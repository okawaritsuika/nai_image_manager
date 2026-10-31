"""Incremental local PNG/WebP catalog; only positive prompt tags are searchable."""
from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import re
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageOps

from naim.images.webp_conversion import restore_webp_metadata


def _text(value):
    if isinstance(value, str):
        return value.strip().strip('\x00')
    if not isinstance(value, bytes):
        return ''
    if value.startswith(b'UNICODE\x00'):
        value = value[8:]
        return value.decode('utf-16' if value.startswith((b'\xff\xfe', b'\xfe\xff')) else 'utf-16-be', errors='replace').strip('\x00').strip()
    if value.startswith((b'ASCII\x00\x00\x00', b'JIS\x00\x00\x00\x00\x00')):
        value = value[8:]
    return value.decode('utf-8', errors='replace').strip('\x00').strip()


def _json(value):
    if isinstance(value, dict):
        return value
    try:
        result = json.loads(_text(value))
        return result if isinstance(result, dict) else {}
    except (ValueError, TypeError):
        return {}


def _captions(value):
    if not isinstance(value, dict):
        return []
    caption = value.get('caption', value)
    if not isinstance(caption, dict):
        return []
    result = [caption.get('base_caption', '')]
    characters = caption.get('char_captions', [])
    if isinstance(characters, list):
        for character in characters:
            if isinstance(character, dict):
                result.append(character.get('char_caption', ''))
    return [item for item in result if isinstance(item, str) and item.strip()]


def _join(values):
    return ',\n'.join(dict.fromkeys(value.strip() for value in values if isinstance(value, str) and value.strip()))


def _structured(value):
    """Read recognized prompt fields, never every text node in arbitrary JSON."""
    data = _json(value)
    if not data:
        return '', ''
    def first(names):
        return next((data[name] for name in names if isinstance(data.get(name), str) and data[name].strip()), '')

    # v4 captions are the actual final base/character prompts. Earlier input
    # fields may contain tags removed before generation and must not be merged.
    v4_positive = _captions(data.get('v4_prompt'))
    v4_negative = _captions(data.get('v4_negative_prompt'))
    positive = v4_positive or [first(('prompt', 'positive_prompt', 'main_prompt', 'processed_input', 'input', 'original_input'))]
    negative = v4_negative or [first(('negative_prompt', 'uc'))]
    if not v4_positive:
        characters = data.get('character_prompts', [])
        if isinstance(characters, list):
            for character in characters:
                if isinstance(character, dict):
                    positive.append(next((character[name] for name in ('prompt', 'positive_prompt', 'caption')
                                          if isinstance(character.get(name), str) and character[name].strip()), ''))
                    if not v4_negative:
                        negative.append(next((character[name] for name in ('negative_prompt', 'uc')
                                              if isinstance(character.get(name), str) and character[name].strip()), ''))
    return _join(positive), _join(negative)


def _parameters(value):
    text = _text(value)
    # An A1111 settings footer is not prompt text.
    content = re.split(r'\n\s*Steps:\s*\d+', text, maxsplit=1)[0]
    pieces = re.split(r'\n\s*Negative prompt:\s*', content, maxsplit=1)
    return pieces[0].strip(), pieces[1].strip() if len(pieces) > 1 else ''


def _comfy(value):
    graph = _json(value)
    if not graph or not any(isinstance(node, dict) and 'class_type' in node for node in graph.values()):
        return '', ''

    def resolve(link, seen):
        if not isinstance(link, list) or not link:
            return []
        identifier = str(link[0])
        if identifier in seen:
            return []
        seen = seen | {identifier}
        node = graph.get(identifier)
        if not isinstance(node, dict):
            return []
        kind = str(node.get('class_type', ''))
        inputs = node.get('inputs', {})
        if not isinstance(inputs, dict):
            return []
        if kind in {'CLIPTextEncode', 'CLIPTextEncodeSDXL', 'CLIPTextEncodeSDXLRefiner'}:
            return [inputs.get(name) for name in ('text', 'text_g', 'text_l') if isinstance(inputs.get(name), str)]
        if kind.startswith('Conditioning'):
            return [text for item in inputs.values() if isinstance(item, list) for text in resolve(item, seen)]
        return []

    positive, negative = [], []
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get('inputs', {})
        if not isinstance(inputs, dict):
            continue
        if 'positive' in inputs and 'negative' in inputs:
            positive += resolve(inputs['positive'], set())
            negative += resolve(inputs['negative'], set())
    return _join(positive), _join(negative)


def _stealth(image):
    if image.mode != 'RGBA':
        return {}
    alpha = image.getchannel('A').transpose(Image.Transpose.TRANSPOSE).tobytes()

    def read(offset, size):
        bits = alpha[offset:offset + size * 8]
        return bytes(sum((bits[i + bit] & 1) << (7 - bit) for bit in range(8)) for i in range(0, len(bits) - 7, 8))

    signature = read(0, 15)
    if signature not in {b'stealth_pngcomp', b'stealth_pnginfo'}:
        return {}
    size_bits = int.from_bytes(read(120, 4), 'big')
    if size_bits % 8 or size_bits > min(len(alpha) - 152, 8 * 1024 * 1024):
        return {}
    payload = read(152, size_bits // 8)
    if signature == b'stealth_pngcomp':
        with gzip.GzipFile(fileobj=io.BytesIO(payload)) as stream:
            payload = stream.read(1024 * 1024 + 1)
        if len(payload) > 1024 * 1024:
            return {}
    return _json(payload)


def extract_prompt(image):
    restore_webp_metadata(image)
    info = dict(image.info)
    for key in ('Comment', 'comment', 'naia_prompt_context', 'naia_generation_params', 'naia_api_metadata'):
        positive, negative = _structured(info.get(key))
        if positive:
            # NAIA contexts can omit negatives which are present in generation parameters.
            if not negative:
                negative = _structured(info.get('naia_generation_params'))[1]
            return positive, negative, key
    if info.get('parameters'):
        positive, negative = _parameters(info['parameters'])
        if positive:
            return positive, negative, 'parameters'
    exif = image.getexif()
    exif_values = [exif.get(37510), exif.get(270)]
    try:
        exif_values.insert(0, exif.get_ifd(34665).get(37510))
    except (KeyError, TypeError, ValueError):
        pass
    for value in exif_values:
        text = _text(value)
        if not text:
            continue
        parsed = _json(text)
        positive, negative = _structured(parsed)
        if not positive and parsed:
            for key in ('Comment', 'comment', 'naia_prompt_context'):
                positive, negative = _structured(parsed.get(key))
                if positive:
                    break
            if not positive and parsed.get('parameters'):
                positive, negative = _parameters(parsed['parameters'])
        if not positive and not parsed and ('Steps:' in text or 'Negative prompt:' in text):
            positive, negative = _parameters(text)
        if positive:
            return positive, negative, 'EXIF'
    for key in ('prompt', 'workflow_api'):
        value = info.get(key)
        positive, negative = _structured(value)
        if not positive:
            positive, negative = _comfy(value)
        if positive:
            return positive, negative, 'ComfyUI' if _json(value) else key
        if key == 'prompt' and isinstance(value, str) and not value.lstrip().startswith(('{', '[')):
            return value, _text(info.get('negative_prompt')), 'prompt'
    description = _text(info.get('Description'))
    if description and ('novelai' in _text(info.get('Software')).lower() or info.get('Comment')):
        return description, '', 'NovelAI Description'
    stealth = _stealth(image)
    if stealth:
        positive, negative = _structured(stealth)
        if not positive:
            positive, negative = _structured(stealth.get('Comment'))
        if not positive and stealth.get('parameters'):
            positive, negative = _parameters(stealth['parameters'])
        if positive:
            return positive, negative, 'NovelAI stealth'
    return '', '', ''


def prompt_tags(prompt, vocabulary):
    text = re.sub(r'-?\d+(?:\.\d+)?::', '', prompt).replace('::', '')
    text = text.translate(str.maketrans('', '', '{}[]'))
    result = set()
    for piece in re.split(r'[,\n]', text):
        tag = piece.strip()
        while len(tag) > 1 and tag[0] == '(' and tag[-1] == ')':
            tag = re.sub(r':[-+]?\d+(?:\.\d+)?$', '', tag[1:-1]).strip()
        tag = ' '.join(tag.lower().replace('_', ' ').split())
        if tag in vocabulary:
            result.add(tag)
    return result


class ImageCatalog:
    def __init__(self, data_dir: Path, vocabulary: set[str]):
        self.directory = Path(data_dir)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.vocabulary = set(vocabulary)
        self.database = self.directory / 'image_catalog.sqlite3'
        self.cache = self.directory / 'image_thumbnails'
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.scanning = False
        self.generation = 0
        self.revision = 0
        self.last_scan = None
        self.error = None
        self.worker = None
        with self._connect() as db:
            db.executescript('''CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
            CREATE TABLE IF NOT EXISTS images(id INTEGER PRIMARY KEY AUTOINCREMENT,path TEXT UNIQUE NOT NULL,
              mtime INTEGER,size INTEGER,width INTEGER,height INTEGER,prompt TEXT,negative TEXT,source TEXT,
              tags TEXT,status TEXT);
            CREATE TABLE IF NOT EXISTS image_tags(image_id INTEGER,tag TEXT,PRIMARY KEY(image_id,tag));
            CREATE INDEX IF NOT EXISTS image_tag_lookup ON image_tags(tag,image_id);''')
            setting = db.execute("SELECT value FROM settings WHERE key='folder'").fetchone()
            self.folder = setting[0] if setting else None
            db.execute("DELETE FROM image_tags WHERE tag NOT IN (%s)" % ','.join('?' for _ in self.vocabulary), tuple(self.vocabulary)) if self.vocabulary else db.execute('DELETE FROM image_tags')
        self.watcher = threading.Thread(target=self._watch, daemon=True, name='tag-dictionary-images')
        self.watcher.start()
        if self.folder:
            self.scan_async()

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(self.database, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def _path_within_folder(self, value):
        if not self.folder:
            return None
        try:
            root = Path(self.folder).resolve(strict=True)
            path = Path(value).resolve(strict=True)
        except (OSError, RuntimeError, ValueError):
            return None
        return path if path.is_relative_to(root) and path.is_file() else None

    def _watch(self):
        while not self.stop.wait(30):
            if self.folder:
                try:
                    self.scan_async()
                except Exception:
                    with self.lock:
                        self.error = '이미지 폴더를 색인하지 못했습니다.'

    def status(self):
        with self.lock, self._connect() as db:
            values = db.execute('''SELECT COUNT(*) AS total,
              SUM(status!='error') AS indexed,SUM(status='error') AS unreadable,
              SUM(status='no_prompt') AS no_prompt,
              SUM(id IN (SELECT image_id FROM image_tags)) AS matched FROM images''').fetchone()
            return {'folder': self.folder, 'scanning': self.scanning,
                    'revision': self.revision,
                    'total_files': values['total'], 'indexed_images': values['indexed'] or 0,
                    'matched_images': values['matched'] or 0, 'unreadable': values['unreadable'] or 0,
                    'no_prompt': values['no_prompt'] or 0, 'last_scan': self.last_scan, 'error': self.error}

    def statistics_counts(self):
        """One consistent snapshot of prompt-bearing images and exact tag counts."""
        with self.lock, self._connect() as db:
            db.execute('BEGIN')
            total = db.execute("SELECT COUNT(*) FROM images WHERE status='indexed'").fetchone()[0]
            counts = {row[0]: row[1] for row in db.execute(
                "SELECT tag,COUNT(*) FROM image_tags GROUP BY tag")}
            return {'total_images': total, 'tag_counts': counts}

    def set_folder(self, path: str):
        folder = Path(path).expanduser().resolve(strict=True)
        if not folder.is_dir():
            raise ValueError('압축을 푼 이미지 폴더를 선택하세요.')
        with self.lock:
            if self.folder != str(folder):
                self.generation += 1
                self.revision += 1
                self.folder = str(folder)
                with self._connect() as db:
                    db.execute('DELETE FROM image_tags')
                    db.execute('DELETE FROM images')
                    db.execute("INSERT OR REPLACE INTO settings VALUES('folder',?)", (self.folder,))
                self.last_scan = None
                self.error = None
        self.scan_async()
        return self.status()

    def can_install_image_pack(self):
        """A downloaded pack may replace only an absent or unusable image index."""
        with self.lock, self._connect() as db:
            return not any(self._path_within_folder(row['path']) is not None
                           for row in db.execute('SELECT path FROM images'))

    def install_image_pack(self, root, records, expected_generation, stop_event=None):
        """Connect a fully verified managed pack without touching dictionary edits."""
        root = Path(root).resolve(strict=True)
        managed = (self.directory / 'shared_image_packs').resolve()
        if not root.is_dir() or not root.is_relative_to(managed) or root == managed:
            raise ValueError('예시 이미지 설치 폴더를 확인해 주세요.')
        if not isinstance(records, list) or not records:
            raise ValueError('연결할 예시 이미지가 없습니다.')
        values, tag_rows, seen = [], [], set()
        for record in records:
            identifier = record.get('id')
            if type(identifier) is not int or not 1 <= identifier <= 9007199254740991 or identifier in seen:
                raise ValueError('예시 이미지 번호를 확인해 주세요.')
            seen.add(identifier)
            relative = f'images/{identifier:06d}.webp'
            if record.get('file') != relative:
                raise ValueError('예시 이미지 경로를 확인해 주세요.')
            path = root / relative
            if path.is_symlink() or not path.resolve().is_relative_to(root) or not path.is_file():
                raise ValueError('예시 이미지 파일을 확인해 주세요.')
            prompt, negative, source = (record.get(key) for key in ('prompt', 'negative', 'source'))
            if (not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 1024 * 1024
                    or not isinstance(negative, str) or len(negative) > 1024 * 1024
                    or not isinstance(source, str) or len(source) > 128):
                raise ValueError('예시 이미지 프롬프트를 확인해 주세요.')
            width, height = record.get('width'), record.get('height')
            if any(type(value) is not int or not 1 <= value <= 16383 for value in (width, height)):
                raise ValueError('예시 이미지 크기를 확인해 주세요.')
            info = path.stat()
            matched = sorted(prompt_tags(prompt, self.vocabulary))
            values.append((identifier, str(path.resolve()), info.st_mtime_ns, info.st_size,
                           width, height, prompt, negative, source, json.dumps(matched), 'indexed'))
            tag_rows.extend((identifier, tag) for tag in matched)
        with self.lock:
            if self.stop.is_set() or (stop_event is not None and stop_event.is_set()):
                raise InterruptedError('예시 이미지 연결을 중지했습니다.')
            if self.generation != expected_generation:
                raise ValueError('이미지 폴더 연결이 바뀌었습니다. 현재 연결을 유지합니다.')
            if not self.can_install_image_pack():
                raise ValueError('이미 연결된 이미지가 있습니다. 현재 연결을 유지합니다.')
            with self._connect() as db:
                db.execute('DELETE FROM image_tags')
                db.execute('DELETE FROM images')
                db.executemany('''INSERT INTO images(id,path,mtime,size,width,height,prompt,negative,source,tags,status)
                                  VALUES(?,?,?,?,?,?,?,?,?,?,?)''', values)
                db.executemany('INSERT INTO image_tags VALUES(?,?)', tag_rows)
                db.execute("INSERT OR REPLACE INTO settings VALUES('folder',?)", (str(root),))
                if stop_event is not None and stop_event.is_set():
                    raise InterruptedError('예시 이미지 연결을 중지했습니다.')
            self.generation += 1
            self.revision += 1
            self.folder = str(root)
            self.last_scan = datetime.now(timezone.utc).isoformat()
            self.error = None
        return self.status()

    def scan_async(self):
        with self.lock:
            if self.scanning or not self.folder or self.stop.is_set():
                return self.status()
            self.scanning = True
            generation, folder = self.generation, self.folder
            self.worker = threading.Thread(target=self._scan, args=(generation, folder), daemon=True)
            self.worker.start()
        return self.status()

    def _scan(self, generation, folder):
        root = Path(folder)
        seen = set()
        try:
            if not root.is_dir():
                raise FileNotFoundError('선택한 이미지 폴더를 찾을 수 없습니다.')
            for path in root.rglob('*'):
                if self.stop.is_set() or generation != self.generation:
                    return
                if path.suffix.lower() not in {'.png', '.webp'} or not path.is_file():
                    continue
                resolved = path.resolve()
                if not resolved.is_relative_to(root):
                    continue
                key = str(resolved)
                seen.add(key)
                existing = None
                try:
                    before = resolved.stat()
                    with self.lock, self._connect() as db:
                        existing = db.execute('SELECT * FROM images WHERE path=?', (key,)).fetchone()
                    if existing and existing['mtime'] == before.st_mtime_ns and existing['size'] == before.st_size and existing['status'] != 'error':
                        continue
                    with Image.open(resolved) as image:
                        width, height = image.size
                        prompt, negative, source = extract_prompt(image)
                    after = resolved.stat()
                    if (before.st_mtime_ns, before.st_size) != (after.st_mtime_ns, after.st_size):
                        continue
                    matched = sorted(prompt_tags(prompt, self.vocabulary))
                    status = 'indexed' if prompt else 'no_prompt'
                except (OSError, ValueError, SyntaxError, Image.DecompressionBombError):
                    before = None
                    width = height = 0
                    prompt = negative = source = ''
                    matched = []
                    status = 'error'
                with self.lock:
                    if self.stop.is_set() or generation != self.generation:
                        return
                    values = (key, before.st_mtime_ns if before else 0, before.st_size if before else 0,
                              width, height, prompt, negative, source, json.dumps(matched), status)
                    fields = ('path', 'mtime', 'size', 'width', 'height', 'prompt', 'negative', 'source', 'tags', 'status')
                    if existing and tuple(existing[field] for field in fields) == values:
                        continue
                    with self._connect() as db:
                        db.execute('''INSERT INTO images(path,mtime,size,width,height,prompt,negative,source,tags,status)
                          VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET
                          mtime=excluded.mtime,size=excluded.size,width=excluded.width,height=excluded.height,
                          prompt=excluded.prompt,negative=excluded.negative,source=excluded.source,tags=excluded.tags,status=excluded.status''',
                          values)
                        identifier = db.execute('SELECT id FROM images WHERE path=?', (key,)).fetchone()[0]
                        db.execute('DELETE FROM image_tags WHERE image_id=?', (identifier,))
                        db.executemany('INSERT INTO image_tags VALUES(?,?)', [(identifier, tag) for tag in matched])
                    self.revision += 1
            with self.lock:
                if self.stop.is_set() or generation != self.generation:
                    return
                with self._connect() as db:
                    stale = [row[0] for row in db.execute('SELECT path FROM images') if row[0] not in seen]
                    for path in stale:
                        db.execute('DELETE FROM image_tags WHERE image_id=(SELECT id FROM images WHERE path=?)', (path,))
                        db.execute('DELETE FROM images WHERE path=?', (path,))
                    if stale:
                        self.revision += 1
                self.last_scan = datetime.now(timezone.utc).isoformat()
                self.error = None
        except OSError as error:
            with self.lock:
                if generation == self.generation:
                    self.error = str(error)
        except Exception:
            with self.lock:
                if generation == self.generation:
                    self.error = '이미지 폴더를 색인하지 못했습니다.'
        finally:
            with self.lock:
                self.scanning = False
                changed = generation != self.generation
            if changed and not self.stop.is_set():
                self.scan_async()

    def query(self, tag: str, offset=0, limit=24):
        offset, limit = max(0, int(offset)), max(1, min(100, int(limit)))
        with self.lock, self._connect() as db:
            total = db.execute('SELECT COUNT(*) FROM image_tags WHERE tag=?', (tag,)).fetchone()[0]
            rows = db.execute('''SELECT images.* FROM images JOIN image_tags ON images.id=image_tags.image_id
              WHERE image_tags.tag=? ORDER BY images.mtime DESC,images.id DESC LIMIT ? OFFSET ?''', (tag, limit, offset)).fetchall()
        rows = [row for row in rows if self._path_within_folder(row['path']) is not None]
        items = [{'id': row['id'], 'name': Path(row['path']).name, 'width': row['width'],
                      'height': row['height'], 'matched_tags': json.loads(row['tags'])} for row in rows]
        return {'total': total, 'items': items, 'offset': offset, 'limit': limit}

    def detail(self, image_id: int):
        with self.lock, self._connect() as db:
            row = db.execute('SELECT * FROM images WHERE id=?', (int(image_id),)).fetchone()
            if not row or self._path_within_folder(row['path']) is None:
                return None
            return {'id': row['id'], 'name': Path(row['path']).name, 'path': row['path'],
                    'width': row['width'], 'height': row['height'], 'prompt': row['prompt'],
                    'negative_prompt': row['negative'], 'matched_tags': json.loads(row['tags']),
                    'metadata_source': row['source']}

    def file_path(self, image_id: int):
        with self.lock:
            detail = self.detail(image_id)
            if not detail:
                return None
            return self._path_within_folder(detail['path'])

    def thumbnail(self, image_id: int):
        with self.lock:
            path = self.file_path(image_id)
            if path is None:
                return None
            stat = path.stat()
            digest = hashlib.sha256(f'{image_id}:{path}:{stat.st_mtime_ns}:{stat.st_size}'.encode()).hexdigest()
            self.cache.mkdir(exist_ok=True)
            target = self.cache / (digest + '.webp')
            if target.exists():
                return target
            with Image.open(path) as image:
                preview = ImageOps.exif_transpose(image)
                preview.thumbnail((256, 768), Image.Resampling.LANCZOS)
                if preview.mode not in {'RGB', 'RGBA'}:
                    preview = preview.convert('RGB')
                temporary = target.with_suffix('.tmp')
                preview.save(temporary, format='WEBP', quality=82)
                os.replace(temporary, target)
            return target

    def close(self):
        with self.lock:
            self.stop.set()
        self.watcher.join(timeout=2)
        worker = self.worker
        if worker and worker is not threading.current_thread():
            worker.join(timeout=5)
