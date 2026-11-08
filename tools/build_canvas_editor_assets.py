"""Bundle the same retouch algorithms used by Flask for the local editor worker."""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'static' / 'canvas_editor' / 'engine.zip'
SOURCES = ('retouch.py', 'retouch_working.py')


if __name__ == '__main__':
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(OUTPUT, 'w') as bundle:
        for name in SOURCES:
            contents = (ROOT / 'naim' / 'images' / name).read_bytes()
            bundle.writestr(ZipInfo(name), contents, compress_type=ZIP_DEFLATED)
