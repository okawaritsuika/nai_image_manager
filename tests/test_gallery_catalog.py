import ast
from pathlib import Path
import os
import sqlite3
import types
import unittest

from naim.gallery.catalog import gallery_rows, gallery_image_page


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(':memory:')
        self.addCleanup(self.conn.close)
        self.conn.execute('''CREATE TABLE gallery_images (
            rel_path TEXT PRIMARY KEY, folder_path TEXT, file_name TEXT, width INTEGER,
            height INTEGER, mtime REAL, reason TEXT, gallery_tag TEXT, model_family TEXT,
            ctime REAL, mode TEXT)''')
        self.conn.execute('CREATE INDEX folders ON gallery_images(folder_path)')

    def add(self, folder, name, mtime=1, mode='general', family='v5'):
        self.conn.execute('INSERT INTO gallery_images VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            (f'{folder}/{name}', folder, name, 1024, 1536, mtime, 'synthetic reason', 'tag-a', family, mtime + 1, mode))

    def builder(self, decorate=lambda *args: None):
        source = ast.parse((Path(__file__).resolve().parents[1] / 'app.py').read_text(encoding='utf-8-sig'))
        names = {'normalize_gallery_display_folder_path', 'build_gallery_data_payload_from_index'}
        module = ast.Module(body=[n for n in source.body if isinstance(n, ast.FunctionDef) and n.name in names], type_ignores=[])
        db = types.SimpleNamespace(conn=self.conn, ensure_gallery_image_creation_times=lambda _: None, close=lambda: None)
        ns = {'os': os, 'utils': types.SimpleNamespace(HistoryDB=lambda: db), 'CLASSIFIED_DIR': 'synthetic',
              'image_logic': types.SimpleNamespace(normalize_model_family_filter=lambda v: v, normalize_model_family=lambda v: v or 'other'),
              'load_gallery_image_tags_config': lambda: {'tags': [], 'image_tags': {}},
              'get_gallery_image_tag_for_path': lambda *args: '', 'decorate_comic_node': decorate,
              'build_gallery_brand_payload': lambda *args: ({}, {}), 'GALLERY_SERVER_SESSION_ID': 'synthetic'}
        exec(compile(module, '<catalog builder>', 'exec'), ns)
        return ns['build_gallery_data_payload_from_index']

    def test_catalog_matches_legacy_counts_thumbnails_modes_and_merged_rating_folders(self):
        for folder, mode in [('1_Solo/A', 'general'), ('_R-18/1_Solo/A', 'r18'), ('_R-15/1_Solo/B', 'r18'), ('_TRASH/1_Solo/A', 'trash')]:
            self.add(folder, 'new.png', 20, mode)
            self.add(folder, '000_MAIN_old.png', 10, mode)
            self.add(folder, 'other.png', 30, mode, 'other')
        self.add('1_Solo/A/child', 'child.png', 1)
        build = self.builder()
        def shape(node):
            return (node['name'], node.get('path'), node['total_images'], node['thumb'], [shape(c) for c in node['folders']])
        for mode in ('general', 'r18', 'all', 'trash'):
            for family in ('all', 'v5', 'other'):
                for sort in ('name', 'count'):
                    with self.subTest(mode=mode, family=family, sort=sort):
                        old = build(mode, sort, family)['tree']
                        new = build(mode, sort, family, summary_only=True)['tree']
                        self.assertEqual(shape(new), shape(old))

    def test_page_boundaries_preserve_original_metadata_and_literal_folder_names(self):
        folder = "1_Solo/한글_'_%"
        for i in range(1030): self.add(folder, f'{i:04}.png', i)
        self.add('1_Solo/else', 'else.png')
        actual, after, sizes = [], '', []
        while True:
            rows, after = gallery_image_page(self.conn, 'general', 'all', [folder], after, 999999)
            sizes.append(len(rows)); actual.extend(rows)
            if after is None: break
        expected = list(gallery_rows(self.conn, 'general', 'all'))[:-1]
        self.assertEqual(actual, expected)
        self.assertEqual(sizes, [512, 512, 6])
        self.assertEqual(len(list(gallery_rows(self.conn, 'general', summary=True))), 2)

    def test_comic_thumbnail_keeps_page_order_instead_of_latest_modified_time(self):
        self.add('1_Solo/Comic/book', '001.png', 1)
        self.add('1_Solo/Comic/book', '002.png', 20)
        build = self.builder(lambda node, *args: node.update(is_comic=True))
        for main in (False, True):
            if main:
                self.add('1_Solo/Comic/book', '000_MAIN_A.png', 1)
                self.add('1_Solo/Comic/book', '000_MAIN_B.png', 20)
            self.assertEqual(build('general', 'name')['tree']['thumb'],
                             build('general', 'name', summary_only=True)['tree']['thumb'])

    def test_invalid_requests_and_cursor_are_rejected(self):
        for folders in (None, [], ['a'] * 129, [42]):
            with self.assertRaises(ValueError): gallery_image_page(self.conn, 'all', 'all', folders)
        with self.assertRaises(ValueError): gallery_image_page(self.conn, 'all', 'all', ['a'], {})

    def test_virtual_metadata_paths_are_literal_bounded_and_filtered(self):
        self.add('1_Solo/A', "a'_%한글.png")
        self.add('1_Solo/A', 'not_requested.png')
        self.add('_R-18/A', 'restricted.png', mode='r18')
        wanted = ["1_Solo/A/a'_%한글.png", '_R-18/A/restricted.png']
        rows, cursor = gallery_image_page(self.conn, 'general', 'all', None, paths=wanted)
        self.assertEqual([row[0] for row in rows], wanted[:1])
        self.assertIsNone(cursor)
        for invalid in ([], ['a'] * 513, [None]):
            with self.assertRaises(ValueError):
                gallery_image_page(self.conn, 'all', 'all', None, paths=invalid)

    def test_catalog_row_count_depends_on_folders_not_image_count(self):
        for folder in range(10):
            for i in range(100): self.add(f'1_Solo/{folder}', f'{i}.png')
        rows = list(gallery_rows(self.conn, 'general', summary=True))
        self.assertEqual(len(rows), 10)
        self.assertEqual(sum(row[10] for row in rows), 1000)

    def test_endpoint_backfills_only_requested_page_and_keeps_other_rows_untouched(self):
        self.add('1_Solo/A', '1.png'); self.add('1_Solo/A', '2.png')
        self.add('1_Solo/B', 'other.png')
        self.conn.execute('UPDATE gallery_images SET ctime = NULL')
        source = ast.parse((Path(__file__).resolve().parents[1] / 'app.py').read_text(encoding='utf-8-sig'))
        fn = next(n for n in source.body if isinstance(n, ast.FunctionDef) and n.name == 'get_gallery_image_page')
        fn.decorator_list = []
        reads = []
        db = types.SimpleNamespace(conn=self.conn, has_full_gallery_index=lambda: True, close=lambda: None)
        def created(path, fallback):
            reads.append(path)
            return 123
        ns = {'request': types.SimpleNamespace(get_json=lambda **kw: {'folders': ['1_Solo/A'], 'limit': 1}),
              'jsonify': lambda **kw: kw, 'utils': types.SimpleNamespace(HistoryDB=lambda: db),
              'image_logic': types.SimpleNamespace(normalize_model_family_filter=lambda v: v, normalize_model_family=lambda v: v),
              'os': os, 'CLASSIFIED_DIR': 'synthetic', 'get_file_creation_time': created,
              'load_gallery_image_tags_config': lambda: {}, 'get_gallery_image_tag_for_path': lambda *args: ''}
        exec(compile(ast.Module(body=[fn], type_ignores=[]), '<page endpoint>', 'exec'), ns)
        result = ns['get_gallery_image_page']()
        self.assertEqual(result['images'][0]['ctime'], 123)
        self.assertEqual(len(reads), 1)
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM gallery_images WHERE ctime IS NULL').fetchone()[0], 2)
        ns['get_gallery_image_page']()
        self.assertEqual(len(reads), 1)


if __name__ == '__main__': unittest.main()
