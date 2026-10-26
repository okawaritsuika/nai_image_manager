"""Read display dimensions without decoding PNG or WebP pixel data."""
import struct
import zlib

from PIL import Image

from naim.images.previews import get_display_oriented_image_size


_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_WEBP_SIGNATURE = b"WEBP"
_MAX_EXIF_BYTES = 1024 * 1024


def _read_exact(stream, count, description):
    data = stream.read(count)
    if len(data) != count:
        raise ValueError(f"Truncated {description}")
    return data


def _file_size(stream):
    position = stream.tell()
    stream.seek(0, 2)
    size = stream.tell()
    stream.seek(position)
    return size


def _skip(stream, count, limit, description):
    position = stream.tell()
    if count < 0 or position + count > limit:
        raise ValueError(f"Invalid {description} boundary")
    stream.seek(count, 1)


def _orientation(exif_data):
    try:
        exif = Image.Exif()
        exif.load(exif_data)
        value = exif.get(274, 1)
        return value if value in range(1, 9) else 1
    except Exception:
        return 1


def _oriented_size(width, height, orientation):
    if orientation in (5, 6, 7, 8):
        return height, width
    return width, height


def _png_dimensions(stream):
    size = _file_size(stream)
    stream.seek(0)
    if _read_exact(stream, len(_PNG_SIGNATURE), "PNG signature") != _PNG_SIGNATURE:
        raise ValueError("Invalid PNG signature")

    width = height = None
    orientation = 1
    seen_ihdr = False
    seen_exif = False
    seen_idat = False
    first_chunk = True

    while stream.tell() < size:
        chunk_length, chunk_type = struct.unpack(">I4s", _read_exact(stream, 8, "PNG chunk header"))
        if not all(65 <= byte <= 90 or 97 <= byte <= 122 for byte in chunk_type):
            raise ValueError("Invalid PNG chunk type")
        if chunk_type[2] & 0x20:
            raise ValueError("Invalid PNG reserved chunk bit")
        if first_chunk and chunk_type != b"IHDR":
            raise ValueError("PNG IHDR must be the first chunk")
        first_chunk = False

        payload_start = stream.tell()
        if payload_start + chunk_length + 4 > size:
            raise ValueError("Invalid PNG chunk boundary")

        if chunk_type == b"IHDR":
            if seen_ihdr or chunk_length != 13:
                raise ValueError("Invalid PNG IHDR")
            ihdr = _read_exact(stream, 13, "PNG IHDR")
            crc = struct.unpack(">I", _read_exact(stream, 4, "PNG IHDR checksum"))[0]
            if zlib.crc32(ihdr, zlib.crc32(chunk_type)) & 0xFFFFFFFF != crc:
                raise ValueError("Invalid PNG IHDR checksum")
            width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(
                ">IIBBBBB", ihdr
            )
            valid_depths = {
                0: (1, 2, 4, 8, 16),
                2: (8, 16),
                3: (1, 2, 4, 8),
                4: (8, 16),
                6: (8, 16),
            }
            if (not 0 < width <= 0x7FFFFFFF or not 0 < height <= 0x7FFFFFFF
                    or bit_depth not in valid_depths.get(color_type, ())
                    or compression != 0 or filtering != 0 or interlace not in (0, 1)):
                raise ValueError("Invalid PNG image header")
            seen_ihdr = True
            continue

        if not seen_ihdr:
            raise ValueError("PNG image header is missing")

        if chunk_type == b"IEND":
            if chunk_length != 0:
                raise ValueError("Invalid PNG IEND")
            _read_exact(stream, 4, "PNG IEND checksum")
            if not seen_idat:
                raise ValueError("PNG image data is missing")
            return _oriented_size(width, height, orientation)

        if chunk_type == b"IDAT":
            seen_idat = seen_idat or chunk_length > 0

        if chunk_type == b"eXIf" and not seen_exif:
            seen_exif = True
            if chunk_length <= _MAX_EXIF_BYTES:
                exif_data = _read_exact(stream, chunk_length, "PNG EXIF data")
                crc = struct.unpack(">I", _read_exact(stream, 4, "PNG EXIF checksum"))[0]
                if zlib.crc32(exif_data, zlib.crc32(chunk_type)) & 0xFFFFFFFF == crc:
                    orientation = _orientation(exif_data)
                continue

        _skip(stream, chunk_length + 4, size, "PNG chunk")

    raise ValueError("PNG IEND is missing")


def _webp_dimensions(stream):
    file_size = _file_size(stream)
    stream.seek(0)
    header = _read_exact(stream, 12, "WebP RIFF header")
    if header[:4] != b"RIFF" or header[8:12] != _WEBP_SIGNATURE:
        raise ValueError("Invalid WebP RIFF header")
    riff_size = struct.unpack("<I", header[4:8])[0]
    riff_end = 8 + riff_size
    if riff_size < 4 or riff_end > file_size:
        raise ValueError("Invalid WebP RIFF boundary")

    canvas_size = None
    frame_size = None
    orientation = 1
    seen_exif = False
    first_chunk = True
    has_image_data = False

    while stream.tell() < riff_end:
        if riff_end - stream.tell() < 8:
            raise ValueError("Truncated WebP chunk header")
        chunk_type, chunk_length = struct.unpack("<4sI", _read_exact(stream, 8, "WebP chunk header"))
        padded_length = chunk_length + (chunk_length & 1)
        payload_start = stream.tell()
        if payload_start + padded_length > riff_end:
            raise ValueError("Invalid WebP chunk boundary")

        if chunk_type == b"VP8X":
            if not first_chunk or canvas_size is not None or chunk_length != 10:
                raise ValueError("Invalid WebP VP8X header")
            extended = _read_exact(stream, 10, "WebP VP8X header")
            canvas_size = (
                1 + int.from_bytes(extended[4:7], "little"),
                1 + int.from_bytes(extended[7:10], "little"),
            )
        elif chunk_type == b"VP8 ":
            if frame_size is not None or chunk_length < 10:
                raise ValueError("Invalid WebP VP8 frame header")
            frame = _read_exact(stream, 10, "WebP VP8 frame header")
            if frame[0] & 1 or frame[3:6] != b"\x9d\x01\x2a":
                raise ValueError("Invalid WebP VP8 frame signature")
            width = int.from_bytes(frame[6:8], "little") & 0x3FFF
            height = int.from_bytes(frame[8:10], "little") & 0x3FFF
            if not width or not height:
                raise ValueError("Invalid WebP VP8 dimensions")
            frame_size = (width, height)
            has_image_data = True
        elif chunk_type == b"VP8L":
            if frame_size is not None or chunk_length < 5:
                raise ValueError("Invalid WebP VP8L header")
            frame = _read_exact(stream, 5, "WebP VP8L header")
            if frame[0] != 0x2F or frame[4] & 0xE0:
                raise ValueError("Invalid WebP VP8L signature")
            width = 1 + frame[1] + ((frame[2] & 0x3F) << 8)
            height = 1 + (frame[2] >> 6) + (frame[3] << 2) + ((frame[4] & 0x0F) << 10)
            frame_size = (width, height)
            has_image_data = True
        elif chunk_type == b"ANMF":
            if chunk_length < 16:
                raise ValueError("Invalid WebP animation frame")
            has_image_data = True
        elif chunk_type == b"EXIF" and not seen_exif:
            seen_exif = True
            if chunk_length <= _MAX_EXIF_BYTES:
                orientation = _orientation(_read_exact(stream, chunk_length, "WebP EXIF data"))

        _skip(stream, padded_length - (stream.tell() - payload_start), riff_end, "WebP chunk")
        first_chunk = False

    if stream.tell() != riff_end:
        raise ValueError("Invalid WebP RIFF boundary")
    if not has_image_data:
        raise ValueError("WebP image data is missing")
    dimensions = canvas_size or frame_size
    if dimensions is None:
        raise ValueError("WebP dimensions are missing")
    return _oriented_size(*dimensions, orientation)


def get_display_image_dimensions(path):
    """Return display-oriented dimensions, reading only PNG/WebP headers.

    Other formats retain the existing Pillow-based orientation behavior. A
    malformed PNG or WebP raises ``ValueError`` instead of falling through to
    a decoder that might read the full image merely to obtain its dimensions.
    """
    with open(path, "rb") as stream:
        prefix = stream.read(12)
        stream.seek(0)
        if prefix.startswith(_PNG_SIGNATURE[:4]):
            return _png_dimensions(stream)
        if prefix[:4] == b"RIFF" and prefix[8:12] == _WEBP_SIGNATURE:
            return _webp_dimensions(stream)

    with Image.open(path) as image:
        return get_display_oriented_image_size(image)
