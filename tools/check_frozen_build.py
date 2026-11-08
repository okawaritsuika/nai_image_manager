"""Build the real EXE spec against synthetic data and smoke-test its server.

This checks bundled imports/assets and portable settings, not AI/native engines
or a production release payload. No live settings, databases or images are used.
"""
from contextlib import closing, nullcontext
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from zipfile import ZipFile

from run_isolated_tests import copy_source


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=5000)
    parser.add_argument('--skip-legacy', action='store_true')
    parser.add_argument('--pyvips-path', help='Directory containing the pinned pyvips build modules.')
    parser.add_argument('--skip-browser', action='store_true')
    parser.add_argument('--keep-temp', action='store_true', help='Keep the unique disposable stage directory for diagnostics.')
    parser.add_argument('--stage-dir', help='Use a new, explicit staging directory; it must not already exist.')
    options = parser.parse_args()
    port = options.port
    source_root = Path(__file__).resolve().parents[1]
    # An alternate port changes only the temporary test copy.
    # Never stop an existing program to obtain it.
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', port))
    stage_parent = source_root / 'build'
    stage_parent.mkdir(exist_ok=True)
    if options.stage_dir:
        stage_dir = Path(options.stage_dir).resolve()
        if stage_dir.exists():
            raise FileExistsError(f'Refusing to reuse a staging directory: {stage_dir}')
        stage_dir.mkdir(parents=True)
        temporary_context = nullcontext(str(stage_dir))
    elif options.keep_temp:
        temporary_context = nullcontext(tempfile.mkdtemp(prefix='naim-frozen-test-', dir=stage_parent))
    else:
        temporary_context = tempfile.TemporaryDirectory(prefix='naim-frozen-test-', dir=stage_parent)
    with temporary_context as temporary:
        root = Path(temporary)
        if options.keep_temp:
            print(f'FROZEN_STAGE_DIR={root}', flush=True)
        copy_source(source_root, root)
        (root / 'data/prompt_tags').mkdir(parents=True, exist_ok=True)
        if port != 5000:
            server_source = root / 'app.py'
            original = server_source.read_text(encoding='utf-8')
            assert original.count('port=5000,') == 1
            server_source.write_text(original.replace('port=5000,', f'port={port},'), encoding='utf-8')
        server_source = root / 'app.py'
        diagnostic = "\n@app.errorhandler(Exception)\ndef frozen_smoke_error(error):\n    import traceback\n    from pathlib import Path\n    Path(get_app_dir(), 'frozen-smoke-error.txt').write_text(traceback.format_exc(), encoding='utf-8')\n    return 'Synthetic smoke failure', 500\n\n"
        server_source.write_text(server_source.read_text(encoding='utf-8').replace('def run_server():', diagnostic + 'def run_server():'), encoding='utf-8')
        (root / 'data').mkdir(exist_ok=True)
        dictionary = root / 'data/daki_dictionary'
        dictionary.mkdir()
        (dictionary / 'dictionary.json').write_text(json.dumps({
            'source': {'rows': 1, 'unique_tags': 1}, 'categories': [],
            'tags': [{'tag': 'smile', 'ko': '미소', 'description': '',
                      'categories': ['표정/웃음'], 'count': 1, 'translation_source': 'synthetic'}],
        }), encoding='utf-8')
        (dictionary / 'source_combinations.json').write_text(json.dumps([
            {'id': 1, 'general': 'smile', 'rating': 'g'},
        ]), encoding='utf-8')
        (root / 'tools').mkdir(exist_ok=True)
        (root / 'tools/synthetic.txt').write_text('No engines in packaging smoke test.')
        (root / 'data/tag_categories_ko.generated.json').write_text('{}')
        for path in (root / 'danbooru_tags.db', root / 'data/danbooru_tags.sqlite3'):
            with closing(sqlite3.connect(path)) as db:
                db.execute('CREATE TABLE tags (name TEXT, category INTEGER, post_count INTEGER)')
                db.execute('CREATE TABLE danbooru_tags (name TEXT, category INTEGER, post_count INTEGER)')
                db.commit()
        nonce = uuid.uuid4().hex
        (root / 'static' / f'{nonce}.txt').write_text(nonce)
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1', PYTHONIOENCODING='utf-8')
        env.pop('PYTHONPATH', None)
        pyvips_path = Path(options.pyvips_path).resolve() if options.pyvips_path else source_root / '.qa' / 'editor-vips'
        if pyvips_path.is_dir():
            env['PYTHONPATH'] = str(pyvips_path)
        else:
            raise RuntimeError(f'Pinned pyvips modules not found: {pyvips_path}')

        # Regenerate the browser engine inside the disposable copy, so the EXE
        # stages exactly the retouch modules present in this source snapshot.
        result = subprocess.run(
            [sys.executable, '-B', 'tools/build_canvas_editor_assets.py'],
            cwd=root, env=env, capture_output=True, text=True,
        )
        if result.returncode:
            raise RuntimeError('Canvas worker asset build failed:\n' + result.stdout + result.stderr)
        for relative in (
            'static/canvas_editor_worker.js',
            'static/canvas_editor_engine.js',
            'static/canvas_editor_scene.js',
            'static/canvas_editor_view.js',
            'static/canvas_editor/brush.wasm',
            'static/canvas_editor/filter.wasm',
        ):
            stage_hash = hashlib.sha256((root / relative).read_bytes()).hexdigest()
            source_hash = hashlib.sha256((source_root / relative).read_bytes()).hexdigest()
            assert stage_hash == source_hash, f'staged canvas asset differs from project source: {relative}'

        # The test-only branch checks native DLL loading from the frozen EXE.
        # It is injected into the disposable source copy, never the app source.
        entrypoint = root / 'main_executor.pyw'
        original_entrypoint = entrypoint.read_text(encoding='utf-8')
        needle = 'APP_DIR = get_app_dir()\n'
        assert original_entrypoint.count(needle) == 1
        vips_smoke_branch = '''APP_DIR = get_app_dir()
if "--frozen-vips-smoke" in sys.argv:
    from pathlib import Path
    import json
    import traceback
    try:
        import pyvips
        png = pyvips.Image.black(16, 16, bands=4).write_to_buffer(".png")
        result = {
            "pyvips": pyvips.__version__,
            "libvips": [pyvips.version(part) for part in range(3)],
            "png_bytes": len(png),
            "png_signature": png[:8].hex(),
        }
        Path(APP_DIR, "frozen-vips-smoke.json").write_text(json.dumps(result), encoding="utf-8")
        sys.exit(0)
    except Exception:
        Path(APP_DIR, "frozen-vips-smoke-error.txt").write_text(traceback.format_exc(), encoding="utf-8")
        sys.exit(31)
'''
        entrypoint.write_text(original_entrypoint.replace(needle, vips_smoke_branch), encoding='utf-8')
        # Expose the browser-only accelerator state to this smoke test.
        # This instrumentation lives only in the disposable staging copy.
        worker_path = root / 'static/canvas_editor_worker.js'
        worker_source = worker_path.read_text(encoding='utf-8')
        source_worker_hash = hashlib.sha256(worker_path.read_bytes()).hexdigest()
        assert source_worker_hash == hashlib.sha256(
            (source_root / 'static/canvas_editor_worker.js').read_bytes()
        ).hexdigest(), 'staged worker source differs from the project source'
        warm_handler = """if (kind === 'warm') {
            self.postMessage({id, done: true});
            return;
        }"""
        diagnostic_handler = """if (kind === 'warm') {
            const nativeBlendLoaded = py.runPython('engine._native_normal_blend is not None');
            const nativeGaussianLoaded = py.runPython('engine._native_gaussian is not None');
            self.postMessage({id, done: true, nativeBlendLoaded, nativeGaussianLoaded});
            return;
        }"""
        assert worker_source.count(warm_handler) == 1
        worker_path.write_text(worker_source.replace(warm_handler, diagnostic_handler), encoding='utf-8')
        for spec in ('NAI_Image_Manager.spec', 'NAIM_Updater.spec'):
            print(f'Building {spec}', flush=True)
            with (root / 'build.log').open('w', encoding='utf-8') as log:
                result = subprocess.run(
                    [sys.executable, '-B', '-m', 'PyInstaller', '--noconfirm', spec],
                    cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT,
                )
            if result.returncode:
                print((root / 'build.log').read_text(encoding='utf-8')[-6000:])
                return result.returncode
        install = root / 'dist/NAI_Image_Manager'
        assert (install / 'naim/upscale_worker.py').is_file()
        assert not (install / 'upscale_models').exists()
        for relative in (
            'static/canvas_editor_worker.js',
            'static/canvas_editor_engine.js',
            'static/canvas_editor_scene.js',
            'static/canvas_editor_view.js',
            'static/canvas_editor/engine.zip',
            'static/canvas_editor/brush.wasm',
            'static/canvas_editor/filter.wasm',
            'static/vendor/pyodide/pyodide.js',
            'static/vendor/pyodide/pyodide.asm.wasm',
            'static/vendor/pyodide/numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl',
            'static/vendor/pyodide/pillow-11.3.0-cp313-cp313-pyodide_2025_0_wasm32.whl',
        ):
            assert (install / relative).is_file(), f'missing packaged worker asset: {relative}'
        with ZipFile(root / 'static/canvas_editor/engine.zip') as bundle:
            assert set(bundle.namelist()) == {'retouch.py', 'retouch_working.py'}
            for name in ('retouch.py', 'retouch_working.py'):
                assert bundle.read(name) == (root / 'naim/images' / name).read_bytes(), name
        canvas_asset_hashes = {}
        for relative in (
            'static/canvas_editor_worker.js',
            'static/canvas_editor_engine.js',
            'static/canvas_editor_scene.js',
            'static/canvas_editor_view.js',
            'static/canvas_editor/engine.zip',
            'static/canvas_editor/brush.wasm',
            'static/canvas_editor/filter.wasm',
        ):
            source_path = root / relative
            packaged_path = install / relative
            source_hash = hashlib.sha256(source_path.read_bytes()).hexdigest()
            packaged_hash = hashlib.sha256(packaged_path.read_bytes()).hexdigest()
            assert packaged_hash == source_hash, f'packaged canvas asset differs from staged source: {relative}'
            canvas_asset_hashes[Path(relative).name] = packaged_hash
        assert canvas_asset_hashes['canvas_editor_worker.js'] != source_worker_hash, (
            'test worker instrumentation was not included in the frozen smoke build'
        )
        print(
            'CANVAS_ASSET_HASHES_OK: '
            f"engine.zip={canvas_asset_hashes['engine.zip']}; "
            f"worker-smoke={canvas_asset_hashes['canvas_editor_worker.js']}; "
            f"worker-source={source_worker_hash}; "
            f"engine-js={canvas_asset_hashes['canvas_editor_engine.js']}; "
            f"scene-js={canvas_asset_hashes['canvas_editor_scene.js']}; "
            f"view-js={canvas_asset_hashes['canvas_editor_view.js']}; "
            f"brush.wasm={canvas_asset_hashes['brush.wasm']}; "
            f"filter.wasm={canvas_asset_hashes['filter.wasm']}",
            flush=True,
        )

        app_env = dict(env)
        app_env.pop('PYTHONPATH', None)
        vips_exe = install / 'NAI_Image_Manager.exe'
        smoke = subprocess.run([str(vips_exe), '--frozen-vips-smoke'], cwd=install, env=app_env, timeout=45)
        smoke_result = install / 'frozen-vips-smoke.json'
        if smoke.returncode or not smoke_result.is_file():
            error_path = install / 'frozen-vips-smoke-error.txt'
            details = error_path.read_text(encoding='utf-8') if error_path.is_file() else f'EXE exit code: {smoke.returncode}'
            raise RuntimeError('Frozen libvips smoke failed:\n' + details)
        vips_result = json.loads(smoke_result.read_text(encoding='utf-8'))
        assert (vips_result['pyvips'], vips_result['libvips']) == ('3.2.0', [8, 18, 7])
        assert vips_result['png_signature'] == '89504e470d0a1a0a' and vips_result['png_bytes'] > 64
        print('FROZEN_VIPS_OK: bundled pyvips and libvips encoded a PNG.', flush=True)

        browser = None
        playwright = None
        if not options.skip_browser:
            chrome_candidates = (
                Path(os.environ.get('PROGRAMFILES', 'C:/Program Files')) / 'Google/Chrome/Application/chrome.exe',
                Path(os.environ.get('PROGRAMFILES(X86)', 'C:/Program Files (x86)')) / 'Microsoft/Edge/Application/msedge.exe',
            )
            chrome_path = next((path for path in chrome_candidates if path.is_file()), None)
            if chrome_path:
                try:
                    from playwright.sync_api import sync_playwright
                    playwright = sync_playwright().start()
                    browser = playwright.chromium.launch(
                        executable_path=str(chrome_path), headless=True,
                        args=['--enable-gpu', '--use-angle=d3d11'],
                    )
                except Exception as error:
                    if playwright:
                        playwright.stop()
                    playwright = None
                    print(f'CHROMIUM_SKIPPED: {error}', flush=True)
            else:
                print('CHROMIUM_SKIPPED: Chrome/Edge executable not found.', flush=True)
        # Exercise real archived installations without running their launcher
        # or contacting the public update service. Only synthetic user data is
        # placed in these temporary copies.
        sys.path.insert(0, str(root))
        import naim_updater
        from naim.storage.legacy_import import import_installation
        managed = sorted(p.relative_to(install).as_posix() for p in install.rglob('*') if p.is_file())
        (install / naim_updater.MANAGED_MANIFEST).write_text(json.dumps({'files': managed}), encoding='utf-8')
        archives = sorted((Path(__file__).resolve().parents[1] / 'release_assets').rglob('*-exe_windows.zip'))
        payload = install
        if options.skip_legacy:
            archives = []
        for index, archive in enumerate(archives):
            legacy = naim_updater.safe_extract(archive, root / f'legacy-{index}', 'NAI_Image_Manager')
            fixtures = {
                'lab_config.json': b'{"legacy_extra":"preserved"}',
                'TOTAL_CLASSIFIED/group/sample.png': b'synthetic-image',
                'TOTAL_CLASSIFIED/group/sample.json': b'{"basePrompt":"synthetic"}',
                'TOTAL_CLASSIFIED/group/sample.txt': b'synthetic-classification',
                'artists.json': b'{"synthetic":"kept"}',
                'styles.json': b'{"synthetic":"kept"}',
                'daki_generated_temp/synthetic.png': b'synthetic-draft',
            }
            for relative, data in fixtures.items():
                path = legacy / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            database = legacy / 'TOTAL_CLASSIFIED/naia_history.db'
            with closing(sqlite3.connect(database)) as db:
                db.execute('CREATE TABLE IF NOT EXISTS legacy_extension (value TEXT)')
                db.execute("INSERT INTO legacy_extension VALUES ('preserved')")
                db.commit()
            fixtures['TOTAL_CLASSIFIED/naia_history.db'] = database.read_bytes()
            imported = root / f'imported-{index}'
            import_installation(legacy, imported)
            for relative, original in fixtures.items():
                if relative.endswith('.db'):
                    with closing(sqlite3.connect(imported / relative)) as db:
                        assert db.execute('SELECT value FROM legacy_extension').fetchone()[0] == 'preserved'
                else:
                    assert (imported / relative).read_bytes() == original, relative
                assert (legacy / relative).read_bytes() == original, relative
            print('LEGACY_IMPORT_OK: ' + archive.name, flush=True)
            naim_updater.apply_staged_update(payload, legacy)
            for relative, original in fixtures.items():
                assert (legacy / relative).read_bytes() == original, relative
            print('LEGACY_UPDATE_OK: ' + archive.name, flush=True)
            install = legacy
        settings = install / 'lab_config.json'
        settings.write_text('{"legacy_extra": "preserved"}', encoding='utf-8')
        app_env['NAIM_SERVER_CONTROL_TOKEN'] = uuid.uuid4().hex
        process = subprocess.Popen(
            [str(install / 'NAI_Image_Manager.exe'), '--server'], cwd=install, env=app_env,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
        try:
            deadline = time.monotonic() + 30
            while True:
                if process.poll() is not None:
                    raise RuntimeError('Packaged server exited before readiness')
                try:
                    with urllib.request.urlopen(f'http://127.0.0.1:{port}/static/{nonce}.txt', timeout=1) as response:
                        if response.read().decode() == nonce:
                            break
                except OSError:
                    pass
                if time.monotonic() > deadline:
                    raise RuntimeError('Packaged server readiness timeout')
                time.sleep(0.2)
            if browser:
                page = browser.new_page()
                page.goto(f'http://127.0.0.1:{port}/canvas', wait_until='domcontentloaded', timeout=30000)
                worker_result = page.evaluate('''() => new Promise((resolve, reject) => {
                    const worker = new Worker('/static/canvas_editor_worker.js?v=7');
                    const canvas = document.createElement('canvas');
                    canvas.width = 32; canvas.height = 24;
                    const context = canvas.getContext('2d');
                    context.fillStyle = 'rgb(24,80,120)'; context.fillRect(0, 0, 32, 24);
                    const source = canvas.toDataURL('image/png');
                    const sampleX = 8, sampleY = 8;
                    let pixelBytes = 0, samplePixel = null;
                    let nativeBlendLoaded = false, nativeGaussianLoaded = false;
                    const timer = setTimeout(() => { worker.terminate(); reject(new Error('worker render timed out')); }, 90000);
                    worker.onerror = event => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message || 'worker error')); };
                    worker.onmessage = ({data}) => {
                        if (data.error) { clearTimeout(timer); worker.terminate(); reject(new Error(data.error)); }
                        if (data.id === 1 && data.done) {
                            nativeBlendLoaded = data.nativeBlendLoaded === true;
                            nativeGaussianLoaded = data.nativeGaussianLoaded === true;
                            worker.postMessage({id: 2, kind: 'update', body: {
                                source, width: 32, height: 24, baseRevision: 0,
                                layers: [
                                    {id: 'smoke-blur', type: 'blur', params: {radius: 1.5},
                                        opacity: 1, mask: {base: 1, strokes: []}},
                                    {id: 'smoke-tone', type: 'tone', params: {brightness: 16},
                                        opacity: 0.37, mask: {base: 0, strokes: [{
                                            points: [[8, 8]], radius: 5, hardness: 1, opacity: 0.5,
                                        }]}}
                                ],
                            }});
                        } else if (data.id === 2) {
                            if (data.region && data.pixels) {
                                const pixels = new Uint8Array(data.pixels.buffer, data.pixels.byteOffset, data.pixels.byteLength);
                                pixelBytes += pixels.byteLength;
                                if (sampleX >= data.region.x && sampleX < data.region.x + data.region.width &&
                                    sampleY >= data.region.y && sampleY < data.region.y + data.region.height) {
                                    const offset = ((sampleY - data.region.y) * data.region.width + sampleX - data.region.x) * 4;
                                    samplePixel = Array.from(pixels.slice(offset, offset + 4));
                                }
                            }
                            if (data.done) {
                                clearTimeout(timer); worker.terminate();
                                resolve({revision: data.revision, pixelBytes, samplePixel,
                                    nativeBlendLoaded, nativeGaussianLoaded});
                            }
                        }
                    };
                    worker.postMessage({id: 1, kind: 'warm', body: {}});
                })''')
                assert worker_result['revision'] == 1 and worker_result['pixelBytes'] > 0
                assert worker_result['nativeBlendLoaded'], 'worker did not load the packaged normal blend kernel'
                assert worker_result['nativeGaussianLoaded'], 'worker did not bind filter.wasm gaussian_rgba'
                assert worker_result['samplePixel'] == [32, 88, 128, 255], worker_result
                renderer = page.evaluate('''() => {
                    const gl = document.createElement('canvas').getContext('webgl');
                    if (!gl) return 'WebGL unavailable';
                    const ext = gl.getExtension('WEBGL_debug_renderer_info');
                    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
                }''')
                print(f'CHROMIUM_RETOUCH_OK: {chrome_path}; renderer={renderer}; result={worker_result}', flush=True)
                page.close()
            for url in ('/canvas', '/legacy-generation', '/style-lab', '/daki-workshop',
                        '/static/gallery_catalog.js', '/static/gallery_recycling.js',
                        '/static/gallery_layout.js', '/static/gallery_modern.css',
                        '/static/canvas_autosave.js', '/static/canvas_dialogs.js',
                        '/static/legacy_generation.js', '/static/legacy_generation.css',
                        '/static/canvas_clipboard.js', '/static/canvas_reference.js', '/static/canvas_setups.js',
                        '/static/gallery_dates.js', '/static/gallery_selection.js', '/static/gallery_managers.js',
                        '/static/gallery_rules.js', '/static/gallery_inpaint.js', '/static/gallery_upscale.js',
                        '/static/upscale_models.js', '/static/upscale_models.css',
                        '/daki/dictionary', '/static/daki_dictionary.js',
                        '/static/daki_dictionary/app.js', '/static/daki_dictionary/styles.css'):
                with urllib.request.urlopen(f'http://127.0.0.1:{port}' + url, timeout=5) as response:
                    assert response.status == 200, url
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/daki/dictionary/health', timeout=5) as response:
                assert json.load(response)['tags'] == 1
            native_request = urllib.request.Request(
                f'http://127.0.0.1:{port}/api/style-workspace/connect', data=b'',
                headers={'X-NAIM-Workspace': '1'}, method='POST')
            with urllib.request.urlopen(native_request, timeout=90) as response:
                assert json.load(response)['url'] == '/style-workspace/?naim=1'
            for suffix in ('/?naim=1', '/static/naim_workspace.js', '/api/ratings',
                           '/api/naim-shared-library', '/api/confirmed-styles'):
                with urllib.request.urlopen(f'http://127.0.0.1:{port}/style-workspace' + suffix, timeout=60) as response:
                    assert response.status == 200, suffix
            assert not (install / 'style_workspace.local.json').exists()
            assert (install / 'data/style_manager/artist_rater.sqlite').is_file()
            assert not list(install.rglob('DanbooruArtistRater.exe'))
            print('NATIVE_STYLE_OK: bundled workspace, API, static assets and owned data work without an external application.', flush=True)
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/upscale/models', timeout=5) as response:
                assert {row['id'] for row in json.load(response)['models']} == {
                    'realcugan', 'waifu2x', 'illustrationjanai', 'animesharp'}
            preview = urllib.request.Request(
                f'http://127.0.0.1:{port}/api/upscale/nai/preview',
                data=b'{"width":640,"height":2048}', headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(preview, timeout=5) as response:
                plan = json.load(response)['plan']
                assert (plan['output_width'], plan['output_height']) == (1280, 4096)
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/lab/config', timeout=5) as response:
                assert json.load(response)['legacy_extra'] == 'preserved'
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/canvas/setups', timeout=5) as response:
                assert json.load(response)['allowLegacyMigration'] is False
            assert json.loads(settings.read_text()) == {'legacy_extra': 'preserved'}
            if archives:
                assert (install / 'daki_generated_temp/synthetic.png').read_bytes() == b'synthetic-draft'
            shutdown = urllib.request.Request(
                f'http://127.0.0.1:{port}/api/internal/shutdown_jobs',
                data=json.dumps({'pid': process.pid}).encode(),
                headers={'Content-Type': 'application/json', 'X-NAIM-Control': app_env['NAIM_SERVER_CONTROL_TOKEN']},
            )
            with urllib.request.urlopen(shutdown, timeout=10) as response:
                assert json.load(response)['stopped'] is True
            print('FROZEN_BUILD_OK: both EXEs built; packaged server, scripts, portable settings and job shutdown verified.', flush=True)
        except Exception:
            diagnostic = install / 'frozen-smoke-error.txt'
            if diagnostic.is_file():
                print(diagnostic.read_text(encoding='utf-8'), flush=True)
            raise
        finally:
            if browser:
                browser.close()
            if playwright:
                playwright.stop()
            process.terminate()
            process.wait(timeout=10)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
