import threading
import time
import types
import unittest
from unittest import mock

from naim.jobs import upscale


class UpscaleWorkerStartTests(unittest.TestCase):
    def test_concurrent_start_creates_only_one_worker(self):
        created = []
        gate = threading.Barrier(8)
        jobs = upscale.UpscaleJobs(lambda job, progress: {})

        class FakeWorker:
            def __init__(self, **kwargs):
                created.append(self)
                time.sleep(0.03)

            def is_alive(self):
                return True

            def start(self):
                pass

        def request_start():
            gate.wait(timeout=2)
            jobs.ensure_started()

        callers = [threading.Thread(target=request_start) for _ in range(8)]
        with mock.patch.object(upscale, 'threading', types.SimpleNamespace(Thread=FakeWorker)):
            for caller in callers:
                caller.start()
            for caller in callers:
                caller.join(timeout=3)
            self.assertFalse(any(caller.is_alive() for caller in callers))
        self.assertEqual(len(created), 1)
