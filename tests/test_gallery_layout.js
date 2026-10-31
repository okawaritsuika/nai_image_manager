const test = require('node:test');
const assert = require('node:assert/strict');
const {createGalleryLayoutController} = require('../static/gallery_layout.js');

class Node {
    constructor(id = '') {
        this.id = id;
        this.children = [];
        this.parentNode = null;
        this.dataset = {};
        this.attributes = {};
        this.listeners = new Map();
        this.hidden = false;
        this.textContent = '';
        this.focusCount = 0;
        this.classes = new Set();
        this.classList = {
            toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name)
        };
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
    focus() { this.focusCount++; }
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
    body.appendChild(make('galleryPromptSearchPanel'));
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

test('narrow layout collapses navigation and filters once while preserving later manual expansion', () => {
    const f = fixture({narrow: true});
    f.controller.initialize();
    const navSection = f.nodes.get('galleryModernNavSection');
    const filterSection = f.nodes.get('galleryModernFilterSection');
    assert.equal(navSection.open, false);
    assert.equal(filterSection.open, false);

    navSection.open = true;
    f.controller.initialize();
    f.controller.setMode('legacy');

    assert.equal(navSection.open, true);
    assert.equal(filterSection.open, false);
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
    const originalParents = [controls.parentNode, brandFilter.parentNode, tagFilter.parentNode];

    f.controller.initialize();

    assert.deepEqual([controls.parentNode, brandFilter.parentNode, tagFilter.parentNode], originalParents);
    for (const node of [controls, brandFilter, tagFilter]) assert.equal(f.count(f.body, node), 1);
    assert.equal(f.nodes.get('header').parentNode.id, 'galleryModernMain');
});
