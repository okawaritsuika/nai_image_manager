import unittest
from unittest.mock import patch

import app


class FakeHistoryDB:
    def __init__(self, full_index=True):
        self.full_index = full_index
        self.closed = False
        self.calls = []

    def has_full_gallery_index(self):
        self.calls.append(("has_full_gallery_index",))
        return self.full_index

    def remove_gallery_image_record(self, rel_path):
        self.calls.append(("remove_gallery_image_record", rel_path))

    def upsert_gallery_image_file(self, file_path, classified_root=None, **overrides):
        self.calls.append(("upsert_gallery_image_file", file_path, classified_root, overrides))
        return {"rel_path": overrides.get("rel_path") or "new.png"}

    def rebuild_gallery_folder_summaries(self):
        self.calls.append(("rebuild_gallery_folder_summaries",))

    def gallery_image_record_exists(self, rel_path):
        self.calls.append(("gallery_image_record_exists", rel_path))
        return True

    def close(self):
        self.closed = True


class GalleryIndexRefreshTests(unittest.TestCase):
    def test_existing_gallery_rel_path_uses_actual_filesystem_casing(self):
        def fake_listdir(path):
            normalized = path.replace("\\", "/").rstrip("/")
            if normalized == "C:/gallery":
                return ["1_Solo"]
            if normalized == "C:/gallery/1_Solo":
                return ["Katsuragi_Lilja_Dakimakura"]
            if normalized == "C:/gallery/1_Solo/Katsuragi_Lilja_Dakimakura":
                return ["canvas_test.png"]
            return []

        with patch.object(app, "CLASSIFIED_DIR", "C:/gallery"), \
             patch.object(app.os, "listdir", side_effect=fake_listdir), \
             patch.object(app.os.path, "exists", return_value=True):
            rel_path = app.get_existing_gallery_rel_path(
                "C:/gallery/1_Solo/Katsuragi_Lilja_dakimakura/canvas_test.png"
            )

        self.assertEqual(rel_path, "1_Solo/Katsuragi_Lilja_Dakimakura/canvas_test.png")

    def test_refresh_removes_case_mismatched_path_and_upserts_actual_path(self):
        fake_db = FakeHistoryDB(full_index=True)

        with patch.object(app, "CLASSIFIED_DIR", "C:/gallery"), \
             patch.object(app, "get_existing_gallery_rel_path", return_value="folder/RealCase.png"), \
             patch.object(app.utils, "HistoryDB", return_value=fake_db), \
             patch.object(app, "load_gallery_image_tags_config", return_value={"image_tags": {}, "tags": []}), \
             patch.object(app, "get_gallery_image_tag_for_path", return_value=""):
            result = app.refresh_gallery_index_for_file_change(
                "C:/gallery/folder/realcase.png",
                rel_path="folder/realcase.png",
                mode="general",
            )

        self.assertTrue(result["index_updated"])
        self.assertEqual(
            fake_db.calls,
            [
                ("has_full_gallery_index",),
                ("remove_gallery_image_record", "folder/realcase.png"),
                (
                    "upsert_gallery_image_file",
                    "C:/gallery/folder/realcase.png",
                    "C:/gallery",
                    {"rel_path": "folder/RealCase.png", "mode": "general", "gallery_tag": ""},
                ),
                ("rebuild_gallery_folder_summaries",),
                ("gallery_image_record_exists", "folder/RealCase.png"),
            ],
        )

    def test_gallery_index_rebuild_does_not_skip_upscaled_directory(self):
        with patch.object(app.os.path, "exists", return_value=True):
            self.assertFalse(app.should_skip_gallery_index_directory("C:/gallery/folder/_upscaled"))
            self.assertFalse(app.should_skip_gallery_index_child_directory("C:/gallery/folder", "_upscaled"))

    def test_gallery_index_rebuild_skips_other_ignored_directories(self):
        with patch.object(app.os.path, "exists", return_value=True):
            self.assertTrue(app.should_skip_gallery_index_directory("C:/gallery/folder"))
            self.assertTrue(app.should_skip_gallery_index_child_directory("C:/gallery", "folder"))

    def test_refresh_removes_old_path_and_upserts_new_path_when_full_index_exists(self):
        fake_db = FakeHistoryDB(full_index=True)

        with patch.object(app, "get_existing_gallery_rel_path", return_value="folder/new.png"), \
             patch.object(app.utils, "HistoryDB", return_value=fake_db), \
             patch.object(app, "load_gallery_image_tags_config", return_value={"image_tags": {}, "tags": []}), \
             patch.object(app, "get_gallery_image_tag_for_path", return_value=""):
            result = app.refresh_gallery_index_for_file_change(
                "C:/gallery/new.png",
                rel_path="folder/new.png",
                old_rel_path="_TRASH/old.png",
                mode="general",
            )

        self.assertTrue(result["index_updated"])
        self.assertTrue(result["index_verified"])
        self.assertEqual(
            fake_db.calls,
            [
                ("has_full_gallery_index",),
                ("remove_gallery_image_record", "_TRASH/old.png"),
                (
                    "upsert_gallery_image_file",
                    "C:/gallery/new.png",
                    app.CLASSIFIED_DIR,
                    {"rel_path": "folder/new.png", "mode": "general", "gallery_tag": ""},
                ),
                ("rebuild_gallery_folder_summaries",),
                ("gallery_image_record_exists", "folder/new.png"),
            ],
        )
        self.assertTrue(fake_db.closed)

    def test_refresh_starts_rebuild_when_full_index_is_missing(self):
        fake_db = FakeHistoryDB(full_index=False)

        with patch.object(app.utils, "HistoryDB", return_value=fake_db), \
             patch.object(app, "start_gallery_index_rebuild_background", return_value=(True, True)) as rebuild:
            result = app.refresh_gallery_index_for_file_change(
                "C:/gallery/new.png",
                rel_path="folder/new.png",
            )

        self.assertFalse(result["index_updated"])
        self.assertTrue(result["index_rebuild_started"])
        self.assertTrue(result["index_rebuild_running"])
        rebuild.assert_called_once_with(auto=True)
        self.assertEqual(fake_db.calls, [("has_full_gallery_index",)])
        self.assertTrue(fake_db.closed)


if __name__ == "__main__":
    unittest.main()
