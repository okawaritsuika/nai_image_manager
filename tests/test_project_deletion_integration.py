from pathlib import Path
import re
import tempfile
import unittest
from unittest import mock

from PIL import Image

import app
from naim.images.canvas_export import save_project_candidate_image
from naim.storage.history import HistoryDB
from naim.daki_image_refs import parse_daki_image_reference


class ProjectDeletionAppIntegrationTests(unittest.TestCase):
    """Exercise app.py's real resolver, route wiring, and deletion callback."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.gallery = self.root / 'classified'
        self.gallery.mkdir()
        self.imports = self.root / 'canvas_imports'
        self.imports.mkdir()
        self.database = self.root / 'gallery.db'

        path_patches = (
            mock.patch.object(app, 'CLASSIFIED_DIR', str(self.gallery)),
            mock.patch.object(app, 'CANVAS_IMPORT_DIR', str(self.imports)),
            mock.patch.object(app, 'DAKI_PROJECTS_FILE', str(self.root / 'daki_projects.json')),
        )
        for patcher in path_patches:
            patcher.start()
            self.addCleanup(patcher.stop)
        for patcher in (
            mock.patch.object(app.DAKI_PERSONAL_STYLES, 'references', return_value=[]),
            mock.patch.object(app.DAKI_TAG_EXAMPLES, 'references', return_value=[]),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

        self.history_factory = mock.Mock(side_effect=self._new_history_db)
        self.history_patch = mock.patch.object(app.utils, 'HistoryDB', self.history_factory)
        self.history_patch.start()
        self.addCleanup(self.history_patch.stop)

        app.app.config['TESTING'] = True
        self.client = app.app.test_client()

    def _new_history_db(self, *args, **kwargs):
        return HistoryDB(self.database)

    def gallery_image(self, name, color=(20, 40, 60)):
        path = self.gallery / name
        Image.new('RGB', (4, 3), color).save(path)
        return path

    def seed_gallery_record(self, path):
        database = HistoryDB(self.database)
        try:
            database.upsert_gallery_image_file(
                str(path),
                classified_root=str(self.gallery),
                width=4,
                height=3,
                model_family='other',
            )
            database.rebuild_gallery_folder_summaries()
        finally:
            database.close()

    def gallery_record_exists(self, relative):
        database = HistoryDB(self.database)
        try:
            return database.gallery_image_record_exists(relative)
        finally:
            database.close()

    def test_app_route_deletes_gallery_bundle_and_only_its_gallery_record(self):
        source = self.gallery_image('selected.png')
        source.with_suffix('.json').write_text('{"prompt":"synthetic"}', encoding='utf-8')
        source.with_suffix('.txt').write_text('synthetic prompt', encoding='utf-8')
        unrelated = self.gallery_image('unrelated.png', (70, 80, 90))
        unrelated_bytes = unrelated.read_bytes()
        self.seed_gallery_record(source)
        self.seed_gallery_record(unrelated)

        project = app.DAKI_PROJECTS.create_project('Gallery deletion', 'selected.png', 'front')
        candidate = project['candidates']['front'][0]

        response = self.client.post(
            f"/api/daki/projects/{project['id']}/candidates/{candidate['id']}/delete",
            json={},
        )

        self.assertEqual(response.status_code, 200, response.json)
        self.assertNotIn('warning', response.json)
        self.assertFalse(source.exists())
        self.assertFalse(source.with_suffix('.json').exists())
        self.assertFalse(source.with_suffix('.txt').exists())
        self.assertEqual(app.DAKI_PROJECTS.get_project(project['id'])['candidates']['front'], [])
        self.assertFalse(self.gallery_record_exists('selected.png'))
        self.assertTrue(self.gallery_record_exists('unrelated.png'))
        self.assertEqual(unrelated.read_bytes(), unrelated_bytes)
        self.assertEqual(self.history_factory.call_count, 1)

    def test_project_export_deletion_uses_real_allowlist_for_png_and_webp_alias(self):
        unrelated = self.gallery_image('unrelated.png', (7, 8, 9))
        unrelated_bytes = unrelated.read_bytes()
        self.seed_gallery_record(unrelated)
        export_root = self.imports / 'project_exports'
        unrelated_export = self.imports / 'unrelated.keep'
        unrelated_export.write_bytes(b'keep')

        for converted in (False, True):
            with self.subTest(converted=converted):
                project = app.DAKI_PROJECTS.create_project(
                    'Private export converted' if converted else 'Private export PNG',
                )
                result = save_project_candidate_image(
                    app.DAKI_PROJECTS,
                    export_root,
                    project['id'],
                    'front',
                    Image.new('RGBA', (3, 2), (41, 52, 63, 127)),
                    {'basePrompt': 'synthetic project export'},
                )
                reference = result['path']
                match = re.fullmatch(r'__daki_exports__/([a-f0-9]{32})/([a-f0-9]{32})\.png', reference)
                self.assertIsNotNone(match)
                self.assertEqual(match.group(1), project['id'])
                self.assertEqual(parse_daki_image_reference(reference), ('export', match.group(1), match.group(2)))
                source, resolved_reference = app.resolve_daki_image_path('/image/' + reference)
                source = Path(source)
                self.assertEqual(resolved_reference, reference)
                self.assertEqual(source, export_root / project['id'] / f"{match.group(2)}.png")
                self.assertTrue(source.is_file())
                sidecar = source.with_suffix('.json')
                prompt_sidecar = source.with_suffix('.txt')
                self.assertTrue(sidecar.is_file())
                prompt_sidecar.write_text('synthetic sidecar', encoding='utf-8')

                if converted:
                    webp = source.with_suffix('.webp')
                    with Image.open(source) as exported:
                        exported.save(webp, format='WEBP')
                    source.unlink()
                    self.assertTrue(webp.is_file())
                    actual_source = webp
                else:
                    actual_source = source

                stored_project = app.DAKI_PROJECTS.get_project(project['id'])
                candidate = stored_project['candidates']['front'][0]
                self.assertEqual(candidate['path'], reference)
                self.history_factory.reset_mock()

                response = self.client.post(
                    f"/api/daki/projects/{project['id']}/candidates/{candidate['id']}/delete",
                    json={},
                )

                self.assertEqual(response.status_code, 200, response.json)
                self.assertNotIn('warning', response.json)
                self.assertFalse(actual_source.exists())
                self.assertFalse(sidecar.exists())
                self.assertFalse(prompt_sidecar.exists())
                self.assertEqual(app.DAKI_PROJECTS.get_project(project['id'])['candidates']['front'], [])
                self.assertEqual(self.history_factory.call_count, 0)
                self.assertTrue(unrelated_export.exists())
                self.assertTrue(self.gallery_record_exists('unrelated.png'))
                self.assertEqual(unrelated.read_bytes(), unrelated_bytes)


if __name__ == '__main__':
    unittest.main()
