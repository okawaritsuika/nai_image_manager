"""One bounded, cancellable WebP replacement job for explicit gallery images."""
from copy import deepcopy
import threading
import uuid


def image_paths(value, limit=10000):
    if (not isinstance(value, list) or not 1 <= len(value) <= limit
            or any(not isinstance(path, str) or not path.strip() or len(path) > 4096 for path in value)):
        raise ValueError(f'그림을 1~{limit:,}장 선택해 주세요.')
    return list(dict.fromkeys(value))


class ImageConversionJobs:
    def __init__(self, processor):
        self.processor = processor
        self.lock = threading.Lock()
        self.event = threading.Event()
        self.thread = None
        self.closing = False
        self.state = {'id': '', 'status': 'idle', 'total': 0, 'processed': 0,
                      'converted': 0, 'skipped': 0, 'failed': 0,
                      'source_bytes': 0, 'target_bytes': 0, 'quality': 90,
                      'details': [], 'cancel_requested': False}

    def snapshot(self):
        with self.lock:
            return deepcopy(self.state)

    def start(self, paths, quality=90):
        paths = image_paths(paths)
        if type(quality) is not int or not 1 <= quality <= 100:
            raise ValueError('품질은 1~100의 정수여야 합니다.')
        with self.lock:
            if self.closing or (self.thread is not None and self.thread.is_alive()):
                raise RuntimeError('이미 WebP 변환이 실행 중이거나 종료 중입니다.')
            self.event.clear()
            self.state = {'id': uuid.uuid4().hex, 'status': 'running', 'total': len(paths),
                          'processed': 0, 'converted': 0, 'skipped': 0, 'failed': 0,
                          'source_bytes': 0, 'target_bytes': 0, 'quality': quality,
                          'details': [], 'cancel_requested': False}
            self.thread = threading.Thread(target=self._run, args=(paths, quality),
                                           name='naim-image-webp', daemon=True)
            try:
                self.thread.start()
            except Exception:
                self.state['status'] = 'error'
                raise
            return deepcopy(self.state)

    def _run(self, paths, quality):
        try:
            # Encoding one image at a time bounds RAM and leaves the web/UI
            # threads available; cancellation is checked between encoder stages.
            for path in paths:
                if self.event.is_set():
                    break
                try:
                    result = self.processor(path, quality, self.event)
                    outcome = 'converted' if result['status'] == 'converted' else 'skipped'
                    message = result.get('reason', '')
                except Exception:
                    outcome, message = 'failed', '그림 또는 연결 정보를 확인하지 못해 원본을 유지했습니다.'
                    result = {}
                with self.lock:
                    self.state['processed'] += 1
                    self.state[outcome] += 1
                    before = result.get('source_bytes', 0)
                    self.state['source_bytes'] += before
                    self.state['target_bytes'] += result.get('target_bytes', 0) if outcome == 'converted' else before
                    if message and len(self.state['details']) < 30:
                        self.state['details'].append({'path': path, 'message': message})
            with self.lock:
                self.state['status'] = 'cancelled' if self.event.is_set() else 'completed'
        except Exception:
            with self.lock:
                self.state['status'] = 'error'

    def cancel(self, job_id):
        with self.lock:
            if not job_id or self.state['id'] != job_id:
                raise RuntimeError('작업이 변경되었습니다. 현재 진행 상태를 다시 확인해 주세요.')
            if self.state['status'] == 'running':
                self.event.set()
                self.state['cancel_requested'] = True
            return deepcopy(self.state)

    def shutdown(self, timeout=8):
        with self.lock:
            self.closing = True
            self.event.set()
            thread = self.thread
        if thread is not None:
            thread.join(timeout)
        return thread is None or not thread.is_alive()
