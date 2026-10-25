(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CanvasRetouchState = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
    'use strict';

    const NAMES = {
        color: '색 덧입히기',
        tone: '밝기 · 채도 · 명암',
        paint: '부분 정리',
        clone: '원본 복제',
        blur: '부분 부드럽게',
        line: '선 강조',
        texture: '펄린 미세 질감',
        sharpen: '언샤프 마스크',
        liquify: '픽셀 유동화'
    };

    const TOOLS = [
        {id: 'hand', label: '화면 이동 · Space'},
        {id: 'paint', label: '부분 브러시 (B)'},
        {id: 'maskErase', label: '부드러운 지우개 (E)'},
        {id: 'airbrush', label: '에어브러시 · 직접 칠하기 (A)'},
        {id: 'clone', label: '원본 복제 · Alt+클릭'},
        {id: 'liquify', label: '픽셀 유동화 (L)'},
        {id: 'dropper', label: '스포이드 (I)'},
        {id: 'rect', label: '사각 영역 선택'},
        {id: 'ellipse', label: '타원 영역 선택'},
        {id: 'inspect', label: '원본 픽셀 검사'}
    ];

    const PARAMS = {
        color: [],
        tone: [
            {key: 'brightness', label: '밝기', min: -40, max: 40, step: 1},
            {key: 'contrast', label: '대비', min: -70, max: 70, step: 1},
            {key: 'saturation', label: '채도', min: -100, max: 100, step: 1},
            {key: 'vibrance', label: '생기', min: -100, max: 100, step: 1},
            {key: 'shadows', label: '어두운 부분', min: -40, max: 40, step: 1},
            {key: 'highlights', label: '밝은 부분', min: -40, max: 40, step: 1}
        ],
        paint: [],
        clone: [],
        blur: [
            {key: 'radius', label: '흐림 반경', min: 0.5, max: 40, step: 0.5}
        ],
        line: [
            {key: 'strength', label: '선 강조 강도', min: 0.1, max: 5, step: 0.1}
        ],
        texture: [
            {key: 'scale', label: '질감 크기 (원본 px)', min: 2, max: 500, step: 1},
            {key: 'octaves', label: '자세함', min: 1, max: 4, step: 1},
            {key: 'decay', label: '감쇠', min: 0.1, max: 0.9, step: 0.05}
        ],
        sharpen: [
            {key: 'radius', label: '반경 (원본 px)', min: 0.5, max: 40, step: 0.5},
            {key: 'amount', label: '강도', min: 0, max: 250, step: 1},
            {key: 'threshold', label: '임계값', min: 0, max: 50, step: 1}
        ],
        liquify: [
            {key: 'strength', label: '다음 드래그 강도', min: 0.01, max: 1, step: 0.01}
        ]
    };

    const CHECKS = [
        '양면 피부 톤 맞춤',
        '색감과 흰옷 확인',
        '얼굴·눈 선명도 확인',
        '불필요한 선 정리',
        '홍조 강도 확인',
        '질감·샤프닝 후광 확인',
        '안전영역과 끝부분 확인',
        '100% 원본 픽셀 확인'
    ];

    const LIMITS = {
        maxLayers: 40,
        maxPoints: 100000,
        maxPixels: 160000000,
        maxEdge: 100000,
        maxNotes: 10000,
        history: 50
    };

    const DEFAULT_PARAMS = {
        color: {color: '#ffe0cd', mode: 'soft-light'},
        tone: {brightness: 0, contrast: 0, saturation: 0, vibrance: 0, shadows: 0, highlights: 0},
        paint: {mode: 'normal'},
        clone: {},
        blur: {radius: 6},
        sharpen: {radius: 5, amount: 100, threshold: 0},
        line: {strength: 1.5},
        texture: {scale: 100, decay: 0.4, octaves: 3, seed: 17},
        liquify: {mode: 'push', strength: 0.35}
    };
    const MODES = {
        color: ['normal', 'soft-light', 'color', 'multiply', 'screen'],
        paint: ['normal', 'soft-light', 'color', 'multiply', 'screen'],
        liquify: ['push', 'expand', 'shrink', 'clockwise', 'counterclockwise']
    };
    const STROKE_MODES = [...MODES.color, ...MODES.liquify];
    const PRESET_GROUPS = [
        {id: 'global', label: '전체 분위기'},
        {id: 'skin', label: '피부 · 혈색'},
        {id: 'light', label: '음영 · 빛'}
    ];
    const PRESETS = [
        {id: 'rose', label: '장밋빛 혈색', hint: '피부에 붉은 기를 더할 부분만 칠하세요. 칠한 곳에만 적용됩니다.', scope: 'local', group: 'skin', layerCount: 1},
        {id: 'peach', label: '복숭아빛 온기', hint: '피부에 따뜻한 기를 더할 부분만 칠하세요. 칠한 곳에만 적용됩니다.', scope: 'local', group: 'skin', layerCount: 1},
        {id: 'coral', label: '살구빛 혈색', hint: '피부에 살구빛 혈색을 더할 부분만 칠하세요. 칠한 곳에만 적용됩니다.', scope: 'local', group: 'skin', layerCount: 1},
        {id: 'muted-rose', label: '차분한 장밋빛', hint: '피부에 차분한 장밋빛을 더할 부분만 칠하세요. 칠한 곳에만 적용됩니다.', scope: 'local', group: 'skin', layerCount: 1},
        {id: 'warm-shadow', label: '따뜻한 음영', hint: '피부의 음영을 더할 부분만 칠하세요. 칠한 곳에만 적용됩니다.', scope: 'local', group: 'light', layerCount: 1},
        {id: 'cool-shadow', label: '차분한 음영', hint: '차가운 그림자가 필요한 피부 부분만 칠하세요. 칠한 곳에만 적용됩니다.', scope: 'local', group: 'light', layerCount: 1},
        {id: 'soft-light', label: '은은한 빛', hint: '피부에서 빛을 받을 부분만 부드럽게 칠하세요. 칠한 곳에만 적용됩니다.', scope: 'local', group: 'light', layerCount: 1},
        {id: 'natural', label: '내추럴', hint: '원본 느낌을 유지하면서 색과 대비를 가볍게 살립니다.', scope: 'global', group: 'global', layerCount: 1},
        {id: 'clear', label: '맑은 색감', hint: '밝은 부분을 조금 눌러 색과 윤곽을 맑게 정리합니다.', scope: 'global', group: 'global', layerCount: 1},
        {id: 'warm-look', label: '따뜻한 색감', hint: '은은한 살구빛과 따뜻한 조명을 더합니다. 머리·옷을 포함한 전체 색감이 바뀝니다.', scope: 'global', group: 'global', layerCount: 2},
        {id: 'cool-look', label: '차분한 색감', hint: '옅은 푸른빛으로 차분한 분위기를 만듭니다. 머리·옷을 포함한 전체 색감이 바뀝니다.', scope: 'global', group: 'global', layerCount: 2},
        {id: 'rich', label: '깊은 명암', hint: '어두운 부분과 대비를 강화해 입체감을 더합니다. 이미 어두운 그림에는 은은하게부터 사용하세요.', scope: 'global', group: 'global', layerCount: 1},
        {id: 'vivid', label: '전체 색감 생기', hint: '이미지 전체의 약한 색을 살립니다. 밝기와 흐림은 바꾸지 않습니다.', scope: 'global', group: 'global', layerCount: 1},
        {id: 'depth', label: '전체 명암 또렷하게', hint: '색감은 그대로 두고 전체 대비만 조금 높입니다.', scope: 'global', group: 'global', layerCount: 1}
    ];
    const PRESET_SETTINGS = {
        rose: {layers: [{type: 'paint', params: {color: '#e47789', mode: 'color'}}], flow: 4},
        peach: {layers: [{type: 'paint', params: {color: '#ed9a78', mode: 'color'}}], flow: 4},
        coral: {layers: [{type: 'paint', params: {color: '#e78a72', mode: 'color'}}], flow: 3},
        'muted-rose': {layers: [{type: 'paint', params: {color: '#c87f91', mode: 'color'}}], flow: 3},
        'warm-shadow': {layers: [{type: 'paint', params: {color: '#b97c78', mode: 'multiply'}}], flow: 3},
        'cool-shadow': {layers: [{type: 'paint', params: {color: '#9e91b2', mode: 'multiply'}}], flow: 3},
        'soft-light': {layers: [{type: 'paint', params: {color: '#f4d5b9', mode: 'soft-light'}}], flow: 3},
        vivid: {layers: [{type: 'tone', params: {vibrance: 18}}]},
        depth: {layers: [{type: 'tone', params: {contrast: 6}}]},
        natural: {layers: [{type: 'tone', params: {contrast: 2, vibrance: 8}}]},
        clear: {layers: [{type: 'tone', params: {contrast: 4, vibrance: 12, highlights: -3}}]},
        'warm-look': {
            layers: [
                {type: 'tone', params: {contrast: 3, vibrance: 8}},
                {type: 'color', params: {color: '#edb18b', mode: 'soft-light'}, opacity: 0.035}
            ]
        },
        'cool-look': {
            layers: [
                {type: 'tone', params: {contrast: 3, vibrance: 6}},
                {type: 'color', params: {color: '#9eadd4', mode: 'soft-light'}, opacity: 0.03}
            ]
        },
        rich: {layers: [{type: 'tone', params: {contrast: 7, vibrance: 12, shadows: -2}}]}
    };
    const DEFAULT_OPACITY = {color: 0.07, sharpen: 0.5, texture: 0.02};
    const EMPTY_MASK_KINDS = new Set(['blur', 'sharpen', 'line']);
    const COPY_EXCLUDED = new Set(['paint', 'clone', 'liquify']);
    const HEX_COLOR = /^#[0-9a-f]{6}$/i;
    let generatedIdCounter = 0;

    function clone(value) {
        if (typeof structuredClone === 'function') return structuredClone(value);
        return JSON.parse(JSON.stringify(value));
    }

    function generatedId() {
        try {
            if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
                return globalThis.crypto.randomUUID().replace(/-/g, '');
            }
        } catch (_) {
            // Fall through to the local fallback for runtimes without Web Crypto.
        }
        generatedIdCounter += 1;
        return Date.now().toString(36) + Math.random().toString(36).slice(2) + generatedIdCounter.toString(36);
    }

    function nextId(makeId) {
        const value = makeId === undefined ? generatedId() : makeId();
        if (typeof value !== 'string' || !value.length || value.length > 100) {
            throw new TypeError('Layer id factory must return a non-empty string of at most 100 characters.');
        }
        return value;
    }

    function defaultMaskBase(type) {
        return EMPTY_MASK_KINDS.has(type) ? 0 : 1;
    }

    function createLayer(type, makeId) {
        if (!Object.prototype.hasOwnProperty.call(NAMES, type)) throw new RangeError('Unknown retouch layer type.');
        return {
            id: nextId(makeId),
            type,
            name: NAMES[type],
            params: clone(DEFAULT_PARAMS[type]),
            opacity: Object.prototype.hasOwnProperty.call(DEFAULT_OPACITY, type) ? DEFAULT_OPACITY[type] : 1,
            visible: true,
            mask: {base: defaultMaskBase(type), strokes: []},
            strokes: []
        };
    }

    function createPreset(id, makeId, strength = 1) {
        const preset = PRESETS.find(item => item.id === id);
        if (!preset) return null;
        const scale = [0.5, 1, 1.5].includes(strength) ? strength : 1;
        const settings = PRESET_SETTINGS[id];
        if (!settings || !Array.isArray(settings.layers) || settings.layers.length !== preset.layerCount) return null;
        const seenIds = new Set();
        const makeUniqueId = () => {
            let layerId = nextId(makeId);
            if (seenIds.has(layerId)) {
                do {
                    layerId = generatedId();
                } while (seenIds.has(layerId));
            }
            seenIds.add(layerId);
            return layerId;
        };
        const layers = settings.layers.map(definition => {
            const layer = createLayer(definition.type, makeUniqueId);
            const multiLayerSuffix = definition.type === 'tone' ? '명암' : definition.type === 'color' ? '색감' : '';
            layer.name = preset.layerCount > 1 && multiLayerSuffix
                ? `${preset.label} · ${multiLayerSuffix}`
                : preset.label;
            layer.params = {...layer.params, ...clone(definition.params)};
            if (definition.type === 'tone') {
                for (const [key, value] of Object.entries(layer.params)) {
                    if (typeof value === 'number' && value !== 0) layer.params[key] = Math.round(value * scale);
                }
            }
            if (definition.type === 'paint') {
                layer.mask = {base: 1, strokes: []};
                layer.strokes = [];
            }
            if (definition.type === 'color' && typeof definition.opacity === 'number') {
                layer.opacity = Math.max(0, Math.min(1, definition.opacity * scale));
                layer.mask = {base: 1, strokes: []};
            }
            return layer;
        });
        const isLocal = preset.scope === 'local';
        const result = {
            layer: layers[0],
            layers,
            tool: isLocal ? 'airbrush' : 'hand',
            hint: preset.hint
        };
        if (isLocal) {
            const color = settings.layers[0].params.color;
            result.brush = {
                size: 160,
                flow: Math.max(1, Math.round(settings.flow * scale)),
                opacity: 100,
                hardness: 0,
                color
            };
        }
        return result;
    }

    const RECIPE_DEFINITIONS = [
        {id: 'skin-tone', type: 'color', name: '피부 톤 통일', params: {color: '#e6baa4', mode: 'color'}, opacity: 0.53, base: 0},
        {id: 'warm-color', type: 'color', name: '따뜻한 색감', params: {color: '#ffe0cd', mode: 'soft-light'}, opacity: 0.07, base: 1},
        {id: 'tone', type: 'tone', name: '밝기 +2 · 대비 −3', params: {brightness: 2, contrast: -3, saturation: 0, shadows: 0, highlights: 0}, opacity: 1, base: 1},
        {id: 'beige', type: 'color', name: '부드러운 베이지 막', params: {color: '#f5eee8', mode: 'normal'}, opacity: 0.04, base: 1},
        {id: 'line', type: 'line', name: '중요한 선 정리', params: {strength: 1.5}, opacity: 0.4, base: 0},
        {id: 'blush', type: 'color', name: '홍조 정리', params: {color: '#f15e32', mode: 'color'}, opacity: 0.18, base: 0},
        {id: 'texture', type: 'texture', name: '펄린 미세 질감', params: {scale: 100, decay: 0.4, octaves: 3, seed: 17}, opacity: 0.02, base: 1},
        {id: 'sharpen', type: 'sharpen', name: '마지막 선택적 샤프닝', params: {radius: 5, amount: 100, threshold: 0}, opacity: 0.5, base: 0}
    ];
    const RECIPE_STEPS = RECIPE_DEFINITIONS.map(({id, name, base}) => ({
        id,
        label: name,
        scope: base === 1 ? 'all' : 'painted'
    }));

    function recipe(makeId, selectedIds = undefined) {
        const selected = selectedIds === undefined
            ? null
            : new Set(Array.isArray(selectedIds) ? selectedIds : []);
        return RECIPE_DEFINITIONS
            .filter(definition => selected === null || selected.has(definition.id))
            .map(({type, name, params, opacity, base}) => ({
                ...createLayer(type, makeId),
                name,
                params: clone(params),
                opacity,
                mask: {base, strokes: []}
            }));
    }

    function finiteNumber(value) {
        return typeof value === 'number' && Number.isFinite(value);
    }

    function clamp(value, min, max, fallback) {
        return finiteNumber(value) ? Math.max(min, Math.min(max, value)) : fallback;
    }

    function snap(value, min, step) {
        const snapped = min + Math.round((value - min) / step) * step;
        const precision = Math.max(0, (String(step).split('.')[1] || '').length);
        return Number(snapped.toFixed(precision));
    }

    function normalizeParams(type, value) {
        const defaults = DEFAULT_PARAMS[type];
        const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const params = clone(defaults);
        for (const spec of PARAMS[type]) {
            let normalized = clamp(input[spec.key], spec.min, spec.max, defaults[spec.key]);
            normalized = snap(normalized, spec.min, spec.step);
            params[spec.key] = Math.max(spec.min, Math.min(spec.max, normalized));
        }
        if (type === 'color') {
            params.color = typeof input.color === 'string' && HEX_COLOR.test(input.color) ? input.color.toLowerCase() : defaults.color;
        }
        if (type === 'paint' && typeof input.color === 'string' && HEX_COLOR.test(input.color)) {
            params.color = input.color.toLowerCase();
        }
        if (Object.prototype.hasOwnProperty.call(MODES, type)) {
            params.mode = MODES[type].includes(input.mode) ? input.mode : defaults.mode;
        }
        if (type === 'texture') {
            params.seed = finiteNumber(input.seed) ? Math.max(0, Math.min(9998, Math.round(input.seed))) : defaults.seed;
        }
        return params;
    }

    function validPoint(value) {
        return Array.isArray(value) && value.length === 2 && value.every(item => finiteNumber(item) && Math.abs(item) <= 1000000);
    }

    function sanitizeStroke(value, budget) {
        if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.points) || value.points.length === 0 || value.points.length > budget.remaining) return null;
        const points = [];
        for (const point of value.points) {
            if (!validPoint(point)) return null;
            points.push([point[0], point[1]]);
        }
        const stroke = {
            points,
            radius: clamp(value.radius, 1, 800, 80),
            hardness: clamp(value.hardness, 0, 1, 0.3),
            opacity: clamp(value.opacity, 0, 1, 0.1),
            color: typeof value.color === 'string' && HEX_COLOR.test(value.color) ? value.color.toLowerCase() : '#e6baa4',
            mode: STROKE_MODES.includes(value.mode) ? value.mode : 'push',
            strength: clamp(value.strength, 0.01, 1, 0.35)
        };
        if (value.brush === 'airbrush') {
            stroke.brush = 'airbrush';
            stroke.flow = clamp(value.flow, 0, 1, 0.04);
        }
        if (Object.prototype.hasOwnProperty.call(value, 'source')) {
            stroke.source = value.source === null ? null : validPoint(value.source) ? [value.source[0], value.source[1]] : null;
        }
        if (typeof value.erase === 'boolean') stroke.erase = value.erase;
        budget.remaining -= points.length;
        return stroke;
    }

    function sanitizeShape(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value) || !['rect', 'ellipse'].includes(value.kind)) return null;
        const box = value.box;
        if (!Array.isArray(box) || box.length !== 4 || !box.every(item => finiteNumber(item) && Math.abs(item) <= 1000000) || box[0] > box[2] || box[1] > box[3]) return null;
        return {kind: value.kind, box: box.slice()};
    }

    function sanitizeLayer(value, ids, budget) {
        if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.prototype.hasOwnProperty.call(NAMES, value.type)) return null;
        if (typeof value.id !== 'string' || !value.id.length || value.id.length > 100 || ids.has(value.id)) return null;
        ids.add(value.id);
        const type = value.type;
        const defaults = createLayer(type, () => value.id);
        const name = typeof value.name === 'string' ? value.name.slice(0, 80) : defaults.name;
        const layer = {
            id: value.id,
            type,
            name,
            params: normalizeParams(type, value.params),
            opacity: clamp(value.opacity, 0, 1, defaults.opacity),
            visible: typeof value.visible === 'boolean' ? value.visible : true,
            mask: {base: value.mask && (value.mask.base === 0 || value.mask.base === 1) ? value.mask.base : defaults.mask.base, strokes: []},
            strokes: []
        };
        const rawStrokes = Array.isArray(value.strokes) ? value.strokes : [];
        for (const stroke of rawStrokes) {
            const clean = sanitizeStroke(stroke, budget);
            if (clean) layer.strokes.push(clean);
        }
        const mask = value.mask && typeof value.mask === 'object' && !Array.isArray(value.mask) ? value.mask : {};
        if (Array.isArray(mask.strokes)) {
            for (const stroke of mask.strokes) {
                const clean = sanitizeStroke(stroke, budget);
                if (clean) layer.mask.strokes.push(clean);
            }
        }
        const shape = sanitizeShape(mask.shape);
        if (shape) layer.mask.shape = shape;
        return layer;
    }

    function validSource(source) {
        if (typeof source !== 'string' || !source.length || source.trim() !== source || /[\u0000-\u001f]/.test(source)) return false;
        if (/^data:/i.test(source)) return /^data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*,.+$/i.test(source);
        if (source.startsWith('//') || source.startsWith('\\\\') || /^[a-z][a-z0-9+.-]*:/i.test(source)) return false;
        return source.length > 0;
    }

    function normalize(value) {
        try {
            if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !validSource(value.source)) return null;
            const width = value.width;
            const height = value.height;
            if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > LIMITS.maxEdge || height > LIMITS.maxEdge || width > Math.floor(LIMITS.maxPixels / height)) return null;
            if (!Array.isArray(value.layers)) return null;
            const layerRecords = value.layers.slice(0, LIMITS.maxLayers);
            const ids = new Set();
            const budget = {remaining: LIMITS.maxPoints};
            const layers = [];
            for (const record of layerRecords) {
                const clean = sanitizeLayer(record, ids, budget);
                if (clean) layers.push(clean);
            }
            const inputPrint = value.print && typeof value.print === 'object' && !Array.isArray(value.print) ? value.print : {};
            const print = {
                widthCm: clamp(inputPrint.widthCm, 1, 300, 50),
                heightCm: clamp(inputPrint.heightCm, 1, 400, 160),
                safeMm: clamp(inputPrint.safeMm, 0, 100, 5)
            };
            const checks = [];
            const seenChecks = new Set();
            if (Array.isArray(value.checks)) {
                for (const check of value.checks) {
                    if (Number.isInteger(check) && check >= 0 && check < CHECKS.length && !seenChecks.has(check)) {
                        checks.push(check);
                        seenChecks.add(check);
                    }
                }
            }
            return {
                version: 1,
                source: value.source,
                width,
                height,
                layers,
                print,
                notes: typeof value.notes === 'string' ? value.notes.slice(0, LIMITS.maxNotes) : '',
                checks
            };
        } catch (_) {
            return null;
        }
    }

    function copySettings(layer, makeId) {
        if (!layer || typeof layer !== 'object' || Array.isArray(layer) || COPY_EXCLUDED.has(layer.type)) return null;
        const clean = sanitizeLayer(layer, new Set(), {remaining: LIMITS.maxPoints});
        if (!clean) return null;
        clean.id = nextId(makeId);
        clean.strokes = [];
        clean.mask = {base: clean.mask.base, strokes: []};
        return clean;
    }

    class History {
        constructor() {
            this._undo = [];
            this._redo = [];
        }

        get canUndo() {
            return this._undo.length > 0;
        }

        get canRedo() {
            return this._redo.length > 0;
        }

        push(document) {
            this._undo.push(clone(document));
            if (this._undo.length > LIMITS.history) this._undo.shift();
            this._redo = [];
        }

        undo(current) {
            if (!this.canUndo) return null;
            this._redo.push(clone(current));
            return clone(this._undo.pop());
        }

        redo(current) {
            if (!this.canRedo) return null;
            this._undo.push(clone(current));
            if (this._undo.length > LIMITS.history) this._undo.shift();
            return clone(this._redo.pop());
        }
    }

    return {NAMES, TOOLS, PARAMS, CHECKS, LIMITS, MODES, PRESET_GROUPS, PRESETS, RECIPE_STEPS, createLayer, createPreset, recipe, normalize, copySettings, History};
});
