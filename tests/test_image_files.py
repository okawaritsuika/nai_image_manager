from pathlib import Path
import tempfile
import unittest
from unittest import mock
import io

from PIL import Image
import app

from naim.storage import image_files


class ImageFilesTests(unittest.TestCase):
    def test_overwrite_endpoint_does_not_change_original_when_sidecar_save_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / 'source.png'
            Image.new('RGB', (8, 8), 'white').save(target)
            app.save_prompt_sidecar(str(target), {'basePrompt': 'synthetic original'})
            originals = {p: p.read_bytes() for p in (target, target.with_suffix('.json'))}
            pixels = io.BytesIO()
            Image.new('RGB', (8, 8), 'black').save(pixels, 'PNG')
            with mock.patch.object(app, 'CLASSIFIED_DIR', temp), \
                 mock.patch.object(app, 'read_canvas_image_bytes', return_value=pixels.getvalue()), \
                 mock.patch.object(app, 'save_prompt_sidecar', side_effect=OSError('synthetic full disk')):
                response = app.app.test_client().post('/api/gallery/overwrite_image', json={
                    'source_image': 'synthetic', 'target_path': 'source.png',
                })
            self.assertEqual(response.status_code, 500)
            for path, original in originals.items():
                self.assertEqual(path.read_bytes(), original)

    def test_sidecar_publish_failure_restores_original_image_and_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            image = Path(temp) / 'image.png'
            sidecar = image.with_suffix('.json')
            image.write_bytes(b'original-image')
            sidecar.write_bytes(b'original-metadata')
            replace = image_files.os.replace

            def fail_sidecar(source, target):
                if Path(target) == sidecar:
                    raise OSError('synthetic locked sidecar')
                return replace(source, target)

            with mock.patch.object(image_files.os, 'replace', side_effect=fail_sidecar):
                with self.assertRaises(OSError):
                    with image_files.staged_image_bundle(image) as staged:
                        Path(staged).write_bytes(b'new-image')
                        Path(staged).with_suffix('.json').write_bytes(b'new-metadata')
            self.assertEqual(image.read_bytes(), b'original-image')
            self.assertEqual(sidecar.read_bytes(), b'original-metadata')
            self.assertEqual(len(list(Path(temp).iterdir())), 2)

    def test_failed_preparation_leaves_original_and_cleans_staging(self):
        with tempfile.TemporaryDirectory() as temp:
            image = Path(temp) / 'image.png'
            image.write_bytes(b'original')
            with self.assertRaises(OSError):
                with image_files.staged_image_bundle(image) as staged:
                    Path(staged).write_bytes(b'partial')
                    raise OSError('synthetic full disk')
            self.assertEqual(image.read_bytes(), b'original')
            self.assertEqual(list(Path(temp).iterdir()), [image])

    def test_rollback_failure_retains_original_backup(self):
        with tempfile.TemporaryDirectory() as temp:
            image = Path(temp) / 'image.png'
            image.write_bytes(b'original')
            replace, copy = image_files.os.replace, image_files.shutil.copy2

            def fail_replace(source, target):
                if Path(target).suffix == '.json':
                    raise OSError('publish failure')
                return replace(source, target)

            def fail_restore(source, target):
                if Path(source).name.startswith('backup-'):
                    raise OSError('restore failure')
                return copy(source, target)

            with mock.patch.object(image_files.os, 'replace', side_effect=fail_replace), \
                 mock.patch.object(image_files.shutil, 'copy2', side_effect=fail_restore):
                with self.assertRaises(RuntimeError):
                    with image_files.staged_image_bundle(image) as staged:
                        Path(staged).write_bytes(b'new')
                        Path(staged).with_suffix('.json').write_bytes(b'new')
            self.assertEqual(next(Path(temp).glob('.naim-image-*/backup-image.png')).read_bytes(), b'original')
