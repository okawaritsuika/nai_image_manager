const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
    class Element {
        constructor(tag) {
            this.tagName = tag;
            this.children = [];
            this.attributes = {};
            this.listeners = {};
            this.style = {};
            this.hidden = false;
            this.text = '';
        }
        appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
        append(...children) { children.forEach(child => this.appendChild(child)); }
        set textContent(value) { this.text = String(value); this.children = []; }
        get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
        setAttribute(key, value) { this.attributes[key] = String(value); }
        removeAttribute(key) { delete this.attributes[key]; }
        addEventListener(name, callback) { this.listeners[name] = callback; }
        dispatch(name, event = {}) { return this.listeners[name]?.(event); }
        all(tag) { return this.children.flatMap(child => [...(child.tagName === tag ? [child] : []), ...child.all(tag)]); }
    }

    const elements = new Map();
    for (const id of ['galleryIndexJobPanel', 'galleryIndexJobBody', 'galleryPromptIndexJobBody', 'dakiStyleSyncJobBody']) {
        elements.set(id, new Element('div'));
    }
    elements.get('galleryIndexJobBody').hidden = false;
    elements.get('galleryPromptIndexJobBody').hidden = true;
    elements.get('dakiStyleSyncJobBody').hidden = true;
    elements.get('galleryIndexJobPanel').hidden = false;

    const syncWindow = {document: {}, addEventListener() {}};
    vm.runInNewContext(fs.readFileSync(require.resolve('../static/daki_style_sync.js'), 'utf8'), {window: syncWindow});
    const jobProgress = syncWindow.DakiStyleSync.jobProgress;
    const requests = [], pending = [], timers = new Map(), listeners = {};
    let nextTimer = 0, completions = 0, opens = 0, refreshes = 0;
    const document = {
        readyState: 'complete',
        getElementById: id => elements.get(id) || null,
        createElement: tag => new Element(tag),
        addEventListener(name, callback) { listeners[`document:${name}`] = callback; },
    };
    const win = {
        document,
        console,
        addEventListener(name, callback) { listeners[name] = callback; },
        fetch(url, options) {
            requests.push({url, ...options});
            return new Promise((resolve, reject) => pending.push({resolve, reject}));
        },
        setTimeout(callback, delay) {
            const id = ++nextTimer;
            timers.set(id, {callback, delay});
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        refreshGalleryJobPanelVisibility() {
            refreshes++;
            const bodies = ['galleryIndexJobBody', 'galleryPromptIndexJobBody', 'dakiStyleSyncJobBody'];
            elements.get('galleryIndexJobPanel').hidden = bodies.every(id => elements.get(id).hidden);
        },
        DakiStyleSync: {
            open() { opens++; },
            jobProgress,
            jobText(job) {
                const published = job.published === true ? '반영됨'
                    : job.published === false ? '기존 목록 유지' : '반영 여부 확인 불가';
                const failed = Number.isSafeInteger(job.failed_images) ? ` · 이미지 실패 ${job.failed_images}` : '';
                return `${job.status} · ${published}${failed}${job.message ? ` · ${job.message}` : ''}`;
            },
            notifyActivityCompletion() { completions++; },
        },
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../static/daki_style_sync_activity.js'), 'utf8'), {window: win});

    async function flush() {
        for (let i = 0; i < 8; i++) await Promise.resolve();
    }
    function reply(data, status = 200, index = 0) {
        assert.ok(pending[index], `pending request ${index}`);
        const request = pending.splice(index, 1)[0];
        request.resolve({ok: status < 400, json: async () => ({status: status < 400 ? 'success' : 'error', ...data})});
        return flush();
    }
    function fail(error = new Error('offline'), index = 0) {
        assert.ok(pending[index], `pending request ${index}`);
        const request = pending.splice(index, 1)[0];
        request.reject(error);
        return flush();
    }
    async function fireTimer(expectedDelay) {
        const entry = [...timers.entries()][0];
        assert.ok(entry, 'scheduled timer');
        const [id, timer] = entry;
        if (expectedDelay !== undefined) assert.equal(timer.delay, expectedDelay);
        timers.delete(id);
        timer.callback();
        await flush();
    }
    return {
        win, elements, requests, pending, timers, reply, fail, flush, fireTimer,
        completions: () => completions,
        opens: () => opens,
        refreshes: () => refreshes,
        body: () => elements.get('dakiStyleSyncJobBody'),
        panel: () => elements.get('galleryIndexJobPanel'),
        otherBody: () => elements.get('galleryIndexJobBody'),
        button(label) {
            const button = this.body().all('button').find(item => item.textContent === label);
            assert.ok(button, label);
            return button;
        },
        event(name, event = {}) { return listeners[name]?.(event); },
    };
}

const job = (status = 'running', extra = {}) => ({
    status, source: 'huggingface', started_at: '2026-10-25T01:02:03Z',
    downloaded_bytes: 10, total_bytes: 100, downloaded_images: 2, added: 0, updated: 0, skipped: 0, failed_images: 0,
    ...extra,
});

test('bootstrap shows running jobs but leaves an old completed job quiet', async () => {
    const running = fixture();
    assert.equal(running.requests.length, 1);
    assert.equal(running.requests[0].method, 'GET');
    assert.equal(running.requests[0].cache, 'no-store');
    await running.reply({job: job()});
    assert.equal(running.body().hidden, false);
    assert.equal(running.timers.size, 1);

    const old = fixture();
    await old.reply({job: job('completed', {started_at: '2026-10-24T00:00:00Z'})});
    assert.equal(old.body().hidden, true);
    assert.equal(old.completions(), 0);
    assert.equal(old.timers.size, 0);
});

test('running work polls to a persistent terminal card and dismissal preserves other cards', async () => {
    const f = fixture();
    await f.reply({job: job()});
    await f.fireTimer(1000);
    await f.reply({job: job('completed', {published: true, updated: 2})});
    assert.equal(f.body().hidden, false);
    assert.match(f.body().textContent, /완료/);
    assert.equal(f.completions(), 1);
    assert.equal(f.timers.size, 0);

    const originalCard = f.otherBody();
    await f.button('알림 닫기').dispatch('click');
    assert.equal(f.body().hidden, true);
    assert.equal(f.otherBody(), originalCard);
    assert.equal(originalCard.hidden, false);
    assert.equal(f.panel().hidden, false);
});

test('attach pauses polling, stale responses cannot replace an observed job, and reopen resumes once', async () => {
    const f = fixture();
    await f.reply({job: job()});
    await f.fireTimer(1000);
    assert.equal(f.pending.length, 1);

    f.win.DakiStyleSyncActivity.attach();
    f.win.DakiStyleSyncActivity.attach();
    assert.equal(f.body().hidden, true);
    assert.equal(f.timers.size, 0);
    f.win.DakiStyleSyncActivity.observe(job('running', {started_at: '2026-10-25T01:02:04Z', message: '새 작업'}));
    await f.reply({job: job('completed')});
    assert.equal(f.completions(), 0);

    f.win.DakiStyleSyncActivity.detach();
    assert.equal(f.body().hidden, false);
    assert.match(f.body().textContent, /새 작업/);
    assert.doesNotMatch(f.body().textContent, /완료/);
    assert.equal(f.timers.size, 1);
    f.win.DakiStyleSyncActivity.detach();
    assert.equal(f.timers.size, 1);
});

test('a start accepted after modal close recovers a pending job and invalidates an old read', async () => {
    const f = fixture();
    await f.reply({job: null});
    f.win.DakiStyleSyncActivity.attach();
    f.win.DakiStyleSyncActivity.detach({check: true});
    assert.equal(f.pending.length, 1);
    f.win.DakiStyleSyncActivity.observe(job('running', {started_at: '2026-10-25T02:00:00Z'}), {started: true});
    await f.reply({job: job('failed', {started_at: '2026-10-24T23:00:00Z'})});
    assert.equal(f.body().hidden, false);
    assert.match(f.body().textContent, /running/);
    assert.equal(f.completions(), 0);
    assert.equal(f.timers.size, 1);
});

test('a terminal start result is tracked once and attached modal results do not call completion', async () => {
    const f = fixture();
    await f.reply({job: null});
    const terminal = job('completed', {started_at: '2026-10-25T03:00:00Z', published: false});
    f.win.DakiStyleSyncActivity.observe(terminal, {started: true});
    f.win.DakiStyleSyncActivity.observe(terminal, {started: true});
    assert.equal(f.body().hidden, false);
    assert.equal(f.completions(), 1);

    f.win.DakiStyleSyncActivity.attach();
    const modalTerminal = job('completed', {started_at: '2026-10-25T04:00:00Z', published: true});
    f.win.DakiStyleSyncActivity.observe(modalTerminal, {started: true});
    assert.equal(f.body().hidden, true);
    assert.equal(f.completions(), 1);
    f.win.DakiStyleSyncActivity.detach();
    assert.equal(f.body().hidden, false);
    assert.match(f.body().textContent, /반영됨/);
    assert.equal(f.completions(), 1);
});

test('a failed running read keeps its snapshot, retries after two seconds, then clears the warning', async () => {
    const f = fixture();
    await f.reply({job: job()});
    await f.fireTimer(1000);
    await f.fail();
    assert.match(f.body().textContent, /진행 상태 연결을 다시 확인하고 있습니다/);
    assert.equal(f.timers.size, 1);
    await f.fireTimer(2000);
    await f.reply({job: job('running', {downloaded_bytes: 35})});
    assert.doesNotMatch(f.body().textContent, /진행 상태 연결을 다시 확인하고 있습니다/);
    assert.equal(f.timers.size, 1);
    assert.equal([...f.timers.values()][0].delay, 1000);
});

test('pagehide clears reads without stopping the server and persisted pageshow recovers once', async () => {
    const f = fixture();
    await f.reply({job: job()});
    assert.equal(f.timers.size, 1);
    f.event('pagehide');
    assert.equal(f.timers.size, 0);
    assert.equal(f.requests.every(request => request.method === 'GET'), true);
    f.event('pageshow', {persisted: false});
    assert.equal(f.requests.length, 1);
    f.event('pageshow', {persisted: true});
    assert.equal(f.requests.length, 2);
    await f.reply({job: job('running', {downloaded_bytes: 50})});
    assert.equal(f.timers.size, 1);
    assert.equal(f.requests.every(request => request.method === 'GET'), true);
});

test('persisted pageshow resumes a running job after pagehide removed its attached modal', async () => {
    const f = fixture();
    await f.reply({job: null});
    f.win.DakiStyleSyncActivity.attach();
    f.win.DakiStyleSyncActivity.observe(job('running', {started_at: '2026-10-25T05:00:00Z'}));
    assert.equal(f.body().hidden, true);
    assert.equal(f.requests.length, 1);

    f.event('pagehide');
    assert.equal(f.requests.length, 1);
    assert.equal(f.timers.size, 0);
    assert.equal(f.requests.every(request => request.method === 'GET'), true);

    f.event('pageshow', {persisted: true});
    assert.equal(f.body().hidden, false);
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].method, 'GET');
    await f.reply({job: job('running', {started_at: '2026-10-25T05:00:00Z'})});
    assert.equal(f.timers.size, 1);
    assert.equal(f.completions(), 0);
});

test('background progress uses the shared phase formatter and marks unknown totals indeterminate', async () => {
    const f = fixture();
    await f.reply({job: job('running', {phase: 'inspect', processed_images: 1200, total_images: 4425, downloaded_images: 4000})});
    const meter = f.body().all('div').find(item => item.attributes.role === 'progressbar');
    assert.ok(meter);
    assert.equal(meter.attributes['aria-label'], '그림체 검사 진행률');
    assert.equal(meter.attributes['aria-valuenow'], '27');
    assert.equal(meter.children[0].style.width, '27%');
    assert.match(f.body().textContent, /그림체 검사 1,200 \/ 4,425장 · 27%/);
    assert.match(f.body().textContent, /running/);
    await f.button('자세히 보기').dispatch('click');
    assert.equal(f.opens(), 1);

    const legacy = fixture();
    await legacy.reply({job: job('running', {downloaded_bytes: 250, total_bytes: 100})});
    const legacyMeter = legacy.body().all('div').find(item => item.attributes.role === 'progressbar');
    assert.equal(legacyMeter.attributes['aria-label'], '다운로드 이후 처리 진행률');
    assert.equal(legacyMeter.attributes['aria-valuenow'], undefined);
    assert.equal(legacyMeter.children[0].style.width, '38%');
    assert.match(legacy.body().textContent, /다운로드 이후 처리 중 · 확인한 그림 2장/);

    const unknown = fixture();
    await unknown.reply({job: job('running', {source: 'arca', downloaded_bytes: 20, total_bytes: 0})});
    assert.equal(unknown.body().all('div').some(item => item.attributes.role === 'progressbar'), true);
    const unknownMeter = unknown.body().all('div').find(item => item.attributes.role === 'progressbar');
    assert.equal(unknownMeter.hidden, false);
    assert.equal(unknownMeter.attributes['aria-valuenow'], undefined);
    assert.doesNotMatch(unknown.body().textContent, /다운로드 \d+%/);
});

test('job summaries preserve publication and partial-failure wording while rendering messages as text', async () => {
    for (const [published, expected] of [[true, /반영됨/], [false, /기존 목록 유지/], [null, /반영 여부 확인 불가/]]) {
        const f = fixture();
        await f.reply({job: job('running')});
        f.win.DakiStyleSyncActivity.observe(job('completed', {
            published, failed_images: 2, message: '<img src=x onerror=bad()>',
        }));
        assert.match(f.body().textContent, expected);
        assert.match(f.body().textContent, /이미지 실패 2/);
        assert.match(f.body().textContent, /<img src=x onerror=bad\(\)>/);
        assert.equal(f.body().all('img').length, 0);
        assert.equal(f.completions(), 1);
    }
});
