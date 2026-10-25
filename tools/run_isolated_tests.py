"""Run regression tests against a temporary source copy, never live user data.

Some legacy modules create/clean runtime directories during import. Copy only
source files before importing them; copying an installation wholesale is unsafe.
"""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def copy_source(root, staging):
    for pattern in ("*.py", "*.pyw", "*.html", "*.spec"):
        for source in root.glob(pattern):
            shutil.copy2(source, staging / source.name)
    (staging / 'tools').mkdir(exist_ok=True)
    for source in (root / 'tools').glob('*.py'):
        shutil.copy2(source, staging / 'tools' / source.name)
    # Only committed application artwork; never copy user image directories.
    for name in ('app_icon.png', 'app_icon.ico'):
        source = root / 'assets' / name
        if source.is_file():
            (staging / 'assets').mkdir(exist_ok=True)
            shutil.copy2(source, staging / 'assets' / name)
    for name in ('shared_style_artists.json', 'shared_style_post_dates.json'):
        source = root / 'data' / name
        if source.is_file():
            (staging / 'data').mkdir(exist_ok=True)
            shutil.copy2(source, staging / 'data' / source.name)
    for folder in ("static", "tests", "naim"):
        source_root = root / folder
        if not source_root.is_dir():
            continue
        for source in source_root.rglob("*"):
            if source.is_file() and (source.suffix in {".py", ".js", ".css", ".html"}
                                    or source.relative_to(root).as_posix() == 'static/arca_session_bridge/manifest.json'):
                target = staging / source.relative_to(root)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)


def main():
    root = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="naim-tests-") as temporary:
        staging = Path(temporary)
        copy_source(root, staging)
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="utf-8")
        # Do not let an inherited PYTHONPATH import the live application.
        env.pop("PYTHONPATH", None)
        if sys.argv[1:2] == ["--serve"]:
            port = int(sys.argv[2]) if len(sys.argv) > 2 else 5127
            return subprocess.call(
                [sys.executable, "-B", "-c",
                 f"import app; app.app.run(host='127.0.0.1', port={port}, use_reloader=False)"],
                cwd=staging, env=env,
            )
        pattern = sys.argv[1] if len(sys.argv) > 1 else "test_*.py"
        return subprocess.call(
            [sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests", "-p", pattern],
            cwd=staging, env=env,
        )


if __name__ == "__main__":
    raise SystemExit(main())
