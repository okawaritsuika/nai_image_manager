"""Center-crop planning and a single, explicitly requested NovelAI upscale."""
import base64
import io
import json
import os
import tempfile
import urllib.error
import urllib.request
import zipfile

from PIL import Image

from naim.processes import UpscaleCancelled


# Official studio client/API checked 2026-10-24: /ai/upscale, curated V5,
# sigma 0, 2x sides; the studio disables upscale above STABLE_DIFFUSION_MAX_SIZE.
NAI_UPSCALE_MAX_PIXELS = 3145728
NAI_UPSCALE_MODEL = 'nai-diffusion-5-curated'
MAX_RESPONSE_BYTES = 64 * 1024 * 1024


def plan_nai_upscale(width, height):
    if type(width) is not int or type(height) is not int or width <= 0 or height <= 0:
        raise ValueError('원본 이미지의 가로·세로 크기를 확인해 주세요.')
    if width * height > 130000000:
        raise ValueError('NAI 맞춤에 사용할 원본은 130MP 이하여야 합니다.')
    unit = min(width // 5, height // 16)
    crop_width, crop_height = unit * 5, unit * 16
    # Both dimensions must be multiples of 64 AND exactly 5:16.
    step = min(crop_width // 320, crop_height // 1024, 3)
    if step < 1:
        raise ValueError('5:16으로 자른 영역이 최소 320 × 1024px이어야 합니다.')
    input_width, input_height = 320 * step, 1024 * step
    left, top = (width - crop_width) // 2, (height - crop_height) // 2
    return {
        'source_width': width, 'source_height': height,
        'crop_width': crop_width, 'crop_height': crop_height,
        'crop_box': [left, top, left + crop_width, top + crop_height],
        'cropped': (crop_width, crop_height) != (width, height),
        'resized': (crop_width, crop_height) != (input_width, input_height),
        'input_width': input_width, 'input_height': input_height,
        'output_width': input_width * 2, 'output_height': input_height * 2,
    }


def _check_cancel(event):
    if event is not None and event.is_set():
        raise UpscaleCancelled()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def request_nai_upscale(api_key, image_bytes, expected_size):
    """Never retry a paid request or send credentials through redirects."""
    if not isinstance(api_key, str) or not api_key.strip():
        raise ValueError('설정에서 NovelAI API 키를 등록해 주세요.')
    payload = {'image': base64.b64encode(image_bytes).decode('ascii'),
               'model': NAI_UPSCALE_MODEL, 'declared_blur_sigma': 0}
    request = urllib.request.Request(
        'https://image.novelai.net/ai/upscale',
        data=json.dumps(payload).encode('utf-8'), method='POST',
        headers={'Authorization': 'Bearer ' + api_key.strip(),
                 'Content-Type': 'application/json', 'Accept': 'application/zip',
                 'User-Agent': 'Mozilla/5.0'},
    )
    try:
        with urllib.request.build_opener(_NoRedirect()).open(request, timeout=180) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        code = error.code
        error.close()
        messages = {400: 'NAI가 입력 이미지나 크기를 거부했습니다.',
                    401: 'NovelAI API 키 인증에 실패했습니다.',
                    402: 'NovelAI Anlas 잔액이 부족합니다.',
                    403: 'NovelAI 업스케일 요청이 허용되지 않았습니다.',
                    429: 'NovelAI 요청이 많습니다. 잠시 후 다시 시도해 주세요.'}
        raise ValueError(messages.get(code, f'NAI 업스케일 요청에 실패했습니다. (HTTP {code})')) from None
    except (OSError, urllib.error.URLError, UnicodeError, ValueError):
        raise ValueError('NAI 연결에 실패했습니다. 중복 과금을 막기 위해 자동으로 재시도하지 않습니다.') from None
    if len(raw) > MAX_RESPONSE_BYTES:
        raise ValueError('NAI 업스케일 응답이 너무 큽니다.')
    try:
        if raw.startswith(b'PK'):
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                entries = [entry for entry in archive.infolist()
                           if entry.filename.lower().endswith(('.png', '.webp'))]
                if len(entries) != 1 or entries[0].file_size > MAX_RESPONSE_BYTES:
                    raise ValueError()
                raw = archive.read(entries[0])
        elif raw.lstrip().startswith((b'{', b'[')):
            data = json.loads(raw)
            items = data.get('images') if isinstance(data, dict) else data
            if not isinstance(items, list) or len(items) != 1:
                raise ValueError()
            item = items[0]
            raw = base64.b64decode(item.get('image') if isinstance(item, dict) else item, validate=True)
        with Image.open(io.BytesIO(raw)) as source:
            if source.size != expected_size:
                raise ValueError()
            return source.convert('RGBA')
    except (ValueError, TypeError, KeyError, OSError, zipfile.BadZipFile):
        raise ValueError('NAI 업스케일 응답의 이미지 형식 또는 크기가 예상과 다릅니다.') from None


def run_nai_upscale(source_path, target_path, target_width, target_height, *,
                    api_key, progress_callback=None, cancel_event=None):
    _check_cancel(cancel_event)
    if os.path.normcase(os.path.realpath(source_path)) == os.path.normcase(os.path.realpath(target_path)):
        raise ValueError('업스케일 결과는 원본과 다른 파일로 저장해야 합니다.')
    with Image.open(source_path) as source:
        plan = plan_nai_upscale(*source.size)
        expected_size = (plan['output_width'], plan['output_height'])
        if expected_size != (target_width, target_height):
            raise ValueError('원본 크기가 바뀌었습니다. 업스케일 창에서 NAI 맞춤 크기를 다시 확인해 주세요.')
        with source.crop(plan['crop_box']).convert('RGBA') as cropped:
            prepared = cropped.resize((plan['input_width'], plan['input_height']), Image.Resampling.LANCZOS)
    try:
        if progress_callback:
            progress_callback(15, f"가운데 맞춤 완료: {plan['input_width']} × {plan['input_height']}px")
        background = Image.new('RGBA', prepared.size, 'white')
        try:
            background.alpha_composite(prepared)
            buffer = io.BytesIO()
            with background.convert('RGB') as rgb:
                rgb.save(buffer, 'PNG')
        finally:
            background.close()
        _check_cancel(cancel_event)
        if progress_callback:
            progress_callback(25, 'NovelAI 업스케일 요청 중… 전송한 요청은 자동 재시도하지 않습니다.')
        result = request_nai_upscale(api_key, buffer.getvalue(), expected_size)
        try:
            _check_cancel(cancel_event)
            with prepared.getchannel('A') as alpha:
                with alpha.resize(expected_size, Image.Resampling.LANCZOS) as output_alpha:
                    result.putalpha(output_alpha)
            directory = os.path.dirname(os.path.abspath(target_path))
            fd, staging = tempfile.mkstemp(prefix='.nai-upscale-', suffix='.png', dir=directory)
            os.close(fd)
            try:
                result.save(staging, 'PNG')
                _check_cancel(cancel_event)
                os.replace(staging, target_path)
            finally:
                if os.path.exists(staging):
                    os.unlink(staging)
        finally:
            result.close()
    finally:
        prepared.close()
    return {'engine': 'nai', 'quality': 'standard', 'stages': [{'scale': 2}],
            'final_width': target_width, 'final_height': target_height, 'nai_plan': plan}
