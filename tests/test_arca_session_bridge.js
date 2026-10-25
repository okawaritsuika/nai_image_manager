const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const manager = 'http://127.0.0.1:5000/api/arca-styles/browser-session/extension';
const artist = 'http://127.0.0.1:5001/api/arca-styles/browser-session/extension';
const cookie = {name: 'session', value: 'synthetic-session', domain: '.arca.live', path: '/', secure: true};
const response = (status = 200, body = {connected: true}) => ({ok: status < 400, status, json: async () => body});

function fixture(fetcher = async () => response(), cookies = async () => [cookie], statusFetcher = async () => response(200, {connected: false})) {
    const elements = Object.fromEntries(['connectSession', 'status', 'managerStatus', 'artistStatus'].map(id =>
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

test('one click connects both fixed apps with the existing bridge contract', async () => {
    const f = fixture();
    await f.click();
    assert.deepEqual(f.posts.map(item => item.url), [manager, artist]);
    assert.equal(f.cookieReads(), 1);
    for (const {options} of f.posts) {
        assert.equal(options.method, 'POST');
        assert.equal(options.headers['X-Arca-Session-Bridge'], '1');
        assert.deepEqual(JSON.parse(options.body), {cookies: [cookie], user_agent: 'Synthetic Browser/1.0'});
        assert.equal(options.credentials, 'omit');
        assert.equal(options.redirect, 'error');
    }
    assert.equal(f.elements.managerStatus.dataset.state, 'success');
    assert.equal(f.elements.artistStatus.dataset.state, 'success');
    assert.match(f.elements.status.textContent, /NAI Image Manager · NAImakeArtistGroup 연결 완료/);
    assert.equal(f.elements.connectSession.disabled, false);
    assert.equal(f.timers.size, 0);
    assert.ok(!Object.values(f.elements).some(element => element.textContent.includes(cookie.value)));
});

test('either app can be offline without preventing the other connection', async () => {
    for (const offline of [manager, artist]) {
        const f = fixture(async url => { if (url === offline) throw new TypeError('synthetic network error'); return response(); });
        await f.click();
        const unavailable = offline === manager ? 'managerStatus' : 'artistStatus';
        const available = offline === manager ? 'artistStatus' : 'managerStatus';
        assert.equal(f.elements[unavailable].dataset.state, 'error');
        assert.match(f.elements[unavailable].textContent, /실행/);
        assert.equal(f.elements[available].dataset.state, 'success');
        assert.equal(f.elements.status.dataset.state, 'success');
    }
});

test('per-app HTTP errors distinguish an old API from login rejection and can retry', async () => {
    let retry = false;
    const f = fixture(async url => retry ? response() : url === manager ? response(404, null)
        : response(401, {error: '합성 로그인 만료 안내'}));
    await f.click();
    assert.match(f.elements.managerStatus.textContent, /최신 버전/);
    assert.equal(f.elements.artistStatus.textContent, '합성 로그인 만료 안내');
    assert.equal(f.elements.status.dataset.state, 'error');
    retry = true;
    await f.click();
    assert.equal(f.elements.status.dataset.state, 'success');
    assert.equal(f.posts.length, 4);
});

test('missing cookies or denied cookie access never sends a bridge request', async () => {
    for (const cookies of [async () => [], async () => { throw new Error('synthetic denial'); }]) {
        const f = fixture(undefined, cookies);
        await f.click();
        assert.equal(f.posts.length, 0);
        assert.equal(f.elements.status.dataset.state, 'error');
        assert.equal(f.elements.managerStatus.dataset.state, 'error');
        assert.equal(f.elements.artistStatus.dataset.state, 'error');
        assert.equal(f.elements.connectSession.disabled, false);
    }
});

test('a hung app times out independently and repeated clicks cannot duplicate requests', async () => {
    const f = fixture((url, {signal}) => url === artist ? Promise.resolve(response())
        : new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('synthetic timeout')))));
    const first = f.click();
    await f.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.cookieReads(), 1);
    assert.equal(f.posts.length, 2);
    assert.equal(f.elements.connectSession.disabled, true);
    for (const callback of f.timers.values()) callback();
    await first;
    assert.match(f.elements.managerStatus.textContent, /시간이 초과/);
    assert.equal(f.elements.artistStatus.dataset.state, 'success');
    assert.equal(f.elements.connectSession.disabled, false);
    assert.equal(f.timers.size, 0);
});

test('opening the popup reads both saved connection states without reading or sending cookies', async () => {
    const f = fixture(undefined, undefined, async url => response(200, {connected: url.includes(':5000/')}));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.requests.map(item => item.url), [manager, artist].map(url => url.replace(/\/extension$/, '')));
    assert.equal(f.cookieReads(), 0);
    assert.equal(f.posts.length, 0);
    for (const {options} of f.requests) {
        assert.equal(options.method, 'GET');
        assert.equal(options.headers['X-Arca-Session-Bridge'], '1');
        assert.equal(options.body, undefined);
        assert.equal(options.credentials, 'omit');
        assert.equal(options.redirect, 'error');
    }
    assert.equal(f.elements.managerStatus.textContent, '로그인 연결됨');
    assert.match(f.elements.artistStatus.textContent, /로그인 연결 안 됨/);
    assert.equal(f.elements.status.textContent, 'NAI Image Manager 연결됨');
    assert.equal(f.elements.connectSession.disabled, false);
    assert.equal(f.timers.size, 0);
});

test('initial status failures are unknown and do not hide the other app connection', async () => {
    const f = fixture(undefined, undefined, async url => {
        if (url.includes(':5000/')) throw new TypeError('synthetic network error');
        return response();
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.match(f.elements.managerStatus.textContent, /연결 상태 확인 불가/);
    assert.equal(f.elements.artistStatus.textContent, '로그인 연결됨');
    assert.equal(f.elements.status.textContent, 'NAImakeArtistGroup 연결됨');
    assert.equal(f.cookieReads(), 0);
});

test('failed login refresh reports the existing connection retained by the app', async () => {
    const f = fixture(async url => url === manager
        ? response(400, {connected: true, code: 'rate_limited', message: '합성 HTTP 429 안내'})
        : response(401, {connected: false, message: '합성 로그인 실패'}));
    await f.click();
    assert.match(f.elements.managerStatus.textContent, /기존 연결은 유지됩니다.*HTTP 429/);
    assert.equal(f.elements.artistStatus.textContent, '합성 로그인 실패');
    assert.match(f.elements.status.textContent, /NAI Image Manager 연결 유지 중/);
    assert.doesNotMatch(f.elements.status.textContent, /연결 완료/);
    assert.equal(f.elements.connectSession.disabled, false);
});

test('an old initial lookup cannot replace a newer login connection result', async () => {
    const pending = [];
    const f = fixture(undefined, undefined, () => new Promise((resolve, reject) => pending.push({resolve, reject})));
    assert.equal(pending.length, 2);
    await f.click();
    const current = Object.fromEntries(Object.entries(f.elements).map(([id, element]) => [id, element.textContent]));
    pending[0].resolve(response(200, {connected: false}));
    pending[1].reject(new Error('synthetic late failure'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(Object.fromEntries(Object.entries(f.elements).map(([id, element]) => [id, element.textContent])), current);
    assert.equal(f.cookieReads(), 1);
    assert.equal(f.timers.size, 0);
});

test('initial lookup timeout reports unknown connection rather than a disconnection', async () => {
    const f = fixture(undefined, undefined, (url, {signal}) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('synthetic timeout')));
    }));
    assert.equal(f.elements.connectSession.disabled, false);
    for (const callback of f.timers.values()) callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.match(f.elements.managerStatus.textContent, /연결 상태 확인 불가.*시간이 초과/);
    assert.match(f.elements.artistStatus.textContent, /연결 상태 확인 불가.*시간이 초과/);
    assert.match(f.elements.status.textContent, /연결 상태를 확인하지 못했습니다/);
    assert.doesNotMatch(f.elements.status.textContent, /연결된 앱이 없습니다/);
    assert.equal(f.posts.length, 0);
    assert.equal(f.cookieReads(), 0);
    assert.equal(f.timers.size, 0);
});
