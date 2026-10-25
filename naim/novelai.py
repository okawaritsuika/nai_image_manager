"""NovelAI image transport; payloads and UI responses remain with callers."""
from contextlib import contextmanager
import base64
import io
import json
import secrets
import urllib.error
import urllib.request
import zipfile

from PIL import Image


@contextmanager
def generated_image_archive(api_key, payload):
    request = urllib.request.Request('https://image.novelai.net/ai/generate-image', method='POST')
    request.add_header('Authorization', f'Bearer {api_key}')
    request.add_header('Content-Type', 'application/json')
    request.add_header('User-Agent', 'Mozilla/5.0')
    with urllib.request.urlopen(request, data=json.dumps(payload).encode('utf-8')) as response:
        with zipfile.ZipFile(io.BytesIO(response.read())) as archive:
            yield archive


def generate_text_image(api_key, payload):
    """One explicit text-generation request, without paid-request retries.

    V5 uses the same multipart request part as the studio client. The older
    archive helper remains unchanged for existing inpainting callers.
    """
    if payload.get('action') != 'generate':
        raise ValueError('그림체 테스트는 일반 이미지 생성만 지원합니다.')
    body = json.dumps(payload).encode('utf-8')
    content_type = 'application/json'
    if str(payload.get('model', '')).startswith('nai-diffusion-5'):
        boundary = '----NAIMDaki' + secrets.token_hex(16)
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="request"; filename="blob"\r\n'
                'Content-Type: application/json\r\n\r\n').encode() + body + f'\r\n--{boundary}--\r\n'.encode()
        content_type = 'multipart/form-data; boundary=' + boundary
    request = urllib.request.Request(
        'https://image.novelai.net/ai/generate-image', data=body,
        headers={'Authorization': 'Bearer ' + api_key, 'Content-Type': content_type,
                 'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache'},
    )

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args):
            return None

    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=180) as response:
            raw = response.read(256 * 1024 * 1024 + 1)
        if len(raw) > 256 * 1024 * 1024:
            raise ValueError('NAI 이미지 응답이 너무 큽니다.')
    except urllib.error.HTTPError as error:
        # Response bodies can echo private prompts or credentials.
        raise ValueError(f'NAI HTTP {error.code}: 요청에 실패했습니다. 자동으로 재시도하지 않습니다.') from None
    except (OSError, urllib.error.URLError):
        raise ValueError('NAI 연결이 끊겼습니다. 중복 생성을 막기 위해 자동으로 재시도하지 않습니다.') from None
    if raw.startswith(b'PK'):
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            images = [item for item in archive.infolist() if item.filename.lower().endswith('.png')]
            if len(images) != 1 or images[0].file_size > 256 * 1024 * 1024:
                raise ValueError('NAI 이미지 응답 형식이 예상과 다릅니다.')
            raw = archive.read(images[0])
    elif raw[:1] == b'{':
        raw = base64.b64decode(json.loads(raw)['images'][0]['image'], validate=True)
    with Image.open(io.BytesIO(raw)) as source:
        if source.size != (payload['parameters']['width'], payload['parameters']['height']):
            raise ValueError('생성 결과의 크기가 요청한 크기와 다릅니다.')
        return source.convert('RGBA')
