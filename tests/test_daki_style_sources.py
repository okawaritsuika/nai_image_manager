import json
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

from naim.storage.daki_style_sources import DakiStyleSources, source_metadata, source_url
from tools.import_daki_source_posts import import_source_posts


class DakiStyleSourceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.imported = self.root / 'imported'
        self.imported.mkdir()
        self.path = self.imported / 'source_posts.json'
        self.url = 'https://arca.live/b/aiart/123'
        self.store = DakiStyleSources(lambda: self.imported)

    def save(self, count=12):
        self.path.write_text(json.dumps({'version': 1, 'posts': {self.url: {
            'recommendation_count': count, 'recommendation_collected_at': '2026-01-02T03:04:05Z'}}}), encoding='utf-8')

    def test_only_article_urls_are_normalized_and_unsafe_urls_are_rejected(self):
        self.assertEqual(source_url(' http://arca.live/b/aiart/123/?p=2#reply '), self.url)
        for value in (None, {}, '', 'javascript:alert(1)', 'https://arca.live.evil/b/aiart/123',
                      'https://name@arca.live/b/aiart/123', 'https://arca.live:443/b/aiart/123',
                      'https://arca.live/b/aiart', 'https://arca.live/b/aiart/123/else',
                      'https://arca.live/b/../123', 'https://arca.live/b/aiart/123\n'):
            with self.subTest(value=value):
                self.assertIsNone(source_url(value))

    def test_zero_and_missing_are_distinct_and_snapshot_takes_precedence(self):
        self.save()
        stored = {'source_url': self.url, 'recommendation_count': 0,
                  'recommendation_collected_at': '2025-01-02'}
        self.assertEqual(self.store.metadata(stored), stored)
        self.assertEqual(self.store.metadata({'source_url': self.url})['recommendation_count'], 12)
        for count in (True, False, -1, '12', 1.5):
            self.assertIsNone(source_metadata({'source_url': self.url, 'recommendation_count': count})['recommendation_count'])
        self.assertIsNone(source_metadata({'source_url': 'https://example.invalid', 'recommendation_count': 12})['recommendation_count'])

    def test_missing_deleted_or_bad_optional_metadata_does_not_block_existing_recipes(self):
        self.assertIsNone(self.store.metadata({'source_url': self.url})['recommendation_count'])
        self.save()
        self.assertEqual(self.store.metadata({'source_url': self.url})['recommendation_count'], 12)
        self.save(900)
        self.assertEqual(self.store.metadata({'source_url': self.url})['recommendation_count'], 900)
        self.path.write_text('{bad', encoding='utf-8')
        self.assertIsNone(self.store.metadata({'source_url': self.url})['recommendation_count'])
        self.assertEqual(self.path.read_text(encoding='utf-8'), '{bad')
        self.path.unlink()
        self.assertIsNone(self.store.metadata({'source_url': self.url})['recommendation_count'])

    def test_inaccessible_optional_metadata_keeps_link_and_unknown_count(self):
        for method in ('resolve', 'stat'):
            with self.subTest(method=method), mock.patch.object(Path, method, side_effect=PermissionError('synthetic')):
                result = self.store.metadata({'source_url': self.url})
                self.assertEqual(result['source_url'], self.url)
                self.assertIsNone(result['recommendation_count'])

    def test_batch_metadata_reads_source_once_for_many_saved_styles(self):
        self.save()
        with mock.patch.object(self.store, '_load', wraps=self.store._load) as load:
            results = self.store.metadata_many([{'source_url': self.url}] * 400)
        self.assertEqual(len(results), 400)
        self.assertTrue(all(row['recommendation_count'] == 12 for row in results))
        load.assert_called_once()

    def prepare_import(self):
        catalog = self.root / 'source-catalog'
        catalog.mkdir()
        (catalog / 'default_styles.json').write_text(json.dumps({'styles': [
            {'source_url': self.url}, {'source_url': 'http://arca.live/b/aiart/124?view=1'},
            {'source_url': 'https://arca.live/b/aiart/125'}, {'source_url': 'https://example.invalid'}]}), encoding='utf-8')
        database = self.root / 'source.sqlite'
        with closing(sqlite3.connect(database)) as connection:
            connection.execute('CREATE TABLE arca_style_items (source_url TEXT,recommendation_count INTEGER,updated_at TEXT,collected_at TEXT)')
            connection.executemany('INSERT INTO arca_style_items VALUES(?,?,?,?)', [
                (self.url, 0, '2026-01-02', '2026-01-01'),
                ('https://arca.live/b/aiart/124', None, '', '2026-01-01'),
                ('https://arca.live/b/aiart/999', 999, '2026-01-02', '2026-01-01')])
            connection.commit()
        return database, catalog

    def test_import_reads_only_collected_metadata_and_preserves_sources_and_old_posts(self):
        database, catalog = self.prepare_import()
        before = database.read_bytes()
        original = (catalog / 'default_styles.json').read_bytes()
        dry = import_source_posts(database, catalog, self.imported)
        self.assertFalse(self.path.exists())
        self.assertEqual((dry['catalog_posts'], dry['matched_posts'], dry['known_counts'], dry['missing_posts']), (3, 2, 1, 1))
        self.path.write_text(json.dumps({'version': 1, 'posts': {'https://arca.live/b/aiart/777': {'recommendation_count': 7}}}), encoding='utf-8')
        result = import_source_posts(database, catalog, self.imported, apply=True)
        self.assertEqual(result['retained_posts'], 3)
        rows = json.loads(self.path.read_text(encoding='utf-8'))['posts']
        self.assertEqual(rows[self.url]['recommendation_count'], 0)
        self.assertEqual(rows[self.url]['recommendation_collected_at'], '2026-01-02')
        self.assertIsNone(rows['https://arca.live/b/aiart/124']['recommendation_count'])
        self.assertNotIn('https://arca.live/b/aiart/999', rows)
        self.assertEqual(database.read_bytes(), before)
        self.assertEqual((catalog / 'default_styles.json').read_bytes(), original)

    def test_failed_atomic_replace_keeps_existing_metadata_and_database(self):
        database, catalog = self.prepare_import()
        self.save()
        before, database_before = self.path.read_bytes(), database.read_bytes()
        with mock.patch('naim.storage.json_files.os.replace', side_effect=OSError('synthetic failure')):
            with self.assertRaises(OSError):
                import_source_posts(database, catalog, self.imported, apply=True)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(database.read_bytes(), database_before)

    def test_source_catalog_cannot_be_destination_and_missing_database_is_not_created(self):
        database, catalog = self.prepare_import()
        with self.assertRaises(ValueError):
            import_source_posts(database, catalog, catalog, apply=True)
        missing = self.root / 'missing.sqlite'
        with self.assertRaises(sqlite3.OperationalError):
            import_source_posts(missing, catalog, self.imported, apply=True)
        self.assertFalse(missing.exists())
