"""Bind verified WebP replacement to the gallery's existing reference writer."""
from pathlib import Path

from naim.images.webp_conversion import convert_image_to_webp
from naim.storage.history import HistoryDB
from naim.storage.webp_conversion import migrate_webp_references


def gallery_image_processor(resolver, gallery_root, tags_path):
    def process(reference, quality, cancel_event):
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
                return migrate_webp_references(db, root, old, new, tags_path())

            return convert_image_to_webp(source, lossless=False, quality=quality,
                                         before_delete=update_references if db is not None else None,
                                         cancel_event=cancel_event)
        finally:
            if db is not None:
                db.close()
    return process
