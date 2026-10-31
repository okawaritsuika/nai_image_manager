from contextlib import closing
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from naim.storage import legacy_import
import naim_updater


class LegacyImportTests(unittest.TestCase):
    def test_config_path_is_relocated_even_without_history_db(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, target = Path(temporary) / 'old', Path(temporary) / 'new'
            source.mkdir()
            (source / 'gallery_config.json').write_text(json.dumps({'path': str(source / 'output')}))
            legacy_import.import_installation(source, target)
            self.assertEqual(json.loads((target / 'gallery_config.json').read_text())['path'], str(target / 'output'))

    def test_import_preserves_source_unknown_settings_and_relocates_history(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, target = Path(temporary) / 'old', Path(temporary) / 'new'
            source.mkdir(); target.mkdir()
            for directory in legacy_import.DATA_DIRECTORIES:
                (source / directory).mkdir()
                (source / directory / 'synthetic.png').write_bytes(b'synthetic')
            personal_catalog = b'{"version":1,"styles":[{"name":"personal ink","source_path":"folder/source.png"}]}'
            (source / 'daki_personal_styles' / 'catalog.json').write_bytes(personal_catalog)
            worldcup = b'{"version":1,"title":"synthetic tournament","choices":["sample.png"]}'
            (source / 'daki_worldcups' / 'record.json').write_bytes(worldcup)
            config = {'path': str(source / 'output'), 'unknown_setting': [1, 2]}
            (source / 'gallery_config.json').write_text(json.dumps(config))
            (source / 'canvas_saved_setups.json').write_text('[{"id":"synthetic","state":{}}]')
            (source / 'NAI_Image_Manager.exe').write_bytes(b'old executable must not be copied')
            (source / 'data').mkdir()
            (source / 'data/tag_categories_ko.json').write_text('{"synthetic":"translation"}')
            (target / 'gallery_config.json').write_bytes(b'new-config-backup')
            database = source / 'TOTAL_CLASSIFIED/naia_history.db'
            with closing(sqlite3.connect(database)) as db:
                db.execute('PRAGMA journal_mode=WAL')
                db.execute('CREATE TABLE trash_map (trash_path TEXT PRIMARY KEY, original_path TEXT)')
                db.execute('INSERT INTO trash_map VALUES (?, ?)', (str(source / 'TOTAL_CLASSIFIED/_TRASH/image.png'), str(source / 'TOTAL_CLASSIFIED/group/image.png')))
                db.execute('CREATE TABLE legacy_extension (value TEXT)')
                db.execute("INSERT INTO legacy_extension VALUES ('preserved')")
                db.commit()
                result = legacy_import.import_installation(source, target)
            self.assertEqual(json.loads((source / 'gallery_config.json').read_text()), config)
            imported = json.loads((target / 'gallery_config.json').read_text())
            self.assertEqual(imported['path'], str(target / 'output'))
            self.assertEqual(imported['unknown_setting'], [1, 2])
            self.assertFalse((target / 'NAI_Image_Manager.exe').exists())
            self.assertEqual((Path(result['backup']) / 'gallery_config.json').read_bytes(), b'new-config-backup')
            self.assertEqual((target / 'canvas_saved_setups.json').read_bytes(), (source / 'canvas_saved_setups.json').read_bytes())
            self.assertEqual((target / 'daki_style_tests/synthetic.png').read_bytes(), b'synthetic')
            self.assertEqual((target / 'daki_drafts/synthetic.png').read_bytes(), b'synthetic')
            self.assertEqual((target / 'daki_tag_examples/synthetic.png').read_bytes(), b'synthetic')
            self.assertEqual((target / 'daki_dictionary_user/synthetic.png').read_bytes(), b'synthetic')
            self.assertEqual((target / 'daki_imported_styles/synthetic.png').read_bytes(), b'synthetic')
            self.assertEqual((target / 'daki_personal_styles/catalog.json').read_bytes(), personal_catalog)
            self.assertEqual((source / 'daki_personal_styles/catalog.json').read_bytes(), personal_catalog)
            self.assertEqual((target / 'daki_worldcups/record.json').read_bytes(), worldcup)
            self.assertEqual((source / 'daki_worldcups/record.json').read_bytes(), worldcup)
            with closing(sqlite3.connect(target / 'TOTAL_CLASSIFIED/naia_history.db')) as db:
                self.assertEqual(db.execute('SELECT value FROM legacy_extension').fetchone()[0], 'preserved')
                self.assertEqual(db.execute('SELECT original_path FROM trash_map').fetchone()[0], str(target / 'TOTAL_CLASSIFIED/group/image.png'))

    def test_failed_publish_restores_destination(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, target = Path(temporary) / 'old', Path(temporary) / 'new'
            source.mkdir(); target.mkdir()
            (source / 'gallery_config.json').write_text('{}')
            (target / 'gallery_config.json').write_bytes(b'original')
            replace = legacy_import.os.replace

            def fail(source_path, target_path):
                if Path(source_path).parent.name.startswith('.naim-import-'):
                    raise OSError('synthetic publish failure')
                return replace(source_path, target_path)

            with mock.patch.object(legacy_import.os, 'replace', side_effect=fail):
                with self.assertRaises(OSError):
                    legacy_import.import_installation(source, target)
            self.assertEqual((target / 'gallery_config.json').read_bytes(), b'original')
            self.assertEqual((source / 'gallery_config.json').read_text(), '{}')

    def test_same_nested_and_non_installation_folders_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for source, target in ((root, root), (root, root / 'child'), (root / 'child', root)):
                with self.assertRaises(ValueError):
                    legacy_import.inspect_installation(source, target)
            with self.assertRaises(ValueError):
                legacy_import.inspect_installation(root, root.parent / 'synthetic-unused')

    def test_wait_for_process_does_not_terminate_the_process(self):
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(1)'], creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        try:
            with self.assertRaises(TimeoutError):
                naim_updater.wait_for_process(child.pid, timeout=0.02)
            self.assertIsNone(child.poll())
            naim_updater.wait_for_process(child.pid, timeout=5)
            self.assertEqual(child.wait(), 0)
        finally:
            if child.poll() is None:
                child.terminate()
                child.wait()
