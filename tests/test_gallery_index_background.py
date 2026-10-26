import ast
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import types
import unittest
from unittest import mock

from naim.gallery.catalog import gallery_image_page
from naim.storage.history import HistoryDB


class GalleryIndexBackgroundTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='naim-gallery-background-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        patch = mock.patch('naim.storage.history.get_app_dir', return_value=str(self.root))
        patch.start()
        self.addCleanup(patch.stop)
        self.live_path = self.root / 'live.db'
        self.live = HistoryDB(self.live_path)
        self.addCleanup(self.live.close)
        self.add_image(self.live, 'previous/old.png', 11)
        self.live.rebuild_gallery_folder_summaries()
        self.live.set_gallery_index_state('full_index_built', '1')
        self.live.set_gallery_index_state('custom_state', 'preserved')
        self.live.upsert_gallery_prompt_records([{
            'rel_path': 'previous/old.png', 'prompt_text': 'synthetic prompt',
        }])
        with self.live.conn:
            self.live.conn.execute("INSERT INTO processed_files (file_hash, file_name) VALUES ('synthetic-hash', 'old.png')")
            self.live.conn.execute("INSERT INTO file_metadata VALUES ('previous/old.png', 8, 12, 11)")
            self.live.conn.execute("INSERT INTO known_characters (tag, clean_name) VALUES ('synthetic-tag', 'synthetic-name')")
            self.live.conn.execute("INSERT INTO gallery_prompt_index_profiles (id, name) VALUES ('synthetic-profile', 'Preserved profile')")
            self.live.conn.execute("INSERT INTO gallery_prompt_index_profile_items VALUES ('synthetic-profile', 'previous/old.png')")

    @staticmethod
    def add_image(db, path, timestamp):
        db.upsert_gallery_image_records([{
            'rel_path': path, 'mtime': timestamp, 'ctime': timestamp,
            'width': 8, 'height': 12, 'gallery_tag': 'synthetic-tag',
        }])

    def snapshot(self, db, include_gallery=True):
        excluded = set() if include_gallery else {'gallery_images', 'gallery_folders'}
        result = {}
        for (table,) in db.conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"):
            if table in excluded:
                continue
            rows = db.conn.execute(f'SELECT * FROM "{table}" ORDER BY rowid').fetchall()
            if table == 'gallery_index_state' and not include_gallery:
                rows = [row for row in rows if row[0] not in {'full_index_built', 'partial_index_updated_at'}]
            result[table] = rows
        return result

    def worker(self, read_reason, extract_model_family=None):
        classified = self.root / 'images'
        (classified / 'replacement').mkdir(parents=True, exist_ok=True)
        (classified / 'replacement' / 'new.png').write_bytes(b'synthetic image placeholder')
        source = Path(__file__).resolve().parents[1] / 'app.py'
        function = next(node for node in ast.parse(source.read_text(encoding='utf-8-sig')).body
                        if isinstance(node, ast.FunctionDef) and node.name == 'gallery_index_rebuild_worker')
        namespace = {
            'os': os, 'time': time, 'tempfile': tempfile,
            'utils': types.SimpleNamespace(HistoryDB=lambda path=None: HistoryDB(path or self.live_path)),
            'CLASSIFIED_DIR': str(classified), 'UPSCALE_OUTPUT_FOLDER_NAME': '_upscaled',
            'GALLERY_INDEX_REBUILD_LOCK': threading.Lock(), 'GALLERY_INDEX_DB_LOCK': threading.Lock(),
            'GALLERY_INDEX_REBUILD_JOB': {},
            'should_skip_gallery_index_child_directory': lambda *args: False,
            'should_skip_gallery_index_directory': lambda *args: False,
            'load_gallery_image_tags_config': lambda: {},
            'get_gallery_image_tag_for_path': lambda *args: 'synthetic-tag',
            'load_gallery_reason_text_for_image': read_reason,
            'image_logic': types.SimpleNamespace(
                extract_model_family_from_file=extract_model_family or (lambda _: 'v5')),
            'infer_gallery_mode_from_rel_path': lambda _: 'general',
            'get_file_creation_time': lambda path, fallback: 17,
        }
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), namespace)
        return namespace

    def test_rebuild_keeps_gallery_readable_until_complete_and_preserves_other_data(self):
        entered, release = threading.Event(), threading.Event()
        def read_reason(_):
            entered.set()
            if not release.wait(5):
                raise RuntimeError('test timed out waiting to release worker')
            return 'synthetic reason'
        namespace = self.worker(read_reason)
        preserved = self.snapshot(self.live, include_gallery=False)
        worker = threading.Thread(target=namespace['gallery_index_rebuild_worker'])
        worker.start()
        try:
            self.assertTrue(entered.wait(5))
            # Real request connections initialize HistoryDB before reading pages.
            reader = HistoryDB(self.live_path)
            try:
                self.assertTrue(reader.has_full_gallery_index())
                rows, _ = gallery_image_page(reader.conn, 'all', 'all', ['previous'])
                self.assertEqual([row[0] for row in rows], ['previous/old.png'])
                self.assertTrue(namespace['GALLERY_INDEX_DB_LOCK'].locked())
            finally:
                reader.close()
        finally:
            release.set()
            worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertFalse(namespace['GALLERY_INDEX_REBUILD_JOB']['error'])
        self.assertTrue(self.live.has_full_gallery_index())
        self.assertEqual(self.live.conn.execute('SELECT rel_path, ctime FROM gallery_images').fetchall(),
                         [('replacement/new.png', 17)])
        self.assertEqual(preserved, self.snapshot(self.live, include_gallery=False))

    def test_scan_failure_preserves_the_complete_live_index(self):
        def fail(_):
            raise RuntimeError('synthetic metadata failure')
        namespace = self.worker(fail)
        original = self.snapshot(self.live)
        namespace['gallery_index_rebuild_worker']()
        self.assertEqual(namespace['GALLERY_INDEX_REBUILD_JOB']['error'], 'synthetic metadata failure')
        self.assertEqual(original, self.snapshot(self.live))

    def test_rebuild_refreshes_tags_changed_in_json_during_the_scan(self):
        tag_file = self.root / 'synthetic-tags.json'
        tag_file.write_text(json.dumps({'image_tags': {
            'replacement/new.png': 'old-tag', 'replacement/removed.png': 'old-tag',
        }}), encoding='utf-8')
        latest = {'image_tags': {
            'replacement/new.png': 'changed-tag', 'replacement/added.png': 'new-tag',
        }}

        def edit_tags(_):
            tag_file.write_text(json.dumps(latest), encoding='utf-8')
            return 'synthetic reason'

        namespace = self.worker(edit_tags)
        for name in ['removed.png', 'added.png']:
            (self.root / 'images' / 'replacement' / name).write_bytes(b'synthetic image placeholder')
        namespace['load_gallery_image_tags_config'] = lambda: json.loads(tag_file.read_text(encoding='utf-8'))
        namespace['get_gallery_image_tag_for_path'] = lambda config, path: config.get('image_tags', {}).get(path, '')
        namespace['gallery_index_rebuild_worker']()

        self.assertFalse(namespace['GALLERY_INDEX_REBUILD_JOB']['error'])
        self.assertEqual(self.live.conn.execute(
            'SELECT rel_path, gallery_tag FROM gallery_images ORDER BY rel_path').fetchall(), [
                ('replacement/added.png', 'new-tag'), ('replacement/new.png', 'changed-tag'),
                ('replacement/removed.png', ''),
            ])
        self.assertEqual(json.loads(tag_file.read_text(encoding='utf-8')), latest)

    def test_rebuild_reuses_unchanged_catalog_rows_and_opens_only_changed_or_new_images(self):
        image_dir = self.root / 'images' / 'replacement'
        image_dir.mkdir(parents=True, exist_ok=True)
        stable_families = {
            'stable-v5.png': ('v5', 640, 480),
            'stable-v4_5.png': ('v4_5', 800, 600),
            'stable-other.png': ('other', 1024, 768),
        }
        for file_name, (family, width, height) in stable_families.items():
            path = image_dir / file_name
            path.write_bytes(b'synthetic image placeholder')
            os.utime(path, (1_700_000_000, 1_700_000_000))
            rel_path = f'replacement/{file_name}'
            self.add_image(self.live, rel_path, os.path.getmtime(path))
            with self.live.conn:
                self.live.conn.execute(
                    'UPDATE gallery_images SET model_family = ?, width = ?, height = ? WHERE rel_path = ?',
                    (family, width, height, rel_path))
        with self.live.conn:
            self.live.conn.execute(
                "UPDATE gallery_images SET model_family = NULL WHERE rel_path = 'replacement/stable-v5.png'")
            self.live.conn.execute(
                "DELETE FROM gallery_index_state WHERE key = 'legacy_gallery_model_default'")

        changed_path = image_dir / 'changed.png'
        changed_path.write_bytes(b'synthetic image placeholder')
        changed_mtime = os.path.getmtime(changed_path)
        self.add_image(self.live, 'replacement/changed.png', changed_mtime - 10)
        with self.live.conn:
            self.live.conn.execute(
                "UPDATE gallery_images SET model_family = 'v4_5' WHERE rel_path = 'replacement/changed.png'")
        self.add_image(self.live, 'replacement/removed.png', 1_700_000_000)

        extracted = []

        def extract(path):
            extracted.append(Path(path).name)
            return {'changed.png': 'other', 'new.png': 'v5'}[Path(path).name]

        namespace = self.worker(lambda _: 'synthetic reason', extract_model_family=extract)
        namespace['gallery_index_rebuild_worker']()

        self.assertFalse(namespace['GALLERY_INDEX_REBUILD_JOB']['error'])
        self.assertCountEqual(extracted, ['changed.png', 'new.png'])
        rows = {
            row[0]: row[1:]
            for row in self.live.conn.execute(
                'SELECT rel_path, model_family, width, height, reason FROM gallery_images')
        }
        for file_name, (family, width, height) in stable_families.items():
            self.assertEqual(rows[f'replacement/{file_name}'],
                             (family, width, height, 'synthetic reason'))
        self.assertEqual(rows['replacement/changed.png'],
                         ('other', None, None, 'synthetic reason'))
        self.assertEqual(rows['replacement/new.png'],
                         ('v5', None, None, 'synthetic reason'))
        self.assertNotIn('replacement/removed.png', rows)
        self.assertNotIn('previous/old.png', rows)

    def test_readers_see_old_or_complete_new_index_during_publication(self):
        staging = HistoryDB(self.root / 'staging.db')
        self.addCleanup(staging.close)
        staging.capture_gallery_index_baseline(self.live_path)
        self.add_image(staging, 'replacement/new.png', 17)
        staging.rebuild_gallery_folder_summaries()
        reader = sqlite3.connect(self.live_path)
        self.addCleanup(reader.close)
        entered, release = threading.Event(), threading.Event()
        failures = []
        def pause_publish():
            entered.set()
            if not release.wait(5):
                raise RuntimeError('test timed out waiting to publish')
            return 0
        self.live.conn.create_function('pause_publish', 0, pause_publish)
        self.live.conn.execute('''CREATE TEMP TRIGGER pause_gallery_publish
            BEFORE INSERT ON gallery_images BEGIN SELECT pause_publish(); END''')
        def publish():
            try:
                self.live.replace_gallery_index_from(staging)
            except Exception as error:
                failures.append(error)
        worker = threading.Thread(target=publish)
        worker.start()
        try:
            self.assertTrue(entered.wait(5), failures)
            reader.execute('BEGIN')
            self.assertEqual(reader.execute('SELECT rel_path FROM gallery_images').fetchall(), [('previous/old.png',)])
            self.assertEqual(reader.execute('SELECT thumb_path FROM gallery_folders').fetchall(), [('previous/old.png',)])
            self.assertEqual(reader.execute("SELECT value FROM gallery_index_state WHERE key = 'full_index_built'").fetchone(), ('1',))
        finally:
            release.set()
            worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(reader.execute('SELECT rel_path FROM gallery_images').fetchall(), [('previous/old.png',)])
        reader.rollback()
        self.assertEqual(reader.execute('SELECT rel_path FROM gallery_images').fetchall(), [('replacement/new.png',)])
        self.assertEqual(reader.execute('SELECT thumb_path FROM gallery_folders').fetchall(), [('replacement/new.png',)])

    def test_publish_failure_rolls_back_images_folders_and_state(self):
        staging = HistoryDB(self.root / 'staging.db')
        self.addCleanup(staging.close)
        staging.capture_gallery_index_baseline(self.live_path)
        self.add_image(staging, 'replacement/new.png', 17)
        staging.rebuild_gallery_folder_summaries()
        self.live.conn.execute('''CREATE TEMP TRIGGER fail_gallery_publish
            BEFORE INSERT ON gallery_folders BEGIN SELECT RAISE(ABORT, 'synthetic publish failure'); END''')
        original = self.snapshot(self.live)
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'synthetic publish failure'):
            self.live.replace_gallery_index_from(staging)
        self.assertEqual(original, self.snapshot(self.live))
        self.assertEqual([row[1] for row in self.live.conn.execute('PRAGMA database_list')], ['main', 'temp'])

    def test_publication_preserves_live_moves_additions_and_deletions(self):
        self.add_image(self.live, 'discarded/remove.png', 12)
        self.add_image(self.live, 'stable/keep.png', 13)
        self.live.rebuild_gallery_folder_summaries()
        staging = HistoryDB(self.root / 'staging.db')
        self.addCleanup(staging.close)
        staging.capture_gallery_index_baseline(self.live_path)
        for path in ['previous/old.png', 'discarded/remove.png', 'stable/keep.png']:
            self.add_image(staging, path, 22)
        staging.rebuild_gallery_folder_summaries()

        writer = HistoryDB(self.live_path)
        self.addCleanup(writer.close)
        writer.remove_gallery_image_record('previous/old.png')
        writer.remove_gallery_image_record('discarded/remove.png')
        self.add_image(writer, 'moved/new.png', 33)
        self.add_image(writer, 'added/new.png', 44)
        writer.rebuild_gallery_folder_summaries()
        preserved = self.snapshot(self.live, include_gallery=False)

        self.live.replace_gallery_index_from(staging)
        self.assertEqual(self.live.conn.execute(
            'SELECT rel_path, ctime FROM gallery_images ORDER BY rel_path').fetchall(), [
                ('added/new.png', 44), ('moved/new.png', 33), ('stable/keep.png', 22),
            ])
        self.assertEqual(self.live.conn.execute(
            'SELECT folder_path, total_images, thumb_path FROM gallery_folders ORDER BY folder_path').fetchall(), [
                ('added', 1, 'added/new.png'), ('moved', 1, 'moved/new.png'), ('stable', 1, 'stable/keep.png'),
            ])
        self.assertEqual(preserved, self.snapshot(self.live, include_gallery=False))

    def test_publication_preserves_live_tag_and_metadata_edits_without_new_updated_at(self):
        staging = HistoryDB(self.root / 'staging.db')
        self.addCleanup(staging.close)
        staging.capture_gallery_index_baseline(self.live_path)
        self.add_image(staging, 'previous/old.png', 22)
        staging.rebuild_gallery_folder_summaries()
        previous_timestamp = self.live.conn.execute('SELECT updated_at FROM gallery_images').fetchone()[0]
        writer = HistoryDB(self.live_path)
        self.addCleanup(writer.close)
        with writer.conn:
            writer.conn.execute("UPDATE gallery_images SET gallery_tag = 'changed-tag', ctime = 99")

        self.live.replace_gallery_index_from(staging)
        self.assertEqual(self.live.conn.execute(
            'SELECT gallery_tag, ctime, updated_at FROM gallery_images').fetchall(),
            [('changed-tag', 99, previous_timestamp)])


if __name__ == '__main__':
    unittest.main()
