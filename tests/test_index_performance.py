import ast
import gzip
import json
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

from PIL import Image
from PIL.PngImagePlugin import PngInfo

import image_logic
from naim.images.prompt_metadata import extract_prompt_info_from_image
from naim.jobs.batches import iter_completed
from utils import HistoryDB


def stealth_image(text, size=(128, 128)):
    data = gzip.compress(text.encode('utf-8'))
    header = b'stealth_pngcomp' + (len(data) * 8).to_bytes(4, 'big')
    bits = ''.join(f'{value:08b}' for value in header + data)
    image = Image.new('RGBA', size, (30, 40, 50, 255))
    for index, bit in enumerate(bits):
        x, y = divmod(index, size[1])
        image.putpixel((x, y), (30, 40, 50, 254 | int(bit)))
    return image


class StealthPerformanceTests(unittest.TestCase):
    def test_column_order_and_unicode_round_trip(self):
        text = json.dumps({'prompt': 'synthetic example', 'note': '\uac00\ub098\ub2e4'})
        for size in ((128, 128), (256, 7), (8, 256)):
            with self.subTest(size=size), stealth_image(text, size) as image:
                self.assertEqual(image_logic.read_stealth_info(image), text)

    def test_plain_rgba_only_extracts_a_narrow_alpha_strip(self):
        original = Image.Image.getchannel
        extracted_sizes = []

        def getchannel(image, channel):
            extracted_sizes.append(image.size)
            return original(image, channel)

        with Image.new('RGBA', (1024, 1024)) as image:
            with mock.patch.object(Image.Image, 'getchannel', getchannel):
                self.assertIsNone(image_logic.read_stealth_info(image))
        self.assertEqual(extracted_sizes, [(1, 1024)])

    def test_invalid_length_tiny_and_rgb_stay_unreadable_as_stealth(self):
        with stealth_image('example') as image:
            for index in range(120, 152):
                x, y = divmod(index, image.height)
                image.putpixel((x, y), (30, 40, 50, 255))
            self.assertIsNone(image_logic.read_stealth_info(image))
        for mode in ('RGB', 'RGBA'):
            with Image.new(mode, (2, 2)) as image:
                self.assertIsNone(image_logic.read_stealth_info(image))

    def test_classification_shares_stealth_read_and_keeps_metadata_precedence(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'sample.png'
            hidden = json.dumps({'model': 'nai-diffusion-5-full', 'prompt': 'hidden example'})
            with stealth_image(hidden) as image:
                image.save(path)
            with mock.patch.object(image_logic, 'read_stealth_info', wraps=image_logic.read_stealth_info) as read:
                result = image_logic.analyze_file_worker(str(path), skip_nsfw=True)
                self.assertEqual(read.call_count, 1)
                self.assertEqual(result[6], 'v5')
                self.assertEqual(result[3], ['hidden example'])

            metadata = PngInfo()
            metadata.add_text('parameters', json.dumps({'prompt': 'visible example', 'model': 'nai-diffusion-4-5-full'}))
            with stealth_image(hidden) as image:
                image.save(path, pnginfo=metadata)
            result = image_logic.analyze_file_worker(str(path), skip_nsfw=True)
            self.assertEqual(result[3], ['visible example'])
            self.assertEqual(result[6], 'v4_5')
            self.assertEqual(extract_prompt_info_from_image(str(path))['basePrompt'], 'hidden example')


class BoundedWorkTests(unittest.TestCase):
    def test_submission_is_bounded_and_errors_keep_their_input(self):
        consumed = []

        def inputs():
            for item in range(100):
                consumed.append(item)
                yield item

        def work(item):
            if item == 3:
                raise ValueError('synthetic failure')
            return item * 2

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = iter_completed(executor, work, inputs(), 4)
            first = next(results)
            self.assertEqual(len(consumed), 4)
            returned = [first] + list(results)
        self.assertEqual({item for item, _ in returned}, set(range(100)))
        for item, future in returned:
            if item == 3:
                with self.assertRaises(ValueError):
                    future.result()
            else:
                self.assertEqual(future.result(), item * 2)

    def test_stop_drains_only_submitted_transfers_and_records_them(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source'
            source.mkdir()
            for index in range(100):
                with Image.new('RGB', (8, 8), (index, 0, 0)) as image:
                    image.save(source / f'{index}.png')
            output = root / 'TOTAL_CLASSIFIED'
            db_path = output / 'history.db'
            stopped = threading.Event()
            original = image_logic.file_io_worker

            def transfer(*args, **kwargs):
                result = original(*args, **kwargs)
                stopped.set()
                return result

            with mock.patch.object(sys, 'argv', [str(root / 'main.py')]), \
                 mock.patch.object(image_logic.utils, 'HistoryDB', side_effect=lambda: HistoryDB(db_path)), \
                 mock.patch.object(image_logic.utils, 'load_config', return_value={}), \
                 mock.patch.object(image_logic, 'file_io_worker', side_effect=transfer):
                image_logic.process(str(source), method='copy', normal_workers=2,
                                    stop_check=stopped.is_set, log_func=lambda _: None)
            copied = list(output.rglob('*.png'))
            self.assertGreater(len(copied), 0)
            self.assertLessEqual(len(copied), 32)
            self.assertEqual(len(list(source.glob('*.png'))), 100)
            db = HistoryDB(db_path)
            try:
                self.assertEqual(db.conn.execute('SELECT COUNT(*) FROM processed_files').fetchone()[0], len(copied))
                self.assertEqual(db.conn.execute('SELECT COUNT(*) FROM gallery_images').fetchone()[0], len(copied))
            finally:
                db.close()


class IndexStatusPerformanceTests(unittest.TestCase):
    def test_progress_only_does_not_open_database_or_scan_files(self):
        from tests.test_model_family_backend import GalleryModelFamilyMigrationTests
        app = GalleryModelFamilyMigrationTests._load_app_without_flask()
        app.request.args = {'job_only': '1'}
        with mock.patch.object(app.utils, 'HistoryDB', side_effect=AssertionError('database opened')), \
             mock.patch.object(app, 'iter_gallery_prompt_index_files', side_effect=AssertionError('files scanned')):
            response = app.gallery_prompt_index_status()
        self.assertEqual(response['status'], 'success')
        self.assertEqual(response['job'], app.GALLERY_PROMPT_INDEX_JOB)

    def test_desktop_progress_coalesces_bursts_but_keeps_phase_and_completion(self):
        source = Path(__file__).resolve().parents[1] / 'main_executor.pyw'
        tree = ast.parse(source.read_text(encoding='utf-8-sig'))
        method = next(node for node in ast.walk(tree)
                      if isinstance(node, ast.FunctionDef) and node.name == 'update_progress')
        namespace = {'time': types.SimpleNamespace(monotonic=lambda: 1.0)}
        exec(compile(ast.Module(body=[method], type_ignores=[]), str(source), 'exec'), namespace)
        queued = []
        labels = []
        progress_values = []
        controller = types.SimpleNamespace(
            root=types.SimpleNamespace(after=lambda delay, callback: queued.append(callback)),
            lbl_progress=types.SimpleNamespace(config=lambda **kwargs: labels.append(kwargs['text'])),
            progress_bar=types.SimpleNamespace(configure=lambda **kwargs: progress_values.append(kwargs['value'])),
        )
        for current in range(101):
            namespace['update_progress'](controller, current, 100, 'scan')
        namespace['update_progress'](controller, 1, 10, 'copy')
        self.assertEqual(len(queued), 3)
        for callback in queued:
            callback()
        self.assertIn('100 / 100 (100.0%)', labels[1])
        self.assertIn('copy', labels[2])
        self.assertEqual(progress_values, [0.0, 100.0, 10.0])


if __name__ == '__main__':
    unittest.main()
