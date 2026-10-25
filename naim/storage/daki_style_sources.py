"""Collected article metadata, independent of images and generation recipes."""
import json
from pathlib import Path
import re
import threading
from urllib.parse import urlsplit


def source_url(value):
    if not isinstance(value, str) or len(value) > 2048 or any(ord(char) < 32 for char in value):
        return None
    try:
        parsed = urlsplit(value.strip())
        if (parsed.scheme not in ('http', 'https') or parsed.hostname != 'arca.live'
                or parsed.username or parsed.password or parsed.port is not None
                or not re.fullmatch(r'/b/[A-Za-z0-9_-]+/[0-9]+/?', parsed.path)):
            return None
    except ValueError:
        return None
    return 'https://arca.live' + parsed.path.rstrip('/')


def source_metadata(style, fallback=None):
    """A stored recipe's known count takes precedence; unknown is not zero."""
    url = source_url(style.get('source_url'))
    count = style.get('recommendation_count')
    collected = style.get('recommendation_collected_at')
    if type(count) is not int or count < 0:
        fallback = fallback if isinstance(fallback, dict) else {}
        count = fallback.get('recommendation_count')
        collected = fallback.get('recommendation_collected_at')
    if not url or type(count) is not int or count < 0:
        count, collected = None, None
    if not isinstance(collected, str) or not collected.strip() or len(collected) > 100:
        collected = None
    return {'source_url': url, 'recommendation_count': count,
            'recommendation_collected_at': collected}


class DakiStyleSources:
    def __init__(self, root_provider):
        self.root_provider = root_provider
        self._lock = threading.RLock()
        self._signature = None
        self._posts = {}

    def _load(self):
        value = self.root_provider() if callable(self.root_provider) else self.root_provider
        if not value:
            return {}
        try:
            root = Path(value).resolve()
            path = root / 'source_posts.json'
            if path.resolve().parent != root:
                return {}
            stat = path.stat()
        except OSError:
            return {}
        signature = (path, stat.st_mtime_ns, stat.st_size)
        if signature != self._signature:
            try:
                data = json.loads(path.read_text(encoding='utf-8'))
                posts = data.get('posts') if isinstance(data, dict) and data.get('version') == 1 else None
                if not isinstance(posts, dict):
                    posts = {}
            except (OSError, ValueError, UnicodeError):
                # Optional display metadata must not prevent opening saved images.
                posts = {}
            self._posts = {url: source_metadata({'source_url': url}, row)
                           for raw, row in posts.items() if (url := source_url(raw))}
            self._signature = signature
        return self._posts

    def metadata(self, style):
        return self.metadata_many([style])[0]

    def metadata_many(self, styles):
        with self._lock:
            posts = self._load()
            return [source_metadata(style, posts.get(source_url(style.get('source_url')))) for style in styles]
