"""Saved NovelAI credentials and a bounded, cached subscription lookup."""
from copy import deepcopy
import json
import threading
import time
import urllib.error
import urllib.request

from naim.storage.json_files import merge_json_object, read_json


SUBSCRIPTION_URL = 'https://image.novelai.net/user/subscription'
MAX_RESPONSE_BYTES = 1024 * 1024
CACHE_SECONDS = 60
ERROR_CACHE_SECONDS = 10


class AccountLookupError(Exception):
    """A safe message that never contains a remote body or credential."""


def _integer(value, *, nonnegative=False):
    if type(value) is not int or (nonnegative and value < 0):
        return None
    return value


def parse_subscription(data):
    """Keep absent or malformed balances unknown instead of inventing zero."""
    if not isinstance(data, dict):
        raise AccountLookupError('NovelAI 계정 응답 형식을 확인할 수 없습니다.')
    result = {'anlas': None, 'usage': None, 'subscription_active': None}
    training = data.get('trainingStepsLeft')
    if isinstance(training, dict):
        fixed = _integer(training.get('fixedTrainingStepsLeft'), nonnegative=True)
        purchased = _integer(training.get('purchasedTrainingSteps'), nonnegative=True)
        if fixed is not None and purchased is not None:
            result['anlas'] = fixed + purchased
    usage = data.get('usage')
    if isinstance(usage, dict):
        percent = _integer(usage.get('percent'))
        negative = usage.get('isNegative')
        if percent is not None and isinstance(negative, bool):
            result['usage'] = {
                'percent': percent,
                'is_negative': negative,
                'seconds_until_next_percent': _integer(usage.get('timeUntilNextPercent'), nonnegative=True),
            }
    if isinstance(data.get('active'), bool):
        result['subscription_active'] = data['active']
    return result


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def fetch_subscription(api_key):
    """Read account status only; credentials cannot follow a redirect."""
    request = urllib.request.Request(
        SUBSCRIPTION_URL,
        headers={'Authorization': 'Bearer ' + api_key, 'Accept': 'application/json',
                 'User-Agent': 'Mozilla/5.0'},
        method='GET',
    )
    try:
        with urllib.request.build_opener(_NoRedirect()).open(request, timeout=10) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        code = error.code
        error.close()
        if code in (401, 403):
            message = 'NovelAI 키 인증에 실패했습니다. 설정에서 키를 확인해 주세요.'
        elif code == 429:
            message = 'NovelAI 조회 요청이 많습니다. 잠시 후 새로고침해 주세요.'
        else:
            message = f'NovelAI 계정 조회에 실패했습니다. (HTTP {code})'
        raise AccountLookupError(message) from None
    except (OSError, urllib.error.URLError, ValueError, UnicodeError):
        raise AccountLookupError('NovelAI 계정에 연결하지 못했습니다. 잠시 후 새로고침해 주세요.') from None
    if len(raw) > MAX_RESPONSE_BYTES:
        raise AccountLookupError('NovelAI 계정 응답이 너무 큽니다.')
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeError):
        raise AccountLookupError('NovelAI 계정 응답 형식을 확인할 수 없습니다.') from None
    return parse_subscription(data)


def _key_status(key):
    hint = (key[:4] + '…' + key[-4:]) if len(key) > 12 else ('••••••••' if key else '')
    return {'configured': bool(key), 'key_hint': hint}


class NovelAIAccount:
    """Coalesce lookups and discard a result if its saved key has changed."""
    def __init__(self, config_path_provider, fetcher=None):
        self.config_path_provider = config_path_provider
        self.fetcher = fetcher or fetch_subscription
        self._condition = threading.Condition(threading.RLock())
        self._key = None
        self._revision = 0
        self._cache = None
        self._cache_until = 0
        self._inflight = set()

    def _read_key(self):
        value = read_json(self.config_path_provider(), expected_type=dict).get('key')
        return value.strip() if isinstance(value, str) else ''

    def _synchronize_key(self, key):
        if key != self._key:
            self._key = key
            self._revision += 1
            self._cache = None
            self._cache_until = 0
            self._condition.notify_all()

    def set_key(self, value):
        if not isinstance(value, str):
            raise ValueError('NovelAI 키는 문자열이어야 합니다.')
        key = value.strip()
        if len(key) > 4096 or any(ord(char) < 33 or ord(char) > 126 for char in key):
            raise ValueError('NovelAI 키 형식을 확인해 주세요. 키에 공백이나 줄바꿈을 넣을 수 없습니다.')
        with self._condition:
            merge_json_object(self.config_path_provider(), {'key': key})
            # A save also permits retrying the same key after an authentication error.
            self._key = key
            self._revision += 1
            self._cache = None
            self._cache_until = 0
            self._condition.notify_all()
            return _key_status(key)

    def get(self, refresh=False):
        while True:
            with self._condition:
                key = self._read_key()
                self._synchronize_key(key)
                base = {**_key_status(key), 'anlas': None, 'usage': None,
                        'subscription_active': None, 'checked_at': None,
                        'status': 'unconfigured', 'message': '설정에서 NovelAI 키를 등록해 주세요.'}
                if not key:
                    return base
                if self._cache is not None and not refresh and time.monotonic() < self._cache_until:
                    return deepcopy(self._cache)
                ticket = (key, self._revision)
                if ticket in self._inflight:
                    self._condition.wait()
                    # A concurrently requested refresh satisfies this request too.
                    refresh = False
                    continue
                self._inflight.add(ticket)
            try:
                summary = self.fetcher(key)
                result = {**base, **summary, 'status': 'ok', 'message': ''}
            except AccountLookupError as error:
                result = {**base, 'status': 'error', 'message': str(error)}
            except Exception:
                # Third-party exception messages may echo an Authorization header.
                result = {**base, 'status': 'error', 'message': 'NovelAI 계정 정보를 조회하지 못했습니다.'}
            result['checked_at'] = time.time()
            with self._condition:
                self._inflight.discard(ticket)
                self._condition.notify_all()
                self._synchronize_key(self._read_key())
                if ticket != (self._key, self._revision):
                    refresh = False
                    continue
                self._cache = result
                ttl = CACHE_SECONDS if result['status'] == 'ok' else ERROR_CACHE_SECONDS
                self._cache_until = time.monotonic() + ttl
                return deepcopy(result)
