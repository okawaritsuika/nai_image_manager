import os
import sqlite3
import tempfile
import unittest

from utils import HistoryDB, parse_gallery_prompt_search_query


class VirtualFoldersDbTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.temp_dir.name, "history.sqlite")
        self.db = HistoryDB(self.db_path)

    def tearDown(self):
        self.db.close()
        self.temp_dir.cleanup()

    def test_nested_create_and_parent_filtered_list(self):
        root = self.db.create_gallery_virtual_folder("Root")
        child = self.db.create_gallery_virtual_folder("Child", parent_id=root["id"])
        grandchild = self.db.create_gallery_virtual_folder(
            "Grandchild", parent_id=child["id"]
        )

        self.assertCountEqual(
            [item["id"] for item in self.db.list_gallery_virtual_folders()],
            [root["id"], child["id"], grandchild["id"]],
        )
        self.assertEqual(
            [item["id"] for item in self.db.list_gallery_virtual_folders(root["id"])],
            [child["id"]],
        )
        self.assertEqual(
            self.db.get_gallery_virtual_folder(grandchild["id"])["parent_id"],
            child["id"],
        )

    def test_duplicate_sibling_and_missing_parent_rejected(self):
        root = self.db.create_gallery_virtual_folder("Root")
        with self.assertRaises(ValueError):
            self.db.create_gallery_virtual_folder("root")
        with self.assertRaises(ValueError):
            self.db.create_gallery_virtual_folder("Missing", parent_id="missing-id")

        child = self.db.create_gallery_virtual_folder("Child", parent_id=root["id"])
        with self.assertRaises(ValueError):
            self.db.create_gallery_virtual_folder("child", parent_id=root["id"])
        with self.assertRaises(ValueError):
            self.db.update_gallery_virtual_folder(child["id"], parent_id="missing-id")

    def test_self_and_descendant_cycles_rejected(self):
        root = self.db.create_gallery_virtual_folder("Root")
        child = self.db.create_gallery_virtual_folder("Child", parent_id=root["id"])
        grandchild = self.db.create_gallery_virtual_folder(
            "Grandchild", parent_id=child["id"]
        )

        with self.assertRaises(ValueError):
            self.db.update_gallery_virtual_folder(child["id"], parent_id=child["id"])
        with self.assertRaises(ValueError):
            self.db.update_gallery_virtual_folder(root["id"], parent_id=grandchild["id"])

    def test_reparent_to_root_and_delete_guards(self):
        root = self.db.create_gallery_virtual_folder("Root")
        child = self.db.create_gallery_virtual_folder("Child", parent_id=root["id"])
        leaf = self.db.create_gallery_virtual_folder("Leaf", parent_id=child["id"])

        with self.assertRaises(ValueError):
            self.db.delete_gallery_virtual_folder(root["id"])

        moved = self.db.reparent_gallery_virtual_folder(child["id"], parent_id=None)
        self.assertIsNone(moved["parent_id"])
        self.assertEqual(
            self.db.get_gallery_virtual_folder(leaf["id"])["parent_id"], child["id"]
        )
        self.assertTrue(self.db.delete_gallery_virtual_folder(leaf["id"]))
        self.assertTrue(self.db.delete_gallery_virtual_folder(child["id"]))
        self.assertTrue(self.db.delete_gallery_virtual_folder(root["id"]))
        self.assertFalse(self.db.delete_gallery_virtual_folder(root["id"]))

    def test_search_configuration_persists_and_explicit_path_isolated(self):
        folder = self.db.create_gallery_virtual_folder(
            "Saved Search",
            query="red hair",
            scope_paths=["1_Solo", "_R-18", "1_Solo"],
            mode="r18",
            order_index=4,
        )
        loaded = self.db.get_gallery_virtual_folder(folder["id"])
        self.assertEqual(loaded["query"], "red hair")
        self.assertEqual(loaded["scope_paths"], ["1_Solo", "_R-18"])
        self.assertEqual(loaded["mode"], "r18")
        self.assertEqual(loaded["order_index"], 4)
        self.assertEqual(loaded["scope_paths_json"], '["1_Solo", "_R-18"]')

        second_path = os.path.join(self.temp_dir.name, "other.sqlite")
        second = HistoryDB(second_path)
        try:
            self.assertEqual(second.db_path, os.path.abspath(second_path))
            self.assertEqual(second.list_gallery_virtual_folders(), [])
            second.create_gallery_virtual_folder("Only Other DB")
            self.assertEqual(len(second.list_gallery_virtual_folders()), 1)
            self.assertEqual(len(self.db.list_gallery_virtual_folders()), 1)
        finally:
            second.close()

    def test_prompt_summary_counts_matches_and_keeps_first_thumbnail(self):
        self.db.upsert_gallery_prompt_records(
            [
                {
                    "rel_path": "1_Solo/a.png",
                    "folder_path": "1_Solo",
                    "file_name": "a.png",
                    "mode": "general",
                    "prompt_text": "red hat",
                    "normalized_text": "red hat",
                },
                {
                    "rel_path": "1_Solo/b.png",
                    "folder_path": "1_Solo",
                    "file_name": "b.png",
                    "mode": "general",
                    "prompt_text": "blue hat",
                    "normalized_text": "blue hat",
                },
                {
                    "rel_path": "1_Solo/c.png",
                    "folder_path": "1_Solo",
                    "file_name": "c.png",
                    "mode": "general",
                    "prompt_text": "red scarf",
                    "normalized_text": "red scarf",
                },
            ]
        )

        summary = self.db.summarize_gallery_prompt_index(
            [[{"text": "red", "partial": False}]], "", "all"
        )
        self.assertEqual(summary, {"total_matches": 2, "thumb": "1_Solo/a.png"})

        summary = self.db.summarize_gallery_prompt_index(
            [
                [
                    {"text": "red", "partial": False},
                    {"text": "scarf", "partial": False},
                ],
                [{"text": "blue", "partial": False}],
            ],
            "",
            "all",
        )
        self.assertEqual(summary, {"total_matches": 2, "thumb": "1_Solo/b.png"})

    def test_virtual_uncategorized_summary_excludes_descendant_union_once(self):
        self.db.upsert_gallery_prompt_records(
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
                    "prompt_text": "red hat",
                    "normalized_text": "red hat",
                },
                {
                    "rel_path": "1_Solo/c.png",
                    "folder_path": "1_Solo",
                    "file_name": "c.png",
                    "mode": "general",
                    "prompt_text": "blue hat",
                    "normalized_text": "blue hat",
                },
                {
                    "rel_path": "1_Solo/d.png",
                    "folder_path": "1_Solo",
                    "file_name": "d.png",
                    "mode": "general",
                    "prompt_text": "green hat",
                    "normalized_text": "green hat",
                },
            ]
        )

        root = self.db.create_gallery_virtual_folder("Root")
        red = self.db.create_gallery_virtual_folder("Red", "red", parent_id=root["id"])
        self.db.create_gallery_virtual_folder("Blue", "blue", parent_id=red["id"])

        root_summary = self.db.summarize_gallery_virtual_uncategorized()
        self.assertEqual(root_summary["total_matches"], 1)
        self.assertEqual(root_summary["thumb"], "1_Solo/d.png")
        self.assertTrue(root_summary["indexed"])

        folder_summary = self.db.summarize_gallery_virtual_uncategorized(root["id"])
        self.assertEqual(folder_summary["total_matches"], 1)
        self.assertEqual(folder_summary["thumb"], "1_Solo/d.png")

        red_summary = self.db.summarize_gallery_virtual_uncategorized(red["id"])
        self.assertEqual(red_summary["total_matches"], 1)
        self.assertEqual(red_summary["thumb"], "1_Solo/b.png")

    def test_virtual_uncategorized_summary_returns_zero_without_unassigned(self):
        self.db.upsert_gallery_prompt_records(
            [
                {
                    "rel_path": "1_Solo/a.png",
                    "folder_path": "1_Solo",
                    "file_name": "a.png",
                    "mode": "general",
                    "prompt_text": "red",
                    "normalized_text": "red",
                }
            ]
        )
        root = self.db.create_gallery_virtual_folder("Root")
        self.db.create_gallery_virtual_folder("Red", "red", parent_id=root["id"])

        summary = self.db.summarize_gallery_virtual_uncategorized(root["id"])
        self.assertEqual(summary["total_matches"], 0)
        self.assertIsNone(summary["thumb"])
        self.assertTrue(summary["indexed"])

    def test_virtual_uncategorized_summary_is_not_indexed_after_clear(self):
        self.db.upsert_gallery_prompt_records(
            [{
                "rel_path": "1_Solo/a.png",
                "folder_path": "1_Solo",
                "file_name": "a.png",
                "mode": "general",
                "prompt_text": "red",
                "normalized_text": "red",
            }]
        )
        root = self.db.create_gallery_virtual_folder("Root")
        self.db.clear_gallery_prompt_index()

        summary = self.db.summarize_gallery_virtual_uncategorized(root["id"])
        self.assertFalse(summary["indexed"])
        self.assertEqual(summary["reason"], "prompt_index_unavailable")
        self.assertEqual(summary["total_matches"], 0)
        self.assertIsNone(summary["thumb"])

    def test_virtual_folder_cache_hits_and_survives_reopen(self):
        self.db.upsert_gallery_prompt_records(
            [
                {
                    "rel_path": "1_Solo/a.png",
                    "folder_path": "1_Solo",
                    "file_name": "a.png",
                    "mode": "general",
                    "prompt_text": "red hat",
                    "normalized_text": "red hat",
                },
                {
                    "rel_path": "1_Solo/b.png",
                    "folder_path": "1_Solo",
                    "file_name": "b.png",
                    "mode": "general",
                    "prompt_text": "red scarf",
                    "normalized_text": "red scarf",
                },
            ]
        )
        folder = self.db.create_gallery_virtual_folder("Red", "red")
        terms = [[{"text": "red", "partial": False}]]

        first = self.db.resolve_gallery_virtual_folder_cache(folder, terms)
        self.assertFalse(first["cached"])
        self.assertEqual(first["total_matches"], 2)
        self.assertEqual(
            self.db.conn.execute(
                "SELECT COUNT(*) FROM gallery_virtual_folder_cache_items WHERE folder_id = ?",
                (folder["id"],),
            ).fetchone()[0],
            2,
        )

        second = self.db.resolve_gallery_virtual_folder_cache(folder, terms)
        self.assertTrue(second["cached"])
        self.assertEqual([row["rel_path"] for row in second["rows"]], ["1_Solo/a.png", "1_Solo/b.png"])

        db_path = self.db.db_path
        self.db.close()
        reopened = HistoryDB(db_path)
        try:
            reopened_folder = reopened.get_gallery_virtual_folder(folder["id"])
            reopened_result = reopened.resolve_gallery_virtual_folder_cache(reopened_folder, terms)
            self.assertTrue(reopened_result["cached"])
            self.assertEqual(reopened_result["total_matches"], 2)
        finally:
            reopened.close()
            self.db = HistoryDB(db_path)

    def test_virtual_folder_cache_invalidates_on_index_or_folder_change_and_delete_cleans(self):
        self.db.upsert_gallery_prompt_records(
            [{
                "rel_path": "1_Solo/a.png",
                "folder_path": "1_Solo",
                "file_name": "a.png",
                "mode": "general",
                "prompt_text": "red",
                "normalized_text": "red",
            }]
        )
        folder = self.db.create_gallery_virtual_folder("Red", "red")
        terms = [[{"text": "red", "partial": False}]]
        self.assertFalse(self.db.resolve_gallery_virtual_folder_cache(folder, terms)["cached"])
        self.assertTrue(self.db.resolve_gallery_virtual_folder_cache(folder, terms)["cached"])

        self.db.upsert_gallery_prompt_records(
            [{
                "rel_path": "1_Solo/b.png",
                "folder_path": "1_Solo",
                "file_name": "b.png",
                "mode": "general",
                "prompt_text": "red scarf",
                "normalized_text": "red scarf",
            }]
        )
        changed_index_folder = self.db.get_gallery_virtual_folder(folder["id"])
        rebuilt = self.db.resolve_gallery_virtual_folder_cache(changed_index_folder, terms)
        self.assertFalse(rebuilt["cached"])
        self.assertEqual(rebuilt["total_matches"], 2)

        updated = self.db.update_gallery_virtual_folder(folder["id"], query="scarf")
        scarf_terms = [[{"text": "scarf", "partial": False}]]
        changed_folder = self.db.resolve_gallery_virtual_folder_cache(updated, scarf_terms)
        self.assertFalse(changed_folder["cached"])
        self.assertEqual(changed_folder["total_matches"], 1)

        self.assertTrue(self.db.delete_gallery_virtual_folder(folder["id"]))
        self.assertEqual(
            self.db.conn.execute(
                "SELECT COUNT(*) FROM gallery_virtual_folder_cache_meta WHERE folder_id = ?",
                (folder["id"],),
            ).fetchone()[0],
            0,
        )
        self.assertEqual(
            self.db.conn.execute(
                "SELECT COUNT(*) FROM gallery_virtual_folder_cache_items WHERE folder_id = ?",
                (folder["id"],),
            ).fetchone()[0],
            0,
        )

    def test_uncategorized_reuses_descendant_cache_and_keeps_union_exact(self):
        self.db.upsert_gallery_prompt_records(
            [
                {"rel_path": "1_Solo/a.png", "folder_path": "1_Solo", "file_name": "a.png", "mode": "general", "prompt_text": "red blue", "normalized_text": "red blue"},
                {"rel_path": "1_Solo/b.png", "folder_path": "1_Solo", "file_name": "b.png", "mode": "general", "prompt_text": "red", "normalized_text": "red"},
                {"rel_path": "1_Solo/c.png", "folder_path": "1_Solo", "file_name": "c.png", "mode": "general", "prompt_text": "blue", "normalized_text": "blue"},
                {"rel_path": "1_Solo/d.png", "folder_path": "1_Solo", "file_name": "d.png", "mode": "general", "prompt_text": "green", "normalized_text": "green"},
            ]
        )
        root = self.db.create_gallery_virtual_folder("Root")
        red = self.db.create_gallery_virtual_folder("Red", "red", parent_id=root["id"])
        self.db.create_gallery_virtual_folder("Blue", "blue", parent_id=root["id"])

        first = self.db.summarize_gallery_virtual_uncategorized(root["id"])
        self.assertEqual(first["total_matches"], 1)
        built_at = self.db.conn.execute(
            "SELECT built_at FROM gallery_virtual_folder_cache_meta WHERE folder_id = ?",
            (red["id"],),
        ).fetchone()[0]
        second = self.db.summarize_gallery_virtual_uncategorized(root["id"])
        self.assertEqual(second["total_matches"], 1)
        self.assertEqual(
            self.db.conn.execute(
                "SELECT built_at FROM gallery_virtual_folder_cache_meta WHERE folder_id = ?",
                (red["id"],),
            ).fetchone()[0],
            built_at,
        )

    def test_virtual_folder_cache_uses_positive_prompt_only(self):
        self.db.upsert_gallery_prompt_records(
            [
                {
                    "rel_path": "1_Solo/base.png",
                    "folder_path": "1_Solo",
                    "file_name": "base.png",
                    "mode": "general",
                    "prompt_text": "hero negative_only",
                    "normalized_text": "hero negative only",
                    "positive_prompt_text": "hero",
                    "positive_normalized_text": "hero",
                },
                {
                    "rel_path": "1_Solo/negative.png",
                    "folder_path": "1_Solo",
                    "file_name": "negative.png",
                    "mode": "general",
                    "prompt_text": "negative_only",
                    "normalized_text": "negative only",
                    "positive_prompt_text": "",
                    "positive_normalized_text": "",
                },
            ]
        )

        negative_folder = self.db.create_gallery_virtual_folder(
            "Negative", "negative_only"
        )
        negative_result = self.db.resolve_gallery_virtual_folder_cache(
            negative_folder,
            parse_gallery_prompt_search_query("negative_only"),
        )
        self.assertEqual(negative_result["total_matches"], 0)

        hero_folder = self.db.create_gallery_virtual_folder("Hero", "hero")
        hero_result = self.db.resolve_gallery_virtual_folder_cache(
            hero_folder,
            parse_gallery_prompt_search_query("hero"),
        )
        self.assertEqual(
            [row["rel_path"] for row in hero_result["rows"]],
            ["1_Solo/base.png"],
        )

    def test_prompt_semantics_migration_clears_indexes_but_keeps_virtual_folders(self):
        self.db.upsert_gallery_prompt_records(
            [
                {
                    "rel_path": "1_Solo/legacy.png",
                    "folder_path": "1_Solo",
                    "file_name": "legacy.png",
                    "mode": "general",
                    "prompt_text": "red negative_only",
                    "normalized_text": "red negative only",
                    "positive_prompt_text": "red",
                    "positive_normalized_text": "red",
                }
            ]
        )
        profile = self.db.upsert_gallery_prompt_index_profile(
            "Legacy profile", "all", [], ["1_Solo/legacy.png"]
        )
        folder = self.db.create_gallery_virtual_folder("Saved", "red")
        self.db.resolve_gallery_virtual_folder_cache(
            folder, [[{"text": "red", "partial": False}]]
        )
        db_path = self.db.db_path
        self.db.close()

        legacy = sqlite3.connect(db_path)
        try:
            legacy.execute(
                "UPDATE gallery_prompt_index SET positive_prompt_text = NULL, positive_normalized_text = NULL"
            )
            legacy.execute(
                "UPDATE gallery_index_state SET value = ? WHERE key = ?",
                ("legacy-v0", "prompt_index_semantics_version"),
            )
            legacy.commit()
        finally:
            legacy.close()

        self.db = HistoryDB(db_path)
        self.assertEqual(
            self.db.conn.execute("SELECT COUNT(*) FROM gallery_prompt_index").fetchone()[0],
            0,
        )
        self.assertEqual(
            self.db.conn.execute("SELECT COUNT(*) FROM gallery_prompt_index_profiles").fetchone()[0],
            1,
        )
        saved_profile = self.db.list_gallery_prompt_index_profiles()[0]
        self.assertEqual(saved_profile['id'], profile['id'])
        self.assertEqual(saved_profile['name'], 'Legacy profile')
        self.assertEqual((saved_profile['image_count'], saved_profile['text_bytes'], saved_profile['built_at']),
                         (0, 0, 0))
        self.assertEqual(
            self.db.conn.execute("SELECT COUNT(*) FROM gallery_prompt_index_profile_items").fetchone()[0],
            0,
        )
        self.assertEqual(
            self.db.conn.execute("SELECT COUNT(*) FROM gallery_virtual_folder_cache_meta").fetchone()[0],
            0,
        )
        self.assertEqual(
            self.db.conn.execute("SELECT COUNT(*) FROM gallery_virtual_folder_cache_items").fetchone()[0],
            0,
        )
        saved = self.db.get_gallery_virtual_folder(folder["id"])
        self.assertEqual(saved["name"], "Saved")
        self.assertEqual(saved["query"], "red")


if __name__ == "__main__":
    unittest.main()
