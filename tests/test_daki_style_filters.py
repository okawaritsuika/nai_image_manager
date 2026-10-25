import unittest

from naim.daki_style_filters import matches_style_filters, normalize_style_filters


class DakiStyleFilterTests(unittest.TestCase):
    def test_defaults_and_tag_normalization(self):
        self.assertEqual(normalize_style_filters(), {
            'exclude_realistic': True, 'include_mode': 'any', 'include_tags': [], 'exclude_tags': []
        })
        self.assertEqual(normalize_style_filters({'low_recommendation_limit': None}), {
            'exclude_realistic': True, 'include_mode': 'any', 'low_recommendation_limit': None,
            'include_tags': [], 'exclude_tags': []
        })
        self.assertEqual(normalize_style_filters({'low_recommendation_limit': 0})[
            'low_recommendation_limit'], 0)
        self.assertEqual(normalize_style_filters({'low_recommendation_limit': 10})[
            'low_recommendation_limit'], 10)
        self.assertEqual(normalize_style_filters({'low_recommendation_limit': 9007199254740991})[
            'low_recommendation_limit'], 9007199254740991)
        self.assertEqual(normalize_style_filters({
            'include_tags': [' Blue_Hair ', 'blue   hair', 'INK'],
            'exclude_tags': ['Red_Eyes', ' red eyes '],
        }), {
            'exclude_realistic': True, 'include_mode': 'any',
            'include_tags': ['blue hair', 'ink'], 'exclude_tags': ['red eyes'],
        })
        self.assertEqual(normalize_style_filters({
            'exclude_realistic': False, 'include_mode': 'all'
        }), {
            'exclude_realistic': False, 'include_mode': 'all', 'include_tags': [], 'exclude_tags': []
        })

    def test_rejects_invalid_filter_shapes_values_and_tag_limits(self):
        invalid = (
            'not an object',
            {'exclude_realistic': 1},
            {'include_mode': 'OR'},
            {'low_recommendation_limit': True},
            {'low_recommendation_limit': False},
            {'low_recommendation_limit': '10'},
            {'low_recommendation_limit': 1.5},
            {'low_recommendation_limit': -1},
            {'low_recommendation_limit': 9007199254740992},
            {'include_tags': 'watercolor'},
            {'exclude_tags': None},
            {'include_tags': ['']},
            {'include_tags': ['  ']},
            {'include_tags': [',']},
            {'include_tags': ['water,color']},
            {'include_tags': ['x' * 201]},
            {'include_tags': [None]},
            {'include_tags': ['line\nbreak']},
            {'exclude_tags': ['line\tbreak']},
            {'include_tags': ['delete\x7f']},
            {'include_tags': ['too many'] * 101},
            {'exclude_tags': ['too many'] * 101},
        )
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_style_filters(value)

    def test_matching_uses_weighted_exact_tags_and_any_or_all(self):
        positive = '1.25::Blue_Hair::, watercolorish, ink'
        filters = normalize_style_filters({'include_tags': ['blue hair', 'watercolor']})
        self.assertTrue(matches_style_filters(positive, filters))
        self.assertTrue(matches_style_filters('blue hair, watercolorish', filters))
        self.assertFalse(matches_style_filters('blue hair, watercolorish',
                                               normalize_style_filters({'include_tags': ['watercolor']})))
        self.assertFalse(matches_style_filters('blue hair, watercolorish, ink',
                                               normalize_style_filters({
                                                   'include_tags': ['blue hair', 'watercolor'],
                                                   'include_mode': 'all'})))
        self.assertTrue(matches_style_filters('blue hair, watercolor',
                                              normalize_style_filters({
                                                  'include_tags': ['blue hair', 'watercolor'],
                                                  'include_mode': 'all'})))

    def test_excluded_tags_take_priority_and_realism_uses_only_positive_prompt(self):
        conflict = normalize_style_filters({'include_tags': ['watercolor'],
                                            'exclude_tags': ['ink']})
        self.assertFalse(matches_style_filters('artist:sample, watercolor, ink', conflict))
        self.assertTrue(matches_style_filters('artist:sample, watercolor', conflict))

        default = normalize_style_filters()
        self.assertFalse(matches_style_filters('artist:sample, Photorealistic', default))
        self.assertFalse(matches_style_filters('artist:sample, realistic', default))
        self.assertTrue(matches_style_filters('artist:sample, watercolor', default))
        self.assertTrue(matches_style_filters('artist:sample, watercolor',
                                              normalize_style_filters({'exclude_realistic': False})))

    def test_supported_malformed_prompt_uses_reviewed_edit_for_matching(self):
        positive = 'artist:sample, watercolor, ||1girl, beach||'
        self.assertTrue(matches_style_filters(positive,
                                              normalize_style_filters({'include_tags': ['watercolor']})))
        self.assertFalse(matches_style_filters(positive,
                                               normalize_style_filters({'include_tags': ['beach']})))

    def test_query_uses_virtual_folder_and_or_mixed_and_partial_syntax(self):
        cases = [
            ('watercolor, sketch', 'watercolor, sketch', True),
            ('watercolor, sketch', 'watercolor', False),
            ('watercolor || sketch', 'sketch', True),
            ('watercolor, sketch || ink', 'ink', True),
            ('watercolor, sketch || ink', 'watercolor', False),
            ('watercolor\nsketch', 'watercolor, sketch', True),
            ('blue_hair', '1.2::Blue Hair::', True),
            ('blue_hair', 'blue eyes, red hair', False),
            ('%watercolor%', 'watercolorish', True),
            ('watercolor', 'watercolorish', False),
        ]
        for query, positive, expected in cases:
            with self.subTest(query=query, positive=positive):
                self.assertEqual(matches_style_filters(positive, normalize_style_filters({
                    'include_query': query})), expected)

    def test_query_exclusions_and_legacy_precedence(self):
        filters = normalize_style_filters({'include_query': 'watercolor || ink',
                                            'exclude_tags': ['sketch']})
        self.assertTrue(matches_style_filters('ink', filters))
        self.assertFalse(matches_style_filters('ink, sketch', filters))
        self.assertFalse(matches_style_filters('ink, realistic', filters))
        # An explicitly cleared expression must not resurrect a legacy filter.
        filters = normalize_style_filters({'include_query': '  ', 'include_tags': ['ink']})
        self.assertTrue(matches_style_filters('watercolor', filters))
        self.assertEqual(filters['include_query'], '')
        self.assertFalse(matches_style_filters('ink', normalize_style_filters({
            'include_query': 'sketch', 'include_tags': ['ink']})))

    def test_query_limits_and_invalid_values(self):
        invalid = [None, [], 1, 'x' * 20001, 'x' * 201, '||', '%%',
                   'watercolor\x00', 'ink\x7f', ','.join(['ink'] * 101)]
        for query in invalid:
            with self.subTest(query=query), self.assertRaises(ValueError):
                normalize_style_filters({'include_query': query})
        self.assertEqual(normalize_style_filters({'include_query': '  ink\n||\tsketch  '})[
            'include_query'], 'ink\n||\tsketch')
        self.assertTrue(matches_style_filters('ink', normalize_style_filters({
            'include_query': ','.join(['ink'] * 100)})))


if __name__ == '__main__':
    unittest.main()
