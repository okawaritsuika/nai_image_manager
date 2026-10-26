"""Keep image links readable after project pictures move into the gallery."""
from contextlib import closing
from pathlib import Path
import sqlite3

from naim.storage.webp_conversion import resolve_converted_gallery_path


def record_archived_images(connection, aliases):
    connection.execute('''CREATE TABLE IF NOT EXISTS gallery_project_archives (
        source_path TEXT PRIMARY KEY, gallery_path TEXT NOT NULL)''')
    for source, target in aliases:
        connection.execute('UPDATE gallery_project_archives SET gallery_path = ? WHERE gallery_path = ?', (target, source))
        connection.execute('INSERT OR REPLACE INTO gallery_project_archives VALUES (?, ?)', (source, target))


def resolve_archived_image(root, reference, db_path):
    """Read exact aliases only; neither create a DB nor accept outside paths."""
    try:
        with closing(sqlite3.connect(Path(db_path).absolute().as_uri() + '?mode=ro', uri=True)) as conn:
            row = conn.execute(
                'SELECT gallery_path FROM gallery_project_archives WHERE source_path = ?',
                (reference,),
            ).fetchone()
        if not row:
            return None
        relative = str(row[0]).replace('\\', '/')
        if (not relative.startswith(('No_Metadata/프로젝트 보관/', '_R-18/No_Metadata/프로젝트 보관/'))
                or '..' in relative.split('/')):
            return None
        base = Path(root).resolve()
        target = base / relative
        if not target.resolve().is_relative_to(base):
            return None
        if any(part.is_symlink() for part in [target, *target.parents] if part != base and part.is_relative_to(base)):
            return None
        if not target.is_file():
            converted = resolve_converted_gallery_path(base, relative, db_path)
            if not converted:
                return None
            target = Path(converted)
        return str(target), target.relative_to(base).as_posix()
    except (OSError, ValueError, sqlite3.Error):
        return None
