import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from naim.shared_style_recipe import (
    extract_recipe, load_style_artist_names, original_options, recipe_fingerprint,
    style_duplicate_key,
)
from naim.generation_settings import V5_FULL_MEDIUM, V5_MEDIUM_FIXED_SETTINGS


class SharedStyleRecipeTests(unittest.TestCase):
    def test_preserves_style_order_emphasis_and_repetitions(self):
        recipe = extract_recipe(
            '1girl, {artist:synthetic, lineart}, blue hair, 0.5::flat color, flat color ::, '
            '-1::3d ::, bedroom, from above, best quality',
            '2::worst quality ::, bad hands, red dress')
        self.assertEqual(recipe['positive'],
                         '1.05::artist:synthetic, lineart ::, 0.5::flat color, flat color ::, '
                         '-1::3d ::, best quality')
        self.assertEqual(recipe['negative'], '2::worst quality ::, bad hands')
        signature = [[['artist:synthetic', 1.05], ['lineart', 1.05],
                      ['flat color', 0.5], ['flat color', 0.5], ['3d', -1.0],
                      ['best quality', 1.0]], [['worst quality', 2.0], ['bad hands', 1.0]]]
        expected = hashlib.sha256(json.dumps(signature, ensure_ascii=False).encode()).hexdigest()
        self.assertEqual(recipe['fingerprint'], expected)
        self.assertEqual(recipe_fingerprint(recipe['positive'], recipe['negative']), expected)

    def test_quality_without_rendering_is_not_a_recipe(self):
        with self.assertRaises(ValueError):
            extract_recipe('1girl, masterpiece, year 2026, bedroom', '')

    def test_unknown_style_syntax_is_rejected(self):
        with self.assertRaises(ValueError):
            extract_recipe('||artist:synthetic|lineart||, 1girl', '')
        with self.assertRaises(ValueError):
            extract_recipe('"artist:synthetic', '')

    def test_reviewed_character_randomizer_is_removed(self):
        recipe = extract_recipe('artist:synthetic, ||1girl|1boy||, lineart', '')
        self.assertEqual(recipe['positive'], 'artist:synthetic, lineart')
        self.assertTrue(recipe['import_edits'])

    def test_raw_options_preserve_zero_and_false(self):
        raw = {'steps': 28, 'scale': 4.5, 'sampler': 'k_euler_ancestral',
               'noise_schedule': 'karras', 'cfg_rescale': 0, 'noise': 0,
               'dynamic_thresholding': False}
        options = original_options(raw, 'nai-diffusion-5-full')
        self.assertEqual(options['cfg_rescale'], 0)
        self.assertEqual(options['noise'], 0)
        self.assertIs(options['dynamic_thresholding'], False)
        self.assertEqual(options['cfg'], 4.5)
        self.assertNotIn('strength', options)

    def test_medium_fixed_constraints_and_missing_guidance(self):
        options = original_options({'scale': 4.5}, V5_FULL_MEDIUM)
        self.assertEqual(options, dict(V5_MEDIUM_FIXED_SETTINGS, cfg=4.5))
        with self.assertRaises(ValueError):
            original_options({}, V5_FULL_MEDIUM)
        with self.assertRaises(ValueError):
            original_options({'scale': 4.5}, 'nai-diffusion-5-full')

    def test_invalid_numeric_and_boolean_options(self):
        for key, value in [('scale', True), ('steps', 1.5), ('cfg_rescale', float('nan')),
                           ('prefer_brownian', 0)]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                original_options({'scale': 4.5, key: value}, V5_FULL_MEDIUM)

    def test_artist_duplicate_key_ignores_order_weights_repeats_and_prefix_form(self):
        first = style_duplicate_key(
            '{first_artist, artists:Second Artist, high quality}',
            artist_names=frozenset({'first artist', 'second artist'}))
        second = style_duplicate_key(
            '0.5::artists:SECOND_ARTIST, artist:first artist, second_artist, masterpiece ::',
            artist_names=frozenset({'first artist', 'second artist'}))
        self.assertEqual(first, ('artists', ('first artist', 'second artist')))
        self.assertEqual(first, second)

    def test_artist_duplicate_key_normalizes_parenthesis_spacing(self):
        first = style_duplicate_key('artist:Painter(alias)', artist_names=frozenset())
        second = style_duplicate_key('ARTISTS: painter ( alias )', artist_names=frozenset())
        self.assertEqual(first, ('artists', ('painter (alias)',)))
        self.assertEqual(first, second)

    def test_bare_dictionary_artists_work_with_bundled_and_injected_snapshots(self):
        bundled = frozenset({'synthetic artist'})
        with patch('naim.shared_style_recipe._artist_names', return_value=bundled):
            self.assertEqual(style_duplicate_key('synthetic artist'),
                             ('artists', ('synthetic artist',)))

        self.assertEqual(
            style_duplicate_key('injected_artist', artist_names=frozenset({'injected artist'})),
            ('artists', ('injected artist',)))
        recipe = extract_recipe(
            'injected_artist, lineart', '',
            artist_names=frozenset({'injected artist'}))
        self.assertEqual(recipe['positive'], 'injected_artist, lineart')

    def test_artist_duplicate_key_requires_the_full_same_combination(self):
        names = frozenset()
        first = style_duplicate_key('artist:artist_a, artist:artist_b', artist_names=names)
        self.assertNotEqual(first,
                            style_duplicate_key('artist:artist_a, artist:artist_c', artist_names=names))
        self.assertNotEqual(first, style_duplicate_key('artist:artist_a', artist_names=names))

    def test_style_duplicate_key_uses_unique_classified_styles_without_quality_or_year(self):
        first = style_duplicate_key(
            'watercolor, lineart, watercolor, high quality, year 2025, 3d',
            artist_names=frozenset())
        second = style_duplicate_key(
            '0.25::3d, lineart, watercolor ::, best quality',
            artist_names=frozenset())
        self.assertEqual(first, ('style', ('3d', 'lineart', 'watercolor')))
        self.assertEqual(first, second)
        self.assertNotEqual(first, style_duplicate_key('ink', artist_names=frozenset()))

    def test_style_duplicate_key_returns_none_for_quality_year_only_and_rejects_bad_syntax(self):
        self.assertIsNone(style_duplicate_key(
            'best quality, masterpiece, high quality, year 2025', artist_names=frozenset()))
        with self.assertRaises(ValueError):
            style_duplicate_key('||artist:synthetic|lineart||', artist_names=frozenset())
        with self.assertRaises(ValueError):
            style_duplicate_key('"lineart', artist_names=frozenset())
        with self.assertRaises(ValueError):
            style_duplicate_key(None, artist_names=frozenset())
        with self.assertRaises(ValueError):
            style_duplicate_key('x' * 100001, artist_names=frozenset())

    def test_load_style_artist_names_unions_bundled_and_category_one_names(self):
        with tempfile.TemporaryDirectory() as directory:
            dictionary = Path(directory) / 'danbooru_tags.sqlite3'
            connection = sqlite3.connect(dictionary)
            try:
                connection.execute('CREATE TABLE danbooru_tags (name TEXT, category INTEGER)')
                connection.executemany(
                    'INSERT INTO danbooru_tags (name, category) VALUES (?, ?)',
                    [('New_Artist', 1), ('Non_Artist', 0), ('  ', 1), (None, 1),
                     ('___', 1), (sqlite3.Binary(b'not-a-name'), 1)])
                connection.commit()
            finally:
                connection.close()
            before = hashlib.sha256(dictionary.read_bytes()).digest()

            with patch('naim.shared_style_recipe._artist_names', return_value=frozenset({
                    'Bundled_Artist', 'Bundled( Alias )'})):
                names = load_style_artist_names(dictionary)
            after = hashlib.sha256(dictionary.read_bytes()).digest()

        self.assertEqual(before, after)
        self.assertEqual(names, frozenset({
            'bundled artist', 'bundled (alias)', 'new artist'}))

    def test_missing_dictionary_is_not_created_and_uses_only_bundled_names(self):
        with tempfile.TemporaryDirectory() as directory:
            dictionary = Path(directory) / 'missing.sqlite3'
            with patch('naim.shared_style_recipe._artist_names', return_value=frozenset({
                    'Bundled_Artist'})):
                names = load_style_artist_names(dictionary)
            self.assertFalse(dictionary.exists())
        self.assertEqual(names, frozenset({'bundled artist'}))

    def test_load_style_artist_names_reports_corrupt_or_invalid_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            corrupt = Path(directory) / 'corrupt.sqlite3'
            corrupt.write_text('not a sqlite database', encoding='utf-8')
            invalid_schema = Path(directory) / 'invalid-schema.sqlite3'
            connection = sqlite3.connect(invalid_schema)
            try:
                connection.execute('CREATE TABLE other_table (name TEXT, category INTEGER)')
            finally:
                connection.close()

            with patch('naim.shared_style_recipe._artist_names', return_value=frozenset()):
                for dictionary in (corrupt, invalid_schema):
                    with self.subTest(dictionary=dictionary.name), self.assertRaises(ValueError) as error:
                        load_style_artist_names(dictionary)
                    self.assertIn('사전', str(error.exception))
                    self.assertNotIn('no such table', str(error.exception))

    def test_load_style_artist_names_uses_application_data_path(self):
        with tempfile.TemporaryDirectory() as directory:
            app_dir = Path(directory)
            database = app_dir / 'data' / 'danbooru_tags.sqlite3'
            database.parent.mkdir()
            connection = sqlite3.connect(database)
            try:
                connection.execute('CREATE TABLE danbooru_tags (name TEXT, category INTEGER)')
                connection.execute(
                    'INSERT INTO danbooru_tags (name, category) VALUES (?, ?)',
                    ('Local_Artist', 1))
                connection.commit()
            finally:
                connection.close()
            with patch('naim.shared_style_recipe._artist_names', return_value=frozenset()):
                with patch('naim.shared_style_recipe.get_app_dir', return_value=str(app_dir)):
                    names = load_style_artist_names()
        self.assertEqual(names, frozenset({'local artist'}))


if __name__ == '__main__':
    unittest.main()
