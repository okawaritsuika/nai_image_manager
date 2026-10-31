"""Compact desktop controller widgets; jobs and settings remain in the controller."""

import tkinter as tk
from tkinter import scrolledtext, ttk

from .desktop_theme import (
    BG, PANEL, INK, MUTED, BORDER, ACCENT, SOFT, ERROR, WARNING, INFO,
    FONT, SMALL_FONT, label as _label, button as _button, check as _check,
    radio as _radio, spin as _spin, style_progress,
)


def _row(parent, pady=0):
    row = tk.Frame(parent, bg=parent.cget("bg"))
    row.pack(fill="x", pady=pady)
    return row


def _block(parent, title=None):
    block = tk.Frame(parent, bg=PANEL, padx=10, pady=7,
                     highlightbackground=BORDER, highlightthickness=1)
    block.pack(fill="x", pady=(0, 6))
    heading = None
    if title:
        heading = _row(block, pady=(0, 5))
        _label(heading, title, fg=ACCENT, font=(*FONT, "bold")).pack(side="left")
    return block, heading


def _build_header(controller):
    header = tk.Frame(controller.root, bg=PANEL, padx=10, pady=7,
                      highlightbackground=BORDER, highlightthickness=1)
    header.pack(fill="x")
    title_row = _row(header, pady=(0, 6))
    _label(title_row, "NAI Image Manager", font=(*FONT, "bold")).pack(side="left")
    controller.btn_log_toggle = _button(title_row, "로그", controller.toggle_log)
    controller.btn_log_toggle.pack(side="right")
    if controller.frozen_app:
        controller.btn_update = _button(
            title_row, f"업데이트 (v{controller.app_version})", controller.check_for_exe_update,
        )
        controller.btn_update.pack(side="right", padx=(0, 6))
    if controller.admin_mode:
        _label(title_row, "관리자 모드", fg=ACCENT, font=SMALL_FONT).pack(side="right", padx=8)
    else:
        _button(title_row, "관리자 실행", controller.run_as_admin).pack(side="right", padx=(0, 6))

    server_row = _row(header)
    controller.lbl_status = _label(
        server_row, textvariable=controller.server_status_var, fg=MUTED, font=SMALL_FONT,
    )
    controller.lbl_status.pack(side="left", padx=(0, 10))
    controller.btn_server = _button(server_row, "서버 시작", controller.toggle_server)
    controller.btn_server.pack(side="left", padx=(0, 6))
    controller.btn_open = _button(server_row, "갤러리 열기", controller.open_gallery, primary=True)
    controller.btn_open.pack(side="left", padx=(0, 8))
    controller.auto_open_gallery_checkbox = _check(
        server_row, "서버 시작 시 웹페이지 열기", controller.auto_open_gallery_var,
        command=controller.save_desktop_settings,
    )
    controller.auto_open_gallery_checkbox.pack(side="left")
    style_progress(controller.root)
    loading_track = tk.Frame(header, bg=PANEL, height=4)
    loading_track.pack(fill="x", pady=(5, 0))
    loading_track.pack_propagate(False)
    controller.server_loading_bar = ttk.Progressbar(
        loading_track, style="Remote.Horizontal.TProgressbar", mode="indeterminate", maximum=100,
    )
    controller._server_loading_active = False
    controller._server_loading_after = None
    controller.server_loading_bar.bind(
        "<Destroy>", lambda event: set_server_loading(controller, False), add="+",
    )


def _build_path(controller):
    block, _ = _block(controller.ctrl_panel)
    _label(block, "작업 폴더", fg=MUTED, font=SMALL_FONT).pack(side="left", padx=(0, 8))
    controller.placeholder = "클릭하여 대상 폴더 경로 표시"
    controller.path_var = tk.StringVar(master=controller.root, value=controller.placeholder)
    controller.path_entry = tk.Entry(
        block, textvariable=controller.path_var, width=12, font=FONT,
        bg=BG, fg=MUTED, insertbackground=INK, relief="flat", bd=0,
        highlightbackground=BORDER, highlightcolor=ACCENT, highlightthickness=1,
    )
    controller.path_entry.pack(side="left", fill="x", expand=True, ipady=4)
    controller.path_entry.bind("<Button-1>", controller._on_path_click)
    controller.path_entry.bind("<FocusOut>", controller._on_path_blur)
    _button(block, "폴더 선택", controller.browse).pack(side="left", padx=6)
    controller.btn_import = _button(block, "기존 자료 가져오기", controller.open_legacy_import)
    controller.btn_import.pack(side="left")


def _build_style_connection(controller):
    block, _ = _block(controller.ctrl_panel)
    controller.btn_style_connection = _button(
        block, "그림체 프로그램 연결", controller.open_style_connection,
    )
    controller.btn_style_connection.pack(side="left", padx=(0, 10))
    _label(block, "기존 그림체 폴더의 데이터·설정 연결", fg=MUTED,
           font=SMALL_FONT, wraplength=370, justify="left").pack(side="left", fill="x", expand=True)


def _build_classification(controller):
    block, heading = _block(controller.ctrl_panel, "분류 설정")
    controller.btn_reset_history = _button(heading, "이력 초기화", controller.reset_history, danger=True)
    controller.btn_reset_history.pack(side="right")
    _button(heading, "설정 저장", controller.save_classify_settings).pack(side="right", padx=(0, 6))

    method = _row(block)
    _radio(method, "복사 · 원본 유지", controller.classify_method_var, "copy").pack(side="left", padx=(0, 15))
    _radio(method, "이동", controller.classify_method_var, "move").pack(side="left", padx=(0, 15))
    _label(method, "재정렬은 항상 이동", fg=MUTED, font=SMALL_FONT).pack(side="left")
    tk.Frame(block, bg=BORDER, height=1).pack(fill="x", pady=5)

    options = _row(block)
    _check(options, "분류 이력 활용", controller.is_fast_mode).pack(side="left", padx=(0, 20))
    _check(options, "알림창 끄기", controller.show_alert_var, onvalue=False, offvalue=True).pack(side="left")
    _check(block, "코믹 가져오기 후 바깥 중복 원본 삭제", controller.delete_comic_duplicates_var).pack(anchor="w", pady=3)

    webp = _row(block, pady=(2, 0))
    controller.auto_webp_checkbox = _check(
        webp, "분류 후 WebP", controller.auto_webp_var, command=controller._update_auto_webp_controls,
    )
    controller.auto_webp_checkbox.pack(side="left", padx=(0, 12))
    controller.auto_webp_mode_buttons = []
    for value, label in ((True, "무손실"), (False, "손실")):
        button = _radio(webp, label, controller.webp_lossless_var, value,
                        command=controller._update_auto_webp_controls)
        button.pack(side="left", padx=(0, 10))
        controller.auto_webp_mode_buttons.append(button)
    _label(webp, "화질", font=SMALL_FONT).pack(side="left", padx=(4, 6))
    controller.auto_webp_quality_input = _spin(webp, controller.webp_quality_var, 1, 100)
    controller.auto_webp_quality_input.pack(side="left", ipady=3)
    _label(block, "메타데이터 검증 후 분류된 PNG 삭제 · 복사 모드 입력 원본 유지",
           fg=MUTED, font=SMALL_FONT).pack(fill="x", pady=(3, 0))
    controller._update_auto_webp_controls()


def _build_ai(controller):
    block, heading = _block(controller.ctrl_panel, "AI 및 성능")
    _button(heading, "자동 최적화", controller.apply_auto_config).pack(side="right")
    options = _row(block)
    state = "disabled" if controller.lite_ai_disabled else "normal"
    ai_text = "AI 자동 분류 제외됨" if controller.lite_ai_disabled else "AI 자동 분류"
    _check(options, ai_text, controller.use_ai_var, state=state,
           command=controller.update_thread_guide).pack(side="left", padx=(0, 14))
    _check(options, "GPU 가속", controller.use_gpu_var, state=state).pack(side="left", padx=(0, 14))
    _check(options, "수위 무시", controller.skip_nsfw_var).pack(side="left", padx=(0, 14))
    _check(options, "캐릭터 판별 무시", controller.skip_char_var).pack(side="left")

    performance = _row(block, pady=(6, 2))
    _label(performance, "일반 스레드").pack(side="left", padx=(0, 6))
    controller.normal_thread_spin = _spin(
        performance, controller.normal_thread_count_var, 1, 64, command=controller.update_thread_guide,
    )
    controller.normal_thread_spin.pack(side="left", ipady=3, padx=(0, 16))
    controller.normal_thread_spin.bind("<KeyRelease>", lambda event: controller.update_thread_guide())
    _label(performance, "AI 스레드").pack(side="left", padx=(0, 6))
    controller.ai_thread_spin = _spin(
        performance, controller.ai_thread_count_var, 1, 16, command=controller.update_thread_guide,
    )
    controller.ai_thread_spin.pack(side="left", ipady=3, padx=(0, 16))
    controller.ai_thread_spin.bind("<KeyRelease>", lambda event: controller.update_thread_guide())
    _label(performance, "AI 감도 (%)").pack(side="left", padx=(0, 6))
    controller.threshold_spin = _spin(
        performance, controller.threshold_var, 90.000, 99.999, width=7,
        increment=0.001, format="%.3f",
    )
    controller.threshold_spin.pack(side="left", ipady=3)
    controller.guide_text_var = tk.StringVar(master=controller.root)
    controller.lbl_thread_guide = _label(block, textvariable=controller.guide_text_var,
                                        fg=MUTED, font=SMALL_FONT)
    controller.lbl_thread_guide.pack(fill="x", pady=(3, 0))
    controller.update_thread_guide()


def _build_actions(controller):
    block, _ = _block(controller.ctrl_panel, "이미지 작업")
    actions = _row(block)
    controls = (
        ("btn_run", "새 분류", controller.start_process, True, False, 13),
        ("btn_reorg", "재정렬", controller.start_reorg, False, False, 10),
        ("btn_scan_art", "아티스트 스캔", controller.start_art_scan, False, False, 12),
        ("btn_webp", "WebP 압축", controller.open_webp_compression, False, False, 10),
        ("btn_stop", "정지", controller.stop_process, False, True, 7),
    )
    for column, (name, text, callback, primary, danger, weight) in enumerate(controls):
        button = _button(actions, text, callback, primary=primary, danger=danger)
        button.grid(row=0, column=column, sticky="ew", padx=(0 if column == 0 else 6, 0))
        actions.columnconfigure(column, weight=weight)
        setattr(controller, name, button)
    controller.btn_stop.config(state="disabled")
    progress = _row(block, pady=(7, 0))
    controller.lbl_progress = _label(progress, "대기 중: 0 / 0", fg=MUTED, font=SMALL_FONT)
    controller.lbl_progress.pack(side="left", padx=(0, 12))
    style_progress(controller.root)
    controller.progress_bar = ttk.Progressbar(
        progress, style="Remote.Horizontal.TProgressbar", maximum=100,
        mode="determinate", value=0,
    )
    controller.progress_bar.pack(side="left", fill="x", expand=True)

    brand, _ = _block(controller.ctrl_panel)
    _label(brand, "브랜드 소속사", fg=MUTED, font=SMALL_FONT).pack(side="left", padx=(0, 10))
    controller.btn_sync = _button(brand, "브랜드 분석 및 동기화", controller.start_brand_sync)
    controller.btn_sync.pack(side="left", fill="x", expand=True, padx=(0, 6))
    controller.btn_reset_brand = _button(brand, "정보 초기화", controller.reset_brand_data, danger=True)
    controller.btn_reset_brand.pack(side="right")


def _build_log(controller):
    controller.log_sidebar = tk.Frame(controller.main_container, bg=PANEL, width=320,
                                      highlightbackground=BORDER, highlightthickness=1)
    controller.log_sidebar.pack_propagate(False)
    _label(controller.log_sidebar, f"최근 {controller.LOG_MAX_LINES:,}줄 표시",
           fg=MUTED, font=SMALL_FONT).pack(fill="x", padx=10, pady=(8, 4))
    controller.log_area = scrolledtext.ScrolledText(
        controller.log_sidebar, bg=PANEL, fg=INK, font=("Consolas", 9),
        border=0, padx=10, pady=8, state="disabled", wrap="word",
    )
    controller.log_area.pack(fill="both", expand=True)


def _advance_server_loading(controller):
    controller._server_loading_after = None
    if not controller._server_loading_active:
        return
    controller.server_loading_bar.step(3)
    controller._server_loading_after = controller.root.after(35, lambda: _advance_server_loading(controller))


def set_server_loading(controller, active):
    """Animate only during a server transition and release its Tk timer on exit."""
    bar = controller.server_loading_bar
    if not active:
        controller._server_loading_active = False
        if controller._server_loading_after is not None:
            controller.root.after_cancel(controller._server_loading_after)
            controller._server_loading_after = None
    try:
        if active:
            if not controller._server_loading_active:
                bar.pack(fill="x")
                controller._server_loading_active = True
                _advance_server_loading(controller)
        else:
            bar.configure(value=0)
            bar.pack_forget()
    except tk.TclError:
        # A child Destroy binding can run after Tcl removed the widget command.
        controller._server_loading_active = False


def fit_controller_window(controller, show_log=None):
    """Fit initial content; log toggling retains the user's content width/height."""
    root = controller.root
    root.update_idletasks()
    width, height = 750, 650
    if show_log is not None:
        width, height = root.winfo_width(), root.winfo_height()
        if show_log != controller.log_visible:
            sidebar_width = controller.log_sidebar.winfo_reqwidth() + 8
            width += sidebar_width if show_log else -sidebar_width
            if show_log:
                controller.log_sidebar.pack(side="right", fill="both", padx=(0, 8), pady=8)
            else:
                controller.log_sidebar.pack_forget()
            controller.log_visible = show_log
        root.update_idletasks()
    minimum_width = max(750, root.winfo_reqwidth())
    minimum_height = max(650, root.winfo_reqheight())
    width, height = max(width, minimum_width), max(height, minimum_height)
    root.minsize(minimum_width, minimum_height)
    root.geometry(f"{width}x{height}")


def build_controller_ui(controller):
    """Build widgets against the existing controller variables and callbacks."""
    controller.root.configure(bg=BG)
    _build_header(controller)
    controller.main_container = tk.Frame(controller.root, bg=BG)
    controller.main_container.pack(fill="both", expand=True)
    controller.ctrl_panel = tk.Frame(controller.main_container, bg=BG, padx=8, pady=8)
    controller.ctrl_panel.pack(side="left", fill="both", expand=True)
    _build_path(controller)
    _build_style_connection(controller)
    _build_classification(controller)
    _build_ai(controller)
    _build_actions(controller)
    _build_log(controller)
