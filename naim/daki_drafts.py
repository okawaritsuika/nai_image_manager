"""Persist explicit image drafts separately from shared-style comparison batches."""
from copy import deepcopy
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import secrets
import shutil
import tempfile
import threading
import uuid

from PIL import Image
from PIL.PngImagePlugin import PngInfo

from naim.daki_style_tests import (
    DakiAnlasConfirmation, DakiStyleTestConflict, GENERATION_DEFAULTS, MODELS,
    build_style_test_payload,
)
from naim.novelai import generate_text_image
from naim.images.daki_framing import frame_image, framed_png_metadata, normalize_framing
from naim.images.webp_conversion import resolve_webp_image, restore_webp_metadata
from naim.storage.json_files import write_json


DRAFT_ID = re.compile(r'[a-f0-9]{32}\Z')
FOLDER_ID = DRAFT_ID


class DakiDraftReferencesConflict(DakiStyleTestConflict):
    def __init__(self, references):
        super().__init__('daki 후보, 개인 그림체의 대표 그림 또는 태그사전 예시로 연결되어 있습니다. 삭제하면 원본 연결이 끊길 수 있습니다.')
        self.references = references


def _now():
    return datetime.now(timezone.utc).isoformat()


def _text(value, label, limit=30000):
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError(f'{label} 내용을 확인해 주세요.')
    return value.strip()


def normalize_draft_settings(data):
    """Keep editable inputs; payload validation shares the comparison generator."""
    if not isinstance(data, dict):
        raise ValueError('그림체/시안 설정은 JSON 객체여야 합니다.')
    model = data.get('model', 'nai-diffusion-5-full')
    if not isinstance(model, str) or model not in MODELS:
        raise ValueError('V5 Full, V5 Full Medium 또는 V4.5 Full 모델을 선택해 주세요.')
    seed = data.get('seed', -1)
    if type(seed) is not int or not -1 <= seed <= 4294967295:
        raise ValueError('시드는 -1(무작위) 또는 0~4294967295의 정수로 입력해 주세요.')
    options = data.get('options', {})
    if not isinstance(options, dict):
        raise ValueError('생성 옵션을 확인해 주세요.')
    positioning = data.get('character_positioning', 'auto')
    if positioning not in ('auto', 'custom'):
        raise ValueError('캐릭터 위치는 자동 또는 직접 지정을 선택해 주세요.')
    characters = data.get('char_prompts', [])
    maximum = 22 if model.startswith('nai-diffusion-5') else 6
    if not isinstance(characters, list) or len(characters) > maximum:
        raise ValueError(f'이 모델의 캐릭터 프롬프트는 최대 {maximum}개입니다.')
    normalized = []
    for character in characters:
        if not isinstance(character, dict):
            raise ValueError('캐릭터 프롬프트 내용을 확인해 주세요.')
        item = {key: _text(character.get(key, ''), '캐릭터 프롬프트')
                for key in ('prompt', 'negative_prompt')}
        for key in ('x', 'y'):
            value = character.get(key, .5)
            if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1:
                raise ValueError('캐릭터 위치는 0~1 사이의 숫자로 입력해 주세요.')
            item[key] = value
        normalized.append(item)
    settings = {
        'prompt': _text(data.get('prompt', ''), 'Base 프롬프트'),
        'negative_prompt': _text(data.get('negative_prompt', ''), 'Nega 프롬프트'),
        'model': model, 'width': data.get('width', 512), 'height': data.get('height', 768),
        'seed': seed, 'character_positioning': positioning, 'char_prompts': normalized,
        'options': {key: deepcopy(options.get(key, value)) for key, value in GENERATION_DEFAULTS.items()},
    }
    # A style label records where the editable values came from. It never grants
    # access to a catalog path or replaces the user's current prompt/options.
    source = data.get('style')
    if source is not None:
        if (not isinstance(source, dict) or source.get('library') not in ('shared', 'personal')
                or not isinstance(source.get('id'), str)
                or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', source['id'])):
            raise ValueError('선택한 그림체 정보를 확인해 주세요.')
        settings['style'] = {'id': source['id'], 'library': source['library'],
                             'name': _text(source.get('name', ''), '그림체 이름', 120),
                             'positive': _text(source.get('positive', ''), '그림체 Base 프롬프트'),
                             'negative': _text(source.get('negative', ''), '그림체 Nega 프롬프트')}
    build_draft_payload(settings)
    return settings


def build_draft_payload(settings):
    style = {'positive': '', 'negative': '', 'options': settings['options'],
             'preview': {'width': settings['width'], 'height': settings['height']}}
    payload = build_style_test_payload(style, settings)
    custom = settings['character_positioning'] == 'custom' and bool(settings['char_prompts'])
    for key in ('v4_prompt', 'v4_negative_prompt'):
        section = payload['parameters'][key]
        section['use_coords'] = custom
        for caption, character in zip(section['caption']['char_captions'], settings['char_prompts']):
            caption['centers'] = [{'x': character['x'] if custom else .5,
                                   'y': character['y'] if custom else .5}]
    return payload


class DakiDrafts:
    def __init__(self, root_provider, key_provider, generator=None,
                 excluded_draft_ids_provider=None, references_provider=None):
        self.root_provider = root_provider
        self.key_provider = key_provider
        self.generator = generator or generate_text_image
        self.excluded_draft_ids_provider = excluded_draft_ids_provider or (lambda: ())
        self.references_provider = references_provider or (lambda paths: ())
        self.lock = threading.RLock()
        self._active = None
        self._thread = None
        self._recovered = set()

    def _root(self):
        value = self.root_provider() if callable(self.root_provider) else self.root_provider
        return Path(value).resolve()

    @staticmethod
    def _directory(root, draft_id):
        if not isinstance(draft_id, str) or not DRAFT_ID.fullmatch(draft_id):
            raise ValueError('올바른 시안을 선택해 주세요.')
        path = (root / draft_id).resolve()
        if path.parent != root:
            raise ValueError('허용되지 않는 시안 경로입니다.')
        return path

    def _file(self, root, draft_id, filename):
        directory = self._directory(root, draft_id)
        path = (directory / filename).resolve()
        if path.parent != directory:
            raise ValueError('허용되지 않는 시안 경로입니다.')
        return path

    @staticmethod
    def _catalog_path(root):
        path = root / 'folders.json'
        if path.resolve().parent != root:
            raise ValueError('허용되지 않는 시안 폴더 경로입니다.')
        return path

    def _load_catalog(self, root):
        path = self._catalog_path(root)
        try:
            with path.open(encoding='utf-8') as stream:
                catalog = json.load(stream)
        except FileNotFoundError:
            return {'folders': []}
        if not isinstance(catalog, dict) or not isinstance(catalog.get('folders'), list):
            raise ValueError('저장된 시안 폴더 형식을 확인해 주세요.')
        seen = set()
        for folder in catalog['folders']:
            if (not isinstance(folder, dict) or not isinstance(folder.get('id'), str)
                    or not FOLDER_ID.fullmatch(folder['id']) or folder['id'] in seen):
                raise ValueError('저장된 시안 폴더 형식을 확인해 주세요.')
            seen.add(folder['id'])
        return catalog

    def _save_catalog(self, root, catalog):
        root.mkdir(parents=True, exist_ok=True)
        write_json(self._catalog_path(root), catalog, indent=2)

    @staticmethod
    def _folder_index(catalog, folder_id):
        for index, folder in enumerate(catalog['folders']):
            if folder['id'] == folder_id:
                return index
        return None

    @staticmethod
    def _folder_name(value):
        if not isinstance(value, str):
            raise ValueError('시안 폴더 이름을 입력해 주세요.')
        name = value.strip()
        if not name or len(name) > 120:
            raise ValueError('시안 폴더 이름은 1~120자로 입력해 주세요.')
        return name

    @staticmethod
    def _project_id(value):
        if value == '':
            return ''
        if not isinstance(value, str) or not FOLDER_ID.fullmatch(value):
            raise ValueError('프로젝트 정보를 확인해 주세요.')
        return value

    def _excluded_ids(self):
        values = self.excluded_draft_ids_provider()
        if isinstance(values, str):
            values = (values,)
        return {value for value in (values or ()) if isinstance(value, str)}

    def _load(self, root, draft_id):
        with self._file(root, draft_id, 'draft.json').open(encoding='utf-8') as stream:
            record = json.load(stream)
        if (not isinstance(record, dict) or record.get('id') != draft_id
                or not isinstance(record.get('settings'), dict)
                or record.get('status') not in ('running', 'completed', 'failed')):
            raise ValueError('저장된 시안 형식을 확인해 주세요.')
        return record

    def _save(self, root, record):
        record['updated_at'] = _now()
        self._directory(root, record['id']).mkdir(parents=True, exist_ok=True)
        write_json(self._file(root, record['id'], 'draft.json'), record, indent=2)

    def _recover(self, root):
        if root in self._recovered:
            return
        if root.exists():
            for path in root.iterdir():
                if path.is_dir() and DRAFT_ID.fullmatch(path.name):
                    try:
                        record = self._load(root, path.name)
                    except (OSError, ValueError):
                        continue
                    if record['status'] == 'running':
                        record.update(status='failed', error='프로그램이 종료되어 결과를 확인할 수 없습니다. 자동으로 다시 생성하지 않습니다.')
                        self._save(root, record)
        self._recovered.add(root)

    @staticmethod
    def _public(record):
        result = {key: deepcopy(record.get(key)) for key in
                  ('id', 'status', 'created_at', 'updated_at', 'settings', 'seed')}
        result.update(purpose='tag_example' if record.get('purpose') == 'tag_example' else 'draft',
                      selected=record.get('selected') is True)
        if isinstance(record.get('folder_id'), str):
            result['folder_id'] = record['folder_id']
        result.update(width=record['settings']['width'], height=record['settings']['height'],
                      path=f"__daki_drafts__/{record['id']}.png")
        if record.get('framing'):
            result['framing'] = deepcopy(record['framing'])
            result.update(width=record['framing']['width'], height=record['framing']['height'])
        if record['status'] == 'completed':
            result['src'] = f"/api/daki/drafts/{record['id']}/image"
        if record.get('error'):
            result['error'] = record['error']
        return result

    def list_drafts(self, purpose=None):
        if purpose is not None and purpose not in ('draft', 'tag_example'):
            raise ValueError('시안 종류를 확인해 주세요.')
        with self.lock:
            root = self._root()
            self._recover(root)
            records = []
            if root.exists():
                for path in root.iterdir():
                    if path.is_dir() and DRAFT_ID.fullmatch(path.name):
                        try:
                            public = self._public(self._load(root, path.name))
                            if purpose is None or public['purpose'] == purpose:
                                records.append(public)
                        except FileNotFoundError:
                            # A failed first manifest write may leave only its
                            # empty directory. Existing results remain visible.
                            continue
            return sorted(records, key=lambda item: item['created_at'], reverse=True)

    def get(self, draft_id):
        with self.lock:
            root = self._root()
            self._recover(root)
            return self._public(self._load(root, draft_id))

    def _folder_records(self, root):
        records = []
        if not root.exists():
            return records
        self._recover(root)
        for path in root.iterdir():
            if not path.is_dir() or not DRAFT_ID.fullmatch(path.name):
                continue
            try:
                record = self._load(root, path.name)
            except FileNotFoundError:
                # A failed first manifest write may leave an empty directory.
                continue
            except (OSError, ValueError):
                continue
            records.append(record)
        return records

    @staticmethod
    def _matches_folder(record, folder_id):
        if record.get('purpose', 'draft') != 'draft':
            return False
        if folder_id == 'legacy':
            return not record.get('folder_id')
        return record.get('folder_id') == folder_id

    def _folder_drafts(self, root, folder_id, records=None, excluded=None):
        records = self._folder_records(root) if records is None else records
        excluded = self._excluded_ids() if excluded is None else excluded
        rows = [self._public(record) for record in records
                if self._matches_folder(record, folder_id) and record['id'] not in excluded]
        return sorted(rows, key=lambda item: item['created_at'], reverse=True)

    @staticmethod
    def _folder_summary(folder, drafts, *, legacy=False):
        result = deepcopy(folder)
        completed = next((draft for draft in drafts if draft['status'] == 'completed'), None)
        result.update(count=len(drafts),
                      selected_count=sum(draft['selected'] for draft in drafts),
                      src=completed.get('src') if completed else None)
        if legacy:
            result['legacy'] = True
        return result

    def _legacy_folder(self, drafts):
        settings = deepcopy(drafts[0]['settings']) if drafts else normalize_draft_settings({})
        folder = {'id': 'legacy', 'name': '기존 시안', 'project_id': '', 'settings': settings}
        return self._folder_summary(folder, drafts, legacy=True)

    def list_folders(self, project_id=None):
        if project_id is not None:
            project_id = self._project_id(project_id)
        with self.lock:
            root = self._root()
            records = self._folder_records(root)
            excluded = self._excluded_ids()
            catalog = self._load_catalog(root)
            folders = []
            for folder in catalog['folders']:
                if project_id is not None and folder.get('project_id', '') != project_id:
                    continue
                drafts = self._folder_drafts(root, folder['id'], records, excluded)
                folders.append(self._folder_summary(folder, drafts))
            legacy_drafts = self._folder_drafts(root, 'legacy', records, excluded)
            if legacy_drafts and project_id in (None, ''):
                folders.append(self._legacy_folder(legacy_drafts))
            return folders

    def create_folder(self, data):
        if not isinstance(data, dict):
            raise ValueError('요청 내용은 JSON 객체여야 합니다.')
        name = data.get('name', '')
        name = '' if isinstance(name, str) and not name.strip() else self._folder_name(name)
        folder = {
            'id': uuid.uuid4().hex,
            'name': name,
            'project_id': self._project_id(data.get('project_id', '')),
            'settings': normalize_draft_settings(data.get('settings', {})),
            'created_at': _now(),
            'updated_at': _now(),
        }
        with self.lock:
            root = self._root()
            catalog = self._load_catalog(root)
            if not name:
                # Allocate together with the save so simultaneous requests cannot reuse a number.
                number = 1
                for saved in catalog['folders']:
                    if saved.get('project_id', '') == folder['project_id']:
                        match = re.fullmatch(r'시안([1-9][0-9]*)', str(saved.get('name', '')))
                        if match:
                            number = max(number, int(match.group(1)) + 1)
                folder['name'] = f'시안{number}'
            catalog['folders'].append(folder)
            self._save_catalog(root, catalog)
            return self._folder_summary(folder, [])

    def get_folder(self, folder_id):
        with self.lock:
            root = self._root()
            records = self._folder_records(root)
            excluded = self._excluded_ids()
            drafts = self._folder_drafts(root, folder_id, records, excluded)
            if folder_id == 'legacy':
                folder = self._legacy_folder(drafts)
            else:
                if not isinstance(folder_id, str) or not FOLDER_ID.fullmatch(folder_id):
                    raise ValueError('올바른 시안 폴더를 선택해 주세요.')
                catalog = self._load_catalog(root)
                index = self._folder_index(catalog, folder_id)
                if index is None:
                    raise FileNotFoundError('시안 폴더를 찾을 수 없습니다.')
                folder = self._folder_summary(catalog['folders'][index], drafts)
            return {'folder': folder, 'drafts': drafts}

    def update_folder(self, folder_id, data):
        if not isinstance(data, dict):
            raise ValueError('요청 내용은 JSON 객체여야 합니다.')
        if folder_id == 'legacy':
            raise ValueError('기존 시안 폴더는 이름이나 설정을 바꿀 수 없습니다.')
        with self.lock:
            root = self._root()
            if not isinstance(folder_id, str) or not FOLDER_ID.fullmatch(folder_id):
                raise ValueError('올바른 시안 폴더를 선택해 주세요.')
            catalog = self._load_catalog(root)
            index = self._folder_index(catalog, folder_id)
            if index is None:
                raise FileNotFoundError('시안 폴더를 찾을 수 없습니다.')
            folder = catalog['folders'][index]
            if 'name' in data:
                folder['name'] = self._folder_name(data['name'])
            if 'settings' in data:
                folder['settings'] = normalize_draft_settings(data['settings'])
            if 'name' in data or 'settings' in data:
                folder['updated_at'] = _now()
                self._save_catalog(root, catalog)
            return self.get_folder(folder_id)

    def set_selected(self, draft_id, selected):
        if type(selected) is not bool:
            raise ValueError('선택 여부는 true 또는 false여야 합니다.')
        with self.lock:
            root = self._root()
            self._recover(root)
            record = self._load(root, draft_id)
            if record['status'] != 'completed':
                raise DakiStyleTestConflict('완성된 시안만 선택할 수 있습니다.')
            record['selected'] = selected
            self._save(root, record)
            return self._public(record)

    def delete_folder_drafts(self, folder_id, ids, preserve_selected=False, confirm_daki=False):
        if not isinstance(ids, list) or not ids or len(ids) > 10000:
            raise ValueError('삭제할 시안 목록을 확인해 주세요.')
        if any(not isinstance(draft_id, str) or not DRAFT_ID.fullmatch(draft_id) for draft_id in ids):
            raise ValueError('시안 ID를 확인해 주세요.')
        if len(set(ids)) != len(ids):
            raise ValueError('중복 시안 ID는 한 번만 입력해 주세요.')
        if type(preserve_selected) is not bool or type(confirm_daki) is not bool:
            raise ValueError('삭제 옵션을 확인해 주세요.')
        if folder_id != 'legacy' and (not isinstance(folder_id, str) or not FOLDER_ID.fullmatch(folder_id)):
            raise ValueError('올바른 시안 폴더를 선택해 주세요.')

        with self.lock:
            root = self._root()
            self._recover(root)
            if folder_id != 'legacy':
                catalog = self._load_catalog(root)
                if self._folder_index(catalog, folder_id) is None:
                    raise FileNotFoundError('시안 폴더를 찾을 수 없습니다.')
            excluded = self._excluded_ids()
            records = []
            for draft_id in ids:
                directory_entry = root / draft_id
                directory = self._directory(root, draft_id)
                if (directory_entry.is_symlink() or directory != directory_entry
                        or directory.parent != root or not directory.is_dir()):
                    raise FileNotFoundError('시안을 찾을 수 없습니다.')
                record = self._load(root, draft_id)
                if not self._matches_folder(record, folder_id) or draft_id in excluded:
                    raise ValueError('선택한 시안이 이 폴더에 속하지 않습니다.')
                if record['status'] == 'running':
                    raise DakiStyleTestConflict('생성 중인 시안은 삭제할 수 없습니다.')
                if record.get('purpose', 'draft') != 'draft':
                    raise ValueError('일반 시안만 삭제할 수 있습니다.')
                records.append((draft_id, directory, record))

            skipped = [draft_id for draft_id, _, record in records
                       if preserve_selected and record.get('selected') is True]
            candidates = [(draft_id, directory) for draft_id, directory, record in records
                          if not (preserve_selected and record.get('selected') is True)]
            if candidates and not confirm_daki:
                paths = [f'__daki_drafts__/{draft_id}.png' for draft_id, _ in candidates]
                references = list(self.references_provider(paths) or ())
                if references:
                    raise DakiDraftReferencesConflict(references)

            deleted, failed = [], []
            for draft_id, directory in candidates:
                try:
                    entry = root / draft_id
                    if entry.is_symlink() or entry.resolve() != directory or directory.parent != root:
                        raise ValueError('허용되지 않는 시안 경로입니다.')
                    shutil.rmtree(directory)
                    deleted.append(draft_id)
                except (OSError, ValueError):
                    failed.append(draft_id)
            return {'deleted_ids': deleted, 'failed_ids': failed, 'skipped_ids': skipped}

    def delete_folder(self, folder_id, confirm_daki=False):
        if not isinstance(folder_id, str) or not FOLDER_ID.fullmatch(folder_id):
            raise ValueError('올바른 시안 폴더를 선택해 주세요.')
        if type(confirm_daki) is not bool:
            raise ValueError('삭제 옵션을 확인해 주세요.')

        with self.lock:
            root = self._root()
            self._recover(root)
            catalog = self._load_catalog(root)
            folder_index = self._folder_index(catalog, folder_id)
            if folder_index is None:
                raise FileNotFoundError('시안 폴더를 찾을 수 없습니다.')
            folder = catalog['folders'][folder_index]
            catalog_without_folder = deepcopy(catalog)
            del catalog_without_folder['folders'][folder_index]

            owned = []
            if root.exists():
                for entry in root.iterdir():
                    if not DRAFT_ID.fullmatch(entry.name) or not entry.is_dir():
                        continue
                    if entry.is_symlink() or entry.resolve() != entry or entry.resolve().parent != root:
                        raise ValueError('허용되지 않는 시안 경로입니다.')
                    directory = self._directory(root, entry.name)
                    if directory != entry or directory.parent != root:
                        raise ValueError('허용되지 않는 시안 경로입니다.')
                    try:
                        record = self._load(root, entry.name)
                    except FileNotFoundError:
                        # Failed initial manifest writes can leave only an empty directory.
                        if not any(entry.iterdir()):
                            continue
                        raise ValueError('저장된 시안 형식을 확인해 주세요.') from None

                    record_folder = record.get('folder_id')
                    purpose = record.get('purpose', 'draft')
                    if record_folder == folder_id and purpose != 'draft':
                        raise ValueError('일반 시안 폴더에 다른 종류의 시안이 연결되어 있습니다.')
                    if record_folder != folder_id:
                        continue
                    if purpose != 'draft':
                        raise ValueError('일반 시안 폴더의 시안 종류를 확인해 주세요.')
                    owned.append((entry.name, directory, record))

            active_id = None
            if self._active is not None and self._active[0] == root:
                active_id = self._active[1]
            if active_id is not None and any(draft_id == active_id for draft_id, _, _ in owned):
                raise DakiStyleTestConflict('생성 중인 시안이 있어 폴더를 삭제할 수 없습니다.')
            if any(record['status'] == 'running' for _, _, record in owned):
                raise DakiStyleTestConflict('생성 중인 시안이 있어 폴더를 삭제할 수 없습니다.')

            owned.sort(key=lambda item: item[0])
            draft_ids = [draft_id for draft_id, _, _ in owned]
            if draft_ids and not confirm_daki:
                paths = [f'__daki_drafts__/{draft_id}.png' for draft_id in draft_ids]
                references = list(self.references_provider(paths) or ())
                if references:
                    raise DakiDraftReferencesConflict(references)

            staging = None
            moved = []
            try:
                if owned:
                    staging = Path(tempfile.mkdtemp(prefix='.delete-folder-', dir=str(root)))
                for draft_id, directory, _ in owned:
                    entry = root / draft_id
                    current = self._directory(root, draft_id)
                    if (entry.is_symlink() or entry.resolve() != directory or current != directory
                            or current.parent != root or not entry.is_dir()):
                        raise ValueError('허용되지 않는 시안 경로입니다.')
                    destination = staging / draft_id
                    os.replace(entry, destination)
                    moved.append((entry, destination))

                self._save_catalog(root, catalog_without_folder)
            except Exception as error:
                rollback_errors = []
                for original, staged in reversed(moved):
                    try:
                        if original.exists() or original.is_symlink():
                            raise OSError('시안 경로가 복구 중에 변경되었습니다.')
                        os.replace(staged, original)
                    except OSError as rollback_error:
                        rollback_errors.append(rollback_error)
                if staging is not None and not rollback_errors:
                    try:
                        staging.rmdir()
                    except OSError as cleanup_error:
                        rollback_errors.append(cleanup_error)
                if rollback_errors:
                    raise OSError('시안 폴더 삭제 중 오류가 발생해 복구를 완료하지 못했습니다.') from error
                raise

            result = {
                'deleted_folder_id': folder_id,
                'project_id': folder.get('project_id', ''),
                'deleted_ids': draft_ids,
            }
            if staging is not None:
                try:
                    shutil.rmtree(staging)
                except OSError:
                    result['warning'] = '시안 폴더는 삭제했지만 일부 시안 파일 정리를 마치지 못했습니다.'
            return result

    def iter_completed_prompt_images(self):
        """Read saved positive recipes without recovery writes or generation."""
        root = self._root()
        if not root.is_dir():
            return
        for directory in sorted(root.iterdir(), key=lambda path: path.name):
            if not directory.is_dir() or not DRAFT_ID.fullmatch(directory.name):
                continue
            try:
                with self.lock:
                    record = self._load(root, directory.name)
                    if record['status'] != 'completed':
                        continue
                    image = resolve_webp_image(self._file(root, directory.name, 'image.png')).resolve()
                    if (image.parent != self._directory(root, directory.name)
                            or not image.is_file()):
                        continue
                    info = deepcopy(record['settings'])
                yield {'path': f"__daki_drafts__/{directory.name}.png", 'name': '시안 · ' + directory.name[:8],
                       'prompt_info': info}
            except (OSError, ValueError):
                continue

    def _store_folder_settings(self, root, folder_id, settings):
        catalog = self._load_catalog(root)
        index = self._folder_index(catalog, folder_id)
        if index is None:
            raise FileNotFoundError('시안 폴더를 찾을 수 없습니다.')
        folder = catalog['folders'][index]
        previous = {'settings': deepcopy(folder.get('settings')), 'updated_at': folder.get('updated_at')}
        folder['settings'] = deepcopy(settings)
        folder['updated_at'] = _now()
        self._save_catalog(root, catalog)
        return previous

    def _restore_folder_settings(self, root, folder_id, previous):
        catalog = self._load_catalog(root)
        index = self._folder_index(catalog, folder_id)
        if index is None:
            raise FileNotFoundError('시안 폴더를 찾을 수 없습니다.')
        folder = catalog['folders'][index]
        if previous['settings'] is None:
            folder.pop('settings', None)
        else:
            folder['settings'] = previous['settings']
        if previous['updated_at'] is None:
            folder.pop('updated_at', None)
        else:
            folder['updated_at'] = previous['updated_at']
        self._save_catalog(root, catalog)

    def _start(self, root, record, allow_anlas, persist_folder_settings=False):
        if self._active is not None:
            raise DakiStyleTestConflict('이미 시안을 생성하고 있습니다. 완료 후 다시 시도해 주세요.')
        payload = build_draft_payload(record['settings'])
        parameters = payload['parameters']
        if (parameters['width'] * parameters['height'] > 1048576 or parameters['steps'] > 28) and allow_anlas is not True:
            raise DakiAnlasConfirmation('이 설정은 Anlas가 소모될 수 있습니다. 사용에 동의한 뒤 실행해 주세요.')
        key = self.key_provider()
        if not isinstance(key, str) or not key.strip():
            raise ValueError('NovelAI API Key를 먼저 설정해 주세요.')
        seed = record['settings']['seed']
        if seed == -1:
            seed = secrets.randbelow(2 ** 32)
        parameters.update(seed=seed, extra_noise_seed=seed, n_samples=1)
        record.update(seed=seed, status='running')
        record.pop('error', None)
        previous_folder = None
        try:
            if persist_folder_settings:
                previous_folder = self._store_folder_settings(root, record['folder_id'], record['settings'])
            self._save(root, record)
            self._active = (root, record['id'])
            self._thread = threading.Thread(target=self._worker, args=(root, record['id'], payload, key.strip()), daemon=True)
            try:
                self._thread.start()
            except RuntimeError:
                self._active = None
                self._thread = None
                record.update(status='failed', error='생성을 시작하지 못했습니다. 다시 시도해 주세요.')
                self._save(root, record)
                raise DakiStyleTestConflict(record['error']) from None
            return self._public(record)
        except Exception:
            if self._active == (root, record['id']):
                self._active = None
                self._thread = None
            if previous_folder is not None:
                self._restore_folder_settings(root, record['folder_id'], previous_folder)
            raise

    def create(self, data):
        if not isinstance(data, dict):
            raise ValueError('그림체/시안 설정은 JSON 객체여야 합니다.')
        purpose = data.get('purpose', 'draft')
        if purpose not in ('draft', 'tag_example'):
            raise ValueError('시안 종류를 확인해 주세요.')
        supplied_folder_id = data.get('folder_id')
        if purpose == 'tag_example' and supplied_folder_id not in (None, ''):
            raise ValueError('태그 예시 시안은 시안 폴더에 넣을 수 없습니다.')
        folder_id = None
        if purpose == 'draft' and supplied_folder_id not in (None, '', 'legacy'):
            if not isinstance(supplied_folder_id, str) or not FOLDER_ID.fullmatch(supplied_folder_id):
                raise ValueError('시안 폴더를 확인해 주세요.')
            folder_id = supplied_folder_id
        settings = normalize_draft_settings(data)
        with self.lock:
            root = self._root()
            self._recover(root)
            if folder_id is not None:
                catalog = self._load_catalog(root)
                if self._folder_index(catalog, folder_id) is None:
                    raise FileNotFoundError('시안 폴더를 찾을 수 없습니다.')
            record = {'id': uuid.uuid4().hex, 'created_at': _now(), 'settings': settings,
                      'purpose': purpose, 'selected': False}
            if folder_id is not None:
                record['folder_id'] = folder_id
            return self._start(root, record, data.get('allow_anlas', False),
                                persist_folder_settings=folder_id is not None)

    def retry(self, draft_id, allow_anlas=False):
        with self.lock:
            root = self._root()
            self._recover(root)
            record = self._load(root, draft_id)
            if record.get('framing') or record['status'] != 'failed':
                raise DakiStyleTestConflict('실패한 시안만 다시 생성할 수 있습니다.')
            return self._start(root, record, allow_anlas)

    def frame(self, draft_id, data):
        settings = normalize_framing(data)
        # Serialize local image work as well as publication; no key lookup,
        # generation worker, retry record, or intermediate gallery item exists.
        with self.lock:
            root = self._root()
            self._recover(root)
            original = self._load(root, draft_id)
            if original['status'] != 'completed':
                raise DakiStyleTestConflict('완성된 시안의 크기만 맞출 수 있습니다.')
            source_path = resolve_webp_image(self._file(root, draft_id, 'image.png')).resolve()
            if source_path.parent != self._directory(root, draft_id) or not source_path.is_file():
                raise FileNotFoundError('시안 이미지를 찾을 수 없습니다.')
            with Image.open(source_path) as opened:
                source = restore_webp_metadata(opened)
                image, framing = frame_image(source, settings)
                try:
                    framing['source_id'] = draft_id
                    metadata = framed_png_metadata(source, framing)
                    record = {'id': uuid.uuid4().hex, 'status': 'completed', 'created_at': _now(),
                              'settings': deepcopy(original['settings']), 'seed': original['seed'],
                              'purpose': 'tag_example' if original.get('purpose') == 'tag_example' else 'draft',
                              'selected': False, 'framing': framing}
                    if isinstance(original.get('folder_id'), str):
                        record['folder_id'] = original['folder_id']
                    # Publish the complete directory at once. Staging names
                    # cannot match a draft ID and are invisible after a crash.
                    with tempfile.TemporaryDirectory(dir=root, prefix='.frame-') as temporary:
                        staging = Path(temporary).resolve()
                        self._directory(staging, record['id']).mkdir()
                        self._write_image_files(staging, record['id'], image, metadata)
                        self._save(staging, record)
                        os.rename(self._directory(staging, record['id']), self._directory(root, record['id']))
                    return self._public(record)
                finally:
                    image.close()

    def _save_image(self, root, draft_id, payload, image):
        parameters = payload['parameters']
        if image.size != (parameters['width'], parameters['height']):
            raise ValueError('생성 결과의 크기가 요청한 크기와 다릅니다.')
        metadata = PngInfo()
        metadata.add_text('Comment', json.dumps({**parameters, 'prompt': payload['input'],
                                               'model': payload['model']}, ensure_ascii=False))
        metadata.add_text('Source', payload['model'])
        self._write_image_files(root, draft_id, image, metadata)

    def _write_image_files(self, root, draft_id, image, metadata):
        scale = min(1, 512 / image.width, 512 / image.height)
        thumbnail_size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
        with image.resize(thumbnail_size, Image.Resampling.LANCZOS) as small, \
                Image.new('RGB', small.size, 'white') as thumbnail:
            thumbnail.paste(small, mask=small.getchannel('A') if 'A' in small.getbands() else None)
            for filename, output, kwargs in (
                    ('image.png', image, {'format': 'PNG', 'pnginfo': metadata}),
                    ('preview.jpg', thumbnail, {'format': 'JPEG', 'quality': 88})):
                destination = self._file(root, draft_id, filename)
                temporary = None
                try:
                    with tempfile.NamedTemporaryFile(dir=destination.parent, prefix='.image-', suffix='.tmp', delete=False) as stream:
                        temporary = Path(stream.name)
                        output.save(stream, **kwargs)
                        stream.flush()
                        os.fsync(stream.fileno())
                    os.replace(temporary, destination)
                finally:
                    if temporary is not None:
                        temporary.unlink(missing_ok=True)

    def _worker(self, root, draft_id, payload, key):
        try:
            image = self.generator(key, deepcopy(payload))
            try:
                self._save_image(root, draft_id, payload, image)
            finally:
                image.close()
            with self.lock:
                record = self._load(root, draft_id)
                record['status'] = 'completed'
                self._save(root, record)
        except Exception as error:
            # A failure may follow a paid request. Preserve the record and require
            # a fresh explicit retry; do not echo HTTP bodies or local paths.
            if isinstance(error, ValueError):
                message = str(error).replace(key, '[키 숨김]')[:500]
            else:
                message = '결과를 생성하거나 저장하지 못했습니다. 자동으로 다시 생성하지 않습니다.'
            with self.lock:
                try:
                    record = self._load(root, draft_id)
                    record.update(status='failed', error=message)
                    self._save(root, record)
                except (OSError, ValueError):
                    # An unwriteable running record is recovered as failed on restart.
                    pass
        finally:
            with self.lock:
                self._active = None

    def image_path(self, draft_id, full=False):
        with self.lock:
            root = self._root()
            self._recover(root)
            record = self._load(root, draft_id)
            if record['status'] != 'completed':
                raise FileNotFoundError('완성된 시안 이미지를 찾을 수 없습니다.')
            source = self._file(root, draft_id, 'image.png' if full else 'preview.jpg')
            path = resolve_webp_image(source).resolve()
            if path.parent != self._directory(root, draft_id):
                raise ValueError('허용되지 않는 시안 경로입니다.')
            if not path.is_file():
                raise FileNotFoundError('시안 이미지를 찾을 수 없습니다.')
            return path

    def wait(self, timeout=10):
        thread = self._thread
        if thread is not None:
            thread.join(timeout)
        return thread is None or not thread.is_alive()
