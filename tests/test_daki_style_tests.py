import copy
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock
import urllib.error
import zipfile

from PIL import Image

from naim.daki_style_tests import DakiStyleTests, DakiStyleTestConflict, DakiAnlasConfirmation, build_style_test_payload, SIZE_PRESETS, SIZE_LIMITS
from naim.generation_settings import V5_FULL_MEDIUM, V5_HEAVY_UC
from naim.novelai import generate_text_image


def synthetic_styles(count=3):
    return [dict(
        id=f'style-{index}', name=f'Synthetic {index}', model='nai-diffusion-4-5-full',
        positive=f'1::{index}_synthetic_style::', negative=f'synthetic_negative_{index}',
        options={'steps': 20 + index, 'cfg': 4 + index / 10, 'sampler': 'k_euler',
                 'cfg_rescale': 0, 'noise_schedule': 'native', 'prefer_brownian': False,
                 'deliberate_euler_ancestral_bug': False, 'legacy_v3_extend': False,
                 'dynamic_thresholding': False, 'strength': .5, 'noise': 0},
        preview={'width': 64, 'height': 128}, seed=100 + index,
        source_image_id=f'synthetic-source-{index}', source_url='https://example.invalid/synthetic',
    ) for index in range(count)]


def synthetic_request(**changes):
    request = dict(prompt='synthetic common scene', negative_prompt='synthetic common negative',
                   model='nai-diffusion-5-full',
                   char_prompts=[{'prompt': 'synthetic character', 'negative_prompt': 'synthetic character negative'}])
    request.update(changes)
    return request


def synthetic_upper_source(styles=None):
    styles = styles or synthetic_styles(1)
    request = synthetic_request(model='nai-diffusion-5-full', prompt='original scene',
                               negative_prompt='original common negative', width=64, height=128,
                               output_format='webp')
    entries = []
    for index, style in enumerate(styles):
        payload = {
            'input': style['positive'] + ', original scene', 'model': request['model'],
            'action': 'generate', 'parameters': {
                'width': 64, 'height': 128, 'steps': style['options']['steps'],
                'seed': 1000 + index, 'v4_prompt': {'caption': {'char_captions': [
                    {'char_caption': 'synthetic character'}]}},
                'v4_negative_prompt': {'caption': {'char_captions': [
                    {'char_caption': 'synthetic character negative'}]}},
            },
        }
        entries.append({'style': copy.deepcopy(style), 'payload': payload, 'output_format': 'png'})
    return {'request': request, 'entries': entries}


class DakiStyleTestsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'comparisons'
        self.styles = synthetic_styles()
        self.catalog = mock.Mock()
        self.catalog.list_styles.side_effect = lambda: copy.deepcopy(self.styles)
        self.catalog.get_style.side_effect = lambda sid: copy.deepcopy(next(style for style in self.styles if style['id'] == sid))
        self.key = 'synthetic-secret-key'
        self.generator = mock.Mock(side_effect=lambda key, payload: Image.new('RGBA', (
            payload['parameters']['width'], payload['parameters']['height']), 'navy'))
        self.manager = self.new_manager()
        self.addCleanup(lambda: self.manager.wait(5))

    def new_manager(self):
        return DakiStyleTests(lambda: self.root, self.catalog, lambda: self.key, self.generator)

    def test_upper_test_import_is_stable_and_persistent_without_generation(self):
        source = synthetic_upper_source(self.styles[:1])
        self.catalog.upper_test_source.return_value = source

        batch = self.manager.ensure_upper_test()

        self.assertEqual((batch['id'], batch['name'], batch['origin'], batch['library']),
                         ('d79b7ac88db758808a2cf316913635a6', '상반신', 'shared_upper', 'shared'))
        self.assertEqual((batch['status'], batch['total'], batch['completed'], batch['pending']),
                         ('completed', 1, 1, 0))
        self.assertEqual(batch['items'][0]['status'], 'completed')
        self.assertEqual(batch['output_format'], 'webp')
        self.assertEqual(batch['items'][0]['output_format'], 'png')
        self.assertEqual(batch['items'][0]['options'], self.styles[0]['options'])
        stored = self.root / batch['id'] / 'batch.json'
        before = stored.read_bytes()
        original_payload = copy.deepcopy(source['entries'][0]['payload'])
        self.assertEqual(json.loads(before)['items'][0]['payload'], original_payload)
        self.catalog.upper_test_source.assert_called_once_with()
        self.generator.assert_not_called()

        reopened = self.new_manager()
        existing = reopened.ensure_upper_test()
        self.assertEqual(existing['id'], batch['id'])
        self.assertEqual(stored.read_bytes(), before)
        self.catalog.upper_test_source.assert_called_once_with()
        self.generator.assert_not_called()

    def test_upper_test_append_and_settings_keep_imported_payload_and_preview_reference(self):
        source = synthetic_upper_source(self.styles[:1])
        self.catalog.upper_test_source.return_value = source
        self.root.mkdir(parents=True, exist_ok=True)
        preview = self.root / 'legacy-preview.webp'
        preview.write_bytes(b'synthetic legacy preview')
        self.catalog.preview_path.return_value = preview

        batch = self.manager.ensure_upper_test()
        original_payload = json.loads((self.root / batch['id'] / 'batch.json').read_text('utf-8'))['items'][0]['payload']
        appended = self.manager.append_styles(batch['id'], ['style-1'])
        self.assertEqual((appended['total'], appended['completed'], appended['pending']), (2, 1, 1))
        saved = self.manager.update_settings(batch['id'], synthetic_request(
            prompt='updated scene', negative_prompt='updated common negative', width=128, height=128))

        stored = json.loads((self.root / batch['id'] / 'batch.json').read_text('utf-8'))
        self.assertEqual(stored['items'][0]['payload'], original_payload)
        self.assertTrue(stored['items'][0]['legacy_preview'])
        self.assertEqual((saved['items'][1]['width'], saved['items'][1]['height']), (128, 128))
        self.assertEqual(saved['items'][1]['status'], 'pending')
        self.assertEqual(self.manager.image_path(batch['id'], 'style-0', full=True), preview)
        self.catalog.preview_path.assert_called_once_with('style-0', full=True)
        rows = list(self.manager.iter_completed_prompt_images())
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['path'], f"__daki_tests__/{batch['id']}/style-0.png")
        self.assertEqual(rows[0]['prompt_info']['prompt'], source['entries'][0]['payload']['input'])
        self.generator.assert_not_called()

    def test_upper_test_missing_or_malformed_source_does_not_create_partial_batch(self):
        batch_id = 'd79b7ac88db758808a2cf316913635a6'
        target = self.root / batch_id
        for result in (FileNotFoundError('synthetic source missing'),
                       {'request': synthetic_request(), 'entries': [{'style': {}, 'payload': {}}]}):
            with self.subTest(source=type(result).__name__):
                self.catalog.upper_test_source.reset_mock()
                if isinstance(result, Exception):
                    self.catalog.upper_test_source.side_effect = result
                else:
                    self.catalog.upper_test_source.side_effect = None
                    self.catalog.upper_test_source.return_value = result
                with self.assertRaises((FileNotFoundError, ValueError)):
                    self.manager.ensure_upper_test()
                self.assertFalse(target.exists())
        self.generator.assert_not_called()

    def test_sort_dates_enrich_old_items_without_rewriting_completed_or_saved_data(self):
        self.styles[0]['source_posted_at'] = '2026-01-02T03:04:05Z'
        self.catalog.sort_dates_many.return_value = [None, '2025-01-01T00:00:00Z', None]
        batch = self.manager.create(synthetic_request())
        path = self.root / batch['id'] / 'batch.json'
        before = path.read_bytes()
        detail = self.manager.get(batch['id'])
        self.assertEqual([item['sort_date'] for item in detail['items']],
                         ['2026-01-02T03:04:05+00:00', '2025-01-01T00:00:00Z', None])
        self.assertEqual(path.read_bytes(), before)

    def test_details_find_current_missing_shared_styles_without_mutating_saved_items(self):
        batch = self.manager.create(synthetic_request())
        path = self.root / batch['id'] / 'batch.json'
        before = path.read_bytes()
        self.assertEqual(batch['missing_shared_style_ids'], [])
        new_styles = synthetic_styles(6)[3:]
        self.styles.extend([new_styles[0], new_styles[1], new_styles[0]])
        # The last source remains readable but is excluded from list_styles.
        self.catalog.get_style.side_effect = None
        self.catalog.get_style.return_value = new_styles[2]
        details = self.manager.get(batch['id'])
        self.assertEqual(details['missing_shared_style_ids'], ['style-3', 'style-4'])
        self.assertEqual((details['total'], details['pending']), (3, 3))
        self.assertEqual([item['style_id'] for item in details['items']], ['style-0', 'style-1', 'style-2'])
        self.assertEqual(path.read_bytes(), before)
        self.catalog.list_styles.assert_called_with()
        self.catalog.get_style.assert_not_called()
        self.generator.assert_not_called()

    def test_missing_shared_styles_use_import_artist_rules_instead_of_source_posts(self):
        self.styles[0]['source_url'] = 'http://arca.live/b/aiart/123/?from=saved#image'
        self.styles[0]['positive'] = 'artist:synthetic_a, artist:synthetic_b, lineart'
        self.styles[1]['positive'] = 'watercolor, lineart, high quality'
        batch = self.manager.create(synthetic_request())
        path = self.root / batch['id'] / 'batch.json'
        before = path.read_bytes()
        candidates = synthetic_styles(11)[3:]
        candidates[0].update(source_url='https://arca.live/b/aiart/999',
                             positive='0.5::artists:SYNTHETIC_B, artist:synthetic_a ::, watercolor',
                             negative='different negative')
        candidates[1].update(source_url='https://arca.live/b/aiart/123',
                             positive='artist:synthetic_a, artist:synthetic_c')
        candidates[2]['positive'] = '0.25::lineart, watercolor ::, best quality'
        candidates[3]['source_url'] = ''
        candidates[4]['source_url'] = 'https://example.invalid/synthetic'
        candidates[5]['positive'] = 'artist:new_synthetic'
        candidates[6]['positive'] = '0.5::artist:NEW_SYNTHETIC ::, lineart'
        candidates[7]['positive'] = '||artist:invalid|lineart||'
        self.styles.extend(candidates)

        details = self.manager.get(batch['id'])

        expected = ['style-4', 'style-6', 'style-7', 'style-8', 'style-10']
        self.assertEqual(details['missing_shared_style_ids'], expected)
        self.assertEqual(details['total'], 3)
        self.assertEqual(path.read_bytes(), before)
        self.generator.assert_not_called()
        updated = self.manager.append_styles(batch['id'], details['missing_shared_style_ids'])
        self.assertEqual([item['style_id'] for item in updated['items']],
                         ['style-0', 'style-1', 'style-2', *expected])
        self.assertEqual(updated['missing_shared_style_ids'], [])
        self.generator.assert_not_called()

    def test_summaries_do_not_read_shared_catalog_or_include_missing_ids(self):
        batch = self.manager.create(synthetic_request())
        self.catalog.list_styles.reset_mock()
        self.catalog.list_styles.side_effect = FileNotFoundError('synthetic unavailable catalog')
        summary = self.manager.list_batches()[0]
        self.assertEqual(summary['id'], batch['id'])
        self.assertNotIn('missing_shared_style_ids', summary)
        self.catalog.list_styles.assert_not_called()

    def test_unavailable_shared_catalog_does_not_prevent_viewing_or_running_saved_tests(self):
        batch = self.manager.create(synthetic_request())
        path = self.root / batch['id'] / 'batch.json'
        before = path.read_bytes()
        for error in (FileNotFoundError, PermissionError, ValueError, UnicodeError):
            with self.subTest(error=error.__name__):
                self.catalog.list_styles.side_effect = error('synthetic unavailable catalog')
                details = self.manager.get(batch['id'])
                self.assertIsNone(details['missing_shared_style_ids'])
                self.assertEqual((details['total'], details['pending']), (3, 3))
                self.assertEqual(path.read_bytes(), before)
        running = self.manager.run(batch['id'], 'next')
        self.assertIsNone(running['missing_shared_style_ids'])
        self.assertTrue(self.manager.wait())
        details = self.manager.get(batch['id'])
        self.assertEqual((details['completed'], details['pending']), (1, 2))
        self.assertIsNone(details['missing_shared_style_ids'])
        self.generator.assert_called_once()

    def test_old_batches_expose_source_counts_without_rewriting_saved_data_or_requiring_active_style(self):
        self.styles[0]['source_url'] = 'https://arca.live/b/aiart/123?from=example'
        self.styles[1].update(source_url='https://arca.live/b/aiart/124', recommendation_count=0,
                              recommendation_collected_at='2026-01-01')
        self.styles[2]['source_url'] = 'javascript:alert(1)'
        self.catalog.source_metadata_many.side_effect = lambda styles: [{
            'recommendation_count': 50, 'recommendation_collected_at': '2026-01-02'} for style in styles]
        batch = self.manager.create(synthetic_request())
        path = self.root / batch['id'] / 'batch.json'
        before = path.read_bytes()
        self.styles.clear()
        self.catalog.get_style.side_effect = KeyError('removed')
        items = self.manager.get(batch['id'])['items']
        self.assertEqual(items[0]['source_url'], 'https://arca.live/b/aiart/123')
        self.assertEqual(items[0]['recommendation_count'], 50)
        self.assertEqual(items[0]['recommendation_collected_at'], '2026-01-02')
        self.assertEqual(items[1]['recommendation_count'], 0)
        self.assertEqual(items[1]['recommendation_collected_at'], '2026-01-01')
        self.assertIsNone(items[2]['source_url'])
        self.assertIsNone(items[2]['recommendation_count'])
        self.assertEqual(path.read_bytes(), before)
        self.catalog.get_style.assert_not_called()
        self.catalog.source_metadata.assert_not_called()
        self.generator.assert_not_called()

    def test_personal_style_test_has_no_fabricated_article_or_recommendation_count(self):
        self.styles[0]['id'] = 'personal_example'
        self.styles[0].update(source_url='https://arca.live/b/aiart/123', recommendation_count=99)
        batch = self.manager.create(synthetic_request(style_ids=['personal_example']))
        self.assertIsNone(batch['items'][0]['source_url'])
        self.assertIsNone(batch['items'][0]['recommendation_count'])
        self.assertIsNone(batch['items'][0]['recommendation_collected_at'])

    def test_create_selected_styles_deduplicates_in_requested_order_and_only_builds_selected_payloads(self):
        original = copy.deepcopy(self.styles)
        self.styles[1]['options']['steps'] = 0
        with mock.patch('naim.daki_style_tests.build_style_test_payload', wraps=build_style_test_payload) as build:
            batch = self.manager.create(synthetic_request(style_ids=['style-2', 'style-0', 'style-2'],
                name='Selected comparison', prompt='selected scene', width=128, height=192))
        self.assertEqual([item['style_id'] for item in batch['items']], ['style-2', 'style-0'])
        self.assertEqual((batch['total'], batch['pending'], batch['name'], batch['library']), (2, 2, 'Selected comparison', 'shared'))
        self.assertEqual([call.args[0]['id'] for call in build.call_args_list], ['style-2', 'style-0'])
        self.catalog.get_style.assert_not_called()
        self.generator.assert_not_called()
        stored = json.loads((self.root / batch['id'] / 'batch.json').read_text('utf-8'))
        self.assertEqual([item['style'] for item in stored['items']], [original[2], original[0]])
        self.styles[2]['positive'] = 'changed after preparation'
        self.manager.run(batch['id'], 'remaining')
        self.assertTrue(self.manager.wait())
        self.assertEqual(self.generator.call_count, 2)
        self.assertEqual([call.args[1]['input'] for call in self.generator.call_args_list],
                         [original[2]['positive'] + ', selected scene', original[0]['positive'] + ', selected scene'])
        self.assertTrue(all((call.args[1]['parameters']['width'], call.args[1]['parameters']['height']) == (128, 192)
                            for call in self.generator.call_args_list))

    def test_explicit_selection_rejects_invalid_unknown_and_excluded_ids_before_saving(self):
        for selected in (None, [], 'style-0', ('style-0',), {}, [None], [True], [1], [''],
                         ['../style-0'], ['x' * 129], ['style-0'] * 10001,
                         ['style-0', 'unknown'], ['style-0', 'personal_other']):
            with self.subTest(selected=str(selected)[:80]), self.assertRaises(ValueError):
                self.manager.create(synthetic_request(style_ids=selected))
            self.assertFalse(self.root.exists())
        removed = self.styles.pop()
        # The old source remains readable through get_style, while list_styles
        # is the active recipe list used for every new batch.
        self.catalog.get_style.side_effect = None
        self.catalog.get_style.return_value = removed
        with self.assertRaises(ValueError):
            self.manager.create(synthetic_request(style_ids=['style-0', removed['id']]))
        self.assertFalse(self.root.exists())
        self.catalog.get_style.assert_not_called()
        self.generator.assert_not_called()

    def test_personal_selection_uses_only_the_active_personal_catalog_and_omission_keeps_all_styles(self):
        personal = synthetic_styles(3)
        for index, style in enumerate(personal):
            style['id'] = f'personal_{index}'
        personal_catalog = mock.Mock()
        personal_catalog.list_styles.return_value = personal
        self.manager.personal_catalog = personal_catalog
        selected = self.manager.create(synthetic_request(library='personal', style_ids=['personal_2', 'personal_0', 'personal_2']))
        self.assertEqual([item['style_id'] for item in selected['items']], ['personal_2', 'personal_0'])
        self.assertEqual(selected['library'], 'personal')
        self.assertEqual(selected['missing_shared_style_ids'], [])
        self.catalog.list_styles.assert_not_called()
        before = {path.name for path in self.root.iterdir()}
        for ids in (['style-0'], ['personal_1', 'missing'], []):
            with self.assertRaises(ValueError):
                self.manager.create(synthetic_request(library='personal', style_ids=ids))
        self.assertEqual({path.name for path in self.root.iterdir()}, before)
        all_personal = self.manager.create(synthetic_request(library='personal'))
        all_shared = self.manager.create(synthetic_request())
        self.assertEqual([item['style_id'] for item in all_personal['items']], ['personal_0', 'personal_1', 'personal_2'])
        self.assertEqual([item['style_id'] for item in all_shared['items']], ['style-0', 'style-1', 'style-2'])
        personal_catalog.get_style.assert_not_called()
        self.generator.assert_not_called()

    def test_named_personal_batch_uses_personal_catalog_and_image_cover(self):
        personal = synthetic_styles(2)
        for index, style in enumerate(personal):
            style['id'] = f'personal_{index}'
        catalog = mock.Mock()
        catalog.list_styles.return_value = personal
        manager = DakiStyleTests(lambda: self.root, self.catalog, lambda: self.key,
                                 self.generator, personal_catalog=catalog)
        self.addCleanup(lambda: manager.wait(5))
        batch = manager.create(synthetic_request(name='  Synthetic gallery  ', library='personal'))
        self.assertEqual((batch['name'], batch['library'], batch['total']), ('Synthetic gallery', 'personal', 2))
        self.assertIsNone(batch['cover_src'])
        self.assertIsNone(batch['items'][0]['source_src'])
        self.catalog.list_styles.assert_not_called()
        self.generator.assert_not_called()
        manager.run(batch['id'], 'next')
        self.assertTrue(manager.wait())
        details, summary = manager.get(batch['id']), manager.list_batches()[0]
        for result in (details, summary):
            self.assertEqual(result['name'], 'Synthetic gallery')
            self.assertEqual(result['library'], 'personal')
            self.assertEqual(result['cover_src'], details['items'][0]['src'])

    def test_old_unnamed_batches_keep_shared_library_without_storage_migration(self):
        batch = self.manager.create(synthetic_request(name='   '))
        path = self.root / batch['id'] / 'batch.json'
        stored = json.loads(path.read_text('utf-8'))
        stored.pop('name')
        stored.pop('library')
        path.write_text(json.dumps(stored), encoding='utf-8')
        before = path.read_bytes()
        self.styles.append(synthetic_styles(4)[-1])
        details = self.manager.get(batch['id'])
        self.assertEqual(details['missing_shared_style_ids'], ['style-3'])
        for result in (details, self.manager.list_batches()[0]):
            self.assertEqual(result['name'], '')
            self.assertEqual(result['library'], 'shared')
            self.assertIsNone(result['cover_src'])
        self.assertEqual(path.read_bytes(), before)

    def test_name_and_library_validation_precede_create_or_rename_mutation(self):
        for values in ({'name': None}, {'name': 3}, {'name': 'x' * 121},
                       {'library': 'unknown'}, {'library': []}, {'library': 'personal'}):
            with self.subTest(values=values), self.assertRaises(ValueError):
                self.manager.create(synthetic_request(**values))
        self.assertFalse(self.root.exists())
        batch = self.manager.create(synthetic_request(name='  ' + 'x' * 120 + '  '))
        self.assertEqual(batch['name'], 'x' * 120)
        path = self.root / batch['id'] / 'batch.json'
        before = path.read_bytes()
        for name in (None, 4, '', '   ', 'x' * 121):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.manager.rename(batch['id'], name)
            self.assertEqual(path.read_bytes(), before)

    def test_rename_during_generation_preserves_latest_items_and_survives_completion(self):
        batch = self.manager.create(synthetic_request(name='Before'))
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def generate(key, payload):
            entered.set()
            if not release.wait(5):
                raise ValueError('synthetic timeout')
            return Image.new('RGB', (64, 128), 'green')
        self.generator.side_effect = generate
        self.manager.run(batch['id'], 'next')
        self.assertTrue(entered.wait(5))
        path = self.root / batch['id'] / 'batch.json'
        before = json.loads(path.read_text('utf-8'))
        renamed = self.manager.rename(batch['id'], '  After  ')
        after = json.loads(path.read_text('utf-8'))
        self.assertEqual((renamed['name'], renamed['status']), ('After', 'running'))
        self.assertEqual(after['items'], before['items'])
        self.assertEqual(after['model'], before['model'])
        release.set()
        self.assertTrue(self.manager.wait())
        completed = self.manager.get(batch['id'])
        self.assertEqual((completed['name'], completed['completed'], completed['pending']), ('After', 1, 2))

    def test_append_after_completion_uses_current_settings_and_freezes_new_sources(self):
        batch = self.manager.create(synthetic_request(name='Test gallery'))
        self.manager.run(batch['id'], 'next')
        self.assertTrue(self.manager.wait())
        self.manager.update_settings(batch['id'], synthetic_request(
            prompt='changed scene', model='nai-diffusion-4-5-full', width=128, height=192))
        self.manager.run(batch['id'], 'remaining')
        self.assertTrue(self.manager.wait())
        path = self.root / batch['id'] / 'batch.json'
        before = json.loads(path.read_text('utf-8'))
        images = {item['style_id']: self.manager.image_path(batch['id'], item['style_id'], True).read_bytes()
                  for item in before['items']}
        new_style = synthetic_styles(4)[-1]
        self.styles.append(new_style)
        personal = copy.deepcopy(new_style)
        personal.update(id='personal_new', name='Synthetic personal')
        personal_catalog = mock.Mock()
        personal_catalog.get_style.return_value = personal
        self.manager.personal_catalog = personal_catalog
        missing = self.manager.get(batch['id'])['missing_shared_style_ids']
        self.assertEqual(missing, [new_style['id']])
        result = self.manager.append_styles(batch['id'], missing + [personal['id']])
        self.assertEqual(result['missing_shared_style_ids'], [])
        self.assertEqual((result['status'], result['completed'], result['pending'], result['total']), ('paused', 3, 2, 5))
        self.assertEqual((result['name'], result['library']), ('Test gallery', 'shared'))
        self.assertEqual(self.generator.call_count, 3)
        after = json.loads(path.read_text('utf-8'))
        self.assertEqual(after['items'][:3], before['items'])
        frozen = copy.deepcopy(after['items'][3:])
        for item in frozen:
            self.assertEqual(item['payload']['model'], 'nai-diffusion-4-5-full')
            self.assertEqual(item['payload']['input'], new_style['positive'] + ', changed scene')
            self.assertEqual((item['payload']['parameters']['width'], item['payload']['parameters']['height']), (128, 192))
        new_style['positive'] = personal['positive'] = 'changed after append'
        self.manager.run(batch['id'], 'remaining')
        self.assertTrue(self.manager.wait())
        self.assertEqual(self.generator.call_count, 5)
        for call, item in zip(self.generator.call_args_list[3:], frozen):
            self.assertEqual(call.args[1]['input'], item['payload']['input'])
        for style_id, image in images.items():
            self.assertEqual(self.manager.image_path(batch['id'], style_id, True).read_bytes(), image)

    def test_append_duplicates_do_not_overwrite_any_status_or_repeat_additions(self):
        batch = self.manager.create(synthetic_request())
        self.manager.run(batch['id'], 'next')
        self.assertTrue(self.manager.wait())
        self.generator.side_effect = ValueError('synthetic failure')
        self.manager.run(batch['id'], 'next')
        self.assertTrue(self.manager.wait())
        path = self.root / batch['id'] / 'batch.json'
        before = path.read_bytes()
        self.manager.append_styles(batch['id'], ['style-0', 'style-1', 'style-2', 'style-0'])
        self.assertEqual(path.read_bytes(), before)
        self.styles.append(synthetic_styles(4)[-1])
        self.manager.append_styles(batch['id'], ['style-0', 'style-3', 'style-3', 'style-1'])
        after = json.loads(path.read_text('utf-8'))
        self.assertEqual(after['items'][:3], json.loads(before)['items'])
        self.assertEqual([item['style_id'] for item in after['items']], ['style-0', 'style-1', 'style-2', 'style-3'])
        self.assertEqual((after['status'], after['items'][-1]['status']), ('paused', 'pending'))
        # Excluding a source later does not turn an existing batch item into a
        # new request or invalidate an idempotent duplicate append.
        self.styles.clear()
        duplicate = path.read_bytes()
        self.manager.append_styles(batch['id'], ['style-0', 'style-3'])
        self.assertEqual(path.read_bytes(), duplicate)

    def test_append_validation_is_atomic_for_unknown_removed_or_invalid_styles(self):
        batch = self.manager.create(synthetic_request())
        path = self.root / batch['id'] / 'batch.json'
        before = path.read_bytes()
        self.styles.append(synthetic_styles(4)[-1])
        for ids in (None, [], 'style-3', [4], ['../outside'], ['style-3', 'unknown'],
                    ['style-3', 'personal_missing'], ['style-3', 'excluded']):
            with self.subTest(ids=ids), self.assertRaises((ValueError, FileNotFoundError)):
                self.manager.append_styles(batch['id'], ids)
            self.assertEqual(path.read_bytes(), before)
        # A removed entry may still have a readable source/preview, but must not
        # enter a new generation request through get_style.
        self.catalog.get_style.return_value = synthetic_styles(1)[0]
        self.catalog.get_style.side_effect = None
        with self.assertRaises(FileNotFoundError):
            self.manager.append_styles(batch['id'], ['excluded'])
        self.assertEqual(path.read_bytes(), before)
        self.catalog.get_style.side_effect = lambda sid: copy.deepcopy(next(style for style in self.styles if style['id'] == sid))
        invalid = copy.deepcopy(self.styles[-1])
        invalid.update(id='personal_invalid')
        invalid['options']['steps'] = 0
        self.manager.personal_catalog = mock.Mock()
        self.manager.personal_catalog.get_style.return_value = invalid
        with self.assertRaises(ValueError):
            self.manager.append_styles(batch['id'], ['style-3', 'personal_invalid'])
        self.assertEqual(path.read_bytes(), before)
        self.generator.assert_not_called()

    def test_append_rejects_active_running_and_stopping_batches(self):
        batch = self.manager.create(synthetic_request())
        self.styles.append(synthetic_styles(4)[-1])
        path = self.root / batch['id'] / 'batch.json'
        for status in ('running', 'stopping'):
            stored = json.loads(path.read_text('utf-8'))
            stored['status'] = status
            path.write_text(json.dumps(stored), encoding='utf-8')
            before = path.read_bytes()
            with self.assertRaises(DakiStyleTestConflict):
                self.manager.append_styles(batch['id'], ['style-3'])
            self.assertEqual(path.read_bytes(), before)
        stored['status'] = 'paused'
        path.write_text(json.dumps(stored), encoding='utf-8')
        before = path.read_bytes()
        self.manager._active = (self.root.resolve(), batch['id'])
        with self.assertRaises(DakiStyleTestConflict):
            self.manager.append_styles(batch['id'], ['style-3'])
        self.assertEqual(path.read_bytes(), before)
        self.generator.assert_not_called()

    def test_create_freezes_source_settings_and_never_starts_generation(self):
        batch = self.manager.create(synthetic_request())
        self.assertEqual(batch['status'], 'ready')
        self.assertEqual(batch['pending'], 3)
        self.assertEqual(batch['total'], 3)
        self.generator.assert_not_called()
        self.styles[0]['options']['steps'] = 40
        self.styles[0]['positive'] = 'changed source'
        self.manager.run(batch['id'], 'next')
        self.assertTrue(self.manager.wait())
        payload = self.generator.call_args.args[1]
        self.assertEqual(payload['parameters']['steps'], 20)
        self.assertEqual(payload['parameters']['scale'], 4)
        self.assertEqual(payload['parameters']['sampler'], 'k_euler')
        self.assertIsInstance(payload['parameters']['seed'], int)
        self.assertEqual(payload['parameters']['seed'], payload['parameters']['extra_noise_seed'])
        self.assertFalse(payload['parameters']['prefer_brownian'])
        self.assertEqual(payload['parameters']['cfg_rescale'], 0)
        self.assertEqual(payload['input'], '1::0_synthetic_style::, synthetic common scene')
        self.assertEqual(payload['parameters']['negative_prompt'], 'synthetic_negative_0, synthetic common negative')
        self.assertEqual(payload['parameters']['v4_prompt']['caption']['char_captions'][0]['char_caption'], 'synthetic character')
        self.assertEqual(payload['parameters']['v4_negative_prompt']['caption']['char_captions'][0]['char_caption'], 'synthetic character negative')
        self.assertEqual(payload['model'], 'nai-diffusion-5-full')
        self.assertEqual(payload['action'], 'generate')
        self.assertNotIn(self.key, (self.root / batch['id'] / 'batch.json').read_text('utf-8'))

    def test_next_remaining_persist_images_metadata_and_summary(self):
        batch = self.manager.create(synthetic_request())
        self.manager.run(batch['id'], 'next')
        self.assertTrue(self.manager.wait())
        batch = self.manager.get(batch['id'])
        self.assertEqual((batch['status'], batch['completed'], batch['pending']), ('paused', 1, 2))
        path = self.manager.image_path(batch['id'], 'style-0', full=True)
        with Image.open(path) as image:
            info = json.loads(image.info['Comment'])
            self.assertEqual(info['model'], 'nai-diffusion-5-full')
            self.assertEqual(info['seed'], self.generator.call_args.args[1]['parameters']['seed'])
            self.assertEqual(info['seed'], batch['items'][0]['seed'])
            self.assertEqual(info['noise_schedule'], 'native')
            self.assertEqual(info['v4_prompt']['caption']['base_caption'], '1::0_synthetic_style::, synthetic common scene')
        self.assertEqual(self.manager.image_path(batch['id'], 'style-0').suffix, '.jpg')
        self.manager.run(batch['id'], 'remaining')
        self.assertTrue(self.manager.wait())
        completed = self.manager.get(batch['id'])
        self.assertEqual((completed['status'], completed['completed'], completed['pending']), ('completed', 3, 0))
        self.assertEqual(self.generator.call_count, 3)
        summary = self.new_manager().list_batches()[0]
        self.assertNotIn('items', summary)
        self.assertEqual(summary['completed'], 3)
        with self.assertRaises(DakiStyleTestConflict):
            self.manager.run(batch['id'], 'remaining')

    def test_medium_dispatch_and_png_keep_effective_settings_and_original_snapshot(self):
        self.styles = synthetic_styles(1)
        self.styles[0]['options'].update(steps=40, cfg=7.5, cfg_rescale=.8)
        originals = copy.deepcopy(self.styles)
        request = synthetic_request(model=V5_FULL_MEDIUM)
        batch = self.manager.create(request)
        self.assertEqual(batch['model'], V5_FULL_MEDIUM)
        self.assertEqual(batch['items'][0]['options'], originals[0]['options'])
        self.assertIsNone(batch['items'][0]['seed'])
        self.assertEqual(batch['paid_count'], 0)
        self.assertFalse(batch['requires_anlas'])
        self.assertFalse(batch['items'][0]['requires_anlas'])
        self.generator.assert_not_called()
        with mock.patch('naim.daki_style_tests.secrets.randbelow', return_value=123456):
            self.manager.run(batch['id'], 'next')
            self.assertTrue(self.manager.wait())
        payload = self.generator.call_args.args[1]
        parameters = payload['parameters']
        self.assertEqual(payload['model'], V5_FULL_MEDIUM)
        self.assertEqual(payload['action'], 'generate')
        self.assertEqual(payload['input'], originals[0]['positive'] + ', ' + request['prompt'])
        self.assertEqual((parameters['steps'], parameters['sampler'], parameters['noise_schedule']),
                         (14, 'k_euler_ancestral', 'karras'))
        self.assertEqual((parameters['scale'], parameters['width'], parameters['height']), (7.5, 64, 128))
        self.assertEqual((parameters['params_version'], parameters['tag_hint_uc_preset']), (4, 2))
        self.assertNotIn('cfg_rescale', parameters)
        self.assertFalse(parameters['prefer_brownian'])
        self.assertEqual(parameters['negative_prompt'], 'nsfw, ' + V5_HEAVY_UC)
        self.assertEqual(parameters['v4_negative_prompt']['caption']['base_caption'], parameters['negative_prompt'])
        positive_character = parameters['v4_prompt']['caption']['char_captions'][0]
        negative_character = parameters['v4_negative_prompt']['caption']['char_captions'][0]
        self.assertEqual(positive_character['char_caption'], 'synthetic character')
        self.assertEqual(negative_character, dict(positive_character, char_caption=''))
        self.assertEqual((parameters['seed'], parameters['extra_noise_seed']), (123456, 123456))
        completed = self.manager.get(batch['id'])
        self.assertEqual((completed['status'], completed['completed']), ('completed', 1))
        with Image.open(self.manager.image_path(batch['id'], 'style-0', full=True)) as image:
            metadata = json.loads(image.info['Comment'])
            self.assertEqual(metadata['model'], V5_FULL_MEDIUM)
            for key, value in parameters.items():
                self.assertEqual(metadata[key], value)
            self.assertNotIn('cfg_rescale', metadata)
        stored = json.loads((self.root / batch['id'] / 'batch.json').read_text('utf-8'))
        self.assertEqual(stored['items'][0]['style'], originals[0])
        self.assertEqual(self.styles, originals)

    def test_medium_ignores_unavailable_source_options_but_validates_cfg_and_size(self):
        style = synthetic_styles(1)[0]
        style['options'].update(steps=0, sampler='unsupported', noise_schedule='unsupported', cfg_rescale='stale')
        original = copy.deepcopy(style)
        for prompt, expected in (('synthetic scene', 'nsfw, ' + V5_HEAVY_UC), ('synthetic nsfw scene', V5_HEAVY_UC)):
            with self.subTest(prompt=prompt):
                payload = build_style_test_payload(style, synthetic_request(model=V5_FULL_MEDIUM, prompt=prompt))
                self.assertEqual(payload['parameters']['negative_prompt'], expected)
                self.assertNotIn('seed', payload['parameters'])
                self.assertEqual(payload['parameters']['steps'], 14)
        self.assertEqual(style, original)
        style['options']['cfg'] = float('nan')
        with self.assertRaises(ValueError):
            build_style_test_payload(style, synthetic_request(model=V5_FULL_MEDIUM))
        self.styles = synthetic_styles(1)
        self.styles[0]['preview'].update(width=1280, height=1024)
        batch = self.manager.create(synthetic_request(model=V5_FULL_MEDIUM))
        self.assertTrue(batch['items'][0]['requires_anlas'])
        with self.assertRaises(DakiAnlasConfirmation):
            self.manager.run(batch['id'], 'next')
        self.generator.assert_not_called()

    def test_custom_dimensions_apply_to_requests_and_png_without_changing_sources(self):
        self.styles[1]['preview'].update(width=1280, height=1024)
        original = copy.deepcopy(self.styles)
        batch = self.manager.create(synthetic_request(model=V5_FULL_MEDIUM, width=128, height=192))
        self.assertEqual((batch['width'], batch['height'], batch['paid_count']), (128, 192, 0))
        self.assertTrue(all((item['width'], item['height']) == (128, 192) for item in batch['items']))
        self.manager.run(batch['id'], 'remaining')
        self.assertTrue(self.manager.wait())
        for item in self.manager.get(batch['id'])['items']:
            self.assertEqual(item['model'], V5_FULL_MEDIUM)
            with Image.open(self.manager.image_path(batch['id'], item['style_id'], full=True)) as image:
                metadata = json.loads(image.info['Comment'])
                self.assertEqual(image.size, (128, 192))
                self.assertEqual((metadata['width'], metadata['height']), (128, 192))
                self.assertEqual(metadata['steps'], 14)
        stored = json.loads((self.root / batch['id'] / 'batch.json').read_text('utf-8'))
        self.assertEqual([item['style'] for item in stored['items']], original)
        self.assertEqual(self.styles, original)
        paid = self.manager.create(synthetic_request(width=1472, height=1472))
        self.assertEqual(paid['paid_count'], len(self.styles))
        with self.assertRaises(DakiAnlasConfirmation):
            self.manager.run(paid['id'], 'remaining')

    def test_original_dimensions_and_old_batches_keep_source_sizes(self):
        self.styles[1]['preview'].update(width=128, height=192)
        for request in (synthetic_request(), synthetic_request(width=None, height=None)):
            batch = self.manager.create(request)
            self.assertIsNone(batch['width'])
            self.assertIsNone(batch['height'])
            self.assertEqual([(item['width'], item['height']) for item in batch['items']], [(64, 128), (128, 192), (64, 128)])
        path = self.root / batch['id'] / 'batch.json'
        stored = json.loads(path.read_text('utf-8'))
        stored.pop('width')
        stored.pop('height')
        path.write_text(json.dumps(stored), encoding='utf-8')
        self.assertIsNone(self.manager.get(batch['id'])['width'])
        summary = next(item for item in self.manager.list_batches() if item['id'] == batch['id'])
        self.assertIsNone(summary['height'])

    def test_invalid_dimensions_are_rejected_before_persistence(self):
        for change in ({'width': 64}, {'height': 128}, {'width': None, 'height': 128},
                       {'width': '64', 'height': 128}, {'width': True, 'height': 128},
                       {'width': 64.5, 'height': 128}, {'width': 64, 'height': 0},
                       {'width': 49216, 'height': 64}, {'width': 65, 'height': 128},
                       {'width': 2048, 'height': 2048}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.manager.create(synthetic_request(**change))
        self.assertFalse(self.root.exists())
        self.generator.assert_not_called()

    def test_all_naia_and_daki_size_presets_build_for_override_and_original_dimensions(self):
        self.assertEqual([band['id'] for band in SIZE_PRESETS], ['small', 'normal', 'large', 'wallpaper', 'daki'])
        self.assertEqual(sum(len(band['sizes']) for band in SIZE_PRESETS), 35)
        self.assertEqual(SIZE_PRESETS[-1]['sizes'], [[320, 1024], [512, 1664], [640, 2048],
                                                    [960, 3072], [1024, 3072]])
        self.assertEqual(SIZE_LIMITS, {'min': 64, 'max': 49152, 'step': 64, 'max_pixels': 3145728})
        for band in SIZE_PRESETS:
            for width, height in band['sizes']:
                with self.subTest(band=band['id'], width=width, height=height):
                    style = synthetic_styles(1)[0]
                    payload = build_style_test_payload(style, synthetic_request(width=width, height=height))
                    self.assertEqual((payload['parameters']['width'], payload['parameters']['height']), (width, height))
                    style['preview'].update(width=width, height=height)
                    original = build_style_test_payload(style, synthetic_request())
                    self.assertEqual((original['parameters']['width'], original['parameters']['height']), (width, height))

    def test_official_pixel_budget_accepts_all_supported_models_and_has_no_2048_axis_cap(self):
        for model in ('nai-diffusion-5-full', V5_FULL_MEDIUM, 'nai-diffusion-4-5-full'):
            for width, height in ((960, 3072), (1024, 3072), (2048, 1536), (49152, 64), (64, 49152)):
                with self.subTest(model=model, width=width, height=height):
                    style = synthetic_styles(1)[0]
                    payload = build_style_test_payload(style, synthetic_request(model=model, width=width, height=height))
                    self.assertEqual((payload['parameters']['width'], payload['parameters']['height']), (width, height))
                    style['preview'].update(width=width, height=height)
                    original = build_style_test_payload(style, synthetic_request(model=model))
                    self.assertEqual((original['parameters']['width'], original['parameters']['height']), (width, height))
            for width, height in ((2048, 2048), (1088, 3072), (1024, 3136), (49216, 64), (64, 49216), (1280, 4096)):
                with self.subTest(model=model, width=width, height=height), self.assertRaises(ValueError):
                    self.manager.create(synthetic_request(model=model, width=width, height=height))
        with self.assertRaisesRegex(ValueError, '3,145,728'):
            build_style_test_payload(synthetic_styles(1)[0], synthetic_request(width=2048, height=2048))
        self.assertFalse(self.root.exists())
        self.generator.assert_not_called()

    def test_maximum_area_batch_still_requires_anlas_consent_without_generating(self):
        for model in ('nai-diffusion-5-full', V5_FULL_MEDIUM, 'nai-diffusion-4-5-full'):
            with self.subTest(model=model):
                batch = self.manager.create(synthetic_request(model=model, width=1024, height=3072))
                self.assertEqual(batch['paid_count'], len(self.styles))
                with self.assertRaises(DakiAnlasConfirmation):
                    self.manager.run(batch['id'], 'next')
        self.generator.assert_not_called()

    def test_candidate_recipes_use_completed_payload_even_after_common_settings_change(self):
        batch = self.manager.create(synthetic_request(prompt='synthetic_hair'))
        self.manager.run(batch['id'], 'next')
        self.assertTrue(self.manager.wait())
        self.manager.update_settings(batch['id'], synthetic_request(prompt='synthetic_shirt'))
        path = self.root / batch['id'] / 'batch.json'
        before = path.read_bytes()
        reopened = self.new_manager()
        rows = list(reopened.iter_completed_prompt_images())
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['path'], f"__daki_tests__/{batch['id']}/style-0.png")
        self.assertIn('synthetic_hair', rows[0]['prompt_info']['prompt'])
        self.assertNotIn('synthetic_shirt', rows[0]['prompt_info']['prompt'])
        self.assertEqual(path.read_bytes(), before)

    def test_update_before_first_generation_uses_frozen_styles_and_can_restore_original_size(self):
        self.styles[1]['preview'].update(width=128, height=192)
        originals = copy.deepcopy(self.styles)
        batch = self.manager.create(synthetic_request())
        self.styles.clear()
        self.catalog.list_styles.reset_mock()
        updated = self.manager.update_settings(batch['id'], synthetic_request(model=V5_FULL_MEDIUM, width=192, height=256, prompt='changed scene'))
        self.assertEqual((updated['id'], updated['status'], updated['model']), (batch['id'], 'ready', V5_FULL_MEDIUM))
        self.assertEqual((updated['width'], updated['height']), (192, 256))
        self.assertTrue(all(item['seed'] is None for item in updated['items']))
        restored = self.manager.update_settings(batch['id'], synthetic_request(model='nai-diffusion-4-5-full', width=None, height=None))
        self.assertIsNone(restored['width'])
        self.assertEqual([(item['width'], item['height']) for item in restored['items']], [(64, 128), (128, 192), (64, 128)])
        stored = json.loads((self.root / batch['id'] / 'batch.json').read_text('utf-8'))
        self.assertEqual([item['style'] for item in stored['items']], originals)
        self.assertEqual([item['payload']['parameters']['steps'] for item in stored['items']], [20, 21, 22])
        self.assertEqual(updated['missing_shared_style_ids'], [])
        self.assertEqual(restored['missing_shared_style_ids'], [])
        self.catalog.get_style.assert_not_called()
        self.generator.assert_not_called()

    def test_update_preserves_completed_and_failed_requests_and_only_generates_changed_pending_item(self):
        batch = self.manager.create(synthetic_request())
        self.manager.run(batch['id'], 'next')
        self.assertTrue(self.manager.wait())
        first_image = self.manager.image_path(batch['id'], 'style-0', full=True)
        original_bytes = first_image.read_bytes()
        self.generator.side_effect = ValueError('synthetic failure')
        self.manager.run(batch['id'], 'next')
        self.assertTrue(self.manager.wait())
        path = self.root / batch['id'] / 'batch.json'
        before = json.loads(path.read_text('utf-8'))
        updated = self.manager.update_settings(batch['id'], synthetic_request(model=V5_FULL_MEDIUM, width=128, height=192,
            prompt='changed scene', char_prompts=[{'prompt': 'changed character', 'negative_prompt': 'ignored negative'}]))
        self.assertEqual((updated['status'], updated['completed'], updated['failed'], updated['pending']), ('failed', 1, 1, 1))
        self.assertEqual([item['model'] for item in updated['items']], ['nai-diffusion-5-full', 'nai-diffusion-5-full', V5_FULL_MEDIUM])
        after = json.loads(path.read_text('utf-8'))
        self.assertEqual(after['items'][:2], before['items'][:2])
        self.assertEqual(after['items'][2]['style'], before['items'][2]['style'])
        self.assertEqual(first_image.read_bytes(), original_bytes)
        self.generator.side_effect = lambda key, payload: Image.new('RGB', (payload['parameters']['width'], payload['parameters']['height']), 'red')
        self.manager.run(batch['id'], 'remaining')
        self.assertTrue(self.manager.wait())
        self.assertEqual(self.generator.call_count, 3)
        payload = self.generator.call_args.args[1]
        self.assertEqual(payload['input'], self.styles[2]['positive'] + ', changed scene')
        with Image.open(self.manager.image_path(batch['id'], 'style-2', full=True)) as image:
            metadata = json.loads(image.info['Comment'])
            self.assertEqual((image.size, metadata['model'], metadata['steps']), ((128, 192), V5_FULL_MEDIUM, 14))
            self.assertEqual(metadata['v4_prompt']['caption']['char_captions'][0]['char_caption'], 'changed character')
            self.assertEqual(metadata['v4_negative_prompt']['caption']['char_captions'][0]['char_caption'], '')
        self.assertEqual(first_image.read_bytes(), original_bytes)
        with self.assertRaises(DakiStyleTestConflict):
            self.manager.update_settings(batch['id'], synthetic_request())

    def test_invalid_updates_leave_entire_batch_unchanged(self):
        batch = self.manager.create(synthetic_request())
        path = self.root / batch['id'] / 'batch.json'
        before = path.read_bytes()
        for data in ([], synthetic_request(model='unknown'), synthetic_request(prompt=[]),
                     synthetic_request(width=128), synthetic_request(char_prompts=[4])):
            with self.subTest(data=data), self.assertRaises((ValueError, TypeError)):
                self.manager.update_settings(batch['id'], data)
            self.assertEqual(path.read_bytes(), before)
        stored = json.loads(before)
        stored['items'][1]['style']['options']['cfg'] = 0
        path.write_text(json.dumps(stored), encoding='utf-8')
        before = path.read_bytes()
        with self.assertRaises(ValueError):
            self.manager.update_settings(batch['id'], synthetic_request(model=V5_FULL_MEDIUM, prompt='changed scene'))
        self.assertEqual(path.read_bytes(), before)
        self.generator.assert_not_called()

    def test_running_and_stopping_batches_reject_setting_updates(self):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def generate(key, payload):
            entered.set()
            if not release.wait(5):
                raise ValueError('synthetic timeout')
            return Image.new('RGB', (64, 128), 'green')
        self.generator.side_effect = generate
        batch = self.manager.create(synthetic_request())
        self.manager.run(batch['id'], 'remaining')
        self.assertTrue(entered.wait(5))
        path = self.root / batch['id'] / 'batch.json'
        for stop in (False, True):
            if stop:
                self.manager.stop(batch['id'])
            before = path.read_bytes()
            with self.assertRaises(DakiStyleTestConflict):
                self.manager.update_settings(batch['id'], synthetic_request(width=128, height=192))
            self.assertEqual(path.read_bytes(), before)
        release.set()
        self.assertTrue(self.manager.wait())
        updated = self.manager.update_settings(batch['id'], synthetic_request(width=128, height=192))
        self.assertEqual((updated['status'], updated['pending']), ('paused', 2))

    def test_stop_finishes_only_current_image_and_blocks_parallel_runs(self):
        entered, release = threading.Event(), threading.Event()
        def generate(key, payload):
            entered.set()
            if not release.wait(5):
                raise ValueError('synthetic timeout')
            return Image.new('RGB', (64, 128), 'green')
        self.generator.side_effect = generate
        batch = self.manager.create(synthetic_request())
        other = self.manager.create(synthetic_request())
        self.manager.run(batch['id'], 'remaining')
        self.assertTrue(entered.wait(5))
        with self.assertRaises(DakiStyleTestConflict):
            self.manager.run(other['id'], 'next')
        stopped = self.manager.stop(batch['id'])
        self.assertEqual(stopped['status'], 'stopping')
        release.set()
        self.assertTrue(self.manager.wait())
        after = self.manager.get(batch['id'])
        self.assertEqual((after['status'], after['completed'], after['pending']), ('paused', 1, 2))
        self.assertEqual(self.generator.call_count, 1)
        first_seed = after['items'][0]['seed']
        self.manager.run(batch['id'], 'next')
        self.assertTrue(self.manager.wait())
        resumed = self.manager.get(batch['id'])
        self.assertEqual(resumed['completed'], 2)
        self.assertEqual(resumed['items'][0]['seed'], first_seed)

    def test_completed_image_visible_while_remaining_request_runs(self):
        second_entered, release = threading.Event(), threading.Event()
        def generate(key, payload):
            if payload['input'].startswith(self.styles[1]['positive']):
                second_entered.set()
                if not release.wait(5):
                    raise ValueError('synthetic timeout')
            return Image.new('RGB', (64, 128), 'green')
        self.generator.side_effect = generate
        batch = self.manager.create(synthetic_request())
        self.manager.run(batch['id'], 'remaining')
        self.assertTrue(second_entered.wait(5))
        during = self.manager.get(batch['id'])
        self.assertEqual(during['items'][0]['status'], 'completed')
        self.assertIn('src', during['items'][0])
        self.assertEqual(during['items'][1]['status'], 'running')
        self.manager.stop(batch['id'])
        release.set()
        self.assertTrue(self.manager.wait())
        self.assertEqual(self.manager.get(batch['id'])['completed'], 2)

    def test_failure_stops_without_retry_and_next_skips_failed(self):
        self.generator.side_effect = [ValueError('synthetic failure ' + self.key), Image.new('RGB', (64, 128))]
        batch = self.manager.create(synthetic_request())
        self.manager.run(batch['id'], 'remaining')
        self.assertTrue(self.manager.wait())
        failed = self.manager.get(batch['id'])
        self.assertEqual((failed['status'], failed['failed'], failed['pending']), ('failed', 1, 2))
        self.assertNotIn(self.key, failed['items'][0]['error'])
        self.assertEqual(self.generator.call_count, 1)
        self.manager.run(batch['id'], 'next')
        self.assertTrue(self.manager.wait())
        self.assertTrue(self.generator.call_args.args[1]['input'].startswith(self.styles[1]['positive']))
        self.assertEqual(self.manager.get(batch['id'])['completed'], 1)

    def test_retry_failed_keeps_completed_and_pending_items_and_reuses_payload_with_fresh_seed(self):
        batch = self.manager.create(synthetic_request())
        with mock.patch('naim.daki_style_tests.secrets.randbelow', side_effect=[100, 200, 300]):
            self.manager.run(batch['id'], 'next')
            self.assertTrue(self.manager.wait())
            completed = self.manager.image_path(batch['id'], 'style-0', full=True)
            completed_bytes = completed.read_bytes()
            self.generator.side_effect = ValueError('synthetic failure')
            self.manager.run(batch['id'], 'next')
            self.assertTrue(self.manager.wait())
            self.manager.update_settings(batch['id'], synthetic_request(prompt='pending scene', width=128, height=192))
            path = self.root / batch['id'] / 'batch.json'
            before = json.loads(path.read_text('utf-8'))
            self.key = 'synthetic-replacement-key'
            def retry(key, payload):
                running = self.manager.get(batch['id'])['items'][1]
                self.assertEqual(running['status'], 'running')
                self.assertNotIn('error', running)
                return Image.new('RGB', (64, 128), 'green')
            self.generator.side_effect = retry
            self.manager.run(batch['id'], 'retry_failed')
            self.assertTrue(self.manager.wait())
        after = json.loads(path.read_text('utf-8'))
        self.assertEqual(after['items'][0], before['items'][0])
        self.assertEqual(after['items'][2], before['items'][2])
        self.assertEqual(completed.read_bytes(), completed_bytes)
        expected = copy.deepcopy(before['items'][1]['payload'])
        expected['parameters'].update(seed=300, extra_noise_seed=300)
        self.assertEqual(self.generator.call_args, mock.call(self.key, expected))
        self.assertEqual(after['items'][1]['payload'], expected)
        self.assertNotIn('error', after['items'][1])
        result = self.manager.get(batch['id'])
        self.assertEqual((result['status'], result['completed'], result['pending'], result['failed']), ('paused', 2, 1, 0))
        self.assertEqual(self.generator.call_count, 3)

    def test_retry_failed_works_without_pending_requests(self):
        self.styles = synthetic_styles(2)
        batch = self.manager.create(synthetic_request())
        self.generator.side_effect = ValueError('synthetic failure')
        for _ in range(2):
            self.manager.run(batch['id'], 'remaining')
            self.assertTrue(self.manager.wait())
        self.assertEqual(self.manager.get(batch['id'])['pending'], 0)
        self.generator.side_effect = lambda key, payload: Image.new('RGB', (64, 128), 'green')
        self.manager.run(batch['id'], 'retry_failed')
        self.assertTrue(self.manager.wait())
        result = self.manager.get(batch['id'])
        self.assertEqual((result['status'], result['completed'], result['failed']), ('completed', 2, 0))
        self.assertEqual(self.generator.call_count, 4)

    def test_retry_failed_stops_after_new_failure_without_repeating(self):
        batch = self.manager.create(synthetic_request())
        self.generator.side_effect = ValueError('synthetic failure')
        for _ in range(2):
            self.manager.run(batch['id'], 'next')
            self.assertTrue(self.manager.wait())
        self.generator.reset_mock()
        self.manager.run(batch['id'], 'retry_failed')
        self.assertTrue(self.manager.wait())
        self.assertEqual(self.generator.call_count, 1)
        result = self.manager.get(batch['id'])
        self.assertEqual((result['status'], result['failed'], result['pending']), ('failed', 2, 1))

    def test_retry_failed_checks_its_paid_payloads_and_refusal_leaves_storage_unchanged(self):
        self.styles[0]['options']['steps'] = 40
        batch = self.manager.create(synthetic_request())
        self.generator.side_effect = ValueError('synthetic failure')
        self.manager.run(batch['id'], 'next', allow_anlas=True)
        self.assertTrue(self.manager.wait())
        path = self.root / batch['id'] / 'batch.json'
        before = path.read_bytes()
        self.generator.reset_mock()
        for consent in (False, 1):
            with self.assertRaises(DakiAnlasConfirmation):
                self.manager.run(batch['id'], 'retry_failed', allow_anlas=consent)
            self.assertEqual(path.read_bytes(), before)
        self.generator.assert_not_called()
        self.generator.side_effect = lambda key, payload: Image.new('RGB', (64, 128), 'green')
        self.manager.run(batch['id'], 'retry_failed', allow_anlas=True)
        self.assertTrue(self.manager.wait())
        self.assertEqual(self.generator.call_args.args[1]['parameters']['steps'], 40)
        self.assertEqual(self.manager.get(batch['id'])['pending'], 2)

    def test_retry_failed_ignores_paid_pending_requests_and_can_stop_between_failures(self):
        self.styles[2]['options']['steps'] = 40
        batch = self.manager.create(synthetic_request())
        self.generator.side_effect = ValueError('synthetic failure')
        for _ in range(2):
            self.manager.run(batch['id'], 'next')
            self.assertTrue(self.manager.wait())
        before = json.loads((self.root / batch['id'] / 'batch.json').read_text('utf-8'))
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def generate(key, payload):
            entered.set()
            if not release.wait(5):
                raise ValueError('synthetic timeout')
            return Image.new('RGB', (64, 128), 'green')
        self.generator.reset_mock()
        self.generator.side_effect = generate
        self.manager.run(batch['id'], 'retry_failed')
        self.assertTrue(entered.wait(5))
        path = self.root / batch['id'] / 'batch.json'
        running = path.read_bytes()
        with self.assertRaises(DakiStyleTestConflict):
            self.manager.run(batch['id'], 'retry_failed')
        self.assertEqual(path.read_bytes(), running)
        self.assertEqual(self.manager.stop(batch['id'])['status'], 'stopping')
        release.set()
        self.assertTrue(self.manager.wait())
        after = json.loads(path.read_text('utf-8'))
        self.assertEqual(after['items'][1:], before['items'][1:])
        self.assertEqual(after['items'][0]['status'], 'completed')
        self.assertEqual(self.generator.call_count, 1)

    def test_retry_failed_rejects_missing_failures_and_key_before_mutation(self):
        batch = self.manager.create(synthetic_request())
        path = self.root / batch['id'] / 'batch.json'
        before = path.read_bytes()
        with self.assertRaises(DakiStyleTestConflict):
            self.manager.run(batch['id'], 'retry_failed')
        self.assertEqual(path.read_bytes(), before)
        self.generator.side_effect = ValueError('synthetic failure')
        self.manager.run(batch['id'], 'next')
        self.assertTrue(self.manager.wait())
        self.key = ''
        before = path.read_bytes()
        with self.assertRaises(ValueError):
            self.manager.run(batch['id'], 'retry_failed')
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(self.generator.call_count, 1)

    def test_restart_marks_inflight_uncertain_and_never_replays_it(self):
        batch = self.manager.create(synthetic_request())
        path = self.root / batch['id'] / 'batch.json'
        stored = json.loads(path.read_text('utf-8'))
        stored['status'] = 'running'
        stored['items'][0]['status'] = 'running'
        path.write_text(json.dumps(stored), encoding='utf-8')
        restarted = self.new_manager()
        self.addCleanup(lambda: restarted.wait(5))
        recovered = restarted.get(batch['id'])
        self.assertEqual(recovered['status'], 'failed')
        self.assertEqual(recovered['items'][0]['status'], 'failed')
        self.generator.assert_not_called()
        restarted.run(batch['id'], 'remaining')
        self.assertTrue(restarted.wait())
        self.assertEqual(self.generator.call_count, 2)
        self.assertEqual([call.args[1]['input'] for call in self.generator.call_args_list],
                         [style['positive'] + ', synthetic common scene' for style in self.styles[1:]])

    def test_seed_is_fresh_per_dispatch_and_completed_results_keep_the_used_seed(self):
        self.styles[0]['seed'] = 2 ** 64 + 123
        self.styles[1]['seed'] = 'source metadata only'
        self.styles[2].pop('seed')
        originals = copy.deepcopy(self.styles)
        with mock.patch('naim.daki_style_tests.secrets.randbelow', side_effect=[12345, 23456, 34567]) as random_seed:
            payload = build_style_test_payload(self.styles[0], synthetic_request())
            self.assertNotIn('seed', payload['parameters'])
            batch = self.manager.create(synthetic_request())
            self.assertTrue(all(item['seed'] is None for item in batch['items']))
            random_seed.assert_not_called()
            # A batch saved by an older version may still contain source seeds.
            path = self.root / batch['id'] / 'batch.json'
            stored = json.loads(path.read_text('utf-8'))
            for item in stored['items']:
                item['payload']['parameters'].update(seed=2 ** 64 + 123, extra_noise_seed=100)
            path.write_text(json.dumps(stored), encoding='utf-8')
            self.manager.run(batch['id'], 'next')
            self.assertTrue(self.manager.wait())
            first = self.manager.image_path(batch['id'], 'style-0', full=True).read_bytes()
            self.assertEqual(self.manager.get(batch['id'])['items'][0]['seed'], 12345)
            self.manager.run(batch['id'], 'remaining')
            self.assertTrue(self.manager.wait())
            self.assertEqual(random_seed.call_args_list, [mock.call(2 ** 32)] * 3)
            self.assertEqual(self.manager.image_path(batch['id'], 'style-0', full=True).read_bytes(), first)
            completed = self.new_manager().get(batch['id'])
            self.assertEqual([item['seed'] for item in completed['items']], [12345, 23456, 34567])
            for call, seed in zip(self.generator.call_args_list, [12345, 23456, 34567]):
                parameters = call.args[1]['parameters']
                self.assertEqual((parameters['seed'], parameters['extra_noise_seed'], parameters['n_samples']),
                                 (seed, seed, 1))
            for item in completed['items']:
                with Image.open(self.manager.image_path(batch['id'], item['style_id'], full=True)) as image:
                    info = json.loads(image.info['Comment'])
                    self.assertEqual(info['seed'], item['seed'])
                    self.assertEqual(info['extra_noise_seed'], item['seed'])
            with self.assertRaises(DakiStyleTestConflict):
                self.manager.run(batch['id'], 'remaining')
            self.assertEqual(random_seed.call_count, 3)
        self.assertEqual(self.styles, originals)

    def test_anlas_confirmation_checks_only_the_selected_pending_requests(self):
        self.styles[1]['options']['steps'] = 40
        batch = self.manager.create(synthetic_request())
        self.assertEqual(batch['paid_count'], 1)
        self.assertTrue(batch['requires_anlas'])
        with self.assertRaises(DakiAnlasConfirmation):
            self.manager.run(batch['id'], 'remaining')
        self.generator.assert_not_called()
        self.manager.run(batch['id'], 'next')
        self.assertTrue(self.manager.wait())
        with self.assertRaises(DakiAnlasConfirmation):
            self.manager.run(batch['id'], 'next', allow_anlas=1)
        self.manager.run(batch['id'], 'next', allow_anlas=True)
        self.assertTrue(self.manager.wait())
        self.assertEqual(self.generator.call_args.args[1]['parameters']['steps'], 40)

    def test_validation_and_missing_key_never_start_requests(self):
        for changes in ({'prompt': []}, {'model': 'unsupported-model'}, {'char_prompts': [4]}, {'char_prompts': ['x'] * 7}):
            request = synthetic_request()
            request.update(changes)
            with self.assertRaises(ValueError):
                self.manager.create(request)
        batch = self.manager.create(synthetic_request())
        self.key = ''
        with self.assertRaises(ValueError):
            self.manager.run(batch['id'], 'next')
        self.assertEqual(self.manager.get(batch['id'])['status'], 'ready')
        for invalid in ('../outside', '', 'abc', 'A' * 32):
            with self.assertRaises(ValueError):
                self.manager.get(invalid)
        with self.assertRaises(ValueError):
            self.manager.image_path(batch['id'], '../secret', True)
        self.generator.assert_not_called()

    def test_empty_common_prompt_uses_style_and_optional_characters(self):
        batch = self.manager.create(synthetic_request(prompt='', negative_prompt=''))
        self.manager.run(batch['id'], 'next')
        self.assertTrue(self.manager.wait())
        payload = self.generator.call_args.args[1]
        self.assertEqual(payload['input'], self.styles[0]['positive'])
        self.assertEqual(payload['parameters']['negative_prompt'], self.styles[0]['negative'])
        self.assertEqual(payload['parameters']['v4_prompt']['caption']['char_captions'][0]['char_caption'], 'synthetic character')

    def test_source_generation_validation_precedes_persistence(self):
        for change in ({'steps': 0}, {'cfg': float('nan')}, {'sampler': 'unknown'}, {'prefer_brownian': 'false'}):
            self.styles = synthetic_styles(1)
            self.styles[0]['options'].update(change)
            with self.assertRaises(ValueError):
                self.manager.create(synthetic_request())
        self.styles = synthetic_styles(1)
        self.styles[0]['preview']['width'] = 65
        with self.assertRaises(ValueError):
            self.manager.create(synthetic_request())
        self.assertEqual(self.manager.list_batches(), [])

    def test_stop_before_first_request_does_not_call_generator(self):
        batch = self.manager.create(synthetic_request())
        # Hold the worker at its first state transition until stop is recorded.
        with self.manager.lock:
            self.manager.run(batch['id'], 'remaining')
            self.manager.stop(batch['id'])
        self.assertTrue(self.manager.wait())
        self.generator.assert_not_called()
        self.assertEqual(self.manager.get(batch['id'])['pending'], 3)

    def test_save_failure_does_not_expose_paths_or_retry_paid_request(self):
        batch = self.manager.create(synthetic_request())
        with mock.patch.object(self.manager, '_save_image', side_effect=OSError('synthetic/private/path')):
            self.manager.run(batch['id'], 'remaining')
            self.assertTrue(self.manager.wait())
        after = self.manager.get(batch['id'])
        self.assertEqual((after['status'], after['failed'], self.generator.call_count), ('failed', 1, 1))
        self.assertNotIn('synthetic/private/path', after['items'][0]['error'])

    def test_inflight_snapshot_must_be_saved_before_generation(self):
        batch = self.manager.create(synthetic_request())
        save = self.manager._save
        def fail_inflight(root, state):
            if any(item['status'] == 'running' for item in state['items']):
                raise OSError('synthetic write failure')
            return save(root, state)
        with mock.patch.object(self.manager, '_save', side_effect=fail_inflight):
            self.manager.run(batch['id'], 'remaining')
            self.assertTrue(self.manager.wait())
        self.generator.assert_not_called()
        self.assertEqual(self.manager.get(batch['id'])['status'], 'failed')

    def test_replaced_batch_file_cannot_escape_results_directory(self):
        batch = self.manager.create(synthetic_request())
        resolve = Path.resolve
        outside = Path(self.temp.name) / 'outside.json'
        def redirect(path, *args, **kwargs):
            return outside if path.name == 'batch.json' else resolve(path, *args, **kwargs)
        with mock.patch.object(Path, 'resolve', redirect):
            with self.assertRaises(ValueError):
                self.manager.get(batch['id'])


class DakiTextGenerationTransportTests(unittest.TestCase):
    @staticmethod
    def archive():
        png = io.BytesIO()
        Image.new('RGBA', (64, 128), 'purple').save(png, 'PNG')
        result = io.BytesIO()
        with zipfile.ZipFile(result, 'w') as output:
            output.writestr('result.png', png.getvalue())
        return result.getvalue()

    def test_v5_multipart_and_v45_json_do_not_change_existing_transport(self):
        for model in ('nai-diffusion-5-full', V5_FULL_MEDIUM, 'nai-diffusion-4-5-full'):
            with self.subTest(model=model):
                payload = build_style_test_payload(synthetic_styles(1)[0], synthetic_request(model=model))
                response = mock.MagicMock()
                response.__enter__.return_value.read.return_value = self.archive()
                opener = mock.Mock()
                opener.open.return_value = response
                with mock.patch('naim.novelai.urllib.request.build_opener', return_value=opener):
                    image = generate_text_image('synthetic-key', payload)
                self.assertEqual(image.size, (64, 128))
                request = opener.open.call_args.args[0]
                self.assertEqual(request.get_header('Authorization'), 'Bearer synthetic-key')
                self.assertEqual(opener.open.call_count, 1)
                self.assertNotIn(b'synthetic-key', request.data)
                if model.startswith('nai-diffusion-5'):
                    self.assertIn('multipart/form-data', request.get_header('Content-type'))
                    encoded = request.data.split(b'\r\n\r\n', 1)[1].rsplit(b'\r\n--', 1)[0]
                    self.assertEqual(json.loads(encoded), payload)
                else:
                    self.assertEqual(json.loads(request.data), payload)
                image.close()

    def test_transport_http_error_redacts_response_and_never_retries(self):
        opener = mock.Mock()
        opener.open.side_effect = urllib.error.HTTPError('synthetic', 429, 'synthetic', {}, io.BytesIO(b'synthetic-key'))
        with mock.patch('naim.novelai.urllib.request.build_opener', return_value=opener):
            with self.assertRaisesRegex(ValueError, 'HTTP 429') as error:
                generate_text_image('synthetic-key', {'model': 'nai-diffusion-5-full', 'action': 'generate', 'parameters': {}})
        self.assertNotIn('synthetic-key', str(error.exception))
        self.assertEqual(opener.open.call_count, 1)

    def test_transport_rejects_other_actions_without_request(self):
        with mock.patch('naim.novelai.urllib.request.build_opener') as opener:
            with self.assertRaises(ValueError):
                generate_text_image('synthetic-key', {'model': 'nai-diffusion-5-full', 'action': 'infill'})
        opener.assert_not_called()
