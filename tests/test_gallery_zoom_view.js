const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'static/gallery_zoom_view.js'), 'utf8');

class Element {
    constructor(id = '') {
        this.id = id;
        this.style = {};
        this.hidden = false;
        this.textContent = '';
        this.attributes = {};
        this.listeners = new Map();
        this.classes = new Set();
        this.captures = new Set();
        this.classList = {
            toggle: (name, force) => {
                const enabled = force === undefined ? !this.classes.has(name) : Boolean(force);
                if (enabled) this.classes.add(name);
                else this.classes.delete(name);
                return enabled;
            },
            contains: name => this.classes.has(name),
        };
        this.rect = {left: 100, top: 50, width: 400, height: 300};
    }

    addEventListener(type, callback, options) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push({callback, options});
    }

    setAttribute(name, value) { this.attributes[name] = value; }
    setPointerCapture(id) { this.captures.add(id); }
    hasPointerCapture(id) { return this.captures.has(id); }
    releasePointerCapture(id) { this.captures.delete(id); }
    getBoundingClientRect() { return this.rect; }

    dispatch(type, values = {}) {
        const event = {
            type,
            target: values.target || this,
            pointerId: 1,
            button: 0,
            isPrimary: true,
            clientX: 0,
            clientY: 0,
            deltaY: 0,
            deltaMode: 0,
            defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; },
            ...values,
        };
        for (const {callback} of this.listeners.get(type) || []) callback(event);
        return event;
    }
}

function createView() {
    const layer = new Element('zoomLayer');
    const stage = new Element();
    const image = new Element('zoomImg');
    const pinButton = new Element('galleryZoomPinBtn');
    const hint = new Element('galleryZoomViewHint');
    layer.style.display = 'flex';
    layer.querySelector = selector => selector === '.gallery-zoom-image-stage' ? stage : null;
    const byId = new Map([[layer.id, layer], [image.id, image], [pinButton.id, pinButton], [hint.id, hint]]);
    const context = vm.createContext({document: {getElementById: id => byId.get(id) || null}, window: {}});
    vm.runInContext(source, context);
    const view = context.window.GalleryZoomView;
    view.init();
    return {view, layer, stage, image, pinButton, hint};
}

function transform(image) {
    const match = image.style.transform.match(/^translate\(([-\d.e+]+)px, ([-\d.e+]+)px\) scale\(([-\d.e+]+)\)$/);
    assert.ok(match, image.style.transform);
    return match.slice(1).map(Number);
}

test('pin toggle updates controls and resets the view; reset can preserve or clear pin state', () => {
    const {view, layer, stage, image, pinButton, hint} = createView();
    assert.equal(view.isPinned(), false);
    assert.equal(pinButton.textContent, '고정');
    assert.equal(pinButton.attributes['aria-pressed'], 'false');
    assert.equal(hint.textContent, '');
    assert.equal(layer.classList.contains('gallery-zoom-pinned'), false);

    view.toggle();
    assert.equal(view.isPinned(), true);
    assert.equal(pinButton.textContent, '고정 해제');
    assert.equal(pinButton.attributes['aria-pressed'], 'true');
    assert.equal(hint.textContent, '그림·빈 공간 드래그로 이동 · 휠로 확대·축소');
    assert.equal(layer.classList.contains('gallery-zoom-pinned'), true);
    assert.equal(stage.listeners.get('wheel')[0].options.passive, false);

    stage.dispatch('pointerdown', {pointerId: 3, clientX: 10, clientY: 20});
    stage.dispatch('pointermove', {pointerId: 3, clientX: 30, clientY: 60});
    view.reset();
    assert.equal(view.isPinned(), true);
    assert.deepEqual(transform(image), [0, 0, 1]);
    assert.equal(stage.classList.contains('gallery-zoom-dragging'), false);

    view.toggle();
    assert.equal(view.isPinned(), false);
    assert.equal(pinButton.textContent, '고정');
    assert.equal(pinButton.attributes['aria-pressed'], 'false');
    view.toggle();
    view.reset(true);
    assert.equal(view.isPinned(), false);
    assert.equal(layer.classList.contains('gallery-zoom-pinned'), false);
});

test('wheel zoom and dragging work only while pinned and visible, including image and empty stage', () => {
    const {view, layer, stage, image} = createView();
    let event = stage.dispatch('wheel', {deltaY: -100, clientX: 400, clientY: 200});
    assert.equal(event.defaultPrevented, false);
    assert.equal(stage.dispatch('dragstart', {target: image}).defaultPrevented, false);
    assert.deepEqual(transform(image), [0, 0, 1]);
    stage.dispatch('pointerdown', {pointerId: 4, clientX: 10, clientY: 20});
    stage.dispatch('pointermove', {pointerId: 4, clientX: 50, clientY: 70});
    assert.deepEqual(transform(image), [0, 0, 1]);

    view.toggle();
    assert.equal(stage.dispatch('dragstart', {target: image}).defaultPrevented, true);
    assert.equal(stage.dispatch('dragstart', {target: stage}).defaultPrevented, false);
    event = stage.dispatch('wheel', {deltaY: -100, clientX: 400, clientY: 200});
    assert.equal(event.defaultPrevented, true);
    let [x, y, scale] = transform(image);
    assert.ok(scale > 1);
    assert.ok(x < 0, 'zoom keeps the off-center cursor anchor stable');
    assert.ok(Number.isFinite(y));

    for (const target of [stage, image]) {
        const pointerId = target === stage ? 5 : 6;
        stage.dispatch('pointerdown', {target, pointerId, clientX: 100, clientY: 120});
        assert.equal(stage.hasPointerCapture(pointerId), true);
        assert.equal(stage.classList.contains('gallery-zoom-dragging'), true);
        stage.dispatch('pointermove', {pointerId, clientX: 130, clientY: 150});
        [x, y, scale] = transform(image);
        assert.ok(x > -1, 'pointer movement updates pan from either stage target');
        assert.ok(y > 0);
        assert.ok(scale > 1);
        stage.dispatch('pointerup', {pointerId});
        assert.equal(stage.hasPointerCapture(pointerId), false);
        assert.equal(stage.classList.contains('gallery-zoom-dragging'), false);
    }

    layer.style.display = 'none';
    event = stage.dispatch('wheel', {deltaY: -100});
    assert.equal(event.defaultPrevented, false);
    const beforeHiddenDrag = transform(image);
    stage.dispatch('pointerdown', {pointerId: 7, clientX: 0, clientY: 0});
    stage.dispatch('pointermove', {pointerId: 7, clientX: 80, clientY: 80});
    assert.deepEqual(transform(image), beforeHiddenDrag);
});

test('wheel delta normalization stays finite and scale is clamped', () => {
    const {view, stage, image} = createView();
    view.toggle();
    stage.dispatch('wheel', {deltaY: -1, deltaMode: 1});
    let [x, y, scale] = transform(image);
    assert.ok(Math.abs(scale - Math.exp(0.024)) < 0.000001);
    assert.ok(Number.isFinite(x) && Number.isFinite(y));

    for (let index = 0; index < 10; index++) stage.dispatch('wheel', {deltaY: -1000});
    assert.equal(transform(image)[2], 8);
    for (let index = 0; index < 10; index++) stage.dispatch('wheel', {deltaY: 1000});
    [x, y, scale] = transform(image);
    assert.equal(scale, 0.25);
    assert.ok(Number.isFinite(x) && Number.isFinite(y));

    stage.dispatch('wheel', {deltaY: Infinity});
    assert.ok(transform(image).every(Number.isFinite));
});

test('pointer cancellation, lost capture, and reset end drag and release capture', () => {
    const {view, stage, image} = createView();
    view.toggle();
    stage.dispatch('pointerdown', {pointerId: 8, clientX: 0, clientY: 0});
    stage.dispatch('pointermove', {pointerId: 8, clientX: 10, clientY: 12});
    stage.dispatch('pointercancel', {pointerId: 8});
    assert.equal(stage.hasPointerCapture(8), false);
    assert.equal(stage.classList.contains('gallery-zoom-dragging'), false);
    const afterCancel = transform(image);
    stage.dispatch('pointermove', {pointerId: 8, clientX: 30, clientY: 32});
    assert.deepEqual(transform(image), afterCancel);

    stage.dispatch('pointerdown', {pointerId: 9, clientX: 0, clientY: 0});
    stage.dispatch('lostpointercapture', {pointerId: 9});
    assert.equal(stage.classList.contains('gallery-zoom-dragging'), false);

    stage.dispatch('pointerdown', {pointerId: 10, clientX: 0, clientY: 0});
    view.reset();
    assert.equal(stage.hasPointerCapture(10), false);
    assert.equal(stage.classList.contains('gallery-zoom-dragging'), false);
    assert.deepEqual(transform(image), [0, 0, 1]);
});

test('non-primary and non-left pointer presses do not start a drag', () => {
    const {view, stage, image} = createView();
    view.toggle();
    stage.dispatch('pointerdown', {button: 2, pointerId: 11});
    stage.dispatch('pointerdown', {isPrimary: false, pointerId: 12});
    assert.equal(stage.classList.contains('gallery-zoom-dragging'), false);
    assert.equal(stage.hasPointerCapture(11), false);
    assert.equal(stage.hasPointerCapture(12), false);
    stage.dispatch('pointermove', {pointerId: 11, clientX: 10});
    assert.deepEqual(transform(image), [0, 0, 1]);
});
