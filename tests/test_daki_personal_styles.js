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
        getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
        addEventListener(name, callback) {
            const callbacks = this.listeners.get(name) || []; callbacks.push(callback); this.listeners.set(name, callbacks);
        }
        emit(name, event = {}) { (this.listeners.get(name) || []).forEach(callback => callback(event)); }
        showModal() { this.open = true; }
        close() { this.open = false; (this.listeners.get('close') || []).forEach(callback => callback()); }
        focus() { doc.activeElement = this; }
        get isConnected() { return !!this.parentNode; }
        matches(selector) {
            if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
            if (selector.startsWith('#')) return this.id === selector.slice(1);
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
function confirmedStyle(overrides = {}) {
    return {id: 31, name: 'Confirmed synthetic', model: 'nai-diffusion-5-full', positive: 'source prompt', negative: '',
        preview: {width: 832, height: 1216}, src: '/api/daki/confirmed-styles/31/preview', ...overrides};
}
async function loadedLibrary(f, styles = [style()]) {
    const loaded = f.render(); f.reply({styles}); await flush(); f.reply({batches: []}); await loaded;
}
function picker(f) { return f.doc.body.querySelectorAll('dialog').find(dialog => dialog.className.includes('daki-personal-picker-dialog')); }
function deleteDialog(f) { return f.doc.body.querySelectorAll('dialog').find(dialog => dialog.className.includes('daki-project-delete-dialog')); }

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
    assert.deepEqual(request.body.preview, {width: 832, height: 1216});
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
    f.field('name').value = 'Retried edit'; const save = f.submit();
    const request = f.reply({style: style({name: 'Retried edit'})}); await save;
    assert.equal(request.method, 'PUT'); assert.equal(request.url, '/api/daki/personal-styles/personal_example');
    assert.equal(request.body.name, 'Retried edit');
});

test('failed edit load stays unsaveable after trial and source import attempts', async () => {
    const f = fixture(); const opened = f.win.DakiPersonalStyles.openEditor({id: 'personal_example'});
    f.reply({message: 'Synthetic load failure'}, 500); await opened;
    f.field('positive').value = 'synthetic trial prompt';

    const failedTrial = f.button('시안 생성').onclick();
    f.reply({message: 'Synthetic trial failure'}, 502); await failedTrial;
    assert.equal(f.button('그림체 저장').disabled, true);
    const afterFailedTrial = f.requests.length;
    await f.submit();
    assert.equal(f.requests.length, afterFailedTrial);

    const successfulTrial = f.button('시안 생성').onclick();
    f.reply({image: 'data:image/png;base64,synthetic'}); await successfulTrial;
    assert.equal(f.button('그림체 저장').disabled, true);
    const afterSuccessfulTrial = f.requests.length;
    await f.submit();
    assert.equal(f.requests.length, afterSuccessfulTrial);

    f.field('source_path').value = 'synthetic/import.png';
    const failedImport = f.button('이 그림에서 가져오기').onclick();
    f.reply({message: 'Synthetic import failure'}, 502); await failedImport;
    assert.equal(f.button('그림체 저장').disabled, true);
    const afterFailedImport = f.requests.length;
    await f.submit();
    assert.equal(f.requests.length, afterFailedImport);

    const successfulImport = f.button('이 그림에서 가져오기').onclick();
    f.reply({style: style({source_path: 'synthetic/import.png', positive: 'imported prompt'})}); await successfulImport;
    assert.equal(f.field('positive').value, 'imported prompt');
    assert.equal(f.button('그림체 저장').disabled, true);
    const afterSuccessfulImport = f.requests.length;
    await f.submit();
    assert.equal(f.requests.length, afterSuccessfulImport);
    assert.equal(f.requests.filter(request => request.method === 'PUT').length, 0);
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

test('confirmed styles are copied by id as an independent personal style and the current library refreshes', async () => {
    const f = fixture(); await loadedLibrary(f, []);
    f.button('확정 그림체 가져오기').onclick();
    assert.equal(f.requests.at(-1).url, '/api/daki/confirmed-styles');
    assert.equal(picker(f).getAttribute('aria-labelledby'), 'dakiPersonalPickerTitle');
    assert.match(picker(f).querySelector('.daki-personal-status').textContent, /불러오는 중/);
    const source = confirmedStyle(); f.reply({styles: [source]}); await flush();
    const dialog = picker(f), choice = dialog.querySelector('.daki-personal-picker-choice');
    assert.equal(choice.querySelector('img').src, source.src);
    assert.equal(choice.textContent.includes(source.name), true);
    assert.equal(choice.textContent.includes('NovelAI V5 Full'), true);
    choice.onclick();
    const copying = f.button('개인 그림체로 복사').onclick();
    const request = f.requests.at(-1);
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/daki/personal-styles/import-confirmed');
    assert.deepEqual(request.body, {style_id: 31});
    assert.equal(source.name, 'Confirmed synthetic');
    f.reply({style: style({id: 'personal_copy', name: source.name})}, 201); await flush();
    f.reply({styles: [style({id: 'personal_copy', name: source.name})]}); await flush();
    f.reply({batches: []}); await copying;
    assert.equal(picker(f), undefined);
    assert.equal(f.content.querySelectorAll('.daki-personal-card').length, 1);
    assert.equal(f.bindings.includes('__daki_personal__/personal_copy.png'), true);
});

test('confirmed picker reveals further same-name styles and copies the selected ID without requesting a missing preview', async () => {
    const f = fixture(); await loadedLibrary(f, []);
    f.button('확정 그림체 가져오기').onclick();
    const styles = Array.from({length: 61}, (_, index) => confirmedStyle({id: 1000 + index, name: 'Same synthetic name', src: ''}));
    f.reply({styles}); await flush();
    const dialog = picker(f), search = dialog.querySelector('input');
    search.value = 'same synthetic name'; search.oninput();
    assert.equal(dialog.querySelectorAll('.daki-personal-picker-choice').length, 60);
    const first = dialog.querySelector('.daki-personal-picker-choice');
    assert.equal(first.querySelector('img'), null);
    assert.equal(first.querySelector('.daki-personal-picker-placeholder').textContent, '대표 그림 없음');
    const more = f.button('더 보기'); assert.equal(more.hidden, false);
    more.onclick();
    const choices = dialog.querySelectorAll('.daki-personal-picker-choice');
    assert.equal(choices.length, 61); assert.equal(more.hidden, true);
    choices.at(-1).onclick();
    const copying = f.button('개인 그림체로 복사').onclick();
    assert.deepEqual(f.requests.at(-1).body, {style_id: 1060});
    f.reply({style: style({id: 'personal_last', name: 'Same synthetic name'})}, 201); await flush();
    f.reply({styles: [style({id: 'personal_last', name: 'Same synthetic name'})]}); await flush();
    f.reply({batches: []}); await copying;
});

test('confirmed picker shows loading, retries list errors, and reports an empty catalog', async () => {
    const f = fixture(); await loadedLibrary(f, []);
    f.button('확정 그림체 가져오기').onclick();
    assert.match(picker(f).querySelector('.daki-personal-status').textContent, /불러오는 중/);
    f.reply({message: 'Synthetic catalog error'}, 500); await flush();
    assert.match(picker(f).querySelector('.daki-personal-status').textContent, /Synthetic catalog error/);
    const retry = f.button('다시 불러오기').onclick();
    f.reply({styles: []}); await retry;
    assert.match(picker(f).querySelector('.daki-personal-status').textContent, /가져올 확정 그림체가 없습니다/);
    f.button('취소').onclick();
    assert.equal(picker(f), undefined);
});

test('failed confirmed copy can retry; canceling during retry ignores its late success', async () => {
    const f = fixture(); await loadedLibrary(f, []);
    f.button('확정 그림체 가져오기').onclick(); f.reply({styles: [confirmedStyle()]}); await flush();
    picker(f).querySelector('.daki-personal-picker-choice').onclick();
    const failed = f.button('개인 그림체로 복사').onclick();
    f.reply({message: 'Synthetic copy error'}, 500); await failed;
    assert.equal(picker(f).open, true);
    assert.match(picker(f).querySelector('.daki-personal-status').textContent, /Synthetic copy error/);
    const retry = f.button('개인 그림체로 복사').onclick();
    assert.equal(f.requests.at(-1).method, 'POST');
    f.button('취소').onclick();
    assert.equal(picker(f), undefined);
    const requestCount = f.requests.length;
    f.reply({style: style({id: 'late_copy'})}, 201); await retry;
    assert.equal(f.requests.length, requestCount);
    assert.equal(f.content.querySelectorAll('.daki-personal-card').length, 0);
});

test('confirmed picker closes on leave and a late catalog response cannot open or populate a new view', async () => {
    const f = fixture(); await loadedLibrary(f, []);
    f.button('확정 그림체 가져오기').onclick();
    f.win.DakiPersonalStyles.leave();
    assert.equal(picker(f), undefined);
    const next = f.render();
    f.reply({styles: [confirmedStyle()]}); await flush();
    f.reply({styles: [style({id: 'new_view'})]}); await flush();
    f.reply({batches: []}); await next;
    assert.equal(f.content.querySelectorAll('.daki-personal-card').length, 1);
    assert.equal(f.content.querySelectorAll('.daki-personal-picker-choice').length, 0);
});

test('personal style delete confirmation uses safe text, supports Escape and backdrop cancellation, and restores focus', async () => {
    const f = fixture(); await loadedLibrary(f, [style({name: '<Synthetic style>'})]);
    const opener = f.button('그림체 삭제'); opener.focus(); opener.onclick();
    let dialog = deleteDialog(f);
    assert.equal(dialog.getAttribute('aria-labelledby'), 'dakiPersonalDeleteTitle');
    assert.equal(dialog.querySelector('#dakiPersonalDeleteTitle').textContent, '개인 그림체를 삭제할까요?');
    assert.equal(dialog.querySelector('.daki-project-delete-title').textContent, '개인 그림체를 삭제할까요?');
    assert.equal(dialog.querySelector('.daki-project-delete-name').textContent, '<Synthetic style>');
    assert.match(dialog.querySelector('.daki-project-delete-description').textContent, /원본.*유지됩니다/);
    assert.equal(f.doc.activeElement.textContent, '취소');
    let prevented = false;
    dialog.emit('cancel', {preventDefault() { prevented = true; }});
    assert.equal(prevented, true);
    assert.equal(deleteDialog(f), undefined);
    assert.equal(f.doc.activeElement, opener);
    assert.equal(f.requests.filter(request => request.method === 'DELETE').length, 0);

    opener.onclick(); dialog = deleteDialog(f);
    dialog.getBoundingClientRect = () => ({left: 10, right: 400, top: 10, bottom: 500});
    dialog.emit('click', {target: dialog, clientX: 5, clientY: 200});
    assert.equal(deleteDialog(f), undefined);
    assert.equal(f.doc.activeElement, opener);
});

test('personal style delete succeeds once, disables all modal controls while pending, then refreshes', async () => {
    const f = fixture(); await loadedLibrary(f, [style()]);
    const opener = f.button('그림체 삭제'); opener.onclick();
    const dialog = deleteDialog(f), confirm = dialog.querySelector('.daki-project-delete-confirm');
    const removing = confirm.onclick();
    assert.equal(f.requests.at(-1).method, 'DELETE');
    assert.equal(f.requests.at(-1).url, '/api/daki/personal-styles/personal_example');
    assert.equal(dialog.querySelector('.daki-project-delete-close').disabled, true);
    assert.equal(dialog.querySelector('.daki-project-delete-cancel').disabled, true);
    assert.equal(confirm.disabled, true);
    confirm.onclick();
    assert.equal(f.requests.filter(request => request.method === 'DELETE').length, 1);
    f.reply({}); await flush();
    f.reply({styles: []}); await flush(); f.reply({batches: []}); await removing;
    assert.equal(deleteDialog(f), undefined);
    assert.equal(f.content.querySelectorAll('.daki-personal-card').length, 0);
});

test('personal style delete failure stays in the dialog and can be retried', async () => {
    const f = fixture(); await loadedLibrary(f, [style()]);
    f.button('그림체 삭제').onclick();
    const dialog = deleteDialog(f), confirm = dialog.querySelector('.daki-project-delete-confirm');
    const failed = confirm.onclick(); f.reply({message: 'Synthetic delete error'}, 500); await failed;
    assert.equal(dialog.open, true);
    assert.match(dialog.querySelector('.daki-personal-status').textContent, /Synthetic delete error/);
    assert.equal(confirm.disabled, false);
    const retry = confirm.onclick(); f.reply({}); await flush();
    f.reply({styles: []}); await flush(); f.reply({batches: []}); await retry;
    assert.equal(f.content.querySelectorAll('.daki-personal-card').length, 0);
});

test('leaving during personal style deletion closes the dialog and ignores its late response', async () => {
    const f = fixture(); await loadedLibrary(f, [style()]);
    f.button('그림체 삭제').onclick();
    const removing = deleteDialog(f).querySelector('.daki-project-delete-confirm').onclick();
    f.win.DakiPersonalStyles.leave();
    assert.equal(deleteDialog(f), undefined);
    f.content.replaceChildren();
    const next = f.render();
    f.reply({}); await removing;
    f.reply({styles: [style({id: 'still_visible'})]}); await flush();
    f.reply({batches: []}); await next;
    assert.equal(f.content.querySelectorAll('.daki-personal-card').length, 1);
    assert.equal(f.content.querySelectorAll('.daki-project-delete-dialog').length, 0);
});


test('trial generation is disposable and only explicitly selected image is saved', async () => {
    const f = fixture(); await f.win.DakiPersonalStyles.openEditor();
    f.field('positive').value = 'ink'; f.field('negative').value = 'blur';
    f.field('prompt').value = 'portrait'; f.field('negative_prompt').value = 'hat';
    f.field('width').value = '1024'; f.field('height').value = '1024';
    const generating = f.button('시안 생성').onclick();
    const generated = f.reply({image: 'data:image/png;base64,synthetic'}); await generating;
    assert.equal(generated.url, '/api/daki/personal-styles/generate');
    assert.equal(generated.body.prompt, 'portrait'); assert.equal(generated.body.positive, 'ink');
    assert.equal(generated.body.width, 1024); assert.equal(f.requests.length, 1);
    f.button('대표 그림으로 사용').onclick(); f.field('name').value = 'Trial style';
    const saving = f.submit(); const saved = f.reply({style: style()}); await saving;
    assert.equal(saved.body.representative_image, 'data:image/png;base64,synthetic');
    assert.equal(saved.body.positive, 'ink'); assert.equal(saved.body.negative, 'blur');
    assert.equal('prompt' in saved.body, false); assert.equal('width' in saved.body, false);
    assert.deepEqual(saved.body.preview, {width: 832, height: 1216});
});

test('unselected trial is not saved and failure permits retry', async () => {
    const f = fixture(); await f.win.DakiPersonalStyles.openEditor();
    f.field('positive').value = 'ink'; f.field('name').value = 'Trial';
    const failed = f.button('시안 생성').onclick(); f.reply({message: 'Synthetic failure'}, 502); await failed;
    assert.equal(f.button('시안 생성').disabled, false);
    const retry = f.button('시안 생성').onclick(); f.reply({image: 'data:image/png;base64,trial'}); await retry;
    const saving = f.submit(); const saved = f.reply({style: style()}); await saving;
    assert.equal('representative_image' in saved.body, false);
});

test('paid trial requires confirmation and duplicate generation is suppressed', async () => {
    const f = fixture(); await f.win.DakiPersonalStyles.openEditor(); f.field('positive').value = 'ink';
    f.field('steps').value = '29'; let warnings = 0;
    f.win.showAnlasWarningModal = async () => { warnings++; return false; };
    await f.button('시안 생성').onclick(); assert.equal(f.requests.length, 0); assert.equal(warnings, 1);
    f.win.showAnlasWarningModal = async () => true;
    const generating = f.button('시안 생성').onclick(); await flush();
    await f.button('시안 생성').onclick(); assert.equal(f.requests.length, 1);
    const request = f.reply({image: 'data:image/png;base64,trial'}); await generating;
    assert.equal(request.body.allow_anlas, true);
});
