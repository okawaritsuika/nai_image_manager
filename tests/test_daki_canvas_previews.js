const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../static/daki_canvas_previews.js'), 'utf8');

class Container {
    constructor() {
        this.children = [];
        this.attributes = {};
        this.classes = new Set();
        this.textContent = '';
        this.classList = {
            add: name => this.classes.add(name),
            remove: name => this.classes.delete(name),
            contains: name => this.classes.has(name),
        };
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    replaceChildren(...children) { this.children = children; this.textContent = ''; }
}

class FakeImage {
    constructor(autoLoad = true) {
        this.listeners = new Map();
        this.autoLoad = autoLoad;
        this._src = '';
    }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    removeEventListener(name) { this.listeners.delete(name); }
    set src(value) {
        this._src = value;
        if (value && this.autoLoad) queueMicrotask(() => this.listeners.get('load')?.());
    }
    get src() { return this._src; }
}

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
}

function harness({intersection = true, render, imageAutoLoad = true} = {}) {
    const requests = [];
    const renderCalls = [];
    const observers = [];
    const images = [];
    const root = {
        AbortController,
        URL,
        location: new URL('http://localhost/daki'),
        document: {createElement: tag => {
            assert.equal(tag, 'img');
            return {className: '', src: '', alt: '', title: ''};
        }},
        Image: class extends FakeImage {
            constructor() { super(typeof imageAutoLoad === 'function' ? imageAutoLoad() : imageAutoLoad); images.push(this); }
        },
        fetch: (url, options) => {
            const request = deferred();
            requests.push({url, options, ...request});
            return request.promise;
        },
        renderMergedCanvasToDataUrl: options => {
            renderCalls.push(options);
            if (render) return render(options);
            return Promise.resolve('data:image/png;base64,synthetic');
        },
    };
    if (intersection) {
        root.IntersectionObserver = class {
            constructor(callback, options) { this.callback = callback; this.options = options; this.targets = new Set(); observers.push(this); }
            observe(target) { this.targets.add(target); }
            unobserve(target) { this.targets.delete(target); }
            disconnect() { this.disconnected = true; this.targets.clear(); }
            trigger(target, isIntersecting = true) {
                this.callback([{target, isIntersecting, intersectionRatio: isIntersecting ? 1 : 0}]);
            }
        };
    }
    vm.runInNewContext(source, {window: root, URL, encodeURIComponent});
    return {root, requests, renderCalls, observers, images, create: () => root.DakiCanvasPreviews.create()};
}

function canvas(id, overrides = {}) {
    return {id, name: `Canvas ${id}`, side: 'front', revision: 1, ...overrides};
}

function result(projectId, id, {side = 'front', layers = []} = {}) {
    return {
        status: 'success',
        project: {id: projectId, name: 'Synthetic project'},
        canvas: {id, side, state: {width: 800, height: 600, layers}},
    };
}

function reply(request, body, {ok = true} = {}) {
    request.resolve({ok, json: async () => body});
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('IntersectionObserver defers work and the manager runs at most two previews at once', async () => {
    const renders = [];
    const h = harness({render: () => {
        const wait = deferred();
        renders.push(wait);
        return wait.promise;
    }});
    const manager = h.create();
    const containers = [new Container(), new Container(), new Container()];
    containers.forEach((node, index) => manager.observe(node, 'project-a', canvas(`c${index}`)));

    assert.equal(h.requests.length, 0);
    assert.equal(containers[0].textContent, '불러오는 중…');
    assert.equal(containers[0].attributes['aria-busy'], 'true');
    assert.equal(h.observers[0].options.rootMargin, '200px');

    h.observers[0].trigger(containers[0]);
    h.observers[0].trigger(containers[1]);
    h.observers[0].trigger(containers[2]);
    await flush();
    assert.equal(h.requests.length, 2);
    reply(h.requests[0], result('project-a', 'c0'));
    reply(h.requests[1], result('project-a', 'c1'));
    await flush();
    assert.equal(renders.length, 2);
    assert.equal(h.requests.length, 2);

    renders[0].resolve('data:image/png;base64,first');
    await flush();
    assert.equal(h.requests.length, 3);
    assert.equal(h.renderCalls.length, 2);
    manager.dispose();
    assert.equal(h.observers[0].disconnected, true);
});

test('same project, canvas and revision share one request and one composite across containers', async () => {
    const h = harness();
    const manager = h.create();
    const first = new Container(), second = new Container();
    manager.observe(first, 'project-a', canvas('shared'));
    manager.observe(second, 'project-a', canvas('shared'));
    h.observers[0].trigger(first);
    await flush();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url, '/api/daki/projects/project-a/canvases/shared');
    reply(h.requests[0], result('project-a', 'shared'));
    await flush();
    assert.equal(h.renderCalls.length, 1);
    await flush();
    assert.equal(first.children[0].src, 'data:image/png;base64,synthetic');
    assert.equal(second.children[0].src, 'data:image/png;base64,synthetic');
    assert.equal(first.children[0].alt, 'Canvas shared · 통합 미리보기');
    assert.equal(first.children[0].title, first.children[0].alt);
    assert.equal(first.attributes['aria-busy'], 'false');
});

test('saved canvas states composite directly without a project detail request', async () => {
    const state = {width: 640, height: 480, layers: [{type: 'synthetic-layer'}]};
    const h = harness({intersection: false});
    const manager = h.create();
    const node = new Container();
    manager.observeState(node, {id: 'saved-a', name: 'Saved A', savedAt: 42, state});
    await flush();

    assert.equal(h.requests.length, 0);
    assert.equal(h.renderCalls.length, 1);
    assert.equal(h.renderCalls[0].state, state);
    assert.equal(h.renderCalls[0].maxDimension, 768);
    await flush();
    assert.equal(node.children[0].className, 'daki-canvas-preview-image');
    assert.equal(node.children[0].alt, 'Saved A · 통합 미리보기');
});

test('invalid or failed saved-state composites show an error without fetching details', async () => {
    const h = harness({intersection: false, render: async () => { throw new Error('synthetic composite failure'); }});
    const manager = h.create();
    const invalid = new Container();
    manager.observeState(invalid, {id: 'invalid', savedAt: 1, state: {}});
    assert.equal(invalid.textContent, '통합 그림을 표시할 수 없습니다.');

    const failed = new Container();
    manager.observeState(failed, {id: 'failed', savedAt: 2, state: {layers: []}});
    await flush();
    assert.equal(h.requests.length, 0);
    assert.equal(h.renderCalls.length, 1);
    assert.equal(failed.textContent, '통합 그림을 표시할 수 없습니다.');
    assert.equal(failed.classList.contains('daki-warning'), true);
});

test('saved and project preview identifiers use separate cache namespaces', async () => {
    const h = harness({intersection: false});
    const manager = h.create();
    const saved = new Container(), project = new Container();
    manager.observeState(saved, {id: 'same-id', name: 'Saved', savedAt: 1, state: {layers: []}});
    manager.observe(project, 'same-id', canvas('same-id', {revision: 1}));
    await flush();

    assert.equal(h.requests.length, 1);
    reply(h.requests[0], result('same-id', 'same-id'));
    await flush();
    assert.equal(h.renderCalls.length, 2);
});

test('dispose prevents a late saved-state composite from changing its container', async () => {
    const composite = deferred();
    const h = harness({intersection: false, render: () => composite.promise});
    const manager = h.create();
    const node = new Container();
    manager.observeState(node, {id: 'late-saved', name: 'Late', savedAt: 8, state: {layers: []}});
    await flush();
    assert.equal(h.requests.length, 0);
    assert.equal(h.renderCalls.length, 1);
    manager.dispose();
    composite.resolve('data:image/png;base64,late');
    await flush();
    assert.equal(node.textContent, '불러오는 중…');
    assert.equal(node.children.length, 0);
});

test('failed response validation shows a card error and skips compositing', async () => {
    const h = harness({intersection: false});
    const manager = h.create();
    const node = new Container();
    manager.observe(node, 'project-a', canvas('wrong-side'));
    await flush();
    reply(h.requests[0], result('project-a', 'wrong-side', {side: 'back'}));
    await flush();
    assert.equal(node.textContent, '통합 그림을 표시할 수 없습니다.');
    assert.equal(node.attributes['aria-busy'], 'false');
    assert.equal(node.classList.contains('daki-warning'), true);
    assert.equal(h.renderCalls.length, 0);
});

test('dispose aborts pending work and prevents a late response from changing the DOM', async () => {
    const h = harness({intersection: false});
    const manager = h.create();
    const node = new Container();
    manager.observe(node, 'project-a', canvas('late'));
    await flush();
    const request = h.requests[0];
    manager.dispose();
    assert.equal(request.options.signal.aborted, true);
    reply(request, result('project-a', 'late'));
    await flush();
    manager.observe(new Container(), 'project-a', canvas('after-dispose'));
    assert.equal(node.textContent, '불러오는 중…');
    assert.equal(node.children.length, 0);
    assert.equal(h.requests.length, 1);
    assert.equal(h.renderCalls.length, 0);
});

test('dispose releases image sources and removes the image load listeners', async () => {
    const h = harness({intersection: false, imageAutoLoad: false, render: async ({state, loadImage}) => {
        await loadImage(state.layers[0].src, state.layers[0]);
        return 'data:image/png;base64,too-late';
    }});
    const manager = h.create();
    const node = new Container();
    manager.observe(node, 'project-a', canvas('image-abort'));
    await flush();
    reply(h.requests[0], result('project-a', 'image-abort', {
        layers: [{type: 'image', src: '/image/sample.png', layerWidth: 100, layerHeight: 100}],
    }));
    await flush();
    assert.equal(h.images.length, 1);
    assert.equal(h.images[0].src, 'http://localhost/image/sample.png?preview=768');
    manager.dispose();
    await flush();
    assert.equal(h.images[0].src, '');
    assert.equal(h.images[0].listeners.size, 0);
    assert.equal(node.textContent, '불러오는 중…');
});

test('an image decode failure shows an error and does not block the next queued preview', async () => {
    const h = harness({intersection: false, imageAutoLoad: false, render: async ({state, loadImage}) => {
        if (state.layers.length) await loadImage(state.layers[0].src, state.layers[0]);
        return 'data:image/png;base64,next';
    }});
    const manager = h.create();
    const failed = new Container(), succeeded = new Container(), queued = new Container();
    manager.observe(failed, 'project-a', canvas('decode-failure'));
    manager.observe(succeeded, 'project-a', canvas('already-running'));
    manager.observe(queued, 'project-a', canvas('next-in-queue'));
    await flush();
    assert.equal(h.requests.length, 2);

    reply(h.requests[0], result('project-a', 'decode-failure', {
        layers: [{type: 'image', src: '/image/decode-fails.png', layerWidth: 100, layerHeight: 100}],
    }));
    await flush();
    assert.equal(h.images.length, 1);
    assert.equal(h.requests.length, 2);

    h.images[0].listeners.get('error')();
    await flush();
    assert.equal(failed.textContent, '통합 그림을 표시할 수 없습니다.');
    assert.equal(h.requests.length, 3, 'the failed first slot starts the queued third canvas');
    reply(h.requests[2], result('project-a', 'next-in-queue'));
    reply(h.requests[1], result('project-a', 'already-running'));
    await flush();
    assert.equal(queued.children[0].src, 'data:image/png;base64,next');
    assert.equal(succeeded.children[0].src, 'data:image/png;base64,next');
});

test('same-origin image and canvas-import sources get preview URLs only with saved geometry', async () => {
    const state = {width: 800, height: 600, layers: [
        {type: 'image', src: '/image/folder/sample.png?token=x&preview=128#part', layerWidth: 120, layerHeight: 80},
        {type: 'image', src: '/canvas-imports/sample.png', imageWidth: 320, imageHeight: 200},
        {type: 'image', src: '/image/no-geometry.png', imageWidth: 100},
        {type: 'image', src: 'https://images.example/sample.png', layerWidth: 90, layerHeight: 60},
        {type: 'image', src: 'data:image/png;base64,abc', layerWidth: 90, layerHeight: 60},
    ]};
    const h = harness({intersection: false, render: async ({state: compositeState, loadImage, maxDimension}) => {
        assert.equal(maxDimension, 768);
        for (const layer of compositeState.layers) await loadImage(layer.src, layer);
        return 'data:image/png;base64,composite';
    }});
    const manager = h.create();
    manager.observe(new Container(), 'project-a', canvas('urls'));
    await flush();
    reply(h.requests[0], result('project-a', 'urls', {layers: state.layers}));
    await flush();
    await flush();

    const [withExistingQuery, imported, withoutHeight, remote, data] = h.images.map(image => image.src);
    const firstUrl = new URL(withExistingQuery);
    assert.equal(firstUrl.pathname, '/image/folder/sample.png');
    assert.equal(firstUrl.searchParams.get('token'), 'x');
    assert.equal(firstUrl.searchParams.get('preview'), '768');
    assert.equal(firstUrl.hash, '#part');
    assert.equal(new URL(imported).searchParams.get('preview'), '768');
    assert.equal(withoutHeight, '/image/no-geometry.png');
    assert.equal(remote, 'https://images.example/sample.png');
    assert.equal(data, 'data:image/png;base64,abc');
    assert.deepEqual(state.layers[0], {
        type: 'image', src: '/image/folder/sample.png?token=x&preview=128#part', layerWidth: 120, layerHeight: 80,
    });
});
