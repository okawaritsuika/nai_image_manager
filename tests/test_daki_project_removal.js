const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../static/daki_project_removal.js'), 'utf8');

class Element {
    constructor(tagName = '') {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.attributes = {};
        this.listeners = new Map();
        this.classes = new Set();
        this.classList = {
            add: name => this.classes.add(name),
            remove: name => this.classes.delete(name),
            contains: name => this.classes.has(name),
            toggle: (name, force) => {
                const enabled = force === undefined ? !this.classes.has(name) : Boolean(force);
                if (enabled) this.classes.add(name); else this.classes.delete(name);
                return enabled;
            },
        };
        this.open = false;
        this.disabled = false;
        this.hidden = false;
        this.checked = false;
        this.textContent = '';
    }
    set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
    get isConnected() {
        for (let node = this; node; node = node.parentNode) if (node.isDocumentRoot) return true;
        return false;
    }
    appendChild(node) {
        if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1);
        node.parentNode = this;
        this.children.push(node);
        return node;
    }
    append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
    replaceChildren(...nodes) {
        this.children.forEach(node => { node.parentNode = null; });
        this.children = [];
        this.append(...nodes);
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(type, handler) { this.listeners.set(type, handler); }
    dispatch(type, event = {}) { this.listeners.get(type)?.({target: this, preventDefault() {}, stopPropagation() {}, ...event}); }
    focus(options) { this.focusOptions = options; this.ownerDocument.activeElement = this; }
    showModal() { this.open = true; }
    close() {
        const wasOpen = this.open;
        this.open = false;
        if (wasOpen) this.listeners.get('close')?.({target: this});
    }
    getBoundingClientRect() { return {left: 100, top: 100, right: 600, bottom: 700}; }
}

function fixture(fetchImpl) {
    const body = new Element('body');
    body.isDocumentRoot = true;
    const doc = {body, activeElement: null, createElement: tag => {
        const node = new Element(tag);
        node.ownerDocument = doc;
        return node;
    }};
    const win = {document: doc, fetch: fetchImpl};
    vm.runInNewContext(source, {window: win});
    const api = win.DakiProjectRemoval;
    const project = {
        id: 'a/b project',
        name: '<img src=x onerror=alert(1)> 긴 프로젝트',
        candidates: {front: [{id: 'f'}], back: [{id: 'b'}, {id: 'b2'}]},
        canvases: {front: [{id: 'c'}], back: []},
    };
    let current = true;
    const callbacks = [];
    const button = api.createButton({project, isCurrent: () => current, onDeleted: value => callbacks.push(value)});
    body.appendChild(button);
    const dialog = () => descendants(body).find(node => node.classList.contains('daki-project-removal-dialog'));
    return {api, body, doc, project, callbacks, button, dialog, setCurrent: value => { current = value; }};
}

function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }
function classed(node, name) { return descendants(node).find(child => child.classList.contains(name)); }
function pendingFetches() {
    const requests = [];
    return {
        requests,
        fetch: (url, options) => new Promise((resolve, reject) => requests.push({url, options, resolve, reject})),
    };
}
function response(status, result) {
    return {status, ok: status >= 200 && status < 300, json: async () => result};
}
function click(handler) {
    let prevented = false;
    let stopped = false;
    handler({preventDefault() { prevented = true; }, stopPropagation() { stopped = true; }});
    return {prevented, stopped};
}
async function flush() { await new Promise(resolve => setImmediate(resolve)); }
function open(f) { click(f.button.onclick); return f.dialog(); }

test('cancel closes without a request and restores focus to the opener', () => {
    const network = pendingFetches();
    const f = fixture(network.fetch);
    const event = click(f.button.onclick);
    assert.deepEqual(event, {prevented: true, stopped: true});
    const dialog = f.dialog();
    assert.equal(dialog.open, true);
    assert.equal(classed(dialog, 'daki-project-removal-name').textContent, f.project.name);
    assert.equal(classed(dialog, 'daki-project-removal-stat').textContent, '등록 그림 3');
    assert.equal(classed(dialog, 'daki-project-removal-stat').parentNode.children[1].textContent, '편집 캔버스 1');
    click(classed(dialog, 'daki-project-removal-cancel').onclick);
    assert.equal(dialog.open, false);
    assert.equal(network.requests.length, 0);
    assert.equal(f.doc.activeElement, f.button);
});

test('archive is the default and submits the encoded project id and archive payload', async () => {
    const network = pendingFetches();
    const f = fixture(network.fetch);
    const dialog = open(f);
    click(classed(dialog, 'daki-project-removal-confirm').onclick);
    assert.equal(network.requests.length, 1);
    const request = network.requests[0];
    assert.equal(request.url, '/api/daki/projects/a%2Fb%20project/delete');
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(request.options.body), {action: 'archive', confirm_daki: false});
    assert.equal(classed(dialog, 'daki-project-removal-close').disabled, true);
    request.resolve(response(200, {status: 'success', project_id: 'a/b project', action: 'archive'}));
    await flush();
    assert.equal(dialog.open, false);
    assert.equal(f.callbacks.length, 1);
    assert.equal(f.callbacks[0].action, 'archive');
});

test('delete action sends delete payload and keeps project names as text', async () => {
    const network = pendingFetches();
    const f = fixture(network.fetch);
    const dialog = open(f);
    const name = classed(dialog, 'daki-project-removal-name');
    assert.equal(name.textContent, '<img src=x onerror=alert(1)> 긴 프로젝트');
    assert.equal(name.children.length, 0);
    const deleteRadio = descendants(dialog).find(node => node.tagName === 'INPUT' && node.value === 'delete');
    deleteRadio.checked = true;
    deleteRadio.dispatch('change');
    click(classed(dialog, 'daki-project-removal-confirm').onclick);
    assert.deepEqual(JSON.parse(network.requests[0].options.body), {action: 'delete', confirm_daki: false});
    network.requests[0].resolve(response(200, {status: 'success', project_id: 'a/b project', action: 'delete'}));
    await flush();
    assert.equal(f.callbacks[0].action, 'delete');
});

test('action changes update the confirmation label immediately', () => {
    const network = pendingFetches();
    const f = fixture(network.fetch);
    const dialog = open(f);
    const confirm = classed(dialog, 'daki-project-removal-confirm');
    const archive = descendants(dialog).find(node => node.tagName === 'INPUT' && node.value === 'archive');
    const remove = descendants(dialog).find(node => node.tagName === 'INPUT' && node.value === 'delete');
    assert.equal(confirm.children[0].textContent, '보관하고 삭제');
    archive.checked = false;
    remove.checked = true;
    remove.dispatch('change');
    assert.equal(confirm.children[0].textContent, '그림까지 삭제');
    archive.checked = true;
    remove.checked = false;
    archive.dispatch('change');
    assert.equal(confirm.children[0].textContent, '보관하고 삭제');
    assert.match(classed(dialog, 'daki-project-removal-settings-note').textContent, /공유·개인 그림체 라이브러리 원본은 유지됩니다\./);
});

test('a reference conflict requires a fresh checkbox confirmation before retry', async () => {
    const network = pendingFetches();
    const f = fixture(network.fetch);
    const dialog = open(f);
    click(classed(dialog, 'daki-project-removal-confirm').onclick);
    const references = Array.from({length: 11}, (_, index) => ({
        project_name: `연결 ${index}`, side: index % 2 ? 'back' : 'front', path: `C:/gallery/${index}.png`,
    }));
    network.requests[0].resolve(response(409, {status: 'error', code: 'daki_references', message: '<b>연결 경고</b>', references}));
    await flush();
    const warning = classed(dialog, 'daki-project-removal-reference-warning');
    assert.equal(warning.hidden, false);
    assert.equal(classed(dialog, 'daki-project-removal-reference-list').children.length, 10);
    assert.equal(classed(dialog, 'daki-project-removal-reference-count').textContent, '외 1개 연결');
    assert.equal(classed(dialog, 'daki-project-removal-status').textContent, '<b>연결 경고</b>');
    const confirm = classed(dialog, 'daki-project-removal-confirm');
    assert.equal(confirm.disabled, true);
    click(confirm.onclick);
    assert.equal(network.requests.length, 1, 'no implicit or unchecked retry');

    const checkbox = descendants(dialog).find(node => node.tagName === 'INPUT' && node.type === 'checkbox');
    checkbox.checked = true;
    checkbox.dispatch('change');
    assert.equal(confirm.disabled, false);
    click(confirm.onclick);
    assert.equal(network.requests.length, 2);
    assert.deepEqual(JSON.parse(network.requests[1].options.body), {action: 'archive', confirm_daki: true});
    network.requests[1].resolve(response(200, {status: 'success', project_id: 'a/b project', action: 'archive'}));
    await flush();
    assert.equal(f.callbacks.length, 1);
});

test('switching from a reference-conflicted delete to archive clears confirmation; delete asks the server again', async () => {
    const network = pendingFetches();
    const f = fixture(network.fetch);
    const dialog = open(f);
    const confirm = classed(dialog, 'daki-project-removal-confirm');
    const archive = descendants(dialog).find(node => node.tagName === 'INPUT' && node.value === 'archive');
    const remove = descendants(dialog).find(node => node.tagName === 'INPUT' && node.value === 'delete');
    remove.checked = true;
    archive.checked = false;
    remove.dispatch('change');
    click(confirm.onclick);
    network.requests[0].resolve(response(409, {
        status: 'error', code: 'daki_references', references: [{project_name: 'Linked', side: 'front', path: 'linked.png'}],
    }));
    await flush();
    assert.equal(confirm.disabled, true);

    archive.checked = true;
    remove.checked = false;
    archive.dispatch('change');
    assert.equal(classed(dialog, 'daki-project-removal-reference-warning').hidden, true);
    assert.equal(confirm.disabled, false);
    assert.equal(confirm.children[0].textContent, '보관하고 삭제');

    remove.checked = true;
    archive.checked = false;
    remove.dispatch('change');
    assert.equal(confirm.children[0].textContent, '그림까지 삭제');
    click(confirm.onclick);
    assert.equal(network.requests.length, 2);
    assert.deepEqual(JSON.parse(network.requests[1].options.body), {action: 'delete', confirm_daki: false});
    network.requests[1].resolve(response(409, {
        status: 'error', code: 'daki_references', references: [{project_name: 'Linked', side: 'front', path: 'linked.png'}],
    }));
    await flush();
    assert.equal(classed(dialog, 'daki-project-removal-reference-warning').hidden, false);
    assert.equal(confirm.disabled, true);
});

test('network failure leaves the dialog open with text-only feedback and allows retry', async () => {
    const network = pendingFetches();
    const f = fixture(network.fetch);
    const dialog = open(f);
    click(classed(dialog, 'daki-project-removal-confirm').onclick);
    network.requests[0].reject(new TypeError('Failed to fetch'));
    await flush();
    assert.equal(dialog.open, true);
    assert.equal(classed(dialog, 'daki-project-removal-status').textContent, '요청을 전송하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.');
    click(classed(dialog, 'daki-project-removal-confirm').onclick);
    assert.equal(network.requests.length, 2);
    network.requests[1].resolve(response(200, {status: 'success', project_id: 'a/b project', action: 'archive'}));
    await flush();
    assert.equal(f.callbacks.length, 1);
});

test('busy submission is single flight and disables all dismissal and choice controls', async () => {
    const network = pendingFetches();
    const f = fixture(network.fetch);
    const dialog = open(f);
    const confirm = classed(dialog, 'daki-project-removal-confirm');
    click(confirm.onclick);
    click(confirm.onclick);
    assert.equal(network.requests.length, 1);
    assert.equal(classed(dialog, 'daki-project-removal-cancel').disabled, true);
    assert.equal(classed(dialog, 'daki-project-removal-close').disabled, true);
    const radios = descendants(dialog).filter(node => node.tagName === 'INPUT' && node.type === 'radio');
    assert.ok(radios.every(radio => radio.disabled));
    assert.equal(classed(dialog, 'daki-project-removal-status').textContent, '그림과 프로젝트를 정리하는 중…');
});

test('navigation close ignores late success and does not notify the old project view', async () => {
    const network = pendingFetches();
    const f = fixture(network.fetch);
    const dialog = open(f);
    click(classed(dialog, 'daki-project-removal-confirm').onclick);
    f.api.close(false);
    assert.equal(dialog.open, false);
    network.requests[0].resolve(response(200, {status: 'success', project_id: 'a/b project', action: 'archive'}));
    await flush();
    assert.equal(f.callbacks.length, 0);
});

test('late response from a closed dialog cannot close a newly opened project dialog', async () => {
    const network = pendingFetches();
    const f = fixture(network.fetch);
    const firstDialog = open(f);
    click(classed(firstDialog, 'daki-project-removal-confirm').onclick);
    f.api.close(false);
    const secondProject = {...f.project, id: 'second', name: 'Second project'};
    const secondButton = f.api.createButton({project: secondProject, isCurrent: () => true});
    click(secondButton.onclick);
    const currentDialog = f.dialog();
    assert.equal(currentDialog.open, true);
    assert.equal(classed(currentDialog, 'daki-project-removal-name').textContent, 'Second project');
    network.requests[0].resolve(response(200, {status: 'success', project_id: 'a/b project', action: 'archive'}));
    await flush();
    assert.equal(currentDialog.open, true);
    assert.equal(f.callbacks.length, 0);
});
