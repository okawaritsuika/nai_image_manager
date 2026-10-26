"""Persistence for merged images exported from project-linked canvases."""
import json
import os
from pathlib import Path
import re
import shutil
import uuid

from PIL import Image

from naim.daki_image_refs import PROJECT_EXPORT_PREFIX
from naim.images.prompt_metadata import (
    get_prompt_sidecar_path,
    has_prompt_info_payload,
    normalize_prompt_info_for_sidecar,
    save_png_with_prompt_metadata,
    save_prompt_sidecar,
)
from naim.storage.json_files import write_json


_EXPORT_ID_RE = re.compile(r'^[a-f0-9]{32}$')


def _validate_export_id(value, label):
    if not isinstance(value, str) or not _EXPORT_ID_RE.fullmatch(value):
        raise ValueError(f'{label}가 올바르지 않습니다.')
    return value


def project_export_image_path(export_root, project_id, export_id):
    """Return an allowlisted export path, rejecting symlink/path escapes."""
    project_id = _validate_export_id(project_id, '다키 프로젝트 ID')
    export_id = _validate_export_id(export_id, '통합 이미지 ID')
    root = Path(export_root).resolve(strict=False)
    target = (root / project_id / f'{export_id}.png').resolve(strict=False)
    try:
        target.relative_to(root)
    except ValueError as error:
        raise ValueError('프로젝트 통합 이미지 경로가 올바르지 않습니다.') from error
    return str(target)


def _reserve_file(path):
    return os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)


def _remove_owned_file(path, owned):
    if not owned:
        return
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


def _validate_project_side(side):
    if side not in ('front', 'back'):
        raise ValueError('앞면 또는 뒷면을 선택해 주세요.')
    return side


def save_project_candidate_image(store, export_root, project_id, side, image, prompt_info,
                                 *, source_label='NAI Image Manager Project Result',
                                 sidecar_extra=None, canvas_id=None):
    """Save a unique project image and link it as a candidate on one side."""
    project_id = _validate_export_id(project_id, '다키 프로젝트 ID')
    side = _validate_project_side(side)
    store.get_project(project_id)

    normalized_prompt = normalize_prompt_info_for_sidecar(prompt_info)
    wants_sidecar = has_prompt_info_payload(normalized_prompt)
    if sidecar_extra is not None and not isinstance(sidecar_extra, dict):
        raise ValueError('추가 이미지 메타데이터 형식이 올바르지 않습니다.')
    extra_sidecar = dict(sidecar_extra or {})
    wants_sidecar_file = wants_sidecar or bool(extra_sidecar)
    root = Path(export_root)
    (root / project_id).mkdir(parents=True, exist_ok=True)

    # Exclusive file creation prevents an existing export from ever being
    # overwritten and gives rollback ownership only over files created here.
    while True:
        export_id = uuid.uuid4().hex
        image_path = Path(project_export_image_path(root, project_id, export_id))
        sidecar_path = Path(get_prompt_sidecar_path(str(image_path)))
        if sidecar_path.exists():
            continue
        try:
            image_descriptor = _reserve_file(image_path)
        except FileExistsError:
            continue

        image_owned = True
        sidecar_owned = False
        try:
            os.close(image_descriptor)
            if wants_sidecar_file:
                sidecar_descriptor = _reserve_file(sidecar_path)
                sidecar_owned = True
                with os.fdopen(sidecar_descriptor, 'w', encoding='utf-8') as reserved_sidecar:
                    reserved_sidecar.write('{}')
                    reserved_sidecar.flush()
                    os.fsync(reserved_sidecar.fileno())

            embedded_metadata_saved = save_png_with_prompt_metadata(
                image, str(image_path), normalized_prompt,
                source_label=source_label,
            )
            sidecar_saved = save_prompt_sidecar(str(image_path), normalized_prompt) if wants_sidecar else False
            if extra_sidecar:
                sidecar_data = dict(normalized_prompt)
                if sidecar_saved:
                    try:
                        with open(sidecar_path, 'r', encoding='utf-8') as sidecar_file:
                            sidecar_data = json.load(sidecar_file) or sidecar_data
                    except (OSError, ValueError):
                        pass
                sidecar_data.update(extra_sidecar)
                write_json(sidecar_path, sidecar_data, indent=2)
                sidecar_saved = True
            reference = f'{PROJECT_EXPORT_PREFIX}/{project_id}/{export_id}.png'
            if canvas_id is None:
                project = store.add_candidate(project_id, reference, side)
            else:
                project = store.add_candidate(project_id, reference, side, canvas_id=canvas_id)
            result = {
                'status': 'success',
                'destination': 'project',
                'path': reference,
                'src': '/image/' + reference,
                'projectId': project_id,
                'projectName': project['name'],
                'side': side,
                'embedded_metadata_saved': bool(embedded_metadata_saved),
                'sidecar_saved': bool(sidecar_saved),
            }
            if canvas_id is not None:
                candidate = next((item for item in project['candidates'][side]
                                  if item.get('path') == reference), None)
                if candidate and isinstance(candidate.get('name'), str):
                    result['name'] = candidate['name']
            return result
        except Exception:
            _remove_owned_file(image_path, image_owned)
            _remove_owned_file(sidecar_path, sidecar_owned)
            raise


def save_project_webp_candidate(store, export_root, project_id, side, source_path):
    """Copy a verified WebP into a unique project export and link it as a candidate."""
    project_id = _validate_export_id(project_id, '다키 프로젝트 ID')
    side = _validate_project_side(side)
    project = store.get_project(project_id)
    source = Path(source_path)
    if source.is_symlink() or not source.is_file():
        raise ValueError('저장할 WebP 파일이 올바르지 않습니다.')
    with Image.open(source) as image:
        if image.format != 'WEBP':
            raise ValueError('프로젝트 후보로 저장할 파일은 검증된 WebP여야 합니다.')
        image.verify()

    source_sidecars = []
    for suffix in ('.json', '.txt'):
        sidecar = source.with_suffix(suffix)
        if not os.path.lexists(sidecar):
            continue
        if sidecar.is_symlink() or not sidecar.is_file():
            raise ValueError('이미지 메타데이터 보조 파일은 일반 파일이어야 합니다.')
        source_sidecars.append(sidecar)

    root = Path(export_root)
    project_root = root / project_id
    project_root.mkdir(parents=True, exist_ok=True)
    while True:
        export_id = uuid.uuid4().hex
        image_path = Path(project_export_image_path(root, project_id, export_id))
        webp_path = image_path.with_suffix('.webp')
        json_path = image_path.with_suffix('.json')
        text_path = image_path.with_suffix('.txt')
        if any(os.path.lexists(path) for path in (image_path, webp_path, json_path, text_path)):
            continue
        try:
            webp_descriptor = _reserve_file(webp_path)
        except FileExistsError:
            continue

        owned = [webp_path]
        retry = False
        try:
            with os.fdopen(webp_descriptor, 'wb') as target_stream, open(source, 'rb') as source_stream:
                shutil.copyfileobj(source_stream, target_stream)
            with Image.open(webp_path) as copied_image:
                if copied_image.format != 'WEBP':
                    raise ValueError('복사된 프로젝트 WebP를 확인할 수 없습니다.')
                copied_image.verify()

            for source_sidecar in source_sidecars:
                target_sidecar = image_path.with_suffix(source_sidecar.suffix)
                try:
                    sidecar_descriptor = _reserve_file(target_sidecar)
                except FileExistsError:
                    retry = True
                    break
                owned.append(target_sidecar)
                with open(source_sidecar, 'rb') as source_stream, os.fdopen(sidecar_descriptor, 'wb') as target_stream:
                    shutil.copyfileobj(source_stream, target_stream)

            if retry:
                for path in owned:
                    _remove_owned_file(path, True)
                continue

            reference = f'{PROJECT_EXPORT_PREFIX}/{project_id}/{export_id}.webp'
            saved_project = store.add_candidate(project_id, reference, side)
            return {
                'status': 'success',
                'path': reference,
                'src': '/image/' + reference,
                'projectId': project_id,
                'projectName': saved_project.get('name', project.get('name', '')),
                'side': side,
                'destination': 'project',
            }
        except Exception:
            for path in owned:
                _remove_owned_file(path, True)
            raise


def save_project_canvas_export(store, export_root, project_id, canvas_id, image, prompt_info):
    """Save a canvas composite and link it as a candidate to that canvas side."""
    project_id = _validate_export_id(project_id, '다키 프로젝트 ID')
    canvas_id = _validate_export_id(canvas_id, '다키 캔버스 ID')

    # get_canvas is project-scoped, so it validates both IDs before any write.
    canvas = store.get_canvas(project_id, canvas_id)
    side = canvas.get('side')
    if side not in ('front', 'back'):
        raise ValueError('캔버스 앞면/뒷면 정보가 올바르지 않습니다.')
    return save_project_candidate_image(
        store, export_root, project_id, side, image, prompt_info,
        source_label='NAI Image Manager Canvas Export',
        canvas_id=canvas_id,
    )
