import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import Mock, patch

from naim.style_connection import (
    AmbiguousDataDirectories,
    current_connection,
    inspect_connection,
    save_connection,
)
from naim.storage.json_files import write_json


class StyleConnectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path.cwd())
        self.root = Path(self.temp.name)
        self.app_dir = self.root / "naim"
        self.app_dir.mkdir()
        self.selected = self.root / "NAImakeArtistGroup"
        self.selected.mkdir()
        self.source = self.selected / "artist_rater"
        self._make_runtime(self.source)
        self.data_dir = self.source / "data"
        self._make_database(self.data_dir)
        self._write_json(self.data_dir / "settings.json", {
            "novelai_app_key": "source-key-fixture",
            "preserved": {"mode": "keep"},
        })
        self._write_json(self.app_dir / "lab_config.json", {
            "key": "current-key-fixture",
            "width": 1024,
            "unknown_lab_setting": "preserve",
        })
        self._write_json(self.app_dir / "style_workspace.local.json", {
            "source_dir": str(self.source),
            "python": str(self.source / ".venv" / "Scripts" / "python.exe"),
            "unknown_connection_setting": "preserve",
        })

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def _write_json(path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    @staticmethod
    def _make_database(path):
        path.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(path / "artist_rater.sqlite") as database:
            database.execute("CREATE TABLE synthetic_fixture (id INTEGER PRIMARY KEY)")

    @staticmethod
    def _make_runtime(path):
        path.mkdir(parents=True, exist_ok=True)
        (path / "app.py").write_text("# synthetic app\n", encoding="utf-8")
        (path / "naim_runner.py").write_text("# synthetic runner\n", encoding="utf-8")
        python = path / ".venv" / "Scripts" / "python.exe"
        python.parent.mkdir(parents=True, exist_ok=True)
        python.write_bytes(b"synthetic python executable")

    def inspect(self, *, data_dir=None):
        return inspect_connection(self.app_dir, self.selected, data_dir=data_dir)

    def test_inspection_uses_existing_runtime_and_detects_key_conflict_without_writing(self):
        config_path = self.app_dir / "style_workspace.local.json"
        config_before = config_path.read_bytes()
        lab_before = (self.app_dir / "lab_config.json").read_bytes()
        settings_before = (self.data_dir / "settings.json").read_bytes()
        database_before = (self.data_dir / "artist_rater.sqlite").read_bytes()

        preview = self.inspect()

        self.assertEqual(preview.source_dir, str(self.source.resolve()))
        self.assertEqual(preview.data_dir, str(self.data_dir.resolve()))
        self.assertTrue(preview.key_choice_required)
        self.assertTrue(preview.current_key_present)
        self.assertTrue(preview.source_key_present)
        self.assertTrue(preview.settings_present)
        self.assertNotIn("source-key-fixture", repr(preview))
        self.assertEqual(config_path.read_bytes(), config_before)
        self.assertEqual((self.app_dir / "lab_config.json").read_bytes(), lab_before)
        self.assertEqual((self.data_dir / "settings.json").read_bytes(), settings_before)
        self.assertEqual((self.data_dir / "artist_rater.sqlite").read_bytes(), database_before)

    def test_finds_supported_database_locations_and_requires_explicit_choice_if_ambiguous(self):
        root_database = self.selected / "artist_rater.sqlite"
        self._make_database(self.selected)
        with self.assertRaises(AmbiguousDataDirectories) as raised:
            self.inspect()
        self.assertEqual(len(raised.exception.directories), 2)
        preview = self.inspect(data_dir=self.data_dir)
        self.assertEqual(preview.data_dir, str(self.data_dir.resolve()))

        root_only = self.root / "root-layout"
        self._make_runtime(root_only)
        self._make_database(root_only)
        self._write_json(root_only / "settings.json", {})
        self._write_json(self.app_dir / "style_workspace.local.json", {
            "source_dir": str(self.root / "missing-runtime"),
            "python": str(self.root / "missing-python.exe"),
        })
        root_preview = inspect_connection(self.app_dir, root_only)
        self.assertEqual(root_preview.data_dir, str(root_only.resolve()))
        self.assertEqual(root_preview.source_dir, str(root_only.resolve()))
        self.assertTrue(root_database.is_file())

        data_layout = self.root / "data-layout"
        self._make_runtime(data_layout / "artist_rater")
        self._make_database(data_layout / "data")
        data_preview = inspect_connection(self.app_dir, data_layout)
        self.assertEqual(data_preview.data_dir, str((data_layout / "data").resolve()))
        self.assertEqual(data_preview.source_dir, str((data_layout / "artist_rater").resolve()))

    def test_rejects_missing_or_non_sqlite_database(self):
        with tempfile.TemporaryDirectory() as empty:
            selected = Path(empty)
            with self.assertRaisesRegex(ValueError, "데이터베이스"):
                inspect_connection(self.app_dir, selected)
        with self.assertRaisesRegex(ValueError, "폴더"):
            inspect_connection(self.app_dir, self.root / "missing-folder")
        with self.assertRaisesRegex(ValueError, "데이터 폴더"):
            self.inspect(data_dir=self.root)

        bad = self.root / "bad-db"
        self._make_runtime(bad)
        bad.mkdir(exist_ok=True)
        (bad / "artist_rater.sqlite").write_bytes(b"not a sqlite database")
        with self.assertRaisesRegex(ValueError, "데이터베이스"):
            inspect_connection(self.app_dir, bad)

    def test_prefers_valid_existing_runtime_and_python(self):
        installed = self.root / "installed-bridge"
        self._make_runtime(installed)
        installed_python = self.root / "installed-python.exe"
        installed_python.write_bytes(b"synthetic python executable")
        self._write_json(self.app_dir / "style_workspace.local.json", {
            "source_dir": str(installed),
            "python": str(installed_python),
        })
        preview = self.inspect()
        self.assertEqual(preview.source_dir, str(installed.resolve()))
        self.assertEqual(preview.python, str(installed_python.resolve()))

    def test_rejects_malformed_settings_without_repairing_them(self):
        settings = self.data_dir / "settings.json"
        settings.write_bytes(b"{invalid")
        before = settings.read_bytes()
        with self.assertRaisesRegex(ValueError, "형식"):
            self.inspect()
        self.assertEqual(settings.read_bytes(), before)
        self.assertEqual(list(self.data_dir.glob("settings.json.corrupt-*.bak")), [])

    def test_utf8_sig_json_is_supported_and_duplicate_fields_are_rejected(self):
        config_path = self.app_dir / "style_workspace.local.json"
        config_path.write_bytes(
            b'\xef\xbb\xbf' + json.dumps({
                "source_dir": str(self.source),
                "python": str(self.source / ".venv" / "Scripts" / "python.exe"),
            }).encode("utf-8")
        )
        self.assertEqual(self.inspect().source_dir, str(self.source.resolve()))
        config_path.write_text('{"source_dir":"a","source_dir":"b"}', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "형식"):
            self.inspect()

    def test_key_choice_is_required_and_keep_preserves_both_settings_objects(self):
        preview = self.inspect()
        config_path = self.app_dir / "style_workspace.local.json"
        config_before = json.loads(config_path.read_text(encoding="utf-8"))
        lab_path = self.app_dir / "lab_config.json"
        lab_before = json.loads(lab_path.read_text(encoding="utf-8"))
        with self.assertRaisesRegex(ValueError, "선택"):
            save_connection(preview)
        self.assertEqual(json.loads(config_path.read_text(encoding="utf-8")), config_before)
        self.assertEqual(json.loads(lab_path.read_text(encoding="utf-8")), lab_before)

        save_connection(preview, key_choice="keep")
        saved_config = json.loads(config_path.read_text(encoding="utf-8"))
        saved_lab = json.loads(lab_path.read_text(encoding="utf-8"))
        self.assertEqual(saved_config["unknown_connection_setting"], "preserve")
        self.assertEqual(saved_lab["unknown_lab_setting"], "preserve")
        self.assertEqual(saved_lab["key"], "current-key-fixture")
        self.assertEqual(saved_config["data_dir"], str(self.data_dir.resolve()))

    def test_use_source_key_only_updates_common_key_and_keeps_unknown_fields(self):
        preview = self.inspect()
        lab_path = self.app_dir / "lab_config.json"
        before = json.loads(lab_path.read_text(encoding="utf-8"))
        source_settings_before = (self.data_dir / "settings.json").read_bytes()
        database_before = (self.data_dir / "artist_rater.sqlite").read_bytes()
        save_connection(preview, key_choice="use_source")
        after = json.loads(lab_path.read_text(encoding="utf-8"))
        self.assertEqual(after["key"], "source-key-fixture")
        self.assertEqual(after["width"], before["width"])
        self.assertEqual(after["unknown_lab_setting"], before["unknown_lab_setting"])
        self.assertEqual(
            json.loads((self.data_dir / "settings.json").read_text(encoding="utf-8")),
            {"novelai_app_key": "source-key-fixture", "preserved": {"mode": "keep"}},
        )
        self.assertEqual((self.data_dir / "settings.json").read_bytes(), source_settings_before)
        self.assertEqual((self.data_dir / "artist_rater.sqlite").read_bytes(), database_before)

    def test_empty_common_key_still_requires_a_choice_and_can_use_source_key(self):
        lab_path = self.app_dir / "lab_config.json"
        lab = json.loads(lab_path.read_text(encoding="utf-8"))
        lab["key"] = ""
        self._write_json(lab_path, lab)
        preview = self.inspect()
        self.assertFalse(preview.current_key_present)
        self.assertTrue(preview.key_choice_required)
        with self.assertRaises(ValueError):
            save_connection(preview)
        save_connection(preview, key_choice="use_source")
        saved_lab = json.loads(lab_path.read_text(encoding="utf-8"))
        self.assertEqual(saved_lab["key"], "source-key-fixture")
        self.assertEqual(saved_lab["unknown_lab_setting"], "preserve")

    def test_missing_source_key_never_clears_an_existing_common_key(self):
        self._write_json(self.data_dir / "settings.json", {"other": "keep"})
        preview = self.inspect()
        self.assertFalse(preview.source_key_present)
        self.assertFalse(preview.key_choice_required)
        save_connection(preview)
        lab = json.loads((self.app_dir / "lab_config.json").read_text(encoding="utf-8"))
        self.assertEqual(lab["key"], "current-key-fixture")
        with self.assertRaisesRegex(ValueError, "키"):
            save_connection(self.inspect(), key_choice="use_source")

    def test_stale_settings_require_a_new_preview_without_touching_configuration(self):
        preview = self.inspect()
        config_path = self.app_dir / "style_workspace.local.json"
        config_before = config_path.read_bytes()
        self._write_json(self.data_dir / "settings.json", {"novelai_app_key": "changed"})
        with self.assertRaisesRegex(ValueError, "변경"):
            save_connection(preview, key_choice="keep")
        self.assertEqual(config_path.read_bytes(), config_before)

    def test_cancelled_or_unapplied_preview_does_not_write_any_file(self):
        paths = (
            self.app_dir / "style_workspace.local.json",
            self.app_dir / "lab_config.json",
            self.data_dir / "settings.json",
            self.data_dir / "artist_rater.sqlite",
        )
        before = {path: path.read_bytes() for path in paths}
        self.inspect()
        self.assertEqual({path: path.read_bytes() for path in paths}, before)

    def test_second_write_failure_restores_original_connection_file(self):
        preview = self.inspect()
        config_path = self.app_dir / "style_workspace.local.json"
        before = json.loads(config_path.read_text(encoding="utf-8"))
        real_write = write_json
        calls = []

        def fail_lab_once(path, data, **kwargs):
            calls.append(Path(path))
            if len(calls) == 2:
                raise OSError("synthetic write failure")
            return real_write(path, data, **kwargs)

        with patch("naim.style_connection.write_json", side_effect=fail_lab_once):
            with self.assertRaisesRegex(RuntimeError, "복구했습니다"):
                save_connection(preview, key_choice="use_source")
        self.assertEqual(len(calls), 3)
        self.assertEqual(json.loads(config_path.read_text(encoding="utf-8")), before)
        self.assertEqual(
            json.loads((self.app_dir / "lab_config.json").read_text(encoding="utf-8"))["key"],
            "current-key-fixture",
        )

    def test_second_write_failure_removes_new_connection_file_when_none_existed(self):
        config_path = self.app_dir / "style_workspace.local.json"
        config_path.unlink()
        preview = self.inspect()
        real_write = write_json
        calls = []

        def fail_lab_once(path, data, **kwargs):
            calls.append(Path(path))
            if len(calls) == 2:
                raise OSError("synthetic write failure")
            return real_write(path, data, **kwargs)

        with patch("naim.style_connection.write_json", side_effect=fail_lab_once):
            with self.assertRaises(RuntimeError):
                save_connection(preview, key_choice="use_source")
        self.assertFalse(config_path.exists())
        self.assertEqual(len(calls), 2)

    def test_rollback_failure_reports_generic_recovery_error_without_key(self):
        preview = self.inspect()
        calls = 0

        def fail_all(_path, _data, **_kwargs):
            nonlocal calls
            calls += 1
            raise OSError("source-key-fixture")

        with patch("naim.style_connection.write_json", side_effect=fail_all):
            with self.assertRaises(RuntimeError) as raised:
                save_connection(preview, key_choice="use_source")
        self.assertIn("복구하지 못했습니다", str(raised.exception))
        self.assertNotIn("source-key-fixture", str(raised.exception))
        self.assertEqual(calls, 2)

    def test_current_connection_returns_effective_data_path_without_settings(self):
        self._write_json(self.app_dir / "style_workspace.local.json", {
            "source_dir": str(self.source),
        })
        self.assertEqual(current_connection(self.app_dir), {
            "source_dir": str(self.source),
            "data_dir": str(self.source / "data"),
        })

    def test_saved_folder_is_used_by_runner_and_shared_catalog(self):
        from flask import Flask
        from naim.web.style_workspace import StyleService
        from naim.storage.shared_library_catalog import build_shared_catalog

        installed = self.root / 'old-install'
        data = installed / 'data'
        self._make_database(data)
        preview = inspect_connection(self.app_dir, installed)
        save_connection(preview)
        process = Mock()
        process.poll.return_value = None

        def launch(command, **kwargs):
            ready = Path(command[command.index('--ready-file') + 1])
            ready.write_text('{"port": 54321}', encoding='utf-8')
            return process

        service = StyleService(self.app_dir / 'style_workspace.local.json')
        with patch('naim.web.style_workspace.subprocess.Popen', side_effect=launch) as start:
            try:
                self.assertEqual(service.start('http://127.0.0.1:5000'), 54321)
                command = start.call_args.args[0]
                self.assertEqual(command[command.index('--data-dir') + 1], str(data.resolve()))
                self.assertEqual(Path(command[2]), self.source / 'naim_runner.py')
            finally:
                service.stop()
        app = Flask(__name__)
        with patch('naim.storage.shared_library_catalog.SharedLibraryCatalog') as catalog:
            build_shared_catalog(app, Mock(), root=self.app_dir, artist_names=set())
            self.assertEqual(catalog.call_args.args[2], data.resolve())


if __name__ == "__main__":
    unittest.main()
