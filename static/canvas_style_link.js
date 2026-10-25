(function attachCanvasStyleLink(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CanvasStyleLink = api;
})(typeof window !== 'undefined' ? window : globalThis, function createCanvasStyleLinkModule() {
    'use strict';

    const LIBRARIES = ['shared', 'personal'];
    const URLS = {
        shared: '/api/daki/shared-styles?include_prompts=1',
        personal: '/api/daki/personal-styles?include_prompts=1',
    };
    const MAX_ID_LENGTH = 256;
    const MAX_NAME_LENGTH = 500;
    const MAX_PROMPT_LENGTH = 100000;

    function textWithin(value, maxLength, allowEmpty) {
        return typeof value === 'string'
            && value.length <= maxLength
            && (allowEmpty || value.trim().length > 0);
    }

    function normalizePromptSelection(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const selection = { base: [], negative: [] };
        const seen = { base: new Set(), negative: new Set() };
        let itemCount = 0;
        for (const field of ['base', 'negative']) {
            const entries = value[field];
            if (!Array.isArray(entries) || entries.length > MAX_PROMPT_LENGTH) return null;
            let fieldCharacters = 0;
            for (const entry of entries) {
                if (!entry || typeof entry !== 'object' || Array.isArray(entry)
                    || !textWithin(entry.token, MAX_PROMPT_LENGTH, false)
                    || entry.token !== entry.token.trim()
                    || entry.token.includes(',')
                    || !Number.isSafeInteger(entry.occurrence)
                    || entry.occurrence < 0) return null;
                fieldCharacters += entry.token.length;
                if (fieldCharacters > MAX_PROMPT_LENGTH) return null;
                const duplicateKey = JSON.stringify([tokenKey(entry.token), entry.occurrence]);
                if (seen[field].has(duplicateKey)) return null;
                seen[field].add(duplicateKey);
                selection[field].push({ token: entry.token, occurrence: entry.occurrence });
                itemCount += 1;
                if (itemCount > MAX_PROMPT_LENGTH) return null;
            }
        }
        return itemCount ? selection : null;
    }

    function normalizeStyleSnapshot(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        if (!textWithin(value.id, MAX_ID_LENGTH, false)
            || !textWithin(value.name, MAX_NAME_LENGTH, false)
            || !textWithin(value.positive, MAX_PROMPT_LENGTH, true)
            || !textWithin(value.negative, MAX_PROMPT_LENGTH, true)) return null;
        const base = {
            id: value.id,
            library: value.library,
            name: value.name,
            positive: value.positive,
            negative: value.negative,
        };
        if (LIBRARIES.includes(value.library)) {
            if (Object.prototype.hasOwnProperty.call(value, 'selection')) {
                const selection = normalizePromptSelection(value.selection);
                if (!selection) return null;
                base.selection = selection;
            }
            return base;
        }
        if (value.library === 'project') {
            const selection = normalizePromptSelection(value.selection);
            if (typeof value.sourceProjectId !== 'string'
                || !/^[a-f0-9]{32}$/.test(value.sourceProjectId)
                || !selection) return null;
            return { ...base, sourceProjectId: value.sourceProjectId, selection };
        }
        if (value.library !== 'custom'
            || value.id !== 'canvas-custom'
            || (!value.positive.trim() && !value.negative.trim())
            || !value.rangeStarts
            || typeof value.rangeStarts !== 'object'
            || Array.isArray(value.rangeStarts)) return null;
        const rangeStarts = {};
        for (const field of ['base', 'negative']) {
            const start = value.rangeStarts[field];
            const recipe = field === 'base' ? value.positive : value.negative;
            if (recipe.trim()) {
                if (!Number.isSafeInteger(start) || start < 0) return null;
                rangeStarts[field] = start;
            } else {
                if (start !== null) return null;
                rangeStarts[field] = null;
            }
        }
        return { ...base, rangeStarts };
    }

    function normalizeState(value) {
        const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const mode = ['auto', 'manual', 'off'].includes(source.mode) ? source.mode : 'auto';
        const style = mode === 'off' ? null : normalizeStyleSnapshot(source.style);
        const expanded = source.expanded && typeof source.expanded === 'object' && !Array.isArray(source.expanded)
            ? source.expanded
            : {};
        return {
            mode,
            style,
            expanded: {
                base: expanded.base === true,
                negative: expanded.negative === true,
            },
        };
    }

    function tokenKey(text) {
        let value = String(text == null ? '' : text).trim();
        for (let pass = 0; pass < 4; pass += 1) {
            const previous = value;
            value = value.replace(/^[\[{]+/, '').replace(/[\]}]+$/, '').trim();
            value = value.replace(/^[-+]?(?:\d+(?:\.\d+)?|\.\d+)::\s*/, '');
            value = value.replace(/\s*::$/, '').trim();
            if (value === previous) break;
        }
        return value.toLowerCase().replace(/[\s_]+/g, '_');
    }

    function promptTokens(value) {
        return String(value == null ? '' : value)
            .split(',')
            .map((token) => token.trim())
            .filter(Boolean);
    }

    function buildPromptSelection(prompt, indexes) {
        if (typeof prompt !== 'string' || prompt.length > MAX_PROMPT_LENGTH) return [];
        const requested = new Set((Array.isArray(indexes) ? indexes : [])
            .filter((index) => Number.isSafeInteger(index) && index >= 0));
        if (!requested.size) return [];
        const selection = [];
        const occurrences = new Map();
        promptTokens(prompt).forEach((token, index) => {
            const key = tokenKey(token);
            const occurrence = occurrences.get(key) || 0;
            if (requested.has(index)) selection.push({ token, occurrence });
            occurrences.set(key, occurrence + 1);
        });
        return selection;
    }

    function indexesForPromptSelection(prompt, selection) {
        const tokens = promptTokens(prompt);
        const wanted = new Set((Array.isArray(selection) ? selection : []).map((item) => (
            JSON.stringify([tokenKey(item.token), item.occurrence])
        )));
        const indexes = new Set();
        const occurrences = new Map();
        tokens.forEach((token, index) => {
            const key = tokenKey(token);
            const occurrence = occurrences.get(key) || 0;
            occurrences.set(key, occurrence + 1);
            if (wanted.has(JSON.stringify([key, occurrence]))) indexes.add(index);
        });
        return indexes;
    }

    function occurrenceCounts(tokens) {
        const counts = new Map();
        tokens.forEach((token) => {
            const key = tokenKey(token);
            if (key) counts.set(key, (counts.get(key) || 0) + 1);
        });
        return counts;
    }

    function scoreStyle(style, promptCounts) {
        const recipe = promptTokens(style && style.positive);
        const keys = recipe.map(tokenKey).filter(Boolean);
        const needed = new Map();
        keys.forEach((key) => needed.set(key, (needed.get(key) || 0) + 1));
        let matched = 0;
        needed.forEach((count, key) => {
            matched += Math.min(count, promptCounts.get(key) || 0);
        });
        const total = keys.length;
        return {
            style,
            matched,
            total,
            coverage: total ? matched / total : 0,
            isExact: total > 0 && matched === total,
        };
    }

    function compareText(left, right) {
        const leftText = String(left == null ? '' : left);
        const rightText = String(right == null ? '' : right);
        if (leftText < rightText) return -1;
        if (leftText > rightText) return 1;
        return 0;
    }

    function compareIdentity(left, right) {
        const leftLibrary = String(left.style && left.style.library || '');
        const rightLibrary = String(right.style && right.style.library || '');
        const libraryOrder = compareText(leftLibrary, rightLibrary);
        if (libraryOrder) return libraryOrder;
        return compareText(left.style && left.style.id, right.style && right.style.id);
    }

    function compareRank(left, right) {
        if (left.coverage !== right.coverage) return right.coverage - left.coverage;
        if (left.matched !== right.matched) return right.matched - left.matched;
        return compareIdentity(left, right);
    }

    function rankStyles(styles, promptInfo) {
        const basePrompt = promptInfo && typeof promptInfo.basePrompt === 'string' ? promptInfo.basePrompt : '';
        const promptCounts = occurrenceCounts(promptTokens(basePrompt));
        const scored = (Array.isArray(styles) ? styles : [])
            .filter((style) => style && typeof style === 'object')
            .map((style) => scoreStyle(style, promptCounts));
        const exact = scored.filter((item) => item.isExact)
            .sort((left, right) => right.total - left.total || compareIdentity(left, right));
        const candidates = scored.filter((item) => !item.isExact && item.matched > 0)
            .sort(compareRank);
        return { exact, candidates, scored };
    }

    function matchStyles(styles, promptInfo) {
        const ranked = rankStyles(styles, promptInfo);
        return { exact: ranked.exact, candidates: ranked.candidates };
    }

    function selectPromptRange(prompt, start, end) {
        if (typeof prompt !== 'string'
            || prompt.length > MAX_PROMPT_LENGTH
            || !Number.isSafeInteger(start)
            || !Number.isSafeInteger(end)
            || start < 0
            || end <= start
            || end > prompt.length) return null;
        if (!prompt.slice(start, end).replace(/,/g, '').trim()) return null;
        const tags = [];
        let tokenStart = 0;
        let logicalIndex = 0;
        for (let cursor = 0; cursor <= prompt.length; cursor += 1) {
            if (cursor !== prompt.length && prompt[cursor] !== ',') continue;
            const raw = prompt.slice(tokenStart, cursor);
            const leading = raw.length - raw.trimStart().length;
            const token = raw.trim();
            if (token) {
                const spanStart = tokenStart + leading;
                const spanEnd = spanStart + token.length;
                if (start < spanEnd && end > spanStart) {
                    tags.push({ token, index: logicalIndex });
                }
                logicalIndex += 1;
            }
            tokenStart = cursor + 1;
        }
        if (!tags.length) return null;
        return {
            text: tags.map((item) => item.token).join(', '),
            start: tags[0].index,
            end: tags[tags.length - 1].index + 1,
            tokens: tags.map((item) => item.token),
        };
    }

    function tokenParts(indexedTokens) {
        return (Array.isArray(indexedTokens) ? indexedTokens : []).map((item) => ({
            type: 'token',
            token: item && item.token,
            index: item && item.index,
        }));
    }

    function groupCustomParts(style, field, parts, expanded) {
        const recipeText = field === 'negative' ? style.negative : style.positive;
        const recipeKeys = promptTokens(recipeText).map(tokenKey).filter(Boolean);
        if (!recipeKeys.length) return parts;
        const partKeys = parts.map((part) => tokenKey(part.token));
        const matchesAt = (start) => start >= 0
            && start + recipeKeys.length <= parts.length
            && recipeKeys.every((key, offset) => partKeys[start + offset] === key);
        let selectedStart = style.rangeStarts && Number.isSafeInteger(style.rangeStarts[field])
            ? style.rangeStarts[field]
            : -1;
        if (!matchesAt(selectedStart)) {
            selectedStart = -1;
            for (let start = 0; start + recipeKeys.length <= parts.length; start += 1) {
                if (!matchesAt(start)) continue;
                if (selectedStart !== -1) return parts;
                selectedStart = start;
            }
            if (selectedStart === -1) return parts;
        }
        const selectedItems = parts.slice(selectedStart, selectedStart + recipeKeys.length);
        const marker = {
            type: 'style',
            name: typeof style.name === 'string' ? style.name : '',
            tokens: selectedItems.map((part) => part.token),
            indexes: selectedItems.map((part) => part.index),
            expanded: expanded === true,
        };
        const result = [];
        parts.forEach((part, position) => {
            if (position === selectedStart) result.push(marker);
            if (expanded === true || position < selectedStart || position >= selectedStart + recipeKeys.length) {
                result.push(part);
            }
        });
        return result;
    }

    function groupParts(style, field, indexedTokens, expanded) {
        const parts = tokenParts(indexedTokens);
        if (!style || (field !== 'base' && field !== 'negative')) return parts;
        if (style.library === 'custom') return groupCustomParts(style, field, parts, expanded);
        const recipeText = field === 'negative' ? style.negative : style.positive;
        const selected = new Set();
        const selectedItems = [];
        if (Object.prototype.hasOwnProperty.call(style, 'selection')) {
            const normalized = normalizePromptSelection(style.selection);
            if (!normalized) return parts;
            const selectedPairs = new Set(normalized[field].map((item) => (
                JSON.stringify([tokenKey(item.token), item.occurrence])
            )));
            const occurrences = new Map();
            parts.forEach((part, position) => {
                const key = tokenKey(part.token);
                const occurrence = occurrences.get(key) || 0;
                occurrences.set(key, occurrence + 1);
                if (!selectedPairs.has(JSON.stringify([key, occurrence]))) return;
                selected.add(position);
                selectedItems.push(part);
            });
        } else {
            const remaining = occurrenceCounts(promptTokens(recipeText));
            parts.forEach((part, position) => {
                const key = tokenKey(part.token);
                const count = key ? remaining.get(key) || 0 : 0;
                if (!count) return;
                remaining.set(key, count - 1);
                selected.add(position);
                selectedItems.push(part);
            });
        }
        if (!selectedItems.length) return parts;

        const firstPosition = selectedItems[0] ? parts.indexOf(selectedItems[0]) : -1;
        const marker = {
            type: 'style',
            name: typeof style.name === 'string' ? style.name : '',
            tokens: selectedItems.map((part) => part.token),
            indexes: selectedItems.map((part) => part.index),
            expanded: expanded === true,
        };
        const result = [];
        parts.forEach((part, position) => {
            if (position === firstPosition) result.push(marker);
            if (expanded === true || !selected.has(position)) result.push(part);
        });
        return result;
    }

    function cloneState(value) {
        const state = normalizeState(value);
        return {
            mode: state.mode,
            style: state.style ? {
                ...state.style,
                ...(state.style.rangeStarts ? { rangeStarts: { ...state.style.rangeStarts } } : {}),
                ...(state.style.selection ? {
                    selection: {
                        base: state.style.selection.base.map((item) => ({ ...item })),
                        negative: state.style.selection.negative.map((item) => ({ ...item })),
                    },
                } : {}),
            } : null,
            expanded: { ...state.expanded },
        };
    }

    function stateKey(value) {
        const state = normalizeState(value);
        return JSON.stringify(state);
    }

    function catalogStyle(value, library) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const id = typeof value.id === 'string'
            ? value.id
            : (typeof value.id === 'number' && Number.isFinite(value.id) ? String(value.id) : '');
        const name = typeof value.name === 'string' ? value.name : '';
        const positive = typeof value.positive === 'string' ? value.positive : '';
        const negative = typeof value.negative === 'string' ? value.negative : '';
        const normalized = normalizeStyleSnapshot({ id, library, name, positive, negative });
        if (!normalized) return null;
        const src = typeof value.src === 'string' && value.src.length <= 4096 ? value.src : '';
        return { ...normalized, src };
    }

    function create(options) {
        const config = options && typeof options === 'object' ? options : {};
        const doc = config.document || null;
        const fetchImpl = config.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
        const getPrompt = typeof config.getPrompt === 'function' ? config.getPrompt : () => ({});
        const onChange = typeof config.onChange === 'function' ? config.onChange : () => {};
        const onRender = typeof config.onRender === 'function' ? config.onRender : () => {};

        let state = normalizeState(null);
        let disposed = false;
        let interactionRevision = 0;
        let pickerOpen = false;
        let pickerView = 'candidates';
        let pickerSearch = '';
        let pickerLibrary = 'all';
        let pickerLimit = 40;
        let attempted = false;
        let pending = null;
        let activeAbortController = null;
        let requestRevision = 0;
        let catalogRevision = 0;
        let lastComputedKey = '';
        let lastPromptSignature = null;
        let restoredAutoCandidate = false;
        let promptInfo = { basePrompt: '', negativePrompt: '' };
        let lastMatches = { exact: [], candidates: [], scored: [] };
        let renderQueued = false;
        let pickerPane = 'gallery';
        let directSourceSignature = '';
        let directRanges = { base: null, negative: null };
        let directError = '';
        const mounts = [];
        const catalogs = {
            shared: { status: 'idle', styles: [], error: '' },
            personal: { status: 'idle', styles: [], error: '' },
        };

        let modal = null;
        let modalDialog = null;
        let modalTitle = null;
        let modalConnectionStatus = null;
        let modalStatus = null;
        let resultList = null;
        let moreButton = null;
        let retryButton = null;
        let searchInput = null;
        let librarySelect = null;
        let candidateButton = null;
        let allButton = null;
        let galleryPane = null;
        let directPane = null;
        let galleryTab = null;
        let directTab = null;
        let directNameInput = null;
        let directBasePrompt = null;
        let directNegativePrompt = null;
        let directBasePreview = null;
        let directNegativePreview = null;
        let directBaseClear = null;
        let directNegativeClear = null;
        let directApplyButton = null;
        let directErrorStatus = null;
        let directEmptyStatus = null;
        let reviewPane = null;
        let reviewHeading = null;
        let reviewHeroImage = null;
        let reviewHeroPlaceholder = null;
        let reviewLibraryBadge = null;
        let reviewApplyButton = null;
        let reviewErrorStatus = null;
        let reviewSelectionBox = null;
        let reviewDraft = null;
        let renderedReviewDraft = null;
        let reviewDrag = null;
        let suppressedReviewClick = null;
        const reviewFields = { base: null, negative: null };

        function readPrompt() {
            let value = {};
            try {
                value = getPrompt() || {};
            } catch (_) {
                value = {};
            }
            return {
                basePrompt: typeof value.basePrompt === 'string' ? value.basePrompt : '',
                negativePrompt: typeof value.negativePrompt === 'string' ? value.negativePrompt : '',
            };
        }

        function promptSignature(info) {
            return JSON.stringify([info.basePrompt, info.negativePrompt]);
        }

        function scheduleRender() {
            if (disposed || renderQueued) return;
            renderQueued = true;
            const enqueue = typeof queueMicrotask === 'function'
                ? queueMicrotask
                : (callback) => Promise.resolve().then(callback);
            enqueue(() => {
                renderQueued = false;
                if (disposed) return;
                mounts.forEach(renderMount);
                if (pickerOpen) renderPicker();
                onRender();
            });
        }

        function commit(nextState, notify) {
            const next = normalizeState(nextState);
            if (stateKey(next) === stateKey(state)) return false;
            state = next;
            try {
                if (notify !== false) onChange(cloneState(state));
            } finally {
                scheduleRender();
            }
            return true;
        }

        function allKnownStyles() {
            return catalogs.shared.styles.concat(catalogs.personal.styles);
        }

        function allLibrariesLoaded() {
            return LIBRARIES.every((library) => catalogs[library].status === 'success');
        }

        function libraryErrors() {
            return LIBRARIES.filter((library) => catalogs[library].status === 'error')
                .map((library) => (library === 'shared' ? '공유' : '개인') + ': ' + catalogs[library].error);
        }

        function libraryStatusText() {
            const labels = { shared: '공유', personal: '개인' };
            return LIBRARIES.map((library) => {
                const item = catalogs[library];
                if (item.status === 'loading') return labels[library] + ' 불러오는 중';
                if (item.status === 'error') return labels[library] + ' 오류: ' + item.error;
                if (item.status === 'success') return labels[library] + ' ' + item.styles.length + '개';
                return labels[library] + ' 미확인';
            }).join(' · ');
        }

        function snapshot() {
            return cloneState(state);
        }

        function snapshotForStyle(style) {
            return normalizeStyleSnapshot(style);
        }

        function selectedAutoStyle() {
            if (!allLibrariesLoaded()) return null;
            if (!lastMatches.exact.length) return null;
            const bestTotal = lastMatches.exact[0].total;
            const best = lastMatches.exact.filter((record) => record.total === bestTotal);
            if (best.length !== 1) return null;
            return snapshotForStyle(best[0].style);
        }

        function exactAgainstSaved(style) {
            if (!style) return false;
            const result = scoreStyle(style, occurrenceCounts(promptTokens(promptInfo.basePrompt)));
            return result.isExact;
        }

        function refresh(options) {
            if (disposed) return;
            const settings = options && typeof options === 'object' ? options : {};
            promptInfo = readPrompt();
            const signature = promptSignature(promptInfo);
            const promptChanged = lastPromptSignature !== null && signature !== lastPromptSignature;
            if (promptChanged && state.mode === 'auto' && state.style) {
                commit({ ...state, style: null });
            }
            lastPromptSignature = signature;

            const computedKey = JSON.stringify([state.mode, signature, catalogRevision]);
            if (computedKey !== lastComputedKey) {
                lastComputedKey = computedKey;
                lastMatches = rankStyles(allKnownStyles(), promptInfo);
                if (state.mode === 'auto') {
                    if (allLibrariesLoaded()) {
                        commit({ ...state, style: selectedAutoStyle() });
                    } else if (restoredAutoCandidate) {
                        commit({ ...state, style: exactAgainstSaved(state.style) ? state.style : null });
                    } else if (state.style && !exactAgainstSaved(state.style)) {
                        commit({ ...state, style: null });
                    }
                }
                restoredAutoCandidate = false;
                scheduleRender();
            }

            if (settings.load === true && promptInfo.basePrompt.trim() && !attempted) {
                loadCatalog(false);
            }
        }

        async function requestLibrary(library, signal) {
            if (!fetchImpl) throw new Error('fetch를 사용할 수 없습니다.');
            const response = await fetchImpl(URLS[library], { method: 'GET', signal });
            let data = {};
            try {
                data = await response.json();
            } catch (_) {
                throw new Error('응답을 읽을 수 없습니다.');
            }
            if (!response || response.ok !== true || !data || data.status !== 'success') {
                const message = data && (data.message || data.error);
                throw new Error(typeof message === 'string' && message.trim() ? message : '그림체 목록을 불러오지 못했습니다.');
            }
            if (!Array.isArray(data.styles)) throw new Error('그림체 목록 형식이 올바르지 않습니다.');
            return data.styles.map((style) => catalogStyle(style, library)).filter(Boolean);
        }

        function loadCatalog(force) {
            if (disposed) return Promise.resolve();
            if (pending) return pending;
            if (attempted && force !== true) return Promise.resolve();
            attempted = true;
            const requestId = ++requestRevision;
            activeAbortController = typeof AbortController === 'function' ? new AbortController() : null;
            const signal = activeAbortController ? activeAbortController.signal : undefined;
            LIBRARIES.forEach((library) => {
                catalogs[library].status = 'loading';
                catalogs[library].error = '';
            });
            catalogRevision += 1;
            lastComputedKey = '';
            scheduleRender();

            const task = Promise.all(LIBRARIES.map(async (library) => {
                try {
                    return { library, styles: await requestLibrary(library, signal), error: '' };
                } catch (error) {
                    return { library, styles: null, error: error && error.message ? error.message : '불러오지 못했습니다.' };
                }
            })).then((results) => {
                if (disposed || requestId !== requestRevision) return;
                results.forEach((result) => {
                    const catalog = catalogs[result.library];
                    if (result.error) {
                        catalog.status = 'error';
                        catalog.error = result.error;
                    } else {
                        catalog.status = 'success';
                        catalog.styles = result.styles;
                        catalog.error = '';
                    }
                });
                pending = null;
                activeAbortController = null;
                catalogRevision += 1;
                lastComputedKey = '';
                refresh();
                scheduleRender();
            }).catch(() => {
                if (disposed || requestId !== requestRevision) return;
                LIBRARIES.forEach((library) => {
                    catalogs[library].status = 'error';
                    catalogs[library].error = '그림체 목록을 불러오지 못했습니다.';
                });
                pending = null;
                activeAbortController = null;
                catalogRevision += 1;
                lastComputedKey = '';
                refresh();
                scheduleRender();
            });
            pending = task;
            return task;
        }

        function statusText() {
            const hasPrompt = promptInfo.basePrompt.trim().length > 0;
            const errors = libraryErrors();
            let text = '';
            if (state.mode === 'off') {
                text = '그림체 연결 해제됨';
            } else if (state.mode === 'manual') {
                if (state.style) {
                    if (state.style.library === 'project') {
                        const baseParts = groupParts(state.style, 'base',
                            promptTokens(promptInfo.basePrompt).map((token, index) => ({token, index})), false);
                        const negativeParts = groupParts(state.style, 'negative',
                            promptTokens(promptInfo.negativePrompt).map((token, index) => ({token, index})), false);
                        const matchedCount = baseParts.reduce((count, part) => count
                            + (part.type === 'style' ? part.tokens.length : 0), 0)
                            + negativeParts.reduce((count, part) => count
                                + (part.type === 'style' ? part.tokens.length : 0), 0);
                        const selectedCount = state.style.selection.base.length + state.style.selection.negative.length;
                        text = '프로젝트 그림: ' + state.style.name + ' · 선택 영역 ' + matchedCount + '/' + selectedCount;
                        if (matchedCount === 0) text += ' · 현재 프롬프트에 일치하는 태그 없음';
                        return text;
                    }
                    if (state.style.library === 'custom') {
                        const baseScore = scoreStyle(state.style, occurrenceCounts(promptTokens(promptInfo.basePrompt)));
                        const negativeScore = scoreStyle(
                            { positive: state.style.negative },
                            occurrenceCounts(promptTokens(promptInfo.negativePrompt))
                        );
                        const currentBase = groupCustomParts(
                            state.style,
                            'base',
                            promptTokens(promptInfo.basePrompt).map((token, index) => ({ type: 'token', token, index })),
                            false
                        );
                        const currentNegative = groupCustomParts(
                            state.style,
                            'negative',
                            promptTokens(promptInfo.negativePrompt).map((token, index) => ({ type: 'token', token, index })),
                            false
                        );
                        const baseMarker = currentBase.find((part) => part.type === 'style');
                        const negativeMarker = currentNegative.find((part) => part.type === 'style');
                        const matched = (baseMarker ? baseMarker.tokens.length : 0)
                            + (negativeMarker ? negativeMarker.tokens.length : 0);
                        const total = baseScore.total + negativeScore.total;
                        text = '직접 지정: ' + state.style.name + ' · 현재 일치 ' + matched + '/' + total;
                        return text;
                    }
                    let matchedCount;
                    let selectedCount;
                    if (state.style.selection) {
                        const baseParts = groupParts(
                            state.style,
                            'base',
                            promptTokens(promptInfo.basePrompt).map((token, index) => ({ token, index })),
                            false
                        );
                        const negativeParts = groupParts(
                            state.style,
                            'negative',
                            promptTokens(promptInfo.negativePrompt).map((token, index) => ({ token, index })),
                            false
                        );
                        matchedCount = baseParts.reduce((count, part) => count + (part.type === 'style' ? part.tokens.length : 0), 0)
                            + negativeParts.reduce((count, part) => count + (part.type === 'style' ? part.tokens.length : 0), 0);
                        selectedCount = state.style.selection.base.length + state.style.selection.negative.length;
                    } else {
                        const score = scoreStyle(state.style, occurrenceCounts(promptTokens(promptInfo.basePrompt)));
                        matchedCount = score.matched;
                        selectedCount = score.total;
                    }
                    const isListed = allKnownStyles().some((style) => style.library === state.style.library && style.id === state.style.id);
                    text = '수동 지정: ' + state.style.name + ' · '
                        + (state.style.selection ? '선택 영역 ' : '일치 ')
                        + matchedCount + '/' + selectedCount;
                    if (matchedCount === 0) text += ' · 현재 프롬프트에 일치하는 태그 없음';
                    if (errors.length) text += ' · 라이브러리 확인 실패';
                    else if (allLibrariesLoaded() && !isListed) text += ' · 라이브러리에서 찾을 수 없음';
                } else {
                    text = '수동 그림체를 선택해 주세요';
                }
            } else if (state.style) {
                if (errors.length) text = '자동 연결: ' + state.style.name + ' · 라이브러리 확인 실패';
                else if (!allLibrariesLoaded()) text = '자동 연결: ' + state.style.name + ' · 라이브러리 확인 중';
                else text = '자동 연결: ' + state.style.name;
            } else if (!hasPrompt) {
                text = '기본 프롬프트를 입력하면 그림체를 찾습니다';
            } else if (catalogs.shared.status === 'loading' || catalogs.personal.status === 'loading') {
                text = '공유·개인 그림체를 불러오는 중';
            } else if (allLibrariesLoaded() && lastMatches.exact.length > 1) {
                const largest = lastMatches.exact[0].total;
                const count = lastMatches.exact.filter((item) => item.total === largest).length;
                text = count > 1 ? '가장 구체적인 일치가 ' + count + '개입니다. 그림체를 선택해 주세요' : '정확히 일치하는 그림체가 있습니다';
            } else if (lastMatches.candidates.length) {
                text = '비슷한 그림체 ' + lastMatches.candidates.length + '개 · 자동 연결은 보류됨';
            } else if (errors.length) {
                text = '그림체 목록을 확인할 수 없습니다';
            } else if (allLibrariesLoaded()) {
                text = '일치하는 그림체가 없습니다';
            } else {
                text = '그림체 라이브러리를 아직 불러오지 않았습니다';
            }
            if (!hasPrompt && state.mode !== 'off' && state.mode !== 'manual') {
                text = '기본 프롬프트를 입력하면 그림체를 찾습니다';
            }
            if (errors.length && state.mode !== 'off') text += ' · ' + errors.join(' / ');
            return text;
        }

        function makeButton(label, className, action) {
            const button = doc.createElement('button');
            button.type = 'button';
            button.className = className || 'secondary';
            button.textContent = label;
            button.onclick = action;
            return button;
        }

        function renderMount(mount) {
            if (!mount || !mount.launcher) return;
            const status = statusText();
            mount.launcher.title = status;
            mount.launcher.setAttribute('aria-label', '그림체 연결: ' + status);
        }

        function mount(host) {
            if (disposed || !doc || !host || typeof doc.createElement !== 'function') return null;
            const previous = mounts.find((item) => item.host === host);
            if (previous) return previous.strip;
            const strip = doc.createElement('div');
            strip.className = 'canvas-style-strip';
            const launcher = makeButton('그림체 연결', 'canvas-style-launcher', openPicker);
            strip.appendChild(launcher);
            host.appendChild(strip);
            const record = { host, strip, launcher };
            mounts.push(record);
            renderMount(record);
            return strip;
        }

        function ensureModal() {
            if (!doc || modalDialog) return !!modalDialog;
            modal = typeof doc.getElementById === 'function' ? doc.getElementById('canvasStyleLinkModal') : null;
            if (!modal) return false;
            modalDialog = modal.querySelector ? modal.querySelector('.canvas-style-dialog') : null;
            if (!modalDialog) return false;
            modalDialog.replaceChildren();
            modalDialog.classList.add('canvas-style-dialog-content');

            const header = doc.createElement('div');
            header.className = 'canvas-style-link-header';
            modalTitle = doc.createElement('h3');
            modalTitle.id = 'canvasStyleLinkTitle';
            modalTitle.tabIndex = -1;
            modalTitle.textContent = '캔버스 그림체 연결';
            const closeHeader = makeButton('닫기', 'secondary', closePicker);
            closeHeader.setAttribute('aria-label', '캔버스 그림체 연결 닫기');
            header.append(modalTitle, closeHeader);

            const topbar = doc.createElement('div');
            topbar.className = 'canvas-style-link-topbar';
            modalConnectionStatus = doc.createElement('div');
            modalConnectionStatus.className = 'canvas-style-link-connection-status';
            modalConnectionStatus.setAttribute('role', 'status');
            modalConnectionStatus.setAttribute('aria-live', 'polite');
            const autoButton = makeButton('자동 찾기', 'secondary', autoFind);
            const disconnectButton = makeButton('연결 해제', 'secondary', disconnect);
            topbar.append(modalConnectionStatus, autoButton, disconnectButton);

            const tabs = doc.createElement('div');
            tabs.className = 'canvas-style-link-tabs';
            galleryTab = makeButton('갤러리에서 선택', 'secondary', () => setPickerPane('gallery'));
            directTab = makeButton('프롬프트에서 직접 지정', 'secondary', () => setPickerPane('direct'));
            tabs.append(galleryTab, directTab);

            const body = doc.createElement('div');
            body.className = 'canvas-style-link-body';
            galleryPane = doc.createElement('section');
            galleryPane.id = 'canvasStyleLinkGalleryPane';
            galleryPane.className = 'canvas-style-link-gallery-pane';
            galleryPane.setAttribute('aria-label', '갤러리에서 선택');
            const controls = doc.createElement('div');
            controls.className = 'canvas-style-link-controls';
            searchInput = doc.createElement('input');
            searchInput.type = 'search';
            searchInput.setAttribute('aria-label', '그림체 검색');
            searchInput.placeholder = '그림체 이름 또는 프롬프트 검색';
            searchInput.oninput = () => {
                pickerSearch = searchInput.value || '';
                pickerLimit = 40;
                renderPicker();
            };
            librarySelect = doc.createElement('select');
            librarySelect.setAttribute('aria-label', '그림체 라이브러리');
            [
                ['all', '전체'],
                ['shared', '공유'],
                ['personal', '개인'],
            ].forEach(([value, label]) => {
                const option = doc.createElement('option');
                option.value = value;
                option.textContent = label;
                librarySelect.appendChild(option);
            });
            librarySelect.onchange = () => {
                pickerLibrary = librarySelect.value || 'all';
                pickerLimit = 40;
                renderPicker();
            };
            candidateButton = makeButton('비슷한 후보', 'secondary', () => setPickerView('candidates'));
            allButton = makeButton('전체 목록', 'secondary', () => setPickerView('all'));
            controls.append(searchInput, librarySelect, candidateButton, allButton);
            const help = doc.createElement('div');
            help.className = 'canvas-style-link-help';
            help.textContent = '현재 프롬프트는 바꾸지 않고 일치하는 태그만 묶습니다. 자동 판별은 태그 기준이며 순서와 가중치는 비교하지 않습니다.';
            resultList = doc.createElement('div');
            resultList.className = 'canvas-style-link-results';
            resultList.setAttribute('role', 'group');
            resultList.setAttribute('aria-label', '그림체 갤러리');
            galleryPane.append(controls, help, resultList);

            directPane = doc.createElement('section');
            directPane.id = 'canvasStyleLinkDirectPane';
            directPane.className = 'canvas-style-link-direct-pane';
            directPane.setAttribute('aria-label', '프롬프트에서 직접 지정');
            directPane.hidden = true;

            const nameField = doc.createElement('div');
            nameField.className = 'canvas-style-link-direct-name';
            const nameLabel = doc.createElement('label');
            nameLabel.setAttribute('for', 'canvasStyleLinkDirectName');
            nameLabel.textContent = '그림체 이름';
            directNameInput = doc.createElement('input');
            directNameInput.id = 'canvasStyleLinkDirectName';
            directNameInput.type = 'text';
            directNameInput.maxLength = MAX_NAME_LENGTH;
            directNameInput.setAttribute('aria-label', '직접 지정 그림체 이름');
            nameField.append(nameLabel, directNameInput);

            const directHelp = doc.createElement('div');
            directHelp.className = 'canvas-style-link-direct-help';
            directHelp.textContent = '그림체 부분을 드래그하거나 Shift+방향키로 선택하세요. 태그 중간을 선택하면 해당 태그 전체를 묶습니다.';
            directEmptyStatus = doc.createElement('div');
            directEmptyStatus.className = 'canvas-style-link-direct-empty';
            directEmptyStatus.textContent = '기본·네거티브 프롬프트가 비어 있어 선택할 수 없습니다.';
            directEmptyStatus.hidden = true;

            const createDirectField = (field, labelText, ariaLabel) => {
                const group = doc.createElement('div');
                group.className = 'canvas-style-link-direct-field';
                const label = doc.createElement('label');
                label.className = 'canvas-style-link-direct-field-label';
                label.textContent = labelText;
                const textarea = doc.createElement('textarea');
                textarea.id = field === 'base' ? 'canvasStyleLinkBaseSource' : 'canvasStyleLinkNegativeSource';
                label.setAttribute('for', textarea.id);
                textarea.readOnly = true;
                textarea.setAttribute('aria-label', ariaLabel);
                const onSelection = () => captureDirectRange(field, textarea);
                textarea.onselect = onSelection;
                textarea.onmouseup = onSelection;
                textarea.onkeyup = onSelection;
                const previewRow = doc.createElement('div');
                previewRow.className = 'canvas-style-link-direct-preview-row';
                const previewLabel = doc.createElement('span');
                previewLabel.className = 'canvas-style-link-direct-preview-label';
                previewLabel.textContent = '선택 미리보기';
                const preview = doc.createElement('div');
                preview.className = 'canvas-style-reference-preview canvas-style-reference-token';
                preview.setAttribute('role', 'status');
                const clear = makeButton('선택 지우기', 'secondary', () => clearDirectRange(field));
                previewRow.append(previewLabel, preview, clear);
                group.append(label, textarea, previewRow);
                return { textarea, preview, clear, group };
            };
            const baseField = createDirectField('base', '기본 프롬프트', '기본 프롬프트 구간 선택');
            directBasePrompt = baseField.textarea;
            directBasePreview = baseField.preview;
            directBaseClear = baseField.clear;
            const negativeField = createDirectField('negative', '네거티브 프롬프트', '네거티브 프롬프트 구간 선택');
            directNegativePrompt = negativeField.textarea;
            directNegativePreview = negativeField.preview;
            directNegativeClear = negativeField.clear;

            directErrorStatus = doc.createElement('div');
            directErrorStatus.className = 'canvas-style-link-direct-error';
            directErrorStatus.setAttribute('role', 'alert');
            directErrorStatus.hidden = true;
            directApplyButton = makeButton('선택 구간을 그림체로 연결', 'canvas-style-link-apply', applyCustomStyle);
            directPane.append(nameField, directHelp, directEmptyStatus, baseField.group, negativeField.group,
                directErrorStatus, directApplyButton);

            reviewPane = doc.createElement('section');
            reviewPane.className = 'canvas-style-link-review-pane';
            reviewPane.hidden = true;
            reviewPane.onscroll = () => {
                if (reviewDrag) updateReviewDrag(null);
            };
            const reviewHero = doc.createElement('div');
            reviewHero.className = 'canvas-style-review-hero';
            const reviewHeroMedia = doc.createElement('div');
            reviewHeroMedia.className = 'canvas-style-review-hero-media';
            reviewHeroImage = doc.createElement('img');
            reviewHeroImage.className = 'canvas-style-review-hero-image';
            reviewHeroImage.alt = '';
            reviewHeroImage.loading = 'lazy';
            reviewHeroPlaceholder = doc.createElement('span');
            reviewHeroPlaceholder.className = 'canvas-style-review-hero-placeholder';
            reviewHeroPlaceholder.textContent = '미리보기 없음';
            reviewHeroMedia.append(reviewHeroImage, reviewHeroPlaceholder);
            const reviewHeroInfo = doc.createElement('div');
            reviewHeroInfo.className = 'canvas-style-review-hero-info';
            reviewHeading = doc.createElement('h4');
            reviewHeading.className = 'canvas-style-review-heading';
            reviewHeading.tabIndex = -1;
            reviewLibraryBadge = doc.createElement('span');
            reviewLibraryBadge.className = 'canvas-style-review-library';
            reviewHeroInfo.append(reviewHeading, reviewLibraryBadge);
            const reviewBackButton = makeButton('다른 그림체 선택', 'secondary', () => {
                setPickerPane('gallery');
                if (searchInput && typeof searchInput.focus === 'function') searchInput.focus();
            });
            reviewHero.append(reviewHeroMedia, reviewHeroInfo, reviewBackButton);

            const reviewHelp = doc.createElement('div');
            reviewHelp.className = 'canvas-style-link-help';
            reviewHelp.textContent = '버튼이나 빈 공간에서 사각형을 드래그해 여러 태그를 선택하세요. 클릭으로 포함·제외하고 Shift+클릭으로 구간을 더할 수 있습니다.';
            reviewPane.append(reviewHero, reviewHelp);

            const createReviewField = (field, labelText, containerId, ariaLabel) => {
                const section = doc.createElement('section');
                section.className = 'canvas-style-review-field';
                const header = doc.createElement('div');
                header.className = 'canvas-style-review-field-header';
                const label = doc.createElement('h5');
                label.textContent = labelText;
                const count = doc.createElement('div');
                count.className = 'canvas-style-review-count';
                header.append(label, count);

                const recipeDetails = doc.createElement('details');
                recipeDetails.className = 'canvas-style-review-recipe';
                const summary = doc.createElement('summary');
                summary.textContent = '그림체 태그 보기';
                const recipeText = doc.createElement('div');
                recipeText.className = 'canvas-style-review-recipe-text';
                recipeDetails.append(summary, recipeText);

                const noPrompt = doc.createElement('div');
                noPrompt.className = 'canvas-style-review-empty';
                noPrompt.textContent = '프롬프트가 비어 있습니다.';
                noPrompt.hidden = true;
                const noMatch = doc.createElement('div');
                noMatch.className = 'canvas-style-review-no-match';
                noMatch.textContent = '일치하는 태그가 없습니다. 그림체로 묶을 태그를 직접 선택하세요.';
                noMatch.hidden = true;
                const tokenContainer = doc.createElement('div');
                tokenContainer.className = 'canvas-style-review-tokens';
                tokenContainer.id = containerId;
                tokenContainer.setAttribute('role', 'group');
                tokenContainer.setAttribute('aria-label', ariaLabel);
                const legend = doc.createElement('div');
                legend.className = 'canvas-style-review-legend';
                legend.textContent = '✓ 지정할 영역 · 밑줄: 그림체와 일치';
                const actions = doc.createElement('div');
                actions.className = 'canvas-style-review-field-actions';
                const reset = makeButton('일치 부분 다시 선택', 'secondary', () => resetReviewField(field));
                const clear = makeButton('선택 해제', 'secondary', () => clearReviewField(field));
                actions.append(reset, clear);
                section.append(header, recipeDetails, noPrompt, noMatch, tokenContainer, legend, actions);
                reviewPane.appendChild(section);
                reviewFields[field] = { section, count, recipeText, noPrompt, noMatch, tokenContainer, legend, reset, clear, buttons: [] };
                tokenContainer.onpointerdown = (event) => beginReviewDrag(field, event);
                tokenContainer.onpointermove = (event) => {
                    if (reviewDrag && event && event.pointerId === reviewDrag.pointerId) updateReviewDrag(event);
                };
                tokenContainer.onpointerup = (event) => finishReviewDrag(false, event, true);
                tokenContainer.onpointercancel = (event) => finishReviewDrag(true, event, true);
                tokenContainer.onlostpointercapture = (event) => finishReviewDrag(true, event, true, false);
                tokenContainer.onscroll = () => {
                    if (reviewDrag && reviewDrag.field === field) updateReviewDrag(null);
                };
            };
            createReviewField('base', '기본 프롬프트', 'canvasStyleReviewBaseTokens', '기본 프롬프트 비교 영역');
            createReviewField('negative', '네거티브 프롬프트', 'canvasStyleReviewNegativeTokens', '네거티브 프롬프트 비교 영역');

            reviewErrorStatus = doc.createElement('div');
            reviewErrorStatus.className = 'canvas-style-link-review-error';
            reviewErrorStatus.setAttribute('role', 'alert');
            reviewErrorStatus.hidden = true;
            reviewApplyButton = makeButton('이 영역을 그림체로 지정', 'canvas-style-link-apply', applyReviewSelection);
            reviewApplyButton.setAttribute('aria-label', '이 영역을 그림체로 지정');
            reviewPane.append(reviewErrorStatus, reviewApplyButton);
            body.append(galleryPane, directPane, reviewPane);

            const footer = doc.createElement('div');
            footer.className = 'canvas-style-link-footer';
            modalStatus = doc.createElement('div');
            modalStatus.className = 'canvas-style-link-modal-status';
            modalStatus.setAttribute('role', 'status');
            modalStatus.setAttribute('aria-live', 'polite');
            retryButton = makeButton('다시 불러오기', 'secondary', () => loadCatalog(true));
            retryButton.className = 'canvas-style-link-retry';
            const footerActions = doc.createElement('div');
            footerActions.className = 'canvas-style-link-footer-actions';
            moreButton = makeButton('더 보기', 'secondary', () => {
                pickerLimit += 40;
                renderPicker();
            });
            footerActions.append(retryButton, moreButton);
            footer.append(modalStatus, footerActions);
            modalDialog.append(header, topbar, tabs, body, footer);
            reviewSelectionBox = doc.createElement('div');
            reviewSelectionBox.id = 'canvasStyleReviewSelectionBox';
            reviewSelectionBox.className = 'canvas-style-review-selection-box';
            reviewSelectionBox.hidden = true;
            reviewSelectionBox.setAttribute('aria-hidden', 'true');
            modal.appendChild(reviewSelectionBox);
            return true;
        }

        function clearReviewDraft() {
            finishReviewDrag(true, null, false);
            suppressedReviewClick = null;
            reviewDraft = null;
            renderedReviewDraft = null;
            if (reviewHeading) reviewHeading.textContent = '';
            if (reviewLibraryBadge) reviewLibraryBadge.textContent = '';
            if (reviewHeroImage) {
                reviewHeroImage.hidden = true;
                if (typeof reviewHeroImage.removeAttribute === 'function') reviewHeroImage.removeAttribute('src');
            }
            if (reviewHeroPlaceholder) reviewHeroPlaceholder.hidden = false;
            for (const field of ['base', 'negative']) {
                const ui = reviewFields[field];
                if (!ui) continue;
                ui.tokenContainer.replaceChildren();
                ui.buttons = [];
                ui.recipeText.textContent = '';
                ui.count.textContent = '';
            }
            if (reviewErrorStatus) {
                reviewErrorStatus.textContent = '';
                reviewErrorStatus.hidden = true;
            }
            if (reviewApplyButton) reviewApplyButton.disabled = true;
        }

        function readReviewRect(element) {
            if (!element || typeof element.getBoundingClientRect !== 'function') return null;
            const source = element.getBoundingClientRect();
            if (!source || !Number.isFinite(source.left) || !Number.isFinite(source.top)) return null;
            const width = Number.isFinite(source.width) ? source.width : source.right - source.left;
            const height = Number.isFinite(source.height) ? source.height : source.bottom - source.top;
            const right = Number.isFinite(source.right) ? source.right : source.left + width;
            const bottom = Number.isFinite(source.bottom) ? source.bottom : source.top + height;
            if (![width, height, right, bottom].every(Number.isFinite)) return null;
            return { left: source.left, top: source.top, right, bottom, width, height };
        }

        function intersectReviewRects(left, right) {
            if (!left || !right) return null;
            const rect = {
                left: Math.max(left.left, right.left),
                top: Math.max(left.top, right.top),
                right: Math.min(left.right, right.right),
                bottom: Math.min(left.bottom, right.bottom),
            };
            if (rect.right < rect.left || rect.bottom < rect.top) return null;
            rect.width = rect.right - rect.left;
            rect.height = rect.bottom - rect.top;
            return rect;
        }

        function reviewRectsOverlap(left, right) {
            return !!left && !!right
                && left.left <= right.right && left.right >= right.left
                && left.top <= right.bottom && left.bottom >= right.top;
        }

        function setReviewSelectionBox(rect) {
            if (!reviewSelectionBox) return;
            reviewSelectionBox.hidden = !rect;
            if (!rect) return;
            reviewSelectionBox.style.left = rect.left + 'px';
            reviewSelectionBox.style.top = rect.top + 'px';
            reviewSelectionBox.style.width = rect.width + 'px';
            reviewSelectionBox.style.height = rect.height + 'px';
        }

        function reviewSurfaceClientRect(surface, rect) {
            const clientLeft = Number.isFinite(surface.clientLeft) ? surface.clientLeft : 0;
            const clientTop = Number.isFinite(surface.clientTop) ? surface.clientTop : 0;
            const clientWidth = Number.isFinite(surface.clientWidth) ? surface.clientWidth : rect.width;
            const clientHeight = Number.isFinite(surface.clientHeight) ? surface.clientHeight : rect.height;
            return {
                left: rect.left + clientLeft,
                top: rect.top + clientTop,
                right: rect.left + clientLeft + clientWidth,
                bottom: rect.top + clientTop + clientHeight,
            };
        }

        function reviewSetsEqual(left, right) {
            return left.size === right.size && Array.from(left).every((value) => right.has(value));
        }

        function updateReviewDrag(event) {
            const drag = reviewDrag;
            if (!drag || drag.draft !== reviewDraft) return;
            if (event) {
                if (event.pointerId !== drag.pointerId
                    || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
                drag.latestClientX = event.clientX;
                drag.latestClientY = event.clientY;
            }
            if (!Number.isFinite(drag.latestClientX) || !Number.isFinite(drag.latestClientY)) return;
            drag.active = drag.active
                || Math.abs(drag.latestClientX - drag.downClientX) > 4
                || Math.abs(drag.latestClientY - drag.downClientY) > 4;
            if (!drag.active) {
                setReviewSelectionBox(null);
                return;
            }

            const ui = reviewFields[drag.field];
            const surface = ui && ui.tokenContainer;
            const surfaceRect = readReviewRect(surface);
            const paneRect = readReviewRect(reviewPane);
            if (!surface || !surfaceRect || !paneRect) {
                setReviewSelectionBox(null);
                return;
            }
            const scrollLeft = Number.isFinite(surface.scrollLeft) ? surface.scrollLeft : 0;
            const scrollTop = Number.isFinite(surface.scrollTop) ? surface.scrollTop : 0;
            const originX = surfaceRect.left + drag.originContentX - scrollLeft;
            const originY = surfaceRect.top + drag.originContentY - scrollTop;
            const selectionRect = {
                left: Math.min(originX, drag.latestClientX),
                top: Math.min(originY, drag.latestClientY),
                right: Math.max(originX, drag.latestClientX),
                bottom: Math.max(originY, drag.latestClientY),
            };
            const clipRect = intersectReviewRects(reviewSurfaceClientRect(surface, surfaceRect), paneRect);
            const visibleRect = intersectReviewRects(selectionRect, clipRect);
            setReviewSelectionBox(visibleRect);

            const field = drag.draft.fields[drag.field];
            const nextSelected = new Set(drag.selectedBefore);
            let lastHit = null;
            if (visibleRect) {
                ui.buttons.forEach((button, index) => {
                    if (!reviewRectsOverlap(visibleRect, readReviewRect(button))) return;
                    nextSelected.add(index);
                    lastHit = index;
                });
            }
            const changed = !reviewSetsEqual(field.selectedIndexes, nextSelected);
            field.selectedIndexes = nextSelected;
            if (lastHit !== null) field.anchor = lastHit;
            drag.draft.error = '';
            if (changed) renderReviewPane();
        }

        function finishReviewDrag(cancelled, event, restoreDraft, releaseCapture) {
            const drag = reviewDrag;
            if (!drag) return;
            if (event && event.pointerId !== drag.pointerId) return;
            if (!cancelled) updateReviewDrag(event);
            reviewDrag = null;
            setReviewSelectionBox(null);
            if (cancelled && restoreDraft !== false && drag.draft === reviewDraft) {
                const field = drag.draft.fields[drag.field];
                field.selectedIndexes = new Set(drag.selectedBefore);
                field.anchor = drag.anchorBefore;
                renderReviewPane();
            }
            if (!cancelled && drag.active) {
                suppressedReviewClick = { pointerId: drag.pointerId, button: drag.clickButton };
            }
            if (releaseCapture !== false && drag.captureSet && drag.captureOwner
                && typeof drag.captureOwner.releasePointerCapture === 'function') {
                try {
                    drag.captureOwner.releasePointerCapture(drag.pointerId);
                } catch (_) {
                    // Pointer capture can already be released by the browser.
                }
            }
        }

        function beginReviewDrag(field, event) {
            if (reviewDrag) return;
            suppressedReviewClick = null;
            const ui = reviewFields[field];
            const surface = ui && ui.tokenContainer;
            if (!reviewDraft || !reviewDraft.fields[field] || !surface || !event
                || event.button !== 0 || event.isPrimary === false
                || (event.pointerType && event.pointerType !== 'mouse')
                || !Number.isSafeInteger(event.pointerId)
                || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
            const startButton = ui.buttons.includes(event.target) ? event.target : null;
            if (!startButton && event.target !== surface) return;
            const captureOwner = startButton || surface;
            if (typeof captureOwner.setPointerCapture !== 'function') return;
            const surfaceRect = readReviewRect(surface);
            if (!surfaceRect || !readReviewRect(reviewPane)) return;
            const draft = reviewDraft;
            const fieldDraft = draft.fields[field];
            const scrollLeft = Number.isFinite(surface.scrollLeft) ? surface.scrollLeft : 0;
            const scrollTop = Number.isFinite(surface.scrollTop) ? surface.scrollTop : 0;
            reviewDrag = {
                draft,
                field,
                pointerId: event.pointerId,
                selectedBefore: new Set(fieldDraft.selectedIndexes),
                anchorBefore: fieldDraft.anchor,
                captureOwner,
                clickButton: startButton,
                captureSet: false,
                active: false,
                originContentX: event.clientX - surfaceRect.left + scrollLeft,
                originContentY: event.clientY - surfaceRect.top + scrollTop,
                downClientX: event.clientX,
                downClientY: event.clientY,
                latestClientX: event.clientX,
                latestClientY: event.clientY,
            };
            try {
                captureOwner.setPointerCapture(event.pointerId);
                reviewDrag.captureSet = true;
            } catch (_) {
                reviewDrag = null;
                setReviewSelectionBox(null);
            }
        }

        function consumeReviewClick(button, event) {
            const suppressed = suppressedReviewClick;
            if (!suppressed || !event || !(event.detail > 0)) return false;
            const pointerId = Number.isSafeInteger(event.pointerId) ? event.pointerId : null;
            const matches = pointerId === null
                ? button === suppressed.button
                : pointerId === suppressed.pointerId;
            if (!matches) return false;
            suppressedReviewClick = null;
            return true;
        }

        function startStyleReview(style) {
            if (!pickerOpen || !style || !ensureModal()) return false;
            refresh();
            const source = { ...promptInfo };
            const normalized = snapshotForStyle(style);
            if (!normalized || !LIBRARIES.includes(normalized.library)) return false;
            const catalogSnapshot = { ...normalized, src: typeof style.src === 'string' ? style.src : '' };
            const sameStyle = state.style
                && state.style.id === catalogSnapshot.id
                && state.style.library === catalogSnapshot.library
                && state.style.selection;
            const fields = {};
            for (const field of ['base', 'negative']) {
                const prompt = field === 'base' ? source.basePrompt : source.negativePrompt;
                const tokens = promptTokens(prompt);
                const indexedTokens = tokens.map((token, index) => ({ token, index }));
                const matched = groupParts(catalogSnapshot, field, indexedTokens, false)
                    .find((part) => part.type === 'style');
                const initialMatchedIndexes = new Set(matched ? matched.indexes : []);
                const savedSelection = sameStyle ? state.style.selection[field] : null;
                const selectedIndexes = savedSelection
                    ? indexesForPromptSelection(prompt, savedSelection)
                    : new Set(initialMatchedIndexes);
                fields[field] = {
                    prompt,
                    tokens,
                    recipeTotal: promptTokens(field === 'base' ? catalogSnapshot.positive : catalogSnapshot.negative).length,
                    initialMatchedIndexes,
                    selectedIndexes,
                    anchor: null,
                };
            }
            reviewDraft = {
                style: catalogSnapshot,
                source,
                signature: promptSignature(source),
                fields,
            };
            renderedReviewDraft = null;
            pickerPane = 'review';
            renderPicker();
            if (reviewHeading && typeof reviewHeading.focus === 'function') reviewHeading.focus();
            return true;
        }

        function updateReviewField(field) {
            if (!reviewDraft || !reviewFields[field]) return;
            const draft = reviewDraft.fields[field];
            const ui = reviewFields[field];
            const total = draft.tokens.length;
            ui.count.textContent = '일치 ' + draft.initialMatchedIndexes.size + '/' + draft.recipeTotal
                + ' · 선택 ' + draft.selectedIndexes.size + '개';
            ui.noPrompt.hidden = total > 0;
            ui.noMatch.hidden = total === 0 || draft.initialMatchedIndexes.size > 0;
            ui.reset.disabled = draft.initialMatchedIndexes.size === 0;
            ui.clear.disabled = draft.selectedIndexes.size === 0;
            ui.buttons.forEach((button, index) => {
                const selected = draft.selectedIndexes.has(index);
                const matched = draft.initialMatchedIndexes.has(index);
                button.className = 'canvas-style-review-token'
                    + (matched ? ' is-match' : '')
                    + (selected ? ' is-selected' : '');
                button.setAttribute('aria-pressed', selected ? 'true' : 'false');
                button.title = matched ? '그림체와 일치' : '직접 선택 가능';
                button.textContent = draft.tokens[index];
            });
        }

        function renderReviewPane() {
            if (!reviewPane || !reviewDraft) return;
            const draft = reviewDraft;
            if (renderedReviewDraft !== draft) {
                reviewHeading.textContent = draft.style.name;
                reviewHeading.title = draft.style.name;
                reviewLibraryBadge.textContent = draft.style.library === 'shared' ? '공유' : '개인';
                if (draft.style.src) {
                    reviewHeroImage.src = draft.style.src;
                    reviewHeroImage.hidden = false;
                    reviewHeroPlaceholder.hidden = true;
                } else {
                    reviewHeroImage.hidden = true;
                    reviewHeroPlaceholder.hidden = false;
                }
                for (const field of ['base', 'negative']) {
                    const ui = reviewFields[field];
                    const recipe = field === 'base' ? draft.style.positive : draft.style.negative;
                    ui.recipeText.textContent = recipe || '그림체 태그가 없습니다.';
                    ui.tokenContainer.replaceChildren();
                    ui.buttons = [];
                    draft.fields[field].tokens.forEach((token, index) => {
                        const button = makeButton(token, 'canvas-style-review-token', (event) => {
                            if (consumeReviewClick(button, event)) return;
                            toggleReviewToken(field, index, !!(event && event.shiftKey));
                        });
                        button.setAttribute('data-index', String(index));
                        ui.buttons.push(button);
                        ui.tokenContainer.appendChild(button);
                    });
                }
                renderedReviewDraft = draft;
            }
            for (const field of ['base', 'negative']) updateReviewField(field);
            if (reviewErrorStatus) {
                reviewErrorStatus.hidden = !draft.error;
                reviewErrorStatus.textContent = draft.error || '';
            }
            if (reviewApplyButton) {
                const anySelected = draft.fields.base.selectedIndexes.size > 0
                    || draft.fields.negative.selectedIndexes.size > 0;
                reviewApplyButton.disabled = !anySelected;
            }
        }

        function toggleReviewToken(field, index, extendRange) {
            if (!reviewDraft || !reviewDraft.fields[field]) return;
            const draft = reviewDraft.fields[field];
            if (extendRange && Number.isSafeInteger(draft.anchor)) {
                const start = Math.min(draft.anchor, index);
                const end = Math.max(draft.anchor, index);
                for (let current = start; current <= end; current += 1) draft.selectedIndexes.add(current);
            } else if (draft.selectedIndexes.has(index)) {
                draft.selectedIndexes.delete(index);
            } else {
                draft.selectedIndexes.add(index);
            }
            draft.anchor = index;
            reviewDraft.error = '';
            renderReviewPane();
        }

        function resetReviewField(field) {
            if (!reviewDraft || !reviewDraft.fields[field]) return;
            const draft = reviewDraft.fields[field];
            draft.selectedIndexes = new Set(draft.initialMatchedIndexes);
            draft.anchor = null;
            reviewDraft.error = '';
            renderReviewPane();
        }

        function clearReviewField(field) {
            if (!reviewDraft || !reviewDraft.fields[field]) return;
            const draft = reviewDraft.fields[field];
            draft.selectedIndexes.clear();
            draft.anchor = null;
            reviewDraft.error = '';
            renderReviewPane();
        }

        function applyReviewSelection() {
            if (!reviewDraft) return false;
            const draft = reviewDraft;
            const baseIndexes = Array.from(draft.fields.base.selectedIndexes);
            const negativeIndexes = Array.from(draft.fields.negative.selectedIndexes);
            if (!baseIndexes.length && !negativeIndexes.length) return false;
            if (promptSignature(readPrompt()) !== draft.signature) {
                draft.error = '프롬프트가 변경되었습니다. 다른 그림체 선택으로 돌아가 다시 비교해 주세요.';
                renderReviewPane();
                return false;
            }
            const selectedStyle = snapshotForStyle({
                id: draft.style.id,
                library: draft.style.library,
                name: draft.style.name,
                positive: draft.style.positive,
                negative: draft.style.negative,
                selection: {
                    base: buildPromptSelection(draft.source.basePrompt, baseIndexes),
                    negative: buildPromptSelection(draft.source.negativePrompt, negativeIndexes),
                },
            });
            if (!selectedStyle) return false;
            interactionRevision += 1;
            commit({
                mode: 'manual',
                style: selectedStyle,
                expanded: { base: false, negative: false },
            });
            closePicker();
            return true;
        }

        function setPickerView(view) {
            pickerView = view === 'all' ? 'all' : 'candidates';
            pickerLimit = 40;
            renderPicker();
        }

        function setPickerPane(pane) {
            const nextPane = pane === 'direct' ? 'direct' : 'gallery';
            if (pickerPane === 'review') clearReviewDraft();
            pickerPane = nextPane;
            renderPicker();
        }

        function renderDirectPane() {
            if (!directPane) return;
            const base = directRanges.base;
            const negative = directRanges.negative;
            if (directBasePreview) directBasePreview.textContent = base ? base.text : '선택된 태그 없음';
            if (directNegativePreview) directNegativePreview.textContent = negative ? negative.text : '선택된 태그 없음';
            if (directBaseClear) directBaseClear.disabled = !base;
            if (directNegativeClear) directNegativeClear.disabled = !negative;
            if (directEmptyStatus) {
                directEmptyStatus.hidden = !!(directBasePrompt && directBasePrompt.value)
                    || !!(directNegativePrompt && directNegativePrompt.value);
            }
            if (directErrorStatus) {
                directErrorStatus.hidden = !directError;
                directErrorStatus.textContent = directError;
            }
            if (directApplyButton) directApplyButton.disabled = !base && !negative;
        }

        function captureDirectRange(field, textarea) {
            const source = field === 'negative'
                ? (directNegativePrompt ? directNegativePrompt.value : '')
                : (directBasePrompt ? directBasePrompt.value : '');
            directRanges[field] = selectPromptRange(source, textarea.selectionStart, textarea.selectionEnd);
            directError = '';
            renderDirectPane();
        }

        function clearDirectRange(field) {
            if (field !== 'base' && field !== 'negative') return;
            directRanges[field] = null;
            directError = '';
            renderDirectPane();
        }

        function applyCustomStyle() {
            if (!directRanges.base && !directRanges.negative) return false;
            const latest = readPrompt();
            if (promptSignature(latest) !== directSourceSignature) {
                directError = '프롬프트가 변경되었습니다. 모달을 다시 열어 구간을 지정해 주세요.';
                renderDirectPane();
                return false;
            }
            const typedName = directNameInput && typeof directNameInput.value === 'string'
                ? directNameInput.value.trim().slice(0, MAX_NAME_LENGTH)
                : '';
            const base = directRanges.base;
            const negative = directRanges.negative;
            const custom = {
                id: 'canvas-custom',
                library: 'custom',
                name: typedName || '직접 지정',
                positive: base ? base.text : '',
                negative: negative ? negative.text : '',
                rangeStarts: {
                    base: base ? base.start : null,
                    negative: negative ? negative.start : null,
                },
            };
            return chooseStyle(custom);
        }

        function openPicker() {
            if (disposed) return false;
            interactionRevision += 1;
            return showPicker();
        }

        function showPicker() {
            if (disposed || !ensureModal()) return false;
            refresh();
            clearReviewDraft();
            directSourceSignature = promptSignature(promptInfo);
            directRanges = { base: null, negative: null };
            directError = '';
            pickerPane = 'gallery';
            if (directNameInput) directNameInput.value = '직접 지정';
            if (directBasePrompt) directBasePrompt.value = promptInfo.basePrompt;
            if (directNegativePrompt) directNegativePrompt.value = promptInfo.negativePrompt;
            pickerView = lastMatches.exact.length || lastMatches.candidates.length ? 'candidates' : 'all';
            pickerSearch = '';
            pickerLibrary = 'all';
            pickerLimit = 40;
            if (searchInput) searchInput.value = '';
            if (librarySelect) librarySelect.value = 'all';
            pickerOpen = true;
            modal.style.display = 'flex';
            modal.setAttribute('aria-hidden', 'false');
            renderPicker();
            if (modalTitle && typeof modalTitle.focus === 'function') modalTitle.focus();
            loadCatalog(false);
            return true;
        }

        function closePicker() {
            interactionRevision += 1;
            if (!pickerOpen && (!modal || !modal.style)) return false;
            pickerOpen = false;
            clearReviewDraft();
            if (modal) {
                modal.style.display = 'none';
                modal.setAttribute('aria-hidden', 'true');
            }
            scheduleRender();
            return true;
        }

        function chooseStyle(style) {
            const nextStyle = snapshotForStyle(style);
            if (!nextStyle) return false;
            interactionRevision += 1;
            commit({
                ...state,
                mode: 'manual',
                style: nextStyle,
                expanded: nextStyle.library === 'custom'
                    ? { base: false, negative: false }
                    : state.expanded,
            });
            closePicker();
            return true;
        }

        function disconnect() {
            interactionRevision += 1;
            commit({ mode: 'off', style: null, expanded: state.expanded });
            closePicker();
        }

        function autoFind() {
            const revision = ++interactionRevision;
            if (pickerOpen && pickerPane === 'review') setPickerPane('gallery');
            const priorStyle = state.mode === 'auto' ? state.style : null;
            commit({ ...state, mode: 'auto', style: priorStyle });
            refresh();
            if (!promptInfo.basePrompt.trim()) return;
            const capturedPromptSignature = promptSignature(promptInfo);
            let task;
            if (allLibrariesLoaded() && libraryErrors().length === 0) {
                task = Promise.resolve();
            } else {
                task = loadCatalog(true);
            }
            Promise.resolve(task).then(() => {
                if (disposed
                    || interactionRevision !== revision
                    || state.mode !== 'auto'
                    || promptSignature(readPrompt()) !== capturedPromptSignature) return;
                refresh();
                if (disposed
                    || interactionRevision !== revision
                    || state.mode !== 'auto'
                    || promptSignature(readPrompt()) !== capturedPromptSignature) return;
                if (!state.style) {
                    if (pickerOpen) renderPicker();
                    else showPicker();
                }
            });
        }

        function controllerGroupParts(field, indexedTokens) {
            if (state.mode === 'off' || !state.style) return tokenParts(indexedTokens);
            return groupParts(state.style, field, indexedTokens, state.expanded[field] === true);
        }

        function toggleExpanded(field) {
            if (field !== 'base' && field !== 'negative') return false;
            commit({
                ...state,
                expanded: { ...state.expanded, [field]: !state.expanded[field] },
            });
            return state.expanded[field];
        }

        function restore(value) {
            interactionRevision += 1;
            closePicker();
            state = normalizeState(value);
            restoredAutoCandidate = state.mode === 'auto' && !!state.style;
            lastPromptSignature = null;
            lastComputedKey = '';
            lastMatches = { exact: [], candidates: [], scored: [] };
            scheduleRender();
            return snapshot();
        }

        function statusForPicker() {
            const errors = libraryErrors();
            if (catalogs.shared.status === 'loading' || catalogs.personal.status === 'loading') {
                return '공유·개인 그림체를 불러오는 중 · ' + libraryStatusText();
            }
            if (errors.length) return libraryStatusText() + ' · 실패한 라이브러리를 다시 불러올 수 있습니다.';
            if (allLibrariesLoaded()) return statusText() + ' · ' + libraryStatusText();
            return '그림체 목록을 불러오지 않았습니다.';
        }

        function pickerRecords() {
            let records;
            if (pickerView === 'candidates') {
                records = lastMatches.exact.concat(lastMatches.candidates)
                    .filter((record) => pickerLibrary === 'all' || record.style.library === pickerLibrary)
                    .sort((left, right) => {
                        if (left.isExact !== right.isExact) return left.isExact ? -1 : 1;
                        if (left.isExact) return right.total - left.total || compareIdentity(left, right);
                        return compareRank(left, right);
                    });
            } else {
                records = lastMatches.scored
                    .filter((record) => pickerLibrary === 'all' || record.style.library === pickerLibrary)
                    .sort((left, right) => {
                    const nameOrder = String(left.style.name).localeCompare(String(right.style.name));
                    return nameOrder || compareIdentity(left, right);
                });
            }
            const query = pickerSearch.trim().toLowerCase();
            if (query) {
                records = records.filter((record) => (
                    record.style.name + ' ' + record.style.positive + ' ' + record.style.negative
                ).toLowerCase().includes(query));
            }
            return records;
        }

        function renderPicker() {
            if (!pickerOpen || !resultList || !doc) return;
            const onGallery = pickerPane === 'gallery';
            const onDirect = pickerPane === 'direct';
            if (galleryPane) galleryPane.hidden = !onGallery;
            if (directPane) directPane.hidden = !onDirect;
            if (reviewPane) reviewPane.hidden = pickerPane !== 'review';
            if (galleryTab) galleryTab.setAttribute('aria-pressed', onDirect ? 'false' : 'true');
            if (directTab) directTab.setAttribute('aria-pressed', onDirect ? 'true' : 'false');

            const status = statusForPicker();
            if (modalConnectionStatus) modalConnectionStatus.textContent = statusText();
            if (modalStatus) modalStatus.textContent = directError || status;
            if (retryButton) {
                retryButton.hidden = libraryErrors().length === 0;
                retryButton.disabled = catalogs.shared.status === 'loading' || catalogs.personal.status === 'loading';
            }
            if (moreButton) moreButton.hidden = !onGallery;
            renderDirectPane();
            renderReviewPane();
            if (!onGallery) return;

            const records = pickerRecords();
            const visible = records.slice(0, pickerLimit);
            resultList.replaceChildren();
            if (!visible.length) {
                const empty = doc.createElement('div');
                empty.className = 'canvas-style-link-empty';
                if (pickerView === 'candidates') {
                    empty.textContent = '겹치는 후보가 없습니다. 전체 목록에서 직접 고를 수 있습니다.';
                } else if (libraryErrors().length && allKnownStyles().length === 0) {
                    empty.textContent = '표시할 그림체가 없습니다. 라이브러리를 다시 불러와 주세요.';
                } else if (catalogs.shared.status === 'loading' || catalogs.personal.status === 'loading') {
                    empty.textContent = '그림체 목록을 불러오는 중입니다.';
                } else {
                    empty.textContent = '검색 조건에 맞는 그림체가 없습니다.';
                }
                resultList.appendChild(empty);
            }
            visible.forEach((record) => {
                const style = record.style;
                const button = doc.createElement('button');
                button.type = 'button';
                button.className = 'canvas-style-link-item';
                button.setAttribute('aria-label', style.name + ' 비교');
                button.title = style.name;
                const isSelected = state.style
                    && state.style.library === style.library
                    && state.style.id === style.id;
                button.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
                if (isSelected) button.classList.add('is-selected');
                button.onclick = () => startStyleReview(style);
                if (style.src) {
                    const image = doc.createElement('img');
                    image.className = 'canvas-style-link-thumbnail';
                    image.alt = '';
                    image.loading = 'lazy';
                    image.src = style.src;
                    button.appendChild(image);
                } else {
                    const placeholder = doc.createElement('span');
                    placeholder.className = 'canvas-style-link-thumbnail-placeholder';
                    placeholder.textContent = '미리보기 없음';
                    button.appendChild(placeholder);
                }
                const details = doc.createElement('span');
                details.className = 'canvas-style-link-item-details';
                const name = doc.createElement('span');
                name.className = 'canvas-style-link-item-name';
                name.textContent = style.name;
                name.title = style.name;
                const meta = doc.createElement('span');
                meta.className = 'canvas-style-link-item-meta';
                meta.textContent = (style.library === 'shared' ? '공유' : '개인')
                    + ' · 일치 ' + record.matched + '/' + record.total;
                details.append(name, meta);
                button.appendChild(details);
                resultList.appendChild(button);
            });
            if (moreButton) {
                moreButton.hidden = visible.length >= records.length;
                moreButton.disabled = visible.length >= records.length;
            }
            if (candidateButton) {
                candidateButton.setAttribute('aria-pressed', pickerView === 'candidates' ? 'true' : 'false');
                candidateButton.disabled = lastMatches.exact.length + lastMatches.candidates.length === 0;
            }
            if (allButton) allButton.setAttribute('aria-pressed', pickerView === 'all' ? 'true' : 'false');
            if (modalStatus) modalStatus.textContent = directError || status;
        }

        function dispose() {
            if (disposed) return;
            interactionRevision += 1;
            disposed = true;
            requestRevision += 1;
            if (activeAbortController) activeAbortController.abort();
            activeAbortController = null;
            pending = null;
            mounts.forEach((item) => {
                if (item.strip && typeof item.strip.remove === 'function') item.strip.remove();
            });
            mounts.length = 0;
            if (modal) {
                modal.style.display = 'none';
                modal.setAttribute('aria-hidden', 'true');
            }
            pickerOpen = false;
            clearReviewDraft();
        }

        return {
            mount,
            refresh,
            snapshot,
            restore,
            groupParts: controllerGroupParts,
            toggleExpanded,
            openPicker,
            closePicker,
            dispose,
        };
    }

    return { create, tokenKey, matchStyles, groupParts, normalizeState, selectPromptRange, buildPromptSelection };
});
