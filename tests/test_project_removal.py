import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest import mock

from flask import Flask
from PIL import Image

from naim.daki_drafts import DakiDrafts
from naim.images.project_removal import remove_project
from naim.storage.daki_projects import DakiProjectsStore
from naim.storage.history import HistoryDB
from naim.storage.project_archives import resolve_archived_image
from naim.web.project_removal import register_project_removal_routes


class WholeProjectRemovalTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.gallery = self.root / 'classified'
        self.gallery.mkdir()
        self.exports = self.root / 'project-exports'
        self.exports.mkdir()
        self.draft_root = self.root / 'daki-drafts'
        self.database = self.root / 'naia_history.db'
        self.app_data = self.root / 'app-data'
        patcher = mock.patch('naim.storage.history.get_app_dir', return_value=str(self.app_data))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.external_references = []
        self.gallery_lock = threading.RLock()
        self.aliases = {}
        self.store = DakiProjectsStore(lambda: self.root / 'daki_projects.json', self.resolve_image)
        self.drafts = DakiDrafts(lambda: self.draft_root, lambda: 'synthetic-key',
                                 generator=mock.Mock(side_effect=AssertionError('generator must not run')))
        self.addCleanup(self.drafts.wait)
        self.app = Flask(__name__)
        self.app.config['TESTING'] = True
        register_project_removal_routes(self.app, self.remove)
        self.client = self.app.test_client()

    def resolve_image(self, relative):
        archived = resolve_archived_image(self.gallery, relative, self.database)
        if archived is not None:
            return archived
        normalized = str(relative).replace('\\', '/')
        if normalized.startswith('__daki_exports__/'):
            target = self.exports / normalized.removeprefix('__daki_exports__/')
            if not target.is_file() and target.suffix.lower() == '.png':
                converted = target.with_suffix('.webp')
                if converted.is_file():
                    target = converted
        elif normalized.startswith('__daki_drafts__/'):
            draft_id = Path(normalized).stem
            target = self.draft_root / draft_id / 'image.png'
        else:
            target = self.gallery / normalized
        target = target.resolve()
        target.relative_to(self.gallery if target.is_relative_to(self.gallery)
                           else self.exports if target.is_relative_to(self.exports)
                           else self.draft_root)
        if not target.is_file() and normalized in self.aliases:
            target = (self.gallery / self.aliases[normalized]).resolve()
            target.relative_to(self.gallery)
        if not target.is_file():
            raise FileNotFoundError('synthetic image is missing')
        base = self.gallery if target.is_relative_to(self.gallery) else self.exports if target.is_relative_to(self.exports) else self.draft_root
        if base == self.exports:
            resolved_relative = '__daki_exports__/' + target.relative_to(self.exports).as_posix()
        elif base == self.draft_root:
            resolved_relative = '__daki_drafts__/' + target.parent.name + '.png'
        else:
            resolved_relative = target.relative_to(base).as_posix()
        return str(target), resolved_relative

    def remove(self, project_id, action, *, confirm_daki=False):
        return remove_project(
            self.store, self.drafts, project_id, action,
            gallery_root=self.gallery,
            db_factory=lambda: HistoryDB(self.database),
            gallery_lock=self.gallery_lock,
            references_provider=lambda paths: list(self.external_references),
            confirm_daki=confirm_daki,
        )

    @staticmethod
    def removal_url(project_id):
        return f'/api/daki/projects/{project_id}/delete'

    def image(self, relative, *, color=(12, 34, 56), image_format=None, root=None):
        base = Path(root) if root is not None else self.gallery
        path = base / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        fmt = image_format or Path(relative).suffix.lstrip('.').upper()
        if fmt == 'JPG':
            fmt = 'JPEG'
        Image.new('RGB', (4, 3), color).save(path, format=fmt)
        return path

    def add_project(self, name, relative=None, side='front'):
        return self.store.create_project(name, relative, side)

    def add_draft_folder(self, project_id, name='Target drafts'):
        return self.drafts.create_folder({'name': name, 'project_id': project_id})

    def add_draft(self, folder, draft_id, *, selected=False, status='completed', image=True):
        directory = self.draft_root / draft_id
        directory.mkdir(parents=True)
        if image:
            self.image('image.png', color=(23, 45, 67), root=directory)
        record = {
            'id': draft_id, 'status': status, 'created_at': 'synthetic-created',
            'updated_at': 'synthetic-updated', 'settings': {'width': 4, 'height': 3},
            'purpose': 'draft', 'selected': selected, 'folder_id': folder['id'],
        }
        (directory / 'draft.json').write_text(json.dumps(record), encoding='utf-8')
        return directory

    def seed_gallery_record(self, path, *, mode=None, model_family='v5', ctime=123.5):
        db = HistoryDB(self.database)
        try:
            return db.upsert_gallery_image_file(
                str(path), classified_root=str(self.gallery), width=4, height=3,
                mode=mode, model_family=model_family, ctime=ctime,
                reason='synthetic reason', gallery_tag='synthetic tag',
            )
        finally:
            db.close()

    def gallery_rows(self):
        db = HistoryDB(self.database)
        try:
            return {
                row[0]: row[1:]
                for row in db.conn.execute(
                    'SELECT rel_path, folder_path, file_name, mode, model_family, width, height, ctime, reason, gallery_tag FROM gallery_images'
                )
            }
        finally:
            db.close()

    def archive_path_for(self, result, suffix, contents):
        folder = self.gallery / result['gallery_folder']
        matches = [path for path in folder.glob(f'*{suffix}') if path.read_bytes() == contents]
        self.assertEqual(len(matches), 1, matches)
        return matches[0]

    def test_archive_copies_gallery_export_and_selected_or_unselected_drafts_and_updates_aliases(self):
        source = self.image('set/registered.png')
        source_bytes = source.read_bytes()
        source.with_suffix('.json').write_bytes(b'{"prompt":"gallery"}\n')
        source.with_suffix('.txt').write_bytes(b'gallery prompt\n')
        source_json, source_txt = source.with_suffix('.json'), source.with_suffix('.txt')
        self.seed_gallery_record(source, model_family='v4_5', ctime=456.25)
        unrelated = self.image('keep/unrelated.png', color=(90, 80, 70))
        unrelated_bytes = unrelated.read_bytes()
        self.seed_gallery_record(unrelated, model_family='other')

        project = self.add_project('Target / Project', 'set/registered.png')
        project = self.store.add_candidate(project['id'], 'set/registered.png', 'back')
        other_project = self.add_project('Other project', 'set/registered.png')
        export_id = 'a' * 32
        export = self.image(f'{project["id"]}/{export_id}.webp', image_format='WEBP', root=self.exports)
        export_bytes = export.read_bytes()
        export.with_suffix('.json').write_bytes(b'{"prompt":"export"}')
        export.with_suffix('.txt').write_bytes(b'export prompt')
        export_json, export_txt = export.with_suffix('.json'), export.with_suffix('.txt')
        export_reference = f'__daki_exports__/{project["id"]}/{export_id}.png'
        project = self.store.add_candidate(project['id'], export_reference, 'front')
        saved = json.loads(self.store.path.read_text(encoding='utf-8'))
        target_record = next(item for item in saved['projects'] if item['id'] == project['id'])
        target_record['candidates']['front'][-1]['path'] = export_reference
        self.store.path.write_text(json.dumps(saved), encoding='utf-8')

        folder = self.add_draft_folder(project['id'])
        selected_id, unselected_id, failed_id = 'b' * 32, 'c' * 32, 'd' * 32
        selected_dir = self.add_draft(folder, selected_id, selected=True)
        unselected_dir = self.add_draft(folder, unselected_id, selected=False)
        failed_dir = self.add_draft(folder, failed_id, status='failed', image=False)
        selected_bytes = (selected_dir / 'image.png').read_bytes()
        unselected_bytes = (unselected_dir / 'image.png').read_bytes()
        for directory, stem in ((selected_dir, b'selected'), (unselected_dir, b'unselected')):
            (directory / 'image.json').write_bytes(stem + b' metadata')
            (directory / 'image.txt').write_bytes(stem + b' prompt')
        selected_sidecars = [(selected_dir / 'image.json').read_bytes(), (selected_dir / 'image.txt').read_bytes()]
        unselected_sidecars = [(unselected_dir / 'image.json').read_bytes(), (unselected_dir / 'image.txt').read_bytes()]
        unrelated_folder = self.add_draft_folder('e' * 32, 'Unrelated drafts')
        unrelated_draft = self.add_draft(unrelated_folder, 'e' * 32)
        unrelated_draft_bytes = (unrelated_draft / 'image.png').read_bytes()

        db = HistoryDB(self.database)
        try:
            db.set_gallery_index_state('full_index_built', '1')
        finally:
            db.close()
        before_rows = self.gallery_rows()

        response = self.client.post(self.removal_url(project['id']), json={'action': 'archive'})

        self.assertEqual(response.status_code, 200, response.json)
        result = response.json
        self.assertEqual(result['action'], 'archive')
        self.assertEqual(result['archived_count'], 4)
        self.assertEqual(result['deleted_count'], 0)
        self.assertTrue(result['gallery_changed'])
        self.assertEqual(result['gallery_folder'], f'No_Metadata/프로젝트 보관/project_Target _ Project_{project["id"][:8]}')
        self.assertFalse(source.exists())
        self.assertFalse(source_json.exists())
        self.assertFalse(source_txt.exists())
        self.assertFalse(export.exists())
        self.assertFalse(export_json.exists())
        self.assertFalse(export_txt.exists())
        self.assertFalse(selected_dir.exists())
        self.assertFalse(unselected_dir.exists())
        self.assertFalse(failed_dir.exists())
        self.assertEqual(unrelated.read_bytes(), unrelated_bytes)
        self.assertEqual(unrelated_draft_bytes, (unrelated_draft / 'image.png').read_bytes())
        self.assertEqual(self.store.list_projects(), [other_project])
        self.assertEqual([folder['id'] for folder in self.drafts.list_folders()], [unrelated_folder['id']])

        gallery_copy = self.archive_path_for(result, '.png', source_bytes)
        export_copy = self.archive_path_for(result, '.webp', export_bytes)
        self.assertEqual(gallery_copy.read_bytes(), source_bytes)
        self.assertEqual(gallery_copy.with_suffix('.json').read_bytes(), b'{"prompt":"gallery"}\n')
        self.assertEqual(gallery_copy.with_suffix('.txt').read_bytes(), b'gallery prompt\n')
        self.assertEqual(export_copy.read_bytes(), export_bytes)
        self.assertEqual(export_copy.with_suffix('.json').read_bytes(), b'{"prompt":"export"}')
        self.assertEqual(export_copy.with_suffix('.txt').read_bytes(), b'export prompt')
        draft_copies = [path for path in (self.gallery / result['gallery_folder']).glob('*.png')
                        if path not in (gallery_copy,)]
        self.assertEqual(len(draft_copies), 2)
        self.assertEqual({path.read_bytes() for path in draft_copies}, {selected_bytes, unselected_bytes})
        copied_sidecars = [((path.with_suffix('.json')).read_bytes(), path.with_suffix('.txt').read_bytes())
                           for path in draft_copies]
        self.assertCountEqual(copied_sidecars, [tuple(selected_sidecars), tuple(unselected_sidecars)])

        old_gallery = self.store.resolve_image('set/registered.png')
        self.assertEqual(Path(old_gallery[0]), gallery_copy)
        old_export = self.store.resolve_image(export_reference)
        self.assertEqual(Path(old_export[0]), export_copy)
        self.assertEqual(Path(self.store.resolve_image(
            export_reference[:-4] + '.webp'
        )[0]), export_copy)
        self.assertEqual(self.store.get_project(other_project['id'])['candidates']['front'][0]['path'],
                         'set/registered.png')
        rows = self.gallery_rows()
        self.assertNotIn('set/registered.png', rows)
        self.assertIn('keep/unrelated.png', rows)
        self.assertEqual(rows['keep/unrelated.png'], before_rows['keep/unrelated.png'])
        self.assertEqual(rows[gallery_copy.relative_to(self.gallery).as_posix()][2:],
                         before_rows['set/registered.png'][2:])
        self.assertTrue(any(path.suffix == '.webp' for path in map(Path, rows)))
        archived_rows = {relative for relative in rows
                         if relative.startswith(result['gallery_folder'] + '/')}
        self.assertEqual(len(archived_rows), 4)
        db = HistoryDB(self.database)
        try:
            self.assertEqual(db.get_gallery_index_state('full_index_built'), '1')
        finally:
            db.close()

    def test_archive_preserves_r18_tree_and_mode(self):
        source = self.image('_R-18/series/explicit.webp', image_format='WEBP')
        source_bytes = source.read_bytes()
        self.seed_gallery_record(source, mode='r18', model_family='v5', ctime=987.5)
        project = self.add_project('R18', '_R-18/series/explicit.webp')

        response = self.client.post(self.removal_url(project['id']), json={'action': 'archive'})

        self.assertEqual(response.status_code, 200, response.json)
        archived = next((self.gallery / '_R-18/No_Metadata/프로젝트 보관').rglob('*.webp'))
        self.assertEqual(archived.read_bytes(), source_bytes)
        row = self.gallery_rows()[archived.relative_to(self.gallery).as_posix()]
        self.assertEqual(row[2], 'r18')
        self.assertEqual(row[3], 'v5')
        self.assertEqual(row[6], 987.5)
        self.assertFalse(source.exists())

    def test_delete_checks_other_references_then_confirmation_removes_only_project_assets(self):
        target_image = self.image('delete/target.png')
        target_image.with_suffix('.json').write_text('target metadata', encoding='utf-8')
        target_image.with_suffix('.txt').write_text('target prompt', encoding='utf-8')
        self.seed_gallery_record(target_image)
        unrelated = self.image('delete/keep.png', color=(80, 70, 60))
        self.seed_gallery_record(unrelated)
        target = self.add_project('Target delete', 'delete/target.png')
        canvas = self.store.create_canvas(target['id'], {
            'name': 'Synthetic canvas', 'side': 'front',
            'state': {'width': 4, 'height': 3, 'layers': []},
        })
        other = self.add_project('Other project', 'delete/target.png')
        target_folder = self.add_draft_folder(target['id'])
        target_draft = self.add_draft(target_folder, 'f' * 32, selected=True)
        unrelated_folder = self.add_draft_folder('1' * 32, 'Keep drafts')
        unrelated_draft = self.add_draft(unrelated_folder, '2' * 32)
        before_keep = unrelated.read_bytes(), (unrelated_draft / 'image.png').read_bytes()

        blocked = self.client.post(self.removal_url(target['id']), json={'action': 'delete'})

        self.assertEqual(blocked.status_code, 409, blocked.json)
        self.assertEqual(blocked.json['code'], 'daki_references')
        self.assertTrue(target_image.exists())
        self.assertTrue(target_folder['id'])
        self.assertTrue(target_draft.exists())
        self.assertEqual(self.store.get_project(target['id'])['id'], target['id'])
        self.assertEqual(self.store.get_project(target['id'])['canvases']['front'][0]['id'], canvas['id'])
        self.assertIn(target_folder['id'], {item['id'] for item in self.drafts.list_folders()})

        deleted = self.client.post(self.removal_url(target['id']),
                                   json={'action': 'delete', 'confirm_daki': True})

        self.assertEqual(deleted.status_code, 200, deleted.json)
        self.assertEqual(deleted.json['deleted_count'], 2)
        self.assertEqual(deleted.json['archived_count'], 0)
        self.assertFalse(target_image.exists())
        self.assertFalse(target_image.with_suffix('.json').exists())
        self.assertFalse(target_image.with_suffix('.txt').exists())
        self.assertFalse(target_draft.exists())
        self.assertEqual(self.store.list_projects(), [other])
        self.assertEqual([folder['id'] for folder in self.drafts.list_folders()], [unrelated_folder['id']])
        self.assertEqual((unrelated.read_bytes(), (unrelated_draft / 'image.png').read_bytes()), before_keep)
        self.assertFalse(self.gallery_rows().get('delete/target.png'))
        self.assertIn('delete/keep.png', self.gallery_rows())

    def test_delete_removes_export_files_and_only_its_project_and_draft_folders(self):
        target = self.add_project('Export delete')
        export_id = '9' * 32
        export = self.image(f'{target["id"]}/{export_id}.png', root=self.exports)
        export.with_suffix('.json').write_text('metadata', encoding='utf-8')
        export.with_suffix('.txt').write_text('prompt', encoding='utf-8')
        target = self.store.add_candidate(target['id'],
                                          f'__daki_exports__/{target["id"]}/{export_id}.png', 'front')
        folder = self.add_draft_folder(target['id'])
        draft_dir = self.add_draft(folder, '3' * 32)
        unrelated = self.add_project('Unrelated')

        response = self.client.post(self.removal_url(target['id']),
                                    json={'action': 'delete', 'confirm_daki': True})

        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(response.json['deleted_count'], 2)
        self.assertFalse(export.exists())
        self.assertFalse(export.with_suffix('.json').exists())
        self.assertFalse(export.with_suffix('.txt').exists())
        self.assertFalse(draft_dir.exists())
        self.assertEqual(self.store.list_projects(), [unrelated])
        self.assertNotIn(folder['id'], {item['id'] for item in self.drafts.list_folders()})

    def test_post_commit_gallery_index_failure_warns_without_undoing_removal(self):
        source = self.image('index-failure/source.png')
        source_bytes = source.read_bytes()
        project = self.add_project('Index warning', 'index-failure/source.png')
        folder = self.add_draft_folder(project['id'])
        draft = self.add_draft(folder, '7' * 32)

        with mock.patch.object(HistoryDB, 'upsert_gallery_image_records',
                               side_effect=OSError('synthetic index failure')):
            response = self.client.post(self.removal_url(project['id']), json={'action': 'archive'})

        self.assertEqual(response.status_code, 200, response.json)
        self.assertTrue(response.json['warning'])
        self.assertFalse(source.exists())
        self.assertFalse(draft.exists())
        self.assertEqual(self.store.list_projects(), [])
        archived = self.archive_path_for(response.json, '.png', source_bytes)
        self.assertTrue(archived.is_file())

    def test_archive_copy_failure_rolls_back_project_drafts_and_owned_copies(self):
        first = self.image('rollback/first.png')
        second = self.image('rollback/second.png', color=(40, 50, 60))
        project = self.add_project('Rollback', 'rollback/first.png')
        project = self.store.add_candidate(project['id'], 'rollback/second.png', 'back')
        folder = self.add_draft_folder(project['id'])
        draft = self.add_draft(folder, '4' * 32)
        project_bytes = self.store.path.read_bytes()
        catalog_bytes = (self.draft_root / 'folders.json').read_bytes()
        original_files = {path: path.read_bytes() for path in (first, second, draft / 'image.png', draft / 'draft.json')}
        real_bundle = __import__('naim.images.project_removal', fromlist=['_archived_bundle'])._archived_bundle
        calls = 0

        def fail_after_first_copy(source, destination_folder, name):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError('synthetic copy failure')
            return real_bundle(source, destination_folder, name)

        with mock.patch('naim.images.project_removal._archived_bundle', side_effect=fail_after_first_copy):
            response = self.client.post(self.removal_url(project['id']), json={'action': 'archive'})

        self.assertEqual(response.status_code, 500, response.json)
        self.assertEqual(self.store.path.read_bytes(), project_bytes)
        self.assertEqual((self.draft_root / 'folders.json').read_bytes(), catalog_bytes)
        self.assertEqual({path: path.read_bytes() for path in original_files}, original_files)
        self.assertFalse(any(path.is_file() for path in (self.gallery / 'No_Metadata/프로젝트 보관').glob('**/*')))

    def test_alias_database_write_failure_rolls_back_archive_copy_and_staged_sources(self):
        source = self.image('rollback/alias.png')
        source_bytes = source.read_bytes()
        project = self.add_project('Alias rollback', 'rollback/alias.png')
        folder = self.add_draft_folder(project['id'])
        draft = self.add_draft(folder, '5' * 32, selected=False)
        project_bytes = self.store.path.read_bytes()
        catalog_bytes = (self.draft_root / 'folders.json').read_bytes()
        with mock.patch('naim.images.project_removal.record_archived_images',
                        side_effect=OSError('synthetic alias db failure')):
            response = self.client.post(self.removal_url(project['id']), json={'action': 'archive'})

        self.assertEqual(response.status_code, 500, response.json)
        self.assertEqual(source.read_bytes(), source_bytes)
        self.assertTrue(draft.is_dir())
        self.assertEqual(self.store.path.read_bytes(), project_bytes)
        self.assertEqual((self.draft_root / 'folders.json').read_bytes(), catalog_bytes)
        self.assertFalse(any(path.is_file() for path in (self.gallery / 'No_Metadata/프로젝트 보관').glob('**/*')))
        connection = sqlite3.connect(self.database)
        try:
            self.assertEqual(connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='gallery_project_archives'"
            ).fetchone(), None)
        finally:
            connection.close()

    def test_running_draft_blocks_removal_without_changing_project_or_files(self):
        source = self.image('running/current.png')
        project = self.add_project('Busy project', 'running/current.png')
        folder = self.add_draft_folder(project['id'])
        running = self.add_draft(folder, '6' * 32, status='running')
        project_bytes = self.store.path.read_bytes()
        catalog_bytes = (self.draft_root / 'folders.json').read_bytes()
        source_bytes = source.read_bytes()

        response = self.client.post(self.removal_url(project['id']),
                                    json={'action': 'delete', 'confirm_daki': True})

        self.assertEqual(response.status_code, 409, response.json)
        self.assertEqual(response.json['code'], 'project_busy')
        self.assertEqual(self.store.path.read_bytes(), project_bytes)
        self.assertEqual((self.draft_root / 'folders.json').read_bytes(), catalog_bytes)
        self.assertEqual(source.read_bytes(), source_bytes)
        self.assertTrue(running.is_dir())

    def test_invalid_non_object_and_missing_requests_leave_storage_untouched(self):
        source = self.image('validation/source.png')
        project = self.add_project('Validation', 'validation/source.png')
        project_bytes = self.store.path.read_bytes()
        source_bytes = source.read_bytes()
        url = self.removal_url(project['id'])
        malformed = self.client.post(url, data='{', content_type='application/json')
        self.assertEqual(malformed.status_code, 400)
        for payload in ([], 'bad', None, {'action': 'other'}, {'action': 'archive', 'confirm_daki': 1}):
            with self.subTest(payload=payload):
                response = self.client.post(url, json=payload)
                self.assertEqual(response.status_code, 400, response.json)
        self.assertEqual(self.client.post(self.removal_url('f' * 32), json={'action': 'archive'}).status_code, 404)
        self.assertEqual(self.store.path.read_bytes(), project_bytes)
        self.assertEqual(source.read_bytes(), source_bytes)

    def test_archive_alias_chains_flatten_and_invalid_alias_reads_are_read_only(self):
        source = self.image('chain/source.png')
        source_bytes = source.read_bytes()
        reference = 'chain/source.png'
        first_project = self.add_project('First archive', reference)
        first_response = self.client.post(self.removal_url(first_project['id']), json={'action': 'archive'})
        self.assertEqual(first_response.status_code, 200, first_response.json)
        first_target = self.store.resolve_image(reference)[0]
        second_project = self.add_project('Second archive', reference)
        second_response = self.client.post(self.removal_url(second_project['id']), json={'action': 'archive'})
        self.assertEqual(second_response.status_code, 200, second_response.json)
        second_target = self.store.resolve_image(reference)[0]
        self.assertNotEqual(Path(first_target), Path(second_target))
        self.assertEqual(Path(second_target).read_bytes(), source_bytes)
        self.assertEqual(resolve_archived_image(self.gallery, reference, self.database),
                         (second_target, Path(second_target).relative_to(self.gallery).as_posix()))
        missing_db = self.root / 'does-not-exist.db'
        self.assertIsNone(resolve_archived_image(self.gallery, '../escape.png', missing_db))
        self.assertIsNone(resolve_archived_image(self.gallery, reference, missing_db))
        self.assertFalse(missing_db.exists())

        connection = sqlite3.connect(self.database)
        try:
            connection.execute('INSERT OR REPLACE INTO gallery_project_archives VALUES (?, ?)',
                               ('unsafe-alias.png', '../outside.png'))
            connection.commit()
        finally:
            connection.close()
        self.assertIsNone(resolve_archived_image(self.gallery, 'unsafe-alias.png', self.database))


if __name__ == '__main__':
    unittest.main()
