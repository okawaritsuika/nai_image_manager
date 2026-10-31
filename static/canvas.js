let pinnedReferenceLayerId = null;
let activePinnedReferenceResizeDrag = null;
let activePinnedReferenceMoveDrag = null;

let activePinnedReferencePanelDrag = null;
let activePinnedReferenceUiDrag = null;
let clipOutputPanelPosition = null;
let activeClipOutputPanelDrag = null;
let activeCanvasPanDrag = null;
let canvasPanOffsetX = 0;
let canvasPanOffsetY = 0;

let isImageResizeMode = false;
let activeImageResizeDrag = null;
let isCanvasResizeMode = false;
let activeCanvasResizeDrag = null;
const IMAGE_RESIZE_MIN_SIZE = 16;
const IMAGE_RESIZE_FINE_FACTOR = 0.2;
const CANVAS_RESIZE_STEP = 64;
const CANVAS_RESIZE_MIN_SIZE = 64;

let imageResizeLastEditedAxis = 'width';
let isSyncingImageResizeInputs = false;

let clipInpaintLoadingClipId = null;
let clipInpaintLoadingMessage = '인페인팅 처리 중...';
let activeTagTranslationOriginalTarget = '';
let activeTagTranslationParts = [];
let activeTagTranslationJoiner = ' ';
let activeTagTranslationTarget = null;
const CANVAS_RATIO_W = 5;
const CANVAS_RATIO_H = 16;

let currentCanvasWidth = 0;
let currentCanvasHeight = 0;
let lastEditedCanvasAxis = 'width';

let canvasLayers = [];
let activeLayerId = null;
let selectedLayerIds = new Set();
let layerIdSeq = 1;
let contextImageLayerId = null;
let isLayerMoveMode = false;
let activeLayerDrag = null;
let draggedLayerId = null;
let canvasLayerDeletePointerId = null;
let canvasLayerDeletePressedId = null;
let pendingCanvasHotLayerIds = new Set();
let canvasHotGeometryFrame = null;

let activeSelectionDrag = null;

let contextSelectionId = null;
let activeClipSelectionId = null;

const SELECTION_SIZE_STEP = 64;
const SELECTION_MIN_SIZE = 64;
const NAI_FREE_AREA_LIMIT = 1048576;

let activeClipMaskTool = 'brush';
let clipMaskBrushSize = 96;
let isClipMaskPainting = false;
const clipMaskPersistRevisions = new WeakMap();
let pendingCanvasClipMaskWrites = 0;
let clipOutputInternalClipboard = null;

const CLIP_MASK_BRUSH_MIN = 8;
const CLIP_MASK_BRUSH_MAX = 256;
const CLIP_MASK_BRUSH_STEP = 4;

let activeClipPromptId = null;

let clipPromptViewMode = 'buttons';
let clipPromptGroups = [];
let selectedClipPromptGroup = null;
let temporaryClipPromptGroups = [];
let temporaryClipPromptGroupSeq = 1;
let activeClipAreaSelection = null;
let suppressNextClipPromptSelectionClear = false;
let clipTagDictionary = {};
let clipPromptGroupSearchText = '';
let clipPromptGroupActiveTag = 'ALL';
let clipPromptGroupVisibleLimit = 80;
const CLIP_PROMPT_GROUP_PAGE_SIZE = 80;

let sharedSelectionClipPromptInfo = null;
let sharedSelectionClipPromptControlGroups = [];

const staticClipPromptFields = [
    { key: 'base', inputId: 'clipBasePromptInput', tokensId: 'clipBasePromptTokens' },
    { key: 'negative', inputId: 'clipNegativePromptInput', tokensId: 'clipNegativePromptTokens' }
];

let clipCharPromptEditorSeq = 1;

function getAllClipLayers() {
    return getAllCanvasLayerNodes().filter((layer) => layer && layer.type === 'clip');
}

function hasSharedSelectionClipPrompt() {
    return hasAnyPromptText(sharedSelectionClipPromptInfo);
}

async function recoverSharedSelectionClipPromptFromAvailableSources(selection = null, preferredClip = null) {
    // 이미 공용 프롬프트가 있으면 그대로 사용
    if (hasSharedSelectionClipPrompt()) {
        return getSharedSelectionClipPromptInfo();
    }

    // 1순위: preferredClip 자체에 남아 있는 프롬프트
    if (preferredClip?.promptInfo && hasAnyPromptText(preferredClip.promptInfo)) {
        rememberSharedSelectionClipPrompt(
            preferredClip.promptInfo,
            preferredClip.promptControlGroups
        );
        return getSharedSelectionClipPromptInfo();
    }

    // 2순위: 기존 클립 중 프롬프트가 남아 있는 클립
    const clips = typeof getAllClipLayers === 'function'
        ? getAllClipLayers()
        : getAllCanvasLayerNodes().filter((layer) => layer?.type === 'clip');

    const promptfulClip = clips.find((clip) => hasAnyPromptText(clip.promptInfo));

    if (promptfulClip) {
        rememberSharedSelectionClipPrompt(
            promptfulClip.promptInfo,
            promptfulClip.promptControlGroups
        );
        return getSharedSelectionClipPromptInfo();
    }

    // 3순위: 선택 영역과 겹치는 이미지 레이어
    if (selection && selection.type === 'selection') {
        const selectionSourceLayers = collectPromptSourceLayersFromSelection(selection);

        for (const layer of selectionSourceLayers) {
            const recovered = await recoverPromptFromImageLayer(layer);

            if (hasAnyPromptText(recovered)) {
                rememberSharedSelectionClipPrompt(
                    recovered,
                    layer.promptControlGroups
                );
                return getSharedSelectionClipPromptInfo();
            }
        }
    }

    // 4순위: 캔버스 전체 이미지 레이어
    const imageLayers = getAllCanvasLayerNodes()
        .filter((layer) => layer?.type === 'image' && layer.src)
        .sort((a, b) => {
            // 보이는 레이어 우선, 위쪽 레이어 우선
            const visibleA = a.visible === false ? 1 : 0;
            const visibleB = b.visible === false ? 1 : 0;
            return visibleA - visibleB;
        });

    for (const layer of imageLayers) {
        const recovered = await recoverPromptFromImageLayer(layer);

        if (hasAnyPromptText(recovered)) {
            rememberSharedSelectionClipPrompt(
                recovered,
                layer.promptControlGroups
            );
            return getSharedSelectionClipPromptInfo();
        }
    }

    return normalizePromptInfo(null);
}

async function recoverPromptFromImageLayer(layer) {
    if (!layer || layer.type !== 'image') {
        return normalizePromptInfo(null);
    }

    if (layer.promptInfo && hasAnyPromptText(layer.promptInfo)) {
        return normalizePromptInfo(layer.promptInfo);
    }

    if (layer.sourcePath) {
        const fromImage = await fetchPromptInfoByPath(layer.sourcePath);

        if (hasAnyPromptText(fromImage) || canvasInpaintHasGenerationSettings(fromImage)) {
            if (hasAnyPromptText(fromImage)) layer.promptInfo = normalizePromptInfo(fromImage);

            if (hasAnyPromptText(fromImage) && !Array.isArray(layer.promptControlGroups)) {
                layer.promptControlGroups = [];
            }

            return hasAnyPromptText(fromImage) ? layer.promptInfo : fromImage;
        }
    }

    if (canvasInpaintHasGenerationSettings(layer.promptInfo)) {
        return layer.promptInfo;
    }

    return normalizePromptInfo(null);
}

function getSharedSelectionClipPromptInfo() {
    return sharedSelectionClipPromptInfo
        ? normalizePromptInfo(sharedSelectionClipPromptInfo)
        : normalizePromptInfo(null);
}

function rememberSharedSelectionClipPrompt(promptInfo, promptControlGroups = []) {
    const info = normalizePromptInfo(promptInfo || {});

    // 빈 프롬프트로 기존 공용 프롬프트를 덮어쓰지 않는다.
    if (hasAnyPromptText(info)) {
        sharedSelectionClipPromptInfo = structuredClone(info);
    }

    if (Array.isArray(promptControlGroups) && promptControlGroups.length) {
        sharedSelectionClipPromptControlGroups = structuredClone(promptControlGroups);
    }

    if (!Array.isArray(sharedSelectionClipPromptControlGroups)) {
        sharedSelectionClipPromptControlGroups = [];
    }
}

function applySharedSelectionPromptToClip(clip) {
    if (!clip || clip.type !== 'clip') return;
    if (!hasSharedSelectionClipPrompt()) return;

    clip.promptInfo = normalizePromptInfo(sharedSelectionClipPromptInfo);

    clip.promptControlGroups = Array.isArray(sharedSelectionClipPromptControlGroups)
        ? structuredClone(sharedSelectionClipPromptControlGroups)
        : [];
}

function migrateAllSelectionClipsToSharedPromptOwner(preferredOwnerId = null) {
    const clips = getAllClipLayers();

    if (!clips.length) {
        // 클립이 없어도 sharedSelectionClipPromptInfo는 지우지 않는다.
        // 선택 영역을 삭제했다가 새로 만들어도 프롬프트가 살아 있어야 하기 때문.
        return null;
    }

    // 아직 전역 공용 프롬프트가 없으면, 기존 클립 중 프롬프트 있는 것을 먼저 회수한다.
    if (!hasSharedSelectionClipPrompt()) {
        const promptfulClip = clips.find((clip) => hasAnyPromptText(clip.promptInfo));

        if (promptfulClip) {
            rememberSharedSelectionClipPrompt(
                promptfulClip.promptInfo,
                promptfulClip.promptControlGroups
            );
        }
    }

    let owner = null;

    if (preferredOwnerId != null) {
        const preferred = findCanvasLayer(preferredOwnerId)?.layer;

        if (preferred && preferred.type === 'clip') {
            owner = preferred;
        }
    }

    if (!owner) {
        owner = clips.find((clip) => hasAnyPromptText(clip.promptInfo)) || clips[0];
    }

    if (!owner) return null;

    // 기존 owner가 이미지/클립이면 거기서도 프롬프트를 회수한다.
    const legacyOwner = owner.promptOwnerId
        ? findCanvasLayer(owner.promptOwnerId)?.layer
        : null;

    if (!hasSharedSelectionClipPrompt() && legacyOwner?.promptInfo && hasAnyPromptText(legacyOwner.promptInfo)) {
        rememberSharedSelectionClipPrompt(
            legacyOwner.promptInfo,
            legacyOwner.promptControlGroups
        );
    }

    // 공용 프롬프트가 있으면 owner에도 다시 심는다.
    if (hasSharedSelectionClipPrompt()) {
        owner.promptInfo = normalizePromptInfo(sharedSelectionClipPromptInfo);
        owner.promptControlGroups = Array.isArray(sharedSelectionClipPromptControlGroups)
            ? structuredClone(sharedSelectionClipPromptControlGroups)
            : [];
    } else {
        owner.promptInfo = normalizePromptInfo(owner.promptInfo || {});

        if (!Array.isArray(owner.promptControlGroups)) {
            owner.promptControlGroups = [];
        }

        // owner가 프롬프트를 가지고 있으면 전역 공용 저장소에 저장
        rememberSharedSelectionClipPrompt(owner.promptInfo, owner.promptControlGroups);
    }

    owner.promptOwnerId = owner.id;

    // 모든 선택 영역 클립은 같은 owner와 같은 프롬프트 복사본을 가진다.
    clips.forEach((clip) => {
        clip.promptOwnerId = owner.id;
        clip.promptInfo = normalizePromptInfo(owner.promptInfo || {});
        clip.promptControlGroups = Array.isArray(owner.promptControlGroups)
            ? structuredClone(owner.promptControlGroups)
            : [];
    });

    return owner;
}

function getClipPromptFields() {
    const charFields = [...document.querySelectorAll('#clipCharPromptList .clip-char-prompt-item')]
        .map((node) => {
            const id = node.dataset.charPromptId;
            return {
                key: `char-${id}`,
                inputId: `clipCharPromptInput-${id}`,
                tokensId: `clipCharPromptTokens-${id}`,
                isChar: true
            };
        });

    return [...staticClipPromptFields, ...charFields];
}

// EDGE_STICK_THRESHOLD = 가장자리에 살짝 닿았을 때 붙는 거리
// EDGE_BREAK_THRESHOLD = 이 거리 이상 계속 밀면 캔버스 밖으로 나가는 거리
const EDGE_STICK_SCREEN_THRESHOLD = 10;   // 가장자리에 붙는 거리: 화면 기준 px
const EDGE_BREAK_SCREEN_THRESHOLD = 36;   // 이만큼 더 밀어야 밖으로 탈출

const el = (id) => document.getElementById(id);

function showToast(message) {
    const toast = document.createElement('div');
    toast.style.cssText = `
        position: fixed;
        bottom: 30px;
        left: 50%;
        transform: translateX(-50%);
        background: #22c55e;
        color: white;
        padding: 12px 25px;
        border-radius: 30px;
        z-index: 99999;
        font-weight: bold;
        font-size: 13px;
        box-shadow: 0 4px 15px rgba(0,0,0,0.3);
        opacity: 1;
        transition: opacity 0.35s ease, transform 0.35s ease;
        pointer-events: none;
    `;
    toast.innerText = message;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(-50%) translateY(8px)';
    }, 1600);

    setTimeout(() => toast.remove(), 2100);
}

const CANVAS_STATE_KEY = window.CanvasWorkspaceBridge?.stateKey || 'naia_canvas_state_v1';
const CANVAS_PENDING_IMPORT_KEY = 'naia_canvas_pending_import';
const CANVAS_DISPLAY_PREVIEW_MAX_SIDE = 4096;
const CANVAS_IMPORT_SESSION_ID = `canvas_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const CANVAS_IMPORT_CLEANUP_DELAY = 2500;

let isClipInpaintPreviewMode = false;
let isClipInpaintMergedSourceMode = false;
let clipMergedSourcePreviewCache = {
    key: '',
    dataUrl: ''
};
let clipMergedSourcePreviewSeq = 0;

let openClipMaskSizeTool = null; // 'brush' | 'eraser' | null

let isSelectionOverlayHidden = false;

let checkedSelectionId = null;

let clipPromptControlGroupSeq = 1;

let canvasZoom = 1;
let clipPreviewZoom = 1;
let activeClipAutoMaskPickClipId = null;
let activeCanvasSetupId = null;
let lastCanvasSurfaceHoverEvent = null;
let canvasImportCleanupTimer = null;

const CANVAS_ZOOM_MIN = 0.15;
const CANVAS_ZOOM_MAX = 8;
const CLIP_PREVIEW_ZOOM_MIN = 0.25;
const CLIP_PREVIEW_ZOOM_MAX = 8;
const WHEEL_ZOOM_STEP = 1.12;

const CANVAS_SAVED_SETUPS_KEY = 'naia_canvas_saved_setups_v1';
let cachedSavedCanvasSetups = null;
let savedCanvasSetupsLoadPromise = null;
let savedCanvasSetupsSavePromise = Promise.resolve();
let canvasLegacySetupMigrationMessage = '';
let pendingCanvasImportPayload = null;
let externalCanvasImageImportBusy = false;
let canvasImportManagerItems = [];
let selectedCanvasImportManagerRef = '';
let canvasImportManagerFilter = 'all';

window.addEventListener('load', async () => {
    if (window.CanvasWorkspaceBridge?.isHost) return;
    if (typeof CanvasInpaintReference !== 'undefined') CanvasInpaintReference.configure({
        getContext: () => ({...getClipOutputTarget(), canvasWidth: currentCanvasWidth,
            canvasHeight: currentCanvasHeight, selectionHidden: isSelectionOverlayHidden}),
        save: () => saveCanvasState(),
        redraw: () => renderCanvasLayersOnSurface(),
        getProjectLink: () => window.CanvasProject?.localLink(),
        sessionId: CANVAS_IMPORT_SESSION_ID
    });
    await fetchClipTagDictionary();
    await loadSavedCanvasSetupsFromServer();

    updateCanvasRatioInfo();
    restoreCanvasState();
    if (window.CanvasProject) await CanvasProject.initialize();
    await loadSharedClipPromptGroups(true);
    updateSelectionOverlayToggleUI();
    if (!window.CanvasWorkspaceBridge?.isPane) await consumePendingCanvasImport();

    document.addEventListener('mousemove', handleLayerMoveMouseMove);
    document.addEventListener('mouseup', handleLayerMoveMouseUp);

    document.addEventListener('mousemove', handleSelectionMouseMove);
    document.addEventListener('mouseup', handleSelectionMouseUp);

    document.addEventListener('mousemove', handleImageResizeMouseMove);
    document.addEventListener('mouseup', handleImageResizeMouseUp);

    document.addEventListener('mousemove', handleCanvasResizeMouseMove);
    document.addEventListener('mouseup', handleCanvasResizeMouseUp);

    document.addEventListener('mousemove', handlePinnedReferenceResizeMouseMove);
    document.addEventListener('mouseup', handlePinnedReferenceResizeMouseUp);

    document.addEventListener('mousemove', handlePinnedReferenceMoveMouseMove);
    document.addEventListener('mouseup', handlePinnedReferenceMoveMouseUp);

    document.addEventListener('mousemove', handlePinnedReferencePanelMouseMove);
    document.addEventListener('mouseup', handlePinnedReferencePanelMouseUp);

    document.addEventListener('mousemove', handlePinnedReferenceUiMouseMove);
    document.addEventListener('mouseup', handlePinnedReferenceUiMouseUp);
    document.addEventListener('mousemove', handleClipOutputPanelDragMove);
    document.addEventListener('mouseup', stopClipOutputPanelDrag);

    document.addEventListener('click', (event) => {
        const imageMenu = el('canvasImageLayerContextMenu');
        const selectionMenu = el('canvasSelectionContextMenu');
        const clipOutputMenu = getClipOutputClipboardContextMenu(false);

        if (imageMenu && imageMenu.style.display === 'block' && !imageMenu.contains(event.target)) {
            closeCanvasImageLayerContextMenu();
        }

        if (selectionMenu && selectionMenu.style.display === 'block' && !selectionMenu.contains(event.target)) {
            closeCanvasSelectionContextMenu();
        }

        if (clipOutputMenu && clipOutputMenu.style.display === 'block' && !clipOutputMenu.contains(event.target)) {
            closeClipOutputClipboardContextMenu();
        }

        if (!event.target.closest('.clip-mask-tool-control')) {
            closeClipMaskSizePopover();
        }

        if (
            !event.target.closest('#temporaryClipPromptGroupMenu') &&
            !event.target.closest('.prompt-token-btn.temporary-group')
        ) {
            closeTemporaryClipPromptGroupMenu();
        }

        if (suppressNextClipPromptSelectionClear) {
            suppressNextClipPromptSelectionClear = false;
        } else if (
            !event.target.closest('#clipGroupSelectionPopover') &&
            !event.target.closest('#temporaryClipPromptGroupMenu')
        ) {
            hideClipGroupSelectionPopover();
        }
    });

    document.addEventListener('keydown', (event) => {
        if (handleClipOutputClipboardShortcut(event)) {
            return;
        }

        if (event.key === 'Escape') {
            closeCanvasImageLayerContextMenu();
            closeCanvasSelectionContextMenu();
            closeClipOutputClipboardContextMenu();
        }
    });

    document.addEventListener('scroll', () => {
        closeCanvasImageLayerContextMenu();
        closeCanvasSelectionContextMenu();
        closeClipOutputClipboardContextMenu();
        refreshActiveCanvasDragCoordinateCache();
    }, true);

    bindExternalCanvasImageDropAndPaste();
    window.CanvasWorkspaceBridge?.ready();

});

window.addEventListener('pagehide', saveCanvasStateBeforeLeaving);

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        saveCanvasStateBeforeLeaving();
    }
});

window.addEventListener('resize', () => {
    if (currentCanvasWidth && currentCanvasHeight) {
        renderCanvas(currentCanvasWidth, currentCanvasHeight);
    }
});

function saveCanvasStateBeforeLeaving() {
    if (!currentCanvasWidth || !currentCanvasHeight) return;
    // Leaving is a flush, not a new edit: do not start a fresh project request
    // after beforeunload has already checked whether all changes were saved.
    window.CanvasProject?.flush();
    getCanvasAutosave().schedule(true);
}

async function clearCurrentCanvasCompletely() {
    const hasCanvas = Boolean(currentCanvasWidth && currentCanvasHeight) ||
        (Array.isArray(canvasLayers) && canvasLayers.length > 0);

    if (!hasCanvas) {
        alert('초기화할 캔버스가 없습니다.');
        return;
    }

    const ok = confirm(
        '현재 캔버스를 완전히 초기화할까요?\n\n' +
        '캔버스 크기, 레이어, 선택 영역, 클립 이미지, 인페인팅 결과가 모두 사라집니다.'
    );

    if (!ok) return;

    if (window.CanvasProject && !await CanvasProject.leave()) return;
    disposeClipMaskEditor();
    if (typeof setCanvasLayerEraserEnabled === 'function') setCanvasLayerEraserEnabled(false);
    canvasAutosave?.reset();

    const detachedRefs = collectCanvasImportRefsFromLayer({
        type: 'folder',
        children: canvasLayers
    });

    currentCanvasWidth = 0;
    currentCanvasHeight = 0;
    lastEditedCanvasAxis = 'width';

    if (typeof CanvasDakiFocus !== 'undefined') CanvasDakiFocus.restore(null);
    if (typeof CanvasRetouch !== 'undefined') CanvasRetouch.restore(null);
    if (typeof CanvasOppositeReference !== 'undefined') CanvasOppositeReference.restore(null);
    if (typeof CanvasInpaintReference !== 'undefined') CanvasInpaintReference.restore(null);
    canvasLayers = [];
    activeLayerId = null;
    selectedLayerIds.clear();
    layerIdSeq = 1;

    contextImageLayerId = null;
    contextSelectionId = null;
    activeClipSelectionId = null;
    checkedSelectionId = null;
    activeClipPromptId = null;

    isLayerMoveMode = false;
    isImageResizeMode = false;
    activeLayerDrag = null;
    activeSelectionDrag = null;
    activeImageResizeDrag = null;

    clipInpaintLoadingClipId = null;
    isClipInpaintPreviewMode = false;
    isClipInpaintMergedSourceMode = false;

    sharedSelectionClipPromptInfo = null;
    sharedSelectionClipPromptControlGroups = [];
    if (typeof CanvasInpaintSettings !== 'undefined') CanvasInpaintSettings.restore(null);
    if (typeof CanvasProjectSettings !== 'undefined') CanvasProjectSettings.restore(null);
    if (typeof getCanvasStyleLink === 'function') getCanvasStyleLink()?.restore(null);

    pinnedReferenceLayerId = null;

    canvasZoom = 1;
    clipPreviewZoom = 1;
    canvasPanOffsetX = 0;
    canvasPanOffsetY = 0;
    activeCanvasSetupId = null;

    try {
        localStorage.removeItem(window.CanvasWorkspaceBridge?.stateKey || CANVAS_STATE_KEY);
    } catch (error) {
        console.warn('Canvas state clear failed:', error);
    }

    const emptyState = el('canvasEmptyState');
    const stage = el('canvasStage');
    const surface = el('canvasSurface');

    if (emptyState) emptyState.style.display = '';
    if (stage) stage.style.display = 'none';
    if (surface) {
        surface.innerHTML = '';
        surface.style.width = '';
        surface.style.height = '';
        delete surface.dataset.width;
        delete surface.dataset.height;
        delete surface.dataset.scale;
        delete surface.dataset.fitScale;
    }

    updateCanvasReadout(0, 0, 1);
    renderLayerList();
    renderClipOutputPanel();
    renderPinnedReferencePanel();

    if (typeof resetCanvasEditHistory === 'function') resetCanvasEditHistory();
    cleanupDetachedCanvasImportRefs(detachedRefs);
}

function openCanvasDialog() {
    const modal = el('canvasCreateModal');
    if (modal) {
        modal.style.display = 'flex';
        updateCanvasRatioInfo();
    }
}

function closeCanvasDialog() {
    const modal = el('canvasCreateModal');
    if (modal) modal.style.display = 'none';
}

function applyCanvasPreset(width, height) {
    el('canvasWidthInput').value = width;
    el('canvasHeightInput').value = height;
    lastEditedCanvasAxis = 'width';
    updateCanvasRatioInfo();
}

function handleCanvasWidthInput() {
    lastEditedCanvasAxis = 'width';

    if (el('canvasRatioLock')?.checked) {
        const width = readCanvasInputValue('canvasWidthInput', 960);
        el('canvasHeightInput').value = Math.round(width * CANVAS_RATIO_H / CANVAS_RATIO_W);
    }

    updateCanvasRatioInfo();
}

function handleCanvasHeightInput() {
    lastEditedCanvasAxis = 'height';

    if (el('canvasRatioLock')?.checked) {
        const height = readCanvasInputValue('canvasHeightInput', 3072);
        el('canvasWidthInput').value = Math.round(height * CANVAS_RATIO_W / CANVAS_RATIO_H);
    }

    updateCanvasRatioInfo();
}

document.addEventListener('change', (event) => {
    if (event.target && event.target.id === 'canvasRatioLock') {
        if (event.target.checked) {
            if (lastEditedCanvasAxis === 'height') {
                handleCanvasHeightInput();
            } else {
                handleCanvasWidthInput();
            }
        } else {
            updateCanvasRatioInfo();
        }
    }

    if (event.target && event.target.id === 'imageResizeRatioLock') {
        if (event.target.checked) {
            if (imageResizeLastEditedAxis === 'height') {
                handleImageResizeHeightInput();
            } else {
                handleImageResizeWidthInput();
            }
        }
    }
});

function readCanvasInputValue(id, fallback) {
    const value = parseInt(el(id)?.value, 10);
    if (!Number.isFinite(value) || value < 64) return fallback;
    return value;
}

function updateCanvasRatioInfo() {
    const width = readCanvasInputValue('canvasWidthInput', 960);
    const height = readCanvasInputValue('canvasHeightInput', 3072);
    const ratio = width / height;
    const targetRatio = CANVAS_RATIO_W / CANVAS_RATIO_H;
    const diff = Math.abs(ratio - targetRatio);

    const info = el('canvasRatioInfo');
    if (!info) return;

    const ratioText = `${width} : ${height}`;
    const percent = ((width * height) / 1000000).toFixed(2);

    if (diff < 0.001) {
        info.innerText = `현재 해상도 ${ratioText} · 약 ${percent}MP · 5:16 비율에 맞습니다.`;
    } else {
        info.innerText = `현재 해상도 ${ratioText} · 약 ${percent}MP · 5:16과 다릅니다.`;
    }
}

async function createCanvasFromDialog() {
    const width = readCanvasInputValue('canvasWidthInput', 960);
    const height = readCanvasInputValue('canvasHeightInput', 3072);

    if (window.CanvasProject && !await CanvasProject.leave()) return;
    activeCanvasSetupId = null;

    currentCanvasWidth = width;
    currentCanvasHeight = height;
    canvasZoom = 1;
    canvasPanOffsetX = 0;
    canvasPanOffsetY = 0;

    addCanvasBaseLayer(width, height);

    renderCanvas(width, height);
    renderLayerList();
    saveCanvasState();
    closeCanvasDialog();
}

function renderCanvas(width, height) {
    const emptyState = el('canvasEmptyState');
    const stage = el('canvasStage');
    const surface = el('canvasSurface');

    if (!stage || !surface) return;

    if (emptyState) emptyState.style.display = 'none';
    stage.style.display = 'flex';

    const fitScale = getCanvasFitScale(width, height);
    const scale = activeCanvasResizeDrag
        ? Math.max(activeCanvasResizeDrag.displayScale || fitScale, 0.01)
        : fitScale * canvasZoom;

    const displayWidth = Math.max(1, Math.round(width * scale));
    const displayHeight = Math.max(1, Math.round(height * scale));

    stage.style.width = `${displayWidth}px`;
    stage.style.height = `${displayHeight}px`;

    surface.style.position = '';
    surface.style.left = '';
    surface.style.top = '';
    surface.style.width = `${displayWidth}px`;
    surface.style.height = `${displayHeight}px`;
    surface.style.transform = '';
    surface.dataset.width = String(width);
    surface.dataset.height = String(height);
    surface.dataset.scale = String(scale);
    surface.dataset.fitScale = String(fitScale);

    updateCanvasReadout(width, height, scale);
    applyCanvasWorkspacePanOffset();
    bindCanvasWheelZoom();
    bindCanvasWorkspacePanDrag();
    bindCanvasSelectionHoverCursor();
    renderCanvasLayersOnSurface();
}

function updateCanvasReadout(width, height, scale) {
    const sizeText = el('canvasSizeText');
    const scaleText = el('canvasScaleText');

    if (!width || !height) {
        if (sizeText) sizeText.innerText = '캔버스 없음';
        if (scaleText) scaleText.innerText = '-';
        return;
    }

    if (sizeText) sizeText.innerText = `${width} × ${height}px`;
    if (scaleText) scaleText.innerText = `화면 표시 배율 ${(scale * 100).toFixed(1)}%`;
}

function snapCanvasSizeToStep(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return CANVAS_RESIZE_MIN_SIZE;
    return Math.max(CANVAS_RESIZE_MIN_SIZE, Math.round(numeric / CANVAS_RESIZE_STEP) * CANVAS_RESIZE_STEP);
}

function resizeCurrentCanvasTo(width, height) {
    const nextWidth = snapCanvasSizeToStep(width);
    const nextHeight = snapCanvasSizeToStep(height);

    currentCanvasWidth = nextWidth;
    currentCanvasHeight = nextHeight;

    const widthInput = el('canvasWidthInput');
    const heightInput = el('canvasHeightInput');

    if (widthInput) widthInput.value = nextWidth;
    if (heightInput) heightInput.value = nextHeight;

    updateCanvasBaseLayer(nextWidth, nextHeight);
    renderCanvas(nextWidth, nextHeight);
    updateCanvasRatioInfo();

    return { width: nextWidth, height: nextHeight };
}

function initializeCanvasLayers() {
    layerIdSeq = 1;
    if (typeof CanvasInpaintSettings !== 'undefined') CanvasInpaintSettings.restore(null);
    if (typeof CanvasProjectSettings !== 'undefined') CanvasProjectSettings.restore(null);
    if (typeof CanvasDakiFocus !== 'undefined') CanvasDakiFocus.restore(null);
    if (typeof CanvasRetouch !== 'undefined') CanvasRetouch.restore(null);
    if (typeof CanvasOppositeReference !== 'undefined') CanvasOppositeReference.restore(null);
    if (typeof CanvasInpaintReference !== 'undefined') CanvasInpaintReference.restore(null);

    const baseLayer = {
        id: layerIdSeq++,
        name: '레이어 1',
        visible: true,
        type: 'empty'
    };

    canvasLayers = [baseLayer];
    activeLayerId = baseLayer.id;
}

function addCanvasLayer() {
    if (!currentCanvasWidth || !currentCanvasHeight) {
        openCanvasDialog();
        return;
    }

    const layer = {
        id: layerIdSeq++,
        name: `레이어 ${countCanvasLayersByType('empty') + 1}`,
        visible: true,
        type: 'empty',
        src: ''
    };

    const activeInfo = findCanvasLayer(activeLayerId);

    // 폴더가 선택된 상태에서 +레이어를 누르면 그 폴더 안에 생성
    if (activeInfo && activeInfo.layer.type === 'folder') {
        activeInfo.layer.children = activeInfo.layer.children || [];
        activeInfo.layer.children.unshift(layer);
        activeInfo.layer.expanded = true;
    } else {
        canvasLayers.unshift(layer);
    }

    activeLayerId = layer.id;

    renderLayerList();
    renderCanvasLayersOnSurface();
    saveCanvasState();
}

function addCanvasFolder() {
    if (!currentCanvasWidth || !currentCanvasHeight) {
        openCanvasDialog();
        return;
    }

    const folder = {
        id: layerIdSeq++,
        name: `폴더 ${countCanvasLayersByType('folder') + 1}`,
        visible: true,
        type: 'folder',
        expanded: true,
        children: []
    };

    canvasLayers.unshift(folder);
    activeLayerId = folder.id;

    renderLayerList();
    renderCanvasLayersOnSurface();
    saveCanvasState();
}

function getSelectionAreaCreationCenter() {
    const fallback = {x: currentCanvasWidth / 2, y: currentCanvasHeight / 2};
    const surface = el('canvasSurface');
    const workspace = surface?.closest('.canvas-workspace');
    if (!surface || !workspace) return fallback;

    const surfaceRect = surface.getBoundingClientRect();
    const workspaceRect = workspace.getBoundingClientRect();
    if (surfaceRect.width <= 0 || surfaceRect.height <= 0) return fallback;

    const left = Math.max(surfaceRect.left, workspaceRect.left + workspace.clientLeft, 0);
    const top = Math.max(surfaceRect.top, workspaceRect.top + workspace.clientTop, 0);
    const right = Math.min(
        surfaceRect.right,
        workspaceRect.left + workspace.clientLeft + workspace.clientWidth,
        window.innerWidth
    );
    const bottom = Math.min(
        surfaceRect.bottom,
        workspaceRect.top + workspace.clientTop + workspace.clientHeight,
        window.innerHeight
    );
    if (right <= left || bottom <= top) return fallback;

    const center = getCanvasPointerPosition({
        clientX: (left + right) / 2,
        clientY: (top + bottom) / 2
    });
    return {x: center.x, y: center.y};
}

function addSelectionArea() {
    if (!currentCanvasWidth || !currentCanvasHeight) {
        openCanvasDialog();
        return;
    }

    let width = snapToSelectionStep(Math.max(128, Math.round(currentCanvasWidth * 0.5)));
    let height = snapToSelectionStep(Math.max(128, Math.round(currentCanvasHeight * 0.22)));
    while (!isSelectionRequestSizeAllowed({layerWidth: width, layerHeight: height})) {
        width = Math.max(SELECTION_MIN_SIZE, width - SELECTION_SIZE_STEP);
        height = Math.max(SELECTION_MIN_SIZE, height - SELECTION_SIZE_STEP);
    }

    const center = getSelectionAreaCreationCenter();
    const selection = {
        id: layerIdSeq++,
        name: `선택 영역 ${countCanvasLayersByType('selection') + 1}`,
        visible: true,
        type: 'selection',
        expanded: true,
        hasInpaintResult: false,
        x: Math.round(center.x - width / 2),
        y: Math.round(center.y - height / 2),
        layerWidth: width,
        layerHeight: height,
        children: []
    };

    canvasLayers.unshift(selection);
    activeLayerId = selection.id;
    checkedSelectionId = selection.id;
    activeClipSelectionId = selection.id;

    if (typeof CanvasDakiFocus !== 'undefined') CanvasDakiFocus.selectionChanged(selection);
    renderLayerList();
    renderCanvasLayersOnSurface();
    saveCanvasState();
}

function layerTreeHasRenderableInpaintClip(layers = []) {
    if (!Array.isArray(layers)) return false;

    return layers.some((child) => {
        if (!child) return false;

        if (child.type === 'clip' && child.renderOnCanvas === true && child.src) {
            return true;
        }

        if ((child.type === 'folder' || child.type === 'selection') && Array.isArray(child.children)) {
            return layerTreeHasRenderableInpaintClip(child.children);
        }

        return false;
    });
}

function selectionHasInpaintResult(layer) {
    if (!layer || layer.type !== 'selection') return false;

    return layer.hasInpaintResult === true ||
        layerTreeHasRenderableInpaintClip(layer.children);
}

function selectionRequiresLayerMoveMode(layer) {
    return Boolean(layer && layer.type === 'selection' && selectionHasInpaintResult(layer));
}

function canMoveActiveSelection(selection = null) {
    const target = selection || getHoveredSelectionLayer();
    if (!target) return false;
    return !selectionRequiresLayerMoveMode(target) || isLayerMoveMode;
}

function getHoveredSelectionLayer(event = lastCanvasSurfaceHoverEvent) {
    const selectionEl = event?.target?.closest?.('.selection-area-layer');
    if (!selectionEl) return null;

    const found = findCanvasLayer(Number(selectionEl.dataset.layerId));
    const layer = found?.layer;

    return layer && layer.type === 'selection' ? layer : null;
}

function bindCanvasSelectionHoverCursor() {
    const surface = el('canvasSurface');
    if (!surface || surface.dataset.selectionHoverBound === '1') return;

    surface.dataset.selectionHoverBound = '1';

    surface.addEventListener('mousemove', (event) => {
        lastCanvasSurfaceHoverEvent = event;
        updateSelectionHoverCursor(event);
    });

    surface.addEventListener('mouseleave', () => {
        if (!activeSelectionDrag && !activeLayerDrag && !activeImageResizeDrag) {
            surface.style.cursor = '';
        }
    });
}

function updateSelectionHoverCursor(event = lastCanvasSurfaceHoverEvent) {
    const surface = el('canvasSurface');
    if (!surface) return;

    if (
        activeSelectionDrag ||
        activeLayerDrag ||
        activeImageResizeDrag ||
        activePinnedReferenceResizeDrag ||
        activePinnedReferenceMoveDrag ||
        activePinnedReferencePanelDrag ||
        activePinnedReferenceUiDrag
    ) {
        return;
    }

    const selection = getHoveredSelectionLayer(event);

    if (!selection || isSelectionOverlayHidden || !isSelectionChecked(selection.id)) {
        surface.style.cursor = '';
        return;
    }

    if (canMoveActiveSelection(selection)) {
        surface.style.cursor = 'move';
    } else {
        surface.style.cursor = 'not-allowed';
    }
}

function selectCanvasLayer(layerId, event = null) {
    const id = Number(layerId);
    const found = findCanvasLayer(id);
    const layer = found?.layer;

    if (event?.shiftKey && isMultiTransformLayer(layer)) {
        // 처음 Shift 선택할 때 기존 active 이미지도 같이 포함
        const activeLayer = getActiveTransformLayerOrNull();

        if (activeLayer && !selectedLayerIds.size) {
            selectedLayerIds.add(Number(activeLayer.id));
        }

        if (selectedLayerIds.has(id)) {
            selectedLayerIds.delete(id);
        } else {
            selectedLayerIds.add(id);
        }

        activeLayerId = id;

        // 하나만 남으면 일반 선택처럼 유지
        if (selectedLayerIds.size <= 1) {
            selectedLayerIds.clear();

            if (isMultiTransformLayer(layer)) {
                selectedLayerIds.add(id);
            }
        }
    } else {
        selectedLayerIds.clear();
        activeLayerId = id;

        if (isMultiTransformLayer(layer)) {
            selectedLayerIds.add(id);
        }
    }

    renderLayerList();
    renderCanvasLayersOnSurface();

    if (typeof updateImageResizePanel === 'function') {
        updateImageResizePanel();
    }

    saveCanvasState();
}

function checkSelectionArea(layerId, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }

    const found = findCanvasLayer(layerId);
    if (!found || found.layer.type !== 'selection') return;

    if (Number(checkedSelectionId) === Number(found.layer.id)) {
        checkedSelectionId = null;

        if (Number(activeClipSelectionId) === Number(found.layer.id)) {
            activeClipSelectionId = null;
        }
    } else {
        checkedSelectionId = found.layer.id;
        activeLayerId = found.layer.id;
        activeClipSelectionId = found.layer.id;
    }

    renderLayerList();
    renderCanvasLayersOnSurface();
    saveCanvasState();
}

function isSelectionChecked(layerId) {
    return Number(checkedSelectionId) === Number(layerId);
}

function getAllSelectionLayers(layers = canvasLayers, output = []) {
    layers.forEach((layer) => {
        if (layer.type === 'selection') {
            output.push(layer);
        }

        if ((layer.type === 'folder' || layer.type === 'selection') && Array.isArray(layer.children)) {
            getAllSelectionLayers(layer.children, output);
        }
    });

    return output;
}

function ensureCheckedSelectionId() {
    const selections = getAllSelectionLayers();

    if (!selections.length) {
        checkedSelectionId = null;
        return;
    }

    if (!checkedSelectionId) {
        return;
    }

    const exists = selections.some((layer) => Number(layer.id) === Number(checkedSelectionId));

    if (!exists) {
        checkedSelectionId = null;
    }
}

function toggleCanvasLayerVisibility(layerId, event) {
    if (event) event.stopPropagation();

    const found = findCanvasLayer(layerId);
    if (!found) return;

    found.layer.visible = !found.layer.visible;
    clearClipMergedSourcePreviewCache();
    clipMergedSourcePreviewSeq += 1;

    renderLayerList();
    renderCanvasLayersOnSurface();
    if (isClipInpaintMergedSourceMode) {
        renderClipOutputPanel();
    }
    saveCanvasState();
}

function collectCanvasLayerIds(layer, ids = new Set()) {
    if (!layer) return ids;

    ids.add(Number(layer.id));

    if ((layer.type === 'folder' || layer.type === 'selection') && Array.isArray(layer.children)) {
        layer.children.forEach((child) => collectCanvasLayerIds(child, ids));
    }

    return ids;
}

async function deleteCanvasLayer(layerId, event) {
    if (event) event.stopPropagation();

    let found = findCanvasLayer(layerId);
    if (!found) return;

    if (CanvasLayerDelete.countSourceClips(found.layer) > 0) {
        const target = found.layer;
        const confirmedIds = collectCanvasLayerIds(target);
        if (!await CanvasLayerDelete.confirm(target)) return;
        found = findCanvasLayer(layerId);
        const currentIds = found ? collectCanvasLayerIds(found.layer) : new Set();
        if (found?.layer !== target || currentIds.size !== confirmedIds.size ||
            [...currentIds].some(id => !confirmedIds.has(id))) {
            showToast('확인 중 레이어 구성이 바뀌었습니다. 삭제 대상을 다시 확인해 주세요.');
            return;
        }
    }

    const totalNodes = getAllCanvasLayerNodes();
    if (totalNodes.length <= 1) {
        alert('레이어는 최소 1개 이상 필요합니다.');
        return;
    }

    const deletedLayerIds = collectCanvasLayerIds(found.layer);
    const detachedRefs = collectCanvasImportRefsFromLayer(found.layer);

    found.container.splice(found.index, 1);

    if (Number(checkedSelectionId) === Number(layerId)) {
        checkedSelectionId = null;
    }

    if (Number(activeClipSelectionId) === Number(layerId)) {
        activeClipSelectionId = null;
    }

    ensureCheckedSelectionId();

    if (deletedLayerIds.has(Number(activeLayerId))) {
        activeLayerId = getFirstCanvasLayerId();
    }

    deletedLayerIds.forEach((id) => selectedLayerIds.delete(Number(id)));

    if (selectedLayerIds.size <= 1) {
        const remaining = [...selectedLayerIds][0];
        selectedLayerIds.clear();

        if (remaining) {
            selectedLayerIds.add(Number(remaining));
        }
    }

    renderLayerList();
    renderCanvasLayersOnSurface();
    saveCanvasState();
    cleanupDetachedCanvasImportRefs(detachedRefs);
}

function renderLayerList() {
    if (typeof refreshCanvasStyleLink === 'function') refreshCanvasStyleLink();
    if (typeof CanvasDakiFocus !== 'undefined') CanvasDakiFocus.refresh();
    const list = el('layerList');
    if (!list) return;

    // Keep the row under the pointer in place when a generated result is inserted.
    const hovered = list.querySelector('.layer-item:hover');
    const anchorId = hovered?.dataset.layerId;
    const anchorTop = hovered?.getBoundingClientRect().top;
    if (!list.dataset.deletePointerBound) {
        list.dataset.deletePointerBound = '1';
        list.addEventListener('pointermove', (event) => {
            canvasLayerDeletePointerId = getCanvasLayerDeletePointerTarget(event);
        });
        list.addEventListener('pointerleave', () => { canvasLayerDeletePointerId = null; });
        list.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            const id = getCanvasLayerDeletePointerTarget(event);
            if (event.pointerType === 'touch') canvasLayerDeletePointerId = id;
            canvasLayerDeletePressedId = id === canvasLayerDeletePointerId ? id : null;
        }, true);
    }

    list.innerHTML = '';

    if (!canvasLayers.length) {
        list.innerHTML = '<div class="layer-empty">캔버스를 생성하면 레이어가 표시됩니다.</div>';
        return;
    }

    renderLayerTree(canvasLayers, list, 0);
    if (anchorId) {
        const anchor = list.querySelector(`.layer-item[data-layer-id="${Number(anchorId)}"]`);
        if (anchor) list.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    }
    updateImageResizePanel();
}

function getCanvasLayerDeletePointerTarget(event) {
    const button = event.target.closest?.('.layer-delete-btn');
    return button ? Number(button.closest('.layer-item')?.dataset.layerId) : null;
}

function handleCanvasLayerDeleteClick(layerId, event) {
    event.stopPropagation();
    // A new row may replace a button between hover, press and release. Keyboard
    // activation has detail=0 and is already addressed to the focused button.
    if (event.detail > 0 && (canvasLayerDeletePointerId !== Number(layerId) ||
        canvasLayerDeletePressedId !== Number(layerId))) {
        showToast('목록이 갱신되었습니다. 삭제할 레이어를 다시 가리켜 주세요.');
        return;
    }
    canvasLayerDeletePressedId = null;
    deleteCanvasLayer(layerId, event);
}

function renderLayerTree(layers, container, depth) {
    layers.forEach((layer) => {
        if (layer.type === 'folder') {
            layer.children = Array.isArray(layer.children) ? layer.children : [];
        }
        const item = document.createElement('div');
        item.dataset.layerId = String(layer.id);

        item.style.setProperty('--layer-depth', depth);
        item.onclick = (event) => selectCanvasLayer(layer.id, event);

        const isFolder = layer.type === 'folder';
        const isSelection = layer.type === 'selection';
        const selectionLabel = isSelection && typeof CanvasDakiFocus !== 'undefined'
            ? CanvasDakiFocus.selectionLabel?.(layer) || '선택 영역' : '선택 영역';
        const isCheckedSelection = isSelection && isSelectionChecked(layer.id);
        const isContainer = isFolder || isSelection;
        const isImage = layer.type === 'image';
        const isClip = layer.type === 'clip';
        const isImageLike = isImage || isClip;
        const isCanvas = layer.type === 'canvas';
        const isInsideFolder = depth > 0 && !isContainer && !isCanvas;

        item.className = [
            'layer-item',
            isInsideFolder ? 'has-exit-folder' : '',
            isSelection ? 'has-selection-check' : '',
            isFolder ? 'folder-item' : '',
            isSelection ? 'selection-item' : '',
            isImageLike ? 'image-layer-item' : '',
            layer.id === activeLayerId ? 'active' : '',
            isLayerMultiSelected(layer.id) ? 'multi-selected' : '',
            layer.visible ? '' : 'hidden-layer'
        ].filter(Boolean).join(' ');

        item.innerHTML = `
            ${
                isContainer
                    ? `<button class="layer-expand-btn" title="열기/닫기">${layer.expanded ? '▼' : '▶'}</button>`
                    : `<div class="layer-expand-placeholder"></div>`
            }

            <button class="layer-visibility-btn ${layer.visible ? 'is-visible' : 'is-hidden'}" title="표시/숨김" aria-label="표시/숨김">
                <span class="layer-visibility-dot"></span>
            </button>

            ${
                isInsideFolder
                    ? `<button class="layer-exit-folder-btn" title="폴더 밖으로 꺼내기">←</button>`
                    : ``
            }

            ${
                isFolder
                    ? `<div class="layer-thumb layer-folder-thumb">📁</div>`
                    : isSelection
                        ? `<div class="layer-thumb layer-selection-thumb"></div>`
                        : `<div class="layer-thumb">${layer.src ? `<img src="${escapeHtml(getCanvasLayerDisplaySrc(layer))}" alt="">` : ''}</div>`
            }

            <div class="layer-info">
                <div class="layer-name">${escapeHtml(layer.name)}</div>
                <div class="layer-meta">
                    ${
                        isFolder
                            ? `폴더 · ${layer.children.length}개`
                            : isSelection
                                ? `<span class="layer-selection-region" data-selection-id="${layer.id}" title="${escapeHtml(selectionLabel)}">${escapeHtml(selectionLabel)}</span><span class="layer-selection-count">· ${layer.children.length}개</span>`
                                : isClip
                                    ? '클립 이미지'
                                    : isImage
                                        ? '이미지 레이어'
                                        : isCanvas
                                            ? '캔버스'
                                            : '빈 레이어'
                    }
                </div>
            </div>
            ${
                isSelection
                    ? `<button class="layer-selection-check-btn ${isCheckedSelection ? 'checked' : ''}"
                            title="이 선택 영역을 클립/인페인팅 표시 대상으로 사용">
                        ${isCheckedSelection ? '✓' : ''}
                    </button>`
                    : ``
            }

            <button class="layer-delete-btn" title="레이어 삭제">×</button>
        `;

        const expandBtn = item.querySelector('.layer-expand-btn');
        const visibilityBtn = item.querySelector('.layer-visibility-btn');
        const exitFolderBtn = item.querySelector('.layer-exit-folder-btn');
        const selectionCheckBtn = item.querySelector('.layer-selection-check-btn');
        const deleteBtn = item.querySelector('.layer-delete-btn');

        if (expandBtn) {
            expandBtn.onclick = (event) => {
                event.stopPropagation();
                layer.expanded = !layer.expanded;
                renderLayerList();
                saveCanvasState();
            };
        }

        visibilityBtn.onclick = (event) => toggleCanvasLayerVisibility(layer.id, event);

        if (exitFolderBtn) {
            exitFolderBtn.onclick = (event) => exitLayerFromFolder(layer.id, event);
            exitFolderBtn.oncontextmenu = (event) => event.stopPropagation();
        }

        deleteBtn.onclick = (event) => handleCanvasLayerDeleteClick(layer.id, event);
        if (selectionCheckBtn) {
            selectionCheckBtn.onclick = (event) => checkSelectionArea(layer.id, event);
            selectionCheckBtn.oncontextmenu = (event) => event.stopPropagation();
        }

        visibilityBtn.oncontextmenu = (event) => event.stopPropagation();
        deleteBtn.oncontextmenu = (event) => event.stopPropagation();

        // 이미지 레이어 우클릭 메뉴 유지
        if (isImageLike) {
            item.oncontextmenu = (event) => {
                openCanvasImageLayerContextMenu(event, layer.id);
            };
        }

        // 폴더와 캔버스 레이어는 드래그 대상에서 제외.
        // 일반 레이어/이미지 레이어만 폴더 안으로 넣을 수 있게 함.
        if (!isCanvas) {
            item.draggable = true;

            item.ondragstart = (event) => {
                if (event.target.closest('button')) {
                    event.preventDefault();
                    return;
                }

                draggedLayerId = layer.id;
                activeLayerId = layer.id;

                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', String(layer.id));
                item.classList.add('dragging-layer');
            };

            item.ondragend = () => {
                draggedLayerId = null;
                clearLayerDropMarkers();
                item.classList.remove('dragging-layer');
            };
        }

        item.ondragover = (event) => {
            if (!draggedLayerId) return;

            const dropPosition = resolveLayerListDropPosition(event, item, layer);
            if (!canDropLayerOnTarget(draggedLayerId, layer.id, dropPosition)) return;

            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'move';

            clearLayerDropMarkers();
            item.classList.add(
                dropPosition === 'inside'
                    ? 'drop-target'
                    : dropPosition === 'before'
                        ? 'drop-before'
                        : 'drop-after'
            );
        };

        item.ondragleave = () => {
            item.classList.remove('drop-target', 'drop-before', 'drop-after');
        };

        item.ondrop = (event) => {
            const dropPosition = resolveLayerListDropPosition(event, item, layer);
            moveDraggedLayerToTarget(event, layer.id, dropPosition);
        };

        container.appendChild(item);

        if (isContainer && layer.expanded) {
            const childContainer = document.createElement('div');
            childContainer.className = 'layer-children';

            childContainer.ondragover = (event) => {
                if (!draggedLayerId) return;
                if (!canDropLayerOnTarget(draggedLayerId, layer.id, 'inside')) return;

                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = 'move';

                clearLayerDropMarkers();
                item.classList.add('drop-target');
            };

            childContainer.ondragleave = () => {
                item.classList.remove('drop-target');
            };

            childContainer.ondrop = (event) => {
                moveDraggedLayerToTarget(event, layer.id, 'inside');
            };

            if (layer.children.length) {
                renderLayerTree(layer.children, childContainer, depth + 1);
            } else {
                childContainer.innerHTML = `<div class="folder-empty">레이어를 드래그해서 넣으세요.</div>`;
            }

            container.appendChild(childContainer);
        }
    });
}

function escapeHtml(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getCanvasDisplayImageSrc(src, width, height) {
    const source = String(src || '').trim();
    const maxSide = Math.max(Number(width) || 0, Number(height) || 0);

    if (!source || maxSide <= CANVAS_DISPLAY_PREVIEW_MAX_SIDE) {
        return source;
    }

    try {
        const url = new URL(source, window.location.origin);
        const isLocalCanvasImage = url.origin === window.location.origin && (
            url.pathname.startsWith('/image/') ||
            url.pathname.startsWith('/canvas-imports/')
        );

        if (!isLocalCanvasImage) return source;

        url.searchParams.set('preview', String(CANVAS_DISPLAY_PREVIEW_MAX_SIDE));
        return `${url.pathname}${url.search}`;
    } catch (error) {
        return source;
    }
}

function getCanvasLayerDisplaySrc(layer) {
    if (!layer) return '';
    return getCanvasDisplayImageSrc(
        layer.src,
        layer.imageWidth || layer.layerWidth,
        layer.imageHeight || layer.layerHeight
    );
}

let canvasAutosave = null;
function getCanvasAutosave() {
    if (!canvasAutosave) canvasAutosave = createCanvasAutosave({
        snapshot: () => ({...buildCanvasStateSnapshot({preserveMasks: Boolean(window.CanvasProject?.localLink() || window.CanvasWorkspaceBridge?.isPane)}),
            projectLink: window.CanvasProject?.localLink() || null,
            ...(window.CanvasWorkspaceBridge?.isPane ? {workspaceSetupId: activeCanvasSetupId} : {})}),
        write: text => localStorage.setItem(window.CanvasWorkspaceBridge?.stateKey || CANVAS_STATE_KEY, text),
        status: setCanvasAutosaveStatus
    });
    return canvasAutosave;
}
function setCanvasAutosaveStatus(state) {
    const box = document.getElementById('canvasAutosaveStatus');
    const label = document.getElementById('canvasAutosaveMessage');
    const retry = document.getElementById('canvasAutosaveRetry');
    if (!box || !label || !retry) return;
    box.hidden = state === 'idle';
    box.dataset.state = state;
    label.textContent = state === 'error'
        ? '자동 저장 실패. 현재 작업은 화면에 남아 있습니다. 다시 시도하거나 현재 캔버스 저장으로 보관하세요.'
        : state === 'pending' ? '자동 저장 대기 중…' : '이 브라우저에 자동 저장됨';
    retry.hidden = state !== 'error';
    window.CanvasWorkspaceBridge?.report();
}
function saveCanvasState(options = {}) {
    const edited = typeof recordCanvasEditHistory === 'function' ? recordCanvasEditHistory() : true;
    if (edited) window.CanvasProject?.schedule(Boolean(options.immediate));
    return getCanvasAutosave().schedule(Boolean(options.immediate));
}
window.addEventListener('beforeunload', event => {
    if (canvasAutosave && !canvasAutosave.flush()) {
        event.preventDefault();
        event.returnValue = '';
    }
});

function normalizeCanvasImportRef(value) {
    const text = String(value || '').trim();
    if (!text) return '';

    try {
        const url = new URL(text, window.location.origin);
        const path = decodeURIComponent(url.pathname || '');

        if (path.startsWith('/canvas-imports/')) {
            return path.slice('/canvas-imports/'.length).replace(/^\/+/, '');
        }
    } catch (error) {
        if (text.startsWith('/canvas-imports/')) {
            return text.split('?')[0].slice('/canvas-imports/'.length).replace(/^\/+/, '');
        }
    }

    return '';
}

function collectCanvasImportRefsFromValue(value, refs, seen = new WeakSet()) {
    if (typeof value === 'string') {
        const ref = normalizeCanvasImportRef(value);
        if (ref) refs.add(ref);
        return;
    }

    if (!value || typeof value !== 'object') return;

    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
        value.forEach((item) => collectCanvasImportRefsFromValue(item, refs, seen));
        return;
    }

    Object.values(value).forEach((item) => collectCanvasImportRefsFromValue(item, refs, seen));
}

function collectCurrentCanvasImportRefs() {
    const refs = new Set();

    try {
        if (currentCanvasWidth && currentCanvasHeight) {
            collectCanvasImportRefsFromValue(buildCanvasStateSnapshot(), refs);
        }

        if (typeof referenceGenSession !== 'undefined' && referenceGenSession) {
            collectCanvasImportRefsFromValue(referenceGenSession, refs);
        }
    } catch (error) {
        console.warn('Current canvas import ref collection failed:', error);
    }

    return [...refs];
}

function collectSavedCanvasImportRefs() {
    const refs = new Set();

    try {
        collectCanvasImportRefsFromValue(loadSavedCanvasSetups(), refs);
    } catch (error) {
        console.warn('Saved canvas import ref collection failed:', error);
    }

    return [...refs];
}

function collectStoredCanvasImportRefs() {
    const refs = new Set();

    try {
        const states = window.CanvasWorkspaceState
            ? CanvasWorkspaceState.storedStates(localStorage)
            : [JSON.parse(localStorage.getItem(CANVAS_STATE_KEY) || 'null')];
        states.forEach(state => collectCanvasImportRefsFromValue(state, refs));
    } catch (error) {
        console.warn('Stored canvas import ref collection failed:', error);
    }

    return [...refs];
}

function collectRetainedCanvasImportRefs() {
    return [
        ...new Set([
            ...collectCurrentCanvasImportRefs(),
            ...(typeof collectCanvasEditHistoryImportRefs === 'function' ? collectCanvasEditHistoryImportRefs() : []),
            ...collectSavedCanvasImportRefs(),
            ...collectStoredCanvasImportRefs()
        ])
    ];
}

function buildCanvasImportUsageIndex() {
    return {
        current: new Set(collectCurrentCanvasImportRefs()),
        saved: new Set(collectSavedCanvasImportRefs()),
        stored: new Set(collectStoredCanvasImportRefs())
    };
}

function getCanvasImportUsageStatus(ref, usageIndex = buildCanvasImportUsageIndex()) {
    const normalizedRef = normalizeCanvasImportRef(ref) || canvas_import_ref_fallback(ref);

    if (usageIndex.current.has(normalizedRef)) {
        return {
            key: 'current',
            label: '현재 캔버스 사용 중',
            detail: '지금 열린 캔버스나 참조 이미지 생성에서 쓰고 있습니다.',
            deletable: false
        };
    }

    if (usageIndex.saved.has(normalizedRef)) {
        return {
            key: 'saved',
            label: '저장 캔버스 사용 중',
            detail: '저장한 캔버스를 불러올 때 필요한 파일입니다.',
            deletable: false
        };
    }

    if (usageIndex.stored.has(normalizedRef)) {
        return {
            key: 'stored',
            label: '자동저장 사용 중',
            detail: '브라우저 자동저장 상태에서 참조 중입니다.',
            deletable: false
        };
    }

    return {
        key: 'unused',
        label: '삭제 가능',
        detail: '현재 캔버스와 저장 캔버스에서 사용하지 않습니다.',
        deletable: true
    };
}

function canvas_import_ref_fallback(ref) {
    return String(ref || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function collectCanvasImportRefsFromLayer(layer) {
    const refs = new Set();
    collectCanvasImportRefsFromValue(layer, refs);
    return [...refs];
}

function getActiveCanvasImportSessionIds() {
    return [CANVAS_IMPORT_SESSION_ID].filter(Boolean);
}

function scheduleCanvasImportCleanup() {
    // Keep generated/imported canvas assets until the user explicitly deletes them.
    // Only detached refs from delete actions are cleaned by cleanupDetachedCanvasImportRefs().
}

async function cleanupUnusedCanvasImports() {
    const retainedRefs = collectRetainedCanvasImportRefs();

    try {
        await fetch('/api/canvas/cleanup_imports', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                retainedRefs,
                activeSessionIds: getActiveCanvasImportSessionIds()
            })
        });
    } catch (error) {
        console.warn('Canvas import cleanup failed:', error);
    }
}

async function cleanupDetachedCanvasImportRefs(refs) {
    const targetRefs = Array.isArray(refs) ? refs.filter(Boolean) : [];
    if (!targetRefs.length) return;

    try {
        await fetch('/api/canvas/cleanup_import_refs', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                refs: targetRefs,
                retainedRefs: collectRetainedCanvasImportRefs()
            })
        });
    } catch (error) {
        console.warn('Detached canvas import cleanup failed:', error);
    }
}

function buildCanvasStateSnapshot(options = {}) {
    return {
        version: 2,
        savedAt: Date.now(),
        width: currentCanvasWidth,
        height: currentCanvasHeight,
        layers: cloneCanvasLayersForState(canvasLayers, options.preserveMasks === true),
        activeLayerId,
        layerIdSeq,
        styleLink: typeof getCanvasStyleLink === 'function' ? getCanvasStyleLink()?.snapshot() : undefined,
        projectSettingsLink: typeof CanvasProjectSettings !== 'undefined' ? CanvasProjectSettings.snapshot() : undefined,
        dakiBodyMap: typeof CanvasDakiFocus !== 'undefined' ? CanvasDakiFocus.snapshot() : undefined,
        retouchDraft: typeof CanvasRetouch !== 'undefined' ? CanvasRetouch.snapshot() : undefined,
        oppositeReference: typeof CanvasOppositeReference !== 'undefined' ? CanvasOppositeReference.snapshot() : undefined,
        inpaintReference: typeof CanvasInpaintReference !== 'undefined' ? CanvasInpaintReference.snapshot() : undefined,
        sharedSelectionClipPromptInfo: sharedSelectionClipPromptInfo
            ? structuredClone(sharedSelectionClipPromptInfo)
            : null,
        inpaintSettings: typeof CanvasInpaintSettings !== 'undefined'
            ? CanvasInpaintSettings.snapshot()
            : null,
        sharedSelectionClipPromptControlGroups: structuredClone(sharedSelectionClipPromptControlGroups || []),
        isSelectionOverlayHidden,
        checkedSelectionId,
        canvasZoom: typeof canvasZoom !== 'undefined' ? canvasZoom : 1,
        clipPreviewZoom: typeof clipPreviewZoom !== 'undefined' ? clipPreviewZoom : 1,
        isClipInpaintMergedSourceMode: Boolean(isClipInpaintMergedSourceMode)
    };
}

function cloneCanvasLayersForState(layers = [], preserveMasks = false) {
    const copies = structuredClone(Array.isArray(layers) ? layers : []);
    const clearSnapshotMasks = (items) => {
        items.forEach((layer) => {
            if (layer.type === 'clip' && !preserveMasks) {
                clearClipInpaintMask(layer);
            }

            if ((layer.type === 'folder' || layer.type === 'selection') && Array.isArray(layer.children)) {
                clearSnapshotMasks(layer.children);
            }
        });
    };
    clearSnapshotMasks(copies);
    return copies;
}

function collectClipInpaintMaskRefs(clip) {
    if (!clip || clip.type !== 'clip') {
        return [];
    }

    const refs = new Set();
    collectCanvasImportRefsFromValue({
        maskSrc: clip.maskSrc,
        maskDataUrl: clip.maskDataUrl
    }, refs);
    return [...refs];
}

function clearClipInpaintMask(clip) {
    if (!clip || clip.type !== 'clip') return;

    delete clip.maskSrc;
    delete clip.maskDataUrl;
    delete clip.maskWidth;
    delete clip.maskHeight;
}

function restoreCanvasState() {
    try {
        const raw = localStorage.getItem(CANVAS_STATE_KEY);

        if (!raw) {
            renderLayerList();
            return;
        }

        const state = JSON.parse(raw);

        if (!state || !state.width || !state.height) {
            renderLayerList();
            return;
        }

        applyCanvasStateSnapshot(state);
        window.CanvasProject?.restoreLocalLink(state.projectLink);

    } catch (error) {
        console.warn('Canvas state restore failed:', error);
        renderLayerList();
    }
}

function closePendingCanvasImportModal() {
    const modal = el('pendingCanvasImportModal');
    if (modal) modal.remove();

    pendingCanvasImportPayload = null;
}

function showPendingCanvasImportModal(payload) {
    pendingCanvasImportPayload = payload;

    const existing = el('pendingCanvasImportModal');
    if (existing) existing.remove();

    const hasCanvas = hasUsableCurrentCanvas();
    const alreadySaved = isCurrentCanvasAlreadySaved();
    const hasPrompt = Boolean(payload.hasPromptInfo || hasAnyPromptText(payload.promptInfo));
    const promptStatusHtml = hasPrompt
        ? `
            <div class="canvas-tool-hint" style="margin-bottom:14px;">
                프롬프트를 읽었습니다. 갤러리에서 가져온 이미지처럼 프롬프트 정보가 레이어에 함께 들어갑니다.
            </div>
        `
        : `
            <div class="canvas-tool-hint" style="margin-bottom:14px;">
                이 이미지에서 읽을 수 있는 프롬프트를 찾지 못했습니다. 이미지만 레이어로 가져옵니다.
            </div>
        `;

    const modal = document.createElement('div');
    modal.id = 'pendingCanvasImportModal';
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';

    modal.innerHTML = `
        <div class="modal-content canvas-modal">
            <div class="canvas-modal-header">
                <h3>캔버스로 가져오기</h3>
                <button class="icon-btn danger" onclick="cancelPendingCanvasImport()">×</button>
            </div>

            <div style="font-size:13px; line-height:1.6; color:var(--text-muted); margin-bottom:14px;">
                가져올 이미지:
                <strong style="color:var(--text-main);">${escapeHtml(payload.name || '이미지')}</strong>
            </div>

            ${promptStatusHtml}

            ${
                !hasCanvas
                    ? ''
                    : alreadySaved
                    ? `
                        <div class="canvas-tool-hint" style="margin-bottom:14px;">
                            현재 캔버스와 같은 저장본이 있어 저장 확인은 생략합니다.
                        </div>
                    `
                    : `
                        <label class="canvas-ratio-toggle" style="margin-bottom:14px;">
                            <input type="checkbox" id="pendingImportSaveCurrentCanvas" checked>
                            <span>가져오기 전에 현재 캔버스 저장</span>
                        </label>
                        <div class="canvas-tool-hint" style="margin-bottom:14px;">
                            현재 캔버스와 같은 저장본을 찾지 못했습니다. 초기화할 가능성이 있으니 저장을 권장합니다.
                        </div>
                    `
            }

            <div class="canvas-modal-actions" style="display:flex; flex-direction:column; gap:8px;">
                ${
                    hasCanvas
                        ? `
                            <button class="success" onclick="confirmPendingCanvasImport('append')" style="width:100%;">
                                기존 캔버스에 그림 추가
                            </button>

                            <button class="secondary" onclick="confirmPendingCanvasImport('reset')" style="width:100%;">
                                기존 캔버스를 초기화하고 그림 추가
                            </button>
                        `
                        : `
                            <button class="success" onclick="confirmPendingCanvasImport('append')" style="width:100%;">
                                새 캔버스로 가져오기
                            </button>
                        `
                }

                <button class="secondary" onclick="cancelPendingCanvasImport()" style="width:100%;">
                    취소
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
}

async function resetCanvasForPendingImport() {
    if (window.CanvasProject && !await CanvasProject.leave()) return false;
    if (typeof getCanvasStyleLink === 'function') getCanvasStyleLink()?.restore(null);
    if (typeof CanvasDakiFocus !== 'undefined') CanvasDakiFocus.restore(null);
    if (typeof CanvasRetouch !== 'undefined') CanvasRetouch.restore(null);
    if (typeof CanvasOppositeReference !== 'undefined') CanvasOppositeReference.restore(null);
    if (typeof CanvasInpaintReference !== 'undefined') CanvasInpaintReference.restore(null);
    currentCanvasWidth = 0;
    currentCanvasHeight = 0;
    canvasLayers = [];
    layerIdSeq = 1;
    activeLayerId = null;
    selectedLayerIds.clear();
    checkedSelectionId = null;
    activeClipSelectionId = null;
    activeClipPromptId = null;
    isClipInpaintPreviewMode = false;
    pinnedReferenceLayerId = null;

    sharedSelectionClipPromptInfo = null;
    sharedSelectionClipPromptControlGroups = [];
    if (typeof CanvasInpaintSettings !== 'undefined') CanvasInpaintSettings.restore(null);
    if (typeof CanvasProjectSettings !== 'undefined') CanvasProjectSettings.restore(null);

    canvasZoom = 1;
    clipPreviewZoom = 1;
    if (typeof resetCanvasEditHistory === 'function') resetCanvasEditHistory();
    return true;
}

async function confirmPendingCanvasImport(mode) {
    const payload = pendingCanvasImportPayload;
    if (!payload || !payload.src) {
        closePendingCanvasImportModal();
        return;
    }

    const saveCheckbox = el('pendingImportSaveCurrentCanvas');
    const shouldSaveBeforeImport = Boolean(saveCheckbox && saveCheckbox.checked);

    try {
        await importPendingCanvasImage(payload, {reset: mode === 'reset', saveCurrent: shouldSaveBeforeImport});

    } catch (error) {
        alert(`캔버스 이미지 가져오기 실패: ${error.message || error}`);
    }
}

function cancelPendingCanvasImport() {
    localStorage.removeItem(CANVAS_PENDING_IMPORT_KEY);
    closePendingCanvasImportModal();
}

function formatCanvasImportSize(bytes) {
    const size = Number(bytes) || 0;
    if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
    if (size >= 1024) return `${Math.round(size / 1024)} KB`;
    return `${size} B`;
}

function formatCanvasImportDate(timestamp) {
    const date = new Date(Number(timestamp) || 0);
    if (Number.isNaN(date.getTime())) return '날짜 없음';
    return date.toLocaleString();
}

function getCanvasImportPromptSummary(item) {
    if (!item?.hasPromptInfo && !hasAnyPromptText(item?.promptInfo)) {
        return '프롬프트 없음';
    }

    const promptInfo = normalizePromptInfo(item.promptInfo);
    const promptText = promptInfo?.prompt || promptInfo?.description || promptInfo?.uc || '';
    const summary = String(promptText || '').trim().replace(/\s+/g, ' ');

    return summary ? `프롬프트 있음 · ${summary.slice(0, 90)}` : '프롬프트 있음';
}

function closeCanvasImportManagerModal() {
    const modal = el('canvasImportManagerModal');
    if (modal) modal.remove();
    selectedCanvasImportManagerRef = '';
}

function ensureCanvasImportManagerModal() {
    const existing = el('canvasImportManagerModal');
    if (existing) return existing;

    const modal = document.createElement('div');
    modal.id = 'canvasImportManagerModal';
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';
    modal.innerHTML = `
        <div class="modal-content canvas-import-manager-modal">
            <div class="canvas-modal-header">
                <h3>외부 이미지 목록</h3>
                <button class="icon-btn danger" type="button" id="canvasImportManagerCloseBtn">×</button>
            </div>
            <div class="canvas-import-manager-filters" id="canvasImportManagerFilters">
                <button type="button" data-filter="all" class="active">전체</button>
                <button type="button" data-filter="unused">삭제 가능</button>
                <button type="button" data-filter="protected">사용 중</button>
            </div>
            <div class="canvas-import-manager-layout">
                <div class="canvas-import-manager-list" id="canvasImportManagerList">
                    <div class="saved-canvas-empty">외부 이미지를 불러오는 중입니다.</div>
                </div>
                <div class="canvas-import-manager-preview" id="canvasImportManagerPreview">
                    <div class="canvas-import-manager-empty">왼쪽 목록에서 이미지를 선택하세요.</div>
                </div>
            </div>
        </div>
    `;

    modal.querySelector('#canvasImportManagerCloseBtn')?.addEventListener('click', closeCanvasImportManagerModal);
    modal.querySelectorAll('#canvasImportManagerFilters button[data-filter]').forEach((button) => {
        button.addEventListener('click', () => {
            canvasImportManagerFilter = button.dataset.filter || 'all';
            selectedCanvasImportManagerRef = '';
            renderCanvasImportManagerList();
            renderCanvasImportManagerPreview();
        });
    });
    modal.addEventListener('click', (event) => {
        if (event.target === modal) closeCanvasImportManagerModal();
    });

    document.body.appendChild(modal);
    return modal;
}

async function openCanvasImportManagerModal() {
    ensureCanvasImportManagerModal();
    await loadCanvasImportManagerItems();
}

async function loadCanvasImportManagerItems() {
    const listEl = el('canvasImportManagerList');
    const previewEl = el('canvasImportManagerPreview');

    if (listEl) listEl.innerHTML = `<div class="saved-canvas-empty">외부 이미지를 불러오는 중입니다.</div>`;
    if (previewEl) previewEl.innerHTML = `<div class="canvas-import-manager-empty">왼쪽 목록에서 이미지를 선택하세요.</div>`;

    try {
        const response = await fetch('/api/canvas/imports/list');
        const data = await response.json();

        if (!response.ok || data.status !== 'success') {
            throw new Error(data.message || '외부 이미지 목록을 불러오지 못했습니다.');
        }

        canvasImportManagerItems = Array.isArray(data.items) ? data.items : [];
        selectedCanvasImportManagerRef = canvasImportManagerItems[0]?.ref || '';
        renderCanvasImportManagerList();
        renderCanvasImportManagerPreview();

    } catch (error) {
        canvasImportManagerItems = [];
        selectedCanvasImportManagerRef = '';
        if (listEl) {
            listEl.innerHTML = `<div class="saved-canvas-empty">목록 불러오기 실패: ${escapeHtml(error.message || error)}</div>`;
        }
    }
}

function renderCanvasImportManagerList() {
    const listEl = el('canvasImportManagerList');
    if (!listEl) return;

    listEl.innerHTML = '';
    const usageIndex = buildCanvasImportUsageIndex();
    const visibleItems = canvasImportManagerItems.filter((item) => {
        const status = getCanvasImportUsageStatus(item.ref, usageIndex);

        if (canvasImportManagerFilter === 'unused') return status.deletable;
        if (canvasImportManagerFilter === 'protected') return !status.deletable;
        return true;
    });

    document.querySelectorAll('#canvasImportManagerFilters button[data-filter]').forEach((button) => {
        button.classList.toggle('active', (button.dataset.filter || 'all') === canvasImportManagerFilter);
    });

    if (!canvasImportManagerItems.length) {
        listEl.innerHTML = `<div class="saved-canvas-empty">남아있는 외부 이미지가 없습니다.</div>`;
        return;
    }

    if (!visibleItems.length) {
        selectedCanvasImportManagerRef = '';
        listEl.innerHTML = `<div class="saved-canvas-empty">이 조건에 맞는 외부 이미지가 없습니다.</div>`;
        return;
    }

    if (!visibleItems.some((item) => item.ref === selectedCanvasImportManagerRef)) {
        selectedCanvasImportManagerRef = visibleItems[0]?.ref || '';
    }

    visibleItems.forEach((item) => {
        const status = getCanvasImportUsageStatus(item.ref, usageIndex);
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `canvas-import-manager-item${item.ref === selectedCanvasImportManagerRef ? ' active' : ''}`;
        row.innerHTML = `
            <img src="${escapeHtml(getCanvasDisplayImageSrc(item.src, item.width, item.height))}" alt="">
            <span class="canvas-import-manager-item-info">
                <strong>${escapeHtml(item.name || '외부 이미지')}</strong>
                <span class="canvas-import-manager-status ${status.key}">${escapeHtml(status.label)}</span>
                <span>${escapeHtml(item.categoryLabel || '기타')} · ${escapeHtml(formatCanvasImportDate(item.mtime))}</span>
                <span>${escapeHtml(item.width || '?')}×${escapeHtml(item.height || '?')} · ${escapeHtml(formatCanvasImportSize(item.size))}</span>
                <span class="${item.hasPromptInfo ? 'has-prompt' : ''}">${escapeHtml(getCanvasImportPromptSummary(item))}</span>
            </span>
        `;
        row.addEventListener('click', () => {
            selectedCanvasImportManagerRef = item.ref;
            renderCanvasImportManagerList();
            renderCanvasImportManagerPreview();
        });
        listEl.appendChild(row);
    });
}

function getSelectedCanvasImportManagerItem() {
    return canvasImportManagerItems.find((item) => item.ref === selectedCanvasImportManagerRef) || null;
}

function renderCanvasImportManagerPreview() {
    const previewEl = el('canvasImportManagerPreview');
    if (!previewEl) return;

    const item = getSelectedCanvasImportManagerItem();
    if (!item) {
        previewEl.innerHTML = `<div class="canvas-import-manager-empty">왼쪽 목록에서 이미지를 선택하세요.</div>`;
        return;
    }
    const status = getCanvasImportUsageStatus(item.ref);

    previewEl.innerHTML = '';

    const imageWrap = document.createElement('div');
    imageWrap.className = 'canvas-import-manager-image-wrap';
    imageWrap.innerHTML = `<img src="${escapeHtml(getCanvasDisplayImageSrc(item.src, item.width, item.height))}" alt="">`;

    const details = document.createElement('div');
    details.className = 'canvas-import-manager-details';
    details.innerHTML = `
        <div class="canvas-import-manager-name">${escapeHtml(item.name || '외부 이미지')}</div>
        <div><span class="canvas-import-manager-status ${status.key}">${escapeHtml(status.label)}</span></div>
        <div>${escapeHtml(status.detail)}</div>
        <div>${escapeHtml(item.width || '?')}×${escapeHtml(item.height || '?')} · ${escapeHtml(formatCanvasImportSize(item.size))}</div>
        <div>${escapeHtml(item.categoryLabel || '기타')} · ${escapeHtml(formatCanvasImportDate(item.mtime))}</div>
        <div class="${item.hasPromptInfo ? 'has-prompt' : ''}">${escapeHtml(getCanvasImportPromptSummary(item))}</div>
    `;

    const actions = document.createElement('div');
    actions.className = 'canvas-import-manager-actions';

    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'success';
    importBtn.innerText = '캔버스로 가져오기';
    importBtn.addEventListener('click', () => importCanvasImportManagerItem(item.ref));

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'danger';
    deleteBtn.innerText = '삭제';
    deleteBtn.disabled = !status.deletable;
    deleteBtn.title = status.deletable ? '이 파일은 삭제할 수 있습니다.' : status.detail;
    deleteBtn.addEventListener('click', () => deleteCanvasImportManagerItem(item.ref));

    actions.append(importBtn, deleteBtn);
    previewEl.append(imageWrap, details, actions);
}

function importCanvasImportManagerItem(ref) {
    const item = canvasImportManagerItems.find((entry) => entry.ref === ref);
    if (!item) return;

    closeCanvasImportManagerModal();
    showPendingCanvasImportModal({
        src: item.src,
        path: item.src,
        width: item.width,
        height: item.height,
        name: item.name || '외부 이미지',
        promptInfo: item.promptInfo || null,
        hasPromptInfo: Boolean(item.hasPromptInfo),
        importedAt: Date.now()
    });
}

async function deleteCanvasImportManagerItem(ref) {
    const item = canvasImportManagerItems.find((entry) => entry.ref === ref);
    if (!item) return;

    const status = getCanvasImportUsageStatus(ref);
    if (!status.deletable) {
        alert(`${status.label}이라 삭제하지 않았습니다.\n${status.detail}`);
        return;
    }

    const ok = confirm(`'${item.name || '외부 이미지'}' 파일을 삭제할까요?\n현재 캔버스나 저장된 캔버스에서 사용 중이면 삭제되지 않습니다.`);
    if (!ok) return;

    try {
        const response = await fetch('/api/canvas/cleanup_import_refs', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                refs: [ref],
                retainedRefs: collectRetainedCanvasImportRefs()
            })
        });
        const data = await response.json();

        if (!response.ok || data.status !== 'success') {
            throw new Error(data.message || '외부 이미지를 삭제하지 못했습니다.');
        }

        if (Number(data.deleted || 0) > 0) {
            showToast('외부 이미지를 삭제했습니다.');
        } else {
            alert('삭제되지 않았습니다. 현재 캔버스나 저장된 캔버스에서 사용 중일 수 있습니다.');
        }

        await loadCanvasImportManagerItems();

    } catch (error) {
        alert(`외부 이미지 삭제 실패: ${error.message || error}`);
    }
}

function openExternalCanvasImagePicker() {
    const input = el('externalCanvasImageInput');
    if (input) input.click();
}

function isSupportedExternalCanvasImage(file) {
    return CanvasImageClipboard.isSupported(file);
}

async function handleExternalCanvasImageSelected(input) {
    const file = input?.files?.[0] || null;
    if (input) input.value = '';
    if (!file) return;

    await importExternalCanvasImageFile(file);
}

async function importExternalCanvasImageFile(file) {
    if (!file) return;

    if (!isSupportedExternalCanvasImage(file)) {
        alert('PNG, JPG, WebP 이미지만 가져올 수 있습니다.');
        return;
    }

    if (externalCanvasImageImportBusy) return;
    externalCanvasImageImportBusy = true;

    const button = el('externalCanvasImageBtn');
    if (button) {
        button.disabled = true;
        button.dataset.originalText = button.innerText;
        button.innerText = '가져오는 중...';
    }

    try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('sessionId', CANVAS_IMPORT_SESSION_ID);

        const response = await fetch('/api/canvas/upload_image', {
            method: 'POST',
            body: formData
        });

        const data = await response.json();

        if (!response.ok || data.status !== 'success') {
            throw new Error(data.message || '외부 이미지를 가져오지 못했습니다.');
        }

        const payload = {
            src: data.src,
            path: data.path || data.src || '',
            width: data.width,
            height: data.height,
            name: data.name || file.name || '외부 이미지',
            promptInfo: data.promptInfo || null,
            hasPromptInfo: Boolean(data.hasPromptInfo),
            importedAt: Date.now()
        };

        if (!payload.src) {
            throw new Error('업로드된 이미지 경로가 없습니다.');
        }

        showPendingCanvasImportModal(payload);

    } catch (error) {
        alert(`외부 이미지 가져오기 실패: ${error.message || error}`);

    } finally {
        externalCanvasImageImportBusy = false;
        if (button) {
            button.disabled = false;
            button.innerText = button.dataset.originalText || '📁 외부 이미지 가져오기';
            delete button.dataset.originalText;
        }
    }
}

function getFirstSupportedImageFileFromList(files) {
    return [...(files || [])].find((file) => isSupportedExternalCanvasImage(file)) || null;
}

function blobToDataUrl(blob) {
    return CanvasImageClipboard.toDataUrl(blob);
}

async function readExternalCanvasImageFileFromSystemClipboard() {
    return CanvasImageClipboard.readSystemFile();
}

async function readExternalCanvasImageDataUrlFromSystemClipboard() {
    const file = await readExternalCanvasImageFileFromSystemClipboard();
    if (!file) return '';
    return await blobToDataUrl(file);
}

function isEditablePasteTarget(target) {
    if (!target) return false;
    const tag = String(target.tagName || '').toLowerCase();
    return target.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select';
}

function bindExternalCanvasImageDropAndPaste() {
    const surface = el('canvasSurface');
    const workspace = document.querySelector('.canvas-workspace');

    const bindDropTarget = (target) => {
        if (!target || target.dataset.externalImageDropBound === '1') return;

        target.dataset.externalImageDropBound = '1';

        target.addEventListener('dragover', (event) => {
            if (![...(event.dataTransfer?.types || [])].includes('Files')) return;

            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            (workspace || target).classList.add('external-image-drag-over');
        });

        target.addEventListener('dragleave', (event) => {
            if (target.contains(event.relatedTarget)) return;
            (workspace || target).classList.remove('external-image-drag-over');
        });

        target.addEventListener('drop', async (event) => {
            const file = getFirstSupportedImageFileFromList(event.dataTransfer?.files);
            if (!file) return;

            event.preventDefault();
            event.stopPropagation();
            (workspace || target).classList.remove('external-image-drag-over');
            await importExternalCanvasImageFile(file);
        });
    };

    bindDropTarget(workspace);
    bindDropTarget(surface);

    if (document.body?.dataset.externalImagePasteBound === '1') return;
    if (document.body) document.body.dataset.externalImagePasteBound = '1';

    document.addEventListener('paste', async (event) => {
        if (isEditablePasteTarget(event.target)) return;

        let file = CanvasImageClipboard.readEventFile(event.clipboardData);
        const pasteToSelection = isClipOutputKeyboardTargetActive();
        // Cancel synchronously: after awaiting clipboard permission it is too late.
        if (file || pasteToSelection) event.preventDefault();
        if (pasteToSelection) {
            await pasteInternalClipboardToClipInpaintResults({
                externalImageFile: file,
                preferSystemClipboard: !file
            });
            return;
        }
        if (!file) {
            file = await readExternalCanvasImageFileFromSystemClipboard();
        }

        if (!file) return;

        event.preventDefault();
        await importExternalCanvasImageFile(file);
    });
}

async function consumePendingCanvasImport() {
    const raw = localStorage.getItem(CANVAS_PENDING_IMPORT_KEY);
    if (!raw) return;

    try {
        const payload = JSON.parse(raw);
        if (!payload || !payload.src) {
            localStorage.removeItem(CANVAS_PENDING_IMPORT_KEY);
            return;
        }

        // 캔버스가 없으면 물어보지 않고 바로 새 캔버스로 가져온다.
        if (!hasUsableCurrentCanvas()) {
            await importPendingCanvasImage(payload);
            return;
        }

        // 기존 캔버스가 있으면 추가/초기화 선택 모달을 띄운다.
        showPendingCanvasImportModal(payload);

    } catch (error) {
        localStorage.removeItem(CANVAS_PENDING_IMPORT_KEY);
        alert(`캔버스 이미지 가져오기 실패: ${error.message || error}`);
    }
}

let pendingCanvasImageImportBusy = false;

async function importPendingCanvasImage(payload, {reset = false, saveCurrent = false} = {}) {
    if (pendingCanvasImageImportBusy) return false;
    pendingCanvasImageImportBusy = true;
    try {
        const project = window.CanvasProject;
        const target = project ? await project.prepareImageImport(payload.projectContext) : null;
        if (target === false) return false;

        if (saveCurrent && !isCurrentCanvasAlreadySaved()) await saveCurrentCanvasSetupSilently();
        // Flush the old project before the imported layer can enter its autosave snapshot.
        const current = project?.localLink();
        if (target && current && target.projectId !== current.projectId && !await project.leave()) return false;
        if (reset && !await resetCanvasForPendingImport()) return false;

        localStorage.removeItem(CANVAS_PENDING_IMPORT_KEY);
        closePendingCanvasImportModal();
        await importImageLayer(payload);
        if (target) {
            try {
                await project.connectImportedImage(target, payload);
            } catch (error) {
                showToast('그림은 가져왔지만 프로젝트 연결에 실패했습니다. 「Daki 프로젝트 연결」에서 다시 연결해 주세요. ' + error.message);
            }
        }
        return true;
    } finally {
        pendingCanvasImageImportBusy = false;
    }
}

function loadImageInfo(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({
            width: img.naturalWidth || img.width || 960,
            height: img.naturalHeight || img.height || 3072
        });
        img.onerror = () => reject(new Error('이미지를 불러올 수 없습니다.'));
        img.src = src;
    });
}

async function importImageLayer(payload) {
    const payloadWidth = Math.round(Number(payload.width) || 0);
    const payloadHeight = Math.round(Number(payload.height) || 0);
    const info = payloadWidth > 0 && payloadHeight > 0
        ? { width: payloadWidth, height: payloadHeight }
        : await loadImageInfo(payload.src);

    // 캔버스가 없으면 가져온 이미지 크기로 새 캔버스 생성
    if (!currentCanvasWidth || !currentCanvasHeight) {
        currentCanvasWidth = info.width;
        currentCanvasHeight = info.height;
        canvasLayers = [];
        layerIdSeq = 1;
    }

    const initialGeometry = getInitialImageLayerGeometry(info.width, info.height, {
        allowUpscale: true
    });

    if (typeof CanvasInpaintSettings !== 'undefined') CanvasInpaintSettings.seed(payload.promptInfo);
    let promptInfo = normalizePromptInfo(payload.promptInfo);

    if ((!promptInfo || !hasAnyPromptText(promptInfo)) && payload.path) {
        const fetchedPrompt = await fetchPromptInfoByPath(payload.path);
        if (typeof CanvasInpaintSettings !== 'undefined') CanvasInpaintSettings.seed(fetchedPrompt);
        if (fetchedPrompt && hasAnyPromptText(fetchedPrompt)) {
            promptInfo = fetchedPrompt;
        }
    }
    const newLayerId = layerIdSeq++;

    const layer = {
        id: newLayerId,
        promptOwnerId: newLayerId,
        name: payload.name || `이미지 레이어 ${canvasLayers.length + 1}`,
        visible: true,
        type: 'image',
        src: payload.src,
        sourcePath: payload.path || '',
        promptInfo,
        promptControlGroups: [],
        imageWidth: info.width,
        imageHeight: info.height,
        x: initialGeometry.x,
        y: initialGeometry.y,
        layerWidth: initialGeometry.width,
        layerHeight: initialGeometry.height
    };

    canvasLayers.unshift(layer);
    activeLayerId = layer.id;

    renderCanvas(currentCanvasWidth, currentCanvasHeight);
    renderLayerList();
    saveCanvasState();
}

function renderCanvasLayersOnSurface() {
    const surface = el('canvasSurface');
    if (!surface) return;

    if (canvasHotGeometryFrame !== null) {
        cancelAnimationFrame(canvasHotGeometryFrame);
        canvasHotGeometryFrame = null;
    }
    pendingCanvasHotLayerIds.clear();
    surface.innerHTML = '';

    const displayScale = getCanvasDisplayScale();

    renderCanvasLayerStack(canvasLayers, surface, displayScale);
    renderMultiLayerTransformOverlay(surface, displayScale);
    renderClampedImageResizeHandles(surface, displayScale);
    renderClipOutputPanel();
    renderPinnedReferencePanel();
    renderCanvasResizeHandles(surface, displayScale);
    renderCanvasResizeSpacingGuides(surface, displayScale);
    if (typeof syncCanvasLayerEraser === 'function') syncCanvasLayerEraser();
    if (typeof CanvasDakiFocus !== 'undefined') CanvasDakiFocus.syncEditor?.();
    if (typeof CanvasOppositeReference !== 'undefined') CanvasOppositeReference.render();
    if (typeof CanvasRetouch !== 'undefined') CanvasRetouch.sync();
    if (typeof CanvasGrid !== 'undefined') CanvasGrid.render();
    if (typeof CanvasKeyboardMove !== 'undefined') CanvasKeyboardMove.syncControls();
    if (typeof CanvasInpaintReference !== 'undefined') CanvasInpaintReference.render();
}

function setCanvasLayerNodePosition(node, x, y, displayScale) {
    if (!node) return;

    node.style.left = '0px';
    node.style.top = '0px';
    node.style.transform = `translate3d(${x * displayScale}px, ${y * displayScale}px, 0)`;
}

function updateCanvasLayerNodeGeometry(layer, displayScale = getCanvasDisplayScale()) {
    if (!layer || layer.visible === false) return false;

    const node = document.querySelector(`.canvas-render-layer[data-layer-id="${Number(layer.id)}"]`);
    if (!node) return false;

    if (layer.type === 'selection') {
        normalizeSelectionAreaGeometry(layer);
    } else if (layer.type === 'image') {
        normalizeImageLayerGeometry(layer);
    }

    const x = Number(layer.x || 0);
    const y = Number(layer.y || 0);
    const width = Number(layer.layerWidth || layer.imageWidth || 1);
    const height = Number(layer.layerHeight || layer.imageHeight || 1);

    setCanvasLayerNodePosition(node, x, y, displayScale);
    node.style.width = `${width * displayScale}px`;
    node.style.height = `${height * displayScale}px`;
    if (layer.type === 'selection') {
        node.style.transform += ` rotate(${CanvasSelectionRotation.angle(layer.rotation)}deg)`;
        node.style.setProperty('--selection-rotate-size', `${Math.max(12, Math.min(36, Math.min(width, height) * displayScale - 24))}px`);
    }
    if (layer.type === 'clip') node.style.transform += ` rotate(${CanvasSelectionRotation.angle(layer.rotation)}deg)`;
    return true;
}

function updateCanvasHotMultiLayerOverlay(surface, displayScale) {
    const box = surface.querySelector('.multi-layer-transform-box');
    if (!box) return;

    const layers = getSelectedTransformLayers();
    const bounds = layers.length >= 2 ? getTransformLayerBounds(layers) : null;

    if (!bounds) {
        box.remove();
        return;
    }

    box.style.left = `${bounds.x * displayScale}px`;
    box.style.top = `${bounds.y * displayScale}px`;
    box.style.width = `${bounds.width * displayScale}px`;
    box.style.height = `${bounds.height * displayScale}px`;
}

function syncCanvasSurfaceSelectionState() {
    const surface = el('canvasSurface');
    if (!surface) return;

    surface.querySelectorAll('.canvas-render-layer[data-layer-id]').forEach((node) => {
        const id = Number(node.dataset.layerId);
        node.classList.toggle('multi-selected', isLayerMultiSelected(id));
        node.classList.toggle(
            'is-active-moving',
            Boolean(activeLayerDrag && activeLayerDrag.mode !== 'multi' && Number(activeLayerId) === id)
        );

        if (node.classList.contains('selection-area-layer')) {
            node.classList.toggle('active-selection', Number(activeLayerId) === id);
        }
    });

    surface.querySelector('.multi-layer-transform-box')?.remove();
    renderMultiLayerTransformOverlay(surface, getCanvasDisplayScale());
}

function updateCanvasHotResizeControls(surface, displayScale) {
    if (!isImageResizeMode) return;
    surface.querySelectorAll('.image-resize-clamped-handle').forEach((node) => node.remove());
    renderClampedImageResizeHandles(surface, displayScale);
}

function updateCanvasHotLayerGeometry(targets) {
    const addTarget = (target) => {
        if (target == null) return;
        if (typeof target === 'object' && target.id != null) {
            pendingCanvasHotLayerIds.add(Number(target.id));
            return;
        }
        pendingCanvasHotLayerIds.add(Number(target));
    };

    if (Array.isArray(targets)) {
        targets.forEach(addTarget);
    } else {
        addTarget(targets);
    }

    if (canvasHotGeometryFrame !== null) return;

    canvasHotGeometryFrame = requestAnimationFrame(() => {
        canvasHotGeometryFrame = null;
        flushPendingCanvasHotLayerGeometry();
    });
}

function flushPendingCanvasHotLayerGeometry() {
    if (canvasHotGeometryFrame !== null) {
        cancelAnimationFrame(canvasHotGeometryFrame);
        canvasHotGeometryFrame = null;
    }

    if (!pendingCanvasHotLayerIds.size) return;

    const ids = [...pendingCanvasHotLayerIds];
    pendingCanvasHotLayerIds.clear();
    flushCanvasHotLayerGeometry(ids);
}

function flushCanvasHotLayerGeometry(ids) {
    const surface = el('canvasSurface');
    if (!surface) return;

    const displayScale = getCanvasDisplayScale();

    (ids || []).forEach((id) => {
        if (!Number.isFinite(id)) return;
        const layer = findCanvasLayer(id)?.layer;
        updateCanvasLayerNodeGeometry(layer, displayScale);
    });

    updateCanvasHotMultiLayerOverlay(surface, displayScale);
    updateCanvasHotResizeControls(surface, displayScale);
    if (typeof CanvasInpaintReference !== 'undefined') CanvasInpaintReference.render();
}

function renderCanvasResizeHandles(surface, displayScale) {
    if (!isCanvasResizeMode || !currentCanvasWidth || !currentCanvasHeight) return;

    const right = currentCanvasWidth * displayScale;
    const bottom = currentCanvasHeight * displayScale;
    const centerX = right / 2;
    const centerY = bottom / 2;

    const positions = {
        tl: { left: 0, top: 0 },
        t: { left: centerX, top: 0 },
        tr: { left: right, top: 0 },
        r: { left: right, top: centerY },
        br: { left: right, top: bottom },
        b: { left: centerX, top: bottom },
        bl: { left: 0, top: bottom },
        l: { left: 0, top: centerY }
    };

    Object.entries(positions).forEach(([handle, point]) => {
        const node = document.createElement('div');
        node.className = `canvas-resize-handle ${handle}`;
        node.dataset.handle = handle;
        node.style.left = `${point.left}px`;
        node.style.top = `${point.top}px`;
        node.onmousedown = (event) => startCanvasResizeDrag(event, handle);
        surface.appendChild(node);
    });
}

function getCanvasResizeImageBounds() {
    let bounds = null;

    forEachCanvasLayerDeep(canvasLayers, (layer) => {
        if (!layer || layer.type !== 'image' || !layer.src || layer.visible === false || layer.pinnedReference) return;

        normalizeImageLayerGeometry(layer);

        const x = Number(layer.x || 0);
        const y = Number(layer.y || 0);
        const width = Number(layer.layerWidth || layer.imageWidth || 0);
        const height = Number(layer.layerHeight || layer.imageHeight || 0);
        if (!width || !height) return;

        const next = {
            left: x,
            top: y,
            right: x + width,
            bottom: y + height
        };

        if (!bounds) {
            bounds = next;
            return;
        }

        bounds.left = Math.min(bounds.left, next.left);
        bounds.top = Math.min(bounds.top, next.top);
        bounds.right = Math.max(bounds.right, next.right);
        bounds.bottom = Math.max(bounds.bottom, next.bottom);
    });

    return bounds;
}

function renderCanvasResizeSpacingGuides(surface, displayScale) {
    if (!activeCanvasResizeDrag || !currentCanvasWidth || !currentCanvasHeight) return;

    const bounds = getCanvasResizeImageBounds();
    if (!bounds) return;

    const spacing = {
        left: Math.round(bounds.left),
        right: Math.round(currentCanvasWidth - bounds.right),
        top: Math.round(bounds.top),
        bottom: Math.round(currentCanvasHeight - bounds.bottom)
    };

    const labels = [
        {
            key: 'left',
            text: `좌 ${spacing.left}px`,
            left: Math.max(6, (bounds.left * displayScale) / 2),
            top: Math.max(18, ((bounds.top + bounds.bottom) / 2) * displayScale)
        },
        {
            key: 'right',
            text: `우 ${spacing.right}px`,
            left: Math.min(currentCanvasWidth * displayScale - 6, ((bounds.right + currentCanvasWidth) / 2) * displayScale),
            top: Math.max(18, ((bounds.top + bounds.bottom) / 2) * displayScale)
        },
        {
            key: 'top',
            text: `상 ${spacing.top}px`,
            left: Math.max(6, ((bounds.left + bounds.right) / 2) * displayScale),
            top: Math.max(18, (bounds.top * displayScale) / 2)
        },
        {
            key: 'bottom',
            text: `하 ${spacing.bottom}px`,
            left: Math.max(6, ((bounds.left + bounds.right) / 2) * displayScale),
            top: Math.min(currentCanvasHeight * displayScale - 6, ((bounds.bottom + currentCanvasHeight) / 2) * displayScale)
        }
    ];

    labels.forEach((label) => {
        const node = document.createElement('div');
        node.className = `canvas-resize-spacing-label ${label.key}`;
        node.innerText = label.text;
        node.style.left = `${label.left}px`;
        node.style.top = `${label.top}px`;
        surface.appendChild(node);
    });
}

function getResizeBoundsForLayer(layer) {
    if (!isResizableCanvasLayer(layer)) return null;

    normalizeResizableLayerGeometry(layer);

    return {
        x: Number(layer.x || 0),
        y: Number(layer.y || 0),
        width: Number(layer.layerWidth || layer.imageWidth || 1),
        height: Number(layer.layerHeight || layer.imageHeight || 1)
    };
}

function getResizeHandleCanvasPoint(bounds, handle) {
    const left = bounds.x;
    const top = bounds.y;
    const right = bounds.x + bounds.width;
    const bottom = bounds.y + bounds.height;
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;

    const positions = {
        tl: { x: left, y: top },
        t: { x: centerX, y: top },
        tr: { x: right, y: top },
        r: { x: right, y: centerY },
        br: { x: right, y: bottom },
        b: { x: centerX, y: bottom },
        bl: { x: left, y: bottom },
        l: { x: left, y: centerY }
    };

    return positions[handle] || null;
}

function isResizeHandleOutsideCanvas(point) {
    if (!point) return false;

    return (
        point.x < 0 ||
        point.y < 0 ||
        point.x > currentCanvasWidth ||
        point.y > currentCanvasHeight
    );
}

function getClampedResizeHandlePoint(point, displayScale) {
    const inset = 10 / Math.max(displayScale, 0.01);
    const maxX = Math.max(inset, currentCanvasWidth - inset);
    const maxY = Math.max(inset, currentCanvasHeight - inset);

    return {
        x: Math.min(maxX, Math.max(inset, point.x)),
        y: Math.min(maxY, Math.max(inset, point.y))
    };
}

function appendClampedResizeHandle(surface, displayScale, handle, point, onStart) {
    if (!isResizeHandleOutsideCanvas(point)) return;

    const clamped = getClampedResizeHandlePoint(point, displayScale);
    const node = document.createElement('div');
    node.className = `image-resize-clamped-handle ${handle}`;
    node.dataset.handle = handle;
    node.style.left = `${clamped.x * displayScale}px`;
    node.style.top = `${clamped.y * displayScale}px`;

    node.onmousedown = (event) => {
        onStart(event, handle);
    };

    surface.appendChild(node);
}

function appendClampedResizeHandles(surface, displayScale, bounds, onStart) {
    if (!bounds) return;

    ['tl', 't', 'tr', 'r', 'br', 'b', 'bl', 'l'].forEach((handle) => {
        appendClampedResizeHandle(
            surface,
            displayScale,
            handle,
            getResizeHandleCanvasPoint(bounds, handle),
            onStart
        );
    });
}

function renderClampedImageResizeHandles(surface, displayScale) {
    if (!isImageResizeMode) return;

    const selectedTransformLayers = getSelectedTransformLayers();

    if (selectedTransformLayers.length >= 2) {
        appendClampedResizeHandles(
            surface,
            displayScale,
            getTransformLayerBounds(selectedTransformLayers),
            (event, handle) => startMultiImageResizeDrag(event, handle)
        );
        return;
    }

    const layer = getActiveTransformLayerOrNull();
    if (!isResizableCanvasLayer(layer)) return;

    appendClampedResizeHandles(
        surface,
        displayScale,
        getResizeBoundsForLayer(layer),
        (event, handle) => startImageResizeDrag(event, layer.id, handle)
    );
}

function renderMultiLayerTransformOverlay(surface, displayScale) {
    const layers = getSelectedTransformLayers();

    if (layers.length < 2) return;

    const bounds = getTransformLayerBounds(layers);
    if (!bounds) return;

    const box = document.createElement('div');
    box.className = [
        'multi-layer-transform-box',
        isLayerMoveMode ? 'move-mode' : '',
        isImageResizeMode ? 'resize-mode' : ''
    ].filter(Boolean).join(' ');

    box.style.left = `${bounds.x * displayScale}px`;
    box.style.top = `${bounds.y * displayScale}px`;
    box.style.width = `${bounds.width * displayScale}px`;
    box.style.height = `${bounds.height * displayScale}px`;

    box.innerHTML = `
        <div class="multi-layer-transform-label">${layers.length}개 레이어</div>
    `;

    if (isLayerMoveMode) {
        box.onpointerdown = (event) => {
            event.stopPropagation();
        };

        box.onmousedown = (event) => {
            startMultiLayerMoveDrag(event);
        };
    }

    if (isImageResizeMode) {
        appendMultiLayerResizeHandles(box);
    }

    surface.appendChild(box);
}

function appendMultiLayerResizeHandles(box) {
    ['tl', 't', 'tr', 'r', 'br', 'b', 'bl', 'l'].forEach((handle) => {
        const node = document.createElement('div');
        node.className = `image-resize-handle ${handle}`;
        node.dataset.handle = handle;

        node.onmousedown = (event) => {
            startMultiImageResizeDrag(event, handle);
        };

        box.appendChild(node);
    });
}

function renderPinnedReferencePanel() {
    const stage = el('canvasStage');
    if (!stage) return;

    const oldPanel = stage.querySelector('.canvas-pinned-reference-panel');
    if (oldPanel) oldPanel.remove();

    const layer = getPinnedReferenceLayer();

    stage.classList.toggle('has-pinned-reference', Boolean(layer));

    if (!layer || !layer.src) return;

    normalizeImageLayerGeometry(layer);

    const originalWidth = Math.round(Number(layer.imageWidth || layer.layerWidth || 1));
    const originalHeight = Math.round(Number(layer.imageHeight || layer.layerHeight || 1));

    const width = Math.max(32, Math.round(Number(layer.pinnedWidth || 240)));
    const height = Math.max(32, Math.round(Number(layer.pinnedHeight || 720)));

    const panelOffsetX = Number(layer.pinnedPanelOffsetX || 0);
    const panelOffsetY = Number(layer.pinnedPanelOffsetY || 0);

    const uiX = Number(layer.pinnedUiX ?? 8);
    const uiY = Number(layer.pinnedUiY ?? 8);
    const uiLocked = Boolean(layer.pinnedUiLocked);

    const uiInverseX = -panelOffsetX;
    const uiInverseY = -panelOffsetY;

    const scaleText = originalWidth
        ? `${((width / originalWidth) * 100).toFixed(1)}%`
        : '-';

    const panel = document.createElement('div');
    panel.className = 'canvas-pinned-reference-panel';
    panel.style.transform = `translate(${panelOffsetX}px, ${panelOffsetY}px)`;

    panel.innerHTML = `
        <div class="canvas-pinned-reference-body">
            <div class="canvas-pinned-reference-image-wrap"
                 data-layer-id="${layer.id}"
                 style="width:${width}px; height:${height}px;">
                <img src="${escapeHtml(getCanvasLayerDisplaySrc(layer))}" draggable="false" alt="pinned reference">
            </div>
        </div>

        <div class="canvas-pinned-reference-floating-ui ${uiLocked ? 'locked' : ''}"
                style="
                    left:${uiX}px;
                    top:${uiY}px;
                    transform:translate(${uiInverseX}px, ${uiInverseY}px);
                ">
            <div class="canvas-pinned-reference-header">
                <div class="canvas-pinned-reference-title"
                     title="드래그해서 정보창 위치 이동">
                    📌 ${escapeHtml(layer.name || '고정 이미지')}
                </div>

                <button class="canvas-pinned-reference-mini-btn"
                        title="${uiLocked ? '정보창 위치 잠금 해제' : '정보창 위치 잠금'}"
                        onclick="togglePinnedReferenceUiLock(${layer.id})">
                    ${uiLocked ? '🔒' : '🔓'}
                </button>

                <button class="canvas-pinned-reference-close"
                        title="고정 해제"
                        onclick="unpinReferenceLayer(${layer.id})">
                    ×
                </button>
            </div>

            <div class="canvas-pinned-reference-meta">
                원본 ${originalWidth} × ${originalHeight}px · 표시 ${width} × ${height}px · ${scaleText}
            </div>

            <div class="canvas-pinned-reference-actions">
                <button class="secondary" onclick="syncPinnedReferenceToCanvasDisplay(${layer.id})">
                    캔버스 표시 크기 맞춤
                </button>
                <button class="secondary" onclick="resetPinnedReferencePanelPosition(${layer.id})">
                    창 위치 초기화
                </button>
                <button class="secondary" onclick="resetPinnedReferenceUiPosition(${layer.id})">
                    정보창 위치 초기화
                </button>
            </div>
        </div>
    `;

    const wrap = panel.querySelector('.canvas-pinned-reference-image-wrap');
    if (wrap) {
        appendPinnedReferenceResizeHandles(wrap, layer.id);
    }

    // 패널 전체 드래그: 이미지 영역 빈 곳 또는 이미지 자체를 Alt 없이 드래그
    const body = panel.querySelector('.canvas-pinned-reference-body');
    if (body) {
        body.onmousedown = (event) => {
            if (event.target.closest('.image-resize-handle')) return;
            if (event.target.closest('.canvas-pinned-reference-floating-ui')) return;

            startPinnedReferencePanelDrag(event, layer.id);
        };
    }

    // 정보창 드래그: 제목 부분을 드래그
    const title = panel.querySelector('.canvas-pinned-reference-title');
    if (title) {
        title.onmousedown = (event) => {
            startPinnedReferenceUiDrag(event, layer.id);
        };
    }

    const surface = el('canvasSurface');

    if (surface && surface.parentElement === stage) {
        stage.insertBefore(panel, surface);
    } else {
        stage.insertBefore(panel, stage.firstChild);
    }
}

function startPinnedReferenceResizeDrag(event, layerId, handle) {
    const found = findCanvasLayer(layerId);
    const layer = found?.layer;

    if (!layer || layer.type !== 'image' || !layer.pinnedReference) return;

    event.preventDefault();
    event.stopPropagation();

    const width = Math.max(32, Number(layer.pinnedWidth || 240));
    const height = Math.max(32, Number(layer.pinnedHeight || 720));

    activePinnedReferenceResizeDrag = {
        layerId: layer.id,
        handle,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startWidth: width,
        startHeight: height,
        aspectRatio: Math.max(0.0001, width / height)
    };
}

function handlePinnedReferenceResizeMouseMove(event) {
    if (!activePinnedReferenceResizeDrag) return;

    const found = findCanvasLayer(activePinnedReferenceResizeDrag.layerId);
    const layer = found?.layer;

    if (!layer || layer.type !== 'image') return;

    const drag = activePinnedReferenceResizeDrag;
    const handle = drag.handle;

    const fineMode = Boolean(el('imageResizeFineMode')?.checked) || event.altKey;
    const factor = fineMode ? 0.2 : 1;

    const dx = (event.clientX - drag.startClientX) * factor;
    const dy = (event.clientY - drag.startClientY) * factor;

    let nextWidth = drag.startWidth;
    let nextHeight = drag.startHeight;

    if (handle.includes('r')) nextWidth = drag.startWidth + dx;
    if (handle.includes('l')) nextWidth = drag.startWidth - dx;
    if (handle.includes('b')) nextHeight = drag.startHeight + dy;
    if (handle.includes('t')) nextHeight = drag.startHeight - dy;

    const keepRatio = Boolean(el('imageResizeRatioLock')?.checked) && !event.shiftKey;

    if (keepRatio) {
        const ratio = drag.aspectRatio;

        if (handle.length === 2) {
            const widthDelta = Math.abs(nextWidth - drag.startWidth);
            const heightDelta = Math.abs(nextHeight - drag.startHeight);

            if (widthDelta >= heightDelta) {
                nextHeight = nextWidth / ratio;
            } else {
                nextWidth = nextHeight * ratio;
            }
        }

        if (handle === 'l' || handle === 'r') {
            nextHeight = nextWidth / ratio;
        }

        if (handle === 't' || handle === 'b') {
            nextWidth = nextHeight * ratio;
        }
    }

    layer.pinnedWidth = Math.max(32, Math.round(nextWidth));
    layer.pinnedHeight = Math.max(32, Math.round(nextHeight));

    renderPinnedReferencePanel();
}

function handlePinnedReferenceResizeMouseUp() {
    if (!activePinnedReferenceResizeDrag) return;

    activePinnedReferenceResizeDrag = null;
    saveCanvasState();
}

function startPinnedReferencePanelDrag(event, layerId) {
    const found = findCanvasLayer(layerId);
    const layer = found?.layer;

    if (!layer || layer.type !== 'image' || !layer.pinnedReference) return;

    event.preventDefault();
    event.stopPropagation();

    activePinnedReferencePanelDrag = {
        layerId: layer.id,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startOffsetX: Number(layer.pinnedPanelOffsetX || 0),
        startOffsetY: Number(layer.pinnedPanelOffsetY || 0)
    };

    document.body.classList.add('dragging-pinned-reference');
}

function handlePinnedReferencePanelMouseMove(event) {
    if (!activePinnedReferencePanelDrag) return;

    const found = findCanvasLayer(activePinnedReferencePanelDrag.layerId);
    const layer = found?.layer;

    if (!layer || layer.type !== 'image' || !layer.pinnedReference) return;

    const dx = event.clientX - activePinnedReferencePanelDrag.startClientX;
    const dy = event.clientY - activePinnedReferencePanelDrag.startClientY;

    layer.pinnedPanelOffsetX = Math.round(activePinnedReferencePanelDrag.startOffsetX + dx);
    layer.pinnedPanelOffsetY = Math.round(activePinnedReferencePanelDrag.startOffsetY + dy);

    renderPinnedReferencePanel();
}

function handlePinnedReferencePanelMouseUp() {
    if (!activePinnedReferencePanelDrag) return;

    activePinnedReferencePanelDrag = null;
    document.body.classList.remove('dragging-pinned-reference');
    saveCanvasState();
}

function resetPinnedReferencePanelPosition(layerId) {
    const found = findCanvasLayer(layerId);
    const layer = found?.layer;

    if (!layer || layer.type !== 'image') return;

    layer.pinnedPanelOffsetX = 0;
    layer.pinnedPanelOffsetY = 0;

    renderPinnedReferencePanel();
    saveCanvasState();
}

function startPinnedReferenceMoveDrag(event, layerId) {
    const found = findCanvasLayer(layerId);
    const layer = found?.layer;

    if (!layer || layer.type !== 'image' || !layer.pinnedReference) return;

    event.preventDefault();
    event.stopPropagation();

    activePinnedReferenceMoveDrag = {
        layerId: layer.id,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startOffsetX: Number(layer.pinnedOffsetX || 0),
        startOffsetY: Number(layer.pinnedOffsetY || 0)
    };

    const wrap = event.currentTarget;
    if (wrap) wrap.classList.add('dragging-reference');
}

function handlePinnedReferenceMoveMouseMove(event) {
    if (!activePinnedReferenceMoveDrag) return;

    const found = findCanvasLayer(activePinnedReferenceMoveDrag.layerId);
    const layer = found?.layer;

    if (!layer || layer.type !== 'image' || !layer.pinnedReference) return;

    const dx = event.clientX - activePinnedReferenceMoveDrag.startClientX;
    const dy = event.clientY - activePinnedReferenceMoveDrag.startClientY;

    layer.pinnedOffsetX = Math.round(activePinnedReferenceMoveDrag.startOffsetX + dx);
    layer.pinnedOffsetY = Math.round(activePinnedReferenceMoveDrag.startOffsetY + dy);

    renderPinnedReferencePanel();
}

function handlePinnedReferenceMoveMouseUp() {
    if (!activePinnedReferenceMoveDrag) return;

    activePinnedReferenceMoveDrag = null;
    saveCanvasState();
}

function syncPinnedReferenceToCanvasDisplay(layerId) {
    const found = findCanvasLayer(layerId);
    const layer = found?.layer;

    if (!layer || layer.type !== 'image') return;

    const imageWidth = Number(layer.imageWidth || layer.layerWidth || 1);
    const imageHeight = Number(layer.imageHeight || layer.layerHeight || 1);
    const displayScale = getCanvasDisplayScale();

    layer.pinnedWidth = Math.max(32, Math.round(imageWidth * displayScale));
    layer.pinnedHeight = Math.max(32, Math.round(imageHeight * displayScale));

    // 이미지 내부 이동값은 더 이상 쓰지 않음
    layer.pinnedOffsetX = 0;
    layer.pinnedOffsetY = 0;

    renderPinnedReferencePanel();
    saveCanvasState();
}

function resetPinnedReferenceOffset(layerId) {
    const found = findCanvasLayer(layerId);
    const layer = found?.layer;

    if (!layer || layer.type !== 'image') return;

    layer.pinnedOffsetX = 0;
    layer.pinnedOffsetY = 0;

    renderPinnedReferencePanel();
    saveCanvasState();
}

function appendPinnedReferenceResizeHandles(wrap, layerId) {
    ['tl', 't', 'tr', 'r', 'br', 'b', 'bl', 'l'].forEach((handle) => {
        const node = document.createElement('div');
        node.className = `image-resize-handle ${handle}`;
        node.dataset.handle = handle;

        node.onmousedown = (event) => {
            startPinnedReferenceResizeDrag(event, layerId, handle);
        };

        wrap.appendChild(node);
    });
}

function appendImageResizeHandles(layerEl, layerId) {
    ['tl', 't', 'tr', 'r', 'br', 'b', 'bl', 'l'].forEach((handle) => {
        const node = document.createElement('div');
        node.className = `image-resize-handle ${handle}`;
        node.dataset.handle = handle;

        node.onmousedown = (event) => {
            startImageResizeDrag(event, layerId, handle);
        };

        layerEl.appendChild(node);
    });
}

function startSelectionMoveFromCanvasEvent(event, layer) {
    if (!layer || layer.type !== 'selection' || event.button !== 0) return;

    if (event.shiftKey) {
        selectCanvasLayer(layer.id, event);
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (!isLayerMultiSelected(layer.id)) {
        selectedLayerIds.clear();
        selectedLayerIds.add(Number(layer.id));
    }

    activeLayerId = layer.id;
    checkedSelectionId = layer.id;
    activeClipSelectionId = layer.id;

    const requiresLayerMoveMode = selectionRequiresLayerMoveMode(layer);

    renderLayerList();

    if (requiresLayerMoveMode && !isLayerMoveMode) {
        renderCanvasLayersOnSurface();
        updateSelectionHoverCursor(event);
        return;
    }

    if (isLayerMoveMode && getSelectedTransformLayers().length >= 2) {
        startMultiLayerMoveDrag(event);
        return;
    }

    startSelectionMoveDrag(event, layer.id);
}

function renderCanvasLayerStack(layers, surface, displayScale, parentSelection = null) {
    // 배열 앞쪽이 위 레이어이므로, 화면에는 아래 레이어부터 먼저 그림
    [...layers].reverse().forEach((layer) => {
        if (!layer.visible) return;

        if (layer.type === 'folder') {
            layer.children = Array.isArray(layer.children) ? layer.children : [];
            renderCanvasLayerStack(layer.children, surface, displayScale, parentSelection);
            return;
        }

        if (layer.type === 'selection') {
            layer.children = Array.isArray(layer.children) ? layer.children : [];
            normalizeSelectionAreaGeometry(layer);

            // 선택 영역 안의 자식 레이어/인페인팅 결과는 계속 렌더링
            renderCanvasLayerStack(layer.children, surface, displayScale, layer);

            // 체크 안 된 선택 영역은 표시 상태여도 점선 박스/핸들을 그리지 않음
            if (isSelectionOverlayHidden || !isSelectionChecked(layer.id)) {
                return;
            }

            const selectionEl = document.createElement('div');
            selectionEl.className = [
                'canvas-render-layer',
                'selection-area-layer',
                layer.id === activeLayerId ? 'active-selection' : '',
                isLayerMultiSelected(layer.id) ? 'multi-selected' : '',
                canMoveActiveSelection(layer) ? 'selection-can-move' : 'selection-locked-move'
            ].filter(Boolean).join(' ');

            selectionEl.dataset.layerId = String(layer.id);

            setCanvasLayerNodePosition(selectionEl, layer.x, layer.y, displayScale);
            selectionEl.style.width = `${layer.layerWidth * displayScale}px`;
            selectionEl.style.height = `${layer.layerHeight * displayScale}px`;
            selectionEl.style.transform += ` rotate(${CanvasSelectionRotation.angle(layer.rotation)}deg)`;
            selectionEl.style.setProperty('--selection-rotate-size', `${Math.max(12, Math.min(36, Math.min(layer.layerWidth, layer.layerHeight) * displayScale - 24))}px`);

            selectionEl.oncontextmenu = (event) => {
                openCanvasSelectionContextMenu(event, layer.id);
            };

            selectionEl.innerHTML = `
                <div class="selection-move-zone" title="선택 영역 이동"></div>
                ${getEditableClipForSelection(layer) ? '' : '<button type="button" class="selection-rotate-handle" title="가운데를 잡고 드래그하여 선택 영역 회전" aria-label="선택 영역 회전"></button>'}
                <div class="selection-resize-handle tl" data-handle="tl" title="크기 조절"></div>
                <div class="selection-resize-handle tr" data-handle="tr" title="크기 조절"></div>
                <div class="selection-resize-handle bl" data-handle="bl" title="크기 조절"></div>
                <div class="selection-resize-handle br" data-handle="br" title="크기 조절"></div>
            `;

            const moveZone = selectionEl.querySelector('.selection-move-zone');
            const rotateHandle = selectionEl.querySelector('.selection-rotate-handle');
            if (rotateHandle) rotateHandle.onmousedown = (event) => startSelectionRotateDrag(event, layer.id);
            if (moveZone) {
                moveZone.onmousedown = (event) => {
                    startSelectionMoveFromCanvasEvent(event, layer);
                };
            }

            selectionEl.querySelectorAll('.selection-resize-handle').forEach((handle) => {
                handle.onmousedown = (event) => startSelectionResizeDrag(event, layer.id, handle.dataset.handle);
            });

            surface.appendChild(selectionEl);
            return;
        }

        if (layer.type === 'clip') {
            if (!layer.renderOnCanvas || !layer.src) {
                return;
            }

            const layerEl = document.createElement('div');
            layerEl.className = 'canvas-render-layer image-layer';
            layerEl.dataset.layerId = String(layer.id);

            setCanvasLayerNodePosition(layerEl, layer.x, layer.y, displayScale);
            layerEl.style.width = `${layer.layerWidth * displayScale}px`;
            layerEl.style.height = `${layer.layerHeight * displayScale}px`;

            layerEl.style.transform += ` rotate(${CanvasSelectionRotation.angle(layer.rotation)}deg)`;

            layerEl.onmousedown = (event) => {
                if (isImageResizeMode) {
                    event.preventDefault();
                    event.stopPropagation();
                    selectedLayerIds.clear();
                    selectedLayerIds.add(Number(layer.id));
                    activeLayerId = layer.id;
                    renderLayerList();
                    renderCanvasLayersOnSurface();
                    return;
                }

                if (parentSelection) {
                    startSelectionMoveFromCanvasEvent(event, parentSelection);
                }
            };

            layerEl.oncontextmenu = (event) => {
                openCanvasImageLayerContextMenu(event, layer.id);
            };

            const img = document.createElement('img');
            img.src = getCanvasLayerDisplaySrc(layer);
            img.alt = layer.name || 'inpaint result';
            img.draggable = false;

            layerEl.appendChild(img);

            if (isLayerMultiSelected(layer.id)) {
                layerEl.classList.add('multi-selected');
            }

            if (isImageResizeMode && Number(layer.id) === Number(activeLayerId)) {
                layerEl.classList.add('resize-active');
                appendImageResizeHandles(layerEl, layer.id);
            }

            surface.appendChild(layerEl);
            return;
        }

        const layerEl = document.createElement('div');
        layerEl.className = 'canvas-render-layer';
        layerEl.dataset.layerId = String(layer.id);

        if (layer.type === 'canvas') {
            return;
        }

        if (layer.type === 'image' && layer.src) {
            if (layer.pinnedReference) {
                return;
            }

            normalizeImageLayerGeometry(layer);

            layerEl.classList.add('image-layer');

            if (layer.id === activeLayerId && isLayerMoveMode) {
                layerEl.classList.add('is-active-moving');
            }

            setCanvasLayerNodePosition(layerEl, layer.x, layer.y, displayScale);
            layerEl.style.width = `${layer.layerWidth * displayScale}px`;
            layerEl.style.height = `${layer.layerHeight * displayScale}px`;

            layerEl.onmousedown = (event) => {
                if (event.shiftKey) {
                    selectCanvasLayer(layer.id, event);
                    return;
                }

                if (!isLayerMultiSelected(layer.id)) {
                    selectedLayerIds.clear();
                    selectedLayerIds.add(Number(layer.id));
                }

                activeLayerId = layer.id;
                renderLayerList();

                if (isLayerMoveMode) {
                    startLayerMoveDrag(event, layer.id);
                }
            };

            const img = document.createElement('img');
            img.src = getCanvasLayerDisplaySrc(layer);
            img.alt = layer.name || 'canvas layer';
            img.draggable = false;

            layerEl.appendChild(img);

            const selectedTransformLayers = getSelectedTransformLayers();

            if (isLayerMultiSelected(layer.id)) {
                layerEl.classList.add('multi-selected');
            }

            if (isImageResizeMode && selectedTransformLayers.length < 2 && Number(layer.id) === Number(activeLayerId)) {
                layerEl.classList.add('resize-active');
                appendImageResizeHandles(layerEl, layer.id);
            }

            surface.appendChild(layerEl);
        }
    });
}

function addCanvasBaseLayer(width, height) {
    const layer = {
        id: layerIdSeq++,
        name: `캔버스 ${width}×${height}`,
        visible: true,
        type: 'canvas',
        src: '',
        canvasWidth: width,
        canvasHeight: height
    };

    // 캔버스 레이어는 배경 역할이므로 맨 아래에 추가
    canvasLayers.push(layer);

    // 현재 선택 레이어가 없을 때만 캔버스를 선택
    if (!activeLayerId) {
        activeLayerId = layer.id;
    }
}

function openCanvasImageLayerContextMenu(event, layerId) {
    event.preventDefault();
    event.stopPropagation();

    contextImageLayerId = layerId;

    const menu = el('canvasImageLayerContextMenu');
    if (!menu) return;

    const found = findCanvasLayer(layerId);
    const layer = found?.layer;

    const pinBtn = el('canvasPinImageLayerBtn');
    if (pinBtn && layer) {
        pinBtn.innerText = layer.pinnedReference ? '고정 해제' : '고정';
    }

    menu.style.display = 'block';

    const margin = 12;
    const menuWidth = menu.offsetWidth || 180;
    const menuHeight = menu.offsetHeight || 100;

    const left = Math.min(event.clientX, window.innerWidth - menuWidth - margin);
    const top = Math.min(event.clientY, window.innerHeight - menuHeight - margin);

    menu.style.left = `${Math.max(margin, left)}px`;
    menu.style.top = `${Math.max(margin, top)}px`;
}

function closeCanvasImageLayerContextMenu() {
    const menu = el('canvasImageLayerContextMenu');
    if (menu) menu.style.display = 'none';
}

async function fitCanvasSizeToContextImageLayer() {
    closeCanvasImageLayerContextMenu();

    const found = findCanvasLayer(contextImageLayerId);
    const layer = found?.layer;
    if (!layer || layer.type !== 'image' || !layer.src) return;

    let width = parseInt(layer.imageWidth, 10);
    let height = parseInt(layer.imageHeight, 10);

    if (!width || !height) {
        try {
            const info = await loadImageInfo(layer.src);
            width = info.width;
            height = info.height;
            layer.imageWidth = width;
            layer.imageHeight = height;
        } catch (error) {
            alert(`이미지 크기를 읽을 수 없습니다: ${error.message || error}`);
            return;
        }
    }

    fitCanvasSizeToImageLayer(layer, width, height);
}

function canUseLayerAsDetailSource(layer) {
    return Boolean(layer && (layer.type === 'image' || layer.type === 'clip') && layer.src);
}

async function getLayerDetailSource(layer) {
    if (!canUseLayerAsDetailSource(layer)) {
        return null;
    }

    let width = parseInt(layer.imageWidth || layer.layerWidth, 10);
    let height = parseInt(layer.imageHeight || layer.layerHeight, 10);

    if (!width || !height) {
        const info = await loadImageInfo(layer.src);
        width = info.width;
        height = info.height;
        layer.imageWidth = width;
        layer.imageHeight = height;
    }

    if (!width || !height) {
        return null;
    }

    return {
        src: layer.src,
        width,
        height,
        promptInfo: normalizeReferenceGenPromptInfo(layer.promptInfo || {}),
        sourceLayerId: layer.id,
        sourceLayerName: layer.name || '',
        sourceLayerType: layer.type
    };
}

async function openOriginalLayerDetailEditor() {
    closeCanvasImageLayerContextMenu();

    const found = findCanvasLayer(contextImageLayerId);
    const layer = found?.layer;

    if (!canUseLayerAsDetailSource(layer)) {
        alert('디테일을 적용할 이미지 또는 클립 레이어를 찾을 수 없습니다.');
        return;
    }

    try {
        const detailSource = await getLayerDetailSource(layer);

        if (!detailSource) {
            alert('디테일을 적용할 이미지 크기를 읽을 수 없습니다.');
            return;
        }

        referenceGenSession = {
            width: detailSource.width,
            height: detailSource.height,
            originalSrc: detailSource.src,
            currentSrc: detailSource.src,
            detailSourceSrc: detailSource.src,
            resultSrc: '',
            promptInfo: detailSource.promptInfo,
            maskDataUrl: '',
            sourceLayerId: detailSource.sourceLayerId,
            sourceLayerName: detailSource.sourceLayerName,
            sourceLayerType: layer.type,
            mode: 'original-detail',
            createdAt: Date.now()
        };

        referenceGenTool = 'brush';
        referenceGenBrushSize = 96;
        referenceGenMaskVisible = true;
        referenceGenPainting = false;
        referenceGenLastPoint = null;
        referenceGenLastPointerEvent = null;

        openReferenceGenLayer();
        showReferenceGenToast('원본 이미지에서 디테일 영역을 선택할 수 있습니다.');

    } catch (error) {
        alert(`원본 디테일 편집을 열 수 없습니다: ${error.message || error}`);
    }
}

function forEachCanvasLayerDeep(layers, callback) {
    (layers || []).forEach((layer) => {
        callback(layer);

        if (Array.isArray(layer.children)) {
            forEachCanvasLayerDeep(layer.children, callback);
        }
    });
}

function getPinnedReferenceLayer() {
    let pinned = null;

    forEachCanvasLayerDeep(canvasLayers, (layer) => {
        if (!pinned && layer?.type === 'image' && layer.pinnedReference) {
            pinned = layer;
        }
    });

    return pinned;
}

function getDefaultPinnedReferenceSize(layer) {
    const imageWidth = Number(layer.imageWidth || layer.layerWidth || 1);
    const imageHeight = Number(layer.imageHeight || layer.layerHeight || 1);

    const displayScale = getCanvasDisplayScale();

    // 원본 이미지가 현재 캔버스와 같은 크기라면,
    // 고정 레퍼런스도 중앙 캔버스의 화면 표시 배율과 맞춘다.
    if (
        currentCanvasWidth &&
        currentCanvasHeight &&
        displayScale &&
        Math.abs(imageWidth - currentCanvasWidth) <= 1 &&
        Math.abs(imageHeight - currentCanvasHeight) <= 1
    ) {
        return {
            width: Math.max(32, Math.round(imageWidth * displayScale)),
            height: Math.max(32, Math.round(imageHeight * displayScale))
        };
    }

    const ratio = imageWidth / Math.max(1, imageHeight);

    const maxWidth = 300;
    const maxHeight = Math.max(360, window.innerHeight - 240);

    let width = maxWidth;
    let height = width / Math.max(0.0001, ratio);

    if (height > maxHeight) {
        height = maxHeight;
        width = height * ratio;
    }

    return {
        width: Math.max(32, Math.round(width)),
        height: Math.max(32, Math.round(height))
    };
}

function togglePinnedContextImageLayer() {
    closeCanvasImageLayerContextMenu();

    const found = findCanvasLayer(contextImageLayerId);
    const layer = found?.layer;

    if (!layer || layer.type !== 'image' || !layer.src) return;

    if (layer.pinnedReference) {
        unpinReferenceLayer(layer.id);
        return;
    }

    pinReferenceLayer(layer.id);
}

async function matchClipPromptToContextImageLayer() {
    closeCanvasImageLayerContextMenu();

    const found = findCanvasLayer(contextImageLayerId);
    const layer = found?.layer;

    if (!layer || layer.type !== 'image') {
        alert('프롬프트를 가져올 이미지 레이어를 찾을 수 없습니다.');
        return;
    }

    try {
        let promptInfo = normalizePromptInfo(layer.promptInfo || {});

        // 이미지 레이어 안에 promptInfo가 비어 있으면 sourcePath로 원본 이미지 메타데이터를 다시 읽는다.
        if (!hasAnyPromptText(promptInfo) && layer.sourcePath) {
            const fetched = await fetchPromptInfoByPath(layer.sourcePath);

            if (hasAnyPromptText(fetched)) {
                promptInfo = normalizePromptInfo(fetched);
                layer.promptInfo = promptInfo;
            }
        }

        if (!hasAnyPromptText(promptInfo)) {
            alert(
                '이 이미지 레이어에서 프롬프트를 찾지 못했습니다.\n' +
                '이미지 레이어에 promptInfo가 있거나 sourcePath로 원본 메타데이터를 읽을 수 있어야 합니다.'
            );
            return;
        }

        const promptControlGroups = Array.isArray(layer.promptControlGroups)
            ? structuredClone(layer.promptControlGroups)
            : [];

        /*
            중요:
            기존 OFF 제어그룹이 새 프롬프트에 엉뚱하게 적용되지 않도록,
            이미지 레이어의 제어그룹이 없으면 공용 제어그룹도 비운다.
        */
        sharedSelectionClipPromptInfo = structuredClone(promptInfo);
        sharedSelectionClipPromptControlGroups = structuredClone(promptControlGroups);

        // 혹시 remember 함수 쪽에 추가 처리 로직이 있으면 같이 태운다.
        if (typeof rememberSharedSelectionClipPrompt === 'function') {
            rememberSharedSelectionClipPrompt(promptInfo, promptControlGroups);
        }

        // 현재 존재하는 모든 선택 영역 클립에 공용 프롬프트 재적용
        if (typeof migrateAllSelectionClipsToSharedPromptOwner === 'function') {
            migrateAllSelectionClipsToSharedPromptOwner();
        }

        if (typeof syncAllPromptCopiesFromOwners === 'function') {
            syncAllPromptCopiesFromOwners();
        }

        refreshOpenClipPromptModalAfterPromptMatch(promptInfo, promptControlGroups);

        renderLayerList();
        renderCanvasLayersOnSurface();
        saveCanvasState();

        showCanvasPromptMatchMessage('이미지 레이어의 프롬프트로 맞췄습니다.');

    } catch (error) {
        alert(`프롬프트 맞춤 실패: ${error.message || error}`);
    }
}

function refreshOpenClipPromptModalAfterPromptMatch(promptInfo, promptControlGroups = []) {
    const modal = el('clipPromptModalOverlay');

    if (!modal || !modal.classList.contains('open')) {
        return;
    }

    const info = normalizePromptInfo(promptInfo || {});
    const generationInfo = typeof CanvasInpaintSettings !== 'undefined'
        ? CanvasInpaintSettings.apply(info)
        : info;

    setClipPromptEditorValue('base', info.basePrompt || '');
    setClipPromptEditorValue('negative', info.negativePrompt || '');
    setClipCharPromptValues(info.charPrompts || info.charPrompt || '');

    setGenerationSettings('clip', generationInfo);
    setClipPromptInputValueIfExists('clipCfgInput', generationInfo.cfg || generationInfo.scale || 6);
    setClipPromptInputValueIfExists('clipStrengthInput', generationInfo.strength ?? 0.65);
    setClipPromptInputValueIfExists('clipNoiseInput', generationInfo.noise ?? 0.2);
    setClipPromptInputValueIfExists('clipSeedInput', generationInfo.seed ?? -1);

    const owner = getActiveClipForPromptControl();

    if (owner) {
        owner.promptInfo = normalizePromptInfo(info);
        owner.promptControlGroups = Array.isArray(promptControlGroups)
            ? structuredClone(promptControlGroups)
            : [];

        renderClipPromptControlGroups(owner);
    }

    renderAllClipPromptTokens();
}

function setClipPromptInputValueIfExists(id, value) {
    const node = el(id);
    if (node) {
        node.value = value;
    }
}

function showCanvasPromptMatchMessage(message) {
    if (typeof showToast === 'function') {
        showToast(message);
        return;
    }

    console.log(message);
}

function pinReferenceLayer(layerId) {
    const found = findCanvasLayer(layerId);
    const layer = found?.layer;

    if (!layer || layer.type !== 'image') return;

    // 우선 1개만 고정. 다른 고정 이미지는 해제.
    forEachCanvasLayerDeep(canvasLayers, (item) => {
        if (item?.type === 'image') {
            item.pinnedReference = false;
        }
    });

    normalizeImageLayerGeometry(layer);

    layer.pinnedReference = true;

    if (!layer.pinnedWidth || !layer.pinnedHeight) {
        const size = getDefaultPinnedReferenceSize(layer);
        layer.pinnedWidth = size.width;
        layer.pinnedHeight = size.height;
    }

    pinnedReferenceLayerId = layer.id;

    // 고정한 이미지는 중앙 캔버스에서 편집 대상이 아니므로 active 해제
    if (Number(activeLayerId) === Number(layer.id)) {
        activeLayerId = null;
    }

    renderLayerList();
    renderCanvasLayersOnSurface();
    saveCanvasState();
}

function unpinReferenceLayer(layerId) {
    const found = findCanvasLayer(layerId);
    const layer = found?.layer;

    if (layer && layer.type === 'image') {
        layer.pinnedReference = false;
    }

    if (Number(pinnedReferenceLayerId) === Number(layerId)) {
        pinnedReferenceLayerId = null;
    }

    renderLayerList();
    renderCanvasLayersOnSurface();
    saveCanvasState();
}

function fitCanvasSizeToImageLayer(layer, width, height) {
    currentCanvasWidth = width;
    currentCanvasHeight = height;

    const widthInput = el('canvasWidthInput');
    const heightInput = el('canvasHeightInput');

    if (widthInput) widthInput.value = width;
    if (heightInput) heightInput.value = height;

    updateCanvasBaseLayer(width, height);

    renderCanvas(width, height);
    renderLayerList();
    updateCanvasRatioInfo();
    saveCanvasState();
}

function updateCanvasBaseLayer(width, height) {
    const baseLayer = [...canvasLayers].reverse().find((layer) => layer.type === 'canvas');

    if (baseLayer) {
        baseLayer.name = `캔버스 ${width}×${height}`;
        baseLayer.canvasWidth = width;
        baseLayer.canvasHeight = height;
        return;
    }

    addCanvasBaseLayer(width, height);
}

function toggleLayerMoveMode() {
    if (!isLayerMoveMode && typeof setCanvasLayerEraserEnabled === 'function') setCanvasLayerEraserEnabled(false);
    isLayerMoveMode = !isLayerMoveMode;
    activeLayerDrag = null;

    const btn = el('layerMoveToolBtn');
    const hint = el('layerMoveToolHint');
    const surface = el('canvasSurface');

    if (btn) btn.classList.toggle('active', isLayerMoveMode);
    if (surface) surface.classList.toggle('move-mode', isLayerMoveMode);

    if (hint) {
        hint.innerText = isLayerMoveMode
            ? '레이어를 드래그하거나 방향키로 이동하세요. Shift를 누르면 큰 간격으로 이동합니다.'
            : '이동 버튼을 켜고 레이어를 드래그하거나 방향키로 이동하세요.';
    }

    renderCanvasLayersOnSurface();
    updateSelectionHoverCursor();
}

function toggleImageResizeMode() {
    if (!isImageResizeMode && typeof setCanvasLayerEraserEnabled === 'function') setCanvasLayerEraserEnabled(false);
    isImageResizeMode = !isImageResizeMode;
    activeImageResizeDrag = null;
    hideImageResizeGuideOverlay();

    if (isImageResizeMode && isCanvasResizeMode) {
        setCanvasResizeMode(false);
    }

    if (isImageResizeMode && isLayerMoveMode) {
        isLayerMoveMode = false;

        const moveBtn = el('layerMoveToolBtn');
        const moveHint = el('layerMoveToolHint');
        const surface = el('canvasSurface');

        if (moveBtn) moveBtn.classList.remove('active');
        if (surface) surface.classList.remove('move-mode');

        if (moveHint) {
            moveHint.innerText = '이동 버튼을 켠 뒤 캔버스 위 이미지 레이어를 드래그하세요.';
        }
    }

    const btn = el('imageResizeToolBtn');
    const hint = el('imageResizeToolHint');
    const surface = el('canvasSurface');

    if (btn) btn.classList.toggle('active', isImageResizeMode);
    if (surface) surface.classList.toggle('image-resize-mode', isImageResizeMode);

    if (hint) {
        hint.innerText = isImageResizeMode
            ? '이미지 레이어의 가장자리/모서리를 드래그해서 크기를 조절하세요. Alt = 세밀 조절, Shift = 비율 유지 해제.'
            : '버튼을 켠 뒤 이미지 레이어를 선택하고 가장자리/모서리를 드래그하세요.';
    }

    renderCanvasLayersOnSurface();
}

function getCanvasFitScale(width, height) {
    const workspace = document.querySelector('.canvas-workspace');
    const padding = window.CanvasWorkspaceBridge?.isPane ? 48 : 120;

    const minimum = window.CanvasWorkspaceBridge?.isPane ? 40 : 200;
    const availableWidth = Math.max(minimum, (workspace?.clientWidth || window.innerWidth) - padding);
    const availableHeight = Math.max(minimum, (workspace?.clientHeight || window.innerHeight) - padding);

    return Math.min(
        availableWidth / Math.max(1, width),
        availableHeight / Math.max(1, height),
        1
    );
}

function setCanvasResizeMode(enabled) {
    if (enabled && typeof setCanvasLayerEraserEnabled === 'function') setCanvasLayerEraserEnabled(false);
    isCanvasResizeMode = Boolean(enabled);
    activeCanvasResizeDrag = null;

    const btn = el('canvasResizeToolBtn');
    const hint = el('canvasResizeToolHint');
    const surface = el('canvasSurface');

    if (btn) btn.classList.toggle('active', isCanvasResizeMode);
    if (surface) surface.classList.toggle('canvas-resize-mode', isCanvasResizeMode);

    if (hint) {
        hint.innerText = isCanvasResizeMode
            ? '캔버스 오른쪽/아래쪽/오른쪽 아래 핸들을 드래그하세요. 크기는 64 단위로 맞춰집니다.'
            : '버튼을 켠 뒤 캔버스 오른쪽/아래쪽/오른쪽 아래 핸들을 드래그하세요.';
    }

    if (!isCanvasResizeMode) {
        hideCanvasResizeTooltip();
    }

    renderCanvasLayersOnSurface();
}

function toggleCanvasResizeMode() {
    if (!currentCanvasWidth || !currentCanvasHeight) {
        alert('먼저 캔버스를 생성해 주세요.');
        return;
    }

    const nextEnabled = !isCanvasResizeMode;

    if (nextEnabled && isImageResizeMode) {
        isImageResizeMode = false;
        activeImageResizeDrag = null;
        hideImageResizeGuideOverlay();

        const imageBtn = el('imageResizeToolBtn');
        const imageHint = el('imageResizeToolHint');
        const surface = el('canvasSurface');

        if (imageBtn) imageBtn.classList.remove('active');
        if (surface) surface.classList.remove('image-resize-mode');
        if (imageHint) {
            imageHint.innerText = '버튼을 켠 뒤 이미지 레이어를 선택하고 가장자리/모서리를 드래그하세요.';
        }
    }

    if (nextEnabled && isLayerMoveMode) {
        isLayerMoveMode = false;
        activeLayerDrag = null;

        const moveBtn = el('layerMoveToolBtn');
        const moveHint = el('layerMoveToolHint');
        const surface = el('canvasSurface');

        if (moveBtn) moveBtn.classList.remove('active');
        if (surface) surface.classList.remove('move-mode');
        if (moveHint) {
            moveHint.innerText = '이동 버튼을 켠 뒤 캔버스 위 이미지 레이어를 드래그하세요.';
        }
    }

    setCanvasResizeMode(nextEnabled);
}

function toggleSelectionOverlayVisibility() {
    isSelectionOverlayHidden = !isSelectionOverlayHidden;

    updateSelectionOverlayToggleUI();
    renderCanvasLayersOnSurface();
    saveCanvasState();
}

function updateSelectionOverlayToggleUI() {
    const btn = el('selectionOverlayToggleBtn');
    const hint = el('selectionOverlayHint');

    if (btn) {
        btn.classList.toggle('active', !isSelectionOverlayHidden);
        btn.innerText = isSelectionOverlayHidden
            ? '▣ 영역 숨김'
            : '▣ 영역 표시';
        const label = isSelectionOverlayHidden ? '선택 영역 숨김' : '선택 영역 표시';
        btn.title = label;
        btn.setAttribute('aria-label', label);
    }

    if (hint) {
        hint.innerText = isSelectionOverlayHidden
            ? '선택 영역 박스를 숨긴 상태입니다. 인페인팅 결과만 확인할 수 있습니다.'
            : '선택 영역 박스만 숨기고 인페인팅 결과를 확인합니다.';
    }
}

function getCanvasDisplayScale() {
    const surface = el('canvasSurface');
    if (!surface || !currentCanvasWidth) return 1;

    const displayWidth = surface.clientWidth || parseFloat(surface.style.width) || currentCanvasWidth;
    return displayWidth / currentCanvasWidth;
}

function isResizableCanvasLayer(layer) {
    return Boolean(
        layer &&
        layer.visible !== false &&
        !layer.pinnedReference &&
        (layer.type === 'image' || (layer.type === 'clip' && layer.renderOnCanvas && layer.src))
    );
}

function normalizeResizableLayerGeometry(layer) {
    if (!isResizableCanvasLayer(layer)) return;

    if (layer.type === 'image') {
        normalizeImageLayerGeometry(layer);
        return;
    }

    const fallbackWidth = parseInt(layer.imageWidth, 10) || currentCanvasWidth || 1;
    const fallbackHeight = parseInt(layer.imageHeight, 10) || currentCanvasHeight || 1;
    layer.layerWidth = Math.max(1, Number(layer.layerWidth) || fallbackWidth);
    layer.layerHeight = Math.max(1, Number(layer.layerHeight) || fallbackHeight);
    layer.x = Number.isFinite(Number(layer.x)) ? Number(layer.x) : 0;
    layer.y = Number.isFinite(Number(layer.y)) ? Number(layer.y) : 0;
}

function getActiveImageLayerForResize() {
    const found = findCanvasLayer(activeLayerId);
    const layer = found?.layer;

    if (!isResizableCanvasLayer(layer)) {
        return null;
    }

    normalizeResizableLayerGeometry(layer);
    return layer;
}

function updateImageResizePanel() {
    const panel = el('imageResizePanel');
    const nameNode = el('imageResizeSelectedName');
    const widthInput = el('imageResizeWidthInput');
    const heightInput = el('imageResizeHeightInput');

    if (!panel || !nameNode || !widthInput || !heightInput) return;

    const layer = getActiveImageLayerForResize();

    if (!layer) {
        panel.style.display = 'none';
        return;
    }

    panel.style.display = 'flex';

    const layerLabel = layer.type === 'clip' ? '인페인팅 결과' : '이미지 레이어';
    nameNode.innerText = `${layer.name || layerLabel} · 원본 ${layer.imageWidth || '?'} × ${layer.imageHeight || '?'}px`;

    isSyncingImageResizeInputs = true;
    widthInput.value = Math.round(layer.layerWidth || layer.imageWidth || 1);
    heightInput.value = Math.round(layer.layerHeight || layer.imageHeight || 1);
    isSyncingImageResizeInputs = false;
}

function readImageResizeInputValue(id, fallback) {
    const value = parseInt(el(id)?.value, 10);
    if (!Number.isFinite(value) || value < 1) return fallback;
    return value;
}

function resizeActiveImageLayer(width, height, options = {}) {
    const layer = getActiveImageLayerForResize();
    if (!layer) return;

    const oldWidth = Math.max(1, Number(layer.layerWidth || layer.imageWidth || width || 1));
    const oldHeight = Math.max(1, Number(layer.layerHeight || layer.imageHeight || height || 1));

    const nextWidth = Math.max(1, Math.round(width || oldWidth));
    const nextHeight = Math.max(1, Math.round(height || oldHeight));

    // 중심 기준으로 크기 조절
    const centerX = Number(layer.x || 0) + oldWidth / 2;
    const centerY = Number(layer.y || 0) + oldHeight / 2;

    layer.layerWidth = nextWidth;
    layer.layerHeight = nextHeight;

    layer.x = Math.round(centerX - nextWidth / 2);
    layer.y = Math.round(centerY - nextHeight / 2);

    if (options.clamp !== false) {
        clampImageLayerInsideCanvas(layer);
    }

    renderLayerList();
    renderCanvasLayersOnSurface();
    updateImageResizePanel();
    saveCanvasState();
}

function clampImageLayerInsideCanvas(layer) {
    if (!layer) return;

    const width = Math.max(1, Number(layer.layerWidth || 1));
    const height = Math.max(1, Number(layer.layerHeight || 1));

    if (width <= currentCanvasWidth) {
        layer.x = Math.max(0, Math.min(Number(layer.x || 0), currentCanvasWidth - width));
    }

    if (height <= currentCanvasHeight) {
        layer.y = Math.max(0, Math.min(Number(layer.y || 0), currentCanvasHeight - height));
    }
}

function resetActiveImageLayerSize() {
    const layer = getActiveImageLayerForResize();
    if (!layer) return;

    resizeActiveImageLayer(
        layer.imageWidth || layer.layerWidth || 1,
        layer.imageHeight || layer.layerHeight || 1
    );
}

function fitActiveImageLayerToCanvas() {
    const layer = getActiveImageLayerForResize();
    if (!layer) return;

    const geometry = getInitialImageLayerGeometry(
        layer.imageWidth || layer.layerWidth || 1,
        layer.imageHeight || layer.layerHeight || 1,
        { allowUpscale: true }
    );

    layer.layerWidth = geometry.width;
    layer.layerHeight = geometry.height;
    layer.x = geometry.x;
    layer.y = geometry.y;

    renderLayerList();
    renderCanvasLayersOnSurface();
    updateImageResizePanel();
    saveCanvasState();
}

function startLayerMoveDrag(event, layerId) {
    if (!isLayerMoveMode) return;

    if (isLayerMultiSelected(layerId) && getSelectedTransformLayers().length >= 2) {
        startMultiLayerMoveDrag(event);
        return;
    }

    const found = findCanvasLayer(layerId);
    const layer = found?.layer;
    if (!layer || layer.type !== 'image' || !layer.visible) return;

    event.preventDefault();
    event.stopPropagation();

    normalizeImageLayerGeometry(layer);

    const displayScale = getCanvasDisplayScale();
    const surface = el('canvasSurface');
    const surfaceRect = surface.getBoundingClientRect();

    // 마우스가 캔버스 내부 좌표에서 어디를 찍었는지 계산
    const pointerCanvasX = (event.clientX - surfaceRect.left) / displayScale;
    const pointerCanvasY = (event.clientY - surfaceRect.top) / displayScale;

    // 이미지 레이어 안에서 클릭한 지점의 오프셋
    // 이후 이동 중에는 이 오프셋을 고정해서 이미지 좌표를 계산한다.
    const grabOffsetX = pointerCanvasX - layer.x;
    const grabOffsetY = pointerCanvasY - layer.y;

    activeLayerId = layer.id;

    activeLayerDrag = {
        layerId: layer.id,
        grabOffsetX,
        grabOffsetY,
        layerWidth: layer.layerWidth,
        layerHeight: layer.layerHeight,
        displayScale,
        surfaceLeft: surfaceRect.left,
        surfaceTop: surfaceRect.top,
        stuckX: null,
        stuckY: null
    };

    if (surface) surface.classList.add('dragging');

    renderLayerList();
    syncCanvasSurfaceSelectionState();
}

function startMultiLayerMoveDrag(event) {
    if (!isLayerMoveMode) return;

    const layers = getSelectedTransformLayers();
    if (layers.length < 2) return;

    event.preventDefault();
    event.stopPropagation();

    const bounds = getTransformLayerBounds(layers);
    const pointer = getCanvasPointerPosition(event);
    const surface = el('canvasSurface');

    activeLayerDrag = {
        mode: 'multi',
        layerIds: layers.map((layer) => Number(layer.id)),
        startPointerX: pointer.x,
        startPointerY: pointer.y,
        displayScale: pointer.displayScale,
        surfaceLeft: pointer.surfaceLeft,
        surfaceTop: pointer.surfaceTop,
        startBoundsX: bounds.x,
        startBoundsY: bounds.y,
        boundsWidth: bounds.width,
        boundsHeight: bounds.height,
        starts: layers.map((layer) => ({
            id: Number(layer.id),
            x: Number(layer.x || 0),
            y: Number(layer.y || 0)
        })),
        childStarts: buildSelectionChildMoveStarts(layers),
        stuckX: null,
        stuckY: null
    };

    if (surface) surface.classList.add('dragging');

    renderLayerList();
    syncCanvasSurfaceSelectionState();
}

function isSelectionChildMovableLayer(layer) {
    return Boolean(
        layer &&
        layer.visible !== false &&
        (
            layer.type === 'image' ||
            layer.type === 'clip' ||
            layer.type === 'selection'
        )
    );
}

function collectSelectionChildMovableLayers(selection, output = []) {
    if (!selection || !Array.isArray(selection.children)) return output;

    selection.children.forEach((child) => {
        if (!child) return;

        if (child.type === 'folder') {
            child.children = Array.isArray(child.children) ? child.children : [];
            collectSelectionChildMovableLayers(child, output);
            return;
        }

        if (child.type === 'selection') {
            normalizeSelectionAreaGeometry(child);
            output.push(child);
            collectSelectionChildMovableLayers(child, output);
            return;
        }

        if (child.type === 'image') {
            normalizeImageLayerGeometry(child);
            output.push(child);
            return;
        }

        if (child.type === 'clip') {
            output.push(child);
        }
    });

    return output;
}

function buildSelectionChildMoveStarts(selectedLayers) {
    const starts = [];
    const usedIds = new Set(selectedLayers.map((layer) => Number(layer.id)));

    selectedLayers.forEach((layer) => {
        if (!layer || layer.type !== 'selection') return;

        const children = collectSelectionChildMovableLayers(layer);

        children.forEach((child) => {
            const id = Number(child.id);

            // 이미 직접 선택된 레이어는 중복 이동 방지
            if (usedIds.has(id)) return;

            usedIds.add(id);

            starts.push({
                id,
                x: Number(child.x || 0),
                y: Number(child.y || 0)
            });
        });
    });

    return starts;
}

function handleLayerMoveMouseMove(event) {
    if (!activeLayerDrag) return;

    if (activeLayerDrag.mode === 'multi') {
        handleMultiLayerMoveMouseMove(event);
        return;
    }

    const found = findCanvasLayer(activeLayerDrag.layerId);
    const layer = found?.layer;
    if (!layer) return;

    const displayScale = activeLayerDrag.displayScale || getCanvasDisplayScale();
    const surface = el('canvasSurface');
    if (!surface) return;

    // 현재 마우스 위치를 캔버스 실제 좌표로 변환
    const pointerCanvasX = (event.clientX - activeLayerDrag.surfaceLeft) / displayScale;
    const pointerCanvasY = (event.clientY - activeLayerDrag.surfaceTop) / displayScale;

    // 중요:
    // 마우스 기준이 아니라,
    // 이미지 안에서 처음 클릭한 지점(grabOffset)을 유지한 채 이미지 좌표를 계산한다.
    const proposedX = pointerCanvasX - activeLayerDrag.grabOffsetX;
    const proposedY = pointerCanvasY - activeLayerDrag.grabOffsetY;

    const resolvedX = resolveLayerEdgeStickAxis({
        proposed: proposedX,
        size: activeLayerDrag.layerWidth,
        canvasSize: currentCanvasWidth,
        stuckState: activeLayerDrag.stuckX,
        pointerClientAxis: event.clientX,
        displayScale
    });

    const resolvedY = resolveLayerEdgeStickAxis({
        proposed: proposedY,
        size: activeLayerDrag.layerHeight,
        canvasSize: currentCanvasHeight,
        stuckState: activeLayerDrag.stuckY,
        pointerClientAxis: event.clientY,
        displayScale
    });

    layer.x = snapCanvasMovePosition(resolvedX.value);
    layer.y = snapCanvasMovePosition(resolvedY.value);

    activeLayerDrag.stuckX = resolvedX.stuckState;
    activeLayerDrag.stuckY = resolvedY.stuckState;

    updateCanvasHotLayerGeometry(layer.id);
}

function handleMultiLayerMoveMouseMove(event) {
    const drag = activeLayerDrag;
    if (!drag || drag.mode !== 'multi') return;

    const pointer = getCanvasPointerPositionForDrag(event, drag);
    const displayScale = pointer.displayScale;

    const dx = pointer.x - drag.startPointerX;
    const dy = pointer.y - drag.startPointerY;

    const proposedX = drag.startBoundsX + dx;
    const proposedY = drag.startBoundsY + dy;

    const resolvedX = resolveLayerEdgeStickAxis({
        proposed: proposedX,
        size: drag.boundsWidth,
        canvasSize: currentCanvasWidth,
        stuckState: drag.stuckX,
        pointerClientAxis: event.clientX,
        displayScale
    });

    const resolvedY = resolveLayerEdgeStickAxis({
        proposed: proposedY,
        size: drag.boundsHeight,
        canvasSize: currentCanvasHeight,
        stuckState: drag.stuckY,
        pointerClientAxis: event.clientY,
        displayScale
    });

    drag.stuckX = resolvedX.stuckState;
    drag.stuckY = resolvedY.stuckState;

    const finalDx = snapCanvasMovePosition(resolvedX.value) - drag.startBoundsX;
    const finalDy = snapCanvasMovePosition(resolvedY.value) - drag.startBoundsY;

    drag.starts.forEach((start) => {
        const found = findCanvasLayer(start.id);
        const layer = found?.layer;
        if (!isMultiTransformLayer(layer)) return;

        layer.x = snapCanvasMovePosition(start.x + finalDx);
        layer.y = snapCanvasMovePosition(start.y + finalDy);
    });

    (drag.childStarts || []).forEach((start) => {
        const found = findCanvasLayer(start.id);
        const layer = found?.layer;
        if (!isSelectionChildMovableLayer(layer)) return;

        layer.x = snapCanvasMovePosition(start.x + finalDx);
        layer.y = snapCanvasMovePosition(start.y + finalDy);
    });

    updateCanvasHotLayerGeometry([
        ...drag.starts.map((start) => start.id),
        ...(drag.childStarts || []).map((start) => start.id)
    ]);
}

function handleLayerMoveMouseUp() {
    if (!activeLayerDrag) return;

    if (activeLayerDrag.mode === 'multi') {
        activeLayerDrag.layerIds.forEach((id) => {
            const found = findCanvasLayer(id);
            const layer = found?.layer;
            if (!isMultiTransformLayer(layer)) return;

            layer.x = Math.round(layer.x || 0);
            layer.y = Math.round(layer.y || 0);
        });
        (activeLayerDrag.childStarts || []).forEach((start) => {
            const found = findCanvasLayer(start.id);
            const layer = found?.layer;
            if (!isSelectionChildMovableLayer(layer)) return;

            layer.x = Math.round(layer.x || 0);
            layer.y = Math.round(layer.y || 0);
        });

        flushPendingCanvasHotLayerGeometry();
        activeLayerDrag = null;

        const surface = el('canvasSurface');
        if (surface) surface.classList.remove('dragging');

        renderLayerList();
        syncCanvasSurfaceSelectionState();
        saveCanvasState();
        return;
    }

    flushPendingCanvasHotLayerGeometry();
    activeLayerDrag = null;

    const surface = el('canvasSurface');
    if (surface) surface.classList.remove('dragging');

    renderLayerList();
    syncCanvasSurfaceSelectionState();
    saveCanvasState();
}

function resolveLayerEdgeStickAxis({
    proposed,
    size,
    canvasSize,
    stuckState,
    pointerClientAxis,
    displayScale
}) {
    if (!Number.isFinite(proposed)) {
        return { value: 0, stuckState: null };
    }

    if (!canvasSize || !size) {
        return { value: proposed, stuckState: null };
    }

    const safeScale = displayScale || 1;
    const stickThresholdCanvas = EDGE_STICK_SCREEN_THRESHOLD / safeScale;

    let minPos = 0;
    let maxPos = canvasSize - size;

    // 이미지가 캔버스보다 큰 축은 이동 가능 범위가 반대로 된다.
    if (size > canvasSize) {
        minPos = canvasSize - size;
        maxPos = 0;
    }

    const isEqualSizeAxis = Math.abs(size - canvasSize) <= 1;

    // 이미지 크기와 캔버스 크기가 같은 축.
    // 평소에는 0에 붙이고, 충분히 밀면 탈출 허용.
    if (isEqualSizeAxis) {
        const target = 0;

        if (stuckState && stuckState.side === 'equal') {
            // 이미 탈출한 상태라면, 0 근처로 돌아오기 전까지 재스냅하지 않는다.
            if (stuckState.released) {
                if (Math.abs(proposed - target) <= stickThresholdCanvas) {
                    return {
                        value: target,
                        stuckState: {
                            side: 'equal',
                            pointerClientAxis,
                            released: false
                        }
                    };
                }

                return {
                    value: proposed,
                    stuckState
                };
            }

            const pushScreen = Math.abs(pointerClientAxis - stuckState.pointerClientAxis);

            if (pushScreen < EDGE_BREAK_SCREEN_THRESHOLD) {
                return {
                    value: target,
                    stuckState
                };
            }

            return {
                value: proposed,
                stuckState: {
                    side: 'equal',
                    pointerClientAxis,
                    released: true
                }
            };
        }

        if (Math.abs(proposed - target) <= stickThresholdCanvas) {
            return {
                value: target,
                stuckState: {
                    side: 'equal',
                    pointerClientAxis,
                    released: false
                }
            };
        }

        return {
            value: proposed,
            stuckState: null
        };
    }

    // 이미 특정 가장자리에서 탈출한 상태.
    // 이 상태에서는 같은 방향으로는 재스냅하지 않는다.
    // 다시 캔버스 안쪽으로 충분히 돌아왔을 때만 스냅 상태를 해제한다.
    if (stuckState && stuckState.released && stuckState.side) {
        const side = stuckState.side;
        const target = side === 'min' ? minPos : maxPos;

        const backInside = side === 'min'
            ? proposed > target + stickThresholdCanvas
            : proposed < target - stickThresholdCanvas;

        if (backInside) {
            return {
                value: proposed,
                stuckState: null
            };
        }

        return {
            value: proposed,
            stuckState
        };
    }

    // 이미 가장자리에 붙어 있는 상태
    if (stuckState && stuckState.side) {
        const side = stuckState.side;
        const target = side === 'min' ? minPos : maxPos;

        // 안쪽으로 돌아오는 움직임
        const inwardDistance = side === 'min'
            ? proposed - target
            : target - proposed;

        if (inwardDistance > stickThresholdCanvas) {
            return {
                value: proposed,
                stuckState: null
            };
        }

        // 바깥쪽으로 미는 마우스 이동량.
        // min: 왼쪽/위쪽으로 밀면 pointer 감소
        // max: 오른쪽/아래쪽으로 밀면 pointer 증가
        const outwardPushScreen = side === 'min'
            ? stuckState.pointerClientAxis - pointerClientAxis
            : pointerClientAxis - stuckState.pointerClientAxis;

        if (outwardPushScreen < EDGE_BREAK_SCREEN_THRESHOLD) {
            return {
                value: target,
                stuckState
            };
        }

        // 핵심:
        // 탈출 허용 후 released 상태로 둔다.
        // 그래야 다음 mousemove에서 곧바로 다시 가장자리에 붙지 않는다.
        return {
            value: proposed,
            stuckState: {
                side,
                pointerClientAxis,
                released: true
            }
        };
    }

    // 아직 붙어 있지 않은 상태.
    // 가장자리 근처에 오거나 살짝 넘어가면 붙임.
    if (Math.abs(proposed - minPos) <= stickThresholdCanvas || proposed < minPos) {
        return {
            value: minPos,
            stuckState: {
                side: 'min',
                pointerClientAxis,
                released: false
            }
        };
    }

    if (Math.abs(proposed - maxPos) <= stickThresholdCanvas || proposed > maxPos) {
        return {
            value: maxPos,
            stuckState: {
                side: 'max',
                pointerClientAxis,
                released: false
            }
        };
    }

    return {
        value: proposed,
        stuckState: null
    };
}

function findCanvasLayer(layerId, layers = canvasLayers, parent = null) {
    const targetId = Number(layerId);

    for (let index = 0; index < layers.length; index++) {
        const layer = layers[index];

        if (Number(layer.id) === targetId) {
            return {
                layer,
                parent,
                container: layers,
                index
            };
        }

        if (layer.type === 'folder' || layer.type === 'selection') {
            layer.children = Array.isArray(layer.children) ? layer.children : [];
            const found = findCanvasLayer(targetId, layer.children, layer);
            if (found) return found;
        }
    }

    return null;
}

function isMultiSelectableImageLayer(layer) {
    return Boolean(
        layer &&
        layer.type === 'image' &&
        !layer.pinnedReference
    );
}

function isMultiTransformLayer(layer) {
    return Boolean(
        layer &&
        layer.visible !== false &&
        (
            isResizableCanvasLayer(layer) ||
            layer.type === 'selection'
        )
    );
}

function normalizeTransformLayerGeometry(layer) {
    if (!layer) return;

    if (isResizableCanvasLayer(layer)) {
        normalizeResizableLayerGeometry(layer);
        return;
    }

    if (layer.type === 'selection') {
        normalizeSelectionAreaGeometry(layer);
    }
}

function getSelectedTransformLayers() {
    const layers = [];

    selectedLayerIds.forEach((id) => {
        const found = findCanvasLayer(id);
        const layer = found?.layer;

        if (isMultiTransformLayer(layer)) {
            normalizeTransformLayerGeometry(layer);
            layers.push(layer);
        }
    });

    return layers;
}

function getActiveTransformLayerOrNull() {
    const found = findCanvasLayer(activeLayerId);
    const layer = found?.layer;

    if (!isMultiTransformLayer(layer)) return null;

    normalizeTransformLayerGeometry(layer);
    return layer;
}

function getTransformLayerBounds(layers) {
    if (!layers.length) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    layers.forEach((layer) => {
        normalizeTransformLayerGeometry(layer);

        const x = Number(layer.x || 0);
        const y = Number(layer.y || 0);
        const width = Number(layer.layerWidth || layer.imageWidth || 1);
        const height = Number(layer.layerHeight || layer.imageHeight || 1);

        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + width);
        maxY = Math.max(maxY, y + height);
    });

    return {
        x: minX,
        y: minY,
        width: Math.max(1, maxX - minX),
        height: Math.max(1, maxY - minY),
        right: maxX,
        bottom: maxY
    };
}

function getSelectedImageLayers() {
    const layers = [];

    selectedLayerIds.forEach((id) => {
        const found = findCanvasLayer(id);
        const layer = found?.layer;

        if (isMultiSelectableImageLayer(layer)) {
            normalizeImageLayerGeometry(layer);
            layers.push(layer);
        }
    });

    return layers;
}

function getActiveImageLayerOrNull() {
    const found = findCanvasLayer(activeLayerId);
    const layer = found?.layer;

    if (!isMultiSelectableImageLayer(layer)) return null;

    normalizeImageLayerGeometry(layer);
    return layer;
}

function getTransformTargetImageLayers() {
    const selected = getSelectedImageLayers();

    if (selected.length >= 2) {
        return selected;
    }

    const active = getActiveImageLayerOrNull();
    return active ? [active] : [];
}

function getImageLayerBounds(layers) {
    if (!layers.length) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    layers.forEach((layer) => {
        normalizeImageLayerGeometry(layer);

        const x = Number(layer.x || 0);
        const y = Number(layer.y || 0);
        const width = Number(layer.layerWidth || layer.imageWidth || 1);
        const height = Number(layer.layerHeight || layer.imageHeight || 1);

        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + width);
        maxY = Math.max(maxY, y + height);
    });

    return {
        x: minX,
        y: minY,
        width: Math.max(1, maxX - minX),
        height: Math.max(1, maxY - minY),
        right: maxX,
        bottom: maxY
    };
}

function isLayerMultiSelected(layerId) {
    return selectedLayerIds.has(Number(layerId));
}

function clearMultiLayerSelection() {
    selectedLayerIds.clear();
}

function removeCanvasLayerById(layerId) {
    const found = findCanvasLayer(layerId);
    if (!found) return null;

    const [removed] = found.container.splice(found.index, 1);
    return {
        layer: removed,
        parent: found.parent,
        container: found.container,
        index: found.index
    };
}

function getAllCanvasLayerNodes(layers = canvasLayers, output = []) {
    layers.forEach((layer) => {
        output.push(layer);

        if ((layer.type === 'folder' || layer.type === 'selection') && Array.isArray(layer.children)) {
            layer.children = Array.isArray(layer.children) ? layer.children : [];
            getAllCanvasLayerNodes(layer.children, output);
        }
    });

    return output;
}

function countCanvasLayersByType(type) {
    return getAllCanvasLayerNodes().filter((layer) => layer.type === type).length;
}

function getFirstCanvasLayerId(layers = canvasLayers) {
    for (const layer of layers) {
        if (layer.id !== undefined && layer.id !== null) return layer.id;

        if ((layer.type === 'folder' || layer.type === 'selection') && Array.isArray(layer.children)) {
            const childId = getFirstCanvasLayerId(layer.children);
            if (childId) return childId;
        }
    }

    return null;
}

function normalizeCanvasLayerTree(layers = canvasLayers) {
    layers.forEach((layer) => {
        if (layer.type === 'folder' || layer.type === 'selection') {
            layer.children = Array.isArray(layer.children) ? layer.children : [];
            if (layer.expanded === undefined) layer.expanded = true;

            if (layer.type === 'selection') {
                normalizeSelectionAreaGeometry(layer);
            }

            normalizeCanvasLayerTree(layer.children);
        }

        if (layer.type === 'image') {
            if (!layer.promptOwnerId) {
                layer.promptOwnerId = layer.id;
            }
            if (!Array.isArray(layer.promptControlGroups)) {
                layer.promptControlGroups = [];
            }
        }

        if (layer.type === 'clip') {
            ensureClipPromptControlGroups(layer);
        }
    });
}

function normalizeSelectionAreaGeometry(layer) {
    if (!layer || layer.type !== 'selection') return;

    if (!Number.isFinite(layer.layerWidth) || layer.layerWidth <= 0) {
        layer.layerWidth = Math.max(128, Math.round((currentCanvasWidth || 960) * 0.5));
    }

    if (!Number.isFinite(layer.layerHeight) || layer.layerHeight <= 0) {
        layer.layerHeight = Math.max(128, Math.round((currentCanvasHeight || 3072) * 0.22));
    }

    layer.layerWidth = snapToSelectionStep(layer.layerWidth);
    layer.layerHeight = snapToSelectionStep(layer.layerHeight);

    if (!Number.isFinite(layer.x)) {
        layer.x = Math.round(((currentCanvasWidth || layer.layerWidth) - layer.layerWidth) / 2);
    } else {
        layer.x = Math.round(Number(layer.x || 0));
    }

    if (!Number.isFinite(layer.y)) {
        layer.y = Math.round(((currentCanvasHeight || layer.layerHeight) - layer.layerHeight) / 2);
    } else {
        layer.y = Math.round(Number(layer.y || 0));
    }
}

function clearLayerDropMarkers() {
    document.querySelectorAll('.drop-target, .drop-before, .drop-after').forEach((node) => {
        node.classList.remove('drop-target', 'drop-before', 'drop-after');
    });
}

function resolveLayerListDropPosition(event, item, targetLayer) {
    const rect = item.getBoundingClientRect();
    const ratio = rect.height > 0
        ? (event.clientY - rect.top) / rect.height
        : 0.5;

    const isContainer = targetLayer?.type === 'folder' || targetLayer?.type === 'selection';

    if (isContainer && ratio >= 0.25 && ratio <= 0.75) {
        return 'inside';
    }

    return ratio < 0.5 ? 'before' : 'after';
}

function layerTreeContainsLayerId(rootLayer, layerId) {
    const targetId = Number(layerId);

    if (!rootLayer || !Array.isArray(rootLayer.children)) {
        return false;
    }

    return rootLayer.children.some((child) => {
        if (Number(child.id) === targetId) return true;

        if (child.type === 'folder' || child.type === 'selection') {
            return layerTreeContainsLayerId(child, targetId);
        }

        return false;
    });
}

function canDropLayerOnTarget(sourceId, targetId, position) {
    const sourceInfo = findCanvasLayer(sourceId);
    const targetInfo = findCanvasLayer(targetId);

    if (!sourceInfo || !targetInfo) return false;
    if (Number(sourceId) === Number(targetId)) return false;

    const source = sourceInfo.layer;
    const target = targetInfo.layer;

    if (!source || source.type === 'canvas') return false;
    if (layerTreeContainsLayerId(source, targetId)) return false;

    if (position === 'inside') {
        if (target.type !== 'folder' && target.type !== 'selection') return false;
        if (source.type === 'folder' || source.type === 'selection' || source.type === 'canvas') return false;
        return true;
    }

    if (position !== 'before' && position !== 'after') return false;
    if (target.type === 'canvas' && position === 'after') return false;

    return true;
}

function moveDraggedLayerToTarget(event, targetId, position) {
    event.preventDefault();
    event.stopPropagation();

    const sourceId = Number(draggedLayerId || event.dataTransfer.getData('text/plain'));
    if (!sourceId) return;

    if (!canDropLayerOnTarget(sourceId, targetId, position)) {
        clearLayerDropMarkers();
        return;
    }

    const removed = removeCanvasLayerById(sourceId);
    if (!removed) {
        clearLayerDropMarkers();
        return;
    }

    const targetInfo = findCanvasLayer(targetId);
    if (!targetInfo) {
        removed.container.splice(removed.index, 0, removed.layer);
        clearLayerDropMarkers();
        return;
    }

    if (position === 'inside') {
        const target = targetInfo.layer;
        target.children = Array.isArray(target.children) ? target.children : [];
        target.children.unshift(removed.layer);
        target.expanded = true;
    } else {
        const insertIndex = targetInfo.index + (position === 'after' ? 1 : 0);
        targetInfo.container.splice(insertIndex, 0, removed.layer);
    }

    draggedLayerId = null;
    activeLayerId = removed.layer.id;

    clearLayerDropMarkers();
    renderLayerList();
    renderCanvasLayersOnSurface();

    if (typeof updateImageResizePanel === 'function') {
        updateImageResizePanel();
    }

    saveCanvasState();
}

function dropLayerIntoContainer(event, containerId) {
    moveDraggedLayerToTarget(event, containerId, 'inside');
}

function exitLayerFromFolder(layerId, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }

    const found = findCanvasLayer(layerId);
    if (!found || !found.parent) return;

    // 폴더나 캔버스 레이어는 이 버튼이 뜨지 않지만 안전장치
    if (found.layer.type === 'folder' || found.layer.type === 'canvas') return;

    const removed = removeCanvasLayerById(layerId);
    if (!removed) return;

    // 최상단으로 꺼냄
    canvasLayers.unshift(removed.layer);
    activeLayerId = removed.layer.id;

    renderLayerList();
    renderCanvasLayersOnSurface();
    saveCanvasState();
}

function snapToSelectionStep(value) {
    const n = Number(value) || SELECTION_MIN_SIZE;
    return Math.max(SELECTION_MIN_SIZE, Math.round(n / SELECTION_SIZE_STEP) * SELECTION_SIZE_STEP);
}

function snapCanvasMovePosition(value) {
    return Math.round(Number(value) || 0);
}

function getCanvasPointerPosition(event) {
    const surface = el('canvasSurface');
    const displayScale = getCanvasDisplayScale();

    if (!surface) {
        return { x: 0, y: 0, displayScale, surfaceLeft: 0, surfaceTop: 0 };
    }

    const rect = surface.getBoundingClientRect();

    return {
        x: (event.clientX - rect.left) / displayScale,
        y: (event.clientY - rect.top) / displayScale,
        displayScale,
        surfaceLeft: rect.left,
        surfaceTop: rect.top
    };
}

function getCanvasPointerPositionForDrag(event, drag) {
    const displayScale = Number(drag?.displayScale);
    const surfaceLeft = Number(drag?.surfaceLeft);
    const surfaceTop = Number(drag?.surfaceTop);

    if (
        Number.isFinite(displayScale) && displayScale > 0 &&
        Number.isFinite(surfaceLeft) && Number.isFinite(surfaceTop)
    ) {
        return {
            x: (event.clientX - surfaceLeft) / displayScale,
            y: (event.clientY - surfaceTop) / displayScale,
            displayScale,
            surfaceLeft,
            surfaceTop
        };
    }

    return getCanvasPointerPosition(event);
}

function startSelectionMoveDrag(event, layerId) {
    const found = findCanvasLayer(layerId);
    const layer = found?.layer;

    if (!layer || layer.type !== 'selection' || !layer.visible) return;

    if (selectionRequiresLayerMoveMode(layer) && !isLayerMoveMode) {
        event.preventDefault();
        event.stopPropagation();
        updateSelectionHoverCursor(event);
        return;
    }

    if (isLayerMultiSelected(layerId) && getSelectedTransformLayers().length >= 2) {
        startMultiLayerMoveDrag(event);
        return;
    }

    // 선택된 selection만 이동 가능
    if (Number(activeLayerId) !== Number(layerId)) return;

    event.preventDefault();
    event.stopPropagation();

    const surface = el('canvasSurface');
    if (surface) {
        surface.style.cursor = 'move';
        surface.classList.add('selection-dragging');
    }

    normalizeSelectionAreaGeometry(layer);

    const pointer = getCanvasPointerPosition(event);

    activeSelectionDrag = {
        mode: 'move',
        layerId: layer.id,
        grabOffsetX: pointer.x - layer.x,
        grabOffsetY: pointer.y - layer.y,
        displayScale: pointer.displayScale,
        surfaceLeft: pointer.surfaceLeft,
        surfaceTop: pointer.surfaceTop,
        startX: layer.x,
        startY: layer.y,
        startWidth: layer.layerWidth,
        startHeight: layer.layerHeight,
        childStarts: buildSelectionChildMoveStarts([layer]),
        stuckX: null,
        stuckY: null
    };

    hideSelectionSizeTooltip();
}

function startSelectionRotateDrag(event, layerId) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const layer = findCanvasLayer(layerId)?.layer;
    if (!layer || layer.type !== 'selection' || !layer.visible) return;
    if (getEditableClipForSelection(layer)) return;
    if (selectionRequiresLayerMoveMode(layer) && !isLayerMoveMode) return;
    normalizeSelectionAreaGeometry(layer);
    selectedLayerIds.clear();
    selectedLayerIds.add(Number(layer.id));
    activeLayerId = checkedSelectionId = activeClipSelectionId = layer.id;
    const pointer = getCanvasPointerPosition(event);
    const centerX = layer.x + layer.layerWidth / 2;
    const centerY = layer.y + layer.layerHeight / 2;
    const dx = pointer.x - centerX;
    const dy = pointer.y - centerY;
    activeSelectionDrag = {
        mode: 'rotate', layerId: layer.id,
        displayScale: pointer.displayScale, surfaceLeft: pointer.surfaceLeft, surfaceTop: pointer.surfaceTop,
        centerX, centerY, startRotation: CanvasSelectionRotation.angle(layer.rotation),
        startAngle: Math.hypot(dx, dy) * pointer.displayScale >= 6 ? Math.atan2(dy, dx) : null
    };
    hideSelectionSizeTooltip();
    renderLayerList();
    syncCanvasSurfaceSelectionState();
}

function startSelectionResizeDrag(event, layerId, handle) {
    const found = findCanvasLayer(layerId);
    const layer = found?.layer;

    if (!layer || layer.type !== 'selection' || !layer.visible) return;

    if (selectionRequiresLayerMoveMode(layer) && !isLayerMoveMode) return;
    
    if (
        isImageResizeMode &&
        isLayerMultiSelected(layerId) &&
        getSelectedTransformLayers().length >= 2
    ) {
        startMultiImageResizeDrag(event, handle);
        return;
    }

    if (isLayerMultiSelected(layerId) && getSelectedTransformLayers().length >= 2) {
        startMultiLayerMoveDrag(event);
        return;
    }

    // 선택된 selection만 크기 조절 가능
    if (Number(activeLayerId) !== Number(layerId)) return;

    event.preventDefault();
    event.stopPropagation();

    const surface = el('canvasSurface');
    if (surface) surface.style.cursor = 'grabbing';

    normalizeSelectionAreaGeometry(layer);

    const pointer = getCanvasPointerPosition(event);

    activeSelectionDrag = {
        mode: 'resize',
        layerId: layer.id,
        rotation: CanvasSelectionRotation.angle(layer.rotation),
        handle,
        startPointerX: pointer.x,
        startPointerY: pointer.y,
        displayScale: pointer.displayScale,
        surfaceLeft: pointer.surfaceLeft,
        surfaceTop: pointer.surfaceTop,
        startX: layer.x,
        startY: layer.y,
        startWidth: layer.layerWidth,
        startHeight: layer.layerHeight,
        anchorRight: layer.x + layer.layerWidth,
        anchorBottom: layer.y + layer.layerHeight,
        stuckX: null,
        stuckY: null,
        clientX: event.clientX,
        clientY: event.clientY
    };

    updateSelectionSizeTooltip(event.clientX, event.clientY, layer.layerWidth, layer.layerHeight, true);
}

function handleSelectionMouseMove(event) {
    if (!activeSelectionDrag) return;

    const found = findCanvasLayer(activeSelectionDrag.layerId);
    const layer = found?.layer;
    if (!layer || layer.type !== 'selection') return;

    if (activeSelectionDrag.mode === 'rotate') {
        const pointer = getCanvasPointerPositionForDrag(event, activeSelectionDrag);
        const dx = pointer.x - activeSelectionDrag.centerX;
        const dy = pointer.y - activeSelectionDrag.centerY;
        if (Math.hypot(dx, dy) * pointer.displayScale < 6) return;
        const angle = Math.atan2(dy, dx);
        if (activeSelectionDrag.startAngle === null) activeSelectionDrag.startAngle = angle;
        const rotation = CanvasSelectionRotation.angle(CanvasSelectionRotation.snapAngle(
            activeSelectionDrag.startRotation + (angle - activeSelectionDrag.startAngle) * 180 / Math.PI));
        if (!isSelectionRequestSizeAllowed({...layer, rotation})) return;
        layer.rotation = rotation;
        updateCanvasHotLayerGeometry(layer.id);
        return;
    }

    if (activeSelectionDrag.mode === 'move') {
        handleSelectionMove(event, layer);
        return;
    }

    if (activeSelectionDrag.mode === 'resize') {
        handleSelectionResize(event, layer);
    }
}

function handleSelectionMove(event, layer) {
    const pointer = getCanvasPointerPositionForDrag(event, activeSelectionDrag);
    const displayScale = pointer.displayScale;

    const proposedX = pointer.x - activeSelectionDrag.grabOffsetX;
    const proposedY = pointer.y - activeSelectionDrag.grabOffsetY;

    const resolvedX = resolveLayerEdgeStickAxis({
        proposed: proposedX,
        size: activeSelectionDrag.startWidth,
        canvasSize: currentCanvasWidth,
        stuckState: activeSelectionDrag.stuckX,
        pointerClientAxis: event.clientX,
        displayScale
    });

    const resolvedY = resolveLayerEdgeStickAxis({
        proposed: proposedY,
        size: activeSelectionDrag.startHeight,
        canvasSize: currentCanvasHeight,
        stuckState: activeSelectionDrag.stuckY,
        pointerClientAxis: event.clientY,
        displayScale
    });

    layer.x = snapCanvasMovePosition(resolvedX.value);
    layer.y = snapCanvasMovePosition(resolvedY.value);

    const dx = layer.x - activeSelectionDrag.startX;
    const dy = layer.y - activeSelectionDrag.startY;

    (activeSelectionDrag.childStarts || []).forEach((start) => {
        const found = findCanvasLayer(start.id);
        const child = found?.layer;
        if (!isSelectionChildMovableLayer(child)) return;

        child.x = snapCanvasMovePosition(start.x + dx);
        child.y = snapCanvasMovePosition(start.y + dy);
    });

    activeSelectionDrag.stuckX = resolvedX.stuckState;
    activeSelectionDrag.stuckY = resolvedY.stuckState;

    updateCanvasHotLayerGeometry([
        layer.id,
        ...(activeSelectionDrag.childStarts || []).map((start) => start.id)
    ]);
}

function handleSelectionResize(event, layer) {
    const pointer = getCanvasPointerPositionForDrag(event, activeSelectionDrag);
    const handle = activeSelectionDrag.handle;

    if (activeSelectionDrag.rotation) {
        const drag = activeSelectionDrag;
        const resized = CanvasSelectionRotation.resize({
            x: drag.startX, y: drag.startY, layerWidth: drag.startWidth,
            layerHeight: drag.startHeight, rotation: drag.rotation
        }, handle, pointer.x - drag.startPointerX, pointer.y - drag.startPointerY, snapToSelectionStep);
        if (!isSelectionRequestSizeAllowed({...layer, ...resized})) return;
        Object.assign(layer, resized);
        updateSelectionSizeTooltip(event.clientX, event.clientY, layer.layerWidth, layer.layerHeight, true);
        updateCanvasHotLayerGeometry(layer.id);
        return;
    }

    let nextX = activeSelectionDrag.startX;
    let nextY = activeSelectionDrag.startY;
    let nextWidth = activeSelectionDrag.startWidth;
    let nextHeight = activeSelectionDrag.startHeight;

    const dx = pointer.x - activeSelectionDrag.startPointerX;
    const dy = pointer.y - activeSelectionDrag.startPointerY;

    // 오른쪽 모서리 조절
    if (handle.includes('r')) {
        nextWidth = snapToSelectionStep(activeSelectionDrag.startWidth + dx);
    }

    // 왼쪽 모서리 조절: 오른쪽을 고정하고 왼쪽이 움직임
    if (handle.includes('l')) {
        nextWidth = snapToSelectionStep(activeSelectionDrag.startWidth - dx);
        nextX = activeSelectionDrag.anchorRight - nextWidth;
    }

    // 아래쪽 모서리 조절
    if (handle.includes('b')) {
        nextHeight = snapToSelectionStep(activeSelectionDrag.startHeight + dy);
    }

    // 위쪽 모서리 조절: 아래쪽을 고정하고 위쪽이 움직임
    if (handle.includes('t')) {
        nextHeight = snapToSelectionStep(activeSelectionDrag.startHeight - dy);
        nextY = activeSelectionDrag.anchorBottom - nextHeight;
    }

    nextWidth = Math.max(SELECTION_MIN_SIZE, nextWidth);
    nextHeight = Math.max(SELECTION_MIN_SIZE, nextHeight);

    // 크기 조절 중에도 선택 영역 박스의 가장자리가 캔버스 가장자리에 닿으면 잠시 붙게 함.
    // x/y가 움직이는 핸들만 스냅 처리한다.
    const displayScale = pointer.displayScale;

    if (handle.includes('l')) {
        const resolvedX = resolveLayerEdgeStickAxis({
            proposed: nextX,
            size: nextWidth,
            canvasSize: currentCanvasWidth,
            stuckState: activeSelectionDrag.stuckX,
            pointerClientAxis: event.clientX,
            displayScale
        });

        nextX = resolvedX.value;
        nextWidth = activeSelectionDrag.anchorRight - nextX;
        nextWidth = snapToSelectionStep(nextWidth);
        nextX = activeSelectionDrag.anchorRight - nextWidth;
        activeSelectionDrag.stuckX = resolvedX.stuckState;
    }

    if (handle.includes('t')) {
        const resolvedY = resolveLayerEdgeStickAxis({
            proposed: nextY,
            size: nextHeight,
            canvasSize: currentCanvasHeight,
            stuckState: activeSelectionDrag.stuckY,
            pointerClientAxis: event.clientY,
            displayScale
        });

        nextY = resolvedY.value;
        nextHeight = activeSelectionDrag.anchorBottom - nextY;
        nextHeight = snapToSelectionStep(nextHeight);
        nextY = activeSelectionDrag.anchorBottom - nextHeight;
        activeSelectionDrag.stuckY = resolvedY.stuckState;
    }

    // 오른쪽/아래쪽 핸들은 오른쪽/아래쪽 가장자리를 proposed position으로 보고 스냅.
    if (handle.includes('r')) {
        const maxX = nextX + nextWidth;
        const proposedLeftForRight = maxX - nextWidth;

        const resolvedRight = resolveSelectionFarEdgeStick({
            farEdge: maxX,
            minEdge: nextX,
            canvasSize: currentCanvasWidth,
            stuckState: activeSelectionDrag.stuckX,
            pointerClientAxis: event.clientX,
            displayScale
        });

        nextWidth = snapToSelectionStep(resolvedRight.value - nextX);
        activeSelectionDrag.stuckX = resolvedRight.stuckState;
    }

    if (handle.includes('b')) {
        const maxY = nextY + nextHeight;

        const resolvedBottom = resolveSelectionFarEdgeStick({
            farEdge: maxY,
            minEdge: nextY,
            canvasSize: currentCanvasHeight,
            stuckState: activeSelectionDrag.stuckY,
            pointerClientAxis: event.clientY,
            displayScale
        });

        nextHeight = snapToSelectionStep(resolvedBottom.value - nextY);
        activeSelectionDrag.stuckY = resolvedBottom.stuckState;
    }

    nextWidth = Math.max(SELECTION_MIN_SIZE, nextWidth);
    nextHeight = Math.max(SELECTION_MIN_SIZE, nextHeight);

    if (!isSelectionRequestSizeAllowed({
        ...layer, x: Math.round(nextX), y: Math.round(nextY),
        layerWidth: nextWidth, layerHeight: nextHeight
    })) return;

    layer.x = Math.round(nextX);
    layer.y = Math.round(nextY);
    layer.layerWidth = nextWidth;
    layer.layerHeight = nextHeight;

    updateSelectionSizeTooltip(event.clientX, event.clientY, nextWidth, nextHeight, true);
    updateCanvasHotLayerGeometry(layer.id);
}

function resolveSelectionFarEdgeStick({
    farEdge,
    minEdge,
    canvasSize,
    stuckState,
    pointerClientAxis,
    displayScale
}) {
    const size = Math.max(SELECTION_MIN_SIZE, farEdge - minEdge);

    // 오른쪽/아래쪽 끝을 기준으로 스냅하려면,
    // left/top = farEdge - size 형태로 기존 함수를 사용할 수 있다.
    const proposed = farEdge - size;

    const resolved = resolveLayerEdgeStickAxis({
        proposed,
        size,
        canvasSize,
        stuckState,
        pointerClientAxis,
        displayScale
    });

    return {
        value: resolved.value + size,
        stuckState: resolved.stuckState
    };
}

function handleSelectionMouseUp(event) {
    if (!activeSelectionDrag) return;

    const found = findCanvasLayer(activeSelectionDrag.layerId);
    const layer = found?.layer;
    let selectionSnapDx = 0;
    let selectionSnapDy = 0;

    if (layer && layer.type === 'selection') {
        const oldX = Number(layer.x || 0);
        const oldY = Number(layer.y || 0);
        layer.x = Math.round(oldX);
        layer.y = Math.round(oldY);
        selectionSnapDx = layer.x - oldX;
        selectionSnapDy = layer.y - oldY;
        layer.layerWidth = snapToSelectionStep(layer.layerWidth);
        layer.layerHeight = snapToSelectionStep(layer.layerHeight);
    }
    
    (activeSelectionDrag.childStarts || []).forEach((start) => {
        const found = findCanvasLayer(start.id);
        const child = found?.layer;
        if (!isSelectionChildMovableLayer(child)) return;

        child.x = Math.round(Number(child.x || 0) + selectionSnapDx);
        child.y = Math.round(Number(child.y || 0) + selectionSnapDy);
    });

    flushPendingCanvasHotLayerGeometry();
    activeSelectionDrag = null;

    const surface = el('canvasSurface');
    if (surface) {
        surface.classList.remove('selection-dragging');
        surface.style.cursor = '';
    }

    hideSelectionSizeTooltip();

    if (typeof CanvasDakiFocus !== 'undefined') CanvasDakiFocus.selectionChanged(layer);
    renderLayerList();
    syncCanvasSurfaceSelectionState();
    updateSelectionHoverCursor(event);
    saveCanvasState();
}

function isSelectionRequestSizeAllowed(selection) {
    // Rotation keeps the selection's original request dimensions.
    let width = Math.ceil(selection.layerWidth / SELECTION_SIZE_STEP) * SELECTION_SIZE_STEP;
    const height = Math.ceil(selection.layerHeight / SELECTION_SIZE_STEP) * SELECTION_SIZE_STEP;
    if (typeof CanvasInpaintReference !== 'undefined') {
        const reference = CanvasInpaintReference.snapshot();
        if (reference.include) width += reference.reference?.width || 320;
    }
    return width > 0 && height > 0 && width * height <= 3145728;
}

function getSelectionSizeTooltip() {
    let tooltip = el('selectionSizeTooltip');

    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'selectionSizeTooltip';
        tooltip.className = 'selection-size-tooltip';
        document.body.appendChild(tooltip);
    }

    return tooltip;
}

function updateSelectionSizeTooltip(clientX, clientY, width, height, isSelection = false) {
    const tooltip = getSelectionSizeTooltip();
    let requestSize = {width, height, reference: null};
    let referenceMissing = false;

    if (isSelection) {
        width = snapToSelectionStep(width);
        height = snapToSelectionStep(height);
        requestSize = {width, height, reference: null};
        if (typeof CanvasInpaintReference !== 'undefined') {
            try {
                requestSize = CanvasInpaintReference.request(width, height);
            } catch (_) {
                referenceMissing = true;
            }
        }
    }

    const isAnlas = requestSize.width * requestSize.height > NAI_FREE_AREA_LIMIT;
    const rangeLabel = isAnlas ? 'Anlas 가능' : '무료 크기 범위';
    let text = `${width} × ${height}px${isAnlas ? ' · Anlas 가능' : ''}`;
    if (isSelection) {
        text = `선택 ${width} × ${height}px`;
        if (referenceMissing) {
            text += '\n참고 이미지 없음 · 요청 불가';
        } else if (requestSize.reference) {
            text += ` · 참고 폭 ${requestSize.reference.width}px\n전체 ${requestSize.width} × ${requestSize.height}px · ${rangeLabel}`;
        } else {
            text += ` · ${rangeLabel}`;
        }
    }

    tooltip.classList.toggle('danger', isAnlas || referenceMissing);
    tooltip.innerText = text;

    tooltip.style.display = 'block';
    const bounds = tooltip.getBoundingClientRect();
    const maxLeft = Math.max(8, window.innerWidth - bounds.width - 8);
    const maxTop = Math.max(8, window.innerHeight - bounds.height - 8);
    const top = clientY - bounds.height - 10;
    tooltip.style.left = `${Math.max(8, Math.min(clientX + 10, maxLeft))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(top < 8 ? clientY + 10 : top, maxTop))}px`;
}

function hideSelectionSizeTooltip() {
    const tooltip = el('selectionSizeTooltip');
    if (tooltip) tooltip.style.display = 'none';
}

function getCanvasResizeTooltip() {
    let tooltip = el('canvasResizeTooltip');

    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'canvasResizeTooltip';
        tooltip.className = 'canvas-resize-tooltip';
        document.body.appendChild(tooltip);
    }

    return tooltip;
}

function updateCanvasResizeTooltip(clientX, clientY, width, height) {
    const tooltip = getCanvasResizeTooltip();
    tooltip.innerText = `적용 크기: ${width} × ${height}px`;
    tooltip.style.display = 'block';
    tooltip.style.left = `${clientX + 10}px`;
    tooltip.style.top = `${clientY - 38}px`;
}

function hideCanvasResizeTooltip() {
    const tooltip = el('canvasResizeTooltip');
    if (tooltip) tooltip.style.display = 'none';
}

function startCanvasResizeDrag(event, handle) {
    if (!isCanvasResizeMode || !currentCanvasWidth || !currentCanvasHeight) return;

    event.preventDefault();
    event.stopPropagation();

    const surface = el('canvasSurface');
    if (!surface) return;

    const rect = surface.getBoundingClientRect();
    const displayScale = getCanvasDisplayScale();

    activeCanvasResizeDrag = {
        handle,
        surfaceLeft: rect.left,
        surfaceTop: rect.top,
        startDisplayWidth: rect.width,
        startDisplayHeight: rect.height,
        startWidth: currentCanvasWidth,
        startHeight: currentCanvasHeight,
        currentLeftOffset: 0,
        currentTopOffset: 0,
        displayScale,
        layerStarts: collectCanvasLayerPositionStarts()
    };

    if (surface) surface.classList.add('canvas-resize-dragging');

    updateCanvasResizeTooltip(event.clientX, event.clientY, currentCanvasWidth, currentCanvasHeight);
}

function collectCanvasLayerPositionStarts() {
    const starts = [];

    forEachCanvasLayerDeep(canvasLayers, (layer) => {
        if (!layer || layer.type === 'canvas') return;
        if (!Number.isFinite(Number(layer.x)) || !Number.isFinite(Number(layer.y))) return;

        starts.push({
            id: layer.id,
            x: Number(layer.x || 0),
            y: Number(layer.y || 0)
        });
    });

    return starts;
}

function resolveCanvasResizeDragSize(event) {
    const drag = activeCanvasResizeDrag;
    if (!drag) return null;

    const leftEdge = drag.handle.includes('l')
        ? event.clientX
        : drag.surfaceLeft;
    const rightEdge = drag.handle.includes('r')
        ? event.clientX
        : drag.surfaceLeft + drag.startDisplayWidth;
    const topEdge = drag.handle.includes('t')
        ? event.clientY
        : drag.surfaceTop;
    const bottomEdge = drag.handle.includes('b')
        ? event.clientY
        : drag.surfaceTop + drag.startDisplayHeight;

    const width = (drag.handle.includes('l') || drag.handle.includes('r'))
        ? snapCanvasSizeToStep((rightEdge - leftEdge) / Math.max(drag.displayScale || 1, 0.01))
        : snapCanvasSizeToStep(drag.startWidth);
    const height = (drag.handle.includes('t') || drag.handle.includes('b'))
        ? snapCanvasSizeToStep((bottomEdge - topEdge) / Math.max(drag.displayScale || 1, 0.01))
        : snapCanvasSizeToStep(drag.startHeight);

    const leftOffset = drag.handle.includes('l')
        ? width - drag.startWidth
        : 0;
    const topOffset = drag.handle.includes('t')
        ? height - drag.startHeight
        : 0;

    return { width, height, leftOffset, topOffset };
}

function updateCanvasResizeStageShift(leftOffset, topOffset) {
    const drag = activeCanvasResizeDrag;
    if (!drag) return;

    const stage = el('canvasStage');
    const surface = el('canvasSurface');
    if (!stage || !surface) return;

    stage.style.transform = '';

    const scale = Math.max(drag.displayScale || 1, 0.01);
    const rect = surface.getBoundingClientRect();
    const desiredLeft = drag.handle.includes('l')
        ? drag.surfaceLeft - leftOffset * scale
        : drag.surfaceLeft;
    const desiredTop = drag.handle.includes('t')
        ? drag.surfaceTop - topOffset * scale
        : drag.surfaceTop;
    const shiftX = desiredLeft - rect.left;
    const shiftY = desiredTop - rect.top;

    drag.viewShiftX = shiftX;
    drag.viewShiftY = shiftY;
    stage.style.transform = `translate(${shiftX}px, ${shiftY}px)`;
}

function settleCanvasResizeStageShift() {
    const drag = activeCanvasResizeDrag;
    if (!drag) return;

    const stage = el('canvasStage');
    const workspace = document.querySelector('.canvas-workspace');

    if (workspace) {
        workspace.scrollLeft -= Math.round(drag.viewShiftX || 0);
        workspace.scrollTop -= Math.round(drag.viewShiftY || 0);
    }

    if (stage) {
        stage.style.transform = '';
    }
}

function preserveCanvasResizeDisplayScale(width, height) {
    const drag = activeCanvasResizeDrag;
    if (!drag) return;

    const fitScale = getCanvasFitScale(width, height);
    canvasZoom = Math.min(
        CANVAS_ZOOM_MAX,
        Math.max(CANVAS_ZOOM_MIN, (drag.displayScale || fitScale) / Math.max(fitScale, 0.01))
    );
}

function applyCanvasResizeLayerOffsets(leftOffset, topOffset) {
    const drag = activeCanvasResizeDrag;
    if (!drag) return;

    (drag.layerStarts || []).forEach((start) => {
        const found = findCanvasLayer(start.id);
        const layer = found?.layer;
        if (!layer || layer.type === 'canvas') return;
        if (!Number.isFinite(Number(layer.x)) || !Number.isFinite(Number(layer.y))) return;

        layer.x = Math.round(start.x + leftOffset);
        layer.y = Math.round(start.y + topOffset);
    });
}

function handleCanvasResizeMouseMove(event) {
    if (!activeCanvasResizeDrag) return;

    const next = resolveCanvasResizeDragSize(event);
    if (!next) return;

    applyCanvasResizeLayerOffsets(next.leftOffset, next.topOffset);
    activeCanvasResizeDrag.currentLeftOffset = next.leftOffset;
    activeCanvasResizeDrag.currentTopOffset = next.topOffset;

    if (next.width !== currentCanvasWidth || next.height !== currentCanvasHeight) {
        resizeCurrentCanvasTo(next.width, next.height);
    } else {
        renderCanvasLayersOnSurface();
    }

    updateCanvasResizeStageShift(next.leftOffset, next.topOffset);
    updateCanvasResizeTooltip(event.clientX, event.clientY, next.width, next.height);
}

function handleCanvasResizeMouseUp(event) {
    if (!activeCanvasResizeDrag) return;

    const next = resolveCanvasResizeDragSize(event);

    const surface = el('canvasSurface');
    if (surface) surface.classList.remove('canvas-resize-dragging');

    if (next) {
        applyCanvasResizeLayerOffsets(next.leftOffset, next.topOffset);
        resizeCurrentCanvasTo(next.width, next.height);
        updateCanvasResizeStageShift(next.leftOffset, next.topOffset);
        preserveCanvasResizeDisplayScale(next.width, next.height);
    }

    settleCanvasResizeStageShift();
    activeCanvasResizeDrag = null;

    hideCanvasResizeTooltip();
    if (next) {
        renderCanvas(next.width, next.height);
    }
    renderLayerList();
    saveCanvasState();
}

function getImageResizeGuideOverlay() {
    let overlay = el('imageResizeGuideOverlay');

    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'imageResizeGuideOverlay';
        overlay.className = 'image-resize-guide-overlay';

        ['tl', 't', 'tr', 'r', 'br', 'b', 'bl', 'l'].forEach((handle) => {
            const node = document.createElement('div');
            node.className = `image-resize-guide-handle ${handle}`;
            overlay.appendChild(node);
        });

        document.body.appendChild(overlay);
    }

    return overlay;
}

function updateImageResizeGuideOverlay(bounds) {
    const surface = el('canvasSurface');
    if (!surface || !bounds) return;

    const rect = surface.getBoundingClientRect();
    const displayScale = getCanvasDisplayScale();
    const overlay = getImageResizeGuideOverlay();

    overlay.style.display = 'block';
    overlay.style.left = `${rect.left + bounds.x * displayScale}px`;
    overlay.style.top = `${rect.top + bounds.y * displayScale}px`;
    overlay.style.width = `${Math.max(1, bounds.width * displayScale)}px`;
    overlay.style.height = `${Math.max(1, bounds.height * displayScale)}px`;
}

function updateActiveImageResizeGuideOverlay() {
    const drag = activeImageResizeDrag;
    if (!drag) return;

    if (drag.mode === 'multi') {
        const layers = (drag.starts || [])
            .map((start) => findCanvasLayer(start.id)?.layer)
            .filter((layer) => isMultiTransformLayer(layer));
        updateImageResizeGuideOverlay(getTransformLayerBounds(layers));
        return;
    }

    const found = findCanvasLayer(drag.layerId);
    const layer = found?.layer;

    if (!layer || layer.type !== 'image') return;

    updateImageResizeGuideOverlay({
        x: Number(layer.x || 0),
        y: Number(layer.y || 0),
        width: Number(layer.layerWidth || layer.imageWidth || 1),
        height: Number(layer.layerHeight || layer.imageHeight || 1)
    });
}

function hideImageResizeGuideOverlay() {
    const overlay = el('imageResizeGuideOverlay');
    if (overlay) overlay.style.display = 'none';
}

function openCanvasSelectionContextMenu(event, selectionId) {
    event.preventDefault();
    event.stopPropagation();

    contextSelectionId = selectionId;
    activeLayerId = selectionId;
    activeClipSelectionId = selectionId;

    renderLayerList();
    renderCanvasLayersOnSurface();

    const menu = el('canvasSelectionContextMenu');
    if (!menu) return;

    closeCanvasImageLayerContextMenu();

    menu.style.display = 'block';

    const margin = 12;
    const menuWidth = menu.offsetWidth || 180;
    const menuHeight = menu.offsetHeight || 60;

    const left = Math.min(event.clientX, window.innerWidth - menuWidth - margin);
    const top = Math.min(event.clientY, window.innerHeight - menuHeight - margin);

    menu.style.left = `${Math.max(margin, left)}px`;
    menu.style.top = `${Math.max(margin, top)}px`;
}

function closeCanvasSelectionContextMenu() {
    const menu = el('canvasSelectionContextMenu');
    if (menu) menu.style.display = 'none';
}

function getClipOutputClipboardContextMenu(createIfMissing = true) {
    let menu = el('clipOutputClipboardContextMenu');

    if (!menu && createIfMissing) {
        menu = document.createElement('div');
        menu.id = 'clipOutputClipboardContextMenu';
        menu.className = 'canvas-layer-context-menu clip-output-clipboard-context-menu';
        menu.innerHTML = `
            <button class="canvas-layer-context-item" onclick="copyClipOutputToInternalClipboard()">
                복사
            </button>
            <button class="canvas-layer-context-item" onclick="pasteInternalClipboardToClipInpaintResults({ preferSystemClipboard: true, preferCurrentOutput: true })">
                가져오기
            </button>
        `;
        document.body.appendChild(menu);
    }

    return menu;
}

function openClipOutputClipboardContextMenu(event) {
    event.preventDefault();
    event.stopPropagation();

    const target = getClipOutputTarget();
    if (!target?.clip) return;

    activeClipSelectionId = target.selection.id;
    checkedSelectionId = target.selection.id;

    closeCanvasImageLayerContextMenu();
    closeCanvasSelectionContextMenu();
    closeCanvasSurfaceContextMenu();

    const menu = getClipOutputClipboardContextMenu();
    if (!menu) return;

    menu.style.display = 'block';

    const margin = 12;
    const menuWidth = menu.offsetWidth || 180;
    const menuHeight = menu.offsetHeight || 80;

    const left = Math.min(event.clientX, window.innerWidth - menuWidth - margin);
    const top = Math.min(event.clientY, window.innerHeight - menuHeight - margin);

    menu.style.left = `${Math.max(margin, left)}px`;
    menu.style.top = `${Math.max(margin, top)}px`;
}

function closeClipOutputClipboardContextMenu() {
    const menu = getClipOutputClipboardContextMenu(false);
    if (menu) menu.style.display = 'none';
}

function getCurrentClipOutputDisplayState() {
    const target = getClipOutputTarget();
    if (!target?.clip) return null;

    const previewClip = getTopVisibleInpaintClipForSelection(target.selection, target.clip);
    const showInpaintPreview = Boolean(isClipInpaintPreviewMode && previewClip);

    const mergedPreviewKey = isClipInpaintMergedSourceMode
        ? buildClipMergedSourcePreviewKey(target.selection, target.clip)
        : '';

    const hasMergedPreview =
        !showInpaintPreview &&
        isClipInpaintMergedSourceMode &&
        clipMergedSourcePreviewCache.key === mergedPreviewKey &&
        clipMergedSourcePreviewCache.dataUrl;

    const displayClip = showInpaintPreview && previewClip ? previewClip : target.clip;
    const displaySrc = hasMergedPreview ? clipMergedSourcePreviewCache.dataUrl : displayClip.src;

    return {
        selection: target.selection,
        baseClip: target.clip,
        displayClip,
        displaySrc,
        isMergedPreview: Boolean(hasMergedPreview)
    };
}

function clonePromptControlGroupsForClipboard(groups) {
    return Array.isArray(groups) ? structuredClone(groups) : [];
}

function buildClipboardPayloadFromClipOutputState(state) {
    if (!state?.displaySrc || !state.selection || !state.baseClip) return null;

    const sourceClip = state.displayClip || state.baseClip;

    return {
        src: state.displaySrc,
        clipId: sourceClip.id || null,
        sourceSelectionId: state.selection.id,
        sourcePath: sourceClip.sourcePath || '',
        promptOwnerId: sourceClip.promptOwnerId || state.baseClip.promptOwnerId || state.baseClip.id,
        promptInfo: normalizePromptInfo(sourceClip.promptInfo || state.baseClip.promptInfo || {}),
        promptControlGroups: clonePromptControlGroupsForClipboard(
            sourceClip.promptControlGroups || state.baseClip.promptControlGroups
        ),
        imageWidth: sourceClip.imageWidth || state.baseClip.imageWidth || state.selection.layerWidth,
        imageHeight: sourceClip.imageHeight || state.baseClip.imageHeight || state.selection.layerHeight,
        x: sourceClip.x ?? state.baseClip.x ?? sourceClip.sourceSelectionX ?? state.baseClip.sourceSelectionX ?? state.selection.x,
        y: sourceClip.y ?? state.baseClip.y ?? sourceClip.sourceSelectionY ?? state.baseClip.sourceSelectionY ?? state.selection.y,
        layerWidth: sourceClip.layerWidth || state.baseClip.layerWidth || state.selection.layerWidth,
        layerHeight: sourceClip.layerHeight || state.baseClip.layerHeight || state.selection.layerHeight,
        rotation: CanvasSelectionRotation.angle(sourceClip.rotation),
        copiedAt: Date.now(),
        isMergedPreview: state.isMergedPreview
    };
}

function buildExternalClipboardPayloadForClipOutput(imageDataUrl, state) {
    if (!imageDataUrl || !state?.selection || !state.baseClip) return null;

    // Match inpainting placement; a previewed result may have been moved or resized.
    const sourceClip = state.baseClip;

    return {
        src: imageDataUrl,
        clipId: null,
        sourceSelectionId: state.selection.id,
        sourcePath: '',
        promptOwnerId: state.baseClip.promptOwnerId || state.baseClip.id,
        promptInfo: normalizePromptInfo(state.baseClip.promptInfo || {}),
        promptControlGroups: clonePromptControlGroupsForClipboard(state.baseClip.promptControlGroups),
        imageWidth: sourceClip.imageWidth || state.baseClip.imageWidth || state.selection.layerWidth,
        imageHeight: sourceClip.imageHeight || state.baseClip.imageHeight || state.selection.layerHeight,
        x: sourceClip.x ?? state.baseClip.x ?? state.selection.x,
        y: sourceClip.y ?? state.baseClip.y ?? state.selection.y,
        layerWidth: sourceClip.layerWidth || state.baseClip.layerWidth || state.selection.layerWidth,
        layerHeight: sourceClip.layerHeight || state.baseClip.layerHeight || state.selection.layerHeight,
        rotation: CanvasSelectionRotation.angle(sourceClip.rotation),
        copiedAt: Date.now(),
        isExternalClipboard: true
    };
}

async function imageSourceToBlob(src) {
    const response = await fetch(src);
    const blob = await response.blob();

    if (blob.type && blob.type.startsWith('image/')) {
        return blob;
    }

    return new Blob([blob], { type: 'image/png' });
}

async function writeClipOutputToSystemClipboard(src) {
    if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
        throw new Error('현재 브라우저에서 이미지 클립보드 복사를 지원하지 않습니다.');
    }

    const blob = await imageSourceToBlob(src);
    await navigator.clipboard.write([
        new ClipboardItem({ [blob.type || 'image/png']: blob })
    ]);
}

async function copyClipOutputToInternalClipboard() {
    closeClipOutputClipboardContextMenu();

    const state = getCurrentClipOutputDisplayState();
    if (!state?.displaySrc) {
        alert('복사할 클립 결과가 없습니다.');
        return false;
    }

    clipOutputInternalClipboard = buildClipboardPayloadFromClipOutputState(state);

    try {
        await writeClipOutputToSystemClipboard(state.displaySrc);

        if (typeof showToast === 'function') {
            showToast('클립 결과를 클립보드에 복사했습니다.');
        }
    } catch (error) {
        alert(`복사 실패: ${error.message || error}`);
        return false;
    }

    return true;
}

async function pasteInternalClipboardToClipInpaintResults(options = {}) {
    closeClipOutputClipboardContextMenu();

    const state = getCurrentClipOutputDisplayState();
    if (!state?.selection || !state.baseClip) {
        alert('붙여넣을 선택 영역을 먼저 선택해 주세요.');
        return false;
    }

    const selection = state.selection;
    const baseClip = state.baseClip;
    normalizeSelectionAreaGeometry(selection);

    try {
        let clipboard = clipOutputInternalClipboard;

        if (options.externalImageFile || options.preferSystemClipboard) {
            const externalImageDataUrl = options.externalImageFile
                ? await blobToDataUrl(options.externalImageFile)
                : await readExternalCanvasImageDataUrlFromSystemClipboard();
            if (externalImageDataUrl) {
                clipboard = buildExternalClipboardPayloadForClipOutput(externalImageDataUrl, state);
            }
        }

        if (!clipboard?.src && options.preferCurrentOutput) {
            clipboard = buildClipboardPayloadFromClipOutputState(state);
        }

        if (!clipboard?.src) {
            alert('가져올 클립보드 이미지가 없습니다.');
            return false;
        }

        const pastedSrc = String(clipboard.src).startsWith('data:')
            ? await saveClipDataUrlToServer(clipboard.src)
            : clipboard.src;

        const inpaintFolder = getOrCreateSelectionInpaintFolder(selection);
        selection.hasInpaintResult = true;
        const pasteX = Number.isFinite(Number(clipboard.x))
            ? Number(clipboard.x)
            : Math.round(Number(baseClip.x ?? selection.x ?? 0));
        const pasteY = Number.isFinite(Number(clipboard.y))
            ? Number(clipboard.y)
            : Math.round(Number(baseClip.y ?? selection.y ?? 0));
        const pasteWidth = Number.isFinite(Number(clipboard.layerWidth))
            ? Number(clipboard.layerWidth)
            : Math.round(Number(baseClip.layerWidth || selection.layerWidth || clipboard.imageWidth || 1));
        const pasteHeight = Number.isFinite(Number(clipboard.layerHeight))
            ? Number(clipboard.layerHeight)
            : Math.round(Number(baseClip.layerHeight || selection.layerHeight || clipboard.imageHeight || 1));

        const resultClip = {
            id: layerIdSeq++,
            name: `인페인팅 ${inpaintFolder.children.filter((child) => child.type === 'clip').length + 1}`,
            visible: true,
            type: 'clip',
            renderOnCanvas: true,
            src: pastedSrc,
            sourceSelectionId: selection.id,
            sourceInternalClipboardClipId: clipboard.clipId || null,
            sourcePath: clipboard.sourcePath || baseClip.sourcePath || '',
            promptOwnerId: clipboard.promptOwnerId || baseClip.promptOwnerId || baseClip.id,
            promptInfo: normalizePromptInfo(clipboard.promptInfo || baseClip.promptInfo || {}),
            promptControlGroups: clonePromptControlGroupsForClipboard(
                clipboard.promptControlGroups || baseClip.promptControlGroups
            ),
            imageWidth: clipboard.imageWidth || baseClip.imageWidth || selection.layerWidth,
            imageHeight: clipboard.imageHeight || baseClip.imageHeight || selection.layerHeight,
            x: pasteX,
            y: pasteY,
            sourceSelectionX: pasteX,
            sourceSelectionY: pasteY,
            layerWidth: pasteWidth,
            layerHeight: pasteHeight,
            rotation: CanvasSelectionRotation.angle(clipboard.rotation),
            createdAt: Date.now()
        };

        inpaintFolder.children.unshift(resultClip);
        selection.expanded = true;

        clearClipMergedSourcePreviewCache();
        clipMergedSourcePreviewSeq += 1;
        migrateAllSelectionClipsToSharedPromptOwner(resultClip.promptOwnerId || baseClip.id);

        activeLayerId = resultClip.id;
        activeClipSelectionId = selection.id;
        checkedSelectionId = selection.id;
        isClipInpaintPreviewMode = true;

        renderLayerList();
        renderCanvasLayersOnSurface();
        renderClipOutputPanel();
        saveCanvasState();

        if (typeof showToast === 'function') {
            showToast('클립보드 이미지를 인페인팅 결과에 추가했습니다.');
        }

        return true;
    } catch (error) {
        alert(`가져오기 실패: ${error.message || error}`);
        return false;
    }
}

function toggleClipOutputSelectionOverlayVisibility() {
    isSelectionOverlayHidden = !isSelectionOverlayHidden;
    updateSelectionOverlayToggleUI();
    renderCanvasLayersOnSurface();
    saveCanvasState();
}

function getCanvasLayerRenderDiagnostics() {
    const displayScale = getCanvasDisplayScale();
    const surface = el('canvasSurface');
    const surfaceRect = surface?.getBoundingClientRect?.() || null;

    return getAllCanvasLayerNodes()
        .filter((layer) => layer && (layer.type === 'clip' || layer.type === 'image') && layer.src)
        .map((layer) => {
            const node = document.querySelector(`.canvas-render-layer[data-layer-id="${layer.id}"]`);
            const rect = node?.getBoundingClientRect?.() || null;
            const img = node?.querySelector?.('img') || null;

            return {
                id: layer.id,
                type: layer.type,
                name: layer.name,
                visible: layer.visible,
                renderOnCanvas: layer.renderOnCanvas,
                pinnedReference: layer.pinnedReference || false,
                src: layer.src,
                sourceInternalClipboardClipId: layer.sourceInternalClipboardClipId || null,
                sourceSelectionId: layer.sourceSelectionId || null,
                sourceSelectionX: layer.sourceSelectionX ?? null,
                sourceSelectionY: layer.sourceSelectionY ?? null,
                promptOwnerId: layer.promptOwnerId || null,
                imageWidth: layer.imageWidth,
                imageHeight: layer.imageHeight,
                x: layer.x,
                y: layer.y,
                layerWidth: layer.layerWidth,
                layerHeight: layer.layerHeight,
                cssLeft: node?.style?.left || '',
                cssTop: node?.style?.top || '',
                cssWidth: node?.style?.width || '',
                cssHeight: node?.style?.height || '',
                rectLeft: rect ? rect.left : null,
                rectTop: rect ? rect.top : null,
                rectWidth: rect ? rect.width : null,
                rectHeight: rect ? rect.height : null,
                surfaceRelativeLeft: rect && surfaceRect ? rect.left - surfaceRect.left : null,
                surfaceRelativeTop: rect && surfaceRect ? rect.top - surfaceRect.top : null,
                naturalWidth: img?.naturalWidth || null,
                naturalHeight: img?.naturalHeight || null,
                displayScale
            };
        });
}

window.debugCanvasLayerRenderDiagnostics = function debugCanvasLayerRenderDiagnostics() {
    const diagnostics = getCanvasLayerRenderDiagnostics();
    console.table(diagnostics);
    return diagnostics;
};

function isClipOutputKeyboardTargetActive() {
    if (isEditablePasteTarget(document.activeElement)) return false;

    const target = getClipOutputTarget();
    if (!target?.selection || !target.clip) return false;

    const selectionId = Number(target.selection.id);
    const clipId = Number(target.clip.id);

    return Number(activeClipSelectionId) === selectionId ||
        Number(checkedSelectionId) === selectionId ||
        Number(activeLayerId) === selectionId ||
        Number(activeLayerId) === clipId ||
        selectedLayerIds.has(selectionId) ||
        selectedLayerIds.has(clipId);
}

function handleClipOutputClipboardShortcut(event) {
    if (!event || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) {
        return false;
    }

    if (event.key.toLowerCase() === 'c') {
        if (!isClipOutputKeyboardTargetActive()) return false;
        event.preventDefault();
        copyClipOutputToInternalClipboard();
        return true;
    }

    // Ctrl+V is handled by the paste event, which includes external image bytes.
    return false;
}

async function clipSelectionFromContext() {
    closeCanvasSelectionContextMenu();

    const found = findCanvasLayer(contextSelectionId);
    const selection = found?.layer;

    if (!selection || selection.type !== 'selection') {
        alert('선택 영역을 찾을 수 없습니다.');
        return;
    }

    try {
        await createClipFromSelection(selection);
    } catch (error) {
        alert(`클립 실패: ${error.message || error}`);
    }
}

async function createClipFromSelection(selection) {
    normalizeSelectionAreaGeometry(selection);
    clipOutputPanelPosition = null;

    const rotated = CanvasSelectionRotation.angle(selection.rotation) !== 0;
    const bounds = rotated ? CanvasSelectionRotation.bounds(selection) : null;
    const cropX = Math.round(selection.x);
    const cropY = Math.round(selection.y);
    const cropWidth = Math.round(selection.layerWidth);
    const cropHeight = Math.round(selection.layerHeight);

    if (cropWidth <= 0 || cropHeight <= 0) {
        throw new Error('선택 영역 크기가 올바르지 않습니다.');
    }

    const offscreen = document.createElement('canvas');
    offscreen.width = cropWidth;
    offscreen.height = cropHeight;

    const ctx = offscreen.getContext('2d');
    ctx.clearRect(0, 0, cropWidth, cropHeight);

    // 캔버스 레이어가 보이면 흰 배경도 합성
    if (hasVisibleCanvasBaseLayer(canvasLayers)) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cropWidth, cropHeight);
    }

    // Unrotate world coordinates into the selection's original pixel dimensions.
    if (rotated) {
        ctx.translate(cropWidth / 2, cropHeight / 2);
        ctx.rotate(-CanvasSelectionRotation.angle(selection.rotation) * Math.PI / 180);
        ctx.translate(-cropWidth / 2, -cropHeight / 2);
    }

    const drawableLayers = collectDrawableImageLayersForClip(canvasLayers);

    for (const layer of drawableLayers) {
        normalizeImageLayerGeometry(layer);

        // 선택 영역과 전혀 겹치지 않으면 스킵
        const layerBounds = layer.type === 'clip' && layer.rotation ? CanvasSelectionRotation.bounds(layer) : layer;
        if (!rectsIntersect(
            bounds ? bounds.x : cropX,
            bounds ? bounds.y : cropY,
            bounds ? bounds.width : cropWidth,
            bounds ? bounds.height : cropHeight,
            layerBounds.x,
            layerBounds.y,
            layerBounds.width ?? layer.layerWidth,
            layerBounds.height ?? layer.layerHeight
        )) {
            continue;
        }

        const img = await loadImageElementForClip(layer.src);

        drawCanvasLayerImage(ctx, img, layer, cropX, cropY);
    }

    const dataUrl = offscreen.toDataURL('image/png');

    const savedSrc = await saveClipDataUrlToServer(dataUrl);

    const sourceLayerForPrompt = getPrimaryPromptSourceLayer(selection);

    const sourcePromptInfo = sourceLayerForPrompt?.promptInfo && hasAnyPromptText(sourceLayerForPrompt.promptInfo)
        ? normalizePromptInfo(sourceLayerForPrompt.promptInfo)
        : buildClipPromptInfoFromSelection(selection);

    let sharedPromptInfo = getSharedSelectionClipPromptInfo();

    // 공용 프롬프트가 비어 있으면 이미지 레이어/원본 메타데이터에서 자동 복구
    if (!hasAnyPromptText(sharedPromptInfo)) {
        const recoveredPromptInfo = await recoverSharedSelectionClipPromptFromAvailableSources(selection);

        if (hasAnyPromptText(recoveredPromptInfo)) {
            sharedPromptInfo = recoveredPromptInfo;
        }
    }

    const clipPromptInfo = hasAnyPromptText(sharedPromptInfo)
        ? sharedPromptInfo
        : sourcePromptInfo;

    if (!hasSharedSelectionClipPrompt() && hasAnyPromptText(clipPromptInfo)) {
        rememberSharedSelectionClipPrompt(
            clipPromptInfo,
            sourceLayerForPrompt?.promptControlGroups || []
        );
    }

    const promptOwnerId =
        sourceLayerForPrompt?.promptOwnerId ||
        sourceLayerForPrompt?.id ||
        null;

    const clipLayer = {
        id: layerIdSeq++,
        promptOwnerId,
        name: `클립 ${countSelectionClipChildren(selection) + 1}`,
        visible: true,
        type: 'clip',
        src: savedSrc,
        sourceSelectionId: selection.id,
        sourcePath: sourceLayerForPrompt?.sourcePath || '',
        promptInfo: clipPromptInfo,
        promptControlGroups: Array.isArray(sourceLayerForPrompt?.promptControlGroups)
            ? structuredClone(sourceLayerForPrompt.promptControlGroups)
            : [],
        imageWidth: cropWidth,
        imageHeight: cropHeight,
        x: cropX,
        y: cropY,
        sourceSelectionX: Math.round(selection.x),
        sourceSelectionY: Math.round(selection.y),
        rotation: CanvasSelectionRotation.angle(selection.rotation),
        layerWidth: cropWidth,
        layerHeight: cropHeight,
        createdAt: Date.now()
    };

    selection.children = Array.isArray(selection.children) ? selection.children : [];
    selection.children.unshift(clipLayer);
    selection.expanded = true;

    // 새 클립이 생기면 전체 선택 영역 클립을 다시 공용 프롬프트 owner에 묶는다.
    migrateAllSelectionClipsToSharedPromptOwner(clipLayer.id);

    activeLayerId = clipLayer.id;
    activeClipSelectionId = selection.id;
    checkedSelectionId = selection.id;

    renderLayerList();
    renderCanvasLayersOnSurface();
    saveCanvasState();
}

async function dataUrlToBlob(dataUrl) {
    const response = await fetch(dataUrl);
    return await response.blob();
}

async function copyMergedCanvasImageToClipboard() {
    closeCanvasSurfaceContextMenu();

    if (!currentCanvasWidth || !currentCanvasHeight) {
        alert('먼저 캔버스를 생성해 주세요.');
        return;
    }

    if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
        alert('현재 브라우저에서 이미지 클립보드 복사를 지원하지 않습니다.');
        return;
    }

    try {
        const dataUrl = await renderMergedCanvasToDataUrl();
        const blob = await dataUrlToBlob(dataUrl);

        await navigator.clipboard.write([
            new ClipboardItem({ [blob.type || 'image/png']: blob })
        ]);

        if (typeof showToast === 'function') {
            showToast('캔버스 통합본을 클립보드에 복사했습니다.');
        } else {
            alert('캔버스 통합본을 클립보드에 복사했습니다.');
        }
    } catch (error) {
        alert(`복사 실패: ${error.message || error}`);
    }
}

function buildMergedCanvasDownloadName() {
    const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .replace('T', '_')
        .slice(0, 19);

    const width = Math.max(1, Number(currentCanvasWidth) || 0);
    const height = Math.max(1, Number(currentCanvasHeight) || 0);
    return `NAI_canvas_${width}x${height}_${stamp}.png`;
}

async function downloadMergedCanvasImage() {
    if (!currentCanvasWidth || !currentCanvasHeight) {
        alert('먼저 캔버스를 생성해 주세요.');
        return;
    }

    const button = el('externalCanvasImageExportBtn');
    if (button) {
        button.disabled = true;
        button.dataset.originalText = button.innerText;
        button.innerText = '내보내는 중...';
    }

    try {
        const dataUrl = await renderMergedCanvasToDataUrl();
        const projectName = await window.CanvasProject?.suggestDownloadName?.();
        const link = document.createElement('a');
        link.href = dataUrl;
        link.download = projectName || buildMergedCanvasDownloadName();
        document.body.appendChild(link);
        link.click();
        link.remove();

        if (typeof showToast === 'function') {
            showToast('캔버스 통합본 다운로드를 시작했습니다.');
        }
    } catch (error) {
        alert(`외부 이미지 내보내기 실패: ${error.message || error}`);
    } finally {
        if (button) {
            button.disabled = false;
            button.innerText = button.dataset.originalText || '💾 외부 이미지 내보내기';
            delete button.dataset.originalText;
        }
    }
}

async function buildMergedOnlyCanvasStateSnapshot(dataUrl = null, exportedPromptInfo = null) {
    dataUrl = dataUrl || await renderMergedCanvasToDataUrl();

    if (!dataUrl) {
        throw new Error('통합 이미지를 만들지 못했습니다.');
    }

    const mergedSrc = await saveClipDataUrlToServer(dataUrl);
    const promptInfo = exportedPromptInfo || getCanvasExportPromptInfo();

    const imageLayerId = 1;
    const baseLayerId = 2;

    return {
        version: 2,
        savedAt: Date.now(),
        width: currentCanvasWidth,
        height: currentCanvasHeight,
        layers: [
            {
                id: imageLayerId,
                promptOwnerId: imageLayerId,
                name: '통합 이미지',
                visible: true,
                type: 'image',
                src: mergedSrc,
                sourcePath: '',
                promptInfo,
                promptControlGroups: [],
                imageWidth: currentCanvasWidth,
                imageHeight: currentCanvasHeight,
                x: 0,
                y: 0,
                layerWidth: currentCanvasWidth,
                layerHeight: currentCanvasHeight
            },
            {
                id: baseLayerId,
                name: `캔버스 ${currentCanvasWidth}×${currentCanvasHeight}`,
                visible: true,
                type: 'canvas',
                src: '',
                canvasWidth: currentCanvasWidth,
                canvasHeight: currentCanvasHeight
            }
        ],
        activeLayerId: imageLayerId,
        layerIdSeq: 3,
        styleLink: typeof getCanvasStyleLink === 'function' ? getCanvasStyleLink()?.snapshot() : undefined,
        projectSettingsLink: typeof CanvasProjectSettings !== 'undefined' ? CanvasProjectSettings.snapshot() : undefined,
        oppositeReference: typeof CanvasOppositeReference !== 'undefined' ? CanvasOppositeReference.snapshot() : undefined,
        inpaintReference: typeof CanvasInpaintReference !== 'undefined' ? CanvasInpaintReference.snapshot() : undefined,
        inpaintSettings: typeof CanvasInpaintSettings !== 'undefined'
            ? CanvasInpaintSettings.snapshot()
            : null,
        isSelectionOverlayHidden: false,
        checkedSelectionId: null,
        canvasZoom: 1,
        clipPreviewZoom: typeof clipPreviewZoom !== 'undefined' ? clipPreviewZoom : 1
    };
}

function getPrimaryPromptSourceLayer(selection) {
    const sourceLayers = collectPromptSourceLayersFromSelection(selection);

    return sourceLayers.find((layer) => {
        return (layer.promptInfo && hasAnyPromptText(layer.promptInfo)) || layer.sourcePath;
    }) || sourceLayers[0] || null;
}

function countSelectionClipChildren(selection) {
    if (!selection || !Array.isArray(selection.children)) return 0;
    return selection.children.filter((child) => child.type === 'clip').length;
}

function rectsIntersect(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw &&
           ax + aw > bx &&
           ay < by + bh &&
           ay + ah > by;
}

async function saveClipDataUrlToServer(dataUrl, options = {}) {
    const response = await fetch('/api/canvas/import_base64', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            image: dataUrl,
            category: options.category || 'canvas',
            sessionId: options.sessionId || CANVAS_IMPORT_SESSION_ID
        })
    });

    const data = await response.json();

    if (!response.ok || data.status !== 'success') {
        throw new Error(data.message || '클립 이미지를 저장하지 못했습니다.');
    }

    return data.src;
}

function findSelectionWithVisibleClip(layers = canvasLayers) {
    for (const layer of layers) {
        if (layer.type === 'selection') {
            layer.children = Array.isArray(layer.children) ? layer.children : [];

            const visibleClip = findFirstVisibleClipInSelection(layer);
            if (visibleClip) {
                return {
                    selection: layer,
                    clip: visibleClip
                };
            }

            const nested = findSelectionWithVisibleClip(layer.children);
            if (nested) return nested;
        }

        if (layer.type === 'folder' && Array.isArray(layer.children)) {
            const nested = findSelectionWithVisibleClip(layer.children);
            if (nested) return nested;
        }
    }

    return null;
}

function findFirstVisibleClipInSelection(selection) {
    if (!selection) return null;
    const children = Array.isArray(selection.children) ? selection.children : [];

    for (const child of children) {
        if (child.type === 'clip' && child.visible && child.src) {
            return child;
        }

        if ((child.type === 'folder' || child.type === 'selection') && Array.isArray(child.children)) {
            const nestedClip = findFirstVisibleClipInSelection(child);
            if (nestedClip) return nestedClip;
        }
    }

    return null;
}

function getEditableClipForSelection(selection) {
    if (!selection || !Array.isArray(selection.children)) return null;

    // 원본 클립은 renderOnCanvas가 없는 clip.
    // 인페인팅 결과 clip은 renderOnCanvas: true라서 제외.
    const directClip = selection.children.find((child) => {
        return child.type === 'clip' &&
            child.visible &&
            child.src &&
            !child.renderOnCanvas;
    });

    if (directClip) return directClip;

    // fallback
    return selection.children.find((child) => {
        return child.type === 'clip' &&
            child.visible &&
            child.src;
    }) || null;
}

function getClipOutputTarget() {
    ensureCheckedSelectionId();

    if (checkedSelectionId) {
        const checkedFound = findCanvasLayer(checkedSelectionId);
        const checkedSelection = checkedFound?.layer;

        if (checkedSelection?.type === 'selection') {
            const clip = getEditableClipForSelection(checkedSelection);

            if (!clip) return null;

            return {
                selection: checkedSelection,
                clip
            };
        }
    }

    return null;
}

function setClipInpaintProcessing(clipId, isLoading, message = '인페인팅 처리 중...') {
    if (!isLoading && clipInpaintLoadingClipId !== clipId) return;
    clipInpaintLoadingClipId = isLoading ? clipId : null;
    clipInpaintLoadingMessage = message || '인페인팅 처리 중...';

    syncClipInpaintProcessing(el('canvasStage')?.querySelector('.canvas-clip-output-panel'));
}

function syncClipInpaintProcessing(panel) {
    if (!panel) return;
    const isLoading = clipInpaintLoadingClipId !== null &&
        Number(panel.dataset.clipId) === Number(clipInpaintLoadingClipId);
    const overlay = panel.querySelector('.clip-inpaint-loading');
    overlay.classList.toggle('show', isLoading);
    overlay.setAttribute('aria-hidden', String(!isLoading));
    panel.querySelector('.clip-inpaint-loading-text').textContent = clipInpaintLoadingMessage;
    panel.querySelector('.canvas-clip-output-image-wrap').setAttribute('aria-busy', String(isLoading));
    const button = panel.querySelector('.clip-inpaint-run-btn');
    button.disabled = clipInpaintLoadingClipId !== null;
    button.textContent = isLoading ? '생성 중…' : '인페인팅';
}

function animateClipInpaintResult(resultId) {
    const images = [...document.querySelectorAll(`.canvas-render-layer[data-layer-id="${Number(resultId)}"] img`)];
    const wrap = el('canvasStage')?.querySelector('.canvas-clip-output-image-wrap');
    if (Number(wrap?.dataset.displayClipId) === Number(resultId)) {
        const image = wrap.querySelector('.clip-output-image');
        if (image) images.push(image);
    }
    images.forEach(image => {
        const reveal = () => {
            if (image.isConnected) image.classList.add('clip-inpaint-result-reveal');
        };
        if (image.complete && image.naturalWidth > 0) reveal();
        else image.addEventListener('load', reveal, {once: true});
    });
}

function getClipSourceSelectionPosition(clip) {
    if (!clip) return null;

    const x = Number.isFinite(Number(clip.sourceSelectionX))
        ? Number(clip.sourceSelectionX)
        : Number(clip.x);
    const y = Number.isFinite(Number(clip.sourceSelectionY))
        ? Number(clip.sourceSelectionY)
        : Number(clip.y);

    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

    return { x, y };
}

function restoreSelectionPositionToClipOutput() {
    const target = getClipOutputTarget();
    const selection = target?.selection;
    const clip = target?.clip;
    const sourcePosition = getClipSourceSelectionPosition(clip);

    if (!selection || !clip || !sourcePosition) {
        alert('되돌릴 클립 위치를 찾을 수 없습니다.');
        return false;
    }

    normalizeSelectionAreaGeometry(selection);

    const dx = sourcePosition.x - Number(selection.x || 0);
    const dy = sourcePosition.y - Number(selection.y || 0);

    if (!dx && !dy) {
        return true;
    }

    const childStarts = buildSelectionChildMoveStarts([selection]);

    selection.x = snapCanvasMovePosition(sourcePosition.x);
    selection.y = snapCanvasMovePosition(sourcePosition.y);

    childStarts.forEach((start) => {
        const found = findCanvasLayer(start.id);
        const child = found?.layer;
        if (!isSelectionChildMovableLayer(child)) return;

        child.x = snapCanvasMovePosition(start.x + dx);
        child.y = snapCanvasMovePosition(start.y + dy);
    });

    checkedSelectionId = selection.id;
    activeClipSelectionId = selection.id;
    activeLayerId = selection.id;
    clipOutputPanelPosition = null;

    renderLayerList();
    renderCanvasLayersOnSurface();
    renderClipOutputPanel();
    saveCanvasState();

    return true;
}

function getClipOutputPanelDefaultPosition(selection) {
    if (!selection) return { canvasLeft: 0, canvasTop: 0 };

    normalizeSelectionAreaGeometry(selection);

    return {
        canvasLeft: selection.x + selection.layerWidth,
        canvasTop: selection.y
    };
}

function positionClipOutputPanel(panel, selection, clip) {
    if (!panel || !selection || !clip) return;

    const targetKey = `${selection.id}:${clip.id}`;
    const displayScale = getCanvasDisplayScale();
    const gap = 18;

    if (!clipOutputPanelPosition || clipOutputPanelPosition.targetKey !== targetKey) {
        const next = getClipOutputPanelDefaultPosition(selection);
        clipOutputPanelPosition = {
            targetKey,
            canvasLeft: next.canvasLeft,
            canvasTop: next.canvasTop,
            custom: false
        };
    }

    panel.style.left = `${Math.round(clipOutputPanelPosition.canvasLeft * displayScale + gap)}px`;
    panel.style.top = `${Math.round(clipOutputPanelPosition.canvasTop * displayScale)}px`;
    keepDefaultClipOutputPanelVisible(panel);
}

function keepDefaultClipOutputPanelVisible(panel) {
    if (!panel) return;
    const workspace = panel.closest('.canvas-workspace');
    if (!workspace || !workspace.clientWidth || !workspace.clientHeight) return;

    const workspaceRect = workspace.getBoundingClientRect();
    // The workspace can extend below a short browser window. Keep the resize corner reachable.
    const visibleWidth = Math.min(workspace.clientWidth, window.innerWidth - workspaceRect.left - workspace.clientLeft);
    const visibleHeight = Math.min(workspace.clientHeight, window.innerHeight - workspaceRect.top - workspace.clientTop);
    panel.style.maxWidth = `${Math.max(420, visibleWidth - 16)}px`;
    panel.style.maxHeight = `${Math.max(340, visibleHeight - 16)}px`;
    if (clipOutputPanelPosition?.custom) return;
    const panelRect = panel.getBoundingClientRect();
    const inset = 8;
    const left = workspaceRect.left + workspace.clientLeft + inset;
    const top = workspaceRect.top + workspace.clientTop + inset;
    const maxLeft = Math.max(left, left + visibleWidth - inset * 2 - panelRect.width);
    const maxTop = Math.max(top, top + visibleHeight - inset * 2 - panelRect.height);
    const nextLeft = Math.max(left, Math.min(maxLeft, panelRect.left));
    const nextTop = Math.max(top, Math.min(maxTop, panelRect.top));

    // Move only the floating UI; original canvas coordinates and user drag positions stay intact.
    panel.style.left = `${Math.round((parseFloat(panel.style.left) || 0) + nextLeft - panelRect.left)}px`;
    panel.style.top = `${Math.round((parseFloat(panel.style.top) || 0) + nextTop - panelRect.top)}px`;
}

function bindClipOutputPanelDrag(panel) {
    if (!panel || panel.dataset.clipOutputPanelDragBound === '1') return;

    panel.dataset.clipOutputPanelDragBound = '1';

    const title = panel.querySelector('.canvas-clip-output-title');
    if (!title) return;

    title.onmousedown = (event) => startClipOutputPanelDrag(event, panel);
}

function getClipOutputViewportSize(wrap) {
    const bounds = wrap.getBoundingClientRect();
    const style = getComputedStyle(wrap);
    // Exclude borders, but not transient scrollbars from the previous image size.
    return {
        width: Math.max(0, Math.floor(bounds.width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth))),
        height: Math.max(0, Math.floor(bounds.height - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth)))
    };
}

function fitClipOutputPanelToImage(panel, clip) {
    const wrap = panel.querySelector('.canvas-clip-output-image-wrap');
    if (!wrap || !clip) return;
    const naturalWidth = Math.max(1, Number(clip.imageWidth) || 512);
    const naturalHeight = Math.max(1, Number(clip.imageHeight) || 512);
    const maxWidth = Math.min(546, parseFloat(panel.style.maxWidth) || window.innerWidth - 32);
    const maxHeight = parseFloat(panel.style.maxHeight) || window.innerHeight - 32;
    panel.dataset.manualSize = '';
    panel.classList.remove('compact');
    panel.style.width = `${maxWidth}px`;
    panel.style.height = 'auto';
    // With a zero flex basis the viewport contributes only its borders here.
    const viewport = getClipOutputViewportSize(wrap);
    const bounds = panel.getBoundingClientRect();
    const chromeWidth = bounds.width - viewport.width;
    const chromeHeight = bounds.height - viewport.height;
    const scale = Math.min(1, Math.max(1, maxWidth - chromeWidth) / naturalWidth,
        Math.max(1, maxHeight - chromeHeight) / naturalHeight);
    panel.style.width = `${Math.max(Math.min(420, maxWidth), Math.floor(naturalWidth * scale) + chromeWidth)}px`;
    panel.style.height = `${Math.floor(naturalHeight * scale) + chromeHeight}px`;
}

function getClipOutputResizeScale(width, height, dx, dy) {
    const horizontal = dx / Math.max(1, width);
    const vertical = dy / Math.max(1, height);
    return 1 + (Math.abs(horizontal) >= Math.abs(vertical) ? horizontal : vertical);
}

function bindClipOutputPanelResize(panel, clip, syncOverlay) {
    const handle = panel.querySelector('.clip-output-resize-handle');
    const reset = panel.querySelector('.clip-output-auto-size');
    const wrap = panel.querySelector('.canvas-clip-output-image-wrap');
    if (!handle || !wrap) return () => {};
    let drag = null;
    const measure = () => {
        const viewport = getClipOutputViewportSize(wrap);
        return {...viewport, chromeWidth: panel.getBoundingClientRect().width - viewport.width};
    };
    const resize = (start, factor) => {
        const maxWidth = parseFloat(panel.style.maxWidth) || window.innerWidth - 32;
        const maxHeight = parseFloat(panel.style.maxHeight) || window.innerHeight - 32;
        const minFactor = Math.max((320 - start.chromeWidth) / start.width, 64 / start.height);
        factor = Math.max(minFactor, Math.min(factor, (maxWidth - start.chromeWidth) / start.width));
        const setWidth = () => {
            const width = start.width * factor + start.chromeWidth;
            panel.classList.toggle('compact', width < 420);
            panel.style.width = `${width}px`;
        };
        setWidth();
        // Compact toolbars have a second row; keep that chrome out of image scaling.
        let chromeHeight = panel.getBoundingClientRect().height - getClipOutputViewportSize(wrap).height;
        factor = Math.min(factor, Math.max(1, maxHeight - chromeHeight) / start.height);
        factor = Math.max(minFactor, factor);
        setWidth();
        chromeHeight = panel.getBoundingClientRect().height - getClipOutputViewportSize(wrap).height;
        panel.style.height = `${Math.min(maxHeight, start.height * factor + chromeHeight)}px`;
        panel.dataset.manualSize = '1';
        syncOverlay();
    };
    const stop = () => {
        if (drag) {
            try { handle.releasePointerCapture(drag.pointerId); } catch (_) {}
        }
        drag = null;
        panel.classList.remove('resizing');
    };
    const autoSize = () => {
        stop();
        fitClipOutputPanelToImage(panel, clip);
        syncOverlay();
    };
    handle.onpointerdown = (event) => {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        drag = {...measure(), pointerId: event.pointerId, x: event.clientX, y: event.clientY};
        handle.setPointerCapture(event.pointerId);
        panel.classList.add('resizing');
    };
    handle.onpointermove = (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        event.preventDefault(); event.stopPropagation();
        resize(drag, getClipOutputResizeScale(drag.width, drag.height, event.clientX - drag.x, event.clientY - drag.y));
    };
    handle.onpointerup = handle.onpointercancel = handle.onlostpointercapture = stop;
    handle.onkeydown = (event) => {
        if (event.key === 'Home') { event.preventDefault(); autoSize(); return; }
        const delta = {ArrowRight: 16, ArrowDown: 16, ArrowLeft: -16, ArrowUp: -16}[event.key];
        if (!delta) return;
        event.preventDefault(); event.stopPropagation();
        const start = measure();
        resize(start, 1 + delta / start.width);
    };
    if (reset) reset.onclick = autoSize;
    return () => {
        stop();
        handle.onpointerdown = handle.onpointermove = handle.onpointerup = null;
        handle.onpointercancel = handle.onlostpointercapture = handle.onkeydown = null;
        if (reset) reset.onclick = null;
    };
}

function startClipOutputPanelDrag(event, panel) {
    if (!panel || event.button !== 0) return;

    event.preventDefault();
    event.stopPropagation();

    activeClipOutputPanelDrag = {
        panel,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startLeft: parseFloat(panel.style.left) || panel.offsetLeft || 0,
        startTop: parseFloat(panel.style.top) || panel.offsetTop || 0
    };

    panel.classList.add('dragging');
}

function handleClipOutputPanelDragMove(event) {
    if (!activeClipOutputPanelDrag) return;

    event.preventDefault();

    const drag = activeClipOutputPanelDrag;
    const displayScale = Math.max(getCanvasDisplayScale(), 0.01);
    const gap = 18;
    // A default panel may sit left of the stage after viewport clamping.
    // Keep that starting position reachable so its first drag does not jump.
    const nextLeft = Math.max(Math.min(0, drag.startLeft), Math.round(drag.startLeft + event.clientX - drag.startClientX));
    const nextTop = Math.round(drag.startTop + event.clientY - drag.startClientY);

    drag.panel.style.left = `${nextLeft}px`;
    drag.panel.style.top = `${nextTop}px`;

    clipOutputPanelPosition = {
        ...(clipOutputPanelPosition || {}),
        canvasLeft: drag.startLeft < 0 ? (nextLeft - gap) / displayScale : Math.max(0, (nextLeft - gap) / displayScale),
        canvasTop: nextTop / displayScale,
        custom: true
    };
}

function stopClipOutputPanelDrag() {
    if (!activeClipOutputPanelDrag) return;

    activeClipOutputPanelDrag.panel?.classList.remove('dragging');
    activeClipOutputPanelDrag = null;
}

function renderClipOutputPanel() {
    disposeClipMaskEditor();
    const stage = el('canvasStage');
    if (!stage) return;

    const oldPanel = stage.querySelector('.canvas-clip-output-panel');
    const oldOutputWrap = oldPanel?.querySelector('.canvas-clip-output-image-wrap');
    const previousPreviewScroll = oldOutputWrap
        ? {left: oldOutputWrap.scrollLeft, top: oldOutputWrap.scrollTop}
        : null;
    if (oldPanel) oldPanel.remove();

    const target = getClipOutputTarget();

    if (!target || !target.clip) {
        stage.classList.remove('has-clip-output');
        if (typeof CanvasInpaintReference !== 'undefined') CanvasInpaintReference.render();
        return;
    }

    stage.classList.add('has-clip-output');

    const panel = document.createElement('div');
    panel.className = 'canvas-clip-output-panel';
    panel.dataset.clipId = String(target.clip.id);
    panel.dataset.clipSizeKey = `${target.selection.id}:${target.clip.id}:${target.clip.imageWidth}x${target.clip.imageHeight}`;
    // Retain a manual size only for the same clip, never for a new selection/image.
    if (oldPanel?.dataset.clipSizeKey === panel.dataset.clipSizeKey && oldPanel.dataset.manualSize === '1') {
        panel.dataset.manualSize = '1';
        panel.style.width = oldPanel.style.width;
        panel.style.height = oldPanel.style.height;
        panel.classList.toggle('compact', oldPanel.classList.contains('compact'));
    }

    const previewClip = getTopVisibleInpaintClipForSelection(target.selection, target.clip);
    const showInpaintPreview = Boolean(isClipInpaintPreviewMode && previewClip);

    // 결과 보기는 요청 소스의 통합 설정과 독립적으로 전환한다.
    const mergedPreviewKey = isClipInpaintMergedSourceMode
        ? buildClipMergedSourcePreviewKey(target.selection, target.clip)
        : '';

    const hasMergedPreview =
        !showInpaintPreview &&
        isClipInpaintMergedSourceMode &&
        clipMergedSourcePreviewCache.key === mergedPreviewKey &&
        clipMergedSourcePreviewCache.dataUrl;

    if (isClipInpaintMergedSourceMode && !showInpaintPreview && !hasMergedPreview) {
        ensureClipMergedSourcePreview(target.selection, target.clip);
    }

    const displayClip = showInpaintPreview && previewClip
        ? previewClip
        : {
            ...target.clip,
            src: hasMergedPreview
                ? clipMergedSourcePreviewCache.dataUrl
                : target.clip.src
        };

    const imageWrapClass = showInpaintPreview
        ? 'canvas-clip-output-image-wrap mask-editor preview-mode'
        : 'canvas-clip-output-image-wrap mask-editor';

    if (isClipInpaintPreviewMode && !previewClip) {
        isClipInpaintPreviewMode = false;
    }

    const isLoading = clipInpaintLoadingClipId === target.clip.id;

    panel.innerHTML = `
        <div class="canvas-clip-output-title">클립 결과 <span class="clip-output-drag-hint">드래그로 이동</span></div>
        <div class="canvas-clip-output-meta">
            <span class="clip-output-selection-name" title="${escapeHtml(target.selection.name || '선택 영역')}">${escapeHtml(target.selection.name || '선택 영역')}</span>
            <span>${displayClip.imageWidth} × ${displayClip.imageHeight}px</span>
            <span class="clip-preview-zoom-readout">${Math.round(clipPreviewZoom * 100)}%</span>
            ${
                showInpaintPreview && previewClip
                    ? `<span class="clip-preview-mode-label" title="인페인팅 보기: ${escapeHtml(previewClip.name || '결과')}">인페인팅 보기: ${escapeHtml(previewClip.name || '결과')}</span>`
                    : isClipInpaintMergedSourceMode
                        ? `<span class="clip-preview-mode-label">${hasMergedPreview ? '통합 소스 보기' : '통합 소스 생성 중...'}</span>`
                        : `<span class="clip-preview-mode-label">마스크 편집 보기</span>`
            }
        </div>

        <div class="canvas-clip-output-toolbar">
            <div class="clip-output-tools-row" role="group" aria-label="클립 편집 도구">
            <div class="clip-mask-tool-control ${openClipMaskSizeTool === 'brush' ? 'open' : ''}">
                <button class="clip-mask-tool-btn clip-mask-tool-labeled ${activeClipMaskTool === 'brush' ? 'active' : ''}"
                        title="브러시"
                        aria-pressed="${activeClipMaskTool === 'brush'}"
                        onclick="toggleClipMaskToolSizePopover('brush', event)">
                    브러시
                </button>
                <div class="clip-brush-size-popover">
                    <input type="range"
                        min="${CLIP_MASK_BRUSH_MIN}"
                        max="${CLIP_MASK_BRUSH_MAX}"
                        step="${CLIP_MASK_BRUSH_STEP}"
                        value="${clipMaskBrushSize}"
                        oninput="setClipMaskBrushSize(this.value)">
                    <div class="clip-brush-size-readout">${clipMaskBrushSize}px</div>
                </div>
            </div>

            <div class="clip-mask-tool-control ${openClipMaskSizeTool === 'eraser' ? 'open' : ''}">
                <button class="clip-mask-tool-btn clip-mask-tool-labeled ${activeClipMaskTool === 'eraser' ? 'active' : ''}"
                        title="지우개"
                        aria-pressed="${activeClipMaskTool === 'eraser'}"
                        onclick="toggleClipMaskToolSizePopover('eraser', event)">
                    지우개
                </button>
                <div class="clip-brush-size-popover">
                    <input type="range"
                        min="${CLIP_MASK_BRUSH_MIN}"
                        max="${CLIP_MASK_BRUSH_MAX}"
                        step="${CLIP_MASK_BRUSH_STEP}"
                        value="${clipMaskBrushSize}"
                        oninput="setClipMaskBrushSize(this.value)">
                    <div class="clip-brush-size-readout">${clipMaskBrushSize}px</div>
                </div>
            </div>

            <button class="clip-mask-tool-btn clip-mask-tool-labeled ${showInpaintPreview ? 'active' : ''}"
                    title="인페인팅 결과 보기 토글"
                    aria-pressed="${showInpaintPreview}"
                    onclick="toggleClipInpaintPreview()">
                결과 보기
            </button>

            <button class="clip-mask-tool-btn selection-overlay-toggle ${isSelectionOverlayHidden ? '' : 'active'}"
                    title="선택 영역 박스 표시 전환"
                    onclick="toggleClipOutputSelectionOverlayVisibility()">
                ${isSelectionOverlayHidden ? '선택 OFF' : '선택 ON'}
            </button>

            <button class="clip-mask-tool-btn restore-position"
                    title="선택 영역과 함께 이동한 그림을 클립한 원래 위치로 되돌리기"
                    onclick="restoreSelectionPositionToClipOutput()">
                위치
            </button>

            <button class="clip-mask-tool-btn clip-mask-tool-labeled auto-mask ${activeClipAutoMaskPickClipId === target.clip.id ? 'active' : ''}"
                    title="클릭한 그림 레이어 기준으로 위 레이어 영역을 제외해 자동 선택"
                    aria-pressed="${activeClipAutoMaskPickClipId === target.clip.id}"
                    onclick="toggleClipAutoMaskPickMode(${target.clip.id})">
                자동 선택
            </button>
            </div>

            <div class="clip-output-actions-row" role="group" aria-label="인페인팅 설정과 실행">
            <button class="clip-mask-tool-btn clip-mask-tool-labeled prompt-btn"
                    title="프롬프트"
                    onclick="openClipPromptModal(${target.clip.id})">
                프롬프트
            </button>

            <button class="clip-mask-tool-btn merged-source-toggle ${isClipInpaintMergedSourceMode ? 'active' : ''}"
                    title="ON: 클립 이미지와 인페인팅 결과를 통합한 이미지에 마스크를 적용해서 요청 / OFF: 기존처럼 클립 이미지와 마스크만 요청"
                    onclick="toggleClipInpaintMergedSourceMode()">
                통합 ${isClipInpaintMergedSourceMode ? 'ON' : 'OFF'}
            </button>

            <button class="clip-mask-tool-btn clip-mask-tool-labeled clip-inpaint-run-btn"
                    title="인페인팅"
                    onclick="requestClipInpainting(${target.clip.id})">
                인페인팅
            </button>
            </div>
        </div>

        <div class="${imageWrapClass}" data-clip-id="${target.clip.id}">
            <img class="clip-output-image" src="${escapeHtml(displayClip.src)}" alt="clip result">
            <canvas class="clip-mask-overlay-canvas"></canvas>

            <div class="clip-inpaint-loading ${isLoading ? 'show' : ''}" aria-hidden="${!isLoading}">
                <div class="clip-inpaint-loading-spinner" aria-hidden="true"></div>
                <div class="clip-inpaint-loading-text" role="status" aria-live="polite">${escapeHtml(clipInpaintLoadingMessage)}</div>
                <div class="clip-inpaint-loading-track" aria-hidden="true"></div>
            </div>
        </div>
        <div class="clip-output-size-actions">
            <button type="button" class="secondary clip-output-auto-size" title="클립 이미지에 맞는 자동 크기로 되돌리기">자동 크기</button>
            <span class="clip-output-resize-hint">모서리 드래그: 창·이미지 함께 조절</span>
        </div>
        <button type="button" class="clip-output-resize-handle" aria-label="클립 창과 이미지 크기 조절" title="비율을 유지하며 크기 조절 · 방향키로 조절 · Home: 자동 크기">◢</button>
    `;

    stage.appendChild(panel);
    if (typeof CanvasInpaintReference !== 'undefined') {
        CanvasInpaintReference.mountActions(panel.querySelector('.clip-output-actions-row'));
        CanvasInpaintReference.render();
    }
    positionClipOutputPanel(panel, target.selection, target.clip);
    if (panel.dataset.manualSize !== '1') fitClipOutputPanelToImage(panel, target.clip);
    keepDefaultClipOutputPanelVisible(panel);
    bindClipOutputPanelDrag(panel);

    const outputWrap = panel.querySelector('.canvas-clip-output-image-wrap');
    if (outputWrap) {
        outputWrap.dataset.displaySrc = displayClip.src || '';
        outputWrap.dataset.displayClipId = String(displayClip.id || target.clip.id || '');
    }

    bindClipMaskEditor(panel, target.clip);
    syncClipInpaintProcessing(panel);
    if (previousPreviewScroll && oldPanel.dataset.clipSizeKey === panel.dataset.clipSizeKey && outputWrap) {
        // Restore only after zoom establishes the new scroll range.
        applyClipPreviewZoom(outputWrap, panel.querySelector('.clip-output-image'), target.clip);
        outputWrap.scrollLeft = previousPreviewScroll.left;
        outputWrap.scrollTop = previousPreviewScroll.top;
    }
}

function getOrCreateSelectionInpaintFolder(selection, preparedFocus = null) {
    selection.children = Array.isArray(selection.children) ? selection.children : [];
    // 부위가 바뀌어도 같은 선택 영역의 결과는 기존 폴더에 계속 쌓는다.
    let folder = selection.children.find((child) => child.type === 'folder'
        && (child.name === '인페인팅'
            || (typeof child.dakiRegion === 'string' && child.dakiRegion.length > 0)
            || (Array.isArray(child.children) && child.children.some((result) =>
                result.type === 'clip' && result.renderOnCanvas === true
                && Number(result.sourceSelectionId) === Number(selection.id)))));

    if (!folder && typeof CanvasDakiFocus !== 'undefined') {
        folder = CanvasDakiFocus.resultFolder(selection, preparedFocus, () => layerIdSeq++);
    }

    if (!folder) {
        folder = {
            id: layerIdSeq++,
            name: '인페인팅',
            visible: true,
            type: 'folder',
            expanded: true,
            children: []
        };
        selection.children.unshift(folder);
    }

    folder.children = Array.isArray(folder.children) ? folder.children : [];
    folder.expanded = true;
    return folder;
}


async function requestClipInpainting(clipId) {
    if (clipInpaintLoadingClipId) return;
    const found = findCanvasLayer(clipId);
    const clip = found?.layer;
    const selection = findSelectionParentForLayerId(clipId);

    if (!clip || clip.type !== 'clip' || !selection) {
        alert('인페인팅할 클립을 찾을 수 없습니다.');
        return;
    }

    const mask = clip.maskDataUrl || clip.maskSrc || '';
    if (!mask) {
        alert('인페인팅 마스크를 먼저 칠해 주세요.');
        return;
    }

    let preparedFocus;
    try {
        const original = buildEffectiveClipPromptInfo(clip);
        preparedFocus = typeof CanvasDakiFocus !== 'undefined'
            ? await CanvasDakiFocus.prepare(clip, original) : {promptInfo: original};
    } catch (error) {
        alert('부위 설정을 확인해 주세요: ' + error.message);
        return;
    }
    const requestPromptInfo = preparedFocus.promptInfo;
    const requestWidth = clip.imageWidth || clip.layerWidth;
    const requestHeight = clip.imageHeight || clip.layerHeight;
    const requestSteps = parseInt(requestPromptInfo.steps || 28, 10) || 28;
    let referenceRequest;
    try {
        referenceRequest = typeof CanvasInpaintReference !== 'undefined'
            ? CanvasInpaintReference.request(requestWidth, requestHeight)
            : {width: requestWidth, height: requestHeight, reference: null};
    } catch (error) {
        alert(error.message);
        return;
    }

    const canUseAnlas = await showAnlasWarningModal({
        width: referenceRequest.width,
        height: referenceRequest.height,
        steps: requestSteps,
        title: '캔버스 인페인팅 Anlas 사용 경고',
        detail: '현재 캔버스 인페인팅 요청은 무료 범위를 벗어나 Anlas가 소모될 수 있습니다.'
    });

    if (!canUseAnlas || clipInpaintLoadingClipId || findCanvasLayer(clipId)?.layer !== clip) return;

    setClipInpaintProcessing(
        clipId,
        true,
        isClipInpaintMergedSourceMode
            ? '클립과 인페인팅 결과를 통합한 뒤 인페인팅 처리 중...'
            : '인페인팅 처리 중...'
    );

    try {
        const requestImage = isClipInpaintMergedSourceMode
            ? await renderMergedClipSourceToDataUrl(selection, clip)
            : clip.src;

        const response = await fetch('/api/canvas/inpaint', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                image: requestImage,
                mask,
                width: requestWidth,
                height: requestHeight,
                promptInfo: requestPromptInfo,
                ...(referenceRequest.reference ? {reference: referenceRequest.reference} : {}),
                tempCategory: 'canvas_inpaint',
                tempSessionId: CANVAS_IMPORT_SESSION_ID
            })
        });

        const data = await response.json();
        if (!response.ok || data.status !== 'success') {
            throw new Error(data.message || '인페인팅 요청에 실패했습니다.');
        }
        if (findCanvasLayer(clipId)?.layer !== clip || findCanvasLayer(selection.id)?.layer !== selection) {
            showToast('요청 중 캔버스가 변경되어 인페인팅 결과를 현재 캔버스에 붙이지 않았습니다.');
            return;
        }

        const inpaintFolder = getOrCreateSelectionInpaintFolder(selection, preparedFocus);
        selection.hasInpaintResult = true;

        const resultClip = {
            id: layerIdSeq++,
            name: `인페인팅 ${inpaintFolder.children.filter((child) => child.type === 'clip').length + 1}`,
            visible: true,
            type: 'clip',
            renderOnCanvas: true,
            src: data.src || data.image,
            sourceSelectionId: selection.id,
            sourcePath: clip.sourcePath || '',
            promptOwnerId: clip.promptOwnerId || clip.id,
            promptInfo: normalizePromptInfo(data.promptInfo || requestPromptInfo || clip.promptInfo),
            promptControlGroups: Array.isArray(clip.promptControlGroups)
                ? structuredClone(clip.promptControlGroups)
                : [],
            imageWidth: clip.imageWidth,
            imageHeight: clip.imageHeight,
            x: clip.x,
            y: clip.y,
            rotation: CanvasSelectionRotation.angle(clip.rotation),
            layerWidth: clip.layerWidth,
            layerHeight: clip.layerHeight,
            createdAt: Date.now()
        };
        if (preparedFocus.folderRegion) resultClip.dakiGenerationFocus = {
            region: preparedFocus.folderRegion, regions: preparedFocus.regions,
            prompt: preparedFocus.addedPrompt
        };
        

        inpaintFolder.children.unshift(resultClip);
        selection.expanded = true;

        // 새 인페인팅 결과가 생기면 통합 소스 미리보기가 달라지므로 캐시를 버린다.
        clearClipMergedSourcePreviewCache();
        clipMergedSourcePreviewSeq += 1;

        migrateAllSelectionClipsToSharedPromptOwner(clip.promptOwnerId || clip.id);

        activeLayerId = resultClip.id;
        activeClipSelectionId = selection.id;
        checkedSelectionId = selection.id;

        // 완료 후에는 자동으로 인페인팅 보기 상태
        isClipInpaintPreviewMode = true;

        renderLayerList();
        renderCanvasLayersOnSurface();
        animateClipInpaintResult(resultClip.id);
        saveCanvasState();
    } catch (error) {
        alert(`인페인팅 실패: ${error.message || error}`);
    } finally {
        setClipInpaintProcessing(clipId, false);
    }
}

function findSelectionParentForLayerId(layerId, layers = canvasLayers, currentSelection = null) {
    const targetId = Number(layerId);

    for (const layer of layers) {
        const nextSelection = layer.type === 'selection' ? layer : currentSelection;
        if (Number(layer.id) === targetId) return nextSelection;

        if ((layer.type === 'folder' || layer.type === 'selection') && Array.isArray(layer.children)) {
            const found = findSelectionParentForLayerId(targetId, layer.children, nextSelection);
            if (found) return found;
        }
    }

    return null;
}

function setClipMaskTool(tool, button) {
    activeClipMaskTool = tool === 'eraser' ? 'eraser' : 'brush';
    updateClipBrushCursorMode();
    renderClipOutputPanel();
}

function toggleClipMaskToolSizePopover(tool, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }

    const nextTool = tool === 'eraser' ? 'eraser' : 'brush';
    const wasOpen = openClipMaskSizeTool === nextTool;

    activeClipMaskTool = nextTool;
    openClipMaskSizeTool = wasOpen ? null : nextTool;

    updateClipBrushCursorMode();
    renderClipOutputPanel();
}

function closeClipMaskSizePopover() {
    if (!openClipMaskSizeTool) return;

    openClipMaskSizeTool = null;
    document.querySelectorAll('.clip-mask-tool-control.open').forEach((control) => {
        control.classList.remove('open');
    });
}

function setClipMaskBrushSize(value) {
    clipMaskBrushSize = Math.max(
        CLIP_MASK_BRUSH_MIN,
        Math.min(CLIP_MASK_BRUSH_MAX, parseInt(value, 10) || 96)
    );

    document.querySelectorAll('.clip-brush-size-popover input[type="range"]').forEach((input) => {
        input.value = String(clipMaskBrushSize);
    });

    document.querySelectorAll('.clip-brush-size-readout').forEach((node) => {
        node.innerText = `${clipMaskBrushSize}px`;
    });
}

let activeClipMaskEditorCleanup = null;

function disposeClipMaskEditor() {
    if (activeClipMaskEditorCleanup) {
        activeClipMaskEditorCleanup();
        activeClipMaskEditorCleanup = null;
    }
}

function bindClipMaskEditor(panel, clip) {
    disposeClipMaskEditor();
    const wrap = panel.querySelector('.canvas-clip-output-image-wrap');
    const img = panel.querySelector('.clip-output-image');
    const overlayCanvas = panel.querySelector('.clip-mask-overlay-canvas');

    if (!wrap || !img || !overlayCanvas || !clip) return;

    const cursor = getClipBrushCursor();

    wrap.oncontextmenu = (event) => {
        openClipOutputClipboardContextMenu(event);
    };

    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = clip.imageWidth || img.naturalWidth || 512;
    maskCanvas.height = clip.imageHeight || img.naturalHeight || 512;

    const maskCtx = maskCanvas.getContext('2d');

    let lastPoint = null;
    let maskInitialized = false;
    let maskDirty = false;
    let maskLoadToken = 0;
    let clipAlphaSampler = null;
    let disposed = false;
    let maskPreviewFrame = null;
    let dirtyBounds = null;
    const markMaskBounds = (from, to = from) => {
        const radius = Math.max(1, clipMaskBrushSize / 2) + 2;
        const bounds = {left: Math.min(from.x, to.x) - radius, top: Math.min(from.y, to.y) - radius,
            right: Math.max(from.x, to.x) + radius, bottom: Math.max(from.y, to.y) + radius};
        if (!dirtyBounds) dirtyBounds = bounds;
        else {
            dirtyBounds.left = Math.min(dirtyBounds.left, bounds.left);
            dirtyBounds.top = Math.min(dirtyBounds.top, bounds.top);
            dirtyBounds.right = Math.max(dirtyBounds.right, bounds.right);
            dirtyBounds.bottom = Math.max(dirtyBounds.bottom, bounds.bottom);
        }
    };

    const syncMaskCanvasSize = (width, height, preserveExisting = false) => {
        const nextWidth = Math.max(1, Math.round(width || maskCanvas.width || 512));
        const nextHeight = Math.max(1, Math.round(height || maskCanvas.height || 512));

        if (preserveExisting) {
            resizeCanvasPreserveContent(maskCanvas, nextWidth, nextHeight);
        } else if (maskCanvas.width !== nextWidth || maskCanvas.height !== nextHeight) {
            maskCanvas.width = nextWidth;
            maskCanvas.height = nextHeight;
            maskCtx.clearRect(0, 0, nextWidth, nextHeight);
        }

        overlayCanvas.width = maskCanvas.width;
        overlayCanvas.height = maskCanvas.height;
        maskInitialized = true;
    };

    const renderMaskPreview = () => {
        if (maskPreviewFrame !== null) {
            cancelAnimationFrame(maskPreviewFrame);
            maskPreviewFrame = null;
        }
        if (disposed) return;
        redrawMaskOverlay(maskCanvas, overlayCanvas, dirtyBounds);
        dirtyBounds = null;
    };

    const queueMaskPreview = () => {
        // Every pointer sample already updates maskCanvas; only its display is coalesced.
        if (disposed || maskPreviewFrame !== null) return;
        maskPreviewFrame = requestAnimationFrame(() => {
            maskPreviewFrame = null;
            renderMaskPreview();
        });
    };

    const refreshClipAlphaSampler = () => {
        try {
            const canvas = document.createElement('canvas');
            canvas.width = maskCanvas.width;
            canvas.height = maskCanvas.height;

            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

            clipAlphaSampler = ctx;
        } catch (error) {
            clipAlphaSampler = null;
        }
    };

    const isTransparentClipPoint = (point) => {
        if (!clipAlphaSampler || !point) return false;

        try {
            const x = Math.max(0, Math.min(maskCanvas.width - 1, Math.floor(point.x)));
            const y = Math.max(0, Math.min(maskCanvas.height - 1, Math.floor(point.y)));
            return clipAlphaSampler.getImageData(x, y, 1, 1).data[3] < 8;
        } catch (error) {
            clipAlphaSampler = null;
            return false;
        }
    };

    const drawMaskDot = (point) => {
        if (!point) return;

        maskCtx.save();
        maskCtx.globalCompositeOperation = activeClipMaskTool === 'eraser' ? 'destination-out' : 'source-over';
        maskCtx.fillStyle = '#ffffff';

        const radius = Math.max(1, clipMaskBrushSize / 2);
        maskCtx.beginPath();
        maskCtx.arc(point.x, point.y, radius, 0, Math.PI * 2);
        maskCtx.fill();
        maskCtx.restore();

        maskDirty = true;
        markMaskBounds(point);
    };

    const drawMaskStrokeSegment = (from, to) => {
        if (!from || !to) return;

        maskCtx.save();
        maskCtx.globalCompositeOperation = activeClipMaskTool === 'eraser' ? 'destination-out' : 'source-over';
        maskCtx.strokeStyle = '#ffffff';
        maskCtx.fillStyle = '#ffffff';
        maskCtx.lineWidth = clipMaskBrushSize;
        maskCtx.lineCap = 'round';
        maskCtx.lineJoin = 'round';

        maskCtx.beginPath();
        maskCtx.moveTo(from.x, from.y);
        maskCtx.lineTo(to.x, to.y);
        maskCtx.stroke();

        maskCtx.beginPath();
        maskCtx.arc(to.x, to.y, maskCtx.lineWidth / 2, 0, Math.PI * 2);
        maskCtx.fill();

        maskCtx.restore();
        maskDirty = true;
        markMaskBounds(from, to);
    };

    const syncOverlayPosition = () => {
        if (disposed) return;
        applyClipPreviewZoom(wrap, img, clip);

        const preserveMask = maskInitialized || maskDirty;
        syncMaskCanvasSize(
            clip.imageWidth || img.naturalWidth || maskCanvas.width || 512,
            clip.imageHeight || img.naturalHeight || maskCanvas.height || 512,
            preserveMask
        );

        overlayCanvas.style.left = `${img.offsetLeft}px`;
        overlayCanvas.style.top = `${img.offsetTop}px`;
        overlayCanvas.style.width = `${img.clientWidth}px`;
        overlayCanvas.style.height = `${img.clientHeight}px`;

        refreshClipAlphaSampler();
        dirtyBounds = null; // Resizing the overlay requires a full redraw.
        renderMaskPreview();
        keepDefaultClipOutputPanelVisible(panel);
    };

    const resizeObserver = typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => { if (img.complete) syncOverlayPosition(); }) : null;
    const disposeResize = bindClipOutputPanelResize(panel, clip, syncOverlayPosition);

    activeClipMaskEditorCleanup = () => {
        disposed = true;
        maskLoadToken += 1;
        if (maskPreviewFrame !== null) {
            cancelAnimationFrame(maskPreviewFrame);
            maskPreviewFrame = null;
        }
        window.removeEventListener('resize', syncOverlayPosition);
        resizeObserver?.disconnect();
        disposeResize();
        img.onload = null;
    };

    resizeObserver?.observe(panel);
    window.addEventListener('resize', syncOverlayPosition);

    img.onload = () => {
        syncOverlayPosition();
    };

    if (img.complete) {
        requestAnimationFrame(syncOverlayPosition);
    }

    bindClipPreviewWheelZoom(wrap, img, clip, syncOverlayPosition);
    bindClipOutputBackgroundScrollDrag(wrap);

    if (wrap.classList.contains('preview-mode')) {
        overlayCanvas.style.display = 'none';
        if (cursor) cursor.style.display = 'none';
        return;
    }

    overlayCanvas.style.display = 'block';

    const loadExistingMask = async () => {
        const maskSrc = clip.maskDataUrl || clip.maskSrc || '';
        const currentLoadToken = ++maskLoadToken;

        if (!maskSrc) {
            if (!maskDirty) {
                maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
            }
            maskInitialized = true;
            syncOverlayPosition();
            return;
        }

        try {
            const maskImg = await loadImageElementForClip(maskSrc);
            if (maskDirty || currentLoadToken !== maskLoadToken) {
                return;
            }
            maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
            maskCtx.drawImage(maskImg, 0, 0, maskCanvas.width, maskCanvas.height);
            maskInitialized = true;
        } catch (error) {
            console.warn('Mask load failed:', error);
            if (!maskDirty && currentLoadToken === maskLoadToken) {
                maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
            }
        }

        syncOverlayPosition();
    };

    loadExistingMask();

    overlayCanvas.onpointerdown = (event) => {
        if (event.button === 2) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        const point = getClipMaskPoint(event, overlayCanvas, maskCanvas);

        if (isTransparentClipPoint(point)) {
            if (cursor) cursor.style.display = 'none';
            wrap.startClipOutputBackgroundScrollDrag?.(event);
            return;
        }

        if (activeClipAutoMaskPickClipId === Number(clip.id)) {
            maskLoadToken += 1;
            maskInitialized = true;
            applyClipAutoMaskFromPreviewClick(event, clip, overlayCanvas, maskCanvas)
                .then((applied) => {
                    if (!applied) return;
                    activeClipAutoMaskPickClipId = null;
                    maskDirty = true;
                    renderMaskPreview();
                    renderCanvasLayersOnSurface();
                })
                .catch((error) => {
                    activeClipAutoMaskPickClipId = null;
                    alert(`자동 선택 실패: ${error.message || error}`);
                    renderCanvasLayersOnSurface();
                });
            return;
        }

        isClipMaskPainting = true;
        maskLoadToken += 1;
        maskDirty = true;
        maskInitialized = true;
        overlayCanvas.setPointerCapture(event.pointerId);

        lastPoint = point;
        drawMaskDot(lastPoint);
        renderMaskPreview();
        updateClipBrushCursor(event, overlayCanvas, maskCanvas, cursor);
    };

    overlayCanvas.onpointermove = (event) => {
        updateClipBrushCursor(event, overlayCanvas, maskCanvas, cursor);

        if (!isClipMaskPainting) return;

        const point = getClipMaskPoint(event, overlayCanvas, maskCanvas);

        if (lastPoint) {
            drawMaskStrokeSegment(lastPoint, point);
        } else {
            drawMaskDot(point);
        }

        lastPoint = point;
        queueMaskPreview();
    };

    overlayCanvas.onpointerup = async (event) => {
        if (!isClipMaskPainting) return;

        isClipMaskPainting = false;
        lastPoint = null;

        try {
            overlayCanvas.releasePointerCapture(event.pointerId);
        } catch (e) {}

        if (maskPreviewFrame !== null) renderMaskPreview();
        await persistClipMask(clip, maskCanvas);
        maskDirty = true;
    };

    overlayCanvas.onpointercancel = async () => {
        isClipMaskPainting = false;
        lastPoint = null;
        if (maskPreviewFrame !== null) renderMaskPreview();
        await persistClipMask(clip, maskCanvas);
        maskDirty = true;
    };

    overlayCanvas.onmouseenter = (event) => {
        cursor.style.display = 'block';
        updateClipBrushCursor(event, overlayCanvas, maskCanvas, cursor);
    };

    overlayCanvas.onmouseleave = () => {
        if (!isClipMaskPainting) {
            cursor.style.display = 'none';
        }
    };
}

function bindClipOutputBackgroundScrollDrag(wrap) {
    if (!wrap || wrap.dataset.backgroundScrollDragBound === '1') return;

    wrap.dataset.backgroundScrollDragBound = '1';

    let drag = null;

    wrap.startClipOutputBackgroundScrollDrag = (event) => {
        if (event.button !== 0) return;

        event.preventDefault();
        event.stopPropagation();

        drag = {
            pointerId: event.pointerId,
            startClientY: event.clientY,
            startScrollTop: wrap.scrollTop
        };

        wrap.setPointerCapture(event.pointerId);
    };

    wrap.addEventListener('pointerdown', (event) => {
        if (event.target !== wrap) return;
        wrap.startClipOutputBackgroundScrollDrag(event);
    });

    wrap.addEventListener('pointermove', (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;

        event.preventDefault();
        wrap.scrollTop = drag.startScrollTop - (event.clientY - drag.startClientY);
    });

    const stopDrag = (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;

        try {
            wrap.releasePointerCapture(event.pointerId);
        } catch (e) {}

        drag = null;
    };

    wrap.addEventListener('pointerup', stopDrag);
    wrap.addEventListener('pointercancel', stopDrag);
}

function getClipBrushCursor() {
    let cursor = el('clipBrushCursor');

    if (!cursor) {
        cursor = document.createElement('div');
        cursor.id = 'clipBrushCursor';
        cursor.className = 'clip-brush-cursor';
        document.body.appendChild(cursor);
    }

    return cursor;
}

function updateClipBrushCursorMode() {
    const cursor = el('clipBrushCursor');
    if (!cursor) return;

    cursor.classList.toggle('eraser', activeClipMaskTool === 'eraser');
}

function toggleClipAutoMaskPickMode(clipId) {
    const id = Number(clipId);
    activeClipAutoMaskPickClipId = activeClipAutoMaskPickClipId === id ? null : id;
    if (activeClipAutoMaskPickClipId === id) {
        isClipInpaintPreviewMode = false;
    }
    renderCanvasLayersOnSurface();

    if (typeof showToast === 'function') {
        showToast(activeClipAutoMaskPickClipId === id
            ? '자동 선택: 미리보기에서 기준 그림을 클릭하세요.'
            : '자동 선택을 취소했습니다.');
    }
}

function updateClipBrushCursor(event, overlayCanvas, maskCanvas, cursor) {
    if (!cursor || !overlayCanvas || !maskCanvas) return;

    const rect = overlayCanvas.getBoundingClientRect();
    const scale = rect.width / maskCanvas.width;
    const displaySize = Math.max(4, clipMaskBrushSize * scale);

    cursor.style.display = 'block';
    cursor.style.width = `${displaySize}px`;
    cursor.style.height = `${displaySize}px`;
    cursor.style.left = `${event.clientX}px`;
    cursor.style.top = `${event.clientY}px`;
    cursor.classList.toggle('eraser', activeClipMaskTool === 'eraser');
}

function getClipMaskPoint(event, overlayCanvas, maskCanvas) {
    const rect = overlayCanvas.getBoundingClientRect();

    const x = ((event.clientX - rect.left) / rect.width) * maskCanvas.width;
    const y = ((event.clientY - rect.top) / rect.height) * maskCanvas.height;

    return {
        x: Math.max(0, Math.min(maskCanvas.width, x)),
        y: Math.max(0, Math.min(maskCanvas.height, y))
    };
}

function collectAutoMaskSourceCandidateLayers(layers, output = []) {
    [...(layers || [])].reverse().forEach((layer) => {
        if (!layer || !layer.visible) return;

        if (layer.type === 'folder' || layer.type === 'selection') {
            collectAutoMaskSourceCandidateLayers(layer.children, output);
            return;
        }

        if (layer.type === 'canvas') {
            output.push(layer);
            return;
        }

        if (layer.type === 'image' && layer.src) {
            output.push(layer);
            return;
        }

        if (layer.type === 'clip' && layer.renderOnCanvas && layer.src) {
            output.push(layer);
        }
    });

    return output;
}

function collectAutoMaskSourceLayersForSelection(selection) {
    if (!selection) return [];
    return collectAutoMaskSourceCandidateLayers(canvasLayers)
        .filter((layer) => {
            const rect = getAutoMaskSourceLayerRect(layer, selection);
            return CanvasSelectionRotation.intersects(selection, rect);
        });
}

function getAutoMaskSourceLayerRect(layer, selection) {
    const selectionX = Number(selection?.x || 0);
    const selectionY = Number(selection?.y || 0);

    if (layer?.type === 'canvas') {
        return {
            x: 0,
            y: 0,
            layerWidth: Number(layer.canvasWidth || currentCanvasWidth || selection?.layerWidth || 0),
            layerHeight: Number(layer.canvasHeight || currentCanvasHeight || selection?.layerHeight || 0)
        };
    }

    return {
        x: Number(layer.x ?? selectionX),
        y: Number(layer.y ?? selectionY),
        layerWidth: Number(layer.layerWidth || layer.imageWidth || selection?.layerWidth || 0),
        layerHeight: Number(layer.layerHeight || layer.imageHeight || selection?.layerHeight || 0),
        rotation: CanvasSelectionRotation.angle(layer.rotation)
    };
}

function autoMaskSourceLayerContainsCanvasPoint(layer, selection, x, y) {
    const rect = getAutoMaskSourceLayerRect(layer, selection);
    return CanvasSelectionRotation.containsPoint(rect, {x, y});
}

function findAutoMaskSourceLayerAtMaskPoint(selection, clip, point, maskCanvas) {
    if (!selection || !clip || !point || !maskCanvas) return null;

    const selectionWidth = Number(selection.layerWidth || clip.imageWidth || maskCanvas.width || 1);
    const selectionHeight = Number(selection.layerHeight || clip.imageHeight || maskCanvas.height || 1);
    let canvasX = Number(selection.x || 0) + (point.x / Math.max(1, maskCanvas.width)) * selectionWidth;
    let canvasY = Number(selection.y || 0) + (point.y / Math.max(1, maskCanvas.height)) * selectionHeight;
    if (clip.rotation) {
        const width = Number(clip.layerWidth || selectionWidth);
        const height = Number(clip.layerHeight || selectionHeight);
        const radians = CanvasSelectionRotation.angle(clip.rotation) * Math.PI / 180;
        const x = point.x / maskCanvas.width * width - width / 2;
        const y = point.y / maskCanvas.height * height - height / 2;
        canvasX = Number(clip.x || 0) + width / 2 + x * Math.cos(radians) - y * Math.sin(radians);
        canvasY = Number(clip.y || 0) + height / 2 + x * Math.sin(radians) + y * Math.cos(radians);
    }
    const topFirstLayers = collectAutoMaskSourceLayersForSelection(selection).slice().reverse();

    return topFirstLayers
        .find((layer) => autoMaskSourceLayerContainsCanvasPoint(layer, selection, canvasX, canvasY)) || null;
}

function applyAutoMaskAboveSourceLayer(selection, clip, targetLayer, maskCanvas) {
    if (!selection || !clip || !targetLayer || !maskCanvas) return false;

    const layers = collectAutoMaskSourceLayersForSelection(selection);
    const targetIndex = layers.findIndex((layer) => Number(layer.id) === Number(targetLayer.id));
    if (targetIndex < 0) return false;

    const ctx = maskCanvas.getContext('2d');
    const selectionWidth = Number(selection.layerWidth || clip.imageWidth || maskCanvas.width || 1);
    const selectionHeight = Number(selection.layerHeight || clip.imageHeight || maskCanvas.height || 1);
    const scaleX = maskCanvas.width / Math.max(1, selectionWidth);
    const scaleY = maskCanvas.height / Math.max(1, selectionHeight);
    const selectionX = Number(selection.x || 0);
    const selectionY = Number(selection.y || 0);
    const previewRect = {x: selectionX, y: selectionY, layerWidth: selectionWidth,
        layerHeight: selectionHeight, rotation: clip.rotation};

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);

    ctx.globalCompositeOperation = 'destination-out';
    layers.slice(targetIndex + 1).forEach((layer) => {
        const rect = getAutoMaskSourceLayerRect(layer, selection);
        if (rect.layerWidth <= 0 || rect.layerHeight <= 0) return;
        if (!clip.rotation && !rect.rotation) {
            ctx.fillRect(Math.round((rect.x - selectionX) * scaleX),
                Math.round((rect.y - selectionY) * scaleY),
                Math.round(rect.layerWidth * scaleX), Math.round(rect.layerHeight * scaleY));
        } else {
            ctx.beginPath();
            CanvasSelectionRotation.corners(rect).forEach((point, index) => {
                const local = CanvasSelectionRotation.localPoint(previewRect, point);
                if (index === 0) ctx.moveTo(local.x * scaleX, local.y * scaleY);
                else ctx.lineTo(local.x * scaleX, local.y * scaleY);
            });
            ctx.closePath();
            ctx.fill();
        }
    });

    ctx.restore();
    return true;
}

async function applyClipAutoMaskFromPreviewClick(event, clip, overlayCanvas, maskCanvas) {
    const selection = findSelectionParentForLayerId(clip?.id);
    if (!selection) {
        alert('자동 선택 기준이 될 선택영역을 찾을 수 없습니다.');
        return false;
    }

    const point = getClipMaskPoint(event, overlayCanvas, maskCanvas);
    const targetLayer = findAutoMaskSourceLayerAtMaskPoint(selection, clip, point, maskCanvas);

    if (!targetLayer) {
        alert('클릭한 위치에서 기준 그림 레이어를 찾을 수 없습니다.');
        return false;
    }

    const applied = applyAutoMaskAboveSourceLayer(selection, clip, targetLayer, maskCanvas);
    if (!applied) return false;

    await persistClipMask(clip, maskCanvas);

    if (typeof showToast === 'function') {
        showToast(`자동 선택 완료: ${targetLayer.name || '선택 레이어'} 기준`);
    }

    return true;
}

function drawClipMaskPoint(ctx, x, y, size, tool) {
    ctx.save();

    ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.fillStyle = '#ffffff';

    ctx.beginPath();
    ctx.arc(x, y, size / 2, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
}

function drawClipMaskLine(ctx, from, to, size, tool) {
    ctx.save();

    ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();

    ctx.restore();
}

function resizeCanvasPreserveContent(canvas, width, height) {
    if (!canvas) return;

    const nextWidth = Math.max(1, Math.round(width));
    const nextHeight = Math.max(1, Math.round(height));

    if (canvas.width === nextWidth && canvas.height === nextHeight) {
        return;
    }

    const prevWidth = canvas.width;
    const prevHeight = canvas.height;
    let snapshot = null;

    if (prevWidth > 0 && prevHeight > 0) {
        snapshot = document.createElement('canvas');
        snapshot.width = prevWidth;
        snapshot.height = prevHeight;
        snapshot.getContext('2d').drawImage(canvas, 0, 0);
    }

    canvas.width = nextWidth;
    canvas.height = nextHeight;

    if (snapshot) {
        canvas.getContext('2d').drawImage(snapshot, 0, 0, prevWidth, prevHeight, 0, 0, nextWidth, nextHeight);
    }
}

function redrawMaskOverlay(maskCanvas, overlayCanvas, bounds = null) {
    const left = bounds ? Math.max(0, Math.floor(bounds.left)) : 0;
    const top = bounds ? Math.max(0, Math.floor(bounds.top)) : 0;
    const right = bounds ? Math.min(maskCanvas.width, Math.ceil(bounds.right)) : maskCanvas.width;
    const bottom = bounds ? Math.min(maskCanvas.height, Math.ceil(bounds.bottom)) : maskCanvas.height;
    if (right <= left || bottom <= top) return;
    const imageData = maskCanvas.getContext('2d').getImageData(left, top, right - left, bottom - top);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3];
        if (alpha > 0) {
            data[i] = 72;
            data[i + 1] = 160;
            data[i + 2] = 255;
            data[i + 3] = Math.min(150, alpha);
        }
    }
    // Replace this region, including erased pixels. Never rescale the real mask.
    overlayCanvas.getContext('2d').putImageData(imageData, left, top);
}

async function persistClipMask(clip, maskCanvas) {
    if (!clip || !maskCanvas) return;

    const maskDataUrl = maskCanvas.toDataURL('image/png');
    const revision = (clipMaskPersistRevisions.get(clip) || 0) + 1;
    clipMaskPersistRevisions.set(clip, revision);

    clip.maskWidth = maskCanvas.width;
    clip.maskHeight = maskCanvas.height;
    clip.maskDataUrl = maskDataUrl;

    pendingCanvasClipMaskWrites++;
    try {
        const savedSrc = await saveClipDataUrlToServer(maskDataUrl);
        if (clipMaskPersistRevisions.get(clip) !== revision) return;
        clip.maskSrc = savedSrc;
        delete clip.maskDataUrl;
    } catch (error) {
        if (clipMaskPersistRevisions.get(clip) !== revision) return;
        // 서버 저장 실패 시 임시로 dataUrl 보관
        console.warn('Mask save failed, fallback to local dataUrl:', error);
        clip.maskDataUrl = maskDataUrl;
    } finally {
        pendingCanvasClipMaskWrites--;
    }

    saveCanvasState();
}

function normalizePromptInfo(promptInfo) {
    const info = promptInfo || {};
    const negativeText = pickNegativePromptText(info);
    const charPrompts = normalizeCharPromptList(
        Array.isArray(info.charPrompts) ? info.charPrompts : (
            info.charPrompts || info.charPrompt || info.characterPrompt || ''
        )
    );

    return {
        basePrompt: String(info.basePrompt || info.prompt || '').trim(),
        charPrompts,
        charPrompt: buildLegacyCharPromptText(charPrompts),
        negativePrompt: negativeText,
        model: String(info.model || 'nai-diffusion-5-full'),
        cfg_rescale: Number(info.cfg_rescale === '' ? 0.4 : info.cfg_rescale ?? 0.4),
        noise_schedule: String(info.noise_schedule || 'native'),
        sampler: String(info.sampler || 'k_euler_ancestral'),
        steps: Number(info.steps || 28),
        cfg: Number(info.cfg || info.scale || 6),
        strength: Number(info.strength ?? 0.65),
        noise: Number(info.noise ?? 0.2),
        seed: Number(info.seed ?? -1)
    };
}

function applyCanvasInpaintSettingsToPromptInfo(promptInfo) {
    return typeof CanvasInpaintSettings !== 'undefined'
        ? CanvasInpaintSettings.apply(promptInfo)
        : normalizePromptInfo(promptInfo);
}

function canvasInpaintHasGenerationSettings(promptInfo) {
    return typeof CanvasInpaintSettings !== 'undefined' &&
        typeof CanvasInpaintSettings.hasGenerationSettings === 'function' &&
        CanvasInpaintSettings.hasGenerationSettings(promptInfo);
}

function pickNegativePromptText(info) {
    if (!info) return '';

    const candidates = [
        info.negativePrompt,
        info.negative_prompt,
        info.uc,
        info.uncond,
        info.unconditional_prompt,
        Array.isArray(info.negativePrompts) ? info.negativePrompts.join(', ') : '',
        info.comment?.negativePrompt,
        info.comment?.negative_prompt,
        info.comment?.uc,
        info.parameters?.negativePrompt,
        info.parameters?.negative_prompt,
        info.parameters?.uc
    ];

    const found = candidates.find((value) => typeof value === 'string' && value.trim());
    return String(found || '').trim();
}

function buildClipPromptInfoFromSelection(selection) {
    const sourceLayers = collectPromptSourceLayersFromSelection(selection);

    // 가장 위쪽의 프롬프트가 있는 이미지 레이어를 우선 사용
    const primary = sourceLayers.find((layer) => layer.promptInfo && hasAnyPromptText(layer.promptInfo));

    if (!primary) {
        return normalizePromptInfo(null);
    }

    return normalizePromptInfo(primary.promptInfo);
}

function hasAnyPromptText(promptInfo) {
    if (!promptInfo) return false;

    return Boolean(
        String(promptInfo.basePrompt || '').trim() ||
        buildLegacyCharPromptText(promptInfo.charPrompts || promptInfo.charPrompt || '').trim() ||
        String(promptInfo.negativePrompt || '').trim()
    );
}

function collectPromptSourceLayersFromSelection(selection) {
    const result = [];

    const scan = (layers) => {
        [...layers].forEach((layer) => {
            if (!layer.visible) return;

            if (layer.type === 'folder' || layer.type === 'selection') {
                layer.children = Array.isArray(layer.children) ? layer.children : [];
                scan(layer.children);
                return;
            }

            // 프롬프트 출처는 오직 원본 이미지 레이어만 사용
            if (layer.type !== 'image') return;
            if (!layer.src) return;

            normalizeImageLayerGeometry(layer);

            if (!CanvasSelectionRotation.intersects(selection, layer)) {
                return;
            }

            result.push(layer);
        });
    };

    scan(canvasLayers);
    return result;
}

async function openClipPromptModal(clipId) {
    const found = findCanvasLayer(clipId);
    const clip = found?.layer;

    if (!clip || clip.type !== 'clip') {
        alert('클립을 찾을 수 없습니다.');
        return;
    }
    // 프롬프트가 비어 있으면, 프롬프트 창을 열기 전에 자동 복구 시도
    if (!hasSharedSelectionClipPrompt() || !hasAnyPromptText(clip.promptInfo)) {
        await recoverSharedSelectionClipPromptFromAvailableSources(
            findSelectionParentForLayerId(clip.id),
            clip
        );
    }

    applySharedSelectionPromptToClip(clip);

    const owner = getPromptOwnerLayer(clip) || clip;
    if (!owner) {
        alert('프롬프트 소유 레이어를 찾을 수 없습니다.');
        return;
    }

    activeClipPromptId = clip.id;

    // owner 기준으로 현재 클립도 동기화
    syncPromptStateFromOwner(clip);

    owner.promptInfo = normalizePromptInfo(owner.promptInfo || {});
    setGenerationSettings('clip', typeof CanvasInpaintSettings !== 'undefined'
        ? CanvasInpaintSettings.apply(owner.promptInfo)
        : owner.promptInfo);

    setClipPromptEditorValue('base', owner.promptInfo.basePrompt || '');
    setClipPromptEditorValue('negative', owner.promptInfo.negativePrompt || '');
    setClipCharPromptValues(owner.promptInfo.charPrompts || owner.promptInfo.charPrompt || '');
    const selection = findSelectionParentForLayerId(clip.id);
    el('clipInstancePromptInput').value = typeof selection?.instancePrompt === 'string' ? selection.instancePrompt : '';
    el('clipInstancePromptInput').disabled = !selection;
    el('clipInstanceNegativePromptInput').value = getClipInstancePrompt(clip, 'instanceNegativePrompt');
    el('clipInstanceNegativePromptInput').disabled = !selection;
    switchClipInstancePromptTab('base');
    if (typeof CanvasDetailPresets !== 'undefined') CanvasDetailPresets.refreshPicker();

    ensureClipPromptControlGroups(owner);
    renderClipPromptControlGroups(owner);

    bindClipPromptInputs();
    renderAllClipPromptTokens();
    applyClipPromptViewMode();
    switchClipPromptTab('base');

    el('clipPromptModalOverlay').classList.add('open');
    if (typeof CanvasDakiFocus !== 'undefined') CanvasDakiFocus.refresh();
    if (typeof refreshCanvasStyleLink === 'function') refreshCanvasStyleLink();
}

function closeClipPromptModal() {
    if (typeof CanvasDetailPresets !== 'undefined') CanvasDetailPresets.closePicker();
    el('clipPromptModalOverlay')?.classList.remove('open');
    if (typeof CanvasDakiFocus !== 'undefined') CanvasDakiFocus.refresh();
    if (typeof refreshCanvasStyleLink === 'function') refreshCanvasStyleLink();
}

function saveClipPromptModal() {
    const found = findCanvasLayer(activeClipPromptId);
    const clip = found?.layer;

    if (!clip || clip.type !== 'clip') {
        closeClipPromptModal();
        return;
    }

    const owner = getPromptOwnerLayer(clip) || clip;

    const charPrompts = getClipCharPromptValues();

    const settings = readGenerationSettings('clip');
    if (!settings) return;
    const selection = findSelectionParentForLayerId(clip.id);
    if (selection) {
        selection.instancePrompt = el('clipInstancePromptInput').value.trim();
        selection.instanceNegativePrompt = el('clipInstanceNegativePromptInput').value.trim();
    }
    if (typeof CanvasInpaintSettings !== 'undefined') CanvasInpaintSettings.update(settings);
    owner.promptInfo = normalizePromptInfo({
        basePrompt: getClipPromptEditorValue('base'),
        charPrompts,
        charPrompt: buildLegacyCharPromptText(charPrompts),
        negativePrompt: getClipPromptEditorValue('negative'),
        ...settings
    });

    rememberSharedSelectionClipPrompt(owner.promptInfo, owner.promptControlGroups);
    // 저장한 프롬프트를 모든 선택 영역 클립에 다시 공유
    migrateAllSelectionClipsToSharedPromptOwner(owner.id);

    syncPromptStateFromOwner(clip);

    saveCanvasState();
    closeClipPromptModal();
}

function syncClipRangeNumber(rangeId, inputId) {
    const range = el(rangeId);
    const input = el(inputId);
    if (!range || !input) return;
    input.value = range.value;
}

function syncClipNumberRange(inputId, rangeId) {
    const input = el(inputId);
    const range = el(rangeId);
    if (!range || !input) return;
    range.value = input.value;
}

async function inferPromptInfoForClip(clip, parentSelection) {
    // 1순위: 선택 영역과 겹치는 이미지 레이어의 promptInfo
    if (parentSelection && parentSelection.type === 'selection') {
        const fromLayer = buildClipPromptInfoFromSelection(parentSelection);
        if (hasAnyPromptText(fromLayer)) {
            return normalizePromptInfo(fromLayer);
        }
    }

    // 2순위: 클립 생성 당시 source 이미지 경로가 있으면 그 이미지에서 직접 메타데이터 읽기
    const sourcePath = clip.sourcePath || clip.originalPath || clip.path || '';
    if (sourcePath) {
        const fromImage = await fetchPromptInfoByPath(sourcePath);
        if (hasAnyPromptText(fromImage)) {
            return normalizePromptInfo(fromImage);
        }
    }

    // 3순위: 전체 이미지 레이어 중 선택 영역과 겹치는 레이어의 sourcePath를 통해 읽기
    if (parentSelection && parentSelection.type === 'selection') {
        const sourceLayers = collectPromptSourceLayersFromSelection(parentSelection);

        for (const layer of sourceLayers) {
            if (layer.promptInfo && hasAnyPromptText(layer.promptInfo)) {
                return normalizePromptInfo(layer.promptInfo);
            }

            if (layer.sourcePath) {
                const fromImage = await fetchPromptInfoByPath(layer.sourcePath);
                if (hasAnyPromptText(fromImage)) {
                    layer.promptInfo = normalizePromptInfo(fromImage);
                    return layer.promptInfo;
                }
            }
        }
    }

    return normalizePromptInfo(null);
}

async function fetchPromptInfoByPath(path) {
    if (!path) return null;

    try {
        const res = await fetch('/api/prompt_info', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ path })
        });

        const json = await res.json();
        if (json.status !== 'success') {
            throw new Error(json.message || '프롬프트를 읽을 수 없습니다.');
        }

        const data = json.data || {};

        const charText =
            Array.isArray(data.charPrompts) ? data.charPrompts.join('\n') :
            Array.isArray(data.characterPrompts) ? data.characterPrompts.join('\n') :
            String(data.charPrompt || data.characterPrompt || '');

        const promptInfo = normalizePromptInfo({
            basePrompt: data.basePrompt || data.prompt || '',
            charPrompt: charText,
            negativePrompt: pickNegativePromptText(data),
            model: data.model,
            sampler: data.sampler,
            steps: data.steps,
            cfg: data.cfg ?? data.scale,
            cfg_rescale: data.cfg_rescale,
            noise_schedule: data.noise_schedule,
            seed: data.seed,
            strength: data.strength,
            noise: data.noise,
            uc: data.uc,
            negative_prompt: data.negative_prompt
        });
        Object.defineProperty(promptInfo, '__hasGenerationSettings', {
            value: NAI_GENERATION_FIELDS.some(field => Object.prototype.hasOwnProperty.call(data, field.key))
                || Object.prototype.hasOwnProperty.call(data, 'scale'),
            enumerable: false
        });
        return promptInfo;

    } catch (error) {
        console.warn('Prompt metadata fetch failed:', error);
        return null;
    }
}

function toggleClipPromptSection(kind) {
    const body = el(kind === 'base' ? 'clipBasePromptSection' : 'clipNegativePromptSection');
    const icon = el(kind === 'base' ? 'clipBasePromptToggleIcon' : 'clipNegativePromptToggleIcon');

    if (!body || !icon) return;

    const isOpen = body.classList.toggle('open');
    icon.innerText = isOpen ? '▼' : '▶';
}

function toggleClipPromptCollapse() {
    const clipPromptBody = el('clipPromptBody');
    const toggle = el('clipPromptCollapseToggle');
    if (!clipPromptBody) return;

    const isCollapsed = clipPromptBody.classList.toggle('collapsed');
    if (toggle) toggle.innerText = isCollapsed ? '펼치기' : '접기';
}

function normalizeSharedPromptGroups(groups) {
    if (!Array.isArray(groups)) return [];

    const result = [];

    groups.forEach((group) => {
        if (!group || typeof group !== 'object') return;

        const name = String(group.name || '').trim();
        const prompts = Array.isArray(group.prompts)
            ? group.prompts.map(prompt => String(prompt || '').trim()).filter(Boolean)
            : [];

        if (!name || !prompts.length) return;

        const tags = Array.isArray(group.tags)
            ? group.tags.map(tag => String(tag || '').trim().replace(/^#+/, '')).filter(Boolean)
            : String(group.tags || '')
                .split(/[,#\n]+/)
                .map(tag => tag.trim().replace(/^#+/, ''))
                .filter(Boolean);

        result.push({
            name,
            prompts,
            tags: [...new Set(tags)],
            collapsed: group.collapsed === undefined ? true : Boolean(group.collapsed)
        });
    });

    const map = new Map();
    result.forEach((group) => map.set(group.name, group));

    return [...map.values()];
}

function mergePromptGroupLists(baseGroups, incomingGroups) {
    const map = new Map();

    normalizeSharedPromptGroups(baseGroups).forEach((group) => {
        map.set(group.name, group);
    });

    normalizeSharedPromptGroups(incomingGroups).forEach((group) => {
        map.set(group.name, group);
    });

    return [...map.values()];
}

function getClipPromptGroupTagsFromInput(value) {
    return String(value || '')
        .split(/[,#\n]+/)
        .map(tag => tag.trim().replace(/^#+/, ''))
        .filter(Boolean)
        .filter((tag, index, arr) => arr.indexOf(tag) === index);
}

function getAllClipPromptGroupTags() {
    const tags = new Set();

    normalizeSharedPromptGroups(clipPromptGroups).forEach((group) => {
        (group.tags || []).forEach((tag) => tags.add(tag));
    });

    return [...tags].sort((a, b) => a.localeCompare(b));
}

function getRenderableClipPromptGroups() {
    const tempGroups = (Array.isArray(temporaryClipPromptGroups) ? temporaryClipPromptGroups : [])
        .map((group) => ({
            id: group.id || `temp_${temporaryClipPromptGroupSeq++}`,
            name: String(group.name || '임시 그룹').trim() || '임시 그룹',
            prompts: Array.isArray(group.prompts)
                ? group.prompts.map((prompt) => String(prompt || '').trim()).filter(Boolean)
                : [],
            tags: [],
            collapsed: true,
            temporary: true
        }))
        .filter((group) => group.prompts.length);

    return [
        ...tempGroups,
        ...normalizeSharedPromptGroups(clipPromptGroups)
    ];
}

function clipPromptGroupMatchesManagerFilter(group) {
    const search = String(clipPromptGroupSearchText || '').trim().toLowerCase();
    const tag = String(clipPromptGroupActiveTag || 'ALL');

    if (tag !== 'ALL' && !(group.tags || []).includes(tag)) {
        return false;
    }

    if (!search) return true;

    const haystack = [
        group.name,
        (group.tags || []).join(' '),
        (group.prompts || []).join(' ')
    ].join(' ').toLowerCase();

    return haystack.includes(search);
}

function getFilteredClipPromptGroupsForManager() {
    return normalizeSharedPromptGroups(clipPromptGroups)
        .map((group, index) => ({ group, index }))
        .filter(({ group }) => clipPromptGroupMatchesManagerFilter(group));
}

function ensureClipPromptGroupManagerControls() {
    const list = el('clipPromptGroupList');
    if (!list || el('clipPromptGroupManagerControls')) return;

    const controls = document.createElement('div');
    controls.id = 'clipPromptGroupManagerControls';
    controls.style.cssText = `
        display:flex;
        flex-direction:column;
        gap:8px;
        margin-bottom:12px;
        padding:10px;
        border:1px solid var(--border-color);
        border-radius:10px;
        background:rgba(255,255,255,0.03);
    `;

    controls.innerHTML = `
        <div style="display:flex; gap:8px; align-items:center;">
            <input id="clipPromptGroupSearchInput"
                   type="text"
                   placeholder="그룹명 / 태그 / 프롬프트 검색..."
                   style="flex:1; min-width:0; padding:9px 11px; border-radius:8px; border:1px solid var(--border-color); background:var(--bg-color); color:var(--text-color);">
            <select id="clipPromptGroupTagFilter"
                    style="width:160px; padding:9px 34px 9px 10px; border-radius:8px; border:1px solid var(--border-color); background-color:var(--bg-color); color:var(--text-color); appearance:none; background-image:url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%228%22 viewBox=%220 0 12 8%22%3E%3Cpath fill=%22%23d1d5db%22 d=%22M1.41.59 6 5.17 10.59.59 12 2l-6 6-6-6z%22/%3E%3C/svg%3E'); background-repeat:no-repeat; background-position:right 13px center;">
                <option value="ALL">전체 태그</option>
            </select>
        </div>
        <div id="clipPromptGroupManagerSummary" style="font-size:12px; color:var(--text-muted);"></div>
    `;

    list.parentNode.insertBefore(controls, list);

    const searchInput = el('clipPromptGroupSearchInput');
    const tagFilter = el('clipPromptGroupTagFilter');

    if (searchInput) {
        searchInput.value = clipPromptGroupSearchText;
        searchInput.oninput = () => {
            clipPromptGroupSearchText = searchInput.value || '';
            clipPromptGroupVisibleLimit = CLIP_PROMPT_GROUP_PAGE_SIZE;
            renderClipPromptGroupList();
        };
    }

    if (tagFilter) {
        tagFilter.onchange = () => {
            clipPromptGroupActiveTag = tagFilter.value || 'ALL';
            clipPromptGroupVisibleLimit = CLIP_PROMPT_GROUP_PAGE_SIZE;
            renderClipPromptGroupList();
        };
    }
}

function updateClipPromptGroupTagFilterOptions() {
    const select = el('clipPromptGroupTagFilter');
    if (!select) return;

    const previous = clipPromptGroupActiveTag || 'ALL';
    const tags = getAllClipPromptGroupTags();

    select.innerHTML = '<option value="ALL">전체 태그</option>';

    tags.forEach((tag) => {
        const option = document.createElement('option');
        option.value = tag;
        option.innerText = `#${tag}`;
        select.appendChild(option);
    });

    select.value = tags.includes(previous) ? previous : 'ALL';
    clipPromptGroupActiveTag = select.value;
}

async function saveClipPromptGroupManagerState(silent = true) {
    clipPromptGroups = normalizeSharedPromptGroups(clipPromptGroups);
    await saveSharedClipPromptGroups(silent);
    renderAllClipPromptTokens();
}

async function updateClipPromptGroupFromManager(index, patch, options = {}) {
    const group = clipPromptGroups[index];
    if (!group) return;

    clipPromptGroups[index] = {
        ...group,
        ...patch
    };

    clipPromptGroups = normalizeSharedPromptGroups(clipPromptGroups);

    await saveClipPromptGroupManagerState(options.silent !== false);
    renderClipPromptGroupList();
    saveCanvasState();
}

function toggleClipPromptGroupCollapsed(index) {
    const group = clipPromptGroups[index];
    if (!group) return;

    clipPromptGroups[index] = {
        ...group,
        collapsed: !Boolean(group.collapsed)
    };

    renderClipPromptGroupList();
}

function renderClipPromptGroupTagChips(container, tags) {
    container.innerHTML = '';

    if (!tags || !tags.length) {
        const empty = document.createElement('span');
        empty.style.cssText = 'font-size:11px; color:var(--text-muted);';
        empty.innerText = '태그 없음';
        container.appendChild(empty);
        return;
    }

    tags.forEach((tag) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.innerText = `#${tag}`;
        chip.style.cssText = `
            border:none;
            border-radius:999px;
            padding:3px 8px;
            font-size:11px;
            font-weight:800;
            background:rgba(255,255,255,0.09);
            color:var(--text-color);
            cursor:pointer;
        `;
        chip.onclick = () => {
            clipPromptGroupActiveTag = tag;
            clipPromptGroupVisibleLimit = CLIP_PROMPT_GROUP_PAGE_SIZE;
            renderClipPromptGroupList();
        };
        container.appendChild(chip);
    });
}

async function fetchJsonOrThrow(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};

    if (!response.ok) {
        throw new Error(data.message || data.error || `HTTP Error ${response.status}`);
    }

    return data;
}

async function saveSharedClipPromptGroups(silent = true) {
    await fetchJsonOrThrow(`/api/shared_prompt_groups?t=${Date.now()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ groups: clipPromptGroups })
    });

    if (!silent && typeof showToast === 'function') {
        showToast('프롬프트 그룹을 저장했습니다.');
    }
}

async function loadSharedClipPromptGroups(mergeLocal = true) {
    try {
        const localGroups = normalizeSharedPromptGroups(clipPromptGroups);
        const data = await fetchJsonOrThrow(`/api/shared_prompt_groups?t=${Date.now()}`, {
            cache: 'no-store'
        });
        const sharedGroups = normalizeSharedPromptGroups(data.groups || []);

        clipPromptGroups = mergeLocal
            ? mergePromptGroupLists(sharedGroups, localGroups)
            : sharedGroups;

        if (mergeLocal && JSON.stringify(clipPromptGroups) !== JSON.stringify(sharedGroups)) {
            await saveSharedClipPromptGroups(true);
        }

        renderAllClipPromptTokens();

        const modal = el('clipPromptGroupModal');
        if (modal && modal.style.display === 'flex') {
            renderClipPromptGroupList();
        }
    } catch (error) {
        console.warn('공용 프롬프트 그룹 로드 실패:', error);

        if (!mergeLocal && typeof showToast === 'function') {
            showToast(`프롬프트 그룹 로드 실패: ${error.message || error}`);
        }
    }
}

async function fetchClipTagDictionary() {
    try {
        const res = await fetch('/api/tag_dictionary');
        const data = await res.json();
        clipTagDictionary = data.tags || {};
    } catch (error) {
        console.warn('Clip tag dictionary load failed:', error);
        clipTagDictionary = {};
    }
}

function getClipPromptField(fieldKey) {
    return getClipPromptFields().find((field) => field.key === fieldKey);
}

function parseClipPromptTokens(promptText) {
    return String(promptText || '')
        .split(',')
        .map((token) => token.trim())
        .filter(Boolean);
}

function joinClipPromptTokens(tokens) {
    return tokens.map((token) => token.trim()).filter(Boolean).join(', ');
}

function stripClipWeightMarkers(token) {
    return String(token || '')
        .replace(/^[-+]?\d+(?:\.\d+)?::\s*/, '')
        .replace(/\s*::$/, '')
        .trim();
}

function normalizeClipTokenForGroup(token) {
    return stripClipWeightMarkers(token).toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeClipLookupKey(value) {
    return String(value || '')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '_');
}

function findClipTagMetadata(token) {
    const editable = stripClipWeightMarkers(token);
    const parts = editable.split(/\s+/).filter(Boolean);

    for (let start = 0; start < parts.length; start++) {
        const candidate = parts.slice(start).join('_').toLowerCase();
        if (clipTagDictionary[candidate]?.ko) return clipTagDictionary[candidate];
    }

    return clipTagDictionary[normalizeClipLookupKey(editable)] || null;
}

function formatClipTokenLabel(token) {
    const cleanToken = stripClipWeightMarkers(token);
    const meta = findClipTagMetadata(token);

    if (meta && meta.ko) {
        return `${meta.group_ko || meta.group || '기타'} / ${meta.ko} | ${cleanToken}`;
    }

    return cleanToken;
}

function getClipTagColor(token) {
    const meta = findClipTagMetadata(token);
    return meta?.color || '#64748b';
}

function getClipPromptGroupColor(name) {
    let hash = 0;
    for (let i = 0; i < String(name || '').length; i++) {
        hash = ((hash << 5) - hash) + String(name).charCodeAt(i);
        hash |= 0;
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue} 70% 48%)`;
}

function appendClipPromptText(surface, text) {
    const span = document.createElement('span');
    span.className = 'prompt-token-text';
    span.innerText = text;
    surface.appendChild(span);
}

function applyClipPromptGroupsWithIndexes(indexedTokens) {
    const parts = [];
    let index = 0;

    while (index < indexedTokens.length) {
        const matched = getRenderableClipPromptGroups().find((group) => {
            const groupTokens = Array.isArray(group.prompts) ? group.prompts : [];
            if (!groupTokens.length || index + groupTokens.length > indexedTokens.length) return false;

            return groupTokens.every((prompt, offset) =>
                normalizeClipTokenForGroup(prompt) === normalizeClipTokenForGroup(indexedTokens[index + offset].token)
            );
        });

        if (matched) {
            const groupTokens = matched.prompts;
            const matchedTokens = indexedTokens.slice(index, index + groupTokens.length);

            parts.push({
                type: 'group',
                name: matched.name,
                temporary: Boolean(matched.temporary),
                id: matched.id || '',
                tokens: matchedTokens.map((part) => part.token),
                indexes: matchedTokens.map((part) => part.index)
            });

            index += groupTokens.length;
        } else {
            parts.push({
                type: 'token',
                token: indexedTokens[index].token,
                index: indexedTokens[index].index
            });

            index += 1;
        }
    }

    return parts;
}

function applyClipWeightedRanges(tokens) {
    const parts = [];
    let index = 0;

    while (index < tokens.length) {
        const token = tokens[index];
        const leadingWeightMatch = token.match(/^([-+]?\d+(?:\.\d+)?)::\s*(.*)$/);
        const isSingleWeightedToken = leadingWeightMatch && /\s*::$/.test(token);

        if (leadingWeightMatch && !isSingleWeightedToken) {
            let end = index + 1;
            while (end < tokens.length && !/\s*::$/.test(tokens[end])) end += 1;

            if (end < tokens.length) {
                parts.push({
                    type: 'weightedRange',
                    prefix: `${leadingWeightMatch[1]}::`,
                    suffix: '::',
                    tokens: tokens.slice(index, end + 1),
                    startIndex: index
                });
                index = end + 1;
                continue;
            }
        }

        parts.push({ type: 'token', token, index });
        index += 1;
    }

    return parts;
}

function renderAllClipPromptTokens() {
    if (typeof CanvasDakiFocus !== 'undefined') CanvasDakiFocus.promptChanged();
    getClipPromptFields().forEach((field) => renderClipPromptTokens(field.key));
}

function renderClipPromptTokens(fieldKey) {
    const field = getClipPromptField(fieldKey);
    if (!field) return;

    const input = el(field.inputId);
    const surface = el(field.tokensId);
    if (!input || !surface) return;

    if (typeof getCanvasStyleLink === 'function') getCanvasStyleLink()?.refresh();
    const tokens = parseClipPromptTokens(input.value);
    const disabledState = getDisabledClipPromptVisualState(fieldKey);

    surface.dataset.clipPromptField = fieldKey;
    surface.onmousedown = (event) => startClipPromptAreaSelection(event, fieldKey, surface);
    surface.innerHTML = '';

    if (!tokens.length) {
        const empty = document.createElement('span');
        empty.style.cssText = 'color: var(--text-muted); font-size: 12px;';
        empty.innerText = '프롬프트를 입력하면 버튼으로 표시됩니다.';
        surface.appendChild(empty);
        return;
    }

    const indexedTokens = tokens.map((token, index) => ({ token, index }));
    const groupedParts = typeof buildCanvasStylePromptParts === 'function'
        ? buildCanvasStylePromptParts(fieldKey, indexedTokens)
        : applyClipPromptGroupsWithIndexes(indexedTokens);

    let pendingTokens = [];

    groupedParts.forEach((part) => {
        if (part.type === 'style') {
            renderClipTokenSequenceWithWeightedRanges(surface, fieldKey, pendingTokens, disabledState);
            pendingTokens = [];
            renderCanvasStylePromptButton(surface, fieldKey, part, disabledState);
            return;
        }
        if (part.type === 'group') {
            renderClipTokenSequenceWithWeightedRanges(surface, fieldKey, pendingTokens, disabledState);
            pendingTokens = [];
            renderClipPromptGroupButton(surface, fieldKey, part, disabledState);
            return;
        }

        pendingTokens.push(part);
    });

    renderClipTokenSequenceWithWeightedRanges(surface, fieldKey, pendingTokens, disabledState);
}

function setupClipPromptSelectableButton(button, fieldKey, startIndex, endIndex) {
    button.dataset.clipPromptField = fieldKey;
    button.dataset.clipPromptStart = String(startIndex);
    button.dataset.clipPromptEnd = String(endIndex);
}

function startClipPromptAreaSelection(event, fieldKey, surface) {
    if (event.button !== 0 || clipPromptViewMode !== 'buttons') return;
    if (event.target.closest?.('.prompt-token-btn')) return;

    activeClipAreaSelection = {
        fieldKey,
        surface,
        originX: event.clientX,
        originY: event.clientY,
        clientX: event.clientX,
        clientY: event.clientY,
        start: null,
        end: null,
        selectedIndexes: new Set(),
        moved: false
    };

    clearClipButtonSelectionMarks();
    updateClipAreaSelectionBox(event.clientX, event.clientY);
    event.preventDefault();
}

function getClipAreaSelectionBox() {
    let box = el('clipPromptAreaSelectionBox');
    if (!box) {
        box = document.createElement('div');
        box.id = 'clipPromptAreaSelectionBox';
        box.className = 'clip-prompt-area-selection-box';
        document.body.appendChild(box);
    }
    return box;
}

function getRectFromPoints(x1, y1, x2, y2) {
    return {
        left: Math.min(x1, x2),
        top: Math.min(y1, y2),
        right: Math.max(x1, x2),
        bottom: Math.max(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1)
    };
}

function domRectsIntersect(a, b) {
    return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

function updateClipAreaSelectionBox(clientX, clientY) {
    const state = activeClipAreaSelection;
    if (!state) return;

    state.clientX = clientX;
    state.clientY = clientY;
    state.moved = state.moved || Math.abs(clientX - state.originX) > 4 || Math.abs(clientY - state.originY) > 4;

    const rect = getRectFromPoints(state.originX, state.originY, clientX, clientY);
    const box = getClipAreaSelectionBox();
    box.style.display = state.moved ? 'block' : 'none';
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;

    updateClipAreaSelectionMarks(rect);
}

function updateClipAreaSelectionMarks(selectionRect) {
    const state = activeClipAreaSelection;
    if (!state) return;

    clearClipButtonSelectionMarks();

    state.selectedIndexes = state.selectedIndexes instanceof Set
        ? state.selectedIndexes
        : new Set();

    state.surface.querySelectorAll('.prompt-token-btn[data-clip-prompt-field]').forEach((node) => {
        if (node.dataset.clipPromptField !== state.fieldKey) return;

        const start = Number(node.dataset.clipPromptStart);
        const end = Number(node.dataset.clipPromptEnd);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return;

        const rect = node.getBoundingClientRect();
        if (!domRectsIntersect(selectionRect, rect)) return;

        const partStart = Math.min(start, end);
        const partEnd = Math.max(start, end);
        for (let index = partStart; index <= partEnd; index += 1) {
            state.selectedIndexes.add(index);
        }
    });

    if (!state.selectedIndexes.size) {
        state.start = null;
        state.end = null;
        return;
    }

    const selected = [...state.selectedIndexes].sort((a, b) => a - b);
    const nextStart = selected[0];
    const nextEnd = selected[selected.length - 1];

    state.start = nextStart;
    state.end = nextEnd;

    state.surface.querySelectorAll('.prompt-token-btn[data-clip-prompt-field]').forEach((node) => {
        if (node.dataset.clipPromptField !== state.fieldKey) return;

        const start = Number(node.dataset.clipPromptStart);
        const end = Number(node.dataset.clipPromptEnd);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return;

        if (Math.max(start, end) >= nextStart && Math.min(start, end) <= nextEnd) {
            node.classList.add('button-selected');
        }
    });
}

function clearClipButtonSelectionMarks() {
    document.querySelectorAll('.prompt-token-btn.button-selected').forEach((node) => {
        node.classList.remove('button-selected');
    });
}

function hideClipAreaSelectionBox() {
    const box = el('clipPromptAreaSelectionBox');
    if (box) box.style.display = 'none';
}

function finishClipPromptAreaSelection(event) {
    if (!activeClipAreaSelection) return;

    const state = activeClipAreaSelection;
    activeClipAreaSelection = null;
    hideClipAreaSelectionBox();

    const field = getClipPromptField(state.fieldKey);
    const input = field ? el(field.inputId) : null;
    if (!input) {
        clearClipButtonSelectionMarks();
        return;
    }

    const tokens = parseClipPromptTokens(input.value);
    const start = Number(state.start);
    const end = Number(state.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
        clearClipButtonSelectionMarks();
        return;
    }

    const selectedTokens = tokens.slice(start, end + 1);

    if (!selectedTokens.length || !state.moved) {
        clearClipButtonSelectionMarks();
        return;
    }

    selectedClipPromptGroup = {
        inputId: input.id,
        fieldKey: state.fieldKey,
        tokenStart: start,
        tokenEnd: end,
        text: joinClipPromptTokens(selectedTokens)
    };

    suppressNextClipPromptSelectionClear = true;
    setTimeout(() => {
        suppressNextClipPromptSelectionClear = false;
    }, 0);
    showClipGroupSelectionPopoverAt(event.clientX || state.clientX, event.clientY || state.clientY);
}

document.addEventListener('mousemove', (event) => {
    updateClipAreaSelectionBox(event.clientX, event.clientY);
});

document.addEventListener('mouseup', (event) => {
    finishClipPromptAreaSelection(event);
});

function renderClipTokenSequenceWithWeightedRanges(surface, fieldKey, sequence, disabledState) {
    const weightedParts = applyClipWeightedRanges(sequence.map((part) => part.token));

    weightedParts.forEach((part) => {
        if (part.type === 'weightedRange') {
            const mappedStart = sequence[part.startIndex]?.index ?? part.startIndex;
            renderClipWeightedRangePart(surface, fieldKey, {
                ...part,
                startIndex: mappedStart
            }, disabledState);
            return;
        }

        const original = sequence[part.index];
        if (!original) return;

        renderClipPromptPart(surface, fieldKey, part.token, original.index, disabledState);
    });
}

function renderClipPromptPart(surface, fieldKey, token, index, disabledState) {
    const leadingWeightMatch = token.match(/^([-+]?\d+(?:\.\d+)?)::\s*(.*)$/);
    const trailingWeightMatch = token.match(/^(.*?)\s*::$/);
    const isDisabled = isClipPromptTokenDisabledByControls(token, disabledState);
    const disabledTitle = isDisabled ? '\n현재 OFF 상태의 제어그룹에 들어 있어 요청에 포함되지 않습니다.' : '';

    if (leadingWeightMatch && trailingWeightMatch) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `prompt-token-btn weighted-single ${findClipTagMetadata(token)?.ko ? 'has-ko' : ''} ${isDisabled ? 'disabled-by-control' : ''}`.trim();
        button.style.setProperty('--tag-color', getClipTagColor(token));
        button.innerText = `${leadingWeightMatch[1]}:: ${formatClipTokenLabel(token)} ::`;
        button.title = `더블 클릭해서 프롬프트 내용만 수정${disabledTitle}`;
        button.ondblclick = () => startClipTokenEdit(fieldKey, index, token, button);
        setupClipPromptSelectableButton(button, fieldKey, index, index);

        button.draggable = true;
        button.ondragstart = (event) => {
            setClipPromptDragData(event, {
                field: fieldKey,
                type: 'token',
                token
            });
        };

        button.oncontextmenu = (event) => {
            event.preventDefault();
            event.stopPropagation();
            openTagTranslationModal(stripClipWeightMarkers(token), event);
        };

        surface.appendChild(button);
        return;
    }

    if (leadingWeightMatch) appendClipPromptText(surface, `${leadingWeightMatch[1]}::`);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = `prompt-token-btn ${findClipTagMetadata(token)?.ko ? 'has-ko' : ''} ${isDisabled ? 'disabled-by-control' : ''}`.trim();
    button.style.setProperty('--tag-color', getClipTagColor(token));
    button.innerText = formatClipTokenLabel(token);
    button.title = `더블 클릭해서 프롬프트 내용만 수정${disabledTitle}`;
    button.ondblclick = () => startClipTokenEdit(fieldKey, index, token, button);
    setupClipPromptSelectableButton(button, fieldKey, index, index);

    button.draggable = true;
    button.ondragstart = (event) => {
        setClipPromptDragData(event, {
            field: fieldKey,
            type: 'token',
            token
        });
    };

    button.oncontextmenu = (event) => {
        event.preventDefault();
        event.stopPropagation();
        openTagTranslationModal(stripClipWeightMarkers(token), event);
    };

    surface.appendChild(button);

    if (trailingWeightMatch) appendClipPromptText(surface, '::');
}

function renderClipWeightedRangePart(surface, fieldKey, part, disabledState) {
    const hasDisabledItems = (part.tokens || []).some((token) =>
        isClipPromptTokenDisabledByControls(token, disabledState)
    );

    const button = document.createElement('button');
    button.type = 'button';
    button.className = `prompt-token-btn weighted-range ${hasDisabledItems ? 'has-disabled-items' : ''}`.trim();
    button.title = part.tokens.join(', ');
    button.ondblclick = () => startClipWeightedRangeEdit(fieldKey, part, button);
    setupClipPromptSelectableButton(button, fieldKey, part.startIndex, part.startIndex + part.tokens.length - 1);

    const prefix = document.createElement('span');
    prefix.className = 'prompt-token-range-marker';
    prefix.innerText = part.prefix;
    button.appendChild(prefix);

    applyClipPromptGroupsWithIndexes(part.tokens.map((token, index) => ({ token, index }))).forEach((groupedPart) => {
        if (groupedPart.type === 'group') {
            const isDisabledGroup = isClipPromptGroupDisabledByControls(groupedPart.tokens, disabledState);

            const chip = document.createElement('span');
            chip.className = `prompt-token-inner-chip group ${isDisabledGroup ? 'disabled-by-control' : ''}`.trim();
            chip.style.setProperty('--group-color', getClipPromptGroupColor(groupedPart.name));
            chip.innerText = `[${groupedPart.name}]`;
            chip.title = `${groupedPart.tokens.join(', ')}${isDisabledGroup ? '\n현재 OFF 상태의 제어그룹에 들어 있어 요청에 포함되지 않습니다.' : ''}`;
            chip.draggable = true;
            chip.ondragstart = (event) => {
                event.stopPropagation();
                setClipPromptDragData(event, {
                    field: fieldKey,
                    type: 'group',
                    name: groupedPart.name,
                    tokens: groupedPart.tokens
                });
            };

            chip.oncontextmenu = (event) => {
                event.preventDefault();
                event.stopPropagation();

                const firstToken = Array.isArray(groupedPart.tokens)
                    ? groupedPart.tokens[0]
                    : '';

                openTagTranslationModal(stripClipWeightMarkers(firstToken), event);
            };

            button.appendChild(chip);
            return;
        }

        const token = groupedPart.token;
        const isDisabledToken = isClipPromptTokenDisabledByControls(token, disabledState);

        const chip = document.createElement('span');
        chip.className = `prompt-token-inner-chip ${findClipTagMetadata(token)?.ko ? 'has-ko' : ''} ${isDisabledToken ? 'disabled-by-control' : ''}`.trim();
        chip.style.setProperty('--tag-color', getClipTagColor(token));
        chip.innerText = formatClipTokenLabel(token);
        chip.title = isDisabledToken ? '현재 OFF 상태의 제어그룹에 들어 있어 요청에 포함되지 않습니다.' : '';
        chip.draggable = true;
        chip.ondragstart = (event) => {
            event.stopPropagation();
            setClipPromptDragData(event, {
                field: fieldKey,
                type: 'token',
                token
            });
        };
        chip.oncontextmenu = (event) => {
            event.preventDefault();
            event.stopPropagation();
            openTagTranslationModal(stripClipWeightMarkers(token), event);
        };
        button.appendChild(chip);
    });

    const suffix = document.createElement('span');
    suffix.className = 'prompt-token-range-marker';
    suffix.innerText = part.suffix;
    button.appendChild(suffix);

    surface.appendChild(button);
}

function renderClipPromptGroupButton(surface, fieldKey, groupPart, disabledState) {
    const isDisabled = isClipPromptGroupDisabledByControls(groupPart.tokens, disabledState);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = `prompt-token-btn group ${groupPart.temporary ? 'temporary-group' : ''} ${isDisabled ? 'disabled-by-control' : ''}`.trim();
    button.style.setProperty('--group-color', getClipPromptGroupColor(groupPart.name));
    button.innerText = `[${groupPart.name}]`;
    button.title = `${groupPart.tokens.join(', ')}${groupPart.temporary ? '\n임시 그룹입니다. 클릭하면 해제 메뉴가 열립니다.' : ''}${isDisabled ? '\n현재 OFF 상태의 제어그룹에 들어 있어 요청에 포함되지 않습니다.' : ''}`;

    const indexes = Array.isArray(groupPart.indexes) ? groupPart.indexes : [];
    if (indexes.length && !groupPart.temporary) {
        setupClipPromptSelectableButton(button, fieldKey, Math.min(...indexes), Math.max(...indexes));
    }

    if (groupPart.temporary) {
        button.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            openTemporaryClipPromptGroupMenu(groupPart.id, event);
        };
    }

    button.draggable = true;
    button.ondragstart = (event) => {
        setClipPromptDragData(event, {
            field: fieldKey,
            type: 'group',
            name: groupPart.name,
            tokens: groupPart.tokens
        });
    };

    surface.appendChild(button);
}

function getClipEditableTokenValue(token) {
    return stripClipWeightMarkers(token);
}

function rebuildClipTokenValue(originalToken, editedValue) {
    const leadingWeightMatch = originalToken.match(/^([-+]?\d+(?:\.\d+)?)::\s*(.*)$/);
    const trailingWeightMatch = originalToken.match(/^(.*?)\s*::$/);
    const prefix = leadingWeightMatch ? `${leadingWeightMatch[1]}::` : '';
    const suffix = trailingWeightMatch ? '::' : '';
    return `${prefix}${String(editedValue || '').trim()}${suffix}`;
}

function startClipTokenEdit(fieldKey, index, token, button) {
    const editor = document.createElement('input');
    editor.type = 'text';
    editor.className = 'prompt-token-edit';
    editor.setAttribute('data-prompt-autocomplete', '');
    editor.value = getClipEditableTokenValue(token);

    editor.onkeydown = (event) => {
        if (event.key === 'Enter') finishClipTokenEdit(fieldKey, index, token, editor.value);
        if (event.key === 'Escape') renderClipPromptTokens(fieldKey);
    };

    editor.onblur = () => finishClipTokenEdit(fieldKey, index, token, editor.value);

    button.replaceWith(editor);
    editor.focus();
    editor.select();
}

function finishClipTokenEdit(fieldKey, index, originalToken, editedValue) {
    const field = getClipPromptField(fieldKey);
    if (!field) return;

    const input = el(field.inputId);
    if (!input) return;

    const tokens = parseClipPromptTokens(input.value);
    if (index < 0 || index >= tokens.length) return;

    const rebuilt = rebuildClipTokenValue(originalToken, editedValue);

    if (rebuilt) tokens[index] = rebuilt;
    else tokens.splice(index, 1);

    input.value = joinClipPromptTokens(tokens);
    renderClipPromptTokens(fieldKey);
    saveCanvasState();
}

function startClipWeightedRangeEdit(fieldKey, part, button) {
    const editor = document.createElement('input');
    editor.type = 'text';
    editor.className = 'prompt-token-edit';
    editor.setAttribute('data-prompt-autocomplete', '');
    editor.value = part.tokens.map(stripClipWeightMarkers).join(', ');

    editor.onkeydown = (event) => {
        if (event.key === 'Enter') finishClipWeightedRangeEdit(fieldKey, part, editor.value);
        if (event.key === 'Escape') renderClipPromptTokens(fieldKey);
    };

    editor.onblur = () => finishClipWeightedRangeEdit(fieldKey, part, editor.value);

    button.replaceWith(editor);
    editor.focus();
    editor.select();
}

function finishClipWeightedRangeEdit(fieldKey, part, editedValue) {
    const field = getClipPromptField(fieldKey);
    if (!field) return;

    const input = el(field.inputId);
    if (!input) return;

    const tokens = parseClipPromptTokens(input.value);
    const replacement = parseClipPromptTokens(editedValue);
    if (!replacement.length) return;

    replacement[0] = `${part.prefix}${replacement[0]}`;
    replacement[replacement.length - 1] = `${replacement[replacement.length - 1]}${part.suffix}`;

    tokens.splice(part.startIndex, part.tokens.length, ...replacement);

    input.value = joinClipPromptTokens(tokens);
    renderClipPromptTokens(fieldKey);
    saveCanvasState();
}

function bindClipPromptInputs() {
    getClipPromptFields().forEach((field) => {
        const input = el(field.inputId);
        if (!input || input.dataset.clipPromptBound === '1') return;

        input.dataset.clipPromptBound = '1';
        input.addEventListener('input', () => renderClipPromptTokens(field.key));
        input.addEventListener('mouseup', handleClipPromptSelection);
        input.addEventListener('keyup', handleClipPromptSelection);
        input.addEventListener('blur', () => saveCanvasState());
    });
}

function toggleClipPromptViewMode() {
    clipPromptViewMode = clipPromptViewMode === 'buttons' ? 'text' : 'buttons';

    if (clipPromptViewMode === 'buttons') {
        renderAllClipPromptTokens();
    }

    applyClipPromptViewMode();
}

function applyClipPromptViewMode() {
    const useText = clipPromptViewMode === 'text';

    getClipPromptFields().forEach((field) => {
        const input = el(field.inputId);
        const surface = el(field.tokensId);

        if (input) input.style.display = useText ? 'block' : 'none';
        if (surface) surface.style.display = useText ? 'none' : 'flex';
    });

    const toggle = el('clipPromptViewToggle');
    if (toggle) toggle.innerText = useText ? '버튼 보기' : '텍스트 편집';
}

function setClipPromptEditorValue(kind, value) {
    const field = getClipPromptField(kind);
    const input = field ? el(field.inputId) : null;
    if (input) input.value = String(value || '');
}

function getClipPromptEditorValue(kind) {
    const field = getClipPromptField(kind);
    const input = field ? el(field.inputId) : null;
    return input ? String(input.value || '') : '';
}

function handleClipPromptSelection(event) {
    if (clipPromptViewMode !== 'text') return;

    const input = event.target;
    if (!input || !getClipPromptFields().some((field) => field.inputId === input.id)) return;

    const start = input.selectionStart;
    const end = input.selectionEnd;
    const selectedText = input.value.slice(start, end).trim();

    if (!selectedText || start === end) {
        hideClipGroupSelectionPopover();
        return;
    }

    selectedClipPromptGroup = {
        inputId: input.id,
        start,
        end,
        text: selectedText
    };

    showClipGroupSelectionPopoverAt(event.clientX, event.clientY);
}

function showClipGroupSelectionPopoverAt(clientX, clientY) {
    const popover = el('clipGroupSelectionPopover');
    const nameBox = el('clipPromptGroupNameBox');
    const startButton = el('clipBtnStartPromptGroup');
    const tempButton = el('clipBtnCreateTempPromptGroup');

    if (!popover) return;

    const margin = 12;
    const popoverWidth = 240;
    const popoverHeight = 70;

    const left = Math.min(
        clientX + 8,
        window.innerWidth - popoverWidth - margin
    );

    const top = Math.min(
        clientY + 8,
        window.innerHeight - popoverHeight - margin
    );

    popover.style.left = `${Math.max(margin, left)}px`;
    popover.style.top = `${Math.max(margin, top)}px`;
    popover.style.display = 'block';

    if (nameBox) nameBox.style.display = 'none';
    if (startButton) startButton.style.display = 'inline-block';
    if (tempButton) tempButton.style.display = 'inline-block';
}

function hideClipGroupSelectionPopover() {
    const popover = el('clipGroupSelectionPopover');
    if (popover) popover.style.display = 'none';
    selectedClipPromptGroup = null;
    clearClipButtonSelectionMarks();
    hideClipAreaSelectionBox();
}

function showClipPromptGroupNameInput() {
    const nameBox = el('clipPromptGroupNameBox');
    const startButton = el('clipBtnStartPromptGroup');
    const tempButton = el('clipBtnCreateTempPromptGroup');
    const input = el('clipPromptGroupNameInput');

    if (startButton) startButton.style.display = 'none';
    if (tempButton) tempButton.style.display = 'none';
    if (nameBox) nameBox.style.display = 'flex';

    if (input) {
        input.value = '';
        input.focus();
    }
}

async function saveSelectedClipPromptGroup() {
    if (!selectedClipPromptGroup) return;

    const name = el('clipPromptGroupNameInput')?.value.trim();
    const prompts = parseClipPromptTokens(selectedClipPromptGroup.text);

    if (!name || !prompts.length) return;

    clipPromptGroups = clipPromptGroups.filter((group) => group.name !== name);
    clipPromptGroups.push({ name, prompts, tags: [], collapsed: true });
    clipPromptGroups = normalizeSharedPromptGroups(clipPromptGroups);

    await saveSharedClipPromptGroups(false);

    hideClipGroupSelectionPopover();
    renderAllClipPromptTokens();
    renderClipPromptGroupList();
    saveCanvasState();
}

function saveSelectedTemporaryClipPromptGroup() {
    if (!selectedClipPromptGroup) return;

    const prompts = parseClipPromptTokens(selectedClipPromptGroup.text);
    if (!prompts.length) return;

    const name = `임시 그룹 ${temporaryClipPromptGroupSeq}`;
    temporaryClipPromptGroups.push({
        id: `temp_${Date.now()}_${temporaryClipPromptGroupSeq++}`,
        name,
        prompts,
        temporary: true
    });

    hideClipGroupSelectionPopover();
    renderAllClipPromptTokens();
}

function openTemporaryClipPromptGroupMenu(groupId, event) {
    closeTemporaryClipPromptGroupMenu();

    const group = temporaryClipPromptGroups.find((item) => String(item.id) === String(groupId));
    if (!group) return;

    const menu = document.createElement('div');
    menu.id = 'temporaryClipPromptGroupMenu';
    menu.className = 'prompt-group-popover temporary-group-menu';
    menu.style.display = 'block';
    menu.style.left = `${Math.min(event.clientX + 8, window.innerWidth - 180)}px`;
    menu.style.top = `${Math.min(event.clientY + 8, window.innerHeight - 60)}px`;

    const button = document.createElement('button');
    button.type = 'button';
    button.innerText = '임시 그룹 해제';
    button.onclick = () => removeTemporaryClipPromptGroup(groupId);

    menu.appendChild(button);
    document.body.appendChild(menu);
}

function closeTemporaryClipPromptGroupMenu() {
    const menu = el('temporaryClipPromptGroupMenu');
    if (menu) menu.remove();
}

function removeTemporaryClipPromptGroup(groupId) {
    temporaryClipPromptGroups = temporaryClipPromptGroups.filter((group) => String(group.id) !== String(groupId));
    closeTemporaryClipPromptGroupMenu();
    renderAllClipPromptTokens();
}

async function openClipPromptGroupManager() {
    hideClipGroupSelectionPopover();

    await loadSharedClipPromptGroups(false);

    clipPromptGroupVisibleLimit = CLIP_PROMPT_GROUP_PAGE_SIZE;
    ensureClipPromptGroupManagerControls();
    renderClipPromptGroupList();

    if (typeof showToast === 'function') {
        showToast(`프롬프트 그룹 ${clipPromptGroups.length}개를 불러왔습니다.`);
    }

    const modal = el('clipPromptGroupModal');
    if (modal) {
        modal.style.display = 'flex';
        modal.style.zIndex = '27000';
    }
}

function closeClipPromptGroupManager() {
    const modal = el('clipPromptGroupModal');
    if (modal) modal.style.display = 'none';
}

function renderClipPromptGroupList() {
    const list = el('clipPromptGroupList');
    if (!list) return;

    ensureClipPromptGroupManagerControls();
    updateClipPromptGroupTagFilterOptions();

    list.innerHTML = '';

    const filtered = getFilteredClipPromptGroupsForManager();
    const visibleItems = filtered.slice(0, clipPromptGroupVisibleLimit);
    const summary = el('clipPromptGroupManagerSummary');

    if (summary) {
        summary.innerText = `전체 ${clipPromptGroups.length}개 · 표시 ${visibleItems.length}/${filtered.length}개`;
    }

    if (!filtered.length) {
        const empty = document.createElement('div');
        empty.style.cssText = 'color: var(--text-muted); font-size: 13px; padding:14px;';
        empty.innerText = clipPromptGroups.length ? '검색/태그 조건에 맞는 그룹이 없습니다.' : '저장된 그룹이 없습니다.';
        list.appendChild(empty);
        return;
    }

    visibleItems.forEach(({ group, index }) => {
        const row = document.createElement('div');
        row.style.cssText = `
            border:1px solid var(--border-color);
            border-radius:12px;
            padding:10px;
            background:var(--bg-color);
            display:grid;
            grid-template-columns:minmax(0,1fr) 52px;
            gap:10px;
            margin-bottom:10px;
        `;

        const body = document.createElement('div');
        body.style.cssText = 'min-width:0; display:flex; flex-direction:column; gap:8px;';

        const top = document.createElement('div');
        top.style.cssText = 'display:flex; gap:8px; align-items:center;';

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.innerText = group.collapsed ? '펼치기' : '접기';
        toggle.style.cssText = 'width:58px; padding:6px 0; font-size:12px;';
        toggle.onclick = () => toggleClipPromptGroupCollapsed(index);

        const nameInput = document.createElement('input');
        nameInput.value = group.name || '';
        nameInput.placeholder = '그룹명';
        nameInput.style.cssText = `
            flex:1;
            min-width:0;
            padding:7px 9px;
            border-radius:8px;
            border:1px solid var(--border-color);
            background:rgba(255,255,255,0.04);
            color:var(--text-color);
            font-weight:900;
        `;

        top.appendChild(toggle);
        top.appendChild(nameInput);

        const tagInput = document.createElement('input');
        tagInput.value = (group.tags || []).join(', ');
        tagInput.placeholder = '태그 입력: 그림체, 고퀄, 자주씀';
        tagInput.style.cssText = `
            width:100%;
            box-sizing:border-box;
            padding:7px 9px;
            border-radius:8px;
            border:1px solid var(--border-color);
            background:rgba(255,255,255,0.04);
            color:var(--text-color);
            font-size:12px;
        `;

        const chips = document.createElement('div');
        chips.style.cssText = 'display:flex; gap:5px; flex-wrap:wrap;';
        renderClipPromptGroupTagChips(chips, group.tags || []);

        const preview = document.createElement('div');
        preview.style.cssText = `
            font-size:12px;
            color:var(--text-muted);
            overflow:hidden;
            text-overflow:ellipsis;
            white-space:nowrap;
            border-top:1px dashed var(--border-color);
            padding-top:8px;
        `;
        preview.innerText = (group.prompts || []).join(', ');

        const promptArea = document.createElement('textarea'); promptArea.setAttribute('data-prompt-autocomplete', '');
        promptArea.value = (group.prompts || []).join(', ');
        promptArea.rows = 5;
        promptArea.style.cssText = `
            width:100%;
            box-sizing:border-box;
            resize:vertical;
            min-height:86px;
            max-height:220px;
            padding:8px 9px;
            border-radius:8px;
            border:1px solid var(--border-color);
            background:rgba(255,255,255,0.04);
            color:var(--text-color);
            font-size:12px;
            line-height:1.45;
        `;

        body.appendChild(top);
        body.appendChild(tagInput);
        body.appendChild(chips);

        if (group.collapsed) {
            body.appendChild(preview);
        } else {
            body.appendChild(promptArea);
        }

        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex; flex-direction:column; gap:8px; align-items:flex-end; justify-content:flex-start;';

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'success';
        saveBtn.innerText = '저장';
        saveBtn.style.cssText = `
            width:44px;
            height:32px;
            padding:0;
            font-size:12px;
            border-radius:8px;
        `;
        saveBtn.onclick = async () => {
            const nextName = nameInput.value.trim();
            const nextTags = getClipPromptGroupTagsFromInput(tagInput.value);
            const nextPrompts = group.collapsed
                ? (group.prompts || [])
                : parseClipPromptTokens(promptArea.value);

            if (!nextName) {
                showToast('그룹명을 입력하세요.');
                return;
            }

            if (!nextPrompts.length) {
                showToast('프롬프트 내용이 비어 있습니다.');
                return;
            }

            await updateClipPromptGroupFromManager(index, {
                name: nextName,
                tags: nextTags,
                prompts: nextPrompts,
                collapsed: Boolean(clipPromptGroups[index]?.collapsed)
            }, { silent: false });
        };

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'danger';
        del.innerText = '삭제';
        del.style.cssText = `
            width:44px;
            height:32px;
            padding:0;
            font-size:12px;
            border-radius:8px;
        `;
        del.onclick = () => deleteClipPromptGroup(index);

        actions.appendChild(saveBtn);
        actions.appendChild(del);
        row.appendChild(body);
        row.appendChild(actions);
        list.appendChild(row);
    });

    if (filtered.length > visibleItems.length) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'secondary';
        more.style.cssText = 'width:100%; padding:10px; margin-top:4px;';
        more.innerText = `더 보기 (${visibleItems.length}/${filtered.length})`;
        more.onclick = () => {
            clipPromptGroupVisibleLimit += CLIP_PROMPT_GROUP_PAGE_SIZE;
            renderClipPromptGroupList();
        };
        list.appendChild(more);
    }
}

async function deleteClipPromptGroup(index) {
    clipPromptGroups.splice(index, 1);
    clipPromptGroups = normalizeSharedPromptGroups(clipPromptGroups);

    await saveSharedClipPromptGroups(false);

    renderClipPromptGroupList();
    renderAllClipPromptTokens();
    saveCanvasState();
}

function switchClipPromptTab(tab) {
    const btnBase = el('clipBtnTabBase');
    const btnNegative = el('clipBtnTabNegative');
    const tabBase = el('clipTabBase');
    const tabNegative = el('clipTabNegative');

    if (!btnBase || !btnNegative || !tabBase || !tabNegative) return;

    if (tab === 'base') {
        btnBase.classList.add('active');
        btnNegative.classList.remove('active');
        tabBase.style.display = 'block';
        tabNegative.style.display = 'none';
    } else {
        btnNegative.classList.add('active');
        btnBase.classList.remove('active');
        tabNegative.style.display = 'block';
        tabBase.style.display = 'none';
    }
}

function switchClipInstancePromptTab(tab) {
    const btnBase = el('clipInstanceTabBaseBtn');
    const btnNegative = el('clipInstanceTabNegativeBtn');
    const tabBase = el('clipInstanceTabBase');
    const tabNegative = el('clipInstanceTabNegative');

    if (!btnBase || !btnNegative || !tabBase || !tabNegative) return;

    const showBase = tab === 'base';
    btnBase.classList.toggle('active', showBase);
    btnNegative.classList.toggle('active', !showBase);
    btnBase.setAttribute('aria-pressed', String(showBase));
    btnNegative.setAttribute('aria-pressed', String(!showBase));
    tabBase.hidden = !showBase;
    tabNegative.hidden = showBase;
}

function findTopVisibleInpaintClipInLayers(layers, excludeClipId = null) {
    if (!Array.isArray(layers)) return null;

    // 배열 앞쪽이 위 레이어이므로 앞에서부터 찾으면 "가장 위"를 찾게 됨
    for (const layer of layers) {
        if (!layer || !layer.visible) continue;

        if ((layer.type === 'folder' || layer.type === 'selection') && Array.isArray(layer.children)) {
            const nested = findTopVisibleInpaintClipInLayers(layer.children, excludeClipId);
            if (nested) return nested;
            continue;
        }

        if (
            layer.type === 'clip' &&
            layer.id !== excludeClipId &&
            layer.renderOnCanvas &&
            layer.src
        ) {
            return layer;
        }
    }

    return null;
}

function getTopVisibleInpaintClipForSelection(selection, baseClip) {
    if (!selection || !Array.isArray(selection.children)) return null;
    return findTopVisibleInpaintClipInLayers(selection.children, baseClip?.id || null);
}

function collectVisibleInpaintClipsForMergedSource(layers, excludeClipId = null, output = []) {
    if (!Array.isArray(layers)) return output;

    // 레이어 렌더링 순서와 맞추기 위해 아래 레이어부터 위 레이어 순서로 수집한다.
    [...layers].reverse().forEach((layer) => {
        if (!layer || layer.visible === false) return;

        if ((layer.type === 'folder' || layer.type === 'selection') && Array.isArray(layer.children)) {
            collectVisibleInpaintClipsForMergedSource(layer.children, excludeClipId, output);
            return;
        }

        if (
            layer.type === 'clip' &&
            layer.renderOnCanvas === true &&
            layer.src &&
            Number(layer.id) !== Number(excludeClipId)
        ) {
            output.push(layer);
        }
    });

    return output;
}

async function renderMergedClipSourceToDataUrl(selection, baseClip) {
    if (!selection || !baseClip || !baseClip.src) {
        throw new Error('통합할 클립을 찾을 수 없습니다.');
    }

    const width = Math.round(
        Number(baseClip.imageWidth || baseClip.layerWidth || selection.layerWidth || 0)
    );
    const height = Math.round(
        Number(baseClip.imageHeight || baseClip.layerHeight || selection.layerHeight || 0)
    );

    if (width <= 0 || height <= 0) {
        throw new Error('클립 크기가 올바르지 않습니다.');
    }

    const offscreen = document.createElement('canvas');
    offscreen.width = width;
    offscreen.height = height;

    const ctx = offscreen.getContext('2d');
    ctx.clearRect(0, 0, width, height);

    const baseImg = await loadImageElementForClip(baseClip.src);
    ctx.drawImage(baseImg, 0, 0, width, height);

    const selectionX = Number(selection.x || 0);
    const selectionY = Number(selection.y || 0);
    const inpaintClips = collectVisibleInpaintClipsForMergedSource(
        selection.children || [],
        baseClip.id
    );

    for (const layer of inpaintClips) {
        const img = await loadImageElementForClip(layer.src);

        if (CanvasSelectionRotation.angle(baseClip.rotation) || CanvasSelectionRotation.angle(layer.rotation)) {
            const baseWidth = Number(baseClip.layerWidth || width);
            const baseHeight = Number(baseClip.layerHeight || height);
            ctx.save();
            ctx.translate(width / 2, height / 2);
            ctx.scale(width / baseWidth, height / baseHeight);
            ctx.rotate(-CanvasSelectionRotation.angle(baseClip.rotation) * Math.PI / 180);
            ctx.translate(-(Number(baseClip.x || 0) + baseWidth / 2), -(Number(baseClip.y || 0) + baseHeight / 2));
            drawCanvasLayerImage(ctx, img, layer);
            ctx.restore();
            continue;
        }

        const drawX = Math.round(Number(layer.x || selectionX) - selectionX);
        const drawY = Math.round(Number(layer.y || selectionY) - selectionY);
        const drawWidth = Math.round(Number(layer.layerWidth || layer.imageWidth || width));
        const drawHeight = Math.round(Number(layer.layerHeight || layer.imageHeight || height));

        ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);
    }

    return offscreen.toDataURL('image/png');
}

function buildClipMergedSourcePreviewKey(selection, baseClip) {
    if (!selection || !baseClip) return '';

    const parts = [
        `selection:${selection.id}`,
        `base:${baseClip.id}`,
        `baseSrc:${baseClip.src || ''}`,
        `baseSize:${baseClip.imageWidth || baseClip.layerWidth || 0}x${baseClip.imageHeight || baseClip.layerHeight || 0}`,
        `selectionPos:${selection.x || 0},${selection.y || 0}`,
        `baseRotation:${baseClip.rotation || 0}`
    ];

    const inpaintClips = collectVisibleInpaintClipsForMergedSource(
        selection.children || [],
        baseClip.id
    );

    inpaintClips.forEach((clip) => {
        parts.push([
            clip.id,
            clip.src || '',
            clip.visible === false ? 'hidden' : 'visible',
            clip.renderOnCanvas ? 'render' : 'no-render',
            clip.x || 0,
            clip.y || 0,
            clip.layerWidth || clip.imageWidth || 0,
            clip.layerHeight || clip.imageHeight || 0,
            clip.rotation || 0
        ].join(':'));
    });

    return parts.join('|');
}

function clearClipMergedSourcePreviewCache() {
    clipMergedSourcePreviewCache = {
        key: '',
        dataUrl: ''
    };
}

async function ensureClipMergedSourcePreview(selection, baseClip) {
    if (!selection || !baseClip || !isClipInpaintMergedSourceMode) return;

    const key = buildClipMergedSourcePreviewKey(selection, baseClip);
    if (!key) return;

    if (
        clipMergedSourcePreviewCache.key === key &&
        clipMergedSourcePreviewCache.dataUrl
    ) {
        return;
    }

    const seq = ++clipMergedSourcePreviewSeq;

    try {
        const dataUrl = await renderMergedClipSourceToDataUrl(selection, baseClip);

        if (seq !== clipMergedSourcePreviewSeq) return;
        if (!isClipInpaintMergedSourceMode) return;

        const currentTarget = getClipOutputTarget();
        if (!currentTarget || Number(currentTarget.clip?.id) !== Number(baseClip.id)) return;

        const latestKey = buildClipMergedSourcePreviewKey(selection, baseClip);
        if (latestKey !== key) return;

        clipMergedSourcePreviewCache = {
            key,
            dataUrl
        };

        renderClipOutputPanel();

    } catch (error) {
        console.warn('Merged clip source preview failed:', error);
    }
}

function toggleClipInpaintPreview() {
    const target = getClipOutputTarget();
    if (!target || !target.selection || !target.clip) return;

    const previewClip = getTopVisibleInpaintClipForSelection(target.selection, target.clip);

    // 켜려는데 보여줄 인페인팅 결과가 없으면 아무 것도 안 함
    if (!isClipInpaintPreviewMode && !previewClip) {
        return;
    }

    isClipInpaintPreviewMode = !isClipInpaintPreviewMode;

    const cursor = el('clipBrushCursor');
    if (cursor) cursor.style.display = 'none';

    renderClipOutputPanel();
}

function toggleClipInpaintMergedSourceMode() {
    isClipInpaintMergedSourceMode = !isClipInpaintMergedSourceMode;

    // ON/OFF 전환 시 이전 통합 미리보기 캐시를 버린다.
    clearClipMergedSourcePreviewCache();
    clipMergedSourcePreviewSeq += 1;

    renderClipOutputPanel();
    saveCanvasState();
}

function ensureClipPromptControlGroups(clip) {
    if (!clip) return [];

    if (!Array.isArray(clip.promptControlGroups)) {
        clip.promptControlGroups = [];
    }

    const usedIds = new Set();

    clip.promptControlGroups.forEach((group) => {
        let id = Number(group.id);

        // id가 없거나, 이미 사용 중이면 새 id 부여
        if (!Number.isFinite(id) || id <= 0 || usedIds.has(id)) {
            id = getNextClipPromptControlGroupId(clip.promptControlGroups);
            group.id = id;
        }

        usedIds.add(id);
        clipPromptControlGroupSeq = Math.max(clipPromptControlGroupSeq, id + 1);

        if (!group.name) group.name = `제어 그룹 ${group.id}`;
        if (group.enabled === undefined) group.enabled = true;
        if (group.expanded === undefined) group.expanded = true;
        if (!Array.isArray(group.items)) group.items = [];
    });

    return clip.promptControlGroups;
}

function getActiveClipForPromptControl() {
    const found = findCanvasLayer(activeClipPromptId);
    const clip = found?.layer;

    if (!clip || clip.type !== 'clip') return null;

    const owner = getPromptOwnerLayer(clip) || clip;

    ensureClipPromptControlGroups(owner);

    // 현재 클립에도 owner 연결만 보정
    if (owner.id && clip.promptOwnerId !== owner.id) {
        clip.promptOwnerId = owner.id;
    }

    return owner;
}

function addClipPromptControlGroup() {
    const clip = getActiveClipForPromptControl();

    if (!clip) {
        alert('클립 프롬프트 모달을 먼저 열어주세요.');
        return;
    }

    const groups = ensureClipPromptControlGroups(clip);

    const group = {
        id: getNextClipPromptControlGroupId(groups),
        name: `제어 그룹 ${groups.length + 1}`,
        enabled: true,
        expanded: true,
        items: []
    };

    groups.push(group);
    const owner = getActiveClipForPromptControl();
    renderClipPromptControlGroups(owner);
    renderAllClipPromptTokens();
    saveCanvasState();
}

function renderClipPromptControlGroups(clip) {
    const list = el('clipPromptControlGroupList');
    if (!list) return;

    if (!clip) {
        list.innerHTML = '';
        return;
    }

    const groups = ensureClipPromptControlGroups(clip);
    list.innerHTML = '';

    if (!groups.length) {
        list.innerHTML = `<div class="clip-control-empty">제어 그룹을 추가한 뒤 왼쪽 프롬프트 버튼을 드래그해서 넣으세요.</div>`;
        return;
    }

    groups.forEach((group) => {
        const wrapper = document.createElement('div');
        wrapper.className = [
            'clip-control-group',
            group.enabled ? '' : 'off',
            group.expanded ? 'expanded' : ''
        ].filter(Boolean).join(' ');

        wrapper.innerHTML = `
            <div class="clip-control-group-header">
                <div class="clip-control-group-name">${escapeHtml(group.name)}</div>

                <button class="clip-control-icon-btn"
                        title="영역 이름 편집"
                        onclick="editClipPromptControlGroupName(${group.id})">
                    ✎
                </button>

                <button class="clip-control-toggle-btn ${group.enabled ? 'on' : ''}"
                        title="인페인팅에 포함/제외"
                        aria-label="${escapeHtml(group.name)} 프롬프트 포함"
                        aria-pressed="${Boolean(group.enabled)}"
                        onclick="toggleClipPromptControlGroupEnabled(${group.id})">
                    ${group.enabled ? 'ON' : 'OFF'}
                </button>

                <button class="clip-control-icon-btn"
                        title="펼치기/접기"
                        aria-label="${escapeHtml(group.name)} ${group.expanded ? '접기' : '펼치기'}"
                        aria-expanded="${Boolean(group.expanded)}"
                        onclick="toggleClipPromptControlGroupExpanded(${group.id})">
                    ${group.expanded ? '▲' : '▼'}
                </button>

                <button class="clip-control-icon-btn clip-control-delete-btn"
                        title="제어그룹 삭제"
                        aria-label="제어그룹 삭제"
                        onclick="deleteClipPromptControlGroup(${group.id})">
                </button>
            </div>

            <div class="clip-control-group-body">
                <div class="clip-control-drop-zone"
                     data-control-group-id="${group.id}">
                </div>
            </div>
        `;

        const dropZone = wrapper.querySelector('.clip-control-drop-zone');
        bindClipPromptControlDropZone(dropZone, group);

        renderClipPromptControlItems(dropZone, group);

        list.appendChild(wrapper);
    });
}

function renderClipPromptControlItems(dropZone, group) {
    if (!dropZone || !group) return;

    dropZone.innerHTML = '';

    if (!group.items.length) {
        dropZone.innerHTML = `<div class="clip-control-empty">프롬프트 버튼 또는 그룹을 여기로 드래그하세요.</div>`;
        return;
    }

    group.items.forEach((item, index) => {
        const chip = document.createElement('span');
        chip.className = `clip-control-chip ${escapeHtml(item.field || 'base')}`;

        const label = item.type === 'group'
            ? `[${item.name || '그룹'}] ${Array.isArray(item.tokens) ? item.tokens.join(', ') : ''}`
            : item.token || '';

        const fieldLabel = item.field === 'negative'
            ? 'NEG'
            : item.field === 'char'
                ? 'CHAR'
                : 'BASE';

        chip.innerHTML = `
            <strong>${fieldLabel}</strong>
            <span>${escapeHtml(label)}</span>
            <button class="clip-control-chip-remove"
                    title="제거"
                    onclick="removeClipPromptControlItem(${group.id}, ${index})">
                ×
            </button>
        `;

        dropZone.appendChild(chip);
    });
}function renderClipPromptControlItems(dropZone, group) {
    if (!dropZone || !group) return;

    dropZone.innerHTML = '';

    if (!group.items.length) {
        dropZone.innerHTML = `<div class="clip-control-empty">프롬프트 버튼 또는 그룹을 여기로 드래그하세요.</div>`;
        return;
    }

    group.items.forEach((item, index) => {
        const chip = document.createElement('span');
        chip.className = `clip-control-chip ${escapeHtml(item.field || 'base')}`;

        const label = item.type === 'group'
            ? `[${item.name || '그룹'}] ${Array.isArray(item.tokens) ? item.tokens.join(', ') : ''}`
            : item.token || '';

        const fieldLabel = item.field === 'negative'
            ? 'NEG'
            : item.field === 'char'
                ? 'CHAR'
                : 'BASE';

        chip.innerHTML = `
            <strong>${fieldLabel}</strong>
            <span>${escapeHtml(label)}</span>
            <button class="clip-control-chip-remove"
                    title="제거"
                    onclick="removeClipPromptControlItem(${group.id}, ${index})">
                ×
            </button>
        `;

        dropZone.appendChild(chip);
    });
}

function findClipPromptControlGroup(groupId) {
    const clip = getActiveClipForPromptControl();
    if (!clip) return null;

    const groups = ensureClipPromptControlGroups(clip);
    return groups.find((group) => Number(group.id) === Number(groupId)) || null;
}

function editClipPromptControlGroupName(groupId) {
    const group = findClipPromptControlGroup(groupId);
    if (!group) return;

    const nextName = prompt('영역 이름을 입력하세요.', group.name || '');
    if (!nextName || !nextName.trim()) return;

    group.name = nextName.trim();

    const owner = getActiveClipForPromptControl();
    renderClipPromptControlGroups(owner);
    saveCanvasState();
}

function toggleClipPromptControlGroupEnabled(groupId) {
    const group = findClipPromptControlGroup(groupId);
    if (!group) return;

    group.enabled = !group.enabled;

    const owner = getActiveClipForPromptControl();
    renderClipPromptControlGroups(owner);
    renderAllClipPromptTokens();
    saveCanvasState();
}

function toggleClipPromptControlGroupExpanded(groupId) {
    const group = findClipPromptControlGroup(groupId);
    if (!group) return;

    group.expanded = !group.expanded;

    const owner = getActiveClipForPromptControl();
    renderClipPromptControlGroups(owner);
    saveCanvasState();
}

function deleteClipPromptControlGroup(groupId) {
    const owner = getActiveClipForPromptControl();
    if (!owner) return;

    const groups = ensureClipPromptControlGroups(owner);
    const index = groups.findIndex((group) => Number(group.id) === Number(groupId));

    if (index < 0) return;

    const groupName = groups[index].name || '제어 그룹';
    const ok = confirm(`'${groupName}' 제어그룹을 삭제할까요?`);
    if (!ok) return;

    groups.splice(index, 1);
    
    syncAllPromptCopiesFromOwners();

    renderClipPromptControlGroups(owner);
    renderAllClipPromptTokens();
    saveCanvasState();
}

function removeClipPromptControlItem(groupId, itemIndex) {
    const group = findClipPromptControlGroup(groupId);
    if (!group) return;

    group.items.splice(itemIndex, 1);

    const owner = getActiveClipForPromptControl();
    renderClipPromptControlGroups(owner);
    saveCanvasState();
}

function setClipPromptDragData(event, payload) {
    event.dataTransfer.effectAllowed = 'copy';

    let dragPayload = payload;
    const sourceButton = event.currentTarget?.closest?.('.prompt-token-btn[data-clip-prompt-field]')
        || event.target?.closest?.('.prompt-token-btn[data-clip-prompt-field]');
    const selection = selectedClipPromptGroup;
    const field = selection && payload.field === selection.fieldKey
        ? getClipPromptField(payload.field)
        : null;

    if (sourceButton?.classList?.contains('button-selected')
        && field
        && field.inputId === selection.inputId
        && selection.fieldKey === sourceButton.dataset.clipPromptField
        && Number.isInteger(selection.tokenStart)
        && Number.isInteger(selection.tokenEnd)
        && selection.tokenStart >= 0
        && selection.tokenEnd >= selection.tokenStart) {
        const sourceStartValue = sourceButton.dataset.clipPromptStart;
        const sourceEndValue = sourceButton.dataset.clipPromptEnd;
        const sourceStart = Number(sourceStartValue);
        const sourceEnd = Number(sourceEndValue);
        const input = el(field.inputId);
        const tokens = input ? parseClipPromptTokens(input.value) : [];

        if (/^-?\d+$/.test(sourceStartValue || '')
            && /^-?\d+$/.test(sourceEndValue || '')
            && Number.isInteger(sourceStart)
            && Number.isInteger(sourceEnd)
            && sourceStart >= 0
            && sourceEnd >= sourceStart
            && sourceStart >= selection.tokenStart
            && sourceEnd <= selection.tokenEnd
            && selection.tokenEnd < tokens.length) {
            const selectedTokens = tokens.slice(selection.tokenStart, selection.tokenEnd + 1);

            if (selectedTokens.length >= 2 && joinClipPromptTokens(selectedTokens) === selection.text) {
                dragPayload = {
                    field: payload.field,
                    type: 'tokens',
                    tokens: selectedTokens
                };
            }
        }
    }

    event.dataTransfer.setData('application/x-clip-prompt-item', JSON.stringify(dragPayload));
    event.dataTransfer.setData('text/plain', dragPayload.type === 'tokens'
        ? joinClipPromptTokens(dragPayload.tokens)
        : payload.token || payload.name || '');
}

function bindClipPromptControlDropZone(dropZone, group) {
    if (!dropZone || !group) return;

    dropZone.ondragover = (event) => {
        if (!event.dataTransfer.types.includes('application/x-clip-prompt-item')) return;

        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        dropZone.classList.add('drag-over');
    };

    dropZone.ondragleave = () => {
        dropZone.classList.remove('drag-over');
    };

    dropZone.ondrop = (event) => {
        event.preventDefault();
        event.stopPropagation();
        dropZone.classList.remove('drag-over');

        const raw = event.dataTransfer.getData('application/x-clip-prompt-item');
        if (!raw) return;

        let payload = null;

        try {
            payload = JSON.parse(raw);
        } catch (error) {
            console.warn('Prompt control drop parse failed:', error);
            return;
        }

        addClipPromptControlItemToGroup(group.id, payload);
    };
}

function addClipPromptControlItemToGroup(groupId, payload) {
    const group = findClipPromptControlGroup(groupId);
    if (!group || !payload) return;

    const normalized = normalizeClipPromptControlItems(payload);
    if (!normalized) return;

    if (normalized.batch) {
        const existingItems = Array.isArray(group.items) ? group.items : [];
        const seenKeys = new Set(existingItems.map(getClipPromptControlItemKey));
        const itemsToAdd = [];

        normalized.items.forEach((item) => {
            const itemKey = getClipPromptControlItemKey(item);
            if (seenKeys.has(itemKey)) return;
            seenKeys.add(itemKey);
            itemsToAdd.push(item);
        });

        if (!itemsToAdd.length) return;

        group.items = existingItems;
        group.items.push(...itemsToAdd);

        hideClipGroupSelectionPopover();
        const owner = getActiveClipForPromptControl();
        renderClipPromptControlGroups(owner);
        renderAllClipPromptTokens();
        saveCanvasState();
        return;
    }

    const item = normalized.items[0];

    group.items = Array.isArray(group.items) ? group.items : [];

    // 중복 방지
    const itemKey = getClipPromptControlItemKey(item);
    const exists = group.items.some((oldItem) => getClipPromptControlItemKey(oldItem) === itemKey);
    if (exists) return;

    group.items.push(item);

    const owner = getActiveClipForPromptControl();
    renderClipPromptControlGroups(owner);
    renderAllClipPromptTokens();
    saveCanvasState();
}

function normalizeClipPromptControlItems(payload) {
    const field = normalizeClipPromptControlField(payload.field);

    if (payload.type === 'tokens') {
        if (!Array.isArray(payload.tokens) || !payload.tokens.length) return null;
        if (payload.tokens.some((token) => typeof token !== 'string' || !token.trim())) return null;

        return {
            batch: true,
            items: payload.tokens.map((token) => ({
                field,
                type: 'token',
                token: token.trim()
            }))
        };
    }

    if (payload.type === 'group') {
        const tokens = Array.isArray(payload.tokens)
            ? payload.tokens.map((token) => String(token || '').trim()).filter(Boolean)
            : parseClipPromptTokens(payload.token || '');

        if (!tokens.length) return null;

        return {
            batch: false,
            items: [{
                field,
                type: 'group',
                name: payload.name || '그룹',
                tokens
            }]
        };
    }

    const token = String(payload.token || '').trim();
    if (!token) return null;

    return {
        batch: false,
        items: [{
            field,
            type: 'token',
            token
        }]
    };
}

function getClipPromptControlItemKey(item) {
    if (!item) return '';

    const field = normalizeClipPromptControlField(item.field);

    if (item.type === 'group') {
        return `${field}:group:${(item.tokens || []).map(normalizeClipTokenForGroup).join('|')}`;
    }

    return `${field}:token:${normalizeClipTokenForGroup(item.token || '')}`;
}

function normalizeClipPromptControlField(field) {
    const key = String(field || '');
    if (key === 'char' || key.startsWith('char-')) return 'char';
    if (key === 'negative') return 'negative';
    return 'base';
}

function getDisabledClipPromptVisualState(fieldKey) {
    const owner = getActiveClipForPromptControl();
    const groups = ensureClipPromptControlGroups(owner);
    const normalizedField = normalizeClipPromptControlField(fieldKey);

    const tokenKeys = new Set();
    const groupKeys = new Set();

    groups.forEach((group) => {
        if (!group || group.enabled !== false) return;

        const items = Array.isArray(group.items) ? group.items : [];

        items.forEach((item) => {
            const itemField = normalizeClipPromptControlField(item.field);

            if (itemField !== normalizedField) return;

            if (item.type === 'group') {
                const groupKey = (item.tokens || [])
                    .map((token) => normalizeClipTokenForGroup(token))
                    .join('|');

                if (groupKey) {
                    groupKeys.add(groupKey);
                }
                return;
            }

            const tokenKey = normalizeClipTokenForGroup(item.token || '');
            if (tokenKey) {
                tokenKeys.add(tokenKey);
            }
        });
    });

    // Automatic exclusions use compact character indexes, while editor fields have stable IDs.
    let autoField = fieldKey;
    if (normalizedField === 'char') {
        const charFields = getClipPromptFields().filter(field => field.isChar && el(field.inputId)?.value.trim());
        const index = charFields.findIndex(field => field.key === fieldKey);
        autoField = index < 0 ? '' : `char-${index}`;
    }
    const automatic = typeof CanvasDakiFocus !== 'undefined'
        ? CanvasDakiFocus.excludedTokens?.(autoField) || [] : [];
    automatic.forEach(token => tokenKeys.add(normalizeClipTokenForGroup(token)));

    return { tokenKeys, groupKeys };
}

function isClipPromptTokenDisabledByControls(token, disabledState) {
    if (!disabledState) return false;
    return disabledState.tokenKeys.has(normalizeClipTokenForGroup(token || ''));
}

function isClipPromptGroupDisabledByControls(tokens, disabledState) {
    if (!disabledState) return false;

    const key = (tokens || [])
        .map((token) => normalizeClipTokenForGroup(token))
        .join('|');

    return disabledState.groupKeys.has(key)
        || Boolean(tokens?.length && tokens.every(token => isClipPromptTokenDisabledByControls(token, disabledState)));
}

function buildEffectiveClipPromptInfo(clip) {
    applySharedSelectionPromptToClip(clip);

    const baseInfo = normalizePromptInfo(
        hasAnyPromptText(clip?.promptInfo)
            ? clip.promptInfo
            : getSharedSelectionClipPromptInfo()
    );

    const groups = ensureClipPromptControlGroups(clip);

    const rawCharPrompts = normalizeCharPromptList(
        Array.isArray(baseInfo.charPrompts) && baseInfo.charPrompts.length
            ? baseInfo.charPrompts
            : baseInfo.charPrompt
    );

    const effectiveCharPrompts = rawCharPrompts
        .map((text) => applyDisabledClipPromptControlGroups(text, groups, 'char'))
        .map((text) => String(text || '').trim())
        .filter(Boolean);

    return applyCanvasInpaintSettingsToPromptInfo({
        ...baseInfo,
        basePrompt: [
            applyDisabledClipPromptControlGroups(baseInfo.basePrompt, groups, 'base'),
            getClipInstancePrompt(clip)
        ].filter(Boolean).join(', '),
        negativePrompt: [
            applyDisabledClipPromptControlGroups(baseInfo.negativePrompt, groups, 'negative'),
            getClipInstancePrompt(clip, 'instanceNegativePrompt')
        ].filter(Boolean).join(', '),
        charPrompts: effectiveCharPrompts,
        charPrompt: buildLegacyCharPromptText(effectiveCharPrompts)
    });
}

function getClipInstancePrompt(clip, field = 'instancePrompt') {
    const selection = clip ? findSelectionParentForLayerId(clip.id) : null;
    return typeof selection?.[field] === 'string' ? selection[field].trim() : '';
}

function applyDisabledClipPromptControlGroups(promptText, groups, field) {
    const tokens = parseClipPromptTokens(promptText);
    if (!tokens.length) return '';

    const disabledKeys = new Set();

    groups
        .filter((group) => group.enabled === false)
        .forEach((group) => {
            (group.items || []).forEach((item) => {
                if (normalizeClipPromptControlField(item.field) !== field) return;

                if (item.type === 'group') {
                    (item.tokens || []).forEach((token) => {
                        disabledKeys.add(normalizeClipTokenForGroup(token));
                    });
                    return;
                }

                disabledKeys.add(normalizeClipTokenForGroup(item.token || ''));
            });
        });

    if (!disabledKeys.size) {
        return joinClipPromptTokens(tokens);
    }

    return joinClipPromptTokens(
        tokens.filter((token) => !disabledKeys.has(normalizeClipTokenForGroup(token)))
    );
}

function getPromptOwnerLayer(layerOrId) {
    const layer = typeof layerOrId === 'object'
        ? layerOrId
        : findCanvasLayer(layerOrId)?.layer;

    if (!layer) return null;

    // 이미지 레이어는 자기 자신이 owner
    if (layer.type === 'image') {
        layer.promptOwnerId = layer.promptOwnerId || layer.id;
        layer.promptInfo = normalizePromptInfo(layer.promptInfo || {});

        if (!Array.isArray(layer.promptControlGroups)) {
            layer.promptControlGroups = [];
        }

        return layer;
    }

    // promptOwnerId가 있고, 그 대상이 image 또는 clip 이면 owner로 사용
    if (layer.promptOwnerId) {
        const owner = findCanvasLayer(layer.promptOwnerId)?.layer;

        if (owner && (owner.type === 'image' || owner.type === 'clip')) {
            owner.promptOwnerId = owner.promptOwnerId || owner.id;
            owner.promptInfo = normalizePromptInfo(owner.promptInfo || {});

            if (!Array.isArray(owner.promptControlGroups)) {
                owner.promptControlGroups = [];
            }

            return owner;
        }
    }

    // 여기부터는 구버전 clip 보정
    const allLayers = getAllCanvasLayerNodes();
    const imageLayers = allLayers.filter((candidate) => candidate.type === 'image');

    if (layer.type === 'clip') {
        const legacyOwner = findPromptOwnerForLegacyClip(layer, imageLayers);

        if (legacyOwner) {
            legacyOwner.promptOwnerId = legacyOwner.promptOwnerId || legacyOwner.id;
            legacyOwner.promptInfo = normalizePromptInfo(legacyOwner.promptInfo || layer.promptInfo || {});

            if (!Array.isArray(legacyOwner.promptControlGroups)) {
                legacyOwner.promptControlGroups = [];
            }

            layer.promptOwnerId = legacyOwner.promptOwnerId;
            layer.promptInfo = normalizePromptInfo(legacyOwner.promptInfo);
            layer.promptControlGroups = Array.isArray(legacyOwner.promptControlGroups)
                ? structuredClone(legacyOwner.promptControlGroups)
                : [];

            return legacyOwner;
        }
    }

    // 마지막 fallback
    layer.promptOwnerId = layer.promptOwnerId || layer.id;
    layer.promptInfo = normalizePromptInfo(layer.promptInfo || {});

    if (!Array.isArray(layer.promptControlGroups)) {
        layer.promptControlGroups = [];
    }

    return layer;
}

function syncPromptStateFromOwner(layer) {
    if (!layer) return;

    const owner = getPromptOwnerLayer(layer);
    if (!owner) return;

    layer.promptInfo = normalizePromptInfo(owner.promptInfo);
    layer.promptControlGroups = Array.isArray(owner.promptControlGroups)
        ? structuredClone(owner.promptControlGroups)
        : [];
}

function migratePromptOwnersAndControlGroups() {
    const allLayers = getAllCanvasLayerNodes();
    const imageLayers = allLayers.filter((layer) => layer.type === 'image');

    // 이미지 레이어는 자기 자신이 프롬프트 owner
    imageLayers.forEach((imageLayer) => {
        if (!imageLayer.promptOwnerId) {
            imageLayer.promptOwnerId = imageLayer.id;
        }

        imageLayer.promptInfo = normalizePromptInfo(imageLayer.promptInfo || {});

        if (!Array.isArray(imageLayer.promptControlGroups)) {
            imageLayer.promptControlGroups = [];
        }
    });

    const clipLayers = allLayers.filter((layer) => layer.type === 'clip');

    clipLayers.forEach((clip) => {
        const previousGroups = Array.isArray(clip.promptControlGroups)
            ? structuredClone(clip.promptControlGroups)
            : [];

        const owner = findPromptOwnerForLegacyClip(clip, imageLayers);

        if (!owner) {
            // 원본 이미지를 못 찾는 오래된 클립은 자기 자신을 owner로 유지
            if (!clip.promptOwnerId) clip.promptOwnerId = clip.id;
            clip.promptInfo = normalizePromptInfo(clip.promptInfo || {});
            if (!Array.isArray(clip.promptControlGroups)) clip.promptControlGroups = [];
            return;
        }

        owner.promptOwnerId = owner.promptOwnerId || owner.id;
        owner.promptInfo = normalizePromptInfo(owner.promptInfo || clip.promptInfo || {});
        owner.promptControlGroups = Array.isArray(owner.promptControlGroups)
            ? owner.promptControlGroups
            : [];

        // 핵심: 기존 클립에 있던 제어그룹을 owner로 이동/병합
        mergePromptControlGroups(owner.promptControlGroups, previousGroups);

        clip.promptOwnerId = owner.promptOwnerId;
        clip.promptInfo = normalizePromptInfo(owner.promptInfo);

        // 호환용 복사본. 실제 편집/실행 기준은 owner여야 함.
        clip.promptControlGroups = structuredClone(owner.promptControlGroups);
    });
}

function syncAllPromptCopiesFromOwners() {
    const allLayers = getAllCanvasLayerNodes();

    allLayers.forEach((layer) => {
        if (!layer || layer.type !== 'clip') return;

        const owner = getPromptOwnerLayer(layer);

        if (!owner || owner === layer) return;
        if (owner.type !== 'image' && owner.type !== 'clip') return;

        layer.promptOwnerId = owner.promptOwnerId || owner.id;
        layer.promptInfo = normalizePromptInfo(owner.promptInfo || {});

        layer.promptControlGroups = Array.isArray(owner.promptControlGroups)
            ? structuredClone(owner.promptControlGroups)
            : [];
    });
}

function findPromptOwnerForLegacyClip(clip, imageLayers) {
    // 1순위: 이미 promptOwnerId가 있고 해당 이미지가 존재하면 사용
    if (clip.promptOwnerId) {
        const existing = findCanvasLayer(clip.promptOwnerId)?.layer;
        if (existing?.type === 'image') {
            return existing;
        }
    }

    // 2순위: sourcePath가 같은 이미지 레이어
    if (clip.sourcePath) {
        const byPath = imageLayers.find((layer) => {
            return layer.sourcePath && layer.sourcePath === clip.sourcePath;
        });

        if (byPath) return byPath;
    }

    // 3순위: 이 클립이 속한 선택 영역과 겹치는 원본 이미지 레이어
    if (clip.sourceSelectionId) {
        const selection = findCanvasLayer(clip.sourceSelectionId)?.layer;

        if (selection?.type === 'selection') {
            const sourceLayer = getPrimaryPromptSourceLayer(selection);
            if (sourceLayer?.type === 'image') {
                return sourceLayer;
            }
        }
    }

    // 4순위: 이미지가 하나뿐이면 그걸 owner로 사용
    if (imageLayers.length === 1) {
        return imageLayers[0];
    }

    return null;
}

function mergePromptControlGroups(targetGroups, sourceGroups) {
    if (!Array.isArray(targetGroups) || !Array.isArray(sourceGroups)) return;

    sourceGroups.forEach((sourceGroup) => {
        if (!sourceGroup) return;

        const normalized = normalizePromptControlGroupForMigration(sourceGroup);
        const key = getPromptControlGroupMergeKey(normalized);

        const exists = targetGroups.some((targetGroup) => {
            return getPromptControlGroupMergeKey(normalizePromptControlGroupForMigration(targetGroup)) === key;
        });

        if (!exists) {
            targetGroups.push(normalized);
        }
    });
}

function normalizePromptControlGroupForMigration(group) {
    return {
        id: group.id || Date.now() + Math.floor(Math.random() * 100000),
        name: String(group.name || '제어 그룹'),
        enabled: group.enabled !== false,
        expanded: group.expanded !== false,
        items: Array.isArray(group.items)
            ? group.items.map((item) => ({
                field: ['base', 'negative', 'char'].includes(item.field) ? item.field : 'base',
                type: item.type === 'group' ? 'group' : 'token',
                token: item.token || '',
                name: item.name || '',
                tokens: Array.isArray(item.tokens) ? item.tokens : []
            }))
            : []
    };
}

function getPromptControlGroupMergeKey(group) {
    const items = Array.isArray(group.items) ? group.items : [];

    const itemKey = items.map((item) => {
        if (item.type === 'group') {
            return `${item.field}:group:${(item.tokens || []).map(normalizeClipTokenForGroup).join('|')}`;
        }

        return `${item.field}:token:${normalizeClipTokenForGroup(item.token || '')}`;
    }).join('||');

    return `${group.name}::${itemKey}`;
}

function getClipInputValue(id, fallback = '') {
    const node = el(id);
    if (!node) {
        console.warn(`Missing clip prompt input: #${id}`);
        return fallback;
    }
    return node.value;
}

function getClipNumberValue(id, fallback) {
    const raw = getClipInputValue(id, fallback);
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
}

function forceSharePromptControlsByImageOwner() {
    const allLayers = getAllCanvasLayerNodes();
    const imageLayers = allLayers.filter((layer) => layer.type === 'image');
    const clipLayers = allLayers.filter((layer) => layer.type === 'clip');

    if (!imageLayers.length) return;

    clipLayers.forEach((clip) => {
        const owner = findPromptOwnerForLegacyClip(clip, imageLayers);
        if (!owner) return;

        owner.promptOwnerId = owner.promptOwnerId || owner.id;
        owner.promptInfo = normalizePromptInfo(owner.promptInfo || clip.promptInfo || {});

        if (!Array.isArray(owner.promptControlGroups)) {
            owner.promptControlGroups = [];
        }

        if (Array.isArray(clip.promptControlGroups)) {
            mergePromptControlGroups(owner.promptControlGroups, clip.promptControlGroups);
        }

        clip.promptOwnerId = owner.promptOwnerId;
        clip.promptInfo = normalizePromptInfo(owner.promptInfo);

        // 호환용 복사본. 실제 기준은 owner.
        clip.promptControlGroups = structuredClone(owner.promptControlGroups);
    });
}

function getNextClipPromptControlGroupId(existingGroups = []) {
    const usedIds = new Set(
        existingGroups
            .map((group) => Number(group?.id))
            .filter((id) => Number.isFinite(id) && id > 0)
    );

    let nextId = Math.max(1, Number(clipPromptControlGroupSeq) || 1);

    while (usedIds.has(nextId)) {
        nextId += 1;
    }

    clipPromptControlGroupSeq = nextId + 1;
    return nextId;
}

function syncClipPromptControlGroupSeqFromAllLayers() {
    const allGroups = getAllCanvasLayerNodes()
        .flatMap((layer) => Array.isArray(layer.promptControlGroups) ? layer.promptControlGroups : []);

    const maxId = allGroups.reduce((max, group) => {
        const id = Number(group?.id);
        return Number.isFinite(id) && id > max ? id : max;
    }, 0);

    clipPromptControlGroupSeq = Math.max(Number(clipPromptControlGroupSeq) || 1, maxId + 1);
}

function clampZoom(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function getWheelZoomFactor(event) {
    return event.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP;
}

function hasActiveCanvasGeometryDrag() {
    return Boolean(
        activeLayerDrag ||
        activeSelectionDrag ||
        activeImageResizeDrag ||
        activeCanvasResizeDrag
    );
}

function refreshActiveCanvasDragCoordinateCache() {
    if (!hasActiveCanvasGeometryDrag()) return;

    const surface = el('canvasSurface');
    if (!surface) return;

    const rect = surface.getBoundingClientRect();
    const displayScale = getCanvasDisplayScale();

    [activeLayerDrag, activeSelectionDrag, activeImageResizeDrag]
        .filter(Boolean)
        .forEach((drag) => {
            drag.surfaceLeft = rect.left;
            drag.surfaceTop = rect.top;
            drag.displayScale = displayScale;
        });

    if (activeCanvasResizeDrag) {
        activeCanvasResizeDrag.surfaceLeft = rect.left;
        activeCanvasResizeDrag.surfaceTop = rect.top;
    }
}

function bindCanvasWheelZoom() {
    const workspace = document.querySelector('.canvas-workspace');
    if (!workspace || workspace.dataset.zoomWheelBound === '1') return;

    workspace.dataset.zoomWheelBound = '1';
    workspace.addEventListener('wheel', handleCanvasWheelZoom, { passive: false });
}

function bindCanvasWorkspacePanDrag() {
    const workspace = document.querySelector('.canvas-workspace');
    if (!workspace || workspace.dataset.panDragBound === '1') return;

    workspace.dataset.panDragBound = '1';

    workspace.addEventListener('pointerdown', startCanvasWorkspacePanDrag);
    workspace.addEventListener('pointermove', handleCanvasWorkspacePanDragMove);
    workspace.addEventListener('pointerup', stopCanvasWorkspacePanDrag);
    workspace.addEventListener('pointercancel', stopCanvasWorkspacePanDrag);
}

function applyCanvasWorkspacePanOffset() {
    const stage = el('canvasStage');
    if (!stage) return;

    stage.style.transform = `translate(${Math.round(canvasPanOffsetX)}px, ${Math.round(canvasPanOffsetY)}px)`;
}

function isCanvasWorkspacePanTarget(event) {
    const target = event?.target;
    if (!target) return false;

    if (target.closest?.(
        '.canvas-clip-output-panel, ' +
        '.canvas-render-layer.image-layer, ' +
        '.selection-area-layer, ' +
        '.selection-resize-handle, ' +
        '.image-resize-handle, ' +
        '.image-resize-clamped-handle, ' +
        '.multi-layer-transform-box, ' +
        '.canvas-resize-handle, ' +
        '.canvas-pinned-reference-panel, ' +
        '.canvas-pinned-reference-image-wrap'
    )) {
        return false;
    }

    return Boolean(target.closest?.('.canvas-workspace'));
}

function startCanvasWorkspacePanDrag(event) {
    if (hasActiveCanvasGeometryDrag()) return;
    if (event.button !== 0 || !isCanvasWorkspacePanTarget(event)) return;

    const workspace = document.querySelector('.canvas-workspace');
    if (!workspace) return;

    event.preventDefault();
    event.stopPropagation();

    activeCanvasPanDrag = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startOffsetX: canvasPanOffsetX,
        startOffsetY: canvasPanOffsetY
    };

    workspace.classList.add('canvas-pan-dragging');
    workspace.setPointerCapture(event.pointerId);
}

function handleCanvasWorkspacePanDragMove(event) {
    if (!activeCanvasPanDrag || event.pointerId !== activeCanvasPanDrag.pointerId) return;

    event.preventDefault();

    canvasPanOffsetX = activeCanvasPanDrag.startOffsetX + event.clientX - activeCanvasPanDrag.startClientX;
    canvasPanOffsetY = activeCanvasPanDrag.startOffsetY + event.clientY - activeCanvasPanDrag.startClientY;

    applyCanvasWorkspacePanOffset();
}

function stopCanvasWorkspacePanDrag(event) {
    if (!activeCanvasPanDrag || event.pointerId !== activeCanvasPanDrag.pointerId) return;

    const workspace = document.querySelector('.canvas-workspace');

    if (workspace) {
        try {
            workspace.releasePointerCapture(event.pointerId);
        } catch (e) {}

        workspace.classList.remove('canvas-pan-dragging');
    }

    activeCanvasPanDrag = null;
}

function handleCanvasWheelZoom(event) {
    if (!currentCanvasWidth || !currentCanvasHeight) return;
    // Keep embedded editors and controls in charge of their own scrolling.
    if (event.target?.closest?.(
        '.canvas-clip-output-panel, .canvas-pinned-reference-panel, ' +
        '#canvasDakiFocus, .canvas-multi-references, ' +
        'input, textarea, select, button, [contenteditable="true"]'
    )) return;
    if (!event.deltaY) return;

    if (hasActiveCanvasGeometryDrag()) {
        event.preventDefault();
        event.stopPropagation();
        return;
    }

    const surface = el('canvasSurface');
    const workspace = document.querySelector('.canvas-workspace');

    if (!surface || !workspace) return;

    event.preventDefault();
    event.stopPropagation();

    const oldScale = getCanvasDisplayScale();
    const oldRect = surface.getBoundingClientRect();

    const canvasX = (event.clientX - oldRect.left) / oldScale;
    const canvasY = (event.clientY - oldRect.top) / oldScale;

    canvasZoom = clampZoom(
        canvasZoom * getWheelZoomFactor(event),
        CANVAS_ZOOM_MIN,
        CANVAS_ZOOM_MAX
    );

    renderCanvas(currentCanvasWidth, currentCanvasHeight);

    requestAnimationFrame(() => {
        const newScale = getCanvasDisplayScale();
        const newRect = surface.getBoundingClientRect();

        // 마우스 아래에 있던 캔버스 좌표가 계속 마우스 아래에 오도록 스크롤 보정
        workspace.scrollLeft += newRect.left + canvasX * newScale - event.clientX;
        workspace.scrollTop += newRect.top + canvasY * newScale - event.clientY;
    });

    saveCanvasState();
}

function applyClipPreviewZoom(wrap, img, clip) {
    if (!wrap || !img || !clip) return;

    const naturalWidth = Number(clip.imageWidth || img.naturalWidth || 512);
    const naturalHeight = Number(clip.imageHeight || img.naturalHeight || 512);

    // At the default zoom the complete clip fits both axes. Explicit wheel zoom still scrolls.
    // Use the border box so scrollbars appearing during zoom do not change the base scale.
    const viewport = getClipOutputViewportSize(wrap);
    const fitScale = Math.min(Math.max(1, viewport.width) / naturalWidth,
        Math.max(1, viewport.height) / naturalHeight);

    const baseWidth = Math.max(1, Math.floor(naturalWidth * fitScale));
    const baseHeight = Math.max(1, Math.floor(naturalHeight * fitScale));

    const displayWidth = Math.max(1, Math.round(baseWidth * clipPreviewZoom));
    const displayHeight = Math.max(1, Math.round(baseHeight * clipPreviewZoom));

    img.style.width = `${displayWidth}px`;
    img.style.height = `${displayHeight}px`;
    img.style.maxWidth = 'none';
    img.style.maxHeight = 'none';
}

function bindClipPreviewWheelZoom(wrap, img, clip, afterZoom) {
    if (!wrap || !img || !clip || wrap.dataset.clipZoomWheelBound === '1') return;

    wrap.dataset.clipZoomWheelBound = '1';

    wrap.addEventListener('wheel', (event) => {
        if (event.target === wrap) return;
        handleClipPreviewWheelZoom(event, wrap, img, clip, afterZoom);
    }, { passive: false });
}

function handleClipPreviewWheelZoom(event, wrap, img, clip, afterZoom) {
    event.preventDefault();
    event.stopPropagation();

    const rect = wrap.getBoundingClientRect();

    const pointerX = event.clientX - rect.left + wrap.scrollLeft;
    const pointerY = event.clientY - rect.top + wrap.scrollTop;

    const oldZoom = clipPreviewZoom;

    clipPreviewZoom = clampZoom(
        clipPreviewZoom * getWheelZoomFactor(event),
        CLIP_PREVIEW_ZOOM_MIN,
        CLIP_PREVIEW_ZOOM_MAX
    );

    const ratio = clipPreviewZoom / oldZoom;

    applyClipPreviewZoom(wrap, img, clip);

    requestAnimationFrame(() => {
        wrap.scrollLeft = pointerX * ratio - (event.clientX - rect.left);
        wrap.scrollTop = pointerY * ratio - (event.clientY - rect.top);

        if (typeof afterZoom === 'function') {
            afterZoom();
        }

        const readout = document.querySelector('.clip-preview-zoom-readout');
        if (readout) {
            readout.innerText = `${Math.round(clipPreviewZoom * 100)}%`;
        }
    });

    saveCanvasState();
}

function normalizeCanvasStateForCompare(state) {
    if (!state) return '';

    const copy = structuredClone(state);

    // 저장 시각은 매번 달라지므로 비교에서 제외
    delete copy.savedAt;

    return JSON.stringify(copy);
}

function isCurrentCanvasAlreadySaved() {
    if (!currentCanvasWidth || !currentCanvasHeight) {
        return true;
    }

    const currentStateKey = normalizeCanvasStateForCompare(buildCanvasStateSnapshot());
    const savedList = loadSavedCanvasSetups();

    return savedList.some((item) => {
        return normalizeCanvasStateForCompare(item.state) === currentStateKey;
    });
}

async function saveCurrentCanvasSetupSilently(name = '') {
    if (!currentCanvasWidth || !currentCanvasHeight) {
        return null;
    }

    const snapshot = buildCanvasStateSnapshot();
    const saveName = String(name || '').trim() ||
        `가져오기 전 캔버스 ${currentCanvasWidth}×${currentCanvasHeight}`;

    return await saveCanvasSetupItem(saveName, snapshot, {
        mode: 'normal',
        layerCount: countLayersInSavedState(snapshot)
    });
}

function hasUsableCurrentCanvas() {
    return Boolean(currentCanvasWidth && currentCanvasHeight && Array.isArray(canvasLayers) && canvasLayers.length);
}

async function migrateCanvasLayerDataUrlsToServer() {
    const layers = getAllCanvasLayerNodes()
        .filter((layer) => {
            return layer &&
                (layer.type === 'image' || layer.type === 'clip') &&
                typeof layer.src === 'string' &&
                layer.src.startsWith('data:image/');
        });

    if (!layers.length) return;

    let didUpdate = false;

    for (const layer of layers) {
        try {
            layer.src = await saveClipDataUrlToServer(layer.src, {
                category: layer.type === 'clip' && layer.renderOnCanvas ? 'canvas_inpaint' : 'canvas'
            });
            didUpdate = true;
        } catch (error) {
            console.warn('Canvas layer data URL migration failed:', error);
        }
    }

    if (didUpdate) {
        saveCanvasState();
        renderLayerList();
        renderCanvasLayersOnSurface();
    }
}

function getCanvasExportPromptInfo() {
    const allLayers = getAllCanvasLayerNodes();
    const imageLayer = allLayers.find((layer) => {
        return layer.type === 'image' &&
            layer.promptInfo &&
            hasAnyPromptText(layer.promptInfo);
    });

    if (imageLayer) return applyCanvasInpaintSettingsToPromptInfo(imageLayer.promptInfo);

    const clipLayer = allLayers.find((layer) => {
        return layer.type === 'clip' &&
            layer.promptInfo &&
            hasAnyPromptText(layer.promptInfo);
    });

    if (clipLayer) {
        const owner = getPromptOwnerLayer(clipLayer) || clipLayer;
        return applyCanvasInpaintSettingsToPromptInfo(owner.promptInfo || clipLayer.promptInfo);
    }

    const generationOnlyLayer = allLayers.find((layer) => {
        return layer && layer.visible !== false &&
            (layer.type === 'image' || layer.type === 'clip') &&
            canvasInpaintHasGenerationSettings(layer.promptInfo);
    });
    if (generationOnlyLayer) {
        const owner = generationOnlyLayer.type === 'clip'
            ? getPromptOwnerLayer(generationOnlyLayer) || generationOnlyLayer
            : generationOnlyLayer;
        return applyCanvasInpaintSettingsToPromptInfo(owner.promptInfo || generationOnlyLayer.promptInfo);
    }

    if (canvasInpaintHasGenerationSettings(sharedSelectionClipPromptInfo)) {
        return applyCanvasInpaintSettingsToPromptInfo(sharedSelectionClipPromptInfo);
    }

    return applyCanvasInpaintSettingsToPromptInfo(null);
}

async function getCanvasExportPromptInfoAsync() {
    const direct = getCanvasExportPromptInfo();

    if (hasAnyPromptText(direct)) {
        return applyCanvasInpaintSettingsToPromptInfo(direct);
    }

    const allLayers = getAllCanvasLayerNodes();

    const imageLayers = allLayers.filter((layer) => {
        return layer &&
            layer.type === 'image' &&
            layer.visible !== false &&
            (layer.promptInfo || layer.sourcePath);
    });

    for (const layer of imageLayers) {
        const recovered = await recoverPromptFromImageLayer(layer);

        if (hasAnyPromptText(recovered) || canvasInpaintHasGenerationSettings(recovered)) {
            if (hasAnyPromptText(recovered)) {
                layer.promptInfo = normalizePromptInfo(recovered);
                saveCanvasState();
            }
            return applyCanvasInpaintSettingsToPromptInfo(
                hasAnyPromptText(recovered) ? layer.promptInfo : recovered
            );
        }
    }

    const clipLayers = allLayers.filter((layer) => {
        return layer &&
            layer.type === 'clip' &&
            layer.visible !== false &&
            (layer.promptInfo || layer.sourcePath || layer.promptOwnerId);
    });

    for (const clip of clipLayers) {
        const owner = getPromptOwnerLayer(clip) || clip;
        const candidate = normalizePromptInfo(
            hasAnyPromptText(owner.promptInfo)
                ? owner.promptInfo
                : clip.promptInfo
        );

        if (hasAnyPromptText(candidate)) {
            return applyCanvasInpaintSettingsToPromptInfo(candidate);
        }

        const sourcePath = clip.sourcePath || owner.sourcePath || '';
        if (sourcePath) {
            const fromImage = await fetchPromptInfoByPath(sourcePath);

            if (hasAnyPromptText(fromImage) || canvasInpaintHasGenerationSettings(fromImage)) {
                if (hasAnyPromptText(fromImage)) {
                    clip.promptInfo = normalizePromptInfo(fromImage);
                    if (owner && owner !== clip) {
                        owner.promptInfo = normalizePromptInfo(fromImage);
                    }
                    saveCanvasState();
                }
                return applyCanvasInpaintSettingsToPromptInfo(fromImage);
            }
        } else if (canvasInpaintHasGenerationSettings(owner.promptInfo || clip.promptInfo)) {
            return applyCanvasInpaintSettingsToPromptInfo(owner.promptInfo || clip.promptInfo);
        }
    }

    return applyCanvasInpaintSettingsToPromptInfo(getCanvasExportPromptInfo());
}

function isCurrentCanvasDakimakuraLike(promptInfo = null) {
    const width = Number(currentCanvasWidth || 0);
    const height = Number(currentCanvasHeight || 0);

    const ratio = width && height ? width / height : 0;
    const targetRatio = 5 / 16;
    const isDakiRatio = ratio > 0 && Math.abs(ratio - targetRatio) < 0.035;

    const promptText = [
        promptInfo?.basePrompt,
        promptInfo?.charPrompt,
        promptInfo?.negativePrompt
    ].filter(Boolean).join(', ').toLowerCase();

    return isDakiRatio ||
        promptText.includes('dakimakura') ||
        promptText.includes('pillow cover') ||
        promptText.includes('body pillow');
}

let canvasExportBusy = false;

async function exportMergedCanvasToClassified() {
    if (!currentCanvasWidth || !currentCanvasHeight) {
        alert('내보낼 캔버스가 없습니다.');
        return;
    }
    if (canvasExportBusy) return;

    canvasExportBusy = true;
    const exportButton = document.getElementById('canvasExportMergedBtn');
    let linkedProject = null;
    let progress = null;
    let exported = false;
    let progressDone = false;
    try {
        linkedProject = window.CanvasProject?.localLink?.() || null;
        let capturedLink = null;
        let isSameLink = () => !window.CanvasProject?.localLink?.();
        let destination = {destination: 'gallery'};
        if (linkedProject) {
            capturedLink = {
                projectId: linkedProject.projectId,
                canvasId: linkedProject.canvasId,
                projectName: linkedProject.projectName,
                side: linkedProject.side
            };
            destination = await window.CanvasProject.chooseExportDestination(linkedProject);
            if (!destination) return;
            isSameLink = () => {
                const current = window.CanvasProject?.localLink?.();
                return current && current.projectId === capturedLink.projectId
                    && current.canvasId === capturedLink.canvasId && current.side === capturedLink.side;
            };
            if (!isSameLink()) return;
            if (destination.destination === 'project' && (destination.projectId !== capturedLink.projectId
                || destination.canvasId !== capturedLink.canvasId)) return;
            if (destination.destination !== 'project' && destination.destination !== 'gallery') return;
        }

        const stateKey = window.CanvasWorkspaceBridge?.stateKey;
        const contextLabel = linkedProject
            ? `${linkedProject.projectName} · ${linkedProject.side === 'back' ? '뒷면' : '앞면'}`
            : '현재 캔버스';
        const reset = window.CanvasExportFeedback
            ? await window.CanvasExportFeedback.chooseReset(contextLabel) : false;
        if (reset === null || !isSameLink() || stateKey !== window.CanvasWorkspaceBridge?.stateKey) return;
        if (exportButton) exportButton.disabled = true;
        progress = window.CanvasExportFeedback?.start(contextLabel) || null;
        const total = reset ? 5 : 3;
        progress?.update('프롬프트와 내보내기 설정 확인 중…', 0, total);
        if (reset && linkedProject && !await window.CanvasProject.flush()) {
            throw new Error('기존 캔버스의 자동 저장을 먼저 완료해 주세요.');
        }
        const promptInfo = await getCanvasExportPromptInfoAsync();
        const isDakimakura = isCurrentCanvasDakimakuraLike(promptInfo);
        if (!isSameLink()) return;

        progress?.update('이미지 합치는 중…', 1, total);
        const originalState = reset ? normalizeCanvasStateForCompare(buildCanvasStateSnapshot({preserveMasks: true})) : null;
        const image = await renderMergedCanvasToDataUrl();
        if (!isSameLink()) return;
        const isSameCanvas = () => isSameLink() && stateKey === window.CanvasWorkspaceBridge?.stateKey
            && (!reset || originalState === normalizeCanvasStateForCompare(buildCanvasStateSnapshot({preserveMasks: true})));
        if (!isSameCanvas()) throw new Error('내보내는 동안 캔버스가 변경되었습니다. 다시 내보내 주세요.');
        let mergedState = null;
        if (reset) {
            progress?.update('정리할 캔버스 이미지 준비 중…', 2, total);
            mergedState = await buildMergedOnlyCanvasStateSnapshot(image, promptInfo);
            if (!isSameCanvas()) throw new Error('캔버스가 변경되어 내보내기를 중단했습니다.');
        }

        const body = {
            image,
            width: currentCanvasWidth,
            height: currentCanvasHeight,
            promptInfo,
            isDakimakura,
            source: 'canvas'
        };
        if (destination.destination === 'project') {
            body.destination = 'project';
            body.projectId = destination.projectId;
            body.canvasId = destination.canvasId;
        }

        progress?.update('내보낸 파일을 저장하는 중…', reset ? 3 : 2, total);
        const response = await fetch('/api/canvas/export_merged', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body)
        });

        const data = await response.json();

        if (!response.ok || data.status !== 'success') {
            throw new Error(data.message || '통합 내보내기에 실패했습니다.');
        }
        exported = true;
        if (reset) {
            if (!isSameCanvas()) throw new Error('캔버스가 변경되어 정리·저장은 건너뛰었습니다. 현재 작업은 유지됩니다.');
            progress?.update('캔버스를 한 장으로 정리하고 저장하는 중…', 4, total);
            if (linkedProject) {
                applyCanvasStateSnapshot(mergedState);
                saveCanvasState({immediate: true});
                window.CanvasProject.schedule(true);
                if (!await window.CanvasProject.flush()) {
                    throw new Error('정리한 캔버스의 프로젝트 저장에 실패했습니다. 자동 저장 상태에서 다시 시도해 주세요.');
                }
            } else {
                const previous = loadSavedCanvasSetups().find(item => item.id === activeCanvasSetupId);
                const name = previous?.name || data.name?.replace(/\.png$/i, '') || `캔버스_${new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-')}`;
                if (previous) await updateCanvasSetupItem(previous.id, name, mergedState, {mode: 'merged'});
                else await saveCanvasSetupItem(name, mergedState, {mode: 'merged'});
                if (!isSameCanvas()) throw new Error('캔버스 저장은 완료했지만 화면이 변경되어 적용은 건너뛰었습니다.');
                applyCanvasStateSnapshot(mergedState);
                saveCanvasState({immediate: true});
            }
        }
        progress?.finish(reset ? '내보내기와 캔버스 정리·저장을 완료했습니다.' : '통합 내보내기를 완료했습니다.');
        progressDone = true;

        if (destination.destination === 'project') {
            const side = data.side || capturedLink.side;
            const sideLabel = side === 'back' ? '뒷면' : '앞면';
            showToast(`${data.projectName || capturedLink.projectName} · ${sideLabel}에 그림을 추가했습니다.`);
            return;
        }

        const exportedPath = data.path || '';

        if (data.index_updated) {
            showToast(`통합 내보내기 완료: ${exportedPath || '저장됨'}`);
        } else if (data.index_rebuild_started || data.index_rebuild_running) {
            showToast('통합 내보내기 완료: 갤러리 인덱스를 갱신 중입니다.');
        } else {
            showToast(`통합 내보내기 완료: ${exportedPath || '저장됨'}`);
        }

    } catch (error) {
        const message = `${exported ? '그림 내보내기는 완료되었습니다. 캔버스 정리·저장 확인 필요' : '통합 내보내기 실패'}: ${error.message || error}`;
        if (progress) progress.fail(message);
        else alert(message);
        progressDone = true;
    } finally {
        // Early identity checks may abort before a terminal progress message.
        if (progress && !progressDone) progress.close();
        canvasExportBusy = false;
        if (exportButton) {
            exportButton.disabled = false;
            if (linkedProject && document.activeElement === document.body && exportButton.isConnected) {
                exportButton.focus();
            }
        }
    }
}


function openTagTranslationModal(tag, event = null) {
    const built = buildTagTranslationParts(tag);

    activeTagTranslationOriginalTarget = built.original;
    activeTagTranslationParts = built.parts;
    activeTagTranslationJoiner = built.joiner;
    activeTagTranslationTarget = built.original;

    if (!activeTagTranslationTarget) return;

    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }

    const popover = document.getElementById('tagTranslationModal');
    const content = popover?.querySelector('.modal-content');
    const tagLabel = document.getElementById('tagTranslationTargetTag');
    const input = document.getElementById('tagTranslationInput');

    if (!popover || !content) return;

    if (tagLabel) tagLabel.innerText = activeTagTranslationTarget;
    if (input) input.value = '';

    renderTagTranslationPartPicker();

    // 기존 중앙 모달 overlay를 작은 고정 팝오버처럼 강제 변경
    popover.style.display = 'block';
    popover.style.position = 'fixed';
    popover.style.inset = 'auto';
    popover.style.width = 'auto';
    popover.style.height = 'auto';
    popover.style.background = 'transparent';
    popover.style.zIndex = '30000';
    popover.style.pointerEvents = 'none';

    content.style.pointerEvents = 'auto';
    content.style.width = '320px';
    content.style.maxWidth = 'calc(100vw - 24px)';
    content.style.padding = '12px';
    content.style.borderRadius = '12px';
    content.style.boxShadow = '0 16px 45px rgba(0,0,0,0.55)';

    const margin = 12;
    const x = event ? event.clientX + 10 : window.innerWidth / 2 - 160;
    const y = event ? event.clientY + 10 : window.innerHeight / 2 - 120;

    // 일단 위치 지정 후 실제 크기 측정
    popover.style.left = `${x}px`;
    popover.style.top = `${y}px`;

    requestAnimationFrame(() => {
        const rect = content.getBoundingClientRect();

        const nextLeft = Math.min(
            Math.max(margin, x),
            window.innerWidth - rect.width - margin
        );

        const nextTop = Math.min(
            Math.max(margin, y),
            window.innerHeight - rect.height - margin
        );

        popover.style.left = `${nextLeft}px`;
        popover.style.top = `${nextTop}px`;

        if (input) {
            input.focus();
            input.select();
        }
    });

    bindTagTranslationPopoverOutsideClose();
}

function stripTagTranslationTarget(tag) {
    return String(tag || '')
        .replace(/^[-+]?\d+(?:\.\d+)?::\s*/, '')
        .replace(/\s*::$/, '')
        .trim();
}

function bindTagTranslationPopoverOutsideClose() {
    if (window.__tagTranslationPopoverBound) return;
    window.__tagTranslationPopoverBound = true;

}

function closeTagTranslationModal() {
    activeTagTranslationTarget = null;
    activeTagTranslationOriginalTarget = '';
    activeTagTranslationParts = [];
    activeTagTranslationJoiner = ' ';

    const popover = document.getElementById('tagTranslationModal');
    if (popover) {
        popover.style.display = 'none';
    }
}

async function saveTagTranslationFromModal() {
    const input = document.getElementById('tagTranslationInput');
    const raw = input ? input.value.trim() : '';

    const targetTag = getEffectiveTagTranslationTarget();

    if (!targetTag) {
        alert('저장할 태그 단어를 하나 이상 활성화해 주세요.');
        return;
    }

    if (!raw) {
        alert('저장할 내용을 입력해 주세요.');
        return;
    }

    try {
        const response = await fetch('/api/tag_dictionary/save_app_translation', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                tag: targetTag,
                input: raw
            })
        });

        const data = await response.json();
        if (!response.ok || data.status !== 'success') {
            throw new Error(data.message || '저장 실패');
        }

        applySavedTagTranslationLocally(targetTag, data.category, data.ko);

        // 다키 제작소라면
        if (typeof fetchTagDictionary === 'function') {
            await fetchTagDictionary();
        }
        if (typeof renderAllPromptTokens === 'function') {
            renderAllPromptTokens();
        }

        // 캔버스라면
        if (typeof fetchClipTagDictionary === 'function') {
            await fetchClipTagDictionary();
        }
        if (typeof renderAllClipPromptTokens === 'function') {
            renderAllClipPromptTokens();
        }

        closeTagTranslationModal();

    } catch (error) {
        alert(`태그 번역 저장 실패: ${error.message || error}`);
    }
}

function applySavedTagTranslationLocally(tag, category, ko) {
    if (!window.tagDictionaryAppCategories) {
        window.tagDictionaryAppCategories = {};
    }

    if (!window.tagDictionaryAppCategories[category]) {
        window.tagDictionaryAppCategories[category] = {};
    }

    window.tagDictionaryAppCategories[category][tag] = ko;

    if (typeof renderTagDictionary === 'function') {
        renderTagDictionary();
    }
}

function buildTagTranslationParts(rawTag) {
    const clean = stripTagTranslationTarget(rawTag);

    if (!clean) {
        return {
            original: '',
            parts: [],
            joiner: ' '
        };
    }

    const joiner = clean.includes('_') && !clean.includes(' ')
        ? '_'
        : ' ';

    const parts = clean
        .split(/[ _]+/)
        .map((part) => part.trim())
        .filter(Boolean)
        .map((text) => ({
            text,
            active: true
        }));

    return {
        original: clean,
        parts,
        joiner
    };
}

function getEffectiveTagTranslationTarget() {
    if (!activeTagTranslationParts.length) {
        return activeTagTranslationOriginalTarget || activeTagTranslationTarget || '';
    }

    return activeTagTranslationParts
        .filter((part) => part.active)
        .map((part) => part.text)
        .join(activeTagTranslationJoiner)
        .trim();
}

function renderTagTranslationPartPicker() {
    const picker = document.getElementById('tagTranslationPartPicker');
    const effective = document.getElementById('tagTranslationEffectiveTag');
    const label = document.getElementById('tagTranslationTargetTag');

    if (label) {
        label.innerText = activeTagTranslationOriginalTarget || '';
    }

    if (!picker) return;

    picker.innerHTML = '';

    if (!activeTagTranslationParts.length || activeTagTranslationParts.length <= 1) {
        picker.style.display = 'none';

        if (effective) {
            effective.innerText = '';
        }

        return;
    }

    picker.style.display = 'flex';

    activeTagTranslationParts.forEach((part, index) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `tag-translation-part-btn ${part.active ? 'active' : 'inactive'}`;
        btn.innerText = part.text;
        btn.onclick = () => toggleTagTranslationPart(index);

        btn.style.cssText = `
            border: 1px solid ${part.active ? 'var(--success)' : 'var(--border-color)'};
            background: ${part.active ? 'rgba(0,184,148,0.16)' : 'var(--btn-secondary)'};
            color: ${part.active ? 'var(--success)' : 'var(--text-muted)'};
            border-radius: 999px;
            padding: 5px 9px;
            font-size: 11px;
            font-weight: 800;
            cursor: pointer;
        `;

        picker.appendChild(btn);
    });

    updateTagTranslationEffectiveLabel();
}

function toggleTagTranslationPart(index) {
    if (!activeTagTranslationParts[index]) return;

    activeTagTranslationParts[index].active = !activeTagTranslationParts[index].active;

    renderTagTranslationPartPicker();
}

function updateTagTranslationEffectiveLabel() {
    const effective = document.getElementById('tagTranslationEffectiveTag');
    if (!effective) return;

    const tag = getEffectiveTagTranslationTarget();

    effective.innerText = tag
        ? `저장 대상: ${tag}`
        : '저장 대상이 없습니다. 하나 이상 활성화하세요.';

    effective.style.color = tag ? 'var(--text-muted)' : 'var(--danger)';
}

function normalizeCharPromptList(value) {
    if (Array.isArray(value)) {
        return value
            .map((item) => String(item || '').trim())
            .filter(Boolean);
    }

    if (value && typeof value === 'object') {
        if (Array.isArray(value.charPrompts)) {
            return value.charPrompts
                .map((item) => String(item || '').trim())
                .filter(Boolean);
        }

        if (typeof value.charPrompt === 'string' && value.charPrompt.trim()) {
            return [value.charPrompt.trim()];
        }

        if (typeof value.characterPrompt === 'string' && value.characterPrompt.trim()) {
            return [value.characterPrompt.trim()];
        }
    }

    if (typeof value === 'string' && value.trim()) {
        return [value.trim()];
    }

    return [];
}

function buildLegacyCharPromptText(list) {
    return normalizeCharPromptList(list).join(', ');
}

function getClipCharPromptValues() {
    return [...document.querySelectorAll('#clipCharPromptList textarea')]
        .map((textarea) => String(textarea.value || '').trim())
        .filter(Boolean);
}

function setClipCharPromptValues(values) {
    const list = normalizeCharPromptList(values);
    const container = el('clipCharPromptList');
    if (!container) return;

    container.innerHTML = '';

    if (!list.length) {
        addClipCharPromptEditor('');
        return;
    }

    list.forEach((value) => addClipCharPromptEditor(value));
}

function addClipCharPromptEditor(initialValue = '') {
    const container = el('clipCharPromptList');
    if (!container) return;

    const id = `ccp${clipCharPromptEditorSeq++}`;
    const index = container.querySelectorAll('.clip-char-prompt-item').length + 1;

    const item = document.createElement('div');
    item.className = 'clip-char-prompt-item';
    item.dataset.charPromptId = id;
    item.style.cssText = 'border:1px solid var(--border-color); border-radius:10px; padding:10px; margin-bottom:10px; background:var(--bg-panel);';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;';

    const title = document.createElement('div');
    title.className = 'clip-char-prompt-title';
    title.style.cssText = 'font-size:12px; font-weight:800;';
    title.innerText = `Character Prompt ${index}`;

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'danger';
    deleteBtn.style.cssText = 'padding:4px 8px; font-size:12px;';
    deleteBtn.innerText = '삭제';
    deleteBtn.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        removeClipCharPromptEditor(id);
    };

    const tokens = document.createElement('div');
    tokens.id = `clipCharPromptTokens-${id}`;
    tokens.className = 'prompt-token-surface compact';

    const textarea = document.createElement('textarea'); textarea.setAttribute('data-prompt-autocomplete', '');
    textarea.id = `clipCharPromptInput-${id}`;
    textarea.className = 'prompt-raw-textarea';
    textarea.rows = 3;
    textarea.value = initialValue || '';

    header.appendChild(title);
    header.appendChild(deleteBtn);
    item.appendChild(header);
    item.appendChild(tokens);
    item.appendChild(textarea);
    container.appendChild(item);

    bindClipPromptInputs();
    renderAllClipPromptTokens();
    applyClipPromptViewMode();
    refreshClipCharPromptIndexes();
}

function removeClipCharPromptEditor(id) {
    const container = el('clipCharPromptList');
    if (!container) return;

    const item = container.querySelector(`.clip-char-prompt-item[data-char-prompt-id="${id}"]`);
    if (item) item.remove();

    if (!container.querySelector('.clip-char-prompt-item')) {
        addClipCharPromptEditor('');
        return;
    }

    bindClipPromptInputs();
    renderAllClipPromptTokens();
    applyClipPromptViewMode();
    refreshClipCharPromptIndexes();
}

function refreshClipCharPromptIndexes() {
    [...document.querySelectorAll('#clipCharPromptList .clip-char-prompt-item')].forEach((item, index) => {
        const title = item.querySelector('.clip-char-prompt-title');
        if (title) title.innerText = `Character Prompt ${index + 1}`;
    });
}

function startImageResizeDrag(event, layerId, handle) {
    const found = findCanvasLayer(layerId);
    const layer = found?.layer;

    if (!isResizableCanvasLayer(layer)) return;
    if (!isImageResizeMode) return;

    event.preventDefault();
    event.stopPropagation();

    activeLayerId = layer.id;
    normalizeResizableLayerGeometry(layer);

    const pointer = getCanvasPointerPosition(event);

    activeImageResizeDrag = {
        layerId: layer.id,
        handle,

        startPointerX: pointer.x,
        startPointerY: pointer.y,
        displayScale: pointer.displayScale,
        surfaceLeft: pointer.surfaceLeft,
        surfaceTop: pointer.surfaceTop,

        // 세밀 조절용 화면 좌표
        startClientX: event.clientX,
        startClientY: event.clientY,

        startX: Number(layer.x || 0),
        startY: Number(layer.y || 0),
        startWidth: Number(layer.layerWidth || layer.imageWidth || 1),
        startHeight: Number(layer.layerHeight || layer.imageHeight || 1),

        anchorRight: Number(layer.x || 0) + Number(layer.layerWidth || layer.imageWidth || 1),
        anchorBottom: Number(layer.y || 0) + Number(layer.layerHeight || layer.imageHeight || 1),

        // 이미지 자신의 현재 비율
        aspectRatio: Math.max(
            0.0001,
            Number(layer.layerWidth || layer.imageWidth || 1) /
            Number(layer.layerHeight || layer.imageHeight || 1)
        ),

        stuckX: null,
        stuckY: null
    };

    updateSelectionSizeTooltip(event.clientX, event.clientY, layer.layerWidth, layer.layerHeight);
    updateActiveImageResizeGuideOverlay();
}

function handleImageResizeMouseMove(event) {
    if (!activeImageResizeDrag) return;

    if (activeImageResizeDrag.mode === 'multi') {
        handleMultiImageResizeMouseMove(event);
        return;
    }

    const found = findCanvasLayer(activeImageResizeDrag.layerId);
    const layer = found?.layer;

    if (!isMultiTransformLayer(layer)) return;

    const pointer = getCanvasPointerPositionForDrag(event, activeImageResizeDrag);
    const handle = activeImageResizeDrag.handle;

    const fineMode = Boolean(el('imageResizeFineMode')?.checked) || event.altKey;

    let dx;
    let dy;

    if (fineMode) {
        // 세밀 조절:
        // 캔버스 좌표 변화가 아니라 화면 좌표 변화를 기준으로 천천히 움직임.
        // 확대율 때문에 5px씩 튀는 문제를 줄임.
        dx = (event.clientX - activeImageResizeDrag.startClientX) * IMAGE_RESIZE_FINE_FACTOR;
        dy = (event.clientY - activeImageResizeDrag.startClientY) * IMAGE_RESIZE_FINE_FACTOR;
    } else {
        // 일반 조절:
        // 마우스 위치와 핸들이 정확히 따라오는 방식.
        dx = pointer.x - activeImageResizeDrag.startPointerX;
        dy = pointer.y - activeImageResizeDrag.startPointerY;
    }

    let nextX = activeImageResizeDrag.startX;
    let nextY = activeImageResizeDrag.startY;
    let nextWidth = activeImageResizeDrag.startWidth;
    let nextHeight = activeImageResizeDrag.startHeight;

    if (handle.includes('r')) {
        nextWidth = activeImageResizeDrag.startWidth + dx;
    }

    if (handle.includes('l')) {
        nextWidth = activeImageResizeDrag.startWidth - dx;
        nextX = activeImageResizeDrag.anchorRight - nextWidth;
    }

    if (handle.includes('b')) {
        nextHeight = activeImageResizeDrag.startHeight + dy;
    }

    if (handle.includes('t')) {
        nextHeight = activeImageResizeDrag.startHeight - dy;
        nextY = activeImageResizeDrag.anchorBottom - nextHeight;
    }

    // 비율 유지.
    // Shift를 누르면 임시로 비율 유지 해제.
    const keepRatio = Boolean(el('imageResizeRatioLock')?.checked) && !event.shiftKey;

    if (keepRatio) {
        const ratio = activeImageResizeDrag.aspectRatio;

        if (handle.length === 2) {
            const widthDelta = Math.abs(nextWidth - activeImageResizeDrag.startWidth);
            const heightDelta = Math.abs(nextHeight - activeImageResizeDrag.startHeight);

            if (widthDelta >= heightDelta) {
                nextHeight = nextWidth / ratio;
            } else {
                nextWidth = nextHeight * ratio;
            }

            if (handle.includes('l')) {
                nextX = activeImageResizeDrag.anchorRight - nextWidth;
            }

            if (handle.includes('t')) {
                nextY = activeImageResizeDrag.anchorBottom - nextHeight;
            }
        }

        if (handle === 'l' || handle === 'r') {
            const centerY = activeImageResizeDrag.startY + activeImageResizeDrag.startHeight / 2;

            nextHeight = nextWidth / ratio;
            nextY = centerY - nextHeight / 2;

            if (handle === 'l') {
                nextX = activeImageResizeDrag.anchorRight - nextWidth;
            }
        }

        if (handle === 't' || handle === 'b') {
            const centerX = activeImageResizeDrag.startX + activeImageResizeDrag.startWidth / 2;

            nextWidth = nextHeight * ratio;
            nextX = centerX - nextWidth / 2;

            if (handle === 't') {
                nextY = activeImageResizeDrag.anchorBottom - nextHeight;
            }
        }
    }

    nextWidth = Math.max(IMAGE_RESIZE_MIN_SIZE, nextWidth);
    nextHeight = Math.max(IMAGE_RESIZE_MIN_SIZE, nextHeight);

    if (handle.includes('l')) {
        nextX = activeImageResizeDrag.anchorRight - nextWidth;
    }

    if (handle.includes('t')) {
        nextY = activeImageResizeDrag.anchorBottom - nextHeight;
    }

    // 여기서는 일부러 소수점 유지.
    // mousemove 중 Math.round를 해버리면 또 뚝뚝 끊겨 보일 수 있음.
    layer.x = nextX;
    layer.y = nextY;
    layer.layerWidth = nextWidth;
    layer.layerHeight = nextHeight;

    updateSelectionSizeTooltip(
        event.clientX,
        event.clientY,
        Math.round(layer.layerWidth),
        Math.round(layer.layerHeight)
    );

    updateCanvasHotLayerGeometry(layer.id);
    updateActiveImageResizeGuideOverlay();
}

function handleImageResizeMouseUp() {
    if (!activeImageResizeDrag) return;

    if (activeImageResizeDrag.mode === 'multi') {
        activeImageResizeDrag.starts.forEach((start) => {
            const found = findCanvasLayer(start.id);
            const layer = found?.layer;
            if (!isMultiTransformLayer(layer)) return;

            layer.x = Math.round(layer.x || 0);
            layer.y = Math.round(layer.y || 0);
            layer.layerWidth = Math.round(layer.layerWidth || 1);
            layer.layerHeight = Math.round(layer.layerHeight || 1);

            if (layer.type === 'selection') {
                layer.layerWidth = snapToSelectionStep(layer.layerWidth);
                layer.layerHeight = snapToSelectionStep(layer.layerHeight);
            }
        });

        activeImageResizeDrag = null;
        hideSelectionSizeTooltip();
        hideImageResizeGuideOverlay();

        renderLayerList();
        renderCanvasLayersOnSurface();

        if (typeof updateImageResizePanel === 'function') {
            updateImageResizePanel();
        }

        saveCanvasState();
        return;
    }

    const found = findCanvasLayer(activeImageResizeDrag.layerId);
    const layer = found?.layer;

    if (isResizableCanvasLayer(layer)) {
        // 저장할 때는 정수화
        layer.x = Math.round(layer.x || 0);
        layer.y = Math.round(layer.y || 0);
        layer.layerWidth = Math.round(layer.layerWidth || 1);
        layer.layerHeight = Math.round(layer.layerHeight || 1);
    }

    if (layer?.type === 'selection') {
        layer.layerWidth = snapToSelectionStep(layer.layerWidth);
        layer.layerHeight = snapToSelectionStep(layer.layerHeight);
    }

    activeImageResizeDrag = null;
    hideSelectionSizeTooltip();
    hideImageResizeGuideOverlay();

    renderLayerList();
    renderCanvasLayersOnSurface();

    if (typeof updateImageResizePanel === 'function') {
        updateImageResizePanel();
    }

    saveCanvasState();
}

function getActiveImageLayer() {
    const found = findCanvasLayer(activeLayerId);
    const layer = found?.layer;

    if (!layer || layer.type !== 'image') {
        alert('이미지 레이어를 선택해 주세요.');
        return null;
    }

    normalizeImageLayerGeometry(layer);
    return layer;
}

function alignActiveImageLayer(axis = 'both') {
    const layer = getActiveImageLayer();
    if (!layer) return;

    const width = Math.max(1, Number(layer.layerWidth || layer.imageWidth || 1));
    const height = Math.max(1, Number(layer.layerHeight || layer.imageHeight || 1));

    if (axis === 'x' || axis === 'both') {
        layer.x = Math.round((currentCanvasWidth - width) / 2);
    }

    if (axis === 'y' || axis === 'both') {
        layer.y = Math.round((currentCanvasHeight - height) / 2);
    }

    renderCanvasLayersOnSurface();
    renderLayerList();

    if (typeof updateImageResizePanel === 'function') {
        updateImageResizePanel();
    }

    saveCanvasState();
}

function fitActiveImageLayerToCanvasAndCenter() {
    const layer = getActiveImageLayer();
    if (!layer) return;

    const imageWidth = Number(layer.imageWidth || layer.layerWidth || 1);
    const imageHeight = Number(layer.imageHeight || layer.layerHeight || 1);

    const geometry = getInitialImageLayerGeometry(imageWidth, imageHeight, {
        allowUpscale: true
    });

    layer.layerWidth = geometry.width;
    layer.layerHeight = geometry.height;
    layer.x = geometry.x;
    layer.y = geometry.y;

    renderCanvasLayersOnSurface();
    renderLayerList();

    if (typeof updateImageResizePanel === 'function') {
        updateImageResizePanel();
    }

    saveCanvasState();
}

function refreshPinnedReferenceStateFromLayers() {
    let pinned = null;

    forEachCanvasLayerDeep(canvasLayers, (layer) => {
        if (!layer || layer.type !== 'image') return;

        if (layer.pinnedReference && !pinned) {
            pinned = layer;

            if (!layer.pinnedWidth || !layer.pinnedHeight) {
                const size = getDefaultPinnedReferenceSize(layer);
                layer.pinnedWidth = size.width;
                layer.pinnedHeight = size.height;
            }

            return;
        }

        // 저장 데이터에 고정 이미지가 여러 개 있으면 첫 번째만 유지
        if (layer.pinnedReference && pinned) {
            layer.pinnedReference = false;
        }
    });

    pinnedReferenceLayerId = pinned ? pinned.id : null;

    // 고정된 이미지는 중앙 캔버스 편집 대상이 아니므로 active 해제
    if (pinned && Number(activeLayerId) === Number(pinned.id)) {
        activeLayerId = null;
    }
}

function closeCanvasSaveOptionsModal() {
    const modal = el('canvasSaveOptionsModal');
    if (modal) modal.style.display = 'none';
}

function getSelectedCanvasSaveMode() {
    return document.querySelector('input[name="canvasSaveMode"]:checked')?.value || 'normal';
}

async function updateCanvasSetupItem(setupId, name, snapshot, options = {}) {
    const list = loadSavedCanvasSetups();
    const index = list.findIndex((item) => item.id === setupId);

    if (index < 0) {
        return await saveCanvasSetupItem(name, snapshot, options);
    }

    const previous = list[index];

    const nextItem = {
        ...previous,
        name: String(name || previous.name || '이름 없는 캔버스').trim(),
        savedAt: Date.now(),
        width: snapshot.width || currentCanvasWidth,
        height: snapshot.height || currentCanvasHeight,
        layerCount: options.layerCount ?? countLayersInSavedState(snapshot),
        saveMode: options.mode || 'normal',
        state: snapshot
    };

    list[index] = nextItem;
    const saved = await persistSavedCanvasSetups(list, {upserts: [nextItem], removeIds: []});
    if (!saved) {
        throw new Error('캔버스 저장본을 서버에 저장하지 못했습니다.');
    }

    activeCanvasSetupId = nextItem.id;

    return nextItem;
}

function findCanvasSetupByName(name) {
    const targetName = String(name || '').trim();

    if (!targetName) return null;

    return loadSavedCanvasSetups().find((item) => {
        return String(item.name || '').trim() === targetName;
    }) || null;
}

async function saveCanvasSetupItem(name, snapshot, options = {}) {
    const list = loadSavedCanvasSetups();

    const item = {
        id: `canvas_setup_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        name: String(name || '이름 없는 캔버스').trim(),
        savedAt: Date.now(),
        width: snapshot.width || currentCanvasWidth,
        height: snapshot.height || currentCanvasHeight,
        layerCount: options.layerCount ?? countLayersInSavedState(snapshot),
        saveMode: options.mode || 'normal',
        state: snapshot
    };

    list.unshift(item);
    const saved = await persistSavedCanvasSetups(list, {upserts: [item], removeIds: []});
    if (!saved) {
        throw new Error('캔버스 저장본을 서버에 저장하지 못했습니다.');
    }

    activeCanvasSetupId = item.id;

    return item;
}

async function replaceCurrentCanvasWithMergedImage() {
    const mergedState = await buildMergedOnlyCanvasStateSnapshot();

    applyCanvasStateSnapshot(mergedState);
    saveCanvasState();
}

async function resetCurrentCanvasAfterSave() {
    if (window.CanvasProject && !await CanvasProject.leave()) return false;
    const width = currentCanvasWidth;
    const height = currentCanvasHeight;

    if (typeof CanvasDakiFocus !== 'undefined') CanvasDakiFocus.restore(null);
    if (typeof CanvasRetouch !== 'undefined') CanvasRetouch.restore(null);
    if (typeof CanvasOppositeReference !== 'undefined') CanvasOppositeReference.restore(null);
    if (typeof CanvasInpaintReference !== 'undefined') CanvasInpaintReference.restore(null);
    canvasLayers = [];
    layerIdSeq = 1;
    activeLayerId = null;
    checkedSelectionId = null;
    activeClipSelectionId = null;
    isClipInpaintPreviewMode = false;
    pinnedReferenceLayerId = null;

    addCanvasBaseLayer(width, height);

    canvasZoom = 1;
    clipPreviewZoom = 1;

    renderCanvas(width, height);
    renderLayerList();
    updateCanvasRatioInfo();
    saveCanvasState();
    return true;
}

function getCanvasSaveModeLabel(mode) {
    switch (mode) {
        case 'mergeAfterSave':
            return '저장 후 통합';
        case 'resetAfterSave':
            return '저장 후 초기화';
        case 'imageOnly':
            return '그림만 저장';
        default:
            return '전체 저장';
    }
}

function startPinnedReferenceUiDrag(event, layerId) {
    const found = findCanvasLayer(layerId);
    const layer = found?.layer;

    if (!layer || layer.type !== 'image' || !layer.pinnedReference) return;
    if (layer.pinnedUiLocked) return;

    event.preventDefault();
    event.stopPropagation();

    activePinnedReferenceUiDrag = {
        layerId: layer.id,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startUiX: Number(layer.pinnedUiX ?? 8),
        startUiY: Number(layer.pinnedUiY ?? 8)
    };
}

function handlePinnedReferenceUiMouseMove(event) {
    if (!activePinnedReferenceUiDrag) return;

    const found = findCanvasLayer(activePinnedReferenceUiDrag.layerId);
    const layer = found?.layer;

    if (!layer || layer.type !== 'image' || !layer.pinnedReference) return;

    const dx = event.clientX - activePinnedReferenceUiDrag.startClientX;
    const dy = event.clientY - activePinnedReferenceUiDrag.startClientY;

    layer.pinnedUiX = Math.round(activePinnedReferenceUiDrag.startUiX + dx);
    layer.pinnedUiY = Math.round(activePinnedReferenceUiDrag.startUiY + dy);

    renderPinnedReferencePanel();
}

function handlePinnedReferenceUiMouseUp() {
    if (!activePinnedReferenceUiDrag) return;

    activePinnedReferenceUiDrag = null;
    saveCanvasState();
}

function togglePinnedReferenceUiLock(layerId) {
    const found = findCanvasLayer(layerId);
    const layer = found?.layer;

    if (!layer || layer.type !== 'image') return;

    layer.pinnedUiLocked = !layer.pinnedUiLocked;

    renderPinnedReferencePanel();
    saveCanvasState();
}

function resetPinnedReferenceUiPosition(layerId) {
    const found = findCanvasLayer(layerId);
    const layer = found?.layer;

    if (!layer || layer.type !== 'image') return;

    layer.pinnedUiX = 8;
    layer.pinnedUiY = 8;

    renderPinnedReferencePanel();
    saveCanvasState();
}

function startMultiImageResizeDrag(event, handle) {
    const layers = getSelectedImageLayers();
    if (layers.length < 2) return;

    event.preventDefault();
    event.stopPropagation();

    const bounds = getTransformLayerBounds(layers);
    const pointer = getCanvasPointerPosition(event);

    activeImageResizeDrag = {
        mode: 'multi',
        handle,
        startPointerX: pointer.x,
        startPointerY: pointer.y,
        displayScale: pointer.displayScale,
        surfaceLeft: pointer.surfaceLeft,
        surfaceTop: pointer.surfaceTop,
        startClientX: event.clientX,
        startClientY: event.clientY,

        startX: bounds.x,
        startY: bounds.y,
        startWidth: bounds.width,
        startHeight: bounds.height,
        anchorRight: bounds.x + bounds.width,
        anchorBottom: bounds.y + bounds.height,
        aspectRatio: Math.max(0.0001, bounds.width / bounds.height),

        starts: layers.map((layer) => ({
            id: Number(layer.id),
            x: Number(layer.x || 0),
            y: Number(layer.y || 0),
            width: Number(layer.layerWidth || layer.imageWidth || 1),
            height: Number(layer.layerHeight || layer.imageHeight || 1)
        }))
    };

    updateSelectionSizeTooltip(event.clientX, event.clientY, bounds.width, bounds.height);
    updateActiveImageResizeGuideOverlay();
}

function handleMultiImageResizeMouseMove(event) {
    const drag = activeImageResizeDrag;
    if (!drag || drag.mode !== 'multi') return;

    const pointer = getCanvasPointerPositionForDrag(event, drag);
    const handle = drag.handle;

    const fineMode = Boolean(el('imageResizeFineMode')?.checked) || event.altKey;

    let dx;
    let dy;

    if (fineMode) {
        dx = (event.clientX - drag.startClientX) * IMAGE_RESIZE_FINE_FACTOR;
        dy = (event.clientY - drag.startClientY) * IMAGE_RESIZE_FINE_FACTOR;
    } else {
        dx = pointer.x - drag.startPointerX;
        dy = pointer.y - drag.startPointerY;
    }

    let nextX = drag.startX;
    let nextY = drag.startY;
    let nextWidth = drag.startWidth;
    let nextHeight = drag.startHeight;

    if (handle.includes('r')) {
        nextWidth = drag.startWidth + dx;
    }

    if (handle.includes('l')) {
        nextWidth = drag.startWidth - dx;
        nextX = drag.anchorRight - nextWidth;
    }

    if (handle.includes('b')) {
        nextHeight = drag.startHeight + dy;
    }

    if (handle.includes('t')) {
        nextHeight = drag.startHeight - dy;
        nextY = drag.anchorBottom - nextHeight;
    }

    const keepRatio = Boolean(el('imageResizeRatioLock')?.checked) && !event.shiftKey;

    if (keepRatio) {
        const ratio = drag.aspectRatio;

        if (handle.length === 2) {
            const widthDelta = Math.abs(nextWidth - drag.startWidth);
            const heightDelta = Math.abs(nextHeight - drag.startHeight);

            if (widthDelta >= heightDelta) {
                nextHeight = nextWidth / ratio;
            } else {
                nextWidth = nextHeight * ratio;
            }

            if (handle.includes('l')) {
                nextX = drag.anchorRight - nextWidth;
            }

            if (handle.includes('t')) {
                nextY = drag.anchorBottom - nextHeight;
            }
        }

        if (handle === 'l' || handle === 'r') {
            const centerY = drag.startY + drag.startHeight / 2;

            nextHeight = nextWidth / ratio;
            nextY = centerY - nextHeight / 2;

            if (handle === 'l') {
                nextX = drag.anchorRight - nextWidth;
            }
        }

        if (handle === 't' || handle === 'b') {
            const centerX = drag.startX + drag.startWidth / 2;

            nextWidth = nextHeight * ratio;
            nextX = centerX - nextWidth / 2;

            if (handle === 't') {
                nextY = drag.anchorBottom - nextHeight;
            }
        }
    }

    nextWidth = Math.max(IMAGE_RESIZE_MIN_SIZE, nextWidth);
    nextHeight = Math.max(IMAGE_RESIZE_MIN_SIZE, nextHeight);

    if (handle.includes('l')) {
        nextX = drag.anchorRight - nextWidth;
    }

    if (handle.includes('t')) {
        nextY = drag.anchorBottom - nextHeight;
    }

    const scaleX = nextWidth / Math.max(1, drag.startWidth);
    const scaleY = nextHeight / Math.max(1, drag.startHeight);

    if (drag.starts.some((start) => {
        const layer = findCanvasLayer(start.id)?.layer;
        return layer?.type === 'selection' && !isSelectionRequestSizeAllowed({
            ...layer,
            x: nextX + (start.x - drag.startX) * scaleX,
            y: nextY + (start.y - drag.startY) * scaleY,
            layerWidth: snapToSelectionStep(start.width * scaleX),
            layerHeight: snapToSelectionStep(start.height * scaleY)
        });
    })) return;

    drag.starts.forEach((start) => {
        const found = findCanvasLayer(start.id);
        const layer = found?.layer;
        if (!isMultiTransformLayer(layer)) return;

        const relativeX = start.x - drag.startX;
        const relativeY = start.y - drag.startY;

        layer.x = nextX + relativeX * scaleX;
        layer.y = nextY + relativeY * scaleY;
        layer.layerWidth = start.width * scaleX;
        layer.layerHeight = start.height * scaleY;
    });

    updateSelectionSizeTooltip(
        event.clientX,
        event.clientY,
        Math.round(nextWidth),
        Math.round(nextHeight)
    );

    updateCanvasHotLayerGeometry(drag.starts.map((start) => start.id));
    updateActiveImageResizeGuideOverlay();
}
