import ast
import os
from pathlib import Path
import shutil
import tempfile
import threading
import types
import unittest
from unittest import mock
from urllib.parse import unquote, urlsplit

from PIL import Image
import image_logic
import utils
from naim.storage.history import HistoryDB
from naim.storage.daki_projects import DakiProjectsStore
from naim.storage.daki_personal_styles import DakiPersonalStyles
from naim.storage.daki_tag_examples import DakiTagExamples
from naim.storage.webp_conversion import resolve_converted_gallery_path, migrate_webp_references
from naim.storage.project_archives import resolve_archived_image
from naim.images.webp_conversion import convert_png_to_webp


class GalleryZoomTrashTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.database = self.root / 'naia_history.db'
        # Exercise the actual route without importing the live app or requiring Flask.
        source = ast.parse((Path(__file__).resolve().parents[1] / 'app.py').read_text(encoding='utf-8'))
        functions = [node for node in source.body if isinstance(node, ast.FunctionDef)
                     and node.name in ('trash_gallery_image', 'resolve_gallery_file_path',
                                       'clean_gallery_rel_path', 'resolve_daki_image_path',
                                       'daki_delete_warning', 'apply_changes', 'empty_trash_folder')]
        for function in functions:
            function.decorator_list = []
        self.request = types.SimpleNamespace(json={})
        namespace = {'request': self.request, 'jsonify': lambda value: value, 'utils': utils,
                     'image_logic': image_logic, 'os': os, 'CLASSIFIED_DIR': str(self.root),
                     'resolve_converted_gallery_path': resolve_converted_gallery_path,
                     'resolve_archived_image': resolve_archived_image,
                     'unquote': unquote, 'urlsplit': urlsplit, 'shutil': shutil,
                     'TRASH_DIR': str(self.root / '_TRASH'), 'GALLERY_INDEX_DB_LOCK': threading.RLock()}
        exec(compile(ast.Module(body=functions, type_ignores=[]), '<trash_gallery_image>', 'exec'), namespace)
        self.store = DakiProjectsStore(self.root / 'daki_projects.json',
                                      namespace['resolve_daki_image_path'], namespace['clean_gallery_rel_path'])
        namespace['DAKI_PROJECTS'] = self.store
        self.personal = DakiPersonalStyles(self.root / 'personal', self.store.resolve_image, lambda path: {})
        namespace['DAKI_PERSONAL_STYLES'] = self.personal
        self.tag_examples = DakiTagExamples(self.root / 'tag_examples', self.store.resolve_image)
        namespace['DAKI_TAG_EXAMPLES'] = self.tag_examples
        self.route = namespace['trash_gallery_image']
        self.apply_route = namespace['apply_changes']
        self.empty_route = namespace['empty_trash_folder']
        patcher = mock.patch.object(utils, 'HistoryDB', side_effect=lambda: HistoryDB(self.database))
        patcher.start()
        self.addCleanup(patcher.stop)

    def image(self, relative, color='blue'):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new('RGB', (4, 4), color).save(path)
        return path

    def send(self, path, **options):
        self.request.json = {'path': path, **options}
        result = self.route()
        return result if isinstance(result, tuple) else (result, 200)

    def test_single_image_and_sidecar_move_with_restore_mapping(self):
        image = self.image('sample/a.png')
        image.with_suffix('.txt').write_text('Synthetic reason', encoding='utf-8')
        other = self.image('sample/b.png')
        result, status = self.send('sample/a.png')
        self.assertEqual((status, result['status']), (200, 'success'))
        self.assertFalse(image.exists())
        self.assertTrue(other.exists())
        trashed = list((self.root / '_TRASH').rglob('*.png'))
        self.assertEqual(len(trashed), 1)
        self.assertEqual(trashed[0].with_suffix('.txt').read_text(encoding='utf-8'), 'Synthetic reason')
        db = HistoryDB(self.database)
        try:
            self.assertEqual(db.get_original_path(str(trashed[0])), str(image))
        finally:
            db.close()

    def test_tag_example_requires_explicit_warning_confirmation_before_trash(self):
        source = self.image('sample/tag.png')
        self.tag_examples.add('synthetic_tag', 'sample/tag.png')
        response, status = self.send('sample/tag.png')
        self.assertEqual((status, response['code']), (409, 'daki_references'))
        self.assertEqual(response['references'][0]['tag'], 'synthetic_tag')
        self.assertTrue(source.exists())
        response, status = self.send('sample/tag.png', confirm_daki=True)
        self.assertEqual((status, response['status']), (200, 'success'))
        self.assertFalse(source.exists())
        self.assertEqual(self.tag_examples.list_examples()[0]['path'], 'sample/tag.png')

    def test_old_converted_png_url_moves_the_webp_to_trash(self):
        source = self.image('sample/a.png')
        db = HistoryDB(self.database)
        try:
            result = convert_png_to_webp(source, before_delete=lambda old, new:
                                         migrate_webp_references(db, self.root, old, new, None))
            self.assertEqual(result['status'], 'converted', result)
        finally:
            db.close()
        result, status = self.send('sample/a.png')
        self.assertEqual((status, result['status']), (200, 'success'))
        self.assertFalse(source.with_suffix('.webp').exists())
        self.assertEqual(len(list((self.root / '_TRASH').rglob('*.webp'))), 1)

    def test_trash_missing_non_image_and_outside_paths_are_rejected(self):
        image = self.image('_TRASH/already.png')
        text = self.root / 'notes.txt'
        text.write_text('Synthetic note', encoding='utf-8')
        with mock.patch.object(image_logic, 'handle_integrated_tasks') as move:
            for path, expected in [('_TRASH/already.png', 400), ('missing.png', 404),
                                   ('notes.txt', 404), ('../outside.png', 400)]:
                with self.subTest(path=path):
                    result, status = self.send(path)
                    self.assertEqual(status, expected)
                    self.assertEqual(result['status'], 'error')
            move.assert_not_called()
        self.assertTrue(image.exists())

    def test_locked_file_failure_is_reported_and_source_remains(self):
        image = self.image('sample/a.png')
        with mock.patch.object(image_logic.os, 'replace', side_effect=PermissionError('Synthetic lock')):
            result, status = self.send('sample/a.png')
        self.assertEqual((status, result['status']), (409, 'error'))
        self.assertTrue(image.exists())

    def test_rapid_deletes_of_identical_names_preserve_both_images(self):
        import datetime
        first = self.image('one/page.png', 'red')
        second = self.image('two/page.png', 'blue')
        with mock.patch('datetime.datetime') as clock:
            clock.now.return_value = datetime.date(2026, 1, 1)
            self.assertEqual(self.send('one/page.png')[1], 200)
            self.assertEqual(self.send('two/page.png')[1], 200)
        self.assertFalse(first.exists())
        self.assertFalse(second.exists())
        colors = []
        for path in (self.root / '_TRASH').rglob('*.png'):
            with Image.open(path) as image:
                colors.append(image.getpixel((0, 0)))
        self.assertCountEqual(colors, [(255, 0, 0), (0, 0, 255)])

    def test_linked_candidate_requires_explicit_approval_before_actual_move(self):
        image = self.image('sample/a.png')
        image.with_suffix('.txt').write_text('Synthetic sidecar', encoding='utf-8')
        project = self.store.create_project('Front project', 'sample/a.png', 'front')
        for options in ({}, {'confirm_daki': False}, {'confirm_daki': 'true'}, {'confirm_daki': 1}):
            with self.subTest(options=options):
                result, status = self.send('sample/a.png', **options)
                self.assertEqual((status, result['code']), (409, 'daki_references'))
                self.assertEqual(result['references'], [{
                    'project_id': project['id'], 'project_name': 'Front project',
                    'side': 'front', 'path': 'sample/a.png',
                }])
                self.assertTrue(image.exists())
                self.assertTrue(image.with_suffix('.txt').exists())
                self.assertFalse((self.root / '_TRASH').exists())
        result, status = self.send('sample/a.png', confirm_daki=True)
        self.assertEqual((status, result['status']), (200, 'success'))
        self.assertFalse(image.exists())
        self.assertEqual(len(list((self.root / '_TRASH').rglob('*.png'))), 1)
        self.assertEqual(self.store.get_project(project['id']), project)

    def test_disabled_daki_still_warns_before_moving_a_linked_candidate(self):
        image = self.image('sample/a.png')
        self.store.create_project('Preserved project', 'sample/a.png', 'back')
        self.store.set_enabled(False)
        with mock.patch.object(image_logic, 'handle_integrated_tasks') as move:
            result, status = self.send('sample/a.png')
            self.assertEqual((status, result['code']), (409, 'daki_references'))
            move.assert_not_called()
        self.assertTrue(image.exists())

    def test_personal_representative_and_project_warn_together_before_deletion(self):
        image = self.image('sample/a.png')
        personal = self.personal.create({'name': 'Personal recipe', 'positive': 'ink', 'source_path': 'sample/a.png'})
        project = self.store.create_project('Project recipe', 'sample/a.png', 'front')
        result, status = self.send('sample/a.png')
        self.assertEqual((status, result['code']), (409, 'daki_references'))
        self.assertEqual({entry['project_id'] for entry in result['references']}, {personal['id'], project['id']})
        self.assertEqual(result['references'][1]['side'], '대표 그림')
        self.assertTrue(image.exists())
        result, status = self.send('sample/a.png', confirm_daki=True)
        self.assertEqual((status, result['status']), (200, 'success'))
        self.assertFalse(image.exists())
        self.assertEqual(self.personal.get_style(personal['id']), personal)

    def test_personal_only_folder_and_batch_deletion_warn_before_any_write(self):
        image = self.image('group/nested/a.png')
        style = self.personal.create({'name': 'Linked personal', 'positive': 'ink', 'source_path': 'group/nested/a.png'})
        self.store.set_enabled(False)
        for payload in ({'deletes': ['group/nested/a.png']}, {'delete_folders': ['group']}):
            with self.subTest(payload=payload):
                self.request.json = payload
                with mock.patch.object(image_logic, 'handle_integrated_tasks') as apply:
                    result, status = self.apply_route()
                    self.assertEqual((status, result['code']), (409, 'daki_references'))
                    self.assertEqual(result['references'][0]['style_id'], style['id'])
                    apply.assert_not_called()
                self.assertTrue(image.exists())

    def test_converted_candidate_warns_for_both_old_png_and_actual_webp_paths(self):
        source = self.image('sample/a.png')
        self.store.create_project('Converted project', 'sample/a.png', 'front')
        db = HistoryDB(self.database)
        try:
            converted = convert_png_to_webp(source, before_delete=lambda old, new:
                                            migrate_webp_references(db, self.root, old, new, None))
            self.assertEqual(converted['status'], 'converted', converted)
        finally:
            db.close()
        for path in ('sample/a.png', 'sample/a.webp'):
            with self.subTest(path=path):
                result, status = self.send(path)
                self.assertEqual((status, result['code']), (409, 'daki_references'))
                self.assertEqual(result['references'][0]['path'], 'sample/a.png')
                self.assertTrue(source.with_suffix('.webp').exists())

    def test_missing_source_never_reconnects_to_same_name_in_another_rating_folder(self):
        source = self.image('sample/a.png', 'blue')
        self.image('_R-18/sample/a.png', 'red')
        self.image('_R-15/sample/a.png', 'green')
        project = self.store.create_project('Original location', 'sample/a.png', 'front')
        source.unlink()
        with self.assertRaises(FileNotFoundError):
            self.store.resolve_image('sample/a.png')
        self.assertEqual(self.store.references(paths=['_R-18/sample/a.png', '_R-15/sample/a.png']), [])
        self.assertEqual(self.store.get_project(project['id']), project)

    def test_literal_percent_and_hash_filenames_keep_the_original_reference_on_delete(self):
        relative = 'sample/literal%2F%23#plus+.png'
        source = self.image(relative)
        self.store.create_project('Special filename', relative, 'front')
        result, status = self.send(relative)
        self.assertEqual((status, result['code']), (409, 'daki_references'))
        self.assertEqual(result['references'][0]['path'], relative)
        self.assertTrue(source.exists())

    def test_batch_image_and_folder_deletes_check_references_before_applying_any_changes(self):
        image = self.image('group/nested/a.png')
        self.store.create_project('Batch project', 'group/nested/a.png', 'front')
        for payload in ({'deletes': ['group/nested/a.png']}, {'delete_folders': ['group']}):
            with self.subTest(payload=payload):
                self.request.json = {**payload, 'thumbs': [{'new_thumb': 'other.png'}]}
                with mock.patch.object(image_logic, 'handle_integrated_tasks') as apply:
                    result, status = self.apply_route()
                    self.assertEqual((status, result['code']), (409, 'daki_references'))
                    apply.assert_not_called()
                    self.request.json['confirm_daki'] = True
                    self.assertEqual(self.apply_route()['status'], 'success')
                    apply.assert_called_once_with(str(self.root), self.request.json)
                self.assertTrue(image.exists())

    def test_empty_trash_keeps_linked_candidates_until_explicit_approval_even_when_disabled(self):
        image = self.image('_TRASH/batch/a.png')
        unrelated = self.image('_TRASH/batch2/b.png')
        project = self.store.create_project('Trash project', '_TRASH/batch/a.png', 'back')
        self.store.set_enabled(False)
        self.request.json = {'folder': 'batch'}
        result, status = self.empty_route()
        self.assertEqual((status, result['code']), (409, 'daki_references'))
        self.assertTrue(image.exists())
        self.assertTrue(unrelated.exists())
        self.request.json['confirm_daki'] = True
        self.assertEqual(self.empty_route()['status'], 'success')
        self.assertFalse(image.parent.exists())
        self.assertTrue(unrelated.exists())
        self.assertEqual(self.store.get_project(project['id']), project)


if __name__ == '__main__':
    unittest.main()
