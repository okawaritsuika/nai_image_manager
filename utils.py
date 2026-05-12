# -*- coding: utf-8 -*-
import os
import json
import re
import sqlite3
import hashlib
import socket

CONFIG_FILE = "gallery_config.json"


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
        base_dir = os.path.dirname(os.path.abspath(__file__))
        db_folder = os.path.join(base_dir, "TOTAL_CLASSIFIED")
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
            with self.conn:
                self.conn.execute("DELETE FROM processed_files")
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

    def close(self):
        self.conn.close()
