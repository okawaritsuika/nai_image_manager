const test = require('node:test');
const assert = require('node:assert/strict');
const WorkspaceState = require('../static/canvas_workspace_state.js');

const WORKSPACE_ID = 'a'.repeat(32);
const PANE_ID = 'b'.repeat(32);
const SECOND_PANE_ID = 'c'.repeat(32);
const PROJECT_ID = 'd'.repeat(32);
const CANVAS_ID = 'e'.repeat(32);

test('context accepts only a complete, valid workspace and pane scope', () => {
    assert.deepEqual(WorkspaceState.context(''), {mode: 'single', workspaceId: null, paneId: null});
    assert.deepEqual(WorkspaceState.context('?workspace=bad'), {mode: 'single', workspaceId: null, paneId: null});
    assert.deepEqual(WorkspaceState.context(`?workspace=${WORKSPACE_ID}`), {
        mode: 'host', workspaceId: WORKSPACE_ID, paneId: null,
    });
    assert.deepEqual(WorkspaceState.context(`?workspace=${WORKSPACE_ID}&pane=${PANE_ID}`), {
        mode: 'pane', workspaceId: WORKSPACE_ID, paneId: PANE_ID,
    });
    for (const search of [
        `?workspace=${WORKSPACE_ID}&pane=`,
        `?workspace=${WORKSPACE_ID}&pane=${PANE_ID.toUpperCase()}`,
        `?workspace=${WORKSPACE_ID}&pane=${PANE_ID.slice(1)}`,
        `?workspace=bad&pane=${PANE_ID}`,
        `?pane=${PANE_ID}`,
    ]) {
        assert.deepEqual(WorkspaceState.context(search), {mode: 'single', workspaceId: null, paneId: null});
    }
});

test('storage keys are unique by validated workspace and pane IDs', () => {
    assert.equal(WorkspaceState.LEGACY_STATE_KEY, 'naia_canvas_state_v1');
    assert.equal(WorkspaceState.MANIFEST_PREFIX, 'naia_canvas_workspace_v1:');
    assert.equal(WorkspaceState.PANE_PREFIX, 'naia_canvas_pane_v1:');
    assert.equal(WorkspaceState.stateKey(WORKSPACE_ID, PANE_ID),
        `naia_canvas_pane_v1:${WORKSPACE_ID}:${PANE_ID}`);
    assert.notEqual(WorkspaceState.stateKey(WORKSPACE_ID, PANE_ID),
        WorkspaceState.stateKey(WORKSPACE_ID, SECOND_PANE_ID));
    assert.notEqual(WorkspaceState.stateKey(WORKSPACE_ID, PANE_ID),
        WorkspaceState.stateKey(SECOND_PANE_ID, PANE_ID));
    assert.equal(WorkspaceState.manifestKey(WORKSPACE_ID), `naia_canvas_workspace_v1:${WORKSPACE_ID}`);
    assert.notEqual(WorkspaceState.manifestKey(WORKSPACE_ID), WorkspaceState.manifestKey(SECOND_PANE_ID));
    assert.equal(WorkspaceState.stateKey(WORKSPACE_ID.toUpperCase(), PANE_ID), null);
    assert.equal(WorkspaceState.stateKey(WORKSPACE_ID, 'short'), null);
    assert.equal(WorkspaceState.manifestKey(''), null);
});

test('normalize rejects invalid top-level state and returns an isolated canonical copy', () => {
    assert.equal(WorkspaceState.normalize(null), null);
    assert.equal(WorkspaceState.normalize([]), null);
    assert.equal(WorkspaceState.normalize({version: '1', panes: []}), null);
    assert.equal(WorkspaceState.normalize({version: 1, panes: {}}), null);

    const input = {
        version: 1,
        activeId: PANE_ID,
        layout: 'grid',
        panes: [{
            id: PANE_ID,
            name: '  Main canvas  ',
            projectId: PROJECT_ID,
            canvasId: CANVAS_ID,
            retouch: true,
            privateNestedValue: {image: 'synthetic-only'},
        }],
        legacyField: {should: 'not leak'},
    };
    const normalized = WorkspaceState.normalize(input);

    assert.deepEqual(normalized, {
        version: 1,
        panes: [{
            id: PANE_ID,
            name: 'Main canvas',
            closed: false,
            projectId: PROJECT_ID,
            canvasId: CANVAS_ID,
            retouch: true,
        }],
        activeId: PANE_ID,
        layout: 'grid',
    });
    input.panes[0].name = 'Changed later';
    input.panes[0].privateNestedValue.image = 'changed';
    input.panes.push({id: SECOND_PANE_ID, name: 'Added later'});
    assert.equal(normalized.panes[0].name, 'Main canvas');
    assert.equal(Object.hasOwn(normalized.panes[0], 'privateNestedValue'), false);
    assert.equal(normalized.panes.length, 1);
});

test('normalize drops repeated pane IDs and project canvas pairs', () => {
    const normalized = WorkspaceState.normalize({
        version: 1,
        panes: [
            {id: PANE_ID, name: 'First', projectId: PROJECT_ID, canvasId: CANVAS_ID},
            {id: SECOND_PANE_ID, name: 'Same server canvas', projectId: PROJECT_ID, canvasId: CANVAS_ID},
            {id: PANE_ID, name: 'Repeated pane ID', setupId: 'setup-a'},
            {id: 'f'.repeat(32), name: 'Bad partial pair', projectId: PROJECT_ID, setupId: 'setup-b'},
            {id: '0'.repeat(32), name: 'Setup', setupId: ' setup-c '},
        ],
    });

    assert.deepEqual(normalized.panes, [
        {id: PANE_ID, name: 'First', closed: false, projectId: PROJECT_ID, canvasId: CANVAS_ID, retouch: false},
        {id: 'f'.repeat(32), name: 'Bad partial pair', closed: false, setupId: 'setup-b', retouch: false},
        {id: '0'.repeat(32), name: 'Setup', closed: false, setupId: ' setup-c ', retouch: false},
    ]);
});

test('normalize applies defaults and selects the first nonclosed pane when active is unusable', () => {
    const normalized = WorkspaceState.normalize({
        version: 1,
        activeId: SECOND_PANE_ID,
        layout: 'unexpected',
        panes: [
            {id: PANE_ID, name: '   ', closed: true, retouch: 'true'},
            {id: SECOND_PANE_ID, name: 'Open pane', closed: false},
            {id: 'f'.repeat(32), name: 'x'.repeat(151), closed: false, retouch: true},
        ],
    });
    assert.deepEqual(normalized, {
        version: 1,
        panes: [
            {id: PANE_ID, name: '캔버스', closed: true, retouch: false},
            {id: SECOND_PANE_ID, name: 'Open pane', closed: false, retouch: false},
            {id: 'f'.repeat(32), name: '캔버스', closed: false, retouch: true},
        ],
        activeId: SECOND_PANE_ID,
        layout: 'row',
    });

    const allClosed = WorkspaceState.normalize({
        version: 1,
        activeId: PANE_ID,
        panes: [{id: PANE_ID, name: 'Closed', closed: true, retouch: false}],
    });
    assert.equal(allClosed.activeId, null);
});

test('normalize clamps optional reference bounds and keeps older manifests without reference fields', () => {
    const thirdPaneId = 'f'.repeat(32);
    const input = {
        version: 1,
        activeId: PANE_ID,
        panes: [
            {id: PANE_ID, name: 'Legacy main'},
            {id: SECOND_PANE_ID, name: 'Clamped', reference: {
                visible: false, x: -5, y: Infinity, width: 20, height: 9000, privateField: 'drop',
            }},
            {id: thirdPaneId, name: 'Defaults', reference: {}},
        ],
    };
    const normalized = WorkspaceState.normalize(input);

    assert.deepEqual(normalized.panes, [
        {id: PANE_ID, name: 'Legacy main', closed: false, retouch: false},
        {id: SECOND_PANE_ID, name: 'Clamped', closed: false, retouch: false,
            reference: {visible: false, x: 0, y: 8, width: 120, height: 2000}},
        {id: thirdPaneId, name: 'Defaults', closed: false, retouch: false,
            reference: {visible: true, x: 8, y: 8, width: 160, height: 300}},
    ]);
    assert.equal(Object.hasOwn(normalized.panes[0], 'reference'), false,
        'older manifest entries keep the optional field absent');
    input.panes[1].reference.x = 700;
    assert.equal(normalized.panes[1].reference.x, 0, 'normalized reference bounds are an isolated copy');
});

test('normalize preserves bounded image-fit dimensions while keeping old reference fields readable', () => {
    const normalized = WorkspaceState.normalize({
        version: 1,
        panes: [
            {id: PANE_ID, name: 'Fitted', reference: {width: 302, height: 650, fitHeight: 600, fitRatio: 0.5}},
            {id: SECOND_PANE_ID, name: 'Invalid fit', reference: {fitHeight: 100001, fitRatio: 0.5}},
        ],
    });
    assert.deepEqual(normalized.panes[0].reference,
        {visible: true, x: 8, y: 8, width: 302, height: 650, fitHeight: 600, fitRatio: 0.5});
    assert.deepEqual(normalized.panes[1].reference, {visible: true, x: 8, y: 8, width: 160, height: 300});
});

test('frameUrl creates only a same-origin canvas URL from validated IDs', () => {
    assert.equal(WorkspaceState.frameUrl(WORKSPACE_ID, {
        id: PANE_ID, projectId: PROJECT_ID, canvasId: CANVAS_ID,
    }), `/canvas?workspace=${WORKSPACE_ID}&pane=${PANE_ID}&project=${PROJECT_ID}&canvas=${CANVAS_ID}`);
    assert.equal(WorkspaceState.frameUrl(WORKSPACE_ID, {id: PANE_ID, projectId: PROJECT_ID}),
        `/canvas?workspace=${WORKSPACE_ID}&pane=${PANE_ID}`);
    assert.equal(WorkspaceState.frameUrl('invalid', {id: PANE_ID}), null);
    assert.equal(WorkspaceState.frameUrl(WORKSPACE_ID, {id: 'invalid'}), null);
    assert.equal(WorkspaceState.frameUrl(WORKSPACE_ID, 'https://example.invalid/'), null);
});

test('storedStates reads only the legacy key and exact pane-state keys, skipping bad entries', () => {
    const paneKey = `naia_canvas_pane_v1:${WORKSPACE_ID}:${PANE_ID}`;
    const missingKey = `naia_canvas_pane_v1:${SECOND_PANE_ID}:${'f'.repeat(32)}`;
    const unrelatedKey = 'naia_canvas_pane_v1:short:also-short';
    const values = new Map([
        ['naia_canvas_state_v1', JSON.stringify({legacy: true})],
        [paneKey, JSON.stringify({canvas: {imageSrc: 'synthetic-data:'}})],
        [missingKey, null],
        ['naia_canvas_pane_v1:bad-key', '{'],
        [unrelatedKey, JSON.stringify({mustNotRead: true})],
        ['naia_canvas_pane_v1:' + '4'.repeat(32) + ':' + '5'.repeat(32), '{broken'],
        ['naia_canvas_pane_v1:' + '0'.repeat(32) + ':' + '1'.repeat(32), 'null'],
        ['naia_canvas_pane_v1:' + '2'.repeat(32) + ':' + '3'.repeat(32), '[]'],
        ['unrelated-setting', JSON.stringify({mustNotRead: true})],
    ]);
    const keys = Array.from(values.keys());
    const reads = [];
    let writes = 0;
    const fakeStorage = {
        get length() { return keys.length; },
        key(index) { return keys[index] ?? null; },
        getItem(key) {
            reads.push(key);
            return values.has(key) ? values.get(key) : null;
        },
        setItem() { writes += 1; },
        removeItem() { writes += 1; },
    };

    const states = WorkspaceState.storedStates(fakeStorage);
    assert.deepEqual(states, [
        {legacy: true},
        {canvas: {imageSrc: 'synthetic-data:'}},
    ]);
    assert.deepEqual(reads, [
        'naia_canvas_state_v1',
        paneKey,
        missingKey,
        'naia_canvas_pane_v1:' + '4'.repeat(32) + ':' + '5'.repeat(32),
        'naia_canvas_pane_v1:' + '0'.repeat(32) + ':' + '1'.repeat(32),
        'naia_canvas_pane_v1:' + '2'.repeat(32) + ':' + '3'.repeat(32),
    ]);
    assert.equal(writes, 0);
});
