"""One deduplicated shared recipe catalog; source files remain untouched."""
from contextlib import closing
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sqlite3


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


class SharedLibraryStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self.connect()) as conn, conn:
            conn.executescript('''
                CREATE TABLE IF NOT EXISTS shared_recipes (
                    id TEXT PRIMARY KEY, dedup_key TEXT NOT NULL UNIQUE,
                    record_json TEXT NOT NULL, excluded INTEGER NOT NULL DEFAULT 0,
                    excluded_by_user INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS shared_sources (
                    origin TEXT NOT NULL, source_id TEXT NOT NULL,
                    recipe_id TEXT NOT NULL REFERENCES shared_recipes(id),
                    source_json TEXT NOT NULL, image_path TEXT NOT NULL,
                    thumbnail_path TEXT NOT NULL, raw_json TEXT NOT NULL,
                    PRIMARY KEY(origin,source_id));
                CREATE TABLE IF NOT EXISTS shared_aliases (
                    alias_id TEXT PRIMARY KEY, recipe_id TEXT NOT NULL REFERENCES shared_recipes(id));
                CREATE TABLE IF NOT EXISTS shared_library_metadata (
                    name TEXT PRIMARY KEY, value_json TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS shared_sources_recipe ON shared_sources(recipe_id);
            ''')
            columns = {row[1] for row in conn.execute('PRAGMA table_info(shared_recipes)')}
            if 'excluded_by_user' not in columns:
                conn.execute('ALTER TABLE shared_recipes ADD COLUMN excluded_by_user INTEGER NOT NULL DEFAULT 0')
                conn.execute('UPDATE shared_recipes SET excluded_by_user=excluded')

    def connect(self):
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys=ON')
        return conn

    def scan_state(self):
        with closing(self.connect()) as conn:
            row = conn.execute("SELECT value_json FROM shared_library_metadata WHERE name='source_scan'").fetchone()
        if row is None:
            return None
        try:
            state = json.loads(row[0])
        except (TypeError, ValueError):
            return None
        if (not isinstance(state, dict) or not isinstance(state.get('signature'), str)
                or not isinstance(state.get('warnings'), list)
                or any(not isinstance(item, str) for item in state['warnings'])):
            return None
        return state

    def save_scan_state(self, signature, warnings):
        with closing(self.connect()) as conn, conn:
            conn.execute("""INSERT INTO shared_library_metadata(name,value_json) VALUES('source_scan',?)
                ON CONFLICT(name) DO UPDATE SET value_json=excluded.value_json""",
                         (_json({'signature': signature, 'warnings': list(warnings)}),))

    def ingest(self, entries):
        """Publish one verified batch atomically, retaining the first recipe snapshot."""
        added = 0
        exclusions = {}
        for entry in entries:
            key = _json(entry['key'])
            exclusions[key] = exclusions.get(key, True) and bool(entry.get('excluded'))
        with closing(self.connect()) as conn, conn:
            for entry in entries:
                key = _json(entry['key'])
                sid = 'common-' + hashlib.sha256(key.encode()).hexdigest()[:24]
                record = deepcopy(entry['record'])
                record['id'] = sid
                cursor = conn.execute('INSERT OR IGNORE INTO shared_recipes(id,dedup_key,record_json,excluded) VALUES(?,?,?,?)',
                                      (sid, key, _json(record), int(exclusions[key])))
                added += cursor.rowcount
                # Legacy duplicate exclusions cannot override a visible source;
                # explicit exclusions made in the common library always persist.
                conn.execute('UPDATE shared_recipes SET excluded=? WHERE id=? AND excluded_by_user=0',
                             (int(exclusions[key]), sid))
                previous = conn.execute('SELECT * FROM shared_sources WHERE origin=? AND source_id=?',
                                        (entry['origin'], str(entry['source_id']))).fetchone()
                if previous and previous['recipe_id'] != sid:
                    # Retain the earlier source snapshot for already saved common IDs.
                    historical_id = str(entry['source_id']) + '@' + previous['recipe_id']
                    historical_source = json.loads(previous['source_json'])
                    historical_source['_historical'] = True
                    conn.execute('INSERT OR IGNORE INTO shared_sources VALUES(?,?,?,?,?,?,?)',
                                 (previous['origin'], historical_id, previous['recipe_id'], _json(historical_source),
                                  previous['image_path'], previous['thumbnail_path'], previous['raw_json']))
                conn.execute('''INSERT INTO shared_sources VALUES(?,?,?,?,?,?,?)
                    ON CONFLICT(origin,source_id) DO UPDATE SET
                    recipe_id=excluded.recipe_id,source_json=excluded.source_json,
                    image_path=excluded.image_path,thumbnail_path=excluded.thumbnail_path,raw_json=excluded.raw_json''',
                    (entry['origin'], str(entry['source_id']), sid, _json(entry.get('source', {})),
                     str(entry.get('image_path') or ''), str(entry.get('thumbnail_path') or ''),
                     _json(entry.get('raw_metadata') or {})))
                for alias in entry.get('aliases', []):
                    # Legacy identities are immutable; their saved snapshots remain readable.
                    conn.execute('INSERT OR IGNORE INTO shared_aliases VALUES(?,?)', (alias, sid))
        return added

    @staticmethod
    def resolve(conn, sid):
        row = conn.execute('SELECT id FROM shared_recipes WHERE id=?', (sid,)).fetchone()
        if row:
            return row['id']
        row = conn.execute('SELECT recipe_id FROM shared_aliases WHERE alias_id=?', (sid,)).fetchone()
        if row:
            return row['recipe_id']
        raise KeyError(sid)

    def list_records(self, include_excluded=False):
        with closing(self.connect()) as conn:
            query = 'SELECT record_json FROM shared_recipes'
            if not include_excluded:
                query += ''' WHERE excluded=0 AND EXISTS (
                    SELECT 1 FROM shared_sources WHERE recipe_id=shared_recipes.id
                    AND COALESCE(json_extract(source_json,'$._historical'),0)=0)'''
            query += ' ORDER BY rowid'
            return [json.loads(row[0]) for row in conn.execute(query)]

    def get_record(self, sid):
        with closing(self.connect()) as conn:
            canonical = self.resolve(conn, sid)
            if sid != canonical:
                originals = conn.execute("SELECT source_json FROM shared_sources WHERE origin='naim' AND recipe_id=?", (canonical,)).fetchall()
                for original in originals:
                    saved = json.loads(original[0]).get('_legacy_record')
                    if isinstance(saved, dict) and saved.get('id') == sid:
                        return saved
            record = json.loads(conn.execute('SELECT record_json FROM shared_recipes WHERE id=?', (canonical,)).fetchone()[0])
            record['id'] = sid
            return record

    def sources(self, sid):
        with closing(self.connect()) as conn:
            canonical = self.resolve(conn, sid)
            return [dict(row) for row in conn.execute(
                'SELECT * FROM shared_sources WHERE recipe_id=? ORDER BY CASE origin WHEN \'naim\' THEN 0 ELSE 1 END,rowid', (canonical,))]

    def all_sources(self):
        with closing(self.connect()) as conn:
            grouped = {}
            for row in conn.execute("SELECT * FROM shared_sources ORDER BY CASE origin WHEN 'naim' THEN 0 ELSE 1 END,rowid"):
                grouped.setdefault(row['recipe_id'], []).append(dict(row))
            return grouped

    def exclude(self, ids):
        if not isinstance(ids, list) or not 1 <= len(ids) <= 10000 or any(not isinstance(sid, str) or not sid or len(sid) > 128 for sid in ids):
            raise ValueError('제외할 그림체를 1~10000개 선택해 주세요.')
        with closing(self.connect()) as conn, conn:
            canonical = {self.resolve(conn, sid) for sid in ids}
            changed = 0
            for sid in canonical:
                changed += conn.execute('UPDATE shared_recipes SET excluded=1,excluded_by_user=1 WHERE id=? AND excluded=0', (sid,)).rowcount
                conn.execute('UPDATE shared_recipes SET excluded_by_user=1 WHERE id=?', (sid,))
            return changed
