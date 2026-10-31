"""Safe, shared schema for portable tag-dictionary image packs."""

import re


FORMAT = 'naim-dictionary-image-pack'
VERSION = 1
MANIFEST = 'dictionary-image-pack.json'
ARCHIVE = 'dictionary-images-webp-q90-v1.zip'
INDEX = 'index.json'

MAX_IMAGES = 100_000
MAX_ARCHIVE_BYTES = 2 * 1024 ** 3
MAX_IMAGE_BYTES = 32 * 1024 ** 2
MAX_INDEX_BYTES = 16 * 1024 ** 2
MAX_EXPANDED_BYTES = 4 * 1024 ** 3
MAX_IMAGE_PIXELS = 100_000_000
MAX_DIMENSION = 16_383
MAX_SAFE_INTEGER = 2 ** 53 - 1

_HASH = re.compile(r'[0-9a-f]{64}')


def _fail(message):
    raise ValueError(message)


def _exact_fields(value, fields, message):
    if not isinstance(value, dict) or set(value) != set(fields):
        _fail(message)


def _integer(value, minimum, maximum, message):
    if type(value) is not int or not minimum <= value <= maximum:
        _fail(message)
    return value


def _digest(value, message):
    if not isinstance(value, str) or not _HASH.fullmatch(value):
        _fail(message)
    return value


def validate_manifest(document):
    """Return a copied manifest containing only the supported public fields."""
    fields = ('format', 'version', 'filename', 'bytes', 'sha256', 'image_count',
              'image_bytes', 'index_sha256', 'quality')
    _exact_fields(document, fields, '태그 사전 이미지팩 설명 형식이 올바르지 않습니다.')
    if document['format'] != FORMAT or type(document['version']) is not int or document['version'] != VERSION:
        _fail('태그 사전 이미지팩 형식 또는 버전이 지원되지 않습니다.')
    if document['filename'] != ARCHIVE:
        _fail('태그 사전 이미지팩 파일명이 올바르지 않습니다.')
    _integer(document['bytes'], 1, MAX_ARCHIVE_BYTES,
             '태그 사전 이미지팩 크기가 허용 범위를 벗어났습니다.')
    _digest(document['sha256'], '태그 사전 이미지팩 SHA-256 정보가 올바르지 않습니다.')
    _integer(document['image_count'], 1, MAX_IMAGES,
             '태그 사전 이미지 수가 허용 범위를 벗어났습니다.')
    image_bytes = _integer(document['image_bytes'], 1, MAX_EXPANDED_BYTES,
                           '태그 사전 그림 용량이 허용 범위를 벗어났습니다.')
    if image_bytes > document['image_count'] * MAX_IMAGE_BYTES:
        _fail('태그 사전 그림 용량이 이미지 수와 일치하지 않습니다.')
    _digest(document['index_sha256'], '태그 사전 색인 SHA-256 정보가 올바르지 않습니다.')
    if type(document['quality']) is not int or document['quality'] != 90:
        _fail('태그 사전 이미지 품질 설정이 지원되지 않습니다.')
    return {key: document[key] for key in fields}


def validate_index(document):
    """Validate and copy index entries without normalizing untrusted paths."""
    _exact_fields(document, ('format', 'version', 'images'),
                  '태그 사전 이미지 색인 형식이 올바르지 않습니다.')
    if document['format'] != FORMAT or type(document['version']) is not int or document['version'] != VERSION:
        _fail('태그 사전 이미지 색인 형식 또는 버전이 지원되지 않습니다.')
    images = document['images']
    if not isinstance(images, list) or not 1 <= len(images) <= MAX_IMAGES:
        _fail('태그 사전 이미지 색인 수가 허용 범위를 벗어났습니다.')

    result = []
    seen_ids, seen_files = set(), set()
    total_bytes = 0
    fields = ('id', 'file', 'bytes', 'sha256', 'width', 'height')
    for raw in images:
        _exact_fields(raw, fields, '태그 사전 이미지 정보 형식이 올바르지 않습니다.')
        identifier = _integer(raw['id'], 1, MAX_SAFE_INTEGER,
                              '태그 사전 이미지 ID가 올바르지 않습니다.')
        filename = 'images/' + str(identifier).zfill(6) + '.webp'
        if raw['file'] != filename or identifier in seen_ids or raw['file'] in seen_files:
            _fail('태그 사전 이미지 파일 경로 또는 ID가 올바르지 않습니다.')
        size = _integer(raw['bytes'], 1, MAX_IMAGE_BYTES,
                        '태그 사전 이미지 크기가 허용 범위를 벗어났습니다.')
        digest = _digest(raw['sha256'], '태그 사전 이미지 SHA-256 정보가 올바르지 않습니다.')
        width = _integer(raw['width'], 1, MAX_DIMENSION,
                         '태그 사전 이미지 너비가 허용 범위를 벗어났습니다.')
        height = _integer(raw['height'], 1, MAX_DIMENSION,
                          '태그 사전 이미지 높이가 허용 범위를 벗어났습니다.')
        if width * height > MAX_IMAGE_PIXELS:
            _fail('태그 사전 이미지 픽셀 수가 허용 범위를 벗어났습니다.')
        total_bytes += size
        if total_bytes > MAX_EXPANDED_BYTES:
            _fail('태그 사전 이미지 전체 용량이 허용 범위를 벗어났습니다.')
        seen_ids.add(identifier)
        seen_files.add(raw['file'])
        result.append({key: raw[key] for key in fields})
    return result
