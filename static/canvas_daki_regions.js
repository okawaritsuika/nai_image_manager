(function attachCanvasDakiRegions(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CanvasDakiRegions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createCanvasDakiRegions() {
    'use strict';

    const REGIONS = [
        { id: 'whole', label: '전체', prompt: '', color: '#8b5cf6' },
        { id: 'hair', label: '머리카락', prompt: 'close-up of the hair', color: '#f59e0b' },
        { id: 'face', label: '얼굴', prompt: 'close-up of the face', color: '#ec4899' },
        { id: 'chest', label: '가슴·어깨', prompt: 'close-up of the torso and shoulders', color: '#ef4444' },
        { id: 'back', label: '등', prompt: 'close-up of the back', color: '#14b8a6' },
        { id: 'arms', label: '팔', prompt: 'close-up of the arms', color: '#f97316' },
        { id: 'hands', label: '손', prompt: 'close-up of hands and fingers', color: '#eab308' },
        { id: 'abdomen', label: '배·허리', prompt: 'close-up of the waist and abdomen', color: '#84cc16' },
        { id: 'pelvis', label: '골반', prompt: 'close-up of the hips and pelvis', color: '#06b6d4' },
        { id: 'legs', label: '다리', prompt: 'close-up of the legs', color: '#3b82f6' },
        { id: 'feet', label: '발', prompt: 'close-up of the feet and ankles', color: '#a855f7' },
    ];
    const REGION_IDS = REGIONS.map((region) => region.id);
    const MIN_SIZE = 0.005;
    const MAX_CUSTOM_REGIONS = 64;
    const CUSTOM_ID_PATTERN = /^custom-[a-z0-9][a-z0-9_-]{0,79}$/;

    function defaultMap() {
        const front = {
            whole: [],
            hair: [{ x: 0.12, y: 0.02, width: 0.76, height: 0.30 }],
            face: [{ x: 0.28, y: 0.04, width: 0.44, height: 0.18 }],
            chest: [{ x: 0.22, y: 0.22, width: 0.56, height: 0.21 }],
            back: [],
            arms: [
                { x: 0.03, y: 0.20, width: 0.27, height: 0.42 },
                { x: 0.70, y: 0.20, width: 0.27, height: 0.42 },
            ],
            hands: [
                { x: 0.05, y: 0.48, width: 0.25, height: 0.19 },
                { x: 0.70, y: 0.48, width: 0.25, height: 0.19 },
            ],
            abdomen: [{ x: 0.27, y: 0.40, width: 0.46, height: 0.19 }],
            pelvis: [{ x: 0.20, y: 0.55, width: 0.60, height: 0.17 }],
            legs: [{ x: 0.18, y: 0.65, width: 0.64, height: 0.27 }],
            feet: [{ x: 0.15, y: 0.88, width: 0.70, height: 0.11 }],
        };
        const back = cloneSide(front);
        back.chest = [];
        back.face = [];
        back.back = [{ x: 0.22, y: 0.22, width: 0.56, height: 0.21 }];
        return { version: 1, front, back };
    }

    function cloneSide(side) {
        const result = {};
        for (const id of REGION_IDS) {
            result[id] = Array.isArray(side[id])
                ? side[id].map((rect) => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }))
                : [];
        }
        return result;
    }

    function isRecord(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function isFiniteNumber(value) {
        return typeof value === 'number' && Number.isFinite(value);
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function normalizeRect(rect) {
        if (!isRecord(rect) || !isFiniteNumber(rect.x) || !isFiniteNumber(rect.y)
            || !isFiniteNumber(rect.width) || !isFiniteNumber(rect.height)) return null;
        const width = clamp(rect.width, MIN_SIZE, 1);
        const height = clamp(rect.height, MIN_SIZE, 1);
        return {
            x: clamp(rect.x, 0, 1 - width),
            y: clamp(rect.y, 0, 1 - height),
            width,
            height,
        };
    }

    function normalizeSide(value, defaults) {
        const side = {};
        for (const id of REGION_IDS) {
            if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, id)) {
                side[id] = defaults[id].map((rect) => ({ ...rect }));
                continue;
            }
            const input = value[id];
            if (!Array.isArray(input)) {
                side[id] = defaults[id].map((rect) => ({ ...rect }));
                continue;
            }
            if (input.length === 0) {
                side[id] = [];
                continue;
            }
            const boxes = input.slice(0, 8).map(normalizeRect).filter(Boolean);
            side[id] = boxes.length ? boxes : defaults[id].map((rect) => ({ ...rect }));
        }
        return side;
    }

    function normalizeCustomRegions(value) {
        if (!Array.isArray(value)) return [];
        const customRegions = [];
        const seen = new Set();
        for (const item of value) {
            if (!isRecord(item) || typeof item.id !== 'string' || !CUSTOM_ID_PATTERN.test(item.id)
                || REGION_IDS.includes(item.id) || typeof item.label !== 'string') continue;
            const label = item.label.trim();
            if (!label || label.length > 60 || seen.has(item.id)) continue;
            seen.add(item.id);
            customRegions.push({
                id: item.id,
                label,
                baseRegion: REGION_IDS.includes(item.baseRegion) ? item.baseRegion : 'whole',
                prompt: typeof item.prompt === 'string' && item.prompt.length <= 2000 ? item.prompt : '',
                color: typeof item.color === 'string' && /^#[0-9a-f]{6}$/i.test(item.color) ? item.color : '#22c55e',
            });
            if (customRegions.length >= MAX_CUSTOM_REGIONS) break;
        }
        return customRegions;
    }

    function normalizeCustomSide(value, ids) {
        const side = {};
        for (const id of ids) {
            const input = isRecord(value) && Object.prototype.hasOwnProperty.call(value, id) ? value[id] : null;
            side[id] = Array.isArray(input) ? input.slice(0, 8).map(normalizeRect).filter(Boolean) : [];
        }
        return side;
    }

    function normalizeMap(value) {
        const defaults = defaultMap();
        if (!isRecord(value)) return defaults;
        const customRegions = normalizeCustomRegions(value.customRegions);
        const customIds = customRegions.map((region) => region.id);
        const normalized = {
            version: 1,
            front: { ...normalizeSide(value.front, defaults.front), ...normalizeCustomSide(value.front, customIds) },
            back: { ...normalizeSide(value.back, defaults.back), ...normalizeCustomSide(value.back, customIds) },
        };
        if (customRegions.length) normalized.customRegions = customRegions;
        return normalized;
    }

    function listRegions(map) {
        const normalized = normalizeMap(map);
        const customRegions = (normalized.customRegions || []).map((region) => ({ ...region, custom: true }));
        return REGIONS.map((region) => ({ ...region })).concat(customRegions);
    }

    function customRegionError(message) {
        throw new Error(message);
    }

    function makeCustomRegionId() {
        if (typeof globalThis !== 'undefined' && globalThis.crypto
            && typeof globalThis.crypto.randomUUID === 'function') {
            return `custom-${globalThis.crypto.randomUUID()}`;
        }
        return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    }

    function addCustomRegion(map, spec, makeId) {
        const input = isRecord(spec) ? spec : {};
        const label = typeof input.label === 'string' ? input.label.trim() : '';
        if (!label) customRegionError('이름을 입력해 주세요.');
        if (label.length > 60) customRegionError('이름은 60자 이내로 입력해 주세요.');
        const prompt = typeof input.prompt === 'string' ? input.prompt : '';
        if (prompt.length > 2000) customRegionError('프롬프트는 2000자 이내로 입력해 주세요.');

        const normalized = normalizeMap(map);
        const customRegions = normalized.customRegions || [];
        if (customRegions.length >= MAX_CUSTOM_REGIONS) {
            customRegionError('사용자 신체 부위는 최대 64개까지 추가할 수 있습니다.');
        }
        const normalizedLabel = label.toLowerCase();
        if (REGIONS.some((region) => region.label.toLowerCase() === normalizedLabel)
            || customRegions.some((region) => region.label.toLowerCase() === normalizedLabel)) {
            customRegionError('이미 사용 중인 이름입니다.');
        }

        const id = makeId === undefined || makeId === null
            ? makeCustomRegionId()
            : (typeof makeId === 'function' ? makeId() : makeId);
        if (typeof id !== 'string' || !CUSTOM_ID_PATTERN.test(id)) {
            customRegionError('사용자 신체 부위 ID가 올바르지 않습니다.');
        }
        if (REGION_IDS.includes(id) || customRegions.some((region) => region.id === id)) {
            customRegionError('사용자 신체 부위 ID가 이미 존재합니다.');
        }

        const region = {
            id,
            label,
            baseRegion: REGION_IDS.includes(input.baseRegion) ? input.baseRegion : 'whole',
            prompt,
            color: '#22c55e',
        };
        normalized.customRegions = [...customRegions.map((item) => ({ ...item })), region];
        normalized.front[id] = [];
        normalized.back[id] = [];
        return { map: normalized, region: { ...region } };
    }

    function intersect(a, b) {
        const rect = {
            x1: Math.max(a.x1, b.x1),
            y1: Math.max(a.y1, b.y1),
            x2: Math.min(a.x2, b.x2),
            y2: Math.min(a.y2, b.y2),
        };
        return rect.x2 > rect.x1 && rect.y2 > rect.y1 ? rect : null;
    }

    function unionArea(rects) {
        if (!rects.length) return 0;
        const xEdges = Array.from(new Set(rects.flatMap((rect) => [rect.x1, rect.x2]))).sort((a, b) => a - b);
        let area = 0;
        for (let i = 0; i < xEdges.length - 1; i++) {
            const x1 = xEdges[i];
            const x2 = xEdges[i + 1];
            if (x2 <= x1) continue;
            const intervals = rects
                .filter((rect) => rect.x1 < x2 && rect.x2 > x1)
                .map((rect) => [rect.y1, rect.y2])
                .sort((a, b) => a[0] - b[0]);
            let covered = 0;
            let start = null;
            let end = null;
            for (const interval of intervals) {
                if (start === null) {
                    [start, end] = interval;
                } else if (interval[0] <= end) {
                    end = Math.max(end, interval[1]);
                } else {
                    covered += end - start;
                    [start, end] = interval;
                }
            }
            if (start !== null) covered += end - start;
            area += (x2 - x1) * covered;
        }
        return area;
    }

    function normalizedBoxes(value) {
        if (!Array.isArray(value)) return [];
        return value.map(normalizeRect).filter(Boolean).map((rect) => ({
            x1: rect.x,
            y1: rect.y,
            x2: rect.x + rect.width,
            y2: rect.y + rect.height,
        }));
    }

    function wholeResult() {
        return { primary: 'whole', regions: ['whole'] };
    }

    function detect(selection, width, height, regions, catalog = REGIONS) {
        if (!isRecord(selection) || !isFiniteNumber(width) || !isFiniteNumber(height)
            || width <= 0 || height <= 0
            || !isFiniteNumber(selection.x) || !isFiniteNumber(selection.y)
            || !isFiniteNumber(selection.layerWidth) || !isFiniteNumber(selection.layerHeight)
            || selection.layerWidth <= 0 || selection.layerHeight <= 0 || !isRecord(regions)) return wholeResult();

        const canvasSelection = {
            x1: selection.x / width,
            y1: selection.y / height,
            x2: (selection.x + selection.layerWidth) / width,
            y2: (selection.y + selection.layerHeight) / height,
        };
        const clippedSelection = intersect(canvasSelection, { x1: 0, y1: 0, x2: 1, y2: 1 });
        if (!clippedSelection) return wholeResult();
        const selectionArea = (clippedSelection.x2 - clippedSelection.x1) * (clippedSelection.y2 - clippedSelection.y1);
        if (selectionArea <= 0 || selectionArea >= 0.75) return wholeResult();

        const regionCatalog = Array.isArray(catalog) ? catalog : REGIONS;
        const measurements = [];
        for (const region of regionCatalog) {
            if (!region || typeof region.id !== 'string' || region.id === 'whole') continue;
            const boxes = normalizedBoxes(regions[region.id]);
            const regionArea = unionArea(boxes);
            if (regionArea <= 0) continue;
            const overlap = unionArea(boxes.map((box) => intersect(box, clippedSelection)).filter(Boolean));
            if (overlap <= 0) continue;
            const iou = overlap / (selectionArea + regionArea - overlap);
            measurements.push({ id: region.id, overlap, regionArea, iou });
        }

        let primary = null;
        for (const measurement of measurements) {
            if (measurement.overlap < selectionArea * 0.20) continue;
            if (!primary || measurement.iou > primary.iou) primary = measurement;
        }
        if (!primary) return wholeResult();

        const result = [primary.id];
        for (const region of regionCatalog) {
            if (!region || typeof region.id !== 'string' || region.id === 'whole' || region.id === primary.id) continue;
            const measurement = measurements.find((item) => item.id === region.id);
            if (!measurement || measurement.overlap < selectionArea * 0.12
                || measurement.overlap < measurement.regionArea * 0.50) continue;
            result.push(region.id);
        }
        return { primary: primary.id, regions: result };
    }

    function resolve(selection, width, height, map, side) {
        const normalized = normalizeMap(map);
        const regions = listRegions(normalized);
        const regionIds = regions.map((region) => region.id);
        const focus = selection && selection.dakiFocus;
        if (focus && focus.mode === 'manual' && Array.isArray(focus.regions)) {
            const regions = [];
            for (const id of focus.regions) {
                if (regionIds.includes(id) && !regions.includes(id)) regions.push(id);
            }
            if (regions.includes('whole')) return wholeResult();
            if (regions.length) return { primary: regions[0], regions };
        }
        return detect(selection, width, height, normalized[side === 'back' ? 'back' : 'front'], regions);
    }

    function ensureResultFolder(selection, region, makeId, map) {
        const catalog = listRegions(map);
        const resolvedRegion = catalog.find((item) => item.id === region);
        const id = resolvedRegion ? resolvedRegion.id : 'whole';
        const label = (resolvedRegion || catalog.find((item) => item.id === 'whole')).label;
        if (!Array.isArray(selection.children)) selection.children = [];

        let folder = selection.children.find((child) => child && child.type === 'folder' && child.dakiRegion === id);
        if (!folder) {
            folder = selection.children.find((child) => child && child.type === 'folder'
                && child.dakiRegion == null && child.name === label);
            if (folder) folder.dakiRegion = id;
        }
        if (folder) {
            if (!Array.isArray(folder.children)) folder.children = [];
            folder.expanded = true;
            return folder;
        }

        folder = {
            id: makeId(),
            name: label,
            type: 'folder',
            visible: true,
            expanded: true,
            children: [],
            dakiRegion: id,
        };
        selection.children.unshift(folder);
        return folder;
    }

    return { REGIONS, defaultMap, normalizeMap, listRegions, addCustomRegion, detect, resolve, ensureResultFolder };
});
