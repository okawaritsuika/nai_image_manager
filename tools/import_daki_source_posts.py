"""Copy already-collected Arca counts into NAIM without network or image access."""
import argparse
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from naim.storage.daki_style_sources import source_metadata, source_url
from naim.storage.json_files import write_json


def catalog_urls(catalog_root, imported_root):
    urls = set()
    for path in (Path(catalog_root) / 'default_styles.json', Path(imported_root) / 'catalog.json'):
        if not path.is_file():
            continue
        data = json.loads(path.read_text(encoding='utf-8'))
        for style in data.get('styles', []):
            if isinstance(style, dict) and (url := source_url(style.get('source_url'))):
                urls.add(url)
    return urls


def import_source_posts(database, catalog_root, imported_root, apply=False):
    database, catalog_root, imported_root = (Path(value).resolve()
                                           for value in (database, catalog_root, imported_root))
    if imported_root == catalog_root or imported_root.is_relative_to(catalog_root):
        raise ValueError('Destination must be separate from the read-only source catalog.')
    path = imported_root / 'source_posts.json'
    if path.resolve().parent != imported_root or database == path.resolve():
        raise ValueError('Source metadata destination is unsafe.')
    urls = catalog_urls(catalog_root, imported_root)
    posts = {}
    with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as connection:
        connection.execute('PRAGMA query_only = ON')
        for raw, count, collected in connection.execute(
                'SELECT source_url,recommendation_count,COALESCE(NULLIF(updated_at,\'\'),collected_at) '
                'FROM arca_style_items'):
            url = source_url(raw)
            if url in urls:
                posts[url] = source_metadata({'source_url': url, 'recommendation_count': count,
                                             'recommendation_collected_at': collected})
    # Retain metadata for older saved tests if the current catalog shrinks later.
    existing = json.loads(path.read_text(encoding='utf-8')) if path.is_file() else {}
    previous = existing.get('posts', {}) if isinstance(existing, dict) else {}
    retained = {url: source_metadata({'source_url': url}, row)
                for raw, row in previous.items() if (url := source_url(raw))} if isinstance(previous, dict) else {}
    retained.update(posts)
    summary = {'catalog_posts': len(urls), 'matched_posts': len(posts),
               'known_counts': sum(row['recommendation_count'] is not None for row in posts.values()),
               'missing_posts': len(urls - posts.keys()), 'retained_posts': len(retained), 'applied': bool(apply)}
    if apply:
        imported_root.mkdir(parents=True, exist_ok=True)
        write_json(path, {'version': 1, 'posts': retained}, indent=2)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True)
    parser.add_argument('--catalog-root', required=True)
    parser.add_argument('--imported-root', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    print(json.dumps(import_source_posts(args.database, args.catalog_root, args.imported_root, args.apply)))


if __name__ == '__main__':
    main()
