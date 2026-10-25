const test = require('node:test');
const assert = require('node:assert/strict');
const {createNovelAIAccount} = require('../static/novelai_account.js');

function fixture({missing = []} = {}) {
    const elements = new Map(), requests = [], replies = [];
    const absent = new Set(missing);
    const doc = {hidden: false, listeners: {}, addEventListener(type, handler) { this.listeners[type] = handler; }, getElementById(id) {
        if (absent.has(id)) return null;
        if (!elements.has(id)) elements.set(id, {textContent: '', value: '', type: 'password', dataset: {}, parentNode: {dataset: {}},
            listeners: {}, addEventListener(type, handler) { this.listeners[type] = handler; }, setAttribute(name, value) { this[name] = value; }});
        return elements.get(id);
    }};
    const win = {confirm: () => true, setInterval(handler) { this.poll = handler; },
        fetch: async (url, options) => {
            requests.push({url, options});
            const reply = replies.shift();
            if (reply instanceof Error) throw reply;
            if (typeof reply === 'function') return reply();
            return {ok: true, json: async () => reply};
        }};
    const account = createNovelAIAccount(doc, win);
    return {account, doc, win, requests, replies, el: id => doc.getElementById(id)};
}
const summary = {configured: true, key_hint: 'test…hint', status: 'ok', anlas: 1234,
    usage: {percent: 87, is_negative: false, seconds_until_next_percent: 90}, checked_at: 1700000000};

test('header shows remaining quota and Anlas, including real zero balances', async () => {
    const f = fixture(); f.replies.push(summary);
    await f.account.initialize();
    assert.equal(f.el('naiQuotaLabel').textContent, '할당량 87%');
    assert.equal(f.el('naiAnlasLabel').textContent, 'Anlas 1,234');
    assert.match(f.el('naiAccountDetail').textContent, /2분/);
    f.replies.push({...summary, anlas: 0, usage: {...summary.usage, percent: 0}});
    await f.account.refresh(true);
    assert.equal(f.el('naiAnlasLabel').textContent, 'Anlas 0');
    assert.equal(f.el('naiQuotaLabel').textContent, '할당량 0%');
});

test('unknown balances and failed requests are not displayed as zero', async () => {
    const f = fixture(); f.replies.push({...summary, anlas: null, usage: null});
    await f.account.refresh();
    assert.equal(f.el('naiAnlasLabel').textContent, 'Anlas —');
    f.replies.push(new Error('synthetic secret must not appear'));
    await f.account.refresh();
    assert.equal(f.el('naiQuotaLabel').textContent, '할당량 조회 실패');
    assert.doesNotMatch(f.el('naiAccountDetail').textContent, /synthetic secret/);
});

test('negative quota and missing key have distinct header states', async () => {
    const f = fixture(); f.replies.push({...summary, usage: {...summary.usage, percent: 2, is_negative: true}});
    await f.account.refresh();
    assert.equal(f.el('naiQuotaLabel').textContent, '할당량 −2%');
    f.replies.push({configured: false, status: 'unconfigured'});
    await f.account.refresh();
    assert.equal(f.el('naiQuotaLabel').textContent, 'NovelAI 키 설정');
});

test('saving sends key in request body, clears draft and refreshes account', async () => {
    const f = fixture(); f.el('naiApiKey').value = '  synthetic-new-key  ';
    f.el('naiApiKey').type = 'text';
    f.replies.push({configured: true, key_hint: 'synt…-key'}, summary);
    await f.account.saveKey();
    assert.equal(f.requests[0].url, '/api/novelai/key');
    assert.deepEqual(JSON.parse(f.requests[0].options.body), {key: 'synthetic-new-key'});
    assert.equal(f.requests[0].options.method, 'PUT');
    assert.equal(f.requests[1].url, '/api/novelai/account?refresh=1');
    assert.equal(f.el('naiApiKey').value, '');
    assert.equal(f.el('naiApiKey').type, 'password');
    assert.match(f.el('naiKeyStatus').textContent, /저장했습니다/);
});

test('a stale response from the old key cannot replace a newly saved account', async () => {
    const f = fixture(); let release;
    f.replies.push(() => new Promise(resolve => { release = resolve; }));
    const old = f.account.refresh();
    f.el('naiApiKey').value = 'synthetic-new-key';
    f.replies.push({configured: true}, {...summary, anlas: 9000});
    await f.account.saveKey();
    release({ok: true, json: async () => summary});
    await old;
    assert.equal(f.el('naiAnlasLabel').textContent, 'Anlas 9,000');
});

test('empty input does not clear the saved key, explicit deletion can be cancelled', async () => {
    const f = fixture(); await f.account.saveKey();
    assert.equal(f.requests.length, 0);
    f.win.confirm = () => false;
    await f.account.saveKey(true);
    assert.equal(f.requests.length, 0);
    f.win.confirm = () => true;
    f.replies.push({configured: false}, {configured: false, status: 'unconfigured'});
    await f.account.saveKey(true);
    assert.deepEqual(JSON.parse(f.requests[0].options.body), {key: ''});
});

test('refresh calls coalesce and hidden pages do not poll', async () => {
    const f = fixture(); f.replies.push(summary);
    await f.account.initialize();
    let release; f.replies.push(() => new Promise(resolve => { release = resolve; }));
    const first = f.account.refresh(); const second = f.account.refresh(true);
    assert.equal(f.requests.length, 2);
    release({ok: true, json: async () => summary}); await Promise.all([first, second]);
    f.doc.hidden = true; f.win.poll();
    assert.equal(f.requests.length, 2);
});

test('canvas header works without gallery settings and refreshes while visible', async () => {
    const settingsOnly = ['naiSettingsRefresh', 'naiKeySave', 'naiKeyRemove', 'naiApiKey', 'naiSettingsQuota',
        'naiSettingsAnlas', 'naiKeyHint', 'naiAccountDetail', 'naiAccountSettings', 'naiKeyForm', 'naiKeyReveal', 'naiKeyStatus'];
    const f = fixture({missing: settingsOnly});
    f.replies.push({...summary, anlas: 0, usage: {...summary.usage, percent: 0}});
    await f.account.initialize();
    assert.equal(f.el('naiQuotaLabel').textContent, '할당량 0%');
    assert.equal(f.el('naiAnlasLabel').textContent, 'Anlas 0');

    f.replies.push({configured: true, status: 'error', message: 'synthetic error'});
    await f.el('naiAccountRefresh').listeners.click();
    assert.equal(f.requests[1].url, '/api/novelai/account?refresh=1');
    assert.equal(f.el('naiQuotaLabel').textContent, '할당량 조회 실패');
    assert.equal(f.el('naiAnlasLabel').textContent, 'Anlas —');
    assert.match(f.el('naiAccountBadge').title, /synthetic error/);

    f.replies.push(summary);
    await f.el('naiAccountBadge').listeners.click();
    assert.equal(f.requests[2].url, '/api/novelai/account?refresh=1');
    assert.equal(f.el('naiQuotaLabel').textContent, '할당량 87%');

    f.replies.push({...summary, anlas: 1});
    await f.win.poll();
    assert.equal(f.requests[3].url, '/api/novelai/account');
    assert.equal(f.el('naiAnlasLabel').textContent, 'Anlas 1');
    f.doc.hidden = true;
    await f.win.poll();
    assert.equal(f.requests.length, 4);
});
