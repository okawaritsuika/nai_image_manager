(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.CanvasWorkspaceState = api;
}(typeof globalThis === 'object' ? globalThis : this, function () {
    'use strict';

    const LEGACY_STATE_KEY = 'naia_canvas_state_v1';
    const MANIFEST_PREFIX = 'naia_canvas_workspace_v1:';
    const PANE_PREFIX = 'naia_canvas_pane_v1:';
    const ID_PATTERN = /^[a-f0-9]{32}$/;
    const PANE_KEY_PATTERN = /^naia_canvas_pane_v1:([a-f0-9]{32}):([a-f0-9]{32})$/;

    function validId(value) {
        return typeof value === 'string' && ID_PATTERN.test(value);
    }

    function isPlainObject(value) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function context(search) {
        const params = new URLSearchParams(typeof search === 'string' ? search : '');
        const workspaceId = params.get('workspace');
        if (!validId(workspaceId)) return {mode: 'single', workspaceId: null, paneId: null};
        if (!params.has('pane')) return {mode: 'host', workspaceId, paneId: null};
        const paneId = params.get('pane');
        if (!validId(paneId)) return {mode: 'single', workspaceId: null, paneId: null};
        return {mode: 'pane', workspaceId, paneId};
    }

    function stateKey(workspaceId, paneId) {
        if (!validId(workspaceId) || !validId(paneId)) return null;
        return PANE_PREFIX + workspaceId + ':' + paneId;
    }

    function manifestKey(workspaceId) {
        if (!validId(workspaceId)) return null;
        return MANIFEST_PREFIX + workspaceId;
    }

    function normalize(value) {
        if (!isPlainObject(value) || value.version !== 1 || !Array.isArray(value.panes)) return null;

        const panes = [];
        const paneIds = new Set();
        const projectPairs = new Set();
        for (const input of value.panes) {
            if (!isPlainObject(input) || !validId(input.id) || paneIds.has(input.id)) continue;
            paneIds.add(input.id);

            const pane = {
                id: input.id,
                name: typeof input.name === 'string' ? input.name.trim() : '',
                closed: input.closed === true,
                retouch: input.retouch === true,
            };
            if (!pane.name || pane.name.length > 150) pane.name = '캔버스';
            if (isPlainObject(input.reference)) {
                const number = (key, fallback, min, max) => typeof input.reference[key] === 'number'
                    && Number.isFinite(input.reference[key]) ? Math.min(max, Math.max(min, input.reference[key])) : fallback;
                pane.reference = {visible: input.reference.visible !== false,
                    x: number('x', 8, 0, 10000), y: number('y', 8, 0, 10000),
                    width: number('width', 160, 120, 2000), height: number('height', 300, 120, 2000)};
                if (typeof input.reference.fitHeight === 'number' && Number.isFinite(input.reference.fitHeight)
                    && input.reference.fitHeight > 0 && input.reference.fitHeight <= 100000
                    && typeof input.reference.fitRatio === 'number' && Number.isFinite(input.reference.fitRatio)
                    && input.reference.fitRatio > 0 && input.reference.fitRatio <= 100000) {
                    pane.reference.fitHeight = input.reference.fitHeight;
                    pane.reference.fitRatio = input.reference.fitRatio;
                }
            }

            const hasProjectPair = validId(input.projectId) && validId(input.canvasId);
            if (hasProjectPair) {
                const pairKey = input.projectId + ':' + input.canvasId;
                if (projectPairs.has(pairKey)) continue;
                pane.projectId = input.projectId;
                pane.canvasId = input.canvasId;
                projectPairs.add(pairKey);
            } else if (typeof input.setupId === 'string' && input.setupId.trim().length > 0
                && input.setupId.length <= 200) {
                pane.setupId = input.setupId;
            }
            panes.push(pane);
        }

        const openPanes = panes.filter(pane => !pane.closed);
        const activeId = openPanes.some(pane => pane.id === value.activeId)
            ? value.activeId
            : (openPanes[0]?.id ?? null);
        return {
            version: 1,
            panes,
            activeId,
            layout: value.layout === 'grid' ? 'grid' : 'row',
        };
    }

    function frameUrl(workspaceId, pane) {
        if (!validId(workspaceId) || !isPlainObject(pane) || !validId(pane.id)) return null;
        let url = '/canvas?workspace=' + workspaceId + '&pane=' + pane.id;
        if (validId(pane.projectId) && validId(pane.canvasId)) {
            url += '&project=' + pane.projectId + '&canvas=' + pane.canvasId;
        }
        return url;
    }

    function storedStates(storage) {
        if (!storage) return [];
        let length;
        try {
            length = storage.length;
        } catch (_) {
            return [];
        }
        if (!Number.isSafeInteger(length) || length < 0 || typeof storage.key !== 'function'
            || typeof storage.getItem !== 'function') return [];

        const states = [];
        for (let index = 0; index < length; index += 1) {
            let key;
            try {
                key = storage.key(index);
                if (key !== LEGACY_STATE_KEY && !(typeof key === 'string' && PANE_KEY_PATTERN.test(key))) continue;
                const raw = storage.getItem(key);
                if (typeof raw !== 'string') continue;
                const state = JSON.parse(raw);
                if (state !== null && typeof state === 'object' && !Array.isArray(state)) states.push(state);
            } catch (_) {
                // A corrupt or unavailable entry does not prevent protecting the remaining canvas states.
            }
        }
        return states;
    }

    return {
        LEGACY_STATE_KEY,
        MANIFEST_PREFIX,
        PANE_PREFIX,
        context,
        stateKey,
        manifestKey,
        normalize,
        frameUrl,
        storedStates,
    };
}));
