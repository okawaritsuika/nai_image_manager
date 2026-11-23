const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {test} = require('node:test');

const source = fs.readFileSync(require.resolve('../static/canvas.js'), 'utf8');
const warning = fs.readFileSync(require.resolve('../static/common_anlas_warning.js'), 'utf8');
const settings = fs.readFileSync(require.resolve('../static/canvas_inpaint_settings.js'), 'utf8');
const section = (start, next) => source.slice(source.indexOf('function ' + start + '('), source.indexOf('function ' + next + '('));

test('the expanded crop uses the same charge estimate as submission, including steps and reference width', () => {
    let referenceWidth = 0;
    let steps = 28;
    let editor;
    const clip = {id: 2};
    const ctx = vm.createContext({
        NAI_FREE_AREA_LIMIT: 1048576,
        buildEffectiveClipPromptInfo(target) { assert.equal(target, clip); return {steps}; },
        CanvasInpaintReference: {request(width, height) {
            if (referenceWidth === null) throw new Error('missing reference');
            return {width: width + referenceWidth, height};
        }},
        CanvasClipBoundaryEditor: {mount(_panel, _state, options) { editor = options; }},
        bindClipOutputPanelResize() {}
    });
    ctx.window = ctx;
    vm.runInContext(warning + section('getCanvasSizeWarning', 'updateSelectionSizeTooltip') +
        section('bindClipBoundaryEditor', 'renderClipOutputPanel'), ctx);
    ctx.bindClipBoundaryEditor({querySelector: () => ({})}, {clip}, {});
    const estimate = (width, height) => editor.getRequestEstimate({width, height}, editor.getSteps());
    assert.equal(estimate(1024, 1024).cost, 0);
    assert.ok(estimate(1088, 1024).cost > 0);
    assert.equal(estimate(960, 1024).cost, 0);
    referenceWidth = 128;
    assert.equal(estimate(960, 1024).width, 1088);
    assert.equal(estimate(960, 1024).cost, ctx.getExpectedAnlasCost(1088, 1024, 28));
    referenceWidth = 0;
    steps = 29;
    assert.ok(estimate(512, 512).cost > 0);
    referenceWidth = null;
    assert.equal(estimate(512, 512).cost, 0);
});

test('saved generation step changes notify an open editor without requiring it to reopen', () => {
    const win = new EventTarget();
    const ctx = vm.createContext({window: win, Event, normalizePromptInfo: value => value,
        NAI_GENERATION_FIELDS: [{key: 'steps'}]});
    vm.runInContext(settings, ctx);
    const changes = [];
    win.addEventListener('canvas-inpaint-settings-changed', () => {
        changes.push(win.CanvasInpaintSettings.snapshot()?.steps);
    });
    win.CanvasInpaintSettings.update({steps: 29});
    win.CanvasInpaintSettings.update({steps: 28});
    win.CanvasInpaintSettings.restore(null);
    assert.deepEqual(changes, [29, 28, undefined]);
});
