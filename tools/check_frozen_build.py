"""Build the real EXE spec against synthetic data and smoke-test its server.

This checks bundled imports/assets and portable settings, not AI/native engines
or a production release payload. No live settings, databases or images are used.
"""
from contextlib import closing
import argparse
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

from run_isolated_tests import copy_source


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=5000)
    port = parser.parse_args().port
    # An alternate port changes only the temporary test copy.
    # Never stop an existing program to obtain it.
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', port))
    with tempfile.TemporaryDirectory(prefix='naim-frozen-test-') as temporary:
        root = Path(temporary)
        copy_source(Path(__file__).resolve().parents[1], root)
        if port != 5000:
            server_source = root / 'app.py'
            original = server_source.read_text(encoding='utf-8')
            assert original.count('port=5000,') == 1
            server_source.write_text(original.replace('port=5000,', f'port={port},'), encoding='utf-8')
        (root / 'data').mkdir(exist_ok=True)
        (root / 'tools').mkdir(exist_ok=True)
        (root / 'tools/synthetic.txt').write_text('No engines in packaging smoke test.')
        (root / 'data/tag_categories_ko.generated.json').write_text('{}')
        for path in (root / 'danbooru_tags.db', root / 'data/danbooru_tags.sqlite3'):
            with closing(sqlite3.connect(path)) as db:
                db.execute('CREATE TABLE tags (name TEXT, category INTEGER, post_count INTEGER)')
                db.commit()
        nonce = uuid.uuid4().hex
        (root / 'static' / f'{nonce}.txt').write_text(nonce)
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1', PYTHONIOENCODING='utf-8')
        env.pop('PYTHONPATH', None)
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
        env['NAIM_SERVER_CONTROL_TOKEN'] = uuid.uuid4().hex
        process = subprocess.Popen(
            [str(install / 'NAI_Image_Manager.exe'), '--server'], cwd=install, env=env,
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
            for url in ('/canvas', '/legacy-generation', '/style-lab', '/daki-workshop',
                        '/static/gallery_catalog.js', '/static/gallery_recycling.js',
                        '/static/gallery_layout.js', '/static/gallery_modern.css',
                        '/static/canvas_autosave.js', '/static/canvas_dialogs.js',
                        '/static/legacy_generation.js', '/static/legacy_generation.css',
                        '/static/canvas_clipboard.js', '/static/canvas_reference.js', '/static/canvas_setups.js',
                        '/static/gallery_dates.js', '/static/gallery_selection.js', '/static/gallery_managers.js',
                        '/static/gallery_rules.js', '/static/gallery_inpaint.js', '/static/gallery_upscale.js',
                        '/static/upscale_models.js', '/static/upscale_models.css'):
                with urllib.request.urlopen(f'http://127.0.0.1:{port}' + url, timeout=5) as response:
                    assert response.status == 200, url
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
                headers={'Content-Type': 'application/json', 'X-NAIM-Control': env['NAIM_SERVER_CONTROL_TOKEN']},
            )
            with urllib.request.urlopen(shutdown, timeout=10) as response:
                assert json.load(response)['stopped'] is True
            print('FROZEN_BUILD_OK: both EXEs built; packaged server, scripts, portable settings and job shutdown verified.', flush=True)
        finally:
            process.terminate()
            process.wait(timeout=10)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
