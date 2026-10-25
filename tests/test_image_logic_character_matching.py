import unittest

from image_logic import build_character_matcher, extract_character_names


def matcher(known_rows=(), danbooru_tags=()):
    return build_character_matcher(known_rows, danbooru_tags)


class ImageLogicCharacterMatchingTests(unittest.TestCase):
    def test_matcher_uses_first_token_candidates_not_giant_regex(self):
        compiled = matcher([
            ("Ikuta_Haruki", None),
            ("alice", None),
            ("Ta", None),
            ("Holo", None),
        ])

        self.assertIsNone(compiled["known_pattern"])
        self.assertIn("ikuta", compiled["known_candidates_by_first_token"])
        self.assertIn("alice", compiled["known_candidates_by_first_token"])
        self.assertNotIn("ta", compiled["known_candidates_by_first_token"])
        self.assertNotIn("holo", compiled["known_candidates_by_first_token"])

    def test_known_character_is_found_inside_base_prompt_prose(self):
        found = extract_character_names(
            [],
            [
                "Ikuta Haruki is standing beneath a large tree beside a quiet riverside road",
            ],
            matcher([("Ikuta_Haruki", None)]),
        )

        self.assertEqual(found, ["Ikuta_Haruki"])

    def test_known_character_is_found_when_prose_contains_blacklist_word(self):
        found = extract_character_names(
            [],
            ["Ikuta Haruki wears a school uniform"],
            matcher([("Ikuta_Haruki", None)]),
        )

        self.assertEqual(found, ["Ikuta_Haruki"])

    def test_known_alias_matches_underscore_tag_form(self):
        found = extract_character_names(
            [],
            ["Ikuta_Haruki"],
            matcher([("Ikuta_Haruki", None)]),
        )

        self.assertEqual(found, ["Ikuta_Haruki"])

    def test_short_alias_is_not_found_inside_prose(self):
        found = extract_character_names(
            [],
            ["Ta is standing beside Ikuta Haruki"],
            matcher([("Ta", None), ("Ikuta_Haruki", None)]),
        )

        self.assertEqual(found, ["Ikuta_Haruki"])

    def test_generic_known_tags_are_not_detected_from_exact_fields(self):
        found = extract_character_names(
            [],
            ["Boy", "Girl", "2boys", "1girl"],
            matcher([
                ("Boy", None),
                ("Girl", None),
                ("2boys", None),
                ("1girl", None),
            ]),
        )

        self.assertEqual(found, [])

    def test_generic_danbooru_fallback_tags_are_not_characters(self):
        found = extract_character_names(
            [],
            ["girl", "2boys"],
            matcher([], ["girl", "2boys"]),
        )

        self.assertEqual(found, [])

    def test_character_generic_word_is_excluded_from_tags_and_prose(self):
        for compiled in (
            matcher([("character", None), ("alice", None)]),
            matcher([("alice", None)], ["character"]),
        ):
            with self.subTest(compiled=compiled):
                found = extract_character_names(
                    ["Character", "{character}"],
                    ["the character is standing beside alice"],
                    compiled,
                )
                self.assertEqual(found, ["alice"])

    def test_generic_tag_and_real_character_leave_real_character(self):
        found = extract_character_names(
            [],
            ["boy", "Ikuta Haruki is standing"],
            matcher([("boy", None), ("Ikuta_Haruki", None)]),
        )

        self.assertEqual(found, ["Ikuta_Haruki"])

    def test_generic_words_inside_real_character_names_are_allowed(self):
        found = extract_character_names(
            [],
            ["cowboy bebop is here", "Boy Name is here"],
            matcher([
                ("cowboy_bebop", "Cowboy Bebop"),
                ("boy_name", "Boy Name"),
            ]),
        )

        self.assertEqual(found, ["Cowboy Bebop", "Boy Name"])

    def test_short_alias_is_found_when_it_is_a_comma_split_field(self):
        found = extract_character_names(
            [],
            ["Ta", "Ikuta Haruki is standing"],
            matcher([("Ta", None), ("Ikuta_Haruki", None)]),
        )

        self.assertEqual(found, ["Ta", "Ikuta_Haruki"])

    def test_four_letter_alias_is_exact_only(self):
        prose_found = extract_character_names(
            [],
            ["Holo is standing beside a river"],
            matcher([("Holo", None)]),
        )
        exact_found = extract_character_names(
            [],
            ["Holo"],
            matcher([("Holo", None)]),
        )

        self.assertEqual(prose_found, [])
        self.assertEqual(exact_found, ["Holo"])

    def test_five_letter_alias_still_matches_prose(self):
        found = extract_character_names(
            [],
            ["Alice is standing beside a river"],
            matcher([("Alice", None)]),
        )

        self.assertEqual(found, ["Alice"])

    def test_character_and_base_prompts_are_both_searched(self):
        found = extract_character_names(
            ["alice"],
            ["Robin is smiling"],
            matcher([("alice", None), ("Robin", None)]),
        )

        self.assertEqual(found, ["alice", "Robin"])

    def test_word_boundaries_prevent_substring_false_positive(self):
        found = extract_character_names(
            [],
            ["malice", "alice_dakimakura"],
            matcher([("alice", None)]),
        )

        self.assertEqual(found, [])

    def test_repeated_same_character_counts_once(self):
        found = extract_character_names(
            [],
            ["alice meets alice"],
            matcher([("alice", None)]),
        )

        self.assertEqual(found, ["alice"])

    def test_repeated_characters_across_fields_leave_two_unique_names(self):
        found = extract_character_names(
            ["alice", "Robin", "Robin"],
            ["alice meets alice", "Robin"],
            matcher([("alice", None), ("Robin", None)]),
        )

        self.assertEqual(found, ["alice", "Robin"])

    def test_duplicate_db_alias_rows_do_not_create_fake_occurrence(self):
        found = extract_character_names(
            [],
            ["alice"],
            matcher([
                ("alice", "Alice"),
                ("alice_dakimakura", "Alice"),
            ]),
        )

        self.assertEqual(found, ["Alice"])

    def test_two_different_characters_are_both_preserved(self):
        found = extract_character_names(
            [],
            ["alice and Robin"],
            matcher([("alice", None), ("Robin", None)]),
        )

        self.assertEqual(found, ["alice", "Robin"])

    def test_longest_alias_wins_for_one_overlapping_occurrence(self):
        found = extract_character_names(
            [],
            ["Ann Lee is here"],
            matcher([("ann", None), ("ann_lee", None)]),
        )

        self.assertEqual(found, ["ann_lee"])

    def test_unknown_exact_danbooru_tag_remains_supported(self):
        found = extract_character_names(
            [],
            ["unknown_character"],
            matcher([], ["unknown_character"]),
        )

        self.assertEqual(found, ["Unknown_Character"])

    def test_exact_blacklisted_token_is_not_classified_as_character(self):
        found = extract_character_names(
            [],
            ["artist"],
            matcher([], ["artist"]),
        )

        self.assertEqual(found, [])

    def test_known_alias_and_danbooru_exact_tag_are_not_double_counted(self):
        found = extract_character_names(
            [],
            ["alice"],
            matcher([("alice", None)], ["alice"]),
        )

        self.assertEqual(found, ["alice"])

    def test_simple_exact_alias_and_danbooru_tag_are_not_double_counted(self):
        found = extract_character_names(
            [],
            ["Ta"],
            matcher([("Ta", None)], ["ta"]),
        )

        self.assertEqual(found, ["Ta"])


if __name__ == "__main__":
    unittest.main()
