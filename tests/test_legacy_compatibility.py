import base64
from contextlib import closing
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

from PIL import Image
import app
import naim_updater
from utils import HistoryDB


class LegacyCompatibilityTests(unittest.TestCase):
    def test_update_preserves_existing_settings_images_and_database_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            install, payload = Path(temp) / 'install', Path(temp) / 'payload'
            install.mkdir()
            payload.mkdir()
            fixtures = {}
            for filename in naim_updater.PROTECTED_FILES:
                fixtures[filename] = b'{"legacy_unknown": [1, 2, 3]}'
            for folder in ('TOTAL_CLASSIFIED/group', 'TOTAL_CLASSIFIED/_TRASH', 'canvas_imports', 'output'):
                fixtures[f'{folder}/sample.png'] = b'synthetic-image-bytes'
                fixtures[f'{folder}/sample.json'] = b'{"base_prompt":"test"}'
            for relative, data in fixtures.items():
                path = install / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            db_path = install / 'TOTAL_CLASSIFIED/naia_history.db'
            with closing(sqlite3.connect(db_path)) as db:
                with db:
                    db.execute('CREATE TABLE legacy_extension (value TEXT)')
                    db.execute("INSERT INTO legacy_extension VALUES ('keep')")
            fixtures['TOTAL_CLASSIFIED/naia_history.db'] = db_path.read_bytes()
            (install / 'app.bin').write_bytes(b'old-runtime')
            (payload / 'app.bin').write_bytes(b'new-runtime')
            (payload / 'static').mkdir()
            (payload / 'static/canvas_clipboard.js').write_bytes(b'new-module')
            for root, files in ((install, ['app.bin']), (payload, ['app.bin', 'static/canvas_clipboard.js'])):
                (root / naim_updater.MANAGED_MANIFEST).write_text(json.dumps({'files': files}), encoding='utf-8')
            naim_updater.apply_staged_update(payload, install)
            for relative, original in fixtures.items():
                self.assertEqual((install / relative).read_bytes(), original, relative)
            history = HistoryDB(db_path)
            try:
                self.assertEqual(history.conn.execute('SELECT value FROM legacy_extension').fetchone(), ('keep',))
            finally:
                history.close()

    def test_lab_update_preserves_unknown_keys_and_recovers_corrupt_config(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'lab_config.json'
            client = app.app.test_client()
            with mock.patch.object(app, 'CONFIG_FILE', str(path)):
                path.write_text('{"legacy_extra":{"x":1}}', encoding='utf-8')
                self.assertEqual(client.post('/api/lab/config', json={'steps': 28}).status_code, 200)
                self.assertEqual(client.get('/api/lab/config').json, {'legacy_extra': {'x': 1}, 'steps': 28})
                path.write_bytes(b'{damaged')
                self.assertEqual(client.get('/api/lab/config').json, {})
                self.assertEqual(next(Path(temp).glob('*.bak')).read_bytes(), b'{damaged')

    def test_saved_image_sidecar_keeps_prompts_without_copying_credential(self):
        with tempfile.TemporaryDirectory() as temp:
            data = io.BytesIO()
            Image.new('RGB', (4, 4)).save(data, format='PNG')
            with mock.patch.object(app, 'OUTPUT_DIR', temp):
                response = app.app.test_client().post('/api/save', json={
                    'image': base64.b64encode(data.getvalue()).decode(),
                    'key': 'synthetic-not-a-credential',
                    'base_prompt': 'test', 'char_prompt': 'character', 'negative_prompt': 'negative',
                })
            self.assertEqual(response.status_code, 200)
            saved = json.loads(next(Path(temp).glob('*.json')).read_text(encoding='utf-8'))
            self.assertNotIn('api_key', saved)
            self.assertEqual(saved['base_prompt'], 'test')
            self.assertEqual(saved['negative_prompt'], 'negative')
