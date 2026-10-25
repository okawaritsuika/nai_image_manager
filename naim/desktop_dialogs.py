"""Small themed dialogs shared by the desktop controller and its helpers."""

import tkinter as tk

from naim import desktop_theme as theme


def _body(window):
    frame = tk.Frame(window, bg=theme.BG, padx=14, pady=12)
    frame.pack(fill="both", expand=True)
    return frame


def _card(parent, title=None):
    frame = tk.Frame(parent, bg=theme.PANEL, padx=10, pady=8,
                     highlightbackground=theme.BORDER, highlightthickness=1)
    frame.pack(fill="x", pady=(0, 8))
    if title:
        theme.label(frame, title, fg=theme.ACCENT, font=(*theme.FONT, "bold")).pack(anchor="w", pady=(0, 5))
    return frame


def _text(parent, text, **options):
    return theme.label(parent, str(text), justify="left", wraplength=500, **options)


def _wait_modal(window, parent, default_button, cancel):
    """Restore a parent dialog's grab and focus after nested prompts close."""
    previous_grab = parent.grab_current()
    previous_grab_status = previous_grab.grab_status() if previous_grab else None
    previous_focus = parent.focus_get()
    window.protocol("WM_DELETE_WINDOW", cancel)
    window.bind("<Escape>", lambda event: cancel())

    def activate(event):
        focused = window.focus_get()
        if isinstance(focused, tk.Button) and focused.winfo_toplevel() == window:
            focused.invoke()
        else:
            default_button.invoke()
        return "break"

    window.bind("<Return>", activate)
    window.update_idletasks()
    width, height = window.winfo_reqwidth(), window.winfo_reqheight()
    x = parent.winfo_rootx() + max(0, (parent.winfo_width() - width) // 2)
    y = parent.winfo_rooty() + max(0, (parent.winfo_height() - height) // 2)
    x = max(0, min(x, window.winfo_screenwidth() - width))
    y = max(0, min(y, window.winfo_screenheight() - height))
    window.geometry(f"+{x}+{y}")
    try:
        window.grab_set()
        default_button.focus_set()
        window.wait_window()
    finally:
        try:
            if previous_grab is not None and previous_grab.winfo_exists():
                if previous_grab_status == "global":
                    previous_grab.grab_set_global()
                else:
                    previous_grab.grab_set()
            if previous_focus is not None and previous_focus.winfo_exists():
                previous_focus.focus_set()
        except tk.TclError:
            pass  # Closing the parent also destroys its modal children.


def _window(parent, title):
    window = tk.Toplevel(parent)
    theme.configure_window(window, title)
    window.resizable(False, False)
    if parent.winfo_viewable():
        window.transient(parent)
    return window


def _message(title, message, *, kind, choices, cancel_value, **options):
    parent = options.get("parent") or tk._default_root
    owned_root = parent is None
    if owned_root:
        parent = tk.Tk()
        parent.withdraw()
    window = _window(parent, title or "알림")
    body = _body(window)
    color = {"error": theme.ERROR, "warning": theme.WARNING}.get(kind, theme.ACCENT)
    _text(body, title or "알림", fg=color, font=(*theme.FONT, "bold")).pack(anchor="w", pady=(0, 8))
    card = _card(body)
    _text(card, message or "").pack(anchor="w")
    if options.get("detail"):
        _text(card, options["detail"], fg=theme.MUTED).pack(anchor="w", pady=(6, 0))
    row = tk.Frame(body, bg=theme.BG)
    row.pack(fill="x")
    result = {"value": cancel_value}

    def choose(value):
        result["value"] = value
        window.destroy()

    buttons = {}
    for key, label, value in reversed(choices):
        button = theme.button(row, label, lambda value=value: choose(value),
                              primary=key == choices[0][0], width=9)
        button.pack(side="right", padx=(6, 0))
        buttons[key] = button
    default = buttons.get(str(options.get("default", choices[0][0])), buttons[choices[0][0]])
    try:
        _wait_modal(window, parent, default, lambda: choose(cancel_value))
        return result["value"]
    finally:
        if owned_root:
            parent.destroy()


def showinfo(title=None, message=None, **options):
    return _message(title, message, kind="info", choices=(("ok", "확인", "ok"),), cancel_value="ok", **options)


def showwarning(title=None, message=None, **options):
    return _message(title, message, kind="warning", choices=(("ok", "확인", "ok"),), cancel_value="ok", **options)


def showerror(title=None, message=None, **options):
    return _message(title, message, kind="error", choices=(("ok", "확인", "ok"),), cancel_value="ok", **options)


def askyesno(title=None, message=None, **options):
    return _message(title, message, kind="question", choices=(("yes", "예", True), ("no", "아니요", False)),
                    cancel_value=False, **options)


def askyesnocancel(title=None, message=None, **options):
    return _message(title, message, kind="question",
                    choices=(("yes", "예", True), ("no", "아니요", False), ("cancel", "취소", None)),
                    cancel_value=None, **options)


def action_confirm(controller, title, icon, target_title, target_value, method_title,
                   method_value, method_desc, options, confirm_text, accent_color,
                   warning_text=None):
    # Retain the controller's call contract; all actions now use the shared teal.
    window = _window(controller.root, title)
    body = _body(window)
    _text(body, f"{icon} {title}", fg=theme.ACCENT, font=(*theme.FONT, "bold")).pack(anchor="w")
    _text(body, "작업을 시작하기 전에 아래 설정을 확인해주세요.", fg=theme.MUTED).pack(anchor="w", pady=(3, 8))
    target = _card(body, target_title)
    _text(target, target_value).pack(anchor="w")
    method = _card(body, method_title)
    _text(method, method_value, fg=theme.ACCENT, font=(*theme.FONT, "bold")).pack(anchor="w")
    _text(method, method_desc, fg=theme.MUTED).pack(anchor="w", pady=(3, 0))
    option_card = _card(body, "실행 옵션")
    for item in options:
        row = tk.Frame(option_card, bg=theme.PANEL)
        row.pack(fill="x", pady=2)
        theme.label(row, item.get("label", "")).pack(side="left", padx=(0, 18))
        state, value = item.get("state"), item.get("value", "")
        value = (value or "ON") if state is True else (value or "OFF") if state is False else str(value)
        color = theme.ACCENT if state is True else theme.MUTED if state is False else theme.INFO
        theme.label(row, value, fg=color, wraplength=330, justify="right").pack(side="right")
    if warning_text:
        warning = _card(body)
        _text(warning, warning_text, fg=theme.WARNING).pack(anchor="w")
    row = tk.Frame(body, bg=theme.BG)
    row.pack(fill="x")
    result = {"ok": False}

    def choose(value):
        result["ok"] = value
        window.destroy()

    theme.button(row, "취소", lambda: choose(False), width=10).pack(side="right", padx=(6, 0))
    confirm = theme.button(row, confirm_text, lambda: choose(True), primary=True, width=14)
    confirm.pack(side="right")
    _wait_modal(window, controller.root, confirm, lambda: choose(False))
    return result["ok"]


def choose_reorg_target(controller):
    window = _window(controller.root, "재정렬 대상 선택")
    body = _body(window)
    _text(body, "재정렬 대상 선택", fg=theme.ACCENT, font=(*theme.FONT, "bold")).pack(anchor="w")
    _text(body, "재정렬할 범위를 선택해주세요.", fg=theme.MUTED).pack(anchor="w", pady=(3, 8))
    result = {"choice": None}

    def choose(value):
        result["choice"] = value
        window.destroy()

    for value, title, description, label in (
        ("all", "전체 재정렬", "TOTAL_CLASSIFIED 전체를 다시 검사하고 정리합니다.", "전체 재정렬 선택"),
        ("partial", "부분 재정렬", "특정 폴더만 선택해서 그 안의 이미지만 다시 정리합니다.", "부분 재정렬 선택"),
    ):
        card = _card(body, title)
        _text(card, description).pack(anchor="w", pady=(0, 6))
        theme.button(card, label, lambda value=value: choose(value), primary=True).pack(fill="x")
    cancel = theme.button(body, "취소", lambda: choose(None), width=10)
    cancel.pack(anchor="e")
    _wait_modal(window, controller.root, cancel, lambda: choose(None))
    return result["choice"]
