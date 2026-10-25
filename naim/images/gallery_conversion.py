"""Bind verified WebP replacement to the gallery's existing reference writer."""
from pathlib import Path

from naim.images.webp_conversion import convert_image_to_webp
from naim.images.project_results import process_project_webp_conversion, validate_project_image_context
from naim.storage.history import HistoryDB
from naim.storage.webp_conversion import add_webp_gallery_image, migrate_webp_references


def gallery_image_processor(resolver, gallery_root, tags_path, *, project_store=None, project_export_root=None):
    def process(reference, quality, cancel_event, *, keep_original=False, project_context=None):
        if project_context is not None:
            if project_store is None:
                raise ValueError('프로젝트 WebP 변환을 사용할 수 없습니다.')
            validate_project_image_context(project_store, project_context, reference)
            if keep_original:
                export_root = project_export_root() if callable(project_export_root) else project_export_root
                return process_project_webp_conversion(
                    project_store, export_root, project_context, reference, quality, cancel_event)
        source, _ = resolver(reference)
        source = Path(source)
        root = Path(gallery_root()).resolve()
        db = None
        try:
            # Daki virtual IDs stay stable; only ordinary gallery files require
            # index/tag migration. Its aliases also preserve saved canvas URLs.
            if source.resolve().is_relative_to(root) and source.suffix.lower() != '.webp':
                db = HistoryDB(root / 'naia_history.db')

            def update_references(old, new):
                if project_context is not None:
                    validate_project_image_context(project_store, project_context, reference)
                if db is None:
                    return None
                if keep_original:
                    return add_webp_gallery_image(db, root, old, new)
                return migrate_webp_references(db, root, old, new, tags_path())

            return convert_image_to_webp(source, lossless=False, quality=quality,
                                         before_delete=update_references if db is not None or project_context is not None else None,
                                         cancel_event=cancel_event, keep_original=keep_original)
        finally:
            if db is not None:
                db.close()
    return process
