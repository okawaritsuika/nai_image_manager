import io
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock
import urllib.error

from flask import Flask

from naim.novelai_account import (
    AccountLookupError, MAX_RESPONSE_BYTES, NovelAIAccount, SUBSCRIPTION_URL,
    _NoRedirect, fetch_subscription, parse_subscription,
)
from naim.storage.json_files import merge_json_object, read_json, write_json
from naim.web.novelai_account import register_novelai_account_routes


def subscription(anlas=1200, percent=82):
    return {'trainingStepsLeft': {'fixedTrainingStepsLeft': anlas, 'purchasedTrainingSteps': 0},
            'usage': {'percent': percent, 'isNegative': False, 'timeUntilNextPercent': 3600},
            'active': True}


class SubscriptionParsingTests(unittest.TestCase):
    def test_balances_and_remaining_quota(self):
        data = subscription()
        data['trainingStepsLeft']['purchasedTrainingSteps'] = 50
        self.assertEqual(parse_subscription(data), {
            'anlas': 1250, 'usage': {'percent': 82, 'is_negative': False,
                                   'seconds_until_next_percent': 3600},
            'subscription_active': True,
        })

    def test_zero_and_negative_quota_are_not_missing(self):
        data = subscription(0, 0)
        data['usage']['isNegative'] = True
        data['usage']['timeUntilNextPercent'] = 0
        data['active'] = False
        result = parse_subscription(data)
        self.assertEqual(result['anlas'], 0)
        self.assertEqual(result['usage'], {'percent': 0, 'is_negative': True,
                                           'seconds_until_next_percent': 0})
        self.assertIs(result['subscription_active'], False)

    def test_absent_and_malformed_fields_stay_unknown(self):
        unknown = {'anlas': None, 'usage': None, 'subscription_active': None}
        for value in ({}, {'trainingStepsLeft': {}, 'usage': {}},
                      {'trainingStepsLeft': {'fixedTrainingStepsLeft': 5},
                       'usage': {'percent': 3}, 'active': 'false'},
                      {'trainingStepsLeft': {'fixedTrainingStepsLeft': True, 'purchasedTrainingSteps': 0},
                       'usage': {'percent': '20', 'isNegative': False}, 'active': 0},
                      {'trainingStepsLeft': {'fixedTrainingStepsLeft': 5, 'purchasedTrainingSteps': -1},
                       'usage': [], 'active': None}):
            with self.subTest(value=value):
                self.assertEqual(parse_subscription(value), unknown)

    def test_missing_or_invalid_recovery_time_does_not_hide_quota(self):
        for value in (None, False, -1, '100'):
            data = subscription()
            data['usage']['timeUntilNextPercent'] = value
            result = parse_subscription(data)
            self.assertEqual(result['usage']['percent'], 82)
            self.assertIsNone(result['usage']['seconds_until_next_percent'])

    def test_non_object_is_invalid(self):
        for data in (None, [], 'private-remote-content'):
            with self.subTest(data=data), self.assertRaises(AccountLookupError):
                parse_subscription(data)


class SubscriptionTransportTests(unittest.TestCase):
    def test_saved_key_only_in_authorization_header(self):
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(subscription()).encode()
        opener = mock.Mock()
        opener.open.return_value = response
        with mock.patch('naim.novelai_account.urllib.request.build_opener', return_value=opener) as build:
            result = fetch_subscription('synthetic-only-secret')
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, SUBSCRIPTION_URL)
        self.assertEqual(request.get_method(), 'GET')
        self.assertIsNone(request.data)
        self.assertEqual(request.get_header('Authorization'), 'Bearer synthetic-only-secret')
        self.assertEqual(opener.open.call_args.kwargs, {'timeout': 10})
        self.assertIsInstance(build.call_args.args[0], _NoRedirect)
        self.assertIsNone(build.call_args.args[0].redirect_request(None, None, None, None, None, None))
        response.__enter__.return_value.read.assert_called_once_with(MAX_RESPONSE_BYTES + 1)
        self.assertEqual(result['anlas'], 1200)

    def test_http_errors_never_include_body_or_exception_text(self):
        for code in (301, 401, 403, 429, 500):
            error = urllib.error.HTTPError(SUBSCRIPTION_URL, code, 'synthetic-private-token', {},
                                          io.BytesIO(b'synthetic-private-body'))
            with self.subTest(code=code), mock.patch(
                    'naim.novelai_account.urllib.request.build_opener') as build:
                build.return_value.open.side_effect = error
                with self.assertRaises(AccountLookupError) as caught:
                    fetch_subscription('synthetic-only-secret')
                self.assertNotIn('synthetic-private', str(caught.exception))
                self.assertNotIn('synthetic-only-secret', str(caught.exception))

    def test_timeout_and_network_errors_are_sanitized(self):
        for error in (TimeoutError('synthetic-private'), urllib.error.URLError('synthetic-private')):
            with self.subTest(error=type(error).__name__), mock.patch(
                    'naim.novelai_account.urllib.request.build_opener') as build:
                build.return_value.open.side_effect = error
                with self.assertRaises(AccountLookupError) as caught:
                    fetch_subscription('synthetic-only-secret')
                self.assertNotIn('synthetic-private', str(caught.exception))

    def test_malformed_and_oversized_responses_are_rejected(self):
        for body in (b'not-json-private', b'[]', b'\xff', b'x' * (MAX_RESPONSE_BYTES + 1)):
            with self.subTest(length=len(body)), mock.patch(
                    'naim.novelai_account.urllib.request.build_opener') as build:
                build.return_value.open.return_value.__enter__.return_value.read.return_value = body
                with self.assertRaises(AccountLookupError) as caught:
                    fetch_subscription('synthetic-only-secret')
                self.assertNotIn('private', str(caught.exception))


class AccountServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'synthetic-config.json'
        write_json(self.path, {'key': 'synthetic-secret-alpha', 'model': 'preserved', 'nested': {'value': 7}})
        self.fetcher = mock.Mock(return_value=parse_subscription(subscription()))
        self.account = NovelAIAccount(lambda: self.path, self.fetcher)

    def test_cache_refresh_expiry_and_result_copy(self):
        with mock.patch('naim.novelai_account.time.monotonic', return_value=100) as clock:
            first = self.account.get()
            first['usage']['percent'] = 1
            self.assertEqual(self.account.get()['usage']['percent'], 82)
            self.assertEqual(self.fetcher.call_count, 1)
            self.account.get(refresh=True)
            self.assertEqual(self.fetcher.call_count, 2)
            clock.return_value = 161
            self.account.get()
            self.assertEqual(self.fetcher.call_count, 3)
        self.assertNotIn('synthetic-secret-alpha', json.dumps(first))
        self.assertIsInstance(first['checked_at'], (float, int))

    def test_key_change_preserves_settings_and_invalidates_cache(self):
        self.account.get()
        status = self.account.set_key('  synthetic-secret-beta  ')
        self.assertEqual(status, {'configured': True, 'key_hint': 'synt…beta'})
        self.assertEqual(read_json(self.path), {
            'key': 'synthetic-secret-beta', 'model': 'preserved', 'nested': {'value': 7}})
        self.account.get()
        self.assertEqual(self.fetcher.call_count, 2)
        self.fetcher.assert_called_with('synthetic-secret-beta')

    def test_external_legacy_key_change_is_detected(self):
        self.account.get()
        merge_json_object(self.path, {'key': 'synthetic-external-key'})
        self.account.get()
        self.fetcher.assert_called_with('synthetic-external-key')
        self.assertEqual(self.fetcher.call_count, 2)

    def test_empty_key_clears_without_network_and_short_key_fully_masked(self):
        self.assertEqual(self.account.set_key('short')['key_hint'], '••••••••')
        self.assertEqual(self.account.set_key(''), {'configured': False, 'key_hint': ''})
        result = self.account.get(refresh=True)
        self.assertEqual(result['status'], 'unconfigured')
        self.assertIsNone(result['anlas'])
        self.assertIsNone(result['checked_at'])
        self.fetcher.assert_not_called()
        self.assertEqual(read_json(self.path)['model'], 'preserved')

    def test_invalid_keys_do_not_change_config(self):
        before = read_json(self.path)
        for value in (None, {}, 123, 'space inside', 'line\nbreak', '한글', 'x' * 4097):
            with self.subTest(kind=type(value).__name__), self.assertRaises(ValueError):
                self.account.set_key(value)
            self.assertEqual(read_json(self.path), before)

    def test_errors_are_safe_unknown_and_briefly_cached(self):
        self.fetcher.side_effect = RuntimeError('synthetic-secret-alpha')
        with mock.patch('naim.novelai_account.time.monotonic', return_value=50) as clock:
            result = self.account.get()
            self.assertEqual(result['status'], 'error')
            self.assertIsNone(result['anlas'])
            self.assertIsNone(result['usage'])
            self.assertNotIn('synthetic-secret-alpha', json.dumps(result))
            self.account.get()
            self.assertEqual(self.fetcher.call_count, 1)
            clock.return_value = 61
            self.account.get()
            self.assertEqual(self.fetcher.call_count, 2)

    def test_concurrent_refreshes_share_one_request(self):
        started, release, waiting = threading.Event(), threading.Event(), threading.Event()

        def fetch(key):
            started.set()
            self.assertTrue(release.wait(5))
            return parse_subscription(subscription())

        self.fetcher.side_effect = fetch
        real_wait = self.account._condition.wait

        def wait(*args):
            waiting.set()
            return real_wait(*args)

        with ThreadPoolExecutor(max_workers=2) as pool, mock.patch.object(
                self.account._condition, 'wait', side_effect=wait):
            first = pool.submit(self.account.get, True)
            try:
                self.assertTrue(started.wait(5))
                second = pool.submit(self.account.get, True)
                self.assertTrue(waiting.wait(5))
            finally:
                release.set()
            self.assertEqual(first.result(timeout=5), second.result(timeout=5))
        self.assertEqual(self.fetcher.call_count, 1)

    def test_old_key_response_is_discarded_while_new_key_loads(self):
        started, release = threading.Event(), threading.Event()

        def fetch(key):
            if key == 'synthetic-secret-alpha':
                started.set()
                self.assertTrue(release.wait(5))
                return parse_subscription(subscription(100))
            return parse_subscription(subscription(900))

        self.fetcher.side_effect = fetch
        with ThreadPoolExecutor(max_workers=1) as pool:
            first = pool.submit(self.account.get)
            try:
                self.assertTrue(started.wait(5))
                self.account.set_key('synthetic-secret-beta')
                self.assertEqual(self.account.get()['anlas'], 900)
            finally:
                release.set()
            result = first.result(timeout=5)
        self.assertEqual(result['anlas'], 900)
        self.assertEqual(result['key_hint'], 'synt…beta')
        self.assertEqual(self.fetcher.call_count, 2)


class AccountRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'synthetic-config.json'
        write_json(self.path, {'key': 'synthetic-secret-alpha', 'preserved': True})
        self.app = Flask(__name__)
        self.account = register_novelai_account_routes(self.app, lambda: self.path)
        self.account.fetcher = mock.Mock(return_value=parse_subscription(subscription()))
        self.client = self.app.test_client()

    def test_status_uses_saved_key_and_never_returns_it(self):
        response = self.client.get('/api/novelai/account?key=ignored-query-key')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json['status'], 'ok')
        self.assertEqual(response.json['anlas'], 1200)
        self.assertNotIn('synthetic-secret-alpha', response.get_data(as_text=True))
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.account.fetcher.assert_called_once_with('synthetic-secret-alpha')
        self.client.get('/api/novelai/account')
        self.client.get('/api/novelai/account?refresh=1')
        self.assertEqual(self.account.fetcher.call_count, 2)

    def test_key_put_returns_only_masked_status_preserving_other_data(self):
        response = self.client.put('/api/novelai/key', json={'key': 'synthetic-secret-beta', 'preserved': False})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, {'configured': True, 'key_hint': 'synt…beta'})
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertEqual(read_json(self.path), {'key': 'synthetic-secret-beta', 'preserved': True})
        self.account.fetcher.assert_not_called()

    def test_invalid_body_and_key_return_safe_errors(self):
        for value in ({}, [], {'key': None}, {'key': 'private\ninvalid'}):
            response = self.client.put('/api/novelai/key', json=value)
            self.assertEqual(response.status_code, 400)
            self.assertNotIn('private', response.get_data(as_text=True))
        self.assertEqual(read_json(self.path)['key'], 'synthetic-secret-alpha')

    def test_file_failures_are_sanitized(self):
        with mock.patch.object(self.account, 'get', side_effect=OSError('private-path-secret')):
            response = self.client.get('/api/novelai/account')
            self.assertEqual(response.status_code, 500)
            self.assertNotIn('private', response.get_data(as_text=True))
        with mock.patch.object(self.account, 'set_key', side_effect=OSError('private-path-secret')):
            response = self.client.put('/api/novelai/key', json={'key': 'synthetic-new-key'})
            self.assertEqual(response.status_code, 500)
            self.assertNotIn('private', response.get_data(as_text=True))


if __name__ == '__main__':
    unittest.main()
