"""Metadata-only dimensions for large PNG and WebP project images."""
import builtins
from pathlib import Path
import struct
import tempfile
import unittest
from unittest import mock
import zlib

from PIL import Image, PngImagePlugin, WebPImagePlugin

from naim.images import dimensions
from naim.images.previews import get_display_oriented_image_size


def _png_chunk(kind, data):
    checksum = zlib.crc32(data, zlib.crc32(kind)) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", checksum)


def _png_chunks(data):
    chunks = []
    position = 8
    while position < len(data):
        length = struct.unpack(">I", data[position:position + 4])[0]
        end = position + 12 + length
        chunks.append((data[position + 4:position + 8], data[position + 8:position + 8 + length]))
        position = end
    return chunks


def _webp_chunk(kind, data):
    return kind + struct.pack("<I", len(data)) + data + (b"\0" if len(data) & 1 else b"")


def _webp_file(chunks):
    body = b"WEBP" + b"".join(chunks)
    return b"RIFF" + struct.pack("<I", len(body)) + body


def _vp8l_header(width, height):
    width -= 1
    height -= 1
    return bytes((
        0x2F,
        width & 0xFF,
        ((width >> 8) & 0x3F) | ((height & 0x03) << 6),
        (height >> 2) & 0xFF,
        (height >> 10) & 0x0F,
    ))


class _CountingReader:
    def __init__(self, wrapped):
        self.wrapped = wrapped
        self.bytes_read = 0

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.wrapped.close()

    def read(self, count=-1):
        result = self.wrapped.read(count)
        self.bytes_read += len(result)
        return result

    def seek(self, *args):
        return self.wrapped.seek(*args)

    def tell(self):
        return self.wrapped.tell()


class ImageDimensionsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def make_image(self, name, image_format, *, size=(31, 17), mode="RGB", **options):
        path = self.root / name
        Image.new(mode, size, "red").save(path, format=image_format, **options)
        return path

    def existing_dimensions(self, path):
        with Image.open(path) as image:
            return get_display_oriented_image_size(image)

    def assert_matches_pillow(self, path):
        before = path.read_bytes()
        self.assertEqual(dimensions.get_display_image_dimensions(path), self.existing_dimensions(path))
        self.assertEqual(path.read_bytes(), before)

    def test_png_rgb_rgba_and_jpeg_fallback_dimensions(self):
        rgb = self.make_image("rgb.png", "PNG")
        rgba = self.make_image("alpha.png", "PNG", mode="RGBA", size=(20, 10))
        exif = Image.Exif()
        exif[274] = 6
        jpeg = self.make_image("rotated.jpg", "JPEG", size=(20, 10), exif=exif)

        self.assert_matches_pillow(rgb)
        self.assert_matches_pillow(rgba)
        self.assert_matches_pillow(jpeg)
        self.assertEqual(dimensions.get_display_image_dimensions(jpeg), (10, 20))

    def test_actual_format_takes_precedence_over_legacy_extension(self):
        for name, format in (('webp-in-png.png', 'WEBP'), ('jpeg-in-png.png', 'JPEG'), ('png-in-webp.webp', 'PNG')):
            with self.subTest(format=format):
                path = self.make_image(name, format, size=(19, 37))
                self.assert_matches_pillow(path)

    def test_png_exif_orientations_are_read_even_after_idat(self):
        base = self.make_image("base.png", "PNG", size=(29, 13)).read_bytes()
        chunks = _png_chunks(base)
        for orientation in range(1, 9):
            with self.subTest(orientation=orientation):
                exif = Image.Exif()
                exif[274] = orientation
                # PNG eXIf stores the TIFF stream; placing it before IEND
                # exercises metadata that follows the compressed image data.
                metadata = _png_chunk(b"eXIf", exif.tobytes()[6:])
                output = bytearray(base[:8])
                for kind, data in chunks:
                    if kind == b"IEND":
                        output.extend(metadata)
                    output.extend(_png_chunk(kind, data))
                path = self.root / f"orientation-{orientation}.png"
                path.write_bytes(output)
                self.assert_matches_pillow(path)
                expected = (13, 29) if orientation in (5, 6, 7, 8) else (29, 13)
                self.assertEqual(dimensions.get_display_image_dimensions(path), expected)

    def test_invalid_png_exif_falls_back_to_unrotated_dimensions(self):
        base = self.make_image("base.png", "PNG", size=(29, 13)).read_bytes()
        chunks = _png_chunks(base)
        output = bytearray(base[:8])
        for kind, data in chunks:
            if kind == b"IEND":
                output.extend(_png_chunk(b"eXIf", b"not a TIFF stream"))
            output.extend(_png_chunk(kind, data))
        path = self.root / "bad-exif.png"
        path.write_bytes(output)
        self.assertEqual(dimensions.get_display_image_dimensions(path), (29, 13))

    def test_lossy_lossless_and_exif_rotated_webp(self):
        exif = Image.Exif()
        exif[274] = 6
        cases = (
            ("lossy.webp", {"lossless": False}, (31, 17)),
            ("lossless.webp", {"lossless": True}, (31, 17)),
            ("rotated.webp", {"lossless": True, "exif": exif}, (17, 31)),
        )
        for name, options, expected in cases:
            with self.subTest(name=name):
                path = self.make_image(name, "WEBP", **options)
                self.assert_matches_pillow(path)
                self.assertEqual(dimensions.get_display_image_dimensions(path), expected)

    def test_animated_webp_uses_canvas_dimensions(self):
        first = Image.new("RGB", (34, 22), "red")
        second = Image.new("RGB", (34, 22), "blue")
        path = self.root / "animated.webp"
        try:
            first.save(path, format="WEBP", save_all=True, append_images=[second], duration=50, loop=0)
        except (OSError, RuntimeError, ValueError) as error:
            self.skipTest(f"Pillow WebP animation encoder unavailable: {error}")
        self.assert_matches_pillow(path)
        self.assertEqual(dimensions.get_display_image_dimensions(path), (34, 22))

    def test_corrupt_and_truncated_png_headers_are_rejected(self):
        valid = self.make_image("valid.png", "PNG", size=(12, 7)).read_bytes()
        ihdr_start = 8
        ihdr_length = struct.unpack(">I", valid[ihdr_start:ihdr_start + 4])[0]
        ihdr_end = ihdr_start + 8 + ihdr_length

        zero_width = bytearray(valid)
        zero_width[ihdr_start + 8:ihdr_start + 12] = b"\0\0\0\0"
        zero_width[ihdr_end:ihdr_end + 4] = struct.pack(
            ">I", zlib.crc32(zero_width[ihdr_start + 8:ihdr_end], zlib.crc32(b"IHDR")) & 0xFFFFFFFF
        )
        bad_crc = bytearray(valid)
        bad_crc[ihdr_end + 3] ^= 1
        truncated = valid[:-3]
        oversized_chunk = bytearray(valid)
        first_chunk_after_ihdr = ihdr_end + 4
        oversized_chunk[first_chunk_after_ihdr:first_chunk_after_ihdr + 4] = struct.pack(">I", 0x7FFFFFFF)

        for name, raw in (("zero-width.png", zero_width), ("bad-crc.png", bad_crc),
                          ("truncated.png", truncated), ("oversized.png", oversized_chunk)):
            with self.subTest(name=name):
                path = self.root / name
                path.write_bytes(raw)
                with self.assertRaises(ValueError):
                    dimensions.get_display_image_dimensions(path)

    def test_corrupt_and_truncated_webp_headers_are_rejected(self):
        valid = _webp_file([_webp_chunk(b"VP8L", _vp8l_header(12, 7) + b"\0")])
        bad_signature = _webp_file([_webp_chunk(b"VP8L", b"\x00\0\0\0\0\0")])
        truncated = valid[:-2]
        overrun = bytearray(valid)
        overrun[16:20] = struct.pack("<I", 1000)
        for name, raw in (("bad-signature.webp", bad_signature), ("truncated.webp", truncated),
                          ("overrun.webp", overrun)):
            with self.subTest(name=name):
                path = self.root / name
                path.write_bytes(raw)
                with self.assertRaises(ValueError):
                    dimensions.get_display_image_dimensions(path)

    def test_png_large_ancillary_payload_is_skipped_without_decoding(self):
        source = self.make_image("source.png", "PNG", size=(19, 11)).read_bytes()
        chunks = _png_chunks(source)
        large_length = 32 * 1024 * 1024
        payload_type = b"raNd"
        crc = zlib.crc32(payload_type)
        zeroes = bytes(64 * 1024)
        remaining = large_length
        while remaining:
            block = zeroes[:min(remaining, len(zeroes))]
            crc = zlib.crc32(block, crc)
            remaining -= len(block)
        path = self.root / "large-ancillary.png"
        with path.open("wb") as output:
            output.write(source[:8])
            output.write(_png_chunk(chunks[0][0], chunks[0][1]))
            output.write(struct.pack(">I", large_length) + payload_type)
            output.seek(large_length, 1)
            output.write(struct.pack(">I", crc & 0xFFFFFFFF))
            for kind, data in chunks[1:]:
                output.write(_png_chunk(kind, data))

        readers = []
        real_open = builtins.open

        def tracked_open(*args, **kwargs):
            reader = _CountingReader(real_open(*args, **kwargs))
            readers.append(reader)
            return reader

        with mock.patch("builtins.open", side_effect=tracked_open), \
                mock.patch.object(PngImagePlugin.PngImageFile, "load", side_effect=AssertionError("PNG pixels decoded")):
            self.assertEqual(dimensions.get_display_image_dimensions(path), (19, 11))
        self.assertLess(readers[0].bytes_read, 512)

    def test_webp_large_metadata_payload_is_skipped_without_decoding(self):
        width, height = 19, 11
        extended = bytes(4) + (width - 1).to_bytes(3, "little") + (height - 1).to_bytes(3, "little")
        large_length = 32 * 1024 * 1024
        image_header = _vp8l_header(width, height) + b"\0"
        riff_size = 4 + 18 + 8 + large_length + 8 + len(image_header)
        path = self.root / "large-metadata.webp"
        with path.open("wb") as output:
            output.write(b"RIFF" + struct.pack("<I", riff_size) + b"WEBP")
            output.write(_webp_chunk(b"VP8X", extended))
            output.write(b"XMP " + struct.pack("<I", large_length))
            output.seek(large_length, 1)
            output.write(_webp_chunk(b"VP8L", image_header))

        readers = []
        real_open = builtins.open

        def tracked_open(*args, **kwargs):
            reader = _CountingReader(real_open(*args, **kwargs))
            readers.append(reader)
            return reader

        with mock.patch("builtins.open", side_effect=tracked_open), \
                mock.patch.object(WebPImagePlugin.WebPImageFile, "_open", side_effect=AssertionError("WebP decoded")):
            self.assertEqual(dimensions.get_display_image_dimensions(path), (width, height))
        self.assertLess(readers[0].bytes_read, 512)


if __name__ == "__main__":
    unittest.main()
