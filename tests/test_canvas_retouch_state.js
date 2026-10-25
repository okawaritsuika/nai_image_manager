const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const state = require('../static/canvas_retouch_state.js');

function documentWith(layers = []) {
    return {
        version: 1,
        source: '/api/retouch/source/synthetic.png',
        width: 512,
        height: 1024,
        layers,
        print: {widthCm: 50, heightCm: 160, safeMm: 5},
        notes: '',
        checks: []
    };
}

test('browser UMD export is available as CanvasRetouchState', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas_retouch_state.js'), 'utf8');
    const context = {};
    vm.runInNewContext(source, context);
    assert.equal(typeof context.CanvasRetouchState.createLayer, 'function');
    assert.deepEqual(Array.from(context.CanvasRetouchState.CHECKS), state.CHECKS);
});

test('metadata retains all retouch layer kinds, canvas tools, and review checks', () => {
    assert.deepEqual(Object.keys(state.NAMES), ['color', 'tone', 'paint', 'clone', 'blur', 'line', 'texture', 'sharpen', 'liquify']);
    assert.deepEqual(state.TOOLS.map(tool => tool.id), ['hand', 'paint', 'maskErase', 'airbrush', 'clone', 'liquify', 'dropper', 'rect', 'ellipse', 'inspect']);
    assert.ok(state.TOOLS.every(tool => Object.keys(tool).sort().join(',') === 'id,label'));
    assert.equal(state.CHECKS.length, 8);
    assert.equal(state.PARAMS.tone.length, 6);
    assert.deepEqual(state.MODES.paint, ['normal', 'soft-light', 'color', 'multiply', 'screen']);
});

test('createLayer uses the original defaults and fresh nested values', () => {
    const ids = ['first', 'second'];
    const color = state.createLayer('color', () => ids.shift());
    const blur = state.createLayer('blur', () => ids.shift());
    assert.deepEqual(color, {
        id: 'first', type: 'color', name: '색 덧입히기',
        params: {color: '#ffe0cd', mode: 'soft-light'}, opacity: 0.07, visible: true,
        mask: {base: 1, strokes: []}, strokes: []
    });
    assert.deepEqual(blur.params, {radius: 6});
    assert.equal(blur.opacity, 1);
    assert.deepEqual(blur.mask, {base: 0, strokes: []});
    color.params.color = '#000000';
    assert.equal(state.createLayer('color', () => 'third').params.color, '#ffe0cd');
    assert.throws(() => state.createLayer('unknown'), RangeError);
});

test('recipe preserves the eight original names, parameters, opacity, and mask defaults', () => {
    const layers = state.recipe((() => { let n = 0; return () => `recipe-${++n}`; })());
    assert.deepEqual(layers.map(layer => [layer.type, layer.name, layer.opacity, layer.mask.base]), [
        ['color', '피부 톤 통일', 0.53, 0],
        ['color', '따뜻한 색감', 0.07, 1],
        ['tone', '밝기 +2 · 대비 −3', 1, 1],
        ['color', '부드러운 베이지 막', 0.04, 1],
        ['line', '중요한 선 정리', 0.4, 0],
        ['color', '홍조 정리', 0.18, 0],
        ['texture', '펄린 미세 질감', 0.02, 1],
        ['sharpen', '마지막 선택적 샤프닝', 0.5, 0]
    ]);
    assert.deepEqual(layers[0].params, {color: '#e6baa4', mode: 'color'});
    assert.deepEqual(layers[1].params, {color: '#ffe0cd', mode: 'soft-light'});
    assert.deepEqual(layers[2].params, {brightness: 2, contrast: -3, saturation: 0, shadows: 0, highlights: 0});
    assert.deepEqual(layers[3].params, {color: '#f5eee8', mode: 'normal'});
    assert.deepEqual(layers[4].params, {strength: 1.5});
    assert.deepEqual(layers[5].params, {color: '#f15e32', mode: 'color'});
    assert.deepEqual(layers[6].params, {scale: 100, decay: 0.4, octaves: 3, seed: 17});
    assert.deepEqual(layers[7].params, {radius: 5, amount: 100, threshold: 0});
    assert.ok(layers.every(layer => layer.strokes.length === 0 && layer.mask.strokes.length === 0));
});

test('recipe step metadata exposes the stable selection ids and mask scopes', () => {
    assert.deepEqual(state.RECIPE_STEPS, [
        {id: 'skin-tone', label: '피부 톤 통일', scope: 'painted'},
        {id: 'warm-color', label: '따뜻한 색감', scope: 'all'},
        {id: 'tone', label: '밝기 +2 · 대비 −3', scope: 'all'},
        {id: 'beige', label: '부드러운 베이지 막', scope: 'all'},
        {id: 'line', label: '중요한 선 정리', scope: 'painted'},
        {id: 'blush', label: '홍조 정리', scope: 'painted'},
        {id: 'texture', label: '펄린 미세 질감', scope: 'all'},
        {id: 'sharpen', label: '마지막 선택적 샤프닝', scope: 'painted'}
    ]);
});

test('recipe selects valid unique step ids in original order and creates independent layers', () => {
    let nextId = 0;
    const makeId = () => `recipe-layer-${++nextId}`;
    const selected = state.recipe(makeId, ['sharpen', 'tone', 'tone', 'unknown']);
    assert.deepEqual(selected.map(layer => layer.name), ['밝기 +2 · 대비 −3', '마지막 선택적 샤프닝']);
    assert.deepEqual(selected.map(layer => layer.id), ['recipe-layer-1', 'recipe-layer-2']);
    assert.equal(Object.hasOwn(selected[0], 'stepId'), false);
    assert.deepEqual(state.recipe(makeId, []), []);
    for (const invalid of ['tone', null, {}, ['unknown']]) assert.deepEqual(state.recipe(makeId, invalid), []);

    const first = state.recipe(makeId, ['tone'])[0];
    const second = state.recipe(makeId, ['tone'])[0];
    assert.notStrictEqual(first.params, second.params);
    assert.notStrictEqual(first.mask, second.mask);
    first.params.brightness = 30;
    first.mask.strokes.push({points: [[1, 2]], radius: 3});
    assert.equal(second.params.brightness, 2);
    assert.deepEqual(second.mask.strokes, []);
});

test('preset groups and catalog metadata describe the supported choices', () => {
    assert.deepEqual(state.PRESET_GROUPS, [
        {id: 'global', label: '전체 분위기'},
        {id: 'skin', label: '피부 · 혈색'},
        {id: 'light', label: '음영 · 빛'}
    ]);
    assert.equal(state.PRESETS.length, 14);
    for (const id of ['rose', 'peach', 'warm-shadow', 'cool-shadow', 'soft-light', 'vivid', 'depth']) {
        assert.ok(state.PRESETS.some(preset => preset.id === id), `legacy preset ${id} remains available`);
    }
    let catalogId = 0;
    for (const preset of state.PRESETS) {
        assert.equal(typeof preset.label, 'string');
        assert.ok(preset.label.length > 0);
        assert.equal(typeof preset.hint, 'string');
        assert.ok(preset.hint.length > 0);
        assert.ok(['local', 'global'].includes(preset.scope));
        assert.ok(state.PRESET_GROUPS.some(group => group.id === preset.group));
        assert.ok(Number.isInteger(preset.layerCount) && preset.layerCount >= 1);
        const created = state.createPreset(preset.id, () => `catalog-${++catalogId}`);
        assert.equal(created.layers.length, preset.layerCount);
        assert.strictEqual(created.layer, created.layers[0]);
        assert.equal(new Set(created.layers.map(layer => layer.id)).size, preset.layerCount);
    }
    assert.deepEqual(state.PRESETS.filter(preset => preset.layerCount === 2).map(preset => preset.id), ['warm-look', 'cool-look']);
});

test('legacy local and global presets retain their layer settings', () => {
    let index = 0;
    const makeId = () => `legacy-${++index}`;
    const expectedLocal = [
        ['rose', '#e47789', 'color', 4],
        ['peach', '#ed9a78', 'color', 4],
        ['warm-shadow', '#b97c78', 'multiply', 3],
        ['cool-shadow', '#9e91b2', 'multiply', 3],
        ['soft-light', '#f4d5b9', 'soft-light', 3]
    ];
    for (const [id, color, mode, flow] of expectedLocal) {
        const preset = state.createPreset(id, makeId);
        assert.strictEqual(preset.layer, preset.layers[0]);
        assert.equal(preset.layers.length, 1);
        assert.equal(preset.layer.type, 'paint');
        assert.deepEqual(preset.layer.params, {mode, color});
        assert.equal(preset.layer.opacity, 1);
        assert.deepEqual(preset.layer.mask, {base: 1, strokes: []});
        assert.deepEqual(preset.layer.strokes, []);
        assert.equal(preset.tool, 'airbrush');
        assert.deepEqual(preset.brush, {size: 160, flow, opacity: 100, hardness: 0, color});
    }
    const vivid = state.createPreset('vivid', makeId);
    const depth = state.createPreset('depth', makeId);
    assert.deepEqual(vivid.layer.params, {brightness: 0, contrast: 0, saturation: 0, vibrance: 18, shadows: 0, highlights: 0});
    assert.deepEqual(depth.layer.params, {brightness: 0, contrast: 6, saturation: 0, vibrance: 0, shadows: 0, highlights: 0});
    assert.equal(vivid.tool, 'hand');
    assert.equal(Object.hasOwn(vivid, 'brush'), false);
    assert.equal(depth.tool, 'hand');
    assert.equal(Object.hasOwn(depth, 'brush'), false);
    assert.equal(state.createPreset('unknown'), null);
});

test('new skin presets stay local and add the requested colors', () => {
    const coral = state.createPreset('coral', () => 'coral');
    const mutedRose = state.createPreset('muted-rose', () => 'muted-rose');
    assert.deepEqual([coral.layer.name, coral.layer.params, coral.brush.flow], ['살구빛 혈색', {mode: 'color', color: '#e78a72'}, 3]);
    assert.deepEqual([mutedRose.layer.name, mutedRose.layer.params, mutedRose.brush.flow], ['차분한 장밋빛', {mode: 'color', color: '#c87f91'}, 3]);
    for (const preset of [coral, mutedRose]) {
        assert.equal(preset.layer.type, 'paint');
        assert.equal(preset.layer.mask.base, 1);
        assert.deepEqual(preset.layer.mask.strokes, []);
        assert.deepEqual(preset.layer.strokes, []);
        assert.equal(preset.tool, 'airbrush');
    }
});

test('new global presets use restrained tone and soft-light layers only', () => {
    const ids = ['natural', 'clear', 'rich', 'warm-tone', 'warm-color', 'cool-tone', 'cool-color'];
    const expected = [
        ['natural', {contrast: 2, vibrance: 8}],
        ['clear', {contrast: 4, vibrance: 12, highlights: -3}],
        ['rich', {contrast: 7, vibrance: 12, shadows: -2}]
    ];
    for (const [id, params] of expected) {
        const preset = state.createPreset(id, () => ids.shift());
        assert.equal(preset.layers.length, 1);
        assert.equal(preset.layer.type, 'tone');
        for (const [key, value] of Object.entries(params)) assert.equal(preset.layer.params[key], value);
        assert.equal(preset.tool, 'hand');
    }
    const warm = state.createPreset('warm-look', () => ids.shift());
    const cool = state.createPreset('cool-look', () => ids.shift());
    for (const [preset, color, opacity, contrast, vibrance, firstId, secondId, label] of [
        [warm, '#edb18b', 0.035, 3, 8, 'warm-tone', 'warm-color', '따뜻한 색감'],
        [cool, '#9eadd4', 0.03, 3, 6, 'cool-tone', 'cool-color', '차분한 색감']
    ]) {
        assert.equal(preset.layers.length, 2);
        assert.strictEqual(preset.layer, preset.layers[0]);
        assert.deepEqual(preset.layers.map(layer => layer.type), ['tone', 'color']);
        assert.deepEqual(preset.layers.map(layer => layer.id), [firstId, secondId]);
        assert.deepEqual(preset.layers.map(layer => layer.name), [`${label} · 명암`, `${label} · 색감`]);
        assert.equal(preset.layers[0].params.contrast, contrast);
        assert.equal(preset.layers[0].params.vibrance, vibrance);
        assert.deepEqual(preset.layers[1].params, {color, mode: 'soft-light'});
        assert.equal(preset.layers[1].opacity, opacity);
    }
    assert.ok(state.PRESETS.filter(preset => preset.scope === 'global').every(preset => {
        const layers = state.createPreset(preset.id).layers;
        return layers.every(layer => layer.type !== 'blur' && layer.type !== 'line'
            && !(layer.type === 'color' && layer.params.mode === 'normal'));
    }));
});

test('preset strength accepts only the three supported values and scales the intended controls', () => {
    const naturalHalf = state.createPreset('natural', () => 'natural-half', 0.5);
    const naturalOneAndHalf = state.createPreset('natural', () => 'natural-one-half', 1.5);
    assert.equal(naturalHalf.layer.params.contrast, 1);
    assert.equal(naturalHalf.layer.params.vibrance, 4);
    assert.equal(naturalOneAndHalf.layer.params.contrast, 3);
    assert.equal(naturalOneAndHalf.layer.params.vibrance, 12);
    const clearHalf = state.createPreset('clear', () => 'clear-half', 0.5);
    assert.equal(clearHalf.layer.params.highlights, -1);

    const localHalf = state.createPreset('coral', () => 'local-half', 0.5);
    const localOneAndHalf = state.createPreset('coral', () => 'local-one-half', 1.5);
    assert.equal(localHalf.brush.flow, 2);
    assert.equal(localOneAndHalf.brush.flow, 5);
    assert.equal(localHalf.layer.opacity, 1);
    assert.equal(localOneAndHalf.layer.opacity, 1);

    const warmHalf = state.createPreset('warm-look', (() => { let id = 0; return () => `warm-half-${++id}`; })(), 0.5);
    const warmOneAndHalf = state.createPreset('warm-look', (() => { let id = 0; return () => `warm-one-half-${++id}`; })(), 1.5);
    assert.equal(warmHalf.layers[0].params.contrast, 2);
    assert.ok(Math.abs(warmHalf.layers[1].opacity - 0.0175) < Number.EPSILON);
    assert.ok(Math.abs(warmOneAndHalf.layers[1].opacity - 0.0525) < Number.EPSILON);

    const defaults = state.createPreset('natural', () => 'default');
    for (const invalid of [undefined, 0, 0.25, 2, '0.5', null]) {
        const result = state.createPreset('natural', () => `invalid-${String(invalid)}`, invalid);
        assert.deepEqual(result.layer.params, defaults.layer.params);
    }
});

test('multi-layer presets create unique fresh layers and normalize as ordinary v1 layers', () => {
    let id = 0;
    const makeId = () => `multi-${++id}`;
    for (const presetId of ['warm-look', 'cool-look']) {
        const first = state.createPreset(presetId, makeId);
        const second = state.createPreset(presetId, makeId);
        assert.equal(new Set(first.layers.map(layer => layer.id)).size, 2);
        assert.notEqual(first.layers[0].id, first.layers[1].id);
        for (let index = 0; index < 2; index += 1) {
            assert.notStrictEqual(first.layers[index], second.layers[index]);
            assert.notStrictEqual(first.layers[index].params, second.layers[index].params);
            assert.notStrictEqual(first.layers[index].mask, second.layers[index].mask);
            assert.notEqual(first.layers[index].id, second.layers[index].id);
        }
        if (presetId === 'cool-look') {
            first.layers[1].params.color = '#000000';
            assert.equal(second.layers[1].params.color, '#9eadd4');
            const normalized = state.normalize(documentWith(first.layers));
            assert.equal(normalized.version, 1);
            assert.deepEqual(normalized.layers.map(layer => [layer.id, layer.type]), first.layers.map(layer => [layer.id, layer.type]));
            assert.equal(normalized.layers[1].opacity, 0.03);
            assert.equal(normalized.layers[1].params.color, '#000000');
        }
    }
    assert.equal(state.createPreset('unknown'), null);
});

test('normalize rejects invalid documents and keeps only valid source references and dimensions', () => {
    const base = documentWith();
    for (const source of ['https://example.invalid/image.png', '//example.invalid/image.png', 'javascript:alert(1)', 'data:text/html,not-image']) {
        assert.equal(state.normalize({...base, source}), null);
    }
    for (const dims of [[0, 10], [10, -1], [100001, 1], [40000, 4001], [1.5, 2], [NaN, 2], [Infinity, 2]]) {
        assert.equal(state.normalize({...base, width: dims[0], height: dims[1]}), null);
    }
    assert.equal(state.normalize({...base, source: 'data:image/png;base64,c3ludGhldGlj'}).source, 'data:image/png;base64,c3ludGhldGlj');
});

test('normalize filters invalid records, bounds supported values, and isolates cloned state', () => {
    const input = documentWith([
        {
            id: 'layer-1', type: 'color', name: '색 레이어', opacity: NaN, visible: false,
            params: {color: '#AABBCC', mode: 'bogus', ignored: 'drop'},
            strokes: [
                {points: [[1, 2], [3, 4]], radius: 900, hardness: 1.2, opacity: -1, color: '#ABCDEF', mode: 'color', source: [5, 6], strength: 0},
                {points: [[NaN, 4]], radius: 5}
            ],
            mask: {
                base: 0,
                shape: {kind: 'rect', box: [1, 2, 8, 9]},
                strokes: [{points: [[7, 8]], erase: true, color: 'bad'}]
            },
            unknown: {drop: true}
        },
        {id: 'layer-1', type: 'tone', params: {brightness: 1000}},
        {id: 23, type: 'tone'},
        {id: 'layer-4', type: 'not-a-kind'},
        {id: 'layer-5', type: 'tone', params: {brightness: -500, contrast: Infinity, saturation: 12, shadows: -12, highlights: 12}}
    ]);
    input.print = {widthCm: -1, heightCm: 900, safeMm: NaN, custom: 'discard'};
    input.notes = 'x'.repeat(10003);
    input.checks = [3, 3, -1, 7, 8, '1', 0];
    const before = structuredClone(input);
    const result = state.normalize(input);
    assert.equal(JSON.stringify(input), JSON.stringify(before));
    assert.equal(result.layers.length, 2);
    assert.deepEqual(result.layers[0], {
        id: 'layer-1', type: 'color', name: '색 레이어', params: {color: '#aabbcc', mode: 'soft-light'},
        opacity: 0.07, visible: false,
        mask: {
            base: 0,
            strokes: [{points: [[7, 8]], radius: 80, hardness: 0.3, opacity: 0.1, color: '#e6baa4', mode: 'push', strength: 0.35, erase: true}],
            shape: {kind: 'rect', box: [1, 2, 8, 9]}
        },
        strokes: [{points: [[1, 2], [3, 4]], radius: 800, hardness: 1, opacity: 0, color: '#abcdef', mode: 'color', strength: 0.01, source: [5, 6]}]
    });
    assert.deepEqual(result.layers[1].params, {brightness: -40, contrast: 0, saturation: 12, vibrance: 0, shadows: -12, highlights: 12});
    assert.deepEqual(result.print, {widthCm: 1, heightCm: 400, safeMm: 5});
    assert.deepEqual(result.checks, [3, 7, 0]);
    assert.equal(result.notes.length, 10000);
    result.layers[0].mask.shape.box[0] = 50;
    result.layers[0].strokes[0].points[0][0] = 99;
    assert.deepEqual(input.layers[0].mask.shape.box, [1, 2, 8, 9]);
    assert.deepEqual(input.layers[0].strokes[0].points[0], [1, 2]);
});

test('airbrush stroke metadata is bounded while legacy strokes keep their original shape', () => {
    const result = state.normalize(documentWith([{
        id: 'paint', type: 'paint', strokes: [
            {points: [[1, 2]], brush: 'airbrush', flow: 1.5, opacity: 0.75, mode: 'multiply'},
            {points: [[2, 3]], brush: 'airbrush', flow: -1},
            {points: [[3, 4]], brush: 'airbrush', flow: Infinity},
            {points: [[4, 5]], brush: 'unknown', flow: 0.5}
        ]
    }]));
    const strokes = result.layers[0].strokes;
    assert.equal(strokes[0].brush, 'airbrush');
    assert.equal(strokes[0].flow, 1);
    assert.equal(strokes[0].opacity, 0.75);
    assert.equal(strokes[0].mode, 'multiply');
    assert.equal(strokes[1].flow, 0);
    assert.equal(strokes[2].flow, 0.04);
    assert.equal(Object.hasOwn(strokes[3], 'brush'), false);
    assert.equal(Object.hasOwn(strokes[3], 'flow'), false);
});

test('normalize applies layer and point limits without failing on oversized state', () => {
    const layers = Array.from({length: 45}, (_, index) => ({id: `layer-${index}`, type: 'tone'}));
    const result = state.normalize(documentWith(layers));
    assert.equal(result.layers.length, state.LIMITS.maxLayers);
    const overLimit = Array.from({length: state.LIMITS.maxPoints + 1}, (_, index) => [index, 0]);
    const bounded = state.normalize(documentWith([{id: 'many-points', type: 'paint', strokes: [{points: overLimit}]}]));
    assert.equal(bounded.layers[0].strokes.length, 0);
});

test('copySettings gives a new id and retains settings and mask base while clearing drawn coordinates', () => {
    const original = state.createLayer('tone', () => 'old-id');
    original.name = '맞춤 톤';
    original.params.brightness = 8;
    original.mask = {base: 0, shape: {kind: 'ellipse', box: [1, 2, 8, 9]}, strokes: [{points: [[4, 5]]}]};
    original.strokes = [{points: [[2, 3]], source: [7, 8]}];
    const copy = state.copySettings(original, () => 'new-id');
    assert.equal(copy.id, 'new-id');
    assert.equal(copy.name, '맞춤 톤');
    assert.equal(copy.params.brightness, 8);
    assert.deepEqual(copy.mask, {base: 0, strokes: []});
    assert.deepEqual(copy.strokes, []);
    assert.equal(state.copySettings(state.createLayer('paint', () => 'paint-id')), null);
    assert.equal(state.copySettings(state.createLayer('clone', () => 'clone-id')), null);
    assert.equal(state.copySettings(state.createLayer('liquify', () => 'liquify-id')), null);
});

test('history clones snapshots, keeps at most 50 entries, and clears redo on new work', () => {
    const history = new state.History();
    const initial = documentWith();
    assert.equal(history.canUndo, false);
    assert.equal(history.canRedo, false);
    assert.equal(history.undo(initial), null);
    assert.equal(history.redo(initial), null);
    history.push(initial);
    initial.notes = 'changed after push';
    assert.equal(history.canUndo, true);
    const changed = documentWith();
    changed.notes = 'changed';
    const undone = history.undo(changed);
    assert.equal(undone.notes, '');
    assert.equal(history.canRedo, true);
    undone.notes = 'mutated returned clone';
    assert.equal(history.redo(initial).notes, 'changed');
    assert.equal(history.canRedo, false);
    history.undo(changed);
    history.push(documentWith());
    assert.equal(history.canRedo, false);

    const bounded = new state.History();
    for (let index = 0; index < 60; index += 1) bounded.push({index});
    assert.equal(bounded._undo.length, state.LIMITS.history);
    let current = {index: 60};
    for (let index = 0; index < state.LIMITS.history; index += 1) current = bounded.undo(current);
    assert.equal(bounded.canUndo, false);
});
