"""Exercise installed local engines using synthetic pixels, never user images."""
import sys
from pathlib import Path
import tempfile
import threading

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from PIL import Image
import upscale_logic


def main():
    with tempfile.TemporaryDirectory(prefix='naim-engine-test-') as temporary:
        root = Path(temporary)
        source = root / 'source.png'
        Image.new('RGB', (32, 48), (40, 100, 180)).save(source)
        for engine in ('lanczos', 'realcugan', 'waifu2x'):
            cancel = threading.Event()
            timer = threading.Timer(45, cancel.set)
            timer.start()
            try:
                target = root / (engine + '.png')
                upscale_logic.run_upscale(str(source), str(target), 64, 96,
                                          engine=engine, quality='fast', cancel_event=cancel)
                with Image.open(target) as result:
                    assert result.size == (64, 96)
                print(engine + ': real engine output verified', flush=True)
            finally:
                timer.cancel()
                timer.join()
        Image.new('RGB', (1024, 1024), (30, 60, 90)).save(source)
        for engine in ('realcugan', 'waifu2x'):
            cancel = threading.Event()
            timer = threading.Timer(0.2, cancel.set)
            timer.start()
            try:
                try:
                    upscale_logic.run_upscale(str(source), str(root / 'cancel.png'), 4096, 4096,
                                              engine=engine, quality='high', cancel_event=cancel)
                except upscale_logic.UpscaleCancelled:
                    print(engine + ': cancellation verified', flush=True)
                else:
                    raise AssertionError(engine + ': finished before cancellation could be tested')
            finally:
                timer.cancel()
                timer.join()


if __name__ == '__main__':
    main()
