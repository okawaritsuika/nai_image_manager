# -*- mode: python ; coding: utf-8 -*-

from PyInstaller.utils.hooks import collect_submodules


datas = [
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
    ("tools", "tools"),
    ("naim/upscale_worker.py", "naim"),
    ("danbooru_tags.db", "."),
]


a = Analysis(
    ["main_executor.pyw"],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=collect_submodules("PIL"),
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
