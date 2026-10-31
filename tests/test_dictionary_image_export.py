"""Portable dictionary image export tests use synthetic WebP and SQLite data."""
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import random
import sqlite3
import tempfile
import unittest
import zipfile
from contextlib import closing

from PIL import Image
from PIL.PngImagePlugin import PngInfo

from naim.daki_dictionary_images import extract_prompt
from naim.images.webp_conversion import convert_png_to_webp
from naim.daki_dictionary_pack_format import ARCHIVE, FORMAT, INDEX, MANIFEST
from tools.export_dictionary_image_pack import export_dictionary_image_pack


class DictionaryImagePackExportTests(unittest.TestCase):
    def setUp(self):
        temporary_root = os.environ.get('TEMP') or os.environ.get('TMP')
        self.temporary = tempfile.TemporaryDirectory(dir=temporary_root)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.data_directory = self.root / 'dictionary-data'
        self.data_directory.mkdir()
        self.source_root = self.data_directory / 'images_webp_q90'
        self.source_root.mkdir()
        self.database = self.data_directory / 'image_catalog.sqlite3'
        self.records = {}
        self._create_webp(700006, 'synthetic positive', 'synthetic negative')
        self._create_webp(37, 'synthetic second positive', 'synthetic second negative')
        self._create_database()
        self.output = self.root / 'portable-pack'

    def _create_webp(self, identifier, prompt, negative):
        png_path = self.root / 'fixtures' / f'{identifier}.png'
        png_path.parent.mkdir(exist_ok=True)
        info = PngInfo()
        info.add_text('Comment', json.dumps({'prompt': prompt, 'uc': negative}))
        pixels = random.Random(identifier).randbytes(96 * 64 * 3)
        Image.frombytes('RGB', (96, 64), pixels).save(png_path, pnginfo=info)
        fixture_webp = png_path.with_suffix('.webp')
        if fixture_webp.exists():
            fixture_webp.unlink()
        result = convert_png_to_webp(png_path, lossless=False, quality=90, keep_original=True)
        self.assertEqual(result.get('status'), 'converted')
        webp_path = self.source_root / 'nested' / f'opaque-source-name-{identifier}.webp'
        webp_path.parent.mkdir(exist_ok=True)
        webp_path.write_bytes(png_path.with_suffix('.webp').read_bytes())
        with Image.open(webp_path) as image:
            image.load()
            metadata = extract_prompt(image)
        self.assertEqual(metadata, (prompt, negative, 'Comment'))
        stat_result = webp_path.stat()
        self.records[identifier] = {
            'path': webp_path.resolve(), 'bytes': webp_path.read_bytes(),
            'width': 96, 'height': 64, 'mtime': stat_result.st_mtime_ns,
            'size': stat_result.st_size, 'prompt': prompt, 'negative': negative,
            'source': 'Comment',
        }

    def _create_database(self):
        with sqlite3.connect(self.database) as connection:
            connection.executescript('''
                CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
                CREATE TABLE images(id INTEGER PRIMARY KEY,path TEXT UNIQUE NOT NULL,
                    mtime INTEGER,size INTEGER,width INTEGER,height INTEGER,prompt TEXT,
                    negative TEXT,source TEXT,tags TEXT,status TEXT);
                CREATE TABLE image_tags(image_id INTEGER,tag TEXT,PRIMARY KEY(image_id,tag));
            ''')
            connection.executemany('INSERT INTO settings VALUES(?,?)', [
                ('folder', str(self.source_root.resolve())),
                ('synthetic-extra-setting', 'keep-local'),
            ])
            for identifier, record in self.records.items():
                connection.execute('''INSERT INTO images
                    (id,path,mtime,size,width,height,prompt,negative,source,tags,status)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?)''', (
                    identifier, str(record['path']), record['mtime'], record['size'],
                    record['width'], record['height'], record['prompt'], record['negative'],
                    record['source'], '["synthetic-local-edit"]', 'indexed',
                ))
                connection.execute('INSERT INTO image_tags VALUES(?,?)',
                                   (identifier, 'synthetic-local-edit'))

    def _snapshot(self):
        with closing(sqlite3.connect(self.database)) as connection:
            settings = tuple(connection.execute('SELECT key,value FROM settings ORDER BY key'))
            images = tuple(connection.execute('''SELECT id,path,mtime,size,width,height,prompt,
                negative,source,tags,status FROM images ORDER BY id'''))
            tags = tuple(connection.execute(
                'SELECT image_id,tag FROM image_tags ORDER BY image_id,tag'))
            return settings, images, tags

    def test_exports_only_id_named_webps_and_stable_public_metadata(self):
        original_snapshot = self._snapshot()
        source_bytes = {identifier: record['bytes'] for identifier, record in self.records.items()}

        manifest = export_dictionary_image_pack(self.data_directory, self.output)

        self.assertEqual(set(manifest), {
            'format', 'version', 'filename', 'bytes', 'sha256', 'image_count',
            'image_bytes', 'index_sha256', 'quality',
        })
        self.assertEqual(manifest['format'], FORMAT)
        self.assertEqual(manifest['filename'], ARCHIVE)
        self.assertEqual(manifest['image_count'], len(self.records))
        archive_path = self.output / ARCHIVE
        self.assertEqual(archive_path.stat().st_size, manifest['bytes'])
        self.assertEqual(hashlib.sha256(archive_path.read_bytes()).hexdigest(), manifest['sha256'])

        manifest_bytes = (self.output / MANIFEST).read_bytes()
        self.assertEqual(json.loads(manifest_bytes), manifest)
        with zipfile.ZipFile(archive_path) as archive:
            expected_names = ['images/000037.webp', 'images/700006.webp', INDEX]
            self.assertEqual(archive.namelist(), expected_names)
            self.assertTrue(all(item.compress_type == zipfile.ZIP_STORED for item in archive.infolist()))
            index_bytes = archive.read(INDEX)
            index = json.loads(index_bytes)
            self.assertEqual(hashlib.sha256(index_bytes).hexdigest(), manifest['index_sha256'])
            self.assertEqual(set(index), {'format', 'version', 'images'})
            self.assertEqual(index['format'], FORMAT)
            self.assertEqual([item['id'] for item in index['images']], [37, 700006])
            self.assertEqual(set(index['images'][0]), {'id', 'file', 'bytes', 'sha256', 'width', 'height'})
            self.assertNotIn('path', index_bytes.decode('utf-8'))
            self.assertNotIn('prompt', index_bytes.decode('utf-8'))
            self.assertNotIn('negative', index_bytes.decode('utf-8'))
            self.assertNotIn('synthetic-local-edit', archive.read(INDEX).decode('utf-8'))

            for item in index['images']:
                packed = archive.read(item['file'])
                original = source_bytes[item['id']]
                self.assertEqual(packed, original)
                self.assertEqual(item['bytes'], len(original))
                self.assertEqual(item['sha256'], hashlib.sha256(original).hexdigest())
                with Image.open(BytesIO(packed)) as image:
                    image.load()
                    self.assertEqual(image.format, 'WEBP')
                    self.assertEqual((image.width, image.height), (item['width'], item['height']))
                    self.assertEqual(extract_prompt(image), (
                        self.records[item['id']]['prompt'], self.records[item['id']]['negative'], 'Comment'))

        self.assertEqual(self._snapshot(), original_snapshot)
        for identifier, record in self.records.items():
            self.assertEqual(record['path'].read_bytes(), source_bytes[identifier])

    def test_refuses_existing_output_directory_or_file_without_overwriting(self):
        self.output.mkdir()
        sentinel = self.output / 'keep.txt'
        sentinel.write_bytes(b'keep')
        with self.assertRaises(ValueError):
            export_dictionary_image_pack(self.data_directory, self.output)
        self.assertEqual(sentinel.read_bytes(), b'keep')

        existing_file = self.root / 'existing-output-file'
        existing_file.write_bytes(b'preserve')
        with self.assertRaises(ValueError):
            export_dictionary_image_pack(self.data_directory, existing_file)
        self.assertEqual(existing_file.read_bytes(), b'preserve')

    def test_rejects_missing_and_non_webp_source_files(self):
        missing = self.records[37]['path']
        missing.unlink()
        with self.assertRaises(ValueError):
            export_dictionary_image_pack(self.data_directory, self.output)
        self.assertFalse(self.output.exists())

        missing.write_bytes(self.records[37]['bytes'])
        record = self.records[37]
        record['mtime'] = missing.stat().st_mtime_ns
        record['size'] = missing.stat().st_size
        with sqlite3.connect(self.database) as connection:
            connection.execute('UPDATE images SET mtime=?,size=? WHERE id=37',
                               (record['mtime'], record['size']))
        png_path = record['path'].with_suffix('.png')
        record['path'].rename(png_path)
        with sqlite3.connect(self.database) as connection:
            connection.execute('UPDATE images SET path=? WHERE id=37', (str(png_path),))
        with self.assertRaises(ValueError):
            export_dictionary_image_pack(self.data_directory, self.output)
        self.assertFalse(self.output.exists())

    def test_rejects_unsafe_or_duplicate_ids_and_duplicate_paths(self):
        with sqlite3.connect(self.database) as connection:
            connection.execute('UPDATE images SET id=0 WHERE id=37')
        with self.assertRaises(ValueError):
            export_dictionary_image_pack(self.data_directory, self.output)

        with sqlite3.connect(self.database) as connection:
            connection.execute('UPDATE images SET id=37 WHERE id=0')
            connection.execute('ALTER TABLE images RENAME TO previous_images')
            connection.execute('''CREATE TABLE images(id,path,mtime,size,width,height,prompt,
                negative,source,tags,status)''')
            rows = list(connection.execute('''SELECT id,path,mtime,size,width,height,prompt,
                negative,source,tags,status FROM previous_images ORDER BY id'''))
            duplicate_path_rows = [list(row) for row in rows]
            duplicate_path_rows[1][1] = duplicate_path_rows[0][1]
            connection.executemany('INSERT INTO images VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                                   duplicate_path_rows)
            connection.execute('DROP TABLE previous_images')
        with self.assertRaises(ValueError):
            export_dictionary_image_pack(self.data_directory, self.output)

        with sqlite3.connect(self.database) as connection:
            connection.execute('UPDATE images SET id=37 WHERE id=700006')
        with self.assertRaises(ValueError):
            export_dictionary_image_pack(self.data_directory, self.output)

    def test_rejects_stale_file_metadata_or_prompt_index(self):
        source = self.records[37]['path']
        source.write_bytes(self.records[37]['bytes'] + b'changed')
        with self.assertRaises(ValueError):
            export_dictionary_image_pack(self.data_directory, self.output)
        self.assertFalse(self.output.exists())

    def test_rejects_webp_without_positive_prompt_before_creating_output(self):
        source = self.source_root / 'nested' / 'no-positive-prompt.webp'
        source.parent.mkdir(parents=True, exist_ok=True)
        Image.new('RGB', (96, 64), '#8090a0').save(source, format='WEBP', quality=90)
        stat_result = source.stat()
        with sqlite3.connect(self.database) as connection:
            connection.execute('''INSERT INTO images
                (id,path,mtime,size,width,height,prompt,negative,source,tags,status)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)''', (
                812, str(source.resolve()), stat_result.st_mtime_ns, stat_result.st_size,
                96, 64, '', '', '', '[]', 'no_prompt',
            ))

        with self.assertRaises(ValueError):
            export_dictionary_image_pack(self.data_directory, self.output)
        self.assertFalse(self.output.exists())

        source.write_bytes(self.records[37]['bytes'])
        record = self.records[37]
        record['mtime'] = source.stat().st_mtime_ns
        record['size'] = source.stat().st_size
        with sqlite3.connect(self.database) as connection:
            connection.execute('''UPDATE images SET mtime=?,size=?,prompt=? WHERE id=37''',
                               (record['mtime'], record['size'], 'stale synthetic prompt'))
        with self.assertRaises(ValueError):
            export_dictionary_image_pack(self.data_directory, self.output)
        self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
