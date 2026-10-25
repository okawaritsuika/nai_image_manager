import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from flask import Flask

from naim.detail_prompt_presets import DEFAULT_DETAIL_PRESETS
from naim.storage.daki_projects import DakiProjectsStore
from naim.web.canvas_detail_presets import register_canvas_detail_preset_routes


class CanvasDetailPresetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.path = self.root / 'daki_projects.json'
        self.store = DakiProjectsStore(lambda: self.path)
        self.app = Flask(__name__)
        self.app.config['TESTING'] = True
        register_canvas_detail_preset_routes(self.app, self.store)
        self.client = self.app.test_client()

    @staticmethod
    def preset(preset_id='custom-detail', **overrides):
        value = {
            'id': preset_id,
            'name': '  사용자 상세  ',
            'category': '  얼굴  ',
            'base': '  fine detail:1.2,  soft shading  ',
            'negative': '  blurred detail  ',
        }
        value.update(overrides)
        return value

    def post(self, scope='common', project_id=None, revision=0, preset=None):
        return self.client.post('/api/canvas/detail-presets', json={
            'scope': scope,
            'projectId': project_id,
            'revision': revision,
            'preset': self.preset() if preset is None else preset,
        })

    def test_initial_get_uses_builtins_without_writing_file(self):
        response = self.client.get('/api/canvas/detail-presets')
        self.assertEqual(response.status_code, 200)
        self.assertFalse(self.path.exists())
        self.assertEqual(response.json['status'], 'success')
        self.assertEqual(response.json['project'], None)
        self.assertIsNone(response.json['projectId'])
        self.assertEqual(response.json['common'], {
            'revision': 0, 'items': list(DEFAULT_DETAIL_PRESETS),
        })
        self.assertGreaterEqual(len(response.json['common']['items']), 35)
        self.assertLessEqual(len(response.json['common']['items']), 40)

        project = self.store.create_project('Project A')
        scoped = self.client.get(
            f"/api/canvas/detail-presets?project_id={project['id']}"
        )
        self.assertEqual(scoped.status_code, 200)
        self.assertEqual(scoped.json['project'], {'revision': 0, 'items': []})

    def test_common_create_update_delete_persists_and_keeps_prompt_text(self):
        created = self.post(preset=self.preset('stable_custom-1'))
        self.assertEqual(created.status_code, 201, created.json)
        self.assertEqual(created.json['common']['revision'], 1)
        saved = next(item for item in created.json['common']['items']
                     if item['id'] == 'stable_custom-1')
        self.assertEqual(saved, {
            'id': 'stable_custom-1', 'name': '사용자 상세', 'category': '얼굴',
            'base': '  fine detail:1.2,  soft shading  ',
            'negative': '  blurred detail  ',
        })

        updated = self.client.put('/api/canvas/detail-presets', json={
            'scope': 'common', 'projectId': None, 'revision': 1,
            'preset': {'id': 'stable_custom-1', 'base': 'new  weighted:1.4'},
        })
        self.assertEqual(updated.status_code, 200, updated.json)
        self.assertEqual(updated.json['common']['revision'], 2)
        reopened = DakiProjectsStore(self.path).get_detail_prompt_presets()
        saved_again = next(item for item in reopened['common']['items']
                           if item['id'] == 'stable_custom-1')
        self.assertEqual(saved_again['name'], '사용자 상세')
        self.assertEqual(saved_again['base'], 'new  weighted:1.4')
        self.assertEqual(saved_again['negative'], '  blurred detail  ')

        deleted = self.client.delete('/api/canvas/detail-presets', json={
            'scope': 'common', 'projectId': None, 'revision': 2,
            'id': 'stable_custom-1',
        })
        self.assertEqual(deleted.status_code, 200, deleted.json)
        self.assertEqual(deleted.json['common']['revision'], 3)
        self.assertNotIn('stable_custom-1', {
            item['id'] for item in deleted.json['common']['items']
        })

    def test_builtin_edit_and_delete_materialize_common_defaults(self):
        builtin_id = 'detail-overall-clarity'
        changed = self.client.put('/api/canvas/detail-presets', json={
            'scope': 'common', 'projectId': None, 'revision': 0,
            'preset': {'id': builtin_id, 'name': '  선명한 윤곽  '},
        })
        self.assertEqual(changed.status_code, 200, changed.json)
        self.assertEqual(changed.json['common']['revision'], 1)
        self.assertEqual(next(item for item in changed.json['common']['items']
                              if item['id'] == builtin_id)['name'], '선명한 윤곽')
        self.assertTrue(self.path.exists())
        reopened = DakiProjectsStore(self.path).get_detail_prompt_presets()
        self.assertEqual(next(item for item in reopened['common']['items']
                              if item['id'] == builtin_id)['name'], '선명한 윤곽')

        removed = self.client.delete('/api/canvas/detail-presets', json={
            'scope': 'common', 'projectId': None, 'revision': 1, 'id': builtin_id,
        })
        self.assertEqual(removed.status_code, 200, removed.json)
        self.assertNotIn(builtin_id, {item['id'] for item in removed.json['common']['items']})
        self.assertEqual(removed.json['common']['revision'], 2)

    def test_project_presets_are_isolated_and_common_presets_are_shared(self):
        first = self.store.create_project('Project A')
        second = self.store.create_project('Project B')
        response = self.post('project', first['id'], 0, self.preset('project-a-only'))
        self.assertEqual(response.status_code, 201, response.json)
        self.assertEqual(response.json['projectId'], first['id'])
        self.assertEqual([item['id'] for item in response.json['project']['items']], ['project-a-only'])

        first_read = self.client.get(f"/api/canvas/detail-presets?project_id={first['id']}")
        second_read = self.client.get(f"/api/canvas/detail-presets?project_id={second['id']}")
        self.assertEqual([item['id'] for item in first_read.json['project']['items']], ['project-a-only'])
        self.assertEqual(second_read.json['project'], {'revision': 0, 'items': []})
        self.assertEqual(first_read.json['common']['items'], second_read.json['common']['items'])

        common = self.post('common', first['id'], 0, self.preset('common-visible'))
        self.assertEqual(common.status_code, 201, common.json)
        self.assertEqual(common.json['projectId'], first['id'])
        self.assertEqual(common.json['project']['items'], first_read.json['project']['items'])
        second_read = self.client.get(f"/api/canvas/detail-presets?project_id={second['id']}")
        self.assertIn('common-visible', {item['id'] for item in second_read.json['common']['items']})
        self.assertEqual(second_read.json['project']['items'], [])

    def test_conflict_retry_unknown_fields_and_noop_revision(self):
        created = self.post(preset=self.preset('retry-key'))
        self.assertEqual(created.status_code, 201)
        saved_bytes = self.path.read_bytes()
        retry = self.post(revision=0, preset=self.preset('retry-key'))
        self.assertEqual(retry.status_code, 201)
        self.assertEqual(retry.json['common']['revision'], 1)
        self.assertEqual(self.path.read_bytes(), saved_bytes)
        conflict = self.post(revision=0, preset=self.preset('retry-key', base='different'))
        self.assertEqual(conflict.status_code, 409)
        stale = self.post(revision=0, preset=self.preset('another-key'))
        self.assertEqual(stale.status_code, 409)

        project = self.store.create_project('Unknown fields')
        data = json.loads(self.path.read_text(encoding='utf-8'))
        data['rootExtension'] = {'keep': [1]}
        data['detailPromptPresets']['extension'] = 'common collection'
        target = next(item for item in data['detailPromptPresets']['items']
                      if item['id'] == 'retry-key')
        target['extension'] = {'keep': True}
        saved_project = next(item for item in data['projects'] if item['id'] == project['id'])
        saved_project['projectExtension'] = 'project'
        saved_project['detailPromptPresets'] = {
            'revision': 0,
            'items': [self.preset('project-extra', name='프로젝트', category='피부', base='texture', negative='noise')],
            'extension': 'project collection',
        }
        self.path.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')

        no_op = self.client.put('/api/canvas/detail-presets', json={
            'scope': 'common', 'projectId': None, 'revision': 1,
            'preset': {'id': 'retry-key', 'name': '사용자 상세', 'category': '얼굴',
                       'base': '  fine detail:1.2,  soft shading  ',
                       'negative': '  blurred detail  '},
        })
        self.assertEqual(no_op.status_code, 200, no_op.json)
        self.assertEqual(no_op.json['common']['revision'], 1)
        update = self.client.put('/api/canvas/detail-presets', json={
            'scope': 'common', 'projectId': project['id'], 'revision': 1,
            'preset': {'id': 'retry-key', 'name': 'Updated'},
        })
        self.assertEqual(update.status_code, 200, update.json)
        self.assertEqual(update.json['project']['revision'], 0)

        saved = json.loads(self.path.read_text(encoding='utf-8'))
        self.assertEqual(saved['rootExtension'], {'keep': [1]})
        self.assertEqual(saved['detailPromptPresets']['extension'], 'common collection')
        common_item = next(item for item in saved['detailPromptPresets']['items']
                           if item['id'] == 'retry-key')
        self.assertEqual(common_item['extension'], {'keep': True})
        self.assertEqual(common_item['name'], 'Updated')
        saved_project = next(item for item in saved['projects'] if item['id'] == project['id'])
        self.assertEqual(saved_project['projectExtension'], 'project')
        self.assertEqual(saved_project['detailPromptPresets']['extension'], 'project collection')
        self.assertEqual(saved_project['detailPromptPresets']['items'][0]['id'], 'project-extra')

    def test_stale_put_delete_and_missing_project_common_mutation_do_not_write(self):
        created = self.post(preset=self.preset('stale-edit'))
        self.assertEqual(created.status_code, 201, created.json)
        original = self.path.read_bytes()

        stale_put = self.client.put('/api/canvas/detail-presets', json={
            'scope': 'common', 'projectId': None, 'revision': 0,
            'preset': {'id': 'stale-edit', 'name': 'Changed'},
        })
        self.assertEqual(stale_put.status_code, 409, stale_put.json)
        self.assertEqual(self.path.read_bytes(), original)

        stale_delete = self.client.delete('/api/canvas/detail-presets', json={
            'scope': 'common', 'projectId': None, 'revision': 0, 'id': 'stale-edit',
        })
        self.assertEqual(stale_delete.status_code, 409, stale_delete.json)
        self.assertEqual(self.path.read_bytes(), original)

        missing_project = self.post('common', 'not-a-project', 1, self.preset('missing-project'))
        self.assertEqual(missing_project.status_code, 404, missing_project.json)
        self.assertEqual(self.path.read_bytes(), original)

    def test_invalid_values_limits_missing_ids_and_malformed_stored_data(self):
        for bad in (
            self.preset('', name='Name'),
            self.preset('bad id', name='Name'),
            self.preset('bad', name=' '),
            self.preset('bad', name='x' * 81),
            self.preset('bad', category='x' * 41),
            self.preset('bad', base=4),
            self.preset('bad', base='', negative=''),
            self.preset('bad', base=' ', negative='  '),
            self.preset('bad', base='x' * 10001),
            [],
        ):
            response = self.post(preset=bad)
            self.assertEqual(response.status_code, 400, response.json)
        for invalid_revision in (True, -1, 1.5, '0', None):
            response = self.post(revision=invalid_revision, preset=self.preset('revision-bad'))
            self.assertEqual(response.status_code, 400, response.json)

        missing_project = self.post('project', 'not-a-project', 0, self.preset('missing-project'))
        self.assertEqual(missing_project.status_code, 404, missing_project.json)
        missing_id = self.client.delete('/api/canvas/detail-presets', json={
            'scope': 'common', 'projectId': None, 'revision': 0, 'id': 'not-found',
        })
        self.assertEqual(missing_id.status_code, 404, missing_id.json)
        malformed_json = self.client.post(
            '/api/canvas/detail-presets', data='{', content_type='application/json',
        )
        self.assertEqual(malformed_json.status_code, 400)

        data = {'enabled': True, 'projects': [], 'detailPromptPresets': {'revision': 0, 'items': [{'id': 'bad'}]}}
        self.path.write_text(json.dumps(data), encoding='utf-8')
        original = self.path.read_bytes()
        malformed = self.client.get('/api/canvas/detail-presets')
        self.assertEqual(malformed.status_code, 500)
        self.assertNotIn(str(self.path), malformed.json['message'])
        self.assertEqual(self.path.read_bytes(), original)

        # A collection at its cap rejects one more item without changing revision or bytes.
        items = [self.preset(f'cap-{index}', name='Cap', category='전체', base='detail', negative='')
                 for index in range(500)]
        self.path.write_text(json.dumps({
            'enabled': True, 'projects': [],
            'detailPromptPresets': {'revision': 0, 'items': items},
        }), encoding='utf-8')
        original = self.path.read_bytes()
        capped = self.post(revision=0, preset=self.preset('cap-overflow'))
        self.assertEqual(capped.status_code, 400, capped.json)
        self.assertEqual(self.path.read_bytes(), original)

    def test_failed_atomic_save_returns_generic_error_and_keeps_original(self):
        self.store.create_project('Save failure')
        original = self.path.read_bytes()
        with mock.patch('naim.storage.json_files.os.replace', side_effect=OSError('private path')):
            response = self.post(preset=self.preset('failed-save'))
        self.assertEqual(response.status_code, 500, response.json)
        self.assertNotIn('private path', response.json['message'])
        self.assertNotIn(str(self.path), response.json['message'])
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(list(self.root.glob('*.tmp')), [])

        with mock.patch(
                'naim.storage.daki_projects.write_json',
                side_effect=FileNotFoundError('private path')):
            missing_file = self.post(preset=self.preset('missing-file-save'))
        self.assertEqual(missing_file.status_code, 500, missing_file.json)
        self.assertNotIn('private path', missing_file.json['message'])
        self.assertNotIn(str(self.path), missing_file.json['message'])
        self.assertEqual(self.path.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
