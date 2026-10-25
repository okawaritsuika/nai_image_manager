import os
import unittest
from unittest import mock

from utils import select_gallery_prompt_index_paths


class GalleryPromptIndexIncrementalTests(unittest.TestCase):
    def setUp(self):
        self.root = "TOTAL_CLASSIFIED"
        self.paths = [
            "TOTAL_CLASSIFIED/1_Solo/unchanged.png",
            "TOTAL_CLASSIFIED/1_Solo/changed.png",
            "TOTAL_CLASSIFIED/2_Solo/new.png",
        ]

    def test_general_update_selects_only_changed_and_new_files(self):
        calls = []
        mtimes = {
            self.paths[0]: 10.0,
            self.paths[1]: 30.0,
        }

        def get_mtime(path):
            calls.append(path)
            return mtimes[path]

        selected = select_gallery_prompt_index_paths(
            self.paths,
            {
                "1_Solo/unchanged.png": 10.0,
                "1_Solo/changed.png": 20.0,
            },
            self.root,
            mtime_getter=get_mtime,
        )

        self.assertEqual(selected, [self.paths[1], self.paths[2]])
        self.assertEqual(calls, self.paths[:2])

    def test_missing_only_keeps_missing_semantics_and_does_not_stat_indexed_files(self):
        calls = []

        def get_mtime(path):
            calls.append(path)
            return 999.0

        selected = select_gallery_prompt_index_paths(
            self.paths,
            {
                "1_Solo/unchanged.png": 10.0,
                "1_Solo/changed.png": 20.0,
            },
            self.root,
            missing_only=True,
            mtime_getter=get_mtime,
        )

        self.assertEqual(selected, [self.paths[2]])
        self.assertEqual(calls, [])

    def test_mtime_error_is_reprocessed(self):
        path = self.paths[0]

        def get_mtime(_path):
            raise OSError("file disappeared")

        selected = select_gallery_prompt_index_paths(
            [path],
            {"1_Solo/unchanged.png": 10.0},
            self.root,
            mtime_getter=get_mtime,
        )

        self.assertEqual(selected, [path])

    def test_worker_process_subset_but_profiles_full_scan_scope(self):
        from tests.test_model_family_backend import GalleryModelFamilyMigrationTests
        app = GalleryModelFamilyMigrationTests._load_app_without_flask()
        paths = [os.path.join(app.CLASSIFIED_DIR, '1_Solo', name)
                 for name in ('unchanged.png', 'changed.png', 'new.png')]
        database = mock.MagicMock()
        database.get_gallery_prompt_index_status.return_value = {'text_bytes': 0}
        database.upsert_gallery_prompt_index_profile.return_value = {'id': 'sample'}
        with mock.patch.object(app, 'iter_gallery_prompt_index_files', return_value=paths), \
             mock.patch.object(app, 'filter_gallery_prompt_index_files', return_value=paths[1:]), \
             mock.patch.object(app.utils, 'HistoryDB', return_value=database), \
             mock.patch.object(app, 'build_gallery_prompt_index_record', side_effect=lambda path: {'path': path}) as build:
            app.gallery_prompt_index_worker()
        self.assertFalse(app.GALLERY_PROMPT_INDEX_JOB['error'])
        self.assertCountEqual([call.args[0] for call in build.call_args_list], paths[1:])
        self.assertEqual(database.upsert_gallery_prompt_index_profile.call_args.kwargs['rel_paths'],
                         ['1_Solo/unchanged.png', '1_Solo/changed.png', '1_Solo/new.png'])
        database.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
