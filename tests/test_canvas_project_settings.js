const test = require('node:test');
const assert = require('node:assert/strict');
const CanvasProjectSettings = require('../static/canvas_project_settings.js');
const CanvasStyleLink = require('../static/canvas_style_link.js');

const PROJECT_ID = 'a'.repeat(32);
const OTHER_PROJECT_ID = 'd'.repeat(32);
const CANVAS_ID = 'b'.repeat(32);
const OTHER_CANVAS_ID = 'c'.repeat(32);

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const style = (overrides = {}) => ({
    id: 'project-style',
    library: 'shared',
    name: 'Synthetic style',
    positive: 'woodblock, paper texture',
    negative: 'bad anatomy',
    ...overrides,
});
const inpaintSettings = (overrides = {}) => ({
    prompt: 'synthetic inpaint prompt',
    steps: 24,
    ...overrides,
});
const prompt = (basePrompt = '', negativePrompt = '') => ({basePrompt, negativePrompt});
const settings = ({revision = 1, style: styleValue = style(),
    front = prompt(), back = prompt(), inpaint = inpaintSettings()} = {}) => ({
    revision,
    style: clone(styleValue),
    prompts: {front: clone(front), back: clone(back)},
    inpaintSettings: clone(inpaint),
});
const link = ({projectId = PROJECT_ID, canvasId = CANVAS_ID, side = 'front'} = {}) => ({
    projectId, canvasId, side,
});
const success = value => response({status: 'success', settings: clone(value)});
const failure = (message = 'synthetic request failed') => response({status: 'error', message}, false);
const response = (payload, ok = true) => ({ok, async json() { return clone(payload); }});
const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return {promise, resolve, reject};
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const tokenParts = values => values.map((item, index) => typeof item === 'string'
    ? {type: 'token', token: item, index}
    : {type: 'token', ...item});
const projectMarker = parts => parts.find(part => part.type === 'style' && part.projectPrompt);

function harness({initialLink = link(), canApply = true} = {}) {
    let currentLink = initialLink;
    let canApplyValue = canApply;
    const requests = [];
    const queued = [];
    const styleCalls = [];
    const inpaintCalls = [];
    const statusCalls = [];
    let saves = 0;
    let renders = 0;
    const controller = CanvasProjectSettings.create({
        getLink: () => currentLink,
        fetch: (url, options = {}) => {
            requests.push({url, method: options.method || 'GET', signal: options.signal});
            const next = queued.shift();
            if (!next) throw new Error('Unexpected settings request');
            return typeof next === 'function' ? next(url, options) : next;
        },
        styleRules: CanvasStyleLink,
        setStyle: value => styleCalls.push(clone(value)),
        setInpaint: value => inpaintCalls.push(clone(value)),
        save: () => { saves += 1; },
        render: () => { renders += 1; },
        status: (state, message) => statusCalls.push({state, message}),
        canApply: () => canApplyValue,
    });
    return {
        controller,
        requests,
        styleCalls,
        inpaintCalls,
        statusCalls,
        get saves() { return saves; },
        get renders() { return renders; },
        enqueue: item => queued.push(item),
        setLink: value => { currentLink = value; },
        setCanApply: value => { canApplyValue = value; },
    };
}

test('fresh front and back settings apply once and group only their original per-side prompt text', async () => {
    const h = harness();
    const liveCanvasPrompt = {basePrompt: 'existing positive text', negativePrompt: 'existing negative text'};
    const frontStyle = style();
    const sharedInpaint = inpaintSettings();
    h.enqueue(success(settings({
        style: frontStyle,
        front: prompt('ink, blue hair', 'bad anatomy, jpeg artifacts'),
        back: prompt('rough paper, side view', 'low contrast'),
        inpaint: sharedInpaint,
    })));

    await h.controller.refresh();

    assert.deepEqual(h.styleCalls, [{mode: 'manual', style: frontStyle}]);
    assert.deepEqual(h.inpaintCalls, [sharedInpaint]);
    assert.deepEqual(h.controller.snapshot().prompt, prompt('ink, blue hair', 'bad anatomy, jpeg artifacts'));
    const baseParts = tokenParts(['1.5::INK::', 'loose hair', '{Blue_Hair}']);
    const baseGrouped = h.controller.groupParts('base', baseParts);
    assert.deepEqual(projectMarker(baseGrouped).indexes, [0, 2]);
    assert.deepEqual(projectMarker(baseGrouped).tokens, ['1.5::INK::', '{Blue_Hair}']);
    assert.deepEqual(baseGrouped.filter(part => part.type === 'token').map(part => part.index), [1]);
    const negativeParts = tokenParts(['bad anatomy', 'film grain', 'JPEG_ARTIFACTS']);
    const negativeGrouped = h.controller.groupParts('negative', negativeParts);
    assert.deepEqual(projectMarker(negativeGrouped).indexes, [0, 2]);
    assert.deepEqual(negativeGrouped.filter(part => part.type === 'token').map(part => part.index), [1]);
    assert.deepEqual(liveCanvasPrompt, {basePrompt: 'existing positive text', negativePrompt: 'existing negative text'});

    h.setLink(link({side: 'back'}));
    h.enqueue(success(settings({
        style: frontStyle,
        front: prompt('ink, blue hair', 'bad anatomy, jpeg artifacts'),
        back: prompt('rough paper, side view', 'low contrast'),
        inpaint: sharedInpaint,
    })));
    await h.controller.refresh();

    assert.deepEqual(h.controller.snapshot().prompt, prompt('rough paper, side view', 'low contrast'));
    assert.equal(projectMarker(h.controller.groupParts('base', tokenParts(['ink', 'blue hair']))), undefined);
    assert.equal(projectMarker(h.controller.groupParts('base', tokenParts(['rough paper', 'side view'])))?.name,
        '뒷면 프롬프트');
    assert.equal(projectMarker(h.controller.groupParts('negative', tokenParts(['bad anatomy', 'jpeg artifacts']))), undefined);
    assert.equal(projectMarker(h.controller.groupParts('negative', tokenParts(['low contrast']))).name,
        '뒷면 프롬프트');
    assert.deepEqual(h.requests.map(item => [item.url, item.method]), [
        [`/api/daki/projects/${PROJECT_ID}/canvas-settings`, 'GET'],
        [`/api/daki/projects/${PROJECT_ID}/canvas-settings`, 'GET'],
    ]);
    assert.ok(h.requests.every(item => item.method !== 'PUT'));
});

test('revisions preserve local style and inpaint edits unless their source settings change', async () => {
    const h = harness();
    const originalStyle = style();
    const originalInpaint = inpaintSettings();
    h.enqueue(success(settings({revision: 1, style: originalStyle, inpaint: originalInpaint,
        front: prompt('first base', 'first negative')})));
    await h.controller.refresh();
    const baselineStyleCalls = h.styleCalls.length;
    const baselineInpaintCalls = h.inpaintCalls.length;
    const baselineSaves = h.saves;

    h.enqueue(success(settings({revision: 1, style: style({name: 'same revision server change'}),
        inpaint: inpaintSettings({steps: 99}), front: prompt('first base', 'first negative')})));
    await h.controller.refresh();
    assert.equal(h.styleCalls.length, baselineStyleCalls);
    assert.equal(h.inpaintCalls.length, baselineInpaintCalls);
    assert.equal(h.saves, baselineSaves);

    h.enqueue(success(settings({revision: 2, style: originalStyle, inpaint: originalInpaint,
        front: prompt('edited base recipe', 'first negative')})));
    await h.controller.refresh();
    assert.equal(h.styleCalls.length, baselineStyleCalls);
    assert.equal(h.inpaintCalls.length, baselineInpaintCalls);
    assert.equal(h.controller.snapshot().prompt.basePrompt, 'edited base recipe');

    const changedInpaint = inpaintSettings({steps: 31});
    h.enqueue(success(settings({revision: 3, style: originalStyle, inpaint: changedInpaint,
        front: prompt('edited base recipe', 'first negative')})));
    await h.controller.refresh();
    assert.equal(h.inpaintCalls.length, baselineInpaintCalls + 1);
    assert.deepEqual(h.inpaintCalls.at(-1), changedInpaint);
    assert.equal(h.styleCalls.length, baselineStyleCalls);

    const changedStyle = style({id: 'new-style', name: 'Updated catalog snapshot'});
    h.enqueue(success(settings({revision: 4, style: changedStyle, inpaint: changedInpaint,
        front: prompt('edited base recipe', 'first negative')})));
    await h.controller.refresh();
    assert.deepEqual(h.styleCalls.at(-1), {mode: 'manual', style: changedStyle});
    assert.equal(h.inpaintCalls.length, baselineInpaintCalls + 1);
});

test('recipe matching caps duplicates, preserves source indexes and order through expand and collapse', async () => {
    const h = harness();
    h.enqueue(success(settings({front: prompt('ink, ink, ink', ''), back: prompt()})));
    await h.controller.refresh();
    const original = tokenParts([
        {token: 'unrelated', index: 2},
        {token: '2::INK::', index: 4},
        {token: 'between', index: 5},
        {token: '{ink}', index: 8},
    ]);

    const collapsed = h.controller.groupParts('base', original);
    assert.deepEqual(projectMarker(collapsed).indexes, [4, 8]);
    assert.deepEqual(projectMarker(collapsed).tokens, ['2::INK::', '{ink}']);
    assert.deepEqual(collapsed.filter(part => part.type === 'token').map(part => [part.token, part.index]), [
        ['unrelated', 2], ['between', 5],
    ]);

    h.controller.toggleExpanded('base');
    const expanded = h.controller.groupParts('base', original);
    assert.equal(projectMarker(expanded).expanded, true);
    assert.deepEqual(expanded.filter(part => part.type === 'token').map(part => [part.token, part.index]),
        original.map(part => [part.token, part.index]));
    h.controller.toggleExpanded('base');
    const recollapsed = h.controller.groupParts('base', original);
    assert.deepEqual(projectMarker(recollapsed).indexes, [4, 8]);
    assert.deepEqual(recollapsed.filter(part => part.type === 'token').map(part => [part.token, part.index]), [
        ['unrelated', 2], ['between', 5],
    ]);
});

test('project recipe groups noncontiguous tokens without consuming existing style groups, expanded or collapsed', async () => {
    const h = harness();
    h.enqueue(success(settings({front: prompt('outer, style one, style two, ending', '')})));
    await h.controller.refresh();
    const original = [
        {type: 'token', token: 'outer', index: 0},
        {type: 'style', name: 'Canvas style', indexes: [1, 2], tokens: ['style one', 'style two'], expanded: true},
        {type: 'token', token: 'style one', index: 1},
        {type: 'token', token: 'style two', index: 2},
        {type: 'token', token: 'ending', index: 3},
    ];

    const grouped = h.controller.groupParts('base', original);
    assert.deepEqual(projectMarker(grouped).indexes, [0, 3]);
    assert.ok(grouped.some(part => part.type === 'style' && part.name === 'Canvas style'));
    assert.deepEqual(grouped.filter(part => part.type === 'token' && [1, 2].includes(part.index))
        .map(part => part.index), [1, 2]);

    h.controller.toggleExpanded('base');
    const expanded = h.controller.groupParts('base', original);
    assert.deepEqual(projectMarker(expanded).indexes, [0, 3]);
    assert.deepEqual(expanded.filter(part => part.type === 'token').map(part => part.index), [0, 1, 2, 3]);
    assert.ok(expanded.some(part => part.type === 'style' && part.name === 'Canvas style'));
});

test('character recipes use their saved ordinal, keep blank slots, weights, duplicates, and side isolation', async () => {
    const h = harness();
    const liveCanvasPrompt = {basePrompt: 'existing canvas base', negativePrompt: 'existing canvas negative'};
    const frontRecipes = ['blue eyes, blue eyes', '', 'red hair'];
    h.enqueue(success(settings({
        front: {...prompt('unused base recipe', 'unused negative recipe'), charPrompts: frontRecipes},
        back: {...prompt('back base recipe', ''), charPrompts: ['silver hair']},
    })));
    await h.controller.refresh();

    const duplicated = tokenParts([
        {token: 'outer', index: 2},
        {token: '1.25::BLUE_EYES::', index: 4},
        {token: 'between', index: 5},
        {token: '{blue eyes}', index: 8},
        {token: 'blue eyes', index: 9},
    ]);
    const firstCharacter = projectMarker(h.controller.groupParts('char-ccp918', duplicated, 0));
    assert.equal(firstCharacter.name, '앞면 캐릭터 1');
    assert.deepEqual(firstCharacter.indexes, [4, 8]);
    assert.deepEqual(firstCharacter.tokens, ['1.25::BLUE_EYES::', '{blue eyes}']);
    assert.equal(projectMarker(h.controller.groupParts('char-ccp3', duplicated, 2)), undefined);
    assert.deepEqual(h.controller.groupParts('char-ccp3', duplicated, 1), duplicated);
    assert.equal(projectMarker(h.controller.groupParts('base', duplicated, 0)), undefined);
    assert.deepEqual(h.controller.snapshot().prompt.charPrompts, frontRecipes);
    assert.deepEqual(liveCanvasPrompt, {basePrompt: 'existing canvas base', negativePrompt: 'existing canvas negative'});

    const redHair = tokenParts([{token: '2::RED_HAIR::', index: 7}]);
    assert.equal(projectMarker(h.controller.groupParts('char-ccp3', redHair, 2)).name, '앞면 캐릭터 3');
    h.setLink(link({side: 'back'}));
    assert.deepEqual(h.controller.groupParts('char-ccp3', redHair, 2), redHair);
    h.enqueue(success(settings({
        front: {...prompt('unused base recipe', 'unused negative recipe'), charPrompts: frontRecipes},
        back: {...prompt('back base recipe', ''), charPrompts: ['silver hair']},
    })));
    await h.controller.refresh();
    assert.equal(projectMarker(h.controller.groupParts('char-ccp3', tokenParts(['silver hair']), 0)).name,
        '뒷면 캐릭터 1');
    assert.deepEqual(h.controller.groupParts('char-ccp3', redHair, 0), redHair);
});

test('character expand state is ordinal based, independent, and restored with legacy snapshots intact', async () => {
    const h = harness();
    h.enqueue(success(settings({front: {...prompt(), charPrompts: ['blue eyes, blue eyes', '', 'red hair']}})));
    await h.controller.refresh();
    const parts = tokenParts(['blue eyes', 'blue eyes']);
    h.controller.toggleExpanded('char-ccp900', 0);
    assert.deepEqual(h.controller.snapshot().expanded.characters, [true, false, false]);
    const expanded = h.controller.groupParts('char-ccp900', parts, 0);
    assert.equal(projectMarker(expanded).expanded, true);
    assert.deepEqual(expanded.filter(part => part.type === 'token').map(part => part.token), ['blue eyes', 'blue eyes']);
    const other = projectMarker(h.controller.groupParts('char-ccp77', tokenParts(['red hair']), 2));
    assert.equal(other.expanded, false);
    h.controller.toggleExpanded('char-ccp77', 2);
    assert.deepEqual(h.controller.snapshot().expanded.characters, [true, false, true]);
    const saved = h.controller.snapshot();
    saved.expanded.characters[0] = false;
    assert.deepEqual(h.controller.snapshot().expanded.characters, [true, false, true]);
    h.controller.restore(h.controller.snapshot());
    assert.deepEqual(h.controller.snapshot().expanded.characters, [true, false, true]);
    assert.equal(projectMarker(h.controller.groupParts('char-ccp77', tokenParts(['red hair']), 2)).expanded, true);

    const legacy = harness();
    legacy.enqueue(success(settings({front: prompt('legacy base', 'legacy negative')})));
    await legacy.controller.refresh();
    assert.deepEqual(legacy.controller.snapshot().prompt, prompt('legacy base', 'legacy negative'));
    assert.deepEqual(legacy.controller.snapshot().expanded, {base: false, negative: false});
    legacy.controller.restore({...legacy.controller.snapshot(), expanded: {base: true, negative: false}});
    assert.deepEqual(legacy.controller.snapshot().expanded, {base: true, negative: false});
});

test('character grouping rejects invalid ordinals and expansion resets when character recipes change', async () => {
    const h = harness();
    h.enqueue(success(settings({front: {...prompt(), charPrompts: ['blue eyes']}})));
    await h.controller.refresh();
    const parts = tokenParts(['blue eyes']);
    for (const index of [-1, 22, 1.5, null]) {
        assert.deepEqual(h.controller.groupParts('char-ccp1', parts, index), parts);
        h.controller.toggleExpanded('char-ccp1', index);
    }
    assert.deepEqual(h.controller.snapshot().expanded.characters, [false]);
    h.controller.toggleExpanded('char-ccp1', 0);
    h.enqueue(success(settings({revision: 2, front: {...prompt(), charPrompts: ['changed recipe']}})));
    await h.controller.refresh();
    assert.deepEqual(h.controller.snapshot().expanded.characters, [false]);
});

test('optional character prompt arrays retain an empty list and count as active when any recipe is nonempty', async () => {
    const empty = harness();
    empty.enqueue(success(settings({style: null, front: {...prompt(), charPrompts: []}, inpaint: null})));
    await empty.controller.refresh();
    assert.deepEqual(empty.controller.snapshot().prompt, {...prompt(), charPrompts: []});

    const active = harness();
    active.enqueue(success(settings({style: null, front: {...prompt(), charPrompts: ['', 'character recipe']}, inpaint: null})));
    await active.controller.refresh();
    assert.match(active.statusCalls.at(-1).message, /프로젝트 연동 적용됨/);
});

test('restore is detached, does not reapply an already restored revision, and accepts legacy empty state', async () => {
    const h = harness();
    h.enqueue(success(settings({front: prompt('restored base', 'restored negative')})));
    await h.controller.refresh();
    const persisted = h.controller.snapshot();
    const alteredCopy = h.controller.snapshot();
    alteredCopy.prompt.basePrompt = 'mutated external copy';
    alteredCopy.style.name = 'mutated external copy';
    alteredCopy.inpaintSettings.steps = 999;
    alteredCopy.expanded.base = true;
    assert.deepEqual(h.controller.snapshot(), persisted);

    h.controller.restore(persisted);
    const styleCount = h.styleCalls.length;
    const inpaintCount = h.inpaintCalls.length;
    const saveCount = h.saves;
    h.enqueue(success(settings({front: prompt('server changed at same revision', 'restored negative')})));
    await h.controller.refresh();
    assert.equal(h.styleCalls.length, styleCount);
    assert.equal(h.inpaintCalls.length, inpaintCount);
    assert.equal(h.saves, saveCount);
    assert.deepEqual(h.controller.snapshot(), persisted);

    h.controller.restore(null);
    assert.equal(h.controller.snapshot(), null);
    assert.deepEqual(h.controller.groupParts('base', tokenParts(['plain'])), tokenParts(['plain']));
    h.controller.restore({projectId: 'legacy-id', side: 'front', revision: 1});
    assert.equal(h.controller.snapshot(), null);
});

test('stale project, canvas, restored, canceled, and disconnected requests do not apply or report status', async () => {
    const h = harness();
    const oldRequest = deferred();
    h.enqueue(() => oldRequest.promise);
    const oldRun = h.controller.refresh();
    const oldSignal = h.requests[0].signal;

    h.setLink(link({projectId: OTHER_PROJECT_ID, canvasId: OTHER_CANVAS_ID, side: 'back'}));
    h.enqueue(success(settings({front: prompt('new project'), back: prompt('new project back')})));
    h.controller.linkChanged();
    await flush();
    assert.equal(oldSignal.aborted, true);
    oldRequest.resolve(success(settings({front: prompt('stale prompt')})));
    await oldRun;
    await flush();
    assert.equal(h.controller.snapshot().projectId, OTHER_PROJECT_ID);
    assert.equal(h.controller.snapshot().prompt.basePrompt, 'new project back');
    assert.equal(h.saves, 1);
    assert.equal(h.statusCalls.some(item => item.message.includes('stale prompt')), false);

    const saved = h.controller.snapshot();
    const restoreRequest = deferred();
    h.enqueue(() => restoreRequest.promise);
    const restoreRun = h.controller.refresh();
    h.controller.restore(saved);
    const statusCount = h.statusCalls.length;
    restoreRequest.resolve(success(settings({revision: 99, back: prompt('restored must win')})));
    await restoreRun;
    await flush();
    assert.deepEqual(h.controller.snapshot(), saved);
    assert.equal(h.saves, 1);
    assert.equal(h.statusCalls.length, statusCount);

    const cancelRequest = deferred();
    h.enqueue(() => cancelRequest.promise);
    const cancelRun = h.controller.refresh();
    h.controller.cancel();
    const cancelStatusCount = h.statusCalls.length;
    cancelRequest.resolve(success(settings({revision: 100, back: prompt('canceled must not apply')})));
    await cancelRun;
    await flush();
    assert.deepEqual(h.controller.snapshot(), saved);
    assert.equal(h.statusCalls.length, cancelStatusCount);

    const disconnectRequest = deferred();
    h.enqueue(() => disconnectRequest.promise);
    const disconnectRun = h.controller.refresh();
    h.setLink(null);
    h.controller.linkChanged();
    const disconnectStatusCount = h.statusCalls.length;
    disconnectRequest.resolve(success(settings({revision: 101, back: prompt('disconnected must not apply')})));
    await disconnectRun;
    await flush();
    assert.deepEqual(h.controller.snapshot(), saved);
    assert.equal(h.saves, 1);
    assert.equal(h.statusCalls.length, disconnectStatusCount);
});

test('concurrent refreshes deduplicate and a refresh during the request checks again afterward', async () => {
    const h = harness();
    const first = deferred();
    const second = deferred();
    h.enqueue(() => first.promise);
    h.enqueue(() => second.promise);
    const initialRun = h.controller.refresh();
    const duplicateRun = h.controller.refresh();
    assert.equal(h.requests.length, 1);

    first.resolve(success(settings({revision: 1, front: prompt('first response')})));
    await initialRun;
    await flush();
    assert.equal(h.requests.length, 2);
    second.resolve(success(settings({revision: 2, front: prompt('second response')})));
    await duplicateRun;
    await flush();
    assert.equal(h.controller.snapshot().revision, 2);
    assert.equal(h.controller.snapshot().prompt.basePrompt, 'second response');
    assert.equal(h.requests.length, 2);
});

test('failed loads preserve copied settings, hide prompt contents, and recover on the next refresh', async () => {
    const secretPrompt = 'synthetic private prompt phrase';
    const h = harness();
    h.enqueue(success(settings({front: prompt(secretPrompt, 'synthetic negative phrase')})));
    await h.controller.refresh();
    const before = h.controller.snapshot();
    const savesBefore = h.saves;

    h.enqueue(failure('temporary service error'));
    await h.controller.refresh();
    assert.deepEqual(h.controller.snapshot(), before);
    assert.equal(h.saves, savesBefore);
    const error = h.statusCalls.at(-1);
    assert.equal(error.state, 'error');
    assert.match(error.message, /temporary service error/);
    assert.equal(error.message.includes(secretPrompt), false);
    assert.equal(h.requests.at(-1).url.includes(secretPrompt), false);

    h.enqueue(success(settings({revision: 2, front: prompt('recovered recipe', '')})));
    await h.controller.refresh();
    assert.equal(h.controller.snapshot().revision, 2);
    assert.equal(h.controller.snapshot().prompt.basePrompt, 'recovered recipe');
    assert.equal(h.statusCalls.at(-1).state, 'saved');
});

test('deferred application leaves local edits untouched and applies after editors close', async () => {
    const h = harness();
    h.enqueue(success(settings({revision: 1, front: prompt('old recipe')})));
    await h.controller.refresh();
    const before = h.controller.snapshot();
    const styleCount = h.styleCalls.length;
    const inpaintCount = h.inpaintCalls.length;
    const saves = h.saves;
    const nextStyle = style({id: 'deferred-style'});
    const nextInpaint = inpaintSettings({steps: 40});
    h.setCanApply(false);
    h.enqueue(success(settings({revision: 2, style: nextStyle, inpaint: nextInpaint,
        front: prompt('new recipe')})));

    await h.controller.refresh();

    assert.deepEqual(h.controller.snapshot(), before);
    assert.equal(h.styleCalls.length, styleCount);
    assert.equal(h.inpaintCalls.length, inpaintCount);
    assert.equal(h.saves, saves);
    assert.equal(h.statusCalls.at(-1).state, 'waiting');
    assert.match(h.statusCalls.at(-1).message, /편집창을 닫으면/);

    h.setCanApply(true);
    h.enqueue(success(settings({revision: 2, style: nextStyle, inpaint: nextInpaint,
        front: prompt('new recipe')})));
    await h.controller.refresh();
    assert.equal(h.controller.snapshot().revision, 2);
    assert.deepEqual(h.styleCalls.at(-1), {mode: 'manual', style: nextStyle});
    assert.deepEqual(h.inpaintCalls.at(-1), nextInpaint);
    assert.equal(h.saves, saves + 1);
});

test('removed project style clears the copied style, missing inpaint retains local values, and disconnect keeps copied groups', async () => {
    const h = harness();
    const initialInpaint = inpaintSettings();
    h.enqueue(success(settings({revision: 1, front: prompt('project recipe', ''), inpaint: initialInpaint})));
    await h.controller.refresh();
    const styleCount = h.styleCalls.length;
    const inpaintCount = h.inpaintCalls.length;
    const removed = settings({revision: 2, style: null, inpaint: null, front: prompt('project recipe', '')});
    h.enqueue(success(removed));
    await h.controller.refresh();

    assert.deepEqual(h.styleCalls.at(-1), {mode: 'off', style: null});
    assert.equal(h.styleCalls.length, styleCount + 1);
    assert.equal(h.inpaintCalls.length, inpaintCount);
    assert.deepEqual(h.controller.snapshot().inpaintSettings, null);
    assert.equal(projectMarker(h.controller.groupParts('base', tokenParts(['project recipe'])))?.name,
        '앞면 프롬프트');
    const requestCount = h.requests.length;
    h.setLink(null);
    h.controller.linkChanged();
    assert.equal(h.requests.length, requestCount);
    assert.equal(h.statusCalls.at(-1).state, 'idle');
    assert.equal(projectMarker(h.controller.groupParts('base', tokenParts(['project recipe'])))?.name,
        '앞면 프롬프트');
});

test('invalid settings responses preserve prior state and surface an error', async () => {
    const h = harness();
    h.enqueue(success(settings({front: prompt('safe previous state')})));
    await h.controller.refresh();
    const before = h.controller.snapshot();
    const saves = h.saves;
    h.enqueue(response({status: 'success', settings: {revision: 2, style: null, prompts: {front: prompt('bad')}}}));

    await h.controller.refresh();

    assert.deepEqual(h.controller.snapshot(), before);
    assert.equal(h.saves, saves);
    assert.equal(h.statusCalls.at(-1).state, 'error');
    assert.match(h.statusCalls.at(-1).message, /형식이 올바르지 않습니다/);
});

test('a newly linked project side does not display the previously copied side group', async () => {
    const h = harness();
    h.enqueue(success(settings({front: prompt('front-only recipe'), back: prompt('back-only recipe')})));
    await h.controller.refresh();
    const parts = tokenParts(['front-only recipe']);
    assert.ok(projectMarker(h.controller.groupParts('base', parts)));

    h.setLink(link({side: 'back'}));
    assert.deepEqual(h.controller.groupParts('base', parts), parts);
    h.enqueue(success(settings({front: prompt('front-only recipe'), back: prompt('back-only recipe')})));
    await h.controller.refresh();
    assert.equal(projectMarker(h.controller.groupParts('base', tokenParts(['front-only recipe']))), undefined);
    assert.ok(projectMarker(h.controller.groupParts('base', tokenParts(['back-only recipe']))));
});
