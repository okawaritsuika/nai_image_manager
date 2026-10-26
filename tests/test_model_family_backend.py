import json
import os
import sqlite3
import sys
import tempfile
import types
import unittest
from unittest import mock

from flask import Response
from PIL import Image
from PIL.PngImagePlugin import PngInfo

import image_logic
import utils


class ModelFamilyExtractionTests(unittest.TestCase):
    def _write_png(self, directory, name, **metadata):
        path = os.path.join(directory, name)
        png_info = PngInfo()
        for key, value in metadata.items():
            if isinstance(value, (dict, list)):
                value = json.dumps(value, ensure_ascii=False)
            png_info.add_text(key, str(value))
        Image.new("RGB", (1, 1)).save(path, "PNG", pnginfo=png_info)
        return path

    def test_official_ids_and_unknown_values(self):
        self.assertEqual(image_logic.classify_model_family("nai-diffusion-5-full"), "v5")
        self.assertEqual(image_logic.classify_model_family("nai-diffusion-5-full-medium"), "v5")
        self.assertEqual(image_logic.classify_model_family("nai-diffusion-5-full-medium-inpainting"), "v5")
        self.assertEqual(image_logic.classify_model_family("nai-diffusion-5-curated"), "v5")
        self.assertEqual(image_logic.classify_model_family("nai-diffusion-4-5-full"), "v4_5")
        self.assertEqual(image_logic.classify_model_family("nai-diffusion-4-5-curated"), "v4_5")
        self.assertEqual(image_logic.classify_model_family(""), "other")
        self.assertEqual(image_logic.classify_model_family("not-a-novelai-model"), "other")

    def test_real_metadata_variants(self):
        with tempfile.TemporaryDirectory() as directory:
            cases = [
                ({"Model": "nai-diffusion-4-5-curated"}, "v4_5"),
                ({"Comment": {"model": "nai-diffusion-5-full-medium-inpainting"}}, "v5"),
                ({"parameters": {"model": "nai-diffusion-5-curated"}}, "v5"),
                ({"Comment": {"model_name": "NovelAI Diffusion V5"}}, "v5"),
                ({"Source": "NovelAI Diffusion V4.5 1229B44F"}, "v4_5"),
                ({"Source": "NovelAI Diffusion V50 test"}, "other"),
            ]
            for index, (metadata, expected) in enumerate(cases):
                path = self._write_png(directory, f"case_{index}.png", **metadata)
                self.assertEqual(image_logic.extract_model_family_from_file(path), expected)

    def test_ai_pending_tuple_keeps_model_family_and_flags_separate(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self._write_png(
                directory,
                "pending.png",
                parameters={"model": "nai-diffusion-5-full"},
            )
            previous = image_logic.USE_AI_FILTER
            image_logic.USE_AI_FILTER = True
            try:
                result = image_logic.analyze_file_worker(
                    path,
                    allow_ai=False,
                    mark_ai_pending=True,
                )
                self.assertEqual(result[6], "v5")
                self.assertTrue(result[7])
                self.assertEqual(result[8], "parameters")
                with mock.patch.object(
                    image_logic,
                    "get_nsfw_model",
                    return_value=lambda _image: [{"label": "hentai", "score": 0.0}, {"label": "porn", "score": 0.0}],
                ):
                    classified = image_logic.ai_classify_pending_result(result[:7])
                self.assertEqual(classified[6], "v5")
            finally:
                image_logic.USE_AI_FILTER = previous

    def test_stealth_is_only_fallback_when_visible_metadata_is_absent(self):
        with tempfile.TemporaryDirectory() as directory:
            visible_path = self._write_png(directory, "visible.png", Source="unknown source")
            with mock.patch.object(image_logic, "read_stealth_info", return_value=json.dumps({"model": "nai-diffusion-5-full"})) as stealth:
                self.assertEqual(image_logic.extract_model_family_from_file(visible_path), "other")
                stealth.assert_not_called()

            blank_path = self._write_png(directory, "blank.png")
            with mock.patch.object(image_logic, "read_stealth_info", return_value=json.dumps({"model": "nai-diffusion-5-full"})) as stealth:
                self.assertEqual(image_logic.extract_model_family_from_file(blank_path), "v5")
                stealth.assert_called_once()


class GalleryModelFamilyMigrationTests(unittest.TestCase):
    @staticmethod
    def _load_app_without_flask():
        flask_stub = types.ModuleType("flask")

        class FakeFlask:
            def __init__(self, *_args, **_kwargs):
                self.config = {}

            def route(self, *_args, **_kwargs):
                return lambda function: function

            def get(self, *_args, **_kwargs):
                return self.route(*_args, **_kwargs)

            def post(self, *_args, **_kwargs):
                return self.route(*_args, **_kwargs)

            def run(self, *_args, **_kwargs):
                return None

        flask_stub.Flask = FakeFlask
        flask_stub.Response = Response
        flask_stub.jsonify = lambda value=None, **kwargs: value if value is not None else kwargs
        flask_stub.send_file = lambda *args, **kwargs: None
        flask_stub.request = types.SimpleNamespace(args={}, form={}, files={})

        previous_app = sys.modules.pop("app", None)
        with mock.patch.dict(sys.modules, {"flask": flask_stub}):
            import app as app_module
        if previous_app is not None:
            sys.modules["app"] = previous_app
        else:
            sys.modules.pop("app", None)
        return app_module

    @staticmethod
    def _flatten_images(node):
        images = list(node.get("images") or [])
        for child in node.get("folders") or []:
            images.extend(GalleryModelFamilyMigrationTests._flatten_images(child))
        return images

    def test_old_database_keeps_full_index_and_backfills_legacy_model_without_opening_images(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = os.path.join(directory, "legacy.sqlite")
            conn = sqlite3.connect(db_path)
            conn.executescript(
                """
                CREATE TABLE gallery_images (
                    rel_path TEXT PRIMARY KEY, folder_path TEXT, file_name TEXT,
                    mode TEXT, rating TEXT, brand TEXT, character_names TEXT,
                    is_dakimakura INTEGER, width INTEGER, height INTEGER,
                    mtime REAL, reason TEXT, gallery_tag TEXT, updated_at REAL
                );
                CREATE TABLE gallery_index_state (
                    key TEXT PRIMARY KEY, value TEXT, updated_at REAL
                );
                CREATE TABLE gallery_prompt_index_profiles (
                    id TEXT PRIMARY KEY, name TEXT, mode TEXT, scope_paths_json TEXT,
                    image_count INTEGER, text_bytes INTEGER, created_at REAL,
                    updated_at REAL, built_at REAL
                );
                INSERT INTO gallery_prompt_index_profiles (
                    id, name, mode, scope_paths_json, image_count, text_bytes,
                    created_at, updated_at, built_at
                ) VALUES ('profile-a', 'Saved profile', 'general', '[\"1_Solo\"]', 8, 123, 10, 11, 12);
                INSERT INTO gallery_index_state VALUES ('full_index_built', '1', 987.25);
                """
            )
            conn.execute(
                "INSERT INTO gallery_images VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ("1_Solo/a.png", "1_Solo", "a.png", "general", "safe", "brand", "[\"char\"]",
                 0, 1024, 1536, 123.5, "legacy reason", "legacy tag", 456.0),
            )
            conn.commit()
            conn.close()

            with mock.patch("PIL.Image.open", side_effect=AssertionError("migration must not decode images")):
                db = utils.HistoryDB(db_path)
            try:
                columns = {row[1] for row in db.conn.execute("PRAGMA table_info(gallery_images)")}
                self.assertIn("model_family", columns)
                self.assertEqual(
                    db.conn.execute(
                        "SELECT rel_path, folder_path, file_name, mode, rating, brand, character_names, "
                        "is_dakimakura, width, height, mtime, reason, gallery_tag, model_family, updated_at "
                        "FROM gallery_images WHERE rel_path = '1_Solo/a.png'"
                    ).fetchone(),
                    ("1_Solo/a.png", "1_Solo", "a.png", "general", "safe", "brand", '["char"]',
                     0, 1024, 1536, 123.5, "legacy reason", "legacy tag", "v5", 456.0),
                )
                self.assertEqual(
                    db.conn.execute(
                        "SELECT value, updated_at FROM gallery_index_state WHERE key = 'full_index_built'"
                    ).fetchone(),
                    ("1", 987.25),
                )
                self.assertEqual(db.get_gallery_index_state("legacy_gallery_model_default"), "v5")
                self.assertTrue(db.has_full_gallery_index())
                self.assertTrue(db.has_usable_gallery_index())
                self.assertEqual(
                    db.conn.execute(
                        "SELECT id, name, mode, scope_paths_json FROM gallery_prompt_index_profiles WHERE id = 'profile-a'"
                    ).fetchone(),
                    ("profile-a", "Saved profile", "general", '["1_Solo"]'),
                )
            finally:
                db.close()

            # Opening an already migrated database must not rewrite the image rows.
            statements = []
            original_connect = sqlite3.connect

            def traced_connect(*args, **kwargs):
                connection = original_connect(*args, **kwargs)
                connection.set_trace_callback(statements.append)
                return connection

            with mock.patch("naim.storage.history.sqlite3.connect", side_effect=traced_connect):
                reopened = utils.HistoryDB(db_path)
            reopened.close()
            self.assertFalse(
                any(statement.lstrip().upper().startswith("UPDATE GALLERY_IMAGES") for statement in statements),
                statements,
            )

    def test_index_payload_filters_model_family(self):
        app_module = self._load_app_without_flask()
        with tempfile.TemporaryDirectory() as directory:
            classified_root = os.path.join(directory, "TOTAL_CLASSIFIED")
            os.makedirs(classified_root, exist_ok=True)
            with mock.patch.object(utils, "get_app_dir", return_value=directory), \
                    mock.patch.object(app_module, "CLASSIFIED_DIR", classified_root):
                db = utils.HistoryDB()
                db.upsert_gallery_image_records([
                    {"rel_path": "1_Solo/v5.png", "folder_path": "1_Solo", "file_name": "v5.png", "model_family": "v5"},
                    {"rel_path": "1_Solo/v45.png", "folder_path": "1_Solo", "file_name": "v45.png", "model_family": "v4_5"},
                    {"rel_path": "1_Solo/other.png", "folder_path": "1_Solo", "file_name": "other.png", "model_family": "other"},
                ])
                db.set_gallery_index_state("full_index_built", "1")
                db.close()

                def paths_for(filter_value):
                    payload = app_module.build_gallery_data_payload_from_index("all", "name", filter_value)
                    return {item["path"] for item in self._flatten_images(payload["tree"])}

                self.assertEqual(paths_for("v5"), {"1_Solo/v5.png"})
                self.assertEqual(paths_for("v4_5"), {"1_Solo/v45.png"})
                self.assertEqual(paths_for("other"), {"1_Solo/other.png"})
                self.assertEqual(paths_for("all"), {"1_Solo/v5.png", "1_Solo/v45.png", "1_Solo/other.png"})
                self.assertEqual(paths_for("not-a-family"), {"1_Solo/v5.png", "1_Solo/v45.png", "1_Solo/other.png"})


if __name__ == "__main__":
    unittest.main()
