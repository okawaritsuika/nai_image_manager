"""Project candidate upscale and inpaint results stay in the chosen Daki side."""
import base64
from contextlib import contextmanager
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
import zipfile
from unittest import mock

from PIL import Image

import app
from naim.daki_image_refs import PROJECT_EXPORT_PREFIX, resolve_daki_image_reference
from naim.images.canvas_export import save_project_candidate_image
from naim.images.project_results import (
    process_project_upscale_job,
    validate_project_image_context,
)
from naim.images.prompt_metadata import load_prompt_sidecar, save_prompt_sidecar
from naim.jobs.upscale import UpscaleJobs
from naim.processes import UpscaleCancelled
from naim.storage.daki_projects import DakiNotFoundError
from naim.web.upscale import UpscaleAPI
from tests.test_upscale_jobs import wait_terminal


class ProjectImageResultStorageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.gallery = self.root / 'gallery'
        self.gallery.mkdir()
        self.export_root = self.root / 'canvas_imports' / 'project_exports'
        self.source = self.gallery / 'source.png'
        Image.new('RGB', (32, 48), (40, 120, 200)).save(self.source)
        self.original = self.source.read_bytes()
        self.prompt_info = {'basePrompt': 'synthetic source prompt', 'negativePrompt': 'synthetic blur'}
        save_prompt_sidecar(str(self.source), self.prompt_info)
        self.catalog_aliases = {'alias.png': self.source}

        def resolve_source(relative):
            if relative.startswith(PROJECT_EXPORT_PREFIX + '/'):
                return resolve_daki_image_reference(
                    relative, None, project_exports_root=self.export_root,
                )
            if relative.startswith('__daki_shared__/'):
                return str(self.source), relative
            target = self.gallery / relative
            target = self.catalog_aliases.get(relative, target)
            if not target.is_file():
                raise FileNotFoundError('synthetic image missing')
            return str(target), relative

        from naim.storage.daki_projects import DakiProjectsStore
        self.store = DakiProjectsStore(self.root / 'projects.json', resolve_source)
        self.project = self.store.create_project('Synthetic project', 'source.png', 'front')
        self.front_candidate = self.project['candidates']['front'][0]

    def context(self, candidate=None, side='front', project_id=None):
        candidate = candidate or self.front_candidate
        return {
            'projectId': project_id or self.project['id'],
            'side': side,
            'candidateId': candidate['id'],
        }

    def load_source_prompt(self, path):
        return load_prompt_sidecar(path) or {}

    def test_context_accepts_gallery_alias_catalog_and_project_export_sources(self):
        alias = validate_project_image_context(
            self.store, self.context(), 'alias.png',
        )
        self.assertEqual(alias['sourceFullPath'], str(self.source))

        catalog_project = self.store.add_candidate(
            self.project['id'], '__daki_shared__/synthetic.png', 'back',
        )
        catalog_candidate = catalog_project['candidates']['back'][0]
        catalog = validate_project_image_context(
            self.store, self.context(catalog_candidate, 'back'), catalog_candidate['path'],
        )
        self.assertEqual(catalog['candidatePath'], '__daki_shared__/synthetic.png')

        exported = save_project_candidate_image(
            self.store, self.export_root, self.project['id'], 'back',
            Image.new('RGBA', (32, 48), (1, 2, 3, 255)), self.prompt_info,
        )
        export_candidate = self.store.get_project(self.project['id'])['candidates']['back'][-1]
        self.assertEqual(export_candidate['path'], exported['path'])
        resolved = validate_project_image_context(
            self.store, self.context(export_candidate, 'back'), exported['path'],
        )
        self.assertTrue(resolved['sourceFullPath'].endswith('.png'))
        self.assertEqual(resolved['sourceRelativePath'], exported['path'])

    def test_invalid_project_candidate_side_and_path_are_rejected(self):
        with self.assertRaises(ValueError):
            validate_project_image_context(self.store, None, 'source.png')
        with self.assertRaises(ValueError):
            validate_project_image_context(
                self.store, {**self.context(), 'side': 'sideways'}, 'source.png',
            )
        with self.assertRaises(DakiNotFoundError):
            validate_project_image_context(
                self.store, self.context(project_id='f' * 32), 'source.png',
            )
        with self.assertRaises(DakiNotFoundError):
            validate_project_image_context(
                self.store, {**self.context(), 'candidateId': 'e' * 32}, 'source.png',
            )
        other = self.gallery / 'other.png'
        Image.new('RGB', (32, 48), (1, 2, 3)).save(other)
        with self.assertRaisesRegex(ValueError, '일치하지 않습니다'):
            validate_project_image_context(self.store, self.context(), 'other.png')

    def test_real_lanczos_upscale_adds_metadata_and_preserves_original(self):
        result = process_project_upscale_job(
            {
                'source_path': self.front_candidate['path'],
                'projectContext': self.context(),
                'target_width': 64,
                'target_height': 96,
                'engine': 'lanczos',
                'quality': 'standard',
            },
            lambda *_args: None,
            store=self.store,
            export_root=self.export_root,
            prompt_info_loader=self.load_source_prompt,
            created_at=lambda: 'synthetic-time',
        )
        self.assertEqual(result['destination'], 'project')
        self.assertEqual(result['side'], 'front')
        self.assertEqual(result['projectContext'], self.context())
        self.assertEqual(self.source.read_bytes(), self.original)
        project = self.store.get_project(self.project['id'])
        self.assertEqual(len(project['candidates']['front']), 2)
        self.assertEqual(project['candidates']['back'], [])
        full_path, _ = resolve_daki_image_reference(
            result['result_path'], None, project_exports_root=self.export_root,
        )
        with Image.open(full_path) as image:
            self.assertEqual(image.size, (64, 96))
        sidecar = load_prompt_sidecar(full_path)
        self.assertEqual(sidecar['basePrompt'], 'synthetic source prompt')
        saved_sidecar = json.loads(Path(full_path).with_suffix('.json').read_text(encoding='utf-8'))
        self.assertEqual(saved_sidecar['upscale']['engine'], 'lanczos')
        self.assertEqual(saved_sidecar['upscale']['source_path'], 'source.png')

    def test_cancel_before_persistence_leaves_no_candidate_or_export(self):
        cancel = threading.Event()

        def cancelled_engine(**kwargs):
            Image.new('RGB', (64, 96)).save(kwargs['target_path'])
            cancel.set()
            return {'engine': 'lanczos'}

        with mock.patch('naim.images.project_results.upscale_logic.run_upscale', side_effect=cancelled_engine):
            with self.assertRaises(UpscaleCancelled):
                process_project_upscale_job(
                    {
                        'source_path': self.front_candidate['path'],
                        'projectContext': self.context(),
                        'target_width': 64,
                        'target_height': 96,
                        'engine': 'lanczos',
                        '_cancel_event': cancel,
                    },
                    lambda *_args: None,
                    store=self.store,
                    export_root=self.export_root,
                    prompt_info_loader=self.load_source_prompt,
                    created_at=lambda: 'synthetic-time',
                )
        self.assertEqual(len(self.store.get_project(self.project['id'])['candidates']['front']), 1)
        self.assertFalse(self.export_root.exists())

    def test_failed_project_link_rolls_back_new_image_and_sidecar(self):
        with mock.patch.object(self.store, 'add_candidate', side_effect=OSError('synthetic write failure')):
            with self.assertRaisesRegex(OSError, 'synthetic write failure'):
                save_project_candidate_image(
                    self.store, self.export_root, self.project['id'], 'front',
                    Image.new('RGBA', (8, 8), (1, 2, 3, 255)), self.prompt_info,
                )
        self.assertEqual(len(self.store.get_project(self.project['id'])['candidates']['front']), 1)
        self.assertEqual(list((self.export_root / self.project['id']).glob('*')), [])


class ProjectImageResultRouteTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.gallery = self.root / 'gallery'
        self.gallery.mkdir()
        self.imports = self.root / 'canvas_imports'
        self.imports.mkdir()
        self.source = self.gallery / 'source.png'
        Image.new('RGB', (32, 48), (40, 120, 200)).save(self.source)
        self.original = self.source.read_bytes()
        self.path_patchers = [
            mock.patch.object(app, 'CLASSIFIED_DIR', str(self.gallery)),
            mock.patch.object(app, 'CANVAS_IMPORT_DIR', str(self.imports)),
            mock.patch.object(app, 'DAKI_PROJECTS_FILE', str(self.root / 'projects.json')),
        ]
        for patcher in self.path_patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        app.app.config['TESTING'] = True
        self.client = app.app.test_client()
        self.project = app.DAKI_PROJECTS.create_project('Synthetic route project', 'source.png', 'back')
        self.candidate = self.project['candidates']['back'][0]
        self.context = {
            'projectId': self.project['id'],
            'side': 'back',
            'candidateId': self.candidate['id'],
        }

    @staticmethod
    def data_url(image):
        output = io.BytesIO()
        image.save(output, format='PNG')
        return 'data:image/png;base64,' + base64.b64encode(output.getvalue()).decode('ascii')

    @staticmethod
    def archive_bytes(image):
        png = io.BytesIO()
        image.save(png, format='PNG')
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w') as bundle:
            bundle.writestr('result.png', png.getvalue())
        return archive.getvalue()

    def test_inpaint_saves_even_when_temporary_persistence_is_disabled(self):
        generated = self.archive_bytes(Image.new('RGB', (32, 48), (10, 20, 30)))

        @contextmanager
        def fake_archive(_api_key, _payload):
            with zipfile.ZipFile(io.BytesIO(generated)) as bundle:
                yield bundle

        with mock.patch.object(app, 'generated_image_archive', side_effect=fake_archive):
            response = self.client.post('/api/canvas/inpaint', json={
                'key': 'synthetic-key',
                'image': self.data_url(Image.new('RGB', (32, 48), 'white')),
                'mask': self.data_url(Image.new('RGBA', (32, 48), (255, 255, 255, 255))),
                'promptInfo': {'model': 'nai-diffusion-5-full', 'basePrompt': 'synthetic inpaint prompt'},
                'persistResult': False,
                'projectContext': self.context,
                'source_path': self.candidate['path'],
            })
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(response.json['destination'], 'project')
        self.assertEqual(response.json['side'], 'back')
        self.assertEqual(response.json['projectContext'], self.context)
        self.assertTrue(response.json['path'].startswith('__daki_exports__/'))
        self.assertTrue(response.json['src'].startswith('/image/__daki_exports__/'))
        project = app.DAKI_PROJECTS.get_project(self.project['id'])
        self.assertEqual(len(project['candidates']['back']), 2)
        self.assertEqual(project['candidates']['front'], [])
        self.assertEqual(self.source.read_bytes(), self.original)
        saved = app.resolve_daki_image_path(response.json['path'])[0]
        self.assertEqual(load_prompt_sidecar(saved)['basePrompt'], 'synthetic inpaint prompt')

    def test_unscoped_inpaint_keeps_existing_temporary_response_shape(self):
        generated = self.archive_bytes(Image.new('RGB', (32, 48), (10, 20, 30)))

        @contextmanager
        def fake_archive(_api_key, _payload):
            with zipfile.ZipFile(io.BytesIO(generated)) as bundle:
                yield bundle

        with mock.patch.object(app, 'generated_image_archive', side_effect=fake_archive):
            response = self.client.post('/api/canvas/inpaint', json={
                'key': 'synthetic-key',
                'image': self.data_url(Image.new('RGB', (32, 48), 'white')),
                'mask': self.data_url(Image.new('RGBA', (32, 48), (255, 255, 255, 255))),
                'promptInfo': {'model': 'nai-diffusion-5-full'},
                'persistResult': False,
            })
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(set(response.json), {'status', 'src', 'name', 'image', 'promptInfo'})
        self.assertTrue(response.json['src'].startswith('data:image/png;base64,'))
        self.assertEqual(response.json['name'], '')

    def test_invalid_context_is_rejected_before_inpaint_network_call(self):
        Image.new('RGB', (32, 48), (1, 2, 3)).save(self.gallery / 'other.png')
        body = {
            'key': 'synthetic-key',
            'image': self.data_url(Image.new('RGB', (32, 48), 'white')),
            'mask': self.data_url(Image.new('RGBA', (32, 48), (255, 255, 255, 255))),
            'promptInfo': {'model': 'nai-diffusion-5-full'},
            'projectContext': self.context,
            'source_path': 'other.png',
        }
        with mock.patch.object(app, 'generated_image_archive', side_effect=AssertionError('network called')):
            response = self.client.post('/api/canvas/inpaint', json=body)
        self.assertEqual(response.status_code, 400, response.json)
        self.assertEqual(len(app.DAKI_PROJECTS.get_project(self.project['id'])['candidates']['back']), 1)

    def test_invalid_upscale_context_is_rejected_before_job_submission(self):
        jobs = mock.Mock()
        api = UpscaleAPI(
            jobs,
            app.clean_gallery_rel_path,
            mock.Mock(side_effect=AssertionError('gallery resolver used')),
            validate_project_context=lambda context, source_path: validate_project_image_context(
                app.DAKI_PROJECTS, context, source_path,
            ),
        )
        with mock.patch.object(app, 'UPSCALE_API', api):
            invalid_side = self.client.post('/api/gallery/upscale/start', json={
                'source_path': self.candidate['path'],
                'projectContext': {**self.context, 'side': 'invalid'},
            })
            missing_candidate = self.client.post('/api/gallery/upscale/start', json={
                'source_path': self.candidate['path'],
                'projectContext': {**self.context, 'side': 'front'},
            })
        self.assertEqual(invalid_side.status_code, 400, invalid_side.json)
        self.assertEqual(missing_candidate.status_code, 404, missing_candidate.json)
        jobs.submit.assert_not_called()

    def test_project_upscale_route_returns_context_and_adds_result(self):
        service = UpscaleJobs(app.process_gallery_upscale_job)
        api = UpscaleAPI(
            service,
            app.clean_gallery_rel_path,
            app.resolve_gallery_image_path,
            validate_project_context=lambda context, source_path: validate_project_image_context(
                app.DAKI_PROJECTS, context, source_path,
            ),
        )
        try:
            with mock.patch.object(app, 'UPSCALE_API', api):
                response = self.client.post('/api/gallery/upscale/start', json={
                    'source_path': self.candidate['path'],
                    'projectContext': self.context,
                    'target_width': 64,
                    'target_height': 96,
                    'engine': 'lanczos',
                })
            self.assertEqual(response.status_code, 200, response.json)
            self.assertEqual(response.json['job']['projectContext'], self.context)
            state = wait_terminal(service, response.json['job_id'])
            self.assertEqual(state['status'], 'done', state)
            self.assertEqual(state['destination'], 'project')
            self.assertEqual(state['projectContext'], self.context)
            self.assertTrue(state['result_path'].startswith('__daki_exports__/'))
            project = app.DAKI_PROJECTS.get_project(self.project['id'])
            self.assertEqual(len(project['candidates']['back']), 2)
            self.assertEqual(project['candidates']['front'], [])
            self.assertEqual(self.source.read_bytes(), self.original)
        finally:
            self.assertTrue(service.shutdown(timeout=2))


if __name__ == '__main__':
    unittest.main()
