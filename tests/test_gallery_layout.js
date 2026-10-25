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
    insertBefore(node, target) {
        this.detach(node);
        this.children.splice(this.children.indexOf(target), 0, node);
        node.parentNode = this;
    }
    replaceChild(node, marker) {
        this.detach(node);
        this.children.splice(this.children.indexOf(marker), 1, node);
        marker.parentNode = null;
        node.parentNode = this;
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    getBoundingClientRect() { return {height: 54}; }
    focus() { this.focusCount++; }
}

function fixture(savedMode = null) {
    const nodes = new Map();
    const make = id => {
        const node = new Node(id);
        nodes.set(id, node);
        return node;
    };
    const body = make('body');
    const bar = body.appendChild(make('galleryLayoutSwitch'));
    const legacyButton = bar.appendChild(make('galleryLegacyLayoutBtn'));
    legacyButton.dataset.galleryLayout = 'legacy';
    const modernButton = bar.appendChild(make('galleryModernLayoutBtn'));
    modernButton.dataset.galleryLayout = 'modern';
    bar.appendChild(make('galleryLayoutSaveStatus'));
    const layout = body.appendChild(make('galleryModernLayout'));
    const sidebar = layout.appendChild(make('sidebar'));
    sidebar.appendChild(make('galleryModernNavigationBody'));
    sidebar.appendChild(make('galleryModernFiltersBody'));
    sidebar.appendChild(make('galleryModernCharactersBody'));
    layout.appendChild(make('galleryModernMain'));
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
    dakiLibrary.hidden = true;
    const candidate = dakiLibrary.appendChild(make('daki-candidate'));
    candidate.addEventListener('click', () => 'candidate listener');
    const modal = body.appendChild(make('existing-modal'));
    const callbacks = [];
    const writes = [];
    const doc = {
        body,
        activeElement: input,
        documentElement: {style: {setProperty: () => {}}},
        getElementById: id => nodes.get(id) || null,
        querySelector: selector => {
            const aliases = {'.header-main':'header', '.gallery-header-control-stack':'controls', '.search-wrapper':'search'};
            return nodes.get(aliases[selector] || selector.slice(1)) || null;
        },
        querySelectorAll: selector => selector === '[data-gallery-layout]' ? [legacyButton, modernButton] : (doc.anchorCandidates || []),
        createComment: text => new Node(`comment:${text}`)
    };
    const win = {
        scrollX: 7,
        scrollY: 820,
        localStorage: {
            getItem: () => savedMode,
            setItem: (key, value) => writes.push([key, value])
        },
        requestAnimationFrame: callback => callbacks.push(callback),
        scrollTo(x, y) { this.scrollX = x; this.scrollY = y; },
        addEventListener: () => {},
        scheduleGalleryScrollNavigationUpdate: () => {}
    };
    const controller = createGalleryLayoutController(doc, win);
    const flush = () => { while(callbacks.length) callbacks.shift()(); };
    const flushFrame = () => { callbacks.shift()?.(); };
    const tree = node => [node.id, node.children.map(tree)];
    return {doc, win, controller, nodes, writes, flush, flushFrame, tree, body, input, image, dakiLibrary, candidate, modal};
}

test('existing installations default to legacy and initialization does not write settings', () => {
    const f = fixture();
    const before = f.tree(f.body);
    f.controller.initialize();
    f.controller.initialize();
    f.flush();
    assert.equal(f.controller.getMode(), 'legacy');
    assert.deepEqual(f.tree(f.body), before);
    assert.equal(f.nodes.get('galleryModernLayout').hidden, true);
    assert.equal(f.nodes.get('galleryLegacyLayoutBtn').attributes['aria-pressed'], 'true');
    assert.deepEqual(f.writes, []);
});

test('modern and legacy reuse the same nodes and restore their exact positions repeatedly', () => {
    const f = fixture();
    f.controller.initialize();
    f.flush();
    const before = f.tree(f.body);
    const listener = f.image.listeners.get('click');
    const candidateListener = f.candidate.listeners.get('click');
    for (let i = 0; i < 3; i++) {
        f.controller.setMode('modern');
        f.flush();
        assert.equal(f.nodes.get('nav-tabs').parentNode.id, 'galleryModernNavigationBody');
        assert.equal(f.nodes.get('content').parentNode.id, 'galleryModernMain');
        assert.equal(f.dakiLibrary.parentNode.id, 'galleryModernMain');
        assert.equal(f.dakiLibrary.children[0], f.candidate);
        assert.equal(f.dakiLibrary.hidden, true);
        assert.equal(f.candidate.listeners.get('click'), candidateListener);
        assert.equal(f.nodes.get('controls').parentNode.id, 'galleryModernFiltersBody');
        assert.equal(f.modal.parentNode, f.body);
        assert.equal(f.input.value, 'synthetic filter');
        assert.equal(f.image.selected, true);
        assert.equal(f.image.listeners.get('click'), listener);
        assert.deepEqual([f.win.scrollX, f.win.scrollY], [7, 820]);
        f.controller.setMode('legacy');
        f.flush();
        assert.deepEqual(f.tree(f.body), before);
        assert.deepEqual([f.win.scrollX, f.win.scrollY], [7, 820]);
    }
    assert.ok(f.input.focusCount > 0);
    assert.equal(f.writes.length, 6);
    assert.ok(f.writes.every(([key]) => key === 'naia_gallery_layout_v1'));
});

test('an open daki library keeps its candidate nodes and visibility across layout switches', () => {
    const f = fixture();
    f.dakiLibrary.hidden = false;
    f.body.classes.add('gallery-daki-active');
    f.doc.activeElement = f.candidate;
    f.controller.initialize();
    f.flush();
    const before = f.tree(f.body);
    f.controller.setMode('modern');
    f.flush();
    assert.equal(f.dakiLibrary.parentNode.id, 'galleryModernMain');
    assert.equal(f.dakiLibrary.children[0], f.candidate);
    assert.equal(f.dakiLibrary.hidden, false);
    assert.equal(f.body.classes.has('gallery-daki-active'), true);
    f.controller.setMode('legacy');
    f.flush();
    assert.deepEqual(f.tree(f.body), before);
    assert.equal(f.dakiLibrary.hidden, false);
    assert.ok(f.candidate.focusCount > 0);
});

test('saved modern mode applies before data rendering, with accessible toggles in either mode', () => {
    const f = fixture('modern');
    f.controller.initialize();
    f.flush();
    assert.equal(f.controller.getMode(), 'modern');
    assert.deepEqual(f.writes, []);
    assert.equal(f.nodes.get('galleryModernLayout').hidden, false);
    assert.equal(f.nodes.get('galleryModernLayoutBtn').attributes['aria-pressed'], 'true');
    assert.equal(f.nodes.get('galleryLayoutSwitch').parentNode, f.body);
    f.nodes.get('galleryLegacyLayoutBtn').listeners.get('click')();
    f.flush();
    assert.equal(f.controller.getMode(), 'legacy');
    assert.equal(f.nodes.get('galleryLayoutSwitch').parentNode, f.body);
});

test('blocked browser storage leaves layout usable and reports the save failure', () => {
    const f = fixture();
    Object.defineProperty(f.win, 'localStorage', {get() {throw new Error('storage unavailable');}});
    f.controller.initialize();
    f.flush();
    assert.equal(f.controller.getMode(), 'legacy');
    assert.equal(f.nodes.get('galleryLayoutSaveStatus').hidden, false);
    f.controller.setMode('modern');
    f.flush();
    assert.equal(f.controller.getMode(), 'modern');
    assert.match(f.nodes.get('galleryLayoutSaveStatus').textContent, /저장하지 못했습니다/);
});

test('rapid toggles ignore stale scroll restoration callbacks', () => {
    const f = fixture();
    f.controller.initialize();
    f.win.scrollY = 900;
    f.controller.setMode('modern');
    f.win.scrollY = 1100;
    f.controller.setMode('legacy');
    f.flush();
    assert.equal(f.win.scrollY, 1100);
    assert.equal(f.controller.getMode(), 'legacy');
});

test('small windows start with collapsible navigation and remember manual expansion in this session', () => {
    const f = fixture('modern');
    f.win.matchMedia = () => ({matches: true});
    for (const id of ['galleryModernNavSection', 'galleryModernFilterSection']) {
        const section = new Node(id);
        section.open = true;
        f.nodes.set(id, section);
    }
    f.controller.initialize();
    f.flush();
    assert.equal(f.nodes.get('galleryModernNavSection').open, false);
    assert.equal(f.nodes.get('galleryModernFilterSection').open, false);
    f.nodes.get('galleryModernNavSection').open = true;
    f.controller.setMode('legacy');
    f.controller.setMode('modern');
    f.flush();
    assert.equal(f.nodes.get('galleryModernNavSection').open, true);
});

test('visible image stays at the same viewport offset across height changes and browser scroll clamping', () => {
    const f = fixture();
    f.controller.initialize();
    f.flush();
    f.win.innerHeight = 720;
    f.win.innerWidth = 1280;
    f.win.scrollY = 1400;
    f.win.maxScroll = 2000;
    f.doc.anchorCandidates = [f.image];
    f.image.getBoundingClientRect = () => {
        const absoluteTop = f.body.classes.has('gallery-layout-modern') ? 920 : 1520;
        const top = absoluteTop - f.win.scrollY;
        return {top, bottom:top+300, left:320, right:620};
    };
    f.win.scrollTo = function(x,y) { this.scrollX=x;this.scrollY=Math.max(0,Math.min(y,this.maxScroll)); };
    const initialOffset = f.image.getBoundingClientRect().top;
    f.controller.setMode('modern');
    f.win.maxScroll = 1000;
    f.win.scrollY = Math.min(f.win.scrollY, f.win.maxScroll);
    f.flush();
    assert.equal(f.win.scrollY,800);
    assert.equal(f.image.getBoundingClientRect().top,initialOffset);
    f.controller.setMode('legacy');
    f.win.maxScroll = 2000;
    f.flush();
    assert.equal(f.win.scrollY,1400);
    assert.equal(f.image.getBoundingClientRect().top,initialOffset);
});

test('anchor selection follows the top visible section, rather than DOM column order or hidden items', () => {
    const f = fixture();
    f.controller.initialize();
    f.flush();
    f.win.innerHeight = 720;
    f.win.innerWidth = 1280;
    f.win.scrollY = 500;
    const laterImage = new Node('later-image');
    const section = new Node('visible-section');
    const hiddenItem = new Node('hidden-item');
    for (const item of [laterImage,section,hiddenItem]) f.nodes.get('content').appendChild(item);
    laterImage.getBoundingClientRect = () => ({top:450,bottom:650,left:200,right:400});
    hiddenItem.getBoundingClientRect = () => ({top:0,bottom:0,left:0,right:0});
    section.getBoundingClientRect = () => {
        const top = (f.body.classes.has('gallery-layout-modern') ? 350 : 600) - f.win.scrollY;
        return {top,bottom:top+40,left:200,right:700};
    };
    f.doc.anchorCandidates = [laterImage,hiddenItem,section];
    f.controller.setMode('modern');
    f.flush();
    assert.equal(f.win.scrollY,250);
    assert.equal(section.getBoundingClientRect().top,100);
});

test('removed anchors fall back to the saved scroll position', () => {
    const f = fixture();
    f.controller.initialize();
    f.flush();
    f.win.innerHeight=720;
    f.win.innerWidth=1280;
    f.doc.anchorCandidates=[f.image];
    f.image.getBoundingClientRect=()=>({top:100,bottom:300,left:100,right:300});
    f.controller.setMode('modern');
    f.nodes.get('content').detach(f.image);
    f.image.parentNode=null;
    f.flush();
    assert.equal(f.win.scrollY,820);
});

test('scroll restoration reads the updated scroll position after geometry flushes layout', () => {
    const f = fixture();
    f.controller.initialize();
    f.flush();
    f.win.innerHeight=720;
    f.win.innerWidth=1280;
    f.win.scrollY=1400;
    f.doc.anchorCandidates=[f.image];
    let layoutPending=false;
    f.image.getBoundingClientRect=()=>{
        const modern=f.body.classes.has('gallery-layout-modern');
        if (modern && layoutPending) {
            f.win.scrollY=1000;
            layoutPending=false;
        }
        const top=(modern ? 920 : 1520)-f.win.scrollY;
        return {top,bottom:top+300,left:320,right:620};
    };
    f.controller.setMode('modern');
    layoutPending=true;
    f.flushFrame();
    assert.equal(f.win.scrollY,800);
    assert.equal(f.image.getBoundingClientRect().top,120);
    f.flush();
    assert.equal(f.win.scrollY,800);
});

test('only the same anchor is rechecked for three frames while visible card heights settle', () => {
    const f = fixture();
    f.controller.initialize();
    f.flush();
    f.win.innerHeight=720;
    f.win.innerWidth=1280;
    f.win.scrollY=1400;
    f.doc.anchorCandidates=[f.image];
    let modernAbsoluteTop=920;
    let anchorReads=0;
    let contentQueries=0;
    const query=f.doc.querySelectorAll;
    f.doc.querySelectorAll=selector=>{
        if (selector.startsWith('#content')) contentQueries++;
        return query(selector);
    };
    f.image.getBoundingClientRect=()=>{
        anchorReads++;
        const top=(f.body.classes.has('gallery-layout-modern') ? modernAbsoluteTop : 1520)-f.win.scrollY;
        return {top,bottom:top+300,left:320,right:620};
    };
    f.controller.setMode('modern');
    f.flushFrame();
    assert.equal(f.win.scrollY,800);
    modernAbsoluteTop=1040;
    f.flushFrame();
    assert.equal(f.win.scrollY,920);
    modernAbsoluteTop=1100;
    f.flushFrame();
    assert.equal(f.win.scrollY,980);
    modernAbsoluteTop=1300;
    f.flush();
    assert.equal(f.win.scrollY,980);
    assert.equal(anchorReads,4); // One capture and three bounded corrections.
    assert.equal(contentQueries,1);
});
