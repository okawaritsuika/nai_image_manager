from pathlib import Path
import tempfile
import unittest
from unittest import mock

from flask import Flask

from naim.storage.daki_projects import DakiProjectsStore
from naim.web.daki import register_daki_routes


class _NoDeepcopy:
    def __deepcopy__(self, memo):
        raise AssertionError('large state payload should not be copied')


def project_fixture(*, guarded=False):
    payload = _NoDeepcopy() if guarded else {'large': [1, {'nested': 'state'}]}
    state = {
        'width': 640,
        'height': 800,
        'layers': [{'children': [{'id': 'nested'}]}, {'id': 'top'}],
        'maskData': payload,
    }
    config = _NoDeepcopy() if guarded else {'prompts': ['private']}
    return {
        'id': 'project-id',
        'name': 'Read performance',
        'created_at': '2026-10-01T00:00:00+00:00',
        'updated_at': '2026-10-02T00:00:00+00:00',
        'candidates': {'front': [], 'back': []},
        'canvasSettings': config,
        'detailPromptPresets': config,
        'extension': {'nested': [1, {'keep': True}]},
        'canvases': {
            'front': [{
                'id': 'a' * 32,
                'name': 'Front',
                'side': 'front',
                'revision': 3,
                'created_at': '2026-10-01T01:00:00+00:00',
                'updated_at': '2026-10-02T01:00:00+00:00',
                'state': state,
            }],
            'back': [],
        },
    }


class DakiReadPerformanceTests(unittest.TestCase):
    def test_summary_reads_skip_canvas_states_and_private_project_settings(self):
        project = project_fixture(guarded=True)
        store = DakiProjectsStore(Path('unused.json'))
        with mock.patch.object(store, '_load', return_value={'projects': [project]}) as load:
            listed = store.list_projects(summary=True)
            fetched = store.get_project(project['id'], summary=True)

        expected_canvas = {
            'id': 'a' * 32,
            'name': 'Front',
            'side': 'front',
            'revision': 3,
            'created_at': '2026-10-01T01:00:00+00:00',
            'updated_at': '2026-10-02T01:00:00+00:00',
            'width': 640,
            'height': 800,
            'layerCount': 3,
        }
        for summary in (listed[0], fetched):
            self.assertEqual(summary['canvases'], {'front': [expected_canvas], 'back': []})
            self.assertNotIn('canvasSettings', summary)
            self.assertNotIn('detailPromptPresets', summary)
            self.assertEqual(summary['extension'], {'nested': [1, {'keep': True}]})
        self.assertEqual(load.call_count, 2)
        listed[0]['extension']['nested'][0] = 9
        self.assertEqual(project['extension']['nested'][0], 1)

    def test_default_project_reads_still_return_independent_full_copies(self):
        project = project_fixture()
        store = DakiProjectsStore(Path('unused.json'))
        with mock.patch.object(store, '_load', return_value={'projects': [project]}):
            listed = store.list_projects()
            fetched = store.get_project(project['id'])

        for result in (listed[0], fetched):
            result['canvases']['front'][0]['state']['layers'][0]['children'][0]['id'] = 'changed'
            result['canvasSettings']['prompts'].append('changed')
        self.assertEqual(project['canvases']['front'][0]['state']['layers'][0]['children'][0]['id'], 'nested')
        self.assertEqual(project['canvasSettings']['prompts'], ['private'])
        self.assertEqual(project['detailPromptPresets'], {'prompts': ['private']})

    def test_project_http_summaries_keep_response_shape_and_load_once(self):
        project = project_fixture(guarded=True)
        app = Flask(__name__)
        app.config['TESTING'] = True
        store = register_daki_routes(app, lambda: Path('unused.json'), lambda path: (path, path))
        client = app.test_client()
        data = {'enabled': True, 'projects': [project]}
        expected = {
            'id': 'project-id',
            'name': 'Read performance',
            'created_at': '2026-10-01T00:00:00+00:00',
            'updated_at': '2026-10-02T00:00:00+00:00',
            'candidates': {'front': [], 'back': []},
            'extension': {'nested': [1, {'keep': True}]},
            'canvases': {
                'front': [{
                    'id': 'a' * 32,
                    'name': 'Front',
                    'side': 'front',
                    'revision': 3,
                    'created_at': '2026-10-01T01:00:00+00:00',
                    'updated_at': '2026-10-02T01:00:00+00:00',
                    'width': 640,
                    'height': 800,
                    'layerCount': 3,
                }],
                'back': [],
            },
        }

        with mock.patch.object(store, '_load', return_value=data) as load:
            listed = client.get('/api/daki/projects')
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(listed.json, {'status': 'success', 'projects': [expected]})
        self.assertEqual(load.call_count, 1)

        with mock.patch.object(store, '_load', return_value=data) as load:
            fetched = client.get('/api/daki/projects/project-id')
        self.assertEqual(fetched.status_code, 200)
        self.assertEqual(fetched.json, {'status': 'success', 'project': expected})
        self.assertEqual(load.call_count, 1)


if __name__ == '__main__':
    unittest.main()
