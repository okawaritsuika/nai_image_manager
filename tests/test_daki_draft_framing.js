const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const flush = () => new Promise(resolve => setImmediate(resolve));
const limits = {min: 1, max: 16000, max_pixels: 80000000};

function fixture() {
    class Element {
        constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.style = {}; this.listeners = {}; this.text = ''; this.value = ''; this.open = false; this.isConnected = false; }
        appendChild(child) { this.children.push(child); child.parent = this; child.isConnected = this.isConnected; return child; }
        append(...children) { children.forEach(child => this.appendChild(child)); }
        set textContent(value) { this.children = []; this.text = String(value); }
        get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
        setAttribute(key, value) { this.attributes[key] = value; }
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
    const requests = [], pending = [], saved = [];
    const root = {document: {body, activeElement: originalFocus, createElement: tag => new Element(tag)},
        fetch(url, options) {
            requests.push({url, method: options.method, body: options.body && JSON.parse(options.body)});
            return new Promise((resolve, reject) => pending.push({resolve, reject}));
        }};
    const context = vm.createContext({window: root});
    vm.runInContext(fs.readFileSync(require.resolve('../static/generation_settings.js'), 'utf8'), context);
    root.formatGenerationSize = context.formatGenerationSize;
    vm.runInContext(fs.readFileSync(require.resolve('../static/daki_draft_framing.js'), 'utf8'), context);
    const all = () => body.descendants();
    const f = {root, body, originalFocus, requests, pending, saved, all,
        open(width = 512, height = 1664) { return root.DakiDraftFraming.open({record: {id: 'synthetic-id', width, height}, onSaved: draft => saved.push(draft)}); },
        field(label) { const item = all().find(item => item.attributes['aria-label'] === label); assert.ok(item, label); return item; },
        button(label) { const item = all().find(item => item.tagName === 'BUTTON' && item.textContent === label); assert.ok(item, label); return item; },
        image() { return all().find(item => item.tagName === 'IMG'); },
        async loaded(width, height) { const dialog = this.open(width, height); this.reply({limits}); await flush(); return dialog; },
        reply(data, code = 200) { assert.ok(pending.length); pending.shift().resolve({ok: code < 400, json: async () => ({status: code < 400 ? 'success' : 'error', ...data})}); },
        dimensions(width, height) { this.field('최종 너비').value = String(width); this.field('최종 높이').value = String(height); this.field('최종 너비').oninput(); },
        cover() { this.field('확대·잘라 맞추기 · 중앙 정렬').onchange(); },
        pad() { this.field('투명 여백 · 중앙 정렬').onchange(); },
        submit() { return all().find(item => item.tagName === 'FORM').onsubmit({preventDefault() {}}); },
    };
    return f;
}

test('defaults to the smallest exact 5:16 canvas containing the source without changing any pixels', async () => {
    const f = fixture(); await f.loaded();
    assert.equal(Number(f.field('최종 너비').value), 520); assert.equal(Number(f.field('최종 높이').value), 1664);
    assert.match(f.field('최종 크기와 비율').textContent, /520 × 1664.*5:16.*1:3.20/);
    assert.match(f.field('크기 맞추기 내역').textContent, /100.00%.*\n투명 여백 · 왼쪽 4 \/ 오른쪽 4 \/ 위 0 \/ 아래 0 px/);
    assert.equal(f.image().src, '/api/daki/drafts/synthetic-id/image?full=1');
    assert.equal(parseFloat(f.image().style.width), 512 / 520 * 100);
    assert.equal(f.button('별도 저장').disabled, false);
    assert.deepEqual(f.requests.map(item => item.method), ['GET']);
    assert.equal(f.requests[0].url, '/api/daki/drafts/framing-options');
    assert.match(f.body.textContent, /5:16 맞추기 \(선택\).*투명 여백 · 중앙 정렬.*확대·잘라 맞추기 · 중앙 정렬/);
    assert.equal(f.field('맞추기 방식').attributes.role, 'group');
});

test('odd padding places the extra pixel on the right or bottom just like saved output', async () => {
    const f = fixture(); await f.loaded(512, 1665); f.dimensions(515, 1680);
    assert.match(f.field('크기 맞추기 내역').textContent, /왼쪽 1 \/ 오른쪽 2 \/ 위 7 \/ 아래 8 px/);
    assert.equal(parseFloat(f.image().style.left), 1 / 515 * 100);
    assert.equal(parseFloat(f.image().style.top), 7 / 1680 * 100);
});

test('cover scales proportionally and reports precisely centered crop in original pixels', async () => {
    const f = fixture(); await f.loaded(); f.dimensions(640, 2048); f.cover();
    assert.match(f.field('크기 맞추기 내역').textContent, /125.00%.*\n잘리는 원본 · 왼쪽 0.00 \/ 오른쪽 0.00 \/ 위 12.80 \/ 아래 12.80 px/);
    assert.equal(parseFloat(f.image().style.width), 100);
    assert.equal(parseFloat(f.image().style.height), 2080 / 2048 * 100);
    assert.equal(parseFloat(f.image().style.top), -16 / 2048 * 100);
    f.dimensions(320, 1024);
    assert.match(f.field('크기 맞추기 내역').textContent, /62.50%/);
    assert.equal(f.button('별도 저장').disabled, false);
});

test('cover preserves half pixel center cropping instead of rounding into a shifted preview', async () => {
    const f = fixture(); await f.loaded(3, 2); f.dimensions(2, 2); f.cover();
    assert.match(f.field('크기 맞추기 내역').textContent, /왼쪽 0.50 \/ 오른쪽 0.50 \/ 위 0.00 \/ 아래 0.00 px/);
    assert.equal(f.image().style.width, '150%'); assert.equal(f.image().style.left, '-25%');
});

test('changing fit mode retains dimensions, rejects shrinking pad, and source or 5:16 shortcuts are explicit', async () => {
    const f = fixture(); await f.loaded(); f.dimensions(400, 1200);
    assert.equal(f.button('별도 저장').disabled, true); assert.match(f.body.textContent, /원본보다 작게/);
    f.cover(); assert.equal(Number(f.field('최종 너비').value), 400); assert.equal(Number(f.field('최종 높이').value), 1200);
    assert.equal(f.button('별도 저장').disabled, false);
    f.pad(); assert.equal(Number(f.field('최종 너비').value), 400); assert.equal(f.button('별도 저장').disabled, true);
    f.button('원본 크기').onclick(); assert.equal(Number(f.field('최종 너비').value), 512); assert.equal(Number(f.field('최종 높이').value), 1664);
    f.button('5:16 맞추기').onclick(); assert.equal(Number(f.field('최종 너비').value), 520); assert.equal(Number(f.field('최종 높이').value), 1664);
});

test('server supplied dimensions and pixel limits validate on input and at submit without silent clamping', async () => {
    const f = fixture(); await f.loaded(); f.cover();
    for (const [width, height, pattern] of [[0, 1200, /정수/], ['1.5', 1200, /정수/], [16001, 100, /16000/], [10000, 10000, /80,000,000/]]) {
        f.dimensions(width, height); assert.equal(f.button('별도 저장').disabled, true); assert.match(f.body.textContent, pattern);
        await f.submit(); assert.equal(f.requests.length, 1); assert.equal(Number(f.field('최종 너비').value), Number(width));
    }
    f.dimensions(5000, 16000); assert.equal(f.button('별도 저장').disabled, false);
});

test('does not guess limits or save while options are unavailable or malformed', async () => {
    const f = fixture(); f.open(); await f.submit(); assert.equal(f.requests.length, 1); assert.equal(f.button('별도 저장').disabled, true);
    f.reply({message: 'Synthetic options error'}, 500); await flush(); await f.submit();
    assert.equal(f.requests.length, 1); assert.match(f.body.textContent, /Synthetic options error/);
    f.open(); f.reply({limits: {min: 1, max: 16000}}); await flush();
    assert.equal(f.button('별도 저장').disabled, true); assert.match(f.body.textContent, /저장 가능한 크기를 확인하지 못했습니다/);
});

test('explicit save sends one request, disables duplicate submits, and returns the saved draft', async () => {
    const f = fixture(); await f.loaded(); f.dimensions(640, 2048); f.cover();
    const saving = f.submit(); await f.submit();
    assert.equal(f.button('저장 중…').disabled, true); assert.equal(f.requests.length, 2);
    assert.deepEqual(f.requests[1], {url: '/api/daki/drafts/synthetic-id/frame', method: 'POST', body: {width: 640, height: 2048, mode: 'cover'}});
    f.reply({draft: {id: 'saved-copy', width: 640, height: 2048}}, 201); await saving;
    assert.equal(f.body.children.length, 0); assert.deepEqual(f.saved, [{id: 'saved-copy', width: 640, height: 2048}]);
    assert.equal(f.originalFocus.focused, true);
});

test('closed save completion refreshes its original gallery callback without closing a newly opened dialog', async () => {
    const f = fixture(); await f.loaded(); const saving = f.submit(); f.root.DakiDraftFraming.close();
    const nextDialog = f.open(640, 2048); f.reply({draft: {id: 'late-saved-copy'}}, 201); await saving;
    assert.deepEqual(f.saved, [{id: 'late-saved-copy'}]); assert.equal(nextDialog.open, true); assert.equal(f.body.children.length, 1);
    f.reply({limits}); await flush(); assert.equal(f.button('별도 저장').disabled, false);
});

test('an unavailable preview is hidden and clearly reported while a save can still validate the source', async () => {
    const f = fixture(); await f.loaded(); f.image().onerror();
    assert.match(f.body.textContent, /미리보기 그림을 불러오지 못했습니다/);
    assert.equal(f.image().parent.hidden, true); assert.equal(f.button('별도 저장').disabled, false);
    f.dimensions(640, 2048); assert.match(f.body.textContent, /미리보기 그림을 불러오지 못했습니다/);
    f.image().onload(); assert.equal(f.image().parent.hidden, false);
    assert.doesNotMatch(f.body.textContent, /미리보기 그림을 불러오지 못했습니다/);
});

test('failed save leaves controls available and retries only after a new explicit submit', async () => {
    const f = fixture(); await f.loaded(); const saving = f.submit();
    f.reply({message: 'Synthetic image unavailable'}, 404); await saving;
    assert.equal(f.body.children.length, 1); assert.equal(f.button('별도 저장').disabled, false);
    assert.match(f.body.textContent, /Synthetic image unavailable/); assert.equal(f.saved.length, 0); assert.equal(f.requests.length, 2);
    const retry = f.submit(); f.reply({draft: {id: 'explicit-retry'}}, 201); await retry;
    assert.equal(f.requests.length, 3); assert.equal(f.saved.length, 1);
});

test('closing ignores late options and cancel restores focus without any save', async () => {
    const f = fixture(); const oldDialog = f.open(); f.root.DakiDraftFraming.close();
    f.reply({limits}); await flush(); assert.equal(f.body.children.length, 0); assert.equal(oldDialog.open, false);
    const dialog = await f.loaded(); let prevented = false;
    dialog.fire('cancel', {preventDefault() { prevented = true; }});
    assert.equal(prevented, true); assert.equal(f.body.children.length, 0); assert.equal(f.originalFocus.focused, true);
    assert.ok(f.requests.every(item => item.method === 'GET'));
});
