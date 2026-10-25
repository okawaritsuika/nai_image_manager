from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock

from PIL import Image

from naim import webp_compression_ui as ui


class WebPDesktopFlowTests(unittest.TestCase):
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
             mock.patch.object(ui.os.path, 'isdir', return_value=True):
            dialog.start(estimate=True)
        self.assertEqual(dialog.controller._launch_job.call_args.kwargs['args'], (True, 90, True))


if __name__ == '__main__':
    unittest.main()
