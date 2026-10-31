import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import tkinter as tk
import unittest
from tkinter import ttk
from types import SimpleNamespace
from unittest import mock

from naim import style_connection, style_connection_ui


RUN_TK_CHILD = False


def _widgets(parent):
    result = []
    pending = [parent]
    while pending:
        widget = pending.pop()
        result.append(widget)
        try:
            pending.extend(widget.winfo_children())
        except tk.TclError:
            pass
    return result


def _button(window, title):
    return next(widget for widget in _widgets(window)
                if isinstance(widget, tk.Button) and widget.cget("text") == title)


def _wait_until(root, predicate, timeout=1):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        root.update()
        if predicate():
            return True
        time.sleep(0.01)
    root.update()
    return predicate()


def _after_ids(widget):
    return set(widget.tk.splitlist(widget.tk.call("after", "info")))


class StyleConnectionUiTests(unittest.TestCase):
    def test_dialog_flows(self):
        if not RUN_TK_CHILD:
            code = (
                "import sys, unittest; sys.path.insert(0, 'tests'); "
                "import test_style_connection_ui as m; m.RUN_TK_CHILD = True; "
                "unittest.main(module=m, verbosity=2)"
            )
            env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="utf-8")
            env.pop("PYTHONPATH", None)
            result = subprocess.run(
                [sys.executable, "-B", "-c", code],
                cwd=Path(__file__).resolve().parents[1], env=env,
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=45, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            if "skipped=1" in result.stderr:
                self.skipTest(result.stderr)
            return

        try:
            root = tk.Tk()
        except tk.TclError as error:
            self.skipTest(str(error))
        root.withdraw()
        self.addCleanup(root.destroy)

        with tempfile.TemporaryDirectory() as temporary:
            app_dir = Path(temporary)
            current = {"source_dir": str(app_dir / "old-style"), "data_dir": str(app_dir / "old-data")}
            source = str(app_dir / ("style-" + "s" * 130))
            candidate_one = str(app_dir / "candidate-one")
            candidate_two = str(app_dir / "candidate-two")
            preview = SimpleNamespace(
                selected_dir=source,
                source_dir=source,
                data_dir=candidate_one,
                python="python.exe",
                key_choice_required=True,
                current_key_present=True,
                source_key_present=True,
                settings_present=True,
            )
            ambiguity = style_connection.AmbiguousDataDirectories((candidate_one, candidate_two))
            info_events = []
            saved_callback = mock.Mock(side_effect=lambda: info_events.append("saved"))

            with mock.patch.object(style_connection, "current_connection", return_value=current), \
                 mock.patch.object(style_connection, "inspect_connection", side_effect=[ambiguity, preview]) as inspect, \
                 mock.patch.object(style_connection, "save_connection") as save_connection, \
                 mock.patch.object(style_connection_ui.filedialog, "askdirectory", return_value=source), \
                 mock.patch.object(style_connection_ui.messagebox, "showerror") as showerror, \
                 mock.patch.object(
                     style_connection_ui.messagebox, "showinfo",
                     side_effect=lambda *args, **kwargs: info_events.append("info"),
                 ):
                window = style_connection_ui.open_style_connection(
                    root, app_dir, on_saved=saved_callback,
                )
                root.update()
                choose = _button(window, "프로그램 폴더 선택")
                body_canvas = next(widget for widget in _widgets(window)
                                   if isinstance(widget, tk.Canvas))
                self.assertGreaterEqual(choose.winfo_rooty(), body_canvas.winfo_rooty())
                self.assertLessEqual(
                    choose.winfo_rooty() + choose.winfo_height(),
                    body_canvas.winfo_rooty() + body_canvas.winfo_height(),
                )
                choose.invoke()
                root.update()
                combos = [widget for widget in _widgets(window) if isinstance(widget, ttk.Combobox)]
                self.assertEqual(len(combos), 1)
                combo = combos[0]
                self.assertEqual(tuple(combo.cget("values")), (candidate_one, candidate_two))
                self.assertTrue(_wait_until(root, lambda: (
                    combo.winfo_rooty() >= body_canvas.winfo_rooty()
                    and combo.winfo_rooty() + combo.winfo_height()
                    <= body_canvas.winfo_rooty() + body_canvas.winfo_height()
                )), "ambiguous-data selector did not scroll into the visible body")
                combo.set(candidate_one)
                combo.event_generate("<<ComboboxSelected>>")
                root.update()

                self.assertEqual(inspect.call_count, 2)
                self.assertEqual(inspect.call_args.kwargs, {"data_dir": candidate_one})
                self.assertEqual(_button(window, "연결 저장").cget("state"), "disabled")
                availability = next(widget for widget in _widgets(window)
                                    if isinstance(widget, tk.Label)
                                    and "그림체 DB 확인됨" in widget.cget("text"))
                self.assertIn("독립 실행 설정 파일 있음", availability.cget("text"))
                footer_status = next(widget for widget in _widgets(window)
                                     if isinstance(widget, tk.Label) and widget.cget("textvariable"))
                self.assertIn("NAI 키를 선택", root.getvar(footer_status.cget("textvariable")))
                entries = [widget for widget in _widgets(window)
                           if isinstance(widget, tk.Entry) and widget.winfo_class() == "Entry"]
                self.assertTrue(entries)
                self.assertTrue(all(widget.cget("state") == "readonly" for widget in entries))
                self.assertTrue(all(widget.cget("xscrollcommand") for widget in entries))
                selected_entry = next(widget for widget in entries if widget.get() == source)
                selected_entry.xview_moveto(1)
                self.assertEqual(selected_entry.get(), source)

                key_radio = next(widget for widget in _widgets(window)
                                 if isinstance(widget, tk.Radiobutton)
                                 and widget.cget("text") == "그림체 프로그램 키 사용")
                self.assertTrue(_wait_until(root, lambda: (
                    key_radio.winfo_rooty() >= body_canvas.winfo_rooty()
                    and key_radio.winfo_rooty() + key_radio.winfo_height()
                    <= body_canvas.winfo_rooty() + body_canvas.winfo_height()
                )), "NAI key options did not scroll into the visible body")
                key_radio.invoke()
                root.update()
                self.assertEqual(_button(window, "연결 저장").cget("state"), "normal")
                self.assertIn("NAI 키 선택 완료", root.getvar(footer_status.cget("textvariable")))
                self.assertFalse(showerror.called)
                _button(window, "연결 저장").invoke()
                root.update()

                save_connection.assert_called_once_with(preview, key_choice="use_source")
                saved_callback.assert_called_once_with()
                self.assertEqual(info_events, ["saved", "info"])
                self.assertFalse(window.winfo_exists())

            source_again = str(app_dir / "reselected-style")
            preview_again = SimpleNamespace(
                selected_dir=source_again,
                source_dir=source_again,
                data_dir=candidate_two,
                python="python.exe",
                key_choice_required=False,
                current_key_present=True,
                source_key_present=True,
                settings_present=False,
            )
            can_save = mock.Mock(return_value=False)
            with mock.patch.object(style_connection, "current_connection", return_value=current), \
                 mock.patch.object(style_connection, "inspect_connection", side_effect=[preview_again, preview_again]), \
                 mock.patch.object(style_connection, "save_connection") as save_connection, \
                 mock.patch.object(style_connection_ui.filedialog, "askdirectory", side_effect=[source, source_again]), \
                 mock.patch.object(style_connection_ui.messagebox, "showerror") as showerror, \
                 mock.patch.object(style_connection_ui.messagebox, "showinfo"):
                window = style_connection_ui.open_style_connection(root, app_dir, can_save=can_save)
                root.update()
                _button(window, "프로그램 폴더 선택").invoke()
                root.update()
                _button(window, "연결 저장").invoke()
                root.update()
                showerror.assert_called_once_with(
                    "연결 저장",
                    "진행 중인 작업과 서버를 정지한 뒤 연결을 저장해 주세요.",
                    parent=window,
                )
                save_connection.assert_not_called()
                self.assertTrue(window.winfo_exists())
                self.assertIn(source, [widget.get() for widget in _widgets(window)
                                       if isinstance(widget, tk.Entry) and widget.winfo_class() == "Entry"])

                can_save.return_value = True
                save_connection.side_effect = RuntimeError("synthetic save failure")
                _button(window, "연결 저장").invoke()
                root.update()
                self.assertTrue(window.winfo_exists())
                self.assertTrue(any("synthetic save failure" in str(call.args[1]) for call in showerror.call_args_list))

                _button(window, "프로그램 폴더 선택").invoke()
                root.update()
                self.assertIn(source_again, [widget.get() for widget in _widgets(window)
                                             if isinstance(widget, tk.Entry) and widget.winfo_class() == "Entry"])
                _button(window, "취소").invoke()
                root.update()
                self.assertFalse(window.winfo_exists())
                self.assertEqual(save_connection.call_count, 1)

            with mock.patch.object(style_connection, "current_connection", return_value=current), \
                 mock.patch.object(style_connection, "inspect_connection", return_value=preview), \
                 mock.patch.object(style_connection, "save_connection") as save_connection, \
                 mock.patch.object(style_connection_ui.filedialog, "askdirectory", return_value=source), \
                 mock.patch.object(style_connection_ui.messagebox, "showerror"), \
                 mock.patch.object(style_connection_ui.messagebox, "showinfo"):
                window = style_connection_ui.open_style_connection(root, app_dir)
                root.update()
                before_choose = _after_ids(window)
                _button(window, "프로그램 폴더 선택").invoke()
                pending_reveals = _after_ids(window) - before_choose
                self.assertTrue(pending_reveals)
                self.assertEqual(_button(window, "연결 저장").cget("state"), "disabled")
                _button(window, "취소").invoke()
                root.update()
                self.assertFalse(window.winfo_exists())
                self.assertFalse(pending_reveals & _after_ids(root))
                save_connection.assert_not_called()


if __name__ == "__main__":
    unittest.main()
