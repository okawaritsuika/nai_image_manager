"""Public article dates used to prefill the shared-style collection period."""
from datetime import date, datetime, timezone
from functools import lru_cache
import json
from pathlib import Path

from naim.storage.daki_style_sources import source_url


_DATES_PATH = Path(__file__).resolve().parents[2] / 'data' / 'shared_style_post_dates.json'


def posted_date(value):
    """Return the calendar date of an ISO date/timestamp, or None."""
    if not isinstance(value, str):
        return None
    value = value.strip()
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        try:
            return datetime.fromisoformat(value.replace('Z', '+00:00')).date().isoformat()
        except ValueError:
            return None


@lru_cache(maxsize=1)
def _bundled_dates():
    try:
        data = json.loads(_DATES_PATH.read_text(encoding='utf-8'))
    except (OSError, ValueError, UnicodeError):
        return {}
    posts = data.get('posts') if isinstance(data, dict) and data.get('version') == 1 else None
    if not isinstance(posts, dict):
        return {}
    return {url: day for raw, value in posts.items()
            if (url := source_url(raw)) and (day := posted_date(value))}


def post_date(style):
    """Prefer stored article dates, with public seed metadata for older styles."""
    for key in ('source_posted_at', 'posted_at'):
        day = posted_date(style.get(key))
        if day:
            return day
    return _bundled_dates().get(source_url(style.get('source_url')))


def style_sort_date(style, image_path=None):
    """Article date first; legacy styles use their original file's creation time."""
    for value in (style.get('source_posted_at'), style.get('posted_at'),
                  post_date(style), style.get('sort_date'), style.get('added_at'), style.get('created_at')):
        if not posted_date(value):
            continue
        parsed = datetime.fromisoformat(value.strip().replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.isoformat()
    if image_path is not None:
        try:
            stat = image_path.stat()
            # Windows exposes creation time as st_birthtime (st_ctime on older Python).
            stamp = getattr(stat, 'st_birthtime', stat.st_ctime)
            return datetime.fromtimestamp(stamp, timezone.utc).isoformat()
        except (OSError, ValueError, OverflowError):
            pass
    return None


def latest_posted_date(styles, today=None):
    """Return the latest known article date through today, or None."""
    if today is None:
        today = date.today()
    cutoff = today.isoformat() if isinstance(today, date) else posted_date(today)
    if not cutoff:
        raise ValueError('today must be an ISO date or a date object')
    return max((day for style in styles if (day := post_date(style)) and day <= cutoff), default=None)
