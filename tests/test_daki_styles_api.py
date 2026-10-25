import copy
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

from flask import Flask
from PIL import Image

from naim.storage.daki_projects import DakiNotFoundError
from naim.storage.daki_personal_styles import DakiPersonalStyles
from naim.web.daki_personal_styles import register_daki_personal_style_routes
from naim.web.daki_styles import register_daki_style_routes
from tests.test_daki_style_tests import synthetic_styles, synthetic_request, synthetic_upper_source


class DakiStylesApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.preview = self.root / 'synthetic-preview.png'
        Image.new('RGB', (64, 128), 'white').save(self.preview)
        self.styles = synthetic_styles(2)
        self.catalog = mock.Mock()
        self.catalog.list_styles.side_effect = lambda: copy.deepcopy(self.styles)
        self.catalog.get_style.side_effect = lambda style_id: copy.deepcopy(next(style for style in self.styles if style['id'] == style_id))
        self.catalog.preview_path.return_value = self.preview
        self.app = Flask(__name__)
        self.key = 'synthetic-key'
        self.personal = DakiPersonalStyles(lambda: self.root / 'personal',
            lambda reference: (self.preview, reference), lambda path: {})
        register_daki_personal_style_routes(self.app, self.personal)
        with mock.patch('naim.web.daki_styles.DakiSharedStyles', return_value=self.catalog):
            self.manager = register_daki_style_routes(self.app, lambda: self.root, lambda: self.root / 'tests',
                                                      lambda: self.key, personal_catalog=self.personal)
        self.manager.generator = mock.Mock(side_effect=lambda key, payload: Image.new('RGB',
            (payload['parameters']['width'], payload['parameters']['height']), 'blue'))
        self.addCleanup(lambda: self.manager.wait(5))
        self.client = self.app.test_client()

    def create(self):
        result = self.client.post('/api/daki/style-tests', json=synthetic_request())
        self.assertEqual(result.status_code, 201, result.json)
        return result.json['batch']

    def test_target_filter_reuses_import_query_and_exclusions_without_writes(self):
        self.styles = synthetic_styles(4)
        for style, prompt in zip(self.styles, ('watercolor, blue hair', 'watercolor, monochrome',
                                               'sketch, realistic', 'oil painting')):
            style['positive'] = prompt
        endpoint = '/api/daki/style-tests/targets/filter'
        response = self.client.post(endpoint, json={'include_query': 'watercolor || sketch',
                                                   'exclude_tags': ['monochrome']})
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(response.json['style_ids'], ['style-0', 'style-2'])
        response = self.client.post(endpoint, json={'include_query': 'watercolor, %hair%'})
        self.assertEqual(response.json['style_ids'], ['style-0'])
        self.assertEqual(len(self.client.post(endpoint, json={}).json['style_ids']), 4)
        self.assertEqual(self.client.post(endpoint, json={'include_query': 'absent'}).json['style_ids'], [])
        self.assertFalse((self.root / 'tests').exists())
        self.manager.generator.assert_not_called()

    def test_target_filter_is_library_scoped_and_validates_inputs(self):
        endpoint = '/api/daki/style-tests/targets/filter'
        with mock.patch.object(self.personal, 'list_styles', return_value=[
                {'id': 'personal_synthetic', 'positive': 'watercolor'}]):
            response = self.client.post(endpoint, json={'library': 'personal', 'include_query': 'watercolor'})
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(response.json['style_ids'], ['personal_synthetic'])
        for data in ({'library': 'unknown'}, {'include_query': None}, {'exclude_tags': 'ink'},
                     {'exclude_tags': ['x' * 201]}, {'include_query': 'x' * 20001}):
            with self.subTest(data=data):
                self.assertEqual(self.client.post(endpoint, json=data).status_code, 400)

    def test_styles_list_is_lightweight_and_details_keep_options(self):
        self.styles[0]['sort_date'] = '2026-01-02T00:00:00+00:00'
        result = self.client.get('/api/daki/shared-styles')
        self.assertEqual(result.status_code, 200)
        self.assertTrue(result.json['configured'])
        item = result.json['styles'][0]
        self.assertEqual(item['sort_date'], '2026-01-02T00:00:00+00:00')
        self.assertNotIn('positive', item)
        self.assertNotIn('options', item)
        self.assertEqual(item['src'], '/api/daki/shared-styles/style-0/preview')
        detail = self.client.get('/api/daki/shared-styles/style-0').json['style']
        self.assertEqual(detail['options']['cfg_rescale'], 0)
        response = self.client.get(item['src'] + '?full=1')
        self.assertEqual(response.status_code, 200)
        response.close()
        self.catalog.preview_path.assert_called_once_with('style-0', full=True)
        self.assertNotIn(self.key, result.get_data(as_text=True))

    def test_shared_and_existing_test_responses_include_collected_article_fields(self):
        self.styles[0].update(source_url='https://arca.live/b/aiart/123', recommendation_count=12,
                              recommendation_collected_at='2026-01-01')
        listing = self.client.get('/api/daki/shared-styles').json['styles']
        self.assertEqual(listing[0]['recommendation_count'], 12)
        self.assertEqual(listing[0]['recommendation_collected_at'], '2026-01-01')
        self.assertIsNone(listing[1]['recommendation_count'])
        batch = self.create()
        response = self.client.get('/api/daki/style-tests/' + batch['id']).json['batch']
        self.assertEqual(response['items'][0]['source_url'], 'https://arca.live/b/aiart/123')
        self.assertEqual(response['items'][0]['recommendation_count'], 12)

    def test_canvas_can_opt_in_to_prompt_catalog_without_generation_options(self):
        result = self.client.get('/api/daki/shared-styles?include_prompts=1')
        self.assertEqual(result.status_code, 200)
        item = result.json['styles'][0]
        self.assertEqual(item['positive'], self.styles[0]['positive'])
        self.assertEqual(item['negative'], self.styles[0]['negative'])
        self.assertNotIn('options', item)
        self.assertNotIn('positive', self.client.get('/api/daki/shared-styles?include_prompts=0').json['styles'][0])
        self.manager.generator.assert_not_called()

    def test_batch_api_creates_separately_runs_and_serves_persistent_results(self):
        batch = self.create()
        self.manager.generator.assert_not_called()
        result = self.client.post(f"/api/daki/style-tests/{batch['id']}/run", json={'mode': 'next'})
        self.assertEqual(result.status_code, 200, result.json)
        self.assertTrue(self.manager.wait())
        current = self.client.get(f"/api/daki/style-tests/{batch['id']}").json['batch']
        self.assertEqual(current['completed'], 1)
        for suffix, mimetype in (('', 'image/jpeg'), ('?full=1', 'image/png')):
            response = self.client.get(current['items'][0]['src'] + suffix)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.mimetype, mimetype)
            response.close()
        listing = self.client.get('/api/daki/style-tests').json['batches']
        self.assertEqual(len(listing), 1)
        self.assertNotIn('items', listing[0])
        self.assertEqual(listing[0]['completed'], 1)

    def test_upper_legacy_api_imports_persistent_exact_results_and_serves_catalog_previews(self):
        thumbnail = self.root / 'synthetic-thumbnail.webp'
        Image.new('RGB', (32, 64), 'white').save(thumbnail, format='WEBP')
        self.catalog.preview_path.side_effect = lambda style_id, full=False: self.preview if full else thumbnail
        source = synthetic_upper_source(self.styles[:1])
        source['entries'][0]['output_format'] = 'png'
        self.catalog.upper_test_source.return_value = source

        response = self.client.post('/api/daki/style-tests/upper')
        self.assertEqual(response.status_code, 200, response.json)
        batch = response.json['batch']
        self.assertEqual((batch['id'], batch['name'], batch['origin'], batch['library']),
                         ('d79b7ac88db758808a2cf316913635a6', '상반신', 'shared_upper', 'shared'))
        self.assertEqual((batch['completed'], batch['pending'], batch['output_format']), (1, 0, 'webp'))
        self.assertEqual(batch['items'][0]['output_format'], 'png')
        self.manager.generator.assert_not_called()
        stored = self.root / 'tests' / batch['id'] / 'batch.json'
        before = stored.read_bytes()
        persisted = json.loads(before)
        self.assertEqual(persisted['items'][0]['payload'], source['entries'][0]['payload'])
        self.assertTrue(persisted['items'][0]['legacy_preview'])

        for suffix, expected, mimetype in (('', thumbnail, 'image/webp'),
                                            ('?full=1', self.preview, 'image/png')):
            image = self.client.get(batch['items'][0]['src'] + suffix)
            self.assertEqual(image.status_code, 200)
            self.assertEqual(image.mimetype, mimetype)
            self.assertEqual(image.data, expected.read_bytes())
            image.close()
        self.assertEqual(self.client.get('/api/daki/style-tests').json['batches'][0]['origin'], 'shared_upper')

        repeated = self.client.post('/api/daki/style-tests/upper')
        self.assertEqual(repeated.status_code, 200, repeated.json)
        self.assertEqual(repeated.json['batch']['id'], batch['id'])
        self.assertEqual(stored.read_bytes(), before)
        self.catalog.upper_test_source.assert_called_once_with()
        self.manager.generator.assert_not_called()

    def test_upper_legacy_api_append_and_edit_settings_keep_imported_payload(self):
        self.catalog.upper_test_source.return_value = synthetic_upper_source(self.styles[:1])
        batch = self.client.post('/api/daki/style-tests/upper').json['batch']
        original_payload = json.loads((self.root / 'tests' / batch['id'] / 'batch.json').read_text('utf-8'))['items'][0]['payload']

        appended = self.client.post('/api/daki/style-tests/' + batch['id'] + '/styles',
                                    json={'style_ids': ['style-1']})
        self.assertEqual(appended.status_code, 200, appended.json)
        self.assertEqual((appended.json['batch']['total'], appended.json['batch']['completed'],
                          appended.json['batch']['pending']), (2, 1, 1))
        changed = self.client.post('/api/daki/style-tests/' + batch['id'] + '/settings', json=synthetic_request(
            model='nai-diffusion-5-full', prompt='updated scene', width=128, height=128))
        self.assertEqual(changed.status_code, 200, changed.json)
        self.assertEqual((changed.json['batch']['items'][1]['width'], changed.json['batch']['items'][1]['height']),
                         (128, 128))
        self.assertEqual(changed.json['batch']['items'][0]['status'], 'completed')
        stored = json.loads((self.root / 'tests' / batch['id'] / 'batch.json').read_text('utf-8'))
        self.assertEqual(stored['items'][0]['payload'], original_payload)
        self.manager.generator.assert_not_called()

    def test_upper_legacy_api_source_errors_do_not_create_batch_or_generate(self):
        batch_id = 'd79b7ac88db758808a2cf316913635a6'
        target = self.root / 'tests' / batch_id
        for result, status in ((FileNotFoundError('synthetic missing source'), 404),
                               ({'request': synthetic_request(), 'entries': [{'style': {}, 'payload': {}}]}, 400)):
            with self.subTest(status=status):
                self.catalog.upper_test_source.reset_mock()
                if isinstance(result, Exception):
                    self.catalog.upper_test_source.side_effect = result
                else:
                    self.catalog.upper_test_source.side_effect = None
                    self.catalog.upper_test_source.return_value = result
                response = self.client.post('/api/daki/style-tests/upper')
                self.assertEqual(response.status_code, status, response.json)
                self.assertFalse(target.exists())
        self.manager.generator.assert_not_called()

    def test_batch_api_creates_and_generates_only_selected_shared_styles_in_input_order(self):
        self.styles = synthetic_styles(3)
        response = self.client.post('/api/daki/style-tests', json=synthetic_request(
            name='Selected styles', style_ids=['style-2', 'style-0', 'style-2']))
        self.assertEqual(response.status_code, 201, response.json)
        batch = response.json['batch']
        self.assertEqual([item['style_id'] for item in batch['items']], ['style-2', 'style-0'])
        self.assertEqual((batch['total'], batch['pending'], batch['library']), (2, 2, 'shared'))
        self.manager.generator.assert_not_called()
        self.catalog.get_style.assert_not_called()
        path = '/api/daki/style-tests/' + batch['id']
        self.assertEqual(self.client.post(path + '/run', json={'mode': 'remaining'}).status_code, 200)
        self.assertTrue(self.manager.wait())
        self.assertEqual(self.client.get(path).json['batch']['completed'], 2)
        self.assertEqual(self.manager.generator.call_count, 2)
        self.assertEqual([call.args[1]['input'].split(', ')[0] for call in self.manager.generator.call_args_list],
                         [self.styles[2]['positive'], self.styles[0]['positive']])

    def test_batch_api_rejects_invalid_or_removed_selections_without_writing_a_batch(self):
        removed = self.styles.pop()
        self.catalog.get_style.side_effect = None
        self.catalog.get_style.return_value = removed
        for ids in (None, [], 'style-0', [None], ['../invalid'], ['style-0', 'unknown'],
                    ['style-0', removed['id']]):
            with self.subTest(ids=ids):
                response = self.client.post('/api/daki/style-tests', json=synthetic_request(style_ids=ids))
                self.assertEqual(response.status_code, 400, response.json)
                self.assertFalse((self.root / 'tests').exists())
        self.catalog.get_style.assert_not_called()
        self.manager.generator.assert_not_called()

    def test_generation_options_expose_naia_presets_without_loading_catalog(self):
        response = self.client.get('/api/daki/style-tests/options')
        self.assertEqual(response.status_code, 200, response.json)
        self.assertTrue(response.json['configured'])
        self.assertEqual([band['label'] for band in response.json['size_presets']], ['Small', 'Normal', 'Large', 'Wallpaper', 'Daki'])
        self.assertEqual(sum(len(band['sizes']) for band in response.json['size_presets']), 35)
        groups = {band['id']: band['sizes'] for band in response.json['size_presets']}
        self.assertIn([1472, 1472], groups['wallpaper'])
        self.assertEqual(groups['daki'], [[320, 1024], [512, 1664], [640, 2048], [960, 3072], [1024, 3072]])
        self.assertEqual(response.json['size_limits'], {'min': 64, 'max': 49152, 'step': 64, 'max_pixels': 3145728})
        self.catalog.list_styles.assert_not_called()
        self.assertNotIn(self.key, response.get_data(as_text=True))
        self.key = ''
        self.assertFalse(self.client.get('/api/daki/style-tests/options').json['configured'])

    def test_maximum_generation_area_is_shared_by_models_and_excess_is_rejected(self):
        for model in ('nai-diffusion-5-full', 'nai-diffusion-5-full-medium', 'nai-diffusion-4-5-full'):
            with self.subTest(model=model):
                response = self.client.post('/api/daki/style-tests', json=synthetic_request(
                    model=model, width=1024, height=3072))
                self.assertEqual(response.status_code, 201, response.json)
                self.assertEqual(response.json['batch']['paid_count'], len(self.styles))
                excess = self.client.post('/api/daki/style-tests', json=synthetic_request(
                    model=model, width=1088, height=3072))
                self.assertEqual(excess.status_code, 400, excess.json)
                self.assertIn('3,145,728', excess.json['message'])
        self.manager.generator.assert_not_called()

    def create_personal(self):
        response = self.client.post('/api/daki/personal-styles', json={
            'name': 'Synthetic personal ink', 'positive': 'ink', 'negative': 'blur',
            'preview': {'width': 64, 'height': 128}})
        self.assertEqual(response.status_code, 201, response.json)
        return response.json['style']

    def test_personal_catalog_creates_named_batch_without_using_shared_styles(self):
        style = self.create_personal()
        response = self.client.post('/api/daki/style-tests', json=synthetic_request(
            library='personal', name='Named personal test'))
        self.assertEqual(response.status_code, 201, response.json)
        batch = response.json['batch']
        self.assertEqual((batch['name'], batch['library'], batch['total']), ('Named personal test', 'personal', 1))
        self.assertEqual(batch['items'][0]['style_id'], style['id'])
        self.catalog.list_styles.assert_not_called()
        path = '/api/daki/style-tests/' + batch['id']
        self.assertEqual(self.client.put(path + '/name', json={'name': 'Renamed gallery'}).status_code, 200)
        self.assertEqual(self.client.post(path + '/run', json={'mode': 'remaining'}).status_code, 200)
        self.assertTrue(self.manager.wait())
        generated = self.client.get(path).json['batch']
        self.assertEqual(generated['completed'], 1)
        self.assertEqual(generated['name'], 'Renamed gallery')
        listing = self.client.get('/api/daki/style-tests').json['batches'][0]
        self.assertEqual(listing['cover_src'], generated['items'][0]['src'])
        self.assertEqual(listing['name'], 'Renamed gallery')
        self.assertNotIn('items', listing)
        payload = self.manager.generator.call_args.args[1]
        self.assertTrue(payload['input'].startswith('ink, '))
        self.assertIn('blur', payload['parameters']['negative_prompt'])

    def test_personal_selection_respects_library_boundaries_and_rejects_missing_ids_atomically(self):
        first, second = self.create_personal(), self.create_personal()
        response = self.client.post('/api/daki/style-tests', json=synthetic_request(
            library='personal', style_ids=[second['id'], second['id']]))
        self.assertEqual(response.status_code, 201, response.json)
        batch = response.json['batch']
        self.assertEqual((batch['library'], batch['total']), ('personal', 1))
        self.assertEqual([item['style_id'] for item in batch['items']], [second['id']])
        self.catalog.list_styles.assert_not_called()
        for library, ids in (('personal', ['style-0']), ('shared', [first['id']]),
                             ('personal', [first['id'], 'personal_' + '0' * 32])):
            rejected = self.client.post('/api/daki/style-tests', json=synthetic_request(library=library, style_ids=ids))
            self.assertEqual(rejected.status_code, 400, rejected.json)
            self.assertEqual([item['id'] for item in self.client.get('/api/daki/style-tests').json['batches']], [batch['id']])
        self.manager.generator.assert_not_called()

    def test_new_shared_styles_are_discovered_appended_and_generated_in_an_existing_test(self):
        batch = self.create()
        endpoint = '/api/daki/style-tests/' + batch['id']
        self.assertEqual(self.client.post(endpoint + '/run', json={'mode': 'remaining'}).status_code, 200)
        self.assertTrue(self.manager.wait())
        batch_file = self.root / 'tests' / batch['id'] / 'batch.json'
        before = batch_file.read_bytes()
        originals = {style['id']: self.manager.image_path(batch['id'], style['id'], full=True).read_bytes()
                     for style in self.styles}
        self.styles.append(synthetic_styles(3)[-1])
        updated = self.client.get(endpoint).json['batch']
        self.assertEqual(updated['missing_shared_style_ids'], ['style-2'])
        self.assertEqual(batch_file.read_bytes(), before)
        added = self.client.post(endpoint + '/styles', json={'style_ids': updated['missing_shared_style_ids']})
        self.assertEqual(added.status_code, 200, added.json)
        self.assertEqual((added.json['batch']['completed'], added.json['batch']['pending']), (2, 1))
        self.assertEqual(added.json['batch']['missing_shared_style_ids'], [])
        self.assertEqual(self.manager.generator.call_count, 2)
        self.assertEqual(self.client.post(endpoint + '/run', json={'mode': 'remaining'}).status_code, 200)
        self.assertTrue(self.manager.wait())
        finished = self.client.get(endpoint).json['batch']
        self.assertEqual((finished['completed'], finished['pending']), (3, 0))
        self.assertEqual(self.manager.generator.call_count, 3)
        for style_id, data in originals.items():
            self.assertEqual(self.manager.image_path(batch['id'], style_id, full=True).read_bytes(), data)

    def test_append_personal_to_finished_shared_batch_preserves_images_and_recipe_snapshot(self):
        batch = self.create()
        path = '/api/daki/style-tests/' + batch['id']
        self.assertEqual(self.client.post(path + '/run', json={'mode': 'remaining'}).status_code, 200)
        self.assertTrue(self.manager.wait())
        originals = {item['style_id']: self.manager.image_path(batch['id'], item['style_id'], full=True).read_bytes()
                     for item in self.manager.get(batch['id'])['items']}
        style = self.create_personal()
        response = self.client.post(path + '/styles', json={'style_ids': [style['id'], style['id']]})
        self.assertEqual(response.status_code, 200, response.json)
        appended = response.json['batch']
        self.assertEqual((appended['total'], appended['pending'], appended['completed']), (3, 1, 2))
        self.assertIsNone(appended['items'][-1]['source_src'])
        self.assertEqual(self.client.put('/api/daki/personal-styles/' + style['id'],
                                        json={'positive': 'changed later'}).status_code, 200)
        self.assertEqual(self.client.post(path + '/styles', json={'style_ids': [style['id']]}).json['batch']['total'], 3)
        self.assertEqual(self.client.post(path + '/run', json={'mode': 'remaining'}).status_code, 200)
        self.assertTrue(self.manager.wait())
        self.assertEqual(self.client.get(path).json['batch']['completed'], 3)
        self.assertEqual(self.manager.generator.call_count, 3)
        self.assertTrue(self.manager.generator.call_args.args[1]['input'].startswith('ink, '))
        for sid, content in originals.items():
            self.assertEqual(self.manager.image_path(batch['id'], sid, full=True).read_bytes(), content)

    def test_linked_personal_batch_keeps_representative_preview_url(self):
        style = self.create_personal()
        self.personal.update(style['id'], {'source_path': 'synthetic-preview.png'})
        result = self.client.post('/api/daki/style-tests', json=synthetic_request(library='personal'))
        self.assertEqual(result.status_code, 201, result.json)
        source = result.json['batch']['items'][0]['source_src']
        self.assertEqual(source, '/api/daki/personal-styles/' + style['id'] + '/preview')
        response = self.client.get(source)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, self.preview.read_bytes())
        response.close()

    def test_name_and_append_api_validation_does_not_change_saved_batch(self):
        batch = self.create()
        path = '/api/daki/style-tests/' + batch['id']
        stored = self.root / 'tests' / batch['id'] / 'batch.json'
        before = stored.read_bytes()
        for suffix, method, data in (('/name', 'put', {'name': ''}),
                                     ('/name', 'put', {'name': 'x' * 121}),
                                     ('/styles', 'post', {'style_ids': []}),
                                     ('/styles', 'post', {'style_ids': ['../bad']})):
            response = getattr(self.client, method)(path + suffix, json=data)
            self.assertEqual(response.status_code, 400, response.json)
            self.assertEqual(stored.read_bytes(), before)
        response = self.client.post(path + '/styles', json={'style_ids': ['personal_' + '0' * 32]})
        self.assertEqual(response.status_code, 404, response.json)
        self.assertEqual(stored.read_bytes(), before)

    def test_settings_api_updates_pending_size_and_preserves_existing_result(self):
        batch = self.create()
        path = f"/api/daki/style-tests/{batch['id']}"
        self.assertEqual(self.client.post(path + '/run', json={'mode': 'next'}).status_code, 200)
        self.assertTrue(self.manager.wait())
        first_image = self.manager.image_path(batch['id'], 'style-0', full=True)
        first_bytes = first_image.read_bytes()
        response = self.client.post(path + '/settings', json=synthetic_request(
            model='nai-diffusion-5-full-medium', prompt='updated scene', width=192, height=128))
        self.assertEqual(response.status_code, 200, response.json)
        changed = response.json['batch']
        self.assertEqual((changed['width'], changed['height'], changed['pending']), (192, 128, 1))
        self.assertEqual((changed['items'][0]['model'], changed['items'][0]['width']), ('nai-diffusion-5-full', 64))
        self.assertEqual((changed['items'][1]['model'], changed['items'][1]['width']), ('nai-diffusion-5-full-medium', 192))
        self.assertEqual(self.manager.generator.call_count, 1)
        self.assertEqual(self.client.post(path + '/run', json={'mode': 'remaining'}).status_code, 200)
        self.assertTrue(self.manager.wait())
        with Image.open(self.manager.image_path(batch['id'], 'style-1', full=True)) as image:
            self.assertEqual(image.size, (192, 128))
            self.assertEqual(json.loads(image.info['Comment'])['steps'], 14)
        self.assertEqual(first_image.read_bytes(), first_bytes)
        self.assertEqual(self.client.post(path + '/settings', json=synthetic_request()).status_code, 409)

    def test_settings_api_rejects_invalid_data_and_missing_batches(self):
        batch = self.create()
        path = f"/api/daki/style-tests/{batch['id']}/settings"
        stored = self.root / 'tests' / batch['id'] / 'batch.json'
        before = stored.read_bytes()
        for data in (None, [], {}, synthetic_request(width=128), synthetic_request(width=65, height=128)):
            response = self.client.post(path, json=data)
            self.assertEqual(response.status_code, 400, response.json)
            self.assertEqual(stored.read_bytes(), before)
        self.assertEqual(self.client.post('/api/daki/style-tests/' + '0' * 32 + '/settings', json=synthetic_request()).status_code, 404)
        self.manager.generator.assert_not_called()

    def test_anlas_conflict_is_returned_before_any_generation(self):
        self.styles[0]['options']['steps'] = 40
        batch = self.create()
        result = self.client.post(f"/api/daki/style-tests/{batch['id']}/run", json={'mode': 'remaining'})
        self.assertEqual(result.status_code, 409)
        self.assertEqual(result.json['code'], 'anlas_confirmation')
        self.manager.generator.assert_not_called()
        result = self.client.post(f"/api/daki/style-tests/{batch['id']}/run", json={'mode': 'next', 'allow_anlas': True})
        self.assertEqual(result.status_code, 200)
        self.assertTrue(self.manager.wait())
        self.assertEqual(self.manager.generator.call_count, 1)

    def test_run_api_retries_failed_with_current_key_and_preserves_completed_image(self):
        batch = self.create()
        path = f"/api/daki/style-tests/{batch['id']}"
        self.assertEqual(self.client.post(path + '/run', json={'mode': 'retry_failed'}).status_code, 409)
        self.assertEqual(self.client.post(path + '/run', json={'mode': 'next'}).status_code, 200)
        self.assertTrue(self.manager.wait())
        completed = self.manager.image_path(batch['id'], 'style-0', full=True)
        completed_bytes = completed.read_bytes()
        self.manager.generator.side_effect = ValueError('synthetic failure')
        self.assertEqual(self.client.post(path + '/run', json={'mode': 'remaining'}).status_code, 200)
        self.assertTrue(self.manager.wait())
        self.key = 'synthetic-replacement-key'
        self.manager.generator.side_effect = lambda key, payload: Image.new('RGB', (64, 128), 'green')
        response = self.client.post(path + '/run', json={'mode': 'retry_failed'})
        self.assertEqual(response.status_code, 200, response.json)
        self.assertTrue(self.manager.wait())
        result = self.client.get(path).json['batch']
        self.assertEqual((result['status'], result['completed'], result['failed'], result['pending']), ('completed', 2, 0, 0))
        self.assertEqual(self.manager.generator.call_args.args[0], self.key)
        self.assertEqual(self.manager.generator.call_count, 3)
        self.assertEqual(completed.read_bytes(), completed_bytes)
        self.assertNotIn('error', result['items'][1])

    def test_run_api_rechecks_anlas_consent_for_failed_items(self):
        self.styles[0]['options']['steps'] = 40
        batch = self.create()
        path = f"/api/daki/style-tests/{batch['id']}/run"
        self.manager.generator.side_effect = ValueError('synthetic failure')
        self.assertEqual(self.client.post(path, json={'mode': 'next', 'allow_anlas': True}).status_code, 200)
        self.assertTrue(self.manager.wait())
        stored = self.root / 'tests' / batch['id'] / 'batch.json'
        before = stored.read_bytes()
        response = self.client.post(path, json={'mode': 'retry_failed'})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json['code'], 'anlas_confirmation')
        self.assertEqual(stored.read_bytes(), before)
        self.assertEqual(self.manager.generator.call_count, 1)
        self.manager.generator.side_effect = lambda key, payload: Image.new('RGB', (64, 128), 'green')
        self.assertEqual(self.client.post(path, json={'mode': 'retry_failed', 'allow_anlas': True}).status_code, 200)
        self.assertTrue(self.manager.wait())
        self.assertEqual(self.manager.generator.call_count, 2)
        self.assertEqual(self.manager.get(batch['id'])['pending'], 1)

    def test_stop_is_nonblocking_and_current_result_is_retained(self):
        entered, release = threading.Event(), threading.Event()
        def generate(key, payload):
            entered.set()
            if not release.wait(5):
                raise ValueError('synthetic timeout')
            return Image.new('RGB', (64, 128), 'blue')
        self.manager.generator.side_effect = generate
        batch = self.create()
        path = f"/api/daki/style-tests/{batch['id']}"
        self.client.post(path + '/run', json={'mode': 'remaining'})
        self.assertTrue(entered.wait(5))
        result = self.client.post(path + '/stop')
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json['batch']['status'], 'stopping')
        release.set()
        self.assertTrue(self.manager.wait())
        self.assertEqual(self.client.get(path).json['batch']['completed'], 1)
        self.assertEqual(self.manager.generator.call_count, 1)

    def test_invalid_input_missing_style_and_missing_key(self):
        for data in ([], None, 'text'):
            result = self.client.post('/api/daki/style-tests', json=data)
            self.assertEqual(result.status_code, 400)
        self.catalog.get_style.side_effect = DakiNotFoundError('synthetic missing')
        self.assertEqual(self.client.get('/api/daki/shared-styles/missing').status_code, 404)
        self.assertEqual(self.client.get('/api/daki/style-tests/not-a-batch').status_code, 400)
        batch = self.create()
        self.key = ''
        result = self.client.post(f"/api/daki/style-tests/{batch['id']}/run", json={'mode': 'next'})
        self.assertEqual(result.status_code, 400)
        self.manager.generator.assert_not_called()


class DakiStyleRemovalApiTests(unittest.TestCase):
    """Exercise removal against real storage and immutable batch snapshots."""
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / 'source'
        self.imported = self.root / 'imported'
        self.source.mkdir()
        styles, options, jobs = synthetic_styles(2), {}, {}
        for style in styles:
            sid = style['id']
            style['preview'].update(image=f'{sid}.png', thumbnail=f'{sid}.png', job_id=sid)
            options[sid] = {'source_image_id': style['source_image_id'], 'options': style['options']}
            jobs[sid] = {'status': 'success', 'seed': style['seed']}
            Image.new('RGB', (64, 128), 'white').save(self.source / f'{sid}.png')
        for name, data in (('default_styles.json', {'styles': styles}),
                           ('source_generation_options.json', {'styles': options}),
                           ('generation_manifest.json', {'jobs': jobs})):
            (self.source / name).write_text(json.dumps(data), encoding='utf-8')
        app = Flask(__name__)
        self.manager = register_daki_style_routes(app, lambda: self.source,
            lambda: self.root / 'batches', lambda: 'synthetic-key', lambda: self.imported)
        self.manager.generator = mock.Mock(side_effect=lambda key, payload: Image.new('RGB', (64, 128), 'blue'))
        self.addCleanup(lambda: self.manager.wait(5))
        self.client = app.test_client()

    def create(self):
        result = self.client.post('/api/daki/style-tests', json=synthetic_request())
        self.assertEqual(result.status_code, 201, result.json)
        return result.json['batch']

    def remove(self, ids):
        return self.client.post('/api/daki/shared-styles/remove', json={'style_ids': ids})

    def test_removal_excludes_new_batches_but_preserves_prepared_batch_and_image_access(self):
        old = self.create()
        path = self.root / 'batches' / old['id'] / 'batch.json'
        before = path.read_bytes()
        result = self.remove(['style-0', 'style-0'])
        self.assertEqual(result.status_code, 200, result.json)
        self.assertEqual(result.json, {'status': 'success', 'removed': 1})
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(self.remove(['style-0']).json['removed'], 0)
        listed = self.client.get('/api/daki/shared-styles').json['styles']
        self.assertEqual([style['id'] for style in listed], ['style-1'])
        new = self.create()
        self.assertEqual([item['style_id'] for item in new['items']], ['style-1'])
        self.assertEqual(self.client.get('/api/daki/shared-styles/style-0').status_code, 200)
        response = self.client.get('/api/daki/shared-styles/style-0/preview?full=1')
        self.assertEqual(response.status_code, 200)
        response.close()
        self.assertEqual(self.client.post(f"/api/daki/style-tests/{old['id']}/run", json={'mode': 'remaining'}).status_code, 200)
        self.assertTrue(self.manager.wait())
        old = self.client.get(f"/api/daki/style-tests/{old['id']}").json['batch']
        self.assertEqual(old['completed'], 2)
        response = self.client.get(old['items'][0]['src'])
        self.assertEqual(response.status_code, 200)
        response.close()

    def test_removal_rejects_invalid_or_unknown_ids_without_partial_changes(self):
        for data in (None, [], {}, {'style_ids': []}, {'style_ids': 'style-0'},
                     {'style_ids': ['style-0', None]}, {'style_ids': ['style-0'] * 10001}):
            with self.subTest(kind=type(data).__name__):
                result = self.client.post('/api/daki/shared-styles/remove', json=data)
                self.assertEqual(result.status_code, 400, result.json)
        self.assertEqual(self.remove(['style-0', 'unknown']).status_code, 404)
        self.assertFalse((self.imported / 'excluded_styles.json').exists())
        self.assertEqual(len(self.client.get('/api/daki/shared-styles').json['styles']), 2)

    def test_removal_while_running_keeps_its_snapshot_and_all_existing_results(self):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def generate(key, payload):
            entered.set()
            if not release.wait(5):
                raise ValueError('synthetic timeout')
            return Image.new('RGB', (64, 128), 'blue')
        self.manager.generator.side_effect = generate
        batch = self.create()
        self.client.post(f"/api/daki/style-tests/{batch['id']}/run", json={'mode': 'remaining'})
        self.assertTrue(entered.wait(5))
        result = self.remove(['style-0', 'style-1'])
        self.assertEqual(result.json, {'status': 'success', 'removed': 2})
        self.assertEqual(self.client.get('/api/daki/shared-styles').json['styles'], [])
        self.assertEqual(self.client.post('/api/daki/style-tests', json=synthetic_request()).status_code, 400)
        release.set()
        self.assertTrue(self.manager.wait())
        current = self.client.get(f"/api/daki/style-tests/{batch['id']}").json['batch']
        self.assertEqual((current['completed'], current['total']), (2, 2))
        for item in current['items']:
            response = self.client.get(item['src'] + '?full=1')
            self.assertEqual(response.status_code, 200)
            response.close()
            self.assertTrue((self.source / f"{item['style_id']}.png").exists())

