"""Measure catalog serialization without importing the live app or printing paths.

Default: 100,000 synthetic index rows in memory. --installed opens the default
installed gallery DB read-only. Neither mode changes existing data.
"""
import json
from pathlib import Path
import sqlite3
import statistics
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests.test_gallery_catalog import CatalogTests


def main():
    fixture = CatalogTests()
    if '--installed' in sys.argv:
        path = Path(__file__).resolve().parents[1] / 'TOTAL_CLASSIFIED/naia_history.db'
        fixture.conn = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
        fixture.conn.execute('PRAGMA query_only=ON')
    else:
        fixture.setUp()
        fixture.conn.executemany('INSERT INTO gallery_images VALUES (?,?,?,?,?,?,?,?,?,?,?)', (
            (f'1_Solo/Folder_{i // 1000:03}/{i:06}.png', f'1_Solo/Folder_{i // 1000:03}',
             f'{i:06}.png', 1024, 1536, i, 'synthetic', '', 'v5', i + 1, 'general')
            for i in range(100000)))
        fixture.conn.commit()
    try:
        build = fixture.builder()
        count = fixture.conn.execute('SELECT COUNT(*) FROM gallery_images').fetchone()[0]
        print(json.dumps({'index_rows': count, 'read_only_installed': '--installed' in sys.argv}))
        for summary in (False, True):
            timings = []
            for _ in range(3):
                start = time.perf_counter()
                payload = build('all', 'name', summary_only=summary)
                size = len(json.dumps(payload, ensure_ascii=False).encode('utf-8'))
                timings.append((time.perf_counter() - start) * 1000)
            print(json.dumps({'summary': summary, 'response_bytes': size,
                              'total_images': payload['tree']['total_images'],
                              'median_ms': round(statistics.median(timings), 2)}))
    finally:
        fixture.conn.close()


if __name__ == '__main__':
    main()
