# -*- coding: utf-8 -*-
import os
import sys
import subprocess
import secrets
import time
import math
from collections import deque
from queue import Empty, Queue
from naim.server_control import request_job_shutdown


from naim.paths import get_app_dir


# ---------------------------------------------------------
# .venv 우선 진입
# 프로젝트 모듈(utils, image_logic 등)을 import하기 전에 반드시 실행한다.
# ---------------------------------------------------------
APP_DIR = get_app_dir()


def is_frozen_app():
    return getattr(sys, "frozen", False)


def run_server_mode_if_requested():
    if "--server" not in sys.argv:
        return

    os.chdir(APP_DIR)
    import app as server_app

    server_app.run_server()
    sys.exit(0)

if sys.prefix == sys.base_prefix:
    venv_python_candidates = []

    if os.name == "nt":
        venv_python_candidates.extend([
            os.path.join(APP_DIR, ".venv", "Scripts", "pythonw.exe"),
            os.path.join(APP_DIR, ".venv", "Scripts", "python.exe"),
        ])
    else:
        venv_python_candidates.append(
            os.path.join(APP_DIR, ".venv", "bin", "python")
        )

    for venv_python in venv_python_candidates:
        if os.path.exists(venv_python):
            creation_flags = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0
            subprocess.Popen(
                [venv_python] + sys.argv,
                cwd=APP_DIR,
                creationflags=creation_flags
            )
            sys.exit(0)


# ---------------------------------------------------------
# .venv 진입 후 또는 시스템 Python 사용 가능 시 일반 패키지 로드
# ---------------------------------------------------------
if "--import-data" in sys.argv:
    from naim.legacy_import_ui import run as run_legacy_import
    parent_pid = int(sys.argv[sys.argv.index("--import-data") + 1]) if len(sys.argv) > sys.argv.index("--import-data") + 1 else 0
    run_legacy_import(APP_DIR, parent_pid)
    sys.exit(0)

run_server_mode_if_requested()

import tkinter as tk
from tkinter import filedialog, messagebox
from threading import Event, Lock, Thread
from datetime import datetime
import webbrowser
import sqlite3
import importlib
import ctypes
from naim import desktop_ui
from naim.storage.json_files import merge_json_object


try:
    import utils
    import image_logic
    import exe_update

    try:
        import danbooru_sync
    except ImportError:
        danbooru_sync = None

except ImportError as e:
    root = tk.Tk()
    root.withdraw()

    error_msg = (
        "⚠️ 프로그램 실행에 필요한 필수 라이브러리가 설치되어 있지 않습니다.\n\n"
        f"누락된 모듈: {e.name}\n\n"
        "[ 💡 해결 방법 ]\n"
        "1. 동봉된 'naim_setup.py'를 실행하여 [1단계: 가상환경 세팅]을 완료해주세요.\n"
        "2. 수동으로 설치하시려면 터미널(CMD)을 열고 아래 명령어를 입력하세요:\n"
        "   pip install flask requests pillow numpy\n\n"
        "※ .venv가 없거나, 현재 사용 중인 Python 환경에 필수 패키지가 누락된 상태입니다."
    )

    messagebox.showerror("NAI Image Manager - 실행 오류", error_msg)
    sys.exit(1)


from naim import desktop_dialogs as messagebox


class NaiaHyperExecutor:
    LOG_MAX_LINES = 5000
    LOG_QUEUE_LIMIT = 5000
    LOG_BATCH_SIZE = 200
    LOG_FLUSH_MS = 50

    def __init__(self, root):
        self.root = root
        self.root.title("NAI Image Manager · 리모콘")
        self.root.configure(bg=desktop_ui.BG)
        icon_path = os.path.join(APP_DIR, "assets", "app_icon.ico")
        if os.path.isfile(icon_path):
            try:
                self.root.iconbitmap(icon_path)
                self.root.iconbitmap(default=icon_path)
            except tk.TclError:
                pass  # Source checkouts on non-Windows Tk may not support ICO.
        self.admin_mode = self.is_admin()

        self.config = utils.load_config()
        self.full_path = self.config.get("path", os.getcwd())

        classify_settings = self.config.get("classify_settings", {})
        if not isinstance(classify_settings, dict):
            classify_settings = {}

        self.show_alert_var = tk.BooleanVar(value=bool(classify_settings.get("show_alert", True)))
        self.is_fast_mode = tk.BooleanVar(value=bool(classify_settings.get("is_fast_mode", True)))
        self.classify_method_var = tk.StringVar(value=str(classify_settings.get("method", "copy")))
        self.delete_comic_duplicates_var = tk.BooleanVar(value=bool(classify_settings.get("delete_comic_duplicates", False)))
        webp_settings = self._normalize_auto_webp_settings(classify_settings)
        self.auto_webp_var = tk.BooleanVar(value=webp_settings["auto_webp"])
        self.webp_lossless_var = tk.BooleanVar(value=webp_settings["webp_lossless"])
        self.webp_quality_var = tk.StringVar(value=str(webp_settings["webp_quality"]))
        self.auto_open_gallery_var = tk.BooleanVar(value=bool(self.config.get("auto_open_gallery", True)))
        self.frozen_app = is_frozen_app()
        self.app_version = exe_update.APP_VERSION
        self.lite_ai_disabled = self.frozen_app and not image_logic.is_ai_available()
        self.use_ai_var = tk.BooleanVar(value=bool(classify_settings.get("use_ai", False)) and not self.lite_ai_disabled)
        self.use_gpu_var = tk.BooleanVar(value=bool(classify_settings.get("use_gpu", False)) and not self.lite_ai_disabled)
        self.skip_nsfw_var = tk.BooleanVar(value=bool(classify_settings.get("skip_nsfw", False)))
        self.skip_char_var = tk.BooleanVar(value=bool(classify_settings.get("skip_char", False)))
        legacy_threads = int(classify_settings.get("thread_count", 4) or 4)
        self.normal_thread_count_var = tk.IntVar(value=int(classify_settings.get("normal_thread_count", legacy_threads) or legacy_threads))
        self.ai_thread_count_var = tk.IntVar(value=int(classify_settings.get("ai_thread_count", min(4, legacy_threads)) or min(4, legacy_threads)))
        self.thread_count_var = self.normal_thread_count_var
        self.threshold_var = tk.DoubleVar(value=float(classify_settings.get("ai_threshold_percent", 99.980)))

        self.stop_requested = False
        self._active_job = None
        self._job_token = 0
        self._active_job_settings = None
        self._pending_logs = deque(maxlen=self.LOG_QUEUE_LIMIT)
        self._log_lock = Lock()
        self._dropped_logs = 0
        self._log_line_count = 0
        self.log_visible = False
        self.update_in_progress = False

        self.server_process = None
        self.is_opened = False
        self.server_transitioning = False
        self.server_ready = False
        self.server_monitor_token = 0
        self._server_start_queue = None
        self._server_start_cancel = None
        self._closing = False

        self.server_status_var = tk.StringVar(value="● 서버 중지됨")
        self.is_syncing = False

        self.setup_ui()
        self._refresh_job_controls()
        desktop_ui.fit_controller_window(self)
        self.root.after(self.LOG_FLUSH_MS, self._drain_logs)

        # 🌟 [신규] 시작하자마자 5000번 포트 좀비 체크
        self.check_port_on_startup()

    def is_admin(self):
        """현재 프로그램이 관리자 권한으로 실행 중인지 확인"""
        try:
            return ctypes.windll.shell32.IsUserAnAdmin()
        except:
            return False

    def run_as_admin(self):
        """관리자 권한으로 프로그램 재시작 (경로 유지 및 에러 방지 강화)"""
        if self.admin_mode:
            return

        # 🌟 [개선 1] 실행 파일과 인자 경로를 절대 경로로 정확히 지정
        script = os.path.abspath(sys.argv[0])
        params = " ".join([f'"{arg}"' for arg in sys.argv[1:]])

        # 🌟 [개선 2] 현재 작업 디렉터리를 가져와서 새 프로세스에도 전달 (Import 에러 방지 핵심)
        cwd = os.path.dirname(script)

        # 🌟 [개선 3] ShellExecuteW 실행 결과(Handle)를 확인
        # "runas" verb는 관리자 권한 승격을 요청합니다.
        ret = ctypes.windll.shell32.ShellExecuteW(
            None,
            "runas",
            sys.executable,
            f'"{script}" {params}',
            cwd,
            1
        )

        # 결과 값이 32보다 크면 실행 성공입니다.
        if int(ret) > 32:
            self.on_closing()  # 성공했을 때만 기존 창 종료
        else:
            # 사용자가 '아니오'를 눌렀거나 실행에 실패한 경우
            self.log("⚠️ 관리자 권한 승격이 취소되었습니다. (일반 모드로 유지)")
            messagebox.showwarning("권한 승격 실패", "관리자 권한 승격이 거부되었습니다.\n일반 모드에서는 5000번 포트 강제 종료가 작동하지 않을 수 있습니다.")

    # 🌟 [보안 및 정밀도 강화] 포트 체크 로직
    def check_port_on_startup(self):
        if utils.is_port_active(5000):
            self.log("⚠️ [감지] 5000번 포트가 이미 사용 중입니다.")
            self._set_external_server_ui()
        else:
            self.log("🚀 시스템 포트가 깨끗합니다. 준비 완료!")
            self._set_server_offline_ui()

    def _set_server_transition_ui(self, status_text, status_color, button_text):
        self.server_status_var.set(status_text)
        self.lbl_status.config(fg=desktop_ui.WARNING)
        self.btn_server.config(text="전환 중…", state="disabled", bg=desktop_ui.SOFT, fg=desktop_ui.MUTED)
        desktop_ui.set_server_loading(self, True)
        desktop_ui.fit_controller_window(self, show_log=self.log_visible)

    def _set_external_server_ui(self):
        desktop_ui.set_server_loading(self, False)
        self.server_status_var.set("● 외부 서버 감지")
        self.lbl_status.config(fg=desktop_ui.WARNING)
        self.btn_server.config(text="외부 서버 정리", state="normal", bg=desktop_ui.PANEL, fg=desktop_ui.ERROR)
        desktop_ui.fit_controller_window(self, show_log=self.log_visible)

    def _terminate_managed_server_process(self, process, wait=False):
        if not process or process.poll() is not None:
            return

        request_job_shutdown(getattr(process, '_naim_control_token', ''), process.pid)
        try:
            process.terminate()
        except Exception:
            pass

        if wait:
            try:
                process.wait(timeout=0.6)
                return
            except subprocess.TimeoutExpired:
                pass
            except Exception:
                return

        try:
            process.kill()
        except Exception:
            pass

    def _force_kill_port_5000_async(self):
        if os.name != 'nt':
            return

        def _task():
            flags = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0

            try:
                output = subprocess.check_output(
                    ["netstat", "-ano"],
                    text=True,
                    errors="replace",
                    timeout=1,
                    creationflags=flags
                )

                pids = set()
                for line in output.splitlines():
                    if ":5000 " not in line or "LISTENING" not in line:
                        continue

                    parts = line.strip().split()
                    if len(parts) >= 5:
                        pid = parts[-1]
                        if pid and pid != "0":
                            pids.add(pid)

                for pid in pids:
                    subprocess.Popen(
                        ["taskkill", "/F", "/T", "/PID", pid],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        creationflags=flags
                    )
            except Exception:
                pass

        Thread(target=_task, daemon=True).start()

    def stop_server(self, on_complete=None, is_shutdown=False, force_port_cleanup=False):
        if not is_shutdown and self.server_transitioning:
            self.log("⏳ 서버 상태 전환 중입니다. 잠시만 기다려주세요.")
            return

        managed_process = self.server_process
        self.server_process = None
        self.server_ready = False
        self.is_opened = False
        self.server_monitor_token += 1

        if is_shutdown:
            self._terminate_managed_server_process(managed_process, wait=False)
            return

        self.server_transitioning = True
        self.log("📡 서버 종료 중...")
        self._set_server_transition_ui("🟠 서버 종료 중...", "#ffb300", "⏳ 서버 종료 중...")

        def _task():
            if managed_process:
                self._terminate_managed_server_process(managed_process, wait=True)
            elif force_port_cleanup:
                self._force_kill_port_5000_async()

            try:
                self.root.after(0, lambda: self._finish_stop_server(False, on_complete))
            except Exception:
                pass

        Thread(target=_task, daemon=True).start()

    def on_closing(self):
        if self._has_active_webp_job():
            if not self.stop_requested:
                self.stop_process()
            self.root.after(200, self.on_closing)
            return
        self._closing = True
        if self._server_start_queue is not None:
            # Wait responsively for a launch already inside Popen, so its child
            # is either cancelled by the worker or owned before shutdown.
            self._server_start_cancel.set()
            self.root.after(50, self.on_closing)
            return
        try:
            self.stop_server(is_shutdown=True)
        except Exception:
            pass

        try:
            self.root.destroy()
        except Exception:
            pass

        os._exit(0)

    def _finish_stop_server(self, port_still_active, on_complete=None):
        self.server_transitioning = False
        self.server_process = None
        self.is_opened = False
        self.server_ready = False

        if port_still_active:
            self._set_external_server_ui()
        else:
            self._set_server_offline_ui()

        self.log("⚙️ 서버 종료 상태가 마무리되었습니다.")
        if on_complete:
            on_complete()

    # ==========================================
    # 서버 제어 로직 (개선됨)
    # ==========================================
    def toggle_server(self):
        if self._has_active_webp_job():
            self.log('⏳ WebP 압축이 끝난 뒤 서버를 켤 수 있습니다.')
            return
        if self.server_transitioning:
            self.log("⏳ 서버 시작/종료 전환 중입니다. 잠시만 기다려주세요.")
            return

        if self.server_process is None or self.server_process.poll() is not None:
            self.start_server()
        else:
            self.stop_server()

    def setup_ui(self):
        desktop_ui.build_controller_ui(self)

    def _can_start_job(self):
        if self._active_job is not None:
            self.log("⏳ 진행 중인 작업이 끝난 뒤 실행해 주세요.")
            return False
        return True

    def _has_active_webp_job(self):
        return self._active_job == "webp" or (
            self._active_job == "classify" and bool((self._active_job_settings or {}).get("auto_webp"))
        )

    @staticmethod
    def _normalize_auto_webp_settings(settings):
        settings = settings if isinstance(settings, dict) else {}
        quality = settings.get("webp_quality", 90)
        try:
            if isinstance(quality, bool) or not isinstance(quality, (str, int)):
                raise ValueError()
            quality = int(quality)
            if not 1 <= quality <= 100:
                raise ValueError()
        except (ValueError, TypeError):
            quality = 90
        return {
            "auto_webp": settings.get("auto_webp") is True,
            "webp_lossless": settings.get("webp_lossless") is not False,
            "webp_quality": quality,
        }

    def _update_auto_webp_controls(self):
        busy = self._active_job is not None
        enabled = bool(self.auto_webp_var.get()) and not busy
        self.auto_webp_checkbox.config(state="disabled" if busy else "normal")
        for button in self.auto_webp_mode_buttons:
            button.config(state="normal" if enabled else "disabled")
        self.auto_webp_quality_input.config(
            state="normal" if enabled and not self.webp_lossless_var.get() else "disabled"
        )

    def _refresh_job_controls(self):
        busy = self._active_job is not None
        actions = (
            (self.btn_run, "classify", "새 분류", "분류 중…", desktop_ui.ACCENT, "#ffffff"),
            (self.btn_reorg, "reorg", "재정렬", "재정렬 중…", desktop_ui.PANEL, desktop_ui.INK),
            (self.btn_scan_art, "art", "아티스트 스캔", "스캔 중…", desktop_ui.PANEL, desktop_ui.INK),
            (self.btn_sync, "brand", "브랜드 분석 및 동기화", "브랜드 동기화 중…", desktop_ui.PANEL, desktop_ui.INK),
            (self.btn_webp, "webp", "WebP 압축", "압축 중…", desktop_ui.PANEL, desktop_ui.INK),
        )
        for button, job, idle_text, active_text, color, foreground in actions:
            active = self._active_job == job
            button.config(state="disabled" if busy else "normal", text=active_text if active else idle_text,
                          bg=desktop_ui.SOFT if active else color, fg=desktop_ui.ACCENT if active else foreground)
        for button in (self.btn_reset_history, self.btn_reset_brand, self.btn_import):
            button.config(state="disabled" if busy else "normal")
        can_stop = self._active_job in ("classify", "reorg", "art", "webp")
        stopping = can_stop and self.stop_requested
        self.btn_stop.config(state="normal" if can_stop and not stopping else "disabled",
                             text="정지 요청됨" if stopping else "정지",
                             bg=desktop_ui.SOFT if stopping else desktop_ui.PANEL, fg=desktop_ui.ERROR)
        self._update_auto_webp_controls()

    def _launch_job(self, job, target, args=(), job_settings=None):
        if not self._can_start_job():
            return False
        self._job_token += 1
        self._active_job = job
        self._active_job_settings = job_settings
        self.stop_requested = False
        self.is_syncing = job == "brand"
        self._refresh_job_controls()
        kwargs = {"job_token": self._job_token}
        if job_settings is not None:
            kwargs["job_settings"] = job_settings
        try:
            Thread(target=target, args=args, kwargs=kwargs, daemon=True).start()
        except Exception as error:
            self._finish_job(job, self._job_token)
            self.log(f"❌ 작업을 시작하지 못했습니다: {error}")
            return False
        return True

    def _finish_job(self, job, job_token=None):
        if self._active_job != job or (job_token is not None and job_token != self._job_token):
            return False
        self._active_job = None
        self._active_job_settings = None
        self.is_syncing = False
        self._refresh_job_controls()
        return True

    def _snapshot_classify_job_settings(self, include_auto_webp=True):
        try:
            normal_workers = int(self.normal_thread_count_var.get())
            ai_workers = int(self.ai_thread_count_var.get())
            threshold = float(self.threshold_var.get())
            use_gpu = bool(self.use_gpu_var.get())
            if not 1 <= normal_workers <= 64 or not 1 <= ai_workers <= 16:
                raise ValueError("스레드 수 범위")
            if not math.isfinite(threshold) or not 0 <= threshold <= 100:
                raise ValueError("AI 감도 범위")
        except (ValueError, TypeError, tk.TclError):
            messagebox.showwarning("설정 확인", "일반 스레드는 1~64, AI 스레드는 1~16, AI 감도는 0~100 사이의 숫자로 입력해 주세요.")
            return None
        webp_settings = self._normalize_auto_webp_settings({})
        if include_auto_webp:
            try:
                raw_webp = {
                    "auto_webp": bool(self.auto_webp_var.get()),
                    "webp_lossless": bool(self.webp_lossless_var.get()),
                    "webp_quality": self.webp_quality_var.get(),
                }
                if raw_webp["auto_webp"] and not raw_webp["webp_lossless"]:
                    quality = raw_webp["webp_quality"]
                    if isinstance(quality, bool) or not isinstance(quality, (str, int)) or not 1 <= int(quality) <= 100:
                        raise ValueError()
                webp_settings = self._normalize_auto_webp_settings(raw_webp)
            except (ValueError, TypeError, tk.TclError):
                messagebox.showwarning("WebP 화질 확인", "손실 WebP 화질은 1~100의 정수로 입력해 주세요.")
                return None
        return {"normal_workers": normal_workers, "ai_workers": ai_workers,
                "ai_threshold": threshold / 100.0, "use_gpu": use_gpu, **webp_settings}

    def _worker_job_settings(self, job_settings):
        # Optional arguments preserve existing internal callers; workers never read Tk variables.
        return job_settings or self._active_job_settings or {
            "normal_workers": 4, "ai_workers": 2, "ai_threshold": 0.9998, "use_gpu": False,
        }

    def reset_brand_data(self):
        if not self._can_start_job():
            return
        db_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "TOTAL_CLASSIFIED", "naia_history.db")
        if not os.path.exists(db_path):
            messagebox.showerror("오류", "아직 데이터베이스(naia_history.db)가 생성되지 않았습니다.")
            return

        if messagebox.askyesno("브랜드 데이터 초기화", "기존에 수집된 모든 브랜드 정보(소속사)를 삭제하시겠습니까?"):
            try:
                conn = sqlite3.connect(db_path)
                cursor = conn.cursor()
                cursor.execute("UPDATE known_characters SET brand = NULL")
                conn.commit()
                conn.close()

                self.log("🧹 [시스템] 모든 브랜드 데이터가 초기화되었습니다. 다시 동기화를 눌러주세요.")
                if self.show_alert_var.get():
                    messagebox.showinfo("완료", "브랜드 정보가 초기화되었습니다.")
            except Exception as e:
                self.log(f"❌ 초기화 실패: {e}")

    def start_brand_sync(self):
        if not self._launch_job("brand", self._brand_sync_thread):
            return

        self.log("🌐 브랜드 동기화 작업을 시작합니다...")

        if not self.log_visible:
            self.toggle_log()

    def _brand_sync_thread(self, job_token=None):
        class UIStream:
            def __init__(self, log_func): self.log_func = log_func

            def write(self, s):
                if s.strip(): self.log_func(s.strip())

            def flush(self): pass

        old_stdout = sys.stdout
        sys.stdout = UIStream(self.log)

        try:
            global danbooru_sync

            try:
                if 'danbooru_sync' in sys.modules:
                    danbooru_sync = importlib.reload(sys.modules['danbooru_sync'])
                else:
                    import danbooru_sync as loaded_danbooru_sync
                    danbooru_sync = loaded_danbooru_sync

                danbooru_sync.sync_copyrights()
            except ImportError:
                self.log("\u274c danbooru_sync.py \ud30c\uc77c\uc744 \ucc3e\uc744 \uc218 \uc5c6\uc2b5\ub2c8\ub2e4.")
        except Exception as e:
            self.log(f"🚨 브랜드 동기화 에러: {e}")
        finally:
            sys.stdout = old_stdout
            self.root.after(0, lambda: self._finish_brand_sync_ui(job_token))

    def _finish_brand_sync_ui(self, job_token=None):
        if not self._finish_job("brand", job_token):
            return
        self.log("🏁 브랜드 동기화 완료.")
        if self.show_alert_var.get(): messagebox.showinfo("완료", "브랜드 동기화가 완료되었습니다.")

    def update_thread_guide(self):
        try:
            normal_t = int(self.normal_thread_count_var.get())
        except Exception:
            normal_t = 4

        try:
            ai_t = int(self.ai_thread_count_var.get())
        except Exception:
            ai_t = 2

        use_ai = bool(self.use_ai_var.get())

        if normal_t <= 4:
            normal_msg, color = "일반 안정", desktop_ui.ACCENT
        elif normal_t <= 15:
            normal_msg, color = "일반 균형", desktop_ui.MUTED
        elif normal_t <= 32:
            normal_msg, color = "일반 고속", desktop_ui.INFO
        else:
            normal_msg, color = "일반 익스트림", desktop_ui.WARNING

        if use_ai:
            if ai_t <= 2:
                ai_msg = "AI 안정"
            elif ai_t <= 4:
                ai_msg = "AI 균형"
            else:
                ai_msg = "AI 공격적"
            msg = f"🧵 {normal_msg} {normal_t}개 / 🧠 {ai_msg} {ai_t}개"
        else:
            msg = f"🧵 {normal_msg} {normal_t}개 / AI 꺼짐"

        self.guide_text_var.set(msg)
        self.lbl_thread_guide.config(fg=color)

    def apply_auto_config(self):
        use_ai = self.use_ai_var.get()
        use_gpu = self.use_gpu_var.get()
        cpu_cores = os.cpu_count() or 4
        vram_gb = 0
        if use_gpu:
            try:
                import torch
                if torch.cuda.is_available(): vram_gb = torch.cuda.get_device_properties(0).total_memory / (1024 ** 3)
            except:
                pass

        rec_normal_threads = min(32, max(4, cpu_cores * 2))

        if use_ai:
            if vram_gb > 0:
                if vram_gb <= 4.5:
                    rec_ai_threads = 1
                elif vram_gb <= 6.5:
                    rec_ai_threads = 2
                elif vram_gb <= 8.5:
                    rec_ai_threads = 3
                else:
                    rec_ai_threads = 4
            else:
                rec_ai_threads = max(1, min(4, cpu_cores // 2))
        else:
            rec_ai_threads = max(1, min(4, cpu_cores // 2))

        self.normal_thread_count_var.set(rec_normal_threads)
        self.ai_thread_count_var.set(rec_ai_threads)
        self.update_thread_guide()

    def _on_path_click(self, event):
        if self.path_var.get() == self.placeholder:
            self.path_var.set(self.full_path)
            self.path_entry.config(fg=desktop_ui.INK, bg=desktop_ui.PANEL)

    def _on_path_blur(self, event):
        new_val = self.path_var.get().strip()
        if new_val and new_val != self.placeholder:
            self.full_path = new_val
            utils.save_config({"path": self.full_path})
        self.path_var.set(self.placeholder)
        self.path_entry.config(fg=desktop_ui.MUTED, bg=desktop_ui.BG)

    def log(self, msg):
        # Workers only enqueue text; Tk is touched by the periodic UI drain.
        now = datetime.now().strftime("%H:%M:%S")
        with self._log_lock:
            if len(self._pending_logs) == self.LOG_QUEUE_LIMIT:
                self._dropped_logs += 1
            self._pending_logs.append(f"[{now}] {msg}\n")

    def _drain_logs(self):
        with self._log_lock:
            batch = [self._pending_logs.popleft() for _ in range(min(len(self._pending_logs), self.LOG_BATCH_SIZE))]
            dropped, self._dropped_logs = self._dropped_logs, 0
        if dropped:
            batch.insert(0, f"[로그] 대기열 한도로 이전 메시지 {dropped:,}개를 생략했습니다.\n")
        if batch:
            follow_end = self.log_area.yview()[1] >= 0.999
            text = ''.join(batch)
            self.log_area.config(state="normal")
            self.log_area.insert(tk.END, text)
            self._log_line_count += text.count('\n')
            excess = self._log_line_count - self.LOG_MAX_LINES
            if excess > 0:
                self.log_area.delete("1.0", f"{excess + 1}.0")
                self._log_line_count -= excess
            self.log_area.config(state="disabled")
            if follow_end:
                self.log_area.see(tk.END)
        self.root.after(self.LOG_FLUSH_MS, self._drain_logs)

    def _can_save_style_connection(self):
        if (self._active_job is not None or self.update_in_progress
                or self.server_transitioning or self.server_ready or self._closing):
            return False
        if self.server_process is not None and self.server_process.poll() is None:
            return False
        return not utils.is_port_active(5000)

    def open_style_connection(self):
        from naim.style_connection_ui import open_style_connection

        dialog = getattr(self, '_style_connection_dialog', None)
        if dialog is not None and dialog.winfo_exists():
            dialog.lift()
            dialog.focus_set()
            return
        self._style_connection_dialog = open_style_connection(
            self.root, APP_DIR, can_save=self._can_save_style_connection,
            on_saved=lambda: self.log('그림체 프로그램 연결을 저장했습니다. 다음 서버 시작부터 적용됩니다.'),
        )

    def open_legacy_import(self):
        if self.update_in_progress or self._active_job is not None:
            messagebox.showinfo("작업 중", "진행 중인 작업을 마친 뒤 자료를 가져와 주세요.")
            return
        if not messagebox.askyesno("기존 자료 가져오기", "현재 프로그램과 서버를 닫고 자료 가져오기 창을 열까요?"):
            return
        command = [sys.executable] if is_frozen_app() else [sys.executable, os.path.abspath(__file__)]
        try:
            subprocess.Popen(command + ["--import-data", str(os.getpid())], cwd=APP_DIR,
                             creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        except Exception as error:
            messagebox.showerror("가져오기 창 실행 실패", str(error))
            return
        self.on_closing()

    def browse(self):
        p = filedialog.askdirectory(initialdir=self.full_path)
        if p:
            self.full_path = os.path.normpath(p)
            utils.save_config({"path": self.full_path})
            self.log(f"📁 대상 경로 설정됨: {self.full_path}")

    def stop_process(self):
        if self._active_job not in ("classify", "reorg", "art", "webp"):
            return
        self.stop_requested = True
        self._refresh_job_controls()
        self.log("🛑 정지 버튼이 클릭되었습니다. 현재 작업이 끝나는 대로 멈춥니다.")

    def open_webp_compression(self):
        if not self._can_start_job():
            return
        dialog = getattr(self, '_webp_dialog', None)
        if dialog is not None and dialog.window.winfo_exists():
            dialog.window.lift()
            return
        from naim.webp_compression_ui import WebPCompressionDialog
        self._webp_dialog = WebPCompressionDialog(self)

    def update_progress(self, current, total, phase="진행 중"):
        now = time.monotonic()
        previous_phase, previous_at = getattr(self, "_last_progress_update", (None, 0))
        if phase == previous_phase and current not in (0, total) and now - previous_at < 0.1:
            return
        self._last_progress_update = (phase, now)

        def apply():
            try:
                current_num = int(current or 0)
                total_num = int(total or 0)
                percent = (current_num / total_num) * 100 if total_num else 0
            except Exception:
                current_num = current
                total_num = total
                percent = 0

            self.lbl_progress.config(
                text=f"{phase}: {current_num} / {total_num} ({percent:.1f}%)"
            )
            self.progress_bar.configure(value=max(0.0, min(100.0, percent)))

        self.root.after(0, apply)

    def reset_history(self):
        if not self._can_start_job():
            return
        if messagebox.askyesno("히스토리 초기화", "모든 분류 기록과 태그 캐시를 삭제하시겠습니까?"):
            try:
                db = utils.HistoryDB()
                with db.conn:
                    db.conn.execute("DELETE FROM processed_files")
                    db.conn.execute("DELETE FROM known_characters")
                db.close()
                self.log("🧹 DB 초기화 완료: 분류 이력 및 태그 캐시 삭제됨.")
            except Exception as e:
                self.log(f"❌ DB 초기화 실패: {e}")

    def start_art_scan(self):
        if not self._can_start_job():
            return
        # 🌟 [수정] 스캔 시작 시 기존 데이터를 초기화할지 묻는 옵션 추가
        ans = messagebox.askyesnocancel("그림체 스캔",
                                        "아티스트 스캔을 진행합니다.\n\n새로운 '조합형 그림체' 기준을 적용하려면 기존 데이터를 초기화해야 합니다.\n\n[예] 기존 내역 초기화 후 전체 재스캔 (권장)\n[아니오] 멈춘 부분부터 이어서 스캔\n[취소] 돌아가기")
        if ans is None:
            return

        self.clear_art_db = ans  # 🌟 초기화 여부 저장
        self._launch_job("art", self._art_scan_thread)

    def _art_scan_thread(self, job_token=None):
        try:
            classified_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "TOTAL_CLASSIFIED")
            # 🌟 [수정] clear_db 파라미터 전달
            image_logic.scan_and_extract_artists(classified_dir, clear_db=self.clear_art_db, log_func=self.log,
                                                 stop_check=lambda: self.stop_requested)
        except Exception as e:
            self.log(f"❌ 오류: {e}")
        finally:
            self.root.after(0, lambda: self._finish_job("art", job_token))

    def _read_normal_thread_count_for_settings(self):
        try:
            value = int(self.normal_thread_count_var.get())
        except Exception:
            value = 4
        return max(1, min(64, value))

    def _read_ai_thread_count_for_settings(self):
        try:
            value = int(self.ai_thread_count_var.get())
        except Exception:
            value = 2
        return max(1, min(16, value))

    def _read_thread_count_for_settings(self):
        # 기존 코드 호환용. 일반 스레드 값을 반환한다.
        return self._read_normal_thread_count_for_settings()

    def _read_ai_threshold_percent_for_settings(self):
        try:
            value = float(self.threshold_var.get())
        except Exception:
            value = 99.980
        return max(0.0, min(100.0, value))

    def save_desktop_settings(self):
        """Persist the launcher preference independently of classification settings."""
        value = bool(self.auto_open_gallery_var.get())
        try:
            merge_json_object(utils.CONFIG_FILE, {"auto_open_gallery": value})
        except Exception as error:
            self.auto_open_gallery_var.set(bool(self.config.get("auto_open_gallery", True)))
            self.log(f"❌ 리모콘 설정 저장 실패: {error}")
            messagebox.showerror("리모콘 설정 저장 실패", str(error))
            return False
        self.config["auto_open_gallery"] = value
        return True

    def save_classify_settings(self, silent=False):
        try:
            settings = {
                "method": self.classify_method_var.get(),
                "delete_comic_duplicates": bool(self.delete_comic_duplicates_var.get()),
                "show_alert": bool(self.show_alert_var.get()),
                "is_fast_mode": bool(self.is_fast_mode.get()),
                "use_ai": bool(self.use_ai_var.get()),
                "use_gpu": bool(self.use_gpu_var.get()),
                "skip_nsfw": bool(self.skip_nsfw_var.get()),
                "skip_char": bool(self.skip_char_var.get()),
                "thread_count": self._read_normal_thread_count_for_settings(),
                "normal_thread_count": self._read_normal_thread_count_for_settings(),
                "ai_thread_count": self._read_ai_thread_count_for_settings(),
                "ai_threshold_percent": self._read_ai_threshold_percent_for_settings(),
                **self._normalize_auto_webp_settings({
                    "auto_webp": bool(self.auto_webp_var.get()),
                    "webp_lossless": bool(self.webp_lossless_var.get()),
                    "webp_quality": self.webp_quality_var.get(),
                }),
            }

            utils.save_config({"classify_settings": settings})

            if not silent:
                self.log("💾 분류 설정을 저장했습니다.")
                messagebox.showinfo(
                    "분류 설정 저장",
                    "현재 분류 설정을 저장했습니다.\n\n다음 실행부터 이 설정이 자동으로 적용됩니다."
                )

        except Exception as e:
            self.log(f"❌ 분류 설정 저장 실패: {e}")
            if not silent:
                messagebox.showerror("분류 설정 저장 실패", str(e))

    def show_action_confirm_dialog(
        self, title, icon, target_title, target_value, method_title, method_value,
        method_desc, options, confirm_text, accent_color, warning_text=None,
    ):
        return messagebox.action_confirm(
            self, title, icon, target_title, target_value, method_title, method_value,
            method_desc, options, confirm_text, accent_color, warning_text,
        )

    def show_reorg_target_dialog(self):
        return messagebox.choose_reorg_target(self)

    def start_process(self):
        if not self._can_start_job():
            return
        if self.full_path == self.placeholder or not os.path.exists(self.full_path):
            messagebox.showwarning("경고", "올바른 대상 폴더 경로를 선택해주세요.")
            return

        job_settings = self._snapshot_classify_job_settings()
        if job_settings is None:
            return
        if job_settings["auto_webp"] and (self.server_transitioning or utils.is_port_active(5000)):
            messagebox.showwarning("웹 서버 중지 필요", "자동 WebP 변환을 사용하려면 웹 서버를 중지한 뒤 새 분류를 실행해 주세요.")
            return
        method = self.classify_method_var.get()
        delete_comic_duplicates = self.delete_comic_duplicates_var.get()
        is_fast = self.is_fast_mode.get()
        use_ai = self.use_ai_var.get()
        if use_ai and is_frozen_app() and not image_logic.is_ai_available():
            use_ai = False
            self.use_ai_var.set(False)
            self.log("ℹ️ 이 lite exe에는 AI 자동분류 패키지가 포함되어 있지 않아 일반 분류로 진행합니다.")
        skip_nsfw = self.skip_nsfw_var.get()
        skip_char = self.skip_char_var.get()  # 🌟

        m_txt = "복사" if method == "copy" else "이동"
        f_txt = "켜짐" if is_fast else "꺼짐"
        a_txt = "켜짐" if use_ai else "꺼짐"
        g_txt = "켜짐" if job_settings["use_gpu"] else "꺼짐"
        s_txt = "무시 (전부 일반짤 처리)" if skip_nsfw else "판독 진행"
        c_txt = "무시 (하위 폴더 미생성)" if skip_char else "판별 진행"  # 🌟
        t_txt = f"일반 {job_settings['normal_workers']} / AI {job_settings['ai_workers']}"

        method_desc = (
            "원본 이미지는 그대로 두고, 분류 결과 폴더에 복사합니다."
            if method == "copy"
            else "원본 이미지를 분류 결과 폴더로 이동합니다. 원래 위치에서는 사라질 수 있습니다."
        )

        method_value = "복사: 원본 유지" if method == "copy" else "이동: 원본 이동"
        webp_mode = "무손실" if job_settings["webp_lossless"] else f"손실 · 화질 {job_settings['webp_quality']}"
        webp_warning = None
        if job_settings["auto_webp"]:
            webp_warning = "이번에 분류한 PNG만 WebP로 변환하고 메타데이터 보존 검증 후 분류된 PNG를 삭제합니다."
            if method == "copy":
                webp_warning += "\n복사 모드의 입력 원본은 WebP 변환으로 삭제하지 않습니다."

        if not self.show_action_confirm_dialog(
            title="새 이미지 분류 실행 확인",
            icon="▶",
            target_title="대상 폴더",
            target_value=self.full_path,
            method_title="파일 처리 방식",
            method_value=method_value,
            method_desc=method_desc,
            options=[
                {"label": "바깥 코믹 중복 원본", "value": "가져오기 성공 후 삭제" if delete_comic_duplicates else "유지", "state": delete_comic_duplicates},
                {"label": "분류 후 WebP 변환", "value": webp_mode if job_settings["auto_webp"] else "사용 안 함", "state": job_settings["auto_webp"]},
                {"label": "분류 이력 활용", "value": f_txt, "state": is_fast},
                {"label": "AI 야짤 정밀 판독", "value": a_txt, "state": use_ai},
                {"label": "GPU 가속", "value": g_txt, "state": job_settings["use_gpu"]},
                {"label": "수위 감지", "value": s_txt, "state": not skip_nsfw},
                {"label": "캐릭터 판별", "value": c_txt, "state": not skip_char},
                {"label": "스레드 수", "value": str(t_txt), "state": None},
            ],
            confirm_text="분류 시작",
            accent_color="#0984e3",
            warning_text=webp_warning,
        ):
            return

        if job_settings["auto_webp"] and (self.server_transitioning or utils.is_port_active(5000)):
            messagebox.showwarning("웹 서버 중지 필요", "웹 서버가 시작되어 자동 WebP 분류를 시작하지 않았습니다. 서버를 중지한 뒤 다시 실행해 주세요.")
            return

        self.save_classify_settings(silent=True)

        self._launch_job("classify", self._logic_thread,
                         args=(self.full_path, method, is_fast, use_ai, skip_nsfw, skip_char, delete_comic_duplicates),
                         job_settings=job_settings)

    def _logic_thread(self, source, method, is_fast, use_ai, skip_nsfw, skip_char, delete_comic_duplicates=False,
                      job_settings=None, job_token=None):
        try:
            settings = self._worker_job_settings(job_settings)
            image_logic.process(source, method=method, is_fast=is_fast, use_ai=use_ai, use_gpu=settings["use_gpu"],
                                delete_comic_duplicates=delete_comic_duplicates,
                                auto_webp=settings.get("auto_webp", False),
                                webp_lossless=settings.get("webp_lossless", True),
                                webp_quality=settings.get("webp_quality", 90),
                                normal_workers=settings["normal_workers"],
                                ai_workers=settings["ai_workers"],
                                ai_threshold=settings["ai_threshold"],
                                log_func=self.log, stop_check=lambda: self.stop_requested,
                                progress_update=self.update_progress, skip_nsfw=skip_nsfw, skip_char_id=skip_char)
            self.log("✅ [작업 완료] 새 이미지 처리가 끝났습니다.")
        except Exception as e:
            self.log(f"❌ 오류: {e}")
        finally:
            self.root.after(0, lambda: self._finish_job("classify", job_token))

    def start_reorg(self):
        if not self._can_start_job():
            return
        job_settings = self._snapshot_classify_job_settings(include_auto_webp=False)
        if job_settings is None:
            return
        # 전체/부분 재정렬 선택창
        reorg_choice = self.show_reorg_target_dialog()

        if reorg_choice is None:
            return

        reorg_target = None

        if reorg_choice == "partial":
            initial = os.path.join(os.path.dirname(os.path.abspath(__file__)), "TOTAL_CLASSIFIED")
            selected = filedialog.askdirectory(title="부분 재정렬할 타겟 폴더 선택", initialdir=initial)

            if not selected:
                return

            reorg_target = os.path.normpath(selected)
            disp_target = f"부분 재정렬 ({os.path.basename(reorg_target)})"
        else:
            disp_target = "전면 재정렬 (전체)"

        # 🌟 [신규] 실행 전 확인 팝업 구성
        use_ai = self.use_ai_var.get()
        if use_ai and is_frozen_app() and not image_logic.is_ai_available():
            use_ai = False
            self.use_ai_var.set(False)
            self.log("ℹ️ 이 lite exe에는 AI 자동분류 패키지가 포함되어 있지 않아 일반 재정렬로 진행합니다.")
        skip_nsfw = self.skip_nsfw_var.get()
        skip_char = self.skip_char_var.get()  # 🌟

        a_txt = "켜짐" if use_ai else "꺼짐"
        g_txt = "켜짐" if job_settings["use_gpu"] else "꺼짐"
        s_txt = "무시 (모두 기존 폴더/일반짤 처리)" if skip_nsfw else "판독 진행"
        c_txt = "무시 (하위 폴더 미생성)" if skip_char else "판별 진행"  # 🌟
        t_txt = f"일반 {job_settings['normal_workers']} / AI {job_settings['ai_workers']}"

        if not self.show_action_confirm_dialog(
            title="재정렬 실행 확인",
            icon="🔄",
            target_title="재정렬 대상",
            target_value=disp_target,
            method_title="파일 처리 방식",
            method_value="이동 고정",
            method_desc="재정렬은 기존 분류 폴더를 다시 배치하는 작업이므로 항상 이동 방식으로 처리됩니다.",
            options=[
                {"label": "AI 야짤 정밀 판독", "value": a_txt, "state": use_ai},
                {"label": "GPU 가속", "value": g_txt, "state": job_settings["use_gpu"]},
                {"label": "수위 감지", "value": s_txt, "state": not skip_nsfw},
                {"label": "캐릭터 판별", "value": c_txt, "state": not skip_char},
                {"label": "스레드 수", "value": str(t_txt), "state": None},
            ],
            confirm_text="재정렬 시작",
            accent_color="#e17055",
            warning_text="상단의 복사/이동 선택은 새 분류에만 적용됩니다. 재정렬은 항상 이동 방식입니다.",
        ):
            return

        self.save_classify_settings(silent=True)

        self._launch_job("reorg", self._reorg_thread,
                         args=(use_ai, skip_nsfw, skip_char, reorg_target), job_settings=job_settings)

    def _reorg_thread(self, use_ai, skip_nsfw, skip_char, reorg_target, job_settings=None, job_token=None):
        try:
            settings = self._worker_job_settings(job_settings)
            image_logic.process(self.full_path, method="move", is_fast=False, reorg_mode=True, use_ai=use_ai,
                                use_gpu=settings["use_gpu"],
                                normal_workers=settings["normal_workers"],
                                ai_workers=settings["ai_workers"],
                                ai_threshold=settings["ai_threshold"],
                                log_func=self.log, stop_check=lambda: self.stop_requested,
                                progress_update=self.update_progress, skip_nsfw=skip_nsfw, skip_char_id=skip_char,
                                reorg_target=reorg_target)
            self.log("✅ [재정렬 완료] 폴더가 완벽히 재배치되었습니다.")
        except Exception as e:
            self.log(f"❌ 오류: {e}")
        finally:
            self.root.after(0, lambda: self._finish_job("reorg", job_token))

    def start_server(self):
        if self._has_active_webp_job():
            self.log('⏳ WebP 압축이 끝난 뒤 서버를 켤 수 있습니다.')
            return
        if self.server_transitioning:
            self.log("⏳ 서버 상태 전환 중입니다. 잠시만 기다려주세요.")
            return
        if self.server_process is not None and self.server_process.poll() is None:
            self.log("ℹ️ 서버가 이미 실행 중입니다.")
            return
        self.is_opened = False
        self.server_ready = False
        self.server_transitioning = True
        self.server_monitor_token += 1
        monitor_token = self.server_monitor_token
        results = Queue()
        cancel = Event()
        self._server_start_queue = results
        self._server_start_cancel = cancel
        self._set_server_transition_ui("● 서버 준비 중…", "", "")
        self.log("📡 서버를 준비하고 있습니다.")
        try:
            Thread(target=self._launch_server_worker, args=(results, cancel), daemon=True).start()
        except Exception as error:
            self._server_start_queue = None
            self._server_start_cancel = None
            self._server_start_failed(str(error))
            return
        self.root.after(50, lambda: self._poll_server_start(monitor_token, results))

    def _launch_server_worker(self, results, cancel):
        """Blocking launch work never touches Tk; the UI polls one result."""
        process = None
        result = ("cancelled", None)
        try:
            if cancel.is_set():
                return
            if utils.is_port_active(5000):
                result = ("occupied", None)
                return
            if cancel.is_set():
                return
            creation_flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
            env = os.environ.copy()
            env["PYTHONIOENCODING"] = "utf-8"
            control_token = secrets.token_urlsafe(32)
            env["NAIM_SERVER_CONTROL_TOKEN"] = control_token
            server_cmd = [sys.executable, "--server"] if is_frozen_app() else [sys.executable, "-u", os.path.join(APP_DIR, "app.py")]
            process = subprocess.Popen(server_cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                       encoding='utf-8', errors='replace', bufsize=1, cwd=APP_DIR, env=env,
                                       creationflags=creation_flags)
            process._naim_control_token = control_token
            result = ("started", process)
        except Exception as error:
            result = ("error", str(error))
        finally:
            try:
                if cancel.is_set() and process is not None:
                    self._discard_unready_server(process)
                    result = ("cancelled", None)
            finally:
                results.put(result)

    @staticmethod
    def _discard_unready_server(process):
        """Reap only our new child; no HTTP/port cleanup is needed before readiness."""
        try:
            running = process.poll() is None
        except Exception:
            running = True
        try:
            if running:
                try:
                    process.terminate()
                except Exception:
                    pass  # The child may have exited since the last poll.
                try:
                    process.wait(timeout=1)
                except Exception:
                    try:
                        process.kill()
                    except Exception:
                        pass
        finally:
            if process.stdout is not None:
                try:
                    process.stdout.close()
                except Exception:
                    pass

    def _poll_server_start(self, monitor_token, results):
        try:
            status, value = results.get_nowait()
        except Empty:
            self.root.after(50, lambda: self._poll_server_start(monitor_token, results))
            return
        current = monitor_token == self.server_monitor_token and results is self._server_start_queue
        if status == "started" and (not current or self._closing):
            # Keep close pending until the stale child is reaped off the Tk thread.
            def discard():
                try:
                    self._discard_unready_server(value)
                finally:
                    results.put(("cancelled", None))
            try:
                Thread(target=discard, daemon=True).start()
            except Exception:
                discard()  # Bounded cleanup if a new thread cannot be allocated.
            self.root.after(50, lambda: self._poll_server_start(monitor_token, results))
            return
        if results is self._server_start_queue:
            self._server_start_queue = None
            self._server_start_cancel = None
        if not current or self._closing:
            return
        if status == "started":
            self.server_process = value
            try:
                Thread(target=self.monitor_server, args=(value, monitor_token), daemon=True).start()
            except Exception as error:
                self._discard_unready_server(value)
                self._server_start_failed(str(error))
        elif status == "occupied":
            self.server_transitioning = False
            self._set_external_server_ui()
            if messagebox.askyesno("서버 충돌", "5000포트가 이미 사용 중입니다.\n기존 프로세스를 강제로 종료하고 새로 켤까요?"):
                self.stop_server(
                    on_complete=lambda: self.log("🧹 서버를 종료했습니다. 이제 다시 켤 수 있습니다."),
                    force_port_cleanup=True,
                )
        elif status == "error":
            self._server_start_failed(value)
        else:
            self.server_transitioning = False
            self._set_server_offline_ui()

    def _server_start_failed(self, error):
        self.server_transitioning = False
        self.server_process = None
        self.log(f"❌ 서버 시작 실패: {error}")
        self._set_server_offline_ui()

    def _set_server_online_ui(self):
        desktop_ui.set_server_loading(self, False)
        pid = self.server_process.pid if self.server_process else "알 수 없음"
        self.server_status_var.set("● 서버 실행 중")
        self.lbl_status.config(fg=desktop_ui.ACCENT)
        self.btn_server.config(text="서버 중지", state="normal", bg=desktop_ui.PANEL, fg=desktop_ui.INK)
        desktop_ui.fit_controller_window(self, show_log=self.log_visible)
        self.log(f"서버 준비 완료 (PID: {pid})")

    def _mark_server_ready(self, process, monitor_token):
        if monitor_token != self.server_monitor_token or self.server_process is not process or self.server_ready:
            return
        self.is_opened = True
        self.server_ready = True
        self.server_transitioning = False
        self._set_server_online_ui()
        if self.auto_open_gallery_var.get():
            self.open_gallery()

    def monitor_server(self, process, monitor_token):
        exit_code = None
        try:
            # 🌟 서버가 시작되자마자 PID를 로그에 한 번 더 찍어줍니다. [cite: 71]
            if process:
                self.log(f"🚀 서버 프로세스 생성됨 (PID: {process.pid})")

            for line in iter(process.stdout.readline, ''):
                if line:
                    clean_line = line.strip()
                    self.log(f"[서버] {clean_line}")
                    if not self.is_opened and ("SERVER_READY" in clean_line or "Running on http" in clean_line):
                        self.root.after(0, lambda p=process, t=monitor_token: self._mark_server_ready(p, t))
            exit_code = process.wait()
        except Exception as e:
            self.root.after(0, lambda err=e: self.log(f"⚠️ 서버 모니터링 에러: {err}"))
        finally:
            self.root.after(0, lambda p=process, t=monitor_token, code=exit_code: self._finalize_server_monitor(p, t, code))

    def _finalize_server_monitor(self, process, monitor_token, exit_code):
        if monitor_token != self.server_monitor_token:
            return

        was_ready = self.server_ready
        if self.server_process is process:
            self.server_process = None

        self.server_transitioning = False
        self.is_opened = False
        self.server_ready = False

        if utils.is_port_active(5000):
            self._set_external_server_ui()
        else:
            self._set_server_offline_ui()

        if exit_code not in (None, 0):
            self.log(f"⚠️ 서버 프로세스가 종료되었습니다. (exit code: {exit_code})")
        elif was_ready:
            self.log("ℹ️ 서버가 정상적으로 종료되었습니다.")

    def _set_server_offline_ui(self):
        desktop_ui.set_server_loading(self, False)
        self.server_status_var.set("● 서버 중지됨")
        self.lbl_status.config(fg=desktop_ui.MUTED)
        self.btn_server.config(text="서버 시작", state="normal", bg=desktop_ui.PANEL, fg=desktop_ui.INK)
        desktop_ui.fit_controller_window(self, show_log=self.log_visible)

    def toggle_log(self):
        desktop_ui.fit_controller_window(self, show_log=not self.log_visible)

    def _finish_update_check(self):
        self.update_in_progress = False
        if hasattr(self, "btn_update"):
            self.btn_update.config(state="normal")

    def check_for_exe_update(self):
        if not is_frozen_app() or self.update_in_progress:
            return
        self.update_in_progress = True
        self.btn_update.config(state="disabled")
        self.log("🔎 GitHub에서 EXE 업데이트를 확인합니다...")

        def worker():
            try:
                manifest = exe_update.fetch_manifest()
                available = exe_update.is_update_available(exe_update.APP_VERSION, manifest)
            except Exception as exc:
                error_message = str(exc)
                self.root.after(0, lambda: self._show_update_error(error_message))
                return
            self.root.after(0, lambda: self._show_update_result(manifest, available))

        Thread(target=worker, daemon=True).start()

    def _show_update_error(self, error_message):
        self._finish_update_check()
        self.log(f"❌ 업데이트 확인 실패: {error_message}")
        messagebox.showerror("업데이트 확인 실패", error_message)

    def _show_update_result(self, manifest, available):
        if not available:
            self._finish_update_check()
            self.log("✅ 현재 EXE가 최신 버전입니다.")
            messagebox.showinfo(
                "업데이트 확인",
                f"현재 버전 v{exe_update.APP_VERSION}이 최신 버전입니다.",
            )
            return

        summary = manifest.get("summary") or "새 EXE 버전이 준비되었습니다."
        confirmed = messagebox.askyesno(
            "EXE 업데이트",
            f"현재 버전: v{exe_update.APP_VERSION}\n"
            f"새 버전: v{manifest['version']}\n\n"
            f"{summary}\n\n"
            "프로그램을 종료하고 업데이트할까요?\n"
            "개인 설정과 TOTAL_CLASSIFIED는 그대로 유지됩니다.",
        )
        if not confirmed:
            self._finish_update_check()
            return

        try:
            updater = exe_update.resolve_updater_executable(APP_DIR, frozen=True)
            command = exe_update.build_updater_command(APP_DIR, os.getpid(), sys.executable)
            command[0] = str(updater)
            subprocess.Popen(command, cwd=APP_DIR)
        except Exception as exc:
            self._show_update_error(str(exc))
            return

        self.log(f"⬆ v{manifest['version']} 업데이터를 시작했습니다.")
        self.root.after(150, self.on_closing)

    def open_gallery(self):
        if not utils.is_port_active(5000):
            if self.show_alert_var.get(): messagebox.showwarning("경고", "서버가 켜져 있지 않습니다.")
            return
        webbrowser.open("http://127.0.0.1:5000")
        self.log("🌐 갤러리를 열었습니다.")


if __name__ == "__main__":
    # 🌟 3. 메인 로직 구동 (위의 검사를 모두 무사히 통과했을 때만 실행됨)
    if os.name == "nt":
        # Give source launches their own taskbar identity instead of Python's.
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("NAI.ImageManager")
    root = tk.Tk()
    app = NaiaHyperExecutor(root)
    root.protocol("WM_DELETE_WINDOW", app.on_closing)
    root.mainloop()
