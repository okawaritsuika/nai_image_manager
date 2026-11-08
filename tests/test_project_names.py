import unittest

from naim.project_names import (
    MAX_CANVAS_NAME_UTF16_UNITS, readable_canvas_name,
    utf16_length, validate_windows_name,
)


class ProjectNameTests(unittest.TestCase):
    def test_utf16_length_and_windows_limit_count_non_bmp_characters_as_two_units(self):
        self.assertEqual(utf16_length('a🙂'), 3)
        self.assertEqual(validate_windows_name('🙂' * 127), '🙂' * 127)
        with self.assertRaises(ValueError):
            validate_windows_name('🙂' * 128)
        self.assertEqual(validate_windows_name('\ud83d\ude00'), '\ud83d\ude00')

    def test_windows_name_validation_trims_edges_and_rejects_unsafe_names(self):
        self.assertEqual(validate_windows_name('  Draft name  '), 'Draft name')
        for invalid in (
            '', '   ', '.', '..', 'trailing.', 'bad:name', 'bad/name',
            'bad\\name', 'bad?name', 'bad\x1fname', 'CON', 'con.txt',
            'LPT9.backup', 'COM¹', 'AUX', '\ud800', '\udc00',
        ):
            with self.subTest(name=invalid):
                with self.assertRaises(ValueError):
                    validate_windows_name(invalid)
        for reserved in (
            'CON', 'PRN', 'AUX', 'NUL',
            *(f'COM{number}' for number in range(1, 10)),
            *(f'LPT{number}' for number in range(1, 10)),
            'COM¹', 'COM²', 'COM³', 'LPT¹', 'LPT²', 'LPT³',
        ):
            with self.subTest(reserved=reserved):
                with self.assertRaises(ValueError):
                    validate_windows_name(reserved + '.txt')

    def test_windows_name_validation_honors_custom_utf16_limit(self):
        self.assertEqual(validate_windows_name('🙂' * 2, max_units=4), '🙂' * 2)
        with self.assertRaises(ValueError):
            validate_windows_name('🙂' * 2, max_units=3)

    def test_readable_canvas_name_strips_image_extension_and_replaces_unsafe_chars(self):
        self.assertEqual(
            readable_canvas_name('cover.PNG', 'front'),
            'cover · 앞면 편집',
        )
        self.assertEqual(
            readable_canvas_name('bad:name?.jpeg', 'back'),
            'bad_name_ · 뒷면 편집',
        )
        self.assertEqual(
            readable_canvas_name('CON.png', 'front'),
            'CON · 앞면 편집',
        )

    def test_readable_canvas_name_is_unique_case_insensitively_and_utf16_bounded(self):
        base = readable_canvas_name('A very long 🙂 image name.png', 'front')
        duplicate = readable_canvas_name(
            'A very long 🙂 image name.png', 'front', [base.upper()],
        )
        self.assertEqual(duplicate, base + ' 2')

        long_name = readable_canvas_name('🙂' * 200 + '.webp', 'back')
        self.assertLessEqual(utf16_length(long_name), MAX_CANVAS_NAME_UTF16_UNITS)
        self.assertFalse(long_name.endswith('\ud83d'))
        self.assertFalse(any(0xD800 <= ord(char) <= 0xDBFF for char in long_name))


if __name__ == '__main__':
    unittest.main()
