"""Offline import of portable user data. Never imports the live application."""
from contextlib import closing
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import uuid

from naim_updater import PROTECTED_FILES


DATA_DIRECTORIES = ('TOTAL_CLASSIFIED', 'output', 'canvas_imports', 'daki_generated_temp', 'daki_style_tests', 'daki_imported_styles', 'daki_personal_styles', 'daki_worldcups', 'daki_drafts', 'daki_tag_examples', 'daki_dictionary_user')
DATA_FILES = tuple(sorted(PROTECTED_FILES)) + ('data/tag_categories_ko.json',)


def _regular_tree(path):
    if path.is_symlink() or getattr(path.stat(), 'st_file_attributes', 0) & 0x400:
        raise ValueError('링크 폴더는 가져올 수 없습니다.')
    if path.is_dir():
        for child in path.iterdir():
            _regular_tree(child)


def _validate_member(root, path):
    for parent in (path,) + tuple(path.parents):
        if parent == root:
            break
        if parent.exists() and (parent.is_symlink() or getattr(parent.stat(), 'st_file_attributes', 0) & 0x400):
            raise ValueError('링크 경로는 가져올 수 없습니다.')
    if path.exists():
        _regular_tree(path)


def inspect_installation(source, destination):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if source == destination or source in destination.parents or destination in source.parents:
        raise ValueError('현재 프로그램과 분리된 기존 프로그램 폴더를 선택해 주세요.')
    if not source.is_dir():
        raise ValueError('기존 프로그램 폴더를 찾을 수 없습니다.')
    if not ((source / 'TOTAL_CLASSIFIED').is_dir() or any((source / name).is_file() for name in ('gallery_config.json', 'lab_config.json', 'canvas_saved_setups.json'))):
        raise ValueError('EXE와 설정 또는 TOTAL_CLASSIFIED가 들어 있는 프로그램 폴더 전체를 선택해 주세요.')
    items = []
    for name in DATA_DIRECTORIES + DATA_FILES:
        path = source / name
        if path.exists():
            _validate_member(source, path)
            items.append(name)
    return source, destination, items


def _relocate(value, source, destination):
    if not isinstance(value, str) or not os.path.isabs(value):
        return value
    path = Path(value)
    try:
        return str(destination / path.relative_to(source))
    except ValueError:
        return value


def _prepare_history(stage, source, destination):
    relative = Path('TOTAL_CLASSIFIED/naia_history.db')
    original = source / relative
    if not original.is_file():
        return
    copied = stage / relative
    # A SQLite backup includes committed WAL data; copying the main DB alone
    # would lose recent classifications. The source connection is read-only.
    copied.unlink(missing_ok=True)
    for suffix in ('-wal', '-shm', '-journal'):
        Path(str(copied) + suffix).unlink(missing_ok=True)
    with closing(sqlite3.connect(original.as_uri() + '?mode=ro', uri=True)) as src, closing(sqlite3.connect(copied)) as dst:
        src.backup(dst)
        if dst.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise ValueError('기존 분류 DB가 손상되어 가져오기를 중단했습니다.')
        tables = {row[0] for row in dst.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for table, columns in (
            ('trash_map', ('trash_path', 'original_path')),
            ('file_metadata', ('path',)), ('image_artists', ('path',)),
            ('artist_scanned_files', ('path',)),
        ):
            if table not in tables:
                continue
            actual = {row[1] for row in dst.execute(f'PRAGMA table_info("{table}")')}
            for column in columns:
                if column not in actual:
                    continue
                for (value,) in dst.execute(f'SELECT DISTINCT "{column}" FROM "{table}"').fetchall():
                    relocated = _relocate(value, source, destination)
                    if relocated != value:
                        dst.execute(f'UPDATE "{table}" SET "{column}"=? WHERE "{column}"=?', (relocated, value))
        dst.commit()


def _prepare_config(stage, source, destination):
    config_path = stage / 'gallery_config.json'
    if config_path.is_file():
        try:
            config = json.loads(config_path.read_text(encoding='utf-8'))
        except (ValueError, UnicodeError):
            return  # The normal loader backs up malformed settings on startup.
        if isinstance(config, dict) and 'path' in config:
            changed = _relocate(config['path'], source, destination)
            if changed != config['path']:
                config['path'] = changed
                config_path.write_text(json.dumps(config, ensure_ascii=False, indent=4), encoding='utf-8')


def import_installation(source, destination):
    source, destination, items = inspect_installation(source, destination)
    destination.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.naim-import-', dir=destination))
    backup = destination / ('import-backup-' + uuid.uuid4().hex)
    moved, published = [], []
    keep_stage = False
    try:
        for relative in items:
            src, dst = source / relative, stage / relative
            dst.parent.mkdir(parents=True, exist_ok=True)
            if src.is_dir():
                shutil.copytree(src, dst)
            else:
                shutil.copy2(src, dst)
        _prepare_history(stage, source, destination)
        _prepare_config(stage, source, destination)
        # Validate all destination trees before changing anything.
        for relative in items:
            target = destination / relative
            _validate_member(destination, target)
        backup.mkdir()
        try:
            for relative in items:
                target = destination / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists():
                    saved = backup / relative
                    saved.parent.mkdir(parents=True, exist_ok=True)
                    os.replace(target, saved)
                    moved.append(relative)
                os.replace(stage / relative, target)
                published.append(relative)
        except Exception:
            try:
                for relative in reversed(published):
                    os.replace(destination / relative, stage / relative)
                for relative in reversed(moved):
                    os.replace(backup / relative, destination / relative)
            except Exception as error:
                keep_stage = True
                raise RuntimeError(f'복구 실패. 백업과 작업 폴더를 보존했습니다: {backup}, {stage}') from error
            raise
        return {'items': items, 'backup': str(backup)}
    finally:
        if not keep_stage:
            shutil.rmtree(stage, ignore_errors=True)
