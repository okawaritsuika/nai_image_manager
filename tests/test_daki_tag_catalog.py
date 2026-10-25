import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from flask import Flask
from PIL import Image

from naim.daki_tag_catalog import DakiTagCatalog
from naim.web.daki_tag_catalog import register_daki_tag_catalog_routes
from naim.storage.daki_tag_examples import DakiTagExamples


class DakiTagCatalogTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / 'dictionary'
        (self.source / 'visuals').mkdir(parents=True)
        Image.new('RGB', (8, 8), 'white').save(self.source / 'visuals' / 'sample.png')
        self.tags = [
            {'tag': 'synthetic_hair', 'label_ko': '합성 머리', 'description_ko': '합성 테스트 설명',
             'regions': ['face'], 'sections': ['face.hair'], 'auxiliary': [],
             'comparison_tags': ['synthetic_paint', 'missing'],
             'examples': [{'image': 'visuals/sample.png', 'thumbnail': 'visuals/sample.png', 'relation': 'direct', 'tag': 'synthetic_hair'}],
             'description_references': ['https://example.invalid/source'], 'description_source_license': 'Synthetic test license'},
            {'tag': 'synthetic_paint', 'label_ko': '합성 그림체', 'description_ko': '그림체 테스트 설명',
             'regions': [], 'sections': [], 'auxiliary': ['그림체'], 'examples': []},
        ]
        self.write_tags()
        (self.source / 'rules.json').write_text(json.dumps({'regions': {'face': {'label': '얼굴', 'sections': {'hair': {'label': '머리카락'}}}}}), encoding='utf-8')
        self.catalog = DakiTagCatalog(lambda: self.source)
        self.gallery = self.root / 'gallery'
        self.gallery.mkdir()
        Image.new('RGB', (4, 6), 'blue').save(self.gallery / 'sample.png')
        def resolve(relative):
            path = (self.gallery / relative).resolve()
            if not path.is_relative_to(self.gallery) or not path.is_file():
                raise FileNotFoundError()
            return path, path.relative_to(self.gallery).as_posix()
        self.examples = DakiTagExamples(self.root / 'user_examples', resolve)
        self.candidate_provider = mock.Mock(side_effect=lambda tag: iter([
            {'path': 'sample.png', 'name': 'Synthetic sample', 'prompt_info': {'prompt': 'synthetic_hair'}}]))
        self.app = Flask(__name__)
        register_daki_tag_catalog_routes(self.app, lambda: self.source,
            candidate_provider=self.candidate_provider, examples_store=self.examples)
        self.client = self.app.test_client()

    def write_tags(self):
        (self.source / 'tags.json').write_text(json.dumps({'tags': self.tags}), encoding='utf-8')

    def test_categories_counts_body_labels_and_auxiliary_original_labels(self):
        categories = self.catalog.categories()
        self.assertEqual(categories[0]['count'], 2)
        self.assertEqual(categories[1]['sections'], [{'id': 'face.hair', 'label': '머리카락', 'count': 1}])
        self.assertEqual(self.catalog.browse()['items'][0]['label_ko'], '합성 머리')
        self.assertEqual(self.catalog.browse()['items'][1]['label_ko'], 'synthetic_paint')
        categories[0]['count'] = 99
        self.assertEqual(self.catalog.categories()[0]['count'], 2)

    def test_filters_search_and_pagination_preserve_english_tag(self):
        self.assertEqual(self.catalog.browse('face', 'face.hair')['items'][0]['tag'], 'synthetic_hair')
        self.assertEqual(self.catalog.browse('aux:그림체')['total'], 1)
        self.assertEqual(self.catalog.browse(query='SYNTHETIC HAIR')['total'], 1)
        self.assertEqual(self.catalog.browse(query='합성 머리')['total'], 1)
        self.assertEqual(self.catalog.browse(examples_only=True)['total'], 1)
        self.tags += [{'tag': 'item_' + str(i), 'regions': [], 'sections': [], 'auxiliary': []} for i in range(80)]
        self.write_tags()
        result = self.catalog.browse(page=99)
        self.assertEqual((result['total'], result['page'], result['pages'], len(result['items'])), (82, 3, 3, 2))

    def test_details_include_examples_and_attribution_without_local_paths(self):
        result = self.catalog.detail('synthetic_hair')
        self.assertEqual(result['related'], [{'tag': 'synthetic_paint', 'label_ko': 'synthetic_paint'}])
        self.assertEqual(result['description_references'], ['https://example.invalid/source'])
        self.assertEqual(result['description_source_license'], 'Synthetic test license')
        self.assertTrue(result['examples'][0]['image'].startswith('/api/daki/tag-catalog/example?'))
        self.assertNotIn(str(self.root), json.dumps(result))
        result['description_references'].clear()
        self.assertTrue(self.catalog.detail('synthetic_hair')['description_references'])

    def test_translate_only_display_changes_and_preserves_weight_syntax(self):
        text = ' 1.2::synthetic_hair::, {synthetic_paint}, [unknown],\nsynthetic hair'
        result = self.catalog.translate(text)
        self.assertEqual(result, {'text': ' 1.2::합성 머리::, {synthetic_paint}, [unknown],\n합성 머리', 'translated': 2, 'untranslated': 2})
        self.assertEqual(self.catalog.detail('synthetic_hair')['tag'], 'synthetic_hair')

    def test_classify_tokens_normalizes_exact_names_and_preserves_order_and_duplicates(self):
        tokens = ['synthetic_hair', 'SYNTHETIC HAIR', ' synthetic\t hair ', 'synthetic_paint',
                  'synthetic hair extra', 'prefix_synthetic_hair', '1.2::synthetic_hair']
        result = self.catalog.classify_tokens(tokens)
        self.assertEqual([item['token'] for item in result['items']], tokens)
        self.assertEqual([item['tag'] for item in result['items']], [
            'synthetic_hair', 'synthetic_hair', 'synthetic_hair', 'synthetic_paint', None, None, None])
        self.assertEqual(result['items'][0]['regions'], ['face'])
        self.assertEqual(result['items'][0]['sections'], ['face.hair'])
        self.assertEqual(result['items'][4]['regions'], [])
        self.assertEqual(result['items'][4]['sections'], [])

    def test_classify_tokens_returns_copied_multi_region_metadata(self):
        self.tags[0]['regions'] = ['face', 'body']
        self.tags[0]['sections'] = ['face.hair', 'body.upper']
        self.write_tags()
        first = self.catalog.classify_tokens(['synthetic_hair'])['items'][0]
        self.assertEqual(first['regions'], ['face', 'body'])
        self.assertEqual(first['sections'], ['face.hair', 'body.upper'])
        first['regions'].append('changed')
        first['sections'].clear()
        second = self.catalog.classify_tokens(['synthetic_hair'])['items'][0]
        self.assertEqual(second['regions'], ['face', 'body'])
        self.assertEqual(second['sections'], ['face.hair', 'body.upper'])

    def test_classify_tokens_validates_input_and_accepts_empty_list(self):
        self.assertEqual(self.catalog.classify_tokens([]), {'items': []})
        invalid = [
            (None, '태그 토큰은 배열'),
            ((), '태그 토큰은 배열'),
            ([1], '문자열'),
            (['x' * 501], '500자'),
            (['x' * 500] * 101, '50,000자'),
            ([''] * 2001, '2,000개'),
        ]
        for tokens, message in invalid:
            with self.subTest(message=message):
                with self.assertRaisesRegex(ValueError, message):
                    self.catalog.classify_tokens(tokens)

    def test_classify_tokens_rebuilds_index_when_provider_root_or_source_changes(self):
        self.assertEqual(self.catalog.classify_tokens(['synthetic_hair'])['items'][0]['tag'], 'synthetic_hair')
        self.tags[0]['tag'] = 'synthetic_new'
        self.write_tags()
        updated = self.catalog.classify_tokens(['synthetic_hair', 'synthetic_new'])['items']
        self.assertEqual([item['tag'] for item in updated], [None, 'synthetic_new'])

        replacement = self.root / 'replacement'
        replacement.mkdir()
        (replacement / 'tags.json').write_text(json.dumps({'tags': [
            {'tag': 'replacement_tag', 'regions': ['body'], 'sections': ['body.upper']}
        ]}), encoding='utf-8')
        (replacement / 'rules.json').write_text(json.dumps({'regions': {}}), encoding='utf-8')
        self.source = replacement
        replaced = self.catalog.classify_tokens(['synthetic_new', 'replacement tag'])['items']
        self.assertEqual([item['tag'] for item in replaced], [None, 'replacement_tag'])
        self.assertEqual(replaced[1]['regions'], ['body'])
        self.assertEqual(replaced[1]['sections'], ['body.upper'])

    def test_example_requires_registered_file_inside_visuals(self):
        self.assertEqual(self.catalog.example_path('synthetic_hair'), self.source / 'visuals' / 'sample.png')
        for path in ('../outside.png', 'tags.json', str(self.root / 'outside.png'), 'visuals/example.txt'):
            with self.subTest(path=path):
                self.tags[0]['examples'][0]['thumbnail'] = path
                self.write_tags()
                with self.assertRaises(ValueError):
                    self.catalog.example_path('synthetic_hair')
        with self.assertRaises(KeyError):
            self.catalog.example_path('synthetic_hair', -1)

    def test_invalid_queries_and_missing_source_return_clear_errors(self):
        for suffix in ('browse?category=unknown', 'browse?category=face&section=other', 'browse?page=abc',
                       'browse?page=0', 'browse?examples=wrong', 'example?tag=synthetic_hair&index=abc',
                       'example?tag=synthetic_hair&full=wrong'):
            with self.subTest(suffix=suffix):
                self.assertEqual(self.client.get('/api/daki/tag-catalog/' + suffix).status_code, 400)
        self.assertEqual(self.client.get('/api/daki/tag-catalog/detail?tag=missing').status_code, 404)
        for payload in ([], {'text': None}, {'text': 'x' * 50001}):
            self.assertEqual(self.client.post('/api/daki/tag-catalog/translate', json=payload).status_code, 400)
        (self.source / 'tags.json').unlink()
        response = self.client.get('/api/daki/tag-catalog/categories')
        self.assertEqual(response.status_code, 404)
        self.assertIn('원본', response.json['message'])
        self.assertNotIn(str(self.source), response.get_data(as_text=True))

    def test_http_contract_read_only_and_root_change_invalidates_cache(self):
        before = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        for endpoint, key in (('categories', 'categories'), ('browse', 'items'), ('detail?tag=synthetic_hair', 'tag')):
            response = self.client.get('/api/daki/tag-catalog/' + endpoint)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json['status'], 'success')
            self.assertIn(key, response.json)
        response = self.client.get('/api/daki/tag-catalog/example?tag=synthetic_hair&index=0&full=1')
        self.assertEqual((response.status_code, response.mimetype), (200, 'image/png'))
        response.close()
        self.assertEqual(self.client.post('/api/daki/tag-catalog/translate', json={'text': 'synthetic_hair'}).json['text'], '합성 머리')
        classified = self.client.post('/api/daki/tag-catalog/classify', json={
            'tokens': ['SYNTHETIC HAIR', 'unknown']})
        self.assertEqual(classified.status_code, 200)
        self.assertEqual(classified.json, {'status': 'success', 'items': [
            {'token': 'SYNTHETIC HAIR', 'tag': 'synthetic_hair', 'regions': ['face'], 'sections': ['face.hair']},
            {'token': 'unknown', 'tag': None, 'regions': [], 'sections': []},
        ]})
        after = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(before, after)
        self.source = self.root / 'missing'
        response = self.client.get('/api/daki/tag-catalog/categories')
        self.assertEqual(response.status_code, 404)

    def test_malformed_catalog_does_not_expose_raw_data(self):
        (self.source / 'tags.json').write_text('{synthetic-private-invalid-json', encoding='utf-8')
        response = self.client.get('/api/daki/tag-catalog/categories')
        self.assertEqual(response.status_code, 400)
        self.assertNotIn('synthetic-private', response.json['message'])

    def test_classify_route_rejects_non_object_json_and_missing_dictionary(self):
        for payload in ([], None, {'tokens': None}, {'tokens': [1]}):
            with self.subTest(payload=payload):
                self.assertEqual(self.client.post('/api/daki/tag-catalog/classify', json=payload).status_code, 400)
        response = self.client.post('/api/daki/tag-catalog/classify', data='not-json',
                                    content_type='application/json')
        self.assertEqual(response.status_code, 400)
        (self.source / 'tags.json').unlink()
        response = self.client.post('/api/daki/tag-catalog/classify', json={'tokens': []})
        self.assertEqual(response.status_code, 404)

    def test_user_example_addition_merges_without_modifying_dictionary_or_source_image(self):
        before = {path: path.read_bytes() for path in self.source.rglob('*') if path.is_file()}
        image_before = (self.gallery / 'sample.png').read_bytes()
        payload = {'tag': 'synthetic_paint', 'path': 'sample.png'}
        response = self.client.post('/api/daki/tag-catalog/examples', json=payload)
        self.assertEqual(response.status_code, 200, response.json)
        repeated = self.client.post('/api/daki/tag-catalog/examples', json=payload)
        self.assertEqual(response.json, repeated.json)
        detail = self.client.get('/api/daki/tag-catalog/detail?tag=synthetic_paint').json['tag']
        self.assertEqual(len(detail['examples']), 1)
        example = detail['examples'][0]
        self.assertTrue(example['user_added'])
        for key in ('thumbnail', 'image'):
            self.assertTrue(example[key].startswith('/api/daki/tag-catalog/example?'))
            image = self.client.get(example[key])
            self.assertEqual(image.status_code, 200)
            image.close()
        listing = self.client.get('/api/daki/tag-catalog/browse?examples=1').json
        self.assertEqual(listing['total'], 2)
        self.assertEqual(next(item for item in listing['items'] if item['tag'] == 'synthetic_paint')['thumbnail'], example['thumbnail'])
        self.assertEqual({path: path.read_bytes() for path in before}, before)
        self.assertEqual((self.gallery / 'sample.png').read_bytes(), image_before)
        reopened = DakiTagCatalog(self.source, DakiTagExamples(self.root / 'user_examples', self.examples.resolve_source))
        self.assertEqual(reopened.detail('synthetic_paint')['examples'], detail['examples'])
        self.assertNotIn(str(self.root), json.dumps(detail))

    def test_new_examples_append_after_original_examples_and_missing_source_remains_linked(self):
        self.client.post('/api/daki/tag-catalog/examples', json={'tag': 'synthetic_hair', 'path': 'sample.png'})
        detail = self.client.get('/api/daki/tag-catalog/detail?tag=synthetic_hair').json['tag']
        self.assertEqual(len(detail['examples']), 2)
        self.assertIn('index=0', detail['examples'][0]['image'])
        (self.gallery / 'sample.png').unlink()
        self.assertEqual(self.client.get(detail['examples'][1]['image']).status_code, 404)
        self.assertEqual(len(self.examples.list_examples()), 1)

    def test_invalid_additions_do_not_persist_and_candidates_validate_tag(self):
        for payload in ([], None, {'tag': []}, {'tag': 'missing', 'path': 'sample.png'},
                        {'tag': 'synthetic_hair', 'path': '../outside.png'},
                        {'tag': 'synthetic_hair', 'path': '/absolute.png'}):
            with self.subTest(payload=payload):
                self.assertIn(self.client.post('/api/daki/tag-catalog/examples', json=payload).status_code, (400, 404))
        self.assertEqual(self.examples.list_examples(), [])
        response = self.client.get('/api/daki/tag-catalog/candidates?tag=synthetic_hair')
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(response.json['items'], [{'path': 'sample.png', 'name': 'Synthetic sample', 'src': '/image/sample.png?preview=512'}])
        self.assertNotIn('prompt', response.get_data(as_text=True))
        self.client.get('/api/daki/tag-catalog/candidates?tag=synthetic_hair&page=2')
        self.assertEqual(self.candidate_provider.call_count, 1)
        self.assertEqual(self.client.get('/api/daki/tag-catalog/candidates?tag=missing').status_code, 404)
        self.assertEqual(self.client.get('/api/daki/tag-catalog/candidates?tag=synthetic_hair&page=bad').status_code, 400)


if __name__ == '__main__':
    unittest.main()
