"""Offline copy-and-switch checks using a synthetic dictionary catalog."""
import json
import os
from pathlib import Path
import random
import sqlite3
import tempfile
import unittest
from unittest import mock

from PIL import Image
from PIL.PngImagePlugin import PngInfo

from naim.daki_dictionary_images import extract_prompt
from naim.images.webp_conversion import convert_png_to_webp, restore_webp_metadata
from tools import copy_dictionary_webp as migration


class DictionaryWebPCopyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.data_dir = self.root / "daki_dictionary_user"
        self.data_dir.mkdir()
        self.source_root = self.root / "external_dictionary_images"
        image_path = self.source_root / "nested" / "sample.png"
        image_path.parent.mkdir(parents=True)
        info = PngInfo()
        info.add_text("Comment", json.dumps({
            "prompt": "smile, closed eyes", "uc": "blush",
        }))
        pixels = random.Random(7).randbytes(128 * 192 * 3)
        Image.frombytes("RGB", (128, 192), pixels).save(image_path, pnginfo=info)
        self.source = image_path.resolve()
        self.original = self.source.read_bytes()
        with Image.open(self.source) as image:
            self.width, self.height = image.size
            self.metadata = extract_prompt(image)

        self.database = self.data_dir / "image_catalog.sqlite3"
        with sqlite3.connect(self.database) as connection:
            connection.executescript("""
                CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
                CREATE TABLE images(id INTEGER PRIMARY KEY,path TEXT UNIQUE NOT NULL,
                    mtime INTEGER,size INTEGER,width INTEGER,height INTEGER,prompt TEXT,
                    negative TEXT,source TEXT,tags TEXT,status TEXT);
                CREATE TABLE image_tags(image_id INTEGER,tag TEXT,PRIMARY KEY(image_id,tag));
            """)
            connection.executemany("INSERT INTO settings VALUES(?,?)", [
                ("folder", str(self.source_root.resolve())),
                ("unrelated", "preserve this setting"),
            ])
            source_stat = self.source.stat()
            connection.execute("""INSERT INTO images
                (id,path,mtime,size,width,height,prompt,negative,source,tags,status)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)""", (
                37, str(self.source), source_stat.st_mtime_ns, source_stat.st_size,
                self.width, self.height, self.metadata[0], self.metadata[1],
                self.metadata[2], '["smile"]', "indexed",
            ))
            connection.execute("INSERT INTO image_tags VALUES(37,'smile')")

        self.destination = self.data_dir / "images_webp_q90"
        self.idle = lambda: True

    def snapshot(self):
        return migration._database_snapshot(self.database)

    def test_default_run_is_read_only_inventory(self):
        snapshot = self.snapshot()
        database_bytes = self.database.read_bytes()
        result = migration.copy_dictionary_webp(self.data_dir, check_idle=self.idle)

        self.assertEqual(result, {
            "apply": False, "count": 1, "source_bytes": len(self.original),
            "target_bytes": 0, "quality": 90, "backed_up": False, "switch": False,
        })
        self.assertEqual(self.snapshot(), snapshot)
        self.assertEqual(self.database.read_bytes(), database_bytes)
        self.assertEqual(self.source.read_bytes(), self.original)
        self.assertFalse(self.destination.exists())

    def test_apply_uses_quality_90_and_preserves_ids_metadata_tags_and_original(self):
        original_snapshot = self.snapshot()
        calls = []

        def convert(path, **options):
            calls.append((Path(path), options))
            return convert_png_to_webp(path, **options)

        with mock.patch.object(migration, "convert_png_to_webp", side_effect=convert):
            result = migration.copy_dictionary_webp(
                self.data_dir, apply=True, check_idle=self.idle,
            )

        self.assertEqual(result["count"], 1)
        self.assertEqual(result["quality"], 90)
        self.assertTrue(result["backed_up"])
        self.assertTrue(result["switch"])
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1], {"lossless": False, "quality": 90})
        self.assertEqual(self.source.read_bytes(), self.original)

        settings, images, image_tags = self.snapshot()
        settings = dict(settings)
        self.assertEqual(settings["folder"], str(self.destination.resolve()))
        self.assertEqual(settings["unrelated"], "preserve this setting")
        self.assertEqual(image_tags, original_snapshot[2])
        self.assertEqual(len(images), 1)
        row = dict(zip(migration.IMAGE_COLUMNS, images[0]))
        self.assertEqual(row["id"], 37)
        self.assertEqual(row["path"], str((self.destination / "nested" / "sample.webp").resolve()))
        for column in ("width", "height", "prompt", "negative", "source", "tags", "status"):
            self.assertEqual(row[column], dict(zip(migration.IMAGE_COLUMNS, original_snapshot[1][0]))[column])
        self.assertFalse((self.destination / "nested" / "sample.png").exists())
        with Image.open(row["path"]) as image:
            image.load()
            restore_webp_metadata(image)
            self.assertEqual((image.width, image.height), (self.width, self.height))
            self.assertEqual(extract_prompt(image), self.metadata)

        backups = list(self.data_dir.glob("image_catalog.before_webp_copy.*.sqlite3"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(migration._database_snapshot(backups[0]), original_snapshot)

    def test_existing_destination_and_active_server_are_refused_without_changes(self):
        snapshot = self.snapshot()
        self.destination.mkdir()
        sentinel = self.destination / "keep.txt"
        sentinel.write_text("keep", encoding="utf-8")
        with self.assertRaises(migration.MigrationError):
            migration.copy_dictionary_webp(self.data_dir, apply=True, check_idle=self.idle)
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")
        self.destination.rename(self.root / "existing_destination")

        with self.assertRaises(migration.MigrationError):
            migration.copy_dictionary_webp(self.data_dir, apply=True, check_idle=lambda: False)
        self.assertFalse(self.destination.exists())
        self.assertEqual(self.snapshot(), snapshot)
        self.assertEqual(self.source.read_bytes(), self.original)
        self.assertEqual(list(self.data_dir.glob("image_catalog.before_webp_copy.*.sqlite3")), [])

    def test_conversion_failure_leaves_catalog_and_source_unlinked(self):
        snapshot = self.snapshot()
        with mock.patch.object(migration, "convert_png_to_webp",
                               return_value={"status": "failed", "source_bytes": len(self.original)}):
            with self.assertRaises(migration.MigrationError):
                migration.copy_dictionary_webp(self.data_dir, apply=True, check_idle=self.idle)

        self.assertEqual(self.snapshot(), snapshot)
        self.assertEqual(self.source.read_bytes(), self.original)
        self.assertTrue((self.destination / "nested" / "sample.png").is_file())
        self.assertFalse((self.destination / "nested" / "sample.webp").exists())
        self.assertEqual(list(self.data_dir.glob("image_catalog.before_webp_copy.*.sqlite3")), [])

    def test_catalog_change_during_conversion_refuses_switch(self):
        snapshot = self.snapshot()
        original_convert = convert_png_to_webp

        def convert_then_change_database(path, **options):
            result = original_convert(path, **options)
            with sqlite3.connect(self.database) as connection:
                connection.execute("UPDATE settings SET value='changed concurrently' WHERE key='unrelated'")
            return result

        with mock.patch.object(migration, "convert_png_to_webp", side_effect=convert_then_change_database):
            with self.assertRaises(migration.MigrationError):
                migration.copy_dictionary_webp(self.data_dir, apply=True, check_idle=self.idle)

        settings, images, tags = self.snapshot()
        self.assertEqual(dict(settings)["unrelated"], "changed concurrently")
        self.assertEqual(images, snapshot[1])
        self.assertEqual(tags, snapshot[2])
        self.assertEqual(self.source.read_bytes(), self.original)
        self.assertEqual(list(self.data_dir.glob("image_catalog.before_webp_copy.*.sqlite3")), [])

    def test_source_change_before_database_commit_refuses_switch(self):
        snapshot = self.snapshot()
        idle_checks = 0

        def source_changes_when_idle_is_rechecked():
            nonlocal idle_checks
            idle_checks += 1
            if idle_checks == 3:
                source_stat = self.source.stat()
                os.utime(self.source, ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns + 1_000_000))
            return True

        with self.assertRaises(migration.MigrationError):
            migration.copy_dictionary_webp(
                self.data_dir, apply=True, check_idle=source_changes_when_idle_is_rechecked,
            )

        self.assertEqual(self.snapshot(), snapshot)
        self.assertEqual(self.source.read_bytes(), self.original)
        self.assertTrue(list(self.data_dir.glob("image_catalog.before_webp_copy.*.sqlite3")))

    def test_symlinked_catalog_source_is_rejected_when_supported(self):
        link = self.source_root / "nested" / "linked.png"
        try:
            link.symlink_to(self.source)
        except (OSError, NotImplementedError):
            self.skipTest("This environment does not permit creating a symlink.")
        with sqlite3.connect(self.database) as connection:
            source_stat = self.source.stat()
            connection.execute("UPDATE images SET path=?,mtime=?,size=? WHERE id=37", (
                str(link), source_stat.st_mtime_ns, source_stat.st_size,
            ))
        with self.assertRaises(migration.MigrationError):
            migration.copy_dictionary_webp(self.data_dir, check_idle=self.idle)
        self.assertFalse(self.destination.exists())


if __name__ == "__main__":
    unittest.main()
