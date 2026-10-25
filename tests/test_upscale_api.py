import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

from flask import Flask
from PIL import Image
import app
from naim.jobs.upscale import UpscaleJobs
from naim.web.upscale import UpscaleAPI
from naim.web.lifecycle import register_job_shutdown
from tests.test_upscale_jobs import wait_terminal
from naim.processes import UpscaleCancelled


class UpscaleApiTests(unittest.TestCase):
    def test_gallery_fit_5_16_preserves_selected_target_and_job_flag(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'source.png'
            Image.new('RGB', (32, 48)).save(source)
            jobs = mock.Mock()
            jobs.submit.return_value = {'id': 'synthetic-job', 'status': 'queued'}
            api = UpscaleAPI(jobs, lambda value: value, lambda _value: (str(source), source.name))
            with mock.patch.object(app, 'UPSCALE_API', api):
                response = app.app.test_client().post('/api/gallery/upscale/start', json={
                    'source_path': 'source.png', 'engine': 'lanczos',
                    'target_width': 64, 'target_height': 96, 'fit_5_16': True,
                })

            self.assertEqual(response.status_code, 200, response.json)
            job = jobs.submit.call_args.args[0]
            self.assertEqual((job['target_width'], job['target_height']), (64, 96))
            self.assertIs(job['fit_5_16'], True)

    def test_canvas_fit_5_16_returns_cropped_result_dimensions(self):
        import io
        source = io.BytesIO()
        Image.new('RGB', (32, 64), (30, 60, 90)).save(source, format='PNG')
        service = UpscaleJobs(mock.Mock())
        seen = {}

        def engine(**kwargs):
            seen.update(kwargs)
            self.assertEqual((kwargs['target_width'], kwargs['target_height']), (64, 128))
            self.assertIs(kwargs['fit_5_16'], True)
            Image.new('RGBA', (40, 128), (1, 2, 3, 255)).save(kwargs['target_path'], 'PNG')
            return {'engine': 'lanczos', 'final_width': 40, 'final_height': 128}

        with mock.patch.object(app, 'UPSCALE_SERVICE', service), \
             mock.patch.object(app, 'read_canvas_image_bytes', return_value=source.getvalue()), \
             mock.patch.object(app.upscale_logic, 'run_upscale', side_effect=engine), \
             mock.patch.object(app, 'save_canvas_generated_image', return_value=('/generated.png', 'generated.png')) as save:
            try:
                response = app.app.test_client().post('/api/canvas/reference_upscale', json={
                    'image': 'synthetic.png', 'engine': 'lanczos',
                    'target_width': 64, 'target_height': 128, 'fit_5_16': True,
                })
            finally:
                self.assertTrue(service.shutdown(timeout=2))

        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual((response.json['width'], response.json['height']), (40, 128))
        self.assertEqual((seen['target_width'], seen['target_height']), (64, 128))
        save.assert_called_once()

    def test_shutdown_cancels_canvas_engine_and_does_not_save_result(self):
        import io
        source = io.BytesIO()
        Image.new('RGB', (32, 48)).save(source, format='PNG')
        service = UpscaleJobs(mock.Mock())
        started = threading.Event()
        responses = []

        def engine(**kwargs):
            started.set()
            if kwargs['cancel_event'].wait(3):
                raise UpscaleCancelled()
            self.fail('Canvas engine did not receive cancellation')

        def request():
            with app.app.test_client() as client:
                responses.append(client.post('/api/canvas/reference_upscale', json={
                    'image': 'synthetic.png', 'engine': 'lanczos',
                    'target_width': 64, 'target_height': 96,
                }))

        with mock.patch.object(app, 'UPSCALE_SERVICE', service), \
             mock.patch.object(app, 'read_canvas_image_bytes', return_value=source.getvalue()), \
             mock.patch.object(app.upscale_logic, 'run_upscale', side_effect=engine), \
             mock.patch.object(app, 'save_canvas_generated_image') as save:
            thread = threading.Thread(target=request)
            thread.start()
            try:
                self.assertTrue(started.wait(2))
                self.assertTrue(service.shutdown(timeout=2))
            finally:
                service.shutdown(timeout=2)
                thread.join(3)
            self.assertFalse(thread.is_alive())
            self.assertEqual(responses[0].json['status'], 'error')
            save.assert_not_called()
            with self.assertRaises(UpscaleCancelled):
                with service.direct_operation():
                    self.fail('New canvas work accepted after shutdown')

    def test_real_lanczos_job_keeps_original_and_saves_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'source.png'
            Image.new('RGB', (32, 48), (40, 120, 200)).save(source)
            app.save_prompt_sidecar(str(source), {'basePrompt': 'test prompt'})
            original = source.read_bytes()
            service = UpscaleJobs(app.process_gallery_upscale_job)
            api = UpscaleAPI(service, app.clean_gallery_rel_path, lambda value: (str(source), 'source.png'))
            with mock.patch.object(app, 'UPSCALE_API', api), \
                 mock.patch.object(app, 'CLASSIFIED_DIR', temp), \
                 mock.patch.object(app, 'resolve_gallery_image_path', return_value=(str(source), 'source.png')), \
                 mock.patch.object(app, 'sync_gallery_prompt_art_styles_for_path'), \
                 mock.patch.object(app, 'refresh_gallery_index_for_file_change') as refresh:
                try:
                    client = app.app.test_client()
                    response = client.post('/api/gallery/upscale/start', json={
                        'source_path': 'source.png', 'engine': 'lanczos',
                        'target_width': 64, 'target_height': 96,
                    })
                    self.assertEqual(response.status_code, 200, response.json)
                    self.assertEqual(response.json['status'], 'started')
                    identifier = response.json['job_id']
                    state = wait_terminal(service, identifier)
                    self.assertEqual(state['status'], 'done', state)
                    self.assertEqual(client.get('/api/gallery/upscale/status/' + identifier).json['job'], state)
                    self.assertEqual(len(client.get('/api/gallery/upscale/jobs').json['jobs']), 1)
                    self.assertEqual(client.post('/api/gallery/upscale/cancel/' + identifier).json['job'], state)
                    self.assertEqual(client.get('/api/gallery/upscale/status/missing').status_code, 404)
                    self.assertEqual(client.post('/api/gallery/upscale/cancel/missing').status_code, 404)
                    target = Path(temp) / state['result_path']
                    with Image.open(target) as image:
                        self.assertEqual(image.size, (64, 96))
                    sidecar = json.loads(target.with_suffix('.json').read_text(encoding='utf-8'))
                    self.assertEqual(sidecar['basePrompt'], 'test prompt')
                    self.assertEqual(sidecar['upscale']['engine'], 'lanczos')
                    self.assertEqual(source.read_bytes(), original)
                    refresh.assert_called_once()
                finally:
                    self.assertTrue(service.shutdown(timeout=2))

    def test_request_validation_preserves_error_statuses(self):
        jobs = mock.Mock()
        api = UpscaleAPI(jobs, lambda value: value, mock.Mock(side_effect=FileNotFoundError('missing')))
        with mock.patch.object(app, 'UPSCALE_API', api):
            client = app.app.test_client()
            self.assertEqual(client.post('/api/gallery/upscale/start', json={}).status_code, 400)
            self.assertEqual(client.post('/api/gallery/upscale/start', json={'source_path': 'missing.png'}).status_code, 404)
        jobs.submit.assert_not_called()

    def test_private_shutdown_requires_both_instance_token_and_pid(self):
        server = Flask(__name__)
        jobs = mock.Mock()
        jobs.shutdown.return_value = True
        register_job_shutdown(server, jobs, 'synthetic-control-token')
        client = server.test_client()
        url = '/api/internal/shutdown_jobs'
        self.assertEqual(client.post(url, json={'pid': os.getpid()}).status_code, 403)
        headers = {'X-NAIM-Control': 'synthetic-control-token'}
        self.assertEqual(client.post(url, json={'pid': -1}, headers=headers).status_code, 403)
        jobs.shutdown.assert_not_called()
        self.assertEqual(client.post(url, json={'pid': os.getpid()}, headers=headers).json, {'status': 'success', 'stopped': True})
        jobs.shutdown.assert_called_once_with()
