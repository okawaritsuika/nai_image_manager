"""One serial upscale worker with synchronized snapshots and cancellation."""
import datetime
import queue
import threading
import time
from contextlib import contextmanager

from naim.processes import UpscaleCancelled


def now_iso():
    return datetime.datetime.now().isoformat(timespec='seconds')


def public_upscale_job(job):
    if not job:
        return None
    result = {
        'id': job.get('id', ''),
        'status': job.get('status', 'queued'),
        'progress': int(job.get('progress', 0) or 0),
        'message': job.get('message', ''),
        'source_path': job.get('source_path', ''),
        'source_name': job.get('source_name', ''),
        'target_width': job.get('target_width', 0),
        'target_height': job.get('target_height', 0),
        'engine': job.get('engine', 'realcugan'),
        'quality': job.get('quality', 'standard'),
        'result_path': job.get('result_path', ''),
        'result_src': job.get('result_src', ''),
        'error': job.get('error', ''),
        'created_at': job.get('created_at', ''),
        'updated_at': job.get('updated_at', ''),
    }
    if isinstance(job.get('projectContext'), dict):
        result['projectContext'] = dict(job['projectContext'])
    for key in ('destination', 'projectName', 'side'):
        if key in job:
            result[key] = job[key]
    for key in ('embedded_metadata_saved', 'sidecar_saved'):
        if key in job:
            result[key] = job[key]
    return result


class UpscaleJobs:
    def __init__(self, processor):
        self.processor = processor
        self.jobs = {}
        self.queue = queue.Queue()
        self.lock = threading.Lock()
        self.thread = None
        self._closing = False
        self._direct = set()
        self._idle = threading.Condition(self.lock)

    @contextmanager
    def direct_operation(self):
        """Track synchronous canvas work without changing its HTTP contract."""
        with self.lock:
            if self._closing:
                raise UpscaleCancelled()
            event = threading.Event()
            self._direct.add(event)
        try:
            yield event
        finally:
            with self._idle:
                self._direct.remove(event)
                self._idle.notify_all()

    def _ensure_started_locked(self):
        if self._closing:
            raise RuntimeError('업스케일 작업 서비스가 종료 중입니다.')
        if self.thread is None or not self.thread.is_alive():
            self.thread = threading.Thread(target=self.run, daemon=True, name='naim-upscale')
            self.thread.start()
        return self.thread

    def ensure_started(self):
        with self.lock:
            return self._ensure_started_locked()

    def submit(self, job):
        with self.lock:
            if job['id'] in self.jobs:
                raise ValueError('이미 존재하는 업스케일 작업 ID입니다.')
            self._ensure_started_locked()
            self.jobs[job['id']] = dict(job, _cancel_event=threading.Event())
            self.queue.put(job['id'])
            return public_upscale_job(self.jobs[job['id']])

    def update(self, job_id, **patch):
        with self.lock:
            job = self.jobs.get(job_id)
            if job is not None:
                job.update(patch, updated_at=now_iso())

    def get(self, job_id):
        with self.lock:
            return public_upscale_job(self.jobs.get(job_id))

    def list(self):
        with self.lock:
            jobs = [public_upscale_job(job) for job in self.jobs.values()]
        return sorted(jobs, key=lambda job: job.get('created_at', ''), reverse=True)

    def is_busy(self):
        with self.lock:
            return bool(self._direct) or any(
                job.get('status') in ('queued', 'running') for job in self.jobs.values()
            )

    def cancel(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            if job is None:
                return None
            if job.get('status') not in ('done', 'error', 'cancelled'):
                job['_cancel_event'].set()
                if job.get('status') == 'queued':
                    job['status'] = 'cancelled'
                job.update(message='취소 요청됨', updated_at=now_iso())
            return public_upscale_job(job)

    def run(self):
        while True:
            job_id = self.queue.get()
            try:
                if job_id is None:
                    return
                with self.lock:
                    job = self.jobs.get(job_id)
                    if job is None:
                        continue
                    if job['_cancel_event'].is_set():
                        job.update(status='cancelled', progress=100, message='취소됨', updated_at=now_iso())
                        continue
                    job.update(status='running', progress=2, message='업스케일 준비 중...', updated_at=now_iso())
                    work = dict(job)

                def progress(progress, message):
                    self.update(job_id, progress=max(0, min(99, int(progress))), message=message)

                result = self.processor(work, progress)
                self.update(job_id, status='done', progress=100, message='업스케일 완료', **(result or {}))
            except UpscaleCancelled:
                self.update(job_id, status='cancelled', progress=100, message='취소됨')
            except Exception as error:
                self.update(job_id, status='error', progress=100, message='업스케일 실패', error=str(error))
            finally:
                self.queue.task_done()

    def shutdown(self, timeout=8):
        """Cancel running/queued work, reject new work, and wait a bounded time."""
        deadline = time.monotonic() + timeout
        with self.lock:
            if not self._closing:
                self._closing = True
                for event in self._direct:
                    event.set()
                for job in self.jobs.values():
                    if job.get('status') not in ('done', 'error', 'cancelled'):
                        job['_cancel_event'].set()
                        if job.get('status') == 'queued':
                            job.update(status='cancelled', progress=100)
                        job.update(message='취소 요청됨', updated_at=now_iso())
                if self.thread is not None:
                    self.queue.put(None)
            worker = self.thread
        if worker is not None and worker is not threading.current_thread():
            worker.join(timeout=max(0, deadline - time.monotonic()))
        with self._idle:
            self._idle.wait_for(lambda: not self._direct, timeout=max(0, deadline - time.monotonic()))
            return not self._direct and (worker is None or not worker.is_alive())
