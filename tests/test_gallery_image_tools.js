const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const pathModule = require('node:path');
const {createGalleryImageTools, normalizeFormat, uniquePaths, collectCurrentFolderPaths} = require('../static/gallery_image_tools.js');

class FakeClassList {
    constructor(owner) { this.owner = owner; this.values = new Set(); }
    add(...names) { names.forEach(name => this.values.add(name)); }
    remove(...names) { names.forEach(name => this.values.delete(name)); }
    contains(name) { return this.values.has(name); }
    toggle(name, force) {
        const shouldAdd = force === undefined ? !this.values.has(name) : Boolean(force);
        if (shouldAdd) this.values.add(name); else this.values.delete(name);
        return shouldAdd;
    }
    setFrom(value) { this.values = new Set(String(value || '').split(/\s+/).filter(Boolean)); }
    toString() { return [...this.values].join(' '); }
}

class FakeElement {
    constructor(tagName, doc) {
        this.tagName = tagName.toUpperCase();
        this.doc = doc;
        this.children = [];
        this.parentNode = null;
        this.dataset = {};
        this.style = {};
        this.attributes = new Map();
        this.listeners = new Map();
        this.classList = new FakeClassList(this);
        this._className = '';
        this.textContent = '';
        this.value = '';
        this.checked = false;
        this.disabled = false;
        this.open = false;
        this.isConnected = false;
    }
    get className() { return this._className; }
    set className(value) { this._className = String(value || ''); this.classList.setFrom(this._className); }
    get firstElementChild() { return this.children[0] || null; }
    appendChild(child) {
        if (child.parentNode) child.remove();
        child.parentNode = this;
        child.isConnected = this.isConnected;
        this.children.push(child);
        child.children.forEach(item => { item.isConnected = child.isConnected; });
        return child;
    }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    replaceChildren(...children) {
        this.children.forEach(child => { child.parentNode = null; child.isConnected = false; });
        this.children = [];
        this.textContent = '';
        this.append(...children);
    }
    remove() {
        if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        this.parentNode = null;
        this.isConnected = false;
        this.children.forEach(child => { child.isConnected = false; });
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }
    async fire(type, event = {}) {
        const results = [];
        for (const listener of this.listeners.get(type) || []) results.push(await listener({...event, target: this}));
        return results;
    }
    showModal() { this.open = true; this.setAttribute('open', ''); }
    close() { this.open = false; this.removeAttribute('open'); this.fire('close'); }
    focus() { this.focused = true; }
    matches(selector) {
        if (selector.startsWith('#')) return this.id === selector.slice(1);
        const attribute = selector.match(/\[data-path\]/);
        const tag = selector.match(/^[a-z]+/i)?.[0];
        const classes = [...selector.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
        if (tag && this.tagName !== tag.toUpperCase()) return false;
        if (classes.some(name => !this.classList.contains(name))) return false;
        if (attribute && !this.dataset.path) return false;
        return Boolean(tag || classes.length || attribute || selector === '*');
    }
    querySelector(selector) {
        const parts = selector.trim().split(/\s+/);
        const target = parts[parts.length - 1];
        const matchesChain = node => {
            if (!node.matches(target)) return false;
            let ancestor = node.parentNode;
            for (let index = parts.length - 2; index >= 0; index--) {
                while (ancestor && !ancestor.matches(parts[index])) ancestor = ancestor.parentNode;
                if (!ancestor) return false;
                ancestor = ancestor.parentNode;
            }
            return true;
        };
        return this.querySelectorAll('*').find(matchesChain) || null;
    }
    querySelectorAll(selector) {
        const found = [];
        const visit = node => {
            for (const child of node.children) {
                if (selector === '*' || child.matches(selector.trim().split(/\s+/).at(-1))) found.push(child);
                visit(child);
            }
        };
        visit(this);
        if (selector.includes(' ')) return found.filter(node => {
            const parts = selector.trim().split(/\s+/);
            let ancestor = node.parentNode;
            for (let index = parts.length - 2; index >= 0; index--) {
                while (ancestor && !ancestor.matches(parts[index])) ancestor = ancestor.parentNode;
                if (!ancestor) return false;
                ancestor = ancestor.parentNode;
            }
            return true;
        });
        return found;
    }
}

class FakeDocument {
    constructor() {
        this.readyState = 'complete';
        this.nodes = new Map();
        this.body = new FakeElement('body', this);
        this.body.isConnected = true;
    }
    createElement(tagName) { return new FakeElement(tagName, this); }
    register(id, node = this.createElement('input')) { node.id = id; this.nodes.set(id, node); return node; }
    getElementById(id) {
        if (this.nodes.has(id)) return this.nodes.get(id);
        const visit = node => {
            if (node.id === id) return node;
            for (const child of node.children) {
                const found = visit(child);
                if (found) return found;
            }
            return null;
        };
        return visit(this.body);
    }
    querySelectorAll(selector) { return this.body.querySelectorAll(selector); }
}

function response(payload, status = 200) {
    return {ok: status >= 200 && status < 300, status, json: async () => payload};
}

function idleJob() {
    return {id: null, status: 'idle', total: 0, processed: 0, converted: 0, skipped: 0, failed: 0,
        source_bytes: 0, target_bytes: 0, quality: 90, details: [], cancel_requested: false};
}

function fixture({formatResponse, webpStartResponse, webpCancelResponse, storageValue = null, onLoadData,
    tagDefinitions: initialTagDefinitions = [], tagsByPath: initialTagsByPath = {}} = {}) {
    const doc = new FakeDocument();
    const checkbox = doc.register('toggle-image-formats');
    const currentFolderButton = doc.register('galleryWebpCurrentFolder', doc.createElement('button'));
    const requests = [];
    const updatedPaths = [];
    const observers = [];
    const timers = new Map();
    const windowListeners = new Map();
    let timerId = 0;
    let formatResponder = formatResponse || (paths => Object.fromEntries(paths.map(path => [path, 'UNKNOWN'])));
    let startResponder = webpStartResponse || (() => ({...idleJob(), id: 'job-1', status: 'running', total: 1}));
    let cancelResponder = webpCancelResponse || (job => ({...job, status: 'cancelled', cancel_requested: true}));
    let tagDefinitions = initialTagDefinitions;
    let tagsByPath = {...initialTagsByPath};
    const renderedTagIds = [];
    const storage = {
        value: storageValue,
        getItem() { return this.value; },
        setItem(_key, value) { this.value = value; },
    };
    const host = {
        document: doc,
        localStorage: storage,
        location: {hash: '#gallery'},
        setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
        clearTimeout(id) { timers.delete(id); },
        addEventListener(type, listener) {
            const listeners = windowListeners.get(type) || [];
            listeners.push(listener);
            windowListeners.set(type, listeners);
        },
        dispatchEvent() {},
        getGalleryTagState() { return {definitions: tagDefinitions}; },
        getGalleryImageTagId(path) { return tagsByPath[path] || ''; },
        renderGalleryTagIcon(tag) { renderedTagIds.push(String(tag.id)); return '<span class="synthetic-tag-icon"></span>'; },
        Event: global.Event,
        HashChangeEvent: global.HashChangeEvent,
        AbortController: global.AbortController,
        IntersectionObserver: class {
            constructor(callback) { this.callback = callback; this.observed = new Set(); observers.push(this); }
            observe(node) { this.observed.add(node); }
            unobserve(node) { this.observed.delete(node); }
            disconnect() { this.observed.clear(); }
            fire(nodes = [...this.observed]) { this.callback(nodes.map(target => ({target, isIntersecting: true}))); }
        },
        async fetch(url, options = {}) {
            requests.push({url, options});
            if (url === '/api/gallery/image-formats') {
                const body = JSON.parse(options.body);
                const formats = typeof formatResponder === 'function' ? await formatResponder(body.paths, requests.length) : formatResponder;
                return response({status: 'success', formats});
            }
            if (url === '/api/gallery/webp' && options.method === 'POST') {
                const body = JSON.parse(options.body);
                return response({status: 'success', job: await startResponder(body)});
            }
            if (url === '/api/gallery/webp/cancel') {
                const body = JSON.parse(options.body);
                return response({status: 'success', job: await cancelResponder(body)});
            }
            return response({status: 'success', job: idleJob()});
        },
        loadData: () => onLoadData?.(),
        markGalleryImageUpdated(path) { updatedPaths.push(path); return `/image/${path}?t=123`; },
    };
    const tools = createGalleryImageTools(host);
    tools.initialize();
    return {doc, host, tools, checkbox, currentFolderButton, requests, observers, timers, storage, updatedPaths,
        setFormatResponder(value) { formatResponder = value; },
        setStartResponder(value) { startResponder = value; },
        setCancelResponder(value) { cancelResponder = value; },
        setTagState(definitions, mapping) { tagDefinitions = definitions; tagsByPath = {...mapping}; },
        renderedTagIds,
        fireWindowEvent(type, event = {}) { (windowListeners.get(type) || []).forEach(listener => listener(event)); },
        runTimers() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); }};
}

function imageCard(doc, path) {
    const card = doc.createElement('div');
    card.className = 'item-box';
    card.dataset.path = path;
    const image = doc.createElement('img');
    image.className = 'zoomable';
    image.src = `/image/${path}?preview=768`;
    card.appendChild(image);
    doc.body.appendChild(card);
    return card;
}

function addGalleryPaths(f, paths, daki = false) {
    const scope = f.doc.createElement('main');
    const grid = f.doc.createElement('div');
    scope.id = daki ? 'dakiContent' : 'content';
    f.doc.nodes.set(scope.id, scope);
    grid.className = 'flex-masonry';
    grid.galleryZoomImages = paths.map(path => ({path}));
    scope.appendChild(grid);
    f.doc.body.appendChild(scope);
    return grid;
}

const turn = () => new Promise(resolve => setImmediate(resolve));

test('normalizes server formats without guessing from the filename', () => {
    assert.equal(normalizeFormat('jpeg'), 'JPEG');
    assert.equal(normalizeFormat('webp'), 'WEBP');
    assert.equal(normalizeFormat('svg'), 'UNKNOWN');
    assert.deepEqual(uniquePaths(['a.png', 'a.png', '', null, 'b.webp']), ['a.png', 'b.webp']);
});

test('renderImageGrid decorates the same card after appendChild moves it out of its wrapper', () => {
    const doc = new FakeDocument();
    const wrapper = doc.createElement('div');
    const card = doc.createElement('article');
    wrapper.appendChild(card);
    const savedCard = wrapper.firstElementChild;
    const grid = doc.createElement('main');
    grid.isConnected = true;
    grid.appendChild(savedCard);
    assert.equal(wrapper.firstElementChild, null, 'appendChild moves the child out of its old parent');
    assert.equal(grid.firstElementChild, card);
    assert.equal(savedCard, card);

    const source = fs.readFileSync(pathModule.join(__dirname, '../static/index.js'), 'utf8');
    const renderStart = source.indexOf('function renderImageGrid(');
    const wrapperStart = source.indexOf("const wrapper = document.createElement('div');", renderStart);
    const decorateAt = source.indexOf('window.GalleryImageTools?.decorate(', wrapperStart);
    const block = source.slice(wrapperStart, decorateAt + 100);
    assert.match(block, /const card = wrapper\.firstElementChild;/);
    assert.match(block, /appendChild\(card\)/);
    assert.match(block, /GalleryImageTools\?\.decorate\(card, p\)/);
});

test('current-folder collection uses lazy grid lists and selects only the active root', () => {
    const doc = new FakeDocument();
    const content = doc.createElement('main');
    const dakiContent = doc.createElement('main');
    doc.nodes.set('content', content);
    doc.nodes.set('dakiContent', dakiContent);
    const generalGrid = doc.createElement('div');
    generalGrid.className = 'flex-masonry';
    generalGrid.galleryZoomImages = [{path: 'general/a.png'}, {path: 'general/a.png'}, {path: 'general/b.webp'}];
    content.appendChild(generalGrid);
    const dakiGrid = doc.createElement('div');
    dakiGrid.className = 'flex-masonry';
    dakiGrid.galleryZoomImages = [{path: 'daki/visible.png'}];
    dakiContent.appendChild(dakiGrid);
    assert.deepEqual(collectCurrentFolderPaths(doc, false), ['general/a.png', 'general/b.webp']);
    assert.deepEqual(collectCurrentFolderPaths(doc, true), ['daki/visible.png']);

    const filteredGrid = doc.createElement('div');
    filteredGrid.className = 'flex-masonry';
    filteredGrid.galleryZoomImages = [];
    generalGrid.galleryZoomImages = [];
    const hiddenCard = doc.createElement('div');
    hiddenCard.className = 'item-box';
    hiddenCard.dataset.path = 'general/filtered-out.png';
    content.append(filteredGrid, hiddenCard);
    assert.deepEqual(collectCurrentFolderPaths(doc, false), [], 'an empty filtered grid must not fall back to hidden cards');
});

test('format badges are opt-out persisted and use actual server format for a ghost png path', async () => {
    const f = fixture({storageValue: 'false', formatResponse: paths => Object.fromEntries(paths.map(path => [path, 'WEBP']))});
    const path = '__daki_personal__/synthetic.png';
    const card = imageCard(f.doc, path);
    f.tools.decorate(card, path);
    assert.equal(f.checkbox.checked, false);
    assert.equal(card.classList.contains('gallery-image-format-visible'), false);
    assert.equal(f.requests.filter(item => item.url === '/api/gallery/image-formats').length, 0);

    f.checkbox.checked = true;
    await f.checkbox.fire('change');
    assert.equal(f.storage.value, 'true');
    assert.equal(card.classList.contains('gallery-image-format-visible'), true);
    f.observers.at(-1).fire([card]);
    await turn();
    const badge = card.querySelector('.gallery-image-format-badge');
    assert.equal(badge.textContent, 'WEBP');
    assert.match(badge.title, /WEBP/);
    assert.deepEqual(JSON.parse(f.requests.find(item => item.url === '/api/gallery/image-formats').options.body).paths, [path]);

    f.checkbox.checked = false;
    await f.checkbox.fire('change');
    assert.equal(card.classList.contains('gallery-image-format-visible'), false);
    assert.equal(f.storage.value, 'false');
});

test('format badge stays at the top unless a card has an upscale badge, while Daki keeps its offset', () => {
    const f = fixture();
    const regularCard = imageCard(f.doc, 'regular.png');
    f.tools.decorate(regularCard, 'regular.png');
    assert.equal(regularCard.classList.contains('gallery-image-format-below-upscale'), false);

    const upscaleCard = imageCard(f.doc, 'upscaled.png');
    const upscaleBadge = f.doc.createElement('span');
    upscaleBadge.className = 'gallery-upscale-badge';
    upscaleCard.appendChild(upscaleBadge);
    f.tools.decorate(upscaleCard, 'upscaled.png');
    assert.equal(upscaleCard.classList.contains('gallery-image-format-below-upscale'), true);

    const css = fs.readFileSync(pathModule.join(__dirname, '../static/gallery_image_tools.css'), 'utf8');
    assert.match(css, /\.gallery-image-format-badge\s*\{[^}]*top:\s*8px/s);
    assert.match(css, /\.item-box\.gallery-image-format-below-upscale\s*>\s*\.gallery-image-format-badge\s*\{\s*top:\s*64px/s);
    assert.match(css, /#dakiLibrary\s+\.daki-candidate\.gallery-image-format-visible\s*>\s*\.gallery-image-format-badge\s*\{\s*top:\s*46px/s);
});

test('narrow legacy headers wrap whole controls without adding rules to the modern layout', () => {
    const css = fs.readFileSync(pathModule.join(__dirname, '../static/gallery_image_tools.css'), 'utf8');
    assert.match(css, /body:not\(\.gallery-layout-modern\) \.header-main > \.header-row:first-child\s*\{\s*flex-wrap:\s*wrap;\s*min-width:\s*0;/);
    assert.match(css, /body:not\(\.gallery-layout-modern\) \.header-main > \.header-row:first-child > \.header-row-right\s*\{\s*flex-wrap:\s*wrap;\s*min-width:\s*0;\s*max-width:\s*100%;/);
    assert.match(css, /@media\s*\(max-width:\s*1100px\)[\s\S]*?body:not\(\.gallery-layout-modern\) \.gallery-header-control-row\s*\{\s*flex-wrap:\s*wrap;/);
    assert.match(css, /body:not\(\.gallery-layout-modern\) \.gallery-header-control-row > \.gallery-model-controls label,[\s\S]*?\.gallery-sort-view-controls label\s*\{\s*white-space:\s*nowrap;/);
});

test('unknown and failed format results use a question mark with an explanatory title', async () => {
    const f = fixture({formatResponse: paths => Object.fromEntries(paths.map(path => [path, 'UNKNOWN']))});
    const card = imageCard(f.doc, 'sample.bin');
    f.tools.decorate(card, 'sample.bin');
    f.observers.at(-1).fire([card]);
    await turn();
    const badge = card.querySelector('.gallery-image-format-badge');
    assert.equal(badge.textContent, '?');
    assert.equal(badge.title, '형식 확인 불가');
});

test('format lookups are deduplicated and sent in sequential batches of at most 200', async () => {
    const f = fixture({formatResponse: paths => Object.fromEntries(paths.map(path => [path, 'PNG']))});
    const cards = Array.from({length: 205}, (_, index) => imageCard(f.doc, `folder/${index}.png`));
    cards.push(imageCard(f.doc, 'folder/0.png'));
    cards.forEach(card => f.tools.decorate(card, card.dataset.path));
    f.observers.at(-1).fire();
    for (let index = 0; index < 8; index++) await turn();
    const lookups = f.requests.filter(item => item.url === '/api/gallery/image-formats');
    assert.deepEqual(lookups.map(item => JSON.parse(item.options.body).paths.length), [200, 5]);
    assert.equal(new Set(lookups.flatMap(item => JSON.parse(item.options.body).paths)).size, 205);
    assert.equal(cards[0].querySelector('.gallery-image-format-badge').textContent, 'PNG');
});

test('late format responses after disabling do not change badges or cache', async () => {
    let resolveResponse;
    const f = fixture({formatResponse: () => new Promise(resolve => { resolveResponse = resolve; })});
    const card = imageCard(f.doc, 'late.png');
    f.tools.decorate(card, 'late.png');
    f.observers.at(-1).fire([card]);
    await turn();
    assert.equal(typeof resolveResponse, 'function');
    f.checkbox.checked = false;
    await f.checkbox.fire('change');
    resolveResponse({'late.png': 'JPEG'});
    await turn();
    await turn();
    assert.equal(f.tools.formatCache.has('late.png'), false);
    assert.equal(card.querySelector('.gallery-image-format-badge').textContent, '?');
    assert.equal(card.classList.contains('gallery-image-format-visible'), false);
});

test('conversion invalidation aborts and requeues visible lookups so stale formats cannot overwrite WEBP', async () => {
    const pending = [];
    const f = fixture({formatResponse: paths => new Promise(resolve => pending.push({paths, resolve}))});
    const card = imageCard(f.doc, 'late.png');
    f.tools.decorate(card, 'late.png');
    f.observers.at(-1).fire([card]);
    await turn();
    assert.equal(pending.length, 1);

    f.tools.invalidate(['late.png']);
    f.observers.at(-1).fire([card]);
    await turn();
    assert.equal(pending.length, 2, 'the connected card should be queried again after invalidation');
    pending[1].resolve({'late.png': 'WEBP'});
    await turn();
    await turn();
    assert.equal(f.tools.formatCache.get('late.png'), 'WEBP');
    assert.equal(card.querySelector('.gallery-image-format-badge').textContent, 'WEBP');

    pending[0].resolve({'late.png': 'PNG'});
    await turn();
    await turn();
    assert.equal(f.tools.formatCache.get('late.png'), 'WEBP');
    assert.equal(card.querySelector('.gallery-image-format-badge').textContent, 'WEBP');
});

test('pagehide aborts lookups without changing the saved checkbox preference', async () => {
    const f = fixture({formatResponse: () => new Promise(() => {})});
    const card = imageCard(f.doc, 'pagehide.png');
    f.tools.decorate(card, 'pagehide.png');
    f.observers.at(-1).fire([card]);
    await turn();
    f.fireWindowEvent('pagehide');
    assert.equal(f.storage.value, null);
    assert.equal(f.requests.find(item => item.url === '/api/gallery/image-formats').options.signal.aborted, true);
});

test('current-folder modal shows exact lazy target count and posts quality 90 with deduplicated paths', async () => {
    const f = fixture();
    const content = f.doc.createElement('main');
    f.doc.nodes.set('content', content);
    f.doc.body.appendChild(content);
    const grid = f.doc.createElement('div');
    grid.className = 'flex-masonry';
    grid.galleryZoomImages = [{path: 'current/a.png'}, {path: 'current/a.png'}, {path: 'current/b.jpg'}];
    content.appendChild(grid);
    f.setStartResponder(body => ({...idleJob(), id: 'job-started', status: 'running', total: body.paths.length}));

    await f.tools.openCurrentFolder();
    const dialog = f.doc.getElementById('galleryImageToolsDialog');
    assert.equal(dialog.open, true);
    assert.equal(dialog.querySelector('.gallery-image-tools-target').textContent, '변환 대상 2장');
    assert.equal(dialog.querySelector('.gallery-image-tools-scope').textContent, '표시된 그림만 변환 · 하위 폴더 제외');
    const quality = dialog.querySelector('.gallery-image-tools-quality input');
    assert.equal(quality.value, '90');
    assert.equal(dialog.querySelector('.gallery-image-tools-section-title').textContent, '실행 준비');
    assert.equal(dialog.querySelector('.gallery-image-tools-progress').hidden, true);
    assert.equal(dialog.querySelector('.gallery-image-tools-progress-text').textContent, '');
    assert.equal(dialog.querySelector('.gallery-image-tools-counters').hidden, true);
    assert.equal(dialog.querySelector('.gallery-image-tools-bytes').hidden, true);
    assert.equal(dialog.querySelector('.gallery-image-tools-details').hidden, true);
    await dialog.querySelector('.gallery-image-tools-start').fire('click');
    const start = f.requests.find(item => item.url === '/api/gallery/webp' && item.options.method === 'POST');
    assert.deepEqual(JSON.parse(start.options.body), {paths: ['current/a.png', 'current/b.jpg'], quality: 90});
    assert.equal(dialog.querySelector('.gallery-image-tools-start').disabled, true);
    assert.equal(dialog.querySelector('.gallery-image-tools-section-title').textContent, '진행 중인 작업');
    assert.match(dialog.querySelector('.gallery-image-tools-status').textContent, /창을 닫아도 서버 작업은 계속됩니다/);
    assert.equal(dialog.querySelector('.gallery-image-tools-counters').hidden, false);
    assert.equal(dialog.querySelector('.gallery-image-tools-stat-converted .gallery-image-tools-stat-value').textContent, '0');
    assert.equal(f.timers.size, 1);

    await dialog.querySelector('.gallery-image-tools-cancel').fire('click');
    const cancel = f.requests.find(item => item.url === '/api/gallery/webp/cancel');
    assert.deepEqual(JSON.parse(cancel.options.body), {id: 'job-started'});
    f.tools.close();
    assert.equal(f.timers.size, 0);
});

test('current-folder tag exclusions support multiple tags, all-tag mode, and reset on reopen', async () => {
    const f = fixture({
        tagDefinitions: [
            {id: 'star', type: 'text', value: 'star'},
            {id: 'sun', type: 'image', value: '/synthetic/sun.svg'},
        ],
        tagsByPath: {'folder/A.png': 'star', 'folder/B.png': 'sun'},
    });
    addGalleryPaths(f, ['folder/A.png', 'folder/B.png', 'folder/C.png']);

    await f.tools.openCurrentFolder();
    let dialog = f.doc.getElementById('galleryImageToolsDialog');
    const exclusion = dialog.querySelector('.gallery-image-tools-tag-exclusion');
    assert.equal(exclusion.hidden, false);
    assert.equal(dialog.querySelectorAll('.gallery-image-tools-tag-option').length, 2);
    assert.deepEqual(f.renderedTagIds, ['sun']);
    assert.equal(dialog.querySelector('.gallery-image-tools-tag-summary').textContent,
        '전체 3장 · 태그 제외 0장 · 변환 3장');

    const starRow = dialog.querySelectorAll('.gallery-image-tools-tag-option').find(row => row.dataset.tagId === 'star');
    const sunRow = dialog.querySelectorAll('.gallery-image-tools-tag-option').find(row => row.dataset.tagId === 'sun');
    const star = starRow.querySelector('input');
    const sun = sunRow.querySelector('input');
    star.checked = true;
    await star.fire('change');
    sun.checked = true;
    await sun.fire('change');
    assert.equal(dialog.querySelector('.gallery-image-tools-target').textContent, '변환 대상 1장');
    assert.equal(dialog.querySelector('.gallery-image-tools-tag-summary').textContent,
        '전체 3장 · 태그 제외 2장 · 변환 1장');

    const all = dialog.querySelector('.gallery-image-tools-exclude-all-tagged');
    all.checked = true;
    await all.fire('change');
    assert.equal(dialog.querySelector('.gallery-image-tools-target').textContent, '변환 대상 1장');
    assert.equal(star.disabled, true);
    assert.equal(sun.disabled, true);
    all.checked = false;
    await all.fire('change');
    assert.equal(star.disabled, false);
    assert.equal(star.checked, true, 'specific exclusions should be restored after leaving all-tag mode');
    assert.equal(sun.checked, true);

    f.tools.close();
    await f.tools.openCurrentFolder();
    dialog = f.doc.getElementById('galleryImageToolsDialog');
    assert.equal(dialog.querySelector('.gallery-image-tools-exclude-all-tagged').checked, false);
    assert.equal(dialog.querySelectorAll('.gallery-image-tools-tag-option').every(row => !row.querySelector('input').checked), true);
    const reopenedStar = dialog.querySelectorAll('.gallery-image-tools-tag-option').find(row => row.dataset.tagId === 'star').querySelector('input');
    const reopenedSun = dialog.querySelectorAll('.gallery-image-tools-tag-option').find(row => row.dataset.tagId === 'sun').querySelector('input');
    reopenedStar.checked = true;
    await reopenedStar.fire('change');
    reopenedSun.checked = true;
    await reopenedSun.fire('change');
    await dialog.querySelector('.gallery-image-tools-start').fire('click');
    const request = f.requests.find(item => item.url === '/api/gallery/webp' && item.options.method === 'POST');
    assert.deepEqual(JSON.parse(request.options.body), {paths: ['folder/C.png'], quality: 90});
    f.tools.close();
});

test('all-tag mode includes unknown tag IDs and empty results cannot be submitted', async () => {
    const f = fixture({
        tagDefinitions: [{id: 'known', type: 'text', value: 'known'}],
        tagsByPath: {'known.png': 'known', 'unknown.png': 'legacy-<img src=x onerror=alert(1)>'},
    });
    addGalleryPaths(f, ['known.png', 'unknown.png']);
    await f.tools.openCurrentFolder();
    const dialog = f.doc.getElementById('galleryImageToolsDialog');
    const unknownId = 'legacy-<img src=x onerror=alert(1)>';
    const unknownRow = dialog.querySelectorAll('.gallery-image-tools-tag-option').find(row => row.dataset.tagId === unknownId);
    assert.equal(unknownRow.querySelector('.gallery-image-tools-tag-name').textContent, `알 수 없는 태그 (${unknownId})`);
    assert.equal(unknownRow.querySelector('.gallery-image-tools-tag-name').innerHTML, undefined);
    assert.equal(unknownRow.querySelector('.gallery-image-tools-tag-icon').textContent, '?');

    const all = dialog.querySelector('.gallery-image-tools-exclude-all-tagged');
    all.checked = true;
    await all.fire('change');
    assert.equal(dialog.querySelector('.gallery-image-tools-target').textContent, '변환 대상 0장');
    assert.match(dialog.querySelector('.gallery-image-tools-status').textContent, /태그 제외 후 변환할 그림이 없습니다/);
    assert.equal(dialog.querySelector('.gallery-image-tools-start').disabled, true);
    await dialog.querySelector('.gallery-image-tools-start').fire('click');
    assert.equal(f.requests.some(item => item.url === '/api/gallery/webp' && item.options.method === 'POST'), false);
    all.checked = false;
    await all.fire('change');
    assert.equal(dialog.querySelector('.gallery-image-tools-target').textContent, '변환 대상 2장');
    assert.equal(dialog.querySelector('.gallery-image-tools-start').disabled, false);
    f.tools.close();
});

test('individual conversion hides folder tag exclusions and submits its selected path unchanged', async () => {
    const f = fixture({tagDefinitions: [{id: 'star', type: 'text', value: 'star'}], tagsByPath: {'one.png': 'star'}});
    await f.tools.openContext('one.png');
    const dialog = f.doc.getElementById('galleryImageToolsDialog');
    assert.equal(dialog.querySelector('.gallery-image-tools-tag-exclusion').hidden, true);
    await dialog.querySelector('.gallery-image-tools-start').fire('click');
    const request = f.requests.find(item => item.url === '/api/gallery/webp' && item.options.method === 'POST');
    assert.deepEqual(JSON.parse(request.options.body), {paths: ['one.png'], quality: 90});
    f.tools.close();
});

test('tag assignment notifications refresh current-folder counts before submission', async () => {
    const f = fixture({tagDefinitions: [{id: 'star', type: 'text', value: 'star'}], tagsByPath: {'A.png': 'star'}});
    addGalleryPaths(f, ['A.png', 'B.png', 'C.png']);
    await f.tools.openCurrentFolder();
    const dialog = f.doc.getElementById('galleryImageToolsDialog');
    let star = dialog.querySelector('.gallery-image-tools-tag-option').querySelector('input');
    star.checked = true;
    await star.fire('change');
    assert.equal(dialog.querySelector('.gallery-image-tools-target').textContent, '변환 대상 2장');

    f.setTagState([{id: 'star', type: 'text', value: 'star'}], {'A.png': 'star', 'B.png': 'star', 'C.png': ''});
    f.fireWindowEvent('gallery-tags-updated');
    assert.equal(dialog.querySelector('.gallery-image-tools-target').textContent, '변환 대상 1장');
    assert.equal(dialog.querySelector('.gallery-image-tools-tag-options').querySelector('.gallery-image-tools-tag-count').textContent, '2장');
    f.tools.close();
});

test('start rechecks live tags, disables exclusion controls during the request, and holds submitted paths', async () => {
    let resolvePost;
    const f = fixture({tagDefinitions: [{id: 'star', type: 'text', value: 'star'}], tagsByPath: {'A.png': 'star'}});
    addGalleryPaths(f, ['A.png', 'B.png', 'C.png']);
    f.host.fetch = async (url, options = {}) => {
        f.requests.push({url, options});
        if (url === '/api/gallery/webp' && options.method === 'POST') return new Promise(resolve => { resolvePost = resolve; });
        if (url === '/api/gallery/image-formats') return response({status: 'success', formats: {}});
        return response({status: 'success', job: idleJob()});
    };
    await f.tools.openCurrentFolder();
    const dialog = f.doc.getElementById('galleryImageToolsDialog');
    const star = dialog.querySelector('.gallery-image-tools-tag-option').querySelector('input');
    star.checked = true;
    await star.fire('change');
    f.setTagState([{id: 'star', type: 'text', value: 'star'}], {'A.png': 'star', 'B.png': 'star', 'C.png': ''});

    const startPromise = dialog.querySelector('.gallery-image-tools-start').fire('click');
    await turn();
    const request = f.requests.find(item => item.url === '/api/gallery/webp' && item.options.method === 'POST');
    assert.deepEqual(JSON.parse(request.options.body), {paths: ['C.png'], quality: 90},
        'the live tag assignments must be re-evaluated immediately before POST');
    assert.equal(dialog.querySelector('.gallery-image-tools-exclude-all-tagged').disabled, true);
    assert.equal(dialog.querySelector('.gallery-image-tools-tag-option input').disabled, true);
    f.setTagState([{id: 'star', type: 'text', value: 'star'}], {'A.png': '', 'B.png': '', 'C.png': 'star'});
    f.fireWindowEvent('gallery-tags-updated');
    assert.equal(dialog.querySelector('.gallery-image-tools-target').textContent, '변환 대상 1장',
        'late tag notifications must not mutate the submitted path snapshot');
    resolvePost(response({status: 'success', job: {...idleJob(), id: 'tag-snapshot', status: 'running', total: 1}}));
    await startPromise;
    assert.equal(dialog.querySelector('.gallery-image-tools-tag-option input').disabled, true);
    f.tools.close();
});

test('completed exclusions keep their run snapshot while a retry recomputes current tags', async () => {
    let run = 0;
    const f = fixture({
        tagDefinitions: [{id: 'star', type: 'text', value: 'star'}],
        tagsByPath: {'A.png': 'star'},
        webpStartResponse: body => {
            run++;
            return {...idleJob(), id: `finished-${run}`, status: 'completed', total: body.paths.length,
                processed: body.paths.length, converted: body.paths.length};
        },
    });
    addGalleryPaths(f, ['A.png', 'B.png']);
    await f.tools.openCurrentFolder();
    const dialog = f.doc.getElementById('galleryImageToolsDialog');
    const tagCheckbox = dialog.querySelector('.gallery-image-tools-tag-option input');
    tagCheckbox.checked = true;
    await tagCheckbox.fire('change');
    await dialog.querySelector('.gallery-image-tools-start').fire('click');
    assert.deepEqual(JSON.parse(f.requests.filter(item => item.url === '/api/gallery/webp' && item.options.method === 'POST')[0].options.body).paths, ['B.png']);
    assert.equal(dialog.querySelector('.gallery-image-tools-tag-summary').textContent,
        '전체 2장 · 태그 제외 1장 · 변환 1장');

    f.setTagState([{id: 'star', type: 'text', value: 'star'}], {'A.png': '', 'B.png': ''});
    f.fireWindowEvent('gallery-tags-updated');
    assert.equal(dialog.querySelector('.gallery-image-tools-tag-summary').textContent,
        '전체 2장 · 태그 제외 1장 · 변환 1장', 'completion retains the exclusion summary used for that run');

    await dialog.querySelector('.gallery-image-tools-start').fire('click');
    const requests = f.requests.filter(item => item.url === '/api/gallery/webp' && item.options.method === 'POST');
    assert.deepEqual(JSON.parse(requests[1].options.body).paths, ['A.png', 'B.png'],
        'a retry reevaluates assignments that changed after the previous conversion');
    assert.equal(dialog.querySelector('.gallery-image-tools-tag-summary').textContent,
        '전체 2장 · 태그 제외 0장 · 변환 2장');
    f.tools.close();
});

test('tag filtering can bring a folder above the 10,000-path cap below the submission limit', async () => {
    const paths = Array.from({length: 10001}, (_, index) => `bulk/${index}.png`);
    const tagsByPath = Object.fromEntries(paths.slice(0, -1).map(path => [path, 'bulk-tag']));
    const f = fixture({tagDefinitions: [{id: 'bulk-tag', type: 'text', value: 'bulk'}], tagsByPath});
    addGalleryPaths(f, paths);
    await f.tools.openCurrentFolder();
    const dialog = f.doc.getElementById('galleryImageToolsDialog');
    assert.equal(dialog.querySelector('.gallery-image-tools-start').disabled, true);
    const tagged = dialog.querySelector('.gallery-image-tools-tag-option input');
    tagged.checked = true;
    await tagged.fire('change');
    assert.equal(dialog.querySelector('.gallery-image-tools-target').textContent, '변환 대상 1장');
    assert.equal(dialog.querySelector('.gallery-image-tools-start').disabled, false);
    await dialog.querySelector('.gallery-image-tools-start').fire('click');
    const request = f.requests.find(item => item.url === '/api/gallery/webp' && item.options.method === 'POST');
    assert.deepEqual(JSON.parse(request.options.body), {paths: ['bulk/10000.png'], quality: 90});
    f.tools.close();
});

test('folder location cards distinguish normal, virtual, date and combined gallery views and snapshot location on open', async () => {
    const locations = [
        {kind: '현재 폴더', name: 'Folder A', path: 'gallery/Folder A', breadcrumb: '갤러리 / Folder A'},
        {kind: '가상 폴더', name: 'Prompt picks', path: '갤러리 / 가상 폴더 / Prompt picks', breadcrumb: '갤러리 / 가상 폴더 / Prompt picks'},
        {kind: '날짜별 보기', name: '2026년 10월', path: '갤러리 / Folder A / 2026년 10월', breadcrumb: '갤러리 / Folder A / 2026년 10월'},
        {kind: '모아보기', name: 'Character group', path: '갤러리 / Folder A / Character group', breadcrumb: '갤러리 / Folder A / Character group'},
    ];
    for (const expected of locations) {
        const f = fixture();
        addGalleryPaths(f, ['image.png']);
        let current = expected;
        f.host.getGalleryWebpLocation = () => current;
        const opened = f.tools.openCurrentFolder();
        current = {kind: '다른 폴더', name: 'Changed later', path: 'changed', breadcrumb: 'changed'};
        await opened;
        const dialog = f.doc.getElementById('galleryImageToolsDialog');
        assert.equal(dialog.querySelector('.gallery-image-tools-location-kind').textContent, expected.kind);
        assert.equal(dialog.querySelector('.gallery-image-tools-location-name').textContent, expected.name);
        assert.equal(dialog.querySelector('.gallery-image-tools-location-name').title, expected.name);
        assert.equal(dialog.querySelector('.gallery-image-tools-location-path').textContent, expected.path);
        assert.equal(dialog.querySelector('.gallery-image-tools-location-path').title, expected.path);
        const breadcrumb = dialog.querySelector('.gallery-image-tools-location-breadcrumb');
        if (expected.breadcrumb !== expected.path) assert.equal(breadcrumb.textContent, expected.breadcrumb);
        assert.equal(dialog.querySelector('.gallery-image-tools-location-name').textContent, expected.name,
            'navigation changes while the status request is pending must not overwrite the opened location');
        f.tools.close();
    }
});

test('Daki location uses dakiTitle and an individual path is rendered as text only', async () => {
    const daki = fixture();
    addGalleryPaths(daki, ['candidate.png'], true);
    const title = daki.doc.register('dakiTitle', daki.doc.createElement('h1'));
    title.textContent = 'My Daki Project';
    daki.host.Daki = {isActive: () => true};
    await daki.tools.openCurrentFolder();
    let dialog = daki.doc.getElementById('galleryImageToolsDialog');
    assert.equal(dialog.querySelector('.gallery-image-tools-location-kind').textContent, 'Daki 현재 보기');
    assert.equal(dialog.querySelector('.gallery-image-tools-location-name').textContent, 'My Daki Project');
    assert.equal(dialog.querySelector('.gallery-image-tools-location-path').textContent, 'Daki / My Daki Project');
    daki.tools.close();

    const individual = fixture();
    const maliciousPath = ' folder/<img src=x onerror=alert(1)>.png ';
    await individual.tools.openContext(maliciousPath);
    dialog = individual.doc.getElementById('galleryImageToolsDialog');
    const name = dialog.querySelector('.gallery-image-tools-location-name');
    const path = dialog.querySelector('.gallery-image-tools-location-path');
    assert.equal(dialog.querySelector('.gallery-image-tools-location-kind').textContent, '선택한 그림');
    assert.equal(name.textContent, '<img src=x onerror=alert(1)>.png ');
    assert.equal(name.title, '<img src=x onerror=alert(1)>.png ');
    assert.equal(name.innerHTML, undefined);
    assert.equal(path.textContent, maliciousPath);
    assert.equal(path.title, maliciousPath);
    individual.tools.close();
});

test('WebP modal styles keep the body as the scroll owner and adapt quality controls on narrow screens', () => {
    const css = fs.readFileSync(pathModule.join(__dirname, '../static/gallery_image_tools.css'), 'utf8');
    assert.match(css, /\.gallery-image-tools-dialog\s*\{[^}]*width:\s*min\(600px,\s*calc\(100vw - 32px\)\)[^}]*max-height:\s*calc\(100dvh - 32px\)[^}]*overflow:\s*hidden/s);
    assert.equal((css.match(/\.gallery-image-tools-dialog\s*\{/g) || []).length, 1, 'dialog shell styles should have one source of truth');
    assert.match(css, /\.gallery-image-tools-dialog\s+\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
    assert.match(css, /\.gallery-image-tools-dialog \.gallery-image-tools-body\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*auto/s);
    assert.match(css, /\.gallery-image-tools-dialog \.gallery-image-tools-quality\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/s);
    assert.match(css, /@media\s*\(max-width:\s*480px\)[\s\S]*?\.gallery-image-tools-quality\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\);/);
    assert.match(css, /\.gallery-image-tools-dialog \.gallery-image-tools-tag-exclusion\s*\{[^}]*padding:\s*16px[^}]*border-radius:\s*12px/s);
    assert.match(css, /\.gallery-image-tools-dialog \.gallery-image-tools-tag-options\s*\{[^}]*flex-wrap:\s*wrap[^}]*max-height:\s*160px[^}]*overflow-x:\s*hidden[^}]*overflow-y:\s*auto/s);
    assert.match(css, /\.gallery-image-tools-dialog \.gallery-image-tools-tag-name\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/s);
});

test('reopening restores the active server job and polling refreshes its terminal progress', async () => {
    let loaded = 0;
    const f = fixture({onLoadData: () => { loaded++; }});
    let statusCalls = 0;
    f.host.fetch = async (url, options = {}) => {
        f.requests.push({url, options});
        if (url === '/api/gallery/webp') {
            statusCalls++;
            const job = statusCalls === 1
                ? {...idleJob(), id: 'restored-job', status: 'running', total: 2, processed: 1, converted: 1}
                : {...idleJob(), id: 'restored-job', status: 'completed', total: 2, processed: 2, converted: 2};
            return response({status: 'success', job});
        }
        return response({status: 'success', formats: {}});
    };
    await f.tools.openContext('one.png');
    const dialog = f.doc.getElementById('galleryImageToolsDialog');
    assert.equal(f.tools.job.id, 'restored-job');
    assert.equal(dialog.querySelector('.gallery-image-tools-start').disabled, true);
    assert.match(dialog.querySelector('.gallery-image-tools-status').textContent, /창을 닫아도 서버 작업은 계속됩니다/);
    assert.equal(f.timers.size, 1);

    f.runTimers();
    await turn();
    await turn();
    assert.equal(f.tools.job.status, 'completed');
    assert.match(dialog.querySelector('.gallery-image-tools-progress-text').textContent, /^2 \/ 2/);
    assert.equal(dialog.querySelector('.gallery-image-tools-section-title').textContent, '최근 변환 결과');
    assert.equal(dialog.querySelector('.gallery-image-tools-stat-converted .gallery-image-tools-stat-value').textContent, '2');
    assert.equal(dialog.querySelector('.gallery-image-tools-bytes').hidden, false);
    assert.equal(loaded, 1);
    assert.equal(f.timers.size, 0);
    f.tools.close();
});

test('empty and over-limit current folders cannot start a conversion', async () => {
    const empty = fixture();
    const emptyContent = empty.doc.createElement('main');
    empty.doc.nodes.set('content', emptyContent);
    await empty.tools.openCurrentFolder();
    let dialog = empty.doc.getElementById('galleryImageToolsDialog');
    assert.match(dialog.querySelector('.gallery-image-tools-status').textContent, /그림이 없습니다/);
    assert.equal(dialog.querySelector('.gallery-image-tools-start').disabled, true);
    empty.tools.close();

    const tooMany = fixture();
    const content = tooMany.doc.createElement('main');
    tooMany.doc.nodes.set('content', content);
    const grid = tooMany.doc.createElement('div');
    grid.className = 'flex-masonry';
    grid.galleryZoomImages = Array.from({length: 10001}, (_, index) => ({path: `large/${index}.png`}));
    content.appendChild(grid);
    await tooMany.tools.openCurrentFolder();
    dialog = tooMany.doc.getElementById('galleryImageToolsDialog');
    assert.equal(dialog.querySelector('.gallery-image-tools-target').textContent, '대상 10,001장');
    assert.match(dialog.querySelector('.gallery-image-tools-status').textContent, /한 번에 최대 10,000장/);
    assert.equal(dialog.querySelector('.gallery-image-tools-start').disabled, true);
    assert.equal(tooMany.requests.some(item => item.url === '/api/gallery/webp' && item.options.method === 'POST'), false);
    tooMany.tools.close();
});

test('conversion completion invalidates format cache, versions the card URL and reloads the existing gallery view', async () => {
    let loaded = 0;
    const path = 'folder/source.png';
    const f = fixture({onLoadData: () => { loaded++; }, webpStartResponse: body => ({
        ...idleJob(), id: 'job-done', status: 'completed', total: body.paths.length,
        processed: body.paths.length, converted: 1, source_bytes: 2 * 1024 * 1024, target_bytes: 1024 * 1024,
        details: [{path, message: 'converted'}],
    })});
    const content = f.doc.createElement('main');
    f.doc.nodes.set('content', content);
    f.doc.body.appendChild(content);
    const grid = f.doc.createElement('div');
    grid.className = 'flex-masonry';
    grid.galleryZoomImages = [{path}];
    content.appendChild(grid);
    const card = imageCard(f.doc, path);
    content.appendChild(card);
    f.tools.decorate(card, path);
    f.tools.formatCache.set(path, 'PNG');
    f.tools.openCurrentFolder();
    await turn();
    await turn();
    const dialog = f.doc.getElementById('galleryImageToolsDialog');
    await dialog.querySelector('.gallery-image-tools-start').fire('click');
    assert.equal(loaded, 1);
    assert.equal(card.querySelector('img.zoomable').src, `/image/${path}?t=123&preview=768`);
    assert.notEqual(f.tools.formatCache.get(path), 'PNG', 'the stale format result must be invalidated and checked again');
    assert.match(dialog.querySelector('.gallery-image-tools-status').textContent, /완료/);
    assert.equal(dialog.querySelector('.gallery-image-tools-details').children.length, 1);
    f.tools.close();
});

test('a terminal job discovered after reopening refreshes the paths submitted by its original request', async () => {
    let loaded = 0;
    const firstPath = 'folder/original.png';
    const f = fixture({onLoadData: () => { loaded++; }});
    let serverJob = idleJob();
    f.host.fetch = async (url, options = {}) => {
        f.requests.push({url, options});
        if (url === '/api/gallery/webp' && options.method === 'POST') {
            serverJob = {...idleJob(), id: 'closed-job', status: 'running', total: 1};
            return response({status: 'success', job: serverJob});
        }
        if (url === '/api/gallery/webp') return response({status: 'success', job: serverJob});
        if (url === '/api/gallery/image-formats') return response({status: 'success', formats: {}});
        return response({status: 'success', job: idleJob()});
    };

    await f.tools.openContext(firstPath);
    let dialog = f.doc.getElementById('galleryImageToolsDialog');
    await dialog.querySelector('.gallery-image-tools-start').fire('click');
    f.tools.close();
    serverJob = {...serverJob, status: 'completed', processed: 1, converted: 1};

    await f.tools.openContext('folder/another.png');
    dialog = f.doc.getElementById('galleryImageToolsDialog');
    assert.equal(f.tools.job.status, 'completed');
    assert.equal(loaded, 1, 'loading a completed job should refresh the existing gallery view');
    assert.deepEqual(f.updatedPaths, [firstPath], 'the refresh must use the original job paths');
    f.tools.close();
});

test('a pending POST keeps its submitted path snapshot when the open modal selection changes', async () => {
    let resolvePost;
    const f = fixture();
    f.host.fetch = async (url, options = {}) => {
        f.requests.push({url, options});
        if (url === '/api/gallery/webp' && options.method === 'POST') {
            return new Promise(resolve => { resolvePost = resolve; });
        }
        if (url === '/api/gallery/webp') return response({status: 'success', job: idleJob()});
        if (url === '/api/gallery/image-formats') return response({status: 'success', formats: {}});
        return response({status: 'success', job: idleJob()});
    };
    await f.tools.openContext('first.png');
    const dialog = f.doc.getElementById('galleryImageToolsDialog');
    const startPromise = dialog.querySelector('.gallery-image-tools-start').fire('click');
    await turn();
    assert.equal(typeof resolvePost, 'function');
    const submitted = JSON.parse(f.requests.find(item => item.url === '/api/gallery/webp' && item.options.method === 'POST').options.body);
    assert.deepEqual(submitted, {paths: ['first.png'], quality: 90});

    await f.tools.openContext('second.png');
    resolvePost(response({status: 'success', job: {
        ...idleJob(), id: 'snapshot-job', status: 'completed', total: 1, processed: 1, converted: 1,
    }}));
    await startPromise;
    assert.deepEqual(f.updatedPaths, ['first.png']);
    f.tools.close();
});

test('Daki completion refreshes the active project hash without reloading the page', async () => {
    let refreshedProject = '';
    let loadedGallery = 0;
    const f = fixture({webpStartResponse: body => ({
        ...idleJob(), id: 'daki-job', status: 'completed', total: body.paths.length,
        processed: body.paths.length, converted: 1,
    }), onLoadData: () => { loadedGallery++; }});
    f.host.location.hash = '#daki&project=project-one';
    f.host.location.reload = () => assert.fail('the Daki route should refresh through its existing renderer');
    f.host.Daki = {
        isActive: () => true,
        async refreshProject(projectId) { refreshedProject = projectId; return true; },
    };
    await f.tools.openContext('__daki_personal__/candidate.png');
    const dialog = f.doc.getElementById('galleryImageToolsDialog');
    await dialog.querySelector('.gallery-image-tools-start').fire('click');
    assert.equal(refreshedProject, 'project-one');
    assert.equal(loadedGallery, 0);
    f.tools.close();
});

test('quality validation blocks invalid values and server errors stay visible', async () => {
    const f = fixture();
    await f.tools.openContext('sample.png');
    const dialog = f.doc.getElementById('galleryImageToolsDialog');
    dialog.querySelector('.gallery-image-tools-quality input').value = '101';
    await dialog.querySelector('.gallery-image-tools-start').fire('click');
    assert.match(dialog.querySelector('.gallery-image-tools-status').textContent, /1에서 100/);
    assert.equal(f.requests.some(item => item.url === '/api/gallery/webp' && item.options.method === 'POST'), false);
    f.tools.close();

    const failed = fixture();
    failed.host.fetch = async (url, options) => {
        failed.requests.push({url, options});
        if (url === '/api/gallery/webp') return response({status: 'error', message: 'synthetic failure'}, 500);
        return response({status: 'success', job: idleJob()});
    };
    await failed.tools.openContext('sample.png');
    const failedDialog = failed.doc.getElementById('galleryImageToolsDialog');
    await failedDialog.querySelector('.gallery-image-tools-start').fire('click');
    assert.match(failedDialog.querySelector('.gallery-image-tools-status').textContent, /synthetic failure/);
    assert.equal(failedDialog.querySelector('.gallery-image-tools-status').classList.contains('is-error'), true);
    failed.tools.close();
});

