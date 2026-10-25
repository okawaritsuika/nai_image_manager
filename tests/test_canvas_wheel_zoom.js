const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas.js'), 'utf8');
function functionSource(name) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf('\nfunction ', start + 1);
    return source.slice(start, end);
}

function harness() {
    const bindings = [];
    const workspace = {dataset: {}, scrollLeft: 0, scrollTop: 0,
        addEventListener: (...args) => bindings.push(args)};
    let renders = 0, saves = 0, prevented = 0;
    const context = vm.createContext({
        document: {querySelector: () => workspace},
        el: () => ({getBoundingClientRect: () => ({left: 0, top: 0})}),
        currentCanvasWidth: 640, currentCanvasHeight: 2048, canvasZoom: 1,
        WHEEL_ZOOM_STEP: 1.1, CANVAS_ZOOM_MIN: 0.1, CANVAS_ZOOM_MAX: 10,
        hasActiveCanvasGeometryDrag: () => false,
        getCanvasDisplayScale: () => context.canvasZoom,
        renderCanvas: () => { renders++; }, saveCanvasState: () => { saves++; },
        requestAnimationFrame: callback => callback(),
    });
    for (const name of ['clampZoom', 'getWheelZoomFactor', 'bindCanvasWheelZoom', 'handleCanvasWheelZoom']) {
        vm.runInContext(functionSource(name), context);
    }
    const wheel = (target, deltaY = -120) => context.handleCanvasWheelZoom({
        target, deltaY, clientX: 100, clientY: 200,
        preventDefault: () => { prevented++; }, stopPropagation() {},
    });
    return {context, workspace, bindings, wheel,
        counts: () => ({renders, saves, prevented})};
}

test('wheel binds once to the workspace so its background and opposite preview can zoom', () => {
    const h = harness();
    h.context.bindCanvasWheelZoom();
    h.context.bindCanvasWheelZoom();
    assert.equal(h.bindings.length, 1);
    assert.equal(h.bindings[0][0], 'wheel');
    assert.equal(h.bindings[0][2].passive, false);
    for (const area of ['canvas-surface', 'canvas-workspace', 'canvas-opposite-preview']) {
        h.wheel({closest: () => null, className: area});
    }
    assert.ok(h.context.canvasZoom > 1);
    assert.deepEqual(h.counts(), {renders: 3, saves: 3, prevented: 3});
    assert.ok(h.workspace.scrollLeft > 0);
    assert.ok(h.workspace.scrollTop > 0);
    h.wheel({closest: () => null}, 120);
    assert.ok(Math.abs(h.context.canvasZoom - 1.21) < 1e-9);
});

test('embedded controls retain scrolling and zero vertical delta does not zoom', () => {
    const h = harness();
    for (const selector of ['.canvas-clip-output-panel', '.canvas-pinned-reference-panel',
        '#canvasDakiFocus', '.canvas-multi-references', 'input', 'textarea', 'select', 'button', '[contenteditable="true"]']) {
        h.wheel({closest: selectors => selectors.split(', ').includes(selector) ? {} : null});
    }
    h.wheel({closest: () => null}, 0);
    assert.equal(h.context.canvasZoom, 1);
    assert.deepEqual(h.counts(), {renders: 0, saves: 0, prevented: 0});
});

test('geometry dragging blocks wheel zoom and empty canvases remain unchanged', () => {
    const h = harness();
    h.context.hasActiveCanvasGeometryDrag = () => true;
    h.wheel({closest: () => null});
    assert.deepEqual(h.counts(), {renders: 0, saves: 0, prevented: 1});
    h.context.currentCanvasWidth = 0;
    h.wheel({closest: () => null});
    assert.equal(h.context.canvasZoom, 1);
    assert.deepEqual(h.counts(), {renders: 0, saves: 0, prevented: 1});
});
