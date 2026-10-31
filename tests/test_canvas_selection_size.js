const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {afterEach, test} = require('node:test');

const canvasSource = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas.js'), 'utf8');
const CanvasInpaintReference = require(path.join(__dirname, '..', 'static', 'canvas_inpaint_reference.js'));
const FREE_AREA_LIMIT = 1024 * 1024;

afterEach(() => {
    CanvasInpaintReference.restore({reference: null, showArea: false, include: false});
});

function extractFunction(source, name) {
    const marker = `function ${name}(`;
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, `expected ${name} in its source file`);
    let index = source.indexOf('(', start);
    let parentheses = 0;
    for (; index < source.length; index += 1) {
        if (source[index] === '(') parentheses += 1;
        if (source[index] === ')') parentheses -= 1;
        if (parentheses === 0) break;
    }
    const brace = source.indexOf('{', index + 1);
    let depth = 0;
    for (let index = brace; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') depth -= 1;
        if (depth === 0) return source.slice(start, index + 1);
    }
    assert.fail(`expected closing brace for ${name}`);
}

function makeTooltip(width = 180, height = 52) {
    const classes = new Set();
    return {
        style: {},
        innerText: '',
        classList: {
            toggle(name, force) {
                if (force) classes.add(name);
                else classes.delete(name);
            },
            contains(name) { return classes.has(name); }
        },
        getBoundingClientRect() { return {width, height}; }
    };
}

function makeTooltipContext({referenceApi, windowWidth = 1280, windowHeight = 900, tooltipWidth, tooltipHeight} = {}) {
    const tooltip = makeTooltip(tooltipWidth, tooltipHeight);
    const context = {
        SELECTION_MIN_SIZE: 64,
        SELECTION_SIZE_STEP: 64,
        NAI_FREE_AREA_LIMIT: FREE_AREA_LIMIT,
        getSelectionSizeTooltip: () => tooltip,
        window: {innerWidth: windowWidth, innerHeight: windowHeight}
    };
    if (referenceApi !== undefined) context.CanvasInpaintReference = referenceApi;
    vm.createContext(context);
    vm.runInContext([
        extractFunction(canvasSource, 'snapToSelectionStep'),
        extractFunction(canvasSource, 'updateSelectionSizeTooltip')
    ].join('\n'), context);
    return {context, tooltip};
}

function restoreReference(width = 320, include = true) {
    CanvasInpaintReference.restore({
        reference: {
            src: '/canvas-imports/synthetic.png',
            name: 'Synthetic reference',
            width,
            x: 0.5,
            y: 0.5,
            zoom: 1
        },
        showArea: false,
        include
    });
}

function tooltipCalls(source) {
    return [...source.matchAll(/updateSelectionSizeTooltip\(([^;]*?)\);/gs)];
}

test('selection resize start and drag updates pass the selection flag', () => {
    for (const name of ['startSelectionResizeDrag', 'handleSelectionResize']) {
        const calls = tooltipCalls(extractFunction(canvasSource, name));
        assert.equal(calls.length, name === 'handleSelectionResize' ? 2 : 1,
            `expected tooltip updates for each resize branch in ${name}`);
        calls.forEach((call) => assert.match(call[1], /,\s*true\s*$/));
    }
});

test('selection dimensions snap before reference width is added to the request size', () => {
    restoreReference(320, true);
    const {context, tooltip} = makeTooltipContext({referenceApi: CanvasInpaintReference});

    context.updateSelectionSizeTooltip(200, 200, 700, 1000, true);

    assert.equal(tooltip.innerText,
        '선택 704 × 1024px · 참고 폭 320px\n전체 1024 × 1024px · 무료 크기 범위');
    assert.equal(tooltip.classList.contains('danger'), false);
});

test('selection with a reference crosses the free-area threshold using total request dimensions', () => {
    restoreReference(320, true);
    const {context, tooltip} = makeTooltipContext({referenceApi: CanvasInpaintReference});

    context.updateSelectionSizeTooltip(200, 200, 768, 1024, true);

    assert.equal(tooltip.innerText,
        '선택 768 × 1024px · 참고 폭 320px\n전체 1088 × 1024px · Anlas 가능');
    assert.equal(tooltip.classList.contains('danger'), true);
});

test('selection tooltip uses reference widths of 64px and 384px from the reference module', () => {
    for (const width of [64, 384]) {
        restoreReference(width, true);
        const {context, tooltip} = makeTooltipContext({referenceApi: CanvasInpaintReference});

        context.updateSelectionSizeTooltip(200, 200, 512, 512, true);

        assert.equal(tooltip.innerText,
            `선택 512 × 512px · 참고 폭 ${width}px\n전체 ${512 + width} × 512px · 무료 크기 범위`);
        assert.equal(tooltip.classList.contains('danger'), false);
    }
});

test('selection without an included reference uses the snapped selection area', () => {
    restoreReference(320, false);
    const {context, tooltip} = makeTooltipContext({referenceApi: CanvasInpaintReference});

    context.updateSelectionSizeTooltip(200, 200, 1024, 1024, true);

    assert.equal(tooltip.innerText, '선택 1024 × 1024px · 무료 크기 범위');
    assert.equal(tooltip.classList.contains('danger'), false);
});

test('included reference without a configured image reports that the request cannot run', () => {
    CanvasInpaintReference.restore({reference: null, showArea: false, include: true});
    const {context, tooltip} = makeTooltipContext({referenceApi: CanvasInpaintReference});

    assert.doesNotThrow(() => context.updateSelectionSizeTooltip(200, 200, 700, 1000, true));
    assert.equal(tooltip.innerText, '선택 704 × 1024px\n참고 이미지 없음 · 요청 불가');
    assert.equal(tooltip.classList.contains('danger'), true);
});

test('selection size remains available when the optional reference module is missing', () => {
    const {context, tooltip} = makeTooltipContext();

    assert.doesNotThrow(() => context.updateSelectionSizeTooltip(200, 200, 700, 1000, true));
    assert.match(tooltip.innerText, /선택 704 × 1024px/);
    assert.equal(tooltip.classList.contains('danger'), false);
});

test('ordinary image resize keeps its original area label and does not request reference dimensions', () => {
    restoreReference(320, true);
    let requestCount = 0;
    const referenceApi = {
        ...CanvasInpaintReference,
        request(width, height) {
            requestCount += 1;
            return CanvasInpaintReference.request(width, height);
        }
    };
    const {context, tooltip} = makeTooltipContext({referenceApi});

    context.updateSelectionSizeTooltip(200, 200, 1200, 1024);

    assert.equal(requestCount, 0);
    assert.equal(tooltip.innerText, '1200 × 1024px · Anlas 가능');
    assert.equal(tooltip.classList.contains('danger'), true);
});

test('tooltip placement clamps both corners to the viewport after measuring it', () => {
    restoreReference(320, false);
    const topLeft = makeTooltipContext({
        referenceApi: CanvasInpaintReference,
        windowWidth: 400,
        windowHeight: 300,
        tooltipWidth: 120,
        tooltipHeight: 50
    });
    topLeft.context.updateSelectionSizeTooltip(0, 0, 512, 512, true);
    assert.equal(topLeft.tooltip.style.left, '10px');
    assert.equal(topLeft.tooltip.style.top, '10px');

    const bottomRight = makeTooltipContext({
        referenceApi: CanvasInpaintReference,
        windowWidth: 100,
        windowHeight: 100,
        tooltipWidth: 80,
        tooltipHeight: 70
    });
    bottomRight.context.updateSelectionSizeTooltip(95, 80, 512, 512, true);
    assert.equal(bottomRight.tooltip.style.left, '12px');
    assert.equal(bottomRight.tooltip.style.top, '22px');
});
