"""Project export persistence and route coverage; run in the isolated runner."""
import base64
from concurrent.futures import ThreadPoolExecutor
import io
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from urllib.parse import unquote

from PIL import Image

import app
from naim.daki_image_refs import parse_daki_image_reference, resolve_daki_image_reference
from naim.images.canvas_export import (
    project_export_image_path,
    save_project_canvas_export,
)
from naim.images.prompt_metadata import extract_prompt_info_from_image, load_prompt_sidecar
from naim.storage.daki_projects import (
    DakiNotFoundError,
    DakiProjectsStore,
    project_canvas_result_name,
)


_PROJECT_ID = 'a' * 32
_CANVAS_ID = 'b' * 32


def _png_data_url(image):
    stream = io.BytesIO()
    image.save(stream, format='PNG')
    encoded = base64.b64encode(stream.getvalue()).decode('ascii')
    return 'data:image/png;base64,' + encoded


class CanvasProjectExportStorageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.export_root = self.root / 'project_exports'
        self.projects_path = self.root / 'projects.json'

        def resolve_export(relative):
            resolved = resolve_daki_image_reference(
                relative, None, project_exports_root=self.export_root,
            )
            return resolved

        self.store = DakiProjectsStore(self.projects_path, resolve_export)
        self.project = self.store.create_project('Synthetic export project', canvas={
            'id': _CANVAS_ID,
            'name': 'Front draft',
            'side': 'front',
            'state': {'width': 8, 'height': 6, 'layers': []},
        })

    def image(self, color=(17, 43, 91, 127)):
        return Image.new('RGBA', (3, 2), color)

    def export(self, image=None, prompt_info=None, canvas_id=_CANVAS_ID):
        return save_project_canvas_export(
            self.store, self.export_root, self.project['id'], canvas_id,
            image or self.image(),
            {'basePrompt': 'synthetic ink', 'negativePrompt': 'synthetic blur'}
            if prompt_info is None else prompt_info,
        )

    def test_export_preserves_pixels_prompt_and_links_to_canvas_side(self):
        result = self.export()
        self.assertEqual(result['status'], 'success')
        self.assertEqual(result['destination'], 'project')
        self.assertEqual(result['side'], 'front')
        self.assertEqual(result['projectId'], self.project['id'])
        self.assertEqual(result['projectName'], self.project['name'])
        self.assertTrue(result['embedded_metadata_saved'])
        self.assertTrue(result['sidecar_saved'])

        full_path, relative = resolve_daki_image_reference(
            result['path'], None, project_exports_root=self.export_root,
        )
        self.assertEqual(relative, result['path'])
        self.assertEqual(result['src'], '/image/' + relative)
        with Image.open(full_path) as image:
            self.assertEqual(image.mode, 'RGBA')
            self.assertEqual(image.size, (3, 2))
            self.assertEqual(image.getpixel((0, 0)), (17, 43, 91, 127))
        self.assertEqual(extract_prompt_info_from_image(full_path)['basePrompt'], 'synthetic ink')
        sidecar = load_prompt_sidecar(full_path)
        self.assertEqual(sidecar['basePrompt'], 'synthetic ink')
        self.assertEqual(sidecar['negativePrompt'], 'synthetic blur')

        project = self.store.get_project(self.project['id'])
        self.assertEqual(len(project['candidates']['front']), 1)
        self.assertEqual(project['candidates']['front'][0]['path'], relative)
        self.assertEqual(project['candidates']['back'], [])

    def test_canvas_side_is_read_from_storage_and_each_export_is_unique(self):
        back = self.store.create_canvas(self.project['id'], {
            'id': 'c' * 32,
            'name': 'Back draft',
            'side': 'back',
            'state': {'width': 8, 'height': 6, 'layers': []},
        })
        first = self.export(canvas_id=back['id'])
        second = self.export(canvas_id=back['id'], image=self.image((80, 70, 60, 50)))
        self.assertEqual(first['side'], 'back')
        self.assertNotEqual(first['path'], second['path'])
        self.assertEqual(len(self.store.get_project(self.project['id'])['candidates']['back']), 2)
        with Image.open(resolve_daki_image_reference(
                first['path'], None, project_exports_root=self.export_root)[0]) as image:
            self.assertEqual(image.getpixel((0, 0)), (17, 43, 91, 127))

    def test_exports_use_project_side_timestamp_names_and_keep_export_count(self):
        first = self.export()
        second = self.export(image=self.image((80, 70, 60, 50)))
        expected_name = r'^Synthetic export project_앞면_\d{4}-\d{2}-\d{2}_\d{6}\.png$'
        self.assertRegex(first['name'], expected_name)
        self.assertRegex(second['name'], expected_name)
        self.assertNotIn('Front draft', first['name'])

        custom = self.store.create_canvas(self.project['id'], {
            'name': 'Synthetic export project_앞면_Directly named',
            'side': 'front',
            'state': {'width': 8, 'height': 6, 'layers': []},
        })
        custom_result = self.export(canvas_id=custom['id'])
        self.assertRegex(custom_result['name'], expected_name)
        self.assertNotIn('Directly named', custom_result['name'])

        reopened = DakiProjectsStore(self.projects_path, self.store.resolve_source)
        self.assertEqual(reopened.get_canvas(self.project['id'], _CANVAS_ID)['exportCount'], 2)
        self.assertEqual(reopened.get_canvas(self.project['id'], custom['id'])['exportCount'], 1)

    def test_candidate_removal_does_not_reuse_export_number_and_update_keeps_counter(self):
        first = self.export()
        second = self.export()
        project = self.store.get_project(self.project['id'])
        for result in (first, second):
            candidate = next(item for item in project['candidates']['front'] if item['path'] == result['path'])
            project = self.store.remove_candidate(self.project['id'], candidate['id'])

        canvas = self.store.get_canvas(self.project['id'], _CANVAS_ID)
        updated = self.store.update_canvas(
            self.project['id'], _CANVAS_ID, canvas['state'], canvas['revision'],
        )
        self.assertEqual(updated['exportCount'], 2)
        third = self.export()
        self.assertRegex(third['name'], r'^Synthetic export project_앞면_\d{4}-\d{2}-\d{2}_\d{6}\.png$')
        self.assertEqual(self.store.get_canvas(self.project['id'], _CANVAS_ID)['exportCount'], 3)

    def test_parallel_exports_receive_distinct_sequential_indices(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda color: self.export(image=self.image(color)), (
                (1, 2, 3, 4), (5, 6, 7, 8),
            )))
        for result in results:
            self.assertRegex(result['name'], r'^Synthetic export project_앞면_\d{4}-\d{2}-\d{2}_\d{6}\.png$')
            self.assertNotIn('Front draft', result['name'])
        self.assertEqual(len({result['path'] for result in results}), 2)
        self.assertEqual(self.store.get_canvas(self.project['id'], _CANVAS_ID)['exportCount'], 2)

    def test_export_names_replace_windows_invalid_characters_and_stay_under_200(self):
        name = project_canvas_result_name(
            '프로젝트<>/', 'front', '초안<>:"/\\|?*\x01. ', 1,
        )
        self.assertRegex(name, r'^프로젝트____앞면_\d{4}-\d{2}-\d{2}_\d{6}\.png$')
        self.assertNotIn('초안', name)
        self.assertNotRegex(name, r'[<>:"/\\|?*\x00-\x1f]')

        long_name = project_canvas_result_name('프로젝트', 'back', '캔버스' * 300, 12)
        self.assertLessEqual(len(long_name), 200)
        self.assertRegex(long_name, r'^프로젝트_뒷면_\d{4}-\d{2}-\d{2}_\d{6}\.png$')
        self.assertNotIn('캔버스', long_name)

    def test_long_project_name_is_truncated_without_adding_canvas_name(self):
        project_name = '가' * 120
        canvas_name = project_name.strip()[:100] + '_앞면_캔버스1'
        name = project_canvas_result_name(project_name, 'front', canvas_name, 1)
        self.assertRegex(name, r'^가{100}_앞면_\d{4}-\d{2}-\d{2}_\d{6}\.png$')
        self.assertEqual(name.count(project_name[:100]), 1)
        self.assertNotIn('캔버스1', name)

    def test_failed_candidate_json_write_rolls_back_export_and_counter(self):
        with mock.patch(
                'naim.storage.daki_projects.write_json', side_effect=OSError('synthetic project write failure')):
            with self.assertRaisesRegex(OSError, 'synthetic project write failure'):
                self.export()
        self.assertNotIn('exportCount', self.store.get_canvas(self.project['id'], _CANVAS_ID))
        self.assertEqual(self.store.get_project(self.project['id'])['candidates']['front'], [])
        self.assertEqual(list((self.export_root / self.project['id']).glob('*')), [])

    def test_export_without_prompt_keeps_png_without_empty_metadata_sidecar(self):
        result = self.export(prompt_info={})
        self.assertFalse(result['embedded_metadata_saved'])
        self.assertFalse(result['sidecar_saved'])
        full_path, _ = resolve_daki_image_reference(
            result['path'], None, project_exports_root=self.export_root,
        )
        self.assertTrue(Path(full_path).is_file())
        self.assertFalse(Path(full_path).with_suffix('.json').exists())
        self.assertEqual(list(Path(full_path).parent.glob('*.bak')), [])

    def test_invalid_or_missing_targets_do_not_create_export_files(self):
        for invalid_id in ('../' + _PROJECT_ID, _PROJECT_ID.upper(), 'f' * 31, None):
            with self.subTest(project_id=invalid_id), self.assertRaises(ValueError):
                save_project_canvas_export(
                    self.store, self.export_root, invalid_id, _CANVAS_ID,
                    self.image(), {},
                )
        with self.assertRaises(DakiNotFoundError):
            self.export(canvas_id='d' * 32)
        self.assertFalse(self.export_root.exists())

    def test_failed_metadata_or_candidate_write_removes_only_this_export(self):
        existing = self.export()
        existing_full = project_export_image_path(
            self.export_root, self.project['id'], existing['path'].rsplit('/', 1)[1][:-4],
        )
        existing_bytes = Path(existing_full).read_bytes()

        with mock.patch(
                'naim.images.canvas_export.save_prompt_sidecar',
                side_effect=OSError('synthetic sidecar failure')):
            with self.assertRaisesRegex(OSError, 'synthetic sidecar failure'):
                self.export(image=self.image((1, 2, 3, 4)))

        with mock.patch.object(
                self.store, 'add_candidate', side_effect=OSError('synthetic project write failure')):
            with self.assertRaisesRegex(OSError, 'synthetic project write failure'):
                self.export(image=self.image((4, 3, 2, 1)))

        self.assertEqual(Path(existing_full).read_bytes(), existing_bytes)
        self.assertEqual(len(self.store.get_project(self.project['id'])['candidates']['front']), 1)
        files = list((self.export_root / self.project['id']).iterdir())
        self.assertEqual({path.name for path in files}, {
            Path(existing_full).name,
            Path(existing_full).with_suffix('.json').name,
        })

    def test_export_references_are_reserved_and_require_a_root_and_existing_file(self):
        with self.assertRaises(ValueError):
            parse_daki_image_reference(f'__daki_exports__/{_PROJECT_ID}/../escape.png')
        with self.assertRaises(FileNotFoundError):
            resolve_daki_image_reference(f'__daki_exports__/{_PROJECT_ID}/' + 'e' * 32 + '.png', None)
        with self.assertRaises(FileNotFoundError):
            resolve_daki_image_reference(
                f'__daki_exports__/{_PROJECT_ID}/' + 'e' * 32 + '.png', None,
                project_exports_root=self.export_root,
            )
        result = self.export()
        self.assertEqual(parse_daki_image_reference(result['path']), (
            'export', self.project['id'], result['path'].rsplit('/', 1)[1][:-4],
        ))


class CanvasProjectExportRouteTests(unittest.TestCase):
    def test_converted_export_uses_webp_public_path_and_download_name_with_legacy_read_compatibility(self):
        from naim.images.webp_conversion import convert_png_to_webp
        response = self.client.post('/api/canvas/export_merged', json=self.body())
        self.assertEqual(response.status_code, 200, response.json)
        result = response.json
        source, _ = resolve_daki_image_reference(
            result['path'], None, project_exports_root=self.imports / 'project_exports')
        converted = convert_png_to_webp(source)
        self.assertEqual(converted['status'], 'converted', converted)
        webp_reference = result['path'][:-4] + '.webp'
        expected_name = result['name'][:-4] + '.webp'
        project = self.client.get(f'/api/daki/projects/{self.project["id"]}').json['project']
        candidate = project['candidates']['back'][0]
        self.assertEqual(candidate['path'], webp_reference)
        self.assertEqual(candidate['name'], expected_name)
        for url in ('/image/' + webp_reference, result['src']):
            served = self.client.get(url)
            try:
                self.assertEqual(served.status_code, 200)
                self.assertEqual(served.mimetype, 'image/webp')
                self.assertIn(expected_name, unquote(served.headers['Content-Disposition']))
            finally:
                served.close()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.imports = self.root / 'canvas_imports'
        self.imports.mkdir()
        self.gallery = self.root / 'gallery'
        self.gallery.mkdir()
        self.path_patchers = [
            mock.patch.object(app, 'CANVAS_IMPORT_DIR', str(self.imports)),
            mock.patch.object(app, 'CLASSIFIED_DIR', str(self.gallery)),
            mock.patch.object(app, 'DAKI_PROJECTS_FILE', str(self.root / 'projects.json')),
        ]
        for patcher in self.path_patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        app.app.config['TESTING'] = True
        self.client = app.app.test_client()
        self.project = app.DAKI_PROJECTS.create_project('Synthetic route project', canvas={
            'id': _CANVAS_ID,
            'name': 'Back canvas',
            'side': 'back',
            'state': {'width': 8, 'height': 6, 'layers': []},
        })

    def body(self, color=(17, 43, 91, 127)):
        return {
            'image': _png_data_url(Image.new('RGBA', (3, 2), color)),
            'width': 3,
            'height': 2,
            'promptInfo': {'basePrompt': 'synthetic ink', 'negativePrompt': 'synthetic blur'},
            'destination': 'project',
            'projectId': self.project['id'],
            'canvasId': _CANVAS_ID,
        }

    def test_project_route_serves_candidate_and_keeps_export_out_of_gallery_and_cleanup(self):
        with mock.patch.object(app.utils, 'HistoryDB', side_effect=AssertionError('gallery history used')):
            with mock.patch.object(
                    app, 'start_gallery_index_rebuild_background',
                    side_effect=AssertionError('gallery index rebuild used')):
                response = self.client.post('/api/canvas/export_merged', json=self.body())
        self.assertEqual(response.status_code, 200, response.json)
        result = response.json
        self.assertEqual(result['side'], 'back')
        self.assertEqual(list(self.gallery.rglob('*.png')), [])
        export_file, _ = resolve_daki_image_reference(
            result['path'], None,
            project_exports_root=self.imports / 'project_exports',
        )
        self.assertTrue(Path(export_file).is_file())

        served = self.client.get(result['src'])
        self.assertEqual(served.status_code, 200)
        from urllib.parse import unquote
        disposition = unquote(served.headers['Content-Disposition'])
        served_data = served.data
        served.close()
        self.assertIn(result['name'], disposition)
        self.assertTrue(disposition.startswith('inline;'))
        with Image.open(io.BytesIO(served_data)) as image:
            self.assertEqual(image.mode, 'RGBA')
            self.assertEqual(image.getpixel((0, 0)), (17, 43, 91, 127))
        preview = self.client.get(result['src'] + '?preview=256')
        self.assertEqual(preview.status_code, 200)
        self.assertTrue(preview.data)
        preview.close()
        self.assertEqual(app.read_canvas_image_bytes(result['src']), Path(export_file).read_bytes())
        prompt = self.client.post('/api/prompt_info', json={'path': result['path']})
        self.assertEqual(prompt.json['status'], 'success')
        self.assertEqual(prompt.json['data']['basePrompt'], 'synthetic ink')

        project = self.client.get('/api/daki/projects/' + self.project['id']).json['project']
        candidate = project['candidates']['back'][0]
        self.assertEqual(candidate['path'], result['path'])
        self.assertEqual(candidate['src'], result['src'])
        self.assertEqual(candidate['name'], result['name'])
        self.assertFalse(candidate['missing'])

        self.assertEqual(app.cleanup_unreferenced_canvas_imports([], []), 0)
        relative = result['path'].removeprefix('__daki_exports__/')
        cleanup_ref = 'project_exports/' + relative
        self.assertEqual(app.cleanup_canvas_import_refs([cleanup_ref], []), 0)
        self.assertEqual(app.cleanup_canvas_import_session('project_exports', self.project['id']), 0)
        self.assertTrue(Path(export_file).is_file())

    def test_project_route_maps_invalid_targets_and_rolls_back_storage_failure(self):
        for changes, status in (
            ({'projectId': '../' + _PROJECT_ID}, 400),
            ({'canvasId': 'missing'}, 400),
            ({'projectId': 'd' * 32}, 404),
            ({'canvasId': 'd' * 32}, 404),
            ({'promptInfo': []}, 400),
            ({'destination': 'other'}, 400),
        ):
            with self.subTest(changes=changes):
                response = self.client.post(
                    '/api/canvas/export_merged', json={**self.body(), **changes},
                )
                self.assertEqual(response.status_code, status, response.json)

        with mock.patch.object(
                app.DAKI_PROJECTS, 'add_candidate', side_effect=OSError('synthetic persistence failure')):
            response = self.client.post(
                '/api/canvas/export_merged', json=self.body((1, 2, 3, 4)),
            )
        self.assertEqual(response.status_code, 500)
        self.assertEqual(list((self.imports / 'project_exports' / self.project['id']).glob('*')), [])
        self.assertEqual(app.DAKI_PROJECTS.get_project(self.project['id'])['candidates']['back'], [])


if __name__ == '__main__':
    unittest.main()
