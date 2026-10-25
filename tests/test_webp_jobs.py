from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

from naim.jobs.webp_compression import WebPCompressionJobs
from naim.jobs import webp_compression


def write_header(path, width=64, height=64):
    path.write_bytes(b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR'
                     + width.to_bytes(4, 'big') + height.to_bytes(4, 'big'))


class WebPJobsTests(unittest.TestCase):
    def test_estimate_samples_evenly_and_keeps_originals_and_existing_webp(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            originals = {}
            for index in range(20):
                path = root / f'{index:02}.png'
                path.write_bytes(b'synthetic' * 100)
                originals[path] = path.read_bytes()
            (root / '19.webp').write_bytes(b'existing')
            sampled = []

            def preview(path, **options):
                self.assertTrue(options['dry_run'])
                self.assertFalse(options['lossless'])
                self.assertEqual(options['quality'], 82)
                sampled.append(Path(path).name)
                size = Path(path).stat().st_size
                return {'status': 'estimated', 'source_bytes': size, 'target_bytes': size // 2}

            jobs = WebPCompressionJobs(lambda: root, mock.Mock(side_effect=AssertionError('conversion called')))
            with mock.patch('naim.jobs.webp_compression.convert_png_to_webp', side_effect=preview):
                jobs.start(lossless=False, quality=82, estimate=True)
                jobs.thread.join(3)
            state = jobs.snapshot()
            self.assertEqual(state['status'], 'done', state)
            self.assertEqual(len(sampled), 8)
            self.assertEqual(len(set(sampled)), 8)
            self.assertIn('00.png', sampled)
            self.assertIn('18.png', sampled)
            self.assertEqual(state['estimated_source_bytes'], 18000)
            self.assertEqual(state['estimated_target_bytes'], 9450)
            self.assertEqual(state['converted'], 0)
            self.assertEqual((root / '19.webp').read_bytes(), b'existing')
            for path, data in originals.items():
                self.assertEqual(path.read_bytes(), data)

    def test_recursive_png_only_and_bounded_failures(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'nested').mkdir()
            (root / '.naim-image-staged').mkdir()
            for name in ('nested/one.PNG', 'two.png', 'existing.webp', 'photo.jpg', '.naim-image-staged/no.png'):
                (root / name).write_bytes(b'synthetic')
            seen = []

            def process(path, lossless, quality, event):
                seen.append((Path(path).name, lossless, quality))
                if Path(path).name == 'two.png':
                    raise OSError('synthetic failure')
                return {'status': 'converted', 'source_bytes': 100, 'target_bytes': 50}

            jobs = WebPCompressionJobs(lambda: root, process)
            jobs.start(lossless=False, quality=81)
            jobs.thread.join(3)
            self.assertFalse(jobs.thread.is_alive())
            state = jobs.snapshot()
            self.assertEqual(state['status'], 'done')
            self.assertEqual((state['total'], state['processed'], state['converted'], state['failed']), (2, 2, 1, 1))
            self.assertEqual(state['source_bytes'] - state['target_bytes'], 50)
            self.assertEqual(sorted(seen), [('one.PNG', False, 81), ('two.png', False, 81)])
            state['details'].clear()
            self.assertEqual(len(jobs.snapshot()['details']), 1)

    def test_cancel_stops_after_current_file_and_rejects_concurrent_start(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for index in range(3):
                (root / f'{index}.png').write_bytes(b'synthetic')
            started, release = threading.Event(), threading.Event()
            seen = []

            def process(path, lossless, quality, event):
                seen.append(path)
                started.set()
                release.wait(3)
                if event.is_set():
                    raise InterruptedError()
                return {'status': 'skipped', 'reason': 'synthetic skip'}

            jobs = WebPCompressionJobs(lambda: root, process)
            jobs.start(lossless=True, quality=90)
            try:
                self.assertTrue(started.wait(2))
                with self.assertRaises(RuntimeError):
                    jobs.start(lossless=True, quality=90)
                jobs.cancel()
            finally:
                release.set()
                self.assertTrue(jobs.shutdown(3))
            self.assertEqual(len(seen), 1)
            self.assertEqual(jobs.snapshot()['status'], 'cancelled')
            self.assertEqual(jobs.snapshot()['processed'], 0)
            with self.assertRaises(RuntimeError):
                jobs.start(lossless=True, quality=90)

    def test_invalid_options_do_not_start_a_thread(self):
        jobs = WebPCompressionJobs(lambda: '.', lambda *args: self.fail('unexpected conversion'))
        for lossless, quality in ((1, 90), (True, 0), (False, 101), (True, True), (True, 90.5)):
            with self.subTest(lossless=lossless, quality=quality), self.assertRaises(ValueError):
                jobs.start(lossless=lossless, quality=quality)
        self.assertEqual(jobs.snapshot()['status'], 'idle')

    def test_parallel_workers_are_bounded_and_all_results_are_counted(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for index in range(9):
                write_header(root / f'{index}.png')
            release, started = threading.Event(), threading.Event()
            lock = threading.Lock()
            active = peak = 0

            def process(path, lossless, quality, event):
                nonlocal active, peak
                with lock:
                    active += 1
                    peak = max(peak, active)
                    if active == 3:
                        started.set()
                release.wait(3)
                with lock:
                    active -= 1
                return {'status': 'converted', 'source_bytes': 100, 'target_bytes': 40}

            jobs = WebPCompressionJobs(lambda: root, process, max_workers=3)
            jobs.start(lossless=True, quality=90)
            try:
                self.assertTrue(started.wait(2), 'three encodes should overlap')
            finally:
                release.set()
                jobs.thread.join(3)
            self.assertFalse(jobs.thread.is_alive())
            state = jobs.snapshot()
            self.assertEqual(peak, 3)
            self.assertEqual((state['processed'], state['converted']), (9, 9))
            self.assertEqual((state['source_bytes'], state['target_bytes']), (900, 360))

    def test_cancel_drains_in_flight_results_without_starting_more_images(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for index in range(8):
                write_header(root / f'{index}.png')
            release, started = threading.Event(), threading.Event()
            lock = threading.Lock()
            seen = []

            def process(path, lossless, quality, event):
                with lock:
                    seen.append(path)
                    first = len(seen) == 1
                    if len(seen) == 2:
                        started.set()
                release.wait(3)
                if not first:
                    raise InterruptedError()
                # A conversion committed just before cancellation must be counted.
                return {'status': 'converted', 'source_bytes': 100, 'target_bytes': 40}

            jobs = WebPCompressionJobs(lambda: root, process, max_workers=2)
            jobs.start(lossless=False, quality=80)
            try:
                self.assertTrue(started.wait(2))
                jobs.cancel()
            finally:
                release.set()
                jobs.thread.join(3)
            state = jobs.snapshot()
            self.assertEqual(len(seen), 2)
            self.assertEqual(state['status'], 'cancelled')
            self.assertEqual((state['processed'], state['converted'], state['failed']), (1, 1, 0))
            self.assertEqual(state['target_bytes'], 40)

    def test_oversized_image_runs_alone_and_does_not_block_the_batch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for index in range(2):
                write_header(root / f'{index}.png', width=8192, height=8192)
            entered, release = threading.Event(), threading.Event()
            seen = []

            def process(path, lossless, quality, event):
                seen.append(path)
                entered.set()
                release.wait(3)
                return {'status': 'converted', 'source_bytes': 100, 'target_bytes': 40}

            jobs = WebPCompressionJobs(lambda: root, process, max_workers=4)
            jobs.start(lossless=True, quality=90)
            try:
                self.assertTrue(entered.wait(2))
                self.assertEqual(len(seen), 1)
            finally:
                release.set()
                jobs.thread.join(3)
            self.assertFalse(jobs.thread.is_alive())
            self.assertEqual(len(seen), 2)
            self.assertEqual(jobs.snapshot()['converted'], 2)

    def test_estimation_uses_parallel_workers_without_calling_processor(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for index in range(3):
                write_header(root / f'{index}.png')
            barrier = threading.Barrier(3, timeout=3)

            def preview(path, **options):
                self.assertTrue(options['dry_run'])
                barrier.wait()
                return {'status': 'estimated', 'source_bytes': 24, 'target_bytes': 12}

            jobs = WebPCompressionJobs(lambda: root, mock.Mock(side_effect=AssertionError('conversion called')),
                                       max_workers=3)
            with mock.patch('naim.jobs.webp_compression.convert_png_to_webp', side_effect=preview):
                jobs.start(lossless=False, quality=82, estimate=True)
                jobs.thread.join(5)
            state = jobs.snapshot()
            self.assertEqual(state['status'], 'done', state)
            self.assertEqual(state['sampled'], 3)
            self.assertEqual(state['estimated_target_bytes'], 36)
            self.assertEqual(len(list(root.glob('*.png'))), 3)

    def test_cancellation_keeps_recovery_failure_details(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_header(root / 'sample.png')

            def process(path, lossless, quality, event):
                event.set()
                return {'status': 'skipped', 'reason': 'synthetic rollback failure: both files retained'}

            jobs = WebPCompressionJobs(lambda: root, process)
            jobs.start(lossless=True, quality=90)
            jobs.thread.join(3)
            state = jobs.snapshot()
            self.assertEqual(state['status'], 'cancelled')
            self.assertEqual((state['processed'], state['skipped']), (1, 1))
            self.assertIn('both files retained', state['details'][0]['message'])

    def test_parallel_capacity_respects_cpu_ram_and_unknown_memory(self):
        for cpus, available, workers, budget in (
                (16, 16 * 1024 ** 3, 8, 64 * 1024 ** 2),
                (2, 16 * 1024 ** 3, 2, 64 * 1024 ** 2),
                (16, 512 * 1024 ** 2, 8, 512 * 1024 ** 2 // 2 // 96),
                (16, None, 4, 16 * 1024 ** 2),
                (None, None, 1, 16 * 1024 ** 2)):
            with self.subTest(cpus=cpus, available=available), \
                 mock.patch.object(webp_compression.os, 'cpu_count', return_value=cpus), \
                 mock.patch.object(webp_compression, '_available_memory', return_value=available):
                jobs = WebPCompressionJobs(lambda: '.', None)
            self.assertEqual(jobs.max_workers, workers)
            self.assertEqual(jobs.pixel_budget, budget)

    def test_available_ram_allows_eight_large_images_to_overlap(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for index in range(8):
                write_header(root / f'{index}.png', width=3072, height=2560)
            barrier = threading.Barrier(8, timeout=3)

            def process(path, lossless, quality, event):
                barrier.wait()
                return {'status': 'converted', 'source_bytes': 100, 'target_bytes': 40}

            with mock.patch.object(webp_compression.os, 'cpu_count', return_value=16), \
                 mock.patch.object(webp_compression, '_available_memory', return_value=16 * 1024 ** 3):
                jobs = WebPCompressionJobs(lambda: root, process)
            jobs.start(lossless=True, quality=90)
            jobs.thread.join(5)
            state = jobs.snapshot()
            self.assertEqual((state['status'], state['converted'], state['failed']), ('done', 8, 0), state)

    def test_memory_budget_limits_large_image_overlap(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for index in range(4):
                write_header(root / f'{index}.png', width=3072, height=2560)
            ready, release = threading.Event(), threading.Event()
            lock = threading.Lock()
            active = peak = 0

            def process(path, lossless, quality, event):
                nonlocal active, peak
                with lock:
                    active += 1
                    peak = max(peak, active)
                    if active == 2:
                        ready.set()
                release.wait(3)
                with lock:
                    active -= 1
                return {'status': 'converted', 'source_bytes': 100, 'target_bytes': 40}

            # Three GiB free allows a 16-Mi-pixel budget: exactly two of these.
            with mock.patch.object(webp_compression.os, 'cpu_count', return_value=16), \
                 mock.patch.object(webp_compression, '_available_memory', return_value=3 * 1024 ** 3):
                jobs = WebPCompressionJobs(lambda: root, process)
            jobs.start(lossless=True, quality=90)
            try:
                self.assertTrue(ready.wait(2))
            finally:
                release.set()
                jobs.thread.join(3)
            self.assertEqual(peak, 2)
            self.assertEqual(jobs.snapshot()['converted'], 4)

    def test_selected_paths_only_never_rescan_the_gallery(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ('existing.png', 'new.png'):
                write_header(root / name)
            process = mock.Mock(return_value={'status': 'converted', 'source_bytes': 24, 'target_bytes': 12})
            jobs = WebPCompressionJobs(lambda: root, process)
            with mock.patch.object(webp_compression.os, 'walk', side_effect=AssertionError('must not scan gallery')):
                jobs.start(lossless=True, quality=90, paths=[root / 'new.png', root / 'new.png'])
                jobs.thread.join(3)
            self.assertEqual(jobs.snapshot()['status'], 'done')
            self.assertEqual(jobs.snapshot()['total'], 1)
            self.assertEqual(process.call_args.args[0], str(root / 'new.png'))
            self.assertEqual(process.call_count, 1)
            self.assertTrue((root / 'existing.png').exists())

    def test_empty_selected_paths_do_not_mean_the_entire_gallery(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_header(root / 'existing.png')
            process = mock.Mock(side_effect=AssertionError('nothing was selected'))
            jobs = WebPCompressionJobs(lambda: root, process)
            jobs.start(lossless=True, quality=90, paths=[])
            jobs.thread.join(3)
            self.assertEqual((jobs.snapshot()['status'], jobs.snapshot()['total']), ('done', 0))
            process.assert_not_called()

    def test_selected_paths_reject_outside_gallery_and_non_png(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'gallery'
            root.mkdir()
            process = mock.Mock()
            jobs = WebPCompressionJobs(lambda: root, process)
            for path in (root.parent / 'outside.png', root / 'photo.jpg'):
                with self.subTest(path=path), self.assertRaises(ValueError):
                    jobs.start(lossless=True, quality=90, paths=[path])
            self.assertIsNone(jobs.thread)
            process.assert_not_called()

    def test_classification_helper_reports_totals_and_drains_cancelled_workers(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'new.png'
            write_header(source)
            started = threading.Event()
            progress, logs = [], []

            def process(path, lossless, quality, event):
                started.set()
                self.assertTrue(event.wait(3), 'helper should forward stop requests')
                return {'status': 'skipped', 'reason': 'synthetic cancellation'}

            with mock.patch.object(webp_compression, 'gallery_processor', return_value=process):
                state = webp_compression.compress_classified_pngs(
                    None, root, root / 'tags.json', [source], lossless=False, quality=83,
                    stop_check=started.is_set, progress_update=lambda *args: progress.append(args),
                    log_func=logs.append,
                )
            self.assertEqual(state['status'], 'cancelled')
            self.assertEqual(state['skipped'], 1)
            self.assertTrue(source.exists())
            self.assertTrue(any('중지' in item[2] for item in progress))
            self.assertTrue(any('synthetic cancellation' in item for item in logs))

    def test_classification_helper_keeps_byte_counts_and_original_stop_behavior(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'new.png'
            write_header(source)
            process = mock.Mock(return_value={'status': 'converted', 'source_bytes': 1024 * 1024,
                                              'target_bytes': 512 * 1024})
            progress, logs = [], []
            with mock.patch.object(webp_compression, 'gallery_processor', return_value=process):
                state = webp_compression.compress_classified_pngs(
                    None, root, root / 'tags.json', [source], lossless=True, quality=90,
                    progress_update=lambda current, total: progress.append((current, total)),
                    log_func=logs.append,
                )
            self.assertEqual(state['converted'], 1)
            self.assertEqual(progress[-1], (1, 1))
            self.assertTrue(any('1.00 MiB → 0.50 MiB (50.0% 절약)' in item for item in logs))
            with mock.patch.object(webp_compression, 'gallery_processor') as factory:
                self.assertIsNone(webp_compression.compress_classified_pngs(
                    None, root, root / 'tags.json', [source], lossless=True, quality=90,
                    stop_check=lambda: True, log_func=logs.append))
                factory.assert_not_called()


if __name__ == '__main__':
    unittest.main()
