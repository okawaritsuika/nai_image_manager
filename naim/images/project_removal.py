"""Archive or remove a whole project through rollback-capable storage owners."""
from contextlib import ExitStack, contextmanager
from pathlib import Path
import os
import re
import shutil
import uuid

from naim.daki_image_refs import parse_daki_image_reference
from naim.images.project_deletion import ProjectImageReferencesConflict
from naim.images.webp_conversion import resolve_webp_image
from naim.paths import get_file_creation_time
from naim.storage.image_files import IMAGE_FILES_LOCK, image_bundle_paths, staged_image_removal
from naim.storage.project_archives import record_archived_images


def _label(value, limit):
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', str(value)).strip(' .')[:limit] or 'image'


@contextmanager
def _archived_bundle(source, folder, name):
    """Copy bytes and sidecars without recompressing; undo only our new files."""
    folder.mkdir(parents=True, exist_ok=True)
    owned = []
    try:
        while True:
            target = folder / f'image_{_label(Path(name).stem, 40)}_{uuid.uuid4().hex[:12]}{source.suffix.lower()}'
            try:
                descriptor = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.close(descriptor)
                owned.append(target)
                break
            except FileExistsError:
                continue
        for src, dst in zip(image_bundle_paths(source), image_bundle_paths(target)):
            if not src.exists():
                continue
            if src.is_symlink() or not src.is_file() or src.resolve().parent != source.resolve().parent:
                raise ValueError('그림과 보조 파일 경로를 확인해 주세요.')
            if dst != target:
                with dst.open('xb'):
                    pass
                owned.append(dst)
            shutil.copy2(src, dst)
        yield target
    except BaseException:
        for path in reversed(owned):
            path.unlink(missing_ok=True)
        raise


def remove_project(store, drafts, project_id, action, *, gallery_root, db_factory,
                   gallery_lock, references_provider=None, confirm_daki=False):
    if action not in ('archive', 'delete') or type(confirm_daki) is not bool:
        raise ValueError('그림 보관 또는 삭제 방식을 선택해 주세요.')
    root = Path(gallery_root).resolve()
    changes = []
    removed_gallery = set()
    affected_folders = set()
    aliases = []
    protected = 0
    db = None
    # Serialize with existing image writers, draft generation, and index rebuilds.
    with IMAGE_FILES_LOCK, drafts.lock, gallery_lock:
        try:
            db = db_factory()
            with ExitStack() as stack:
                project = stack.enter_context(store.staged_project_removal(project_id))
                staged_drafts = stack.enter_context(drafts.staged_project_removal(project_id))
                draft_sources = {}
                for draft in staged_drafts:
                    source = Path(resolve_webp_image(Path(draft['directory']) / 'image.png'))
                    if source.is_file():
                        draft_sources[draft['reference']] = source

                # One physical picture may be registered on both sides or as
                # both a selected candidate and an unselected draft result.
                pictures = {}
                entries = [(item['path'], item.get('name') or Path(item['path']).name)
                           for side in ('front', 'back') for item in project['candidates'][side]]
                entries.extend((reference, f'draft_{Path(reference).name}') for reference in draft_sources)
                for relative, name in entries:
                    source = draft_sources.get(relative)
                    actual = relative
                    staged = source is not None
                    if source is None:
                        try:
                            resolved, actual = store.resolve_image(relative)
                            source = Path(resolved)
                        except FileNotFoundError:
                            continue
                    if not source.is_file():
                        continue
                    if source.is_symlink() or source.suffix.lower() not in ('.png', '.jpg', '.jpeg', '.webp'):
                        raise ValueError('지원하는 일반 그림 파일만 정리할 수 있습니다.')
                    key = os.path.normcase(str(source.resolve()))
                    picture = pictures.setdefault(key, {'source': source, 'name': name, 'staged': staged, 'paths': set()})
                    picture['paths'].update((relative, actual))

                paths = sorted({path for picture in pictures.values() for path in picture['paths']})
                if action == 'delete' and not confirm_daki:
                    references = store.references(paths=paths)
                    if references_provider:
                        references.extend(references_provider(paths) or [])
                    if references:
                        raise ProjectImageReferencesConflict(references)

                folder = root / 'No_Metadata' / '프로젝트 보관' / f'project_{_label(project["name"], 24)}_{project_id[:8]}'
                if not folder.resolve().is_relative_to(root):
                    raise ValueError('갤러리 보관 폴더 경로를 확인해 주세요.')
                for picture in pictures.values():
                    source = picture['source']
                    refs = picture['paths']
                    # Shared library previews belong to their own catalogs.
                    library_source = any((parse_daki_image_reference(path) or ('gallery',))[0]
                                         in ('shared', 'personal', 'test') for path in refs)
                    source_rel = source.resolve().relative_to(root).as_posix() if source.resolve().is_relative_to(root) else None
                    if action == 'archive':
                        destination_folder = root / '_R-18' / folder.relative_to(root) if source_rel and source_rel.startswith(('_R-18/', '_R-15/')) else folder
                        if not destination_folder.resolve().is_relative_to(root):
                            raise ValueError('갤러리 보관 폴더 경로를 확인해 주세요.')
                        destination = stack.enter_context(_archived_bundle(source, destination_folder, picture['name']))
                        dest_rel = destination.relative_to(root).as_posix()
                        changes.append((destination, source_rel, get_file_creation_time(str(source), source.stat().st_mtime)))
                        # Retained library originals retain their original URLs.
                        if not library_source:
                            aliases.extend((path, dest_rel) for path in refs)
                            for path in refs:
                                if path.startswith('__daki_exports__/'):
                                    aliases.append((str(Path(path).with_suffix('.png')).replace('\\', '/'), dest_rel))
                                    aliases.append((str(Path(path).with_suffix('.webp')).replace('\\', '/'), dest_rel))
                    if library_source:
                        protected += 1
                    elif not picture['staged']:
                        stack.enter_context(staged_image_removal(source))
                    if source_rel and not library_source:
                        removed_gallery.add(source_rel)
                        affected_folders.add(str(Path(source_rel).parent).replace('\\', '/'))
                # Commit aliases before staged originals are discarded. Failure
                # rolls back the project, draft folders, and copied image files.
                if aliases:
                    with db.conn:
                        record_archived_images(db.conn, aliases)

            warning = ''
            try:
                records = []
                for destination, previous, source_created in changes:
                    cached = db.conn.execute(
                        'SELECT model_family, width, height, gallery_tag, reason, ctime, mode, rating, brand, character_names, is_dakimakura FROM gallery_images WHERE rel_path = ?',
                        (previous,),
                    ).fetchone() if previous else None
                    overrides = dict(zip(('model_family', 'width', 'height', 'gallery_tag', 'reason', 'ctime', 'mode', 'rating', 'brand', 'character_names', 'is_dakimakura'), cached)) if cached else {}
                    if overrides.get('ctime') is None:
                        overrides['ctime'] = source_created
                    record = db.build_gallery_image_record_from_file(str(destination), classified_root=str(root), **overrides)
                    records.append(record)
                    affected_folders.add(record['folder_path'])
                if records:
                    db.upsert_gallery_image_records(records)
                for previous in removed_gallery:
                    if not db.remove_gallery_image_record(previous):
                        raise OSError('갤러리 목록 정리에 실패했습니다.')
                if affected_folders:
                    db.refresh_gallery_folder_summaries(affected_folders)
            except Exception:
                warning = '프로젝트 정리는 끝났지만 갤러리 목록을 갱신하지 못했습니다. 갤러리 목록 갱신을 실행해 주세요.'
            if protected:
                warning = (warning + ' 공유·개인 그림체 라이브러리 원본은 유지했습니다.').strip()
            return {'status': 'success', 'project_id': project_id, 'action': action,
                    'archived_count': len(changes), 'deleted_count': len(pictures) - protected if action == 'delete' else 0,
                    'gallery_folder': folder.relative_to(root).as_posix() if changes else '',
                    'gallery_changed': bool(changes or removed_gallery), 'warning': warning}
        finally:
            if db is not None:
                db.close()
