import json
import os
from contextlib import nullcontext
import runpy
import subprocess
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

from PIL import Image
from PIL.PngImagePlugin import PngInfo
from naim.images import comics
import image_logic
from utils import HistoryDB


RUN_TK_CHILD = False


def png(path, color="red", size=(12, 10), note="", mode="RGB"):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    info = PngInfo()
    info.add_text("Comment", note)
    Image.new(mode, size, color).save(path, pnginfo=info)
    return str(path)


class ComicPixelTests(unittest.TestCase):
    def test_metadata_and_rgb_rgba_do_not_prevent_matching(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            page = png(root / "session/comic_maker/book/page_001.png", note="one")
            outside = png(root / "session/generated.png", color=(255, 0, 0, 254), note="two", mode="RGBA")
            different = png(root / "session/different.png", color="blue")
            other_session = png(root / "another/generated.png")
            second_comic = png(root / "session/comic_maker/other/page_001.png")
            paths = [page, outside, different, other_session, second_comic]
            groups, by_path = comics.collect_comics(paths)
            result = comics.find_comic_duplicates(paths, groups, by_path)
            self.assertEqual(result, {outside: page})

    def test_different_dimensions_are_not_decoded(self):
        with tempfile.TemporaryDirectory() as temp:
            path = png(Path(temp) / "small.png")
            with mock.patch.object(Image.Image, "convert", side_effect=AssertionError("decoded")):
                self.assertIsNone(comics.pixel_digest(path, {(100, 100)}))

    def test_one_changed_pixel_is_not_a_duplicate(self):
        with tempfile.TemporaryDirectory() as temp:
            first = png(Path(temp) / "first.png")
            second = Path(temp) / "second.png"
            with Image.open(first) as image:
                image.putpixel((11, 9), (1, 2, 3))
                image.save(second)
            self.assertNotEqual(comics.pixel_digest(first), comics.pixel_digest(second))

    def test_delete_requires_success_and_rechecks_pixels(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            outside = png(root / "outside.png")
            imported = png(root / "imported.png")
            duplicate = {outside: "page"}
            self.assertEqual(comics.delete_imported_duplicates(duplicate, {}), 0)
            png(outside, color="blue")
            self.assertEqual(comics.delete_imported_duplicates(duplicate, {"page": imported}), 0)
            png(outside)
            self.assertEqual(comics.delete_imported_duplicates(duplicate, {"page": imported}), 1)
            self.assertTrue(Path(imported).exists())

    def test_cancel_prevents_comparison_and_deletion(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            page = png(root / "session/comic_maker/book/page.png")
            outside = png(root / "session/outside.png")
            groups, by_path = comics.collect_comics([page, outside])
            self.assertEqual(comics.find_comic_duplicates([page, outside], groups, by_path, lambda: True), {})
            self.assertEqual(comics.delete_imported_duplicates({outside: page}, {page: page}, lambda: True), 0)
            self.assertTrue(Path(outside).exists())


class ComicClassificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.output = self.root / "TOTAL_CLASSIFIED"
        self.db_path = self.output / "naia_history.db"
        db = HistoryDB(self.db_path)
        db.conn.executemany("INSERT OR IGNORE INTO known_characters(tag, clean_name) VALUES (?, ?)",
                            [("alpha_hero", "Alpha Hero"), ("beta_hero", "Beta Hero")])
        db.conn.commit()
        db.close()
        self.pages = [png(self.source / "session/comic_maker/book/page_001.png"),
                      png(self.source / "session/comic_maker/book/page_002.png", color="blue")]
        self.outside = png(self.source / "session/outside.png", note="different metadata")
        (Path(self.pages[0]).parent / "comic_plan.json").write_text(json.dumps({"title": "Synthetic Book"}), encoding="utf-8")

    def run_process(self, real_analysis=False, **kwargs):
        def analyze(path, **_options):
            second = Path(path).name == "page_002.png"
            return (path, HistoryDB.get_hash(None, path), [],
                    ["beta_hero" if second else "alpha_hero"], 2 if second else 0, [], "v5")
        with mock.patch.object(sys, "argv", [str(self.root / "main.py")]), \
             mock.patch.object(image_logic.utils, "HistoryDB", side_effect=lambda: HistoryDB(self.db_path)), \
             mock.patch.object(image_logic.utils, "load_config", return_value={}), \
             (nullcontext() if real_analysis else mock.patch.object(image_logic, "analyze_file_worker", side_effect=analyze)):
            image_logic.process(str(self.source), log_func=lambda _text: None, **kwargs)

    def test_whole_comic_rating_cast_and_duplicate_preserved_by_default(self):
        self.run_process()
        folder = self.output / "_R-18/comic/book"
        self.assertEqual(len(list(folder.glob("*.png"))), 2)
        self.assertEqual(len(list(self.output.rglob("*.png"))), 2)
        self.assertTrue(Path(self.outside).exists())
        data = comics.read_comic(folder)
        self.assertEqual(data["characters"], ["Alpha Hero", "Beta Hero"])
        self.assertEqual(data["rating"], 2)
        self.assertEqual(data["title"], "Synthetic Book")
        db = HistoryDB(self.db_path)
        try:
            rows = db.conn.execute("SELECT character_names FROM gallery_images").fetchall()
            self.assertEqual(len(rows), 2)
            self.assertTrue(all(json.loads(row[0]) == data["characters"] for row in rows))
            self.assertIsNone(db.conn.execute("SELECT tag FROM known_characters WHERE tag='book'").fetchone())
        finally:
            db.close()

    def test_opt_in_deletes_only_outside_duplicate(self):
        self.run_process(delete_comic_duplicates=True)
        self.assertFalse(Path(self.outside).exists())
        self.assertTrue(all(Path(p).exists() for p in self.pages))

    def test_failed_import_keeps_outside_duplicate(self):
        with mock.patch.object(image_logic, "file_io_worker", return_value=False):
            self.run_process(delete_comic_duplicates=True)
        self.assertTrue(Path(self.outside).exists())

    def test_move_without_delete_keeps_outside_duplicate(self):
        self.run_process(method="move")
        self.assertTrue(Path(self.outside).exists())
        self.assertTrue(all(not Path(p).exists() for p in self.pages))

    def test_repeat_import_keeps_pages_together_with_fast_history(self):
        self.run_process()
        self.run_process(delete_comic_duplicates=True)
        self.assertEqual(len(list(self.output.rglob("*.png"))), 2)
        self.assertFalse(Path(self.outside).exists())

    def test_reorder_retains_comic_identity_and_cast(self):
        self.run_process()
        self.run_process(reorg_mode=True, skip_nsfw=True)
        folder = self.output / "comic/book"
        self.assertEqual(len(list(folder.glob("*.png"))), 2)
        self.assertEqual(comics.read_comic(folder)["characters"], ["Alpha Hero", "Beta Hero"])
        db = HistoryDB(self.db_path)
        try:
            rows = db.conn.execute("SELECT rel_path FROM gallery_images").fetchall()
            self.assertEqual(len(rows), 2)
            self.assertTrue(all(row[0].startswith("comic/book/") for row in rows))
        finally:
            db.close()

    def test_snapshot_supplies_cast_without_page_character_tags(self):
        folder = Path(self.pages[0]).parent
        (folder / "character_snapshot.json").write_text(json.dumps({"prompts": {"slot": "alpha_hero, blue eyes"}}), encoding="utf-8")
        groups, _ = comics.collect_comics(self.pages)
        self.assertIn("alpha_hero", groups[str(folder)]["prompt_tags"])

    def test_same_folder_name_in_different_sessions_does_not_merge_comics(self):
        png(self.source / "second_session/comic_maker/book/page_001.png", color="green")
        png(self.source / "second_session/comic_maker/book/page_002.png", color="yellow")
        self.run_process()
        books = list((self.output / "comic").glob("*/_comic.json"))
        adult_books = list((self.output / "_R-18/comic").glob("*/_comic.json"))
        self.assertEqual(len(books) + len(adult_books), 2)
        self.assertEqual(len(list(self.output.rglob("*.png"))), 4)

    def test_conflicting_destination_keeps_entire_comic_and_manifest(self):
        self.run_process()
        folder = self.output / "_R-18/comic/book"
        before = (folder / comics.MANIFEST).read_bytes()
        png(folder / "page_001.png", color="green")
        (folder / "page_002.png").unlink()
        self.run_process(delete_comic_duplicates=True)
        self.assertEqual((folder / comics.MANIFEST).read_bytes(), before)
        self.assertFalse((folder / "page_002.png").exists())
        self.assertTrue(Path(self.outside).exists())

    def test_real_metadata_is_preserved_before_outside_deletion(self):
        note = json.dumps({"prompt": "alpha_hero, outdoors", "rating": "e"})
        png(self.outside, note=note, mode="RGBA", color=(255, 0, 0, 254))
        self.run_process(real_analysis=True, delete_comic_duplicates=True)
        folder = self.output / "_R-18/comic/book"
        self.assertEqual(len(list(folder.glob("*.png"))), 2)
        self.assertFalse(Path(self.outside).exists())
        self.assertIn("Alpha Hero", comics.read_comic(folder)["characters"])
        sidecar = json.loads((folder / "page_001.json").read_text(encoding="utf-8"))
        self.assertEqual(sidecar["basePrompt"], "alpha_hero, outdoors")
        self.assertEqual(comics.pixel_digest(folder / "page_001.png"), comics.pixel_digest(self.pages[0]))

    def test_unreadable_page_keeps_whole_comic_and_outside(self):
        Path(self.pages[1]).write_bytes(b"broken synthetic PNG")
        self.run_process(real_analysis=True, delete_comic_duplicates=True)
        self.assertEqual(list(self.output.rglob("*.png")), [])
        self.assertTrue(all(Path(p).exists() for p in self.pages))
        self.assertTrue(Path(self.outside).exists())


class ComicGalleryTests(unittest.TestCase):
    setUp = ComicClassificationTests.setUp
    run_process = ComicClassificationTests.run_process
    def test_scan_and_index_show_title_cast_and_page_order(self):
        import app
        self.run_process()
        with mock.patch.object(app, "CLASSIFIED_DIR", str(self.output)), \
             mock.patch.object(app.utils, "HistoryDB", side_effect=lambda: HistoryDB(self.db_path)), \
             mock.patch.object(app, "load_gallery_image_tags_config", return_value={"tags": [], "image_tags": {}}):
            for build in (app.build_gallery_data_payload_from_scan, app.build_gallery_data_payload_from_index):
                result = build("r18", "name")
                group = next(node for node in result["tree"]["folders"] if node["name"] == "comic")
                book = group["folders"][0]
                self.assertTrue(book["is_comic"])
                self.assertEqual(book["name"], "Synthetic Book")
                self.assertEqual(book["char_names"], ["Alpha Hero", "Beta Hero"])
                self.assertEqual([p["name"] for p in book["images"]], ["page_001.png", "page_002.png"])


class ComicRemoteControlTests(unittest.TestCase):
    def test_checkbox_defaults_off_and_passes_saved_choice_to_worker(self):
        if not RUN_TK_CHILD:
            # Mock call histories retain controller callbacks in cycles. Keep their
            # Tcl interpreter out of later tests' worker-thread garbage collection.
            child_env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="utf-8")
            child_env.pop("PYTHONPATH", None)
            child_code = (
                "import sys, unittest; sys.path.insert(0, 'tests'); "
                "import test_comics as module; module.RUN_TK_CHILD = True; "
                "unittest.main(module=module, verbosity=2, argv=['test_comics', "
                "'ComicRemoteControlTests.test_checkbox_defaults_off_and_passes_saved_choice_to_worker'])"
            )
            completed = subprocess.run(
                [sys.executable, "-B", "-c", child_code], cwd=Path(__file__).resolve().parents[1],
                env=child_env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace", timeout=45,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            self.assertEqual(completed.returncode, 0, completed.stdout)
            if "skipped=1" in completed.stdout:
                self.skipTest(completed.stdout.strip())
            return
        import tkinter as tk
        try:
            root = tk.Tk()
        except tk.TclError as error:
            self.skipTest(str(error))
        root.withdraw()
        self.addCleanup(root.destroy)
        namespace = runpy.run_path(str(Path(__file__).resolve().parents[1] / "main_executor.pyw"))
        controller_class = namespace["NaiaHyperExecutor"]
        with tempfile.TemporaryDirectory() as temp, \
             mock.patch.object(namespace["utils"], "load_config", return_value={"path": temp}), \
             mock.patch.object(namespace["utils"], "save_config") as save, \
             mock.patch.object(controller_class, "check_port_on_startup"), \
             mock.patch.object(controller_class, "update_thread_guide"):
            controller = controller_class(root)
            self.assertFalse(controller.delete_comic_duplicates_var.get())
            def descendants(widget):
                for child in widget.winfo_children():
                    yield child
                    yield from descendants(child)
            checkbox = next(widget for widget in descendants(root) if isinstance(widget, tk.Checkbutton)
                            and str(widget.cget("text")).startswith("코믹 가져오기"))
            checkbox.invoke()
            controller.save_classify_settings(silent=True)
            self.assertTrue(save.call_args.args[0]["classify_settings"]["delete_comic_duplicates"])
            with mock.patch.object(controller, "show_action_confirm_dialog", return_value=True), \
                 mock.patch.dict(controller.start_process.__globals__, {"Thread": mock.MagicMock()}) as globals_map:
                controller.start_process()
                args = globals_map["Thread"].call_args.kwargs["args"]
                self.assertTrue(args[-1])
                with mock.patch.object(image_logic, "process") as process:
                    controller._logic_thread(*args)
                self.assertTrue(process.call_args.kwargs["delete_comic_duplicates"])


if __name__ == "__main__":
    unittest.main()
