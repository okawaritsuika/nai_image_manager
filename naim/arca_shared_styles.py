"""Memory-only Arca session bridge and bounded shared-style collection."""

import gzip
import io
import json
import math
import re
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from copy import copy
from datetime import date
from html.parser import HTMLParser
from threading import Event, Lock, local
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit

import requests
from PIL import Image
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


BASE_URL = "https://arca.live/b/aiart"
IMAGE_CDN_HOSTS = {"ac.namu.la", "ac.arca.live", "ac-o.arca.live"}
IMAGE_HOSTS = {"arca.live"} | IMAGE_CDN_HOSTS
MAX_IMAGE_BYTES = 32 * 1024 * 1024
MAX_HTML_BYTES = 4 * 1024 * 1024
MAX_METADATA_BYTES = 2 * 1024 * 1024
MAX_PAGES = 4096
IMAGE_WORKERS = 6
VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}


class ArcaSharedError(ValueError):
    def __init__(self, message, code='arca_error'):
        super().__init__(message)
        self.code = code


def _new_session():
    session = requests.Session()
    # Match the reference collector's retries, including server Retry-After.
    # Return the final response so _get can show a controlled Korean error.
    retries = Retry(total=3, connect=3, read=3, status=3, backoff_factor=0.5,
                    status_forcelist=(429, 500, 502, 503, 504),
                    allowed_methods=frozenset({'GET'}), raise_on_status=False)
    session.mount('https://', HTTPAdapter(max_retries=retries))
    return session


def _safe_url(value, base=BASE_URL, image=False, context="주소 검증"):
    try:
        url = urljoin(base, str(value or "").strip())
        parsed = urlsplit(url)
        host = parsed.hostname or ""
    except ValueError:
        raise ArcaSharedError(f"{context} 차단: 주소 형식이 올바르지 않습니다.", "invalid_url") from None
    # Report only the destination host, never signed paths/queries or credentials.
    display_host = host if re.fullmatch(r"[a-z0-9.-]{1,253}", host) else "확인 불가"
    allowed = IMAGE_HOSTS if image else {"arca.live"}
    reason = None
    try:
        port = parsed.port
    except ValueError:
        port = None
        reason = "포트 형식이 올바르지 않습니다"
    if reason is None:
        if parsed.scheme != "https":
            reason = "HTTPS 주소가 아닙니다"
        elif host not in allowed:
            reason = "허용 목록에 없는 도메인입니다"
        elif parsed.username or parsed.password:
            reason = "인증정보가 포함된 주소입니다"
        elif port not in (None, 443):
            reason = "허용되지 않은 포트입니다"
    if reason:
        raise ArcaSharedError(f"{context} 차단: {reason} (도메인: {display_host}).", "invalid_url")
    return url


def _cookie_jar(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get("cookies"), list) or not 0 < len(payload["cookies"]) <= 100:
        raise ArcaSharedError("확장 프로그램의 쿠키 데이터가 올바르지 않습니다.")
    jar = requests.cookies.RequestsCookieJar()
    total = 0
    for cookie in payload["cookies"]:
        if not isinstance(cookie, dict):
            raise ArcaSharedError("쿠키 데이터가 올바르지 않습니다.")
        parts = {}
        for key, maximum, default in (("name", 256, None), ("value", 8192, None), ("domain", 253, None), ("path", 2048, "/")):
            value = cookie.get(key, default)
            if not isinstance(value, str) or len(value) > maximum or (not value and key != "value") or any(ord(char) < 32 or ord(char) == 127 for char in value):
                raise ArcaSharedError("쿠키 데이터가 올바르지 않습니다.")
            parts[key] = value
            total += len(value)
        if total > 128 * 1024 or not parts["path"].startswith("/") or re.search(r'[\s()<>@,;:\\"/\[\]?={}\x80-\uffff]', parts["name"]):
            raise ArcaSharedError("쿠키 데이터가 올바르지 않습니다.")
        domain = parts["domain"].lower().removeprefix(".")
        if (domain != "arca.live" and not domain.endswith(".arca.live")) or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in domain.split(".")):
            raise ArcaSharedError("아카라이브 도메인의 쿠키만 연결할 수 있습니다.")
        secure = cookie.get("secure", False)
        expires = cookie.get("expirationDate")
        if not isinstance(secure, bool) or (expires is not None and (isinstance(expires, bool) or not isinstance(expires, (int, float)) or not math.isfinite(expires) or not 0 < expires <= 253402300799)):
            raise ArcaSharedError("쿠키 데이터가 올바르지 않습니다.")
        jar.set(parts["name"], parts["value"], domain=parts["domain"].lower(), path=parts["path"], secure=secure, expires=int(expires) if expires is not None else None)
    return jar


def _cookies_for_host(cookies, host):
    if not cookies or host not in IMAGE_HOSTS or not (host == 'arca.live' or host.endswith('.arca.live')):
        return None
    jar = requests.cookies.RequestsCookieJar()
    for cookie in cookies:
        domain = cookie.domain.lower()
        # Chrome prefixes domain cookies with a dot; host-only cookies must
        # not inherit requests' more permissive subdomain matching.
        root = domain.removeprefix('.')
        if host == root or (domain.startswith('.') and host.endswith('.' + root)):
            jar.set_cookie(copy(cookie))
    return jar


class _PageParser(HTMLParser):
    """Read only category links, dated search rows and article-body images."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links, self.rows, self.images = [], [], []
        self.link = self.row = None
        self.roles = []
        self.content_depth = 0
        self.found_content = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = set((attrs.get("class") or "").split())
        if tag == "a":
            self.link = [attrs.get("href", ""), []]
            if {"vrow", "column"} <= classes and "notice" not in classes:
                self.row = {"href": attrs.get("href", ""), "title": [], "badge": [], "posted_at": ""}
                self.roles = []
        if self.row is not None and tag not in VOID_TAGS:
            self.roles.append("title" if "title" in classes else "badge" if "badge" in classes else None)
            if tag == "time":
                self.row["posted_at"] = attrs.get("datetime", "")[:10]
        if self.content_depth and tag not in VOID_TAGS:
            self.content_depth += 1
        elif tag == "div" and "article-content" in classes:
            self.content_depth = 1
            self.found_content = True
        if self.content_depth:
            if tag == "img":
                self.images.extend(attrs[key] for key in ("data-original", "data-src", "src") if attrs.get(key))
            elif tag == "source":
                self.images.extend(part.strip().split(" ")[0] for part in attrs.get("srcset", "").split(",") if part.strip())
            elif tag == "a" and re.search(r"\.(png|webp)(?:\?|$)", attrs.get("href", ""), re.I):
                self.images.append(attrs["href"])

    def handle_data(self, text):
        if self.link is not None:
            self.link[1].append(text)
        if self.row is not None:
            for role in ("title", "badge"):
                if role in self.roles:
                    self.row[role].append(text)

    def handle_endtag(self, tag):
        if self.content_depth and tag not in VOID_TAGS:
            self.content_depth -= 1
        if tag == "a":
            if self.link is not None:
                self.links.append((self.link[0], " ".join(self.link[1]).strip()))
                self.link = None
            if self.row is not None:
                self.rows.append(self.row)
                self.row = None
                self.roles = []
        elif self.row is not None and tag not in VOID_TAGS and self.roles:
            self.roles.pop()


def _parse(html):
    parser = _PageParser()
    parser.feed(html)
    return parser


def _image_url(value, source_url):
    url = _safe_url(value, source_url, image=True)
    parsed = urlsplit(url)
    if not re.search(r"\.(png|webp)$", parsed.path, re.I):
        return None
    # Match the reference collector: Arca CDN URLs (including signed queries)
    # stay as published. Only legacy namu URLs request the original explicitly.
    if parsed.hostname == 'ac.namu.la':
        query = dict(parse_qsl(parsed.query, keep_blank_values=True))
        query["type"] = "orig"
        url = urlunsplit(parsed._replace(query=urlencode(query)))
    return url


def _image_identity(url):
    parsed = urlsplit(url)
    host = "ac.namu.la" if parsed.hostname in IMAGE_CDN_HOSTS else parsed.hostname
    query = sorted((key, value) for key, value in parse_qsl(parsed.query) if key.lower() not in {"expires", "key", "type"})
    return (host, parsed.path, tuple(query))


class ArcaSharedClient:
    def __init__(self):
        self._cookies = None
        self._categories = {}
        self._http = local()
        self._user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"

    @property
    def connected(self):
        return self._cookies is not None

    def _get(self, url, *, cookies=None, image=False, stop_event=None, _redirects=0, _session=None):
        resource = "이미지" if image else "게시글/목록"
        url = _safe_url(url, image=image, context=resource + " 요청")
        if stop_event is not None and stop_event.is_set():
            return b""
        limit = MAX_IMAGE_BYTES if image else MAX_HTML_BYTES
        # Original images redirect among the approved HTTPS image CDNs.
        # Recheck browser cookie scope at each destination, including redirects.
        host = urlsplit(url).hostname
        browser_cookies = _cookies_for_host(cookies, host)
        if _session is None:
            sessions = getattr(self._http, 'sessions', None)
            if sessions is None:
                with _new_session() as session:
                    return self._get(url, cookies=cookies, image=image, stop_event=stop_event,
                                     _redirects=_redirects, _session=session)
            # Keep response cookies from the board separate from image sessions.
            scope = 'arca' if host == 'arca.live' else 'cdn'
            if scope not in sessions:
                sessions[scope] = _new_session()
            _session = sessions[scope]
        try:
            with _session.get(url, cookies=browser_cookies, allow_redirects=False, stream=True, timeout=(8, 20), headers={"User-Agent": self._user_agent, "Accept-Language": "ko-KR,ko;q=0.9"}) as response:
                if response.status_code in (301, 302, 303, 307, 308):
                    location = response.headers.get('Location')
                    if not location or _redirects >= 4:
                        raise ArcaSharedError('아카라이브 주소 이동을 확인하지 못했습니다.', 'redirect_error')
                    target = _safe_url(location, url, image=image, context=resource + " 주소 이동")
                    from_host, to_host = urlsplit(url).hostname, urlsplit(target).hostname
                    cdn_redirect = image and from_host in IMAGE_CDN_HOSTS and to_host in IMAGE_CDN_HOSTS
                    if to_host != from_host and not cdn_redirect:
                        raise ArcaSharedError(f'{resource} 주소 이동 차단: 요청한 도메인과 다릅니다 ({from_host} → {to_host}).', 'redirect_error')
                    if not image and not urlsplit(target).path.startswith('/b/aiart'):
                        raise ArcaSharedError('아카라이브가 로그인 또는 접근 확인 페이지로 이동시켰습니다. Chrome에서 AI 그림 채널 접근을 확인해 주세요.', 'login_required')
                    return self._get(target, cookies=cookies, image=image, stop_event=stop_event,
                                     _redirects=_redirects + 1, _session=_session)
                if response.status_code == 429:
                    raise ArcaSharedError(f'{resource} 요청 제한(HTTP 429, 도메인: {host})이 재시도 후에도 계속됩니다. 잠시 뒤 다시 실행해 주세요.', 'rate_limited')
                if response.status_code != 200:
                    raise ArcaSharedError(f'{resource} 요청이 HTTP {response.status_code} 응답으로 거부되었습니다 (도메인: {host}).', 'http_error')
                size_header = response.headers.get("Content-Length", "")
                if size_header.isdigit() and int(size_header) > limit:
                    raise ArcaSharedError("아카라이브 응답이 허용 크기를 초과했습니다.")
                chunks, size = [], 0
                for chunk in response.iter_content(64 * 1024):
                    if stop_event is not None and stop_event.is_set():
                        return b""
                    size += len(chunk)
                    if size > limit:
                        raise ArcaSharedError("아카라이브 응답이 허용 크기를 초과했습니다.")
                    chunks.append(chunk)
                body = b"".join(chunks)
        except requests.Timeout:
            raise ArcaSharedError('앱에서 아카라이브에 요청한 응답 시간이 초과되었습니다.', 'timeout') from None
        except requests.exceptions.SSLError:
            raise ArcaSharedError('앱에서 아카라이브의 HTTPS 인증서를 확인하지 못했습니다.', 'tls_error') from None
        except requests.RequestException:
            raise ArcaSharedError('앱에서 아카라이브에 접속하지 못했습니다. 네트워크 또는 프록시 설정을 확인해 주세요.', 'network_error') from None
        if not image and re.search(rb"(?i)(cf-chl-|just a moment|captcha|challenge-platform)", body):
            page = _parse(body.decode('utf-8', 'replace'))
            if not page.found_content and not any(urlsplit(urljoin(BASE_URL, href)).path == '/b/aiart' and 'NAI' in label for href, label in page.links):
                raise ArcaSharedError('아카라이브가 앱의 접속에 브라우저 확인을 요구했습니다. Chrome 로그인 쿠키만으로는 이 요청을 통과하지 못했습니다.', 'browser_challenge')
        return body

    def connect(self, payload):
        jar = _cookie_jar(payload)
        user_agent = payload.get('user_agent', self._user_agent)
        if not isinstance(user_agent, str) or not 1 <= len(user_agent) <= 512 or any(ord(char) < 32 or ord(char) >= 127 for char in user_agent):
            raise ArcaSharedError("확장 프로그램의 브라우저 정보가 올바르지 않습니다.")
        # Validate a candidate without discarding the last working connection.
        candidate = ArcaSharedClient()
        candidate._user_agent = user_agent
        html = candidate._get(BASE_URL, cookies=jar).decode("utf-8", "replace")
        categories = {}
        for href, label in _parse(html).links:
            label = re.sub(r"\s+", " ", label)
            tab = "R18_NAI" if "🔞" in label and "NAI" in label else "NAI" if label == "NAI" else None
            if tab:
                url = _safe_url(href)
                parsed = urlsplit(url)
                if parsed.path == "/b/aiart" and parsed.query:
                    categories[tab] = dict(parse_qsl(parsed.query))
        if set(categories) != {"NAI", "R18_NAI"}:
            raise ArcaSharedError('받은 AI 그림 게시판에서 NAI·🔞 NAI 분류를 찾지 못했습니다. Chrome의 로그인·성인 표시 설정 또는 게시판 분류를 확인해 주세요.', 'categories_missing')
        self._cookies, self._categories, self._user_agent = jar, categories, user_agent

    def iter_images(self, start_date, end_date, stop_event, progress, *, skip_image=None):
        if not self.connected:
            raise ArcaSharedError("확장 프로그램으로 아카라이브를 먼저 연결해 주세요.")
        if type(start_date) is not date or type(end_date) is not date or start_date > end_date:
            raise ArcaSharedError("수집 기간을 확인해 주세요.")
        cancelled = Event()
        sessions, session_lock = [], Lock()

        class CollectionStop:
            def is_set(self):
                return cancelled.is_set() or stop_event.is_set()

            def wait(self, timeout):
                return self.is_set() or stop_event.wait(timeout) or self.is_set()

        def initialize_sessions():
            self._http.sessions = {}
            with session_lock:
                sessions.append(self._http.sessions)

        initialize_sessions()
        executor = ThreadPoolExecutor(max_workers=IMAGE_WORKERS, initializer=initialize_sessions)
        try:
            yield from self._iter_images(start_date, end_date, CollectionStop(), progress, executor, skip_image)
        finally:
            cancelled.set()
            executor.shutdown(wait=True, cancel_futures=True)
            for cache in sessions:
                for session in cache.values():
                    session.close()
            del self._http.sessions

    def _iter_images(self, start_date, end_date, stop_event, progress, executor, skip_image):
        seen_posts, seen_images = set(), set()
        scanned_posts = downloaded_images = failed_images = 0
        for tab, params in self._categories.items():
            previous_rows = None
            for page in range(1, MAX_PAGES + 1):
                if stop_event.is_set():
                    return
                query = dict(params, target="title", keyword="그림체", p=page)
                progress(stage="search", tab=tab, page=page, scanned_posts=scanned_posts, downloaded_images=downloaded_images)
                html = self._get(BASE_URL + "?" + urlencode(query), cookies=self._cookies, stop_event=stop_event).decode("utf-8", "replace")
                if stop_event.is_set():
                    return
                rows = _parse(html).rows
                identities = tuple(row["href"] for row in rows)
                if not rows or identities == previous_rows:
                    break
                previous_rows = identities
                progress(stage="search", tab=tab, page=page, scanned_posts=scanned_posts, downloaded_images=downloaded_images)
                older = False
                for row in rows:
                    try:
                        posted = date.fromisoformat(row["posted_at"])
                    except ValueError:
                        continue
                    older |= posted < start_date
                    title = " ".join("".join(row["title"]).split())
                    badge = " ".join("".join(row["badge"]).split())
                    row_tab = "R18_NAI" if "🔞" in badge and "NAI" in badge else "NAI" if badge == "NAI" else None
                    if not start_date <= posted <= end_date or row_tab != tab or not all(word in title for word in ("그림체", "공유")):
                        continue
                    source_url = _safe_url(row["href"])
                    match = re.fullmatch(r"/b/aiart/(\d+)/?", urlsplit(source_url).path)
                    if not match:
                        continue
                    source_url = BASE_URL + "/" + match.group(1)
                    if source_url in seen_posts:
                        continue
                    seen_posts.add(source_url)
                    scanned_posts += 1
                    progress(stage="article", tab=tab, page=page, scanned_posts=scanned_posts, downloaded_images=downloaded_images)
                    article = self._get(source_url, cookies=self._cookies, stop_event=stop_event).decode("utf-8", "replace")
                    if stop_event.is_set():
                        return
                    parser = _parse(article)
                    if not parser.found_content:
                        raise ArcaSharedError("게시글 본문에 접근하지 못했습니다. 로그인을 확인해 주세요.")
                    count = re.search(r'<span[^>]*class=["\'][^"\']*head[^"\']*["\'][^>]*>\s*추천\s*</span>\s*<span[^>]*class=["\'][^"\']*body[^"\']*["\'][^>]*>\s*([\d,]+)', article)
                    recommendation = int(count.group(1).replace(",", "")) if count else None
                    candidates = []
                    for candidate in parser.images:
                        try:
                            image_url = _image_url(candidate, source_url)
                        except ArcaSharedError:
                            continue
                        if not image_url or _image_identity(image_url) in seen_images:
                            continue
                        seen_images.add(_image_identity(image_url))
                        candidates.append(image_url)
                    pending = deque()
                    candidates = iter(candidates)
                    exhausted = False
                    while pending or not exhausted:
                        if stop_event.is_set():
                            return
                        while not exhausted and len(pending) < IMAGE_WORKERS:
                            if stop_event.is_set():
                                return
                            for _, queued in pending:
                                if queued.done():
                                    failure = queued.exception()
                                    if failure is not None and not isinstance(failure, ArcaSharedError):
                                        raise failure
                            image_url = next(candidates, None)
                            if image_url is None:
                                exhausted = True
                                break
                            if skip_image is not None and skip_image(image_url):
                                continue
                            progress(stage="download", tab=tab, page=page, scanned_posts=scanned_posts, downloaded_images=downloaded_images)
                            pending.append((image_url, executor.submit(
                                self._get, image_url, cookies=self._cookies, image=True, stop_event=stop_event)))
                        if not pending:
                            break
                        image_url, future = pending.popleft()
                        try:
                            body = future.result()
                        except ArcaSharedError as error:
                            if stop_event.is_set():
                                return
                            # The reference skips an unavailable image and
                            # continues the post; keep failures visible here.
                            failed_images += 1
                            progress(stage="image_error", failed_images=failed_images,
                                     last_image_error=str(error), tab=tab, page=page,
                                     scanned_posts=scanned_posts, downloaded_images=downloaded_images)
                            continue
                        if stop_event.is_set():
                            return
                        if not (body.startswith(b"\x89PNG\r\n\x1a\n") or (body[:4] == b"RIFF" and body[8:12] == b"WEBP")):
                            continue
                        downloaded_images += 1
                        progress(stage="image", tab=tab, page=page, scanned_posts=scanned_posts, downloaded_images=downloaded_images)
                        yield {"source_url": source_url, "source_posted_at": posted.isoformat(), "title": title, "recommendation_count": recommendation, "image_url": image_url, "image_bytes": body}
                if older:
                    break
                if stop_event.wait(0.6):
                    return
            else:
                raise ArcaSharedError("검색 페이지 한도에 도달했습니다. 수집 기간을 나누어 다시 실행해 주세요.")


def _merge_metadata(values, value, depth=0):
    if depth > 3:
        return
    if isinstance(value, bytes):
        value = value.decode("utf-8", "replace")
    if isinstance(value, str):
        if len(value) > MAX_METADATA_BYTES:
            return
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            return
    if not isinstance(value, dict):
        return
    values.update(value)
    comment = next((item for key, item in value.items() if str(key).lower() == "comment"), None)
    if isinstance(comment, (str, dict)):
        _merge_metadata(values, comment, depth + 1)


def _stealth(image):
    if image.mode != "RGBA":
        return None
    width, height = image.size
    alpha = image.getchannel("A").tobytes()
    def read(start, length):
        if start + length > width * height:
            raise ValueError("stealth bounds")
        result = bytearray()
        for index in range(start, start + length, 8):
            value = 0
            for bit in range(index, index + 8):
                x, y = divmod(bit, height)
                value = (value << 1) | (alpha[y * width + x] & 1)
            result.append(value)
        return bytes(result)
    signature = read(0, 120)
    if signature not in (b"stealth_pngcomp", b"stealth_pnginfo"):
        return None
    bits = int.from_bytes(read(120, 32), "big")
    if bits <= 0 or bits % 8 or bits > MAX_METADATA_BYTES * 8:
        return None
    value = read(152, bits)
    if signature == b"stealth_pngcomp":
        with gzip.GzipFile(fileobj=io.BytesIO(value)) as compressed:
            value = compressed.read(MAX_METADATA_BYTES + 1)
    return value.decode("utf-8") if len(value) <= MAX_METADATA_BYTES else None


def _model(value):
    text = str(value or "").strip().casefold()
    # NovelAI's source hashes cover both plain generation and native infilling.
    aliases = {"novelai diffusion v5 0adf9ab7": "nai-diffusion-5-full",
               "novelai diffusion v5 657484a5": "nai-diffusion-5-full",
               "novelai diffusion v5 93f4bd30": "nai-diffusion-5-full-medium",
               "novelai diffusion v5 70ab5786": "nai-diffusion-5-full-medium",
               "naid5f": "nai-diffusion-5-full"}
    if text in aliases:
        return aliases[text]
    for variant in ("full-medium", "full"):
        model = "nai-diffusion-5-" + variant
        if text == model or text in {"novelai diffusion v5 " + variant.replace("-", " "), "v5 " + variant.replace("-", " ")}:
            return model
    return None


def extract_metadata(image_bytes):
    """Return V5 Full/Medium generation metadata without rewriting its raw fields."""
    if not isinstance(image_bytes, bytes) or len(image_bytes) > MAX_IMAGE_BYTES:
        return None
    try:
        with Image.open(io.BytesIO(image_bytes)) as image:
            if image.format not in {"PNG", "WEBP"} or image.width * image.height > 40_000_000:
                return None
            values = {}
            for key, value in image.info.items():
                if isinstance(value, str):
                    values[key] = value
                    if key.lower() in {"comment", "parameters"}:
                        _merge_metadata(values, value)
            exif = image.getexif()
            user_comment = exif.get(37510)
            if user_comment is None and exif:
                user_comment = exif.get_ifd(34665).get(37510)
            if isinstance(user_comment, bytes):
                if user_comment.startswith(b"UNICODE\0"):
                    user_comment = user_comment[8:].decode("utf-16-be").strip("\0")
                else:
                    user_comment = user_comment.removeprefix(b"ASCII\0\0\0").decode("utf-8")
            _merge_metadata(values, user_comment)
            _merge_metadata(values, exif.get(270))
            try:
                _merge_metadata(values, _stealth(image))
            except (ValueError, OSError, UnicodeError, EOFError):
                pass
            named = {str(key).lower(): value for key, value in values.items()}
            model = _model(named.get("model")) or _model(named.get("source"))
            if not model:
                return None
            def prompt(key, *fallbacks):
                structured = values.get(key)
                if isinstance(structured, dict) and isinstance(structured.get("caption"), dict):
                    caption = structured["caption"].get("base_caption")
                    if isinstance(caption, str):
                        return caption
                return next((named[name] for name in fallbacks if isinstance(named.get(name), str)), "")
            base = prompt("v4_prompt", "base_prompt", "prompt", "description")
            if not base.strip():
                return None
            seed = values.get("seed")
            if isinstance(seed, str) and re.fullmatch(r"\d{1,10}", seed.strip()):
                seed = int(seed)
            return {"model": model, "base_prompt": base, "negative_prompt": prompt("v4_negative_prompt", "negative_prompt", "uc"), "raw": values, "seed": seed, "width": values.get("width", image.width), "height": values.get("height", image.height)}
    except (OSError, ValueError, SyntaxError, TypeError, UnicodeError, RecursionError, Image.DecompressionBombError):
        return None
