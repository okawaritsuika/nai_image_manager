import sqlite3
import tempfile
import unittest
from pathlib import Path

from naim.storage.character_copyrights import (
    CharacterCopyrightDictionary,
    match_copyright_suffix,
)


class CharacterCopyrightsTests(unittest.TestCase):
    def setUp(self):
        self.history_connection = sqlite3.connect(":memory:")
        self.addCleanup(self.history_connection.close)
        self.dictionary = CharacterCopyrightDictionary(self.history_connection)

        self.local_connection = sqlite3.connect(":memory:")
        self.addCleanup(self.local_connection.close)
        self.local_connection.executescript(
            """
            CREATE TABLE characters (id INTEGER PRIMARY KEY, name TEXT UNIQUE, post_count INTEGER);
            CREATE TABLE copyrights (name TEXT UNIQUE, post_count INTEGER);
            CREATE TABLE tag_implications (
                antecedent TEXT,
                consequent TEXT,
                UNIQUE (antecedent, consequent)
            );
            """
        )
        self.local_cursor = self.local_connection.cursor()

    def add_character(self, name):
        self.local_connection.execute(
            "INSERT INTO characters (name, post_count) VALUES (?, 1)", (name,)
        )

    def add_copyright(self, name):
        self.local_connection.execute(
            "INSERT INTO copyrights (name, post_count) VALUES (?, 1)", (name,)
        )

    def add_implication(self, character_tag, copyright_tag):
        self.local_connection.execute(
            "INSERT INTO tag_implications (antecedent, consequent) VALUES (?, ?)",
            (character_tag, copyright_tag),
        )

    def test_suffix_match_prefers_exact_then_series_and_handles_idolm_at(self):
        self.assertEqual(
            match_copyright_suffix(
                "pilot_(demo_series)", {"demo_series", "demo_series_(series)"}
            ),
            "demo_series",
        )
        self.assertEqual(
            match_copyright_suffix("pilot_(demo_series)", {"demo_series_(series)"}),
            "demo_series_(series)",
        )
        self.assertEqual(
            match_copyright_suffix("pilot_(the_idolm@ster)", {"the_idolmaster"}),
            "the_idolmaster",
        )
        self.assertIsNone(match_copyright_suffix("pilot", {"demo_series"}))

    def test_empty_tags_raise_value_error_and_remember_duplicate_is_upsert(self):
        for character_tag, copyright_tag in (
            ("", "demo_series"),
            ("pilot", "  "),
        ):
            with self.subTest(character_tag=character_tag, copyright_tag=copyright_tag):
                with self.assertRaises(ValueError):
                    self.dictionary.remember(character_tag, copyright_tag)

        self.dictionary.remember(" Pilot ", " Demo_Series ")
        self.dictionary.remember("pilot", "updated_series")
        self.history_connection.commit()
        self.assertEqual(self.dictionary.lookup(" PILOT "), "updated_series")
        self.assertEqual(
            self.history_connection.execute(
                "SELECT COUNT(*) FROM character_copyright_relations"
            ).fetchone()[0],
            1,
        )
        with self.assertRaises(ValueError):
            self.dictionary.lookup(" ")

    def test_remember_leaves_commit_to_caller(self):
        self.dictionary.remember("pilot", "demo_series")
        self.assertTrue(self.history_connection.in_transaction)
        self.history_connection.rollback()
        self.assertIsNone(self.dictionary.lookup("pilot"))

        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "history.db"
            connection = sqlite3.connect(path)
            dictionary = CharacterCopyrightDictionary(connection)
            dictionary.remember("pilot", "demo_series")
            self.assertTrue(connection.in_transaction)
            connection.commit()
            connection.close()

            reopened = sqlite3.connect(path)
            try:
                self.assertEqual(
                    CharacterCopyrightDictionary(reopened).lookup("pilot"), "demo_series"
                )
            finally:
                reopened.close()

    def test_unique_direct_relation_takes_priority_over_suffix(self):
        self.add_character("pilot_(demo_series)")
        self.add_copyright("demo_series")
        self.add_copyright("direct_series")
        self.add_implication("pilot_(demo_series)", "direct_series")

        self.assertEqual(self.dictionary.seed_from_local(self.local_cursor), 1)
        self.assertEqual(self.dictionary.lookup("pilot_(demo_series)"), "direct_series")
        self.assertEqual(
            self.history_connection.execute(
                "SELECT source FROM character_copyright_relations WHERE character_tag = ?",
                ("pilot_(demo_series)",),
            ).fetchone()[0],
            "tag_implication",
        )

    def test_additional_character_uses_suffix_without_seeding_unmatched_tag(self):
        self.add_copyright("demo_series")

        self.assertEqual(
            self.dictionary.seed_from_local(
                self.local_cursor,
                additional_characters=[" Pilot_(Demo_Series) ", "hero"],
            ),
            1,
        )
        self.assertEqual(self.dictionary.lookup("pilot_(demo_series)"), "demo_series")
        self.assertIsNone(self.dictionary.lookup("hero"))

    def test_multiple_direct_relations_are_not_seeded_or_suffix_fallback(self):
        self.add_character("pilot_(demo_series)")
        for name in ("demo_series", "series_a", "series_b"):
            self.add_copyright(name)
        self.add_implication("pilot_(demo_series)", "series_a")
        self.add_implication("pilot_(demo_series)", "series_b")

        self.assertEqual(self.dictionary.seed_from_local(self.local_cursor), 0)
        self.assertIsNone(self.dictionary.lookup("pilot_(demo_series)"))

    def test_online_relationship_is_preserved_and_seed_is_idempotent(self):
        self.add_character("pilot_(demo_series)")
        self.add_copyright("demo_series")
        self.dictionary.remember("pilot_(demo_series)", "online_series")
        self.history_connection.commit()

        self.assertEqual(self.dictionary.seed_from_local(self.local_cursor), 1)
        self.assertEqual(self.dictionary.lookup("pilot_(demo_series)"), "online_series")
        self.assertEqual(self.dictionary.seed_from_local(self.local_cursor), 1)
        self.assertEqual(
            self.history_connection.execute(
                "SELECT COUNT(*) FROM character_copyright_relations"
            ).fetchone()[0],
            1,
        )

    def test_tag_name_upgrades_to_unique_implication(self):
        self.add_character("pilot_(demo_series)")
        self.add_copyright("demo_series")
        self.add_copyright("direct_series")
        self.assertEqual(self.dictionary.seed_from_local(self.local_cursor), 1)
        self.assertEqual(self.dictionary.lookup("pilot_(demo_series)"), "demo_series")

        self.add_implication("pilot_(demo_series)", "direct_series")
        self.assertEqual(self.dictionary.seed_from_local(self.local_cursor), 1)
        self.assertEqual(self.dictionary.lookup("pilot_(demo_series)"), "direct_series")
        self.assertEqual(
            self.history_connection.execute(
                "SELECT source FROM character_copyright_relations WHERE character_tag = ?",
                ("pilot_(demo_series)",),
            ).fetchone()[0],
            "tag_implication",
        )

    def test_tag_implication_is_not_downgraded_to_tag_name(self):
        self.add_character("pilot_(demo_series)")
        self.add_copyright("demo_series")
        self.add_copyright("direct_series")
        self.add_implication("pilot_(demo_series)", "direct_series")
        self.dictionary.seed_from_local(self.local_cursor)
        self.local_connection.execute("DELETE FROM tag_implications")

        self.dictionary.seed_from_local(self.local_cursor)
        self.assertEqual(self.dictionary.lookup("pilot_(demo_series)"), "direct_series")

    def test_seed_uses_one_atomic_write_on_failure(self):
        for character_tag, copyright_tag in (
            ("pilot_(first_demo)", "first_demo"),
            ("pilot_(second_demo)", "second_demo"),
        ):
            self.add_character(character_tag)
            self.add_copyright(copyright_tag)
            self.add_implication(character_tag, copyright_tag)
        self.history_connection.execute(
            """
            CREATE TRIGGER fail_second_seed
            BEFORE INSERT ON character_copyright_relations
            WHEN NEW.character_tag = 'pilot_(second_demo)'
            BEGIN
                SELECT RAISE(ABORT, 'synthetic seed failure');
            END
            """
        )

        with self.assertRaises(sqlite3.IntegrityError):
            self.dictionary.seed_from_local(self.local_cursor)
        self.assertIsNone(self.dictionary.lookup("pilot_(first_demo)"))
        self.assertIsNone(self.dictionary.lookup("pilot_(second_demo)"))

    def test_local_database_is_read_only_and_missing_source_table_error_propagates(self):
        self.add_character("pilot_(demo_series)")
        self.add_copyright("demo_series")
        before = {
            table: self.local_connection.execute(f"SELECT * FROM {table}").fetchall()
            for table in ("characters", "copyrights", "tag_implications")
        }

        self.dictionary.seed_from_local(self.local_cursor)
        after = {
            table: self.local_connection.execute(f"SELECT * FROM {table}").fetchall()
            for table in ("characters", "copyrights", "tag_implications")
        }
        self.assertEqual(after, before)

        with sqlite3.connect(":memory:") as incomplete_connection:
            with self.assertRaises(sqlite3.Error):
                self.dictionary.seed_from_local(incomplete_connection.cursor())


if __name__ == "__main__":
    unittest.main()
