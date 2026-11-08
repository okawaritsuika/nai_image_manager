const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {test} = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, '../static/canvas.js'), 'utf8');
function harness() {
    const bindings = [], captures = [], transforms = [];
    const workspace = {dataset: {}, classList: {add() {}, remove() {}},
        addEventListener: (...args) => bindings.push(args), setPointerCapture: id => captures.push(id), releasePointerCapture() {}};
    const context = vm.createContext({
        document: {querySelector: () => workspace},
        window: {},
        isLayerMoveMode: false, isImageResizeMode: false, isCanvasResizeMode: false, canvasLayerEraserEnabled: false,
        hasActiveCanvasGeometryDrag: () => false, activeCanvasPanDrag: null, activeLayerId: 77,
        canvasPanOffsetX: 10, canvasPanOffsetY: 20,
        applyCanvasWorkspacePanOffset() {transforms.push([context.canvasPanOffsetX, context.canvasPanOffsetY]);},
    });
    for (const name of ['isCanvasWorkspacePanTarget', 'bindCanvasWorkspacePanDrag', 'startCanvasWorkspacePanDrag',
        'handleCanvasWorkspacePanDragMove', 'stopCanvasWorkspacePanDrag']) {
        const start=source.indexOf(`function ${name}(`), end=source.indexOf('\nfunction ', start+1);
        vm.runInContext(source.slice(start,end),context);
    }
    const target = (...selectors) => ({closest: selector => selector.split(',').some(value => selectors.includes(value.trim())) ? {} : null});
    return {context, workspace, bindings, captures, transforms, target};
}
test('canvas images and existing clip selection bodies pan by default, while editing tools retain their targets', () => {
    const h=harness();
    for(const type of ['.canvas-render-layer.image-layer','.selection-area-layer']) {
        const event={target:h.target('.canvas-workspace',type)};
        assert.equal(h.context.isCanvasWorkspacePanTarget(event),true);
        for(const mode of ['isLayerMoveMode','isImageResizeMode','isCanvasResizeMode','canvasLayerEraserEnabled']) {
            h.context[mode]=true;
            assert.equal(h.context.isCanvasWorkspacePanTarget(event),false,mode);
            h.context[mode]=false;
        }
    }
    for(const type of ['button','input','.canvas-retouch-surface-overlay','.selection-direct-edit','.selection-rotate-handle',
        '.selection-resize-handle','.image-resize-handle','.canvas-pinned-reference-panel']) {
        assert.equal(h.context.isCanvasWorkspacePanTarget({target:h.target('.canvas-workspace',type)}),false,type);
    }
});
test('retouch hand and space modes can pan without intercepting comparison or brush controls', () => {
    const h = harness();
    const target = h.target('.canvas-workspace', '.canvas-retouch-surface-overlay');
    h.context.window.CanvasRetouch = {canPan: () => false};
    assert.equal(h.context.isCanvasWorkspacePanTarget({target}), false);
    h.context.window.CanvasRetouch.canPan = () => true;
    assert.equal(h.context.isCanvasWorkspacePanTarget({target}), true);
    assert.equal(h.context.isCanvasWorkspacePanTarget({target: h.target('.canvas-workspace',
        '.canvas-retouch-surface-overlay', '.canvas-retouch-compare-handle')}), false);
});
test('primary pointer drag moves the viewport without changing the selected layer', () => {
    const h=harness(); let prevented=0;
    h.context.startCanvasWorkspacePanDrag({button:0,pointerId:5,clientX:100,clientY:200,
        target:h.target('.canvas-workspace','.canvas-render-layer.image-layer'),preventDefault(){prevented++;},stopPropagation(){}});
    assert.equal(prevented,1); assert.deepEqual(h.captures,[5]);
    h.context.handleCanvasWorkspacePanDragMove({pointerId:5,clientX:145,clientY:170,preventDefault(){}});
    assert.deepEqual(h.transforms,[[55,-10]]);
    assert.equal(h.context.activeLayerId,77);
    h.context.stopCanvasWorkspacePanDrag({pointerId:5});
    assert.equal(h.context.activeCanvasPanDrag,null);
});
test('pan intercepts pointerdown before image selection and binds once', () => {
    const h=harness();h.context.bindCanvasWorkspacePanDrag();h.context.bindCanvasWorkspacePanDrag();
    const starts=h.bindings.filter(([event])=>event==='pointerdown');
    assert.equal(starts.length,1); assert.equal(starts[0][2].capture,true);
});
