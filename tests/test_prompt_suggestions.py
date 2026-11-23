import csv
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

from flask import Flask
from requests import ConnectionError

from naim.prompt_suggestions import PromptSuggestionCatalog
from naim.web import prompt_suggestions
from naim.web.prompt_suggestions import register_prompt_suggestion_routes


CSV_FILES = (
    'action.csv', 'artist.csv', 'attire.csv', 'character.csv', 'count.csv',
    'expression.csv', 'feature.csv', 'meme.csv', 'meta.csv', 'object.csv',
    'other.csv', 'series.csv', 'setting.csv', 'style.csv',
)


class PromptSuggestionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self._write_data(
            {
                'same': '같음',
                'same_tag': '같은 태그',
                'long_hair': '긴 머리',
                'other': 'label same',
            },
            {
                'action.csv': [('same', 1), ('same_tag', 2), ('same_b', 50), ('same_a', 50)],
                'artist.csv': [('same_tag', 10), ('same_tag_extra', 100)],
                'other.csv': [('x_same_x', 900), ('other', 800)],
                'count.csv': [('long_hair', 40)],
            },
        )
        self.app = Flask(__name__)
        self.app.config['TESTING'] = True
        self.import_path = self.root / 'prompt-tags.csv.local'
        register_prompt_suggestion_routes(self.app, self.root, self.import_path)
        self.client = self.app.test_client()

    def _write_data(self, translations=None, contents=None):
        translations = translations or {}
        contents = contents or {}
        (self.root / 'ko.json').write_text(
            json.dumps(translations, ensure_ascii=False), encoding='utf-8'
        )
        for filename in CSV_FILES:
            with (self.root / filename).open(
                    'w', encoding='utf-8', newline='') as stream:
                writer = csv.writer(stream)
                writer.writerow(['tag', 'count'])
                writer.writerows(contents.get(filename, []))

    def test_exact_prefix_substring_and_frequency_order(self):
        response = self.client.get('/api/prompt-tags/suggest?q=same&limit=10')
        self.assertEqual(response.status_code, 200)
        items = response.json['items']
        self.assertEqual([item['tag'] for item in items], [
            'same', 'same_tag_extra', 'same_a', 'same_b', 'same_tag',
            'x_same_x', 'other',
        ])
        self.assertEqual(items[0], {'tag': 'same', 'ko': '같음', 'count': 1})
        self.assertEqual(next(item for item in items if item['tag'] == 'same_tag')['count'], 10)
        self.assertEqual(response.json['status'], 'success')

    def test_english_and_korean_search_normalize_case_underscores_and_spaces(self):
        english = self.client.get('/api/prompt-tags/suggest?q=LONG__HAIR')
        korean = self.client.get('/api/prompt-tags/suggest?q=%20%EA%B8%B4_%EB%A8%B8%EB%A6%AC%20')
        self.assertEqual(english.json['items'][0]['tag'], 'long_hair')
        self.assertEqual(korean.json['items'][0]['tag'], 'long_hair')
        self.assertEqual(korean.json['items'][0]['ko'], '긴 머리')

    def test_blank_query_is_empty_and_limits_are_bounded(self):
        blank = self.client.get('/api/prompt-tags/suggest?q=%20%20')
        self.assertEqual(blank.status_code, 200)
        self.assertEqual(blank.json, {'status': 'success', 'items': []})
        normalized_blank = self.client.get('/api/prompt-tags/suggest?q=___')
        self.assertEqual(normalized_blank.status_code, 200)
        self.assertEqual(normalized_blank.json, {'status': 'success', 'items': []})

        self._write_data({}, {'count.csv': [(f'tag_{index:02}', index) for index in range(35)]})
        default = self.client.get('/api/prompt-tags/suggest?q=tag')
        capped = self.client.get('/api/prompt-tags/suggest?q=tag&limit=30')
        self.assertEqual(len(default.json['items']), 12)
        self.assertEqual(len(capped.json['items']), 30)

        for query in ('q=' + ('x' * 101), 'q=tag&limit=0', 'q=tag&limit=31', 'q=tag&limit=nope'):
            response = self.client.get('/api/prompt-tags/suggest?' + query)
            self.assertEqual(response.status_code, 400, query)

    def test_empty_count_is_zero_and_keeps_the_tag(self):
        self._write_data({'self_harm': '자해'}, {
            'action.csv': [('self_harm', '')],
        })
        response = self.client.get('/api/prompt-tags/suggest?q=self_harm')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json['items'], [
            {'tag': 'self_harm', 'ko': '자해', 'count': 0},
        ])

    def test_missing_or_corrupt_data_returns_generic_503(self):
        (self.root / 'style.csv').unlink()
        missing = self.client.get('/api/prompt-tags/suggest?q=tag')
        self.assertEqual(missing.status_code, 503)
        self.assertEqual(missing.json['status'], 'error')
        self.assertNotIn(str(self.root), missing.json['message'])

        (self.root / 'style.csv').write_text('tag,count\n', encoding='utf-8')
        (self.root / 'ko.json').write_text('{', encoding='utf-8')
        corrupt = self.client.get('/api/prompt-tags/suggest?q=tag')
        self.assertEqual(corrupt.status_code, 503)
        self.assertNotIn(str(self.root), corrupt.json['message'])

    def test_first_load_is_shared_across_concurrent_searches(self):
        catalog = PromptSuggestionCatalog(self.root)
        barrier = threading.Barrier(8)
        original_loader = catalog._load_entries
        with mock.patch.object(catalog, '_load_entries', wraps=original_loader) as loader:
            def search(_):
                barrier.wait()
                return catalog.suggest('same')

            with ThreadPoolExecutor(max_workers=8) as executor:
                results = list(executor.map(search, range(8)))
            self.assertEqual(loader.call_count, 1)
            self.assertTrue(all(result == results[0] for result in results))
            catalog.suggest('long')
            self.assertEqual(loader.call_count, 1)

    def _import_csv(self, rows):
        stream = io.StringIO(newline='')
        csv.writer(stream).writerows(rows)
        return self.client.post('/api/prompt-tags/import',
                                data=stream.getvalue().encode('utf-8-sig'),
                                content_type='application/octet-stream')

    def test_import_adds_korean_aliases_to_builtin_and_new_tags_and_persists(self):
        route = '/api/prompt-tags/import'
        self.assertFalse(self.client.get(route).json['imported'])
        self.assertEqual(self.client.get('/api/prompt-tags/suggest?q=장발').json['items'], [])
        response = self._import_csv([
            ('long hair', 0, 300, '[머리] 설명, 쉼표. <키워드> 장발, 아주 긴 머리.'),
            ('synthetic hero', 4, 15, '[인물] 설명. <키워드> 가상 영웅, 합성 인물.'),
        ])
        self.assertEqual(response.json, {'status': 'success', 'count': 2})
        self.assertTrue(self.client.get(route).json['imported'])
        builtin = self.client.get('/api/prompt-tags/suggest?q=장발').json['items']
        self.assertEqual(builtin, [{'tag': 'long_hair', 'ko': '긴 머리', 'count': 40}])
        restarted = PromptSuggestionCatalog(self.root, self.import_path)
        self.assertEqual(restarted.suggest('합성 인물'), [
            {'tag': 'synthetic hero', 'ko': '가상 영웅', 'count': 15},
        ])

    def test_import_errors_keep_the_saved_csv_and_current_suggestions(self):
        self.assertEqual(self._import_csv([('old', 0, 1, '<키워드> 이전.')]).status_code, 200)
        saved = self.import_path.read_bytes()
        self.assertEqual(self._import_csv([('invalid', 0, 'bad count', '')]).status_code, 400)
        with self.assertLogs(self.app.logger, level='WARNING'), mock.patch(
                'naim.prompt_suggestions.os.replace', side_effect=OSError):
            self.assertEqual(self._import_csv([('new', 0, 1, '<키워드> 신규.')]).status_code, 503)
        self.assertEqual(self.import_path.read_bytes(), saved)
        self.assertEqual(self.client.get('/api/prompt-tags/suggest?q=이전').json['items'][0]['tag'], 'old')
        self.assertEqual(self.client.get('/api/prompt-tags/suggest?q=신규').json['items'], [])
        self.assertEqual(self._import_csv([('new', 0, 1, '<키워드> 신규.')]).status_code, 200)
        self.assertEqual(self.client.get('/api/prompt-tags/suggest?q=이전').json['items'], [])

    def test_download_verifies_the_fixed_source_and_applies_without_an_upload(self):
        payload = 'downloaded,0,2,<키워드> 내려받음.'.encode()
        with mock.patch.object(prompt_suggestions, '_CSV_BYTES', len(payload)), mock.patch.object(
                prompt_suggestions, '_CSV_SHA256', hashlib.sha256(payload).hexdigest()), mock.patch.object(
                prompt_suggestions, 'public_session') as session:
            get = session.return_value.__enter__.return_value.get
            response = get.return_value.__enter__.return_value
            response.iter_content.return_value = [payload[:7], payload[7:]]

            self.assertEqual(self.client.post('/api/prompt-tags/download').status_code, 415)
            get.assert_not_called()
            reply = self.client.post('/api/prompt-tags/download', json={})
            self.assertEqual(reply.json, {'status': 'success', 'count': 1})
            get.assert_called_once_with(prompt_suggestions._CSV_URL, stream=True, timeout=(8, 20))
            self.assertEqual(self.import_path.read_bytes(), payload)
            self.assertTrue(self.client.get('/api/prompt-tags/import').json['imported'])
            self.assertEqual(self.client.get('/api/prompt-tags/suggest?q=내려받음').json['items'][0]['tag'], 'downloaded')

            for bad_payload in (payload[:-1], payload + b'extra', b'x' * len(payload)):
                with self.subTest(length=len(bad_payload)):
                    response.iter_content.return_value = [bad_payload]
                    self.assertEqual(self.client.post('/api/prompt-tags/download', json={}).status_code, 502)
                    self.assertEqual(self.import_path.read_bytes(), payload)
            get.side_effect = ConnectionError
            self.assertEqual(self.client.post('/api/prompt-tags/download', json={}).status_code, 502)
            self.assertEqual(self.import_path.read_bytes(), payload)

    def test_download_serializes_csv_updates_across_tabs(self):
        started = threading.Event()
        finish = threading.Event()

        def slow_download():
            started.set()
            if not finish.wait(3):
                raise AssertionError('download was not released')
            return 'new,0,1,<키워드> 신규.'.encode()

        with mock.patch.object(prompt_suggestions, '_download_prompt_tag_csv', side_effect=slow_download) as download:
            with ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(self.app.test_client().post, '/api/prompt-tags/download', json={})
                try:
                    self.assertTrue(started.wait(3))
                    self.assertEqual(self.client.post('/api/prompt-tags/download', json={}).status_code, 409)
                    self.assertEqual(self._import_csv([('old', 0, 1, '<키워드> 이전.')]).status_code, 409)
                    download.assert_called_once()
                finally:
                    finish.set()
                self.assertEqual(future.result(timeout=3).status_code, 200)

    def test_keywordless_import_keeps_previous_file_and_mixed_catalog_remains_searchable(self):
        response = self._import_csv([('ink', 0, 1, '<키워드> 잉크'), ('art paper', 0, 2, '')])
        self.assertEqual(response.json['count'], 2)
        saved = self.import_path.read_bytes()
        response = self._import_csv([('unused', 0, 1, 'English description'), ('empty', 0, 1, '<키워드> ...')])
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.import_path.read_bytes(), saved)
        self.assertEqual(self.client.get('/api/prompt-tags/suggest?q=잉크').json['items'][0]['tag'], 'ink')
        self.assertEqual(self.client.get('/api/prompt-tags/suggest?q=art_paper').json['items'][0]['tag'], 'art paper')

    def test_import_status_and_search_share_validation_after_external_file_changes(self):
        from naim.prompt_suggestions import _parse_import
        route = '/api/prompt-tags/import'
        self.assertFalse(self.client.get(route).json['imported'])
        self.import_path.write_text('broken', encoding='utf-8')
        with mock.patch('naim.prompt_suggestions._parse_import', wraps=_parse_import) as parse:
            with self.assertLogs('naim.prompt_suggestions', level='WARNING'):
                status = self.client.get(route).json
            self.assertFalse(status['imported'])
            self.assertEqual(status['import_state'], 'invalid')
            self.assertEqual(self.client.get(route).json, status)
            self.assertEqual(self.client.get('/api/prompt-tags/suggest?q=긴_머리').json['items'][0]['tag'], 'long_hair')
            self.assertEqual(parse.call_count, 1)
            self.import_path.write_text('ink,0,1,<키워드> 잉크', encoding='utf-8')
            self.assertEqual(self.client.get('/api/prompt-tags/suggest?q=잉크').json['items'][0]['tag'], 'ink')
            self.assertTrue(self.client.get(route).json['imported'])
            self.assertEqual(parse.call_count, 2)
            self.import_path.unlink()
            self.assertEqual(self.client.get(route).json['import_state'], 'missing')
            self.assertEqual(self.client.get('/api/prompt-tags/suggest?q=잉크').json['items'], [])

    def test_keywordless_duplicate_preserves_search_words_and_the_highest_count(self):
        rows = [('ink', 0, 1, '<키워드> 잉크'), ('INK', 0, 3, '')]
        for ordered in (rows, rows[::-1]):
            self.assertEqual(self._import_csv(ordered).json.get('count'), 1)
            self.assertEqual(self.client.get('/api/prompt-tags/suggest?q=잉크').json['items'],
                             [{'tag': 'INK', 'ko': '잉크', 'count': 3}])


if __name__ == '__main__':
    unittest.main()
