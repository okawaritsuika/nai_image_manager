const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createGalleryCardRecycler} = require('../static/gallery_recycling');
function setup(fixed = false) {
    class Element {
        constructor() { this.children = []; this.style = {}; }
        appendChild(child) { this.children.push(child); }
        replaceChildren() { this.children = []; }
        contains(child) { return this.children.includes(child); }
        getBoundingClientRect() { return {width: 200, height: this.children.length * 100}; }
    }
    let observer, resize;
    global.document = {activeElement: null, createElement: () => new Element()};
    global.getComputedStyle = () => ({gridTemplateColumns: '260px 260px 260px'});
    global.IntersectionObserver = class {
        constructor(callback) { this.callback = callback; this.targets = []; observer = this; }
        observe(target) { this.targets.push(target); }
        disconnect() { this.targets = []; }
    };
    global.ResizeObserver = class {
        constructor(callback) { this.callback = callback; resize = this; }
        observe() {} disconnect() { this.closed = true; }
    };
    const selected = new Set();
    const recycler = createGalleryCardRecycler({fixed, render(index, group) { group.appendChild({index, selected: selected.has(index)}); }});
    const host = new Element();
    return {host, selected, recycler, observer, resize, append(index) { recycler.append(index, {index}, host); }};
}
test('10000 cards release their nodes, preserve space, and remount the latest selection state', () => {
    const h = setup();
    for (let i = 0; i < 10000; i++) h.append(i);
    h.recycler.finish();
    h.observer.callback(h.observer.targets.map(target => ({target, isIntersecting: false})));
    assert.equal(h.host.children.reduce((n, g) => n + g.children.length, 0), 0);
    const group = h.host.children[200];
    assert.equal(group.style.height, '1600px');
    h.selected.add(group.indices[0]);
    h.observer.callback([{target: group, isIntersecting: true}]);
    assert.equal(group.children.length, 16);
    assert.equal(group.children[0].selected, true);
    assert.deepEqual(group.children.map(c => c.index), group.indices);
});
test('focused controls survive recycling and disposal prevents late remounts', () => {
    const h = setup(); for (let i = 0; i < 16; i++) h.append(i);
    const group = h.host.children[0];
    document.activeElement = group.children[0];
    h.observer.callback([{target: group, isIntersecting: false}]);
    assert.equal(group.children.length, 16);
    document.activeElement = null;
    h.observer.callback([{target: group, isIntersecting: false}]);
    h.resize.callback([{target: group, contentRect: {width: 100}}]);
    assert.equal(group.style.height, '800px');
    h.recycler.cleanup();
    h.observer.callback([{target: group, isIntersecting: true}]);
    assert.equal(group.children.length, 0);
    assert.equal(h.resize.closed, true);
});
test('fixed grids keep complete rows at group boundaries', () => {
    const h = setup(true); for (let i = 0; i < 32; i++) h.append(i);
    h.recycler.finish();
    assert.deepEqual(h.host.children.map(g => g.indices.length), [15, 15, 2]);
    h.recycler.cleanup();
});
