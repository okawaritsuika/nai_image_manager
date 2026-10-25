from datetime import date, datetime, timezone
from types import SimpleNamespace
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from naim.storage import daki_style_dates as dates


class DakiStyleDateTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / 'dates.json'
        patch = mock.patch.object(dates, '_DATES_PATH', self.path)
        patch.start()
        self.addCleanup(patch.stop)
        dates._bundled_dates.cache_clear()
        self.addCleanup(dates._bundled_dates.cache_clear)
        self.url = 'https://arca.live/b/aiart/123'

    def save(self, posts):
        self.path.write_text(json.dumps({'version': 1, 'posts': posts}), encoding='utf-8')

    def test_dates_and_iso_timestamps_preserve_the_article_calendar_day(self):
        for value in ('2026-01-02', '2026-01-02T23:59:59Z',
                      '2026-01-02T00:01:00+09:00', ' 2026-01-02 '):
            self.assertEqual(dates.posted_date(value), '2026-01-02')
        for value in (None, {}, 20260102, '', '2026-02-30', '2026-01-02garbage', 'not a date'):
            self.assertIsNone(dates.posted_date(value))

    def test_stored_source_date_takes_precedence_over_legacy_and_public_dates(self):
        self.save({self.url: '2026-01-01'})
        style = {'source_url': self.url, 'source_posted_at': '2026-01-03T01:00:00Z',
                 'posted_at': '2026-01-02'}
        self.assertEqual(dates.post_date(style), '2026-01-03')
        style['source_posted_at'] = 'invalid'
        self.assertEqual(dates.post_date(style), '2026-01-02')
        style['posted_at'] = None
        self.assertEqual(dates.post_date(style), '2026-01-01')

    def test_public_lookup_normalizes_article_url_and_filters_bad_metadata(self):
        self.save({'http://arca.live/b/aiart/123/?page=2': '2026-01-02',
                   'https://example.invalid/b/aiart/123': '2026-01-03',
                   'https://arca.live/b/aiart/124': 'invalid'})
        self.assertEqual(dates.post_date({'source_url': self.url + '#comment'}), '2026-01-02')
        self.assertIsNone(dates.post_date({'source_url': 'https://example.invalid/b/aiart/123'}))
        self.assertIsNone(dates.post_date({'source_url': 'https://arca.live/b/aiart/124'}))

    def test_valid_stored_date_does_not_require_a_source_link(self):
        self.assertEqual(dates.post_date({'source_url': 'invalid', 'source_posted_at': '2026-01-02'}),
                         '2026-01-02')

    def test_latest_date_ignores_unknown_and_future_posts_and_includes_today(self):
        styles = [{'posted_at': stamp} for stamp in
                  ('2026-01-02', '2026-01-04', None, 'invalid', '2026-01-03')]
        self.assertEqual(dates.latest_posted_date(styles, today=date(2026, 1, 3)), '2026-01-03')
        self.assertEqual(dates.latest_posted_date(styles, today='2026-01-02'), '2026-01-02')
        self.assertIsNone(dates.latest_posted_date(styles, today='2025-12-31'))
        self.assertIsNone(dates.latest_posted_date([], today='2026-01-03'))

    def test_default_cutoff_uses_today(self):
        class Calendar(date):
            @classmethod
            def today(cls):
                return cls(2026, 1, 2)
        with mock.patch.object(dates, 'date', Calendar):
            self.assertEqual(dates.latest_posted_date([{'posted_at': '2026-01-02'}]), '2026-01-02')

    def test_missing_or_corrupt_optional_asset_is_ignored(self):
        for content in (None, '{bad', '[]', '{"version":2,"posts":{}}', '{"version":1,"posts":[]}'):
            dates._bundled_dates.cache_clear()
            if content is not None:
                self.path.write_text(content, encoding='utf-8')
            self.assertIsNone(dates.post_date({'source_url': self.url}))

    def test_public_asset_is_read_once(self):
        self.save({self.url: '2026-01-02'})
        with mock.patch.object(Path, 'read_text', autospec=True, return_value=self.path.read_text()) as read:
            self.assertEqual(dates.latest_posted_date([{'source_url': self.url}] * 50,
                                                   today='2026-01-03'), '2026-01-02')
        read.assert_called_once()

    def test_sort_date_preserves_article_time_and_uses_creation_time_for_legacy(self):
        image = mock.Mock()
        image.stat.return_value = SimpleNamespace(st_birthtime=100, st_ctime=200, st_mtime=300)
        self.assertEqual(dates.style_sort_date({'source_posted_at': '2026-01-02T23:00:00+09:00'}, image),
                         '2026-01-02T23:00:00+09:00')
        image.stat.assert_not_called()
        self.assertEqual(dates.style_sort_date({}, image), datetime.fromtimestamp(100, timezone.utc).isoformat())
        image.stat.return_value = SimpleNamespace(st_ctime=200, st_mtime=300)
        self.assertEqual(dates.style_sort_date({}, image), datetime.fromtimestamp(200, timezone.utc).isoformat())

    def test_sort_date_uses_seed_dates_or_saved_addition_and_tolerates_missing_file(self):
        self.save({self.url: '2026-01-02'})
        self.assertEqual(dates.style_sort_date({'source_url': self.url}), '2026-01-02T00:00:00+00:00')
        self.assertEqual(dates.style_sort_date({'added_at': '2026-01-03T01:02:03Z'}), '2026-01-03T01:02:03+00:00')
        self.assertIsNone(dates.style_sort_date({'sort_date': 'bad'}, self.path.parent / 'missing.png'))
