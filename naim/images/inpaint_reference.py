"""Pure image helpers for reference-strip inpainting requests."""
import io
import math
import re
from urllib.parse import unquote, urlsplit

from PIL import Image, ImageOps


_REFERENCE_PREFIX = "/canvas-imports/"
_SPLIT_SCREEN_TERM = re.compile(r"(?:^|,)\s*split screen\s*(?:,|$)", re.IGNORECASE)


def _invalid_reference(detail):
    raise ValueError(f"참고 이미지 설정이 올바르지 않습니다: {detail}")


def _validate_reference_src(src):
    if not isinstance(src, str):
        _invalid_reference("이미지 경로는 문자열이어야 합니다.")
    if len(src) > 4096:
        _invalid_reference("이미지 경로가 너무 깁니다.")
    if not src.startswith(_REFERENCE_PREFIX):
        _invalid_reference("캔버스 가져오기 이미지 경로만 사용할 수 있습니다.")

    try:
        parsed = urlsplit(src)
    except ValueError:
        _invalid_reference("이미지 경로 형식이 올바르지 않습니다.")
    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment or parsed.path != src:
        _invalid_reference("외부 주소, 쿼리 또는 프래그먼트는 사용할 수 없습니다.")

    relative_path = src[len(_REFERENCE_PREFIX):]
    if not relative_path:
        _invalid_reference("이미지 경로가 비어 있습니다.")

    # Decode repeatedly so nested encodings such as %252e%252e cannot hide traversal.
    while True:
        if "\\" in relative_path or relative_path.startswith("/"):
            _invalid_reference("이미지 경로에 역슬래시나 절대 경로를 사용할 수 없습니다.")
        if any(part == ".." for part in relative_path.split("/")):
            _invalid_reference("이미지 경로에 상위 폴더 이동을 사용할 수 없습니다.")
        decoded_path = unquote(relative_path)
        if decoded_path == relative_path:
            break
        relative_path = decoded_path


def _number(value, label, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _invalid_reference(f"{label} 값은 숫자여야 합니다.")
    if value < minimum or value > maximum:
        _invalid_reference(f"{label} 값의 범위가 올바르지 않습니다.")
    try:
        if not math.isfinite(value):
            _invalid_reference(f"{label} 값은 유한한 숫자여야 합니다.")
    except OverflowError:
        _invalid_reference(f"{label} 값의 범위가 올바르지 않습니다.")
    return float(value)


def normalize_reference(value):
    """Validate and detach a saved canvas-import reference descriptor."""
    if value is None:
        return None
    if not isinstance(value, dict):
        _invalid_reference("설정은 객체여야 합니다.")

    src = value.get("src")
    _validate_reference_src(src)

    name = value.get("name", "참고 이미지")
    if not isinstance(name, str):
        _invalid_reference("이름은 문자열이어야 합니다.")
    if len(name) > 500:
        _invalid_reference("이름은 500자 이하여야 합니다.")

    width = value.get("width", 320)
    if isinstance(width, bool) or not isinstance(width, int):
        _invalid_reference("참고 이미지 너비는 정수여야 합니다.")
    if width < 64 or width > 1024 or width % 64:
        _invalid_reference("참고 이미지 너비는 64~1024의 64 단위여야 합니다.")

    x = _number(value.get("x", 0.5), "가로 위치", 0, 1)
    y = _number(value.get("y", 0.5), "세로 위치", 0, 1)
    zoom = _number(value.get("zoom", 1), "확대", 1, 8)
    return {"src": src, "name": name, "width": width, "x": x, "y": y, "zoom": zoom}


def _positive_size(size, label):
    if not isinstance(size, (tuple, list)) or len(size) != 2:
        raise ValueError(f"{label} 크기는 너비와 높이로 지정해야 합니다.")
    width, height = size
    if (isinstance(width, bool) or not isinstance(width, int) or width <= 0 or
            isinstance(height, bool) or not isinstance(height, int) or height <= 0):
        raise ValueError(f"{label} 크기는 양의 정수여야 합니다.")
    return width, height


def reference_crop_box(source_size, target_size, reference):
    """Legacy crop helper retained for callers; reference rendering uses fitting."""
    source_width, source_height = _positive_size(source_size, "원본")
    target_width, target_height = _positive_size(target_size, "대상")
    scale = max(target_width / source_width, target_height / source_height) * reference["zoom"]
    crop_width = target_width / scale
    crop_height = target_height / scale
    left = min(max(reference["x"] * source_width - crop_width / 2, 0), source_width - crop_width)
    top = min(max(reference["y"] * source_height - crop_height / 2, 0), source_height - crop_height)
    return (float(left), float(top), float(left + crop_width), float(top + crop_height))


def reference_fit_box(source_size, target_size):
    """Fit the whole image in a centered box, shrinking only when necessary."""
    source_width, source_height = _positive_size(source_size, "원본")
    target_width, target_height = _positive_size(target_size, "대상")
    scale = min(1, target_width / source_width, target_height / source_height)
    width = max(1, math.floor(source_width * scale + 0.5))
    height = max(1, math.floor(source_height * scale + 0.5))
    return ((target_width - width) // 2, (target_height - height) // 2, width, height)


def _decode_image(data, label):
    try:
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            return image.copy()
    except (OSError, ValueError, TypeError) as exc:
        raise ValueError(f"{label} 이미지를 읽을 수 없습니다.") from exc


def _png_bytes(image):
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def prepare_reference_input(source_bytes, mask_bytes, reference_bytes, reference):
    """Build the combined reference + original image and its matching mask."""
    normalized_reference = normalize_reference(reference)
    if normalized_reference is None:
        _invalid_reference("참고 이미지 설정이 필요합니다.")

    source_image = _decode_image(source_bytes, "원본").convert("RGB")
    mask_image = _decode_image(mask_bytes, "마스크").convert("RGB")
    if source_image.size != mask_image.size:
        raise ValueError("원본 이미지와 마스크의 크기가 일치하지 않습니다.")

    try:
        with Image.open(io.BytesIO(reference_bytes)) as opened_reference:
            oriented_reference = ImageOps.exif_transpose(opened_reference)
            reference_rgba = oriented_reference.convert("RGBA")
    except (OSError, ValueError, TypeError) as exc:
        raise ValueError("참고 이미지를 읽을 수 없습니다.") from exc

    white_background = Image.new("RGBA", reference_rgba.size, (255, 255, 255, 255))
    reference_rgb = Image.alpha_composite(white_background, reference_rgba).convert("RGB")

    source_width, source_height = source_image.size
    reference_width = normalized_reference["width"]
    left, top, fitted_width, fitted_height = reference_fit_box(
        reference_rgb.size,
        (reference_width, source_height),
    )
    resized_reference = reference_rgb.resize(
        (fitted_width, fitted_height),
        Image.Resampling.LANCZOS,
    )

    combined_image = Image.new("RGB", (source_width + reference_width, source_height), "white")
    combined_image.paste(resized_reference, (left, top))
    combined_image.paste(source_image, (reference_width, 0))

    combined_mask = Image.new("RGB", combined_image.size, (0, 0, 0))
    combined_mask.paste(mask_image, (reference_width, 0))
    return {
        "image": _png_bytes(combined_image),
        "mask": _png_bytes(combined_mask),
        "width": source_width + reference_width,
        "height": source_height,
        "sourceWidth": source_width,
        "referenceWidth": reference_width,
    }


def crop_reference_result(generated_bytes, source_size, reference_width):
    """Remove the generated reference strip while requiring the exact API size."""
    source_width, source_height = _positive_size(source_size, "원본")
    if (isinstance(reference_width, bool) or not isinstance(reference_width, int) or
            reference_width <= 0):
        raise ValueError("참고 이미지 너비는 양의 정수여야 합니다.")
    generated_image = _decode_image(generated_bytes, "생성 결과").convert("RGB")
    expected_size = (source_width + reference_width, source_height)
    if generated_image.size != expected_size:
        raise ValueError("생성 결과 크기가 참고 이미지가 포함된 요청 크기와 일치하지 않습니다.")
    return _png_bytes(generated_image.crop((reference_width, 0, expected_size[0], source_height)))


def inject_split_screen(prompt):
    """Ensure a plain comma-delimited split-screen prompt term exists."""
    if _SPLIT_SCREEN_TERM.search(prompt):
        return prompt
    if not prompt.strip():
        return "split screen"
    return f"split screen, {prompt}"
