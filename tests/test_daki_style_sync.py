import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock
import zipfile

from flask import Flask
from PIL import Image, PngImagePlugin

from naim.daki_style_sync import DakiStyleSync
from naim.arca_shared_styles import ArcaSharedClient, ArcaSharedError
from naim.storage.daki_shared_styles import DakiSharedStyles
from naim.web.daki_style_sync import register_daki_style_sync_routes


SYNTHETIC_ARTIST_NAMES = frozenset({'artist alpha', 'artist beta', 'artist gamma'})


def source_image(prompt='artist:synthetic, watercolor', model='nai-diffusion-5-full', color='blue',
                 negative='lowres', steps=28):
    raw = {'prompt': prompt, 'uc': negative, 'seed': 12, 'steps': steps, 'scale': 5,
           'cfg_rescale': 0, 'sampler': 'k_euler_ancestral', 'noise_schedule': 'karras',
           'prefer_brownian': False}
    info = PngImagePlugin.PngInfo()
    info.add_text('Source', model)
    info.add_text('Comment', json.dumps(raw))
    data = io.BytesIO()
    Image.new('RGB', (64, 128), color).save(data, 'PNG', pnginfo=info)
    return {'source_url': 'https://arca.live/b/aiart/123', 'title': '합성 그림체 공유',
            'recommendation_count': 0, 'image_url': 'https://ac.namu.la/synthetic.png?expires=1',
            'image_bytes': data.getvalue()}


def webp_source_image(prompt='artist:synthetic, watercolor', model='NovelAI Diffusion V5 0ADF9AB7',
                      color='blue'):
    raw = {'prompt': prompt, 'uc': 'lowres', 'seed': 12, 'steps': 28, 'scale': 5,
           'cfg_rescale': 0, 'sampler': 'k_euler_ancestral', 'noise_schedule': 'karras',
           'prefer_brownian': False}
    values = {'Source': model, 'Comment': json.dumps(raw)}
    exif = Image.Exif()
    exif[37510] = b'ASCII\0\0\0' + json.dumps(values).encode('utf-8')
    data = io.BytesIO()
    Image.new('RGB', (64, 128), color).save(data, 'WEBP', exif=exif)
    return {'source_url': 'https://arca.live/b/aiart/123', 'title': '합성 그림체 공유',
            'recommendation_count': 0, 'image_url': 'https://ac.namu.la/synthetic.webp?expires=1',
            'image_bytes': data.getvalue()}


def quota_image(prompt, post_id, recommendation_count, color, image_name, model='nai-diffusion-5-full'):
    image = source_image(prompt, model=model, color=color)
    image['source_url'] = f'https://arca.live/b/aiart/{post_id}'
    image['recommendation_count'] = recommendation_count
    image['image_url'] = f'https://ac.namu.la/{image_name}.png'
    return image


def recommendation_boundary_images():
    ten = [quota_image('artist:ten-first, watercolor', 101, 10, 'blue', 'quota-101-first'),
           quota_image('artist:ten-limited, ink', 101, 10, 'red', 'quota-101-limited'),
           quota_image('artist:above-ten, painting', 101, 11, 'green', 'quota-101-above'),
           quota_image('artist:unknown-first, watercolor', 102, None, 'yellow', 'quota-102-first'),
           quota_image('artist:unknown-next, ink', 102, None, 'purple', 'quota-102-next')]
    ten[1]['source_url'] = 'https://arca.live/b/aiart/101/'
    ten[2]['source_url'] = 'https://arca.live/b/aiart/101?view=article'
    zero = [quota_image('artist:zero-first, watercolor', 103, 0, 'orange', 'quota-103-first'),
            quota_image('artist:zero-limited, ink', 103, 0, 'cyan', 'quota-103-limited'),
            quota_image('artist:above-zero, painting', 103, 1, 'magenta', 'quota-103-above')]
    disabled = [quota_image('artist:disabled-first, watercolor', 104, 0, 'black', 'quota-104-first'),
                quota_image('artist:disabled-next, ink', 104, 0, 'white', 'quota-104-next')]
    unconfigured = [quota_image('artist:unconfigured-first, watercolor', 105, 0, 'navy', 'quota-105-first'),
                    quota_image('artist:unconfigured-next, ink', 105, 0, 'olive', 'quota-105-next')]
    return ten, zero, disabled, unconfigured


class DakiStyleSyncTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.catalog_root = self.root / 'catalog'
        self.catalog_root.mkdir()
        for name, data in (('default_styles.json', {'styles': []}),
                           ('source_generation_options.json', {'styles': {}}),
                           ('generation_manifest.json', {'jobs': {}})):
            (self.catalog_root / name).write_text(json.dumps(data), encoding='utf-8')
        self.imported = self.root / 'imported'
        self.catalog = DakiSharedStyles(self.catalog_root, self.imported)
        self.client = mock.Mock(connected=True)
        self.client.iter_images.return_value = iter([source_image()])
        self.manager = DakiStyleSync(self.imported, self.catalog, self.client)
        self.addCleanup(lambda: (self.manager.stop(), self.manager.wait()))
        self.period = {'start_date': '2026-01-01', 'end_date': '2026-01-02'}

    def run_job(self, images=None, filters=None):
        if images is not None:
            self.client.iter_images.return_value = iter(images)
        request = dict(self.period)
        if filters is not None:
            request['filters'] = filters
        self.manager.start(request)
        self.assertTrue(self.manager.wait())
        return self.manager.status()['job']

    def run_huggingface(self, images=(), filters=None, progress_values=None):
        def archive(root, stop, progress):
            self.assertEqual(root, self.imported / 'sync' / 'downloads')
            if progress_values:
                progress(**progress_values)
            return iter(images)
        self.manager.archive_provider = archive
        request = {'source': 'huggingface'}
        if filters is not None:
            request['filters'] = filters
        self.manager.start(request)
        self.assertTrue(self.manager.wait())
        return self.manager.status()['job']

    def run_source(self, source, images, filters=None):
        if source == 'huggingface':
            return self.run_huggingface(images, filters)
        return self.run_job(images, filters)

    def artist_batch(self, source_name):
        qualities = ('best quality', 'masterpiece', 'high quality', 'highres', 'very aesthetic')
        styles = ('watercolor', 'ink', 'sketch', 'lineart', 'cel shading')
        negatives = ('lowres', 'bad hands', 'jpeg artifacts', 'bad anatomy')

        def image(prompt, index, negative='lowres'):
            item = source_image(prompt, color=(index + 1, (index * 7) % 256, (index * 13 + 3) % 256),
                                negative=negative)
            item['source_url'] = 'https://arca.live/b/aiart/900001'
            item['image_url'] = f'https://ac.namu.la/{source_name}-{index}.png'
            return item

        images = [image('artist:Artist Alpha, artist:Artist Beta, watercolor, best quality', 0)]
        for index in range(1, 31):
            quality = qualities[index % len(qualities)]
            style = styles[index % len(styles)]
            if index % 3 == 1:
                prompt = f'{quality}, {style}, Artist Beta, Artist Alpha, garden'
            elif index % 3 == 2:
                prompt = f'2::{{Artist Beta, {style}, Artist Alpha, {quality}, garden}} ::, 1girl'
            else:
                prompt = f'artist:Artist Alpha, artist:Artist Beta, {style}, {quality}, garden'
            images.append(image(prompt, index, negatives[index % len(negatives)]))
        images.append(image('artist:Artist Alpha, artist:Artist Gamma, ink, masterpiece', 31,
                            'bad hands, lowres'))
        return images

    def assert_recommendation_limit_batches(self, source):
        ten, zero, disabled, unconfigured = recommendation_boundary_images()
        job = self.run_source(source, ten, {'low_recommendation_limit': 10})
        self.assertEqual((job['added'], job['post_limited'], job['skipped'], job['filtered']), (4, 1, 0, 0))

        job = self.run_source(source, zero, {'low_recommendation_limit': 0})
        self.assertEqual((job['added'], job['post_limited'], job['skipped'], job['filtered']), (2, 1, 0, 0))

        job = self.run_source(source, disabled, {'low_recommendation_limit': None})
        self.assertEqual((job['added'], job['post_limited'], job['skipped'], job['filtered']), (2, 0, 0, 0))

        job = self.run_source(source, unconfigured)
        self.assertEqual((job['added'], job['post_limited'], job['skipped'], job['filtered']), (2, 0, 0, 0))

    def add_upper_style(self, style_id='upper-synthetic', positive='artist:synthetic, watercolor'):
        source_image_id = 'upper-source-synthetic'
        style = {'id': style_id, 'name': 'Synthetic upper style', 'model': 'nai-diffusion-5-full',
                 'positive': positive, 'negative': 'lowres', 'source_image_id': source_image_id,
                 'source_url': 'https://example.test/upper',
                 'preview': {'width': 64, 'height': 128, 'image': 'images/upper.png',
                             'thumbnail': 'thumbs/upper.webp', 'job_id': 'upper-preview'}}
        options = {'steps': 28, 'cfg': 5, 'cfg_rescale': 0, 'sampler': 'k_euler_ancestral',
                   'noise_schedule': 'karras', 'prefer_brownian': False}
        values = {
            'default_styles.json': {'styles': [style]},
            'source_generation_options.json': {
                'styles': {style_id: {'source_image_id': source_image_id, 'options': options}}},
            'generation_manifest.json': {'jobs': {'upper-preview': {'seed': 12, 'status': 'success'}}},
        }
        for name, value in values.items():
            (self.catalog_root / name).write_text(json.dumps(value), encoding='utf-8')
        for relative in ('images/upper.png', 'thumbs/upper.webp'):
            path = self.catalog_root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'synthetic upper preview')
        return style_id

    def add_upper_style_for_post(self, post_id):
        style_id = self.add_upper_style()
        path = self.catalog_root / 'default_styles.json'
        value = json.loads(path.read_text(encoding='utf-8'))
        value['styles'][0]['source_url'] = f'https://arca.live/b/aiart/{post_id}'
        value['styles'][0]['recommendation_count'] = 0
        path.write_text(json.dumps(value), encoding='utf-8')
        return style_id

    def add_legacy_v5_style(self, image):
        from naim.arca_shared_styles import extract_metadata
        from naim.shared_style_recipe import extract_recipe
        metadata = extract_metadata(image['image_bytes'])
        recipe = extract_recipe(metadata['base_prompt'], metadata['negative_prompt'])
        style_id = 'import-v5-' + recipe['fingerprint'][:24]
        originals = self.imported / 'legacy-originals'
        originals.mkdir(parents=True, exist_ok=True)
        (originals / 'legacy.png').write_bytes(image['image_bytes'])
        thumbnail = self.imported / 'legacy-thumbnails' / 'legacy.webp'
        thumbnail.parent.mkdir(parents=True, exist_ok=True)
        thumbnail.write_bytes(b'synthetic legacy thumbnail')
        style = {'id': style_id, 'name': 'Legacy V5 fixture', 'model': 'NovelAI Diffusion V5',
                 'positive': recipe['positive'], 'negative': recipe['negative'], 'seed': 12,
                 'options': {'steps': 28, 'cfg': 5, 'cfg_rescale': 0,
                             'sampler': 'k_euler_ancestral', 'noise_schedule': 'karras'},
                 'source_image_id': 'legacy-v5-source', 'source_url': image['source_url'],
                 'preview': {'width': 64, 'height': 128, 'image': 'legacy.png',
                             'thumbnail': 'legacy-thumbnails/legacy.webp'}}
        self.imported.mkdir(parents=True, exist_ok=True)
        (self.imported / 'catalog.json').write_text(json.dumps({
            'styles': [style], 'source_image_root': str(originals), 'hidden_style_ids': []
        }), encoding='utf-8')
        return style_id

    def test_dates_and_connection_are_validated_before_start_or_write(self):
        for period in ({}, None, {'start_date': 'bad', 'end_date': '2026-01-02'},
                       {'start_date': '2026-01-02', 'end_date': '2026-01-01'},
                       {'start_date': '9999-01-01', 'end_date': '9999-01-02'}):
            with self.subTest(period=period), self.assertRaises(ValueError):
                self.manager.start(period)
        self.client.connected = False
        with self.assertRaises(ValueError):
            self.manager.start(self.period)
        self.assertFalse(self.imported.exists())

    def test_full_and_medium_saved_and_catalog_refreshes_without_losing_old_ids(self):
        self.assertEqual(self.catalog.list_styles(), [])
        medium = source_image('artist:synthetic-medium, ink', 'nai-diffusion-5-full-medium', 'red')
        medium['image_url'] = 'https://ac.namu.la/medium.png'
        job = self.run_job([source_image(), medium])
        self.assertEqual((job['status'], job['added']), ('completed', 2))
        styles = self.catalog.list_styles()
        self.assertEqual(len(styles), 2)
        self.assertEqual(styles[0]['recommendation_count'], 0)
        self.assertIs(styles[0]['options']['prefer_brownian'], False)
        self.assertEqual(styles[1]['model'], 'nai-diffusion-5-full-medium')
        self.assertEqual(styles[1]['options']['steps'], 14)
        for style in styles:
            self.assertTrue(self.catalog.preview_path(style['id']).is_file())
            self.assertTrue(self.catalog.preview_path(style['id'], full=True).is_file())
        self.assertEqual(self.run_job([source_image(), medium])['added'], 0)
        self.assertEqual([item['id'] for item in self.catalog.list_styles()], [item['id'] for item in styles])

    def test_arca_artist_combinations_deduplicate_prompt_variants_within_a_post(self):
        images = self.artist_batch('arca-artist')
        with mock.patch('naim.daki_style_sync.load_style_artist_names',
                        return_value=SYNTHETIC_ARTIST_NAMES):
            job = self.run_job(images)

        self.assertEqual((job['added'], job['skipped']), (2, 30))
        self.assertEqual(len(self.catalog.list_styles()), 2)
        self.assertEqual({style['source_url'] for style in self.catalog.list_styles()},
                         {'https://arca.live/b/aiart/900001'})

    def test_huggingface_artist_combinations_deduplicate_prompt_variants_with_progress(self):
        images = self.artist_batch('huggingface-artist')
        progress = {'phase': 'inspect', 'phase_current': 0, 'phase_total': 0,
                    'total_images': len(images)}
        with mock.patch('naim.daki_style_sync.load_style_artist_names',
                        return_value=SYNTHETIC_ARTIST_NAMES):
            job = self.run_huggingface(images, progress_values=progress)

        self.assertEqual((job['prepared'], job['added'], job['skipped']), (2, 2, 30))
        self.assertEqual((job['processed_images'], job['total_images'], job['published']),
                         (32, 32, True))
        self.assertEqual(len(self.catalog.list_styles()), 2)

    def test_artist_names_in_weighted_groups_match_prefixes_without_treating_scene_tags_as_artists(self):
        prompts = [
            'artist:Artist Alpha, artist:Artist Beta, watercolor, best quality',
            '2::{Artist Beta, Artist Alpha, watercolor, masterpiece} ::, 1girl',
            '1.2::{garden, park, watercolor, high quality} ::, 1girl',
        ]
        images = []
        for index, prompt in enumerate(prompts):
            item = source_image(prompt, color=(40 + index, 90 + index, 140 + index),
                                negative=('lowres', 'bad hands', 'jpeg artifacts')[index])
            item['image_url'] = f'https://ac.namu.la/grouped-artist-{index}.png'
            images.append(item)

        with mock.patch('naim.daki_style_sync.load_style_artist_names',
                        return_value=SYNTHETIC_ARTIST_NAMES):
            job = self.run_job(images)

        self.assertEqual((job['added'], job['skipped']), (2, 1))
        records = json.loads((self.imported / 'sync_catalog.json').read_text(encoding='utf-8'))['styles']
        self.assertEqual(len(records), 2)
        self.assertTrue(any('watercolor' in record['positive'] and 'artist:' not in record['positive']
                            for record in records))
        self.assertTrue(all('garden' not in record['positive'] and 'park' not in record['positive']
                            for record in records))

    def test_artist_key_survives_cross_source_run_and_preserves_excluded_synced_record(self):
        first = source_image('artist:Artist Alpha, artist:Artist Beta, watercolor, best quality',
                             color='blue', negative='lowres, bad hands')
        first['image_url'] = 'https://ac.namu.la/cross-source-first.png'
        candidate = source_image('1.7::{Artist Beta, Artist Alpha, ink, masterpiece} ::, garden',
                                 model='nai-diffusion-5-full-medium', color='red',
                                 negative='bad anatomy, jpeg artifacts')
        candidate['image_url'] = 'https://ac.namu.la/cross-source-candidate.png'

        with mock.patch('naim.daki_style_sync.load_style_artist_names',
                        return_value=SYNTHETIC_ARTIST_NAMES):
            first_job = self.run_job([first])
            manifest_path = self.imported / 'sync_catalog.json'
            original_manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
            original_record = original_manifest['styles'][0]
            style_id = original_record['id']
            preview = self.catalog.preview_path(style_id, full=True)
            preview_bytes = preview.read_bytes()
            self.assertEqual(self.catalog.remove_styles([style_id]), 1)
            exclusions_path = self.imported / 'excluded_styles.json'
            exclusions_before = exclusions_path.read_bytes()
            second_job = self.run_huggingface([candidate], progress_values={
                'phase': 'inspect', 'phase_current': 0, 'phase_total': 0, 'total_images': 1,
            })

        after_manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        self.assertEqual((first_job['added'], second_job['added'], second_job['prepared'],
                          second_job['skipped']), (1, 0, 0, 1))
        self.assertEqual(after_manifest['styles'], [original_record])
        self.assertEqual(after_manifest['styles'][0]['id'], style_id)
        self.assertEqual(after_manifest['styles'][0]['fingerprint'], original_record['fingerprint'])
        self.assertEqual((after_manifest['styles'][0]['positive'], after_manifest['styles'][0]['negative']),
                         (original_record['positive'], original_record['negative']))
        self.assertEqual(preview.read_bytes(), preview_bytes)
        self.assertEqual(exclusions_path.read_bytes(), exclusions_before)
        self.assertEqual(self.catalog.list_styles(), [])
        self.assertEqual(self.catalog.list_styles(include_excluded=True)[0]['id'], style_id)

    def test_legacy_catalog_artist_combo_is_derived_without_rewriting_or_reviving(self):
        legacy = source_image('artist:Artist Alpha, artist:Artist Beta, watercolor, high quality',
                              color='blue', negative='lowres, bad hands')
        legacy_id = self.add_legacy_v5_style(legacy)
        catalog_path = self.imported / 'catalog.json'
        catalog_bytes = catalog_path.read_bytes()
        legacy_record = json.loads(catalog_bytes)['styles'][0]
        original_style = self.catalog.get_style(legacy_id)
        legacy_preview = self.catalog.preview_path(legacy_id, full=True)
        preview_bytes = legacy_preview.read_bytes()
        self.assertEqual(self.catalog.remove_styles([legacy_id]), 1)
        exclusions_path = self.imported / 'excluded_styles.json'
        exclusions_before = exclusions_path.read_bytes()

        candidate = source_image('2::{Artist Alpha, Artist Beta, sketch, masterpiece} ::, park',
                                 color='red', negative='bad anatomy, jpeg artifacts')
        candidate['image_url'] = 'https://ac.namu.la/legacy-candidate.png'
        with mock.patch('naim.daki_style_sync.load_style_artist_names',
                        return_value=SYNTHETIC_ARTIST_NAMES):
            job = self.run_job([candidate])

        self.assertEqual((job['added'], job['skipped']), (0, 1))
        self.assertEqual(catalog_path.read_bytes(), catalog_bytes)
        self.assertEqual(json.loads(catalog_bytes)['styles'][0], legacy_record)
        self.assertEqual(self.catalog.get_style(legacy_id)['id'], legacy_id)
        self.assertEqual((self.catalog.get_style(legacy_id)['positive'],
                          self.catalog.get_style(legacy_id)['negative']),
                         (original_style['positive'], original_style['negative']))
        self.assertEqual(legacy_preview.read_bytes(), preview_bytes)
        self.assertEqual(exclusions_path.read_bytes(), exclusions_before)
        self.assertEqual(self.catalog.list_styles(), [])
        self.assertEqual([item['id'] for item in self.catalog.list_styles(include_excluded=True)],
                         [legacy_id])

    def test_no_artist_style_combinations_ignore_quality_order_weights_and_negatives(self):
        prompts = [
            ('watercolor, sketch, best quality', 'lowres'),
            ('2::{sketch, watercolor, high quality} ::, garden', 'bad hands'),
            ('ink, masterpiece, garden', 'jpeg artifacts'),
            ('masterpiece, high quality, garden', 'lowres'),
            ('masterpiece, quality, garden', 'lowres'),
        ]
        images = []
        for index, (prompt, negative) in enumerate(prompts):
            item = source_image(prompt, color=(70 + index, 120 + index, 170 + index),
                                negative=negative)
            item['image_url'] = f'https://ac.namu.la/no-artist-style-{index}.png'
            images.append(item)

        with mock.patch('naim.daki_style_sync.load_style_artist_names', return_value=frozenset()):
            job = self.run_job(images)

        self.assertEqual((job['added'], job['skipped']), (2, 3))
        saved = json.loads((self.imported / 'sync_catalog.json').read_text(encoding='utf-8'))['styles']
        self.assertEqual(len(saved), 2)
        self.assertEqual({style['positive'] for style in saved},
                         {'watercolor, sketch, best quality', 'ink, masterpiece'})

    def test_upper_artist_combination_does_not_consume_v5_artist_key(self):
        upper_id = self.add_upper_style(positive='artist:Artist Alpha, watercolor, best quality')
        candidate = source_image('artist:Artist Alpha, ink, masterpiece, garden', color='red',
                                 negative='bad hands, jpeg artifacts')
        candidate['image_url'] = 'https://ac.namu.la/v5-after-upper.png'
        with mock.patch('naim.daki_style_sync.load_style_artist_names',
                        return_value=SYNTHETIC_ARTIST_NAMES):
            job = self.run_job([candidate])

        self.assertEqual((job['added'], job['skipped']), (1, 0))
        listed = self.catalog.list_styles()
        listed_ids = {style['id'] for style in listed}
        self.assertEqual(len(listed), 2)
        self.assertIn(upper_id, listed_ids)
        imported = json.loads((self.imported / 'sync_catalog.json').read_text(encoding='utf-8'))['styles']
        self.assertEqual(len(imported), 1)
        self.assertEqual(imported[0]['category'], 'v5')
        self.assertNotEqual(imported[0]['id'], upper_id)

    def test_excluded_style_stays_excluded_and_duplicate_recipe_or_pixels_are_skipped(self):
        self.run_job()
        style = self.catalog.list_styles()[0]
        self.catalog.remove_styles([style['id']])
        same_recipe = source_image(color='yellow')
        same_recipe['image_url'] = 'https://ac.namu.la/changed-url.png'
        same_pixels = source_image('artist:other, ink')
        same_pixels['image_url'] = 'https://ac.namu.la/other.png'
        job = self.run_job([same_recipe, same_pixels])
        self.assertEqual((job['added'], job['skipped']), (0, 2))
        self.assertEqual(self.catalog.list_styles(), [])
        self.assertEqual(self.catalog.get_style(style['id'])['id'], style['id'])

    def test_unsupported_models_realism_missing_metadata_and_unknown_style_are_skipped(self):
        job = self.run_job([source_image(model='nai-diffusion-4-5-full'),
                            source_image('artist:synthetic, realistic'),
                            source_image('1girl, solo, beach'),
                            {**source_image(), 'image_bytes': b'invalid'}])
        self.assertEqual((job['added'], job['skipped'], job['filtered'], job['status']),
                         (0, 3, 1, 'completed'))
        self.assertEqual(self.catalog.list_styles(), [])

    def test_previously_imported_images_are_skipped_before_network_after_restart(self):
        self.run_job()
        imported_id = self.catalog.list_styles()[0]['id']
        self.catalog.remove_styles([imported_id])
        known = source_image()
        known['image_url'] = 'https://ac-o.arca.live/synthetic.png?key=renewed&type=orig'
        fresh = source_image('artist:other, ink', color='red')
        fresh['image_url'] = 'https://ac.namu.la/fresh.png'
        downloaded = []
        def images(*args, skip_image):
            for image in (known, fresh):
                if not skip_image(image['image_url']):
                    downloaded.append(image['image_url'])
                    yield image
        self.client.iter_images.side_effect = images
        self.manager = DakiStyleSync(self.imported, self.catalog, self.client)
        job = self.run_job()
        self.assertEqual(downloaded, [fresh['image_url']])
        self.assertEqual((job['status'], job['added'], job['skipped']), ('completed', 1, 1))
        self.assertNotIn(imported_id, [style['id'] for style in self.catalog.list_styles()])

    def test_import_failure_closes_the_image_generator(self):
        closed = threading.Event()
        def images(*args, **kwargs):
            try:
                yield source_image()
                self.fail('An import failure must not request another image')
            finally:
                closed.set()
        self.client.iter_images.side_effect = images
        with mock.patch('naim.daki_style_sync._write_image', side_effect=OSError('synthetic failure')):
            job = self.run_job()
        self.assertEqual(job['status'], 'failed')
        self.assertTrue(closed.is_set())

    def test_image_failures_remain_visible_without_losing_imports_or_connection(self):
        def images(start, end, stop, progress, **kwargs):
            progress(stage='image_error', tab='NAI', failed_images=1,
                     last_image_error='이미지 요청 제한(HTTP 429, 도메인: ac-o.arca.live)')
            yield source_image()
        self.client.iter_images.side_effect = images
        job = self.run_job()
        self.assertEqual((job['status'], job['added'], job['failed_images']), ('completed', 1, 1))
        self.assertIn('같은 기간', job['message'])
        self.assertIn('HTTP 429', job['last_image_error'])
        self.assertTrue(self.manager.status()['connected'])
        self.assertEqual(len(self.catalog.list_styles()), 1)
        persisted = json.loads((self.imported / 'sync_job.json').read_text(encoding='utf-8'))
        self.assertEqual(persisted['failed_images'], 1)
        self.client.iter_images.side_effect = None
        retried = self.run_job([])
        self.assertEqual((retried['failed_images'], retried['last_image_error']), (0, ''))

    def test_all_image_failures_are_reported_even_when_no_styles_were_imported(self):
        def images(start, end, stop, progress, **kwargs):
            progress(stage='image_error', tab='NAI', failed_images=2,
                     last_image_error='이미지 요청 제한(HTTP 429, 도메인: ac-o.arca.live)')
            return iter(())
        self.client.iter_images.side_effect = images
        job = self.run_job()
        self.assertEqual((job['added'], job['failed_images']), (0, 2))
        self.assertIn('2개를 받지 못했습니다', job['message'])
        self.assertTrue(self.manager.status()['connected'])

    def test_real_collector_imports_after_http_429_and_retries_only_missing_image(self):
        from urllib.parse import parse_qs, urlsplit
        from tests.test_arca_shared_styles import Response, CATEGORIES, PAYLOAD, row
        self.manager = DakiStyleSync(self.imported, self.catalog, ArcaSharedClient())
        attempts = []
        def get(url, **kwargs):
            parsed = urlsplit(url)
            if parsed.hostname != 'arca.live':
                attempts.append(parsed.path)
                return Response(status=429) if parsed.path == '/blocked.png' else Response(source_image()['image_bytes'])
            if parsed.path == '/b/aiart/1':
                return Response('<div class="article-content"><img data-original="https://ac-o.arca.live/blocked.png?type=img" src="https://ac.arca.live/available.png?type=img"></div>')
            query = parse_qs(parsed.query)
            if not query:
                return Response(CATEGORIES)
            return Response(row(1, day='2026-01-01')) if query.get('category') == ['1'] and query.get('p') == ['1'] else Response('')
        with mock.patch('naim.arca_shared_styles.requests.Session.get', side_effect=get), \
                mock.patch.object(self.manager._stop, 'wait', return_value=False):
            self.manager.connect(PAYLOAD)
            first = self.run_job()
            self.assertEqual((first['status'], first['added'], first['failed_images']), ('completed', 1, 1))
            self.assertTrue(self.manager.status()['connected'])
            self.assertIn('ac-o.arca.live', first['last_image_error'])
            self.assertEqual(sorted(attempts), ['/available.png', '/blocked.png'])
            attempts.clear()
            second = self.run_job()
        self.assertEqual(attempts, ['/blocked.png'])
        self.assertEqual((second['added'], second['skipped'], second['failed_images']), (0, 1, 1))
        self.assertEqual(len(self.catalog.list_styles()), 1)

    def test_progress_describes_search_download_and_metadata_stages(self):
        messages = []
        def images(start, end, stop, progress, **kwargs):
            for stage in ('search', 'article', 'download', 'image'):
                progress(stage=stage, tab='R18_NAI', page=2)
                messages.append(self.manager.status()['job']['message'])
            return iter(())
        self.client.iter_images.side_effect = images
        self.assertEqual(self.run_job()['status'], 'completed')
        self.assertTrue(all('🔞 NAI' in message for message in messages))
        self.assertIn('2페이지', messages[0])
        self.assertIn('그림체', messages[0])
        self.assertIn('게시글', messages[1])
        self.assertIn('받는 중', messages[2])
        self.assertIn('메타데이터', messages[3])

    def test_huggingface_total_image_count_stays_unknown_until_archive_reports_it(self):
        entered = threading.Event()
        release = threading.Event()

        def archive(root, stop, progress):
            entered.set()
            release.wait(5)
            progress(phase='inspect', phase_current=0, phase_total=0, total_images=1)
            return iter([source_image()])

        self.manager.archive_provider = archive
        self.manager.start({'source': 'huggingface'})
        try:
            self.assertTrue(entered.wait(5))
            resolving = self.manager.status()['job']
            self.assertEqual(resolving['phase'], 'resolve')
            self.assertEqual((resolving['total_images'], resolving['processed_images']), (0, 0))
        finally:
            release.set()

        self.assertTrue(self.manager.wait())
        completed = self.manager.status()['job']
        self.assertEqual((completed['total_images'], completed['processed_images']), (1, 1))
        self.assertEqual(completed['phase'], 'complete')

    def test_huggingface_processed_progress_tracks_each_classified_image_until_publish(self):
        images = [
            quota_image('artist:progress-first, watercolor', 700, 11, 'blue', 'progress-first'),
            quota_image('artist:progress-first, watercolor', 700, 11, 'red', 'progress-duplicate'),
            quota_image('artist:unsupported, ink', 701, 5, 'green', 'progress-unsupported',
                        model='nai-diffusion-4-5-full'),
            quota_image('artist:filtered, photorealistic', 702, 5, 'yellow', 'progress-filtered'),
            quota_image('artist:post-limited, ink', 700, 10, 'purple', 'progress-post-limited'),
        ]
        observed = []
        publish_observed = []

        def archive(root, stop, progress):
            progress(phase='inspect', phase_current=0, phase_total=0,
                     total_images=len(images))

            def stream():
                for image in images:
                    yield image
                    observed.append(self.manager.status()['job'])

            return stream()

        self.manager.archive_provider = archive
        original_write = __import__('naim.daki_style_sync', fromlist=['write_json']).write_json

        def observe_publish(path, *args, **kwargs):
            if Path(path).name == 'sync_catalog.json':
                job = self.manager.status()['job']
                publish_observed.append((job['phase'], job['published']))
            return original_write(path, *args, **kwargs)

        with mock.patch('naim.daki_style_sync.write_json', side_effect=observe_publish):
            self.manager.start({'source': 'huggingface', 'filters': {'low_recommendation_limit': 10}})
            self.assertTrue(self.manager.wait())

        self.assertEqual([job['processed_images'] for job in observed], [1, 2, 3, 4, 5])
        self.assertTrue(all(job['phase'] == 'inspect' and job['total_images'] == 5
                            and job['published'] is False for job in observed))
        self.assertEqual([(job['skipped'], job['filtered'], job['post_limited'])
                          for job in observed], [(0, 0, 0), (1, 0, 0), (2, 0, 0),
                                                 (2, 1, 0), (2, 1, 1)])
        self.assertEqual(publish_observed, [('publish', False)])

        completed = self.manager.status()['job']
        self.assertEqual((completed['status'], completed['phase'], completed['processed_images'],
                          completed['total_images'], completed['prepared'], completed['added'],
                          completed['published']),
                         ('completed', 'complete', 5, 5, 1, 1, True))

    def test_duplicate_run_is_rejected_stop_keeps_successful_import(self):
        release = threading.Event()
        entered = threading.Event()
        def images(*args, **kwargs):
            yield source_image()
            entered.set()
            release.wait(5)
            yield source_image('artist:other, ink', color='red')
        self.client.iter_images.side_effect = images
        self.manager.start(self.period)
        self.assertTrue(entered.wait(5))
        with self.assertRaises(ValueError):
            self.manager.start(self.period)
        with self.assertRaises(ValueError):
            self.manager.start({'source': 'huggingface'})
        self.manager.stop()
        release.set()
        self.assertTrue(self.manager.wait())
        self.assertEqual(self.manager.status()['job']['status'], 'stopped')
        self.assertEqual(len(self.catalog.list_styles()), 1)

    def test_failed_publish_preserves_previous_catalog_and_reports_failure(self):
        self.run_job()
        manifest = self.imported / 'sync_catalog.json'
        before = manifest.read_bytes()
        original_write = __import__('naim.daki_style_sync', fromlist=['write_json']).write_json
        def fail_catalog(path, *args, **kwargs):
            if Path(path).name == 'sync_catalog.json':
                raise OSError('synthetic write failure')
            return original_write(path, *args, **kwargs)
        with mock.patch('naim.daki_style_sync.write_json', side_effect=fail_catalog):
            candidate = source_image('artist:other, ink', color='red')
            candidate['image_url'] = 'https://ac.namu.la/new.png'
            job = self.run_job([candidate])
        self.assertEqual(job['status'], 'failed')
        self.assertEqual(manifest.read_bytes(), before)
        self.assertEqual(len(self.catalog.list_styles()), 1)

    def test_restart_reports_interrupted_job_without_restarting_network(self):
        self.imported.mkdir()
        (self.imported / 'sync_job.json').write_text(json.dumps({'status': 'running', 'added': 1}), encoding='utf-8')
        self.assertEqual(self.manager.status()['job']['status'], 'failed')
        self.client.iter_images.assert_not_called()

        hf_root = self.root / 'interrupted-huggingface'
        hf_root.mkdir()
        (hf_root / 'sync_job.json').write_text(json.dumps({
            'status': 'running', 'source': 'huggingface', 'published': False, 'prepared': 1
        }), encoding='utf-8')
        restarted = DakiStyleSync(hf_root, self.catalog, self.client)
        job = restarted.status()['job']
        self.assertEqual(job['status'], 'failed')
        self.assertIsNone(job['published'])
        self.assertEqual(job['prepared'], 1)
        self.client.iter_images.assert_not_called()

    def test_first_collection_works_without_external_catalog_and_moves_with_installation(self):
        self.catalog.catalog_root_provider = self.root / 'absent-external-catalog'
        self.assertEqual(self.catalog.list_styles(), [])
        self.assertEqual(self.run_job()['added'], 1)
        moved = self.root / 'moved-imported'
        self.imported.rename(moved)
        restored = DakiSharedStyles(self.root / 'absent-external-catalog', moved)
        style = restored.list_styles()[0]
        self.assertTrue(restored.preview_path(style['id'], full=True).is_relative_to(moved))

    def test_period_defaults_follow_current_styles_and_excluded_styles_do_not_count(self):
        candidate = {**source_image(), 'source_posted_at': '2026-01-02'}
        self.run_job([candidate])
        defaults = self.manager.status()['defaults']
        self.assertEqual(defaults['start_date'], '2026-01-02')
        self.assertEqual(defaults['basis'], 'latest_style')
        self.assertGreaterEqual(defaults['end_date'], defaults['start_date'])
        style = self.catalog.list_styles()[0]
        self.assertEqual(style['source_posted_at'], '2026-01-02')
        self.catalog.remove_styles([style['id']])
        defaults = self.manager.status()['defaults']
        self.assertEqual(defaults['start_date'], defaults['end_date'])
        self.assertEqual(defaults['basis'], 'today')

    def test_legacy_styles_use_public_article_dates_without_rewriting_catalog(self):
        self.run_job()
        path = self.imported / 'sync_catalog.json'
        before = path.read_bytes()
        with mock.patch('naim.storage.daki_style_dates._bundled_dates', return_value={
                'https://arca.live/b/aiart/123': '2026-01-03'}):
            self.assertEqual(self.manager.status()['defaults']['start_date'], '2026-01-03')
        self.assertEqual(path.read_bytes(), before)

    def test_arca_filters_default_realism_and_retry_filtered_source_after_opt_in(self):
        realistic = source_image('artist:synthetic, watercolor, photorealistic', color='blue')
        negative_realistic = source_image('artist:other, ink', color='red',
                                          negative='photorealistic, lowres')
        realistic['image_url'] = 'https://ac.namu.la/arca-positive-realism.png'
        negative_realistic['image_url'] = 'https://ac.namu.la/arca-negative-realism.png'

        default_job = self.run_job([realistic, negative_realistic])

        self.assertEqual(default_job['filters'], {'exclude_realistic': True, 'include_mode': 'any',
                                                  'include_tags': [], 'exclude_tags': []})
        self.assertEqual((default_job['added'], default_job['filtered'], default_job['skipped']), (1, 1, 0))
        manifest_path = self.imported / 'sync_catalog.json'
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        self.assertEqual(len(manifest['styles']), 1)
        self.assertEqual(manifest['styles'][0]['negative'], 'photorealistic, lowres')

        opt_in_job = self.run_job([realistic, negative_realistic], {'exclude_realistic': False})

        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        realistic_record = next(style for style in manifest['styles']
                                if 'photorealistic' in style['positive'])
        self.assertEqual((opt_in_job['added'], opt_in_job['filtered'], opt_in_job['skipped']), (1, 0, 1))
        self.assertTrue(realistic_record['allow_realistic'])
        self.assertEqual(len(manifest['styles']), 2)

    def test_arca_tag_filters_any_all_and_exclusion_priority(self):
        images = [source_image('artist:one, watercolor', color='blue'),
                  source_image('artist:two, ink', color='red'),
                  source_image('artist:three, watercolor, ink', color='green')]
        for index, image in enumerate(images):
            image['image_url'] = f'https://ac.namu.la/arca-filter-{index}.png'

        any_job = self.run_job(images, {'include_tags': ['watercolor', 'ink'], 'include_mode': 'any'})
        self.assertEqual((any_job['added'], any_job['filtered'], any_job['skipped']), (3, 0, 0))

        all_images = [dict(image, image_url=f'https://ac.namu.la/arca-all-{index}.png')
                      for index, image in enumerate(images)]
        all_job = self.run_job(all_images, {'include_tags': ['watercolor', 'ink'], 'include_mode': 'all'})
        self.assertEqual((all_job['added'], all_job['filtered'], all_job['skipped']), (0, 2, 1))

        excluded_images = [dict(image, image_url=f'https://ac.namu.la/arca-excluded-{index}.png')
                           for index, image in enumerate(images)]
        excluded_job = self.run_job(excluded_images, {'include_tags': ['watercolor'],
                                                      'exclude_tags': ['watercolor']})
        self.assertEqual((excluded_job['added'], excluded_job['filtered'], excluded_job['skipped']), (0, 3, 0))
        self.assertEqual(len(json.loads((self.imported / 'sync_catalog.json').read_text(encoding='utf-8'))
                             ['styles']), 3)

    def test_arca_query_filter_uses_and_or_groups_and_excludes_matching_terms_first(self):
        images = [source_image('artist:first, watercolor, sketch', color='blue'),
                  source_image('artist:second, ink', color='red'),
                  source_image('artist:third, watercolor', color='green')]
        for index, image in enumerate(images):
            image['image_url'] = f'https://ac.namu.la/arca-query-{index}.png'
        query = 'watercolor, sketch || ink'

        job = self.run_job(images, {'include_query': query, 'exclude_tags': ['ink']})

        self.assertEqual((job['added'], job['filtered'], job['skipped']), (1, 2, 0))
        self.assertEqual(job['filters']['include_query'], query)
        manifest = json.loads((self.imported / 'sync_catalog.json').read_text(encoding='utf-8'))
        self.assertEqual(len(manifest['styles']), 1)
        self.assertIn('sketch', manifest['styles'][0]['positive'])

    def test_huggingface_recommendation_limit_threshold_unknown_zero_and_off(self):
        self.assert_recommendation_limit_batches('huggingface')
        manifest = json.loads((self.imported / 'sync_catalog.json').read_text(encoding='utf-8'))
        self.assertEqual(len(manifest['styles']), 10)

    def test_arca_recommendation_limit_threshold_unknown_zero_and_off(self):
        self.assert_recommendation_limit_batches('arca')
        manifest = json.loads((self.imported / 'sync_catalog.json').read_text(encoding='utf-8'))
        self.assertEqual(len(manifest['styles']), 10)

    def test_huggingface_filtered_invalid_and_duplicate_candidates_do_not_consume_post_quota(self):
        seed = quota_image('artist:synthetic, watercolor', 500, 0, 'blue', 'quota-seed')
        self.assertEqual(self.run_huggingface([seed])['added'], 1)
        candidates = [
            quota_image('artist:filtered, photorealistic', 501, 4, 'red', 'quota-filtered'),
            quota_image('artist:unsupported, ink', 501, 4, 'green', 'quota-invalid',
                        model='nai-diffusion-4-5-full'),
            quota_image('artist:synthetic, watercolor', 501, 4, 'yellow', 'quota-duplicate'),
            quota_image('artist:target-valid, ink', 501, 4, 'purple', 'quota-valid'),
            quota_image('artist:target-after-limit, watercolor', 501, 4, 'orange', 'quota-after-limit'),
        ]

        job = self.run_huggingface(candidates, {'low_recommendation_limit': 10})

        self.assertEqual((job['added'], job['prepared'], job['filtered'], job['skipped'],
                          job['post_limited']), (1, 1, 1, 2, 1))
        manifest = json.loads((self.imported / 'sync_catalog.json').read_text(encoding='utf-8'))
        self.assertEqual(len(manifest['styles']), 2)
        self.assertEqual(manifest['styles'][-1]['positive'], 'artist:target-valid, ink')

    def test_arca_filtered_invalid_and_duplicate_candidates_do_not_consume_post_quota(self):
        seed = quota_image('artist:synthetic, watercolor', 510, 0, 'blue', 'arca-quota-seed')
        self.assertEqual(self.run_job([seed])['added'], 1)
        candidates = [
            quota_image('artist:filtered, photorealistic', 511, 4, 'red', 'arca-quota-filtered'),
            quota_image('artist:unsupported, ink', 511, 4, 'green', 'arca-quota-invalid',
                        model='nai-diffusion-4-5-full'),
            quota_image('artist:synthetic, watercolor', 511, 4, 'yellow', 'arca-quota-duplicate'),
            quota_image('artist:target-valid, ink', 511, 4, 'purple', 'arca-quota-valid'),
            quota_image('artist:target-after-limit, watercolor', 511, 4, 'orange', 'arca-quota-after-limit'),
        ]

        job = self.run_job(candidates, {'low_recommendation_limit': 10})

        self.assertEqual((job['added'], job['filtered'], job['skipped'], job['post_limited']), (1, 1, 2, 1))
        manifest = json.loads((self.imported / 'sync_catalog.json').read_text(encoding='utf-8'))
        self.assertEqual(len(manifest['styles']), 2)
        self.assertEqual(manifest['styles'][-1]['positive'], 'artist:target-valid, ink')

    def test_huggingface_post_quota_includes_hidden_and_manually_excluded_records_and_repeats(self):
        first = quota_image('artist:old-post, watercolor', 520, 0, 'blue', 'hf-old-post')
        self.assertEqual(self.run_huggingface([first])['added'], 1)
        path = self.imported / 'sync_catalog.json'
        manifest = json.loads(path.read_text(encoding='utf-8'))
        style_id = manifest['styles'][0]['id']
        self.catalog.remove_styles([style_id])
        manifest['active_style_ids'] = []
        path.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
        candidate = quota_image('artist:new-from-old-post, ink', 520, 0, 'red', 'hf-new-old-post')

        for _ in range(2):
            job = self.run_huggingface([candidate], {'low_recommendation_limit': 0})
            self.assertEqual((job['added'], job['prepared'], job['post_limited'], job['skipped']),
                             (0, 0, 1, 0))
        published = json.loads(path.read_text(encoding='utf-8'))
        self.assertNotIn('active_style_ids', published)
        self.assertEqual([style['id'] for style in published['styles']], [style_id])
        self.assertEqual(self.catalog.list_styles(), [])

    def test_arca_post_quota_includes_manually_excluded_existing_record(self):
        first = quota_image('artist:old-arca-post, watercolor', 521, 0, 'blue', 'arca-old-post')
        self.assertEqual(self.run_job([first])['added'], 1)
        style_id = self.catalog.list_styles()[0]['id']
        self.catalog.remove_styles([style_id])
        candidate = quota_image('artist:new-arca-from-old-post, ink', 521, 0, 'red', 'arca-new-old-post')

        job = self.run_job([candidate], {'low_recommendation_limit': 0})

        self.assertEqual((job['added'], job['post_limited'], job['skipped']), (0, 1, 0))
        self.assertEqual(self.catalog.list_styles(), [])
        self.assertEqual(self.catalog.get_style(style_id)['id'], style_id)

    def test_upper_collection_does_not_consume_huggingface_post_quota(self):
        self.add_upper_style_for_post(530)
        imported = quota_image('artist:huggingface-post-style, watercolor', 530, 0,
                               'red', 'huggingface-after-upper')

        job = self.run_huggingface([imported], {'low_recommendation_limit': 0})

        self.assertEqual((job['added'], job['post_limited']), (1, 0))

    def test_upper_collection_does_not_consume_arca_post_quota(self):
        self.add_upper_style_for_post(531)
        imported = quota_image('artist:arca-post-style, watercolor', 531, 0,
                               'green', 'arca-after-upper')

        job = self.run_job([imported], {'low_recommendation_limit': 0})

        self.assertEqual((job['added'], job['post_limited']), (1, 0))

    def test_archive_requests_recommendations_only_for_an_enabled_limit(self):
        root = self.imported / 'sync' / 'downloads'
        progress = lambda **values: None
        for filters, expected in (({'low_recommendation_limit': None}, False),
                                  ({'low_recommendation_limit': 0}, True),
                                  ({}, False)):
            with self.subTest(filters=filters):
                self.manager._job = {'status': 'completed', 'filters': filters}
                with mock.patch('naim.daki_style_sync.iter_archive_images', return_value=iter(())) as provider:
                    self.manager._archive_images(root, self.manager._stop, progress)
                provider.assert_called_once_with(root, self.manager._stop, progress,
                                                 include_recommendations=expected)

    def test_huggingface_import_requires_no_browser_login_and_uses_shared_recipe_pipeline(self):
        self.client.connected = False
        def archive(root, stop, progress):
            self.assertEqual(root, self.imported / 'sync/downloads')
            progress(downloaded_bytes=100, total_bytes=100, downloaded_images=2, scanned_posts=1)
            yield {**source_image(model='nai-diffusion-5-full-medium'), 'source_posted_at': '2026-01-02'}
            yield {**source_image(model='nai-diffusion-4-5-full'), 'image_url': 'https://ac.namu.la/v45.png'}
        self.manager.archive_provider = archive
        self.manager.start({'source': 'huggingface'})
        self.assertTrue(self.manager.wait())
        job = self.manager.status()['job']
        self.assertEqual((job['source'], job['status'], job['added'], job['skipped']),
                         ('huggingface', 'completed', 1, 1))
        self.assertEqual((job['downloaded_bytes'], job['total_bytes']), (100, 100))
        self.assertIsNone(job['start_date'])
        self.client.iter_images.assert_not_called()
        self.assertEqual(self.catalog.list_styles()[0]['model'], 'nai-diffusion-5-full-medium')
        self.assertEqual(self.manager.status()['defaults']['start_date'], '2026-01-02')

    def test_huggingface_failure_preserves_existing_catalog_and_allows_retry(self):
        self.run_job()
        before = (self.imported / 'sync_catalog.json').read_bytes()
        self.manager.archive_provider = mock.Mock(side_effect=ValueError('합성 이미지팩 오류'))
        self.manager.start({'source': 'huggingface'})
        self.assertTrue(self.manager.wait())
        self.assertEqual(self.manager.status()['job']['status'], 'failed')
        self.assertEqual((self.imported / 'sync_catalog.json').read_bytes(), before)
        self.manager.archive_provider = lambda *args: iter([])
        self.manager.start({'source': 'huggingface'})
        self.assertTrue(self.manager.wait())
        self.assertEqual(self.manager.status()['job']['status'], 'completed')

    def test_huggingface_appends_without_overwriting_legacy_and_ignores_upper_fingerprints(self):
        legacy = source_image(color='blue')
        legacy_id = self.add_legacy_v5_style(legacy)
        upper_id = self.add_upper_style(positive='artist:upper-only, watercolor')
        before_legacy = self.catalog.get_style(legacy_id)
        old_preview = self.catalog.preview_path(legacy_id, full=True)
        old_preview_bytes = old_preview.read_bytes()

        duplicate_legacy = source_image(color='red', steps=33)
        duplicate_legacy['title'] = 'Must not replace the legacy record'
        upper_recipe = source_image('artist:upper-only, watercolor', color='green')
        upper_recipe['title'] = 'New V5 recipe matching an upper style'
        progress = {'archive_revision': 'a' * 40,
                    'archive_filename': 'NAImakeArtistGroup_shared_images_20261024_webp.zip',
                    'archive_sha256': 'b' * 64}
        job = self.run_huggingface([duplicate_legacy, upper_recipe], progress_values=progress)

        record = self.catalog.get_style(legacy_id)
        manifest = json.loads((self.imported / 'sync_catalog.json').read_text(encoding='utf-8'))
        new_id = next(style['id'] for style in manifest['styles'] if style['name'] == upper_recipe['title'])
        self.assertEqual((job['added'], job['updated'], job['prepared'], job['skipped']), (1, 0, 1, 1))
        self.assertEqual(record, before_legacy)
        self.assertEqual(old_preview.read_bytes(), old_preview_bytes)
        self.assertEqual({item['id'] for item in self.catalog.list_styles()}, {legacy_id, upper_id, new_id})
        listed = {item['id']: item for item in self.catalog.list_styles()}
        self.assertEqual(listed[upper_id]['category'], 'upper')
        self.assertEqual(listed[legacy_id]['category'], 'v5')
        self.assertEqual(listed[new_id]['category'], 'v5')
        self.assertNotEqual(new_id, upper_id)
        self.assertEqual(self.catalog.preview_path(new_id, full=True).read_bytes(), upper_recipe['image_bytes'])
        self.assertEqual({key: job[key] for key in progress}, progress)
        self.assertEqual({key: manifest['huggingface'][key] for key in progress}, progress)

    def test_huggingface_append_keeps_old_records_exclusions_backup_and_unknown_fields(self):
        first = source_image(color='blue')
        second = source_image('artist:other, ink', color='red')
        self.assertEqual(self.run_huggingface([first, second])['added'], 2)
        path = self.imported / 'sync_catalog.json'
        previous = json.loads(path.read_text(encoding='utf-8'))
        previous['future_extension'] = {'preserve': ['synthetic', 7]}
        path.write_text(json.dumps(previous, indent=2), encoding='utf-8')
        previous = json.loads(path.read_text(encoding='utf-8'))
        before = path.read_bytes()
        old_styles = {style['id']: style for style in previous['styles']}
        old_ids = list(old_styles)
        old_preview_bytes = {style_id: self.catalog.preview_path(style_id, full=True).read_bytes()
                             for style_id in old_ids}
        self.catalog.remove_styles([old_ids[0]])
        exclusions = (self.imported / 'excluded_styles.json').read_bytes()

        newest = source_image('artist:third, watercolor', color='green')
        newest['title'] = 'Newest synthetic style'
        job = self.run_huggingface([newest])

        manifest = json.loads(path.read_text(encoding='utf-8'))
        backup = json.loads((self.imported / 'sync_catalog.before-huggingface.json').read_text(encoding='utf-8'))
        newest_id = next(style['id'] for style in manifest['styles'] if style['name'] == newest['title'])
        manifest_styles = {style['id']: style for style in manifest['styles']}
        self.assertEqual((job['added'], job['updated'], job['prepared']), (1, 0, 1))
        self.assertNotIn('active_style_ids', manifest)
        self.assertEqual(set(manifest_styles), set(old_ids) | {newest_id})
        for style_id, style in old_styles.items():
            self.assertEqual(manifest_styles[style_id], style)
        self.assertEqual(manifest['future_extension'], previous['future_extension'])
        self.assertEqual(backup, previous)
        self.assertNotEqual(before, path.read_bytes())
        self.assertEqual((self.imported / 'excluded_styles.json').read_bytes(), exclusions)
        self.assertEqual({style['id'] for style in self.catalog.list_styles()},
                         (set(old_ids) - {old_ids[0]}) | {newest_id})
        for old_id in old_ids:
            self.assertEqual(self.catalog.get_style(old_id)['id'], old_id)
            self.assertEqual(self.catalog.preview_path(old_id, full=True).read_bytes(), old_preview_bytes[old_id])

    def test_empty_huggingface_append_unhides_legacy_cards_but_keeps_manual_exclusions(self):
        legacy_id = self.add_legacy_v5_style(source_image())
        added = source_image('artist:sync-active, ink', color='red')
        self.assertEqual(self.run_huggingface([added])['added'], 1)
        path = self.imported / 'sync_catalog.json'
        manifest = json.loads(path.read_text(encoding='utf-8'))
        active_id = manifest['styles'][0]['id']
        manifest['active_style_ids'] = [active_id]
        path.write_text(json.dumps(manifest, indent=2), encoding='utf-8')

        self.assertEqual([style['id'] for style in self.catalog.list_styles()], [active_id])
        self.catalog.remove_styles([active_id])
        exclusions_path = self.imported / 'excluded_styles.json'
        exclusions_before = exclusions_path.read_bytes()
        self.assertEqual(self.catalog.list_styles(), [])

        job = self.run_huggingface([])

        published = json.loads(path.read_text(encoding='utf-8'))
        self.assertEqual((job['status'], job['added'], job['updated'], job['prepared']),
                         ('completed', 0, 0, 0))
        self.assertNotIn('active_style_ids', published)
        self.assertEqual([style['id'] for style in self.catalog.list_styles()], [legacy_id])
        self.assertEqual(self.catalog.get_style(active_id)['id'], active_id)
        self.assertEqual(exclusions_path.read_bytes(), exclusions_before)

    def test_huggingface_append_keeps_an_overlapping_legacy_snapshot_record_readable(self):
        legacy_id = self.add_legacy_v5_style(source_image())
        legacy = self.catalog.get_style(legacy_id)
        original_preview = self.catalog.preview_path(legacy_id, full=True).read_bytes()
        previous_record = {
            'id': legacy_id, 'name': 'Earlier synced snapshot', 'model': 'nai-diffusion-5-full',
            'positive': legacy['positive'], 'negative': legacy['negative'], 'seed': 27,
            'options': {'steps': 29, 'cfg': 6, 'cfg_rescale': 0, 'sampler': 'k_euler_ancestral',
                        'noise_schedule': 'karras'},
            'source_image_id': 'legacy-snapshot-source', 'source_url': legacy['source_url'],
            'preview': {'image': 'legacy-originals/legacy.png',
                        'thumbnail': 'legacy-thumbnails/legacy.webp', 'width': 64, 'height': 128},
        }
        path = self.imported / 'sync_catalog.json'
        path.write_text(json.dumps({
            'version': 1, 'source_image_root': '.', 'styles': [previous_record], 'seen_images': [],
            'active_style_ids': [legacy_id], 'huggingface': {'update_mode': 'replace'},
        }, indent=2), encoding='utf-8')

        self.assertEqual(self.catalog.get_style(legacy_id)['name'], 'Earlier synced snapshot')
        job = self.run_huggingface([])

        manifest = json.loads(path.read_text(encoding='utf-8'))
        self.assertEqual((job['status'], job['added'], job['updated']), ('completed', 0, 0))
        self.assertNotIn('active_style_ids', manifest)
        self.assertEqual(manifest['styles'], [previous_record])
        self.assertEqual(manifest['huggingface']['update_mode'], 'append')
        self.assertEqual(self.catalog.get_style(legacy_id)['name'], 'Earlier synced snapshot')
        self.assertEqual(self.catalog.get_style(legacy_id)['options'], previous_record['options'])
        self.assertEqual(self.catalog.preview_path(legacy_id, full=True).read_bytes(), original_preview)

    def test_huggingface_groups_each_post_recipe_and_deduplicates_across_posts(self):
        same_post_first = source_image('artist:first, watercolor', color='blue')
        same_post_second = source_image('artist:second, ink', color='red')
        same_post_first['image_url'] = 'https://ac.namu.la/same-post-first.png'
        same_post_second['image_url'] = 'https://ac.namu.la/same-post-second.png'
        same_post_second['source_url'] = same_post_first['source_url']
        job = self.run_huggingface([same_post_first, same_post_second])
        manifest = json.loads((self.imported / 'sync_catalog.json').read_text(encoding='utf-8'))
        self.assertEqual((job['added'], job['skipped']), (2, 0))
        self.assertEqual(len(manifest['styles']), 2)
        self.assertEqual(len({style['source_image_id'] for style in manifest['styles']}), 2)
        self.assertEqual({style['positive'] for style in manifest['styles']},
                         {'artist:first, watercolor', 'artist:second, ink'})

        same_recipe_first = source_image('artist:cross-post, watercolor', color='green')
        same_recipe_second = source_image('artist:cross-post, watercolor', color='yellow')
        same_recipe_first['image_url'] = 'https://ac.namu.la/post-one.png'
        same_recipe_second['image_url'] = 'https://ac.namu.la/post-two.png'
        same_recipe_first['source_url'] = 'https://arca.live/b/aiart/one'
        same_recipe_second['source_url'] = 'https://arca.live/b/aiart/two'
        dedupe_job = self.run_huggingface([same_recipe_first, same_recipe_second])
        after = json.loads((self.imported / 'sync_catalog.json').read_text(encoding='utf-8'))
        self.assertEqual((dedupe_job['added'], dedupe_job['skipped']), (1, 1))
        self.assertEqual(len(after['styles']), 3)

    def test_huggingface_recognizes_hashed_full_webp_metadata_without_filters(self):
        recognized = webp_source_image()
        recognized['image_url'] = 'https://ac.namu.la/recognized.webp'
        unsupported = webp_source_image('artist:unsupported, ink',
                                        model='NovelAI Diffusion V5 DB276663', color='red')
        unsupported['image_url'] = 'https://ac.namu.la/unsupported.webp'

        job = self.run_huggingface([recognized, unsupported])

        manifest = json.loads((self.imported / 'sync_catalog.json').read_text(encoding='utf-8'))
        self.assertEqual((job['added'], job['prepared'], job['filtered'], job['skipped']), (1, 1, 0, 1))
        self.assertEqual(len(manifest['styles']), 1)
        style = manifest['styles'][0]
        self.assertEqual(style['model'], 'nai-diffusion-5-full')
        self.assertEqual(Path(style['preview']['image']).suffix, '.webp')
        self.assertTrue(self.catalog.preview_path(style['id'], full=True).is_file())

    def test_huggingface_failure_or_stop_after_preparing_keeps_catalog_unpublished_and_closes_source(self):
        self.run_huggingface([source_image()])
        path = self.imported / 'sync_catalog.json'
        before = path.read_bytes()
        visible_before = {style['id'] for style in self.catalog.list_styles()}

        class ControlledArchive:
            def __init__(self, manager, mode):
                self.manager = manager
                self.mode = mode
                self.index = 0
                self.closed = False

            def __iter__(self):
                return self

            def __next__(self):
                if self.index == 0:
                    self.index += 1
                    return source_image('artist:failure-check, watercolor', color='red')
                if self.index == 1 and self.mode == 'stop':
                    self.index += 1
                    self.manager._stop.set()
                    return source_image('artist:never-published, ink', color='green')
                if self.index == 1:
                    self.index += 1
                    raise RuntimeError('synthetic archive failure')
                raise StopIteration

            def close(self):
                self.closed = True

        for mode, expected_status in (('failure', 'failed'), ('stop', 'stopped')):
            with self.subTest(mode=mode):
                source = ControlledArchive(self.manager, mode)
                def archive(root, stop, progress):
                    progress(phase='inspect', phase_current=0, phase_total=0, total_images=2)
                    return source
                self.manager.archive_provider = archive
                self.manager.start({'source': 'huggingface'})
                self.assertTrue(self.manager.wait())
                job = self.manager.status()['job']
                self.assertEqual(job['status'], expected_status)
                self.assertEqual((job['prepared'], job['added'], job['updated'], job['published']),
                                 (1, 0, 0, False))
                self.assertEqual((job['phase'], job['processed_images'], job['total_images']),
                                 ('inspect', 1, 2))
                self.assertEqual(path.read_bytes(), before)
                self.assertEqual({style['id'] for style in self.catalog.list_styles()}, visible_before)
                self.assertTrue(source.closed)

    def test_huggingface_backup_and_atomic_publish_failures_preserve_existing_catalog(self):
        self.run_huggingface([source_image()])
        path = self.imported / 'sync_catalog.json'
        before = path.read_bytes()
        candidate = source_image('artist:atomic-check, ink', color='red')
        original_replace = __import__('os').replace

        for fail_name in ('sync_catalog.before-huggingface.json', 'sync_catalog.json'):
            with self.subTest(fail_name=fail_name):
                def fail_replace(source, target):
                    if Path(target).name == fail_name:
                        raise OSError('synthetic atomic replacement failure')
                    return original_replace(source, target)

                with mock.patch('naim.storage.json_files.os.replace', side_effect=fail_replace):
                    job = self.run_huggingface([candidate])
                self.assertEqual(job['status'], 'failed')
                self.assertEqual((job['prepared'], job['added'], job['updated'], job['published']),
                                 (1, 0, 0, False))
                self.assertEqual(path.read_bytes(), before)

    def test_invalid_filters_fail_before_starting_thread_or_creating_data(self):
        invalid_filters = (
            {'exclude_realistic': 1}, {'include_tags': ['\n']}, {'include_query': '||'},
            {'low_recommendation_limit': True}, {'low_recommendation_limit': '10'},
            {'low_recommendation_limit': 1.5}, {'low_recommendation_limit': -1},
            {'low_recommendation_limit': 9007199254740992},
        )
        requests = [
            {'source': 'huggingface', 'filters': filters}
            for filters in invalid_filters
        ] + [
            {**self.period, 'filters': filters}
            for filters in invalid_filters
        ]
        for request in requests:
            with self.subTest(request=request), self.assertRaises(ValueError):
                self.manager.start(request)
            self.assertFalse(self.imported.exists())
            self.assertIsNone(self.manager._thread)
        self.manager.archive_provider = mock.Mock()
        self.assertFalse(self.imported.exists())
        self.manager.archive_provider.assert_not_called()

    def test_huggingface_filters_recheck_before_duplicates_and_preserve_prior_styles(self):
        upper_id = self.add_upper_style()
        images = [source_image('artist:synthetic, watercolor', color='blue'),
                  source_image('artist:other, ink', color='red'),
                  source_image('artist:third, watercolor, ink', color='green'),
                  source_image('artist:v45, watercolor, ink', model='nai-diffusion-4-5-full', color='yellow')]
        for index, image in enumerate(images):
            image['image_url'] = f'https://ac.namu.la/filter-{index}.png'

        any_job = self.run_huggingface(images, {'include_tags': ['watercolor', 'ink'], 'include_mode': 'any'})
        self.assertEqual((any_job['prepared'], any_job['filtered'], any_job['skipped']), (3, 0, 1))
        first_manifest = json.loads((self.imported / 'sync_catalog.json').read_text(encoding='utf-8'))
        prior_ids = {style['id'] for style in first_manifest['styles']}
        self.assertEqual(len(prior_ids), 3)
        self.assertNotIn('active_style_ids', first_manifest)

        all_job = self.run_huggingface(images, {'include_tags': ['watercolor', 'ink'], 'include_mode': 'all'})
        self.assertEqual((all_job['prepared'], all_job['filtered'], all_job['skipped']), (0, 2, 2))

        empty_job = self.run_huggingface(images, {'include_tags': ['watercolor'],
                                                  'exclude_tags': ['watercolor']})
        manifest = json.loads((self.imported / 'sync_catalog.json').read_text(encoding='utf-8'))
        self.assertEqual((empty_job['prepared'], empty_job['filtered'], empty_job['skipped']), (0, 3, 1))
        self.assertEqual({style['id'] for style in manifest['styles']}, prior_ids)
        self.assertEqual({style['id'] for style in self.catalog.list_styles()}, prior_ids | {upper_id})

    def test_huggingface_query_filters_reapply_mixed_groups_to_positive_source(self):
        images = [source_image('artist:synthetic, watercolor, sketch', color='blue'),
                  source_image('artist:other, ink', color='red'),
                  source_image('artist:third, watercolor', color='green', negative='ink')]
        for index, image in enumerate(images):
            image['image_url'] = f'https://ac.namu.la/query-{index}.png'
        query = 'watercolor, sketch || ink'
        job = self.run_huggingface(images, {'include_query': query})
        self.assertEqual((job['prepared'], job['filtered']), (2, 1))
        manifest = json.loads((self.imported / 'sync_catalog.json').read_text(encoding='utf-8'))
        self.assertEqual(manifest['huggingface']['filters']['include_query'], query)
        job = self.run_huggingface(images, {'include_query': 'watercolor, sketch'})
        self.assertEqual((job['prepared'], job['filtered'], job['skipped']), (0, 2, 1))

    def test_huggingface_realism_filter_ignores_negative_and_allows_opt_in_record(self):
        realistic_positive = source_image('artist:synthetic, watercolor, photorealistic', color='blue')
        negative_realistic = source_image('artist:other, ink', color='red', negative='photorealistic, lowres')
        realistic_positive['image_url'] = 'https://ac.namu.la/positive-realistic.png'
        negative_realistic['image_url'] = 'https://ac.namu.la/negative-realistic.png'

        default_job = self.run_huggingface([realistic_positive, negative_realistic])
        self.assertEqual((default_job['prepared'], default_job['filtered']), (1, 1))
        default_manifest = json.loads((self.imported / 'sync_catalog.json').read_text(encoding='utf-8'))
        negative_id = default_manifest['styles'][0]['id']
        self.assertEqual(self.catalog.get_style(negative_id)['negative'], 'photorealistic, lowres')

        opt_in_job = self.run_huggingface([realistic_positive, negative_realistic],
                                          {'exclude_realistic': False})
        manifest = json.loads((self.imported / 'sync_catalog.json').read_text(encoding='utf-8'))
        realistic_id = next(style['id'] for style in manifest['styles']
                            if 'photorealistic' in style['positive'])
        raw_record = next(style for style in manifest['styles'] if style['id'] == realistic_id)
        self.assertEqual((opt_in_job['prepared'], opt_in_job['filtered'], opt_in_job['skipped']), (1, 0, 1))
        self.assertTrue(raw_record['allow_realistic'])
        self.assertEqual(self.catalog.get_style(realistic_id)['id'], realistic_id)

    def test_huggingface_filter_can_select_source_tag_removed_from_saved_recipe(self):
        image = source_image('artist:synthetic, watercolor, 1girl')
        image['image_url'] = 'https://ac.namu.la/source-tag.png'
        job = self.run_huggingface([image], {'include_tags': ['1girl']})
        manifest = json.loads((self.imported / 'sync_catalog.json').read_text(encoding='utf-8'))
        self.assertEqual((job['prepared'], job['filtered']), (1, 0))
        record = manifest['styles'][0]
        self.assertNotIn('1girl', record['positive'])

    def test_huggingface_duplicate_recipes_do_not_overwrite_existing_preview(self):
        first = source_image(color='blue')
        duplicate = source_image(color='red')
        duplicate['image_url'] = 'https://ac.namu.la/duplicate-recipe.png'
        job = self.run_huggingface([first, duplicate])
        path = self.imported / 'sync_catalog.json'
        manifest = json.loads(path.read_text(encoding='utf-8'))
        self.assertEqual((job['prepared'], job['skipped']), (1, 1))
        self.assertNotIn('active_style_ids', manifest)
        self.assertEqual(len(manifest['styles']), 1)

        style_id = manifest['styles'][0]['id']
        preview = self.catalog.preview_path(style_id, full=True)
        preview.write_bytes(b'corrupt synthetic preview')
        repeated = self.run_huggingface([first])
        self.assertEqual((repeated['prepared'], repeated['updated'], repeated['skipped']), (0, 0, 1))
        self.assertEqual(preview.read_bytes(), b'corrupt synthetic preview')

    def test_arca_append_after_huggingface_keeps_new_record_active(self):
        first = source_image(color='blue')
        self.run_huggingface([first])
        before = json.loads((self.imported / 'sync_catalog.json').read_text(encoding='utf-8'))
        new_arca = source_image('artist:arca-only, ink', color='red')
        new_arca['image_url'] = 'https://ac.namu.la/arca-after-hf.png'
        job = self.run_job([new_arca])
        manifest = json.loads((self.imported / 'sync_catalog.json').read_text(encoding='utf-8'))
        self.assertEqual(job['added'], 1)
        self.assertNotIn('active_style_ids', before)
        self.assertNotIn('active_style_ids', manifest)
        self.assertEqual(len(manifest['styles']), 2)
        self.assertEqual({style['id'] for style in self.catalog.list_styles()},
                         {style['id'] for style in manifest['styles']})

    def test_unknown_import_source_is_rejected_before_writing(self):
        with self.assertRaises(ValueError):
            self.manager.start({'source': 'unknown'})
        self.assertFalse(self.imported.exists())


class DakiStyleSyncApiTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.manager = mock.Mock()
        self.manager.client.connected = False
        self.manager.status.return_value = {'connected': False, 'job': None}
        with mock.patch('naim.web.daki_style_sync.DakiStyleSync', return_value=self.manager):
            register_daki_style_sync_routes(self.app, lambda: 'unused', mock.Mock())
        self.client = self.app.test_client()
        self.bridge = '/api/arca-styles/browser-session/extension'
        self.headers = {'Origin': 'chrome-extension://synthetic', 'X-Arca-Session-Bridge': '1'}

    def test_extension_origin_loopback_size_and_preflight(self):
        for headers in ({}, {**self.headers, 'Origin': 'https://example.test'}):
            self.assertEqual(self.client.post(self.bridge, json={}, headers=headers).status_code, 403)
        self.assertEqual(self.client.post(self.bridge, json={}, headers=self.headers,
                                         environ_base={'REMOTE_ADDR': '192.0.2.1'}).status_code, 403)
        self.manager.connect.assert_not_called()
        response = self.client.options(self.bridge, headers=self.headers)
        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.headers['Access-Control-Allow-Origin'], self.headers['Origin'])
        self.assertEqual(self.client.post(self.bridge, json={'cookies': []}, headers=self.headers).status_code, 200)
        self.manager.connect.assert_called_once_with({'cookies': []})

    def test_bridge_errors_do_not_expose_session_or_paths(self):
        self.manager.connect.side_effect = ValueError('synthetic private value')
        response = self.client.post(self.bridge, json={}, headers=self.headers)
        self.assertEqual(response.status_code, 400)
        self.assertNotIn('synthetic private value', response.get_data(as_text=True))

    def test_connection_status_only_reads_memory_with_the_existing_bridge_boundary(self):
        endpoint = '/api/arca-styles/browser-session'
        self.manager.client.connected = True
        response = self.client.get(endpoint, headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertIs(response.json['connected'], True)
        self.assertEqual(response.headers['Access-Control-Allow-Origin'], self.headers['Origin'])
        self.manager.connect.assert_not_called()
        self.manager.status.assert_not_called()
        self.assertTrue(self.client.get(endpoint, headers={'X-Arca-Session-Bridge': '1'}).json['connected'])
        for headers in ({}, {**self.headers, 'Origin': 'https://example.test'}):
            self.assertIn(self.client.get(endpoint, headers=headers).status_code, (400, 403))
        self.assertEqual(self.client.options(endpoint).status_code, 403)
        self.assertEqual(self.client.get(endpoint, headers=self.headers,
                                         environ_base={'REMOTE_ADDR': '192.0.2.1'}).status_code, 403)

    def test_failed_reconnection_response_reports_the_existing_connection(self):
        self.manager.client.connected = True
        for error in (ArcaSharedError('HTTP 429', 'rate_limited'), ValueError('synthetic private value')):
            self.manager.connect.side_effect = error
            response = self.client.post(self.bridge, json={}, headers=self.headers)
            self.assertEqual(response.status_code, 400)
            self.assertIs(response.json['connected'], True)
            self.assertNotIn('synthetic private value', response.get_data(as_text=True))

    def test_bridge_preserves_safe_collector_reason_instead_of_generic_login_error(self):
        self.manager.connect.side_effect = ArcaSharedError('아카라이브가 HTTP 403 응답으로 접속을 거부했습니다.', 'http_error')
        response = self.client.post(self.bridge, json={}, headers=self.headers)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json['code'], 'http_error')
        self.assertIn('HTTP 403', response.json['message'])
        self.assertEqual(response.headers['Access-Control-Allow-Origin'], self.headers['Origin'])

    def test_status_start_stop_and_extension_archive(self):
        endpoint = '/api/daki/shared-styles/sync'
        self.assertFalse(self.client.get(endpoint).json['connected'])
        self.manager.start.return_value = self.manager.stop.return_value = {'connected': True, 'job': {'status': 'running'}}
        self.assertEqual(self.client.post(endpoint, json={'start_date': '2026-01-01'}).status_code, 200)
        self.manager.start.assert_called_once_with({'start_date': '2026-01-01'})
        self.assertEqual(self.client.post(endpoint + '/stop', json={}).status_code, 200)
        response = self.client.get(endpoint + '/extension')
        self.assertEqual(response.status_code, 200)
        with zipfile.ZipFile(io.BytesIO(response.data)) as archive:
            self.assertEqual(len(archive.namelist()), 4)
            script = archive.read('nai_arca_session_bridge/popup.js').decode()
            self.assertIn('127.0.0.1:5000', script)
            self.assertIn('127.0.0.1:5001', script)
            manifest = json.loads(archive.read('nai_arca_session_bridge/manifest.json'))
            self.assertEqual(manifest['version'], '1.1.1')
        response.close()


if __name__ == '__main__':
    unittest.main()
