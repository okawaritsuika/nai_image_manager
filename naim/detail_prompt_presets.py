"""Validation and defaults for canvas instance detail prompt presets."""
from copy import deepcopy
import re


MAX_PRESETS = 500
MAX_NAME_LENGTH = 80
MAX_CATEGORY_LENGTH = 40
MAX_PROMPT_LENGTH = 10000
_PRESET_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,80}$')
_EDITABLE_FIELDS = ('name', 'category', 'base', 'negative')


DEFAULT_DETAIL_PRESETS = (
    {'id': 'detail-overall-clarity', 'name': '전체 선명도', 'category': '전체',
     'base': 'crisp fine details, clear contours, coherent shading',
     'negative': 'blurred details, broken contours, uneven shading'},
    {'id': 'detail-skin-texture', 'name': '피부 결', 'category': '피부',
     'base': 'subtle skin texture, smooth tonal transitions, delicate highlights',
     'negative': 'patchy texture, harsh noise, plastic surface'},
    {'id': 'detail-skin-shading', 'name': '피부 음영', 'category': '피부',
     'base': 'soft skin shading, consistent light and shadow, clean color transitions',
     'negative': 'muddy shading, harsh blotches, inconsistent lighting'},
    {'id': 'detail-face', 'name': '얼굴 윤곽', 'category': '얼굴',
     'base': 'clear facial contours, balanced facial features, smooth shading',
     'negative': 'warped face, uneven features, broken contours'},
    {'id': 'detail-eyes', 'name': '눈', 'category': '얼굴',
     'base': 'clear eye shape, precise iris detail, balanced highlights',
     'negative': 'misaligned eyes, malformed pupils, uneven highlights'},
    {'id': 'detail-eyelashes', 'name': '속눈썹', 'category': '얼굴',
     'base': 'fine eyelash strands, clean lash edges, natural spacing',
     'negative': 'clumped lashes, jagged lash lines, uneven density'},
    {'id': 'detail-eyebrows', 'name': '눈썹', 'category': '얼굴',
     'base': 'defined eyebrow strands, clean brow shape, even detail',
     'negative': 'patchy eyebrows, blurred edges, uneven shape'},
    {'id': 'detail-nose', 'name': '코', 'category': '얼굴',
     'base': 'subtle nose contours, refined bridge shading, clean highlights',
     'negative': 'distorted nose, harsh shading, misplaced highlights'},
    {'id': 'detail-lips', 'name': '입술', 'category': '얼굴',
     'base': 'defined lip contours, subtle lip texture, smooth shading',
     'negative': 'blurred lip edges, uneven contours, harsh texture'},
    {'id': 'detail-ears', 'name': '귀', 'category': '얼굴',
     'base': 'clear ear contours, coherent inner-ear structure, soft shading',
     'negative': 'malformed ears, missing contours, uneven structure'},
    {'id': 'detail-hair-strands', 'name': '머리카락 결', 'category': '머리카락',
     'base': 'fine hair strands, coherent flow, defined silhouette',
     'negative': 'tangled shapes, broken strands, irregular silhouette'},
    {'id': 'detail-hair-shine', 'name': '머리카락 윤기', 'category': '머리카락',
     'base': 'controlled hair highlights, smooth sheen, consistent light direction',
     'negative': 'oversharp shine, patchy highlights, inconsistent lighting'},
    {'id': 'detail-neck', 'name': '목', 'category': '상체',
     'base': 'clean neck contours, natural transitions, subtle shading',
     'negative': 'stiff contours, abrupt transitions, uneven shading'},
    {'id': 'detail-shoulders', 'name': '어깨', 'category': '상체',
     'base': 'clear shoulder contours, coherent joint structure, balanced shading',
     'negative': 'distorted shoulder joints, broken contours, uneven shading'},
    {'id': 'detail-collarbone', 'name': '쇄골', 'category': '상체',
     'base': 'subtle collarbone definition, natural anatomy, soft contour shading',
     'negative': 'overdefined lines, broken anatomy, harsh shadows'},
    {'id': 'detail-chest', 'name': '가슴', 'category': '상체',
     'base': 'coherent upper torso anatomy, smooth contour transitions, balanced shading',
     'negative': 'distorted torso anatomy, abrupt contours, uneven shading'},
    {'id': 'detail-back', 'name': '등', 'category': '상체',
     'base': 'clear back contours, coherent shoulder-blade structure, soft shading',
     'negative': 'broken back contours, distorted structure, harsh shading'},
    {'id': 'detail-abdomen', 'name': '배', 'category': '상체',
     'base': 'natural abdomen contours, coherent torso shading, smooth transitions',
     'negative': 'distorted torso, uneven contours, patchy shading'},
    {'id': 'detail-navel', 'name': '배꼽', 'category': '상체',
     'base': 'subtle navel detail, natural surrounding contours, soft shading',
     'negative': 'misplaced detail, harsh outline, distorted contours'},
    {'id': 'detail-waist', 'name': '허리', 'category': '상체',
     'base': 'clear waist contours, coherent torso proportions, smooth shading',
     'negative': 'warped torso, broken contours, uneven proportions'},
    {'id': 'detail-pelvis', 'name': '골반', 'category': '하체',
     'base': 'coherent pelvic anatomy, clear hip contours, balanced shading',
     'negative': 'distorted pelvic anatomy, broken contours, uneven shading'},
    {'id': 'detail-vulva-anatomy', 'name': '외음부(해부학)', 'category': '하체',
     'base': 'accurate pelvic anatomy, coherent anatomical contours, subtle shading',
     'negative': 'anatomical distortion, inconsistent contours, uneven shading'},
    {'id': 'detail-arms', 'name': '팔', 'category': '팔·손',
     'base': 'clear arm contours, coherent joint structure, smooth shading',
     'negative': 'distorted arms, broken joints, uneven contours'},
    {'id': 'detail-elbows', 'name': '팔꿈치', 'category': '팔·손',
     'base': 'natural elbow structure, clear joint contours, subtle shading',
     'negative': 'malformed joint, sharp creases, broken contours'},
    {'id': 'detail-wrists', 'name': '손목', 'category': '팔·손',
     'base': 'clear wrist contours, natural joint transition, balanced shading',
     'negative': 'distorted wrists, abrupt transitions, uneven contours'},
    {'id': 'detail-hands', 'name': '손', 'category': '팔·손',
     'base': 'well-defined hand structure, clear palm contours, coherent anatomy',
     'negative': 'malformed hands, fused forms, inconsistent anatomy'},
    {'id': 'detail-fingers', 'name': '손가락', 'category': '팔·손',
     'base': 'distinct finger shapes, clear joints, natural spacing',
     'negative': 'extra fingers, fused fingers, malformed joints'},
    {'id': 'detail-buttocks', 'name': '엉덩이', 'category': '하체',
     'base': 'coherent hip anatomy, clear outer contours, balanced shading',
     'negative': 'distorted anatomy, broken contours, uneven shading'},
    {'id': 'detail-thighs', 'name': '허벅지', 'category': '하체',
     'base': 'clear thigh contours, coherent joint transitions, smooth shading',
     'negative': 'warped limbs, broken contours, uneven shading'},
    {'id': 'detail-knees', 'name': '무릎', 'category': '하체',
     'base': 'natural knee structure, clear joint contours, subtle shading',
     'negative': 'malformed knees, sharp creases, broken anatomy'},
    {'id': 'detail-calves', 'name': '종아리', 'category': '하체',
     'base': 'defined calf contours, coherent lower-leg anatomy, smooth shading',
     'negative': 'distorted calves, uneven contours, patchy shading'},
    {'id': 'detail-ankles', 'name': '발목', 'category': '하체',
     'base': 'clear ankle structure, natural joint transitions, balanced shading',
     'negative': 'malformed ankles, abrupt transitions, uneven contours'},
    {'id': 'detail-feet', 'name': '발', 'category': '하체',
     'base': 'well-defined foot structure, clear arch contours, coherent anatomy',
     'negative': 'malformed feet, distorted arches, broken contours'},
    {'id': 'detail-toes', 'name': '발가락', 'category': '하체',
     'base': 'distinct toe shapes, natural spacing, clear joint details',
     'negative': 'extra toes, fused toes, malformed joints'},
    {'id': 'detail-fabric', 'name': '옷감', 'category': '의상',
     'base': 'fine fabric texture, consistent material detail, clean edges',
     'negative': 'patchy texture, blurred material, jagged edges'},
    {'id': 'detail-folds', 'name': '주름', 'category': '의상',
     'base': 'coherent fabric folds, consistent light and shadow, clean transitions',
     'negative': 'random folds, broken shading, tangled fabric shapes'},
    {'id': 'detail-seams', 'name': '봉제선', 'category': '의상',
     'base': 'fine seam detail, straight stitching, clean garment edges',
     'negative': 'broken seams, uneven stitching, ragged edges'},
)


class DetailPresetConflict(ValueError):
    """An edit was based on a preset collection revision that is no longer current."""


class DetailPresetNotFound(LookupError):
    """A requested preset does not exist in the selected collection."""


class DetailPresetStorageError(Exception):
    """The persisted preset data is malformed and cannot be safely edited."""


def default_common_collection():
    return {'revision': 0, 'items': deepcopy(list(DEFAULT_DETAIL_PRESETS))}


def empty_project_collection():
    return {'revision': 0, 'items': []}


def validate_revision(revision):
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
        raise ValueError('프리셋 revision은 0 이상의 정수여야 합니다.')
    return revision


def _validate_id(value, *, storage=False):
    if not isinstance(value, str) or not _PRESET_ID_RE.fullmatch(value):
        error = '저장된 프리셋 ID가 올바르지 않습니다.' if storage else '프리셋 ID가 올바르지 않습니다.'
        raise (DetailPresetStorageError if storage else ValueError)(error)
    return value


def _validate_text(value, field, maximum, *, trim, storage=False):
    if not isinstance(value, str):
        error = f'저장된 프리셋 {field} 형식이 올바르지 않습니다.' if storage else f'프리셋 {field}은 문자열이어야 합니다.'
        raise (DetailPresetStorageError if storage else ValueError)(error)
    normalized = value.strip() if trim else value
    if trim and not normalized:
        error = f'저장된 프리셋 {field}이 비어 있습니다.' if storage else f'프리셋 {field}을 입력해 주세요.'
        raise (DetailPresetStorageError if storage else ValueError)(error)
    if len(normalized) > maximum:
        error = f'저장된 프리셋 {field}이 너무 깁니다.' if storage else f'프리셋 {field}은 {maximum}자 이하로 입력해 주세요.'
        raise (DetailPresetStorageError if storage else ValueError)(error)
    return normalized


def prepare_new_preset(value):
    if not isinstance(value, dict):
        raise ValueError('프리셋은 JSON 객체여야 합니다.')
    preset_id = _validate_id(value.get('id'))
    prepared = {
        'id': preset_id,
        'name': _validate_text(value.get('name'), '이름', MAX_NAME_LENGTH, trim=True),
        'category': _validate_text(value.get('category'), '분류', MAX_CATEGORY_LENGTH, trim=True),
        'base': _validate_text(value.get('base', ''), 'Base 프롬프트', MAX_PROMPT_LENGTH, trim=False),
        'negative': _validate_text(value.get('negative', ''), 'Negative 프롬프트', MAX_PROMPT_LENGTH, trim=False),
    }
    if not prepared['base'].strip() and not prepared['negative'].strip():
        raise ValueError('Base 또는 Negative 프롬프트를 입력해 주세요.')
    return prepared


def prepare_preset_update(value, existing):
    if not isinstance(value, dict):
        raise ValueError('프리셋은 JSON 객체여야 합니다.')
    preset_id = _validate_id(value.get('id'))
    if preset_id != existing['id']:
        raise ValueError('수정할 프리셋 ID는 변경할 수 없습니다.')
    updated = deepcopy(existing)
    for field in _EDITABLE_FIELDS:
        if field not in value:
            continue
        if field == 'name':
            updated[field] = _validate_text(value[field], '이름', MAX_NAME_LENGTH, trim=True)
        elif field == 'category':
            updated[field] = _validate_text(value[field], '분류', MAX_CATEGORY_LENGTH, trim=True)
        else:
            updated[field] = _validate_text(value[field], f'{field} 프롬프트', MAX_PROMPT_LENGTH, trim=False)
    if not updated['base'].strip() and not updated['negative'].strip():
        raise ValueError('Base 또는 Negative 프롬프트를 입력해 주세요.')
    return updated


def validate_stored_collection(value):
    if not isinstance(value, dict):
        raise DetailPresetStorageError('저장된 프리셋 모음 형식이 올바르지 않습니다.')
    revision = value.get('revision')
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
        raise DetailPresetStorageError('저장된 프리셋 revision이 올바르지 않습니다.')
    items = value.get('items')
    if not isinstance(items, list) or len(items) > MAX_PRESETS:
        raise DetailPresetStorageError('저장된 프리셋 목록 형식이 올바르지 않습니다.')
    seen = set()
    for item in items:
        if not isinstance(item, dict):
            raise DetailPresetStorageError('저장된 프리셋 레코드 형식이 올바르지 않습니다.')
        preset_id = _validate_id(item.get('id'), storage=True)
        if preset_id in seen:
            raise DetailPresetStorageError('저장된 프리셋 ID가 중복되었습니다.')
        seen.add(preset_id)
        _validate_text(item.get('name'), '이름', MAX_NAME_LENGTH, trim=True, storage=True)
        _validate_text(item.get('category'), '분류', MAX_CATEGORY_LENGTH, trim=True, storage=True)
        base = _validate_text(item.get('base'), 'Base 프롬프트', MAX_PROMPT_LENGTH, trim=False, storage=True)
        negative = _validate_text(item.get('negative'), 'Negative 프롬프트', MAX_PROMPT_LENGTH, trim=False, storage=True)
        if not base.strip() and not negative.strip():
            raise DetailPresetStorageError('저장된 프리셋에 프롬프트가 없습니다.')
    return deepcopy(value)


def mutate_collection(collection, *, revision, method, preset=None, preset_id=None):
    """Return a changed collection and flag; callers decide whether to persist it."""
    validate_revision(revision)
    current = deepcopy(collection)
    items = current['items']

    if method == 'POST':
        prepared = prepare_new_preset(preset)
        existing = next((item for item in items if item['id'] == prepared['id']), None)
        if existing is not None:
            if {key: existing[key] for key in ('id', *_EDITABLE_FIELDS)} != prepared:
                raise DetailPresetConflict('같은 ID의 프리셋이 이미 다른 내용으로 저장되어 있습니다.')
            return current, False
        if current['revision'] != revision:
            raise DetailPresetConflict('프리셋이 다른 곳에서 변경되었습니다. 최신 목록을 다시 불러와 주세요.')
        if len(items) >= MAX_PRESETS:
            raise ValueError(f'프리셋은 모음당 {MAX_PRESETS}개까지 저장할 수 있습니다.')
        items.append(prepared)
    elif method == 'PUT':
        if not isinstance(preset, dict):
            raise ValueError('프리셋은 JSON 객체여야 합니다.')
        target_id = _validate_id(preset.get('id'))
        index = next((index for index, item in enumerate(items) if item['id'] == target_id), None)
        if index is None:
            raise DetailPresetNotFound('프리셋을 찾을 수 없습니다.')
        if current['revision'] != revision:
            raise DetailPresetConflict('프리셋이 다른 곳에서 변경되었습니다. 최신 목록을 다시 불러와 주세요.')
        updated = prepare_preset_update(preset, items[index])
        if updated == items[index]:
            return current, False
        items[index] = updated
    elif method == 'DELETE':
        _validate_id(preset_id)
        index = next((index for index, item in enumerate(items) if item['id'] == preset_id), None)
        if index is None:
            raise DetailPresetNotFound('프리셋을 찾을 수 없습니다.')
        if current['revision'] != revision:
            raise DetailPresetConflict('프리셋이 다른 곳에서 변경되었습니다. 최신 목록을 다시 불러와 주세요.')
        del items[index]
    else:
        raise ValueError('지원하지 않는 프리셋 작업입니다.')

    current['revision'] += 1
    return current, True
