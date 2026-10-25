const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
    class Element {
        constructor(tag) {
            this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.listeners = new Map();
            this.className = ''; this.hidden = false; this.open = false; this.value = ''; this.max = 1;
            this.checked = false; this.disabled = false; this.text = '';
        }
        descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
        appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; return child; }
        append(...children) { children.forEach(child => this.appendChild(child)); }
        replaceChildren(...children) {
            this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.text = ''; this.append(...children);
        }
        remove() {
            if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
            this.parentNode = null;
        }
        set textContent(value) { this.replaceChildren(); this.text = String(value); }
        get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
        setAttribute(name, value) { this.attributes[name] = String(value); this[name] = String(value); }
        addEventListener(name, callback) {
            const values = this.listeners.get(name) || []; values.push(callback); this.listeners.set(name, values);
        }
        showModal() { this.open = true; }
        close() { this.open = false; (this.listeners.get('close') || []).forEach(callback => callback()); }
        focus() { doc.activeElement = this; }
        get isConnected() { return !!this.parentNode; }
        querySelectorAll(selector) {
            return this.descendants().filter(el => selector.split(',').some(part => {
                const query = part.trim();
                return query.startsWith('.') ? el.className.split(' ').includes(query.slice(1)) : el.tagName === query.toUpperCase();
            }));
        }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    }
    const doc = {body: new Element('body'), createElement: tag => new Element(tag)};
    const requests = [], pending = [], timers = new Map(), controllers = [];
    let nextTimer = 0;
    class AbortController {
        constructor() { this.signal = {aborted: false}; controllers.push(this); }
        abort() { this.signal.aborted = true; }
    }
    const win = {document: doc, AbortController,
        setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, {callback, delay}); return id; },
        clearTimeout(id) { timers.delete(id); },
        fetch(url, options) {
            const request = {url, method: options.method, body: options.body === undefined ? undefined : JSON.parse(options.body), signal: options.signal};
            requests.push(request); return new Promise(resolve => pending.push({request, resolve}));
        }};
    vm.runInNewContext(fs.readFileSync(require.resolve('../static/daki_test_packs.js'), 'utf8'), {window: win});
    function reply(data, status = 200, url) {
        const index = url ? pending.findIndex(entry => entry.request.url === url) : 0;
        assert.ok(index >= 0 && pending[index], `Expected API request${url ? ` to ${url}` : ''}`);
        const entry = pending.splice(index, 1)[0];
        entry.resolve({ok: status < 400, json: async () => ({status: status < 400 ? 'success' : 'error', ...data})});
        return entry.request;
    }
    function fireTimer() {
        const [id, timer] = timers.entries().next().value || [];
        assert.ok(timer, 'Expected a scheduled poll'); assert.equal(timer.delay, 900);
        timers.delete(id); return timer.callback();
    }
    return {win, doc, requests, pending, timers, controllers, reply, fireTimer,
        dialog: () => doc.body.querySelector('dialog'),
        button(text) {
            const found = doc.body.querySelectorAll('button').find(item => item.textContent === text);
            assert.ok(found, text); return found;
        },
        checkboxes: () => doc.body.querySelectorAll('input'),
        status: () => doc.body.querySelector('.daki-test-packs-status'),
        progress: () => doc.body.querySelector('progress'),
        progressDetail: () => doc.body.querySelector('.daki-test-packs-progress-detail'),
    };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const packId = letter => letter.repeat(32);
const packs = [
    {id: packId('a'), name: '상반신 test pack', image_count: 12, bytes: 1536, installed: false},
    {id: packId('b'), name: 'FullBody_MediumPack', image_count: 4, bytes: 1024 * 1024, installed: false},
    {id: packId('c'), name: '이미 저장된 테스트', image_count: 5, bytes: 2048, installed: true},
];
function job(status = 'running', overrides = {}) {
    return {id: packId('d'), status, message: status === 'failed' ? '다운로드 실패' : '', pack_name: '상반신 test pack',
        completed_packs: 0, total_packs: 2, installed: 0, skipped: 0, phase: 'download', phase_current: 1, phase_total: 3, ...overrides};
}
async function open(f, values = packs, currentJob = null) {
    const loading = f.win.DakiTestPacks.open();
    f.reply({packs: values, job: currentJob}, 200, '/api/daki/style-test-packs');
    await loading;
}

test('opens only on demand, lists shared tests, defaults to missing packs, and sends one exact selection', async () => {
    const f = fixture();
    assert.equal(f.requests.length, 0);
    const opening = f.win.DakiTestPacks.open();
    assert.equal(f.requests[0].url, '/api/daki/style-test-packs');
    f.reply({packs, job: null}); await opening;
    const [upper, medium, saved] = f.checkboxes();
    assert.equal(upper.checked, true); assert.equal(medium.checked, true);
    assert.equal(saved.checked, false); assert.equal(saved.disabled, true);
    assert.match(f.dialog().textContent, /저장됨/); assert.match(f.dialog().textContent, /FullBody_MediumPack/);
    medium.checked = false; medium.onchange();
    assert.equal(f.button('선택한 테스트 다운로드').disabled, false);
    const start = f.button('선택한 테스트 다운로드').onclick();
    const request = f.reply({job: job()}, 200, '/api/daki/style-test-packs'); await start;
    assert.deepEqual({url: request.url, method: request.method, body: request.body}, {
        url: '/api/daki/style-test-packs', method: 'POST', body: {pack_ids: [packId('a')]},
    });
    assert.equal(f.requests.filter(item => item.method === 'POST').length, 1);
    assert.equal(f.button('다운로드 중지').hidden, false);
    assert.equal(f.progress().hidden, false); assert.equal(f.progress().value, 1); assert.equal(f.progress().max, 3);
});

test('shows changing progress and posts one explicit stop request', async () => {
    const f = fixture(); await open(f, packs, job());
    assert.match(f.status().textContent, /다운로드 1 B \/ 3 B/);
    assert.doesNotMatch(f.status().textContent, /개 테스트 완료/);
    assert.match(f.progressDetail().textContent, /0\/2개 테스트/);
    const poll = f.fireTimer();
    f.reply({job: job('running', {phase: 'verify', phase_current: 2, installed: 1})}, 200, '/api/daki/style-test-packs/job');
    await poll;
    assert.match(f.status().textContent, /검증 2 B \/ 3 B/); assert.match(f.progressDetail().textContent, /1개 저장/);
    const stopping = f.button('다운로드 중지').onclick();
    const request = f.reply({job: job('stopping')}, 200, '/api/daki/style-test-packs/stop'); await stopping;
    assert.deepEqual({url: request.url, method: request.method, body: request.body}, {
        url: '/api/daki/style-test-packs/stop', method: 'POST', body: {},
    });
    assert.equal(f.button('다운로드 중지').hidden, true);
    f.win.DakiTestPacks.leave(); assert.equal(f.timers.size, 0);
});

test('terminal failure refreshes installed badges, preserves missing selection, and permits a retry', async () => {
    const f = fixture(), completed = [];
    const loading = f.win.DakiTestPacks.open({onComplete: value => completed.push(value)});
    f.reply({packs, job: null}); await loading;
    const starting = f.button('선택한 테스트 다운로드').onclick();
    const failed = job('failed', {installed: 1, completed_packs: 1, message: '테스트 하나를 설치하지 못했습니다.'});
    f.reply({job: failed}); await starting;
    assert.equal(completed.length, 1); assert.equal(completed[0].installed, 1);
    assert.equal(f.requests.at(-1).url, '/api/daki/style-test-packs');
    f.reply({packs: [packs[0], {...packs[1], installed: true}, packs[2]], job: failed}, 200, '/api/daki/style-test-packs');
    await flush();
    assert.equal(f.checkboxes()[1].checked, false); assert.equal(f.checkboxes()[1].disabled, true);
    assert.equal(f.button('선택한 테스트 다운로드').disabled, false);
    const retry = f.button('선택한 테스트 다운로드').onclick();
    const retried = f.reply({job: job()}, 200, '/api/daki/style-test-packs'); await retry;
    assert.deepEqual(retried.body, {pack_ids: [packId('a')]});
    assert.equal(completed.length, 1, 'a settled job invokes the callback once even when catalog refresh repeats it');
});

test('all installed packs disable selection and downloading', async () => {
    const f = fixture();
    await open(f, packs.map(pack => ({...pack, installed: true})));
    assert.equal(f.checkboxes().every(input => !input.checked && input.disabled), true);
    assert.equal(f.button('선택한 테스트 다운로드').disabled, true);
    assert.equal(f.button('받지 않은 테스트 모두 선택').disabled, true);
    assert.match(f.dialog().textContent, /모든 공유 테스트가 이미 저장되어 있습니다/);
});

test('closing keeps an active background download monitored, while leaving cancels it and ignores stale replies', async () => {
    const f = fixture(), completed = [];
    const loading = f.win.DakiTestPacks.open({onComplete: value => completed.push(value)});
    f.reply({packs, job: job()}, 200, '/api/daki/style-test-packs'); await loading;
    const dialog = f.dialog();
    f.button('닫기').onclick();
    assert.equal(f.dialog(), null); assert.equal(f.timers.size, 1);
    const poll = f.fireTimer();
    const done = job('completed', {completed_packs: 2, total_packs: 2, installed: 2, phase: 'complete', phase_current: 3, phase_total: 3});
    f.reply({job: done}, 200, '/api/daki/style-test-packs/job'); await poll;
    assert.equal(completed.length, 1); assert.equal(completed[0].installed, 2);
    assert.equal(f.pending.some(item => item.request.url === '/api/daki/style-test-packs'), false);
    f.win.DakiTestPacks.leave(); assert.equal(f.timers.size, 0);
    assert.equal(f.controllers[0].signal.aborted, true);
    assert.equal(dialog.open, false);
    const stale = fixture();
    const staleLoading = stale.win.DakiTestPacks.open({onComplete: value => completed.push(value)});
    stale.win.DakiTestPacks.leave();
    stale.reply({packs, job: done}, 200, '/api/daki/style-test-packs'); await staleLoading;
    assert.equal(stale.dialog(), null); assert.equal(completed.length, 1);
});

test('catalog failure keeps a retry action and retry restores the selection', async () => {
    const f = fixture(), opening = f.win.DakiTestPacks.open();
    f.reply({message: 'Synthetic catalog failure'}, 503, '/api/daki/style-test-packs'); await opening;
    assert.equal(f.button('선택한 테스트 다운로드').disabled, true);
    assert.equal(f.button('다시 불러오기').hidden, false);
    assert.match(f.status().textContent, /Synthetic catalog failure/);
    const retry = f.button('다시 불러오기').onclick();
    f.reply({packs, job: null}, 200, '/api/daki/style-test-packs'); await retry;
    assert.deepEqual(f.checkboxes().map(input => input.checked), [true, true, false]);
});

test('a late catalog reply from a closed view cannot populate the replacement dialog', async () => {
    const f = fixture(), oldLoad = f.win.DakiTestPacks.open();
    const oldDialog = f.dialog();
    f.win.DakiTestPacks.leave();
    const newLoad = f.win.DakiTestPacks.open();
    const newDialog = f.dialog();
    assert.notEqual(oldDialog, newDialog);
    f.reply({packs, job: null}, 200, '/api/daki/style-test-packs'); await oldLoad;
    assert.equal(f.dialog(), newDialog); assert.doesNotMatch(newDialog.textContent, /FullBody_MediumPack/);
    f.reply({packs, job: null}, 200, '/api/daki/style-test-packs'); await newLoad;
    assert.equal(f.dialog(), newDialog); assert.match(newDialog.textContent, /FullBody_MediumPack/);
});

test('opening on a previously completed job does not invoke completion or close the new dialog', async () => {
    const f = fixture(), completed = [];
    const opening = f.win.DakiTestPacks.open({onComplete: value => completed.push(value)});
    const existing = job('completed', {completed_packs: 2, total_packs: 2, installed: 2,
        phase: 'complete', phase_current: 3, phase_total: 3});
    f.reply({packs, job: existing}, 200, '/api/daki/style-test-packs'); await opening;
    assert.equal(f.dialog().open, true);
    assert.equal(completed.length, 0);
    assert.match(f.status().textContent, /다운로드 완료/);
    assert.equal(f.progressDetail().hidden, true);
});

test('phase progress uses byte and image units while resolve and install use human labels', async () => {
    const downloading = fixture();
    await open(downloading, packs, job('running', {phase_current: 1536, phase_total: 1024 * 1024}));
    assert.match(downloading.status().textContent, /다운로드 1\.5 KB \/ 1\.0 MB/);
    assert.doesNotMatch(downloading.status().textContent, /팩|개 테스트 완료/);
    downloading.win.DakiTestPacks.leave();

    const extracting = fixture();
    await open(extracting, packs, job('running', {phase: 'extract', phase_current: 4, phase_total: 12}));
    assert.match(extracting.status().textContent, /압축 해제 4\/12장/);
    extracting.win.DakiTestPacks.leave();

    const resolving = fixture();
    await open(resolving, packs, job('running', {phase: 'resolve', phase_current: 3, phase_total: 8}));
    assert.match(resolving.status().textContent, /목록 확인 중/);
    assert.doesNotMatch(resolving.status().textContent, /3\/8/);
    resolving.win.DakiTestPacks.leave();

    const installing = fixture();
    await open(installing, packs, job('running', {phase: 'install', phase_current: 2, phase_total: 5}));
    assert.match(installing.status().textContent, /테스트 저장 중/);
    assert.doesNotMatch(installing.status().textContent, /2\/5/);
    installing.win.DakiTestPacks.leave();
});

test('test pack row CSS overrides the shared dialog label display rule', () => {
    const css = fs.readFileSync(require.resolve('../static/daki_test_packs.css'), 'utf8');
    assert.match(css, /\.daki-test-packs-dialog \.daki-test-packs-row\s*\{[^}]*display:\s*grid;[^}]*margin:\s*0\s*!important;/);
});
