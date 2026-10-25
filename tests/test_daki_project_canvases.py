import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from urllib.parse import unquote, urlsplit

from flask import Flask
from PIL import Image

from naim.storage.daki_projects import (
    DakiCanvasConflict, DakiNotFoundError, DakiProjectsStore,
)
from naim.web.daki import register_daki_routes
from tests.test_daki_projects import gallery_resolver


class DakiProjectCanvasTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.gallery = self.root / 'gallery'
        self.gallery.mkdir()
        self.path = self.root / 'daki_projects.json'
        self.resolver = gallery_resolver(self.gallery)
        self.store = DakiProjectsStore(lambda: self.path, self.resolver)
        self.app = Flask(__name__)
        self.app.config['TESTING'] = True
        register_daki_routes(self.app, lambda: self.path, self.resolver)
        self.client = self.app.test_client()

    @staticmethod
    def state(marker='first'):
        return {
            'width': 640,
            'height': 800,
            'layers': [
                {'id': 'base', 'children': [{'id': 'child', 'children': []}]},
                {'id': 'top'},
            ],
            'promptInfo': {'prompt': marker, 'unknownNestedField': {'keep': True}},
            'masks': [{'id': 'mask', 'points': [[1, 2], [3, 4]]}],
            'extension': {'preserve': [1, {'x': 'y'}]},
        }

    @staticmethod
    def canvas(canvas_id, name, side, state=None):
        return {
            'id': canvas_id,
            'name': name,
            'side': side,
            'state': DakiProjectCanvasTests.state() if state is None else state,
        }

    def test_project_canvas_creation_is_atomic_and_retries_are_idempotent(self):
        payload = {
            'name': '  Front & Back  ',
            'canvas': self.canvas('a' * 32, '  Front draft  ', 'front'),
        }
        created = self.client.post('/api/daki/projects', json=payload)
        self.assertEqual(created.status_code, 201)
        project_id = created.json['project']['id']
        self.assertEqual(created.json['project']['name'], 'Front & Back')
        summaries = created.json['project']['canvases']['front']
        self.assertEqual(len(summaries), 1)
        self.assertEqual(summaries[0]['name'], 'Front draft')
        self.assertEqual(summaries[0]['layerCount'], 3)
        self.assertNotIn('state', summaries[0])
        self.assertNotIn('first', json.dumps(created.json))

        retry = self.client.post('/api/daki/projects', json=payload)
        self.assertEqual(retry.status_code, 201)
        self.assertEqual(retry.json['project']['id'], project_id)
        self.assertEqual(len(self.store.list_projects()), 1)

        conflict = self.client.post('/api/daki/projects', json={
            **payload,
            'canvas': self.canvas('a' * 32, 'Front draft', 'front', self.state('changed')),
        })
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.json['code'], 'canvas_conflict')
        self.assertIn('다시 열어', conflict.json['message'])
        self.assertEqual(len(self.store.list_projects()), 1)

        for invalid in (
            {'name': 'Invalid', 'canvas': self.canvas('b' * 32, 'Bad', 'front', {'width': True, 'height': 1, 'layers': []})},
            {'name': 'Invalid', 'canvas': self.canvas('b' * 32, 'Bad', 'front', {'width': 16001, 'height': 1, 'layers': []})},
            {'name': 'Invalid', 'canvas': self.canvas('b' * 32, 'Bad', 'sideways')},
            {'name': 'Invalid', 'canvas': self.canvas('b' * 32, ' ' * 2, 'front')},
            {'name': 'Invalid', 'canvas': self.canvas('B' * 32, 'Bad', 'front')},
        ):
            with self.subTest(invalid=invalid):
                response = self.client.post('/api/daki/projects', json=invalid)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(len(self.store.list_projects()), 1)

    def test_named_front_and_back_canvases_are_independent_and_summaries_hide_state(self):
        project = self.store.create_project('Independent')
        first = self.store.create_canvas(project['id'], self.canvas('1' * 32, 'Front A', 'front'))
        second = self.store.create_canvas(project['id'], self.canvas('2' * 32, 'Front B', 'front', self.state('second')))
        back = self.store.create_canvas(project['id'], self.canvas('3' * 32, 'Back A', 'back', self.state('back')))
        self.assertEqual(first['state']['promptInfo']['prompt'], 'first')
        self.assertEqual(second['state']['promptInfo']['prompt'], 'second')
        self.assertEqual(back['side'], 'back')
        self.assertEqual(self.store.create_canvas(project['id'], self.canvas('1' * 32, 'Front A', 'front')), first)
        with self.assertRaises(DakiCanvasConflict):
            self.store.create_canvas(project['id'], self.canvas('1' * 32, 'Renamed', 'front'))

        response = self.client.get('/api/daki/projects/' + project['id'])
        self.assertEqual(response.status_code, 200)
        public = response.json['project']
        self.assertEqual([item['name'] for item in public['canvases']['front']], ['Front A', 'Front B'])
        self.assertEqual([item['name'] for item in public['canvases']['back']], ['Back A'])
        serialized = json.dumps(public)
        for marker in ('promptInfo', 'unknownNestedField', 'points'):
            self.assertNotIn(marker, serialized)

        get_response = self.client.get(
            f"/api/daki/projects/{project['id']}/canvases/{second['id']}"
        )
        self.assertEqual(get_response.status_code, 200)
        self.assertEqual(get_response.json['canvas'], second)
        self.assertEqual(get_response.json['project'], {'id': project['id'], 'name': 'Independent'})
        self.assertEqual(list(self.store.canvas_states()), [first['state'], second['state'], back['state']])

    def test_canvas_update_revision_retry_and_existing_project_fields_are_preserved(self):
        image = self.gallery / 'candidate.png'
        Image.new('RGB', (3, 4)).save(image)
        project = self.store.create_project('With candidate', 'candidate.png', 'front')
        canvas = self.store.create_canvas(project['id'], self.canvas('4' * 32, 'Front', 'front'))
        stored = json.loads(self.path.read_text(encoding='utf-8'))
        stored['extension'] = {'root': 'keep'}
        stored['projects'][0]['extension'] = {'project': 'keep'}
        stored['projects'][0]['candidates']['front'][0]['extension'] = {'candidate': 'keep'}
        stored['projects'][0]['canvases']['front'][0]['extension'] = {'canvas': 'keep'}
        self.path.write_text(json.dumps(stored), encoding='utf-8')

        changed = self.state('updated')
        url = f"/api/daki/projects/{project['id']}/canvases/{canvas['id']}"
        saved = self.client.put(url, json={'state': changed, 'revision': 1})
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.json['canvas']['revision'], 2)
        self.assertEqual(saved.json['canvas']['layerCount'], 3)
        self.assertNotIn('state', saved.json['canvas'])
        self.assertNotIn('promptInfo', json.dumps(saved.json))

        retry = self.client.put(url, json={'state': changed, 'revision': 1})
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(retry.json['canvas']['revision'], 2)
        stale = self.client.put(url, json={'state': self.state('stale'), 'revision': 1})
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json['code'], 'canvas_conflict')
        self.assertEqual(self.store.get_canvas(project['id'], canvas['id'])['state'], changed)

        persisted = json.loads(self.path.read_text(encoding='utf-8'))
        self.assertEqual(persisted['extension'], {'root': 'keep'})
        updated_project = persisted['projects'][0]
        self.assertEqual(updated_project['extension'], {'project': 'keep'})
        self.assertEqual(updated_project['candidates']['front'][0]['extension'], {'candidate': 'keep'})
        self.assertEqual(updated_project['canvases']['front'][0]['extension'], {'canvas': 'keep'})

    def test_restored_save_with_new_timestamp_accepts_committed_content_only(self):
        project = self.store.create_project('Restored canvas')
        canvas = self.store.create_canvas(project['id'], self.canvas('7' * 32, 'Front', 'front'))
        url = f"/api/daki/projects/{project['id']}/canvases/{canvas['id']}"
        committed = {**self.state('same edit'), 'savedAt': 100}
        self.assertEqual(self.client.put(url, json={'state': committed, 'revision': 1}).status_code, 200)
        before = self.path.read_bytes()

        # Navigation can lose the successful reply; restoration captures a new timestamp.
        restored = {**committed, 'savedAt': 200}
        retry = self.client.put(url, json={'state': restored, 'revision': 1})
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(retry.json['canvas']['revision'], 2)
        self.assertEqual(self.path.read_bytes(), before)

        changed = {**restored, 'layers': []}
        conflict = self.client.put(url, json={'state': changed, 'revision': 1})
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(self.path.read_bytes(), before)

    def test_unknown_canvas_routes_and_invalid_json_inputs(self):
        project = self.store.create_project('Missing targets')
        self.assertEqual(self.client.get('/api/daki/projects/missing/canvases/nope').status_code, 404)
        self.assertEqual(self.client.put(
            f"/api/daki/projects/{project['id']}/canvases/nope",
            json={'state': self.state(), 'revision': 1},
        ).status_code, 404)
        self.assertEqual(self.client.post('/api/daki/projects/missing/canvases', json=self.canvas('5' * 32, 'X', 'front')).status_code, 404)
        self.assertEqual(self.client.post(
            f"/api/daki/projects/{project['id']}/canvases",
            data='{', content_type='application/json',
        ).status_code, 400)
        created = self.client.post(
            f"/api/daki/projects/{project['id']}/canvases",
            json=self.canvas('6' * 32, 'Valid', 'front'),
        )
        self.assertEqual(created.status_code, 201)
        canvas_id = created.json['canvas']['id']
        url = f"/api/daki/projects/{project['id']}/canvases/{canvas_id}"
        for revision in (True, 0, -1, '1', None):
            with self.subTest(revision=revision):
                response = self.client.put(url, json={'state': self.state(), 'revision': revision})
                self.assertEqual(response.status_code, 400)
        for state in (
            [], {'width': 1, 'height': 1, 'layers': {}},
            {'width': 1, 'height': 1}, {'width': 0, 'height': 1, 'layers': []},
        ):
            with self.subTest(state=state):
                response = self.client.put(url, json={'state': state, 'revision': 1})
                self.assertEqual(response.status_code, 400)
        self.assertEqual(self.store.get_canvas(project['id'], canvas_id)['revision'], 1)

    def test_failed_update_write_keeps_previous_file_and_canvas_state(self):
        project = self.store.create_project('Write failure')
        canvas = self.store.create_canvas(project['id'], self.canvas('7' * 32, 'Front', 'front'))
        original_bytes = self.path.read_bytes()
        with mock.patch('naim.storage.daki_projects.write_json', side_effect=OSError('private path')):
            with self.assertRaises(OSError):
                self.store.update_canvas(project['id'], canvas['id'], self.state('failed'), 1)
        self.assertEqual(self.path.read_bytes(), original_bytes)
        self.assertEqual(self.store.get_canvas(project['id'], canvas['id']), canvas)
        self.assertEqual(list(self.root.glob('*.tmp')), [])

    def test_canvas_image_references_are_cleaned_once_and_invalid_values_are_ignored(self):
        def clean_path(value):
            path = unquote(urlsplit(value).path)
            return path[len('/image/'):] if path.startswith('/image/') else path

        store = DakiProjectsStore(lambda: self.path, self.resolver, clean_path)
        project = store.create_project('Referenced')
        state = self.state()
        state['nested'] = {
            'source': '/image/group/literal%252Fname.png',
            'external': 'https://example.invalid/image/ignored.png',
            'invalid': '/image/../outside.png',
        }
        canvas = self.canvas('8' * 32, 'Reference front', 'front', state)
        store.create_canvas(project['id'], canvas)
        matches = store.references(paths=['group/literal%2Fname.png'])
        self.assertEqual(matches, [{
            'project_id': project['id'],
            'project_name': 'Referenced · Reference front',
            'side': 'front',
            'path': 'group/literal%2Fname.png',
        }])
        self.assertEqual(store.references(paths=['ignored.png']), [])

    def test_get_unknown_canvas_raises_not_found(self):
        project = self.store.create_project('No canvas')
        with self.assertRaises(DakiNotFoundError):
            self.store.get_canvas(project['id'], 'missing')

    def test_canvas_delete_preserves_project_candidates_other_canvas_and_saved_assets(self):
        image = self.gallery / 'candidate.png'
        Image.new('RGB', (3, 4), (20, 40, 60)).save(image)
        project = self.store.create_project('Canvas deletion', 'candidate.png', 'front')
        front_state = self.state('front secret')
        front_state['asset'] = '/image/candidate.png'
        front = self.store.create_canvas(
            project['id'], self.canvas('9' * 32, 'Front', 'front', front_state),
        )
        back = self.store.create_canvas(
            project['id'], self.canvas('a' * 32, 'Back', 'back', self.state('back remains')),
        )

        stored = json.loads(self.path.read_text(encoding='utf-8'))
        stored['extension'] = {'root': 'preserve'}
        saved_project = stored['projects'][0]
        saved_project['extension'] = {'project': 'preserve'}
        saved_project['updated_at'] = 'before deletion'
        saved_project['candidates']['front'][0]['extension'] = {'candidate': 'preserve'}
        saved_project['canvases']['front'][0]['extension'] = {'removed canvas': True}
        saved_project['canvases']['back'][0]['extension'] = {'canvas': 'preserve'}
        self.path.write_text(json.dumps(stored), encoding='utf-8')
        image_bytes = image.read_bytes()
        original_candidate = saved_project['candidates']['front'][0]['id']
        delete_url = f"/api/daki/projects/{project['id']}/canvases/{front['id']}"

        response = self.client.delete(delete_url)

        self.assertEqual(response.status_code, 200)
        public_project = response.json['project']
        self.assertEqual(public_project['canvases']['front'], [])
        self.assertEqual([item['id'] for item in public_project['canvases']['back']], [back['id']])
        self.assertNotIn('state', public_project['canvases']['back'][0])
        self.assertNotIn('front secret', json.dumps(response.json))
        self.assertEqual(image.read_bytes(), image_bytes)
        self.assertEqual(
            [candidate['id'] for candidate in public_project['candidates']['front']],
            [original_candidate],
        )

        saved = json.loads(self.path.read_text(encoding='utf-8'))
        self.assertEqual(saved['extension'], {'root': 'preserve'})
        saved_project = saved['projects'][0]
        self.assertEqual(saved_project['extension'], {'project': 'preserve'})
        self.assertNotEqual(saved_project['updated_at'], 'before deletion')
        self.assertEqual(saved_project['candidates']['front'][0]['extension'], {'candidate': 'preserve'})
        self.assertEqual(saved_project['canvases']['back'][0]['extension'], {'canvas': 'preserve'})
        saved_back = dict(saved_project['canvases']['back'][0])
        saved_back.pop('extension')
        self.assertEqual(saved_back, back)

        self.assertEqual(self.client.get(delete_url).status_code, 404)
        self.assertEqual(self.client.put(
            delete_url,
            json={'state': self.state('must not return'), 'revision': front['revision']},
        ).status_code, 404)
        missing_delete = self.client.delete(
            f"/api/daki/projects/{project['id']}/canvases/{'b' * 32}"
        )
        self.assertEqual(missing_delete.status_code, 404)
        self.assertEqual(self.store.get_project(project['id'])['canvases']['front'], [])

    def test_canvas_delete_storage_failure_keeps_original_json_and_canvas(self):
        project = self.store.create_project('Canvas delete failure')
        canvas = self.store.create_canvas(
            project['id'], self.canvas('c' * 32, 'Still here', 'front'),
        )
        original = self.path.read_bytes()

        with mock.patch('naim.storage.daki_projects.write_json', side_effect=OSError('private path')):
            response = self.client.delete(
                f"/api/daki/projects/{project['id']}/canvases/{canvas['id']}"
            )

        self.assertEqual(response.status_code, 500)
        self.assertNotIn('private path', response.json['message'])
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(self.store.get_canvas(project['id'], canvas['id']), canvas)


if __name__ == '__main__':
    unittest.main()
