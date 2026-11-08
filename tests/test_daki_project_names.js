const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'daki_project_names.js'), 'utf8');

class FakeElement {
    constructor(tagName, ownerDocument) {
        this.tagName = tagName.toUpperCase();
        this.ownerDocument = ownerDocument;
        this.children = [];
        this.parentNode = null;
        this.attributes = {};
        this.listeners = new Map();
        this.classes = new Set();
        this.classList = {
            add: name => this.classes.add(name),
            remove: name => this.classes.delete(name),
            contains: name => this.classes.has(name),
        };
        this.hidden = false;
        this.disabled = false;
        this.open = false;
        this.dataset = {};
        this.value = '';
        this._textContent = '';
    }
    get className() { return [...this.classes].join(' '); }
    set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
    get textContent() { return this._textContent + this.children.map(child => child.textContent).join(''); }
    set textContent(value) {
        this.children.forEach(child => { child.parentNode = null; });
        this.children = [];
        this._textContent = String(value ?? '');
    }
    get isConnected() {
        for (let node = this; node; node = node.parentNode) if (node.isDocumentRoot) return true;
        return false;
    }
    append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
    appendChild(node) {
        if (node.parentNode) {
            const index = node.parentNode.children.indexOf(node);
            if (index >= 0) node.parentNode.children.splice(index, 1);
        }
        node.parentNode = this;
        this.children.push(node);
        return node;
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener(type, callback) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(callback);
        this.listeners.set(type, listeners);
    }
    dispatch(type, event = {}) {
        const actual = {target: this, preventDefault() {}, ...event};
        return (this.listeners.get(type) || []).map(callback => callback(actual));
    }
    focus() { this.ownerDocument.activeElement = this; }
    select() { this.selected = true; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    querySelector(selector) {
        const className = selector.startsWith('.') ? selector.slice(1) : '';
        return descendants(this).find(node => node.classList.contains(className)) || null;
    }
}

function descendants(node) {
    return [node, ...node.children.flatMap(descendants)];
}

function fixture(fetchImpl = async () => response({status: 'success', project: {id: 'project'}})) {
    const doc = {
        activeElement: null,
        createElement(tagName) { return new FakeElement(tagName, doc); },
        getElementById(id) { return descendants(doc.body).find(node => node.id === id) || null; },
    };
    doc.body = new FakeElement('body', doc);
    doc.body.isDocumentRoot = true;
    const win = {document: doc, fetch: fetchImpl};
    const module = {exports: {}};
    vm.runInNewContext(source, {window: win, module}, {filename: 'daki_project_names.js'});
    return {api: module.exports, doc, win};
}

function response(result, status = 200) {
    return {ok: status >= 200 && status < 300, status, json: async () => result};
}

function byClass(root, className) {
    return descendants(root).find(node => node.classList.contains(className)) || null;
}

test('rename validation enforces canvas and image filename rules', () => {
    const {api} = fixture();
    assert.equal(api.validateName('새 이름', 'canvas', '이전'), '');
    assert.match(api.validateName('x'.repeat(121), 'canvas', '이전'), /120자/);
    assert.match(api.validateName('bad:name', 'canvas', '이전'), /사용할 수 없는/);
    assert.match(api.validateName('trailing.', 'canvas', '이전'), /끝날 수 없습니다/);
    assert.match(api.validateName('trailing ', 'canvas', '이전'), /끝날 수 없습니다/);
    assert.match(api.validateName('CON.txt', 'image', '기존.png'), /Windows에서/);
    assert.match(api.validateName('CONIN$', 'canvas', '이전'), /Windows에서/);
    assert.match(api.validateName('COM¹.txt', 'image', '기존.png'), /Windows에서/);
    assert.match(api.validateName('\ud800.png', 'image', '기존.png'), /유니코드/);
    assert.equal(api.validateName('새 파일.png', 'image', '기존.png'), '');
    assert.equal(api.validateName('새 파일.PNG', 'image', '기존.png'), '');
    assert.match(api.validateName('새 파일.jpg', 'image', '기존.png'), /확장자/);
    assert.match(api.validateName('x'.repeat(256) + '.png', 'image', '기존.png'), /255자/);
});

test('image rename PATCH keeps the extension, states linked-file behavior, and notifies the current page', async () => {
    const requests = [];
    const saved = [];
    const f = fixture(async (url, options) => {
        requests.push({url, options, body: JSON.parse(options.body)});
        return response({status: 'success', project: {id: 'project'} });
    });
    const button = f.api.createButton({projectId: 'project', itemId: 'candidate', name: '기존 그림.png', kind: 'image',
        isCurrent: () => true, onSaved: project => saved.push(project)});
    f.doc.body.appendChild(button);
    button.onclick();
    const dialog = byClass(f.doc.body, 'daki-project-name-dialog');
    const input = f.doc.getElementById('dakiProjectNameInput');
    const note = byClass(dialog, 'daki-project-name-note');
    assert.equal(dialog.open, true);
    assert.match(note.textContent, /실제 그림 파일/);
    assert.match(note.textContent, /같은 파일을 참조/);
    input.value = '새 그림.png';

    await byClass(dialog, 'daki-project-name-save').onclick();

    assert.equal(requests[0].url, '/api/daki/projects/project/candidates/candidate');
    assert.equal(requests[0].options.method, 'PATCH');
    assert.deepEqual(requests[0].body, {name: '새 그림.png', expectedName: '기존 그림.png'});
    assert.deepEqual(saved, [{id: 'project'}]);
    assert.equal(dialog.open, false);
});

test('server rename errors keep the typed draft visible in the modal', async () => {
    const f = fixture(async () => response({status: 'error', message: '같은 이름이 이미 있습니다.'}, 409));
    const button = f.api.createButton({projectId: 'project', itemId: 'canvas', name: '기존 캔버스', kind: 'canvas'});
    f.doc.body.appendChild(button);
    button.onclick();
    const dialog = byClass(f.doc.body, 'daki-project-name-dialog');
    const input = f.doc.getElementById('dakiProjectNameInput');
    input.value = '바꿀 이름';

    await byClass(dialog, 'daki-project-name-save').onclick();

    assert.equal(dialog.open, true);
    assert.equal(input.value, '바꿀 이름');
    assert.equal(byClass(dialog, 'daki-project-name-status').textContent, '같은 이름이 이미 있습니다.');
    assert.equal(byClass(dialog, 'daki-project-name-save').disabled, false);
});

test('pending saves block user cancellation and forced navigation ignores a late response', async () => {
    let release;
    let savedCount = 0;
    const f = fixture(() => new Promise(resolve => { release = resolve; }));
    const button = f.api.createButton({projectId: 'project', itemId: 'candidate', name: '기존.png', kind: 'image',
        isCurrent: () => true, onSaved: () => { savedCount += 1; }});
    f.doc.body.appendChild(button);
    button.onclick();
    const dialog = byClass(f.doc.body, 'daki-project-name-dialog');
    f.doc.getElementById('dakiProjectNameInput').value = '새 이름.png';
    const pending = byClass(dialog, 'daki-project-name-save').onclick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.api.close(), false);
    assert.equal(dialog.open, true);
    assert.equal(f.api.close(true), true);
    assert.equal(dialog.open, false);

    release(response({status: 'success', project: {id: 'project'}}));
    await pending;
    assert.equal(savedCount, 0);
});
