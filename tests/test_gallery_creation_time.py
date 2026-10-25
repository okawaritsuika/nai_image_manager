import os
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import types
import unittest
from unittest import mock

from naim.paths import get_file_creation_time
from naim.storage.history import HistoryDB


class GalleryCreationTimeTests(unittest.TestCase):
    def test_birthtime_and_platform_fallbacks(self):
        stat = types.SimpleNamespace(st_birthtime=10, st_ctime=20, st_mtime=30)
        with mock.patch('naim.paths.os.stat', return_value=stat):
            self.assertEqual(get_file_creation_time('synthetic.png'), 10)
        del stat.st_birthtime
        with mock.patch('naim.paths.os.stat', return_value=stat):
            with mock.patch('naim.paths.os.name', 'nt'):
                self.assertEqual(get_file_creation_time('synthetic.png'), 20)
            with mock.patch('naim.paths.os.name', 'posix'):
                self.assertEqual(get_file_creation_time('synthetic.png'), 30)
        with mock.patch('naim.paths.os.stat', side_effect=FileNotFoundError):
            self.assertEqual(get_file_creation_time('missing.png', 40), 40)

    def test_legacy_index_is_preserved_and_backfilled_once(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            image = root / 'synthetic.png'
            image.write_bytes(b'synthetic')
            os.utime(image, (100, 100))
            database = root / 'history.sqlite'
            with closing(sqlite3.connect(database)) as connection:
                connection.executescript('''
                    CREATE TABLE gallery_images (
                        rel_path TEXT PRIMARY KEY, folder_path TEXT, file_name TEXT,
                        mode TEXT, rating TEXT, brand TEXT, character_names TEXT,
                        is_dakimakura INTEGER, width INTEGER, height INTEGER,
                        mtime REAL, reason TEXT, gallery_tag TEXT, model_family TEXT, updated_at REAL
                    );
                    CREATE TABLE gallery_index_state (key TEXT PRIMARY KEY, value TEXT, updated_at REAL);
                    INSERT INTO gallery_index_state VALUES ('full_index_built', '1', 1);
                    INSERT INTO gallery_images (rel_path, mtime, gallery_tag, model_family)
                    VALUES ('synthetic.png', 100, 'synthetic-tag', 'v5'), ('missing.png', 200, '', 'other');
                ''')
            db = HistoryDB(database)
            try:
                self.assertEqual(db.get_gallery_index_state('full_index_built'), '1')
                with mock.patch('naim.storage.history.get_file_creation_time', wraps=get_file_creation_time) as read:
                    db.ensure_gallery_image_creation_times(root)
                    db.ensure_gallery_image_creation_times(root)
                self.assertEqual(read.call_count, 2)
                self.assertEqual(db.conn.execute(
                    "SELECT mtime, ctime, gallery_tag, model_family FROM gallery_images WHERE rel_path = 'synthetic.png'"
                ).fetchone(), (100, get_file_creation_time(image), 'synthetic-tag', 'v5'))
                self.assertEqual(db.conn.execute(
                    "SELECT ctime FROM gallery_images WHERE rel_path = 'missing.png'"
                ).fetchone()[0], 200)
            finally:
                db.close()

    def test_record_build_and_legacy_batch_writers_store_creation_time(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            image = root / 'synthetic.png'
            image.write_bytes(b'synthetic')
            os.utime(image, (100, 100))
            db = HistoryDB(root / 'history.sqlite')
            try:
                record = db.build_gallery_image_record_from_file(
                    image, classified_root=root, width=1, height=1, model_family='other'
                )
                self.assertEqual(record['ctime'], get_file_creation_time(image))
                self.assertEqual(record['mtime'], 100)
                del record['ctime']  # Existing classification/rebuild callers only provide mtime.
                db.upsert_gallery_image_records([record])
                self.assertEqual(db.conn.execute('SELECT mtime, ctime FROM gallery_images').fetchone(),
                                 (100, get_file_creation_time(image)))
                record['ctime'] = 50
                db.upsert_gallery_image_records([record])
                self.assertEqual(db.conn.execute('SELECT ctime FROM gallery_images').fetchone()[0], 50)
            finally:
                db.close()

    def test_scan_and_index_payloads_include_creation_and_modification_times(self):
        from PIL import Image
        from tests import test_model_family_backend as model_tests

        app = model_tests.GalleryModelFamilyMigrationTests._load_app_without_flask()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            database = root / 'history.sqlite'
            expected = {}
            db = HistoryDB(database)
            try:
                for relative in ('1_Solo/sample/a.png', '1_Solo/sample/_upscaled/b.png'):
                    image = root / relative
                    image.parent.mkdir(parents=True, exist_ok=True)
                    Image.new('RGB', (4, 4), 'blue').save(image)
                    os.utime(image, (100, 100))
                    expected[relative] = get_file_creation_time(image)
                    db.upsert_gallery_image_file(image, classified_root=root)
                # Also exercise the payload's backfill for a pre-existing index.
                with db.conn:
                    db.conn.execute('UPDATE gallery_images SET ctime = NULL')
            finally:
                db.close()
            with mock.patch.object(app, 'CLASSIFIED_DIR', str(root)), \
                 mock.patch.object(app.utils, 'HistoryDB', side_effect=lambda: HistoryDB(database)), \
                 mock.patch.object(app, 'load_gallery_image_tags_config', return_value={}):
                for build in (app.build_gallery_data_payload_from_scan, app.build_gallery_data_payload_from_index):
                    with self.subTest(builder=build.__name__):
                        payload = build('all', 'name')
                        images = model_tests.GalleryModelFamilyMigrationTests._flatten_images(payload['tree'])
                        self.assertEqual({item['path']: item['ctime'] for item in images}, expected)
                        self.assertTrue(all(item['mtime'] == 100 for item in images))


if __name__ == '__main__':
    unittest.main()
