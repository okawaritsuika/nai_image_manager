"""Exercise draft requests only against synthetic images and injected generators."""
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

from flask import Flask
from PIL import Image

from naim.daki_drafts import DakiDrafts, build_draft_payload, normalize_draft_settings
from naim.daki_image_refs import parse_daki_image_reference, resolve_daki_image_reference
from naim.daki_style_tests import DakiAnlasConfirmation, DakiStyleTestConflict
from naim.images.prompt_metadata import extract_prompt_info_from_image
from naim.web.daki_drafts import register_daki_draft_routes


def synthetic_settings(**changes):
    return {'prompt': 'synthetic ink, blue shape', 'negative_prompt': 'synthetic blur',
            'model': 'nai-diffusion-5-full', 'width': 128, 'height': 192,
            'seed': -1, 'char_prompts': [], **changes}


def synthetic_image(key, payload):
    parameters = payload['parameters']
    return Image.new('RGBA', (parameters['width'], parameters['height']), (20, 40, 80, 255))


class DraftSettingsTests(unittest.TestCase):
    def test_defaults_and_selected_style_metadata_do_not_repeat_style_prompts(self):
        defaults = normalize_draft_settings({})
        self.assertEqual((defaults['width'], defaults['height'], defaults['seed']), (512, 768, -1))
        settings = normalize_draft_settings(synthetic_settings(style={
            'id': 'sample-style', 'name': 'Synthetic ink', 'library': 'shared',
            'positive': 'synthetic ink', 'negative': 'synthetic blur', 'path': 'not retained'},
            key='not retained', unknown='not retained'))
        self.assertEqual(settings['style']['positive'], 'synthetic ink')
        self.assertNotIn('path', settings['style'])
        self.assertNotIn('key', settings)
        self.assertNotIn('unknown', settings)
        payload = build_draft_payload(settings)
        self.assertEqual(payload['input'], 'synthetic ink, blue shape')
        self.assertEqual(payload['parameters']['negative_prompt'], 'synthetic blur')

    def test_character_limits_and_custom_positions_reach_both_captions(self):
        characters = [{'prompt': f'synthetic character {index}', 'negative_prompt': f'blur {index}',
                       'x': .1, 'y': .8} for index in range(22)]
        settings = normalize_draft_settings(synthetic_settings(char_prompts=characters, character_positioning='custom'))
        payload = build_draft_payload(settings)
        for key in ('v4_prompt', 'v4_negative_prompt'):
            section = payload['parameters'][key]
            self.assertTrue(section['use_coords'])
            self.assertEqual(len(section['caption']['char_captions']), 22)
            self.assertEqual(section['caption']['char_captions'][0]['centers'], [{'x': .1, 'y': .8}])
        with self.assertRaises(ValueError):
            normalize_draft_settings(synthetic_settings(char_prompts=characters + characters[:1]))
        for count in (6, 7):
            values = synthetic_settings(model='nai-diffusion-4-5-full', char_prompts=characters[:count])
            if count == 6:
                self.assertEqual(len(normalize_draft_settings(values)['char_prompts']), 6)
            else:
                with self.assertRaises(ValueError):
                    normalize_draft_settings(values)

    def test_auto_position_retains_editable_coordinates_without_applying_them(self):
        settings = normalize_draft_settings(synthetic_settings(char_prompts=[{'prompt': 'synthetic figure', 'x': .1, 'y': .8}]))
        self.assertEqual(settings['char_prompts'][0]['x'], .1)
        section = build_draft_payload(settings)['parameters']['v4_prompt']
        self.assertFalse(section['use_coords'])
        self.assertEqual(section['caption']['char_captions'][0]['centers'], [{'x': .5, 'y': .5}])

    def test_medium_applies_fixed_parameters_and_fixed_character_negatives(self):
        settings = normalize_draft_settings(synthetic_settings(model='nai-diffusion-5-full-medium',
            options={'steps': 50, 'sampler': 'k_dpmpp_sde', 'noise_schedule': 'native', 'cfg_rescale': .8},
            char_prompts=[{'prompt': 'synthetic figure', 'negative_prompt': 'custom negative', 'x': .2}],
            character_positioning='custom'))
        payload = build_draft_payload(settings)
        parameters = payload['parameters']
        self.assertEqual(parameters['steps'], 14)
        self.assertEqual(parameters['sampler'], 'k_euler_ancestral')
        self.assertEqual(parameters['noise_schedule'], 'karras')
        self.assertNotIn('cfg_rescale', parameters)
        self.assertNotEqual(parameters['negative_prompt'], settings['negative_prompt'])
        negative = parameters['v4_negative_prompt']['caption']['char_captions'][0]
        self.assertEqual(negative['char_caption'], '')
        self.assertEqual(negative['centers'], [{'x': .2, 'y': .5}])

    def test_invalid_settings_fail_before_any_request(self):
        cases = [
            {'model': []}, {'model': 'unknown'}, {'width': 127}, {'width': 2048, 'height': 2048},
            {'height': True}, {'seed': 4294967296}, {'seed': True}, {'seed': -2}, {'seed': 1.5},
            {'seed': '1'}, {'options': []}, {'options': {'steps': 0}}, {'options': {'cfg': float('nan')}},
            {'options': {'sampler': 'unknown'}}, {'options': {'prefer_brownian': 1}},
            {'character_positioning': 'unknown'}, {'char_prompts': {}}, {'char_prompts': ['not a dict']},
            {'char_prompts': [{'prompt': None}]}, {'char_prompts': [{'x': float('inf')}]},
            {'char_prompts': [{'y': True}]}, {'char_prompts': [{'x': -1}]},
            {'prompt': []}, {'prompt': 'x' * 30001}, {'style': {'id': '../bad', 'library': 'shared'}},
            {'style': {'id': 'valid', 'library': 'unknown'}},
        ]
        for case in cases:
            with self.subTest(case=case), self.assertRaises((ValueError, TypeError)):
                normalize_draft_settings(synthetic_settings(**case))

    def test_drafts_use_the_shared_official_generation_size_limits_for_all_models(self):
        for model in ('nai-diffusion-5-full', 'nai-diffusion-5-full-medium', 'nai-diffusion-4-5-full'):
            for width, height in ((960, 3072), (1024, 3072), (2048, 1536), (49152, 64)):
                with self.subTest(model=model, width=width, height=height):
                    settings = normalize_draft_settings(synthetic_settings(model=model, width=width, height=height))
                    payload = build_draft_payload(settings)
                    self.assertEqual((payload['parameters']['width'], payload['parameters']['height']), (width, height))
            for width, height in ((2048, 2048), (1088, 3072), (49216, 64)):
                with self.subTest(model=model, width=width, height=height), self.assertRaises(ValueError):
                    normalize_draft_settings(synthetic_settings(model=model, width=width, height=height))


class DraftStorageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / 'drafts'
        self.key = 'synthetic-api-key'
        self.generator = mock.Mock(side_effect=synthetic_image)
        self.manager = DakiDrafts(self.root, lambda: self.key, self.generator)
        self.addCleanup(self.manager.wait)

    def create(self, **changes):
        draft = self.manager.create(synthetic_settings(**changes))
        self.assertEqual(draft['status'], 'running')
        self.assertTrue(self.manager.wait())
        return self.manager.get(draft['id'])

    def test_completed_draft_keeps_full_metadata_and_reloads_without_generation(self):
        draft = self.create(seed=123, character_positioning='custom', char_prompts=[
            {'prompt': 'synthetic character', 'negative_prompt': 'synthetic char blur', 'x': .25, 'y': .75}],
            options={'steps': 24, 'cfg': 4.5, 'cfg_rescale': .3, 'noise_schedule': 'native'})
        self.assertEqual(draft['status'], 'completed')
        self.assertEqual(draft['seed'], 123)
        path = self.manager.image_path(draft['id'], full=True)
        with Image.open(path) as image:
            metadata = json.loads(image.info['Comment'])
        self.assertEqual(metadata['seed'], 123)
        self.assertEqual(metadata['model'], draft['settings']['model'])
        self.assertEqual(metadata['cfg_rescale'], .3)
        self.assertEqual(metadata['v4_prompt']['caption']['char_captions'][0]['centers'], [{'x': .25, 'y': .75}])
        self.assertEqual(metadata['v4_negative_prompt']['caption']['char_captions'][0]['char_caption'], 'synthetic char blur')
        info = extract_prompt_info_from_image(str(path))
        self.assertEqual(info['basePrompt'], draft['settings']['prompt'])
        self.assertEqual(info['negativePrompt'], draft['settings']['negative_prompt'])
        self.assertEqual(info['charPrompts'], ['synthetic character'])
        self.assertNotIn(self.key, (self.root / draft['id'] / 'draft.json').read_text(encoding='utf-8'))
        reopened = DakiDrafts(self.root, lambda: '', mock.Mock())
        self.assertEqual(reopened.get(draft['id']), draft)
        self.assertEqual(reopened.list_drafts(), [draft])
        reopened.generator.assert_not_called()

    def test_random_seed_is_assigned_at_dispatch_and_retry_is_explicit(self):
        self.generator.side_effect = [ValueError('synthetic failure ' + self.key), synthetic_image('', {
            'parameters': {'width': 128, 'height': 192}})]
        with mock.patch('naim.daki_drafts.secrets.randbelow', side_effect=[123, 456]):
            draft = self.create()
            self.assertEqual(draft['status'], 'failed')
            self.assertIn('[키 숨김]', draft['error'])
            self.assertNotIn(self.key, draft['error'])
            self.assertNotIn('src', draft)
            self.assertEqual(draft['seed'], 123)
            self.assertEqual(draft['settings']['seed'], -1)
            self.assertEqual(self.generator.call_count, 1)
            self.manager.get(draft['id'])
            self.manager.list_drafts()
            self.assertEqual(self.generator.call_count, 1)
            self.manager.retry(draft['id'])
            self.assertTrue(self.manager.wait())
        self.assertEqual(self.manager.get(draft['id'])['seed'], 456)
        self.assertEqual(self.manager.get(draft['id'])['status'], 'completed')
        self.assertEqual(self.generator.call_count, 2)

    def test_fixed_seed_never_uses_random_generator(self):
        with mock.patch('naim.daki_drafts.secrets.randbelow') as random:
            draft = self.create(seed=4294967295)
            random.assert_not_called()
        self.assertEqual(draft['seed'], 4294967295)
        self.assertEqual(self.generator.call_args.args[1]['parameters']['seed'], 4294967295)

    def test_busy_rejects_second_request_without_a_second_record(self):
        entered, release = threading.Event(), threading.Event()
        def blocked(key, payload):
            entered.set()
            release.wait(5)
            return synthetic_image(key, payload)
        self.generator.side_effect = blocked
        self.addCleanup(release.set)
        first = self.manager.create(synthetic_settings())
        self.assertTrue(entered.wait(2))
        with self.assertRaises(DakiStyleTestConflict):
            self.manager.create(synthetic_settings())
        with self.assertRaises(DakiStyleTestConflict):
            self.manager.retry(first['id'])
        self.assertEqual(len(self.manager.list_drafts()), 1)
        self.assertEqual(self.generator.call_count, 1)
        release.set()
        self.assertTrue(self.manager.wait())

    def test_anlas_and_missing_key_rejections_do_not_write_or_generate(self):
        with self.assertRaises(DakiAnlasConfirmation):
            self.manager.create(synthetic_settings(options={'steps': 29}))
        self.assertFalse(self.root.exists())
        self.generator.assert_not_called()
        draft = self.create(options={'steps': 29}, allow_anlas=True)
        self.assertEqual(draft['status'], 'completed')
        self.key = ''
        with self.assertRaises(ValueError):
            self.manager.create(synthetic_settings())
        self.assertEqual(len(self.manager.list_drafts()), 1)
        self.assertEqual(self.generator.call_count, 1)

    def test_completed_results_cannot_be_retried_or_overwritten(self):
        draft = self.create()
        image = self.manager.image_path(draft['id'], full=True)
        before = image.read_bytes()
        with self.assertRaises(DakiStyleTestConflict):
            self.manager.retry(draft['id'])
        self.assertEqual(image.read_bytes(), before)
        self.assertEqual(self.generator.call_count, 1)

    def test_interrupted_record_is_failed_on_restart_without_automatic_retry(self):
        draft = self.create()
        manifest = self.root / draft['id'] / 'draft.json'
        record = json.loads(manifest.read_text(encoding='utf-8'))
        record['status'] = 'running'
        manifest.write_text(json.dumps(record), encoding='utf-8')
        reopened = DakiDrafts(self.root, lambda: self.key, mock.Mock())
        recovered = reopened.get(draft['id'])
        self.assertEqual(recovered['status'], 'failed')
        self.assertIn('프로그램이 종료', recovered['error'])
        reopened.generator.assert_not_called()
        with self.assertRaises(FileNotFoundError):
            reopened.image_path(draft['id'])

    def test_save_failure_is_persisted_and_never_automatically_repeated(self):
        with mock.patch.object(self.manager, '_save_image', side_effect=OSError('private local path')):
            draft = self.create()
        self.assertEqual(draft['status'], 'failed')
        self.assertNotIn('private local path', draft['error'])
        self.assertEqual(self.generator.call_count, 1)
        self.assertEqual(self.manager.get(draft['id'])['status'], 'failed')
        self.manager.retry(draft['id'])
        self.assertTrue(self.manager.wait())
        self.assertEqual(self.manager.get(draft['id'])['status'], 'completed')

    def test_wrong_size_response_is_not_published(self):
        self.generator.side_effect = lambda *_: Image.new('RGB', (64, 64), 'blue')
        draft = self.create()
        self.assertEqual(draft['status'], 'failed')
        self.assertFalse((self.root / draft['id'] / 'image.png').exists())
        with self.assertRaises(FileNotFoundError):
            self.manager.image_path(draft['id'], full=True)

    def test_thread_start_failure_leaves_explicit_retry_record(self):
        with mock.patch('naim.daki_drafts.threading.Thread.start', side_effect=RuntimeError('not started')):
            with self.assertRaises(DakiStyleTestConflict):
                self.manager.create(synthetic_settings())
        draft = self.manager.list_drafts()[0]
        self.assertEqual(draft['status'], 'failed')
        self.assertTrue(self.manager.wait())
        self.generator.assert_not_called()
        self.manager.retry(draft['id'])
        self.assertTrue(self.manager.wait())
        self.assertEqual(self.manager.get(draft['id'])['status'], 'completed')

    def test_initial_manifest_write_failure_keeps_existing_results_readable(self):
        completed = self.create()
        with mock.patch('naim.daki_drafts.write_json', side_effect=OSError('synthetic write failure')):
            with self.assertRaises(OSError):
                self.manager.create(synthetic_settings())
        self.assertEqual(self.manager.list_drafts(), [completed])
        self.assertEqual(self.generator.call_count, 1)
        another = self.create()
        self.assertEqual(another['status'], 'completed')
        self.assertEqual(len(self.manager.list_drafts()), 2)

    def test_virtual_reference_is_allowlisted_and_optional_manager_is_compatible(self):
        draft = self.create()
        reference = draft['path']
        self.assertEqual(parse_daki_image_reference(reference), ('draft', draft['id']))
        self.assertEqual(resolve_daki_image_reference(reference, None, self.manager),
                         (str(self.manager.image_path(draft['id'], full=True)), reference))
        with self.assertRaises(FileNotFoundError):
            resolve_daki_image_reference(reference, None)
        self.assertIsNone(resolve_daki_image_reference('ordinary.png', None))
        for bad in ('__daki_drafts__/../image.png', '__daki_drafts__/not-an-id.png',
                    reference + '\n', reference + '/extra', reference.replace('.png', '.jpg'),
                    reference.replace('__daki_drafts__', '__DAKI_DRAFTS__')):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                resolve_daki_image_reference(bad, None, self.manager)
        for bad in ('../outside', draft['id'] + '\n', '0' * 31):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.manager.get(bad)

    def test_framed_draft_is_separate_persistent_and_preserves_original_recipe(self):
        original = self.create(seed=123)
        original_file = self.manager.image_path(original['id'], full=True)
        original_bytes = original_file.read_bytes()
        original_manifest = (original_file.parent / 'draft.json').read_bytes()
        key_provider = mock.Mock(side_effect=AssertionError('Framing must not look up a key'))
        self.manager.key_provider = key_provider
        framed = self.manager.frame(original['id'], {'width': 131, 'height': 200, 'mode': 'pad'})
        self.assertNotEqual(framed['id'], original['id'])
        self.assertEqual(framed['status'], 'completed')
        self.assertEqual((framed['width'], framed['height']), (131, 200))
        self.assertEqual(framed['settings'], original['settings'])
        self.assertEqual(framed['seed'], original['seed'])
        self.assertEqual(framed['framing']['source_id'], original['id'])
        self.assertEqual(original_file.read_bytes(), original_bytes)
        self.assertEqual((original_file.parent / 'draft.json').read_bytes(), original_manifest)
        with Image.open(self.manager.image_path(framed['id'], full=True)) as image:
            self.assertEqual(image.size, (131, 200))
            self.assertEqual(image.mode, 'RGBA')
            self.assertEqual(image.getpixel((0, 0))[3], 0)
            self.assertEqual(image.getpixel((1, 4)), (20, 40, 80, 255))
            comment = json.loads(image.info['Comment'])
            self.assertEqual((comment['width'], comment['height'], comment['seed']), (131, 200, 123))
            self.assertEqual(comment['prompt'], original['settings']['prompt'])
        reopened = DakiDrafts(self.root, key_provider, mock.Mock())
        self.assertEqual(reopened.get(framed['id']), framed)
        self.assertEqual(len(reopened.list_drafts()), 2)
        reference = resolve_daki_image_reference(framed['path'], None, reopened)
        self.assertEqual(reference[0], str(reopened.image_path(framed['id'], full=True)))
        key_provider.assert_not_called()
        reopened.generator.assert_not_called()
        self.assertEqual(self.generator.call_count, 1)

    def test_candidate_recipe_query_reads_completed_only_without_recovery_writes(self):
        completed = self.create(prompt='synthetic_hair', char_prompts=[{'prompt': 'synthetic_shirt'}])
        self.generator.side_effect = ValueError('synthetic failure')
        interrupted = self.create()
        manifest = self.root / interrupted['id'] / 'draft.json'
        record = json.loads(manifest.read_text(encoding='utf-8'))
        record['status'] = 'running'
        manifest.write_text(json.dumps(record), encoding='utf-8')
        before = manifest.read_bytes()
        reopened = DakiDrafts(self.root, mock.Mock(side_effect=AssertionError('No key')), mock.Mock())
        rows = list(reopened.iter_completed_prompt_images())
        self.assertEqual([row['path'] for row in rows], [completed['path']])
        self.assertEqual(rows[0]['prompt_info']['prompt'], 'synthetic_hair')
        self.assertEqual(rows[0]['prompt_info']['char_prompts'][0]['prompt'], 'synthetic_shirt')
        self.assertEqual(manifest.read_bytes(), before)
        reopened.key_provider.assert_not_called()
        reopened.generator.assert_not_called()

    def test_framed_thumbnail_composites_transparency_on_white_and_handles_thin_output(self):
        original = self.create()
        framed = self.manager.frame(original['id'], {'width': 192, 'height': 256, 'mode': 'pad'})
        with Image.open(self.manager.image_path(framed['id'])) as preview:
            self.assertEqual(preview.mode, 'RGB')
            self.assertEqual(preview.getpixel((0, 0)), (255, 255, 255))
        thin = self.manager.frame(original['id'], {'width': 1, 'height': 1024, 'mode': 'cover'})
        with Image.open(self.manager.image_path(thin['id'])) as preview:
            self.assertEqual(preview.size, (1, 512))

    def test_framing_a_saved_copy_uses_its_actual_pixels_and_keeps_generation_recipe(self):
        original = self.create()
        first = self.manager.frame(original['id'], {'width': 200, 'height': 200, 'mode': 'pad'})
        with self.assertRaises(ValueError):
            self.manager.frame(first['id'], {'width': 150, 'height': 200, 'mode': 'pad'})
        second = self.manager.frame(first['id'], {'width': 300, 'height': 300, 'mode': 'pad'})
        self.assertEqual(second['settings'], original['settings'])
        self.assertEqual(second['framing']['source_id'], first['id'])
        self.assertEqual((second['framing']['source_width'], second['framing']['source_height']), (200, 200))
        with Image.open(self.manager.image_path(first['id'], full=True)) as source, \
                Image.open(self.manager.image_path(second['id'], full=True)) as image:
            self.assertEqual(image.crop((50, 50, 250, 250)).tobytes(), source.tobytes())

    def test_partial_framed_files_are_invisible_to_another_reader_until_publication(self):
        original = self.create()
        write_images = self.manager._write_image_files
        checked = []
        def check_staging(root, draft_id, image, metadata):
            write_images(root, draft_id, image, metadata)
            reader = DakiDrafts(self.root, mock.Mock(), mock.Mock())
            checked.append(reader.list_drafts())
            with self.assertRaises(FileNotFoundError):
                reader.get(draft_id)
        with mock.patch.object(self.manager, '_write_image_files', side_effect=check_staging):
            framed = self.manager.frame(original['id'], {'width': 200, 'height': 200, 'mode': 'pad'})
        self.assertEqual(checked, [[original]])
        self.assertEqual(self.manager.get(framed['id'])['status'], 'completed')

    def test_framing_validates_before_publishing_and_failed_local_record_never_retries(self):
        original = self.create()
        with self.assertRaises(ValueError):
            self.manager.frame(original['id'], {'width': 127, 'height': 192, 'mode': 'pad'})
        self.assertEqual(self.manager.list_drafts(), [original])
        framed = self.manager.frame(original['id'], {'width': 128, 'height': 128, 'mode': 'cover'})
        manifest = self.root / framed['id'] / 'draft.json'
        record = json.loads(manifest.read_text(encoding='utf-8'))
        record['status'] = 'failed'
        manifest.write_text(json.dumps(record), encoding='utf-8')
        with self.assertRaises(DakiStyleTestConflict):
            self.manager.retry(framed['id'])
        with self.assertRaises(DakiStyleTestConflict):
            self.manager.frame(framed['id'], {'width': 200, 'height': 200, 'mode': 'pad'})
        self.assertEqual(self.generator.call_count, 1)

    def test_framing_write_or_publication_failure_rolls_back_without_retry_record(self):
        original = self.create()
        original_bytes = self.manager.image_path(original['id'], full=True).read_bytes()
        for target in ('_write_image_files', '_save'):
            with self.subTest(target=target), mock.patch.object(self.manager, target, side_effect=OSError('synthetic failure')):
                with self.assertRaises(OSError):
                    self.manager.frame(original['id'], {'width': 200, 'height': 200, 'mode': 'pad'})
            self.assertEqual(self.manager.list_drafts(), [original])
            self.assertEqual({path.name for path in self.root.iterdir()}, {original['id']})
        with mock.patch('naim.daki_drafts.os.rename', side_effect=OSError('synthetic publication failure')):
            with self.assertRaises(OSError):
                self.manager.frame(original['id'], {'width': 200, 'height': 200, 'mode': 'pad'})
        self.assertEqual(self.manager.list_drafts(), [original])
        self.assertEqual({path.name for path in self.root.iterdir()}, {original['id']})
        self.assertEqual(self.manager.image_path(original['id'], full=True).read_bytes(), original_bytes)
        self.assertEqual(self.generator.call_count, 1)


class DraftApiTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.app = Flask(__name__)
        self.app.config['TESTING'] = True
        self.generator = mock.Mock(side_effect=synthetic_image)
        self.manager = register_daki_draft_routes(self.app, lambda: self.root, lambda: 'synthetic-key', self.generator)
        self.addCleanup(self.manager.wait)
        self.client = self.app.test_client()

    def test_creation_polling_original_preview_and_completed_retry_conflict(self):
        response = self.client.post('/api/daki/drafts', json=synthetic_settings(seed=0))
        self.assertEqual(response.status_code, 201, response.json)
        draft = response.json['draft']
        self.assertEqual(draft['status'], 'running')
        self.assertEqual(draft['seed'], 0)
        self.assertNotIn('synthetic-key', response.get_data(as_text=True))
        self.assertTrue(self.manager.wait())
        detail = self.client.get('/api/daki/drafts/' + draft['id']).json['draft']
        self.assertEqual(detail['status'], 'completed')
        self.assertEqual(self.client.get('/api/daki/drafts').json['drafts'], [detail])
        for suffix, kind in (('', 'JPEG'), ('?full=1', 'PNG')):
            image = self.client.get(detail['src'] + suffix)
            self.assertEqual(image.status_code, 200)
            with Image.open(io.BytesIO(image.data)) as opened:
                self.assertEqual(opened.format, kind)
            image.close()
        retried = self.client.post('/api/daki/drafts/' + draft['id'] + '/retry', json={})
        self.assertEqual(retried.status_code, 409)
        self.assertEqual(self.generator.call_count, 1)

    def test_failed_retry_anlas_and_validation_responses(self):
        paid = self.client.post('/api/daki/drafts', json=synthetic_settings(options={'steps': 29}))
        self.assertEqual(paid.status_code, 409)
        self.assertEqual(paid.json['code'], 'anlas_confirmation')
        self.assertEqual(self.client.get('/api/daki/drafts').json['drafts'], [])
        self.generator.side_effect = ValueError('synthetic network failure')
        response = self.client.post('/api/daki/drafts', json=synthetic_settings())
        self.assertEqual(response.status_code, 201)
        draft_id = response.json['draft']['id']
        self.assertTrue(self.manager.wait())
        image = self.client.get(f'/api/daki/drafts/{draft_id}/image')
        self.assertEqual(image.status_code, 404)
        image.close()
        self.generator.side_effect = synthetic_image
        retried = self.client.post(f'/api/daki/drafts/{draft_id}/retry', json={})
        self.assertEqual(retried.status_code, 200)
        self.assertTrue(self.manager.wait())
        for value in ([], None, {'width': 12}, {'model': []}):
            result = self.client.post('/api/daki/drafts', json=value)
            self.assertEqual(result.status_code, 400, result.json)
        self.assertEqual(self.client.get('/api/daki/drafts/' + '0' * 32).status_code, 404)

    def test_local_framing_api_options_success_and_validation_without_generation(self):
        original = self.client.post('/api/daki/drafts', json=synthetic_settings()).json['draft']
        self.assertTrue(self.manager.wait())
        self.manager.key_provider = mock.Mock(side_effect=AssertionError('No key for local image work'))
        self.generator.reset_mock()
        options = self.client.get('/api/daki/drafts/framing-options')
        self.assertEqual(options.status_code, 200)
        self.assertEqual(options.json['limits'], {'min': 1, 'max': 16000, 'max_pixels': 80000000})
        url = f"/api/daki/drafts/{original['id']}/frame"
        framed = self.client.post(url, json={'width': 200, 'height': 200, 'mode': 'pad'})
        self.assertEqual(framed.status_code, 201, framed.json)
        self.assertEqual(framed.json['draft']['status'], 'completed')
        image = self.client.get(framed.json['draft']['src'] + '?full=1')
        with Image.open(io.BytesIO(image.data)) as opened:
            self.assertEqual(opened.size, (200, 200))
            self.assertEqual(opened.getpixel((0, 0))[3], 0)
        image.close()
        for data in ([], None, {}, {'width': 64, 'height': 192, 'mode': 'pad'},
                     {'width': 128, 'height': 192, 'mode': 'bad'},
                     {'width': 128, 'height': True, 'mode': 'cover'}):
            with self.subTest(data=data):
                self.assertEqual(self.client.post(url, json=data).status_code, 400)
        self.assertEqual(self.client.post('/api/daki/drafts/' + '0' * 32 + '/frame',
            json={'width': 1, 'height': 1, 'mode': 'cover'}).status_code, 404)
        self.generator.assert_not_called()
        self.manager.key_provider.assert_not_called()

    def test_running_and_failed_sources_cannot_be_framed(self):
        entered, release = threading.Event(), threading.Event()
        def blocked(key, payload):
            entered.set()
            release.wait(5)
            raise ValueError('synthetic generation failure')
        self.generator.side_effect = blocked
        self.addCleanup(release.set)
        original = self.client.post('/api/daki/drafts', json=synthetic_settings()).json['draft']
        self.assertTrue(entered.wait(2))
        url = f"/api/daki/drafts/{original['id']}/frame"
        settings = {'width': 200, 'height': 200, 'mode': 'pad'}
        self.assertEqual(self.client.post(url, json=settings).status_code, 409)
        release.set()
        self.assertTrue(self.manager.wait())
        self.assertEqual(self.client.post(url, json=settings).status_code, 409)
        self.assertEqual(len(self.manager.list_drafts()), 1)
        self.assertEqual(self.generator.call_count, 1)


if __name__ == '__main__':
    unittest.main()
