import threading
import time
import unittest

from naim.jobs.upscale import UpscaleJobs
from naim.processes import UpscaleCancelled


def job(identifier):
    return {'id': identifier, 'status': 'queued', 'progress': 0, 'created_at': '2026-01-01T00:00:00'}


def wait_terminal(service, identifier):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        state = service.get(identifier)
        if state['status'] in ('done', 'error', 'cancelled'):
            return state
        time.sleep(0.01)
    raise AssertionError('Job did not finish')


class UpscaleJobsTests(unittest.TestCase):
    def test_failure_does_not_stop_next_job_and_snapshots_are_detached(self):
        seen = []
        def process(work, progress):
            seen.append(work['id'])
            progress(37, 'working')
            if work['id'] == 'bad':
                raise ValueError('synthetic failure')
            return {'result_path': 'group/result.png'}
        service = UpscaleJobs(process)
        self.addCleanup(service.shutdown)
        service.submit(job('bad'))
        service.submit(job('good'))
        self.assertEqual(wait_terminal(service, 'bad')['error'], 'synthetic failure')
        good = wait_terminal(service, 'good')
        self.assertEqual((good['status'], good['progress']), ('done', 100))
        self.assertEqual(seen, ['bad', 'good'])
        self.assertNotIn('_cancel_event', good)
        good['status'] = 'changed'
        self.assertEqual(service.get('good')['status'], 'done')
        self.assertEqual(service.cancel('good')['status'], 'done')
        self.assertIsNone(service.cancel('missing'))

    def test_queued_cancel_never_calls_processor(self):
        entered, release = threading.Event(), threading.Event()
        seen = []
        def process(work, progress):
            seen.append(work['id'])
            entered.set()
            if not release.wait(2):
                raise RuntimeError('test timed out')
            return {}
        service = UpscaleJobs(process)
        self.addCleanup(service.shutdown)
        self.addCleanup(release.set)
        service.submit(job('running'))
        self.assertTrue(entered.wait(2))
        service.submit(job('queued'))
        self.assertEqual(service.cancel('queued')['status'], 'cancelled')
        release.set()
        wait_terminal(service, 'running')
        self.assertTrue(service.shutdown(timeout=2))
        self.assertEqual(seen, ['running'])
        self.assertEqual(service.get('queued')['progress'], 100)

    def test_shutdown_cancels_running_and_pending_and_rejects_new_jobs(self):
        entered = threading.Event()
        def process(work, progress):
            entered.set()
            if not work['_cancel_event'].wait(2):
                raise RuntimeError('cancellation was not delivered')
            raise UpscaleCancelled()
        service = UpscaleJobs(process)
        self.addCleanup(service.shutdown)
        service.submit(job('running'))
        self.assertTrue(entered.wait(2))
        service.submit(job('pending'))
        self.assertTrue(service.shutdown(timeout=2))
        self.assertEqual([item['status'] for item in service.list()], ['cancelled', 'cancelled'])
        self.assertFalse(service.thread.is_alive())
        self.assertTrue(service.shutdown(timeout=0))
        with self.assertRaises(RuntimeError):
            service.submit(job('late'))

    def test_duplicate_id_does_not_overwrite_an_existing_job(self):
        service = UpscaleJobs(lambda work, progress: {})
        self.addCleanup(service.shutdown)
        service.submit(job('same'))
        wait_terminal(service, 'same')
        with self.assertRaises(ValueError):
            service.submit(job('same'))
        self.assertEqual(service.get('same')['status'], 'done')
