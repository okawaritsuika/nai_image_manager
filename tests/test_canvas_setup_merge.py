import copy
import unittest

from naim.images.canvas_setups import apply_canvas_saved_setup_patch


def setup(setup_id, saved_at, **extra):
    return {
        "id": setup_id,
        "name": setup_id,
        "savedAt": saved_at,
        "state": {"width": 64, "height": 64, "layers": []},
        **extra,
    }


class CanvasSetupPatchTests(unittest.TestCase):
    def test_interleaved_upserts_and_stale_delete_preserve_independent_records(self):
        existing = [setup("base", 1), setup("delete-me", 2)]

        after_a = apply_canvas_saved_setup_patch(existing, [setup("pane-a", 3)], [])
        after_b = apply_canvas_saved_setup_patch(after_a, [setup("pane-b", 4)], [])
        after_delete = apply_canvas_saved_setup_patch(after_b, [], ["delete-me"])

        self.assertEqual(
            {item["id"] for item in after_delete},
            {"base", "pane-a", "pane-b"},
        )

    def test_replace_and_unrelated_records_preserve_unknown_metadata(self):
        existing = [
            setup("replace", 1, existingMetadata={"keep": True}),
            setup("untouched", 2, futureField={"value": 7}),
        ]
        replacement = setup("replace", 3, upsertMetadata={"keep": "also"})

        result = apply_canvas_saved_setup_patch(existing, [replacement], [])
        by_id = {item["id"]: item for item in result}

        self.assertEqual(by_id["replace"]["upsertMetadata"], {"keep": "also"})
        self.assertNotIn("existingMetadata", by_id["replace"])
        self.assertEqual(by_id["untouched"]["futureField"], {"value": 7})
        self.assertEqual(existing[0]["existingMetadata"], {"keep": True})

    def test_invalid_patch_changes_raise_without_mutating_existing(self):
        existing = [setup("keep", 1, unknown={"value": 9})]
        original = copy.deepcopy(existing)
        invalid_patches = [
            (None, []),
            ([], None),
            ([{"id": "missing-state"}], []),
            ([{"id": "  ", "state": {}}], []),
            ([{"id": "bad-state", "state": []}], []),
            ([setup("duplicate", 1), setup("duplicate", 2)], []),
            ([], [""]),
            ([], [None]),
        ]

        for upserts, remove_ids in invalid_patches:
            with self.subTest(upserts=upserts, remove_ids=remove_ids):
                with self.assertRaises(ValueError):
                    apply_canvas_saved_setup_patch(existing, upserts, remove_ids)
                self.assertEqual(existing, original)


if __name__ == "__main__":
    unittest.main()
