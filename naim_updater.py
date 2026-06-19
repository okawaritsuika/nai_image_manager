import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

import exe_update


MANAGED_MANIFEST = ".naim-managed-files.json"
PROTECTED_DIRECTORIES = {
    "total_classified",
    "output",
    "canvas_imports",
    "daki_generated_temp",
}
PROTECTED_FILES = {
    "artists.json",
    "styles.json",
    "gallery_config.json",
    "gallery_image_tags.json",
    "lab_config.json",
    "quality_presets.json",
    "tag_dictionary_user_overrides.json",
    "canvas_saved_setups.json",
    "tag_categories_ko.json",
    ".env",
}


def _normalized_relative_path(value):
    text = str(value or "").replace("\\", "/")
    path = PurePosixPath(text)
    if not text or path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        raise ValueError(f"안전하지 않은 상대 경로입니다: {value}")
    if ":" in path.parts[0]:
        raise ValueError(f"안전하지 않은 상대 경로입니다: {value}")
    return path


def _is_protected(path):
    lowered = [part.lower() for part in path.parts]
    return (
        any(part in PROTECTED_DIRECTORIES for part in lowered)
        or lowered[-1] in PROTECTED_FILES
        or lowered[-1].startswith(".env")
    )


def _validated_managed_paths(paths):
    if not isinstance(paths, list):
        raise ValueError("관리 파일 목록이 올바르지 않습니다.")
    result = []
    seen = set()
    for value in paths:
        path = _normalized_relative_path(value)
        if _is_protected(path):
            raise ValueError(f"사용자 데이터는 관리 파일에 포함할 수 없습니다: {path.as_posix()}")
        normalized = path.as_posix()
        if normalized == MANAGED_MANIFEST or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return sorted(result)


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_archive(path, expected_sha256, expected_size):
    archive = Path(path)
    if archive.stat().st_size != expected_size:
        raise ValueError("다운로드한 업데이트 파일 크기가 일치하지 않습니다.")
    if sha256_file(archive).lower() != expected_sha256.lower():
        raise ValueError("다운로드한 업데이트 파일의 SHA-256이 일치하지 않습니다.")


def safe_extract(archive_path, destination, payload_root):
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    root = _normalized_relative_path(payload_root)
    if len(root.parts) != 1:
        raise ValueError("압축 루트 폴더가 올바르지 않습니다.")

    with zipfile.ZipFile(archive_path) as bundle:
        entries = []
        for info in bundle.infolist():
            if "\\" in info.filename:
                raise ValueError(f"안전하지 않은 ZIP 경로입니다: {info.filename}")
            relative = _normalized_relative_path(info.filename.rstrip("/"))
            if relative.parts[0] != root.parts[0]:
                raise ValueError(f"예상하지 못한 ZIP 루트입니다: {info.filename}")
            unix_mode = (info.external_attr >> 16) & 0o170000
            if unix_mode == 0o120000:
                raise ValueError("심볼릭 링크가 포함된 업데이트는 설치할 수 없습니다.")
            entries.append((info, relative))

        for info, relative in entries:
            target = destination.joinpath(*relative.parts)
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(info) as source, target.open("wb") as output:
                shutil.copyfileobj(source, output)

    payload = destination / root.parts[0]
    if not payload.is_dir():
        raise ValueError("업데이트 압축에 프로그램 폴더가 없습니다.")
    return payload


def load_managed_files(folder):
    manifest_path = Path(folder) / MANAGED_MANIFEST
    if not manifest_path.exists():
        return []
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("관리 파일 목록을 읽을 수 없습니다.") from exc
    return _validated_managed_paths(data.get("files"))


def apply_staged_update(payload_dir, install_dir, copy_file=shutil.copy2):
    payload = Path(payload_dir)
    install = Path(install_dir)
    new_files = load_managed_files(payload)
    if not new_files:
        raise ValueError("업데이트에 관리 파일 목록이 없거나 비어 있습니다.")
    old_files = load_managed_files(install)
    for relative in new_files:
        if not (payload / Path(relative)).is_file():
            raise ValueError(f"업데이트 파일이 누락되었습니다: {relative}")

    install.mkdir(parents=True, exist_ok=True)
    affected = sorted(set(old_files).union(new_files).union({MANAGED_MANIFEST}))
    backup = Path(tempfile.mkdtemp(prefix="naim-update-backup-"))
    originally_present = set()

    try:
        for relative in affected:
            current = install / Path(relative)
            if current.is_file():
                originally_present.add(relative)
                backup_target = backup / Path(relative)
                backup_target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(current, backup_target)

        for relative in sorted(set(old_files).difference(new_files)):
            current = install / Path(relative)
            if current.is_file():
                current.unlink()

        for relative in new_files:
            source = payload / Path(relative)
            target = install / Path(relative)
            target.parent.mkdir(parents=True, exist_ok=True)
            copy_file(source, target)

        copy_file(payload / MANAGED_MANIFEST, install / MANAGED_MANIFEST)
    except Exception:
        for relative in affected:
            current = install / Path(relative)
            if current.is_file():
                current.unlink()
        for relative in originally_present:
            backup_source = backup / Path(relative)
            target = install / Path(relative)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(backup_source, target)
        raise
    finally:
        shutil.rmtree(backup, ignore_errors=True)

    return {"installed": len(new_files), "removed": len(set(old_files).difference(new_files))}


def download_file(url, destination, progress=None):
    request = urllib.request.Request(url, headers={"User-Agent": "NAI-Image-Manager-Updater"})
    with urllib.request.urlopen(request, timeout=30) as response, Path(destination).open("wb") as output:
        total = int(response.headers.get("Content-Length", "0") or 0)
        received = 0
        while True:
            block = response.read(1024 * 1024)
            if not block:
                break
            output.write(block)
            received += len(block)
            if progress:
                progress(received, total)


def wait_for_process(pid, timeout=60):
    if not pid:
        return
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except OSError:
            return
        time.sleep(0.2)
    raise TimeoutError("실행 중인 프로그램이 종료되지 않아 업데이트를 계속할 수 없습니다.")


def perform_update(install_dir, manifest_url, current_pid=0, restart_path=None, status=None):
    status = status or (lambda _message: None)
    manifest = exe_update.fetch_manifest(manifest_url)
    with tempfile.TemporaryDirectory(prefix="naim-update-") as tmpdir:
        archive = Path(tmpdir, "update.zip")
        stage = Path(tmpdir, "stage")
        status("업데이트 파일을 다운로드하는 중입니다...")
        download_file(manifest["asset_url"], archive)
        status("다운로드 파일을 검증하는 중입니다...")
        verify_archive(archive, manifest["sha256"], manifest["size"])
        payload = safe_extract(archive, stage, manifest["payload_root"])
        status("프로그램 종료를 기다리는 중입니다...")
        wait_for_process(current_pid)
        status("프로그램 파일을 교체하는 중입니다...")
        apply_staged_update(payload, install_dir)
    if restart_path and Path(restart_path).is_file():
        subprocess.Popen([str(restart_path)], cwd=str(install_dir))
    return manifest


def _run_gui(args):
    import tkinter as tk
    from tkinter import messagebox

    root = tk.Tk()
    root.title("NAI Image Manager 업데이트")
    root.geometry("480x170")
    root.resizable(False, False)
    label = tk.Label(root, text="업데이트를 준비하는 중입니다...", wraplength=430, font=("Malgun Gothic", 10))
    label.pack(expand=True, padx=20, pady=20)
    root.protocol("WM_DELETE_WINDOW", lambda: None)

    def set_status(message):
        root.after(0, lambda: label.config(text=message))

    def worker():
        try:
            manifest = perform_update(
                Path(args.install_dir),
                args.manifest_url,
                current_pid=args.pid,
                restart_path=args.restart,
                status=set_status,
            )
        except Exception as exc:
            root.after(0, lambda: (messagebox.showerror("업데이트 실패", str(exc)), root.destroy()))
            return
        root.after(
            0,
            lambda: (
                messagebox.showinfo("업데이트 완료", f"v{manifest['version']} 업데이트를 설치했습니다."),
                root.destroy(),
            ),
        )

    threading.Thread(target=worker, daemon=True).start()
    root.mainloop()


def _default_app_dir():
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def _parse_args(argv=None):
    parser = argparse.ArgumentParser(description="NAI Image Manager updater")
    parser.add_argument("--install-dir")
    parser.add_argument("--pid", type=int, default=0)
    parser.add_argument("--restart")
    parser.add_argument("--manifest-url", default=exe_update.MANIFEST_URL)
    parser.add_argument("--worker", action="store_true")
    args = parser.parse_args(argv)
    base = Path(args.install_dir).resolve() if args.install_dir else _default_app_dir()
    args.install_dir = str(base)
    args.restart = args.restart or str(base / "NAI_Image_Manager.exe")
    return args


def _launch_temporary_worker(args):
    temp_dir = Path(tempfile.mkdtemp(prefix="naim-updater-"))
    worker_exe = temp_dir / "NAIM_Updater.exe"
    shutil.copy2(sys.executable, worker_exe)
    command = [
        str(worker_exe),
        "--worker",
        "--install-dir",
        args.install_dir,
        "--pid",
        str(args.pid),
        "--restart",
        args.restart,
        "--manifest-url",
        args.manifest_url,
    ]
    subprocess.Popen(command, cwd=args.install_dir)


def main(argv=None):
    args = _parse_args(argv)
    if getattr(sys, "frozen", False) and not args.worker:
        _launch_temporary_worker(args)
        return
    _run_gui(args)


if __name__ == "__main__":
    main()
