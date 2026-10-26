"""Read-only project thumbnails must not transfer editable masks or prompts."""
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from flask import Flask
from PIL import Image, PngImagePlugin

from naim.web.daki import register_daki_routes


class DakiPreviewApiTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.app = Flask(__name__)
        self.app.config['TESTING'] = True
        self.store = register_daki_routes(
            self.app, lambda: self.root / 'projects.json',
            lambda relative: (str(self.root / relative), relative),
        )
        self.client = self.app.test_client()

    def test_preview_is_small_read_only_and_editor_still_gets_full_state(self):
        project = self.store.create_project('Synthetic large canvas')
        state = {'width': 1024, 'height': 2048, 'maskData': 'x' * 800000,
                 'promptInfo': {'prompt': 'synthetic text ' * 10000},
                 'layers': [{'id': 'rendered', 'type': 'image', 'visible': True,
                             'src': '/image/synthetic.png', 'x': 10, 'y': 20,
                             'layerWidth': 500, 'layerHeight': 1000,
                             'promptInfo': {'prompt': 'synthetic layer'},
                             'maskData': 'y' * 200000}]}
        canvas = self.store.create_canvas(project['id'], {
            'name': 'Synthetic', 'side': 'front', 'state': state,
        })
        original = self.store.path.read_bytes()
        url = f'/api/daki/projects/{project["id"]}/canvases/{canvas["id"]}'
        full = self.client.get(url)
        preview = self.client.get(url + '?preview=1')
        self.assertEqual((full.status_code, preview.status_code), (200, 200))
        self.assertEqual(full.json['canvas']['state'], state)
        self.assertEqual(preview.json['project'], full.json['project'])
        self.assertEqual(preview.json['canvas']['revision'], canvas['revision'])
        self.assertLess(len(preview.data), len(full.data) / 100)
        self.assertEqual(preview.json['canvas']['state'], {
            'width': 1024, 'height': 2048,
            'layers': [{'type': 'image', 'visible': True, 'pinnedReference': False, 'src': '/image/synthetic.png',
                        'x': 10, 'y': 20, 'layerWidth': 500, 'layerHeight': 1000}],
        })
        self.assertEqual(self.client.get(url + '?preview=invalid').json, full.json)
        self.assertEqual(self.store.path.read_bytes(), original)
        self.assertEqual(self.store.get_canvas(project['id'], canvas['id'])['state'], state)
        self.assertEqual(self.client.get('/api/daki/projects/missing/canvases/missing?preview=1').status_code, 404)

    def test_first_project_detail_does_not_decode_png_pixels_for_dimensions(self):
        path = self.root / 'synthetic.png'
        Image.new('RGB', (1024, 2048), (80, 120, 180)).save(path)
        project = self.store.create_project('Synthetic picture', path.name, 'front')
        with mock.patch.object(PngImagePlugin.PngImageFile, 'load', side_effect=AssertionError('decoded PNG pixels')):
            response = self.client.get('/api/daki/projects/' + project['id'])
        self.assertEqual(response.status_code, 200)
        candidate = response.json['project']['candidates']['front'][0]
        self.assertEqual((candidate['width'], candidate['height']), (1024, 2048))


if __name__ == '__main__':
    unittest.main()
