import ast
import os
from pathlib import Path
import random
import threading
import types
import unittest
from unittest import mock

from naim.storage.history import HistoryDB


class GalleryFolderSummaryTests(unittest.TestCase):
    def setUp(self):
        # Only in-memory databases are used; never open the installed tag DB.
        synthetic_root = Path(__file__).parent / '.synthetic-no-user-data'
        self.assertFalse(synthetic_root.exists())
        patch = mock.patch('naim.storage.history.get_app_dir', return_value=str(synthetic_root))
        patch.start()
        self.addCleanup(patch.stop)
        self.db = HistoryDB(':memory:')
        self.addCleanup(self.db.close)

    def add(self, path, mtime=10, mode='general', folder=None):
        self.db.upsert_gallery_image_records([{
            'rel_path': path,
            'folder_path': folder if folder is not None else os.path.dirname(path),
            'file_name': os.path.basename(path),
            'mode': mode,
            'mtime': mtime,
            'ctime': mtime,
            'width': 8,
            'height': 8,
            'model_family': 'other',
        }])

    def summaries(self):
        return self.db.conn.execute('''
            SELECT folder_path, parent_path, folder_name, mode,
                   total_images, direct_images, thumb_path
            FROM gallery_folders ORDER BY folder_path
        ''').fetchall()

    def assert_matches_rebuild(self, folders):
        self.db.refresh_gallery_folder_summaries(folders)
        incremental = self.summaries()
        self.db.rebuild_gallery_folder_summaries()
        self.assertEqual(incremental, self.summaries())

    def test_add_nested_folder_preserves_unaffected_rows(self):
        self.add('library/a/old.png')
        self.add('other/unchanged.png', 20)
        self.db.rebuild_gallery_folder_summaries()
        unchanged = self.db.conn.execute(
            "SELECT * FROM gallery_folders WHERE folder_path = 'other'"
        ).fetchone()
        self.add('library/a/new/added.png', 30)
        self.db.refresh_gallery_folder_summaries(['library/a/new'])
        self.assertEqual(unchanged, self.db.conn.execute(
            "SELECT * FROM gallery_folders WHERE folder_path = 'other'"
        ).fetchone())
        incremental = self.summaries()
        self.db.rebuild_gallery_folder_summaries()
        self.assertEqual(incremental, self.summaries())

    def test_thumbnail_priority_ties_and_replacement(self):
        self.add('library/child/000_MAIN_child.png', 1)
        self.add('library/newer.png', 100)
        self.add('library/000_MAIN_first.png', 1)
        self.db.rebuild_gallery_folder_summaries()
        self.add('library/000_MAIN_newest.png', 2)
        self.assert_matches_rebuild(['library'])
        self.db.remove_gallery_image_record('library/000_MAIN_newest.png')
        self.assert_matches_rebuild(['library'])
        self.db.remove_gallery_image_record('library/child/000_MAIN_child.png')
        self.assert_matches_rebuild(['library/child'])
        # REPLACE assigns a new rowid, so the existing equal-score item wins.
        self.add('library/000_MAIN_second.png', 1)
        self.add('library/000_MAIN_first.png', 1)
        self.assert_matches_rebuild(['library'])

    def test_move_last_image_prunes_old_ancestors_and_rebuilds_new_ones(self):
        self.add('old/nested/last.png')
        self.add('new/existing.png', 20)
        self.db.rebuild_gallery_folder_summaries()
        self.db.remove_gallery_image_record('old/nested/last.png')
        self.add('new/child/moved.png', 30)
        self.assert_matches_rebuild(['old/nested', 'new/child'])
        self.assertFalse(any(row[0].startswith('old') for row in self.summaries()))

    def test_modes_follow_first_image_even_across_mixed_children(self):
        self.add('mixed/a/first.png', 10, 'r18')
        self.add('mixed/b/second.png', 20, 'general')
        self.add('mixed/direct.png', 30, 'trash')
        self.db.rebuild_gallery_folder_summaries()
        self.db.remove_gallery_image_record('mixed/a/first.png')
        self.assert_matches_rebuild(['mixed/a'])
        self.add('mixed/b/second.png', 20, 'r18')
        self.assert_matches_rebuild(['mixed/b'])

    def test_literal_folder_names_do_not_match_sql_wildcards(self):
        self.add('a_%/child/first.png', 10, 'r18')
        self.add('a_%/direct.png', 20)
        self.add('aXX/unrelated.png', 1, 'trash')
        self.db.rebuild_gallery_folder_summaries()
        self.add('a_%/child/new.png', 30)
        self.assert_matches_rebuild(['a_%/child'])

    def test_upscaled_display_folder_root_images_and_empty_updates(self):
        self.add('library/a/normal.png')
        self.db.rebuild_gallery_folder_summaries()
        self.add('library/a/_upscaled/large.png', 20, folder='library/a')
        self.assert_matches_rebuild(['library/a'])
        self.add('root.png', 30)
        self.assert_matches_rebuild([''])
        self.assert_matches_rebuild([])

    def test_random_changes_match_full_rebuild(self):
        generator = random.Random(42)
        locations = ['a', 'a/nested', 'a/nested/deep', 'b/child', 'c_%/leaf']
        current = {}
        for index in range(60):
            folder = generator.choice(locations)
            path = f'{folder}/{"000_MAIN_" if index % 5 == 0 else ""}{index}.png'
            current[path] = folder
            self.add(path, generator.randrange(4), generator.choice(['general', 'r18']))
        self.db.rebuild_gallery_folder_summaries()
        for step in range(30):
            path = generator.choice(list(current))
            old_folder = current.pop(path)
            self.db.remove_gallery_image_record(path)
            folder = generator.choice(locations)
            new_path = f'{folder}/{"000_MAIN_" if step % 3 == 0 else ""}new_{step}.png'
            current[new_path] = folder
            self.add(new_path, generator.randrange(4), generator.choice(['general', 'r18']))
            self.assert_matches_rebuild([old_folder, folder])

    def test_refresh_captures_overridden_old_folders_before_deleting_rows(self):
        self.add('source/old.png', folder='display/old')
        self.add('source/stale.png', folder='display/stale')
        self.add('source/new.png', folder='display/previous')
        self.add('untouched/keep.png')
        self.db.rebuild_gallery_folder_summaries()
        self.db.set_gallery_index_state('full_index_built', '1')
        source = Path(__file__).resolve().parents[1] / 'app.py'
        function = next(node for node in ast.parse(source.read_text(encoding='utf-8-sig')).body
                        if isinstance(node, ast.FunctionDef)
                        and node.name == 'refresh_gallery_index_for_file_change')
        namespace = {
            'os': os,
            'utils': types.SimpleNamespace(HistoryDB=lambda: self.db),
            'CLASSIFIED_DIR': str(source.parent),
            'GALLERY_INDEX_DB_LOCK': threading.Lock(),
            'clean_gallery_rel_path': self.db.normalize_gallery_rel_path,
            'get_existing_gallery_rel_path': lambda _: 'source/new.png',
            'load_gallery_image_tags_config': lambda: {},
            'get_gallery_image_tag_for_path': lambda *args: '',
        }
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), namespace)
        with mock.patch.object(self.db, 'close'), \
             mock.patch.object(self.db, 'rebuild_gallery_folder_summaries',
                               side_effect=AssertionError('full rebuild called')):
            result = namespace[function.name](
                'source/new.png', rel_path='source/stale.png', old_rel_path='source/old.png',
                allow_rebuild=False, folder_path='display/new', width=8, height=8,
                mtime=20, ctime=20, model_family='other',
            )
        self.assertTrue(result['index_updated'], result)
        incremental = self.summaries()
        self.db.rebuild_gallery_folder_summaries()
        self.assertEqual(incremental, self.summaries())


if __name__ == '__main__':
    unittest.main()
