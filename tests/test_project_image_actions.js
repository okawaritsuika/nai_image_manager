const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const projectContext = {projectId: 'project-one', side: 'front', candidateId: 'candidate-one'};

function response(status, result) {
    return {status, ok: status >= 200 && status < 300, json: async () => result};
}

function makeElement() {
    return {
        style: {},
        classList: {add() {}, remove() {}, toggle() {}},
        offsetWidth: 220,
        offsetHeight: 140,
        value: '',
        checked: false,
        disabled: false,
        textContent: '',
        innerText: '',
        innerHTML: '',
    };
}

function fixture() {
    const ids = [
        'imageContextMenu', 'galleryContextInpaint', 'galleryContextUpscale',
        'galleryInpaintImage', 'galleryInpaintLayer', 'galleryInpaintMeta',
        'galleryInpaintLoading', 'galleryInpaintLoadingText', 'galleryUpscaleLayer',
        'galleryUpscaleMeta', 'galleryUpscaleWidthInput', 'galleryUpscaleHeightInput',
        'galleryUpscaleRatioInfo', 'galleryUpscaleEngine', 'galleryUpscaleJobList',
        'galleryUpscaleFit516',
    ];
    const elements = new Map(ids.map(id => [id, makeElement()]));
    const document = {
        body: makeElement(),
        getElementById: id => elements.get(id) || null,
        addEventListener() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        createElement(tag) { return createElementImpl(tag); },
    };
    const toasts = [], alerts = [], refreshes = [];
    const storage = new Map();
    let fetchImpl = async () => response(200, {status: 'success'});
    let createElementImpl = () => makeElement();
    let imageLoadImpl = image => image.onload?.();
    const window = {
        document,
        innerWidth: 1200,
        innerHeight: 900,
        location: {hash: '#gallery'},
        addEventListener() {},
        Daki: {refreshProject: async id => { refreshes.push(id); return true; }},
    };
    class MockImage {
        constructor() { this.naturalWidth = 640; this.naturalHeight = 960; }
        set src(value) { this._src = value; imageLoadImpl(this, value); }
        get src() { return this._src; }
    }
    const sandbox = {
        console,
        window,
        document,
        location: window.location,
        navigator: {},
        Image: MockImage,
        fetch: (...args) => fetchImpl(...args),
        alert: message => alerts.push(message),
        confirm: () => true,
        localStorage: {
            getItem: key => storage.get(key) || null,
            setItem: (key, value) => storage.set(key, value),
            removeItem: key => storage.delete(key),
        },
        sessionStorage: {getItem: () => null, setItem() {}, removeItem() {}},
        setTimeout,
        clearTimeout,
        setInterval: () => 1,
        clearInterval() {},
        requestAnimationFrame: callback => callback(),
        cancelAnimationFrame() {},
        ResizeObserver: class { observe() {} disconnect() {} },
    };
    const context = vm.createContext(sandbox);
    for (const filename of ['static/index.js', 'static/gallery_inpaint.js', 'static/gallery_upscale.js']) {
        vm.runInContext(fs.readFileSync(require.resolve(`../${filename}`), 'utf8'), context, {filename});
    }
    context.showToast = message => toasts.push(message);
    context.getImageFileName = value => String(value).split('/').pop();
    return {
        context, window, document, elements, toasts, alerts, refreshes, storage,
        setFetch: fn => { fetchImpl = fn; },
        setCreateElement: fn => { createElementImpl = fn; },
        setImageLoad: fn => { imageLoadImpl = fn; },
        setGlobal: (name, value) => {
            context.__testValue = value;
            vm.runInContext(`${name} = __testValue`, context);
            delete context.__testValue;
        },
        readGlobal: expression => vm.runInContext(expression, context),
        readSession: expression => JSON.parse(JSON.stringify(vm.runInContext(expression, context))),
    };
}

function installClipboardMocks(f, {canvasBlob = null, clipboardWrite} = {}) {
    const writes = [], items = [], objectUrls = [], revokedUrls = [];
    const canvases = [], drawCalls = [], exportTypes = [];
    class MockClipboardItem {
        constructor(payload) {
            this.payload = payload;
            items.push(this);
        }
    }
    f.context.ClipboardItem = MockClipboardItem;
    f.window.ClipboardItem = MockClipboardItem;
    f.context.navigator.clipboard = {
        write: async payload => {
            writes.push(payload);
            if (clipboardWrite) await clipboardWrite(payload);
        },
    };
    f.context.URL = {
        createObjectURL: blob => {
            const url = `blob:synthetic-${objectUrls.length + 1}`;
            objectUrls.push({url, blob});
            return url;
        },
        revokeObjectURL: url => revokedUrls.push(url),
    };
    f.setCreateElement(tag => {
        if (tag !== 'canvas') return makeElement();
        const canvas = {
            width: 0,
            height: 0,
            getContext: type => type === '2d' ? {
                drawImage: (...args) => drawCalls.push(args),
            } : null,
            toBlob: (callback, type) => {
                exportTypes.push(type);
                callback(canvasBlob);
            },
        };
        canvases.push(canvas);
        return canvas;
    });
    return {writes, items, objectUrls, revokedUrls, canvases, drawCalls, exportTypes};
}

function blobResponse(blob) {
    return {status: 200, ok: true, blob: async () => blob};
}

function openMenu(f, path, context = projectContext) {
    f.context.openImageContextMenu({
        preventDefault() {}, stopPropagation() {}, clientX: 80, clientY: 90,
    }, path, `/image/${path}`, context);
}

test('WebP context action passes the selected project side and candidate', () => {
    const f = fixture();
    const calls = [];
    f.window.GalleryImageTools = {openContext: (...args) => calls.push(args)};
    openMenu(f, 'gallery/project.png', projectContext);
    f.context.openGalleryContextWebpDialog();
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['gallery/project.png', projectContext]]);
    openMenu(f, 'gallery/ordinary.png', null);
    f.context.openGalleryContextWebpDialog();
    assert.deepEqual(JSON.parse(JSON.stringify(calls[1])), ['gallery/ordinary.png', null]);
});

function inpaintSession(overrides = {}) {
    return {
        originalPath: '__daki_personal__/same-image.png',
        originalSrc: '/image/__daki_personal__/same-image.png',
        currentSrc: '/image/__daki_personal__/same-image.png',
        projectContext: {...projectContext},
        tempSessionId: 'synthetic-temp-session',
        name: 'same-image.png',
        imageWidth: 640,
        imageHeight: 960,
        promptInfo: {},
        resultSrc: '',
        maskDataUrl: 'data:image/png;base64,synthetic-mask',
        saved: false,
        ...overrides,
    };
}

function prepareInpaint(f) {
    f.context.getEffectiveGalleryInpaintPromptInfo = () => ({steps: 28});
    f.context.showAnlasWarningModal = async () => true;
    f.context.setGalleryInpaintProcessing = () => {};
    f.context.applyGalleryInpaintMaskVisibility = () => {};
}

test('project context allows catalog image actions and invalid context keeps the canvas redirect', async () => {
    const f = fixture();
    const path = '__daki_personal__/same-image.png';
    let canvasRedirects = 0, inpaintOpens = 0, upscaleOpens = 0;
    const actualUpscaleOpen = f.context.openGalleryUpscaleFromContext;
    f.context.sendContextImageToCanvas = () => { canvasRedirects++; };
    f.context.openGalleryInpaintFromContext = () => { inpaintOpens++; };
    f.context.openGalleryUpscaleFromContext = () => { upscaleOpens++; };

    openMenu(f, path, projectContext);
    assert.equal(f.elements.get('galleryContextInpaint').textContent, '인페인팅');
    assert.equal(f.elements.get('galleryContextUpscale').textContent, '업스케일');
    assert.deepEqual(JSON.parse(JSON.stringify(f.readGlobal('activeImageContext.projectContext'))), projectContext);
    await f.context.openContextImageInpaint();
    await f.context.openGalleryUpscaleFromContext();
    assert.equal(inpaintOpens, 1);
    assert.equal(upscaleOpens, 1);
    assert.equal(canvasRedirects, 0);

    f.context.openGalleryUpscaleFromContext = actualUpscaleOpen;
    openMenu(f, path, {projectId: 'project-one', side: 'unknown', candidateId: 'candidate-one'});
    assert.equal(f.readGlobal('activeImageContext.projectContext'), null);
    assert.match(f.elements.get('galleryContextInpaint').textContent, /캔버스로 가져오기/);
    await f.context.openContextImageInpaint();
    assert.equal(canvasRedirects, 1);
    await f.context.openGalleryUpscaleFromContext();
    assert.equal(canvasRedirects, 2);
});

test('canvas prompt transfer keeps cfg_rescale, noise_schedule, and character prompts', async () => {
    const f = fixture();
    openMenu(f, 'gallery/ordinary.png', null);
    f.setFetch(async () => response(200, {status: 'success', data: {
        basePrompt: 'synthetic base', charPrompts: ['synthetic character'],
        cfg_rescale: 0, noise_schedule: 'native',
    }}));

    await f.context.sendContextImageToCanvas();
    const payload = JSON.parse(f.storage.get('naia_canvas_pending_import'));
    assert.equal(payload.promptInfo.cfg_rescale, 0);
    assert.equal(payload.promptInfo.noise_schedule, 'native');
    assert.equal(payload.promptInfo.charPrompt, 'synthetic character');
    assert.equal(payload.projectContext, null);
});

test('canvas transfer captures the project and image before async prompt loading', async () => {
    const f = fixture();
    openMenu(f, 'synthetic/project.png', projectContext);
    let release;
    f.setFetch(() => new Promise(resolve => { release = resolve; }));
    const transfer = f.context.sendContextImageToCanvas();
    openMenu(f, 'synthetic/other.png', {...projectContext, projectId: 'other-project', side: 'back'});
    release(response(200, {status: 'success', data: {basePrompt: 'synthetic prompt'}}));
    await transfer;
    const payload = JSON.parse(f.storage.get('naia_canvas_pending_import'));
    assert.deepEqual(payload.projectContext, projectContext);
    assert.equal(payload.path, 'synthetic/project.png');
    assert.equal(payload.name, 'project.png');
    assert.equal(payload.promptInfo.basePrompt, 'synthetic prompt');
});

test('inpaint context is captured before async image and prompt loading', async () => {
    const f = fixture();
    const opened = [];
    f.context.openGalleryInpaint = () => opened.push(f.readSession('galleryInpaintSession.projectContext'));
    let releaseFirstPrompt;
    f.context.fetchPromptInfoForGalleryPath = () => new Promise(resolve => { releaseFirstPrompt = resolve; });

    openMenu(f, '__daki_personal__/same-image.png', projectContext);
    const firstOpen = f.context.openGalleryInpaintFromContext();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof releaseFirstPrompt, 'function');

    const otherProjectContext = {projectId: 'project-two', side: 'back', candidateId: 'candidate-two'};
    openMenu(f, '__daki_personal__/same-image.png', otherProjectContext);
    releaseFirstPrompt({basePrompt: 'synthetic'});
    await firstOpen;
    assert.equal(f.readGlobal('galleryInpaintSession'), null);

    f.context.fetchPromptInfoForGalleryPath = async () => ({basePrompt: 'synthetic'});
    await f.context.openGalleryInpaintFromContext();
    assert.deepEqual(opened, [otherProjectContext]);
});

test('successful project inpaint is already saved on its captured face and manual save does not duplicate it', async () => {
    const f = fixture();
    const bodies = [];
    f.setGlobal('galleryInpaintSession', inpaintSession());
    prepareInpaint(f);
    f.setFetch(async (url, options) => {
        assert.equal(url, '/api/canvas/inpaint');
        bodies.push(JSON.parse(options.body));
        return response(200, {
            status: 'success', destination: 'project', path: '__daki_exports__/project-one/generated.png',
            src: '/image/__daki_exports__/project-one/generated.png', projectId: 'project-one',
            projectName: 'Synthetic project', side: 'front',
        });
    });

    await f.context.requestGalleryInpaint();
    const session = f.readSession('galleryInpaintSession');
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].source_path, '__daki_personal__/same-image.png');
    assert.deepEqual(bodies[0].projectContext, projectContext);
    assert.equal(session.originalPath, '__daki_personal__/same-image.png');
    assert.equal(session.resultSrc, '/image/__daki_exports__/project-one/generated.png');
    assert.equal(session.currentSrc, session.resultSrc);
    assert.equal(session.saved, true);
    assert.equal(session.savedPath, '__daki_exports__/project-one/generated.png');
    assert.deepEqual(f.refreshes, ['project-one']);
    assert.match(f.toasts[0], /Synthetic project · 앞면 후보/);

    await f.context.saveGalleryInpaintResultAsNew();
    assert.equal(bodies.length, 1);
});

test('inpaint duplicate calls dispatch once and a failed request retains the previous result', async () => {
    const f = fixture();
    const oldSession = inpaintSession({
        currentSrc: '/image/previous-result.png', resultSrc: '/image/previous-result.png',
        saved: true, savedPath: '__daki_exports__/previous.png', autoSavedToProject: true,
    });
    f.setGlobal('galleryInpaintSession', oldSession);
    prepareInpaint(f);
    let releaseResponse;
    let requests = 0;
    f.setFetch(() => {
        requests++;
        return new Promise(resolve => { releaseResponse = resolve; });
    });

    const first = f.context.requestGalleryInpaint();
    await new Promise(resolve => setImmediate(resolve));
    await f.context.requestGalleryInpaint();
    assert.equal(requests, 1);
    releaseResponse(response(500, {status: 'error', message: 'Synthetic failure'}));
    await first;

    const session = f.readSession('galleryInpaintSession');
    assert.equal(session.currentSrc, '/image/previous-result.png');
    assert.equal(session.resultSrc, '/image/previous-result.png');
    assert.equal(session.saved, true);
    assert.equal(session.savedPath, '__daki_exports__/previous.png');
    assert.equal(session.requestPending, false);
    assert.match(f.alerts[0], /Synthetic failure/);
});

test('ordinary inpaint requests omit project-only fields and keep unsaved result behavior', async () => {
    const f = fixture();
    f.setGlobal('galleryInpaintSession', inpaintSession({
        originalPath: 'gallery/ordinary.png', originalSrc: '/image/gallery/ordinary.png',
        currentSrc: '/image/gallery/ordinary.png', projectContext: null,
    }));
    prepareInpaint(f);
    let body;
    f.setFetch(async (url, options) => {
        body = JSON.parse(options.body);
        return response(200, {status: 'success', src: '/image/temp/result.png'});
    });

    await f.context.requestGalleryInpaint();
    assert.equal(Object.hasOwn(body, 'projectContext'), false);
    assert.equal(Object.hasOwn(body, 'source_path'), false);
    assert.equal(f.readGlobal('galleryInpaintSession').saved, false);
    assert.match(f.readGlobal('galleryInpaintSession').resultSrc, /temp\/result\.png\?t=/);
});

test('a delayed project inpaint response does not mutate a newly opened session', async () => {
    const f = fixture();
    const firstSession = inpaintSession();
    f.setGlobal('galleryInpaintSession', firstSession);
    prepareInpaint(f);
    let releaseResponse;
    let requestBody;
    f.setFetch((url, options) => {
        requestBody = JSON.parse(options.body);
        return new Promise(resolve => { releaseResponse = resolve; });
    });

    const pending = f.context.requestGalleryInpaint();
    await new Promise(resolve => setImmediate(resolve));
    const nextSession = inpaintSession({
        originalPath: '__daki_personal__/other.png', currentSrc: '/image/other.png', resultSrc: '',
        projectContext: {projectId: 'project-two', side: 'back', candidateId: 'candidate-two'},
    });
    f.setGlobal('galleryInpaintSession', nextSession);
    releaseResponse(response(200, {
        status: 'success', destination: 'project', path: '__daki_exports__/project-one/generated.png',
        src: '/image/__daki_exports__/project-one/generated.png', projectId: 'project-one',
    }));
    await pending;

    assert.deepEqual(requestBody.projectContext, projectContext);
    assert.equal(f.readGlobal('galleryInpaintSession').originalPath, '__daki_personal__/other.png');
    assert.equal(f.readGlobal('galleryInpaintSession').resultSrc, '');
    assert.deepEqual(f.refreshes, ['project-one']);
    assert.deepEqual(f.toasts, []);
});

test('upscale opens from a project card, captures its context, and prevents duplicate starts', async () => {
    const f = fixture();
    openMenu(f, '__daki_personal__/same-image.png', projectContext);
    f.context.applyGalleryUpscalePreset = () => {};
    f.context.getGalleryUpscaleInputSize = () => ({width: 1200, height: 1800});
    f.context.getSelectedGalleryUpscaleQuality = () => 'high';
    let closeCount = 0, panelCount = 0, pollCount = 0;
    f.context.closeGalleryUpscaleModal = () => { closeCount++; };
    f.context.showGalleryUpscaleJobsPanel = () => { panelCount++; };
    f.context.startGalleryUpscalePolling = () => { pollCount++; };

    await f.context.openGalleryUpscaleFromContext();
    assert.deepEqual(f.readSession('galleryUpscaleSession.projectContext'), projectContext);
    let releaseResponse;
    const bodies = [];
    f.setFetch((url, options) => {
        assert.equal(url, '/api/gallery/upscale/start');
        bodies.push(JSON.parse(options.body));
        return new Promise(resolve => { releaseResponse = resolve; });
    });

    const first = f.context.startGalleryUpscale();
    await new Promise(resolve => setImmediate(resolve));
    await f.context.startGalleryUpscale();
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].source_path, '__daki_personal__/same-image.png');
    assert.deepEqual(bodies[0].projectContext, projectContext);
    releaseResponse(response(200, {status: 'started'}));
    await first;
    assert.equal(closeCount, 1);
    assert.equal(panelCount, 1);
    assert.equal(pollCount, 1);
    assert.equal(f.readGlobal('galleryUpscaleSession.startPending'), false);
});

test('ordinary upscale requests omit project context and failed starts restore pending state', async () => {
    const f = fixture();
    f.setGlobal('galleryUpscaleSession', {
        originalPath: 'gallery/ordinary.png', originalSrc: '/image/gallery/ordinary.png',
        name: 'ordinary.png', imageWidth: 640, imageHeight: 960,
    });
    f.context.getGalleryUpscaleInputSize = () => ({width: 1200, height: 1800});
    f.context.getSelectedGalleryUpscaleQuality = () => 'standard';
    const bodies = [];
    f.setFetch(async (url, options) => {
        bodies.push(JSON.parse(options.body));
        return response(500, {status: 'error', message: 'Synthetic failure'});
    });

    await f.context.startGalleryUpscale();
    assert.equal(Object.hasOwn(bodies[0], 'projectContext'), false);
    assert.equal(f.readGlobal('galleryUpscaleSession.startPending'), false);
    assert.match(f.alerts[0], /Synthetic failure/);
});

test('completed project upscale refreshes its matching project while ordinary completion keeps gallery reload', async () => {
    const f = fixture();
    let loadCount = 0;
    f.context.loadData = async () => { loadCount++; };
    f.setGlobal('galleryUpscalePollingInitialized', true);
    f.setFetch(async () => response(200, {status: 'success', jobs: [{
        id: 'project-job', status: 'done', destination: 'project', projectId: 'project-one',
        projectName: 'Synthetic project', side: 'back',
    }]}));

    await f.context.pollGalleryUpscaleJobsOnce();
    assert.deepEqual(f.refreshes, ['project-one']);
    assert.equal(loadCount, 0);
    assert.match(f.toasts.at(-1), /Synthetic project · 뒷면 후보/);

    f.setFetch(async () => response(200, {status: 'success', jobs: [{id: 'gallery-job', status: 'done'}]}));
    await f.context.pollGalleryUpscaleJobsOnce();
    assert.equal(loadCount, 1);
    assert.deepEqual(f.refreshes, ['project-one']);
});

test('gallery context copy converts WebP to PNG at natural dimensions and revokes its temporary URL', async () => {
    const f = fixture();
    const sourceBlob = {type: 'image/webp', marker: 'synthetic-webp'};
    const pngBlob = {type: 'image/png', marker: 'synthetic-png'};
    const clipboard = installClipboardMocks(f, {canvasBlob: pngBlob});
    const requestedUrls = [];
    f.setFetch(async url => {
        requestedUrls.push(url);
        return blobResponse(sourceBlob);
    });
    openMenu(f, 'gallery/synthetic.webp', null);

    await f.context.copyContextImage();

    assert.deepEqual(requestedUrls, ['/image/gallery/synthetic.webp']);
    assert.deepEqual(clipboard.objectUrls, [{url: 'blob:synthetic-1', blob: sourceBlob}]);
    assert.deepEqual(clipboard.exportTypes, ['image/png']);
    assert.equal(clipboard.canvases[0].width, 640);
    assert.equal(clipboard.canvases[0].height, 960);
    assert.equal(clipboard.drawCalls.length, 1);
    assert.equal(clipboard.drawCalls[0][1], 0);
    assert.equal(clipboard.drawCalls[0][2], 0);
    assert.equal(clipboard.drawCalls[0][0].naturalWidth, 640);
    assert.equal(clipboard.drawCalls[0][0].naturalHeight, 960);
    assert.equal(clipboard.items.length, 1);
    assert.equal(clipboard.items[0].payload['image/png'], pngBlob);
    assert.deepEqual(clipboard.revokedUrls, ['blob:synthetic-1']);
    assert.deepEqual(f.toasts, ['✓ 복사했습니다.']);
    assert.equal(f.alerts.length, 0);
});

test('gallery context copy keeps PNG blob identity and skips image conversion', async () => {
    const f = fixture();
    const pngBlob = {type: 'image/png', marker: 'original-png'};
    const clipboard = installClipboardMocks(f, {canvasBlob: {type: 'image/png', marker: 'unused'}});
    let requestedUrl;
    f.setFetch(async url => {
        requestedUrl = url;
        return blobResponse(pngBlob);
    });
    openMenu(f, 'gallery/synthetic.png', null);

    await f.context.copyContextImage();

    assert.equal(requestedUrl, '/image/gallery/synthetic.png');
    assert.equal(clipboard.items[0].payload['image/png'], pngBlob);
    assert.equal(clipboard.objectUrls.length, 0);
    assert.equal(clipboard.drawCalls.length, 0);
    assert.deepEqual(clipboard.exportTypes, []);
});

test('gallery context copy converts JPEG and empty-MIME blobs to PNG', async t => {
    for (const mimeType of ['image/jpeg', '']) {
        await t.test(`source MIME ${JSON.stringify(mimeType)}`, async () => {
            const f = fixture();
            const sourceBlob = {type: mimeType, marker: 'synthetic-source'};
            const pngBlob = {type: 'image/png', marker: 'synthetic-png'};
            const clipboard = installClipboardMocks(f, {canvasBlob: pngBlob});
            f.setFetch(async () => blobResponse(sourceBlob));
            openMenu(f, 'gallery/synthetic-source', null);

            await f.context.copyContextImage();

            assert.deepEqual(clipboard.exportTypes, ['image/png']);
            assert.equal(clipboard.items[0].payload['image/png'], pngBlob);
            assert.deepEqual(clipboard.revokedUrls, ['blob:synthetic-1']);
        });
    }
});

test('gallery context copy rejects an HTTP error before reading or writing a blob', async () => {
    const f = fixture();
    const sourceBlob = {type: 'image/webp', marker: 'must-not-be-read'};
    const clipboard = installClipboardMocks(f, {canvasBlob: {type: 'image/png'}});
    let blobCalls = 0;
    f.setFetch(async () => ({
        status: 503,
        ok: false,
        blob: async () => { blobCalls++; return sourceBlob; },
    }));
    openMenu(f, 'gallery/unavailable.webp', null);

    await f.context.copyContextImage();

    assert.equal(blobCalls, 0);
    assert.equal(clipboard.writes.length, 0);
    assert.equal(clipboard.objectUrls.length, 0);
    assert.match(f.alerts[0], /이미지 복사 실패:/);
});

test('gallery context copy revokes its temporary URL after image decode failure', async () => {
    const f = fixture();
    const clipboard = installClipboardMocks(f);
    f.setFetch(async () => blobResponse({type: 'image/webp'}));
    f.setImageLoad(image => image.onerror?.());
    openMenu(f, 'gallery/broken.webp', null);

    await f.context.copyContextImage();

    assert.deepEqual(clipboard.revokedUrls, ['blob:synthetic-1']);
    assert.equal(clipboard.writes.length, 0);
    assert.match(f.alerts[0], /이미지 복사 실패:/);
});

test('gallery context copy revokes its temporary URL when PNG canvas export returns null', async () => {
    const f = fixture();
    const clipboard = installClipboardMocks(f, {canvasBlob: null});
    f.setFetch(async () => blobResponse({type: 'image/webp'}));
    openMenu(f, 'gallery/unexportable.webp', null);

    await f.context.copyContextImage();

    assert.deepEqual(clipboard.exportTypes, ['image/png']);
    assert.deepEqual(clipboard.revokedUrls, ['blob:synthetic-1']);
    assert.equal(clipboard.writes.length, 0);
    assert.match(f.alerts[0], /이미지 복사 실패:/);
});

test('gallery context copy keeps the existing failure alert when clipboard write rejects', async () => {
    const f = fixture();
    const clipboard = installClipboardMocks(f, {
        clipboardWrite: async () => { throw new Error('Synthetic clipboard rejection'); },
    });
    f.setFetch(async () => blobResponse({type: 'image/png', marker: 'original-png'}));
    openMenu(f, 'gallery/synthetic.png', null);

    await f.context.copyContextImage();

    assert.equal(clipboard.writes.length, 1);
    assert.match(f.alerts[0], /이미지 복사 실패: Synthetic clipboard rejection/);
});

test('upscale multipliers remain selected when 5:16 cropping is enabled', async () => {
    const f = fixture();
    f.setGlobal('galleryUpscaleSession', {originalPath: 'synthetic.png', imageWidth: 1000, imageHeight: 2000});
    f.elements.get('galleryUpscaleEngine').value = 'lanczos';
    f.elements.get('galleryUpscaleFit516').checked = true;
    for (const scale of [2, 4]) {
        f.context.applyGalleryUpscaleMultiplierPreset(scale);
        assert.deepEqual(JSON.parse(JSON.stringify(f.context.getGalleryUpscaleInputSize())), {width: 1000 * scale, height: 2000 * scale});
        assert.equal(f.elements.get('galleryUpscaleFit516').checked, true);
        assert.equal(f.elements.get('galleryUpscaleWidthInput').disabled, false);
        assert.match(f.elements.get('galleryUpscaleRatioInfo').innerText, new RegExp(`${625 * scale} × ${2000 * scale}px`));
    }
    let payload;
    f.setFetch(async (_url, options) => {
        payload = JSON.parse(options.body);
        return response(400, {status: 'error', message: 'synthetic stop'});
    });
    await f.context.startGalleryUpscale();
    assert.equal(payload.fit_5_16, true);
    assert.equal(payload.target_width, 4000);
    assert.equal(payload.target_height, 8000);
});
