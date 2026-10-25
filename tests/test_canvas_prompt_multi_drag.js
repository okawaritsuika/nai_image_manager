const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const canvasSource = fs.readFileSync(require.resolve('../static/canvas.js'), 'utf8');
const payloadType = 'application/x-clip-prompt-item';

function extractFunction(source, name) {
    const marker = `function ${name}(`;
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, `expected ${name} in its source file`);
    const brace = source.indexOf('{', start);
    let depth = 0;
    for (let index = brace; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') depth -= 1;
        if (depth === 0) return source.slice(start, index + 1);
    }
    assert.fail(`expected closing brace for ${name}`);
}

function makeHarness({inputValue = 'one, two, 1.2:: three ::, four, five', groups = []} = {}) {
    const inputs = new Map([
        ['clipBasePromptInput', {id: 'clipBasePromptInput', value: inputValue}],
        ['clipNegativePromptInput', {id: 'clipNegativePromptInput', value: 'avoid'}],
        ['clipCharPromptInput-2', {id: 'clipCharPromptInput-2', value: 'char prompt'}]
    ]);
    const calls = {groupRenders: 0, tokenRenders: 0, saves: 0};
    const selectedButtons = [];
    const ui = {
        clipGroupSelectionPopover: {style: {display: 'block'}},
        clipPromptAreaSelectionBox: {style: {display: 'block'}}
    };
    const context = vm.createContext({
        console: {warn() {}},
        document: {
            querySelectorAll(selector) {
                if (selector === '.prompt-token-btn.button-selected') return selectedButtons;
                return [];
            }
        },
        el(id) { return inputs.get(id) || ui[id] || null; },
        getClipPromptFields() {
            return [
                {key: 'base', inputId: 'clipBasePromptInput'},
                {key: 'negative', inputId: 'clipNegativePromptInput'},
                {key: 'char-2', inputId: 'clipCharPromptInput-2', isChar: true}
            ];
        },
        findClipPromptControlGroup(id) { return groups.find(group => group.id === id) || null; },
        getActiveClipForPromptControl() { return {id: 7}; },
        renderClipPromptControlGroups() { calls.groupRenders += 1; },
        renderAllClipPromptTokens() { calls.tokenRenders += 1; },
        saveCanvasState() { calls.saves += 1; },
        calls,
        selectedButtons
    });

    for (const name of [
        'getClipPromptField',
        'parseClipPromptTokens',
        'joinClipPromptTokens',
        'stripClipWeightMarkers',
        'normalizeClipTokenForGroup',
        'normalizeClipPromptControlField',
        'getClipPromptControlItemKey',
        'normalizeClipPromptControlItems',
        'clearClipButtonSelectionMarks',
        'hideClipAreaSelectionBox',
        'hideClipGroupSelectionPopover',
        'setClipPromptDragData',
        'bindClipPromptControlDropZone',
        'addClipPromptControlItemToGroup'
    ]) {
        vm.runInContext(extractFunction(canvasSource, name), context);
    }
    return {context, inputs, calls, selectedButtons, ui};
}

function makeSelectableButton(field = 'base', start = 1, end = 3, selected = true) {
    const classes = new Set(selected ? ['button-selected'] : []);
    return {
        dataset: {
            clipPromptField: field,
            clipPromptStart: String(start),
            clipPromptEnd: String(end)
        },
        classList: {
            contains(name) { return classes.has(name); },
            remove(name) { classes.delete(name); }
        },
        closest(selector) {
            return selector === '.prompt-token-btn[data-clip-prompt-field]' ? this : null;
        }
    };
}

function makeDataTransfer(initial = '') {
    const data = new Map();
    if (initial) data.set(payloadType, initial);
    return {
        effectAllowed: '',
        dropEffect: '',
        get types() { return [...data.keys()]; },
        setData(type, value) { data.set(type, value); },
        getData(type) { return data.get(type) || ''; },
        data
    };
}

function dragEvent(button) {
    const dataTransfer = makeDataTransfer();
    return {
        dataTransfer,
        currentTarget: button,
        target: button,
        payload: {field: 'base', type: 'token', token: '1.2:: three ::'}
    };
}

function dropPayload(harness, payload, group = {id: 'target', items: []}) {
    const zoneClasses = new Set();
    const dropZone = {classList: {
        add(name) { zoneClasses.add(name); },
        remove(name) { zoneClasses.delete(name); }
    }};
    harness.context.bindClipPromptControlDropZone(dropZone, group);
    const dataTransfer = makeDataTransfer(typeof payload === 'string' ? payload : JSON.stringify(payload));
    let prevented = 0;
    let stopped = 0;
    dropZone.ondrop({
        dataTransfer,
        preventDefault() { prevented += 1; },
        stopPropagation() { stopped += 1; }
    });
    return {group, prevented, stopped, zoneClasses};
}

test('selected token drag serializes the current raw token range as one batch', () => {
    const h = makeHarness();
    const button = makeSelectableButton('base', 2, 2);
    const payload = {field: 'base', type: 'token', token: '1.2:: three ::'};
    h.context.selectedClipPromptGroup = {
        inputId: 'clipBasePromptInput',
        fieldKey: 'base',
        tokenStart: 1,
        tokenEnd: 3,
        text: 'two, 1.2:: three ::, four'
    };
    const event = dragEvent(button);
    event.payload = payload;
    h.context.setClipPromptDragData(event, payload);

    assert.equal(event.dataTransfer.effectAllowed, 'copy');
    assert.deepEqual(JSON.parse(event.dataTransfer.getData(payloadType)), {
        field: 'base',
        type: 'tokens',
        tokens: ['two', '1.2:: three ::', 'four']
    });
    assert.equal(event.dataTransfer.getData('text/plain'), 'two, 1.2:: three ::, four');
    assert.equal(h.inputs.get('clipBasePromptInput').value, 'one, two, 1.2:: three ::, four, five');
    assert.deepEqual(payload, {field: 'base', type: 'token', token: '1.2:: three ::'});
    assert.equal(h.context.selectedClipPromptGroup.tokenStart, 1);
});

test('nested weighted-range chip resolves its selected parent button', () => {
    const h = makeHarness();
    const parent = makeSelectableButton('base', 1, 2);
    const innerChip = {closest: selector => selector === '.prompt-token-btn[data-clip-prompt-field]' ? parent : null};
    h.context.selectedClipPromptGroup = {
        inputId: 'clipBasePromptInput', fieldKey: 'base', tokenStart: 1, tokenEnd: 2,
        text: 'two, 1.2:: three ::'
    };
    const event = dragEvent(innerChip);
    event.currentTarget = innerChip;
    event.target = innerChip;
    h.context.setClipPromptDragData(event, {field: 'base', type: 'token', token: 'two'});

    assert.deepEqual(JSON.parse(event.dataTransfer.getData(payloadType)), {
        field: 'base', type: 'tokens', tokens: ['two', '1.2:: three ::']
    });
});

test('an unselected existing group keeps the legacy group-chip payload and drag start preserves selection', () => {
    const h = makeHarness();
    const button = makeSelectableButton('base', 1, 2, false);
    const payload = {field: 'base', type: 'group', name: 'Pair', tokens: ['two', 'three']};
    h.context.selectedClipPromptGroup = {
        inputId: 'clipBasePromptInput', fieldKey: 'base', tokenStart: 1, tokenEnd: 2,
        text: 'two, 1.2:: three ::'
    };
    const event = dragEvent(button);
    h.context.setClipPromptDragData(event, payload);

    assert.deepEqual(JSON.parse(event.dataTransfer.getData(payloadType)), payload);
    assert.equal(event.dataTransfer.getData('text/plain'), 'Pair');
    assert.equal(h.context.selectedClipPromptGroup.tokenStart, 1);
    assert.equal(h.inputs.get('clipBasePromptInput').value, 'one, two, 1.2:: three ::, four, five');
});

test('stale, mismatched, unselected, style, and incomplete selections keep single-item payloads', () => {
    const cases = [
        {name: 'stale selection text', selectedText: 'not current'},
        {name: 'cross-field selection', selectedField: 'negative', selectedInput: 'clipNegativePromptInput'},
        {name: 'unselected button', selected: false},
        {name: 'missing button range', missingRange: true},
        {name: 'style button', styleButton: true},
        {name: 'single selected token', tokenStart: 2, tokenEnd: 2, text: '1.2:: three ::'}
    ];

    for (const entry of cases) {
        const h = makeHarness();
        const button = entry.styleButton
            ? {classList: {contains: () => true}, dataset: {}, closest: () => null}
            : makeSelectableButton('base', 2, 2, entry.selected !== false);
        if (entry.missingRange) delete button.dataset.clipPromptStart;
        const fieldKey = entry.selectedField || 'base';
        h.context.selectedClipPromptGroup = {
            inputId: entry.selectedInput || 'clipBasePromptInput',
            fieldKey,
            tokenStart: entry.tokenStart ?? 1,
            tokenEnd: entry.tokenEnd ?? 3,
            text: entry.text || entry.selectedText || 'two, 1.2:: three ::, four'
        };
        const original = {field: 'base', type: 'token', token: '1.2:: three ::'};
        const event = dragEvent(button);
        h.context.setClipPromptDragData(event, original);
        assert.deepEqual(JSON.parse(event.dataTransfer.getData(payloadType)), original, entry.name);
        assert.equal(event.dataTransfer.getData('text/plain'), original.token, entry.name);
    }
});

test('drop adds mixed batch tokens in order, normalizes fields, deduplicates, and saves once', () => {
    const existing = [
        {field: 'char-8', type: 'token', token: 'blue'},
        {field: 'char', type: 'token', token: 'existing'}
    ];
    const group = {id: 'target', items: existing};
    const h = makeHarness({groups: [group]});
    const button = makeSelectableButton('char-2', 1, 2);
    h.selectedButtons.push(button);
    h.context.selectedClipPromptGroup = {
        inputId: 'clipCharPromptInput-2', fieldKey: 'char-2', tokenStart: 0, tokenEnd: 3,
        text: '1.2:: blue ::, red, RED, fresh ::'
    };

    const {group: result, prevented, stopped, zoneClasses} = dropPayload(h, {
        field: 'char-2',
        type: 'tokens',
        tokens: ['1.2:: blue ::', 'red', 'RED', 'fresh ::']
    }, group);

    assert.equal(prevented, 1);
    assert.equal(stopped, 1);
    assert.equal(zoneClasses.has('drag-over'), false);
    assert.deepEqual(JSON.parse(JSON.stringify(result.items)), [
        {field: 'char-8', type: 'token', token: 'blue'},
        {field: 'char', type: 'token', token: 'existing'},
        {field: 'char', type: 'token', token: 'red'},
        {field: 'char', type: 'token', token: 'fresh ::'}
    ]);
    assert.equal(h.calls.groupRenders, 1);
    assert.equal(h.calls.tokenRenders, 1);
    assert.equal(h.calls.saves, 1);
    assert.equal(h.context.selectedClipPromptGroup, null);
    assert.equal(button.classList.contains('button-selected'), false);
    assert.equal(h.ui.clipGroupSelectionPopover.style.display, 'none');
    assert.equal(h.inputs.get('clipCharPromptInput-2').value, 'char prompt');
});

test('negative field stays negative and successful batch clears selection only after drop', () => {
    const group = {id: 'target', items: []};
    const h = makeHarness({groups: [group]});
    h.context.selectedClipPromptGroup = {
        inputId: 'clipNegativePromptInput', fieldKey: 'negative', tokenStart: 0, tokenEnd: 1,
        text: 'avoid, blur'
    };
    const {group: result} = dropPayload(h, {field: 'negative', type: 'tokens', tokens: ['avoid', 'blur']}, group);

    assert.deepEqual(JSON.parse(JSON.stringify(result.items)), [
        {field: 'negative', type: 'token', token: 'avoid'},
        {field: 'negative', type: 'token', token: 'blur'}
    ]);
    assert.equal(h.calls.saves, 1);
});

test('all duplicates, invalid batches, missing targets, and malformed drops do not save or render', () => {
    const cases = [
        {name: 'all duplicates', group: {id: 'target', items: [{field: 'base', type: 'token', token: 'one'}, {field: 'base', type: 'token', token: 'two'}]}, payload: {field: 'base', type: 'tokens', tokens: ['ONE', 'two']}},
        {name: 'empty batch', group: {id: 'target'}, payload: {field: 'base', type: 'tokens', tokens: []}},
        {name: 'invalid batch entry', group: {id: 'target'}, payload: {field: 'base', type: 'tokens', tokens: ['one', null]}},
        {name: 'missing group', group: {id: 'missing'}, registered: false, payload: {field: 'base', type: 'tokens', tokens: ['one', 'two']}}
    ];

    for (const entry of cases) {
        const h = makeHarness({groups: entry.registered === false ? [] : [entry.group]});
        dropPayload(h, entry.payload, entry.group);
        assert.equal(h.calls.groupRenders, 0, entry.name);
        assert.equal(h.calls.tokenRenders, 0, entry.name);
        assert.equal(h.calls.saves, 0, entry.name);
        if (entry.name !== 'all duplicates') assert.equal(entry.group.items, undefined, entry.name);
    }

    const h = makeHarness();
    const group = {id: 'target', items: []};
    const result = dropPayload(h, '{malformed', group);
    assert.equal(result.group.items.length, 0);
    assert.equal(h.calls.saves, 0);
    assert.equal(h.calls.groupRenders, 0);
});

test('legacy single-token and group payloads retain their existing shapes and behavior', () => {
    const group = {id: 'target', items: []};
    const h = makeHarness({groups: [group]});
    h.context.addClipPromptControlItemToGroup('target', {field: 'char-4', type: 'token', token: '  Tag  '});
    h.context.addClipPromptControlItemToGroup('target', {
        field: 'negative', type: 'group', name: 'Pair', tokens: [' A ', null, 'B']
    });

    assert.deepEqual(JSON.parse(JSON.stringify(group.items)), [
        {field: 'char', type: 'token', token: 'Tag'},
        {field: 'negative', type: 'group', name: 'Pair', tokens: ['A', 'B']}
    ]);
    assert.equal(h.calls.groupRenders, 2);
    assert.equal(h.calls.tokenRenders, 2);
    assert.equal(h.calls.saves, 2);
    assert.equal(h.context.selectedClipPromptGroup, undefined);
});
