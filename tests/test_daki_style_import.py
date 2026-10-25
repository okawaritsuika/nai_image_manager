from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from PIL import Image
from PIL.PngImagePlugin import PngInfo

from naim.storage.daki_shared_styles import DakiSharedStyles
from tools import import_daki_v5_styles as importer


class DakiStyleImportTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / 'source'
        self.catalog = self.root / 'research' / 'style-catalog'
        self.destination = self.root / 'imported'
        self.images = self.source / 'artist_rater' / 'data' / 'arca_style_images'
        self.images.mkdir(parents=True)
        self.catalog.mkdir(parents=True)
        names = self.catalog.parent / 'v5-style-controls'
        names.mkdir()
        (names / 'known_bare_artists_v2.json').write_text('{"names":[]}', encoding='utf-8')
        self.options = {'steps': 23, 'cfg': 5, 'cfg_rescale': 0, 'sampler': 'k_euler_ancestral',
                        'noise_schedule': 'karras', 'prefer_brownian': False}
        self.original_style = {
            'id': 'existing', 'name': 'Existing synthetic style', 'model': 'nai-diffusion-5-full',
            'positive': 'flat color', 'negative': '', 'source_image_id': 1,
            'source_url': 'https://example.test/old',
            'preview': {'width': 64, 'height': 128, 'image': 'old.png', 'thumbnail': 'old.png', 'job_id': 'old'},
        }
        duplicate = dict(self.original_style, id='existing-duplicate')
        self.write_json(self.catalog / 'default_styles.json', {'styles': [self.original_style, duplicate]})
        self.write_json(self.catalog / 'source_generation_options.json', {'styles': {
            sid: {'source_image_id': 1, 'options': self.options} for sid in ('existing', 'existing-duplicate')}})
        self.write_json(self.catalog / 'generation_manifest.json', {'jobs': {'old': {'seed': 12, 'status': 'success'}}})
        Image.new('RGB', (64, 128), 'gray').save(self.catalog / 'old.png')
        Image.new('RGB', (64, 128), 'blue').save(self.images / 'new.png')
        Image.new('RGB', (64, 128), 'blue').save(self.images / 'duplicate.png')
        self.seed_db = self.source / 'artist_rater' / 'arca_style_seed.sqlite'
        self.local_db = self.source / 'artist_rater' / 'data' / 'artist_rater.sqlite'
        styles = [('watercolor', 'new.png'), ('ink', 'duplicate.png'), ('realistic', 'new.png'),
                  ('flat color', 'new.png'), ('invalid syntax', 'new.png')]
        self.create_database(self.seed_db, styles, local=False)
        self.create_database(self.local_db, styles, local=True)
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(importer, 'research_helpers', self.fake_helpers).start()

    @staticmethod
    def write_json(path, value):
        path.write_text(json.dumps(value), encoding='utf-8')

    def create_database(self, path, styles, local):
        with sqlite3.connect(path) as connection:
            connection.executescript('''
                CREATE TABLE arca_style_items (id INTEGER, source_url TEXT, posted_at TEXT);
                CREATE TABLE arca_style_images (id INTEGER, item_id INTEGER, image_url TEXT,
                    image_path TEXT, model_family TEXT, metadata_status TEXT, base_prompt TEXT,
                    prompt TEXT, negative_prompt TEXT, raw_metadata_json TEXT, model TEXT, width INTEGER, height INTEGER);
            ''')
            for number, (positive, image) in enumerate(styles, 1):
                connection.execute('INSERT INTO arca_style_items VALUES (?, ?, ?)',
                                   (number, f'https://example.test/post/{number}', '2026-01-01'))
                raw = {**self.options, 'seed': '42'}
                connection.execute('INSERT INTO arca_style_images VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    (number + (900 if local else 100), number,
                     f'https://images.example.test/{number}.png?expires={2 if local else 1}',
                     image if local else '', 'v5', 'ok', positive, positive, '', json.dumps(raw),
                     'NovelAI Diffusion V5', 64, 128))

    @contextmanager
    def fake_helpers(self, *args):
        fingerprint = lambda positive, negative: hashlib.sha256((positive + '|' + negative).encode()).hexdigest()
        def extract(row, names, version):
            return {'issues': ['unsupported'] if row['base_prompt'] == 'invalid syntax' else [],
                    'positive': row['base_prompt'], 'negative': row['negative_prompt'],
                    'fingerprint': fingerprint(row['base_prompt'], row['negative_prompt']), 'import_edits': []}
        yield (SimpleNamespace(parse=lambda text: text, key=lambda text: text),
               SimpleNamespace(build_style_groups=lambda rows: [{'images': [row]} for row in rows]),
               SimpleNamespace(fingerprint=fingerprint, extract=extract),
               SimpleNamespace(original_options=lambda raw, image_id: {key: raw[key] for key in self.options}))

    def run_import(self, apply=False):
        return importer.import_styles(self.source, self.catalog, self.destination, apply=apply)

    def test_dry_run_filters_repeated_recipes_and_pixels_without_writing_any_source(self):
        before = {path: hashlib.sha256(path.read_bytes()).hexdigest()
                  for path in (self.seed_db, self.local_db, self.images / 'new.png')}
        result = self.run_import()
        self.assertEqual(result['new_recipes'], 2)
        self.assertEqual(result['imported_styles'], 1)
        self.assertEqual(result['duplicate_new_images'], 1)
        self.assertEqual(result['duplicate_original_cards'], 1)
        self.assertEqual(result['payloads_validated'], 1)
        self.assertEqual(result['unresolved_images'], 1)
        self.assertFalse(self.destination.exists())
        self.assertEqual(before, {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in before})

    def test_apply_matches_natural_keys_preserves_values_and_retains_old_duplicate_ids(self):
        self.run_import(apply=True)
        store = DakiSharedStyles(self.catalog, self.destination)
        styles = store.list_styles()
        self.assertEqual(len(styles), 2)
        imported = next(style for style in styles if style['category'] == 'v5')
        self.assertEqual(imported['model'], 'NovelAI Diffusion V5')
        self.assertEqual(imported['seed'], 42)
        self.assertEqual(imported['options'], self.options)
        self.assertEqual(imported['preview'], {'width': 64, 'height': 128})
        self.assertTrue(store.preview_path(imported['id']).is_file())
        self.assertEqual(store.preview_path(imported['id'], full=True).parent, self.images)
        self.assertEqual(store.get_style('existing-duplicate')['id'], 'existing-duplicate')
        self.assertTrue(store.preview_path('existing-duplicate', full=True).exists())
        self.run_import(apply=True)
        self.assertEqual([style['id'] for style in store.list_styles()], [style['id'] for style in styles])

    def test_pixel_comparison_ignores_file_metadata_and_encoding(self):
        first, second = self.images / 'first.png', self.images / 'second.png'
        image = Image.new('RGB', (64, 64), 'red')
        image.save(first, compress_level=0)
        metadata = PngInfo()
        metadata.add_text('Comment', 'synthetic different metadata')
        image.convert('RGBA').save(second, compress_level=9, pnginfo=metadata)
        self.assertNotEqual(first.read_bytes(), second.read_bytes())
        self.assertEqual(importer.pixel_hash(first), importer.pixel_hash(second))

    def test_same_recipe_can_hide_a_different_picture_without_deleting_it(self):
        catalog = json.loads((self.catalog / 'default_styles.json').read_text(encoding='utf-8'))
        catalog['styles'][1]['preview'] = {**catalog['styles'][1]['preview'],
                                         'image': 'other.png', 'thumbnail': 'other.png'}
        self.write_json(self.catalog / 'default_styles.json', catalog)
        Image.new('RGB', (64, 128), 'green').save(self.catalog / 'other.png')
        result = self.run_import(apply=True)
        self.assertEqual(result['duplicate_original_pixel_cards'], 0)
        self.assertEqual(result['duplicate_original_recipe_cards'], 1)
        self.assertEqual(result['duplicate_original_cards'], 1)
        store = DakiSharedStyles(self.catalog, self.destination)
        self.assertEqual(store.preview_path('existing-duplicate', full=True), self.catalog / 'other.png')

    def test_large_original_seed_is_preserved_as_metadata(self):
        with sqlite3.connect(self.seed_db) as connection:
            raw = json.loads(connection.execute('SELECT raw_metadata_json FROM arca_style_images WHERE id=102').fetchone()[0])
            raw['seed'] = 8209734110
            connection.execute('UPDATE arca_style_images SET raw_metadata_json=? WHERE id=102', (json.dumps(raw),))
        self.run_import(apply=True)
        imported = next(style for style in DakiSharedStyles(self.catalog, self.destination).list_styles()
                        if style['category'] == 'v5')
        self.assertEqual(imported['seed'], 8209734110)

    def test_incompatible_dimensions_fail_before_destination_write(self):
        with sqlite3.connect(self.seed_db) as connection:
            connection.execute('UPDATE arca_style_images SET width=63 WHERE id=102')
        with self.assertRaisesRegex(ValueError, 'size'):
            self.run_import(apply=True)
        self.assertFalse(self.destination.exists())

    def test_preview_traversal_cannot_import_outside_original_directory(self):
        with sqlite3.connect(self.local_db) as connection:
            connection.execute("UPDATE arca_style_images SET image_path='../outside.png' WHERE id=902")
        with self.assertRaises(ValueError):
            self.run_import(apply=True)
        self.assertFalse(self.destination.exists())

    def test_source_destination_and_missing_database_are_rejected_without_creation(self):
        with self.assertRaises(ValueError):
            importer.import_styles(self.source, self.catalog, self.source / 'output', apply=True)
        missing = self.root / 'missing.sqlite'
        with self.assertRaises(sqlite3.OperationalError):
            importer.read_rows(missing)
        self.assertFalse(missing.exists())


if __name__ == '__main__':
    unittest.main()
