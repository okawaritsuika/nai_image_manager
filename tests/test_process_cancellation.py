import sys
import threading
import time
import unittest

import upscale_logic


class ProcessCancellationTests(unittest.TestCase):
    def test_silent_process_is_cancelled_without_waiting_for_stdout(self):
        cancel = threading.Event()
        timer = threading.Timer(0.1, cancel.set)
        timer.start()
        started = time.monotonic()
        try:
            with self.assertRaises(upscale_logic.UpscaleCancelled):
                upscale_logic.run_process_with_cancel(
                    [sys.executable, '-c', 'import time; time.sleep(0.8)'], cancel
                )
            self.assertLess(time.monotonic() - started, 0.65)
        finally:
            timer.cancel()
            timer.join()

    def test_output_without_final_newline_and_exit_code_are_preserved(self):
        code, output = upscale_logic.run_process_with_cancel(
            [sys.executable, '-c', 'import sys; sys.stdout.write("result"); sys.exit(3)']
        )
        self.assertEqual((code, output), (3, 'result'))
