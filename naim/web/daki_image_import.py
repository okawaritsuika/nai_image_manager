"""Inspect external images without writes, then save through project persistence."""
import io
import json

from flask import jsonify, request
from PIL import Image, ImageOps, UnidentifiedImageError

from naim.images.canvas_export import save_project_candidate_image
from naim.images.prompt_metadata import (
    has_prompt_info_text, normalize_prompt_info_for_sidecar, normalize_prompt_regions,
    PROMPT_REGION_LABELS,
)
from naim.storage.daki_projects import DakiNotFoundError


MAX_UPLOAD_BYTES = 64 * 1024 * 1024
MAX_IMAGE_PIXELS = 80_000_000


def register_daki_image_import_routes(app, store, export_root_provider, extract_prompt):
    """Inject the same metadata reader and permanent save path as canvas exports."""
    def read_image():
        upload = request.files.get('file')
        if upload is None:
            raise ValueError('가져올 그림을 선택해 주세요.')
        raw = upload.stream.read(MAX_UPLOAD_BYTES + 1)
        if not raw or len(raw) > MAX_UPLOAD_BYTES:
            raise ValueError('비어 있지 않은 64MB 이하 그림을 선택해 주세요.')
        try:
            with Image.open(io.BytesIO(raw)) as source:
                if source.format not in ('PNG', 'JPEG', 'WEBP'):
                    raise ValueError('PNG, JPG, WebP 그림만 가져올 수 있습니다.')
                if source.width * source.height > MAX_IMAGE_PIXELS:
                    raise ValueError('그림은 8천만 픽셀 이하여야 합니다.')
                source.verify()
            with Image.open(io.BytesIO(raw)) as source:
                image = ImageOps.exif_transpose(source).convert('RGBA')
        except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError) as error:
            raise ValueError('그림 파일을 읽을 수 없습니다. 다른 파일을 선택해 주세요.') from error
        try:
            # Extraction errors must not prevent an ordinary image import.
            prompt = extract_prompt(type('ImportFile', (), {'stream': io.BytesIO(raw)})())
            prompt = normalize_prompt_info_for_sidecar(prompt)
        except Exception:
            prompt = {}
        return image, prompt

    def edited_prompt(extracted):
        text = request.form.get('promptInfo')
        if text is None:
            return extracted
        if len(text) > 200_000:
            raise ValueError('프롬프트가 너무 깁니다.')
        try:
            value = json.loads(text)
        except (ValueError, TypeError) as error:
            raise ValueError('프롬프트 형식이 올바르지 않습니다.') from error
        if not isinstance(value, dict):
            raise ValueError('프롬프트는 객체 형식이어야 합니다.')
        for key in ('basePrompt', 'negativePrompt'):
            if key in value and (not isinstance(value[key], str) or len(value[key]) > 30000):
                raise ValueError('프롬프트는 3만 자 이하의 글이어야 합니다.')
        chars = value.get('charPrompts', [])
        if (not isinstance(chars, list) or len(chars) > 22
                or any(not isinstance(item, str) or len(item) > 30000 for item in chars)):
            raise ValueError('캐릭터 프롬프트는 3만 자 이하로 최대 22개 입력할 수 있습니다.')
        regions = normalize_prompt_regions(value.get('promptRegions', []))
        # Regional entries are annotations AND usable positive prompt text.
        base = value.get('basePrompt', '').strip()
        for item in regions:
            if 'characterIndex' in item:
                if item['characterIndex'] >= len(chars):
                    raise ValueError('캐릭터가 바뀌었습니다. 부위를 다시 분류해 주세요.')
                # Character annotations describe existing text, never duplicate it in Base.
                continue
            if item['prompt'] not in base:
                base = ', '.join(part for part in (base, item['prompt']) if part)
        if len(base) > 30000:
            raise ValueError('부위별 문구를 포함한 전체 프롬프트는 3만 자 이하여야 합니다.')
        negative = value.get('negativePrompt', '')
        value.update(basePrompt=base, baseCaption=base, prompt=base, base_prompt=base,
                     charPrompt=', '.join(chars), negativePrompt=negative,
                     negative_prompt=negative, uc=negative)
        return normalize_prompt_info_for_sidecar(value)

    def handle(save, project_id=None):
        try:
            side = request.form.get('side')
            if save:
                store.get_project(project_id)
                if side not in ('front', 'back'):
                    raise ValueError('앞면 또는 뒷면을 선택해 주세요.')
            image, extracted = read_image()
            try:
                if not save:
                    return jsonify(status='success', width=image.width, height=image.height,
                                   promptInfo=extracted, hasPromptInfo=has_prompt_info_text(extracted),
                                   regions=[{'id': key, 'label': label}
                                            for key, label in PROMPT_REGION_LABELS.items()])
                result = save_project_candidate_image(
                    store, export_root_provider(), project_id, side, image, edited_prompt(extracted),
                    source_label='NAI Image Manager Project Import',
                )
                return jsonify(result)
            finally:
                image.close()
        except (DakiNotFoundError, FileNotFoundError):
            return jsonify(status='error', message='프로젝트를 찾을 수 없습니다.'), 404
        except (ValueError, TypeError) as error:
            return jsonify(status='error', message=str(error)), 400
        except OSError:
            return jsonify(status='error', message='그림을 저장하지 못했습니다. 다시 시도해 주세요.'), 500

    @app.route('/api/daki/image-import/inspect', methods=['POST'])
    def daki_image_import_inspect():
        return handle(False)

    @app.route('/api/daki/projects/<project_id>/image-import', methods=['POST'])
    def daki_image_import_save(project_id):
        return handle(True, project_id)
