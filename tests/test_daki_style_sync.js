const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
    class Element {
        constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.style = {}; this.text = ''; this.value = ''; this.open = false; this.hidden = false; }
        appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
        append(...children) { children.forEach(child => this.appendChild(child)); }
        set textContent(value) { this.text = value; this.children = []; }
        get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
        setAttribute(key, value) { this.attributes[key] = value; }
        removeAttribute(key) { delete this.attributes[key]; }
        addEventListener(name, callback) { this.listeners[name] = callback; }
        showModal() { this.open = true; }
        close() { this.open = false; this.listeners.close?.(); }
        remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
        all(tag) { return this.children.flatMap(child => [...(child.tagName === tag ? [child] : []), ...child.all(tag)]); }
    }
    const body = new Element('body'), pending = [], timers = new Map(), requests = [], completed = [], activity = [];
    let nextTimer = 0;
    const win = {document: {body, createElement: tag => new Element(tag)},
        DakiStyleSyncActivity: {
            attach() { activity.push({type: 'attach'}); },
            observe(job, options) { activity.push({type: 'observe', job, options}); },
            detach(options) { activity.push({type: 'detach', options}); },
        },
        fetch(url, options) {
            const request = {url, method: options.method, body: options.body && JSON.parse(options.body)};
            requests.push(request); return new Promise((resolve, reject) => pending.push({resolve, reject}));
        },
        setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, {callback, delay}); return id; },
        clearTimeout(id) { timers.delete(id); },
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../static/daki_style_sync.js'), 'utf8'), {window: win});
    function reply(data = {}, status = 200) {
        assert.ok(pending.length); pending.shift().resolve({ok: status < 400, json: async () => ({status: status < 400 ? 'success' : 'error', ...data})});
    }
    return {win, body, pending, timers, requests, completed, activity, reply,
        open: () => win.DakiStyleSync.open({onComplete: job => completed.push(job)}),
        button(text) { const button = body.all('button').find(button => button.textContent === text); assert.ok(button, text); return button; },
        input(name) { return [...body.all('input'), ...body.all('textarea'), ...body.all('select')].find(input => input.name === name); },
        toggle(inputName, label) {
            const input = this.input(inputName), section = input?.parentNode?.parentNode;
            const button = section?.all('button').find(candidate => candidate.textContent === label);
            assert.ok(button, `${inputName}: ${label}`); return button;
        },
        flush() { return new Promise(resolve => setImmediate(resolve)); },
        fireTimer() { const [id, timer] = timers.entries().next().value; assert.equal(timer.delay, 1000); timers.delete(id); return timer.callback(); },
    };
}
const job = (status = 'running', extra = {}) => ({status, scanned_posts: 3, downloaded_images: 2, added: 1, skipped: 1, ...extra});
async function connected(f) { const open = f.open(); f.reply({connected: true, job: null}); await open; }

test('connection help and every opening request fresh dates and extension state', async () => {
    const f = fixture(), first = f.open();
    assert.equal(f.body.all('dialog')[0].className, 'daki-dialog daki-style-sync-dialog');
    assert.equal(f.button('가져오기 시작').disabled, true);
    assert.match(f.body.textContent, /V5 Full Medium/);
    assert.match(f.body.textContent, /NAI · 🔞 NAI/);
    assert.equal(f.body.all('a')[0].href, '/api/daki/shared-styles/sync/extension');
    const help = f.body.all('details').find(details => details.children[0]?.textContent === '아카라이브 로그인 연결 방법');
    const [summary, helpBody] = help.children;
    assert.equal(help.className, 'daki-style-sync-help');
    assert.equal(summary.tagName, 'summary');
    assert.equal(summary.textContent, '아카라이브 로그인 연결 방법');
    assert.equal(helpBody.tagName, 'div');
    assert.equal(helpBody.className, 'daki-style-sync-help-body');
    assert.equal(helpBody.children[0], f.body.all('a')[0]);
    assert.equal(helpBody.children[0].className, 'daki-style-sync-download');
    assert.deepEqual(helpBody.children.map(child => child.tagName), ['a', 'p', 'p']);
    assert.match(helpBody.textContent, /‘현재 로그인 연결’/);
    assert.match(helpBody.textContent, /NAI Image Manager\(5000\).*NAImakeArtistGroup\(5001\).*각각/);
    assert.match(helpBody.textContent, /최근 게시일~오늘.*직접 변경/);
    const queryHelp = f.body.all('details').find(details => details.children[0]?.textContent === '포함 검색 문법과 예시');
    assert.match(queryHelp.children[1].children[0].textContent, /빈칸은 제한 없음.*함께 적용.*원본 긍정 프롬프트/);
    assert.equal(queryHelp.children[1].children[1].className, 'daki-style-sync-examples');
    assert.equal(queryHelp.children[1].children[1].children.length, 4);
    f.reply({connected: false, job: null}); await first;
    f.input('start_date').value = '2026-01-02';
    const check = f.button('연결 상태 확인').onclick(); f.reply({connected: true, job: null}); await check;
    assert.equal(f.button('가져오기 시작').disabled, false);
    f.button('닫기').onclick();
    const reopen = f.open();
    assert.notEqual(f.input('start_date').value, '2026-01-02');
    f.reply({connected: true, job: null}); await reopen;
});

test('date validation and single start, polling completion, then close reload callback', async () => {
    const f = fixture(); await connected(f);
    f.input('start_date').value = '2026-02-02'; f.input('end_date').value = '2026-02-01';
    await f.button('가져오기 시작').onclick(); assert.equal(f.pending.length, 0);
    assert.match(f.body.textContent, /시작일과 종료일/);
    f.input('end_date').value = '2026-02-03';
    const start = f.button('가져오기 시작').onclick();
    await f.button('가져오기 시작').onclick(); assert.equal(f.pending.length, 1);
    assert.deepEqual(f.requests.at(-1), {url: '/api/daki/shared-styles/sync', method: 'POST', body: {
        start_date: '2026-02-02', end_date: '2026-02-03', filters: {
            exclude_realistic: true, include_query: '', exclude_tags: [], low_recommendation_limit: null}}});
    f.reply({connected: true, job: job()}); await start;
    assert.equal(f.button('가져오기 시작').disabled, true);
    await f.button('가져오기 시작').onclick(); assert.equal(f.pending.length, 0);
    const poll = f.fireTimer(); f.reply({connected: true, job: job('completed')}); await poll;
    assert.equal(f.timers.size, 0); assert.match(f.body.textContent, /수집 완료.*추가 1.*건너뜀 1/);
    assert.equal(f.completed.length, 0);
    f.button('닫기').onclick(); assert.equal(f.completed.length, 1);
});

test('reopen reconnects to a running collection and stop does not start another', async () => {
    const f = fixture(), open = f.open(); f.reply({connected: true, job: job()}); await open;
    assert.equal(f.button('수집 중지').disabled, false);
    const stop = f.button('수집 중지').onclick();
    assert.deepEqual(f.requests.at(-1), {url: '/api/daki/shared-styles/sync/stop', method: 'POST', body: {}});
    f.reply({connected: true, job: job('stopped')}); await stop;
    assert.equal(f.timers.size, 0); assert.match(f.body.textContent, /수집 중지됨/);
});

test('request failure enables explicit check and keeps a running start blocked', async () => {
    const f = fixture(), open = f.open(); f.reply({connected: true, job: job()}); await open;
    const poll = f.fireTimer(); f.reply({message: 'Synthetic failure'}, 500); await poll;
    assert.match(f.body.textContent, /Synthetic failure/);
    assert.doesNotMatch(f.body.textContent, /창을 닫아도 수집은 계속됩니다/);
    assert.equal(f.button('연결 상태 확인').disabled, false);
    assert.equal(f.button('가져오기 시작').disabled, true);
    const retry = f.button('연결 상태 확인').onclick(); f.reply({connected: true, job: job()}); await retry;
    assert.equal(f.timers.size, 1);
});

test('collection guidance describes the current job and never claims a failed job continues', async () => {
    const f = fixture(); await connected(f);
    assert.doesNotMatch(f.body.textContent, /창을 닫아도 수집은 계속됩니다/);
    for (const [state, guidance] of [
        ['running', /창을 닫아도 수집은 계속됩니다/],
        ['failed', /수집이 중단되었습니다.*다시 시작/],
        ['stopped', /수집이 중지되었습니다.*다시 시작/],
        ['completed', /수집이 완료되었습니다/],
    ]) {
        const check = f.button('연결 상태 확인').onclick();
        f.reply({connected: true, job: job(state)}); await check;
        assert.match(f.body.textContent, guidance);
        if (state !== 'running') assert.doesNotMatch(f.body.textContent, /창을 닫아도 수집은 계속됩니다/);
    }
});

test('close and leave ignore pending replies and cancel polling without stopping server', async () => {
    for (const leaving of [false, true]) {
        const f = fixture(), open = f.open(), modal = f.body.all('dialog')[0];
        if (leaving) f.win.DakiStyleSync.leave(); else f.button('닫기').onclick();
        f.reply({connected: true, job: job('completed')}); await open;
        assert.equal(f.body.all('dialog').length, 0); assert.equal(f.timers.size, 0);
        assert.equal(f.completed.length, 0); assert.equal(f.requests.length, 1);
        assert.doesNotMatch(modal.textContent, /수집 완료/);
    }
    const f = fixture(), open = f.open(); f.reply({connected: true, job: job()}); await open;
    f.win.DakiStyleSync.leave(); assert.equal(f.timers.size, 0);
});

test('activity attachment preserves a late accepted start and refreshes a reopened modal after the POST settles', async () => {
    const f = fixture(), open = f.open();
    assert.deepEqual(f.activity[0], {type: 'attach'});
    f.reply({connected: false, job: null}); await open;
    const start = f.button('Hugging Face 새 그림체 추가').onclick();
    assert.equal(f.button('Hugging Face 새 그림체 추가').disabled, true);
    f.button('닫기').onclick();
    assert.equal(f.activity.at(-1).type, 'detach');
    assert.equal(f.activity.at(-1).options.check, true);

    const reopened = f.open();
    assert.equal(f.button('Hugging Face 새 그림체 추가').disabled, true);
    assert.equal(f.pending.length, 2);
    f.pending.splice(1, 1)[0].resolve({ok: true, json: async () => ({status: 'success', connected: false, job: null})});
    await reopened;
    assert.equal(f.button('Hugging Face 새 그림체 추가').disabled, true);
    assert.equal(f.requests.length, 3);
    const running = job('running', {source: 'huggingface'});
    f.reply({connected: false, job: running}); await start;
    assert.equal(f.activity.filter(call => call.type === 'observe').at(-1).options.started, true);
    assert.equal(f.pending.length, 1);

    f.reply({connected: false, job: running}); await f.flush();
    assert.equal(f.button('Hugging Face 새 그림체 추가').disabled, true);
    assert.equal(f.activity.filter(call => call.type === 'observe').at(-1).options.started, false);
    f.button('닫기').onclick();
    assert.equal(f.activity.at(-1).type, 'detach');
    assert.equal(f.activity.at(-1).options.check, false);
});

test('a terminal start is observed and completion callback fires once', async () => {
    const f = fixture(), open = f.open();
    f.reply({connected: false, job: null}); await open;
    const terminal = job('completed', {source: 'huggingface', published: true, started_at: '2026-10-25T03:00:00Z'});
    const start = f.button('Hugging Face 새 그림체 추가').onclick();
    f.reply({connected: false, job: terminal}); await start;
    assert.equal(f.activity.filter(call => call.type === 'observe' && call.job?.status === 'completed').length, 1);
    f.button('닫기').onclick();
    f.win.DakiStyleSync.notifyActivityCompletion(terminal);
    assert.equal(f.completed.length, 1);
    assert.equal(f.activity.at(-1).type, 'detach');
    assert.equal(f.activity.at(-1).options.check, false);
});

test('image errors show partial collection and preserved connection instead of a full success', async () => {
    const f = fixture(), open = f.open();
    f.reply({connected: true, job: job('completed', {failed_images: 2,
        last_image_error: '이미지 HTTP 429 <img src=x>', message: '이미지 2개를 받지 못했습니다.'})});
    await open;
    assert.match(f.body.textContent, /수집 완료\(일부 이미지 실패\)/);
    assert.match(f.body.textContent, /이미지 실패 2.*HTTP 429/);
    assert.match(f.body.textContent, /같은 기간으로 다시 실행/);
    assert.doesNotMatch(f.body.textContent, /수집이 완료되었습니다/);
    assert.match(f.body.textContent, /확장 프로그램 연결됨/);
    assert.equal(f.button('가져오기 시작').disabled, false);
    assert.equal(f.body.all('img').length, 0);
    f.button('닫기').onclick();
    assert.equal(f.completed[0].failed_images, 2);
});

test('replaced dialog ignores old response and displays server messages as text', async () => {
    const f = fixture(), old = f.open(); f.win.DakiStyleSync.leave();
    const opened = f.open(); f.reply({connected: true, job: job('completed')}); await old;
    f.reply({connected: true, job: job('failed', {message: '<img src=x onerror=bad()>'})}); await opened;
    assert.match(f.body.textContent, /<img src=x onerror=bad\(\)>/);
    assert.equal(f.body.all('img').length, 0); assert.equal(f.completed.length, 0);
});

test('latest owned post date defaults apply once per opening and keep the same day', async () => {
    const f = fixture(), open = f.open();
    f.reply({connected: true, defaults: {start_date: '2026-09-30', end_date: '2026-10-17', basis: 'latest_style'}}); await open;
    assert.equal(f.input('start_date').value, '2026-09-30');
    assert.equal(f.input('end_date').value, '2026-10-17');
    f.input('start_date').value = '2026-09-01'; f.input('start_date').oninput();
    const check = f.button('연결 상태 확인').onclick();
    f.reply({connected: true, defaults: {start_date: '2026-10-01', end_date: '2026-10-18'}}); await check;
    assert.equal(f.input('start_date').value, '2026-09-01');
    assert.equal(f.input('end_date').value, '2026-10-17');
    const start = f.button('가져오기 시작').onclick();
    f.reply({connected: true, job: job(), defaults: {start_date: '2026-10-02', end_date: '2026-10-18'}}); await start;
    const poll = f.fireTimer();
    f.reply({connected: true, job: job('completed'), defaults: {start_date: '2026-10-03', end_date: '2026-10-18'}}); await poll;
    assert.equal(f.input('start_date').value, '2026-09-01');
    f.button('닫기').onclick();
    const reopen = f.open();
    f.reply({connected: true, defaults: {start_date: '2026-10-05', end_date: '2026-10-18'}}); await reopen;
    assert.equal(f.input('start_date').value, '2026-10-05');
    assert.equal(f.input('end_date').value, '2026-10-18');
});

test('editing dates while first response loads protects the entire chosen period', async () => {
    for (const event of ['oninput', 'onchange']) {
        const f = fixture(), open = f.open();
        assert.equal(f.input('start_date').disabled, false);
        const originalEnd = f.input('end_date').value;
        f.input('start_date').value = '2026-08-01'; f.input('start_date')[event]();
        f.reply({connected: true, defaults: {start_date: '2026-09-30', end_date: '2026-10-17'}}); await open;
        assert.equal(f.input('start_date').value, '2026-08-01');
        assert.equal(f.input('end_date').value, originalEnd);
    }
});

test('missing and invalid default dates safely fall back without accepting impossible dates', async () => {
    for (const defaults of [undefined, null, {start_date: '2026-02-30', end_date: 'bad'}, {start_date: '<img>', end_date: null}]) {
        const f = fixture(), open = f.open(), today = f.input('end_date').value;
        f.reply({connected: true, defaults}); await open;
        assert.equal(f.input('start_date').value, today);
        assert.equal(f.input('end_date').value, today);
        f.input('start_date').value = '2026-02-30'; f.input('end_date').value = '2026-03-01';
        await f.button('가져오기 시작').onclick(); assert.equal(f.pending.length, 0);
    }
    const f = fixture(), open = f.open();
    f.reply({defaults: {start_date: null, end_date: '2026-10-17', basis: 'today'}}); await open;
    assert.equal(f.input('start_date').value, '2026-10-17');
});

test('Hugging Face import needs no login or dates and blocks repeated starts until done', async () => {
    const f = fixture(), open = f.open();
    f.reply({connected: false, job: null}); await open;
    assert.equal(f.button('가져오기 시작').disabled, true);
    assert.equal(f.button('Hugging Face 새 그림체 추가').disabled, false);
    assert.match(f.body.textContent, /V5 Full · V5 Full Medium의 새 그림체.*기존 그림과 테스트는 유지/);
    assert.doesNotMatch(f.body.textContent, /648MB/);
    assert.equal(f.input('exclude_realistic').checked, true);
    assert.equal(f.input('include_mode'), undefined);
    assert.equal(f.input('include_query').maxLength, 20000);
    f.input('start_date').value = '';
    const start = f.button('Hugging Face 새 그림체 추가').onclick();
    assert.deepEqual(f.requests.at(-1).body, {source: 'huggingface', filters: {
        exclude_realistic: true, include_query: '', exclude_tags: [], low_recommendation_limit: null}});
    await f.button('Hugging Face 새 그림체 추가').onclick(); assert.equal(f.pending.length, 1);
    f.reply({connected: false, job: job('running', {source: 'huggingface', downloaded_bytes: 1000000, total_bytes: 648000000})}); await start;
    assert.match(f.body.textContent, /Hugging Face · 수집 중 · 다운로드 1 MB \/ 648 MB/);
    assert.equal(f.button('Hugging Face 새 그림체 추가').disabled, true);
    for (const name of ['exclude_realistic', 'include_query', 'exclude_tags', 'limit_low_recommendations', 'recommendation_threshold',
        'arca_exclude_realistic', 'arca_include_query', 'arca_exclude_tags', 'arca_limit_low_recommendations', 'arca_recommendation_threshold']) {
        assert.equal(f.input(name).disabled, true);
    }
    assert.equal(f.toggle('include_query', '제외 태그').disabled, undefined);
    f.toggle('include_query', '제외 태그').onclick();
    assert.equal(f.input('include_query').parentNode.hidden, true);
    assert.equal(f.input('exclude_tags').parentNode.hidden, false);
    assert.equal(f.button('가져오기 시작').disabled, true);
    assert.equal(f.button('수집 중지').disabled, false);
    await f.button('가져오기 시작').onclick(); await f.button('Hugging Face 새 그림체 추가').onclick();
    assert.equal(f.pending.length, 0);
    const poll = f.fireTimer();
    f.reply({connected: false, job: job('completed', {source: 'huggingface'})}); await poll;
    assert.equal(f.button('Hugging Face 새 그림체 추가').disabled, false);
    f.button('닫기').onclick(); assert.equal(f.completed.length, 1);
    assert.equal(f.completed[0].source, 'huggingface');
});

test('Hugging Face download errors allow explicit retry and stop uses the existing job endpoint', async () => {
    const f = fixture(), open = f.open(); f.reply({connected: false}); await open;
    const first = f.button('Hugging Face 새 그림체 추가').onclick();
    f.reply({message: 'Synthetic download error'}, 500); await first;
    assert.match(f.body.textContent, /Synthetic download error/);
    assert.equal(f.button('Hugging Face 새 그림체 추가').disabled, false);
    const retry = f.button('Hugging Face 새 그림체 추가').onclick();
    f.reply({connected: false, job: job('failed', {source: 'huggingface'})}); await retry;
    assert.equal(f.button('Hugging Face 새 그림체 추가').disabled, false);
    const again = f.button('Hugging Face 새 그림체 추가').onclick();
    f.reply({connected: false, job: job('running', {source: 'huggingface'})}); await again;
    const stop = f.button('수집 중지').onclick();
    assert.deepEqual(f.requests.at(-1), {url: '/api/daki/shared-styles/sync/stop', method: 'POST', body: {}});
    f.reply({connected: false, job: job('stopped', {source: 'huggingface'})}); await stop;
    assert.equal(f.button('Hugging Face 새 그림체 추가').disabled, false);
    assert.equal(f.timers.size, 0);
});

test('Hugging Face submits a trimmed include query and keeps comma/newline exclusions as exact tags', async () => {
    const f = fixture(); await connected(f);
    f.input('exclude_realistic').checked = false; f.input('exclude_realistic').onchange();
    f.input('include_query').value = ' watercolor, sketch || ink ';
    f.input('include_query').oninput();
    f.input('exclude_tags').value = ' monochrome\n, blurry, ';
    f.input('exclude_tags').oninput();
    const start = f.button('Hugging Face 새 그림체 추가').onclick();
    assert.deepEqual(f.requests.at(-1).body, {source: 'huggingface', filters: {
        exclude_realistic: false, include_query: 'watercolor, sketch || ink',
        exclude_tags: ['monochrome', 'blurry'], low_recommendation_limit: null}});
    f.reply({connected: false, job: job('completed', {source: 'huggingface', published: true})}); await start;
});

test('both source cards keep independent filter values behind a single full-width editor and apply them on start', async () => {
    const f = fixture(); await connected(f);
    for (const name of ['exclude_realistic', 'arca_exclude_realistic']) assert.equal(f.input(name).checked, true);
    for (const name of ['include_query', 'exclude_tags', 'arca_include_query', 'arca_exclude_tags']) assert.equal(f.input(name).value, '');
    for (const prefix of ['', 'arca_']) {
        const enabled = f.input(`${prefix}limit_low_recommendations`), threshold = f.input(`${prefix}recommendation_threshold`);
        assert.equal(enabled.checked, false); assert.equal(threshold.value, '10');
        assert.equal(threshold.type, 'number'); assert.equal(threshold.step, '1');
        assert.equal(threshold.min, '0'); assert.equal(threshold.max, String(Number.MAX_SAFE_INTEGER));
        f.input(`${prefix}include_query`).value = prefix ? 'line_art || ink' : ' watercolor, sketch || ink ';
        f.input(`${prefix}include_query`).oninput();
        f.input(`${prefix}exclude_tags`).value = prefix ? 'no humans' : 'monochrome\n, blurry';
        f.input(`${prefix}exclude_tags`).oninput();
        enabled.checked = true; enabled.onchange();
        threshold.value = prefix ? '0' : '10'; threshold.oninput();
    }
    for (const [includeName, excludeName] of [['include_query', 'exclude_tags'], ['arca_include_query', 'arca_exclude_tags']]) {
        const include = f.input(includeName), exclude = f.input(excludeName);
        assert.equal(include.rows, 2); assert.equal(exclude.rows, 2);
        assert.equal(include.parentNode.children.length, 1); assert.equal(exclude.parentNode.children.length, 1);
        assert.equal(include.attributes['aria-label'], '포함 태그'); assert.equal(exclude.attributes['aria-label'], '제외 태그');
        assert.equal(include.parentNode.hidden, false); assert.equal(exclude.parentNode.hidden, true);
        assert.equal(f.toggle(includeName, '포함 태그').attributes['aria-pressed'], 'true');
        assert.equal(f.toggle(includeName, '제외 태그').attributes['aria-pressed'], 'false');
        f.toggle(includeName, '제외 태그').onclick();
        assert.equal(include.parentNode.hidden, true); assert.equal(exclude.parentNode.hidden, false);
        assert.equal(f.toggle(includeName, '포함 태그').attributes['aria-pressed'], 'false');
        assert.equal(f.toggle(includeName, '제외 태그').attributes['aria-pressed'], 'true');
        assert.equal(include.value, includeName.startsWith('arca_') ? 'line_art || ink' : ' watercolor, sketch || ink ');
        assert.equal(exclude.value, includeName.startsWith('arca_') ? 'no humans' : 'monochrome\n, blurry');
        const prefix = includeName.startsWith('arca_') ? 'arca_' : '';
        assert.equal(f.input(`${prefix}recommendation_threshold`).value, prefix ? '0' : '10');
        assert.equal(f.input(`${prefix}limit_low_recommendations`).checked, true);
    }

    f.input('arca_exclude_realistic').checked = false;
    f.input('arca_exclude_realistic').onchange();

    const hfStart = f.button('Hugging Face 새 그림체 추가').onclick();
    assert.deepEqual(f.requests.at(-1).body, {source: 'huggingface', filters: {
        exclude_realistic: true, include_query: 'watercolor, sketch || ink', exclude_tags: ['monochrome', 'blurry'], low_recommendation_limit: 10}});
    assert.equal(f.input('include_query').disabled, true);
    assert.equal(f.toggle('include_query', '포함 태그').disabled, undefined);
    f.toggle('include_query', '포함 태그').onclick();
    assert.equal(f.input('include_query').parentNode.hidden, false);
    assert.equal(f.input('exclude_tags').parentNode.hidden, true);
    f.reply({connected: true, job: job('completed', {source: 'huggingface'})}); await hfStart;

    const arcaStart = f.button('가져오기 시작').onclick();
    const arcaBody = f.requests.at(-1).body;
    assert.deepEqual(arcaBody, {start_date: f.input('start_date').value, end_date: f.input('end_date').value,
        filters: {exclude_realistic: false, include_query: 'line_art || ink', exclude_tags: ['no humans'], low_recommendation_limit: 0}});
    f.reply({connected: true, job: job('completed', {source: 'arca'})}); await arcaStart;
});

test('recommendation limits validate when enabled and remain unconstrained when disabled', async () => {
    for (const [prefix, action] of [['', 'Hugging Face 새 그림체 추가'], ['arca_', '가져오기 시작']]) {
        for (const invalid of ['1.5', '-1', '', '9007199254740992']) {
            const f = fixture(); await connected(f);
            f.input(`${prefix}limit_low_recommendations`).checked = true;
            f.input(`${prefix}limit_low_recommendations`).onchange();
            f.input(`${prefix}recommendation_threshold`).value = invalid;
            f.input(`${prefix}recommendation_threshold`).oninput();
            await f.button(action).onclick();
            assert.equal(f.requests.length, 1);
            const status = f.body.all('p').find(item => item.attributes.role === 'status');
            assert.match(status.textContent, /추천수 제한은 0 이상의 정수로 입력해 주세요/);
        }

        const disabled = fixture(); await connected(disabled);
        disabled.input(`${prefix}recommendation_threshold`).value = 'invalid';
        disabled.input(`${prefix}recommendation_threshold`).oninput();
        const start = disabled.button(action).onclick();
        const request = disabled.requests.at(-1);
        const filters = request.body.filters;
        assert.equal(filters.low_recommendation_limit, null);
        disabled.reply({connected: true, job: job('completed', {source: prefix ? 'arca' : 'huggingface'})}); await start;
    }
});

test('current saved Hugging Face filters prefer include_query including an empty value', async () => {
    const saved = {exclude_realistic: false, include_query: 'watercolor, sketch || ink',
        include_tags: ['legacy value'], exclude_tags: ['monochrome'], include_mode: 'all'};
    const f = fixture(), open = f.open();
    f.reply({connected: false, job: job('completed', {source: 'huggingface', published: true, filters: saved})}); await open;
    assert.equal(f.input('exclude_realistic').checked, false);
    assert.equal(f.input('include_query').value, 'watercolor, sketch || ink');
    assert.equal(f.input('exclude_tags').value, 'monochrome');

    const empty = fixture(), emptyOpen = empty.open();
    empty.reply({connected: false, job: job('completed', {source: 'huggingface', filters: {...saved, include_query: ''}})}); await emptyOpen;
    assert.equal(empty.input('include_query').value, '');
});

test('legacy saved Hugging Face tag arrays restore as any or all query groups', async () => {
    const any = fixture(), anyOpen = any.open();
    any.reply({connected: false, job: job('completed', {source: 'huggingface', filters: {
        include_tags: [' watercolor ', 'line art', 'blue_hair', '', ' sketch '], exclude_tags: ['monochrome']}})}); await anyOpen;
    assert.equal(any.input('include_query').value, 'watercolor || line_art || blue_hair || sketch');
    assert.equal(any.input('exclude_tags').value, 'monochrome');

    const all = fixture(), allOpen = all.open();
    all.reply({connected: false, job: job('completed', {source: 'huggingface', filters: {
        include_tags: ['watercolor', 'line art'], include_mode: 'all'}})}); await allOpen;
    assert.equal(all.input('include_query').value, 'watercolor, line_art');
});

test('saved Hugging Face filters restore only on the first unedited response', async () => {
    const saved = {exclude_realistic: false, include_query: 'watercolor, sketch || ink',
        exclude_tags: ['monochrome']};
    const next = fixture(), initial = next.open();
    next.input('include_query').value = 'my own tag'; next.input('include_query').oninput();
    next.reply({connected: false, job: job('completed', {source: 'huggingface', filters: saved})}); await initial;
    assert.equal(next.input('include_query').value, 'my own tag');
    const check = next.button('연결 상태 확인').onclick();
    next.reply({connected: false, job: job('completed', {source: 'huggingface', filters: {...saved, include_query: 'server value'}})}); await check;
    assert.equal(next.input('include_query').value, 'my own tag');
});

test('initial saved filters restore only to their source and legacy source-less jobs restore as Arca', async () => {
    const saved = {exclude_realistic: false, include_query: 'saved, query', exclude_tags: ['old_tag'], low_recommendation_limit: 3};
    const hf = fixture(), hfOpen = hf.open();
    hf.reply({connected: false, job: job('completed', {source: 'huggingface', filters: saved})}); await hfOpen;
    assert.equal(hf.input('exclude_realistic').checked, false);
    assert.equal(hf.input('include_query').value, 'saved, query');
    assert.equal(hf.input('exclude_tags').value, 'old_tag');
    assert.equal(hf.input('limit_low_recommendations').checked, true);
    assert.equal(hf.input('recommendation_threshold').value, '3');
    assert.equal(hf.input('arca_exclude_realistic').checked, true);
    assert.equal(hf.input('arca_include_query').value, '');
    assert.equal(hf.input('arca_limit_low_recommendations').checked, false);
    assert.equal(hf.input('arca_recommendation_threshold').value, '10');

    const arca = fixture(), arcaOpen = arca.open();
    arca.reply({connected: true, job: job('completed', {source: 'arca', filters: saved})}); await arcaOpen;
    assert.equal(arca.input('arca_exclude_realistic').checked, false);
    assert.equal(arca.input('arca_include_query').value, 'saved, query');
    assert.equal(arca.input('arca_exclude_tags').value, 'old_tag');
    assert.equal(arca.input('arca_limit_low_recommendations').checked, true);
    assert.equal(arca.input('arca_recommendation_threshold').value, '3');
    assert.equal(arca.input('include_query').value, '');

    const legacy = fixture(), legacyOpen = legacy.open();
    legacy.reply({connected: true, job: job('completed', {filters: saved})}); await legacyOpen;
    assert.equal(legacy.input('arca_include_query').value, 'saved, query');
    assert.equal(legacy.input('arca_limit_low_recommendations').checked, true);
    assert.equal(legacy.input('arca_recommendation_threshold').value, '3');

    const edited = fixture(), editedOpen = edited.open();
    edited.input('arca_include_query').value = 'my Arca query'; edited.input('arca_include_query').oninput();
    edited.reply({connected: true, job: job('completed', {source: 'arca', filters: saved})}); await editedOpen;
    assert.equal(edited.input('arca_include_query').value, 'my Arca query');
    assert.equal(edited.input('arca_exclude_realistic').checked, true);
    assert.equal(edited.input('arca_limit_low_recommendations').checked, false);
    assert.equal(edited.input('arca_recommendation_threshold').value, '10');

    const invalid = fixture(), invalidOpen = invalid.open();
    invalid.reply({connected: false, job: job('completed', {source: 'huggingface', filters: {low_recommendation_limit: 2.5}})}); await invalidOpen;
    assert.equal(invalid.input('limit_low_recommendations').checked, false);
    assert.equal(invalid.input('recommendation_threshold').value, '10');
});

test('Hugging Face progress reports prepared and filtered counts, publication totals, version, and retained-list failures', async () => {
    const running = fixture(), opening = running.open();
    running.reply({connected: false, job: job('running', {source: 'huggingface', prepared: 17, filtered: 6,
        skipped: 2, post_limited: 3, phase: 'inspect', processed_images: 1, total_images: 10,
        archive_filename: 'NAImakeArtistGroup_shared_images_20261024_webp.zip'})}); await opening;
    assert.match(running.body.textContent, /추가 예정 17 · 필터 제외 6 · 건너뜀 2/);
    assert.match(running.body.textContent, /게시물 제한 3/);
    assert.match(running.body.textContent, /자료 버전 2026-10-24/);
    const phaseText = running.body.all('div').find(item => item.className === 'gallery-index-progress-meta daki-style-sync-progress-meta');
    assert.equal(phaseText.textContent, '그림체 검사 1 / 10장 · 10%');
    const phaseMeter = running.body.all('div').find(item => item.attributes.role === 'progressbar');
    assert.equal(phaseMeter.attributes['aria-label'], '그림체 검사 진행률');
    assert.equal(phaseMeter.attributes['aria-valuenow'], '10');
    const runningSummary = running.win.DakiStyleSync.jobText(job('running', {source: 'huggingface', phase: 'inspect',
        prepared: 17, filtered: 6, skipped: 2, post_limited: 3, downloaded_bytes: 1000000, total_bytes: 1000000,
        message: '임시 진행 메시지'}));
    assert.equal((runningSummary.match(/게시물 제한 3/g) || []).length, 1);
    assert.doesNotMatch(runningSummary, /다운로드|임시 진행 메시지/);
    const stoppingSummary = running.win.DakiStyleSync.jobText(job('running', {source: 'huggingface', phase: 'inspect',
        prepared: 17, filtered: 6, skipped: 2, message: '현재 요청이 끝나면 수집을 중지합니다.'}));
    assert.match(stoppingSummary, /현재 요청이 끝나면 수집을 중지합니다\./);

    const completed = fixture(), completedOpen = completed.open();
    completed.reply({connected: false, job: job('completed', {source: 'huggingface', published: true,
        added: 3, updated: 4, filtered: 5, skipped: 6})}); await completedOpen;
    assert.match(completed.body.textContent, /추가 3 · 갱신 4 · 필터 제외 5 · 건너뜀 6/);
    assert.match(completed.body.textContent, /최신 V5 Full\/Medium 그림체를 공유 목록에 반영/);

    const added = fixture(), addedOpen = added.open();
    added.reply({connected: false, job: job('completed', {source: 'huggingface', published: true,
        added: 3, updated: 0, filtered: 5, skipped: 6})}); await addedOpen;
    assert.match(added.body.textContent, /추가 3 · 필터 제외 5/);
    assert.doesNotMatch(added.body.textContent, /갱신 0/);

    const arcaFiltered = job('completed', {source: 'arca', filtered: 3});
    assert.match(added.win.DakiStyleSync.jobText(arcaFiltered), /건너뜀 1 · 필터 제외 3/);
    assert.doesNotMatch(added.win.DakiStyleSync.jobText(job('completed', {source: 'arca'})), /필터 제외/);
    assert.match(added.win.DakiStyleSync.jobText(job('completed', {source: 'arca', post_limited: 2})), /건너뜀 1 · 게시물 제한 2/);
    assert.doesNotMatch(added.win.DakiStyleSync.jobText(job('completed', {source: 'arca', post_limited: 0})), /게시물 제한/);

    for (const state of ['failed', 'stopped']) {
        const f = fixture(), open = f.open();
        f.reply({connected: false, job: job(state, {source: 'huggingface', phase: 'inspect', processed_images: 4, total_images: 10,
            prepared: 17, filtered: 6, added: 99, published: false, downloaded_bytes: 1000000, total_bytes: 1000000,
            message: state === 'failed' ? 'Synthetic failure reason' : 'Synthetic stop reason'})}); await open;
        assert.match(f.body.textContent, /기존 공유 그림체 목록은 그대로 유지/);
        assert.match(f.body.textContent, /기존 목록 유지/);
        assert.doesNotMatch(f.body.textContent, /추가 99/);
        assert.match(f.body.textContent, /준비 17 · 필터 제외 6 · 건너뜀 1/);
        assert.match(f.body.textContent, state === 'failed' ? /Synthetic failure reason/ : /Synthetic stop reason/);
        const summary = f.win.DakiStyleSync.jobText(f.activity.at(-1).job);
        assert.doesNotMatch(summary, /다운로드/);
    }

    const uncertain = fixture(), uncertainOpen = uncertain.open();
    uncertain.reply({connected: false, job: job('stopped', {source: 'huggingface', published: null})}); await uncertainOpen;
    assert.match(uncertain.body.textContent, /반영 여부 확인 불가/);
    assert.doesNotMatch(uncertain.body.textContent, /기존 공유 그림체 목록은 그대로 유지|기존 목록 유지/);

    const applied = fixture(), appliedOpen = applied.open();
    applied.reply({connected: false, job: job('failed', {source: 'huggingface', published: true, phase: 'publish',
        downloaded_bytes: 1000000, total_bytes: 1000000, added: 2, updated: 3})}); await appliedOpen;
    assert.match(applied.body.textContent, /카탈로그 반영 · 추가 2 · 갱신 3/);
    assert.match(applied.body.textContent, /공유 목록은 반영되었습니다/);
    assert.doesNotMatch(applied.body.textContent, /기존 목록 유지|기존 공유 그림체 목록은 그대로 유지/);
});

test('jobProgress follows byte, image inspection, publication, and terminal phases without inventing totals', () => {
    const {jobProgress, jobText} = fixture().win.DakiStyleSync;
    const progress = extra => jobProgress(job('running', {source: 'huggingface', ...extra}));
    const plain = result => ({label: result.label, text: result.text, percent: result.percent});
    assert.deepEqual(plain(progress({phase: 'download', phase_current: 5000000, phase_total: 5000000})),
        {label: '이미지팩 다운로드', text: '이미지팩 다운로드 5 MB / 5 MB · 100%', percent: 100});
    assert.deepEqual(plain(progress({phase: 'verify', phase_current: 0, phase_total: 5000000})),
        {label: '파일 확인', text: '파일 확인 0 MB / 5 MB · 0%', percent: 0});
    assert.deepEqual(plain(progress({phase: 'inspect', processed_images: 0, total_images: 4425, downloaded_images: 4000})),
        {label: '그림체 검사', text: '그림체 검사 0 / 4,425장 · 0%', percent: 0});
    assert.deepEqual(plain(progress({phase: 'inspect', processed_images: 1200, total_images: 4425, downloaded_images: 4000})),
        {label: '그림체 검사', text: '그림체 검사 1,200 / 4,425장 · 27%', percent: 27});
    const inspected = progress({phase: 'inspect', processed_images: 4425, total_images: 4425});
    assert.equal(inspected.percent, 100);
    assert.equal(inspected.label, '그림체 검사');
    assert.doesNotMatch(inspected.text, /완료/);
    assert.deepEqual(plain(progress({phase: 'publish', prepared: 187, added: 0})),
        {label: '목록 반영', text: '목록 반영 중 · 새 그림체 187개', percent: null});
    assert.deepEqual(plain(progress({phase: 'publish', published: true, prepared: 187, added: 0})),
        {label: '목록 반영', text: '목록 반영됨 · 새 그림체 0개', percent: null});
    assert.deepEqual(plain(jobProgress(job('completed', {source: 'huggingface', phase: 'complete', published: true}))),
        {label: '완료', text: '완료', percent: 100});

    const transition = [
        progress({phase: 'download', phase_current: 5_000_000, phase_total: 5_000_000}),
        progress({phase: 'verify', phase_current: 0, phase_total: 5_000_000}),
        progress({phase: 'inspect', processed_images: 0, total_images: 4425}),
        progress({phase: 'inspect', processed_images: 1200, total_images: 4425}),
        progress({phase: 'inspect', processed_images: 4425, total_images: 4425}),
        progress({phase: 'publish', prepared: 17, added: 0}),
        jobProgress(job('completed', {source: 'huggingface', phase: 'complete', published: true})),
    ];
    assert.deepEqual(transition.map(item => [item.label, item.percent]), [
        ['이미지팩 다운로드', 100], ['파일 확인', 0], ['그림체 검사', 0], ['그림체 검사', 27],
        ['그림체 검사', 100], ['목록 반영', null], ['완료', 100],
    ]);

    for (const total of [undefined, 0, -2, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        const result = progress({phase: 'inspect', processed_images: 12, total_images: total});
        assert.equal(result.percent, null);
        assert.match(result.text, /12장/);
        assert.doesNotMatch(result.text, /NaN|\d+%/);
    }
    const unknownByteTotal = progress({phase: 'download', phase_current: 2500000, phase_total: 0});
    assert.equal(unknownByteTotal.percent, null);
    assert.match(unknownByteTotal.text, /2\.5 MB/);
    assert.doesNotMatch(unknownByteTotal.text, /NaN|\d+%/);

    for (const state of ['failed', 'stopped']) {
        const interrupted = jobProgress(job(state, {source: 'huggingface', phase: 'verify', phase_current: 0, phase_total: 100}));
        assert.match(interrupted.text, state === 'failed' ? /^실패 · 파일 확인/ : /^중지됨 · 파일 확인/);
        assert.doesNotMatch(interrupted.text, /완료/);
    }
    const legacy = jobProgress(job('running', {source: 'huggingface', downloaded_bytes: 100, total_bytes: 100}));
    assert.equal(legacy.percent, null);
    assert.match(legacy.text, /다운로드 이후 처리 중 · 확인한 그림 2장/);
    assert.match(jobText(job('running', {source: 'huggingface', downloaded_bytes: 1000000, total_bytes: 2000000})), /다운로드 1 MB \/ 2 MB/);
    assert.deepEqual(plain(jobProgress(job('completed', {source: 'huggingface', published: true}))),
        {label: '', text: '', percent: null});
    assert.match(jobText(job('completed', {source: 'huggingface', published: true})), /수집 완료 · 추가 1/);
    const completedMessage = jobText(job('completed', {source: 'huggingface', phase: 'complete', published: true,
        downloaded_bytes: 1000000, total_bytes: 2000000, message: 'Synthetic publication note'}));
    assert.doesNotMatch(completedMessage, /다운로드/);
    assert.match(completedMessage, /Synthetic publication note/);
});

test('Arca progress uses its message and current read counts without a fraction', () => {
    const {jobProgress} = fixture().win.DakiStyleSync;
    const result = jobProgress(job('running', {source: 'arca', message: '게시물 페이지 확인 중', scanned_posts: 28, downloaded_images: 9}));
    assert.equal(result.label, '아카라이브 가져오기');
    assert.equal(result.text, '게시물 페이지 확인 중 · 확인한 글 28 · 받은 그림 9');
    assert.equal(result.percent, null);
});
