"""Center a draft in a final canvas without changing its generation recipe."""
import json

from PIL import Image
from PIL.PngImagePlugin import PngInfo


# The original Daki print canvas is 5000 x 16000; generation limits do not
# apply to this local operation. Bound allocations separately from NovelAI.
FRAMING_LIMITS = {'min': 1, 'max': 16000, 'max_pixels': 80000000}


def normalize_framing(data):
    if not isinstance(data, dict):
        raise ValueError('최종 크기 설정은 JSON 객체여야 합니다.')
    result = {key: data.get(key) for key in ('width', 'height', 'mode')}
    for key in ('width', 'height'):
        value = result[key]
        if type(value) is not int or not FRAMING_LIMITS['min'] <= value <= FRAMING_LIMITS['max']:
            raise ValueError('최종 가로·세로는 1~16000 사이의 정수로 입력해 주세요.')
    if result['width'] * result['height'] > FRAMING_LIMITS['max_pixels']:
        raise ValueError('최종 크기는 8000만 픽셀 이내로 입력해 주세요.')
    if result['mode'] not in ('pad', 'cover'):
        raise ValueError('투명 여백 추가 또는 가운데 맞춰 자르기를 선택해 주세요.')
    return result


def frame_image(source, data):
    """Return a new RGBA image and layout; the caller owns the returned image."""
    layout = normalize_framing(data)
    width, height = layout['width'], layout['height']
    source_width, source_height = source.size
    layout.update(source_width=source_width, source_height=source_height)
    if layout['mode'] == 'pad' and (width < source_width or height < source_height):
        raise ValueError('투명 여백을 붙일 때는 최종 가로·세로가 원본보다 작을 수 없습니다.')
    rgba = source if source.mode == 'RGBA' else source.convert('RGBA')
    try:
        if layout['mode'] == 'pad':
            left, top = (width - source_width) // 2, (height - source_height) // 2
            result = Image.new('RGBA', (width, height), (0, 0, 0, 0))
            # No alpha mask: retain original RGB and alpha bytes, including
            # partly transparent pixels. Odd surplus pixels go right/bottom.
            result.paste(rgba, (left, top))
            layout.update(left=left, top=top, scale=1)
        else:
            scale = max(width / source_width, height / source_height)
            # Clamp floating-point roundoff at the source boundary; Pillow
            # rejects even a tiny negative crop coordinate.
            crop_width = min(source_width, width / scale)
            crop_height = min(source_height, height / scale)
            left, top = (source_width - crop_width) / 2, (source_height - crop_height) / 2
            box = (left, top, left + crop_width, top + crop_height)
            # Resample the centered source region directly: a very different
            # target aspect ratio must not allocate a huge intermediate image.
            result = rgba.resize((width, height), Image.Resampling.LANCZOS, box=box)
            layout.update(scale=scale, crop_box=list(box))
        return result, layout
    finally:
        if rgba is not source:
            rgba.close()


def framed_png_metadata(source, framing):
    """Keep PNG text and generation settings, updating actual output dimensions."""
    values = {key: value for key, value in source.info.items() if isinstance(value, str)}
    try:
        comment = json.loads(values.get('Comment', '{}'))
    except (ValueError, TypeError):
        raise ValueError('원본 시안의 생성 정보를 읽을 수 없습니다.') from None
    if not isinstance(comment, dict):
        raise ValueError('원본 시안의 생성 정보를 읽을 수 없습니다.')
    comment.update(width=framing['width'], height=framing['height'])
    values['Comment'] = json.dumps(comment, ensure_ascii=False)
    values['NAIM Framing'] = json.dumps(framing, ensure_ascii=False)
    metadata = PngInfo()
    for key, value in values.items():
        metadata.add_text(key, value)
    return metadata
