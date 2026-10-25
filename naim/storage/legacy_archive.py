"""Read-only access to images left by the retired generation workspaces."""
import heapq
import os
from pathlib import Path, PurePosixPath


IMAGE_EXTENSIONS = frozenset({'.png', '.jpg', '.jpeg', '.webp', '.bmp'})


def resolve_archive_image(root, relative):
    relative = str(relative or '').replace('\\', '/')
    path = PurePosixPath(relative)
    if not relative or path.is_absolute() or '..' in path.parts or any(':' in part for part in path.parts):
        raise ValueError('허용되지 않은 이미지 경로입니다.')
    base = Path(root).resolve()
    target = (base / relative).resolve(strict=True)
    if not target.is_relative_to(base) or target.suffix.lower() not in IMAGE_EXTENSIONS or not target.is_file():
        raise ValueError('보존된 이미지 파일만 열 수 있습니다.')
    return target


def _iter_images(root):
    base = Path(root)
    if not base.is_dir():
        return
    for folder, directories, files in os.walk(base, followlinks=False):
        # Do not follow Windows junctions or symlink directories into other data.
        retained = []
        for name in directories:
            path = Path(folder) / name
            try:
                if not path.is_symlink() and not getattr(path.stat(), 'st_file_attributes', 0) & 0x400:
                    retained.append(name)
            except OSError:
                continue
        directories[:] = retained
        for name in files:
            if Path(name).suffix.lower() not in IMAGE_EXTENSIONS:
                continue
            relative = (Path(folder) / name).relative_to(base).as_posix()
            try:
                path = resolve_archive_image(base, relative)
                stat = path.stat()
            except (OSError, ValueError):
                continue
            yield {'name': name, 'path': relative, 'size': stat.st_size,
                   'mtime': int(stat.st_mtime * 1000)}


def list_archive_images(root, cursor='', limit=48):
    """Page by relative filename with bounded memory and no image decoding."""
    limit = max(1, min(96, int(limit)))
    cursor_key = (str(cursor).casefold(), str(cursor))

    def order(item):
        return item['path'].casefold(), item['path']

    candidates = (item for item in _iter_images(root) if not cursor or order(item) > cursor_key)
    items = heapq.nsmallest(limit + 1, candidates, key=order)
    return {'items': items[:limit],
            'next_cursor': items[limit - 1]['path'] if len(items) > limit else ''}
