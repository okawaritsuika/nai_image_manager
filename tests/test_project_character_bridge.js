const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../static/canvas_style_bridge.js'), 'utf8');

function loadBridge(fields) {
    const groupingCalls = [];
    const toggleCalls = [];
    const projectSettings = {
        groupParts(...args) {
            groupingCalls.push(args);
            return args[1];
        },
        toggleExpanded(...args) { toggleCalls.push(args); },
    };
    const buttons = [];
    const context = {
        window: {CanvasProjectSettings: projectSettings, addEventListener() {}},
        document: {
            addEventListener() {},
            createElement(tag) {
                return {
                    tagName: tag,
                    style: {setProperty() {}},
                    setAttribute() {},
                    className: '',
                    textContent: '',
                    appendChild() {},
                };
            },
        },
        getClipPromptFields: () => fields,
        getCanvasStyleLink: () => ({groupParts: (_field, parts) => parts}),
        applyClipPromptGroupsWithIndexes: parts => parts,
        getClipPromptGroupColor: () => 'gray',
    };
    vm.createContext(context);
    vm.runInContext(source + '\nthis.__bridge = {buildCanvasStylePromptParts, renderCanvasStylePromptButton};', context);
    return {
        groupingCalls,
        toggleCalls,
        build: context.__bridge.buildCanvasStylePromptParts,
        render: context.__bridge.renderCanvasStylePromptButton,
        buttons,
    };
}

test('project character recipes map arbitrary ccp IDs by current DOM order and preserve base calls', () => {
    const fields = [
        {key: 'base'},
        {key: 'char-ccp918', isChar: true},
        {key: 'char-ccp3', isChar: true},
    ];
    const bridge = loadBridge(fields);
    const parts = [{type: 'token', token: 'synthetic', index: 0}];
    bridge.build('char-ccp3', parts);
    assert.equal(bridge.groupingCalls[0].length, 3);
    assert.equal(bridge.groupingCalls[0][0], 'char-ccp3');
    assert.equal(bridge.groupingCalls[0][2], 1);

    bridge.build('base', parts);
    assert.equal(bridge.groupingCalls[1].length, 2);
    assert.equal(bridge.groupingCalls[1][0], 'base');
});

test('project character group buttons toggle their saved ordinal instead of parsing the field ID', () => {
    const bridge = loadBridge([
        {key: 'char-ccp918', isChar: true},
        {key: 'char-ccp3', isChar: true},
    ]);
    const surface = {appendChild(button) { this.button = button; }};
    bridge.render(surface, 'char-ccp3', {
        type: 'style', projectPrompt: true, characterIndex: 1, name: '앞면 캐릭터 2',
        tokens: ['synthetic'], expanded: false,
    });
    surface.button.onclick({preventDefault() {}, stopPropagation() {}});
    assert.deepEqual(bridge.toggleCalls, [['char-ccp3', 1]]);
});
