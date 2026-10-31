import os
import importlib
import sys
import types
import unittest
from unittest import mock

from flask import Blueprint, g


def _load_app_without_flask():
    flask_stub = types.ModuleType("flask")

    class FakeFlask:
        def __init__(self, *_args, **_kwargs):
            self.config = {}
            self.extensions = {}
            self.root_path = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

        def route(self, *_args, **_kwargs):
            return lambda function: function

        get = post = put = delete = route

        def after_request(self, function):
            return function

        def register_blueprint(self, *_args, **_kwargs):
            return None

        def add_url_rule(self, *_args, **_kwargs):
            return None

        def run(self, *_args, **_kwargs):
            return None

    flask_stub.Flask = FakeFlask
    flask_stub.Blueprint = Blueprint
    flask_stub.g = g
    flask_stub.jsonify = lambda value=None, **kwargs: value if value is not None else kwargs
    flask_stub.send_file = lambda *args, **kwargs: None
    flask_stub.Response = lambda *args, **kwargs: None
    flask_stub.request = types.SimpleNamespace(args={}, form={}, files={})

    previous_app = sys.modules.pop("app", None)
    try:
        with mock.patch.dict(sys.modules, {"flask": flask_stub}):
            return importlib.import_module("app")
    finally:
        if previous_app is not None:
            sys.modules["app"] = previous_app
        else:
            sys.modules.pop("app", None)


app_module = _load_app_without_flask()


KNOWN_CHARACTERS = [
    {"tag": "alice", "clean": "alice", "brand": "A", "brand_kr": ""},
    {"tag": "bob", "clean": "bob", "brand": "B", "brand_kr": ""},
]


class CanvasExportCharacterTests(unittest.TestCase):
    def detect(self, prompt_info):
        with mock.patch.object(app_module, "get_known_character_tags", return_value=KNOWN_CHARACTERS):
            return app_module.detect_canvas_export_characters(prompt_info)

    def test_character_and_base_prompts_are_both_searched(self):
        found = self.detect({
            "charPrompts": ["alice"],
            "basePrompt": "bob",
        })

        self.assertEqual([item["clean"] for item in found], ["alice", "bob"])

    def test_like_matching_respects_word_boundaries(self):
        self.assertEqual(
            [item["clean"] for item in self.detect({"basePrompt": "alice cosplay"})],
            ["alice"],
        )
        self.assertEqual(self.detect({"basePrompt": "malice"}), [])

    def test_short_ascii_aliases_require_an_exact_token(self):
        known_rows = [
            {"tag": "ta", "clean": "Ta", "brand": "A", "brand_kr": ""},
            {"tag": "holo", "clean": "Holo", "brand": "H", "brand_kr": ""},
            {"tag": "ikuta_haruki", "clean": "Ikuta Haruki", "brand": "I", "brand_kr": ""},
        ]
        with mock.patch.object(app_module, "get_known_character_tags", return_value=known_rows):
            prose = app_module.detect_canvas_export_characters({
                "basePrompt": "Ta is standing beside Ikuta Haruki"
            })
            exact = app_module.detect_canvas_export_characters({
                "basePrompt": "Ta, Ikuta Haruki is standing"
            })
            holo_prose = app_module.detect_canvas_export_characters({
                "basePrompt": "Holo is standing in the scene"
            })
            holo_exact = app_module.detect_canvas_export_characters({"basePrompt": "Holo"})

        self.assertEqual([item["clean"] for item in prose], ["Ikuta Haruki"])
        self.assertEqual({item["clean"] for item in exact}, {"Ta", "Ikuta Haruki"})
        self.assertEqual(holo_prose, [])
        self.assertEqual([item["clean"] for item in holo_exact], ["Holo"])

    def test_generic_tags_are_not_counted_but_real_characters_are(self):
        known_rows = [
            {"tag": "boy", "clean": "Boy", "brand": "", "brand_kr": ""},
            {"tag": "girl", "clean": "Girl", "brand": "", "brand_kr": ""},
            {"tag": "2boys", "clean": "2boys", "brand": "", "brand_kr": ""},
            {"tag": "1girl", "clean": "1girl", "brand": "", "brand_kr": ""},
            {"tag": "ikuta_haruki", "clean": "Ikuta Haruki", "brand": "", "brand_kr": ""},
        ]
        with mock.patch.object(app_module, "get_known_character_tags", return_value=known_rows):
            found = app_module.detect_canvas_export_characters({
                "basePrompt": "boy, girl, 2boys, 1girl, Ikuta Haruki is standing",
            })

        self.assertEqual([item["clean"] for item in found], ["Ikuta Haruki"])

    def test_generic_words_inside_real_names_are_not_blocked(self):
        known_rows = [
            {"tag": "cowboy_bebop", "clean": "Cowboy Bebop", "brand": "", "brand_kr": ""},
            {"tag": "boy_name", "clean": "Boy Name", "brand": "", "brand_kr": ""},
        ]
        with mock.patch.object(app_module, "get_known_character_tags", return_value=known_rows):
            found = app_module.detect_canvas_export_characters({
                "basePrompt": "cowboy bebop is here, Boy Name is here",
            })

        self.assertEqual(
            [item["clean"] for item in found],
            ["Cowboy Bebop", "Boy Name"],
        )

    def test_repeated_character_counts_as_solo(self):
        found = self.detect({"charPrompts": ["alice", "alice"]})

        self.assertEqual(len(found), 1)
        self.assertEqual(
            app_module.build_canvas_export_folder(found, False).split(os.sep)[-2],
            "1_Solo",
        )

    def test_repeated_characters_across_fields_count_as_duo(self):
        found = self.detect({
            "charPrompts": ["alice", "alice", "bob"],
            "basePrompt": "alice, bob",
        })

        self.assertEqual([item["clean"] for item in found], ["alice", "bob"])
        self.assertIn("2_Duo", app_module.build_canvas_export_folder(found, False))

    def test_normalized_aliases_do_not_double_count_same_prompt(self):
        found = self.detect({
            "charPrompts": ["alice"],
            "charPrompt": "alice",
            "basePrompt": "bob",
            "baseCaption": "bob",
        })

        self.assertEqual([item["clean"] for item in found], ["alice", "bob"])

    def test_duplicate_known_character_rows_do_not_create_fake_duo(self):
        duplicate_rows = [
            {"tag": "alice", "clean": "alice", "brand": "A", "brand_kr": ""},
            {"tag": "alice_dakimakura", "clean": "alice", "brand": "A", "brand_kr": ""},
        ]
        with mock.patch.object(app_module, "get_known_character_tags", return_value=duplicate_rows):
            found = app_module.detect_canvas_export_characters({"basePrompt": "alice"})

        self.assertEqual(len(found), 1)
        self.assertIn("1_Solo", app_module.build_canvas_export_folder(found, False))


if __name__ == "__main__":
    unittest.main()
