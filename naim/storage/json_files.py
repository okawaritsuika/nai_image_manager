"""Atomic JSON persistence and lossless recovery of malformed settings.

Locks coordinate threads in this process. They are not a multi-process lock.
Corrupt originals are backed up before replacement; a failed backup stops writes.
"""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
import uuid

from naim.paths import path_identity_key


_locks = {}
_locks_guard = threading.Lock()


@contextmanager
def json_lock(path):
    key = path_identity_key(path)
    with _locks_guard:
        lock = _locks.setdefault(key, threading.RLock())
    with lock:
        yield


def _backup_corrupt(path):
    backup = path.with_name(f"{path.name}.corrupt-{uuid.uuid4().hex}.bak")
    shutil.copy2(path, backup)
    return backup


def _replace_json(path, data, indent):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent,
            prefix=f".{path.name}.", suffix=".tmp", delete=False,
        ) as target:
            temporary = Path(target.name)
            json.dump(data, target, ensure_ascii=False, indent=indent)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def read_json(path, default_factory=dict, *, expected_type=None, indent=4):
    """Read settings; preserve malformed bytes before resetting to defaults."""
    path = Path(path)
    with json_lock(path):
        try:
            with path.open(encoding="utf-8") as source:
                data = json.load(source)
        except FileNotFoundError:
            return default_factory()
        except (ValueError, UnicodeError):
            _backup_corrupt(path)
            data = default_factory()
            _replace_json(path, data, indent)
            return data
        if expected_type is not None and not isinstance(data, expected_type):
            _backup_corrupt(path)
            data = default_factory()
            _replace_json(path, data, indent)
        return data


def write_json(path, data, *, indent=4):
    """Replace a JSON file only after serialization and flush succeed."""
    path = Path(path)
    with json_lock(path):
        # Direct save callers must also preserve a pre-existing damaged file.
        try:
            with path.open(encoding="utf-8") as source:
                json.load(source)
        except FileNotFoundError:
            pass
        except (ValueError, UnicodeError):
            _backup_corrupt(path)
        _replace_json(path, data, indent)


def merge_json_object(path, changes):
    """Keep unknown/older setting keys across a partial settings update."""
    with json_lock(path):
        data = read_json(path, expected_type=dict)
        if isinstance(changes, dict):
            data.update(changes)
        write_json(path, data)
        return data
