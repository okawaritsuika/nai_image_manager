import ast
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import types
import unittest
from unittest import mock

from naim.storage.history import HistoryDB


class GalleryUpgradeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="naim-gallery-upgrade-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        patch = mock.patch("naim.storage.history.get_app_dir", return_value=str(self.root))
        patch.start()
        self.addCleanup(patch.stop)

    @staticmethod
    def _create_current_schema(path, rows=(), *, full="0", available=None, reset=None):
        conn = sqlite3.connect(path)
        conn.executescript(
            """
            CREATE TABLE gallery_images (
                rel_path TEXT PRIMARY KEY, folder_path TEXT, file_name TEXT, mode TEXT,
                rating TEXT, brand TEXT, character_names TEXT, is_dakimakura INTEGER,
                width INTEGER, height INTEGER, mtime REAL, reason TEXT, gallery_tag TEXT,
                model_family TEXT, updated_at REAL, ctime REAL
            );
            CREATE TABLE gallery_index_state (
                key TEXT PRIMARY KEY, value TEXT, updated_at REAL
            );
            """
        )
        if full is not None:
            conn.execute("INSERT INTO gallery_index_state VALUES ('full_index_built', ?, 10)", (full,))
        if available is not None:
            conn.execute("INSERT INTO gallery_index_state VALUES ('legacy_gallery_index_available', ?, 11)", (available,))
        if reset is not None:
            conn.execute("INSERT INTO gallery_index_state VALUES ('gallery_index_reset_for_reclassify', ?, 12)", (reset,))
        for path_value, family, mtime in rows:
            folder, name = os.path.split(path_value)
            conn.execute(
                "INSERT INTO gallery_images VALUES (?, ?, ?, 'general', 'safe', '', '[]', 0, 1024, 1536, ?, "
                "'synthetic reason', 'synthetic tag', ?, 20, ?)",
                (path_value, folder, name, mtime, family, mtime + 1),
            )
        conn.commit()
        conn.close()

    @staticmethod
    def _create_old_schema(path, *, full="1"):
        conn = sqlite3.connect(path)
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
            """
        )
        conn.execute("INSERT INTO gallery_index_state VALUES ('full_index_built', ?, 987.25)", (full,))
        conn.execute(
            "INSERT INTO gallery_images VALUES (?, ?, ?, 'general', 'safe', '', '[]', 0, 1024, 1536, ?, "
            "'legacy reason', 'legacy tag', 456)",
            ("1_Solo/legacy.png", "1_Solo", "legacy.png", 123.5),
        )
        conn.commit()
        conn.close()

    def _open(self, path):
        return HistoryDB(path)

    def test_interrupted_migration_preserves_classified_rows_and_exposes_only_the_cached_snapshot(self):
        path = self.root / "interrupted.sqlite"
        self._create_current_schema(
            path,
            rows=[("1_Solo/legacy.png", None, 123.5),
                  ("1_Solo/v45.png", "v4_5", 124.5),
                  ("1_Solo/other.png", "other", 125.5)],
        )

        with mock.patch("PIL.Image.open", side_effect=AssertionError("migration must not decode images")):
            db = self._open(path)
        try:
            self.assertFalse(db.has_full_gallery_index())
            self.assertTrue(db.has_usable_gallery_index())
            self.assertEqual(db.get_gallery_index_state("legacy_gallery_index_available"), "1")
            self.assertEqual(db.get_gallery_index_state("legacy_gallery_model_default"), "v5")
            self.assertEqual(
                db.conn.execute("SELECT rel_path, model_family FROM gallery_images ORDER BY rel_path").fetchall(),
                [("1_Solo/legacy.png", "v5"), ("1_Solo/other.png", "other"), ("1_Solo/v45.png", "v4_5")],
            )
        finally:
            db.close()

    def test_empty_reset_and_nonlegacy_partial_indexes_are_not_usable(self):
        cases = [
            ("empty", [], "0", None, None),
            ("classified-partial", [("1_Solo/known.png", "v4_5", 1)], "0", None, None),
            ("reset-partial", [("1_Solo/legacy.png", None, 1)], "0", None, "1"),
            ("stale-empty-marker", [], "0", "1", None),
        ]
        for name, rows, full, available, reset in cases:
            with self.subTest(name=name):
                path = self.root / f"{name}.sqlite"
                self._create_current_schema(path, rows, full=full, available=available, reset=reset)
                db = self._open(path)
                try:
                    self.assertFalse(db.has_full_gallery_index())
                    self.assertFalse(db.has_usable_gallery_index())
                finally:
                    db.close()

        # Adding model_family to an old, already incomplete index must not
        # turn that snapshot into a usable cache or claim it is complete.
        old_partial = self.root / "old-partial.sqlite"
        self._create_old_schema(old_partial, full="0")
        db = self._open(old_partial)
        try:
            self.assertEqual(db.get_gallery_index_state("full_index_built"), "0")
            self.assertEqual(db.get_gallery_index_state("legacy_gallery_index_available"), None)
            self.assertFalse(db.has_full_gallery_index())
            self.assertFalse(db.has_usable_gallery_index())
            self.assertEqual(
                db.conn.execute("SELECT model_family FROM gallery_images WHERE rel_path = '1_Solo/legacy.png'").fetchone(),
                ("v5",),
            )
        finally:
            db.close()

    def test_clear_and_reset_remove_cached_availability_even_after_new_rows_are_added(self):
        for operation in ("clear", "reset"):
            with self.subTest(operation=operation):
                path = self.root / f"{operation}.sqlite"
                self._create_current_schema(path, [("1_Solo/legacy.png", None, 1)])
                db = self._open(path)
                try:
                    self.assertTrue(db.has_usable_gallery_index())
                    if operation == "clear":
                        db.clear_gallery_index()
                    else:
                        self.assertTrue(db.reset_db())
                    db.upsert_gallery_image_records([{
                        "rel_path": "1_Solo/new.png", "folder_path": "1_Solo", "file_name": "new.png",
                        "mode": "general", "model_family": "v5", "mtime": 2, "ctime": 3,
                    }])
                    self.assertFalse(db.has_full_gallery_index())
                    self.assertFalse(db.has_usable_gallery_index())
                    self.assertIsNone(db.get_gallery_index_state("legacy_gallery_index_available"))
                finally:
                    db.close()

    def test_successful_publish_replaces_cached_state_with_a_full_index(self):
        live_path = self.root / "live.sqlite"
        staging_path = self.root / "staging.sqlite"
        self._create_current_schema(live_path, [("1_Solo/legacy.png", None, 1)])
        live = self._open(live_path)
        staging = self._open(staging_path)
        try:
            self.assertTrue(live.has_usable_gallery_index())
            staging.capture_gallery_index_baseline(live_path)
            staging.upsert_gallery_image_records([{
                "rel_path": "1_Solo/new.png", "folder_path": "1_Solo", "file_name": "new.png",
                "mode": "general", "model_family": "v5", "mtime": 2, "ctime": 3,
            }])
            staging.rebuild_gallery_folder_summaries()
            live.replace_gallery_index_from(staging)
            self.assertTrue(live.has_full_gallery_index())
            self.assertTrue(live.has_usable_gallery_index())
            self.assertIsNone(live.get_gallery_index_state("legacy_gallery_index_available"))
            self.assertEqual(
                live.conn.execute("SELECT rel_path FROM gallery_images ORDER BY rel_path").fetchall(),
                [("1_Solo/new.png",)],
            )
        finally:
            staging.close()
            live.close()

    def _app_namespace(self, db_path, *, start_calls=None, page_json=None):
        source_path = Path(__file__).resolve().parents[1] / "app.py"
        source = ast.parse(source_path.read_text(encoding="utf-8-sig"))
        function_names = {
            "normalize_gallery_display_folder_path",
            "build_gallery_data_payload_from_index",
            "get_data",
            "get_gallery_image_page",
            "gallery_index_status",
        }
        functions = [node for node in source.body
                     if isinstance(node, ast.FunctionDef) and node.name in function_names]
        for function in functions:
            function.decorator_list = []
        if {function.name for function in functions} != function_names:
            self.fail("Expected gallery API functions were not found in app.py")

        statuses = []
        starts = start_calls if start_calls is not None else []

        class Args(dict):
            def get(self, key, default=None):
                return super().get(key, default)

        request = types.SimpleNamespace(
            args=Args({}),
            get_json=lambda **_kwargs: page_json or {},
        )
        namespace = {
            "os": os,
            "time": time,
            "threading": threading,
            "request": request,
            "jsonify": lambda payload=None, **kwargs: payload if payload is not None else kwargs,
            "utils": types.SimpleNamespace(HistoryDB=lambda: HistoryDB(db_path)),
            "image_logic": types.SimpleNamespace(
                normalize_model_family_filter=lambda value: value or "all",
                normalize_model_family=lambda value: value or "other",
            ),
            "CLASSIFIED_DIR": str(self.root / "TOTAL_CLASSIFIED"),
            "GALLERY_SERVER_SESSION_ID": "synthetic-session",
            "GALLERY_INDEX_REBUILD_LOCK": threading.Lock(),
            "GALLERY_INDEX_REBUILD_JOB": {},
            "load_gallery_image_tags_config": lambda: {"tags": [], "image_tags": {}},
            "get_gallery_image_tag_for_path": lambda *_args: "",
            "decorate_comic_node": lambda *_args: None,
            "build_gallery_brand_payload": lambda *_args: ({}, {}),
            "update_gallery_data_status": lambda **values: statuses.append(values),
            "get_gallery_data_status_snapshot": lambda: {"folders": 1, "images": 1},
            "start_gallery_index_rebuild_background": lambda **values: (starts.append(values) or True, True),
            "build_gallery_data_payload_from_scan": lambda *_args: (_ for _ in ()).throw(
                AssertionError("cached gallery data must not scan the image tree")
            ),
            "get_file_creation_time": lambda _path, fallback: fallback,
        }
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(source_path), "exec"), namespace)
        namespace["_statuses"] = statuses
        namespace["_request"] = request
        return namespace

    @staticmethod
    def _image_paths(node):
        paths = [image["path"] for image in node.get("images", [])]
        for child in node.get("folders", []):
            paths.extend(GalleryUpgradeTests._image_paths(child))
        return paths

    def test_completed_legacy_database_returns_its_tree_without_starting_a_rebuild(self):
        path = self.root / "complete-old.sqlite"
        self._create_old_schema(path)
        db = self._open(path)
        try:
            db.conn.execute("UPDATE gallery_images SET ctime = 123.5")
            db.conn.commit()
            self.assertTrue(db.has_full_gallery_index())
            self.assertTrue(db.has_usable_gallery_index())
        finally:
            db.close()

        starts = []
        namespace = self._app_namespace(path, start_calls=starts)
        result = namespace["get_data"]()
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["index_mode"], "full_index")
        self.assertEqual(self._image_paths(result["tree"]), ["1_Solo/legacy.png"])
        self.assertEqual(starts, [])

    def test_interrupted_cached_database_serves_catalog_page_and_starts_one_background_rebuild(self):
        path = self.root / "cached.sqlite"
        self._create_current_schema(path, [("1_Solo/legacy.png", None, 123.5)])
        starts = []
        namespace = self._app_namespace(
            path,
            start_calls=starts,
            page_json={"mode": "general", "model_family": "all", "folders": ["1_Solo"], "limit": 10},
        )

        result = namespace["get_data"]()
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["index_mode"], "cached_index")
        self.assertEqual(self._image_paths(result["tree"]), ["1_Solo/legacy.png"])
        self.assertEqual(starts, [{"auto": True}])

        db = self._open(path)
        try:
            self.assertFalse(db.has_full_gallery_index())
            self.assertTrue(db.has_usable_gallery_index())
        finally:
            db.close()

        page = namespace["get_gallery_image_page"]()
        self.assertEqual(page["status"], "success")
        self.assertEqual([image["path"] for image in page["images"]], ["1_Solo/legacy.png"])

        status = namespace["gallery_index_status"]()
        self.assertTrue(status["index_mode_available"])
        self.assertFalse(status["full_index_built"])


if __name__ == "__main__":
    unittest.main()
