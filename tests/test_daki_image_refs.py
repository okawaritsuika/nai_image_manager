"""Exercise gallery routes on synthetic daki images without importing live app.py."""
import ast
import base64
from copy import deepcopy
from functools import lru_cache
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from urllib.parse import unquote, urlsplit

from flask import Flask, jsonify, request, send_file
from PIL import Image, ImageOps

import utils
from naim.daki_image_refs import (
    daki_image_prompt_fallback, parse_daki_image_reference, resolve_daki_image_reference,
)
from naim.daki_style_tests import DakiStyleTests
from naim.daki_drafts import DakiDrafts
from naim.images.previews import PreviewCache
from naim.images.prompt_metadata import (
    extract_prompt_info_from_image, load_prompt_sidecar, merge_prompt_info_with_fallback,
)
from naim.storage.daki_shared_styles import DakiSharedStyles
from naim.storage.daki_personal_styles import DakiPersonalStyles
from naim.storage.webp_conversion import resolve_converted_gallery_path
from naim.web.daki import register_daki_routes
from tests.test_daki_style_tests import synthetic_request, synthetic_styles


class DakiImageReferenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.catalog_root = self.root / 'catalog'
        self.catalog_root.mkdir()
        self.gallery = self.root / 'gallery'
        self.gallery.mkdir()
        self.original = self.catalog_root / 'source.png'
        Image.new('RGB', (512, 384), 'blue').save(self.original)
        style = synthetic_styles(1)[0]
        style.update(source_image_id=1, source_url='https://example.test/style')
        style['preview'] = {'width': 512, 'height': 384, 'image': 'source.png',
                            'thumbnail': 'source.png', 'job_id': 'source-job'}
        excluded = deepcopy(style)
        excluded.update(id='excluded', positive='photorealistic')
        for name, data in (
            ('default_styles.json', {'styles': [style, excluded]}),
            ('source_generation_options.json', {'styles': {style['id']: {
                'source_image_id': 1, 'options': style['options']}}}),
            ('generation_manifest.json', {'jobs': {'source-job': {'status': 'success', 'seed': 123}}}),
        ):
            (self.catalog_root / name).write_text(json.dumps(data), encoding='utf-8')
        self.manager = DakiStyleTests(lambda: self.root / 'tests', DakiSharedStyles(self.catalog_root),
                                      lambda: 'synthetic-key',
                                      generator=lambda key, payload: Image.new('RGB', (512, 384), 'green'))
        self.batch = self.manager.create(synthetic_request())
        self.manager.run(self.batch['id'], 'next')
        self.assertTrue(self.manager.wait())
        self.addCleanup(self.manager.wait)
        self.shared = '__daki_shared__/style-0.png'
        self.generated = f"__daki_tests__/{self.batch['id']}/style-0.png"
        self.manager.personal_catalog = DakiPersonalStyles(lambda: self.root / 'personal',
            lambda reference: resolve_daki_image_reference(reference, self.manager),
            extract_prompt_info_from_image,
            prompt_fallback=lambda reference: daki_image_prompt_fallback(reference, self.manager))
        personal_style = self.manager.personal_catalog.create({
            'name': 'Personal linked ink', 'positive': 'personal ink', 'negative': 'personal blur',
            'source_path': self.shared, 'preview': {'width': 512, 'height': 384}})
        self.personal = f"__daki_personal__/{personal_style['id']}.png"
        self.drafts = DakiDrafts(lambda: self.root / 'drafts', lambda: 'synthetic-key',
                                generator=lambda key, payload: Image.new('RGB', (512, 384), 'purple'))
        draft = self.drafts.create({'prompt': 'synthetic draft', 'negative_prompt': 'synthetic blur',
                                    'width': 512, 'height': 384, 'seed': 456})
        self.assertTrue(self.drafts.wait())
        self.addCleanup(self.drafts.wait)
        self.draft = draft['path']
        self.before = self.original.read_bytes()
        self.app = Flask(__name__)
        self.app.config['TESTING'] = True
        names = {
            'clean_gallery_rel_path', 'resolve_gallery_file_path', 'resolve_gallery_image_path',
            'resolve_daki_image_path', 'resolve_readable_gallery_image_path', 'serve_image',
            'get_requested_image_preview_max_side', 'build_cached_image_preview',
            'build_image_preview_bytes', 'serve_image_preview', 'get_prompt_info',
            'reveal_in_explorer', 'read_canvas_image_bytes',
        }
        tree = ast.parse((Path(__file__).resolve().parents[1] / 'app.py').read_text(encoding='utf-8'))
        functions = [item for item in tree.body if isinstance(item, ast.FunctionDef) and item.name in names]
        self.assertEqual({item.name for item in functions}, names)
        self.reveal = mock.Mock(return_value='Synthetic reveal')
        self.namespace = {
            'app': self.app, 'request': request, 'jsonify': jsonify, 'send_file': send_file,
            'os': os, 'io': io, 'Image': Image, 'ImageOps': ImageOps, 'utils': utils,
            'base64': base64, 'unquote': unquote, 'urlsplit': urlsplit, 'lru_cache': lru_cache,
            'CLASSIFIED_DIR': str(self.gallery), 'CANVAS_IMPORT_DIR': str(self.root / 'imports'),
            'CANVAS_DISPLAY_PREVIEW_MAX_SIDE': 4096, 'IMAGE_PREVIEW_CACHE': PreviewCache(),
            'DAKI_STYLE_TESTS': self.manager, 'resolve_converted_gallery_path': resolve_converted_gallery_path,
            'DAKI_DRAFTS': self.drafts,
            'parse_daki_image_reference': parse_daki_image_reference,
            'resolve_daki_image_reference': resolve_daki_image_reference,
            'daki_image_prompt_fallback': daki_image_prompt_fallback,
            'load_prompt_sidecar': load_prompt_sidecar,
            'extract_prompt_info_from_image': extract_prompt_info_from_image,
            'merge_prompt_info_with_fallback': merge_prompt_info_with_fallback,
            'reveal_path_in_explorer': self.reveal,
        }
        exec(compile(ast.Module(body=functions, type_ignores=[]), '<daki_image_routes>', 'exec'), self.namespace)
        self.store = register_daki_routes(self.app, lambda: self.root / 'projects.json',
                                         self.namespace['resolve_daki_image_path'],
                                         self.namespace['clean_gallery_rel_path'])
        self.client = self.app.test_client()

    def test_shared_and_completed_results_serve_original_and_display_preview(self):
        for path in (self.shared, self.generated, self.personal, self.draft):
            with self.subTest(path=path):
                response = self.client.get('/image/' + path)
                self.assertEqual(response.status_code, 200)
                with Image.open(io.BytesIO(response.data)) as image:
                    self.assertEqual(image.size, (512, 384))
                response.close()
                preview = self.client.get('/image/' + path + '?preview=256')
                self.assertEqual(preview.status_code, 200)
                with Image.open(io.BytesIO(preview.data)) as image:
                    self.assertEqual(image.size, (256, 192))
                preview.close()
        self.assertEqual(self.original.read_bytes(), self.before)

    def test_prompt_fallback_and_generated_metadata_keep_virtual_paths(self):
        shared = self.client.post('/api/prompt_info', json={'path': self.shared}).json
        self.assertEqual(shared['status'], 'success')
        self.assertEqual(shared['data']['basePrompt'], synthetic_styles(1)[0]['positive'])
        self.assertEqual(shared['data']['cfg_rescale'], 0)
        self.assertEqual(shared['data']['seed'], 123)
        self.assertEqual(shared['data']['path'], self.shared)
        generated = self.client.post('/api/prompt_info', json={'path': self.generated}).json
        self.assertEqual(generated['status'], 'success')
        self.assertIn(synthetic_request()['prompt'], generated['data']['basePrompt'])
        self.assertEqual(generated['data']['path'], self.generated)
        personal = self.client.post('/api/prompt_info', json={'path': self.personal}).json
        self.assertEqual(personal['status'], 'success')
        self.assertEqual(personal['data']['basePrompt'], 'personal ink')
        self.assertEqual(personal['data']['negativePrompt'], 'personal blur')
        self.assertEqual(personal['data']['path'], self.personal)
        self.assertIn(personal['data']['seed'], (None, ''))
        draft = self.client.post('/api/prompt_info', json={'path': self.draft}).json
        self.assertEqual(draft['status'], 'success')
        self.assertEqual(draft['data']['basePrompt'], 'synthetic draft')
        self.assertEqual(draft['data']['negativePrompt'], 'synthetic blur')
        self.assertEqual(draft['data']['seed'], 456)
        self.assertEqual(draft['data']['path'], self.draft)

    def test_shared_reference_import_uses_catalog_metadata_and_preserves_source(self):
        draft = self.manager.personal_catalog.draft_from_image(self.shared)
        self.assertEqual(draft['positive'], synthetic_styles(1)[0]['positive'])
        self.assertEqual(draft['options']['cfg'], synthetic_styles(1)[0]['options']['cfg'])
        self.assertEqual(draft['source_path'], self.shared)
        self.assertIsNone(draft['seed'])
        self.assertEqual(self.original.read_bytes(), self.before)
        with self.assertRaises(ValueError):
            self.manager.personal_catalog.draft_from_image(self.personal)

    def test_explorer_and_canvas_use_exact_allowlisted_source(self):
        for path in (self.shared, self.generated, self.personal, self.draft):
            response = self.client.post('/api/reveal_in_explorer', json={'path': path}).json
            self.assertEqual(response['status'], 'success')
            self.assertEqual(response['path'], path)
            full, _ = resolve_daki_image_reference(path, self.manager, self.drafts)
            self.reveal.assert_called_with(full, mode='select')
            data = self.namespace['read_canvas_image_bytes']('/image/' + path + '?preview=256')
            self.assertEqual(data, Path(full).read_bytes())

    def test_candidates_retain_reference_and_survive_reload_without_copying(self):
        for path in (self.shared, self.generated, self.personal, self.draft):
            response = self.client.post('/api/daki/projects', json={
                'name': 'Synthetic project', 'path': path, 'side': 'front'})
            self.assertEqual(response.status_code, 201, response.json)
            project = response.json['project']
            candidate = project['candidates']['front'][0]
            self.assertEqual(candidate['path'], path)
            self.assertEqual(candidate['src'], '/image/' + path)
            self.assertFalse(candidate['missing'])
            reloaded = self.client.get('/api/daki/projects/' + project['id']).json['project']
            self.assertEqual(reloaded, project)
        self.assertEqual(list(self.gallery.rglob('*.png')), [])
        self.assertEqual(self.original.read_bytes(), self.before)

    def test_reserved_invalid_excluded_pending_and_missing_references_never_fall_back(self):
        pending = self.manager.create(synthetic_request())
        invalid = [
            '__daki_shared__/../source.png', '__daki_shared__/style-0.jpg',
            '__daki_shared__/style-0.png/extra', '__DAKI_SHARED__/style-0.png',
            '__daki_tests__/invalid/style-0.png',
            '__daki_personal__/../source.png', '__daki_personal__/personal_wrong.png',
            self.personal + '/extra', self.personal.replace('__daki_personal__', '__DAKI_PERSONAL__'),
            '__daki_drafts__/invalid.png', self.draft + '/extra', self.draft + '\n',
        ]
        for path in invalid:
            with self.subTest(path=path), self.assertRaises(ValueError):
                resolve_daki_image_reference(path, self.manager)
        absent = ['__daki_shared__/excluded.png', '__daki_shared__/missing.png',
                  f"__daki_tests__/{pending['id']}/style-0.png",
                  f"__daki_tests__/{self.batch['id']}/missing.png",
                  '__daki_personal__/personal_' + '0' * 32 + '.png',
                  '__daki_drafts__/' + '0' * 32 + '.png']
        for path in absent:
            # Even a matching gallery file cannot satisfy a reserved reference.
            collision = self.gallery / path
            collision.parent.mkdir(parents=True, exist_ok=True)
            Image.new('RGB', (8, 8), 'red').save(collision)
            with self.subTest(path=path):
                response = self.client.get('/image/' + path)
                self.assertEqual(response.status_code, 404)
                response.close()
                with self.assertRaises(FileNotFoundError):
                    self.namespace['read_canvas_image_bytes']('/image/' + path)

    def test_ordinary_gallery_and_write_resolvers_remain_separate(self):
        normal = self.gallery / 'normal.png'
        Image.new('RGB', (8, 8), 'red').save(normal)
        self.assertIsNone(parse_daki_image_reference('normal.png'))
        self.assertEqual(self.namespace['resolve_daki_image_path']('normal.png'), (str(normal), 'normal.png'))
        with mock.patch.object(self.manager.catalog, 'preview_path', wraps=self.manager.catalog.preview_path) as read:
            self.assertEqual(self.namespace['resolve_gallery_file_path'](self.shared),
                             str(self.gallery / self.shared))
            with self.assertRaises(FileNotFoundError):
                self.namespace['resolve_gallery_image_path'](self.shared)
            read.assert_not_called()
        self.assertEqual(self.original.read_bytes(), self.before)

    def test_personal_reference_write_resolver_never_modifies_linked_original(self):
        with mock.patch.object(self.manager.personal_catalog, 'preview_path',
                               wraps=self.manager.personal_catalog.preview_path) as read:
            self.assertEqual(self.namespace['resolve_gallery_file_path'](self.personal),
                             str(self.gallery / self.personal))
            with self.assertRaises(FileNotFoundError):
                self.namespace['resolve_gallery_image_path'](self.personal)
            read.assert_not_called()
        self.assertEqual(self.original.read_bytes(), self.before)

    def test_personal_missing_representative_does_not_fall_back_to_gallery_file(self):
        manual = self.manager.personal_catalog.create({'name': 'Without image', 'positive': 'ink'})
        reference = '__daki_personal__/' + manual['id'] + '.png'
        collision = self.gallery / reference
        collision.parent.mkdir(parents=True, exist_ok=True)
        Image.new('RGB', (8, 8), 'red').save(collision)
        response = self.client.get('/image/' + reference)
        self.assertEqual(response.status_code, 404)
        response.close()
        self.assertEqual(self.manager.personal_catalog.get_style(manual['id'])['positive'], 'ink')


if __name__ == '__main__':
    unittest.main()
