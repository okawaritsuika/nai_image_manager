from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

from flask import Flask
from PIL import Image

from naim.style_manager import naim_shared_library as library


STYLE_ID = 'common-' + 'a' * 24
STYLE = {'id': STYLE_ID, 'name': 'Synthetic style', 'positive': 'artist:alpha',
         'model': 'nai-diffusion-5-full', 'sources': []}


class InternalStyleLibraryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.image = Path(temporary.name) / 'synthetic.png'
        Image.new('RGB', (2, 2), 'blue').save(self.image)
        self.catalog = Mock()
        self.catalog.warnings = ['Synthetic warning']
        self.catalog.public_records.return_value = [deepcopy(STYLE)]
        self.catalog.preview_path.return_value = self.image
        library.configure(self.catalog)
        self.addCleanup(lambda: library.configure(None))
        self.app = Flask(__name__)
        library.register_routes(self.app)
        self.client = self.app.test_client()

    def test_records_are_direct_catalog_copies_and_keep_warnings(self):
        rows = library.list_styles()
        rows[0]['name'] = 'Edited'
        self.assertEqual(library.list_styles()[0]['name'], STYLE['name'])
        self.catalog.public_records.assert_called_once_with(include_excluded=False)
        self.assertEqual(self.catalog.public_records.return_value[0]['name'], STYLE['name'])
        self.assertEqual(self.client.get('/api/naim-shared-library').json['warnings'], ['Synthetic warning'])
        library.list_styles(force=True, include_excluded=True)
        self.catalog.public_records.assert_called_with(include_excluded=True)

    def test_exclusion_uses_catalog_and_invalidates_cached_records(self):
        library.list_styles()
        library.exclude_styles([STYLE_ID])
        self.catalog.remove_styles.assert_called_once_with([STYLE_ID])
        self.catalog.public_records.return_value = []
        self.assertEqual(library.list_styles(), [])
        for value in ([], ['../../other'], 'invalid'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                library.exclude_styles(value)

    def test_exclusion_failure_is_controlled(self):
        self.catalog.remove_styles.side_effect = KeyError('missing')
        with self.assertRaises(library.SharedLibraryError):
            library.exclude_styles([STYLE_ID])

    def test_file_preview_uses_catalog_and_preserves_image_headers(self):
        response = self.client.get('/api/naim-shared-library/' + STYLE_ID + '/preview?full=1')
        try:
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.mimetype, 'image/png')
            self.assertEqual(response.data, self.image.read_bytes())
            self.assertEqual(response.headers['X-Content-Type-Options'], 'nosniff')
            self.assertEqual(response.headers['Cache-Control'], 'private, max-age=60')
            self.catalog.preview_path.assert_called_with(STYLE_ID, full=True)
        finally:
            response.close()
        self.assertEqual(self.client.get('/api/naim-shared-library/invalid/preview').status_code, 404)

    def test_image_read_is_bounded_and_exact_limit_is_valid(self):
        expected = self.image.read_bytes()
        self.assertEqual(library.read_image(STYLE_ID, max_bytes=len(expected)), (expected, 'image/png'))
        for limit in (len(expected) - 1, 0, -1):
            with self.subTest(limit=limit), self.assertRaises(library.SharedLibraryError):
                library.read_image(STYLE_ID, max_bytes=limit)
        with self.assertRaises(library.SharedLibraryError):
            library.read_image('../outside')

    def test_missing_or_unsupported_image_is_a_controlled_failure(self):
        self.catalog.preview_path.return_value = self.image.with_name('missing.png')
        self.assertEqual(self.client.get('/api/naim-shared-library/' + STYLE_ID + '/preview').status_code, 503)
        self.catalog.preview_path.side_effect = FileNotFoundError('synthetic')
        with self.assertRaises(library.SharedLibraryError):
            library.read_image(STYLE_ID)
        self.catalog.preview_path.side_effect = None
        unsupported = self.image.with_suffix('.txt')
        unsupported.write_bytes(b'synthetic')
        self.catalog.preview_path.return_value = unsupported
        with self.assertRaises(library.SharedLibraryError):
            library.read_image(STYLE_ID)

    def test_invalid_catalog_records_are_rejected(self):
        self.catalog.public_records.return_value = [{'id': 'invalid'}]
        self.assertEqual(self.client.get('/api/naim-shared-library').status_code, 503)

    def test_unconfigured_adapter_is_disabled_and_has_no_http_transport(self):
        library.configure(None)
        self.assertFalse(library.enabled())
        self.assertEqual(self.client.get('/api/naim-shared-library').json['enabled'], False)
        with self.assertRaises(library.SharedLibraryError):
            library.list_styles()
        self.assertFalse(hasattr(library, 'requests'))
        self.assertFalse(hasattr(library, '_request'))


if __name__ == '__main__':
    unittest.main()
