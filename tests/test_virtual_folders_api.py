import os
import tempfile
import unittest

import app as gallery_app
from utils import HistoryDB


class VirtualFoldersApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.temp_dir.name, "history.sqlite")
        self.classified_dir = os.path.join(self.temp_dir.name, "TOTAL_CLASSIFIED")
        os.makedirs(self.classified_dir, exist_ok=True)
        self.previous_classified_dir = gallery_app.CLASSIFIED_DIR
        gallery_app.CLASSIFIED_DIR = self.classified_dir
        gallery_app.app.config["TESTING"] = True
        gallery_app.app.config["GALLERY_HISTORY_DB_PATH"] = self.db_path
        self.client = gallery_app.app.test_client()

    def tearDown(self):
        gallery_app.CLASSIFIED_DIR = self.previous_classified_dir
        gallery_app.app.config.pop("GALLERY_HISTORY_DB_PATH", None)
        self.temp_dir.cleanup()

    def test_nested_crud_cycle_and_child_delete_guard(self):
        root_response = self.client.post(
            "/api/gallery/virtual_folders",
            json={"name": "Root", "query": "", "mode": "all"},
        )
        self.assertEqual(root_response.status_code, 201)
        root = root_response.get_json()["folder"]

        child_response = self.client.post(
            "/api/gallery/virtual_folders",
            json={"name": "Child", "parent_id": root["id"], "query": "cat"},
        )
        self.assertEqual(child_response.status_code, 201)
        child = child_response.get_json()["folder"]
        self.assertEqual(child["parent_id"], root["id"])

        cycle_response = self.client.patch(
            f"/api/gallery/virtual_folders/{root['id']}",
            json={"parent_id": child["id"]},
        )
        self.assertEqual(cycle_response.status_code, 409)

        delete_parent_response = self.client.delete(
            f"/api/gallery/virtual_folders/{root['id']}"
        )
        self.assertEqual(delete_parent_response.status_code, 409)

        move_response = self.client.post(
            f"/api/gallery/virtual_folders/{child['id']}/reparent",
            json={"parent_id": None},
        )
        self.assertEqual(move_response.status_code, 200)
        self.assertIsNone(move_response.get_json()["folder"]["parent_id"])

        self.assertEqual(
            self.client.delete(f"/api/gallery/virtual_folders/{child['id']}").status_code,
            200,
        )
        self.assertEqual(
            self.client.delete(f"/api/gallery/virtual_folders/{root['id']}").status_code,
            200,
        )

    def test_resolve_uses_saved_search_and_is_dynamic(self):
        db = HistoryDB(self.db_path)
        db.upsert_gallery_prompt_records(
            [
                {
                    "rel_path": "1_Solo/a.png",
                    "folder_path": "1_Solo",
                    "file_name": "a.png",
                    "mode": "general",
                    "prompt_text": "red hat",
                    "normalized_text": "red hat",
                }
            ]
        )
        db.close()

        create_response = self.client.post(
            "/api/gallery/virtual_folders",
            json={"name": "Red", "query": "red", "scope_paths": [], "mode": "all"},
        )
        self.assertEqual(create_response.status_code, 201)
        folder_id = create_response.get_json()["folder"]["id"]

        first = self.client.get(f"/api/gallery/virtual_folders/{folder_id}/resolve")
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.get_json()["image_paths"], ["1_Solo/a.png"])
        self.assertTrue(first.get_json()["indexed"])

        summary = self.client.get(
            f"/api/gallery/virtual_folders/{folder_id}/resolve?summary=1"
        )
        self.assertEqual(summary.status_code, 200)
        summary_payload = summary.get_json()
        self.assertEqual(summary_payload["total_matches"], 1)
        self.assertEqual(summary_payload["thumb"], "1_Solo/a.png")
        self.assertEqual(summary_payload["image_paths"], [])
        self.assertEqual(summary_payload["folder_counts"], {})

        db = HistoryDB(self.db_path)
        db.upsert_gallery_prompt_records(
            [
                {
                    "rel_path": "1_Solo/b.png",
                    "folder_path": "1_Solo",
                    "file_name": "b.png",
                    "mode": "general",
                    "prompt_text": "red scarf",
                    "normalized_text": "red scarf",
                }
            ]
        )
        db.close()

        second = self.client.get(f"/api/gallery/virtual_folders/{folder_id}/search")
        self.assertEqual(second.status_code, 200)
        self.assertEqual(
            second.get_json()["image_paths"], ["1_Solo/a.png", "1_Solo/b.png"]
        )

        summary_after_update = self.client.get(
            f"/api/gallery/virtual_folders/{folder_id}/search?summary=true"
        )
        self.assertEqual(summary_after_update.status_code, 200)
        self.assertEqual(summary_after_update.get_json()["total_matches"], 2)
        self.assertEqual(
            summary_after_update.get_json()["thumb"], "1_Solo/a.png"
        )
        self.assertEqual(summary_after_update.get_json()["image_paths"], [])

    def test_uncategorized_summary_accepts_root_and_folder_owner(self):
        db = HistoryDB(self.db_path)
        db.upsert_gallery_prompt_records(
            [
                {
                    "rel_path": "1_Solo/a.png",
                    "folder_path": "1_Solo",
                    "file_name": "a.png",
                    "mode": "general",
                    "prompt_text": "red blue",
                    "normalized_text": "red blue",
                },
                {
                    "rel_path": "1_Solo/b.png",
                    "folder_path": "1_Solo",
                    "file_name": "b.png",
                    "mode": "general",
                    "prompt_text": "green",
                    "normalized_text": "green",
                },
            ]
        )
        root = db.create_gallery_virtual_folder("Root")
        db.create_gallery_virtual_folder("Red", "red", parent_id=root["id"])
        db.close()

        root_summary = self.client.get(
            "/api/gallery/virtual_folders/uncategorized_summary?owner_id=root"
        )
        self.assertEqual(root_summary.status_code, 200)
        self.assertEqual(root_summary.get_json()["total_matches"], 1)
        self.assertEqual(root_summary.get_json()["thumb"], "1_Solo/b.png")
        self.assertTrue(root_summary.get_json()["indexed"])

        folder_summary = self.client.get(
            f"/api/gallery/virtual_folders/{root['id']}/uncategorized_summary"
        )
        self.assertEqual(folder_summary.status_code, 200)
        self.assertEqual(folder_summary.get_json()["total_matches"], 1)
        self.assertEqual(folder_summary.get_json()["thumb"], "1_Solo/b.png")


if __name__ == "__main__":
    unittest.main()
