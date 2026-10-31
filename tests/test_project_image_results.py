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
from naim.images.canvas_export import (
    project_export_image_path,
    save_project_candidate_image,
    save_project_webp_candidate,
)
from naim.images.project_results import (
    process_project_webp_conversion,
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
        self.assertEqual(project['candidates']['front'][-1]['name'], 'source_업스케일_64x96.png')
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

    def test_project_upscale_name_uses_candidate_name_and_utf16_limit(self):
        named_source = self.gallery / 'named source.png'
        Image.new('RGB', (32, 48), (20, 40, 60)).save(named_source)
        original = named_source.read_bytes()
        source_name = ('한😀' * 35) + '<bad> .PNG'
        project = self.store.add_candidate(
            self.project['id'], named_source.name, 'front', name=source_name,
        )
        candidate = project['candidates']['front'][-1]

        def engine_with_actual_size(**kwargs):
            Image.new('RGB', (81, 105), (70, 80, 90)).save(kwargs['target_path'])
            return {'engine': 'lanczos'}

        with mock.patch('naim.images.project_results.upscale_logic.run_upscale',
                        side_effect=engine_with_actual_size):
            result = process_project_upscale_job(
                {
                    'source_path': candidate['path'],
                    'projectContext': self.context(candidate),
                    'target_width': 64,
                    'target_height': 96,
                    'engine': 'lanczos',
                },
                lambda *_args: None,
                store=self.store,
                export_root=self.export_root,
                prompt_info_loader=self.load_source_prompt,
                created_at=lambda: 'synthetic-time',
            )

        saved_candidate = self.store.get_project(self.project['id'])['candidates']['front'][-1]
        name = saved_candidate['name']
        self.assertTrue(name.endswith('_업스케일_81x105.png'), name)
        self.assertLessEqual(len(name.encode('utf-16-le')) // 2, 120)
        self.assertFalse(any(char in name for char in '<>:"/\\|?*'))
        self.assertFalse(any(ord(char) < 32 for char in name))
        self.assertEqual(named_source.read_bytes(), original)
        self.assertEqual(saved_candidate['path'], result['result_path'])

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

    def test_webp_candidate_save_rerolls_uuid_when_any_export_suffix_exists(self):
        source_webp = self.gallery / 'source.webp'
        Image.new('RGB', (32, 48), (10, 20, 30)).save(source_webp, format='WEBP')
        source_webp.with_suffix('.json').write_bytes(b'{"source":true}')
        collision = Path(project_export_image_path(
            self.export_root, self.project['id'], 'a' * 32,
        )).with_suffix('.json')
        collision.parent.mkdir(parents=True)
        collision.write_bytes(b'owned by an existing export')

        with mock.patch('naim.images.canvas_export.uuid.uuid4',
                        side_effect=[mock.Mock(hex='a' * 32), mock.Mock(hex='b' * 32),
                                     mock.Mock(hex='c' * 32)]):
            saved = save_project_webp_candidate(
                self.store, self.export_root, self.project['id'], 'front', source_webp,
            )

        expected = f'{PROJECT_EXPORT_PREFIX}/{self.project["id"]}/{"b" * 32}.webp'
        self.assertEqual(saved['path'], expected)
        self.assertEqual(collision.read_bytes(), b'owned by an existing export')
        actual, _ = self.store.resolve_image(saved['path'])
        self.assertTrue(actual.endswith('.webp'))
        self.assertEqual(Path(actual).with_suffix('.json').read_bytes(), b'{"source":true}')
        self.assertEqual(len(self.store.get_project(self.project['id'])['candidates']['front']), 2)

    def test_project_webp_conversion_adds_same_side_candidate_and_preserves_sources(self):
        back = self.store.add_candidate(self.project['id'], 'source.png', 'back')['candidates']['back'][0]
        self.source.with_suffix('.txt').write_bytes(b'synthetic sidecar bytes\x00')
        source_json = self.source.with_suffix('.json').read_bytes()
        source_text = self.source.with_suffix('.txt').read_bytes()

        result = process_project_webp_conversion(
            self.store, self.export_root, self.context(), 'source.png', 84, threading.Event(),
        )

        self.assertEqual(result['status'], 'converted', result)
        self.assertEqual(result['destination'], 'project')
        self.assertEqual(result['side'], 'front')
        self.assertEqual(result['projectName'], 'Synthetic project')
        self.assertTrue(result['result_path'].startswith(f'{PROJECT_EXPORT_PREFIX}/'))
        self.assertEqual(result['path'], result['result_path'])
        self.assertEqual(self.source.read_bytes(), self.original)
        self.assertEqual(self.source.with_suffix('.json').read_bytes(), source_json)
        self.assertEqual(self.source.with_suffix('.txt').read_bytes(), source_text)

        project = self.store.get_project(self.project['id'])
        self.assertEqual(len(project['candidates']['front']), 2)
        self.assertEqual(project['candidates']['front'][0]['id'], self.front_candidate['id'])
        self.assertEqual(len(project['candidates']['back']), 1)
        self.assertEqual(project['candidates']['back'][0]['id'], back['id'])
        new_candidate = project['candidates']['front'][1]
        self.assertTrue(new_candidate['path'].endswith('.webp'))
        exported = validate_project_image_context(
            self.store, self.context(new_candidate), result['result_path'],
        )
        self.assertTrue(exported['sourceFullPath'].endswith('.webp'))
        saved_webp = Path(exported['sourceFullPath'])
        self.assertEqual(saved_webp.with_suffix('.json').read_bytes(), source_json)
        self.assertEqual(saved_webp.with_suffix('.txt').read_bytes(), source_text)
        with Image.open(saved_webp) as image:
            self.assertEqual(image.format, 'WEBP')
            image.verify()
        self.assertEqual(load_prompt_sidecar(saved_webp)['basePrompt'], 'synthetic source prompt')

    def test_existing_webp_project_candidate_is_skipped_without_adding_an_export(self):
        source_webp = self.gallery / 'already.webp'
        Image.new('RGB', (32, 48), (10, 20, 30)).save(source_webp, format='WEBP')
        project = self.store.add_candidate(self.project['id'], 'already.webp', 'front')
        candidate = project['candidates']['front'][-1]
        context = self.context(candidate)

        result = process_project_webp_conversion(
            self.store, self.export_root, context, candidate['path'], 84, threading.Event(),
        )

        self.assertEqual(result['status'], 'skipped')
        self.assertIn('이미 WebP', result['reason'])
        self.assertEqual(len(self.store.get_project(self.project['id'])['candidates']['front']), 2)
        self.assertFalse(self.export_root.exists())

    def test_webp_candidate_registration_failure_removes_only_new_export_files(self):
        def convert_copy(source_path, **options):
            self.assertFalse(options['lossless'])
            self.assertEqual(options['quality'], 84)
            target = Path(source_path).with_suffix('.webp')
            Image.new('RGB', (32, 48), (1, 2, 3)).save(target, format='WEBP')
            return {'status': 'converted', 'source_bytes': Path(source_path).stat().st_size,
                    'target_bytes': target.stat().st_size}

        with mock.patch('naim.images.project_results.convert_image_to_webp', side_effect=convert_copy), \
             mock.patch.object(self.store, 'add_candidate', side_effect=OSError('synthetic write failure')):
            with self.assertRaisesRegex(OSError, 'synthetic write failure'):
                process_project_webp_conversion(
                    self.store, self.export_root, self.context(), 'source.png', 84, threading.Event(),
                )
        self.assertEqual(self.source.read_bytes(), self.original)
        self.assertEqual(len(self.store.get_project(self.project['id'])['candidates']['front']), 1)
        self.assertEqual(list((self.export_root / self.project['id']).glob('*')), [])

    def test_invalid_project_candidate_does_not_start_conversion(self):
        invalid_context = {**self.context(), 'candidateId': 'e' * 32}
        with mock.patch('naim.images.project_results.convert_image_to_webp',
                        side_effect=AssertionError('conversion started')):
            with self.assertRaises(DakiNotFoundError):
                process_project_webp_conversion(
                    self.store, self.export_root, invalid_context, 'source.png', 84, threading.Event(),
                )
        self.assertFalse(self.export_root.exists())
        self.assertEqual(self.source.read_bytes(), self.original)

    def test_cancel_after_encoding_skips_project_persistence(self):
        cancel = threading.Event()

        def converted_then_cancelled(source_path, **_options):
            target = Path(source_path).with_suffix('.webp')
            Image.new('RGB', (32, 48), (1, 2, 3)).save(target, format='WEBP')
            cancel.set()
            return {'status': 'converted', 'source_bytes': Path(source_path).stat().st_size,
                    'target_bytes': target.stat().st_size}

        with mock.patch('naim.images.project_results.convert_image_to_webp',
                        side_effect=converted_then_cancelled):
            result = process_project_webp_conversion(
                self.store, self.export_root, self.context(), 'source.png', 84, cancel,
            )
        self.assertEqual(result['status'], 'skipped')
        self.assertEqual(len(self.store.get_project(self.project['id'])['candidates']['front']), 1)
        self.assertFalse(self.export_root.exists())
        self.assertEqual(self.source.read_bytes(), self.original)

    def test_candidate_removed_during_encoding_prevents_export_registration(self):
        def convert_then_remove_candidate(source_path, **_options):
            target = Path(source_path).with_suffix('.webp')
            Image.new('RGB', (32, 48), (1, 2, 3)).save(target, format='WEBP')
            self.store.remove_candidate(self.project['id'], self.front_candidate['id'])
            return {'status': 'converted', 'source_bytes': Path(source_path).stat().st_size,
                    'target_bytes': target.stat().st_size}

        with mock.patch('naim.images.project_results.convert_image_to_webp',
                        side_effect=convert_then_remove_candidate):
            with self.assertRaises(DakiNotFoundError):
                process_project_webp_conversion(
                    self.store, self.export_root, self.context(), 'source.png', 84, threading.Event(),
                )
        self.assertEqual(self.store.get_project(self.project['id'])['candidates']['front'], [])
        self.assertFalse(self.export_root.exists())
        self.assertEqual(self.source.read_bytes(), self.original)


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
