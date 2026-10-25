const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const flush = () => new Promise(resolve => setImmediate(resolve));
const recipe = {prompt: 'synthetic tag', model: 'nai-diffusion-5-full', width: 832, height: 1216, options: {steps: 28}, seed: -1};
const completed = {id: 'synthetic-draft', status: 'completed', width: 832, height: 1216, path: '__daki_drafts__/synthetic-draft.png', settings: recipe};

function fixture({deferEditor = false} = {}) {
    class Element {
        constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.style = {}; this.listeners = {}; this.text = ''; this.value = ''; this.open = false; this.isConnected = false; }
        appendChild(child) { this.children.push(child); child.parent = this; child.isConnected = this.isConnected; return child; }
        append(...children) { children.forEach(child => this.appendChild(child)); }
        replaceChildren(...children) { this.children = []; this.text = ''; this.append(...children); }
        set textContent(value) { this.children = []; this.text = String(value); }
        get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
        setAttribute(key, value) { this.attributes[key] = value; }
        removeAttribute(key) { delete this.attributes[key]; delete this[key]; }
        addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
        fire(name, event = {}) { for (const callback of this.listeners[name] || []) callback(event); }
        showModal() { this.open = true; }
        close() { this.open = false; this.fire('close'); }
        remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.isConnected = false; }
        focus() { this.focused = true; }
        descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
    }
    const body = new Element('body'); body.isConnected = true;
    const originalFocus = new Element('button'); originalFocus.isConnected = true;
    const requests = [], pending = [], saved = [], editors = [], approvals = [], costs = [], timers = new Map();
    let timerId = 0, resolveEditor;
    const f = {settings: structuredClone(recipe), events: []};
    const root = {document: {body, activeElement: originalFocus, createElement: tag => new Element(tag)}, AbortController,
        Event: class { constructor(type) { this.type = type; } }, dispatchEvent: event => f.events.push(event.type),
        fetch(url, options) {
            requests.push({url, method: options.method, body: options.body && JSON.parse(options.body)});
            return new Promise((resolve, reject) => pending.push({resolve, reject}));
        },
        setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); },
        requiresAnlasCost(width, height, steps) { costs.push({width, height, steps}); return width * height > 1048576 || steps > 28; },
        showAnlasWarningModal(options) { return new Promise(resolve => approvals.push({options, resolve})); },
        DakiDraftEditor: {create(options) {
            const editor = {options, element: new Element('section'), read: () => f.settings, disposed: false, dispose() { this.disposed = true; }};
            editors.push(editor);
            return deferEditor ? new Promise(resolve => { resolveEditor = () => resolve(editor); }) : Promise.resolve(editor);
        }},
        NovelAIAccount: {refresh() { f.accountRefreshes = (f.accountRefreshes || 0) + 1; }},
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../static/daki_tag_examples.js'), 'utf8'), {window: root, URLSearchParams});
    const all = () => body.descendants();
    Object.assign(f, {root, body, originalFocus, requests, pending, saved, editors, approvals, costs, timers, all,
        open(mode = 'existing', tag = {tag: 'synthetic_tag', label_ko: '합성 태그'}) { return root.DakiTagExamples.open({tag, mode, onSaved: data => saved.push(data)}); },
        button(label) { const item = all().find(item => item.tagName === 'BUTTON' && item.textContent === label); assert.ok(item, label); return item; },
        labelled(label) { const item = all().find(item => item.attributes['aria-label'] === label); assert.ok(item, label); return item; },
        async generation() { const dialog = this.open('generate'); await flush(); return dialog; },
        reply(data, code = 200) { assert.ok(pending.length); pending.shift().resolve({ok: code < 400, status: code, json: async () => ({status: code < 400 ? 'success' : 'error', ...data})}); },
        candidates(items = [{path: 'synthetic/source.png', src: '/image/synthetic/source.png', name: '합성 그림'}], extra = {}) { this.reply({items, page: 1, pages: 1, total: items.length, ...extra}); },
        submit() { return all().find(item => item.tagName === 'FORM').onsubmit({preventDefault() {}}); },
        tick() { const [id, callback] = timers.entries().next().value; timers.delete(id); return callback(); },
        finishEditor() { resolveEditor(); },
    });
    return f;
}

test('existing candidates use the exact tag and only explicitly chosen pictures are attached', async () => {
    const f = fixture(); f.open('existing', {tag: 'tag (synthetic)&1', label_ko: '합성 태그'});
    const url = new URL(f.requests[0].url, 'http://localhost'); assert.equal(url.searchParams.get('tag'), 'tag (synthetic)&1');
    assert.equal(url.searchParams.get('page'), '1'); assert.equal(f.button('예시로 추가').disabled, true);
    f.candidates(); await flush(); assert.equal(f.requests.length, 1);
    f.labelled('합성 그림').onclick(); assert.equal(f.labelled('합성 그림').attributes['aria-pressed'], 'true');
    assert.equal(f.labelled('선택한 예시 그림').children[0].src, '/image/synthetic/source.png');
    const saving = f.button('예시로 추가').onclick(); f.button('예시로 추가').onclick();
    assert.equal(f.requests.length, 2); assert.deepEqual(f.requests[1], {url: '/api/daki/tag-catalog/examples', method: 'POST', body: {tag: 'tag (synthetic)&1', path: 'synthetic/source.png'}});
    f.reply({example: {id: 'synthetic-example'}}); await saving;
    assert.equal(f.saved.length, 1); assert.equal(f.body.children.length, 0); assert.equal(f.originalFocus.focused, true);
});

test('paging resets selection, empty pages are clear, and candidate errors retry only explicitly', async () => {
    const f = fixture(); f.open(); f.candidates(undefined, {pages: 2, total: 2}); await flush();
    f.labelled('합성 그림').onclick(); f.labelled('다음 그림 페이지').onclick();
    assert.equal(f.button('예시로 추가').disabled, true); assert.match(f.requests[1].url, /page=2/);
    f.reply({message: 'Synthetic candidate error'}, 500); await flush();
    assert.match(f.body.textContent, /Synthetic candidate error/); assert.equal(f.button('다시 불러오기').hidden, false);
    assert.equal(f.requests.length, 2); f.button('다시 불러오기').onclick();
    f.candidates([]); await flush(); assert.match(f.body.textContent, /태그가 포함된 그림이 없습니다/); assert.equal(f.button('예시로 추가').disabled, true);
});

test('late candidate reads and saves cannot update a closed modal or another tag', async () => {
    const f = fixture(); f.open(); f.root.DakiTagExamples.close();
    f.candidates(); await flush(); assert.equal(f.body.children.length, 0);
    f.open(); f.candidates(); await flush(); f.labelled('합성 그림').onclick();
    const saving = f.button('예시로 추가').onclick(); f.root.DakiTagExamples.close(); const next = f.open('generate');
    f.reply({example: {id: 'late'}}); await saving; assert.equal(f.saved.length, 0); assert.equal(next.open, true);
});

test('generation starts with the target tag, reuses the editor without nested dictionary, and adds only on explicit action', async () => {
    const f = fixture(); await f.generation();
    assert.deepEqual(JSON.parse(JSON.stringify(f.editors[0].options)), {settings: {prompt: 'synthetic_tag'}, tagBrowserEnabled: false});
    assert.equal(f.requests.length, 0); assert.equal(f.button('예시로 추가').disabled, true);
    const creating = f.submit(); await f.submit(); assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].body.allow_anlas, false); assert.equal(f.requests[0].body.prompt, recipe.prompt);
    f.reply({draft: completed}, 201); await creating;
    assert.deepEqual(f.events, ['daki-drafts-changed']);
    assert.equal(f.button('예시로 추가').disabled, false); assert.equal(f.saved.length, 0); assert.equal(f.requests.length, 1);
    assert.equal(f.labelled('선택한 예시 그림').children[0].src, '/api/daki/drafts/synthetic-draft/image?full=1');
    const saving = f.button('예시로 추가').onclick(); assert.deepEqual(f.requests[1].body, {tag: 'synthetic_tag', path: completed.path});
    f.reply({example: {id: 'from-generated'}}); await saving; assert.equal(f.saved.length, 1);
});

test('invalid editor settings never submit and a closed late editor is disposed', async () => {
    const f = fixture(); await f.generation(); f.settings = null; await f.submit(); assert.equal(f.requests.length, 0);
    const deferred = fixture({deferEditor: true}); deferred.open('generate'); deferred.root.DakiTagExamples.close(); deferred.finishEditor(); await flush();
    assert.equal(deferred.editors[0].disposed, true); assert.equal(deferred.body.children.length, 0);
});

test('paid generation waits for the native-dialog warning and cancellation performs no POST', async () => {
    const f = fixture(); const dialog = await f.generation(); f.settings.width = 960; f.settings.height = 3072;
    const creating = f.submit(); await f.submit(); assert.equal(f.approvals.length, 1); assert.equal(f.requests.length, 0);
    assert.equal(f.approvals[0].options.parent, dialog); assert.equal(f.approvals[0].options.signal.aborted, false);
    f.approvals[0].resolve(false); await creating;
    assert.equal(f.requests.length, 0); assert.equal(f.button('예시 한 장 생성').disabled, false); assert.match(f.body.textContent, /생성을 취소했습니다/);
});

test('paid approval posts the confirmed settings snapshot and allow_anlas only after approval', async () => {
    const f = fixture(); await f.generation(); f.settings.width = 960; f.settings.height = 3072;
    const creating = f.submit(); f.settings.prompt = 'changed while awaiting'; f.settings.width = 64;
    f.approvals[0].resolve(true); await flush();
    assert.equal(f.requests[0].body.width, 960); assert.equal(f.requests[0].body.prompt, recipe.prompt); assert.equal(f.requests[0].body.allow_anlas, true);
    f.reply({draft: completed}); await creating;
});

test('closing aborts the warning and even a late approval cannot submit', async () => {
    const f = fixture(); await f.generation(); f.settings.width = 960; f.settings.height = 3072;
    const creating = f.submit(); f.root.DakiTagExamples.close();
    assert.equal(f.approvals[0].options.signal.aborted, true); f.approvals[0].resolve(true); await creating;
    assert.equal(f.requests.length, 0); assert.equal(f.editors[0].disposed, true);
});

test('Medium costs use 14 steps and failed-result retry keeps original saved settings', async () => {
    const f = fixture(); await f.generation(); f.settings.model = 'nai-diffusion-5-full-medium'; f.settings.options.steps = 50;
    const creating = f.submit(); assert.equal(f.costs[0].steps, 14); assert.equal(f.approvals.length, 0);
    const failed = {...completed, status: 'failed', settings: {...recipe, width: 960, height: 3072}, error: 'Synthetic generation failed'};
    f.reply({draft: failed}); await creating; assert.match(f.body.textContent, /Synthetic generation failed/);
    f.settings.width = 64;
    const retrying = f.button('실패한 그림 다시 생성').onclick(); assert.equal(f.approvals[0].options.width, 960);
    f.approvals[0].resolve(true); await flush();
    assert.deepEqual(f.requests[1], {url: '/api/daki/drafts/synthetic-draft/retry', method: 'POST', body: {allow_anlas: true}});
    f.reply({draft: completed}); await retrying; assert.equal(f.button('예시로 추가').disabled, false);
});

test('pending generation polls its own result, pauses on read errors, and resumes explicitly', async () => {
    const f = fixture(); await f.generation(); const creating = f.submit(); f.reply({draft: {...completed, status: 'running'}}); await creating;
    assert.equal(f.button('그림 생성 중…').disabled, true); assert.equal(f.timers.size, 1);
    const polling = f.tick(); assert.equal(f.requests[1].url, '/api/daki/drafts/synthetic-draft');
    f.reply({message: 'Synthetic polling error'}, 500); await polling;
    assert.equal(f.timers.size, 0); assert.equal(f.button('결과 다시 확인').hidden, false);
    const refreshing = f.button('결과 다시 확인').onclick(); f.reply({draft: completed}); await refreshing;
    assert.equal(f.button('예시로 추가').disabled, false); assert.equal(f.button('예시 한 장 생성').disabled, false); assert.equal(f.timers.size, 0);
});

test('uncertain POST outcomes never automatically duplicate a paid or free generation', async () => {
    const f = fixture(); await f.generation(); const creating = f.submit(); f.pending.shift().reject(new Error('Synthetic disconnected')); await creating;
    assert.match(f.body.textContent, /생성 기록을 불러와 생성 여부/); assert.equal(f.button('예시 한 장 생성').disabled, true);
    await f.submit(); assert.equal(f.requests.length, 1); assert.equal(f.timers.size, 0);
    assert.equal(f.button('생성 기록 불러오기').disabled, false);
});

test('tag generation records its purpose and reopens a separate history without generating or registering', async () => {
    const f = fixture(); await f.generation();
    const creating = f.submit(); assert.equal(f.requests[0].body.purpose, 'tag_example');
    f.reply({draft: completed}); await creating;
    const loading = f.button('생성 기록 불러오기').onclick();
    assert.equal(f.requests[1].url, '/api/daki/drafts?purpose=tag_example');
    assert.equal(f.requests[1].method, 'GET');
    assert.equal(f.button('요청하는 중…').disabled, true);
    const older = {...completed, id: 'older-example', path: '__daki_drafts__/older-example.png', created_at: '2026-10-01T00:00:00Z'};
    f.reply({drafts: [older]}); await loading;
    const history = f.labelled('태그 예시 생성 기록');
    assert.equal(history.hidden, false); history.value = older.id; history.onchange();
    assert.match(f.labelled('선택한 예시 그림').children[0].src, /older-example/);
    assert.equal(f.requests.length, 2); assert.equal(f.saved.length, 0);
    const saving = f.button('예시로 추가').onclick();
    assert.equal(f.requests[2].body.path, older.path);
    f.reply({example: {id: 'added-older'}}); await saving;
});

test('history failure preserves uncertain generation lock and late history cannot update a closed modal', async () => {
    const f = fixture(); await f.generation();
    const creating = f.submit(); f.pending.shift().reject(new Error('Synthetic disconnected')); await creating;
    const loading = f.button('생성 기록 불러오기').onclick();
    f.reply({message: 'Synthetic history error'}, 500); await loading;
    assert.equal(f.button('예시 한 장 생성').disabled, true);
    assert.match(f.body.textContent, /Synthetic history error/);
    const retry = f.button('생성 기록 불러오기').onclick(); f.root.DakiTagExamples.close();
    f.reply({drafts: [completed]}); await retry;
    assert.equal(f.body.children.length, 0); assert.equal(f.saved.length, 0); assert.equal(f.timers.size, 0);
});

test('closing an in-flight generation never attaches its late result and cancels any poll timer', async () => {
    const f = fixture(); await f.generation(); const creating = f.submit(); f.root.DakiTagExamples.close();
    f.reply({draft: completed}); await creating; assert.equal(f.saved.length, 0); assert.equal(f.requests.length, 1); assert.equal(f.body.children.length, 0);
    await f.generation(); const next = f.submit(); f.reply({draft: {...completed, status: 'pending'}}); await next;
    assert.equal(f.timers.size, 1); f.root.DakiTagExamples.close(); assert.equal(f.timers.size, 0);
});

test('save failure retains the selected preview and requires an explicit retry', async () => {
    const f = fixture(); f.open(); f.candidates(); await flush(); f.labelled('합성 그림').onclick();
    const saving = f.button('예시로 추가').onclick(); f.reply({message: 'Synthetic save error'}, 400); await saving;
    assert.match(f.body.textContent, /Synthetic save error/); assert.equal(f.button('예시로 추가').disabled, false); assert.equal(f.saved.length, 0); assert.equal(f.requests.length, 2);
    const retrying = f.button('예시로 추가').onclick(); f.reply({example: {id: 'retried'}}); await retrying; assert.equal(f.saved.length, 1);
});

test('Escape closes the example dialog, disposes its editor, and restores dictionary focus', async () => {
    const f = fixture(); const dialog = await f.generation(); let prevented = false;
    dialog.fire('cancel', {preventDefault() { prevented = true; }});
    assert.equal(prevented, true); assert.equal(f.body.children.length, 0); assert.equal(f.originalFocus.focused, true); assert.equal(f.editors[0].disposed, true);
});
