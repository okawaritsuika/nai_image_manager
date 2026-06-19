import tempfile
import unittest
import os
import sys
import json
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import utils


class GalleryPromptIndexTests(unittest.TestCase):
    def test_prompt_index_schema_created(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with mock.patch.object(utils, "get_app_dir", return_value=tmpdir):
                db = utils.HistoryDB()
                try:
                    cur = db.conn.cursor()
                    cur.execute("PRAGMA table_info(gallery_prompt_index)")
                    columns = {row[1] for row in cur.fetchall()}

                    self.assertTrue({
                        "rel_path",
                        "folder_path",
                        "file_name",
                        "mode",
                        "mtime",
                        "prompt_text",
                        "normalized_text",
                        "text_bytes",
                        "indexed_at",
                    }.issubset(columns))
                finally:
                    db.close()

    def test_prompt_index_upsert_status_search_and_clear(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with mock.patch.object(utils, "get_app_dir", return_value=tmpdir):
                db = utils.HistoryDB()
                try:
                    db.upsert_gallery_prompt_records([
                        {
                            "rel_path": "1_Solo/A/a.png",
                            "folder_path": "1_Solo/A",
                            "file_name": "a.png",
                            "mode": "general",
                            "mtime": 10.0,
                            "prompt_text": "blue sky, white dress",
                            "normalized_text": "blue sky white dress",
                        },
                        {
                            "rel_path": "1_Solo/A/b.png",
                            "folder_path": "1_Solo/A",
                            "file_name": "b.png",
                            "mode": "general",
                            "mtime": 20.0,
                            "prompt_text": "blue eyes",
                            "normalized_text": "blue eyes",
                        },
                        {
                            "rel_path": "1_Solo/B/c.png",
                            "folder_path": "1_Solo/B",
                            "file_name": "c.png",
                            "mode": "general",
                            "mtime": 30.0,
                            "prompt_text": "red eyes",
                            "normalized_text": "red eyes",
                        },
                    ])

                    status = db.get_gallery_prompt_index_status("1_Solo", "general")
                    self.assertEqual(status["indexed_images"], 3)
                    self.assertGreater(status["text_bytes"], 0)

                    rows = db.search_gallery_prompt_index(["blue"], "1_Solo", "general")
                    self.assertEqual(
                        {row["rel_path"] for row in rows},
                        {"1_Solo/A/a.png", "1_Solo/A/b.png"},
                    )

                    db.clear_gallery_prompt_index("1_Solo/A")
                    status = db.get_gallery_prompt_index_status("1_Solo", "general")
                    self.assertEqual(status["indexed_images"], 1)
                finally:
                    db.close()

    def test_prompt_index_all_mode_excludes_trash(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with mock.patch.object(utils, "get_app_dir", return_value=tmpdir):
                db = utils.HistoryDB()
                try:
                    db.upsert_gallery_prompt_records([
                        {
                            "rel_path": "1_Solo/A/a.png",
                            "folder_path": "1_Solo/A",
                            "file_name": "a.png",
                            "mode": "general",
                            "mtime": 10.0,
                            "prompt_text": "blue sky",
                            "normalized_text": "blue sky",
                        },
                        {
                            "rel_path": "_TRASH/A/old.png",
                            "folder_path": "_TRASH/A",
                            "file_name": "old.png",
                            "mode": "trash",
                            "mtime": 20.0,
                            "prompt_text": "blue sky",
                            "normalized_text": "blue sky",
                        },
                    ])

                    status = db.get_gallery_prompt_index_status("", "all")
                    self.assertEqual(status["indexed_images"], 1)

                    rows = db.search_gallery_prompt_index(["blue"], "", "all")
                    self.assertEqual([row["rel_path"] for row in rows], ["1_Solo/A/a.png"])
                finally:
                    db.close()

    def test_prompt_index_search_accepts_multiple_scope_paths(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with mock.patch.object(utils, "get_app_dir", return_value=tmpdir):
                db = utils.HistoryDB()
                try:
                    db.upsert_gallery_prompt_records([
                        {
                            "rel_path": "1_Solo/A/a.png",
                            "folder_path": "1_Solo/A",
                            "file_name": "a.png",
                            "mode": "general",
                            "mtime": 10.0,
                            "prompt_text": "blue sky",
                            "normalized_text": "blue sky",
                        },
                        {
                            "rel_path": "1_Solo/B/b.png",
                            "folder_path": "1_Solo/B",
                            "file_name": "b.png",
                            "mode": "general",
                            "mtime": 20.0,
                            "prompt_text": "blue sky",
                            "normalized_text": "blue sky",
                        },
                        {
                            "rel_path": "1_Solo/C/c.png",
                            "folder_path": "1_Solo/C",
                            "file_name": "c.png",
                            "mode": "general",
                            "mtime": 30.0,
                            "prompt_text": "blue sky",
                            "normalized_text": "blue sky",
                        },
                    ])

                    rows = db.search_gallery_prompt_index(
                        ["blue"],
                        ["1_Solo/A", "1_Solo/C"],
                        "general",
                    )

                    self.assertEqual(
                        [row["rel_path"] for row in rows],
                        ["1_Solo/A/a.png", "1_Solo/C/c.png"],
                    )
                finally:
                    db.close()

    def test_prompt_index_profiles_can_be_managed(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with mock.patch.object(utils, "get_app_dir", return_value=tmpdir):
                db = utils.HistoryDB()
                try:
                    profile = db.upsert_gallery_prompt_index_profile(
                        name="Solo blue archive",
                        mode="general",
                        scope_paths=["1_Solo/A", "1_Solo/B"],
                        rel_paths=["1_Solo/A/a.png", "1_Solo/B/b.png"],
                        text_bytes=1234,
                    )

                    profiles = db.list_gallery_prompt_index_profiles()
                    self.assertEqual(len(profiles), 1)
                    self.assertEqual(profiles[0]["id"], profile["id"])
                    self.assertEqual(profiles[0]["name"], "Solo blue archive")
                    self.assertEqual(json.loads(profiles[0]["scope_paths_json"]), ["1_Solo/A", "1_Solo/B"])
                    self.assertEqual(profiles[0]["image_count"], 2)
                    self.assertEqual(profiles[0]["text_bytes"], 1234)

                    items = db.get_gallery_prompt_index_profile_paths(profile["id"])
                    self.assertEqual(items, ["1_Solo/A/a.png", "1_Solo/B/b.png"])

                    self.assertTrue(db.delete_gallery_prompt_index_profile(profile["id"]))
                    self.assertEqual(db.list_gallery_prompt_index_profiles(), [])
                finally:
                    db.close()

    def test_prompt_index_profile_search_limits_results_to_profile_items(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with mock.patch.object(utils, "get_app_dir", return_value=tmpdir):
                db = utils.HistoryDB()
                try:
                    db.upsert_gallery_prompt_records([
                        {
                            "rel_path": "1_Solo/A/a.png",
                            "folder_path": "1_Solo/A",
                            "file_name": "a.png",
                            "mode": "general",
                            "mtime": 10.0,
                            "prompt_text": "blue sky",
                            "normalized_text": "blue sky",
                        },
                        {
                            "rel_path": "1_Solo/B/b.png",
                            "folder_path": "1_Solo/B",
                            "file_name": "b.png",
                            "mode": "general",
                            "mtime": 20.0,
                            "prompt_text": "blue sky",
                            "normalized_text": "blue sky",
                        },
                    ])
                    profile = db.upsert_gallery_prompt_index_profile(
                        name="A only",
                        mode="general",
                        scope_paths=["1_Solo/A"],
                        rel_paths=["1_Solo/A/a.png"],
                        text_bytes=100,
                    )

                    rows = db.search_gallery_prompt_index_profile(profile["id"], ["blue"])
                    self.assertEqual([row["rel_path"] for row in rows], ["1_Solo/A/a.png"])
                finally:
                    db.close()

    def test_clear_all_prompt_index_data_removes_cache_and_profiles(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with mock.patch.object(utils, "get_app_dir", return_value=tmpdir):
                db = utils.HistoryDB()
                try:
                    db.upsert_gallery_prompt_records([
                        {
                            "rel_path": "1_Solo/A/a.png",
                            "folder_path": "1_Solo/A",
                            "file_name": "a.png",
                            "mode": "general",
                            "mtime": 10.0,
                            "prompt_text": "blue sky",
                            "normalized_text": "blue sky",
                        },
                    ])
                    db.upsert_gallery_prompt_index_profile(
                        name="A only",
                        mode="general",
                        scope_paths=["1_Solo/A"],
                        rel_paths=["1_Solo/A/a.png"],
                        text_bytes=100,
                    )

                    db.clear_all_gallery_prompt_index_data()

                    self.assertEqual(db.get_gallery_prompt_index_status("", "all")["indexed_images"], 0)
                    self.assertEqual(db.list_gallery_prompt_index_profiles(), [])
                finally:
                    db.close()

    def test_prompt_index_existing_mtimes_are_available(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with mock.patch.object(utils, "get_app_dir", return_value=tmpdir):
                db = utils.HistoryDB()
                try:
                    db.upsert_gallery_prompt_records([
                        {
                            "rel_path": "1_Solo/A/a.png",
                            "folder_path": "1_Solo/A",
                            "file_name": "a.png",
                            "mode": "general",
                            "mtime": 10.5,
                            "prompt_text": "blue sky",
                            "normalized_text": "blue sky",
                        },
                    ])

                    mtimes = db.get_gallery_prompt_index_mtimes(["1_Solo/A/a.png", "1_Solo/A/new.png"])
                    self.assertEqual(mtimes, {"1_Solo/A/a.png": 10.5})
                finally:
                    db.close()


if __name__ == "__main__":
    unittest.main()
