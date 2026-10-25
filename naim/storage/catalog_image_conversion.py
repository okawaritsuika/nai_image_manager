"""Update exact catalog image fields while preserving recipes and unknown data."""
import csv
from copy import deepcopy
import hashlib
from html.parser import HTMLParser
import io
import json
import os
from pathlib import Path
import tempfile

from naim.storage.json_files import json_lock, write_json
from naim.storage.webp_conversion import WebpReferenceRollbackError


_IMAGE_FIELDS = frozenset({'image', 'thumbnail', 'image_path'})


def _image_values(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if key in _IMAGE_FIELDS and isinstance(child, str):
                yield child
            else:
                yield from _image_values(child)
    elif isinstance(value, list):
        for child in value:
            yield from _image_values(child)


def _replace_image(value, old, new, target_sha256):
    changed = False
    if isinstance(value, dict):
        for key, child in value.items():
            if key in _IMAGE_FIELDS and isinstance(child, str) and child.replace('\\', '/') == old:
                value[key] = new
                if key in {'image', 'image_path'} and 'image_sha256' in value:
                    value['image_sha256'] = target_sha256
                changed = True
            else:
                changed = _replace_image(child, old, new, target_sha256) or changed
    elif isinstance(value, list):
        for child in value:
            changed = _replace_image(child, old, new, target_sha256) or changed
    return changed


def _atomic_write_bytes(path, data):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=f'.{path.name}.', suffix='.tmp', delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


class _DataScriptLocator(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=False)
        self.line_offsets = [0]
        self.line_offsets.extend(index + 1 for index, char in enumerate(source) if char == '\n')
        self.active_start = None
        self.ranges = []

    def _offset(self):
        line, column = self.getpos()
        return self.line_offsets[line - 1] + column

    def handle_starttag(self, tag, attrs):
        if tag.lower() != 'script':
            return
        attributes = dict(attrs)
        if attributes.get('id') == 'data' and attributes.get('type', '').lower() == 'application/json':
            if self.active_start is not None:
                raise ValueError('카탈로그 data JSON script가 중첩되었습니다.')
            self.active_start = self._offset() + len(self.get_starttag_text())

    def handle_endtag(self, tag):
        if tag.lower() == 'script' and self.active_start is not None:
            self.ranges.append((self.active_start, self._offset()))
            self.active_start = None


def _data_script(text):
    parser = _DataScriptLocator(text)
    parser.feed(text)
    parser.close()
    if parser.active_start is not None or len(parser.ranges) != 1:
        raise ValueError('index.html에는 data JSON script가 정확히 하나 있어야 합니다.')
    start, end = parser.ranges[0]
    payload = text[start:end]
    try:
        return start, end, json.loads(payload)
    except (json.JSONDecodeError, TypeError) as error:
        raise ValueError('index.html의 data JSON이 올바르지 않습니다.') from error


def _parse_catalog_csv(raw):
    has_bom = raw.startswith(b'\xef\xbb\xbf')
    try:
        text = raw.decode('utf-8-sig')
        reader = csv.reader(io.StringIO(text, newline=''), strict=True)
        rows = list(reader)
    except (UnicodeDecodeError, csv.Error) as error:
        raise ValueError('tags.csv 형식을 읽을 수 없습니다.') from error
    if not rows or rows[0].count('examples') != 1:
        raise ValueError('tags.csv에 examples 열이 정확히 하나 있어야 합니다.')
    examples_index = rows[0].index('examples')
    references = set()
    for row in rows[1:]:
        if examples_index >= len(row) or not row[examples_index].strip():
            continue
        try:
            examples = json.loads(row[examples_index])
        except json.JSONDecodeError as error:
            raise ValueError('tags.csv의 examples JSON이 올바르지 않습니다.') from error
        references.update(value.replace('\\', '/') for value in _image_values(examples))
    return text, rows, examples_index, references, has_bom


def _serialize_catalog_csv(rows, has_bom, newline):
    output = io.StringIO(newline='')
    csv.writer(output, lineterminator=newline).writerows(rows)
    encoded = output.getvalue().encode('utf-8')
    return (b'\xef\xbb\xbf' + encoded) if has_bom else encoded


def _catalog_asset(root, name):
    path = root / name
    if path.is_symlink() or path.resolve().parent != root:
        raise ValueError(f'카탈로그 외부로 연결된 {name}은 갱신하지 않습니다.')
    return path if path.exists() else None


def _csv_newline(text):
    crlf = text.find('\r\n')
    lf = text.find('\n')
    cr = text.find('\r')
    choices = [(index, token) for index, token in ((crlf, '\r\n'), (lf, '\n'), (cr, '\r')) if index >= 0]
    return min(choices, key=lambda item: item[0])[1] if choices else '\r\n'


class CatalogImageReferences:
    """An index for one offline batch; only affected JSON files are reread.

    The converter publishes its verified target before this callback and only
    removes the source after the callback succeeds. Rollback never overwrites
    a catalog subsequently edited by another process.
    """
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.files = {}
        for path in self.root.glob('*.json'):
            if path.is_symlink() or path.resolve().parent != self.root:
                raise ValueError('카탈로그 외부로 연결된 JSON은 갱신하지 않습니다.')
            data = json.loads(path.read_text(encoding='utf-8-sig'))
            for relative in set(_image_values(data)):
                self.files.setdefault(relative.replace('\\', '/'), set()).add(path)

        self.html_path = _catalog_asset(self.root, 'index.html')
        self.html_references = set()
        if self.html_path is not None:
            raw = self.html_path.read_bytes()
            try:
                text = raw.decode('utf-8')
            except UnicodeDecodeError as error:
                raise ValueError('index.html은 UTF-8이어야 합니다.') from error
            _, _, data = _data_script(text)
            self.html_references = {value.replace('\\', '/') for value in _image_values(data)}

        self.csv_path = _catalog_asset(self.root, 'tags.csv')
        self.csv_references = set()
        if self.csv_path is not None:
            _, _, _, self.csv_references, _ = _parse_catalog_csv(self.csv_path.read_bytes())

    def prepare(self, source, target):
        old = Path(source).resolve().relative_to(self.root).as_posix()
        new = Path(target).resolve().relative_to(self.root).as_posix()
        target_path = Path(target)
        if target_path.is_symlink() or not target_path.is_file():
            raise ValueError('검증된 WebP 대상 파일을 찾을 수 없습니다.')
        has_references = bool(self.files.get(old)) or old in self.html_references or old in self.csv_references
        target_sha256 = hashlib.sha256(target_path.read_bytes()).hexdigest() if has_references else None
        written = []

        def rollback():
            errors = []
            for kind, path, previous, published in reversed(written):
                try:
                    if kind == 'json':
                        with json_lock(path):
                            current = json.loads(path.read_text(encoding='utf-8-sig'))
                            if current == previous:
                                continue
                            if current != published:
                                raise ValueError('카탈로그가 외부에서 변경되었습니다.')
                            write_json(path, previous, indent=2)
                    else:
                        current = path.read_bytes()
                        if current == previous:
                            continue
                        if current != published:
                            raise ValueError('카탈로그가 외부에서 변경되었습니다.')
                        _atomic_write_bytes(path, previous)
                except Exception as error:
                    errors.append(error)
            if errors:
                raise WebpReferenceRollbackError('카탈로그 복구를 확인하지 못해 원본과 WebP를 모두 보존합니다.') from errors[0]

        try:
            for path in sorted(self.files.get(old, ())):
                with json_lock(path):
                    previous = json.loads(path.read_text(encoding='utf-8-sig'))
                    updated = deepcopy(previous)
                    if _replace_image(updated, old, new, target_sha256):
                        written.append(('json', path, previous, updated))
                        write_json(path, updated, indent=2)

            if self.html_path is not None and old in self.html_references:
                path = self.html_path
                previous = path.read_bytes()
                try:
                    text = previous.decode('utf-8')
                except UnicodeDecodeError as error:
                    raise ValueError('index.html은 UTF-8이어야 합니다.') from error
                start, end, data = _data_script(text)
                updated = deepcopy(data)
                if _replace_image(updated, old, new, target_sha256):
                    original_payload = text[start:end]
                    leading = original_payload[:len(original_payload) - len(original_payload.lstrip())]
                    trailing = original_payload[len(original_payload.rstrip()):]
                    payload = leading + json.dumps(updated, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c') + trailing
                    published = (text[:start] + payload + text[end:]).encode('utf-8')
                    written.append(('bytes', path, previous, published))
                    if path.read_bytes() != previous:
                        raise WebpReferenceRollbackError('index.html이 외부에서 변경되어 갱신을 중단했습니다.')
                    _atomic_write_bytes(path, published)

            if self.csv_path is not None and old in self.csv_references:
                path = self.csv_path
                previous = path.read_bytes()
                text, rows, examples_index, _, has_bom = _parse_catalog_csv(previous)
                updated_any = False
                for row in rows[1:]:
                    if examples_index >= len(row) or not row[examples_index].strip():
                        continue
                    examples = json.loads(row[examples_index])
                    if _replace_image(examples, old, new, target_sha256):
                        row[examples_index] = json.dumps(examples, ensure_ascii=False, separators=(',', ':'))
                        updated_any = True
                if updated_any:
                    published = _serialize_catalog_csv(rows, has_bom, _csv_newline(text))
                    written.append(('bytes', path, previous, published))
                    if path.read_bytes() != previous:
                        raise WebpReferenceRollbackError('tags.csv가 외부에서 변경되어 갱신을 중단했습니다.')
                    _atomic_write_bytes(path, published)
            return rollback
        except Exception:
            rollback()
            raise
