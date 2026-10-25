import ast
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock
from urllib.parse import quote, unquote

from PIL import Image
from PIL.PngImagePlugin import PngInfo

from naim.daki_tag_candidates import DakiTagCandidates, has_positive_tag
from naim.images.prompt_metadata import extract_prompt_info_from_image, load_prompt_sidecar, merge_prompt_info_with_fallback
from naim.storage.history import HistoryDB


class TagMatchingTests(unittest.TestCase):
    def test_exact_positive_tokens_weights_and_space_underscore_equivalence(self):
        for prompt in ('blue_hair, shirt', '  BLUE HAIR , shirt', '{blue_hair}', '[[blue hair]]',
                       '1.25::blue_hair::, shirt', '-0.5::shirt, blue_hair::', 'shirt\nblue_hair'):
            with self.subTest(prompt=prompt):
                self.assertTrue(has_positive_tag({'prompt': prompt}, 'blue_hair'))
        for prompt in ('long_blue_hair', 'blue_hair_ornament', 'blue hair ornament', 'blue, hair'):
            with self.subTest(prompt=prompt):
                self.assertFalse(has_positive_tag({'prompt': prompt}, 'blue_hair'))
        self.assertFalse(has_positive_tag({'prompt': 'long_hair'}, 'hair'))
        self.assertFalse(has_positive_tag({'negative_prompt': 'blue_hair', 'uc': 'blue_hair',
            'v4_negative_prompt': {'caption': {'base_caption': 'blue_hair'}}}, 'blue_hair'))
        self.assertTrue(has_positive_tag({'char_prompts': [{'prompt': 'blue_hair', 'negative_prompt': 'red_hair'}]}, 'blue_hair'))
        self.assertFalse(has_positive_tag({'char_prompts': [{'prompt': 'blue_hair', 'negative_prompt': 'red_hair'}]}, 'red_hair'))
        self.assertTrue(has_positive_tag({'v4_prompt': {'caption': {'char_captions': [{'char_caption': 'blue_hair'}]}}}, 'blue_hair'))
        self.assertTrue(has_positive_tag({'basePrompt': 'character_(synthetic_series)'}, 'character_(synthetic_series)'))

    def test_pages_reuse_search_first_page_refreshes_and_cache_is_bounded(self):
        rows = [{'path': f'folder/{index}.png', 'prompt_info': {'prompt': 'synthetic_tag'}} for index in range(45)]
        provider = mock.Mock(side_effect=lambda tag: iter(rows))
        context = ['one']
        search = DakiTagCandidates(provider, lambda: context[0])
        self.assertEqual(search.search('synthetic_tag')['total'], 45)
        rows.append({'path': 'folder/new #%.png', 'prompt_info': {'prompt': 'synthetic_tag'}})
        self.assertEqual(len(search.search('synthetic_tag', 2)['items']), 5)
        self.assertEqual(provider.call_count, 1)
        self.assertEqual(search.search('synthetic_tag')['total'], 46)
        result = search.search('synthetic_tag', 2)
        self.assertIn('new%20%23%25.png', result['items'][-1]['src'])
        self.assertNotIn('prompt_info', result['items'][0])
        result['items'].clear()
        self.assertEqual(len(search.search('synthetic_tag', 2)['items']), 6)
        context[0] = 'two'
        search.search('synthetic_tag', 2)
        self.assertEqual(provider.call_count, 3)
        for index in range(6):
            search.search('tag_' + str(index))
        self.assertEqual(len(search._cache), search.MAX_SEARCHES)

    def test_duplicate_invalid_paths_and_negative_matches_are_not_returned(self):
        rows = [{'path': path, 'prompt_info': {'prompt': 'hair'}} for path in ('a.png', 'a.png', '../a.png', 'C:/a.png')]
        rows += [{'path': 'b.png', 'prompt_info': {'negativePrompt': 'hair'}}]
        search = DakiTagCandidates(lambda tag: rows)
        self.assertEqual([item['path'] for item in search.search('hair')['items']], ['a.png'])
        for page in ('bad', 0, -1):
            with self.assertRaises(ValueError):
                search.search('hair', page)


class GalleryTagCandidateTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.gallery = self.root / 'gallery'
        self.gallery.mkdir()
        self.database = self.root / 'history.db'
        db = HistoryDB(self.database)
        db.close()
        tree = ast.parse((Path(__file__).resolve().parents[1] / 'app.py').read_text(encoding='utf-8'))
        names = {'iter_daki_tag_candidate_rows', 'should_skip_gallery_index_directory', 'should_skip_gallery_index_child_directory'}
        functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
        self.assertEqual({node.name for node in functions}, names)
        def resolve(value):
            relative = unquote(value.removeprefix('/image/'))
            path = (self.gallery / relative).resolve()
            if not path.is_relative_to(self.gallery) or not path.is_file():
                raise FileNotFoundError()
            return str(path), path.relative_to(self.gallery).as_posix()
        self.drafts = mock.Mock(return_value=iter([]))
        self.tests = mock.Mock(return_value=iter([]))
        self.read_info = mock.Mock(wraps=extract_prompt_info_from_image)
        namespace = {'os': os, 'quote': quote, 'Image': Image, 'CLASSIFIED_DIR': str(self.gallery),
            'UPSCALE_OUTPUT_FOLDER_NAME': '_upscaled', 'get_gallery_history_db': lambda: HistoryDB(self.database),
            'resolve_daki_image_path': resolve, 'load_prompt_sidecar': load_prompt_sidecar,
            'merge_prompt_info_with_fallback': merge_prompt_info_with_fallback,
            'extract_prompt_info_from_image': self.read_info,
            'DAKI_DRAFTS': types.SimpleNamespace(iter_completed_prompt_images=self.drafts),
            'DAKI_STYLE_TESTS': types.SimpleNamespace(iter_completed_prompt_images=self.tests)}
        exec(compile(ast.Module(body=functions, type_ignores=[]), '<tag_candidates>', 'exec'), namespace)
        self.search = DakiTagCandidates(namespace['iter_daki_tag_candidate_rows'])

    def image(self, name, positive, negative=''):
        path = self.gallery / name
        path.parent.mkdir(parents=True, exist_ok=True)
        metadata = PngInfo()
        metadata.add_text('Comment', json.dumps({'prompt': positive, 'negative_prompt': negative}))
        with Image.new('RGB', (4, 4), 'blue') as image:
            image.save(path, pnginfo=metadata)
        return path

    def index(self, path, positive, negative='', stale=False):
        relative = path.relative_to(self.gallery).as_posix()
        db = HistoryDB(self.database)
        try:
            db.upsert_gallery_prompt_records([{'rel_path': relative, 'folder_path': str(Path(relative).parent),
                'file_name': path.name, 'mode': 'general', 'mtime': path.stat().st_mtime - int(stale),
                'prompt_text': positive + ', ' + negative, 'positive_prompt_text': positive,
                'normalized_text': positive + ' ' + negative, 'positive_normalized_text': positive}])
        finally:
            db.close()

    def test_partial_index_and_changed_files_find_exact_positive_matches_without_nega_or_trash(self):
        exact = self.image('a.png', '1.2::hair::')
        self.index(exact, '1.2::hair::')
        not_exact = self.image('long.png', 'long hair')
        self.index(not_exact, 'long hair')
        negative = self.image('negative.png', 'shirt', 'hair')
        self.index(negative, 'shirt', 'hair')
        self.image('new.png', 'hair')
        changed = self.image('changed.png', 'hair')
        self.index(changed, 'shirt', stale=True)
        self.image('_TRASH/old.png', 'hair')
        self.image('ignored/skip.png', 'hair')
        (self.gallery / 'ignored/.ignore').write_text('')
        (self.gallery / 'fake.png').write_text('not an image')
        (self.gallery / 'fake.json').write_text(json.dumps({'basePrompt': 'hair'}))
        before = {path: path.read_bytes() for path in self.gallery.rglob('*') if path.is_file()}
        self.assertEqual({item['path'] for item in self.search.search('hair')['items']}, {'a.png', 'new.png', 'changed.png'})
        self.assertNotIn(str(negative), [call.args[0] for call in self.read_info.call_args_list])
        self.assertEqual({path: path.read_bytes() for path in before}, before)

    def test_no_index_scan_runs_once_for_pagination_and_includes_completed_daki_rows(self):
        self.image('ordinary.png', 'hair')
        self.drafts.side_effect = lambda: iter([{'path': '__daki_drafts__/' + 'a' * 32 + '.png',
            'name': 'Synthetic draft', 'prompt_info': {'prompt': 'hair'}}])
        self.tests.side_effect = lambda: iter([{'path': '__daki_tests__/' + 'b' * 32 + '/style.png',
            'name': 'Synthetic test', 'prompt_info': {'prompt': 'hair'}}])
        first = self.search.search('hair')
        self.assertEqual(first['total'], 3)
        self.search.search('hair', 2)
        self.assertEqual(self.read_info.call_count, 1)
        self.assertEqual(self.drafts.call_count, 1)

    def test_partial_and_changed_sidecars_do_not_hide_png_prompts_or_reuse_stale_index(self):
        partial = self.image('partial.png', 'hair')
        partial.with_suffix('.json').write_text(json.dumps({'model': 'synthetic model'}))
        self.index(partial, '')
        changed = self.image('changed-sidecar.png', 'shirt')
        changed.with_suffix('.json').write_text(json.dumps({'basePrompt': 'hair'}))
        self.index(changed, 'shirt')
        self.assertEqual({item['path'] for item in self.search.search('hair')['items']},
                         {'partial.png', 'changed-sidecar.png'})


if __name__ == '__main__':
    unittest.main()
