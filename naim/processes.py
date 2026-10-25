"""Cancellable native-engine execution, independent of image processing."""
import os
import subprocess


class UpscaleCancelled(Exception):
    pass


def run_process_with_cancel(cmd, cancel_event=None, cwd=None):
    if cancel_event is not None and cancel_event.is_set():
        raise UpscaleCancelled()
    process = subprocess.Popen(
        cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding='utf-8', errors='replace',
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
    )
    try:
        while True:
            if cancel_event is not None and cancel_event.is_set():
                raise UpscaleCancelled()
            try:
                output, _ = process.communicate(timeout=0.1)
                return process.returncode, '\n'.join((output or '').splitlines())
            except subprocess.TimeoutExpired:
                # communicate drains pipes while allowing cancellation even
                # when an engine emits no output or no newline for minutes.
                continue
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
        if process.stdout is not None:
            process.stdout.close()
