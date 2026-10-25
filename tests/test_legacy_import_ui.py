from pathlib import Path
import os
import subprocess
import sys
import tempfile
import time
import tkinter as tk
import unittest
from unittest import mock

from naim import legacy_import_ui

RUN_TK_CHILD = False


class LegacyImportUiTests(unittest.TestCase):
    def test_choose_preview_confirm_import_and_enable_restart(self):
        if not RUN_TK_CHILD:
            # Keep the remaining real-Tk test out of worker-thread GC in the suite.
            code = ("import sys, unittest; sys.path.insert(0, 'tests'); "
                    "import test_legacy_import_ui as m; m.RUN_TK_CHILD = True; "
                    "unittest.main(module=m, verbosity=2)")
            env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1', PYTHONIOENCODING='utf-8')
            env.pop('PYTHONPATH', None)
            result = subprocess.run([sys.executable, '-B', '-c', code],
                cwd=Path(__file__).resolve().parents[1], env=env, capture_output=True,
                text=True, encoding='utf-8', errors='replace', timeout=45,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            if 'skipped=1' in result.stderr: self.skipTest(result.stderr)
            return
        try:
            root = tk.Tk()
        except tk.TclError as error:
            self.skipTest(str(error))
        root.withdraw()
        self.addCleanup(root.destroy)
        with tempfile.TemporaryDirectory() as temporary:
            source, target = Path(temporary) / 'old', Path(temporary) / 'new'
            source.mkdir(); target.mkdir()
            (source / 'gallery_config.json').write_text('{"synthetic":true}')
            probe = mock.MagicMock()
            probe.__enter__.return_value.connect_ex.return_value = 1

            def exercise():
                buttons = {widget.cget('text'): widget for widget in root.winfo_children() if isinstance(widget, tk.Button)}
                buttons['기존 프로그램 폴더 선택'].invoke()
                preview = next(widget for widget in root.winfo_children() if isinstance(widget, tk.Text))
                self.assertIn('gallery_config.json', preview.get('1.0', 'end'))
                self.assertEqual(str(buttons['표시된 자료 가져오기'].cget('state')), 'normal')
                buttons['표시된 자료 가져오기'].invoke()
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and str(buttons['프로그램 열기'].cget('state')) == 'disabled':
                    root.update()
                    time.sleep(0.01)
                self.assertEqual(str(buttons['프로그램 열기'].cget('state')), 'normal')
                self.assertEqual((target / 'gallery_config.json').read_bytes(), (source / 'gallery_config.json').read_bytes())

            with mock.patch.object(legacy_import_ui.tk, 'Tk', return_value=root), \
                 mock.patch.object(root, 'mainloop', side_effect=exercise), \
                 mock.patch.object(legacy_import_ui.filedialog, 'askdirectory', return_value=str(source)), \
                 mock.patch.object(legacy_import_ui.messagebox, 'askyesno', return_value=True), \
                 mock.patch.object(legacy_import_ui.messagebox, 'showinfo'), \
                 mock.patch.object(legacy_import_ui.messagebox, 'showerror') as error_dialog, \
                 mock.patch.object(legacy_import_ui.socket, 'socket', return_value=probe):
                legacy_import_ui.run(target)
            error_dialog.assert_not_called()
