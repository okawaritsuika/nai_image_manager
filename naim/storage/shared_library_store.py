"""One deduplicated shared recipe catalog; source files remain untouched."""
from contextlib import closing
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def _timestamp(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 100:
        return None
    text = value.strip()
    if text.endswith(('Z', 'z')):
        text = text[:-1] + '+00:00'
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.astimezone()
    return parsed.astimezone(timezone.utc)


def _recommendation(entry):
    record = entry.get('record') or {}
    count = record.get('recommendation_count')
    if type(count) is not int or count < 0:
        return None
    collected_at = record.get('recommendation_collected_at')
    return count, collected_at if _timestamp(collected_at) is not None else None


def _newest_recommendation(candidates):
    selected = None
    selected_at = None
    for candidate in candidates:
        if candidate is None:
            continue
        count, collected_at = candidate
        parsed = _timestamp(collected_at)
        if selected is None or (parsed is not None and (selected_at is None or parsed > selected_at)):
            selected = candidate
            selected_at = parsed
    return selected


def _should_update_recommendation(record, candidate):
    if candidate is None:
        return False
    count = record.get('recommendation_count')
    if type(count) is not int or count < 0:
        return True
    current_at = _timestamp(record.get('recommendation_collected_at'))
    incoming_at = _timestamp(candidate[1])
    if current_at is None and incoming_at is None:
        return True
    if incoming_at is None:
        return False
    return current_at is None or incoming_at > current_at


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
        """Publish one verified batch atomically, retaining recipes and current recommendations."""
        added = 0
        exclusions = {}
        recommendations = {}
        for entry in entries:
            key = _json(entry['key'])
            exclusions[key] = exclusions.get(key, True) and bool(entry.get('excluded'))
            recommendations.setdefault(key, []).append(_recommendation(entry))
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
                    previous_record = conn.execute('SELECT record_json FROM shared_recipes WHERE id=?',
                                                   (previous['recipe_id'],)).fetchone()
                    if previous_record:
                        previous_recommendation = _recommendation({'record': json.loads(previous_record['record_json'])})
                        if previous_recommendation is not None:
                            recommendations[key].insert(0, previous_recommendation)
                    previous_recipe = conn.execute('SELECT excluded_by_user FROM shared_recipes WHERE id=?',
                                                    (previous['recipe_id'],)).fetchone()
                    if previous_recipe and previous_recipe['excluded_by_user']:
                        # Preserve an explicit user exclusion when a source gets a new recipe key.
                        conn.execute('UPDATE shared_recipes SET excluded=1,excluded_by_user=1 WHERE id=?', (sid,))
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
            for key, candidates in recommendations.items():
                candidate = _newest_recommendation(candidates)
                if candidate is None:
                    continue
                sid = 'common-' + hashlib.sha256(key.encode()).hexdigest()[:24]
                row = conn.execute('SELECT record_json FROM shared_recipes WHERE id=?', (sid,)).fetchone()
                if row is None:
                    continue
                record = json.loads(row['record_json'])
                if _should_update_recommendation(record, candidate):
                    record['recommendation_count'], record['recommendation_collected_at'] = candidate
                    conn.execute('UPDATE shared_recipes SET record_json=? WHERE id=?', (_json(record), sid))
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
            record = json.loads(conn.execute('SELECT record_json FROM shared_recipes WHERE id=?', (canonical,)).fetchone()[0])
            self._overlay_active_recommendations(conn, canonical, record)
            if sid != canonical:
                originals = conn.execute("SELECT source_json FROM shared_sources WHERE origin='naim' AND recipe_id=?", (canonical,)).fetchall()
                for original in originals:
                    saved = json.loads(original[0]).get('_legacy_record')
                    if isinstance(saved, dict) and saved.get('id') == sid:
                        saved = deepcopy(saved)
                        saved['recommendation_count'] = record.get('recommendation_count')
                        saved['recommendation_collected_at'] = record.get('recommendation_collected_at')
                        return saved
            record['id'] = sid
            return record

    @staticmethod
    def _overlay_active_recommendations(conn, recipe_id, record):
        historical = conn.execute('''SELECT origin,source_id FROM shared_sources WHERE recipe_id=?
            AND COALESCE(json_extract(source_json,'$._historical'),0)=1''', (recipe_id,)).fetchall()
        for source in historical:
            suffix = '@' + recipe_id
            if not source['source_id'].endswith(suffix):
                continue
            original_source_id = source['source_id'][:-len(suffix)]
            active = conn.execute('''SELECT recipe_id FROM shared_sources WHERE origin=? AND source_id=?
                AND COALESCE(json_extract(source_json,'$._historical'),0)=0''',
                               (source['origin'], original_source_id)).fetchone()
            if active is None or active['recipe_id'] == recipe_id:
                continue
            row = conn.execute('SELECT record_json FROM shared_recipes WHERE id=?', (active['recipe_id'],)).fetchone()
            if row is None:
                continue
            current = json.loads(row['record_json'])
            candidate = _recommendation({'record': current})
            if _should_update_recommendation(record, candidate):
                record['recommendation_count'], record['recommendation_collected_at'] = candidate

    def update_recommendations(self, source_url, count, collected_at):
        """Update matching recipes only when the collected recommendation data is newer."""
        if not isinstance(source_url, str) or not source_url.strip() or len(source_url) > 2048:
            raise ValueError('원본 주소를 확인해 주세요.')
        if type(count) is not int or count < 0:
            raise ValueError('추천수는 0 이상의 정수여야 합니다.')
        incoming_at = _timestamp(collected_at)
        if incoming_at is None:
            raise ValueError('추천수 수집 시각을 확인해 주세요.')
        return self.update_recommendations_many([{
            'source_url': source_url.strip(), 'recommendation_count': count,
            'recommendation_collected_at': collected_at.strip()}])

    def update_recommendations_many(self, updates):
        """Apply source vote changes with one catalog read, without re-ingesting images."""
        by_url = {}
        for update in updates:
            url = update.get('source_url')
            candidate = _recommendation({'record': update})
            if not isinstance(url, str) or not url.strip() or candidate is None:
                continue
            url = url.strip()
            by_url[url] = _newest_recommendation([by_url.get(url), candidate])
        if not by_url:
            return 0
        changed = 0
        with closing(self.connect()) as conn, conn:
            candidates = {}
            for row in conn.execute('''SELECT recipe_id,json_extract(source_json,'$.source_url') AS url
                FROM shared_sources WHERE COALESCE(json_extract(source_json,'$._historical'),0)=0'''):
                if row['url'] in by_url:
                    sid = row['recipe_id']
                    candidates[sid] = _newest_recommendation([candidates.get(sid), by_url[row['url']]])
            for row in conn.execute('SELECT id,record_json FROM shared_recipes').fetchall():
                record = json.loads(row['record_json'])
                candidate = _newest_recommendation([candidates.get(row['id']), by_url.get(record.get('source_url'))])
                if _should_update_recommendation(record, candidate):
                    record['recommendation_count'], record['recommendation_collected_at'] = candidate
                    changed += conn.execute('UPDATE shared_recipes SET record_json=? WHERE id=?',
                                            (_json(record), row['id'])).rowcount
        return changed

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

    def public_sources(self, recipe_ids):
        """Load public source metadata and at most one raw snapshot per recipe."""
        ids = list(dict.fromkeys(recipe_ids))
        grouped = {}
        for offset in range(0, len(ids), 400):
            chunk = ids[offset:offset + 400]
            placeholders = ','.join('?' for _ in chunk)
            # Keep large raw snapshots out of the window-ranking intermediates.
            query = f'''WITH source_rows AS (
                    SELECT rowid AS source_rowid,origin,source_id,recipe_id,source_json,
                        image_path,thumbnail_path,raw_json<>'{{}}' AS has_raw,
                        COALESCE(json_extract(source_json,'$._historical'),0) AS historical
                    FROM shared_sources WHERE recipe_id IN ({placeholders})
                ), active_flags AS (
                    SELECT *,MAX(CASE WHEN historical=0 THEN 1 ELSE 0 END)
                        OVER (PARTITION BY recipe_id) AS has_active
                    FROM source_rows
                ), selected_sources AS (
                    SELECT * FROM active_flags WHERE has_active=0 OR historical=0
                ), ranked_sources AS (
                    SELECT *,ROW_NUMBER() OVER (PARTITION BY recipe_id ORDER BY
                        CASE WHEN has_raw THEN 0 ELSE 1 END,
                        CASE origin WHEN 'naim' THEN 0 ELSE 1 END,source_rowid) AS raw_rank
                    FROM selected_sources
                )
                SELECT origin,source_id,recipe_id,source_json,image_path,thumbnail_path,
                    CASE WHEN has_raw AND raw_rank=1 THEN
                        (SELECT raw_json FROM shared_sources raw WHERE raw.rowid=ranked_sources.source_rowid)
                        ELSE '{{}}' END AS raw_json
                FROM ranked_sources
                ORDER BY CASE origin WHEN 'naim' THEN 0 ELSE 1 END,source_rowid'''
            with closing(self.connect()) as conn:
                for row in conn.execute(query, chunk):
                    grouped.setdefault(row['recipe_id'], []).append(dict(row))
        return grouped

    def selection_origins(self):
        """Return one source origin per recipe without loading source snapshots."""
        with closing(self.connect()) as conn:
            rows = conn.execute('''SELECT recipe_id,origin FROM shared_sources
                ORDER BY COALESCE(json_extract(source_json,'$._historical'),0),
                    CASE origin WHEN 'naim' THEN 0 ELSE 1 END,rowid''')
            origins = {}
            for row in rows:
                origins.setdefault(row['recipe_id'], row['origin'])
            return origins

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
