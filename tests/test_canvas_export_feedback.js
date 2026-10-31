const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {test} = require('node:test');

const moduleSource = fs.readFileSync(require.resolve('../static/canvas_export_feedback.js'), 'utf8');

class FakeNode {
    constructor(doc, tagName) {
        this.doc = doc;
        this.tagName = tagName.toUpperCase();
        this.id = '';
        this.className = '';
        this.type = '';
        this.textContent = '';
        this.children = [];
        this.listeners = new Map();
        this.attributes = new Map();
        this.parentNode = null;
        this.open = false;
        this.disabled = false;
        this.focusCalls = 0;
        this.value = 0;
        this.max = 0;
    }

    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }

    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }

    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
    }

    dispatch(type, event = {}) {
        event.target ||= this;
        event.preventDefault ||= () => { event.defaultPrevented = true; };
        event.stopPropagation ||= () => { event.propagationStopped = true; };
        for (const listener of this.listeners.get(type) || []) listener(event);
        return event;
    }

    focus(options) {
        this.focusCalls++;
        this.doc.activeElement = this;
        this.focusOptions = options;
    }

    showModal() {
        this.open = true;
        this.showModalCalls = (this.showModalCalls || 0) + 1;
    }

    close() {
        if (!this.open) return;
        this.open = false;
        if (this.doc.deferCloseEvents) this.doc.closeEvents.push(() => this.dispatch('close'));
        else this.dispatch('close');
    }

    get isConnected() {
        for (let node = this; node; node = node.parentNode) {
            if (node === this.doc.body) return true;
        }
        return false;
    }
}

function createHarness({deferCloseEvents = false} = {}) {
    let now = 1000;
    let nextTimerId = 1;
    const intervals = new Map();
    const doc = {
        activeElement: null,
        deferCloseEvents,
        closeEvents: [],
        createElement(tagName) { return new FakeNode(doc, tagName); },
        body: null,
        querySelectorAll(selector) {
            assert.equal(selector, 'dialog[open]');
            const found = [];
            const visit = node => {
                for (const child of node.children) {
                    if (child.tagName === 'DIALOG' && child.open) found.push(child);
                    visit(child);
                }
            };
            visit(doc.body);
            return found;
        }
    };
    doc.body = new FakeNode(doc, 'body');
    class FakeDate extends Date { static now() { return now; } }
    const window = {
        document: doc,
        addEventListener(type, listener) {
            this.listeners ||= new Map();
            if (!this.listeners.has(type)) this.listeners.set(type, []);
            this.listeners.get(type).push(listener);
        },
        dispatch(type) { for (const listener of this.listeners?.get(type) || []) listener(); },
        setInterval(callback, delay) {
            const id = nextTimerId++;
            intervals.set(id, {callback, delay});
            return id;
        },
        clearInterval(id) { intervals.delete(id); }
    };
    const sandbox = {document: doc, window, module: {exports: {}}, Date: FakeDate};
    vm.runInContext(moduleSource, vm.createContext(sandbox));
    return {
        doc,
        window,
        api: window.CanvasExportFeedback,
        intervals,
        advance(ms) { now += ms; for (const timer of [...intervals.values()]) timer.callback(); },
        openDialogs() { return doc.querySelectorAll('dialog[open]'); }
    };
}

function findById(root, id) {
    if (root.id === id) return root;
    for (const child of root.children) {
        const found = findById(child, id);
        if (found) return found;
    }
    return null;
}

test('chooseReset resolves all three choices and safely displays context', async () => {
    const h = createHarness();
    const opener = h.doc.body.appendChild(h.doc.createElement('button'));
    opener.focus();
    const context = '<img src=x onerror="run()">\n' + 'C:\\synthetic\\'.repeat(12);

    const confirm = h.api.chooseReset(context);
    const dialog = findById(h.doc.body, 'canvasExportResetChoiceDialog');
    const label = findById(dialog, 'canvasExportResetChoiceContext');
    assert.equal(dialog.getAttribute('aria-labelledby'), 'canvasExportResetChoiceTitle');
    assert.equal(dialog.getAttribute('aria-describedby'), 'canvasExportResetChoiceDescription');
    assert.equal(label.textContent, context);
    assert.equal(label.innerHTML, undefined);
    assert.equal(h.doc.activeElement, findById(dialog, 'canvasExportResetChoiceOnly'));
    assert.match(findById(dialog, 'canvasExportResetChoiceDescription').textContent, /다른 열린 프로젝트 캔버스에는 영향을 주지 않습니다/);
    for (const type of ['keydown', 'paste', 'copy', 'cut']) {
        assert.equal(dialog.dispatch(type).propagationStopped, true, type);
    }
    findById(dialog, 'canvasExportResetChoiceMerge').dispatch('click');
    assert.equal(await confirm, true);
    assert.equal(h.doc.activeElement, opener);

    const exportOnly = h.api.chooseReset('다른 캔버스');
    findById(dialog, 'canvasExportResetChoiceOnly').dispatch('click');
    assert.equal(await exportOnly, false);

    const cancel = h.api.chooseReset('취소 테스트');
    findById(dialog, 'canvasExportResetChoiceCancel').dispatch('click');
    assert.equal(await cancel, null);
});

test('Escape, close, duplicate choice, and delayed close events safely resolve to null', async () => {
    const h = createHarness({deferCloseEvents: true});
    const first = h.api.chooseReset('첫 번째');
    const dialog = findById(h.doc.body, 'canvasExportResetChoiceDialog');
    assert.equal(await h.api.chooseReset('중복'), null);
    const escape = dialog.dispatch('cancel');
    assert.equal(escape.defaultPrevented, true);
    assert.equal(await first, null);

    const second = h.api.chooseReset('두 번째');
    h.doc.closeEvents.shift()();
    findById(dialog, 'canvasExportResetChoiceOnly').dispatch('click');
    assert.equal(await second, false);
    h.doc.closeEvents.shift()();

    const externalClose = h.api.chooseReset('외부 닫기');
    dialog.close();
    h.doc.closeEvents.shift()();
    assert.equal(await externalClose, null);
});

test('progress reports elapsed time and completed stages without inventing percentage', () => {
    const h = createHarness();
    const opener = h.doc.body.appendChild(h.doc.createElement('button'));
    opener.focus();
    const context = '<b>synthetic path</b>\\'.repeat(20);
    const progressHandle = h.api.start(context);
    const dialog = findById(h.doc.body, 'canvasExportFeedbackDialog');
    const bar = findById(dialog, 'canvasExportFeedbackProgress');
    const percent = findById(dialog, 'canvasExportFeedbackPercent');
    const stage = findById(dialog, 'canvasExportFeedbackStage');
    const elapsed = findById(dialog, 'canvasExportFeedbackElapsed');
    const close = findById(dialog, 'canvasExportFeedbackClose');

    assert.equal(dialog.getAttribute('aria-labelledby'), 'canvasExportFeedbackTitle');
    assert.equal(findById(dialog, 'canvasExportFeedbackContext').textContent, context);
    assert.equal(findById(dialog, 'canvasExportFeedbackContext').innerHTML, undefined);
    assert.equal(findById(dialog, 'canvasExportFeedbackDescription').textContent,
        '완료한 처리 단계 기준입니다. 저장 단계는 파일 크기에 따라 오래 걸릴 수 있습니다.');
    assert.equal(bar.getAttribute('aria-labelledby'), 'canvasExportFeedbackProgressLabel');
    assert.equal(bar.value, 0);
    assert.equal(percent.textContent, '0%');
    assert.equal(close.disabled, true);
    assert.equal(h.intervals.size, 1);

    progressHandle.update('이미지 합성', 1, 4);
    assert.equal(bar.value, 25);
    assert.equal(percent.textContent, '25%');
    h.advance(2500);
    assert.equal(elapsed.textContent, '경과 시간: 2초');
    assert.equal(percent.textContent, '25%', 'time alone must not advance progress');

    progressHandle.update('파일 저장', 2, 4);
    assert.equal(bar.value, 50);
    assert.equal(stage.textContent, '파일 저장');
    progressHandle.finish('내보내기 완료: 합성 결과');
    assert.equal(bar.value, 100);
    assert.equal(percent.textContent, '100%');
    assert.equal(stage.textContent, '내보내기 완료: 합성 결과');
    assert.equal(close.disabled, false);
    assert.equal(h.intervals.size, 0);
    assert.equal(h.doc.activeElement, close);
    progressHandle.close();
    progressHandle.close();
    assert.deepEqual(h.openDialogs(), []);
    assert.equal(h.doc.activeElement, opener);
});

test('failure preserves measured percentage, clears elapsed timer, and allows closing', () => {
    const h = createHarness();
    const progressHandle = h.api.start('합성 캔버스');
    const dialog = findById(h.doc.body, 'canvasExportFeedbackDialog');
    const bar = findById(dialog, 'canvasExportFeedbackProgress');
    const percent = findById(dialog, 'canvasExportFeedbackPercent');
    const stage = findById(dialog, 'canvasExportFeedbackStage');
    const close = findById(dialog, 'canvasExportFeedbackClose');

    progressHandle.update('저장 중', 1, 3);
    progressHandle.fail('저장 단계에서 오류가 발생했습니다.');
    assert.equal(bar.value, 33);
    assert.equal(percent.textContent, '33%');
    assert.equal(stage.textContent, '저장 단계에서 오류가 발생했습니다.');
    assert.equal(dialog.getAttribute('data-state'), 'failed');
    assert.equal(h.intervals.size, 0);
    assert.equal(close.disabled, false);
    close.dispatch('click');
    assert.deepEqual(h.openDialogs(), []);
});

test('pagehide resolves pending reset as null and closes progress timers', async () => {
    const h = createHarness();
    const pending = h.api.chooseReset('페이지 이동');
    const progressHandle = h.api.start('진행 중 캔버스');
    assert.equal(h.intervals.size, 1);
    h.window.dispatch('pagehide');
    assert.equal(await pending, null);
    assert.equal(h.intervals.size, 0);
    assert.deepEqual(h.openDialogs(), []);
    progressHandle.update('늦게 도착한 단계', 3, 4);
    assert.equal(findById(h.doc.body, 'canvasExportFeedbackStage').textContent, '준비 중');
});

test('a second progress start cannot replace the active export; a later start closes prior terminal UI', () => {
    const h = createHarness();
    const first = h.api.start('첫 번째 캔버스');
    const dialog = findById(h.doc.body, 'canvasExportFeedbackDialog');
    const showModalCalls = dialog.showModalCalls;
    const duplicate = h.api.start('중복 캔버스');
    assert.equal(dialog.showModalCalls, showModalCalls);
    assert.equal(findById(dialog, 'canvasExportFeedbackContext').textContent, '첫 번째 캔버스');
    duplicate.update('중복 단계', 1, 1);
    assert.equal(findById(dialog, 'canvasExportFeedbackStage').textContent, '준비 중');

    first.finish('완료');
    const second = h.api.start('두 번째 캔버스');
    assert.equal(dialog.showModalCalls, showModalCalls + 1);
    assert.equal(findById(dialog, 'canvasExportFeedbackContext').textContent, '두 번째 캔버스');
    first.fail('오래된 실패');
    assert.equal(findById(dialog, 'canvasExportFeedbackStage').textContent, '준비 중');
    second.close();
    assert.equal(h.intervals.size, 0);
});
