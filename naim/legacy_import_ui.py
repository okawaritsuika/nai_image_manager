"""A separate launcher mode keeps the server and workers closed during import."""
import os
from pathlib import Path
import queue
import socket
import subprocess
import sys
import threading
import tkinter as tk
from tkinter import filedialog

from naim import desktop_dialogs as messagebox
from naim import desktop_theme as theme
from naim.storage.legacy_import import inspect_installation, import_installation
from naim_updater import wait_for_process


def run(destination, parent_pid=0):
    wait_for_process(parent_pid)
    root = tk.Tk()
    theme.configure_window(root, '기존 프로그램 자료 가져오기')
    root.geometry('650x470')
    chosen = tk.StringVar()
    status = tk.StringVar(value='예전 프로그램을 종료한 뒤, EXE가 있는 폴더 전체를 선택하세요.')
    events = queue.Queue()
    busy = False

    def restart():
        cmd = [sys.executable] if getattr(sys, 'frozen', False) else [sys.executable, str(Path(destination) / 'main_executor.pyw')]
        subprocess.Popen(cmd, cwd=destination, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        root.destroy()

    def choose():
        selected = filedialog.askdirectory(title='기존 EXE가 있는 프로그램 폴더 전체 선택', parent=root)
        if not selected:
            return
        try:
            _, _, items = inspect_installation(selected, destination)
        except Exception as error:
            messagebox.showerror('폴더 확인', str(error), parent=root)
            return
        chosen.set(selected)
        preview.delete('1.0', 'end')
        preview.insert('1.0', '\n'.join(items))
        start.config(state='normal')

    def begin():
        nonlocal busy
        with socket.socket() as probe:
            if probe.connect_ex(('127.0.0.1', 5000)) == 0:
                messagebox.showerror('실행 중인 서버', '기존 프로그램과 현재 프로그램의 서버를 모두 종료한 뒤 다시 시도하세요.', parent=root)
                return
        if not messagebox.askyesno('자료 가져오기', '표시된 자료를 복사할까요?\n\n기존 폴더 원본은 유지합니다.\n현재 프로그램의 해당 자료는 별도 백업한 뒤 교체합니다.\n가져온 뒤 프로그램을 다시 열어 주세요.', parent=root):
            return
        busy = True
        start.config(state='disabled')
        pick.config(state='disabled')
        launch.config(state='disabled')
        status.set('복사 및 확인 중입니다. 이미지가 많으면 시간이 걸립니다.')
        source = chosen.get()

        def worker():
            try:
                events.put((True, import_installation(source, destination)))
            except Exception as error:
                events.put((False, str(error)))
        threading.Thread(target=worker, daemon=False).start()

    def poll():
        nonlocal busy
        try:
            ok, result = events.get_nowait()
        except queue.Empty:
            root.after(100, poll)
            return
        busy = False
        pick.config(state='normal')
        launch.config(state='normal')
        if ok:
            status.set('가져오기 완료. 프로그램 열기를 눌러 이어서 사용하세요.')
            messagebox.showinfo('완료', '기존 자료를 가져왔습니다.\n현재 자료의 백업 위치:\n' + result['backup'], parent=root)
        else:
            status.set('가져오기에 실패했습니다. 오류 내용을 확인해 주세요.')
            start.config(state='normal')
            messagebox.showerror('가져오기 실패', result, parent=root)
        root.after(100, poll)

    def close():
        if busy:
            messagebox.showinfo('가져오는 중', '자료 복사와 복구가 끝난 뒤 창을 닫아 주세요.', parent=root)
        else:
            root.destroy()

    theme.label(root, '기존 프로그램 자료 가져오기', fg=theme.ACCENT,
                font=(*theme.FONT, 'bold')).pack(anchor='w', padx=15, pady=(12, 4))
    theme.label(root, textvariable=status, wraplength=610, justify='left').pack(anchor='w', padx=15, pady=(0, 10))
    tk.Entry(root, textvariable=chosen, state='readonly', font=theme.FONT,
             readonlybackground=theme.PANEL, fg=theme.INK, relief='flat',
             highlightbackground=theme.BORDER, highlightthickness=1).pack(fill='x', padx=15, ipady=4)
    pick = theme.button(root, '기존 프로그램 폴더 선택', choose)
    pick.pack(pady=8)
    preview = tk.Text(root, height=12, bg=theme.PANEL, fg=theme.INK, font=theme.FONT,
                      relief='flat', highlightbackground=theme.BORDER, highlightthickness=1,
                      padx=8, pady=6)
    preview.pack(fill='both', expand=True, padx=15)
    theme.label(root, '브라우저에만 저장한 화면 상태는 같은 브라우저와 주소에서 이어집니다.',
                fg=theme.MUTED, font=theme.SMALL_FONT).pack(pady=5)
    start = theme.button(root, '표시된 자료 가져오기', begin, primary=True, state='disabled')
    start.pack(side='left', padx=15, pady=10)
    launch = theme.button(root, '프로그램 열기', restart)
    launch.pack(side='right', padx=15, pady=10)
    root.protocol('WM_DELETE_WINDOW', close)
    root.bind('<Escape>', lambda event: close())
    root.after(100, poll)
    root.mainloop()
