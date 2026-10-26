"""Synthetic-storage tests for full-project removal staging contexts."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from naim.daki_drafts import DakiDrafts
from naim.daki_style_tests import DakiStyleTestConflict
from naim.storage import daki_projects
from naim.storage.daki_projects import DakiNotFoundError, DakiProjectsStore


PROJECT_ID = 'a' * 32
OTHER_PROJECT_ID = 'b' * 32
FOLDER_ID = 'c' * 32
SECOND_FOLDER_ID = 'd' * 32
OTHER_FOLDER_ID = 'e' * 32
COMPLETED_ID = '1' * 32
FAILED_ID = '2' * 32
OTHER_ID = '3' * 32


class ProjectRemovalStorageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.project_path = self.root / 'daki_projects.json'
        self.drafts_root = self.root / 'drafts'
        self.project_store = DakiProjectsStore(lambda: self.project_path)
        self.drafts = DakiDrafts(self.drafts_root, lambda: 'synthetic-key')
        self.addCleanup(self.drafts.wait)

    def write_projects(self, projects):
        payload = {
            'enabled': False,
            'unknown_root_field': {'preserve': [1, 'synthetic']},
            'projects': projects,
        }
        self.project_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
        return payload

    def project(self, project_id, name):
        return {
            'id': project_id,
            'name': name,
            'created_at': 'synthetic-created',
            'updated_at': 'synthetic-updated',
            'candidates': {'front': [], 'back': []},
            'unknown_project_field': {'preserve': project_id},
        }

    def write_catalog(self, folders):
        self.drafts_root.mkdir(parents=True, exist_ok=True)
        payload = {
            'unknown_catalog_field': {'preserve': True},
            'folders': folders,
        }
        path = self.drafts_root / 'folders.json'
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
        return path, payload

    def folder(self, folder_id, project_id):
        return {
            'id': folder_id,
            'name': 'Synthetic folder',
            'project_id': project_id,
            'unknown_folder_field': {'preserve': folder_id},
        }

    def write_draft(self, draft_id, folder_id, *, status='completed', purpose='draft', selected=False,
                    include_image=True):
        directory = self.drafts_root / draft_id
        directory.mkdir(parents=True)
        record = {
            'id': draft_id,
            'settings': {'width': 8, 'height': 16},
            'status': status,
            'selected': selected,
            'purpose': purpose,
            'unknown_record_field': {'preserve': draft_id},
        }
        if folder_id is not None:
            record['folder_id'] = folder_id
        (directory / 'draft.json').write_text(
            json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
        if include_image:
            (directory / 'image.png').write_bytes(f'image:{draft_id}'.encode('ascii'))
        return record

    def test_project_context_removes_only_target_and_yields_independent_record(self):
        target = self.project(PROJECT_ID, 'Target')
        target['unknown_canvas_state'] = {'nested': [1, 2, {'keep': True}]}
        other = self.project(OTHER_PROJECT_ID, 'Other')
        original = self.write_projects([target, other])

        with self.project_store.staged_project_removal(PROJECT_ID) as removed:
            self.assertEqual(removed, target)
            removed['unknown_canvas_state']['nested'][2]['keep'] = False
            saved = json.loads(self.project_path.read_text(encoding='utf-8'))
            self.assertEqual(saved['projects'], [other])
            self.assertEqual(saved['enabled'], original['enabled'])
            self.assertEqual(saved['unknown_root_field'], original['unknown_root_field'])

        saved = json.loads(self.project_path.read_text(encoding='utf-8'))
        self.assertEqual(saved['projects'], [other])

    def test_project_context_restores_original_data_when_caller_fails(self):
        target = self.project(PROJECT_ID, 'Target')
        other = self.project(OTHER_PROJECT_ID, 'Other')
        original = self.write_projects([target, other])

        with self.assertRaisesRegex(RuntimeError, 'synthetic caller failure'):
            with self.project_store.staged_project_removal(PROJECT_ID):
                self.assertEqual(self.project_store.list_projects(), [other])
                raise RuntimeError('synthetic caller failure')

        self.assertEqual(json.loads(self.project_path.read_text(encoding='utf-8')), original)

    def test_project_context_reports_missing_project(self):
        self.write_projects([self.project(OTHER_PROJECT_ID, 'Other')])
        with self.assertRaises(DakiNotFoundError):
            with self.project_store.staged_project_removal(PROJECT_ID):
                self.fail('missing projects must not yield')

    def test_project_context_keeps_original_backup_if_rollback_write_fails(self):
        original = self.write_projects([self.project(PROJECT_ID, 'Target')])
        original_bytes = self.project_path.read_bytes()
        real_write_json = daki_projects.write_json
        calls = 0

        def fail_rollback(path, data, *, indent=4):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError('synthetic rollback failure')
            return real_write_json(path, data, indent=indent)

        with mock.patch('naim.storage.daki_projects.write_json', side_effect=fail_rollback):
            with self.assertRaisesRegex(OSError, '복구하지 못했습니다'):
                with self.project_store.staged_project_removal(PROJECT_ID):
                    raise RuntimeError('synthetic caller failure')

        backups = list(self.root.glob('.daki_projects.json.project-removal-*.bak'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), original_bytes)
        self.assertEqual(json.loads(backups[0].read_text(encoding='utf-8')), original)

    def test_draft_context_stages_all_project_folders_including_unselected_and_failed(self):
        catalog_path, original_catalog = self.write_catalog([
            self.folder(FOLDER_ID, PROJECT_ID),
            self.folder(SECOND_FOLDER_ID, PROJECT_ID),
            self.folder(OTHER_FOLDER_ID, OTHER_PROJECT_ID),
        ])
        self.write_draft(COMPLETED_ID, FOLDER_ID, selected=True)
        failed = self.write_draft(FAILED_ID, SECOND_FOLDER_ID, status='failed', include_image=False)
        unrelated = self.write_draft(OTHER_ID, OTHER_FOLDER_ID)
        original_unrelated = (self.drafts_root / OTHER_ID / 'draft.json').read_bytes()

        with self.drafts.staged_project_removal(PROJECT_ID) as staged:
            self.assertEqual([item['id'] for item in staged], [COMPLETED_ID, FAILED_ID])
            self.assertEqual(staged[0]['reference'], f'__daki_drafts__/{COMPLETED_ID}.png')
            self.assertEqual(staged[0]['directory'].name, COMPLETED_ID)
            self.assertTrue(staged[0]['directory'].parent.name.startswith('.delete-project-'))
            self.assertEqual(staged[0]['directory'].parent.parent, self.drafts_root)
            self.assertEqual(staged[0]['record']['selected'], True)
            self.assertEqual(staged[1]['record'], failed)
            self.assertTrue((staged[0]['directory'] / 'image.png').is_file())
            self.assertFalse((staged[1]['directory'] / 'image.png').exists())
            self.assertFalse((self.drafts_root / COMPLETED_ID).exists())
            saved_catalog = json.loads(catalog_path.read_text(encoding='utf-8'))
            self.assertEqual(saved_catalog['unknown_catalog_field'], original_catalog['unknown_catalog_field'])
            self.assertEqual(saved_catalog['folders'], [original_catalog['folders'][2]])

        self.assertFalse((self.drafts_root / COMPLETED_ID).exists())
        self.assertFalse((self.drafts_root / FAILED_ID).exists())
        self.assertEqual((self.drafts_root / OTHER_ID / 'draft.json').read_bytes(), original_unrelated)
        self.assertEqual(unrelated['unknown_record_field'], {'preserve': OTHER_ID})
        remaining = json.loads(catalog_path.read_text(encoding='utf-8'))
        self.assertEqual(remaining['folders'], [original_catalog['folders'][2]])
        self.assertFalse(any(path.name.startswith('.delete-project-') for path in self.drafts_root.iterdir()))

    def test_draft_context_rolls_catalog_and_files_back_when_caller_fails(self):
        catalog_path, original_catalog = self.write_catalog([self.folder(FOLDER_ID, PROJECT_ID)])
        original_catalog_bytes = catalog_path.read_bytes()
        self.write_draft(COMPLETED_ID, FOLDER_ID)
        original_files = {
            path.name: path.read_bytes()
            for path in (self.drafts_root / COMPLETED_ID).iterdir()
        }

        with self.assertRaisesRegex(RuntimeError, 'synthetic archive failure'):
            with self.drafts.staged_project_removal(PROJECT_ID) as staged:
                self.assertEqual(len(staged), 1)
                raise RuntimeError('synthetic archive failure')

        self.assertEqual(catalog_path.read_bytes(), original_catalog_bytes)
        self.assertEqual(json.loads(catalog_path.read_text(encoding='utf-8')), original_catalog)
        restored = self.drafts_root / COMPLETED_ID
        self.assertEqual({path.name: path.read_bytes() for path in restored.iterdir()}, original_files)
        self.assertFalse(any(path.name.startswith('.delete-project-') for path in self.drafts_root.iterdir()))

    def test_catalog_save_failure_restores_already_moved_directories(self):
        catalog_path, _ = self.write_catalog([self.folder(FOLDER_ID, PROJECT_ID)])
        original_catalog = catalog_path.read_bytes()
        self.write_draft(COMPLETED_ID, FOLDER_ID)
        original_files = {
            path.name: path.read_bytes()
            for path in (self.drafts_root / COMPLETED_ID).iterdir()
        }

        with mock.patch.object(self.drafts, '_save_catalog', side_effect=OSError('synthetic catalog failure')):
            with self.assertRaisesRegex(OSError, 'synthetic catalog failure'):
                with self.drafts.staged_project_removal(PROJECT_ID):
                    self.fail('failed catalog save must not yield')

        self.assertEqual(catalog_path.read_bytes(), original_catalog)
        self.assertEqual(
            {path.name: path.read_bytes() for path in (self.drafts_root / COMPLETED_ID).iterdir()},
            original_files,
        )
        self.assertFalse(any(path.name.startswith('.delete-project-') for path in self.drafts_root.iterdir()))

    def test_mid_move_failure_restores_directories_already_staged(self):
        catalog_path, _ = self.write_catalog([self.folder(FOLDER_ID, PROJECT_ID)])
        original_catalog = catalog_path.read_bytes()
        self.write_draft(COMPLETED_ID, FOLDER_ID)
        self.write_draft(FAILED_ID, FOLDER_ID, status='failed')
        target_ids = sorted((COMPLETED_ID, FAILED_ID))
        original_files = {
            draft_id: {path.name: path.read_bytes() for path in (self.drafts_root / draft_id).iterdir()}
            for draft_id in target_ids
        }
        real_replace = os.replace
        failed = False

        def fail_second_move(source, destination):
            nonlocal failed
            if Path(source) == self.drafts_root / target_ids[1] and not failed:
                failed = True
                raise OSError('synthetic move failure')
            return real_replace(source, destination)

        with mock.patch('naim.daki_drafts.os.replace', side_effect=fail_second_move):
            with self.assertRaisesRegex(OSError, 'synthetic move failure'):
                with self.drafts.staged_project_removal(PROJECT_ID):
                    self.fail('failed move must not yield')

        self.assertTrue(failed)
        self.assertEqual(catalog_path.read_bytes(), original_catalog)
        for draft_id in target_ids:
            self.assertEqual(
                {path.name: path.read_bytes() for path in (self.drafts_root / draft_id).iterdir()},
                original_files[draft_id],
            )
        self.assertFalse(any(path.name.startswith('.delete-project-') for path in self.drafts_root.iterdir()))

    def test_running_or_active_owned_draft_blocks_without_mutation(self):
        catalog_path, _ = self.write_catalog([self.folder(FOLDER_ID, PROJECT_ID)])
        original_catalog = catalog_path.read_bytes()
        record = self.write_draft(COMPLETED_ID, FOLDER_ID, status='running')
        directory = self.drafts_root / COMPLETED_ID
        original_files = {path.name: path.read_bytes() for path in directory.iterdir()}
        with self.assertRaises(DakiStyleTestConflict):
            with self.drafts.staged_project_removal(PROJECT_ID):
                self.fail('running draft must not be staged')
        self.assertEqual(catalog_path.read_bytes(), original_catalog)
        self.assertEqual({path.name: path.read_bytes() for path in directory.iterdir()}, original_files)

        record['status'] = 'completed'
        (directory / 'draft.json').write_text(json.dumps(record), encoding='utf-8')
        active_files = {path.name: path.read_bytes() for path in directory.iterdir()}
        self.drafts._active = (self.drafts_root.resolve(), COMPLETED_ID)
        try:
            with self.assertRaises(DakiStyleTestConflict):
                with self.drafts.staged_project_removal(PROJECT_ID):
                    self.fail('active draft must not be staged')
        finally:
            self.drafts._active = None
        self.assertEqual(catalog_path.read_bytes(), original_catalog)
        self.assertEqual({path.name: path.read_bytes() for path in directory.iterdir()}, active_files)

    def test_empty_or_unlinked_draft_folder_behavior(self):
        catalog_path, _ = self.write_catalog([self.folder(FOLDER_ID, PROJECT_ID)])
        with self.drafts.staged_project_removal(PROJECT_ID) as staged:
            self.assertEqual(staged, [])
            self.assertEqual(json.loads(catalog_path.read_text(encoding='utf-8'))['folders'], [])

        catalog_path.write_text(json.dumps({'folders': [self.folder(OTHER_FOLDER_ID, OTHER_PROJECT_ID)]}),
                                encoding='utf-8')
        original_bytes = catalog_path.read_bytes()
        with self.drafts.staged_project_removal(PROJECT_ID) as staged:
            self.assertEqual(staged, [])
        self.assertEqual(catalog_path.read_bytes(), original_bytes)

    def test_owned_nonordinary_entries_and_symlinks_are_rejected_before_mutation(self):
        catalog_path, _ = self.write_catalog([self.folder(FOLDER_ID, PROJECT_ID)])
        original_catalog = catalog_path.read_bytes()
        self.write_draft(COMPLETED_ID, FOLDER_ID)
        directory = self.drafts_root / COMPLETED_ID
        nested = directory / 'nested'
        nested.mkdir()
        with self.assertRaises(ValueError):
            with self.drafts.staged_project_removal(PROJECT_ID):
                self.fail('nested directory must be rejected')
        self.assertEqual(catalog_path.read_bytes(), original_catalog)
        self.assertTrue(directory.is_dir())

        nested.rmdir()
        outside = self.root / 'outside.txt'
        outside.write_text('synthetic outside', encoding='utf-8')
        link = directory / 'linked.txt'
        try:
            link.symlink_to(outside)
        except (OSError, NotImplementedError):
            return
        with self.assertRaises(ValueError):
            with self.drafts.staged_project_removal(PROJECT_ID):
                self.fail('symlink must be rejected')
        self.assertEqual(catalog_path.read_bytes(), original_catalog)
        self.assertEqual(outside.read_text(encoding='utf-8'), 'synthetic outside')

    def test_tag_example_associated_with_owned_folder_is_rejected(self):
        catalog_path, _ = self.write_catalog([self.folder(FOLDER_ID, PROJECT_ID)])
        original_catalog = catalog_path.read_bytes()
        self.write_draft(COMPLETED_ID, FOLDER_ID, purpose='tag_example')
        with self.assertRaisesRegex(ValueError, '다른 종류의 시안'):
            with self.drafts.staged_project_removal(PROJECT_ID):
                self.fail('tag example must not be staged as a draft')
        self.assertEqual(catalog_path.read_bytes(), original_catalog)
        self.assertTrue((self.drafts_root / COMPLETED_ID).is_dir())


if __name__ == '__main__':
    unittest.main()
