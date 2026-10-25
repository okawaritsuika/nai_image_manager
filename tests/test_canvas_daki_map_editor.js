const assert = require('node:assert/strict');
const {test} = require('node:test');
const CanvasDakiMapEditor = require('../static/canvas_daki_map_editor.js');

function copy(value) {
    return JSON.parse(JSON.stringify(value));
}

const regions = [
    {id: 'whole', label: '전체', color: '#999'},
    {id: 'head', label: '머리', prompt: 'head', color: '#f44'},
    {id: 'arm', label: '팔', prompt: 'arm', color: '#44f'},
];
const defaults = {
    version: 1,
    front: {head: [{x: 0.2, y: 0.2, width: 0.4, height: 0.4}], arm: []},
    back: {head: [{x: 0.1, y: 0.1, width: 0.2, height: 0.2}], arm: [{x: 0.6, y: 0.2, width: 0.2, height: 0.3}]},
};

class FakeClassList {
    constructor(owner) { this.owner = owner; this.values = new Set(); }
    add(value) { this.values.add(value); }
    remove(value) { this.values.delete(value); }
    contains(value) { return this.values.has(value); }
    toggle(value, force) {
        const enabled = force === undefined ? !this.values.has(value) : Boolean(force);
        if (enabled) this.values.add(value); else this.values.delete(value);
        return enabled;
    }
}

class FakeStyle {
    setProperty(name, value) { this[name] = value; }
}

class FakeElement {
    constructor(tagName, doc) {
        this.tagName = tagName.toUpperCase();
        this.ownerDocument = doc;
        this.children = [];
        this.parentNode = null;
        this.dataset = {};
        this.attributes = new Map();
        this.listeners = new Map();
        this.style = new FakeStyle();
        this.classList = new FakeClassList(this);
        this.textContent = '';
        this.value = '';
        this.disabled = false;
        this.open = false;
        this.clientWidth = 0;
        this.clientHeight = 0;
    }
    set className(value) {
        this._className = value;
        this.classList.values = new Set(String(value).split(/\s+/).filter(Boolean));
    }
    get className() { return this._className || ''; }
    get firstChild() { return this.children[0] || null; }
    get isConnected() {
        let node = this;
        while (node) {
            if (node === this.ownerDocument.body) return true;
            node = node.parentNode;
        }
        return false;
    }
    append(...nodes) {
        for (const node of nodes) {
            if (node.parentNode) node.parentNode.removeChild(node);
            this.children.push(node);
            node.parentNode = this;
        }
    }
    removeChild(node) {
        const index = this.children.indexOf(node);
        if (index >= 0) this.children.splice(index, 1);
        node.parentNode = null;
        return node;
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(name, callback, options) {
        if (!this.listeners.has(name)) this.listeners.set(name, new Set());
        this.listeners.get(name).add({callback, capture: options === true || Boolean(options && options.capture)});
    }
    removeEventListener(name, callback, options) {
        const capture = options === true || Boolean(options && options.capture);
        for (const item of this.listeners.get(name) || []) {
            if (item.callback === callback && item.capture === capture) this.listeners.get(name).delete(item);
        }
    }
    dispatch(name, properties = {}) {
        const event = {
            type: name,
            target: this,
            defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; },
            stopPropagation() { this.propagationStopped = true; },
            ...properties,
        };
        const path = [];
        let node = this;
        while (node) { path.push(node); node = node.parentNode; }
        for (const current of path.slice().reverse()) {
            for (const item of current.listeners.get(name) || []) if (item.capture) item.callback(event);
            if (event.propagationStopped) break;
        }
        if (!event.propagationStopped) {
            for (const current of path) {
                for (const item of current.listeners.get(name) || []) if (!item.capture) item.callback(event);
                if (event.propagationStopped) break;
            }
        }
        return event;
    }
    focus() { this.ownerDocument.activeElement = this; }
    setPointerCapture(pointerId) { this.capturedPointerId = pointerId; }
    showModal() { this.open = true; }
    close() {
        this.open = false;
        for (const item of this.listeners.get('close') || []) item.callback({type: 'close', target: this});
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    getBoundingClientRect() {
        if (this.classList.contains('test-canvas-surface')) {
            return {left: 5, top: 7, width: this.clientWidth + 2 * this.clientLeft, height: this.clientHeight + 2 * this.clientTop};
        }
        if (this.classList.contains('canvas-daki-map-stage')) {
            return {left: 0, top: 0, width: this.ownerDocument.stageWidth, height: this.ownerDocument.stageHeight};
        }
        if (this.classList.contains('canvas-daki-map-frame')) {
            return {left: 0, top: 0, width: Number.parseFloat(this.style.width), height: Number.parseFloat(this.style.height)};
        }
        return {left: 0, top: 0, width: 0, height: 0};
    }
}

class FakeDocument {
    constructor() {
        this.stageWidth = 500;
        this.stageHeight = 300;
        this.body = new FakeElement('body', this);
        this.body.parentNode = this;
        this.listeners = new Map();
        this.activeElement = this.body;
        this.resizeObservers = [];
        this.defaultView = this;
        this.ResizeObserver = class {
            constructor(callback) { this.callback = callback; this.disconnected = false; this.target = null; }
            observe(target) { this.target = target; }
            disconnect() { this.disconnected = true; }
        };
    }
    createElement(tagName) {
        const node = new FakeElement(tagName, this);
        if (tagName === 'div') {
            const originalRect = node.getBoundingClientRect.bind(node);
            node.getBoundingClientRect = () => originalRect();
        }
        return node;
    }
    addEventListener(name, callback, options) {
        if (!this.listeners.has(name)) this.listeners.set(name, new Set());
        this.listeners.get(name).add({callback, capture: options === true || Boolean(options && options.capture)});
    }
    removeEventListener(name, callback, options) {
        const capture = options === true || Boolean(options && options.capture);
        for (const item of this.listeners.get(name) || []) {
            if (item.callback === callback && item.capture === capture) this.listeners.get(name).delete(item);
        }
    }
    dispatch(name, properties = {}) {
        const event = {type: name, target: this, defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; }, ...properties};
        for (const item of this.listeners.get(name) || []) item.callback(event);
        return event;
    }
}

function find(node, predicate) {
    if (predicate(node)) return node;
    for (const child of node.children) {
        const result = find(child, predicate);
        if (result) return result;
    }
    return null;
}

function byRole(root, role) {
    const node = find(root, item => item.dataset && item.dataset.role === role);
    assert.ok(node, `missing control ${role}`);
    return node;
}

function buttonByClass(root, className) {
    const node = find(root, item => item.classList && item.classList.contains(className));
    assert.ok(node, `missing button ${className}`);
    return node;
}

function setup() {
    const doc = new FakeDocument();
    const opener = doc.createElement('button');
    doc.body.append(opener);
    opener.focus();
    const observers = [];
    const oldDocument = global.document;
    const oldRegions = global.CanvasDakiRegions;
    global.document = doc;
    let customId = 0;
    global.CanvasDakiRegions = {
        REGIONS: regions,
        defaultMap: () => copy(defaults),
        normalizeMap: value => copy(value && typeof value === 'object' ? value : defaults),
        listRegions: map => regions.concat((map && map.customRegions || []).map(region => ({...region, custom: true}))),
        addCustomRegion: (map, spec) => {
            const label = String(spec.label || '').trim();
            if (!label) throw new Error('이름을 입력해 주세요.');
            if (label.length > 60) throw new Error('이름은 60자 이내로 입력해 주세요.');
            if (regions.some(region => region.label.toLowerCase() === label.toLowerCase())
                || (map.customRegions || []).some(region => region.label.toLowerCase() === label.toLowerCase())) {
                throw new Error('이미 사용 중인 이름입니다.');
            }
            const result = copy(map);
            const region = {id: `custom-test-${++customId}`, label, baseRegion: spec.baseRegion || 'whole', prompt: spec.prompt || '', color: '#22c55e'};
            result.customRegions = [...(result.customRegions || []), region];
            result.front[region.id] = [];
            result.back[region.id] = [];
            return {map: result, region};
        },
    };
    global.ResizeObserver = class {
        constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
        observe(target) { this.target = target; }
        disconnect() { this.disconnected = true; }
    };
    const restore = () => {
        CanvasDakiMapEditor.close();
        global.document = oldDocument;
        global.CanvasDakiRegions = oldRegions;
        delete global.ResizeObserver;
    };
    return {doc, opener, observers, restore};
}

function pointer(target, name, x, y, pointerId = 1) {
    return target.dispatch(name, {target, pointerId, clientX: x, clientY: y, button: 0});
}

function inlineHosts(doc) {
    const panelHost = doc.createElement('div');
    const overlayHost = doc.createElement('div');
    const surface = doc.createElement('div');
    surface.className = 'test-canvas-surface';
    surface.offsetLeft = 5;
    surface.offsetTop = 7;
    surface.clientLeft = 2;
    surface.clientTop = 3;
    surface.clientWidth = 320;
    surface.clientHeight = 640;
    overlayHost.append(surface);
    doc.body.append(panelHost, overlayHost);
    return {panelHost, overlayHost, surface, canvasSurface: surface};
}

test('cancel and Escape keep the input map unchanged, dispose listeners, and restore focus once', () => {
    const h = setup();
    try {
        const input = copy(defaults);
        let saves = 0;
        const closes = [];
        const dialog = CanvasDakiMapEditor.open({map: input, side: 'back', width: 1000, height: 500,
            preview: 'data:image/png;base64,synthetic', onSave: () => saves++, onClose: value => closes.push(value)});
        const add = buttonByClass(dialog, 'canvas-daki-map-add');
        add.dispatch('click');
        assert.equal(input.front.head.length, 1);
        assert.equal(dialog.open, true);
        const observer = h.observers[0];
        const escape = dialog.dispatch('keydown', {key: 'Escape'});
        assert.equal(escape.defaultPrevented, true);
        assert.equal(saves, 0);
        assert.deepEqual(input, defaults);
        assert.deepEqual(closes, [{applied: false}]);
        assert.equal(observer.disconnected, true);
        assert.equal(dialog.parentNode, null);
        assert.equal(h.doc.activeElement, h.opener);
    } finally {
        h.restore();
    }
});

test('Apply returns an edited deep clone with percentage coordinates', () => {
    const h = setup();
    try {
        const input = copy(defaults);
        let saved = null;
        const closes = [];
        const dialog = CanvasDakiMapEditor.open({map: input, side: 'front', width: 1000, height: 500,
            onSave: map => { saved = map; }, onClose: value => closes.push(value)});
        const x = byRole(dialog, 'x');
        assert.equal(x.parentNode.children[0].textContent, 'X (%)');
        x.value = '48.5';
        x.dispatch('input');
        assert.equal(x.value, '48.5');
        buttonByClass(dialog, 'canvas-daki-map-apply').dispatch('click');
        assert.equal(saved.front.head[0].x, 0.485);
        assert.notEqual(saved, input);
        assert.notEqual(saved.front, input.front);
        assert.equal(input.front.head[0].x, 0.2);
        assert.deepEqual(closes, [{applied: true}]);
        assert.equal(h.doc.activeElement, h.opener);
    } finally {
        h.restore();
    }
});

test('zoom scales the image frame without changing normalized overlay coordinates', () => {
    const h = setup();
    try {
        const dialog = CanvasDakiMapEditor.open({map: copy(defaults), width: 1000, height: 500});
        const zoom = byRole(dialog, 'zoom');
        const frame = find(dialog, node => node.classList && node.classList.contains('canvas-daki-map-frame'));
        const rect = find(dialog, node => node.dataset.regionId === 'head' && node.dataset.rectIndex === '0');
        zoom.value = '2';
        zoom.dispatch('change');
        assert.equal(frame.style.width, '1000px');
        assert.equal(frame.style.height, '500px');
        assert.equal(rect.style.left, '20%');
        assert.equal(rect.style.top, '20%');
        assert.equal(rect.style.width, '40%');
        assert.equal(rect.style.height, '40%');
    } finally {
        h.restore();
    }
});

test('zoom centers the selected rectangle and clamps scroll to finite nonnegative bounds', () => {
    const h = setup();
    try {
        const dialog = CanvasDakiMapEditor.open({map: copy(defaults), width: 1000, height: 500});
        const stage = find(dialog, node => node.classList && node.classList.contains('canvas-daki-map-stage'));
        const x = byRole(dialog, 'x');
        const y = byRole(dialog, 'y');
        x.value = '90';
        x.dispatch('input');
        y.value = '90';
        y.dispatch('input');
        buttonByClass(dialog, 'canvas-daki-map-focus-selection').dispatch('click');
        assert.equal(stage.scrollLeft, 500);
        assert.equal(stage.scrollTop, 200);
        assert.ok(Number.isFinite(stage.scrollLeft) && stage.scrollLeft >= 0);
        assert.ok(Number.isFinite(stage.scrollTop) && stage.scrollTop >= 0);
    } finally {
        h.restore();
    }
});

test('pointer movement at zoom uses the enlarged frame dimensions', () => {
    const h = setup();
    try {
        let saved;
        const dialog = CanvasDakiMapEditor.open({map: copy(defaults), width: 1000, height: 500,
            onSave: map => { saved = map; }});
        byRole(dialog, 'zoom').value = '2';
        byRole(dialog, 'zoom').dispatch('change');
        const overlay = find(dialog, node => node.classList && node.classList.contains('canvas-daki-map-overlays'));
        const rect = find(overlay, node => node.dataset.regionId === 'head' && node.dataset.rectIndex === '0');
        pointer(rect, 'pointerdown', 0, 0);
        pointer(overlay, 'pointermove', 100, 50);
        pointer(overlay, 'pointerup', 100, 50);
        buttonByClass(dialog, 'canvas-daki-map-apply').dispatch('click');
        assert.deepEqual(saved.front.head[0], {x: 0.3, y: 0.3, width: 0.4, height: 0.4});
    } finally {
        h.restore();
    }
});

test('zoomed pointerdown preserves the current scroll position for rectangles and handles', () => {
    const h = setup();
    try {
        let saved;
        const dialog = CanvasDakiMapEditor.open({map: copy(defaults), width: 1000, height: 500,
            onSave: map => { saved = map; }});
        byRole(dialog, 'zoom').value = '2';
        byRole(dialog, 'zoom').dispatch('change');
        const stage = find(dialog, node => node.classList && node.classList.contains('canvas-daki-map-stage'));
        const overlay = find(dialog, node => node.classList && node.classList.contains('canvas-daki-map-overlays'));
        stage.scrollLeft = 120;
        stage.scrollTop = 40;
        let rect = find(overlay, node => node.dataset.regionId === 'head' && node.dataset.rectIndex === '0');
        pointer(rect, 'pointerdown', 10, 20);
        assert.equal(stage.scrollLeft, 120);
        assert.equal(stage.scrollTop, 40);
        pointer(overlay, 'pointermove', 110, 70);
        pointer(overlay, 'pointerup', 110, 70);

        rect = find(overlay, node => node.dataset.regionId === 'head' && node.dataset.rectIndex === '0');
        const southeast = find(rect, node => node.dataset.corner === 'se');
        stage.scrollLeft = 200;
        stage.scrollTop = 80;
        pointer(southeast, 'pointerdown', 10, 20, 2);
        assert.equal(stage.scrollLeft, 200);
        assert.equal(stage.scrollTop, 80);
        pointer(overlay, 'pointermove', 110, 70, 2);
        pointer(overlay, 'pointerup', 110, 70, 2);
        buttonByClass(dialog, 'canvas-daki-map-apply').dispatch('click');
        assert.deepEqual(saved.front.head[0], {x: 0.3, y: 0.3, width: 0.5, height: 0.5});
    } finally {
        h.restore();
    }
});

test('resizing the preview recalculates fit dimensions without changing the map', () => {
    const h = setup();
    try {
        let saved;
        const input = copy(defaults);
        const dialog = CanvasDakiMapEditor.open({map: input, width: 1000, height: 500,
            onSave: map => { saved = map; }});
        const frame = find(dialog, node => node.classList && node.classList.contains('canvas-daki-map-frame'));
        byRole(dialog, 'zoom').value = '2';
        byRole(dialog, 'zoom').dispatch('change');
        h.doc.stageWidth = 600;
        h.doc.stageHeight = 400;
        h.observers[0].callback();
        assert.equal(frame.style.width, '1200px');
        assert.equal(frame.style.height, '600px');
        buttonByClass(dialog, 'canvas-daki-map-apply').dispatch('click');
        assert.deepEqual(saved, defaults);
        assert.deepEqual(input, defaults);
    } finally {
        h.restore();
    }
});

test('a valid initial region is selected and an unknown region falls back to the first region', () => {
    const h = setup();
    try {
        let dialog = CanvasDakiMapEditor.open({map: copy(defaults), region: 'arm'});
        assert.equal(byRole(dialog, 'part').value, 'arm');
        CanvasDakiMapEditor.close();
        dialog = CanvasDakiMapEditor.open({map: copy(defaults), region: 'unknown'});
        assert.equal(byRole(dialog, 'part').value, 'head');
    } finally {
        h.restore();
    }
});

test('cancel after zoom never saves the edited map', () => {
    const h = setup();
    try {
        let saves = 0;
        const input = copy(defaults);
        const dialog = CanvasDakiMapEditor.open({map: input, width: 1000, height: 500,
            onSave: () => saves++});
        byRole(dialog, 'zoom').value = '3';
        byRole(dialog, 'zoom').dispatch('change');
        buttonByClass(dialog, 'canvas-daki-map-cancel').dispatch('click');
        assert.equal(saves, 0);
        assert.deepEqual(input, defaults);
    } finally {
        h.restore();
    }
});

test('add/remove enforce eight rectangles and front/back parts keep independent values', () => {
    const h = setup();
    try {
        const input = copy(defaults);
        const dialog = CanvasDakiMapEditor.open({map: input, width: 1000, height: 500});
        const part = byRole(dialog, 'part');
        part.value = 'arm';
        part.dispatch('change');
        const add = buttonByClass(dialog, 'canvas-daki-map-add');
        for (let i = 0; i < 8; i++) add.dispatch('click');
        assert.equal(add.disabled, true);
        assert.equal(byRole(dialog, 'rect').children.length, 8);
        buttonByClass(dialog, 'canvas-daki-map-remove').dispatch('click');
        assert.equal(add.disabled, false);
        assert.equal(input.front.arm.length, 0);

        const side = byRole(dialog, 'side');
        side.value = 'back';
        side.dispatch('change');
        part.value = 'arm';
        part.dispatch('change');
        assert.equal(byRole(dialog, 'rect').children.length, 1);
        assert.equal(byRole(dialog, 'x').value, '60');
        buttonByClass(dialog, 'canvas-daki-map-apply').dispatch('click');
        assert.equal(input.front.arm.length, 0);
        assert.equal(input.back.arm[0].x, 0.6);
    } finally {
        h.restore();
    }
});

test('pointer drag moves and resizes rectangles in normalized frame coordinates', () => {
    const h = setup();
    try {
        let saved;
        const dialog = CanvasDakiMapEditor.open({map: copy(defaults), width: 1000, height: 500,
            onSave: map => { saved = map; }});
        const overlay = find(dialog, node => node.classList && node.classList.contains('canvas-daki-map-overlays'));
        let rect = find(overlay, node => node.dataset.regionId === 'head' && node.dataset.rectIndex === '0');
        pointer(rect, 'pointerdown', 10, 10);
        pointer(overlay, 'pointermove', 60, 35);
        pointer(overlay, 'pointerup', 60, 35);
        rect = find(overlay, node => node.dataset.regionId === 'head' && node.dataset.rectIndex === '0');
        assert.ok(Math.abs(Number.parseFloat(rect.style.left) - 30) < 0.001);
        assert.ok(Math.abs(Number.parseFloat(rect.style.top) - 30) < 0.001);

        const southeast = find(rect, node => node.dataset.corner === 'se');
        assert.ok(southeast);
        pointer(southeast, 'pointerdown', 100, 100, 2);
        pointer(overlay, 'pointermove', 200, 150, 2);
        pointer(overlay, 'pointerup', 200, 150, 2);
        rect = find(overlay, node => node.dataset.regionId === 'head' && node.dataset.rectIndex === '0');
        assert.equal(rect.style.width, '60%');
        assert.equal(rect.style.height, '60%');
        buttonByClass(dialog, 'canvas-daki-map-apply').dispatch('click');
        assert.deepEqual(saved.front.head[0], {x: 0.3, y: 0.3, width: 0.6, height: 0.6});
    } finally {
        h.restore();
    }
});

test('pointercancel rolls back its drag and the default button resets only the selected side and part', () => {
    const h = setup();
    try {
        let saved;
        const dialog = CanvasDakiMapEditor.open({map: copy(defaults), width: 1000, height: 500,
            onSave: map => { saved = map; }});
        const side = byRole(dialog, 'side');
        side.value = 'back';
        side.dispatch('change');
        const x = byRole(dialog, 'x');
        x.value = '90';
        x.dispatch('change');
        buttonByClass(dialog, 'canvas-daki-map-reset').dispatch('click');
        assert.equal(byRole(dialog, 'x').value, '10');

        const overlay = find(dialog, node => node.classList && node.classList.contains('canvas-daki-map-overlays'));
        const rect = find(overlay, node => node.dataset.regionId === 'head' && node.dataset.rectIndex === '0');
        pointer(rect, 'pointerdown', 100, 100, 8);
        pointer(overlay, 'pointermove', 200, 150, 8);
        pointer(overlay, 'pointercancel', 200, 150, 8);
        buttonByClass(dialog, 'canvas-daki-map-apply').dispatch('click');
        assert.equal(saved.back.head[0].x, 0.1);
        assert.equal(saved.front.head[0].x, 0.2);
    } finally {
        h.restore();
    }
});

test('reopen closes the prior editor once, disconnects its observer, and public close is safe', () => {
    const h = setup();
    try {
        const oldCloses = [];
        const first = CanvasDakiMapEditor.open({map: copy(defaults), onClose: value => oldCloses.push(value)});
        const oldObserver = h.observers[0];
        const secondCloses = [];
        const second = CanvasDakiMapEditor.open({map: copy(defaults), onClose: value => secondCloses.push(value)});
        assert.equal(first.parentNode, null);
        assert.equal(oldObserver.disconnected, true);
        assert.deepEqual(oldCloses, [{applied: false}]);
        assert.equal(second.open, true);
        CanvasDakiMapEditor.close();
        CanvasDakiMapEditor.close();
        assert.deepEqual(secondCloses, [{applied: false}]);
        assert.equal(h.doc.activeElement, h.opener);
    } finally {
        h.restore();
    }
});

test('keyboard and clipboard events stay inside the dialog without cancelling native defaults', () => {
    const h = setup();
    try {
        const dialog = CanvasDakiMapEditor.open({map: copy(defaults)});
        const receivedByBody = [];
        for (const eventName of ['keydown', 'paste', 'copy', 'cut']) {
            h.doc.body.addEventListener(eventName, () => receivedByBody.push(eventName));
        }
        const input = byRole(dialog, 'x');
        const key = input.dispatch('keydown', {key: '7'});
        assert.equal(key.defaultPrevented, false);
        for (const eventName of ['paste', 'copy', 'cut']) {
            const event = input.dispatch(eventName);
            assert.equal(event.defaultPrevented, false);
        }
        assert.deepEqual(receivedByBody, []);
    } finally {
        h.restore();
    }
});

test('only rectangles for the selected part are drawn and changing parts removes the previous hit targets', () => {
    const h = setup();
    try {
        const dialog = CanvasDakiMapEditor.open({map: copy(defaults), region: 'head'});
        const overlay = find(dialog, node => node.classList && node.classList.contains('canvas-daki-map-overlays'));
        assert.deepEqual(overlay.children.map(node => node.dataset.regionId), ['head']);
        const part = byRole(dialog, 'part');
        part.value = 'arm';
        part.dispatch('change');
        assert.deepEqual(overlay.children.map(node => node.dataset.regionId), []);
        const message = find(dialog, node => node.classList && node.classList.contains('canvas-daki-map-empty'));
        assert.equal(message.hidden, false);
        part.value = 'head';
        part.dispatch('change');
        assert.deepEqual(overlay.children.map(node => node.dataset.regionId), ['head']);
    } finally {
        h.restore();
    }
});

test('inline mode edits the existing surface with aligned overlay and disposes only its own nodes', () => {
    const h = setup();
    try {
        const {panelHost, overlayHost, surface} = inlineHosts(h.doc);
        const originalSurfaceChildren = surface.children.slice();
        const closes = [];
        const panel = CanvasDakiMapEditor.open({map: copy(defaults), region: 'head', side: 'front',
            panelHost, canvasSurface: surface, overlayHost, onClose: value => closes.push(value)});
        const overlay = find(overlayHost, node => node.classList && node.classList.contains('canvas-daki-map-inline-overlay'));
        assert.equal(panel.tagName, 'SECTION');
        assert.equal(panel.classList.contains('canvas-daki-map-inline'), true);
        assert.equal(panel.getAttribute('aria-label'), '부위 지도 편집');
        assert.equal(find(panel, node => node.tagName === 'IMG'), null);
        assert.equal(panelHost.children.length, 1);
        assert.equal(overlay.parentNode, overlayHost);
        assert.equal(overlay.style.left, '7px');
        assert.equal(overlay.style.top, '10px');
        assert.equal(overlay.style.width, '320px');
        assert.equal(overlay.style.height, '640px');
        assert.equal(h.observers[0].target, surface);
        assert.equal(h.observers[0].disconnected, false);
        assert.deepEqual(overlay.children.map(node => node.dataset.regionId), ['head']);
        assert.equal(CanvasDakiMapEditor.isOpen(), true);

        surface.offsetLeft = 11;
        surface.offsetTop = 13;
        surface.clientWidth = 400;
        surface.clientHeight = 800;
        CanvasDakiMapEditor.sync();
        assert.equal(overlay.style.left, '13px');
        assert.equal(overlay.style.top, '16px');
        assert.equal(overlay.style.width, '400px');
        assert.equal(overlay.style.height, '800px');

        CanvasDakiMapEditor.close();
        assert.equal(panel.parentNode, null);
        assert.equal(overlay.parentNode, null);
        assert.deepEqual(surface.children, originalSurfaceChildren);
        assert.equal(h.observers[0].disconnected, true);
        assert.deepEqual(closes, [{applied: false}]);
        assert.equal(CanvasDakiMapEditor.isOpen(), false);
    } finally {
        h.restore();
    }
});

test('inline zoom, focus and wheel controls call the canvas owner callbacks', () => {
    const h = setup();
    try {
        const hosts = inlineHosts(h.doc);
        const zooms = [], focused = [], wheels = [];
        const panel = CanvasDakiMapEditor.open({map: copy(defaults), region: 'head',
            ...hosts, onZoom: value => zooms.push(value), onFocus: rect => focused.push(rect),
            onWheel: event => { wheels.push(event.deltaY); event.preventDefault(); }});
        buttonByClass(panel, 'canvas-daki-map-zoom-out').dispatch('click');
        buttonByClass(panel, 'canvas-daki-map-zoom-in').dispatch('click');
        buttonByClass(panel, 'canvas-daki-map-focus-selection').dispatch('click');
        assert.deepEqual(zooms, [-1, 1]);
        assert.deepEqual(focused, [defaults.front.head[0]]);
        const overlay = find(hosts.overlayHost, node => node.classList && node.classList.contains('canvas-daki-map-inline-overlay'));
        const wheel = overlay.dispatch('wheel', {deltaY: 120});
        assert.deepEqual(wheels, [120]);
        assert.equal(wheel.defaultPrevented, true);

        const stageEvents = [];
        hosts.overlayHost.addEventListener('pointerdown', event => stageEvents.push(event.target));
        const rect = overlay.children[0];
        const down = pointer(rect, 'pointerdown', 10, 10);
        assert.equal(down.defaultPrevented, true);
        assert.deepEqual(stageEvents, []);
        pointer(overlay, 'pointerdown', 10, 10, 2);
        assert.equal(stageEvents.length, 1);
    } finally {
        h.restore();
    }
});

test('inline document guards cancel Escape and are removed when the editor closes', () => {
    const h = setup();
    try {
        const hosts = inlineHosts(h.doc);
        const panel = CanvasDakiMapEditor.open({map: copy(defaults), ...hosts});
        const overlay = find(hosts.overlayHost, node => node.classList && node.classList.contains('canvas-daki-map-inline-overlay'));
        assert.equal(h.doc.listeners.get('keydown').size, 1);
        assert.equal(h.doc.listeners.get('paste').size, 1);
        const selectRect = overlay.children[0].dispatch('keydown', {key: 'Enter'});
        assert.equal(selectRect.defaultPrevented, true);
        assert.equal(selectRect.propagationStopped, true);
        assert.equal(panel.parentNode, hosts.panelHost);
        const escape = overlay.dispatch('keydown', {key: 'Escape'});
        assert.equal(escape.defaultPrevented, true);
        assert.equal(escape.propagationStopped, true);
        assert.equal(panel.parentNode, null);
        assert.equal(h.doc.listeners.get('keydown').size, 0);
        assert.equal(h.doc.listeners.get('paste').size, 0);
    } finally {
        h.restore();
    }
});

test('custom parts copy the current rectangle on the active side and stay isolated until Apply', () => {
    const h = setup();
    try {
        const input = copy(defaults);
        const dialog = CanvasDakiMapEditor.open({map: input, region: 'head'});
        buttonByClass(dialog, 'canvas-daki-map-add-custom').dispatch('click');
        byRole(dialog, 'custom-label').value = '허벅지';
        byRole(dialog, 'custom-base').value = 'arm';
        byRole(dialog, 'custom-prompt').value = 'close-up of the thigh';
        byRole(dialog, 'custom-label').parentNode.parentNode.dispatch('submit');
        const customId = byRole(dialog, 'part').value;
        assert.match(customId, /^custom-test-/);
        assert.equal(byRole(dialog, 'part').children.at(-1).textContent, '허벅지');
        assert.equal(buttonByClass(dialog, 'canvas-daki-map-reset').disabled, true);
        assert.equal(find(dialog, node => node.classList && node.classList.contains('canvas-daki-map-note')).textContent, '직접 추가한 부위입니다.');

        const side = byRole(dialog, 'side');
        side.value = 'back';
        side.dispatch('change');
        assert.equal(find(dialog, node => node.classList && node.classList.contains('canvas-daki-map-empty')).hidden, false);
        side.value = 'front';
        side.dispatch('change');
        const overlay = find(dialog, node => node.classList && node.classList.contains('canvas-daki-map-overlays'));
        assert.deepEqual(overlay.children.map(node => node.dataset.regionId), [customId]);
        assert.deepEqual(input, defaults);
        buttonByClass(dialog, 'canvas-daki-map-cancel').dispatch('click');
        assert.deepEqual(input, defaults);
    } finally {
        h.restore();
    }
});

test('custom part form reports blank and duplicate names without clearing typed values', () => {
    const h = setup();
    try {
        const dialog = CanvasDakiMapEditor.open({map: copy(defaults)});
        buttonByClass(dialog, 'canvas-daki-map-add-custom').dispatch('click');
        const label = byRole(dialog, 'custom-label');
        const form = label.parentNode.parentNode;
        form.dispatch('submit');
        const error = find(dialog, node => node.classList && node.classList.contains('canvas-daki-map-custom-error'));
        assert.equal(error.getAttribute('role'), 'alert');
        assert.equal(error.textContent, '이름을 입력해 주세요.');
        assert.equal(form.hidden, false);
        label.value = '머리';
        form.dispatch('submit');
        assert.equal(error.textContent, '이미 사용 중인 이름입니다.');
        assert.equal(label.value, '머리');
        assert.equal(form.hidden, false);
    } finally {
        h.restore();
    }
});
