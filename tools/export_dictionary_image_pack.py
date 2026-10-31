"""Create a portable ZIP from the configured Q90 dictionary WebP catalog."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import stat
import sys
import tempfile
import warnings
import zipfile

from PIL import Image

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if __package__ in (None, ''):
    sys.path.insert(0, str(PROJECT_ROOT))

from naim.daki_dictionary_images import extract_prompt  # noqa: E402
from naim.daki_dictionary_pack_format import (  # noqa: E402
    ARCHIVE, FORMAT, INDEX, MANIFEST, MAX_ARCHIVE_BYTES, MAX_DIMENSION,
    MAX_EXPANDED_BYTES, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MAX_IMAGES,
    MAX_INDEX_BYTES, MAX_SAFE_INTEGER, VERSION, validate_index,
    validate_manifest,
)


IMAGE_COLUMNS = (
    'id', 'path', 'mtime', 'size', 'width', 'height', 'prompt', 'negative',
    'source', 'tags', 'status',
)


def _path_is_link(path: Path) -> bool:
    if path.is_symlink() or getattr(path, 'is_junction', lambda: False)():
        return True
    if os.name == 'nt':
        try:
            attributes = path.lstat().st_file_attributes
        except (AttributeError, OSError):
            return False
        return bool(attributes & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400))
    return False


def _assert_no_link_components(path: Path) -> None:
    absolute = Path(os.path.abspath(path))
    current = Path(absolute.anchor)
    for part in absolute.parts[1:]:
        current /= part
        if _path_is_link(current):
            raise ValueError('symbolic link or junction paths are unsupported')


def _resolve_directory(value, *, must_exist: bool) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = Path.cwd() / path
    _assert_no_link_components(path)
    try:
        resolved = path.resolve(strict=must_exist)
    except (OSError, RuntimeError, ValueError):
        raise ValueError('a required directory is unavailable') from None
    if must_exist and not resolved.is_dir():
        raise ValueError('a required directory is unavailable')
    return resolved


def _stat_identity(file_stat) -> tuple:
    return (file_stat.st_dev, file_stat.st_ino, file_stat.st_mode,
            file_stat.st_size, file_stat.st_mtime_ns)


def _database_path(data_directory: Path) -> Path:
    database = data_directory / 'image_catalog.sqlite3'
    _assert_no_link_components(database)
    try:
        resolved = database.resolve(strict=True)
        database_stat = resolved.stat()
    except (OSError, RuntimeError, ValueError):
        raise ValueError('the dictionary catalog database is unavailable') from None
    if not stat.S_ISREG(database_stat.st_mode):
        raise ValueError('the dictionary catalog database is unavailable')
    return resolved


def _database_uri(database: Path) -> str:
    return database.as_uri() + '?mode=ro'


def _database_snapshot(database: Path) -> tuple:
    connection = None
    try:
        connection = sqlite3.connect(_database_uri(database), uri=True, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA query_only=ON')
        connection.execute('BEGIN')
        settings = tuple(tuple(row) for row in connection.execute(
            'SELECT key,value FROM settings ORDER BY key'))
        images = tuple(tuple(row) for row in connection.execute(
            'SELECT ' + ','.join(IMAGE_COLUMNS) + ' FROM images ORDER BY id'))
        image_tags = tuple(tuple(row) for row in connection.execute(
            'SELECT image_id,tag FROM image_tags ORDER BY image_id,tag'))
        return settings, images, image_tags
    except (OSError, sqlite3.DatabaseError):
        raise ValueError('the dictionary catalog schema or database is invalid') from None
    finally:
        if connection is not None:
            connection.close()


def _configured_source_root(settings) -> Path:
    folders = [value for key, value in settings if key == 'folder']
    if len(folders) != 1 or not isinstance(folders[0], str) or not folders[0].strip():
        raise ValueError('the dictionary catalog has no configured image folder')
    root = _resolve_directory(folders[0], must_exist=True)
    return root


def _resolve_source_path(raw_path, source_root: Path) -> Path:
    if not isinstance(raw_path, str) or not raw_path:
        raise ValueError('the dictionary catalog contains an invalid image path')
    raw = Path(raw_path)
    if not raw.is_absolute() or '..' in raw.parts:
        raise ValueError('the dictionary catalog contains an unsafe image path')
    _assert_no_link_components(raw)
    try:
        resolved = raw.resolve(strict=True)
        resolved.relative_to(source_root)
        source_stat = resolved.stat()
    except (OSError, RuntimeError, ValueError):
        raise ValueError('a catalog image is missing or outside its configured folder') from None
    if not stat.S_ISREG(source_stat.st_mode) or resolved.suffix.lower() != '.webp':
        raise ValueError('every catalog image must be a regular WebP file')
    return resolved


def _validate_dimensions(width, height) -> None:
    if (type(width) is not int or type(height) is not int
            or not 1 <= width <= MAX_DIMENSION or not 1 <= height <= MAX_DIMENSION
            or width * height > MAX_IMAGE_PIXELS):
        raise ValueError('a catalog image has invalid dimensions')


def _read_limited(path: Path, expected_size: int) -> tuple[bytes, tuple]:
    _assert_no_link_components(path)
    try:
        before = path.stat()
        if (not stat.S_ISREG(before.st_mode) or before.st_size != expected_size
                or not 0 < before.st_size <= MAX_IMAGE_BYTES):
            raise ValueError('a catalog image size does not match its index')
        with path.open('rb') as stream:
            data = stream.read(MAX_IMAGE_BYTES + 1)
        after = path.stat()
    except OSError:
        raise ValueError('a catalog image could not be read') from None
    if (len(data) != expected_size or len(data) > MAX_IMAGE_BYTES
            or _stat_identity(before) != _stat_identity(after)):
        raise ValueError('a catalog image changed while it was being read')
    return data, _stat_identity(before)


def _prepare_records(source_root: Path, image_rows) -> list[dict]:
    if not 1 <= len(image_rows) <= MAX_IMAGES:
        raise ValueError('the dictionary catalog image count is outside the supported range')
    records = []
    seen_ids, seen_paths = set(), set()
    for image_row in image_rows:
        row = dict(zip(IMAGE_COLUMNS, image_row))
        identifier = row['id']
        if (type(identifier) is not int or not 1 <= identifier <= MAX_SAFE_INTEGER
                or identifier in seen_ids):
            raise ValueError('the dictionary catalog contains an invalid or duplicate image ID')
        _validate_dimensions(row['width'], row['height'])
        if type(row['mtime']) is not int or type(row['size']) is not int:
            raise ValueError('the dictionary catalog contains invalid image file metadata')
        for field in ('prompt', 'negative', 'source'):
            if row[field] is not None and not isinstance(row[field], str):
                raise ValueError('the dictionary catalog contains invalid prompt metadata')
        if not isinstance(row['prompt'], str) or not row['prompt'].strip():
            raise ValueError('a catalog image has no positive prompt')

        source = _resolve_source_path(row['path'], source_root)
        source_key = os.path.normcase(str(source))
        if source_key in seen_paths:
            raise ValueError('the dictionary catalog contains duplicate image paths')
        seen_ids.add(identifier)
        seen_paths.add(source_key)

        data, file_stat = _read_limited(source, row['size'])
        if file_stat[4] != row['mtime']:
            raise ValueError('the dictionary catalog is stale; refresh it before exporting')
        try:
            with warnings.catch_warnings():
                warnings.simplefilter('ignore', Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(data)) as image:
                    image.load()
                    if image.format != 'WEBP' or tuple(image.size) != (row['width'], row['height']):
                        raise ValueError('a catalog image does not match its indexed metadata')
                    metadata = extract_prompt(image)
        except ValueError:
            raise
        except Exception:
            raise ValueError('a catalog WebP could not be decoded') from None
        expected_metadata = (row['prompt'] or '', row['negative'] or '', row['source'] or '')
        if metadata != expected_metadata:
            raise ValueError('a catalog image prompt does not match its indexed metadata')

        records.append({
            'id': identifier,
            'source': source,
            'size': row['size'],
            'mtime': row['mtime'],
            'stat': file_stat,
            'sha256': hashlib.sha256(data).hexdigest(),
            'width': row['width'],
            'height': row['height'],
        })
    records.sort(key=lambda record: record['id'])
    return records


def _read_for_archive(record) -> bytes:
    data, file_stat = _read_limited(record['source'], record['size'])
    if (file_stat != record['stat'] or file_stat[4] != record['mtime']
            or hashlib.sha256(data).hexdigest() != record['sha256']):
        raise ValueError('a source image changed during export')
    return data


def _verify_sources_unchanged(records) -> None:
    for record in records:
        data, file_stat = _read_limited(record['source'], record['size'])
        if (file_stat != record['stat'] or file_stat[4] != record['mtime']
                or hashlib.sha256(data).hexdigest() != record['sha256']):
            raise ValueError('a source image changed during export')


def _json_bytes(document) -> bytes:
    try:
        return json.dumps(document, ensure_ascii=False, sort_keys=True,
                          separators=(',', ':'), allow_nan=False).encode('utf-8')
    except (TypeError, ValueError, RecursionError):
        raise ValueError('the dictionary image pack metadata could not be serialized') from None


def _zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_STORED
    info.external_attr = 0o100644 << 16
    return info


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _output_directory(value, source_root: Path) -> Path:
    raw = Path(value).expanduser()
    if not raw.is_absolute():
        raw = Path.cwd() / raw
    _assert_no_link_components(raw)
    if os.path.lexists(raw):
        raise ValueError('the output directory must not already exist')
    try:
        output = raw.resolve(strict=False)
    except (OSError, RuntimeError, ValueError):
        raise ValueError('the output directory is invalid') from None
    if not output.parent.is_dir():
        raise ValueError('the output parent directory must already exist')
    if output.is_relative_to(source_root):
        raise ValueError('the output directory cannot be inside the source image folder')
    return output


def _publish_exclusive(staged: Path, target: Path) -> None:
    if os.path.lexists(target):
        raise ValueError('an output file already exists')
    try:
        # Same-directory hard links provide atomic, no-overwrite publication.
        os.link(staged, target)
    except OSError:
        raise ValueError('a verified pack file could not be published') from None


def export_dictionary_image_pack(data_directory, output_directory) -> dict:
    """Export all configured Q90 WebPs without writing to the catalog or sources."""
    data_root = _resolve_directory(data_directory, must_exist=True)
    database = _database_path(data_root)
    initial_snapshot = _database_snapshot(database)
    settings, image_rows, _image_tags = initial_snapshot
    source_root = _configured_source_root(settings)
    output = _output_directory(output_directory, source_root)
    records = _prepare_records(source_root, image_rows)

    image_bytes = sum(record['size'] for record in records)
    if image_bytes > MAX_EXPANDED_BYTES:
        raise ValueError('the dictionary image pack exceeds the expanded size limit')
    if image_bytes > MAX_ARCHIVE_BYTES:
        raise ValueError('the dictionary image pack exceeds the archive size limit')

    try:
        output.mkdir(exist_ok=False)
    except OSError:
        raise ValueError('the output directory could not be created exclusively') from None

    try:
        with tempfile.TemporaryDirectory(prefix='.dictionary-image-pack-', dir=output) as temp_name:
            staging = Path(temp_name)
            staged_archive = staging / ARCHIVE
            index_images = []
            with zipfile.ZipFile(staged_archive, 'x', compression=zipfile.ZIP_STORED,
                                 allowZip64=True) as archive:
                for record in records:
                    filename = 'images/' + str(record['id']).zfill(6) + '.webp'
                    data = _read_for_archive(record)
                    digest = hashlib.sha256(data).hexdigest()
                    archive.writestr(_zip_info(filename), data)
                    index_images.append({
                        'id': record['id'], 'file': filename, 'bytes': len(data),
                        'sha256': digest, 'width': record['width'], 'height': record['height'],
                    })

                index_document = {'format': FORMAT, 'version': VERSION, 'images': index_images}
                validated_images = validate_index(index_document)
                index_document = {'format': FORMAT, 'version': VERSION, 'images': validated_images}
                index_data = _json_bytes(index_document)
                if len(index_data) > MAX_INDEX_BYTES:
                    raise ValueError('the dictionary image pack index exceeds the size limit')
                index_sha256 = hashlib.sha256(index_data).hexdigest()
                archive.writestr(_zip_info(INDEX), index_data)

            archive_bytes = staged_archive.stat().st_size
            if not 0 < archive_bytes <= MAX_ARCHIVE_BYTES:
                raise ValueError('the dictionary image pack exceeds the archive size limit')
            with zipfile.ZipFile(staged_archive, 'r') as archive:
                expected_names = [item['file'] for item in validated_images] + [INDEX]
                if archive.namelist() != expected_names or archive.read(INDEX) != index_data:
                    raise ValueError('the dictionary image pack archive did not verify')

            manifest = {
                'format': FORMAT,
                'version': VERSION,
                'filename': ARCHIVE,
                'bytes': archive_bytes,
                'sha256': _sha256_file(staged_archive),
                'image_count': len(records),
                'image_bytes': image_bytes,
                'index_sha256': index_sha256,
                'quality': 90,
            }
            manifest = validate_manifest(manifest)
            staged_manifest = staging / MANIFEST
            staged_manifest.write_bytes(_json_bytes(manifest))

            _verify_sources_unchanged(records)
            if _database_snapshot(database) != initial_snapshot:
                raise ValueError('the dictionary catalog changed during export')

            _publish_exclusive(staged_archive, output / ARCHIVE)
            _publish_exclusive(staged_manifest, output / MANIFEST)
    except Exception:
        # The output directory is ours, but published files may be left behind
        # after a failure. The manifest is always published last as the marker.
        raise
    return manifest


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', default=str(PROJECT_ROOT / 'daki_dictionary_user'))
    parser.add_argument('--output', required=True)
    args = parser.parse_args(argv)
    try:
        manifest = export_dictionary_image_pack(args.data_dir, args.output)
    except Exception:
        print('Export failed: catalog validation or file operation error.', file=sys.stderr)
        return 1
    print(f"images={manifest['image_count']} bytes={manifest['bytes']} "
          f"image_bytes={manifest['image_bytes']} sha256={manifest['sha256']} "
          f"index_sha256={manifest['index_sha256']}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
