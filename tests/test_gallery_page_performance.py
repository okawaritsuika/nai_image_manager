import unittest

from naim.gallery.catalog import gallery_image_page
from naim.storage.history import HistoryDB


class GalleryImagePagePerformanceTests(unittest.TestCase):
    image_count = 12_000
    page_size = 64
    vm_step_limit = 50_000

    def setUp(self):
        self.db = HistoryDB(':memory:')
        self.addCleanup(self.db.close)
        rows = []
        for index in range(self.image_count):
            rel_path = f'synthetic/folder/image-{index:05d}.png'
            model_family = ('v5', 'v4_5', 'other')[index % 3]
            rows.append((rel_path, 'synthetic/folder', f'image-{index:05d}.png',
                         'general', model_family, float(index)))
        self.db.conn.executemany(
            'INSERT INTO gallery_images '
            '(rel_path, folder_path, file_name, mode, model_family, mtime) '
            'VALUES (?, ?, ?, ?, ?, ?)', rows)
        self.db.conn.commit()

    def read_page_with_vm_count(self, after):
        ticks = [0]

        def count_vm_steps():
            ticks[0] += 1
            return 0

        self.db.conn.set_progress_handler(count_vm_steps, 100)
        try:
            page = gallery_image_page(
                self.db.conn, 'all', 'v4_5', ['synthetic/folder'],
                after=after, limit=self.page_size)
        finally:
            self.db.conn.set_progress_handler(None, 0)
        return page, ticks[0] * 100

    def expected_paths_after(self, after):
        return [f'synthetic/folder/image-{index:05d}.png'
                for index in range(self.image_count)
                if index % 3 == 1 and f'synthetic/folder/image-{index:05d}.png' > after]

    def assert_page(self, after):
        (rows, next_cursor), vm_steps = self.read_page_with_vm_count(after)
        expected = self.expected_paths_after(after)
        expected_page = expected[:self.page_size]
        self.assertEqual([row[0] for row in rows], expected_page)
        self.assertEqual(next_cursor, expected_page[-1] if len(expected) > self.page_size else None)
        self.assertLess(vm_steps, self.vm_step_limit,
                        f'page used about {vm_steps:,} SQLite VM operations')

    def test_folder_page_work_stays_bounded_for_first_and_deep_cursors(self):
        self.assert_page('')
        self.assert_page('synthetic/folder/image-09999.png')


if __name__ == '__main__':
    unittest.main()
