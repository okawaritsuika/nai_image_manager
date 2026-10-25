"""Publish an image and its sidecars together with rollback on I/O failure."""
from contextlib import contextmanager
import os
from pathlib import Path
import shutil
import tempfile
import threading


IMAGE_FILES_LOCK = threading.RLock()


def image_bundle_paths(image_path):
    path = Path(image_path)
    return (path, path.with_suffix('.json'), path.with_suffix('.txt'))


@contextmanager
def staged_image_removal(image_path):
    """Remove one resolved image bundle, restoring it if its record save fails."""
    target = Path(image_path)
    with IMAGE_FILES_LOCK:
        paths = [path for path in image_bundle_paths(target) if path.exists()]
        # Sidecars must not redirect deletion outside the resolved image folder.
        if any(path.is_symlink() or not path.is_file()
               or path.resolve().parent != target.resolve().parent for path in paths):
            raise ValueError('이미지와 메타데이터 경로를 확인해 주세요.')
        stage = Path(tempfile.mkdtemp(prefix='.naim-delete-', dir=target.parent))
        moved = []
        keep_backup = False
        try:
            try:
                for path in paths:
                    backup = stage / path.name
                    os.replace(path, backup)
                    moved.append((path, backup))
                yield
            except Exception:
                try:
                    for path, backup in reversed(moved):
                        os.replace(backup, path)
                except OSError as error:
                    keep_backup = True
                    raise OSError('그림 복구에 실패하여 임시 백업을 보존했습니다.') from error
                raise
        finally:
            if not keep_backup:
                shutil.rmtree(stage, ignore_errors=True)


@contextmanager
def staged_image_bundle(image_path):
    """Yield a unique staging image path; keep backups if rollback fails.

    This handles ordinary exceptions, not OS crashes or unrelated processes.
    Only files produced by the caller are replaced; absent sidecars are kept.
    """
    target = Path(image_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with IMAGE_FILES_LOCK:
        stage = Path(tempfile.mkdtemp(prefix='.naim-image-', dir=target.parent))
        keep_backup = False
        try:
            staged = stage / target.name
            yield str(staged)
            if not staged.is_file():
                raise FileNotFoundError('저장할 이미지가 생성되지 않았습니다.')
            pairs = [(src, dst) for src, dst in zip(image_bundle_paths(staged), image_bundle_paths(target)) if src.is_file()]
            backups = {}
            for _, dst in pairs:
                if dst.exists():
                    backup = stage / ('backup-' + dst.name)
                    shutil.copy2(dst, backup)
                    backups[dst] = backup
            published = []
            try:
                for src, dst in pairs:
                    os.replace(src, dst)
                    published.append(dst)
            except Exception:
                try:
                    for dst in reversed(published):
                        if dst in backups:
                            shutil.copy2(backups[dst], dst)
                        else:
                            dst.unlink()
                except Exception as error:
                    keep_backup = True
                    raise RuntimeError(f'이미지 복구 실패. 원본 백업을 보존했습니다: {stage}') from error
                raise
        finally:
            if not keep_backup:
                shutil.rmtree(stage, ignore_errors=True)
