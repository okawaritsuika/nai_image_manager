from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from PIL import Image

from naim.storage.daki_tag_examples import DakiTagExamples


class TagExampleStoreTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.image = self.root / 'original.png'
        with Image.new('RGBA', (5, 8), 'blue') as image:
            image.save(self.image)
        def resolve(relative):
            if relative not in ('folder/image.png', 'folder/old.png') or not self.image.is_file():
                raise FileNotFoundError()
            return self.image, 'folder/image.png'
        self.store = DakiTagExamples(self.root / 'examples', resolve)

    def test_links_are_deduplicated_concurrently_and_keep_source_pixels(self):
        before = self.image.read_bytes()
        with ThreadPoolExecutor(max_workers=3) as executor:
            results = list(executor.map(lambda _: self.store.add('hair', 'folder/old.png'), range(6)))
        self.assertEqual(len({result['id'] for result in results}), 1)
        self.assertEqual(len(self.store.list_examples('hair')), 1)
        self.assertEqual(self.image.read_bytes(), before)
        self.assertEqual(list((self.root / 'examples').iterdir()), [self.root / 'examples/catalog.json'])
        self.assertEqual(self.store.image_path('hair', results[0]['id']), self.image)

    def test_reference_warnings_cover_aliases_folders_and_missing_original(self):
        result = self.store.add('hair', 'folder/image.png')
        self.assertEqual(self.store.references(paths=['folder/old.png'])[0]['example_id'], result['id'])
        self.assertEqual(len(self.store.references(folders=['folder'])), 1)
        self.assertEqual(self.store.references(folders=['fold']), [])
        self.image.unlink()
        self.assertEqual(len(self.store.references(paths=['folder/image.png'])), 1)
        with self.assertRaises(FileNotFoundError):
            self.store.image_path('hair', result['id'])

    def test_failed_save_keeps_existing_reference_and_does_not_modify_source(self):
        self.store.add('hair', 'folder/image.png')
        manifest = self.root / 'examples/catalog.json'
        before, source = manifest.read_bytes(), self.image.read_bytes()
        with mock.patch('naim.storage.daki_tag_examples.write_json', side_effect=OSError('synthetic failure')):
            with self.assertRaises(OSError):
                self.store.add('shirt', 'folder/image.png')
        self.assertEqual(manifest.read_bytes(), before)
        self.assertEqual(self.image.read_bytes(), source)
        self.assertEqual(self.store.list_examples('shirt'), [])

    def test_unregistered_id_bad_path_and_non_image_are_rejected(self):
        for path in ('../original.png', str(self.image), 'https://example.invalid/image.png'):
            with self.assertRaises(ValueError):
                self.store.add('hair', path)
        self.image.write_text('not an image')
        with self.assertRaises(ValueError):
            self.store.add('hair', 'folder/image.png')
        with self.assertRaises(KeyError):
            self.store.image_path('hair', 'a' * 32)
        with self.assertRaises(ValueError):
            self.store.image_path('hair', '../anything')
        self.assertFalse((self.root / 'examples').exists())


if __name__ == '__main__':
    unittest.main()
