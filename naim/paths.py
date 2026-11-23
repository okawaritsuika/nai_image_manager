"""Legacy path containment rules shared by filesystem and database callers."""
import os
import sys
import time

WINDOWS_FILE_LOCK_ERRORS = (5, 32, 33)


def retry_windows_file_lock(operation, *args):
    """Retry only sharing and access conflicts, keeping ordinary filesystem calls single-shot."""
    for delay in (0.03, 0.06, 0.12, 0.24, None):
        try:
            return operation(*args)
        except OSError as error:
            if delay is None or getattr(error, 'winerror', None) not in WINDOWS_FILE_LOCK_ERRORS:
                raise
            time.sleep(delay)

def get_app_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def get_file_creation_time(path, fallback=0):
    """Return birth time; Unix metadata-change time is not a creation time."""
    try:
        stat = os.stat(path)
    except OSError:
        return float(fallback or 0)
    birthtime = getattr(stat, "st_birthtime", None)
    if birthtime is not None:
        return float(birthtime)
    return float(stat.st_ctime if os.name == "nt" else stat.st_mtime)

def path_identity_key(path):
    """Return a comparison key for equivalent Windows paths and JSON locks."""
    key = os.path.normcase(os.path.abspath(path))
    if os.name != "nt":
        return key
    if key.startswith("\\\\?\\unc\\"):
        return "\\\\" + key[8:]
    if (key.startswith("\\\\?\\") and len(key) >= 7
            and "a" <= key[4] <= "z" and key[5:7] == ":\\"):
        return key[4:]
    return key

def is_subpath(target_path, base_path):
    try:
        common_path = os.path.commonpath([os.path.abspath(target_path), os.path.abspath(base_path)])
        return common_path == os.path.abspath(base_path)
    except ValueError:
        return False

def resolve_safe_path(base_path, rel_path, strip_prefix=None):
    normalized_rel_path = str(rel_path or "").replace('\\', '/')
    if strip_prefix:
        normalized_rel_path = normalized_rel_path.replace(strip_prefix, "", 1)
    normalized_rel_path = normalized_rel_path.lstrip('/')
    resolved_path = os.path.normpath(os.path.join(base_path, normalized_rel_path))
    if not is_subpath(resolved_path, base_path):
        raise ValueError("허용되지 않은 경로입니다.")
    return resolved_path
