const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const flush = () => new Promise(resolve => setImmediate(resolve));

class Element {
    constructor(tag) {
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.attributes = {};
        this.dataset = {};
        this.listeners = {};
        this.className = '';
        this.text = '';
        this.value = '';
        this.href = '';
        this.disabled = false;
        this.hidden = false;
        this.open = false;
        this.classList = {contains: name => this.className.split(/\s+/).includes(name)};
    }
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    replaceChildren(...children) {
        this.children.forEach(child => { child.parentNode = null; });
        this.children = [];
        this.text = '';
        this.append(...children);
    }
    set textContent(value) {
        this.children.forEach(child => { child.parentNode = null; });
        this.children = [];
        this.text = String(value);
    }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
    removeEventListener(type, callback) { this.listeners[type] = (this.listeners[type] || []).filter(item => item !== callback); }
    dispatch(type) {
        const event = {type, target: this, currentTarget: this, defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; }};
        const propertyResult = this[`on${type}`]?.(event);
        let result = propertyResult;
        for (const callback of this.listeners[type] || []) result = callback(event) ?? result;
        return {event, result};
    }
    showModal() { this.open = true; }
    close() { if (!this.open) return; this.open = false; this.dispatch('close'); }
    remove() {
        if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        this.parentNode = null;
    }
    descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
}

function fixture({standalone = false} = {}) {
    const body = new Element('body');
    if (standalone) body.className = 'daki-dictionary-standalone';
    const requests = [];
    const pending = [];
    const win = {
        document: {body, createElement: tag => new Element(tag)},
        location: {hash: '', href: ''},
        fetch(url, options = {}) {
            requests.push({url, options, body: options.body ? JSON.parse(options.body) : undefined});
            return new Promise((resolve, reject) => pending.push({resolve, reject}));
        },
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../static/daki_dictionary_drafts.js'), 'utf8'), {
        window: win,
        AbortController,
    });
    const host = new Element('section');
    const bridge = win.DakiDictionaryDrafts.mount(host);
    const all = tag => body.descendants().filter(item => !tag || item.tagName === tag.toUpperCase());
    const dialog = () => all('dialog')[0];
    const action = name => all().find(item => item.dataset.dakiDictionaryDraftAction === name);
    const reply = (index, data, status = 200) => {
        const item = pending[index];
        assert.ok(item, `pending request ${index}`);
        item.resolve({ok: status < 400, status, json: async () => data});
        pending[index] = null;
    };
    const fail = (index, error = new Error('Synthetic network failure')) => {
        const item = pending[index];
        assert.ok(item, `pending request ${index}`);
        item.reject(error);
        pending[index] = null;
    };
    const click = element => {
        assert.ok(element, 'click target');
        const dispatched = element.dispatch('click');
        return dispatched.result;
    };
    return {win, body, requests, pending, bridge, all, dialog, action, reply, fail, click};
}

test('image snapshot creates a project-specific draft folder and navigates to its editor', async () => {
    const f = fixture();
    f.bridge.show({imageId: 17, tag: 'standing_pose'});
    f.bridge.show({imageId: 21, tag: 'other_pose'});
    assert.equal(f.dialog().open, true);
    assert.equal(f.requests.length, 1, 'a duplicate show keeps the original project lookup');
    assert.match(f.dialog().textContent, /standing_pose 자세와 선택한 그림/);
    assert.equal(f.requests[0].url, '/api/daki/projects');
    assert.equal(f.requests[0].options.signal.aborted, false);
    f.reply(0, {status: 'success', projects: [{id: 'project/one', name: 'Synthetic project'}]});
    await flush();
    const select = f.all('select')[0];
    assert.ok(select);
    assert.equal(select.value, 'project/one');

    const creating = f.click(f.action('create-folder'));
    assert.equal(f.requests[1].url, '/api/daki/draft-folders');
    assert.equal(f.requests[1].options.method, 'POST');
    assert.deepEqual(f.requests[1].body, {
        project_id: 'project/one',
        name: '',
        settings: {
            char_prompts: [{prompt: 'standing_pose', negative_prompt: '', x: 0.5, y: 0.5}],
            dictionary_reference: {image_id: 17, tag: 'standing_pose'},
        },
    });
    f.reply(1, {status: 'success', folder: {id: 'folder two', project_id: 'project/one'}}, 201);
    await creating;
    assert.equal(f.win.location.hash, '#daki&library=drafts&project=project%2Fone&folder=folder%20two&edit=1');
    assert.equal(f.dialog().open, false);
});

test('cancel aborts project lookup and a late response cannot replace the next snapshot', async () => {
    const f = fixture();
    f.bridge.show({imageId: 3, tag: 'first'});
    const oldSignal = f.requests[0].options.signal;
    f.click(f.all('button').find(button => button.textContent === '취소'));
    assert.equal(f.dialog().open, false);
    assert.equal(oldSignal.aborted, true);
    f.bridge.show({imageId: 4, tag: 'second'});
    f.reply(0, {status: 'success', projects: [{id: 'old', name: 'Old'}]});
    await flush();
    assert.match(f.dialog().textContent, /second 자세와 선택한 그림/);
    assert.equal(f.all('select').length, 0);
});

test('project lookup failures can retry and an empty project list links back to project creation', async () => {
    const failed = fixture();
    failed.bridge.show({imageId: 5, tag: 'tag'});
    failed.reply(0, {status: 'error', error: 'Synthetic project error'}, 503);
    await flush();
    assert.match(failed.dialog().textContent, /Synthetic project error/);
    const retry = failed.click(failed.action('retry-projects'));
    failed.reply(1, {status: 'success', projects: []});
    await retry;
    const link = failed.all('a')[0];
    assert.equal(link.href, '#daki');
    assert.equal(link.textContent, '프로젝트 만들기');
    failed.click(link);
    assert.equal(failed.dialog().open, false);
    assert.equal(failed.win.location.hash, '#daki');
    assert.equal(failed.requests.length, 2);
    assert.equal(failed.requests.some(request => request.options.method === 'POST'), false);
});

test('stale creation responses after disposal do not navigate', async () => {
    const f = fixture({standalone: true});
    f.bridge.show({imageId: 8, tag: 'dynamic_pose'});
    f.reply(0, {status: 'success', projects: [{id: 'project-8', name: 'Project'}]});
    await flush();
    const creating = f.click(f.action('create-folder'));
    f.bridge.dispose();
    assert.equal(f.all('dialog').length, 0);
    f.reply(1, {status: 'success', folder: {id: 'folder-8', project_id: 'project-8'}}, 201);
    await creating;
    assert.equal(f.win.location.href, '');
    assert.equal(f.win.location.hash, '');
});

test('standalone success and empty-project links navigate outside the dictionary page', async () => {
    const f = fixture({standalone: true});
    f.bridge.show({imageId: 18, tag: 'running_pose'});
    f.reply(0, {status: 'success', projects: [{id: 'project-18', name: 'Project'}]});
    await flush();
    const creating = f.click(f.action('create-folder'));
    f.reply(1, {status: 'success', folder: {id: 'folder-18', project_id: 'project-18'}}, 201);
    await creating;
    assert.equal(f.win.location.href, '/#daki&library=drafts&project=project-18&folder=folder-18&edit=1');

    const empty = fixture({standalone: true});
    empty.bridge.show({imageId: 19, tag: 'walking_pose'});
    empty.reply(0, {status: 'success', projects: []});
    await flush();
    const link = empty.all('a')[0];
    assert.equal(link.href, '/#daki');
    empty.click(link);
    assert.equal(empty.win.location.href, '/#daki');
});

test('folder creation failure is retryable and a mismatched project response is rejected', async () => {
    const f = fixture();
    f.bridge.show({imageId: 9, tag: 'looking_back'});
    f.reply(0, {status: 'success', projects: [{id: 'chosen', name: 'Chosen'}]});
    await flush();
    const failed = f.click(f.action('create-folder'));
    f.reply(1, {status: 'success', folder: {id: 'wrong-project-folder', project_id: 'other'}}, 201);
    await failed;
    assert.match(f.dialog().textContent, /프로젝트가 일치하지 않습니다/);
    assert.equal(f.win.location.hash, '');
    assert.equal(f.action('create-folder').disabled, false);
});

test('dictionary image clicks only select previews and explicit toolbar wiring loads both pages', () => {
    const app = fs.readFileSync(require.resolve('../static/daki_dictionary/app.js'), 'utf8');
    const shell = fs.readFileSync(require.resolve('../index.html'), 'utf8');
    const standalone = fs.readFileSync(require.resolve('../static/daki_dictionary/index.html'), 'utf8');
    assert.match(app, /const dictionaryDrafts = root\.DakiDictionaryDrafts\?\.mount\(host\)/);
    const thumbnailStart = app.indexOf("listen(card, 'click'");
    const thumbnailEnd = app.indexOf("$('imageGallery').append(card)", thumbnailStart);
    const thumbnailClick = app.slice(thumbnailStart, thumbnailEnd);
    assert.match(thumbnailClick, /showImage\(image\.id, \{ scroll: !isDesktopLayout\(\) \}\)/);
    assert.doesNotMatch(thumbnailClick, /dictionaryDrafts/);
    assert.doesNotMatch(app, /listen\(\$\('imageFull'\), 'click'/);
    assert.doesNotMatch(app, /listen\(\$\('pictureOverlayImage'\), 'click'/);
    assert.match(app, /listen\(\$\('importDictionaryDraft'\), 'click', \(\) => openDictionaryDraft\(images\.detail\)\)/);
    assert.match(app, /dictionaryDrafts\?\.show\(\{imageId: image\.id, tag\}\)/);
    assert.match(app, /dictionaryDrafts\?\.dispose\(\)/);
    assert.match(standalone, /<button[^>]*id="importDictionaryDraft"[^>]*>[\s\S]*?시안으로 가져오기/);
    for (const html of [shell, standalone]) {
        assert.match(html, /<link rel="stylesheet" href="\/static\/daki_dictionary_drafts\.css">/);
        assert.match(html, /<script src="\/static\/daki_dictionary_drafts\.js" defer><\/script>[\s\S]*?<script src="\/static\/daki_dictionary\/app\.js" defer><\/script>/);
    }
});
