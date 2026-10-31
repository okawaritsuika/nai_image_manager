import csv
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

from flask import Flask

from naim.prompt_suggestions import PromptSuggestionCatalog
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
        register_prompt_suggestion_routes(self.app, self.root)
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


if __name__ == '__main__':
    unittest.main()
