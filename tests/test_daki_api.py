from datetime import datetime, timezone
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from flask import Flask
from PIL import Image

from naim.daki_image_refs import resolve_daki_image_reference
from naim.images.canvas_export import project_export_image_path
from naim.web.daki import register_daki_routes
from tests.test_daki_projects import gallery_resolver


class DakiApiTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.gallery = self.root / 'gallery'
        self.gallery.mkdir()
        self.path = self.root / 'daki_projects.json'
        self.source = self.gallery / 'sample 한글.png'
        Image.new('RGB', (4, 8)).save(self.source)
        self.aliases = {}
        self.resolver = gallery_resolver(self.gallery, self.aliases)
        self.app = Flask(__name__)
        self.app.config['TESTING'] = True
        self.store = register_daki_routes(self.app, lambda: self.path, self.resolver)
        self.client = self.app.test_client()

    def test_library_creation_add_remove_and_persisted_public_fields(self):
        self.assertEqual(self.client.get('/api/daki/settings').json, {'status': 'success', 'enabled': True})
        self.assertEqual(self.client.get('/api/daki/projects').json, {'status': 'success', 'projects': []})
        created = self.client.post('/api/daki/projects', json={'name': 'API project'})
        self.assertEqual(created.status_code, 201)
        project_id = created.json['project']['id']
        path = f'/api/daki/projects/{project_id}'
        added = self.client.post(path + '/candidates', json={'path': self.source.name, 'side': 'back'})
        self.assertEqual(added.status_code, 200)
        candidate = added.json['project']['candidates']['back'][0]
        self.assertFalse(candidate['missing'])
        self.assertEqual(candidate['src'], '/image/sample%20%ED%95%9C%EA%B8%80.png')
        saved = json.loads(self.path.read_text(encoding='utf-8'))['projects'][0]['candidates']['back'][0]
        self.assertEqual(set(saved), {'id', 'path', 'added_at'})
        self.assertEqual(self.client.get(path).json, added.json)
        self.assertEqual(len(self.client.get('/api/daki/projects').json['projects']), 1)
        original = self.source.read_bytes()
        removed = self.client.delete(path + '/candidates/' + candidate['id'])
        self.assertEqual(removed.status_code, 200)
        self.assertEqual(removed.json['project']['candidates']['back'], [])
        self.assertEqual(self.source.read_bytes(), original)

    def test_candidate_dates_come_from_original_file_and_are_not_persisted(self):
        project = self.store.create_project('File dates', self.source.name, 'front')
        canvas = self.store.create_canvas(project['id'], {
            'id': 'a' * 32,
            'name': 'Date canvas',
            'side': 'front',
            'state': {'width': 12, 'height': 14, 'layers': []},
        })
        source_mtime = datetime(2022, 3, 4, 5, 6, 7, 123000, tzinfo=timezone.utc).timestamp()
        os.utime(self.source, (source_mtime, source_mtime))
        expected_mtime = os.stat(self.source).st_mtime
        creation_time = datetime(2020, 1, 2, 3, 4, 5, 678000, tzinfo=timezone.utc).timestamp()
        original_json = self.path.read_bytes()
        expected_created = '2020-01-02T03:04:05.678+00:00'
        expected_updated = datetime.fromtimestamp(
            expected_mtime, timezone.utc,
        ).isoformat(timespec='milliseconds')

        with mock.patch('naim.web.daki.get_file_creation_time', return_value=creation_time) as get_creation_time:
            project_response = self.client.get(f"/api/daki/projects/{project['id']}")
            list_response = self.client.get('/api/daki/projects')

        self.assertEqual(project_response.status_code, 200)
        self.assertEqual(list_response.status_code, 200)
        candidate = project_response.json['project']['candidates']['front'][0]
        listed_candidate = list_response.json['projects'][0]['candidates']['front'][0]
        for response_candidate in (candidate, listed_candidate):
            self.assertEqual(response_candidate['created_at'], expected_created)
            self.assertEqual(response_candidate['updated_at'], expected_updated)
            self.assertEqual(response_candidate['added_at'], project['candidates']['front'][0]['added_at'])
        self.assertEqual(get_creation_time.call_count, 2)
        for call in get_creation_time.call_args_list:
            self.assertEqual(call.args, (str(self.source.resolve()), expected_mtime))
        self.assertEqual(self.path.read_bytes(), original_json)
        saved_candidate = json.loads(original_json)['projects'][0]['candidates']['front'][0]
        self.assertEqual(set(saved_candidate), {'id', 'path', 'added_at'})

        canvas_summary = project_response.json['project']['canvases']['front'][0]
        persisted_canvas = self.store.get_canvas(project['id'], canvas['id'])
        self.assertEqual(canvas_summary['created_at'], persisted_canvas['created_at'])
        self.assertEqual(canvas_summary['updated_at'], persisted_canvas['updated_at'])

    def test_original_dimensions_are_cached_refreshed_and_never_saved(self):
        project = self.store.create_project('Dimensions', self.source.name, 'front')
        project_url = f"/api/daki/projects/{project['id']}"
        saved = self.path.read_bytes()
        original = self.source.read_bytes()
        from naim.images.dimensions import get_display_image_dimensions
        with mock.patch('naim.web.daki.get_display_image_dimensions', wraps=get_display_image_dimensions) as opened:
            self.assertEqual(self.client.get('/api/daki/projects').status_code, 200)
            opened.assert_not_called()
            for _ in range(2):
                candidate = self.client.get(project_url).json['project']['candidates']['front'][0]
                self.assertEqual((candidate['width'], candidate['height']), (4, 8))
            self.assertEqual(opened.call_count, 1)
        self.assertEqual(self.source.read_bytes(), original)
        Image.new('RGB', (12, 24)).save(self.source)
        candidate = self.client.get(project_url).json['project']['candidates']['front'][0]
        self.assertEqual((candidate['width'], candidate['height']), (12, 24))
        self.assertEqual(self.path.read_bytes(), saved)

    def test_display_dimensions_follow_exif_and_corrupt_images_do_not_break_project(self):
        rotated = self.gallery / 'rotated.jpg'
        exif = Image.Exif()
        exif[274] = 6
        Image.new('RGB', (12, 24)).save(rotated, exif=exif)
        project = self.store.create_project('Rotated', rotated.name, 'back')
        project_url = f"/api/daki/projects/{project['id']}"
        candidate = self.client.get(project_url).json['project']['candidates']['back'][0]
        self.assertEqual((candidate['width'], candidate['height']), (24, 12))
        rotated.write_bytes(b'broken synthetic image')
        response = self.client.get(project_url)
        self.assertEqual(response.status_code, 200)
        candidate = response.json['project']['candidates']['back'][0]
        self.assertIsNone(candidate['width'])
        self.assertIsNone(candidate['height'])
        self.assertFalse(candidate['missing'])

    def test_context_creation_requires_valid_image_and_side_without_orphan(self):
        for data, expected in (
            ({'name': 'Failed', 'path': 'missing.png', 'side': 'front'}, 404),
            ({'name': 'Failed', 'path': self.source.name}, 400),
            ({'name': 'Failed', 'path': self.source.name, 'side': 'other'}, 400),
            ({'name': ' ', 'path': self.source.name, 'side': 'front'}, 400),
            ({'name': 'Failed', 'path': '../outside.png', 'side': 'front'}, 400),
        ):
            with self.subTest(data=data):
                self.assertEqual(self.client.post('/api/daki/projects', json=data).status_code, expected)
                self.assertEqual(self.store.list_projects(), [])
        response = self.client.post('/api/daki/projects', json={
            'name': 'Created', 'path': self.source.name, 'side': 'front',
        })
        self.assertEqual(response.status_code, 201)
        self.assertEqual(len(response.json['project']['candidates']['front']), 1)

    def test_disabled_settings_preserve_projects_and_reference_warnings(self):
        project = self.store.create_project('Referenced', self.source.name, 'front')
        response = self.client.put('/api/daki/settings', json={'enabled': False})
        self.assertEqual(response.json, {'status': 'success', 'enabled': False})
        self.assertEqual(self.client.get('/api/daki/settings').json, response.json)
        references = self.client.post('/api/daki/references', json={'paths': [self.source.name]}).json
        self.assertEqual(references['references'], [{
            'project_id': project['id'], 'project_name': 'Referenced',
            'side': 'front', 'path': self.source.name,
        }])
        self.assertEqual(len(self.client.get('/api/daki/projects').json['projects']), 1)
        self.client.put('/api/daki/settings', json={'enabled': True})
        self.assertEqual(self.store.get_project(project['id']), project)

    def test_missing_candidate_stays_visible_and_webp_alias_is_renderable(self):
        project = self.store.create_project('Original', self.source.name, 'front')
        project_url = '/api/daki/projects/' + project['id']
        self.source.unlink()
        candidate = self.client.get(project_url).json['project']['candidates']['front'][0]
        self.assertTrue(candidate['missing'])
        self.assertEqual(candidate['path'], self.source.name)
        self.assertIsNone(candidate['width'])
        self.assertIsNone(candidate['height'])
        self.assertIsNone(candidate['created_at'])
        self.assertIsNone(candidate['updated_at'])
        self.assertTrue(candidate['added_at'])
        converted = self.source.with_suffix('.webp')
        Image.new('RGB', (4, 8)).save(converted)
        self.aliases[self.source.name] = converted.name
        saved = json.loads(self.path.read_text(encoding='utf-8'))
        stored_candidate = saved['projects'][0]['candidates']['front'][0]
        stored_candidate['name'] = 'Custom render.PNG'
        self.path.write_text(json.dumps(saved), encoding='utf-8')
        candidate_id = stored_candidate['id']
        converted_mtime = datetime(2023, 6, 7, 8, 9, 10, 456000, tzinfo=timezone.utc).timestamp()
        os.utime(converted, (converted_mtime, converted_mtime))
        actual_mtime = os.stat(converted).st_mtime
        creation_time = datetime(2021, 2, 3, 4, 5, 6, 789000, tzinfo=timezone.utc).timestamp()
        with mock.patch('naim.web.daki.get_file_creation_time', return_value=creation_time) as get_creation_time:
            candidate = self.client.get(project_url).json['project']['candidates']['front'][0]
        self.assertFalse(candidate['missing'])
        self.assertEqual(candidate['path'], converted.name)
        self.assertEqual(candidate['id'], candidate_id)
        self.assertEqual(candidate['name'], 'Custom render.webp')
        self.assertTrue(candidate['src'].endswith('.webp'))
        self.assertEqual((candidate['width'], candidate['height']), (4, 8))
        self.assertEqual(candidate['created_at'], '2021-02-03T04:05:06.789+00:00')
        self.assertEqual(candidate['updated_at'], datetime.fromtimestamp(
            actual_mtime, timezone.utc,
        ).isoformat(timespec='milliseconds'))
        get_creation_time.assert_called_once_with(str(converted.resolve()), actual_mtime)
        references = self.client.post('/api/daki/references', json={'paths': [converted.name]}).json['references']
        self.assertEqual(len(references), 1)
        saved_candidate = json.loads(self.path.read_text(encoding='utf-8'))['projects'][0]['candidates']['front'][0]
        self.assertEqual(saved_candidate['path'], self.source.name)
        self.assertEqual(saved_candidate['name'], 'Custom render.PNG')
        self.assertEqual(saved_candidate['id'], candidate_id)

        for saved_name in ('Custom render.webp', 'Custom render', '12'):
            with self.subTest(saved_name=saved_name):
                saved = json.loads(self.path.read_text(encoding='utf-8'))
                saved['projects'][0]['candidates']['front'][0]['name'] = saved_name
                self.path.write_text(json.dumps(saved), encoding='utf-8')
                original_json = self.path.read_bytes()
                candidate = self.client.get(project_url).json['project']['candidates']['front'][0]
                self.assertEqual(candidate['name'], saved_name)
                self.assertEqual(candidate['path'], converted.name)
                self.assertEqual(self.path.read_bytes(), original_json)

        for saved_name in ('Custom render.jpg', 'Custom render.jpeg'):
            with self.subTest(saved_name=saved_name):
                saved = json.loads(self.path.read_text(encoding='utf-8'))
                saved['projects'][0]['candidates']['front'][0]['name'] = saved_name
                self.path.write_text(json.dumps(saved), encoding='utf-8')
                original_json = self.path.read_bytes()
                candidate = self.client.get(project_url).json['project']['candidates']['front'][0]
                self.assertEqual(candidate['name'], os.path.splitext(saved_name)[0] + '.webp')
                self.assertEqual(self.path.read_bytes(), original_json)

    def test_explicit_export_webp_is_selected_when_png_and_webp_both_exist(self):
        export_root = self.root / 'project-exports'
        project_id = 'a' * 32
        export_id = 'b' * 32
        png_path = Path(project_export_image_path(export_root, project_id, export_id))
        png_path.parent.mkdir(parents=True, exist_ok=True)
        Image.new('RGB', (4, 8), (10, 20, 30)).save(png_path)
        webp_path = png_path.with_suffix('.webp')
        Image.new('RGB', (9, 7), (30, 20, 10)).save(webp_path, format='WEBP')

        def resolve_image(relative):
            resolved = resolve_daki_image_reference(
                relative, None, project_exports_root=export_root,
            )
            return resolved if resolved is not None else self.resolver(relative)

        app = Flask(__name__)
        app.config['TESTING'] = True
        store = register_daki_routes(app, lambda: self.path, resolve_image)
        client = app.test_client()
        project = store.create_project('Both formats')
        webp_relative = f'__daki_exports__/{project_id}/{export_id}.webp'
        project = store.add_candidate(project['id'], webp_relative, 'front')

        response = client.get(f"/api/daki/projects/{project['id']}")

        self.assertEqual(response.status_code, 200)
        candidate = response.json['project']['candidates']['front'][0]
        self.assertEqual(candidate['path'], webp_relative)
        self.assertTrue(candidate['src'].endswith('.webp'))
        self.assertEqual((candidate['width'], candidate['height']), (9, 7))
        self.assertTrue(png_path.exists())
        self.assertTrue(webp_path.exists())

    def test_timestamp_failures_keep_candidate_with_null_dates(self):
        project = self.store.create_project('Timestamp failure', self.source.name, 'front')
        project_url = f"/api/daki/projects/{project['id']}"

        with mock.patch('naim.web.daki.get_file_creation_time', side_effect=OSError('unreadable timestamp')):
            response = self.client.get(project_url)
        self.assertEqual(response.status_code, 200)
        candidate = response.json['project']['candidates']['front'][0]
        self.assertEqual(candidate['id'], project['candidates']['front'][0]['id'])
        self.assertFalse(candidate['missing'])
        self.assertIsNone(candidate['created_at'])
        self.assertIsNone(candidate['updated_at'])

        with mock.patch('naim.web.daki.get_file_creation_time', return_value=float('inf')):
            response = self.client.get(project_url)
        self.assertEqual(response.status_code, 200)
        candidate = response.json['project']['candidates']['front'][0]
        self.assertEqual(candidate['id'], project['candidates']['front'][0]['id'])
        self.assertIsNone(candidate['created_at'])
        self.assertIsNone(candidate['updated_at'])

    def test_stat_failure_keeps_candidate_with_null_dates(self):
        project = self.store.create_project('Stat failure', self.source.name, 'front')
        project_url = f"/api/daki/projects/{project['id']}"
        self.store.resolve_source = lambda relative: (str(self.source), self.source.name)
        real_stat = os.stat
        source_path = str(self.source.resolve())

        def fail_for_source(path, *args, **kwargs):
            if os.path.abspath(os.fspath(path)) == source_path:
                raise OSError('synthetic stat failure')
            return real_stat(path, *args, **kwargs)

        with mock.patch('naim.web.daki.os.stat', side_effect=fail_for_source):
            response = self.client.get(project_url)

        self.assertEqual(response.status_code, 200)
        candidate = response.json['project']['candidates']['front'][0]
        self.assertEqual(candidate['id'], project['candidates']['front'][0]['id'])
        self.assertTrue(candidate['missing'])
        self.assertIsNone(candidate['created_at'])
        self.assertIsNone(candidate['updated_at'])

    def test_malformed_json_unknown_records_and_storage_failure(self):
        for value in ([], None, 'bad', 123):
            self.assertEqual(self.client.post('/api/daki/projects', json=value).status_code, 400)
        self.assertEqual(self.client.post('/api/daki/projects', data='{', content_type='application/json').status_code, 400)
        self.assertEqual(self.client.get('/api/daki/projects/missing').status_code, 404)
        self.assertEqual(self.client.delete('/api/daki/projects/missing/candidates/missing').status_code, 404)
        self.assertEqual(self.client.put('/api/daki/settings', json={'enabled': 'false'}).status_code, 400)
        self.assertEqual(self.client.post('/api/daki/references', json={'paths': 'bad'}).status_code, 400)
        with mock.patch('naim.storage.daki_projects.write_json', side_effect=OSError('private path')):
            response = self.client.post('/api/daki/projects', json={'name': 'Failed'})
        self.assertEqual(response.status_code, 500)
        self.assertNotIn('private path', response.json['message'])
        self.assertEqual(self.store.list_projects(), [])

    def test_store_path_provider_is_evaluated_per_request(self):
        self.client.post('/api/daki/projects', json={'name': 'First store'})
        first_path = self.path
        self.path = self.root / 'second.json'
        self.assertEqual(self.client.get('/api/daki/projects').json['projects'], [])
        self.client.post('/api/daki/projects', json={'name': 'Second store'})
        self.assertEqual(json.loads(first_path.read_text(encoding='utf-8'))['projects'][0]['name'], 'First store')
        self.assertEqual(json.loads(self.path.read_text(encoding='utf-8'))['projects'][0]['name'], 'Second store')


if __name__ == '__main__':
    unittest.main()
