const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'static/project_zoom_compare.js'), 'utf8');

class Element {
    constructor(tagName = 'div', id = '') {
        this.tagName = tagName.toUpperCase();
        this.id = id;
        this.children = [];
        this.parentElement = null;
        this.style = {};
        this.attributes = {};
        this.listeners = new Map();
        this.classes = new Set();
        this.hidden = false;
        this.disabled = false;
        this._text = '';
        this.classList = {
            add: name => this.classes.add(name),
            remove: name => this.classes.delete(name),
            contains: name => this.classes.has(name),
            toggle: (name, force) => {
                const enabled = force === undefined ? !this.classes.has(name) : Boolean(force);
                if (enabled) this.classes.add(name);
                else this.classes.delete(name);
                return enabled;
            },
        };
        this.rect = null;
    }

    set className(value) {
        this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
    }

    get className() { return Array.from(this.classes).join(' '); }

    set textContent(value) {
        this._text = String(value ?? '');
        this.replaceChildren();
    }

    get textContent() {
        return this._text + this.children.map(child => child.textContent).join('');
    }

    append(...nodes) { nodes.forEach(node => this.appendChild(node)); }

    appendChild(node) {
        node.remove();
        node.parentElement = this;
        this.children.push(node);
        return node;
    }

    replaceChildren(...nodes) {
        this.children.forEach(child => { child.parentElement = null; });
        this.children = [];
        nodes.forEach(node => this.appendChild(node));
    }

    remove() {
        if (!this.parentElement) return;
        const parent = this.parentElement;
        parent.children = parent.children.filter(child => child !== this);
        this.parentElement = null;
    }

    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; if (name === 'src') this.src = ''; }

    addEventListener(type, callback, options) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push({callback, options});
    }

    dispatch(type, values = {}) {
        const event = {
            type,
            target: this,
            deltaY: 0,
            deltaMode: 0,
            defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; },
            stopPropagation() { this.stopped = true; },
            ...values,
        };
        let current = this;
        while (current) {
            for (const {callback} of current.listeners.get(type) || []) callback(event);
            if (event.stopped) break;
            current = current.parentElement;
        }
        return event;
    }

    closest(selector) {
        const className = selector.startsWith('.') ? selector.slice(1) : '';
        let current = this;
        while (current) {
            if (className && current.classList.contains(className)) return current;
            current = current.parentElement;
        }
        return null;
    }

    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

    querySelectorAll(selector) {
        const className = selector.startsWith('.') ? selector.slice(1) : '';
        const matches = [];
        const visit = node => {
            node.children.forEach(child => {
                if (className && child.classList.contains(className)) matches.push(child);
                visit(child);
            });
        };
        visit(this);
        return matches;
    }

    getBoundingClientRect() { return this.rect || {left: 0, top: 0, width: 0, height: 0}; }

    showModal() { this.open = true; this.modal = true; }
    close() { this.open = false; this.modal = false; }
    focus() { this.focused = true; }
}

function createCompare() {
    const layer = new Element('div', 'zoomLayer');
    layer.hidden = false;
    const controls = new Element('div', 'projectZoomCompareControls');
    controls.hidden = true;
    const stage = new Element('div', 'projectZoomCompareStage');
    stage.hidden = true;
    stage.rect = {left: 0, top: 0, width: 800, height: 500};
    const ids = new Map([[layer.id, layer], [controls.id, controls], [stage.id, stage]]);
    const observers = [];
    const resizeListeners = new Map();
    const document = {
        getElementById: id => ids.get(id) || null,
        createElement: tag => new Element(tag),
    };
    const window = {
        document,
        addEventListener(type, callback) {
            if (!resizeListeners.has(type)) resizeListeners.set(type, new Set());
            resizeListeners.get(type).add(callback);
        },
        removeEventListener(type, callback) { resizeListeners.get(type)?.delete(callback); },
        ResizeObserver: class {
            constructor(callback) { this.callback = callback; observers.push(this); }
            observe() {}
            disconnect() { this.disconnected = true; }
        },
    };
    vm.runInContext(source, vm.createContext({window, URL}));
    return {api: window.ProjectZoomCompare, layer, controls, stage, observers};
}

function findAll(root, className) {
    return root.querySelectorAll(`.${className}`);
}

function loadImage(image, width, height) {
    image.complete = true;
    image.naturalWidth = width;
    image.naturalHeight = height;
    image.onload();
}

function paneImages(stage) { return findAll(stage, 'project-zoom-compare-image'); }
function paneHeights(stage) { return paneImages(stage).map(image => parseFloat(image.style.height)); }

test('two comparison images drag independently and cancellation stops movement', () => {
    const view = createCompare();
    const images = [{path:'a.png',src:'/image/a.png'}, {path:'b.png',src:'/image/b.png'}];
    view.api.prepare({images,current:images[0],onSelect:()=>{}});
    view.api.setPinned(true);
    findAll(view.controls,'project-zoom-compare-add')[0].dispatch('click');
    findAll(view.controls,'project-zoom-compare-picker-item')[0].dispatch('click');
    const [a,b] = paneImages(view.stage);
    loadImage(a,300,900); loadImage(b,300,900);
    const viewport = findAll(view.stage,'project-zoom-compare-viewport')[1];
    viewport.dispatch('pointerdown',{button:0,pointerId:1,clientX:20,clientY:30});
    viewport.dispatch('pointermove',{pointerId:1,clientX:55,clientY:45});
    assert.equal(b.style.transform,'translate(35px, 15px)');
    assert.equal(a.style.transform,undefined);
    viewport.dispatch('pointercancel',{pointerId:1});
    viewport.dispatch('pointermove',{pointerId:1,clientX:90,clientY:90});
    assert.equal(b.style.transform,'translate(35px, 15px)');
    viewport.dispatch('pointerdown',{button:0,pointerId:2,clientX:20,clientY:30});
    view.api.close();
    viewport.dispatch('pointermove',{pointerId:2,clientX:90,clientY:90});
    assert.equal(b.style.transform,'translate(35px, 15px)');
});

test('project picker uses a modal dialog, preview URLs, and 36-item pages', () => {
    const view = createCompare();
    const images = Array.from({length: 40}, (_, index) => ({
        path: `image-${index}.png`,
        src: `/image/image-${index}.png?rev=1#view`,
        name: `Image ${index}`,
    }));
    view.api.prepare({images, current: images[0], onSelect: () => {}});
    view.api.setPinned(true);
    findAll(view.controls, 'project-zoom-compare-add')[0].dispatch('click');

    const dialog = findAll(view.controls, 'project-zoom-compare-picker')[0];
    assert.equal(dialog.tagName, 'DIALOG');
    assert.equal(dialog.modal, true);
    let choices = findAll(dialog, 'project-zoom-compare-picker-item');
    assert.equal(choices.length, 36);
    assert.equal(choices[0].children[0].src, '/image/image-1.png?rev=1&preview=256#view');
    assert.equal(paneImages(view.stage)[0].src, '/image/image-0.png?rev=1#view', 'comparison pane keeps the full image URL');

    choices[0].dispatch('click');
    assert.equal(findAll(dialog, 'project-zoom-compare-picker-item').length, 36, 'selecting an image updates only the page choices');
    findAll(dialog, 'project-zoom-compare-picker-next')[0].dispatch('click');
    choices = findAll(dialog, 'project-zoom-compare-picker-item');
    assert.equal(choices.length, 2);
    const lastPageItem = choices[0];
    findAll(dialog, 'project-zoom-compare-picker-previous')[0].dispatch('click');
    assert.equal(findAll(dialog, 'project-zoom-compare-picker-item').length, 36);
    findAll(dialog, 'project-zoom-compare-picker-next')[0].dispatch('click');
    assert.equal(findAll(dialog, 'project-zoom-compare-picker-item')[0], lastPageItem, 'cached card nodes are reused when changing pages');

    const cancel = dialog.dispatch('cancel');
    assert.equal(cancel.defaultPrevented, true);
    assert.equal(dialog.open, false);
    assert.equal(view.api.isPicking(), false);
    assert.equal(view.controls._compareAddButton.focused, true, 'closing the dialog returns focus to the add button');
});

test('project picker deduplicates, individual and synchronized zoom stay aligned, and height fit copies the selected height', () => {
    const view = createCompare();
    const selected = [];
    const images = [
        {path: 'a.png', src: '/a.png', name: 'A'},
        {path: 'b.png', src: '/b.png', name: 'B'},
        {path: 'b.png', src: '/b-duplicate.png', name: 'B duplicate'},
        {path: 'c.png', src: '/c.png', name: 'C'},
    ];
    assert.equal(view.api.prepare({images, current: images[0], onSelect: path => selected.push(path)}), true);
    assert.equal(view.api.getSelectedPath(), 'a.png');
    assert.equal(view.api.setPinned(true), true);
    assert.equal(view.stage.style.gridTemplateColumns, 'repeat(1, minmax(0, 1fr))');

    findAll(view.controls, 'project-zoom-compare-add')[0].dispatch('click');
    let choices = findAll(view.controls, 'project-zoom-compare-picker-item');
    assert.equal(choices.length, 2, 'one picker entry per unique project path, excluding the open image');
    choices.find(button => button.textContent.includes('B')).dispatch('click');
    assert.equal(view.api.getSelectedPath(), 'b.png');
    assert.equal(view.stage.style.gridTemplateColumns, 'repeat(2, minmax(0, 1fr))');
    assert.equal(selected.at(-1), 'b.png');

    let [imageA, imageB] = paneImages(view.stage);
    loadImage(imageA, 600, 800);
    loadImage(imageB, 800, 600);
    const initial = paneHeights(view.stage);
    assert.notEqual(initial[0], initial[1]);
    const wheel = view.stage.dispatch('wheel', {deltaY: -100});
    assert.equal(wheel.defaultPrevented, true);
    const individual = paneHeights(view.stage);
    assert.equal(individual[0], initial[0]);
    assert.ok(individual[1] > initial[1]);

    const sync = findAll(view.controls, 'project-zoom-compare-sync')[0];
    sync.dispatch('click');
    assert.equal(sync.attributes['aria-pressed'], 'true');
    assert.equal(sync.textContent, '동시 확대');
    assert.equal(paneHeights(view.stage)[0], paneHeights(view.stage)[1]);
    const beforeSyncedWheel = paneHeights(view.stage);
    view.stage.dispatch('wheel', {deltaY: -100});
    const afterSyncedWheel = paneHeights(view.stage);
    assert.ok(afterSyncedWheel[0] > beforeSyncedWheel[0]);
    assert.equal(afterSyncedWheel[0], afterSyncedWheel[1]);

    view.api.closePicker();
    findAll(view.controls, 'project-zoom-compare-add')[0].dispatch('click');
    choices = findAll(view.controls, 'project-zoom-compare-picker-item');
    choices.find(button => button.textContent.includes('C')).dispatch('click');
    const imageC = paneImages(view.stage)[2];
    loadImage(imageC, 400, 900);
    assert.deepEqual(paneHeights(view.stage), [paneHeights(view.stage)[0], paneHeights(view.stage)[0], paneHeights(view.stage)[0]],
        'an image added during synchronized zoom inherits the shared displayed height');

    sync.dispatch('click');
    const afterTurningSyncOff = paneHeights(view.stage);
    view.stage.dispatch('wheel', {deltaY: -100});
    const afterIndividualWheel = paneHeights(view.stage);
    assert.ok(afterIndividualWheel[2] > afterTurningSyncOff[2]);
    assert.equal(afterIndividualWheel[0], afterTurningSyncOff[0]);
    findAll(view.controls, 'project-zoom-compare-fit')[0].dispatch('click');
    assert.equal(new Set(paneHeights(view.stage)).size, 1, 'height fit copies the selected displayed height to every pane');
    assert.equal(view.stage.listeners.has('pointerdown'), false);
    assert.equal(view.stage.listeners.has('pointermove'), false);
});

test('remove, image error, and close clean up panes and ignore a late image load', () => {
    const view = createCompare();
    const images = [
        {path: 'a.png', src: '/a.png', name: 'A'},
        {path: 'b.png', src: '/b.png', name: 'B'},
    ];
    view.api.prepare({images, current: images[0], onSelect: () => {}});
    view.api.setPinned(true);
    const initialRemove = findAll(view.stage, 'project-zoom-compare-remove')[0];
    assert.equal(initialRemove.disabled, true, 'the last comparison pane cannot be removed');

    findAll(view.controls, 'project-zoom-compare-add')[0].dispatch('click');
    findAll(view.controls, 'project-zoom-compare-picker-item')[0].dispatch('click');
    const imagesInPanes = paneImages(view.stage);
    const lateLoad = imagesInPanes[1].onload;
    findAll(view.stage, 'project-zoom-compare-remove')[1].dispatch('click');
    assert.equal(paneImages(view.stage).length, 1);
    assert.equal(findAll(view.stage, 'project-zoom-compare-remove')[0].disabled, true);
    assert.equal(view.api.getSelectedPath(), 'a.png');

    const remainingImage = paneImages(view.stage)[0];
    remainingImage.onerror();
    assert.equal(findAll(view.stage, 'project-zoom-compare-error')[0].hidden, false);
    assert.equal(findAll(view.stage, 'project-zoom-compare-retry')[0].hidden, false);
    view.api.close();
    assert.equal(view.api.isActive(), false);
    assert.equal(view.controls.hidden, true);
    assert.equal(view.stage.hidden, true);
    assert.equal(paneImages(view.stage).length, 0);
    assert.equal(view.observers.at(-1).disconnected, true);

    lateLoad();
    assert.equal(paneImages(view.stage).length, 0, 'a removed pane load cannot restore stale image content');
    assert.equal(view.api.setPinned(true), false, 'closed compare state cannot be pinned without a new snapshot');
});
