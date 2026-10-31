const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const controllerSource = fs.readFileSync(require.resolve('../static/daki_dictionary.js'), 'utf8');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
}

class FakeClassList {
    constructor(owner) { this.owner = owner; }
    add(...names) { for (const name of names) this.owner.classes.add(name); }
    remove(...names) { for (const name of names) this.owner.classes.delete(name); }
    contains(name) { return this.owner.classes.has(name); }
    toggle(name, force) {
        const shouldAdd = force === undefined ? !this.contains(name) : Boolean(force);
        if (shouldAdd) this.add(name); else this.remove(name);
        return shouldAdd;
    }
}

class FakeNode {
    constructor(tagName = 'div', className = '') {
        this.tagName = String(tagName).toUpperCase();
        this.classes = new Set(String(className).split(/\s+/).filter(Boolean));
        this.classList = new FakeClassList(this);
        this.children = [];
        this.parentNode = null;
        this.attributes = new Map();
        this.styleValues = new Map();
        this.style = {setProperty: (name, value) => this.styleValues.set(name, String(value)),
            getPropertyValue: name => this.styleValues.get(name) || ''};
        this.textContent = '';
        this.href = '';
        this.type = '';
        this.onclick = null;
        this.top = 0;
    }
    get className() { return [...this.classes].join(' '); }
    set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
    get isConnected() {
        for (let node = this; node; node = node.parentNode) if (node.isDocumentRoot) return true;
        return false;
    }
    append(...nodes) { for (const node of nodes) this.appendChild(node); }
    appendChild(node) {
        node.remove();
        node.parentNode = this;
        this.children.push(node);
        return node;
    }
    replaceChildren(...nodes) {
        for (const child of this.children) child.parentNode = null;
        this.children = [];
        this.append(...nodes);
    }
    remove() {
        if (!this.parentNode) return;
        const siblings = this.parentNode.children;
        const index = siblings.indexOf(this);
        if (index >= 0) siblings.splice(index, 1);
        this.parentNode = null;
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    removeAttribute(name) { this.attributes.delete(name); }
    getBoundingClientRect() { return {top: this.top, left: 0, right: 0, bottom: this.top + 1, width: 1, height: 1}; }
    contains(candidate) {
        for (let node = candidate; node; node = node.parentNode) if (node === this) return true;
        return false;
    }
}

function findNode(root, predicate) {
    if (predicate(root)) return root;
    for (const child of root.children || []) {
        const found = findNode(child, predicate);
        if (found) return found;
    }
    return null;
}

function response(markup = 'dictionary-template', ok = true) {
    return {ok, text: async () => markup};
}

function fixture({fetchImpl, workbench = true, mountError = null, templateFor} = {}) {
    const body = new FakeNode('body');
    body.isDocumentRoot = true;
    const header = new FakeNode('header');
    const sidebar = new FakeNode('aside');
    const library = new FakeNode('main');
    const container = new FakeNode('section');
    const title = new FakeNode('h1');
    const pageStatus = new FakeNode('p');
    const layoutHeader = new FakeNode('header');
    const dictionaryEntry = new FakeNode('a');
    header.appendChild(dictionaryEntry);
    const nodesById = new Map([
        ['dakiTitle', title], ['dakiPageStatus', pageStatus], ['galleryWorkspaceHeader', layoutHeader],
        ['galleryModernSidebar', sidebar],
        ['openDakiDictionary', dictionaryEntry],
    ]);
    body.append(header, sidebar, layoutHeader, library);
    library.appendChild(container);
    const document = {
        body,
        getElementById: id => nodesById.get(id) || null,
        createElement: tagName => new FakeNode(tagName),
        importNode(template) {
            const imported = new FakeNode(template.tagName, template.className);
            imported.sourceToken = template.sourceToken;
            imported.top = template.top;
            return imported;
        },
    };
    const requests = [];
    const mounts = [];
    const mountOptions = [];
    const disposals = [];
    const resizeObservers = [];
    const listeners = new Map();
    const scrolls = [];
    const parserTemplate = templateFor || (markup => {
        if (markup === 'missing-template') return null;
        const template = new FakeNode('main', 'daki-dictionary-tool');
        template.sourceToken = markup;
        template.top = 150;
        return template;
    });
    class FakeDOMParser {
        parseFromString(markup) {
            const template = parserTemplate(markup);
            return {querySelector: selector => selector === '.daki-dictionary-tool' ? template : null};
        }
    }
    class FakeResizeObserver {
        constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; resizeObservers.push(this); }
        observe(target) { this.targets.push(target); }
        disconnect() { this.disconnected = true; }
    }
    const root = {
        document,
        innerHeight: 900,
        AbortController,
        DOMParser: FakeDOMParser,
        ResizeObserver: FakeResizeObserver,
        scrollTo: (...args) => scrolls.push(args),
        addEventListener(type, callback) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(callback);
        },
        removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
        fetch(url, options) {
            requests.push({url, options});
            return fetchImpl ? fetchImpl(url, options, requests.length - 1) : Promise.resolve(response());
        },
    };
    if (workbench) {
        root.DakiDictionaryWorkbench = {
            mount(host, options) {
                mounts.push(host);
                mountOptions.push(options);
                if (mountError) throw mountError;
                const handle = {disposeCount: 0, dispose() { this.disposeCount += 1; }};
                disposals.push(handle);
                return handle;
            },
        };
    }
    vm.runInNewContext(controllerSource, {window: root, AbortController});
    return {root, dictionary: root.DakiDictionary, body, container, title, pageStatus,
        header, sidebar, layoutHeader, dictionaryEntry, requests, mounts, mountOptions, disposals, resizeObservers, listeners, scrolls};
}

function visibleError(f) {
    const loading = f.container.children.find(node => node.classList.contains('daki-dictionary-loading'));
    assert.ok(loading, 'the content area should show the loading/error panel');
    const back = findNode(loading, node => node.tagName === 'A');
    const status = findNode(loading, node => node.getAttribute('role') === 'status');
    const retry = findNode(loading, node => node.tagName === 'BUTTON' && node.textContent === '다시 불러오기');
    assert.equal(back?.href, '#daki', 'the project-list back link should remain available');
    assert.ok(status?.textContent, 'an actionable error message should be visible');
    assert.ok(retry, 'the user should be able to retry');
    return {loading, back, status, retry};
}

test('native dictionary mounts in the existing shell, fits below its header, and fully leaves', async () => {
    const f = fixture();
    const originalBodyChildren = [...f.body.children];
    const params = new URLSearchParams('daki&library=dictionary');

    await f.dictionary.render(params, f.container);

    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].url, '/daki/dictionary');
    assert.equal(f.container.children.length, 1);
    const host = f.container.children[0];
    assert.equal(host.classList.contains('daki-dictionary-tool'), true);
    assert.equal(host.tagName, 'MAIN');
    assert.equal(host.tagName === 'IFRAME' || f.container.children.some(node => node.tagName === 'IFRAME'), false);
    assert.equal(host.style.getPropertyValue('--daki-dictionary-height'), '738px');
    assert.deepEqual(f.mounts, [host]);
    assert.equal(f.title.textContent, '태그 사전');
    assert.equal(f.pageStatus.textContent, '');
    assert.equal(f.body.classList.contains('daki-dictionary-active'), true);
    assert.deepEqual(f.scrolls, [[0, 0]]);
    assert.deepEqual(f.body.children, originalBodyChildren, 'the surrounding header and sidebar stay in place');
    assert.equal(f.container.parentNode, f.body.children[3]);
    assert.equal(f.resizeObservers.length, 1);
    assert.ok(f.resizeObservers[0].targets.includes(f.container));
    assert.ok(f.resizeObservers[0].targets.includes(f.layoutHeader));
    assert.equal(f.listeners.get('resize').size, 1);

    f.dictionary.leave();
    f.dictionary.leave();
    assert.equal(host.isConnected, false);
    assert.equal(f.disposals[0].disposeCount, 1);
    assert.equal(f.resizeObservers[0].disconnected, true);
    assert.equal(f.listeners.get('resize').size, 0);
    assert.equal(f.body.classList.contains('daki-dictionary-active'), false);
    assert.deepEqual(f.body.children, originalBodyChildren);
});

test('header collapse refits the view and leaving restores navigation without accepting stale callbacks', async () => {
    const f = fixture();
    await f.dictionary.render(new URLSearchParams(), f.container);
    const host = f.mounts[0];
    const changeHeader = f.mountOptions[0].onHeaderChange;
    assert.equal(f.dictionaryEntry.getAttribute('aria-current'), 'page');
    host.top = 80;
    changeHeader(true);
    assert.equal(f.body.classList.contains('daki-dictionary-header-collapsed'), true);
    assert.equal(host.style.getPropertyValue('--daki-dictionary-height'), '808px');
    host.top = 150;
    changeHeader(false);
    assert.equal(f.body.classList.contains('daki-dictionary-header-collapsed'), false);
    assert.equal(host.style.getPropertyValue('--daki-dictionary-height'), '738px');
    changeHeader(true);
    f.dictionary.leave();
    assert.equal(f.body.classList.contains('daki-dictionary-header-collapsed'), false);
    assert.equal(f.dictionaryEntry.getAttribute('aria-current'), null);
    changeHeader(true);
    assert.equal(f.body.classList.contains('daki-dictionary-header-collapsed'), false);
});

test('leaving while the shell request is pending aborts it and ignores its late response', async () => {
    const pending = deferred();
    const f = fixture({fetchImpl: () => pending.promise});
    const rendering = f.dictionary.render(new URLSearchParams(), f.container);
    const signal = f.requests[0].options.signal;
    assert.equal(signal.aborted, false);

    f.dictionary.leave();
    assert.equal(signal.aborted, true);
    pending.resolve(response('late-template'));
    await rendering;

    assert.equal(f.mounts.length, 0);
    assert.equal(f.container.children.some(node => node.classList.contains('daki-dictionary-tool')), false);
    assert.equal(f.body.classList.contains('daki-dictionary-active'), false);
});

test('a late response from an earlier visit cannot replace the reopened dictionary', async () => {
    const pending = [deferred(), deferred()];
    const f = fixture({fetchImpl: (_url, _options, index) => pending[index].promise});
    const oldRender = f.dictionary.render(new URLSearchParams(), f.container);
    const oldSignal = f.requests[0].options.signal;
    const newRender = f.dictionary.render(new URLSearchParams(), f.container);
    const newSignal = f.requests[1].options.signal;

    assert.equal(oldSignal.aborted, true);
    assert.equal(newSignal.aborted, false);
    pending[0].resolve(response('old-visit'));
    pending[1].resolve(response('new-visit'));
    await Promise.all([oldRender, newRender]);

    assert.equal(f.mounts.length, 1);
    assert.equal(f.mounts[0].sourceToken, 'new-visit');
    assert.equal(f.container.children[0], f.mounts[0]);
    assert.equal(f.container.children[0].isConnected, true);
    assert.equal(f.body.classList.contains('daki-dictionary-active'), true);
    f.dictionary.leave();
    assert.equal(f.disposals[0].disposeCount, 1);
});

test('HTTP and missing-template failures leave a visible retry and back link', async t => {
    await t.test('HTTP failure', async () => {
        const f = fixture({fetchImpl: async () => response('', false)});
        await f.dictionary.render(new URLSearchParams(), f.container);
        const {retry, status} = visibleError(f);
        assert.match(status.textContent, /불러오지 못했습니다/);
        assert.equal(typeof retry.onclick, 'function');
    });
    await t.test('tool root is missing from the server document', async () => {
        const f = fixture({fetchImpl: async () => response('missing-template')});
        await f.dictionary.render(new URLSearchParams(), f.container);
        const {status} = visibleError(f);
        assert.match(status.textContent, /도구를 준비하지 못했습니다/);
    });
    await t.test('workbench factory is unavailable', async () => {
        const f = fixture({workbench: false});
        await f.dictionary.render(new URLSearchParams(), f.container);
        const {status} = visibleError(f);
        assert.match(status.textContent, /도구를 준비하지 못했습니다/);
    });
});

test('a workbench mount failure is recoverable in the visible content area', async () => {
    const f = fixture({mountError: new Error('synthetic mount failure')});
    await f.dictionary.render(new URLSearchParams(), f.container);
    assert.equal(f.mounts.length, 1, 'the workbench factory should have been called');
    const {status} = visibleError(f);
    assert.match(status.textContent, /synthetic mount failure/);
    assert.equal(f.container.children.some(node => node.classList.contains('daki-dictionary-tool')), false);
});

test('Daki route and HTML integration preserve the tag tooltip and load the workbench first', () => {
    const daki = fs.readFileSync(require.resolve('../static/daki.js'), 'utf8');
    const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
    const workbench = fs.readFileSync(require.resolve('../static/daki_dictionary/app.js'), 'utf8');
    const workbenchCss = fs.readFileSync(require.resolve('../static/daki_dictionary/styles.css'), 'utf8');
    const workbenchHtml = fs.readFileSync(require.resolve('../static/daki_dictionary/index.html'), 'utf8');
    const outerIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
    const innerIds = [...workbenchHtml.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(innerIds.filter(id => outerIds.has(id)), [], 'native tool IDs must not shadow the existing shell');
    assert.match(html, /<span>갤러리<\/span><\/a>\s*<a id="openDakiDictionary"[^>]*href="#daki&library=dictionary"/);
    assert.match(html, /<span>태그 사전<\/span><\/a>\s*<button id="openCanvasLink"/);
    for (const id of ['openCanvasLink', 'openGalleryLink', 'openDakiDictionary']) {
        const entry = html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`))?.[0] || '';
        assert.match(entry, /class="gallery-workspace-entry"/, 'workspace links share one sizing rule');
        assert.doesNotMatch(entry, /style=/, 'inline styles must not make the two entries diverge');
    }

    assert.doesNotMatch(daki, /folderCard\('태그사전', '#daki&library=dictionary'/);
    assert.match(daki, /params\.get\('library'\) === 'dictionary'/);
    assert.match(daki, /DakiDictionary\.render\(params, container\)/);
    const workbenchScript = html.indexOf('<script src="/static/daki_dictionary/app.js" defer></script>');
    const shellController = html.indexOf('<script src="/static/daki_dictionary.js" defer></script>');
    assert.ok(workbenchScript >= 0 && shellController > workbenchScript, 'the inner app.js must load before the parent controller');
    assert.match(workbench, /function installTagHints\(\)/);
    assert.match(workbench, /tooltip\.id = 'tagTooltip'/);
    assert.match(workbench, /tooltip\.setAttribute\('role', 'tooltip'\)/);
    assert.match(workbenchCss, /\.tag-tooltip\s*\{/);
});

test('dictionary workbench listener helper retains only global disposers and guards detached callbacks', () => {
    class FakeEventTarget {
        constructor() { this.listeners = new Map(); this.removals = []; }
        addEventListener(type, handler, options) {
            if (!this.listeners.has(type)) this.listeners.set(type, []);
            this.listeners.get(type).push({handler, options});
        }
        removeEventListener(type, handler, options) {
            this.removals.push({handler, options});
            this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item.handler !== handler));
        }
        dispatch(type, event = {}) {
            for (const {handler} of [...(this.listeners.get(type) || [])]) handler.call(this, event);
        }
        listenerCount(type) { return (this.listeners.get(type) || []).length; }
    }
    const workbench = fs.readFileSync(require.resolve('../static/daki_dictionary/app.js'), 'utf8');
    const start = workbench.indexOf('  function listen(');
    const end = workbench.indexOf('\nconst number', start);
    assert.ok(start >= 0 && end > start, 'the actual mount listener helper should remain at the expected source boundary');
    const helper = workbench.slice(start, end);
    function mountListeners(root, document) {
        const context = vm.createContext({root, document});
        return vm.runInContext(`
            let disposed = false;
            const listenerDisposers = new Set();
            ${helper}
            ({
                listen,
                listenerDisposers,
                dispose() {
                    if (disposed) return;
                    disposed = true;
                    for (const disposeListener of [...listenerDisposers]) disposeListener();
                },
            });
        `, context);
    }

    const root = new FakeEventTarget(), document = new FakeEventTarget();
    const firstMount = mountListeners(root, document);
    let globalCalls = 0, localCalls = 0, detachedCalls = 0, manualCalls = 0;
    const rootOptions = {capture: true, passive: true};
    firstMount.listen(root, 'resize', () => { globalCalls++; }, rootOptions);
    firstMount.listen(document, 'click', () => { globalCalls++; }, true);
    const host = new FakeEventTarget();
    firstMount.listen(host, 'click', () => { localCalls++; });
    const cards = Array.from({length: 1000}, () => new FakeEventTarget());
    for (const card of cards) firstMount.listen(card, 'click', () => { detachedCalls++; });
    assert.equal(firstMount.listenerDisposers.size, 2, 'only root and document listeners should be retained for disposal');
    assert.equal(root.listeners.get('resize')[0].options, rootOptions, 'listener options should be forwarded unchanged');

    const manualTarget = new FakeEventTarget(), manualOptions = {capture: false};
    const disposeManual = firstMount.listen(manualTarget, 'click', () => { manualCalls++; }, manualOptions);
    const manualHandler = manualTarget.listeners.get('click')[0].handler;
    manualTarget.dispatch('click');
    disposeManual();
    assert.equal(manualCalls, 1, 'a live local listener should run');
    assert.equal(manualTarget.listenerCount('click'), 0, 'a returned disposer should remove its guarded handler');
    assert.equal(manualTarget.removals[0].handler, manualHandler);
    assert.equal(manualTarget.removals[0].options, manualOptions, 'the same options should be used for removal');
    assert.equal(firstMount.listenerDisposers.size, 2);

    root.dispatch('resize'); document.dispatch('click'); host.dispatch('click'); cards[0].dispatch('click');
    assert.deepEqual([globalCalls, localCalls, detachedCalls], [2, 1, 1], 'live global and local listeners should work');
    firstMount.dispose();
    assert.equal(firstMount.listenerDisposers.size, 0);
    assert.equal(root.listenerCount('resize'), 0);
    assert.equal(document.listenerCount('click'), 0);
    root.dispatch('resize'); document.dispatch('click'); host.dispatch('click'); cards[0].dispatch('click');
    assert.deepEqual([globalCalls, localCalls, detachedCalls], [2, 1, 1], 'callbacks held by detached nodes should be ignored after disposal');

    const secondMount = mountListeners(root, document);
    secondMount.listen(root, 'resize', () => { globalCalls++; }, rootOptions);
    secondMount.listen(document, 'click', () => { globalCalls++; }, true);
    assert.equal(root.listenerCount('resize'), 1, 'remount should not leave the first mount listener behind');
    assert.equal(document.listenerCount('click'), 1, 'remount should not duplicate the first mount listener');
    root.dispatch('resize'); document.dispatch('click');
    assert.equal(globalCalls, 4, 'one remount dispatch should invoke only the current callbacks');
    secondMount.dispose();
});
