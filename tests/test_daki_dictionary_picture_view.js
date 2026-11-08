const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'static/daki_dictionary/picture_view.js'), 'utf8');

class FakeEventTarget {
    constructor() {
        this.listeners = new Map();
    }

    addEventListener(type, handler, options) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push({handler, options});
    }

    removeEventListener(type, handler, options) {
        const current = this.listeners.get(type) || [];
        this.listeners.set(type, current.filter(item => item.handler !== handler || item.options !== options));
    }

    listenerCount(type) { return (this.listeners.get(type) || []).length; }

    dispatch(type, values = {}) {
        const event = {
            type,
            target: this,
            button: 0,
            isPrimary: true,
            pointerId: 1,
            clientX: 0,
            clientY: 0,
            deltaY: 0,
            deltaMode: 0,
            defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; },
            ...values,
        };
        for (const {handler} of [...(this.listeners.get(type) || [])]) handler.call(this, event);
        return event;
    }
}

class FakeImage extends FakeEventTarget {
    constructor() {
        super();
        this.style = {transform: ''};
        this.complete = true;
        this.naturalWidth = 640;
        this.src = 'synthetic:image';
        this.capturedPointers = new Set();
        this.failCapture = false;
    }

    getAttribute(name) { return name === 'src' ? this.src : null; }
    setPointerCapture(pointerId) {
        if (this.failCapture) throw new Error('synthetic capture failure');
        this.capturedPointers.add(pointerId);
    }
    hasPointerCapture(pointerId) { return this.capturedPointers.has(pointerId); }
    releasePointerCapture(pointerId) { this.capturedPointers.delete(pointerId); }
}

class FakeOverlay extends FakeEventTarget {
    constructor() {
        super();
        this.open = true;
        this.clientHeight = 300;
        this.rect = {left: 100, top: 50, width: 400, height: 300};
        this.classes = new Set();
        this.classList = {
            add: name => this.classes.add(name),
            remove: name => this.classes.delete(name),
            contains: name => this.classes.has(name),
        };
    }

    getBoundingClientRect() { return this.rect; }
}

function fixture() {
    const root = new FakeEventTarget();
    const overlay = new FakeOverlay();
    const image = new FakeImage();
    vm.runInNewContext(source, {window: root});
    const view = root.DakiDictionaryPictureView;
    return {root, overlay, image, view, handle: view.mount(overlay, image)};
}

function transform(image) {
    const match = image.style.transform.match(/^translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)$/);
    if (!match) return null;
    return {x: Number(match[1]), y: Number(match[2]), scale: Number(match[3])};
}

function startDrag(f, values = {}) {
    return f.image.dispatch('pointerdown', {pointerId: 17, clientX: 120, clientY: 80, ...values});
}

test('mount rejects invalid elements with a reusable no-op handle', () => {
    const f = fixture();
    const handle = f.view.mount(null, f.image);
    assert.equal(typeof handle.reset, 'function');
    assert.equal(typeof handle.dispose, 'function');
    assert.doesNotThrow(() => { handle.reset(); handle.dispose(); });
});

test('wheel zoom keeps the image point under the cursor fixed', () => {
    const f = fixture();
    const cursor = {x: 345, y: 205};
    const center = {x: 300, y: 200};
    const before = {x: (cursor.x - center.x) / 1, y: (cursor.y - center.y) / 1};
    const event = f.overlay.dispatch('wheel', {deltaY: -120, ...{clientX: cursor.x, clientY: cursor.y}});
    const state = transform(f.image);

    assert.equal(event.defaultPrevented, true);
    assert.ok(state.scale > 1);
    assert.ok(Math.abs((cursor.x - center.x - state.x) / state.scale - before.x) < 1e-9);
    assert.ok(Math.abs((cursor.y - center.y - state.y) / state.scale - before.y) < 1e-9);
    assert.equal(f.overlay.listeners.get('wheel')[0].options.passive, false);
});

test('wheel delta modes, clamping, zero, and non-finite values are handled', () => {
    const f = fixture();
    const line = f.overlay.dispatch('wheel', {deltaY: 2, deltaMode: 1, clientX: 300, clientY: 200});
    let state = transform(f.image);
    assert.equal(line.defaultPrevented, true);
    assert.ok(Math.abs(state.scale - Math.exp(-32 * 0.0015)) < 1e-12);

    const page = f.overlay.dispatch('wheel', {deltaY: 0.1, deltaMode: 2, clientX: 300, clientY: 200});
    state = transform(f.image);
    assert.equal(page.defaultPrevented, true);
    assert.ok(Math.abs(state.scale - Math.exp(-(32 + 30) * 0.0015)) < 1e-12);

    const beforeInvalid = f.image.style.transform;
    for (const deltaY of [0, NaN, Infinity]) {
        const ignored = f.overlay.dispatch('wheel', {deltaY, clientX: 300, clientY: 200});
        assert.equal(ignored.defaultPrevented, false);
        assert.equal(f.image.style.transform, beforeInvalid);
    }

    const clampDown = f.overlay.dispatch('wheel', {deltaY: 1e9, clientX: 300, clientY: 200});
    state = transform(f.image);
    assert.equal(clampDown.defaultPrevented, true);
    assert.equal(state.scale, 0.25);
    const atMinimum = f.image.style.transform;
    const stillPrevented = f.overlay.dispatch('wheel', {deltaY: 1e9, clientX: 300, clientY: 200});
    assert.equal(stillPrevented.defaultPrevented, true);
    assert.equal(f.image.style.transform, atMinimum);

    f.handle.reset();
    f.overlay.dispatch('wheel', {deltaY: -1e9, clientX: 300, clientY: 200});
    f.overlay.dispatch('wheel', {deltaY: -1e9, clientX: 300, clientY: 200});
    assert.equal(transform(f.image).scale, 8);
});

test('closed, unavailable, and button-targeted wheel events do not alter the image', () => {
    const f = fixture();
    for (const setup of [
        () => { f.overlay.open = false; },
        () => { f.overlay.open = true; f.image.complete = false; },
        () => { f.image.complete = true; f.image.naturalWidth = 0; },
    ]) {
        setup();
        const event = f.overlay.dispatch('wheel', {deltaY: -100, clientX: 300, clientY: 200});
        assert.equal(event.defaultPrevented, false);
        assert.equal(f.image.style.transform, '');
    }
    f.image.naturalWidth = 640;
    f.image.src = '';
    const noSource = f.overlay.dispatch('wheel', {deltaY: -100, clientX: 300, clientY: 200});
    assert.equal(noSource.defaultPrevented, false);
    assert.equal(f.image.style.transform, '');
    f.image.src = 'synthetic:image';
    const buttonEvent = f.overlay.dispatch('wheel', {
        target: {tagName: 'BUTTON'}, deltaY: -100, clientX: 300, clientY: 200,
    });
    assert.equal(buttonEvent.defaultPrevented, false);
    assert.equal(f.image.style.transform, '');
});

test('primary left drag pans; other buttons, pointers, and non-primary starts are ignored', () => {
    const f = fixture();
    const right = startDrag(f, {button: 2});
    const secondary = startDrag(f, {isPrimary: false});
    assert.equal(right.defaultPrevented, false);
    assert.equal(secondary.defaultPrevented, false);
    assert.equal(f.image.capturedPointers.size, 0);

    f.image.failCapture = true;
    const failedCapture = startDrag(f);
    assert.equal(failedCapture.defaultPrevented, true);
    assert.equal(f.overlay.classList.contains('is-dragging'), false);
    f.image.failCapture = false;

    const down = startDrag(f);
    assert.equal(down.defaultPrevented, true);
    assert.equal(f.overlay.classList.contains('is-dragging'), true);
    assert.equal(f.image.hasPointerCapture(17), true);

    const other = f.image.dispatch('pointermove', {pointerId: 18, clientX: 220, clientY: 160});
    assert.equal(other.defaultPrevented, false);
    assert.equal(f.image.style.transform, '');
    const move = f.image.dispatch('pointermove', {pointerId: 17, clientX: 155, clientY: 95});
    assert.equal(move.defaultPrevented, true);
    assert.deepEqual(transform(f.image), {x: 35, y: 15, scale: 1});

    f.image.dispatch('pointerup', {pointerId: 17});
    assert.equal(f.overlay.classList.contains('is-dragging'), false);
    assert.equal(f.image.hasPointerCapture(17), false);
});

test('pointer cancel, lost capture, and window blur always end an active drag', () => {
    const f = fixture();
    startDrag(f);
    f.image.dispatch('pointercancel', {pointerId: 17});
    assert.equal(f.overlay.classList.contains('is-dragging'), false);
    assert.equal(f.image.hasPointerCapture(17), false);

    startDrag(f);
    f.image.capturedPointers.delete(17);
    f.image.dispatch('lostpointercapture', {pointerId: 17});
    assert.equal(f.overlay.classList.contains('is-dragging'), false);

    startDrag(f);
    f.root.dispatch('blur');
    assert.equal(f.overlay.classList.contains('is-dragging'), false);
    assert.equal(f.image.hasPointerCapture(17), false);
});

test('wheel zoom during a drag rebases the drag origin without a jump', () => {
    const f = fixture();
    startDrag(f);
    f.image.dispatch('pointermove', {pointerId: 17, clientX: 140, clientY: 90});
    const beforeWheel = transform(f.image);
    f.overlay.dispatch('wheel', {deltaY: -100, clientX: 160, clientY: 100});
    const afterWheel = transform(f.image);
    f.image.dispatch('pointermove', {pointerId: 17, clientX: 160, clientY: 100});

    assert.ok(afterWheel.scale > beforeWheel.scale);
    assert.equal(f.image.style.transform, `translate(${afterWheel.x}px, ${afterWheel.y}px) scale(${afterWheel.scale})`);
});

test('close resets the view, while a delayed close event after reopen is ignored', () => {
    const f = fixture();
    f.overlay.dispatch('wheel', {deltaY: -100, clientX: 310, clientY: 210});
    assert.notEqual(f.image.style.transform, '');

    f.overlay.open = true;
    f.overlay.dispatch('close');
    assert.notEqual(f.image.style.transform, '', 'a queued close event must not reset a reopened overlay');

    f.overlay.open = false;
    f.overlay.dispatch('close');
    assert.equal(f.image.style.transform, '');
    f.overlay.open = true;
    f.overlay.dispatch('wheel', {deltaY: -100, clientX: 310, clientY: 210});
    assert.notEqual(f.image.style.transform, '');
});

test('image load and error events reset pan and zoom', () => {
    const f = fixture();
    f.overlay.dispatch('wheel', {deltaY: -100, clientX: 310, clientY: 210});
    f.image.dispatch('load');
    assert.equal(f.image.style.transform, '');
    f.overlay.dispatch('wheel', {deltaY: -100, clientX: 310, clientY: 210});
    f.image.dispatch('error');
    assert.equal(f.image.style.transform, '');
});

test('dispose resets state, removes every listener, and permits a fresh mount', () => {
    const f = fixture();
    f.overlay.dispatch('wheel', {deltaY: -100, clientX: 310, clientY: 210});
    startDrag(f);
    f.handle.dispose();
    f.handle.dispose();

    assert.equal(f.image.style.transform, '');
    assert.equal(f.overlay.classList.contains('is-dragging'), false);
    assert.equal(f.image.capturedPointers.size, 0);
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'dragstart', 'load', 'error']) {
        assert.equal(f.image.listenerCount(type), 0, `${type} listener should be removed`);
    }
    assert.equal(f.overlay.listenerCount('wheel'), 0);
    assert.equal(f.overlay.listenerCount('close'), 0);
    assert.equal(f.root.listenerCount('blur'), 0);

    const remounted = f.view.mount(f.overlay, f.image);
    const event = f.overlay.dispatch('wheel', {deltaY: -100, clientX: 310, clientY: 210});
    assert.equal(event.defaultPrevented, true);
    assert.notEqual(f.image.style.transform, '');
    remounted.dispose();
});
