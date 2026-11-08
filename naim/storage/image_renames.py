"""Keep old image references readable after a same-folder file rename."""
import json
import os
from pathlib import Path

from naim.storage.json_files import json_lock


MANIFEST_NAME = '.naim-image-renames.json'


def read_image_renames(directory):
    path = Path(directory) / MANIFEST_NAME
    if path.is_symlink():
        raise ValueError('이름 변경 연결 파일의 경로를 확인해 주세요.')
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding='utf-8-sig'))
    if not isinstance(data, dict):
        raise ValueError('그림 이름 변경 연결을 읽지 못했습니다.')
    return data


def resolve_renamed_image_path(source):
    source = Path(source).absolute()
    if os.path.lexists(source):
        return source
    manifest = source.parent / MANIFEST_NAME
    with json_lock(manifest):
        aliases = read_image_renames(source.parent)
    name = source.name
    seen = set()
    while name in aliases:
        if name in seen:
            raise ValueError('그림 이름 변경 연결이 순환합니다.')
        seen.add(name)
        name = aliases[name]
        if (not isinstance(name, str) or not name or name in ('.', '..')
                or any(char in name for char in '/\\:\x00')):
            raise ValueError('그림 이름 변경 연결의 경로가 올바르지 않습니다.')
    target = source.with_name(name)
    if target.is_symlink() or target.resolve().parent != source.parent.resolve():
        raise ValueError('그림 폴더 밖으로 연결할 수 없습니다.')
    return target if target.is_file() else source
