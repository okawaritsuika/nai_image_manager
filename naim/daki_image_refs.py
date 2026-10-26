"""Allowlisted daki image references for gallery read operations only."""
import re
from pathlib import Path

from naim.images.webp_conversion import resolve_webp_image
from naim.storage.daki_projects import DakiNotFoundError


PROJECT_EXPORT_PREFIX = '__daki_exports__'
_PREFIXES = ('__daki_shared__', '__daki_tests__', '__daki_personal__', '__daki_drafts__',
             PROJECT_EXPORT_PREFIX)
_SHARED = re.compile(r'__daki_shared__/([A-Za-z0-9_-]{1,128})\.png\Z')
_TEST = re.compile(r'__daki_tests__/([a-f0-9]{32})/([A-Za-z0-9_-]{1,128})\.png\Z')
_PERSONAL = re.compile(r'__daki_personal__/(personal_[a-f0-9]{32})\.png\Z')
_DRAFT = re.compile(r'__daki_drafts__/([a-f0-9]{32})\.png\Z')
_EXPORT = re.compile(
    re.escape(PROJECT_EXPORT_PREFIX) + r'/([a-f0-9]{32})/([a-f0-9]{32})\.(?:png|webp)\Z'
)


def is_daki_image_reference(relative):
    return isinstance(relative, str) and relative.lower().startswith(_PREFIXES)


def parse_daki_image_reference(relative):
    """Return a known reference shape; reserved malformed paths never fall back."""
    if not is_daki_image_reference(relative):
        return None
    shared = _SHARED.fullmatch(relative)
    if shared:
        return ('shared', shared[1])
    personal = _PERSONAL.fullmatch(relative)
    if personal:
        return ('personal', personal[1])
    draft = _DRAFT.fullmatch(relative)
    if draft:
        return ('draft', draft[1])
    export = _EXPORT.fullmatch(relative)
    if export:
        return ('export', export[1], export[2])
    generated = _TEST.fullmatch(relative)
    if generated:
        return ('test', generated[1], generated[2])
    raise ValueError('공유 그림체 이미지 경로가 올바르지 않습니다.')


def resolve_daki_image_reference(relative, manager, draft_manager=None, project_exports_root=None):
    reference = parse_daki_image_reference(relative)
    if reference is None:
        return None
    canonical_relative = relative
    try:
        if reference[0] == 'shared':
            path = manager.catalog.preview_path(reference[1], full=True)
        elif reference[0] == 'personal':
            if manager.personal_catalog is None:
                raise FileNotFoundError('개인 그림체를 찾을 수 없습니다.')
            path = manager.personal_catalog.preview_path(reference[1], full=True)
        elif reference[0] == 'draft':
            if draft_manager is None:
                raise FileNotFoundError('생성한 시안의 저장 위치를 찾을 수 없습니다.')
            path = draft_manager.image_path(reference[1], full=True)
        elif reference[0] == 'export':
            if project_exports_root is None:
                raise FileNotFoundError('프로젝트 통합 이미지의 저장 위치를 찾을 수 없습니다.')
            from naim.images.canvas_export import project_export_image_path
            root = Path(project_exports_root).resolve()
            source = Path(project_export_image_path(root, reference[1], reference[2]))
            if relative.endswith('.webp'):
                requested_webp = source.with_suffix('.webp')
                path = resolve_webp_image(requested_webp)
                if Path(path).absolute() != requested_webp.absolute():
                    raise FileNotFoundError('프로젝트 통합 WebP 이미지를 찾을 수 없습니다.')
            else:
                path = resolve_webp_image(source)
            path = Path(path).resolve()
            if not path.is_relative_to(root):
                raise ValueError('프로젝트 통합 이미지 경로가 올바르지 않습니다.')
            if not path.is_file():
                raise FileNotFoundError('프로젝트 통합 이미지를 찾을 수 없습니다.')
            suffix = path.suffix.lower()
            if suffix not in ('.png', '.webp'):
                raise ValueError('프로젝트 통합 이미지 형식이 올바르지 않습니다.')
            canonical_relative = f'{PROJECT_EXPORT_PREFIX}/{reference[1]}/{reference[2]}{suffix}'
        else:
            path = manager.image_path(reference[1], reference[2], full=True)
    except DakiNotFoundError as error:
        raise FileNotFoundError('공유 그림체 이미지를 찾을 수 없습니다.') from error
    return str(path), canonical_relative


def daki_image_prompt_fallback(relative, manager):
    """A catalog record supplies missing PNG metadata without changing the file."""
    reference = parse_daki_image_reference(relative)
    if reference is None or reference[0] not in ('shared', 'personal'):
        return {}
    catalog = manager.catalog if reference[0] == 'shared' else manager.personal_catalog
    if catalog is None:
        return {}
    style = catalog.get_style(reference[1])
    return {**style['options'], 'basePrompt': style['positive'],
            'negativePrompt': style['negative'], 'model': style['model'],
            'seed': style['seed']}
