const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
    class Element {
        constructor(tag) {
            this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.className = '';
            this.listeners = new Map(); this.text = ''; this.hidden = false; this.disabled = false; this.checked = false;
            this.open = false; this.value = '';
        }
        set value(value) { this._value = String(value); }
        get value() { return this._value; }
        descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
        appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; return child; }
        append(...children) { children.forEach(child => this.appendChild(child)); }
        replaceChildren(...children) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.text = ''; this.append(...children); }
        remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
        set textContent(text) { this.replaceChildren(); this.text = String(text); }
        get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
        setAttribute(key, value) { this.attributes[key] = String(value); }
        getAttribute(key) { return this.attributes[key] ?? null; }
        addEventListener(name, callback) { this.listeners.set(name, [...(this.listeners.get(name) || []), callback]); }
        showModal() { this.open = true; }
        close() { this.open = false; (this.listeners.get('close') || []).forEach(callback => callback()); }
        focus() { doc.activeElement = this; this.onfocus?.(); }
        get isConnected() { return this === doc.body || !!this.parentNode?.isConnected; }
        setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
        matches(selector) {
            if (selector === ':disabled') return this.disabled || this.parentNode?.matches(':disabled');
            if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
            return this.tagName === selector.toUpperCase();
        }
        querySelectorAll(selector) { return this.descendants().filter(item => selector.split(',').some(part => item.matches(part.trim()))); }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    }
    const doc = {createElement: tag => new Element(tag)}; doc.body = new Element('body');
    const pending = [], requests = [], changes = [], tagBrowsers = [], events = new Map();
    const imageTags = {}, definitions = [{id: 'keep', type: 'text', value: '⭐'}, {id: 'maybe', type: 'image', value: '/synthetic/tag.png'}];
    const win = {document: doc, DakiTagBrowser: {open: options => tagBrowsers.push(options)},
        getGalleryTagState: () => ({definitions}), getGalleryImageTagId: path => imageTags[path] || '',
        renderGalleryTagIcon: tag => tag.type === 'image' ? '<img src="/synthetic/tag.png">' : '<span>⭐</span>',
        addEventListener(type, listener) { const listeners = events.get(type) || new Set(); listeners.add(listener); events.set(type, listeners); },
        removeEventListener(type, listener) { events.get(type)?.delete(listener); },
        fetch(url, options) {
            const request = {url, method: options.method, body: options.body === undefined ? undefined : JSON.parse(options.body)};
            requests.push(request); return new Promise(resolve => pending.push({request, resolve}));
        }};
    const context = vm.createContext({window: win});
    vm.runInContext(fs.readFileSync(require.resolve('../static/generation_settings.js'), 'utf8'), context);
    win.formatGenerationSize = context.formatGenerationSize;
    for (const file of ['daki_gallery_filters', 'daki_prompt_groups', 'daki_draft_editor']) vm.runInContext(fs.readFileSync(require.resolve('../static/' + file + '.js'), 'utf8'), context);
    function reply(data, status = 200, index = 0) {
        const entry = pending.splice(index, 1)[0]; assert.ok(entry, 'Expected pending request');
        entry.resolve({ok: status < 400, json: async () => ({status: status < 400 ? 'success' : 'error', ...data})}); return entry.request;
    }
    let editor;
    return {doc, win, pending, requests, changes, tagBrowsers, reply, imageTags, definitions, events,
        fire(type) { [...(events.get(type) || [])].forEach(listener => listener({type})); },
        selectTag(value) { doc.body.querySelectorAll('button').find(button => button.value === value).onclick(); },
        visibleCards() { return doc.body.querySelectorAll('.daki-draft-picker-card').filter(card => !card.hidden); },
        async create(settings, fail = false, editorOptions = {}) {
            const promise = win.DakiDraftEditor.create({...editorOptions, settings, onChange: value => changes.push(clone(value))});
            reply(fail ? {message: 'offline'} : sizes, fail ? 500 : 200); editor = await promise; doc.body.appendChild(editor.element); return editor;
        },
        field(name) { const result = doc.body.querySelectorAll('input, select, textarea').find(item => item.name === name); assert.ok(result, name); return result; },
        label(name) { const result = doc.body.querySelectorAll('input, select, textarea').find(item => item.getAttribute('aria-label') === name); assert.ok(result, name); return result; },
        button(label) { const result = doc.body.querySelectorAll('button').find(item => item.textContent === label); assert.ok(result, label); return result; },
        change(name, value) { const input = this.field(name); input.value = value; return input.oninput(); },
        select(name, value) { const input = this.field(name); input.value = value; return input.onchange(); },
        async picker(items, library = 'shared') {
            const opening = this.button('그림체 고르기').onclick(); reply({styles: items}); await opening;
            if (library !== 'shared') { const select = this.label('그림체 라이브러리'); select.value = library; const loading = select.onchange(); reply({styles: items}); await loading; }
        },
        async choose(style) {
            const choosing = doc.body.querySelectorAll('button').find(item => item.getAttribute('aria-label') === style.name + ' 적용').onclick();
            reply({style}); await choosing;
        },
    };
}
const clone = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
const sizes = {size_limits: {min: 64, max: 49152, step: 64, max_pixels: 3145728},
    size_presets: [{label: 'Small', sizes: [[512, 768], [768, 512], [640, 640]]}, {label: 'Normal', sizes: [[1024, 1024], [832, 1216]]},
        {label: 'Daki', sizes: [[320, 1024], [512, 1664], [640, 2048], [960, 3072], [1024, 3072]]}]};
const style = (override = {}) => ({id: 'style_example', name: 'Synthetic style', model: 'nai-diffusion-5-full',
    positive: 'synthetic paint', negative: 'synthetic avoid', preview: {width: 1024, height: 1024},
    options: {steps: 24, cfg: 7, sampler: 'k_euler', noise_schedule: 'native'}, ...override});
const batchId = 'a'.repeat(32), cupId = 'c'.repeat(32), personalId = 'personal_' + 'b'.repeat(32);
async function history(f, source, records, shared = [style()], personal = []) {
    await f.picker(shared);
    const library = f.label('그림체 라이브러리'); library.value = source; const loading = library.onchange();
    f.reply(source === 'tests' ? {batches: records} : {records});
    f.reply({styles: shared}); f.reply({styles: personal}); await loading;
}
async function record(f, source, id, details) {
    const input = f.label(source === 'tests' ? '기준 테스트' : '기준 월드컵'); input.value = id;
    const loading = input.onchange(); f.reply(source === 'tests' ? {batch: details} : {record: details}); await loading;
}

test('defaults and server presets are editable without generation requests or an initial change event', async () => {
    const f = fixture(), editor = await f.create();
    assert.equal(f.changes.length, 0); assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].url, '/api/daki/style-tests/options');
    assert.deepEqual(clone(editor.read()), {prompt: '', negative_prompt: '', model: 'nai-diffusion-5-full', width: 512, height: 768, seed: -1,
        character_positioning: 'auto', char_prompts: [], options: {steps: 28, cfg: 5, cfg_rescale: 0, sampler: 'k_euler_ancestral', noise_schedule: 'karras',
            deliberate_euler_ancestral_bug: false, prefer_brownian: true, dynamic_thresholding: false, legacy_v3_extend: false}, style: null});
    f.select('size', '832x1216'); assert.equal(editor.read().width, 832); assert.equal(editor.read().height, 1216);
    f.button('⇄').onclick(); assert.equal(editor.read().width, 1216); assert.equal(f.field('size').value, 'custom');
    assert.ok(!f.doc.body.textContent.includes('Inpainting'));
});

test('validates exact dimensions, area, empty numbers, seed and generation options only on read', async () => {
    const f = fixture(), editor = await f.create();
    for (const [key, invalid, valid] of [['width', '513', '512'], ['height', '', '768'], ['seed', '4294967296', '-1'], ['cfg', 'NaN', '5'], ['steps', '2.2', '28']]) {
        f.change(key, invalid); assert.equal(f.doc.body.querySelector('.daki-draft-editor-status').textContent, '');
        assert.equal(editor.read(), null, key); f.change(key, valid); assert.ok(editor.read(), key);
    }
    f.change('width', '2048'); f.change('height', '2048'); assert.equal(editor.read(), null);
    f.change('width', '512'); f.change('height', '768'); f.change('seed', '4294967295'); assert.equal(editor.read().seed, 4294967295);
});

test('size selection survives the browser input event before its change event', async () => {
    const f = fixture(), editor = await f.create(), size = f.field('size');
    size.value = '640x640';
    size.oninput?.();
    size.onchange();
    assert.equal(size.value, '640x640');
    assert.equal(editor.read().width, 640); assert.equal(editor.read().height, 640);
    assert.equal(f.changes.at(-1).width, 640); assert.equal(f.changes.at(-1).height, 640);
});

test('Daki presets show exact aspect ratios and apply valid dimensions through native select events', async () => {
    const f = fixture(), editor = await f.create(), size = f.field('size');
    assert.deepEqual(size.querySelectorAll('option').filter(option => option.value !== 'custom').map(option => option.textContent),
        ['512 × 768 · 2:3 (1:1.50)', '768 × 512 · 3:2 (1:0.67)', '640 × 640 · 1:1 (1:1.00)', '1024 × 1024 · 1:1 (1:1.00)', '832 × 1216 · 13:19 (1:1.46)',
            '320 × 1024 · 5:16 (1:3.20)', '512 × 1664 · 4:13 (1:3.25)', '640 × 2048 · 5:16 (1:3.20)',
            '960 × 3072 · 5:16 (1:3.20) · 5:16 최대', '1024 × 3072 · 1:3 (1:3.00) · 최대 면적']);
    for (const [width, height] of sizes.size_presets.at(-1).sizes) {
        size.value = `${width}x${height}`; size.oninput?.(); size.onchange();
        assert.equal(editor.read().width, width); assert.equal(editor.read().height, height);
    }
});

test('failed options request prevents generation instead of using guessed limits', async () => {
    const f = fixture(), editor = await f.create({}, true);
    assert.match(f.doc.body.textContent, /offline/); assert.equal(editor.read(), null);
});

test('Medium fixes options and disables Nega while retaining editable Full values when switching back', async () => {
    const f = fixture(), editor = await f.create({prompt: ' base ', negative_prompt: 'keep this nega', options: {steps: 32, sampler: 'k_euler', cfg_rescale: .6}});
    f.button('캐릭터').onclick(); f.button('＋ 캐릭터').onclick(); f.label('캐릭터 네거티브').value = 'keep character nega';
    f.select('model', 'nai-diffusion-5-full-medium');
    const medium = editor.read();
    assert.equal(medium.options.steps, 14); assert.equal(medium.options.sampler, 'k_euler_ancestral'); assert.equal(medium.options.cfg_rescale, 0);
    assert.equal(f.field('steps').disabled, true); assert.equal(f.field('negative_prompt').disabled, true); assert.equal(f.label('캐릭터 네거티브').disabled, true);
    assert.equal(medium.negative_prompt, 'keep this nega');
    assert.match(f.doc.body.querySelector('.daki-draft-english-preview').textContent, /고정 네거티브/);
    f.select('model', 'nai-diffusion-5-full');
    assert.equal(editor.read().options.steps, 32); assert.equal(editor.read().options.sampler, 'k_euler'); assert.equal(editor.read().options.cfg_rescale, .6);
    assert.equal(f.field('negative_prompt').disabled, false); assert.equal(editor.read().char_prompts[0].negative_prompt, 'keep character nega');
});

test('switching to V4.5 preserves extra characters and blocks read until explicit removal', async () => {
    const f = fixture(), editor = await f.create({char_prompts: Array.from({length: 7}, (_, i) => ({prompt: 'synthetic ' + i}))});
    f.select('model', 'nai-diffusion-4-5-full'); assert.equal(editor.read(), null);
    assert.equal(f.doc.body.querySelectorAll('.daki-draft-character').length, 7); assert.equal(f.button('＋ 캐릭터').disabled, true);
    f.button('삭제').onclick(); assert.equal(editor.read().char_prompts.length, 6);
    f.select('model', 'nai-diffusion-5-full'); assert.equal(f.button('＋ 캐릭터').disabled, false);
});

test('custom coordinates validate; automatic positioning ignores hidden invalid coordinates', async () => {
    const f = fixture(), editor = await f.create({char_prompts: [{prompt: 'character', x: .2, y: .8}], character_positioning: 'custom'});
    assert.equal(editor.read().char_prompts[0].x, .2);
    f.label('가로 위치 (0~1)').value = '2'; assert.equal(editor.read(), null);
    f.select('character_positioning', 'auto'); assert.equal(f.label('가로 위치 (0~1)').disabled, true);
    assert.equal(editor.read().char_prompts[0].x, .5); assert.equal(editor.read().char_prompts[0].y, .5);
});

test('compatibility flags are absent from controls but survive loading, editing and source-style changes', async () => {
    const original = {deliberate_euler_ancestral_bug: true, prefer_brownian: false, dynamic_thresholding: true, legacy_v3_extend: true};
    const f = fixture(), editor = await f.create({prompt: 'synthetic subject', options: original});
    assert.ok(f.doc.body.querySelectorAll('input').every(input => !(input.name in original)));
    assert.doesNotMatch(f.doc.body.textContent, /Euler Ancestral 호환 모드|Brownian 사용|동적 임계값|V3 확장 호환/);
    f.change('cfg', '7'); f.select('model', 'nai-diffusion-5-full-medium');
    for (const [key, value] of Object.entries(original)) assert.equal(editor.read().options[key], value);
    editor.setSettings({prompt: 'restored subject', options: original});
    assert.equal(editor.read().prompt, 'restored subject');
    for (const [key, value] of Object.entries(original)) assert.equal(editor.read().options[key], value);
    const chosen = style({options: {...style().options, deliberate_euler_ancestral_bug: false, prefer_brownian: true,
        dynamic_thresholding: false, legacy_v3_extend: false}});
    await f.picker([chosen]); await f.choose(chosen);
    for (const key of Object.keys(original)) assert.equal(editor.read().options[key], chosen.options[key]);
    assert.equal(editor.read().prompt, 'synthetic paint, restored subject');
});

test('style selection replaces only its exact old prefixes and retains user size seed and characters', async () => {
    const f = fixture(), editor = await f.create({prompt: 'old style, subject', negative_prompt: 'old nega, avoid subject', width: 1024, height: 1024, seed: 123,
        style: {id: 'old', name: 'Old', library: 'shared', positive: 'old style', negative: 'old nega'}, char_prompts: [{prompt: 'synthetic character', x: .1, y: .9}], character_positioning: 'custom'});
    const next = style(); await f.picker([next]); await f.choose(next);
    const value = editor.read();
    assert.equal(value.prompt, 'synthetic paint, subject'); assert.equal(value.negative_prompt, 'synthetic avoid, avoid subject');
    assert.equal(value.width, 1024); assert.equal(value.height, 1024); assert.equal(value.seed, 123);
    assert.deepEqual(clone(value.char_prompts), [{prompt: 'synthetic character', negative_prompt: '', x: .1, y: .9}]);
    assert.equal(value.options.cfg, 7); assert.equal(value.options.steps, 24); assert.equal(value.options.sampler, 'k_euler');
    assert.deepEqual(clone(value.style), {id: next.id, name: next.name, library: 'shared', positive: next.positive, negative: next.negative});
    assert.equal(f.doc.body.querySelector('dialog'), null);
});

test('modified prefixes are never removed and personal styles use the existing personal API', async () => {
    const f = fixture(), editor = await f.create({prompt: 'old styles altered, subject', style: {positive: 'old style', negative: '', library: 'shared'}});
    const next = style(); await f.picker([next], 'personal'); await f.choose(next);
    assert.equal(editor.read().prompt, 'synthetic paint, old styles altered, subject'); assert.equal(editor.read().style.library, 'personal');
    assert.ok(f.requests.some(request => request.url === '/api/daki/personal-styles/style_example'));
});

test('a stale style detail cannot replace a newer choice, or a newly loaded settings draft', async () => {
    const f = fixture(), editor = await f.create({prompt: 'subject'}), first = style(), second = style({id: 'second', name: 'Second', positive: 'second style'});
    await f.picker([first, second]);
    const cards = f.doc.body.querySelectorAll('.daki-draft-picker-card');
    const one = cards[0].onclick(), two = cards[1].onclick();
    f.reply({style: second}, 200, 1); await two; f.reply({style: first}); await one;
    assert.equal(editor.read().prompt, 'second style, subject');
    await f.picker([first]); const pending = f.doc.body.querySelector('.daki-draft-picker-card').onclick();
    editor.setSettings({prompt: 'fresh'}); f.reply({style: first}); await pending;
    assert.equal(editor.read().prompt, 'fresh');
});

test('tag browser inserts exact English tags into the focused prompt without replacing other text', async () => {
    const f = fixture(), editor = await f.create({prompt: 'base', negative_prompt: 'avoid'});
    f.button('Nega').onclick(); f.field('negative_prompt').setSelectionRange(5, 5); f.button('태그 사전').onclick();
    assert.equal(f.tagBrowsers[0].targetLabel, 'Nega 프롬프트'); f.tagBrowsers[0].onInsert('synthetic_tag');
    assert.equal(editor.read().negative_prompt, 'avoid, synthetic_tag'); assert.equal(editor.read().prompt, 'base');
    f.button('캐릭터').onclick(); f.button('＋ 캐릭터').onclick(); f.label('캐릭터 프롬프트').focus(); f.button('태그 사전').onclick();
    f.tagBrowsers[1].onInsert('character_tag'); assert.equal(editor.read().char_prompts[0].prompt, 'character_tag');
    const fieldset = f.doc.createElement('fieldset'); f.doc.body.appendChild(fieldset); fieldset.appendChild(editor.element); fieldset.disabled = true;
    f.tagBrowsers[1].onInsert('blocked_tag'); assert.equal(editor.read().char_prompts[0].prompt, 'character_tag');
    editor.setSettings({prompt: 'restored while busy'}); fieldset.disabled = false;
    assert.equal(f.button('태그 사전').disabled, false);
});

test('dictionary remains browsable with no characters or with a fixed Medium Nega', async () => {
    const f = fixture(), editor = await f.create({prompt: 'base'});
    f.button('캐릭터').onclick();
    assert.equal(f.button('태그 사전').disabled, false);
    assert.equal(f.button('한국어로 미리 보기').disabled, true);
    f.button('태그 사전').onclick();
    assert.equal(f.tagBrowsers.length, 1); assert.equal(f.tagBrowsers[0], undefined);
    assert.equal(editor.read().char_prompts.length, 0); assert.equal(editor.read().prompt, 'base');
    f.button('＋ 캐릭터').onclick(); f.button('삭제').onclick();
    f.button('태그 사전').onclick(); assert.equal(f.tagBrowsers[1], undefined);
    f.select('model', 'nai-diffusion-5-full-medium'); f.button('Nega').onclick();
    assert.equal(f.button('태그 사전').disabled, false); f.button('태그 사전').onclick(); assert.equal(f.tagBrowsers[2], undefined);
    f.button('Base').onclick(); f.button('태그 사전').onclick();
    assert.equal(typeof f.tagBrowsers[3].onInsert, 'function');
});

test('an embedded editor can disable tag browsing without changing prompt or style controls', async () => {
    const f = fixture(), editor = await f.create({prompt: 'synthetic example'}, false, {tagBrowserEnabled: false});
    const tags = f.button('태그 사전'); assert.equal(tags.hidden, true); assert.equal(tags.disabled, true);
    tags.onclick(); assert.equal(f.tagBrowsers.length, 0);
    assert.equal(editor.read().prompt, 'synthetic example');
    assert.ok(f.button('그림체 고르기')); assert.ok(f.button('한국어로 미리 보기'));
    f.button('캐릭터').onclick(); f.button('＋ 캐릭터').onclick();
    assert.equal(editor.read().char_prompts.length, 1); assert.equal(tags.disabled, true);
});

test('translation is read-only and stale input or disposal prevents its response appearing', async () => {
    const f = fixture(), editor = await f.create({prompt: 'synthetic_tag'});
    const translate = f.button('한국어로 미리 보기').onclick();
    assert.deepEqual(f.requests.at(-1), {url: '/api/daki/tag-catalog/translate', method: 'POST', body: {text: 'synthetic_tag'}});
    f.reply({text: '합성 태그', translated: 1, untranslated: 0}); await translate;
    assert.match(f.doc.body.querySelector('.daki-draft-translation').textContent, /합성 태그/); assert.equal(editor.read().prompt, 'synthetic_tag');
    const stale = f.button('한국어로 미리 보기').onclick(); f.change('prompt', 'updated'); f.reply({text: '늦은 번역'}); await stale;
    assert.equal(f.doc.body.querySelector('.daki-draft-translation').hidden, true);
    const closed = f.button('한국어로 미리 보기').onclick(); editor.dispose(); f.reply({text: '닫은 후 번역'}); await closed;
    assert.ok(!f.doc.body.textContent.includes('닫은 후 번역')); assert.equal(editor.read(), null);
});

test('closing the picker drops late list results without mutating the editor', async () => {
    const f = fixture(), editor = await f.create({prompt: 'unchanged'});
    const opening = f.button('그림체 고르기').onclick(); f.button('닫기').onclick(); f.reply({styles: [style()]}); await opening;
    assert.equal(f.doc.body.querySelector('dialog'), null); assert.equal(editor.read().prompt, 'unchanged');
    editor.dispose(); editor.setSettings({prompt: 'should not change'}); await flush();
    assert.equal(f.field('prompt').value, 'unchanged');
});

test('named tests show completed result thumbnails and apply the current original recipe rather than test settings', async () => {
    const f = fixture(), editor = await f.create({prompt: 'current subject', width: 1024, height: 1024, seed: 456});
    const original = style({model: 'nai-diffusion-4-5-full', options: {steps: 23, cfg: 8}});
    await history(f, 'tests', [{id: batchId, name: 'Synthetic medium test', created_at: '2026-01-02T00:00:00Z'},
        {id: 'd'.repeat(32), name: 'Synthetic medium test', created_at: '2026-01-03T00:00:00Z'}], [original]);
    assert.equal(f.label('기준 테스트').value, '');
    assert.equal(f.doc.body.querySelectorAll('.daki-draft-picker-card').length, 0);
    const options = f.label('기준 테스트').querySelectorAll('option');
    assert.notEqual(options[1].textContent, options[2].textContent);
    await record(f, 'tests', batchId, {model: 'nai-diffusion-5-full-medium', prompt: 'old test subject', items: [
        {style_id: original.id, name: original.name, status: 'completed', src: '/synthetic/result.jpg', model: 'nai-diffusion-5-full-medium', options: {steps: 14, cfg: 2}},
        {style_id: 'pending_style', name: 'Pending', status: 'pending'}, {style_id: 'failed_style', name: 'Failed', status: 'failed'}]});
    const cards = f.doc.body.querySelectorAll('.daki-draft-picker-card'); assert.equal(cards.length, 1);
    assert.equal(cards[0].querySelector('img').src, '/synthetic/result.jpg');
    await f.choose(original);
    assert.equal(f.requests.at(-1).url, '/api/daki/shared-styles/' + original.id);
    const result = editor.read();
    assert.equal(result.model, original.model); assert.equal(result.options.steps, 23); assert.equal(result.options.cfg, 8);
    assert.equal(result.prompt, 'synthetic paint, current subject'); assert.equal(result.seed, 456); assert.equal(result.width, 1024);
    assert.ok(f.requests.every(request => request.method === 'GET'));
});

test('worldcup ranks include tied places and shared personal and test references resolve to their original libraries', async () => {
    const f = fixture(), editor = await f.create(), shared = style(), personal = style({id: personalId, name: 'Personal original'});
    await history(f, 'worldcups', [{id: cupId, title: 'Synthetic cup', created_at: '2026-01-02T00:00:00Z'}], [shared], [personal]);
    await record(f, 'worldcups', cupId, {participants: [
        {path: '__daki_shared__/' + shared.id + '.png', name: 'Shared representative', rank: 3, src: '/synthetic/shared.png'},
        {path: '__daki_tests__/' + batchId + '/' + personalId + '.png', name: 'Personal test result', rank: 1, src: '/synthetic/test.jpg'},
        {path: '__daki_personal__/' + personalId + '.png', name: 'Personal representative', rank: 3, src: '/synthetic/personal.png'},
    ]});
    const cards = f.doc.body.querySelectorAll('.daki-draft-picker-card');
    assert.equal(cards[0].getAttribute('aria-label'), 'Personal test result 적용');
    assert.equal(cards[0].querySelector('.daki-draft-picker-rank').textContent, '1위');
    assert.equal(cards[1].querySelector('.daki-draft-picker-rank').textContent, '공동 3위');
    assert.equal(cards[2].querySelector('.daki-draft-picker-rank').textContent, '공동 3위');
    assert.ok(cards.every(card => !card.disabled));
    const choosing = cards[0].onclick(); f.reply({style: personal}); await choosing;
    assert.equal(f.requests.at(-1).url, '/api/daki/personal-styles/' + personalId);
    assert.equal(editor.read().style.library, 'personal'); assert.equal(editor.read().style.id, personalId);
});

test('removed recipes and malformed or unrelated tournament paths are visibly unavailable and never fetch a fallback', async () => {
    const f = fixture(), editor = await f.create({prompt: 'unchanged'});
    await history(f, 'worldcups', [{id: cupId, title: 'Synthetic cup'}]);
    const invalid = ['__daki_shared__/removed.png', '__daki_shared__/style_example.png\n',
        '__daki_shared__/%73tyle_example.png', '__daki_tests__/short/style_example.png',
        '__daki_tests__/' + batchId + '/../style_example.png', '__daki_personal__/style_example.png',
        'gallery/synthetic.png', '__daki_drafts__/' + batchId + '.png'];
    await record(f, 'worldcups', cupId, {participants: invalid.map((path, index) => ({path, name: 'Unavailable ' + index, rank: index + 1}))});
    const cards = f.doc.body.querySelectorAll('.daki-draft-picker-card'), count = f.requests.length;
    assert.equal(cards.length, invalid.length); assert.ok(cards.every(card => card.disabled));
    cards.forEach(card => card.onclick()); assert.equal(f.requests.length, count);
    assert.match(f.doc.body.textContent, /원본 연결 불가 8개/); assert.match(f.doc.body.textContent, /현재 목록에 없는 원본/);
    assert.equal(editor.read().prompt, 'unchanged');
});

test('switching history source ignores both late record lists and late selected recipe responses', async () => {
    const f = fixture(), editor = await f.create({prompt: 'keep'}), original = style();
    await f.picker([original]);
    const library = f.label('그림체 라이브러리'); library.value = 'tests'; const old = library.onchange();
    library.value = 'personal'; const newer = library.onchange();
    f.reply({styles: []}, 200, 3); await newer;
    f.reply({batches: [{id: batchId, name: 'Late test'}]}); f.reply({styles: [original]}); f.reply({styles: []}); await old;
    assert.equal(f.doc.body.querySelectorAll('.daki-draft-picker-card').length, 0);
    assert.ok(!f.doc.body.textContent.includes('Late test'));
    library.value = 'tests'; const loaded = library.onchange();
    f.reply({batches: [{id: batchId, name: 'Test'}]}); f.reply({styles: [original]}); f.reply({styles: []}); await loaded;
    await record(f, 'tests', batchId, {items: [{style_id: original.id, name: original.name, status: 'completed', src: '/synthetic/result.jpg'}]});
    const selecting = f.doc.body.querySelector('.daki-draft-picker-card').onclick();
    library.value = 'shared'; const changed = library.onchange(); f.reply({styles: [original]}, 200, 1); await changed;
    f.reply({style: original}); await selecting;
    assert.equal(editor.read().prompt, 'keep'); assert.ok(f.doc.body.querySelector('dialog'));
});

test('a late tournament detail cannot replace a newer selected record or reopen a closed picker', async () => {
    const f = fixture(); await f.create();
    const second = 'd'.repeat(32); await history(f, 'worldcups', [{id: cupId, title: 'Old cup'}, {id: second, title: 'New cup'}]);
    const select = f.label('기준 월드컵'); select.value = cupId; const old = select.onchange();
    select.value = second; const newer = select.onchange();
    f.reply({record: {participants: [{path: '__daki_shared__/style_example.png', name: 'Latest picture', rank: 1}]}}, 200, 1); await newer;
    f.reply({record: {participants: [{path: '__daki_shared__/style_example.png', name: 'Stale picture', rank: 1}]}}); await old;
    assert.match(f.doc.body.querySelector('.daki-draft-picker-grid').textContent, /Latest picture/);
    assert.ok(!f.doc.body.querySelector('.daki-draft-picker-grid').textContent.includes('Stale picture'));
    const pending = select.onchange(); f.button('닫기').onclick(); f.reply({record: {participants: []}}); await pending;
    assert.equal(f.doc.body.querySelector('dialog'), null);
});

test('failed active catalog or history requests cannot expose selectable stale cards', async () => {
    const f = fixture(); await f.create(); await f.picker([style()]);
    const library = f.label('그림체 라이브러리'); library.value = 'tests'; const loading = library.onchange();
    f.reply({batches: [{id: batchId, name: 'Test'}]}); f.reply({message: 'catalog unavailable'}, 500); f.reply({styles: []}); await loading;
    assert.equal(f.doc.body.querySelectorAll('.daki-draft-picker-card').length, 0);
    assert.equal(f.label('기준 테스트').disabled, true); assert.match(f.doc.body.textContent, /catalog unavailable/);
    const retry = library.onchange(); f.reply({batches: [{id: batchId, name: 'Test'}]}); f.reply({styles: [style()]}); f.reply({styles: []}); await retry;
    const select = f.label('기준 테스트'); select.value = batchId; const detail = select.onchange();
    f.reply({message: 'record unavailable'}, 404); await detail;
    assert.equal(f.doc.body.querySelectorAll('.daki-draft-picker-card').length, 0); assert.match(f.doc.body.textContent, /record unavailable/);
});

test('picker reuses gallery tag icons and combines representative tags with name search', async () => {
    const f = fixture(); await f.create();
    const first = style(), second = style({id: 'second', name: 'Second'});
    f.imageTags['__daki_shared__/style_example.png'] = 'keep';
    f.imageTags['__daki_shared__/second.png'] = 'maybe';
    await f.picker([first, second, style({id: 'untagged', name: 'Untagged'})]);
    const tagIcon = f.doc.body.querySelectorAll('button').find(button => button.value === 'tag:maybe');
    assert.equal(tagIcon.innerHTML, '<img src="/synthetic/tag.png">');
    f.selectTag('tagged'); assert.equal(f.visibleCards().length, 2);
    f.selectTag('tag:keep'); assert.equal(f.visibleCards()[0].getAttribute('aria-label'), first.name + ' 적용');
    const search = f.label('그림체 이름 검색'); search.value = 'second'; search.oninput();
    assert.equal(f.visibleCards().length, 0); assert.match(f.doc.body.textContent, /태그와 검색 조건에 맞는 그림체가 없습니다/);
    f.selectTag('tag:maybe'); assert.equal(f.visibleCards().length, 1);
    search.value = ''; search.oninput(); f.selectTag('all'); assert.equal(f.visibleCards().length, 3);
    const library = f.label('그림체 라이브러리'); library.value = 'personal'; const pending = library.onchange();
    f.reply({styles: [style({id: personalId})]}); await pending;
    f.imageTags['__daki_personal__/' + personalId + '.png'] = 'keep';
    f.selectTag('tag:keep'); assert.equal(f.visibleCards().length, 1);
    assert.ok(f.requests.every(request => !request.url.includes('worldcups')));
});

test('test and worldcup tag filters use the shown result image tags and still apply the original recipe', async () => {
    const f = fixture(), editor = await f.create();
    f.imageTags['__daki_shared__/style_example.png'] = 'maybe';
    f.imageTags[`__daki_tests__/${batchId}/style_example.png`] = 'keep';
    await history(f, 'tests', [{id: batchId, name: 'Test'}]);
    await record(f, 'tests', batchId, {items: [{style_id: 'style_example', name: 'Test image', status: 'completed', src: '/synthetic/result.jpg'}]});
    f.selectTag('tag:maybe'); assert.equal(f.visibleCards().length, 0);
    f.selectTag('tag:keep'); assert.equal(f.visibleCards().length, 1);
    f.button('닫기').onclick();
    await history(f, 'worldcups', [{id: cupId, title: 'Cup'}]);
    await record(f, 'worldcups', cupId, {participants: [
        {path: '__daki_shared__/style_example.png', name: 'Representative', rank: 2},
        {path: `__daki_tests__/${batchId}/style_example.png`, name: 'Winner', rank: 1}]});
    f.selectTag('tag:keep'); const [card] = f.visibleCards();
    assert.equal(card.getAttribute('aria-label'), 'Winner 적용');
    assert.equal(card.querySelector('.daki-draft-picker-rank').textContent, '1위');
    const choosing = card.onclick(); f.reply({style: style({model: 'nai-diffusion-4-5-full'})}); await choosing;
    assert.equal(editor.read().model, 'nai-diffusion-4-5-full'); assert.equal(editor.read().style.id, 'style_example');
});

test('picker tag updates refresh cards and closing or disposing removes its listener', async () => {
    const f = fixture(), editor = await f.create(); await f.picker([style()]);
    f.selectTag('tagged'); assert.equal(f.visibleCards().length, 0);
    f.imageTags['__daki_shared__/style_example.png'] = 'keep'; f.fire('gallery-tags-updated');
    assert.equal(f.visibleCards().length, 1);
    f.selectTag('tag:keep'); f.definitions.splice(0); f.fire('gallery-tags-updated');
    assert.equal(f.doc.body.querySelectorAll('button').find(button => button.value === 'all').getAttribute('aria-pressed'), 'true');
    f.button('닫기').onclick(); assert.equal(f.events.get('gallery-tags-updated').size, 0);
    await f.picker([style()]); assert.equal(f.events.get('gallery-tags-updated').size, 1);
    editor.dispose(); assert.equal(f.events.get('gallery-tags-updated').size, 0);
    f.fire('gallery-tags-updated'); assert.equal(f.doc.body.querySelector('dialog'), null);
});

test('prompt spans collapse under a name, remain exactly editable, and ungroup without losing syntax', async () => {
    const f = fixture(), raw = '1.2::ink, soft lines::, blue sky';
    const editor = await f.create({prompt: raw});
    const input = f.label('Base 프롬프트'), prefix = '1.2::ink, soft lines::';
    const groups = input.parentNode.parentNode.querySelector('.daki-prompt-groups');
    f.label('임시 묶음 이름').value = '그림체'; input.setSelectionRange(0, prefix.length);
    f.button('선택 영역 묶기').onclick();
    assert.equal(editor.read().prompt, raw);
    assert.equal(input.parentNode.hidden, true);
    const group = groups.querySelector('.daki-prompt-group');
    assert.equal(group.open, false); assert.equal(group.querySelector('summary').textContent, '그림체');
    const textAreas = groups.querySelectorAll('.daki-prompt-text-segment');
    assert.deepEqual(textAreas.map(item => item.value), ['', ', blue sky']);
    group.open = true;
    const groupText = group.querySelector('textarea'); groupText.value = '1.3::pen lines::'; groupText.oninput();
    assert.equal(editor.read().prompt, '1.3::pen lines::, blue sky');
    f.button('그룹 해제').onclick();
    assert.equal(input.parentNode.hidden, false);
    assert.equal(editor.read().prompt, '1.3::pen lines::, blue sky');
    assert.equal(f.doc.body.querySelector('.daki-prompt-group'), null);
});

test('duplicate prompt spans use the selected position and focused text keeps tag insertion in the canonical prompt', async () => {
    const f = fixture(), raw = 'same, middle, same', editor = await f.create({prompt: raw});
    const input = f.label('Base 프롬프트'), lastStart = raw.lastIndexOf('same');
    const groups = input.parentNode.parentNode.querySelector('.daki-prompt-groups');
    input.setSelectionRange(lastStart, lastStart + 4); f.label('임시 묶음 이름').value = '마지막';
    f.button('선택 영역 묶기').onclick();
    assert.equal(editor.read().prompt, raw);
    const groupBlocks = groups.querySelectorAll('.daki-prompt-group');
    assert.equal(groupBlocks.length, 1); assert.equal(groupBlocks[0].querySelector('textarea').value, 'same');
    const segments = groups.querySelectorAll('.daki-prompt-text-segment');
    assert.deepEqual(segments.map(item => item.value), ['same, middle, ', '']);
    const tail = segments[1]; tail.focus(); tail.setSelectionRange(0, 0);
    f.button('태그 사전').onclick(); f.tagBrowsers[0].onInsert('new_tag');
    assert.equal(editor.read().prompt, 'same, middle, same, new_tag');
});

test('style metadata folds only exact delimiter-bounded prefixes and settings replacement clears temporary groups', async () => {
    const f = fixture(), styleData = {id: 'loaded', name: 'Ink Style', positive: 'paint', negative: 'avoid'};
    const editor = await f.create({prompt: 'paint, subject', negative_prompt: 'avoid, no extra', style: styleData});
    assert.equal(editor.read().prompt, 'paint, subject'); assert.equal(editor.read().negative_prompt, 'avoid, no extra');
    assert.deepEqual(f.doc.body.querySelectorAll('.daki-prompt-group-summary').map(item => item.textContent), ['Ink Style', 'Ink Style']);
    f.button('Nega').onclick(); f.button('Base').onclick();
    f.button('태그 사전').onclick();
    assert.equal(f.tagBrowsers[0].targetLabel, 'Base 프롬프트 · 묶음 사이 텍스트');
    f.tagBrowsers[0].onInsert('new_subject'); assert.equal(editor.read().prompt, 'new_subject, paint, subject');
    const translating = f.button('한국어로 미리 보기').onclick();
    assert.deepEqual(f.requests.at(-1).body, {text: 'new_subject, paint, subject'});
    f.reply({text: '합성 프롬프트 번역'}); await translating;
    editor.setSettings({prompt: 'painted subject', negative_prompt: 'avoidance, subject', style: styleData});
    assert.equal(f.doc.body.querySelectorAll('.daki-prompt-group').length, 0);
    assert.equal(f.label('Base 프롬프트').parentNode.hidden, false);
    assert.equal(editor.read().prompt, 'painted subject');
    f.label('Base 프롬프트').setSelectionRange(0, 7); f.label('임시 묶음 이름').value = '임시';
    f.button('선택 영역 묶기').onclick(); assert.equal(f.doc.body.querySelectorAll('.daki-prompt-group').length, 1);
    editor.setSettings({prompt: 'fresh'});
    assert.equal(f.doc.body.querySelectorAll('.daki-prompt-group').length, 0);
    assert.equal(editor.read().prompt, 'fresh');
});

test('Medium and disabled fieldsets disable editable group controls while preserving prompt text', async () => {
    const styleData = {id: 'medium', name: 'Medium Style', positive: 'paint', negative: 'avoid'};
    const f = fixture(), editor = await f.create({prompt: 'paint, subject', negative_prompt: 'avoid, subject', model: 'nai-diffusion-5-full-medium', style: styleData});
    assert.equal(editor.read().prompt, 'paint, subject'); assert.equal(editor.read().negative_prompt, 'avoid, subject');
    const negGroup = f.doc.body.querySelectorAll('.daki-prompt-group').find(item => item.querySelector('textarea').getAttribute('aria-label').startsWith('Nega'));
    assert.equal(negGroup.querySelector('textarea').disabled, true);
    const fieldset = f.doc.createElement('fieldset'); f.doc.body.appendChild(fieldset); fieldset.appendChild(editor.element); fieldset.disabled = true;
    f.change('width', '512');
    const controls = f.doc.body.querySelectorAll('.daki-prompt-groups button');
    assert.ok(controls.every(item => item.disabled));
    assert.equal(editor.read().prompt, 'paint, subject');
});

test('character prompts keep each textarea with its group controls and deletion restores the remaining active target', async () => {
    const f = fixture(), editor = await f.create();
    f.button('캐릭터').onclick(); f.button('＋ 캐릭터').onclick(); f.button('＋ 캐릭터').onclick();
    const rows = f.doc.body.querySelectorAll('.daki-draft-character');
    const first = rows[0].querySelectorAll('textarea').find(item => item.getAttribute('aria-label') === '캐릭터 프롬프트');
    const second = rows[1].querySelectorAll('textarea').find(item => item.getAttribute('aria-label') === '캐릭터 프롬프트');
    assert.equal(rows[0].querySelectorAll('.daki-draft-prompt-entry').length, 2);
    first.value = 'first, character'; first.oninput(); first.setSelectionRange(0, 5);
    const firstGroups = first.parentNode.parentNode.querySelector('.daki-prompt-groups');
    firstGroups.querySelector('.daki-prompt-group-create').onclick();
    second.focus(); second.value = 'second, character'; second.oninput(); second.setSelectionRange(0, 6);
    const secondGroups = second.parentNode.parentNode.querySelector('.daki-prompt-groups');
    secondGroups.querySelector('.daki-prompt-group-create').onclick();
    rows[1].querySelectorAll('button')[0].onclick();
    f.button('태그 사전').onclick();
    assert.equal(f.tagBrowsers[0].targetLabel, '캐릭터 프롬프트 · 묶음 사이 텍스트');
    f.tagBrowsers[0].onInsert('remaining_tag');
    assert.equal(editor.read().char_prompts.length, 1);
    assert.equal(editor.read().char_prompts[0].prompt, 'remaining_tag, first, character');
});
