"""Read migrated Daki images only from generated temporary fixtures."""
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

from PIL import Image

from naim.daki_drafts import DakiDrafts
from naim.daki_image_refs import resolve_daki_image_reference
from naim.daki_style_tests import DakiStyleTests
from naim.daki_tag_catalog import DakiTagCatalog
from naim.images.webp_conversion import convert_image_to_webp
from naim.storage.daki_shared_styles import DakiSharedStyles
from tests.test_daki_drafts import synthetic_settings
from tests.test_daki_style_tests import synthetic_request, synthetic_styles


class DakiWebpReadTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    @staticmethod
    def convert(source):
        result = convert_image_to_webp(source, quality=90)
        if result['status'] != 'converted':
            raise AssertionError(f'synthetic image did not convert: {result}')
        return source.with_suffix('.webp') if source.suffix.lower() == '.png' else Path(str(source) + '.webp')

    @staticmethod
    def image(path, image_format=None, size=(32, 24)):
        path.parent.mkdir(parents=True, exist_ok=True)
        selected_format = image_format or Image.registered_extensions().get(path.suffix.lower())
        mode = 'RGB' if selected_format == 'JPEG' else 'RGBA'
        color = (25, 80, 130) if mode == 'RGB' else (25, 80, 130, 255)
        Image.new(mode, size, color).save(path, format=image_format)

    def test_draft_full_preview_prompt_reference_and_framing_keep_metadata(self):
        root = self.root / 'drafts'
        manager = DakiDrafts(root, lambda: 'synthetic-key',
            generator=lambda key, payload: Image.new('RGBA', (
                payload['parameters']['width'], payload['parameters']['height']), (25, 80, 130, 255)))
        self.addCleanup(manager.wait)
        draft = manager.create(synthetic_settings(prompt='synthetic framing prompt', seed=123))
        self.assertTrue(manager.wait())
        directory = root / draft['id']
        full_webp = self.convert(directory / 'image.png')
        preview_webp = self.convert(directory / 'preview.jpg')

        self.assertEqual(manager.image_path(draft['id'], full=True), full_webp)
        self.assertEqual(manager.image_path(draft['id']), preview_webp)
        self.assertEqual(resolve_daki_image_reference(draft['path'], None, manager),
                         (str(full_webp), draft['path']))
        row, = list(manager.iter_completed_prompt_images())
        self.assertEqual(row['path'], f"__daki_drafts__/{draft['id']}.png")
        self.assertEqual(row['prompt_info']['prompt'], 'synthetic framing prompt')
        original_resolve = Path.resolve
        escaped = self.root / 'escaped.webp'

        def redirect_draft(path, *args, **kwargs):
            return escaped if path == full_webp else original_resolve(path, *args, **kwargs)

        with mock.patch.object(Path, 'resolve', redirect_draft):
            with self.assertRaises(ValueError):
                manager.image_path(draft['id'], full=True)

        framed = manager.frame(draft['id'], {'width': 131, 'height': 200, 'mode': 'pad'})
        framed_path = manager.image_path(framed['id'], full=True)
        with Image.open(framed_path) as image:
            metadata = json.loads(image.info['Comment'])
        self.assertEqual((metadata['width'], metadata['height']), (131, 200))
        self.assertEqual(metadata['prompt'], 'synthetic framing prompt')

        # A newly written PNG remains preferred over an older replacement.
        self.image(directory / 'image.png')
        self.assertEqual(manager.image_path(draft['id'], full=True), directory / 'image.png')
        (directory / 'image.png').unlink()
        full_webp.unlink()
        with self.assertRaises(FileNotFoundError):
            manager.image_path(draft['id'], full=True)

    def test_style_test_full_preview_and_prompt_enumeration_resolve_replacements(self):
        root = self.root / 'style-tests'
        generator = lambda key, payload: Image.new('RGBA', (
            payload['parameters']['width'], payload['parameters']['height']), (25, 80, 130, 255))
        styles = synthetic_styles(1)
        catalog = mock.Mock()
        catalog.list_styles.return_value = styles
        manager = DakiStyleTests(lambda: root, catalog, lambda: 'synthetic-key', generator)
        self.addCleanup(manager.wait)
        batch = manager.create(synthetic_request())
        manager.run(batch['id'], 'next')
        self.assertTrue(manager.wait())
        directory = root / batch['id']
        full_webp = self.convert(directory / 'style-0.png')
        preview_webp = self.convert(directory / 'style-0.jpg')

        self.assertEqual(manager.image_path(batch['id'], 'style-0', full=True), full_webp)
        self.assertEqual(manager.image_path(batch['id'], 'style-0'), preview_webp)
        row, = list(manager.iter_completed_prompt_images())
        self.assertEqual(row['path'], f"__daki_tests__/{batch['id']}/style-0.png")
        self.assertIn('synthetic common scene', row['prompt_info']['prompt'])
        self.assertEqual(resolve_daki_image_reference(row['path'], manager),
                         (str(full_webp), row['path']))
        original_resolve = Path.resolve
        escaped = self.root / 'escaped.webp'

        def redirect_style_test(path, *args, **kwargs):
            return escaped if path == full_webp else original_resolve(path, *args, **kwargs)

        with mock.patch.object(Path, 'resolve', redirect_style_test):
            with self.assertRaises(FileNotFoundError):
                manager.image_path(batch['id'], 'style-0', full=True)

    def test_shared_catalog_full_and_thumbnail_preserve_catalog_paths(self):
        catalog = self.root / 'shared'
        image_path = catalog / 'images' / 'one.png'
        thumb_path = catalog / 'thumbs' / 'one.jpg'
        self.image(image_path)
        self.image(thumb_path, 'JPEG')
        style = {
            'id': 'synthetic-shared', 'name': 'Synthetic shared', 'model': 'nai-diffusion-5-full',
            'positive': 'synthetic ink', 'negative': '', 'source_image_id': 1,
            'preview': {'width': 32, 'height': 24, 'image': 'images/one.png',
                        'thumbnail': 'thumbs/one.jpg', 'job_id': 'synthetic-job'},
        }
        for name, data in (
            ('default_styles.json', {'styles': [style]}),
            ('source_generation_options.json', {'styles': {'synthetic-shared': {
                'source_image_id': 1, 'options': {'steps': 20}}}}),
            ('generation_manifest.json', {'jobs': {'synthetic-job': {'status': 'success', 'seed': 123}}}),
        ):
            (catalog / name).write_text(json.dumps(data), encoding='utf-8')
        store = DakiSharedStyles(catalog)
        full_webp = self.convert(image_path)
        thumb_webp = self.convert(thumb_path)

        self.assertEqual(store.preview_path('synthetic-shared', full=True), full_webp)
        self.assertEqual(store.preview_path('synthetic-shared'), thumb_webp)
        reference = '__daki_shared__/synthetic-shared.png'
        self.assertEqual(resolve_daki_image_reference(reference, SimpleNamespace(catalog=store)),
                         (str(full_webp), reference))
        self.assertEqual(store.get_style('synthetic-shared')['preview']['width'], 32)
        self.assertEqual(style['preview']['image'], 'images/one.png')

    def test_tag_catalog_examples_keep_virtual_dictionary_paths_after_conversion(self):
        source = self.root / 'dictionary'
        full_path = source / 'visuals' / 'sample.png'
        thumb_path = source / 'visuals' / 'thumb.jpg'
        self.image(full_path)
        self.image(thumb_path, 'JPEG')
        (source / 'tags.json').write_text(json.dumps({'tags': [{
            'tag': 'synthetic_example',
            'examples': [{'image': 'visuals/sample.png', 'thumbnail': 'visuals/thumb.jpg'}],
        }]}), encoding='utf-8')
        (source / 'rules.json').write_text(json.dumps({'regions': {}}), encoding='utf-8')
        catalog = DakiTagCatalog(source)
        full_webp = self.convert(full_path)
        thumb_webp = self.convert(thumb_path)

        self.assertEqual(catalog.example_path('synthetic_example', full=True), full_webp)
        self.assertEqual(catalog.example_path('synthetic_example'), thumb_webp)

        tags = json.loads((source / 'tags.json').read_text(encoding='utf-8'))
        tags['tags'][0]['examples'][0].update(image='visuals/invalid.txt', thumbnail='visuals/invalid.txt')
        (source / 'tags.json').write_text(json.dumps(tags), encoding='utf-8')
        self.image(source / 'visuals' / 'invalid.txt.webp', 'WEBP')
        with self.assertRaises(ValueError):
            catalog.example_path('synthetic_example', full=True)

    def test_export_reference_stays_png_shaped_and_resolves_webp_then_original_wins(self):
        exports = self.root / 'exports'
        project_id, export_id = 'a' * 32, 'b' * 32
        directory = exports / project_id
        source = directory / f'{export_id}.png'
        self.image(source)
        reference = f'__daki_exports__/{project_id}/{export_id}.png'
        webp = self.convert(source)
        self.assertEqual(resolve_daki_image_reference(reference, None, project_exports_root=exports),
                         (str(webp), reference))

        self.image(source)
        self.assertEqual(resolve_daki_image_reference(reference, None, project_exports_root=exports),
                         (str(source), reference))

        source.unlink()
        webp.unlink()
        with self.assertRaises(FileNotFoundError):
            resolve_daki_image_reference(reference, None, project_exports_root=exports)

    def test_resolved_candidates_cannot_escape_catalog_visuals_or_export_roots(self):
        outside = self.root / 'outside.webp'
        self.image(outside, 'WEBP')
        catalog_root = self.root / 'safe-catalog'
        catalog_root.mkdir()
        catalog_candidate = catalog_root / 'sample.webp'
        self.image(catalog_candidate, 'WEBP')

        dictionary = self.root / 'safe-dictionary'
        (dictionary / 'visuals').mkdir(parents=True)
        (dictionary / 'tags.json').write_text(json.dumps({'tags': [{
            'tag': 'synthetic_example',
            'examples': [{'image': 'visuals/sample.png', 'thumbnail': 'visuals/sample.png'}],
        }]}), encoding='utf-8')
        (dictionary / 'rules.json').write_text(json.dumps({'regions': {}}), encoding='utf-8')
        visuals_candidate = dictionary / 'visuals' / 'sample.webp'
        self.image(visuals_candidate, 'WEBP')

        exports = self.root / 'safe-exports'
        project_id, export_id = 'c' * 32, 'd' * 32
        project_dir = exports / project_id
        project_dir.mkdir(parents=True)
        reference = f'__daki_exports__/{project_id}/{export_id}.png'
        export_candidate = project_dir / f'{export_id}.webp'
        self.image(export_candidate, 'WEBP')

        original_resolve = Path.resolve

        def redirected(path, *args, **kwargs):
            if path in {catalog_candidate, visuals_candidate, export_candidate}:
                return outside
            return original_resolve(path, *args, **kwargs)

        with mock.patch.object(Path, 'resolve', redirected):
            with self.assertRaises(ValueError):
                DakiSharedStyles._image_path(catalog_root, 'sample.png')
            with self.assertRaises(ValueError):
                DakiTagCatalog(dictionary).example_path('synthetic_example')
            with self.assertRaises(ValueError):
                resolve_daki_image_reference(reference, None, project_exports_root=exports)

    def test_webp_replacement_symlink_cannot_escape_its_source_directory(self):
        directory = self.root / 'symlink-source'
        directory.mkdir()
        outside = self.root / 'outside.webp'
        self.image(outside, 'WEBP')
        source = directory / 'sample.png'
        candidate = directory / 'sample.webp'
        try:
            candidate.symlink_to(outside)
        except (OSError, NotImplementedError) as error:
            self.skipTest(f'filesystem does not permit synthetic symlinks: {error}')
        from naim.images.webp_conversion import resolve_webp_image
        with self.assertRaises(ValueError):
            resolve_webp_image(source)


if __name__ == '__main__':
    unittest.main()
