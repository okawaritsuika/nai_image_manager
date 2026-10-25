"""Import new public V5 style recipes, retaining read-only original image links.

Dry-run is the default. The source project's application is never imported;
only the already-reviewed extraction helpers from the daki research catalog
are used. No download or image-generation API is called.
"""
import argparse
from collections import Counter, defaultdict
from contextlib import contextmanager
import csv
import hashlib
import importlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import ModuleType
from urllib.parse import urlsplit

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from naim.daki_style_tests import build_style_test_payload
from naim.storage.daki_shared_styles import DakiSharedStyles, excluded_style


@contextmanager
def research_helpers(catalog_root, source_project):
    """Reuse reviewed parser/classifier code without its fixed research paths."""
    module_names = ('prompt_syntax', 'review_imports', 'audit_catalog', 'style_terms',
                    'build_catalog', 'export_source_options', 'arca_style_collector',
                    'analyze_v5_board_sample')
    previous = {name: sys.modules.pop(name, None) for name in module_names}
    old_path, old_bytecode = sys.path[:], sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    sys.path[:0] = [str(catalog_root), str(catalog_root.parent / 'v5-style-controls'),
                   str(source_project / 'artist_rater')]
    try:
        syntax = importlib.import_module('prompt_syntax')
        collector = importlib.import_module('arca_style_collector')
        analyzer = importlib.import_module('analyze_v5_board_sample')
        # The research module's standalone runner has machine-local paths.
        # Supply only its pure dependencies; none of its runner is executed.
        audit = ModuleType('audit_catalog')
        audit.ROOT, audit.RESEARCH = catalog_root, catalog_root.parent / 'v5-style-controls'
        audit._classify_tag, audit.key = analyzer._classify_tag, syntax.key
        audit.rows = audit.artist_names = audit.write = None
        sys.modules['audit_catalog'] = audit
        builder = importlib.import_module('build_catalog')
        options = importlib.import_module('export_source_options')
        yield syntax, collector, builder, options
    finally:
        sys.path[:] = old_path
        sys.dont_write_bytecode = old_bytecode
        for name, module in previous.items():
            sys.modules.pop(name, None)
            if module is not None:
                sys.modules[name] = module


def read_rows(database):
    with sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True) as connection:
        connection.execute('PRAGMA query_only = ON')
        connection.row_factory = sqlite3.Row
        return [dict(row) for row in connection.execute(
            "SELECT image.*, post.source_url, post.posted_at FROM arca_style_images image "
            "JOIN arca_style_items post ON post.id=image.item_id "
            "WHERE image.model_family='v5' AND image.metadata_status='ok' ORDER BY image.id")]


def natural_key(row):
    # CDN expiry/query parameters change independently of an image's identity.
    image = urlsplit(row['image_url'])
    return row['source_url'], image.netloc.casefold(), image.path


def pixel_hash(path):
    with Image.open(path) as image:
        pixels = image.convert('RGBA')
        digest = hashlib.sha256(str(pixels.size).encode('ascii'))
        digest.update(pixels.tobytes())
        return digest.hexdigest()


def choose_styles(rows, existing, names, syntax, collector, builder):
    old_fingerprints = {builder.fingerprint(syntax.parse(style['positive']),
                                           syntax.parse(style['negative'])) for style in existing}
    extracted = {row['id']: builder.extract(row, names, version=2) for row in rows}
    posts = defaultdict(list)
    for row in rows:
        posts[row['source_url']].append(row)
    selected, unresolved_groups, group_count = {}, 0, 0
    for images in posts.values():
        for group in collector.build_style_groups(images):
            group_count += 1
            candidates = [row for row in group['images'] if not extracted[row['id']]['issues']]
            if not candidates:
                unresolved_groups += 1
                continue
            counts = Counter(extracted[row['id']]['fingerprint'] for row in candidates)
            fingerprint = counts.most_common(1)[0][0]
            representative = max((row for row in candidates
                if extracted[row['id']]['fingerprint'] == fingerprint), key=lambda row: row['id'])
            recipe = extracted[representative['id']]
            if fingerprint in old_fingerprints or excluded_style(recipe['positive']):
                continue
            selected[fingerprint] = representative, recipe
    return selected, {'source_images': len(rows), 'source_groups': group_count,
                      'unresolved_images': sum(bool(item['issues']) for item in extracted.values()),
                      'unresolved_groups': unresolved_groups, 'new_recipes': len(selected)}


def import_styles(source_project, catalog_root, destination, artist_tags=None, apply=False):
    source_project, catalog_root, destination = (Path(value).resolve()
                                               for value in (source_project, catalog_root, destination))
    image_root = source_project / 'artist_rater' / 'data' / 'arca_style_images'
    if (destination == source_project or destination.is_relative_to(source_project)
            or destination == catalog_root or destination.is_relative_to(catalog_root)):
        raise ValueError('Destination must be separate from both read-only source catalogs.')
    rows = read_rows(source_project / 'artist_rater' / 'arca_style_seed.sqlite')
    local = {natural_key(row): row for row in read_rows(source_project / 'artist_rater' / 'data' / 'artist_rater.sqlite')}
    existing = json.loads((catalog_root / 'default_styles.json').read_text(encoding='utf-8'))['styles']
    with research_helpers(catalog_root, source_project) as (syntax, collector, builder, options_helper):
        names = set(json.loads((catalog_root.parent / 'v5-style-controls' / 'known_bare_artists_v2.json')
                               .read_text(encoding='utf-8'))['names'])
        if artist_tags:
            with Path(artist_tags).open(encoding='utf-8-sig', newline='') as source:
                names.update(syntax.key(row['tag']) for row in csv.DictReader(source))
        selected, summary = choose_styles(rows, existing, names, syntax, collector, builder)
        old_store = DakiSharedStyles(catalog_root)
        seen_pixels, seen_recipes, hidden_ids, hashes = {}, set(), [], {}
        duplicate_old_pixels, duplicate_old_recipes = 0, 0
        for style in old_store.list_styles():
            digest = pixel_hash(old_store.preview_path(style['id'], full=True))
            recipe_key = builder.fingerprint(syntax.parse(style['positive']), syntax.parse(style['negative']))
            hashes[style['id']] = digest
            duplicate_old_pixels += digest in seen_pixels
            duplicate_old_recipes += recipe_key in seen_recipes
            if digest in seen_pixels or recipe_key in seen_recipes:
                hidden_ids.append(style['id'])
            else:
                seen_pixels[digest] = style['id']
                seen_recipes.add(recipe_key)
        records, duplicate_new, repairs = [], 0, 0
        selected = sorted(selected.items(), key=lambda item: (item[1][0]['posted_at'], item[1][0]['id']), reverse=True)
        for fingerprint, (row, recipe) in selected:
            local_row = local.get(natural_key(row))
            if not local_row:
                raise ValueError('A selected V5 style has no local original image reference.')
            path = DakiSharedStyles._image_path(image_root.resolve(), local_row['image_path'])
            digest = pixel_hash(path)
            if digest in seen_pixels:
                duplicate_new += 1
                continue
            raw = json.loads(row['raw_metadata_json'])
            seed = raw['seed']
            if isinstance(seed, str) and seed.isdecimal():
                seed = int(seed)
            if type(seed) is not int or not 0 <= seed <= 9007199254740991:
                raise ValueError('A recorded source seed is not a nonnegative safe integer.')
            with Image.open(path) as image:
                dimensions = image.size
            if dimensions != (row['width'], row['height']):
                raise ValueError('A source image size differs from its recorded generation size.')
            sid = 'import-v5-' + fingerprint[:24]
            record = {
                'id': sid, 'name': f'V5 그림체 {len(records) + 1:03d}', 'category': 'v5',
                'model': row['model'], 'positive': recipe['positive'], 'negative': recipe['negative'],
                'source_url': row['source_url'], 'source_image_id': row['id'],
                'source_model': row['model'], 'seed': seed,
                'options': options_helper.original_options(raw, row['id']),
                'preview': {'image': local_row['image_path'], 'thumbnail': f'thumbs/{sid}.webp',
                            'width': dimensions[0], 'height': dimensions[1]},
                'fingerprint': fingerprint, 'pixel_sha256': digest,
                'import_edits': recipe['import_edits'],
            }
            # Reject incompatible settings before writing anything; never resize
            # or substitute defaults to make an unsupported source appear valid.
            build_style_test_payload(record, {'model': 'nai-diffusion-5-full', 'prompt': '',
                                              'negative_prompt': '', 'char_prompts': []})
            seen_pixels[digest] = sid
            hashes[sid] = digest
            records.append(record)
            repairs += bool(recipe['import_edits'])
    summary.update(imported_styles=len(records), duplicate_original_cards=len(hidden_ids),
                   duplicate_original_pixel_cards=duplicate_old_pixels,
                   duplicate_original_recipe_cards=duplicate_old_recipes,
                   duplicate_new_images=duplicate_new, adapted_source_syntax=repairs,
                   visible_original_styles=len(old_store.list_styles()) - len(hidden_ids),
                   payloads_validated=len(records), applied=apply)
    if not apply:
        return summary
    manifest_path = destination / 'catalog.json'
    previous = json.loads(manifest_path.read_text(encoding='utf-8')) if manifest_path.exists() else {'styles': []}
    by_id = {record['id']: record for record in records}
    # Retain previously imported IDs so older saved comparisons remain readable.
    for record in previous['styles']:
        by_id.setdefault(record['id'], record)
    records = list(by_id.values())
    destination.mkdir(parents=True, exist_ok=True)
    for record in records:
        thumbnail = DakiSharedStyles._image_path(destination, record['preview']['thumbnail'])
        if thumbnail.exists():
            continue
        original = DakiSharedStyles._image_path(image_root.resolve(), record['preview']['image'])
        with Image.open(original) as image:
            image.thumbnail((384, 384))
            thumbnail.parent.mkdir(parents=True, exist_ok=True)
            image.convert('RGB').save(thumbnail, 'WEBP', quality=87)
    manifest = {'version': 1, 'source_image_root': str(image_root.resolve()), 'styles': records,
                'hidden_style_ids': hidden_ids, 'pixel_hashes': hashes, 'summary': summary}
    fd, temporary = tempfile.mkstemp(prefix='catalog-', suffix='.json', dir=destination)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as output:
            json.dump(manifest, output, ensure_ascii=False, indent=2)
            output.write('\n')
        os.replace(temporary, manifest_path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-project', type=Path, required=True)
    parser.add_argument('--catalog-root', type=Path, required=True)
    parser.add_argument('--destination', type=Path, required=True)
    parser.add_argument('--artist-tags', type=Path)
    parser.add_argument('--apply', action='store_true', help='Write a local manifest and thumbnails; originals stay untouched.')
    args = parser.parse_args()
    summary = import_styles(args.source_project, args.catalog_root, args.destination, args.artist_tags, args.apply)
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    main()
