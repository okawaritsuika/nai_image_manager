"""Opt-in compression of newly classified PNGs, using only synthetic galleries."""
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest import mock

from PIL import Image
from PIL.PngImagePlugin import PngInfo

import image_logic
from naim.images import comics, webp_conversion
from naim.jobs import webp_compression
from naim.storage.history import HistoryDB


class WebPClassificationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "source"
        self.output = self.root / "TOTAL_CLASSIFIED"
        self.db_path = self.output / "naia_history.db"
        self.tags = self.root / "gallery_image_tags.json"
        self.source.mkdir()
        self.logs = []
        for patch in (
                mock.patch("naim.storage.history.get_app_dir", return_value=str(self.root)),
                mock.patch.object(sys, "argv", [str(self.root / "main.py")]),
                mock.patch.object(image_logic.utils, "HistoryDB", side_effect=lambda: HistoryDB(self.db_path)),
                mock.patch.object(image_logic.utils, "load_config", return_value={})):
            patch.start()
            self.addCleanup(patch.stop)

    def png(self, path=None, *, seed=1):
        path = Path(path or self.source / "sample.png")
        path.parent.mkdir(parents=True, exist_ok=True)
        info = PngInfo()
        info.add_text("Comment", json.dumps({"prompt": "synthetic scenery", "seed": seed,
                                            "model": "nai-diffusion-5-full"}))
        info.add_itxt("Description", "synthetic metadata", lang="en", tkey="description")
        image = Image.new("RGBA", (24, 20))
        image.putdata([((index * 13 + seed) % 256, (index * 17) % 256,
                        (index * 29) % 256, 254 | index % 2) for index in range(480)])
        exif = Image.Exif()
        exif[37510] = b"ASCII\0\0\0synthetic EXIF"
        image.save(path, pnginfo=info, exif=exif)
        return path

    def run_process(self, **options):
        image_logic.process(str(self.source), normal_workers=2, skip_nsfw=True,
                            log_func=self.logs.append, **options)

    def assert_auto_transfer(self, method):
        source = self.png()
        original = source.read_bytes()
        original_hash = HistoryDB.get_hash(None, source)
        transfer = image_logic.file_io_worker

        def transfer_with_tag(src, dest, *args):
            result = transfer(src, dest, *args)
            self.tags.write_text(json.dumps({"image_tags": {
                Path(dest).relative_to(self.output).as_posix(): "star"}, "unknown": [1]}), encoding="utf-8")
            return result

        with mock.patch.object(image_logic, "file_io_worker", side_effect=transfer_with_tag):
            self.run_process(method=method, auto_webp=True)
        outputs = list(self.output.rglob("*.webp"))
        self.assertEqual(len(outputs), 1, self.logs)
        output = outputs[0]
        self.assertFalse(output.with_suffix(".png").exists())
        if method == "copy":
            self.assertEqual(source.read_bytes(), original)
        else:
            self.assertFalse(source.exists())
        with Image.open(output) as image:
            webp_conversion.restore_webp_metadata(image)
            self.assertEqual(json.loads(image.info["Comment"])["seed"], 1)
            self.assertEqual(image.info["Description"].lang, "en")
            self.assertEqual(image.getexif()[37510], b"ASCII\0\0\0synthetic EXIF")
        relative = output.relative_to(self.output).as_posix()
        self.assertEqual(json.loads(self.tags.read_bytes()), {"image_tags": {relative: "star"}, "unknown": [1]})
        db = HistoryDB(self.db_path)
        try:
            self.assertEqual(db.conn.execute("SELECT rel_path, file_name, model_family FROM gallery_images").fetchall(),
                             [(relative, output.name, "v5")])
            self.assertEqual(db.conn.execute("SELECT old_rel_path, new_rel_path FROM gallery_webp_conversions").fetchall(),
                             [(output.with_suffix(".png").relative_to(self.output).as_posix(), relative)])
            hashes = {row[0] for row in db.conn.execute("SELECT file_hash FROM processed_files")}
            self.assertIn(original_hash, hashes)
            self.assertIn(db.get_hash(output), hashes)
        finally:
            db.close()

    def test_copy_preserves_source_and_converts_metadata_history_and_tags(self):
        self.assert_auto_transfer("copy")

    def test_move_preserves_transfer_semantics_and_converts_metadata_references(self):
        self.assert_auto_transfer("move")

    def test_option_defaults_off(self):
        source = self.png()
        with mock.patch.object(webp_compression, "compress_classified_pngs") as compress:
            self.run_process()
        compress.assert_not_called()
        self.assertTrue(source.exists())
        self.assertEqual(len(list(self.output.rglob("*.png"))), 1)
        self.assertEqual(list(self.output.rglob("*.webp")), [])

    def assert_only_new_png(self, is_fast):
        self.png(self.source / "previous.png", seed=3)
        self.run_process()
        previous = next(self.output.rglob("previous.png"))
        previous_bytes = previous.read_bytes()
        existing = self.png(self.output / "existing.png", seed=4)
        existing_bytes = existing.read_bytes()
        self.png(self.source / "new.png", seed=5)
        (self.source / "broken.png").write_bytes(b"synthetic unreadable PNG")
        Image.new("RGB", (12, 10), "green").save(self.source / "photo.jpg")
        helper = webp_compression.compress_classified_pngs
        with mock.patch.object(webp_compression, "compress_classified_pngs", wraps=helper) as compress:
            self.run_process(auto_webp=True, is_fast=is_fast, webp_lossless=False, webp_quality=73)
        compress.assert_called_once()
        self.assertEqual([Path(path).name for path in compress.call_args.args[3]], ["new.png"])
        self.assertEqual(compress.call_args.kwargs["quality"], 73)
        self.assertFalse(compress.call_args.kwargs["lossless"])
        self.assertEqual(Path(compress.call_args.args[2]), self.tags)
        self.assertEqual(previous.read_bytes(), previous_bytes)
        self.assertEqual(existing.read_bytes(), existing_bytes)
        self.assertEqual(len(list(self.output.rglob("new.webp"))), 1)
        self.assertEqual(len(list(self.output.rglob("photo.jpg"))), 1)
        self.assertEqual(next((self.output / "_UNREADABLE").rglob("broken.png")).read_bytes(),
                         b"synthetic unreadable PNG")

    def test_only_new_pngs_excludes_history_unreadable_and_existing_gallery(self):
        self.assert_only_new_png(is_fast=True)

    def test_only_new_pngs_excludes_existing_destination_with_history_scan_off(self):
        self.assert_only_new_png(is_fast=False)

    def test_reorganization_never_invokes_auto_conversion(self):
        self.png()
        self.run_process()
        with mock.patch.object(webp_compression, "compress_classified_pngs") as compress:
            self.run_process(reorg_mode=True, auto_webp=True)
        compress.assert_not_called()
        self.assertEqual(len(list(self.output.rglob("*.png"))), 1)
        self.assertEqual(list(self.output.rglob("*.webp")), [])

    def test_conversion_verification_failure_keeps_transferred_png_and_index(self):
        self.png()
        with mock.patch.object(webp_conversion, "_verify_webp", side_effect=ValueError("synthetic verification failure")):
            self.run_process(auto_webp=True)
        pngs = list(self.output.rglob("*.png"))
        self.assertEqual(len(pngs), 1)
        self.assertEqual(list(self.output.rglob("*.webp")), [])
        db = HistoryDB(self.db_path)
        try:
            self.assertEqual(db.conn.execute("SELECT rel_path FROM gallery_images").fetchone()[0],
                             pngs[0].relative_to(self.output).as_posix())
        finally:
            db.close()

    def test_failed_transfer_does_not_invoke_conversion(self):
        source = self.png()
        original = source.read_bytes()
        with mock.patch.object(image_logic, "file_io_worker", return_value=False), \
             mock.patch.object(webp_compression, "compress_classified_pngs") as compress:
            self.run_process(auto_webp=True)
        compress.assert_not_called()
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(list(self.output.rglob("*.png")), [])

    def test_cancelled_classification_does_not_convert_completed_transfers(self):
        self.png()
        cancelled = threading.Event()
        transfer = image_logic.file_io_worker

        def transfer_and_cancel(*args):
            result = transfer(*args)
            cancelled.set()
            return result

        with mock.patch.object(image_logic, "file_io_worker", side_effect=transfer_and_cancel), \
             mock.patch.object(webp_compression, "compress_classified_pngs") as compress:
            self.run_process(auto_webp=True, stop_check=cancelled.is_set)
        compress.assert_not_called()
        self.assertEqual(len(list(self.output.rglob("*.png"))), 1)

    def test_failed_gallery_index_write_keeps_png_without_auto_conversion(self):
        self.png()
        with mock.patch.object(HistoryDB, "upsert_gallery_image_records", side_effect=OSError("synthetic DB failure")), \
             mock.patch.object(webp_compression, "compress_classified_pngs") as compress:
            self.run_process(auto_webp=True)
        compress.assert_not_called()
        self.assertEqual(len(list(self.output.rglob("*.png"))), 1)

    def test_invalid_enabled_options_fail_before_files_or_database_are_created(self):
        self.png()
        for options in ({"auto_webp": 1}, {"auto_webp": True, "webp_lossless": "yes"},
                        {"auto_webp": True, "webp_quality": 0},
                        {"auto_webp": True, "webp_quality": True},
                        {"auto_webp": True, "webp_quality": 90.5}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.run_process(**options)
            self.assertFalse(self.output.exists())

    def test_comic_duplicate_checks_finish_before_lossy_conversion(self):
        page = self.png(self.source / "session/comic_maker/book/page_001.png")
        outside = self.source / "session/outside.png"
        outside.write_bytes(page.read_bytes())
        helper = webp_compression.compress_classified_pngs

        def compress(db, root, tags_path, paths, **options):
            self.assertFalse(outside.exists())
            self.assertTrue(all(Path(path).suffix == ".png" and Path(path).exists() for path in paths))
            self.assertEqual(db.conn.execute("SELECT COUNT(*) FROM gallery_images").fetchone()[0], 1)
            self.assertEqual(db.conn.execute("SELECT COUNT(*) FROM processed_files").fetchone()[0], 1)
            return helper(db, root, tags_path, paths, **options)

        with mock.patch.object(webp_compression, "compress_classified_pngs", side_effect=compress):
            self.run_process(auto_webp=True, webp_lossless=False, webp_quality=35,
                             delete_comic_duplicates=True)
        self.assertEqual(len(list(self.output.rglob("page_001.webp"))), 1)
        self.assertTrue(page.exists())
        self.assertFalse(outside.exists())

    def test_repeat_comic_import_reuses_registered_webp_without_recopying_or_false_deletion(self):
        page = self.png(self.source / "session/comic_maker/book/page_001.png")
        outside = self.source / "session/outside.png"
        outside.write_bytes(page.read_bytes())
        self.run_process(auto_webp=True, webp_lossless=False, webp_quality=35)
        output = next(self.output.rglob("page_001.webp"))
        original_webp = output.read_bytes()
        self.assertNotEqual(comics.pixel_digest(outside), comics.pixel_digest(output))
        for is_fast in (True, False):
            with self.subTest(is_fast=is_fast), \
                 mock.patch.object(webp_compression, "compress_classified_pngs") as compress:
                self.run_process(auto_webp=True, is_fast=is_fast, delete_comic_duplicates=True)
            compress.assert_not_called()
            self.assertTrue(outside.exists(), "history alone cannot authorize duplicate deletion")
            self.assertTrue(page.exists())
            self.assertEqual(output.read_bytes(), original_webp)
            self.assertEqual(list(self.output.rglob("*.png")), [])
        db = HistoryDB(self.db_path)
        try:
            self.assertEqual(db.conn.execute("SELECT rel_path FROM gallery_images").fetchall(),
                             [(output.relative_to(self.output).as_posix(),)])
        finally:
            db.close()

    def test_changed_comic_source_keeps_existing_converted_page_and_sidecar(self):
        page = self.png(self.source / "session/comic_maker/book/page_001.png")
        self.run_process(auto_webp=True)
        output = next(self.output.rglob("page_001.webp"))
        existing = {path: path.read_bytes() for path in (output, output.with_suffix(".json"),
                                                        output.parent / comics.MANIFEST)}
        self.png(page, seed=999)
        changed_source = page.read_bytes()
        with mock.patch.object(webp_compression, "compress_classified_pngs") as compress:
            self.run_process(auto_webp=True, is_fast=False, delete_comic_duplicates=True)
        compress.assert_not_called()
        self.assertEqual(page.read_bytes(), changed_source)
        self.assertEqual(list(self.output.rglob("*.png")), [])
        for path, original in existing.items():
            self.assertEqual(path.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
