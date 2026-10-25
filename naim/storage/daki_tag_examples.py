"""User-added tag examples link existing images without modifying the dictionary."""
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
import re
import uuid

from PIL import Image

from naim.storage.daki_projects import matching_image_references, normalize_relative_path
from naim.storage.json_files import json_lock, read_json, write_json


class DakiTagExamples:
    def __init__(self, root_provider, resolve_source):
        self.root_provider = root_provider
        self.resolve_source = resolve_source

    def _path(self):
        root = self.root_provider() if callable(self.root_provider) else self.root_provider
        return Path(root) / 'catalog.json'

    @staticmethod
    def _load(path):
        data = read_json(path, lambda: {'examples': []}, expected_type=dict, indent=2)
        if not isinstance(data.get('examples'), list) or any(
                not isinstance(item, dict) or not isinstance(item.get('tag'), str)
                or not isinstance(item.get('id'), str) or not re.fullmatch(r'[a-f0-9]{32}', item['id'])
                or not isinstance(item.get('path'), str) for item in data['examples']):
            raise ValueError('저장된 태그 예시 목록을 확인해 주세요.')
        return data

    def list_examples(self, tag=None):
        path = self._path()
        with json_lock(path):
            return deepcopy([item for item in self._load(path)['examples'] if tag is None or item['tag'] == tag])

    def add(self, tag, path):
        if not isinstance(tag, str) or not tag.strip() or len(tag) > 1000:
            raise ValueError('예시를 추가할 태그를 확인해 주세요.')
        relative = normalize_relative_path(path)
        image_path, actual = self.resolve_source(relative)
        actual = normalize_relative_path(actual)
        image_path = Path(image_path)
        if image_path.suffix.lower() not in {'.png', '.jpg', '.jpeg', '.webp'}:
            raise ValueError('PNG, JPEG, WebP 그림만 예시로 추가할 수 있습니다.')
        if not image_path.is_file():
            raise FileNotFoundError('예시로 추가할 원본 그림이 없습니다.')
        try:
            with Image.open(image_path) as image:
                if image.format not in {'PNG', 'JPEG', 'WEBP'}:
                    raise ValueError('지원하지 않는 이미지 형식입니다.')
                image.verify()
        except (OSError, SyntaxError) as error:
            raise ValueError('예시 그림 파일을 읽을 수 없습니다.') from error
        store_path = self._path()
        with json_lock(store_path):
            data = self._load(store_path)
            existing = matching_image_references((item for item in data['examples'] if item['tag'] == tag),
                [actual], [], normalize_relative_path, self.resolve_source)
            if existing:
                return deepcopy(existing[0])
            example = {'id': uuid.uuid4().hex, 'tag': tag, 'path': actual,
                       'added_at': datetime.now(timezone.utc).isoformat()}
            data['examples'].append(example)
            store_path.parent.mkdir(parents=True, exist_ok=True)
            write_json(store_path, data, indent=2)
            return deepcopy(example)

    def image_path(self, tag, example_id):
        if not isinstance(example_id, str) or not re.fullmatch(r'[a-f0-9]{32}', example_id):
            raise ValueError('태그 예시 번호를 확인해 주세요.')
        example = next((item for item in self.list_examples(tag) if item['id'] == example_id), None)
        if example is None:
            raise KeyError('등록된 태그 예시를 찾을 수 없습니다.')
        path, _ = self.resolve_source(normalize_relative_path(example['path']))
        if Path(path).suffix.lower() not in {'.png', '.jpg', '.jpeg', '.webp'}:
            raise ValueError('태그 예시의 이미지 경로가 올바르지 않습니다.')
        if not Path(path).is_file():
            raise FileNotFoundError('태그 예시의 원본 그림이 없습니다.')
        return Path(path)

    def references(self, paths=None, folders=None):
        references = ({'project_id': item['id'], 'project_name': '태그사전 · ' + item['tag'],
                       'side': '예시 그림', 'path': item['path'], 'tag': item['tag'], 'example_id': item['id']}
                      for item in self.list_examples())
        return matching_image_references(references, paths, folders, normalize_relative_path, self.resolve_source)
