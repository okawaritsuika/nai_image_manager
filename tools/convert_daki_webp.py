"""Explicit offline conversion of Daki asset roots; no application import.

Use --root for generated assets and --catalog for catalogs with image fields.
Run while image generation/catalog editing is idle. Existing WebP is untouched.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from naim.images.webp_conversion import convert_image_to_webp
from naim.jobs.webp_compression import _is_link
from naim.storage.catalog_image_conversion import CatalogImageReferences


def convert_root(root, *, catalog=False, quality=90, dry_run=False):
    root = Path(root).absolute()
    if not root.is_dir() or _is_link(root):
        raise ValueError('변환할 실제 폴더를 지정해 주세요.')
    root = root.resolve()
    references = CatalogImageReferences(root) if catalog else None
    totals = Counter(converted=0, skipped=0, source_bytes=0, target_bytes=0)
    candidates = []
    # rglob never follows directory symlinks, and every result is checked again.
    for source in root.rglob('*'):
        if source.suffix.lower() in {'.png', '.jpg', '.jpeg', '.bmp', '.gif'} and source.is_file():
            if _is_link(source) or not source.resolve().is_relative_to(root):
                raise ValueError('변환 폴더 외부로 연결된 그림은 처리하지 않습니다.')
            candidates.append(source)
    for index, source in enumerate(sorted(candidates), 1):
        result = convert_image_to_webp(source, lossless=False, quality=quality, dry_run=dry_run,
                                       before_delete=references.prepare if references else None)
        success = result['status'] in {'converted', 'estimated'}
        totals['converted' if success else 'skipped'] += 1
        totals['source_bytes'] += result['source_bytes']
        totals['target_bytes'] += result['target_bytes'] if success else result['source_bytes']
        if not success:
            # Report counts/reasons only, never private filenames or prompts.
            print(json.dumps({'skipped_reason': result.get('reason', '건너뜀')}, ensure_ascii=False), flush=True)
        if index % 100 == 0:
            print(json.dumps({'processed': index, 'total': len(candidates), **totals}), flush=True)
    return dict(totals)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', action='append', default=[])
    parser.add_argument('--catalog', action='append', default=[])
    parser.add_argument('--quality', type=int, default=90)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    if not args.root and not args.catalog:
        parser.error('--root 또는 --catalog를 지정해 주세요.')
    if not 1 <= args.quality <= 100:
        parser.error('--quality는 1~100이어야 합니다.')
    total = Counter()
    for index, (root, catalog) in enumerate([(p, False) for p in args.root] + [(p, True) for p in args.catalog], 1):
        counts = convert_root(root, catalog=catalog, quality=args.quality, dry_run=args.dry_run)
        total.update(counts)
        print(json.dumps({'scope': index, 'dry_run': args.dry_run, **counts}), flush=True)
    print(json.dumps({'total': dict(total)}), flush=True)


if __name__ == '__main__':
    main()
