from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from naim.storage.daki_projects import DakiNotFoundError
from naim.storage.daki_shared_styles import DakiSharedStyles, excluded_style


_NO_ACTIVE_STYLE_IDS = object()


class DakiSharedStylesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.catalog = self.root / 'catalog'
        self.catalog.mkdir()
        self.style = {
            'id': 'shared-one', 'name': 'Synthetic style', 'model': 'nai-diffusion-5-full',
            'positive': 'watercolor', 'negative': 'photorealistic, lowres',
            'source_image_id': 1, 'source_url': 'https://example.test/style',
            'preview': {'width': 1024, 'height': 1024, 'image': 'images/one.png',
                        'thumbnail': 'thumbs/one.webp', 'job_id': 'preview-one'},
        }
        self.options = {'steps': 14, 'cfg': 4.5, 'cfg_rescale': 0, 'noise': 0,
                        'sampler': 'k_euler_ancestral', 'noise_schedule': 'native',
                        'prefer_brownian': False, 'deliberate_euler_ancestral_bug': False}
        self.styles = [self.style]
        self.sources = {'shared-one': {'source_image_id': 1, 'options': self.options}}
        self.jobs = {'preview-one': {'seed': 1234, 'status': 'success'}}
        self.save()
        for key in ('image', 'thumbnail'):
            path = self.catalog / self.style['preview'][key]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'synthetic image fixture')
        self.store = DakiSharedStyles(lambda: self.catalog)

    def save(self):
        for name, value in (
            ('default_styles.json', {'styles': self.styles}),
            ('source_generation_options.json', {'styles': self.sources}),
            ('generation_manifest.json', {'jobs': self.jobs}),
        ):
            (self.catalog / name).write_text(json.dumps(value), encoding='utf-8')

    def test_positive_only_filter_matches_case_and_weighting_without_substrings(self):
        for positive in ('Photorealistic', '1.2::REALISTIC::', 'semi-realistic'):
            self.assertTrue(excluded_style(positive))
        for positive in ('watercolor', 'unrealistic', 'nonrealistic'):
            self.assertFalse(excluded_style(positive))
        blocked = deepcopy(self.style)
        blocked.update(id='excluded', positive='1.2::photorealistic::')
        self.styles.append(blocked)
        self.save()
        self.assertEqual([style['id'] for style in self.store.list_styles()], ['shared-one'])
        for function in (self.store.get_style, self.store.preview_path):
            with self.assertRaises(DakiNotFoundError):
                function('excluded')

    def test_public_records_preserve_original_settings_seed_and_dimensions_without_paths(self):
        record = self.store.get_style('shared-one')
        self.assertEqual(record['options'], self.options)
        self.assertIs(record['options']['prefer_brownian'], False)
        self.assertEqual(record['options']['cfg_rescale'], 0)
        self.assertEqual(record['seed'], 1234)
        self.assertEqual(record['preview'], {'width': 1024, 'height': 1024})
        self.assertEqual(set(record), {'id', 'name', 'model', 'positive', 'negative', 'options',
                                       'seed', 'preview', 'source_image_id', 'source_url', 'category',
                                       'recommendation_count', 'recommendation_collected_at', 'sort_date'})
        self.assertEqual(record['category'], 'upper')
        record['options']['cfg'] = 9
        record['preview']['width'] = 64
        listed = self.store.list_styles()
        listed[0]['positive'] = 'modified'
        self.assertEqual(self.store.get_style('shared-one')['options'], self.options)
        self.assertEqual(self.store.get_style('shared-one')['preview']['width'], 1024)
        self.assertEqual(self.store.get_style('shared-one')['positive'], 'watercolor')

    def test_upper_test_source_uses_visible_raw_upper_recipe_and_exact_success_payload(self):
        payload = {
            'input': 'watercolor, original scene', 'model': 'nai-diffusion-5-full',
            'action': 'generate', 'parameters': {
                'width': 1024, 'height': 1024, 'steps': 14, 'seed': 1234,
                'v4_prompt': {'caption': {'char_captions': [{'char_caption': 'synthetic character'}]}},
                'v4_negative_prompt': {'caption': {'char_captions': [
                    {'char_caption': 'synthetic character negative'}]}},
            },
        }
        self.jobs['preview-one'].update(
            payload=payload,
            job={'data': {'base_prompt': 'watercolor, original scene',
                          'negative_prompt': 'photorealistic, lowres, original common negative'}},
        )
        self.save()

        result = self.store.upper_test_source()

        self.assertEqual(result['request'], {
            'model': 'nai-diffusion-5-full', 'width': 1024, 'height': 1024,
            'prompt': 'original scene', 'negative_prompt': 'original common negative',
            'char_prompts': [{'prompt': 'synthetic character',
                              'negative_prompt': 'synthetic character negative'}],
            'output_format': 'webp',
        })
        self.assertEqual(len(result['entries']), 1)
        self.assertEqual(result['entries'][0]['style']['options'], self.options)
        self.assertEqual(result['entries'][0]['payload'], payload)
        self.assertEqual(result['entries'][0]['output_format'], 'png')

    def test_upper_test_source_rejects_missing_success_payload_without_writing_source(self):
        self.jobs['preview-one']['job'] = {'data': {'base_prompt': 'watercolor, scene',
                                                    'negative_prompt': 'photorealistic, lowres, scene'}}
        self.save()
        before = {name: (self.catalog / name).read_bytes() for name in (
            'default_styles.json', 'source_generation_options.json', 'generation_manifest.json')}

        with self.assertRaisesRegex(ValueError, '생성 요청'):
            self.store.upper_test_source()

        self.assertEqual({name: (self.catalog / name).read_bytes() for name in before}, before)

    def test_sort_dates_resolve_old_snapshots_and_excluded_styles_without_writes(self):
        self.style['source_posted_at'] = '2026-01-02T03:04:05Z'
        self.save()
        before = (self.catalog / 'default_styles.json').read_bytes()
        snapshot = {'id': 'shared-one'}
        self.assertEqual(self.store.sort_dates_many([snapshot]), ['2026-01-02T03:04:05+00:00'])
        self.assertEqual(snapshot, {'id': 'shared-one'})
        self.assertEqual((self.catalog / 'default_styles.json').read_bytes(), before)
        self.assertEqual(self.store.list_styles()[0]['sort_date'], '2026-01-02T03:04:05+00:00')
        self.assertIsNone(self.store.sort_dates_many([{'id': 'missing'}])[0])

    def test_legacy_sort_date_uses_original_image_creation_not_thumbnail(self):
        from datetime import datetime, timezone
        original = self.catalog / self.style['preview']['image']
        stat = original.stat()
        stamp = getattr(stat, 'st_birthtime', stat.st_ctime)
        self.assertEqual(self.store.get_style('shared-one')['sort_date'],
                         datetime.fromtimestamp(stamp, timezone.utc).isoformat())

    def test_source_counts_refresh_without_changing_recipes_or_excluded_style_access(self):
        imported = self.root / 'imported'
        imported.mkdir()
        self.style['source_url'] = 'http://arca.live/b/aiart/123?source=1'
        self.save()
        store = DakiSharedStyles(self.catalog, imported)
        before = (self.catalog / 'default_styles.json').read_bytes()
        path = imported / 'source_posts.json'
        path.write_text(json.dumps({'version': 1, 'posts': {'https://arca.live/b/aiart/123': {
            'recommendation_count': 42, 'recommendation_collected_at': '2026-01-01'}}}), encoding='utf-8')
        self.assertEqual(store.list_styles()[0]['recommendation_count'], 42)
        self.assertEqual(store.get_style('shared-one')['source_url'], 'https://arca.live/b/aiart/123')
        store.remove_styles(['shared-one'])
        self.assertEqual(store.list_styles(), [])
        self.assertEqual(store.get_style('shared-one')['recommendation_count'], 42)
        path.write_text(json.dumps({'version': 1, 'posts': {'https://arca.live/b/aiart/123': {
            'recommendation_count': 120}}}), encoding='utf-8')
        self.assertEqual(store.get_style('shared-one')['recommendation_count'], 120)
        self.assertEqual((self.catalog / 'default_styles.json').read_bytes(), before)

    def test_cache_reuses_reads_and_refreshes_options_manifest_and_catalog(self):
        with mock.patch.object(self.store, '_read', wraps=self.store._read) as read:
            self.store.list_styles()
            self.store.get_style('shared-one')
            self.store.preview_path('shared-one')
            self.assertEqual(read.call_count, 3)
            self.options['steps'] = 29
            self.jobs['preview-one']['seed'] = 98765
            self.style['name'] = 'Changed synthetic style'
            self.save()
            updated = self.store.get_style('shared-one')
            self.assertEqual(read.call_count, 6)
        self.assertEqual(updated['options']['steps'], 29)
        self.assertEqual(updated['seed'], 98765)
        self.assertEqual(updated['name'], 'Changed synthetic style')

    def test_preview_paths_resolve_only_known_images_and_missing_images_fail(self):
        self.assertEqual(self.store.preview_path('shared-one'), (self.catalog / 'thumbs/one.webp').resolve())
        full = self.store.preview_path('shared-one', full=True)
        self.assertEqual(full, (self.catalog / 'images/one.png').resolve())
        full.unlink()
        with self.assertRaises(FileNotFoundError):
            self.store.preview_path('shared-one', full=True)
        for invalid in ('../outside.png', '', None, []):
            with self.subTest(invalid=invalid), self.assertRaises(DakiNotFoundError):
                self.store.get_style(invalid)

    def test_unsafe_preview_paths_are_rejected_before_any_are_served(self):
        for invalid in ('../outside.png', '/outside.png', 'C:/outside.png',
                        '..\\outside.png', 'images/data.json', 'images/bad\x00.png'):
            self.style['preview']['image'] = invalid
            self.save()
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.store.list_styles()

    def test_cached_preview_resolves_target_again_before_serving(self):
        self.store.list_styles()
        original = Path.resolve
        outside = self.root / 'outside.webp'

        def redirected(path, *args, **kwargs):
            if path.name == 'one.webp':
                return outside
            return original(path, *args, **kwargs)

        with mock.patch.object(Path, 'resolve', redirected), self.assertRaises(ValueError):
            self.store.preview_path('shared-one')

    def test_source_mismatch_or_missing_seed_never_silently_changes_generation(self):
        self.sources['shared-one']['source_image_id'] = 2
        self.save()
        with self.assertRaisesRegex(ValueError, '원본 이미지'):
            self.store.list_styles()
        self.sources['shared-one']['source_image_id'] = 1
        self.jobs['preview-one'].pop('seed')
        self.save()
        with self.assertRaisesRegex(ValueError, '시드'):
            self.store.list_styles()

    def test_missing_catalog_is_read_only_and_error_does_not_expose_path(self):
        missing = self.root / 'not-created'
        with self.assertRaises(FileNotFoundError) as caught:
            DakiSharedStyles(missing).list_styles()
        self.assertNotIn(str(missing), str(caught.exception))
        self.assertFalse(missing.exists())

    def test_provider_change_invalidates_cached_records(self):
        self.store.list_styles()
        self.store.catalog_root_provider = lambda: self.root / 'missing'
        with self.assertRaises(FileNotFoundError):
            self.store.list_styles()

    def imported_catalog(self):
        imported = self.root / 'imported'
        originals = self.root / 'original-images'
        imported.mkdir()
        originals.mkdir()
        style = {
            'id': 'import-v5-new', 'name': 'Synthetic V5', 'model': 'NovelAI Diffusion V5',
            'positive': 'ink', 'negative': 'realistic', 'seed': 8209734110,
            'options': deepcopy(self.options), 'source_image_id': 42,
            'source_url': 'https://example.test/new',
            'preview': {'width': 832, 'height': 1216, 'image': 'original.webp',
                        'thumbnail': 'thumb.webp'},
        }
        manifest = {'styles': [style], 'source_image_root': str(originals), 'hidden_style_ids': []}
        (originals / 'original.webp').write_bytes(b'original fixture')
        (imported / 'thumb.webp').write_bytes(b'thumbnail fixture')
        (imported / 'catalog.json').write_text(json.dumps(manifest), encoding='utf-8')
        return imported, originals, manifest

    def synced_style(self, style_id='import-v5-sync', **updates):
        style = {
            'id': style_id, 'name': 'Synthetic synced V5', 'model': 'NovelAI Diffusion V5',
            'positive': 'ink', 'negative': 'lowres', 'seed': 2345,
            'options': deepcopy(self.options), 'source_image_id': 51,
            'source_url': 'https://example.test/synced',
            'preview': {'width': 832, 'height': 1216,
                        'image': f'sync/images/{style_id}.png',
                        'thumbnail': f'sync/thumbs/{style_id}.webp'},
        }
        style.update(updates)
        return style

    def write_sync_catalog(self, imported, styles, active_style_ids=_NO_ACTIVE_STYLE_IDS):
        for style in styles:
            for key in ('image', 'thumbnail'):
                path = imported / style['preview'][key]
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'synthetic sync image fixture')
        manifest = {'version': 1, 'source_image_root': '.', 'styles': styles}
        if active_style_ids is not _NO_ACTIVE_STYLE_IDS:
            manifest['active_style_ids'] = active_style_ids
        (imported / 'sync_catalog.json').write_text(json.dumps(manifest), encoding='utf-8')
        return manifest

    def test_active_snapshot_hides_inactive_v5_but_preserves_upper_and_old_references(self):
        imported, _, _ = self.imported_catalog()
        inactive_sync = self.synced_style('import-v5-old-sync')
        active_sync = self.synced_style('import-v5-active')
        self.write_sync_catalog(imported, [inactive_sync, active_sync], ['import-v5-active'])
        store = DakiSharedStyles(self.catalog, imported)

        self.assertEqual([style['id'] for style in store.list_styles()],
                         ['shared-one', 'import-v5-active'])
        for old_id in ('import-v5-new', 'import-v5-old-sync'):
            self.assertEqual(store.get_style(old_id)['id'], old_id)
            self.assertTrue(store.preview_path(old_id, full=True).is_file())
        self.assertEqual(store.get_style('shared-one')['category'], 'upper')

    def test_active_sync_style_overrides_matching_imported_v5_record(self):
        imported, _, _ = self.imported_catalog()
        old_catalog_bytes = (imported / 'catalog.json').read_bytes()
        updated = self.synced_style('import-v5-new', name='Updated by synthetic snapshot')
        self.write_sync_catalog(imported, [updated], ['import-v5-new'])
        store = DakiSharedStyles(self.catalog, imported)

        record = store.get_style('import-v5-new')
        self.assertEqual(record['name'], 'Updated by synthetic snapshot')
        self.assertEqual(record['source_image_id'], 51)
        self.assertEqual(store.preview_path('import-v5-new', full=True),
                         (imported / updated['preview']['image']).resolve())
        self.assertEqual((imported / 'catalog.json').read_bytes(), old_catalog_bytes)

    def test_active_sync_cannot_override_upper_and_rejects_duplicates_in_its_file(self):
        imported, _, _ = self.imported_catalog()
        upper_collision = self.synced_style('shared-one')
        self.write_sync_catalog(imported, [upper_collision], ['shared-one'])
        with self.assertRaises(ValueError):
            DakiSharedStyles(self.catalog, imported).list_styles()

        duplicate = self.synced_style('duplicate-sync-id')
        self.write_sync_catalog(imported, [duplicate, deepcopy(duplicate)], ['duplicate-sync-id'])
        with self.assertRaises(ValueError):
            DakiSharedStyles(self.catalog, imported).list_styles()

    def test_active_style_ids_are_validated_against_unique_sync_records(self):
        imported, _, _ = self.imported_catalog()
        style = self.synced_style('valid-sync-id')
        invalid_values = (None, 'valid-sync-id', [''], ['x' * 129],
                          ['valid-sync-id', 'valid-sync-id'], ['unknown-sync-id'])
        for active_ids in invalid_values:
            with self.subTest(active_ids=active_ids):
                self.write_sync_catalog(imported, [style], active_ids)
                with self.assertRaises(ValueError):
                    DakiSharedStyles(self.catalog, imported).list_styles()

    def test_empty_active_snapshot_hides_all_v5_but_keeps_records_available(self):
        imported, _, _ = self.imported_catalog()
        style = self.synced_style('inactive-sync-id')
        self.write_sync_catalog(imported, [style], [])
        store = DakiSharedStyles(self.catalog, imported)

        self.assertEqual([record['id'] for record in store.list_styles()], ['shared-one'])
        self.assertEqual({record['id'] for record in store.list_styles(include_excluded=True)},
                         {'shared-one', 'import-v5-new', 'inactive-sync-id'})
        self.assertEqual(store.get_style('inactive-sync-id')['id'], 'inactive-sync-id')
        self.assertTrue(store.preview_path('inactive-sync-id', full=True).is_file())

    def test_synced_realism_flag_is_opt_in_validated_and_not_public(self):
        imported = self.root / 'imported'
        imported.mkdir()
        included = self.synced_style('realistic-included', positive='photorealistic',
                                     allow_realistic=True)
        excluded = self.synced_style('realistic-excluded', positive='realistic')
        explicit_false = self.synced_style('realistic-explicit-false', positive='realistic',
                                           allow_realistic=False)
        self.write_sync_catalog(imported, [included, excluded, explicit_false])
        store = DakiSharedStyles(self.catalog, imported)

        self.assertEqual([record['id'] for record in store.list_styles()],
                         ['shared-one', 'realistic-included'])
        self.assertNotIn('allow_realistic', store.get_style('realistic-included'))
        self.assertEqual(store.get_style('realistic-included')['positive'], 'photorealistic')
        self.assertNotIn('allow_realistic', store.list_styles()[1])
        with self.assertRaises(DakiNotFoundError):
            store.get_style('realistic-excluded')
        with self.assertRaises(DakiNotFoundError):
            store.get_style('realistic-explicit-false')

        invalid = self.synced_style('bad-realism-flag', allow_realistic=1)
        self.write_sync_catalog(imported, [invalid])
        with self.assertRaises(ValueError):
            store.list_styles()

    def test_manual_exclusion_survives_active_sync_override(self):
        imported, _, _ = self.imported_catalog()
        store = DakiSharedStyles(self.catalog, imported)
        store.remove_styles(['import-v5-new'])
        updated = self.synced_style('import-v5-new', name='Updated but still excluded')
        self.write_sync_catalog(imported, [updated], ['import-v5-new'])

        self.assertEqual([record['id'] for record in store.list_styles()], ['shared-one'])
        self.assertEqual(store.get_style('import-v5-new')['name'], 'Updated but still excluded')

    def test_cache_refreshes_after_active_sync_snapshot_changes(self):
        imported = self.root / 'imported'
        imported.mkdir()
        first = self.synced_style('first-active', name='First snapshot')
        self.write_sync_catalog(imported, [first], ['first-active'])
        store = DakiSharedStyles(self.catalog, imported)
        self.assertEqual([record['id'] for record in store.list_styles()], ['shared-one', 'first-active'])

        second = self.synced_style('second-active', name='Second snapshot with different file size')
        self.write_sync_catalog(imported, [first, second], ['second-active'])
        self.assertEqual([record['id'] for record in store.list_styles()], ['shared-one', 'second-active'])
        self.assertEqual(store.get_style('first-active')['id'], 'first-active')

    def test_imported_sources_keep_separate_original_and_thumbnail_roots(self):
        imported, originals, _ = self.imported_catalog()
        store = DakiSharedStyles(self.catalog, lambda: imported)
        self.assertEqual([s['category'] for s in store.list_styles()], ['upper', 'v5'])
        self.assertEqual(store.preview_path('import-v5-new'), imported / 'thumb.webp')
        self.assertEqual(store.preview_path('import-v5-new', full=True), originals / 'original.webp')
        record = store.get_style('import-v5-new')
        self.assertEqual(record['seed'], 8209734110)
        self.assertEqual(record['options'], self.options)
        self.assertNotIn(str(originals), json.dumps(record))

    def test_hidden_duplicate_keeps_its_old_id_and_preview_for_saved_tests(self):
        imported, _, manifest = self.imported_catalog()
        manifest['hidden_style_ids'] = ['shared-one']
        (imported / 'catalog.json').write_text(json.dumps(manifest), encoding='utf-8')
        store = DakiSharedStyles(self.catalog, imported)
        self.assertEqual([s['id'] for s in store.list_styles()], ['import-v5-new'])
        self.assertEqual(store.get_style('shared-one')['id'], 'shared-one')
        self.assertTrue(store.preview_path('shared-one', full=True).is_file())

    def test_imported_optional_missing_manifest_is_read_only_and_later_appears(self):
        imported = self.root / 'imported'
        store = DakiSharedStyles(self.catalog, lambda: imported)
        self.assertEqual(len(store.list_styles()), 1)
        self.assertFalse(imported.exists())
        self.imported_catalog()
        self.assertEqual(len(store.list_styles()), 2)

    def test_imported_preview_traversal_and_invalid_generation_data_are_rejected(self):
        imported, _, manifest = self.imported_catalog()
        store = DakiSharedStyles(self.catalog, imported)
        for value in ('../outside.webp', '/outside.webp', 'C:/outside.webp'):
            manifest['styles'][0]['preview']['image'] = value
            (imported / 'catalog.json').write_text(json.dumps(manifest), encoding='utf-8')
            with self.subTest(value=value), self.assertRaises(ValueError):
                store.list_styles()
        manifest['styles'][0]['preview']['image'] = 'original.webp'
        manifest['styles'][0]['seed'] = True
        (imported / 'catalog.json').write_text(json.dumps(manifest), encoding='utf-8')
        with self.assertRaises(ValueError):
            store.list_styles()

    def test_imported_realistic_positive_is_filtered_but_negative_is_preserved(self):
        imported, _, manifest = self.imported_catalog()
        store = DakiSharedStyles(self.catalog, imported)
        self.assertEqual(store.get_style('import-v5-new')['negative'], 'realistic')
        manifest['styles'][0]['positive'] = 'Photorealistic'
        (imported / 'catalog.json').write_text(json.dumps(manifest), encoding='utf-8')
        self.assertEqual(len(store.list_styles()), 1)
        with self.assertRaises(DakiNotFoundError):
            store.get_style('import-v5-new')

    def test_remove_only_excludes_list_and_survives_new_store_and_manifest_reimport(self):
        imported, originals, manifest = self.imported_catalog()
        store = DakiSharedStyles(self.catalog, imported)
        original_bytes = (originals / 'original.webp').read_bytes()
        manifest_bytes = (imported / 'catalog.json').read_bytes()
        self.assertEqual(store.remove_styles(['shared-one', 'import-v5-new', 'shared-one']), 2)
        self.assertEqual(store.list_styles(), [])
        self.assertEqual(store.remove_styles(['import-v5-new']), 0)
        self.assertEqual((originals / 'original.webp').read_bytes(), original_bytes)
        self.assertEqual((imported / 'catalog.json').read_bytes(), manifest_bytes)
        for sid in ('shared-one', 'import-v5-new'):
            self.assertEqual(store.get_style(sid)['id'], sid)
            self.assertTrue(store.preview_path(sid, full=True).exists())
        manifest['styles'][0]['name'] = 'Reimported synthetic title'
        (imported / 'catalog.json').write_text(json.dumps(manifest), encoding='utf-8')
        restored = DakiSharedStyles(self.catalog, imported)
        self.assertEqual(restored.list_styles(), [])
        self.assertEqual(restored.get_style('import-v5-new')['name'], 'Reimported synthetic title')

    def test_remove_is_available_without_an_import_manifest_and_does_not_modify_source(self):
        imported = self.root / 'new-local-data'
        store = DakiSharedStyles(self.catalog, imported)
        source_bytes = (self.catalog / 'default_styles.json').read_bytes()
        self.assertEqual(store.remove_styles(['shared-one']), 1)
        self.assertFalse((imported / 'catalog.json').exists())
        self.assertEqual((self.catalog / 'default_styles.json').read_bytes(), source_bytes)
        self.assertEqual(DakiSharedStyles(self.catalog, imported).list_styles(), [])

    def test_remove_validates_the_entire_request_before_any_write(self):
        imported, _, _ = self.imported_catalog()
        store = DakiSharedStyles(self.catalog, imported)
        for invalid in (None, 'shared-one', {}, [], ['shared-one', None], [''], ['x' * 129], ['shared-one'] * 10001):
            with self.subTest(invalid_type=type(invalid).__name__), self.assertRaises(ValueError):
                store.remove_styles(invalid)
            self.assertFalse((imported / 'excluded_styles.json').exists())
        with self.assertRaises(DakiNotFoundError):
            store.remove_styles(['shared-one', 'unknown'])
        self.assertFalse((imported / 'excluded_styles.json').exists())
        self.assertEqual(len(store.list_styles()), 2)

    def test_remove_atomic_failure_preserves_previous_exclusions_and_visible_styles(self):
        imported, _, _ = self.imported_catalog()
        store = DakiSharedStyles(self.catalog, imported)
        store.remove_styles(['shared-one'])
        path = imported / 'excluded_styles.json'
        before = path.read_bytes()
        with mock.patch('naim.storage.json_files.os.replace', side_effect=OSError('synthetic failure')):
            with self.assertRaises(OSError):
                store.remove_styles(['import-v5-new'])
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual([s['id'] for s in store.list_styles()], ['import-v5-new'])
        self.assertFalse(list(imported.glob('*.tmp')))

    def test_remove_from_independent_store_instances_merges_exclusions(self):
        imported, _, _ = self.imported_catalog()
        stores = [DakiSharedStyles(self.catalog, imported) for _ in range(2)]
        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(stores[0].remove_styles, ['shared-one'])
            second = executor.submit(stores[1].remove_styles, ['import-v5-new'])
            self.assertEqual((first.result(), second.result()), (1, 1))
        self.assertEqual(stores[0].list_styles(), [])
        self.assertEqual(stores[1].list_styles(), [])

    def test_malformed_exclusions_are_not_silently_reset_or_overwritten(self):
        imported, _, _ = self.imported_catalog()
        store = DakiSharedStyles(self.catalog, imported)
        path = imported / 'excluded_styles.json'
        path.write_text('{broken', encoding='utf-8')
        for function in (store.list_styles, lambda: store.remove_styles(['shared-one'])):
            with self.assertRaises(ValueError):
                function()
        self.assertEqual(path.read_text(encoding='utf-8'), '{broken')

    def test_exclusion_destination_cannot_redirect_outside_local_data(self):
        imported, _, _ = self.imported_catalog()
        store = DakiSharedStyles(self.catalog, imported)
        original_resolve = Path.resolve
        outside = self.root / 'outside.json'
        def redirected(path, *args, **kwargs):
            return outside if path.name == 'excluded_styles.json' else original_resolve(path, *args, **kwargs)
        with mock.patch.object(Path, 'resolve', redirected), self.assertRaises(ValueError):
            store.remove_styles(['shared-one'])
        self.assertFalse(outside.exists())


if __name__ == '__main__':
    unittest.main()
