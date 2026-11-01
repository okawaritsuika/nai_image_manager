from copy import deepcopy
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import Mock, patch

from naim.shared_style_recipe import style_duplicate_key
from naim.shared_style_selection import filter_styles, model_family
from naim.storage.shared_library_catalog import SharedLibraryCatalog
from naim.storage.shared_library_store import SharedLibraryStore, _json


class SharedLibraryModelTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.legacy = Mock()
        self.legacy._catalog_root.return_value = None
        self.legacy._imported_root.return_value = None
        self.legacy.list_styles.return_value = []
        self.catalog = SharedLibraryCatalog(
            self.legacy, self.root / 'common.sqlite', self.root, artist_names=frozenset())

    @staticmethod
    def record(model, *, style_id=None, category='v5'):
        return {'id': style_id or model, 'model': model, 'category': category,
                'positive': 'watercolor', 'negative': '', 'preview': {}}

    def write_artist_database(self, models):
        with sqlite3.connect(self.root / 'artist_rater.sqlite') as connection:
            connection.executescript('''
                CREATE TABLE arca_style_items (id INTEGER PRIMARY KEY, title TEXT, source_url TEXT,
                    posted_at TEXT, recommendation_count INTEGER);
                CREATE TABLE arca_style_images (id INTEGER PRIMARY KEY, item_id INTEGER,
                    metadata_status TEXT, model_id TEXT, base_prompt TEXT, negative_prompt TEXT,
                    image_path TEXT, raw_metadata_json TEXT);
                INSERT INTO arca_style_items VALUES (1,'Synthetic','https://example.test',NULL,0);
            ''')
            connection.executemany(
                'INSERT INTO arca_style_images '
                '(id,item_id,metadata_status,model_id,base_prompt,negative_prompt) '
                "VALUES (?,1,'ok',?,'watercolor','')",
                ((index, model) for index, model in enumerate(models, 1)))

    def test_artist_ingestion_restores_all_models_and_adds_family_metadata(self):
        models = ['nai-diffusion-5-full', 'nai-diffusion-4-5-full', 'custom-model-x', '']
        self.write_artist_database(models)

        entries = self.catalog._artist_entries()
        self.assertEqual([entry['record']['model'] for entry in entries],
                         ['nai-diffusion-5-full', 'nai-diffusion-4-5-full', 'custom-model-x', 'unknown'])
        self.assertTrue(all(entry['record']['category'] == 'artist' for entry in entries))
        self.assertTrue(all(entry['record']['source_library'] == 'artist' for entry in entries))
        self.assertEqual([entry['record']['model_family'] for entry in entries],
                         ['v5', 'v4_5', 'other', 'other'])

        listed = self.catalog.list_styles()
        self.assertEqual([record['model'] for record in listed],
                         ['nai-diffusion-5-full', 'nai-diffusion-4-5-full', 'custom-model-x', 'unknown'])
        self.assertEqual([record['model_family'] for record in listed],
                         ['v5', 'v4_5', 'other', 'other'])
        with sqlite3.connect(self.root / 'artist_rater.sqlite') as connection:
            self.assertEqual(connection.execute('SELECT count(*) FROM arca_style_images').fetchone()[0], len(models))

    def test_list_styles_uses_lightweight_origin_map_without_all_sources(self):
        self.write_artist_database(['nai-diffusion-4-5-full'])
        self.catalog.refresh()

        with patch.object(self.catalog.store, 'all_sources', side_effect=AssertionError('full sources loaded')):
            listed = self.catalog.list_styles()

        self.assertEqual([(record['source_library'], record['model_family']) for record in listed],
                         [('artist', 'v4_5')])

    def test_selection_origins_prefers_active_naim_and_falls_back_to_historical(self):
        shared_key = ('shared', 'same-recipe')
        old_key = ('artist', 'v5', 'old-recipe')
        new_key = ('artist', 'v4_5', 'new-recipe')

        def entry(key, origin, source_id, model):
            return {'key': key, 'record': self.record(model), 'origin': origin,
                    'source_id': source_id, 'source': {'origin': origin}}

        self.catalog.store.ingest([
            entry(shared_key, 'artist', 'artist-source', 'nai-diffusion-5-full'),
            entry(shared_key, 'naim', 'legacy-source', 'nai-diffusion-5-full'),
            entry(old_key, 'artist', 'moving-source', 'nai-diffusion-5-full'),
        ])
        old_id = 'common-' + hashlib.sha256(_json(old_key).encode()).hexdigest()[:24]
        self.catalog.store.ingest([entry(new_key, 'artist', 'moving-source', 'nai-diffusion-4-5-full')])

        origins = self.catalog.store.selection_origins()

        self.assertEqual(origins['common-' + hashlib.sha256(_json(shared_key).encode()).hexdigest()[:24]], 'naim')
        self.assertEqual(origins[old_id], 'artist')

    def test_public_sources_keeps_source_order_and_only_one_raw_with_historical_fallback(self):
        mixed_key = ('shared', 'mixed-recipe')
        historical_key = ('artist', 'v5', 'historical-recipe')
        moved_key = ('artist', 'v4_5', 'moved-recipe')

        def entry(key, origin, source_id, model, seed):
            return {'key': key, 'record': {**self.record(model), 'positive': str(key)},
                    'origin': origin, 'source_id': source_id,
                    'source': {'origin': origin, 'marker': source_id},
                    'raw_metadata': {'seed': seed, 'synthetic_payload': 'x' * 100_000}}

        self.catalog.store.ingest([
            entry(mixed_key, 'artist', 'artist-mixed', 'nai-diffusion-5-full', 'artist'),
            entry(mixed_key, 'naim', 'naim-mixed', 'nai-diffusion-5-full', 'naim'),
            entry(historical_key, 'artist', 'artist-historical', 'nai-diffusion-5-full', 'old'),
        ])
        mixed_id = 'common-' + hashlib.sha256(_json(mixed_key).encode()).hexdigest()[:24]
        historical_id = 'common-' + hashlib.sha256(_json(historical_key).encode()).hexdigest()[:24]

        initial = self.catalog.store.public_sources([mixed_id])[mixed_id]
        self.assertEqual([row['origin'] for row in initial], ['naim', 'artist'])
        self.assertEqual([json.loads(row['raw_json']).get('seed') for row in initial], ['naim', None])
        self.assertGreater(len(initial[0]['raw_json']), 80_000)

        self.catalog.store.ingest([
            entry(moved_key, 'artist', 'artist-historical', 'nai-diffusion-4-5-full', 'new'),
            entry(moved_key, 'artist', 'artist-mixed', 'nai-diffusion-4-5-full', 'moved'),
        ])

        self.assertEqual(self.catalog.store.public_sources([]), {})
        selected = self.catalog.store.public_sources([mixed_id, historical_id])
        self.assertEqual([row['origin'] for row in selected[mixed_id]], ['naim'])
        self.assertEqual(json.loads(selected[mixed_id][0]['raw_json'])['seed'], 'naim')
        self.assertEqual([row['origin'] for row in selected[historical_id]], ['artist'])
        self.assertTrue(json.loads(selected[historical_id][0]['source_json'])['_historical'])
        self.assertEqual(json.loads(selected[historical_id][0]['raw_json'])['seed'], 'old')
        self.assertTrue(all(sum(row['raw_json'] != '{}' for row in rows) <= 1
                            for rows in selected.values()))

    def test_public_records_caches_source_rows_and_rechecks_preview_and_external_exclusion(self):
        self.write_artist_database(['nai-diffusion-5-full'])
        image_root = self.root / 'arca_style_images'
        image_root.mkdir()
        preview = image_root / 'preview.synthetic'
        preview.write_bytes(b'synthetic preview')
        with sqlite3.connect(self.root / 'artist_rater.sqlite') as connection:
            connection.execute('''UPDATE arca_style_images SET image_path=?,raw_metadata_json=? WHERE id=1''',
                               ('preview.synthetic', json.dumps({'seed': 17})))

        store = self.catalog.store
        with (
            patch.object(store, 'all_sources', side_effect=AssertionError('full raw sources loaded')),
            patch.object(store, 'list_records', wraps=store.list_records) as list_records,
            patch.object(store, 'public_sources', wraps=store.public_sources) as public_sources,
        ):
            first = self.catalog.public_records()
            style_id = first[0]['id']
            first[0]['sources'][0]['image_id'] = 'caller mutation'
            first[0]['raw_metadata']['seed'] = -1

            second = self.catalog.public_records()
            self.assertEqual(second[0]['sources'][0]['image_id'], 1)
            self.assertEqual(second[0]['raw_metadata']['seed'], 17)
            self.assertTrue(second[0]['available'])

            preview.unlink()
            third = self.catalog.public_records()
            self.assertFalse(third[0]['available'])
            self.assertEqual(list_records.call_count, 1)
            self.assertEqual(public_sources.call_count, 1)

            external_store = SharedLibraryStore(store.path)
            external_store.exclude([style_id])
            self.assertEqual(self.catalog.public_records(), [])
            self.assertEqual(list_records.call_count, 2)
            self.assertEqual(public_sources.call_count, 2)

            included = self.catalog.public_records(include_excluded=True)
            self.assertEqual(len(included), 1)
            self.assertFalse(included[0]['available'])
            self.catalog.public_records(include_excluded=True)
            self.assertEqual(list_records.call_count, 3)
            self.assertEqual(public_sources.call_count, 3)
            self.assertLessEqual(len(self.catalog._public_records_cache), 2)

            self.catalog.remove_styles([style_id])
            self.catalog.public_records(include_excluded=True)
            self.assertEqual(list_records.call_count, 4)
            self.assertEqual(public_sources.call_count, 4)

    def test_artist_same_recipe_deduplicates_within_model_but_splits_between_models(self):
        self.write_artist_database(['nai-diffusion-5-full', 'naid5f', 'nai-diffusion-4-5-full',
                                    'custom-model-x', ' CUSTOM-MODEL-X '])

        entries = self.catalog._artist_entries()
        self.assertEqual(entries[0]['key'], entries[1]['key'])
        self.assertNotEqual(entries[0]['key'], entries[2]['key'])
        listed = self.catalog.list_styles()
        self.assertEqual(len(listed), 3)
        self.assertEqual([record['category'] for record in listed], ['artist', 'artist', 'artist'])
        self.assertEqual([record['model'] for record in listed],
                         ['nai-diffusion-5-full', 'nai-diffusion-4-5-full', 'custom-model-x'])
        sources = self.catalog.store.all_sources()
        self.assertEqual(sorted(len(rows) for rows in sources.values()), [1, 2, 2])

    def test_identical_legacy_and_artist_recipes_are_separate_catalog_records(self):
        legacy_record = self.record('nai-diffusion-5-full', style_id='legacy-id')
        self.legacy.list_styles.side_effect = lambda include_excluded=False: [legacy_record]
        self.legacy.preview_path.side_effect = FileNotFoundError
        self.write_artist_database(['nai-diffusion-5-full'])

        legacy_entries = self.catalog._legacy_entries()
        artist_entries = self.catalog._artist_entries()
        self.assertNotEqual(legacy_entries[0]['key'], artist_entries[0]['key'])
        records = self.catalog.list_styles()
        self.assertEqual(len(records), 2)
        self.assertEqual({record['source_library'] for record in records}, {'naim', 'artist'})
        self.assertEqual({record['category'] for record in records}, {'v5', 'artist'})

    def test_legacy_keeps_v4_5_and_other_models_but_still_excludes_upper(self):
        records = [self.record(model, style_id=str(index), category=category)
                   for index, (model, category) in enumerate((
                       ('nai-diffusion-5-full', 'v5'),
                       ('nai-diffusion-4-5-full', 'v4_5'),
                       ('unknown', 'other'),
                       ('nai-diffusion-5-full', 'upper')))]
        self.legacy.list_styles.side_effect = lambda include_excluded=False: records
        self.legacy.preview_path.side_effect = FileNotFoundError

        self.assertEqual([entry['record']['model'] for entry in self.catalog._legacy_entries()],
                         ['nai-diffusion-5-full', 'nai-diffusion-4-5-full', 'unknown'])

    def test_version_three_invalidates_version_two_cached_scan(self):
        self.write_artist_database(['nai-diffusion-4-5-full'])
        with patch('naim.storage.shared_library_catalog.SOURCE_SCAN_VERSION', 2):
            version_two_signature = self.catalog._current_signature()
        self.catalog.store.save_scan_state(version_two_signature, ['old cached warning'])

        self.catalog.refresh()

        self.assertEqual([record['model'] for record in self.catalog.list_styles()], ['nai-diffusion-4-5-full'])
        state = self.catalog.store.scan_state()
        self.assertNotEqual(state['signature'], version_two_signature)
        self.assertNotEqual(state['warnings'], ['old cached warning'])

    def test_moved_source_keeps_old_common_id_alias_snapshot_and_exclusion(self):
        self.write_artist_database(['nai-diffusion-5-full'])
        scanned = self.catalog._artist_entries()[0]
        old_key = style_duplicate_key('watercolor', artist_names=frozenset())
        old_id = 'common-' + hashlib.sha256(_json(old_key).encode()).hexdigest()[:24]
        alias = scanned['aliases'][0]
        old_image = self.root / 'arca_style_images' / 'synthetic.png'
        old_image.parent.mkdir(parents=True)
        old_image.write_bytes(b'synthetic preview placeholder')
        old_entry = {
            'key': old_key,
            'record': {'id': old_id, 'name': 'saved snapshot', 'model': 'nai-diffusion-5-full',
                       'positive': 'watercolor', 'negative': '', 'category': 'v5'},
            'origin': 'artist', 'source_id': scanned['source_id'], 'aliases': [alias],
            'source': {'origin': 'artist', 'image_id': 1, 'saved_marker': 'original'},
            'raw_metadata': {'base_prompt': 'watercolor', 'seed': 17},
            'image_path': str(old_image), 'thumbnail_path': str(old_image),
        }
        self.catalog.store.ingest([old_entry])
        self.catalog.store.exclude([old_id])

        self.catalog.refresh()

        new_records = self.catalog.list_styles(include_excluded=True)
        self.assertEqual(len(new_records), 2)
        moved = next(record for record in new_records if record['id'] != old_id)
        self.assertNotIn(moved, self.catalog.list_styles())
        self.assertEqual(self.catalog.get_style(old_id)['name'], 'saved snapshot')
        self.assertEqual(self.catalog.get_style(alias)['name'], 'saved snapshot')
        self.assertEqual(self.catalog.get_style(alias)['id'], alias)

        historical = next(source for source in self.catalog.store.sources(old_id)
                          if source['source_id'].endswith('@' + old_id))
        self.assertTrue(json.loads(historical['source_json'])['_historical'])
        self.assertEqual(json.loads(historical['source_json'])['saved_marker'], 'original')
        self.assertEqual(json.loads(historical['raw_json']), old_entry['raw_metadata'])
        self.assertEqual(historical['image_path'], old_entry['image_path'])
        self.assertEqual(historical['thumbnail_path'], old_entry['thumbnail_path'])
        self.assertEqual(self.catalog.preview_path(old_id, full=True), old_image)

        public_by_id = {record['id']: record for record in self.catalog.public_records(include_excluded=True)}
        self.assertEqual(public_by_id[old_id]['sources'][0]['saved_marker'], 'original')
        self.assertEqual(public_by_id[old_id]['raw_metadata']['seed'], 17)
        self.assertIn('image_id', public_by_id[moved['id']]['sources'][0])
        self.assertNotIn('saved_marker', public_by_id[moved['id']]['sources'][0])
        self.assertNotIn('seed', public_by_id[moved['id']]['raw_metadata'])
        with closing(self.catalog.store.connect()) as connection:
            exclusion = connection.execute('SELECT excluded,excluded_by_user FROM shared_recipes WHERE id=?',
                                            (moved['id'],)).fetchone()
        self.assertEqual(tuple(exclusion), (1, 1))

    def test_model_family_recognizes_known_v5_and_v4_5_names_with_boundaries(self):
        cases = {
            'nai-diffusion-5-full-medium': 'v5',
            'naid5f': 'v5',
            'NovelAI Diffusion V5': 'v5',
            'V5 full': 'v5',
            'nai-diffusion-4-5-curated': 'v4_5',
            'NovelAI Diffusion V4.5 full': 'v4_5',
            'V4.5': 'v4_5',
            'nai-diffusion-50-full': 'other',
            'ModelV5': 'other',
            '': 'other',
        }
        for value, expected in cases.items():
            with self.subTest(value=value):
                self.assertEqual(model_family(value), expected)

    def test_filter_styles_validates_values_filters_and_does_not_mutate(self):
        styles = [
            {'id': 'legacy-v45', 'model': 'nai-diffusion-4-5-full'},
            {'id': 'artist-other', 'source_library': 'artist', 'model': 'custom-model'},
            {'id': 'artist-v5', 'source_library': 'artist', 'model_family': 'v5', 'model': 'unknown'},
            {'id': 'personal-v5', 'source_library': 'personal', 'model': 'V5 full'},
        ]
        original = deepcopy(styles)

        self.assertEqual([style['id'] for style in filter_styles(styles, source='naim')], ['legacy-v45'])
        self.assertEqual([style['id'] for style in filter_styles(styles, source='personal')], ['personal-v5'])
        self.assertEqual([style['id'] for style in filter_styles(styles, source='artist', model='other')],
                         ['artist-other'])
        self.assertEqual([style['id'] for style in filter_styles(styles, model='v5')],
                         ['artist-v5', 'personal-v5'])
        self.assertEqual(filter_styles([], source='artist', model='v4_5'), [])
        self.assertEqual(styles, original)

        for invalid_source in ('NAIM', 'shared'):
            with self.subTest(source=invalid_source), self.assertRaisesRegex(ValueError, '출처'):
                filter_styles(styles, source=invalid_source)
        for invalid_model in ('v45', 'all-models'):
            with self.subTest(model=invalid_model), self.assertRaisesRegex(ValueError, '모델'):
                filter_styles(styles, model=invalid_model)


if __name__ == '__main__':
    unittest.main()
