const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const RetouchState = require('../static/canvas_retouch_state.js');

const controllerSource = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas_retouch.js'), 'utf8');

class FakeClassList {
    constructor() { this.values = new Set(); }
    add(value) { this.values.add(value); }
    remove(value) { this.values.delete(value); }
    contains(value) { return this.values.has(value); }
}

class FakeElement {
    constructor(tagName, ownerDocument) {
        this.tagName = String(tagName).toUpperCase();
        this.ownerDocument = ownerDocument;
        this.children = [];
        this.parentNode = null;
        this.listeners = new Map();
        this.attributes = new Map();
        this.pointerCaptures = new Set();
        this.classList = new FakeClassList();
        this.style = {};
        this.hidden = false;
        this.inert = false;
        this.width = 0;
        this.height = 0;
        this.offsetLeft = 0;
        this.offsetTop = 0;
        this.clientLeft = 0;
        this.clientTop = 0;
        this.clientWidth = 640;
        this.clientHeight = 480;
        this.contextOperations = {drawImage: [], getImageData: [], putImageData: []};
        const operations = this.contextOperations;
        this.context2d = {
            clearRect() {}, drawImage(...args) {operations.drawImage.push(args);}, save() {}, beginPath() {}, rect() {}, clip() {}, restore() {},
            moveTo() {}, lineTo() {}, stroke() {}, fill() {}, ellipse() {}, strokeRect() {}, setLineDash() {},
            getImageData(x = 0, y = 0, width = 1, height = 1) {
                const imageWidth = Math.max(1, Math.floor(Number(width) || 1));
                const imageHeight = Math.max(1, Math.floor(Number(height) || 1));
                const data = new Uint8ClampedArray(imageWidth * imageHeight * 4);
                for (let row = 0; row < imageHeight; row += 1) {
                    for (let column = 0; column < imageWidth; column += 1) {
                        const index = (row * imageWidth + column) * 4;
                        data[index] = (Number(x) + column) % 251;
                        data[index + 1] = (Number(y) + row) % 251;
                        data[index + 2] = (Number(x) + Number(y) + column + row) % 251;
                        data[index + 3] = 255;
                    }
                }
                const imageData = {x, y, width: imageWidth, height: imageHeight, data, canvas: thisElement};
                operations.getImageData.push(imageData);
                return imageData;
            },
            putImageData(...args) {operations.putImageData.push(args);}
        };
        const thisElement = this;
    }
    append(...nodes) {
        for (const node of nodes) {
            if (node.parentNode) node.parentNode.removeChild(node);
            node.parentNode = this;
            this.children.push(node);
        }
    }
    appendChild(node) { this.append(node); return node; }
    removeChild(node) {
        const index = this.children.indexOf(node);
        if (index >= 0) this.children.splice(index, 1);
        node.parentNode = null;
        return node;
    }
    remove() { this.parentNode?.removeChild(this); }
    addEventListener(type, callback, options) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push([callback, options]);
    }
    dispatch(type, event = {}) {
        const dispatched = {target: this, defaultPrevented: false, propagationStopped: false,
            preventDefault() {this.defaultPrevented = true;}, stopPropagation() {this.propagationStopped = true;}, ...event};
        for (const [callback] of this.listeners.get(type) || []) callback(dispatched);
        return dispatched;
    }
    removeEventListener(type, callback) {
        const list = this.listeners.get(type) || [];
        this.listeners.set(type, list.filter(item => item[0] !== callback));
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    getContext() { return this.context2d; }
    getBoundingClientRect() { return {left: 0, top: 0, width: this.clientWidth || 1, height: this.clientHeight || 1}; }
    showModal() { this.open = true; }
    close() { this.open = false; this.dispatch('close'); }
    click() { this.clicked = true; }
    focus() { this.focused = true; }
    setPointerCapture(pointerId) { this.pointerCaptures.add(pointerId); }
    hasPointerCapture(pointerId) { return this.pointerCaptures.has(pointerId); }
    releasePointerCapture(pointerId) {
        if (this.pointerCaptures.delete(pointerId)) this.dispatch('lostpointercapture', {pointerId});
    }
}

class FakeDocument {
    constructor() {
        this.body = new FakeElement('body', this);
        this.listeners = new Map();
        this.toolbar = new FakeElement('div', this);
        this.toolbar.className = 'canvas-toolbar';
        this.createdElements = [];
    }
    createElement(tagName) {
        const element = new FakeElement(tagName, this);
        this.createdElements.push(element);
        return element;
    }
    getElementById(id) {
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
    querySelector(selector) { return selector === '.canvas-toolbar' ? this.toolbar : null; }
    addEventListener(type, callback, options) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push([callback, options]);
    }
    dispatch(type, event = {}) {
        const dispatched = {target: this, defaultPrevented: false, propagationStopped: false,
            preventDefault() {this.defaultPrevented = true;}, stopPropagation() {this.propagationStopped = true;}, ...event};
        for (const [callback] of this.listeners.get(type) || []) callback(dispatched);
        return dispatched;
    }
    removeEventListener(type, callback) {
        const list = this.listeners.get(type) || [];
        this.listeners.set(type, list.filter(item => item[0] !== callback));
    }
}

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
    return {promise, resolve, reject};
}

function makeLiquifyEngine(counters) {
    return {
        create(stroke, imageData, documentWidth, documentHeight, options = {}) {
            const call = {stroke: structuredClone(stroke), imageData, documentWidth, documentHeight, options: {...options}};
            counters.liquifyCreates.push(call);
            let processedPointCount = 0;
            return {
                append(points) {
                    const snapshot = Array.isArray(points) ? points.map(point => Array.isArray(point) ? point.slice() : point) : points;
                    counters.liquifyAppends.push({call, points: snapshot});
                    let maskAllows = !options.mask;
                    if (options.mask) {
                        for (let index = 0; index < options.mask.length; index += 4) {
                            if (options.mask[index] > 0) {maskAllows = true; break;}
                        }
                    }
                    const hasNewPoints = Array.isArray(points) && points.length > processedPointCount;
                    if (Array.isArray(points)) processedPointCount = Math.max(processedPointCount, points.length);
                    if (hasNewPoints && Number(options.opacity ?? 1) > 0 && maskAllows) {
                        imageData.data[0] = (imageData.data[0] + 1) % 256;
                        return {left: 0, top: 0, right: 1, bottom: 1};
                    }
                    return null;
                }
            };
        }
    };
}

function makeDocument(overrides = {}) {
    return {
        version: 1,
        source: '/api/canvas/imports/synthetic-source.png',
        width: 1200,
        height: 800,
        layers: [],
        print: {widthCm: 50, heightCm: 160, safeMm: 5},
        notes: '',
        checks: [],
        ...overrides
    };
}

function makeThreeCorrectionLayers() {
    return [
        RetouchState.createLayer('tone', () => 'tone-a'),
        RetouchState.createLayer('tone', () => 'tone-b'),
        RetouchState.createLayer('color', () => 'color-c')
    ];
}

function selectedIdsFor(panel) {
    return Array.from(panel.latest?.selectedIds || []);
}

function createHarness({layers = [], activeLayerId = null, fetchHandler = null, renderHandler = null, saveHandler = null,
    holdTimerDelays = [], workspaceBridge = null, liquifyEngine = true} = {}) {
    const document = new FakeDocument();
    const host = document.createElement('aside'); host.id = 'canvasRetouchPanel'; host.hidden = true;
    const surface = document.createElement('div'); surface.id = 'canvasSurface';
    const stage = document.createElement('div'); stage.id = 'canvasStage';
    const opposite = document.createElement('img'); opposite.id = 'canvasOppositePreviewImage'; opposite.src = '';
    const oppositeWrap = document.createElement('div'); oppositeWrap.id = 'canvasOppositePreview'; oppositeWrap.hidden = true;
    document.body.append(host, surface, stage, opposite, oppositeWrap);

    const counters = {
        mergedCalls: [], savedSources: [], canvasSaves: 0, layerRenders: 0, surfaceRenders: 0,
        eraserCalls: [], fetchCalls: [], externalCalls: [], bitmaps: [], panels: [], toasts: [],
        liquifyCreates: [], liquifyAppends: []
    };
    let nextLayerId = 100;
    let timerId = 0;
    const timers = new Map();
    let frameId = 0;
    const frames = new Map();
    const heldTimerDelays = new Set([100, ...holdTimerDelays]);
    let clock = 1000;
    let bitmapId = 0;
    const sandbox = {
        console,
        Date: class extends Date {static now() {return clock;}},
        addEventListener: document.addEventListener.bind(document),
        removeEventListener: document.removeEventListener.bind(document),
        document,
        CanvasRetouchState: RetouchState,
        CanvasRetouchLiquify: liquifyEngine ? makeLiquifyEngine(counters) : null,
        CanvasWorkspaceBridge: workspaceBridge,
        currentCanvasWidth: 1200,
        currentCanvasHeight: 800,
        canvasLayers: layers,
        activeLayerId,
        activeLayerIds: new Set(),
        selectedLayerIds: new Set(),
        layerIdSeq: 100,
        setCanvasLayerEraserEnabled(value) { counters.eraserCalls.push(value); },
        findCanvasLayer(id) { return {layer: sandbox.canvasLayers.find(layer => layer.id === id) || null}; },
        saveCanvasState() { counters.canvasSaves += 1; },
        renderLayerList() { counters.layerRenders += 1; },
        renderCanvasLayersOnSurface() { counters.surfaceRenders += 1; },
        renderMergedCanvasToDataUrl(...args) {
            counters.mergedCalls.push(args);
            return renderHandler ? renderHandler(...args) : Promise.resolve('data:image/png;base64,bWVyZ2Vk');
        },
        saveClipDataUrlToServer(data, options) {
            counters.savedSources.push({data, options});
            return saveHandler ? saveHandler(data, options) : Promise.resolve('/api/canvas/imports/retouch-snapshot.png');
        },
        CanvasRetouchPanel: {
            create(panelHost, actions) {
                const panel = {
                    host: panelHost,
                    actions,
                    latest: null,
                    updates: [],
                    destroyed: false,
                    updatesAfterDestroy: 0,
                    update(view) {
                        if (this.destroyed) this.updatesAfterDestroy += 1;
                        this.latest = view;
                        this.updates.push({busy: view.busy, error: view.error, doc: view.doc && structuredClone(view.doc)});
                    },
                    destroy() {this.destroyed = true;}
                };
                counters.panels.push(panel);
                return panel;
            }
        },
        CanvasDakiMapEditor: {close() {}},
        CanvasDakiFocus: {refresh() {}},
        CanvasProject: null,
        CanvasOppositeReference: null,
        showToast(message) { counters.toasts.push(message); },
        handleCanvasWheelZoom() {},
        setTimeout(callback, delay = 0) {
            const id = ++timerId;
            timers.set(id, {callback, delay});
            if (!heldTimerDelays.has(delay)) queueMicrotask(() => runTimer(id));
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        requestAnimationFrame(callback) {
            const id = ++frameId;
            frames.set(id, callback);
            return id;
        },
        cancelAnimationFrame(id) {frames.delete(id);},
        ResizeObserver: class { observe() {} disconnect() {} },
        createImageBitmap: async blob => {
            const bitmap = {id: ++bitmapId, width: 1200, height: 800, blob, closeCount: 0, close() {this.closeCount += 1;}};
            counters.bitmaps.push(bitmap);
            return bitmap;
        },
        fetch: async (url, options = {}) => {
            counters.fetchCalls.push({url, options, body: options.body ? JSON.parse(options.body) : undefined});
            const localRetouch = String(url).startsWith('/api/canvas/retouch/');
            const localProject = String(url).startsWith('/api/daki/projects/');
            if (!localRetouch && !localProject) {
                counters.externalCalls.push(url);
                throw new Error('Unexpected non-local API call: ' + url);
            }
            if (fetchHandler) return fetchHandler(url, options, counters);
            if (url.endsWith('/preview') || url.endsWith('/mask')) return {ok: true, blob: async () => ({url})};
            if (url.endsWith('/apply')) return {ok: true, json: async () => ({job: {id: 'job-1', status: 'done', result: {src: '/api/canvas/retouch/results/result.png'}}})};
            if (String(url).includes('/jobs/')) return {ok: true, json: async () => ({job: {id: 'job-1', status: 'done', result: {src: '/api/canvas/retouch/results/result.png'}}})};
            throw new Error('Unexpected retouch request: ' + url);
        },
        queueMicrotask,
        AbortController,
        structuredClone,
        URL: {
            createObjectURL: () => 'blob:retouch-test-' + (bitmapId + 1),
            revokeObjectURL() {}
        },
        window: null
    };
    function runTimer(id) {
        const timer = timers.get(id);
        if (!timer) return false;
        timers.delete(id); timer.callback(); return true;
    }
    sandbox.window = sandbox;
    const context = vm.createContext(sandbox);
    vm.runInContext(controllerSource, context, {filename: 'canvas_retouch.js'});

    async function settle(rounds = 12) {
        for (let index = 0; index < rounds; index += 1) {
            await Promise.resolve();
            await new Promise(resolve => setImmediate(resolve));
        }
    }
    async function waitFor(predicate, message = 'expected controller state was not reached') {
        for (let index = 0; index < 80; index += 1) {
            if (predicate()) return;
            await new Promise(resolve => setImmediate(resolve));
        }
        assert.fail(message);
    }
    return {context, sandbox, document, host, surface, stage, counters, controller: sandbox.CanvasRetouch,
        advanceTime(ms) {clock += ms;},
        settle, waitFor, setLayers(value) {sandbox.canvasLayers = value;},
        setDimensions(width, height) {sandbox.currentCanvasWidth = width; sandbox.currentCanvasHeight = height;},
        pendingTimers(delay) {return Array.from(timers.values()).filter(timer => delay === undefined || timer.delay === delay).length;},
        timerIds(delay) {return Array.from(timers.entries()).filter(([, timer]) => delay === undefined || timer.delay === delay).map(([id]) => id);},
        pendingFrames() {return frames.size;},
        runFrames() {
            const ready = Array.from(frames.entries());
            let ran = 0;
            for (const [id, callback] of ready) {
                if (!frames.delete(id)) continue;
                ran += 1;
                callback(clock);
            }
            return ran;
        },
        runTimers(delay) {
            const ids = Array.from(timers.entries()).filter(([, timer]) => delay === undefined || timer.delay === delay).map(([id]) => id);
            return ids.reduce((count, id) => count + Number(runTimer(id)), 0);
        }};
}

async function prepareLiquify(h) {
    await h.controller.open();
    await h.settle();
    const panel = h.counters.panels.at(-1);
    panel.actions.setTool('liquify');
    await h.settle();
    return {panel, overlay: h.stage.children[0], layer: h.controller.snapshot().document.layers.at(-1)};
}

function sendStrokePoint(overlay, type, pointerId, clientX, clientY) {
    overlay.dispatch(type, {button: 0, pointerId, clientX, clientY});
}

test('open snapshots the whole merged canvas once and stores its local source', async () => {
    const originalLayers = [
        {id: 1, type: 'image', name: 'base', src: '/canvas-imports/base.png', x: 0, y: 0, layerWidth: 1200, layerHeight: 800},
        {id: 2, type: 'text', text: 'synthetic note', x: 40, y: 30}
    ];
    const before = structuredClone(originalLayers);
    const h = createHarness({layers: originalLayers});
    await h.controller.open();
    await h.settle();

    assert.equal(h.counters.mergedCalls.length, 1);
    assert.deepEqual(h.counters.mergedCalls[0], []);
    assert.equal(h.counters.savedSources.length, 1);
    assert.equal(h.counters.savedSources[0].data, 'data:image/png;base64,bWVyZ2Vk');
    assert.equal(h.counters.savedSources[0].options.category, 'retouch');
    assert.equal(h.counters.canvasSaves, 1);
    assert.equal(h.controller.snapshot().document.source, '/api/canvas/imports/retouch-snapshot.png');
    assert.deepEqual(h.controller.snapshot().document.layers, []);
    assert.deepEqual(originalLayers, before);
    assert.ok(h.counters.fetchCalls.some(call => call.url.endsWith('/preview') && call.body.source === '/api/canvas/imports/retouch-snapshot.png'));
    assert.deepEqual(h.counters.externalCalls, []);
});

test('skin presets create empty local painting layers and keep global corrections explicit', async () => {
    const h = createHarness();
    await h.controller.open(); await h.settle();
    const panel = h.counters.panels.at(-1);
    panel.actions.preset('rose'); await h.settle();
    let layer = h.controller.snapshot().document.layers.at(-1);
    assert.equal(layer.name, '장밋빛 혈색');
    assert.equal(layer.type, 'paint');
    assert.equal(layer.params.mode, 'color');
    assert.equal(layer.strokes.length, 0);
    assert.equal(panel.latest.tool, 'airbrush');
    assert.equal(panel.latest.brush.flow, 4);
    panel.actions.setTool('maskAdd');
    assert.equal(panel.latest.brush.flow, 100);
    panel.actions.setTool('airbrush');
    assert.equal(panel.latest.brush.flow, 4, 'mask opacity must not turn airbrush into opaque paint');
    panel.actions.setTool('maskErase');
    assert.deepEqual([panel.latest.brush.size, panel.latest.brush.flow, panel.latest.brush.hardness], [160, 100, 0]);
    panel.actions.brush('size', 240);
    panel.actions.brush('flow', 37);
    panel.actions.brush('hardness', 22);
    panel.actions.setTool('maskErase');
    assert.deepEqual([panel.latest.brush.size, panel.latest.brush.flow, panel.latest.brush.hardness], [240, 37, 22]);
    panel.actions.setTool('airbrush');
    assert.deepEqual([panel.latest.brush.size, panel.latest.brush.flow, panel.latest.brush.hardness], [160, 4, 0],
        'leaving the eraser restores the airbrush settings');
    panel.actions.setTool('maskErase');
    assert.deepEqual([panel.latest.brush.size, panel.latest.brush.flow, panel.latest.brush.hardness], [240, 37, 22],
        'returning to the eraser restores its own settings');
    panel.actions.setTool('airbrush');
    assert.equal(panel.latest.brush.flow, 4);
    panel.actions.setTool('maskErase');
    assert.deepEqual([panel.latest.brush.size, panel.latest.brush.flow, panel.latest.brush.hardness], [240, 37, 22]);
    panel.actions.preset('peach'); await h.settle();
    layer = h.controller.snapshot().document.layers.at(-1);
    assert.equal(layer.name, '복숭아빛 온기');
    assert.equal(panel.latest.selectedId, layer.id);
    assert.equal(panel.latest.tool, 'airbrush');
    assert.deepEqual([panel.latest.brush.size, panel.latest.brush.flow, panel.latest.brush.hardness, panel.latest.brush.color],
        [160, 4, 0, '#ed9a78']);
    panel.actions.setTool('maskErase');
    assert.deepEqual([panel.latest.brush.size, panel.latest.brush.flow, panel.latest.brush.hardness], [240, 37, 22]);
    panel.actions.preset('vivid'); await h.settle();
    layer = h.controller.snapshot().document.layers.at(-1);
    assert.equal(layer.type, 'tone');
    assert.equal(layer.params.vibrance, 18);
    assert.equal(layer.params.brightness, 0);
    assert.equal(panel.latest.tool, 'hand');
    const before = h.controller.snapshot();
    panel.actions.preset('unknown');
    assert.deepEqual(h.controller.snapshot(), before);
    h.controller.close();
});

test('workspace panes share copied tone settings without copying strokes or masks', async () => {
    const shared = {value: null};
    const workspaceBridge = {
        isPane: true,
        report() {},
        readRetouchSettings() { return shared.value ? structuredClone(shared.value) : null; },
        writeRetouchSettings(value) { shared.value = value ? structuredClone(value) : null; return true; },
    };
    const front = createHarness({workspaceBridge});
    const back = createHarness({workspaceBridge});
    await front.controller.open(); await front.settle();
    await back.controller.open(); await back.settle();
    const frontPanel = front.counters.panels.at(-1), backPanel = back.counters.panels.at(-1);

    frontPanel.actions.preset('natural'); await front.settle();
    frontPanel.actions.change({params: {brightness: 17}}); await front.settle();
    const sourceLayer = frontPanel.latest.doc.layers.at(-1);
    sourceLayer.strokes = [{brush: 'airbrush', points: [[1, 2], [3, 4]]}];
    sourceLayer.mask = {
        base: 0,
        strokes: [{tool: 'maskAdd', points: [[5, 6], [7, 8]]}],
        shape: {kind: 'polygon', points: [[1, 1], [2, 2], [3, 1]]},
    };
    const frontBeforePaste = front.controller.snapshot();
    frontPanel.actions.copy();
    await front.settle();
    assert.equal(shared.value.params.brightness, 17);
    assert.equal(shared.value.params.contrast, 2);
    assert.equal(shared.value.params.vibrance, 8);
    assert.deepEqual(shared.value.strokes, []);
    assert.deepEqual(shared.value.mask, {base: 0, strokes: []});

    assert.equal(backPanel.latest.hasCopy, false);
    back.controller.refreshControls();
    assert.equal(backPanel.latest.hasCopy, true);
    backPanel.actions.paste(); await back.settle();

    const pasted = back.controller.snapshot().document.layers;
    assert.equal(pasted.length, 1);
    assert.equal(pasted[0].params.brightness, 17);
    assert.equal(pasted[0].params.contrast, 2);
    assert.equal(pasted[0].params.vibrance, 8);
    assert.deepEqual(pasted[0].strokes, []);
    assert.deepEqual(pasted[0].mask, {base: 0, strokes: []});
    assert.equal(Object.hasOwn(pasted[0].mask, 'shape'), false);
    assert.deepEqual(front.controller.snapshot(), frontBeforePaste, 'pasting into the back pane does not alter the front pane');
});

test('single-canvas copy and paste keep using the local clipboard', async () => {
    const h = createHarness();
    await h.controller.open(); await h.settle();
    const panel = h.counters.panels.at(-1);
    panel.actions.preset('natural'); await h.settle();
    panel.actions.change({params: {brightness: 12}}); await h.settle();
    const original = h.controller.snapshot().document.layers[0];
    panel.actions.copy(); await h.settle();
    assert.equal(panel.latest.hasCopy, true);

    panel.actions.paste(); await h.settle();
    const layers = h.controller.snapshot().document.layers;
    assert.equal(layers.length, 2);
    assert.notEqual(layers[0].id, layers[1].id);
    assert.equal(layers[1].params.brightness, original.params.brightness);
    assert.equal(layers[1].params.contrast, original.params.contrast);
    assert.equal(layers[1].params.vibrance, original.params.vibrance);
    assert.deepEqual(layers[1].strokes, []);
    assert.equal(h.counters.externalCalls.length, 0);
    h.controller.close();
});

test('a complete preset adds all layers with chosen strength as one undo step and restores them', async () => {
    const h = createHarness();
    await h.controller.open(); await h.settle();
    const panel = h.counters.panels.at(-1);
    panel.actions.preset('rose'); await h.settle();
    const before = h.controller.snapshot();
    panel.actions.preset('warm-look', .5); await h.settle();
    const saved = h.controller.snapshot(), added = saved.document.layers.slice(1);
    assert.equal(added.length, 2);
    assert.equal(added[0].params.contrast, 2);
    assert.equal(added[0].params.vibrance, 4);
    assert.equal(added[1].opacity, .0175);
    assert.equal(panel.latest.selectedId, added[0].id);
    assert.equal(panel.latest.tool, 'hand');
    panel.actions.undo(); await h.settle();
    assert.deepEqual(h.controller.snapshot().document, before.document);
    panel.actions.redo(); await h.settle();
    assert.deepEqual(h.controller.snapshot().document, saved.document);
    h.controller.close(); h.controller.restore(saved);
    await h.controller.open(); await h.settle();
    assert.deepEqual(h.controller.snapshot().document, saved.document);
    h.controller.close();
});

test('multi-layer preset capacity is checked before any mutation and local strength reaches the brush', async () => {
    const h = createHarness();
    await h.controller.open(); await h.settle();
    const panel = h.counters.panels.at(-1);
    panel.actions.preset('rose', .5); await h.settle();
    assert.equal(panel.latest.brush.flow, 2);
    for (let i = 1; i < 39; i++) panel.actions.add('tone');
    await h.settle();
    const before = h.controller.snapshot(), saves = h.counters.canvasSaves;
    panel.actions.preset('warm-look'); await h.settle();
    assert.deepEqual(h.controller.snapshot(), before);
    assert.equal(h.counters.canvasSaves, saves);
    assert.match(panel.latest.message, /2개 레이어/);
    panel.actions.preset('natural'); await h.settle();
    assert.equal(h.controller.snapshot().document.layers.length, 40);
    h.controller.close();
});

test('recipe selection adds ordered stages as one undo step and keeps the eight-stage default', async () => {
    const h = createHarness({holdTimerDelays: [60]});
    await h.controller.open(); await h.settle();
    const panel = h.counters.panels.at(-1);
    const beforeEmpty = h.controller.snapshot();
    const savesBeforeEmpty = h.counters.canvasSaves;
    panel.actions.recipe([]);
    assert.deepEqual(h.controller.snapshot(), beforeEmpty);
    assert.equal(h.counters.canvasSaves, savesBeforeEmpty, 'an empty selection does not save');

    panel.actions.recipe(['sharpen', 'tone', 'tone']);
    const selected = h.controller.snapshot().document.layers;
    assert.deepEqual(selected.map(layer => layer.type), ['tone', 'sharpen']);
    assert.equal(h.counters.canvasSaves, savesBeforeEmpty + 1);
    panel.actions.undo();
    assert.equal(h.controller.snapshot().document.layers.length, 0, 'all selected stages undo together');
    panel.actions.redo();
    assert.deepEqual(h.controller.snapshot().document.layers.map(layer => layer.type), ['tone', 'sharpen']);

    panel.actions.recipe();
    const defaultStages = h.controller.snapshot().document.layers.slice(2);
    assert.equal(defaultStages.length, 8);
    assert.deepEqual(defaultStages.map(layer => layer.name), RetouchState.RECIPE_STEPS.map(step => step.label));
    h.controller.close();
});

test('recipe capacity allows one stage at 39 and rejects two without mutation', async () => {
    const layers = Array.from({length: 39}, (_, index) => RetouchState.createLayer('tone', () => `existing-${index}`));
    const h = createHarness({holdTimerDelays: [60]});
    h.controller.restore({document: makeDocument({layers}), targetLayerId: null});
    await h.controller.open(); await h.settle();
    const panel = h.counters.panels.at(-1);

    panel.actions.recipe(['tone']);
    assert.equal(h.controller.snapshot().document.layers.length, 40);
    panel.actions.undo();
    assert.equal(h.controller.snapshot().document.layers.length, 39);
    const beforeRejected = h.controller.snapshot();
    const savesBeforeRejected = h.counters.canvasSaves;
    panel.actions.recipe(['sharpen', 'tone']);
    assert.deepEqual(h.controller.snapshot(), beforeRejected);
    assert.equal(h.counters.canvasSaves, savesBeforeRejected);
    assert.match(panel.latest.message, /선택한 2단계/);
    h.controller.close();
});

test('Shift selects and toggles individual layers without changing saved document or history', async () => {
    const pendingApply = deferred();
    let applyStarted = false;
    const layers = makeThreeCorrectionLayers();
    const h = createHarness({holdTimerDelays: [60], fetchHandler: async (url, options) => {
        if (url.endsWith('/apply')) {applyStarted = true; return pendingApply.promise;}
        return url.endsWith('/preview') || url.endsWith('/mask')
            ? {ok: true, blob: async () => ({url})}
            : {ok: true, json: async () => ({job: {id: 'busy-selection', status: 'done', result: {src: '/result.png'}}})};
    }});
    h.controller.restore({document: makeDocument({layers}), targetLayerId: null});
    await h.controller.open(); await h.settle();
    const panel = h.counters.panels.at(-1), savedBefore = h.controller.snapshot();
    const savesBefore = h.counters.canvasSaves;
    assert.deepEqual(selectedIdsFor(panel), ['color-c']);
    panel.actions.select('missing-layer', {shiftKey: true});
    assert.deepEqual(selectedIdsFor(panel), ['color-c'], 'unknown IDs are ignored');
    panel.actions.select('tone-a');
    panel.actions.select('tone-b', {shiftKey: true});
    assert.deepEqual(selectedIdsFor(panel), ['tone-a', 'tone-b']);
    assert.equal(panel.latest.selectedId, 'tone-b');
    panel.actions.select('tone-a', {shiftKey: true});
    assert.deepEqual(selectedIdsFor(panel), ['tone-b'], 'Shift toggles an existing individual selection off');
    panel.actions.select('tone-b', {shiftKey: true});
    assert.deepEqual(selectedIdsFor(panel), ['tone-b'], 'the final selected layer cannot be toggled off');
    panel.actions.select('color-c');
    assert.deepEqual(selectedIdsFor(panel), ['color-c'], 'ordinary selection returns to one layer');

    assert.deepEqual(h.controller.snapshot(), savedBefore);
    assert.equal(Object.hasOwn(savedBefore, 'selectedIds'), false, 'selection stays out of the saved snapshot');
    assert.equal(h.counters.canvasSaves, savesBefore);
    assert.equal(panel.latest.canUndo, false, 'selection does not create a history entry');
    panel.actions.undo();
    assert.deepEqual(h.controller.snapshot(), savedBefore);
    assert.equal(panel.latest.canUndo, false);

    panel.actions.apply();
    await h.waitFor(() => applyStarted, 'apply did not enter its busy state');
    const selectedBeforeBusy = selectedIdsFor(panel);
    const activeBeforeBusy = panel.latest.selectedId;
    panel.actions.select('tone-a', {shiftKey: true});
    assert.deepEqual(selectedIdsFor(panel), selectedBeforeBusy, 'selection is ignored while busy');
    assert.equal(panel.latest.selectedId, activeBeforeBusy);
    pendingApply.resolve({ok: true, json: async () => ({job: {id: 'busy-selection', status: 'done', result: {src: '/result.png'}}})});
    await h.waitFor(() => !h.controller.isOpen(), 'held apply did not finish');
});

test('preview scheduling keeps the first 60ms timer and sends the latest edit', async () => {
    const h = createHarness({holdTimerDelays: [60]});
    await h.controller.open(); await h.settle();
    const panel = h.counters.panels.at(-1);
    panel.actions.add('tone');
    const firstTimer = h.timerIds(60);
    assert.equal(firstTimer.length, 1);

    for (const brightness of [3, 7, 13]) panel.actions.change({params: {brightness}});
    assert.deepEqual(h.timerIds(60), firstTimer, 'later input does not restart the first preview timer');
    assert.equal(h.pendingTimers(60), 1);
    const previousRequests = h.counters.fetchCalls.filter(call => call.url.endsWith('/preview')).length;
    h.runTimers(60);
    await h.waitFor(() => h.counters.fetchCalls.filter(call => call.url.endsWith('/preview')).length > previousRequests);
    await h.settle();

    const editedRequests = h.counters.fetchCalls.filter(call => call.url.endsWith('/preview') && call.body.layers.length);
    assert.equal(editedRequests.length, 1);
    assert.equal(editedRequests[0].body.layers[0].params.brightness, 13);
    assert.equal(h.controller.snapshot().document.layers[0].params.brightness, 13);
    h.controller.close();
});

test('an in-flight preview displays its intermediate result then sends one latest queued snapshot', async () => {
    const held = deferred();
    let heldSignal = null;
    const h = createHarness({holdTimerDelays: [60], fetchHandler: async (url, options) => {
        if (url.endsWith('/preview')) {
            const body = JSON.parse(options.body);
            if (body.layers.length && !heldSignal) {heldSignal = options.signal; return held.promise;}
            return {ok: true, blob: async () => ({url})};
        }
        return {ok: true, blob: async () => ({url})};
    }});
    await h.controller.open(); await h.settle();
    const panel = h.counters.panels.at(-1);
    panel.actions.add('tone');
    h.runTimers(60);
    await h.waitFor(() => heldSignal, 'the edited preview was not held in flight');
    const imageCanvas = h.stage.children[0].children[0];
    const drawsBeforeCompletion = imageCanvas.contextOperations.drawImage.length;

    for (const brightness of [2, 6, 11]) panel.actions.change({params: {brightness}});
    assert.equal(h.pendingTimers(60), 0, 'queued edits do not start concurrent preview work');
    assert.equal(h.counters.fetchCalls.filter(call => call.url.endsWith('/preview') && call.body.layers.length).length, 1);
    assert.equal(h.controller.snapshot().document.layers[0].params.brightness, 11);

    held.resolve({ok: true, blob: async () => ({url: 'intermediate-preview'})});
    await h.waitFor(() => h.pendingTimers(60) === 1, 'latest edit was not scheduled after the in-flight response');
    assert.ok(imageCanvas.contextOperations.drawImage.length > drawsBeforeCompletion,
        'the completed intermediate bitmap is drawn while the queued edit waits');
    h.runTimers(60);
    await h.waitFor(() => h.counters.fetchCalls.some(call => call.url.endsWith('/preview')
        && call.body.layers[0]?.params.brightness === 11), 'the queued request did not capture the latest edit');
    await h.settle();

    const editedRequests = h.counters.fetchCalls.filter(call => call.url.endsWith('/preview') && call.body.layers.length);
    assert.equal(editedRequests.length, 2, 'several changes collapse into one latest follow-up request');
    assert.equal(editedRequests[0].body.layers[0].params.brightness, 0);
    assert.equal(editedRequests[1].body.layers[0].params.brightness, 11);
    assert.equal(h.controller.snapshot().document.layers[0].params.brightness, 11, 'an older response does not overwrite document state');
    h.controller.close();
});

test('airbrush paints color instead of adjustment masks, accumulates dwell, and supports undo', async () => {
    const h = createHarness();
    await h.controller.open(); await h.settle();
    const panel = h.counters.panels.at(-1);
    panel.actions.add('tone'); await h.settle();
    panel.actions.setTool('airbrush'); await h.settle();
    panel.actions.brush('flow', 8); panel.actions.brush('color', '#ed9a78');
    const overlay = h.stage.children[0];
    assert.equal(h.controller.snapshot().document.layers.at(-1).type, 'paint');
    const initialSaves = h.counters.canvasSaves;
    const initialRequests = h.counters.fetchCalls.length;
    overlay.dispatch('pointerdown', {button:0, pointerId:4, clientX:160, clientY:180});
    assert.equal(h.pendingTimers(100), 1);
    h.advanceTime(100); h.runTimers(100);
    assert.equal(h.counters.canvasSaves, initialSaves, 'dwell is one undoable stroke, not many saves');
    assert.equal(h.counters.fetchCalls.length, initialRequests, 'live spraying does not request server previews');
    overlay.dispatch('pointerup', {pointerId:4, clientX:160, clientY:180});
    let layer = h.controller.snapshot().document.layers.at(-1);
    assert.equal(layer.mask.strokes.length, 0);
    assert.equal(layer.strokes.length, 1);
    assert.equal(layer.strokes[0].brush, 'airbrush');
    assert.equal(layer.strokes[0].flow, .08);
    assert.equal(layer.strokes[0].points.length, 2);
    assert.equal(h.pendingTimers(100), 0);
    panel.actions.undo(); await h.settle();
    assert.equal(h.controller.snapshot().document.layers.at(-1).strokes.length, 0);
    panel.actions.redo(); await h.settle();
    assert.equal(h.controller.snapshot().document.layers.at(-1).strokes[0].brush, 'airbrush');
    const saved = h.controller.snapshot(); h.controller.close(); h.controller.restore(saved);
    await h.controller.open(); await h.settle();
    assert.equal(h.controller.snapshot().document.layers.at(-1).strokes[0].flow, .08);
    const reopened = h.counters.panels.at(-1);
    reopened.actions.setTool('airbrush');
    assert.equal(reopened.latest.brush.flow, 8);
    assert.equal(reopened.latest.brush.color, '#ed9a78');
    h.controller.close();
});

test('soft mask eraser changes only the selected layer and keeps separate brush settings', async () => {
    const h = createHarness();
    await h.controller.open(); await h.settle();
    const panel = h.counters.panels.at(-1);
    panel.actions.add('tone'); await h.settle();
    const selectedId = h.controller.snapshot().document.layers.at(-1).id;
    panel.actions.add('tone'); await h.settle();
    const otherLayer = h.controller.snapshot().document.layers.at(-1);
    const otherMask = structuredClone(otherLayer.mask);
    panel.actions.select(selectedId); await h.settle();
    const selectedDraftLayer = panel.latest.doc.layers.find(layer => layer.id === selectedId);
    selectedDraftLayer.mask.shape = {kind: 'rect', box: [10, 20, 60, 80]};
    selectedDraftLayer.mask.strokes.push({
        points: [[15, 25]], radius: 12, hardness: .3, opacity: .4, color: '#e6baa4', mode: 'normal', erase: false,
    });
    const selectedMaskBefore = structuredClone(selectedDraftLayer.mask);
    panel.actions.brush('size', 240);
    panel.actions.brush('flow', 7);
    panel.actions.brush('hardness', 31);
    panel.actions.brush('color', '#d1a080');
    panel.actions.brush('opacity', 78);

    panel.actions.setTool('maskErase');
    assert.equal(panel.latest.brush.size, 240);
    assert.equal(panel.latest.brush.flow, 100);
    assert.equal(panel.latest.brush.hardness, 0);
    assert.deepEqual([panel.latest.brush.color, panel.latest.brush.opacity], ['#d1a080', 78]);
    const overlay = h.stage.children[0];
    overlay.dispatch('pointerdown', {button:0, pointerId:81, clientX:120, clientY:130});
    overlay.dispatch('pointerup', {pointerId:81, clientX:120, clientY:130});
    let document = h.controller.snapshot().document;
    let selected = document.layers.find(layer => layer.id === selectedId);
    let untouched = document.layers.find(layer => layer.id === otherLayer.id);
    assert.deepEqual(selected.mask.shape, selectedMaskBefore.shape);
    assert.deepEqual(selected.mask.strokes[0], selectedMaskBefore.strokes[0]);
    assert.equal(selected.mask.strokes.length, 2);
    assert.equal(selected.mask.strokes[1].erase, true);
    assert.equal(selected.mask.strokes[1].radius, 120);
    assert.equal(selected.mask.strokes[1].hardness, 0);
    assert.equal(selected.mask.strokes[1].opacity, 1);
    assert.deepEqual(untouched.mask, otherMask);

    panel.actions.undo(); await h.settle();
    assert.equal(h.controller.snapshot().document.layers.find(layer => layer.id === selectedId).mask.strokes.length, 1);
    panel.actions.redo(); await h.settle();
    assert.equal(h.controller.snapshot().document.layers.find(layer => layer.id === selectedId).mask.strokes[1].erase, true);

    panel.actions.brush('size', 180);
    panel.actions.brush('flow', 35);
    panel.actions.brush('hardness', 55);
    panel.actions.setTool('maskErase');
    assert.deepEqual([panel.latest.brush.size, panel.latest.brush.flow, panel.latest.brush.hardness], [180, 35, 55]);
    overlay.dispatch('pointerdown', {button:0, pointerId:82, clientX:140, clientY:150});
    overlay.dispatch('pointerup', {pointerId:82, clientX:140, clientY:150});
    document = h.controller.snapshot().document;
    selected = document.layers.find(layer => layer.id === selectedId);
    untouched = document.layers.find(layer => layer.id === otherLayer.id);
    assert.deepEqual(selected.mask.strokes.map(stroke => [stroke.erase, stroke.radius, stroke.opacity, stroke.hardness]), [
        [false, 12, .4, .3], [true, 120, 1, 0], [true, 90, .35, .55],
    ]);
    assert.deepEqual(selected.mask.shape, selectedMaskBefore.shape);
    assert.deepEqual(untouched.mask, otherMask);

    panel.actions.setTool('hand');
    assert.deepEqual([panel.latest.brush.size, panel.latest.brush.flow, panel.latest.brush.hardness], [240, 7, 31]);
    panel.actions.brush('color', '#aabbcc');
    panel.actions.brush('opacity', 65);
    panel.actions.setTool('maskErase');
    assert.deepEqual([panel.latest.brush.size, panel.latest.brush.flow, panel.latest.brush.hardness], [180, 35, 55]);
    assert.deepEqual([panel.latest.brush.color, panel.latest.brush.opacity], ['#aabbcc', 65]);
    h.controller.close();
});

test('mask eraser previews and commits one independent stroke to every selected layer', async () => {
    const layers = makeThreeCorrectionLayers();
    layers[1].visible = false;
    const h = createHarness({holdTimerDelays: [60]});
    h.controller.restore({document: makeDocument({layers}), targetLayerId: null});
    await h.controller.open(); await h.settle();
    const panel = h.counters.panels.at(-1), overlay = h.stage.children[0];
    panel.actions.select('tone-a');
    panel.actions.select('tone-b', {shiftKey: true});
    assert.deepEqual(selectedIdsFor(panel), ['tone-a', 'tone-b']);
    panel.actions.setTool('maskErase');
    panel.actions.brush('size', 100);
    panel.actions.brush('flow', 37);
    panel.actions.brush('hardness', 65);
    const savesBefore = h.counters.canvasSaves;

    sendStrokePoint(overlay, 'pointerdown', 141, 120, 120);
    sendStrokePoint(overlay, 'pointermove', 141, 160, 120);
    panel.actions.select('color-c', {shiftKey: true});
    assert.deepEqual(selectedIdsFor(panel), ['tone-a', 'tone-b'], 'selection is fixed during a stroke');
    h.runTimers(60);
    await h.waitFor(() => h.counters.fetchCalls.some(call => call.url.endsWith('/preview')
        && call.body.layers.find(layer => layer.id === 'tone-a')?.mask.strokes.length === 1),
    'preview did not apply the temporary stroke to the first selected layer');
    const preview = h.counters.fetchCalls.filter(call => call.url.endsWith('/preview')
        && call.body.layers.find(layer => layer.id === 'tone-a')?.mask.strokes.length === 1).at(-1).body;
    const firstPreviewStroke = preview.layers.find(layer => layer.id === 'tone-a').mask.strokes[0];
    const secondPreviewStroke = preview.layers.find(layer => layer.id === 'tone-b').mask.strokes[0];
    assert.deepEqual(firstPreviewStroke, secondPreviewStroke);
    assert.notEqual(firstPreviewStroke, secondPreviewStroke, 'preview targets receive independent stroke objects');
    assert.equal(firstPreviewStroke.erase, true);
    assert.equal(firstPreviewStroke.radius, 50);
    assert.equal(firstPreviewStroke.hardness, .65);
    assert.equal(firstPreviewStroke.opacity, .37);
    assert.deepEqual(firstPreviewStroke.points, [[225, 200], [300, 200]]);
    assert.equal(preview.layers.find(layer => layer.id === 'color-c').mask.strokes.length, 0);
    assert.equal(h.controller.snapshot().document.layers[0].mask.strokes.length, 0,
        'preview strokes do not mutate the saved draft');
    assert.equal(h.counters.canvasSaves, savesBefore);
    await h.settle();

    overlay.dispatch('pointerup', {pointerId: 141, clientX: 160, clientY: 120});
    let committed = h.controller.snapshot().document.layers;
    const committedA = committed.find(layer => layer.id === 'tone-a').mask.strokes[0];
    const committedB = committed.find(layer => layer.id === 'tone-b').mask.strokes[0];
    assert.deepEqual(committedA, committedB);
    assert.notEqual(committedA, committedB, 'committed target strokes are independent copies');
    for (const key of ['layerIds', 'tool', 'layerId', 'pointerId']) assert.equal(Object.hasOwn(committedA, key), false);
    assert.equal(committed.find(layer => layer.id === 'tone-b').visible, false, 'hidden selected layers remain hidden');
    assert.equal(committed.find(layer => layer.id === 'color-c').mask.strokes.length, 0);
    assert.equal(h.counters.canvasSaves, savesBefore + 1);
    assert.equal(panel.latest.canUndo, true);

    panel.actions.undo();
    committed = h.controller.snapshot().document.layers;
    assert.equal(committed.find(layer => layer.id === 'tone-a').mask.strokes.length, 0);
    assert.equal(committed.find(layer => layer.id === 'tone-b').mask.strokes.length, 0);
    assert.equal(panel.latest.canRedo, true);
    panel.actions.redo();
    committed = h.controller.snapshot().document.layers;
    assert.equal(committed.find(layer => layer.id === 'tone-a').mask.strokes.length, 1);
    assert.equal(committed.find(layer => layer.id === 'tone-b').mask.strokes.length, 1);
    h.controller.close();
});

test('mask eraser point budget counts every target and permits the exact single-target limit', async () => {
    const layers = makeThreeCorrectionLayers();
    const h = createHarness({holdTimerDelays: [60]});
    h.controller.restore({document: makeDocument({layers}), targetLayerId: null});
    await h.controller.open(); await h.settle();
    const panel = h.counters.panels.at(-1), overlay = h.stage.children[0];
    panel.actions.select('tone-a');
    panel.actions.select('tone-b', {shiftKey: true});
    panel.actions.setTool('maskErase');
    const savesBefore = h.counters.canvasSaves;
    const seed = panel.latest.doc.layers.find(layer => layer.id === 'color-c');
    const repeatedPoint = [1, 1];
    seed.strokes = [
        ...Array.from({length: 83}, () => ({
            points: Array(1200).fill(repeatedPoint), radius: 1, hardness: .5, opacity: 1,
        })),
        {points: Array(399).fill(repeatedPoint), radius: 1, hardness: .5, opacity: 1},
    ];
    const seedPointCount = () => seed.strokes.reduce((total, stroke) => total + stroke.points.length, 0);
    assert.equal(seedPointCount(), 99999);

    sendStrokePoint(overlay, 'pointerdown', 181, 100, 100);
    h.runTimers(60);
    await h.waitFor(() => h.counters.fetchCalls.some(call => call.url.endsWith('/preview')
        && call.body.layers.find(layer => layer.id === 'color-c')?.strokes.reduce((total, stroke) => total + stroke.points.length, 0) === 99999),
    'over-limit multi-target preview was not sent');
    const rejectedPreview = h.counters.fetchCalls.filter(call => call.url.endsWith('/preview')
        && call.body.layers.find(layer => layer.id === 'color-c')?.strokes.reduce((total, stroke) => total + stroke.points.length, 0) === 99999).at(-1).body;
    assert.equal(rejectedPreview.layers.find(layer => layer.id === 'tone-a').mask.strokes.length, 0);
    assert.equal(rejectedPreview.layers.find(layer => layer.id === 'tone-b').mask.strokes.length, 0,
        'preview omits the whole stroke when the combined point count exceeds the limit');
    await h.settle();
    overlay.dispatch('pointerup', {pointerId: 181, clientX: 100, clientY: 100});
    assert.equal(panel.latest.doc.layers.find(layer => layer.id === 'tone-a').mask.strokes.length, 0,
        'over-limit commit does not partially affect the first target');
    assert.equal(panel.latest.doc.layers.find(layer => layer.id === 'tone-b').mask.strokes.length, 0,
        'over-limit commit does not affect the second target');
    assert.equal(h.counters.canvasSaves, savesBefore);
    assert.equal(panel.latest.canUndo, false);
    assert.match(panel.latest.message, /한도/);

    panel.actions.select('tone-a');
    sendStrokePoint(overlay, 'pointerdown', 182, 100, 100);
    h.runTimers(60);
    await h.waitFor(() => h.counters.fetchCalls.some(call => call.url.endsWith('/preview')
        && call.body.layers.find(layer => layer.id === 'tone-a')?.mask.strokes.length === 1),
    'an exact-limit single-target preview was omitted');
    const allowedPreview = h.counters.fetchCalls.filter(call => call.url.endsWith('/preview')
        && call.body.layers.find(layer => layer.id === 'tone-a')?.mask.strokes.length === 1).at(-1).body;
    assert.equal(allowedPreview.layers.find(layer => layer.id === 'tone-b').mask.strokes.length, 0);
    await h.settle();
    overlay.dispatch('pointerup', {pointerId: 182, clientX: 100, clientY: 100});
    assert.equal(seed.mask.strokes.length, 0);
    assert.equal(panel.latest.doc.layers.find(layer => layer.id === 'tone-a').mask.strokes.length, 1);
    assert.equal(panel.latest.doc.layers.find(layer => layer.id === 'tone-b').mask.strokes.length, 0);
    assert.equal(seedPointCount(), 99999);
    assert.equal(h.counters.canvasSaves, savesBefore + 1);
    assert.equal(panel.latest.canUndo, true);
    h.controller.close();
});

test('paint, mask add, and settings edits continue to target only the active layer', async () => {
    const layers = makeThreeCorrectionLayers();
    const h = createHarness({holdTimerDelays: [60]});
    h.controller.restore({document: makeDocument({layers}), targetLayerId: null});
    await h.controller.open(); await h.settle();
    const panel = h.counters.panels.at(-1), overlay = h.stage.children[0];
    panel.actions.select('tone-a');
    panel.actions.select('tone-b', {shiftKey: true});
    const savesBefore = h.counters.canvasSaves;
    panel.actions.change({params: {brightness: 7}});
    panel.actions.setTool('paint');
    sendStrokePoint(overlay, 'pointerdown', 151, 120, 120);
    overlay.dispatch('pointerup', {pointerId: 151, clientX: 120, clientY: 120});
    panel.actions.setTool('maskAdd');
    sendStrokePoint(overlay, 'pointerdown', 152, 130, 130);
    overlay.dispatch('pointerup', {pointerId: 152, clientX: 130, clientY: 130});

    const document = h.controller.snapshot().document;
    assert.equal(document.layers.find(layer => layer.id === 'tone-a').params.brightness, 0);
    assert.equal(document.layers.find(layer => layer.id === 'tone-b').params.brightness, 7);
    assert.equal(document.layers[0].mask.strokes.length, 0);
    assert.deepEqual(document.layers[1].mask.strokes.map(stroke => stroke.erase), [false, false]);
    assert.equal(document.layers[2].mask.strokes.length, 0);
    assert.deepEqual(selectedIdsFor(panel), ['tone-a', 'tone-b']);
    assert.equal(panel.latest.selectedId, 'tone-b');
    assert.equal(h.counters.canvasSaves, savesBefore + 3);
    h.controller.close();
});

test('deleting and undoing selected layers keeps a valid selection and new layers select alone', async () => {
    const layers = makeThreeCorrectionLayers();
    const h = createHarness({holdTimerDelays: [60]});
    h.controller.restore({document: makeDocument({layers}), targetLayerId: null});
    await h.controller.open(); await h.settle();
    const panel = h.counters.panels.at(-1);
    panel.actions.select('tone-a');
    panel.actions.select('tone-b', {shiftKey: true});
    panel.actions.remove();
    assert.deepEqual(h.controller.snapshot().document.layers.map(layer => layer.id), ['tone-a', 'color-c']);
    assert.deepEqual(selectedIdsFor(panel), ['tone-a']);
    assert.equal(panel.latest.selectedId, 'tone-a');

    panel.actions.undo();
    assert.deepEqual(h.controller.snapshot().document.layers.map(layer => layer.id), ['tone-a', 'tone-b', 'color-c']);
    assert.deepEqual(selectedIdsFor(panel), ['tone-a'], 'undo restores the layer without selecting stale IDs');
    assert.equal(panel.latest.selectedId, 'tone-a');

    panel.actions.select('tone-b', {shiftKey: true});
    assert.deepEqual(selectedIdsFor(panel), ['tone-a', 'tone-b']);
    panel.actions.add('tone');
    const added = h.controller.snapshot().document.layers.at(-1).id;
    assert.notEqual(added, 'tone-a');
    assert.ok(h.controller.snapshot().document.layers.some(layer => layer.id === added));
    assert.deepEqual(selectedIdsFor(panel), [added], 'adding a layer resets selection to the new layer');
    assert.equal(panel.latest.selectedId, added);
    assert.equal(Object.hasOwn(h.controller.snapshot(), 'selectedIds'), false);
    h.controller.close();
});

test('cancel, lost capture, and close never commit a multi-layer eraser stroke', async () => {
    for (const outcome of ['pointercancel', 'lostpointercapture', 'close']) {
        const held = deferred();
        let heldSignal = null;
        const h = createHarness({holdTimerDelays: [60], fetchHandler: async (url, options) => {
            if (url.endsWith('/preview')) {
                const body = JSON.parse(options.body);
                const first = body.layers.find(layer => layer.id === 'tone-a');
                const second = body.layers.find(layer => layer.id === 'tone-b');
                if (first?.mask.strokes.length === 1 && second?.mask.strokes.length === 1 && !heldSignal) {
                    heldSignal = options.signal; return held.promise;
                }
                return {ok: true, blob: async () => ({url})};
            }
            return {ok: true, blob: async () => ({url})};
        }});
        const layers = makeThreeCorrectionLayers();
        h.controller.restore({document: makeDocument({layers}), targetLayerId: null});
        await h.controller.open(); await h.settle();
        const panel = h.counters.panels.at(-1), overlay = h.stage.children[0];
        panel.actions.select('tone-a');
        panel.actions.select('tone-b', {shiftKey: true});
        panel.actions.setTool('maskErase');
        sendStrokePoint(overlay, 'pointerdown', 172, 120, 120);
        sendStrokePoint(overlay, 'pointermove', 172, 160, 120);
        h.runTimers(60);
        await h.waitFor(() => heldSignal, 'multi-layer preview was not held for ' + outcome);
        const savesBefore = h.counters.canvasSaves;
        const previewCount = h.counters.fetchCalls.filter(call => call.url.endsWith('/preview')).length;

        if (outcome === 'close') h.controller.close();
        else overlay.dispatch(outcome, {pointerId: 172});
        assert.equal(heldSignal.aborted, true);
        assert.equal(h.counters.canvasSaves, savesBefore + Number(outcome === 'close'),
            'close persists the draft once while discarding the unfinished stroke');
        assert.equal(h.controller.snapshot().document.layers.find(layer => layer.id === 'tone-a').mask.strokes.length, 0);
        assert.equal(h.controller.snapshot().document.layers.find(layer => layer.id === 'tone-b').mask.strokes.length, 0);
        if (outcome !== 'close') assert.deepEqual(selectedIdsFor(panel), ['tone-a', 'tone-b']);

        held.resolve({ok: true, blob: async () => ({url: 'late-multi-mask-' + outcome})});
        await h.waitFor(() => h.counters.bitmaps.some(bitmap => bitmap.blob.url === 'late-multi-mask-' + outcome
            && bitmap.closeCount > 0), 'late multi-mask bitmap was not discarded');
        if (outcome === 'close') {
            await h.settle();
            assert.equal(h.counters.fetchCalls.filter(call => call.url.endsWith('/preview')).length, previewCount);
            continue;
        }

        await h.waitFor(() => h.pendingTimers(60) === 1, 'cancelled stroke did not queue a committed-document refresh');
        h.runTimers(60);
        await h.waitFor(() => h.counters.fetchCalls.filter(call => call.url.endsWith('/preview')).length > previewCount);
        const refreshed = h.counters.fetchCalls.filter(call => call.url.endsWith('/preview')).at(-1).body;
        assert.equal(refreshed.layers.find(layer => layer.id === 'tone-a').mask.strokes.length, 0);
        assert.equal(refreshed.layers.find(layer => layer.id === 'tone-b').mask.strokes.length, 0);
        assert.equal(h.counters.canvasSaves, savesBefore);
        await h.settle();
        h.controller.close();
    }
});

test('mask eraser preview includes the live stroke while the saved document waits for pointerup', async () => {
    const layer = RetouchState.createLayer('tone', () => 'mask-preview-tone');
    const h = createHarness({holdTimerDelays: [60]});
    h.controller.restore({document: makeDocument({layers: [layer]}), targetLayerId: null});
    await h.controller.open(); await h.settle();
    const panel = h.counters.panels.at(-1), overlay = h.stage.children[0];
    panel.actions.setTool('maskErase');
    const savesBefore = h.counters.canvasSaves;
    sendStrokePoint(overlay, 'pointerdown', 55, 120, 120);
    sendStrokePoint(overlay, 'pointermove', 55, 160, 120);
    assert.equal(h.pendingTimers(60), 1);
    assert.equal(h.controller.snapshot().document.layers[0].mask.strokes.length, 0);
    assert.equal(h.counters.canvasSaves, savesBefore);
    assert.equal(panel.latest.canUndo, false);

    h.runTimers(60);
    await h.waitFor(() => h.counters.fetchCalls.some(call => call.url.endsWith('/preview')
        && call.body.layers[0]?.mask.strokes.length === 1), 'live mask stroke was omitted from preview payload');
    const preview = h.counters.fetchCalls.filter(call => call.url.endsWith('/preview')
        && call.body.layers[0]?.mask.strokes.length === 1).at(-1);
    assert.deepEqual(preview.body.layers[0].mask.strokes[0].points, [[225, 200], [300, 200]]);
    assert.equal(preview.body.layers[0].mask.strokes[0].erase, true);
    assert.equal(preview.body.layers[0].mask.strokes[0].opacity, 1);
    await h.settle();
    assert.equal(h.controller.snapshot().document.layers[0].mask.strokes.length, 0);
    assert.equal(h.counters.canvasSaves, savesBefore);

    overlay.dispatch('pointerup', {pointerId: 55, clientX: 160, clientY: 120});
    const committed = h.controller.snapshot().document.layers[0].mask.strokes;
    assert.equal(committed.length, 1);
    assert.equal(committed[0].erase, true);
    assert.deepEqual(committed[0].points, [[225, 200], [300, 200]]);
    assert.equal(h.counters.canvasSaves, savesBefore + 1);
    assert.equal(panel.latest.canUndo, true);
    panel.actions.undo();
    assert.equal(h.controller.snapshot().document.layers[0].mask.strokes.length, 0);
    h.controller.close();
});

test('cancel and lost capture discard active mask previews and refresh the committed document', async () => {
    for (const cancelEvent of ['pointercancel', 'lostpointercapture']) {
        const held = deferred();
        let heldSignal = null;
        const h = createHarness({holdTimerDelays: [60], fetchHandler: async (url, options) => {
            if (url.endsWith('/preview')) {
                const body = JSON.parse(options.body);
                if (body.layers.some(item => item.mask.strokes.length) && !heldSignal) {
                    heldSignal = options.signal; return held.promise;
                }
                return {ok: true, blob: async () => ({url})};
            }
            return {ok: true, blob: async () => ({url})};
        }});
        const layer = RetouchState.createLayer('tone', () => 'mask-cancel-tone');
        h.controller.restore({document: makeDocument({layers: [layer]}), targetLayerId: null});
        await h.controller.open(); await h.settle();
        h.counters.panels.at(-1).actions.setTool('maskErase');
        const overlay = h.stage.children[0];
        sendStrokePoint(overlay, 'pointerdown', 73, 120, 120);
        sendStrokePoint(overlay, 'pointermove', 73, 160, 120);
        h.runTimers(60);
        await h.waitFor(() => heldSignal, 'active mask preview was not held');
        const committedBefore = h.controller.snapshot();
        const savesBefore = h.counters.canvasSaves;
        const previewsBeforeRefresh = h.counters.fetchCalls.filter(call => call.url.endsWith('/preview')).length;

        overlay.dispatch(cancelEvent, {pointerId: 73});
        assert.equal(heldSignal.aborted, true, cancelEvent + ' must invalidate the active preview request');
        assert.deepEqual(h.controller.snapshot(), committedBefore, 'an abandoned stroke is not saved');
        assert.equal(h.counters.canvasSaves, savesBefore);
        if (cancelEvent === 'pointercancel') assert.equal(h.pendingTimers(60), 0, 'refresh waits for the active request to settle');

        held.resolve({ok: true, blob: async () => ({url: 'stale-mask-' + cancelEvent})});
        await h.waitFor(() => h.counters.bitmaps.some(bitmap => bitmap.blob.url === 'stale-mask-' + cancelEvent
            && bitmap.closeCount > 0), 'late mask bitmap was not discarded');
        await h.waitFor(() => h.pendingTimers(60) === 1, 'committed document refresh was not queued');
        assert.deepEqual(h.controller.snapshot(), committedBefore);
        assert.equal(h.counters.canvasSaves, savesBefore);
        h.runTimers(60);
        await h.waitFor(() => h.counters.fetchCalls.filter(call => call.url.endsWith('/preview')).length > previewsBeforeRefresh);
        const refreshed = h.counters.fetchCalls.filter(call => call.url.endsWith('/preview')).at(-1);
        assert.equal(refreshed.body.layers[0].mask.strokes.length, 0);
        await h.settle();
        h.controller.close();
    }
});

test('E selects the mask eraser, ignores input shortcuts, and is disconnected after close', async () => {
    const h = createHarness();
    await h.controller.open(); await h.settle();
    const panel = h.counters.panels.at(-1);
    panel.actions.setTool('maskErase');
    assert.equal(h.controller.snapshot().document.layers.length, 0);
    h.stage.children[0].dispatch('pointerdown', {button:0, pointerId:80, clientX:110, clientY:120});
    assert.equal(h.controller.snapshot().document.layers.length, 0, 'the eraser never creates a layer when none is selected');
    assert.match(panel.latest.message, /보정 레이어를 먼저 추가/);
    panel.actions.setTool('hand');
    panel.actions.add('tone'); await h.settle();
    const key = (target, value = 'e') => h.document.dispatch('keydown', {target, key: value});
    const surfaceTarget = {closest: () => null};
    key(surfaceTarget);
    assert.equal(panel.latest.tool, 'maskErase');

    panel.actions.setTool('hand');
    key({closest: selector => selector.includes('input') ? {} : null});
    assert.equal(panel.latest.tool, 'hand');
    panel.actions.apply();
    key(surfaceTarget);
    assert.equal(panel.latest.busy, true);
    assert.equal(panel.latest.tool, 'hand', 'the eraser shortcut is ignored while a request is busy');
    await h.settle();
    assert.equal(h.controller.isOpen(), false);
    key(surfaceTarget);
    assert.equal(h.controller.isOpen(), false);
    assert.equal((h.document.listeners.get('keydown') || []).length, 0);
});

test('airbrush cannot write into an adjustment when the layer limit prevents a paint layer', async () => {
    const h = createHarness();
    await h.controller.open(); await h.settle();
    const panel = h.counters.panels.at(-1);
    for (let i = 0; i < 39; i++) panel.actions.add('tone');
    const toneId = h.controller.snapshot().document.layers.at(-1).id;
    panel.actions.setTool('airbrush'); await h.settle();
    panel.actions.select(toneId); await h.settle();
    const before = h.controller.snapshot();
    h.stage.children[0].dispatch('pointerdown', {button:0, pointerId:9, clientX:160, clientY:180});
    assert.equal(h.pendingTimers(100), 0);
    assert.deepEqual(h.controller.snapshot(), before);
    assert.match(panel.latest.message, /40개/);
    h.controller.close();
});

test('cancel, lost capture, and close stop airbrush pulses without committing paint', async () => {
    for (const event of ['pointercancel', 'lostpointercapture', 'close']) {
        const h = createHarness();
        await h.controller.open(); await h.settle();
        h.counters.panels.at(-1).actions.preset('peach'); await h.settle();
        const overlay = h.stage.children[0];
        overlay.dispatch('pointerdown', {button:0, pointerId:5, clientX:170, clientY:190});
        if (event === 'close') h.controller.close();
        else overlay.dispatch(event, {pointerId:5});
        assert.equal(h.pendingTimers(100), 0);
        assert.equal(h.controller.snapshot().document.layers.at(-1).strokes.length, 0);
        h.controller.close();
    }
});

test('liquify updates local pixels on one animation frame and commits one undoable stroke', async () => {
    const h = createHarness();
    const {panel, overlay} = await prepareLiquify(h);
    const requestsBeforeStroke = h.counters.fetchCalls.length;
    const savesBeforeStroke = h.counters.canvasSaves;
    sendStrokePoint(overlay, 'pointerdown', 21, 100, 100);
    assert.equal(h.counters.liquifyCreates.length, 1);
    const createCall = h.counters.liquifyCreates[0];
    assert.equal(createCall.documentWidth, 1200);
    assert.equal(createCall.documentHeight, 800);
    assert.ok(createCall.imageData.width > 0 && createCall.imageData.height > 0);
    assert.equal(h.counters.liquifyAppends.length, 1, 'pointerdown applies its first point synchronously');

    sendStrokePoint(overlay, 'pointermove', 21, 130, 100);
    sendStrokePoint(overlay, 'pointermove', 21, 160, 100);
    assert.equal(h.pendingFrames(), 1, 'many pointer moves coalesce into one animation frame');
    assert.equal(h.counters.liquifyAppends.length, 1, 'moves are batched until the frame is flushed');
    assert.equal(h.counters.fetchCalls.length, requestsBeforeStroke, 'dragging does not request server previews');
    assert.equal(h.counters.canvasSaves, savesBeforeStroke, 'dragging does not persist partial strokes');
    assert.equal(h.runFrames(), 1);
    assert.equal(h.pendingFrames(), 0);
    assert.equal(h.counters.liquifyAppends.length, 2);
    const appendedPoints = Array.from(h.counters.liquifyAppends.at(-1).points, point => Array.from(point));
    assert.deepEqual(appendedPoints.map(point => point[0]), [187.5, 243.75, 300]);
    assert.ok(appendedPoints.every(point => Math.abs(point[1] - 800 / 4.8) < 1e-8));

    const localCanvas = createCall.imageData.canvas;
    assert.ok(localCanvas.contextOperations.putImageData.some(([pixels]) => pixels === createCall.imageData),
        'the engine dirty rectangle is uploaded to its local preview canvas');
    const visibleImage = overlay.children[0];
    assert.ok(visibleImage.contextOperations.drawImage.some(([source]) => source === localCanvas),
        'the edited local preview canvas is drawn on the retouch surface while dragging');

    sendStrokePoint(overlay, 'pointerup', 21, 170, 100);
    assert.equal(h.pendingFrames(), 0);
    assert.equal(h.counters.canvasSaves, savesBeforeStroke + 1, 'pointerup persists the whole stroke once');
    const savedLayer = h.controller.snapshot().document.layers.find(layer => layer.id === createCall.stroke.layerId);
    assert.equal(savedLayer.type, 'liquify');
    assert.equal(savedLayer.strokes.length, 1);
    assert.equal(savedLayer.strokes[0].points.length, 4);
    assert.ok(Math.abs(savedLayer.strokes[0].points.at(-1)[0] - 318.75) < 1e-8, 'pointerup includes the final endpoint');
    assert.equal(h.counters.fetchCalls.length, requestsBeforeStroke, 'server refresh is deferred after pointerup');

    const committed = h.controller.snapshot().document;
    panel.actions.undo(); await h.settle();
    assert.equal(h.controller.snapshot().document.layers.find(layer => layer.id === createCall.stroke.layerId).strokes.length, 0);
    panel.actions.redo(); await h.settle();
    assert.deepEqual(h.controller.snapshot().document.layers.find(layer => layer.id === createCall.stroke.layerId).strokes, committed.layers.find(layer => layer.id === createCall.stroke.layerId).strokes);
    h.controller.close();
});

test('liquify keeps committed feedback as the next stroke base and ignores a late server bitmap during drag', async () => {
    const held = deferred();
    let waitingForCommittedStroke = false;
    const h = createHarness({fetchHandler: async (url, options) => {
        if (url.endsWith('/preview')) {
            const body = options.body ? JSON.parse(options.body) : {};
            if (!waitingForCommittedStroke && body.layers?.some(layer => layer.type === 'liquify' && layer.strokes.length)) {
                waitingForCommittedStroke = true;
                return held.promise;
            }
        }
        return {ok: true, blob: async () => ({url})};
    }});
    const {overlay} = await prepareLiquify(h);
    sendStrokePoint(overlay, 'pointerdown', 31, 100, 100);
    sendStrokePoint(overlay, 'pointermove', 31, 130, 100);
    sendStrokePoint(overlay, 'pointerup', 31, 160, 100);
    await h.waitFor(() => waitingForCommittedStroke, 'the committed stroke did not request its server preview');
    await h.settle();

    const firstFeedback = h.counters.liquifyCreates[0].imageData.canvas;
    const visibleImage = overlay.children[0];
    assert.ok(visibleImage.contextOperations.drawImage.some(([source]) => source === firstFeedback),
        'the committed local feedback remains visible while its server refresh is pending');

    sendStrokePoint(overlay, 'pointerdown', 32, 200, 100);
    assert.equal(h.counters.liquifyCreates.length, 2);
    const secondBase = h.counters.liquifyCreates[1].imageData.canvas;
    assert.ok(secondBase.contextOperations.drawImage.some(([source]) => source === firstFeedback),
        'a rapid second stroke starts from the first stroke’s local feedback');
    sendStrokePoint(overlay, 'pointermove', 32, 230, 100);
    assert.equal(h.pendingFrames(), 1);

    held.resolve({ok: true, blob: async () => ({url: '/late-liquify-preview'})});
    await h.settle();
    const lateBitmap = h.counters.bitmaps.find(bitmap => bitmap.blob?.url === '/late-liquify-preview');
    assert.ok(lateBitmap, 'the ignored response reached bitmap decoding');
    assert.ok(lateBitmap.closeCount > 0, 'the stale bitmap is released');
    assert.equal(visibleImage.contextOperations.drawImage.some(([source]) => source === lateBitmap), false,
        'a late server response does not replace the in-progress local preview');
    assert.equal(h.runFrames(), 1);
    overlay.dispatch('pointercancel', {pointerId: 32});
    h.controller.close();
});

test('liquify cancellation, capture loss, blur, and close cancel queued frames without recording a stroke', async () => {
    for (const ending of ['pointercancel', 'lostpointercapture', 'blur', 'close']) {
        const h = createHarness();
        const {overlay} = await prepareLiquify(h);
        sendStrokePoint(overlay, 'pointerdown', 41, 100, 100);
        sendStrokePoint(overlay, 'pointermove', 41, 140, 100);
        assert.equal(h.pendingFrames(), 1, `${ending} case queued a frame`);
        if (ending === 'blur') h.document.dispatch('blur');
        else if (ending === 'close') h.controller.close();
        else overlay.dispatch(ending, {pointerId: 41});

        assert.equal(h.pendingFrames(), 0, `${ending} cancels the queued frame`);
        assert.equal(h.runFrames(), 0, `${ending} leaves no callback to run`);
        assert.equal(h.controller.snapshot().document.layers.at(-1).strokes.length, 0, `${ending} does not commit partial points`);
        if (ending !== 'close') h.controller.close();
    }
});

test('liquify uses a matching layer mask even when mask display is off and blocks live deformation if the mask is missing', async () => {
    const h = createHarness();
    let {panel, overlay, layer} = await prepareLiquify(h);
    panel.actions.mask('painted');
    panel.actions.setTool('liquify');
    await h.settle();
    layer = h.controller.snapshot().document.layers.at(-1);
    assert.equal(panel.latest.maskShow, false);
    const maskRequest = h.counters.fetchCalls.find(call => call.url.endsWith('/mask') && call.body.layerId === layer.id);
    assert.ok(maskRequest, 'a nontrivial selected liquify mask is fetched even when it is not displayed');

    sendStrokePoint(overlay, 'pointerdown', 51, 100, 100);
    assert.ok(h.counters.liquifyCreates[0].options.mask, 'the matching mask bytes reach the liquify engine');
    assert.equal(h.counters.liquifyCreates[0].options.mask.length, h.counters.liquifyCreates[0].imageData.data.length);
    sendStrokePoint(overlay, 'pointerup', 51, 100, 100);
    h.controller.close();

    const missing = createHarness({fetchHandler: async url => {
        if (url.endsWith('/mask')) return {ok: false, status: 503, json: async () => ({message: 'mask unavailable'})};
        return {ok: true, blob: async () => ({url})};
    }});
    const absent = await prepareLiquify(missing);
    absent.panel.actions.mask('painted');
    absent.panel.actions.setTool('liquify');
    await missing.settle();
    sendStrokePoint(absent.overlay, 'pointerdown', 52, 100, 100);
    sendStrokePoint(absent.overlay, 'pointermove', 52, 140, 100);
    assert.equal(missing.counters.liquifyCreates.length, 0, 'frozen pixels are never deformed without the matching mask');
    missing.runFrames();
    sendStrokePoint(absent.overlay, 'pointerup', 52, 140, 100);
    assert.equal(missing.counters.liquifyCreates.length, 0);
    missing.controller.close();
});

test('liquify refuses to preview hidden or fully transparent layers and never writes a tone layer', async () => {
    for (const setting of ['hidden', 'transparent']) {
        const h = createHarness();
        const {panel, overlay, layer} = await prepareLiquify(h);
        if (setting === 'hidden') panel.actions.toggle(layer.id);
        else panel.actions.change({opacity: 0});
        await h.settle();
        sendStrokePoint(overlay, 'pointerdown', 61, 100, 100);
        sendStrokePoint(overlay, 'pointermove', 61, 140, 100);
        sendStrokePoint(overlay, 'pointerup', 61, 160, 100);
        assert.equal(h.counters.liquifyCreates.length, 0, `${setting} liquify layers do not create a pixel preview`);
        h.controller.close();
    }

    const h = createHarness();
    await h.controller.open(); await h.settle();
    const panel = h.counters.panels.at(-1);
    for (let index = 0; index < 40; index += 1) panel.actions.add('tone');
    await h.settle();
    assert.equal(h.controller.snapshot().document.layers.length, 40);
    const selectedToneId = h.controller.snapshot().document.layers.at(-1).id;
    panel.actions.setTool('liquify');
    const before = h.controller.snapshot().document.layers.find(layer => layer.id === selectedToneId);
    const overlay = h.stage.children[0];
    sendStrokePoint(overlay, 'pointerdown', 62, 100, 100);
    sendStrokePoint(overlay, 'pointermove', 62, 140, 100);
    sendStrokePoint(overlay, 'pointerup', 62, 160, 100);
    const after = h.controller.snapshot().document.layers.find(layer => layer.id === selectedToneId);
    assert.deepEqual(after.strokes, before.strokes, 'the layer cap cannot redirect liquify strokes into the selected tone layer');
    assert.equal(h.counters.liquifyCreates.length, 0);
    h.controller.close();
});

test('liquify keeps its recorded stroke when the browser engine is unavailable', async () => {
    const h = createHarness({liquifyEngine: false});
    const {overlay} = await prepareLiquify(h);
    sendStrokePoint(overlay, 'pointerdown', 71, 100, 100);
    sendStrokePoint(overlay, 'pointermove', 71, 140, 100);
    sendStrokePoint(overlay, 'pointerup', 71, 160, 100);
    const layer = h.controller.snapshot().document.layers.at(-1);
    assert.equal(layer.type, 'liquify');
    assert.equal(layer.strokes.length, 1, 'the existing server path still stores the stroke without the local engine');
    assert.equal(h.counters.liquifyCreates.length, 0);
    await h.settle();
    assert.ok(h.counters.fetchCalls.some(call => call.url.endsWith('/preview') && call.body.layers.some(item => item.strokes.length)));
    h.controller.close();
});

test('compare labels and accessible handle reflect the active split and hide narrow sides', async () => {
    const h = createHarness();
    await h.controller.open();
    await h.settle();
    const overlay = h.stage.children[0];
    const handle = overlay.children.find(child => child.className === 'canvas-retouch-compare-handle');
    const original = overlay.children.find(child => String(child.className || '').includes('canvas-retouch-compare-original'));
    const edited = overlay.children.find(child => String(child.className || '').includes('canvas-retouch-compare-edited'));
    const panel = h.counters.panels.at(-1);

    assert.equal(handle.hidden, true);
    assert.equal(original.hidden, true);
    assert.equal(edited.hidden, true);
    panel.actions.compare(true);
    panel.actions.compareSplit(35);
    assert.equal(handle.hidden, false);
    assert.equal(handle.getAttribute('role'), 'slider');
    assert.equal(handle.getAttribute('aria-label'), '전후 비교 경계');
    assert.equal(handle.getAttribute('aria-valuemin'), '0');
    assert.equal(handle.getAttribute('aria-valuemax'), '100');
    assert.equal(handle.getAttribute('aria-valuenow'), '35');
    assert.equal(handle.getAttribute('aria-valuetext'), '원본 35% · 보정본 65%');
    assert.equal(handle.getAttribute('aria-orientation'), 'horizontal');
    assert.equal(handle.style.left, '224px');
    assert.equal(original.textContent, '원본');
    assert.equal(edited.textContent, '보정본');
    assert.equal(original.hidden, false);
    assert.equal(edited.hidden, false);

    panel.actions.compareSplit(5);
    assert.equal(original.hidden, true);
    assert.equal(edited.hidden, false);
    panel.actions.compareSplit(95);
    assert.equal(original.hidden, false);
    assert.equal(edited.hidden, true);
    panel.actions.compare(false);
    assert.equal(handle.hidden, true);
    assert.equal(original.hidden, true);
    assert.equal(edited.hidden, true);
    h.controller.close();
});

test('dragging the comparison handle with a paint tool changes only the UI split', async () => {
    const h = createHarness();
    await h.controller.open();
    await h.settle();
    const panel = h.counters.panels.at(-1);
    panel.actions.add('paint');
    await h.settle();
    panel.actions.compare(true);
    panel.actions.compareSplit(50);
    const overlay = h.stage.children[0];
    const handle = overlay.children.find(child => child.className === 'canvas-retouch-compare-handle');
    const before = h.controller.snapshot().document;
    const savedCount = h.counters.canvasSaves;
    const requestCount = h.counters.fetchCalls.length;
    panel.actions.compareSplit(0);
    handle.dispatch('pointerdown', {button: 0, isPrimary: false, pointerId: 8, clientX: 20});
    assert.equal(handle.hasPointerCapture(8), false);
    handle.dispatch('pointerup', {pointerId: 8, clientX: 20});
    handle.dispatch('pointerdown', {button: 0, isPrimary: true, pointerId: 11, clientX: 20});
    handle.dispatch('pointerup', {pointerId: 11, clientX: 20});
    assert.equal(panel.latest.compareSplit, 0);
    assert.equal(handle.hasPointerCapture(11), false);
    panel.actions.compareSplit(50);
    const down = handle.dispatch('pointerdown', {button: 0, pointerId: 9, clientX: 320});
    assert.equal(down.defaultPrevented, true);
    assert.equal(down.propagationStopped, true);
    assert.equal(handle.focused, true);
    assert.equal(handle.hasPointerCapture(9), true);

    handle.dispatch('pointermove', {pointerId: 9, clientX: -20});
    assert.equal(panel.latest.compareSplit, 0);
    handle.dispatch('pointermove', {pointerId: 9, clientX: 320});
    assert.equal(panel.latest.compareSplit, 50);
    handle.dispatch('pointermove', {pointerId: 9, clientX: 700});
    assert.equal(panel.latest.compareSplit, 100);
    handle.dispatch('pointerup', {pointerId: 9, clientX: 640});
    assert.equal(handle.hasPointerCapture(9), false);
    assert.equal(panel.latest.compareSplit, 100);

    handle.dispatch('pointerdown', {button: 0, pointerId: 10, clientX: 640});
    handle.dispatch('pointermove', {pointerId: 10, clientX: 320});
    assert.equal(panel.latest.compareSplit, 50);
    handle.dispatch('pointercancel', {pointerId: 10});
    handle.dispatch('pointermove', {pointerId: 10, clientX: 0});
    assert.equal(panel.latest.compareSplit, 50);
    assert.equal(handle.hasPointerCapture(10), false);
    assert.deepEqual(h.controller.snapshot().document, before);
    assert.equal(h.counters.canvasSaves, savedCount);
    assert.equal(h.counters.fetchCalls.length, requestCount);
    h.controller.close();
});

test('keyboard comparison controls clamp endpoints and preserve undo and Escape', async () => {
    const h = createHarness();
    await h.controller.open();
    await h.settle();
    const panel = h.counters.panels.at(-1);
    panel.actions.notes('keyboard undo checkpoint');
    await h.settle();
    panel.actions.compare(true);
    const overlay = h.stage.children[0];
    const handle = overlay.children.find(child => child.className === 'canvas-retouch-compare-handle');
    const key = (key, shiftKey = false, modifiers = {}) => h.document.dispatch('keydown', {
        target: handle, key, shiftKey, ...modifiers
    });

    assert.equal(key('ArrowRight').defaultPrevented, true);
    assert.equal(panel.latest.compareSplit, 51);
    key('ArrowRight', true);
    assert.equal(panel.latest.compareSplit, 61);
    key('ArrowLeft', true);
    assert.equal(panel.latest.compareSplit, 51);
    key('Home');
    assert.equal(panel.latest.compareSplit, 0);
    key('ArrowLeft');
    assert.equal(panel.latest.compareSplit, 0);
    key('End');
    assert.equal(panel.latest.compareSplit, 100);
    assert.equal(handle.getAttribute('aria-valuetext'), '원본 100% · 보정본 0%');
    key('z', false, {ctrlKey: true});
    assert.equal(h.controller.snapshot().document.notes, '');
    assert.equal(h.controller.isOpen(), true);
    key('Escape');
    assert.equal(h.controller.isOpen(), false);
    assert.equal((h.document.listeners.get('keydown') || []).length, 0);
    assert.equal((handle.listeners.get('pointerdown') || []).length, 0);
});

test('closing keeps an isolated draft snapshot, while restore(null) resets it for the next canvas', async () => {
    const h = createHarness();
    await h.controller.open();
    await h.settle();
    const panel = h.counters.panels.at(-1);
    panel.actions.notes('draft note');
    await h.settle();
    const returned = h.controller.snapshot();
    h.controller.close();

    assert.equal(h.controller.isOpen(), false);
    assert.equal(h.controller.snapshot().document.notes, 'draft note');
    returned.document.notes = 'mutated outside controller';
    assert.equal(h.controller.snapshot().document.notes, 'draft note');

    h.controller.restore(null);
    assert.equal(h.controller.snapshot(), undefined);
    await h.controller.open();
    await h.settle();
    assert.equal(h.counters.mergedCalls.length, 2);
    assert.equal(h.counters.savedSources.length, 2);
    assert.equal(h.controller.snapshot().document.notes, '');
});

test('apply adds a top image layer with retouch metadata and preserves the original canvas layers', async () => {
    const originalLayers = [
        {id: 10, type: 'image', src: '/canvas-imports/base.png', x: 0, y: 0, layerWidth: 1200, layerHeight: 800},
        {id: 11, type: 'paint', name: 'original paint', strokes: [{points: [[1, 2]]}]}
    ];
    const before = structuredClone(originalLayers);
    const h = createHarness({layers: originalLayers});
    await h.controller.open();
    await h.settle();
    const panel = h.counters.panels.at(-1);
    panel.actions.add('color');
    panel.actions.change({params: {color: '#aabbcc', mode: 'color'}, opacity: 0.42});
    await h.settle();
    const expected = RetouchState.normalize(h.controller.snapshot().document);
    panel.actions.apply();
    await h.waitFor(() => h.counters.layerRenders === 1, 'successful apply did not render the canvas layer list');
    await h.settle();

    const result = h.sandbox.canvasLayers[0];
    assert.equal(result.type, 'image');
    assert.equal(result.name, '전체 보정');
    assert.equal(result.src, '/api/canvas/retouch/results/result.png');
    assert.deepEqual(result.retouch, expected);
    assert.equal(result.retouch.layers[0].params.color, '#aabbcc');
    assert.deepEqual(h.sandbox.canvasLayers.slice(1), before);
    assert.equal(h.counters.surfaceRenders, 1);
    assert.equal(h.controller.snapshot(), undefined);
    assert.equal(h.controller.isOpen(), false);
    const applyCall = h.counters.fetchCalls.find(call => call.url.endsWith('/apply'));
    assert.deepEqual(applyCall.body, {source: expected.source, layers: expected.layers, print: expected.print});
});

test('re-editing a full-size result reuses its source and updates the same result layer id', async () => {
    const retouch = RetouchState.normalize(makeDocument({
        source: '/api/canvas/imports/original-base.png',
        layers: [RetouchState.createLayer('tone', () => 'tone-1')],
        notes: 'earlier notes', checks: [1, 5]
    }));
    const resultLayer = {id: 77, type: 'image', name: 'full correction', src: '/api/canvas/retouch/results/old.png',
        visible: true, x: 0, y: 0, layerWidth: 1200, layerHeight: 800, imageWidth: 1200, imageHeight: 800, retouch};
    const underlying = {id: 78, type: 'image', src: '/canvas-imports/under.png', x: 0, y: 0, layerWidth: 1200, layerHeight: 800};
    const h = createHarness({layers: [resultLayer, underlying], activeLayerId: 77});
    await h.controller.open();
    await h.settle();
    const panel = h.counters.panels.at(-1);
    assert.equal(h.controller.snapshot().targetLayerId, 77);
    assert.equal(h.controller.snapshot().document.source, '/api/canvas/imports/original-base.png');
    assert.equal(h.counters.mergedCalls.length, 0);
    assert.equal(h.counters.savedSources.length, 0);
    panel.actions.notes('updated notes');
    await h.settle();
    const expected = RetouchState.normalize(h.controller.snapshot().document);
    panel.actions.apply();
    await h.waitFor(() => h.counters.layerRenders === 1, 're-applying edited result did not render');
    await h.settle();

    assert.equal(h.sandbox.canvasLayers.length, 2);
    assert.equal(h.sandbox.canvasLayers[0].id, 77);
    assert.equal(h.sandbox.canvasLayers[0].src, '/api/canvas/retouch/results/result.png');
    assert.deepEqual(h.sandbox.canvasLayers[0].retouch, expected);
    assert.equal(h.sandbox.canvasLayers[0].retouch.source, '/api/canvas/imports/original-base.png');
    assert.equal(h.sandbox.canvasLayers[0].retouch.notes, 'updated notes');
    assert.deepEqual(h.sandbox.canvasLayers[1], underlying);
});

test('failed apply leaves the draft and canvas layers untouched and clears busy state', async () => {
    const originalLayers = [{id: 20, type: 'image', src: '/canvas-imports/original.png', x: 0, y: 0, layerWidth: 1200, layerHeight: 800}];
    const before = structuredClone(originalLayers);
    const h = createHarness({layers: originalLayers, fetchHandler: async url => {
        if (url.endsWith('/apply')) return {ok: true, json: async () => ({job: {id: 'bad-job', status: 'failed', message: 'synthetic engine error'}})};
        return {ok: true, blob: async () => ({url})};
    }});
    await h.controller.open();
    await h.settle();
    const panel = h.counters.panels.at(-1);
    panel.actions.add('tone');
    panel.actions.notes('keep this draft');
    await h.settle();
    const expected = RetouchState.normalize(h.controller.snapshot().document);
    panel.actions.apply();
    await h.waitFor(() => panel.latest?.busy === false && panel.latest?.error === true, 'failed apply did not settle into an error state');

    assert.deepEqual(h.controller.snapshot().document, expected);
    assert.deepEqual(h.sandbox.canvasLayers, before);
    assert.equal(panel.latest.busy, false);
    assert.equal(panel.latest.doc.notes, 'keep this draft');
    assert.equal(h.controller.isOpen(), true);
});

test('late merged snapshot completion is ignored after restore replaces the draft', async () => {
    const pending = deferred();
    const h = createHarness({renderHandler: () => pending.promise});
    const opening = h.controller.open();
    await h.waitFor(() => h.counters.mergedCalls.length === 1, 'open did not request the merged canvas snapshot');
    const restored = RetouchState.normalize(makeDocument({source: '/api/canvas/imports/restored.png', notes: 'restored draft'}));
    h.controller.restore({document: restored, targetLayerId: null});
    pending.resolve('data:image/png;base64,b2xk');
    await opening;
    await h.settle();

    assert.equal(h.counters.savedSources.length, 0);
    assert.deepEqual(h.controller.snapshot().document, restored);
    assert.equal(h.controller.isOpen(), false);
    assert.equal(h.counters.panels[0].destroyed, true);
});

test('late preview bitmaps are discarded after restore closes the old editor', async () => {
    const held = deferred();
    let firstPreview = true;
    const h = createHarness({fetchHandler: async url => {
        if (url.endsWith('/preview') && firstPreview) {firstPreview = false; return held.promise;}
        return {ok: true, blob: async () => ({url})};
    }});
    await h.controller.open();
    const oldPanel = h.counters.panels.at(-1);
    await h.waitFor(() => h.counters.fetchCalls.some(call => call.url.endsWith('/preview')), 'open did not start its preview request');
    const restored = RetouchState.normalize(makeDocument({source: '/api/canvas/imports/new-draft.png', notes: 'new draft'}));
    h.controller.restore({document: restored, targetLayerId: null});
    held.resolve({ok: true, blob: async () => ({url: '/late-preview'})});
    await h.settle();

    assert.deepEqual(h.controller.snapshot().document, restored);
    assert.ok(h.counters.bitmaps.length >= 1);
    assert.ok(h.counters.bitmaps.every(bitmap => bitmap.closeCount > 0));
    assert.equal(oldPanel.updatesAfterDestroy, 0);
});

test('apply, inspect, and close cancel a real in-flight preview and discard its late bitmap', async () => {
    for (const action of ['apply', 'inspect', 'close']) {
        const held = deferred();
        let heldSignal = null;
        const h = createHarness({holdTimerDelays: [60], fetchHandler: async (url, options) => {
            if (url.endsWith('/preview')) {
                const body = JSON.parse(options.body);
                if (body.layers.length && !heldSignal) {heldSignal = options.signal; return held.promise;}
                return {ok: true, blob: async () => ({url})};
            }
            if (url.endsWith('/apply')) {
                return {ok: true, json: async () => ({job: {id: 'preview-cancel-job', status: 'done',
                    result: {src: '/api/canvas/retouch/results/applied.png'}}})};
            }
            return {ok: true, blob: async () => ({url})};
        }});
        await h.controller.open(); await h.settle();
        const panel = h.counters.panels.at(-1);
        panel.actions.add('tone');
        h.runTimers(60);
        await h.waitFor(() => heldSignal, 'edited preview was not held in flight for ' + action);

        if (action === 'apply') {
            panel.actions.apply();
            await h.waitFor(() => !h.controller.isOpen(), 'apply did not finish while preview was held');
        } else if (action === 'inspect') {
            panel.actions.setTool('inspect');
            h.stage.children[0].dispatch('pointerdown', {button: 0, pointerId: 92, clientX: 120, clientY: 80});
            await h.waitFor(() => h.counters.fetchCalls.some(call => call.url.endsWith('/detail')),
                'inspection did not start while preview was held');
        } else h.controller.close();

        assert.equal(heldSignal.aborted, true, action + ' must abort the pending preview');
        assert.equal(h.pendingTimers(60), 0);
        const previewCount = h.counters.fetchCalls.filter(call => call.url.endsWith('/preview')).length;
        held.resolve({ok: true, blob: async () => ({url: 'late-preview-' + action})});
        await h.waitFor(() => h.counters.bitmaps.some(bitmap => bitmap.blob.url === 'late-preview-' + action
            && bitmap.closeCount > 0), action + ' left a late preview bitmap open');
        await h.settle();
        assert.equal(h.counters.fetchCalls.filter(call => call.url.endsWith('/preview')).length, previewCount,
            action + ' must not schedule an extra preview after cancellation');
        if (h.controller.isOpen()) h.controller.close();
    }
});

test('late apply result is ignored after the canvas changes', async () => {
    const pending = deferred();
    const h = createHarness({fetchHandler: async (url, options, counters) => {
        if (url.endsWith('/apply')) return pending.promise;
        return {ok: true, blob: async () => ({url})};
    }});
    const oldLayers = h.sandbox.canvasLayers;
    const oldBefore = structuredClone(oldLayers);
    await h.controller.open();
    await h.settle();
    const panel = h.counters.panels.at(-1);
    panel.actions.add('color');
    await h.settle();
    panel.actions.apply();
    await h.waitFor(() => h.counters.fetchCalls.some(call => call.url.endsWith('/apply')), 'apply request was not started');

    const newCanvasLayers = [{id: 501, type: 'image', src: '/canvas-imports/new-canvas.png', x: 0, y: 0, layerWidth: 600, layerHeight: 400}];
    h.setLayers(newCanvasLayers);
    h.setDimensions(600, 400);
    h.controller.sync();
    assert.equal(h.controller.isOpen(), false);
    pending.resolve({ok: true, json: async () => ({job: {id: 'late-job', status: 'done', result: {src: '/api/canvas/retouch/results/late.png'}}})});
    await h.settle();

    assert.deepEqual(h.sandbox.canvasLayers, newCanvasLayers);
    assert.deepEqual(oldLayers, oldBefore);
    assert.equal(h.counters.layerRenders, 0);
    assert.equal(h.controller.snapshot(), undefined);
});

test('notes, checks, print settings, and layers survive close and restore', async () => {
    const h = createHarness();
    await h.controller.open();
    await h.settle();
    const panel = h.counters.panels.at(-1);
    panel.actions.add('texture');
    panel.actions.change({params: {scale: 143, decay: 0.55, octaves: 4, seed: 21}, opacity: 0.17});
    panel.actions.notes('custom restoration note');
    panel.actions.check(6, true);
    panel.actions.print('widthCm', 52);
    await h.settle();
    const saved = h.controller.snapshot();
    const expected = RetouchState.normalize(saved.document);
    h.controller.close();
    h.controller.restore(saved);
    await h.controller.open();
    await h.settle();

    assert.deepEqual(h.controller.snapshot().document, expected);
    assert.equal(h.controller.snapshot().targetLayerId, saved.targetLayerId);
    assert.equal(h.counters.mergedCalls.length, 1);
    assert.equal(h.counters.savedSources.length, 1);
});

test('the controller only calls its local retouch API during edit and apply', async () => {
    const h = createHarness();
    await h.controller.open();
    await h.settle();
    h.counters.panels.at(-1).actions.apply();
    await h.waitFor(() => h.counters.layerRenders === 1, 'apply did not finish');
    await h.settle();

    assert.deepEqual(h.counters.externalCalls, []);
    assert.ok(h.counters.fetchCalls.length > 0);
    assert.ok(h.counters.fetchCalls.every(call => call.url.startsWith('/api/canvas/retouch/')));
});

test('apply retries one renderer-lock 409 after 300ms and reuses the captured body', async () => {
    let applyCount = 0;
    const h = createHarness({holdTimerDelays: [300], fetchHandler: async (url, options) => {
        if (url.endsWith('/apply')) {
            applyCount += 1;
            if (applyCount === 1) return {ok: false, status: 409, json: async () => ({message: 'renderer busy'})};
            return {ok: true, status: 202, json: async () => ({job: {id: 'retry-job', status: 'done', result: {src: '/api/canvas/retouch/results/retried.png'}}})};
        }
        return {ok: true, blob: async () => ({url})};
    }});
    await h.controller.open();
    await h.settle();
    const panel = h.counters.panels.at(-1);
    panel.actions.add('color');
    await h.settle();
    panel.actions.apply();
    await h.waitFor(() => h.pendingTimers(300) === 1, '409 did not schedule a bounded retry delay');
    assert.equal(applyCount, 1);
    assert.equal(h.pendingTimers(60), 0, 'apply clears scheduled preview refreshes');
    assert.equal(h.runTimers(300), 1);
    await h.waitFor(() => h.counters.layerRenders === 1, '202 retry result was not applied');
    await h.settle();

    const bodies = h.counters.fetchCalls.filter(call => call.url.endsWith('/apply')).map(call => JSON.stringify(call.body));
    assert.equal(applyCount, 2);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
    assert.equal(h.sandbox.canvasLayers.filter(layer => layer.type === 'image' && layer.retouch).length, 1);
    assert.equal(h.controller.snapshot(), undefined);
});

test('apply does not retry non-409 HTTP failures or unknown network errors', async () => {
    for (const failure of [
        async () => ({ok: false, status: 503, json: async () => ({message: 'service unavailable'})}),
        async () => {throw new Error('network disconnected');}
    ]) {
        let applyCount = 0;
        const h = createHarness({holdTimerDelays: [300], fetchHandler: async (url, options) => {
            if (url.endsWith('/apply')) {applyCount += 1; return failure();}
            return {ok: true, blob: async () => ({url})};
        }});
        await h.controller.open();
        await h.settle();
        const panel = h.counters.panels.at(-1);
        panel.actions.apply();
        await h.waitFor(() => panel.latest?.busy === false && panel.latest?.error === true, 'non-retryable apply failure did not settle');
        await h.settle();
        assert.equal(applyCount, 1);
        assert.equal(h.pendingTimers(300), 0);
        assert.equal(h.controller.isOpen(), true);
    }
});

test('apply stops after twenty 409 retries', async () => {
    let applyCount = 0;
    const h = createHarness({holdTimerDelays: [300], fetchHandler: async url => {
        if (url.endsWith('/apply')) {
            applyCount += 1;
            return {ok: false, status: 409, json: async () => ({message: 'renderer busy'})};
        }
        return {ok: true, blob: async () => ({url})};
    }});
    await h.controller.open();
    await h.settle();
    const panel = h.counters.panels.at(-1);
    panel.actions.apply();
    for (let retry = 0; retry < 20; retry += 1) {
        await h.waitFor(() => h.pendingTimers(300) === 1, 'retry ' + (retry + 1) + ' was not scheduled');
        assert.equal(h.runTimers(300), 1);
        await h.waitFor(() => applyCount === retry + 2 || panel.latest?.busy === false, 'retry ' + (retry + 1) + ' did not complete');
    }
    await h.waitFor(() => panel.latest?.busy === false && panel.latest?.error === true, 'exhausted conflict retries did not report completion');

    assert.equal(applyCount, 21);
    assert.equal(h.pendingTimers(300), 0);
    assert.equal(h.controller.isOpen(), true);
});

test('closing while apply waits on 409 prevents another POST', async () => {
    let applyCount = 0;
    const h = createHarness({holdTimerDelays: [300], fetchHandler: async (url, options) => {
        if (url.endsWith('/apply')) {
            applyCount += 1;
            return {ok: false, status: 409, json: async () => ({message: 'renderer busy'})};
        }
        return {ok: true, blob: async () => ({url})};
    }});
    await h.controller.open();
    await h.settle();
    h.counters.panels.at(-1).actions.apply();
    await h.waitFor(() => h.pendingTimers(300) === 1, 'apply did not wait after the first 409');
    assert.equal(applyCount, 1);

    h.controller.close();
    await h.settle();
    assert.equal(h.runTimers(300), 0);
    assert.equal(applyCount, 1);
    assert.equal(h.controller.snapshot().document.width, 1200);
});

test('detail pixel requests retry 409, keep their payload, and cancel stale previews', async () => {
    let detailCount = 0;
    const h = createHarness({holdTimerDelays: [300], fetchHandler: async (url, options) => {
        if (url.endsWith('/detail')) {
            detailCount += 1;
            if (detailCount === 1) return {ok: false, status: 409, json: async () => ({message: 'renderer busy'})};
            return {ok: true, blob: async () => ({url})};
        }
        return {ok: true, blob: async () => ({url})};
    }});
    await h.controller.open();
    await h.settle();
    const panel = h.counters.panels.at(-1);
    panel.actions.notes('detail snapshot');
    panel.actions.setTool('inspect');
    const overlay = h.stage.children[0];
    overlay.dispatch('pointerdown', {button: 0, pointerId: 1, clientX: 120, clientY: 80,
        preventDefault() {}, stopPropagation() {}});
    await h.waitFor(() => h.pendingTimers(300) === 1, 'detail request did not schedule retry after 409');
    assert.equal(h.pendingTimers(60), 0, 'pixel inspection clears scheduled preview refreshes');
    assert.equal(h.runTimers(300), 1);
    await h.waitFor(() => detailCount === 3, 'both detail images did not finish');
    await h.settle();

    const calls = h.counters.fetchCalls.filter(call => call.url.endsWith('/detail'));
    assert.equal(calls.length, 3);
    assert.equal(JSON.stringify(calls[0].body), JSON.stringify(calls[1].body));
    assert.equal(calls[0].body.original, true);
    assert.equal(calls[2].body.original, false);
    const dialog = h.document.body.children.find(child => child.tagName === 'DIALOG');
    assert.equal(dialog.open, true);
    dialog.close();
});

test('pair export cancels previews and retries export-pair 409 using one captured payload', async () => {
    let exportCount = 0;
    const h = createHarness({holdTimerDelays: [300], fetchHandler: async (url, options) => {
        if (String(url).startsWith('/api/daki/projects/')) {
            return {ok: true, json: async () => ({project: {candidates: {back: [{id: 'back-candidate', src: '/api/daki/candidates/back.png'}]}}})};
        }
        if (url.endsWith('/export-pair')) {
            exportCount += 1;
            if (exportCount === 1) return {ok: false, status: 409, json: async () => ({message: 'renderer busy'})};
            return {ok: true, blob: async () => ({url})};
        }
        return {ok: true, blob: async () => ({url})};
    }});
    h.sandbox.CanvasProject = {localLink: () => ({projectId: 'project-1', side: 'front'})};
    h.sandbox.CanvasOppositeReference = {snapshot: () => ({projectId: 'project-1', kind: 'candidate', id: 'back-candidate'})};
    await h.controller.open();
    await h.settle();
    const panel = h.counters.panels.at(-1);
    panel.actions.downloadPair();
    await h.waitFor(() => h.pendingTimers(300) === 1, 'pair export did not schedule retry after 409');
    assert.equal(h.pendingTimers(60), 0, 'pair export clears scheduled preview refreshes');
    assert.equal(h.runTimers(300), 1);
    await h.waitFor(() => panel.latest?.busy === false && String(panel.latest?.message).includes('양면 ZIP'), 'pair export completion was not reflected in the panel');

    const calls = h.counters.fetchCalls.filter(call => call.url.endsWith('/export-pair'));
    assert.equal(exportCount, 2);
    assert.equal(calls.length, 2);
    assert.equal(JSON.stringify(calls[0].body), JSON.stringify(calls[1].body));
    assert.equal(calls[0].body.otherSource, '/api/daki/candidates/back.png');
    assert.equal(calls[0].body.side, 'front');
    assert.deepEqual(h.counters.externalCalls, []);
});
