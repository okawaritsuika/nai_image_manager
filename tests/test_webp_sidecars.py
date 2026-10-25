"""Synthetic sidecar compatibility checks for generic WebP conversion."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from PIL import Image

from naim.images import webp_conversion as conversion


class WebPSidecarTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def make_jpeg(self, name="sample.jpg"):
        source = self.root / name
        Image.new("RGB", (12, 9), (82, 116, 149)).save(source, "JPEG", quality=91)
        return source

    def test_jpeg_copies_exact_sidecars_and_keeps_originals(self):
        source = self.make_jpeg()
        json_bytes = b'{"synthetic":true,"keep":"json bytes"}\r\n'
        text_bytes = "합성 프롬프트\r\nsecond line\n".encode("utf-8")
        (self.root / "sample.json").write_bytes(json_bytes)
        (self.root / "sample.txt").write_bytes(text_bytes)

        result = conversion.convert_image_to_webp(source, lossless=True)

        self.assertEqual(result["status"], "converted", result)
        self.assertFalse(source.exists())
        self.assertTrue((self.root / "sample.jpg.webp").is_file())
        self.assertEqual((self.root / "sample.json").read_bytes(), json_bytes)
        self.assertEqual((self.root / "sample.txt").read_bytes(), text_bytes)
        self.assertEqual((self.root / "sample.jpg.json").read_bytes(), json_bytes)
        self.assertEqual((self.root / "sample.jpg.txt").read_bytes(), text_bytes)

    def test_keep_original_keeps_jpeg_and_copies_sidecars(self):
        source = self.make_jpeg()
        original_image = source.read_bytes()
        original_stat = source.stat()
        json_bytes = b'{"synthetic":"retained source"}\r\n'
        text_bytes = b"synthetic retained prompt\n"
        source_json = self.root / "sample.json"
        source_txt = self.root / "sample.txt"
        source_json.write_bytes(json_bytes)
        source_txt.write_bytes(text_bytes)

        result = conversion.convert_image_to_webp(source, keep_original=True)

        self.assertEqual(result["status"], "converted", result)
        self.assertEqual(source.read_bytes(), original_image)
        current_stat = source.stat()
        for attribute in ("st_mtime_ns", "st_ctime_ns", "st_size", "st_mode"):
            self.assertEqual(getattr(current_stat, attribute), getattr(original_stat, attribute), attribute)
        if hasattr(original_stat, "st_birthtime_ns"):
            self.assertEqual(current_stat.st_birthtime_ns, original_stat.st_birthtime_ns)
        self.assertTrue((self.root / "sample.jpg.webp").is_file())
        self.assertEqual(source_json.read_bytes(), json_bytes)
        self.assertEqual(source_txt.read_bytes(), text_bytes)
        self.assertEqual((self.root / "sample.jpg.json").read_bytes(), json_bytes)
        self.assertEqual((self.root / "sample.jpg.txt").read_bytes(), text_bytes)

    def test_png_api_leaves_same_stem_sidecars_in_place(self):
        source = self.root / "sample.png"
        Image.new("RGBA", (8, 6), (50, 100, 150, 220)).save(source)
        sidecar = self.root / "sample.json"
        expected = b'{"synthetic":"png sidecar"}\n'
        sidecar.write_bytes(expected)

        result = conversion.convert_png_to_webp(source)

        self.assertEqual(result["status"], "converted", result)
        self.assertFalse(source.exists())
        self.assertEqual(sidecar.read_bytes(), expected)
        self.assertFalse((self.root / "sample.webp.json").exists())

    def test_same_content_target_sidecar_is_reused(self):
        source = self.make_jpeg()
        json_bytes = b'{"same":"content"}'
        text_bytes = b"new companion"
        (self.root / "sample.json").write_bytes(json_bytes)
        (self.root / "sample.txt").write_bytes(text_bytes)
        target_json = self.root / "sample.jpg.json"
        target_json.write_bytes(json_bytes)
        original_stat = target_json.stat()

        result = conversion.convert_image_to_webp(source)

        self.assertEqual(result["status"], "converted", result)
        self.assertEqual(target_json.read_bytes(), json_bytes)
        self.assertEqual(target_json.stat().st_ino, original_stat.st_ino)
        self.assertEqual((self.root / "sample.jpg.txt").read_bytes(), text_bytes)
        self.assertEqual((self.root / "sample.json").read_bytes(), json_bytes)
        self.assertEqual((self.root / "sample.txt").read_bytes(), text_bytes)

    def test_different_target_sidecar_collision_keeps_source_and_existing_files(self):
        source = self.make_jpeg()
        original_image = source.read_bytes()
        source_json = b'{"source":"synthetic"}'
        existing_json = b'{"target":"preserve"}'
        (self.root / "sample.json").write_bytes(source_json)
        (self.root / "sample.txt").write_bytes(b"companion")
        target_json = self.root / "sample.jpg.json"
        target_json.write_bytes(existing_json)

        result = conversion.convert_image_to_webp(source)

        self.assertEqual(result["status"], "skipped")
        self.assertIn("보조 파일", result["reason"])
        self.assertEqual(source.read_bytes(), original_image)
        self.assertEqual((self.root / "sample.json").read_bytes(), source_json)
        self.assertEqual(target_json.read_bytes(), existing_json)
        self.assertFalse((self.root / "sample.jpg.webp").exists())
        self.assertFalse((self.root / "sample.jpg.txt").exists())

    def test_reference_callback_failure_rolls_back_new_sidecars(self):
        for keep_original in (False, True):
            with self.subTest(keep_original=keep_original):
                self._assert_reference_callback_failure(keep_original)

    def _assert_reference_callback_failure(self, keep_original):
        source = self.make_jpeg()
        source_json = self.root / "sample.json"
        source_json.write_bytes(b'{"synthetic":1}')
        source_txt = self.root / "sample.txt"
        source_txt.write_bytes(b"synthetic text")

        def fail_callback(*_):
            raise RuntimeError("synthetic reference failure")

        result = conversion.convert_image_to_webp(
            source, before_delete=fail_callback, keep_original=keep_original,
        )

        self.assertEqual(result["status"], "skipped")
        self.assertIn("synthetic reference failure", result["reason"])
        self.assertTrue(source.is_file())
        self.assertEqual(source_json.read_bytes(), b'{"synthetic":1}')
        self.assertEqual(source_txt.read_bytes(), b"synthetic text")
        self.assertFalse((self.root / "sample.jpg.webp").exists())
        self.assertFalse((self.root / "sample.jpg.json").exists())
        self.assertFalse((self.root / "sample.jpg.txt").exists())

    def test_callback_retain_target_keeps_webp_and_copied_sidecars(self):
        source = self.make_jpeg()
        (self.root / "sample.json").write_bytes(b'{"synthetic":2}')

        def retain_callback(*_):
            error = RuntimeError("synthetic reference needs WebP")
            error.retain_target = True
            raise error

        result = conversion.convert_image_to_webp(source, before_delete=retain_callback)

        self.assertEqual(result["status"], "skipped")
        self.assertTrue(source.is_file())
        self.assertTrue((self.root / "sample.jpg.webp").is_file())
        self.assertEqual((self.root / "sample.json").read_bytes(), b'{"synthetic":2}')
        self.assertEqual((self.root / "sample.jpg.json").read_bytes(), b'{"synthetic":2}')

    def test_source_delete_failure_runs_reference_and_sidecar_rollback(self):
        source = self.make_jpeg()
        (self.root / "sample.json").write_bytes(b'{"synthetic":3}')
        reference_undo = mock.Mock()
        real_unlink = Path.unlink

        def fail_source_unlink(path, *args, **kwargs):
            if path == source:
                raise PermissionError("synthetic source delete failure")
            return real_unlink(path, *args, **kwargs)

        with mock.patch.object(Path, "unlink", fail_source_unlink):
            result = conversion.convert_image_to_webp(
                source, before_delete=lambda *_: reference_undo,
            )

        self.assertEqual(result["status"], "skipped")
        self.assertTrue(source.is_file())
        self.assertEqual((self.root / "sample.json").read_bytes(), b'{"synthetic":3}')
        self.assertFalse((self.root / "sample.jpg.webp").exists())
        self.assertFalse((self.root / "sample.jpg.json").exists())
        reference_undo.assert_called_once_with()

    def test_reference_undo_failure_keeps_webp_and_both_sidecars(self):
        source = self.make_jpeg()
        original_image = source.read_bytes()
        json_bytes = b'{"synthetic":"undo failure"}'
        text_bytes = b"synthetic companion text"
        source_json = self.root / "sample.json"
        source_txt = self.root / "sample.txt"
        source_json.write_bytes(json_bytes)
        source_txt.write_bytes(text_bytes)
        real_unlink = Path.unlink

        def fail_reference_undo():
            raise RuntimeError("synthetic reference rollback failure")

        def fail_source_unlink(path, *args, **kwargs):
            if path == source:
                raise PermissionError("synthetic source delete failure")
            return real_unlink(path, *args, **kwargs)

        with mock.patch.object(Path, "unlink", fail_source_unlink):
            result = conversion.convert_image_to_webp(
                source, before_delete=lambda *_: fail_reference_undo,
            )

        self.assertEqual(result["status"], "skipped")
        self.assertIn("synthetic source delete failure", result["reason"])
        self.assertIn("경로 복구 실패", result["reason"])
        self.assertEqual(source.read_bytes(), original_image)
        self.assertEqual(source_json.read_bytes(), json_bytes)
        self.assertEqual(source_txt.read_bytes(), text_bytes)
        self.assertTrue((self.root / "sample.jpg.webp").is_file())
        self.assertEqual((self.root / "sample.jpg.json").read_bytes(), json_bytes)
        self.assertEqual((self.root / "sample.jpg.txt").read_bytes(), text_bytes)

    def test_dry_run_does_not_publish_or_touch_sidecars_or_callback(self):
        source = self.make_jpeg()
        expected = b'{"synthetic":"dry run"}'
        (self.root / "sample.json").write_bytes(expected)
        callback = mock.Mock()

        result = conversion.convert_image_to_webp(source, before_delete=callback, dry_run=True)

        self.assertEqual(result["status"], "estimated", result)
        self.assertTrue(source.is_file())
        self.assertEqual((self.root / "sample.json").read_bytes(), expected)
        self.assertFalse((self.root / "sample.jpg.webp").exists())
        self.assertFalse((self.root / "sample.jpg.json").exists())
        callback.assert_not_called()

    def test_non_file_source_sidecar_fails_without_publishing_webp(self):
        source = self.make_jpeg()
        source_json = self.root / "sample.json"
        source_json.mkdir()
        original_image = source.read_bytes()

        result = conversion.convert_image_to_webp(source)

        self.assertEqual(result["status"], "skipped")
        self.assertEqual(source.read_bytes(), original_image)
        self.assertTrue(source_json.is_dir())
        self.assertFalse((self.root / "sample.jpg.webp").exists())

    def test_symlink_source_sidecar_fails_without_reading_through_it(self):
        source = self.make_jpeg()
        outside = self.root / "synthetic-outside.txt"
        outside.write_bytes(b"synthetic linked content")
        source_json = self.root / "sample.json"
        try:
            os.symlink(outside, source_json)
        except (OSError, NotImplementedError) as error:
            self.skipTest("file symlinks are unavailable in this test environment: " + str(error))

        result = conversion.convert_image_to_webp(source)

        self.assertEqual(result["status"], "skipped")
        self.assertTrue(source.is_file())
        self.assertTrue(source_json.is_symlink())
        self.assertEqual(outside.read_bytes(), b"synthetic linked content")
        self.assertFalse((self.root / "sample.jpg.webp").exists())

    def test_different_external_sidecar_change_during_rollback_is_preserved(self):
        source = self.make_jpeg()
        (self.root / "sample.json").write_bytes(b'{"source":true}')
        target_json = self.root / "sample.jpg.json"

        def change_then_fail(*_):
            target_json.write_bytes(b'{"external":"change"}')
            raise RuntimeError("synthetic callback failure")

        result = conversion.convert_image_to_webp(source, before_delete=change_then_fail)

        self.assertEqual(result["status"], "skipped")
        self.assertTrue(source.is_file())
        self.assertTrue((self.root / "sample.jpg.webp").is_file())
        self.assertEqual(target_json.read_bytes(), b'{"external":"change"}')


if __name__ == "__main__":
    unittest.main()
