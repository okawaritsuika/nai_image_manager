"""Shared, compact Tk appearance for the controller and its dialogs."""

from pathlib import Path
import tkinter as tk
from tkinter import ttk

from .paths import get_app_dir


BG = "#f3f5f5"
PANEL = "#ffffff"
INK = "#273739"
MUTED = "#637679"
BORDER = "#d9e1e2"
ACCENT = "#267b75"
SOFT = "#e9f3f0"
ERROR = "#a84242"
WARNING = "#966a20"
INFO = "#386f95"
FONT = ("Malgun Gothic", 9)
SMALL_FONT = ("Malgun Gothic", 8)


def configure_window(window, title=None):
    window.configure(bg=BG)
    if title is not None:
        window.title(title)
    icon = Path(get_app_dir()) / "assets" / "app_icon.ico"
    if icon.is_file():
        try:
            window.iconbitmap(str(icon))
        except tk.TclError:
            pass  # Non-Windows Tk builds may not support ICO icons.


def label(parent, text="", **options):
    style = dict(bg=parent.cget("bg"), fg=INK, font=FONT, anchor="w")
    style.update(options)
    return tk.Label(parent, text=text, **style)


def button(parent, text, command, primary=False, danger=False, **options):
    style = dict(
        font=FONT, relief="flat", bd=0,
        bg=ACCENT if primary else BG, fg=PANEL if primary else ERROR if danger else INK,
        activebackground=ACCENT if primary else SOFT,
        activeforeground=PANEL if primary else INK, disabledforeground=MUTED,
        highlightbackground=BORDER, highlightcolor=ACCENT, highlightthickness=1,
        padx=8, pady=3, cursor="hand2",
    )
    style.update(options)
    return tk.Button(parent, text=text, command=command, **style)


def _rgb(color, widget):
    return tuple(component // 257 for component in widget.winfo_rgb(color))


def _inside_indicator(x, y, size, radio, inset):
    center = size / 2
    if radio:
        return (x - center) ** 2 + (y - center) ** 2 <= (center - inset) ** 2
    radius = size * 0.24
    dx = max(abs(x - center) - (center - inset - radius), 0)
    dy = max(abs(y - center) - (center - inset - radius), 0)
    return dx * dx + dy * dy <= radius * radius


def _on_check_mark(x, y, size):
    for first, second in (((0.24, 0.50), (0.43, 0.69)), ((0.43, 0.69), (0.78, 0.31))):
        ax, ay = first[0] * size, first[1] * size
        bx, by = second[0] * size, second[1] * size
        dx, dy = bx - ax, by - ay
        distance = max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
        if (x - ax - distance * dx) ** 2 + (y - ay - distance * dy) ** 2 <= (size * 0.068) ** 2:
            return True
    return False


def _indicator(widget, radio, selected, disabled, hovered):
    """Cache small antialiased indicators per Tcl interpreter, without assets."""
    root = widget._root()
    scale = float(widget.tk.call("tk", "scaling")) / (96 / 72)
    size = max(12, round(13 * scale))
    background = widget.cget("bg")
    key = (radio, selected, disabled, hovered, background, size)
    if not hasattr(root, "_desktop_indicator_images"):
        root._desktop_indicator_images = {}
    cache = root._desktop_indicator_images
    if key in cache:
        return cache[key]
    edge = MUTED if disabled else ACCENT if selected or hovered else "#9eafb0"
    fill = BORDER if disabled and selected else ACCENT if selected else SOFT if hovered else PANEL
    colors = {name: _rgb(color, widget) for name, color in
              (("background", background), ("edge", edge), ("fill", fill), ("mark", MUTED if disabled else PANEL))}
    border = max(1, size * 0.08)
    rows = []
    for py in range(size):
        pixels = []
        for px in range(size):
            samples = []
            for sx, sy in ((0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)):
                x, y = px + sx, py + sy
                color = "background"
                if _inside_indicator(x, y, size, radio, 0.5):
                    color = "fill" if _inside_indicator(x, y, size, radio, border + 0.5) else "edge"
                    mark = ((x - size / 2) ** 2 + (y - size / 2) ** 2 <= (size * 0.18) ** 2
                            if radio else _on_check_mark(x, y, size))
                    if selected and mark:
                        color = "mark"
                samples.append(colors[color])
            pixels.append("#%02x%02x%02x" % tuple(round(sum(value[channel] for value in samples) / 4)
                                                for channel in range(3)))
        rows.append("{" + " ".join(pixels) + "}")
    image = tk.PhotoImage(master=root, width=size + max(5, round(5 * scale)), height=size)
    image.put(" ".join(rows), to=(0, 0, size, size))
    cache[key] = image
    return image


class _ChoiceAppearance:
    _radio_indicator = False

    def __init__(self, *args, **options):
        self._appearance_ready = False
        self._hovered = False
        super().__init__(*args, **options)
        self._appearance_ready = True
        self._refresh_indicators()
        self.bind("<Enter>", lambda event: self._hover(True), add="+")
        self.bind("<Leave>", lambda event: self._hover(False), add="+")

    def _hover(self, hovered):
        self._hovered = hovered
        self._refresh_indicators()

    def _refresh_indicators(self):
        disabled = str(self.cget("state")) == "disabled"
        images = [_indicator(self, self._radio_indicator, selected, disabled, self._hovered and not disabled)
                  for selected in (False, True)]
        super().configure(image=images[0], selectimage=images[1], selectcolor=self.cget("bg"))

    def configure(self, cnf=None, **options):
        result = super().configure(cnf, **options)
        if self._appearance_ready and (options or isinstance(cnf, dict)):
            self._refresh_indicators()
        return result

    config = configure


class _Checkbutton(_ChoiceAppearance, tk.Checkbutton):
    pass


class _Radiobutton(_ChoiceAppearance, tk.Radiobutton):
    _radio_indicator = True


def _choice_options(parent, options):
    background = parent.cget("bg")
    style = dict(
        bg=background, fg=INK, selectcolor=background,
        activebackground=background, activeforeground=ACCENT,
        disabledforeground=MUTED, font=FONT, bd=0, padx=0, pady=1,
        highlightbackground=background, highlightcolor=ACCENT, highlightthickness=1,
        anchor="w", indicatoron=False, compound="left", relief="flat",
        offrelief="flat", overrelief="flat", cursor="hand2", takefocus=True,
    )
    style.update(options)
    return style


def check(parent, text, variable, **options):
    return _Checkbutton(parent, text=text, variable=variable, **_choice_options(parent, options))


def radio(parent, text, variable, value, **options):
    return _Radiobutton(parent, text=text, variable=variable, value=value,
                        **_choice_options(parent, options))


def spin(parent, variable, minimum, maximum, width=4, **options):
    style = dict(
        font=FONT, bg=BG, fg=INK, buttonbackground=BG, insertbackground=INK,
        disabledbackground=BG, disabledforeground=MUTED,
        relief="flat", bd=0, highlightbackground=BORDER,
        highlightcolor=ACCENT, highlightthickness=1,
    )
    style.update(options)
    return tk.Spinbox(parent, textvariable=variable, from_=minimum, to=maximum, width=width, **style)


def style_progress(root):
    """Configure scoped 4px bars without replacing the Windows ttk theme."""
    style = ttk.Style(root)
    elements = style.element_names()
    for part in ("trough", "pbar"):
        name = f"Remote.Progressbar.{part}"
        if name not in elements:
            style.element_create(name, "from", "default", f"Horizontal.Progressbar.{part}")
    style.layout("Remote.Horizontal.TProgressbar", [
        ("Remote.Progressbar.trough", {"sticky": "nswe", "children": [
            ("Remote.Progressbar.pbar", {"side": "left", "sticky": "ns"}),
        ]}),
    ])
    style.configure("Remote.Horizontal.TProgressbar", thickness=4,
                    background=ACCENT, troughcolor=BORDER, borderwidth=0,
                    pbarrelief="flat", troughrelief="flat")
