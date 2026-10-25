const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas.js'), 'utf8');
const start = source.indexOf('function getClipOutputPanelDefaultPosition(');
const end = source.indexOf('\nfunction bindClipOutputPanelDrag(', start);
const sizeStart = source.indexOf('function getClipOutputViewportSize(');
const sizeEnd = source.indexOf('\nfunction startClipOutputPanelDrag(', sizeStart);

function clipSizeHarness({imageWidth = 512, imageHeight = 512, imageViewportWidth = 400,
    imageViewportHeight = 300, compactChromeExtra = 40,
    transientHorizontalScrollbar = false} = {}) {
    const classes = new Set();
    const captures = {set: [], released: []};
    const resizeHandle = {
        setPointerCapture(id) { captures.set.push(id); },
        releasePointerCapture(id) { captures.released.push(id); }
    };
    const autoSizeButton = {};
    const panel = {
        style: {width: `${imageViewportWidth + 28}px`, height: `${imageViewportHeight + 142}px`,
            maxWidth: '546px', maxHeight: '868px'},
        dataset: {},
        get offsetWidth() { return parseFloat(this.style.width) || 0; },
        get offsetHeight() {
            return this.style.height === 'auto' ? panelChromeHeight() + 2 : parseFloat(this.style.height) || 0;
        },
        getBoundingClientRect() {
            return {left: 0, top: 0, width: this.offsetWidth, height: this.offsetHeight};
        },
        classList: {
            add(name) { classes.add(name); },
            remove(name) { classes.delete(name); },
            toggle(name, force) {
                if (force) classes.add(name); else classes.delete(name);
                return classes.has(name);
            },
            contains(name) { return classes.has(name); }
        },
        querySelector(selector) {
            if (selector === '.canvas-clip-output-image-wrap') return wrap;
            if (selector === '.clip-output-resize-handle') return resizeHandle;
            if (selector === '.clip-output-auto-size') return autoSizeButton;
            return null;
        }
    };
    const panelChromeHeight = () => 140 + (classes.has('compact') ? compactChromeExtra : 0);
    const wrap = {
        getBoundingClientRect() {
            return {left: 0, top: 0, width: panel.offsetWidth - 26,
                height: panel.offsetHeight - panelChromeHeight()};
        },
        get clientWidth() {
            const rect = this.getBoundingClientRect();
            return Math.max(0, Math.floor(rect.width - 2));
        },
        get clientHeight() {
            const rect = this.getBoundingClientRect();
            const scrollbar = transientHorizontalScrollbar && classes.has('compact') ? 17 : 0;
            return Math.max(0, Math.floor(rect.height - 2) - scrollbar);
        }
    };
    const clip = {imageWidth, imageHeight};
    let overlaySyncs = 0;
    let globalListeners = 0;
    const context = {
        clipOutputPanelPosition: null,
        getComputedStyle: () => ({borderLeftWidth: '1px', borderRightWidth: '1px',
            borderTopWidth: '1px', borderBottomWidth: '1px'}),
        window: {innerWidth: 1920, innerHeight: 900,
            addEventListener() { globalListeners++; }, removeEventListener() { globalListeners--; }},
        getCanvasDisplayScale: () => 1,
        normalizeSelectionAreaGeometry() {},
        syncOverlay() { overlaySyncs++; }
    };
    vm.createContext(context);
    vm.runInContext(source.slice(start, end), context);
    vm.runInContext(source.slice(sizeStart, sizeEnd), context);
    return {context, panel, wrap, clip, resizeHandle, autoSizeButton, captures,
        viewport: () => context.getClipOutputViewportSize(wrap),
        overlaySyncs: () => overlaySyncs, globalListeners: () => globalListeners};
}

function pointerEvent({x = 0, y = 0, pointerId = 7, key = null} = {}) {
    let prevented = false;
    let stopped = false;
    return {button: 0, clientX: x, clientY: y, pointerId, key,
        preventDefault() { prevented = true; }, stopPropagation() { stopped = true; },
        wasPrevented: () => prevented, wasStopped: () => stopped};
}

function harness({width = 580, height = 620, panelWidth = 420, panelHeight = 500,
    stageLeft = 350, stageTop = 180, scale = 1, position = null} = {}) {
    const workspace = {clientWidth: width, clientHeight: height, clientLeft: 1, clientTop: 1,
        getBoundingClientRect: () => ({left: 300, top: 130})};
    const panel = {style: {}, closest: () => workspace, getBoundingClientRect: () => ({
        left: stageLeft + (parseFloat(panel.style.left) || 0),
        top: stageTop + (parseFloat(panel.style.top) || 0), width: panelWidth, height: panelHeight
    })};
    const context = {clipOutputPanelPosition: position, window: {innerWidth: 1920, innerHeight: 1080}, getCanvasDisplayScale: () => scale,
        normalizeSelectionAreaGeometry() {}};
    vm.createContext(context);
    vm.runInContext(source.slice(start, end), context);
    return {context, panel, workspace};
}

test('default panel fits the visible workspace without modifying canvas coordinates', () => {
    const {context, panel} = harness();
    const selection = {id: 1, x: 600, y: 450, layerWidth: 512};
    const before = JSON.stringify(selection);
    context.positionClipOutputPanel(panel, selection, {id: 2});
    const bounds = panel.getBoundingClientRect();
    assert.equal(bounds.left, 453);
    assert.equal(bounds.top, 243);
    assert.equal(bounds.left + bounds.width, 873);
    assert.equal(bounds.top + bounds.height, 743);
    assert.equal(JSON.stringify(selection), before);
    assert.equal(context.clipOutputPanelPosition.canvasLeft, 1112);
    assert.equal(context.clipOutputPanelPosition.canvasTop, 450);
    assert.equal(context.clipOutputPanelPosition.custom, false);
});

test('manually dragged panel retains its exact stored positioning at every zoom', () => {
    const position = {targetKey: '1:2', canvasLeft: 1200, canvasTop: -80, custom: true};
    const {context, panel} = harness({position, scale: 0.5});
    context.positionClipOutputPanel(panel, {id: 1}, {id: 2});
    assert.equal(panel.style.left, '618px');
    assert.equal(panel.style.top, '-40px');
    assert.equal(context.clipOutputPanelPosition, position);
});

test('oversized panel keeps its title and toolbar beginning visible and may extend for scrolling', () => {
    const {context, panel} = harness({width: 300, height: 280, panelWidth: 560, panelHeight: 700});
    context.positionClipOutputPanel(panel, {id: 1, x: 600, y: 500, layerWidth: 512}, {id: 2});
    const bounds = panel.getBoundingClientRect();
    assert.equal(bounds.left, 309);
    assert.equal(bounds.top, 139);
    assert.equal(bounds.width, 560);
    assert.equal(bounds.height, 700);
});

test('scrolling and translated stage origins are accounted for without double applying zoom', () => {
    const {context, panel} = harness({stageLeft: -240, stageTop: -180, scale: 0.5});
    context.positionClipOutputPanel(panel, {id: 1, x: 0, y: 0, layerWidth: 256}, {id: 2});
    const bounds = panel.getBoundingClientRect();
    assert.equal(bounds.left, 309);
    assert.equal(bounds.top, 139);
    assert.equal(context.clipOutputPanelPosition.canvasLeft, 256);
});

test('an already visible default panel is not moved', () => {
    const {context, panel} = harness();
    context.positionClipOutputPanel(panel, {id: 1, x: 0, y: 0, layerWidth: 64}, {id: 2});
    assert.equal(panel.style.left, '82px');
    assert.equal(panel.style.top, '0px');
});

test('a workspace taller than the browser keeps the panel and resize corner inside the viewport', () => {
    const {context, panel} = harness({height: 1200, panelHeight: 640});
    context.window.innerHeight = 900;
    context.positionClipOutputPanel(panel, {id: 1, x: 600, y: 500, layerWidth: 512}, {id: 2});
    const bounds = panel.getBoundingClientRect();
    assert.equal(bounds.top + bounds.height, 892);
    assert.equal(panel.style.maxHeight, '753px');
});

test('dragging a clamped negative position starts smoothly and survives rerendering', () => {
    const {context, panel} = harness({width: 300, panelWidth: 560, scale: 0.5});
    const selection = {id: 1, x: 600, y: 0, layerWidth: 512};
    context.positionClipOutputPanel(panel, selection, {id: 2});
    assert.equal(panel.style.left, '-41px');
    panel.classList = {add() {}};
    const dragStart = source.indexOf('function startClipOutputPanelDrag(');
    const dragEnd = source.indexOf('\nfunction stopClipOutputPanelDrag(', dragStart);
    vm.runInContext(source.slice(dragStart, dragEnd), context);
    const event = {button: 0, clientX: 100, clientY: 100, preventDefault() {}, stopPropagation() {}};
    context.startClipOutputPanelDrag(event, panel);
    context.handleClipOutputPanelDragMove({...event, clientX: 110});
    assert.equal(panel.style.left, '-31px');
    assert.equal(context.clipOutputPanelPosition.custom, true);
    context.positionClipOutputPanel(panel, selection, {id: 2});
    assert.equal(panel.style.left, '-31px');
});

test('automatic clip sizing follows image aspect ratio and caps tall output at available height', () => {
    const dimensions = [
        {name: 'wide', width: 1024, height: 512},
        {name: 'square', width: 512, height: 512},
        {name: 'tall', width: 512, height: 1024},
        {name: 'small', width: 128, height: 256}
    ].map(({name, width, height}) => {
        const fixture = clipSizeHarness({imageWidth: width, imageHeight: height});
        fixture.context.fitClipOutputPanelToImage(fixture.panel, fixture.clip);
        const outerWidth = parseFloat(fixture.panel.style.width);
        const outerHeight = parseFloat(fixture.panel.style.height);
        return {name, fixture, outerWidth, outerHeight};
    });
    assert.equal(new Set(dimensions.map(({outerWidth, outerHeight}) => `${outerWidth}x${outerHeight}`)).size, 4);
    for (const {name, fixture, outerHeight} of dimensions) {
        assert.ok(outerHeight <= 868, `${name} panel exceeds the available height`);
        const viewport = fixture.viewport();
        const scale = Math.min(viewport.width / fixture.clip.imageWidth,
            viewport.height / fixture.clip.imageHeight);
        assert.ok(scale > 0, `${name} image has no visible viewport`);
        assert.ok(fixture.clip.imageWidth * scale <= viewport.width);
        assert.ok(fixture.clip.imageHeight * scale <= viewport.height);
    }
    assert.equal(dimensions.find(({name}) => name === 'wide').outerWidth, 546);
    assert.equal(dimensions.find(({name}) => name === 'tall').outerHeight, 868);
    assert.equal(dimensions.find(({name}) => name === 'small').outerWidth, 420);
});

test('horizontal and vertical corner drags apply one proportional factor to both image axes', () => {
    for (const movement of [{dx: 40, dy: 0}, {dx: 0, dy: 30}]) {
        const fixture = clipSizeHarness({imageWidth: 1024, imageHeight: 768,
            imageViewportWidth: 400, imageViewportHeight: 300});
        const startViewport = fixture.viewport();
        const startWidth = startViewport.width;
        const startHeight = startViewport.height;
        const expectedScale = fixture.context.getClipOutputResizeScale(startWidth, startHeight,
            movement.dx, movement.dy);
        assert.ok(Math.abs(expectedScale - 1.1) < 1e-12);
        fixture.context.bindClipOutputPanelResize(fixture.panel, fixture.clip,
            () => fixture.context.syncOverlay());
        fixture.resizeHandle.onpointerdown(pointerEvent());
        fixture.resizeHandle.onpointermove(pointerEvent({x: movement.dx, y: movement.dy}));
        fixture.resizeHandle.onpointerup(pointerEvent());
        const viewport = fixture.viewport();
        assert.ok(Math.abs(viewport.width / startWidth - expectedScale) < 1e-12);
        assert.ok(Math.abs(viewport.height / startHeight - expectedScale) < 1e-12);
        assert.equal(fixture.panel.dataset.manualSize, '1');
        assert.equal(fixture.overlaySyncs(), 1);
    }
});

test('crossing the compact width threshold keeps the extra toolbar row outside image scaling', () => {
    const fixture = clipSizeHarness({imageWidth: 1024, imageHeight: 768,
        imageViewportWidth: 400, imageViewportHeight: 300, compactChromeExtra: 40});
    fixture.context.bindClipOutputPanelResize(fixture.panel, fixture.clip,
        () => fixture.context.syncOverlay());
    fixture.resizeHandle.onpointerdown(pointerEvent());
    fixture.resizeHandle.onpointermove(pointerEvent({x: -20}));
    fixture.resizeHandle.onpointerup(pointerEvent());
    assert.equal(fixture.panel.classList.contains('compact'), true);
    assert.equal(fixture.viewport().width, 380);
    assert.equal(fixture.viewport().height, 285);
});

test('transient horizontal scrollbars do not become panel chrome while shrinking a wide panel', () => {
    function shrink(transientHorizontalScrollbar) {
        const fixture = clipSizeHarness({imageWidth: 1024, imageHeight: 768,
            imageViewportWidth: 400, imageViewportHeight: 300, transientHorizontalScrollbar});
        fixture.context.bindClipOutputPanelResize(fixture.panel, fixture.clip,
            () => fixture.context.syncOverlay());
        fixture.resizeHandle.onpointerdown(pointerEvent());
        fixture.resizeHandle.onpointermove(pointerEvent({x: -60}));
        fixture.resizeHandle.onpointerup(pointerEvent());
        return fixture;
    }
    const ordinary = shrink(false);
    const withScrollbar = shrink(true);
    assert.equal(withScrollbar.panel.style.width, ordinary.panel.style.width);
    assert.equal(withScrollbar.panel.style.height, ordinary.panel.style.height);
    assert.equal(withScrollbar.viewport().height, ordinary.viewport().height);
    assert.equal(withScrollbar.wrap.clientHeight, withScrollbar.viewport().height - 17);
    assert.equal(ordinary.wrap.clientHeight, ordinary.viewport().height);
});

test('pointer cancel releases capture and disposing the resize binding clears element handlers', () => {
    const fixture = clipSizeHarness();
    const dispose = fixture.context.bindClipOutputPanelResize(fixture.panel, fixture.clip,
        () => fixture.context.syncOverlay());
    fixture.resizeHandle.onpointerdown(pointerEvent());
    assert.deepEqual(fixture.captures.set, [7]);
    fixture.resizeHandle.onpointercancel(pointerEvent());
    assert.deepEqual(fixture.captures.released, [7]);
    assert.equal(fixture.panel.classList.contains('resizing'), false);

    fixture.resizeHandle.onpointerdown(pointerEvent({pointerId: 8}));
    dispose();
    assert.deepEqual(fixture.captures.released, [7, 8]);
    for (const name of ['onpointerdown', 'onpointermove', 'onpointerup', 'onpointercancel',
        'onlostpointercapture', 'onkeydown']) {
        assert.equal(fixture.resizeHandle[name], null, `${name} was left attached`);
    }
    assert.equal(fixture.autoSizeButton.onclick, null);
    assert.equal(fixture.globalListeners(), 0);
});

test('keyboard resize and auto-size control keep manual sizing reversible', () => {
    const fixture = clipSizeHarness({imageWidth: 128, imageHeight: 128});
    fixture.context.fitClipOutputPanelToImage(fixture.panel, fixture.clip);
    const autoWidth = fixture.panel.style.width;
    const autoHeight = fixture.panel.style.height;
    fixture.context.bindClipOutputPanelResize(fixture.panel, fixture.clip,
        () => fixture.context.syncOverlay());
    const startViewport = fixture.viewport();
    const startWidth = startViewport.width;
    const startHeight = startViewport.height;
    const arrow = pointerEvent({key: 'ArrowRight'});
    fixture.resizeHandle.onkeydown(arrow);
    assert.equal(arrow.wasPrevented(), true);
    assert.equal(arrow.wasStopped(), true);
    const keyboardScale = 1 + 16 / startWidth;
    assert.ok(Math.abs(fixture.viewport().width - startWidth * keyboardScale) <= 1);
    assert.ok(Math.abs(fixture.viewport().height - startHeight * keyboardScale) <= 1);
    assert.equal(fixture.panel.dataset.manualSize, '1');

    const home = pointerEvent({key: 'Home'});
    fixture.resizeHandle.onkeydown(home);
    assert.equal(home.wasPrevented(), true);
    assert.equal(fixture.panel.style.width, autoWidth);
    assert.equal(fixture.panel.style.height, autoHeight);
    assert.equal(fixture.panel.dataset.manualSize, '');

    fixture.resizeHandle.onkeydown(pointerEvent({key: 'ArrowRight'}));
    assert.equal(fixture.panel.dataset.manualSize, '1');

    fixture.autoSizeButton.onclick();
    assert.equal(fixture.panel.style.width, autoWidth);
    assert.equal(fixture.panel.style.height, autoHeight);
    assert.equal(fixture.panel.dataset.manualSize, '');
    assert.ok(fixture.overlaySyncs() >= 2);
});
