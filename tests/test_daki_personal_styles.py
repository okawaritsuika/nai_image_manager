from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import ast
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from urllib.parse import quote

from flask import Flask
from PIL import Image
from PIL.PngImagePlugin import PngInfo

from naim.daki_style_tests import GENERATION_DEFAULTS, build_style_test_payload
from naim.storage.daki_personal_styles import DakiPersonalStyles
from naim.storage.daki_projects import DakiNotFoundError, normalize_relative_path
from naim.web.daki_personal_styles import register_daki_personal_style_routes


class PersonalStylesFixture:
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.images = self.root / 'images'
        self.images.mkdir()
        self.image = self.images / 'synthetic.png'
        Image.new('RGB', (832, 1216), 'blue').save(self.image)
        self.catalog_root = self.root / 'personal'
        self.prompt_info = {'basePrompt': 'watercolor, ink', 'negativePrompt': 'lowres',
                            'model': 'NovelAI Diffusion V5', 'steps': '20', 'cfg': '4.5',
                            'sampler': 'k_euler', 'cfg_rescale': 0,
                            'noise_schedule': 'native', 'seed': 9876543210}
        self.reader = mock.Mock(side_effect=lambda path: deepcopy(self.prompt_info))
        self.resolver = mock.Mock(side_effect=self.resolve)
        self.store = DakiPersonalStyles(lambda: self.catalog_root, self.resolver, self.reader)

    def resolve(self, reference):
        reference = normalize_relative_path(reference)
        return self.images / reference, reference

    def create(self, **changes):
        return self.store.create({'name': 'Synthetic personal style', 'positive': 'ink', **changes})


class DakiPersonalStylesTests(PersonalStylesFixture, unittest.TestCase):
    @unittest.skipUnless(os.name == 'nt', 'Windows path aliases only')
    def test_catalog_path_accepts_extended_resolve_alias(self):
        original_resolve = Path.resolve

        def extended_alias(path, *args, **kwargs):
            resolved = original_resolve(path, *args, **kwargs)
            if path.name != 'catalog.json':
                return resolved
            value = str(resolved)
            if value.startswith('\\\\?\\'):
                return resolved
            if value.startswith('\\\\'):
                return Path('\\\\?\\UNC\\' + value[2:])
            return Path('\\\\?\\' + value)

        with mock.patch.object(Path, 'resolve', extended_alias):
            self.assertEqual(self.store._path(), self.catalog_root / 'catalog.json')

    def test_catalog_path_still_rejects_a_different_resolved_parent(self):
        original_resolve = Path.resolve

        def outside(path, *args, **kwargs):
            resolved = original_resolve(path, *args, **kwargs)
            return self.root / 'outside' / path.name if path.name == 'catalog.json' else resolved

        with mock.patch.object(Path, 'resolve', outside), self.assertRaises(ValueError):
            self.store._path()

    def test_empty_listing_never_creates_data(self):
        self.assertEqual(self.store.list_styles(), [])
        self.assertFalse(self.catalog_root.exists())

    def test_manual_style_defaults_are_ready_for_generation_without_representative(self):
        style = self.create()
        self.assertRegex(style['id'], r'^personal_[a-f0-9]{32}$')
        self.assertEqual(style['preview'], {'width': 832, 'height': 1216})
        self.assertEqual(style['options'], GENERATION_DEFAULTS)
        self.assertEqual(style['model'], 'nai-diffusion-5-full')
        self.assertIsNone(style['seed'])
        self.assertEqual(style['source_path'], '')
        payload = build_style_test_payload(style, {'model': style['model'], 'prompt': 'test',
                                                  'negative_prompt': '', 'char_prompts': []})
        self.assertEqual(payload['input'], 'ink, test')
        self.assertNotIn('seed', payload['parameters'])
        self.resolver.assert_not_called()
        with self.assertRaises(FileNotFoundError):
            self.store.preview_path(style['id'])

    def test_records_persist_and_return_detached_copies(self):
        created = self.create()
        created['options']['cfg'] = 20
        self.assertEqual(self.store.get_style(created['id'])['options']['cfg'], 5)
        listed = self.store.list_styles()
        listed[0]['positive'] = 'modified'
        reopened = DakiPersonalStyles(self.catalog_root, self.resolver, self.reader)
        self.assertEqual(reopened.get_style(created['id'])['positive'], 'ink')

    def test_import_returns_unsaved_draft_with_metadata_and_no_seed(self):
        before = self.image.read_bytes()
        draft = self.store.draft_from_image('synthetic.png')
        self.assertEqual(draft['positive'], 'watercolor, ink')
        self.assertEqual(draft['negative'], 'lowres')
        self.assertEqual(draft['options']['steps'], 20)
        self.assertEqual(draft['options']['cfg'], 4.5)
        self.assertEqual(draft['options']['cfg_rescale'], 0)
        self.assertEqual(draft['options']['sampler'], 'k_euler')
        self.assertEqual(draft['preview'], {'width': 832, 'height': 1216})
        self.assertEqual(draft['model'], 'nai-diffusion-5-full')
        self.assertIsNone(draft['seed'])
        self.assertNotIn('seed', draft['options'])
        self.assertNotIn('id', draft)
        self.assertFalse(self.catalog_root.exists())
        style = self.store.create(draft)
        self.assertEqual(self.store.preview_path(style['id'], full=True), self.image)
        self.assertEqual(self.image.read_bytes(), before)
        self.assertEqual([path.name for path in self.catalog_root.iterdir()], ['catalog.json'])

    def test_real_image_metadata_reader_prefills_import(self):
        from naim.images.prompt_metadata import (extract_prompt_info_from_image,
            load_prompt_sidecar, merge_prompt_info_with_fallback, save_prompt_sidecar,
            save_png_with_prompt_metadata)
        flags = {'prefer_brownian': False, 'deliberate_euler_ancestral_bug': True,
                 'dynamic_thresholding': False, 'legacy_v3_extend': True}
        meta = PngInfo()
        meta.add_text('Comment', json.dumps({'model': 'nai-diffusion-4-5-full',
            'prompt': 'synthetic art', 'uc': 'blur', 'scale': 6.5, 'steps': 24,
            'sampler': 'k_euler', 'noise_schedule': 'native', 'seed': 9999999999, **flags}))
        Image.new('RGB', (1024, 1024), 'white').save(self.image, pnginfo=meta)
        store = DakiPersonalStyles(self.catalog_root, self.resolver, extract_prompt_info_from_image)
        draft = store.draft_from_image('synthetic.png')
        self.assertEqual(draft['positive'], 'synthetic art')
        self.assertEqual(draft['negative'], 'blur')
        self.assertEqual(draft['options']['cfg'], 6.5)
        self.assertEqual(draft['model'], 'nai-diffusion-4-5-full')
        self.assertEqual(draft['preview'], {'width': 1024, 'height': 1024})
        self.assertIsNone(store.create(draft)['seed'])
        self.assertEqual({key: draft['options'][key] for key in flags}, flags)
        extracted = extract_prompt_info_from_image(self.image)
        save_prompt_sidecar(self.image, extracted)
        reloaded = merge_prompt_info_with_fallback(load_prompt_sidecar(self.image), extracted)
        self.assertEqual({key: reloaded[key] for key in flags}, flags)
        exported = self.images / 'exported.png'
        with Image.open(self.image) as image:
            save_png_with_prompt_metadata(image, exported, reloaded)
        self.assertEqual({key: extract_prompt_info_from_image(exported)[key] for key in flags}, flags)

    def test_unknown_image_settings_are_editable_draft_not_silent_model_replacement(self):
        self.prompt_info = {'model': 'Different image model'}
        draft = self.store.draft_from_image('synthetic.png')
        self.assertEqual(draft['model'], 'Different image model')
        self.assertEqual(draft['positive'], '')
        self.assertFalse(self.catalog_root.exists())
        with self.assertRaises(ValueError):
            self.store.create(draft)
        draft.update(model='nai-diffusion-5-full', positive='edited')
        self.assertEqual(self.store.create(draft)['positive'], 'edited')

    def test_virtual_catalog_fallback_fills_missing_metadata_without_replacing_embedded_text(self):
        reference = '__daki_shared__/synthetic-style.png'
        self.resolver.side_effect = lambda value: (self.image, value)
        self.prompt_info = {'basePrompt': '', 'cfg': '', 'steps': ''}
        fallback = mock.Mock(return_value={'basePrompt': 'catalog ink', 'negativePrompt': 'blur',
            'model': 'nai-diffusion-5-full', 'cfg': 7, 'steps': 18, 'prefer_brownian': False})
        store = DakiPersonalStyles(self.catalog_root, self.resolver, self.reader, prompt_fallback=fallback)
        draft = store.draft_from_image(reference)
        self.assertEqual(draft['positive'], 'catalog ink')
        self.assertEqual(draft['negative'], 'blur')
        self.assertEqual(draft['options']['cfg'], 7)
        self.assertEqual(draft['options']['steps'], 18)
        self.assertIs(draft['options']['prefer_brownian'], False)
        fallback.assert_called_once_with(reference)
        self.assertEqual(store.create(draft)['source_path'], reference)
        self.prompt_info.update(basePrompt='embedded ink', cfg=5)
        draft = store.draft_from_image(reference)
        self.assertEqual(draft['positive'], 'embedded ink')
        self.assertEqual(draft['options']['cfg'], 5)

    def test_invalid_inputs_leave_existing_catalog_untouched(self):
        self.create()
        path = self.catalog_root / 'catalog.json'
        before = path.read_bytes()
        for changes in ({'name': ''}, {'name': 'x' * 121}, {'positive': ''},
                        {'positive': None}, {'negative': []}, {'model': 'unsupported'},
                        {'preview': {'width': 1000, 'height': 1024}},
                        {'options': {'steps': 80}}, {'options': {'cfg': float('nan')}},
                        {'options': {'prefer_brownian': 'true'}}, {'source_path': []}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.create(**changes)
            self.assertEqual(path.read_bytes(), before)

    def test_seed_and_unknown_options_are_not_saved_as_recipe_settings(self):
        style = self.create(seed=9007199254740991, options={'seed': 77, 'unrecognized': 'value', 'cfg': 7})
        self.assertIsNone(style['seed'])
        self.assertEqual(set(style['options']), set(GENERATION_DEFAULTS))
        self.assertEqual(style['options']['cfg'], 7)

    def test_personal_references_and_unsafe_paths_are_rejected_before_resolution(self):
        for reference in ('__daki_personal__/personal_abc.png', '__DAKI_PERSONAL__/x.png',
                          '../outside.png', '/outside.png', 'C:/outside.png', ''):
            with self.subTest(reference=reference), self.assertRaises(ValueError):
                self.store.draft_from_image(reference)
        self.resolver.assert_not_called()

    def test_resolver_cannot_normalize_into_a_personal_cycle(self):
        self.resolver.side_effect = None
        self.resolver.return_value = self.image, '__daki_personal__/cycle.png'
        with self.assertRaises(ValueError):
            self.create(source_path='synthetic.png')
        self.assertFalse(self.catalog_root.exists())

    def test_missing_source_does_not_hide_recipes_or_block_text_updates(self):
        style = self.create(source_path='synthetic.png')
        self.image.unlink()
        self.assertEqual(len(self.store.list_styles()), 1)
        self.assertEqual(self.store.get_style(style['id'])['positive'], 'ink')
        with self.assertRaises(FileNotFoundError):
            self.store.preview_path(style['id'])
        updated = self.store.update(style['id'], {'name': 'Edited name'})
        self.assertEqual(updated['name'], 'Edited name')
        self.assertEqual(updated['source_path'], 'synthetic.png')
        self.assertEqual(updated['created_at'], style['created_at'])

    def test_missing_ids_and_sources_fail_without_creating_catalog(self):
        with self.assertRaises(DakiNotFoundError):
            self.store.get_style('missing')
        with self.assertRaises(DakiNotFoundError):
            self.store.update('missing', {'name': 'x'})
        with self.assertRaises(FileNotFoundError):
            self.create(source_path='missing.png')
        self.assertFalse(self.catalog_root.exists())

    def test_concurrent_creates_keep_all_recipes(self):
        other = DakiPersonalStyles(self.catalog_root, self.resolver, self.reader)
        with ThreadPoolExecutor(max_workers=4) as pool:
            result = list(pool.map(lambda index: (self.store if index % 2 else other).create(
                {'name': f'Style {index}', 'positive': 'ink'}), range(12)))
        self.assertEqual(len(self.store.list_styles()), 12)
        self.assertEqual(len({style['id'] for style in result}), 12)

    def test_references_match_exact_paths_folders_and_converted_aliases_without_writes(self):
        with mock.patch.object(self.store, 'list_styles', side_effect=AssertionError('unexpected catalog read')):
            self.assertEqual(self.store.references(), [])
        style = self.create(source_path='synthetic.png')
        self.create(name='No representative')
        before = (self.catalog_root / 'catalog.json').read_bytes()
        match = self.store.references(paths=['synthetic.png'])
        self.assertEqual(len(match), 1)
        self.assertEqual(match[0]['style_id'], style['id'])
        self.assertEqual(match[0]['project_name'], '개인 그림체 · Synthetic personal style')
        self.assertEqual(match[0]['side'], '대표 그림')
        self.assertEqual(self.store.references(folders=['']), match)
        self.assertEqual(self.store.references(paths=['not-synthetic.png']), [])
        self.image.unlink()
        self.assertEqual(self.store.references(paths=['synthetic.png']), match)
        self.resolver.side_effect = lambda reference: (self.images / 'new/synthetic.webp', 'new/synthetic.webp')
        self.assertEqual(self.store.references(paths=['new/synthetic.webp']), match)
        self.assertEqual(self.store.references(folders=['new']), match)
        self.assertEqual(self.store.references(folders=['ne']), [])
        self.assertEqual(self.store.references(folders=['newer']), [])
        self.assertEqual((self.catalog_root / 'catalog.json').read_bytes(), before)
        for invalid in ({'paths': 'synthetic.png'}, {'folders': {}}, {'paths': ['../outside.png']}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.store.references(**invalid)

    def test_app_personal_resolver_quotes_literal_filename_once(self):
        source = ast.parse((Path(__file__).resolve().parents[1] / 'app.py').read_text(encoding='utf-8'))
        registration = next(node.value for node in source.body if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == 'DAKI_PERSONAL_STYLES' for target in node.targets))
        resolver = mock.Mock(return_value=('unused', 'group/literal%2F#plus+?.png'))
        callback = eval(compile(ast.Expression(registration.args[1]), '<personal_resolver>', 'eval'),
                        {'resolve_daki_image_path': resolver, 'quote': quote})
        callback('group/literal%2F#plus+?.png')
        resolver.assert_called_once_with('/image/group/literal%252F%23plus%2B%3F.png')

    def test_corrupt_catalog_is_preserved_on_read_and_create(self):
        self.catalog_root.mkdir()
        path = self.catalog_root / 'catalog.json'
        path.write_text('{invalid', encoding='utf-8')
        with self.assertRaises(ValueError):
            self.store.list_styles()
        with self.assertRaises(ValueError):
            self.create()
        self.assertEqual(path.read_text(encoding='utf-8'), '{invalid')


class DakiPersonalStylesApiTests(PersonalStylesFixture, unittest.TestCase):
    def test_canvas_prompt_catalog_is_opt_in_and_read_only(self):
        style = self.create(positive='ink, watercolor', negative='lowres')
        app = Flask(__name__)
        register_daki_personal_style_routes(app, self.store)
        client = app.test_client()
        self.assertNotIn('positive', client.get('/api/daki/personal-styles').json['styles'][0])
        response = client.get('/api/daki/personal-styles?include_prompts=1')
        self.assertEqual(response.status_code, 200)
        item = response.json['styles'][0]
        self.assertEqual((item['positive'], item['negative']), ('ink, watercolor', 'lowres'))
        self.assertNotIn('options', item)
        self.assertEqual(self.store.get_style(style['id']), style)

    def setUp(self):
        super().setUp()
        app = Flask(__name__)
        register_daki_personal_style_routes(app, self.store)
        self.client = app.test_client()

    def test_api_manual_create_list_update_and_missing_preview(self):
        root = '/api/daki/personal-styles'
        result = self.client.post(root, json={'name': 'Manual style', 'positive': 'ink'})
        self.assertEqual(result.status_code, 201, result.json)
        style = result.json['style']
        self.assertNotIn('src', style)
        listed = self.client.get(root).json['styles'][0]
        self.assertNotIn('positive', listed)
        self.assertNotIn('options', listed)
        self.assertEqual((listed['width'], listed['height']), (832, 1216))
        path = root + '/' + style['id']
        changed = self.client.put(path, json={'positive': 'watercolor'}).json['style']
        self.assertEqual(changed['positive'], 'watercolor')
        self.assertEqual(self.client.get(path).json['style']['positive'], 'watercolor')
        self.assertEqual(self.client.get(path + '/preview').status_code, 404)

    def test_api_image_import_can_edit_before_save_and_serve_original(self):
        root = '/api/daki/personal-styles'
        result = self.client.post(root + '/import', json={'path': 'synthetic.png'})
        self.assertEqual(result.status_code, 200, result.json)
        draft = result.json['style']
        self.assertEqual(self.client.get(root).json['styles'], [])
        draft['name'] = 'Edited imported style'
        result = self.client.post(root, json=draft)
        self.assertEqual(result.status_code, 201, result.json)
        style = result.json['style']
        self.assertEqual(style['name'], 'Edited imported style')
        response = self.client.get(style['src'] + '?full=1')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, 'image/png')
        self.assertEqual(response.data, self.image.read_bytes())
        response.close()

    def test_api_errors_are_json_without_private_paths(self):
        root = '/api/daki/personal-styles'
        for method, path, data, status in (
                ('post', root, [], 400), ('post', root, {}, 400),
                ('get', root + '/missing', None, 404),
                ('put', root + '/missing', {'name': 'x'}, 404),
                ('post', root + '/import', {'path': '../outside.png'}, 400),
                ('post', root + '/import', {'path': 'missing.png'}, 404)):
            with self.subTest(method=method, path=path):
                result = getattr(self.client, method)(path, json=data)
                self.assertEqual(result.status_code, status, result.json)
                self.assertEqual(result.json['status'], 'error')
                self.assertNotIn(str(self.root), result.get_data(as_text=True))


if __name__ == '__main__':
    unittest.main()
