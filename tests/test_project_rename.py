from contextlib import contextmanager
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from flask import Flask
from PIL import Image

from naim.images.project_rename import rename_project_image
from naim.images.webp_conversion import resolve_webp_image
from naim.storage.daki_projects import DakiProjectsStore
from naim.storage.image_renames import resolve_renamed_image_path
from naim.web.daki import register_daki_routes


class ProjectRenameTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'original.png'
        Image.new('RGB', (8, 10), 'blue').save(self.source)
        self.source.with_suffix('.json').write_text('{"prompt":"synthetic"}', encoding='utf-8')

        def resolver(relative):
            path = resolve_renamed_image_path(self.root / relative)
            if not path.is_file():
                raise FileNotFoundError('missing')
            return str(path), path.name
        self.store = DakiProjectsStore(self.root / 'projects.json', resolver)
        self.first = self.store.create_project('Synthetic A', path='original.png', side='front')
        self.second = self.store.create_project('Synthetic B', path='original.png', side='back')
        self.candidate = self.first['candidates']['front'][0]

    def rename(self, name='수정한 그림.png', expected='original.png', **kwargs):
        return rename_project_image(self.store, self.first['id'], self.candidate['id'],
                                    name, expected, **kwargs)

    def test_rename_moves_bytes_metadata_and_shared_candidates_keeps_old_urls(self):
        original = self.source.read_bytes()
        result = self.rename()
        self.assertFalse(self.source.exists())
        self.assertEqual((self.root / '수정한 그림.png').read_bytes(), original)
        self.assertEqual((self.root / '수정한 그림.json').read_text(), '{"prompt":"synthetic"}')
        self.assertEqual(result['candidates']['front'][0]['name'], '수정한 그림.png')
        self.assertEqual(self.store.get_project(self.second['id'])['candidates']['back'][0]['name'], '수정한 그림.png')
        self.assertEqual(resolve_webp_image(self.source), self.root / '수정한 그림.png')
        self.rename('again.png', '수정한 그림.png')
        self.assertEqual(resolve_webp_image(self.source), self.root / 'again.png')

    def test_collisions_extensions_invalid_names_and_stale_edits_preserve_source(self):
        (self.root / 'taken.png').write_bytes(b'existing')
        for name, expected in [('taken.png', 'original.png'), ('bad.webp', 'original.png'),
                               ('CON.png', 'original.png'), ('../escape.png', 'original.png'),
                               ('ok.png', 'stale'), ('x' * 251 + '.png', 'original.png')]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.rename(name, expected)
            self.assertTrue(self.source.exists())
        self.assertEqual((self.root / 'taken.png').read_bytes(), b'existing')

    def test_store_save_failure_restores_source_sidecars_and_shared_names(self):
        from naim.storage.json_files import write_json

        def fail_project(path, data, **kwargs):
            if Path(path) == self.store.path and data != self.store._load(self.store.path):
                raise OSError('synthetic save failure')
            return write_json(path, data, **kwargs)
        with patch('naim.images.project_rename.write_json', side_effect=fail_project):
            with self.assertRaises(OSError):
                self.rename()
        self.assertTrue(self.source.is_file())
        self.assertTrue(self.source.with_suffix('.json').is_file())
        self.assertFalse((self.root / '수정한 그림.png').exists())
        self.assertNotIn('name', self.store.get_project(self.second['id'])['candidates']['back'][0])

    def test_reference_callback_failure_rolls_back_files(self):
        @contextmanager
        def fail(old, new):
            self.assertTrue(old.is_file() and new.is_file())
            raise OSError('synthetic index failure')
            yield
        with self.assertRaises(OSError):
            self.rename(reference_update=fail)
        self.assertTrue(self.source.exists())
        self.assertFalse((self.root / '수정한 그림.png').exists())

    def test_partial_bundle_move_failure_restores_actual_originals(self):
        original_replace = Path.replace

        def fail_sidecar(path, target):
            if path == self.source.with_suffix('.json'):
                raise OSError('synthetic metadata move failure')
            return original_replace(path, target)
        with patch.object(Path, 'replace', fail_sidecar):
            with self.assertRaises(OSError):
                self.rename()
        self.assertTrue(self.source.is_file())
        self.assertTrue(self.source.with_suffix('.json').is_file())
        self.assertFalse((self.root / '수정한 그림.png').exists())
        self.assertNotIn('name', self.store.get_project(self.second['id'])['candidates']['back'][0])

    def test_patch_endpoint_and_old_reference_survive(self):
        app = Flask(__name__)
        register_daki_routes(app, self.store.path, self.store.resolve_source)
        response = app.test_client().patch(
            f"/api/daki/projects/{self.first['id']}/candidates/{self.candidate['id']}",
            json={'name': 'renamed.png', 'expectedName': 'original.png'})
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(response.json['project']['candidates']['front'][0]['name'], 'renamed.png')
        self.assertEqual(self.store.resolve_image('original.png')[0], str(self.root / 'renamed.png'))

    def test_manifest_rejects_escape_and_cycles(self):
        from naim.storage.image_renames import MANIFEST_NAME
        manifest = self.root / MANIFEST_NAME
        for content in ['{"missing.png":"../outside.png"}', '{"missing.png":"missing.png"}']:
            manifest.write_text(content)
            with self.assertRaises(ValueError):
                resolve_renamed_image_path(self.root / 'missing.png')
