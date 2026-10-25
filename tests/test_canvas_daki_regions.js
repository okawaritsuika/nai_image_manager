'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Regions = require('../static/canvas_daki_regions.js');

function box(x, y, width, height) {
    return { x, y, width, height };
}

function selection(rect, scale = 1000) {
    return { x: rect.x * scale, y: rect.y * scale, layerWidth: rect.width * scale, layerHeight: rect.height * scale };
}

test('the browser bundle exposes CanvasDakiRegions without needing a DOM', () => {
    const source = fs.readFileSync(require.resolve('../static/canvas_daki_regions.js'), 'utf8');
    const context = {};
    vm.runInNewContext(source, context);
    assert.equal(typeof context.CanvasDakiRegions.defaultMap, 'function');
    assert.equal(context.CanvasDakiRegions.REGIONS.length, 11);
});
test('defaultMap returns independent front and back defaults with the old body rectangles', () => {
    const first = Regions.defaultMap();
    const second = Regions.defaultMap();
    assert.equal(first.version, 1);
    assert.deepEqual(first.front.hair, [box(0.12, 0.02, 0.76, 0.30)]);
    assert.deepEqual(first.front.face, [box(0.28, 0.04, 0.44, 0.18)]);
    assert.deepEqual(first.front.chest, [box(0.22, 0.22, 0.56, 0.21)]);
    assert.deepEqual(first.front.arms, [box(0.03, 0.20, 0.27, 0.42), box(0.70, 0.20, 0.27, 0.42)]);
    assert.deepEqual(first.front.hands, [box(0.05, 0.48, 0.25, 0.19), box(0.70, 0.48, 0.25, 0.19)]);
    assert.deepEqual(first.front.abdomen, [box(0.27, 0.40, 0.46, 0.19)]);
    assert.deepEqual(first.front.pelvis, [box(0.20, 0.55, 0.60, 0.17)]);
    assert.deepEqual(first.front.legs, [box(0.18, 0.65, 0.64, 0.27)]);
    assert.deepEqual(first.front.feet, [box(0.15, 0.88, 0.70, 0.11)]);
    assert.deepEqual(first.front.back, []);
    assert.deepEqual(first.back.chest, []);
    assert.deepEqual(first.back.face, []);
    assert.deepEqual(first.back.back, [box(0.22, 0.22, 0.56, 0.21)]);
    assert.notEqual(first.front, first.back);
    first.front.hair[0].x = 0.5;
    assert.equal(second.front.hair[0].x, 0.12);
});

test('normalizeMap keeps valid edits and empty regions, clamps boxes, and falls back per malformed field', () => {
    const input = {
        version: 50,
        front: {
            hair: [box(0.98, -0.1, 0.5, 0.2)],
            face: [],
            chest: [box(0.1, 0.2, 0.3, 0.4), { x: 1, y: 2 }],
            arms: Array.from({ length: 10 }, (_, i) => box(i / 10, 0.3, 0.1, 0.1)),
            hands: 'bad',
            abdomen: [box(Number.NaN, 0, 0.2, 0.2)],
        },
    };
    const snapshot = JSON.stringify(input);
    const normalized = Regions.normalizeMap(input);
    assert.equal(normalized.version, 1);
    assert.deepEqual(normalized.front.hair, [box(0.5, 0, 0.5, 0.2)]);
    assert.deepEqual(normalized.front.face, []);
    assert.deepEqual(normalized.front.chest, [box(0.1, 0.2, 0.3, 0.4)]);
    assert.equal(normalized.front.arms.length, 8);
    assert.deepEqual(normalized.front.hands, Regions.defaultMap().front.hands);
    assert.deepEqual(normalized.front.abdomen, Regions.defaultMap().front.abdomen);
    assert.deepEqual(normalized.back, Regions.defaultMap().back);
    assert.equal(JSON.stringify(input), snapshot);

    const tiny = Regions.normalizeMap({ front: { feet: [box(-2, 5, 0, 0)] } });
    assert.deepEqual(tiny.front.feet, [box(0, 0.995, 0.005, 0.005)]);
});

test('detect chooses the closest region, adds substantially covered overlaps, and uses the back map', () => {
    const map = Regions.defaultMap();
    assert.deepEqual(Regions.detect(selection(box(0.28, 0.04, 0.44, 0.18)), 1000, 1000, map.front), {
        primary: 'face', regions: ['face'],
    });
    assert.deepEqual(Regions.detect(selection(box(0.12, 0.02, 0.76, 0.30)), 1000, 1000, map.front), {
        primary: 'hair', regions: ['hair', 'face'],
    });
    assert.deepEqual(Regions.detect(selection(box(0.22, 0.22, 0.56, 0.21)), 1000, 1000, map.front), {
        primary: 'chest', regions: ['chest'],
    });
    assert.deepEqual(Regions.detect(selection(box(0.22, 0.22, 0.56, 0.21)), 1000, 1000, map.back), {
        primary: 'back', regions: ['back'],
    });
});

test('detect unions arm rectangles, is scale invariant, and returns whole for non-overlap or invalid geometry', () => {
    const front = Regions.defaultMap().front;
    const bothArms = { x: 30, y: 200, layerWidth: 940, layerHeight: 420 };
    assert.deepEqual(Regions.detect(bothArms, 1000, 1000, front), { primary: 'arms', regions: ['arms', 'chest', 'hands', 'abdomen'] });

    const normalized = box(0.70, 0.48, 0.25, 0.19);
    const small = Regions.detect(selection(normalized, 100), 100, 100, front);
    const large = Regions.detect(selection(normalized, 4000), 4000, 4000, front);
    assert.deepEqual(small, { primary: 'hands', regions: ['hands'] });
    assert.deepEqual(large, small);

    assert.deepEqual(Regions.detect({ x: 950, y: 950, layerWidth: 20, layerHeight: 20 }, 1000, 1000, front), {
        primary: 'whole', regions: ['whole'],
    });
    assert.deepEqual(Regions.detect({ x: 0, y: 0, layerWidth: 900, layerHeight: 900 }, 1000, 1000, front), {
        primary: 'whole', regions: ['whole'],
    });
    assert.deepEqual(Regions.detect({ x: 0, y: 0, layerWidth: 0, layerHeight: 20 }, 1000, 1000, front), {
        primary: 'whole', regions: ['whole'],
    });
    assert.deepEqual(Regions.detect({ x: 0, y: 0, layerWidth: 20, layerHeight: 20 }, 1000, 1000, {}), {
        primary: 'whole', regions: ['whole'],
    });
});

test('resolve honors valid manual choices and safely detects from normalized side defaults', () => {
    const manualSelection = {
        ...selection(box(0.28, 0.04, 0.44, 0.18)),
        dakiFocus: { mode: 'manual', regions: ['hands', 'arms', 'hands', 'unknown'] },
    };
    assert.deepEqual(Regions.resolve(manualSelection, 1000, 1000, null, 'front'), {
        primary: 'hands', regions: ['hands', 'arms'],
    });
    assert.deepEqual(Regions.resolve({ dakiFocus: { mode: 'manual', regions: ['face', 'whole', 'arms'] } }, 0, 0, null), {
        primary: 'whole', regions: ['whole'],
    });

    const editedMap = { front: { face: [], chest: [box(0.1, 0.1, 0.2, 0.2)] }, back: { back: [box(0.1, 0.1, 0.2, 0.2)] } };
    const chestSelection = selection(box(0.1, 0.1, 0.2, 0.2));
    assert.deepEqual(Regions.resolve(chestSelection, 1000, 1000, editedMap, 'front'), {
        primary: 'chest', regions: ['chest'],
    });
    assert.deepEqual(Regions.resolve(chestSelection, 1000, 1000, editedMap, 'back'), {
        primary: 'back', regions: ['back'],
    });
    assert.deepEqual(Regions.resolve({ ...chestSelection, dakiFocus: { mode: 'manual', regions: ['bad'] } }, 1000, 1000, editedMap), {
        primary: 'chest', regions: ['chest'],
    });
});

test('ensureResultFolder reuses marked or legacy folders and preserves unrelated children', () => {
    let idCount = 0;
    const makeId = () => `generated-${++idCount}`;
    const renamed = { id: 'existing', name: 'My hair results', type: 'folder', expanded: false, children: [], dakiRegion: 'hair' };
    const legacy = { id: 'legacy', name: '인페인팅', type: 'folder', children: [] };
    const selectionLayer = { children: [legacy, renamed] };

    assert.equal(Regions.ensureResultFolder(selectionLayer, 'hair', makeId), renamed);
    assert.equal(renamed.expanded, true);
    assert.deepEqual(selectionLayer.children, [legacy, renamed]);
    assert.equal(idCount, 0);

    const chestLegacy = { id: 'chest-old', name: '가슴·어깨', type: 'folder', children: [] };
    selectionLayer.children.push(chestLegacy);
    assert.equal(Regions.ensureResultFolder(selectionLayer, 'chest', makeId), chestLegacy);
    assert.equal(chestLegacy.dakiRegion, 'chest');
    assert.equal(chestLegacy.expanded, true);
    assert.equal(idCount, 0);

    const created = Regions.ensureResultFolder(selectionLayer, 'feet', makeId);
    assert.deepEqual(created, {
        id: 'generated-1', name: '발', type: 'folder', visible: true, expanded: true, children: [], dakiRegion: 'feet',
    });
    assert.equal(selectionLayer.children[0], created);
    assert.equal(Regions.ensureResultFolder(selectionLayer, 'not-a-region', makeId).dakiRegion, 'whole');
    assert.equal(idCount, 2);

    const malformed = {};
    assert.deepEqual(Regions.ensureResultFolder(malformed, 'whole', makeId).children, []);
    assert.ok(Array.isArray(malformed.children));
});

test('legacy maps keep their exact v1 shape and unknown map keys are dropped', () => {
    const normalized = Regions.normalizeMap({
        version: 99,
        front: { hair: [], customOrphan: [box(0.1, 0.1, 0.2, 0.2)] },
        back: { back: [] },
        customRegions: [{ id: 'not-custom', label: 'invalid' }],
        other: true,
    });
    const expected = Regions.defaultMap();
    expected.front.hair = [];
    expected.back.back = [];
    assert.deepEqual(normalized, expected);
    assert.equal(Object.hasOwn(normalized, 'customRegions'), false);
    assert.equal(Object.hasOwn(normalized.front, 'customOrphan'), false);
});

test('custom definitions and front/back rectangles normalize independently without mutation', () => {
    const input = {
        version: 1,
        customRegions: [
            { id: 'custom-thighs', label: ' Thighs ', baseRegion: 'legs', prompt: 'upper legs', color: '#AABBCC' },
            { id: 'custom-extra', label: 'Extra', baseRegion: 'unknown', prompt: 4, color: 'blue' },
        ],
        front: {
            thighs: [box(0.1, 0.1, 0.2, 0.2)],
            'custom-thighs': [box(-0.1, 0.2, 0.4, 0.3), { x: 'bad' }],
            'custom-extra': [{ x: 2 }],
        },
        back: { 'custom-thighs': [box(0.3, 0.4, 0.2, 0.1)] },
    };
    const snapshot = JSON.stringify(input);
    const normalized = Regions.normalizeMap(input);
    assert.deepEqual(normalized.customRegions, [
        { id: 'custom-thighs', label: 'Thighs', baseRegion: 'legs', prompt: 'upper legs', color: '#AABBCC' },
        { id: 'custom-extra', label: 'Extra', baseRegion: 'whole', prompt: '', color: '#22c55e' },
    ]);
    assert.deepEqual(normalized.front['custom-thighs'], [box(0, 0.2, 0.4, 0.3)]);
    assert.deepEqual(normalized.back['custom-thighs'], [box(0.3, 0.4, 0.2, 0.1)]);
    assert.deepEqual(normalized.front['custom-extra'], []);
    assert.deepEqual(normalized.back['custom-extra'], []);
    assert.equal(Object.hasOwn(normalized.front, 'thighs'), false);
    assert.equal(JSON.stringify(input), snapshot);

    const regions = Regions.listRegions(normalized);
    assert.equal(regions.length, Regions.REGIONS.length + 2);
    assert.equal(regions.at(-2).custom, true);
    assert.equal(regions.at(-1).custom, true);
    assert.equal(Object.hasOwn(Regions.REGIONS[0], 'custom'), false);
});

test('custom normalization keeps the first valid ID and ignores invalid or special map keys', () => {
    const input = JSON.parse('{"customRegions":[{"id":"custom-thighs","label":"First"},{"id":"custom-thighs","label":"Second"},{"id":"legs","label":"Builtin override"},{"id":"__proto__","label":"Prototype"},{"id":"custom-bad","label":"   "},{"id":"custom-safe","label":"Safe"}],"front":{"__proto__":[{"x":0,"y":0,"width":1,"height":1}],"constructor":[{"x":0,"y":0,"width":1,"height":1}],"custom-thighs":[{"x":0.1,"y":0.2,"width":0.3,"height":0.4}],"custom-safe":[]},"back":{}}');
    const normalized = Regions.normalizeMap(input);
    assert.deepEqual(normalized.customRegions.map((region) => [region.id, region.label]), [
        ['custom-thighs', 'First'], ['custom-safe', 'Safe'],
    ]);
    assert.deepEqual(normalized.front['custom-thighs'], [box(0.1, 0.2, 0.3, 0.4)]);
    assert.equal(Object.hasOwn(normalized.front, '__proto__'), false);
    assert.equal(Object.hasOwn(normalized.front, 'constructor'), false);
    assert.equal({}.polluted, undefined);
});

test('custom IDs participate in manual focus and detection alongside built-in overlaps', () => {
    const map = Regions.defaultMap();
    map.customRegions = [{
        id: 'custom-thighs', label: '허벅지', baseRegion: 'legs', prompt: 'thighs', color: '#22c55e',
    }];
    map.front['custom-thighs'] = [box(0.2, 0.7, 0.6, 0.12)];
    const picked = selection(box(0.2, 0.7, 0.6, 0.12));
    assert.deepEqual(Regions.resolve({ ...picked, dakiFocus: { mode: 'manual', regions: ['custom-thighs'] } }, 1000, 1000, map), {
        primary: 'custom-thighs', regions: ['custom-thighs'],
    });
    assert.deepEqual(Regions.resolve(picked, 1000, 1000, map), {
        primary: 'custom-thighs', regions: ['custom-thighs'],
    });
    assert.deepEqual(Regions.detect(picked, 1000, 1000, map.front, Regions.listRegions(map)), {
        primary: 'custom-thighs', regions: ['custom-thighs'],
    });
});

test('addCustomRegion validates inputs, returns a cloned map, and leaves the input unchanged on success or failure', () => {
    const map = Regions.defaultMap();
    map.customRegions = [{
        id: 'custom-existing', label: 'Tail', baseRegion: 'whole', prompt: '', color: '#22c55e',
    }];
    map.front['custom-existing'] = [box(0.2, 0.2, 0.2, 0.2)];
    const snapshot = JSON.stringify(map);
    const created = Regions.addCustomRegion(map, {
        label: '  Thighs  ', baseRegion: 'legs', prompt: 'close-up of thighs',
    }, () => 'custom-thighs');
    assert.deepEqual(created.region, {
        id: 'custom-thighs', label: 'Thighs', baseRegion: 'legs', prompt: 'close-up of thighs', color: '#22c55e',
    });
    assert.deepEqual(created.map.front['custom-thighs'], []);
    assert.deepEqual(created.map.back['custom-thighs'], []);
    assert.deepEqual(created.map.front['custom-existing'], [box(0.2, 0.2, 0.2, 0.2)]);
    assert.equal(JSON.stringify(map), snapshot);

    const invalidId = (id, label = 'New area') => () => Regions.addCustomRegion(map, { label }, id);
    assert.throws(() => Regions.addCustomRegion(map, { label: '   ' }, 'custom-empty'), /이름을 입력/);
    assert.throws(() => Regions.addCustomRegion(map, { label: 'a'.repeat(61) }, 'custom-long'), /60자 이내/);
    assert.throws(() => Regions.addCustomRegion(map, { label: ' 얼굴 ' }, 'custom-duplicate-name'), /이미 사용/);
    assert.throws(() => Regions.addCustomRegion(map, { label: 'New area', prompt: 'x'.repeat(2001) }, 'custom-too-long'), /2000자 이내/);
    assert.throws(invalidId('bad-id'), /ID가 올바르지/);
    assert.throws(invalidId('custom-existing'), /ID가 이미 존재/);

    const fullMap = {
        customRegions: Array.from({ length: 64 }, (_, index) => ({
            id: `custom-region-${index}`, label: `Region ${index}`,
        })),
    };
    assert.throws(() => Regions.addCustomRegion(fullMap, { label: 'One more' }, 'custom-over-limit'), /최대 64개/);
    assert.equal(JSON.stringify(map), snapshot);
});

test('addCustomRegion generates a valid ID when no ID factory is provided', () => {
    const created = Regions.addCustomRegion(Regions.defaultMap(), { label: 'New area' });
    assert.match(created.region.id, /^custom-[a-z0-9][a-z0-9_-]{0,79}$/);
});

test('ensureResultFolder resolves custom labels and reuses folders by custom ID', () => {
    const map = Regions.defaultMap();
    map.customRegions = [{
        id: 'custom-thighs', label: '허벅지', baseRegion: 'legs', prompt: '', color: '#22c55e',
    }];
    let idCount = 0;
    const makeId = () => `folder-${++idCount}`;
    const selectionLayer = { children: [] };
    const first = Regions.ensureResultFolder(selectionLayer, 'custom-thighs', makeId, map);
    assert.equal(first.name, '허벅지');
    assert.equal(first.dakiRegion, 'custom-thighs');

    const renamedMap = {
        ...map,
        customRegions: [{ ...map.customRegions[0], label: 'Upper legs' }],
    };
    assert.equal(Regions.ensureResultFolder(selectionLayer, 'custom-thighs', makeId, renamedMap), first);
    assert.equal(idCount, 1);
});
