const assert = require('node:assert/strict');
const {test} = require('node:test');
const {mount, mountStrip} = require('../static/canvas_inpaint_reference_preview.js');
const {fitBox} = require('../static/canvas_inpaint_reference.js');

function harness() {
    const loads = [];
    const draws = [];
    const context = {
        setTransform() {}, save() {}, restore() {}, beginPath() {}, clip() {}, rect() {},
        fillRect() {},
        drawImage(image, ...box) { draws.push([image.src, ...box.map(value => value === 0 ? 0 : value)]); }
    };
    const doc = {
        createElement(tag) {
            const element = {
                children: [], style: {}, dataset: {}, ownerDocument: doc,
                append(...nodes) { this.children.push(...nodes); },
                appendChild(node) { this.append(node); node.parent = this; },
                remove() { this.parent.children = this.parent.children.filter(child => child !== this); },
                setAttribute(key, value) { this[key] = value; },
                getContext() { return context; },
                addEventListener(event, fn) { this['on' + event] = fn; },
                focus() {},
                getBoundingClientRect() { return {width: 160, height: 200}; },
                setPointerCapture(id) { this.pointerId = id; },
                hasPointerCapture(id) { return this.pointerId === id; },
                releasePointerCapture() { this.pointerId = null; }
            };
            if (tag === 'img') loads.push(element);
            return element;
        }
    };
    const host = doc.createElement('div');
    const preview = mount(host);
    const [caption, frame, detail] = host.children[0].children;
    const canvas = frame.children[0];
    function finish(index, width, height) {
        Object.assign(loads[index], {naturalWidth: width, naturalHeight: height});
        loads[index].onload();
    }
    return {preview, loads, draws, finish, caption, canvas, detail, doc};
}

test('clip-only request, combined size, independent scale and disabled reference', () => {
    const {preview, loads, draws, finish, caption, canvas, detail} = harness();
    const clip = {src: 'clip.png', imageWidth: 512, imageHeight: 384};
    const ref = {src: 'reference.png', width: 320, scale: 1};
    preview.update(null, null, true, fitBox);
    assert.equal(loads.length, 0);
    assert.match(detail.textContent, /클립을 선택/);
    preview.update(ref, clip, false, fitBox);
    finish(0, 512, 384);
    assert.equal(canvas.hidden, false);
    assert.equal(caption.children[1].textContent, '512 × 384 px');
    assert.deepEqual(draws.at(-1), ['clip.png', 0, 0, 512, 384]);
    preview.update(ref, clip, true, fitBox);
    assert.equal(canvas.hidden, true);
    finish(1, 640, 320);
    assert.equal(caption.children[1].textContent, '832 × 384 px');
    assert.deepEqual(draws.slice(-2), [['reference.png', 0, 112, 320, 160], ['clip.png', 320, 0, 512, 384]]);
    preview.update({...ref, scale: 0.5}, clip, true, fitBox);
    assert.deepEqual(draws.at(-2), ['reference.png', 80, 152, 160, 80]);
    const count = draws.length;
    preview.update({...ref, scale: 0.5}, clip, true, fitBox);
    assert.equal(draws.length, count);
    assert.equal(loads.length, 2);
    preview.update(ref, clip, false, fitBox);
    assert.match(detail.textContent, /클립만 전송/);
});

test('strip drag uses signed free space, commits once and restores the starting pan on cancellation', () => {
    const {finish, loads, doc} = harness();
    const values = [];
    const host = doc.createElement('div');
    const editor = mountStrip(host, (...args) => values.push(args));
    const pane = host.children[0];
    const reference = {src: 'ref.png', width: 320, scale: 2};
    const clip = {id: 1, imageHeight: 400};
    editor.update(reference, clip, true, fitBox);
    finish(0, 320, 200);
    assert.equal(loads[0].style.left, '-50%');
    assert.equal(loads[0].style.width, '200%');
    assert.equal(pane.tabIndex, 0);
    const dispatch = (type, extra) => pane['on' + type]({
        clientX: 0, clientY: 10, button: 0, pointerId: 17,
        preventDefault() {}, stopPropagation() {}, ...extra
    });
    dispatch('pointerdown');
    dispatch('pointermove', {clientX: 40, clientY: 30});
    assert.deepEqual(values.at(-1), [0.25, 0.5, false]);
    assert.equal(loads[0].style.left, '-25%');
    dispatch('pointerup', {clientX: 200});
    assert.deepEqual(values.at(-1), [0, 0.5, true]);
    dispatch('keydown', {key: 'ArrowLeft'});
    assert.deepEqual(values.at(-1), [0.05, 0.5, true]);
    const count = values.length;
    dispatch('keydown', {key: 'ArrowUp'});
    assert.equal(values.length, count);
    dispatch('pointerdown');
    dispatch('pointermove', {clientX: -200});
    dispatch('lostpointercapture');
    assert.deepEqual(values.at(-1), [0.05, 0.5, true]);
    dispatch('pointerdown');
    dispatch('pointermove', {clientX: -100});
    dispatch('pointercancel');
    assert.deepEqual(values.at(-1), [0.05, 0.5, true]);
    editor.update({...reference, src: 'new.png'}, clip, true, fitBox);
    const oldImage = loads[0];
    oldImage.onload();
    assert.equal(loads[1].hidden, true);
    editor.update(reference, clip, false, fitBox);
    finish(1, 320, 200);
    assert.equal(pane.hidden, true);
    assert.equal(pane.children.length, 1);
});

test('sidebar reflects panning an enlarged reference without painting over the clip', () => {
    const {preview, draws, finish} = harness();
    const clip = {src: 'clip.png', imageWidth: 512, imageHeight: 384};
    const ref = {src: 'ref.png', width: 320, scale: 8, panX: 1, panY: 0};
    preview.update(ref, clip, true, fitBox);
    finish(0, 512, 384);
    finish(1, 320, 192);
    assert.deepEqual(draws.slice(-2), [['ref.png', -2240, 0, 2560, 1536], ['clip.png', 320, 0, 512, 384]]);
    preview.update({...ref, panX: 0}, clip, true, fitBox);
    assert.deepEqual(draws.at(-2), ['ref.png', 0, 0, 2560, 1536]);
});

test('reference thumbnail is visible before a clip exists with inclusion switched off', () => {
    const {preview, loads, draws, finish, caption, canvas, detail} = harness();
    preview.update({src: 'reference.png', width: 320}, null, false, fitBox);
    assert.equal(loads.length, 1);
    finish(0, 640, 320);
    assert.equal(canvas.hidden, false);
    assert.deepEqual(draws, [['reference.png', 0, 0, 640, 320]]);
    assert.equal(caption.children[1].textContent, '원본 640 × 320 px');
    assert.match(detail.textContent, /클립을 선택/);
});

test('an old source completion cannot replace a newer request preview', () => {
    const {preview, loads, draws, finish, canvas, detail} = harness();
    const clip = {src: 'first.png', layerWidth: 256, layerHeight: 192};
    preview.update(null, clip, false, fitBox);
    preview.update(null, {...clip, src: 'next.png'}, false, fitBox);
    finish(0, 256, 192);
    assert.equal(canvas.hidden, true);
    assert.equal(draws.length, 0);
    loads[1].onerror();
    assert.match(detail.textContent, /불러오지 못했습니다/);
    preview.update(null, {...clip, src: null}, false, fitBox);
    assert.equal(canvas.hidden, true);
    assert.match(detail.textContent, /준비하는 중/);
});
