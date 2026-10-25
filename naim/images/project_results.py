"""Validation and persistence for images produced from Daki candidates."""
import os
import re
import tempfile

from PIL import Image

import upscale_logic
from naim.images.canvas_export import save_project_candidate_image
from naim.storage.daki_projects import DakiNotFoundError


_DAKI_ID_RE = re.compile(r'^[a-f0-9]{32}$')


def _validate_id(value, label):
    if not isinstance(value, str) or not _DAKI_ID_RE.fullmatch(value):
        raise ValueError(f'{label}가 올바르지 않습니다.')
    return value


def _canonical_path(path):
    return os.path.normcase(os.path.realpath(os.path.abspath(path)))


def validate_project_image_context(store, project_context, source_path):
    """Validate that the requested path is the selected candidate in a project."""
    if not isinstance(project_context, dict):
        raise ValueError('다키 프로젝트 이미지 정보가 올바르지 않습니다.')
    project_id = _validate_id(project_context.get('projectId'), '다키 프로젝트 ID')
    side = project_context.get('side')
    if side not in ('front', 'back'):
        raise ValueError('앞면 또는 뒷면을 선택해 주세요.')
    candidate_id = _validate_id(project_context.get('candidateId'), '다키 후보 ID')

    project = store.get_project(project_id)
    candidates_by_side = project.get('candidates')
    candidates = candidates_by_side.get(side) if isinstance(candidates_by_side, dict) else None
    if not isinstance(candidates, list):
        raise ValueError('저장된 다키 후보 목록이 올바르지 않습니다.')
    candidate = next((item for item in candidates
                      if isinstance(item, dict) and item.get('id') == candidate_id), None)
    if candidate is None:
        raise DakiNotFoundError('다키 프로젝트 후보를 찾을 수 없습니다.')

    candidate_path = candidate.get('path')
    candidate_full_path, candidate_relative_path = store.resolve_image(candidate_path)
    if not os.path.isfile(candidate_full_path):
        raise FileNotFoundError('후보의 원본 이미지를 찾을 수 없습니다.')
    if not isinstance(source_path, str) or not source_path.strip():
        raise ValueError('다키 후보 이미지 경로가 없습니다.')
    source_full_path, source_relative_path = store.resolve_image(source_path)
    if not os.path.isfile(source_full_path):
        raise FileNotFoundError('후보의 원본 이미지를 찾을 수 없습니다.')
    if _canonical_path(source_full_path) != _canonical_path(candidate_full_path):
        raise ValueError('요청한 이미지가 선택한 다키 후보와 일치하지 않습니다.')

    return {
        'projectContext': {
            'projectId': project_id,
            'side': side,
            'candidateId': candidate_id,
        },
        'projectName': project.get('name', ''),
        'side': side,
        'candidatePath': candidate_path,
        'sourceFullPath': candidate_full_path,
        'sourceRelativePath': candidate_relative_path or source_relative_path,
    }


def process_project_upscale_job(job, progress_callback, *, store, export_root,
                                prompt_info_loader, created_at, nai_api_key=None):
    """Upscale a project candidate in temporary storage, then add its result."""
    context = job.get('projectContext')
    source_path = job.get('source_path', '')
    validated = validate_project_image_context(store, context, source_path)
    cancel_event = job.get('_cancel_event')
    target_width = int(job.get('target_width') or 2500)
    target_height = int(job.get('target_height') or 8000)
    engine = str(job.get('engine') or 'realcugan').strip().lower()
    quality = str(job.get('quality') or 'standard').strip().lower()

    prompt_info = {}
    try:
        prompt_info = prompt_info_loader(validated['sourceFullPath']) or {}
    except Exception:
        prompt_info = {}

    with tempfile.TemporaryDirectory(prefix='naim_project_upscale_') as temp_dir:
        target_path = os.path.join(temp_dir, 'upscaled.png')
        result = upscale_logic.run_upscale(
            source_path=validated['sourceFullPath'],
            target_path=target_path,
            target_width=target_width,
            target_height=target_height,
            engine=engine,
            quality=quality,
            progress_callback=progress_callback,
            cancel_event=cancel_event,
            **({'nai_api_key': nai_api_key} if engine == 'nai' else {}),
            **({'fit_5_16': True} if job.get('fit_5_16') is True and engine != 'nai' else {}),
        )
        if cancel_event and cancel_event.is_set():
            raise upscale_logic.UpscaleCancelled()

        # The candidate may have been removed while the engine was running.
        validated = validate_project_image_context(store, context, source_path)
        upscale_info = {
            'engine': engine,
            'quality': quality,
            'target_width': target_width,
            'target_height': target_height,
            'source_path': validated['sourceRelativePath'],
            'created_at': created_at(),
            'result': result,
        }
        with Image.open(target_path) as output_image:
            output_image.load()
            with output_image.convert('RGBA') as rgba_image:
                saved = save_project_candidate_image(
                    store,
                    export_root,
                    context['projectId'],
                    validated['side'],
                    rgba_image,
                    prompt_info,
                    source_label='NAI Image Manager Daki Project Upscale',
                    sidecar_extra={'upscale': upscale_info},
                )

    return {
        'result_path': saved['path'],
        'result_src': saved['src'],
        'destination': 'project',
        'projectName': saved['projectName'],
        'side': saved['side'],
        'projectContext': validated['projectContext'],
        'embedded_metadata_saved': saved['embedded_metadata_saved'],
        'sidecar_saved': saved['sidecar_saved'],
    }
