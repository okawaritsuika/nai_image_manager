const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
    class Element {
        constructor(tag) {
            this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.dataset = {};
            this.listeners = new Map(); this.className = ''; this.hidden = false; this.open = false;
            this.disabled = false; this.text = ''; this.value = '';
        }
        set value(value) { this._value = String(value); }
        get value() { return this._value; }
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
        insertBefore(child, sibling) {
            child.remove(); this.children.splice(this.children.indexOf(sibling), 0, child); child.parentNode = this;
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
            if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
            return this.tagName === selector.toUpperCase();
        }
        querySelectorAll(selector) { return this.descendants().filter(el => selector.split(',').some(part => el.matches(part.trim()))); }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    }
    const doc = {body: new Element('body'), createElement: tag => new Element(tag)};
    doc.getElementById = id => doc.body.descendants().find(el => el.id === id) || null;
    for (const id of ['dakiTitle', 'dakiSubtitle', 'dakiBack', 'dakiPageStatus', 'dakiContent']) {
        const item = new Element('div'); item.id = id; doc.body.appendChild(item);
    }
    const requests = [], pending = [], bindings = [], tests = [], cups = [], batchCards = [], delegated = [], toasts = [];
    let active = true;
    const win = {
        document: doc, location: {hash: '#daki&library=personal'}, showToast: text => toasts.push(text),
        Daki: {
            isActive: () => active,
            createGrid(className, items = []) {
                const grid = new Element('div'); grid.className = className;
                grid.setItems = children => grid.replaceChildren(...children); grid.setItems(items); return grid;
            },
            bindImage(card, image, path) { card.dataset.path = path; bindings.push(path); },
            createImageTools() { const el = new Element('div'); el.textContent = 'gallery image tools'; return el; },
        },
        DakiStyles: {
            openSettings: options => tests.push(options),
            savedBatchCard(batch) { batchCards.push(batch); const card = new Element('a'); card.textContent = batch.name; return card; },
            render: (...args) => delegated.push(args),
        },
        DakiWorldCup: {open: (...args) => cups.push(args)},
        fetch(url, options) {
            const request = {url, method: options.method, body: options.body === undefined ? undefined : JSON.parse(options.body)};
            requests.push(request); return new Promise(resolve => pending.push({request, resolve}));
        },
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../static/daki_personal_styles.js'), 'utf8'), {window: win, URLSearchParams});
    function reply(data, status = 200) {
        const entry = pending.shift(); assert.ok(entry, 'Expected API request');
        entry.resolve({ok: status < 400, json: async () => ({status: status < 400 ? 'success' : 'error', ...data})}); return entry.request;
    }
    const content = doc.getElementById('dakiContent');
    return {win, doc, content, requests, pending, bindings, tests, cups, batchCards, delegated, toasts, reply,
        setActive(value) { active = value; },
        field(key) { return doc.getElementById('dakiPersonal-' + key); },
        button(text) { const item = doc.body.querySelectorAll('button').find(el => el.textContent === text); assert.ok(item, text); return item; },
        render(params = 'library=personal') { return win.DakiPersonalStyles.render(new URLSearchParams(params), content); },
        submit() { return doc.getElementById('dakiPersonalForm').onsubmit({preventDefault() {}}); },
    };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const clone = value => JSON.parse(JSON.stringify(value));
function style(overrides = {}) {
    return {id: 'personal_example', name: 'Synthetic style', positive: 'synthetic base', negative: 'synthetic nega',
        source_path: 'synthetic/example.png', model: 'nai-diffusion-5-full', preview: {width: 832, height: 1216},
        options: {steps: 28, cfg: 6.5, cfg_rescale: .4, sampler: 'k_euler', noise_schedule: 'native',
            prefer_brownian: false, strength: .75, dynamic_thresholding: true}, ...overrides};
}

test('personal library reuses gallery interactions, excludes imageless recipes from worldcup and shows only personal tests', async () => {
    const f = fixture(), styles = [style(), style({id: 'personal_manual', name: 'Manual style', source_path: ''})];
    const loaded = f.render(); f.reply({styles}); await flush();
    assert.equal(f.reply({batches: [{id: 'one', library: 'shared'}, {id: 'two', name: 'Portrait test', library: 'personal'}]}).url, '/api/daki/style-tests');
    await loaded;
    assert.deepEqual(f.bindings, ['__daki_personal__/personal_example.png']);
    assert.equal(f.content.querySelectorAll('.daki-personal-card').length, 2);
    assert.equal(f.content.querySelectorAll('.daki-personal-placeholder').length, 1);
    assert.deepEqual(f.batchCards.map(batch => batch.id), ['two']);
    f.button('전체 그림체로 테스트 만들기').onclick(); assert.deepEqual(clone(f.tests[0]), {styles, library: 'personal'});
    f.button('태그 그림 이상형 월드컵').onclick();
    assert.equal(f.cups[0][0].length, 1); assert.equal(f.cups[0][0][0].path, f.bindings[0]);
    const search = f.content.querySelector('input'); search.value = 'manual'; search.oninput();
    assert.equal(f.content.querySelectorAll('.daki-personal-card').length, 1);
});

test('personal filtering uses representative references and passes only displayed images to its tournament', async () => {
    const f = fixture(); let config, onlyTagged = false, disposed = false;
    f.win.DakiGalleryFilters = {create(options) {
        config = options;
        return {element: f.doc.createElement('div'), dispose() { disposed = true; }, apply(items, pathOf) {
            return onlyTagged ? items.filter(item => pathOf(item).endsWith('/personal_second.png')) : [...items];
        }};
    }};
    const loaded = f.render(); f.reply({styles: [style(), style({id: 'personal_second'}), style({id: 'personal_manual', source_path: ''})]});
    await flush(); f.reply({batches: []}); await loaded;
    assert.equal(config.galleryKey, 'personal');
    assert.equal(f.content.querySelectorAll('.daki-personal-card').length, 3);
    onlyTagged = true; config.onChange();
    assert.equal(f.content.querySelectorAll('.daki-personal-card').length, 1);
    f.button('태그 그림 이상형 월드컵').onclick();
    assert.deepEqual(Array.from(f.cups[0][0], image => image.path), ['__daki_personal__/personal_second.png']);
    assert.equal(f.cups[0][2], 'personal');
    f.win.DakiPersonalStyles.leave(); assert.equal(disposed, true);
});

test('manual editor posts entered recipe only when saved, without a seed or copied image', async () => {
    const f = fixture(); await f.win.DakiPersonalStyles.openEditor();
    assert.equal(f.requests.length, 0);
    f.field('name').value = '  New synthetic  '; f.field('positive').value = '<img src=x onerror=unsafe()> & prompt';
    f.field('negative').value = 'synthetic negative'; f.field('width').value = '1024'; f.field('height').value = '1024';
    f.button('Nega').onclick();
    assert.equal(f.doc.getElementById('dakiPersonalPanel-positive').hidden, true);
    assert.equal(f.doc.getElementById('dakiPersonalPanel-negative').hidden, false);
    const saved = f.submit(); const request = f.reply({style: style({source_path: ''})}); await saved;
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/api/daki/personal-styles');
    assert.equal(request.body.name, 'New synthetic'); assert.equal(request.body.positive, '<img src=x onerror=unsafe()> & prompt');
    assert.equal(request.body.source_path, ''); assert.equal(request.body.model, 'nai-diffusion-5-full');
    assert.deepEqual(request.body.preview, {width: 1024, height: 1024});
    assert.equal(request.body.options.steps, 28); assert.equal('seed' in request.body.options, false);
    assert.equal(f.doc.body.querySelector('dialog'), null); assert.equal(f.toasts.length, 1);
});

test('image import is editable before saving and preserves other original generation options', async () => {
    const f = fixture(), imported = style();
    const opened = f.win.DakiPersonalStyles.openEditor({path: imported.source_path});
    assert.deepEqual(f.reply({style: imported}), {url: '/api/daki/personal-styles/import', method: 'POST', body: {path: imported.source_path}});
    await opened; assert.equal(f.requests.length, 1);
    assert.equal(f.field('positive').value, imported.positive); assert.equal(f.field('cfg').value, '6.5');
    f.field('positive').value = 'edited imported prompt'; f.field('steps').value = '21';
    const saved = f.submit(); const request = f.reply({style: imported}); await saved;
    assert.equal(request.body.positive, 'edited imported prompt'); assert.equal(request.body.options.steps, 21);
    assert.equal(request.body.options.dynamic_thresholding, true); assert.equal(request.body.options.strength, .75);
    assert.equal(request.body.options.prefer_brownian, false); assert.equal(request.body.source_path, imported.source_path);
});

test('editing uses PUT and failures preserve entered values for correction', async () => {
    const f = fixture(); const opened = f.win.DakiPersonalStyles.openEditor({id: 'personal_example'});
    assert.equal(f.reply({style: style()}).url, '/api/daki/personal-styles/personal_example'); await opened;
    f.field('name').value = 'Revised'; const save = f.submit();
    const request = f.reply({message: 'Synthetic validation error'}, 400); await save;
    assert.equal(request.method, 'PUT'); assert.equal(request.url, '/api/daki/personal-styles/personal_example');
    assert.equal(f.field('name').value, 'Revised'); assert.equal(f.doc.body.querySelector('dialog').open, true);
    assert.equal(f.button('그림체 저장').disabled, false); assert.match(f.doc.getElementById('dakiPersonalStatus').textContent, /Synthetic validation/);
});

test('a failed edit load cannot save the default draft over the existing recipe', async () => {
    const f = fixture(); const opened = f.win.DakiPersonalStyles.openEditor({id: 'personal_example'});
    f.reply({message: 'Synthetic load failure'}, 500); await opened;
    assert.equal(f.button('그림체 저장').disabled, true); assert.equal(f.button('취소').disabled, false);
    const retried = f.button('다시 불러오기').onclick(); f.reply({style: style()}); await retried;
    assert.equal(f.button('그림체 저장').disabled, false); assert.equal(f.field('positive').value, 'synthetic base');
});

test('late imports cannot replace a new dialog after leaving the previous view', async () => {
    const f = fixture(); const old = f.win.DakiPersonalStyles.openEditor({path: 'synthetic/old.png'});
    f.win.DakiPersonalStyles.leave(); await f.win.DakiPersonalStyles.openEditor();
    f.field('name').value = 'Current draft'; f.reply({style: style({name: 'Old result'})}); await old;
    assert.equal(f.field('name').value, 'Current draft'); assert.equal(f.doc.body.querySelectorAll('dialog').length, 1);
});

test('late library replies do not populate a different view and batch routes delegate unchanged', async () => {
    const f = fixture(); const loading = f.render(); f.win.DakiPersonalStyles.leave();
    f.reply({styles: [style()]}); await loading; assert.equal(f.content.children.length, 0); assert.equal(f.requests.length, 1);
    await f.render('library=personal&batch=example'); assert.equal(f.delegated.length, 1);
    assert.equal(f.delegated[0][0].get('batch'), 'example'); assert.equal(f.delegated[0][1], f.content);
});

test('saving on the current personal library refreshes its cards after explicit save', async () => {
    const f = fixture(); const initial = f.render(); f.reply({styles: []}); await flush(); f.reply({batches: []}); await initial;
    await f.button('＋ 개인 그림체').onclick(); f.field('name').value = 'New one'; f.field('positive').value = 'synthetic prompt';
    const save = f.submit(); f.reply({style: style()}); await flush();
    assert.equal(f.reply({styles: [style()]}).url, '/api/daki/personal-styles'); await flush(); f.reply({batches: []}); await save;
    assert.equal(f.content.querySelectorAll('.daki-personal-card').length, 1);
});

test('onSaved receives the saved style without navigation or library refresh', async () => {
    const f = fixture(); const initial = f.render(); f.reply({styles: []}); await flush(); f.reply({batches: []}); await initial;
    const savedStyles = [];
    await f.win.DakiPersonalStyles.openEditor({onSaved: saved => savedStyles.push(saved)});
    f.field('name').value = 'New one'; f.field('positive').value = 'synthetic prompt';
    const save = f.submit(); const saved = style(); f.reply({style: saved}); await save;
    assert.deepEqual(savedStyles, [saved]); assert.equal(f.pending.length, 0); assert.equal(f.requests.length, 3);
    assert.equal(f.win.location.hash, '#daki&library=personal'); assert.equal(f.content.querySelectorAll('.daki-personal-card').length, 0);
});
