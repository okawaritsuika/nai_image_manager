"""Real Tk checks for confirmation results, keyboard cancellation and modality."""
import os
from pathlib import Path
import subprocess
import sys
import tkinter as tk
import types
import unittest
from unittest import mock

from naim import desktop_dialogs as dialogs
from naim import desktop_theme as theme


RUN_TK_CHILD = False


def descendants(parent):
    for child in parent.winfo_children():
        yield child
        yield from descendants(child)


class DesktopDialogTests(unittest.TestCase):
    def test_real_tk_confirmation_results_keyboard_and_nested_grab(self):
        if not RUN_TK_CHILD:
            code = ("import sys, unittest; sys.path.insert(0, 'tests'); "
                    "import test_desktop_dialogs as m; m.RUN_TK_CHILD=True; "
                    "unittest.main(module=m, verbosity=2)")
            env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1', PYTHONIOENCODING='utf-8')
            env.pop('PYTHONPATH', None)
            result = subprocess.run([sys.executable, '-B', '-c', code],
                cwd=Path(__file__).resolve().parents[1], env=env, capture_output=True,
                text=True, encoding='utf-8', errors='replace', timeout=45,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            if 'skipped=1' in result.stderr:
                self.skipTest(result.stderr)
            return
        try:
            root = tk.Tk()
        except tk.TclError as error:
            self.skipTest(str(error))
        root.attributes('-alpha', 0.0)
        root.geometry('750x650')
        root.update()
        configure = theme.configure_window

        def configure_hidden(window, title=None):
            configure(window, title)
            window.attributes('-alpha', 0.0)

        def run_dialog(call, response, expected_text=(), parent=root):
            errors = []

            def respond():
                windows = [child for child in parent.winfo_children() if isinstance(child, tk.Toplevel)]
                window = windows[-1]
                try:
                    self.assertEqual(window.cget('bg'), theme.BG)
                    self.assertEqual(root.grab_current(), window)
                    labels = [str(child.cget('text')) for child in descendants(window) if isinstance(child, tk.Label)]
                    for text in expected_text:
                        self.assertIn(text, labels)
                    if response == '~close':
                        window.tk.call(window.protocol('WM_DELETE_WINDOW'))
                    elif response in ('~escape', '~return'):
                        window.focus_force()
                        window.event_generate('<Escape>' if response == '~escape' else '<Return>')
                    else:
                        button = next(child for child in descendants(window)
                                      if isinstance(child, tk.Button) and child.cget('text') == response)
                        button.invoke()
                except Exception as error:
                    errors.append(error)
                    window.destroy()

            root.after(50, respond)
            result = call()
            if errors:
                raise errors[0]
            return result

        try:
            with mock.patch.object(theme, 'configure_window', side_effect=configure_hidden):
                message = '원본 유지\n현재 자료는 백업 후 교체합니다.'
                for function in (dialogs.showinfo, dialogs.showwarning, dialogs.showerror):
                    self.assertEqual(run_dialog(lambda: function('알림', message, parent=root),
                                                '확인', (message,)), 'ok')
                for response, expected in (('예', True), ('아니요', False), ('~close', False), ('~escape', False)):
                    self.assertIs(run_dialog(lambda: dialogs.askyesno('질문', message, parent=root), response), expected)
                for response, expected in (('예', True), ('아니요', False), ('취소', None), ('~close', None), ('~escape', None)):
                    self.assertIs(run_dialog(lambda: dialogs.askyesnocancel('질문', message, parent=root), response), expected)
                self.assertFalse(run_dialog(lambda: dialogs.askyesno('질문', message, parent=root, default='no'), '~return'))
                root.grab_set()
                self.assertTrue(run_dialog(lambda: dialogs.askyesno('중첩 확인', message, parent=root), '예'))
                self.assertEqual(root.grab_current(), root)
                root.grab_release()
                controller = types.SimpleNamespace(root=root)
                warning = '메타데이터 보존 검증 후 분류된 PNG를 삭제합니다. 입력 원본은 유지합니다.'
                action = lambda: dialogs.action_confirm(
                    controller, '실행 확인', '', '대상', 'synthetic/input', '방식', '복사',
                    '원본 유지', [{'label': 'GPU', 'value': '켜짐', 'state': True}],
                    '작업 시작', '#000000', warning_text=warning)
                self.assertTrue(run_dialog(action, '작업 시작', (warning, 'synthetic/input', '원본 유지')))
                self.assertTrue(run_dialog(action, '~return'))
                self.assertFalse(run_dialog(action, '~escape'))
                for response, expected in (('전체 재정렬 선택', 'all'), ('부분 재정렬 선택', 'partial'), ('취소', None)):
                    self.assertEqual(run_dialog(lambda: dialogs.choose_reorg_target(controller), response), expected)
        finally:
            for callback in root.tk.splitlist(root.tk.call('after', 'info')):
                root.after_cancel(callback)
            root.destroy()


if __name__ == '__main__':
    unittest.main()
