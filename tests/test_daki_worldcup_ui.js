const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const flush = () => new Promise(resolve => setImmediate(resolve));
const clone = value => JSON.parse(JSON.stringify(value));
const images = n => Array.from({length: n}, (_, i) => ({path: `synthetic/image-${i}.png`, src: `/synthetic/${i}.png`, name: `Style ${i}`}));

function fixture() {
    class Element {
        constructor(tag) {
            this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.dataset = {};
            this.listeners = new Map(); this.className = ''; this.hidden = false; this.open = false;
            this.disabled = false; this.text = '';
            this.classList = {
                add: (...names) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); },
                toggle: (name, enabled) => {
                    const names = new Set(this.className.split(' ').filter(Boolean));
                    if (enabled) names.add(name); else names.delete(name); this.className = [...names].join(' ');
                },
            };
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
        setAttribute(name, value) { this.attributes[name] = String(value); }
        addEventListener(name, callback) {
            const callbacks = this.listeners.get(name) || []; callbacks.push(callback); this.listeners.set(name, callbacks);
        }
        showModal() { this.open = true; }
        close() { this.open = false; (this.listeners.get('close') || []).forEach(callback => callback()); }
        focus() { doc.activeElement = this; }
        get isConnected() { return !!this.parentNode; }
        matches(selector) {
            if (selector === 'button:not(:disabled)') return this.tagName === 'BUTTON' && !this.disabled;
            if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
            return this.tagName === selector.toUpperCase();
        }
        querySelectorAll(selector) { return this.descendants().filter(el => el.matches(selector)); }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    }
    const doc = {body: new Element('body'), createElement: tag => new Element(tag)};
    doc.getElementById = id => doc.body.descendants().find(el => el.id === id) || null;
    for (const id of ['dakiTitle', 'dakiSubtitle', 'dakiBack', 'dakiPageStatus', 'dakiContent']) {
        const item = new Element('div'); item.id = id; doc.body.appendChild(item);
    }
    const requests = [], pending = [], events = [], bindings = [], tags = {}, listeners = new Map(), confirmations = [];
    let sequence = 0, confirmClose = false;
    const win = {
        document: doc, crypto: {randomUUID: () => (++sequence).toString(16).padStart(32, '0')},
        getGalleryTagState: () => ({definitions: [{id: 'favorite', type: 'text', value: 'Favorite'}, {id: 'other', type: 'text', value: 'Other'}]}),
        getGalleryImageTagId: path => tags[path],
        addEventListener: (name, callback) => listeners.set(name, callback),
        removeEventListener: name => listeners.delete(name),
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
        dispatchEvent: event => events.push(event),
        confirm: message => { confirmations.push(message); return confirmClose; },
        Daki: {
            isActive: () => true,
            createGrid(className, items = []) {
                const grid = new Element('div'); grid.className = className;
                grid.setItems = children => grid.replaceChildren(...children); grid.setItems(items); return grid;
            },
            folderCard(name, href, count, subtitle, src) {
                const card = new Element('a'); card.textContent = name; card.href = href; card.folder = {name, href, count, subtitle, src}; return card;
            },
            bindImage(card, img, path) { card.dataset.path = path; bindings.push(path); },
        },
        fetch(url, options) {
            const request = {url, method: options.method, body: options.body === undefined ? undefined : JSON.parse(options.body)};
            requests.push(request); return new Promise(resolve => pending.push({request, resolve}));
        },
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../static/daki_worldcup.js'), 'utf8'), {window: win, Uint8Array});
    const content = doc.getElementById('dakiContent');
    function button(text) { const item = doc.body.querySelectorAll('button').find(el => el.textContent === text); assert.ok(item, text); return item; }
    return {win, doc, content, tags, requests, pending, events, listeners, bindings, button, confirmations,
        setConfirm(value) { confirmClose = value; },
        cancel(modal) {
            const event = {defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }};
            (modal.listeners.get('cancel') || []).forEach(callback => callback(event));
            if (!event.defaultPrevented) modal.close();
            return event;
        },
        reply(data, status = 200) {
            const entry = pending.shift(); assert.ok(entry, 'Expected API request');
            entry.resolve({ok: status < 400, json: async () => ({status: status < 400 ? 'success' : 'error', ...data})}); return entry.request;
        },
        open(entries = images(3), title = 'Synthetic gallery', galleryKey = 'test:example') {
            entries.forEach(image => { tags[image.path] = 'favorite'; });
            return win.DakiWorldCup.open(entries, title, galleryKey);
        },
        start() { button('Favorite').onclick(); button('월드컵 시작').onclick(); },
        chooseAll() {
            let last;
            for (let count = 0; count < 50; count++) {
                const choice = doc.body.querySelectorAll('.daki-worldcup-choice').find(el => !el.disabled);
                if (!choice) return last;
                last = choice; choice.onclick();
            }
            assert.fail('Tournament did not finish');
        },
        render(params = '') { return win.DakiWorldCup.render(new URLSearchParams(params), content); },
    };
}

function saved(payload, overrides = {}) {
    const paths = payload.participants || images(2);
    const winner = payload.choices?.at(-1) || paths[0].path;
    const participants = paths.map((image, index) => ({...image, src: `/saved/${index}.png`,
        rank: image.path === winner ? 1 : 2, wins: image.path === winner ? 1 : 0}));
    return {id: payload.id || 'a'.repeat(32), title: payload.title || 'Saved synthetic', gallery_key: payload.gallery_key || 'test:example',
        tag: payload.tag || {id: 'favorite', label: 'Favorite'}, created_at: '2026-01-01T00:00:00+00:00', total: participants.length,
        participants, initial_participants: paths.map(({path, name}) => ({path, name})),
        winner: participants.find(image => image.path === winner), ...overrides};
}

test('completion automatically saves one stable transcript and publishes its saved result', async () => {
    const f = fixture(); f.open(); f.start();
    const last = f.chooseAll(); assert.equal(f.requests.length, 1);
    const request = f.requests[0];
    assert.equal(request.url, '/api/daki/worldcups'); assert.equal(request.method, 'POST');
    assert.match(request.body.id, /^[a-f0-9]{32}$/); assert.equal(request.body.gallery_key, 'test:example');
    assert.deepEqual(request.body.tag, {id: 'favorite', label: 'Favorite'});
    assert.equal(request.body.participants.length, 3); assert.equal(request.body.choices.length, 2);
    assert.equal(f.button('이전 선택 되돌리기').disabled, true);
    assert.equal(f.button('같은 그림으로 다시하기').disabled, true);
    last.onclick(); assert.equal(f.requests.length, 1);
    const record = saved(request.body); f.reply({record}); await flush();
    assert.equal(f.events.length, 1); assert.equal(f.events[0].type, 'daki-worldcups-updated');
    assert.equal(f.events[0].detail.record.id, record.id);
    assert.equal(f.button('같은 그림으로 다시하기').disabled, false);
    const link = f.doc.body.querySelectorAll('a').find(el => el.textContent === '저장된 순위 보기');
    assert.equal(link.hidden, false); assert.equal(link.href, '#daki&library=worldcups&result=' + record.id);
    const history = f.doc.body.querySelectorAll('a').find(el => el.textContent === '월드컵 기록');
    assert.equal(history.href, '#daki&library=worldcups&gallery_key=test%3Aexample');
    last.onclick(); assert.equal(f.requests.length, 1); assert.equal(link.hidden, false);
});

test('failed saves retry the identical payload and id, without double posting', async () => {
    const f = fixture(); f.open(images(2)); f.start(); f.chooseAll();
    const first = f.reply({message: 'Synthetic save failure'}, 500); await flush();
    assert.match(f.doc.body.querySelector('.daki-worldcup-save-status').textContent, /Synthetic save failure/);
    assert.equal(f.button('같은 그림으로 다시하기').disabled, true);
    const retry = f.button('저장 다시 시도'); assert.equal(retry.hidden, false);
    const pending = retry.onclick(); retry.onclick();
    assert.equal(f.pending.length, 1); assert.equal(retry.disabled, true);
    const second = f.reply({record: saved(first.body)}); await pending;
    assert.deepEqual(second.body, first.body); assert.equal(f.events.length, 1); assert.equal(retry.hidden, true);
});

test('saving blocks close, Escape and history navigation until persistence succeeds', async () => {
    const f = fixture(), modal = f.open(images(2)); f.start(); f.chooseAll();
    const payload = clone(f.requests[0].body);
    assert.equal(f.button('닫기').disabled, true); f.button('닫기').onclick(); assert.equal(modal.open, true);
    assert.equal(f.cancel(modal).defaultPrevented, true); assert.equal(modal.open, true);
    const history = f.doc.body.querySelectorAll('a').find(el => el.textContent === '월드컵 기록');
    assert.equal(history.hidden, true);
    const click = {defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }};
    history.onclick(click); assert.equal(click.defaultPrevented, true); assert.equal(modal.open, true);
    assert.match(f.doc.body.querySelector('.daki-worldcup-save-status').textContent, /저장 후 닫을 수 있습니다/);
    assert.equal(f.confirmations.length, 0);
    f.reply({record: saved(payload)}); await flush();
    assert.equal(f.button('닫기').disabled, false); assert.equal(history.hidden, false);
    f.button('닫기').onclick();
    assert.equal(f.events.length, 1); assert.equal(f.doc.body.querySelector('dialog'), null);
    assert.equal(f.listeners.has('gallery-tags-updated'), false); assert.equal(f.confirmations.length, 0);
});

test('failed-save close and Escape require explicit loss confirmation and cancellation retains retry', async () => {
    const f = fixture(), modal = f.open(images(2)); f.start(); f.chooseAll();
    f.reply({message: 'Synthetic save failure'}, 500); await flush();
    assert.equal(f.button('닫기').disabled, false); assert.equal(f.button('저장 다시 시도').hidden, false);
    f.button('닫기').onclick(); assert.equal(modal.open, true);
    assert.match(f.confirmations[0], /저장되지 않았습니다.*결과를 잃게 됩니다/);
    f.cancel(modal); assert.equal(modal.open, true); assert.equal(f.confirmations.length, 2);
    const history = f.doc.body.querySelectorAll('a').find(el => el.textContent === '월드컵 기록');
    const click = {defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }};
    history.onclick(click); assert.equal(click.defaultPrevented, true); assert.equal(modal.open, true);
    assert.equal(f.button('저장 다시 시도').disabled, false);
    f.setConfirm(true); f.cancel(modal);
    assert.equal(f.doc.body.querySelector('dialog'), null); assert.equal(f.events.length, 0);
});

test('forced route leave retains background save completion without reopening a dialog', async () => {
    const f = fixture(); f.open(images(2)); f.start(); f.chooseAll();
    const payload = clone(f.requests[0].body); f.win.DakiWorldCup.leave();
    assert.equal(f.doc.body.querySelector('dialog'), null); assert.equal(f.confirmations.length, 0);
    f.reply({record: saved(payload)}); await flush();
    assert.equal(f.events.length, 1); assert.equal(f.doc.body.querySelector('dialog'), null);
});

test('unfinished undo removes its choice from the saved transcript and completion prevents further undo', () => {
    const f = fixture(); f.open(images(3)); f.start();
    const pair = f.doc.body.querySelectorAll('.daki-worldcup-choice');
    const picked = pair[1].querySelector('img').alt; pair[1].onclick();
    f.button('이전 선택 되돌리기').onclick();
    const first = f.doc.body.querySelectorAll('.daki-worldcup-choice')[0];
    assert.notEqual(first.querySelector('img').alt, picked); first.onclick(); f.chooseAll();
    const payload = f.requests[0].body;
    assert.equal(payload.choices.length, 2);
    assert.equal(payload.choices[0], payload.participants[0].path);
    const before = clone(payload); f.button('이전 선택 되돌리기').onclick();
    assert.deepEqual(f.requests[0].body, before); assert.equal(f.pending.length, 1);
});

test('replaying a completed tournament keeps its participants and tag snapshot while creating a new saved record', async () => {
    const f = fixture(); f.open(images(3)); f.start(); f.chooseAll();
    const first = f.requests[0].body; f.reply({record: saved(first)}); await flush();
    Object.keys(f.tags).forEach(path => { delete f.tags[path]; });
    f.button('같은 그림으로 다시하기').onclick(); f.chooseAll();
    const second = f.requests[1].body;
    assert.notEqual(second.id, first.id); assert.equal(second.replay_of, first.id);
    assert.deepEqual(second.tag, first.tag); assert.equal(second.gallery_key, first.gallery_key);
    assert.deepEqual(second.participants.map(image => image.path).sort(), first.participants.map(image => image.path).sort());
    assert.equal(second.choices.length, 2); assert.equal(f.events.length, 1);
});

test('filtered records render gallery folders with their winner cover and detail links', async () => {
    const f = fixture(), record = saved({}); const loaded = f.render('gallery_key=test%3Aexample');
    assert.equal(f.reply({records: [record]}).url, '/api/daki/worldcups?gallery_key=test%3Aexample'); await loaded;
    const card = f.content.querySelector('a'); assert.equal(card.folder.name, record.title);
    assert.equal(card.folder.count, record.total); assert.equal(card.folder.src, record.winner.src);
    assert.equal(card.href, '#daki&library=worldcups&result=' + record.id);
    assert.match(card.folder.subtitle, /Favorite.*2026/);
});

test('saved detail renders all tied ranks and missing entries, and replays saved participants despite current tag changes', async () => {
    const f = fixture(); const entries = images(4);
    const record = saved({participants: entries}, {participants: entries.map((image, index) => ({...image,
        rank: [1, 2, 3, 3][index], wins: [2, 1, 0, 0][index]})), tag: {id: 'retired-tag', label: 'Former favorite'}});
    const loaded = f.render('result=' + record.id); f.reply({record}); await loaded;
    assert.equal(f.doc.getElementById('dakiBack').href, '#daki&library=worldcups&gallery_key=test%3Aexample');
    assert.equal(f.content.querySelectorAll('.daki-worldcup-rank-card').length, 4);
    assert.deepEqual(f.content.querySelectorAll('.daki-worldcup-rank').map(item => item.textContent), ['1위', '2위', '공동 3위', '공동 3위']);
    assert.deepEqual(f.bindings, entries.map(image => image.path));
    const card = f.content.querySelectorAll('.daki-worldcup-rank-card')[3]; card.querySelector('img').onerror();
    assert.equal(card.querySelector('.daki-worldcup-missing').hidden, false);
    assert.equal(f.content.querySelectorAll('.daki-worldcup-rank-card').length, 4);
    f.button('같은 그림으로 다시하기').onclick();
    assert.equal(f.doc.body.querySelector('.daki-worldcup-setup').hidden, true);
    const contender = f.doc.body.querySelector('.daki-worldcup-choice'); contender.querySelector('img').onerror();
    assert.equal(contender.querySelector('.daki-worldcup-missing').hidden, false); assert.equal(contender.disabled, false);
    f.chooseAll(); const payload = f.requests[1].body;
    assert.equal(payload.replay_of, record.id); assert.deepEqual(payload.tag, record.tag);
    assert.deepEqual(payload.participants.map(image => image.path).sort(), entries.map(image => image.path).sort());
});

test('late list replies cannot replace a navigated view and a fetch failure exposes a working retry', async () => {
    const f = fixture(); const pending = f.render(); f.win.DakiWorldCup.leave(); f.content.textContent = 'Destination';
    f.reply({records: [saved({})]}); await pending; assert.equal(f.content.textContent, 'Destination');
    f.content.replaceChildren(); const load = f.render(); f.reply({message: 'Synthetic list failure'}, 500); await load;
    assert.match(f.doc.getElementById('dakiPageStatus').textContent, /Synthetic list failure/);
    const retry = f.button('다시 불러오기').onclick(); f.reply({records: []}); await retry;
    assert.match(f.content.textContent, /저장된 월드컵이 없습니다/);
});
