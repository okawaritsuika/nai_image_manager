"""Disposable display previews, stored outside portable user data.

The cache lives in OS temporary storage and can be deleted at any time. It is
neither an import source nor a release asset. Original images are only read.
The byte budget uses oldest-created eviction, with periodic reconciliation for
other processes; it is best-effort if files are locked or storage is unavailable.
"""
from collections import OrderedDict
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import tempfile
import threading
import time


TRANSFORM_VERSION = 1
DEFAULT_MAX_BYTES = 512 * 1024 * 1024
_MAGIC = b"NAIM_PREVIEW_1\0"
_MIME_CODES = {"image/png": b"P", "image/jpeg": b"J"}
_MIME_TYPES = {value: key for key, value in _MIME_CODES.items()}


def get_display_oriented_image_size(image):
    width, height = image.size
    try:
        orientation = image.getexif().get(274, 1)
    except Exception:
        orientation = 1
    return (height, width) if orientation in (5, 6, 7, 8) else (width, height)


def preview_key(file_path, mtime_ns, file_size, max_side):
    """Hash the source identity without exposing its path in cache filenames."""
    identity = [TRANSFORM_VERSION, os.path.normcase(os.path.abspath(file_path)),
                int(mtime_ns), int(file_size), int(max_side)]
    return hashlib.sha256(json.dumps(identity, ensure_ascii=True).encode()).hexdigest()


class PreviewCache:
    def __init__(self, directory=None, max_bytes=DEFAULT_MAX_BYTES):
        self.directory = Path(directory) if directory is not None else (
            Path(tempfile.gettempdir()) / "nai-image-manager-previews"
        )
        self.max_bytes = max(0, int(max_bytes))
        self._locks = {}
        self._locks_guard = threading.Lock()
        self._write_lock = threading.Lock()
        self._entries = OrderedDict()
        self._total_bytes = 0
        self._last_scan = None

    @contextmanager
    def _key_lock(self, key):
        with self._locks_guard:
            entry = self._locks.setdefault(key, [threading.Lock(), 0])
            entry[1] += 1
        try:
            with entry[0]:
                yield
        finally:
            with self._locks_guard:
                entry[1] -= 1
                if not entry[1]:
                    del self._locks[key]

    def _read(self, path):
        raw = path.read_bytes()
        header_size = len(_MAGIC) + 1 + 32
        if len(raw) <= header_size or not raw.startswith(_MAGIC):
            raise ValueError("Invalid preview cache header")
        mime = _MIME_TYPES.get(raw[len(_MAGIC):len(_MAGIC) + 1])
        data = raw[header_size:]
        if mime is None or hashlib.sha256(data).digest() != raw[header_size - 32:header_size]:
            raise ValueError("Invalid preview cache data")
        return data, mime

    def _scan(self):
        entries = []
        for path in self.directory.iterdir():
            if path.name.startswith(".preview-") and path.suffix == ".tmp":
                try:
                    if time.time() - path.stat().st_mtime > 24 * 60 * 60:
                        path.unlink(missing_ok=True)
                except FileNotFoundError:
                    pass
                continue
            if path.suffix != ".preview" or len(path.stem) != 64:
                continue
            if any(character not in "0123456789abcdef" for character in path.stem):
                continue
            try:
                stat = path.stat()
            except FileNotFoundError:
                continue
            entries.append((stat.st_mtime_ns, path.name, stat.st_size))
        self._entries = OrderedDict((name, size) for _, name, size in sorted(entries))
        self._total_bytes = sum(self._entries.values())
        self._last_scan = time.monotonic()

    def _store(self, path, data, mimetype):
        code = _MIME_CODES.get(mimetype)
        if code is None:
            return
        raw = _MAGIC + code + hashlib.sha256(data).digest() + data
        if len(raw) > self.max_bytes:
            return
        # Only publication and bookkeeping serialize. Image decoding/resizing
        # happens outside this lock, so different source previews run together.
        with self._write_lock:
            self.directory.mkdir(parents=True, exist_ok=True)
            if self._last_scan is None or time.monotonic() - self._last_scan >= 60:
                self._scan()
            self._total_bytes -= self._entries.pop(path.name, 0)
            while self._entries and self._total_bytes + len(raw) > self.max_bytes:
                name, size = next(iter(self._entries.items()))
                (self.directory / name).unlink(missing_ok=True)
                del self._entries[name]
                self._total_bytes -= size
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(dir=self.directory, prefix=".preview-", suffix=".tmp", delete=False) as output:
                    temporary = Path(output.name)
                    output.write(raw)
                os.replace(temporary, path)
                self._entries[path.name] = len(raw)
                self._total_bytes += len(raw)
            except OSError:
                self._last_scan = None
                raise
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)

    def get(self, file_path, mtime_ns, file_size, max_side, build):
        key = preview_key(file_path, mtime_ns, file_size, max_side)
        path = self.directory / (key + ".preview")
        with self._key_lock(key):
            try:
                return self._read(path)
            except (OSError, ValueError):
                pass
            # Builder failures are real image errors and keep their old behavior.
            result = build(file_path, max_side)
            try:
                current = os.stat(file_path)
                if (current.st_mtime_ns, current.st_size) == (mtime_ns, file_size):
                    self._store(path, *result)
            except OSError:
                # Failed eviction/publication can invalidate the size inventory.
                with self._write_lock:
                    self._last_scan = None
            return result
