"""Safe download, installation and removal of optional upscale assets."""
from contextlib import contextmanager
import hashlib
import io
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import shutil
import stat
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

from naim.paths import get_app_dir, is_subpath
from naim.processes import UpscaleCancelled, run_process_with_cancel


_MODEL_IDS = frozenset(('realcugan', 'waifu2x', 'illustrationjanai', 'animesharp'))
_RUNTIME_ID = 'runtime'
_CHUNK_SIZE = 1024 * 1024
_MIN_FREE_BYTES = 256 * 1024 * 1024
_RUNTIME_IMPORT_CHECK = (
    'import torch, torchvision, spandrel; '
    'from spandrel.architectures.FDAT import FDATArch'
)


class UpscaleAssetConflict(RuntimeError):
    """A valid asset operation conflicts with active work or use."""


class UpscaleAssetError(RuntimeError):
    """A safe, user-facing installation failure."""


def _load_catalog():
    # The app owns the manifest; importing it here keeps this module importable
    # while application modules are still being assembled.
    from naim.upscale_catalog import ASSETS
    return ASSETS


def _safe_relative(value, *, allow_dot=False):
    if not isinstance(value, str) or not value or '\x00' in value:
        raise ValueError('업스케일 자료 경로가 올바르지 않습니다.')
    normalized = value.replace('\\', '/')
    windows = PureWindowsPath(normalized)
    if normalized.startswith('/') or windows.is_absolute() or windows.drive:
        raise ValueError('업스케일 자료 경로가 올바르지 않습니다.')
    parts = [part for part in normalized.split('/') if part not in ('', '.')]
    if any(part == '..' or ':' in part for part in parts):
        raise ValueError('업스케일 자료 경로가 올바르지 않습니다.')
    if not parts:
        if allow_dot:
            return PurePosixPath('.')
        raise ValueError('업스케일 자료 경로가 올바르지 않습니다.')
    return PurePosixPath(*parts)


def _has_reparse_point(path):
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return False
    if stat.S_ISLNK(info.st_mode):
        return True
    attributes = getattr(info, 'st_file_attributes', 0)
    reparse_flag = getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400)
    return bool(attributes & reparse_flag)


def _is_regular_file(path):
    try:
        info = os.lstat(path)
    except OSError:
        return False
    return stat.S_ISREG(info.st_mode) and not _has_reparse_point(path)


def _format_bytes(value):
    amount = float(max(0, int(value)))
    for unit in ('B', 'KB', 'MB', 'GB', 'TB'):
        if amount < 1024 or unit == 'TB':
            return f'{amount:.1f} {unit}' if unit != 'B' else f'{int(amount)} B'
        amount /= 1024
    return f'{amount:.1f} TB'


class _DownloadTask:
    def __init__(self, engine, total_bytes):
        self.engine = engine
        self.total_bytes = total_bytes
        self.cancel_event = threading.Event()
        self.download_bytes = 0
        self.progress = 0
        self.message = '다운로드 준비 중...'
        self.thread = None
        self.stage_dirs = set()


class UpscaleAssets:
    """Own optional model folders and one cancellable install task at a time."""

    def __init__(self, root=None):
        self.root = Path(root or get_app_dir()).resolve()
        self._lock = threading.RLock()
        self._active_task = None
        self._states = {}
        self._use_counts = {}
        self._closing = False

    def _catalog(self):
        catalog = _load_catalog()
        if not isinstance(catalog, dict):
            raise UpscaleAssetError('업스케일 모델 목록을 읽지 못했습니다.')
        return catalog

    def _spec(self, engine):
        if not isinstance(engine, str) or engine not in _MODEL_IDS:
            raise ValueError('지원하지 않는 업스케일 모델입니다.')
        spec = self._catalog().get(engine)
        if not isinstance(spec, dict):
            raise ValueError('지원하지 않는 업스케일 모델입니다.')
        return spec

    def _runtime_spec(self):
        spec = self._catalog().get(_RUNTIME_ID)
        if not isinstance(spec, dict):
            raise UpscaleAssetError('업스케일 실행 환경 목록을 읽지 못했습니다.')
        return spec

    def _relative_folder(self, spec):
        try:
            return _safe_relative(spec.get('folder'))
        except ValueError as error:
            raise UpscaleAssetError('업스케일 자료 경로 설정이 올바르지 않습니다.') from error

    def _managed_path(self, relative):
        relative = _safe_relative(str(relative), allow_dot=True)
        target = self.root.joinpath(*(() if str(relative) == '.' else relative.parts))
        if not is_subpath(str(target), str(self.root)):
            raise UpscaleAssetError('업스케일 자료 경로가 허용 범위를 벗어났습니다.')
        self._check_no_reparse(target)
        return target

    def _check_no_reparse(self, target):
        target = Path(os.path.abspath(target))
        root = Path(os.path.abspath(self.root))
        if not is_subpath(str(target), str(root)):
            raise UpscaleAssetError('업스케일 자료 경로가 허용 범위를 벗어났습니다.')
        relative = target.relative_to(root)
        current = root
        if _has_reparse_point(current):
            raise UpscaleAssetError('업스케일 자료 경로에 허용되지 않은 연결 경로가 있습니다.')
        for part in relative.parts:
            current = current / part
            if _has_reparse_point(current):
                raise UpscaleAssetError('업스케일 자료 경로에 허용되지 않은 연결 경로가 있습니다.')

    def _ensure_directory(self, target):
        self._check_no_reparse(target)
        root = Path(os.path.abspath(self.root))
        target = Path(os.path.abspath(target))
        current = root
        for part in target.relative_to(root).parts:
            current = current / part
            if current.exists():
                if _has_reparse_point(current) or not current.is_dir():
                    raise UpscaleAssetError('업스케일 자료 저장 경로를 사용할 수 없습니다.')
            else:
                current.mkdir()

    def _required_paths(self, spec):
        required = spec.get('required')
        if not isinstance(required, list) or not required:
            raise UpscaleAssetError('업스케일 자료 목록이 올바르지 않습니다.')
        folder = self._relative_folder(spec)
        result = []
        try:
            for relative in required:
                result.append(folder / _safe_relative(relative))
        except (TypeError, ValueError) as error:
            raise UpscaleAssetError('업스케일 자료 목록이 올바르지 않습니다.') from error
        return result

    def _required_files_exist(self, spec):
        try:
            for relative in self._required_paths(spec):
                path = self._managed_path(relative)
                if not _is_regular_file(path):
                    return False
            return True
        except (UpscaleAssetError, ValueError, TypeError):
            return False

    def _is_installed(self, engine, spec=None):
        spec = spec or self._spec(engine)
        if not self._required_files_exist(spec):
            return False
        dependency = spec.get('dependency')
        if dependency:
            if dependency != _RUNTIME_ID:
                return False
            if not self._required_files_exist(self._runtime_spec()):
                return False
        task = self._active_task
        return task is None or task.engine != engine

    def list(self):
        catalog = self._catalog()
        runtime_spec = catalog.get(_RUNTIME_ID)
        runtime_installed = bool(runtime_spec and self._required_files_exist(runtime_spec))
        with self._lock:
            rows = []
            for engine in catalog:
                if engine == _RUNTIME_ID:
                    continue
                if engine not in _MODEL_IDS:
                    continue
                spec = catalog.get(engine)
                if not isinstance(spec, dict):
                    continue
                task = self._active_task if self._active_task and self._active_task.engine == engine else None
                installed = False if task else self._is_installed(engine, spec)
                saved_state, saved_message, saved_progress, saved_bytes = self._states.get(
                    engine, ('missing', '', 0, 0))
                if task:
                    state, message, progress = 'downloading', task.message, task.progress
                    downloaded = task.download_bytes
                elif installed:
                    state, message, progress = 'installed', '설치됨', 100
                    downloaded = saved_bytes
                elif saved_state in ('error', 'cancelled'):
                    state, message, progress = saved_state, saved_message, saved_progress
                    downloaded = saved_bytes
                else:
                    state, message, progress, downloaded = 'missing', '모델 파일을 설치해야 합니다.', 0, 0
                rows.append({
                    'id': engine,
                    'name': str(spec.get('name') or engine),
                    'description': str(spec.get('description') or ''),
                    'installed': bool(installed),
                    'state': state,
                    'progress': max(0, min(100, int(progress))),
                    'message': message,
                    'download_bytes': task.total_bytes if task else (
                        self._download_size(spec) + (
                            self._download_size(runtime_spec)
                            if spec.get('dependency') == _RUNTIME_ID and not runtime_installed else 0
                        )
                    ),
                    'downloaded_bytes': int(downloaded),
                    'can_delete': self._managed_path(self._relative_folder(spec)).exists() or (
                        spec.get('dependency') == _RUNTIME_ID and runtime_installed and not any(
                            other != engine and entry.get('dependency') == _RUNTIME_ID
                            and self._is_installed(other, entry)
                            for other, entry in catalog.items() if other != _RUNTIME_ID
                        )
                    ),
                    'requires_runtime': spec.get('dependency') == _RUNTIME_ID,
                    'runtime_installed': runtime_installed,
                })
            return rows

    def _download_size(self, spec):
        downloads = spec.get('downloads')
        if not isinstance(downloads, list) or not downloads:
            raise UpscaleAssetError('업스케일 다운로드 목록이 올바르지 않습니다.')
        total = 0
        for item in downloads:
            if not isinstance(item, dict):
                raise UpscaleAssetError('업스케일 다운로드 목록이 올바르지 않습니다.')
            size = item.get('size')
            if not isinstance(size, int) or isinstance(size, bool) or size < 0:
                raise UpscaleAssetError('업스케일 다운로드 크기 설정이 올바르지 않습니다.')
            total += size
        return total

    def _set_task_status(self, task, *, progress=None, message=None, downloaded=None):
        with self._lock:
            if self._active_task is not task:
                return
            if progress is not None:
                task.progress = max(0, min(99, int(progress)))
            if message is not None:
                task.message = str(message)
            if downloaded is not None:
                task.download_bytes = int(downloaded)

    def _check_cancelled(self, task):
        if task.cancel_event.is_set():
            raise UpscaleCancelled()

    def start_download(self, engine):
        spec = self._spec(engine)
        if spec.get('dependency') not in (None, _RUNTIME_ID):
            raise UpscaleAssetError('업스케일 실행 환경 설정이 올바르지 않습니다.')
        with self._lock:
            if self._closing:
                raise UpscaleAssetConflict('업스케일 자료 관리가 종료 중입니다.')
            if self._active_task:
                if self._active_task.engine == engine:
                    return next(row for row in self.list() if row['id'] == engine)
                raise UpscaleAssetConflict('다른 업스케일 모델을 다운로드 중입니다.')
            if self._is_installed(engine, spec):
                raise UpscaleAssetConflict('이미 설치된 업스케일 모델입니다.')
            if self._use_counts.get(engine, 0):
                raise UpscaleAssetConflict('현재 사용 중인 모델은 설치할 수 없습니다.')
            runtime_needed = spec.get('dependency') == _RUNTIME_ID and not self._required_files_exist(
                self._runtime_spec())
            total_bytes = self._download_size(spec)
            if runtime_needed:
                total_bytes += self._download_size(self._runtime_spec())
            task = _DownloadTask(engine, total_bytes)
            self._active_task = task
            self._states[engine] = ('downloading', '다운로드 준비 중...', 0, 0)
            task.thread = threading.Thread(target=self._run_download, args=(task, spec, runtime_needed),
                                           daemon=True, name=f'naim-upscale-assets-{engine}')
            task.thread.start()
        return next(row for row in self.list() if row['id'] == engine)

    def cancel_download(self, engine):
        self._spec(engine)
        with self._lock:
            task = self._active_task
            if task is None or task.engine != engine:
                return False
            task.cancel_event.set()
            task.message = '다운로드 취소 중...'
            return True

    def _run_download(self, task, spec, runtime_needed):
        try:
            self._preflight_disk_space(spec, runtime_needed)
            if runtime_needed:
                self._set_task_status(task, progress=0, message='공용 실행 환경 다운로드 중...')
                self._install_spec(_RUNTIME_ID, self._runtime_spec(), task, is_runtime=True)
            self._check_cancelled(task)
            self._set_task_status(task, message='모델 파일 다운로드 중...')
            self._install_spec(task.engine, spec, task, is_runtime=False)
            self._set_task_status(task, progress=100, message='설치 완료')
            self._finish_task(task, 'installed', '설치됨', 100)
        except UpscaleCancelled:
            self._finish_task(task, 'cancelled', '다운로드가 취소되었습니다.', task.progress)
        except UpscaleAssetError as error:
            self._finish_task(task, 'error', str(error), task.progress)
        except Exception:
            self._finish_task(task, 'error', '업스케일 모델을 설치하지 못했습니다.', task.progress)

    def _finish_task(self, task, state, message, progress):
        self._cleanup_task_staging(task)
        with self._lock:
            if self._active_task is task:
                self._states[task.engine] = (state, message, max(0, min(100, int(progress))), task.download_bytes)
                self._active_task = None

    def _preflight_disk_space(self, spec, runtime_needed):
        total = self._download_size(spec)
        if runtime_needed:
            total += self._download_size(self._runtime_spec())
        required = total * 3 + _MIN_FREE_BYTES
        folder = self._relative_folder(spec)
        target = self.root / Path(*folder.parts)
        probe = target.parent
        while not probe.exists() and probe != self.root:
            probe = probe.parent
        try:
            available = shutil.disk_usage(probe).free
        except OSError as error:
            raise UpscaleAssetError('저장 공간을 확인하지 못했습니다.') from error
        if available < required:
            raise UpscaleAssetError(
                f'저장 공간이 부족합니다. 필요 예상 공간 {_format_bytes(required)}, '
                f'사용 가능 공간 {_format_bytes(available)}.'
            )

    def _stage_for(self, spec, task):
        folder = self._relative_folder(spec)
        destination = self._managed_path(folder)
        parent = destination.parent
        self._ensure_directory(parent)
        stage = parent / f'.{destination.name}.staging-{uuid.uuid4().hex}'
        self._check_no_reparse(stage)
        stage.mkdir()
        task.stage_dirs.add(stage)
        return stage, destination

    def _install_spec(self, engine, spec, task, *, is_runtime):
        self._check_cancelled(task)
        if engine == _RUNTIME_ID and self._required_files_exist(spec):
            self._set_task_status(task, message='공용 실행 환경 확인 중...')
            try:
                self._verify_runtime(self._managed_path(self._relative_folder(spec)), task.cancel_event)
            except UpscaleCancelled:
                raise
            except UpscaleAssetError:
                # A complete-looking but unusable runtime is replaced through
                # the same staged, rollback-safe installation path.
                pass
            else:
                return

        stage, destination = self._stage_for(spec, task)
        downloads = spec.get('downloads')
        if not isinstance(downloads, list) or not downloads:
            raise UpscaleAssetError('업스케일 다운로드 목록이 올바르지 않습니다.')
        for index, download in enumerate(downloads):
            self._check_cancelled(task)
            if not isinstance(download, dict):
                raise UpscaleAssetError('업스케일 다운로드 목록이 올바르지 않습니다.')
            label = '공용 실행 환경' if is_runtime else '모델 파일'
            self._set_task_status(task, message=f'{label} 다운로드 중... ({index + 1}/{len(downloads)})')
            archive = stage / f'.download-{index}.tmp'
            self._download_to_file(download, archive, task)
            self._check_cancelled(task)
            self._set_task_status(task, message='설치 파일을 준비하는 중...')
            self._install_download(download, archive, stage, task)
            try:
                archive.unlink()
            except OSError:
                pass
        if engine == _RUNTIME_ID:
            self._configure_runtime(stage)
        self._check_required_in_stage(spec, stage)
        if is_runtime:
            self._set_task_status(task, message='공용 실행 환경을 확인하는 중...')
            self._verify_runtime(stage, task.cancel_event)
        self._check_cancelled(task)
        self._set_task_status(task, message='설치를 마무리하는 중...')
        self._commit_stage(stage, destination, spec)

    def _download_to_file(self, item, destination, task):
        url = item.get('url')
        parsed = urllib.parse.urlparse(url if isinstance(url, str) else '')
        if parsed.scheme.lower() != 'https' or not parsed.hostname or parsed.username or parsed.password:
            raise UpscaleAssetError('업스케일 다운로드 주소 설정이 올바르지 않습니다.')
        expected_hash = item.get('sha256')
        expected_size = item.get('size')
        if not isinstance(expected_hash, str) or not re.fullmatch(r'[0-9a-fA-F]{64}', expected_hash):
            raise UpscaleAssetError('업스케일 무결성 설정이 올바르지 않습니다.')
        if not isinstance(expected_size, int) or isinstance(expected_size, bool) or expected_size < 0:
            raise UpscaleAssetError('업스케일 크기 설정이 올바르지 않습니다.')
        self._check_no_reparse(destination)
        hasher = hashlib.sha256()
        received = 0
        try:
            with _open_https(url) as response, open(destination, 'xb') as output:
                final_url = response.geturl()
                if urllib.parse.urlparse(final_url).scheme.lower() != 'https':
                    raise UpscaleAssetError('보안 연결이 아닌 다운로드는 허용되지 않습니다.')
                while True:
                    self._check_cancelled(task)
                    chunk = response.read(_CHUNK_SIZE)
                    if not chunk:
                        break
                    received += len(chunk)
                    if received > expected_size:
                        raise UpscaleAssetError('다운로드 파일 크기가 일치하지 않습니다.')
                    output.write(chunk)
                    hasher.update(chunk)
                    with self._lock:
                        task.download_bytes += len(chunk)
                        if task.total_bytes:
                            task.progress = min(95, int(task.download_bytes * 95 / task.total_bytes))
            if received != expected_size:
                raise UpscaleAssetError('다운로드 파일 크기가 일치하지 않습니다.')
            if hasher.hexdigest().lower() != expected_hash.lower():
                raise UpscaleAssetError('다운로드 파일 무결성 확인에 실패했습니다.')
        except UpscaleCancelled:
            raise
        except UpscaleAssetError:
            raise
        except Exception as error:
            raise UpscaleAssetError('업스케일 파일을 다운로드하지 못했습니다.') from error

    def _install_download(self, item, archive_path, stage, task):
        kind = item.get('kind')
        try:
            target = _safe_relative(item.get('target'), allow_dot=kind in ('zip', 'wheel'))
        except ValueError as error:
            raise UpscaleAssetError('업스케일 다운로드 경로 설정이 올바르지 않습니다.') from error
        if kind == 'file':
            destination = self._safe_destination(stage, target)
            destination.parent.mkdir(parents=True, exist_ok=True)
            self._check_no_reparse(destination)
            if destination.exists():
                raise UpscaleAssetError('업스케일 파일이 중복되었습니다.')
            os.replace(archive_path, destination)
            return
        if kind not in ('zip', 'wheel'):
            raise UpscaleAssetError('지원하지 않는 업스케일 압축 형식입니다.')
        members = item.get('members')
        if members is not None and not isinstance(members, dict):
            raise UpscaleAssetError('업스케일 압축 목록이 올바르지 않습니다.')
        try:
            with zipfile.ZipFile(archive_path) as archive:
                self._extract_archive(archive, item, stage, target, task)
        except UpscaleCancelled:
            raise
        except UpscaleAssetError:
            raise
        except (OSError, zipfile.BadZipFile, RuntimeError, NotImplementedError) as error:
            raise UpscaleAssetError('업스케일 압축 파일을 처리하지 못했습니다.') from error

    def _extract_archive(self, archive, item, stage, target, task):
        entries = archive.infolist()
        members = item.get('members')
        strip_top = bool(item.get('strip_top'))
        if strip_top and members:
            raise UpscaleAssetError('업스케일 압축 경로 설정이 올바르지 않습니다.')
        normalized_entries = []
        for info in entries:
            try:
                member_path = _safe_relative(info.filename.rstrip('/'), allow_dot=info.is_dir())
            except ValueError as error:
                raise UpscaleAssetError('압축 파일에 허용되지 않은 경로가 있습니다.') from error
            mode = (info.external_attr >> 16) & 0xFFFF
            file_type = stat.S_IFMT(mode)
            if file_type == stat.S_IFLNK or (file_type not in (0, stat.S_IFREG, stat.S_IFDIR)):
                raise UpscaleAssetError('압축 파일에 허용되지 않은 항목이 있습니다.')
            normalized_entries.append((info, member_path, info.is_dir()))

        mapped_members = {}
        if members:
            for archive_name, destination in members.items():
                try:
                    source = _safe_relative(archive_name)
                    target_path = _safe_relative(destination, allow_dot=True)
                except ValueError as error:
                    raise UpscaleAssetError('업스케일 압축 경로 설정이 올바르지 않습니다.') from error
                mapped_members[source.as_posix()] = target_path
            found = set()
            for info, member_path, is_dir in normalized_entries:
                key = member_path.as_posix()
                if not is_dir and key in mapped_members:
                    found.add(key)
                    out_relative = target / mapped_members[key]
                    self._copy_zip_member(archive, info, stage, out_relative, task)
            if found != set(mapped_members):
                raise UpscaleAssetError('필요한 업스케일 파일이 압축 파일에 없습니다.')
            return

        strip_root = None
        if strip_top:
            roots = set()
            for _info, member_path, is_dir in normalized_entries:
                parts = member_path.parts
                if is_dir and len(parts) == 1:
                    roots.add(parts[0])
                elif len(parts) >= 2:
                    roots.add(parts[0])
                else:
                    raise UpscaleAssetError('압축 파일의 최상위 폴더 구성이 올바르지 않습니다.')
            if len(roots) != 1:
                raise UpscaleAssetError('압축 파일의 최상위 폴더 구성이 올바르지 않습니다.')
            strip_root = next(iter(roots))

        seen = set()
        for info, member_path, is_dir in normalized_entries:
            if is_dir:
                continue
            parts = member_path.parts
            if strip_root is not None:
                if not parts or parts[0] != strip_root or len(parts) < 2:
                    raise UpscaleAssetError('압축 파일의 최상위 폴더 구성이 올바르지 않습니다.')
                parts = parts[1:]
            archive_relative = PurePosixPath(*parts)
            if item.get('kind') == 'wheel':
                archive_relative = self._wheel_destination(archive_relative)
                if archive_relative is None:
                    continue
            relative = target / archive_relative
            destination = self._safe_destination(stage, relative)
            key = destination.relative_to(stage).as_posix().casefold()
            if key in seen:
                raise UpscaleAssetError('압축 파일에 중복 경로가 있습니다.')
            seen.add(key)
            self._copy_zip_member(archive, info, stage, relative, task)

    def _wheel_destination(self, relative):
        parts = list(relative.parts)
        # Eager inference never compiles C++ extensions. PyTorch's developer
        # headers include names exceeding Windows MAX_PATH in portable folders.
        if parts[:2] == ['torch', 'include']:
            return None
        for index, part in enumerate(parts):
            if part.endswith('.data'):
                if index + 1 >= len(parts):
                    raise UpscaleAssetError('Python wheel의 설치 경로가 올바르지 않습니다.')
                category = parts[index + 1]
                # This runtime imports packages only; pip's console scripts,
                # headers and manual pages are not needed for inference.
                if category in ('scripts', 'headers', 'data'):
                    return None
                if category not in ('purelib', 'platlib'):
                    raise UpscaleAssetError('Python wheel에 지원하지 않는 스크립트 자료가 있습니다.')
                remainder = parts[index + 2:]
                if not remainder:
                    raise UpscaleAssetError('Python wheel의 설치 경로가 올바르지 않습니다.')
                return PurePosixPath(*remainder)
        return relative

    def _safe_destination(self, base, relative):
        relative = _safe_relative(relative.as_posix() if isinstance(relative, PurePosixPath) else str(relative),
                                  allow_dot=True)
        destination = base.joinpath(*(() if str(relative) == '.' else relative.parts))
        if not is_subpath(str(destination), str(base)):
            raise UpscaleAssetError('압축 파일 경로가 허용 범위를 벗어났습니다.')
        self._check_no_reparse(destination)
        return destination

    def _copy_zip_member(self, archive, info, stage, relative, task):
        destination = self._safe_destination(stage, relative)
        self._ensure_directory(destination.parent)
        if destination.exists():
            raise UpscaleAssetError('압축 파일에 중복 경로가 있습니다.')
        self._check_cancelled(task)
        try:
            with archive.open(info, 'r') as source, open(destination, 'xb') as output:
                while True:
                    self._check_cancelled(task)
                    chunk = source.read(_CHUNK_SIZE)
                    if not chunk:
                        break
                    output.write(chunk)
        except UpscaleCancelled:
            raise
        except (OSError, RuntimeError, zipfile.BadZipFile) as error:
            raise UpscaleAssetError('업스케일 압축 파일을 풀지 못했습니다.') from error

    def _check_required_in_stage(self, spec, stage):
        for relative in self._required_paths(spec):
            folder = self._relative_folder(spec)
            inside = relative.relative_to(folder)
            target = self._safe_destination(stage, inside)
            if not _is_regular_file(target):
                raise UpscaleAssetError('필요한 업스케일 파일이 다운로드되지 않았습니다.')

    def _configure_runtime(self, stage):
        pth = stage / 'python311._pth'
        self._check_no_reparse(pth)
        try:
            pth.write_text('python311.zip\n.\nLib/site-packages\nimport site\n', encoding='ascii', newline='\n')
        except OSError as error:
            raise UpscaleAssetError('업스케일 실행 환경을 설정하지 못했습니다.') from error

    def _verify_runtime(self, runtime_folder, cancel_event=None):
        python = runtime_folder / 'python.exe'
        if not _is_regular_file(python):
            raise UpscaleAssetError('업스케일 실행 환경 Python을 찾을 수 없습니다.')
        try:
            code, _output = run_process_with_cancel(
                [str(python), '-I', '-c', _RUNTIME_IMPORT_CHECK], cancel_event,
                cwd=str(runtime_folder),
            )
        except UpscaleCancelled:
            raise
        except Exception as error:
            raise UpscaleAssetError('업스케일 실행 환경 확인에 실패했습니다.') from error
        if code != 0:
            raise UpscaleAssetError('업스케일 실행 환경 확인에 실패했습니다.')

    def _commit_stage(self, stage, destination, spec):
        self._check_no_reparse(destination)
        backup = destination.parent / f'.{destination.name}.backup-{uuid.uuid4().hex}'
        moved_previous = False
        try:
            if destination.exists():
                self._check_tree_no_reparse(destination)
                os.replace(destination, backup)
                moved_previous = True
            os.replace(stage, destination)
            if not self._required_files_exist(spec):
                raise UpscaleAssetError('설치된 업스케일 파일을 확인하지 못했습니다.')
        except Exception:
            if destination.exists() and moved_previous:
                self._remove_managed_tree(destination)
            if moved_previous and backup.exists():
                os.replace(backup, destination)
            raise
        if moved_previous and backup.exists():
            self._remove_managed_tree(backup)

    def _check_tree_no_reparse(self, folder):
        self._check_no_reparse(folder)
        if not folder.exists():
            return
        pending = [folder]
        while pending:
            current = pending.pop()
            self._check_no_reparse(current)
            try:
                entries = list(os.scandir(current))
            except OSError as error:
                raise UpscaleAssetError('업스케일 자료를 확인하지 못했습니다.') from error
            for entry in entries:
                child = Path(entry.path)
                if _has_reparse_point(child):
                    raise UpscaleAssetError('업스케일 자료에 허용되지 않은 연결 경로가 있습니다.')
                try:
                    if entry.is_dir(follow_symlinks=False):
                        pending.append(child)
                except OSError as error:
                    raise UpscaleAssetError('업스케일 자료를 확인하지 못했습니다.') from error

    def _remove_managed_tree(self, folder):
        self._check_tree_no_reparse(folder)
        if not folder.exists():
            return
        def remove_directory(current):
            for entry in os.scandir(current):
                child = Path(entry.path)
                if _has_reparse_point(child):
                    raise UpscaleAssetError('업스케일 자료에 허용되지 않은 연결 경로가 있습니다.')
                if entry.is_dir(follow_symlinks=False):
                    remove_directory(child)
                    child.rmdir()
                else:
                    child.unlink()
        remove_directory(folder)
        folder.rmdir()

    def _cleanup_task_staging(self, task):
        for stage in tuple(task.stage_dirs):
            try:
                if stage.exists():
                    self._remove_managed_tree(stage)
            except (OSError, UpscaleAssetError):
                pass
            finally:
                task.stage_dirs.discard(stage)

    def delete(self, engine):
        spec = self._spec(engine)
        with self._lock:
            if self._active_task is not None:
                raise UpscaleAssetConflict('업스케일 모델 설치가 끝난 뒤 삭제할 수 있습니다.')
            if self._use_counts.get(engine, 0):
                raise UpscaleAssetConflict('현재 사용 중인 업스케일 모델은 삭제할 수 없습니다.')
            folder = self._managed_path(self._relative_folder(spec))
            if folder.exists():
                self._remove_managed_tree(folder)
            self._states[engine] = ('missing', '모델 파일을 설치해야 합니다.', 0, 0)
            if spec.get('dependency') == _RUNTIME_ID:
                self._remove_runtime_if_unused(excluding=engine)

    def _remove_runtime_if_unused(self, excluding):
        catalog = self._catalog()
        for engine, spec in catalog.items():
            if engine in (_RUNTIME_ID, excluding) or not isinstance(spec, dict):
                continue
            if spec.get('dependency') == _RUNTIME_ID and self._is_installed(engine, spec):
                return
            if spec.get('dependency') == _RUNTIME_ID and self._use_counts.get(engine, 0):
                return
        if self._use_counts.get(_RUNTIME_ID, 0):
            return
        runtime_folder = self._managed_path(self._relative_folder(self._runtime_spec()))
        if runtime_folder.exists():
            self._remove_managed_tree(runtime_folder)

    @contextmanager
    def use(self, engine):
        spec = self._spec(engine)
        with self._lock:
            if self._closing:
                raise UpscaleAssetConflict('업스케일 자료 관리가 종료 중입니다.')
            if self._active_task and (
                self._active_task.engine == engine or (
                    spec.get('dependency') == _RUNTIME_ID
                    and not self._required_files_exist(self._runtime_spec())
                )
            ):
                raise UpscaleAssetConflict('모델 설치가 끝난 뒤 업스케일을 시작해 주세요.')
            self._use_counts[engine] = self._use_counts.get(engine, 0) + 1
        try:
            yield self.paths(engine)
        finally:
            with self._lock:
                count = self._use_counts.get(engine, 0) - 1
                if count > 0:
                    self._use_counts[engine] = count
                else:
                    self._use_counts.pop(engine, None)

    def paths(self, engine):
        spec = self._spec(engine)
        required = self._required_paths(spec)
        first = self._managed_path(required[0])
        result = {'model': str(first)}
        if spec.get('dependency') == _RUNTIME_ID:
            runtime = self._runtime_spec()
            python = self._managed_path(self._relative_folder(runtime) / 'python.exe')
            result['python'] = str(python)
        return result

    def shutdown(self, timeout=5):
        deadline = time.monotonic() + max(0, float(timeout))
        with self._lock:
            self._closing = True
            task = self._active_task
            if task is not None:
                task.cancel_event.set()
                worker = task.thread
            else:
                worker = None
        if worker is not None and worker is not threading.current_thread():
            worker.join(timeout=max(0, deadline - time.monotonic()))
        return worker is None or not worker.is_alive()


class _HTTPSOnlyRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        resolved = urllib.parse.urljoin(request.full_url, new_url)
        if urllib.parse.urlparse(resolved).scheme.lower() != 'https':
            raise urllib.error.URLError('Insecure redirect rejected')
        return super().redirect_request(request, fp, code, message, headers, resolved)


def _open_https(url):
    opener = urllib.request.build_opener(_HTTPSOnlyRedirectHandler())
    request = urllib.request.Request(url, headers={'User-Agent': 'NAI-Image-Manager'})
    response = opener.open(request, timeout=30)
    if urllib.parse.urlparse(response.geturl()).scheme.lower() != 'https':
        response.close()
        raise urllib.error.URLError('Insecure download rejected')
    return response


UPSCALE_ASSETS = UpscaleAssets()
