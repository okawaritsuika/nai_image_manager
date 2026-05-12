# -*- coding: utf-8 -*-
import os
import sys
import subprocess
import threading
import tkinter as tk
from tkinter import scrolledtext, messagebox, ttk
import webbrowser
import shutil
import urllib.request
import urllib.error
import zipfile


REALCUGAN_VERSION = "20220728"
REALCUGAN_ZIP_NAME = f"realcugan-ncnn-vulkan-{REALCUGAN_VERSION}-windows.zip"
REALCUGAN_DOWNLOAD_URL = (
    f"https://github.com/nihui/realcugan-ncnn-vulkan/releases/download/"
    f"{REALCUGAN_VERSION}/{REALCUGAN_ZIP_NAME}"
)
GIT_DOWNLOAD_URL = "https://git-scm.com/download/win"


class NaiaSetupManager:
    def __init__(self, root):
        self.root = root
        self.root.title("NAI Image Manager SETUP MANAGER")
        self.root.geometry("850x930")

        self.bg_color = "#121218"
        self.card_color = "#1c1c27"
        self.header_color = "#000000"

        self.btn_red = "#ff6b6b"
        self.btn_purple = "#a29bfe"
        self.btn_blue = "#74b9ff"
        self.btn_teal = "#55efc4"
        self.accent_color = "#ff007c"
        self.success_color = "#39ff14"
        self.warning_color = "#f1c40f"

        self.root.configure(bg=self.bg_color)

        if getattr(sys, "frozen", False):
            self.cwd = os.path.dirname(sys.executable)
        else:
            self.cwd = os.path.dirname(os.path.abspath(__file__))

        self.venv_dir = os.path.join(self.cwd, ".venv")
        self.venv_python = self.get_venv_python_path()
        self.sys_python = self.get_system_python()

        self.active_python = None
        self.active_python_label = "미준비"

        self.tools_dir = os.path.join(self.cwd, "tools")
        self.realcugan_dir = os.path.join(self.tools_dir, "realcugan-ncnn-vulkan")
        self.realcugan_exe = os.path.join(self.realcugan_dir, "realcugan-ncnn-vulkan.exe")

        self.is_working = False

        self.setup_ui()
        self.check_environment()

    # ==========================================================
    # 경로 / Python 환경 판정
    # ==========================================================
    def get_venv_python_path(self):
        if os.name == "nt":
            return os.path.join(self.venv_dir, "Scripts", "python.exe")
        return os.path.join(self.venv_dir, "bin", "python")

    def get_system_python(self):
        if not getattr(sys, "frozen", False):
            if sys.executable and os.path.exists(sys.executable):
                return sys.executable

        return shutil.which("python") or shutil.which("python3")

    def check_imports(self, python_exe, import_code):
        if not python_exe or not os.path.exists(python_exe):
            return False

        try:
            subprocess.check_call(
                [python_exe, "-c", import_code],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                cwd=self.cwd
            )
            return True
        except Exception:
            return False

    def check_core_installed_for(self, python_exe):
        return self.check_imports(
            python_exe,
            "import flask, requests; from PIL import Image"
        )

    def check_ai_installed_for(self, python_exe):
        return self.check_imports(
            python_exe,
            "import torch, torchvision, transformers"
        )

    def check_core_installed(self):
        return self.check_core_installed_for(self.active_python)

    def check_ai_installed(self):
        return self.check_ai_installed_for(self.active_python)

    def check_upscale_installed(self):
        return os.path.exists(self.realcugan_exe)

    def check_git_installed(self):
        return shutil.which("git") is not None

    def get_active_python(self):
        """
        실제 서버 실행 규칙에 맞춰 사용할 Python을 고른다.

        1. .venv가 있으면 .venv Python 사용
        2. .venv가 없고 시스템 Python에 필수 패키지가 있으면 시스템 Python 사용
        3. 둘 다 준비 안 되어 있으면 None
        """
        self.venv_python = self.get_venv_python_path()

        if os.path.exists(self.venv_python):
            return self.venv_python

        if self.sys_python and self.check_core_installed_for(self.sys_python):
            return self.sys_python

        return None

    def get_active_python_label(self):
        if self.active_python and os.path.exists(self.venv_python) and self.active_python == self.venv_python:
            return ".venv"

        if self.active_python and self.sys_python and self.active_python == self.sys_python:
            return "시스템 Python"

        return "미준비"

    def get_pip_python(self):
        """
        선택 기능 설치 대상 Python.

        - .venv가 있으면 .venv
        - .venv가 없고 시스템 Python이 준비되어 있으면 시스템 Python
        - 준비된 환경이 없으면 None
        """
        return self.get_active_python()

    # ==========================================================
    # UI
    # ==========================================================
    def setup_ui(self):
        header = tk.Frame(self.root, bg=self.header_color, pady=15)
        header.pack(fill="x")

        tk.Label(
            header,
            text="👑 NAI Image Manager 환경 구축 매니저",
            font=("Malgun Gothic", 22, "bold"),
            bg=self.header_color,
            fg=self.accent_color
        ).pack()

        self.status_card = tk.Frame(
            self.root,
            bg=self.card_color,
            padx=20,
            pady=15,
            highlightthickness=1,
            highlightbackground="#333"
        )
        self.status_card.pack(fill="x", padx=20, pady=15)

        self.py_icon = tk.Label(
            self.status_card,
            text="❓",
            font=("Malgun Gothic", 24),
            bg=self.card_color
        )
        self.py_icon.pack(side="left", padx=(0, 15))

        self.py_status_msg = tk.Label(
            self.status_card,
            text="Python 상태 확인 중...",
            font=("Malgun Gothic", 14, "bold"),
            bg=self.card_color,
            fg="#fff"
        )
        self.py_status_msg.pack(side="left")

        tk.Button(
            self.status_card,
            text="🔄 다시 확인",
            command=self.check_environment,
            bg="#333",
            fg="#fff",
            font=("Malgun Gothic", 9),
            relief="flat",
            padx=10
        ).pack(side="right")

        guide_frame = tk.Frame(self.root, bg=self.card_color, padx=20, pady=15)
        guide_frame.pack(fill="x", padx=20, pady=5)

        guide_text = (
            "📌 [환경 구축 순서]\n"
            "1. Python 확인 : 시스템 Python에 필수 패키지가 이미 있으면 그대로 사용합니다.\n"
            "2. 시스템 Python에 필수 패키지가 없으면 [1단계]가 프로젝트 전용 .venv를 자동 생성합니다.\n"
            "3. AI 자동분류가 필요하면 [2단계]를 실행합니다. (선택)\n"
            "4. 갤러리 업스케일이 필요하면 [3단계]를 실행합니다. (선택)\n\n"
            "※ 서버 실행 기준:\n"
            "   .venv가 있으면 .venv Python 사용 / .venv가 없으면 시스템 Python 사용\n"
            "※ 따라서 시스템 Python에 이미 flask, requests, pillow가 있으면 .venv를 만들 필요가 없습니다."
        )

        tk.Label(
            guide_frame,
            text=guide_text,
            font=("Malgun Gothic", 10),
            bg=self.card_color,
            fg="#ccc",
            justify="left"
        ).pack(anchor="w")

        btn_frame = tk.Frame(self.root, bg=self.bg_color)
        btn_frame.pack(fill="x", padx=20, pady=10)

        self.btn_install_py = tk.Button(
            btn_frame,
            text="📥 Python 공식 다운로드 페이지 열기",
            command=self.open_python_site,
            bg=self.btn_red,
            fg="#000",
            font=("Malgun Gothic", 12, "bold"),
            pady=12,
            cursor="hand2",
            relief="raised"
        )
        self.btn_install_py.pack(fill="x", pady=5)

        self.btn_install_git = tk.Button(
            btn_frame,
            text="Git 공식 다운로드 페이지 열기",
            command=self.open_git_site,
            bg="#f39c12",
            fg="#000",
            font=("Malgun Gothic", 12, "bold"),
            pady=12,
            cursor="hand2",
            relief="raised"
        )
        self.btn_install_git.pack(fill="x", pady=5)

        self.btn_venv = tk.Button(
            btn_frame,
            text="▶ 1단계: 실행 환경 필수 패키지 확인/설치",
            command=self.create_venv_and_install_basic,
            bg=self.btn_purple,
            fg="#000",
            font=("Malgun Gothic", 11, "bold"),
            pady=10
        )
        self.btn_venv.pack(fill="x", pady=5)

        self.btn_ai = tk.Button(
            btn_frame,
            text="▶ 2단계: AI 자동분류 라이브러리 추가 설치 (선택사항)",
            command=self.install_ai,
            bg=self.btn_blue,
            fg="#000",
            font=("Malgun Gothic", 11, "bold"),
            pady=10
        )
        self.btn_ai.pack(fill="x", pady=5)

        self.btn_upscale = tk.Button(
            btn_frame,
            text="▶ 3단계: 업스케일 엔진 설치 (Real-CUGAN / 선택사항)",
            command=self.install_upscale_engine,
            bg=self.btn_teal,
            fg="#000",
            font=("Malgun Gothic", 11, "bold"),
            pady=10
        )
        self.btn_upscale.pack(fill="x", pady=5)

        self.work_info_frame = tk.Frame(self.root, bg=self.bg_color, padx=20)
        self.work_info_frame.pack(fill="x", pady=(10, 0))

        self.work_label = tk.Label(
            self.work_info_frame,
            text="대기 중...",
            font=("Malgun Gothic", 10, "bold"),
            bg=self.bg_color,
            fg="#888"
        )
        self.work_label.pack(side="left")

        self.pkg_label = tk.Label(
            self.work_info_frame,
            text="",
            font=("Consolas", 10, "bold"),
            bg=self.bg_color,
            fg=self.success_color
        )
        self.pkg_label.pack(side="right")

        self.progress = ttk.Progressbar(
            self.root,
            orient="horizontal",
            mode="indeterminate"
        )
        self.progress.pack(fill="x", padx=20, pady=(5, 15))

        tk.Label(
            self.root,
            text="실시간 작업 로그",
            font=("Malgun Gothic", 9, "bold"),
            bg=self.bg_color,
            fg="#666"
        ).pack(anchor="w", padx=20)

        self.log_area = scrolledtext.ScrolledText(
            self.root,
            bg="#050508",
            fg="#eee",
            font=("Consolas", 10),
            height=12
        )
        self.log_area.pack(fill="both", expand=True, padx=20, pady=(0, 20))

    # ==========================================================
    # 로그 / 작업 공통 처리
    # ==========================================================
    def log(self, msg):
        self.log_area.insert(tk.END, f"{msg}\n")
        self.log_area.see(tk.END)

        if "Collecting" in msg:
            try:
                pkg = msg.split("Collecting")[-1].split()[0]
                self.pkg_label.config(text=f"📦 INSTALLING: {pkg}")
            except Exception:
                pass
        elif "Downloading" in msg:
            self.pkg_label.config(text="📥 DOWNLOADING...")
        elif "Installing collected packages" in msg:
            self.pkg_label.config(text="⚙️ FINALIZING...")

        self.root.update()

    def set_buttons_working_state(self, working):
        state = "disabled" if working else "normal"

        if hasattr(self, "btn_venv"):
            self.btn_venv.config(state=state)
        if hasattr(self, "btn_ai"):
            self.btn_ai.config(state=state)
        if hasattr(self, "btn_upscale"):
            self.btn_upscale.config(state=state)
        if hasattr(self, "btn_install_git"):
            self.btn_install_git.config(state=state)

    def run_cmd_thread(self, cmd_list, success_msg, work_text, on_complete=None):
        if self.is_working:
            return

        self.is_working = True
        self.set_buttons_working_state(True)
        self.work_label.config(text=f"⏳ {work_text}", fg=self.accent_color)
        self.progress.start(10)

        def task():
            should_finish = True

            try:
                env = os.environ.copy()
                env["PYTHONUNBUFFERED"] = "1"
                env["PYTHONIOENCODING"] = "utf-8"

                process = subprocess.Popen(
                    cmd_list,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    cwd=self.cwd,
                    env=env
                )

                for line in process.stdout:
                    self.log(line.strip())

                process.wait()

                if process.returncode == 0:
                    self.log(f"\n🎉 {success_msg}")

                    if on_complete:
                        should_finish = False
                        self.is_working = False
                        self.root.after(0, on_complete)
                else:
                    self.log("\n❌ 작업 중 오류가 발생했습니다.")

            except Exception as e:
                self.log(f"\n🚨 시스템 에러: {e}")

            finally:
                if should_finish:
                    self.is_working = False
                    self.root.after(0, self.finish_work)

        threading.Thread(target=task, daemon=True).start()

    def finish_work(self):
        self.progress.stop()
        self.work_label.config(text="✅ 작업 완료", fg=self.success_color)
        self.pkg_label.config(text="")
        self.check_environment()

    # ==========================================================
    # 환경 상태 확인
    # ==========================================================
    def check_environment(self):
        self.sys_python = self.get_system_python()
        self.venv_python = self.get_venv_python_path()

        if not self.sys_python:
            self.active_python = None
            self.active_python_label = "미준비"

            self.status_card.config(highlightbackground="#ff4d4d")
            self.py_icon.config(text="❌", fg="#ff4d4d")
            self.py_status_msg.config(
                text="Python이 설치되어 있지 않습니다!",
                fg="#ff4d4d"
            )

            self.btn_install_py.pack(fill="x", pady=5)
            self.btn_venv.config(state="disabled", bg="#444", fg="#888")
            self.btn_ai.config(state="disabled", bg="#444", fg="#888")
            self.btn_upscale.config(state="disabled", bg="#444", fg="#888")
            return

        has_venv = os.path.exists(self.venv_python)
        system_core_ready = self.check_core_installed_for(self.sys_python)
        venv_core_ready = self.check_core_installed_for(self.venv_python) if has_venv else False

        if has_venv:
            self.active_python = self.venv_python
        elif system_core_ready:
            self.active_python = self.sys_python
        else:
            self.active_python = None

        self.active_python_label = self.get_active_python_label()

        has_core = venv_core_ready if has_venv else system_core_ready
        has_ai = self.check_ai_installed_for(self.active_python) if self.active_python else False
        has_upscale = self.check_upscale_installed()
        has_git = self.check_git_installed()

        self.btn_install_py.pack_forget()

        if has_git:
            self.btn_install_git.config(
                bg="#2ecc71",
                text="Git 설치 확인됨 - update.bat으로 업데이트 가능",
                fg="#000"
            )
        else:
            self.btn_install_git.config(
                bg="#f39c12",
                text="Git 공식 다운로드 페이지 열기",
                fg="#000"
            )

        if has_core:
            self.status_card.config(highlightbackground=self.success_color)
            self.py_icon.config(text="✅", fg=self.success_color)
            self.py_status_msg.config(
                text=f"실행 환경 준비됨: {self.active_python_label} / {os.path.basename(self.active_python)}",
                fg=self.success_color
            )
        else:
            self.status_card.config(highlightbackground=self.warning_color)
            self.py_icon.config(text="⚠️", fg=self.warning_color)
            self.py_status_msg.config(
                text="시스템 Python에 필수 패키지가 없습니다. 1단계를 누르면 .venv를 자동 생성합니다.",
                fg=self.warning_color
            )

        if has_core:
            if has_venv:
                self.btn_venv.config(
                    state="normal",
                    bg="#2ecc71",
                    text="✓ 1단계: .venv 실행 환경 준비됨",
                    fg="#000"
                )
            else:
                self.btn_venv.config(
                    state="normal",
                    bg="#2ecc71",
                    text="✓ 1단계: 시스템 Python 실행 환경 준비됨",
                    fg="#000"
                )
        else:
            if has_venv:
                self.btn_venv.config(
                    state="normal",
                    bg=self.btn_purple,
                    text="↻ 1단계: .venv 필수 패키지 설치/복구",
                    fg="#000"
                )
            else:
                self.btn_venv.config(
                    state="normal",
                    bg=self.btn_purple,
                    text="▶ 1단계: .venv 자동 생성 및 필수 패키지 설치",
                    fg="#000"
                )

        if has_core:
            ai_text = (
                "✓ 2단계: AI 라이브러리 사용 가능"
                if has_ai
                else f"▶ 2단계: AI 자동분류 라이브러리 설치 ({self.active_python_label})"
            )
            ai_bg = "#2ecc71" if has_ai else self.btn_blue

            self.btn_ai.config(
                state="normal",
                bg=ai_bg,
                text=ai_text,
                fg="#000"
            )

            upscale_text = (
                "✓ 3단계: 업스케일 엔진 설치 완료"
                if has_upscale
                else "▶ 3단계: 업스케일 엔진 설치 (Real-CUGAN)"
            )
            upscale_bg = "#2ecc71" if has_upscale else self.btn_teal

            self.btn_upscale.config(
                state="normal",
                bg=upscale_bg,
                text=upscale_text,
                fg="#000"
            )
        else:
            self.btn_ai.config(state="disabled", bg="#444", fg="#888")
            self.btn_upscale.config(state="disabled", bg="#444", fg="#888")

    # ==========================================================
    # 외부 링크
    # ==========================================================
    def open_python_site(self):
        webbrowser.open("https://www.python.org/downloads/")

    def open_git_site(self):
        webbrowser.open(GIT_DOWNLOAD_URL)

    # ==========================================================
    # 1단계: 필수 패키지 / .venv 자동 생성
    # ==========================================================
    def create_venv_and_install_basic(self):
        if not self.sys_python:
            messagebox.showerror("오류", "먼저 파이썬을 설치해 주세요.")
            return

        has_venv = os.path.exists(self.venv_python)
        system_core_ready = self.check_core_installed_for(self.sys_python)

        if has_venv:
            self.active_python = self.venv_python
            self.active_python_label = ".venv"

            if self.check_core_installed_for(self.venv_python):
                messagebox.showinfo(
                    "필수 패키지 확인",
                    ".venv에 이미 필수 패키지가 설치되어 있습니다."
                )
                self.check_environment()
                return

            self.install_core_packages()
            return

        if system_core_ready:
            self.active_python = self.sys_python
            self.active_python_label = "시스템 Python"

            messagebox.showinfo(
                "필수 패키지 확인",
                "시스템 Python에 이미 필수 패키지가 설치되어 있습니다.\n"
                ".venv를 새로 만들 필요가 없습니다."
            )
            self.check_environment()
            return

        ok = messagebox.askyesno(
            ".venv 자동 생성",
            "현재 .venv가 없고, 시스템 Python에도 필수 패키지가 없습니다.\n\n"
            "프로젝트 전용 .venv를 자동 생성하고 필수 패키지를 설치합니다.\n\n"
            "설치할 패키지:\n"
            "- flask\n"
            "- requests\n"
            "- pillow\n\n"
            "계속할까요?"
        )

        if not ok:
            return

        self.log("\n🚀 시스템 Python에 필수 패키지가 없어서 .venv를 자동 생성합니다...")
        cmd_venv = [self.sys_python, "-m", "venv", ".venv"]

        self.run_cmd_thread(
            cmd_venv,
            "가상환경 폴더 생성 완료.",
            "가상환경 구축 중...",
            self.install_core_packages
        )

    def install_core_packages(self):
        if os.path.exists(self.venv_python):
            target_python = self.venv_python
            target_label = ".venv"
        else:
            target_python = self.sys_python
            target_label = "시스템 Python"

        if not target_python:
            messagebox.showerror("오류", "설치 대상 Python을 찾을 수 없습니다.")
            return

        self.log(f"\n📦 필수 라이브러리 설치/복구 중... 대상: {target_label}")
        self.log("   - flask")
        self.log("   - requests")
        self.log("   - pillow")

        cmd_pip = [
            target_python,
            "-m",
            "pip",
            "install",
            "--upgrade",
            "pip",
            "setuptools",
            "wheel",
            "flask",
            "requests",
            "pillow"
        ]

        self.run_cmd_thread(
            cmd_pip,
            f"필수 패키지 설치가 완료되었습니다. 사용 환경: {target_label}",
            "필수 패키지 설치 중..."
        )

    # ==========================================================
    # 2단계: AI 자동분류 라이브러리
    # ==========================================================
    def install_ai(self):
        target_python = self.get_pip_python()
        target_label = self.get_active_python_label()

        if not target_python:
            messagebox.showerror(
                "오류",
                "사용 가능한 Python 실행 환경이 없습니다.\n"
                "먼저 1단계를 실행해 주세요."
            )
            return

        if not self.check_core_installed_for(target_python):
            messagebox.showerror(
                "오류",
                "먼저 1단계를 실행해서 필수 패키지를 설치해 주세요."
            )
            return

        if self.check_ai_installed_for(target_python):
            messagebox.showinfo(
                "AI 설치 확인",
                f"{target_label}에 이미 AI 라이브러리가 설치되어 있습니다."
            )
            self.check_environment()
            return

        if not messagebox.askyesno(
            "AI 설치",
            f"AI 라이브러리(PyTorch 등 약 2GB)를 설치하시겠습니까?\n\n"
            f"설치 대상: {target_label}\n\n"
            "사양과 네트워크 상태에 따라 10분 이상 소요될 수 있습니다."
        ):
            return

        self.log(f"\n🚀 AI 라이브러리 설치를 시작합니다. 대상: {target_label}")

        cmd = [
            target_python,
            "-m",
            "pip",
            "install",
            "--upgrade",
            "torch",
            "torchvision",
            "transformers"
        ]

        self.run_cmd_thread(
            cmd,
            f"AI 모델 라이브러리 설치가 완료되었습니다. 사용 환경: {target_label}",
            "AI 라이브러리 설치 중..."
        )

    # ==========================================================
    # 3단계: 업스케일 엔진 설치
    # ==========================================================
    def install_upscale_engine(self):
        target_python = self.get_pip_python()

        if not target_python:
            messagebox.showerror(
                "오류",
                "사용 가능한 Python 실행 환경이 없습니다.\n"
                "먼저 1단계를 실행해 주세요."
            )
            return

        if not self.check_core_installed_for(target_python):
            messagebox.showerror(
                "오류",
                "먼저 1단계를 실행해서 필수 패키지를 설치해 주세요."
            )
            return

        if self.check_upscale_installed():
            messagebox.showinfo(
                "업스케일 엔진",
                "업스케일 엔진이 이미 설치되어 있습니다."
            )
            self.check_environment()
            return

        if os.name != "nt":
            messagebox.showerror(
                "지원 확인 필요",
                "현재 자동 다운로드는 Windows용 Real-CUGAN 패키지를 대상으로 합니다.\n"
                "Windows가 아닌 환경에서는 tools 폴더에 엔진을 직접 설치해 주세요."
            )
            return

        if not messagebox.askyesno(
            "업스케일 엔진 설치",
            "Real-CUGAN 업스케일 엔진을 다운로드해 설치하시겠습니까?\n\n"
            "설치 위치:\n"
            "tools/realcugan-ncnn-vulkan/\n\n"
            "이 엔진은 PyTorch/CUDA 설치가 아니라 portable 실행파일 방식입니다."
        ):
            return

        self.run_upscale_install_thread()

    def run_upscale_install_thread(self):
        if self.is_working:
            return

        self.is_working = True
        self.set_buttons_working_state(True)
        self.work_label.config(text="⏳ 업스케일 엔진 설치 중...", fg=self.accent_color)
        self.pkg_label.config(text="📥 REAL-CUGAN")
        self.progress.start(10)

        def task():
            try:
                target_python = self.get_pip_python()
                target_label = self.get_active_python_label()

                if not target_python:
                    raise RuntimeError("사용 가능한 Python 실행 환경이 없습니다.")

                os.makedirs(self.tools_dir, exist_ok=True)

                self.log(f"\n📦 업스케일 처리용 Pillow 설치/업데이트 확인 중... 대상: {target_label}")

                pip_cmd = [
                    target_python,
                    "-m",
                    "pip",
                    "install",
                    "--upgrade",
                    "pillow"
                ]

                pip_process = subprocess.Popen(
                    pip_cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    cwd=self.cwd
                )

                for line in pip_process.stdout:
                    self.log(line.strip())

                pip_process.wait()

                if pip_process.returncode != 0:
                    raise RuntimeError("Pillow 설치/업데이트에 실패했습니다.")

                zip_path = os.path.join(self.tools_dir, REALCUGAN_ZIP_NAME)
                extract_tmp = os.path.join(self.tools_dir, "_realcugan_extract_tmp")

                self.log("\n🚀 Real-CUGAN ncnn-vulkan 다운로드를 시작합니다.")
                self.log(f"   저장 위치: {zip_path}")

                last_percent = {"value": -1}

                def reporthook(block_count, block_size, total_size):
                    if total_size <= 0:
                        return

                    percent = int(min(100, block_count * block_size * 100 / total_size))

                    if percent >= last_percent["value"] + 5:
                        last_percent["value"] = percent
                        self.pkg_label.config(text=f"📥 {percent}%")
                        self.log(f"   다운로드 진행률: {percent}%")

                urllib.request.urlretrieve(
                    REALCUGAN_DOWNLOAD_URL,
                    zip_path,
                    reporthook=reporthook
                )

                self.log("\n📦 압축 해제 중...")

                if os.path.exists(extract_tmp):
                    shutil.rmtree(extract_tmp, ignore_errors=True)

                os.makedirs(extract_tmp, exist_ok=True)

                with zipfile.ZipFile(zip_path, "r") as zf:
                    zf.extractall(extract_tmp)

                found_exe = None

                for root_dir, _, files in os.walk(extract_tmp):
                    for file_name in files:
                        if file_name.lower() == "realcugan-ncnn-vulkan.exe":
                            found_exe = os.path.join(root_dir, file_name)
                            break

                    if found_exe:
                        break

                if not found_exe:
                    raise FileNotFoundError(
                        "압축 파일 안에서 realcugan-ncnn-vulkan.exe를 찾지 못했습니다."
                    )

                engine_root = os.path.dirname(found_exe)

                if os.path.exists(self.realcugan_dir):
                    shutil.rmtree(self.realcugan_dir, ignore_errors=True)

                shutil.copytree(engine_root, self.realcugan_dir)

                shutil.rmtree(extract_tmp, ignore_errors=True)

                try:
                    os.remove(zip_path)
                except OSError:
                    pass

                if not os.path.exists(self.realcugan_exe):
                    raise FileNotFoundError(
                        "설치 후 realcugan-ncnn-vulkan.exe를 찾지 못했습니다."
                    )

                self.log("\n✅ 업스케일 엔진 설치 완료")
                self.log(f"   실행 파일: {self.realcugan_exe}")
                self.log("   이후 업스케일 기능은 이 실행파일을 subprocess로 호출하면 됩니다.")

            except urllib.error.URLError as e:
                self.log(f"\n❌ 다운로드 실패: {e}")
                self.log("   인터넷 연결 또는 GitHub 접속 상태를 확인해 주세요.")

            except Exception as e:
                self.log(f"\n🚨 업스케일 엔진 설치 실패: {e}")

            finally:
                self.is_working = False
                self.root.after(0, self.finish_work)

        threading.Thread(target=task, daemon=True).start()


if __name__ == "__main__":
    root = tk.Tk()
    app = NaiaSetupManager(root)
    root.mainloop()
