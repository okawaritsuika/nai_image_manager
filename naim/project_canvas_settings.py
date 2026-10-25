"""Pure validation and defaults for Daki project canvas settings."""

import re

from naim.generation_settings import normalize_inpaint_settings
from naim.images.inpaint_reference import normalize_reference


PROMPT_SIDES = ('front', 'back')
GENERATION_FIELDS = (
    'model', 'sampler', 'steps', 'cfg', 'cfg_rescale', 'noise_schedule',
    'seed', 'strength', 'noise',
)
_GENERATION_NUMERIC_FIELDS = ('steps', 'cfg', 'cfg_rescale', 'seed', 'strength', 'noise')
_PROMPT_FIELDS = ('basePrompt', 'negativePrompt')
_PROMPT_MAX_LENGTH = 100_000
_CHARACTER_LIMIT = 22


def _normalize_project_selection(value, style):
    selection = _require_object(value, '그림체 태그 선택')
    result = {}
    for field, text_field in (('base', 'positive'), ('negative', 'negative')):
        entries = selection.get(field)
        if not isinstance(entries, list) or len(entries) > _PROMPT_MAX_LENGTH:
            raise ValueError('그림체 태그 선택은 Base와 Negative 목록이어야 합니다.')
        normalized = []
        seen = set()
        total_length = 0
        for entry in entries:
            item = _require_object(entry, '선택한 태그')
            token = _require_string(item.get('token'), '선택한 태그', minimum=1)
            occurrence = item.get('occurrence')
            if (token != token.strip() or ',' in token or isinstance(occurrence, bool)
                    or not isinstance(occurrence, int) or not 0 <= occurrence <= 9_007_199_254_740_991):
                raise ValueError('선택한 태그와 중복 위치가 올바르지 않습니다.')
            pair = (token, occurrence)
            if pair in seen:
                raise ValueError('같은 태그 위치를 중복 선택할 수 없습니다.')
            seen.add(pair)
            total_length += len(token)
            if total_length > _PROMPT_MAX_LENGTH:
                raise ValueError('선택한 태그가 너무 깁니다.')
            normalized.append({'token': token, 'occurrence': occurrence})
        selected_tokens = [item['token'] for item in normalized]
        if selected_tokens != [token.strip() for token in style[text_field].split(',') if token.strip()]:
            raise ValueError('그림체 프롬프트와 선택한 태그가 일치하지 않습니다.')
        result[field] = normalized
    if not result['base'] and not result['negative']:
        raise ValueError('그림체로 연결할 태그를 하나 이상 선택해 주세요.')
    return result


def default_canvas_settings():
    """Return fresh defaults without mutating project storage."""
    return {
        'revision': 0,
        'style': None,
        'prompts': {
            side: {'basePrompt': '', 'negativePrompt': ''}
            for side in PROMPT_SIDES
        },
        'inpaintSettings': None,
    }


def _require_object(value, label):
    if not isinstance(value, dict):
        raise ValueError(f'{label}은 JSON 객체여야 합니다.')
    return value


def _require_string(value, label, *, minimum=0, maximum=_PROMPT_MAX_LENGTH):
    if (not isinstance(value, str) or len(value) < minimum or len(value) > maximum
            or (minimum > 0 and not value.strip())):
        raise ValueError(f'{label}은 {minimum}~{maximum}자 문자열이어야 합니다.')
    return value


def _normalize_style(value):
    if value is None:
        return None
    style = _require_object(value, '그림체')
    for key in ('id', 'name', 'library', 'positive', 'negative'):
        if key not in style:
            raise ValueError('그림체 설정의 필수 항목이 없습니다.')
    style_id = _require_string(style['id'], '그림체 ID', minimum=1, maximum=256)
    name = _require_string(style['name'], '그림체명', minimum=1, maximum=500)
    library = style['library']
    if library not in ('shared', 'personal', 'project'):
        raise ValueError('그림체 보관 위치는 shared, personal 또는 project여야 합니다.')
    normalized = {
        'id': style_id,
        'name': name,
        'library': library,
        'positive': _require_string(style['positive'], '그림체 positive'),
        'negative': _require_string(style['negative'], '그림체 negative'),
    }
    if library == 'project':
        project_id = style.get('sourceProjectId')
        if not isinstance(project_id, str) or not re.fullmatch(r'[a-f0-9]{32}', project_id):
            raise ValueError('그림체를 선택한 프로젝트 ID가 올바르지 않습니다.')
        normalized['sourceProjectId'] = project_id
        normalized['selection'] = _normalize_project_selection(style.get('selection'), normalized)
    return normalized


def _normalize_prompts(value):
    prompts = _require_object(value, '앞면·뒷면 프롬프트')
    if set(prompts) != set(PROMPT_SIDES):
        raise ValueError('프롬프트는 front와 back 항목을 모두 포함해야 합니다.')
    normalized = {}
    for side in PROMPT_SIDES:
        side_prompts = _require_object(prompts[side], f'{side} 프롬프트')
        for key in _PROMPT_FIELDS:
            if key not in side_prompts:
                raise ValueError(f'{side} 프롬프트의 필수 항목이 없습니다.')
        normalized[side] = {
            key: _require_string(side_prompts[key], f'{side} {key}')
            for key in _PROMPT_FIELDS
        }
        if 'charPrompts' in side_prompts:
            characters = side_prompts['charPrompts']
            if not isinstance(characters, list) or len(characters) > _CHARACTER_LIMIT:
                raise ValueError('캐릭터 프롬프트는 최대 22개의 목록이어야 합니다.')
            normalized[side]['charPrompts'] = [
                _require_string(item, f'{side} 캐릭터 프롬프트') for item in characters
            ]
    return normalized


def _normalize_inpaint_settings(value):
    if value is None:
        return None
    settings = _require_object(value, '인페인트 설정')
    if any(key not in settings for key in GENERATION_FIELDS):
        raise ValueError('인페인트 설정의 생성 항목을 모두 입력해 주세요.')
    for key in ('model', 'sampler', 'noise_schedule'):
        if not isinstance(settings[key], str):
            raise ValueError(f'{key}은 문자열이어야 합니다.')
    for key in _GENERATION_NUMERIC_FIELDS:
        if isinstance(settings[key], bool):
            raise ValueError(f'{key}은 참 또는 거짓이 아닌 숫자여야 합니다.')

    normalized = normalize_inpaint_settings({key: settings[key] for key in GENERATION_FIELDS})
    normalized['model'] = normalized['model'].removesuffix('-inpainting')
    if normalized['cfg_rescale'] == '':
        normalized['cfg_rescale'] = 0
    return normalized


def normalize_canvas_settings(value):
    """Return a detached, known-field settings object without its server revision."""
    settings = _require_object(value, '프로젝트 캔버스 설정')
    for key in ('style', 'prompts', 'inpaintSettings'):
        if key not in settings:
            raise ValueError('프로젝트 캔버스 설정의 필수 항목이 없습니다.')
    normalized = {
        'style': _normalize_style(settings['style']),
        'prompts': _normalize_prompts(settings['prompts']),
        'inpaintSettings': _normalize_inpaint_settings(settings['inpaintSettings']),
    }
    if 'inpaintReference' in settings:
        normalized['inpaintReference'] = normalize_reference(settings['inpaintReference'])
    return normalized


def normalize_canvas_settings_record(value):
    """Validate a persisted settings record and return its public API shape."""
    record = _require_object(value, '저장된 프로젝트 캔버스 설정')
    revision = record.get('revision')
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
        raise ValueError('프로젝트 설정 revision은 0 이상의 정수여야 합니다.')
    normalized = normalize_canvas_settings(record)
    return {'revision': revision, **normalized}
