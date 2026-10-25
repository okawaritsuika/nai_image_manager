"""Immutable tournament histories reconstructed from their recorded choices."""
from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
import re
from urllib.parse import quote

from naim.paths import path_identity_key
from naim.daki_image_refs import parse_daki_image_reference
from naim.storage.daki_projects import DakiNotFoundError, normalize_relative_path
from naim.storage.json_files import json_lock, write_json


_RECORD_ID = re.compile(r'^[a-f0-9]{32}$')
_MAX_PARTICIPANTS = 10000


class DakiWorldCupConflict(ValueError):
    pass


def _text(value, label, limit, *, required=True):
    if (not isinstance(value, str) or len(value) > limit or '\x00' in value
            or required and not value.strip()):
        raise ValueError(f'{label} 내용을 확인해 주세요.')
    return value.strip()


def _identifier(value):
    if not isinstance(value, str) or not _RECORD_ID.fullmatch(value):
        raise ValueError('월드컵 기록 ID가 올바르지 않습니다.')
    return value


def _image_path(value):
    value = _text(value, '참가 그림 경로', 4000)
    path = normalize_relative_path(value)
    parse_daki_image_reference(path)
    if Path(path).suffix.lower() not in ('.png', '.jpg', '.jpeg', '.webp'):
        raise ValueError('PNG, JPEG, WebP 그림의 상대 경로를 사용해 주세요.')
    return path


def _request(data):
    if not isinstance(data, dict):
        raise ValueError('월드컵 기록은 JSON 객체여야 합니다.')
    identifier = _identifier(data.get('id'))
    tag = data.get('tag')
    if not isinstance(tag, dict):
        raise ValueError('참가 태그를 확인해 주세요.')
    tag = {'id': _text(tag.get('id'), '참가 태그 ID', 200),
           'label': _text(tag.get('label'), '참가 태그 이름', 500)}
    if tag['id'] == 'NONE':
        raise ValueError('참가할 태그를 선택해 주세요.')
    participants = data.get('participants')
    if not isinstance(participants, list) or not 2 <= len(participants) <= _MAX_PARTICIPANTS:
        raise ValueError('월드컵 참가 그림은 2~10000장이어야 합니다.')
    normalized = []
    seen = set()
    for participant in participants:
        if not isinstance(participant, dict):
            raise ValueError('참가 그림 정보를 확인해 주세요.')
        path = _image_path(participant.get('path'))
        if path in seen:
            raise ValueError('같은 그림은 한 번만 참가할 수 있습니다.')
        seen.add(path)
        normalized.append({'path': path, 'name': _text(participant.get('name'), '참가 그림 이름', 1000)})
    choices = data.get('choices')
    if not isinstance(choices, list) or len(choices) != len(normalized) - 1:
        raise ValueError('모든 대결을 완료한 월드컵만 저장할 수 있습니다.')
    choices = [_image_path(choice) for choice in choices]
    replay = data.get('replay_of')
    if replay is not None:
        replay = _identifier(replay)
        if replay == identifier:
            raise ValueError('재대회는 이전 기록과 다른 ID로 저장해 주세요.')
    return {'id': identifier, 'title': _text(data.get('title'), '월드컵 이름', 240),
            'gallery_key': _text(data.get('gallery_key'), '갤러리 정보', 200),
            'tag': tag, 'participants': normalized, 'choices': choices, 'replay_of': replay}


def _result(request, created_at):
    """Replay paired rounds; the last odd participant advances without a win."""
    initial = request['participants']
    records = {entry['path']: {**entry, 'src': '/image/' + quote(entry['path'], safe='/'),
                               'rank': None, 'wins': 0} for entry in initial}
    round_paths = [entry['path'] for entry in initial]
    choice_index = 0
    while len(round_paths) > 1:
        winners = []
        losing_rank = (len(round_paths) + 1) // 2 + 1
        for index in range(0, len(round_paths) - 1, 2):
            pair = round_paths[index:index + 2]
            choice = request['choices'][choice_index]
            choice_index += 1
            if choice not in pair:
                raise ValueError('선택 기록이 실제 월드컵 대진과 일치하지 않습니다.')
            loser = pair[1] if choice == pair[0] else pair[0]
            records[loser]['rank'] = losing_rank
            records[choice]['wins'] += 1
            winners.append(choice)
        if len(round_paths) % 2:
            winners.append(round_paths[-1])
        round_paths = winners
    winner = records[round_paths[0]]
    winner['rank'] = 1
    participants = sorted(records.values(), key=lambda entry: entry['rank'])
    return {**{key: deepcopy(request[key]) for key in ('id', 'title', 'gallery_key', 'tag', 'choices', 'replay_of')},
            'created_at': created_at, 'total': len(initial), 'participants': participants,
            'initial_participants': deepcopy(initial),
            'winner': {key: winner[key] for key in ('path', 'name', 'src', 'rank')}}


class DakiWorldCups:
    def __init__(self, root_provider):
        self.root_provider = root_provider

    def _root(self):
        value = self.root_provider() if callable(self.root_provider) else self.root_provider
        return Path(value).resolve()

    @staticmethod
    def _path(root, identifier):
        path = root / (_identifier(identifier) + '.json')
        if path_identity_key(path.resolve().parent) != path_identity_key(root):
            raise ValueError('월드컵 기록의 저장 위치가 올바르지 않습니다.')
        return path

    @staticmethod
    def _read(path):
        try:
            with path.open(encoding='utf-8') as stream:
                document = json.load(stream)
        except FileNotFoundError as error:
            raise DakiNotFoundError('월드컵 기록을 찾을 수 없습니다.') from error
        except (UnicodeError, json.JSONDecodeError) as error:
            raise ValueError('저장된 월드컵 기록을 읽을 수 없습니다.') from error
        if not isinstance(document, dict) or document.get('version') != 1:
            raise ValueError('저장된 월드컵 기록의 형식이 올바르지 않습니다.')
        request = _request(document.get('request'))
        created_at = document.get('created_at')
        if request['id'] != path.stem or not isinstance(created_at, str):
            raise ValueError('저장된 월드컵 기록의 형식이 올바르지 않습니다.')
        try:
            parsed = datetime.fromisoformat(created_at)
            if parsed.utcoffset() is None:
                raise ValueError('missing timezone')
        except ValueError as error:
            raise ValueError('저장된 월드컵 기록의 날짜를 확인해 주세요.') from error
        return request, _result(request, created_at)

    def create(self, data):
        request = _request(data)
        created_at = datetime.now(timezone.utc).isoformat()
        record = _result(request, created_at)
        path = self._path(self._root(), request['id'])
        with json_lock(path):
            if path.exists():
                previous, saved = self._read(path)
                if previous != request:
                    raise DakiWorldCupConflict('같은 ID의 월드컵 기록이 이미 다른 내용으로 저장되어 있습니다.')
                return saved
            path.parent.mkdir(parents=True, exist_ok=True)
            write_json(path, {'version': 1, 'created_at': created_at, 'request': request}, indent=2)
        return record

    def get(self, identifier):
        path = self._path(self._root(), identifier)
        with json_lock(path):
            return self._read(path)[1]

    def list_records(self, gallery_key=None):
        if gallery_key is not None:
            gallery_key = _text(gallery_key, '갤러리 정보', 200)
        root = self._root()
        summaries = []
        if not root.exists():
            return summaries
        for path in root.glob('*.json'):
            if not _RECORD_ID.fullmatch(path.stem):
                continue
            record = self.get(path.stem)
            if gallery_key is None or record['gallery_key'] == gallery_key:
                summaries.append({key: record[key] for key in
                                  ('id', 'title', 'gallery_key', 'tag', 'created_at', 'total', 'winner', 'replay_of')})
        return sorted(summaries, key=lambda record: (record['created_at'], record['id']), reverse=True)
