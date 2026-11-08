const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
    constructor(tagName) {
        this.tagName = tagName.toUpperCase();
        this.className = '';
        this.children = [];
        this.attributes = {};
        this.parentNode = null;
        this.hidden = false;
        this.disabled = false;
        this.textContent = '';
    }
    appendChild(child) {
        child.remove(); child.parentNode = this; this.children.push(child); return child;
    }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    replaceChildren(...children) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.append(...children); }
    remove() {
        if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        this.parentNode = null;
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
        const found = [];
        const visit = item => {
            if (selector.startsWith('.') && item.className.split(/\s+/).includes(selector.slice(1))) found.push(item);
            item.children.forEach(visit);
        };
        this.children.forEach(visit);
        return found;
    }
}

function harness({intersection = true} = {}) {
    let nextFrame = 0;
    const frames = new Map();
    const observers = [];
    const root = {
        document: {createElement: tagName => new Element(tagName)},
        Daki: {createGrid(className) {
            const grid = new Element('div'); grid.className = `flex-masonry ${className}`;
            grid.setItems = items => grid.replaceChildren(...items);
            grid.appendItems = items => grid.append(...items);
            return grid;
        }},
        requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
        cancelAnimationFrame(id) { frames.delete(id); },
    };
    if (intersection) root.IntersectionObserver = class {
        constructor(callback, options) { this.callback = callback; this.options = options; this.targets = new Set(); observers.push(this); }
        observe(target) { this.targets.add(target); }
        disconnect() { this.disconnected = true; this.targets.clear(); }
        trigger(target, isIntersecting = true) {
            this.callback([{target, isIntersecting, intersectionRatio: isIntersecting ? 1 : 0}]);
        }
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../static/daki_progressive_grid.js'), 'utf8'), {window: root});
    const flushFrame = () => {
        const pending = [...frames.entries()]; frames.clear();
        pending.forEach(([, callback]) => callback());
    };
    return {root, observers, frames, flushFrame, create: options => root.DakiProgressiveGrid.create(options)};
}

test('80-card rendering batches by frame, resets on new filtered records, and retains all zoom paths', () => {
    const h = harness();
    const rendered = new Map();
    const wrapper = h.create({className: 'daki-style-grid', renderItem: item => {
        if (!rendered.has(item.id)) rendered.set(item.id, new Element('article'));
        return rendered.get(item.id);
    }, pathOf: item => item.path});
    const records = Array.from({length: 3000}, (_, index) => ({id: String(index), path: `__daki_shared__/${index}.png`}));
    wrapper.setItems(records);
    assert.equal(h.frames.size, 1);
    assert.equal(wrapper.querySelectorAll('.daki-style-card').length, 0);
    h.flushFrame();
    const grid = wrapper.querySelector('.daki-style-grid');
    assert.equal(grid.children.length, 80);
    assert.equal(grid.galleryZoomImagesAll.length, 3000);
    assert.equal(wrapper.querySelector('.daki-progressive-count').textContent, '전체 3,000개 중 80개 표시');

    const more = wrapper.querySelector('.daki-progressive-more');
    more.onclick(); h.flushFrame();
    assert.equal(grid.children.length, 160);
    assert.equal(grid.galleryZoomImagesAll.length, 3000);

    wrapper.setItems(records); h.flushFrame();
    assert.equal(grid.children.length, 80, 'a filter refresh resets even when the filtered order stays the same');

    wrapper.setItems(records.slice(2990)); h.flushFrame();
    assert.equal(grid.children.length, 10, 'a changed filter result resets to its first page');
    assert.equal(more.disabled, true);
    assert.equal(wrapper.querySelector('.daki-progressive-count').textContent, '전체 10개 중 10개 표시');
    wrapper.setItems([]); h.flushFrame();
    assert.equal(grid.children.length, 0);
    assert.equal(more.disabled, true);
    assert.equal(wrapper.querySelector('.daki-progressive-count').textContent, '전체 0개 중 0개 표시');
    wrapper.dispose();
});

test('intersection adds one page per entry until the sentinel leaves, then disconnects and ignores late callbacks', () => {
    const h = harness(); const records = Array.from({length: 1000}, (_, index) => ({id: String(index)}));
    let rendered = 0;
    const wrapper = h.create({className: 'daki-style-grid', renderItem: item => { rendered++; return new Element('article'); }});
    wrapper.setItems(records); h.flushFrame();
    const observer = h.observers[0];
    const sentinel = wrapper.querySelector('.daki-progressive-sentinel');
    assert.equal(observer.options.rootMargin, '400px');
    observer.trigger(sentinel); h.flushFrame();
    assert.equal(wrapper.querySelector('.daki-style-grid').children.length, 160);
    observer.trigger(sentinel); h.flushFrame();
    assert.equal(wrapper.querySelector('.daki-style-grid').children.length, 160, 'one intersecting callback cannot drain the list');
    observer.trigger(sentinel, false);
    observer.trigger(sentinel); h.flushFrame();
    assert.equal(wrapper.querySelector('.daki-style-grid').children.length, 240);

    wrapper.querySelector('.daki-progressive-more').onclick();
    const renderedBeforeDispose = rendered;
    wrapper.dispose();
    assert.equal(observer.disconnected, true);
    assert.equal(h.frames.size, 0, 'dispose cancels the queued animation frame');
    observer.trigger(sentinel);
    h.flushFrame();
    assert.equal(rendered, renderedBeforeDispose);
});

test('without IntersectionObserver the enabled button loads pages and empty results stay disabled', () => {
    const h = harness({intersection: false});
    const wrapper = h.create({className: 'daki-style-grid', renderItem: () => new Element('article')});
    const more = wrapper.querySelector('.daki-progressive-more');
    wrapper.setItems([]); h.flushFrame();
    assert.equal(more.disabled, true);
    wrapper.setItems(Array.from({length: 81}, (_, index) => ({id: String(index)}))); h.flushFrame();
    assert.equal(more.disabled, false);
    assert.equal(wrapper.querySelector('.daki-style-grid').children.length, 80);
    more.onclick(); h.flushFrame();
    assert.equal(wrapper.querySelector('.daki-style-grid').children.length, 81);
    assert.equal(more.disabled, true);
    wrapper.dispose();
});

test('loading 1000 records renders each card and resolves each zoom path only once', () => {
    const h = harness({intersection: false});
    let rendered = 0, paths = 0;
    const wrapper = h.create({className: 'daki-style-grid',
        renderItem: () => { rendered++; return new Element('article'); },
        pathOf: item => { paths++; return item.path; }});
    wrapper.setItems(Array.from({length: 1000}, (_, index) => ({path: `synthetic/${index}.png`})));
    h.flushFrame();
    const grid = wrapper.querySelector('.daki-style-grid');
    const original = grid.children[0];
    const navigation = grid.galleryZoomImagesAll;
    const more = wrapper.querySelector('.daki-progressive-more');
    while (!more.disabled) { more.onclick(); h.flushFrame(); }
    assert.equal(rendered, 1000);
    assert.equal(paths, 1000);
    assert.equal(grid.children[0], original);
    assert.equal(grid.galleryZoomImagesAll, navigation);
    assert.equal(grid.children.length, 1000);
    wrapper.dispose();
});
