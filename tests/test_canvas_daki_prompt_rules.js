const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Rules = require('../static/canvas_daki_prompt_rules.js');

test('the browser bundle exposes CanvasDakiPromptRules', () => {
    const source = fs.readFileSync(require.resolve('../static/canvas_daki_prompt_rules.js'), 'utf8');
    const context = {};
    vm.runInNewContext(source, context);
    assert.equal(typeof context.CanvasDakiPromptRules.inspect, 'function');
});

test('inspect unwraps nested emphasis and numeric weight scopes without stripping parentheses', () => {
    assert.deepEqual(Rules.inspect('1.2::blue eyes, long hair::, {tag1, [tag two]}, artist:sample (alias), literal\\(name\\)'), {
        valid: true,
        tokens: ['blue eyes', 'long hair', 'tag1', 'tag two', 'artist:sample (alias)', 'literal\\(name\\)'],
    });
});

test('inspect rejects unbalanced or malformed emphasis and weight scopes', () => {
    for (const prompt of ['blue, {hair', '1.2::blue, long hair', '[blue}', '{blue]', '::', 'tag::']) {
        assert.deepEqual(Rules.inspect(prompt), { valid: false, tokens: [] });
    }
});

test('key performs only exact leaf normalization', () => {
    assert.equal(Rules.key('  Blue__Eyes  '), 'blue eyes');
    assert.equal(Rules.key('artist:sample (alias)'), 'artist:sample (alias)');
    assert.notEqual(Rules.key('blue eyes'), Rules.key('blue eye'));
});

test('filter preserves a surviving numeric weight after removing one weighted leaf', () => {
    assert.equal(Rules.filter('1.2::blue eyes, shirt::, high quality', ['blue eyes']), '1.2::shirt::, high quality');
});

test('filter removes complete emphasis groups and drops their wrappers', () => {
    assert.equal(Rules.filter('{red eyes, blue hair}, other', ['red eyes', 'blue hair']), 'other');
    assert.equal(Rules.filter('{1.2::[blue eyes, shirt]::, hair}, high', ['blue eyes', 'shirt', 'hair']), 'high');
});

test('filter rebalances nested scopes while preserving unaffected branches', () => {
    assert.equal(Rules.filter('{1.2::[blue eyes, shirt]::, hair}, high quality', ['blue eyes']), '{1.2::[shirt]::, hair}, high quality');
});

test('filter preserves untouched weighted and nested envelopes beside a removed sibling', () => {
    assert.equal(Rules.filter('1.2::shirt::, blue eyes, high quality', ['blue eyes']), '1.2::shirt::, high quality');
    assert.equal(Rules.filter('{hair, blue eyes}, [long sleeves], high quality', ['blue eyes']), '{hair}, [long sleeves], high quality');
});

test('filter returns the exact original string for no matches or invalid input', () => {
    const noMatch = '  1.2::blue eyes, shirt::,  high quality  ';
    const invalid = ' [blue eyes, shirt ';
    assert.equal(Rules.filter(noMatch, ['green eyes']), noMatch);
    assert.equal(Rules.filter(invalid, ['blue eyes']), invalid);
});

test('filter matches whole normalized leaves and accepts Set exclusions', () => {
    assert.equal(Rules.filter('blue eyes, blue eyeshadow', new Set(['BLUE__EYES'])), 'blue eyeshadow');
});

test('filter retains parentheses and ordinary colon and underscore punctuation in names', () => {
    assert.equal(Rules.filter('{artist:name (alias), other_tag}', ['other tag']), '{artist:name (alias)}');
});

const classification = (token, tag, regions = [], sections = []) => ({ token, tag, regions, sections });

test('candidates groups only tags outside the selected mapped body focus', () => {
    const promptInfo = {
        basePrompt: 'blue eyes, hair strand, hand, sleeve, shirt, skirt, unknown tag, high quality, person, all torso clothes',
        negativePrompt: 'red eyes',
        charPrompts: [],
    };
    const classifications = [
        classification('blue eyes', 'blue_eyes', ['face'], ['face.eyes']),
        classification('hair strand', 'hair_strand', ['face'], ['face.hair']),
        classification('hand', 'hand', ['arms'], ['arms.hands']),
        classification('sleeve', 'sleeve', ['arms'], ['arms.clothes']),
        classification('shirt', 'shirt', ['chest'], ['chest.clothes']),
        classification('skirt', 'skirt', ['pelvis'], ['pelvis.clothes']),
        classification('unknown tag', null, [], []),
        classification('person', 'whole', ['whole'], []),
        classification('all torso clothes', 'all_torso_clothes', ['chest'], ['chest.clothes']),
    ];

    const result = Rules.candidates(promptInfo, classifications, 'chest');
    assert.deepEqual(result, [
        { region: 'face', name: '얼굴', items: [{ field: 'base', token: 'blue eyes', key: 'blue eyes' }] },
        { region: 'hair', name: '머리카락', items: [{ field: 'base', token: 'hair strand', key: 'hair strand' }] },
        { region: 'hands', name: '손', items: [{ field: 'base', token: 'hand', key: 'hand' }] },
        { region: 'arms', name: '팔', items: [{ field: 'base', token: 'sleeve', key: 'sleeve' }] },
        { region: 'pelvis', name: '골반', items: [{ field: 'base', token: 'skirt', key: 'skirt' }] },
    ]);
    const backItems = Rules.candidates(promptInfo, classifications, 'back').flatMap((group) => group.items.map((item) => item.token));
    assert.equal(backItems.includes('shirt'), false);
    assert.equal(backItems.includes('all torso clothes'), false);
});

test('candidates keep multiple applicable parts and place other multi-part tags under their first part', () => {
    const promptInfo = { basePrompt: 'face and chest, face and legs', charPrompts: [] };
    const classifications = [
        classification('face and chest', 'face.chest', ['face', 'chest']),
        classification('face and legs', 'face.legs', ['face', 'legs']),
    ];
    assert.deepEqual(Rules.candidates(promptInfo, classifications, 'chest'), [
        { region: 'face', name: '얼굴', items: [{ field: 'base', token: 'face and legs', key: 'face and legs' }] },
    ]);
});

test('candidates keep a multi-section face tag in both face and hair focus', () => {
    const promptInfo = { basePrompt: 'face and hair detail', charPrompts: [] };
    const classifications = [classification('face and hair detail', 'multi_face', ['face'], ['face.hair', 'face.eyes'])];
    assert.deepEqual(Rules.candidates(promptInfo, classifications, 'face'), []);
    assert.deepEqual(Rules.candidates(promptInfo, classifications, 'hair'), []);
    assert.deepEqual(Rules.candidates(promptInfo, classifications, 'chest'), [
        { region: 'hair', name: '머리카락', items: [{ field: 'base', token: 'face and hair detail', key: 'face and hair detail' }] },
    ]);
});

test('candidates keep a multi-section arm tag in both arms and hands focus', () => {
    const promptInfo = { basePrompt: 'hand and sleeve detail', charPrompts: [] };
    const classifications = [classification('hand and sleeve detail', 'multi_arm', ['arms'], ['arms.hands', 'arms.clothes'])];
    assert.deepEqual(Rules.candidates(promptInfo, classifications, 'hands'), []);
    assert.deepEqual(Rules.candidates(promptInfo, classifications, 'arms'), []);
    assert.deepEqual(Rules.candidates(promptInfo, classifications, 'chest'), [
        { region: 'hands', name: '손', items: [{ field: 'base', token: 'hand and sleeve detail', key: 'hand and sleeve detail' }] },
    ]);
});

test('candidates protects exact field tokens and preserves unknown regions', () => {
    const promptInfo = { basePrompt: 'blue eyes, sleeve, tail', charPrompts: ['blue eyes'] };
    const classifications = [
        classification('blue eyes', 'blue_eyes', ['face'], ['face.eyes']),
        classification('sleeve', 'sleeve', ['arms'], ['arms.clothes']),
        classification('tail', 'tail', ['tail']),
    ];
    assert.deepEqual(Rules.candidates(promptInfo, classifications, 'chest', { base: ['BLUE__EYES'] }), [
        { region: 'arms', name: '팔', items: [{ field: 'base', token: 'sleeve', key: 'sleeve' }] },
        { region: 'face', name: '얼굴', items: [{ field: 'char-0', token: 'blue eyes', key: 'blue eyes' }] },
    ]);
});

test('candidates deduplicates by field and key but keeps the same tag in separate character fields', () => {
    const promptInfo = { basePrompt: 'sleeve, sleeve', charPrompts: ['sleeve', 'sleeve'] };
    const classifications = [classification('sleeve', 'sleeve', ['arms'], ['arms.clothes'])];
    assert.deepEqual(Rules.candidates(promptInfo, classifications, 'chest'), [
        {
            region: 'arms', name: '팔', items: [
                { field: 'base', token: 'sleeve', key: 'sleeve' },
                { field: 'char-0', token: 'sleeve', key: 'sleeve' },
                { field: 'char-1', token: 'sleeve', key: 'sleeve' },
            ],
        },
    ]);
});

test('candidates returns no groups for whole or invalid focus and leaves inputs unchanged', () => {
    const promptInfo = { basePrompt: 'blue eyes', negativePrompt: 'sleeve', charPrompts: [] };
    const classifications = [classification('blue eyes', 'blue_eyes', ['face'], ['face.eyes'])];
    const promptSnapshot = structuredClone(promptInfo);
    const classificationSnapshot = structuredClone(classifications);
    assert.deepEqual(Rules.candidates(promptInfo, classifications, 'whole'), []);
    assert.deepEqual(Rules.candidates(promptInfo, classifications, 'not-a-region'), []);
    Rules.candidates(promptInfo, classifications, 'chest');
    assert.deepEqual(promptInfo, promptSnapshot);
    assert.deepEqual(classifications, classificationSnapshot);
});
