// General canvas edits share the existing save boundary; editor-local histories stay separate.
let canvasEditHistory = null;
let restoringCanvasEditHistory = false;

// Compare editing content while retaining the complete snapshot for recovery.
const canvasEditContextKeys = [
    'savedAt', 'canvasZoom', 'clipPreviewZoom', 'activeLayerId', 'checkedSelectionId', 'layerIdSeq',
    'styleLink', 'projectSettingsLink', 'dakiBodyMap', 'retouchDraft', 'oppositeReference',
    'inpaintReference', 'sharedSelectionClipPromptInfo', 'inpaintSettings',
    'sharedSelectionClipPromptControlGroups', 'isSelectionOverlayHidden', 'isClipInpaintMergedSourceMode'
];
const canvasLayerEditContextKeys = [
    'name', 'expanded', 'promptInfo', 'promptControlGroups', 'promptOwnerId',
    'instancePrompt', 'instanceNegativePrompt', 'dakiFocus',
    'pinnedWidth', 'pinnedHeight', 'pinnedOffsetX', 'pinnedOffsetY',
    'pinnedPanelOffsetX', 'pinnedPanelOffsetY', 'pinnedUiX', 'pinnedUiY', 'pinnedUiLocked'
];

function getCanvasEditHistory() {
    if (!canvasEditHistory) canvasEditHistory = CanvasHistory.createCanvasHistory();
    return canvasEditHistory;
}

function captureCanvasEditState() {
    const state = buildCanvasStateSnapshot({preserveMasks: true});
    // Navigation and the independent retouch/reference editors are not canvas edits.
    for (const key of ['savedAt', 'canvasZoom', 'clipPreviewZoom', 'retouchDraft', 'oppositeReference']) delete state[key];
    return state;
}

function canvasEditStateKey(state) {
    const content = {...state};
    for (const key of canvasEditContextKeys) delete content[key];
    const contentLayers = layers => layers.map(layer => {
        const copy = {...layer};
        for (const key of canvasLayerEditContextKeys) delete copy[key];
        if (Array.isArray(layer.children)) copy.children = contentLayers(layer.children);
        return copy;
    });
    content.layers = contentLayers(state.layers || []);
    return JSON.stringify(content);
}

function preserveCanvasEditContext(state, current) {
    const previousActive = state.activeLayerId;
    const previousChecked = state.checkedSelectionId;
    const previousSequence = state.layerIdSeq;
    const copyContext = (target, source, keys) => {
        for (const key of keys) {
            if (Object.hasOwn(source, key)) target[key] = source[key];
            else delete target[key];
        }
    };
    copyContext(state, current, canvasEditContextKeys);
    // Never reuse an ID allocated after the edit being undone.
    state.layerIdSeq = Math.max(Number(previousSequence) || 0, Number(current.layerIdSeq) || 0);
    const currentLayers = new Map();
    const restoredIds = new Set();
    const visit = (layers, callback) => {
        for (const layer of layers || []) {
            callback(layer);
            if (Array.isArray(layer.children)) visit(layer.children, callback);
        }
    };
    visit(current.layers, layer => currentLayers.set(String(layer.id), layer));
    visit(state.layers, layer => {
        restoredIds.add(String(layer.id));
        const source = currentLayers.get(String(layer.id));
        if (source) copyContext(layer, source, canvasLayerEditContextKeys);
    });
    if (state.activeLayerId != null && !restoredIds.has(String(state.activeLayerId))) {
        state.activeLayerId = previousActive;
    }
    if (state.checkedSelectionId != null && !restoredIds.has(String(state.checkedSelectionId))) {
        state.checkedSelectionId = previousChecked;
    }
    return state;
}

function resetCanvasEditHistory() {
    if (restoringCanvasEditHistory) return;
    if (!currentCanvasWidth || !currentCanvasHeight) {
        canvasEditHistory?.clear();
        return;
    }
    const state = captureCanvasEditState();
    getCanvasEditHistory().reset(state, canvasEditStateKey(state));
}

function recordCanvasEditHistory() {
    if (!currentCanvasWidth || !currentCanvasHeight) return false;
    if (restoringCanvasEditHistory) return true;
    const state = captureCanvasEditState();
    return getCanvasEditHistory().record(state, canvasEditStateKey(state));
}

function collectCanvasEditHistoryImportRefs() {
    const refs = new Set();
    for (const state of canvasEditHistory?.states() || []) collectCanvasImportRefsFromValue(state, refs);
    return [...refs];
}

function undoCanvasEdit() {
    if (hasActiveCanvasGeometryDrag() || activePinnedReferenceMoveDrag || activePinnedReferenceResizeDrag ||
        isClipMaskPainting || clipInpaintLoadingClipId || externalCanvasImageImportBusy ||
        (typeof pendingCanvasClipMaskWrites !== 'undefined' && pendingCanvasClipMaskWrites > 0) ||
        (typeof canvasLayerEraserSession !== 'undefined' && canvasLayerEraserSession?.stroke)) return;
    const state = canvasEditHistory?.undo();
    if (!state) return;
    preserveCanvasEditContext(state, captureCanvasEditState());
    restoringCanvasEditHistory = true;
    try {
        disposeClipMaskEditor();
        closeCanvasImageLayerContextMenu();
        closeCanvasSelectionContextMenu();
        closeClipOutputClipboardContextMenu();
        selectedLayerIds.clear();
        if (state.activeLayerId) selectedLayerIds.add(Number(state.activeLayerId));
        activeClipSelectionId = state.checkedSelectionId || null;
        activeClipPromptId = null;
        activeClipAutoMaskPickClipId = null;
        isClipInpaintPreviewMode = false;
        applyCanvasStateSnapshot({...state, canvasZoom, clipPreviewZoom}, {fromHistory: true});
        // Restore may normalize layers; the next view-only save must use that baseline.
        const restored = captureCanvasEditState();
        getCanvasEditHistory().replaceCurrent(restored, canvasEditStateKey(restored));
        saveCanvasState();
        showToast('실행 취소했습니다.');
    } finally {
        restoringCanvasEditHistory = false;
    }
}

document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey ||
        !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;
    if (event.target.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], .modal-overlay, .modal')) return;
    // The eraser has a capture-phase handler and retouch owns its editor surface.
    if (typeof canvasLayerEraserEnabled !== 'undefined' && canvasLayerEraserEnabled) return;
    event.preventDefault();
    undoCanvasEdit();
});
