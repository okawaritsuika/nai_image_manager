"""PNG replacement safety and arbitrary metadata round trips, on synthetic data."""
from concurrent.futures import ThreadPoolExecutor
import io
import os
from pathlib import Path
import struct
import tempfile
import threading
import unittest
from unittest import mock
import zlib

from PIL import Image
from PIL.PngImagePlugin import PngInfo, iTXt

from naim.images import webp_conversion as conversion


def png_chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)


class WebPConversionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def make_png(self, name="synthetic.png", **options):
        path = self.root / name
        image = Image.new("RGBA", (32, 24))
        image.putdata([((x * 17) % 256, (x * 23) % 256, (x * 31) % 256, x % 256)
                       for x in range(32 * 24)])
        image.save(path, **options)
        return path

    def assert_preserved(self, source, original, result):
        self.assertEqual(result["status"], "skipped", result)
        self.assertEqual(source.read_bytes(), original)
        self.assertFalse(source.with_suffix(".webp").exists())
        self.assertEqual(list(self.root.glob(".naim-webp-*")), [])

    def test_lossless_preserves_all_pixels_chunks_languages_and_native_metadata(self):
        info = PngInfo()
        info.add_text("parameters", "synthetic prompt")
        info.add_text("Comment", '{"seed":42,"prompt":"synthetic"}', zip=True)
        info.add_itxt("Source", "합성 메타데이터", lang="ko", tkey="원본", zip=True)
        info.add_itxt("XML:com.adobe.xmp", '<x:xmpmeta xmlns:x="adobe:ns:meta/">synthetic</x:xmpmeta>')
        info.add(b"vpAg", b"unknown\0metadata", after_idat=True)
        exif = Image.Exif()
        exif[274] = 6
        exif[37510] = b"ASCII\0\0\0synthetic comment"
        path = self.make_png(pnginfo=info, exif=exif, icc_profile=b"synthetic ICC", dpi=(120, 240))
        # Duplicate and late text chunks must survive even if Pillow exposes
        # only the last duplicate in its info dictionary.
        raw = path.read_bytes()
        path.write_bytes(raw[:-12] + png_chunk(b"tEXt", b"parameters\0late synthetic value") + raw[-12:])
        original_chunks, _ = conversion._png_metadata(path)
        with Image.open(path) as source:
            source.load()
            original_info = dict(source.info)
            original_pixels = source.convert("RGBA").tobytes()
        source_stat = path.stat()
        result = conversion.convert_png_to_webp(path)
        self.assertEqual(result["status"], "converted", result)
        self.assertFalse(path.exists())
        target = path.with_suffix(".webp")
        self.assertEqual(result["source_bytes"], source_stat.st_size)
        self.assertEqual(result["target_bytes"], target.stat().st_size)
        self.assertEqual(target.stat().st_mtime_ns, source_stat.st_mtime_ns)
        if os.name == "nt":
            target_stat = target.stat()
            self.assertEqual(getattr(target_stat, 'st_birthtime_ns', target_stat.st_ctime_ns),
                             getattr(source_stat, 'st_birthtime_ns', source_stat.st_ctime_ns))
        with Image.open(target) as output:
            output.load()
            self.assertEqual(output.convert("RGBA").tobytes(), original_pixels)
            self.assertEqual(output.getexif()[274], 6)
            self.assertEqual(output.info["icc_profile"], b"synthetic ICC")
            self.assertEqual(output.info["xmp"], str(original_info["XML:com.adobe.xmp"]).encode("utf-8"))
            saved_info, saved_chunks = conversion._read_archive(output._decoder.get_chunk("NAIM"))
            self.assertEqual(saved_chunks, original_chunks)
            self.assertEqual(saved_info, original_info)
            conversion.restore_webp_metadata(output)
            for key, value in original_info.items():
                self.assertEqual(output.info[key], value)
            self.assertIsInstance(output.info["Source"], iTXt)
            self.assertEqual(output.info["Source"].lang, "ko")
            self.assertEqual(output.info["Source"].tkey, "원본")
            self.assertIn("xmp", output.info)
        self.assertEqual(list(self.root.glob(".naim-webp-*")), [])

    def test_lossy_preserves_alpha_stealth_bits_and_info(self):
        info = PngInfo()
        info.add_text("Comment", "synthetic metadata")
        path = self.make_png(pnginfo=info)
        with Image.open(path) as source:
            alpha = source.getchannel("A").tobytes()
        result = conversion.convert_png_to_webp(path, lossless=False, quality=35)
        self.assertEqual(result["status"], "converted", result)
        with Image.open(path.with_suffix(".webp")) as output:
            self.assertEqual(output.convert("RGBA").getchannel("A").tobytes(), alpha)
            conversion.restore_webp_metadata(output)
            self.assertEqual(output.info["Comment"], "synthetic metadata")

    def test_palette_transparency_roundtrip(self):
        path = self.root / "palette.png"
        image = Image.new("P", (8, 8))
        image.putpalette([value for index in range(256) for value in (index, 255 - index, index)])
        image.putdata(list(range(64)))
        image.save(path, transparency=bytes(range(256)))
        with Image.open(path) as source:
            pixels = source.convert("RGBA").tobytes()
        result = conversion.convert_png_to_webp(path)
        self.assertEqual(result["status"], "converted", result)
        with Image.open(path.with_suffix(".webp")) as output:
            self.assertEqual(output.convert("RGBA").tobytes(), pixels)
            conversion.restore_webp_metadata(output)
            self.assertNotIn("transparency", output.info)
            saved_info, _ = conversion._read_archive(output._decoder.get_chunk("NAIM"))
            self.assertEqual(saved_info["transparency"], bytes(range(256)))

    def test_metadata_restore_works_for_loaded_bytesio_and_is_idempotent(self):
        info = PngInfo()
        info.add_text("parameters", "synthetic")
        path = self.make_png(pnginfo=info)
        self.assertEqual(conversion.convert_png_to_webp(path)["status"], "converted")
        with Image.open(io.BytesIO(path.with_suffix(".webp").read_bytes())) as output:
            output.load()
            self.assertIs(conversion.restore_webp_metadata(output), output)
            self.assertEqual(output.info["parameters"], "synthetic")
            with mock.patch.object(conversion, "_read_archive", side_effect=AssertionError("read twice")):
                conversion.restore_webp_metadata(output)

    def test_existing_output_even_different_case_is_never_replaced(self):
        source = self.make_png()
        original = source.read_bytes()
        target = self.root / "SYNTHETIC.WEBP"
        target.write_bytes(b"existing output")
        result = conversion.convert_png_to_webp(source)
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(target.read_bytes(), b"existing output")

    def test_crc_failure_keeps_original(self):
        source = self.make_png()
        data = bytearray(source.read_bytes())
        data[29] ^= 1  # IHDR CRC, not the image payload.
        source.write_bytes(data)
        self.assert_preserved(source, bytes(data), conversion.convert_png_to_webp(source))

    def test_verification_failure_never_publishes_or_deletes(self):
        source = self.make_png()
        original = source.read_bytes()
        callback = mock.Mock()
        real_save = Image.Image.save
        encoder_methods = []

        def save(image, filename, format=None, **options):
            encoder_methods.append(options.get("method"))
            return real_save(image, filename, format, **options)

        with mock.patch.object(Image.Image, "save", save), \
             mock.patch.object(conversion, "_verify_webp", side_effect=ValueError("synthetic mismatch")):
            result = conversion.convert_png_to_webp(source, before_delete=callback)
        self.assert_preserved(source, original, result)
        self.assertEqual(encoder_methods, [1])
        callback.assert_not_called()

    def test_callback_sees_verified_files_and_returns_rollback_on_delete_failure(self):
        source = self.make_png()
        original = source.read_bytes()
        rollback = mock.Mock()
        callback = mock.Mock(return_value=rollback)
        real_unlink = Path.unlink

        def fail_source(path, *args, **kwargs):
            if path == source:
                self.assertTrue(path.with_suffix(".webp").is_file())
                raise PermissionError("synthetic locked PNG")
            return real_unlink(path, *args, **kwargs)

        with mock.patch.object(Path, "unlink", fail_source):
            result = conversion.convert_png_to_webp(source, before_delete=callback)
        callback.assert_called_once_with(str(source), str(source.with_suffix(".webp")))
        rollback.assert_called_once_with()
        self.assert_preserved(source, original, result)

    def test_callback_exception_leaves_original(self):
        source = self.make_png()
        original = source.read_bytes()
        callback = mock.Mock(side_effect=OSError("synthetic path reference failure"))
        self.assert_preserved(source, original, conversion.convert_png_to_webp(source, before_delete=callback))

    def test_callback_failed_internal_rollback_retains_target(self):
        source = self.make_png()
        original = source.read_bytes()
        error = OSError("synthetic reference rollback failure")
        error.retain_target = True
        callback = mock.Mock(side_effect=error)
        result = conversion.convert_png_to_webp(source, before_delete=callback)
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(source.read_bytes(), original)
        self.assertTrue(source.with_suffix(".webp").is_file())

    def test_callback_rollback_failure_retains_both_files(self):
        source = self.make_png()
        original = source.read_bytes()
        rollback = mock.Mock(side_effect=OSError("synthetic rollback failure"))
        real_unlink = Path.unlink

        def fail_source(path, *args, **kwargs):
            if path == source:
                raise PermissionError("synthetic locked PNG")
            return real_unlink(path, *args, **kwargs)

        with mock.patch.object(Path, "unlink", fail_source):
            result = conversion.convert_png_to_webp(source, before_delete=lambda *_: rollback)
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(source.read_bytes(), original)
        self.assertTrue(source.with_suffix(".webp").is_file())
        self.assertIn("복구 실패", result["reason"])

    def test_concurrent_source_change_is_not_deleted_and_references_roll_back(self):
        source = self.make_png()
        changed = b"synthetic concurrent edit"
        rollback = mock.Mock()

        def callback(*_):
            source.write_bytes(changed)
            return rollback

        self.assert_preserved(source, changed, conversion.convert_png_to_webp(source, before_delete=callback))
        rollback.assert_called_once_with()

    def test_concurrent_output_creation_is_not_overwritten(self):
        source = self.make_png()
        original = source.read_bytes()
        real_link = os.link

        def collide(temporary, target):
            Path(target).write_bytes(b"concurrent output")
            return real_link(temporary, target)

        with mock.patch.object(conversion.os, "link", side_effect=collide):
            result = conversion.convert_png_to_webp(source)
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(source.with_suffix(".webp").read_bytes(), b"concurrent output")

    def test_unsupported_bit_depth_animation_and_dimensions_keep_png(self):
        for name, image, options in (
            ("depth.png", Image.new("I;16", (8, 8), 12345), {}),
            ("large.png", Image.new("RGB", (16384, 1), "red"), {}),
            ("animated.png", Image.new("RGB", (8, 8), "red"),
             {"save_all": True, "append_images": [Image.new("RGB", (8, 8), "blue")]}),
        ):
            with self.subTest(name=name):
                source = self.root / name
                image.save(source, **options)
                original = source.read_bytes()
                self.assert_preserved(source, original, conversion.convert_png_to_webp(source))

    def test_archive_corruption_is_rejected_and_ordinary_reading_is_tolerant(self):
        archive = bytearray(conversion._make_archive({"Comment": "synthetic"}, conversion._PNG_SIGNATURE))
        archive[len(conversion._ARCHIVE_MAGIC)] ^= 1
        with self.assertRaises(ValueError):
            conversion._read_archive(bytes(archive))
        output = mock.Mock(format="WEBP", _naim_metadata_restored=False, info={"xmp": b"keep"})
        output._decoder.get_chunk.return_value = bytes(archive)
        conversion.restore_webp_metadata(output)
        self.assertEqual(output.info, {"xmp": b"keep"})
        png = mock.Mock(format="PNG")
        self.assertIs(conversion.restore_webp_metadata(png), png)
        png._decoder.get_chunk.assert_not_called()

    def test_metadata_budget_failure_keeps_original(self):
        source = self.make_png()
        original = source.read_bytes()
        with mock.patch.object(conversion, "_MAX_METADATA", 20):
            self.assert_preserved(source, original, conversion.convert_png_to_webp(source))

    def test_dry_run_estimates_verified_full_file_without_publishing_or_callback(self):
        source = self.make_png()
        original = source.read_bytes()
        original_stat = source.stat()
        callback = mock.Mock()
        estimated = conversion.convert_png_to_webp(source, lossless=False, quality=75,
                                                   before_delete=callback, dry_run=True)
        self.assertEqual(estimated["status"], "estimated", estimated)
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(source.stat().st_mtime_ns, original_stat.st_mtime_ns)
        self.assertFalse(source.with_suffix(".webp").exists())
        self.assertEqual(list(self.root.glob(".naim-webp-*")), [])
        callback.assert_not_called()
        actual = conversion.convert_png_to_webp(source, lossless=False, quality=75)
        self.assertEqual(actual["status"], "converted", actual)
        self.assertEqual(estimated["source_bytes"], actual["source_bytes"])
        self.assertEqual(estimated["target_bytes"], actual["target_bytes"])

    def test_encoding_and_verification_overlap_but_publication_and_deletion_are_locked(self):
        sources = [self.make_png("first.png"), self.make_png("second.png")]
        encoding = threading.Barrier(2)
        verification = threading.Barrier(2)
        real_save, real_verify = Image.Image.save, conversion._verify_webp
        real_link, real_unlink = os.link, Path.unlink
        phases = []

        def save(image, filename, format=None, **options):
            self.assertFalse(conversion.IMAGE_FILES_LOCK._is_owned())
            self.assertEqual(options["method"], 1 if options["lossless"] else 0)
            self.assertEqual(options["quality"], 73)
            encoding.wait(timeout=5)
            return real_save(image, filename, format, **options)

        def verify(*args):
            self.assertFalse(conversion.IMAGE_FILES_LOCK._is_owned())
            real_verify(*args)
            verification.wait(timeout=5)

        def link(*args):
            self.assertTrue(conversion.IMAGE_FILES_LOCK._is_owned())
            phases.append("publish")
            return real_link(*args)

        def callback(*_):
            self.assertTrue(conversion.IMAGE_FILES_LOCK._is_owned())
            phases.append("references")

        def unlink(path, *args, **kwargs):
            self.assertTrue(conversion.IMAGE_FILES_LOCK._is_owned())
            phases.append("delete" if path.suffix == ".png" else "cleanup")
            return real_unlink(path, *args, **kwargs)

        with mock.patch.object(Image.Image, "save", save), \
             mock.patch.object(conversion, "_verify_webp", verify), \
             mock.patch.object(conversion.os, "link", link), \
             mock.patch.object(Path, "unlink", unlink), \
             ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(conversion.convert_png_to_webp, source, lossless=index == 0,
                                   quality=73, before_delete=callback)
                       for index, source in enumerate(sources)]
            results = [future.result(timeout=10) for future in futures]
        self.assertEqual([result["status"] for result in results], ["converted", "converted"], results)
        self.assertEqual(phases, ["publish", "references", "delete", "cleanup"] * 2)
        self.assertTrue(all(not source.exists() and source.with_suffix(".webp").is_file() for source in sources))

    def test_cancellation_after_preparation_leaves_source_and_no_output(self):
        for dry_run in (False, True):
            with self.subTest(dry_run=dry_run):
                source = self.make_png()
                original = source.read_bytes()
                cancelled = threading.Event()
                callback = mock.Mock()
                real_verify = conversion._verify_webp

                def verify(*args):
                    real_verify(*args)
                    cancelled.set()

                with mock.patch.object(conversion, "_verify_webp", verify):
                    result = conversion.convert_png_to_webp(source, dry_run=dry_run,
                                                           before_delete=callback, cancel_event=cancelled)
                self.assert_preserved(source, original, result)
                self.assertTrue(cancelled.is_set())
                self.assertIn("취소", result["reason"])
                callback.assert_not_called()

    def test_cancellation_after_reference_update_rolls_back_under_lock(self):
        source = self.make_png()
        original = source.read_bytes()
        cancelled = threading.Event()
        phases = []
        real_unlink = Path.unlink

        def rollback():
            self.assertTrue(conversion.IMAGE_FILES_LOCK._is_owned())
            phases.append("rollback")

        def callback(*_):
            self.assertTrue(conversion.IMAGE_FILES_LOCK._is_owned())
            phases.append("references")
            cancelled.set()
            return rollback

        def unlink(path, *args, **kwargs):
            self.assertTrue(conversion.IMAGE_FILES_LOCK._is_owned())
            self.assertNotEqual(path, source)
            phases.append("cleanup")
            return real_unlink(path, *args, **kwargs)

        with mock.patch.object(Path, "unlink", unlink):
            result = conversion.convert_png_to_webp(source, before_delete=callback, cancel_event=cancelled)
        self.assert_preserved(source, original, result)
        self.assertEqual(phases, ["references", "rollback", "cleanup", "cleanup"])

    def test_cancellation_while_waiting_for_commit_lock_does_not_publish(self):
        source = self.make_png()
        original = source.read_bytes()
        cancelled = threading.Event()
        lock_requested = threading.Event()
        shared_lock = conversion.IMAGE_FILES_LOCK
        callback = mock.Mock()

        class ObservedLock:
            def __enter__(self):
                lock_requested.set()
                shared_lock.acquire()

            def __exit__(self, *args):
                shared_lock.release()

        with mock.patch.object(conversion, "IMAGE_FILES_LOCK", ObservedLock()), \
             ThreadPoolExecutor(max_workers=1) as pool:
            with shared_lock:
                future = pool.submit(conversion.convert_png_to_webp, source,
                                     before_delete=callback, cancel_event=cancelled)
                self.assertTrue(lock_requested.wait(timeout=5))
                cancelled.set()
            result = future.result(timeout=10)
        self.assert_preserved(source, original, result)
        callback.assert_not_called()

    def test_jpeg_conversion_preserves_native_exif_icc_and_full_info_archive(self):
        source = self.root / "photo.jpg"
        exif = Image.Exif()
        exif[274] = 6
        Image.new("RGB", (12, 8), (70, 110, 150)).save(
            source, "JPEG", quality=92, exif=exif.tobytes(), icc_profile=b"synthetic ICC profile",
        )
        with Image.open(source) as image:
            expected_info = dict(image.info)
        result = conversion.convert_image_to_webp(source, lossless=True)
        target = self.root / "photo.jpg.webp"
        self.assertEqual(result["status"], "converted", result)
        self.assertFalse(source.exists())
        with Image.open(target) as image:
            image.load()
            self.assertEqual(image.getexif()[274], 6)
            self.assertEqual(image.info["icc_profile"], b"synthetic ICC profile")
            saved_info, saved_chunks = conversion._read_archive(image._decoder.get_chunk("NAIM"))
            self.assertEqual(saved_info, expected_info)
            self.assertEqual(saved_chunks, conversion._PNG_SIGNATURE)
            conversion.restore_webp_metadata(image)
            for key, value in expected_info.items():
                self.assertEqual(image.info[key], value)

    def test_png_and_jpeg_with_same_stem_use_distinct_webp_names(self):
        png = self.make_png("shared.png")
        jpeg = self.root / "shared.jpg"
        Image.new("RGB", (8, 8), (90, 120, 160)).save(jpeg, "JPEG")
        self.assertEqual(conversion.webp_target_path(png), self.root / "shared.webp")
        self.assertEqual(conversion.webp_target_path(jpeg), self.root / "shared.jpg.webp")
        png_result = conversion.convert_image_to_webp(png, lossless=True)
        jpeg_result = conversion.convert_image_to_webp(jpeg, lossless=True)
        self.assertEqual((png_result["status"], jpeg_result["status"]), ("converted", "converted"))
        self.assertTrue((self.root / "shared.webp").is_file())
        self.assertTrue((self.root / "shared.jpg.webp").is_file())

    def test_bmp_and_static_gif_convert_with_appended_webp_suffix(self):
        sources = []
        bmp = self.root / "still.bmp"
        Image.new("RGB", (8, 6), (35, 65, 95)).save(bmp, "BMP")
        sources.append(bmp)
        gif = self.root / "still.gif"
        Image.new("P", (8, 6), 3).save(gif, "GIF")
        sources.append(gif)
        for source in sources:
            with self.subTest(source=source.suffix):
                result = conversion.convert_image_to_webp(source)
                self.assertEqual(result["status"], "converted", result)
                self.assertTrue(source.with_name(source.name + ".webp").is_file())
                self.assertFalse(source.exists())

    def test_animated_gif_and_existing_webp_are_skipped(self):
        first, second = Image.new("RGB", (8, 8), "red"), Image.new("RGB", (8, 8), "blue")
        animated = self.root / "animated.gif"
        first.save(animated, "GIF", save_all=True, append_images=[second], duration=100, loop=0)
        original = animated.read_bytes()
        result = conversion.convert_image_to_webp(animated)
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(animated.read_bytes(), original)
        self.assertFalse((self.root / "animated.gif.webp").exists())

        already_webp = self.root / "already.webp"
        Image.new("RGB", (8, 8), "green").save(already_webp, "WEBP")
        webp_original = already_webp.read_bytes()
        result = conversion.convert_image_to_webp(already_webp)
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(already_webp.read_bytes(), webp_original)

    def test_non_png_collision_source_change_and_reference_rollback_are_safe(self):
        collision_source = self.root / "collision.jpg"
        Image.new("RGB", (8, 8), "red").save(collision_source, "JPEG")
        collision_target = self.root / "collision.jpg.webp"
        collision_target.write_bytes(b"existing WebP")
        collision_original = collision_source.read_bytes()
        result = conversion.convert_image_to_webp(collision_source)
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(collision_source.read_bytes(), collision_original)
        self.assertEqual(collision_target.read_bytes(), b"existing WebP")

        source = self.root / "changed.jpg"
        Image.new("RGB", (8, 8), "yellow").save(source, "JPEG")
        changed = b"synthetic source changed during conversion"
        rollback = mock.Mock()

        def change_source(*_):
            source.write_bytes(changed)
            return rollback

        result = conversion.convert_image_to_webp(source, before_delete=change_source)
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(source.read_bytes(), changed)
        self.assertFalse((self.root / "changed.jpg.webp").exists())
        rollback.assert_called_once_with()

    def test_resolve_webp_image_prefers_source_then_exact_existing_target(self):
        source = self.root / "sample.jpg"
        target = self.root / "sample.jpg.webp"
        target.write_bytes(b"verified synthetic WebP")
        self.assertEqual(conversion.resolve_webp_image(source), target)
        source.write_bytes(b"new source")
        self.assertEqual(conversion.resolve_webp_image(source), source)


if __name__ == "__main__":
    unittest.main()
