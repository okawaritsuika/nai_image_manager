from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from urllib.parse import quote, unquote, urlsplit

from PIL import Image

from naim.storage.daki_projects import DakiNotFoundError, DakiProjectsStore


def gallery_resolver(root, aliases=None):
    root = Path(root).resolve()
    aliases = {} if aliases is None else aliases

    def resolve(relative):
        target = (root / relative).resolve()
        target.relative_to(root)
        if not target.is_file() and relative in aliases:
            target = (root / aliases[relative]).resolve()
            target.relative_to(root)
        if not target.is_file():
            raise FileNotFoundError('이미지가 없습니다.')
        return str(target), target.relative_to(root).as_posix()
    return resolve


class DakiProjectsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.gallery = self.root / 'gallery'
        self.gallery.mkdir()
        self.path = self.root / 'daki_projects.json'
        self.aliases = {}
        self.resolver = gallery_resolver(self.gallery, self.aliases)
        self.store = DakiProjectsStore(lambda: self.path, self.resolver)

    def image(self, relative='group/sample.png'):
        path = self.gallery / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new('RGB', (4, 8), (10, 30, 90)).save(path)
        return path

    def test_empty_defaults_and_named_project_survive_reopening(self):
        self.assertEqual(self.store.settings(), {'enabled': True})
        self.assertEqual(self.store.list_projects(), [])
        self.assertFalse(self.path.exists())
        project = self.store.create_project('  테스트 다키  ')
        self.assertEqual(project['name'], '테스트 다키')
        self.assertEqual(project['candidates'], {'front': [], 'back': []})
        reopened = DakiProjectsStore(self.path, self.resolver)
        self.assertEqual(reopened.get_project(project['id']), project)
        self.assertEqual(reopened.list_projects(), [project])

    def test_front_back_are_independent_and_removal_only_unlinks(self):
        source = self.image()
        original = source.read_bytes()
        project = self.store.create_project('Test', 'group/sample.png', 'front')
        duplicate = self.store.add_candidate(project['id'], 'group/sample.png', 'front')
        self.assertEqual(duplicate, project)
        updated = self.store.add_candidate(project['id'], 'group/sample.png', 'back')
        front = updated['candidates']['front'][0]
        back = updated['candidates']['back'][0]
        self.assertNotEqual(front['id'], back['id'])
        self.assertEqual(front['path'], back['path'])
        remaining = self.store.remove_candidate(project['id'], front['id'])
        self.assertEqual(remaining['candidates']['front'], [])
        self.assertEqual(remaining['candidates']['back'], [back])
        self.assertEqual(source.read_bytes(), original)
        with self.assertRaises(DakiNotFoundError):
            self.store.remove_candidate(project['id'], front['id'])

    def test_invalid_initial_image_never_publishes_project(self):
        invalid = self.gallery / 'broken.png'
        invalid.write_bytes(b'not an image')
        text = self.gallery / 'metadata.json'
        text.write_text('{}')
        for path, side, error in (
            ('missing.png', 'front', FileNotFoundError),
            ('broken.png', 'front', ValueError),
            ('metadata.json', 'front', ValueError),
            ('../outside.png', 'front', ValueError),
            ('C:/outside.png', 'front', ValueError),
            ('broken.png', 'unknown', ValueError),
        ):
            with self.subTest(path=path, side=side):
                with self.assertRaises(error):
                    self.store.create_project('Test', path, side)
                self.assertEqual(self.store.list_projects(), [])
                self.assertFalse(self.path.exists())
        for name in ('', '  ', None, 123, 'x' * 121):
            with self.assertRaises(ValueError):
                self.store.create_project(name)

    def test_unknown_fields_preserved_and_failed_save_retains_original(self):
        self.image()
        project = self.store.create_project('Test', 'group/sample.png', 'front')
        data = json.loads(self.path.read_text(encoding='utf-8'))
        data['extension'] = {'keep': [1, 2]}
        data['projects'][0]['extension'] = 'project'
        data['projects'][0]['candidates']['front'][0]['extension'] = 'candidate'
        self.path.write_text(json.dumps(data), encoding='utf-8')
        self.store.set_enabled(False)
        self.store.add_candidate(project['id'], 'group/sample.png', 'back')
        saved = json.loads(self.path.read_text(encoding='utf-8'))
        self.assertEqual(saved['extension'], {'keep': [1, 2]})
        self.assertEqual(saved['projects'][0]['extension'], 'project')
        self.assertEqual(saved['projects'][0]['candidates']['front'][0]['extension'], 'candidate')
        original = self.path.read_bytes()
        with mock.patch('naim.storage.json_files.os.replace', side_effect=OSError('save failed')):
            with self.assertRaises(OSError):
                self.store.create_project('Failed')
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(list(self.root.glob('*.tmp')), [])

    def test_parallel_candidate_and_setting_updates_preserve_all_changes(self):
        project = self.store.create_project('Concurrent')
        for index in range(12):
            self.image(f'group/{index}.png')

        def update(index):
            if index % 2:
                self.store.set_enabled(False)
            return self.store.add_candidate(project['id'], f'group/{index}.png', 'front')

        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(update, range(12)))
        candidates = self.store.get_project(project['id'])['candidates']['front']
        self.assertEqual({item['path'] for item in candidates}, {f'group/{index}.png' for index in range(12)})
        self.assertEqual(self.store.settings(), {'enabled': False})

    def test_references_use_folder_boundaries_and_survive_disabled_and_missing_images(self):
        first = self.image('group/sample.png')
        self.image('group/sub/other.png')
        self.image('group2/unrelated.png')
        project = self.store.create_project('Referenced', 'group/sample.png', 'front')
        self.store.add_candidate(project['id'], 'group/sub/other.png', 'back')
        self.store.create_project('Unrelated', 'group2/unrelated.png', 'front')
        self.store.set_enabled(False)
        first.unlink()
        matches = self.store.references(folders=['group'])
        self.assertEqual({item['path'] for item in matches}, {'group/sample.png', 'group/sub/other.png'})
        self.assertEqual(self.store.references(paths=['group/sample.png']), [{
            'project_id': project['id'], 'project_name': 'Referenced',
            'side': 'front', 'path': 'group/sample.png',
        }])
        self.assertEqual(len(self.store.references(folders=[''])), 3)

    def test_webp_alias_prevents_duplicates_and_warns_on_converted_source_deletion(self):
        original = self.image()
        project = self.store.create_project('Converted', 'group/sample.png', 'front')
        self.image('group/sample.webp')
        original.unlink()
        self.aliases['group/sample.png'] = 'group/sample.webp'
        updated = self.store.add_candidate(project['id'], 'group/sample.webp', 'front')
        self.assertEqual(updated, project)
        matches = self.store.references(paths=['group/sample.webp'])
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]['path'], 'group/sample.png')
        self.assertEqual(self.store.references(paths=['group/sample.png']), matches)

    def test_reference_inputs_and_boolean_settings_are_validated(self):
        for value in (0, 1, 'false', None):
            with self.assertRaises(ValueError):
                self.store.set_enabled(value)
        for kwargs in ({'paths': 'image.png'}, {'folders': '../outside'}, {'paths': ['../outside']}, {'folders': [None]}):
            with self.assertRaises(ValueError):
                self.store.references(**kwargs)

    def test_legacy_url_cleaner_keeps_literal_percent_hash_and_plus_filenames(self):
        def legacy_clean(value):
            path = unquote(urlsplit(value).path)
            return path[len('/image/'):] if path.startswith('/image/') else path

        legacy_resolver = lambda value: self.resolver(legacy_clean(value))
        store = DakiProjectsStore(self.path, legacy_resolver, legacy_clean)
        relative = 'group/literal%2F%23#plus+.png'
        self.image(relative)
        project = store.create_project('Special', relative, 'front')
        self.assertEqual(project['candidates']['front'][0]['path'], relative)
        url = '/image/' + quote(relative, safe='/')
        self.assertEqual(store.add_candidate(project['id'], url, 'front'), project)
        self.assertEqual(len(store.references(paths=[relative])), 1)
        self.assertEqual(len(store.references(paths=[url])), 1)
        self.assertEqual(store.resolve_image(relative)[1], relative)

        # Question marks cannot be Windows filenames, but the URL boundary
        # must also preserve them for compatible libraries on other systems.
        with mock.patch.object(store, 'resolve_source', return_value=('unused', 'group/a?b.png')) as resolver:
            store.resolve_image('group/a?b.png')
        self.assertEqual(resolver.call_args.args[0], '/image/group/a%3Fb.png')


if __name__ == '__main__':
    unittest.main()
