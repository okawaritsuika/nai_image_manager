"""Daki project references, stored independently of the gallery's image files."""
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
import os
from pathlib import Path, PurePosixPath
import re
import threading
import unicodedata
from urllib.parse import quote
import uuid

from PIL import Image

from naim.project_canvas_settings import (
    default_canvas_settings, normalize_canvas_settings,
    normalize_canvas_settings_record,
)
from naim.detail_prompt_presets import (
    default_common_collection, empty_project_collection, mutate_collection,
    validate_stored_collection,
)
from naim.storage.json_files import json_lock, read_json, write_json


SIDES = ('front', 'back')
_CANVAS_ID_RE = re.compile(r'^[0-9a-f]{32}$')
_WINDOWS_INVALID_FILENAME_CHARS = frozenset('<>:"/\\|?*')
_SIDE_DISPLAY_NAMES = {'front': '앞면', 'back': '뒷면'}
_CANVAS_PREVIEW_LAYER_FIELDS = (
    'type', 'visible', 'src', 'x', 'y', 'layerWidth', 'layerHeight',
    'imageWidth', 'imageHeight', 'pinnedReference', 'renderOnCanvas',
)


class DakiNotFoundError(LookupError):
    pass


class DakiCanvasConflict(ValueError):
    """A canvas update was based on a revision that is no longer current."""


class DakiProjectSettingsConflict(ValueError):
    """A project settings update was based on a revision that is no longer current."""


def canvas_metadata(canvas):
    """Return canvas metadata without exposing its editable state payload."""
    state = canvas['state']
    return {
        'id': canvas['id'],
        'name': canvas['name'],
        'side': canvas['side'],
        'revision': canvas['revision'],
        'created_at': canvas['created_at'],
        'updated_at': canvas['updated_at'],
        'width': state['width'],
        'height': state['height'],
        'layerCount': _canvas_layer_count(state),
    }


def _project_summary(project):
    summary = {
        key: deepcopy(value)
        for key, value in project.items()
        if key not in ('canvasSettings', 'detailPromptPresets', 'canvases')
    }
    if 'canvases' in project:
        summary['canvases'] = {
            side: [canvas_metadata(canvas) for canvas in project['canvases'].get(side, [])]
            for side in SIDES
        }
    return summary


def _canvas_layer_count(state):
    def count_layers(layers):
        total = 0
        for layer in layers:
            total += 1
            if isinstance(layer, dict) and isinstance(layer.get('children'), list):
                total += count_layers(layer['children'])
        return total

    return count_layers(state['layers'])


def _javascript_truthy(value):
    """Match JavaScript truthiness for values read from ordinary JSON."""
    if value is None:
        return False
    if isinstance(value, (bool, int, float, str)):
        return bool(value)
    # JavaScript arrays and objects are truthy, including empty ones.
    return True


def _canvas_preview_layers(layers):
    """Copy drawable layers in order, omitting editor-only payload fields."""
    result = []
    pending = [(layers, result)]
    while pending:
        source_layers, target_layers = pending.pop()
        if not isinstance(source_layers, list):
            continue
        for layer in source_layers:
            if not isinstance(layer, dict) or not _javascript_truthy(layer.get('visible')):
                continue
            layer_type = layer.get('type')
            if layer_type == 'image':
                if _javascript_truthy(layer.get('pinnedReference')):
                    continue
            elif layer_type == 'clip':
                if not _javascript_truthy(layer.get('renderOnCanvas')):
                    continue
            elif layer_type not in ('canvas', 'folder', 'selection'):
                continue

            projected = {
                key: value for key, value in layer.items()
                if key in _CANVAS_PREVIEW_LAYER_FIELDS
                and isinstance(value, (str, int, float, bool, type(None)))
            }
            projected['visible'] = True
            if layer_type == 'image':
                projected['pinnedReference'] = False
            if layer_type == 'clip':
                projected['renderOnCanvas'] = True
            target_layers.append(projected)
            if layer_type in ('folder', 'selection'):
                children = []
                projected['children'] = children
                pending.append((layer.get('children'), children))
    return result


def _canvas_preview(canvas):
    state = canvas['state']
    return {
        **{key: canvas[key] for key in (
            'id', 'name', 'side', 'revision', 'created_at', 'updated_at',
        )},
        'state': {
            'width': state['width'],
            'height': state['height'],
            'layers': _canvas_preview_layers(state.get('layers')),
        },
    }


def _validate_canvas_state(state):
    if not isinstance(state, dict):
        raise ValueError('캔버스 상태는 JSON 객체여야 합니다.')
    for dimension in ('width', 'height'):
        value = state.get(dimension)
        if (isinstance(value, bool) or not isinstance(value, int)
                or value < 1 or value > 16000):
            raise ValueError('캔버스 너비와 높이는 1~16000 사이의 정수여야 합니다.')
    if not isinstance(state.get('layers'), list):
        raise ValueError('캔버스 레이어 목록이 올바르지 않습니다.')
    return deepcopy(state)


def _prepare_canvas(canvas):
    if not isinstance(canvas, dict):
        raise ValueError('캔버스는 JSON 객체여야 합니다.')
    name = canvas.get('name')
    if not isinstance(name, str) or not name.strip():
        raise ValueError('캔버스명을 입력해 주세요.')
    name = name.strip()
    if len(name) > 120:
        raise ValueError('캔버스명은 120자 이하로 입력해 주세요.')
    side = _validate_side(canvas.get('side'))
    canvas_id = canvas.get('id')
    if canvas_id is None:
        canvas_id = uuid.uuid4().hex
    elif not isinstance(canvas_id, str) or not _CANVAS_ID_RE.fullmatch(canvas_id):
        raise ValueError('캔버스 ID가 올바르지 않습니다.')
    return {
        'id': canvas_id,
        'name': name,
        'side': side,
        'revision': 1,
        'created_at': None,
        'updated_at': None,
        'state': _validate_canvas_state(canvas.get('state')),
    }


def _same_canvas_request(existing, prepared):
    return (existing.get('id') == prepared['id']
            and existing.get('name') == prepared['name']
            and existing.get('side') == prepared['side']
            and existing.get('state') == prepared['state'])


def _iter_canvas_records(project):
    canvases = project.get('canvases')
    if not isinstance(canvases, dict):
        return
    for side in SIDES:
        records = canvases.get(side, [])
        if isinstance(records, list):
            for canvas in records:
                if isinstance(canvas, dict):
                    yield canvas


def normalize_relative_path(value, *, allow_empty=False):
    if not isinstance(value, str) or '\x00' in value:
        raise ValueError('이미지 경로가 올바르지 않습니다.')
    text = value.strip().replace('\\', '/')
    if not text and allow_empty:
        return ''
    path = PurePosixPath(text)
    if (not text or path.is_absolute() or '..' in path.parts
            or any(':' in part for part in path.parts) or str(path) == '.'):
        raise ValueError('갤러리 안의 상대 경로를 사용해 주세요.')
    return path.as_posix()


def _path_key(path):
    return os.path.normcase(path).replace('\\', '/')


def _image_path_variants(relative, cache, resolve_source=None):
    if relative not in cache:
        values = {_path_key(relative)}
        if resolve_source is not None:
            try:
                _, actual = resolve_source(relative)
                values.add(_path_key(normalize_relative_path(actual)))
            except (OSError, ValueError):
                pass  # Missing images still retain their saved references.
        cache[relative] = values
    return cache[relative]


def matching_image_references(references, paths, folders, clean_path, resolve_source=None):
    """Match linked images and converted aliases with exact folder boundaries."""
    paths = [] if paths is None else paths
    folders = [] if folders is None else folders
    if not isinstance(paths, (list, tuple)) or not isinstance(folders, (list, tuple)):
        raise ValueError('이미지와 폴더 경로 목록이 올바르지 않습니다.')
    cache = {}
    path_keys = set()
    for path in paths:
        path_keys.update(_image_path_variants(clean_path(path), cache, resolve_source))
    folder_keys = {_path_key(clean_path(folder, allow_empty=True)).rstrip('/') for folder in folders}
    if not path_keys and not folder_keys:
        return []
    matches = []
    for reference in references:
        image_variants = _image_path_variants(reference['path'], cache, resolve_source)
        folder_match = any(not folder or variant == folder or variant.startswith(folder + '/')
                           for folder in folder_keys for variant in image_variants)
        if image_variants & path_keys or folder_match:
            matches.append(reference)
    return matches


def _now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds')


def _validate_side(side):
    if side not in SIDES:
        raise ValueError('앞면 또는 뒷면을 선택해 주세요.')
    return side


def project_canvas_result_name(project_name, side, canvas_name, result_index):
    """Build a safe display name for a canvas export without changing its file path."""
    side = _validate_side(side)
    if not isinstance(project_name, str) or not isinstance(canvas_name, str):
        raise ValueError('프로젝트명과 캔버스명은 문자열이어야 합니다.')
    if isinstance(result_index, bool) or not isinstance(result_index, int) or result_index < 1:
        raise ValueError('결과 번호는 양의 정수여야 합니다.')

    prefix = f"{project_name.strip()[:100]}_{_SIDE_DISPLAY_NAMES[side]}_"
    base_name = canvas_name if canvas_name.startswith(prefix) else prefix + canvas_name
    safe_base = ''.join(
        '_' if char in _WINDOWS_INVALID_FILENAME_CHARS or unicodedata.category(char) == 'Cc' else char
        for char in base_name
    ).rstrip(' .')
    if not safe_base:
        safe_base = '캔버스'

    suffix = f'_결과{result_index}.png'
    available_base_length = 200 - len(suffix)
    if available_base_length < 1:
        raise ValueError('결과 번호가 너무 커 파일명을 만들 수 없습니다.')
    safe_base = safe_base[:available_base_length].rstrip(' .')
    if not safe_base:
        safe_base = '캔버스'[:available_base_length]
    return safe_base + suffix


class DakiProjectsStore:
    def __init__(self, path_provider, resolve_source=None, clean_path=None):
        self.path_provider = path_provider
        self.resolve_source = resolve_source
        self.clean_path = clean_path
        self._snapshot_lock = threading.RLock()
        self._snapshot_path = None
        self._snapshot_signature = None
        self._snapshot_data = None

    @property
    def path(self):
        value = self.path_provider() if callable(self.path_provider) else self.path_provider
        return Path(value)

    def _load(self, path):
        data = read_json(path, lambda: {'enabled': True, 'projects': []}, expected_type=dict, indent=2)
        data.setdefault('enabled', True)
        data.setdefault('projects', [])
        if not isinstance(data['enabled'], bool) or not isinstance(data['projects'], list):
            raise ValueError('저장된 다키 프로젝트 형식이 올바르지 않습니다.')
        return data

    @staticmethod
    def _file_signature(path):
        resolved = Path(path).resolve()
        stat = resolved.stat()
        return (
            os.path.normcase(os.path.abspath(os.fspath(resolved))),
            stat.st_mtime_ns,
            stat.st_ctime_ns,
            stat.st_size,
            getattr(stat, 'st_dev', None),
            getattr(stat, 'st_ino', None),
        )

    def _clear_snapshot(self):
        self._snapshot_path = None
        self._snapshot_signature = None
        self._snapshot_data = None

    def _read_snapshot(self, path):
        """Read or reuse the store's single validated, read-only JSON snapshot."""
        store_path = Path(path)
        with json_lock(store_path), self._snapshot_lock:
            try:
                before = self._file_signature(store_path)
            except OSError:
                self._clear_snapshot()
                return self._load(store_path)

            file_path = before[0]
            if file_path != self._snapshot_path:
                self._clear_snapshot()
                self._snapshot_path = file_path
            elif before == self._snapshot_signature:
                return self._snapshot_data

            try:
                data = self._load(store_path)
            except BaseException:
                self._clear_snapshot()
                raise

            try:
                after = self._file_signature(store_path)
            except OSError:
                self._clear_snapshot()
                return data

            if before == after:
                self._snapshot_path = file_path
                self._snapshot_signature = after
                self._snapshot_data = data
            else:
                self._clear_snapshot()
            return data

    @staticmethod
    def _find_project(data, project_id):
        for project in data['projects']:
            if project.get('id') == project_id:
                return project
        raise DakiNotFoundError('다키 프로젝트를 찾을 수 없습니다.')

    def _clean(self, value, *, allow_empty=False):
        if not isinstance(value, str):
            raise ValueError('이미지 경로가 올바르지 않습니다.')
        # Paths from gallery records are already decoded. Cleaning them again
        # would turn literal `%2F`, `#`, and `?` filename text into URL syntax.
        if self.clean_path and value.startswith(('/image/', 'http://', 'https://')):
            value = self.clean_path(value)
        return normalize_relative_path(value, allow_empty=allow_empty)

    def resolve_image(self, relative):
        if self.resolve_source is None:
            raise ValueError('갤러리 이미지 경로를 확인할 수 없습니다.')
        # A supplied URL cleaner denotes the legacy gallery resolver, which
        # decodes its input once. Encode at this boundary to preserve names.
        source = '/image/' + quote(relative, safe='/') if self.clean_path else relative
        return self.resolve_source(source)

    def _prepare_image(self, value):
        relative = self._clean(value)
        full_path, resolved_relative = self.resolve_image(relative)
        resolved_relative = normalize_relative_path(resolved_relative)
        if not os.path.isfile(full_path):
            raise FileNotFoundError('후보로 추가할 이미지가 없습니다.')
        # The gallery resolver accepts all files. Only its image formats are
        # candidates; verify the source without writing it or its sidecars.
        if Path(full_path).suffix.lower() not in ('.png', '.jpg', '.jpeg', '.webp'):
            raise ValueError('PNG, JPEG, WebP 이미지만 후보로 추가할 수 있습니다.')
        try:
            with Image.open(full_path) as image:
                if image.format not in ('PNG', 'JPEG', 'WEBP'):
                    raise ValueError('지원하지 않는 이미지 형식입니다.')
                image.verify()
        except (OSError, SyntaxError) as error:
            raise ValueError('이미지 파일을 읽을 수 없습니다.') from error
        return resolved_relative

    def settings(self):
        return {'enabled': self._read_snapshot(self.path)['enabled']}

    def _path_variants(self, relative, cache):
        return _image_path_variants(relative, cache, self.resolve_image if self.resolve_source is not None else None)

    def set_enabled(self, enabled):
        if not isinstance(enabled, bool):
            raise ValueError('다키 사용 설정은 참 또는 거짓이어야 합니다.')
        path = self.path
        with json_lock(path):
            data = self._load(path)
            data['enabled'] = enabled
            write_json(path, data, indent=2)
        return {'enabled': enabled}

    def list_projects(self, *, summary=False):
        projects = self._read_snapshot(self.path)['projects']
        if summary:
            return [_project_summary(project) for project in projects]
        return deepcopy(projects)

    def get_project(self, project_id, *, summary=False):
        project = self._find_project(self._read_snapshot(self.path), project_id)
        return _project_summary(project) if summary else deepcopy(project)

    @contextmanager
    def staged_project_removal(self, project_id):
        """Remove one project while a caller stages its linked resources."""
        store_path = self.path
        with json_lock(store_path):
            data = self._load(store_path)
            project = self._find_project(data, project_id)
            original_bytes = store_path.read_bytes()
            removed_project = deepcopy(project)
            updated_data = dict(data)
            updated_data['projects'] = [
                item for item in data['projects'] if item is not project
            ]
            write_json(store_path, updated_data, indent=2)
            try:
                yield removed_project
            except BaseException:
                try:
                    write_json(store_path, data, indent=2)
                except BaseException as rollback_error:
                    try:
                        backup_path = store_path.with_name(
                            f'.{store_path.name}.project-removal-{uuid.uuid4().hex}.bak'
                        )
                        with backup_path.open('xb') as backup:
                            backup.write(original_bytes)
                            backup.flush()
                            os.fsync(backup.fileno())
                    except OSError:
                        pass
                    raise OSError(
                        '프로젝트 삭제 중 오류가 발생해 프로젝트 정보를 복구하지 못했습니다.'
                    ) from rollback_error
                raise

    def get_canvas_settings(self, project_id):
        project = self._find_project(self._read_snapshot(self.path), project_id)
        if 'canvasSettings' not in project:
            return default_canvas_settings()
        return normalize_canvas_settings_record(project['canvasSettings'])

    def update_canvas_settings(self, project_id, settings, revision):
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
            raise ValueError('프로젝트 설정 revision은 0 이상의 정수여야 합니다.')
        prepared_settings = normalize_canvas_settings(settings)
        store_path = self.path
        with json_lock(store_path):
            data = self._load(store_path)
            project = self._find_project(data, project_id)
            current = (default_canvas_settings() if 'canvasSettings' not in project
                       else normalize_canvas_settings_record(project['canvasSettings']))
            current_settings = {
                key: current[key] for key in ('style', 'prompts', 'inpaintSettings')
            }
            if 'inpaintReference' in current:
                current_settings['inpaintReference'] = current['inpaintReference']
            if ('inpaintReference' not in prepared_settings
                    and 'inpaintReference' in current_settings):
                prepared_settings['inpaintReference'] = current_settings['inpaintReference']

            if current['revision'] == revision + 1 and current_settings == prepared_settings:
                return current
            if current['revision'] != revision:
                raise DakiProjectSettingsConflict(
                    '다른 탭에서 프로젝트 설정이 변경되었습니다. 최신 설정을 다시 확인해 주세요.'
                )
            if current_settings == prepared_settings:
                return current

            updated = {'revision': revision + 1, **prepared_settings}
            project['canvasSettings'] = updated
            project['updated_at'] = _now()
            write_json(store_path, data, indent=2)
            return deepcopy(updated)

    def get_detail_prompt_presets(self, project_id=None):
        if project_id is not None and (not isinstance(project_id, str) or not project_id):
            raise ValueError('프로젝트 ID가 올바르지 않습니다.')
        data = self._load(self.path)
        project = self._find_project(data, project_id) if project_id is not None else None
        common = (validate_stored_collection(data['detailPromptPresets'])
                  if 'detailPromptPresets' in data else default_common_collection())
        project_collection = None
        if project is not None:
            project_collection = (
                validate_stored_collection(project['detailPromptPresets'])
                if 'detailPromptPresets' in project else empty_project_collection()
            )
        return {
            'common': common,
            'project': project_collection,
            'projectId': project_id,
        }

    def mutate_detail_prompt_presets(
            self, scope, project_id, revision, method, preset=None, preset_id=None):
        if scope not in ('common', 'project'):
            raise ValueError('프리셋 범위는 common 또는 project여야 합니다.')
        if project_id is not None and (not isinstance(project_id, str) or not project_id):
            raise ValueError('프로젝트 ID가 올바르지 않습니다.')
        if scope == 'project' and project_id is None:
            raise ValueError('프로젝트 프리셋에는 프로젝트 ID가 필요합니다.')

        store_path = self.path
        with json_lock(store_path):
            data = self._load(store_path)
            project = self._find_project(data, project_id) if project_id is not None else None
            common = (validate_stored_collection(data['detailPromptPresets'])
                      if 'detailPromptPresets' in data else default_common_collection())
            project_collection = None
            if project is not None:
                project_collection = (
                    validate_stored_collection(project['detailPromptPresets'])
                    if 'detailPromptPresets' in project else empty_project_collection()
                )

            if scope == 'common':
                updated, changed = mutate_collection(
                    common, revision=revision, method=method,
                    preset=preset, preset_id=preset_id,
                )
                if changed or 'detailPromptPresets' not in data:
                    data['detailPromptPresets'] = updated
                    write_json(store_path, data, indent=2)
                common = updated
            else:
                updated, changed = mutate_collection(
                    project_collection, revision=revision, method=method,
                    preset=preset, preset_id=preset_id,
                )
                if changed or 'detailPromptPresets' not in project:
                    project['detailPromptPresets'] = updated
                    write_json(store_path, data, indent=2)
                project_collection = updated

            return {
                'common': common,
                'project': project_collection,
                'projectId': project_id,
            }

    def create_project(self, name, path=None, side=None, *, canvas=None):
        if not isinstance(name, str) or not name.strip():
            raise ValueError('프로젝트명을 입력해 주세요.')
        project_name = name.strip()
        if len(project_name) > 120:
            raise ValueError('프로젝트명은 120자 이하로 입력해 주세요.')
        if path is None and side is not None:
            _validate_side(side)
        # Validate the optional first image before publishing the new project.
        # An invalid image must not leave an empty project behind.
        candidate_path = None
        if path is not None:
            _validate_side(side)
            candidate_path = self._prepare_image(path)
        prepared_canvas = _prepare_canvas(canvas) if canvas is not None else None
        now = _now()
        project = {
            'id': uuid.uuid4().hex, 'name': project_name,
            'created_at': now, 'updated_at': now,
            'candidates': {'front': [], 'back': []},
        }
        if candidate_path is not None:
            project['candidates'][side].append({
                'id': uuid.uuid4().hex, 'path': candidate_path, 'added_at': now,
            })
        if prepared_canvas is not None:
            prepared_canvas['created_at'] = now
            prepared_canvas['updated_at'] = now
            project['canvases'] = {'front': [], 'back': []}
            project['canvases'][prepared_canvas['side']].append(prepared_canvas)
        store_path = self.path
        with json_lock(store_path):
            data = self._load(store_path)
            if prepared_canvas is not None:
                for existing_project in data['projects']:
                    for existing_canvas in _iter_canvas_records(existing_project):
                        if existing_canvas.get('id') != prepared_canvas['id']:
                            continue
                        if (existing_project.get('name') == project_name
                                and _same_canvas_request(existing_canvas, prepared_canvas)):
                            return deepcopy(existing_project)
                        raise DakiCanvasConflict('다른 탭에서 캔버스가 변경되었습니다. 다시 열어 최신 내용을 확인해 주세요.')
            data['projects'].append(project)
            write_json(store_path, data, indent=2)
        return deepcopy(project)

    def create_canvas(self, project_id, canvas):
        prepared = _prepare_canvas(canvas)
        now = _now()
        prepared['created_at'] = now
        prepared['updated_at'] = now
        store_path = self.path
        with json_lock(store_path):
            data = self._load(store_path)
            project = self._find_project(data, project_id)
            for existing_project in data['projects']:
                for existing_canvas in _iter_canvas_records(existing_project):
                    if existing_canvas.get('id') != prepared['id']:
                        continue
                    if (existing_project.get('id') == project_id
                            and _same_canvas_request(existing_canvas, prepared)):
                        return deepcopy(existing_canvas)
                    raise DakiCanvasConflict('다른 탭에서 캔버스가 변경되었습니다. 다시 열어 최신 내용을 확인해 주세요.')
            canvases = project.get('canvases')
            if canvases is None:
                canvases = {'front': [], 'back': []}
                project['canvases'] = canvases
            if not isinstance(canvases, dict):
                raise ValueError('저장된 캔버스 목록 형식이 올바르지 않습니다.')
            for canvas_side in SIDES:
                records = canvases.setdefault(canvas_side, [])
                if not isinstance(records, list):
                    raise ValueError('저장된 캔버스 목록 형식이 올바르지 않습니다.')
            canvases[prepared['side']].append(prepared)
            project['updated_at'] = now
            write_json(store_path, data, indent=2)
        return deepcopy(prepared)

    def get_canvas(self, project_id, canvas_id):
        return self.get_canvas_with_project(project_id, canvas_id)[1]

    def get_canvas_with_project(self, project_id, canvas_id, *, preview=False):
        project = self._find_project(self._read_snapshot(self.path), project_id)
        for canvas in _iter_canvas_records(project):
            if canvas.get('id') == canvas_id:
                record = _canvas_preview(canvas) if preview else deepcopy(canvas)
                return {'id': project['id'], 'name': project['name']}, record
        raise DakiNotFoundError('다키 캔버스를 찾을 수 없습니다.')

    def update_canvas(self, project_id, canvas_id, state, revision):
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
            raise ValueError('캔버스 revision은 양의 정수여야 합니다.')
        prepared_state = _validate_canvas_state(state)
        store_path = self.path
        with json_lock(store_path):
            data = self._load(store_path)
            project = self._find_project(data, project_id)
            for canvas in _iter_canvas_records(project):
                if canvas.get('id') != canvas_id:
                    continue
                current_revision = canvas.get('revision')
                if current_revision == revision + 1:
                    # Restoring after a lost save response takes a new snapshot timestamp.
                    # Accept only identical content; never replace a newer edit on retry.
                    current_state = canvas.get('state')
                    if isinstance(current_state, dict) and (
                        {key: value for key, value in current_state.items() if key != 'savedAt'}
                        == {key: value for key, value in prepared_state.items() if key != 'savedAt'}
                    ):
                        return deepcopy(canvas)
                if current_revision != revision:
                    raise DakiCanvasConflict('다른 탭에서 캔버스가 변경되었습니다. 다시 열어 최신 내용을 확인해 주세요.')
                now = _now()
                canvas['state'] = prepared_state
                canvas['revision'] = revision + 1
                canvas['updated_at'] = now
                project['updated_at'] = now
                write_json(store_path, data, indent=2)
                return deepcopy(canvas)
        raise DakiNotFoundError('다키 캔버스를 찾을 수 없습니다.')

    def canvas_states(self):
        """Yield copies of saved canvas state objects for reference checks."""
        for project in self._load(self.path)['projects']:
            for canvas in _iter_canvas_records(project):
                state = canvas.get('state')
                if isinstance(state, dict):
                    yield deepcopy(state)

    def remove_canvas(self, project_id, canvas_id):
        store_path = self.path
        with json_lock(store_path):
            data = self._load(store_path)
            project = self._find_project(data, project_id)
            for side in SIDES:
                canvases = (project.get('canvases') or {}).get(side, [])
                for index, canvas in enumerate(canvases):
                    if canvas.get('id') == canvas_id:
                        del canvases[index]
                        project['updated_at'] = _now()
                        write_json(store_path, data, indent=2)
                        return deepcopy(project)
        raise DakiNotFoundError('다키 캔버스를 찾을 수 없습니다.')

    def add_candidate(self, project_id, path, side, *, canvas_id=None):
        _validate_side(side)
        if canvas_id is not None and (not isinstance(canvas_id, str)
                or not _CANVAS_ID_RE.fullmatch(canvas_id)):
            raise ValueError('다키 캔버스 ID가 올바르지 않습니다.')
        candidate_path = self._prepare_image(path)
        store_path = self.path
        with json_lock(store_path):
            data = self._load(store_path)
            project = self._find_project(data, project_id)
            candidates = project['candidates'][side]
            canvas = None
            if canvas_id is not None:
                canvas = next((item for item in _iter_canvas_records(project)
                               if item.get('id') == canvas_id and item.get('side') == side), None)
                if canvas is None:
                    raise DakiNotFoundError('해당 앞면/뒷면 캔버스를 찾을 수 없습니다.')
            cache = {}
            target = self._path_variants(candidate_path, cache)
            for candidate in candidates:
                if target & self._path_variants(candidate['path'], cache):
                    return deepcopy(project)
            now = _now()
            candidate = {'id': uuid.uuid4().hex, 'path': candidate_path, 'added_at': now}
            if canvas is not None:
                previous_count = canvas.get('exportCount')
                if isinstance(previous_count, bool) or not isinstance(previous_count, int) or previous_count < 0:
                    previous_count = 0
                previous_index = max((item.get('resultIndex', 0) for item in candidates
                                      if item.get('sourceCanvasId') == canvas_id
                                      and isinstance(item.get('resultIndex'), int)
                                      and not isinstance(item.get('resultIndex'), bool)
                                      and item['resultIndex'] > 0), default=0)
                result_index = max(previous_count, previous_index) + 1
                candidate.update({
                    'name': project_canvas_result_name(
                        project.get('name', ''), side, canvas.get('name', '캔버스'), result_index,
                    ),
                    'sourceCanvasId': canvas_id,
                    'resultIndex': result_index,
                })
                canvas['exportCount'] = result_index
            candidates.append(candidate)
            project['updated_at'] = now
            write_json(store_path, data, indent=2)
        return deepcopy(project)

    def remove_candidate(self, project_id, candidate_id):
        store_path = self.path
        with json_lock(store_path):
            data = self._load(store_path)
            project = self._find_project(data, project_id)
            for side in SIDES:
                candidates = project['candidates'][side]
                for index, candidate in enumerate(candidates):
                    if candidate['id'] == candidate_id:
                        del candidates[index]
                        project['updated_at'] = _now()
                        write_json(store_path, data, indent=2)
                        return deepcopy(project)
        raise DakiNotFoundError('다키 후보를 찾을 수 없습니다.')

    def references(self, paths=None, folders=None):
        """Find deletion warnings, including old PNG aliases and disabled Daki.

        This method does not modify projects. Folder matches include only the
        exact folder and its descendants, so `group` does not match `group2`.
        """
        def references():
            for project in self._load(self.path)['projects']:
                for side in SIDES:
                    for candidate in project['candidates'][side]:
                        yield {'project_id': project['id'], 'project_name': project['name'],
                               'side': side, 'path': candidate['path']}
                for canvas in _iter_canvas_records(project):
                    state = canvas.get('state')
                    if not isinstance(state, dict):
                        continue
                    canvas_paths = set()

                    def collect_image_paths(value):
                        if isinstance(value, str):
                            if value.startswith('/image/'):
                                try:
                                    canvas_paths.add(self._clean(value))
                                except ValueError:
                                    pass
                        elif isinstance(value, dict):
                            for nested in value.values():
                                collect_image_paths(nested)
                        elif isinstance(value, list):
                            for nested in value:
                                collect_image_paths(nested)

                    collect_image_paths(state)
                    for relative in canvas_paths:
                        yield {
                            'project_id': project['id'],
                            'project_name': f"{project['name']} · {canvas.get('name', '캔버스')}",
                            'side': canvas.get('side'),
                            'path': relative,
                        }
        return matching_image_references(references(), paths, folders, self._clean,
                                         self.resolve_image if self.resolve_source is not None else None)
