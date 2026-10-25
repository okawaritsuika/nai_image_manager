const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
    class Element {
        constructor(tag) {
            this.tagName = tag.toUpperCase();
            this.children = [];
            this.attributes = {};
            this.dataset = {};
            this.listeners = new Map();
            this.className = '';
            this.classList = {add: (...names) => {
                this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' ');
            }};
            this.style = {setProperty(name, value) { this[name] = value; }};
            this.value = '';
            this.checked = false;
            this.disabled = false;
            this.hidden = false;
            this.open = false;
            this.text = '';
            this.elements = {namedItem: name => this.descendants().find(el => el.name === name)};
        }
        descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
        appendChild(child) {
            child.remove(); this.children.push(child); child.parentNode = this; return child;
        }
        append(...children) { children.forEach(child => this.appendChild(child)); }
        replaceChildren(...children) {
            this.children.forEach(child => { child.parentNode = null; });
            this.children = []; this.text = ''; this.append(...children);
        }
        remove() {
            if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
            this.parentNode = null;
        }
        replaceWith(child) {
            if (this.parentNode) this.parentNode.replaceChild(child, this);
        }
        replaceChild(child, previous) {
            child.remove();
            const index = this.children.indexOf(previous);
            assert.notEqual(index, -1);
            this.children[index] = child; child.parentNode = this; previous.parentNode = null;
            return previous;
        }
        set textContent(value) { this.replaceChildren(); this.text = String(value); }
        get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
        get lastChild() { return this.children.at(-1); }
        setAttribute(name, value) {
            this.attributes[name] = value; this[name] = value;
            if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
        }
        addEventListener(name, callback) {
            const callbacks = this.listeners.get(name) || []; callbacks.push(callback); this.listeners.set(name, callbacks);
        }
        showModal() { this.open = true; }
        close() { this.open = false; (this.listeners.get('close') || []).forEach(callback => callback()); }
        focus() { doc.activeElement = this; }
        insertBefore(child, sibling) {
            child.remove(); this.children.splice(this.children.indexOf(sibling), 0, child); child.parentNode = this;
        }
        matches(selector) {
            if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
            if (selector.startsWith('[')) {
                const [, key, value] = selector.match(/^\[([^=]+)=([^\]]+)\]$/);
                return this[key] === value.replace(/^['"]|['"]$/g, '');
            }
            return this.tagName === selector.toUpperCase();
        }
        querySelectorAll(selector) { return this.descendants().filter(el => el.matches(selector)); }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
        set innerHTML(html) {
            this.replaceChildren();
            const stack = [this];
            for (const token of html.matchAll(/<\/?([a-z][a-z0-9]*)([^>]*)>/gi)) {
                if (token[0].startsWith('</')) { stack.pop(); continue; }
                const element = new Element(token[1]);
                for (const attribute of token[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
                    const [, name, value] = attribute;
                    if (name === 'class') element.className = value;
                    else if (name === 'hidden') element.hidden = true;
                    else element.setAttribute(name, value === undefined ? '' : value);
                }
                stack.at(-1).appendChild(element);
                if (!['input', 'img', 'br', 'hr'].includes(token[1])) stack.push(element);
            }
        }
    }
    const doc = {body: new Element('body'), createElement: tag => new Element(tag)};
    doc.getElementById = id => doc.body.descendants().find(el => el.id === id) || null;
    for (const id of ['dakiTitle', 'dakiSubtitle', 'dakiBack', 'dakiPageStatus', 'dakiContent']) {
        const element = new Element('div'); element.id = id; doc.body.appendChild(element);
    }
    const requests = [];
    const pending = [];
    const timers = new Map();
    let nextTimer = 0;
    let active = true;
    const renames = [], appends = [], worldcups = [], warnings = [], approvals = [], syncs = [], testPackOpens = [];
    const win = {
        document: doc,
        location: {hash: '#daki&library=shared&category=upper'},
        Daki: {
            isActive: () => active,
            createGrid(className, items = [], imageGrid = true) {
                const grid = new Element('div');
                grid.className = `flex-masonry ${className}`;
                grid.setItems = items => grid.replaceChildren(...items);
                grid.setItems(items);
                return grid;
            },
            folderCard(name, href, count, subtitle, src) {
                const card = new Element('a'); card.className = 'card'; card.href = href;
                card.textContent = name;
                card.folder = {name, href, count, subtitle, src};
                if (src) { const image = new Element('img'); image.src = src; card.appendChild(image); }
                return card;
            },
            bindImage(card, image, path) { card.dataset.path = path; },
            createImageTools() { return new Element('div'); },
        },
        DakiTestLibrary: {
            rename: (...args) => renames.push(args), append: (...args) => appends.push(args), leave() {},
        },
        DakiWorldCup: {open: (...args) => worldcups.push(args)},
        DakiStyleSync: {open: options => syncs.push(options), leave() {}},
        DakiTestPacks: {open: options => testPackOpens.push(options), leave() {}},
        fetch(url, options) {
            const request = {url, method: options.method,
                body: options.body === undefined ? undefined : JSON.parse(options.body)};
            requests.push(request);
            return new Promise(resolve => pending.push({request, resolve}));
        },
        setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, {callback, delay}); return id; },
        clearTimeout(id) { timers.delete(id); },
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../static/generation_settings.js'), 'utf8'), win);
    vm.runInNewContext(fs.readFileSync(require.resolve('../static/common_anlas_warning.js'), 'utf8'), {window: win});
    win.showAnlasWarningModal = options => { warnings.push(JSON.parse(JSON.stringify(options))); return new Promise(resolve => approvals.push(resolve)); };
    vm.runInNewContext(fs.readFileSync(require.resolve('../static/daki_styles.js'), 'utf8'), {window: win, URL});
    const content = doc.getElementById('dakiContent');
    function reply(data, status = 200) {
        const request = pending.shift(); assert.ok(request, 'Expected an API request');
        request.resolve({ok: status < 400, json: async () => ({status: status < 400 ? 'success' : 'error', ...data})});
        return request.request;
    }
    function fireTimer() {
        const [id, timer] = timers.entries().next().value || [];
        assert.ok(timer, 'Expected a scheduled poll'); assert.equal(timer.delay, 1000);
        timers.delete(id); return timer.callback();
    }
    const buttons = () => doc.body.querySelectorAll('button');
    const button = text => {
        const result = buttons().find(el => el.textContent === text); assert.ok(result, text); return result;
    };
    return {win, doc, requests, pending, timers, reply, fireTimer, content, button, renames, appends, worldcups, syncs, testPackOpens,
        warnings, confirm(value) { assert.ok(approvals.length); approvals.shift()(value); return new Promise(resolve => setImmediate(resolve)); },
        setActive(value) { active = value; },
        render(params = 'batch=test-one') { return win.DakiStyles.render(new URLSearchParams(params), content); }};
}

function batch(overrides = {}) {
    return {id: 'test-one', created_at: '2026-01-01T00:00:00Z', model: 'nai-diffusion-5-full',
        prompt: 'synthetic common prompt', negative_prompt: '', char_prompts: [],
        status: 'ready', completed: 0, total: 2, pending: 2, failed: 0,
        items: ['one', 'two'].map(id => ({style_id: id, name: `Style ${id}`, status: 'pending',
            width: 1024, height: 1024, options: {steps: 28}, requires_anlas: false, source_src: `/source/${id}`})), ...overrides};
}

function settingsOptions() {
    return {configured: true, size_limits: {min: 64, max: 49152, step: 64, max_pixels: 3145728},
        size_presets: [
            {id: 'small', label: 'Small', sizes: [[640, 640], [512, 768]]},
            {id: 'normal', label: 'Normal', sizes: [[1024, 1024], [832, 1216]]},
            {id: 'large', label: 'Large', sizes: [[1024, 1536]]},
            {id: 'wallpaper', label: 'Wallpaper', sizes: [[1472, 1472], [1088, 1920]]},
            {id: 'daki', label: 'Daki', sizes: [[320, 1024], [512, 1664], [640, 2048], [960, 3072], [1024, 3072]]},
        ]};
}

async function openTestSettings(f, edit = false) {
    const opened = f.button(edit ? '설정 수정' : '전체 그림체로 테스트 만들기').onclick();
    assert.equal(f.reply(settingsOptions()).url, '/api/daki/style-tests/options');
    await opened;
    return f.doc.getElementById('dakiTestForm');
}

function styleCatalog() {
    return {configured: true, styles: [
        {id: 'one', name: 'Synthetic blue V5', category: 'v5', src: '/source/one'},
        {id: 'two', name: 'Synthetic green V5', category: 'v5', src: '/source/two'},
        {id: 'three', name: 'Synthetic blue V5', category: 'v5', src: '/source/three'},
    ]};
}

async function openStyleList(f, category = 'all') {
    const catalog = styleCatalog();
    const render = f.render('library=shared&category=' + category);
    f.reply(catalog); await render;
    return catalog;
}

function styleCheckbox(card) {
    const checkbox = card.querySelectorAll('input').find(input => input.type === 'checkbox');
    assert.ok(checkbox, 'Style card has a selection checkbox');
    return checkbox;
}

function selectStyle(card, selected = true) {
    const checkbox = styleCheckbox(card); checkbox.checked = selected; checkbox.onchange();
    return checkbox;
}

function styleDetail() {
    return {id: 'one', name: 'Synthetic blue upper', model: 'nai-diffusion-5-full',
        positive: '  1.2::synthetic_style::,\n<img src="example" onerror="unsafe()"> & text  ',
        negative: 'synthetic negative,\n  0.5::blur::, <plain text>',
        preview: {width: 832, height: 1216}, seed: 4294967297,
        source_url: 'https://arca.live/b/aiart/120001',
        options: {steps: 28, cfg: 5.5, sampler: 'k_euler_ancestral', noise_schedule: 'karras',
            cfg_rescale: 0, strength: .5, noise: 0, prefer_brownian: true,
            deliberate_euler_ancestral_bug: false, dynamic_thresholding: false, legacy_v3_extend: false}};
}

async function openStyleDetail(f, style = styleDetail()) {
    await openStyleList(f);
    const load = f.content.querySelector('.daki-style-card').querySelector('button').onclick();
    const dialog = f.doc.body.querySelector('dialog');
    assert.ok(dialog.open);
    assert.deepEqual(f.reply({style}), {url: '/api/daki/shared-styles/one', method: 'GET', body: undefined});
    await load;
    return dialog;
}

function pressKey(target, key) {
    const event = {key, target, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.stopped = true; }};
    for (let element = target; element && !event.stopped; element = element.parentNode) {
        event.currentTarget = element;
        element.onkeydown?.(event);
        (element.listeners.get('keydown') || []).forEach(callback => callback(event));
    }
    return event;
}

async function openBatch(f, value = batch()) {
    const render = f.render(); f.reply({batch: value}); await render;
    return {next: f.button('다음 그림체 한 장 생성'), all: f.button('남은 그림체 모두 생성'), stop: f.button('중지')};
}

test('next, remaining, and stop send explicit modes and prevent duplicate commands', async () => {
    const f = fixture();
    const {next, all, stop} = await openBatch(f);
    assert.equal(stop.disabled, true);
    const nextRun = next.onclick();
    assert.equal(next.disabled, true); assert.equal(all.disabled, true);
    await all.onclick();
    assert.equal(f.pending.length, 1);
    assert.deepEqual(f.reply({batch: batch({status: 'paused'})}), {
        url: '/api/daki/style-tests/test-one/run', method: 'POST', body: {mode: 'next', allow_anlas: false},
    });
    await nextRun;
    const remaining = all.onclick();
    assert.deepEqual(f.reply({batch: batch({status: 'running'})}), {
        url: '/api/daki/style-tests/test-one/run', method: 'POST', body: {mode: 'remaining', allow_anlas: false},
    });
    await remaining;
    assert.equal(stop.disabled, false); assert.equal(next.disabled, true);
    assert.equal(f.timers.size, 1);
    const stopping = stop.onclick();
    assert.deepEqual(f.reply({batch: batch({status: 'stopping'})}), {
        url: '/api/daki/style-tests/test-one/stop', method: 'POST', body: {},
    });
    await stopping;
    assert.equal(stop.disabled, true); assert.equal(f.timers.size, 1);
    assert.equal(f.warnings.length, 0);
});

test('paid next and remaining show one modal for the selected queue and cancellation sends nothing', async () => {
    const f = fixture(), value = batch();
    Object.assign(value.items[0], {width: 640, height: 2048, options: {steps: 35}, requires_anlas: true});
    const {next, all, stop} = await openBatch(f, value);
    const cancelled = next.onclick(); await all.onclick();
    assert.equal(f.requests.length, 1); assert.equal(f.warnings.length, 1);
    assert.equal(next.disabled, true); assert.equal(f.button('설정 수정').disabled, true);
    assert.deepEqual(f.warnings[0].requests, [{width: 640, height: 2048, steps: 35}]);
    await f.confirm(false); await cancelled;
    assert.equal(f.requests.length, 1); assert.equal(next.disabled, false);
    const accepted = all.onclick();
    assert.deepEqual(f.warnings[1].requests, [{width: 640, height: 2048, steps: 35}, {width: 1024, height: 1024, steps: 28}]);
    assert.match(f.warnings[1].detail, /2장 중 1장/);
    await f.confirm(true);
    const running = {...value, status: 'running'};
    assert.equal(f.reply({batch: running}).body.allow_anlas, true); await accepted;
    const stopping = stop.onclick(); f.reply({batch: {...running, status: 'stopping'}}); await stopping;
    assert.equal(f.warnings.length, 2, 'stop does not request Anlas approval');
});

test('leaving while a test confirmation is open prevents an approved stale request', async () => {
    const f = fixture(), value = batch(); value.items[0].options.steps = 29;
    const {next} = await openBatch(f, value); const request = next.onclick();
    f.setActive(false); f.win.DakiStyles.leave(); f.doc.getElementById('dakiPageStatus').textContent = 'New page';
    await f.confirm(true); await request;
    assert.equal(f.requests.length, 1); assert.equal(f.doc.getElementById('dakiPageStatus').textContent, 'New page');
});

test('test warnings use effective Medium steps rather than original style steps', async () => {
    const f = fixture(), value = batch({model: 'nai-diffusion-5-full-medium'});
    value.items[0].options.steps = 50;
    Object.assign(value.items[1], {width: 640, height: 2048, options: {steps: 40}});
    const {next, all} = await openBatch(f, value);
    const free = next.onclick(); assert.equal(f.warnings.length, 0);
    assert.equal(f.reply({batch: value}).body.allow_anlas, false); await free;
    const paid = all.onclick();
    assert.deepEqual(f.warnings[0].requests.map(item => item.steps), [14, 14]);
    await f.confirm(false); await paid; assert.equal(f.requests.length, 2);
});

test('polling updates completed images incrementally and stops after completion', async () => {
    const f = fixture();
    await openBatch(f, batch({status: 'running'}));
    const grid = f.content.querySelector('.daki-style-grid');
    const [first, second] = grid.children;
    const secondPreview = second.children[0];
    const partial = batch({status: 'running', completed: 1, pending: 1});
    partial.items[0] = {...partial.items[0], status: 'completed', src: '/result/one.png'};
    const poll = f.fireTimer(); f.reply({batch: partial}); await poll;
    assert.equal(grid.children[0], first); assert.equal(grid.children[1], second);
    assert.equal(first.querySelector('img').src, '/result/one.png');
    assert.equal(second.children[0], secondPreview);
    assert.ok(first.matches('.item-box'));
    assert.ok(first.children[0].matches('.zoomable'));
    assert.equal(first.children[0].tagName, 'IMG');
    assert.ok(first.querySelector('.gallery-card-actions'));
    const firstImage = first.querySelector('img');
    const done = structuredClone(partial);
    Object.assign(done, {status: 'completed', completed: 2, pending: 0});
    done.items[1] = {...done.items[1], status: 'completed', src: '/result/two.png'};
    const finalPoll = f.fireTimer(); f.reply({batch: done}); await finalPoll;
    assert.equal(first.querySelector('img'), firstImage);
    assert.equal(second.querySelector('img').src, '/result/two.png');
    assert.equal(f.timers.size, 0);
    assert.match(f.content.querySelector('.daki-test-progress').textContent, /2\/2장 완료/);
});

test('WebP conversion progress, placeholder, and conversion warnings update from batch snapshots', async () => {
    const f = fixture();
    const converting = batch({status: 'running', completed: 1, pending: 0, converting: 1});
    converting.items[0] = {...converting.items[0], status: 'converting'};
    converting.items[1] = {...converting.items[1], status: 'completed', src: '/result/two.png',
        conversion_error: 'WebP 변환에 실패해 PNG를 유지했습니다.'};
    await openBatch(f, converting);
    assert.match(f.content.querySelector('.daki-test-progress').textContent, /1장 WebP 변환 중/);
    const grid = f.content.querySelector('.daki-style-grid');
    assert.match(grid.children[0].textContent, /WebP 변환 중…/);
    assert.match(grid.children[1].textContent, /WebP 변환에 실패해 PNG를 유지했습니다\./);

    const completed = structuredClone(converting);
    Object.assign(completed, {status: 'completed', completed: 2, converting: 0});
    completed.items[0] = {...completed.items[0], status: 'completed', src: '/result/one.png'};
    completed.items[1].conversion_error = 'PNG로 저장했습니다.';
    const poll = f.fireTimer(); f.reply({batch: completed}); await poll;
    assert.doesNotMatch(f.content.querySelector('.daki-test-progress').textContent, /WebP 변환 중/);
    assert.match(grid.children[1].textContent, /PNG로 저장했습니다\./);
});

test('a poll started before rename cannot revert the newer name, items, or generation status', async () => {
    const f = fixture();
    const old = batch({name: 'Before', status: 'running', updated_at: '2026-01-01T00:00:01+00:00'});
    await openBatch(f, old);
    const poll = f.fireTimer();
    f.button('이름 변경').onclick();
    const renamed = structuredClone(old);
    Object.assign(renamed, {name: 'New name', status: 'paused', completed: 1, pending: 1,
        updated_at: '2026-01-01T00:00:03+00:00'});
    renamed.items[0] = {...renamed.items[0], status: 'completed', src: '/new/result.png'};
    f.renames[0][1](renamed);
    const image = f.content.querySelector('.daki-style-grid').children[0].querySelector('img');
    f.reply({batch: old}); await poll;
    assert.equal(f.doc.getElementById('dakiTitle').textContent, 'New name');
    assert.equal(f.content.querySelector('.daki-style-grid').children[0].querySelector('img'), image);
    assert.equal(image.src, '/new/result.png');
    assert.match(f.content.querySelector('.daki-test-progress').textContent, /1\/2장 완료.*대기 중/);
    assert.equal(f.button('다음 그림체 한 장 생성').disabled, false);
    assert.equal(f.button('중지').disabled, true); assert.equal(f.timers.size, 0);
    f.button('이름 변경').onclick(); assert.equal(f.renames[1][0], renamed);
});

test('a stale poll missing newly appended styles cannot remove their state or replace completed images', async () => {
    const f = fixture();
    const old = batch({name: 'Existing test', status: 'running', updated_at: '2026-01-01T00:00:01+00:00'});
    await openBatch(f, old); const poll = f.fireTimer();
    const completed = structuredClone(old);
    Object.assign(completed, {status: 'completed', completed: 2, pending: 0, updated_at: '2026-01-01T00:00:02+00:00'});
    completed.items = completed.items.map(item => ({...item, status: 'completed', src: `/results/${item.style_id}.png`}));
    f.button('이름 변경').onclick(); f.renames[0][1](completed);
    assert.equal(f.button('그림체 추가').disabled, false);
    const grid = f.content.querySelector('.daki-style-grid');
    const originals = [...grid.children], images = originals.map(card => card.querySelector('img'));
    f.button('그림체 추가').onclick();
    const appended = {...completed, status: 'paused', total: 3, pending: 1, updated_at: '2026-01-01T00:00:03+00:00',
        items: [...completed.items, {...batch().items[0], style_id: 'personal_added', name: 'New personal style'}]};
    f.appends[0][1](appended);
    const addition = grid.children[2]; f.reply({batch: old}); await poll;
    assert.equal(grid.children.length, 3); assert.equal(grid.children[2], addition);
    assert.equal(grid.children[0], originals[0]); assert.equal(grid.children[1], originals[1]);
    assert.equal(grid.children[0].querySelector('img'), images[0]); assert.equal(grid.children[1].querySelector('img'), images[1]);
    assert.match(f.content.querySelector('.daki-test-progress').textContent, /2\/3장 완료.*1장 대기/);
    assert.equal(f.content.querySelector('.daki-test-generation').open, true);
    assert.equal(f.timers.size, 0); assert.equal(f.requests.some(request => request.url.endsWith('/run')), false);
    f.button('그림체 추가').onclick(); assert.equal(f.appends[1][0], appended);
});

test('a delayed command response cannot overwrite a newer snapshot received by polling', async () => {
    const f = fixture();
    const old = batch({name: 'Initial', status: 'running', updated_at: '2026-01-01T00:00:01+00:00'});
    await openBatch(f, old); const poll = f.fireTimer();
    const stopping = f.button('중지').onclick();
    const newer = {...old, name: 'Latest snapshot', status: 'paused', updated_at: '2026-01-01T00:00:03+00:00'};
    f.reply({batch: newer}); await poll;
    assert.equal(f.reply({batch: {...old, status: 'stopping', updated_at: '2026-01-01T00:00:02+00:00'}}).url,
        '/api/daki/style-tests/test-one/stop');
    await stopping;
    assert.equal(f.doc.getElementById('dakiTitle').textContent, 'Latest snapshot');
    assert.equal(f.button('다음 그림체 한 장 생성').disabled, false); assert.equal(f.button('중지').disabled, true);
    assert.match(f.content.querySelector('.daki-test-progress').textContent, /대기 중/); assert.equal(f.timers.size, 0);
});

test('leaving cancels scheduled polls and ignores in-flight results', async () => {
    const f = fixture();
    await openBatch(f, batch({status: 'running'}));
    const before = f.content.textContent;
    const poll = f.fireTimer();
    f.win.DakiStyles.leave();
    const done = batch({status: 'completed', completed: 2, pending: 0});
    done.items[0].src = '/stale/result.png';
    f.reply({batch: done}); await poll;
    assert.equal(f.content.textContent, before);
    assert.equal(f.content.querySelector('img').src, '/source/one');
    assert.equal(f.timers.size, 0);

    const next = fixture();
    await openBatch(next, batch({status: 'running'}));
    assert.equal(next.timers.size, 1);
    next.win.DakiStyles.leave();
    assert.equal(next.timers.size, 0);
});

test('navigation before initial load finishes leaves the destination DOM untouched', async () => {
    const f = fixture();
    const render = f.render();
    f.win.DakiStyles.leave(); f.setActive(false);
    f.content.textContent = 'Destination gallery';
    f.reply({batch: batch()}); await render;
    assert.equal(f.content.textContent, 'Destination gallery');
    assert.equal(f.doc.getElementById('dakiTitle').textContent, '');
    assert.equal(f.timers.size, 0);
});

test('command errors restore controls and permit an explicit retry', async () => {
    const f = fixture();
    const {next, all} = await openBatch(f);
    const run = next.onclick(); f.reply({message: 'Synthetic generation refusal'}, 400); await run;
    assert.equal(next.disabled, false); assert.equal(all.disabled, false);
    assert.equal(f.doc.getElementById('dakiPageStatus').textContent, 'Synthetic generation refusal');
    assert.equal(f.timers.size, 0);
    const retry = next.onclick(); f.reply({batch: batch({status: 'running'})}); await retry;
    assert.equal(f.doc.getElementById('dakiPageStatus').textContent, '');
    assert.equal(f.timers.size, 1);
});

test('failed-only retry remains available without pending items and preserves completed cards', async () => {
    const f = fixture();
    const failed = batch({status: 'failed', completed: 1, pending: 0, failed: 1});
    failed.items[0] = {...failed.items[0], status: 'completed', src: '/result/one.png'};
    failed.items[1] = {...failed.items[1], status: 'failed', error: 'Synthetic failure', requires_anlas: true, options: {steps: 35}};
    const {next, all, stop} = await openBatch(f, failed);
    const retry = f.button('실패한 그림 다시 생성 (1)');
    assert.equal(retry.disabled, false);
    assert.equal(next.disabled, true); assert.equal(all.disabled, true);
    const costLabel = f.content.querySelector('.daki-test-anlas');
    assert.equal(costLabel.hidden, false);
    const firstImage = f.content.querySelector('.daki-style-grid').children[0].querySelector('img');
    const request = retry.onclick();
    assert.equal(retry.disabled, true);
    await retry.onclick(); assert.equal(f.pending.length, 0); assert.equal(f.warnings.length, 1);
    assert.deepEqual(f.warnings[0].requests, [{width: 1024, height: 1024, steps: 35}]);
    await f.confirm(true); assert.equal(f.pending.length, 1);
    const running = structuredClone(failed);
    running.status = 'running'; running.failed = 0;
    running.items[1].status = 'running'; delete running.items[1].error;
    assert.deepEqual(f.reply({batch: running}), {
        url: '/api/daki/style-tests/test-one/run', method: 'POST', body: {mode: 'retry_failed', allow_anlas: true},
    });
    await request;
    assert.equal(stop.disabled, false);
    const completed = structuredClone(running);
    completed.status = 'completed'; completed.completed = 2;
    completed.items[1] = {...completed.items[1], status: 'completed', src: '/result/two.png'};
    const poll = f.fireTimer(); f.reply({batch: completed}); await poll;
    const grid = f.content.querySelector('.daki-style-grid');
    assert.equal(grid.children[0].querySelector('img'), firstImage);
    assert.equal(grid.children[1].querySelector('img').src, '/result/two.png');
    assert.doesNotMatch(grid.children[1].textContent, /Synthetic failure/);
    assert.equal(retry.hidden, true); assert.equal(f.timers.size, 0);
});

test('retry rejection retains failures and running batches cannot start another retry', async () => {
    const f = fixture(); const failed = batch({status: 'failed', failed: 1, pending: 1});
    failed.items[0].status = 'failed';
    await openBatch(f, failed);
    const retry = f.button('실패한 그림 다시 생성 (1)');
    const request = retry.onclick(); f.reply({message: 'Synthetic retry refusal'}, 409); await request;
    assert.equal(retry.disabled, false); assert.equal(retry.hidden, false);
    assert.equal(f.doc.getElementById('dakiPageStatus').textContent, 'Synthetic retry refusal');
    for (const status of ['running', 'stopping']) {
        f.content.replaceChildren(); await openBatch(f, {...failed, status});
        assert.equal(f.button('실패한 그림 다시 생성 (1)').disabled, true);
    }
});

test('test preparation sends name and library with common settings, retaining drafts after errors', async () => {
    const f = fixture();
    const render = f.render('library=shared');
    f.reply({configured: true, styles: [{id: 'one', name: 'Synthetic style', category: 'v5', src: '/source/one'}]});
    // Catalog rendering starts a second request for saved batches.
    await new Promise(resolve => setImmediate(resolve));
    f.reply({batches: []}); await render;
    await openTestSettings(f);
    const form = f.doc.getElementById('dakiTestForm');
    assert.deepEqual(form.querySelectorAll('input').map(el => el.name), ['name', 'width', 'height', 'key']);
    assert.deepEqual(form.querySelectorAll('select').map(el => el.name), ['model', 'size_preset', 'output_format']);
    assert.deepEqual(form.querySelectorAll('textarea').map(el => el.name), ['prompt', 'negative_prompt']);
    assert.deepEqual(form.elements.namedItem('output_format').children.map(option => option.value), ['webp', 'png']);
    assert.equal(form.elements.namedItem('output_format').value, 'webp');
    form.elements.namedItem('name').value = ' Synthetic named gallery ';
    form.elements.namedItem('model').value = 'nai-diffusion-4-5-full';
    form.elements.namedItem('output_format').value = 'png';
    form.elements.namedItem('prompt').value = ' common scene ';
    form.elements.namedItem('negative_prompt').value = ' common exclusions ';
    f.doc.getElementById('dakiTestAddCharacter').onclick();
    const character = f.doc.getElementById('dakiTestCharacters').children[0].querySelectorAll('textarea');
    character[0].value = ' blue hair '; character[1].value = ' hat ';
    const submit = form.querySelector('[type=submit]');
    const event = {preventDefault() {}};
    const prepare = form.onsubmit(event);
    assert.equal(submit.disabled, true); assert.equal(f.doc.getElementById('dakiTestCancel').disabled, true);
    const request = f.reply({message: 'Synthetic preparation error'}, 400);
    assert.deepEqual(request, {url: '/api/daki/style-tests', method: 'POST', body: {
        name: 'Synthetic named gallery', library: 'shared', style_ids: ['one'],
        model: 'nai-diffusion-4-5-full', output_format: 'png', prompt: 'common scene', negative_prompt: 'common exclusions', width: null, height: null,
        char_prompts: [{prompt: 'blue hair', negative_prompt: 'hat'}],
    }});
    await prepare;
    assert.equal(submit.disabled, false); assert.equal(f.doc.getElementById('dakiTestCancel').disabled, false);
    assert.equal(f.doc.getElementById('dakiTestSettingsStatus').textContent, 'Synthetic preparation error');
    assert.equal(form.elements.namedItem('name').value, ' Synthetic named gallery ');
    f.doc.getElementById('dakiTestCancel').onclick();
    const reopened = f.win.DakiStyles.openSettings(styleCatalog()); f.reply(settingsOptions()); await reopened;
    const restoredForm = f.doc.getElementById('dakiTestForm');
    assert.equal(restoredForm.elements.namedItem('output_format').value, 'png');
    assert.equal(restoredForm.elements.namedItem('name').value, 'Synthetic named gallery');
    const retry = restoredForm.onsubmit(event); f.reply({batch: {id: 'prepared-one'}}); await retry;
    assert.equal(f.win.location.hash, '#daki&library=shared&batch=prepared-one');
    assert.equal(restoredForm.parentNode.open, false);
    assert.equal(f.requests.filter(request => request.url.endsWith('/run')).length, 0);
});

test('new tests submit the exact selected styles and freeze the selection while preparing', async () => {
    const f = fixture(); let changed, disposed = 0;
    let selection = {styleIds: ['three', 'one'], count: 2, error: ''};
    f.win.DakiTestTargets = {create(options) {
        assert.deepEqual(options.catalog, styleCatalog()); changed = options.onChange;
        return {element: f.doc.createElement('section'), selection: () => selection, dispose: () => disposed++};
    }};
    const opened = f.win.DakiStyles.openSettings(styleCatalog()); f.reply(settingsOptions()); await opened;
    const form = f.doc.getElementById('dakiTestForm');
    assert.equal(form.elements.namedItem('output_format').value, 'webp');
    form.elements.namedItem('name').value = 'Selected styles';
    form.elements.namedItem('prompt').value = 'synthetic scene';
    form.elements.namedItem('key').value = 'synthetic-test-key';
    assert.match(f.doc.getElementById('dakiTestScope').textContent, /^2개/);
    const saving = form.onsubmit({preventDefault() {}});
    assert.equal(f.doc.getElementById('dakiTestTargetFields').disabled, true);
    selection = {styleIds: ['two'], count: 1, error: ''}; changed();
    assert.equal(form.querySelector('[type=submit]').disabled, true);
    f.reply({}); await new Promise(resolve => setImmediate(resolve));
    const request = f.reply({batch: {id: 'chosen', library: 'shared'}}); await saving;
    assert.deepEqual(request.body.style_ids, ['three', 'one']);
    assert.equal(request.body.output_format, 'webp');
    assert.equal(disposed, 1);
    assert.equal(f.requests.some(request => request.url.endsWith('/run')), false);
});

test('empty or loading targets cannot silently prepare every style and all mode remains compatible', async () => {
    const f = fixture(); let changed;
    let selection = {styleIds: [], count: 0, error: '선택한 조건의 그림체가 없습니다.'};
    f.win.DakiTestTargets = {create(options) {
        changed = options.onChange;
        return {element: f.doc.createElement('section'), selection: () => selection, dispose() {}};
    }};
    const opened = f.win.DakiStyles.openSettings(styleCatalog()); f.reply(settingsOptions()); await opened;
    const form = f.doc.getElementById('dakiTestForm');
    form.elements.namedItem('name').value = 'All styles';
    assert.equal(form.querySelector('[type=submit]').disabled, true);
    await form.onsubmit({preventDefault() {}});
    assert.equal(f.pending.length, 0);
    selection = {styleIds: null, count: 3, error: ''}; changed();
    assert.equal(form.querySelector('[type=submit]').disabled, false);
    const saving = form.onsubmit({preventDefault() {}});
    const request = f.reply({batch: {id: 'all'}}); await saving;
    assert.deepEqual(request.body.style_ids, ['one', 'two', 'three']);
});

test('target selection is disposed on cancel and unavailable when editing existing pending settings', async () => {
    const f = fixture(); let calls = 0, disposed = 0;
    f.win.DakiTestTargets = {create() {
        calls++;
        return {element: f.doc.createElement('section'), selection: () => ({styleIds: null, count: 3, error: ''}), dispose: () => disposed++};
    }};
    let opened = f.win.DakiStyles.openSettings(styleCatalog()); f.reply(settingsOptions()); await opened;
    f.doc.getElementById('dakiTestCancel').onclick(); assert.equal(disposed, 1);
    opened = f.win.DakiStyles.openSettings(null, batch()); f.reply(settingsOptions()); await opened;
    assert.equal(f.doc.getElementById('dakiTestTargetFields').hidden, true); assert.equal(calls, 1);
});

test('Medium preparation disables unsupported negatives without losing drafts or character prompts', async () => {
    const f = fixture();
    const render = f.render('library=shared'); f.reply(styleCatalog());
    await new Promise(resolve => setImmediate(resolve)); f.reply({batches: []}); await render;
    await openTestSettings(f);
    let form = f.doc.getElementById('dakiTestForm');
    const model = form.elements.namedItem('model');
    assert.deepEqual(model.children.map(option => [option.value, option.textContent]), [
        ['nai-diffusion-5-full', 'NovelAI V5 Full'], ['nai-diffusion-5-full-medium', 'NovelAI V5 Full Medium'],
        ['nai-diffusion-4-5-full', 'NovelAI V4.5 Full'],
    ]);
    const negative = form.elements.namedItem('negative_prompt'); negative.value = 'saved common negative';
    form.elements.namedItem('name').value = 'Medium comparison';
    form.elements.namedItem('prompt').value = 'synthetic common prompt';
    f.doc.getElementById('dakiTestAddCharacter').onclick();
    const character = f.doc.getElementById('dakiTestCharacters').children[0].querySelectorAll('textarea');
    character[0].value = 'synthetic character'; character[1].value = 'saved character negative';
    assert.equal(f.doc.getElementById('dakiTestModelNote').hidden, true);
    model.value = 'nai-diffusion-5-full-medium'; model.onchange();
    assert.equal(f.doc.getElementById('dakiTestModelNote').hidden, false);
    assert.match(f.doc.getElementById('dakiTestModelNote').textContent, /14 스텝.*Euler Ancestral.*Karras/);
    assert.equal(negative.disabled, true); assert.equal(character[1].disabled, true);
    assert.equal(character[0].disabled, false);
    f.doc.getElementById('dakiTestAddCharacter').onclick();
    const extra = f.doc.getElementById('dakiTestCharacters').children[1];
    assert.equal(extra.querySelectorAll('textarea')[1].disabled, true);
    extra.querySelector('button').onclick();
    model.value = 'nai-diffusion-4-5-full'; model.onchange();
    assert.equal(negative.disabled, false); assert.equal(character[1].disabled, false);
    assert.equal(negative.value, 'saved common negative'); assert.equal(character[1].value, 'saved character negative');
    model.value = 'nai-diffusion-5-full-medium'; model.onchange();
    const prepare = form.onsubmit({preventDefault() {}});
    const request = f.reply({batch: {id: 'medium-test'}}); await prepare;
    assert.deepEqual(request.body, {name: 'Medium comparison', library: 'shared', style_ids: ['one', 'two', 'three'], model: 'nai-diffusion-5-full-medium', output_format: 'webp', prompt: 'synthetic common prompt',
        negative_prompt: '', width: null, height: null, char_prompts: [{prompt: 'synthetic character', negative_prompt: ''}]});
    assert.equal(f.win.location.hash, '#daki&library=shared&batch=medium-test');
    await openTestSettings(f);
    form = f.doc.getElementById('dakiTestForm');
    assert.equal(form.elements.namedItem('name').value, 'Medium comparison');
    assert.equal(form.elements.namedItem('model').value, 'nai-diffusion-5-full-medium');
    assert.equal(form.elements.namedItem('negative_prompt').disabled, true);
    assert.equal(form.elements.namedItem('negative_prompt').value, 'saved common negative');
    assert.equal(f.doc.getElementById('dakiTestCharacters').children[0].querySelectorAll('textarea')[1].value, 'saved character negative');
    assert.equal(f.requests.filter(request => request.url.endsWith('/run')).length, 0);
});

test('new tests require a name and retain cancelled name and prompt drafts for personal-library creation', async () => {
    const f = fixture();
    const catalog = {...styleCatalog(), library: 'personal'};
    let opened = f.win.DakiStyles.openSettings(catalog); f.reply(settingsOptions()); await opened;
    let form = f.doc.getElementById('dakiTestForm');
    const name = form.elements.namedItem('name');
    assert.equal(name.required, true); assert.equal(f.doc.activeElement, name);
    name.value = '   '; await form.onsubmit({preventDefault() {}});
    assert.equal(f.pending.length, 0); assert.match(f.doc.getElementById('dakiTestSettingsStatus').textContent, /이름/);
    assert.equal(form.parentNode.open, true);
    name.value = '  Personal portrait  '; form.elements.namedItem('prompt').value = 'saved synthetic scene';
    f.doc.getElementById('dakiTestCancel').onclick();
    opened = f.win.DakiStyles.openSettings(catalog); f.reply(settingsOptions()); await opened;
    form = f.doc.getElementById('dakiTestForm');
    assert.equal(form.elements.namedItem('name').value, 'Personal portrait');
    assert.equal(form.elements.namedItem('prompt').value, 'saved synthetic scene');
    const saved = form.onsubmit({preventDefault() {}});
    const request = f.reply({batch: {id: 'personal-test', name: 'Personal portrait', library: 'personal'}}); await saved;
    assert.equal(request.body.name, 'Personal portrait'); assert.equal(request.body.library, 'personal');
    assert.equal(f.win.location.hash, '#daki&library=personal&batch=personal-test');
    assert.equal(f.requests.some(request => request.url.endsWith('/run')), false);
});

test('saved test cards keep their names, representative image, status, and library routes with old-name fallback', () => {
    const f = fixture();
    for (const library of ['shared', 'personal']) {
        const card = f.win.DakiStyles.savedBatchCard(batch({name: 'Synthetic named test', library,
            completed: 1, cover_src: '/covers/result.png', status: 'paused'}));
        assert.equal(card.textContent, 'Synthetic named test');
        assert.equal(card.href, `#daki&library=${library}&batch=test-one`);
        assert.equal(card.folder.count, 1); assert.equal(card.querySelector('img').src, '/covers/result.png');
        assert.match(card.folder.subtitle, /1\/2장 완료/); assert.match(card.folder.subtitle, /대기 중/);
        assert.equal(card.matches('.daki-test-record'), true);
    }
    const old = f.win.DakiStyles.savedBatchCard(batch());
    assert.match(old.textContent, /2026.*테스트/); assert.equal(old.href, '#daki&library=shared&batch=test-one');
    assert.equal(f.win.DakiStyles.savedBatchCard(batch({created_at: 'invalid-date'})).textContent, '그림체 테스트');
});

test('personal batches use their named gallery heading and backlink with completed generation controls collapsed', async () => {
    const f = fixture();
    const completed = batch({name: 'Personal gallery', library: 'personal', status: 'completed', completed: 2, pending: 0});
    completed.items = completed.items.map(item => ({...item, status: 'completed', src: `/result/${item.style_id}.png`}));
    await openBatch(f, completed);
    assert.equal(f.doc.getElementById('dakiTitle').textContent, 'Personal gallery');
    assert.equal(f.doc.getElementById('dakiBack').href, '#daki&library=personal');
    assert.equal(f.doc.getElementById('dakiBack').textContent, '← 개인 그림체');
    assert.equal(f.content.querySelector('.daki-test-generation').open, false);
    assert.equal(f.button('그림체 추가').disabled, false);
    assert.equal(f.content.querySelectorAll('.daki-style-card').length, 2);
    f.content.replaceChildren(); await openBatch(f, batch({name: 'Pending gallery'}));
    assert.equal(f.content.querySelector('.daki-test-generation').open, true);
    assert.equal(f.doc.getElementById('dakiBack').href, '#daki&library=shared');
});

test('rename and append callbacks refresh batch state while preserving completed cards and never auto-generating', async () => {
    const f = fixture();
    const completed = batch({name: 'Before', status: 'completed', completed: 2, pending: 0});
    completed.items = completed.items.map(item => ({...item, status: 'completed', src: `/result/${item.style_id}.png`}));
    await openBatch(f, completed);
    const grid = f.content.querySelector('.daki-style-grid'), before = [...grid.children];
    const images = before.map(card => card.querySelector('img'));
    f.button('이름 변경').onclick();
    assert.equal(f.renames.length, 1); assert.equal(f.renames[0][0], completed);
    const renamed = {...completed, name: 'After'}; f.renames[0][1](renamed);
    assert.equal(f.doc.getElementById('dakiTitle').textContent, 'After');
    assert.equal(grid.children[0], before[0]); assert.equal(grid.children[1], before[1]);
    f.button('그림체 추가').onclick();
    assert.equal(f.appends.length, 1); assert.equal(f.appends[0][0], renamed);
    const appended = {...renamed, status: 'paused', pending: 1, total: 3,
        items: [...renamed.items, {...batch().items[0], style_id: 'personal_new', name: 'New style'}]};
    f.appends[0][1](appended);
    assert.equal(grid.children.length, 3);
    assert.equal(grid.children[0], before[0]); assert.equal(grid.children[1], before[1]);
    assert.equal(grid.children[0].querySelector('img'), images[0]); assert.equal(grid.children[1].querySelector('img'), images[1]);
    assert.equal(f.content.querySelector('.daki-test-generation').open, true);
    assert.equal(f.button('다음 그림체 한 장 생성').disabled, false);
    assert.match(f.content.querySelector('.daki-test-progress').textContent, /2\/3장 완료.*1장 대기/);
    assert.equal(f.requests.length, 1); assert.equal(f.requests.some(request => request.url.endsWith('/run')), false);
});

test('running batches allow renaming but disable append and late callbacks leave a destination untouched', async () => {
    const f = fixture(); await openBatch(f, batch({status: 'running'}));
    assert.equal(f.button('이름 변경').disabled, false); assert.equal(f.button('그림체 추가').disabled, true);
    f.button('이름 변경').onclick();
    f.win.DakiStyles.leave(); f.content.textContent = 'Destination gallery';
    const heading = f.doc.getElementById('dakiTitle').textContent;
    f.renames[0][1](batch({name: 'Stale rename'}));
    assert.equal(f.content.textContent, 'Destination gallery'); assert.equal(f.doc.getElementById('dakiTitle').textContent, heading);
    assert.equal(f.timers.size, 0);
    const next = fixture(); await openBatch(next);
    next.button('그림체 추가').onclick(); next.win.DakiStyles.leave(); next.content.textContent = 'Destination';
    next.appends[0][1](batch({name: 'Stale append'}));
    assert.equal(next.content.textContent, 'Destination');
});

test('new shared styles can be appended to a completed test then generated without replacing results', async () => {
    const f = fixture();
    const completed = batch({status: 'completed', completed: 2, pending: 0, missing_shared_style_ids: ['three', 'four']});
    completed.items = completed.items.map(item => ({...item, status: 'completed', src: `/result/${item.style_id}.png`}));
    await openBatch(f, completed);
    const grid = f.content.querySelector('.daki-style-grid');
    const oldCards = [...grid.children], oldImages = oldCards.map(card => card.querySelector('img'));
    assert.equal(f.button('새 공유 그림체 2개 추가').disabled, false);
    assert.equal(f.content.querySelector('.daki-test-generation').open, false);
    const adding = f.button('새 공유 그림체 2개 추가').onclick();
    await f.button('새 공유 그림체 2개 추가').onclick();
    assert.equal(f.pending.length, 1);
    const appended = {...completed, status: 'paused', pending: 2, total: 4, missing_shared_style_ids: [],
        items: [...completed.items, ...['three', 'four'].map(id => ({...batch().items[0], style_id: id, name: id}))]};
    const request = f.reply({batch: appended}); await adding;
    assert.deepEqual(request, {url: '/api/daki/style-tests/test-one/styles', method: 'POST', body: {style_ids: ['three', 'four']}});
    assert.equal(f.button('새 공유 그림체 없음').disabled, true);
    assert.equal(f.content.querySelector('.daki-test-generation').open, true);
    assert.equal(f.button('남은 그림체 모두 생성').disabled, false);
    assert.equal(f.requests.some(request => request.url.endsWith('/run')), false);
    assert.equal(f.warnings.length, 0);
    for (let i = 0; i < oldCards.length; i++) {
        assert.equal(grid.children[i], oldCards[i]);
        assert.equal(grid.children[i].querySelector('img'), oldImages[i]);
    }
    const generating = f.button('남은 그림체 모두 생성').onclick();
    const run = f.reply({batch: {...appended, status: 'running'}}); await generating;
    assert.equal(run.url, '/api/daki/style-tests/test-one/run');
    assert.equal(run.body.mode, 'remaining');
});

test('new shared styles action handles running, missing catalog, and personal tests', async () => {
    for (const status of ['running', 'stopping']) {
        const f = fixture(); await openBatch(f, batch({status, missing_shared_style_ids: ['three']}));
        assert.equal(f.button('새 공유 그림체 1개 추가').disabled, true);
        await f.button('새 공유 그림체 1개 추가').onclick();
        assert.equal(f.requests.length, 1);
    }
    const unavailable = fixture(); await openBatch(unavailable, batch({missing_shared_style_ids: null}));
    assert.equal(unavailable.button('새 공유 그림체 확인 불가').disabled, true);
    assert.equal(unavailable.button('남은 그림체 모두 생성').disabled, false);
    const personal = fixture(); await openBatch(personal, batch({library: 'personal', missing_shared_style_ids: []}));
    assert.equal(personal.content.querySelectorAll('button').some(button => button.textContent.startsWith('새 공유 그림체')), false);
});

test('new shared append errors preserve counts and late replies cannot alter another page', async () => {
    const f = fixture(); await openBatch(f, batch({missing_shared_style_ids: ['three']}));
    const first = f.button('새 공유 그림체 1개 추가').onclick();
    f.reply({message: 'Synthetic append failure'}, 400); await first;
    assert.equal(f.button('새 공유 그림체 1개 추가').disabled, false);
    assert.match(f.doc.getElementById('dakiPageStatus').textContent, /Synthetic append failure/);
    assert.equal(f.content.querySelectorAll('.daki-style-card').length, 2);
    const retry = f.button('새 공유 그림체 1개 추가').onclick();
    f.win.DakiStyles.leave(); f.content.textContent = 'Destination';
    f.reply({batch: batch({missing_shared_style_ids: []})}); await retry;
    assert.equal(f.content.textContent, 'Destination');
});

test('test worldcup receives only completed images from the current batch with its current name', async () => {
    const f = fixture();
    const value = batch({id: 'current-batch', name: 'Current gallery', status: 'paused', completed: 2, pending: 1, failed: 1, total: 4});
    value.items = [
        {...value.items[0], status: 'completed', src: '/results/one.png'}, value.items[1],
        {...value.items[0], style_id: 'failed', status: 'failed', error: 'Synthetic failure'},
        {...value.items[0], style_id: 'four', name: 'Fourth result', status: 'completed', src: '/results/four.png'},
    ];
    await openBatch(f, value); f.button('태그 그림 이상형 월드컵').onclick();
    assert.deepEqual(JSON.parse(JSON.stringify(f.worldcups[0])), [[
        {path: '__daki_tests__/current-batch/one.png', src: '/results/one.png', name: 'Style one'},
        {path: '__daki_tests__/current-batch/four.png', src: '/results/four.png', name: 'Fourth result'},
    ], 'Current gallery', 'test:current-batch']);
    f.button('이름 변경').onclick(); f.renames[0][1]({...value, name: 'Renamed gallery'});
    f.button('태그 그림 이상형 월드컵').onclick(); assert.equal(f.worldcups[1][1], 'Renamed gallery');
    assert.equal(f.requests.length, 1);
});

test('test gallery filters control visible cards, zoom order and tournament entrants without replacing images', async () => {
    const f = fixture(); let config, mode = 'all', disposed = false; const counts = [];
    f.win.DakiGalleryFilters = {create(options) {
        config = options;
        return {element: f.doc.createElement('div'), dispose() { disposed = true; }, setResultCount(...value) { counts.push(value); }, apply(items, pathOf) {
            return mode === 'all' ? [...items] : items.filter(item => pathOf(item).endsWith('/two.png')).reverse();
        }};
    }};
    const value = batch({completed: 2, pending: 0, status: 'completed'});
    value.items = value.items.map(item => ({...item, status: 'completed', src: '/results/' + item.style_id}));
    await openBatch(f, value);
    assert.equal(config.galleryKey, 'test:test-one');
    assert.deepEqual(counts.at(-1), [2, 2]);
    assert.equal(config.recommendationOf({recommendation_count: 0}), 0);
    assert.equal(config.recommendationOf({recommendation_count: null}), null);
    assert.equal(config.recommendationOf({recommendation_count: '12'}), null);
    const cards = f.content.querySelectorAll('.daki-style-card'); const image = cards[1].children[0];
    mode = 'tagged'; config.onChange();
    assert.deepEqual(counts.at(-1), [1, 2]);
    assert.deepEqual(f.content.querySelectorAll('.daki-style-card'), [cards[1]]);
    assert.equal(cards[1].children[0], image);
    f.button('태그 그림 이상형 월드컵').onclick();
    assert.deepEqual(Array.from(f.worldcups[0][0], item => item.path), ['__daki_tests__/test-one/two.png']);
    mode = 'all'; config.onChange();
    assert.deepEqual(f.content.querySelectorAll('.daki-style-card'), cards);
    f.win.DakiStyles.leave(); assert.equal(disposed, true);
});

test('shared filters compose with name search and keep saved result scope stable', async () => {
    const f = fixture(); let config; const counts = [];
    f.win.DakiGalleryFilters = {create(options) {
        config = options;
        return {element: f.doc.createElement('div'), dispose() {}, setResultCount(...value) { counts.push(value); }, apply(items, pathOf) {
            return items.filter(item => pathOf(item).endsWith('/three.png'));
        }};
    }};
    await openStyleList(f);
    assert.equal(config.galleryKey, 'shared:all');
    assert.equal(config.recommendationOf({style: {recommendation_count: 27}}), 27);
    assert.equal(config.recommendationOf({style: {}}), null);
    assert.equal(f.content.querySelectorAll('.daki-style-card').length, 1);
    assert.deepEqual(counts.at(-1), [1, 3]);
    const search = f.content.querySelector('input'); search.value = 'upper'; search.oninput();
    assert.equal(f.content.querySelectorAll('.daki-style-card').length, 0);
    assert.deepEqual(counts.at(-1), [0, 3]);
    search.value = 'blue'; search.oninput();
    f.button('태그 그림 이상형 월드컵').onclick();
    assert.deepEqual(Array.from(f.worldcups[0][0], item => item.path), ['__daki_shared__/three.png']);
    assert.equal(f.worldcups[0][2], 'shared:all');
});

test('Medium batch shows effective constraints and uses payload-based Anlas status', async () => {
    const f = fixture();
    const value = batch({model: 'nai-diffusion-5-full-medium', negative_prompt: 'ignored common negative',
        char_prompts: [{prompt: 'synthetic character', negative_prompt: 'ignored character negative'}]});
    value.items[0].options.steps = 40;
    await openBatch(f, value);
    const details = f.content.querySelector('.daki-test-history');
    assert.match(details.textContent, /NovelAI V5 Full Medium/);
    assert.match(details.textContent, /14 스텝/);
    assert.match(details.textContent, /Medium에서 적용되지 않음/);
    assert.doesNotMatch(details.textContent, /ignored common negative|ignored character negative/);
    assert.equal(f.content.querySelector('.daki-test-anlas').hidden, true);
    f.content.replaceChildren();
    value.items[1].requires_anlas = true;
    await openBatch(f, value);
    assert.equal(f.content.querySelector('.daki-test-anlas').hidden, false);
});

test('editing a prepared batch prefills settings and updates pending settings without replacing completed cards', async () => {
    const f = fixture();
    const before = batch({status: 'paused', completed: 1, pending: 1, width: 832, height: 1216});
    before.items[0] = {...before.items[0], model: 'nai-diffusion-5-full', status: 'completed', src: '/completed.png'};
    await openBatch(f, before);
    const image = f.content.querySelector('.daki-style-grid').children[0].querySelector('img');
    const form = await openTestSettings(f, true);
    assert.equal(form.elements.namedItem('output_format').value, 'png');
    assert.equal(form.elements.namedItem('prompt').value, before.prompt);
    assert.equal(form.elements.namedItem('width').value, '832');
    assert.equal(form.elements.namedItem('size_preset').value, '832x1216');
    form.elements.namedItem('prompt').value = 'edited common prompt';
    form.elements.namedItem('output_format').value = 'webp';
    form.elements.namedItem('model').value = 'nai-diffusion-5-full-medium';
    form.elements.namedItem('model').onchange();
    const preset = form.elements.namedItem('size_preset'); preset.value = '1472x1472'; preset.onchange();
    const after = structuredClone(before);
    Object.assign(after, {model: 'nai-diffusion-5-full-medium', output_format: 'webp', prompt: 'edited common prompt', width: 1472, height: 1472});
    Object.assign(after.items[1], {model: after.model, width: 1472, height: 1472, requires_anlas: true});
    const saving = form.onsubmit({preventDefault() {}});
    const request = f.reply({batch: after}); await saving;
    assert.equal(request.url, '/api/daki/style-tests/test-one/settings');
    assert.equal(request.method, 'POST');
    assert.equal(request.body.output_format, 'webp');
    assert.equal(request.body.width, 1472); assert.equal(request.body.height, 1472);
    assert.equal(f.content.querySelector('.daki-style-grid').children[0].querySelector('img'), image);
    assert.match(f.content.querySelector('.daki-test-summary').textContent, /Medium.*1472 × 1472/);
    assert.match(f.content.querySelector('.daki-test-history').textContent, /edited common prompt/);
    assert.match(f.content.querySelector('.daki-test-history').textContent, /WebP \(품질 90\)/);
    assert.equal(f.warnings.length, 0);
    assert.equal(f.doc.getElementById('dakiTestDialogTitle').parentNode.parentNode.parentNode.open, false);
    assert.equal(f.requests.filter(request => request.url.endsWith('/run')).length, 0);
});

test('legacy batches without output_format default to PNG and submit PNG settings', async () => {
    const f = fixture();
    const legacy = batch();
    delete legacy.output_format;
    await openBatch(f, legacy);
    assert.match(f.content.querySelector('.daki-test-history').textContent, /PNG/);
    const form = await openTestSettings(f, true);
    assert.equal(form.elements.namedItem('output_format').value, 'png');
    const saving = form.onsubmit({preventDefault() {}});
    const updated = {...legacy, output_format: 'png'};
    const request = f.reply({batch: updated}); await saving;
    assert.equal(request.url, '/api/daki/style-tests/test-one/settings');
    assert.equal(request.body.output_format, 'png');
});

test('size presets, swapping, custom validation and original-size reset share the server limits', async () => {
    const f = fixture(); await openBatch(f);
    const form = await openTestSettings(f, true);
    const size = form.elements.namedItem('size_preset');
    const width = form.elements.namedItem('width'), height = form.elements.namedItem('height');
    assert.deepEqual(size.querySelectorAll('optgroup').map(group => group.label), ['Small', 'Normal', 'Large', 'Wallpaper', 'Daki']);
    const options = size.querySelectorAll('optgroup').flatMap(group => group.querySelectorAll('option'));
    assert.ok(options.every(option => /^\d+ × \d+ · \d+:\d+ \(1:\d+\.\d{2}\)( · (5:16 최대|최대 면적))*$/.test(option.textContent)));
    for (const [value, label] of [['320x1024', '320 × 1024 · 5:16 (1:3.20)'], ['512x1664', '512 × 1664 · 4:13 (1:3.25)'],
        ['640x2048', '640 × 2048 · 5:16 (1:3.20)'], ['960x3072', '960 × 3072 · 5:16 (1:3.20) · 5:16 최대'],
        ['1024x3072', '1024 × 3072 · 1:3 (1:3.00) · 최대 면적']]) {
        assert.equal(options.find(option => option.value === value).textContent, label);
    }
    assert.equal(width.disabled, true);
    size.value = '960x3072'; size.onchange();
    assert.equal(width.value, '960'); assert.equal(height.value, '3072');
    size.value = '832x1216'; size.onchange();
    assert.equal(width.value, '832'); assert.equal(height.value, '1216'); assert.equal(width.disabled, false);
    f.doc.getElementById('dakiTestSwapSize').onclick();
    assert.equal(width.value, '1216'); assert.equal(height.value, '832');
    width.value = '835'; width.oninput();
    await form.onsubmit({preventDefault() {}});
    assert.equal(f.pending.length, 0);
    assert.match(f.doc.getElementById('dakiTestSettingsStatus').textContent, /64 배수/);
    width.value = '2048'; height.value = '2048'; width.oninput();
    await form.onsubmit({preventDefault() {}});
    assert.equal(f.pending.length, 0);
    size.value = 'original'; size.onchange();
    assert.equal(width.disabled, true); assert.equal(height.disabled, true);
    const saving = form.onsubmit({preventDefault() {}});
    const request = f.reply({batch: batch()}); await saving;
    assert.equal(request.body.width, null); assert.equal(request.body.height, null);
});

test('settings edit failures retain values, while running and finished batches disable editing', async () => {
    const f = fixture(); await openBatch(f);
    const form = await openTestSettings(f, true);
    form.elements.namedItem('prompt').value = 'retain edit';
    const saving = form.onsubmit({preventDefault() {}});
    f.reply({message: '현재 생성 중입니다.'}, 409); await saving;
    assert.equal(form.parentNode.open, true);
    assert.equal(form.elements.namedItem('prompt').value, 'retain edit');
    assert.equal(form.querySelector('[type=submit]').disabled, false);
    assert.equal(f.doc.getElementById('dakiTestSettingsStatus').textContent, '현재 생성 중입니다.');
    f.doc.getElementById('dakiTestCancel').onclick();
    for (const value of [batch({status: 'running'}), batch({status: 'stopping'}), batch({pending: 0, completed: 2, status: 'completed'})]) {
        f.content.replaceChildren(); await openBatch(f, value);
        assert.equal(f.button('설정 수정').disabled, true);
    }
});

test('settings prompt tabs are keyboard accessible and options loading failures cannot submit', async () => {
    const f = fixture(); await openBatch(f);
    const form = await openTestSettings(f, true);
    const nega = f.doc.getElementById('dakiTestNegaTab');
    nega.onclick();
    assert.equal(f.doc.getElementById('dakiTestBasePanel').hidden, true);
    assert.equal(f.doc.getElementById('dakiTestNegaPanel').hidden, false);
    pressKey(nega, 'ArrowLeft');
    assert.equal(f.doc.getElementById('dakiTestBaseTab')['aria-selected'], 'true');
    f.doc.getElementById('dakiTestCancel').onclick();
    const opened = f.button('설정 수정').onclick();
    f.reply({message: 'Synthetic options failure'}, 500); await opened;
    const retryForm = f.doc.getElementById('dakiTestForm');
    assert.equal(retryForm.querySelector('[type=submit]').disabled, true);
    await retryForm.onsubmit({preventDefault() {}});
    assert.equal(f.pending.length, 0);
    assert.match(f.doc.getElementById('dakiTestSettingsStatus').textContent, /Synthetic options failure/);
});

test('shared folder presents tests as gallery folders and excludes personal batches', async () => {
    const f = fixture();
    const render = f.render('library=shared');
    const catalog = {configured: true, styles: [
        {id: 'one', name: 'Synthetic blue style', src: '/source/one'},
        {id: 'two', name: 'Synthetic green style', src: '/source/two'},
    ]};
    f.reply(catalog);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.pending[0].request.url, '/api/daki/style-tests');
    f.reply({batches: [batch({name: 'Shared named gallery', cover_src: '/covers/shared.png'}),
        batch({id: 'personal-only', library: 'personal', name: 'Personal named gallery'})]}); await render;
    assert.ok(f.button('전체 그림체로 테스트 만들기'));
    assert.equal(f.content.querySelector('.daki-test-history'), null);
    assert.ok(f.content.querySelector('.daki-project-grid'));
    assert.equal(f.content.querySelector('.daki-test-record').href, '#daki&library=shared&batch=test-one');
    assert.equal(f.content.querySelector('.daki-style-card'), null);
    const folders = f.content.querySelectorAll('a');
    assert.equal(folders.length, 3);
    assert.ok(folders.some(folder => folder.textContent === 'Shared named gallery' && folder.querySelector('img').src === '/covers/shared.png'));
    assert.equal(folders.some(folder => folder.textContent === 'Personal named gallery'), false);
    assert.ok(folders.some(folder => folder.textContent === '그림체 일람' && folder.href === '#daki&library=shared&category=all'));
    assert.ok(folders.some(folder => folder.textContent === '상반신' && folder.href === '#daki&library=shared&category=upper'));
    assert.equal(folders.some(folder => folder.href === '#daki&library=shared&category=v5'), false);

});

test('upper opens a persistent test with preserved results and adds only missing shared styles', async () => {
    const f = fixture();
    const value = batch({name: '상반신', origin: 'shared_upper', status: 'completed', completed: 2, pending: 0,
        missing_shared_style_ids: ['three']});
    value.items = value.items.map(item => ({...item, status: 'completed', src: '/preserved/' + item.style_id}));
    const render = f.render('library=shared&category=upper');
    assert.deepEqual(f.reply({batch: value}), {url: '/api/daki/style-tests/upper', method: 'POST', body: {}});
    await render;
    assert.equal(f.pending.length, 0);
    assert.equal(f.doc.getElementById('dakiTitle').textContent, '상반신');
    assert.ok(f.content.querySelector('.daki-test-history'));
    assert.equal(f.button('다음 그림체 한 장 생성').disabled, true);
    assert.equal(f.button('설정 수정').disabled, true);
    assert.deepEqual(f.content.querySelectorAll('.daki-style-card').map(card => card.querySelector('img').src),
        ['/preserved/one', '/preserved/two']);
    const append = f.button('새 공유 그림체 1개 추가').onclick();
    const updated = batch({...value, status: 'ready', total: 3, pending: 1, missing_shared_style_ids: [],
        items: [...value.items, {...batch().items[0], style_id: 'three', name: 'Style three'}]});
    assert.deepEqual(f.reply({batch: updated}), {url: '/api/daki/style-tests/test-one/styles', method: 'POST', body: {style_ids: ['three']}});
    await append;
    assert.equal(f.button('설정 수정').disabled, false);
    assert.equal(f.button('남은 그림체 모두 생성').disabled, false);
    assert.equal(f.content.querySelectorAll('.daki-style-card').length, 3);
    assert.deepEqual(f.content.querySelectorAll('.daki-style-card').slice(0, 2).map(card => card.querySelector('img').src),
        ['/preserved/one', '/preserved/two']);
});

test('converted upper appears once as a saved test folder', async () => {
    const f = fixture();
    const folderCard = f.win.Daki.folderCard;
    f.win.Daki.folderCard = (...args) => {
        const card = folderCard(...args);
        // Real anchor.href expands the hash into an absolute URL.
        card.href = new URL(card.href, 'http://localhost/').href;
        return card;
    };
    const render = f.render('library=shared');
    f.reply({configured: true, styles: [{id: 'one', name: 'Synthetic upper', category: 'upper', src: '/source/one'}]});
    await new Promise(resolve => setImmediate(resolve));
    f.reply({batches: [batch({name: '상반신', origin: 'shared_upper', completed: 2})]});
    await render;
    const folders = f.content.querySelectorAll('a');
    assert.equal(folders.filter(folder => folder.textContent === '상반신').length, 1);
    assert.ok(folders.some(folder => folder.textContent === '상반신' && folder.href === 'http://localhost/#daki&library=shared&batch=test-one'));
    assert.equal(folders.some(folder => folder.href.endsWith('#daki&library=shared&category=upper')), false);
});

test('upper import errors are shown without starting generation and can be retried', async () => {
    const f = fixture();
    const render = f.render('library=shared&category=upper');
    f.reply({message: 'Synthetic source unavailable'}, 404); await render;
    assert.equal(f.doc.getElementById('dakiPageStatus').textContent, 'Synthetic source unavailable');
    assert.equal(f.pending.length, 0);
    const retry = f.button('다시 불러오기').onclick();
    assert.equal(f.pending[0].request.url, '/api/daki/style-tests/upper');
    f.reply({batch: batch({origin: 'shared_upper', name: '상반신'})}); await retry;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.doc.getElementById('dakiTitle').textContent, '상반신');
});

test('leaving upper while loading cannot render a test on the destination page', async () => {
    const f = fixture();
    const render = f.render('library=shared&category=upper');
    f.win.DakiStyles.leave();
    f.content.textContent = 'Synthetic destination';
    f.reply({batch: batch({origin: 'shared_upper', name: '상반신'})}); await render;
    assert.equal(f.content.textContent, 'Synthetic destination');
    assert.equal(f.pending.length, 0);
});

test('all styles displays V5 cards with gallery images, settings, and selection', async () => {
    const f = fixture();
    const catalog = await openStyleList(f);
    assert.equal(f.pending.length, 0);
    const cards = f.content.querySelectorAll('.daki-style-card');
    assert.equal(cards.length, 3);
    cards.forEach((card, index) => {
        assert.ok(card.matches('.item-box'));
        assert.equal(card.children[0].tagName, 'IMG');
        assert.ok(card.children[0].matches('.zoomable'));
        assert.equal(card.children[0].src, catalog.styles[index].src);
        assert.ok(card.querySelector('.gallery-card-actions'));
        assert.equal(card.querySelector('button').textContent, '원본 설정');
        assert.equal(styleCheckbox(card).attributes['aria-label'], catalog.styles[index].name + ' 선택');
        assert.equal(styleCheckbox(card).checked, false);
    });
    assert.equal(f.button('선택한 그림체 삭제 (0)').disabled, true);

    f.content.replaceChildren();
    await openStyleList(f, 'v5');
    assert.deepEqual(f.content.querySelectorAll('.daki-style-card').map(card => card.children[0].src),
        ['/source/one', '/source/two', '/source/three']);
});

test('shared style overview and new-test targets use V5-only styles before upper conversion', async () => {
    const catalog = {configured: true, styles: [
        {id: 'legacy-upper', name: 'Synthetic legacy upper', category: 'upper', src: '/source/upper'},
        {id: 'v5-one', name: 'Synthetic V5 one', category: 'v5', src: '/source/v5-one'},
        {id: 'missing-category', name: 'Synthetic legacy default', src: '/source/missing'},
        {id: 'v5-two', name: 'Synthetic V5 two', category: 'v5', src: '/source/v5-two'},
    ]};
    const f = fixture(), rootRender = f.render('library=shared');
    f.reply(catalog); await new Promise(resolve => setImmediate(resolve));
    f.reply({batches: []}); await rootRender;
    assert.equal(f.button('전체 그림체로 테스트 만들기').disabled, false);
    let targetCatalog;
    f.win.DakiTestTargets = {create(options) {
        targetCatalog = JSON.parse(JSON.stringify(options.catalog));
        return {element: f.doc.createElement('section'), selection: () => ({styleIds: null, count: 2, error: ''}), dispose() {}};
    }};
    const form = await openTestSettings(f);
    assert.deepEqual(targetCatalog.styles.map(style => style.id), ['v5-one', 'v5-two']);
    assert.match(f.doc.getElementById('dakiTestScope').textContent, /2개/);
    form.elements.namedItem('name').value = 'Shared only';
    const saving = form.onsubmit({preventDefault() {}});
    const request = f.reply({batch: {id: 'shared-only'}}); await saving;
    assert.deepEqual(request.body.style_ids, ['v5-one', 'v5-two']);
    const allFolder = f.content.querySelectorAll('a').find(folder => folder.href.endsWith('category=all'));
    const upperFolder = f.content.querySelectorAll('a').find(folder => folder.href.endsWith('category=upper'));
    assert.equal(allFolder.folder.count, 2);
    assert.equal(allFolder.folder.src, '/source/v5-one');
    assert.equal(allFolder.folder.subtitle, '원본 공유 그림체 · 대표 그림 보기 · 선택 삭제');
    assert.equal(upperFolder.folder.count, 2);
    assert.equal(upperFolder.folder.src, '/source/upper');

    f.content.replaceChildren();
    const allRender = f.render('library=shared&category=all'); f.reply(catalog); await allRender;
    assert.deepEqual(f.content.querySelectorAll('.daki-style-card').map(card => card.dataset.path),
        ['__daki_shared__/v5-one.png', '__daki_shared__/v5-two.png']);
    assert.equal(f.doc.getElementById('dakiSubtitle').textContent, '2개 그림체 · V5 원본 공유 그림체');

});

test('shared-style worldcup receives only images visible in the current category and search', async () => {
    const f = fixture(); await openStyleList(f, 'v5');
    f.button('태그 그림 이상형 월드컵').onclick();
    assert.deepEqual(JSON.parse(JSON.stringify(f.worldcups[0][0])).map(image => image.path),
        ['__daki_shared__/one.png', '__daki_shared__/two.png', '__daki_shared__/three.png']);
    assert.equal(f.worldcups[0][1], '공유 그림체 · V5 그림체');
    const search = f.content.querySelector('input'); search.value = 'blue'; search.oninput();
    f.button('태그 그림 이상형 월드컵').onclick();
    assert.deepEqual(JSON.parse(JSON.stringify(f.worldcups[1][0])), [
        {path: '__daki_shared__/one.png', src: '/source/one', name: 'Synthetic blue V5'},
        {path: '__daki_shared__/three.png', src: '/source/three', name: 'Synthetic blue V5'},
    ]);
    search.value = 'no matching styles'; search.oninput(); f.button('태그 그림 이상형 월드컵').onclick();
    assert.equal(f.worldcups[2][0].length, 0);
    assert.equal(f.requests.length, 1);
});

test('source links identify the original post independently of the image ID and open safely in a new tab', async () => {
    const f = fixture();
    const catalog = styleCatalog();
    catalog.styles.forEach((style, index) => {
        style.source_url = `https://arca.live/b/aiart/${120001 + index}?p=1#comment`;
        style.source_image_id = 900 + index;
    });
    const render = f.render('library=shared&category=all'); f.reply(catalog); await render;
    const cards = f.content.querySelectorAll('.daki-style-card');
    cards.forEach((card, index) => {
        const link = card.querySelector('a');
        assert.equal(link.href, catalog.styles[index].source_url);
        assert.equal(link.textContent, `아카라이브 · aiart #${120001 + index} ↗`);
        assert.equal(link.target, '_blank');
        assert.equal(link.rel, 'noopener noreferrer');
        assert.match(link.attributes['aria-label'], /새 탭/);
        assert.equal(styleCheckbox(card).checked, false);
    });
});

test('missing or non-post source URLs are displayed without creating a navigation link', async () => {
    const f = fixture();
    const urls = [undefined, 'javascript:alert(1)', 'https://arca.live.example.test/b/aiart/123',
        'https://arca.live@other.test/b/aiart/123', 'https://arca.live/b/aiart'];
    const styles = urls.map((source_url, index) => ({id: `style-${index}`, name: 'Synthetic', src: '/source/image', source_url}));
    const render = f.render('library=shared&category=all'); f.reply({configured: true, styles}); await render;
    assert.equal(f.content.querySelectorAll('a').length, 0);
    assert.ok(f.content.querySelectorAll('.daki-style-source').every(label => label.textContent === '출처 정보 없음'));
});

test('shared cards show collected recommendations and distinguish zero from unknown', async () => {
    const f = fixture(), catalog = styleCatalog();
    catalog.styles[0].recommendation_count = 1234;
    catalog.styles[0].recommendation_collected_at = '2026-01-01T12:00:00Z';
    catalog.styles[1].recommendation_count = 0;
    const render = f.render('library=shared&category=all'); f.reply(catalog); await render;
    const votes = f.content.querySelectorAll('.daki-style-votes');
    assert.equal(votes[0].textContent, '👍 추천 1,234');
    assert.match(votes[0].title, /수집 당시 추천수.*2026/);
    assert.equal(votes[1].textContent, '👍 추천 0');
    assert.equal(votes[2].textContent, '추천수 정보 없음');
});

test('existing test results and pending items expose safe source links and update metadata without replacing images', async () => {
    const f = fixture(), value = batch({completed: 1, pending: 1});
    value.items[0] = {...value.items[0], status: 'completed', src: '/results/one',
        source_url: 'https://arca.live/b/aiart/120001', recommendation_count: 21};
    value.items[1] = {...value.items[1], source_url: 'javascript:bad', recommendation_count: null};
    await openBatch(f, value);
    const cards = f.content.querySelectorAll('.daki-style-card'), image = cards[0].children[0];
    const link = cards[0].querySelector('a');
    assert.equal(link.href, value.items[0].source_url);
    assert.equal(link.target, '_blank'); assert.equal(link.rel, 'noopener noreferrer');
    assert.equal(cards[0].querySelector('.daki-style-votes').textContent, '👍 추천 21');
    assert.equal(cards[1].querySelector('a'), null);
    assert.equal(cards[1].querySelector('.daki-style-votes').textContent, '추천수 정보 없음');
    f.button('이름 변경').onclick();
    const updated = JSON.parse(JSON.stringify(value));
    updated.items[0].recommendation_count = 22;
    updated.items[1].source_url = 'https://arca.live/b/aiart/120002';
    updated.items[1].recommendation_count = 0;
    f.renames[0][1](updated);
    assert.equal(cards[0].children[0], image);
    assert.equal(cards[0].querySelectorAll('.daki-style-origin').length, 1);
    assert.equal(cards[0].querySelector('.daki-style-votes').textContent, '👍 추천 22');
    assert.equal(cards[1].querySelector('a').href, updated.items[1].source_url);
    assert.equal(cards[1].querySelector('.daki-style-votes').textContent, '👍 추천 0');
});

test('select visible styles respects search and clearing also resets hidden selections', async () => {
    const f = fixture();
    await openStyleList(f);
    const cards = f.content.querySelectorAll('.daki-style-card');
    const search = f.content.querySelectorAll('input').find(input => input.type === 'search');
    search.value = 'blue'; search.oninput();
    assert.deepEqual(f.content.querySelectorAll('.daki-style-card'), [cards[0], cards[2]]);
    f.button('표시된 그림체 모두 선택').onclick();
    assert.equal(styleCheckbox(cards[0]).checked, true);
    assert.equal(styleCheckbox(cards[1]).checked, false);
    assert.equal(styleCheckbox(cards[2]).checked, true);
    assert.equal(cards[0].dataset.styleSelected, 'true');
    assert.equal(cards[2].dataset.styleSelected, 'true');
    assert.equal(f.button('선택한 그림체 삭제 (2)').disabled, false);
    search.value = 'green'; search.oninput();
    f.button('선택 해제').onclick();
    assert.ok(cards.every(card => !styleCheckbox(card).checked));
    assert.ok(cards.every(card => card.dataset.styleSelected === 'false'));
    assert.equal(f.button('선택한 그림체 삭제 (0)').disabled, true);
    assert.equal(f.requests.filter(request => request.method === 'POST').length, 0);
});

test('selected removal sends exact IDs once, removes only chosen cards, and clears selection', async () => {
    const f = fixture();
    await openStyleList(f);
    const cards = f.content.querySelectorAll('.daki-style-card');
    selectStyle(cards[0]); selectStyle(cards[2]);
    const remove = f.button('선택한 그림체 삭제 (2)');
    const removal = remove.onclick();
    assert.equal(remove.disabled, true);
    assert.equal(f.button('표시된 그림체 모두 선택').disabled, true);
    assert.equal(f.button('선택 해제').disabled, true);
    assert.ok(cards.every(card => styleCheckbox(card).disabled));
    await remove.onclick();
    assert.equal(f.pending.length, 1);
    assert.deepEqual(f.reply({removed: 2}), {
        url: '/api/daki/shared-styles/remove', method: 'POST', body: {style_ids: ['one', 'three']},
    });
    await removal;
    assert.deepEqual(f.content.querySelectorAll('.daki-style-card'), [cards[1]]);
    assert.equal(styleCheckbox(cards[1]).checked, false);
    assert.equal(styleCheckbox(cards[1]).disabled, false);
    assert.equal(f.button('선택한 그림체 삭제 (0)').disabled, true);
    assert.equal(f.button('표시된 그림체 모두 선택').disabled, false);
});

test('failed removal keeps selection available for an explicit retry', async () => {
    const f = fixture();
    await openStyleList(f);
    const cards = f.content.querySelectorAll('.daki-style-card');
    selectStyle(cards[1]);
    const remove = f.button('선택한 그림체 삭제 (1)');
    const failure = remove.onclick();
    f.reply({message: 'Synthetic removal failure'}, 500); await failure;
    assert.deepEqual(f.content.querySelectorAll('.daki-style-card'), cards);
    assert.equal(styleCheckbox(cards[1]).checked, true);
    assert.equal(cards[1].dataset.styleSelected, 'true');
    assert.equal(remove.disabled, false);
    assert.ok(cards.every(card => !styleCheckbox(card).disabled));
    assert.equal(f.doc.getElementById('dakiPageStatus').textContent, 'Synthetic removal failure');
    const retry = remove.onclick();
    assert.deepEqual(f.reply({removed: 1}).body, {style_ids: ['two']}); await retry;
    assert.deepEqual(f.content.querySelectorAll('.daki-style-card'), [cards[0], cards[2]]);
    assert.doesNotMatch(f.doc.getElementById('dakiPageStatus').textContent, /Synthetic removal failure/);
});

test('removal completing after navigation does not change the destination DOM', async () => {
    const f = fixture();
    await openStyleList(f);
    selectStyle(f.content.querySelector('.daki-style-card'));
    const removal = f.button('선택한 그림체 삭제 (1)').onclick();
    f.win.DakiStyles.leave(); f.setActive(false);
    f.content.textContent = 'Destination gallery';
    f.doc.getElementById('dakiPageStatus').textContent = 'Destination status';
    f.reply({removed: 1}); await removal;
    assert.equal(f.content.textContent, 'Destination gallery');
    assert.equal(f.doc.getElementById('dakiPageStatus').textContent, 'Destination status');
});

test('shared folder disables generation when no styles remain', async () => {
    const f = fixture();
    const render = f.render('library=shared');
    f.reply({configured: true, styles: []});
    await new Promise(resolve => setImmediate(resolve));
    f.reply({batches: []}); await render;
    assert.equal(f.button('전체 그림체로 테스트 만들기').disabled, true);
});

test('upper styles alone cannot enable shared all-style test creation', async () => {
    const f = fixture(); const render = f.render('library=shared');
    f.reply({configured: true, styles: [{id: 'upper-only', name: 'Synthetic upper', category: 'upper'},
        {id: 'legacy-upper', name: 'Synthetic old upper'}]});
    await new Promise(resolve => setImmediate(resolve)); f.reply({batches: []}); await render;
    assert.equal(f.button('전체 그림체로 테스트 만들기').disabled, true);
});

test('shared sync is beside test creation, reloads the root and retains completion counts', async () => {
    const f = fixture(), render = f.render('library=shared');
    f.reply(styleCatalog()); await new Promise(resolve => setImmediate(resolve));
    f.reply({batches: []}); await render;
    const toolbar = f.content.querySelector('.daki-style-toolbar');
    assert.deepEqual(toolbar.children.map(child => child.textContent), ['전체 그림체로 테스트 만들기', '공유 테스트 다운로드', '공유 그림체 최신화']);
    f.button('공유 그림체 최신화').onclick(); assert.equal(f.syncs.length, 1);
    const reload = f.syncs[0].onComplete({added: 2, skipped: 3});
    assert.equal(f.content.children.length, 0);
    f.reply(styleCatalog()); await new Promise(resolve => setImmediate(resolve));
    f.reply({batches: []}); await reload;
    assert.equal(f.content.querySelectorAll('.daki-style-toolbar').length, 1);
    assert.equal(f.doc.getElementById('dakiPageStatus').textContent, '공유 그림체 최신화 · 추가 2 · 건너뜀 3');
    await f.syncs[0].onComplete({added: 99});
    assert.equal(f.pending.length, 0);
});

test('shared test pack download is manual and refreshes root saved test cards after an install', async () => {
    const f = fixture(), render = f.render('library=shared');
    f.reply(styleCatalog()); await new Promise(resolve => setImmediate(resolve));
    f.reply({batches: []}); await render;
    assert.deepEqual(f.requests.map(request => request.url), ['/api/daki/shared-styles', '/api/daki/style-tests']);
    f.button('공유 테스트 다운로드').onclick();
    assert.equal(f.testPackOpens.length, 1);
    const refresh = f.testPackOpens[0].onComplete({status: 'completed', installed: 2});
    assert.deepEqual(f.requests.at(-1), {url: '/api/daki/style-tests', method: 'GET', body: undefined});
    f.reply({batches: [{id: 'pack-test', name: 'Downloaded pack', library: 'shared', completed: 3, total: 3,
        status: 'completed', cover_src: '/synthetic/cover.png'}]});
    await refresh;
    assert.ok(f.content.querySelectorAll('a').some(card => card.textContent === 'Downloaded pack'));
});

test('Hugging Face sync root summary reports published updates and keeps failures unpublished', async () => {
    for (const [job, expected, forbidden] of [
        [{source: 'huggingface', status: 'completed', published: true, added: 2, updated: 0, filtered: 4, skipped: 5, post_limited: 3},
            '공유 그림체 최신화 · 추가 2 · 필터 제외 4 · 건너뜀 5 · 게시물 제한 3', /갱신/],
        [{source: 'huggingface', status: 'completed', published: true, added: 2, updated: 3, filtered: 4, skipped: 5},
            '공유 그림체 최신화 · 추가 2 · 갱신 3 · 필터 제외 4 · 건너뜀 5', null],
        [{source: 'huggingface', status: 'failed', published: false, added: 99, prepared: 20},
            '공유 그림체 최신화 실패 · 기존 목록 유지', /추가 99|준비 20/],
        [{source: 'huggingface', status: 'stopped', published: false, added: 99, prepared: 20},
            '공유 그림체 최신화 중지 · 기존 목록 유지', /추가 99|준비 20/],
        [{source: 'huggingface', status: 'failed', published: true, added: 2, updated: 3, filtered: 4, skipped: 5},
            '공유 그림체 최신화 실패 · 카탈로그 반영 · 추가 2 · 갱신 3 · 필터 제외 4 · 건너뜀 5', null],
        [{source: 'huggingface', status: 'stopped', published: null, added: 99, prepared: 20},
            '공유 그림체 최신화 중지 · 반영 여부 확인 불가', /추가 99|준비 20|기존 목록 유지/],
    ]) {
        const f = fixture(), render = f.render('library=shared');
        f.reply(styleCatalog()); await new Promise(resolve => setImmediate(resolve));
        f.reply({batches: []}); await render;
        f.button('공유 그림체 최신화').onclick();
        const reload = f.syncs[0].onComplete(job);
        f.reply(styleCatalog()); await new Promise(resolve => setImmediate(resolve));
        f.reply({batches: []}); await reload;
        const summary = f.doc.getElementById('dakiPageStatus').textContent;
        assert.equal(summary, expected);
        if (forbidden) assert.doesNotMatch(summary, forbidden);
    }
});

test('a sync callback after navigation leaves the destination and its status untouched', async () => {
    const f = fixture(), render = f.render('library=shared');
    f.reply(styleCatalog()); await new Promise(resolve => setImmediate(resolve));
    f.reply({batches: []}); await render;
    f.button('공유 그림체 최신화').onclick();
    f.win.DakiStyles.leave(); f.setActive(false);
    f.content.textContent = 'Destination'; f.doc.getElementById('dakiPageStatus').textContent = 'Destination status';
    await f.syncs[0].onComplete({added: 2});
    assert.equal(f.pending.length, 0); assert.equal(f.content.textContent, 'Destination');
    assert.equal(f.doc.getElementById('dakiPageStatus').textContent, 'Destination status');
});

test('original settings shows core values, source, and collapsed readable details', async () => {
    const f = fixture();
    const style = styleDetail();
    const dialog = await openStyleDetail(f, style);
    assert.equal(dialog.querySelector('h2').textContent, style.name);
    assert.ok(dialog.querySelectorAll('button').some(button => button.textContent === '닫기'));
    const source = dialog.querySelector('a');
    assert.equal(source.href, style.source_url);
    assert.equal(source.target, '_blank');
    assert.equal(source.rel, 'noopener noreferrer');
    const core = dialog.querySelector('dl');
    assert.ok(core, 'Core settings use a description list');
    assert.deepEqual(core.querySelectorAll('dt').map(label => label.textContent),
        ['모델', '크기', '스텝', 'CFG', '샘플러', '노이즈 스케줄']);
    const values = core.querySelectorAll('dd').map(value => value.textContent);
    assert.ok(values.some(value => /V5|nai-diffusion-5-full/.test(value)));
    assert.ok(values.includes('832 × 1216'));
    assert.ok(values.includes('28'));
    assert.ok(values.includes('5.5'));
    assert.ok(values.some(value => /euler/i.test(value)));
    assert.ok(values.some(value => /karras/i.test(value)));
    const advanced = dialog.querySelector('details');
    assert.equal(advanced.querySelector('summary').textContent, '세부 설정');
    assert.equal(advanced.open, false);
    assert.match(advanced.textContent, /켜짐/);
    assert.match(advanced.textContent, /꺼짐/);
    assert.match(advanced.textContent, /4294967297/);
    assert.match(advanced.textContent, /시드/);
    assert.doesNotMatch(advanced.textContent, /cfg_rescale|prefer_brownian|deliberate_euler_ancestral_bug/);
    assert.ok(advanced.querySelectorAll('dd').some(value => value.textContent === '0'));
});

test('Base and Nega tabs preserve exact plain text and support keyboard selection', async () => {
    const f = fixture();
    const style = styleDetail();
    const dialog = await openStyleDetail(f, style);
    const base = f.doc.getElementById('dakiStyleTab-base');
    const nega = f.doc.getElementById('dakiStyleTab-nega');
    const basePanel = f.doc.getElementById('dakiStylePanel-base');
    const negaPanel = f.doc.getElementById('dakiStylePanel-nega');
    assert.equal(base.attributes.role, 'tab'); assert.equal(nega.attributes.role, 'tab');
    assert.equal(basePanel.attributes.role, 'tabpanel'); assert.equal(negaPanel.attributes.role, 'tabpanel');
    assert.equal(base.attributes['aria-controls'], basePanel.id);
    assert.equal(nega.attributes['aria-controls'], negaPanel.id);
    assert.equal(basePanel.attributes['aria-labelledby'], base.id);
    assert.equal(negaPanel.attributes['aria-labelledby'], nega.id);
    function assertSelected(active, inactive, visible, hidden) {
        assert.equal(active.attributes['aria-selected'], 'true');
        assert.equal(inactive.attributes['aria-selected'], 'false');
        assert.equal(Number(active.tabIndex), 0); assert.equal(Number(inactive.tabIndex), -1);
        assert.equal(visible.hidden, false); assert.equal(hidden.hidden, true);
    }
    assertSelected(base, nega, basePanel, negaPanel);
    assert.equal(basePanel.querySelector('pre').textContent, style.positive);
    assert.equal(negaPanel.querySelector('pre').textContent, style.negative);
    assert.equal(basePanel.querySelector('pre').children.length, 0);
    assert.equal(negaPanel.querySelector('pre').children.length, 0);
    assert.equal(dialog.querySelectorAll('textarea').length, 0);
    assert.equal(dialog.querySelectorAll('input').length, 0);
    nega.onclick(); assertSelected(nega, base, negaPanel, basePanel);
    base.onclick(); assertSelected(base, nega, basePanel, negaPanel);
    for (const [from, key, active, inactive, visible, hidden] of [
        [base, 'ArrowRight', nega, base, negaPanel, basePanel],
        [nega, 'ArrowLeft', base, nega, basePanel, negaPanel],
        [base, 'End', nega, base, negaPanel, basePanel],
        [nega, 'Home', base, nega, basePanel, negaPanel],
        [base, 'ArrowLeft', nega, base, negaPanel, basePanel],
    ]) {
        assert.equal(pressKey(from, key).defaultPrevented, true);
        assertSelected(active, inactive, visible, hidden);
        assert.equal(f.doc.activeElement, active);
    }
    assert.equal(pressKey(nega, 'Escape').defaultPrevented, false);
    assert.equal(basePanel.querySelector('pre').textContent, style.positive);
    assert.equal(negaPanel.querySelector('pre').textContent, style.negative);
});

test('failed original-settings fetch retains an error message and a working close control', async () => {
    const f = fixture();
    await openStyleList(f);
    const load = f.content.querySelector('.daki-style-card').querySelector('button').onclick();
    const dialog = f.doc.body.querySelector('dialog');
    f.reply({message: 'Synthetic settings failure'}, 500); await load;
    assert.equal(dialog.open, true);
    assert.match(dialog.textContent, /Synthetic settings failure/);
    dialog.querySelectorAll('button').find(button => button.textContent === '닫기').onclick();
    assert.equal(dialog.open, false);
    assert.equal(f.doc.body.querySelector('dialog'), null);
});

test('a late original-settings response cannot populate a closed dialog', async () => {
    const f = fixture();
    await openStyleList(f);
    const load = f.content.querySelector('.daki-style-card').querySelector('button').onclick();
    const dialog = f.doc.body.querySelector('dialog');
    const before = dialog.textContent;
    dialog.querySelectorAll('button').find(button => button.textContent === '닫기').onclick();
    f.reply({style: styleDetail()}); await load;
    assert.equal(dialog.textContent, before);
    assert.equal(dialog.querySelector('dl'), null);
    assert.equal(f.doc.body.querySelector('dialog'), null);
});
