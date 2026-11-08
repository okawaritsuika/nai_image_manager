import sqlite3
import tempfile
import unittest
from contextlib import closing
from io import BytesIO
from pathlib import Path

from PIL import Image

from naim.style_manager.confirmed_style_store import (
    confirmed_base_prompt,
    create_confirmed_style,
    get_confirmed_style,
    init_confirmed_style_tables,
    normalize_confirmed_style,
    update_confirmed_style,
)


def rgb_png_bytes():
    output = BytesIO()
    Image.new("RGB", (8, 8), (20, 40, 60)).save(output, format="PNG")
    return output.getvalue()


class ConfirmedBasePromptTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.db_path = self.root / "confirmed.sqlite"
        self.image_dir = self.root / "confirmed-images"
        init_confirmed_style_tables(self.db_path)

    def test_migration_adds_nullable_column_and_preserves_legacy_row(self):
        timestamp = "2026-10-01T00:00:00+00:00"
        with closing(sqlite3.connect(self.db_path)) as connection, connection:
            connection.execute(
                """INSERT INTO confirmed_styles (
                    name,description,image_path,artist_prompt,quality_prompt,
                    original_quality_prompt,excluded_quality_tags_json,fixed_prompt,
                    character_prompts_json,negative_prompt,sampler,noise_schedule,
                    model,complexity,quality_toggle,uc_preset,raw_metadata_json,
                    source_type,source_id,source_url,created_at,updated_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    "Legacy", "kept", "legacy.png", "artist:legacy", "quality:legacy",
                    "original:legacy", '["excluded:legacy"]', "fixed:legacy", "[]",
                    "negative:legacy", "sampler", "schedule", "model", "high", 1, 3,
                    '{"legacy":"metadata"}', "generated", 42, "https://example.test/legacy",
                    timestamp, timestamp,
                ),
            )
            legacy_columns = [
                row for row in connection.execute("PRAGMA table_info(confirmed_styles)")
                if row[1] != "base_prompt"
            ]
            definitions = [
                '"id" INTEGER PRIMARY KEY' if row[1] == "id" else f'"{row[1]}" {row[2]}'
                for row in legacy_columns
            ]
            current_columns = [row[1] for row in legacy_columns]
            quoted_columns = ",".join(f'"{name}"' for name in current_columns)
            connection.execute(
                f"CREATE TABLE confirmed_styles_legacy ({','.join(definitions)})"
            )
            connection.execute(
                f"INSERT INTO confirmed_styles_legacy ({quoted_columns}) SELECT {quoted_columns} FROM confirmed_styles"
            )
            connection.execute("DROP TABLE confirmed_style_images")
            connection.execute("DROP TABLE confirmed_styles")
            connection.execute("ALTER TABLE confirmed_styles_legacy RENAME TO confirmed_styles")

        init_confirmed_style_tables(self.db_path)
        style = get_confirmed_style(self.db_path, 1)
        self.assertIsNone(style["base_prompt"])
        self.assertEqual(style["name"], "Legacy")
        self.assertEqual(style["artist_prompt"], "artist:legacy")
        self.assertEqual(style["quality_prompt"], "quality:legacy")
        self.assertEqual(style["fixed_prompt"], "fixed:legacy")
        self.assertEqual(style["raw_metadata"], {"legacy": "metadata"})
        self.assertEqual(style["source_type"], "generated")
        self.assertEqual(style["source_id"], 42)

        with closing(sqlite3.connect(self.db_path)) as connection:
            column = connection.execute(
                "PRAGMA table_info(confirmed_styles)"
            ).fetchall()
            base_prompt_column = next(row for row in column if row[1] == "base_prompt")
            self.assertEqual(base_prompt_column[2], "TEXT")
            self.assertEqual(base_prompt_column[3], 0)
            self.assertIsNone(base_prompt_column[4])

        init_confirmed_style_tables(self.db_path)
        self.assertIsNone(get_confirmed_style(self.db_path, 1)["base_prompt"])

    def test_explicit_base_prompt_is_saved_verbatim_and_survives_name_update(self):
        style = create_confirmed_style(self.db_path, self.image_dir, rgb_png_bytes(), {
            "name": "Integrated",
            "artist_prompt": "1.2::artist:synthetic_a::",
            "quality_prompt": "quality_a, quality_b",
            "fixed_prompt": "fixed_a",
            "base_prompt": "quality_a, 1.2::artist:synthetic_a::, fixed_a, quality_b",
        })
        expected_base = "quality_a, 1.2::artist:synthetic_a::, fixed_a, quality_b"
        self.assertEqual(style["base_prompt"], expected_base)
        self.assertEqual(confirmed_base_prompt(style), expected_base)
        self.assertEqual(style["artist_prompt"], "1.2::artist:synthetic_a::")
        self.assertEqual(style["quality_prompt"], "quality_a, quality_b")
        self.assertEqual(style["fixed_prompt"], "fixed_a")

        updated = update_confirmed_style(self.db_path, style["id"], {"name": "Renamed"})
        self.assertEqual(updated["name"], "Renamed")
        self.assertEqual(updated["base_prompt"], expected_base)
        self.assertEqual(confirmed_base_prompt(updated), expected_base)

    def test_legacy_payload_uses_split_prompt_order_and_none_switches_back(self):
        style = create_confirmed_style(self.db_path, self.image_dir, rgb_png_bytes(), {
            "name": "Legacy split",
            "artist_prompt": " artist:synthetic ",
            "quality_prompt": " quality_a, quality_b ",
            "fixed_prompt": " fixed_a ",
        })
        self.assertIsNone(style["base_prompt"])
        self.assertEqual(
            confirmed_base_prompt(style),
            "artist:synthetic, quality_a, quality_b, fixed_a",
        )
        self.assertIsNone(normalize_confirmed_style({})["base_prompt"])

        integrated = update_confirmed_style(
            self.db_path, style["id"], {"base_prompt": "saved integrated prompt"}
        )
        self.assertEqual(confirmed_base_prompt(integrated), "saved integrated prompt")
        split_again = update_confirmed_style(self.db_path, style["id"], {"base_prompt": None})
        self.assertIsNone(split_again["base_prompt"])
        self.assertEqual(
            confirmed_base_prompt(split_again),
            "artist:synthetic, quality_a, quality_b, fixed_a",
        )

    def test_empty_base_prompt_is_explicit_and_does_not_fall_back(self):
        style = create_confirmed_style(self.db_path, self.image_dir, rgb_png_bytes(), {
            "artist_prompt": "artist:synthetic",
            "quality_prompt": "quality:synthetic",
            "fixed_prompt": "fixed:synthetic",
            "base_prompt": "   ",
        })
        self.assertEqual(style["base_prompt"], "")
        self.assertEqual(confirmed_base_prompt(style), "")

    def test_base_prompt_validation_matches_text_contract(self):
        for invalid in (1, [], False):
            with self.subTest(invalid=invalid):
                with self.assertRaisesRegex(ValueError, "base_prompt must be a string"):
                    normalize_confirmed_style({"base_prompt": invalid})
        with self.assertRaisesRegex(ValueError, "base_prompt is too long"):
            normalize_confirmed_style({"base_prompt": "x" * 16385})
        self.assertEqual(
            normalize_confirmed_style({"base_prompt": "  keep:1.2 "})["base_prompt"],
            "keep:1.2",
        )


if __name__ == "__main__":
    unittest.main()
