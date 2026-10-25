import json
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from flask import Flask

from naim.storage.daki_projects import DakiProjectsStore
from naim.web.daki import register_daki_routes
from tests.test_daki_projects import gallery_resolver


class ProjectCanvasSettingsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.path = self.root / 'daki_projects.json'
        self.gallery = self.root / 'gallery'
        self.gallery.mkdir()
        self.resolver = gallery_resolver(self.gallery)
        self.store = DakiProjectsStore(lambda: self.path, self.resolver)
        self.app = Flask(__name__)
        self.app.config['TESTING'] = True
        register_daki_routes(self.app, lambda: self.path, self.resolver)
        self.client = self.app.test_client()
        self.project = self.store.create_project('Settings project')

    @staticmethod
    def settings():
        return {
            'style': {
                'id': 'personal-style-1',
                'name': '  Example style  ',
                'library': 'personal',
                'positive': '  soft lines, (weighted detail:1.3)  ',
                'negative': '  blurry, bad anatomy  ',
            },
            'prompts': {
                'front': {
                    'basePrompt': '  (front detail:1.2), literal prompt  ',
                    'negativePrompt': '  front negative  ',
                },
                'back': {
                    'basePrompt': '  back prompt, (weighted:0.8)  ',
                    'negativePrompt': '  back negative  ',
                },
            },
            'inpaintSettings': {
                'model': 'nai-diffusion-4-5-full-inpainting',
                'sampler': 'k_dpmpp_2m',
                'steps': 28,
                'cfg': 6.4,
                'cfg_rescale': 0,
                'noise_schedule': 'karras',
                'seed': 0,
                'strength': 0.25,
                'noise': 0,
            },
        }

    def settings_url(self, project_id=None):
        return f"/api/daki/projects/{project_id or self.project['id']}/canvas-settings"

    def image_style(self):
        return {
            'id': 'c' * 32, 'library': 'project', 'name': 'Synthetic project image',
            'sourceProjectId': self.project['id'],
            'positive': '1.2::ink::', 'negative': 'blur',
            'selection': {
                'base': [{'token': '1.2::ink::', 'occurrence': 1}],
                'negative': [{'token': 'blur', 'occurrence': 0}],
            },
        }

    @staticmethod
    def reference():
        return {
            'src': '/canvas-imports/canvas/reference.png',
            'name': 'Synthetic reference',
            'width': 384,
            'x': 0.25,
            'y': 0.7,
            'zoom': 1.5,
        }

    def test_image_style_and_side_characters_round_trip_without_prompt_rewriting(self):
        settings = self.settings()
        settings['style'] = self.image_style()
        settings['prompts']['front']['charPrompts'] = ['  front character, 1.2::detail::  ', '', 'third']
        settings['prompts']['back']['charPrompts'] = ['back character', 'other character']
        response = self.client.put(self.settings_url(), json={'revision': 0, 'settings': settings})
        self.assertEqual(response.status_code, 200)
        saved = response.json['settings']
        self.assertEqual(saved['style'], settings['style'])
        self.assertEqual(saved['prompts'], settings['prompts'])
        self.assertEqual(self.client.get(self.settings_url()).json['settings'], saved)
        self.assertEqual(self.store.get_project(self.project['id'])['candidates'], {'front': [], 'back': []})
        # A saved selection is a detached recipe and survives source-image removal.
        self.assertEqual(self.store.get_canvas_settings(self.project['id'])['style'], settings['style'])

    def test_negative_only_image_style_and_empty_character_lists_are_valid(self):
        settings = self.settings()
        settings['style'] = self.image_style()
        settings['style']['positive'] = ''
        settings['style']['selection']['base'] = []
        settings['prompts']['front']['charPrompts'] = []
        settings['prompts']['back']['charPrompts'] = [''] * 22
        response = self.client.put(self.settings_url(), json={'revision': 0, 'settings': settings})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json['settings']['style'], settings['style'])
        self.assertEqual(response.json['settings']['prompts'], settings['prompts'])

    def test_invalid_image_selections_do_not_modify_stored_settings(self):
        before = self.path.read_bytes()
        mutations = (
            lambda style: style.pop('selection'),
            lambda style: style.update(sourceProjectId='invalid'),
            lambda style: style['selection'].update(base=[]),
            lambda style: style['selection']['base'][0].update(occurrence=True),
            lambda style: style['selection']['base'][0].update(occurrence=-1),
            lambda style: style['selection']['base'][0].update(occurrence=9_007_199_254_740_992),
            lambda style: style['selection']['base'][0].update(token='different tag'),
            lambda style: style.update(positive='', negative='', selection={'base': [], 'negative': []}),
            lambda style: style['selection'].update(negative=None),
        )
        for mutate in mutations:
            settings = self.settings()
            settings['style'] = self.image_style()
            mutate(settings['style'])
            with self.subTest(style=settings['style']):
                response = self.client.put(self.settings_url(), json={'revision': 0, 'settings': settings})
                self.assertEqual(response.status_code, 400)
                self.assertEqual(self.path.read_bytes(), before)

    def test_invalid_character_lists_do_not_modify_stored_settings(self):
        before = self.path.read_bytes()
        for characters in (None, 'single string', {}, [True], [None], ['x'] * 23, ['x' * 100001]):
            settings = self.settings()
            settings['prompts']['front']['charPrompts'] = characters
            with self.subTest(type=type(characters).__name__):
                response = self.client.put(self.settings_url(), json={'revision': 0, 'settings': settings})
                self.assertEqual(response.status_code, 400)
                self.assertEqual(self.path.read_bytes(), before)

    def test_legacy_get_returns_defaults_without_writing(self):
        original = self.path.read_bytes()

        response = self.client.get(self.settings_url())

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, {
            'status': 'success',
            'settings': {
                'revision': 0, 'style': None,
                'prompts': {
                    'front': {'basePrompt': '', 'negativePrompt': ''},
                    'back': {'basePrompt': '', 'negativePrompt': ''},
                },
                'inpaintSettings': None,
            },
        })
        self.assertEqual(self.path.read_bytes(), original)
        self.assertNotIn('canvasSettings', json.loads(original)['projects'][0])

    def test_settings_round_trip_preserves_prompt_text_and_zero_values(self):
        response = self.client.put(self.settings_url(), json={
            'revision': 0, 'settings': self.settings(),
        })

        self.assertEqual(response.status_code, 200)
        saved = response.json['settings']
        self.assertEqual(saved['revision'], 1)
        self.assertEqual(saved['style'], self.settings()['style'])
        self.assertEqual(saved['prompts'], self.settings()['prompts'])
        self.assertEqual(saved['inpaintSettings'], {
            **self.settings()['inpaintSettings'],
            'model': 'nai-diffusion-4-5-full',
            'cfg_rescale': 0.0,
            'noise': 0.0,
        })
        self.assertEqual(self.client.get(self.settings_url()).json['settings'], saved)

        stored = json.loads(self.path.read_text(encoding='utf-8'))['projects'][0]
        self.assertEqual(stored['canvasSettings'], saved)
        self.assertEqual(self.store.get_canvas_settings(self.project['id']), saved)

    def test_optional_reference_round_trips_without_requiring_an_existing_asset(self):
        settings = self.settings()
        reference = self.reference()
        settings['inpaintReference'] = reference

        response = self.client.put(self.settings_url(), json={
            'revision': 0, 'settings': settings,
        })

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json['settings']['inpaintReference'], reference)
        self.assertEqual(
            self.client.get(self.settings_url()).json['settings']['inpaintReference'],
            reference,
        )
        stored = json.loads(self.path.read_text(encoding='utf-8'))['projects'][0]
        self.assertEqual(stored['canvasSettings']['inpaintReference'], reference)

    def test_reference_is_detached_between_projects_and_return_values(self):
        settings = self.settings()
        settings['inpaintReference'] = self.reference()
        first = self.client.put(self.settings_url(), json={
            'revision': 0, 'settings': settings,
        })
        self.assertEqual(first.status_code, 200)

        # Neither the caller's object nor the response object owns stored state.
        settings['inpaintReference']['x'] = 0.9
        first.json['settings']['inpaintReference']['y'] = 0.1
        self.assertEqual(
            self.store.get_canvas_settings(self.project['id'])['inpaintReference'],
            self.reference(),
        )

        other = self.store.create_project('Independent reference project')
        other_settings = self.settings()
        other_settings['inpaintReference'] = self.reference()
        other_settings['inpaintReference']['width'] = 448
        saved_other = self.store.update_canvas_settings(other['id'], other_settings, 0)
        self.assertEqual(saved_other['inpaintReference']['width'], 448)
        self.assertEqual(
            self.store.get_canvas_settings(self.project['id'])['inpaintReference'],
            self.reference(),
        )

    def test_legacy_update_omitting_reference_preserves_saved_image_and_crop(self):
        with_reference = self.settings()
        with_reference['inpaintReference'] = self.reference()
        saved = self.store.update_canvas_settings(self.project['id'], with_reference, 0)

        legacy_payload = self.settings()
        legacy_payload['prompts']['front']['basePrompt'] = 'legacy caller update'
        updated = self.store.update_canvas_settings(
            self.project['id'], legacy_payload, saved['revision'],
        )

        self.assertEqual(updated['revision'], 2)
        self.assertEqual(updated['prompts']['front']['basePrompt'], 'legacy caller update')
        self.assertEqual(updated['inpaintReference'], self.reference())

    def test_reference_idempotent_retry_stale_conflict_and_explicit_clear(self):
        settings = self.settings()
        settings['inpaintReference'] = self.reference()
        first = self.client.put(self.settings_url(), json={
            'revision': 0, 'settings': settings,
        })
        self.assertEqual(first.status_code, 200)
        committed = self.path.read_bytes()

        retry = self.client.put(self.settings_url(), json={
            'revision': 0, 'settings': settings,
        })
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(retry.json['settings']['revision'], 1)
        self.assertEqual(self.path.read_bytes(), committed)

        stale = deepcopy(settings)
        stale['prompts']['front']['basePrompt'] = 'stale edit'
        conflict = self.client.put(self.settings_url(), json={
            'revision': 0, 'settings': stale,
        })
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(self.path.read_bytes(), committed)

        cleared = deepcopy(settings)
        cleared['inpaintReference'] = None
        response = self.client.put(self.settings_url(), json={
            'revision': 1, 'settings': cleared,
        })
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json['settings']['inpaintReference'])
        self.assertIsNone(
            self.client.get(self.settings_url()).json['settings']['inpaintReference'],
        )

    def test_invalid_reference_does_not_modify_stored_settings(self):
        before = self.path.read_bytes()
        for mutate in (
            lambda reference: reference.update(src='/image/not-a-canvas-import.png'),
            lambda reference: reference.update(width=65),
            lambda reference: reference.update(width=True),
            lambda reference: reference.update(x=1.01),
            lambda reference: reference.update(zoom=0),
        ):
            settings = self.settings()
            settings['inpaintReference'] = self.reference()
            mutate(settings['inpaintReference'])
            with self.subTest(reference=settings['inpaintReference']):
                response = self.client.put(self.settings_url(), json={
                    'revision': 0, 'settings': settings,
                })
                self.assertEqual(response.status_code, 400)
                self.assertEqual(self.path.read_bytes(), before)

    def test_medium_constraints_and_generation_zero_values_are_normalized_for_ui(self):
        settings = self.settings()
        settings['inpaintSettings'] = {
            'model': 'nai-diffusion-5-full-medium-inpainting',
            'sampler': 'k_dpmpp_2m', 'steps': 41, 'cfg': 7.5,
            'cfg_rescale': 0.8, 'noise_schedule': 'native',
            'seed': 0, 'strength': 0.4, 'noise': 0,
        }

        response = self.client.put(self.settings_url(), json={
            'revision': 0, 'settings': settings,
        })

        self.assertEqual(response.status_code, 200)
        normalized = response.json['settings']['inpaintSettings']
        self.assertEqual(normalized, {
            'model': 'nai-diffusion-5-full-medium',
            'sampler': 'k_euler_ancestral', 'steps': 14, 'cfg': 7.5,
            'cfg_rescale': 0, 'noise_schedule': 'karras',
            'seed': 0, 'strength': 0.4, 'noise': 0,
        })

    def test_revision_cas_idempotent_retry_and_unchanged_update_do_not_rewrite(self):
        unchanged_bytes = self.path.read_bytes()
        same_settings = {
            'style': None,
            'prompts': {
                'front': {'basePrompt': '', 'negativePrompt': ''},
                'back': {'basePrompt': '', 'negativePrompt': ''},
            },
            'inpaintSettings': None,
        }
        no_op = self.client.put(self.settings_url(), json={
            'revision': 0, 'settings': same_settings,
        })
        self.assertEqual(no_op.status_code, 200)
        self.assertEqual(no_op.json['settings']['revision'], 0)
        self.assertEqual(self.path.read_bytes(), unchanged_bytes)

        updated_settings = self.settings()
        first = self.client.put(self.settings_url(), json={
            'revision': 0, 'settings': updated_settings,
        })
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json['settings']['revision'], 1)
        committed_bytes = self.path.read_bytes()

        retry = self.client.put(self.settings_url(), json={
            'revision': 0, 'settings': updated_settings,
        })
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(retry.json['settings']['revision'], 1)
        self.assertEqual(self.path.read_bytes(), committed_bytes)

        stale_settings = self.settings()
        stale_settings['prompts']['front']['basePrompt'] = 'different stale prompt'
        stale = self.client.put(self.settings_url(), json={
            'revision': 0, 'settings': stale_settings,
        })
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json['code'], 'project_settings_conflict')
        self.assertIn('최신 설정', stale.json['message'])
        self.assertEqual(self.path.read_bytes(), committed_bytes)

        current_no_op = self.client.put(self.settings_url(), json={
            'revision': 1, 'settings': updated_settings,
        })
        self.assertEqual(current_no_op.status_code, 200)
        self.assertEqual(current_no_op.json['settings']['revision'], 1)
        self.assertEqual(self.path.read_bytes(), committed_bytes)

    def test_settings_update_preserves_extensions_canvas_state_and_summary_privacy(self):
        canvas = self.store.create_canvas(self.project['id'], {
            'id': 'c' * 32, 'name': 'Front', 'side': 'front',
            'state': {
                'width': 2, 'height': 3,
                'layers': [{'id': 'layer', 'promptInfo': {'prompt': 'synthetic saved state'}}],
                'extension': {'keep': True},
            },
        })
        data = json.loads(self.path.read_text(encoding='utf-8'))
        data['extension'] = {'root': 'keep'}
        data['projects'][0]['extension'] = {'project': 'keep'}
        data['projects'][0]['updated_at'] = 'before settings update'
        data['projects'][0]['canvases']['front'][0]['extension'] = {'canvas': 'keep'}
        self.path.write_text(json.dumps(data), encoding='utf-8')
        original_state = canvas['state']

        updated = self.client.put(self.settings_url(), json={
            'revision': 0, 'settings': self.settings(),
        })
        self.assertEqual(updated.status_code, 200)
        saved = json.loads(self.path.read_text(encoding='utf-8'))
        project = saved['projects'][0]
        self.assertEqual(saved['extension'], {'root': 'keep'})
        self.assertEqual(project['extension'], {'project': 'keep'})
        self.assertNotEqual(project['updated_at'], 'before settings update')
        self.assertEqual(project['canvases']['front'][0]['extension'], {'canvas': 'keep'})
        self.assertEqual(project['canvases']['front'][0]['state'], original_state)

        for response in (
            self.client.get('/api/daki/projects'),
            self.client.get(f"/api/daki/projects/{self.project['id']}"),
        ):
            self.assertEqual(response.status_code, 200)
            if 'projects' in response.json:
                public_projects = response.json['projects']
            else:
                public_projects = [response.json['project']]
            self.assertNotIn('canvasSettings', public_projects[0])
            self.assertNotIn('synthetic saved state', json.dumps(public_projects))

    def test_invalid_payloads_revisions_and_settings_types_are_rejected(self):
        valid = self.settings()
        for revision in (True, '0', -1, 0.5, None):
            with self.subTest(revision=revision):
                response = self.client.put(self.settings_url(), json={
                    'revision': revision, 'settings': valid,
                })
                self.assertEqual(response.status_code, 400)

        invalid_settings = []
        missing_top_level = self.settings()
        missing_top_level.pop('style')
        invalid_settings.append(missing_top_level)
        unknown_side = self.settings()
        unknown_side['prompts']['left'] = {'basePrompt': '', 'negativePrompt': ''}
        invalid_settings.append(unknown_side)
        invalid_style = self.settings()
        invalid_style['style']['library'] = 'unknown'
        invalid_settings.append(invalid_style)
        invalid_inpaint = self.settings()
        invalid_inpaint['inpaintSettings']['seed'] = True
        invalid_settings.append(invalid_inpaint)
        missing_generation_key = self.settings()
        del missing_generation_key['inpaintSettings']['noise']
        invalid_settings.append(missing_generation_key)
        for settings in invalid_settings:
            with self.subTest(settings=settings):
                response = self.client.put(self.settings_url(), json={
                    'revision': 0, 'settings': settings,
                })
                self.assertEqual(response.status_code, 400)

        missing_body_field = self.client.put(self.settings_url(), json={'revision': 0})
        self.assertEqual(missing_body_field.status_code, 400)
        self.assertEqual(self.store.get_canvas_settings(self.project['id'])['revision'], 0)

    def test_missing_project_and_storage_failure_do_not_report_success(self):
        self.assertEqual(self.client.get(self.settings_url('missing')).status_code, 404)
        self.assertEqual(self.client.put(self.settings_url('missing'), json={
            'revision': 0, 'settings': self.settings(),
        }).status_code, 404)

        original = self.path.read_bytes()
        with mock.patch('naim.storage.daki_projects.write_json', side_effect=OSError('private path')):
            response = self.client.put(self.settings_url(), json={
                'revision': 0, 'settings': self.settings(),
            })
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json['status'], 'error')
        self.assertNotIn('private path', response.json['message'])
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(self.store.get_canvas_settings(self.project['id'])['revision'], 0)


if __name__ == '__main__':
    unittest.main()
