# -*- coding: utf-8 -*-
import os
import sys
import subprocess


def get_app_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------
# .venv 우선 진입
# 프로젝트 모듈(utils, image_logic 등)을 import하기 전에 반드시 실행한다.
# ---------------------------------------------------------
APP_DIR = get_app_dir()

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
import tkinter as tk
from tkinter import filedialog, scrolledtext, messagebox
from threading import Thread
from datetime import datetime
import webbrowser
import sqlite3
import importlib
import ctypes


try:
    import utils
    import image_logic

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
        "   pip install flask requests pillow\n\n"
        "※ .venv가 없거나, 현재 사용 중인 Python 환경에 필수 패키지가 누락된 상태입니다."
    )

    messagebox.showerror("NAI Image Manager - 실행 오류", error_msg)
    sys.exit(1)


class NaiaHyperExecutor:
    def __init__(self, root):
        self.root = root
        self.root.title("NAI ImageManager MASTER CONTROL")
        self.root.geometry("750x780")
        self.root.configure(bg="#1e1e2e")
        self.admin_mode = self.is_admin()

        self.config = utils.load_config()
        self.full_path = self.config.get("path", os.getcwd())

        classify_settings = self.config.get("classify_settings", {})
        if not isinstance(classify_settings, dict):
            classify_settings = {}

        self.show_alert_var = tk.BooleanVar(value=bool(classify_settings.get("show_alert", True)))
        self.is_fast_mode = tk.BooleanVar(value=bool(classify_settings.get("is_fast_mode", True)))
        self.classify_method_var = tk.StringVar(value=str(classify_settings.get("method", "copy")))

        self.stop_requested = False
        self.log_visible = False

        self.server_process = None
        self.is_opened = False
        self.server_transitioning = False
        self.server_ready = False
        self.server_monitor_token = 0

        self.server_status_var = tk.StringVar(value="🔴 서버 중지됨")
        self.is_syncing = False

        self.setup_ui()

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
        self.lbl_status.config(fg=status_color)
        self.btn_server.config(text=button_text, state="disabled", bg="#555", fg="#ffffff")

    def _set_external_server_ui(self):
        self.server_status_var.set("🟠 기존/외부 서버 감지됨")
        self.lbl_status.config(fg="#ffb300")
        self.btn_server.config(text="💀 남은 서버 강제 종료 및 청소", state="normal", bg="#d63031", fg="#fff")

    def _terminate_managed_server_process(self, process, wait=False):
        if not process or process.poll() is not None:
            return

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
        if self.server_transitioning:
            self.log("⏳ 서버 시작/종료 전환 중입니다. 잠시만 기다려주세요.")
            return

        # 포트가 열려 있는데 관리 프로세스가 없다면 '강제 종료' 모드 수행
        if self.server_process is None and utils.is_port_active(5000):
            if messagebox.askyesno("서버 충돌", "5000포트가 이미 사용 중입니다.\n기존 프로세스를 강제로 종료하고 새로 켤까요?"):
                self.stop_server(
                    on_complete=lambda: self.log("🧹 서버를 종료했습니다. 이제 다시 켤 수 있습니다."),
                    force_port_cleanup=True
                )
            return

        if self.server_process is None or self.server_process.poll() is not None:
            self.start_server()
        else:
            self.stop_server()

    def create_section_header(self, parent, title):
        # 🌟 구역 간의 세로 여백(pady)을 줄여서 화면을 압축합니다.
        frame = tk.Frame(parent, bg="#1e1e2e", pady=3)
        frame.pack(fill="x", padx=10)
        tk.Label(frame, text=title, font=("Malgun Gothic", 11, "bold"), bg="#1e1e2e", fg="#a29bfe").pack(side="left")
        tk.Frame(frame, bg="#444", height=1).pack(side="left", fill="x", expand=True, padx=(10, 0))
        return frame

    def setup_ui(self):
        self.placeholder = "───────── 클릭하여 대상 폴더 경로 표시 ─────────"
        self.path_var = tk.StringVar(value=self.placeholder)

        # ==========================================
        # 👑 헤더 영역 (780px 높이 내에서 최적화)
        # ==========================================
        header = tk.Frame(self.root, bg="#161625", pady=10)
        header.pack(fill="x")

        # 상단 버튼 라인 (관리자 & 로그 토글을 한 줄에 배치)
        top_btn_line = tk.Frame(header, bg="#161625")
        top_btn_line.pack(fill="x", padx=15)

        # [왼쪽] 관리자 권한 버튼/상태
        admin_frame = tk.Frame(top_btn_line, bg="#161625")
        admin_frame.pack(side="left")

        if self.admin_mode:
            tk.Label(admin_frame, text="🛡️ ADMIN MODE", font=("Malgun Gothic", 9, "bold"),
                     bg="#161625", fg="#39ff14").pack()
        else:
            tk.Button(admin_frame, text="🔓 관리자 권한으로 실행", command=self.run_as_admin,
                      bg="#0984e3", fg="#fff", font=("Malgun Gothic", 8, "bold"),
                      relief="flat", padx=10, cursor="hand2").pack()

        # [오른쪽] 로그 창 토글 버튼
        self.btn_log_toggle = tk.Button(top_btn_line, text="📜 로그 창 토글", command=self.toggle_log,
                                        bg="#3b3b4f", fg="#ffffff", font=("Malgun Gothic", 8, "bold"),
                                        relief="flat", padx=10, cursor="hand2")
        self.btn_log_toggle.pack(side="right")

        # [중앙] 메인 타이틀
        tk.Label(header, text="👑 NAI ImageManager", font=("Malgun Gothic", 24, "bold"),
                 bg="#161625", fg="#ff007c").pack(pady=(0, 2))

        # [중앙] 서버 상태 배지
        self.lbl_status = tk.Label(header, textvariable=self.server_status_var, font=("Malgun Gothic", 11, "bold"),
                                   bg="#161625", fg="#ff4d4d")
        self.lbl_status.pack()

        # ==========================================
        # 메인 컨테이너 (이하 기존과 동일)
        # ==========================================
        self.main_container = tk.Frame(self.root, bg="#1e1e2e")
        self.main_container.pack(fill="both", expand=True)

        self.ctrl_panel = tk.Frame(self.main_container, bg="#1e1e2e", padx=25)
        self.ctrl_panel.pack(side="left", fill="both", expand=True)

        self.log_sidebar = tk.Frame(self.main_container, bg="#050508", width=380, highlightbackground="#444",
                                    highlightthickness=1)
        self.log_sidebar.pack_propagate(False)

        # ==========================================
        # 📂 구역 1: 기본 경로 및 설정
        # ==========================================
        self.create_section_header(self.ctrl_panel, "📂 기본 설정")

        path_frame = tk.Frame(self.ctrl_panel, bg="#1e1e2e")
        path_frame.pack(fill="x", pady=2)

        self.path_entry = tk.Entry(path_frame, textvariable=self.path_var, font=("Consolas", 10),
                                   bg="#2a2a35", fg="#888", border=0, justify="center")
        self.path_entry.pack(side="left", expand=True, fill="x", ipady=6)
        self.path_entry.bind("<Button-1>", self._on_path_click)
        self.path_entry.bind("<FocusOut>", self._on_path_blur)

        tk.Button(path_frame, text=" 폴더 선택 ", command=self.browse, bg="#4b4b6b", fg="#ffffff",
                  font=("Malgun Gothic", 9, "bold"), relief="flat", padx=10).pack(side="right", padx=(10, 0))

        opt_frame = tk.Frame(self.ctrl_panel, bg="#1e1e2e")
        opt_frame.pack(fill="x", pady=(2, 4))

        option_top_row = tk.Frame(opt_frame, bg="#1e1e2e")
        option_top_row.pack(fill="x")

        tk.Checkbutton(
            option_top_row,
            text="알림창 끄기",
            variable=self.show_alert_var,
            onvalue=False,
            offvalue=True,
            bg="#1e1e2e",
            fg="#ccc",
            selectcolor="#222"
        ).pack(side="left")

        tk.Checkbutton(
            option_top_row,
            text="⚡ 분류 이력 활용 (고속)",
            variable=self.is_fast_mode,
            bg="#1e1e2e",
            fg="#ffb300",
            selectcolor="#222"
        ).pack(side="left", padx=5)

        tk.Button(
            option_top_row,
            text="분류 설정 저장",
            command=self.save_classify_settings,
            bg="#2d3436",
            fg="#55efc4",
            font=("Malgun Gothic", 8, "bold"),
            relief="flat",
            width=13
        ).pack(side="right", padx=(6, 0))

        tk.Button(
            option_top_row,
            text="이력 초기화",
            command=self.reset_history,
            bg="#4a1a1a",
            fg="#ff6b6b",
            font=("Malgun Gothic", 8, "bold"),
            relief="flat",
            width=11
        ).pack(side="right", padx=(6, 0))

        method_row = tk.Frame(opt_frame, bg="#1e1e2e")
        method_row.pack(fill="x", pady=(6, 0))

        method_frame = tk.LabelFrame(
            method_row,
            text="새 분류 파일 처리 방식",
            bg="#1e1e2e",
            fg="#00f2ff",
            font=("Malgun Gothic", 8, "bold"),
            padx=8,
            pady=4,
            bd=1,
            relief="groove"
        )
        method_frame.pack(side="left", fill="x", expand=True)

        tk.Radiobutton(
            method_frame,
            text="📄 복사: 원본 유지",
            variable=self.classify_method_var,
            value="copy",
            bg="#1e1e2e",
            fg="#39ff14",
            selectcolor="#222",
            activebackground="#1e1e2e",
            activeforeground="#39ff14",
            font=("Malgun Gothic", 9, "bold")
        ).pack(side="left", padx=(4, 18))

        tk.Radiobutton(
            method_frame,
            text="📦 이동: 원본을 분류 폴더로 이동",
            variable=self.classify_method_var,
            value="move",
            bg="#1e1e2e",
            fg="#ffb300",
            selectcolor="#222",
            activebackground="#1e1e2e",
            activeforeground="#ffb300",
            font=("Malgun Gothic", 9, "bold")
        ).pack(side="left", padx=(0, 12))

        tk.Label(
            method_frame,
            text="※ 재정렬은 항상 이동 방식",
            bg="#1e1e2e",
            fg="#888",
            font=("Malgun Gothic", 8)
        ).pack(side="right", padx=(8, 2))

        # ==========================================
        # ⚙️ 구역 2: 시스템 및 AI 세팅
        # ==========================================
        self.create_section_header(self.ctrl_panel, "⚙️ AI 및 시스템 성능")

        ai_frame = tk.Frame(self.ctrl_panel, bg="#1e1e2e")
        ai_frame.pack(fill="x")

        classify_settings = self.config.get("classify_settings", {})
        if not isinstance(classify_settings, dict):
            classify_settings = {}

        self.use_ai_var = tk.BooleanVar(value=bool(classify_settings.get("use_ai", False)))
        self.use_gpu_var = tk.BooleanVar(value=bool(classify_settings.get("use_gpu", False)))
        self.skip_nsfw_var = tk.BooleanVar(value=bool(classify_settings.get("skip_nsfw", False)))
        self.skip_char_var = tk.BooleanVar(value=bool(classify_settings.get("skip_char", False)))  # 🌟 [신규] 캐릭터 판별 무시 변수

        tk.Checkbutton(ai_frame, text="🤖 딥러닝 AI 야짤 정밀 판독", variable=self.use_ai_var, bg="#1e1e2e", fg="#00f2ff",
                       selectcolor="#222", font=("Malgun Gothic", 9, "bold")).pack(side="left")
        tk.Checkbutton(ai_frame, text="🚀 GPU 가속", variable=self.use_gpu_var, bg="#1e1e2e", fg="#39ff14",
                       selectcolor="#222", font=("Malgun Gothic", 9, "bold")).pack(side="left", padx=(10, 5))
        tk.Checkbutton(ai_frame, text="🙈 수위 무시", variable=self.skip_nsfw_var, bg="#1e1e2e", fg="#ff9ff3",
                       selectcolor="#222", font=("Malgun Gothic", 9, "bold")).pack(side="left", padx=5)
        tk.Checkbutton(ai_frame, text="👤 캐릭 판별 무시", variable=self.skip_char_var, bg="#1e1e2e", fg="#feca57",
                       selectcolor="#222", font=("Malgun Gothic", 9, "bold")).pack(side="left", padx=5)

        perf_frame = tk.Frame(self.ctrl_panel, bg="#1e1e2e")
        perf_frame.pack(fill="x", pady=2)

        perf_frame = tk.Frame(self.ctrl_panel, bg="#1e1e2e")
        perf_frame.pack(fill="x", pady=2)

        tk.Label(perf_frame, text="스레드:", font=("Malgun Gothic", 9, "bold"), bg="#1e1e2e", fg="#fff").pack(side="left")
        self.thread_count_var = tk.IntVar(value=int(classify_settings.get("thread_count", 4)))
        self.thread_spin = tk.Spinbox(perf_frame, from_=1, to=64, textvariable=self.thread_count_var, width=4,
                                      bg="#2a2a35", fg="#fff", border=0, command=self.update_thread_guide)
        self.thread_spin.pack(side="left", padx=5)
        self.thread_spin.bind("<KeyRelease>", lambda e: self.update_thread_guide())

        tk.Label(perf_frame, text="AI 감도(%):", font=("Malgun Gothic", 9, "bold"), bg="#1e1e2e", fg="#fff").pack(
            side="left", padx=(10, 0))
        self.threshold_var = tk.DoubleVar(value=float(classify_settings.get("ai_threshold_percent", 99.980)))
        self.threshold_spin = tk.Spinbox(perf_frame, from_=90.000, to=99.999, increment=0.001, format="%.3f",
                                         textvariable=self.threshold_var, width=6, bg="#2a2a35", fg="#ffb300", border=0)
        self.threshold_spin.pack(side="left", padx=5)

        tk.Button(perf_frame, text="🪄 자동 최적화", command=self.apply_auto_config, bg="#3b3b4f", fg="#00f2ff",
                  font=("Malgun Gothic", 8, "bold"), relief="flat", padx=5).pack(side="right")

        self.guide_text_var = tk.StringVar()
        self.lbl_thread_guide = tk.Label(self.ctrl_panel, textvariable=self.guide_text_var, font=("Malgun Gothic", 8),
                                         bg="#1e1e2e", fg="#888", justify="left")
        self.lbl_thread_guide.pack(fill="x", anchor="w")
        self.update_thread_guide()

        # ==========================================
        # 🚀 구역 3: 핵심 아카이브 작업
        # ==========================================
        self.create_section_header(self.ctrl_panel, "🚀 아카이브 관리 (이미지 처리)")

        action_frame = tk.Frame(self.ctrl_panel, bg="#1e1e2e")
        action_frame.pack(fill="x")

        # 🌟 버튼 크기 비율 조정: 아티스트 스캔 추가 및 정지 버튼 축소
        self.btn_run = tk.Button(action_frame, text="▶ 새 분류", command=self.start_process, bg="#0984e3",
                                 fg="#ffffff", font=("Malgun Gothic", 10, "bold"), relief="flat", width=10)
        self.btn_run.pack(side="left", ipady=5, padx=(0, 5))

        self.btn_reorg = tk.Button(action_frame, text="🔄 재정렬", command=self.start_reorg, bg="#e17055",
                                   fg="#ffffff", font=("Malgun Gothic", 10, "bold"), relief="flat", width=10)
        self.btn_reorg.pack(side="left", ipady=5, padx=5)

        self.btn_scan_art = tk.Button(action_frame, text="🎨 아티스트 스캔", command=self.start_art_scan, bg="#f1c40f",
                                      fg="#000000", font=("Malgun Gothic", 10, "bold"), relief="flat", width=14)
        self.btn_scan_art.pack(side="left", ipady=5, padx=5)

        self.btn_stop = tk.Button(action_frame, text="⏹ 정지", command=self.stop_process, bg="#d63031", fg="#ffffff",
                                  font=("Malgun Gothic", 10, "bold"), relief="flat")
        self.btn_stop.pack(side="right", fill="x", expand=True, ipady=5, padx=(5, 0))

        self.lbl_progress = tk.Label(self.ctrl_panel, text="대기 중: 0 / 0", font=("Consolas", 10, "bold"), bg="#1e1e2e",
                                     fg="#00f2ff")
        self.lbl_progress.pack(pady=2)

        # ==========================================
        # 👑 구역 4: 브랜드 소속사 동기화
        # ==========================================
        self.create_section_header(self.ctrl_panel, "👑 브랜드 소속사 동기화")

        brand_frame = tk.Frame(self.ctrl_panel, bg="#1e1e2e")
        brand_frame.pack(fill="x")

        self.btn_sync = tk.Button(brand_frame, text="🌐 다수결 브랜드 분석 및 동기화 시작", command=self.start_brand_sync,
                                  bg="#6c5ce7", fg="#ffffff", font=("Malgun Gothic", 10, "bold"), relief="flat")
        self.btn_sync.pack(side="left", fill="x", expand=True, ipady=5, padx=(0, 5))

        self.btn_reset_brand = tk.Button(brand_frame, text="⚠️ 정보 초기화", command=self.reset_brand_data, bg="#4a1a1a",
                                         fg="#ff6b6b", font=("Malgun Gothic", 9, "bold"), relief="flat")
        self.btn_reset_brand.pack(side="right", ipady=5, padx=(5, 0))

        # ==========================================
        # 🌐 구역 5: 로컬 서버 및 갤러리
        # ==========================================
        self.create_section_header(self.ctrl_panel, "🌐 로컬 서버 및 갤러리")

        self.btn_server = tk.Button(self.ctrl_panel, text="🚀 로컬 웹 서버 켜기", command=self.toggle_server, bg="#00b894",
                                    fg="#ffffff", font=("Malgun Gothic", 12, "bold"), relief="flat")
        self.btn_server.pack(fill="x", ipady=6, pady=3)

        self.btn_open = tk.Button(self.ctrl_panel, text="🖼️ 갤러리 띄우기 (127.0.0.1:5000)", command=self.open_gallery,
                                  bg="#2d3436", fg="#00cec9", font=("Malgun Gothic", 10, "bold"), relief="flat",
                                  borderwidth=1)
        self.btn_open.pack(fill="x", ipady=5)


        # 로그창 세팅
        self.log_area = scrolledtext.ScrolledText(self.log_sidebar, bg="#050508", fg="#d1d1d1", font=("Consolas", 9),
                                                  border=0, padx=10, pady=10)
        self.log_area.pack(fill="both", expand=True)

    # ... (이하 로직들은 기존과 완전히 동일합니다) ...

    def reset_brand_data(self):
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
        if self.is_syncing: return
        self.is_syncing = True

        self.btn_sync.config(state="disabled", text="⏳ 브랜드 동기화 진행 중...", bg="#444")
        self.btn_reset_brand.config(state="disabled")
        self.btn_run.config(state="disabled")
        self.btn_reorg.config(state="disabled")

        self.log("🌐 브랜드 동기화 작업을 시작합니다...")

        if not self.log_visible:
            self.toggle_log()

        Thread(target=self._brand_sync_thread, daemon=True).start()

    def _brand_sync_thread(self):
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
            self.is_syncing = False
            self.root.after(0, self._finish_brand_sync_ui)

    def _finish_brand_sync_ui(self):
        self.btn_sync.config(state="normal", text="🌐 다수결 브랜드 분석 및 동기화 시작", bg="#6c5ce7")
        self.btn_reset_brand.config(state="normal")
        self.btn_run.config(state="normal")
        self.btn_reorg.config(state="normal")
        self.log("🏁 브랜드 동기화 완료.")
        if self.show_alert_var.get(): messagebox.showinfo("완료", "브랜드 동기화가 완료되었습니다.")

    def update_thread_guide(self):
        try:
            t = self.thread_count_var.get()
        except:
            t = 4

        if t <= 4:
            msg, color = "🟢 [안정 권장] VRAM 보호 및 온도 유지", "#2ecc71"
        elif t <= 15:
            msg, color = "🟡 [CPU/다중작업] RAM 중심 (GPU 모드 주의)", "#f1c40f"
        elif t <= 32:
            msg, color = "🚀 [일반 고속] SSD 대역폭 한계 활용", "#3498db"
        else:
            msg, color = "⚠️ [익스트림] 시스템 버벅임 주의", "#e74c3c"

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

        if use_ai:
            if vram_gb > 0:
                if vram_gb <= 4.5:
                    rec_threads = 1
                elif vram_gb <= 6.5:
                    rec_threads = 2
                elif vram_gb <= 8.5:
                    rec_threads = 4
                else:
                    rec_threads = 6
            else:
                rec_threads = max(1, cpu_cores // 2)
        else:
            rec_threads = min(32, cpu_cores * 2)

        self.thread_count_var.set(rec_threads)
        self.update_thread_guide()

    def _on_path_click(self, event):
        if self.path_var.get() == self.placeholder:
            self.path_var.set(self.full_path)
            self.path_entry.config(fg="#ffffff", bg="#3b3b4f")
        else:
            self.path_var.set(self.placeholder)
            self.path_entry.config(fg="#888", bg="#2a2a35")
            self.root.focus()

    def _on_path_blur(self, event):
        new_val = self.path_var.get().strip()
        if new_val and new_val != self.placeholder:
            self.full_path = new_val
            utils.save_config({"path": self.full_path})
        self.path_var.set(self.placeholder)
        self.path_entry.config(fg="#888", bg="#2a2a35")

    def log(self, msg):
        def _append():
            now = datetime.now().strftime("%H:%M:%S")
            self.log_area.insert(tk.END, f"[{now}] {msg}\n")
            self.log_area.see(tk.END)

        self.root.after(0, _append)

    def browse(self):
        p = filedialog.askdirectory(initialdir=self.full_path)
        if p:
            self.full_path = os.path.normpath(p)
            utils.save_config({"path": self.full_path})
            self.log(f"📁 대상 경로 설정됨: {self.full_path}")

    def stop_process(self):
        self.stop_requested = True
        self.btn_stop.config(state="disabled", text="🛑 정지 명령 접수됨!", bg="#ff8c00")
        self.log("🛑 정지 버튼이 클릭되었습니다. 현재 작업이 끝나는 대로 멈춥니다.")

    def update_progress(self, current, total):
        self.root.after(0, lambda: self.lbl_progress.config(
            text=f"진행 중: {current} / {total} ({(current / total) * 100:.1f}%)"))

    def reset_history(self):
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
        # 🌟 [수정] 스캔 시작 시 기존 데이터를 초기화할지 묻는 옵션 추가
        ans = messagebox.askyesnocancel("그림체 스캔",
                                        "아티스트 스캔을 진행합니다.\n\n새로운 '조합형 그림체' 기준을 적용하려면 기존 데이터를 초기화해야 합니다.\n\n[예] 기존 내역 초기화 후 전체 재스캔 (권장)\n[아니오] 멈춘 부분부터 이어서 스캔\n[취소] 돌아가기")
        if ans is None:
            return

        self.stop_requested = False
        self.clear_art_db = ans  # 🌟 초기화 여부 저장

        self.btn_scan_art.config(state="disabled", text="⏳ 스캔 중...", bg="#444", fg="#fff")
        self.btn_run.config(state="disabled")
        self.btn_reorg.config(state="disabled")
        self.btn_sync.config(state="disabled")
        self.btn_stop.config(state="normal", text="⏹ 정지", bg="#d63031")

        Thread(target=self._art_scan_thread, daemon=True).start()

    def _art_scan_thread(self):
        try:
            classified_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "TOTAL_CLASSIFIED")
            # 🌟 [수정] clear_db 파라미터 전달
            image_logic.scan_and_extract_artists(classified_dir, clear_db=self.clear_art_db, log_func=self.log,
                                                 stop_check=lambda: self.stop_requested)
        except Exception as e:
            self.log(f"❌ 오류: {e}")
        finally:
            self.root.after(0, lambda: self.btn_scan_art.config(state="normal", text="🎨 아티스트 스캔", bg="#f1c40f", fg="#000"))
            self.root.after(0, lambda: self.btn_run.config(state="normal"))
            self.root.after(0, lambda: self.btn_reorg.config(state="normal"))
            self.root.after(0, lambda: self.btn_sync.config(state="normal"))
            self.root.after(0, lambda: self.btn_stop.config(state="disabled", text="⏹ 정지"))

    def _read_thread_count_for_settings(self):
        try:
            value = int(self.thread_count_var.get())
        except Exception:
            value = 4
        return max(1, min(64, value))

    def _read_ai_threshold_percent_for_settings(self):
        try:
            value = float(self.threshold_var.get())
        except Exception:
            value = 99.980
        return max(0.0, min(100.0, value))

    def save_classify_settings(self, silent=False):
        try:
            settings = {
                "method": self.classify_method_var.get(),
                "show_alert": bool(self.show_alert_var.get()),
                "is_fast_mode": bool(self.is_fast_mode.get()),
                "use_ai": bool(self.use_ai_var.get()),
                "use_gpu": bool(self.use_gpu_var.get()),
                "skip_nsfw": bool(self.skip_nsfw_var.get()),
                "skip_char": bool(self.skip_char_var.get()),
                "thread_count": self._read_thread_count_for_settings(),
                "ai_threshold_percent": self._read_ai_threshold_percent_for_settings(),
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
        self,
        title,
        icon,
        target_title,
        target_value,
        method_title,
        method_value,
        method_desc,
        options,
        confirm_text,
        accent_color,
        warning_text=None,
    ):
        result = {"ok": False}

        dialog = tk.Toplevel(self.root)
        dialog.title(title)
        dialog.configure(bg="#151522")
        dialog.resizable(False, False)
        dialog.transient(self.root)
        dialog.grab_set()

        outer = tk.Frame(dialog, bg="#151522", padx=18, pady=16)
        outer.pack(fill="both", expand=True)

        header = tk.Frame(outer, bg="#151522")
        header.pack(fill="x", pady=(0, 12))

        tk.Label(
            header,
            text=f"{icon} {title}",
            bg="#151522",
            fg=accent_color,
            font=("Malgun Gothic", 16, "bold")
        ).pack(anchor="w")

        tk.Label(
            header,
            text="작업을 시작하기 전에 아래 설정을 확인해주세요.",
            bg="#151522",
            fg="#cfd3dc",
            font=("Malgun Gothic", 9)
        ).pack(anchor="w", pady=(4, 0))

        def add_card(parent, card_title, body_builder, border_color="#33334a"):
            card = tk.Frame(
                parent,
                bg="#202033",
                highlightthickness=1,
                highlightbackground=border_color,
                padx=12,
                pady=10
            )
            card.pack(fill="x", pady=(0, 10))

            tk.Label(
                card,
                text=card_title,
                bg="#202033",
                fg="#a29bfe",
                font=("Malgun Gothic", 10, "bold")
            ).pack(anchor="w", pady=(0, 6))

            body_builder(card)
            return card

        def build_target(card):
            tk.Label(
                card,
                text=target_value,
                bg="#202033",
                fg="#ffffff",
                font=("Malgun Gothic", 9),
                justify="left",
                wraplength=560
            ).pack(anchor="w")

        add_card(outer, target_title, build_target)

        def build_method(card):
            badge_bg = "#0f5132" if "복사" in method_value else "#6b4f00"
            badge_fg = "#39ff14" if "복사" in method_value else "#ffdd57"

            row = tk.Frame(card, bg="#202033")
            row.pack(fill="x")

            tk.Label(
                row,
                text=method_value,
                bg=badge_bg,
                fg=badge_fg,
                font=("Malgun Gothic", 10, "bold"),
                padx=10,
                pady=4
            ).pack(side="left")

            tk.Label(
                card,
                text=method_desc,
                bg="#202033",
                fg="#dfe6e9",
                font=("Malgun Gothic", 9),
                justify="left",
                wraplength=560
            ).pack(anchor="w", pady=(8, 0))

        add_card(outer, method_title, build_method, border_color=accent_color)

        def build_options(card):
            for item in options:
                label = item.get("label", "")
                value = item.get("value", "")
                state = item.get("state", None)

                row = tk.Frame(card, bg="#202033")
                row.pack(fill="x", pady=2)

                tk.Label(
                    row,
                    text=label,
                    bg="#202033",
                    fg="#dfe6e9",
                    font=("Malgun Gothic", 9)
                ).pack(side="left")

                if state is True:
                    badge_text = value or "ON"
                    badge_bg = "#0f5132"
                    badge_fg = "#39ff14"
                elif state is False:
                    badge_text = value or "OFF"
                    badge_bg = "#30303a"
                    badge_fg = "#8d94a3"
                else:
                    badge_text = str(value)
                    badge_bg = "#16324a"
                    badge_fg = "#74b9ff"

                tk.Label(
                    row,
                    text=badge_text,
                    bg=badge_bg,
                    fg=badge_fg,
                    font=("Malgun Gothic", 8, "bold"),
                    padx=8,
                    pady=2
                ).pack(side="right")

        add_card(outer, "실행 옵션", build_options)

        if warning_text:
            warning = tk.Frame(
                outer,
                bg="#332a12",
                highlightthickness=1,
                highlightbackground="#ffb300",
                padx=12,
                pady=8
            )
            warning.pack(fill="x", pady=(0, 12))

            tk.Label(
                warning,
                text=warning_text,
                bg="#332a12",
                fg="#ffdd57",
                font=("Malgun Gothic", 9, "bold"),
                justify="left",
                wraplength=560
            ).pack(anchor="w")

        button_row = tk.Frame(outer, bg="#151522")
        button_row.pack(fill="x", pady=(4, 0))

        def on_cancel():
            result["ok"] = False
            dialog.destroy()

        def on_ok():
            result["ok"] = True
            dialog.destroy()

        tk.Button(
            button_row,
            text="취소",
            command=on_cancel,
            bg="#2d3436",
            fg="#dfe6e9",
            font=("Malgun Gothic", 10, "bold"),
            relief="flat",
            width=14,
            pady=6
        ).pack(side="right", padx=(8, 0))

        tk.Button(
            button_row,
            text=confirm_text,
            command=on_ok,
            bg=accent_color,
            fg="#ffffff",
            font=("Malgun Gothic", 10, "bold"),
            relief="flat",
            width=16,
            pady=6
        ).pack(side="right")

        dialog.protocol("WM_DELETE_WINDOW", on_cancel)
        dialog.bind("<Escape>", lambda event: on_cancel())
        dialog.bind("<Return>", lambda event: on_ok())

        dialog.update_idletasks()

        try:
            parent_x = self.root.winfo_rootx()
            parent_y = self.root.winfo_rooty()
            parent_w = self.root.winfo_width()
            parent_h = self.root.winfo_height()
            dialog_w = dialog.winfo_width()
            dialog_h = dialog.winfo_height()

            x = parent_x + max(0, (parent_w - dialog_w) // 2)
            y = parent_y + max(0, (parent_h - dialog_h) // 2)
            dialog.geometry(f"+{x}+{y}")
        except Exception:
            pass

        dialog.focus_force()
        dialog.wait_window()

        return result["ok"]

    def show_reorg_target_dialog(self):
        result = {"choice": None}

        dialog = tk.Toplevel(self.root)
        dialog.title("재정렬 대상 선택")
        dialog.configure(bg="#151522")
        dialog.resizable(False, False)
        dialog.transient(self.root)
        dialog.grab_set()

        outer = tk.Frame(dialog, bg="#151522", padx=18, pady=16)
        outer.pack(fill="both", expand=True)

        tk.Label(
            outer,
            text="🔄 재정렬 대상 선택",
            bg="#151522",
            fg="#e17055",
            font=("Malgun Gothic", 16, "bold")
        ).pack(anchor="w")

        tk.Label(
            outer,
            text="재정렬할 범위를 선택해주세요.",
            bg="#151522",
            fg="#cfd3dc",
            font=("Malgun Gothic", 9)
        ).pack(anchor="w", pady=(4, 14))

        def choose(value):
            result["choice"] = value
            dialog.destroy()

        full_card = tk.Frame(
            outer,
            bg="#202033",
            highlightthickness=1,
            highlightbackground="#6c5ce7",
            padx=12,
            pady=10
        )
        full_card.pack(fill="x", pady=(0, 10))

        tk.Label(
            full_card,
            text="🌐 전체 재정렬",
            bg="#202033",
            fg="#a29bfe",
            font=("Malgun Gothic", 11, "bold")
        ).pack(anchor="w")

        tk.Label(
            full_card,
            text="TOTAL_CLASSIFIED 전체를 다시 검사하고 정리합니다.",
            bg="#202033",
            fg="#dfe6e9",
            font=("Malgun Gothic", 9),
            justify="left",
            wraplength=560
        ).pack(anchor="w", pady=(4, 8))

        tk.Button(
            full_card,
            text="전체 재정렬 선택",
            command=lambda: choose("all"),
            bg="#6c5ce7",
            fg="#ffffff",
            font=("Malgun Gothic", 10, "bold"),
            relief="flat",
            pady=6
        ).pack(fill="x")

        partial_card = tk.Frame(
            outer,
            bg="#202033",
            highlightthickness=1,
            highlightbackground="#00b894",
            padx=12,
            pady=10
        )
        partial_card.pack(fill="x", pady=(0, 12))

        tk.Label(
            partial_card,
            text="📁 부분 재정렬",
            bg="#202033",
            fg="#55efc4",
            font=("Malgun Gothic", 11, "bold")
        ).pack(anchor="w")

        tk.Label(
            partial_card,
            text="특정 폴더만 선택해서 그 안의 이미지만 다시 정리합니다.",
            bg="#202033",
            fg="#dfe6e9",
            font=("Malgun Gothic", 9),
            justify="left",
            wraplength=560
        ).pack(anchor="w", pady=(4, 8))

        tk.Button(
            partial_card,
            text="부분 재정렬 선택",
            command=lambda: choose("partial"),
            bg="#00b894",
            fg="#ffffff",
            font=("Malgun Gothic", 10, "bold"),
            relief="flat",
            pady=6
        ).pack(fill="x")

        button_row = tk.Frame(outer, bg="#151522")
        button_row.pack(fill="x")

        tk.Button(
            button_row,
            text="취소",
            command=lambda: choose(None),
            bg="#2d3436",
            fg="#dfe6e9",
            font=("Malgun Gothic", 10, "bold"),
            relief="flat",
            width=14,
            pady=6
        ).pack(side="right")

        dialog.protocol("WM_DELETE_WINDOW", lambda: choose(None))
        dialog.bind("<Escape>", lambda event: choose(None))

        dialog.update_idletasks()

        try:
            parent_x = self.root.winfo_rootx()
            parent_y = self.root.winfo_rooty()
            parent_w = self.root.winfo_width()
            parent_h = self.root.winfo_height()
            dialog_w = dialog.winfo_width()
            dialog_h = dialog.winfo_height()

            x = parent_x + max(0, (parent_w - dialog_w) // 2)
            y = parent_y + max(0, (parent_h - dialog_h) // 2)
            dialog.geometry(f"+{x}+{y}")
        except Exception:
            pass

        dialog.focus_force()
        dialog.wait_window()

        return result["choice"]

    def start_process(self):
        if self.full_path == self.placeholder or not os.path.exists(self.full_path):
            messagebox.showwarning("경고", "올바른 대상 폴더 경로를 선택해주세요.")
            return

        method = self.classify_method_var.get()
        is_fast = self.is_fast_mode.get()
        use_ai = self.use_ai_var.get()
        skip_nsfw = self.skip_nsfw_var.get()
        skip_char = self.skip_char_var.get()  # 🌟

        m_txt = "복사" if method == "copy" else "이동"
        f_txt = "켜짐" if is_fast else "꺼짐"
        a_txt = "켜짐" if use_ai else "꺼짐"
        g_txt = "켜짐" if self.use_gpu_var.get() else "꺼짐"
        s_txt = "무시 (전부 일반짤 처리)" if skip_nsfw else "판독 진행"
        c_txt = "무시 (하위 폴더 미생성)" if skip_char else "판별 진행"  # 🌟
        t_txt = str(self.thread_count_var.get())

        method_desc = (
            "원본 이미지는 그대로 두고, 분류 결과 폴더에 복사합니다."
            if method == "copy"
            else "원본 이미지를 분류 결과 폴더로 이동합니다. 원래 위치에서는 사라질 수 있습니다."
        )

        method_value = "복사: 원본 유지" if method == "copy" else "이동: 원본 이동"

        if not self.show_action_confirm_dialog(
            title="새 이미지 분류 실행 확인",
            icon="▶",
            target_title="대상 폴더",
            target_value=self.full_path,
            method_title="파일 처리 방식",
            method_value=method_value,
            method_desc=method_desc,
            options=[
                {"label": "분류 이력 활용", "value": f_txt, "state": is_fast},
                {"label": "AI 야짤 정밀 판독", "value": a_txt, "state": use_ai},
                {"label": "GPU 가속", "value": g_txt, "state": self.use_gpu_var.get()},
                {"label": "수위 감지", "value": s_txt, "state": not skip_nsfw},
                {"label": "캐릭터 판별", "value": c_txt, "state": not skip_char},
                {"label": "스레드 수", "value": f"{t_txt}개", "state": None},
            ],
            confirm_text="분류 시작",
            accent_color="#0984e3",
        ):
            return

        self.save_classify_settings(silent=True)

        self.stop_requested = False
        self.btn_run.config(state="disabled", text="⏳ 분류 작업 중...", bg="#444")
        self.btn_reorg.config(state="disabled")
        self.btn_sync.config(state="disabled")
        self.btn_stop.config(state="normal", text="⏹ 정지", bg="#d63031")
        Thread(target=self._logic_thread, args=(self.full_path, method, is_fast, use_ai, skip_nsfw, skip_char),
               daemon=True).start()

    def _logic_thread(self, source, method, is_fast, use_ai, skip_nsfw, skip_char):
        use_gpu = self.use_gpu_var.get()
        threshold_val = self.threshold_var.get() / 100.0
        try:
            image_logic.process(source, method=method, is_fast=is_fast, use_ai=use_ai, use_gpu=use_gpu,
                                max_workers=self.thread_count_var.get(), ai_threshold=threshold_val,
                                log_func=self.log, stop_check=lambda: self.stop_requested,
                                progress_update=self.update_progress, skip_nsfw=skip_nsfw, skip_char_id=skip_char)
            self.log("✅ [작업 완료] 새 이미지 처리가 끝났습니다.")
        except Exception as e:
            self.log(f"❌ 오류: {e}")
        finally:
            self.root.after(0, lambda: self.btn_run.config(state="normal", text="▶ 새 분류", bg="#0984e3"))
            self.root.after(0, lambda: self.btn_reorg.config(state="normal", text="🔄 재정렬", bg="#e17055"))
            self.root.after(0, lambda: self.btn_sync.config(state="normal"))
            self.root.after(0, lambda: self.btn_stop.config(state="disabled", text="⏹ 정지"))

    def start_reorg(self):
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
        skip_nsfw = self.skip_nsfw_var.get()
        skip_char = self.skip_char_var.get()  # 🌟

        a_txt = "켜짐" if use_ai else "꺼짐"
        g_txt = "켜짐" if self.use_gpu_var.get() else "꺼짐"
        s_txt = "무시 (모두 기존 폴더/일반짤 처리)" if skip_nsfw else "판독 진행"
        c_txt = "무시 (하위 폴더 미생성)" if skip_char else "판별 진행"  # 🌟
        t_txt = str(self.thread_count_var.get())

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
                {"label": "GPU 가속", "value": g_txt, "state": self.use_gpu_var.get()},
                {"label": "수위 감지", "value": s_txt, "state": not skip_nsfw},
                {"label": "캐릭터 판별", "value": c_txt, "state": not skip_char},
                {"label": "스레드 수", "value": f"{t_txt}개", "state": None},
            ],
            confirm_text="재정렬 시작",
            accent_color="#e17055",
            warning_text="상단의 복사/이동 선택은 새 분류에만 적용됩니다. 재정렬은 항상 이동 방식입니다.",
        ):
            return

        self.save_classify_settings(silent=True)

        self.stop_requested = False
        self.btn_reorg.config(state="disabled", text="⏳ 재정렬 중...", bg="#444")
        self.btn_run.config(state="disabled")
        self.btn_sync.config(state="disabled")
        self.btn_stop.config(state="normal", text="⏹ 정지", bg="#d63031")
        Thread(target=self._reorg_thread, args=(use_ai, skip_nsfw, skip_char, reorg_target), daemon=True).start()

    def _reorg_thread(self, use_ai, skip_nsfw, skip_char, reorg_target):
        use_gpu = self.use_gpu_var.get()
        threshold_val = self.threshold_var.get() / 100.0
        try:
            image_logic.process(self.full_path, method="move", is_fast=False, reorg_mode=True, use_ai=use_ai,
                                use_gpu=use_gpu, max_workers=self.thread_count_var.get(), ai_threshold=threshold_val,
                                log_func=self.log, stop_check=lambda: self.stop_requested,
                                progress_update=self.update_progress, skip_nsfw=skip_nsfw, skip_char_id=skip_char,
                                reorg_target=reorg_target)
            self.log("✅ [재정렬 완료] 폴더가 완벽히 재배치되었습니다.")
        except Exception as e:
            self.log(f"❌ 오류: {e}")
        finally:
            self.root.after(0, lambda: self.btn_reorg.config(state="normal", text="🔄 전면/부분 재정렬", bg="#e17055"))
            self.root.after(0, lambda: self.btn_run.config(state="normal", text="▶ 새 이미지 분류", bg="#0984e3"))
            self.root.after(0, lambda: self.btn_sync.config(state="normal"))
            self.root.after(0, lambda: self.btn_stop.config(state="disabled", text="⏹ 정지"))

    def start_server(self):
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
        base_dir = os.path.dirname(os.path.abspath(__file__))
        app_script = os.path.join(base_dir, "app.py")

        try:
            creation_flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
            env = os.environ.copy()
            env["PYTHONIOENCODING"] = "utf-8"

            self.server_process = subprocess.Popen([sys.executable, "-u", app_script], stdout=subprocess.PIPE,
                                                   stderr=subprocess.STDOUT,
                                                   encoding='utf-8', errors='replace', bufsize=1, cwd=base_dir, env=env,
                                                   creationflags=creation_flags)

            self._set_server_transition_ui("🟡 서버 기동 중...", "#ffc107", "⏳ 연결 중...")

            Thread(target=self.monitor_server, args=(self.server_process, monitor_token), daemon=True).start()
        except Exception as e:
            self.server_transitioning = False
            self.server_process = None
            self.log(f"❌ 서버 시작 실패: {e}")
            if utils.is_port_active(5000):
                self._set_external_server_ui()
            else:
                self._set_server_offline_ui()

    def _set_server_online_ui(self):
        # 🌟 현재 실행 중인 서버의 PID를 UI에 함께 표시합니다.
        pid = self.server_process.pid if self.server_process else "알 수 없음"
        self.server_status_var.set(f"🟢 서버 작동 중 (PID: {pid})")
        self.lbl_status.config(fg="#00b894")
        self.btn_server.config(text="🛑 로컬 웹 서버 끄기", state="normal", bg="#d63031", fg="#ffffff")

    def _mark_server_ready(self, process, monitor_token):
        if monitor_token != self.server_monitor_token or self.server_process is not process:
            return
        self.is_opened = True
        self.server_ready = True
        self.server_transitioning = False
        self._set_server_online_ui()
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
                    self.root.after(0, lambda l=clean_line: self.log(f"[서버] {l}"))
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
        self.server_status_var.set("🔴 서버 중지됨")
        self.lbl_status.config(fg="#ff4d4d")
        self.btn_server.config(text="🚀 로컬 웹 서버 켜기", state="normal", bg="#00b894", fg="#ffffff")

    def toggle_log(self):
        if self.log_visible:
            self.log_sidebar.pack_forget()
            # 🌟 로그창 닫았을 때 세로 길이도 줄인 사이즈(780)로 맞춰줍니다.
            self.root.geometry("800x780")
            self.log_visible = False
        else:
            self.root.geometry("1150x780")
            self.log_sidebar.pack(side="right", fill="y", padx=(10, 30), pady=40)
            self.log_visible = True

    def open_gallery(self):
        if not utils.is_port_active(5000):
            if self.show_alert_var.get(): messagebox.showwarning("경고", "서버가 켜져 있지 않습니다.")
            return
        webbrowser.open("http://127.0.0.1:5000")
        self.log("🌐 갤러리를 열었습니다.")


if __name__ == "__main__":
    # 🌟 3. 메인 로직 구동 (위의 검사를 모두 무사히 통과했을 때만 실행됨)
    root = tk.Tk()
    app = NaiaHyperExecutor(root)
    root.protocol("WM_DELETE_WINDOW", app.on_closing)
    root.mainloop()
