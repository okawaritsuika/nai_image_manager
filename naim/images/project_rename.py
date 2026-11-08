"""Rename a project image bundle while retaining its saved logical references."""
from contextlib import nullcontext
from copy import deepcopy
import os
from pathlib import Path
import shutil

from naim.project_names import validate_windows_name
from naim.storage.daki_projects import DakiCanvasConflict, DakiNotFoundError, SIDES
from naim.storage.image_files import IMAGE_FILES_LOCK, image_bundle_paths
from naim.storage.image_renames import MANIFEST_NAME, read_image_renames
from naim.storage.json_files import json_lock, write_json


def _units(text):
    return sum(2 if ord(char) > 0xffff else 1 for char in str(text))


def _copy_exclusive(source, target):
    with source.open('rb') as incoming, target.open('xb') as outgoing:
        try:
            shutil.copyfileobj(incoming, outgoing)
        except Exception:
            outgoing.close()
            target.unlink()
            raise
    try:
        shutil.copystat(source, target)
    except Exception:
        target.unlink()
        raise


def rename_project_image(store, project_id, candidate_id, name, expected_name,
                         reference_update=None):
    name = validate_windows_name(name)
    with IMAGE_FILES_LOCK, json_lock(store.path):
        before = store._load(store.path)
        data = deepcopy(before)
        project = store._find_project(data, project_id)
        candidate = next((item for side in SIDES for item in project['candidates'][side]
                          if item['id'] == candidate_id), None)
        if candidate is None:
            raise DakiNotFoundError('다키 후보를 찾을 수 없습니다.')
        source, actual = store.resolve_image(candidate['path'])
        source = Path(source).absolute()
        current_name = candidate.get('name') or Path(candidate['path']).name
        if source.suffix.lower() == '.webp' and Path(current_name).suffix.lower() in ('.png', '.jpg', '.jpeg'):
            current_name = str(Path(current_name).with_suffix('.webp'))
        if not isinstance(expected_name, str) or expected_name != current_name:
            raise DakiCanvasConflict('그림 이름이 변경되었습니다. 새로고침 후 다시 수정해 주세요.')
        if source.suffix.lower() not in ('.png', '.jpg', '.jpeg', '.webp') or not source.is_file():
            raise ValueError('이름을 변경할 그림 파일을 찾을 수 없습니다.')
        if Path(name).suffix.lower() != source.suffix.lower():
            raise ValueError('그림의 확장자는 변경할 수 없습니다.')
        target = source.with_name(name)
        if source.is_symlink() or source.resolve().parent != target.resolve().parent:
            raise ValueError('그림 폴더 안의 일반 파일만 이름을 변경할 수 있습니다.')
        pairs = [(old, new) for old, new in zip(image_bundle_paths(source), image_bundle_paths(target))
                 if old.exists()]
        for old, new in pairs:
            if old.is_symlink() or not old.is_file():
                raise ValueError('그림과 메타데이터 경로를 확인해 주세요.')
            if _units(new.name) > 255 or _units(new) > 259:
                raise ValueError('저장 폴더를 포함한 경로가 Windows 길이 제한을 넘습니다. 이름을 줄여 주세요.')
            if old != new and os.path.lexists(new):
                raise ValueError('같은 이름의 파일이 이미 있습니다. 다른 이름을 입력해 주세요.')
        manifest = source.parent / MANIFEST_NAME
        with json_lock(manifest):
            aliases_before = read_image_renames(source.parent)
            if source != target and name.casefold() in {key.casefold() for key in aliases_before}:
                raise ValueError('이전 그림에서 사용하는 이름입니다. 다른 이름을 입력해 주세요.')
            aliases = dict(aliases_before)
            if source != target:
                for old, new in pairs:
                    aliases[old.name] = new.name
                # Flatten repeated renames so old canvas URLs resolve in one hop.
                for key, value in list(aliases.items()):
                    if value == source.name:
                        aliases[key] = name
            # Locate shared candidates before changing the source's filesystem name.
            for owner in data['projects']:
                for side in SIDES:
                    for item in owner['candidates'][side]:
                        try:
                            other, _ = store.resolve_image(item['path'])
                        except (OSError, ValueError):
                            continue
                        if os.path.normcase(os.path.abspath(other)) == os.path.normcase(str(source)):
                            item['name'] = name
            published = []
            removed = []
            saved = False
            try:
                for old, new in pairs:
                    if old != new:
                        _copy_exclusive(old, new)
                        published.append(new)
                context = reference_update(source, target) if reference_update and source != target else nullcontext()
                with context:
                    write_json(manifest, aliases, indent=2)
                    saved = True
                    write_json(store.path, data, indent=2)
                    for old, new in pairs:
                        if old != new:
                            # Replace only our staged copy with the actual source;
                            # a rename retains creation time and filesystem metadata.
                            old.replace(new)
                            removed.append((old, new))
            except Exception:
                # Keep both copies if recovery itself fails; never discard the only image.
                for old, new in removed:
                    new.rename(old)
                if saved:
                    write_json(store.path, before, indent=2)
                    write_json(manifest, aliases_before, indent=2)
                for new in reversed(published):
                    new.unlink(missing_ok=True)
                raise
        return store.get_project(project_id)
