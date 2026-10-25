import os
import tempfile
import unittest

from utils import (
    HistoryDB,
    gallery_prompt_search_matches,
    parse_gallery_prompt_search_query,
)


class GalleryPromptQueryTests(unittest.TestCase):
    def test_parser_builds_or_of_and_groups(self):
        self.assertEqual(
            parse_gallery_prompt_search_query("prompt1, prompt2 || prompt3"),
            [
                [
                    {"text": "prompt1", "partial": False},
                    {"text": "prompt2", "partial": False},
                ],
                [{"text": "prompt3", "partial": False}],
            ],
        )
        self.assertEqual(
            parse_gallery_prompt_search_query("%blue eyes%,red_hat"),
            [
                [
                    {"text": "blue eyes", "partial": True},
                    {"text": "red hat", "partial": False},
                ]
            ],
        )

    def test_exact_partial_phrase_and_boundaries(self):
        self.assertFalse(gallery_prompt_search_matches("catgirl", "cat"))
        self.assertTrue(gallery_prompt_search_matches("black catgirl", "%cat%"))
        self.assertTrue(gallery_prompt_search_matches("red_hat, blue eyes", "red hat blue eyes"))
        self.assertFalse(gallery_prompt_search_matches("red hair", "red hat"))
        self.assertTrue(gallery_prompt_search_matches("prompt1 prompt2", "prompt1, prompt2 || prompt3"))
        self.assertTrue(gallery_prompt_search_matches("prompt3", "prompt1, prompt2 || prompt3"))
        self.assertFalse(gallery_prompt_search_matches("prompt1", "prompt1, prompt2 || prompt3"))
        self.assertTrue(gallery_prompt_search_matches("a blue eyes portrait", "%blue eyes%"))


class GalleryPromptQueryDbTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db = HistoryDB(os.path.join(self.temp_dir.name, "history.sqlite"))
        self.records = [
            {
                "rel_path": "1_Solo/cat.png",
                "folder_path": "1_Solo",
                "file_name": "cat.png",
                "mode": "general",
                "prompt_text": "red hat, cat",
                "normalized_text": "red hat cat",
            },
            {
                "rel_path": "1_Solo/catgirl.png",
                "folder_path": "1_Solo",
                "file_name": "catgirl.png",
                "mode": "general",
                "prompt_text": "red hat catgirl",
                "normalized_text": "red hat catgirl",
            },
            {
                "rel_path": "2_Solo/blue.png",
                "folder_path": "2_Solo",
                "file_name": "blue.png",
                "mode": "general",
                "prompt_text": "blue eyes portrait",
                "normalized_text": "blue eyes portrait",
            },
            {
                "rel_path": "2_Solo/raw.png",
                "folder_path": "2_Solo",
                "file_name": "raw.png",
                "mode": "general",
                "prompt_text": "red_hat cat",
                "normalized_text": "",
            },
        ]
        self.db.upsert_gallery_prompt_records(self.records)

    def tearDown(self):
        self.db.close()
        self.temp_dir.cleanup()

    def test_index_search_uses_exact_partial_and_or(self):
        rows = self.db.search_gallery_prompt_index("cat")
        self.assertEqual(
            [row["rel_path"] for row in rows],
            ["1_Solo/cat.png", "2_Solo/raw.png"],
        )
        rows = self.db.search_gallery_prompt_index("%cat%")
        self.assertEqual(
            [row["rel_path"] for row in rows],
            ["1_Solo/cat.png", "1_Solo/catgirl.png", "2_Solo/raw.png"],
        )
        rows = self.db.search_gallery_prompt_index("red, hat || blue eyes")
        self.assertEqual(
            [row["rel_path"] for row in rows],
            ["1_Solo/cat.png", "1_Solo/catgirl.png", "2_Solo/blue.png", "2_Solo/raw.png"],
        )

    def test_profile_search_uses_same_matcher(self):
        profile = self.db.upsert_gallery_prompt_index_profile(
            "All", "all", [], [record["rel_path"] for record in self.records]
        )
        rows = self.db.search_gallery_prompt_index_profile(profile["id"], "cat")
        self.assertEqual(
            [row["rel_path"] for row in rows],
            ["1_Solo/cat.png", "2_Solo/raw.png"],
        )
        rows = self.db.search_gallery_prompt_index_profile(profile["id"], "%blue eyes%")
        self.assertEqual([row["rel_path"] for row in rows], ["2_Solo/blue.png"])

    def test_positive_search_excludes_negative_but_general_search_keeps_it(self):
        self.db.upsert_gallery_prompt_records(
            [
                {
                    "rel_path": "3_Solo/positive.png",
                    "folder_path": "3_Solo",
                    "file_name": "positive.png",
                    "mode": "general",
                    "prompt_text": "hero negative_only",
                    "normalized_text": "hero negative only",
                    "positive_prompt_text": "hero",
                    "positive_normalized_text": "hero",
                },
                {
                    "rel_path": "3_Solo/negative.png",
                    "folder_path": "3_Solo",
                    "file_name": "negative.png",
                    "mode": "general",
                    "prompt_text": "negative_only",
                    "normalized_text": "negative only",
                    "positive_prompt_text": "",
                    "positive_normalized_text": "",
                },
            ]
        )

        positive_rows = self.db.search_gallery_prompt_index(
            "negative_only", positive_only=True
        )
        self.assertEqual(positive_rows, [])
        general_rows = self.db.search_gallery_prompt_index("negative_only")
        self.assertEqual(
            [row["rel_path"] for row in general_rows],
            ["3_Solo/negative.png", "3_Solo/positive.png"],
        )

    def test_empty_positive_row_counts_as_indexed_but_never_matches(self):
        self.db.upsert_gallery_prompt_records(
            [
                {
                    "rel_path": "3_Solo/empty-positive.png",
                    "folder_path": "3_Solo",
                    "file_name": "empty-positive.png",
                    "mode": "general",
                    "prompt_text": "negative_only",
                    "normalized_text": "negative only",
                    "positive_prompt_text": "",
                    "positive_normalized_text": "",
                }
            ]
        )

        status = self.db.get_gallery_prompt_index_status(
            "", "all", positive_only=True
        )
        self.assertGreaterEqual(status["indexed_images"], 1)
        self.assertEqual(
            self.db.search_gallery_prompt_index(
                "negative_only", positive_only=True
            ),
            [],
        )


if __name__ == "__main__":
    unittest.main()
