"""Controller regressions without importing launcher code or opening user data."""
import ast
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import io
import json
import math
import os
from queue import Empty, Queue
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from threading import Event, Lock, Thread as RealThread
import tkinter as tk
from tkinter import scrolledtext
import types
import unittest
from unittest import mock


SOURCE = Path(__file__).resolve().parents[1] / "main_executor.pyw"
with mock.patch.object(sys, "path", [str(SOURCE.parent), *sys.path]):
    from naim import desktop_ui
    from naim.storage.json_files import merge_json_object
RUN_TK_CHILD = False


class Variable:
    def __init__(self, value):
        self.value = value

    def get(self):
        return self.value

    def set(self, value):
        self.value = value


class Button:
    def __init__(self):
        self.values = {"state": "normal"}

    def config(self, **kwargs):
        self.values.update(kwargs)


class Root:
    def __init__(self):
        self.callbacks = []

    def after(self, delay, callback):
        self.callbacks.append((delay, callback))

    def drain_ready(self):
        ready = [callback for delay, callback in self.callbacks if delay == 0]
        self.callbacks = [(delay, callback) for delay, callback in self.callbacks if delay != 0]
        for callback in ready:
            callback()


class LogText:
    def __init__(self):
        self.text = ""
        self.inserts = []
        self.see_count = 0
        self.at_end = True
        self.state = "disabled"

    def config(self, **kwargs):
        self.state = kwargs["state"]

    def insert(self, index, text):
        self.inserts.append(text)
        self.text += text

    def delete(self, first, last):
        self.text = ''.join(self.text.splitlines(keepends=True)[int(last.split('.')[0]) - 1:])

    def yview(self):
        return (0.0, 1.0 if self.at_end else 0.5)

    def see(self, index):
        self.see_count += 1


class DesktopControllerTests(unittest.TestCase):
    def setUp(self):
        self.threads = []
        thread_specs = self.threads

        class DeferredThread:
            def __init__(self, **kwargs):
                self.spec = kwargs

            def start(self):
                thread_specs.append(self.spec)

        self.namespace = {
            "tk": tk, "scrolledtext": scrolledtext, "deque": deque, "Lock": Lock,
            "Thread": DeferredThread, "datetime": datetime, "math": math,
            "os": os, "__file__": str(SOURCE), "is_frozen_app": lambda: False,
            "messagebox": mock.Mock(), "utils": mock.Mock(), "image_logic": mock.Mock(),
            "desktop_ui": desktop_ui, "merge_json_object": mock.Mock(),
            "APP_DIR": str(SOURCE.parent), "exe_update": types.SimpleNamespace(APP_VERSION="1.2.0"),
            "time": time, "webbrowser": mock.Mock(),
            "Empty": Empty, "Queue": Queue, "Event": Event, "sys": sys,
            "secrets": types.SimpleNamespace(token_urlsafe=lambda length: "synthetic-control-token"),
            "subprocess": types.SimpleNamespace(Popen=mock.Mock(), PIPE=subprocess.PIPE,
                                                STDOUT=subprocess.STDOUT, CREATE_NO_WINDOW=0,
                                                TimeoutExpired=subprocess.TimeoutExpired),
        }
        tree = ast.parse(SOURCE.read_text(encoding="utf-8-sig"))
        controller_class = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "NaiaHyperExecutor")
        exec(compile(ast.Module(body=[controller_class], type_ignores=[]), str(SOURCE), "exec"), self.namespace)
        self.controller_class = self.namespace["NaiaHyperExecutor"]
        self.controller = self.controller_class.__new__(self.controller_class)
        c = self.controller
        c.config = {}
        c.root = Root()
        c._active_job = None
        c._job_token = 0
        c._active_job_settings = None
        c.stop_requested = False
        c.is_syncing = False
        c.log_visible = True
        c.update_in_progress = False
        c.server_transitioning = False
        c.server_process = None
        c.server_monitor_token = 0
        c.server_ready = c.is_opened = False
        c._server_start_queue = c._server_start_cancel = None
        c._closing = False
        c._pending_logs = deque(maxlen=c.LOG_QUEUE_LIMIT)
        c._log_lock = Lock()
        c._dropped_logs = 0
        c._log_line_count = 0
        c.log_area = LogText()
        c.full_path = "synthetic/input"
        c.placeholder = "placeholder"
        c.path_var = Variable(c.placeholder)
        c.path_entry = Button()
        c.show_action_confirm_dialog = mock.Mock(return_value=True)
        c.show_reorg_target_dialog = mock.Mock(return_value="all")
        c.save_classify_settings = mock.Mock()
        for name, value in {
            "classify_method_var": "copy", "delete_comic_duplicates_var": True,
            "auto_webp_var": False, "webp_lossless_var": True, "webp_quality_var": "90",
            "is_fast_mode": True, "use_ai_var": False, "use_gpu_var": True,
            "skip_nsfw_var": False, "skip_char_var": False, "show_alert_var": False,
            "normal_thread_count_var": 4, "ai_thread_count_var": 2, "threshold_var": 99.98,
            "auto_open_gallery_var": True,
        }.items():
            setattr(c, name, Variable(value))
        for name in ("btn_run", "btn_reorg", "btn_sync", "btn_scan_art", "btn_stop",
                     "btn_reset_history", "btn_reset_brand", "btn_import", "btn_webp",
                     "auto_webp_checkbox", "auto_webp_quality_input"):
            setattr(c, name, Button())
        c.auto_webp_mode_buttons = [Button(), Button()]
        c._refresh_job_controls()
        self.namespace["messagebox"].askyesnocancel.return_value = False
        self.namespace["utils"].is_port_active.return_value = False
        self.path_exists = mock.patch("os.path.exists", return_value=True)
        self.path_exists.start()
        self.addCleanup(self.path_exists.stop)

    def prepare_server_start(self):
        c = self.controller
        for name in ("_set_server_transition_ui", "_set_server_offline_ui", "_set_external_server_ui"):
            setattr(c, name, mock.Mock())
        process = mock.Mock(pid=12345, stdout=io.StringIO())
        process.poll.return_value = None
        self.namespace["subprocess"].Popen.return_value = process
        return process

    def run_launch_worker(self):
        worker = self.threads[0]
        worker["target"](*worker["args"])

    def test_server_start_displays_loading_before_background_work_and_blocks_repeat_click(self):
        process = self.prepare_server_start()
        c = self.controller
        c.toggle_server()
        c.toggle_server()
        self.assertTrue(c.server_transitioning)
        c._set_server_transition_ui.assert_called_once()
        self.assertEqual(len(self.threads), 1)
        self.namespace["utils"].is_port_active.assert_not_called()
        self.namespace["subprocess"].Popen.assert_not_called()
        callbacks_before = list(c.root.callbacks)
        self.run_launch_worker()
        self.assertEqual(c.root.callbacks, callbacks_before)  # Worker never calls Tk.
        self.assertIsNone(c.server_process)
        c._poll_server_start(c.server_monitor_token, c._server_start_queue)
        self.assertIs(c.server_process, process)
        self.assertIsNone(c._server_start_queue)
        self.assertEqual(self.threads[-1]["args"], (process, c.server_monitor_token))
        self.assertFalse(c.server_ready)
        self.assertEqual(process._naim_control_token, "synthetic-control-token")

    def test_server_start_port_and_process_failures_restore_idle(self):
        self.prepare_server_start()
        c = self.controller
        for failing in (self.namespace["utils"].is_port_active, self.namespace["subprocess"].Popen):
            with self.subTest(failing=failing):
                failing.side_effect = OSError("synthetic launch failure")
                self.threads.clear()
                c.start_server()
                self.run_launch_worker()
                c._poll_server_start(c.server_monitor_token, c._server_start_queue)
                self.assertFalse(c.server_transitioning)
                self.assertIsNone(c.server_process)
                self.assertIsNone(c._server_start_queue)
                failing.side_effect = None
        self.assertEqual(c._set_server_offline_ui.call_count, 2)

    def test_server_start_thread_failure_restores_idle(self):
        self.prepare_server_start()
        self.namespace["Thread"] = mock.Mock(side_effect=RuntimeError("synthetic thread failure"))
        c = self.controller
        c.start_server()
        self.assertFalse(c.server_transitioning)
        self.assertIsNone(c._server_start_queue)
        c._set_server_offline_ui.assert_called_once()

    def test_occupied_port_requires_confirmation_before_cleanup(self):
        self.prepare_server_start()
        c = self.controller
        c.stop_server = mock.Mock()
        self.namespace["utils"].is_port_active.return_value = True
        for answer in (False, True):
            self.threads.clear()
            self.namespace["messagebox"].askyesno.return_value = answer
            c.start_server()
            self.run_launch_worker()
            c._poll_server_start(c.server_monitor_token, c._server_start_queue)
            self.assertFalse(c.server_transitioning)
            self.namespace["subprocess"].Popen.assert_not_called()
            if answer:
                self.assertTrue(c.stop_server.call_args.kwargs["force_port_cleanup"])
            else:
                c.stop_server.assert_not_called()

    def test_close_during_launch_waits_for_worker_and_cancels_new_child(self):
        process = self.prepare_server_start()
        c = self.controller
        c.root.destroy = mock.Mock()
        c.stop_server = mock.Mock()
        c.start_server()
        results = c._server_start_queue
        # Simulate a close arriving while Popen has not returned yet.
        def launch(*args, **kwargs):
            c.on_closing()
            return process
        self.namespace["subprocess"].Popen.side_effect = launch
        with mock.patch.object(os, "_exit") as exit_process:
            self.run_launch_worker()
            c.root.destroy.assert_not_called()
            exit_process.assert_not_called()
            process.terminate.assert_called_once()
            c._poll_server_start(c.server_monitor_token, results)
            self.assertIsNone(c._server_start_queue)
            c.on_closing()
            c.root.destroy.assert_called_once()
            exit_process.assert_called_once_with(0)

    def test_stale_launch_result_is_reaped_without_changing_new_server(self):
        process = self.prepare_server_start()
        c = self.controller
        results = Queue()
        results.put(("started", process))
        c.server_monitor_token = 4
        c.server_process = current = object()
        c._server_start_queue = current_queue = Queue()
        c._poll_server_start(3, results)
        worker = self.threads[-1]
        worker["target"]()
        c._poll_server_start(3, results)
        process.terminate.assert_called_once()
        self.assertIs(c.server_process, current)
        self.assertIs(c._server_start_queue, current_queue)

    def test_cancelled_launch_cleanup_errors_still_publish_completion(self):
        process = self.prepare_server_start()
        process.terminate.side_effect = OSError("synthetic terminate failure")
        process.wait.side_effect = subprocess.TimeoutExpired("synthetic", 1)
        process.stdout = mock.Mock()
        process.stdout.close.side_effect = OSError("synthetic pipe failure")
        c = self.controller
        c.start_server()
        results = c._server_start_queue

        def launch(*args, **kwargs):
            c._server_start_cancel.set()
            return process

        self.namespace["subprocess"].Popen.side_effect = launch
        self.run_launch_worker()
        c._poll_server_start(c.server_monitor_token, results)
        process.kill.assert_called_once()
        process.stdout.close.assert_called_once()
        self.assertIsNone(c._server_start_queue)
        self.assertFalse(c.server_transitioning)

    def test_close_cleanup_thread_failure_still_finishes_pending_launch(self):
        process = self.prepare_server_start()
        c = self.controller
        c.start_server()
        results = c._server_start_queue
        self.run_launch_worker()
        c._closing = True
        self.namespace["Thread"] = mock.Mock()
        self.namespace["Thread"].return_value.start.side_effect = RuntimeError("synthetic thread failure")
        c._poll_server_start(c.server_monitor_token, results)
        c._poll_server_start(c.server_monitor_token, results)
        process.terminate.assert_called_once()
        self.assertIsNone(c._server_start_queue)

    def test_monitor_thread_failure_cleans_child_and_restores_idle(self):
        process = self.prepare_server_start()
        c = self.controller
        c.start_server()
        self.run_launch_worker()
        self.namespace["Thread"] = mock.Mock()
        self.namespace["Thread"].return_value.start.side_effect = RuntimeError("synthetic monitor failure")
        c._poll_server_start(c.server_monitor_token, c._server_start_queue)
        process.terminate.assert_called_once()
        self.assertIsNone(c.server_process)
        self.assertIsNone(c._server_start_queue)
        self.assertFalse(c.server_transitioning)
        c._set_server_offline_ui.assert_called_once()

    def test_ready_server_opens_gallery_only_when_enabled_and_only_once(self):
        c = self.controller
        c.open_gallery = mock.Mock()
        c._set_server_online_ui = mock.Mock()
        c.server_monitor_token = 3
        c.server_process = object()
        for enabled in (True, False):
            with self.subTest(enabled=enabled):
                c.auto_open_gallery_var.set(enabled)
                c.server_ready = c.is_opened = False
                c.server_transitioning = True
                c.open_gallery.reset_mock()
                c._set_server_online_ui.reset_mock()
                c._mark_server_ready(c.server_process, 2)
                c._mark_server_ready(object(), 3)
                self.assertFalse(c.server_ready)
                c._mark_server_ready(c.server_process, 3)
                c._mark_server_ready(c.server_process, 3)
                self.assertTrue(c.server_ready)
                self.assertTrue(c.is_opened)
                self.assertFalse(c.server_transitioning)
                c._set_server_online_ui.assert_called_once()
                self.assertEqual(c.open_gallery.call_count, int(enabled))

    def test_auto_open_preference_preserves_other_settings(self):
        self.path_exists.stop()
        c = self.controller
        self.namespace["merge_json_object"] = merge_json_object
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "gallery_config.json"
            original = {"path": "synthetic/input", "classify_settings": {"method": "move"}, "extra": 42}
            path.write_text(json.dumps(original), encoding="utf-8")
            self.namespace["utils"].CONFIG_FILE = str(path)
            for enabled in (False, True):
                c.auto_open_gallery_var.set(enabled)
                self.assertTrue(c.save_desktop_settings(), list(c._pending_logs))
                self.assertEqual(json.loads(path.read_text(encoding="utf-8")),
                                 {**original, "auto_open_gallery": enabled})
                self.assertEqual(c.config["auto_open_gallery"], enabled)

    def test_failed_auto_open_save_restores_last_saved_choice(self):
        c = self.controller
        c.config["auto_open_gallery"] = False
        c.auto_open_gallery_var.set(True)
        self.namespace["merge_json_object"].side_effect = OSError("synthetic write failure")
        self.assertFalse(c.save_desktop_settings())
        self.assertFalse(c.auto_open_gallery_var.get())
        self.assertFalse(c.config["auto_open_gallery"])
        self.namespace["messagebox"].showerror.assert_called_once()

    def test_manual_gallery_open_works_with_automatic_open_disabled(self):
        self.controller.auto_open_gallery_var.set(False)
        self.namespace["utils"].is_port_active.return_value = True
        self.controller.open_gallery()
        self.namespace["webbrowser"].open.assert_called_once_with("http://127.0.0.1:5000")

    def test_running_classification_blocks_scan_sync_reorg_and_resets(self):
        c = self.controller
        c.start_process()
        c.stop_process()
        c.start_art_scan()
        c.start_brand_sync()
        c.start_reorg()
        c.start_process()
        c.reset_history()
        c.reset_brand_data()
        self.assertEqual(len(self.threads), 1)
        self.assertTrue(c.stop_requested)
        self.assertEqual(c._active_job, "classify")
        self.assertEqual(c.btn_scan_art.values["state"], "disabled")
        self.assertEqual(c.btn_reset_history.values["state"], "disabled")
        self.namespace["messagebox"].askyesnocancel.assert_not_called()
        self.namespace["utils"].HistoryDB.assert_not_called()

    def test_each_job_restores_controls_and_old_completion_cannot_end_new_job(self):
        c = self.controller
        for job in ("classify", "reorg", "art", "brand", "webp"):
            with self.subTest(job=job):
                c._launch_job(job, mock.Mock())
                first_token = c._job_token
                for name in ("btn_run", "btn_reorg", "btn_scan_art", "btn_sync", "btn_import", "btn_reset_brand", "btn_webp"):
                    self.assertEqual(getattr(c, name).values["state"], "disabled")
                self.assertEqual(c.btn_stop.values["state"], "disabled" if job == "brand" else "normal")
                self.assertTrue(c._finish_job(job, first_token))
                c._launch_job(job, mock.Mock())
                self.assertFalse(c._finish_job(job, first_token))
                self.assertEqual(c._active_job, job)
                c._finish_job(job, c._job_token)
                self.assertEqual(c.btn_run.values["state"], "normal")
                self.assertEqual(c.btn_stop.values["state"], "disabled")

    def test_invalid_settings_are_rejected_before_disabling_controls(self):
        c = self.controller
        for field, invalid in (("threshold_var", ""), ("threshold_var", float("nan")),
                               ("threshold_var", float("inf")), ("threshold_var", 101),
                               ("normal_thread_count_var", 0), ("ai_thread_count_var", 17)):
            with self.subTest(field=field, invalid=invalid):
                original = getattr(c, field).get()
                getattr(c, field).set(invalid)
                c.start_process()
                self.assertIsNone(c._active_job)
                self.assertEqual(c.btn_run.values["state"], "normal")
                getattr(c, field).set(original)
        c.threshold_var = mock.Mock()
        c.threshold_var.get.side_effect = tk.TclError("invalid double")
        c.start_reorg()
        self.assertEqual(self.threads, [])
        self.assertEqual(self.namespace["messagebox"].showwarning.call_count, 7)

    def test_classification_uses_confirmed_snapshot_without_worker_tk_reads(self):
        c = self.controller
        c.start_process()
        spec = self.threads[0]
        self.assertTrue(spec["args"][-1])  # Keep the existing comic-option positional contract.
        for name in ("use_gpu_var", "threshold_var", "normal_thread_count_var", "ai_thread_count_var"):
            getattr(c, name).get = mock.Mock(side_effect=AssertionError("worker touched Tk"))
        spec["target"](*spec["args"], **spec["kwargs"])
        kwargs = self.namespace["image_logic"].process.call_args.kwargs
        self.assertEqual((kwargs["normal_workers"], kwargs["ai_workers"], kwargs["ai_threshold"]), (4, 2, 0.9998))
        self.assertTrue(kwargs["use_gpu"])
        self.assertTrue(kwargs["delete_comic_duplicates"])
        self.assertFalse(kwargs["auto_webp"])
        self.assertTrue(kwargs["webp_lossless"])
        self.assertEqual(kwargs["webp_quality"], 90)
        c.root.drain_ready()
        self.assertIsNone(c._active_job)

    def test_auto_webp_settings_defaults_and_invalid_legacy_values_are_safe(self):
        normalize = self.controller._normalize_auto_webp_settings
        expected = {"auto_webp": False, "webp_lossless": True, "webp_quality": 90}
        for settings in (None, {}, [], {"auto_webp": "false", "webp_lossless": "false", "webp_quality": "invalid"},
                         {"auto_webp": 1, "webp_lossless": 0, "webp_quality": True}, {"webp_quality": 101}):
            with self.subTest(settings=settings):
                self.assertEqual(normalize(settings), expected)
        self.assertEqual(normalize({"auto_webp": True, "webp_lossless": False, "webp_quality": "83"}),
                         {"auto_webp": True, "webp_lossless": False, "webp_quality": 83})

    def test_auto_webp_settings_persist_in_classify_settings(self):
        c = self.controller
        c.auto_webp_var.set(True)
        c.webp_lossless_var.set(False)
        c.webp_quality_var.set("83")
        self.controller_class.save_classify_settings(c, silent=True)
        saved = self.namespace["utils"].save_config.call_args.args[0]["classify_settings"]
        self.assertEqual((saved["auto_webp"], saved["webp_lossless"], saved["webp_quality"]), (True, False, 83))
        self.assertEqual(saved["method"], "copy")
        self.assertTrue(saved["delete_comic_duplicates"])

    def test_auto_webp_snapshot_and_confirmation_cover_copy_and_move(self):
        c = self.controller
        for method in ("copy", "move"):
            with self.subTest(method=method):
                c.classify_method_var.set(method)
                c.auto_webp_var.set(True)
                c.webp_lossless_var.set(False)
                c.webp_quality_var.set("83")
                c.start_process()
                spec = self.threads[-1]
                self.assertTrue(spec["args"][-1])
                dialog = c.show_action_confirm_dialog.call_args.kwargs
                option = next(item for item in dialog["options"] if item["label"] == "분류 후 WebP 변환")
                self.assertEqual(option["value"], "손실 · 화질 83")
                self.assertIn("메타데이터 보존 검증 후 분류된 PNG를 삭제", dialog["warning_text"])
                self.assertEqual("입력 원본" in dialog["warning_text"], method == "copy")
                originals = {}
                for name in ("auto_webp_var", "webp_lossless_var", "webp_quality_var"):
                    variable = getattr(c, name)
                    originals[name] = variable.get
                    variable.get = mock.Mock(side_effect=AssertionError("worker touched Tk"))
                try:
                    spec["target"](*spec["args"], **spec["kwargs"])
                finally:
                    for name, getter in originals.items():
                        getattr(c, name).get = getter
                kwargs = self.namespace["image_logic"].process.call_args.kwargs
                self.assertEqual((kwargs["auto_webp"], kwargs["webp_lossless"], kwargs["webp_quality"]), (True, False, 83))
                self.assertEqual(kwargs["method"], method)
                c.root.drain_ready()

    def test_auto_webp_lossy_quality_rejected_but_reorg_ignores_option(self):
        c = self.controller
        c.auto_webp_var.set(True)
        c.webp_lossless_var.set(False)
        for invalid in ("", "no", "82.5", "0", "101", True, 82.5):
            with self.subTest(invalid=invalid):
                c.webp_quality_var.set(invalid)
                c.start_process()
                self.assertEqual(self.threads, [])
                self.assertIsNone(c._active_job)
        c.start_reorg()
        spec = self.threads[0]
        self.assertFalse(spec["kwargs"]["job_settings"]["auto_webp"])
        spec["target"](*spec["args"], **spec["kwargs"])
        self.assertFalse(self.namespace["image_logic"].process.call_args.kwargs.get("auto_webp", False))
        c.root.drain_ready()
        c.webp_lossless_var.set(True)
        c.start_process()
        self.assertEqual(len(self.threads), 2)

    def test_auto_webp_requires_offline_server_before_and_after_confirmation(self):
        c = self.controller
        c.auto_webp_var.set(True)
        self.namespace["utils"].is_port_active.return_value = True
        c.start_process()
        self.assertEqual(self.threads, [])
        c.show_action_confirm_dialog.assert_not_called()
        self.namespace["utils"].is_port_active.return_value = False
        c.server_transitioning = True
        c.start_process()
        self.assertEqual(self.threads, [])
        c.server_transitioning = False
        self.namespace["utils"].is_port_active.side_effect = [False, True]
        c.start_process()
        self.assertEqual(self.threads, [])
        c.show_action_confirm_dialog.assert_called_once()
        self.assertIsNone(c._active_job)

    def test_auto_webp_blocks_server_start_and_shutdown_waits_for_worker(self):
        c = self.controller
        c.auto_webp_var.set(True)
        c.start_process()
        c.auto_webp_var.set(False)  # The active snapshot, not later UI edits, owns the guard.
        c.start_server()
        c.toggle_server()
        c.stop_server = mock.Mock()
        c.root.destroy = mock.Mock()
        with mock.patch.object(os, "_exit") as exit_process:
            c.on_closing()
            self.assertTrue(c.stop_requested)
            self.assertTrue(any(delay == 200 for delay, callback in c.root.callbacks))
            c.stop_server.assert_not_called()
            c.root.destroy.assert_not_called()
            exit_process.assert_not_called()
            self.assertEqual(c._active_job, "classify")
            c._finish_job("classify", c._job_token)
            c.on_closing()
            c.root.destroy.assert_called_once()
            exit_process.assert_called_once_with(0)

    def test_reorg_uses_snapshot_and_failure_releases_busy_state(self):
        c = self.controller
        c.start_reorg()
        for name in ("use_gpu_var", "threshold_var", "normal_thread_count_var", "ai_thread_count_var"):
            getattr(c, name).get = mock.Mock(side_effect=AssertionError("worker touched Tk"))
        self.namespace["image_logic"].process.side_effect = RuntimeError("synthetic failure")
        spec = self.threads[0]
        spec["target"](*spec["args"], **spec["kwargs"])
        c.root.drain_ready()
        self.assertIsNone(c._active_job)
        self.assertEqual(c.btn_scan_art.values["state"], "normal")
        self.assertEqual(c.btn_stop.values["state"], "disabled")

    def test_failed_thread_start_restores_idle_controls(self):
        self.namespace["Thread"] = mock.Mock(side_effect=RuntimeError("synthetic thread limit"))
        self.controller.start_process()
        self.assertIsNone(self.controller._active_job)
        self.assertEqual(self.controller.btn_run.values["state"], "normal")

    def test_second_path_click_keeps_edit_and_blur_saves_it(self):
        c = self.controller
        c._on_path_click(None)
        self.assertEqual(c.path_var.get(), "synthetic/input")
        c.path_var.set("synthetic/edited")
        c._on_path_click(None)
        self.assertEqual(c.path_var.get(), "synthetic/edited")
        c._on_path_blur(None)
        self.assertEqual(c.full_path, "synthetic/edited")
        self.namespace["utils"].save_config.assert_called_once_with({"path": "synthetic/edited"})

    def test_log_producers_never_schedule_tk_and_flush_in_batches(self):
        c = self.controller
        for index in range(1000):
            c.log(f"synthetic {index}")
        self.assertEqual(c.root.callbacks, [])
        while c._pending_logs:
            c._drain_logs()
        self.assertEqual(len(c.log_area.inserts), 5)
        self.assertEqual(c.log_area.see_count, 5)
        self.assertEqual(len(c.root.callbacks), 5)
        self.assertEqual(len(c.log_area.text.splitlines()), 1000)
        self.assertEqual(c.log_area.state, "disabled")

    def test_log_overflow_is_bounded_and_does_not_force_scrolled_view(self):
        c = self.controller
        c.LOG_QUEUE_LIMIT = c.LOG_MAX_LINES = 5
        c.LOG_BATCH_SIZE = 3
        c._pending_logs = deque(maxlen=c.LOG_QUEUE_LIMIT)
        c.log_area.at_end = False
        for index in range(12):
            c.log(f"synthetic {index}")
        self.assertEqual(len(c._pending_logs), 5)
        self.assertEqual(c._dropped_logs, 7)
        while c._pending_logs:
            c._drain_logs()
        self.assertIn("7개", c.log_area.inserts[0])
        self.assertEqual(len(c.log_area.text.splitlines()), 5)
        self.assertIn("synthetic 7", c.log_area.text)
        self.assertIn("synthetic 11", c.log_area.text)
        self.assertEqual(c.log_area.see_count, 0)

    def test_concurrent_log_producers_preserve_every_message_below_limit(self):
        c = self.controller
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda index: c.log(f"synthetic {index}"), range(2000)))
        self.assertEqual(len(c._pending_logs), 2000)
        self.assertEqual(c._dropped_logs, 0)
        self.assertEqual(c.root.callbacks, [])
        while c._pending_logs:
            c._drain_logs()
        for index in range(2000):
            self.assertIn(f"synthetic {index}\n", c.log_area.text)

    def test_server_stdout_no_longer_enqueues_per_line_tk_callbacks(self):
        c = self.controller
        c.is_opened = True
        c._finalize_server_monitor = mock.Mock()
        process = types.SimpleNamespace(pid=12345, stdout=io.StringIO("synthetic request\n" * 1000), wait=lambda: 0)
        c.monitor_server(process, 1)
        self.assertEqual(len(c.root.callbacks), 1)  # Only the monitor completion callback.
        while c._pending_logs:
            c._drain_logs()
        self.assertEqual(len(c.root.callbacks), 7)
        self.assertEqual(len(c.log_area.inserts), 6)
        self.assertEqual(len(c.log_area.text.splitlines()), 1001)

    def test_isolated_ui_initializes_real_controls_and_readonly_log(self):
        if not RUN_TK_CHILD:
            # Tcl objects must not survive into another test's worker-thread GC.
            # This child only runs the real-Tk case, and exits on its main thread.
            self.path_exists.stop()
            child_env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="utf-8")
            child_env.pop("PYTHONPATH", None)
            completed = subprocess.run(
                [sys.executable, "-B", str(Path(__file__).resolve()), "--tk-child", "-v",
                 "DesktopControllerTests.test_isolated_ui_initializes_real_controls_and_readonly_log"],
                cwd=SOURCE.parent, env=child_env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace", timeout=45,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            self.assertEqual(completed.returncode, 0, completed.stdout)
            if "skipped=1" in completed.stdout:
                self.skipTest(completed.stdout.strip())
            return
        try:
            root = tk.Tk()
        except tk.TclError as error:
            self.skipTest(str(error))
        root.withdraw()
        try:
            self.namespace["utils"].load_config.return_value = {"path": "synthetic/input"}
            self.namespace["image_logic"].is_ai_available.return_value = False
            with mock.patch.object(self.controller_class, "is_admin", return_value=False), \
                 mock.patch.object(self.controller_class, "check_port_on_startup"):
                c = self.controller_class(root)
            # A withdrawn root never allocates child geometry on Windows. Map
            # a fully transparent test window to verify actual button bounds.
            root.attributes("-alpha", 0)
            root.deiconify()
            root.update()
            root.update_idletasks()
            self.assertGreaterEqual(root.winfo_height(), root.winfo_reqheight())
            for button in (c.auto_webp_checkbox, c.btn_run, c.btn_stop, c.btn_server, c.btn_open,
                           c.auto_open_gallery_checkbox, c.btn_sync, c.btn_reset_brand,
                           c.btn_reorg, c.btn_scan_art, c.btn_webp, c.threshold_spin):
                self.assertGreaterEqual(button.winfo_height(), button.winfo_reqheight())
                bottom = button.winfo_rooty() - root.winfo_rooty() + button.winfo_height()
                self.assertLessEqual(bottom, root.winfo_height())
                right = button.winfo_rootx() - root.winfo_rootx() + button.winfo_width()
                self.assertLessEqual(right, root.winfo_width())
            self.assertGreaterEqual(c.auto_open_gallery_checkbox.winfo_rootx(),
                                    c.btn_open.winfo_rootx() + c.btn_open.winfo_width())
            self.assertEqual(c.auto_open_gallery_checkbox.master, c.btn_open.master)
            self.assertTrue(c.auto_open_gallery_var.get())
            c.auto_open_gallery_checkbox.invoke()
            self.assertFalse(c.auto_open_gallery_var.get())
            self.namespace["merge_json_object"].assert_called_once_with(
                self.namespace["utils"].CONFIG_FILE, {"auto_open_gallery": False})
            c.update_progress(4, 10)
            root.update()
            self.assertEqual(float(c.progress_bar.cget("value")), 40)
            root.geometry(f"{root.winfo_width() + 80}x{root.winfo_height() + 40}")
            root.update()
            original_size = root.winfo_width(), root.winfo_height()
            c.toggle_log()
            root.update()
            self.assertTrue(c.log_visible)
            self.assertGreater(root.winfo_width(), original_size[0])
            c.toggle_log()
            root.update()
            self.assertFalse(c.log_visible)
            self.assertEqual((root.winfo_width(), root.winfo_height()), original_size)
            # Dynamic server text must keep the last checkbox readable at high DPI.
            root.tk.call("tk", "scaling", 2.5)
            for update in (c._set_external_server_ui,
                           lambda: c._set_server_transition_ui("● 서버 기동 중…", "", ""),
                           c._set_server_online_ui, c._set_server_offline_ui):
                update()
                root.update()
                checkbox = c.auto_open_gallery_checkbox
                self.assertGreaterEqual(checkbox.winfo_width(), checkbox.winfo_reqwidth())
                self.assertLessEqual(checkbox.winfo_rootx() - root.winfo_rootx() + checkbox.winfo_width(),
                                     root.winfo_width())
            # Both launch operations deliberately block. Real Tk timers and
            # the loading bar must continue while each worker stage waits.
            gates = [Event(), Event()]
            entered = [Event(), Event()]
            launched_threads = []
            process = mock.Mock(pid=12345, stdout=io.StringIO())
            process.poll.return_value = None
            deferred_thread = self.namespace["Thread"]

            def actual_thread(**kwargs):
                thread = RealThread(**kwargs)
                launched_threads.append(thread)
                return thread

            def slow_port(port):
                entered[0].set()
                gates[0].wait(5)
                return False

            def slow_launch(*args, **kwargs):
                entered[1].set()
                gates[1].wait(5)
                return process

            ticks = []

            def pulse():
                ticks.append(time.monotonic())
                root.after(10, pulse)

            self.namespace["Thread"] = actual_thread
            self.namespace["utils"].is_port_active.side_effect = slow_port
            self.namespace["subprocess"].Popen.side_effect = slow_launch
            try:
                with mock.patch.object(c, "monitor_server"):
                    root.after(10, pulse)
                    c.start_server()
                    for stage in range(2):
                        self.assertTrue(entered[stage].wait(1))
                        before = len(ticks)
                        bar_before = float(c.server_loading_bar.cget("value"))
                        deadline = time.monotonic() + 0.25
                        while time.monotonic() < deadline:
                            root.update()
                            time.sleep(0.005)
                        self.assertGreater(len(ticks) - before, 5)
                        self.assertNotEqual(float(c.server_loading_bar.cget("value")), bar_before)
                        self.assertTrue(c._server_loading_active)
                        self.assertEqual(str(c.btn_server.cget("state")), "disabled")
                        gates[stage].set()
                    deadline = time.monotonic() + 2
                    while c._server_start_queue is not None and time.monotonic() < deadline:
                        root.update()
                        time.sleep(0.005)
                    self.assertIs(c.server_process, process)
                    c._mark_server_ready(process, c.server_monitor_token)
                    self.assertFalse(c._server_loading_active)
                    self.assertIsNone(c._server_loading_after)
            finally:
                for gate in gates:
                    gate.set()
                for thread in launched_threads:
                    thread.join(2)
                self.namespace["Thread"] = deferred_thread
                self.namespace["utils"].is_port_active.side_effect = None
                self.namespace["subprocess"].Popen.side_effect = None
                c.server_process = None
                c._set_server_offline_ui()
            root.withdraw()
            self.assertEqual(str(c.btn_run.cget("state")), "normal")
            self.assertEqual(str(c.btn_reset_history.cget("state")), "normal")
            self.assertEqual(str(c.btn_stop.cget("state")), "disabled")
            self.assertEqual(str(c.btn_webp.cget("state")), "normal")
            self.assertFalse(c.auto_webp_var.get())
            self.assertTrue(c.webp_lossless_var.get())
            self.assertEqual(c.webp_quality_var.get(), "90")
            self.assertEqual(str(c.auto_webp_quality_input.cget("state")), "disabled")
            self.assertTrue(all(str(button.cget("state")) == "disabled" for button in c.auto_webp_mode_buttons))
            c.auto_webp_checkbox.invoke()
            self.assertTrue(c.auto_webp_var.get())
            self.assertTrue(all(str(button.cget("state")) == "normal" for button in c.auto_webp_mode_buttons))
            c.auto_webp_mode_buttons[1].invoke()
            self.assertFalse(c.webp_lossless_var.get())
            self.assertEqual(str(c.auto_webp_quality_input.cget("state")), "normal")
            c.auto_webp_checkbox.invoke()
            with mock.patch.object(sys, 'path', [str(SOURCE.parent), *sys.path]):
                from naim.webp_compression_ui import WebPCompressionDialog
            dialog = WebPCompressionDialog(c)
            try:
                self.assertEqual(str(dialog.quality_input.cget('state')), 'disabled')
                dialog.mode.set('lossy')
                dialog._update_quality()
                self.assertEqual(str(dialog.quality_input.cget('state')), 'normal')
                self.assertIn('예상', dialog.estimate_button.cget('text'))
                self.assertIn('PNG 삭제', dialog.start_button.cget('text'))
                self.assertEqual(str(dialog.details.cget('state')), 'disabled')
            finally:
                dialog.close()
            self.assertTrue(any(isinstance(widget, tk.Label) and widget.cget("text") == "최근 5,000줄 표시"
                                for widget in c.log_sidebar.winfo_children()))
            for job in ("classify", "reorg", "art", "brand", "webp"):
                with self.subTest(real_tk_job=job):
                    c._launch_job(job, mock.Mock())
                    for button in (c.btn_run, c.btn_reorg, c.btn_scan_art, c.btn_sync,
                                   c.btn_reset_history, c.btn_reset_brand, c.btn_import, c.btn_webp):
                        self.assertEqual(str(button.cget("state")), "disabled")
                    self.assertEqual(str(c.btn_stop.cget("state")), "disabled" if job == "brand" else "normal")
                    c.stop_process()
                    self.assertEqual(str(c.btn_stop.cget("state")), "disabled")
                    self.assertEqual(c.stop_requested, job != "brand")
                    c._finish_job(job, c._job_token)
                    self.assertEqual(str(c.btn_scan_art.cget("state")), "normal")
            launched = len(self.threads)
            c.threshold_var.set("not-a-number")
            c.start_process()
            self.assertEqual(len(self.threads), launched)
            self.assertIsNone(c._active_job)
            self.namespace["messagebox"].showwarning.assert_called_once()
            c.log("synthetic multiline\nsecond line")
            c._drain_logs()
            self.assertEqual(str(c.log_area.cget("state")), "disabled")
            self.assertIn("second line", c.log_area.get("1.0", "end"))
            c.LOG_MAX_LINES = 3
            c.log("synthetic A\nsynthetic B\nsynthetic C\nsynthetic D")
            c._drain_logs()
            self.assertEqual(c.log_area.get("1.0", "end-1c"), "synthetic B\nsynthetic C\nsynthetic D\n")
            self.namespace["utils"].load_config.return_value = {"auto_open_gallery": False}
            with mock.patch.object(self.controller_class, "is_admin", return_value=False), \
                 mock.patch.object(self.controller_class, "check_port_on_startup"), \
                 mock.patch.object(self.controller_class, "setup_ui"), \
                 mock.patch.object(self.controller_class, "_refresh_job_controls"), \
                 mock.patch.object(desktop_ui, "fit_controller_window"):
                restored = self.controller_class(root)
            self.assertFalse(restored.auto_open_gallery_var.get())
        finally:
            for callback in root.tk.splitlist(root.tk.call("after", "info")):
                root.after_cancel(callback)
            root.destroy()


if __name__ == "__main__":
    if "--tk-child" in sys.argv:
        sys.argv.remove("--tk-child")
        RUN_TK_CHILD = True
    unittest.main()
