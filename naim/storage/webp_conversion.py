"""Preserve gallery references when a verified image is replaced by WebP."""
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import tempfile

from naim.images.webp_conversion import webp_target_path
from naim.storage.json_files import json_lock, write_json


class WebpReferenceRollbackError(RuntimeError):
    """References may still point to WebP, so keep both image files."""
    retain_target = True


def _contained_path(root, relative):
    relative = str(relative or "").replace("\\", "/")
    if not relative or os.path.isabs(relative) or ".." in relative.split("/"):
        raise ValueError("갤러리 이미지 경로가 올바르지 않습니다.")
    base = os.path.realpath(root)
    lexical_target = os.path.abspath(os.path.join(base, relative))
    if os.path.normcase(os.path.commonpath((base, lexical_target))) != os.path.normcase(base):
        raise ValueError("갤러리 밖의 이미지 경로입니다.")
    current = base
    for part in Path(os.path.relpath(lexical_target, base)).parts:
        current = os.path.join(current, part)
        if os.path.islink(current):
            raise ValueError("심볼릭 링크 이미지 경로는 사용할 수 없습니다.")
    target = os.path.realpath(os.path.join(base, relative))
    if os.path.normcase(os.path.commonpath((base, target))) != os.path.normcase(base):
        raise ValueError("갤러리 밖의 이미지 경로입니다.")
    return target


def resolve_converted_gallery_path(root, rel_path, db_path):
    """Return an existing alias target, or None; never create a database.

    Keeping exact aliases also preserves browser-local canvas snapshots which
    the server cannot rewrite. A newly created PNG always takes precedence.
    """
    try:
        relative = str(rel_path or "").replace("\\", "/")
        if Path(relative).suffix.lower() not in {".png", ".jpg", ".jpeg", ".bmp", ".gif"}:
            return None
        source = _contained_path(root, relative)
        if os.path.lexists(source):
            return None
        expected = webp_target_path(Path(relative)).as_posix()
        uri = Path(db_path).absolute().as_uri() + "?mode=ro"
        with closing(sqlite3.connect(uri, uri=True)) as connection:
            row = connection.execute(
                "SELECT new_rel_path FROM gallery_webp_conversions WHERE old_rel_path = ?",
                (relative,),
            ).fetchone()
        if row is None or str(row[0]).replace("\\", "/") != expected:
            return None
        target = _contained_path(root, row[0])
        if os.path.isfile(target):
            return target
    except (OSError, ValueError, sqlite3.Error):
        pass
    return None


def _restore_bytes(path, data):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=os.path.dirname(path), delete=False) as stream:
            temporary = stream.name
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
            written = os.fstat(stream.fileno())
        os.replace(temporary, path)
        return written
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


class GalleryTagCache:
    """One batch's parsed tags, guarded by the caller's existing JSON lock.

    Every change is still persisted before source deletion. File identity checks
    invalidate cached data after external edits; this is never a global cache.
    """
    def __init__(self, path):
        self.path = os.path.abspath(path)
        self.invalidate()

    def invalidate(self):
        self.signature = None
        self.raw = None
        self.config = None

    def current_signature(self):
        details = os.stat(self.path)
        return details.st_dev, details.st_ino, details.st_size, details.st_mtime_ns, details.st_ctime_ns

    def read(self):
        signature = self.current_signature()
        if signature != self.signature or self.raw is None:
            raw = Path(self.path).read_bytes()
            if signature != self.current_signature():
                self.invalidate()
                raise ValueError("이미지 태그 파일이 변경되어 원본을 유지합니다.")
            config = json.loads(raw)
            self.signature, self.raw, self.config = signature, raw, config
        return self.raw, self.config

    def write(self, config):
        raw = json.dumps(config, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if self.signature != self.current_signature():
            self.invalidate()
            raise ValueError("이미지 태그 파일이 변경되어 원본을 유지합니다.")
        # read() already validated the prior JSON. Serialize once and atomically
        # replace it instead of reparsing and streaming many tiny JSON writes.
        written = _restore_bytes(self.path, raw)
        try:
            signature = self.current_signature()
        except OSError as error:
            self.invalidate()
            raise WebpReferenceRollbackError("태그 저장 뒤 파일 상태를 확인하지 못해 원본과 WebP를 모두 보존합니다.") from error
        if signature[:4] != (written.st_dev, written.st_ino, written.st_size, written.st_mtime_ns):
            self.invalidate()
            raise WebpReferenceRollbackError("태그 저장 뒤 외부 변경을 감지해 원본과 WebP를 모두 보존합니다.")
        self.signature = signature
        self.raw, self.config = raw, config


def add_webp_gallery_image(db, root, source_path, target_path):
    """Index an additional WebP without moving source references or tags.

    Called under IMAGE_FILES_LOCK after publication. Return an undo callback
    so cancellation or a final verification failure can remove the new record.
    """
    from PIL import Image

    old_rel = os.path.relpath(source_path, root).replace('\\', '/')
    new_rel = os.path.relpath(target_path, root).replace('\\', '/')
    _contained_path(root, old_rel)
    _contained_path(root, new_rel)
    if Path(target_path).absolute() != webp_target_path(Path(source_path).absolute()):
        raise ValueError('WebP 추가 경로가 올바르지 않습니다.')
    cursor = db.conn.execute('SELECT * FROM gallery_images WHERE rel_path = ?', (new_rel,))
    columns = [column[0] for column in cursor.description]
    previous = cursor.fetchone()
    source_cursor = db.conn.execute('SELECT * FROM gallery_images WHERE rel_path = ?', (old_rel,))
    source_row = source_cursor.fetchone()
    source_record = dict(zip((column[0] for column in source_cursor.description), source_row)) if source_row else {}
    # Reuse the ordinary file index writer, preserving classification fields.
    overrides = {key: source_record[key] for key in (
        'mode', 'rating', 'brand', 'character_names', 'is_dakimakura', 'reason', 'model_family'
    ) if key in source_record}
    # Supplying verified dimensions avoids a separate metadata-cache write
    # outside the new gallery record's rollback boundary.
    with Image.open(target_path) as image:
        overrides.update(width=image.width, height=image.height)
    folder = os.path.dirname(new_rel).replace('\\', '/')
    if os.path.basename(folder) == '_upscaled':
        folder = os.path.dirname(folder).replace('\\', '/')

    def undo():
        try:
            with db.conn:
                if previous is None:
                    db.conn.execute('DELETE FROM gallery_images WHERE rel_path = ?', (new_rel,))
                else:
                    names = ','.join('"' + column + '"' for column in columns)
                    placeholders = ','.join('?' for _ in columns)
                    db.conn.execute(f'INSERT OR REPLACE INTO gallery_images ({names}) VALUES ({placeholders})', previous)
            db.refresh_gallery_folder_summaries([folder])
        except Exception as error:
            raise WebpReferenceRollbackError('추가 이미지 인덱스 복구 실패로 원본과 WebP를 보존합니다.') from error

    try:
        db.upsert_gallery_image_file(target_path, classified_root=root, **overrides)
        db.refresh_gallery_folder_summaries([folder])
    except Exception:
        undo()
        raise
    return undo


def migrate_webp_references(db, root, source_path, target_path, tags_path, *, tags_cache=None):
    """Commit path/hash references and return an idempotent undo callback.

    The caller holds IMAGE_FILES_LOCK across migration, source deletion and undo,
    and has verified target_path. This function acquires its own JSON locks.
    The source is retained until this succeeds. Only affected rows are retained
    for rollback, never a DB snapshot.
    """
    source_path, target_path = os.path.abspath(source_path), os.path.abspath(target_path)
    old_rel = os.path.relpath(source_path, root).replace("\\", "/")
    new_rel = os.path.relpath(target_path, root).replace("\\", "/")
    _contained_path(root, old_rel)
    _contained_path(root, new_rel)
    if (Path(old_rel).suffix.lower() not in {".png", ".jpg", ".jpeg", ".bmp", ".gif"}
            or os.path.normcase(webp_target_path(Path(source_path))) != os.path.normcase(target_path)):
        raise ValueError("이미지 원본의 정확한 WebP 출력만 연결할 수 있습니다.")
    if not os.path.isfile(source_path) or not os.path.isfile(target_path):
        raise FileNotFoundError("변환 원본 또는 검증된 WebP가 없습니다.")
    old_hash, new_hash = db.get_hash(source_path), db.get_hash(target_path)
    if not old_hash or not new_hash:
        raise OSError("변환 이미지 이력을 확인할 수 없습니다.")
    connection = db.conn
    if connection.in_transaction:
        raise RuntimeError("WebP 경로 갱신에는 독립된 DB 트랜잭션이 필요합니다.")
    if tags_cache is not None and os.path.normcase(tags_cache.path) != os.path.normcase(os.path.abspath(tags_path)):
        raise ValueError("이미지 태그 캐시 경로가 일치하지 않습니다.")
    undo_statements = []
    tags_before = None
    tags_changed = False
    tags_written_signature = None

    def restore_tags():
        with json_lock(tags_path):
            if tags_cache is not None and (tags_written_signature is None or
                    tags_written_signature != tags_cache.current_signature()):
                raise ValueError("외부에서 변경한 이미지 태그를 덮어쓰지 않고 두 이미지를 보존합니다.")
            _restore_bytes(tags_path, tags_before)

    def change(table, column, before, after, where_column=None, where_value=None):
        if before == after:
            return
        where_column = where_column or column
        where_value = before if where_value is None else where_value
        rows = connection.execute(
            f'SELECT rowid, "{column}" FROM "{table}" WHERE "{where_column}" = ?',
            (where_value,),
        ).fetchall()
        for rowid, previous in rows:
            connection.execute(f'UPDATE "{table}" SET "{column}" = ? WHERE rowid = ?', (after, rowid))
            undo_statements.append((f'UPDATE "{table}" SET "{column}" = ? WHERE rowid = ?', (previous, rowid)))

    def insert(table, columns, values):
        placeholders = ",".join("?" for _ in values)
        cursor = connection.execute(
            f'INSERT OR IGNORE INTO "{table}" ({",".join(columns)}) VALUES ({placeholders})', values
        )
        if cursor.rowcount:
            undo_statements.append((f'DELETE FROM "{table}" WHERE rowid = ?', (cursor.lastrowid,)))

    try:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("""
            CREATE TABLE IF NOT EXISTS gallery_webp_conversions (
                old_rel_path TEXT PRIMARY KEY, new_rel_path TEXT NOT NULL
            )
        """)
        # These secondary lookups would otherwise scan large caches per image.
        for table, column in (
            ("gallery_folders", "thumb_path"),
            ("gallery_virtual_folder_cache_meta", "thumb_path"),
            ("gallery_virtual_folder_cache_items", "rel_path"),
            ("trash_map", "original_path"),
        ):
            connection.execute(f'CREATE INDEX IF NOT EXISTS "idx_webp_{table}_{column}" ON "{table}" ("{column}")')

        for table, column in (
            ("gallery_images", "rel_path"), ("gallery_prompt_index", "rel_path"),
            ("gallery_prompt_index_profile_items", "rel_path"),
            ("gallery_folders", "thumb_path"),
            ("gallery_virtual_folder_cache_items", "rel_path"),
            ("gallery_virtual_folder_cache_meta", "thumb_path"),
        ):
            change(table, column, old_rel, new_rel)
        for table in ("gallery_images", "gallery_prompt_index"):
            change(table, "file_name", os.path.basename(source_path), os.path.basename(target_path), "rel_path", new_rel)
        for table in ("file_metadata", "image_artists", "artist_scanned_files"):
            for before, after in dict.fromkeys((
                (old_rel, new_rel), (old_rel.replace("/", "\\"), new_rel.replace("/", "\\")),
                (source_path, target_path), (source_path.replace("\\", "/"), target_path.replace("\\", "/")),
            )):
                change(table, "path", before, after)

        for before, after in dict.fromkeys((
            (source_path, target_path), (source_path.replace("\\", "/"), target_path.replace("\\", "/")),
            (old_rel, new_rel),
        )):
            # A converted trash item must restore with its actual new format,
            # even though its original destination does not currently exist.
            rows = connection.execute("SELECT rowid, original_path FROM trash_map WHERE trash_path = ?", (before,)).fetchall()
            for rowid, original in rows:
                if isinstance(original, str) and Path(original).suffix.lower() in {".png", ".jpg", ".jpeg", ".bmp", ".gif"}:
                    restored = str(webp_target_path(Path(original)))
                    restored_full = os.path.abspath(restored if os.path.isabs(restored) else os.path.join(root, restored))
                    image_paths = {os.path.normcase(source_path), os.path.normcase(target_path)}
                    if os.path.lexists(restored_full) and os.path.normcase(restored_full) not in image_paths:
                        raise ValueError("휴지통 복구 위치에 같은 이름의 WebP가 있어 이미지 원본을 유지합니다.")
                    change("trash_map", "original_path", original, restored, "rowid", rowid)
            change("trash_map", "trash_path", before, after)
            change("trash_map", "original_path", before, after)

        previous = connection.execute("SELECT file_name, characters, processed_at FROM processed_files WHERE file_hash = ?", (old_hash,)).fetchone()
        if previous:
            insert("processed_files", ("file_hash", "file_name", "characters", "processed_at"),
                   (new_hash, os.path.basename(target_path), previous[1], previous[2]))
        if connection.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manual_overrides'").fetchone():
            previous = connection.execute("SELECT is_nsfw FROM manual_overrides WHERE file_hash = ?", (old_hash,)).fetchone()
            if previous:
                existing = connection.execute("SELECT is_nsfw FROM manual_overrides WHERE file_hash = ?", (new_hash,)).fetchone()
                if existing and existing != previous:
                    raise ValueError("WebP의 기존 수동 분류와 원본 분류가 충돌합니다.")
                insert("manual_overrides", ("file_hash", "is_nsfw"), (new_hash, previous[0]))
        previous_alias = connection.execute("SELECT 1 FROM gallery_webp_conversions WHERE old_rel_path = ?", (old_rel,)).fetchone()
        if previous_alias:
            change("gallery_webp_conversions", "new_rel_path", None, new_rel, "old_rel_path", old_rel)
        else:
            insert("gallery_webp_conversions", ("old_rel_path", "new_rel_path"), (old_rel, new_rel))

        if tags_path and os.path.isfile(tags_path):
            with json_lock(tags_path):
                if tags_cache is None:
                    tags_before = Path(tags_path).read_bytes()
                    config = json.loads(tags_before)
                else:
                    tags_before, config = tags_cache.read()
                if not isinstance(config, dict) or not isinstance(config.get("image_tags", {}), dict):
                    raise ValueError("이미지 태그 파일 형식을 확인할 수 없습니다.")
                tags = config.get("image_tags", {})
                if old_rel in tags:
                    if new_rel in tags and tags[new_rel] != tags[old_rel]:
                        raise ValueError("WebP의 기존 태그와 원본 태그가 충돌합니다.")
                    # Never mutate the prior cached snapshot needed by undo.
                    config, tags = dict(config), dict(tags)
                    config["image_tags"] = tags
                    tags[new_rel] = tags.pop(old_rel)
                    if tags_cache is None:
                        write_json(tags_path, config, indent=2)
                    else:
                        tags_cache.write(config)
                        tags_written_signature = tags_cache.signature
                    tags_changed = True
        connection.commit()
    except Exception:
        rollback_errors = []
        try:
            connection.rollback()
        except Exception as error:
            rollback_errors.append(error)
        try:
            if tags_changed:
                restore_tags()
        except Exception as error:
            rollback_errors.append(error)
        if tags_cache is not None:
            tags_cache.invalidate()
        if rollback_errors:
            raise WebpReferenceRollbackError("이미지 참조 복구를 확인하지 못해 원본과 WebP를 모두 보존합니다.") from rollback_errors[0]
        raise

    undone = False

    def rollback():
        nonlocal undone
        if undone:
            return
        try:
            with connection:
                for statement, parameters in reversed(undo_statements):
                    connection.execute(statement, parameters)
                if tags_changed:
                    restore_tags()
        except Exception as error:
            raise WebpReferenceRollbackError("이미지 참조 복구를 확인하지 못해 원본과 WebP를 모두 보존합니다.") from error
        finally:
            if tags_cache is not None:
                tags_cache.invalidate()
        undone = True

    return rollback
