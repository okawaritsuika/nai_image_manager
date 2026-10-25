"""External project imports use synthetic images and temporary project storage."""
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from PIL import Image
from PIL.PngImagePlugin import PngInfo

import app
from naim.images.prompt_metadata import extract_prompt_info_from_image, load_prompt_sidecar


class DakiImageImportTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for key, value in {'DAKI_PROJECTS_FILE': self.root / 'projects.json',
                           'CANVAS_IMPORT_DIR': self.root / 'imports'}.items():
            patch = mock.patch.object(app, key, str(value))
            patch.start()
            self.addCleanup(patch.stop)
        self.client = app.app.test_client()
        self.project = app.DAKI_PROJECTS.create_project('Synthetic import')
        self.url = '/api/daki/projects/' + self.project['id'] + '/image-import'

    def image(self, metadata=False, fmt='PNG'):
        stream = io.BytesIO()
        image = Image.new('RGBA' if fmt == 'PNG' else 'RGB', (16, 24), (30, 60, 90))
        options = {}
        if metadata:
            info = PngInfo()
            info.add_text('Comment', json.dumps({
                'prompt': 'synthetic scene', 'uc': 'synthetic blur', 'steps': 28,
                'v4_prompt': {'caption': {'base_caption': 'synthetic base',
                                         'char_captions': [{'char_caption': 'blue hair'}]}},
            }))
            options['pnginfo'] = info
        image.save(stream, format=fmt, **options)
        return stream.getvalue()

    def post(self, url=None, raw=None, **fields):
        return self.client.post(url or self.url, data={
            'file': (io.BytesIO(self.image() if raw is None else raw), 'clipboard.png'), **fields,
        })

    def saved(self, response):
        self.assertEqual(response.status_code, 200, response.json)
        path, _ = app.resolve_daki_image_path(response.json['path'])
        return Path(path)

    def test_inspection_extracts_nai_base_character_negative_without_writes(self):
        response = self.post('/api/daki/image-import/inspect', raw=self.image(True))
        self.assertEqual(response.status_code, 200, response.json)
        info = response.json['promptInfo']
        self.assertEqual(info['basePrompt'], 'synthetic base')
        self.assertEqual(info['negativePrompt'], 'synthetic blur')
        self.assertEqual(info['charPrompts'], ['blue hair'])
        self.assertEqual(info['steps'], 28)
        self.assertTrue(response.json['hasPromptInfo'])
        self.assertEqual((response.json['width'], response.json['height']), (16, 24))
        self.assertFalse((self.root / 'imports').exists())

    def test_auto_import_retains_prompt_and_works_in_existing_viewer(self):
        response = self.post(raw=self.image(True), side='back')
        path = self.saved(response)
        info = self.client.post('/api/prompt_info', json={'path': response.json['path']}).json['data']
        self.assertEqual(info['basePrompt'], 'synthetic base')
        self.assertEqual(info['charPrompts'], ['blue hair'])
        project = app.DAKI_PROJECTS.get_project(self.project['id'])
        self.assertEqual(project['candidates']['front'], [])
        self.assertEqual(project['candidates']['back'][0]['path'], response.json['path'])
        served = self.client.get(response.json['src'])
        self.assertEqual(served.status_code, 200)
        served.close()
        with Image.open(path) as saved:
            self.assertEqual(saved.size, (16, 24))
        self.assertEqual(extract_prompt_info_from_image(str(path))['charPrompts'], ['blue hair'])

    def test_manual_region_meanings_survive_sidecar_embedded_and_api_reads(self):
        value = {'basePrompt': 'synthetic illustration', 'negativePrompt': 'blur',
                 'charPrompts': ['person'],
                 'promptRegions': [{'region': 'face', 'prompt': 'blue eyes'},
                                   {'region': 'hair', 'prompt': 'long hair'}]}
        response = self.post(side='front', promptInfo=json.dumps(value))
        path = self.saved(response)
        sidecar = load_prompt_sidecar(str(path))
        self.assertEqual(sidecar['basePrompt'], 'synthetic illustration, blue eyes, long hair')
        self.assertEqual(sidecar['promptRegions'][0],
                         {'region': 'face', 'label': '얼굴', 'prompt': 'blue eyes'})
        embedded = extract_prompt_info_from_image(str(path))
        self.assertEqual(embedded['promptRegions'], sidecar['promptRegions'])
        inspected = self.post('/api/daki/image-import/inspect', raw=path.read_bytes()).json
        self.assertEqual(inspected['promptInfo']['promptRegions'], sidecar['promptRegions'])
        viewer = self.client.post('/api/prompt_info', json={'path': response.json['path']}).json
        self.assertEqual(viewer['data']['promptRegions'], sidecar['promptRegions'])

    def test_no_metadata_can_be_explicitly_imported_without_prompt(self):
        inspection = self.post('/api/daki/image-import/inspect').json
        self.assertFalse(inspection['hasPromptInfo'])
        path = self.saved(self.post(side='front', promptInfo='{}'))
        self.assertFalse(path.with_suffix('.json').exists())

    def test_clearing_editable_prompts_also_clears_legacy_aliases(self):
        value = {'basePrompt': '', 'baseCaption': 'old base', 'negativePrompt': '',
                 'negative_prompt': 'old negative', 'uc': 'old negative',
                 'charPrompts': [], 'charPrompt': 'old character'}
        path = self.saved(self.post(side='front', raw=self.image(True), promptInfo=json.dumps(value)))
        self.assertFalse(path.with_suffix('.json').exists())

    def test_character_annotations_preserve_source_without_duplicating_into_base(self):
        characters = ['1.2::blue eyes, long hair::, unknown tag', 'blue eyes']
        value = {'basePrompt': 'synthetic base', 'charPrompts': characters,
                 'promptRegions': [{'region': 'face', 'characterIndex': 0, 'prompt': '1.2::blue eyes::'},
                                   {'region': 'hair', 'characterIndex': 0, 'prompt': '1.2::long hair::'},
                                   {'region': 'face', 'characterIndex': 1, 'prompt': 'blue eyes'},
                                   {'region': 'clothes', 'prompt': 'white dress'}]}
        response = self.post(side='front', promptInfo=json.dumps(value))
        path = self.saved(response)
        for info in (load_prompt_sidecar(str(path)), extract_prompt_info_from_image(str(path))):
            self.assertEqual(info['basePrompt'], 'synthetic base, white dress')
            self.assertEqual(info['charPrompts'], characters)
            self.assertEqual(info['promptRegions'][0]['characterIndex'], 0)
            self.assertEqual(info['promptRegions'][2]['characterIndex'], 1)
            self.assertNotIn('characterIndex', info['promptRegions'][3])
        viewer = self.client.post('/api/prompt_info', json={'path': response.json['path']}).json
        self.assertEqual(viewer['data']['promptRegions'][2]['characterIndex'], 1)

    def test_character_annotation_index_must_refer_to_existing_character(self):
        for index in (-1, 22, True, '0', 1):
            with self.subTest(index=index):
                value = {'charPrompts': ['blue eyes'], 'promptRegions': [
                    {'region': 'face', 'characterIndex': index, 'prompt': 'blue eyes'}]}
                self.assertEqual(self.post(side='front', promptInfo=json.dumps(value)).status_code, 400)
        self.assertFalse((self.root / 'imports').exists())

    def test_invalid_inputs_do_not_write_candidate_files(self):
        for fields in ({'side': 'other'}, {'side': 'front', 'promptInfo': '[]'},
                       {'side': 'front', 'promptInfo': '{broken'},
                       {'side': 'front', 'promptInfo': json.dumps({'promptRegions': [
                           {'region': '../invalid', 'prompt': 'text'}]})}):
            with self.subTest(fields=fields):
                self.assertEqual(self.post(**fields).status_code, 400)
        for raw in (b'', b'not an image'):
            self.assertEqual(self.post(raw=raw, side='front').status_code, 400)
        self.assertEqual(self.client.post(self.url, data={'side': 'front'}).status_code, 400)
        self.assertEqual(self.post('/api/daki/projects/' + 'f' * 32 + '/image-import', side='front').status_code, 404)
        self.assertFalse((self.root / 'imports').exists())

    def test_failed_candidate_save_rolls_back_new_image(self):
        with mock.patch.object(app.DAKI_PROJECTS, 'add_candidate', side_effect=OSError('synthetic')):
            self.assertEqual(self.post(side='front').status_code, 500)
        self.assertEqual(list((self.root / 'imports').rglob('*.png')), [])

    def test_jpeg_display_orientation_and_webp(self):
        stream = io.BytesIO()
        image = Image.new('RGB', (16, 24))
        exif = Image.Exif()
        exif[274] = 6
        image.save(stream, format='JPEG', exif=exif)
        inspection = self.post('/api/daki/image-import/inspect', raw=stream.getvalue()).json
        self.assertEqual((inspection['width'], inspection['height']), (24, 16))
        path = self.saved(self.post(side='front', raw=stream.getvalue(), promptInfo='{}'))
        with Image.open(path) as saved:
            self.assertEqual(saved.size, (24, 16))
        self.saved(self.post(side='front', raw=self.image(fmt='WEBP')))


if __name__ == '__main__':
    unittest.main()
