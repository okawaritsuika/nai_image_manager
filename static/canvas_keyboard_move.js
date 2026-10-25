(function (root) {
    'use strict';

    const DEFAULT_SETTINGS = Object.freeze({unit: 'px', step: 1, shiftStep: 10});
    const ARROW_KEYS = new Set(['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown']);
    const TARGET_IGNORE_SELECTOR = [
        'input', 'textarea', 'select',
        '[contenteditable]:not([contenteditable="false"])',
        '[role="dialog"]', 'dialog', '.modal-overlay', '.modal',
        '.reference-gen-layer', '.canvas-keyboard-move-controls'
    ].join(', ');

    let settings = {...DEFAULT_SETTINGS};
    let globalListenersBound = false;
    let controlsBound = false;
    const pressedArrowKeys = new Set();
    const movedLayers = new Set();
    const movedSelections = new Set();
    let hasPendingMove = false;

    function isUnit(value) {
        return value === 'px' || value === 'percent';
    }

    function normalizeStep(value, fallback, unit) {
        if (value === null || value === undefined || typeof value === 'boolean') return fallback;
        if (typeof value === 'string' && !value.trim()) return fallback;

        const number = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(number)) return fallback;

        if (unit === 'percent') {
            const rounded = Math.round(number * 100) / 100;
            return Math.min(100, Math.max(0.01, rounded));
        }

        return Math.min(10000, Math.max(1, Math.round(number)));
    }

    function normalizeSettings(value, fallback = DEFAULT_SETTINGS) {
        const source = value && typeof value === 'object' ? value : {};
        const fallbackSource = fallback && typeof fallback === 'object' ? fallback : DEFAULT_SETTINGS;
        const fallbackUnit = isUnit(fallbackSource.unit) ? fallbackSource.unit : DEFAULT_SETTINGS.unit;
        const fallbackStep = normalizeStep(fallbackSource.step, DEFAULT_SETTINGS.step, fallbackUnit);
        const fallbackShiftStep = normalizeStep(fallbackSource.shiftStep, DEFAULT_SETTINGS.shiftStep, fallbackUnit);
        const unit = isUnit(source.unit) ? source.unit : fallbackUnit;

        return {
            unit,
            step: normalizeStep(source.step, normalizeStep(fallbackStep, DEFAULT_SETTINGS.step, unit), unit),
            shiftStep: normalizeStep(source.shiftStep, normalizeStep(fallbackShiftStep, DEFAULT_SETTINGS.shiftStep, unit), unit)
        };
    }

    function movementDelta(key, shift, value, width, height) {
        const arrowKey = String(key || '');
        if (!ARROW_KEYS.has(arrowKey)) return null;

        const normalized = normalizeSettings(value);
        const amount = shift ? normalized.shiftStep : normalized.step;
        let horizontal = arrowKey === 'ArrowLeft' || arrowKey === 'ArrowRight';

        if (normalized.unit === 'percent') {
            const dimension = Number(horizontal ? width : height);
            if (!Number.isFinite(dimension) || dimension <= 0) return null;
            // Positions are stored in original canvas pixels, independent of screen zoom.
            const roundedAmount = Math.max(1, Math.round(dimension * amount / 100));
            return {
                dx: horizontal ? (arrowKey === 'ArrowLeft' ? -roundedAmount : roundedAmount) : 0,
                dy: horizontal ? 0 : (arrowKey === 'ArrowUp' ? -roundedAmount : roundedAmount)
            };
        }

        return {
            dx: horizontal ? (arrowKey === 'ArrowLeft' ? -amount : amount) : 0,
            dy: horizontal ? 0 : (arrowKey === 'ArrowUp' ? -amount : amount)
        };
    }

    function getControlElements() {
        const doc = root.document;
        if (!doc?.getElementById) return null;
        return {
            group: doc.getElementById('canvasKeyboardMoveControls'),
            unit: doc.getElementById('canvasKeyboardMoveUnit'),
            step: doc.getElementById('canvasKeyboardMoveStep'),
            shiftStep: doc.getElementById('canvasKeyboardMoveShiftStep')
        };
    }

    function currentMoveMode() {
        return typeof isLayerMoveMode !== 'undefined' && Boolean(isLayerMoveMode);
    }

    function syncControls() {
        bindControlsIfAvailable();

        const controls = getControlElements();
        if (!controls) return;

        if (controls.group) controls.group.hidden = !currentMoveMode();

        if (controls.unit) {
            if (root.document.activeElement !== controls.unit) controls.unit.value = settings.unit;
        }

        const range = settings.unit === 'percent'
            ? {min: '0.01', max: '100', step: '0.01'}
            : {min: '1', max: '10000', step: '1'};

        [controls.step, controls.shiftStep].forEach((input, index) => {
            if (!input) return;
            input.min = range.min;
            input.max = range.max;
            input.step = range.step;
            if (root.document.activeElement !== input) {
                input.value = String(index === 0 ? settings.step : settings.shiftStep);
            }
        });
    }

    function bindControlsIfAvailable() {
        if (controlsBound) return;
        const controls = getControlElements();
        if (!controls?.unit || !controls.step || !controls.shiftStep) return;

        controls.unit.addEventListener('change', () => {
            settings = normalizeSettings({...settings, unit: controls.unit.value}, settings);
            controls.unit.value = settings.unit;
            syncControls();
        });

        [[controls.step, 'step'], [controls.shiftStep, 'shiftStep']].forEach(([input, field]) => {
            input.addEventListener('change', () => {
                settings = normalizeSettings({...settings, [field]: input.value}, settings);
                input.value = String(settings[field]);
                syncControls();
            });
        });

        controlsBound = true;
    }

    function eventTargetIsIgnored(target) {
        return Boolean(
            target?.isContentEditable ||
            target?.closest?.(TARGET_IGNORE_SELECTOR)
        );
    }

    function movementIsBlocked() {
        return Boolean(
            (typeof hasActiveCanvasGeometryDrag === 'function' && hasActiveCanvasGeometryDrag()) ||
            (typeof activePinnedReferenceMoveDrag !== 'undefined' && activePinnedReferenceMoveDrag) ||
            (typeof activePinnedReferenceResizeDrag !== 'undefined' && activePinnedReferenceResizeDrag) ||
            (typeof isClipMaskPainting !== 'undefined' && isClipMaskPainting) ||
            (typeof clipInpaintLoadingClipId !== 'undefined' && clipInpaintLoadingClipId) ||
            (typeof externalCanvasImageImportBusy !== 'undefined' && externalCanvasImageImportBusy) ||
            (typeof pendingCanvasClipMaskWrites !== 'undefined' && pendingCanvasClipMaskWrites > 0) ||
            (typeof canvasLayerEraserEnabled !== 'undefined' && canvasLayerEraserEnabled) ||
            root.CanvasRetouch?.isOpen?.()
        );
    }

    function getMoveRoots() {
        const selected = typeof getSelectedTransformLayers === 'function'
            ? getSelectedTransformLayers().filter(Boolean)
            : [];
        if (selected.length) return selected;

        const active = typeof getActiveTransformLayerOrNull === 'function'
            ? getActiveTransformLayerOrNull()
            : null;
        return active ? [active] : [];
    }

    function rememberMovedLayer(layer) {
        if (!layer || !Number.isFinite(Number(layer.id))) return;
        movedLayers.add(layer);
        if (layer.type === 'selection') movedSelections.add(layer);
    }

    function moveLayer(layer, dx, dy) {
        if (!layer || !Number.isFinite(Number(layer.id))) return false;
        const x = Number(layer.x);
        const y = Number(layer.y);
        layer.x = (Number.isFinite(x) ? Math.round(x) : 0) + dx;
        layer.y = (Number.isFinite(y) ? Math.round(y) : 0) + dy;
        rememberMovedLayer(layer);
        return true;
    }

    function moveCurrentSelection(dx, dy) {
        const roots = getMoveRoots();
        if (!roots.length) return false;

        let moved = false;
        roots.forEach((layer) => {
            moved = moveLayer(layer, dx, dy) || moved;
        });

        if (typeof buildSelectionChildMoveStarts === 'function' && typeof findCanvasLayer === 'function') {
            buildSelectionChildMoveStarts(roots).forEach((start) => {
                const child = findCanvasLayer(start.id)?.layer;
                if (!child || typeof isSelectionChildMovableLayer !== 'function' || !isSelectionChildMovableLayer(child)) return;
                moved = moveLayer(child, dx, dy) || moved;
            });
        }

        return moved;
    }

    function findCurrentLayer(layer) {
        if (!layer || typeof findCanvasLayer !== 'function') return null;
        const found = findCanvasLayer(layer.id);
        return found?.layer === layer ? layer : null;
    }

    function flushPending() {
        if (!hasPendingMove) return false;

        const changedLayers = [...movedLayers];
        const changedSelections = [...movedSelections];
        hasPendingMove = false;
        movedLayers.clear();
        movedSelections.clear();

        const currentLayers = changedLayers.filter(findCurrentLayer);
        if (!currentLayers.length) return false;

        if (typeof root.CanvasDakiFocus?.selectionChanged === 'function') {
            changedSelections.filter(findCurrentLayer).forEach((selection) => {
                root.CanvasDakiFocus.selectionChanged(selection);
            });
        }
        if (typeof saveCanvasState === 'function') saveCanvasState();
        return true;
    }

    function flush() {
        const saved = flushPending();
        pressedArrowKeys.clear();
        return saved;
    }

    function onKeyDownCapture(event) {
        if (!ARROW_KEYS.has(event?.key)) flushPending();
    }

    function onKeyDown(event) {
        if (!event || event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
        if (!ARROW_KEYS.has(event.key) || eventTargetIsIgnored(event.target)) return;
        if (!currentMoveMode() || movementIsBlocked()) return;

        const width = Number(typeof currentCanvasWidth !== 'undefined' ? currentCanvasWidth : 0);
        const height = Number(typeof currentCanvasHeight !== 'undefined' ? currentCanvasHeight : 0);
        if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return;

        const delta = movementDelta(event.key, event.shiftKey, settings, width, height);
        if (!delta || !moveCurrentSelection(delta.dx, delta.dy)) return;

        event.preventDefault();
        pressedArrowKeys.add(event.key);
        hasPendingMove = true;
        if (typeof renderCanvasLayersOnSurface === 'function') renderCanvasLayersOnSurface();
        if (typeof renderLayerList === 'function') renderLayerList();
    }

    function onKeyUp(event) {
        if (!ARROW_KEYS.has(event?.key)) return;
        pressedArrowKeys.delete(event.key);
        if (pressedArrowKeys.size === 0) flushPending();
    }

    function onPointerDown() {
        flushPending();
    }

    function onWindowBlur() {
        flush();
    }

    function onVisibilityChange() {
        if (root.document?.hidden) flush();
    }

    function bindGlobalListeners() {
        const doc = root.document;
        if (globalListenersBound || !doc?.addEventListener) return;

        doc.addEventListener('keydown', onKeyDownCapture, true);
        doc.addEventListener('keydown', onKeyDown);
        doc.addEventListener('keyup', onKeyUp);
        doc.addEventListener('pointerdown', onPointerDown, true);
        doc.addEventListener('visibilitychange', onVisibilityChange);
        root.addEventListener?.('blur', onWindowBlur);
        globalListenersBound = true;
    }

    const api = {
        DEFAULT_SETTINGS,
        normalizeSettings,
        movementDelta,
        syncControls,
        getSettings() { return {...settings}; },
        flush
    };

    root.CanvasKeyboardMove = api;
    if (typeof module === 'object' && module.exports) module.exports = api;

    if (root.document) {
        bindGlobalListeners();
        if (root.document.readyState === 'loading') {
            root.document.addEventListener('DOMContentLoaded', syncControls, {once: true});
        }
        syncControls();
    }
})(typeof window !== 'undefined' ? window : globalThis);
