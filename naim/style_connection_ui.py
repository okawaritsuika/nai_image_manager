"""Tk dialog for connecting the controller to an existing style workspace."""

from pathlib import Path
import tkinter as tk
from tkinter import filedialog, ttk

from naim import desktop_dialogs as messagebox
from naim import desktop_theme as theme
from naim import style_connection


def open_style_connection(parent, app_dir, *, can_save=None, on_saved=None):
    """Open the folder-link dialog and return its Toplevel without blocking."""
    window = tk.Toplevel(parent)
    theme.configure_window(window, "그림체 프로그램 연결")
    window.resizable(True, True)

    screen_width = parent.winfo_screenwidth()
    screen_height = parent.winfo_screenheight()
    width = min(680, max(360, screen_width - 32))
    height = min(480, max(300, screen_height - 64))
    window.geometry(f"{width}x{height}")
    window.minsize(min(560, width), min(420, height))
    if parent.winfo_viewable():
        window.transient(parent)

    previous_focus = parent.focus_get()
    state = {"preview": None, "current": None, "reveal_after_id": None}
    status_var = tk.StringVar(value="연결할 그림체 프로그램 폴더를 선택해 주세요.")
    key_choice_var = tk.StringVar(value="")
    wrap_labels = []

    def path_field(parent_widget, title, row):
        field = tk.Frame(parent_widget, bg=theme.PANEL)
        field.grid(row=row, column=0, sticky="ew", pady=(2, 5))
        field.grid_columnconfigure(0, weight=1)
        theme.label(field, title, bg=theme.PANEL, fg=theme.MUTED,
                    font=theme.SMALL_FONT).grid(row=0, column=0, sticky="w", pady=(0, 2))
        value = tk.StringVar()
        entry = tk.Entry(
            field, textvariable=value, state="readonly", font=theme.FONT,
            readonlybackground=theme.PANEL, fg=theme.INK, relief="flat",
            highlightbackground=theme.BORDER, highlightcolor=theme.ACCENT,
            highlightthickness=1, takefocus=True,
        )
        scrollbar = ttk.Scrollbar(field, orient="horizontal", command=entry.xview)
        entry.configure(xscrollcommand=scrollbar.set)
        entry.grid(row=1, column=0, sticky="ew", ipady=3)
        scrollbar.grid(row=2, column=0, sticky="ew", pady=(1, 0))
        return value

    def card(parent_widget, title, row):
        frame = tk.Frame(parent_widget, bg=theme.PANEL, padx=10, pady=7,
                         highlightbackground=theme.BORDER, highlightthickness=1)
        frame.grid(row=row, column=0, sticky="ew", padx=2, pady=(0, 8))
        frame.grid_columnconfigure(0, weight=1)
        heading = theme.label(frame, title, bg=theme.PANEL, fg=theme.ACCENT,
                              font=(*theme.FONT, "bold"))
        heading.grid(row=0, column=0, sticky="w", pady=(0, 3))
        return frame

    header = tk.Frame(window, bg=theme.BG, padx=14, pady=10)
    header.grid(row=0, column=0, sticky="ew")
    header.grid_columnconfigure(0, weight=1)
    title = theme.label(header, "그림체 프로그램 연결", fg=theme.ACCENT,
                        font=(*theme.FONT, "bold"))
    title.grid(row=0, column=0, sticky="w")
    intro = theme.label(
        header,
        "기존 그림체 프로그램 폴더를 연결합니다. 연결 후 그림체 데이터와 이미지는 선택한 폴더에서 그대로 사용하며, 처음 연결할 때 복사하거나 삭제하지 않습니다.",
        fg=theme.MUTED, justify="left", wraplength=620,
    )
    intro.grid(row=1, column=0, sticky="ew", pady=(3, 0))
    wrap_labels.append(intro)

    body = tk.Frame(window, bg=theme.BG, padx=10)
    body.grid(row=1, column=0, sticky="nsew")
    body.grid_rowconfigure(0, weight=1)
    body.grid_columnconfigure(0, weight=1)
    canvas = tk.Canvas(body, bg=theme.BG, bd=0, highlightthickness=0)
    scrollbar = ttk.Scrollbar(body, orient="vertical", command=canvas.yview)
    canvas.configure(yscrollcommand=scrollbar.set)
    canvas.grid(row=0, column=0, sticky="nsew")
    scrollbar.grid(row=0, column=1, sticky="ns")
    content = tk.Frame(canvas, bg=theme.BG)
    content.grid_columnconfigure(0, weight=1)
    content_id = canvas.create_window((0, 0), window=content, anchor="nw")

    def update_scroll_region(_event=None):
        canvas.configure(scrollregion=canvas.bbox("all"))

    def fit_content(event):
        canvas.itemconfigure(content_id, width=event.width)
        for label_widget in wrap_labels:
            label_widget.configure(wraplength=max(220, event.width - 32))

    content.bind("<Configure>", update_scroll_region)
    canvas.bind("<Configure>", fit_content)

    def scroll_body(event):
        if getattr(event, "num", None) == 4:
            canvas.yview_scroll(-1, "units")
        elif getattr(event, "num", None) == 5:
            canvas.yview_scroll(1, "units")
        elif event.delta:
            units = max(1, abs(event.delta) // 120)
            canvas.yview_scroll(-units if event.delta > 0 else units, "units")
        return "break"

    window.bind("<MouseWheel>", scroll_body, add="+")
    window.bind("<Button-4>", scroll_body, add="+")
    window.bind("<Button-5>", scroll_body, add="+")

    select_card = card(content, "연결할 그림체 프로그램", 0)
    selected_value = path_field(select_card, "선택한 폴더", 1)
    selected_row = tk.Frame(select_card, bg=theme.PANEL)
    selected_row.grid(row=2, column=0, sticky="ew", pady=(3, 0))
    selected_row.grid_columnconfigure(0, weight=1)
    choose_button = theme.button(selected_row, "프로그램 폴더 선택", lambda: None)
    choose_button.grid(row=0, column=0, sticky="w")

    current_card = card(content, "현재 연결", 1)
    current_source_value = path_field(current_card, "연결된 그림체 프로그램 폴더", 1)
    current_data_value = path_field(current_card, "현재 사용하는 데이터 폴더", 2)
    current_status = theme.label(current_card, "연결된 그림체 프로그램이 없습니다.",
                                 bg=theme.PANEL, fg=theme.MUTED, justify="left", wraplength=600)
    current_status.grid(row=3, column=0, sticky="ew", pady=(2, 0))
    wrap_labels.append(current_status)

    summary_card = card(content, "연결 정보", 2)
    data_value = path_field(summary_card, "연결 후 사용할 데이터 폴더", 1)
    availability = theme.label(summary_card, "DB와 설정 파일은 폴더를 선택한 뒤 확인합니다.",
                                bg=theme.PANEL, fg=theme.MUTED, justify="left", wraplength=600)
    availability.grid(row=2, column=0, sticky="ew", pady=(2, 0))
    details = theme.label(
        summary_card,
        "그림체 앱의 파일 기반 설정과 기록은 연결한 데이터 폴더에서 계속 사용합니다. 공통 생성 기본값은 현재 프로그램 설정을 계속 사용하며, 브라우저에만 저장된 화면·입력 설정은 가져오지 않습니다.",
        bg=theme.PANEL, fg=theme.MUTED, justify="left", wraplength=600,
    )
    details.grid(row=3, column=0, sticky="ew", pady=(5, 0))
    wrap_labels.extend((availability, details))

    ambiguous_card = card(content, "데이터 폴더 선택", 3)
    ambiguous_card.grid_remove()
    ambiguity_text = theme.label(
        ambiguous_card,
        "여러 데이터 폴더를 찾았습니다. 연결할 데이터 폴더를 선택해 주세요.",
        bg=theme.PANEL, fg=theme.MUTED, justify="left", wraplength=600,
    )
    ambiguity_text.grid(row=1, column=0, sticky="ew", pady=(0, 4))
    candidate_var = tk.StringVar(value="")
    candidate_combo = ttk.Combobox(ambiguous_card, textvariable=candidate_var, state="readonly")
    candidate_scroll = ttk.Scrollbar(ambiguous_card, orient="horizontal", command=candidate_combo.xview)
    candidate_combo.configure(xscrollcommand=candidate_scroll.set)
    candidate_combo.grid(row=2, column=0, sticky="ew")
    candidate_scroll.grid(row=3, column=0, sticky="ew", pady=(1, 0))
    wrap_labels.append(ambiguity_text)

    key_card = card(content, "NAI 키 선택", 4)
    key_card.grid_remove()
    key_message = theme.label(key_card, "", bg=theme.PANEL, fg=theme.WARNING,
                              justify="left", wraplength=600)
    key_message.grid(row=1, column=0, sticky="ew", pady=(0, 5))
    keep_key = theme.radio(key_card, "현재 프로그램 키 유지", key_choice_var, "keep", bg=theme.PANEL)
    source_key = theme.radio(key_card, "그림체 프로그램 키 사용", key_choice_var, "use_source", bg=theme.PANEL)
    keep_key.grid(row=2, column=0, sticky="ew", pady=1)
    source_key.grid(row=3, column=0, sticky="ew", pady=1)
    wrap_labels.append(key_message)

    footer = tk.Frame(window, bg=theme.BG, padx=14, pady=8)
    footer.grid(row=2, column=0, sticky="ew")
    footer.grid_columnconfigure(0, weight=1)
    status_label = theme.label(footer, textvariable=status_var, fg=theme.MUTED,
                               justify="left", wraplength=640)
    status_label.grid(row=0, column=0, sticky="ew", pady=(0, 6))
    wrap_labels.append(status_label)
    actions = tk.Frame(footer, bg=theme.BG)
    actions.grid(row=1, column=0, sticky="ew")
    actions.grid_columnconfigure(0, weight=1)

    def cancel_pending_reveal():
        after_id = state["reveal_after_id"]
        state["reveal_after_id"] = None
        if after_id is not None:
            try:
                window.after_cancel(after_id)
            except tk.TclError:
                pass

    def close():
        cancel_pending_reveal()
        try:
            window.grab_release()
        except tk.TclError:
            pass
        if window.winfo_exists():
            window.destroy()
        try:
            if previous_focus is not None and previous_focus.winfo_exists():
                previous_focus.focus_set()
            else:
                parent.focus_set()
        except tk.TclError:
            pass

    cancel_button = theme.button(actions, "취소", close, width=10)
    cancel_button.grid(row=0, column=1, padx=(0, 7))
    save_button = theme.button(actions, "연결 저장", lambda: None, primary=True, width=12, state="disabled")
    save_button.configure(disabledforeground=theme.PANEL)
    save_button.grid(row=0, column=2)

    def update_footer_width(event):
        status_label.configure(wraplength=max(220, event.width - 34))

    footer.bind("<Configure>", update_footer_width)

    def refresh_save_state():
        preview = state["preview"]
        ready = preview is not None
        if ready and preview.key_choice_required:
            ready = key_choice_var.get() in {"keep", "use_source"}
            status_var.set(
                "NAI 키 선택 완료. 연결을 저장할 수 있습니다."
                if ready else "NAI 키를 선택한 뒤 연결 저장을 눌러 주세요."
            )
        elif preview is not None:
            status_var.set("확인 완료. 저장하면 이후에는 선택한 데이터 폴더를 사용합니다.")
        save_button.configure(state="normal" if ready else "disabled")

    def reveal_card(widget):
        if not widget.winfo_exists() or widget.winfo_manager() != "grid":
            return
        canvas.update_idletasks()
        update_scroll_region()
        total_height = max(content.winfo_height(), canvas.winfo_height())
        viewport_height = canvas.winfo_height()
        max_offset = max(0, total_height - viewport_height)
        bottom = widget.winfo_y() + widget.winfo_height()
        offset = max(0, min(max_offset, bottom - viewport_height + 10))
        if total_height:
            canvas.yview_moveto(offset / total_height)

    def schedule_reveal(widget):
        cancel_pending_reveal()

        def reveal_after_layout():
            state["reveal_after_id"] = None
            if window.winfo_exists():
                reveal_card(widget)

        # Let Tk settle the expanded scroll region before moving its viewport.
        state["reveal_after_id"] = window.after(20, reveal_after_layout)

    key_choice_var.trace_add("write", lambda *_: refresh_save_state())

    def clear_preview():
        state["preview"] = None
        data_value.set("")
        availability.configure(text="DB와 설정 파일은 폴더를 선택한 뒤 확인합니다.", fg=theme.MUTED)
        key_choice_var.set("")
        key_card.grid_remove()
        refresh_save_state()

    def show_preview(preview):
        state["preview"] = preview
        ambiguous_card.grid_remove()
        data_value.set(preview.data_dir)
        db_text = "그림체 DB 확인됨"
        settings_text = "독립 실행 설정 파일 있음" if preview.settings_present else "독립 실행 설정 파일 없음"
        availability.configure(text=f"{db_text} · {settings_text}", fg=theme.ACCENT)
        key_choice_var.set("")
        if preview.key_choice_required:
            if preview.current_key_present and preview.source_key_present:
                message = "현재 프로그램과 그림체 프로그램의 NAI 키가 다릅니다. 저장 전에 사용할 키를 선택해 주세요."
            elif preview.source_key_present:
                message = "현재 프로그램에 NAI 키가 없습니다. 그림체 프로그램 키를 사용할지 선택해 주세요."
            elif preview.current_key_present:
                message = "그림체 프로그램에 NAI 키가 없습니다. 현재 프로그램 키를 유지할지 선택해 주세요."
            else:
                message = "NAI 키가 서로 다르거나 비어 있습니다. 사용할 키를 선택해 주세요."
            key_message.configure(text=message)
            key_card.grid(row=4, column=0, sticky="ew", padx=2, pady=(0, 8))
        else:
            key_card.grid_remove()
        refresh_save_state()
        update_scroll_region()
        if preview.key_choice_required:
            schedule_reveal(key_card)

    def inspect_selected(data_dir=None):
        selected_dir = selected_value.get()
        if not selected_dir:
            return
        clear_preview()
        try:
            preview = style_connection.inspect_connection(
                app_dir, selected_dir, **({"data_dir": data_dir} if data_dir is not None else {})
            )
        except style_connection.AmbiguousDataDirectories as error:
            candidates = tuple(error.directories)
            candidate_var.set("")
            candidate_combo.configure(values=candidates)
            if candidates:
                ambiguous_card.grid(row=3, column=0, sticky="ew", padx=2, pady=(0, 8))
                status_var.set("연결할 데이터 폴더를 선택해 주세요.")
                schedule_reveal(ambiguous_card)
            else:
                ambiguous_card.grid_remove()
                status_var.set("데이터 폴더를 찾지 못했습니다. 다른 프로그램 폴더를 선택해 주세요.")
        except Exception as error:
            ambiguous_card.grid_remove()
            status_var.set(f"폴더를 확인하지 못했습니다: {error}")
        else:
            show_preview(preview)
        update_scroll_region()

    def choose_folder():
        initialdir = state["current"].get("source_dir") if state["current"] else None
        if not initialdir or not Path(initialdir).is_dir():
            initialdir = str(app_dir)
        selected = filedialog.askdirectory(
            parent=window, title="그림체 프로그램 폴더 선택", initialdir=initialdir,
            mustexist=True,
        )
        if not selected:
            return
        selected_value.set(selected)
        candidate_var.set("")
        ambiguous_card.grid_remove()
        inspect_selected()

    choose_button.configure(command=choose_folder)
    candidate_combo.bind("<<ComboboxSelected>>", lambda _event: inspect_selected(candidate_var.get()))

    def save():
        preview = state["preview"]
        if preview is None:
            return
        if callable(can_save):
            allowed = can_save()
        else:
            allowed = True if can_save is None else bool(can_save)
        if not allowed:
            messagebox.showerror(
                "연결 저장",
                "진행 중인 작업과 서버를 정지한 뒤 연결을 저장해 주세요.",
                parent=window,
            )
            return
        choice = key_choice_var.get() if preview.key_choice_required else None
        try:
            style_connection.save_connection(preview, key_choice=choice)
        except Exception as error:
            messagebox.showerror("연결 저장 실패", str(error), parent=window)
            status_var.set("저장하지 못했습니다. 선택한 폴더와 입력을 확인한 뒤 다시 시도해 주세요.")
            return
        if on_saved is not None:
            on_saved()
        messagebox.showinfo(
            "연결 완료",
            "연결을 저장했습니다. 서버를 시작한 뒤 그림체 관리 화면을 열어 주세요.",
            parent=window,
        )
        close()

    save_button.configure(command=save)
    window.protocol("WM_DELETE_WINDOW", close)
    window.bind("<Escape>", lambda _event: close())

    try:
        connection = style_connection.current_connection(app_dir)
    except Exception as error:
        state["current"] = None
        current_status.configure(text=f"현재 연결 정보를 읽지 못했습니다: {error}", fg=theme.ERROR)
        status_var.set("현재 연결 정보를 확인하지 못했습니다. 폴더를 선택해 다시 확인해 주세요.")
    else:
        state["current"] = connection
        source_dir = connection.get("source_dir", "")
        data_dir = connection.get("data_dir", "")
        current_source_value.set(source_dir or "")
        current_data_value.set(data_dir or "")
        if source_dir or data_dir:
            current_status.configure(text="현재 저장된 연결입니다. 새 폴더를 확인한 뒤 연결을 바꿀 수 있습니다.")

    window.grid_columnconfigure(0, weight=1)
    window.grid_rowconfigure(1, weight=1)
    window.update_idletasks()
    actual_width = window.winfo_width()
    actual_height = window.winfo_height()
    if parent.winfo_viewable():
        x = parent.winfo_rootx() + (parent.winfo_width() - actual_width) // 2
        y = parent.winfo_rooty() + (parent.winfo_height() - actual_height) // 2
    else:
        x = (screen_width - actual_width) // 2
        y = (screen_height - actual_height) // 2
    x = max(8, min(x, screen_width - actual_width - 8))
    y = max(8, min(y, screen_height - actual_height - 8))
    window.geometry(f"{actual_width}x{actual_height}+{x}+{y}")
    window.grab_set()
    choose_button.focus_set()
    return window
