# -*- mode: python ; coding: utf-8 -*-

from PyInstaller.utils.hooks import collect_submodules, collect_all
from importlib.metadata import version
from importlib.util import find_spec
from pathlib import Path

playwright_datas, playwright_binaries, playwright_imports = collect_all('playwright')
pyvips_spec = find_spec('pyvips')
vips_extension = find_spec('_libvips')
if pyvips_spec is None or vips_extension is None:
    raise RuntimeError(
        'The main EXE requires pyvips==3.2.0 and pyvips-binary==8.18.7. '
        'Install requirements-canvas-tiles.txt in the build environment.'
    )

import pyvips

if pyvips.__version__ != '3.2.0':
    raise RuntimeError(f'Expected pyvips 3.2.0, found {pyvips.__version__}.')
if version('pyvips-binary') != '8.18.7':
    raise RuntimeError(f"Expected pyvips-binary 8.18.7, found {version('pyvips-binary')}.")
if tuple(pyvips.version(part) for part in range(3)) != (8, 18, 7):
    raise RuntimeError('pyvips-binary metadata does not match the loaded libvips runtime.')

vips_datas, vips_binaries, vips_imports = collect_all('pyvips')
vips_imports += ['_libvips', '_cffi_backend']
vips_dlls = list(Path(vips_extension.origin).parent.glob('libvips-42*.dll'))
if not vips_dlls:
    raise RuntimeError('The pyvips-binary libvips DLL was not found beside _libvips.')
vips_binaries += [(str(path), '.') for path in vips_dlls]


datas = [
    ("style_workspace.html", "."),
    ("naim/style_manager/templates", "naim/style_manager/templates"),
    ("naim/style_manager/static", "naim/style_manager/static"),
    ("naim/style_manager/arca_style_seed.sqlite", "naim/style_manager"),
    ("naim/style_manager/arca_image_archive_legacy.json", "naim/style_manager"),
    ("index.html", "."),
    ("canvas.html", "."),
    ("legacy_generation.html", "."),
    ("static", "static"),
    ("assets/app_icon.png", "assets"),
    ("assets/app_icon.ico", "assets"),
    ("data/danbooru_tags.sqlite3", "data"),
    ("data/tag_categories_ko.generated.json", "data"),
    ("data/shared_style_artists.json", "data"),
    ("data/shared_style_post_dates.json", "data"),
    ("data/daki_dictionary", "data/daki_dictionary"),
    ("data/prompt_tags", "data/prompt_tags"),
    ("tools", "tools"),
    ("naim/upscale_worker.py", "naim"),
    ("danbooru_tags.db", "."),
]


a = Analysis(
    ["main_executor.pyw"],
    pathex=[],
    binaries=playwright_binaries + vips_binaries,
    datas=datas + playwright_datas + vips_datas,
    hiddenimports=collect_submodules("PIL") + playwright_imports + vips_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "basicsr",
        "cv2",
        "facexlib",
        "fastapi",
        "google",
        "google_genai",
        "huggingface_hub",
        "llvmlite",
        "lmdb",
        "matplotlib",
        "numba",
        "pydantic",
        "realesrgan",
        "safetensors",
        "scipy",
        "starlette",
        "tokenizers",
        "torch",
        "torchvision",
        "tqdm",
        "transformers",
        "typer",
        "uvicorn",
    ],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="NAI_Image_Manager",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    icon="assets/app_icon.ico",
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    contents_directory=".",
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="NAI_Image_Manager",
)
