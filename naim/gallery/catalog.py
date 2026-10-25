"""Read-only gallery catalog and bounded image pages over the existing index."""

COLUMNS = 'rel_path, folder_path, file_name, width, height, mtime, reason, gallery_tag, model_family, ctime'


def gallery_where(mode, model_family='all'):
    # Preserve the legacy view predicates, including mode/path compatibility.
    clauses = {
        'general': "rel_path NOT LIKE '_R-18/%' AND rel_path NOT LIKE '_R-15/%' AND rel_path NOT LIKE '_TRASH/%'",
        'r18': "(rel_path LIKE '_R-18/%' OR rel_path LIKE '_R-15/%' OR (mode = 'r18' AND rel_path NOT LIKE '_TRASH/%'))",
        'trash': "(rel_path LIKE '_TRASH/%' OR mode = 'trash')",
    }
    clause = clauses.get(mode, "rel_path NOT LIKE '_TRASH/%' AND (mode IN ('general', 'r18') OR rel_path LIKE '_R-18/%' OR rel_path LIKE '_R-15/%')")
    params = []
    if model_family != 'all':
        clause += " AND COALESCE(model_family, 'other') = ?"
        params.append(model_family)
    return clause, params


def gallery_rows(connection, mode, model_family='all', summary=False):
    where, params = gallery_where(mode, model_family)
    if not summary:
        return connection.execute(f'SELECT {COLUMNS} FROM gallery_images WHERE {where}', params)
    # Group once, then use the existing folder index for small representative
    # lookups. Avoid sorting the entire library through several window functions.
    selected_columns = ', '.join('g.' + column.strip() for column in COLUMNS.split(','))
    return connection.execute(f'''
        WITH counts AS (
            SELECT folder_path, COUNT(*) AS image_count, MIN(rowid) AS first_row
            FROM gallery_images WHERE {where} GROUP BY folder_path
        ) SELECT {selected_columns}, c.image_count,
            (SELECT rel_path FROM gallery_images WHERE folder_path = c.folder_path AND ({where})
             ORDER BY (substr(file_name, 1, 9) = '000_MAIN_') DESC, file_name, rel_path LIMIT 1)
          FROM counts c JOIN gallery_images g ON g.rel_path = (
            SELECT rel_path FROM gallery_images WHERE folder_path = c.folder_path AND ({where})
            ORDER BY (substr(file_name, 1, 9) = '000_MAIN_') DESC,
                     COALESCE(mtime, 0) DESC, file_name, rel_path LIMIT 1
          ) ORDER BY c.first_row
    ''', params * 3)


def gallery_image_page(connection, mode, model_family, folders, after='', limit=512, paths=None):
    if paths is not None:
        if not isinstance(paths, list) or not 1 <= len(paths) <= 512 or any(not isinstance(p, str) for p in paths):
            raise ValueError('paths must contain 1–512 image paths')
    elif not isinstance(folders, list) or not 1 <= len(folders) <= 128 or any(not isinstance(p, str) for p in folders):
        raise ValueError('folders must contain 1–128 folder paths')
    if not isinstance(after, str):
        raise ValueError('invalid cursor')
    limit = max(1, min(512, int(limit)))
    where, params = gallery_where(mode, model_family)
    values = paths if paths is not None else folders
    column = 'rel_path' if paths is not None else 'folder_path'
    marks = ','.join('?' for _ in values)
    rows = connection.execute(
        f'SELECT {COLUMNS} FROM gallery_images WHERE ({where}) '
        f'AND {column} IN ({marks}) AND rel_path > ? ORDER BY rel_path LIMIT ?',
        [*params, *values, after, limit + 1],
    ).fetchall()
    return rows[:limit], rows[limit - 1][0] if len(rows) > limit else None
