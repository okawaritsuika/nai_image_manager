"""Inspect and save a local link to an existing artist-rater data folder."""
from dataclasses import dataclass, field
import hashlib
import json
from pathlib import Path
import sys

from naim.storage.json_files import json_lock, write_json
from naim.web.style_shared_settings import _validate_key


_MAX_JSON_BYTES = 4 * 1024 * 1024
_SQLITE_HEADER = b"SQLite format 3\x00"


@dataclass(frozen=True)
class _FileSnapshot:
    exists: bool
    digest: str = ""


@dataclass(frozen=True)
class ConnectionPreview:
    selected_dir: str
    source_dir: str
    data_dir: str
    python: str
    key_choice_required: bool
    current_key_present: bool
    source_key_present: bool
    settings_present: bool
    _app_dir: Path = field(repr=False, compare=False)
    _config_snapshot: _FileSnapshot = field(repr=False, compare=False)
    _lab_snapshot: _FileSnapshot = field(repr=False, compare=False)
    _source_settings_snapshot: _FileSnapshot = field(repr=False, compare=False)
    _source_key: str = field(repr=False, compare=False)


class AmbiguousDataDirectories(ValueError):
    """Raised when a selected folder contains multiple valid data databases."""

    def __init__(self, directories):
        self.directories = tuple(str(path) for path in directories)
        super().__init__("기존 그림체 데이터 폴더가 여러 개입니다. 사용할 폴더를 직접 선택해 주세요.")


def _reject_constant(_value):
    raise ValueError("invalid JSON constant")


def _object_from_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON field")
        result[key] = value
    return result


def _read_json_object(path):
    """Read a bounded JSON object without repairing or rewriting malformed files."""
    path = Path(path)
    try:
        with path.open("rb") as source:
            raw = source.read(_MAX_JSON_BYTES + 1)
    except FileNotFoundError:
        return {}, _FileSnapshot(False)
    except OSError:
        raise ValueError("연결 설정 파일을 읽을 수 없습니다.") from None

    if len(raw) > _MAX_JSON_BYTES:
        raise ValueError("연결 설정 파일 크기가 너무 큽니다.")
    try:
        data = json.loads(
            raw.decode("utf-8-sig"),
            object_pairs_hook=_object_from_pairs,
            parse_constant=_reject_constant,
        )
    except (UnicodeError, json.JSONDecodeError, RecursionError, ValueError):
        raise ValueError("연결 설정 파일 형식이 올바르지 않습니다.") from None
    if not isinstance(data, dict):
        raise ValueError("연결 설정 파일은 JSON 객체여야 합니다.")
    return data, _FileSnapshot(True, hashlib.sha256(raw).hexdigest())


def _as_path(value, message):
    try:
        return Path(value)
    except (TypeError, ValueError, OSError):
        raise ValueError(message) from None


def _resolved_directory(value, message):
    path = _as_path(value, message)
    try:
        if not path.is_dir():
            raise ValueError(message)
        return path.resolve(strict=True)
    except (OSError, RuntimeError):
        raise ValueError(message) from None


def _has_database(data_dir):
    database = data_dir / "artist_rater.sqlite"
    try:
        if not database.is_file():
            return False
        with database.open("rb") as source:
            return source.read(16) == _SQLITE_HEADER
    except OSError:
        return False


def _candidate_data_directories(selected_dir):
    candidates = []
    seen = set()
    for path in (
        selected_dir,
        selected_dir / "data",
        selected_dir / "artist_rater" / "data",
    ):
        try:
            if not path.is_dir():
                continue
            resolved = path.resolve(strict=True)
        except (OSError, RuntimeError):
            continue
        identity = str(resolved).casefold()
        if identity in seen or not _has_database(resolved):
            continue
        seen.add(identity)
        candidates.append(resolved)
    return candidates


def _has_runtime(source_dir):
    return (source_dir / "naim_runner.py").is_file() and (source_dir / "app.py").is_file()


def _select_source_directory(config, selected_dir):
    configured = config.get("source_dir")
    if isinstance(configured, str) and configured.strip():
        try:
            configured_dir = _resolved_directory(
                configured, "기존 연결 실행 폴더를 확인할 수 없습니다."
            )
        except ValueError:
            configured_dir = None
        if configured_dir is not None and _has_runtime(configured_dir):
            return configured_dir

    for candidate in (selected_dir, selected_dir / "artist_rater"):
        if candidate.is_dir() and _has_runtime(candidate):
            try:
                return candidate.resolve(strict=True)
            except (OSError, RuntimeError):
                continue
    raise ValueError("호환되는 그림체 실행 환경을 찾을 수 없습니다. 앱 폴더를 선택해 주세요.")


def _select_python(config, source_dir):
    configured = config.get("python")
    if isinstance(configured, str) and configured.strip():
        try:
            configured_path = _as_path(configured, "Python 경로를 확인할 수 없습니다.")
            if configured_path.is_file():
                return configured_path.resolve(strict=True)
        except (OSError, RuntimeError, ValueError):
            pass

    for candidate in (
        source_dir / ".venv" / "Scripts" / "python.exe",
        source_dir.parent / ".venv" / "Scripts" / "python.exe",
    ):
        if candidate.is_file():
            try:
                return candidate.resolve(strict=True)
            except (OSError, RuntimeError):
                continue

    if not getattr(sys, "frozen", False):
        interpreter = Path(sys.executable)
        if interpreter.is_file():
            try:
                return interpreter.resolve(strict=True)
            except (OSError, RuntimeError):
                pass
    raise ValueError("사용할 Python 실행 파일을 찾을 수 없습니다.")


def _normalized_setting_key(settings, name, error_message):
    value = settings.get(name)
    if not isinstance(value, str):
        return ""
    try:
        return _validate_key(value)
    except ValueError:
        raise ValueError(error_message) from None


def inspect_connection(app_dir, selected_dir, *, data_dir=None):
    """Build a read-only preview of a compatible existing artist-rater folder."""
    app_root = _resolved_directory(app_dir, "NAIM 프로그램 폴더를 확인할 수 없습니다.")
    selected_root = _resolved_directory(selected_dir, "선택한 폴더를 확인할 수 없습니다.")
    config_path = app_root / "style_workspace.local.json"
    lab_path = app_root / "lab_config.json"
    config, config_snapshot = _read_json_object(config_path)
    lab, lab_snapshot = _read_json_object(lab_path)

    candidates = _candidate_data_directories(selected_root)
    if not candidates:
        raise ValueError("선택한 폴더에서 기존 그림체 데이터베이스를 찾을 수 없습니다.")
    if data_dir is None:
        if len(candidates) > 1:
            raise AmbiguousDataDirectories(candidates)
        selected_data = candidates[0]
    else:
        requested_data = _resolved_directory(
            data_dir, "선택한 데이터 폴더를 확인할 수 없습니다."
        )
        selected_data = next((path for path in candidates if path == requested_data), None)
        if selected_data is None:
            raise ValueError("선택한 데이터 폴더에 유효한 그림체 데이터베이스가 없습니다.")

    source_settings, source_settings_snapshot = _read_json_object(selected_data / "settings.json")
    source_key = _normalized_setting_key(
        source_settings,
        "novelai_app_key",
        "연결 앱의 API 키 설정을 확인해 주세요.",
    )
    current_key = _normalized_setting_key(
        lab,
        "key",
        "NAIM 공통 API 키 설정을 확인해 주세요.",
    )

    source = _select_source_directory(config, selected_root)
    python = _select_python(config, source)
    return ConnectionPreview(
        selected_dir=str(selected_root),
        source_dir=str(source),
        data_dir=str(selected_data),
        python=str(python),
        key_choice_required=bool(source_key and source_key != current_key),
        current_key_present=bool(current_key),
        source_key_present=bool(source_key),
        settings_present=source_settings_snapshot.exists,
        _app_dir=app_root,
        _config_snapshot=config_snapshot,
        _lab_snapshot=lab_snapshot,
        _source_settings_snapshot=source_settings_snapshot,
        _source_key=source_key,
    )


def _snapshot_matches(preview, current):
    return (
        preview._config_snapshot == current._config_snapshot
        and preview._lab_snapshot == current._lab_snapshot
        and preview._source_settings_snapshot == current._source_settings_snapshot
        and preview.selected_dir == current.selected_dir
        and preview.source_dir == current.source_dir
        and preview.data_dir == current.data_dir
        and preview.python == current.python
    )


def _restore_config(config_path, original_config, originally_present):
    if originally_present:
        write_json(config_path, original_config)
    else:
        config_path.unlink(missing_ok=True)


def save_connection(preview, key_choice=None):
    """Save the link, preserving unknown settings and guarding against stale previews."""
    if not isinstance(preview, ConnectionPreview):
        raise ValueError("연결 미리보기를 다시 만들어 주세요.")
    if preview.key_choice_required and key_choice not in ("keep", "use_source"):
        raise ValueError("공통 API 키를 유지할지 연결 앱 키를 사용할지 선택해 주세요.")
    if key_choice not in (None, "keep", "use_source"):
        raise ValueError("공통 API 키 선택을 확인해 주세요.")
    use_source_key = key_choice == "use_source"
    if use_source_key and not preview.source_key_present:
        raise ValueError("연결 앱에 사용할 수 있는 API 키가 없습니다.")

    current_preview = inspect_connection(
        preview._app_dir,
        preview.selected_dir,
        data_dir=preview.data_dir,
    )
    if not _snapshot_matches(preview, current_preview):
        raise ValueError("미리보기 후 설정이 변경되었습니다. 폴더를 다시 선택해 주세요.")

    config_path = preview._app_dir / "style_workspace.local.json"
    lab_path = preview._app_dir / "lab_config.json"
    try:
        with json_lock(config_path):
            with json_lock(lab_path):
                config, config_snapshot = _read_json_object(config_path)
                lab, lab_snapshot = _read_json_object(lab_path)
                source_settings, source_snapshot = _read_json_object(
                    Path(preview.data_dir) / "settings.json"
                )
                current_check = inspect_connection(
                    preview._app_dir,
                    preview.selected_dir,
                    data_dir=preview.data_dir,
                )
                if (
                    config_snapshot != preview._config_snapshot
                    or lab_snapshot != preview._lab_snapshot
                    or source_snapshot != preview._source_settings_snapshot
                    or not _snapshot_matches(preview, current_check)
                ):
                    raise ValueError("미리보기 후 설정이 변경되었습니다. 폴더를 다시 선택해 주세요.")

                updated_config = dict(config)
                updated_config.update({
                    "source_dir": preview.source_dir,
                    "python": preview.python,
                    "data_dir": preview.data_dir,
                })
                updated_lab = dict(lab)
                if use_source_key:
                    source_key = _normalized_setting_key(
                        source_settings,
                        "novelai_app_key",
                        "연결 앱의 API 키 설정을 확인해 주세요.",
                    )
                    if not source_key:
                        raise ValueError("연결 앱에 사용할 수 있는 API 키가 없습니다.")
                    updated_lab["key"] = _validate_key(source_key)

                try:
                    write_json(config_path, updated_config)
                    if use_source_key:
                        write_json(lab_path, updated_lab)
                except Exception:
                    try:
                        _restore_config(config_path, config, config_snapshot.exists)
                    except Exception:
                        raise RuntimeError(
                            "연결 설정 저장에 실패했고 기존 설정도 복구하지 못했습니다. 설정 파일을 확인해 주세요."
                        ) from None
                    raise RuntimeError(
                        "연결 설정 저장에 실패했습니다. 기존 연결 설정을 복구했습니다."
                    ) from None
    except (OSError, ValueError, RuntimeError):
        raise
    return None


def current_connection(app_dir):
    """Return the effective configured runtime paths without reading any keys."""
    app_root = _resolved_directory(app_dir, "NAIM 프로그램 폴더를 확인할 수 없습니다.")
    config, _snapshot = _read_json_object(app_root / "style_workspace.local.json")
    source = config.get("source_dir", "")
    data = config.get("data_dir")
    if not isinstance(source, str) or not isinstance(data, (str, type(None))):
        raise ValueError("그림체 연결 설정을 확인해 주세요.")
    if not data and source:
        data = str(Path(source) / "data")
    return {"source_dir": source, "data_dir": data or ""}
