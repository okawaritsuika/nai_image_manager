const test = require('node:test');
const assert = require('node:assert/strict');
const {createGalleryLayoutController} = require('../static/gallery_layout.js');

class Node {
    constructor(id = '', classNames = []) {
        this.id = id;
        this.children = [];
        this.parentNode = null;
        this.dataset = {};
        this.attributes = {};
        this.listeners = new Map();
        this.style = {};
        this.hidden = false;
        this.textContent = '';
        this.focusCount = 0;
        this.classes = new Set(classNames);
        this.classList = {
            toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name),
            contains: name => this.classes.has(name)
        };
        this.offsetWidth = 380;
        this.rect = {left: 700, right: 780, top: 30, bottom: 60};
    }
    get isConnected() { return Boolean(this.parentNode); }
    detach(node) {
        if (node.parentNode) {
            const siblings = node.parentNode.children;
            siblings.splice(siblings.indexOf(node), 1);
        }
    }
    appendChild(node) {
        this.detach(node);
        this.children.push(node);
        node.parentNode = this;
        return node;
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    closest(selector) {
        const className = selector.startsWith('.') ? selector.slice(1) : '';
        for (let node = this; node; node = node.parentNode) {
            if (selector === 'label' && node.tagName === 'LABEL') return node;
            if (className && node.classList.contains(className)) return node;
        }
        return null;
    }
    contains(target) {
        return this === target || this.children.some(child => child.contains(target));
    }
    getBoundingClientRect() { return this.rect; }
    dispatchEvent(event) {
        event.target ||= this;
        for (let node = this; node; node = event.bubbles ? node.parentNode : null) {
            node.listeners.get(event.type)?.(event);
        }
        return !event.defaultPrevented;
    }
    focus() { this.focusCount++; }
}

class TestEvent {
    constructor(type, {bubbles = false, key = '', path = null} = {}) {
        this.type = type;
        this.bubbles = bubbles;
        this.key = key;
        this.path = path;
        this.defaultPrevented = false;
    }
    composedPath() { return this.path || []; }
    preventDefault() { this.defaultPrevented = true; }
}

function fixture({includeLayout = true, missingTargets = [], narrow = false, legacyStoredValue = 'legacy'} = {}) {
    const nodes = new Map();
    const make = id => {
        const node = new Node(id);
        nodes.set(id, node);
        return node;
    };
    const body = make('body');
    const createLayout = () => {
        const layout = body.appendChild(make('galleryModernLayout'));
        layout.hidden = true;
        const sidebar = layout.appendChild(make('sidebar'));
        const navSection = sidebar.appendChild(make('galleryModernNavSection'));
        navSection.open = true;
        if (!missingTargets.includes('galleryModernNavigationBody')) {
            navSection.appendChild(make('galleryModernNavigationBody'));
        }
        const filterSection = sidebar.appendChild(make('galleryModernFilterSection'));
        filterSection.open = true;
        if (!missingTargets.includes('galleryModernFiltersBody')) {
            filterSection.appendChild(make('galleryModernFiltersBody'));
        }
        if (!missingTargets.includes('galleryModernCharactersBody')) {
            sidebar.appendChild(make('galleryModernCharactersBody'));
        }
        if (!missingTargets.includes('galleryModernMain')) {
            layout.appendChild(make('galleryModernMain'));
        }
        return layout;
    };
    if (includeLayout) createLayout();

    const header = body.appendChild(make('header'));
    header.appendChild(make('nav-tabs'));
    header.appendChild(make('unmovedHeaderActions'));
    header.appendChild(make('controls'));
    body.appendChild(make('breadcrumb-path'));
    body.appendChild(make('brand-filter-bar'));
    body.appendChild(make('galleryTagFilterBar'));
    body.appendChild(make('galleryTagAssignmentModeStatus'));
    body.appendChild(make('char-chip-container'));
    const search = body.appendChild(make('search'));
    const input = search.appendChild(make('folder-search'));
    input.value = 'synthetic filter';
    body.appendChild(make('galleryPromptSearchPanel')).appendChild(make('galleryPromptSearchToggle'));
    const content = body.appendChild(make('content'));
    const image = content.appendChild(make('existing-image'));
    image.selected = true;
    image.addEventListener('click', () => 'original listener');
    const dakiLibrary = body.appendChild(make('dakiLibrary'));
    dakiLibrary.hidden = false;
    const candidate = dakiLibrary.appendChild(make('daki-candidate'));
    candidate.addEventListener('click', () => 'candidate listener');
    const modal = body.appendChild(make('existing-modal'));
    const storageCalls = {getItem: 0, setItem: 0, removeItem: 0};
    const doc = {
        body,
        activeElement: candidate,
        getElementById: id => nodes.get(id) || null,
        querySelector: selector => {
            const aliases = {'.header-main': 'header', '.gallery-header-control-stack': 'controls', '.search-wrapper': 'search'};
            return nodes.get(aliases[selector] || selector.slice(1)) || null;
        }
    };
    const win = {
        scrollX: 7,
        scrollY: 820,
        localStorage: {
            getItem() { storageCalls.getItem++; return legacyStoredValue; },
            setItem() { storageCalls.setItem++; },
            removeItem() { storageCalls.removeItem++; }
        },
        matchMedia: query => ({matches: narrow && query === '(max-width: 760px)'}),
        scrollToCalls: 0,
        scrollTo(x, y) { this.scrollToCalls++; this.scrollX = x; this.scrollY = y; },
        requestAnimationFrameCalls: 0,
        requestAnimationFrame() { this.requestAnimationFrameCalls++; }
    };
    const controller = createGalleryLayoutController(doc, win);
    const tree = node => [node.id, node.children.map(tree)];
    const count = (root, target) => Number(root === target) + root.children.reduce((sum, child) => sum + count(child, target), 0);
    return {body, candidate, controller, count, createLayout, dakiLibrary, doc, image, input, modal, nodes, storageCalls, tree, win};
}

function compactFixture() {
    const f = fixture({missingTargets: ['galleryModernFiltersBody', 'galleryModernCharactersBody']});
    const make = (id, classes = []) => {
        const node = new Node(id, classes);
        f.nodes.set(id, node);
        return node;
    };
    const append = (parent, id, classes = []) => parent.appendChild(make(id, classes));
    const main = f.nodes.get('galleryModernMain');
    const toolbar = append(main, 'galleryCompactToolbar');
    const viewTarget = append(toolbar, 'galleryCompactView');
    const searchTarget = append(toolbar, 'galleryCompactSearch');
    const actions = append(toolbar, 'galleryCompactActions');
    const sortSelect = append(actions, 'galleryCompactSort');
    sortSelect.value = '';
    const promptTarget = append(actions, 'galleryCompactPrompt');
    const toggle = append(actions, 'galleryFilterToggle');
    const popover = append(actions, 'galleryFilterPopover');
    const filterBody = append(popover, 'galleryModernFiltersBody');
    const characterSection = append(filterBody, 'character-section', ['gallery-modern-character-section']);
    const charactersBody = append(characterSection, 'galleryModernCharactersBody');
    const closeButton = append(popover, 'galleryFilterPopoverClose');
    const controls = f.nodes.get('controls');
    controls.classes.add('gallery-header-control-stack');
    const sortView = append(controls, 'sort-view', ['gallery-sort-view-controls']);
    const inputs = {};
    const addInput = (parent, name, value, checked = false) => {
        const label = append(parent, `${name}-${value}-label`);
        label.tagName = 'LABEL';
        const input = append(label, `${name}-${value}-input`, ['view-radio']);
        input.tagName = 'INPUT';
        input.name = name;
        input.value = value;
        input.checked = checked;
        inputs[`${name}:${value}`] = input;
        return input;
    };
    for (const value of ['name', 'count', 'newest', 'oldest']) addInput(sortView, 'sortMode', value, value === 'count');
    for (const value of ['general', 'r18', 'all', 'trash']) addInput(sortView, 'viewMode', value, value === 'general');
    const dateControls = append(controls, 'gallery-date-controls');
    const galleryViewGroup = append(dateControls, 'gallery-view-group', ['gallery-date-control-group']);
    for (const value of ['character', 'date', 'virtual']) addInput(galleryViewGroup, 'galleryViewMode', value, value === 'character');
    const dateGroup = append(dateControls, 'gallery-date-group', ['gallery-date-control-group']);
    addInput(dateGroup, 'galleryDateGrouping', 'month', true);

    f.nodes.get('header').classes.add('header-main');
    f.nodes.get('search').classes.add('search-wrapper');
    f.doc.querySelector = selector => {
        const className = selector.startsWith('.') ? selector.slice(1) : '';
        const id = selector.startsWith('#') ? selector.slice(1) : '';
        const walk = node => {
            if ((id && node.id === id) || (className && node.classList.contains(className))) return node;
            for (const child of node.children) {
                const found = walk(child);
                if (found) return found;
            }
            return null;
        };
        return walk(f.body);
    };
    f.doc.querySelectorAll = selector => {
        const name = selector.match(/input\[name="([^"]+)"\]/)?.[1];
        const matches = [];
        const walk = node => {
            if (name && node.tagName === 'INPUT' && node.name === name) matches.push(node);
            for (const child of node.children) walk(child);
        };
        walk(f.body);
        return matches;
    };
    f.doc.documentElement = {clientWidth: 800, clientHeight: 800};
    f.doc.listeners = new Map();
    f.doc.addEventListener = (name, callback) => f.doc.listeners.set(name, callback);
    f.win.innerWidth = 800;
    f.win.innerHeight = 800;
    f.win.location = {hash: '#gallery'};
    f.win.Event = TestEvent;
    f.win.listeners = new Map();
    f.win.addEventListener = (name, callback) => f.win.listeners.set(name, callback);
    return {...f, actions, charactersBody, closeButton, filterBody, galleryViewGroup, inputs, popover, promptTarget, sortSelect, toggle, toolbar, viewTarget, searchTarget};
}

test('cold start uses the modern layout and ignores a saved legacy preference without storage access', () => {
    const f = fixture({legacyStoredValue: 'legacy'});
    f.controller.initialize();

    assert.equal(f.controller.getMode(), 'modern');
    assert.equal(f.body.classes.has('gallery-layout-modern'), true);
    assert.equal(f.nodes.get('galleryModernLayout').hidden, false);
    assert.equal(f.nodes.get('header').parentNode.id, 'galleryModernMain');
    assert.equal(f.nodes.get('nav-tabs').parentNode.id, 'galleryModernNavigationBody');
    assert.equal(f.nodes.get('content').parentNode.id, 'galleryModernMain');
    assert.deepEqual(f.storageCalls, {getItem: 0, setItem: 0, removeItem: 0});
});

test('repeated initialize and legacy setMode calls keep one set of nodes in modern layout without focus or scroll changes', () => {
    const f = fixture();
    f.controller.initialize();
    const parents = new Map([...f.nodes].map(([id, node]) => [id, node.parentNode]));
    const activeElement = f.doc.activeElement;
    const focusCounts = new Map([...f.nodes].map(([id, node]) => [id, node.focusCount]));
    const scroll = [f.win.scrollX, f.win.scrollY];

    f.controller.initialize();
    f.controller.setMode('legacy');
    f.controller.setMode('legacy', true);
    f.controller.setMode('modern', false);

    assert.equal(f.controller.getMode(), 'modern');
    assert.equal(f.body.classes.has('gallery-layout-modern'), true);
    for (const [id, node] of f.nodes) {
        assert.equal(node.parentNode, parents.get(id), `${id} stays with the same parent`);
        assert.equal(f.count(f.body, node), 1, `${id} occurs once`);
        assert.equal(node.focusCount, focusCounts.get(id), `${id} is not refocused`);
    }
    assert.equal(f.doc.activeElement, activeElement);
    assert.deepEqual([f.win.scrollX, f.win.scrollY], scroll);
    assert.equal(f.win.scrollToCalls, 0);
    assert.equal(f.win.requestAnimationFrameCalls, 0);
    assert.deepEqual(f.storageCalls, {getItem: 0, setItem: 0, removeItem: 0});
});

test('gallery and Daki nodes retain their state and event handlers after one-time relocation', () => {
    const f = fixture();
    f.body.classes.add('gallery-daki-active');
    f.input.value = 'preserved prompt';
    f.image.selected = true;
    const imageListener = f.image.listeners.get('click');
    const candidateListener = f.candidate.listeners.get('click');

    f.controller.initialize();

    assert.equal(f.nodes.get('content').parentNode.id, 'galleryModernMain');
    assert.equal(f.dakiLibrary.parentNode.id, 'galleryModernMain');
    assert.equal(f.dakiLibrary.children[0], f.candidate);
    assert.equal(f.dakiLibrary.hidden, false);
    assert.equal(f.body.classes.has('gallery-daki-active'), true);
    assert.equal(f.input.value, 'preserved prompt');
    assert.equal(f.image.selected, true);
    assert.equal(f.image.listeners.get('click'), imageListener);
    assert.equal(f.candidate.listeners.get('click'), candidateListener);
    assert.equal(f.modal.parentNode, f.body);
});

test('narrow layout collapses library navigation once while preserving later manual expansion', () => {
    const f = fixture({narrow: true});
    f.controller.initialize();
    const navSection = f.nodes.get('galleryModernNavSection');
    assert.equal(navSection.open, false);

    navSection.open = true;
    f.controller.initialize();
    f.controller.setMode('legacy');

    assert.equal(navSection.open, true);
});

test('missing layout returns safely and can initialize later when the layout exists', () => {
    const f = fixture({includeLayout: false});
    const before = f.tree(f.body);

    assert.doesNotThrow(() => f.controller.initialize());
    assert.doesNotThrow(() => f.controller.setMode('legacy'));
    assert.deepEqual(f.tree(f.body), before);
    assert.equal(f.body.classes.has('gallery-layout-modern'), false);
    assert.equal(f.controller.getMode(), 'modern');

    f.createLayout();
    f.controller.initialize();
    assert.equal(f.nodes.get('header').parentNode.id, 'galleryModernMain');
    assert.equal(f.body.classes.has('gallery-layout-modern'), true);
    assert.equal(f.nodes.get('galleryModernLayout').hidden, false);
});

test('nodes stay in their original location when a modern destination is missing', () => {
    const f = fixture({missingTargets: ['galleryModernFiltersBody']});
    const controls = f.nodes.get('controls');
    const brandFilter = f.nodes.get('brand-filter-bar');
    const tagFilter = f.nodes.get('galleryTagFilterBar');
    const originalParents = [controls.parentNode, brandFilter.parentNode];

    f.controller.initialize();

    assert.deepEqual([controls.parentNode, brandFilter.parentNode], originalParents);
    assert.equal(tagFilter.parentNode.id, 'galleryModernMain');
    for (const node of [controls, brandFilter, tagFilter]) assert.equal(f.count(f.body, node), 1);
    assert.equal(f.nodes.get('header').parentNode.id, 'galleryModernMain');
});

test('compact toolbar exposes prompt search and tags while detailed filters retain the existing grade radios', () => {
    const f = compactFixture();
    const promptPanel = f.nodes.get('galleryPromptSearchPanel');
    const promptToggle = f.nodes.get('galleryPromptSearchToggle');
    promptPanel.classes.add('collapsed');
    const query = promptPanel.appendChild(new Node('galleryPromptSearchInput'));
    query.value = 'synthetic prompt, %long tag%';
    const tagBar = f.nodes.get('galleryTagFilterBar');
    const tag = tagBar.appendChild(new Node('synthetic-tag'));
    tag.selected = true;
    const onTagClick = () => 'original tag handler';
    tag.addEventListener('click', onTagClick);
    f.controller.initialize();

    const main = f.nodes.get('galleryModernMain');
    assert.deepEqual(main.children.map(node => node.id), [
        'header', 'breadcrumb-path', 'galleryCompactToolbar',
        'galleryPromptSearchPanel', 'galleryTagFilterBar',
        'galleryTagAssignmentModeStatus', 'content', 'dakiLibrary'
    ]);
    assert.equal(f.galleryViewGroup.parentNode, f.viewTarget);
    assert.equal(f.nodes.get('search').parentNode, f.searchTarget);
    assert.equal(f.nodes.get('viewMode-general-label').parentNode, f.nodes.get('sort-view'));
    assert.equal(f.nodes.get('sortMode-count-label').parentNode, f.nodes.get('sort-view'));
    assert.deepEqual(f.filterBody.children.map(node => node.id), [
        'brand-filter-bar', 'character-section', 'controls'
    ]);
    assert.equal(promptPanel.parentNode, main);
    assert.equal(promptToggle.parentNode, f.promptTarget);
    assert.equal(promptPanel.classes.has('collapsed'), true);
    assert.equal(query.parentNode, promptPanel);
    assert.equal(query.value, 'synthetic prompt, %long tag%');
    assert.equal(tagBar.parentNode, main);
    assert.equal(tag.selected, true);
    assert.equal(tag.listeners.get('click'), onTagClick);
    assert.equal(f.count(f.body, tagBar), 1);
    assert.equal(f.count(f.body, promptToggle), 1);
    assert.equal(f.nodes.get('char-chip-container').parentNode, f.charactersBody);
    assert.equal(f.sortSelect.value, 'count');
    assert.equal(f.popover.hidden, true);
    assert.equal(f.toggle.attributes['aria-expanded'], 'false');

    let radioChange = null;
    f.inputs['sortMode:newest'].addEventListener('change', event => { radioChange = event; });
    f.sortSelect.value = 'newest';
    f.sortSelect.dispatchEvent(new TestEvent('change', {bubbles: true}));
    assert.equal(f.inputs['sortMode:newest'].checked, true);
    assert.equal(radioChange?.type, 'change');
    assert.equal(radioChange?.bubbles, true);
});

test('detail popover opens below its trigger, closes by Escape/outside/explicit action, and preserves dynamic inside clicks', () => {
    const f = compactFixture();
    f.controller.initialize();
    f.toggle.dispatchEvent(new TestEvent('click', {bubbles: true}));

    assert.equal(f.popover.hidden, false);
    assert.equal(f.toggle.attributes['aria-expanded'], 'true');
    assert.equal(f.popover.style.position, 'fixed');
    assert.equal(f.popover.style.left, '400px');
    assert.equal(f.popover.style.top, '66px');
    assert.equal(f.popover.style.maxHeight, '560px');

    const detachedChip = f.popover.appendChild(new Node('rerendered-chip'));
    f.popover.detach(detachedChip);
    f.doc.listeners.get('click')(new TestEvent('click', {path: [detachedChip, f.popover]}));
    assert.equal(f.popover.hidden, false);

    const focusBeforeEscape = f.toggle.focusCount;
    const escape = new TestEvent('keydown', {key: 'Escape'});
    f.doc.listeners.get('keydown')(escape);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(f.popover.hidden, true);
    assert.equal(f.toggle.focusCount, focusBeforeEscape + 1);

    f.toggle.dispatchEvent(new TestEvent('click'));
    const focusBeforeOutside = f.toggle.focusCount;
    f.doc.listeners.get('click')(new TestEvent('click', {path: [f.nodes.get('existing-modal'), f.body]}));
    assert.equal(f.popover.hidden, true);
    assert.equal(f.toggle.focusCount, focusBeforeOutside);

    f.toggle.dispatchEvent(new TestEvent('click'));
    f.closeButton.dispatchEvent(new TestEvent('click'));
    assert.equal(f.popover.hidden, true);
    assert.equal(f.toggle.focusCount, focusBeforeOutside + 1);

    f.toggle.dispatchEvent(new TestEvent('click'));
    f.win.location.hash = '#daki&library=projects';
    f.win.listeners.get('hashchange')();
    assert.equal(f.popover.hidden, true);

    f.win.location.hash = '#gallery';
    f.toggle.rect = {left: 700, right: 780, top: 810, bottom: 840};
    f.toggle.dispatchEvent(new TestEvent('click'));
    assert.equal(f.popover.hidden, true);
    assert.equal(f.toggle.attributes['aria-expanded'], 'false');

    f.toggle.rect = {left: 700, right: 780, top: 700, bottom: 790};
    f.toggle.dispatchEvent(new TestEvent('click'));
    assert.equal(f.popover.hidden, true);
});
