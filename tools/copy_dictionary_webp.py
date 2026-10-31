"""Copy the offline tag-dictionary image catalog to lossy WebP files.

The default invocation performs a read-only inventory. Pass ``--apply`` to
create a separate image tree and switch only the user dictionary catalog.
Run while the NAIM server is stopped; source files are always retained.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import stat
import sys
from uuid import uuid4

from PIL import Image

PROJECT_ROOT = Path(__file__).resolve().parents[1]
QUALITY = 90
MAX_WORKERS = 4
SERVER_HOST = "127.0.0.1"
SERVER_PORT = 5000
IMAGE_COLUMNS = (
    "id", "path", "mtime", "size", "width", "height", "prompt", "negative",
    "source", "tags", "status",
)

sys.path.insert(0, str(PROJECT_ROOT))

from naim.daki_dictionary_images import extract_prompt  # noqa: E402
from naim.images.webp_conversion import convert_png_to_webp, restore_webp_metadata  # noqa: E402


class MigrationError(RuntimeError):
    """A safe, path-free error suitable for CLI output."""


def _path_is_link(path: Path) -> bool:
    return path.is_symlink() or getattr(path, "is_junction", lambda: False)()


def _assert_no_link_components(path: Path) -> None:
    absolute = Path(os.path.abspath(path))
    current = Path(absolute.anchor)
    for part in absolute.parts[1:]:
        current = current / part
        if _path_is_link(current):
            raise MigrationError("Symbolic links and junction paths are not supported.")


def _resolve_directory(value, *, must_exist: bool) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = Path.cwd() / path
    _assert_no_link_components(path)
    try:
        resolved = path.resolve(strict=must_exist)
    except (OSError, RuntimeError, ValueError):
        raise MigrationError("A required directory is unavailable.") from None
    if must_exist and not resolved.is_dir():
        raise MigrationError("A required directory is unavailable.")
    return resolved


def _database_uri(database: Path) -> str:
    return database.resolve().as_uri() + "?mode=ro"


def _connect_readonly(database: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(_database_uri(database), uri=True, timeout=30)
    connection.row_factory = sqlite3.Row
    return connection


def _snapshot_from_connection(connection: sqlite3.Connection) -> tuple:
    try:
        settings = tuple(tuple(row) for row in connection.execute(
            "SELECT key,value FROM settings ORDER BY key"))
        images = tuple(tuple(row) for row in connection.execute(
            "SELECT " + ",".join(IMAGE_COLUMNS) + " FROM images ORDER BY id"))
        image_tags = tuple(tuple(row) for row in connection.execute(
            "SELECT image_id,tag FROM image_tags ORDER BY image_id,tag"))
    except sqlite3.DatabaseError:
        raise MigrationError("The dictionary catalog schema or database is invalid.") from None
    return settings, images, image_tags


def _database_snapshot(database: Path) -> tuple:
    connection = None
    try:
        connection = _connect_readonly(database)
        snapshot = _snapshot_from_connection(connection)
    except (OSError, sqlite3.DatabaseError):
        raise MigrationError("The dictionary catalog could not be read.") from None
    finally:
        if connection is not None:
            connection.close()
    return snapshot


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _stat_identity(file_stat) -> tuple:
    return (file_stat.st_dev, file_stat.st_ino, file_stat.st_mode,
            file_stat.st_size, file_stat.st_mtime_ns)


def _server_is_offline() -> bool:
    try:
        with socket.create_connection((SERVER_HOST, SERVER_PORT), timeout=0.25):
            return False
    except OSError:
        return True


def _require_server_offline(check_idle) -> None:
    try:
        offline = check_idle()
    except Exception:
        offline = False
    if offline is not True:
        raise MigrationError("The NAIM server must be stopped before this operation.")


def _catalog_inputs(data_dir: Path, destination_value, snapshot: tuple):
    settings, image_rows, _image_tags = snapshot
    folder_values = [value for key, value in settings if key == "folder"]
    if len(folder_values) != 1 or not isinstance(folder_values[0], str) or not folder_values[0].strip():
        raise MigrationError("The catalog has no configured source folder.")

    source_root = _resolve_directory(folder_values[0], must_exist=True)
    if not image_rows:
        raise MigrationError("The dictionary catalog contains no images.")

    if destination_value is None:
        destination_value = data_dir / "images_webp_q90"
    destination_raw = Path(destination_value).expanduser()
    if not destination_raw.is_absolute():
        destination_raw = Path.cwd() / destination_raw
    _assert_no_link_components(destination_raw.parent)
    try:
        destination = destination_raw.resolve(strict=False)
    except (OSError, RuntimeError, ValueError):
        raise MigrationError("The destination path is invalid.") from None
    if destination.exists() or os.path.lexists(destination):
        raise MigrationError("The destination directory must not already exist.")
    if not destination.parent.is_dir():
        raise MigrationError("The destination parent directory must already exist.")
    data_root = data_dir.resolve(strict=True)
    workspace_root = PROJECT_ROOT.resolve(strict=True)
    if not (destination.is_relative_to(data_root) or destination.is_relative_to(workspace_root)):
        raise MigrationError("The destination must be inside the data directory or workspace.")
    if destination.is_relative_to(source_root):
        raise MigrationError("The destination cannot be inside the source folder.")

    records = []
    seen_sources = set()
    seen_targets = set()
    for image_row in image_rows:
        row = dict(zip(IMAGE_COLUMNS, image_row))
        raw_path = row["path"]
        if not isinstance(raw_path, str) or not raw_path:
            raise MigrationError("The catalog contains an invalid image path.")
        source = Path(raw_path)
        if not source.is_absolute() or ".." in source.parts:
            raise MigrationError("The catalog contains a traversing image path.")
        _assert_no_link_components(source)
        try:
            resolved_source = source.resolve(strict=True)
            relative = resolved_source.relative_to(source_root)
            source_stat = resolved_source.stat()
        except (OSError, RuntimeError, ValueError):
            raise MigrationError("A catalog image is missing or outside its source folder.") from None
        if (not stat.S_ISREG(source_stat.st_mode) or
                resolved_source.suffix.lower() != ".png"):
            raise MigrationError("Every catalog image must be a regular PNG file.")
        source_key = os.path.normcase(str(resolved_source))
        if source_key in seen_sources:
            raise MigrationError("The catalog contains duplicate image paths.")
        seen_sources.add(source_key)
        target_key = os.path.normcase(str(relative.with_suffix(".webp")))
        if target_key in seen_targets:
            raise MigrationError("The catalog contains image names that collide after conversion.")
        seen_targets.add(target_key)
        if row["mtime"] != source_stat.st_mtime_ns or row["size"] != source_stat.st_size:
            raise MigrationError("The catalog is stale; refresh it before copying.")
        try:
            with Image.open(resolved_source) as image:
                image.load()
                if image.format != "PNG" or tuple(image.size) != (row["width"], row["height"]):
                    raise MigrationError("A catalog image does not match its indexed metadata.")
                metadata = extract_prompt(image)
        except MigrationError:
            raise
        except Exception:
            raise MigrationError("A catalog PNG could not be verified.") from None
        expected_metadata = (row["prompt"] or "", row["negative"] or "", row["source"] or "")
        if metadata != expected_metadata:
            raise MigrationError("The catalog prompt metadata is stale; refresh it before copying.")
        try:
            source_digest = _sha256(resolved_source)
        except OSError:
            raise MigrationError("A catalog PNG could not be read.") from None
        records.append({
            "row": row,
            "source": resolved_source,
            "relative": relative,
            "digest": source_digest,
            "stat": _stat_identity(source_stat),
            "source_bytes": source_stat.st_size,
            "metadata": metadata,
        })
    return destination, records


def _assert_source_unchanged(record) -> None:
    source = record["source"]
    try:
        _assert_no_link_components(source)
        current_stat = source.stat()
        current_digest = _sha256(source)
    except OSError:
        raise MigrationError("A source PNG changed or became unavailable.") from None
    if (_stat_identity(current_stat) != record["stat"] or
            current_digest != record["digest"]):
        raise MigrationError("A source PNG changed during the copy.")


def _copy_convert_one(record, destination: Path) -> dict:
    source = record["source"]
    copied_png = destination / record["relative"]
    try:
        copied_png.parent.mkdir(parents=True, exist_ok=True)
        _assert_no_link_components(copied_png.parent)
        if os.path.lexists(copied_png):
            raise MigrationError("A destination image path already exists.")
        shutil.copy2(source, copied_png)
        if _sha256(copied_png) != record["digest"]:
            raise MigrationError("A copied PNG did not match its source.")
        _assert_source_unchanged(record)
        result = convert_png_to_webp(copied_png, lossless=False, quality=QUALITY)
        if not isinstance(result, dict) or result.get("status") != "converted":
            raise MigrationError("A PNG could not be converted to WebP.")
        webp_path = copied_png.with_suffix(".webp")
        _assert_no_link_components(webp_path)
        if copied_png.exists() or not webp_path.is_file() or webp_path.is_symlink():
            raise MigrationError("A converted WebP file is incomplete.")
        with Image.open(webp_path) as image:
            image.load()
            restore_webp_metadata(image)
            if tuple(image.size) != (record["row"]["width"], record["row"]["height"]):
                raise MigrationError("A converted WebP has unexpected dimensions.")
            if extract_prompt(image) != record["metadata"]:
                raise MigrationError("A converted WebP prompt did not match its source.")
        _assert_source_unchanged(record)
        target_stat = webp_path.stat()
        return {
            "id": record["row"]["id"],
            "path": str(webp_path.resolve(strict=True)),
            "mtime": target_stat.st_mtime_ns,
            "size": target_stat.st_size,
            "target_bytes": target_stat.st_size,
        }
    except MigrationError:
        raise
    except Exception:
        raise MigrationError("An image could not be copied and verified.") from None


def _verify_sources(records) -> None:
    for record in records:
        _assert_source_unchanged(record)


def _create_database_backup(database: Path, data_dir: Path) -> Path:
    backup = data_dir / f"image_catalog.before_webp_copy.{uuid4().hex}.sqlite3"
    try:
        descriptor = os.open(backup, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
        os.close(descriptor)
        with closing(_connect_readonly(database)) as source:
            with closing(sqlite3.connect(backup, timeout=30)) as target:
                source.backup(target)
        with closing(sqlite3.connect(backup)) as check:
            if check.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise MigrationError("The catalog backup did not pass its integrity check.")
    except MigrationError:
        raise
    except Exception:
        raise MigrationError("The catalog backup could not be created.") from None
    return backup


def _switch_catalog(database: Path, destination: Path, records, initial_snapshot: tuple,
                    check_idle) -> None:
    try:
        connection = sqlite3.connect(database, timeout=30, isolation_level=None)
    except sqlite3.DatabaseError:
        raise MigrationError("The dictionary catalog could not be opened for switching.") from None
    try:
        connection.execute("BEGIN IMMEDIATE")
        if _snapshot_from_connection(connection) != initial_snapshot:
            raise MigrationError("The dictionary catalog changed during the copy.")
        # IDs and all indexed content stay fixed; only path, mtime, size, and
        # settings.folder change in this transaction.
        converted_by_id = {record["converted"]["id"]: record["converted"] for record in records}
        id_index = IMAGE_COLUMNS.index("id")
        path_index = IMAGE_COLUMNS.index("path")
        mtime_index = IMAGE_COLUMNS.index("mtime")
        size_index = IMAGE_COLUMNS.index("size")
        expected_images = []
        for image_row in initial_snapshot[1]:
            converted = converted_by_id.get(image_row[id_index])
            if converted is None:
                raise MigrationError("A catalog image is missing from the copy results.")
            changed = list(image_row)
            changed[path_index] = converted["path"]
            changed[mtime_index] = converted["mtime"]
            changed[size_index] = converted["size"]
            expected_images.append(tuple(changed))
        for record in records:
            converted = record["converted"]
            cursor = connection.execute(
                "UPDATE images SET path=?,mtime=?,size=? WHERE id=?",
                (converted["path"], converted["mtime"], converted["size"], converted["id"]),
            )
            if cursor.rowcount != 1:
                raise MigrationError("A catalog image disappeared during switching.")
        cursor = connection.execute("UPDATE settings SET value=? WHERE key='folder'",
                                    (str(destination),))
        if cursor.rowcount != 1:
            raise MigrationError("The catalog source folder setting changed during switching.")
        expected_settings = tuple(
            (key, str(destination) if key == "folder" else value)
            for key, value in initial_snapshot[0]
        )
        if _snapshot_from_connection(connection) != (
                expected_settings, tuple(expected_images), initial_snapshot[2]):
            raise MigrationError("The catalog changed unexpectedly during switching.")
        if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise MigrationError("The dictionary catalog failed its integrity check.")
        _verify_sources(records)
        _require_server_offline(check_idle)
        connection.commit()
    except MigrationError:
        connection.rollback()
        connection.close()
        raise
    except Exception:
        connection.rollback()
        connection.close()
        raise MigrationError("The dictionary catalog switch failed and was rolled back.") from None
    connection.close()


def copy_dictionary_webp(data_dir=None, destination=None, *, apply=False, progress=None,
                         check_idle=_server_is_offline) -> dict:
    """Inventory or copy the indexed images, keeping original PNGs untouched."""
    if data_dir is None:
        data_dir = PROJECT_ROOT / "daki_dictionary_user"
    data_dir = _resolve_directory(data_dir, must_exist=True)
    database = data_dir / "image_catalog.sqlite3"
    if _path_is_link(database) or not database.is_file():
        raise MigrationError("The dictionary catalog database is unavailable.")

    _require_server_offline(check_idle)
    initial_snapshot = _database_snapshot(database)
    destination_path, records = _catalog_inputs(data_dir, destination, initial_snapshot)
    source_bytes = sum(record["source_bytes"] for record in records)
    if not apply:
        return {
            "apply": False,
            "count": len(records),
            "source_bytes": source_bytes,
            "target_bytes": 0,
            "quality": QUALITY,
            "backed_up": False,
            "switch": False,
        }

    _require_server_offline(check_idle)
    try:
        destination_path.mkdir()
    except OSError:
        raise MigrationError("The destination directory could not be created.") from None

    completed = 0
    target_bytes = 0
    totals = {"processed": 0, "total": len(records), "source_bytes": source_bytes,
              "target_bytes": 0}
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as workers:
        futures = {workers.submit(_copy_convert_one, record, destination_path): record
                   for record in records}
        try:
            for future in as_completed(futures):
                record = futures[future]
                converted = future.result()
                record["converted"] = converted
                completed += 1
                target_bytes += converted["target_bytes"]
                if completed % 100 == 0 and progress is not None:
                    totals.update(processed=completed, target_bytes=target_bytes)
                    progress(dict(totals))
        except Exception:
            for future in futures:
                future.cancel()
            raise

    if completed != len(records):
        raise MigrationError("Not all catalog images were copied.")
    _verify_sources(records)
    if _database_snapshot(database) != initial_snapshot:
        raise MigrationError("The dictionary catalog changed during the copy.")
    _require_server_offline(check_idle)

    backup = _create_database_backup(database, data_dir)
    if _database_snapshot(backup) != initial_snapshot:
        raise MigrationError("The catalog changed while its backup was being created.")
    _switch_catalog(database, destination_path, records, initial_snapshot, check_idle)
    return {
        "apply": True,
        "count": completed,
        "source_bytes": source_bytes,
        "target_bytes": target_bytes,
        "quality": QUALITY,
        "backed_up": True,
        "switch": True,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", default=str(PROJECT_ROOT / "daki_dictionary_user"))
    parser.add_argument("--destination", default=None)
    parser.add_argument("--apply", action="store_true",
                        help="copy verified PNGs, then switch the dictionary catalog")
    args = parser.parse_args(argv)
    try:
        result = copy_dictionary_webp(
            args.data_dir, args.destination, apply=args.apply,
            progress=lambda counters: print(json.dumps(counters, ensure_ascii=False), flush=True),
        )
    except MigrationError as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr, flush=True)
        return 1
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
