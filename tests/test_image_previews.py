"""Synthetic display-preview and disposable-cache compatibility checks."""
from concurrent.futures import ThreadPoolExecutor
import io
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

from PIL import Image
import app
from naim.images import previews
from naim.images.previews import PreviewCache, preview_key


class ImagePreviewTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.library = self.root / 'library'
        self.library.mkdir()
        self.cache = PreviewCache(self.root / 'cache')
        for name, value in (('CLASSIFIED_DIR', str(self.library)), ('IMAGE_PREVIEW_CACHE', self.cache)):
            patch = mock.patch.object(app, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        self.client = app.app.test_client()

    def make_image(self, filename='synthetic.png', mode='RGB', color='red', **save):
        path = self.library / filename
        Image.new(mode, (640, 320), color).save(path, **save)
        return path

    def cached(self, path, builder=None, size=256, cache=None):
        stat = path.stat()
        return (cache or self.cache).get(str(path), stat.st_mtime_ns, stat.st_size, size,
                                        builder or app.build_image_preview_bytes)

    def test_disk_hit_survives_new_cache_instance_and_keeps_source(self):
        path = self.make_image()
        original = path.read_bytes()
        first = self.cached(path)
        builder = mock.Mock(side_effect=AssertionError('decoded a disk cache hit'))
        self.assertEqual(self.cached(path, builder, cache=PreviewCache(self.cache.directory)), first)
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(len(list(self.library.iterdir())), 1)

    def test_png_alpha_and_jpeg_exif_keep_original_preview_contract(self):
        alpha = self.make_image('alpha.png', 'RGBA', (20, 40, 60, 70))
        exif = Image.Exif()
        exif[274] = 6
        rotated = self.make_image('rotated.jpg', exif=exif)
        for path, expected_size, mime in ((alpha, (256, 128), 'image/png'),
                                           (rotated, (128, 256), 'image/jpeg')):
            with self.subTest(path=path.name):
                original = path.read_bytes()
                expected = app.build_image_preview_bytes(str(path), 256)
                actual = self.cached(path)
                self.assertEqual(actual, expected)
                self.assertEqual(actual[1], mime)
                with Image.open(io.BytesIO(actual[0])) as image:
                    self.assertEqual(image.size, expected_size)
                    if path == alpha:
                        self.assertEqual(image.getpixel((0, 0))[3], 70)
                self.assertEqual(path.read_bytes(), original)

    def test_route_keeps_preview_bounds_mime_etag_and_original_response(self):
        path = self.make_image()
        for query in ('?preview=1', '?preview=256'):
            response = self.client.get('/image/synthetic.png' + query)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.mimetype, 'image/jpeg')
            self.assertIn('must-revalidate', response.headers['Cache-Control'])
            with Image.open(io.BytesIO(response.data)) as image:
                self.assertEqual(image.size, (256, 128))
            unchanged = self.client.get('/image/synthetic.png' + query,
                                        headers={'If-None-Match': response.headers['ETag']})
            self.assertEqual(unchanged.status_code, 304)
        for query in ('', '?preview=invalid'):
            response = self.client.get('/image/synthetic.png' + query)
            self.assertEqual(response.data, path.read_bytes())
            response.close()
        with app.app.test_request_context('/?preview=99999'):
            self.assertEqual(app.get_requested_image_preview_max_side(), 4096)

    def test_source_changes_invalidate_disk_preview(self):
        path = self.make_image()
        before = self.cached(path)
        old = path.stat()
        Image.new('RGB', (640, 320), 'blue').save(path)
        os.utime(path, ns=(old.st_atime_ns, old.st_mtime_ns + 1_000_000_000))
        after = self.cached(path)
        self.assertNotEqual(before[0], after[0])
        self.assertEqual(after, app.build_image_preview_bytes(str(path), 256))

    def test_key_contains_all_identity_fields_without_disclosing_source(self):
        first = preview_key('synthetic-private-name.png', 1, 2, 256)
        self.assertRegex(first, r'^[0-9a-f]{64}$')
        for args in (('other.png', 1, 2, 256), ('synthetic-private-name.png', 2, 2, 256),
                     ('synthetic-private-name.png', 1, 3, 256), ('synthetic-private-name.png', 1, 2, 512)):
            self.assertNotEqual(first, preview_key(*args))
        with mock.patch.object(previews, 'TRANSFORM_VERSION', previews.TRANSFORM_VERSION + 1):
            self.assertNotEqual(first, preview_key('synthetic-private-name.png', 1, 2, 256))

    def test_corrupt_cache_is_rebuilt(self):
        path = self.make_image()
        expected = self.cached(path)
        saved = next(self.cache.directory.glob('*.preview'))
        raw = bytearray(saved.read_bytes())
        raw[-1] ^= 1
        saved.write_bytes(raw)
        self.assertEqual(self.cached(path), expected)
        self.assertEqual(self.cache._read(saved), expected)

    def test_cache_write_failure_returns_preview_and_cleans_temporary_file(self):
        path = self.make_image()
        with mock.patch.object(previews.os, 'replace', side_effect=OSError('synthetic storage failure')):
            result = self.cached(path)
        self.assertEqual(result, app.build_image_preview_bytes(str(path), 256))
        self.assertEqual(list(self.cache.directory.iterdir()), [])

    def test_unavailable_cache_directory_returns_preview(self):
        path = self.make_image()
        self.cache.directory.write_bytes(b'synthetic blocked directory')
        self.assertEqual(self.cached(path), app.build_image_preview_bytes(str(path), 256))

    def test_oversized_entry_is_not_stored(self):
        path = self.make_image()
        cache = PreviewCache(self.root / 'small-cache', max_bytes=1)
        self.assertEqual(self.cached(path, cache=cache), app.build_image_preview_bytes(str(path), 256))
        self.assertFalse(cache.directory.exists())

    def test_old_interrupted_cache_writes_are_cleaned(self):
        path = self.make_image()
        self.cache.directory.mkdir()
        stale = self.cache.directory / '.preview-synthetic.tmp'
        stale.write_bytes(b'incomplete cache only')
        os.utime(stale, (1, 1))
        recent = self.cache.directory / '.preview-current.tmp'
        recent.write_bytes(b'concurrent write')
        self.cached(path)
        self.assertFalse(stale.exists())
        self.assertTrue(recent.exists())

    def test_budget_evicts_oldest_entry_and_preserves_unmanaged_files(self):
        first = self.make_image('first.png')
        second = self.make_image('second.png', color='blue')
        self.cached(first)
        old_cache_path = next(self.cache.directory.glob('*.preview'))
        budget = old_cache_path.stat().st_size + 100
        unrelated = self.cache.directory / 'unmanaged.txt'
        unrelated.write_text('keep')
        cache = PreviewCache(self.cache.directory, max_bytes=budget)
        self.cached(second, cache=cache)
        self.assertFalse(old_cache_path.exists())
        self.assertLessEqual(sum(p.stat().st_size for p in cache.directory.glob('*.preview')), budget)
        self.assertEqual(unrelated.read_text(), 'keep')

    def test_same_preview_builds_once_and_releases_key_locks(self):
        path = self.make_image()
        entered = threading.Event()
        release = threading.Event()

        def build(file_path, max_side):
            entered.set()
            if not release.wait(5):
                raise AssertionError('preview release timeout')
            return app.build_image_preview_bytes(file_path, max_side)

        builder = mock.Mock(side_effect=build)
        with ThreadPoolExecutor(max_workers=4) as executor:
            futures = [executor.submit(self.cached, path, builder) for _ in range(4)]
            self.assertTrue(entered.wait(5))
            release.set()
            results = [future.result(timeout=5) for future in futures]
        self.assertEqual(builder.call_count, 1)
        self.assertTrue(all(result == results[0] for result in results))
        self.assertEqual(self.cache._locks, {})

    def test_different_previews_can_build_concurrently(self):
        paths = [self.make_image('one.png'), self.make_image('two.png')]
        barrier = threading.Barrier(2)

        def build(file_path, max_side):
            barrier.wait(timeout=5)
            return app.build_image_preview_bytes(file_path, max_side)

        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(self.cached, path, build) for path in paths]
            for future in futures:
                self.assertEqual(future.result(timeout=5)[1], 'image/jpeg')

    def test_changed_source_during_build_is_not_cached_under_old_identity(self):
        path = self.make_image()

        def build(file_path, max_side):
            result = app.build_image_preview_bytes(file_path, max_side)
            previous = path.stat()
            os.utime(path, ns=(previous.st_atime_ns, previous.st_mtime_ns + 1_000_000_000))
            return result

        self.cached(path, build)
        self.assertFalse(self.cache.directory.exists())
