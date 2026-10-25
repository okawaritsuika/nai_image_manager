import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from flask import Flask
from PIL import Image

from naim.web.daki import register_daki_routes
from tests.test_daki_projects import gallery_resolver


class ProjectCandidateImageDeletionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.gallery = self.root / 'gallery'
        self.gallery.mkdir()
        self.path = self.root / 'daki_projects.json'
        self.aliases = {}
        self.resolver = gallery_resolver(self.gallery, self.aliases)
        self.deletion_notifications = []
        self.extra_references = []
        self.deletion_reference_calls = []
        self.app, self.client, self.store = self.register(self.resolver)

    def register(self, resolver):
        app = Flask(__name__)
        app.config['TESTING'] = True
        store = register_daki_routes(
            app,
            lambda: self.path,
            resolver,
            deletion_references=self._deletion_references,
            image_deleted=self._image_deleted,
        )
        return app, app.test_client(), store

    def _deletion_references(self, paths):
        self.deletion_reference_calls.append(list(paths))
        return list(self.extra_references)

    def _image_deleted(self, source, relative):
        self.deletion_notifications.append((source, relative))

    def image(self, relative, color=(12, 34, 56)):
        path = self.gallery / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new('RGB', (3, 2), color).save(path)
        return path

    def add_candidate(self, relative='sample.png', *, name='Delete source', side='front'):
        self.image(relative)
        project = self.store.create_project(name, relative, side)
        candidate = project['candidates'][side][0]
        return project, candidate

    @staticmethod
    def delete_url(project_id, candidate_id):
        return f'/api/daki/projects/{project_id}/candidates/{candidate_id}/delete'

    def test_explicit_delete_removes_original_bundle_and_only_selected_candidate(self):
        project, target = self.add_candidate()
        kept_path = self.image('keep.png', (90, 80, 70))
        kept_project = self.store.add_candidate(project['id'], 'keep.png', 'back')
        kept = kept_project['candidates']['back'][0]
        target_source = self.gallery / 'sample.png'
        target_json = target_source.with_suffix('.json')
        target_txt = target_source.with_suffix('.txt')
        target_json.write_text('{"prompt":"synthetic"}', encoding='utf-8')
        target_txt.write_text('synthetic prompt', encoding='utf-8')
        kept_bytes = kept_path.read_bytes()
        kept_path.with_suffix('.json').write_text('{"keep":true}', encoding='utf-8')

        stored = json.loads(self.path.read_text(encoding='utf-8'))
        stored['extension'] = {'root': 'preserve'}
        stored_project = stored['projects'][0]
        stored_project['extension'] = {'project': 'preserve'}
        stored_project['candidates']['front'][0]['extension'] = {'deleted': 'with candidate'}
        stored_project['candidates']['back'][0]['extension'] = {'candidate': 'preserve'}
        stored_project['canvases'] = {'front': [], 'back': []}
        stored_project['canvases']['back'].append({
            'id': 'a' * 32,
            'name': 'Kept canvas',
            'side': 'back',
            'revision': 1,
            'created_at': 'created',
            'updated_at': 'updated',
            'state': {'width': 8, 'height': 9, 'layers': [], 'extension': 'preserve'},
            'extension': {'canvas': 'preserve'},
        })
        self.path.write_text(json.dumps(stored), encoding='utf-8')

        response = self.client.post(self.delete_url(project['id'], target['id']), json={})

        self.assertEqual(response.status_code, 200)
        self.assertFalse(target_source.exists())
        self.assertFalse(target_json.exists())
        self.assertFalse(target_txt.exists())
        self.assertEqual(response.json['project']['candidates']['front'], [])
        self.assertEqual(response.json['project']['candidates']['back'][0]['id'], kept['id'])
        self.assertEqual(response.json['project']['extension'], {'project': 'preserve'})
        self.assertEqual(self.deletion_notifications, [(str(target_source), 'sample.png')])

        saved = json.loads(self.path.read_text(encoding='utf-8'))
        self.assertEqual(saved['extension'], {'root': 'preserve'})
        saved_project = saved['projects'][0]
        self.assertEqual(saved_project['extension'], {'project': 'preserve'})
        self.assertEqual(saved_project['candidates']['back'][0]['extension'], {'candidate': 'preserve'})
        self.assertEqual(saved_project['canvases']['back'][0]['extension'], {'canvas': 'preserve'})
        self.assertEqual(kept_path.read_bytes(), kept_bytes)

    def test_existing_candidate_delete_route_remains_link_only(self):
        project, candidate = self.add_candidate()
        source = self.gallery / 'sample.png'
        source_bytes = source.read_bytes()
        metadata = source.with_suffix('.json')
        metadata.write_text('{"keep":true}', encoding='utf-8')
        metadata_bytes = metadata.read_bytes()

        response = self.client.delete(
            f"/api/daki/projects/{project['id']}/candidates/{candidate['id']}"
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json['project']['candidates']['front'], [])
        self.assertEqual(source.read_bytes(), source_bytes)
        self.assertEqual(metadata.read_bytes(), metadata_bytes)
        self.assertEqual(self.deletion_notifications, [])

    def test_shared_daki_and_external_references_require_explicit_confirmation(self):
        project, target = self.add_candidate(name='Target')
        same_project = self.store.add_candidate(project['id'], 'sample.png', 'back')
        other_project = self.store.create_project('Other project', 'sample.png', 'front')
        self.extra_references = [{
            'kind': 'external', 'project_id': 'external-project', 'path': 'sample.png',
        }]
        source = self.gallery / 'sample.png'
        original = source.read_bytes()

        conflict = self.client.post(self.delete_url(project['id'], target['id']), json={})

        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.json['code'], 'daki_references')
        references = conflict.json['references']
        self.assertEqual({(item.get('project_id'), item.get('side')) for item in references}, {
            (project['id'], 'back'), (other_project['id'], 'front'),
            ('external-project', None),
        })
        self.assertTrue(source.exists())
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(len(self.store.get_project(project['id'])['candidates']['front']), 1)
        self.assertEqual(len(same_project['candidates']['back']), 1)
        self.assertEqual(self.deletion_reference_calls, [['sample.png', 'sample.png']])

        confirmed = self.client.post(
            self.delete_url(project['id'], target['id']), json={'confirm_daki': True},
        )

        self.assertEqual(confirmed.status_code, 200)
        self.assertFalse(source.exists())
        self.assertEqual(self.store.get_project(project['id'])['candidates']['front'], [])
        self.assertEqual(len(self.store.get_project(project['id'])['candidates']['back']), 1)
        self.assertEqual(len(self.store.get_project(other_project['id'])['candidates']['front']), 1)

    def test_webp_alias_deletes_resolved_webp_bundle(self):
        project, candidate = self.add_candidate('legacy.png')
        legacy = self.gallery / 'legacy.png'
        legacy.with_suffix('.json').write_text('legacy metadata', encoding='utf-8')
        legacy.unlink()
        converted = self.gallery / 'converted.webp'
        Image.new('RGB', (2, 3), (1, 2, 3)).save(converted, format='WEBP')
        converted_json = converted.with_suffix('.json')
        converted_txt = converted.with_suffix('.txt')
        converted_json.write_text('converted metadata', encoding='utf-8')
        converted_txt.write_text('converted prompt', encoding='utf-8')
        converted_unrelated = self.gallery / 'other.json'
        converted_unrelated.write_text('unrelated', encoding='utf-8')
        self.aliases['legacy.png'] = 'converted.webp'

        response = self.client.post(self.delete_url(project['id'], candidate['id']), json={})

        self.assertEqual(response.status_code, 200)
        self.assertFalse(converted.exists())
        self.assertFalse(converted_json.exists())
        self.assertFalse(converted_txt.exists())
        self.assertTrue(legacy.with_suffix('.json').exists())
        self.assertEqual(converted_unrelated.read_text(encoding='utf-8'), 'unrelated')
        self.assertEqual(self.deletion_notifications, [(str(converted), 'converted.webp')])

    def test_injected_resolver_can_delete_private_project_export_without_gallery_root(self):
        private = self.root / 'private-exports'
        private.mkdir()
        source = private / 'private.png'
        Image.new('RGB', (2, 2), (8, 7, 6)).save(source)
        source.with_suffix('.txt').write_text('private prompt', encoding='utf-8')

        def allowlisted_resolver(relative):
            normalized = relative.replace('\\', '/')
            if normalized.startswith('__daki_exports__/'):
                base = private.resolve()
                target = (base / normalized.removeprefix('__daki_exports__/')).resolve()
            else:
                base = self.gallery.resolve()
                target = (base / normalized).resolve()
            target.relative_to(base)
            if not target.is_file():
                raise FileNotFoundError('missing synthetic image')
            return str(target), normalized

        _, client, store = self.register(allowlisted_resolver)
        project = store.create_project('Private export')
        project = store.add_candidate(project['id'], '__daki_exports__/private.png', 'front')
        candidate = project['candidates']['front'][0]

        response = client.post(self.delete_url(project['id'], candidate['id']), json={})

        self.assertEqual(response.status_code, 200)
        self.assertFalse(source.exists())
        self.assertFalse(source.with_suffix('.txt').exists())
        self.assertEqual(self.deletion_notifications, [(str(source), '__daki_exports__/private.png')])

    def test_missing_source_removes_stale_card_and_unsafe_sources_are_rejected(self):
        project, missing_candidate = self.add_candidate(name='Missing')
        missing_source = self.gallery / 'sample.png'
        missing_source.unlink()

        removed = self.client.post(self.delete_url(project['id'], missing_candidate['id']), json={})

        self.assertEqual(removed.status_code, 200)
        self.assertEqual(removed.json['project']['candidates']['front'], [])
        self.assertEqual(self.deletion_notifications, [(None, 'sample.png')])

        outside = self.root / 'outside.png'
        Image.new('RGB', (1, 1)).save(outside)
        note = self.gallery / 'notes.txt'
        note.write_text('not an image', encoding='utf-8')
        for index, unsafe_path in enumerate(('../outside.png', 'notes.txt')):
            with self.subTest(unsafe_path=unsafe_path):
                current, candidate = self.add_candidate(f'good-{index}.png', name=f'Unsafe {index}')
                saved = json.loads(self.path.read_text(encoding='utf-8'))
                record = next(item for item in saved['projects'] if item['id'] == current['id'])
                record['candidates']['front'][0]['path'] = unsafe_path
                self.path.write_text(json.dumps(saved), encoding='utf-8')

                rejected = self.client.post(self.delete_url(current['id'], candidate['id']), json={})

                self.assertEqual(rejected.status_code, 400)
                self.assertTrue(outside.exists())
                self.assertTrue(note.exists())
                self.assertTrue((self.gallery / f'good-{index}.png').exists())
                self.assertEqual(self.store.get_project(current['id'])['candidates']['front'][0]['path'], unsafe_path)
        self.assertEqual(len(self.deletion_notifications), 1)

    def test_invalid_requests_and_unknown_targets_do_not_mutate_image_or_record(self):
        project, candidate = self.add_candidate()
        source = self.gallery / 'sample.png'
        original_bytes = source.read_bytes()
        original_record = self.path.read_bytes()
        url = self.delete_url(project['id'], candidate['id'])

        malformed = self.client.post(url, data='{', content_type='application/json')
        self.assertEqual(malformed.status_code, 400)
        for invalid in (1, 'true', None):
            with self.subTest(confirm_daki=invalid):
                rejected = self.client.post(url, json={'confirm_daki': invalid})
                self.assertEqual(rejected.status_code, 400)
        self.assertEqual(self.client.post(self.delete_url('missing', candidate['id']), json={}).status_code, 404)
        self.assertEqual(self.client.post(self.delete_url(project['id'], 'missing'), json={}).status_code, 404)
        self.assertEqual(source.read_bytes(), original_bytes)
        self.assertEqual(self.path.read_bytes(), original_record)
        self.assertEqual(self.deletion_notifications, [])

    def test_record_save_failure_restores_image_bundle_and_keeps_record(self):
        project, candidate = self.add_candidate()
        source = self.gallery / 'sample.png'
        bundle = [source, source.with_suffix('.json'), source.with_suffix('.txt')]
        for path in bundle[1:]:
            path.write_text(f'original {path.suffix}', encoding='utf-8')
        original_files = {path: path.read_bytes() for path in bundle}
        original_record = self.path.read_bytes()

        with mock.patch('naim.storage.daki_projects.write_json', side_effect=OSError('private path')):
            response = self.client.post(self.delete_url(project['id'], candidate['id']), json={})

        self.assertEqual(response.status_code, 500)
        self.assertNotIn('private path', response.json['message'])
        self.assertEqual(self.path.read_bytes(), original_record)
        self.assertEqual({path: path.read_bytes() for path in bundle}, original_files)
        self.assertEqual(self.store.get_project(project['id'])['candidates']['front'][0]['id'], candidate['id'])
        self.assertEqual(list(self.gallery.glob('.naim-delete-*')), [])
        self.assertEqual(self.deletion_notifications, [])

    def test_mid_move_failure_restores_already_staged_files(self):
        project, candidate = self.add_candidate()
        source = self.gallery / 'sample.png'
        sidecar = source.with_suffix('.txt')
        sidecar.write_text('original prompt', encoding='utf-8')
        original_files = {path: path.read_bytes() for path in (source, sidecar)}
        original_record = self.path.read_bytes()
        real_replace = os.replace
        failed_once = False

        def fail_on_prompt_sidecar(source_path, target_path):
            nonlocal failed_once
            if Path(source_path) == sidecar and not failed_once:
                failed_once = True
                raise OSError('synthetic staging failure')
            return real_replace(source_path, target_path)

        with mock.patch('naim.storage.image_files.os.replace', side_effect=fail_on_prompt_sidecar):
            response = self.client.post(self.delete_url(project['id'], candidate['id']), json={})

        self.assertEqual(response.status_code, 500)
        self.assertTrue(failed_once)
        self.assertEqual(self.path.read_bytes(), original_record)
        self.assertEqual({path: path.read_bytes() for path in original_files}, original_files)
        self.assertEqual(self.deletion_notifications, [])

    def test_gallery_callback_failure_is_a_successful_delete_with_warning(self):
        project, candidate = self.add_candidate()
        source = self.gallery / 'sample.png'

        with mock.patch.object(self, '_image_deleted', side_effect=RuntimeError('synthetic callback failure')):
            _, client, _ = self.register(self.resolver)
            response = client.post(self.delete_url(project['id'], candidate['id']), json={})

        self.assertEqual(response.status_code, 200)
        self.assertIn('warning', response.json)
        self.assertFalse(source.exists())
        self.assertEqual(self.store.get_project(project['id'])['candidates']['front'], [])


if __name__ == '__main__':
    unittest.main()
