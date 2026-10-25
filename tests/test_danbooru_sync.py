import contextlib
import io
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import requests

import danbooru_sync


@contextlib.contextmanager
def sqlite_connection(path):
    connection = sqlite3.connect(path)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


class DanbooruSyncCopyrightDictionaryTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name)
        self.history_path = self.root / "history.db"

        with sqlite_connection(self.history_path) as connection:
            connection.execute(
                """
                CREATE TABLE known_characters (
                    tag TEXT PRIMARY KEY,
                    clean_name TEXT,
                    brand TEXT,
                    brand_kr TEXT,
                    is_visible INTEGER DEFAULT 1
                )
                """
            )

    def add_known_character(
        self, tag, brand=None, brand_kr=None, is_visible=1, clean_name=None
    ):
        with sqlite_connection(self.history_path) as connection:
            connection.execute(
                """
                INSERT INTO known_characters
                    (tag, clean_name, brand, brand_kr, is_visible)
                VALUES (?, ?, ?, ?, ?)
                """,
                (tag, clean_name or tag, brand, brand_kr, is_visible),
            )

    def create_local_database(
        self, path, characters=(), copyrights=(), implications=(), include_implications=True
    ):
        path = Path(path)
        with sqlite_connection(path) as connection:
            connection.executescript(
                """
                CREATE TABLE characters (
                    id INTEGER PRIMARY KEY,
                    name TEXT UNIQUE,
                    post_count INTEGER
                );
                CREATE TABLE copyrights (name TEXT UNIQUE, post_count INTEGER);
                """
                + (
                    """
                    CREATE TABLE tag_implications (
                        antecedent TEXT,
                        consequent TEXT,
                        UNIQUE (antecedent, consequent)
                    );
                    """
                    if include_implications
                    else ""
                )
            )
            connection.executemany(
                "INSERT INTO characters (name, post_count) VALUES (?, 1)",
                [(name,) for name in characters],
            )
            connection.executemany(
                "INSERT INTO copyrights (name, post_count) VALUES (?, 1)",
                [(name,) for name in copyrights],
            )
            if include_implications:
                connection.executemany(
                    "INSERT INTO tag_implications (antecedent, consequent) VALUES (?, ?)",
                    list(implications),
                )
        return path

    def run_sync(self, local_database_path, posts=None, fetch_error=None):
        session = Mock()
        with (
            patch.object(danbooru_sync, "DB_PATH", str(self.history_path)),
            patch.object(danbooru_sync, "LOCAL_CHAR_DB_PATH", str(local_database_path)),
            patch.object(danbooru_sync, "RECLASSIFY_ALL_BRANDS_ONCE", False),
            patch.object(danbooru_sync.requests, "Session", return_value=session),
            patch.object(danbooru_sync.time, "sleep"),
            patch.object(danbooru_sync, "fetch_brand_candidate_posts") as fetch_posts,
            contextlib.redirect_stdout(io.StringIO()),
        ):
            if fetch_error is not None:
                fetch_posts.side_effect = fetch_error
            else:
                fetch_posts.return_value = posts or []
            danbooru_sync.sync_copyrights()
        return session, fetch_posts

    def get_character(self, tag):
        with sqlite_connection(self.history_path) as connection:
            return connection.execute(
                """
                SELECT tag, brand, brand_kr, is_visible
                FROM known_characters WHERE tag = ?
                """,
                (tag,),
            ).fetchone()

    def get_relation(self, character_tag):
        with sqlite_connection(self.history_path) as connection:
            return connection.execute(
                """
                SELECT copyright_tag, source
                FROM character_copyright_relations
                WHERE character_tag = ?
                """,
                (character_tag,),
            ).fetchone()

    @staticmethod
    def solo_post(character_tag, copyright_tag):
        return {
            "id": 1,
            "tag_string_character": character_tag,
            "tag_string_general": "solo",
            "tag_string_copyright": copyright_tag,
        }

    def test_local_suffix_relation_reuses_brand_for_variants_and_preserves_existing_rows(self):
        local_path = self.create_local_database(
            self.root / "local.db",
            characters=("pilot_(demo_series)",),
            copyrights=("demo_series",),
        )
        self.add_known_character("pilot_(demo_series)_dakimakura")
        self.add_known_character("pilot_(demo_series)_2pcs")
        self.add_known_character(
            "kept_character",
            brand="Custom Brand",
            brand_kr="기존 이름",
            is_visible=0,
        )
        source_before = local_path.read_bytes()

        session, fetch_posts = self.run_sync(local_path)

        self.assertEqual(
            self.get_character("pilot_(demo_series)_dakimakura")[1], "Demo Series"
        )
        self.assertEqual(self.get_character("pilot_(demo_series)_2pcs")[1], "Demo Series")
        self.assertEqual(
            self.get_character("kept_character"),
            ("kept_character", "Custom Brand", "기존 이름", 0),
        )
        self.assertEqual(self.get_relation("pilot_(demo_series)"), ("demo_series", "tag_name"))
        fetch_posts.assert_not_called()
        session.close.assert_called_once_with()
        self.assertEqual(local_path.read_bytes(), source_before)

    def test_known_character_suffix_seeds_when_source_character_is_missing(self):
        local_path = self.create_local_database(
            self.root / "local.db", copyrights=("demo_series",)
        )
        self.add_known_character("pilot_(demo_series)_dakimakura")

        session, fetch_posts = self.run_sync(local_path)

        self.assertEqual(
            self.get_character("pilot_(demo_series)_dakimakura")[1], "Demo Series"
        )
        self.assertEqual(
            self.get_relation("pilot_(demo_series)"), ("demo_series", "tag_name")
        )
        fetch_posts.assert_not_called()
        session.close.assert_called_once_with()

    def test_online_relation_is_reused_for_new_variant_without_local_database(self):
        local_path = self.create_local_database(
            self.root / "local.db", copyrights=("demo_series",)
        )
        missing_local_path = self.root / "missing-local.db"
        self.add_known_character("hero_dakimakura")

        first_session, first_fetch = self.run_sync(
            local_path, posts=[self.solo_post("hero", "demo_series")]
        )

        self.assertEqual(self.get_character("hero_dakimakura")[1], "Demo Series")
        self.assertEqual(self.get_relation("hero"), ("demo_series", "online"))
        first_fetch.assert_called_once_with(first_session, "hero")
        first_session.close.assert_called_once_with()

        self.add_known_character("hero_2pcs")
        second_session, second_fetch = self.run_sync(missing_local_path)

        self.assertEqual(self.get_character("hero_2pcs")[1], "Demo Series")
        self.assertEqual(self.get_character("hero_dakimakura")[1], "Demo Series")
        second_fetch.assert_not_called()
        second_session.close.assert_called_once_with()

    def test_ambiguous_suffix_does_not_override_successful_online_vote(self):
        local_path = self.create_local_database(
            self.root / "local.db",
            characters=("pilot_(demo_series)",),
            copyrights=("demo_series", "side_series"),
            implications=(
                ("pilot_(demo_series)", "demo_series"),
                ("pilot_(demo_series)", "side_series"),
            ),
        )
        self.add_known_character("pilot_(demo_series)_dakimakura")

        session, fetch_posts = self.run_sync(
            local_path, posts=[self.solo_post("pilot_(demo_series)", "side_series")]
        )

        self.assertEqual(
            self.get_character("pilot_(demo_series)_dakimakura")[1], "Side Series"
        )
        self.assertEqual(
            self.get_relation("pilot_(demo_series)"), ("side_series", "online")
        )
        fetch_posts.assert_called_once_with(session, "pilot_(demo_series)")
        session.close.assert_called_once_with()

    def test_empty_online_result_marks_unknown_without_learning_and_can_retry(self):
        missing_local_path = self.root / "missing-local.db"
        self.add_known_character("mystery")

        first_session, first_fetch = self.run_sync(missing_local_path)

        self.assertEqual(self.get_character("mystery")[1], "Unknown")
        with sqlite_connection(self.history_path) as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) FROM character_copyright_relations"
                ).fetchone()[0],
                0,
            )
        first_fetch.assert_called_once_with(first_session, "mystery")
        first_session.close.assert_called_once_with()

        second_session, second_fetch = self.run_sync(
            missing_local_path, posts=[self.solo_post("mystery", "demo_series")]
        )

        self.assertEqual(self.get_character("mystery")[1], "Demo Series")
        self.assertEqual(self.get_relation("mystery"), ("demo_series", "online"))
        second_fetch.assert_called_once_with(second_session, "mystery")
        second_session.close.assert_called_once_with()

    def test_fetch_exception_does_not_learn_and_successful_rows_are_preserved_on_retry(self):
        missing_local_path = self.root / "missing-local.db"
        self.add_known_character("hero")
        self.add_known_character(
            "kept_character", brand="Kept Brand", brand_kr="기존 이름", is_visible=0
        )

        failed_session, failed_fetch = self.run_sync(
            missing_local_path, fetch_error=requests.Timeout("synthetic timeout")
        )

        self.assertIsNone(self.get_character("hero")[1])
        self.assertEqual(
            self.get_character("kept_character"),
            ("kept_character", "Kept Brand", "기존 이름", 0),
        )
        with sqlite_connection(self.history_path) as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) FROM character_copyright_relations"
                ).fetchone()[0],
                0,
            )
        failed_fetch.assert_called_once_with(failed_session, "hero")
        failed_session.close.assert_called_once_with()

        retry_session, retry_fetch = self.run_sync(
            missing_local_path, posts=[self.solo_post("hero", "demo_series")]
        )

        self.assertEqual(self.get_character("hero")[1], "Demo Series")
        self.assertEqual(self.get_relation("hero"), ("demo_series", "online"))
        self.assertEqual(
            self.get_character("kept_character"),
            ("kept_character", "Kept Brand", "기존 이름", 0),
        )
        retry_fetch.assert_called_once_with(retry_session, "hero")
        retry_session.close.assert_called_once_with()

    def test_online_relation_and_brand_update_roll_back_together(self):
        missing_local_path = self.root / "missing-local.db"
        self.add_known_character("hero")
        with sqlite_connection(self.history_path) as connection:
            connection.execute(
                """
                CREATE TRIGGER fail_synthetic_brand_update
                BEFORE UPDATE ON known_characters
                WHEN NEW.brand = 'Demo Series'
                BEGIN
                    SELECT RAISE(ABORT, 'synthetic update failure');
                END
                """
            )

        session, fetch_posts = self.run_sync(
            missing_local_path, posts=[self.solo_post("hero", "demo_series")]
        )

        self.assertIsNone(self.get_character("hero")[1])
        with sqlite_connection(self.history_path) as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) FROM character_copyright_relations"
                ).fetchone()[0],
                0,
            )
        fetch_posts.assert_called_once_with(session, "hero")
        session.close.assert_called_once_with()

    def test_missing_local_implication_table_allows_online_fallback(self):
        local_path = self.create_local_database(
            self.root / "incomplete-local.db",
            copyrights=("demo_series",),
            include_implications=False,
        )
        self.add_known_character("hero")

        session, fetch_posts = self.run_sync(
            local_path, posts=[self.solo_post("hero", "demo_series")]
        )

        self.assertEqual(self.get_character("hero")[1], "Demo Series")
        self.assertEqual(self.get_relation("hero"), ("demo_series", "online"))
        fetch_posts.assert_called_once_with(session, "hero")
        session.close.assert_called_once_with()

    def test_no_pending_characters_leaves_classified_rows_unchanged(self):
        missing_local_path = self.root / "missing-local.db"
        self.add_known_character(
            "kept_character", brand="Kept Brand", brand_kr="기존 이름", is_visible=0
        )
        self.add_known_character(
            "other_character", brand="Other Brand", brand_kr="다른 이름", is_visible=1
        )

        before = [self.get_character("kept_character"), self.get_character("other_character")]
        session, fetch_posts = self.run_sync(missing_local_path)

        self.assertEqual(
            [self.get_character("kept_character"), self.get_character("other_character")],
            before,
        )
        fetch_posts.assert_not_called()
        session.close.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
