import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
from unittest import mock

from PIL import Image

from tools import export_daki_test_packs as export_builder
from tools.export_daki_test_packs import MANIFEST, export_packs


class DakiTestPackExportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1])
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.tests_root = self.root / 'tests'
        self.tests_root.mkdir()
        self.catalog_root = self.root / 'catalog'
        self.catalog_root.mkdir()
        self.imported_root = self.root / 'imported'
        self.imported_root.mkdir()
        self.output = self.root / 'export'

    @staticmethod
    def image_bytes(image_format='PNG', color='purple'):
        image = Image.new('RGBA', (64, 128), color)
        output = io.BytesIO()
        image.save(output, format=image_format)
        image.close()
        return output.getvalue()

    @staticmethod
    def batch(batch_id='a' * 32, *, status='completed', library='shared', count=1,
              output_format='png', legacy=False):
        items = []
        for index in range(count):
            style_id = f'style-{index}'
            items.append({
                'style_id': style_id,
                'status': 'completed',
                'style': {
                    'id': style_id, 'name': f'Synthetic style {index}',
                    'model': 'nai-diffusion-4-5-full',
                    'positive': f'synthetic style prompt {index}',
                    'negative': f'synthetic style negative {index}',
                    'source_image_id': f'source-{index}',
                    'source_url': 'https://example.invalid/source',
                    'recommendation_count': 23,
                    'recommendation_collected_at': '2026-01-01T00:00:00+00:00',
                    'options': {'steps': 20, 'cfg': 4.5, 'root': 'private root',
                                'source_path': 'private file', 'api_key': 'private key'},
                    'seed': 1234, 'category': 'synthetic',
                    'preview': {'width': 64, 'height': 128, 'filename': 'private.png',
                                'root': 'private root'},
                    'sort_date': '2026-01-01', 'api_key': 'private key',
                    'source_path': 'private file',
                },
                'output_format': output_format,
                'payload': {
                    'input': f'synthetic full request {index}',
                    'model': 'nai-diffusion-5-full', 'action': 'generate',
                    'parameters': {
                        'width': 64, 'height': 128, 'steps': 20,
                        'negative_prompt': 'synthetic generation negative',
                        'nested_snapshot': {'keep': 'generation setting', 'root': 'private root',
                                            'source_path': 'private file'},
                    },
                    'api_key': 'private key',
                },
                'legacy_preview': legacy,
                'root': 'private root', 'source_path': 'private file', 'error': 'private diagnostic',
            })
        return {
            'id': batch_id, 'name': 'Synthetic completed pack', 'library': library,
            'origin': 'shared_upper' if legacy else None, 'status': status,
            'created_at': '2026-01-01T00:00:00+00:00',
            'updated_at': '2026-01-02T00:00:00+00:00',
            'prompt': 'synthetic common prompt', 'negative_prompt': 'synthetic common negative',
            'model': 'nai-diffusion-5-full', 'width': 64, 'height': 128,
            'output_format': 'png',
            'char_prompts': [{'prompt': 'synthetic character', 'negative_prompt': 'synthetic character negative',
                              'source_path': 'private file'}],
            'items': items,
            'api_key': 'private key', 'root': 'private root', 'source_path': 'private file',
        }

    def write_batch(self, batch, images=None):
        batch_id = batch['id']
        directory = self.tests_root / batch_id
        directory.mkdir()
        (directory / 'batch.json').write_text(json.dumps(batch), encoding='utf-8')
        source_images = [self.image_bytes()] * len(batch['items']) if images is None else images
        for item, image in zip(batch['items'], source_images):
            suffix = '.webp' if item.get('output_format') == 'webp' else '.png'
            (directory / (item['style_id'] + suffix)).write_bytes(image)
        return directory

    def export(self, batch_ids=None, output=None):
        selected = ['a' * 32] if batch_ids is None else batch_ids
        destination = self.output if output is None else output
        return export_packs(self.tests_root, self.catalog_root, self.imported_root,
                            destination, selected)

    def test_exports_png_and_webp_with_safe_editable_snapshot_and_exact_manifest(self):
        batch = self.batch(count=2)
        png = self.image_bytes('PNG', 'purple')
        webp = self.image_bytes('WEBP', 'green')
        batch['items'][1]['style_id'] = 'style-webp'
        batch['items'][1]['style']['id'] = 'style-webp'
        batch['items'][1]['output_format'] = 'webp'
        directory = self.write_batch(batch, [png, webp])
        original_batch = (directory / 'batch.json').read_bytes()

        manifest = self.export()

        pack = manifest['packs'][0]
        archive_path = self.output / pack['filename']
        archive_bytes = archive_path.read_bytes()
        with zipfile.ZipFile(archive_path) as exported_archive:
            expanded_bytes = sum(info.file_size for info in exported_archive.infolist())
        self.assertEqual(pack, {
            'id': 'a' * 32,
            'name': 'Synthetic completed pack',
            'filename': 'style_test_' + 'a' * 32 + '.zip',
            'bytes': len(archive_bytes),
            'sha256': hashlib.sha256(archive_bytes).hexdigest(),
            'image_count': 2,
            'expanded_bytes': expanded_bytes,
        })
        self.assertEqual(json.loads((self.output / MANIFEST).read_text('utf-8')), manifest)
        self.assertEqual((directory / 'batch.json').read_bytes(), original_batch)
        self.assertEqual((directory / 'style-0.png').read_bytes(), png)
        self.assertEqual((directory / 'style-webp.webp').read_bytes(), webp)

        with zipfile.ZipFile(archive_path) as archive:
            self.assertEqual(set(archive.namelist()), {
                'batch.json', 'style-0.png', 'style-0.jpg', 'style-webp.webp', 'style-webp.jpg',
            })
            saved = json.loads(archive.read('batch.json'))
            self.assertEqual(saved['prompt'], 'synthetic common prompt')
            self.assertEqual(saved['items'][0]['payload']['parameters']['steps'], 20)
            self.assertEqual(saved['items'][0]['payload']['parameters']['nested_snapshot']['keep'],
                             'generation setting')
            self.assertNotIn('root', saved['items'][0]['payload']['parameters']['nested_snapshot'])
            self.assertEqual([item['output_format'] for item in saved['items']], ['png', 'webp'])
            self.assertNotIn('legacy_preview', saved['items'][0])
            self.assertNotIn('api_key', saved)
            self.assertNotIn('source_path', saved)
            self.assertNotIn('root', saved['items'][0]['style'])
            self.assertNotIn('source_path', saved['items'][0]['style'])
            self.assertNotIn('filename', saved['items'][0]['style']['preview'])
            self.assertNotIn('api_key', saved['items'][0]['style']['options'])
            self.assertEqual(archive.read('style-0.png'), png)
            self.assertEqual(archive.read('style-webp.webp'), webp)
            for thumb_name in ('style-0.jpg', 'style-webp.jpg'):
                with Image.open(io.BytesIO(archive.read(thumb_name))) as thumb:
                    self.assertEqual(thumb.format, 'JPEG')
                    self.assertEqual(thumb.mode, 'RGB')
                    self.assertLessEqual(max(thumb.size), 512)
        self.assertEqual(sorted(path.name for path in self.output.iterdir()),
                         sorted([MANIFEST, pack['filename']]))

    def test_legacy_preview_uses_catalog_full_image_and_exports_normal_item(self):
        batch = self.batch(legacy=True)
        directory = self.write_batch(batch, images=[])
        legacy_path = self.root / 'legacy-full.webp'
        legacy_bytes = self.image_bytes('WEBP', 'orange')
        legacy_path.write_bytes(legacy_bytes)
        with mock.patch('tools.export_daki_test_packs.DakiSharedStyles') as catalog_type:
            catalog = catalog_type.return_value
            catalog.preview_path.return_value = legacy_path
            manifest = self.export()
        self.assertEqual(catalog.preview_path.call_args_list,
                         [mock.call('style-0', full=True), mock.call('style-0', full=True)])
        with zipfile.ZipFile(self.output / manifest['packs'][0]['filename']) as archive:
            saved = json.loads(archive.read('batch.json'))
            self.assertNotIn('legacy_preview', saved['items'][0])
            self.assertEqual(saved['items'][0]['output_format'], 'webp')
            self.assertEqual(archive.read('style-0.webp'), legacy_bytes)
        self.assertFalse((directory / 'style-0.png').exists())

    def test_rejects_incomplete_personal_invalid_and_duplicate_batches(self):
        variants = [
            ('running', self.batch(batch_id='1' * 32, status='running'), ['1' * 32]),
            ('personal library', self.batch(batch_id='2' * 32, library='personal'), ['2' * 32]),
            ('invalid item id', self.batch(batch_id='3' * 32), ['3' * 32]),
            ('malformed id', self.batch(batch_id='A' * 32), ['A' * 32]),
            ('path traversal id', self.batch(batch_id='5' * 32), ['../outside']),
            ('duplicate ids', self.batch(batch_id='6' * 32, count=2), ['6' * 32]),
        ]
        variants[2][1]['items'][0]['style_id'] = '../outside'
        variants[2][1]['items'][0]['style']['id'] = '../outside'
        variants[5][1]['items'][1]['style_id'] = 'STYLE-0'
        variants[5][1]['items'][1]['style']['id'] = 'STYLE-0'
        for index, (label, batch, ids) in enumerate(variants):
            with self.subTest(label=label):
                self.write_batch(batch)
                output = self.root / f'export-{index}'
                with self.assertRaises(ValueError):
                    self.export(ids, output=output)
                self.assertFalse(output.exists())

    def test_shared_batch_exports_personal_style_id_and_keeps_request_settings(self):
        batch = self.batch(batch_id='7' * 32)
        item = batch['items'][0]
        item['style_id'] = 'personal_sample'
        item['style']['id'] = 'personal_sample'
        item['payload']['input'] = 'synthetic personal style generation request'
        item['payload']['parameters']['steps'] = 27
        item['style']['options']['steps'] = 27
        self.write_batch(batch)

        manifest = self.export(['7' * 32], output=self.root / 'shared-personal-export')

        with zipfile.ZipFile(self.root / 'shared-personal-export' / manifest['packs'][0]['filename']) as archive:
            saved = json.loads(archive.read('batch.json'))
        self.assertEqual(saved['library'], 'shared')
        self.assertEqual(saved['items'][0]['style_id'], 'personal_sample')
        self.assertEqual(saved['items'][0]['style']['id'], 'personal_sample')
        self.assertEqual(saved['items'][0]['style']['options']['steps'], 27)
        self.assertEqual(saved['items'][0]['payload']['input'], 'synthetic personal style generation request')
        self.assertEqual(saved['items'][0]['payload']['parameters']['steps'], 27)

    def test_legacy_shared_snapshot_defaults_missing_library_and_batch_format(self):
        batch = self.batch(batch_id='8' * 32)
        batch.pop('library')
        batch.pop('output_format')
        self.write_batch(batch)

        manifest = self.export(['8' * 32], output=self.root / 'legacy-defaults-export')

        with zipfile.ZipFile(self.root / 'legacy-defaults-export' / manifest['packs'][0]['filename']) as archive:
            saved = json.loads(archive.read('batch.json'))
        self.assertEqual(saved['library'], 'shared')
        self.assertEqual(saved['output_format'], 'png')
        self.assertEqual(saved['items'][0]['output_format'], 'png')

    def test_batch_selection_requires_nonempty_unique_lowercase_ids(self):
        for batch_ids in ([], ['a' * 32, 'a' * 32], ['a' * 31 + 'A']):
            with self.subTest(batch_ids=batch_ids):
                with self.assertRaises(ValueError):
                    self.export(batch_ids, output=self.root / f'bad-selection-{len(batch_ids)}')

    def test_rejects_missing_image_dimension_mismatch_and_sensitive_parameters(self):
        batch = self.batch()
        directory = self.write_batch(batch)
        (directory / 'style-0.png').unlink()
        with self.assertRaises(ValueError):
            self.export(output=self.root / 'missing-image-export')
        self.assertFalse((self.root / 'missing-image-export').exists())

        batch = self.batch()
        batch['id'] = 'b' * 32
        batch['items'][0]['payload']['parameters']['width'] = 128
        self.write_batch(batch)
        with self.assertRaises(ValueError):
            self.export(['b' * 32], output=self.root / 'dimension-export')
        self.assertFalse((self.root / 'dimension-export').exists())

        batch = self.batch()
        batch['id'] = 'c' * 32
        batch['items'][0]['payload']['parameters']['nested'] = {'auth': {'access_token': 'synthetic secret'}}
        self.write_batch(batch)
        with self.assertRaises(ValueError):
            self.export(['c' * 32], output=self.root / 'sensitive-export')
        self.assertFalse((self.root / 'sensitive-export').exists())

    def test_rejects_existing_output_without_changing_it(self):
        self.write_batch(self.batch())
        self.output.mkdir()
        sentinel = self.output / 'keep.txt'
        sentinel.write_text('existing output', encoding='utf-8')
        with self.assertRaises(ValueError):
            self.export()
        self.assertEqual(sentinel.read_text('utf-8'), 'existing output')

    def test_failure_after_output_creation_leaves_no_archive_or_manifest(self):
        self.write_batch(self.batch())
        original_reader = export_builder._safe_image_for_item
        call_count = 0

        def fail_during_archive(item, batch_directory, catalog, *, legacy_preview=False):
            nonlocal call_count
            call_count += 1
            if call_count > 1:
                raise ValueError('synthetic archive failure')
            return original_reader(item, batch_directory, catalog, legacy_preview=legacy_preview)

        with mock.patch.object(export_builder, '_safe_image_for_item', side_effect=fail_during_archive):
            with self.assertRaises(ValueError):
                self.export()
        self.assertEqual(call_count, 2)
        self.assertFalse(self.output.exists())

    def test_rejects_batch_image_symlink_when_supported(self):
        batch = self.batch()
        directory = self.write_batch(batch)
        source = directory / 'style-0.png'
        outside = self.root / 'outside.png'
        outside.write_bytes(source.read_bytes())
        source.unlink()
        try:
            source.symlink_to(outside)
        except (OSError, NotImplementedError):
            self.skipTest('symbolic links are unavailable in this environment')
        with self.assertRaises(ValueError):
            self.export()
        self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
