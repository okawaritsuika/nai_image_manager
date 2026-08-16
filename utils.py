# -*- coding: utf-8 -*-
import os
import json
import re
import sqlite3
import hashlib
import socket
import time
import uuid

CONFIG_FILE = "gallery_config.json"


def get_app_dir():
    import sys

    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def clean_tag(raw_tag):
    """프롬프트의 텍스트를 Danbooru DB 표준 포맷으로 완벽 정제합니다."""
    if not raw_tag: return ""
    clean = raw_tag.strip()

    # 1. 가중치 완벽 제거
    clean = re.sub(r'^[-0-9.]+:+\s*', '', clean)
    clean = re.sub(r'\s*:+$', '', clean)
    clean = re.sub(r':[0-9.]+$', '', clean).strip()

    # 2. 강조용 겉 괄호만 벗기기
    while clean.startswith('(') and clean.endswith(')'):
        clean = clean[1:-1].strip()
    while clean.startswith('[') and clean.endswith(']'):
        clean = clean[1:-1].strip()
    while clean.startswith('{') and clean.endswith('}'):
        clean = clean[1:-1].strip()

    # 3. 특수 공백 및 띄어쓰기 언더바 변환
    clean = re.sub(r'\s+', '_', clean).lower().strip()
    return clean


def normalize_gallery_prompt_search_text(value):
    """Normalize prompt text without changing the stored index schema.

    Prompt queries and indexed prompt text use the same representation so
    underscores remain equivalent to spaces and old index rows stay usable.
    Commas/newlines are separators in the query grammar, but are normalized
    to spaces when they occur inside a ``%...%`` partial term.
    """
    text = str(value or "").lower().replace("_", " ")
    text = re.sub(r"[\r\n,]+", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _normalize_gallery_prompt_search_term(value, partial=None):
    """Return one normalized search term, or ``None`` when it is empty."""
    if isinstance(value, dict):
        if partial is None:
            partial = bool(value.get("partial"))
        value = value.get("text", value.get("term", value.get("value", "")))

    raw = str(value or "").strip()
    if partial is None:
        partial = len(raw) >= 2 and raw.startswith("%") and raw.endswith("%")
    if partial and len(raw) >= 2 and raw.startswith("%") and raw.endswith("%"):
        raw = raw[1:-1]

    text = normalize_gallery_prompt_search_text(raw)
    if not text:
        return None
    return {"text": text, "partial": bool(partial)}


def parse_gallery_prompt_search_query(query):
    """Parse the gallery prompt grammar into OR-of-AND term groups.

    The return value is a list of groups; each group is a list of
    ``{"text": ..., "partial": bool}`` dictionaries.  Separators are
    commas, whitespace, and ``||`` outside ``%...%``.  This shape is kept
    deliberately simple so DB-backed and filesystem fallback searches can
    share the exact same matcher.
    """
    raw_query = str(query or "")
    groups = []
    current_group = []
    token = []
    in_partial = False
    index = 0

    def flush_token():
        if not token:
            return
        raw_term = "".join(token).strip()
        token.clear()
        term = _normalize_gallery_prompt_search_term(raw_term)
        if term is not None:
            current_group.append(term)

    def flush_group():
        flush_token()
        if current_group:
            groups.append(list(current_group))
            current_group.clear()

    while index < len(raw_query):
        char = raw_query[index]
        if char == "%":
            in_partial = not in_partial
            token.append(char)
            index += 1
            continue

        if not in_partial and raw_query[index:index + 2] == "||":
            flush_group()
            index += 2
            continue

        if not in_partial and (char == "," or char.isspace()):
            flush_token()
            index += 1
            continue

        token.append(char)
        index += 1

    flush_group()
    return groups


def _coerce_gallery_prompt_search_groups(query_or_terms):
    """Accept parser output and the historic flat term-list contract."""
    if isinstance(query_or_terms, str) or query_or_terms is None:
        return parse_gallery_prompt_search_query(query_or_terms)

    if isinstance(query_or_terms, dict):
        raw_groups = query_or_terms.get("groups")
        if raw_groups is not None:
            query_or_terms = raw_groups
        else:
            query_or_terms = [query_or_terms]

    if not isinstance(query_or_terms, (list, tuple, set)):
        return parse_gallery_prompt_search_query(query_or_terms)

    values = list(query_or_terms)
    if not values:
        return []

    # Parsed output is nested.  A flat list remains a historic AND term list.
    nested = any(isinstance(value, (list, tuple, set)) for value in values)
    raw_groups = values if nested else [values]
    groups = []
    for raw_group in raw_groups:
        if isinstance(raw_group, dict):
            raw_group = [raw_group]
        if not isinstance(raw_group, (list, tuple, set)):
            raw_group = [raw_group]
        group = []
        for raw_term in raw_group:
            term = _normalize_gallery_prompt_search_term(raw_term)
            if term is not None:
                group.append(term)
        if group:
            groups.append(group)
    return groups


def gallery_prompt_search_matches(prompt_text, query_or_terms, normalized_text=None):
    """Return whether a prompt satisfies an OR-of-AND gallery query."""
    groups = _coerce_gallery_prompt_search_groups(query_or_terms)
    if not groups:
        return False

    source_text = normalized_text if normalized_text not in (None, "") else prompt_text
    normalized_prompt = normalize_gallery_prompt_search_text(source_text)
    if not normalized_prompt:
        return False

    for group in groups:
        if all(
            term["text"] in normalized_prompt
            if term["partial"]
            else re.search(
                r"(?<![A-Za-z0-9\uac00-\ud7a3])"
                + re.escape(term["text"])
                + r"(?![A-Za-z0-9\uac00-\ud7a3])",
                normalized_prompt,
            ) is not None
            for term in group
        ):
            return True
    return False


def _gallery_prompt_search_candidate_where(groups, column, fallback_column=None):
    """Build broad SQL candidates; final matching stays in Python.

    ``prompt_text`` is included as a fallback for rows created before the
    normalized index was populated.  For multi-word terms, token candidates
    avoid false negatives caused by raw commas/underscores; the shared matcher
    still enforces the phrase boundary or substring rule afterwards.
    """
    clauses = []
    params = []
    for group in groups:
        group_clauses = []
        for term in group:
            token_clauses = []
            for token in term["text"].split():
                token_clauses.append(f"{column} LIKE ?")
                params.append(f"%{token}%")
                if fallback_column:
                    token_clauses.append(f"{fallback_column} LIKE ?")
                    params.append(f"%{token}%")
            if token_clauses:
                group_clauses.append("(" + " OR ".join(token_clauses) + ")")
        if group_clauses:
            clauses.append("(" + " AND ".join(group_clauses) + ")")
    if not clauses:
        return "", []
    return "(" + " OR ".join(clauses) + ")", params


def load_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except:
            return {}
    return {}


def save_config(config_data):
    try:
        merged_config = load_config()
        if not isinstance(merged_config, dict):
            merged_config = {}
        if isinstance(config_data, dict):
            merged_config.update(config_data)
        with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(merged_config, f, indent=4, ensure_ascii=False)
    except Exception as e:
        print(f"설정 저장 실패: {e}")


def is_subpath(target_path, base_path):
    try:
        common_path = os.path.commonpath([os.path.abspath(target_path), os.path.abspath(base_path)])
        return common_path == os.path.abspath(base_path)
    except ValueError:
        return False


def resolve_safe_path(base_path, rel_path, strip_prefix=None):
    normalized_rel_path = str(rel_path or "").replace('\\', '/')
    if strip_prefix:
        normalized_rel_path = normalized_rel_path.replace(strip_prefix, "", 1)
    normalized_rel_path = normalized_rel_path.lstrip('/')
    resolved_path = os.path.normpath(os.path.join(base_path, normalized_rel_path))
    if not is_subpath(resolved_path, base_path):
        raise ValueError("허용되지 않은 경로입니다.")
    return resolved_path


def is_port_active(port, host='127.0.0.1'):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        return sock.connect_ex((host, port)) == 0


class HistoryDB:
    def __init__(self, _unused_path=None):
        base_dir = get_app_dir()
        db_folder = os.path.join(base_dir, "TOTAL_CLASSIFIED")
        # Keep the historic no-argument location, while allowing isolated DBs
        # for tests and callers that explicitly provide a database path.
        if _unused_path:
            requested_path = os.fspath(_unused_path)
            if requested_path == ":memory:":
                self.db_path = requested_path
            else:
                requested_path = os.path.abspath(requested_path)
                if os.path.isdir(requested_path):
                    requested_path = os.path.join(requested_path, "naia_history.db")
                self.db_path = requested_path
                os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        else:
            os.makedirs(db_folder, exist_ok=True)
            self.db_path = os.path.join(db_folder, "naia_history.db")
        self.danbooru_db_path = os.path.join(base_dir, "danbooru_tags.db")

        self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self.conn.execute("PRAGMA journal_mode=WAL;")
        self.conn.execute("PRAGMA synchronous=NORMAL;")

        self.danbooru_conn = None
        if os.path.exists(self.danbooru_db_path):
            self.danbooru_conn = sqlite3.connect(self.danbooru_db_path, check_same_thread=False)
            self.danbooru_conn.execute("PRAGMA journal_mode=WAL;")

        self.create_table()

    # utils.py 내의 create_table 함수 수정
    def create_table(self):
        with self.conn:
            self.conn.execute('''
                CREATE TABLE IF NOT EXISTS processed_files (
                    file_hash TEXT PRIMARY KEY,
                    file_name TEXT,
                    characters TEXT,
                    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            ''')

            # 🌟 [수정] brand_kr (한국어 명칭) 컬럼 추가
            self.conn.execute('''
                CREATE TABLE IF NOT EXISTS known_characters (
                    tag TEXT PRIMARY KEY,
                    clean_name TEXT,
                    brand TEXT,
                    brand_kr TEXT
                )
            ''')

            # 🌟 기존 사용자를 위한 안전한 컬럼 업데이트 시도
            # 🌟 [추가] 필터 표시 여부 스위치 컬럼 (기본값 1 = 표시)
            try:
                self.conn.execute("ALTER TABLE known_characters ADD COLUMN is_visible INTEGER DEFAULT 1")
            except sqlite3.OperationalError:
                pass
            try:
                self.conn.execute("ALTER TABLE known_characters ADD COLUMN brand_kr TEXT")
            except sqlite3.OperationalError:
                pass

            self.conn.execute('''
                CREATE TABLE IF NOT EXISTS trash_map (
                    trash_path TEXT PRIMARY KEY,
                    original_path TEXT
                )
            ''')
            self.conn.execute('''
                CREATE TABLE IF NOT EXISTS file_metadata (
                    path TEXT PRIMARY KEY,
                    width INTEGER,
                    height INTEGER,
                    mtime REAL
                )
            ''')
            # 🌟 [추가] 그림체(아티스트 조합) 관리용 테이블
            self.conn.execute('''
                CREATE TABLE IF NOT EXISTS art_styles (
                    artist_name TEXT PRIMARY KEY,
                    name_kr TEXT
                )
            ''')
            self.conn.execute('''
                CREATE TABLE IF NOT EXISTS image_artists (
                    path TEXT,
                    artist_name TEXT,
                    PRIMARY KEY (path, artist_name)
                )
            ''')
            self.conn.execute('''
                CREATE TABLE IF NOT EXISTS artist_scanned_files (
                    path TEXT PRIMARY KEY
                )
            ''')
            # 🌟 [추가] 그림체(아티스트) 관리용 테이블
            self.conn.execute('''
                CREATE TABLE IF NOT EXISTS art_styles (
                    artist_name TEXT PRIMARY KEY,
                    name_kr TEXT
                )
            ''')
            self.conn.execute('''
                CREATE TABLE IF NOT EXISTS image_artists (
                    path TEXT,
                    artist_name TEXT,
                    PRIMARY KEY (path, artist_name)
                )
            ''')
            # 🌟 [추가] 그림체(아티스트) 관리용 테이블
            self.conn.execute('''
                CREATE TABLE IF NOT EXISTS art_styles (
                    artist_name TEXT PRIMARY KEY,
                    name_kr TEXT
                )
            ''')
            self.conn.execute('''
                CREATE TABLE IF NOT EXISTS image_artists (
                    path TEXT,
                    artist_name TEXT,
                    PRIMARY KEY (path, artist_name)
                )
            ''')
            self.conn.execute('''
                CREATE TABLE IF NOT EXISTS gallery_images (
                    rel_path TEXT PRIMARY KEY,
                    folder_path TEXT,
                    file_name TEXT,
                    mode TEXT,
                    rating TEXT,
                    brand TEXT,
                    character_names TEXT,
                    is_dakimakura INTEGER DEFAULT 0,
                    width INTEGER,
                    height INTEGER,
                    mtime REAL,
                    reason TEXT,
                    gallery_tag TEXT,
                    updated_at REAL
                )
            ''')
            self.conn.execute('''
                CREATE TABLE IF NOT EXISTS gallery_folders (
                    folder_path TEXT PRIMARY KEY,
                    parent_path TEXT,
                    folder_name TEXT,
                    mode TEXT,
                    total_images INTEGER DEFAULT 0,
                    direct_images INTEGER DEFAULT 0,
                    thumb_path TEXT,
                    updated_at REAL
                )
            ''')
            self.conn.execute('''
                CREATE TABLE IF NOT EXISTS gallery_index_state (
                    key TEXT PRIMARY KEY,
                    value TEXT,
                    updated_at REAL
                )
            ''')
            self.conn.execute('''
                CREATE TABLE IF NOT EXISTS gallery_prompt_index (
                    rel_path TEXT PRIMARY KEY,
                    folder_path TEXT,
                    file_name TEXT,
                    mode TEXT,
                    mtime REAL,
                    prompt_text TEXT,
                    normalized_text TEXT,
                    text_bytes INTEGER DEFAULT 0,
                    indexed_at REAL
                )
            ''')
            self.conn.execute('''
                CREATE TABLE IF NOT EXISTS gallery_prompt_index_profiles (
                    id TEXT PRIMARY KEY,
                    name TEXT,
                    mode TEXT,
                    scope_paths_json TEXT,
                    image_count INTEGER DEFAULT 0,
                    text_bytes INTEGER DEFAULT 0,
                    created_at REAL,
                    updated_at REAL,
                    built_at REAL
                )
            ''')
            self.conn.execute('''
                CREATE TABLE IF NOT EXISTS gallery_prompt_index_profile_items (
                    profile_id TEXT,
                    rel_path TEXT,
                    PRIMARY KEY (profile_id, rel_path)
                )
            ''')
            self.conn.execute('''
                CREATE TABLE IF NOT EXISTS gallery_virtual_folders (
                    id TEXT PRIMARY KEY,
                    parent_id TEXT,
                    name TEXT NOT NULL,
                    query TEXT NOT NULL DEFAULT '',
                    scope_paths_json TEXT NOT NULL DEFAULT '[]',
                    mode TEXT NOT NULL DEFAULT 'all',
                    order_index INTEGER NOT NULL DEFAULT 0,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                )
            ''')
            # Dynamic virtual-folder result cache.  These tables are additive
            # and deliberately do not use a foreign key so old databases can
            # open without a migration or schema rewrite.
            self.conn.execute('''
                CREATE TABLE IF NOT EXISTS gallery_virtual_folder_cache_meta (
                    folder_id TEXT PRIMARY KEY,
                    folder_updated_at REAL NOT NULL,
                    prompt_index_revision TEXT NOT NULL,
                    query_signature TEXT NOT NULL,
                    match_count INTEGER NOT NULL DEFAULT 0,
                    thumb_path TEXT,
                    indexed INTEGER NOT NULL DEFAULT 1,
                    built_at REAL NOT NULL
                )
            ''')
            self.conn.execute('''
                CREATE TABLE IF NOT EXISTS gallery_virtual_folder_cache_items (
                    folder_id TEXT NOT NULL,
                    rel_path TEXT NOT NULL,
                    PRIMARY KEY (folder_id, rel_path)
                )
            ''')
            self.conn.execute("CREATE INDEX IF NOT EXISTS idx_gallery_images_folder_path ON gallery_images(folder_path)")
            self.conn.execute("CREATE INDEX IF NOT EXISTS idx_gallery_images_mode ON gallery_images(mode)")
            self.conn.execute("CREATE INDEX IF NOT EXISTS idx_gallery_folders_parent_path ON gallery_folders(parent_path)")
            self.conn.execute("CREATE INDEX IF NOT EXISTS idx_gallery_folders_mode ON gallery_folders(mode)")
            self.conn.execute("CREATE INDEX IF NOT EXISTS idx_gallery_prompt_folder_path ON gallery_prompt_index(folder_path)")
            self.conn.execute("CREATE INDEX IF NOT EXISTS idx_gallery_prompt_mode ON gallery_prompt_index(mode)")
            self.conn.execute("CREATE INDEX IF NOT EXISTS idx_gallery_prompt_mtime ON gallery_prompt_index(mtime)")
            self.conn.execute("CREATE INDEX IF NOT EXISTS idx_gallery_prompt_profile_items_path ON gallery_prompt_index_profile_items(rel_path)")
            self.conn.execute("CREATE INDEX IF NOT EXISTS idx_gallery_virtual_folders_parent ON gallery_virtual_folders(parent_id, order_index, name)")

    def extract_characters_from_prompt(self, prompt_text):
        if not prompt_text: return []
        tags = [t.strip() for t in prompt_text.split(',')]
        found_characters = set()

        cur = self.conn.cursor()
        d_cur = self.danbooru_conn.cursor() if self.danbooru_conn else None

        for raw_tag in tags:
            cleaned_tag = clean_tag(raw_tag)
            if not cleaned_tag or len(cleaned_tag) < 2: continue

            # 1. 빠른 메모리(캐시) DB 우선 조회
            cur.execute("SELECT clean_name FROM known_characters WHERE tag = ?", (cleaned_tag,))
            row = cur.fetchone()

            if row:
                found_characters.add(row[0])
                continue

            is_found = False

            # 2. 단보루 정식 DB 초고속 일치 검색 (여기서 LIKE 검색을 날려서 속도를 10배 올렸습니다!)
            if d_cur:
                d_cur.execute("SELECT name FROM characters WHERE TRIM(name) = ?", (cleaned_tag,))
                d_row = d_cur.fetchone()

                if d_row:
                    char_name = d_row[0]
                    pretty_name = char_name.title()
                    is_found = True
                    try:
                        with self.conn:
                            self.conn.execute("INSERT OR IGNORE INTO known_characters (tag, clean_name) VALUES (?, ?)",
                                              (cleaned_tag, pretty_name))
                    except:
                        pass
                    found_characters.add(pretty_name)

            # 3. DB에 없어도 무조건 인정하는 최후의 보루! (이게 있으니 LIKE 검색이 필요 없습니다)
            if not is_found and re.search(r'_\(.*?\)$', cleaned_tag):
                if not cleaned_tag.startswith(
                        ('cosplay', 'style', 'artist', 'uniform')) and 'artist' not in cleaned_tag:
                    pretty_name = cleaned_tag.title()
                    try:
                        with self.conn:
                            self.conn.execute("INSERT OR IGNORE INTO known_characters (tag, clean_name) VALUES (?, ?)",
                                              (cleaned_tag, pretty_name))
                    except:
                        pass
                    found_characters.add(pretty_name)

        return list(found_characters)

    def get_hash(self, file_path):
        try:
            size = os.path.getsize(file_path)
            hasher = hashlib.md5()
            hasher.update(str(size).encode('utf-8'))
            with open(file_path, 'rb') as f:
                hasher.update(f.read(102400))
            return hasher.hexdigest()
        except:
            return None

    def is_processed(self, file_path):
        file_hash = self.get_hash(file_path)
        if not file_hash: return False
        cur = self.conn.cursor()
        cur.execute("SELECT 1 FROM processed_files WHERE file_hash = ?", (file_hash,))
        return cur.fetchone() is not None

    def add_history(self, file_path, file_name, characters=""):
        file_hash = self.get_hash(file_path)
        if not file_hash: return
        try:
            with self.conn:
                self.conn.execute("INSERT INTO processed_files (file_hash, file_name, characters) VALUES (?, ?, ?)",
                                  (file_hash, file_name, characters))
        except sqlite3.IntegrityError:
            pass

    def reset_db(self):
        try:
            now = time.time()
            with self.conn:
                self.conn.execute("DELETE FROM processed_files")
                self.conn.execute("DELETE FROM gallery_images")
                self.conn.execute("DELETE FROM gallery_folders")
                self.conn.execute(
                    "INSERT OR REPLACE INTO gallery_index_state (key, value, updated_at) VALUES (?, ?, ?)",
                    ("full_index_built", "0", now)
                )
                self.conn.execute(
                    "INSERT OR REPLACE INTO gallery_index_state (key, value, updated_at) VALUES (?, ?, ?)",
                    ("gallery_index_reset_for_reclassify", "1", now)
                )
            return True
        except:
            return False

    # 🌟 [여기 추가!] 휴지통 전용 관리 메서드들
    def save_trash_path(self, trash_path, original_path):
        try:
            with self.conn:
                self.conn.execute("INSERT OR REPLACE INTO trash_map (trash_path, original_path) VALUES (?, ?)",
                                  (trash_path, original_path))
        except:
            pass

    def get_original_path(self, trash_path):
        try:
            cur = self.conn.cursor()
            cur.execute("SELECT original_path FROM trash_map WHERE trash_path = ?", (trash_path,))
            row = cur.fetchone()
            return row[0] if row else None
        except:
            return None

    def remove_trash_path(self, trash_path):
        try:
            with self.conn:
                self.conn.execute("DELETE FROM trash_map WHERE trash_path = ?", (trash_path,))
        except:
            pass

    def remove_trash_folder(self, folder_path):
        try:
            with self.conn:
                self.conn.execute("DELETE FROM trash_map WHERE trash_path LIKE ?", (folder_path + '%',))
        except:
            pass

    # 🌟 [추가] 메타데이터 가져오기/저장 메서드
    def get_file_metadata(self, path):
        try:
            cur = self.conn.cursor()
            cur.execute("SELECT width, height, mtime FROM file_metadata WHERE path = ?", (path,))
            return cur.fetchone()
        except:
            return None

    def save_file_metadata(self, path, w, h, mtime):
        try:
            with self.conn:
                self.conn.execute("INSERT OR REPLACE INTO file_metadata VALUES (?, ?, ?, ?)", (path, w, h, mtime))
        except:
            pass

    def remove_all_file_records(self, rel_path):
        """특정 파일의 관련 스캔/통계 DB 기록을 삭제한다."""
        try:
            with self.conn:
                self.conn.execute("DELETE FROM image_artists WHERE path = ?", (rel_path,))
                self.conn.execute("DELETE FROM artist_scanned_files WHERE path = ?", (rel_path,))
                self.conn.execute("DELETE FROM file_metadata WHERE path = ?", (rel_path,))
        except Exception as e:
            print(f"DB 기록 삭제 실패: {e}")

    def gallery_image_record_exists(self, rel_path):
        clean = self.normalize_gallery_rel_path(rel_path)
        if clean.startswith("TOTAL_CLASSIFIED/"):
            clean = clean[len("TOTAL_CLASSIFIED/"):]
        if clean.startswith("/image/"):
            clean = clean[len("/image/"):]
        clean = clean.lstrip("/")

        if not clean:
            return False

        cur = self.conn.cursor()
        cur.execute("SELECT 1 FROM gallery_images WHERE rel_path = ? LIMIT 1", (clean,))
        return cur.fetchone() is not None

    def remove_gallery_image_record(self, rel_path):
        clean = self.normalize_gallery_rel_path(rel_path)
        if clean.startswith("TOTAL_CLASSIFIED/"):
            clean = clean[len("TOTAL_CLASSIFIED/"):]
        if clean.startswith("/image/"):
            clean = clean[len("/image/"):]
        clean = clean.lstrip("/")

        if not clean:
            return False

        now = self._next_gallery_prompt_index_revision()
        try:
            with self.conn:
                self.conn.execute("DELETE FROM gallery_images WHERE rel_path = ?", (clean,))
                self.conn.execute("DELETE FROM file_metadata WHERE path = ?", (clean,))
                self.conn.execute(
                    "DELETE FROM gallery_prompt_index_profile_items WHERE rel_path = ?",
                    (clean,)
                )
                self.conn.execute(
                    "DELETE FROM gallery_prompt_index WHERE rel_path = ?",
                    (clean,)
                )
                self.conn.execute(
                    "INSERT OR REPLACE INTO gallery_index_state (key, value, updated_at) VALUES (?, ?, ?)",
                    ("partial_index_updated_at", str(now), now)
                )
                self.conn.execute(
                    "INSERT OR REPLACE INTO gallery_index_state (key, value, updated_at) VALUES (?, ?, ?)",
                    ("prompt_index_updated_at", str(now), now)
                )
            return True
        except Exception as e:
            print(f"갤러리 이미지 인덱스 삭제 실패: {e}")
            return False

    def remove_gallery_folder_records(self, folder_rel_path):
        clean = self.normalize_gallery_rel_path(folder_rel_path)
        if clean.startswith("TOTAL_CLASSIFIED/"):
            clean = clean[len("TOTAL_CLASSIFIED/"):]
        clean = clean.strip("/")

        if not clean:
            return False

        like_pattern = clean + "/%"
        now = self._next_gallery_prompt_index_revision()

        try:
            with self.conn:
                self.conn.execute(
                    "DELETE FROM gallery_images WHERE rel_path = ? OR rel_path LIKE ? OR folder_path = ? OR folder_path LIKE ?",
                    (clean, like_pattern, clean, like_pattern)
                )
                self.conn.execute(
                    "DELETE FROM gallery_prompt_index_profile_items WHERE rel_path = ? OR rel_path LIKE ?",
                    (clean, like_pattern)
                )
                self.conn.execute(
                    "DELETE FROM gallery_prompt_index WHERE rel_path = ? OR rel_path LIKE ? OR folder_path = ? OR folder_path LIKE ?",
                    (clean, like_pattern, clean, like_pattern)
                )
                self.conn.execute(
                    "INSERT OR REPLACE INTO gallery_index_state (key, value, updated_at) VALUES (?, ?, ?)",
                    ("partial_index_updated_at", str(now), now)
                )
                self.conn.execute(
                    "INSERT OR REPLACE INTO gallery_index_state (key, value, updated_at) VALUES (?, ?, ?)",
                    ("prompt_index_updated_at", str(now), now)
                )
            return True
        except Exception as e:
            print(f"갤러리 폴더 인덱스 삭제 실패: {e}")
            return False

    def remove_folder_records(self, folder_rel_path):
        """폴더 삭제 시 하위 파일들의 DB 기록을 일괄 삭제한다."""
        clean = str(folder_rel_path or "").replace("\\", "/").strip("/")
        if not clean:
            return

        like_pattern = clean + "/%"

        try:
            with self.conn:
                self.conn.execute("DELETE FROM image_artists WHERE path = ? OR path LIKE ?", (clean, like_pattern))
                self.conn.execute("DELETE FROM artist_scanned_files WHERE path = ? OR path LIKE ?", (clean, like_pattern))
                self.conn.execute("DELETE FROM file_metadata WHERE path = ? OR path LIKE ?", (clean, like_pattern))
        except Exception as e:
            print(f"DB 폴더 기록 삭제 실패: {e}")

    def normalize_gallery_rel_path(self, path):
        text = str(path or "").replace("\\", "/").strip()

        if not text:
            return ""

        if "?" in text:
            text = text.split("?", 1)[0]

        # URL/공개 경로 prefix 제거
        for prefix in ("/image/", "image/", "/TOTAL_CLASSIFIED/", "TOTAL_CLASSIFIED/"):
            if text.startswith(prefix):
                text = text[len(prefix):]

        # absolute path가 들어온 경우 TOTAL_CLASSIFIED 기준 상대경로로 변환
        try:
            classified_root = os.path.dirname(self.db_path)
            if os.path.isabs(text):
                abs_text = os.path.abspath(text)
                abs_root = os.path.abspath(classified_root)
                if is_subpath(abs_text, abs_root):
                    text = os.path.relpath(abs_text, abs_root).replace("\\", "/")
        except Exception:
            pass

        # 문자열 중간에 TOTAL_CLASSIFIED가 포함된 absolute-like path 보정
        marker = "TOTAL_CLASSIFIED/"
        marker_index = text.replace("\\", "/").find(marker)
        if marker_index >= 0:
            text = text[marker_index + len(marker):]

        while text.startswith("/"):
            text = text[1:]

        return text.replace("\\", "/").strip("/")

    def set_gallery_index_state(self, key, value):
        now = time.time()
        with self.conn:
            self.conn.execute(
                "INSERT OR REPLACE INTO gallery_index_state (key, value, updated_at) VALUES (?, ?, ?)",
                (str(key), str(value), now)
            )

    def get_gallery_index_state(self, key, default=None):
        cur = self.conn.cursor()
        cur.execute("SELECT value FROM gallery_index_state WHERE key = ?", (str(key),))
        row = cur.fetchone()
        return row[0] if row else default

    def _next_gallery_prompt_index_revision(self):
        """Return a strictly increasing prompt-index revision marker."""
        now = time.time()
        previous = self.get_gallery_index_state("prompt_index_updated_at")
        try:
            previous = float(previous)
        except (TypeError, ValueError):
            previous = 0.0
        if now <= previous:
            now = previous + 0.000001
        return now

    def has_full_gallery_index(self):
        return self.get_gallery_index_state("full_index_built", "0") == "1"

    def clear_gallery_index(self):
        with self.conn:
            self.conn.execute("DELETE FROM gallery_images")
            self.conn.execute("DELETE FROM gallery_folders")
            self.conn.execute(
                "INSERT OR REPLACE INTO gallery_index_state (key, value, updated_at) VALUES (?, ?, ?)",
                ("full_index_built", "0", time.time())
            )

    def upsert_gallery_prompt_records(self, records):
        if not records:
            return

        now = self._next_gallery_prompt_index_revision()
        rows = []

        for record in records:
            rel_path = self.normalize_gallery_rel_path(record.get("rel_path"))
            if not rel_path:
                continue

            folder_path = self.normalize_gallery_rel_path(record.get("folder_path") or os.path.dirname(rel_path))
            prompt_text = str(record.get("prompt_text") or "")
            rows.append((
                rel_path,
                folder_path,
                str(record.get("file_name") or os.path.basename(rel_path)),
                str(record.get("mode") or "general"),
                float(record.get("mtime") or 0),
                prompt_text,
                str(record.get("normalized_text") or ""),
                len(prompt_text.encode("utf-8")),
                now
            ))

        if not rows:
            return

        with self.conn:
            self.conn.executemany(
                """
                INSERT OR REPLACE INTO gallery_prompt_index
                (rel_path, folder_path, file_name, mode, mtime, prompt_text, normalized_text, text_bytes, indexed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows
            )
            self.conn.execute(
                "INSERT OR REPLACE INTO gallery_index_state (key, value, updated_at) VALUES (?, ?, ?)",
                ("prompt_index_updated_at", str(now), now)
            )

    def clear_gallery_prompt_index(self, folder_prefix=None):
        folder_prefix = self.normalize_gallery_rel_path(folder_prefix or "")
        now = self._next_gallery_prompt_index_revision()

        with self.conn:
            if folder_prefix:
                like_value = folder_prefix.rstrip("/") + "/%"
                self.conn.execute(
                    """
                    DELETE FROM gallery_prompt_index
                    WHERE folder_path = ? OR folder_path LIKE ? OR rel_path LIKE ?
                    """,
                    (folder_prefix, like_value, like_value)
                )
            else:
                self.conn.execute("DELETE FROM gallery_prompt_index")

            self.conn.execute(
                "INSERT OR REPLACE INTO gallery_index_state (key, value, updated_at) VALUES (?, ?, ?)",
                ("prompt_index_updated_at", str(now), now)
            )

    def clear_all_gallery_prompt_index_data(self):
        now = self._next_gallery_prompt_index_revision()
        with self.conn:
            self.conn.execute("DELETE FROM gallery_prompt_index")
            self.conn.execute("DELETE FROM gallery_prompt_index_profiles")
            self.conn.execute("DELETE FROM gallery_prompt_index_profile_items")
            self.conn.execute(
                "INSERT OR REPLACE INTO gallery_index_state (key, value, updated_at) VALUES (?, ?, ?)",
                ("prompt_index_updated_at", str(now), now)
            )

    def _normalize_gallery_scope_paths(self, scope_paths=None):
        if isinstance(scope_paths, (list, tuple, set)):
            raw_paths = scope_paths
        else:
            raw_paths = [scope_paths]

        cleaned = []
        seen = set()

        for raw_path in raw_paths:
            clean = self.normalize_gallery_rel_path(raw_path or "")
            if clean in seen:
                continue
            seen.add(clean)
            cleaned.append(clean)

        return cleaned

    def _append_gallery_scope_where(self, clauses, params, scope_paths=None):
        scopes = [path for path in self._normalize_gallery_scope_paths(scope_paths) if path]

        if not scopes:
            return

        scope_clauses = []

        for scope in scopes:
            like_value = scope.rstrip("/") + "/%"
            scope_clauses.append("(folder_path = ? OR folder_path LIKE ? OR rel_path LIKE ?)")
            params.extend([scope, like_value, like_value])

        clauses.append("(" + " OR ".join(scope_clauses) + ")")

    def get_gallery_prompt_index_status(self, folder_prefix=None, mode=None):
        clauses = []
        params = []

        self._append_gallery_scope_where(clauses, params, folder_prefix)

        if mode == "all":
            clauses.append("mode != ?")
            params.append("trash")
        elif mode:
            clauses.append("mode = ?")
            params.append(str(mode))

        where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        cur = self.conn.cursor()
        cur.execute(
            f"""
            SELECT COUNT(*), COALESCE(SUM(text_bytes), 0), MAX(indexed_at)
            FROM gallery_prompt_index
            {where_sql}
            """,
            params
        )
        count, text_bytes, updated_at = cur.fetchone()

        return {
            "indexed_images": int(count or 0),
            "text_bytes": int(text_bytes or 0),
            "updated_at": float(updated_at or 0)
        }

    def get_gallery_prompt_index_mtimes(self, rel_paths):
        clean_paths = [
            self.normalize_gallery_rel_path(path)
            for path in (rel_paths or [])
            if self.normalize_gallery_rel_path(path)
        ]
        clean_paths = list(dict.fromkeys(clean_paths))

        if not clean_paths:
            return {}

        result = {}
        cur = self.conn.cursor()
        chunk_size = 450

        for index in range(0, len(clean_paths), chunk_size):
            chunk = clean_paths[index:index + chunk_size]
            placeholders = ",".join(["?"] * len(chunk))
            cur.execute(
                f"SELECT rel_path, mtime FROM gallery_prompt_index WHERE rel_path IN ({placeholders})",
                chunk
            )
            for rel_path, mtime in cur.fetchall():
                result[rel_path] = float(mtime or 0)

        return result

    def search_gallery_prompt_index(self, terms, scope_path="", mode="all", limit=50000):
        groups = _coerce_gallery_prompt_search_groups(terms)
        if not groups:
            return []

        clauses = []
        params = []

        self._append_gallery_scope_where(clauses, params, scope_path)

        if mode == "all":
            clauses.append("mode != ?")
            params.append("trash")
        elif mode:
            clauses.append("mode = ?")
            params.append(str(mode))

        candidate_sql, candidate_params = _gallery_prompt_search_candidate_where(
            groups, "normalized_text", "prompt_text"
        )
        if not candidate_sql:
            return []
        clauses.append(candidate_sql)
        params.extend(candidate_params)

        where_sql = f"WHERE {' AND '.join(clauses)}"
        cur = self.conn.cursor()
        cur.execute(
            f"""
            SELECT rel_path, folder_path, file_name, prompt_text, normalized_text
            FROM gallery_prompt_index
            {where_sql}
            ORDER BY folder_path, file_name
            """,
            params
        )

        max_results = max(0, int(limit))
        if max_results == 0:
            return []
        rows = []
        for row in cur.fetchall():
            if not gallery_prompt_search_matches(row[3], groups, row[4]):
                continue
            rows.append({"rel_path": row[0], "folder_path": row[1], "file_name": row[2]})
            if len(rows) >= max_results:
                break
        return rows

    def _iter_gallery_prompt_index_rows(self, scope_path="", mode="all"):
        """Stream indexed rows for a scope without materializing the result set."""
        clauses = []
        params = []

        self._append_gallery_scope_where(clauses, params, scope_path)

        if mode == "all":
            clauses.append("mode != ?")
            params.append("trash")
        elif mode:
            clauses.append("mode = ?")
            params.append(str(mode))

        where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        cur = self.conn.cursor()
        cur.execute(
            f"""
            SELECT rel_path, folder_path, file_name, prompt_text, normalized_text
            FROM gallery_prompt_index
            {where_sql}
            ORDER BY folder_path, file_name
            """,
            params
        )
        while True:
            row = cur.fetchone()
            if row is None:
                break
            yield row

    def _iter_gallery_prompt_index_matches(self, terms, scope_path="", mode="all"):
        """Stream exact shared-matcher results for an already indexed scope."""
        groups = _coerce_gallery_prompt_search_groups(terms)
        if not groups:
            return

        clauses = []
        params = []
        self._append_gallery_scope_where(clauses, params, scope_path)

        if mode == "all":
            clauses.append("mode != ?")
            params.append("trash")
        elif mode:
            clauses.append("mode = ?")
            params.append(str(mode))

        candidate_sql, candidate_params = _gallery_prompt_search_candidate_where(
            groups, "normalized_text", "prompt_text"
        )
        if not candidate_sql:
            return
        clauses.append(candidate_sql)
        params.extend(candidate_params)

        where_sql = f"WHERE {' AND '.join(clauses)}"
        cur = self.conn.cursor()
        cur.execute(
            f"""
            SELECT rel_path, folder_path, file_name, prompt_text, normalized_text
            FROM gallery_prompt_index
            {where_sql}
            ORDER BY folder_path, file_name
            """,
            params
        )
        while True:
            row = cur.fetchone()
            if row is None:
                break
            if gallery_prompt_search_matches(row[3], groups, row[4]):
                yield row

    @staticmethod
    def _gallery_virtual_folder_cache_signature(folder):
        """Canonicalize the dynamic inputs used to build one folder result."""
        return json.dumps(
            {
                "query": str(folder.get("query") or "").strip(),
                "scope_paths": list(folder.get("scope_paths") or []),
                "mode": str(folder.get("mode") or "all"),
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )

    def _gallery_virtual_folder_cache_revision(self):
        revision = self.get_gallery_index_state("prompt_index_updated_at")
        return str(revision or "").strip()

    def _get_gallery_virtual_folder_cache_meta(self, folder):
        """Return a metadata row only when it matches current folder/index state."""
        revision = self._gallery_virtual_folder_cache_revision()
        if not revision or not folder:
            return None

        cur = self.conn.cursor()
        cur.execute(
            """
            SELECT folder_id, folder_updated_at, prompt_index_revision,
                   query_signature, match_count, thumb_path, indexed, built_at
            FROM gallery_virtual_folder_cache_meta
            WHERE folder_id = ?
            """,
            (str(folder.get("id") or ""),),
        )
        row = cur.fetchone()
        if not row:
            return None

        try:
            same_folder = float(row[1]) == float(folder.get("updated_at") or 0)
        except (TypeError, ValueError):
            same_folder = False
        if not same_folder:
            return None
        if str(row[2] or "") != revision:
            return None
        if str(row[3] or "") != self._gallery_virtual_folder_cache_signature(folder):
            return None

        return {
            "folder_id": str(row[0]),
            "match_count": int(row[4] or 0),
            "thumb_path": str(row[5]) if row[5] else None,
            "indexed": bool(row[6]),
            "built_at": float(row[7] or 0),
            "prompt_index_revision": revision,
        }

    def _read_gallery_virtual_folder_cache_items(self, folder_id):
        cur = self.conn.cursor()
        cur.execute(
            """
            SELECT rel_path
            FROM gallery_virtual_folder_cache_items
            WHERE folder_id = ?
            ORDER BY rel_path
            """,
            (str(folder_id or ""),),
        )
        return [
            {
                "rel_path": row[0],
                "folder_path": self.normalize_gallery_rel_path(os.path.dirname(row[0] or "")),
                "file_name": os.path.basename(row[0] or ""),
            }
            for row in cur.fetchall()
        ]

    def resolve_gallery_virtual_folder_cache(self, folder, terms, include_items=True):
        """Return a cached dynamic search result, building it lazily on a miss.

        File-system fallback searches are intentionally not cached because they
        have no stable prompt-index revision to invalidate against.
        """
        if not folder or not str(folder.get("query") or "").strip() or not terms:
            return {
                "rows": [],
                "total_matches": 0,
                "thumb": None,
                "indexed": True,
                "cached": False,
            }

        revision = self._gallery_virtual_folder_cache_revision()
        if not revision:
            return {
                "rows": [],
                "total_matches": 0,
                "thumb": None,
                "indexed": False,
                "cached": False,
            }

        cached_meta = self._get_gallery_virtual_folder_cache_meta(folder)
        if cached_meta:
            rows = (
                self._read_gallery_virtual_folder_cache_items(folder.get("id"))
                if include_items else []
            )
            return {
                "rows": rows,
                "total_matches": cached_meta["match_count"],
                "thumb": cached_meta["thumb_path"],
                "indexed": cached_meta["indexed"],
                "cached": True,
            }

        scope_paths = folder.get("scope_paths") or []
        mode = folder.get("mode") or "all"
        rows = []
        for row in self._iter_gallery_prompt_index_matches(terms, scope_paths, mode):
            rel_path = self.normalize_gallery_rel_path(row[0])
            if not rel_path:
                continue
            rows.append({
                "rel_path": rel_path,
                "folder_path": self.normalize_gallery_rel_path(row[1] or os.path.dirname(rel_path)),
                "file_name": str(row[2] or os.path.basename(rel_path)),
            })

        thumb = rows[0]["rel_path"] if rows else None
        now = time.time()
        # Delete/insert/meta are one transaction so readers see either the old
        # complete cache or the new complete cache, never a partial build.
        with self.conn:
            folder_id = str(folder.get("id") or "")
            self.conn.execute(
                "DELETE FROM gallery_virtual_folder_cache_items WHERE folder_id = ?",
                (folder_id,),
            )
            self.conn.execute(
                "DELETE FROM gallery_virtual_folder_cache_meta WHERE folder_id = ?",
                (folder_id,),
            )
            if rows:
                self.conn.executemany(
                    """
                    INSERT INTO gallery_virtual_folder_cache_items
                    (folder_id, rel_path)
                    VALUES (?, ?)
                    """,
                    [
                        (folder_id, row["rel_path"])
                        for row in rows
                    ],
                )
            self.conn.execute(
                """
                INSERT INTO gallery_virtual_folder_cache_meta
                (folder_id, folder_updated_at, prompt_index_revision,
                 query_signature, match_count, thumb_path, indexed, built_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    folder_id,
                    float(folder.get("updated_at") or 0),
                    revision,
                    self._gallery_virtual_folder_cache_signature(folder),
                    len(rows),
                    thumb,
                    1,
                    now,
                ),
            )

        return {
            "rows": rows if include_items else [],
            "total_matches": len(rows),
            "thumb": thumb,
            "indexed": True,
            "cached": False,
        }

    def _list_gallery_virtual_folder_descendants(self, owner_id):
        """Return all descendants using the persisted parent_id links."""
        owner_id = str(owner_id or "")
        folders = self.list_gallery_virtual_folders()
        children_by_parent = {}
        for folder in folders:
            children_by_parent.setdefault(str(folder.get("parent_id") or ""), []).append(folder)

        descendants = []
        pending = [owner_id]
        while pending:
            parent_id = pending.pop(0)
            children = children_by_parent.get(parent_id, [])
            descendants.extend(children)
            pending.extend(str(child.get("id") or "") for child in children)
        return descendants

    def summarize_gallery_virtual_uncategorized(self, owner_id=None):
        """Summarize indexed images not assigned to a virtual descendant.

        ``owner_id=None`` is the virtual-folder root.  A concrete owner uses
        its own saved query/scope/mode as the base; queryless containers use
        only their scope/mode.  Descendant matches are removed by rel_path
        union so overlapping virtual searches are counted only once.
        """
        clean_owner_id = str(owner_id or "").strip()
        owner = None
        if clean_owner_id and clean_owner_id.lower() not in {"root", "null"}:
            owner = self.get_gallery_virtual_folder(clean_owner_id)
            if not owner:
                raise ValueError("가상 폴더를 찾을 수 없습니다.")

        base_scope = owner.get("scope_paths", []) if owner else []
        base_mode = owner.get("mode", "all") if owner else "all"
        base_query = owner.get("query", "") if owner else ""
        base_terms = parse_gallery_prompt_search_query(base_query) if base_query else []

        # A revision marker survives an index clear, but does not mean this
        # scope/mode has usable rows.  Preserve the existing not-ready/fallback
        # contract until the current base has at least one indexed image.
        base_status = self.get_gallery_prompt_index_status(base_scope, base_mode)
        indexed = int(base_status.get("indexed_images") or 0) > 0
        result = {
            "total_matches": 0,
            "thumb": None,
            "indexed": indexed,
        }
        if not indexed:
            result["reason"] = "prompt_index_unavailable"
            return result

        assigned_paths = set()
        if owner:
            descendants = self._list_gallery_virtual_folder_descendants(owner["id"])
        else:
            all_folders = self.list_gallery_virtual_folders()
            descendants = [folder for folder in all_folders if not folder.get("parent_id")]
            pending = list(descendants)
            while pending:
                current = pending.pop(0)
                children = [
                    folder for folder in all_folders
                    if str(folder.get("parent_id") or "") == str(current.get("id") or "")
                ]
                descendants.extend(children)
                pending.extend(children)

        for descendant in descendants:
            query = str(descendant.get("query") or "").strip()
            terms = parse_gallery_prompt_search_query(query) if query else []
            if not terms:
                continue
            descendant_result = self.resolve_gallery_virtual_folder_cache(
                descendant, terms, include_items=True
            )
            for row in descendant_result.get("rows") or []:
                assigned_paths.add(row["rel_path"])

        if base_terms:
            if owner:
                base_result = self.resolve_gallery_virtual_folder_cache(
                    owner, base_terms, include_items=True
                )
                base_rows = base_result.get("rows") or []
            else:
                base_rows = self._iter_gallery_prompt_index_matches(base_terms, base_scope, base_mode)
        else:
            base_rows = self._iter_gallery_prompt_index_rows(base_scope, base_mode)

        for row in base_rows:
            rel_path = row["rel_path"] if isinstance(row, dict) else row[0]
            if rel_path in assigned_paths:
                continue
            result["total_matches"] += 1
            if result["thumb"] is None:
                result["thumb"] = rel_path

        return result

    def summarize_gallery_prompt_index(self, terms, scope_path="", mode="all"):
        """Count exact prompt matches without materializing result rows.

        The SQL predicate intentionally remains the same broad candidate filter
        used by ``search_gallery_prompt_index``.  The shared Python matcher is
        still the final authority for exact/partial/AND/OR semantics.
        """
        groups = _coerce_gallery_prompt_search_groups(terms)
        if not groups:
            return {"total_matches": 0, "thumb": None}

        clauses = []
        params = []

        self._append_gallery_scope_where(clauses, params, scope_path)

        if mode == "all":
            clauses.append("mode != ?")
            params.append("trash")
        elif mode:
            clauses.append("mode = ?")
            params.append(str(mode))

        candidate_sql, candidate_params = _gallery_prompt_search_candidate_where(
            groups, "normalized_text", "prompt_text"
        )
        if not candidate_sql:
            return {"total_matches": 0, "thumb": None}
        clauses.append(candidate_sql)
        params.extend(candidate_params)

        where_sql = f"WHERE {' AND '.join(clauses)}"
        cur = self.conn.cursor()
        cur.execute(
            f"""
            SELECT rel_path, prompt_text, normalized_text
            FROM gallery_prompt_index
            {where_sql}
            ORDER BY folder_path, file_name
            """,
            params
        )

        total_matches = 0
        thumb = None
        while True:
            row = cur.fetchone()
            if row is None:
                break
            rel_path, prompt_text, normalized_text = row
            if not gallery_prompt_search_matches(prompt_text, groups, normalized_text):
                continue
            total_matches += 1
            if thumb is None:
                thumb = rel_path

        return {"total_matches": total_matches, "thumb": thumb}

    def search_gallery_prompt_index_profile(self, profile_id, terms, limit=50000):
        groups = _coerce_gallery_prompt_search_groups(terms)
        if not profile_id or not groups:
            return []

        clauses = ["pi.profile_id = ?"]
        params = [str(profile_id)]

        candidate_sql, candidate_params = _gallery_prompt_search_candidate_where(
            groups, "g.normalized_text", "g.prompt_text"
        )
        if not candidate_sql:
            return []
        clauses.append(candidate_sql)
        params.extend(candidate_params)

        cur = self.conn.cursor()
        cur.execute(
            f"""
            SELECT g.rel_path, g.folder_path, g.file_name, g.prompt_text, g.normalized_text
            FROM gallery_prompt_index_profile_items pi
            JOIN gallery_prompt_index g ON g.rel_path = pi.rel_path
            WHERE {' AND '.join(clauses)}
            ORDER BY g.folder_path, g.file_name
            """,
            params
        )

        max_results = max(0, int(limit))
        if max_results == 0:
            return []
        rows = []
        for row in cur.fetchall():
            if not gallery_prompt_search_matches(row[3], groups, row[4]):
                continue
            rows.append({"rel_path": row[0], "folder_path": row[1], "file_name": row[2]})
            if len(rows) >= max_results:
                break
        return rows

    def make_gallery_prompt_index_profile_id(self, mode, scope_paths):
        scope_list = [path for path in self._normalize_gallery_scope_paths(scope_paths) if path]
        signature = json.dumps({
            "mode": str(mode or "all"),
            "scope_paths": scope_list
        }, ensure_ascii=False, sort_keys=True)
        digest = hashlib.sha1(signature.encode("utf-8")).hexdigest()[:16]
        return f"prompt_{digest}"

    def upsert_gallery_prompt_index_profile(self, name, mode, scope_paths, rel_paths, text_bytes=0):
        scope_list = [path for path in self._normalize_gallery_scope_paths(scope_paths) if path]
        profile_id = self.make_gallery_prompt_index_profile_id(mode, scope_list)
        now = time.time()
        rel_list = [
            self.normalize_gallery_rel_path(path)
            for path in (rel_paths or [])
            if self.normalize_gallery_rel_path(path)
        ]
        rel_list = list(dict.fromkeys(rel_list))
        scope_json = json.dumps(scope_list, ensure_ascii=False)

        cur = self.conn.cursor()
        cur.execute("SELECT created_at FROM gallery_prompt_index_profiles WHERE id = ?", (profile_id,))
        row = cur.fetchone()
        created_at = float(row[0]) if row and row[0] else now

        with self.conn:
            self.conn.execute(
                """
                INSERT OR REPLACE INTO gallery_prompt_index_profiles
                (id, name, mode, scope_paths_json, image_count, text_bytes, created_at, updated_at, built_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    profile_id,
                    str(name or profile_id),
                    str(mode or "all"),
                    scope_json,
                    len(rel_list),
                    int(text_bytes or 0),
                    created_at,
                    now,
                    now
                )
            )
            self.conn.execute(
                "DELETE FROM gallery_prompt_index_profile_items WHERE profile_id = ?",
                (profile_id,)
            )
            self.conn.executemany(
                """
                INSERT OR REPLACE INTO gallery_prompt_index_profile_items
                (profile_id, rel_path)
                VALUES (?, ?)
                """,
                [(profile_id, rel_path) for rel_path in rel_list]
            )

        return {
            "id": profile_id,
            "name": str(name or profile_id),
            "mode": str(mode or "all"),
            "scope_paths_json": scope_json,
            "image_count": len(rel_list),
            "text_bytes": int(text_bytes or 0),
            "created_at": created_at,
            "updated_at": now,
            "built_at": now
        }

    def list_gallery_prompt_index_profiles(self):
        cur = self.conn.cursor()
        cur.execute(
            """
            SELECT id, name, mode, scope_paths_json, image_count, text_bytes, created_at, updated_at, built_at
            FROM gallery_prompt_index_profiles
            ORDER BY updated_at DESC, name ASC
            """
        )
        return [
            {
                "id": row[0],
                "name": row[1],
                "mode": row[2],
                "scope_paths_json": row[3],
                "image_count": int(row[4] or 0),
                "text_bytes": int(row[5] or 0),
                "created_at": float(row[6] or 0),
                "updated_at": float(row[7] or 0),
                "built_at": float(row[8] or 0)
            }
            for row in cur.fetchall()
        ]

    def get_gallery_prompt_index_profile_paths(self, profile_id):
        cur = self.conn.cursor()
        cur.execute(
            """
            SELECT rel_path
            FROM gallery_prompt_index_profile_items
            WHERE profile_id = ?
            ORDER BY rel_path
            """,
            (str(profile_id or ""),)
        )
        return [row[0] for row in cur.fetchall()]

    def delete_gallery_prompt_index_profile(self, profile_id):
        profile_id = str(profile_id or "")
        if not profile_id:
            return False

        with self.conn:
            cur = self.conn.execute(
                "DELETE FROM gallery_prompt_index_profiles WHERE id = ?",
                (profile_id,)
            )
            self.conn.execute(
                "DELETE FROM gallery_prompt_index_profile_items WHERE profile_id = ?",
                (profile_id,)
            )

        return cur.rowcount > 0

    # 가상 폴더는 파일 시스템을 변경하지 않고 검색 조건만 저장한다.
    @staticmethod
    def _normalize_virtual_folder_name(name):
        clean = str(name or "").strip()
        if not clean:
            raise ValueError("가상 폴더 이름은 비워 둘 수 없습니다.")
        if len(clean) > 200:
            raise ValueError("가상 폴더 이름은 200자 이내여야 합니다.")
        return clean

    def _normalize_virtual_folder_scope_paths(self, scope_paths=None):
        if isinstance(scope_paths, str) or scope_paths is None:
            raw_paths = [] if scope_paths is None else [scope_paths]
        else:
            raw_paths = scope_paths

        cleaned = []
        seen = set()
        for raw_path in raw_paths:
            clean = self.normalize_gallery_rel_path(raw_path or "")
            # Stored scopes must remain relative to TOTAL_CLASSIFIED.
            parts = [part for part in clean.split("/") if part]
            if any(part == ".." for part in parts):
                raise ValueError("가상 폴더 검색 범위가 올바르지 않습니다.")
            if clean in seen:
                continue
            seen.add(clean)
            cleaned.append(clean)
        return cleaned

    @staticmethod
    def _normalize_virtual_folder_mode(mode):
        clean = str(mode or "all").strip().lower()
        if clean not in {"all", "general", "r18"}:
            raise ValueError("가상 폴더 mode는 all, general, r18 중 하나여야 합니다.")
        return clean

    def _virtual_folder_row_to_dict(self, row):
        if not row:
            return None
        scope_paths = []
        try:
            decoded = json.loads(row[4] or "[]")
            if isinstance(decoded, list):
                scope_paths = [str(path) for path in decoded]
        except (TypeError, ValueError, json.JSONDecodeError):
            scope_paths = []
        return {
            "id": str(row[0]),
            "parent_id": str(row[1]) if row[1] else None,
            "name": str(row[2] or ""),
            "query": str(row[3] or ""),
            "scope_paths": scope_paths,
            "scope_paths_json": row[4] or "[]",
            "mode": str(row[5] or "all"),
            "order_index": int(row[6] or 0),
            "created_at": float(row[7] or 0),
            "updated_at": float(row[8] or 0)
        }

    def _get_virtual_folder_row(self, folder_id):
        cur = self.conn.cursor()
        cur.execute(
            """
            SELECT id, parent_id, name, query, scope_paths_json, mode,
                   order_index, created_at, updated_at
            FROM gallery_virtual_folders
            WHERE id = ?
            """,
            (str(folder_id or ""),)
        )
        return cur.fetchone()

    def _ensure_virtual_folder_parent(self, parent_id, folder_id=None):
        parent_id = str(parent_id or "")
        if not parent_id:
            return None
        parent = self._get_virtual_folder_row(parent_id)
        if not parent:
            raise ValueError("상위 가상 폴더를 찾을 수 없습니다.")
        if folder_id and parent_id == str(folder_id):
            raise ValueError("가상 폴더를 자기 자신 아래에 넣을 수 없습니다.")

        # Walk upward through the explicitly validated parent links. This
        # catches cycles even on databases created before this table existed.
        current_id = parent_id
        visited = set()
        while current_id:
            if current_id in visited:
                raise ValueError("가상 폴더 계층에 순환 참조가 있습니다.")
            visited.add(current_id)
            row = self._get_virtual_folder_row(current_id)
            if not row:
                raise ValueError("상위 가상 폴더를 찾을 수 없습니다.")
            current_id = str(row[1] or "")
            if folder_id and current_id == str(folder_id):
                raise ValueError("하위 가상 폴더를 상위 폴더로 이동할 수 없습니다.")
        return parent_id

    def _ensure_virtual_folder_sibling_name(self, name, parent_id, folder_id=None):
        clauses = ["parent_id IS NULL", "LOWER(name) = LOWER(?)"] if not parent_id else [
            "parent_id = ?", "LOWER(name) = LOWER(?)"
        ]
        params = [name] if not parent_id else [str(parent_id), name]
        if folder_id:
            clauses.append("id != ?")
            params.append(str(folder_id))
        cur = self.conn.cursor()
        cur.execute(
            "SELECT id FROM gallery_virtual_folders WHERE " + " AND ".join(clauses) + " LIMIT 1",
            params
        )
        if cur.fetchone():
            raise ValueError("같은 위치에 같은 이름의 가상 폴더가 이미 있습니다.")

    def list_gallery_virtual_folders(self, parent_id="__all__"):
        clauses = []
        params = []
        if parent_id != "__all__":
            if parent_id:
                clauses.append("parent_id = ?")
                params.append(str(parent_id))
            else:
                clauses.append("parent_id IS NULL")

        where_sql = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        cur = self.conn.cursor()
        cur.execute(
            """
            SELECT id, parent_id, name, query, scope_paths_json, mode,
                   order_index, created_at, updated_at
            FROM gallery_virtual_folders
            """ + where_sql + " ORDER BY order_index ASC, name COLLATE NOCASE ASC, id ASC",
            params
        )
        return [self._virtual_folder_row_to_dict(row) for row in cur.fetchall()]

    def get_gallery_virtual_folder(self, folder_id):
        return self._virtual_folder_row_to_dict(self._get_virtual_folder_row(folder_id))

    def create_gallery_virtual_folder(
        self, name, query="", scope_paths=None, mode="all", parent_id=None, order_index=0
    ):
        clean_name = self._normalize_virtual_folder_name(name)
        clean_query = str(query or "").strip()
        clean_scopes = self._normalize_virtual_folder_scope_paths(scope_paths)
        clean_mode = self._normalize_virtual_folder_mode(mode)
        clean_parent = self._ensure_virtual_folder_parent(parent_id)
        self._ensure_virtual_folder_sibling_name(clean_name, clean_parent)
        try:
            clean_order = int(order_index or 0)
        except (TypeError, ValueError):
            clean_order = 0

        folder_id = uuid.uuid4().hex
        now = time.time()
        with self.conn:
            self.conn.execute(
                """
                INSERT INTO gallery_virtual_folders
                (id, parent_id, name, query, scope_paths_json, mode,
                 order_index, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    folder_id,
                    clean_parent,
                    clean_name,
                    clean_query,
                    json.dumps(clean_scopes, ensure_ascii=False),
                    clean_mode,
                    clean_order,
                    now,
                    now
                )
            )
        return self.get_gallery_virtual_folder(folder_id)

    def update_gallery_virtual_folder(self, folder_id, **changes):
        current = self.get_gallery_virtual_folder(folder_id)
        if not current:
            return None

        name = self._normalize_virtual_folder_name(changes.get("name", current["name"]))
        query = str(changes.get("query", current["query"]) or "").strip()
        scopes = self._normalize_virtual_folder_scope_paths(
            changes.get("scope_paths", current["scope_paths"])
        )
        mode = self._normalize_virtual_folder_mode(changes.get("mode", current["mode"]))
        parent_id = changes.get("parent_id", current["parent_id"])
        parent_id = self._ensure_virtual_folder_parent(parent_id, folder_id=folder_id)
        self._ensure_virtual_folder_sibling_name(name, parent_id, folder_id=folder_id)
        try:
            order_index = int(changes.get("order_index", current["order_index"]) or 0)
        except (TypeError, ValueError):
            order_index = current["order_index"]

        now = time.time()
        try:
            previous_updated_at = float(current.get("updated_at") or 0)
            if now <= previous_updated_at:
                now = previous_updated_at + 0.000001
        except (TypeError, ValueError):
            pass
        with self.conn:
            self.conn.execute(
                """
                UPDATE gallery_virtual_folders
                SET parent_id = ?, name = ?, query = ?, scope_paths_json = ?,
                    mode = ?, order_index = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    parent_id,
                    name,
                    query,
                    json.dumps(scopes, ensure_ascii=False),
                    mode,
                    order_index,
                    now,
                    str(folder_id)
                )
            )
        return self.get_gallery_virtual_folder(folder_id)

    def reparent_gallery_virtual_folder(self, folder_id, parent_id=None, order_index=None):
        changes = {"parent_id": parent_id}
        if order_index is not None:
            changes["order_index"] = order_index
        return self.update_gallery_virtual_folder(folder_id, **changes)

    def delete_gallery_virtual_folder(self, folder_id):
        folder_id = str(folder_id or "")
        if not folder_id:
            return False
        if not self._get_virtual_folder_row(folder_id):
            return False
        cur = self.conn.cursor()
        cur.execute(
            "SELECT 1 FROM gallery_virtual_folders WHERE parent_id = ? LIMIT 1",
            (folder_id,)
        )
        if cur.fetchone():
            raise ValueError("하위 가상 폴더가 있어 삭제할 수 없습니다.")
        with self.conn:
            self.conn.execute(
                "DELETE FROM gallery_virtual_folder_cache_items WHERE folder_id = ?",
                (folder_id,),
            )
            self.conn.execute(
                "DELETE FROM gallery_virtual_folder_cache_meta WHERE folder_id = ?",
                (folder_id,),
            )
            deleted = self.conn.execute(
                "DELETE FROM gallery_virtual_folders WHERE id = ?",
                (folder_id,)
            ).rowcount
        return deleted > 0

    def build_gallery_image_record_from_file(self, file_path, classified_root=None, **overrides):
        classified_root = classified_root or os.path.dirname(self.db_path)
        raw_path = str(file_path or "")

        if os.path.isabs(raw_path):
            rel_path = os.path.relpath(raw_path, classified_root).replace("\\", "/")
            full_path = raw_path
        else:
            rel_path = self.normalize_gallery_rel_path(raw_path)
            full_path = os.path.join(classified_root, rel_path)

        rel_path = self.normalize_gallery_rel_path(rel_path)
        folder_path = self.normalize_gallery_rel_path(
            overrides.get("folder_path") or os.path.dirname(rel_path)
        )

        if os.path.basename(folder_path) == "_upscaled":
            folder_path = os.path.dirname(folder_path).replace("\\", "/")

        file_name = str(overrides.get("file_name") or os.path.basename(rel_path))

        try:
            mtime = float(overrides.get("mtime") or os.path.getmtime(full_path))
        except Exception:
            mtime = time.time()

        width = overrides.get("width")
        height = overrides.get("height")

        if width is None or height is None:
            cached = self.get_file_metadata(rel_path)
            if cached and cached[2] == mtime:
                width, height = cached[0], cached[1]
            else:
                try:
                    from PIL import Image
                    with Image.open(full_path) as img:
                        width, height = img.size
                    self.save_file_metadata(rel_path, width, height, mtime)
                except Exception:
                    pass

        mode = overrides.get("mode")
        if not mode:
            if rel_path.startswith("_TRASH/"):
                mode = "trash"
            elif rel_path.startswith("_R-18/") or rel_path.startswith("_R-15/"):
                mode = "r18"
            else:
                mode = "general"

        return {
            "rel_path": rel_path,
            "folder_path": folder_path,
            "file_name": file_name,
            "mode": mode,
            "rating": str(overrides.get("rating") or ""),
            "brand": str(overrides.get("brand") or ""),
            "character_names": str(overrides.get("character_names") or ""),
            "is_dakimakura": 1 if overrides.get("is_dakimakura") else 0,
            "width": width,
            "height": height,
            "mtime": mtime,
            "reason": str(overrides.get("reason") or ""),
            "gallery_tag": str(overrides.get("gallery_tag") or "")
        }

    def upsert_gallery_image_file(self, file_path, classified_root=None, **overrides):
        record = self.build_gallery_image_record_from_file(
            file_path,
            classified_root=classified_root,
            **overrides
        )
        self.upsert_gallery_image_records([record])
        return record

    def upsert_gallery_image_records(self, records):
        if not records:
            return

        now = time.time()
        image_rows = []
        folder_map = {}

        for record in records:
            rel_path = self.normalize_gallery_rel_path(record.get("rel_path"))
            if not rel_path:
                continue

            folder_path = self.normalize_gallery_rel_path(record.get("folder_path") or os.path.dirname(rel_path))
            file_name = str(record.get("file_name") or os.path.basename(rel_path))
            mode = str(record.get("mode") or "general")

            image_rows.append((
                rel_path,
                folder_path,
                file_name,
                mode,
                str(record.get("rating") or ""),
                str(record.get("brand") or ""),
                str(record.get("character_names") or ""),
                1 if record.get("is_dakimakura") else 0,
                record.get("width"),
                record.get("height"),
                record.get("mtime"),
                str(record.get("reason") or ""),
                str(record.get("gallery_tag") or ""),
                now
            ))

            folder_name = os.path.basename(folder_path) if folder_path else ""
            parent_path = os.path.dirname(folder_path).replace("\\", "/") if folder_path else ""
            folder_map[folder_path] = (folder_path, parent_path, folder_name, mode, now)

        if not image_rows:
            return

        with self.conn:
            self.conn.executemany(
                """
                INSERT OR REPLACE INTO gallery_images
                (rel_path, folder_path, file_name, mode, rating, brand, character_names,
                 is_dakimakura, width, height, mtime, reason, gallery_tag, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                image_rows
            )
            self.conn.executemany(
                """
                INSERT OR IGNORE INTO gallery_folders
                (folder_path, parent_path, folder_name, mode, total_images, direct_images, thumb_path, updated_at)
                VALUES (?, ?, ?, ?, 0, 0, '', ?)
                """,
                list(folder_map.values())
            )
            self.conn.execute(
                "INSERT OR REPLACE INTO gallery_index_state (key, value, updated_at) VALUES (?, ?, ?)",
                ("partial_index_updated_at", str(now), now)
            )

    def rebuild_gallery_folder_summaries(self):
        now = time.time()
        cur = self.conn.cursor()
        cur.execute("SELECT rel_path, folder_path, file_name, mode, mtime FROM gallery_images")
        images = cur.fetchall()
        folders = {}

        def ensure_folder(folder_path, mode):
            folder_path = self.normalize_gallery_rel_path(folder_path)
            if folder_path not in folders:
                folders[folder_path] = {
                    "folder_path": folder_path,
                    "parent_path": os.path.dirname(folder_path).replace("\\", "/") if folder_path else "",
                    "folder_name": os.path.basename(folder_path) if folder_path else "",
                    "mode": mode or "general",
                    "total_images": 0,
                    "direct_images": 0,
                    "thumb_path": "",
                    "thumb_score": (-1, -1.0)
                }
            return folders[folder_path]

        for rel_path, folder_path, file_name, mode, mtime in images:
            mode = mode or "general"
            folder_path = self.normalize_gallery_rel_path(folder_path)
            node = ensure_folder(folder_path, mode)
            node["direct_images"] += 1
            score = (1 if str(file_name or "").startswith("000_MAIN_") else 0, float(mtime or 0))
            if score > node["thumb_score"]:
                node["thumb_score"] = score
                node["thumb_path"] = rel_path

            current = folder_path
            while current:
                parent_node = ensure_folder(current, mode)
                parent_node["total_images"] += 1
                if score > parent_node["thumb_score"]:
                    parent_node["thumb_score"] = score
                    parent_node["thumb_path"] = rel_path
                current = os.path.dirname(current).replace("\\", "/")

        rows = [
            (
                item["folder_path"],
                item["parent_path"],
                item["folder_name"],
                item["mode"],
                item["total_images"],
                item["direct_images"],
                item["thumb_path"],
                now
            )
            for item in folders.values()
            if item["folder_path"]
        ]

        with self.conn:
            self.conn.execute("DELETE FROM gallery_folders")
            self.conn.executemany(
                """
                INSERT OR REPLACE INTO gallery_folders
                (folder_path, parent_path, folder_name, mode, total_images, direct_images, thumb_path, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows
            )

    def close(self):
        self.conn.close()
