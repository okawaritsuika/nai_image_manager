const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
    class Element {
        constructor(tag) {
            this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.listeners = new Map();
            this.className = ''; this.hidden = false; this.open = false; this.value = ''; this.text = ''; this.disabled = false;
        }
        descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
        appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; return child; }
        append(...children) { children.forEach(child => this.appendChild(child)); }
        replaceChildren(...children) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.text = ''; this.append(...children); }
        remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
        set textContent(value) { this.replaceChildren(); this.text = String(value); }
        get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
        setAttribute(name, value) { this.attributes[name] = String(value); }
        addEventListener(name, callback) { this.listeners.set(name, callback); }
        showModal() { this.open = true; }
        close() { this.open = false; this.listeners.get('close')?.(); }
        focus() { doc.activeElement = this; }
        get isConnected() { return !!this.parentNode; }
        querySelectorAll(selector) { return this.descendants().filter(el => selector.split(',').some(part => {
            const query = part.trim();
            return query.startsWith('.') ? el.className.split(' ').includes(query.slice(1)) : el.tagName === query.toUpperCase();
        })); }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    }
    const doc = {body: new Element('body'), createElement: tag => new Element(tag)};
    const requests = [], pending = [], editorOptions = [];
    const win = {document: doc, DakiPersonalStyles: {openEditor: options => editorOptions.push(options)},
        fetch(url, options) {
            const request = {url, method: options.method, body: options.body && JSON.parse(options.body)};
            requests.push(request); return new Promise(resolve => pending.push({request, resolve}));
        }};
    vm.runInNewContext(fs.readFileSync(require.resolve('../static/daki_test_library.js'), 'utf8'), {window: win});
    function reply(data, status = 200, url) {
        const index = url ? pending.findIndex(entry => entry.request.url === url) : 0;
        assert.ok(index >= 0 && pending[index], 'Expected API request');
        const entry = pending.splice(index, 1)[0];
        entry.resolve({ok: status < 400, json: async () => ({status: status < 400 ? 'success' : 'error', ...data})});
        return entry.request;
    }
    return {win, doc, requests, pending, editorOptions, reply,
        dialog: () => doc.body.querySelector('dialog'),
        button(text) { const found = doc.body.querySelectorAll('button').find(button => button.textContent === text); assert.ok(found, text); return found; },
        submit() { return doc.body.querySelector('form').onsubmit({preventDefault() {}}); },
        search(text) { const input = doc.body.querySelectorAll('input').find(input => input.type === 'search'); input.value = text; input.oninput(); },
        choose(name, value = true) { const input = doc.body.querySelectorAll('input').find(input => input.attributes['aria-label'] === name + ' 선택'); assert.ok(input, name); input.checked = value; input.onchange(); },
        cards: () => doc.body.querySelectorAll('.daki-test-style-choice'),
    };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const batch = {id: 'test-example', name: 'Portrait test', items: [{style_id: 'included'}]};
const shared = [{id: 'included', name: 'Existing'}, {id: 'shared-one', name: 'Blue shared', src: '/synthetic/blue.png'},
    {id: 'shared-two', name: 'Green shared', src: '/synthetic/green.png'}];
const personal = [{id: 'personal-one', name: 'Blue personal'}, {id: 'personal-two', name: 'Other personal', src: '/synthetic/other.png'}];
async function load(f, values = personal) { f.reply({styles: shared}); f.reply({styles: values}); await flush(); }

test('rename validates and trims the name, saves only the name and returns the updated batch', async () => {
    const f = fixture(), saved = [];
    f.win.DakiTestLibrary.rename(batch, value => saved.push(value));
    const input = f.doc.body.querySelector('input'); assert.equal(input.maxLength, 120); assert.equal(input.required, true);
    input.value = ' '; await f.submit(); assert.equal(f.requests.length, 0);
    input.value = '  New portrait name  ';
    const pending = f.submit(); await f.submit(); assert.equal(f.requests.length, 1);
    assert.deepEqual(f.reply({batch: {...batch, name: 'New portrait name'}}),
        {url: '/api/daki/style-tests/test-example/name', method: 'PUT', body: {name: 'New portrait name'}});
    await pending;
    assert.equal(saved[0].name, 'New portrait name'); assert.equal(f.dialog(), null); assert.equal(batch.name, 'Portrait test');
});

test('failed rename preserves the draft and re-enables saving', async () => {
    const f = fixture(); f.win.DakiTestLibrary.rename(batch);
    f.doc.body.querySelector('input').value = 'Try again'; const pending = f.submit();
    f.reply({message: 'Synthetic failure'}, 500); await pending;
    assert.equal(f.doc.body.querySelector('input').value, 'Try again'); assert.equal(f.button('이름 저장').disabled, false);
    assert.match(f.dialog().textContent, /Synthetic failure/);
});

test('append loads both libraries, omits existing styles, preserves filtered selections and only queues new ids', async () => {
    const f = fixture(), saved = [];
    f.win.DakiTestLibrary.append(batch, value => saved.push(value));
    assert.deepEqual(f.requests.map(request => request.url), ['/api/daki/shared-styles', '/api/daki/personal-styles']);
    f.search('blue'); await load(f);
    assert.equal(f.cards().length, 2); assert.match(f.cards()[0].textContent, /공유 그림체/); assert.match(f.cards()[1].textContent, /개인 그림체/);
    assert.match(f.cards()[1].textContent, /대표 그림 없음/);
    f.button('표시 항목 전체 선택').onclick(); f.search('green'); f.choose('Green shared');
    const pending = f.submit();
    const request = f.reply({batch: {...batch, items: [...batch.items, {style_id: 'shared-one', status: 'pending'}]}}); await pending;
    assert.deepEqual(request, {url: '/api/daki/style-tests/test-example/styles', method: 'POST',
        body: {style_ids: ['shared-one', 'personal-one', 'shared-two']}});
    assert.equal(saved.length, 1); assert.equal(f.dialog(), null);
    assert.equal(f.requests.some(request => request.url.endsWith('/run')), false);
});

test('new personal styles refresh the candidates and are selected without starting generation', async () => {
    const f = fixture(); f.win.DakiTestLibrary.append(batch); await load(f);
    f.search('green'); f.button('＋ 새 개인 그림체').onclick(); assert.equal(f.editorOptions.length, 1);
    const saved = f.editorOptions[0].onSaved({id: 'personal-new'});
    await load(f, [...personal, {id: 'personal-new', name: 'New personal'}]); await saved;
    assert.equal(f.cards().length, 5);
    const checkbox = f.doc.body.querySelectorAll('input').find(input => input.attributes['aria-label'] === 'New personal 선택');
    assert.equal(checkbox.checked, true); assert.equal(f.button('선택한 그림체 추가').disabled, false);
    assert.equal(f.requests.length, 4);
});

test('both catalog failures disable submission until retry succeeds and request errors keep the selection', async () => {
    const f = fixture(); f.win.DakiTestLibrary.append(batch);
    f.reply({message: 'Synthetic shared failure'}, 500); f.reply({message: 'Synthetic personal failure'}, 500); await flush();
    assert.equal(f.button('선택한 그림체 추가').disabled, true); assert.equal(f.button('다시 불러오기').hidden, false);
    assert.equal(f.cards().length, 0); assert.match(f.dialog().textContent, /공유 그림체 목록/); assert.match(f.dialog().textContent, /개인 그림체 목록/);
    await f.submit(); assert.equal(f.requests.length, 2);
    const retried = f.button('다시 불러오기').onclick(); await load(f); await retried;
    f.choose('Blue shared'); const pending = f.submit(); f.reply({message: 'Synthetic conflict'}, 409); await pending;
    assert.equal(f.dialog().open, true); assert.equal(f.button('선택한 그림체 추가').disabled, false);
    assert.equal(f.doc.body.querySelectorAll('input').find(input => input.attributes['aria-label'] === 'Blue shared 선택').checked, true);
});

test('one unavailable catalog preserves successful choices and excludes failed-source selections on refresh', async () => {
    const f = fixture(); f.win.DakiTestLibrary.append(batch); await load(f);
    f.choose('Blue shared'); f.choose('Blue personal');
    const refreshed = f.button('다시 불러오기').onclick();
    f.reply({message: 'Shared unavailable'}, 500); f.reply({styles: personal}); await refreshed;
    assert.equal(f.cards().length, 2); assert.match(f.dialog().textContent, /공유 그림체 목록을 불러오지 못했습니다/);
    assert.equal(f.button('다시 불러오기').hidden, false);
    assert.equal(f.doc.body.querySelectorAll('input').find(input => input.attributes['aria-label'] === 'Blue personal 선택').checked, true);
    const pending = f.submit(); const request = f.reply({batch}); await pending;
    assert.deepEqual(request.body, {style_ids: ['personal-one']});
});

test('shared choices remain usable when the personal catalog is unavailable', async () => {
    const f = fixture(); f.win.DakiTestLibrary.append(batch);
    f.reply({styles: shared}); f.reply({message: 'Personal unavailable'}, 500); await flush();
    assert.equal(f.cards().length, 2); assert.match(f.dialog().textContent, /개인 그림체 목록을 불러오지 못했습니다/);
    f.choose('Green shared'); assert.equal(f.button('선택한 그림체 추가').disabled, false);
    const pending = f.submit(); const request = f.reply({batch}); await pending;
    assert.deepEqual(request.body, {style_ids: ['shared-two']});
});

test('a newly saved personal style is selected while the shared catalog stays unavailable', async () => {
    const f = fixture(); f.win.DakiTestLibrary.append(batch);
    f.reply({message: 'Shared unavailable'}, 500); f.reply({styles: personal}); await flush();
    f.button('＋ 새 개인 그림체').onclick();
    const refreshed = f.editorOptions[0].onSaved({id: 'personal-new'});
    f.reply({message: 'Shared unavailable'}, 500); f.reply({styles: [...personal, {id: 'personal-new', name: 'New personal'}]}); await refreshed;
    assert.equal(f.cards().length, 3); assert.equal(f.button('선택한 그림체 추가').disabled, false);
    const pending = f.submit(); const request = f.reply({batch}); await pending;
    assert.deepEqual(request.body, {style_ids: ['personal-new']});
});

test('late catalog and save replies cannot populate or close a newer dialog', async () => {
    const f = fixture(), saved = [];
    f.win.DakiTestLibrary.append(batch); f.win.DakiTestLibrary.leave();
    f.win.DakiTestLibrary.rename(batch, value => saved.push(value)); const current = f.dialog();
    await load(f); assert.equal(f.cards().length, 0); assert.equal(f.dialog(), current);
    f.doc.body.querySelector('input').value = 'Late name'; const pending = f.submit();
    f.win.DakiTestLibrary.leave(); f.win.DakiTestLibrary.rename(batch); const replacement = f.dialog();
    f.reply({batch: {...batch, name: 'Late name'}}); await pending;
    assert.equal(f.dialog(), replacement); assert.equal(saved.length, 0);
});

test('closing the append dialog ignores later personal-editor callbacks', async () => {
    const f = fixture(); f.win.DakiTestLibrary.append(batch); await load(f);
    f.button('＋ 새 개인 그림체').onclick(); f.button('취소').onclick();
    await f.editorOptions[0].onSaved({id: 'new'});
    assert.equal(f.requests.length, 2); assert.equal(f.dialog(), null);
});
