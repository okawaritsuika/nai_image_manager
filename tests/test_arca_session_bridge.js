const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const endpoint = 'http://127.0.0.1:5000/api/arca-styles/browser-session/extension';
const statusEndpoint = endpoint.replace(/\/extension$/, '');
const cookie = {name: 'session', value: 'synthetic-session', domain: '.arca.live', path: '/', secure: true};
const response = (status = 200, body = {connected: true}) => ({ok: status < 400, status, json: async () => body});

function fixture(fetcher = async () => response(), cookies = async () => [cookie], statusFetcher = async () => response(200, {connected: false})) {
    const elements = Object.fromEntries(['connectSession', 'status', 'managerStatus'].map(id =>
        [id, {disabled: false, textContent: '', dataset: {}, addEventListener(name, action) { this[name] = action; }}]));
    const requests = [], timers = new Map();
    let nextTimer = 0, cookieReads = 0;
    vm.runInNewContext(fs.readFileSync(require.resolve('../static/arca_session_bridge/popup.js'), 'utf8'), {
        document: {getElementById: id => elements[id]}, navigator: {userAgent: 'Synthetic Browser/1.0'}, AbortController,
        chrome: {cookies: {getAll: async options => {
            cookieReads++; assert.equal(options.domain, 'arca.live'); return cookies();
        }}},
        fetch(url, options) {
            requests.push({url, options});
            return (options.method === 'GET' ? statusFetcher : fetcher)(url, options);
        },
        setTimeout(callback, delay) { assert.equal(delay, 45000); const id = ++nextTimer; timers.set(id, callback); return id; },
        clearTimeout(id) { timers.delete(id); },
    });
    return {elements, requests, timers, click: () => elements.connectSession.click(), cookieReads: () => cookieReads,
        get posts() { return requests.filter(item => item.options.method === 'POST'); }};
}

test('the extension targets only NAI Image Manager and keeps its existing manifest permissions', () => {
    const manifest = JSON.parse(fs.readFileSync(require.resolve('../static/arca_session_bridge/manifest.json'), 'utf8'));
    const popup = fs.readFileSync(require.resolve('../static/arca_session_bridge/popup.html'), 'utf8');
    assert.equal(manifest.version, '1.2.0');
    assert.match(manifest.name, /NAI Image Manager/);
    assert.match(manifest.description, /NAI Image Manager/);
    assert.doesNotMatch(`${manifest.name} ${manifest.description} ${popup}`, /NAImakeArtistGroup|5001/);
    assert.deepEqual(manifest.permissions, ['cookies']);
    assert.deepEqual(manifest.host_permissions, ['https://arca.live/*', 'https://*.arca.live/*', 'http://127.0.0.1/*']);
    assert.match(popup, /id="managerStatus"/);
    assert.doesNotMatch(popup, /artistStatus/);
});

test('one click posts the existing cookie payload to the fixed NAI Image Manager endpoint', async () => {
    const f = fixture(async () => response(200, {connected: true, cookies: [cookie]}));
    await f.click();
    assert.deepEqual(f.posts.map(item => item.url), [endpoint]);
    assert.equal(f.cookieReads(), 1);
    const {options} = f.posts[0];
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['X-Arca-Session-Bridge'], '1');
    assert.deepEqual(JSON.parse(options.body), {cookies: [cookie], user_agent: 'Synthetic Browser/1.0'});
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(f.elements.managerStatus.dataset.state, 'success');
    assert.equal(f.elements.status.textContent, 'NAI Image Manager 연결 완료');
    assert.equal(f.elements.connectSession.disabled, false);
    assert.equal(f.timers.size, 0);
    assert.ok(!Object.values(f.elements).some(element => element.textContent.includes(cookie.value)));
    assert.ok(f.requests.every(item => item.url === endpoint || item.url === statusEndpoint));
});

test('an offline NAI Image Manager reports an actionable error without another endpoint', async () => {
    const f = fixture(async () => { throw new TypeError('synthetic network error'); });
    await f.click();
    assert.deepEqual(f.posts.map(item => item.url), [endpoint]);
    assert.equal(f.elements.managerStatus.dataset.state, 'error');
    assert.match(f.elements.managerStatus.textContent, /실행 여부와 확장 프로그램의 사이트 접근 권한/);
    assert.equal(f.elements.status.dataset.state, 'error');
    assert.match(f.elements.status.textContent, /NAI Image Manager 연결 상태를 확인하지 못했습니다/);
    assert.equal(f.elements.connectSession.disabled, false);
});

test('missing cookies or denied cookie access never sends a bridge request', async () => {
    for (const cookies of [async () => [], async () => { throw new Error('synthetic denial'); }]) {
        const f = fixture(undefined, cookies);
        await f.click();
        assert.equal(f.posts.length, 0);
        assert.equal(f.elements.status.dataset.state, 'error');
        assert.equal(f.elements.managerStatus.dataset.state, 'error');
        assert.equal(f.elements.connectSession.disabled, false);
        assert.ok(!Object.values(f.elements).some(element => element.textContent.includes('synthetic')));
    }
});

test('HTTP 404 and login failure are reported and a later retry can connect', async () => {
    let attempt = 0;
    const f = fixture(async () => {
        attempt++;
        if (attempt === 1) return response(404, null);
        if (attempt === 2) return response(401, {error: '합성 로그인 만료 안내'});
        return response();
    });
    await f.click();
    assert.match(f.elements.managerStatus.textContent, /최신 버전/);
    assert.equal(f.elements.status.dataset.state, 'error');
    await f.click();
    assert.equal(f.elements.managerStatus.textContent, '합성 로그인 만료 안내');
    assert.equal(f.elements.status.dataset.state, 'error');
    await f.click();
    assert.equal(f.elements.managerStatus.dataset.state, 'success');
    assert.equal(f.elements.status.dataset.state, 'success');
    assert.equal(f.posts.length, 3);
    assert.equal(f.elements.connectSession.disabled, false);
});

test('opening the popup checks the saved connection without reading or sending cookies', async () => {
    const f = fixture(undefined, undefined, async () => response(200, {connected: true, cookies: [cookie], user_agent: 'Synthetic Browser/1.0'}));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.requests.map(item => item.url), [statusEndpoint]);
    assert.equal(f.cookieReads(), 0);
    assert.equal(f.posts.length, 0);
    const {options} = f.requests[0];
    assert.equal(options.method, 'GET');
    assert.equal(options.headers['X-Arca-Session-Bridge'], '1');
    assert.equal(options.body, undefined);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(f.elements.managerStatus.textContent, '로그인 연결됨');
    assert.equal(f.elements.status.textContent, 'NAI Image Manager 연결됨');
    assert.ok(!Object.values(f.elements).some(element => element.textContent.includes(cookie.value)));
    assert.ok(!Object.values(f.elements).some(element => element.textContent.includes('Synthetic Browser/1.0')));
    assert.equal(f.elements.connectSession.disabled, false);
    assert.equal(f.timers.size, 0);
});

test('an initial status failure is unknown rather than a disconnected login', async () => {
    const f = fixture(undefined, undefined, async () => { throw new TypeError('synthetic network error'); });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.requests.map(item => item.url), [statusEndpoint]);
    assert.match(f.elements.managerStatus.textContent, /연결 상태 확인 불가/);
    assert.match(f.elements.status.textContent, /NAI Image Manager 연결 상태를 확인하지 못했습니다/);
    assert.equal(f.cookieReads(), 0);
    assert.equal(f.elements.connectSession.disabled, false);
});

test('a failed login refresh reports the connection retained by NAI Image Manager', async () => {
    const f = fixture(async () => response(400, {connected: true, code: 'rate_limited', message: '합성 HTTP 429 안내'}));
    await f.click();
    assert.match(f.elements.managerStatus.textContent, /기존 연결은 유지됩니다.*HTTP 429/);
    assert.match(f.elements.status.textContent, /NAI Image Manager 연결 유지 중/);
    assert.doesNotMatch(f.elements.status.textContent, /연결 완료/);
    assert.equal(f.elements.connectSession.disabled, false);
});

test('an old initial lookup cannot replace a newer login connection result', async () => {
    let resolveInitial;
    const f = fixture(undefined, undefined, () => new Promise(resolve => { resolveInitial = resolve; }));
    assert.equal(typeof resolveInitial, 'function');
    await f.click();
    const current = Object.fromEntries(Object.entries(f.elements).map(([id, element]) => [id, element.textContent]));
    resolveInitial(response(200, {connected: false}));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(Object.fromEntries(Object.entries(f.elements).map(([id, element]) => [id, element.textContent])), current);
    assert.equal(f.cookieReads(), 1);
    assert.equal(f.timers.size, 0);
});

test('a hung request times out, and a duplicate click cannot send another request', async () => {
    const f = fixture((url, {signal}) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('synthetic timeout')));
    }));
    const first = f.click();
    await f.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.cookieReads(), 1);
    assert.equal(f.posts.length, 1);
    assert.equal(f.elements.connectSession.disabled, true);
    assert.equal(f.timers.size, 1);
    for (const callback of f.timers.values()) callback();
    await first;
    assert.match(f.elements.managerStatus.textContent, /시간이 초과/);
    assert.equal(f.elements.managerStatus.dataset.state, 'error');
    assert.equal(f.elements.connectSession.disabled, false);
    assert.equal(f.timers.size, 0);
});

test('initial lookup timeout reports unknown connection without reading cookies', async () => {
    const f = fixture(undefined, undefined, (url, {signal}) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('synthetic timeout')));
    }));
    assert.equal(f.elements.connectSession.disabled, false);
    assert.equal(f.timers.size, 1);
    for (const callback of f.timers.values()) callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.match(f.elements.managerStatus.textContent, /연결 상태 확인 불가.*시간이 초과/);
    assert.match(f.elements.status.textContent, /연결 상태를 확인하지 못했습니다/);
    assert.doesNotMatch(f.elements.status.textContent, /로그인 세션이 없습니다/);
    assert.equal(f.posts.length, 0);
    assert.equal(f.cookieReads(), 0);
    assert.equal(f.timers.size, 0);
});
