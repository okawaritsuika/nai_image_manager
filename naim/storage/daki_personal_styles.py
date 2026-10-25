"""Personal style recipes with optional links to existing gallery images."""
from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import uuid

from PIL import Image

from naim.paths import path_identity_key
from naim.daki_style_tests import GENERATION_DEFAULTS, MODELS, build_style_test_payload
from naim.storage.daki_projects import DakiNotFoundError, matching_image_references, normalize_relative_path
from naim.storage.json_files import json_lock, write_json


_STYLE_ID = re.compile(r'^personal_[a-f0-9]{32}$')
_DEFAULT_MODEL = 'nai-diffusion-5-full'


def _now():
    return datetime.now(timezone.utc).isoformat()


def _text(value, label, *, required=False, limit=30000):
    if not isinstance(value, str) or len(value) > limit or '\x00' in value:
        raise ValueError(f'{label} 내용을 확인해 주세요.')
    value = value.strip()
    if required and not value:
        raise ValueError(f'{label} 내용을 입력해 주세요.')
    return value


def _model(value):
    value = _text(value, '모델', limit=120)
    key = value.casefold().replace(' ', '').replace('_', '-')
    aliases = {'novelaidiffusionv5': _DEFAULT_MODEL,
               'novelaidiffusionv5full': _DEFAULT_MODEL,
               'novelaidiffusionv5fullmedium': 'nai-diffusion-5-full-medium',
               'novelaidiffusionv4.5': 'nai-diffusion-4-5-full',
               'novelaidiffusionv4.5full': 'nai-diffusion-4-5-full'}
    model = aliases.get(key, value.removesuffix('-inpainting'))
    if model not in MODELS:
        raise ValueError('V5 Full, V5 Full Medium 또는 V4.5 Full 모델을 선택해 주세요.')
    return model


class DakiPersonalStyles:
    """Store recipes atomically; source image files are never copied or edited."""

    def __init__(self, root_provider, resolve_source, read_prompt, prompt_fallback=None):
        self.root_provider = root_provider
        self.resolve_source = resolve_source
        self.read_prompt = read_prompt
        self.prompt_fallback = prompt_fallback

    def _path(self):
        value = self.root_provider() if callable(self.root_provider) else self.root_provider
        root = Path(value).resolve()
        path = root / 'catalog.json'
        if path_identity_key(path.resolve().parent) != path_identity_key(root):
            raise ValueError('개인 그림체의 저장 위치가 올바르지 않습니다.')
        return path

    @staticmethod
    def _read(path):
        try:
            with path.open(encoding='utf-8') as source:
                data = json.load(source)
        except FileNotFoundError:
            return {'version': 1, 'styles': []}
        except (UnicodeError, json.JSONDecodeError) as error:
            raise ValueError('개인 그림체 목록을 읽을 수 없습니다.') from error
        if (not isinstance(data, dict) or data.get('version') != 1
                or not isinstance(data.get('styles'), list)):
            raise ValueError('개인 그림체 목록의 형식이 올바르지 않습니다.')
        ids = set()
        for style in data['styles']:
            if (not isinstance(style, dict) or not isinstance(style.get('id'), str)
                    or not _STYLE_ID.fullmatch(style['id']) or style['id'] in ids
                    or not isinstance(style.get('preview'), dict)
                    or not isinstance(style.get('options'), dict)
                    or any(not isinstance(style.get(key), str) for key in
                           ('name', 'model', 'positive', 'negative', 'source_path'))):
                raise ValueError('개인 그림체 항목의 형식이 올바르지 않습니다.')
            ids.add(style['id'])
        return data

    @staticmethod
    def _find(data, style_id):
        if isinstance(style_id, str):
            for style in data['styles']:
                if style['id'] == style_id:
                    return style
        raise DakiNotFoundError('개인 그림체를 찾을 수 없습니다.')

    @staticmethod
    def _reference(value):
        reference = normalize_relative_path(value)
        if reference.casefold().startswith('__daki_personal__/'):
            raise ValueError('개인 그림체의 대표 이미지는 원본 그림에서 가져와 주세요.')
        return reference

    def _source(self, reference):
        path, normalized = self.resolve_source(self._reference(reference))
        normalized = self._reference(normalized)
        path = Path(path)
        if not path.is_file():
            raise FileNotFoundError('연결한 원본 그림을 찾을 수 없습니다.')
        return path, normalized

    def _normalize(self, data, *, existing=None):
        if not isinstance(data, dict):
            raise ValueError('개인 그림체 설정은 JSON 객체여야 합니다.')
        values = {**(existing or {}), **data}
        options = values.get('options', {})
        preview = values.get('preview', {'width': 832, 'height': 1216})
        if not isinstance(options, dict) or not isinstance(preview, dict):
            raise ValueError('개인 그림체 생성 설정을 확인해 주세요.')
        style = {
            'name': _text(values.get('name'), '그림체 이름', required=True, limit=120),
            'positive': _text(values.get('positive'), 'Base 프롬프트', required=True),
            'negative': _text(values.get('negative', ''), 'Nega 프롬프트'),
            'model': _model(values.get('model', _DEFAULT_MODEL)),
            'options': {key: deepcopy(options.get(key, default)) for key, default in GENERATION_DEFAULTS.items()},
            'preview': {key: preview.get(key) for key in ('width', 'height')},
            'seed': None, 'category': 'personal', 'source_path': '',
            'source_image_id': None, 'source_url': '',
        }
        build_style_test_payload(style, {'model': style['model'], 'prompt': '',
                                        'negative_prompt': '', 'char_prompts': []})
        reference = values.get('source_path', '')
        if reference:
            reference = self._reference(reference)
            # Existing recipes remain editable even after their linked image moves.
            if not existing or reference != existing.get('source_path'):
                _, reference = self._source(reference)
            style['source_path'] = reference
        elif reference not in ('', None):
            raise ValueError('대표 이미지 경로를 확인해 주세요.')
        return style

    def list_styles(self):
        path = self._path()
        with json_lock(path):
            return deepcopy(self._read(path)['styles'])

    def get_style(self, style_id):
        path = self._path()
        with json_lock(path):
            return deepcopy(self._find(self._read(path), style_id))

    def create(self, data):
        style = self._normalize(data)
        style.update(id='personal_' + uuid.uuid4().hex, created_at=_now())
        style['updated_at'] = style['created_at']
        path = self._path()
        with json_lock(path):
            catalog = self._read(path)
            catalog['styles'].append(style)
            path.parent.mkdir(parents=True, exist_ok=True)
            write_json(path, catalog, indent=2)
        return deepcopy(style)

    def update(self, style_id, data):
        path = self._path()
        with json_lock(path):
            catalog = self._read(path)
            previous = self._find(catalog, style_id)
            style = self._normalize(data, existing=previous)
            style.update(id=previous['id'], created_at=previous['created_at'], updated_at=_now())
            previous.clear()
            previous.update(style)
            write_json(path, catalog, indent=2)
            return deepcopy(style)

    def preview_path(self, style_id, full=False):
        style = self.get_style(style_id)
        if not style['source_path']:
            raise FileNotFoundError('이 개인 그림체에는 대표 이미지가 없습니다.')
        path, _ = self._source(style['source_path'])
        return path

    def references(self, paths=None, folders=None):
        def references():
            for style in self.list_styles():
                if style['source_path']:
                    yield {'project_id': style['id'], 'style_id': style['id'],
                           'project_name': '개인 그림체 · ' + style['name'], 'side': '대표 그림',
                           'path': style['source_path'], 'source_path': style['source_path']}
        return matching_image_references(references(), paths, folders, normalize_relative_path,
                                         self.resolve_source)

    def draft_from_image(self, reference):
        path, reference = self._source(reference)
        info = self.read_prompt(str(path))
        if not isinstance(info, dict):
            raise ValueError('그림에서 프롬프트 정보를 읽을 수 없습니다.')
        if self.prompt_fallback:
            from naim.images.prompt_metadata import merge_prompt_info_with_fallback
            fallback = self.prompt_fallback(reference) or {}
            if not isinstance(fallback, dict):
                raise ValueError('그림체의 프롬프트 정보를 읽을 수 없습니다.')
            # The shared metadata normalizer preserves prompt aliases; keep
            # generation flags outside its schema available to the recipe too.
            info = {**fallback, **{key: value for key, value in info.items()
                                  if value not in (None, '', [], {})},
                    **merge_prompt_info_with_fallback(info, fallback)}
        options = deepcopy(GENERATION_DEFAULTS)
        for key in options:
            value = info.get(key, info.get('scale') if key == 'cfg' else None)
            if value not in (None, ''):
                if isinstance(value, str) and type(options[key]) in (int, float):
                    try:
                        value = float(value)
                        if key == 'steps' and value.is_integer():
                            value = int(value)
                    except ValueError:
                        pass
                options[key] = value
        with Image.open(path) as image:
            width, height = image.size
        # Return a draft even when its prompt/model needs editing before saving.
        source_model = info.get('model') or info.get('modelName') or info.get('model_name') or _DEFAULT_MODEL
        try:
            model = _model(source_model)
        except ValueError:
            model = source_model
        return {
            'name': path.stem[:120], 'category': 'personal', 'source_path': reference,
            'positive': str(info.get('basePrompt') or info.get('baseCaption') or info.get('prompt') or '').strip(),
            'negative': str(info.get('negativePrompt') or info.get('negative_prompt') or info.get('uc') or '').strip(),
            'model': model, 'options': options, 'preview': {'width': width, 'height': height},
            'seed': None, 'source_image_id': None, 'source_url': '',
        }
