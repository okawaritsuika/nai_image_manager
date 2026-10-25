"""Build portable ZIP files from explicitly selected completed shared tests."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import zipfile
import warnings

from PIL import Image

if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from naim.daki_style_tests import BATCH_ID, SIZE_LIMITS, STYLE_ID
from naim.daki_test_packs import (
    FORMAT, MANIFEST, MAX_BATCH_BYTES, MAX_EXPANDED_BYTES, MAX_IMAGE_BYTES,
    MAX_IMAGES, MAX_PACK_BYTES, validate_batch,
)
from naim.images.webp_conversion import resolve_webp_image
from naim.storage.daki_shared_styles import DakiSharedStyles
from naim.storage.json_files import write_json


_BATCH_FIELDS = (
    'id', 'name', 'library', 'origin', 'status', 'created_at', 'updated_at',
    'prompt', 'negative_prompt', 'model', 'width', 'height', 'output_format',
    'char_prompts', 'items',
)
_STYLE_FIELDS = (
    'id', 'name', 'model', 'positive', 'negative', 'source_image_id', 'source_url',
    'recommendation_count', 'recommendation_collected_at', 'options', 'seed', 'category',
    'preview', 'sort_date',
)
_SECRET_KEYS = {'authorization', 'apikey', 'accesstoken', 'password', 'token'}
_NONPORTABLE_KEYS = {'root', 'sourcepath'}


def _key_name(value):
    return value.casefold().replace('_', '').replace('-', '') if isinstance(value, str) else ''


def _copy_json(value, *, reject_secrets=False):
    """Copy JSON data while dropping local path fields and blocking credentials."""
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            normalized = _key_name(key)
            if normalized in _SECRET_KEYS:
                if reject_secrets:
                    raise ValueError('generation parameters contain a sensitive field')
                continue
            if normalized in _NONPORTABLE_KEYS:
                continue
            result[key] = _copy_json(item, reject_secrets=reject_secrets)
        return result
    if isinstance(value, list):
        return [_copy_json(item, reject_secrets=reject_secrets) for item in value]
    return value


def _safe_batch_directory(root, batch_id):
    path = root / batch_id
    if (path.is_symlink() or getattr(path, 'is_junction', lambda: False)()
            or path.resolve().parent != root or not path.is_dir()):
        raise ValueError('selected batch directory is missing or unsafe')
    return path.resolve()


def _load_batch(root, batch_id):
    directory = _safe_batch_directory(root, batch_id)
    path = directory / 'batch.json'
    if (path.is_symlink() or getattr(path, 'is_junction', lambda: False)()
            or path.resolve().parent != directory or not path.is_file()):
        raise ValueError('batch settings file is missing or unsafe')
    if path.stat().st_size > MAX_BATCH_BYTES:
        raise ValueError('batch settings file exceeds the size limit')
    with path.open('rb') as source:
        raw = source.read(MAX_BATCH_BYTES + 1)
    if len(raw) > MAX_BATCH_BYTES:
        raise ValueError('batch settings file exceeds the size limit')
    try:
        batch = json.loads(raw.decode('utf-8'))
    except (UnicodeError, json.JSONDecodeError):
        raise ValueError('batch settings file is invalid') from None
    return directory, batch


def _sanitize_batch(batch, batch_id):
    library = batch.get('library') if isinstance(batch, dict) else None
    if library is None or library == '':
        library = 'shared'
    if (not isinstance(batch, dict) or batch.get('id') != batch_id
            or library != 'shared' or batch.get('status') != 'completed'):
        raise ValueError('only completed shared batches can be exported')
    origin = batch.get('origin')
    if origin is not None and (not isinstance(origin, str) or len(origin) > 120 or '/' in origin or '\\' in origin):
        raise ValueError('batch origin is invalid')
    items = batch.get('items')
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_IMAGES:
        raise ValueError('batch item count is invalid')

    clean_items = []
    for item in items:
        if not isinstance(item, dict):
            raise ValueError('batch item is invalid')
        style_id = item.get('style_id')
        if (not isinstance(style_id, str) or not STYLE_ID.fullmatch(style_id)
                or item.get('status') != 'completed'):
            raise ValueError('batch item is invalid')
        style = item.get('style')
        payload = item.get('payload')
        if (not isinstance(style, dict) or style.get('id') != style_id
                or not isinstance(style.get('options'), dict) or not isinstance(style.get('preview'), dict)
                or not isinstance(payload, dict) or not isinstance(payload.get('input'), str)
                or not isinstance(payload.get('parameters'), dict)):
            raise ValueError('batch item snapshot is invalid')
        parameters = payload['parameters']
        # Future generation parameters remain intact, but secrets and local paths do not.
        parameters = _copy_json(parameters, reject_secrets=True)
        options = _copy_json(style['options'])
        preview = {key: style['preview'][key] for key in ('width', 'height') if key in style['preview']}
        clean_style = {key: _copy_json(style[key]) for key in _STYLE_FIELDS
                       if key in style and key not in ('options', 'preview')}
        clean_style.update(options=options, preview=preview)
        clean_items.append({
            'style_id': style_id,
            'status': 'completed',
            'style': clean_style,
            'output_format': item.get('output_format', 'png'),
            'payload': {'input': payload['input'], 'model': payload.get('model'),
                        'action': payload.get('action'), 'parameters': parameters},
        })
    clean = {key: _copy_json(batch[key]) for key in _BATCH_FIELDS if key in batch and key != 'items'}
    clean['library'] = library
    clean['output_format'] = batch.get('output_format', 'png')
    if isinstance(batch.get('char_prompts'), list):
        clean['char_prompts'] = [
            ({'prompt': item.get('prompt', ''), 'negative_prompt': item.get('negative_prompt', '')}
             if isinstance(item, dict) else
             {'prompt': item, 'negative_prompt': ''} if isinstance(item, str) else _copy_json(item))
            for item in batch['char_prompts']
        ]
    clean['items'] = clean_items
    validate_batch(clean, {'id': batch_id, 'name': clean.get('name'), 'image_count': len(clean_items)})
    return clean


def _has_link_component(path):
    path = Path(path).absolute()
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        if current.is_symlink() or getattr(current, 'is_junction', lambda: False)():
            return True
    return False


def _read_image(path, *, batch_directory=None):
    path = Path(path)
    if _has_link_component(path):
        raise ValueError('image path contains a symbolic link')
    resolved = path.resolve()
    if batch_directory is not None and resolved.parent != batch_directory:
        raise ValueError('image path escapes its batch directory')
    if not resolved.is_file():
        raise ValueError('completed image is missing')
    if resolved.stat().st_size > MAX_IMAGE_BYTES:
        raise ValueError('completed image exceeds the size limit')
    with resolved.open('rb') as source:
        data = source.read(MAX_IMAGE_BYTES + 1)
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise ValueError('completed image is empty or too large')
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                image_format = image.format
                dimensions = image.size
                image.verify()
    except Exception:
        raise ValueError('completed image is invalid') from None
    if image_format not in ('PNG', 'WEBP'):
        raise ValueError('completed image must be PNG or WebP')
    if (dimensions[0] <= 0 or dimensions[1] <= 0
            or dimensions[0] * dimensions[1] > SIZE_LIMITS['max_pixels']):
        raise ValueError('completed image dimensions exceed the limit')
    return data, image_format, dimensions


def _thumbnail(image_data):
    try:
        with Image.open(io.BytesIO(image_data)) as source:
            rgb = source.convert('RGB')
            rgb.thumbnail((512, 512), Image.Resampling.LANCZOS)
            output = io.BytesIO()
            rgb.save(output, format='JPEG', quality=88)
            return output.getvalue()
    except Exception:
        raise ValueError('completed image thumbnail could not be created') from None


def _safe_image_for_item(item, batch_directory, catalog, *, legacy_preview=False):
    style_id = item['style_id']
    if legacy_preview:
        try:
            source = catalog.preview_path(style_id, full=True)
        except Exception:
            raise ValueError('legacy shared preview is missing') from None
        return _read_image(source)
    source = batch_directory / (style_id + '.png')
    try:
        resolved = resolve_webp_image(source)
    except (OSError, ValueError):
        raise ValueError('completed image path is invalid') from None
    return _read_image(resolved, batch_directory=batch_directory)


def _write_member(archive, name, data, size_state):
    next_expanded = size_state['expanded_bytes'] + len(data)
    if next_expanded > MAX_EXPANDED_BYTES:
        raise ValueError('expanded pack exceeds the size limit')
    name_bytes = len(name.encode('ascii'))
    central_entry_bytes = 46 + name_bytes
    projected_zip_size = (archive.fp.tell() + 30 + name_bytes + len(data)
                          + size_state['central_bytes'] + central_entry_bytes + 22)
    if projected_zip_size > MAX_PACK_BYTES:
        raise ValueError('pack exceeds the archive size limit')
    archive.writestr(name, data, compress_type=zipfile.ZIP_STORED)
    size_state['expanded_bytes'] = next_expanded
    size_state['central_bytes'] += central_entry_bytes
    return next_expanded


def _sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _prepare_inputs(tests_root, catalog_root, imported_root, batch_ids):
    if not isinstance(batch_ids, (list, tuple)) or not batch_ids:
        raise ValueError('select one or more batch IDs')
    if (any(not isinstance(batch_id, str) or not BATCH_ID.fullmatch(batch_id) for batch_id in batch_ids)
            or len(set(batch_ids)) != len(batch_ids)):
        raise ValueError('batch IDs must be unique lowercase 32-character hex strings')
    tests_root = Path(tests_root).resolve()
    if not tests_root.is_dir():
        raise ValueError('tests root is missing')
    catalog_root = Path(catalog_root).resolve()
    imported_root = Path(imported_root).resolve()
    catalog = DakiSharedStyles(catalog_root, imported_root)
    prepared = []
    for batch_id in batch_ids:
        directory, source_batch = _load_batch(tests_root, batch_id)
        clean_batch = _sanitize_batch(source_batch, batch_id)
        legacy_styles = {item['style_id'] for item in source_batch['items']
                         if isinstance(item, dict) and item.get('legacy_preview') is True}
        for item in clean_batch['items']:
            image_data, image_format, dimensions = _safe_image_for_item(
                item, directory, catalog, legacy_preview=item['style_id'] in legacy_styles)
            parameters = item['payload']['parameters']
            if dimensions != (parameters['width'], parameters['height']):
                raise ValueError('completed image dimensions do not match its generation request')
            item['output_format'] = image_format.lower()
        try:
            batch_json = json.dumps(clean_batch, ensure_ascii=False, indent=2, allow_nan=False).encode('utf-8')
        except (TypeError, ValueError, RecursionError):
            raise ValueError('batch contains unsupported JSON values') from None
        if len(batch_json) > MAX_BATCH_BYTES:
            raise ValueError('sanitized batch exceeds the size limit')
        prepared.append((batch_id, directory, clean_batch, batch_json, legacy_styles))
    return tests_root, catalog_root, imported_root, catalog, prepared


def export_packs(tests_root, catalog_root, imported_root, output, batch_ids):
    """Export selected completed shared batches without changing their source files."""
    tests_root, catalog_root, imported_root, catalog, prepared = _prepare_inputs(
        tests_root, catalog_root, imported_root, batch_ids)
    output_path_input = Path(output).absolute()
    if os.path.lexists(output_path_input):
        raise ValueError('output directory already exists')
    output_path = output_path_input.resolve()
    if not output_path.parent.is_dir():
        raise ValueError('output parent directory is missing')
    for input_root in (tests_root, catalog_root, imported_root):
        if output_path.is_relative_to(input_root):
            raise ValueError('output must be outside the input roots')

    output_path.mkdir(exist_ok=False)
    created_files = []
    manifest = {'format': FORMAT, 'version': 1, 'packs': []}
    try:
        for batch_id, batch_directory, batch, batch_json, legacy_styles in prepared:
            filename = 'style_test_' + batch_id + '.zip'
            archive_path = output_path / filename
            created_files.append(archive_path)
            size_state = {'expanded_bytes': 0, 'central_bytes': 0}
            image_count = 0
            with zipfile.ZipFile(archive_path, 'w', compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
                _write_member(archive, 'batch.json', batch_json, size_state)
                for item in batch['items']:
                    image_data, image_format, dimensions = _safe_image_for_item(
                        item, batch_directory, catalog, legacy_preview=item['style_id'] in legacy_styles)
                    parameters = item['payload']['parameters']
                    if (dimensions != (parameters['width'], parameters['height'])
                            or image_format.lower() != item['output_format']):
                        raise ValueError('completed image dimensions do not match its generation request')
                    full_suffix = '.png' if image_format == 'PNG' else '.webp'
                    thumbnail = _thumbnail(image_data)
                    _write_member(archive, item['style_id'] + full_suffix, image_data, size_state)
                    _write_member(archive, item['style_id'] + '.jpg', thumbnail, size_state)
                    image_count += 1
            if image_count != len(batch['items']) or archive_path.stat().st_size > MAX_PACK_BYTES:
                raise ValueError('pack exceeds the archive size limit')
            manifest['packs'].append({
                'id': batch_id,
                'name': batch['name'],
                'filename': filename,
                'bytes': archive_path.stat().st_size,
                'sha256': _sha256(archive_path),
                'image_count': image_count,
                'expanded_bytes': size_state['expanded_bytes'],
            })
        write_json(output_path / MANIFEST, manifest, indent=2)
    except Exception:
        for path in reversed(created_files):
            try:
                if path.exists() and not path.is_symlink():
                    path.unlink()
            except OSError:
                pass
        try:
            output_path.rmdir()
        except OSError:
            pass
        raise
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description='Export selected completed shared style tests.')
    parser.add_argument('--tests-root', required=True)
    parser.add_argument('--catalog-root', required=True)
    parser.add_argument('--imported-root', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--batch-id', action='append', required=True)
    args = parser.parse_args(argv)
    try:
        manifest = export_packs(args.tests_root, args.catalog_root, args.imported_root, args.output, args.batch_id)
    except (OSError, ValueError, TypeError, zipfile.BadZipFile):
        print('Export failed: input validation or file operation error.', file=sys.stderr)
        return 1
    for pack in manifest['packs']:
        print(f"{pack['filename']}\t{pack['image_count']}\t{pack['bytes']}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
