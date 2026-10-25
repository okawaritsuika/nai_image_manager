"""Persistent comparisons with sequential generation and local WebP conversion."""
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import secrets
import tempfile
import threading
from urllib.parse import quote
import uuid

from PIL import Image
from PIL.PngImagePlugin import PngInfo

from naim.generation_settings import SAMPLERS, NOISE_SCHEDULES, V5_FULL_MEDIUM, V5_MEDIUM_FIXED_SETTINGS, apply_model_constraints
from naim.novelai import generate_text_image
from naim.storage.json_files import write_json
from naim.storage.daki_style_sources import source_metadata
from naim.shared_style_recipe import load_style_artist_names, style_duplicate_key
from naim.storage.daki_style_dates import style_sort_date
from naim.images.webp_conversion import convert_png_to_webp, resolve_webp_image


MODELS = {'nai-diffusion-5-full', V5_FULL_MEDIUM, 'nai-diffusion-4-5-full'}
STYLE_ID = re.compile(r'^[A-Za-z0-9_-]{1,128}$')
BATCH_ID = re.compile(r'^[a-f0-9]{32}$')
GENERATION_DEFAULTS = {
    'steps': 28, 'cfg': 5, 'sampler': 'k_euler_ancestral', 'cfg_rescale': 0,
    'noise_schedule': 'karras', 'strength': .5, 'noise': .02,
    'deliberate_euler_ancestral_bug': False, 'prefer_brownian': True,
    'dynamic_thresholding': False, 'legacy_v3_extend': False,
}
# NAIA's core/resolution_utils.py presets plus dakiMaker's tall draft sizes;
# keep this catalog local so generation does not require either installation.
SIZE_PRESETS = [
    {'id': 'small', 'label': 'Small', 'sizes': [[640, 640], [576, 640], [576, 704], [512, 768],
                                               [640, 576], [704, 576], [768, 512]]},
    {'id': 'normal', 'label': 'Normal', 'sizes': [[1024, 1024], [960, 1088], [896, 1152], [832, 1216],
                                                 [1088, 960], [1152, 896], [1216, 832]]},
    {'id': 'large', 'label': 'Large', 'sizes': [[1280, 1280], [1152, 1344], [1088, 1408], [1024, 1536],
                                               [1344, 1152], [1408, 1088], [1536, 1024]]},
    {'id': 'wallpaper', 'label': 'Wallpaper', 'sizes': [[1472, 1472], [1344, 1536], [1280, 1664], [1216, 1728],
                                                       [1088, 1920], [1536, 1344], [1664, 1280], [1728, 1216], [1920, 1088]]},
    {'id': 'daki', 'label': 'Daki', 'sizes': [[320, 1024], [512, 1664], [640, 2048],
                                           [960, 3072], [1024, 3072]]},
]
# Official NovelAI UI, checked 2026-10-12: shared pixel budget/64-pixel quantum
# https://novelai.net/_next/static/chunks/1601-acc34459bdce34e2.js (module 85097)
# https://novelai.net/_next/static/chunks/2952-8caf894fb1bb5206.js (generation guard)
# The axis bound is derived from max_pixels / minimum other dimension, not a
# separately verified API axis limit. Auto-SMEA's 1472 squared + 1 threshold
# is unrelated to the generation size cap.
SIZE_LIMITS = {'min': 64, 'max': 49152, 'step': 64, 'max_pixels': 3145728}


class DakiStyleTestConflict(ValueError):
    pass


class DakiAnlasConfirmation(DakiStyleTestConflict):
    pass


def _now():
    return datetime.now(timezone.utc).isoformat()


def _text(value, label):
    if not isinstance(value, str) or len(value) > 30000:
        raise ValueError(f'{label} 내용을 확인해 주세요.')
    value = value.strip()
    return value


def _batch_name(value, required=False):
    if not isinstance(value, str):
        raise ValueError('테스트 이름은 120자 이내로 입력해 주세요.')
    value = value.strip()
    if len(value) > 120 or required and not value:
        raise ValueError('테스트 이름은 1~120자로 입력해 주세요.')
    return value


def _number(options, key, default, low, high, integer=False):
    value = options.get(key, default)
    if (type(value) not in (int, float) or not math.isfinite(value)
            or not low <= value <= high or integer and int(value) != value):
        raise ValueError(f'{key} 설정을 확인해 주세요 ({low}~{high}).')
    return int(value) if integer else value


def _dimensions(values, optional=False):
    width, height = values.get('width'), values.get('height')
    if optional and width is None and height is None:
        return None, None
    if optional and (type(width) is not int or type(height) is not int):
        raise ValueError('출력 너비와 높이를 모두 정수로 입력하거나 원본 크기를 선택해 주세요.')
    width = _number(values, 'width', None, SIZE_LIMITS['min'], SIZE_LIMITS['max'], True)
    height = _number(values, 'height', None, SIZE_LIMITS['min'], SIZE_LIMITS['max'], True)
    if width % SIZE_LIMITS['step'] or height % SIZE_LIMITS['step'] or width * height > SIZE_LIMITS['max_pixels']:
        raise ValueError(f"출력 크기는 {SIZE_LIMITS['step']}의 배수이며 최대 면적은 {SIZE_LIMITS['max_pixels']:,}픽셀입니다.")
    return width, height


def _request_settings(data):
    if not isinstance(data, dict):
        raise ValueError('테스트 설정은 JSON 객체여야 합니다.')
    output_format = data.get('output_format', 'png')
    if output_format not in ('png', 'webp'):
        raise ValueError('저장 형식은 PNG 또는 WebP를 선택해 주세요.')
    width, height = _dimensions(data, optional=True)
    request = {
        'prompt': _text(data.get('prompt', ''), '공통 프롬프트'),
        'negative_prompt': _text(data.get('negative_prompt', ''), '네거티브 프롬프트'),
        'model': data.get('model'), 'width': width, 'height': height,
        'output_format': output_format,
    }
    characters = data.get('char_prompts', [])
    if not isinstance(characters, list) or len(characters) > 6:
        raise ValueError('캐릭터 프롬프트는 최대 6개까지 입력할 수 있습니다.')
    request['char_prompts'] = []
    for character in characters:
        if isinstance(character, str):
            character = {'prompt': character, 'negative_prompt': ''}
        if not isinstance(character, dict):
            raise ValueError('캐릭터 프롬프트 내용을 확인해 주세요.')
        positive = _text(character.get('prompt', ''), '캐릭터 프롬프트')
        negative = _text(character.get('negative_prompt', ''), '캐릭터 네거티브 프롬프트')
        if positive or negative:
            request['char_prompts'].append({'prompt': positive, 'negative_prompt': negative})
    return request


def build_style_test_payload(style, request):
    """Keep style settings; the worker supplies a new seed when generating."""
    model = request.get('model')
    if model not in MODELS:
        raise ValueError('V5 Full, V5 Full Medium 또는 V4.5 Full 모델을 선택해 주세요.')
    source_options = style.get('options')
    if not isinstance(source_options, dict):
        raise ValueError('원본 그림체의 생성 설정을 읽을 수 없습니다.')
    options = {**GENERATION_DEFAULTS, **source_options}
    if model == V5_FULL_MEDIUM:
        options.update(V5_MEDIUM_FIXED_SETTINGS)
    for key, low, high, integer in (
        ('steps', 1, 50, True), ('cfg', 1, 20, False), ('cfg_rescale', 0, 1, False),
        ('strength', .01, 1, False), ('noise', 0, 1, False),
    ):
        options[key] = _number(options, key, GENERATION_DEFAULTS[key], low, high, integer)
    if options['sampler'] not in SAMPLERS or options['noise_schedule'] not in NOISE_SCHEDULES:
        raise ValueError('원본 그림체의 Sampler 또는 Noise Schedule을 지원하지 않습니다.')
    for key in ('deliberate_euler_ancestral_bug', 'prefer_brownian', 'dynamic_thresholding', 'legacy_v3_extend'):
        if type(options[key]) is not bool:
            raise ValueError(f'{key} 설정은 켜기 또는 끄기여야 합니다.')
    width, height = _dimensions(request, optional=True)
    if width is None:
        width, height = _dimensions(style.get('preview') or {})
    positive = ', '.join(value for value in (str(style.get('positive') or '').strip(), request['prompt']) if value)
    negative = ', '.join(value for value in (str(style.get('negative') or '').strip(), request['negative_prompt']) if value)
    captions = [{'char_caption': item['prompt'], 'centers': [{'x': .5, 'y': .5}]} for item in request['char_prompts']]
    negative_captions = [{'char_caption': item['negative_prompt'], 'centers': [{'x': .5, 'y': .5}]} for item in request['char_prompts']]
    parameters = {
        'width': width, 'height': height, 'steps': options['steps'], 'n_samples': 1,
        'sampler': options['sampler'],
        'scale': options['cfg'], 'cfg_rescale': options['cfg_rescale'],
        'noise_schedule': options['noise_schedule'], 'params_version': 4 if model.startswith('nai-diffusion-5') else 3,
        'legacy': False, 'legacy_v3_extend': options['legacy_v3_extend'], 'add_original_image': False,
        'negative_prompt': negative, 'qualityToggle': False, 'ucPreset': 3,
        'prefer_brownian': options['prefer_brownian'], 'dynamic_thresholding': options['dynamic_thresholding'],
        'sm': False, 'sm_dyn': False, 'deliberate_euler_ancestral_bug': options['deliberate_euler_ancestral_bug'],
        'v4_prompt': {'caption': {'base_caption': positive, 'char_captions': captions}, 'use_coords': False, 'use_order': True},
        'v4_negative_prompt': {'caption': {'base_caption': negative, 'char_captions': negative_captions},
                               'use_coords': False, 'use_order': False, 'legacy_uc': False},
    }
    if model.startswith('nai-diffusion-5'):
        parameters['straight_alpha'] = True
    payload = {'input': positive, 'model': model, 'action': 'generate', 'parameters': parameters}
    apply_model_constraints(payload)
    return payload


class DakiStyleTests:
    def __init__(self, root_provider, catalog, key_provider, generator=None, personal_catalog=None):
        self.root_provider = root_provider
        self.catalog = catalog
        self.personal_catalog = personal_catalog
        self.key_provider = key_provider
        self.generator = generator or generate_text_image
        self.lock = threading.RLock()
        self._recovered = set()
        self._active = None
        self._thread = None
        self._stop = threading.Event()

    def _root(self):
        return Path(self.root_provider()).resolve()

    def _directory(self, root, batch_id):
        if not isinstance(batch_id, str) or not BATCH_ID.fullmatch(batch_id):
            raise ValueError('올바른 테스트 묶음을 선택해 주세요.')
        directory = (root / batch_id).resolve()
        if directory.parent != root:
            raise ValueError('허용되지 않는 테스트 경로입니다.')
        return directory

    def _load(self, root, batch_id):
        directory = self._directory(root, batch_id)
        path = (directory / 'batch.json').resolve()
        if path.parent != directory:
            raise ValueError('허용되지 않는 테스트 경로입니다.')
        with path.open(encoding='utf-8') as source:
            result = json.load(source)
        if not isinstance(result, dict) or result.get('id') != batch_id or not isinstance(result.get('items'), list):
            raise ValueError('저장된 테스트 묶음의 형식을 확인해 주세요.')
        return result

    def _save(self, root, batch):
        batch['updated_at'] = _now()
        directory = self._directory(root, batch['id'])
        directory.mkdir(parents=True, exist_ok=True)
        if (directory / 'batch.json').resolve().parent != directory:
            raise ValueError('허용되지 않는 테스트 경로입니다.')
        write_json(directory / 'batch.json', batch, indent=2)

    def _recover(self, root):
        if root in self._recovered:
            return
        if root.exists():
            for path in root.iterdir():
                if not path.is_dir() or not BATCH_ID.fullmatch(path.name):
                    continue
                try:
                    batch = self._load(root, path.name)
                except (OSError, ValueError):
                    continue
                interrupted = False
                recovered_conversion = False
                for item in batch['items']:
                    if item['status'] == 'running':
                        item.update(status='failed', error='프로그램이 종료되어 결과를 확인할 수 없습니다. 자동으로 다시 생성하지 않습니다.')
                        interrupted = True
                    elif item['status'] == 'converting':
                        self._recover_conversion(root, batch['id'], item)
                        recovered_conversion = True
                if interrupted or recovered_conversion or batch['status'] in ('running', 'stopping'):
                    if interrupted or recovered_conversion and any(item['status'] == 'failed' for item in batch['items']):
                        batch['status'] = 'failed'
                    else:
                        batch['status'] = self._finished_status(batch) if recovered_conversion else 'paused'
                    self._save(root, batch)
        self._recovered.add(root)

    def _recover_conversion(self, root, batch_id, item):
        """A received image must never become another automatic paid request."""
        directory = self._directory(root, batch_id)
        try:
            paths = [resolve_webp_image(directory / (item['style_id'] + suffix)).resolve()
                     for suffix in ('.png', '.jpg')]
            if not all(path.parent == directory and path.is_file() for path in paths):
                raise FileNotFoundError
            item['status'] = 'completed'
            item.pop('error', None)
            if paths[0].suffix.lower() == '.png':
                item['conversion_error'] = 'WebP 변환이 완료되지 않아 PNG로 보관했습니다.'
        except (OSError, ValueError):
            item.update(status='failed', error='저장된 생성 결과를 찾을 수 없습니다. 자동으로 다시 생성하지 않습니다.')

    def _public(self, batch, summary=False):
        result = {key: deepcopy(batch.get(key)) for key in ('id', 'status', 'created_at', 'updated_at', 'model', 'prompt', 'width', 'height', 'origin')}
        result['name'] = batch.get('name') or ''
        result['library'] = batch.get('library') or 'shared'
        result['output_format'] = batch.get('output_format', 'png')
        cover = next((item for item in batch['items'] if item['status'] == 'completed'), None)
        result['cover_src'] = (f"/api/daki/style-tests/{batch['id']}/images/{quote(cover['style_id'], safe='')}"
                               if cover else None)
        for status in ('completed', 'failed', 'pending', 'converting'):
            result[status] = sum(item['status'] == status for item in batch['items'])
        result['total'] = len(batch['items'])
        result['paid_count'] = sum(DakiStyleTests._requires_anlas(item) for item in batch['items'] if item['status'] == 'pending')
        result['requires_anlas'] = result['paid_count'] > 0
        if summary:
            result['prompt'] = result['prompt'][:120]
            return result
        result['missing_shared_style_ids'] = []
        if result['library'] == 'shared':
            existing = {item['style_id'] for item in batch['items']}
            try:
                artist_names = load_style_artist_names()

                def duplicate_key(style):
                    try:
                        return style_duplicate_key(style.get('positive'), artist_names=artist_names)
                    except ValueError:
                        # Unparseable saved recipes still match by ID.
                        return None

                existing_keys = {key for item in batch['items']
                                 if (key := duplicate_key(item['style'])) is not None}
                missing = []
                for style in self.catalog.list_styles():
                    if style['id'] in existing:
                        continue
                    key = duplicate_key(style)
                    if key is not None and key in existing_keys:
                        continue
                    missing.append(style['id'])
                    existing.add(style['id'])
                    if key is not None:
                        existing_keys.add(key)
                result['missing_shared_style_ids'] = missing
            except (OSError, ValueError):
                # Saved snapshots remain usable when the current catalog cannot
                # be read; only the optional new-style action is unavailable.
                result['missing_shared_style_ids'] = None
        result.update(negative_prompt=batch['negative_prompt'], char_prompts=deepcopy(batch['char_prompts']), items=[])
        resolver = getattr(self.catalog, 'source_metadata_many', None)
        sources = resolver([item['style'] for item in batch['items']]) if callable(resolver) else None
        if not isinstance(sources, list) or len(sources) != len(batch['items']):
            sources = None
        date_resolver = getattr(self.catalog, 'sort_dates_many', None)
        dates = date_resolver([item['style'] for item in batch['items']]) if callable(date_resolver) else None
        if not isinstance(dates, list) or len(dates) != len(batch['items']):
            dates = [None] * len(batch['items'])
        for index, item in enumerate(batch['items']):
            style = item['style']
            parameters = item['payload']['parameters']
            source_library = 'personal-styles' if item['style_id'].startswith('personal_') else 'shared-styles'
            metadata = source_metadata(style)
            if source_library == 'shared-styles':
                if sources is not None:
                    metadata = source_metadata(style, sources[index])
                else:
                    resolver = getattr(self.catalog, 'source_metadata', None)
                    if callable(resolver):
                        metadata = source_metadata(style, resolver(style))
            else:
                metadata = source_metadata({})
            public = {
                **metadata,
                'sort_date': style_sort_date(style) or dates[index],
                'style_id': item['style_id'], 'name': style['name'], 'status': item['status'],
                'source_src': (None if source_library == 'personal-styles' and not style.get('source_path') else
                               '/api/daki/' + source_library + '/' + quote(item['style_id'], safe='') + '/preview'),
                'source_model': style.get('model', ''), 'options': deepcopy(style['options']),
                'model': item['payload']['model'],
                'output_format': item.get('output_format', 'png'),
                'width': parameters['width'], 'height': parameters['height'],
                'seed': parameters.get('seed') if item['status'] != 'pending' else None,
                'requires_anlas': DakiStyleTests._requires_anlas(item),
            }
            if item['status'] == 'completed':
                public['src'] = f"/api/daki/style-tests/{batch['id']}/images/{quote(item['style_id'], safe='')}"
            if item.get('error'):
                public['error'] = item['error']
            if item.get('conversion_error'):
                public['conversion_error'] = item['conversion_error']
            result['items'].append(public)
        return result

    def create(self, data):
        request = _request_settings(data)
        name = _batch_name(data.get('name', ''))
        library = data.get('library', 'shared')
        if library not in ('shared', 'personal'):
            raise ValueError('공유 그림체 또는 개인 그림체를 선택해 주세요.')
        catalog = self.personal_catalog if library == 'personal' else self.catalog
        styles = catalog.list_styles() if catalog is not None else []
        if 'style_ids' in data:
            selected = data['style_ids']
            if (not isinstance(selected, list) or not 1 <= len(selected) <= 10000
                    or any(not isinstance(sid, str) or not STYLE_ID.fullmatch(sid) for sid in selected)):
                raise ValueError('테스트할 그림체를 1~10000개 선택해 주세요.')
            active = {style['id']: style for style in styles}
            if any(sid not in active for sid in selected):
                raise ValueError('선택한 라이브러리에 없는 그림체가 있습니다. 목록을 새로 불러와 선택해 주세요.')
            styles = [active[sid] for sid in dict.fromkeys(selected)]
        if not styles:
            raise ValueError('테스트할 그림체가 없습니다.')
        items = []
        seen = set()
        for style in styles:
            style = deepcopy(style)
            style_id = style.get('id')
            if not isinstance(style_id, str) or not STYLE_ID.fullmatch(style_id) or style_id in seen:
                raise ValueError('그림체 ID를 확인해 주세요.')
            seen.add(style_id)
            items.append({'style_id': style_id, 'status': 'pending', 'style': style,
                          'output_format': request['output_format'],
                          'payload': build_style_test_payload(style, request)})
        batch = {'id': uuid.uuid4().hex, 'name': name, 'library': library,
                 'status': 'ready', 'created_at': _now(), **request, 'items': items}
        with self.lock:
            root = self._root()
            self._recover(root)
            self._save(root, batch)
        return self._public(batch)

    def ensure_upper_test(self):
        """Import legacy upper previews once as an ordinary persistent batch."""
        batch_id = uuid.uuid5(uuid.NAMESPACE_URL, 'naim:shared-upper-test').hex
        with self.lock:
            root = self._root()
            self._recover(root)
            directory = self._directory(root, batch_id)
            batch_path = directory / 'batch.json'
            if batch_path.exists():
                return self._public(self._load(root, batch_id))
            if directory.exists():
                raise ValueError('저장된 상반신 테스트 자료의 형식을 확인해 주세요.')

            source = self.catalog.upper_test_source()
            if not isinstance(source, dict) or not isinstance(source.get('entries'), list):
                raise ValueError('상반신 그림체 자료 형식이 올바르지 않습니다.')
            request = _request_settings(source.get('request'))
            if request['model'] not in MODELS:
                raise ValueError('V5 Full, V5 Full Medium 또는 V4.5 Full 모델을 선택해 주세요.')
            entries = source['entries']
            if not entries:
                raise ValueError('테스트할 상반신 그림체가 없습니다.')
            items, seen = [], set()
            for entry in entries:
                if not isinstance(entry, dict):
                    raise ValueError('공유 그림체 항목 형식이 올바르지 않습니다.')
                style = deepcopy(entry.get('style'))
                payload = deepcopy(entry.get('payload'))
                style_id = style.get('id') if isinstance(style, dict) else None
                if (not isinstance(style_id, str) or not STYLE_ID.fullmatch(style_id) or style_id in seen
                        or not isinstance(style.get('name'), str) or not isinstance(style.get('model'), str)
                        or not isinstance(style.get('options'), dict) or not isinstance(style.get('preview'), dict)
                        or entry.get('output_format', 'png') not in ('png', 'webp')
                        or not isinstance(payload, dict) or not isinstance(payload.get('model'), str)
                        or not isinstance(payload.get('input'), str)
                        or not isinstance(payload.get('parameters'), dict)):
                    raise ValueError('공유 그림체 생성 설정을 확인해 주세요.')
                parameters = payload['parameters']
                if (any(type(parameters.get(key)) is not int or parameters[key] <= 0
                        for key in ('width', 'height', 'steps'))):
                    raise ValueError('공유 그림체 생성 요청의 크기 또는 단계를 확인해 주세요.')
                seen.add(style_id)
                items.append({'style_id': style_id, 'status': 'completed', 'style': style,
                              'output_format': entry.get('output_format', 'png'),
                              'payload': payload, 'legacy_preview': True})

            now = _now()
            batch = {'id': batch_id, 'name': '상반신', 'library': 'shared', 'origin': 'shared_upper',
                     'status': 'completed', 'created_at': now, 'updated_at': now, **request, 'items': items}
            self._save(root, batch)
            return self._public(batch)

    def rename(self, batch_id, name):
        name = _batch_name(name, required=True)
        with self.lock:
            root = self._root()
            self._recover(root)
            batch = self._load(root, batch_id)
            batch['name'] = name
            self._save(root, batch)
            return self._public(batch)

    def install_shared_pack(self, staging, batch, stop_event=None):
        """Publish a validated download once; existing local tests always win."""
        with self.lock:
            root = self._root()
            staging = Path(staging).resolve()
            if staging.parent != root / '.packs' or not (staging / 'batch.json').is_file():
                raise ValueError('공유 테스트 임시 저장 위치가 올바르지 않습니다.')
            directory = self._directory(root, batch['id'])
            if directory.exists():
                return False
            if stop_event is not None and stop_event.is_set():
                from naim.daki_test_packs import _PackStopped
                raise _PackStopped()
            os.rename(staging, directory)
            return True

    def append_styles(self, batch_id, style_ids):
        if (not isinstance(style_ids, list) or not 1 <= len(style_ids) <= 10000
                or any(not isinstance(sid, str) or not STYLE_ID.fullmatch(sid) for sid in style_ids)):
            raise ValueError('추가할 그림체를 1~10000개 선택해 주세요.')
        with self.lock:
            root = self._root()
            self._recover(root)
            batch = self._load(root, batch_id)
            if self._active == (root, batch_id) or batch['status'] in ('running', 'stopping'):
                raise DakiStyleTestConflict('생성이 끝나거나 중지된 뒤 그림체를 추가해 주세요.')
            existing = {item['style_id'] for item in batch['items']}
            requested = [sid for sid in dict.fromkeys(style_ids) if sid not in existing]
            if not requested:
                return self._public(batch)
            # get_style also serves saved previews for excluded shared styles;
            # only the active catalog may supply new generation requests.
            shared_ids = ({style['id'] for style in self.catalog.list_styles()}
                          if any(not sid.startswith('personal_') for sid in requested) else set())
            request = _request_settings(batch)
            additions = []
            for style_id in requested:
                personal = style_id.startswith('personal_')
                catalog = self.personal_catalog if personal else self.catalog
                if catalog is None or not personal and style_id not in shared_ids:
                    raise FileNotFoundError('추가할 그림체를 찾을 수 없습니다.')
                style = deepcopy(catalog.get_style(style_id))
                if style.get('id') != style_id:
                    raise ValueError('그림체 ID를 확인해 주세요.')
                additions.append({'style_id': style_id, 'status': 'pending', 'style': style,
                                  'output_format': request['output_format'],
                                  'payload': build_style_test_payload(style, request)})
            batch['items'].extend(additions)
            batch['status'] = self._finished_status(batch)
            self._save(root, batch)
            return self._public(batch)

    def update_settings(self, batch_id, data):
        with self.lock:
            root = self._root()
            self._recover(root)
            batch = self._load(root, batch_id)
            if self._active == (root, batch_id) or batch['status'] in ('running', 'stopping'):
                raise DakiStyleTestConflict('생성이 끝나거나 중지된 뒤 설정을 수정해 주세요.')
            pending = [item for item in batch['items'] if item['status'] == 'pending']
            if not pending:
                raise DakiStyleTestConflict('설정을 수정할 대기 중인 그림체가 없습니다.')
            if not isinstance(data, dict):
                raise ValueError('테스트 설정은 JSON 객체여야 합니다.')
            request = _request_settings({'output_format': batch.get('output_format', 'png'), **data})
            payloads = [build_style_test_payload(item['style'], request) for item in pending]
            for item, payload in zip(pending, payloads):
                item['payload'] = payload
                item['output_format'] = request['output_format']
            batch.update(request)
            self._save(root, batch)
            return self._public(batch)

    def list_batches(self):
        with self.lock:
            root = self._root()
            self._recover(root)
            batches = []
            if root.exists():
                for path in root.iterdir():
                    if path.is_dir() and BATCH_ID.fullmatch(path.name):
                        try:
                            batches.append(self._public(self._load(root, path.name), summary=True))
                        except (OSError, ValueError):
                            continue
            return sorted(batches, key=lambda item: item['created_at'], reverse=True)

    def get(self, batch_id):
        with self.lock:
            root = self._root()
            self._recover(root)
            return self._public(self._load(root, batch_id))

    def iter_completed_prompt_images(self):
        """Read each completed image's immutable payload, not current batch inputs."""
        root = self._root()
        if not root.is_dir():
            return
        for directory in sorted(root.iterdir(), key=lambda path: path.name):
            if not directory.is_dir() or not BATCH_ID.fullmatch(directory.name):
                continue
            try:
                with self.lock:
                    batch = self._load(root, directory.name)
                for item in batch['items']:
                    style_id = item.get('style_id')
                    if item.get('status') != 'completed' or not isinstance(style_id, str) or not STYLE_ID.fullmatch(style_id):
                        continue
                    if item.get('legacy_preview') is True:
                        image = self.catalog.preview_path(style_id, full=True)
                    else:
                        image = resolve_webp_image(self._directory(root, directory.name) / (style_id + '.png')).resolve()
                        if image.parent != self._directory(root, directory.name):
                            continue
                    if not image.is_file():
                        continue
                    payload = item.get('payload') or {}
                    info = {**deepcopy(payload.get('parameters') or {}), 'prompt': payload.get('input', '')}
                    yield {'path': f'__daki_tests__/{directory.name}/{style_id}.png',
                           'name': (batch.get('name') or '그림체 테스트') + ' · ' + str(item.get('style', {}).get('name') or style_id),
                           'prompt_info': info}
            except (OSError, ValueError):
                continue

    @staticmethod
    def _requires_anlas(item):
        parameters = item['payload']['parameters']
        return parameters['width'] * parameters['height'] > 1048576 or parameters['steps'] > 28

    def run(self, batch_id, mode, allow_anlas=False):
        if mode not in ('next', 'remaining', 'retry_failed'):
            raise ValueError('한 장, 남은 전체 또는 실패한 그림체 다시 생성을 선택해 주세요.')
        with self.lock:
            root = self._root()
            self._recover(root)
            if self._active is not None:
                raise DakiStyleTestConflict('이미 그림체 테스트를 생성하고 있습니다.')
            batch = self._load(root, batch_id)
            target_status = 'failed' if mode == 'retry_failed' else 'pending'
            selected = [item for item in batch['items'] if item['status'] == target_status]
            if not selected:
                if mode == 'retry_failed':
                    raise DakiStyleTestConflict('다시 생성할 실패한 그림체가 없습니다.')
                raise DakiStyleTestConflict('남은 그림체가 없습니다. 완료·실패한 요청은 자동으로 다시 생성하지 않습니다.')
            if mode == 'next':
                selected = selected[:1]
            if allow_anlas is not True and any(self._requires_anlas(item) for item in selected):
                raise DakiAnlasConfirmation('이 설정은 Anlas가 소모될 수 있습니다. 사용에 동의한 뒤 실행해 주세요.')
            key = self.key_provider()
            if not isinstance(key, str) or not key.strip():
                raise ValueError('NovelAI API Key를 먼저 설정해 주세요.')
            self._stop.clear()
            batch['status'] = 'running'
            self._save(root, batch)
            self._active = (root, batch_id)
            self._thread = threading.Thread(target=self._worker, args=(root, batch_id, mode, key.strip()), daemon=True)
            try:
                self._thread.start()
            except RuntimeError:
                self._active = None
                batch['status'] = 'paused'
                self._save(root, batch)
                raise
            return self._public(batch)

    def stop(self, batch_id):
        with self.lock:
            root = self._root()
            self._recover(root)
            batch = self._load(root, batch_id)
            if self._active == (root, batch_id):
                self._stop.set()
                batch['status'] = 'stopping'
                self._save(root, batch)
            return self._public(batch)

    @staticmethod
    def _finished_status(batch):
        if any(item['status'] == 'pending' for item in batch['items']):
            return 'paused'
        return 'failed' if any(item['status'] == 'failed' for item in batch['items']) else 'completed'

    def _save_image(self, root, batch_id, item, image):
        directory = self._directory(root, batch_id)
        parameters = item['payload']['parameters']
        if image.size != (parameters['width'], parameters['height']):
            raise ValueError('생성 결과의 크기가 요청한 크기와 다릅니다.')
        metadata = PngInfo()
        metadata.add_text('Comment', json.dumps({**parameters, 'prompt': item['payload']['input'],
                                               'model': item['payload']['model']}, ensure_ascii=False))
        metadata.add_text('Source', item['payload']['model'])
        thumbnail = image.convert('RGB')
        thumbnail.thumbnail((512, 512), Image.Resampling.LANCZOS)
        for suffix, output, kwargs in (('.png', image, {'format': 'PNG', 'pnginfo': metadata}),
                                       ('.jpg', thumbnail, {'format': 'JPEG', 'quality': 88})):
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(dir=directory, prefix='.image-', suffix='.tmp', delete=False) as stream:
                    temporary = Path(stream.name)
                    output.save(stream, **kwargs)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, directory / (item['style_id'] + suffix))
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)

    def _convert_image(self, root, batch_id, style_id):
        source = self._directory(root, batch_id) / (style_id + '.png')
        try:
            result = convert_png_to_webp(source, lossless=False, quality=90)
            converted = result['status'] == 'converted'
        except Exception:
            converted = False
        with self.lock:
            batch = self._load(root, batch_id)
            current = next(item for item in batch['items'] if item['style_id'] == style_id)
            current['status'] = 'completed'
            if not converted:
                # The converter verifies before deleting PNG. Conversion failure
                # is a storage warning, never a reason to pay for generation again.
                current['conversion_error'] = 'WebP 변환에 실패하여 PNG로 보관했습니다.'
            self._save(root, batch)

    def _worker(self, root, batch_id, mode, key):
        target_status = 'failed' if mode == 'retry_failed' else 'pending'
        failed = False
        try:
            # Only local conversion overlaps server generation. Bound unfinished
            # conversions to two so a fast server cannot build an unlimited queue.
            with ThreadPoolExecutor(max_workers=1, thread_name_prefix='daki-webp') as converter:
                conversions = deque()
                while True:
                    while conversions and (conversions[0].done() or len(conversions) >= 2):
                        conversions.popleft().result()
                    with self.lock:
                        batch = self._load(root, batch_id)
                        item = next((item for item in batch['items'] if item['status'] == target_status), None)
                        if self._stop.is_set() or item is None:
                            break
                        item['status'] = 'running'
                        item.pop('error', None)
                        item.pop('conversion_error', None)
                        # Assign at dispatch, including batches prepared by older
                        # versions. Persist the used seed before any paid request.
                        seed = secrets.randbelow(2 ** 32)
                        item['payload']['parameters'].update(seed=seed, extra_noise_seed=seed, n_samples=1)
                        self._save(root, batch)
                    try:
                        image = self.generator(key, deepcopy(item['payload']))
                        try:
                            self._save_image(root, batch_id, item, image)
                        finally:
                            image.close()
                    except Exception as error:
                        with self.lock:
                            batch = self._load(root, batch_id)
                            current = next(entry for entry in batch['items'] if entry['style_id'] == item['style_id'])
                            message = ('결과 파일을 읽거나 저장하지 못했습니다. 자동으로 다시 생성하지 않습니다.'
                                       if isinstance(error, OSError) else str(error).replace(key, '[키 숨김]')[:500])
                            current.update(status='failed', error=message or '생성에 실패했습니다. 자동으로 다시 요청하지 않습니다.')
                            self._save(root, batch)
                        failed = True
                        break
                    webp = item.get('output_format', 'png') == 'webp'
                    with self.lock:
                        batch = self._load(root, batch_id)
                        current = next(entry for entry in batch['items'] if entry['style_id'] == item['style_id'])
                        current['status'] = 'converting' if webp else 'completed'
                        self._save(root, batch)
                    if webp:
                        conversions.append(converter.submit(self._convert_image, root, batch_id, item['style_id']))
                    if mode == 'next':
                        break
                # Stop drains received images, even when another server request
                # failed. Keep the batch busy and polling until all files are safe.
                for conversion in conversions:
                    conversion.result()
            with self.lock:
                batch = self._load(root, batch_id)
                batch['status'] = 'failed' if failed else self._finished_status(batch)
                self._save(root, batch)
        except Exception:
            # A persistence failure may happen after a paid request. Mark the
            # in-flight item uncertain when storage is available; never replay it.
            with self.lock:
                try:
                    batch = self._load(root, batch_id)
                    for item in batch['items']:
                        if item['status'] == 'running':
                            item.update(status='failed', error='결과 저장을 완료하지 못했습니다. 자동으로 다시 생성하지 않습니다.')
                        elif item['status'] == 'converting':
                            self._recover_conversion(root, batch_id, item)
                    batch['status'] = 'failed'
                    self._save(root, batch)
                except (OSError, ValueError):
                    pass
        finally:
            with self.lock:
                self._active = None

    def image_path(self, batch_id, style_id, full=False):
        if not isinstance(style_id, str) or not STYLE_ID.fullmatch(style_id):
            raise ValueError('올바른 그림체를 선택해 주세요.')
        with self.lock:
            root = self._root()
            self._recover(root)
            batch = self._load(root, batch_id)
            item = next((entry for entry in batch['items'] if entry['style_id'] == style_id), None)
            if item is None or item['status'] != 'completed':
                raise FileNotFoundError('생성 결과를 찾을 수 없습니다.')
            if item.get('legacy_preview') is True:
                return self.catalog.preview_path(style_id, full=full)
            directory = self._directory(root, batch_id)
            source = directory / (style_id + ('.png' if full else '.jpg'))
            path = resolve_webp_image(source).resolve()
            if path.parent != directory or not path.is_file():
                raise FileNotFoundError('생성 결과를 찾을 수 없습니다.')
            return path

    def wait(self, timeout=10):
        thread = self._thread
        if thread is not None:
            thread.join(timeout)
            return not thread.is_alive()
        return True
