"""One cancellable gallery PNG conversion batch, with bounded progress details."""
import copy
import os
import stat
import threading
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait

from naim.images.webp_conversion import convert_png_to_webp
from naim.storage.webp_conversion import (GalleryTagCache, add_webp_gallery_image,
                                          migrate_webp_references)


_MAX_IN_FLIGHT_PIXELS = 16 * 1024 * 1024
_MAX_WORKERS = 8


def _available_memory():
    """Read Windows' available RAM without adding a runtime dependency."""
    if os.name != 'nt':
        return None
    try:
        import ctypes

        class MemoryStatus(ctypes.Structure):
            _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong),
                        ('total', ctypes.c_ulonglong), ('available', ctypes.c_ulonglong),
                        ('page_total', ctypes.c_ulonglong), ('page_available', ctypes.c_ulonglong),
                        ('virtual_total', ctypes.c_ulonglong), ('virtual_available', ctypes.c_ulonglong),
                        ('extended_available', ctypes.c_ulonglong)]

        status = MemoryStatus()
        status.length = ctypes.sizeof(status)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return status.available
    except (AttributeError, OSError):
        pass
    return None


def gallery_processor(db, root, tags_path, *, keep_original=False):
    """Bind the conversion and reference transaction to one offline gallery."""
    tags_cache = GalleryTagCache(tags_path)

    def process(path, lossless, quality, cancel_event):
        def prepare_delete(source, target):
            if cancel_event.is_set():
                raise InterruptedError('압축 중지 요청')
            if keep_original:
                return add_webp_gallery_image(db, root, source, target)
            return migrate_webp_references(db, root, source, target, tags_path,
                                           tags_cache=tags_cache)

        # The converter holds IMAGE_FILES_LOCK only during publication, reference
        # updates, deletion and rollback. Encoding can proceed on other workers.
        return convert_png_to_webp(path, lossless=lossless, quality=quality,
                                   before_delete=prepare_delete, cancel_event=cancel_event,
                                   keep_original=keep_original)
    return process


def _is_link(path):
    details = os.lstat(path)
    return stat.S_ISLNK(details.st_mode) or bool(
        getattr(details, 'st_file_attributes', 0) & 0x400
    )


def _pixel_cost(path, fallback):
    """Read only IHDR; unknown inputs conservatively occupy the entire budget."""
    try:
        with open(path, 'rb') as source:
            header = source.read(24)
        if len(header) == 24 and header[:16] == b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR':
            pixels = int.from_bytes(header[16:20], 'big') * int.from_bytes(header[20:24], 'big')
            if pixels:
                return pixels
    except OSError:
        pass
    return fallback


class WebPCompressionJobs:
    def __init__(self, root_provider, processor, *, max_workers=None):
        self.root_provider = root_provider
        self.processor = processor
        available = _available_memory()
        # Budget for decoded images, encoder/decoder workspaces and verification
        # copies. Keep at least half of currently available RAM for other work.
        self.pixel_budget = (max(1, min(64 * 1024 * 1024, available // 2 // 96))
                             if available is not None else _MAX_IN_FLIGHT_PIXELS)
        worker_limit = _MAX_WORKERS if available is not None else 4
        self.max_workers = max(1, min(worker_limit,
                                     max_workers if max_workers is not None else (os.cpu_count() or 1)))
        self.lock = threading.Lock()
        self.cancel_event = threading.Event()
        self.thread = None
        self.closing = False
        self.state = {'status': 'idle', 'processed': 0, 'total': 0}

    def snapshot(self):
        with self.lock:
            return copy.deepcopy(self.state)

    def _update(self, **values):
        with self.lock:
            self.state.update(values)

    def start(self, *, lossless, quality, estimate=False, paths=None):
        """Scan the gallery by default; an explicit list, even empty, scopes it."""
        if not isinstance(lossless, bool):
            raise ValueError('압축 방식을 선택해 주세요.')
        if isinstance(quality, bool) or not isinstance(quality, int) or not 1 <= quality <= 100:
            raise ValueError('화질은 1~100의 정수여야 합니다.')
        root = os.path.realpath(self.root_provider())
        if not os.path.isdir(root):
            raise ValueError('갤러리 폴더를 찾을 수 없습니다.')
        selected_paths = None
        if paths is not None:
            selected_paths = []
            seen = set()
            for path in paths:
                path = os.path.abspath(path)
                resolved = os.path.realpath(path)
                if (not path.lower().endswith('.png')
                        or os.path.normcase(os.path.commonpath([root, resolved])) != os.path.normcase(root)):
                    raise ValueError('자동 변환은 갤러리 안의 지정된 PNG만 처리합니다.')
                key = os.path.normcase(path)
                if key not in seen:
                    selected_paths.append(path)
                    seen.add(key)
            selected_paths = tuple(selected_paths)
        with self.lock:
            if self.closing or (self.thread is not None and self.thread.is_alive()):
                raise RuntimeError('WebP 압축 작업이 이미 실행 중이거나 종료 중입니다.')
            self.cancel_event.clear()
            self.state = {
                'status': 'running', 'phase': 'scanning', 'processed': 0,
                'total': 0, 'converted': 0, 'skipped': 0, 'failed': 0,
                'source_bytes': 0, 'target_bytes': 0, 'current': '',
                'details': [], 'lossless': lossless, 'quality': quality,
                'estimate': estimate, 'workers': self.max_workers,
                'cancel_requested': False,
            }
            self.thread = threading.Thread(
                target=self._run, args=(root, lossless, quality, estimate, selected_paths),
                daemon=True, name='naim-webp-compression',
            )
            try:
                self.thread.start()
            except Exception:
                self.state['status'] = 'error'
                raise
            return copy.deepcopy(self.state)

    def cancel(self):
        self.cancel_event.set()
        self._update(cancel_requested=True)
        return self.snapshot()

    def _detail(self, path, message):
        with self.lock:
            # A large library must not keep an unbounded per-image log in RAM.
            if len(self.state['details']) < 30:
                self.state['details'].append({'path': path, 'message': message})

    def _process(self, root, path, lossless, quality, estimate):
        if self.cancel_event.is_set():
            raise InterruptedError()
        # Recheck after scheduling: a directory may have moved since scanning.
        if (os.path.normcase(os.path.commonpath([root, os.path.realpath(path)])) != os.path.normcase(root)
                or _is_link(path)):
            raise ValueError('갤러리 밖으로 연결된 경로는 변환하지 않습니다.')
        if estimate:
            result = convert_png_to_webp(path, lossless=lossless, quality=quality,
                                         dry_run=True, cancel_event=self.cancel_event)
        else:
            result = self.processor(path, lossless, quality, self.cancel_event)
        # Preserve skipped/error details even during cancellation: rollback may
        # have retained both files and its diagnostic must remain visible.
        return result

    def _parallel_results(self, root, paths, lossless, quality, estimate=False):
        """Bound both pending work and pixels; drain running workers on cancel."""
        remaining = iter(paths)
        next_path = next(remaining, None)
        next_cost = _pixel_cost(next_path, self.pixel_budget) if next_path is not None else 0
        pending = {}
        pixels = 0
        with ThreadPoolExecutor(max_workers=self.max_workers, thread_name_prefix='naim-webp') as pool:
            while pending or (next_path is not None and not self.cancel_event.is_set()):
                while (next_path is not None and not self.cancel_event.is_set()
                       and len(pending) < self.max_workers):
                    # An oversized image runs alone instead of blocking forever.
                    if pending and pixels + next_cost > self.pixel_budget:
                        break
                    future = pool.submit(self._process, root, next_path, lossless, quality, estimate)
                    pending[future] = (next_path, next_cost)
                    pixels += next_cost
                    self._update(current=os.path.relpath(next_path, root).replace('\\', '/'))
                    next_path = next(remaining, None)
                    next_cost = _pixel_cost(next_path, self.pixel_budget) if next_path is not None else 0
                if not pending:
                    break
                completed, _ = wait(pending, return_when=FIRST_COMPLETED)
                for future in completed:
                    path, cost = pending.pop(future)
                    pixels -= cost
                    try:
                        result = future.result()
                    except Exception as error:
                        yield path, None, error
                    else:
                        yield path, result, None

    def _estimate(self, root, paths, lossless, quality):
        sizes = {path: os.path.getsize(path) for path in paths}
        total_bytes = sum(sizes.values())
        eligible = sorted(path for path in paths if not os.path.exists(os.path.splitext(path)[0] + '.webp'))
        count = min(8, len(eligible))
        samples = [eligible[round(index * (len(eligible) - 1) / max(1, count - 1))] for index in range(count)]
        self._update(phase='estimating', sample_total=count, sampled=0, total_bytes=total_bytes)
        sample_before = sample_after = excluded_bytes = 0
        for index, (path, result, error) in enumerate(
                self._parallel_results(root, samples, lossless, quality, estimate=True)):
            if isinstance(error, InterruptedError):
                self.cancel_event.set()
                continue
            if error is not None:
                raise error
            relative = os.path.relpath(path, root).replace('\\', '/')
            if result['status'] == 'estimated':
                sample_before += result['source_bytes']
                sample_after += result['target_bytes']
            else:
                excluded_bytes += sizes[path]
                self._detail(relative, result.get('reason') or '예상에서 제외')
            self._update(sampled=index + 1)
        if self.cancel_event.is_set():
            return
        if eligible and not sample_before:
            raise ValueError('변환 가능한 표본이 없어 예상 용량을 계산하지 못했습니다. 원본은 유지됩니다.')
        eligible_bytes = sum(sizes[path] for path in eligible) - excluded_bytes
        estimated_after = total_bytes - eligible_bytes
        if sample_before:
            estimated_after += round(eligible_bytes * sample_after / sample_before)
        self._update(estimated_source_bytes=total_bytes, estimated_target_bytes=estimated_after,
                     sample_source_bytes=sample_before, sample_target_bytes=sample_after)

    def _run(self, root, lossless, quality, estimate=False, selected_paths=None):
        try:
            paths = list(selected_paths) if selected_paths is not None else []

            def scan_error(error):
                raise error

            if selected_paths is None:
                for folder, dirs, files in os.walk(root, followlinks=False, onerror=scan_error):
                    if self.cancel_event.is_set():
                        break
                    dirs[:] = [name for name in dirs if not name.startswith('.naim-')
                               and not _is_link(os.path.join(folder, name))]
                    for name in files:
                        path = os.path.join(folder, name)
                        if name.lower().endswith('.png') and not _is_link(path):
                            paths.append(path)
            self._update(total=len(paths), phase='converting')
            if estimate:
                self._estimate(root, paths, lossless, quality)
                self._update(status='cancelled' if self.cancel_event.is_set() else 'done', current='')
                return
            for path, result, error in self._parallel_results(root, paths, lossless, quality):
                relative = os.path.relpath(path, root).replace('\\', '/')
                try:
                    if error is not None:
                        raise error
                    with self.lock:
                        if result['status'] == 'converted':
                            self.state['converted'] += 1
                            self.state['source_bytes'] += result['source_bytes']
                            self.state['target_bytes'] += result['target_bytes']
                        elif result['status'] == 'failed':
                            self.state['failed'] += 1
                        else:
                            self.state['skipped'] += 1
                    if result['status'] != 'converted':
                        self._detail(relative, result.get('reason') or '원본 유지')
                except InterruptedError:
                    self.cancel_event.set()
                    continue
                except Exception as error:
                    with self.lock:
                        self.state['failed'] += 1
                    self._detail(relative, str(error))
                with self.lock:
                    self.state['processed'] += 1
            self._update(status='cancelled' if self.cancel_event.is_set() else 'done', current='')
        except Exception as error:
            self._update(status='error', error=str(error), current='')

    def shutdown(self, timeout=8):
        with self.lock:
            self.closing = True
            self.cancel_event.set()
            worker = self.thread
        if worker is not None and worker is not threading.current_thread():
            worker.join(timeout=timeout)
        return worker is None or not worker.is_alive()


def compress_classified_pngs(db, root, tags_path, paths, *, lossless, quality,
                             stop_check=None, progress_update=None, log_func=print):
    """Compress this import's new PNGs after its history/index writes commit.

    Called by the offline classification worker. All conversion workers finish
    before returning, so the caller can safely close its shared HistoryDB.
    """
    if stop_check and stop_check():
        log_func('자동 WebP 변환을 중지했습니다. 분류된 PNG는 유지됩니다.')
        return None
    jobs = WebPCompressionJobs(lambda: root, gallery_processor(db, root, tags_path))
    mode = '무손실' if lossless else f'손실 · 화질 {quality}'
    log_func(f'자동 WebP 변환 시작 ({mode}) · 이번에 새로 분류한 PNG만 처리합니다.')
    jobs.start(lossless=lossless, quality=quality, paths=paths)
    previous = None
    try:
        while True:
            if stop_check and stop_check():
                jobs.cancel()
            jobs.thread.join(timeout=0.1)
            running = jobs.thread.is_alive()
            state = jobs.snapshot()
            progress = (state['processed'], state['total'], state['cancel_requested'])
            if progress_update and progress != previous:
                phase = '자동 WebP 중지 처리 중' if state['cancel_requested'] else '자동 WebP 변환'
                try:
                    progress_update(state['processed'], state['total'], phase)
                except TypeError:
                    progress_update(state['processed'], state['total'])
            previous = progress
            if not running:
                break
    finally:
        if jobs.thread.is_alive():
            jobs.cancel()
            jobs.thread.join()
    before, after = state['source_bytes'], state['target_bytes']
    percent = abs(before - after) * 100 / before if before else 0
    direction = '절약' if before >= after else '증가'
    status = {'done': '완료', 'cancelled': '중지', 'error': '오류'}.get(state['status'], state['status'])
    log_func(f"자동 WebP {status}: 변환 {state['converted']}장 · 건너뜀 {state['skipped']}장 · 실패 {state['failed']}장")
    log_func(f'변환한 파일: {before / (1024 * 1024):,.2f} MiB → {after / (1024 * 1024):,.2f} MiB ({percent:.1f}% {direction})')
    for detail in state['details']:
        log_func(f"PNG 유지: {detail['path']} · {detail['message']}")
    if state.get('error'):
        log_func(f"자동 WebP 오류: {state['error']}")
    return state
