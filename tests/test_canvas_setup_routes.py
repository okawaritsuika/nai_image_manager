import ast
import copy
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

from flask import Flask, jsonify, request

from naim.images.canvas_setups import (
    apply_canvas_saved_setup_patch,
    normalize_canvas_saved_setups,
)


APP_SOURCE = Path(__file__).resolve().parents[1] / "app.py"
ROUTE_NAMES = {"get_canvas_saved_setups", "set_canvas_saved_setups"}


def setup(setup_id, saved_at=1, **extra):
    return {
        "id": setup_id,
        "name": setup_id,
        "savedAt": saved_at,
        "state": {"width": 64, "height": 64, "layers": []},
        **extra,
    }


def make_isolated_routes(initial=None, load_delay=0):
    """Compile only the real route bodies with an in-memory storage boundary."""
    storage = normalize_canvas_saved_setups(copy.deepcopy(initial or []))
    save_calls = []

    def load_canvas_saved_setups():
        snapshot = copy.deepcopy(storage)
        if load_delay:
            time.sleep(load_delay)
        return snapshot

    def save_canvas_saved_setups(setups):
        save_calls.append(copy.deepcopy(setups))
        storage[:] = normalize_canvas_saved_setups(copy.deepcopy(setups))
        return copy.deepcopy(storage)

    tree = ast.parse(APP_SOURCE.read_text(encoding="utf-8"), filename=str(APP_SOURCE))
    route_nodes = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in ROUTE_NAMES:
            isolated_node = copy.deepcopy(node)
            isolated_node.decorator_list = []
            route_nodes.append(isolated_node)

    if {node.name for node in route_nodes} != ROUTE_NAMES:
        raise AssertionError("Could not find both canvas setup route functions in app.py")

    namespace = {
        "CANVAS_SETUPS_LOCK": threading.RLock(),
        "apply_canvas_saved_setup_patch": apply_canvas_saved_setup_patch,
        "jsonify": jsonify,
        "load_canvas_saved_setups": load_canvas_saved_setups,
        "request": request,
        "save_canvas_saved_setups": save_canvas_saved_setups,
        "sys": SimpleNamespace(frozen=False),
    }
    module = ast.fix_missing_locations(ast.Module(body=route_nodes, type_ignores=[]))
    exec(compile(module, str(APP_SOURCE), "exec"), namespace)

    app = Flask(__name__)
    app.add_url_rule(
        "/api/canvas/setups",
        endpoint="get_canvas_saved_setups",
        view_func=namespace["get_canvas_saved_setups"],
        methods=["GET"],
    )
    app.add_url_rule(
        "/api/canvas/setups",
        endpoint="set_canvas_saved_setups",
        view_func=namespace["set_canvas_saved_setups"],
        methods=["POST"],
    )
    app.add_url_rule(
        "/api/canvas/setups/patch", endpoint="patch_canvas_saved_setups",
        view_func=namespace["set_canvas_saved_setups"], methods=["POST"],
    )
    return app, storage, save_calls


class CanvasSetupRouteTests(unittest.TestCase):
    def test_get_and_legacy_full_list_post_keep_existing_contract(self):
        app, storage, save_calls = make_isolated_routes([setup("old", 1)])
        client = app.test_client()

        response = client.get("/api/canvas/setups")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["status"], "success")
        self.assertEqual(response.json["count"], 1)
        self.assertTrue(response.json["allowLegacyMigration"])

        replacement = setup("legacy-full-list", 2, customMetadata={"keep": True})
        response = client.post("/api/canvas/setups", json={"setups": [replacement]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["setups"][0]["id"], "legacy-full-list")
        self.assertEqual(storage[0]["customMetadata"], {"keep": True})
        self.assertEqual(len(save_calls), 1)

    def test_patch_upsert_and_delete_preserve_unaffected_records(self):
        app, storage, _ = make_isolated_routes([
            setup("update", 1, oldMetadata={"field": "preserved by caller copy"}),
            setup("untouched", 2, futureField={"value": 8}),
        ])
        client = app.test_client()

        updated = setup("update", 3, updatedMetadata={"value": True})
        added = setup("added", 4)
        response = client.post(
            "/api/canvas/setups",
            json={"upserts": [updated, added]},
        )
        self.assertEqual(response.status_code, 200)
        by_id = {item["id"]: item for item in response.json["setups"]}
        self.assertEqual(by_id["update"]["updatedMetadata"], {"value": True})
        self.assertNotIn("oldMetadata", by_id["update"])
        self.assertEqual(by_id["untouched"]["futureField"], {"value": 8})

        response = client.post(
            "/api/canvas/setups",
            json={"removeIds": ["update"]},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual({item["id"] for item in response.json["setups"]}, {"untouched", "added"})
        self.assertEqual({item["id"] for item in storage}, {"untouched", "added"})

    def test_mixed_or_invalid_patch_returns_400_without_saving(self):
        app, storage, save_calls = make_isolated_routes([setup("preserve", 1)])
        original = copy.deepcopy(storage)
        client = app.test_client()

        invalid_bodies = [
            [], ["invalid"], None,
            {"setups": [], "upserts": []},
            {"upserts": "not-an-array"},
            {"removeIds": "not-an-array"},
            {"upserts": [{"id": "missing-state"}]},
        ]
        for body in invalid_bodies:
            with self.subTest(body=body):
                response = client.post("/api/canvas/setups", json=body)
                self.assertEqual(response.status_code, 400)
                self.assertIn("message", response.json)
                self.assertEqual(storage, original)

        self.assertEqual(save_calls, [])

    def test_concurrent_patches_do_not_erase_each_other(self):
        app, storage, _ = make_isolated_routes([setup("base", 1)], load_delay=0.05)
        start = threading.Barrier(2)

        def post_patch(item):
            with app.test_client() as client:
                start.wait(timeout=3)
                response = client.post("/api/canvas/setups/patch", json={"upserts": [item]})
                return response.status_code, response.json

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [
                pool.submit(post_patch, setup("pane-a", 2)),
                pool.submit(post_patch, setup("pane-b", 3)),
            ]
            results = [future.result(timeout=5) for future in futures]

        self.assertEqual([status for status, _ in results], [200, 200])
        self.assertEqual({item["id"] for item in storage}, {"base", "pane-a", "pane-b"})


if __name__ == "__main__":
    unittest.main()
