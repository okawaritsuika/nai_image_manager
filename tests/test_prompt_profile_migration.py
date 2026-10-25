"""Preserve saved search scopes when rebuilding an old prompt index."""
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from naim.storage.history import HistoryDB


class PromptProfileMigrationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / 'synthetic.sqlite'
        # The optional lookup DB must also remain inside the synthetic fixture.
        patch = mock.patch('naim.storage.history.get_app_dir', return_value=temporary.name)
        patch.start()
        self.addCleanup(patch.stop)
        self.db = HistoryDB(self.path)
        self.addCleanup(lambda: self.db.close())
        self.profile = self.db.upsert_gallery_prompt_index_profile(
            'Synthetic saved scope', 'general', ['synthetic/folder'],
            ['synthetic/folder/image.png'], text_bytes=100,
        )
        self.db.upsert_gallery_prompt_records([{
            'rel_path': 'synthetic/folder/image.png', 'folder_path': 'synthetic/folder',
            'file_name': 'image.png', 'mode': 'general', 'prompt_text': 'synthetic prompt',
            'normalized_text': 'synthetic prompt', 'text_bytes': 100,
        }])

    def reopen(self):
        self.db.close()
        self.db = HistoryDB(self.path)

    def assert_profile_preserved_and_invalidated(self):
        profiles = self.db.list_gallery_prompt_index_profiles()
        self.assertEqual(len(profiles), 1)
        profile = profiles[0]
        for field in ('id', 'name', 'mode', 'scope_paths_json', 'created_at', 'updated_at'):
            self.assertEqual(profile[field], self.profile[field], field)
        for field in ('image_count', 'text_bytes', 'built_at'):
            self.assertEqual(profile[field], 0, field)
        self.assertEqual(self.db.get_gallery_prompt_index_profile_paths(profile['id']), [])
        self.assertEqual(self.db.get_gallery_prompt_index_status(),
                         {'indexed_images': 0, 'text_bytes': 0, 'updated_at': 0.0})

    def test_old_semantics_preserves_profile_definition_and_invalidates_statistics(self):
        with self.db.conn:
            self.db.conn.execute("UPDATE gallery_index_state SET value = 'synthetic-old-version' "
                                 "WHERE key = 'prompt_index_semantics_version'")
            self.db.conn.execute('ALTER TABLE gallery_prompt_index_profiles ADD COLUMN legacy_extension TEXT')
            self.db.conn.execute("UPDATE gallery_prompt_index_profiles SET legacy_extension = 'preserve'")
        self.reopen()
        self.assert_profile_preserved_and_invalidated()
        self.assertEqual(self.db.conn.execute('SELECT legacy_extension FROM gallery_prompt_index_profiles').fetchone(),
                         ('preserve',))
        self.reopen()
        self.assert_profile_preserved_and_invalidated()

    def test_missing_semantics_marker_preserves_profile(self):
        with self.db.conn:
            self.db.conn.execute("DELETE FROM gallery_index_state WHERE key = 'prompt_index_semantics_version'")
        self.reopen()
        self.assert_profile_preserved_and_invalidated()

    def test_rebuilt_profile_statistics_survive_later_startup(self):
        with self.db.conn:
            self.db.conn.execute("UPDATE gallery_index_state SET value = 'synthetic-old-version' "
                                 "WHERE key = 'prompt_index_semantics_version'")
        self.reopen()
        self.assert_profile_preserved_and_invalidated()
        self.db.upsert_gallery_prompt_records([
            {'rel_path': f'synthetic/folder/{name}.png', 'prompt_text': 'synthetic ' * 10}
            for name in ('image', 'second')
        ])
        rebuilt = self.db.upsert_gallery_prompt_index_profile(
            self.profile['name'], self.profile['mode'], ['synthetic/folder'],
            ['synthetic/folder/image.png', 'synthetic/folder/second.png'], text_bytes=200,
        )
        self.assertEqual(rebuilt['id'], self.profile['id'])
        self.assertEqual(rebuilt['created_at'], self.profile['created_at'])
        self.reopen()
        self.assertEqual(self.db.list_gallery_prompt_index_profiles(), [rebuilt])
        self.assertEqual(len(self.db.get_gallery_prompt_index_profile_paths(rebuilt['id'])), 2)
        status = self.db.get_gallery_prompt_index_status()
        self.assertEqual((status['indexed_images'], status['text_bytes']), (2, 200))
