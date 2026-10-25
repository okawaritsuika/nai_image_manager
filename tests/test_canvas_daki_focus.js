'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const Regions = require('../static/canvas_daki_regions.js');
const PromptRules = require('../static/canvas_daki_prompt_rules.js');
const focusSource = require('node:fs').readFileSync(require.resolve('../static/canvas_daki_focus.js'), 'utf8');

function record(token, tag, regions = [], sections = []) {
    return { token, tag, regions, sections };
}

function responseFor(tokens, catalog) {
    return {
        ok: true,
        json: async () => ({
            status: 'success',
            items: tokens.map((token) => catalog[token] || record(token, null)),
        }),
    };
}

function createHarness({ linked = true, catalog = {}, styleLink = false } = {}) {
    const layers = new Map();
    const clipParents = new Map();
    let fetchCount = 0;
    let saveCount = 0;
    let styleGroupCalls = 0;
    let fetcher = (tokens) => Promise.resolve(responseFor(tokens, catalog));
    const document = { getElementById: () => null, addEventListener() {} };
    const sandbox = {
        console,
        document,
        CanvasDakiRegions: Regions,
        CanvasDakiPromptRules: PromptRules,
        CanvasProject: { localLink: () => linked ? { projectId: 'synthetic-project', canvasId: 'synthetic-canvas', side: 'front' } : null },
        canvasLayers: {},
        currentCanvasWidth: 1000,
        currentCanvasHeight: 1000,
        findCanvasLayer: (id) => layers.has(id) ? { layer: layers.get(id) } : null,
        findSelectionParentForLayerId: (id) => clipParents.get(id) || null,
        saveCanvasState: () => { saveCount += 1; },
        buildLegacyCharPromptText: (prompts) => prompts.join('\n'),
        parseClipPromptTokens: (text) => String(text || '').split(',').map((token) => token.trim()).filter(Boolean),
        queueMicrotask: () => {},
        setTimeout: () => 1,
        clearTimeout: () => {},
        fetch: (url, options) => {
            assert.equal(url, '/api/daki/tag-catalog/classify');
            assert.equal(options.method, 'POST');
            fetchCount += 1;
            const tokens = JSON.parse(options.body).tokens;
            return fetcher(tokens);
        },
    };
    sandbox.window = sandbox;
    if (styleLink) {
        sandbox.getCanvasStyleLink = () => ({
            groupParts(field, tokens) {
                assert.equal(field, 'base');
                styleGroupCalls += 1;
                const selectedStyleTokens = Array.isArray(styleLink) ? styleLink : ['style tag'];
                const styleTokens = tokens.filter((item) => selectedStyleTokens.includes(item.token)).map((item) => item.token);
                return styleTokens.length ? [{ type: 'style', tokens: styleTokens }] : [];
            },
        });
    }
    const context = vm.createContext(sandbox);
    vm.runInContext(focusSource, context, { filename: 'canvas_daki_focus.js' });
    const focus = context.CanvasDakiFocus;

    return {
        context,
        focus,
        layers,
        clipParents,
        addSelection(id, dakiFocus = {}) {
            const layer = { id, type: 'selection', name: `Selection ${id}`, children: [], dakiFocus };
            layers.set(id, layer);
            return layer;
        },
        addClip(id, selection) {
            const clip = { id, type: 'clip' };
            clipParents.set(id, selection);
            return clip;
        },
        setFetcher(callback) { fetcher = callback; },
        fetchCount: () => fetchCount,
        saveCount: () => saveCount,
        styleGroupCalls: () => styleGroupCalls,
    };
}

function promptInfo(basePrompt, charPrompts = [], negativePrompt = 'red eyes') {
    return { basePrompt, charPrompts, negativePrompt };
}

test('unlinked prepare passes prompt info through without classifying', async () => {
    const h = createHarness({ linked: false });
    const info = promptInfo('blue eyes, shirt', ['long hair']);
    const result = await h.focus.prepare({ id: 'clip-1' }, info);
    assert.equal(result.promptInfo, info);
    assert.equal(result.folderRegion, null);
    assert.equal(h.fetchCount(), 0);
});

test('selection labels follow manual, automatic, and custom regions without changing saved state', () => {
    const h = createHarness();
    const selection = h.addSelection('selection-1', {mode: 'manual', regions: ['chest', 'arms']});
    const before = JSON.stringify(selection);
    assert.equal(h.focus.selectionLabel(selection), '가슴·어깨 / 팔');
    assert.equal(JSON.stringify(selection), before);

    selection.dakiFocus = {mode: 'auto'};
    Object.assign(selection, {x: 50, y: 490, layerWidth: 150, layerHeight: 150});
    assert.equal(h.focus.selectionLabel(selection), '손');

    h.focus.restore({customRegions: [{
        id: 'custom-test', label: '긴 부위 이름 <합성>', baseRegion: 'legs',
        prompt: '', color: '#22c55e'
    }]});
    selection.dakiFocus = {mode: 'manual', regions: ['custom-test']};
    assert.equal(h.focus.selectionLabel(selection), '긴 부위 이름 <합성>');
    assert.equal(h.saveCount(), 0);
    assert.equal(h.fetchCount(), 0);
});

test('selection labels retain the ordinary canvas description without a project link', () => {
    const h = createHarness({linked: false});
    assert.equal(h.focus.selectionLabel(h.addSelection('selection-1')), '선택 영역');
    assert.equal(h.focus.selectionLabel(null), '선택 영역');
});

test('manual chest focus filters body tags while preserving unknown, style, global, negative, and weighted prompt structure', async () => {
    const h = createHarness({ styleLink: true, catalog: {
        smile: record('smile', 'smile', ['face'], ['face.expression']),
        'chest mark': record('chest mark', 'chest_mark', ['chest']),
        'blue eyes': record('blue eyes', 'blue_eyes', ['face'], ['face.eyes']),
        'unknown tag': record('unknown tag', null),
        'style tag': record('style tag', 'style_face', ['face'], ['face.style']),
        'high quality': record('high quality', 'high_quality', ['whole']),
        hand: record('hand', 'hand', ['arms'], ['arms.hands']),
        'thigh strap': record('thigh strap', 'thigh_strap', ['legs']),
    } });
    const selection = h.addSelection('selection-1', { mode: 'manual', regions: ['chest'] });
    const clip = h.addClip('clip-1', selection);
    const info = promptInfo(
        '1.2::smile, chest mark::, blue eyes, unknown tag, style tag, high quality',
        ['blue eyes, chest mark', 'smile, hand, thigh strap, high quality'],
        'red eyes'
    );
    const original = structuredClone(info);

    const prepared = await h.focus.prepare(clip, info);
    assert.equal(prepared.folderRegion, 'chest');
    assert.deepEqual(Array.from(prepared.regions), ['chest']);
    assert.equal(prepared.addedPrompt, 'close-up of the torso and shoulders');
    assert.equal(prepared.promptInfo.basePrompt, '1.2::chest mark::, unknown tag, style tag, high quality, close-up of the torso and shoulders');
    assert.deepEqual(Array.from(prepared.promptInfo.charPrompts), ['chest mark', 'high quality']);
    assert.equal(prepared.promptInfo.negativePrompt, 'red eyes');
    assert.equal(PromptRules.inspect(prepared.promptInfo.basePrompt).valid, true);
    assert.equal(PromptRules.inspect(prepared.promptInfo.charPrompts[0]).valid, true);
    assert.deepEqual(info, original);
    assert.ok(h.styleGroupCalls() > 0);
});

test('manual multiple-body focus preserves tags belonging to either selected body region', async () => {
    const h = createHarness({ catalog: {
        'blue eyes': record('blue eyes', 'blue_eyes', ['face'], ['face.eyes']),
        'chest mark': record('chest mark', 'chest_mark', ['chest']),
        'thigh strap': record('thigh strap', 'thigh_strap', ['legs']),
    } });
    const selection = h.addSelection('selection-1', { mode: 'manual', regions: ['chest', 'face'] });
    const clip = h.addClip('clip-1', selection);
    const prepared = await h.focus.prepare(clip, promptInfo('blue eyes, chest mark, thigh strap'));
    assert.deepEqual(Array.from(prepared.regions), ['chest', 'face']);
    assert.equal(prepared.folderRegion, 'chest');
    assert.equal(prepared.promptInfo.basePrompt, 'blue eyes, chest mark, close-up of the torso and shoulders');
});

test('filterEnabled false skips classification and keeps all prompt fields', async () => {
    const h = createHarness();
    const existingGroups = [{ region: 'face', name: '얼굴', items: [{ field: 'base', token: 'blue eyes', key: 'blue eyes' }] }];
    const selection = h.addSelection('selection-1', {
        mode: 'manual', regions: ['chest'], filterEnabled: false, usePrompt: false, groups: existingGroups,
    });
    const clip = h.addClip('clip-1', selection);
    const prepared = await h.focus.prepare(clip, promptInfo('blue eyes, shirt', ['long hair']));
    assert.equal(h.fetchCount(), 0);
    assert.equal(prepared.promptInfo.basePrompt, 'blue eyes, shirt');
    assert.deepEqual(Array.from(prepared.promptInfo.charPrompts), ['long hair']);
    assert.equal(selection.dakiFocus.groups, existingGroups);
});

test('enabledGroups and keepKeys restore only the requested group and field on one selection', async () => {
    const h = createHarness({ catalog: {
        shirt: record('shirt', 'shirt', ['chest'], ['chest.clothes']),
        'blue eyes': record('blue eyes', 'blue_eyes', ['face'], ['face.eyes']),
        sleeve: record('sleeve', 'sleeve', ['arms'], ['arms.clothes']),
    } });
    const first = h.addSelection('selection-1', { mode: 'manual', regions: ['chest'], usePrompt: false });
    const second = h.addSelection('selection-2', { mode: 'manual', regions: ['chest'], usePrompt: false });
    const firstClip = h.addClip('clip-1', first);
    const secondClip = h.addClip('clip-2', second);
    const info = promptInfo('shirt, blue eyes, sleeve', ['blue eyes, sleeve', 'blue eyes, sleeve']);

    await h.focus.prepare(firstClip, info);
    await h.focus.prepare(secondClip, info);
    first.dakiFocus.enabledGroups.face = true;
    first.dakiFocus.keepKeys = ['char-0\u0000sleeve'];

    const restored = await h.focus.prepare(firstClip, info);
    const untouched = await h.focus.prepare(secondClip, info);
    assert.equal(restored.promptInfo.basePrompt, 'shirt, blue eyes');
    assert.deepEqual(Array.from(restored.promptInfo.charPrompts), ['blue eyes, sleeve', 'blue eyes']);
    assert.equal(untouched.promptInfo.basePrompt, 'shirt');
    assert.deepEqual(Array.from(untouched.promptInfo.charPrompts), ['', '']);
    assert.equal(first.dakiFocus.enabledGroups.face, true);
    assert.equal(second.dakiFocus.enabledGroups.face, undefined);
});

test('deferred classification rejects stale selections, restored maps, and revision changes', async () => {
    const scenarios = ['removed-selection', 'restore', 'revision'];
    for (const scenario of scenarios) {
        const h = createHarness({ catalog: { 'blue eyes': record('blue eyes', 'blue_eyes', ['face'], ['face.eyes']) } });
        const selection = h.addSelection('selection-1', { mode: 'manual', regions: ['chest'] });
        const clip = h.addClip('clip-1', selection);
        let release;
        h.setFetcher((tokens) => new Promise((resolve) => {
            release = () => resolve(responseFor(tokens, { 'blue eyes': record('blue eyes', 'blue_eyes', ['face'], ['face.eyes']) }));
        }));

        const pending = h.focus.prepare(clip, promptInfo('blue eyes, shirt'));
        assert.equal(typeof release, 'function');
        if (scenario === 'removed-selection') h.layers.delete(selection.id);
        if (scenario === 'restore') h.focus.restore(Regions.defaultMap());
        if (scenario === 'revision') h.focus.selectionChanged(selection);
        release();
        await assert.rejects(pending, /부위 설정 또는 캔버스가 바뀌었습니다/);
    }
});

test('snapshot and restore clone the editable front/back map', () => {
    const h = createHarness();
    const source = Regions.defaultMap();
    source.front.chest[0].x = 0.31;
    h.focus.restore(source);
    source.front.chest[0].x = 0.81;

    const snapshot = h.focus.snapshot();
    assert.equal(snapshot.front.chest[0].x, 0.31);
    snapshot.front.chest[0].x = 0.39;
    assert.equal(h.focus.snapshot().front.chest[0].x, 0.31);
    assert.deepEqual(Regions.defaultMap().back.back, snapshot.back.back);

    h.focus.restore(snapshot);
    assert.equal(h.focus.snapshot().front.chest[0].x, 0.39);
    snapshot.back.back[0].x = 0.1;
    assert.notEqual(h.focus.snapshot().back.back[0].x, 0.1);
});

test('resultFolder uses the region captured by prepare after the selection changes', async () => {
    const h = createHarness();
    const selection = h.addSelection('selection-1', { mode: 'manual', regions: ['chest'] });
    const clip = h.addClip('clip-1', selection);
    const prepared = await h.focus.prepare(clip, promptInfo('shirt'));
    selection.dakiFocus.mode = 'manual';
    selection.dakiFocus.regions = ['feet'];

    let idCount = 0;
    const folder = h.focus.resultFolder(selection, prepared, () => `folder-${++idCount}`);
    assert.equal(prepared.folderRegion, 'chest');
    assert.equal(folder.dakiRegion, 'chest');
    assert.equal(folder.name, '가슴·어깨');
    assert.equal(idCount, 1);
});





test('weighted style scopes protect every selected face leaf while excluding other face tags', async () => {
    const h = createHarness({ styleLink: ['1.2::smile', 'blue eyes::'], catalog: {
        smile: record('smile', 'smile', ['face'], ['face.expression']),
        'blue eyes': record('blue eyes', 'blue_eyes', ['face'], ['face.eyes']),
        'green eyes': record('green eyes', 'green_eyes', ['face'], ['face.eyes']),
        shirt: record('shirt', 'shirt', ['chest'], ['chest.clothes']),
    } });
    const selection = h.addSelection('selection-1', { mode: 'manual', regions: ['chest'], usePrompt: false });
    const clip = h.addClip('clip-1', selection);
    const info = promptInfo('1.2::smile, blue eyes::, green eyes, shirt');

    const prepared = await h.focus.prepare(clip, info);
    assert.equal(prepared.promptInfo.basePrompt, '1.2::smile, blue eyes::, shirt');
    assert.equal(PromptRules.inspect(prepared.promptInfo.basePrompt).valid, true);
    assert.ok(h.styleGroupCalls() > 0);
});

test('an incomplete selected style scope conservatively protects the full base field', async () => {
    const h = createHarness({ styleLink: ['1.2::smile'], catalog: {
        smile: record('smile', 'smile', ['face'], ['face.expression']),
        'blue eyes': record('blue eyes', 'blue_eyes', ['face'], ['face.eyes']),
        'green eyes': record('green eyes', 'green_eyes', ['face'], ['face.eyes']),
        shirt: record('shirt', 'shirt', ['chest'], ['chest.clothes']),
    } });
    const selection = h.addSelection('selection-1', { mode: 'manual', regions: ['chest'], usePrompt: false });
    const clip = h.addClip('clip-1', selection);
    const info = promptInfo('1.2::smile, blue eyes::, green eyes, shirt');

    const prepared = await h.focus.prepare(clip, info);
    assert.equal(prepared.promptInfo.basePrompt, info.basePrompt);
    assert.equal(PromptRules.inspect(prepared.promptInfo.basePrompt).valid, true);
});

test('whole focus leaves prompts unchanged and never calls a failing classifier', async () => {
    const h = createHarness();
    h.setFetcher(() => { throw new Error('classifier should be skipped for whole focus'); });
    const selection = h.addSelection('selection-1', {
        mode: 'manual', regions: ['whole'], usePrompt: false,
    });
    const clip = h.addClip('clip-1', selection);
    const info = promptInfo('blue eyes, shirt', ['long hair'], 'red eyes');

    const prepared = await h.focus.prepare(clip, info);
    assert.equal(h.fetchCount(), 0);
    assert.equal(prepared.folderRegion, 'whole');
    assert.equal(prepared.promptInfo.basePrompt, info.basePrompt);
    assert.deepEqual(Array.from(prepared.promptInfo.charPrompts), ['long hair']);
    assert.equal(prepared.promptInfo.negativePrompt, 'red eyes');
});

test('classification rejection fails prepare, while disabling filtering bypasses the failed classifier', async () => {
    const h = createHarness();
    h.setFetcher(() => Promise.reject(new Error('synthetic classifier failure')));
    const selection = h.addSelection('selection-1', {
        mode: 'manual', regions: ['chest'], usePrompt: false,
    });
    const clip = h.addClip('clip-1', selection);
    const info = promptInfo('blue eyes, shirt');

    await assert.rejects(h.focus.prepare(clip, info), /synthetic classifier failure/);
    assert.equal(h.fetchCount(), 1);
    selection.dakiFocus.filterEnabled = false;
    const prepared = await h.focus.prepare(clip, info);
    assert.equal(h.fetchCount(), 1);
    assert.equal(prepared.promptInfo.basePrompt, info.basePrompt);
});

test('resultFolder falls back to current focus only when prepared is omitted', () => {
    const h = createHarness();
    const selection = h.addSelection('selection-1', { mode: 'manual', regions: ['feet'] });
    let idCount = 0;
    const makeId = () => `fallback-${++idCount}`;

    const fallback = h.focus.resultFolder(selection, undefined, makeId);
    assert.equal(fallback.dakiRegion, 'feet');
    assert.equal(fallback.name, '발');
    assert.equal(idCount, 1);

    const explicitNull = h.focus.resultFolder(selection, { folderRegion: null }, makeId);
    assert.equal(explicitNull, null);
    assert.equal(selection.children.length, 1);
    assert.equal(idCount, 1);
});

test('custom focus maps to its built-in classification region and snapshots its folder definition', async () => {
    const h = createHarness({styleLink: true, catalog: {
        'thigh strap': record('thigh strap', 'thigh_strap', ['legs'], ['legs.clothing']),
        'blue eyes': record('blue eyes', 'blue_eyes', ['face'], ['face.eyes']),
        'style tag': record('style tag', 'style_face', ['face'], ['face.style']),
    }});
    const added = Regions.addCustomRegion(Regions.defaultMap(), {
        label: '허벅지', baseRegion: 'legs', prompt: 'close-up of the thighs',
    }, 'custom-thigh');
    h.focus.restore(added.map);
    const selection = h.addSelection('selection-1', {mode: 'manual', regions: ['custom-thigh']});
    const clip = h.addClip('clip-1', selection);
    const info = promptInfo(
        'thigh strap, blue eyes, unknown tag, style tag',
        ['thigh strap, blue eyes'],
        'red eyes'
    );

    const prepared = await h.focus.prepare(clip, info);
    assert.equal(h.fetchCount(), 1);
    assert.equal(prepared.folderRegion, 'custom-thigh');
    assert.equal(prepared.folderDefinition.id, 'custom-thigh');
    assert.equal(prepared.folderDefinition.label, '허벅지');
    assert.equal(prepared.folderDefinition.baseRegion, 'legs');
    assert.equal(prepared.folderDefinition.prompt, 'close-up of the thighs');
    assert.equal(prepared.promptInfo.basePrompt, 'thigh strap, unknown tag, style tag, close-up of the thighs');
    assert.deepEqual(Array.from(prepared.promptInfo.charPrompts), ['thigh strap']);
    assert.equal(prepared.promptInfo.negativePrompt, 'red eyes');
    assert.ok(h.styleGroupCalls() > 0);

    const legacyFolder = {id: 'legacy-thigh', name: '허벅지', type: 'folder', children: []};
    selection.children.push(legacyFolder);
    h.focus.restore(null);
    let idCount = 0;
    const folder = h.focus.resultFolder(selection, prepared, () => `folder-${++idCount}`);
    assert.equal(folder, legacyFolder);
    assert.equal(folder.dakiRegion, 'custom-thigh');
    assert.equal(folder.name, '허벅지');
    assert.equal(idCount, 0);
});

test('a custom whole-base focus keeps prompt tokens and skips classification', async () => {
    const h = createHarness();
    h.setFetcher(() => { throw new Error('whole-base custom focus must skip classification'); });
    const added = Regions.addCustomRegion(Regions.defaultMap(), {
        label: '전신 포커스', baseRegion: 'whole', prompt: 'full body portrait',
    }, 'custom-whole');
    h.focus.restore(added.map);
    const selection = h.addSelection('selection-1', {mode: 'manual', regions: ['custom-whole']});
    const clip = h.addClip('clip-1', selection);
    const info = promptInfo('blue eyes, shirt', ['long hair'], 'red eyes');

    const prepared = await h.focus.prepare(clip, info);
    assert.equal(h.fetchCount(), 0);
    assert.equal(prepared.folderRegion, 'custom-whole');
    assert.equal(prepared.folderDefinition.baseRegion, 'whole');
    assert.equal(prepared.promptInfo.basePrompt, 'blue eyes, shirt, full body portrait');
    assert.deepEqual(Array.from(prepared.promptInfo.charPrompts), ['long hair']);
    assert.equal(prepared.promptInfo.negativePrompt, 'red eyes');
});

