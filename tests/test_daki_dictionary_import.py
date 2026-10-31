from contextlib import closing
import importlib.util
import json
from pathlib import Path, PurePosixPath
import sqlite3
import tempfile
import unittest

import naim_updater
from naim.storage.legacy_import import DATA_DIRECTORIES


spec = importlib.util.spec_from_file_location(
    'dictionary_import', Path(__file__).resolve().parents[1] / 'tools/import_daki_dictionary.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DictionaryImportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.source, self.target = root / 'source', root / 'target'
        self.target.mkdir()
        data = self.source / 'data'
        data.mkdir(parents=True)
        payload = {'source': {'rows': 1, 'requested_path': '/synthetic/source',
                              'preserved_path': '/synthetic/backup', 'sha256': 'synthetic'},
                   'tags': [{'tag': 'smile', 'ko': '미소', 'categories': ['표정/웃음']}],
                   'categories': []}
        (data / 'dictionary.json').write_text(json.dumps(payload), encoding='utf-8')
        (data / 'user_edits.json').write_text('{"smile":{"ko":"합성 미소","unknown":7}}', encoding='utf-8')
        with closing(sqlite3.connect(data / 'image_catalog.sqlite3')) as db:
            db.executescript("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);"
                             "CREATE TABLE images(id INTEGER PRIMARY KEY,path TEXT);"
                             "INSERT INTO settings VALUES('folder','/synthetic/images');"
                             "INSERT INTO images VALUES(19,'/synthetic/images/one.png');")
        self.rows = [{'id': 1, 'general': 'smile', 'rating': 'g'}]

    def run_import(self):
        return module.import_dictionary(self.source, self.target, read_rows=lambda path: self.rows)

    def test_copies_connections_and_edits_without_source_paths_in_bundle(self):
        source_files = {p.name: p.read_bytes() for p in (self.source / 'data').iterdir()}
        self.assertEqual(self.run_import(), {'tags': 1, 'combinations': 1, 'indexed_images': 1})
        base = self.target / 'data/daki_dictionary'
        user = self.target / 'daki_dictionary_user'
        payload = json.loads((base / 'dictionary.json').read_text(encoding='utf-8'))
        self.assertEqual(payload['source'], {'sha256': 'synthetic', 'rows': 1, 'unique_tags': 1})
        self.assertEqual(json.loads((base / 'source_combinations.json').read_text()), self.rows)
        self.assertEqual((user / 'user_edits.json').read_bytes(), source_files['user_edits.json'])
        with closing(sqlite3.connect(user / 'image_catalog.sqlite3')) as db:
            self.assertEqual(db.execute('SELECT * FROM images').fetchone(), (19, '/synthetic/images/one.png'))
            self.assertEqual(db.execute('SELECT value FROM settings').fetchone()[0], '/synthetic/images')
        self.assertEqual({p.name: p.read_bytes() for p in (self.source / 'data').iterdir()}, source_files)

    def test_existing_installation_is_never_overwritten(self):
        self.run_import()
        marker = self.target / 'daki_dictionary_user/user_edits.json'
        before = marker.read_bytes()
        with self.assertRaises(ValueError):
            self.run_import()
        self.assertEqual(marker.read_bytes(), before)

    def test_mismatched_rows_fail_before_destination_is_written(self):
        self.rows[0]['general'] = 'closed eyes'
        with self.assertRaises(ValueError):
            self.run_import()
        self.assertFalse((self.target / 'data').exists())
        self.assertFalse((self.target / 'daki_dictionary_user').exists())

    def test_runtime_protection_does_not_block_distributable_assets(self):
        self.assertIn('daki_dictionary_user', DATA_DIRECTORIES)
        self.assertTrue(naim_updater._is_protected(PurePosixPath('daki_dictionary_user/user_edits.json')))
        self.assertFalse(naim_updater._is_protected(PurePosixPath('data/daki_dictionary/dictionary.json')))
        self.assertFalse(naim_updater._is_protected(PurePosixPath('static/daki_dictionary/app.js')))


if __name__ == '__main__':
    unittest.main()
