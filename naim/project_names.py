"""Windows-safe names used for project canvases and source images."""
_INVALID_FILENAME_CHARS = frozenset('<>:"/\\|?*')
_RESERVED_DEVICE_NAMES = frozenset({
    'CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$',
    *(f'COM{number}' for number in range(1, 10)),
    *(f'LPT{number}' for number in range(1, 10)),
    *(f'COM{digit}' for digit in '¹²³'),
    *(f'LPT{digit}' for digit in '¹²³'),
})
_IMAGE_EXTENSIONS = frozenset(('.png', '.jpg', '.jpeg', '.webp'))
_SIDE_SUFFIXES = {'front': ' · 앞면 편집', 'back': ' · 뒷면 편집'}
MAX_CANVAS_NAME_UTF16_UNITS = 120


def utf16_length(value):
    """Return the number of UTF-16 code units in a string."""
    if not isinstance(value, str):
        raise ValueError('이름은 문자열이어야 합니다.')
    return len(value.encode('utf-16-le', errors='surrogatepass')) // 2


def _has_isolated_surrogate(value):
    index = 0
    while index < len(value):
        codepoint = ord(value[index])
        if 0xD800 <= codepoint <= 0xDBFF:
            if (index + 1 >= len(value)
                    or not 0xDC00 <= ord(value[index + 1]) <= 0xDFFF):
                return True
            index += 2
            continue
        if 0xDC00 <= codepoint <= 0xDFFF:
            return True
        index += 1
    return False


def _sanitize_image_stem(value):
    result = []
    index = 0
    while index < len(value):
        char = value[index]
        codepoint = ord(char)
        if 0xD800 <= codepoint <= 0xDBFF:
            if (index + 1 < len(value)
                    and 0xDC00 <= ord(value[index + 1]) <= 0xDFFF):
                result.extend((char, value[index + 1]))
                index += 2
                continue
            result.append('_')
        elif 0xDC00 <= codepoint <= 0xDFFF:
            result.append('_')
        elif char in _INVALID_FILENAME_CHARS or codepoint < 32:
            result.append('_')
        else:
            result.append(char)
        index += 1
    return ''.join(result)


def validate_windows_name(name, *, max_units=255):
    """Trim surrounding whitespace, then validate a Windows filename stem."""
    if not isinstance(name, str):
        raise ValueError('이름은 문자열이어야 합니다.')
    if isinstance(max_units, bool) or not isinstance(max_units, int) or max_units < 1:
        raise ValueError('이름 길이 제한이 올바르지 않습니다.')

    name = name.strip()
    if not name or name in ('.', '..'):
        raise ValueError('이름을 입력해 주세요.')
    if _has_isolated_surrogate(name):
        raise ValueError('짝이 맞지 않는 유니코드 대체 문자는 사용할 수 없습니다.')
    if any(char in _INVALID_FILENAME_CHARS or ord(char) < 32 for char in name):
        raise ValueError('이름에 파일명으로 사용할 수 없는 문자가 있습니다.')
    if name.endswith('.'):
        raise ValueError('이름은 마침표로 끝날 수 없습니다.')

    device_stem = name.split('.', 1)[0].rstrip(' .').upper()
    if device_stem in _RESERVED_DEVICE_NAMES:
        raise ValueError('Windows 예약 이름은 사용할 수 없습니다.')
    if utf16_length(name) > max_units:
        raise ValueError(f'이름은 UTF-16 기준 {max_units}자 이하여야 합니다.')
    return name


def _truncate_utf16(value, max_units):
    """Truncate without splitting a non-BMP character or explicit surrogate pair."""
    pieces = []
    units = 0
    index = 0
    while index < len(value):
        char = value[index]
        codepoint = ord(char)
        width = 2 if codepoint > 0xFFFF else 1
        piece = char
        if (0xD800 <= codepoint <= 0xDBFF and index + 1 < len(value)
                and 0xDC00 <= ord(value[index + 1]) <= 0xDFFF):
            piece += value[index + 1]
            width = 2
            index += 1
        if units + width > max_units:
            break
        pieces.append(piece)
        units += width
        index += 1
    return ''.join(pieces)


def readable_canvas_name(
        image_name, side, existing_names=(), *, max_units=MAX_CANVAS_NAME_UTF16_UNITS):
    """Build a readable, safe, unique canvas name from a source image name."""
    if not isinstance(image_name, str):
        raise ValueError('이미지명은 문자열이어야 합니다.')
    if side not in _SIDE_SUFFIXES:
        raise ValueError('앞면 또는 뒷면을 선택해 주세요.')
    if isinstance(max_units, bool) or not isinstance(max_units, int) or max_units < 1:
        raise ValueError('이름 길이 제한이 올바르지 않습니다.')

    filename = image_name.replace('\\', '/').rsplit('/', 1)[-1]
    stem, separator, extension = filename.rpartition('.')
    if not separator or f'.{extension}'.lower() not in _IMAGE_EXTENSIONS:
        stem = filename

    readable = _sanitize_image_stem(stem).strip().rstrip(' .')
    if not readable:
        readable = '캔버스'

    existing = {
        value.casefold() for value in existing_names if isinstance(value, str)
    }
    side_suffix = _SIDE_SUFFIXES[side]
    duplicate_index = 1
    while True:
        duplicate_suffix = '' if duplicate_index == 1 else f' {duplicate_index}'
        reserved_units = utf16_length(side_suffix + duplicate_suffix)
        if reserved_units >= max_units:
            raise ValueError('이름 길이 제한이 너무 짧습니다.')
        prefix = _truncate_utf16(readable, max_units - reserved_units).rstrip(' .')
        if not prefix:
            prefix = _truncate_utf16('캔버스', max_units - reserved_units).rstrip(' .')
        candidate = validate_windows_name(
            prefix + side_suffix + duplicate_suffix, max_units=max_units,
        )
        if candidate.casefold() not in existing:
            return candidate
        duplicate_index += 1
