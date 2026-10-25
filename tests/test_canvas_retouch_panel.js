'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const RetouchState = require('../static/canvas_retouch_state.js');

class FakeClassList {
    constructor(owner) { this.owner = owner; this.values = new Set(); }
    add(value) { this.values.add(value); this.sync(); }
    remove(value) { this.values.delete(value); this.sync(); }
    contains(value) { return this.values.has(value); }
    toggle(value, force) {
        const enabled = force === undefined ? !this.contains(value) : Boolean(force);
        if (enabled) this.values.add(value); else this.values.delete(value);
        this.sync();
        return enabled;
    }
    sync() { this.owner._className = Array.from(this.values).join(' '); }
}

class FakeElement {
    constructor(tagName, ownerDocument) {
        this.tagName = String(tagName).toUpperCase();
        this.ownerDocument = ownerDocument;
        this.children = [];
        this.parentNode = null;
        this.dataset = {};
        this.attributes = new Map();
        this.classList = new FakeClassList(this);
        this.listeners = new Map();
        this.value = '';
        this.checked = false;
        this.disabled = false;
        this.hidden = false;
        this.open = false;
        this._textContent = '';
        this._className = '';
    }
    set className(value) {
        this._className = String(value || '');
        this.classList.values = new Set(this._className.split(/\s+/).filter(Boolean));
    }
    get className() { return this._className; }
    set textContent(value) {
        for (const child of this.children) child.parentNode = null;
        this.children = [];
        this._textContent = String(value ?? '');
    }
    get textContent() { return this._textContent + this.children.map(child => child.textContent).join(''); }
    get options() { return this.tagName === 'SELECT' ? this.children.filter(child => child.tagName === 'OPTION') : undefined; }
    append(...nodes) {
        for (const node of nodes) {
            if (node.parentNode) node.parentNode.removeChild(node);
            this.children.push(node);
            node.parentNode = this;
        }
    }
    appendChild(node) { this.append(node); return node; }
    replaceChildren(...nodes) {
        for (const child of this.children) child.parentNode = null;
        this.children = [];
        this._textContent = '';
        this.append(...nodes);
    }
    removeChild(node) {
        const index = this.children.indexOf(node);
        if (index >= 0) this.children.splice(index, 1);
        node.parentNode = null;
        return node;
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(name, callback) {
        if (!this.listeners.has(name)) this.listeners.set(name, []);
        this.listeners.get(name).push(callback);
    }
    dispatch(name, extra = {}) {
        const event = {target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...extra};
        for (const callback of this.listeners.get(name) || []) callback(event);
        return event;
    }
}

class FakeDocument {
    constructor() { this.body = new FakeElement('body', this); this.activeElement = null; }
    createElement(tagName) { return new FakeElement(tagName, this); }
}

function find(root, predicate) {
    if (predicate(root)) return root;
    for (const child of root.children) {
        const match = find(child, predicate);
        if (match) return match;
    }
    return null;
}

function byClass(root, className) {
    const match = find(root, item => item.classList?.contains(className));
    assert.ok(match, `missing .${className}`);
    return match;
}

function byLabel(root, label) {
    const match = find(root, item => item.getAttribute?.('aria-label') === label);
    assert.ok(match, `missing [aria-label="${label}"]`);
    return match;
}

function createHarness() {
    const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas_retouch_panel.js'), 'utf8');
    const document = new FakeDocument();
    const host = document.createElement('div');
    host.id = 'canvasRetouchPanel';
    document.body.append(host);
    const context = {document, CanvasRetouchState: RetouchState, Math};
    context.window = context;
    vm.runInNewContext(source, context, {filename: 'canvas_retouch_panel.js'});
    const calls = [];
    const names = ['add', 'recipe', 'preset', 'select', 'toggle', 'move', 'duplicate', 'remove', 'change', 'mask', 'setTool', 'brush', 'undo', 'redo', 'compare', 'compareSplit', 'guides', 'maskShow', 'print', 'copy', 'paste', 'notes', 'check', 'apply', 'close', 'download', 'downloadPair'];
    const actions = Object.fromEntries(names.map(name => [name, (...args) => calls.push([name, ...args])]));
    const panel = context.CanvasRetouchPanel.create(host, actions);
    return {document, host, panel, calls, root: host.children[0]};
}

function view({layers = [], selectedId = null, busy = false, extra = {}} = {}) {
    return {
        doc: {layers, print: {widthCm: 50, heightCm: 160, safeMm: 5}, notes: '', checks: [], width: 512, height: 1024, name: '합성본'},
        selectedId, tool: 'hand', brush: {size: 160, flow: 10, hardness: 30, color: '#e6baa4'},
        canUndo: true, canRedo: false, compare: false, compareSplit: 50, guides: true,
        maskShow: false, busy, message: '', error: '', hasCopy: false, downloadSrc: '', otherAvailable: false,
        ...extra,
    };
}

test('panel starts with loading state and forwards add, recipe, and close actions', () => {
    const h = createHarness();
    assert.equal(byClass(h.root, 'canvas-retouch-loading').hidden, false);
    assert.equal(h.root.getAttribute('aria-label'), '캔버스 보정');
    const presets = byClass(h.root, 'canvas-retouch-preset-section');
    assert.equal(byLabel(presets, '전체 분위기 프리셋 보기').disabled, true);
    assert.equal(byLabel(presets, '내추럴 프리셋 선택').disabled, true);
    assert.equal(byLabel(presets, '프리셋 강도 기본').disabled, true);
    assert.equal(byLabel(presets, '선택한 프리셋 추가').disabled, true);
    h.panel.update(view());

    const quick = byClass(h.root, 'canvas-retouch-quick');
    assert.equal(quick.children[0].textContent, '8단계 골라 추가 · 설정 복사');
    assert.equal(byLabel(quick, '선택한 8단계 보정 추가').textContent, '선택한 8단계 추가');
    assert.match(quick.textContent, /원하는 단계만 골라 추가하세요/);
    assert.match(quick.textContent, /칠한 곳만.*추가한 뒤.*칠해야 적용됩니다/);
    assert.equal(byClass(quick, 'canvas-retouch-recipe-options').children.length, 8);

    const select = byLabel(h.root, '새 보정 레이어 종류');
    select.value = 'tone';
    byLabel(h.root, '보정 레이어 추가').dispatch('click');
    byLabel(quick, '선택한 8단계 보정 추가').dispatch('click');
    byLabel(h.root, '캔버스 보정 닫기').dispatch('click');

    assert.deepEqual(h.calls, [
        ['add', 'tone'],
        ['recipe', ['skin-tone', 'warm-color', 'tone', 'beige', 'line', 'blush', 'texture', 'sharpen']],
        ['close']
    ]);
});

test('eight-step recipe selection stays local, follows capacity, and forwards ids in recipe order', () => {
    const h = createHarness();
    h.panel.update(view());
    const quick = byClass(h.root, 'canvas-retouch-quick');
    const options = byClass(quick, 'canvas-retouch-recipe-options');
    const recipeButton = byLabel(quick, '선택한 8단계 보정 추가');
    const selectAll = byLabel(quick, '8단계 모두 선택');
    const clearAll = byLabel(quick, '8단계 모두 해제');
    const capacity = byClass(quick, 'canvas-retouch-recipe-capacity');
    const labels = [
        '1. 피부 톤 통일 · 칠한 곳만', '2. 따뜻한 색감 · 전체', '3. 밝기 +2 · 대비 −3 · 전체',
        '4. 부드러운 베이지 막 · 전체', '5. 중요한 선 정리 · 칠한 곳만', '6. 홍조 정리 · 칠한 곳만',
        '7. 펄린 미세 질감 · 전체', '8. 마지막 선택적 샤프닝 · 칠한 곳만'
    ];
    assert.deepEqual(options.children.map(option => option.children[1].textContent), labels);
    assert.ok(options.children.every(option => option.children[0].checked));
    assert.equal(recipeButton.textContent, '선택한 8단계 추가');

    selectAll.dispatch('click');
    assert.equal(h.calls.length, 0, 'selecting steps does not call the controller');
    const tone = byLabel(options, labels[2]);
    const sharpen = byLabel(options, labels[7]);
    tone.checked = false;
    tone.dispatch('change');
    assert.equal(recipeButton.textContent, '선택한 7단계 추가');
    h.panel.update(view());
    assert.equal(tone.checked, false, 'panel updates preserve the local selection');
    clearAll.dispatch('click');
    assert.ok(options.children.every(option => !option.children[0].checked));
    assert.equal(recipeButton.textContent, '선택한 0단계 추가');
    assert.equal(recipeButton.disabled, true);
    recipeButton.dispatch('click');
    assert.equal(h.calls.length, 0);

    sharpen.checked = true;
    sharpen.dispatch('change');
    tone.checked = true;
    tone.dispatch('change');
    assert.equal(recipeButton.textContent, '선택한 2단계 추가');
    assert.equal(recipeButton.getAttribute('aria-label'), '선택한 2단계 보정 추가');
    assert.match(capacity.textContent, /선택한 단계 2\/8/);
    assert.equal(recipeButton.disabled, false);

    const makeLayers = count => Array.from({length: count}, (_, index) => RetouchState.createLayer('tone', () => `layer-${index}`));
    h.panel.update(view({layers: makeLayers(38)}));
    assert.equal(recipeButton.disabled, false, '38 existing layers plus 2 selected steps fit the limit');
    h.panel.update(view({layers: makeLayers(39)}));
    assert.equal(recipeButton.disabled, true);
    assert.match(capacity.textContent, /현재 선택한 단계를 모두 추가할 공간이 부족합니다/);
    h.panel.update(view({layers: makeLayers(38), busy: true}));
    assert.equal(recipeButton.disabled, true);
    assert.equal(selectAll.disabled, true);
    assert.equal(clearAll.disabled, true);
    assert.ok(options.children.every(option => option.children[0].disabled));
    assert.ok(tone.checked && sharpen.checked, 'busy updates preserve the local selection');

    h.panel.update(view({layers: makeLayers(38)}));
    assert.equal(recipeButton.disabled, false);
    assert.ok(tone.checked && sharpen.checked);
    recipeButton.dispatch('click');
    assert.deepEqual(h.calls, [['recipe', ['tone', 'sharpen']]]);

    clearAll.dispatch('click');
    tone.checked = true;
    tone.dispatch('change');
    h.panel.update(view({layers: makeLayers(39)}));
    assert.equal(recipeButton.disabled, false, '39 existing layers plus one selected step reaches the limit');
    h.panel.update(view({layers: makeLayers(40)}));
    assert.equal(recipeButton.disabled, true);
    assert.match(capacity.textContent, /선택한 단계 1\/8 · 보정 레이어 40\/40/);
    h.panel.update(view({layers: makeLayers(39)}));
    recipeButton.dispatch('click');
    assert.deepEqual(h.calls, [['recipe', ['tone', 'sharpen']], ['recipe', ['tone']]]);

    h.panel.update({doc: null, busy: false});
    assert.equal(recipeButton.disabled, true);
    assert.equal(selectAll.disabled, true);
    assert.equal(clearAll.disabled, true);
    assert.ok(options.children.every(option => option.children[0].disabled));
    assert.equal(tone.checked, true);
    assert.equal(sharpen.checked, false);
});

test('preset categories and cards select locally without applying, then add with the chosen strength', () => {
    const h = createHarness();
    h.panel.update(view());
    const section = byClass(h.root, 'canvas-retouch-preset-section');
    const globalGroup = RetouchState.PRESET_GROUPS.find(group => group.id === 'global');
    const skinGroup = RetouchState.PRESET_GROUPS.find(group => group.id === 'skin');
    const natural = RetouchState.PRESETS.find(preset => preset.id === 'natural');
    const skinPresets = RetouchState.PRESETS.filter(preset => preset.group === 'skin');
    assert.ok(globalGroup && skinGroup && natural && skinPresets.length);

    const globalCategory = byLabel(section, `${globalGroup.label} 프리셋 보기`);
    assert.equal(globalCategory.getAttribute('aria-pressed'), 'true');
    const naturalCard = byLabel(section, `${natural.label} 프리셋 선택`);
    assert.equal(naturalCard.getAttribute('aria-pressed'), 'true');
    const presetHints = section.children.filter(child => child.classList.contains('canvas-retouch-hint'));
    assert.equal(naturalCard.children[1].textContent, `전체 · ${natural.layerCount}개 레이어`);
    assert.equal(presetHints[0].textContent, natural.hint);
    assert.equal(presetHints[1].textContent, '이미지 전체에 적용됩니다. 추가 후 각 레이어에서 강도를 조절할 수 있어요.');

    byLabel(section, `${skinGroup.label} 프리셋 보기`).dispatch('click');
    assert.equal(globalCategory.getAttribute('aria-pressed'), 'false');
    assert.equal(byLabel(section, `${skinGroup.label} 프리셋 보기`).getAttribute('aria-pressed'), 'true');
    const firstSkinCard = byLabel(section, `${skinPresets[0].label} 프리셋 선택`);
    assert.equal(firstSkinCard.getAttribute('aria-pressed'), 'true');
    assert.equal(firstSkinCard.children[1].textContent, '칠한 곳만');
    assert.equal(presetHints[1].textContent, '추가한 뒤 원하는 곳에 에어브러시로 칠하세요. 칠하지 않은 머리·옷은 그대로 유지됩니다.');
    assert.deepEqual(h.calls, []);

    const chosenPreset = skinPresets.at(-1);
    byLabel(section, `${chosenPreset.label} 프리셋 선택`).dispatch('click');
    assert.equal(byLabel(section, `${chosenPreset.label} 프리셋 선택`).getAttribute('aria-pressed'), 'true');
    assert.deepEqual(h.calls, []);
    const strength = byLabel(section, '프리셋 강도 또렷하게');
    strength.dispatch('click');
    assert.equal(strength.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(h.calls, []);
    byLabel(section, '선택한 프리셋 추가').dispatch('click');
    assert.deepEqual(h.calls, [['preset', chosenPreset.id, 1.5]]);

    h.panel.update(view());
    assert.equal(byLabel(section, `${chosenPreset.label} 프리셋 선택`).getAttribute('aria-pressed'), 'true');
    assert.equal(byLabel(section, '프리셋 강도 또렷하게').getAttribute('aria-pressed'), 'true');

    h.panel.update(view({busy: true}));
    assert.equal(byLabel(section, `${globalGroup.label} 프리셋 보기`).disabled, true);
    assert.equal(byLabel(section, `${chosenPreset.label} 프리셋 선택`).disabled, true);
    assert.equal(byLabel(section, '프리셋 강도 기본').disabled, true);
    assert.equal(byLabel(section, '선택한 프리셋 추가').disabled, true);
    h.panel.update({doc: null, busy: false});
    assert.equal(byLabel(section, `${globalGroup.label} 프리셋 보기`).disabled, true);
    assert.equal(byLabel(section, `${chosenPreset.label} 프리셋 선택`).disabled, true);
    assert.equal(byLabel(section, '프리셋 강도 기본').disabled, true);
    assert.equal(byLabel(section, '선택한 프리셋 추가').disabled, true);
});

test('preset capacity accounts for the selected preset layer count', () => {
    const h = createHarness();
    const natural = RetouchState.PRESETS.find(preset => preset.id === 'natural');
    const needed = natural.layerCount;
    const makeLayers = count => Array.from({length: count}, (_, index) => RetouchState.createLayer('tone', () => `layer-${index}`));
    h.panel.update(view({layers: makeLayers(40 - needed)}));
    const section = byClass(h.root, 'canvas-retouch-preset-section');
    assert.equal(byLabel(section, '선택한 프리셋 추가').disabled, false);

    const tooMany = 41 - needed;
    h.panel.update(view({layers: makeLayers(tooMany)}));
    assert.equal(byLabel(section, '선택한 프리셋 추가').disabled, true);
    const capacity = byClass(section, 'canvas-retouch-capacity');
    assert.equal(capacity.hidden, false);
    assert.equal(capacity.textContent, `보정 레이어가 ${needed}개 필요해요. (현재 ${tooMany}/40)`);
});

test('brush defaults match the retouch studio and empty layers show the requested guidance', () => {
    const h = createHarness();
    h.panel.update(view({extra: {brush: undefined}}));

    assert.equal(byLabel(h.root, '크기').value, '160');
    assert.equal(byLabel(h.root, '불투명도').value, '10');
    assert.equal(byLabel(h.root, '경계 선명도').value, '30');
    assert.equal(byLabel(h.root, '브러시 칠할 색').value, '#e6baa4');
    assert.equal(byClass(h.root, 'canvas-retouch-empty').textContent, '보정 레이어를 추가하세요.');
});

test('tool buttons show compact labels while keeping full accessible names and titles', () => {
    const h = createHarness();
    h.panel.update(view());
    const expected = [
        ['화면 이동 · Space', '이동'],
        ['부분 브러시 (B)', '브러시'],
        ['부드러운 지우개 (E)', '지우개'],
        ['에어브러시 · 직접 칠하기 (A)', '에어브러시'],
        ['원본 복제 · Alt+클릭', '복제'],
        ['픽셀 유동화 (L)', '유동화'],
        ['스포이드 (I)', '스포이드'],
        ['사각 영역 선택', '사각형'],
        ['타원 영역 선택', '타원'],
        ['원본 픽셀 검사', '픽셀 검사'],
    ];
    for (const [fullLabel, shortLabel] of expected) {
        const control = byLabel(h.root, fullLabel);
        assert.equal(control.textContent, shortLabel);
        assert.equal(control.title, fullLabel);
    }
});

test('layer settings, mask tools, print, review, and text controls forward the view contract', () => {
    const h = createHarness();
    const layer = RetouchState.createLayer('tone', () => 'tone-1');
    h.panel.update(view({layers: [layer], selectedId: layer.id, extra: {otherAvailable: true, hasCopy: true}}));

    const brightness = byLabel(h.root, '밝기');
    brightness.value = '12';
    brightness.dispatch('input');
    const vibrance = byLabel(h.root, '생기');
    vibrance.value = '18';
    vibrance.dispatch('input');
    byLabel(h.root, '칠한 곳만').dispatch('click');
    byLabel(h.root, '레이어 설정에서 보정 지우개 도구 선택').dispatch('click');
    const size = byLabel(h.root, '크기');
    size.value = '220'; size.dispatch('input');
    const check = byLabel(h.root, RetouchState.CHECKS[0]);
    check.checked = true; check.dispatch('change');
    const notes = byLabel(h.root, '마무리 메모');
    notes.value = '긴 메모'; notes.dispatch('input');
    byLabel(h.root, '제품 가로 (cm)').value = '60';
    byLabel(h.root, '제품 가로 (cm)').dispatch('change');
    byLabel(h.root, '반대쪽 면까지 양면 ZIP 다운로드').dispatch('click');

    assert.ok(h.calls.some(call => call[0] === 'change' && call[1].params.brightness === 12));
    assert.ok(h.calls.some(call => call[0] === 'change' && call[1].params.vibrance === 18));
    assert.ok(h.calls.some(call => call[0] === 'mask' && call[1] === 'painted'));
    assert.ok(h.calls.some(call => call[0] === 'setTool' && call[1] === 'maskErase'));
    assert.ok(h.calls.some(call => call[0] === 'brush' && call[1] === 'size' && call[2] === 220));
    assert.ok(h.calls.some(call => call[0] === 'check' && call[1] === 0 && call[2] === true));
    assert.ok(h.calls.some(call => call[0] === 'notes' && call[1] === '긴 메모'));
    assert.ok(h.calls.some(call => call[0] === 'print' && call[1] === 'widthCm' && call[2] === 60));
    assert.ok(h.calls.some(call => call[0] === 'downloadPair'));
});

test('airbrush exposes flow and per-stroke opacity while legacy paint keeps its opacity label', () => {
    const h = createHarness();
    h.panel.update(view({extra: {tool: 'airbrush', brush: {size: 160, flow: 4, opacity: 100, hardness: 0, color: '#e47789'}}}));
    const airbrush = byLabel(h.root, '에어브러시 · 직접 칠하기 (A)');
    assert.equal(airbrush.textContent, '에어브러시');
    assert.equal(byLabel(h.root, '분사량').value, '4');
    const opacity = byLabel(h.root, '한 획 최대 농도');
    assert.equal(opacity.parentNode.hidden, false);
    opacity.value = '75';
    opacity.dispatch('input');
    assert.ok(h.calls.some(call => call[0] === 'brush' && call[1] === 'opacity' && call[2] === 75));
    assert.equal(byClass(h.root, 'canvas-retouch-tool-section').children.at(-1).textContent,
        '색을 직접 분사합니다. 누르고 있거나 여러 번 지나가면 진해집니다. 혼합 모드·분사량으로 강도를 조절하세요.');

    h.panel.update(view({extra: {tool: 'paint'}}));
    assert.equal(byLabel(h.root, '불투명도').value, '10');
    assert.equal(byLabel(h.root, '한 획 최대 농도').parentNode.hidden, true);
    assert.equal(byClass(h.root, 'canvas-retouch-tool-section').children.at(-1).textContent,
        '선택한 보정의 적용 영역을 칠합니다. 색을 직접 칠하려면 에어브러시를 선택하세요.');

    const paintLayer = RetouchState.createLayer('paint', () => 'paint-layer');
    h.panel.update(view({layers: [paintLayer], selectedId: paintLayer.id, extra: {tool: 'paint'}}));
    assert.equal(byClass(h.root, 'canvas-retouch-tool-section').children.at(-1).textContent, '색을 직접 칠합니다.');
});

test('eraser controls explain soft edges, hide paint color, and keep layer actions accessible', () => {
    const h = createHarness();
    const layer = RetouchState.createLayer('tone', () => 'tone-1');
    h.panel.update(view({layers: [layer], selectedId: layer.id}));

    const erase = byLabel(h.root, '선택한 보정의 보정 지우개 선택');
    const restore = byLabel(h.root, '선택한 보정에서 지운 곳 복원 도구 선택');
    assert.equal(erase.textContent, '보정 지우개');
    assert.equal(restore.textContent, '지운 곳 복원');
    assert.equal(erase.disabled, false);
    assert.equal(restore.disabled, false);
    erase.dispatch('click');
    restore.dispatch('click');
    assert.ok(h.calls.some(call => call[0] === 'setTool' && call[1] === 'maskErase'));
    assert.ok(h.calls.some(call => call[0] === 'setTool' && call[1] === 'maskAdd'));

    h.panel.update(view({layers: [layer], selectedId: layer.id, extra: {
        tool: 'maskErase', brush: {size: 220, flow: 35, opacity: 100, hardness: 0, color: '#e6baa4'},
    }}));
    assert.equal(erase.getAttribute('aria-pressed'), 'true');
    assert.equal(restore.getAttribute('aria-pressed'), 'false');
    assert.equal(erase.classList.contains('is-active'), true);
    assert.equal(byLabel(h.root, '부드러운 지우개 (E)').getAttribute('aria-pressed'), 'true');
    assert.equal(byClass(h.root, 'canvas-retouch-brush').children[0].textContent, '지우개');
    assert.equal(byLabel(h.root, '지우는 강도').value, '35');
    assert.equal(byLabel(h.root, '경계 선명도').value, '0');
    assert.equal(byLabel(h.root, '브러시 칠할 색').parentNode.hidden, true);
    assert.equal(byClass(h.root, 'canvas-retouch-tool-section').children.at(-1).textContent,
        '선택한 보정만 지웁니다. 경계 선명도 0%는 부드럽게, 100%는 또렷하게 지웁니다.');

    h.panel.update(view({layers: [layer], selectedId: null}));
    assert.equal(erase.disabled, true);
    assert.equal(restore.disabled, true);
    h.panel.update(view({layers: [layer], selectedId: layer.id, busy: true}));
    assert.equal(erase.disabled, true);
    assert.equal(restore.disabled, true);
});

test('color blend options describe skin-safe modes and add multiply and screen', () => {
    const h = createHarness();
    const layer = RetouchState.createLayer('color', () => 'color-layer');
    h.panel.update(view({layers: [layer], selectedId: layer.id}));
    const mode = byLabel(h.root, '합성 모드');
    assert.deepEqual(mode.options.map(option => [option.value, option.textContent]), [
        ['normal', '일반 · 색 덮기'], ['color', '색상 · 음영 유지'],
        ['soft-light', '소프트 라이트 · 빛과 색'], ['multiply', '곱하기 · 음영'], ['screen', '스크린 · 밝은 빛']
    ]);
    mode.value = 'multiply';
    mode.dispatch('change');
    assert.ok(h.calls.some(call => call[0] === 'change' && call[1].params.mode === 'multiply'));
    assert.match(byClass(h.root, 'canvas-retouch-settings').textContent, /색상 모드는 원본 밝기와 음영을 유지합니다/);
});

test('busy state locks mutation and export while keeping close and view controls available', () => {
    const h = createHarness();
    const layer = RetouchState.createLayer('color', () => 'color-1');
    h.panel.update(view({layers: [layer], selectedId: layer.id, busy: true, extra: {otherAvailable: true}}));

    assert.equal(byLabel(h.root, '보정 결과 적용').disabled, true);
    assert.equal(byLabel(h.root, '인쇄 PNG 다운로드').disabled, true);
    assert.equal(byLabel(h.root, '반대쪽 면까지 양면 ZIP 다운로드').disabled, true);
    assert.equal(byLabel(h.root, '레이어 이름').disabled, true);
    assert.equal(byLabel(h.root, '전후 비교').disabled, false);
    byLabel(h.root, '캔버스 보정 닫기').dispatch('click');
    assert.equal(h.calls.at(-1)[0], 'close');
});

test('controller updates preserve the active setting input and panel scroll position', () => {
    const h = createHarness();
    const layer = RetouchState.createLayer('tone', () => 'tone-1');
    h.panel.update(view({layers: [layer], selectedId: layer.id}));
    const brightness = byLabel(h.root, '밝기');
    brightness.value = '17';
    h.document.activeElement = brightness;
    byClass(h.root, 'canvas-retouch-body').scrollTop = 123;

    h.panel.update(view({layers: [{...layer, params: {...layer.params, brightness: 2}}], selectedId: layer.id}));

    assert.equal(byLabel(h.root, '밝기'), brightness);
    assert.equal(brightness.value, '17');
    assert.equal(byClass(h.root, 'canvas-retouch-body').scrollTop, 123);
});

test('layer ordering, selection, visibility, compare, guides, and footer actions reach the controller', () => {
    const h = createHarness();
    const bottom = RetouchState.createLayer('tone', () => 'bottom');
    const top = RetouchState.createLayer('color', () => 'top');
    h.panel.update(view({layers: [bottom, top], selectedId: 'bottom', extra: {canRedo: true, hasCopy: true}}));

    byLabel(h.root, '밝기 · 채도 · 명암 레이어 선택').dispatch('click');
    byLabel(h.root, '색 덧입히기 표시 전환').dispatch('click');
    byLabel(h.root, '선택한 레이어 위로 이동').dispatch('click');
    byLabel(h.root, '선택한 레이어 아래로 이동').dispatch('click');
    byLabel(h.root, '선택한 레이어 복제').dispatch('click');
    byLabel(h.root, '선택한 레이어 삭제').dispatch('click');
    byLabel(h.root, '현재 보정 설정 복사').dispatch('click');
    byLabel(h.root, '복사한 보정 설정 붙여넣기').dispatch('click');
    byLabel(h.root, '다시 실행').dispatch('click');
    const compare = byLabel(h.root, '전후 비교'); compare.checked = true; compare.dispatch('change');
    const split = byLabel(h.root, '전후 비교 위치'); split.value = '65'; split.dispatch('input');
    const guides = byLabel(h.root, '재단 가이드 표시'); guides.checked = false; guides.dispatch('change');
    byLabel(h.root, '마스크 표시 전환').dispatch('click');
    byLabel(h.root, '보정 결과 적용').dispatch('click');
    byLabel(h.root, '인쇄 PNG 다운로드').dispatch('click');

    assert.ok(h.calls.some(call => call[0] === 'select' && call[1] === 'bottom' && call[2].shiftKey === false));
    assert.ok(h.calls.some(call => call[0] === 'toggle' && call[1] === 'top'));
    assert.ok(h.calls.some(call => call[0] === 'move' && call[1] === 1));
    assert.ok(h.calls.some(call => call[0] === 'move' && call[1] === -1));
    assert.ok(h.calls.some(call => call[0] === 'duplicate'));
    assert.ok(h.calls.some(call => call[0] === 'remove'));
    assert.ok(h.calls.some(call => call[0] === 'copy'));
    assert.ok(h.calls.some(call => call[0] === 'paste'));
    assert.ok(h.calls.some(call => call[0] === 'redo'));
    assert.ok(h.calls.some(call => call[0] === 'compare' && call[1] === true));
    assert.ok(h.calls.some(call => call[0] === 'compareSplit' && call[1] === 65));
    assert.ok(h.calls.some(call => call[0] === 'guides' && call[1] === false));
    assert.ok(h.calls.some(call => call[0] === 'maskShow' && call[1] === true));
    assert.ok(h.calls.some(call => call[0] === 'apply'));
    assert.ok(h.calls.some(call => call[0] === 'download'));
});

test('layer selection supports Shift multi-select, active-layer distinction, fallback, and busy state', () => {
    const h = createHarness();
    const first = RetouchState.createLayer('tone', () => 'first');
    const second = RetouchState.createLayer('color', () => 'second');
    const third = RetouchState.createLayer('sharpen', () => 'third');
    const layers = [first, second, third];
    h.panel.update(view({layers, selectedId: 'second', extra: {selectedIds: ['first', 'second'], tool: 'maskErase'}}));

    const list = byClass(h.root, 'canvas-retouch-layer-list');
    const rowFor = id => find(list, item => item.dataset?.layerId === id);
    const firstRow = rowFor('first');
    const secondRow = rowFor('second');
    const thirdRow = rowFor('third');
    assert.equal(firstRow.classList.contains('is-selected'), true);
    assert.equal(secondRow.classList.contains('is-selected'), true);
    assert.equal(secondRow.classList.contains('is-active'), true);
    assert.equal(firstRow.classList.contains('is-active'), false);
    assert.equal(thirdRow.classList.contains('is-selected'), false);
    const selectFor = id => rowFor(id).children[1];
    assert.equal(selectFor('first').getAttribute('aria-pressed'), 'true');
    assert.equal(selectFor('third').getAttribute('aria-pressed'), 'false');

    const hint = byClass(byClass(h.root, 'canvas-retouch-layer-section'), 'canvas-retouch-selection-hint');
    assert.equal(hint.textContent, '보정 2개 선택 · 지우개는 모두에 적용됩니다. 다른 조작은 마지막으로 선택한 보정에 적용됩니다.');
    assert.equal(byClass(h.root, 'canvas-retouch-tool-section').children.at(-1).textContent,
        '선택한 보정 2개만 지웁니다. 경계 선명도 0%는 부드럽게, 100%는 또렷하게 지웁니다.');

    list.scrollTop = 87;
    selectFor('third').dispatch('click', {shiftKey: true});
    assert.equal(h.calls.at(-1)[0], 'select');
    assert.equal(h.calls.at(-1)[1], 'third');
    assert.equal(h.calls.at(-1)[2].shiftKey, true);
    h.panel.update(view({layers, selectedId: 'third', extra: {selectedIds: ['first', 'third'], tool: 'maskErase'}}));
    assert.equal(list.scrollTop, 87, 'selection updates preserve the layer-list scroll position');
    assert.equal(rowFor('first').classList.contains('is-selected'), true);
    assert.equal(rowFor('second').classList.contains('is-selected'), false);
    assert.equal(rowFor('third').classList.contains('is-active'), true);

    selectFor('second').dispatch('click', {shiftKey: false});
    assert.equal(h.calls.at(-1)[0], 'select');
    assert.equal(h.calls.at(-1)[1], 'second');
    assert.equal(h.calls.at(-1)[2].shiftKey, false);

    h.panel.update(view({layers, selectedId: 'second', extra: {tool: 'maskErase'}}));
    assert.equal(rowFor('second').classList.contains('is-selected'), true, 'selectedId remains the single-selection fallback');
    assert.equal(hint.textContent, 'Shift+클릭으로 여러 보정을 선택합니다.');
    assert.equal(byClass(h.root, 'canvas-retouch-tool-section').children.at(-1).textContent,
        '선택한 보정만 지웁니다. 경계 선명도 0%는 부드럽게, 100%는 또렷하게 지웁니다.');

    h.panel.update(view({layers, selectedId: null}));
    assert.ok(list.children.every(row => !row.classList.contains('is-selected')));
    assert.equal(hint.textContent, 'Shift+클릭으로 여러 보정을 선택합니다.');
    h.panel.update(view({layers, selectedId: 'second', busy: true, extra: {selectedIds: ['first', 'second']}}));
    assert.ok(list.children.every(row => row.children[1].disabled));
    h.panel.update(view({layers: [], selectedId: null}));
    assert.equal(hint.textContent, 'Shift+클릭으로 여러 보정을 선택합니다.');
    assert.equal(list.children.length, 1, 'empty layer list keeps the existing empty state');
});

test('status and error text remain visible text and download results expose a safe PNG link', () => {
    const h = createHarness();
    const dangerousName = '<img src=x onerror=alert(1)>';
    const layer = RetouchState.createLayer('color', () => 'color-1');
    h.panel.update(view({layers: [layer], selectedId: layer.id, extra: {error: '요청에 실패했습니다.', message: '숨겨져야 하는 안내', downloadSrc: '/api/retouch/export/1', otherAvailable: true}}));

    const error = find(h.root, item => item.classList?.contains('canvas-retouch-message') && item.classList?.contains('is-error'));
    assert.ok(error);
    assert.equal(error.hidden, false);
    assert.equal(error.textContent, '요청에 실패했습니다.');
    assert.equal(byClass(h.root, 'canvas-retouch-result-link').hidden, false);
    assert.equal(byClass(h.root, 'canvas-retouch-result-link').getAttribute('download'), '합성본.png');
    assert.equal(find(h.root, item => item.tagName === 'IMG'), null);

    h.panel.update(view({layers: [layer], selectedId: layer.id, extra: {message: dangerousName, downloadSrc: '//example.invalid/unsafe.png'}}));
    const status = find(h.root, item => item.classList?.contains('canvas-retouch-message') && item.getAttribute('role') === 'status');
    assert.equal(status.textContent, dangerousName);
    assert.equal(byClass(h.root, 'canvas-retouch-result-link').hidden, true);
});

