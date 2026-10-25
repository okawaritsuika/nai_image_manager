"""Regression coverage for Daki-linked canvas import asset cleanup.

Run only through tools/run_isolated_tests.py so importing app never touches the
active installation or real user data.
"""
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from urllib.parse import quote

from PIL import Image

import app


class CanvasProjectAssetCleanupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.asset_root = self.root / 'assets'
        self.asset_root.mkdir()

        self.canvas_dir_patch = mock.patch.object(app, 'CANVAS_IMPORT_DIR', str(self.asset_root))
        self.projects_file_patch = mock.patch.object(
            app, 'DAKI_PROJECTS_FILE', str(self.root / 'daki_projects.json'),
        )
        self.canvas_dir_patch.start()
        self.projects_file_patch.start()
        self.addCleanup(self.projects_file_patch.stop)
        self.addCleanup(self.canvas_dir_patch.stop)

        app.app.testing = True
        self.client = app.app.test_client()

    def make_png(self, relative):
        path = self.asset_root.joinpath(*relative.split('/'))
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new('RGBA', (3, 2), (20, 90, 130, 255)).save(path)
        return path

    @staticmethod
    def public_src(relative):
        return '/canvas-imports/' + quote(relative, safe='/')

    def create_project_with_linked_assets(self):
        relatives = {
            'front': 'canvas/session-a/front image.png',
            'mask': 'canvas_inpaint/session-b/mask%shape.png',
            'back': 'canvas/session-c/back image.png',
        }
        files = {key: self.make_png(path) for key, path in relatives.items()}
        original_bytes = {key: path.read_bytes() for key, path in files.items()}
        urls = {key: self.public_src(path) for key, path in relatives.items()}

        front_state = {
            'width': 64,
            'height': 48,
            'layers': [{
                'id': 'front-layer',
                'children': [{
                    'src': urls['front'],
                    'metadata': {'nested': [{'maskSrc': urls['mask']}]},
                }],
            }],
            'unknown': {'deep': {'items': [1, {'preserve': True}]}},
        }
        back_state = {
            'width': 80,
            'height': 60,
            'layers': [{'children': [{'payload': {'src': urls['back']}}]}],
        }
        project = app.DAKI_PROJECTS.create_project('Synthetic workspace', canvas={
            'id': 'a' * 32,
            'name': 'Front workspace',
            'side': 'front',
            'state': front_state,
        })
        back_canvas = app.DAKI_PROJECTS.create_canvas(project['id'], {
            'id': 'b' * 32,
            'name': 'Back workspace',
            'side': 'back',
            'state': back_state,
        })
        app.DAKI_PROJECTS.set_enabled(False)
        return {
            'project': project,
            'front_state': front_state,
            'front_canvas_id': 'a' * 32,
            'back_state': back_state,
            'back_canvas_id': back_canvas['id'],
            'relatives': relatives,
            'files': files,
            'bytes': original_bytes,
        }

    def assert_linked_files_unchanged(self, fixture):
        for key, path in fixture['files'].items():
            self.assertTrue(path.is_file(), key)
            self.assertEqual(path.read_bytes(), fixture['bytes'][key], key)
        project_id = fixture['project']['id']
        front = app.DAKI_PROJECTS.get_canvas(project_id, fixture['front_canvas_id'])
        back = app.DAKI_PROJECTS.get_canvas(project_id, fixture['back_canvas_id'])
        self.assertEqual(front['state'], fixture['front_state'])
        self.assertEqual(back['state'], fixture['back_state'])

    def assert_project_refs(self, fixture):
        self.assertEqual(
            app.project_canvas_import_refs(),
            set(fixture['relatives'].values()),
        )
        self.assertFalse(app.DAKI_PROJECTS.settings()['enabled'])

    def test_references_cover_deep_nested_src_and_mask_on_both_sides_when_disabled(self):
        fixture = self.create_project_with_linked_assets()

        self.assert_project_refs(fixture)
        self.assert_linked_files_unchanged(fixture)

    def test_reference_and_global_cleanups_preserve_links_and_remove_orphans(self):
        fixture = self.create_project_with_linked_assets()
        refs = list(fixture['relatives'].values())

        direct_orphan = 'canvas/session-a/orphan-refs.png'
        direct_orphan_path = self.make_png(direct_orphan)
        deleted = app.cleanup_canvas_import_refs(
            [*refs, direct_orphan], retained_refs=[],
        )
        self.assertEqual(deleted, 1)
        self.assertFalse(direct_orphan_path.exists())
        self.assert_project_refs(fixture)
        self.assert_linked_files_unchanged(fixture)

        global_orphan = 'canvas_inpaint/session-b/orphan-global.png'
        global_orphan_path = self.make_png(global_orphan)
        deleted = app.cleanup_unreferenced_canvas_imports([], active_session_ids=[])
        self.assertEqual(deleted, 1)
        self.assertFalse(global_orphan_path.exists())
        self.assert_project_refs(fixture)
        self.assert_linked_files_unchanged(fixture)

    def test_session_cleanup_preserves_linked_assets_in_other_sessions_and_sides(self):
        fixture = self.create_project_with_linked_assets()
        front_orphan = self.make_png('canvas/session-a/orphan-front.png')
        mask_orphan = self.make_png('canvas_inpaint/session-b/orphan-mask.png')
        other_session_orphan = self.make_png('canvas/session-c/orphan-back.png')

        self.assertEqual(app.cleanup_canvas_import_session('canvas', 'session-a'), 1)
        self.assertFalse(front_orphan.exists())
        self.assertTrue(mask_orphan.exists())
        self.assertTrue(other_session_orphan.exists())
        self.assert_project_refs(fixture)
        self.assert_linked_files_unchanged(fixture)

        self.assertEqual(app.cleanup_canvas_import_session('canvas_inpaint', 'session-b'), 1)
        self.assertFalse(mask_orphan.exists())
        self.assertTrue(other_session_orphan.exists())
        self.assert_project_refs(fixture)
        self.assert_linked_files_unchanged(fixture)

    def test_cleanup_post_endpoints_keep_linked_src_and_mask_and_delete_orphans(self):
        fixture = self.create_project_with_linked_assets()
        global_orphan = self.make_png('canvas/session-a/orphan-endpoint.png')
        response = self.client.post('/api/canvas/cleanup_imports', json={
            'retainedRefs': [], 'activeSessionIds': [],
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json['deleted'], 1)
        self.assertFalse(global_orphan.exists())
        self.assert_linked_files_unchanged(fixture)

        refs_orphan = self.make_png('canvas_inpaint/session-b/orphan-refs-endpoint.png')
        refs = [self.public_src(path) for path in fixture['relatives'].values()]
        refs.append(self.public_src('canvas_inpaint/session-b/orphan-refs-endpoint.png'))
        response = self.client.post('/api/canvas/cleanup_import_refs', json={
            'refs': refs, 'retainedRefs': [],
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json['deleted'], 1)
        self.assertFalse(refs_orphan.exists())
        self.assert_linked_files_unchanged(fixture)

        session_orphan = self.make_png('canvas/session-a/orphan-session-endpoint.png')
        response = self.client.post('/api/canvas/cleanup_import_session', json={
            'category': 'canvas', 'sessionId': 'session-a',
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json['deleted'], 1)
        self.assertFalse(session_orphan.exists())
        self.assert_linked_files_unchanged(fixture)

    def test_storage_read_errors_abort_cleanup_functions_and_post_endpoints(self):
        fixture = self.create_project_with_linked_assets()
        orphan = self.make_png('canvas/session-a/orphan-failure.png')
        error = OSError('synthetic storage read failure')

        with mock.patch.object(app.DAKI_PROJECTS, 'canvas_states', side_effect=error):
            for cleanup in (
                lambda: app.cleanup_canvas_import_refs(
                    [fixture['relatives']['front'], 'canvas/session-a/orphan-failure.png'], [],
                ),
                lambda: app.cleanup_unreferenced_canvas_imports([], []),
                lambda: app.cleanup_canvas_import_session('canvas', 'session-a'),
            ):
                with self.assertRaisesRegex(OSError, 'synthetic storage read failure'):
                    cleanup()
                self.assertTrue(orphan.exists())
                self.assert_linked_files_unchanged(fixture)

            for url, body in (
                ('/api/canvas/cleanup_imports', {'retainedRefs': [], 'activeSessionIds': []}),
                ('/api/canvas/cleanup_import_refs', {'refs': [], 'retainedRefs': []}),
                ('/api/canvas/cleanup_import_session', {'category': 'canvas', 'sessionId': 'session-a'}),
            ):
                with self.subTest(url=url):
                    with self.assertRaisesRegex(OSError, 'synthetic storage read failure'):
                        self.client.post(url, json=body)
                    self.assertTrue(orphan.exists())
                    self.assert_linked_files_unchanged(fixture)


if __name__ == '__main__':
    unittest.main()
