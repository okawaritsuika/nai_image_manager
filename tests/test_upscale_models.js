const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'upscale_models.js'), 'utf8');

function makeElement() {
    const listeners = new Map();
    const progress = {setAttribute(name, value) { this[name] = value; }};
    return {
        hidden: false,
        disabled: false,
        value: '',
        textContent: '',
        style: {},
        dataset: {},
        listeners,
        addEventListener(type, callback) { listeners.set(type, callback); },
        async click() { return listeners.get('click')?.(); },
        change() { return listeners.get('change')?.(); },
        querySelector() { return progress; },
        setAttribute(name, value) { this[name] = value; },
        progress,
    };
}

function model(id, state, extra = {}) {
    return {
        id,
        name: id,
        description: `synthetic ${id}`,
        installed: state === 'installed',
        state,
        progress: state === 'downloading' ? 35 : 0,
        message: '',
        download_bytes: 1024 * 1024 * 900,
        requires_runtime: id === 'illustrationjanai' || id === 'animesharp',
        runtime_installed: false,
        ...extra,
    };
}

function success(models) {
    return {status: 'success', models};
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function response(payload, status = 200) {
    return {ok: status >= 200 && status < 300, status, json: async () => payload};
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
}

function fixture({engine = 'realcugan', dimensions = {width: 640, height: 960}, statusModels = []} = {}) {
    const prefix = 'galleryUpscale';
    const ids = [
        'ModelName', 'ModelState', 'ModelDescription', 'ModelMessage', 'ModelProgressArea',
        'ModelProgressBar', 'ModelProgressText', 'ModelDownload', 'ModelCancel', 'ModelDelete',
        'ModelRetry', 'NaiRetry', 'NaiPreview', 'NaiSteps', 'WaifuWebsite', 'WaifuInfo',
        'ResolutionSection', 'QualitySection', 'Start',
    ];
    const elements = new Map(ids.map(id => [`${prefix}${id}`, makeElement()]));
    elements.set('galleryUpscaleLayer', makeElement());
    elements.set('galleryUpscaleEngine', makeElement());
    elements.get('galleryUpscaleLayer').style.display = 'flex';
    elements.get('galleryUpscaleEngine').value = engine;
    const document = {getElementById: id => elements.get(id) || null};
    const timers = new Map();
    let timerSeq = 0;
    const confirms = [];
    let confirmResult = true;
    const calls = [];
    let identity = 'synthetic-source';
    let targetSize = {width: 2500, height: 8000};
    let fetchImpl = async url => {
        calls.push({url});
        if (url === '/api/upscale/models') return response(success(statusModels));
        throw new Error(`Unexpected URL ${url}`);
    };
    const window = {
        document,
        fetch: (...args) => fetchImpl(...args),
        confirm: message => { confirms.push(message); return confirmResult; },
        addEventListener() {},
        setInterval(callback, delay) { const id = ++timerSeq; timers.set(id, {callback, delay}); return id; },
        clearInterval(id) { timers.delete(id); },
        UpscaleModelPanel: null,
    };
    const context = vm.createContext({window, document, AbortController, console});
    vm.runInContext(source, context, {filename: 'static/upscale_models.js'});
    const panel = window.UpscaleModelPanel.create({
        prefix,
        layerId: 'galleryUpscaleLayer',
        engineSelectId: 'galleryUpscaleEngine',
        resolutionSectionId: 'galleryUpscaleResolutionSection',
        qualitySectionId: 'galleryUpscaleQualitySection',
        startButtonId: 'galleryUpscaleStart',
        getTargetDimensions: () => ({...targetSize}),
        setTargetDimensions: (width, height) => { targetSize = {width, height}; },
        getQuality: () => 'high',
        sourceDimensions: () => dimensions,
        sourceIdentity: () => identity,
    });
    return {
        panel,
        window,
        document,
        elements,
        calls,
        confirms,
        timers,
        fetch: fn => { fetchImpl = fn; },
        setConfirm: value => { confirmResult = value; },
        setIdentity: value => { identity = value; },
        targetSize: () => targetSize,
        element: suffix => elements.get(`${prefix}${suffix}`),
        selected: value => { elements.get('galleryUpscaleEngine').value = value; return elements.get('galleryUpscaleEngine').change(); },
    };
}

test('missing model blocks prepare, explicit download installs it, and selection never auto-downloads', async () => {
    let current = model('illustrationjanai', 'missing');
    const f = fixture({engine: 'illustrationjanai', statusModels: [current]});
    f.fetch(async (url, options = {}) => {
        f.calls.push({url, options});
        if (url === '/api/upscale/models' && options.method !== 'POST') return response(success([current]));
        if (url.endsWith('/illustrationjanai/download')) {
            current = model('illustrationjanai', 'installed');
            return response(success([current]));
        }
        throw new Error(`Unexpected URL ${url}`);
    });

    await f.panel.open();
    assert.equal(f.element('ModelState').textContent, '설치 필요');
    assert.equal(f.element('Start').disabled, true);
    assert.equal(f.element('ModelDownload').hidden, false);
    assert.equal(f.calls.some(call => call.options?.method === 'POST'), false);
    assert.equal(await f.panel.prepare(), null);

    await f.element('ModelDownload').click();
    assert.equal(f.calls.some(call => call.url.endsWith('/illustrationjanai/download')), true);
    assert.equal(f.element('ModelState').textContent, '설치됨');
    assert.equal(f.element('Start').disabled, false);
    assert.deepEqual(plain(await f.panel.prepare()), {
        engine: 'illustrationjanai', target_width: 2500, target_height: 8000, quality: 'standard',
    });
});

test('downloading model can be cancelled and installed model deletion confirms retained images once', async () => {
    let current = model('animesharp', 'downloading', {progress: 47, downloaded_bytes: 1024 * 1024 * 450, message: 'synthetic progress'});
    let other = model('illustrationjanai', 'missing');
    const f = fixture({engine: 'animesharp', statusModels: [current, other]});
    f.fetch(async (url, options = {}) => {
        f.calls.push({url, options});
        if (url === '/api/upscale/models') return response(success([current, other]));
        if (url.endsWith('/animesharp/cancel')) {
            current = model('animesharp', 'cancelled');
            return response(success([current, other]));
        }
        if (url.endsWith('/animesharp/delete')) {
            current = model('animesharp', 'missing');
            return response(success([current, other]));
        }
        throw new Error(`Unexpected URL ${url}`);
    });

    await f.panel.open();
    assert.equal(f.element('ModelProgressArea').hidden, false);
    assert.equal(f.element('ModelProgressBar').style.width, '50%');
    assert.equal(f.element('ModelProgressText').textContent, '다운로드 50.0% · 450 MB / 900 MB');
    assert.equal(f.element('Start').disabled, true);
    assert.equal(f.element('ModelCancel').hidden, false);
    await f.element('ModelCancel').click();
    assert.equal(f.calls.some(call => call.url.endsWith('/animesharp/cancel')), true);
    assert.equal(f.element('ModelState').textContent, '취소됨');

    current = model('animesharp', 'installed', {requires_runtime: true, runtime_installed: true});
    await f.panel.refresh();
    await f.element('ModelDelete').click();
    assert.equal(f.confirms.length, 1);
    assert.match(f.confirms[0], /원본 이미지와 업스케일 결과는 보존됩니다/);
    assert.match(f.confirms[0], /공용 실행 환경도 함께 삭제됩니다/);
    assert.equal(f.calls.some(call => call.url.endsWith('/animesharp/delete')), true);
});

test('download byte progress shows installation at 100 percent and falls back when bytes are unavailable', async () => {
    let current = model('animesharp', 'downloading', {
        progress: 95,
        downloaded_bytes: 1024 * 1024 * 900,
        download_bytes: 1024 * 1024 * 900,
    });
    const other = model('illustrationjanai', 'missing');
    const f = fixture({engine: 'animesharp', statusModels: [current, other]});
    f.fetch(async url => {
        if (url === '/api/upscale/models') return response(success([current, other]));
        throw new Error(`Unexpected URL ${url}`);
    });

    await f.panel.open();
    assert.equal(f.element('ModelProgressBar').style.width, '100%');
    assert.equal(f.element('ModelProgressText').textContent, '다운로드 100% · 설치 중 · 900 MB / 900 MB');

    current = model('animesharp', 'downloading', {progress: 47});
    await f.panel.refresh();
    assert.equal(f.element('ModelProgressBar').style.width, '47%');
    assert.equal(f.element('ModelProgressText').textContent, '47%');
});

test('partial model files remain deletable when the server sets can_delete', async () => {
    const partial = model('illustrationjanai', 'error', {
        installed: false,
        can_delete: true,
        runtime_installed: true,
        message: 'synthetic partial download',
    });
    const other = model('animesharp', 'missing');
    const f = fixture({engine: 'illustrationjanai', statusModels: [partial, other]});
    f.fetch(async (url, options = {}) => {
        f.calls.push({url, options});
        if (url === '/api/upscale/models') return response(success([partial, other]));
        if (url.endsWith('/illustrationjanai/delete')) return response(success([
            model('illustrationjanai', 'missing', {can_delete: false, runtime_installed: false}), other,
        ]));
        throw new Error(`Unexpected URL ${url}`);
    });

    await f.panel.open();
    assert.equal(f.element('ModelDelete').hidden, false);
    assert.equal(f.element('ModelDownload').hidden, false);
    await f.element('ModelDelete').click();
    assert.equal(f.confirms.length, 1);
    assert.match(f.confirms[0], /공용 실행 환경도 함께 삭제됩니다/);
    assert.equal(f.calls.some(call => call.url.endsWith('/illustrationjanai/delete')), true);
});

test('status network error does not claim missing or installed and retry refreshes state', async () => {
    const f = fixture({engine: 'waifu2x'});
    let fail = true;
    f.fetch(async (url, options = {}) => {
        f.calls.push({url, options});
        if (url !== '/api/upscale/models') throw new Error(`Unexpected URL ${url}`);
        if (fail) throw new Error('offline');
        return response(success([model('waifu2x', 'missing')]));
    });

    await f.panel.open();
    assert.equal(f.element('ModelState').textContent, '상태 확인 필요');
    assert.match(f.element('ModelMessage').textContent, /불러오지 못했습니다/);
    assert.equal(f.element('Start').disabled, true);
    assert.equal(f.element('ModelDownload').hidden, true);
    assert.equal(f.element('ModelDelete').hidden, true);
    assert.equal(f.element('ModelRetry').hidden, false);

    fail = false;
    await f.element('ModelRetry').click();
    assert.equal(f.element('ModelState').textContent, '설치 필요');
    assert.equal(f.element('Start').disabled, true);
    assert.equal(f.element('ModelDownload').hidden, false);
});

test('a server busy response remains visible until the user retries status', async () => {
    const current = model('illustrationjanai', 'missing');
    const f = fixture({engine: 'illustrationjanai', statusModels: [current]});
    f.fetch(async (url, options = {}) => {
        f.calls.push({url, options});
        if (url === '/api/upscale/models') return response(success([current]));
        if (url.endsWith('/illustrationjanai/download')) {
            return response({status: 'error', message: '다른 모델을 설치 중입니다.'}, 409);
        }
        throw new Error(`Unexpected URL ${url}`);
    });

    await f.panel.open();
    await f.element('ModelDownload').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.element('ModelState').textContent, '상태 확인 필요');
    assert.match(f.element('ModelMessage').textContent, /다른 모델을 설치 중입니다/);
    assert.equal(f.element('ModelDownload').hidden, true);
    await f.element('ModelRetry').click();
    assert.equal(f.element('ModelState').textContent, '설치 필요');
    assert.equal(f.element('ModelDownload').hidden, false);
});

test('a closed dialog discards an older status response', async () => {
    const pending = deferred();
    const f = fixture();
    f.fetch(async () => pending.promise);
    const opening = f.panel.open();
    f.panel.close();
    pending.resolve(response(success([model('realcugan', 'installed')])));
    await opening;
    assert.notEqual(f.element('ModelState').textContent, '설치됨');
    assert.equal(f.timers.size, 0);
});

test('a NAI preview for a source that changes while loading is discarded', async () => {
    const pending = deferred();
    const f = fixture({engine: 'nai', dimensions: {width: 1024, height: 2048}});
    f.fetch(async url => {
        if (url === '/api/upscale/models') return response(success([]));
        if (url === '/api/upscale/nai/preview') return pending.promise;
        throw new Error(`Unexpected URL ${url}`);
    });
    const opening = f.panel.open();
    assert.equal(f.element('Start').disabled, true);
    f.setIdentity('second-source');
    pending.resolve(response({status: 'success', plan: {
        source_width: 1024, source_height: 2048,
        crop_box: [192, 0, 832, 2048], crop_width: 640, crop_height: 2048,
        input_width: 320, input_height: 1024, output_width: 640, output_height: 2048,
    }}));
    await opening;
    assert.equal(f.element('NaiSteps').textContent, '');
    assert.deepEqual(f.targetSize(), {width: 2500, height: 8000});
});

test('closing while prepare awaits keeps NAI blocked until a fresh preview and skips confirmation', async () => {
    const pending = deferred();
    const f = fixture({engine: 'nai', dimensions: {width: 1024, height: 2048}});
    f.fetch(async url => {
        if (url === '/api/upscale/models') return response(success([]));
        if (url === '/api/upscale/nai/preview') return pending.promise;
        throw new Error(`Unexpected URL ${url}`);
    });
    const opening = f.panel.open();
    const preparing = f.panel.prepare();
    assert.equal(f.element('Start').disabled, true);
    f.panel.close();
    pending.resolve(response({status: 'success', plan: {
        source_width: 1024, source_height: 2048,
        crop_box: [192, 0, 832, 2048], crop_width: 640, crop_height: 2048,
        input_width: 320, input_height: 1024, output_width: 640, output_height: 2048,
    }}));
    await Promise.all([opening, preparing]);
    assert.equal(f.element('Start').disabled, true);
    assert.equal(f.confirms.length, 0);
    await f.panel.open();
    assert.equal(f.element('Start').disabled, false);
});

test('a caller-disabled start button remains disabled after panel state updates', async () => {
    const f = fixture({engine: 'realcugan', statusModels: [model('realcugan', 'installed')]});
    await f.panel.open();
    assert.equal(f.element('Start').disabled, false);
    f.element('Start').disabled = true;
    assert.equal(await f.panel.prepare(), null);
    assert.equal(f.element('Start').disabled, true);
    f.selected('lanczos');
    assert.equal(f.element('Start').disabled, true);
});

test('status polling reuses an in-flight request instead of overlapping', async () => {
    const pending = deferred();
    const f = fixture();
    let fetchCount = 0;
    f.fetch(async () => { fetchCount++; return pending.promise; });
    const opening = f.panel.open();
    assert.equal(f.timers.size, 1);
    [...f.timers.values()][0].callback();
    assert.equal(fetchCount, 1);
    pending.resolve(response(success([model('realcugan', 'installed')])));
    await opening;
    [...f.timers.values()][0].callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fetchCount, 2);
    f.panel.close();
    assert.equal(f.timers.size, 0);
});

test('NAI preview shows crop and 2x dimensions, and confirmation can be declined or accepted', async () => {
    const dimensions = {width: 1024, height: 2048};
    const f = fixture({engine: 'nai', dimensions});
    let previews = 0;
    const plan = {
        source_width: 1024, source_height: 2048,
        crop_box: [192, 0, 832, 2048], crop_width: 640, crop_height: 2048,
        input_width: 320, input_height: 1024,
        output_width: 640, output_height: 2048,
        cropped: true, resized: true,
    };
    f.fetch(async (url, options = {}) => {
        f.calls.push({url, options});
        if (url === '/api/upscale/models') return response(success([]));
        if (url === '/api/upscale/nai/preview') {
            previews++;
            assert.deepEqual(JSON.parse(options.body), dimensions);
            return response({status: 'success', plan});
        }
        throw new Error(`Unexpected URL ${url}`);
    });

    await f.panel.open();
    assert.equal(f.element('Start').disabled, false);
    assert.match(f.element('NaiSteps').textContent, /원본 1,024 × 2,048px → 중앙 크롭 640 × 2,048px → NAI 입력 320 × 1,024px → 2× 출력 640 × 2,048px/);
    assert.deepEqual(f.targetSize(), {width: 2500, height: 8000});
    assert.equal(f.element('ResolutionSection').hidden, true);
    assert.equal(f.element('QualitySection').hidden, true);

    f.setConfirm(false);
    assert.equal(await f.panel.prepare(), null);
    assert.match(f.confirms[0], /Anlas가 소모될 수 있습니다\. 정확한 비용은 이 앱에서 계산하지 않습니다\./);
    assert.equal(/Anlas\s*[:=]\s*\d+/i.test(f.confirms[0]), false);

    f.setConfirm(true);
    assert.deepEqual(plain(await f.panel.prepare()), {
        engine: 'nai', target_width: 640, target_height: 2048, quality: 'standard', nai_confirmed: true,
    });
    assert.equal(previews, 3);
    f.selected('lanczos');
    assert.deepEqual(plain(await f.panel.prepare()), {
        engine: 'lanczos', target_width: 2500, target_height: 8000, quality: 'standard',
    });
    assert.equal(f.panel !== null, true);
});

test('waifu2x link is separate from local processing and is hidden for other engines', async () => {
    const f = fixture({engine: 'waifu2x', statusModels: [model('waifu2x', 'installed')]});
    await f.panel.open();
    const link = f.element('WaifuWebsite');
    assert.equal(link.hidden, false);
    f.selected('lanczos');
    assert.equal(link.hidden, true);
    assert.equal(f.element('ModelState').textContent, '설치 불필요');
});

test('both pages load the shared controller before their upscale caller scripts', () => {
    const root = path.join(__dirname, '..');
    const gallery = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const canvas = fs.readFileSync(path.join(root, 'canvas.html'), 'utf8');
    assert.ok(gallery.indexOf('/static/upscale_models.js') < gallery.indexOf('/static/gallery_upscale.js'));
    assert.ok(canvas.indexOf('/static/upscale_models.js') < canvas.indexOf('/static/canvas_reference.js'));
    assert.match(gallery, /href="\/static\/upscale_models\.css"/);
    assert.match(canvas, /href="\/static\/upscale_models\.css"/);
    for (const html of [gallery, canvas]) {
        for (const id of ['realcugan', 'waifu2x', 'lanczos', 'illustrationjanai', 'animesharp', 'nai']) {
            assert.match(html, new RegExp(`option value="${id}"`));
        }
        assert.match(html, /href="https:\/\/unlimited\.waifu2x\.net\/" target="_blank" rel="noopener"/);
        assert.match(html, /브라우저에서 처리하므로 PC 성능 영향을 받습니다\. 이미지는 업로드되지/);
    }
    assert.match(source, /NVIDIA GPU용 선택 다운로드/);
});
