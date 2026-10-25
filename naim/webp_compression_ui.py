"""Desktop controls for verified, offline gallery PNG compression."""
from functools import partial
import os
import tkinter as tk
from tkinter import scrolledtext, ttk

import utils
from naim import desktop_dialogs as messagebox
from naim import desktop_theme as theme
from naim.jobs.webp_compression import WebPCompressionJobs, gallery_processor
from naim.paths import get_app_dir


def choose_webp_storage(parent):
    """Choose whether converted WebP files supplement or replace PNGs."""
    window = messagebox._window(parent, 'WebP 저장 방식 선택')
    body = messagebox._body(window)
    messagebox._text(body, 'WebP 저장 방식 선택', fg=theme.ACCENT,
                     font=(*theme.FONT, 'bold')).pack(anchor='w', pady=(0, 8))
    result = {'choice': None}

    def choose(value):
        result['choice'] = value
        window.destroy()

    for value, title, description, label in (
        ('keep_original', '원본 유지 + WebP 추가',
         '원본 PNG와 기존 갤러리 연결을 유지하고 WebP를 추가합니다. 디스크 사용량이 늘어납니다.',
         '원본 유지 + WebP 추가'),
        ('replace_original', '원본을 WebP로 교체',
         '변환과 메타데이터 검증이 끝나면 PNG를 삭제하고 기존 갤러리 연결을 WebP로 갱신합니다.',
         '원본을 WebP로 교체'),
    ):
        card = messagebox._card(body, title)
        messagebox._text(card, description, fg=theme.MUTED).pack(
            anchor='w', fill='x', pady=(0, 6))
        theme.button(card, label, lambda value=value: choose(value), primary=True).pack(fill='x')

    cancel = theme.button(body, '취소', lambda: choose(None), width=10)
    cancel.pack(anchor='e')
    messagebox._wait_modal(window, parent, cancel, lambda: choose(None))
    return result['choice']


class WebPCompressionDialog:
    def __init__(self, controller):
        self.controller = controller
        self.gallery_root = os.path.join(get_app_dir(), 'TOTAL_CLASSIFIED')
        self.jobs = None
        self.running = False
        self.job_token = None
        self.window = tk.Toplevel(controller.root)
        theme.configure_window(self.window, '갤러리 WebP 압축')
        self.window.transient(controller.root)
        self.window.minsize(600, 460)
        self.window.protocol('WM_DELETE_WINDOW', self.close)
        self.window.bind('<Escape>', lambda event: self.close())
        self.mode = tk.StringVar(self.window, value='lossless')
        self.quality = tk.StringVar(self.window, value='90')
        self.status = tk.StringVar(self.window, value='압축 방식을 선택한 뒤 실행해 주세요.')
        content = tk.Frame(self.window, bg=theme.BG, padx=14, pady=12)
        content.pack(fill='both', expand=True)
        theme.label(content, '갤러리 전체 PNG → WebP', fg=theme.ACCENT,
                    font=(*theme.FONT, 'bold')).pack(anchor='w')
        theme.label(content, self.gallery_root, fg=theme.MUTED,
                    wraplength=570, justify='left').pack(anchor='w', pady=(6, 4))
        theme.label(content, '하위 폴더·휴지통·업스케일 포함 · JPG와 기존 WebP는 유지\n'
                 '변환·메타데이터 보존 검증 후 실행 직전 선택한 방식으로 처리합니다.\n'
                 '원본 교체를 선택한 경우만 PNG를 삭제하며, 실패·이름 중복 파일은 원본을 유지합니다.\n'
                 'PNG 고유 메타데이터는 보관되지만, 다른 프로그램에서 표시되지 않을 수 있습니다.\n'
                 'PC 성능·여유 메모리에 맞춰 여러 장을 동시에 압축합니다.\n'
                 '실제 변환은 웹 서버를 중지한 뒤 실행하세요. 완료 후 갤러리를 새로고침하세요.',
                    fg=theme.MUTED, justify='left', wraplength=570).pack(anchor='w', pady=6)
        self.options = []
        for value, label in (('lossless', '무손실 — 원본 화질과 투명도 유지'),
                             ('lossy', '손실 — 화질을 조절해 용량 줄이기')):
            button = theme.radio(content, label, self.mode, value,
                                 command=self._update_quality, bg=theme.BG,
                                 activebackground=theme.BG)
            button.pack(anchor='w')
            self.options.append(button)
        row = tk.Frame(content, bg=theme.BG)
        row.pack(anchor='w', pady=(2, 8))
        theme.label(row, '손실 압축 화질 (1~100)').pack(side='left')
        self.quality_input = theme.spin(row, self.quality, 1, 100, width=5)
        self.quality_input.pack(side='left', padx=8)
        self._update_quality()
        self.estimate_button = theme.button(content, '예상 용량 계산 (원본 유지)',
                                            lambda: self.start(estimate=True))
        self.estimate_button.pack(fill='x', pady=(0, 5))
        self.start_button = theme.button(content, 'WebP 변환…', self.start, primary=True)
        self.start_button.pack(fill='x')
        theme.label(content, textvariable=self.status, fg=theme.ACCENT,
                    wraplength=570, justify='left').pack(anchor='w', pady=10)
        theme.style_progress(self.window)
        self.progress = ttk.Progressbar(content, maximum=100, style='Remote.Horizontal.TProgressbar')
        self.progress.pack(fill='x')
        self.details = scrolledtext.ScrolledText(content, height=5, state='disabled',
                                                bg=theme.PANEL, fg=theme.INK, font=theme.FONT,
                                                relief='flat', highlightbackground=theme.BORDER,
                                                highlightthickness=1, wrap='word')
        self.details.pack(fill='both', expand=True, pady=8)
        self.cancel_button = theme.button(content, '중지', self.cancel, danger=True, state='disabled')
        self.cancel_button.pack(side='right')

    def _update_quality(self):
        self.quality_input.config(state='normal' if self.mode.get() == 'lossy' and not self.running else 'disabled')

    def start(self, estimate=False):
        if self.running or not self.controller._can_start_job():
            return
        if not estimate and (self.controller.server_transitioning or utils.is_port_active(5000)):
            messagebox.showwarning('웹 서버 중지 필요',
                                   '파일 경로가 바뀌므로 리모콘에서 웹 서버를 중지한 뒤 실행해 주세요.', parent=self.window)
            return
        try:
            quality = int(self.quality.get()) if self.mode.get() == 'lossy' else 90
            if not 1 <= quality <= 100:
                raise ValueError()
        except (ValueError, tk.TclError):
            messagebox.showwarning('화질 확인', '화질은 1~100의 정수로 입력해 주세요.', parent=self.window)
            return
        if not os.path.isdir(self.gallery_root):
            messagebox.showwarning('갤러리 확인', '갤러리 폴더가 없습니다.', parent=self.window)
            return
        keep_original = False
        if not estimate:
            choice = choose_webp_storage(self.window)
            if choice is None:
                return
            keep_original = choice == 'keep_original'
        self.running = True
        self.jobs = None
        self.worker_error = ''
        self.keep_original = keep_original
        options = (self.mode.get() == 'lossless', quality, estimate)
        worker = partial(self._worker, keep_original=keep_original)
        if not self.controller._launch_job('webp', worker, args=options):
            self.running = False
            return
        self.job_token = self.controller._job_token
        self.start_button.config(state='disabled')
        self.estimate_button.config(state='disabled')
        for option in self.options:
            option.config(state='disabled')
        self._update_quality()
        self.cancel_button.config(state='normal')
        self.status.set('PNG 목록 수집 중…')
        self.window.after(150, self._poll)

    def _worker(self, lossless, quality, estimate, job_token=None, keep_original=False):
        db = None
        try:
            processor = None
            if not estimate:
                db = utils.HistoryDB(os.path.join(self.gallery_root, 'naia_history.db'))
                processor = gallery_processor(db, self.gallery_root,
                                              os.path.join(get_app_dir(), 'gallery_image_tags.json'),
                                              keep_original=keep_original)
            self.jobs = WebPCompressionJobs(lambda: self.gallery_root, processor)
            self.jobs.start(lossless=lossless, quality=quality, estimate=estimate)
            while self.jobs.thread.is_alive():
                if self.controller.stop_requested:
                    self.jobs.cancel()
                self.jobs.thread.join(timeout=0.1)
        except Exception as error:
            self.worker_error = str(error)
        finally:
            try:
                if db is not None:
                    db.close()
            finally:
                self.running = False

    def _poll(self):
        state = self.jobs.snapshot() if self.jobs else {}
        processed, total = state.get('processed', 0), state.get('total', 0)
        converted, skipped, failed = (state.get(key, 0) for key in ('converted', 'skipped', 'failed'))
        saved = (state.get('source_bytes', 0) - state.get('target_bytes', 0)) / (1024 * 1024)
        phase = '목록 수집 중' if state.get('phase') == 'scanning' else '압축 중'
        if not self.running:
            phase = {'cancelled': '중지됨', 'error': '오류'}.get(state.get('status'), '완료')
        elif state.get('cancel_requested'):
            phase = '중지 요청됨 · 처리 중인 파일 정리 중'
        before = state.get('source_bytes', 0)
        after = state.get('target_bytes', 0)
        if getattr(self, 'keep_original', False):
            summary = (f'{phase}: {processed:,} / {total:,} · 변환 {converted:,} · 건너뜀 {skipped:,} · 실패 {failed:,}\n'
                       f'원본 PNG {before / (1024 * 1024):,.2f} MiB 유지 · 추가 WebP {after / (1024 * 1024):,.2f} MiB\n'
                       f'원본 유지 · WebP {after / (1024 * 1024):,.2f} MiB 추가')
        else:
            percent = (before - after) * 100 / before if before else 0
            change = f'{saved:,.2f} MiB 절약' if saved >= 0 else f'{-saved:,.2f} MiB 증가'
            ratio = f'{percent:.1f}% 감소' if percent >= 0 else f'{-percent:.1f}% 증가'
            summary = (f'{phase}: {processed:,} / {total:,} · 변환 {converted:,} · 건너뜀 {skipped:,} · 실패 {failed:,}\n'
                       f'변환한 파일: {before / (1024 * 1024):,.2f} MiB → {after / (1024 * 1024):,.2f} MiB\n'
                       f'{change} · {ratio}')
        if state.get('estimate'):
            sampled, sample_total = state.get('sampled', 0), state.get('sample_total', 0)
            summary = f'예상 용량 계산: 표본 {sampled} / {sample_total}장 · 전체 PNG {total:,}장'
            if self.running and state.get('cancel_requested'):
                summary += '\n중지 요청됨 · 처리 중인 파일 정리 중'
            if 'estimated_target_bytes' in state:
                before, after = state['estimated_source_bytes'], state['estimated_target_bytes']
                saved = before - after
                percent = abs(saved) * 100 / before if before else 0
                direction = '절약' if saved >= 0 else '증가'
                summary += (f'\n현재 {before / (1024 * 1024):,.2f} MiB → 예상 {after / (1024 * 1024):,.2f} MiB'
                            f'\n약 {abs(saved) / (1024 * 1024):,.2f} MiB ({percent:.1f}%) {direction}'
                            '\n표본 기반 추정치입니다. 이미지 내용·변환 제외 파일에 따라 실제 결과가 달라집니다.')
            elif not self.running:
                summary += '\n중지되었거나 예상 용량을 계산하지 못했습니다.'
            processed, total = sampled, sample_total
        error = getattr(self, 'worker_error', '') or state.get('error', '')
        if error:
            summary += '\n' + error
        self.status.set(summary)
        self.controller.lbl_progress.config(text=summary.split('\n')[0])
        self.progress['value'] = processed * 100 / total if total else 0
        lines = [f"{item['path']}: {item['message']}" for item in state.get('details', [])]
        if lines:
            lines.insert(0, '원본 유지 내역 (최대 30건)')
        self.details.config(state='normal')
        self.details.delete('1.0', 'end')
        self.details.insert('end', '\n'.join(lines))
        self.details.config(state='disabled')
        if self.running:
            self.window.after(250, self._poll)
        else:
            self.controller._finish_job('webp', self.job_token)
            self.controller.log(summary)
            self.start_button.config(state='normal')
            self.estimate_button.config(state='normal')
            self.cancel_button.config(state='disabled')
            for option in self.options:
                option.config(state='normal')
            self._update_quality()

    def cancel(self):
        self.controller.stop_process()
        if self.jobs:
            self.jobs.cancel()
        self.cancel_button.config(state='disabled')

    def close(self):
        if self.running or self.controller._active_job == 'webp':
            self.cancel()
            self.status.set('중지 요청됨. 현재 파일의 처리가 끝나면 창을 닫을 수 있습니다.')
            return
        self.window.destroy()
