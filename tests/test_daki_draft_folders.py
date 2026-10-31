"""Synthetic-storage tests for standalone Daki draft folders."""
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
import unittest
from unittest import mock

from flask import Flask
from PIL import Image

from naim.daki_drafts import DakiDraftReferencesConflict, DakiDrafts
from naim.daki_style_tests import DakiStyleTestConflict
from naim.web.daki_drafts import register_daki_draft_routes


def synthetic_settings(**changes):
    return {'prompt': 'synthetic blue shape', 'negative_prompt': 'synthetic blur',
            'model': 'nai-diffusion-5-full', 'width': 128, 'height': 192,
            'seed': 123, 'char_prompts': [], **changes}


def synthetic_image(_key, payload):
    width = payload['parameters']['width']
    height = payload['parameters']['height']
    return Image.new('RGBA', (width, height), (40, 80, 120, 255))


class DraftFolderStorageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / 'drafts'
        self.excluded = set()
        self.references = mock.Mock(return_value=[])
        self.generator = mock.Mock(side_effect=synthetic_image)
        self.manager = DakiDrafts(
            self.root, lambda: 'synthetic-key', self.generator,
            excluded_draft_ids_provider=lambda: self.excluded,
            references_provider=self.references)
        self.addCleanup(self.manager.wait)

    def make_folder(self, **data):
        return self.manager.create_folder({'name': 'Synthetic folder', **data})

    def test_dictionary_reference_is_saved_and_reopened_with_first_character(self):
        reference = {'image_id': 42, 'tag': 'synthetic_pose'}
        settings = {'dictionary_reference': reference, 'char_prompts': [{'prompt': 'synthetic_pose'}]}
        folder = self.make_folder(settings=settings)
        reopened = DakiDrafts(self.root, lambda: 'synthetic-key', self.generator)
        saved = reopened.get_folder(folder['id'])['folder']
        self.assertEqual(saved['settings']['dictionary_reference'], reference)
        self.assertEqual(saved['settings']['char_prompts'][0]['prompt'], 'synthetic_pose')

    def make_draft(self, folder_id=None, purpose='draft', **settings):
        data = synthetic_settings(**settings)
        data['purpose'] = purpose
        if folder_id is not None:
            data['folder_id'] = folder_id
        draft = self.manager.create(data)
        self.assertTrue(self.manager.wait())
        return self.manager.get(draft['id'])

    def test_unnamed_folders_use_persisted_project_numbers_and_preserve_custom_names(self):
        project = 'a' * 32
        for expected, supplied in [('시안1', {}), ('시안2', {'name': ''}), ('시안3', {'name': '  '})]:
            folder = self.manager.create_folder({'project_id': project, **supplied})
            self.assertEqual(folder['name'], expected)
        custom = self.make_folder(name='  Named study  ', project_id=project)
        self.assertEqual(custom['name'], 'Named study')
        self.make_folder(name='시안7', project_id=project)
        reopened = DakiDrafts(self.root, lambda: 'synthetic-key', self.generator)
        self.assertEqual(reopened.create_folder({'project_id': project})['name'], '시안8')
        self.assertEqual(reopened.create_folder({'project_id': 'b' * 32})['name'], '시안1')
        self.generator.assert_not_called()

    def test_default_names_do_not_accept_invalid_names_or_change_rename_validation(self):
        for name in [None, 1, False, [], 'x' * 121]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.manager.create_folder({'name': name})
        folder = self.manager.create_folder({})
        with self.assertRaises(ValueError):
            self.manager.update_folder(folder['id'], {'name': ''})
        self.assertEqual(self.manager.get_folder(folder['id'])['folder']['name'], '시안1')

    def test_empty_reads_do_not_write_and_edits_preserve_unknown_catalog_fields(self):
        self.assertEqual(self.manager.list_folders(), [])
        self.assertFalse(self.root.exists())
        folder = self.make_folder(settings=synthetic_settings(prompt='folder recipe'))
        self.generator.assert_not_called()

        catalog_path = self.root / 'folders.json'
        catalog = json.loads(catalog_path.read_text(encoding='utf-8'))
        catalog['unknown_catalog_key'] = {'preserved': True}
        catalog['folders'][0]['unknown_folder_key'] = ['preserved']
        catalog_path.write_text(json.dumps(catalog), encoding='utf-8')
        result = self.manager.update_folder(folder['id'], {'name': 'Renamed folder'})

        stored = json.loads(catalog_path.read_text(encoding='utf-8'))
        self.assertEqual(stored['unknown_catalog_key'], {'preserved': True})
        self.assertEqual(stored['folders'][0]['unknown_folder_key'], ['preserved'])
        self.assertEqual(result['folder']['name'], 'Renamed folder')
        self.assertEqual(result['folder']['settings']['prompt'], 'folder recipe')
        self.assertEqual(result['folder']['count'], 0)
        self.assertIsNone(result['folder']['src'])

    def test_folder_listing_filters_projects_and_hides_tag_examples_and_excluded_ids(self):
        project_folder = self.make_folder(name='Project', project_id='a' * 32)
        loose_folder = self.make_folder(name='Loose')
        attached = self.make_draft(folder_id=project_folder['id'], prompt='attached')
        legacy = self.make_draft(prompt='legacy')
        tagged = self.make_draft(purpose='tag_example', prompt='tag example')
        self.assertEqual(self.manager.get_folder(project_folder['id'])['drafts'][0]['id'], attached['id'])
        self.assertEqual([folder['id'] for folder in self.manager.list_folders('a' * 32)],
                         [project_folder['id']])
        unassigned_ids = {folder['id'] for folder in self.manager.list_folders('')}
        self.assertEqual(unassigned_ids, {loose_folder['id'], 'legacy'})
        self.assertEqual(self.manager.get_folder('legacy')['drafts'][0]['id'], legacy['id'])
        self.assertNotIn(tagged['id'], [draft['id'] for folder in self.manager.list_folders()
                                        for draft in self.manager.get_folder(folder['id'])['drafts']])

        self.excluded.add(legacy['id'])
        self.assertNotIn('legacy', {folder['id'] for folder in self.manager.list_folders()})
        self.assertEqual(self.manager.list_drafts()[0]['id'], tagged['id'])

    def test_folder_generation_persists_latest_recipe_only_after_acceptance(self):
        folder = self.make_folder(settings=synthetic_settings(prompt='saved recipe'))
        with self.assertRaises(ValueError):
            self.manager.create({**synthetic_settings(), 'purpose': 'tag_example',
                                 'folder_id': folder['id']})
        rejected = synthetic_settings(prompt='costly recipe', options={'steps': 29})
        rejected['folder_id'] = folder['id']
        with self.assertRaises(ValueError):
            self.manager.create(rejected)
        self.assertEqual(self.manager.get_folder(folder['id'])['folder']['settings']['prompt'], 'saved recipe')
        self.generator.assert_not_called()

        created = self.make_draft(folder_id=folder['id'], prompt='latest accepted recipe')
        saved = self.manager.get_folder(folder['id'])
        self.assertEqual(saved['folder']['settings']['prompt'], 'latest accepted recipe')
        self.assertEqual(saved['drafts'][0]['folder_id'], folder['id'])
        sent_payload = self.generator.call_args.args[1]
        serialized = json.dumps(sent_payload)
        for metadata_key in ('purpose', 'folder_id', 'selected'):
            self.assertNotIn(metadata_key, serialized)

        missing_folder = synthetic_settings()
        missing_folder['folder_id'] = 'f' * 32
        calls = self.generator.call_count
        with self.assertRaises(FileNotFoundError):
            self.manager.create(missing_folder)
        self.assertEqual(self.generator.call_count, calls)
        self.assertEqual(self.manager.get(created['id'])['purpose'], 'draft')

    def test_old_manifests_remain_readable_without_rewrite_and_tag_examples_stay_separate(self):
        ordinary = self.make_draft(prompt='old manifest')
        manifest = self.root / ordinary['id'] / 'draft.json'
        raw = json.loads(manifest.read_text(encoding='utf-8'))
        for field in ('purpose', 'selected', 'folder_id'):
            raw.pop(field, None)
        manifest.write_text(json.dumps(raw), encoding='utf-8')
        before = manifest.read_bytes()

        failed_generator = mock.Mock(side_effect=ValueError('synthetic failure'))
        failed_manager = DakiDrafts(self.root, lambda: 'synthetic-key', failed_generator)
        self.addCleanup(failed_manager.wait)
        tagged = failed_manager.create({**synthetic_settings(), 'purpose': 'tag_example'})
        self.assertTrue(failed_manager.wait())
        self.assertEqual(failed_manager.get(tagged['id'])['status'], 'failed')

        reopened = DakiDrafts(self.root, mock.Mock(), mock.Mock())
        self.addCleanup(reopened.wait)
        self.assertEqual(reopened.get(ordinary['id'])['purpose'], 'draft')
        self.assertFalse(reopened.get(ordinary['id'])['selected'])
        self.assertEqual([draft['id'] for draft in reopened.get_folder('legacy')['drafts']], [ordinary['id']])
        self.assertNotIn(tagged['id'], [draft['id'] for draft in reopened.get_folder('legacy')['drafts']])
        self.assertEqual(manifest.read_bytes(), before)

    def test_legacy_generation_stays_unassigned_and_does_not_persist_folder_settings(self):
        existing = self.make_draft(prompt='legacy starting recipe')
        created = self.make_draft(folder_id='legacy', prompt='legacy new recipe')
        self.assertNotIn('folder_id', created)
        self.assertEqual(created['settings']['prompt'], 'legacy new recipe')
        self.assertEqual([row['id'] for row in self.manager.get_folder('legacy')['drafts']],
                         [created['id'], existing['id']])
        self.assertFalse((self.root / 'folders.json').exists())
        self.assertEqual(self.manager.get_folder('legacy')['folder']['settings']['prompt'],
                         'legacy new recipe')

    def test_retry_and_frame_preserve_provenance_and_frame_is_unselected(self):
        folder = self.make_folder()
        self.generator.side_effect = [ValueError('synthetic failure'), Image.new('RGBA', (128, 192), (40, 80, 120, 255))]
        failed = self.make_draft(folder_id=folder['id'], prompt='retry recipe')
        self.assertEqual(failed['status'], 'failed')
        retried = self.manager.retry(failed['id'])
        self.assertTrue(self.manager.wait())
        retried = self.manager.get(retried['id'])
        self.assertEqual(retried['purpose'], 'draft')
        self.assertEqual(retried['folder_id'], folder['id'])
        self.assertEqual(retried['settings']['prompt'], 'retry recipe')

        self.manager.set_selected(retried['id'], True)
        framed = self.manager.frame(retried['id'], {'width': 128, 'height': 192, 'mode': 'pad'})
        self.assertEqual(framed['purpose'], 'draft')
        self.assertEqual(framed['folder_id'], folder['id'])
        self.assertFalse(framed['selected'])
        detail = self.manager.get_folder(folder['id'])
        self.assertEqual(detail['folder']['count'], 2)
        self.assertEqual(detail['folder']['selected_count'], 1)

    def test_selection_is_completed_only_persistent_and_strictly_boolean(self):
        entered, release = threading.Event(), threading.Event()

        def blocked(_key, payload):
            entered.set()
            release.wait(5)
            return synthetic_image(_key, payload)

        self.generator.side_effect = blocked
        running = self.manager.create(synthetic_settings())
        self.assertTrue(entered.wait(2))
        with self.assertRaises(DakiStyleTestConflict):
            self.manager.set_selected(running['id'], True)
        release.set()
        self.assertTrue(self.manager.wait())

        selected = self.manager.set_selected(running['id'], True)
        self.assertTrue(selected['selected'])
        reopened = DakiDrafts(self.root, mock.Mock(), mock.Mock())
        self.addCleanup(reopened.wait)
        self.assertTrue(reopened.get(running['id'])['selected'])
        for invalid in (1, 0, 'true', None):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                reopened.set_selected(running['id'], invalid)

    def test_delete_preflights_scope_references_selection_and_partial_failures(self):
        folder = self.make_folder()
        other_folder = self.make_folder(name='Other')
        first = self.make_draft(folder_id=folder['id'], prompt='first')
        selected = self.make_draft(folder_id=folder['id'], prompt='selected')
        other = self.make_draft(folder_id=other_folder['id'], prompt='other')
        self.manager.set_selected(selected['id'], True)

        with self.assertRaises(ValueError):
            self.manager.delete_folder_drafts(folder['id'], [first['id'], other['id']], confirm_daki=True)
        with self.assertRaises(ValueError):
            self.manager.delete_folder_drafts(folder['id'], ['../' + first['id']], confirm_daki=True)
        for invalid_ids in ([], [first['id'], first['id']], ['not-an-id']):
            with self.subTest(invalid_ids=invalid_ids), self.assertRaises(ValueError):
                self.manager.delete_folder_drafts(folder['id'], invalid_ids, confirm_daki=True)
        self.assertTrue(self.manager.image_path(first['id']).is_file())

        reference = {'kind': 'project', 'label': 'Synthetic project'}
        self.references.return_value = [reference]
        with self.assertRaises(DakiDraftReferencesConflict) as caught:
            self.manager.delete_folder_drafts(folder['id'], [first['id']])
        self.assertEqual(caught.exception.references, [reference])
        self.assertTrue(self.manager.image_path(first['id']).is_file())
        self.assertEqual(self.references.call_args.args[0], [f"__daki_drafts__/{first['id']}.png"])

        self.references.reset_mock()
        skipped_only = self.manager.delete_folder_drafts(
            folder['id'], [selected['id']], preserve_selected=True)
        self.assertEqual(skipped_only, {'deleted_ids': [], 'failed_ids': [],
                                        'skipped_ids': [selected['id']]})
        self.references.assert_not_called()
        result = self.manager.delete_folder_drafts(
            folder['id'], [first['id'], selected['id']], preserve_selected=True, confirm_daki=True)
        self.assertEqual(result, {'deleted_ids': [first['id']], 'failed_ids': [],
                                  'skipped_ids': [selected['id']]})
        self.references.assert_not_called()
        detail = self.manager.get_folder(folder['id'])
        self.assertEqual([draft['id'] for draft in detail['drafts']], [selected['id']])
        self.assertEqual(detail['folder']['selected_count'], 1)

        extra = self.make_draft(folder_id=folder['id'], prompt='partial failure')
        rmtree = shutil.rmtree

        def fail_selected_then_delete(path):
            if Path(path).resolve() == (self.root / selected['id']).resolve():
                raise OSError('synthetic removal failure')
            return rmtree(path)

        with mock.patch('naim.daki_drafts.shutil.rmtree', side_effect=fail_selected_then_delete):
            partial = self.manager.delete_folder_drafts(
                folder['id'], [selected['id'], extra['id']], confirm_daki=True)
        self.assertEqual(partial, {'deleted_ids': [extra['id']], 'failed_ids': [selected['id']],
                                   'skipped_ids': []})
        self.assertTrue((self.root / selected['id']).is_dir())
        self.assertFalse((self.root / extra['id']).exists())
        self.assertTrue(self.manager.image_path(selected['id']).is_file())
        with self.assertRaises(FileNotFoundError):
            self.manager.image_path(extra['id'])
        image_app = Flask(__name__)
        image_manager = register_daki_draft_routes(
            image_app, lambda: self.root, lambda: 'synthetic-key', mock.Mock())
        self.addCleanup(image_manager.wait)
        image_client = image_app.test_client()
        remaining_image = image_client.get(f"/api/daki/drafts/{selected['id']}/image")
        self.assertEqual(remaining_image.status_code, 200)
        remaining_image.close()
        deleted_image = image_client.get(f"/api/daki/drafts/{extra['id']}/image")
        self.assertEqual(deleted_image.status_code, 404)
        deleted_image.close()

    def test_running_draft_delete_conflict_leaves_manifest_and_directory_untouched(self):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def blocked(key, payload):
            entered.set()
            release.wait(5)
            return synthetic_image(key, payload)

        self.generator.side_effect = blocked
        folder = self.make_folder()
        running = self.manager.create({**synthetic_settings(), 'folder_id': folder['id']})
        self.assertTrue(entered.wait(2))
        directory = self.root / running['id']
        before = (directory / 'draft.json').read_bytes()
        with self.assertRaises(DakiStyleTestConflict):
            self.manager.delete_folder_drafts(folder['id'], [running['id']], confirm_daki=True)
        self.assertTrue(directory.is_dir())
        self.assertEqual((directory / 'draft.json').read_bytes(), before)
        self.assertEqual(self.manager.get_folder(folder['id'])['drafts'][0]['status'], 'running')
        release.set()
        self.assertTrue(self.manager.wait())

    def test_delete_rejects_symlink_escape_when_supported(self):
        folder = self.make_folder()
        draft = self.make_draft(folder_id=folder['id'])
        entry = self.root / draft['id']
        outside = self.root.parent / 'outside-draft'
        entry.rename(outside)
        try:
            try:
                entry.symlink_to(outside, target_is_directory=True)
            except (OSError, NotImplementedError):
                outside.rename(entry)
                self.skipTest('Directory symlinks are unavailable in this environment.')
            with self.assertRaises(ValueError):
                self.manager.delete_folder_drafts(folder['id'], [draft['id']], confirm_daki=True)
            self.assertTrue(outside.is_dir())
            self.assertTrue((outside / 'draft.json').is_file())
        finally:
            if entry.is_symlink():
                entry.unlink()
            if outside.exists():
                outside.rename(entry)

    def test_delete_folder_removes_every_owned_draft_and_only_its_catalog_entry(self):
        folder = self.make_folder(name='Delete me', project_id='a' * 32)
        other_folder = self.make_folder(name='Keep me', project_id='b' * 32)
        catalog_path = self.root / 'folders.json'
        catalog = json.loads(catalog_path.read_text(encoding='utf-8'))
        catalog['unknown_catalog_key'] = {'preserved': True}
        catalog['folders'][0]['unknown_folder_key'] = ['preserved']
        catalog['folders'][1]['other_folder_key'] = {'preserved': True}
        catalog_path.write_text(json.dumps(catalog), encoding='utf-8')

        generated = 0

        def generate_three(key, payload):
            nonlocal generated
            generated += 1
            if generated == 3:
                raise ValueError('synthetic failure')
            return synthetic_image(key, payload)

        self.generator.side_effect = generate_three
        completed = self.make_draft(folder_id=folder['id'], prompt='completed')
        selected = self.make_draft(folder_id=folder['id'], prompt='selected')
        failed = self.make_draft(folder_id=folder['id'], prompt='failed')
        self.generator.side_effect = synthetic_image
        other = self.make_draft(folder_id=other_folder['id'], prompt='other')
        legacy = self.make_draft(folder_id='legacy', prompt='legacy')
        tag_example = self.make_draft(purpose='tag_example', prompt='tag example')
        self.manager.set_selected(selected['id'], True)
        self.excluded.add(failed['id'])
        target_ids = {completed['id'], selected['id'], failed['id']}
        before_delete_catalog = json.loads(catalog_path.read_text(encoding='utf-8'))

        result = self.manager.delete_folder(folder['id'])

        self.assertEqual(result['deleted_folder_id'], folder['id'])
        self.assertEqual(result['project_id'], 'a' * 32)
        self.assertEqual(set(result['deleted_ids']), target_ids)
        self.assertEqual(self.references.call_args.args[0],
                         [f'__daki_drafts__/{draft_id}.png' for draft_id in sorted(target_ids)])
        for draft_id in target_ids:
            self.assertFalse((self.root / draft_id).exists())
        self.assertTrue((self.root / other['id']).is_dir())
        self.assertTrue((self.root / legacy['id']).is_dir())
        self.assertTrue((self.root / tag_example['id']).is_dir())
        stored = json.loads(catalog_path.read_text(encoding='utf-8'))
        self.assertEqual(stored['unknown_catalog_key'], {'preserved': True})
        expected_remaining = [item for item in before_delete_catalog['folders']
                              if item['id'] == other_folder['id']]
        self.assertEqual(stored['folders'], expected_remaining)
        self.assertEqual(stored['folders'][0]['other_folder_key'], {'preserved': True})
        with self.assertRaises(FileNotFoundError):
            self.manager.get_folder(folder['id'])
        self.assertEqual(self.manager.get_folder(other_folder['id'])['drafts'][0]['id'], other['id'])
        self.assertEqual(self.manager.get_folder('legacy')['drafts'][0]['id'], legacy['id'])

    def test_delete_empty_folder_removes_catalog_entry_without_reference_lookup(self):
        folder = self.make_folder()
        self.references.reset_mock()

        result = self.manager.delete_folder(folder['id'])

        self.assertEqual(result, {
            'deleted_folder_id': folder['id'], 'project_id': '', 'deleted_ids': [],
        })
        self.references.assert_not_called()
        self.assertEqual(json.loads((self.root / 'folders.json').read_text(encoding='utf-8'))['folders'], [])
        self.assertFalse(any(path.name.startswith('.delete-folder-') for path in self.root.iterdir()))

    def test_delete_folder_rejects_symlink_escape_when_supported(self):
        folder = self.make_folder()
        draft = self.make_draft(folder_id=folder['id'])
        entry = self.root / draft['id']
        outside = self.root.parent / 'outside-folder-draft'
        before_catalog = (self.root / 'folders.json').read_bytes()
        entry.rename(outside)
        try:
            try:
                entry.symlink_to(outside, target_is_directory=True)
            except (OSError, NotImplementedError):
                outside.rename(entry)
                self.skipTest('Directory symlinks are unavailable in this environment.')
            with self.assertRaises(ValueError):
                self.manager.delete_folder(folder['id'], confirm_daki=True)
            self.assertTrue(outside.is_dir())
            self.assertTrue((outside / 'draft.json').is_file())
            self.assertEqual((self.root / 'folders.json').read_bytes(), before_catalog)
        finally:
            if entry.is_symlink():
                entry.unlink()
            if outside.exists():
                outside.rename(entry)

    def test_delete_folder_reference_conflict_keeps_selected_and_excluded_files_until_confirmation(self):
        folder = self.make_folder()
        selected = self.make_draft(folder_id=folder['id'], prompt='selected')
        excluded = self.make_draft(folder_id=folder['id'], prompt='excluded')
        self.manager.set_selected(selected['id'], True)
        self.excluded.add(excluded['id'])
        target_ids = [selected['id'], excluded['id']]
        before_files = {
            draft_id: {path.name: path.read_bytes() for path in (self.root / draft_id).iterdir()}
            for draft_id in target_ids
        }
        before_catalog = (self.root / 'folders.json').read_bytes()
        self.references.return_value = [{'kind': 'project', 'label': 'Synthetic reference'}]

        with self.assertRaises(DakiDraftReferencesConflict) as caught:
            self.manager.delete_folder(folder['id'])

        self.assertEqual(caught.exception.references, self.references.return_value)
        self.assertEqual(self.references.call_args.args[0],
                         [f'__daki_drafts__/{draft_id}.png' for draft_id in sorted(target_ids)])
        self.assertEqual((self.root / 'folders.json').read_bytes(), before_catalog)
        for draft_id in target_ids:
            self.assertEqual({path.name: path.read_bytes() for path in (self.root / draft_id).iterdir()},
                             before_files[draft_id])

        self.references.reset_mock()
        result = self.manager.delete_folder(folder['id'], confirm_daki=True)
        self.references.assert_not_called()
        self.assertEqual(set(result['deleted_ids']), set(target_ids))
        self.assertTrue(all(not (self.root / draft_id).exists() for draft_id in target_ids))

    def test_delete_folder_validation_running_and_corrupt_manifest_preflight(self):
        folder = self.make_folder()
        for invalid_folder in ('legacy', 'bad-id', '../' + folder['id'], None):
            with self.subTest(folder=invalid_folder), self.assertRaises(ValueError):
                self.manager.delete_folder(invalid_folder)
        for invalid_confirmation in (1, 0, 'true', None):
            with self.subTest(confirmation=invalid_confirmation), self.assertRaises(ValueError):
                self.manager.delete_folder(folder['id'], confirm_daki=invalid_confirmation)
        with self.assertRaises(FileNotFoundError):
            self.manager.delete_folder('a' * 32)

        target = self.make_draft(folder_id=folder['id'], prompt='target')
        incomplete_id = 'b' * 32
        incomplete = self.root / incomplete_id
        incomplete.mkdir()
        (incomplete / 'draft.json').write_text('{broken', encoding='utf-8')
        before_catalog = (self.root / 'folders.json').read_bytes()
        before_target = {path.name: path.read_bytes() for path in (self.root / target['id']).iterdir()}
        with self.assertRaises(ValueError):
            self.manager.delete_folder(folder['id'], confirm_daki=True)
        self.assertEqual((self.root / 'folders.json').read_bytes(), before_catalog)
        self.assertEqual({path.name: path.read_bytes() for path in (self.root / target['id']).iterdir()},
                         before_target)

    def test_delete_folder_blocks_active_generation_and_anomalous_tag_example_owner(self):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def blocked(key, payload):
            entered.set()
            release.wait(5)
            return synthetic_image(key, payload)

        self.generator.side_effect = blocked
        folder = self.make_folder()
        running = self.manager.create({**synthetic_settings(), 'folder_id': folder['id']})
        self.assertTrue(entered.wait(2))
        before_catalog = (self.root / 'folders.json').read_bytes()
        before_manifest = (self.root / running['id'] / 'draft.json').read_bytes()
        with self.assertRaises(DakiStyleTestConflict):
            self.manager.delete_folder(folder['id'], confirm_daki=True)
        self.assertEqual((self.root / 'folders.json').read_bytes(), before_catalog)
        self.assertEqual((self.root / running['id'] / 'draft.json').read_bytes(), before_manifest)
        release.set()
        self.assertTrue(self.manager.wait())

        tag_folder = self.make_folder()
        tagged = self.make_draft(purpose='tag_example', prompt='tagged')
        manifest = self.root / tagged['id'] / 'draft.json'
        record = json.loads(manifest.read_text(encoding='utf-8'))
        record['folder_id'] = tag_folder['id']
        manifest.write_text(json.dumps(record), encoding='utf-8')
        tag_folder_bytes = (self.root / 'folders.json').read_bytes()
        with self.assertRaises(ValueError):
            self.manager.delete_folder(tag_folder['id'], confirm_daki=True)
        self.assertEqual((self.root / 'folders.json').read_bytes(), tag_folder_bytes)
        self.assertTrue((self.root / tagged['id']).is_dir())

    def test_delete_folder_move_and_catalog_failures_restore_original_directories(self):
        folder = self.make_folder()
        first = self.make_draft(folder_id=folder['id'], prompt='first')
        second = self.make_draft(folder_id=folder['id'], prompt='second')
        target_ids = [first['id'], second['id']]
        fail_id = sorted(target_ids)[1]
        before_catalog = (self.root / 'folders.json').read_bytes()
        before_files = {
            draft_id: {path.name: path.read_bytes() for path in (self.root / draft_id).iterdir()}
            for draft_id in target_ids
        }
        original_replace = os.replace
        failed = False

        def fail_second_move(source, destination):
            nonlocal failed
            if Path(source) == self.root / fail_id and not failed:
                failed = True
                raise OSError('synthetic move failure')
            return original_replace(source, destination)

        with mock.patch('naim.daki_drafts.os.replace', side_effect=fail_second_move):
            with self.assertRaises(OSError):
                self.manager.delete_folder(folder['id'], confirm_daki=True)
        self.assertTrue(failed)
        self.assertEqual((self.root / 'folders.json').read_bytes(), before_catalog)
        for draft_id in target_ids:
            self.assertEqual({path.name: path.read_bytes() for path in (self.root / draft_id).iterdir()},
                             before_files[draft_id])
        self.assertFalse(any(path.name.startswith('.delete-folder-') for path in self.root.iterdir()))

        with mock.patch.object(self.manager, '_save_catalog', side_effect=OSError('synthetic catalog failure')):
            with self.assertRaises(OSError):
                self.manager.delete_folder(folder['id'], confirm_daki=True)
        self.assertEqual((self.root / 'folders.json').read_bytes(), before_catalog)
        for draft_id in target_ids:
            self.assertEqual({path.name: path.read_bytes() for path in (self.root / draft_id).iterdir()},
                             before_files[draft_id])
        self.assertFalse(any(path.name.startswith('.delete-folder-') for path in self.root.iterdir()))

    def test_delete_folder_cleanup_failure_returns_safe_warning_after_catalog_commit(self):
        folder = self.make_folder()
        draft = self.make_draft(folder_id=folder['id'])
        rmtree = shutil.rmtree

        def fail_staging_cleanup(path, *args, **kwargs):
            if Path(path).name.startswith('.delete-folder-'):
                raise OSError('synthetic cleanup failure')
            return rmtree(path, *args, **kwargs)

        with mock.patch('naim.daki_drafts.shutil.rmtree', side_effect=fail_staging_cleanup):
            result = self.manager.delete_folder(folder['id'], confirm_daki=True)
        self.assertEqual(result['deleted_ids'], [draft['id']])
        self.assertIn('warning', result)
        self.assertNotIn(str(self.root), result['warning'])
        self.assertFalse(any(folder['id'] == item['id'] for item in self.manager.list_folders()))
        leftovers = [path for path in self.root.iterdir() if path.name.startswith('.delete-folder-')]
        self.assertEqual(len(leftovers), 1)
        rmtree(leftovers[0])

    def test_http_full_folder_delete_conflict_confirmation_and_missing_routes(self):
        app = Flask(__name__)
        app.config['TESTING'] = True
        references = mock.Mock(return_value=[{'kind': 'canvas', 'label': 'Synthetic canvas'}])
        manager = register_daki_draft_routes(
            app, lambda: self.root, lambda: 'synthetic-key', mock.Mock(side_effect=synthetic_image),
            references_provider=references)
        self.addCleanup(manager.wait)
        client = app.test_client()
        folder = client.post('/api/daki/draft-folders', json={'name': 'HTTP delete', 'project_id': 'a' * 32})
        self.assertEqual(folder.status_code, 201, folder.json)
        folder_id = folder.json['folder']['id']
        draft = client.post('/api/daki/drafts', json={
            **synthetic_settings(), 'folder_id': folder_id})
        self.assertEqual(draft.status_code, 201, draft.json)
        draft_id = draft.json['draft']['id']
        self.assertTrue(manager.wait())

        blocked = client.post(f'/api/daki/draft-folders/{folder_id}/delete', json={})
        self.assertEqual(blocked.status_code, 409, blocked.json)
        self.assertEqual(blocked.json['code'], 'daki_references')
        self.assertTrue((self.root / draft_id).is_dir())
        for invalid in (1, None, 'true'):
            invalid_response = client.post(f'/api/daki/draft-folders/{folder_id}/delete',
                                           json={'confirm_daki': invalid})
            self.assertEqual(invalid_response.status_code, 400)

        deleted = client.post(f'/api/daki/draft-folders/{folder_id}/delete', json={'confirm_daki': True})
        self.assertEqual(deleted.status_code, 200, deleted.json)
        self.assertEqual(deleted.json['status'], 'success')
        self.assertEqual(deleted.json['deleted_folder_id'], folder_id)
        self.assertEqual(deleted.json['project_id'], 'a' * 32)
        self.assertEqual(deleted.json['deleted_ids'], [draft_id])
        self.assertFalse((self.root / draft_id).exists())
        for method, path in (
            ('get', f'/api/daki/draft-folders/{folder_id}'),
            ('put', f'/api/daki/draft-folders/{folder_id}'),
            ('post', f'/api/daki/draft-folders/{folder_id}/delete'),
        ):
            response = getattr(client, method)(path, json={} if method != 'get' else None)
            self.assertEqual(response.status_code, 404, response.json)
        self.assertEqual(client.post('/api/daki/draft-folders/legacy/delete', json={}).status_code, 400)
        self.assertEqual(client.post('/api/daki/draft-folders/' + 'f' * 32 + '/delete', json={}).status_code, 404)

    def test_http_routes_expose_folder_detail_selection_reference_conflict_and_remaining_results(self):
        app = Flask(__name__)
        app.config['TESTING'] = True
        app_generator = mock.Mock(side_effect=synthetic_image)
        references = mock.Mock(return_value=[])
        manager = register_daki_draft_routes(
            app, lambda: self.root, lambda: 'synthetic-key', app_generator,
            excluded_draft_ids_provider=lambda: (), references_provider=references)
        self.addCleanup(manager.wait)
        client = app.test_client()

        created_folder = client.post('/api/daki/draft-folders', json={'name': 'HTTP folder'})
        self.assertEqual(created_folder.status_code, 201, created_folder.json)
        folder_id = created_folder.json['folder']['id']
        draft_response = client.post('/api/daki/drafts', json={
            **synthetic_settings(), 'folder_id': folder_id})
        self.assertEqual(draft_response.status_code, 201, draft_response.json)
        draft_id = draft_response.json['draft']['id']
        self.assertTrue(manager.wait())
        tag_response = client.post('/api/daki/drafts', json={
            **synthetic_settings(prompt='tag example history'), 'purpose': 'tag_example'})
        self.assertEqual(tag_response.status_code, 201, tag_response.json)
        tag_id = tag_response.json['draft']['id']
        self.assertTrue(manager.wait())
        self.assertEqual({row['id'] for row in client.get('/api/daki/drafts').json['drafts']},
                         {draft_id, tag_id})
        self.assertEqual([row['id'] for row in client.get('/api/daki/drafts?purpose=draft').json['drafts']],
                         [draft_id])
        self.assertEqual([row['id'] for row in client.get('/api/daki/drafts?purpose=tag_example').json['drafts']],
                         [tag_id])
        self.assertEqual(client.get('/api/daki/drafts?purpose=unknown').status_code, 400)
        selected_response = client.put(f'/api/daki/drafts/{draft_id}/selection', json={'selected': True})
        self.assertEqual(selected_response.status_code, 200)
        self.assertTrue(selected_response.json['draft']['selected'])
        detail_response = client.put(f'/api/daki/draft-folders/{folder_id}',
                                     json={'name': 'Updated HTTP folder'})
        self.assertEqual(detail_response.status_code, 200)
        self.assertEqual(detail_response.json['folder']['name'], 'Updated HTTP folder')

        references.return_value = [{'kind': 'tag_example'}]
        blocked = client.post(f'/api/daki/draft-folders/{folder_id}/delete-drafts',
                              json={'ids': [draft_id]})
        self.assertEqual(blocked.status_code, 409)
        self.assertEqual(blocked.json['code'], 'daki_references')
        self.assertIn('daki 후보', blocked.json['message'])

        deleted = client.post(f'/api/daki/draft-folders/{folder_id}/delete-drafts', json={
            'ids': [draft_id], 'preserve_selected': True, 'confirm_daki': True})
        self.assertEqual(deleted.status_code, 200, deleted.json)
        self.assertEqual(deleted.json['deleted_ids'], [])
        self.assertEqual(deleted.json['skipped_ids'], [draft_id])
        self.assertEqual(deleted.json['folder']['count'], 1)
        self.assertEqual(deleted.json['drafts'][0]['id'], draft_id)

    def test_project_query_and_owner_validation_keep_folders_with_their_project(self):
        app = Flask(__name__)
        app.config['TESTING'] = True
        project_ids = {'a' * 32, 'b' * 32}
        validated = []

        def validate_project(project_id):
            validated.append(project_id)
            if project_id not in project_ids:
                raise ValueError('프로젝트를 찾을 수 없습니다.')

        manager = register_daki_draft_routes(
            app, lambda: self.root, lambda: 'synthetic-key', mock.Mock(side_effect=synthetic_image),
            project_validator=validate_project)
        self.addCleanup(manager.wait)
        client = app.test_client()

        missing = client.post('/api/daki/draft-folders', json={'name': 'Missing project'})
        unknown = client.post('/api/daki/draft-folders', json={
            'name': 'Unknown project', 'project_id': 'c' * 32})
        self.assertEqual(missing.status_code, 400)
        self.assertEqual(unknown.status_code, 400)
        self.assertFalse(self.root.exists())

        first = client.post('/api/daki/draft-folders', json={
            'name': 'Project A', 'project_id': 'a' * 32,
            'settings': synthetic_settings(prompt='project A recipe')})
        second = client.post('/api/daki/draft-folders', json={
            'name': 'Project B', 'project_id': 'b' * 32,
            'settings': synthetic_settings(prompt='project B recipe')})
        self.assertEqual(first.status_code, 201, first.json)
        self.assertEqual(second.status_code, 201, second.json)
        first_id, second_id = first.json['folder']['id'], second.json['folder']['id']

        for folder_id, prompt in ((first_id, 'A result'), (second_id, 'B result')):
            response = client.post('/api/daki/drafts', json={
                **synthetic_settings(prompt=prompt), 'folder_id': folder_id})
            self.assertEqual(response.status_code, 201, response.json)
            self.assertTrue(manager.wait())
        legacy = client.post('/api/daki/drafts', json=synthetic_settings(prompt='legacy result'))
        self.assertEqual(legacy.status_code, 201, legacy.json)
        self.assertTrue(manager.wait())

        for project_id, expected_id in (('a' * 32, first_id), ('b' * 32, second_id)):
            rows = client.get(f'/api/daki/draft-folders?project={project_id}').json['folders']
            self.assertEqual([row['id'] for row in rows], [expected_id])
            self.assertEqual(rows[0]['project_id'], project_id)
            self.assertEqual(rows[0]['count'], 1)
            self.assertNotEqual(rows[0]['id'], 'legacy')
        alias_rows = client.get(f"/api/daki/draft-folders?project_id={'a' * 32}").json['folders']
        self.assertEqual([row['id'] for row in alias_rows], [first_id])
        all_rows = client.get('/api/daki/draft-folders').json['folders']
        self.assertEqual({row['id'] for row in all_rows}, {first_id, second_id, 'legacy'})
        self.assertIn('c' * 32, validated)


if __name__ == '__main__':
    unittest.main()
