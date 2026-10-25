import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from concurrent.futures import ThreadPoolExecutor

from naim.storage import json_files
from naim.paths import path_identity_key


class JsonFilesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "settings.json"

    def test_existing_unknown_keys_survive_partial_update(self):
        original = {"legacy_extra": {"nested": [1, 2]}, "mode": "copy"}
        self.path.write_text(json.dumps(original), encoding="utf-8")
        json_files.merge_json_object(self.path, {"mode": "move"})
        self.assertEqual(json_files.read_json(self.path), {**original, "mode": "move"})

    def test_corrupt_bytes_backed_up_before_defaults_replace_them(self):
        for content in (b'{"unfinished":', b'\xff\xfe', b'[]'):
            with self.subTest(content=content):
                self.path.write_bytes(content)
                self.assertEqual(json_files.read_json(self.path, expected_type=dict), {})
                self.assertEqual(json.loads(self.path.read_text()), {})
                self.assertTrue(any(p.read_bytes() == content for p in self.path.parent.glob('*.bak')))

    def test_failed_backup_preserves_corrupt_original(self):
        self.path.write_bytes(b'{broken')
        with mock.patch.object(json_files.shutil, 'copy2', side_effect=OSError('backup failed')):
            with self.assertRaises(OSError):
                json_files.read_json(self.path)
        self.assertEqual(self.path.read_bytes(), b'{broken')

    def test_serialization_and_replace_failure_preserve_existing_json(self):
        self.path.write_bytes(b'{"old": true}')
        with self.assertRaises(TypeError):
            json_files.write_json(self.path, {"bad": object()})
        with mock.patch.object(json_files.os, 'replace', side_effect=OSError('locked')):
            with self.assertRaises(OSError):
                json_files.write_json(self.path, {"new": True})
        self.assertEqual(self.path.read_bytes(), b'{"old": true}')
        self.assertEqual(list(self.path.parent.glob('*.tmp')), [])

    def test_parallel_partial_updates_do_not_lose_keys(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda i: json_files.merge_json_object(self.path, {str(i): i}), range(40)))
        self.assertEqual(json_files.read_json(self.path), {str(i): i for i in range(40)})

    @unittest.skipUnless(os.name == 'nt', 'Windows path aliases only')
    def test_windows_path_identity_key_normalizes_extended_drive_and_unc_aliases(self):
        self.assertEqual(path_identity_key(r'C:\synthetic\settings.json'),
                         path_identity_key(r'\\?\C:\synthetic\settings.json'))
        self.assertEqual(path_identity_key(r'\\server\share\synthetic\settings.json'),
                         path_identity_key(r'\\?\UNC\server\share\synthetic\settings.json'))
        self.assertNotEqual(path_identity_key(r'C:\synthetic\settings.json'),
                            path_identity_key(r'C:\synthetic\other.json'))
        volume_path = r'\\?\Volume{synthetic-guid}\settings.json'
        self.assertEqual(path_identity_key(volume_path), os.path.normcase(os.path.abspath(volume_path)))

    @unittest.skipUnless(os.name == 'nt', 'Windows path aliases only')
    def test_parallel_updates_share_lock_for_extended_drive_alias(self):
        normal_path = os.path.abspath(self.path)
        if normal_path.startswith('\\\\?\\unc\\'):
            normal_path = '\\\\' + normal_path[8:]
        elif normal_path.startswith('\\\\?\\'):
            normal_path = normal_path[4:]
        if normal_path.startswith('\\\\'):
            extended_path = '\\\\?\\UNC\\' + normal_path[2:]
        else:
            extended_path = '\\\\?\\' + normal_path

        def update(index):
            path = self.path if index % 2 else extended_path
            return json_files.merge_json_object(path, {str(index): index})

        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(update, range(40)))
        self.assertEqual(json_files.read_json(self.path), {str(i): i for i in range(40)})

    def test_direct_save_also_backs_up_corrupt_original(self):
        self.path.write_bytes(b'broken')
        json_files.write_json(self.path, {"new": True})
        self.assertEqual(next(self.path.parent.glob('*.bak')).read_bytes(), b'broken')
        self.assertEqual(json_files.read_json(self.path), {"new": True})

    def test_absent_file_returns_fresh_defaults_without_creating_it(self):
        self.assertEqual(json_files.read_json(self.path, list), [])
        self.assertFalse(self.path.exists())
