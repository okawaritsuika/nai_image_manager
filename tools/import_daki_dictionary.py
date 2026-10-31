"""Copy an offline dictionary into NAIM without changing the source installation.

Parquet support is needed only for this one-time import, never at app runtime.
Image files stay in the connected folder; SQLite backup preserves their IDs.
"""
import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import tempfile


def parquet_rows(path):
    import pyarrow.parquet as pq
    return pq.read_table(path, columns=['id', 'general', 'rating']).to_pylist()


def import_dictionary(source, destination, *, read_rows=parquet_rows):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if not destination.is_dir():
        raise ValueError('대상 프로그램 폴더를 먼저 준비해 주세요.')
    assets = destination / 'data' / 'daki_dictionary'
    user_data = destination / 'daki_dictionary_user'
    if assets.exists() or user_data.exists():
        raise ValueError('이미 가져온 사전 또는 사용자 데이터가 있어 덮어쓰지 않았습니다.')
    payload = json.loads((source / 'data' / 'dictionary.json').read_text(encoding='utf-8-sig'))
    tags = payload.get('tags')
    if not isinstance(tags, list) or not tags or any(
        not isinstance(tag, dict) or not isinstance(tag.get('tag'), str) for tag in tags
    ):
        raise ValueError('원본 사전 형식을 확인해 주세요.')
    rows = read_rows(source / 'data' / 'source_combinations.parquet')
    if not isinstance(rows, list) or not rows or any(
        not isinstance(row, dict) or not isinstance(row.get('general'), str)
        or 'id' not in row or 'rating' not in row for row in rows
    ):
        raise ValueError('원본 태그 조합 형식을 확인해 주세요.')
    vocabulary = {tag['tag'] for tag in tags}
    if vocabulary != {tag for row in rows for tag in row['general'].split(', ')}:
        raise ValueError('사전과 원본 조합의 태그가 일치하지 않습니다.')
    # Source metadata may contain personal absolute paths. Only provenance
    # and counts belong in the distributable base dictionary.
    metadata = payload.get('source', {})
    payload['source'] = {key: metadata[key] for key in (
        'sha256', 'translation_note', 'image_linking_enabled'
    ) if key in metadata}
    payload['source'].update(rows=len(rows), unique_tags=len(vocabulary))
    edits = source / 'data' / 'user_edits.json'
    if edits.is_file() and not isinstance(json.loads(edits.read_text(encoding='utf-8-sig')), dict):
        raise ValueError('원본 사용자 편집 파일 형식을 확인해 주세요.')
    image_count = 0
    with tempfile.TemporaryDirectory(prefix='.dictionary-import-', dir=destination) as temporary:
        stage = Path(temporary)
        base_stage, user_stage = stage / 'base', stage / 'user'
        base_stage.mkdir()
        user_stage.mkdir()
        (base_stage / 'dictionary.json').write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
        (base_stage / 'source_combinations.json').write_text(
            json.dumps(rows, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        if edits.is_file():
            (user_stage / 'user_edits.json').write_bytes(edits.read_bytes())
        database = source / 'data' / 'image_catalog.sqlite3'
        if database.is_file():
            with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as original:
                with closing(sqlite3.connect(user_stage / database.name)) as copied:
                    original.backup(copied)
                    if copied.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                        raise ValueError('원본 이미지 연결 정보를 확인해 주세요.')
                    image_count = copied.execute('SELECT COUNT(*) FROM images').fetchone()[0]
        assets.parent.mkdir(parents=True, exist_ok=True)
        # Both targets are new. No replacement of an existing user installation.
        if assets.exists() or user_data.exists():
            raise ValueError('가져오기 도중 대상이 생성되어 중단했습니다.')
        os.rename(base_stage, assets)
        os.rename(user_stage, user_data)
    return {'tags': len(tags), 'combinations': len(rows), 'indexed_images': image_count}


def main():
    parser = argparse.ArgumentParser(description='태그 사전과 이미지 연결을 새 NAIM 저장소로 복사')
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--destination', default=Path(__file__).resolve().parents[1], type=Path)
    args = parser.parse_args()
    print(json.dumps(import_dictionary(args.source, args.destination), ensure_ascii=False))


if __name__ == '__main__':
    main()
