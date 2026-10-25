"""WebP output behavior for persistent Daki style test batches."""
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

from flask import Flask
from PIL import Image

import naim.daki_style_tests as daki_style_tests
from naim.daki_image_refs import resolve_daki_image_reference
from naim.daki_style_tests import DakiStyleTests, DakiStyleTestConflict, _request_settings
from naim.images.webp_conversion import convert_png_to_webp, restore_webp_metadata
from naim.web.daki_styles import register_daki_style_routes
from tests.test_daki_style_tests import synthetic_request, synthetic_styles


class DakiStyleTestWebpTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / 'style-tests'
        self.styles = synthetic_styles()
        self.catalog = mock.Mock()
        self.catalog.list_styles.side_effect = lambda: [dict(style) for style in self.styles]
        self.catalog.get_style.side_effect = lambda style_id: dict(
            next(style for style in self.styles if style['id'] == style_id))
        self.key = 'synthetic-secret-key'
        self.generator = mock.Mock(side_effect=lambda key, payload: Image.new(
            'RGBA', (payload['parameters']['width'], payload['parameters']['height']),
            (25, 80, 130, 255)))
        self.manager = self.new_manager()
        self.addCleanup(lambda: self.manager.wait(5))

    def new_manager(self):
        return DakiStyleTests(lambda: self.root, self.catalog, lambda: self.key, self.generator)

    @staticmethod
    def image(size=(64, 128)):
        return Image.new('RGBA', size, (25, 80, 130, 255))

    def create_webp_batch(self, **changes):
        return self.manager.create(synthetic_request(output_format='webp', **changes))

    def test_format_validation_defaults_and_saved_payload_boundary(self):
        self.assertEqual(_request_settings(synthetic_request())['output_format'], 'png')
        self.assertEqual(_request_settings(synthetic_request(output_format='webp'))['output_format'], 'webp')
        for value in (None, 1, [], 'jpeg', 'WEBP'):
            with self.subTest(output_format=value), self.assertRaises(ValueError):
                _request_settings(synthetic_request(output_format=value))

        png_batch = self.manager.create(synthetic_request())
        webp_batch = self.create_webp_batch()
        for batch, expected in ((png_batch, 'png'), (webp_batch, 'webp')):
            self.assertEqual(batch['output_format'], expected)
            self.assertEqual({item['output_format'] for item in batch['items']}, {expected})
            stored = json.loads((self.root / batch['id'] / 'batch.json').read_text('utf-8'))
            self.assertEqual(stored['output_format'], expected)
            self.assertEqual({item['output_format'] for item in stored['items']}, {expected})
            for item in stored['items']:
                self.assertNotIn('output_format', item['payload'])

    def test_webp_generation_preserves_metadata_jpeg_preview_and_virtual_png_reference(self):
        batch = self.create_webp_batch(style_ids=['style-0'], prompt='synthetic WebP scene')
        with mock.patch('naim.daki_style_tests.secrets.randbelow', return_value=321):
            with mock.patch.object(daki_style_tests, 'convert_png_to_webp',
                                   wraps=convert_png_to_webp) as convert:
                self.manager.run(batch['id'], 'next')
                self.assertTrue(self.manager.wait())

        directory = self.root / batch['id']
        webp_path = directory / 'style-0.webp'
        jpeg_path = directory / 'style-0.jpg'
        self.assertTrue(webp_path.is_file())
        self.assertFalse((directory / 'style-0.png').exists())
        self.assertTrue(jpeg_path.is_file())
        self.assertEqual(convert.call_count, 1)
        self.assertEqual(convert.call_args.kwargs, {'lossless': False, 'quality': 90})

        with Image.open(webp_path) as image:
            restore_webp_metadata(image)
            metadata = json.loads(image.info['Comment'])
            self.assertEqual(image.format, 'WEBP')
            self.assertEqual((metadata['prompt'], metadata['model'], metadata['seed']),
                             ('1::0_synthetic_style::, synthetic WebP scene',
                              'nai-diffusion-5-full', 321))
        with Image.open(jpeg_path) as preview:
            self.assertEqual(preview.format, 'JPEG')

        completed = self.manager.get(batch['id'])
        item = completed['items'][0]
        self.assertEqual((completed['status'], item['status'], item['output_format']),
                         ('completed', 'completed', 'webp'))
        self.assertEqual(self.manager.image_path(batch['id'], 'style-0', full=True), webp_path)
        row, = list(self.manager.iter_completed_prompt_images())
        self.assertEqual(row['path'], f"__daki_tests__/{batch['id']}/style-0.png")
        self.assertEqual(resolve_daki_image_reference(row['path'], self.manager),
                         (str(webp_path), row['path']))

        fresh_manager = self.new_manager()
        self.addCleanup(lambda: fresh_manager.wait(5))
        self.assertEqual(fresh_manager.get(batch['id'])['items'][0]['output_format'], 'webp')

    def test_explicit_png_output_keeps_both_png_and_jpeg_without_conversion(self):
        batch = self.manager.create(synthetic_request(output_format='png', style_ids=['style-0']))
        with mock.patch.object(daki_style_tests, 'convert_png_to_webp', create=True) as convert:
            self.manager.run(batch['id'], 'next')
            self.assertTrue(self.manager.wait())
        directory = self.root / batch['id']
        self.assertTrue((directory / 'style-0.png').is_file())
        self.assertTrue((directory / 'style-0.jpg').is_file())
        self.assertFalse((directory / 'style-0.webp').exists())
        convert.assert_not_called()
        self.assertEqual(self.manager.get(batch['id'])['items'][0]['output_format'], 'png')

    def test_api_round_trip_serves_webp_full_image_with_webp_mime_type(self):
        app = Flask(__name__)
        with mock.patch('naim.web.daki_styles.DakiSharedStyles', return_value=self.catalog):
            manager = register_daki_style_routes(
                app, lambda: self.root / 'catalog', lambda: self.root / 'api-tests', lambda: self.key)
        manager.generator = self.generator
        self.addCleanup(lambda: manager.wait(5))
        client = app.test_client()

        created = client.post('/api/daki/style-tests', json=synthetic_request(
            output_format='webp', style_ids=['style-0']))
        self.assertEqual(created.status_code, 201, created.json)
        batch = created.json['batch']
        self.assertEqual(batch['output_format'], 'webp')
        self.assertEqual(batch['items'][0]['output_format'], 'webp')
        self.assertEqual(client.post(f"/api/daki/style-tests/{batch['id']}/run",
                                     json={'mode': 'next'}).status_code, 200)
        self.assertTrue(manager.wait())

        current = client.get(f"/api/daki/style-tests/{batch['id']}").json['batch']
        self.assertEqual(current['items'][0]['output_format'], 'webp')
        for suffix, mimetype in (('', 'image/jpeg'), ('?full=1', 'image/webp')):
            response = client.get(current['items'][0]['src'] + suffix)
            try:
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.mimetype, mimetype)
            finally:
                response.close()

    def test_settings_update_append_and_failed_retry_keep_per_item_format_snapshots(self):
        batch = self.create_webp_batch()
        self.manager.run(batch['id'], 'next')
        self.assertTrue(self.manager.wait())

        self.generator.side_effect = ValueError('synthetic generation failure')
        self.manager.run(batch['id'], 'next')
        self.assertTrue(self.manager.wait())
        before = json.loads((self.root / batch['id'] / 'batch.json').read_text('utf-8'))
        self.assertEqual([item['status'] for item in before['items']], ['completed', 'failed', 'pending'])
        self.assertEqual([item['output_format'] for item in before['items']], ['webp'] * 3)

        omitted = self.manager.update_settings(batch['id'], synthetic_request(prompt='omitted format update'))
        after_omitted = json.loads((self.root / batch['id'] / 'batch.json').read_text('utf-8'))
        self.assertEqual(omitted['output_format'], 'webp')
        self.assertEqual([item['output_format'] for item in after_omitted['items']], ['webp'] * 3)
        self.assertEqual(after_omitted['items'][:2], before['items'][:2])

        self.manager.update_settings(batch['id'], synthetic_request(
            output_format='png', prompt='pending item uses PNG'))
        changed = json.loads((self.root / batch['id'] / 'batch.json').read_text('utf-8'))
        self.assertEqual([item['output_format'] for item in changed['items']], ['webp', 'webp', 'png'])
        self.assertEqual(changed['items'][:2], after_omitted['items'][:2])

        self.styles.append(synthetic_styles(4)[-1])
        appended = self.manager.append_styles(batch['id'], ['style-3'])
        self.assertEqual(appended['items'][-1]['output_format'], 'png')

        self.generator.side_effect = lambda key, payload: self.image(
            (payload['parameters']['width'], payload['parameters']['height']))
        with mock.patch.object(daki_style_tests, 'convert_png_to_webp',
                               wraps=convert_png_to_webp) as convert:
            self.manager.run(batch['id'], 'retry_failed')
            self.assertTrue(self.manager.wait())
        result = self.manager.get(batch['id'])
        self.assertEqual(result['items'][1]['status'], 'completed')
        self.assertEqual(result['items'][1]['output_format'], 'webp')
        self.assertEqual(result['items'][2]['output_format'], 'png')
        self.assertEqual(result['items'][3]['output_format'], 'png')
        self.assertEqual(convert.call_count, 1)
        self.assertTrue((self.root / batch['id'] / 'style-1.webp').is_file())
        self.assertFalse((self.root / batch['id'] / 'style-3.png').exists())

    def test_generation_continues_while_local_conversion_is_blocked(self):
        conversion_entered, release_conversion = threading.Event(), threading.Event()
        second_generation_entered = threading.Event()
        self.addCleanup(release_conversion.set)

        def generate(key, payload):
            if payload['input'].startswith(self.styles[1]['positive']):
                second_generation_entered.set()
            return self.image((payload['parameters']['width'], payload['parameters']['height']))

        def blocked_conversion(path, *, lossless, quality):
            conversion_entered.set()
            if not release_conversion.wait(5):
                raise RuntimeError('synthetic converter timeout')
            return convert_png_to_webp(path, lossless=lossless, quality=quality)

        self.generator.side_effect = generate
        batch = self.create_webp_batch()
        try:
            with mock.patch.object(daki_style_tests, 'convert_png_to_webp', side_effect=blocked_conversion):
                self.manager.run(batch['id'], 'remaining')
                self.assertTrue(conversion_entered.wait(5))
                self.assertTrue(second_generation_entered.wait(5))
                self.assertFalse(release_conversion.is_set())
                release_conversion.set()
                self.assertTrue(self.manager.wait(5))
        finally:
            release_conversion.set()

        self.assertEqual(self.generator.call_count, 3)
        self.assertEqual(self.manager.get(batch['id'])['completed'], 3)

    def test_generation_failure_waits_for_prior_conversion_to_drain(self):
        conversion_entered, release_conversion = threading.Event(), threading.Event()
        second_generation_entered = threading.Event()
        self.addCleanup(release_conversion.set)

        def generate(key, payload):
            if payload['input'].startswith(self.styles[1]['positive']):
                second_generation_entered.set()
                raise ValueError('synthetic server failure')
            return self.image((payload['parameters']['width'], payload['parameters']['height']))

        def blocked_conversion(path, *, lossless, quality):
            conversion_entered.set()
            if not release_conversion.wait(5):
                raise RuntimeError('synthetic converter timeout')
            return convert_png_to_webp(path, lossless=lossless, quality=quality)

        self.generator.side_effect = generate
        batch = self.create_webp_batch()
        try:
            with mock.patch.object(daki_style_tests, 'convert_png_to_webp', side_effect=blocked_conversion):
                self.manager.run(batch['id'], 'remaining')
                self.assertTrue(conversion_entered.wait(5))
                self.assertTrue(second_generation_entered.wait(5))
                self.assertFalse(self.manager.wait(.01))
                release_conversion.set()
                self.assertTrue(self.manager.wait(5))
        finally:
            release_conversion.set()

        result = self.manager.get(batch['id'])
        self.assertEqual((result['status'], result['completed'], result['failed'], result['pending']),
                         ('failed', 1, 1, 1))
        self.assertEqual(self.generator.call_count, 2)
        self.assertTrue((self.root / batch['id'] / 'style-0.webp').is_file())

    def test_stop_waits_for_queued_conversion_and_blocks_later_generation(self):
        conversion_entered, release_conversion = threading.Event(), threading.Event()
        second_generation_entered, release_second_generation = threading.Event(), threading.Event()
        third_generation_entered = threading.Event()
        self.addCleanup(release_conversion.set)
        self.addCleanup(release_second_generation.set)
        other_batch = self.manager.create(synthetic_request(style_ids=['style-0']))

        def generate(key, payload):
            if payload['input'].startswith(self.styles[1]['positive']):
                second_generation_entered.set()
                if not release_second_generation.wait(5):
                    raise RuntimeError('synthetic generator timeout')
            elif payload['input'].startswith(self.styles[2]['positive']):
                third_generation_entered.set()
            return self.image((payload['parameters']['width'], payload['parameters']['height']))

        def blocked_conversion(path, *, lossless, quality):
            if path.name == 'style-0.png':
                conversion_entered.set()
                if not release_conversion.wait(5):
                    raise RuntimeError('synthetic converter timeout')
            return convert_png_to_webp(path, lossless=lossless, quality=quality)

        self.generator.side_effect = generate
        batch = self.create_webp_batch()
        try:
            with mock.patch.object(daki_style_tests, 'convert_png_to_webp', side_effect=blocked_conversion):
                self.manager.run(batch['id'], 'remaining')
                self.assertTrue(conversion_entered.wait(5))
                self.assertTrue(second_generation_entered.wait(5))
                stopped = self.manager.stop(batch['id'])
                self.assertEqual(stopped['status'], 'stopping')
                with self.assertRaises(DakiStyleTestConflict):
                    self.manager.run(other_batch['id'], 'next')
                self.assertFalse(self.manager.wait(.01))
                release_second_generation.set()
                release_conversion.set()
                self.assertTrue(self.manager.wait(5))
        finally:
            release_second_generation.set()
            release_conversion.set()

        result = self.manager.get(batch['id'])
        self.assertEqual((result['status'], result['completed'], result['pending']), ('paused', 2, 1))
        self.assertEqual(self.generator.call_count, 2)
        self.assertFalse(third_generation_entered.is_set())
        self.assertTrue((self.root / batch['id'] / 'style-0.webp').is_file())
        self.assertTrue((self.root / batch['id'] / 'style-1.webp').is_file())

    def test_conversion_skip_and_exception_keep_png_warn_safely_and_do_not_retry(self):
        batch = self.create_webp_batch()
        calls = []

        def conversion(path, *, lossless, quality):
            calls.append(Path(path).name)
            if len(calls) == 1:
                return {'status': 'skipped', 'reason': f'{path} {self.key}'}
            if len(calls) == 2:
                raise OSError(f'could not convert {path} with {self.key}')
            return convert_png_to_webp(path, lossless=lossless, quality=quality)

        with mock.patch.object(daki_style_tests, 'convert_png_to_webp', side_effect=conversion):
            self.manager.run(batch['id'], 'remaining')
            self.assertTrue(self.manager.wait())
            result = self.manager.get(batch['id'])

        self.assertEqual((result['status'], result['completed'], result['failed']), ('completed', 3, 0))
        for index in (0, 1):
            item = result['items'][index]
            warning = item.get('conversion_error')
            self.assertTrue(warning)
            self.assertNotIn(str(self.root), warning)
            self.assertNotIn(self.key, warning)
            self.assertTrue((self.root / batch['id'] / f'style-{index}.png').is_file())
            self.assertEqual(self.manager.image_path(batch['id'], f'style-{index}', full=True).suffix, '.png')
        self.assertEqual(result['items'][2]['status'], 'completed')
        self.assertTrue((self.root / batch['id'] / 'style-2.webp').is_file())
        self.assertEqual(calls, ['style-0.png', 'style-1.png', 'style-2.png'])
        self.assertEqual(self.generator.call_count, 3)
        with self.assertRaises(DakiStyleTestConflict):
            self.manager.run(batch['id'], 'retry_failed')
        self.assertEqual(self.generator.call_count, 3)

    def test_legacy_format_and_interrupted_conversion_recovery(self):
        legacy = self.manager.create(synthetic_request(style_ids=['style-0']))
        retained_png = self.create_webp_batch(style_ids=['style-0'])
        converted_webp = self.create_webp_batch(style_ids=['style-0'])
        missing_result = self.create_webp_batch(style_ids=['style-0'])

        legacy_path = self.root / legacy['id'] / 'batch.json'
        legacy_data = json.loads(legacy_path.read_text('utf-8'))
        legacy_data.pop('output_format', None)
        for item in legacy_data['items']:
            item.pop('output_format', None)
        legacy_path.write_text(json.dumps(legacy_data), encoding='utf-8')

        for batch in (retained_png, converted_webp, missing_result):
            path = self.root / batch['id'] / 'batch.json'
            stored = json.loads(path.read_text('utf-8'))
            stored['status'] = 'running'
            stored['items'][0]['status'] = 'converting'
            path.write_text(json.dumps(stored), encoding='utf-8')

        for batch in (retained_png, converted_webp):
            stored = json.loads((self.root / batch['id'] / 'batch.json').read_text('utf-8'))
            self.manager._save_image(self.root, batch['id'], stored['items'][0], self.image())
        converted_png_path = self.root / converted_webp['id'] / 'style-0.png'
        self.assertEqual(convert_png_to_webp(converted_png_path, lossless=False, quality=90)['status'], 'converted')

        restarted = self.new_manager()
        self.addCleanup(lambda: restarted.wait(5))
        with mock.patch.object(daki_style_tests, 'convert_png_to_webp', side_effect=AssertionError('must not retry')):
            legacy_result = restarted.get(legacy['id'])
            retained_result = restarted.get(retained_png['id'])
            webp_result = restarted.get(converted_webp['id'])
            missing = restarted.get(missing_result['id'])

        self.assertEqual((legacy_result['output_format'], legacy_result['items'][0]['output_format']),
                         ('png', 'png'))
        self.assertEqual((retained_result['status'], retained_result['items'][0]['status']),
                         ('completed', 'completed'))
        warning = retained_result['items'][0].get('conversion_error')
        self.assertTrue(warning)
        self.assertNotIn(str(self.root), warning)
        self.assertEqual((webp_result['status'], webp_result['items'][0]['status']), ('completed', 'completed'))
        self.assertNotIn('conversion_error', webp_result['items'][0])
        self.assertEqual((missing['status'], missing['items'][0]['status']), ('failed', 'failed'))
        self.generator.assert_not_called()


if __name__ == '__main__':
    unittest.main()
