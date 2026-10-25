from pathlib import Path
from contextlib import closing
import sqlite3
import tempfile
import types
import unittest
from unittest import mock

from PIL import Image

from naim import webp_compression_ui as ui
import utils


class WebPDesktopFlowTests(unittest.TestCase):
    def _dialog_for_start(self, root):
        dialog = ui.WebPCompressionDialog.__new__(ui.WebPCompressionDialog)
        dialog.running = False
        dialog.gallery_root = str(root)
        dialog.controller = mock.Mock(server_transitioning=False)
        dialog.controller._can_start_job.return_value = True
        dialog.controller._launch_job.return_value = True
        dialog.controller._job_token = 11
        dialog.window = mock.Mock()
        dialog.status = mock.Mock()
        dialog.mode = mock.Mock()
        dialog.mode.get.return_value = 'lossless'
        dialog.quality = mock.Mock()
        dialog.quality.get.return_value = '90'
        dialog.options = []
        dialog.start_button = mock.Mock()
        dialog.estimate_button = mock.Mock()
        dialog.cancel_button = mock.Mock()
        dialog.quality_input = mock.Mock()
        dialog._update_quality = mock.Mock()
        return dialog

    def test_conversion_cancel_does_not_launch_a_job(self):
        with tempfile.TemporaryDirectory() as temporary:
            dialog = self._dialog_for_start(Path(temporary))
            with mock.patch.object(ui.utils, 'is_port_active', return_value=False), \
                 mock.patch.object(ui, 'choose_webp_storage', return_value=None) as choose:
                dialog.start()
            choose.assert_called_once_with(dialog.window)
            dialog.controller._launch_job.assert_not_called()
            self.assertFalse(dialog.running)

    def test_conversion_choice_is_captured_by_worker(self):
        for choice, keep_original in (('keep_original', True), ('replace_original', False)):
            with self.subTest(choice=choice), tempfile.TemporaryDirectory() as temporary:
                dialog = self._dialog_for_start(Path(temporary))
                with mock.patch.object(ui.utils, 'is_port_active', return_value=False), \
                     mock.patch.object(ui, 'choose_webp_storage', return_value=choice):
                    dialog.start()
                launch = dialog.controller._launch_job.call_args
                self.assertEqual(launch.args[0], 'webp')
                self.assertEqual(launch.kwargs['args'], (True, 90, False))
                self.assertEqual(launch.args[1].keywords, {'keep_original': keep_original})
                self.assertEqual(dialog.keep_original, keep_original)

    def test_worker_estimate_then_conversion_preserves_original_until_execution(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            gallery = root / 'TOTAL_CLASSIFIED'
            gallery.mkdir()
            source = gallery / 'sample.png'
            Image.new('RGBA', (32, 48), (70, 140, 200, 254)).save(source)
            original = source.read_bytes()
            dialog = ui.WebPCompressionDialog.__new__(ui.WebPCompressionDialog)
            dialog.gallery_root = str(gallery)
            dialog.controller = types.SimpleNamespace(stop_requested=False)
            for estimate in (True, False):
                dialog.running = True
                with mock.patch.object(ui, 'get_app_dir', return_value=str(root)):
                    dialog._worker(False, 84, estimate)
                self.assertFalse(dialog.running)
                self.assertFalse(getattr(dialog, 'worker_error', ''), getattr(dialog, 'worker_error', ''))
                state = dialog.jobs.snapshot()
                self.assertEqual(state['status'], 'done', state)
                if estimate:
                    self.assertEqual(source.read_bytes(), original)
                    self.assertFalse(source.with_suffix('.webp').exists())
                    self.assertFalse((gallery / 'naia_history.db').exists())
                    expected_size = state['estimated_target_bytes']
                else:
                    self.assertFalse(source.exists())
                    self.assertEqual(state['converted'], 1)
                    self.assertEqual(state['target_bytes'], expected_size)

    def test_worker_adds_webp_and_keeps_original_png_and_gallery_index(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            gallery = root / 'TOTAL_CLASSIFIED'
            gallery.mkdir()
            source = gallery / 'sample.png'
            Image.new('RGBA', (32, 48), (70, 140, 200, 254)).save(source)
            original = source.read_bytes()
            db_path = gallery / 'naia_history.db'
            db = utils.HistoryDB(str(db_path))
            db.upsert_gallery_image_file(str(source), classified_root=str(gallery))
            db.close()

            dialog = ui.WebPCompressionDialog.__new__(ui.WebPCompressionDialog)
            dialog.gallery_root = str(gallery)
            dialog.controller = types.SimpleNamespace(stop_requested=False)
            dialog.running = True
            with mock.patch.object(ui, 'get_app_dir', return_value=str(root)):
                dialog._worker(False, 84, False, keep_original=True)

            target = source.with_suffix('.webp')
            self.assertFalse(getattr(dialog, 'worker_error', ''), getattr(dialog, 'worker_error', ''))
            self.assertEqual(dialog.jobs.snapshot()['status'], 'done', dialog.jobs.snapshot())
            self.assertEqual(dialog.jobs.snapshot()['converted'], 1)
            self.assertEqual(source.read_bytes(), original)
            self.assertTrue(target.is_file())
            with closing(sqlite3.connect(db_path)) as connection:
                indexed = {row[0] for row in connection.execute(
                    'SELECT rel_path FROM gallery_images WHERE rel_path IN (?, ?)',
                    ('sample.png', 'sample.webp'))}
            self.assertEqual(indexed, {'sample.png', 'sample.webp'})

    def test_active_web_server_prevents_conversion(self):
        dialog = ui.WebPCompressionDialog.__new__(ui.WebPCompressionDialog)
        dialog.running = False
        dialog.controller = mock.Mock(server_transitioning=False)
        dialog.controller._can_start_job.return_value = True
        dialog.window = mock.Mock()
        with mock.patch.object(ui.utils, 'is_port_active', return_value=True), \
             mock.patch.object(ui.messagebox, 'showwarning') as warning:
            dialog.start()
        dialog.controller._launch_job.assert_not_called()
        warning.assert_called_once()

    def test_actual_summary_handles_both_savings_and_growth(self):
        for target, wording in ((512 * 1024, '50.0% 감소'), (2 * 1024 * 1024, '100.0% 증가')):
            dialog = ui.WebPCompressionDialog.__new__(ui.WebPCompressionDialog)
            dialog.controller = mock.Mock()
            dialog.jobs = mock.Mock()
            dialog.jobs.snapshot.return_value = {
                'status': 'done', 'total': 1, 'processed': 1, 'converted': 1,
                'source_bytes': 1024 * 1024, 'target_bytes': target,
            }
            dialog.running = False
            dialog.job_token = 7
            dialog.status = mock.Mock()
            dialog.progress = {}
            dialog.details = mock.Mock()
            dialog.start_button = mock.Mock()
            dialog.estimate_button = mock.Mock()
            dialog.cancel_button = mock.Mock()
            dialog.options = []
            dialog._update_quality = mock.Mock()
            dialog._poll()
            summary = dialog.status.set.call_args.args[0]
            self.assertIn('1.00 MiB →', summary)
            self.assertIn(wording, summary)
            dialog.controller._finish_job.assert_called_once_with('webp', 7)

    def test_add_mode_summary_reports_added_webp_bytes(self):
        dialog = ui.WebPCompressionDialog.__new__(ui.WebPCompressionDialog)
        dialog.controller = mock.Mock()
        dialog.jobs = mock.Mock()
        dialog.jobs.snapshot.return_value = {
            'status': 'done', 'total': 1, 'processed': 1, 'converted': 1,
            'source_bytes': 1024 * 1024, 'target_bytes': 1536 * 1024,
        }
        dialog.running = False
        dialog.keep_original = True
        dialog.job_token = 7
        dialog.status = mock.Mock()
        dialog.progress = {}
        dialog.details = mock.Mock()
        dialog.start_button = mock.Mock()
        dialog.estimate_button = mock.Mock()
        dialog.cancel_button = mock.Mock()
        dialog.options = []
        dialog._update_quality = mock.Mock()
        dialog._poll()
        summary = dialog.status.set.call_args.args[0]
        self.assertIn('원본 유지 · WebP 1.50 MiB 추가', summary)
        self.assertNotIn('절약', summary)
        self.assertNotIn('감소', summary)

    def test_read_only_estimate_can_start_while_server_is_running(self):
        dialog = ui.WebPCompressionDialog.__new__(ui.WebPCompressionDialog)
        dialog.running = False
        dialog.gallery_root = 'synthetic'
        dialog.controller = mock.Mock(server_transitioning=False)
        dialog.controller._can_start_job.return_value = True
        dialog.controller._launch_job.return_value = False
        dialog.mode = mock.Mock()
        dialog.mode.get.return_value = 'lossless'
        with mock.patch.object(ui.utils, 'is_port_active', return_value=True), \
             mock.patch.object(ui.os.path, 'isdir', return_value=True), \
             mock.patch.object(ui, 'choose_webp_storage') as choose:
            dialog.start(estimate=True)
        self.assertEqual(dialog.controller._launch_job.call_args.kwargs['args'], (True, 90, True))
        choose.assert_not_called()


if __name__ == '__main__':
    unittest.main()
