import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

from naim.storage.history import HistoryDB
from naim.storage.webp_conversion import (
    GalleryTagCache, WebpReferenceRollbackError, add_webp_gallery_image, migrate_webp_references, resolve_converted_gallery_path,
)


class WebpReferencesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "synthetic" / "sample.png"
        self.target = self.source.with_suffix(".webp")
        self.source.parent.mkdir()
        self.source.write_bytes(b"synthetic PNG bytes")
        self.target.write_bytes(b"verified synthetic WebP bytes")
        self.old = "synthetic/sample.png"
        self.new = "synthetic/sample.webp"
        with mock.patch("naim.storage.history.get_app_dir", return_value=str(self.root)):
            self.db = HistoryDB(self.root / "history.sqlite")
        self.addCleanup(self.db.close)
        self.tags = self.root / "tags.json"
        self.tags.write_text(json.dumps({"tags": [{"id": "star"}], "image_tags": {self.old: "star"}, "unknown": [1]}), encoding="utf-8")

    def migrate(self, **options):
        return migrate_webp_references(self.db, self.root, self.source, self.target, self.tags, **options)

    def test_addition_registration_and_undo_preserve_source_and_tags(self):
        from PIL import Image
        Image.new('RGB', (16, 24)).save(self.source, 'PNG')
        Image.new('RGB', (16, 24)).save(self.target, 'WEBP')
        self.db.upsert_gallery_image_file(self.source, classified_root=self.root,
                                         reason='synthetic', model_family='v5')
        source_record = self.db.conn.execute('SELECT * FROM gallery_images WHERE rel_path = ?', (self.old,)).fetchone()
        tag_bytes = self.tags.read_bytes()
        undo = add_webp_gallery_image(self.db, self.root, self.source, self.target)
        self.assertTrue(self.db.gallery_image_record_exists(self.new))
        self.assertEqual(self.db.conn.execute('SELECT reason, model_family FROM gallery_images WHERE rel_path = ?',
                                             (self.new,)).fetchone(), ('synthetic', 'v5'))
        self.assertEqual(self.tags.read_bytes(), tag_bytes)
        undo()
        undo()
        self.assertFalse(self.db.gallery_image_record_exists(self.new))
        self.assertEqual(self.db.conn.execute('SELECT * FROM gallery_images WHERE rel_path = ?', (self.old,)).fetchone(), source_record)
        self.assertEqual(self.tags.read_bytes(), tag_bytes)

    def populate(self):
        connection = self.db.conn
        with connection:
            connection.execute("""INSERT INTO gallery_images
                (rel_path, folder_path, file_name, ctime, mtime, gallery_tag, model_family, reason)
                VALUES (?, 'synthetic', 'sample.png', 123, 456, 'star', 'v5', 'synthetic reason')""", (self.old,))
            connection.execute("INSERT INTO gallery_folders (folder_path, thumb_path, total_images) VALUES ('synthetic', ?, 1)", (self.old,))
            connection.execute("INSERT INTO gallery_prompt_index (rel_path, file_name, prompt_text, text_bytes) VALUES (?, 'sample.png', 'synthetic prompt', 16)", (self.old,))
            connection.execute("INSERT INTO gallery_prompt_index_profiles (id, image_count, text_bytes) VALUES ('profile', 1, 16)")
            connection.execute("INSERT INTO gallery_prompt_index_profile_items VALUES ('profile', ?)", (self.old,))
            connection.execute("INSERT INTO gallery_virtual_folder_cache_meta VALUES ('virtual', 1, '1', '{}', 1, ?, 1, 1)", (self.old,))
            connection.execute("INSERT INTO gallery_virtual_folder_cache_items VALUES ('virtual', ?)", (self.old,))
            connection.execute("INSERT INTO file_metadata VALUES (?, 2, 3, 456)", (self.old,))
            connection.execute("INSERT INTO image_artists VALUES (?, 'synthetic artist')", (self.old,))
            connection.execute("INSERT INTO artist_scanned_files VALUES (?)", (str(self.source),))
            connection.execute("INSERT INTO processed_files VALUES (?, 'sample.png', 'synthetic character', '2000-01-01')", (self.db.get_hash(self.source),))
            connection.execute("CREATE TABLE manual_overrides (file_hash TEXT PRIMARY KEY, is_nsfw INTEGER)")
            connection.execute("INSERT INTO manual_overrides VALUES (?, 2)", (self.db.get_hash(self.source),))

    def snapshot(self):
        tables = [row[0] for row in self.db.conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name != 'gallery_webp_conversions'")]
        return {table: self.db.conn.execute(f'SELECT * FROM "{table}" ORDER BY rowid').fetchall() for table in tables}

    def test_every_reference_and_hash_history_moves_without_losing_metadata(self):
        self.populate()
        source_hash, target_hash = self.db.get_hash(self.source), self.db.get_hash(self.target)
        self.migrate()
        connection = self.db.conn
        self.assertEqual(connection.execute("SELECT rel_path, file_name, ctime, mtime, gallery_tag, model_family, reason FROM gallery_images").fetchone(),
                         (self.new, "sample.webp", 123, 456, "star", "v5", "synthetic reason"))
        for table, column in (("gallery_folders", "thumb_path"), ("gallery_prompt_index", "rel_path"),
                              ("gallery_prompt_index_profile_items", "rel_path"), ("gallery_virtual_folder_cache_items", "rel_path"),
                              ("gallery_virtual_folder_cache_meta", "thumb_path"), ("file_metadata", "path"), ("image_artists", "path")):
            self.assertEqual(connection.execute(f'SELECT "{column}" FROM "{table}"').fetchone()[0], self.new)
        self.assertEqual(connection.execute("SELECT path FROM artist_scanned_files").fetchone()[0], str(self.target))
        self.assertEqual(connection.execute("SELECT prompt_text, text_bytes FROM gallery_prompt_index").fetchone(), ("synthetic prompt", 16))
        self.assertEqual(connection.execute("SELECT id, image_count, text_bytes FROM gallery_prompt_index_profiles").fetchone(), ("profile", 1, 16))
        for value in (source_hash, target_hash):
            self.assertEqual(connection.execute("SELECT characters, processed_at FROM processed_files WHERE file_hash = ?", (value,)).fetchone(), ("synthetic character", "2000-01-01"))
            self.assertEqual(connection.execute("SELECT is_nsfw FROM manual_overrides WHERE file_hash = ?", (value,)).fetchone(), (2,))
        self.assertEqual(json.loads(self.tags.read_text(encoding="utf-8")),
                         {"tags": [{"id": "star"}], "image_tags": {self.new: "star"}, "unknown": [1]})

    def test_undo_restores_exact_rows_and_json_bytes_and_can_run_twice(self):
        self.populate()
        before, tags_before = self.snapshot(), self.tags.read_bytes()
        undo = self.migrate()
        undo()
        undo()
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.tags.read_bytes(), tags_before)
        self.assertEqual(self.db.conn.execute("SELECT * FROM gallery_webp_conversions").fetchall(), [])

    def test_conversion_does_not_mark_unprocessed_image_as_processed(self):
        self.migrate()
        self.assertEqual(self.db.conn.execute("SELECT * FROM processed_files").fetchall(), [])

    def test_db_collision_rolls_back_all_changes_and_does_not_overwrite(self):
        self.populate()
        with self.db.conn:
            self.db.conn.execute("INSERT INTO gallery_prompt_index (rel_path, prompt_text) VALUES (?, 'keep existing')", (self.new,))
        before, tags_before = self.snapshot(), self.tags.read_bytes()
        with self.assertRaises(sqlite3.IntegrityError):
            self.migrate()
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.tags.read_bytes(), tags_before)

    def test_tag_failure_rolls_back_db_and_preserves_bad_json(self):
        self.populate()
        self.tags.write_bytes(b"{ invalid JSON retained")
        before = self.snapshot()
        with self.assertRaises(ValueError):
            self.migrate()
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.tags.read_bytes(), b"{ invalid JSON retained")

    def test_tag_write_failure_rolls_back_all_database_rows(self):
        self.populate()
        before, tags_before = self.snapshot(), self.tags.read_bytes()
        with mock.patch("naim.storage.webp_conversion.write_json", side_effect=OSError("synthetic failure")):
            with self.assertRaises(OSError):
                self.migrate()
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.tags.read_bytes(), tags_before)

    def test_callback_rollback_failure_marks_webp_for_retention(self):
        self.populate()
        before = self.snapshot()
        connection = self.db.conn

        class CommitFailure:
            def __getattr__(self, name):
                return getattr(connection, name)

            def commit(self):
                raise OSError("synthetic commit failure")

        with mock.patch.object(self.db, "conn", CommitFailure()), \
                mock.patch("naim.storage.webp_conversion._restore_bytes", side_effect=OSError("synthetic rollback failure")):
            with self.assertRaises(WebpReferenceRollbackError) as raised:
                self.migrate()
        self.assertTrue(raised.exception.retain_target)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(json.loads(self.tags.read_bytes())["image_tags"], {self.new: "star"})

    def test_undo_failure_marks_webp_for_retention(self):
        self.populate()
        undo = self.migrate()
        after = self.snapshot()
        with mock.patch("naim.storage.webp_conversion._restore_bytes", side_effect=OSError("synthetic rollback failure")):
            with self.assertRaises(WebpReferenceRollbackError) as raised:
                undo()
        self.assertTrue(raised.exception.retain_target)
        self.assertEqual(self.snapshot(), after)

    def test_trash_original_destination_changes_format_and_undo_restores_it(self):
        restore_to = str(self.root / "restored" / "original.png")
        with self.db.conn:
            self.db.conn.execute("INSERT INTO trash_map VALUES (?, ?)", (str(self.source), restore_to))
        undo = self.migrate()
        self.assertEqual(self.db.conn.execute("SELECT * FROM trash_map").fetchone(), (str(self.target), restore_to[:-4] + ".webp"))
        undo()
        self.assertEqual(self.db.conn.execute("SELECT * FROM trash_map").fetchone(), (str(self.source), restore_to))

    def test_jpeg_reference_migration_uses_appended_webp_name_and_undoes(self):
        source = self.root / "synthetic" / "photo.jpg"
        target = self.root / "synthetic" / "photo.jpg.webp"
        source.write_bytes(b"synthetic JPEG source bytes")
        target.write_bytes(b"verified synthetic WebP bytes")
        restore_to = str(self.root / "restored" / "photo.jpg")
        with self.db.conn:
            self.db.conn.execute("INSERT INTO trash_map VALUES (?, ?)", (str(source), restore_to))

        undo = migrate_webp_references(self.db, self.root, source, target, self.tags)
        self.assertEqual(self.db.conn.execute("SELECT old_rel_path, new_rel_path FROM gallery_webp_conversions").fetchone(),
                         ("synthetic/photo.jpg", "synthetic/photo.jpg.webp"))
        self.assertEqual(self.db.conn.execute("SELECT * FROM trash_map").fetchone(),
                         (str(target), restore_to + ".webp"))
        resolve = lambda name: resolve_converted_gallery_path(self.root, name, self.db.db_path)
        self.assertIsNone(resolve("synthetic/photo.jpg"))
        source.unlink()
        self.assertEqual(resolve("synthetic/photo.jpg"), str(target))
        undo()
        self.assertEqual(self.db.conn.execute("SELECT * FROM trash_map").fetchone(), (str(source), restore_to))
        self.assertEqual(self.db.conn.execute("SELECT * FROM gallery_webp_conversions").fetchall(), [])

    def test_jpeg_migration_rejects_noncanonical_output_name(self):
        source = self.root / "synthetic" / "photo.jpg"
        source.write_bytes(b"synthetic JPEG source bytes")
        wrong_target = self.root / "synthetic" / "photo.webp"
        wrong_target.write_bytes(b"unrelated output name")
        with self.assertRaises(ValueError):
            migrate_webp_references(self.db, self.root, source, wrong_target, self.tags)
        self.assertTrue(source.is_file())
        self.assertEqual(self.db.conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='gallery_webp_conversions'").fetchone(), None)

    def test_trash_restore_destination_collision_preserves_all_references(self):
        self.populate()
        restored = self.root / "restored" / "original.webp"
        restored.parent.mkdir()
        restored.write_bytes(b"unrelated WebP must survive restore")
        with self.db.conn:
            self.db.conn.execute("INSERT INTO trash_map VALUES (?, ?)",
                                 (str(self.source), str(restored.with_suffix(".png"))))
        before, tags_before = self.snapshot(), self.tags.read_bytes()
        with self.assertRaisesRegex(ValueError, "휴지통 복구 위치"):
            self.migrate()
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.tags.read_bytes(), tags_before)
        self.assertEqual(restored.read_bytes(), b"unrelated WebP must survive restore")

    def test_alias_only_applies_to_missing_registered_png(self):
        self.migrate()
        resolve = lambda name: resolve_converted_gallery_path(self.root, name, self.db.db_path)
        self.assertIsNone(resolve(self.old))
        self.source.unlink()
        self.assertEqual(resolve(self.old), str(self.target))
        self.assertIsNone(resolve("synthetic/unregistered.png"))
        self.assertIsNone(resolve("synthetic/sample.jpg"))
        self.source.write_bytes(b"new PNG takes priority")
        self.assertIsNone(resolve(self.old))
        self.source.unlink()
        self.target.unlink()
        self.assertIsNone(resolve(self.old))

    def test_alias_does_not_create_missing_db_or_follow_hostile_mapping(self):
        missing = self.root / "missing.sqlite"
        self.source.unlink()
        self.assertIsNone(resolve_converted_gallery_path(self.root, self.old, missing))
        self.assertFalse(missing.exists())
        with self.db.conn:
            self.db.conn.execute("CREATE TABLE gallery_webp_conversions (old_rel_path TEXT PRIMARY KEY, new_rel_path TEXT)")
            self.db.conn.execute("INSERT INTO gallery_webp_conversions VALUES (?, '../outside.webp')", (self.old,))
        self.assertIsNone(resolve_converted_gallery_path(self.root, self.old, self.db.db_path))
        self.assertIsNone(resolve_converted_gallery_path(self.root, "../outside.png", self.db.db_path))

    def test_batch_tag_cache_reuses_parsed_config_and_preserves_unknown_fields(self):
        config = json.loads(self.tags.read_bytes())
        config["unknown"] = {"한국어": "합성 값", "escaped": "quote\" and \\ and\nnewline"}
        self.tags.write_text(json.dumps(config, ensure_ascii=False, indent=4), encoding="utf-8")
        cache = GalleryTagCache(self.tags)
        with mock.patch("naim.storage.webp_conversion.json.loads", wraps=json.loads) as loads:
            self.migrate(tags_cache=cache)
            self.migrate(tags_cache=cache)
        self.assertEqual(loads.call_count, 1)
        config["image_tags"] = {self.new: "star"}
        self.assertEqual(json.loads(self.tags.read_bytes()),
                         config)

    def test_batch_tag_cache_reloads_external_replacement(self):
        cache = GalleryTagCache(self.tags)
        self.migrate(tags_cache=cache)
        external = {"external": ["preserved"], "image_tags": {self.old: "different"}}
        replacement = self.root / "replacement.json"
        replacement.write_text(json.dumps(external), encoding="utf-8")
        os.replace(replacement, self.tags)
        self.migrate(tags_cache=cache)
        self.assertEqual(json.loads(self.tags.read_bytes()),
                         {"external": ["preserved"], "image_tags": {self.new: "different"}})

    def test_batch_tag_cache_rejects_external_edit_between_read_and_write(self):
        self.populate()
        before = self.snapshot()
        cache = GalleryTagCache(self.tags)
        save = cache.write
        external = b'{"external": "do not overwrite"}'

        def changed_before_write(config):
            self.tags.write_bytes(external)
            return save(config)

        with mock.patch.object(cache, "write", side_effect=changed_before_write):
            with self.assertRaisesRegex(ValueError, "태그 파일이 변경"):
                self.migrate(tags_cache=cache)
        self.assertEqual(self.tags.read_bytes(), external)
        self.assertEqual(self.snapshot(), before)
        self.assertIsNone(cache.signature)

    def test_batch_tag_cache_undo_restores_bytes_and_invalidates_snapshot(self):
        self.populate()
        config = json.loads(self.tags.read_bytes())
        config["unknown"] = {"한국어": "합성 값"}
        self.tags.write_text(json.dumps(config, ensure_ascii=False, indent=4), encoding="utf-8")
        before, tags_before = self.snapshot(), self.tags.read_bytes()
        cache = GalleryTagCache(self.tags)
        undo = self.migrate(tags_cache=cache)
        undo()
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.tags.read_bytes(), tags_before)
        self.assertIsNone(cache.signature)
        self.migrate(tags_cache=cache)
        self.assertEqual(json.loads(self.tags.read_bytes())["image_tags"], {self.new: "star"})

    def test_batch_tag_cache_undo_preserves_external_edit_and_both_images(self):
        cache = GalleryTagCache(self.tags)
        undo = self.migrate(tags_cache=cache)
        external = b'{"external": "do not overwrite"}'
        self.tags.write_bytes(external)
        with self.assertRaises(WebpReferenceRollbackError) as raised:
            undo()
        self.assertTrue(raised.exception.retain_target)
        self.assertEqual(self.tags.read_bytes(), external)
        self.assertIsNone(cache.signature)

    def test_batch_tag_cache_failed_save_rolls_back_and_invalidates(self):
        self.populate()
        before, tags_before = self.snapshot(), self.tags.read_bytes()
        cache = GalleryTagCache(self.tags)
        with mock.patch("naim.storage.webp_conversion._restore_bytes", side_effect=OSError("synthetic save failure")):
            with self.assertRaises(OSError):
                self.migrate(tags_cache=cache)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.tags.read_bytes(), tags_before)
        self.assertIsNone(cache.signature)

    def test_post_save_external_edit_keeps_both_images_in_real_conversion(self):
        from PIL import Image
        from naim.images.webp_conversion import convert_png_to_webp
        from naim.storage import webp_conversion as references

        Image.new("RGBA", (8, 8), (30, 60, 90, 150)).save(self.source, "PNG")
        self.target.unlink()
        self.populate()
        before = self.snapshot()
        cache = GalleryTagCache(self.tags)
        save = references._restore_bytes
        external = json.dumps({"external": "preserved", "image_tags": {self.old: "external-tag"}}).encode("utf-8")

        def changed_after_write(path, data):
            written = save(path, data)
            self.tags.write_bytes(external)
            return written

        with mock.patch.object(references, "_restore_bytes", side_effect=changed_after_write):
            result = convert_png_to_webp(self.source, before_delete=lambda source, target: self.migrate(tags_cache=cache))
        self.assertEqual(result["status"], "skipped", result)
        self.assertTrue(self.source.is_file())
        self.assertTrue(self.target.is_file())
        self.assertEqual(self.tags.read_bytes(), external)
        self.assertEqual(self.snapshot(), before)
        self.assertIsNone(cache.signature)

    def test_post_save_stat_failure_requires_webp_retention(self):
        from naim.storage import webp_conversion as references

        self.populate()
        before = self.snapshot()
        cache = GalleryTagCache(self.tags)
        save = references._restore_bytes

        def unavailable_after_write(path, data):
            written = save(path, data)
            cache.current_signature = mock.Mock(side_effect=OSError("synthetic post-save stat failure"))
            return written

        with mock.patch.object(references, "_restore_bytes", side_effect=unavailable_after_write):
            with self.assertRaises(WebpReferenceRollbackError) as raised:
                self.migrate(tags_cache=cache)
        self.assertTrue(raised.exception.retain_target)
        self.assertEqual(json.loads(self.tags.read_bytes())["image_tags"], {self.new: "star"})
        self.assertEqual(self.snapshot(), before)
        self.assertIsNone(cache.signature)


if __name__ == "__main__":
    unittest.main()
