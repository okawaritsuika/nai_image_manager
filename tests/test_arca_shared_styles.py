import io
import json
import unittest
from datetime import date
from threading import Barrier, Event, Lock, get_ident
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from PIL import Image, PngImagePlugin

from naim.arca_shared_styles import ArcaSharedClient, ArcaSharedError, _cookie_jar, _image_identity, _image_url, _merge_metadata, _parse, _safe_url, extract_metadata


def png_metadata(model="NovelAI Diffusion V5 Full", structured=False):
    values = {"prompt": "artist:example, watercolor", "uc": "lowres", "seed": 12, "width": 8, "height": 8}
    if structured:
        values["v4_prompt"] = {"caption": {"base_caption": "style base", "char_captions": [{"char_caption": "character"}]}}
    info = PngImagePlugin.PngInfo()
    info.add_text("Source", model)
    info.add_text("Comment", json.dumps(values))
    output = io.BytesIO()
    Image.new("RGB", (8, 8)).save(output, "PNG", pnginfo=info)
    return output.getvalue()


class Response:
    def __init__(self, body=b"", status=200, headers=None):
        self.body = body.encode() if isinstance(body, str) else body
        self.status_code = status
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def iter_content(self, size):
        yield self.body


PAYLOAD = {"cookies": [{"name": "session", "value": "synthetic", "domain": ".arca.live", "path": "/", "secure": True}]}
CATEGORIES = '<a href="/b/aiart?category=1">NAI</a><a href="/b/aiart?category=2">🔞 NAI</a>'


def row(number, day="2026-10-17", badge="NAI", title="그림체 공유 예시"):
    return f'<a class="vrow column" href="/b/aiart/{number}"><span class="badge">{badge}</span><span class="title">{title}</span><time datetime="{day}T10:00:00+09:00"></time></a>'


class ArcaSharedTests(unittest.TestCase):
    def test_http_adapter_retries_rate_limit_using_server_delay(self):
        import requests
        from urllib3.response import HTTPResponse
        original_session = requests.Session

        def offline_session():
            session = original_session()
            session.trust_env = False
            return session

        for retry_after, seconds in (('2', 2), ('Thu, 01 Jan 1970 00:17:40 GMT', 60)):
            responses = [HTTPResponse(body=io.BytesIO(b''), status=429,
                                      headers={'Retry-After': retry_after}, preload_content=False),
                         HTTPResponse(body=io.BytesIO(b'synthetic image'), status=200, preload_content=False)]
            with self.subTest(retry_after=retry_after), \
                    patch('naim.arca_shared_styles.requests.Session', side_effect=offline_session), \
                    patch('urllib3.connectionpool.HTTPSConnectionPool._make_request', side_effect=responses) as request, \
                    patch('urllib3.util.retry.time.sleep') as sleep, \
                    patch('urllib3.util.retry.time.time', return_value=1000):
                result = ArcaSharedClient()._get('https://ac-o.arca.live/synthetic.png', image=True)
            self.assertEqual(result, b'synthetic image')
            self.assertEqual(request.call_count, 2)
            sleep.assert_called_once_with(seconds)

    def test_http_adapter_retries_are_bounded_and_other_http_errors_are_not_retried(self):
        import requests
        from urllib3.response import HTTPResponse
        original_session = requests.Session

        def offline_session():
            session = original_session()
            session.trust_env = False
            return session

        for status, count, code in ((429, 4, 'rate_limited'), (503, 4, 'http_error'), (403, 1, 'http_error')):
            def respond(*args, **kwargs):
                return HTTPResponse(body=io.BytesIO(b''), status=status, preload_content=False)
            with self.subTest(status=status), \
                    patch('naim.arca_shared_styles.requests.Session', side_effect=offline_session), \
                    patch('urllib3.connectionpool.HTTPSConnectionPool._make_request', side_effect=respond) as request, \
                    patch('urllib3.util.retry.time.sleep') as sleep:
                with self.assertRaises(ArcaSharedError) as caught:
                    ArcaSharedClient()._get('https://ac-o.arca.live/synthetic.png', image=True)
            self.assertEqual(request.call_count, count)
            self.assertEqual(caught.exception.code, code)
            if status == 429:
                self.assertIn('요청 제한', str(caught.exception))
                self.assertNotIn('로그인', str(caught.exception))
            self.assertEqual([call.args[0] for call in sleep.call_args_list], [] if status == 403 else [1.0, 2.0])

    def ready_client(self):
        client = ArcaSharedClient()
        client._cookies = _cookie_jar(PAYLOAD)
        client._categories = {'NAI': {'category': '1'}, 'R18_NAI': {'category': '2'}}
        return client

    def test_image_candidate_urls_match_reference_without_forcing_arca_cdn_originals(self):
        for host in ('ac.arca.live', 'ac-o.arca.live'):
            for query in ('', '?type=img&key=a%2Fb&expires=123', '?key=a&key=b&type=orig'):
                url = f'https://{host}/synthetic.png{query}'
                self.assertEqual(_image_url(url, 'https://arca.live/b/aiart/1'), url)
        self.assertEqual(_image_url('https://ac.namu.la/synthetic.png?type=img', ''),
                         'https://ac.namu.la/synthetic.png?type=orig')
        urls = [f'https://ac.arca.live/{name}.png?type=img' for name in ('original', 'lazy', 'display')]
        article = '<div class="article-content"><img ' + ' '.join(
            f'{key}="{url}"' for key, url in zip(('data-original', 'data-src', 'src'), urls)) + '></div>'
        self.assertEqual(_parse(article).images, urls)

    def test_failed_images_do_not_stop_other_images_or_posts_and_keep_connection(self):
        client, event, attempts, progress = self.ready_client(), Event(), [], []

        def fetch(url, **kwargs):
            parsed = urlsplit(url)
            if kwargs.get('image'):
                attempts.append(parsed.path)
                if parsed.path == '/bad.png':
                    raise ArcaSharedError('이미지 요청 제한(HTTP 429, 도메인: ac-o.arca.live)', 'rate_limited')
                return png_metadata()
            if parsed.path == '/b/aiart/1':
                return b'<div class="article-content"><img data-original="https://ac.arca.live/bad.png?type=img" src="https://ac.arca.live/good.png?type=img"></div>'
            if parsed.path == '/b/aiart/2':
                return b'<div class="article-content"><img src="https://ac.arca.live/next.png?type=img"></div>'
            query = parse_qs(parsed.query)
            return (row(1) + row(2)).encode() if query.get('category') == ['1'] and query.get('p') == ['1'] else b''

        with patch.object(client, '_get', side_effect=fetch), patch.object(event, 'wait', return_value=False):
            results = list(client.iter_images(date(2026, 10, 17), date(2026, 10, 17), event, lambda **kw: progress.append(kw)))
        self.assertEqual(sorted(attempts), ['/bad.png', '/good.png', '/next.png'])
        self.assertEqual(len(results), 2)
        failures = [item for item in progress if item.get('stage') == 'image_error']
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]['failed_images'], 1)
        self.assertIn('HTTP 429', failures[0]['last_image_error'])
        self.assertEqual(progress[-1]['scanned_posts'], 2)
        self.assertTrue(client.connected)

    def image_fetcher(self, image_count, download):
        article = '<div class="article-content">' + ''.join(
            f'<img src="https://ac.namu.la/{index}.png">' for index in range(image_count)) + '</div>'

        def fetch(url, **kwargs):
            parsed = urlsplit(url)
            if kwargs.get('image'):
                return download(int(parsed.path[1:-4]), kwargs)
            if parsed.path == '/b/aiart/1':
                return article.encode()
            query = parse_qs(parsed.query)
            return row(1).encode() if query.get('category') == ['1'] and query.get('p') == ['1'] else b''

        return fetch

    def test_search_uses_style_word_then_filters_both_words_tabs_and_dates(self):
        client, event, article_requests, search_queries = self.ready_client(), Event(), [], []
        first = (row(1, title='내 그림체를 공유합니다') + row(2, title='공유하는 그림체')
                 + row(3, title='그림체 질문') + row(4, title='태그 공유')
                 + row(5, badge='기타') + row(6, badge='🔞 NAI')
                 + row(7, day='2026-10-18') + row(8, day='2026-10-16'))

        def fetch(url, **kwargs):
            parsed = urlsplit(url)
            if kwargs.get('image'):
                return png_metadata()
            if parsed.path != '/b/aiart':
                article_requests.append(parsed.path)
                return f'<div class="article-content"><img src="https://ac.namu.la/{parsed.path.rsplit("/", 1)[1]}.png"></div>'.encode()
            query = parse_qs(parsed.query)
            search_queries.append(query)
            if query['p'] != ['1']:
                return b''
            return (first if query['category'] == ['1'] else row(9, badge='🔞 NAI')).encode()

        with patch.object(client, '_get', side_effect=fetch), patch.object(event, 'wait', return_value=False):
            results = list(client.iter_images(date(2026, 10, 17), date(2026, 10, 17), event, lambda **kw: None))
        self.assertEqual(article_requests, ['/b/aiart/1', '/b/aiart/2', '/b/aiart/9'])
        self.assertEqual(len(results), 3)
        self.assertTrue(all(query['target'] == ['title'] and query['keyword'] == ['그림체'] for query in search_queries))
        self.assertEqual({query['category'][0] for query in search_queries}, {'1', '2'})

    def test_images_download_in_parallel_with_six_pending_and_dom_order(self):
        client, event, barrier, lock = self.ready_client(), Event(), Barrier(6), Lock()
        started, finished, active, peak = [], [], 0, 0
        later_finished = Event()

        def download(index, kwargs):
            nonlocal active, peak
            with lock:
                started.append(index)
                active += 1
                peak = max(peak, active)
            if index < 6:
                barrier.wait(timeout=3)
                if index == 0:
                    self.assertTrue(later_finished.wait(3))
            with lock:
                finished.append(index)
                active -= 1
                if len(finished) == 5:
                    later_finished.set()
            return b'\x89PNG\r\n\x1a\n' + bytes([index])

        with patch.object(client, '_get', side_effect=self.image_fetcher(12, download)), patch.object(event, 'wait', return_value=False) as wait:
            images = client.iter_images(date(2026, 10, 17), date(2026, 10, 17), event, lambda **kw: None)
            first = next(images)
            self.assertEqual(sorted(started), list(range(6)))
            results = [first] + list(images)
        self.assertEqual(peak, 6)
        self.assertNotEqual(finished[0], 0)
        self.assertEqual([item['image_bytes'][-1] for item in results], list(range(12)))
        self.assertEqual(wait.call_count, 1)  # Page pacing remains; image pacing is removed.

    def test_known_images_skip_before_download_on_collector_thread(self):
        client, event, downloaded, callback_threads = self.ready_client(), Event(), [], []
        owner = get_ident()

        def skip(url):
            callback_threads.append(get_ident())
            return urlsplit(url).path in {'/0.png', '/2.png'}

        def download(index, kwargs):
            downloaded.append(index)
            return png_metadata()

        with patch.object(client, '_get', side_effect=self.image_fetcher(4, download)), patch.object(event, 'wait', return_value=False):
            results = list(client.iter_images(date(2026, 10, 17), date(2026, 10, 17), event, lambda **kw: None, skip_image=skip))
        self.assertEqual(sorted(downloaded), [1, 3])
        self.assertEqual(len(results), 2)
        self.assertEqual(callback_threads, [owner] * 4)

    def test_cancellation_or_error_does_not_schedule_more_images(self):
        for fail in (False, True):
            with self.subTest(fail=fail):
                client, event, barrier, started = self.ready_client(), Event(), Barrier(6), []

                def download(index, kwargs):
                    started.append(index)
                    barrier.wait(timeout=3)
                    if fail and index == 0:
                        raise RuntimeError('synthetic failure')
                    return png_metadata()

                with patch.object(client, '_get', side_effect=self.image_fetcher(12, download)):
                    images = client.iter_images(date(2026, 10, 17), date(2026, 10, 17), event, lambda **kw: None)
                    if fail:
                        with self.assertRaisesRegex(RuntimeError, 'synthetic failure'):
                            next(images)
                    else:
                        next(images)
                        event.set()
                        self.assertEqual(list(images), [])
                self.assertEqual(sorted(started), list(range(6)))

    def test_unexpected_failure_later_in_batch_prevents_refilling(self):
        from concurrent.futures import Future
        client, event = self.ready_client(), Event()
        executor = unittest.mock.Mock()
        def submit(function, url, **kwargs):
            future = Future()
            if urlsplit(url).path == '/5.png':
                future.set_exception(RuntimeError('synthetic internal failure'))
            else:
                future.set_result(png_metadata())
            return future
        executor.submit.side_effect = submit
        with patch('naim.arca_shared_styles.ThreadPoolExecutor', return_value=executor), \
                patch.object(client, '_get', side_effect=self.image_fetcher(12, lambda *args: None)):
            images = client.iter_images(date(2026, 10, 17), date(2026, 10, 17), event, lambda **kw: None)
            next(images)
            with self.assertRaisesRegex(RuntimeError, 'synthetic internal failure'):
                next(images)
        self.assertEqual(executor.submit.call_count, 6)
        executor.shutdown.assert_called_once_with(wait=True, cancel_futures=True)

    def test_http_connections_reused_with_separate_board_and_cdn_cookie_jars(self):
        import requests
        client, event, calls = self.ready_client(), Event(), []
        article = ('<div class="article-content"><img src="https://arca.live/b/aiart/local.png">'
                   '<img src="https://ac.namu.la/one.png"><img src="https://ac-o.arca.live/two.png"></div>')

        def send(session, request, **kwargs):
            parsed = urlsplit(request.url)
            calls.append((session, parsed.hostname, parsed.path, request.headers.get('Cookie', '')))
            response = requests.Response()
            response.status_code = 200
            response._content_consumed = True
            if parsed.hostname == 'arca.live':
                session.cookies.set('server_login', 'synthetic', domain='.arca.live')
            if parsed.path == '/b/aiart/1':
                response._content = article.encode()
            elif parsed.path == '/b/aiart':
                query = parse_qs(parsed.query)
                response._content = row(1).encode() if query.get('category') == ['1'] and query.get('p') == ['1'] else b''
            elif parsed.hostname == 'ac.namu.la':
                response.status_code = 302
                response.headers['Location'] = 'https://ac-o.arca.live/one.png'
                response._content = b''
            else:
                response._content = png_metadata()
            return response

        with patch('naim.arca_shared_styles.requests.Session.send', autospec=True, side_effect=send), \
                patch('naim.arca_shared_styles.requests.Session.close', autospec=True) as close, \
                patch('naim.arca_shared_styles.IMAGE_WORKERS', 1), patch.object(event, 'wait', return_value=False):
            results = list(client.iter_images(date(2026, 10, 17), date(2026, 10, 17), event, lambda **kw: None))
        self.assertEqual(len(results), 3)
        board_sessions = {id(session) for session, host, path, cookie in calls if host == 'arca.live' and not path.endswith('.png')}
        cdn_sessions = {id(session) for session, host, path, cookie in calls if host != 'arca.live'}
        self.assertEqual(len(board_sessions), 1)
        self.assertEqual(len(cdn_sessions), 1)
        self.assertFalse(board_sessions & cdn_sessions)
        for session, host, path, cookie in calls:
            if host in ('arca.live', 'ac-o.arca.live'):
                self.assertIn('session=synthetic', cookie)
            else:
                self.assertNotIn('session=', cookie)
            if host != 'arca.live':
                self.assertNotIn('server_login=', cookie)
        self.assertEqual({id(call.args[0]) for call in close.call_args_list}, {id(call[0]) for call in calls})

    def test_browser_cookies_keep_domain_path_and_expiry_scope(self):
        import requests
        cookies = _cookie_jar({'cookies': PAYLOAD['cookies'] + [
            {'name': 'board_only', 'value': 'synthetic', 'domain': 'arca.live'},
            {'name': 'original_only', 'value': 'synthetic', 'domain': 'ac-o.arca.live'},
            {'name': 'cdn_domain', 'value': 'synthetic', 'domain': '.ac.arca.live'},
            {'name': 'board_path', 'value': 'synthetic', 'domain': '.arca.live', 'path': '/b/aiart'},
            {'name': 'expired', 'value': 'synthetic', 'domain': '.arca.live', 'expirationDate': 1},
        ]})
        sent = []

        def send(session, request, **kwargs):
            sent.append({part.split('=', 1)[0] for part in request.headers.get('Cookie', '').split('; ') if part})
            self.assertEqual(len(session.cookies), 0)
            response = requests.Response()
            response.status_code = 200
            response._content_consumed = True
            response._content = b''
            return response

        cases = (
            ('https://arca.live/b/aiart/1', False, {'session', 'board_only', 'board_path'}),
            ('https://ac.arca.live/synthetic.png', True, {'session', 'cdn_domain'}),
            ('https://ac-o.arca.live/synthetic.png', True, {'session', 'original_only'}),
            ('https://ac.namu.la/synthetic.png', True, set()),
        )
        with patch('naim.arca_shared_styles.requests.Session.send', autospec=True, side_effect=send):
            client = ArcaSharedClient()
            for url, image, expected in cases:
                with self.subTest(url=url):
                    client._get(url, image=image, cookies=cookies)
                    self.assertEqual(sent[-1], expected)
        self.assertEqual(len(cookies), 6)

    def test_generator_close_closes_sessions_before_returning(self):
        client, event, sessions = self.ready_client(), Event(), set()
        fetch = self.image_fetcher(12, lambda index, kwargs: png_metadata())

        def get(session, url, **kwargs):
            sessions.add(id(session))
            return Response(fetch(url, image=urlsplit(url).hostname != 'arca.live'))

        with patch('naim.arca_shared_styles.requests.Session.get', autospec=True, side_effect=get), \
                patch('naim.arca_shared_styles.requests.Session.close', autospec=True) as close:
            images = client.iter_images(date(2026, 10, 17), date(2026, 10, 17), event, lambda **kw: None)
            next(images)
            images.close()
        self.assertEqual({id(call.args[0]) for call in close.call_args_list}, sessions)

    def test_metadata_full_medium_and_raw_structure(self):
        for source, expected in (("NovelAI Diffusion V5 Full", "nai-diffusion-5-full"),
                                 ("NovelAI Diffusion V5 0ADF9AB7", "nai-diffusion-5-full"),
                                 ("NovelAI Diffusion V5 657484A5", "nai-diffusion-5-full"),
                                 ("NovelAI Diffusion V5 Full Medium", "nai-diffusion-5-full-medium"),
                                 ("NovelAI Diffusion V5 93F4BD30", "nai-diffusion-5-full-medium"),
                                 ("NovelAI Diffusion V5 70AB5786", "nai-diffusion-5-full-medium")):
            result = extract_metadata(png_metadata(source, structured=True))
            self.assertEqual(result["model"], expected)
            self.assertEqual(result["base_prompt"], "style base")
            self.assertEqual(result["negative_prompt"], "lowres")
            self.assertEqual(result["raw"]["v4_prompt"]["caption"]["char_captions"][0]["char_caption"], "character")

    def test_v45_unknown_and_invalid_are_ignored(self):
        for source in ("NovelAI Diffusion V4.5 Full", "NovelAI Diffusion V5 unknown",
                       "NovelAI Diffusion V5 Curated", "NovelAI Diffusion V5 DB276663"):
            self.assertIsNone(extract_metadata(png_metadata(source)))
        self.assertIsNone(extract_metadata(b"not an image"))

    def test_webp_exif_metadata(self):
        for source, expected_model in (("NovelAI Diffusion V5 Full Medium", "nai-diffusion-5-full-medium"),
                                       ("NovelAI Diffusion V5 657484A5", "nai-diffusion-5-full")):
            with self.subTest(source=source):
                exif = Image.Exif()
                values = {"Source": source, "Comment": json.dumps({"prompt": "style", "uc": "negative", "seed": "123"})}
                exif[37510] = b"ASCII\0\0\0" + json.dumps(values).encode()
                output = io.BytesIO()
                Image.new("RGB", (8, 8)).save(output, "WEBP", exif=exif)
                result = extract_metadata(output.getvalue())
                self.assertEqual(result["model"], expected_model)
                self.assertEqual(result["base_prompt"], "style")
                self.assertEqual(result["raw"]["Source"], values["Source"])
                self.assertEqual(result["seed"], 123)
                self.assertEqual(result["raw"]["seed"], "123")

    def test_metadata_recursion_and_invalid_urls_are_bounded(self):
        recursive = {}
        recursive["Comment"] = recursive
        values = {}
        _merge_metadata(values, recursive)
        with self.assertRaises(ArcaSharedError):
            _safe_url("https://arca.live:invalid/b/aiart")
        with self.assertRaises(ArcaSharedError):
            _safe_url("https://arca.live.evil.example/b/aiart")
        jar = _cookie_jar({"cookies": [{"name": "session", "value": "synthetic", "domain": "sub.arca.live"}]})
        self.assertEqual(next(iter(jar)).domain, "sub.arca.live")

    def test_stealth_png_metadata(self):
        values = json.dumps({"Source": "NovelAI Diffusion V5 Full", "Comment": json.dumps({"prompt": "stealth style", "seed": 2})}).encode()
        payload = b"stealth_pnginfo" + (len(values) * 8).to_bytes(4, "big") + values
        bits = "".join(f"{value:08b}" for value in payload)
        image = Image.new("RGBA", (64, 64), (1, 2, 3, 254))
        for index, bit in enumerate(bits):
            x, y = divmod(index, image.height)
            image.putpixel((x, y), (1, 2, 3, 254 | int(bit)))
        output = io.BytesIO()
        image.save(output, "PNG")
        self.assertEqual(extract_metadata(output.getvalue())["base_prompt"], "stealth style")

    @patch("naim.arca_shared_styles.requests.Session.get")
    def test_cookie_validation_precedes_network(self, get):
        for cookies in ([], [{"name": "bad\rname", "value": "x", "domain": "arca.live"}], [{"name": "session", "value": "x", "domain": "evil.example"}], [{"name": "session", "value": "x", "domain": "arca.live", "expirationDate": float("nan")}], [{"name": "session", "value": "x", "domain": "arca.live", "secure": "yes"}]):
            with self.assertRaises(ArcaSharedError):
                ArcaSharedClient().connect({"cookies": cookies})
        get.assert_not_called()

    @patch("naim.arca_shared_styles.requests.Session.get")
    def test_connect_validates_before_replacing_previous_session(self, get):
        client = ArcaSharedClient()
        get.side_effect = [Response(CATEGORIES)]
        client.connect({**PAYLOAD, 'user_agent': 'Synthetic Browser/1.0'})
        self.assertTrue(client.connected)
        self.assertEqual(get.call_count, 1)
        self.assertEqual(get.call_args.kwargs['headers']['User-Agent'], 'Synthetic Browser/1.0')
        original_cookies, original_categories = client._cookies, client._categories
        for response in (Response(status=429), Response(status=302), Response('<html>no categories</html>')):
            get.return_value = response
            get.side_effect = None
            with self.assertRaises(ArcaSharedError):
                client.connect({**PAYLOAD, 'user_agent': 'Synthetic Browser/2.0'})
            self.assertTrue(client.connected)
            self.assertIs(client._cookies, original_cookies)
            self.assertIs(client._categories, original_categories)
            self.assertEqual(client._user_agent, 'Synthetic Browser/1.0')
            empty_client = ArcaSharedClient()
            with self.assertRaises(ArcaSharedError):
                empty_client.connect(PAYLOAD)
            self.assertFalse(empty_client.connected)
        self.assertFalse(get.call_args.kwargs["allow_redirects"])
        get.return_value = Response(CATEGORIES)
        client.connect({**PAYLOAD, 'user_agent': 'Synthetic Browser/2.0'})
        self.assertIsNot(client._cookies, original_cookies)
        self.assertEqual(client._user_agent, 'Synthetic Browser/2.0')

    @patch("naim.arca_shared_styles.requests.Session.get")
    def test_inclusive_dates_tabs_duplicates_original_and_cookie_isolation(self, get):
        image = png_metadata()
        article = '<span class="head">추천</span><span class="body">1,234</span><div class="article-content"><img src="https://ac.namu.la/a.png?type=thumb"><img src="https://ac.arca.live/a.png?expires=2"><img src="https://evil.example/a.png"></div>'
        get.side_effect = [Response(CATEGORIES), Response(row(1)), Response(article), Response(image), Response(""), Response(row(2, badge="🔞 NAI")), Response(article), Response("")]
        client = ArcaSharedClient()
        client.connect(PAYLOAD)
        event = Event()
        progress = []
        with patch.object(event, "wait", return_value=False):
            results = list(client.iter_images(date(2026, 10, 17), date(2026, 10, 17), event, lambda **kw: progress.append(kw)))
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["image_bytes"], image)
        self.assertEqual(results[0]["recommendation_count"], 1234)
        self.assertEqual(progress[-1]["scanned_posts"], 2)
        self.assertEqual(progress[-1]["downloaded_images"], 1)
        image_call = next(call for call in get.call_args_list if "ac.namu.la" in call.args[0])
        self.assertIn("type=orig", image_call.args[0])
        self.assertIsNone(image_call.kwargs["cookies"])
        self.assertTrue(any("category=2" in call.args[0] and "keyword=" in call.args[0] for call in get.call_args_list))

    @patch('naim.arca_shared_styles.requests.Session.get')
    def test_original_cdn_redirect_reselects_browser_cookies_for_destination(self, get):
        image = png_metadata()
        original = 'https://ac-o.arca.live/synthetic.png?expires=2&key=synthetic&type=orig'
        for host in ('ac.namu.la', 'ac.arca.live'):
            with self.subTest(host=host):
                get.reset_mock()
                article = f'<div class="article-content"><img src="https://{host}/synthetic.png"><img src="{original}"></div>'
                get.side_effect = [Response(CATEGORIES), Response(row(1)), Response(article),
                                   Response(status=302, headers={'Location': original}), Response(image),
                                   Response(''), Response('')]
                client = ArcaSharedClient()
                client.connect(PAYLOAD)
                event = Event()
                with patch.object(event, 'wait', return_value=False):
                    results = list(client.iter_images(date(2026, 10, 17), date(2026, 10, 17), event, lambda **kw: None))
                self.assertEqual(len(results), 1)
                self.assertEqual(results[0]['image_bytes'], image)
                self.assertEqual(get.call_count, 7)
                self.assertEqual(get.call_args_list[4].args[0], original)
                for call in get.call_args_list[3:5]:
                    if urlsplit(call.args[0]).hostname == 'ac.namu.la':
                        self.assertIsNone(call.kwargs['cookies'])
                    else:
                        self.assertEqual(call.kwargs['cookies'].get_dict(), {'session': 'synthetic'})
                    self.assertFalse(call.kwargs['allow_redirects'])
                self.assertIsNotNone(get.call_args_list[2].kwargs['cookies'])
                self.assertEqual(_image_identity(original), _image_identity(results[0]['image_url']))

    @patch('naim.arca_shared_styles.requests.Session.get')
    def test_http_error_reports_resource_and_final_host_without_private_url_parts(self, get):
        client = ArcaSharedClient()
        for image, status in ((False, 429), (True, 429), (True, 403)):
            host = 'ac-o.arca.live' if image else 'arca.live'
            initial_host = 'ac.namu.la' if image else host
            get.side_effect = [Response(status=302, headers={
                'Location': f'https://{host}/private?key=secret#hidden' if image
                else f'https://{host}/b/aiart/private?key=secret#hidden'}), Response(status=status)]
            with self.subTest(image=image, status=status), self.assertRaises(ArcaSharedError) as caught:
                client._get(f'https://{initial_host}/b/aiart/1', cookies=_cookie_jar(PAYLOAD), image=image)
            message = str(caught.exception)
            self.assertIn('이미지' if image else '게시글/목록', message)
            self.assertIn(f'HTTP {status}', message)
            self.assertIn(f'도메인: {host}', message)
            self.assertEqual(caught.exception.code, 'rate_limited' if status == 429 else 'http_error')
            for private in ('private', 'secret', 'hidden'):
                self.assertNotIn(private, message)

    @patch('naim.arca_shared_styles.requests.Session.get')
    def test_original_cdn_support_does_not_allow_unrelated_or_insecure_redirects(self, get):
        client = ArcaSharedClient()
        for location in ('https://ac-o.arca.live.evil.example/synthetic.png',
                         'http://ac-o.arca.live/synthetic.png',
                         'https://ac-o.arca.live:444/synthetic.png',
                         'https://arca.live/b/aiart/1'):
            get.reset_mock()
            get.side_effect = [Response(status=302, headers={'Location': location})]
            with self.subTest(location=location), self.assertRaises(ArcaSharedError):
                client._get('https://ac.namu.la/synthetic.png', image=True, cookies=_cookie_jar(PAYLOAD))
            self.assertEqual(get.call_count, 1)
            self.assertIsNone(get.call_args.kwargs['cookies'])
        get.reset_mock()
        get.side_effect = [Response(status=302, headers={'Location': 'https://ac-o.arca.live/synthetic.png'})]
        with self.assertRaises(ArcaSharedError):
            client._get('https://arca.live/b/aiart/1', cookies=_cookie_jar(PAYLOAD))
        self.assertEqual(get.call_count, 1)

    @patch("naim.arca_shared_styles.requests.Session.get")
    def test_date_boundary_and_cancellation(self, get):
        client = ArcaSharedClient()
        get.side_effect = [Response(CATEGORIES), Response(row(1, day="2026-10-01")), Response("")]
        client.connect(PAYLOAD)
        event = Event()
        self.assertEqual(list(client.iter_images(date(2026, 10, 17), date(2026, 10, 17), event, lambda **kw: None)), [])
        self.assertEqual(get.call_count, 3)
        event.set()
        self.assertEqual(list(client.iter_images(date(2026, 10, 17), date(2026, 10, 17), event, lambda **kw: None)), [])
        self.assertEqual(get.call_count, 3)

    @patch("naim.arca_shared_styles.requests.Session.get")
    def test_challenge_and_oversize_rejected(self, get):
        for response in (Response("Just a moment"), Response(CATEGORIES, headers={"Content-Length": str(5 * 1024 * 1024)})):
            get.return_value = response
            with self.assertRaises(ArcaSharedError):
                ArcaSharedClient().connect(PAYLOAD)

    @patch("naim.arca_shared_styles.requests.Session.get")
    def test_search_limit_does_not_report_a_complete_period(self, get):
        get.side_effect = [Response(CATEGORIES), Response(row(1, day="2026-10-18"))]
        client = ArcaSharedClient()
        client.connect(PAYLOAD)
        event = Event()
        with patch('naim.arca_shared_styles.MAX_PAGES', 1), patch.object(event, 'wait', return_value=False):
            with self.assertRaisesRegex(ArcaSharedError, '한도'):
                list(client.iter_images(date(2026, 10, 17), date(2026, 10, 17), event, lambda **kw: None))

    @patch('naim.arca_shared_styles.requests.Session.get')
    def test_safe_board_redirect_connects_but_external_or_login_redirect_does_not(self, get):
        client = ArcaSharedClient()
        get.side_effect = [Response(status=302, headers={'Location': '/b/aiart?view=board'}), Response(CATEGORIES)]
        client.connect(PAYLOAD)
        self.assertTrue(client.connected)
        self.assertIn('/b/aiart?view=board', get.call_args.args[0])
        for location in ('https://example.test/collect', '/u/login'):
            get.reset_mock()
            get.side_effect = [Response(status=302, headers={'Location': location})]
            with self.subTest(location=location), self.assertRaises(ArcaSharedError):
                client.connect(PAYLOAD)
            self.assertEqual(get.call_count, 1)
            self.assertTrue(client.connected)  # The rejected replacement preserves the validated session.

    @patch('naim.arca_shared_styles.requests.Session.get')
    def test_blocked_redirect_reports_stage_and_host_without_private_url_parts(self, get):
        client = ArcaSharedClient()
        cases = (
            ('https://arca.live/b/aiart/1', False, 'https://blocked.example/private?key=secret#hidden',
             '게시글/목록 주소 이동', 'blocked.example'),
            ('https://ac.namu.la/synthetic.png', True, 'http://ac.namu.la/private?key=secret#hidden',
             '이미지 주소 이동', 'ac.namu.la'),
            ('https://ac.namu.la/synthetic.png', True, 'https://ac.namu.la:invalid/private?key=secret',
             '이미지 주소 이동', 'ac.namu.la'),
            ('https://ac.namu.la/synthetic.png', True, 'https://user:secret@blocked.example/private?key=secret',
             '이미지 주소 이동', 'blocked.example'),
        )
        for url, image, location, stage, host in cases:
            get.reset_mock()
            get.side_effect = [Response(status=302, headers={'Location': location})]
            with self.subTest(location=location), self.assertRaises(ArcaSharedError) as caught:
                client._get(url, cookies=_cookie_jar(PAYLOAD), image=image)
            message = str(caught.exception)
            self.assertIn(stage, message)
            self.assertIn(host, message)
            for private in ('private', 'secret', 'hidden', 'user:'):
                self.assertNotIn(private, message)
            self.assertEqual(get.call_count, 1)

    @patch('naim.arca_shared_styles.requests.Session.get')
    def test_invalid_image_address_has_safe_reason_and_never_requests(self, get):
        client = ArcaSharedClient()
        for url, reason in (
            ('http://ac.namu.la/private?key=secret', 'HTTPS'),
            ('https://blocked.example/private?key=secret', '도메인'),
            ('https://ac.namu.la:invalid/private?key=secret', '포트'),
            ('https://[invalid/private?key=secret', '형식'),
        ):
            with self.subTest(url=url), self.assertRaises(ArcaSharedError) as caught:
                client._get(url, image=True)
            self.assertIn('이미지 요청', str(caught.exception))
            self.assertIn(reason, str(caught.exception))
            self.assertNotIn('secret', str(caught.exception))
            self.assertNotIn('private', str(caught.exception))
        get.assert_not_called()

    @patch('naim.arca_shared_styles.requests.Session.get')
    def test_legitimate_board_with_captcha_script_is_not_a_challenge_page(self, get):
        get.return_value = Response(CATEGORIES + '<script src="/assets/captcha.js"></script>')
        client = ArcaSharedClient()
        client.connect(PAYLOAD)
        self.assertTrue(client.connected)

    @patch('naim.arca_shared_styles.requests.Session.get')
    def test_connect_reports_controlled_failure_codes(self, get):
        import requests
        cases = [(Response(status=403), 'http_error'), (Response('Just a moment'), 'browser_challenge'),
                 (Response('<a href="/b/aiart?category=1">NAI</a>'), 'categories_missing'),
                 (requests.Timeout('synthetic private URL'), 'timeout'),
                 (requests.exceptions.SSLError('synthetic private URL'), 'tls_error'),
                 (requests.ConnectionError('synthetic private URL'), 'network_error')]
        for result, code in cases:
            get.side_effect = [result]
            with self.subTest(code=code), self.assertRaises(ArcaSharedError) as caught:
                ArcaSharedClient().connect(PAYLOAD)
            self.assertEqual(caught.exception.code, code)
            self.assertNotIn('synthetic private URL', str(caught.exception))


if __name__ == "__main__":
    unittest.main()
