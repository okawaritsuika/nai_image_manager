let pinnedReferenceLayerId = null;
let activePinnedReferenceResizeDrag = null;
let activePinnedReferenceMoveDrag = null;

let activePinnedReferencePanelDrag = null;
let activePinnedReferenceUiDrag = null;

let isImageResizeMode = false;
let activeImageResizeDrag = null;
const IMAGE_RESIZE_MIN_SIZE = 16;
const IMAGE_RESIZE_FINE_FACTOR = 0.2;

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

let activeSelectionDrag = null;

let contextSelectionId = null;
let activeClipSelectionId = null;

const SELECTION_SIZE_STEP = 64;
const SELECTION_MIN_SIZE = 64;
const NAI_FREE_AREA_LIMIT = 1048576;
const LATEST_NAI_IMAGE_MODEL = 'nai-diffusion-4-5-full';

let activeClipMaskTool = 'brush';
let clipMaskBrushSize = 96;
let isClipMaskPainting = false;

const CLIP_MASK_BRUSH_MIN = 8;
const CLIP_MASK_BRUSH_MAX = 256;
const CLIP_MASK_BRUSH_STEP = 4;

let activeClipPromptId = null;

let clipPromptViewMode = 'buttons';
let clipPromptGroups = [];
let selectedClipPromptGroup = null;
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

        if (hasAnyPromptText(fromImage)) {
            layer.promptInfo = normalizePromptInfo(fromImage);

            if (!Array.isArray(layer.promptControlGroups)) {
                layer.promptControlGroups = [];
            }

            return layer.promptInfo;
        }
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

const CANVAS_STATE_KEY = 'naia_canvas_state_v1';
const CANVAS_PENDING_IMPORT_KEY = 'naia_canvas_pending_import';
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

window.addEventListener('load', async () => {
    await fetchClipTagDictionary();
    await loadSavedCanvasSetupsFromServer();

    updateCanvasRatioInfo();
    restoreCanvasState();
    await loadSharedClipPromptGroups(true);
    updateSelectionOverlayToggleUI();
    await consumePendingCanvasImport();

    document.addEventListener('mousemove', handleLayerMoveMouseMove);
    document.addEventListener('mouseup', handleLayerMoveMouseUp);

    document.addEventListener('mousemove', handleSelectionMouseMove);
    document.addEventListener('mouseup', handleSelectionMouseUp);

    document.addEventListener('mousemove', handleImageResizeMouseMove);
    document.addEventListener('mouseup', handleImageResizeMouseUp);

    document.addEventListener('mousemove', handlePinnedReferenceResizeMouseMove);
    document.addEventListener('mouseup', handlePinnedReferenceResizeMouseUp);

    document.addEventListener('mousemove', handlePinnedReferenceMoveMouseMove);
    document.addEventListener('mouseup', handlePinnedReferenceMoveMouseUp);

    document.addEventListener('mousemove', handlePinnedReferencePanelMouseMove);
    document.addEventListener('mouseup', handlePinnedReferencePanelMouseUp);

    document.addEventListener('mousemove', handlePinnedReferenceUiMouseMove);
    document.addEventListener('mouseup', handlePinnedReferenceUiMouseUp);

    document.addEventListener('click', (event) => {
        const imageMenu = el('canvasImageLayerContextMenu');
        const selectionMenu = el('canvasSelectionContextMenu');

        if (imageMenu && imageMenu.style.display === 'block' && !imageMenu.contains(event.target)) {
            closeCanvasImageLayerContextMenu();
        }

        if (selectionMenu && selectionMenu.style.display === 'block' && !selectionMenu.contains(event.target)) {
            closeCanvasSelectionContextMenu();
        }

        if (!event.target.closest('.clip-mask-tool-control')) {
            closeClipMaskSizePopover();
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            closeCanvasImageLayerContextMenu();
            closeCanvasSelectionContextMenu();
        }
    });

    document.addEventListener('scroll', () => {
        closeCanvasImageLayerContextMenu();
        closeCanvasSelectionContextMenu();
    }, true);

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
    saveCanvasState();
}

function clearCurrentCanvasCompletely() {
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

    const detachedRefs = collectCanvasImportRefsFromLayer({
        type: 'folder',
        children: canvasLayers
    });

    currentCanvasWidth = 0;
    currentCanvasHeight = 0;
    lastEditedCanvasAxis = 'width';

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

    pinnedReferenceLayerId = null;

    canvasZoom = 1;
    clipPreviewZoom = 1;
    activeCanvasSetupId = null;

    try {
        localStorage.removeItem(CANVAS_STATE_KEY);
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

function createCanvasFromDialog() {
    const width = readCanvasInputValue('canvasWidthInput', 960);
    const height = readCanvasInputValue('canvasHeightInput', 3072);

    activeCanvasSetupId = null;

    currentCanvasWidth = width;
    currentCanvasHeight = height;
    canvasZoom = 1;

    addCanvasBaseLayer(width, height);

    renderCanvas(width, height);
    renderLayerList();
    renderCanvasLayersOnSurface();
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

    const workspace = document.querySelector('.canvas-workspace');
    const padding = 120;

    const availableWidth = Math.max(200, (workspace?.clientWidth || window.innerWidth) - padding);
    const availableHeight = Math.max(200, (workspace?.clientHeight || window.innerHeight) - padding);

    const fitScale = Math.min(
        availableWidth / width,
        availableHeight / height,
        1
    );

    const scale = fitScale * canvasZoom;

    const displayWidth = Math.max(1, Math.round(width * scale));
    const displayHeight = Math.max(1, Math.round(height * scale));

    surface.style.width = `${displayWidth}px`;
    surface.style.height = `${displayHeight}px`;
    surface.dataset.width = String(width);
    surface.dataset.height = String(height);
    surface.dataset.scale = String(scale);
    surface.dataset.fitScale = String(fitScale);
    surface.dataset.scale = String(scale);

    updateCanvasReadout(width, height, scale);
    bindCanvasWheelZoom();
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

function initializeCanvasLayers() {
    layerIdSeq = 1;

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

function addSelectionArea() {
    if (!currentCanvasWidth || !currentCanvasHeight) {
        openCanvasDialog();
        return;
    }

    const width = Math.max(128, Math.round(currentCanvasWidth * 0.5));
    const height = Math.max(128, Math.round(currentCanvasHeight * 0.22));

    const selection = {
        id: layerIdSeq++,
        name: `선택 영역 ${countCanvasLayersByType('selection') + 1}`,
        visible: true,
        type: 'selection',
        expanded: true,
        hasInpaintResult: false,
        x: Math.round((currentCanvasWidth - width) / 2),
        y: Math.round((currentCanvasHeight - height) / 2),
        layerWidth: width,
        layerHeight: height,
        children: []
    };

    canvasLayers.unshift(selection);
    activeLayerId = selection.id;
    checkedSelectionId = selection.id;
    activeClipSelectionId = selection.id;

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

function deleteCanvasLayer(layerId, event) {
    if (event) event.stopPropagation();

    const found = findCanvasLayer(layerId);
    if (!found) return;

    if (found.layer.type === 'folder' && Array.isArray(found.layer.children) && found.layer.children.length > 0) {
        const ok = confirm(`'${found.layer.name}' 폴더와 내부 레이어 ${found.layer.children.length}개를 삭제할까요?`);
        if (!ok) return;
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
    const list = el('layerList');
    if (!list) return;

    list.innerHTML = '';

    if (!canvasLayers.length) {
        list.innerHTML = '<div class="layer-empty">캔버스를 생성하면 레이어가 표시됩니다.</div>';
        return;
    }

    renderLayerTree(canvasLayers, list, 0);
    updateImageResizePanel();
}

function renderLayerTree(layers, container, depth) {
    layers.forEach((layer) => {
        if (layer.type === 'folder') {
            layer.children = Array.isArray(layer.children) ? layer.children : [];
        }
        const item = document.createElement('div');

        item.style.setProperty('--layer-depth', depth);
        item.onclick = (event) => selectCanvasLayer(layer.id, event);

        const isFolder = layer.type === 'folder';
        const isSelection = layer.type === 'selection';
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
                        : `<div class="layer-thumb">${layer.src ? `<img src="${escapeHtml(layer.src)}" alt="">` : ''}</div>`
            }

            <div class="layer-info">
                <div class="layer-name">${escapeHtml(layer.name)}</div>
                <div class="layer-meta">
                    ${
                        isFolder
                            ? `폴더 · ${layer.children.length}개`
                            : isSelection
                                ? `선택 영역 · ${layer.children.length}개`
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

        deleteBtn.onclick = (event) => deleteCanvasLayer(layer.id, event);
        if (selectionCheckBtn) {
            selectionCheckBtn.onclick = (event) => checkSelectionArea(layer.id, event);
            selectionCheckBtn.oncontextmenu = (event) => event.stopPropagation();
        }

        visibilityBtn.oncontextmenu = (event) => event.stopPropagation();
        deleteBtn.oncontextmenu = (event) => event.stopPropagation();

        // 이미지 레이어 우클릭 메뉴 유지
        if (isImage) {
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

function saveCanvasState() {
    const state = buildCanvasStateSnapshot();

    try {
        localStorage.setItem(CANVAS_STATE_KEY, JSON.stringify(state));
    } catch (error) {
        console.warn('Canvas state save failed:', error);
    }
}

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

function collectRetainedCanvasImportRefs() {
    const refs = new Set();

    try {
        if (currentCanvasWidth && currentCanvasHeight) {
            collectCanvasImportRefsFromValue(buildCanvasStateSnapshot(), refs);
        }

        collectCanvasImportRefsFromValue(loadSavedCanvasSetups(), refs);

        if (typeof referenceGenSession !== 'undefined' && referenceGenSession) {
            collectCanvasImportRefsFromValue(referenceGenSession, refs);
        }

        const rawState = localStorage.getItem(CANVAS_STATE_KEY);
        if (rawState) {
            collectCanvasImportRefsFromValue(JSON.parse(rawState), refs);
        }
    } catch (error) {
        console.warn('Canvas import ref collection failed:', error);
    }

    return [...refs];
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

function buildCanvasStateSnapshot() {
    return {
        version: 2,
        savedAt: Date.now(),
        width: currentCanvasWidth,
        height: currentCanvasHeight,
        layers: cloneCanvasLayersForState(canvasLayers),
        activeLayerId,
        layerIdSeq,
        sharedSelectionClipPromptInfo: sharedSelectionClipPromptInfo
            ? structuredClone(sharedSelectionClipPromptInfo)
            : null,
        sharedSelectionClipPromptControlGroups: structuredClone(sharedSelectionClipPromptControlGroups || []),
        isSelectionOverlayHidden,
        checkedSelectionId,
        canvasZoom: typeof canvasZoom !== 'undefined' ? canvasZoom : 1,
        clipPreviewZoom: typeof clipPreviewZoom !== 'undefined' ? clipPreviewZoom : 1,
        isClipInpaintMergedSourceMode: Boolean(isClipInpaintMergedSourceMode)
    };
}

function cloneCanvasLayersForState(layers = []) {
    return (Array.isArray(layers) ? layers : [])
        .map((layer) => {
            const copy = structuredClone(layer);

            if (copy.type === 'clip') {
                clearClipInpaintMask(copy);
            }

            if ((copy.type === 'folder' || copy.type === 'selection') && Array.isArray(copy.children)) {
                copy.children = cloneCanvasLayersForState(copy.children);
            }

            return copy;
        });
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

    const alreadySaved = isCurrentCanvasAlreadySaved();

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

            ${
                alreadySaved
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
                <button class="success" onclick="confirmPendingCanvasImport('append')" style="width:100%;">
                    기존 캔버스에 그림 추가
                </button>

                <button class="secondary" onclick="confirmPendingCanvasImport('reset')" style="width:100%;">
                    기존 캔버스를 초기화하고 그림 추가
                </button>

                <button class="secondary" onclick="cancelPendingCanvasImport()" style="width:100%;">
                    취소
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
}

function resetCanvasForPendingImport() {
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

    canvasZoom = 1;
    clipPreviewZoom = 1;
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
        if (shouldSaveBeforeImport && !isCurrentCanvasAlreadySaved()) {
            await saveCurrentCanvasSetupSilently();
        }

        localStorage.removeItem(CANVAS_PENDING_IMPORT_KEY);
        closePendingCanvasImportModal();

        if (mode === 'reset') {
            resetCanvasForPendingImport();
        }

        await importImageLayer(payload);

    } catch (error) {
        alert(`캔버스 이미지 가져오기 실패: ${error.message || error}`);
    }
}

function cancelPendingCanvasImport() {
    localStorage.removeItem(CANVAS_PENDING_IMPORT_KEY);
    closePendingCanvasImportModal();
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
            localStorage.removeItem(CANVAS_PENDING_IMPORT_KEY);
            await importImageLayer(payload);
            return;
        }

        // 기존 캔버스가 있으면 추가/초기화 선택 모달을 띄운다.
        showPendingCanvasImportModal(payload);

    } catch (error) {
        localStorage.removeItem(CANVAS_PENDING_IMPORT_KEY);
        alert(`캔버스 이미지 가져오기 실패: ${error.message || error}`);
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
    const info = await loadImageInfo(payload.src);

    // 캔버스가 없으면 가져온 이미지 크기로 새 캔버스 생성
    if (!currentCanvasWidth || !currentCanvasHeight) {
        currentCanvasWidth = info.width;
        currentCanvasHeight = info.height;
        canvasLayers = [];
        layerIdSeq = 1;
        renderCanvas(currentCanvasWidth, currentCanvasHeight);
    }

    const initialGeometry = getInitialImageLayerGeometry(info.width, info.height);

    let promptInfo = normalizePromptInfo(payload.promptInfo);

    if ((!promptInfo || !hasAnyPromptText(promptInfo)) && payload.path) {
        const fetchedPrompt = await fetchPromptInfoByPath(payload.path);
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
    renderCanvasLayersOnSurface();
    saveCanvasState();
}

function renderCanvasLayersOnSurface() {
    const surface = el('canvasSurface');
    if (!surface) return;

    surface.innerHTML = '';

    const displayScale = getCanvasDisplayScale();

    renderCanvasLayerStack(canvasLayers, surface, displayScale);
    renderMultiLayerTransformOverlay(surface, displayScale);
    renderClipOutputPanel();
    renderPinnedReferencePanel();
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
                <img src="${escapeHtml(layer.src)}" draggable="false" alt="pinned reference">
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

function renderCanvasLayerStack(layers, surface, displayScale) {
    // 배열 앞쪽이 위 레이어이므로, 화면에는 아래 레이어부터 먼저 그림
    [...layers].reverse().forEach((layer) => {
        if (!layer.visible) return;

        if (layer.type === 'folder') {
            layer.children = Array.isArray(layer.children) ? layer.children : [];
            renderCanvasLayerStack(layer.children, surface, displayScale);
            return;
        }

        if (layer.type === 'selection') {
            layer.children = Array.isArray(layer.children) ? layer.children : [];
            normalizeSelectionAreaGeometry(layer);

            // 선택 영역 안의 자식 레이어/인페인팅 결과는 계속 렌더링
            renderCanvasLayerStack(layer.children, surface, displayScale);

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

            selectionEl.style.left = `${layer.x * displayScale}px`;
            selectionEl.style.top = `${layer.y * displayScale}px`;
            selectionEl.style.width = `${layer.layerWidth * displayScale}px`;
            selectionEl.style.height = `${layer.layerHeight * displayScale}px`;

            selectionEl.oncontextmenu = (event) => {
                openCanvasSelectionContextMenu(event, layer.id);
            };

            selectionEl.innerHTML = `
                <div class="selection-move-zone" title="선택 영역 이동"></div>
                <div class="selection-resize-handle tl" data-handle="tl" title="크기 조절"></div>
                <div class="selection-resize-handle tr" data-handle="tr" title="크기 조절"></div>
                <div class="selection-resize-handle bl" data-handle="bl" title="크기 조절"></div>
                <div class="selection-resize-handle br" data-handle="br" title="크기 조절"></div>
            `;

            const moveZone = selectionEl.querySelector('.selection-move-zone');
            if (moveZone) {
                moveZone.onmousedown = (event) => {
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

            layerEl.style.left = `${layer.x * displayScale}px`;
            layerEl.style.top = `${layer.y * displayScale}px`;
            layerEl.style.width = `${layer.layerWidth * displayScale}px`;
            layerEl.style.height = `${layer.layerHeight * displayScale}px`;

            const img = document.createElement('img');
            img.src = layer.src;
            img.alt = layer.name || 'inpaint result';
            img.draggable = false;

            layerEl.appendChild(img);
            surface.appendChild(layerEl);
            return;
        }

        const layerEl = document.createElement('div');
        layerEl.className = 'canvas-render-layer';
        layerEl.dataset.layerId = String(layer.id);

        if (layer.type === 'canvas') {
            layerEl.classList.add('canvas-base-layer');
            layerEl.style.left = '0px';
            layerEl.style.top = '0px';
            layerEl.style.width = `${Math.round(currentCanvasWidth * displayScale)}px`;
            layerEl.style.height = `${Math.round(currentCanvasHeight * displayScale)}px`;
            surface.appendChild(layerEl);
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

            layerEl.style.left = `${layer.x * displayScale}px`;
            layerEl.style.top = `${layer.y * displayScale}px`;
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
            img.src = layer.src;
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

    setClipPromptEditorValue('base', info.basePrompt || '');
    setClipPromptEditorValue('negative', info.negativePrompt || '');
    setClipCharPromptValues(info.charPrompts || info.charPrompt || '');

    setClipPromptInputValueIfExists('clipSamplerInput', info.sampler || 'k_euler_ancestral');
    setClipPromptInputValueIfExists('clipStepsInput', info.steps || 28);
    setClipPromptInputValueIfExists('clipCfgInput', info.cfg || info.scale || 6);
    setClipPromptInputValueIfExists('clipStrengthInput', info.strength ?? 0.65);
    setClipPromptInputValueIfExists('clipNoiseInput', info.noise ?? 0.2);
    setClipPromptInputValueIfExists('clipSeedInput', info.seed ?? -1);

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
    renderCanvasLayersOnSurface();
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
    isLayerMoveMode = !isLayerMoveMode;
    activeLayerDrag = null;

    const btn = el('layerMoveToolBtn');
    const hint = el('layerMoveToolHint');
    const surface = el('canvasSurface');

    if (btn) btn.classList.toggle('active', isLayerMoveMode);
    if (surface) surface.classList.toggle('move-mode', isLayerMoveMode);

    if (hint) {
        hint.innerText = isLayerMoveMode
            ? '이동할 이미지 레이어를 클릭한 뒤 마우스를 떼지 말고 움직이세요.'
            : '이동 버튼을 켠 뒤 캔버스 위 이미지 레이어를 드래그하세요.';
    }

    renderCanvasLayersOnSurface();
    updateSelectionHoverCursor();
}

function toggleImageResizeMode() {
    isImageResizeMode = !isImageResizeMode;
    activeImageResizeDrag = null;

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
        btn.classList.toggle('active', isSelectionOverlayHidden);
        btn.innerText = isSelectionOverlayHidden
            ? '▣ 선택 영역 표시'
            : '▣ 선택 영역 숨김';
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

function getInitialImageLayerGeometry(imageWidth, imageHeight) {
    const canvasWidth = currentCanvasWidth || imageWidth || 960;
    const canvasHeight = currentCanvasHeight || imageHeight || 3072;

    // 기본은 원본 크기 유지.
    // 단, 캔버스보다 너무 크면 캔버스 안에 들어오도록 축소.
    const fitScale = Math.min(
        canvasWidth / imageWidth,
        canvasHeight / imageHeight,
        1
    );

    const width = Math.max(1, Math.round(imageWidth * fitScale));
    const height = Math.max(1, Math.round(imageHeight * fitScale));

    return {
        width,
        height,
        x: Math.round((canvasWidth - width) / 2),
        y: Math.round((canvasHeight - height) / 2)
    };
}

function normalizeImageLayerGeometry(layer) {
    if (!layer || layer.type !== 'image') return;

    const imageWidth = parseInt(layer.imageWidth, 10) || currentCanvasWidth || 960;
    const imageHeight = parseInt(layer.imageHeight, 10) || currentCanvasHeight || 3072;

    if (!Number.isFinite(layer.layerWidth) || !Number.isFinite(layer.layerHeight) || !layer.layerWidth || !layer.layerHeight) {
        const geometry = getInitialImageLayerGeometry(imageWidth, imageHeight);
        layer.layerWidth = geometry.width;
        layer.layerHeight = geometry.height;
    }

    if (!Number.isFinite(layer.x)) {
        layer.x = Math.round(((currentCanvasWidth || imageWidth) - layer.layerWidth) / 2);
    }

    if (!Number.isFinite(layer.y)) {
        layer.y = Math.round(((currentCanvasHeight || imageHeight) - layer.layerHeight) / 2);
    }
}

function getActiveImageLayerForResize() {
    const found = findCanvasLayer(activeLayerId);
    const layer = found?.layer;

    if (!layer || layer.type !== 'image') {
        return null;
    }

    normalizeImageLayerGeometry(layer);
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

    nameNode.innerText = `${layer.name || '이미지 레이어'} · 원본 ${layer.imageWidth || '?'} × ${layer.imageHeight || '?'}px`;

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
        layer.imageHeight || layer.layerHeight || 1
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
        stuckX: null,
        stuckY: null
    };

    if (surface) surface.classList.add('dragging');

    renderLayerList();
    renderCanvasLayersOnSurface();
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
    renderCanvasLayersOnSurface();
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

    const displayScale = getCanvasDisplayScale();
    const surface = el('canvasSurface');
    if (!surface) return;

    const surfaceRect = surface.getBoundingClientRect();

    // 현재 마우스 위치를 캔버스 실제 좌표로 변환
    const pointerCanvasX = (event.clientX - surfaceRect.left) / displayScale;
    const pointerCanvasY = (event.clientY - surfaceRect.top) / displayScale;

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

    layer.x = resolvedX.value;
    layer.y = resolvedY.value;

    activeLayerDrag.stuckX = resolvedX.stuckState;
    activeLayerDrag.stuckY = resolvedY.stuckState;

    renderCanvasLayersOnSurface();
}

function handleMultiLayerMoveMouseMove(event) {
    const drag = activeLayerDrag;
    if (!drag || drag.mode !== 'multi') return;

    const pointer = getCanvasPointerPosition(event);
    const displayScale = getCanvasDisplayScale();

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

    const finalDx = resolvedX.value - drag.startBoundsX;
    const finalDy = resolvedY.value - drag.startBoundsY;

    drag.starts.forEach((start) => {
        const found = findCanvasLayer(start.id);
        const layer = found?.layer;
        if (!isMultiTransformLayer(layer)) return;

        layer.x = start.x + finalDx;
        layer.y = start.y + finalDy;
    });

    (drag.childStarts || []).forEach((start) => {
        const found = findCanvasLayer(start.id);
        const layer = found?.layer;
        if (!isSelectionChildMovableLayer(layer)) return;

        layer.x = start.x + finalDx;
        layer.y = start.y + finalDy;
    });

    renderCanvasLayersOnSurface();
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

        activeLayerDrag = null;

        const surface = el('canvasSurface');
        if (surface) surface.classList.remove('dragging');

        renderLayerList();
        renderCanvasLayersOnSurface();
        saveCanvasState();
        return;
    }

    activeLayerDrag = null;

    const surface = el('canvasSurface');
    if (surface) surface.classList.remove('dragging');

    renderLayerList();
    renderCanvasLayersOnSurface();
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
            (layer.type === 'image' && !layer.pinnedReference) ||
            layer.type === 'selection'
        )
    );
}

function normalizeTransformLayerGeometry(layer) {
    if (!layer) return;

    if (layer.type === 'image') {
        normalizeImageLayerGeometry(layer);
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
    }

    if (!Number.isFinite(layer.y)) {
        layer.y = Math.round(((currentCanvasHeight || layer.layerHeight) - layer.layerHeight) / 2);
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

function getCanvasPointerPosition(event) {
    const surface = el('canvasSurface');
    const displayScale = getCanvasDisplayScale();

    if (!surface) {
        return { x: 0, y: 0, displayScale };
    }

    const rect = surface.getBoundingClientRect();

    return {
        x: (event.clientX - rect.left) / displayScale,
        y: (event.clientY - rect.top) / displayScale,
        displayScale
    };
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
        handle,
        startPointerX: pointer.x,
        startPointerY: pointer.y,
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

    updateSelectionSizeTooltip(event.clientX, event.clientY, layer.layerWidth, layer.layerHeight);
}

function handleSelectionMouseMove(event) {
    if (!activeSelectionDrag) return;

    const found = findCanvasLayer(activeSelectionDrag.layerId);
    const layer = found?.layer;
    if (!layer || layer.type !== 'selection') return;

    if (activeSelectionDrag.mode === 'move') {
        handleSelectionMove(event, layer);
        return;
    }

    if (activeSelectionDrag.mode === 'resize') {
        handleSelectionResize(event, layer);
    }
}

function handleSelectionMove(event, layer) {
    const pointer = getCanvasPointerPosition(event);
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

    layer.x = resolvedX.value;
    layer.y = resolvedY.value;

    const dx = layer.x - activeSelectionDrag.startX;
    const dy = layer.y - activeSelectionDrag.startY;

    (activeSelectionDrag.childStarts || []).forEach((start) => {
        const found = findCanvasLayer(start.id);
        const child = found?.layer;
        if (!isSelectionChildMovableLayer(child)) return;

        child.x = start.x + dx;
        child.y = start.y + dy;
    });

    activeSelectionDrag.stuckX = resolvedX.stuckState;
    activeSelectionDrag.stuckY = resolvedY.stuckState;

    renderCanvasLayersOnSurface();
}

function handleSelectionResize(event, layer) {
    const pointer = getCanvasPointerPosition(event);
    const handle = activeSelectionDrag.handle;

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

    layer.x = Math.round(nextX);
    layer.y = Math.round(nextY);
    layer.layerWidth = nextWidth;
    layer.layerHeight = nextHeight;

    updateSelectionSizeTooltip(event.clientX, event.clientY, nextWidth, nextHeight);
    renderCanvasLayersOnSurface();
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

    if (layer && layer.type === 'selection') {
        layer.layerWidth = snapToSelectionStep(layer.layerWidth);
        layer.layerHeight = snapToSelectionStep(layer.layerHeight);
    }
    
    (activeSelectionDrag.childStarts || []).forEach((start) => {
        const found = findCanvasLayer(start.id);
        const child = found?.layer;
        if (!isSelectionChildMovableLayer(child)) return;

        child.x = Math.round(child.x || 0);
        child.y = Math.round(child.y || 0);
    });

    activeSelectionDrag = null;

    const surface = el('canvasSurface');
    if (surface) {
        surface.classList.remove('selection-dragging');
        surface.style.cursor = '';
    }

    hideSelectionSizeTooltip();

    renderLayerList();
    renderCanvasLayersOnSurface();
    updateSelectionHoverCursor(event);
    saveCanvasState();
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

function updateSelectionSizeTooltip(clientX, clientY, width, height) {
    const tooltip = getSelectionSizeTooltip();
    const area = width * height;
    const isAnlas = area > NAI_FREE_AREA_LIMIT;

    tooltip.classList.toggle('danger', isAnlas);
    tooltip.innerText = `${width} × ${height}px${isAnlas ? ' · Anlas 가능' : ''}`;

    tooltip.style.display = 'block';
    tooltip.style.left = `${clientX + 10}px`;
    tooltip.style.top = `${clientY - 38}px`;
}

function hideSelectionSizeTooltip() {
    const tooltip = el('selectionSizeTooltip');
    if (tooltip) tooltip.style.display = 'none';
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

    const drawableLayers = collectDrawableImageLayersForClip(canvasLayers);

    for (const layer of drawableLayers) {
        normalizeImageLayerGeometry(layer);

        // 선택 영역과 전혀 겹치지 않으면 스킵
        if (!rectsIntersect(
            cropX,
            cropY,
            cropWidth,
            cropHeight,
            layer.x,
            layer.y,
            layer.layerWidth,
            layer.layerHeight
        )) {
            continue;
        }

        const img = await loadImageElementForClip(layer.src);

        ctx.drawImage(
            img,
            layer.x - cropX,
            layer.y - cropY,
            layer.layerWidth,
            layer.layerHeight
        );
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

async function renderMergedCanvasToDataUrl() {
    if (!currentCanvasWidth || !currentCanvasHeight) {
        throw new Error('내보낼 캔버스가 없습니다.');
    }

    const offscreen = document.createElement('canvas');
    offscreen.width = currentCanvasWidth;
    offscreen.height = currentCanvasHeight;

    const ctx = offscreen.getContext('2d');
    ctx.clearRect(0, 0, currentCanvasWidth, currentCanvasHeight);

    // 캔버스 베이스 레이어가 보이면 흰 배경 합성
    if (hasVisibleCanvasBaseLayer(canvasLayers)) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, currentCanvasWidth, currentCanvasHeight);
    }

    const drawableLayers = collectDrawableImageLayersForClip(canvasLayers);

    for (const layer of drawableLayers) {
        if (layer.type === 'image') {
            if (layer.pinnedReference) continue;

            normalizeImageLayerGeometry(layer);
        }

        if (!layer.src) continue;

        const img = await loadImageElementForClip(layer.src);

        ctx.drawImage(
            img,
            layer.x || 0,
            layer.y || 0,
            layer.layerWidth || layer.imageWidth || img.naturalWidth || img.width,
            layer.layerHeight || layer.imageHeight || img.naturalHeight || img.height
        );
    }

    return offscreen.toDataURL('image/png');
}

async function buildMergedOnlyCanvasStateSnapshot() {
    const dataUrl = await renderMergedCanvasToDataUrl();

    if (!dataUrl) {
        throw new Error('통합 이미지를 만들지 못했습니다.');
    }

    const mergedSrc = await saveClipDataUrlToServer(dataUrl);
    const promptInfo = getCanvasExportPromptInfo();

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

function loadImageElementForClip(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();

        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('이미지를 불러올 수 없습니다.'));

        // 같은 서버의 /image, /canvas-imports는 문제 없음.
        // 외부 URL을 쓸 경우 CORS 때문에 canvas export가 막힐 수 있음.
        img.src = src;
    });
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

function hasVisibleCanvasBaseLayer(layers) {
    for (const layer of layers) {
        if (!layer.visible) continue;

        if (layer.type === 'canvas') {
            return true;
        }

        if ((layer.type === 'folder' || layer.type === 'selection') && Array.isArray(layer.children)) {
            if (hasVisibleCanvasBaseLayer(layer.children)) return true;
        }
    }

    return false;
}

function collectDrawableImageLayersForClip(layers, output = []) {
    // renderCanvasLayerStack과 같은 순서: 아래 레이어부터 위 레이어 순서
    [...layers].reverse().forEach((layer) => {
        if (!layer || !layer.visible) return;

        if (layer.type === 'folder' || layer.type === 'selection') {
            layer.children = Array.isArray(layer.children) ? layer.children : [];
            collectDrawableImageLayersForClip(layer.children, output);
            return;
        }

        // 일반 이미지 레이어는 그대로 포함
        if (layer.type === 'image' && layer.src) {
            output.push(layer);
            return;
        }

        // 캔버스에 실제로 보이는 클립(= 인페인팅 결과)도 포함
        // 원본 클립은 renderOnCanvas가 없으므로 제외됨
        if (layer.type === 'clip' && layer.renderOnCanvas && layer.src) {
            output.push(layer);
            return;
        }
    });

    return output;
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
    clipInpaintLoadingClipId = isLoading ? clipId : null;
    clipInpaintLoadingMessage = message || '인페인팅 처리 중...';

    renderClipOutputPanel();
}

function renderClipOutputPanel() {
    const stage = el('canvasStage');
    if (!stage) return;

    const oldPanel = stage.querySelector('.canvas-clip-output-panel');
    if (oldPanel) oldPanel.remove();

    const target = getClipOutputTarget();

    if (!target || !target.clip) {
        stage.classList.remove('has-clip-output');
        return;
    }

    stage.classList.add('has-clip-output');

    const panel = document.createElement('div');
    panel.className = 'canvas-clip-output-panel';

    const previewClip = getTopVisibleInpaintClipForSelection(target.selection, target.clip);
    const showInpaintPreview = Boolean(!isClipInpaintMergedSourceMode && isClipInpaintPreviewMode && previewClip);

    // 통합 ON이면 인페인팅 결과 보기 토글보다 통합 소스 미리보기를 우선한다.
    // OFF일 때는 기존처럼 원본 클립 또는 인페인팅 결과 미리보기를 보여준다.
    const mergedPreviewKey = isClipInpaintMergedSourceMode
        ? buildClipMergedSourcePreviewKey(target.selection, target.clip)
        : '';

    const hasMergedPreview =
        isClipInpaintMergedSourceMode &&
        clipMergedSourcePreviewCache.key === mergedPreviewKey &&
        clipMergedSourcePreviewCache.dataUrl;

    if (isClipInpaintMergedSourceMode && !hasMergedPreview) {
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
        <div class="canvas-clip-output-title">클립 결과</div>
        <div class="canvas-clip-output-meta">
            ${escapeHtml(target.selection.name || '선택 영역')} · ${displayClip.imageWidth} × ${displayClip.imageHeight}px
            · <span class="clip-preview-zoom-readout">${Math.round(clipPreviewZoom * 100)}%</span>
            ${
                isClipInpaintMergedSourceMode
                    ? ` · <span class="clip-preview-mode-label">${hasMergedPreview ? '통합 소스 보기' : '통합 소스 생성 중...'}</span>`
                    : showInpaintPreview && previewClip
                        ? ` · <span class="clip-preview-mode-label">인페인팅 보기: ${escapeHtml(previewClip.name || '결과')}</span>`
                        : ` · <span class="clip-preview-mode-label">마스크 편집 보기</span>`
            }
        </div>

        <div class="canvas-clip-output-toolbar">
            <div class="clip-mask-tool-control ${openClipMaskSizeTool === 'brush' ? 'open' : ''}">
                <button class="clip-mask-tool-btn ${activeClipMaskTool === 'brush' ? 'active' : ''}"
                        title="브러시"
                        onclick="toggleClipMaskToolSizePopover('brush', event)">
                    ●
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
                <button class="clip-mask-tool-btn ${activeClipMaskTool === 'eraser' ? 'active' : ''}"
                        title="지우개"
                        onclick="toggleClipMaskToolSizePopover('eraser', event)">
                    ◌
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

            <button class="clip-mask-tool-btn ${showInpaintPreview ? 'active' : ''}"
                    title="인페인팅 결과 보기 토글"
                    onclick="toggleClipInpaintPreview()">
                ◧
            </button>

            <button class="clip-mask-tool-btn prompt-btn"
                    title="프롬프트"
                    onclick="openClipPromptModal(${target.clip.id})">
                ✎
            </button>

            <button class="clip-mask-tool-btn merged-source-toggle ${isClipInpaintMergedSourceMode ? 'active' : ''}"
                    title="ON: 클립 이미지와 인페인팅 결과를 통합한 이미지에 마스크를 적용해서 요청 / OFF: 기존처럼 클립 이미지와 마스크만 요청"
                    onclick="toggleClipInpaintMergedSourceMode()">
                통합 ${isClipInpaintMergedSourceMode ? 'ON' : 'OFF'}
            </button>

            <button class="clip-mask-tool-btn prompt-btn"
                    title="인페인팅"
                    onclick="requestClipInpainting(${target.clip.id})">
                IN
            </button>
        </div>

        <div class="${imageWrapClass}" data-clip-id="${target.clip.id}">
            <img class="clip-output-image" src="${escapeHtml(displayClip.src)}" alt="clip result">
            <canvas class="clip-mask-overlay-canvas"></canvas>

            <div class="clip-inpaint-loading ${isLoading ? 'show' : ''}">
                <div class="clip-inpaint-loading-spinner"></div>
                <div class="clip-inpaint-loading-text">${escapeHtml(clipInpaintLoadingMessage)}</div>
            </div>
        </div>
    `;

    stage.appendChild(panel);

    bindClipMaskEditor(panel, target.clip);
}

function getOrCreateSelectionInpaintFolder(selection) {
    selection.children = Array.isArray(selection.children) ? selection.children : [];
    let folder = selection.children.find((child) => child.type === 'folder' && child.name === '인페인팅');

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
    const found = findCanvasLayer(clipId);
    const clip = found?.layer;
    const selection = findSelectionParentForLayerId(clipId);

    if (!clip || clip.type !== 'clip' || !selection) {
        alert('인페인팅할 클립을 찾을 수 없습니다.');
        return;
    }

    const mask = clip.maskSrc || clip.maskDataUrl || '';
    if (!mask) {
        alert('인페인팅 마스크를 먼저 칠해 주세요.');
        return;
    }

    const requestPromptInfo = buildEffectiveClipPromptInfo(clip);

    setClipInpaintProcessing(
        clipId,
        true,
        isClipInpaintMergedSourceMode
            ? '클립과 인페인팅 결과를 통합한 뒤 인페인팅 처리 중...'
            : '인페인팅 처리 중...'
    );

    try {
        const requestWidth = clip.imageWidth || clip.layerWidth;
        const requestHeight = clip.imageHeight || clip.layerHeight;

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
                tempCategory: 'canvas_inpaint',
                tempSessionId: CANVAS_IMPORT_SESSION_ID
            })
        });

        const data = await response.json();
        if (!response.ok || data.status !== 'success') {
            throw new Error(data.message || '인페인팅 요청에 실패했습니다.');
        }

        const inpaintFolder = getOrCreateSelectionInpaintFolder(selection);
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
            promptInfo: normalizePromptInfo(clip.promptInfo),
            promptControlGroups: Array.isArray(clip.promptControlGroups)
                ? structuredClone(clip.promptControlGroups)
                : [],
            imageWidth: clip.imageWidth,
            imageHeight: clip.imageHeight,
            x: clip.x,
            y: clip.y,
            layerWidth: clip.layerWidth,
            layerHeight: clip.layerHeight,
            createdAt: Date.now()
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
        renderClipOutputPanel();
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
    renderClipOutputPanel();
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

function bindClipMaskEditor(panel, clip) {
    const wrap = panel.querySelector('.canvas-clip-output-image-wrap');
    const img = panel.querySelector('.clip-output-image');
    const overlayCanvas = panel.querySelector('.clip-mask-overlay-canvas');

    if (!wrap || !img || !overlayCanvas || !clip) return;

    const cursor = getClipBrushCursor();

    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = clip.imageWidth || img.naturalWidth || 512;
    maskCanvas.height = clip.imageHeight || img.naturalHeight || 512;

    const maskCtx = maskCanvas.getContext('2d');

    let lastPoint = null;
    let maskInitialized = false;
    let maskDirty = false;
    let maskLoadToken = 0;

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
        redrawMaskOverlay(maskCanvas, overlayCanvas);
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
    };

    const syncOverlayPosition = () => {
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

        redrawMaskOverlay(maskCanvas, overlayCanvas);
    };

    img.onload = () => {
        syncOverlayPosition();
    };

    if (img.complete) {
        requestAnimationFrame(syncOverlayPosition);
    }

    bindClipPreviewWheelZoom(wrap, img, clip, syncOverlayPosition);

    if (wrap.classList.contains('preview-mode')) {
        overlayCanvas.style.display = 'none';
        if (cursor) cursor.style.display = 'none';
        return;
    }

    overlayCanvas.style.display = 'block';

    const loadExistingMask = async () => {
        const maskSrc = clip.maskSrc || clip.maskDataUrl || '';
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

    window.addEventListener('resize', syncOverlayPosition);

    // 아래 pointer 이벤트들은 기존 코드 그대로 유지
    overlayCanvas.onpointerdown = (event) => {
        event.preventDefault();
        event.stopPropagation();

        isClipMaskPainting = true;
        maskLoadToken += 1;
        maskDirty = true;
        maskInitialized = true;
        overlayCanvas.setPointerCapture(event.pointerId);

        lastPoint = getClipMaskPoint(event, overlayCanvas, maskCanvas);
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
        renderMaskPreview();
    };

    overlayCanvas.onpointerup = async (event) => {
        if (!isClipMaskPainting) return;

        isClipMaskPainting = false;
        lastPoint = null;

        try {
            overlayCanvas.releasePointerCapture(event.pointerId);
        } catch (e) {}

        await persistClipMask(clip, maskCanvas);
        maskDirty = true;
    };

    overlayCanvas.onpointercancel = async () => {
        isClipMaskPainting = false;
        lastPoint = null;
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

function redrawMaskOverlay(maskCanvas, overlayCanvas) {
    const overlayCtx = overlayCanvas.getContext('2d');
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    const temp = document.createElement('canvas');
    temp.width = maskCanvas.width;
    temp.height = maskCanvas.height;

    const tempCtx = temp.getContext('2d');

    // 실제 마스크는 흰색이지만, 화면에는 빨간색 반투명으로 표시
    tempCtx.clearRect(0, 0, temp.width, temp.height);
    tempCtx.drawImage(maskCanvas, 0, 0);

    const imageData = tempCtx.getImageData(0, 0, temp.width, temp.height);
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

    tempCtx.putImageData(imageData, 0, 0);
    overlayCtx.drawImage(temp, 0, 0);
}

async function persistClipMask(clip, maskCanvas) {
    if (!clip || !maskCanvas) return;

    const maskDataUrl = maskCanvas.toDataURL('image/png');

    clip.maskWidth = maskCanvas.width;
    clip.maskHeight = maskCanvas.height;

    try {
        const savedSrc = await saveClipDataUrlToServer(maskDataUrl);
        clip.maskSrc = savedSrc;
        delete clip.maskDataUrl;
    } catch (error) {
        // 서버 저장 실패 시 임시로 dataUrl 보관
        console.warn('Mask save failed, fallback to local dataUrl:', error);
        clip.maskDataUrl = maskDataUrl;
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
        model: String(info.model || 'nai-diffusion-4-full'),
        sampler: String(info.sampler || 'k_euler_ancestral'),
        steps: Number(info.steps || 28),
        cfg: Number(info.cfg || info.scale || 6),
        strength: Number(info.strength ?? 0.65),
        noise: Number(info.noise ?? 0.2),
        seed: Number(info.seed ?? -1)
    };
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

            if (!rectsIntersect(
                selection.x,
                selection.y,
                selection.layerWidth,
                selection.layerHeight,
                layer.x,
                layer.y,
                layer.layerWidth,
                layer.layerHeight
            )) {
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

    setClipPromptEditorValue('base', owner.promptInfo.basePrompt || '');
    setClipPromptEditorValue('negative', owner.promptInfo.negativePrompt || '');
    setClipCharPromptValues(owner.promptInfo.charPrompts || owner.promptInfo.charPrompt || '');

    ensureClipPromptControlGroups(owner);
    renderClipPromptControlGroups(owner);

    bindClipPromptInputs();
    renderAllClipPromptTokens();
    applyClipPromptViewMode();
    switchClipPromptTab('base');

    el('clipPromptModalOverlay').classList.add('open');
}

function closeClipPromptModal() {
    el('clipPromptModalOverlay')?.classList.remove('open');
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

    owner.promptInfo = normalizePromptInfo({
        basePrompt: getClipPromptEditorValue('base'),
        charPrompts,
        charPrompt: buildLegacyCharPromptText(charPrompts),
        negativePrompt: getClipPromptEditorValue('negative'),
        model: LATEST_NAI_IMAGE_MODEL,
        sampler: getClipInputValue('clipSamplerInput', 'k_euler_ancestral'),
        steps: getClipNumberValue('clipStepsInput', 28),
        cfg: getClipNumberValue('clipCfgInput', 6),
        strength: getClipNumberValue('clipStrengthInput', 0.65),
        noise: getClipNumberValue('clipNoiseInput', 0.2),
        seed: getClipNumberValue('clipSeedInput', -1)
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

        return normalizePromptInfo({
            basePrompt: data.basePrompt || data.prompt || '',
            charPrompt: charText,
            negativePrompt: pickNegativePromptText(data),
            model: data.model,
            sampler: data.sampler,
            steps: data.steps,
            cfg: data.cfg,
            seed: data.seed,
            strength: data.strength,
            noise: data.noise,
            uc: data.uc,
            negative_prompt: data.negative_prompt
        });

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
        const matched = clipPromptGroups.find((group) => {
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
    getClipPromptFields().forEach((field) => renderClipPromptTokens(field.key));
}

function renderClipPromptTokens(fieldKey) {
    const field = getClipPromptField(fieldKey);
    if (!field) return;

    const input = el(field.inputId);
    const surface = el(field.tokensId);
    if (!input || !surface) return;

    const tokens = parseClipPromptTokens(input.value);
    const disabledState = getDisabledClipPromptVisualState(fieldKey);

    surface.innerHTML = '';

    if (!tokens.length) {
        const empty = document.createElement('span');
        empty.style.cssText = 'color: var(--text-muted); font-size: 12px;';
        empty.innerText = '프롬프트를 입력하면 버튼으로 표시됩니다.';
        surface.appendChild(empty);
        return;
    }

    const groupedParts = applyClipPromptGroupsWithIndexes(tokens.map((token, index) => ({ token, index })));

    let pendingTokens = [];

    groupedParts.forEach((part) => {
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
    button.draggable = true;
    button.ondragstart = (event) => {
        setClipPromptDragData(event, {
            field: fieldKey,
            type: 'group',
            name: '가중치 범위',
            tokens: part.tokens
        });
    };
    button.appendChild(suffix);

    surface.appendChild(button);
}

function renderClipPromptGroupButton(surface, fieldKey, groupPart, disabledState) {
    const isDisabled = isClipPromptGroupDisabledByControls(groupPart.tokens, disabledState);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = `prompt-token-btn group ${isDisabled ? 'disabled-by-control' : ''}`.trim();
    button.style.setProperty('--group-color', getClipPromptGroupColor(groupPart.name));
    button.innerText = `[${groupPart.name}]`;
    button.title = `${groupPart.tokens.join(', ')}${isDisabled ? '\n현재 OFF 상태의 제어그룹에 들어 있어 요청에 포함되지 않습니다.' : ''}`;

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

    const popover = el('clipGroupSelectionPopover');
    const nameBox = el('clipPromptGroupNameBox');
    const startButton = el('clipBtnStartPromptGroup');

    if (!popover) return;

    const margin = 12;
    const popoverWidth = 240;
    const popoverHeight = 70;

    const left = Math.min(
        event.clientX + 8,
        window.innerWidth - popoverWidth - margin
    );

    const top = Math.min(
        event.clientY + 8,
        window.innerHeight - popoverHeight - margin
    );

    popover.style.left = `${Math.max(margin, left)}px`;
    popover.style.top = `${Math.max(margin, top)}px`;
    popover.style.display = 'block';

    if (nameBox) nameBox.style.display = 'none';
    if (startButton) startButton.style.display = 'inline-block';
}

function hideClipGroupSelectionPopover() {
    const popover = el('clipGroupSelectionPopover');
    if (popover) popover.style.display = 'none';
    selectedClipPromptGroup = null;
}

function showClipPromptGroupNameInput() {
    const nameBox = el('clipPromptGroupNameBox');
    const startButton = el('clipBtnStartPromptGroup');
    const input = el('clipPromptGroupNameInput');

    if (startButton) startButton.style.display = 'none';
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

        const promptArea = document.createElement('textarea');
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
        `selectionPos:${selection.x || 0},${selection.y || 0}`
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
            clip.layerHeight || clip.imageHeight || 0
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
                        onclick="toggleClipPromptControlGroupEnabled(${group.id})">
                    ${group.enabled ? 'ON' : 'OFF'}
                </button>

                <button class="clip-control-icon-btn"
                        title="펼치기/접기"
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
    event.dataTransfer.setData('application/x-clip-prompt-item', JSON.stringify(payload));
    event.dataTransfer.setData('text/plain', payload.token || payload.name || '');
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

    const field = normalizeClipPromptControlField(payload.field);

    let item = null;

    if (payload.type === 'group') {
        const tokens = Array.isArray(payload.tokens)
            ? payload.tokens.map((token) => String(token || '').trim()).filter(Boolean)
            : parseClipPromptTokens(payload.token || '');

        if (!tokens.length) return;

        item = {
            field,
            type: 'group',
            name: payload.name || '그룹',
            tokens
        };
    } else {
        const token = String(payload.token || '').trim();
        if (!token) return;

        item = {
            field,
            type: 'token',
            token
        };
    }

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

    return disabledState.groupKeys.has(key);
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

    return normalizePromptInfo({
        ...baseInfo,
        basePrompt: applyDisabledClipPromptControlGroups(baseInfo.basePrompt, groups, 'base'),
        negativePrompt: applyDisabledClipPromptControlGroups(baseInfo.negativePrompt, groups, 'negative'),
        charPrompts: effectiveCharPrompts,
        charPrompt: buildLegacyCharPromptText(effectiveCharPrompts)
    });
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

function bindCanvasWheelZoom() {
    const surface = el('canvasSurface');
    if (!surface || surface.dataset.zoomWheelBound === '1') return;

    surface.dataset.zoomWheelBound = '1';
    surface.addEventListener('wheel', handleCanvasWheelZoom, { passive: false });
}

function handleCanvasWheelZoom(event) {
    if (!currentCanvasWidth || !currentCanvasHeight) return;

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

    // 선택 영역 이미지를 기본으로 보여줄 최대 크기.
    // zoom 1일 때는 이 크기만큼만 래퍼가 보인다.
    const maxViewportWidth = Math.min(520, Math.max(240, window.innerWidth * 0.32));
    const maxViewportHeight = Math.min(720, Math.max(240, window.innerHeight * 0.72));

    const fitScale = Math.min(
        maxViewportWidth / naturalWidth,
        maxViewportHeight / naturalHeight,
        1
    );

    const baseWidth = Math.max(1, Math.round(naturalWidth * fitScale));
    const baseHeight = Math.max(1, Math.round(naturalHeight * fitScale));

    const displayWidth = Math.max(1, Math.round(baseWidth * clipPreviewZoom));
    const displayHeight = Math.max(1, Math.round(baseHeight * clipPreviewZoom));

    // 래퍼는 기존 선택 영역 표시 크기만큼만 보이게 고정.
    // 이미지가 확대되면 래퍼 안에서 스크롤된다.
    wrap.style.width = `${baseWidth}px`;
    wrap.style.height = `${baseHeight}px`;
    wrap.style.maxWidth = 'min(520px, 72vw)';
    wrap.style.maxHeight = 'min(72vh, 720px)';
    wrap.style.overflow = 'auto';

    img.style.width = `${displayWidth}px`;
    img.style.height = `${displayHeight}px`;
    img.style.maxWidth = 'none';
    img.style.maxHeight = 'none';
}

function bindClipPreviewWheelZoom(wrap, img, clip, afterZoom) {
    if (!wrap || !img || !clip || wrap.dataset.clipZoomWheelBound === '1') return;

    wrap.dataset.clipZoomWheelBound = '1';

    wrap.addEventListener('wheel', (event) => {
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

function normalizeSavedCanvasSetupItem(item) {
    if (!item || typeof item !== 'object') return null;
    if (!item.state || typeof item.state !== 'object') return null;

    const setup = {
        ...item,
        id: String(item.id || `canvas_setup_${Date.now()}_${Math.random().toString(16).slice(2)}`),
        name: String(item.name || '이름 없는 캔버스').trim() || '이름 없는 캔버스',
        savedAt: Number(item.savedAt || Date.now()),
        width: Number(item.width || item.state?.width || 0),
        height: Number(item.height || item.state?.height || 0),
        layerCount: Number(item.layerCount || countLayersInSavedState(item.state) || 0),
        saveMode: String(item.saveMode || 'normal')
    };

    return setup;
}

function normalizeSavedCanvasSetupsList(list) {
    const result = [];
    const seen = new Set();

    (Array.isArray(list) ? list : []).forEach((item) => {
        const normalized = normalizeSavedCanvasSetupItem(item);
        if (!normalized) return;

        if (seen.has(normalized.id)) {
            normalized.id = `${normalized.id}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        }

        seen.add(normalized.id);
        result.push(normalized);
    });

    result.sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0));
    return result;
}

function mergeSavedCanvasSetups(serverList, legacyList) {
    const merged = [];
    const seenIds = new Set();

    normalizeSavedCanvasSetupsList(serverList).forEach((item) => {
        seenIds.add(item.id);
        merged.push(item);
    });

    normalizeSavedCanvasSetupsList(legacyList).forEach((item) => {
        if (seenIds.has(item.id)) {
            const serverItem = merged.find((entry) => entry.id === item.id);
            const serverSavedAt = Number(serverItem?.savedAt || 0);
            const legacySavedAt = Number(item.savedAt || 0);

            // 같은 id인데 브라우저 저장본이 더 최신이면 덮어쓰기
            if (serverItem && legacySavedAt > serverSavedAt) {
                Object.assign(serverItem, item);
            }

            return;
        }

        seenIds.add(item.id);
        merged.push(item);
    });

    merged.sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0));
    return merged;
}

function readLegacySavedCanvasSetups() {
    try {
        const raw = localStorage.getItem(CANVAS_SAVED_SETUPS_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return normalizeSavedCanvasSetupsList(list);
    } catch (error) {
        console.warn('Legacy saved canvas setups read failed:', error);
        return [];
    }
}

async function loadSavedCanvasSetupsFromServer(force = false) {
    if (!force && Array.isArray(cachedSavedCanvasSetups)) {
        return cachedSavedCanvasSetups;
    }

    if (!force && savedCanvasSetupsLoadPromise) {
        return savedCanvasSetupsLoadPromise;
    }

    savedCanvasSetupsLoadPromise = (async () => {
        try {
            const res = await fetch('/api/canvas/setups');
            const data = await res.json();

            if (!res.ok || data.status !== 'success') {
                throw new Error(data.message || '캔버스 저장본을 불러오지 못했습니다.');
            }

            const serverList = normalizeSavedCanvasSetupsList(data.setups);
            const legacyList = readLegacySavedCanvasSetups();

            if (legacyList.length) {
                const merged = mergeSavedCanvasSetups(serverList, legacyList);
                const beforeCount = serverList.length;

                cachedSavedCanvasSetups = merged;
                const saveOk = await persistSavedCanvasSetups(merged);

                if (saveOk) {
                    const addedCount = Math.max(0, merged.length - beforeCount);
                    canvasLegacySetupMigrationMessage =
                        `브라우저에 남아 있던 캔버스 저장본 ${legacyList.length}개를 확인했고, 서버 저장본과 병합했습니다.` +
                        (addedCount ? ` 새로 복구된 저장본: ${addedCount}개.` : '');

                    // 기존 localStorage 데이터는 삭제하지 않는다.
                    // 사용자가 직접 확인할 수 있도록 남겨두되, 앞으로 저장은 서버 JSON에만 한다.
                }
            } else {
                cachedSavedCanvasSetups = serverList;
            }

            return cachedSavedCanvasSetups;
        } catch (error) {
            console.warn('Saved canvas setups server load failed:', error);
            cachedSavedCanvasSetups = [];
            return cachedSavedCanvasSetups;
        } finally {
            savedCanvasSetupsLoadPromise = null;
        }
    })();

    return savedCanvasSetupsLoadPromise;
}

function loadSavedCanvasSetups() {
    return Array.isArray(cachedSavedCanvasSetups) ? cachedSavedCanvasSetups : [];
}

function persistSavedCanvasSetups(list) {
    cachedSavedCanvasSetups = normalizeSavedCanvasSetupsList(list);

    savedCanvasSetupsSavePromise = savedCanvasSetupsSavePromise
        .catch(() => null)
        .then(async () => {
            const res = await fetch('/api/canvas/setups', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    setups: cachedSavedCanvasSetups
                })
            });

            const data = await res.json();

            if (!res.ok || data.status !== 'success') {
                throw new Error(data.message || '캔버스 저장본 저장 실패');
            }

            cachedSavedCanvasSetups = normalizeSavedCanvasSetupsList(data.setups || cachedSavedCanvasSetups);
            return true;
        })
        .catch((error) => {
            console.warn('Saved canvas setups server save failed:', error);
            if (typeof showToast === 'function') {
                showToast(`⚠️ 캔버스 저장본 저장 실패: ${error.message || error}`);
            }
            return false;
        });

    return savedCanvasSetupsSavePromise;
}

function saveCurrentCanvasSetup() {
    if (!currentCanvasWidth || !currentCanvasHeight) {
        alert('저장할 캔버스가 없습니다.');
        return;
    }

    const activeSavedItem = activeCanvasSetupId
        ? loadSavedCanvasSetups().find((item) => item.id === activeCanvasSetupId)
        : null;

    const defaultName = activeSavedItem?.name || `캔버스 ${currentCanvasWidth}×${currentCanvasHeight}`;
    const nameInput = el('canvasSaveNameInput');

    if (nameInput) {
        nameInput.value = defaultName;
        requestAnimationFrame(() => {
            nameInput.focus();
            nameInput.select();
        });
    }

    const normalOption = document.querySelector('input[name="canvasSaveMode"][value="normal"]');
    if (normalOption) normalOption.checked = true;

    const modal = el('canvasSaveOptionsModal');
    if (modal) {
        modal.style.display = 'flex';
    }
}

async function confirmSaveCurrentCanvasSetup() {
    if (!currentCanvasWidth || !currentCanvasHeight) {
        alert('저장할 캔버스가 없습니다.');
        return;
    }

    const name = String(el('canvasSaveNameInput')?.value || '').trim();
    if (!name) {
        alert('저장 이름을 입력해 주세요.');
        return;
    }

    const mode = getSelectedCanvasSaveMode();

    try {
        const snapshot = mode === 'imageOnly'
            ? await buildMergedOnlyCanvasStateSnapshot()
            : buildCanvasStateSnapshot();

        const saveOptions = {
            mode,
            layerCount: countLayersInSavedState(snapshot)
        };

        const activeSavedItem = activeCanvasSetupId
            ? loadSavedCanvasSetups().find((item) => item.id === activeCanvasSetupId)
            : null;

        const sameNameItem = findCanvasSetupByName(name);
        const overwriteTarget = activeSavedItem || sameNameItem || null;

        if (overwriteTarget) {
            const ok = confirm(
                `'${overwriteTarget.name}' 저장본을 덮어쓸까요?\n\n` +
                '취소하면 새 저장본으로 추가합니다.'
            );

            if (ok) {
                await updateCanvasSetupItem(overwriteTarget.id, name, snapshot, saveOptions);
            } else {
                await saveCanvasSetupItem(name, snapshot, saveOptions);
            }
        } else {
            await saveCanvasSetupItem(name, snapshot, saveOptions);
        }

        closeCanvasSaveOptionsModal();

        if (mode === 'mergeAfterSave') {
            await replaceCurrentCanvasWithMergedImage();
            alert(`'${name}' 저장 완료\n현재 캔버스는 통합 이미지 1장만 남겼습니다.`);
            return;
        }

        if (mode === 'resetAfterSave') {
            resetCurrentCanvasAfterSave();
            alert(`'${name}' 저장 완료\n현재 캔버스를 초기화했습니다.`);
            return;
        }

        if (mode === 'imageOnly') {
            alert(`'${name}' 그림만 저장 완료`);
            return;
        }

        alert(`'${name}' 저장 완료`);

    } catch (error) {
        alert(`저장 실패: ${error.message || error}`);
    }
}

async function openSavedCanvasSetupsModal() {
    await loadSavedCanvasSetupsFromServer(true);
    renderSavedCanvasSetupList();

    if (canvasLegacySetupMigrationMessage) {
        const listEl = el('savedCanvasSetupList');
        if (listEl) {
            const notice = document.createElement('div');
            notice.className = 'saved-canvas-migration-notice';
            notice.style.cssText = `
                margin-bottom: 10px;
                padding: 10px 12px;
                border: 1px solid #00b894;
                border-radius: 10px;
                background: rgba(0, 184, 148, 0.12);
                color: #dfffee;
                font-size: 12px;
                line-height: 1.5;
                font-weight: 700;
            `;
            notice.innerText = canvasLegacySetupMigrationMessage;
            listEl.prepend(notice);
        }
    }

    const modal = el('savedCanvasSetupsModal');
    if (modal) modal.style.display = 'flex';
}

function closeSavedCanvasSetupsModal() {
    const modal = el('savedCanvasSetupsModal');
    if (modal) modal.style.display = 'none';
}

function renderSavedCanvasSetupList() {
    const listEl = el('savedCanvasSetupList');
    if (!listEl) return;

    const list = loadSavedCanvasSetups();

    listEl.innerHTML = '';

    if (!list.length) {
        listEl.innerHTML = `<div class="saved-canvas-empty">저장된 캔버스가 없습니다.</div>`;
        return;
    }

    list.forEach((item) => {
        const dateText = formatSavedCanvasDate(item.savedAt);
        const layerCount = item.layerCount ?? countLayersInSavedState(item.state);
        const modeLabel = getCanvasSaveModeLabel(item.saveMode);

        const row = document.createElement('div');
        row.className = 'saved-canvas-item';

        row.innerHTML = `
            <div class="saved-canvas-info">
                <div class="saved-canvas-name">${escapeHtml(item.name || '이름 없는 캔버스')}</div>
                <div class="saved-canvas-meta">
                    ${escapeHtml(String(item.width || item.state?.width || '?'))} × ${escapeHtml(String(item.height || item.state?.height || '?'))}
                    · 레이어 ${layerCount}개
                    · ${escapeHtml(dateText)}
                    · ${escapeHtml(modeLabel)}
                </div>
            </div>

            <div class="saved-canvas-actions">
                <button class="secondary" onclick="loadCanvasSetup('${item.id}')">불러오기</button>
                <button class="secondary" onclick="renameCanvasSetup('${item.id}')">이름</button>
                <button class="danger" onclick="deleteCanvasSetup('${item.id}')">삭제</button>
            </div>
        `;

        listEl.appendChild(row);
    });
}

function formatSavedCanvasDate(timestamp) {
    if (!timestamp) return '날짜 없음';

    const date = new Date(timestamp);

    if (Number.isNaN(date.getTime())) return '날짜 없음';

    return date.toLocaleString();
}

function countLayersInSavedState(state) {
    if (!state || !Array.isArray(state.layers)) return 0;

    const scan = (layers) => {
        return layers.reduce((count, layer) => {
            const children = Array.isArray(layer.children) ? scan(layer.children) : 0;
            return count + 1 + children;
        }, 0);
    };

    return scan(state.layers);
}

function loadCanvasSetup(setupId) {
    const list = loadSavedCanvasSetups();
    const item = list.find((entry) => entry.id === setupId);

    if (!item || !item.state) {
        alert('저장본을 찾을 수 없습니다.');
        return;
    }

    const ok = confirm(`'${item.name}' 캔버스를 불러올까요?\n현재 캔버스 작업 상태는 자동 저장 슬롯에서 덮어써집니다.`);
    if (!ok) return;

    applyCanvasStateSnapshot(item.state);
    activeCanvasSetupId = item.id;

    closeSavedCanvasSetupsModal();
}

async function renameCanvasSetup(setupId) {
    const list = loadSavedCanvasSetups();
    const item = list.find((entry) => entry.id === setupId);

    if (!item) return;

    const nextName = prompt('새 이름을 입력하세요.', item.name || '');
    if (!nextName || !nextName.trim()) return;

    item.name = nextName.trim();
    item.savedAt = Date.now();

    const saved = await persistSavedCanvasSetups(list);
    if (!saved) {
        alert('이름 변경 저장에 실패했습니다.');
        return;
    }
    renderSavedCanvasSetupList();
}

async function deleteCanvasSetup(setupId) {
    const list = loadSavedCanvasSetups();
    const item = list.find((entry) => entry.id === setupId);

    if (!item) return;

    const ok = confirm(`'${item.name}' 저장본을 삭제할까요?`);
    if (!ok) return;

    const detachedRefs = collectCanvasImportRefsFromLayer(item.state);
    const nextList = list.filter((entry) => entry.id !== setupId);
    const saved = await persistSavedCanvasSetups(nextList);
    if (!saved) {
        alert('캔버스 저장본 삭제에 실패했습니다.');
        return;
    }

    if (activeCanvasSetupId === setupId) {
        activeCanvasSetupId = null;
    }
    renderSavedCanvasSetupList();
    cleanupDetachedCanvasImportRefs(detachedRefs);
}

function applyCanvasStateSnapshot(state) {
    if (!state || !state.width || !state.height) {
        alert('불러올 수 없는 캔버스 저장본입니다.');
        return;
    }

    currentCanvasWidth = parseInt(state.width, 10) || 0;
    currentCanvasHeight = parseInt(state.height, 10) || 0;
    canvasLayers = Array.isArray(state.layers) ? structuredClone(state.layers) : [];
    activeLayerId = state.activeLayerId || canvasLayers[0]?.id || null;
    layerIdSeq = parseInt(state.layerIdSeq, 10) || (canvasLayers.length + 1);
    const restoredClipPromptGroups = normalizeSharedPromptGroups(state.clipPromptGroups || []);
    if (restoredClipPromptGroups.length) {
        clipPromptGroups = mergePromptGroupLists(clipPromptGroups, restoredClipPromptGroups);
        saveSharedClipPromptGroups(true).catch((error) => {
            console.warn('캔버스 저장본의 프롬프트 그룹 공유 저장 실패:', error);
        });
    }

    sharedSelectionClipPromptInfo = state.sharedSelectionClipPromptInfo
        ? normalizePromptInfo(state.sharedSelectionClipPromptInfo)
        : null;

    sharedSelectionClipPromptControlGroups = Array.isArray(state.sharedSelectionClipPromptControlGroups)
        ? structuredClone(state.sharedSelectionClipPromptControlGroups)
        : [];

    isSelectionOverlayHidden = Boolean(state.isSelectionOverlayHidden);
    checkedSelectionId = state.checkedSelectionId || null;

    if (typeof canvasZoom !== 'undefined') {
        canvasZoom = Number(state.canvasZoom) || 1;
    }

    if (typeof clipPreviewZoom !== 'undefined') {
        clipPreviewZoom = Number(state.clipPreviewZoom) || 1;
    }

    isClipInpaintMergedSourceMode = Boolean(state.isClipInpaintMergedSourceMode);

    normalizeCanvasLayerTree(canvasLayers);

    const needsLegacyPromptMigration = Number(state.version || 0) < 2;

    if (needsLegacyPromptMigration) {
        if (typeof migratePromptOwnersAndControlGroups === 'function') {
            migratePromptOwnersAndControlGroups();
        }

        if (typeof forceSharePromptControlsByImageOwner === 'function') {
            forceSharePromptControlsByImageOwner();
        }
    }

    // 최신 구조에서는 clip → owner 병합 금지.
    // owner → clip 복사본 동기화만 수행.
    syncAllPromptCopiesFromOwners();

    // 선택 영역 클립들은 다시 공용 프롬프트 owner 하나를 공유하도록 강제
    migrateAllSelectionClipsToSharedPromptOwner();

    if (typeof syncClipPromptControlGroupSeqFromAllLayers === 'function') {
        syncClipPromptControlGroupSeqFromAllLayers();
    }

    if (typeof refreshPinnedReferenceStateFromLayers === 'function') {
        refreshPinnedReferenceStateFromLayers();
    }

    ensureCheckedSelectionId();
    updateSelectionOverlayToggleUI();

    if (currentCanvasWidth && currentCanvasHeight) {
        renderCanvas(currentCanvasWidth, currentCanvasHeight);
        renderLayerList();
        renderCanvasLayersOnSurface();
    } else {
        renderLayerList();
    }

    updateCanvasRatioInfo();
    migrateCanvasLayerDataUrlsToServer();
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

    if (imageLayer) {
        return normalizePromptInfo(imageLayer.promptInfo);
    }

    const clipLayer = allLayers.find((layer) => {
        return layer.type === 'clip' &&
            layer.promptInfo &&
            hasAnyPromptText(layer.promptInfo);
    });

    if (clipLayer) {
        const owner = getPromptOwnerLayer(clipLayer) || clipLayer;
        return normalizePromptInfo(owner.promptInfo || clipLayer.promptInfo);
    }

    return normalizePromptInfo(null);
}

async function getCanvasExportPromptInfoAsync() {
    const direct = getCanvasExportPromptInfo();

    if (hasAnyPromptText(direct)) {
        return normalizePromptInfo(direct);
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

        if (hasAnyPromptText(recovered)) {
            layer.promptInfo = normalizePromptInfo(recovered);
            saveCanvasState();
            return layer.promptInfo;
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
            return candidate;
        }

        const sourcePath = clip.sourcePath || owner.sourcePath || '';
        if (sourcePath) {
            const fromImage = await fetchPromptInfoByPath(sourcePath);

            if (hasAnyPromptText(fromImage)) {
                clip.promptInfo = normalizePromptInfo(fromImage);
                if (owner && owner !== clip) {
                    owner.promptInfo = normalizePromptInfo(fromImage);
                }
                saveCanvasState();
                return normalizePromptInfo(fromImage);
            }
        }
    }

    return normalizePromptInfo(null);
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

async function exportMergedCanvasToClassified() {
    if (!currentCanvasWidth || !currentCanvasHeight) {
        alert('내보낼 캔버스가 없습니다.');
        return;
    }

    try {
        const promptInfo = await getCanvasExportPromptInfoAsync();
        const isDakimakura = isCurrentCanvasDakimakuraLike(promptInfo);

        const image = await renderMergedCanvasToDataUrl();

        const response = await fetch('/api/canvas/export_merged', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                image,
                width: currentCanvasWidth,
                height: currentCanvasHeight,
                promptInfo,
                isDakimakura,
                source: 'canvas'
            })
        });

        const data = await response.json();

        if (!response.ok || data.status !== 'success') {
            throw new Error(data.message || '통합 내보내기에 실패했습니다.');
        }

        alert(`내보내기 완료\n${data.path}`);

    } catch (error) {
        alert(`통합 내보내기 실패: ${error.message || error}`);
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

    const textarea = document.createElement('textarea');
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

    if (!layer || layer.type !== 'image' || !layer.visible) return;
    if (!isImageResizeMode) return;

    event.preventDefault();
    event.stopPropagation();

    activeLayerId = layer.id;
    normalizeImageLayerGeometry(layer);

    const pointer = getCanvasPointerPosition(event);

    activeImageResizeDrag = {
        layerId: layer.id,
        handle,

        startPointerX: pointer.x,
        startPointerY: pointer.y,

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

    const pointer = getCanvasPointerPosition(event);
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

    renderCanvasLayersOnSurface();
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

    if (layer && layer.type === 'image') {
        // 저장할 때는 정수화
        layer.x = Math.round(layer.x || 0);
        layer.y = Math.round(layer.y || 0);
        layer.layerWidth = Math.round(layer.layerWidth || 1);
        layer.layerHeight = Math.round(layer.layerHeight || 1);
    }

    if (layer.type === 'selection') {
        layer.layerWidth = snapToSelectionStep(layer.layerWidth);
        layer.layerHeight = snapToSelectionStep(layer.layerHeight);
    }

    activeImageResizeDrag = null;
    hideSelectionSizeTooltip();

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

    const fitScale = Math.min(
        currentCanvasWidth / imageWidth,
        currentCanvasHeight / imageHeight,
        1
    );

    layer.layerWidth = Math.max(1, Math.round(imageWidth * fitScale));
    layer.layerHeight = Math.max(1, Math.round(imageHeight * fitScale));
    layer.x = Math.round((currentCanvasWidth - layer.layerWidth) / 2);
    layer.y = Math.round((currentCanvasHeight - layer.layerHeight) / 2);

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
    const saved = await persistSavedCanvasSetups(list);
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
    const saved = await persistSavedCanvasSetups(list);
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

function resetCurrentCanvasAfterSave() {
    const width = currentCanvasWidth;
    const height = currentCanvasHeight;

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
    renderCanvasLayersOnSurface();
    updateCanvasRatioInfo();
    saveCanvasState();
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
}

function handleMultiImageResizeMouseMove(event) {
    const drag = activeImageResizeDrag;
    if (!drag || drag.mode !== 'multi') return;

    const pointer = getCanvasPointerPosition(event);
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

    renderCanvasLayersOnSurface();
}

/* =========================================================
   참조 이미지 생성
   - 가운데 캔버스 우클릭 → 참조 이미지 생성
   - 현재 캔버스 통합 이미지 생성
   - 선택 해상도 흰 배경 중앙에 비율 유지 배치
   - 갤러리 인페인팅과 비슷한 마스크 편집/인페인팅
   - 덮어쓰기/새로 저장 없음
   - 내보내기: 현재 캔버스에 새 이미지 레이어로 가져오기
========================================================= */

let referenceGenSession = null;
let referenceGenTool = 'brush';
let referenceGenBrushSize = 96;
let referenceGenPainting = false;
let referenceGenLastPoint = null;
let referenceGenLastPointerEvent = null;
let referenceGenMaskVisible = true;
let referenceGenCharPromptSeq = 1;
let referenceGenMaskCanvas = null;
let referenceGenMaskCtx = null;

window.addEventListener('load', () => {
    bindCanvasSurfaceReferenceContextMenu();

    document.addEventListener('click', (event) => {
        const surfaceMenu = el('canvasSurfaceContextMenu');

        if (
            surfaceMenu &&
            surfaceMenu.style.display === 'block' &&
            !surfaceMenu.contains(event.target)
        ) {
            closeCanvasSurfaceContextMenu();
        }

        if (!event.target.closest?.('.reference-gen-tool-wrap')) {
            document.querySelectorAll('.reference-gen-tool-wrap.open').forEach((wrap) => {
                wrap.classList.remove('open');
            });
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;

        closeCanvasSurfaceContextMenu();
    });

    document.addEventListener('scroll', () => {
        closeCanvasSurfaceContextMenu();
    }, true);

    window.addEventListener('resize', () => {
        syncReferenceGenOverlayDisplaySize();
    });
});

function bindCanvasSurfaceReferenceContextMenu() {
    const surface = el('canvasSurface');
    if (!surface) return;

    if (surface.dataset.referenceGenContextBound === '1') {
        return;
    }

    surface.dataset.referenceGenContextBound = '1';

    surface.addEventListener('contextmenu', (event) => {
        openCanvasSurfaceContextMenu(event);
    });
}

function openCanvasSurfaceContextMenu(event) {
    if (!currentCanvasWidth || !currentCanvasHeight) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    closeCanvasImageLayerContextMenu();
    closeCanvasSelectionContextMenu();

    const menu = el('canvasSurfaceContextMenu');
    if (!menu) return;

    menu.style.display = 'block';

    const margin = 12;
    const menuWidth = menu.offsetWidth || 180;
    const menuHeight = menu.offsetHeight || 60;

    const left = Math.min(event.clientX, window.innerWidth - menuWidth - margin);
    const top = Math.min(event.clientY, window.innerHeight - menuHeight - margin);

    menu.style.left = `${Math.max(margin, left)}px`;
    menu.style.top = `${Math.max(margin, top)}px`;
}

function closeCanvasSurfaceContextMenu() {
    const menu = el('canvasSurfaceContextMenu');
    if (menu) menu.style.display = 'none';
}

function openReferenceGenResolutionModal() {
    closeCanvasSurfaceContextMenu();

    if (!currentCanvasWidth || !currentCanvasHeight) {
        alert('먼저 캔버스를 생성해 주세요.');
        return;
    }

    applyReferenceGenPreset(512, 1664);

    const modal = el('referenceGenResolutionModal');
    if (modal) {
        modal.style.display = 'flex';
    }
}

function closeReferenceGenResolutionModal() {
    const modal = el('referenceGenResolutionModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

function applyReferenceGenPreset(width, height) {
    const widthInput = el('referenceGenWidthInput');
    const heightInput = el('referenceGenHeightInput');

    if (widthInput) widthInput.value = width;
    if (heightInput) heightInput.value = height;
}

function readReferenceGenResolutionInput() {
    const width = parseInt(el('referenceGenWidthInput')?.value, 10);
    const height = parseInt(el('referenceGenHeightInput')?.value, 10);

    return {
        width: Number.isFinite(width) && width >= 64 ? width : 512,
        height: Number.isFinite(height) && height >= 64 ? height : 1664
    };
}

async function createReferenceGenSessionFromDialog() {
    if (!currentCanvasWidth || !currentCanvasHeight) {
        alert('먼저 캔버스를 생성해 주세요.');
        return;
    }

    const { width, height } = readReferenceGenResolutionInput();

    closeReferenceGenResolutionModal();

    try {
        setReferenceGenProcessing(true, '참조 이미지 생성 중...');

        const mergedDataUrl = await renderMergedCanvasToDataUrl();
        const referenceDataUrl = await buildReferenceGenBaseImageDataUrl(
            mergedDataUrl,
            width,
            height
        );

        const savedSrc = await saveClipDataUrlToServer(referenceDataUrl);
        const promptInfo = normalizeReferenceGenPromptInfo(getCanvasExportPromptInfo());

        referenceGenSession = {
            width,
            height,
            originalSrc: savedSrc,
            currentSrc: savedSrc,
            resultSrc: '',
            promptInfo,
            maskDataUrl: '',
            createdAt: Date.now()
        };

        referenceGenTool = 'brush';
        referenceGenBrushSize = 96;
        referenceGenMaskVisible = true;
        referenceGenPainting = false;
        referenceGenLastPoint = null;
        referenceGenLastPointerEvent = null;

        openReferenceGenLayer();
        showReferenceGenToast('참조 이미지가 생성되었습니다.');

    } catch (error) {
        alert(`참조 이미지 생성 실패: ${error.message || error}`);
    } finally {
        setReferenceGenProcessing(false);
    }
}

async function buildReferenceGenBaseImageDataUrl(sourceDataUrl, targetWidth, targetHeight) {
    const sourceImage = await loadReferenceGenImage(sourceDataUrl);

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const ctx = canvas.getContext('2d');

    // 참조 이미지 배경은 흰색
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetWidth, targetHeight);

    /*
        중요:
        여기서 맞추는 기준은 이미지 레이어가 아니라
        현재 가운데 실제 캔버스 전체 통합 이미지다.
    */
    const scale = Math.min(
        targetWidth / sourceImage.naturalWidth,
        targetHeight / sourceImage.naturalHeight
    );

    const drawWidth = Math.round(sourceImage.naturalWidth * scale);
    const drawHeight = Math.round(sourceImage.naturalHeight * scale);
    const drawX = Math.round((targetWidth - drawWidth) / 2);
    const drawY = Math.round((targetHeight - drawHeight) / 2);

    ctx.drawImage(sourceImage, drawX, drawY, drawWidth, drawHeight);

    return canvas.toDataURL('image/png');
}

function loadReferenceGenImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();

        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('이미지를 불러올 수 없습니다.'));

        img.src = src;
    });
}

function openReferenceGenLayer() {
    if (!referenceGenSession) return;

    const layer = el('referenceGenLayer');
    const img = el('referenceGenImage');
    const meta = el('referenceGenMeta');

    if (!layer || !img) return;

    if (meta) {
        meta.innerText = `${referenceGenSession.width} × ${referenceGenSession.height}px`;
    }

    img.onload = () => {
        setupReferenceGenOverlay();
        clearReferenceGenMask();
        applyReferenceGenMaskVisibility();
    };

    img.src = withCacheBuster(referenceGenSession.currentSrc);

    layer.style.display = 'flex';

    setReferenceGenTool('brush');
    setReferenceGenBrushSize(referenceGenBrushSize);
    setReferenceGenPromptValues(referenceGenSession.promptInfo);
}

function closeReferenceGen() {
    const layer = el('referenceGenLayer');
    if (layer) layer.style.display = 'none';

    referenceGenPainting = false;
    referenceGenLastPoint = null;
    hideReferenceGenBrushCursor();
}

function setupReferenceGenOverlay() {
    const img = el('referenceGenImage');
    const overlay = el('referenceGenOverlay');

    if (!img || !overlay || !referenceGenSession) return;

    referenceGenMaskCanvas = document.createElement('canvas');
    referenceGenMaskCanvas.width = referenceGenSession.width;
    referenceGenMaskCanvas.height = referenceGenSession.height;
    referenceGenMaskCtx = referenceGenMaskCanvas.getContext('2d');
    referenceGenMaskCtx.clearRect(0, 0, referenceGenMaskCanvas.width, referenceGenMaskCanvas.height);

    overlay.width = referenceGenSession.width;
    overlay.height = referenceGenSession.height;

    syncReferenceGenOverlayDisplaySize();
    redrawReferenceGenMaskOverlay();

    if (overlay.dataset.referenceGenBound !== '1') {
        overlay.dataset.referenceGenBound = '1';

        overlay.addEventListener('mousedown', startReferenceGenMaskPaint);
        overlay.addEventListener('mousemove', moveReferenceGenMaskPaint);
        overlay.addEventListener('mouseup', stopReferenceGenMaskPaint);
        overlay.addEventListener('mouseleave', stopReferenceGenMaskPaint);

        overlay.addEventListener('mouseenter', (event) => {
            referenceGenLastPointerEvent = event;
            updateReferenceGenBrushCursor(event);
        });

        overlay.addEventListener('mousemove', (event) => {
            referenceGenLastPointerEvent = event;
            updateReferenceGenBrushCursor(event);
        });

        overlay.addEventListener('mouseleave', () => {
            hideReferenceGenBrushCursor();
        });

        overlay.addEventListener('touchstart', startReferenceGenMaskPaint, { passive: false });
        overlay.addEventListener('touchmove', moveReferenceGenMaskPaint, { passive: false });
        overlay.addEventListener('touchend', stopReferenceGenMaskPaint, { passive: false });
    }
}

function syncReferenceGenOverlayDisplaySize() {
    const img = el('referenceGenImage');
    const overlay = el('referenceGenOverlay');

    if (!img || !overlay) return;

    const displayWidth = img.clientWidth || img.getBoundingClientRect().width;
    const displayHeight = img.clientHeight || img.getBoundingClientRect().height;

    if (!displayWidth || !displayHeight) return;

    overlay.style.width = `${displayWidth}px`;
    overlay.style.height = `${displayHeight}px`;
}

function getReferenceGenPointer(event) {
    const overlay = el('referenceGenOverlay');
    const rect = overlay.getBoundingClientRect();

    const pointSource = event.touches && event.touches.length
        ? event.touches[0]
        : event;

    return {
        x: (pointSource.clientX - rect.left) * (overlay.width / rect.width),
        y: (pointSource.clientY - rect.top) * (overlay.height / rect.height),
        clientX: pointSource.clientX,
        clientY: pointSource.clientY
    };
}

function startReferenceGenMaskPaint(event) {
    if (!referenceGenSession) return;

    event.preventDefault();
    event.stopPropagation();

    referenceGenPainting = true;

    const point = getReferenceGenPointer(event);
    referenceGenLastPoint = point;

    drawReferenceGenMaskPoint(point);
    updateReferenceGenMaskDataUrl();
    updateReferenceGenBrushCursorFromPoint(point);
}

function moveReferenceGenMaskPaint(event) {
    if (!referenceGenSession) return;

    const point = getReferenceGenPointer(event);
    referenceGenLastPointerEvent = event;

    updateReferenceGenBrushCursorFromPoint(point);

    if (!referenceGenPainting) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (referenceGenLastPoint) {
        drawReferenceGenMaskLine(referenceGenLastPoint, point);
    } else {
        drawReferenceGenMaskPoint(point);
    }

    referenceGenLastPoint = point;
    updateReferenceGenMaskDataUrl();
}

function stopReferenceGenMaskPaint(event) {
    if (event) {
        event.preventDefault?.();
        event.stopPropagation?.();
    }

    if (!referenceGenPainting) {
        return;
    }

    referenceGenPainting = false;
    referenceGenLastPoint = null;
    updateReferenceGenMaskDataUrl();
}

function drawReferenceGenMaskPoint(point) {
    if (!referenceGenMaskCtx) return;

    referenceGenMaskCtx.save();

    if (referenceGenTool === 'eraser') {
        referenceGenMaskCtx.globalCompositeOperation = 'destination-out';
        referenceGenMaskCtx.fillStyle = 'rgba(0, 0, 0, 1)';
    } else {
        referenceGenMaskCtx.globalCompositeOperation = 'source-over';

        // 실제 마스크 데이터는 불투명하게 저장한다.
        // 화면에는 redrawReferenceGenMaskOverlay()에서 반투명으로 보여준다.
        referenceGenMaskCtx.fillStyle = 'rgba(0, 128, 255, 1)';
    }

    referenceGenMaskCtx.beginPath();
    referenceGenMaskCtx.arc(point.x, point.y, referenceGenBrushSize / 2, 0, Math.PI * 2);
    referenceGenMaskCtx.fill();

    referenceGenMaskCtx.restore();
    redrawReferenceGenMaskOverlay();
}

function drawReferenceGenMaskLine(from, to) {
    if (!referenceGenMaskCtx) return;

    referenceGenMaskCtx.save();

    if (referenceGenTool === 'eraser') {
        referenceGenMaskCtx.globalCompositeOperation = 'destination-out';
        referenceGenMaskCtx.strokeStyle = 'rgba(0, 0, 0, 1)';
    } else {
        referenceGenMaskCtx.globalCompositeOperation = 'source-over';

        // 실제 마스크 데이터는 불투명하게 저장한다.
        // 화면 표시만 반투명 처리한다.
        referenceGenMaskCtx.strokeStyle = 'rgba(0, 128, 255, 1)';
    }

    referenceGenMaskCtx.lineWidth = referenceGenBrushSize;
    referenceGenMaskCtx.lineCap = 'round';
    referenceGenMaskCtx.lineJoin = 'round';

    referenceGenMaskCtx.beginPath();
    referenceGenMaskCtx.moveTo(from.x, from.y);
    referenceGenMaskCtx.lineTo(to.x, to.y);
    referenceGenMaskCtx.stroke();

    referenceGenMaskCtx.restore();
    redrawReferenceGenMaskOverlay();
}

function redrawReferenceGenMaskOverlay() {
    const overlay = el('referenceGenOverlay');

    if (!overlay || !referenceGenMaskCanvas) return;

    const ctx = overlay.getContext('2d');

    ctx.clearRect(0, 0, overlay.width, overlay.height);

    // 갤러리 인페인팅과 같은 방식:
    // 실제 마스크는 불투명, 화면 표시만 반투명.
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.drawImage(referenceGenMaskCanvas, 0, 0, overlay.width, overlay.height);
    ctx.restore();

    applyReferenceGenMaskVisibility();
}

function clearReferenceGenMask() {
    if (!referenceGenMaskCanvas || !referenceGenMaskCtx) {
        const overlay = el('referenceGenOverlay');

        if (overlay && referenceGenSession) {
            referenceGenMaskCanvas = document.createElement('canvas');
            referenceGenMaskCanvas.width = referenceGenSession.width;
            referenceGenMaskCanvas.height = referenceGenSession.height;
            referenceGenMaskCtx = referenceGenMaskCanvas.getContext('2d');
        }
    }

    if (referenceGenMaskCtx && referenceGenMaskCanvas) {
        referenceGenMaskCtx.clearRect(
            0,
            0,
            referenceGenMaskCanvas.width,
            referenceGenMaskCanvas.height
        );
    }

    if (referenceGenSession) {
        referenceGenSession.maskDataUrl = '';
    }

    redrawReferenceGenMaskOverlay();
}

function updateReferenceGenMaskDataUrl() {
    if (!referenceGenMaskCanvas || !referenceGenSession) return;

    referenceGenSession.maskDataUrl = referenceGenMaskCanvas.toDataURL('image/png');
}

function isReferenceGenMaskEmpty() {
    if (!referenceGenMaskCanvas || !referenceGenMaskCtx) return true;

    const data = referenceGenMaskCtx.getImageData(
        0,
        0,
        referenceGenMaskCanvas.width,
        referenceGenMaskCanvas.height
    ).data;

    for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 8) {
            return false;
        }
    }

    return true;
}

function setReferenceGenTool(tool, button = null) {
    referenceGenTool = tool === 'eraser' ? 'eraser' : 'brush';

    document.querySelectorAll('.reference-gen-tool-btn').forEach((btn) => {
        btn.classList.remove('active');
    });

    document.querySelectorAll('.reference-gen-tool-wrap').forEach((wrap) => {
        wrap.classList.remove('open');
    });

    if (button) {
        button.classList.add('active');

        const wrap = button.closest('.reference-gen-tool-wrap');
        if (wrap) wrap.classList.add('open');
    } else {
        const selector = referenceGenTool === 'eraser'
            ? `.reference-gen-tool-btn[onclick*="eraser"]`
            : `.reference-gen-tool-btn[onclick*="brush"]`;

        const targetButton = document.querySelector(selector);
        if (targetButton) {
            targetButton.classList.add('active');

            const wrap = targetButton.closest('.reference-gen-tool-wrap');
            if (wrap) wrap.classList.add('open');
        }
    }

    updateReferenceGenBrushCursor(referenceGenLastPointerEvent);
}

function setReferenceGenBrushSize(value) {
    referenceGenBrushSize = Math.max(8, Math.min(320, parseInt(value, 10) || 96));

    document.querySelectorAll('.reference-gen-size-popover input[type="range"]').forEach((input) => {
        input.value = String(referenceGenBrushSize);
    });

    document.querySelectorAll('.reference-gen-size-readout').forEach((node) => {
        node.innerText = `${referenceGenBrushSize}px`;
    });

    updateReferenceGenBrushCursor(referenceGenLastPointerEvent);
}

function toggleReferenceGenMaskVisible() {
    referenceGenMaskVisible = !referenceGenMaskVisible;
    applyReferenceGenMaskVisibility();
}

function applyReferenceGenMaskVisibility() {
    const overlay = el('referenceGenOverlay');
    const btn = el('referenceGenMaskToggleBtn');
    const cursor = el('referenceGenBrushCursor');

    if (overlay) {
        overlay.style.opacity = referenceGenMaskVisible ? '1' : '0';
    }

    if (btn) {
        btn.innerText = referenceGenMaskVisible ? '선택범위 숨김' : '선택범위 표시';
        btn.classList.toggle('active', !referenceGenMaskVisible);
    }

    if (!referenceGenMaskVisible && cursor) {
        cursor.style.display = 'none';
    }
}

function updateReferenceGenBrushCursor(event) {
    if (!event) return;

    const point = getReferenceGenPointer(event);
    updateReferenceGenBrushCursorFromPoint(point);
}

function updateReferenceGenBrushCursorFromPoint(point) {
    const cursor = el('referenceGenBrushCursor');
    const overlay = el('referenceGenOverlay');

    if (!cursor || !overlay || !referenceGenMaskVisible) {
        hideReferenceGenBrushCursor();
        return;
    }

    const displayScale = (overlay.clientWidth || overlay.getBoundingClientRect().width || overlay.width) / overlay.width;
    const size = Math.max(4, referenceGenBrushSize * displayScale);

    cursor.style.display = 'block';
    cursor.style.left = `${point.clientX}px`;
    cursor.style.top = `${point.clientY}px`;
    cursor.style.width = `${size}px`;
    cursor.style.height = `${size}px`;
    cursor.classList.toggle('eraser', referenceGenTool === 'eraser');
}

function hideReferenceGenBrushCursor() {
    const cursor = el('referenceGenBrushCursor');
    if (cursor) {
        cursor.style.display = 'none';
    }
}

function openReferenceGenPrompt() {
    if (!referenceGenSession) {
        alert('참조 이미지 세션이 없습니다.');
        return;
    }

    setReferenceGenPromptValues(referenceGenSession.promptInfo);

    const layer = el('referenceGenPromptLayer');
    if (layer) {
        layer.style.display = 'flex';
    }
}

function closeReferenceGenPrompt() {
    const layer = el('referenceGenPromptLayer');
    if (layer) {
        layer.style.display = 'none';
    }
}

function setReferenceGenPromptValues(promptInfo) {
    const p = normalizeReferenceGenPromptInfo(promptInfo);

    const baseInput = el('referenceGenBasePrompt');
    const negativeInput = el('referenceGenNegativePrompt');
    const samplerInput = el('referenceGenSampler');
    const stepsInput = el('referenceGenSteps');
    const cfgInput = el('referenceGenCfg');
    const seedInput = el('referenceGenSeed');
    const strengthInput = el('referenceGenStrength');
    const noiseInput = el('referenceGenNoise');

    if (baseInput) baseInput.value = p.basePrompt || '';
    if (negativeInput) negativeInput.value = p.negativePrompt || '';
    if (samplerInput) samplerInput.value = p.sampler || 'k_euler_ancestral';
    if (stepsInput) stepsInput.value = p.steps || 28;
    if (cfgInput) cfgInput.value = p.cfg || p.scale || 6;
    if (seedInput) seedInput.value = p.seed ?? -1;
    if (strengthInput) strengthInput.value = p.strength ?? 0.65;
    if (noiseInput) noiseInput.value = p.noise ?? 0.2;

    const charPrompts = normalizeReferenceGenCharPromptList(p);
    setReferenceGenCharPromptValues(charPrompts);
}

function saveReferenceGenPrompt() {
    if (!referenceGenSession) {
        closeReferenceGenPrompt();
        return;
    }

    referenceGenSession.promptInfo = buildReferenceGenPromptInfoFromInputs();
    closeReferenceGenPrompt();
    showReferenceGenToast('참조 이미지 프롬프트를 저장했습니다.');
}

function buildReferenceGenPromptInfoFromInputs() {
    const charPrompts = getReferenceGenCharPromptValues();

    return normalizeReferenceGenPromptInfo({
        basePrompt: el('referenceGenBasePrompt')?.value || '',
        charPrompt: charPrompts.join(', '),
        charPrompts,
        negativePrompt: el('referenceGenNegativePrompt')?.value || '',
        sampler: el('referenceGenSampler')?.value || 'k_euler_ancestral',
        steps: parseInt(el('referenceGenSteps')?.value, 10) || 28,
        cfg: parseFloat(el('referenceGenCfg')?.value) || 6,
        seed: parseInt(el('referenceGenSeed')?.value, 10),
        strength: parseFloat(el('referenceGenStrength')?.value) || 0.65,
        noise: parseFloat(el('referenceGenNoise')?.value) || 0.2
    });
}

function normalizeReferenceGenPromptInfo(value) {
    const normalized = typeof normalizePromptInfo === 'function'
        ? normalizePromptInfo(value || {})
        : (value || {});

    const charPrompts = normalizeReferenceGenCharPromptList(normalized);

    return {
        ...normalized,
        basePrompt: normalized.basePrompt || normalized.prompt || normalized.baseCaption || '',
        charPrompt: normalized.charPrompt || charPrompts.join(', '),
        charPrompts,
        negativePrompt: normalized.negativePrompt || normalized.negative_prompt || normalized.uc || '',
        sampler: normalized.sampler || 'k_euler_ancestral',
        steps: normalized.steps || 28,
        cfg: normalized.cfg || normalized.scale || 6,
        seed: normalized.seed ?? -1,
        strength: normalized.strength ?? 0.65,
        noise: normalized.noise ?? 0.2
    };
}

function normalizeReferenceGenCharPromptList(value) {
    if (Array.isArray(value)) {
        return value
            .map((item) => String(item || '').trim())
            .filter(Boolean);
    }

    if (value && typeof value === 'object') {
        if (Array.isArray(value.charPrompts)) {
            return normalizeReferenceGenCharPromptList(value.charPrompts);
        }

        if (Array.isArray(value.characterPrompts)) {
            return normalizeReferenceGenCharPromptList(value.characterPrompts);
        }

        const single = value.charPrompt || value.characterPrompt || value.char_prompt || '';
        return normalizeReferenceGenCharPromptList(single);
    }

    return String(value || '')
        .split(/\n|,/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function getReferenceGenCharPromptValues() {
    return [...document.querySelectorAll('#referenceGenCharPromptList textarea')]
        .map((textarea) => String(textarea.value || '').trim())
        .filter(Boolean);
}

function setReferenceGenCharPromptValues(values) {
    const container = el('referenceGenCharPromptList');
    if (!container) return;

    const list = normalizeReferenceGenCharPromptList(values);

    container.innerHTML = '';

    if (!list.length) {
        addReferenceGenCharPromptEditor('');
        return;
    }

    list.forEach((value) => addReferenceGenCharPromptEditor(value));
}

function addReferenceGenCharPromptEditor(initialValue = '') {
    const container = el('referenceGenCharPromptList');
    if (!container) return;

    const id = `rgcp${referenceGenCharPromptSeq++}`;
    const index = container.querySelectorAll('.reference-gen-char-prompt-item').length + 1;

    const item = document.createElement('div');
    item.className = 'reference-gen-char-prompt-item';
    item.dataset.charPromptId = id;
    item.style.cssText = `
        border: 1px solid var(--border-color);
        border-radius: 10px;
        padding: 10px;
        margin-bottom: 10px;
        background: var(--bg-color);
    `;

    item.innerHTML = `
        <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:6px;">
            <div style="font-size:12px; font-weight:900; color:var(--accent-blue);">
                Character Prompt ${index}
            </div>
            <button type="button"
                    class="secondary"
                    style="padding:4px 8px; font-size:12px;">
                삭제
            </button>
        </div>
        <textarea rows="4" id="referenceGenCharPromptInput-${id}"></textarea>
    `;

    const textarea = item.querySelector('textarea');
    textarea.value = String(initialValue || '');

    const deleteBtn = item.querySelector('button');
    deleteBtn.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();

        item.remove();
        renumberReferenceGenCharPromptEditors();

        if (!container.querySelector('.reference-gen-char-prompt-item')) {
            addReferenceGenCharPromptEditor('');
        }
    };

    container.appendChild(item);
}

function renumberReferenceGenCharPromptEditors() {
    document.querySelectorAll('#referenceGenCharPromptList .reference-gen-char-prompt-item').forEach((item, index) => {
        const title = item.querySelector('div div');
        if (title) {
            title.innerText = `Character Prompt ${index + 1}`;
        }
    });
}

async function requestReferenceGenInpaint() {
    if (!referenceGenSession) {
        alert('참조 이미지 세션이 없습니다.');
        return;
    }

    if (isReferenceGenMaskEmpty()) {
        alert('인페인팅할 영역을 먼저 칠해 주세요.');
        return;
    }

    referenceGenSession.promptInfo = normalizeReferenceGenPromptInfo(referenceGenSession.promptInfo);
    updateReferenceGenMaskDataUrl();

    setReferenceGenProcessing(true, '인페인팅 처리 중...');

    try {
        const response = await fetch('/api/canvas/inpaint', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                image: referenceGenSession.currentSrc,
                mask: referenceGenSession.maskDataUrl,
                width: referenceGenSession.width,
                height: referenceGenSession.height,
                promptInfo: referenceGenSession.promptInfo,
                persistResult: false,
                tempCategory: 'canvas_inpaint',
                tempSessionId: CANVAS_IMPORT_SESSION_ID
            })
        });

        const data = await response.json();

        if (!response.ok || data.status !== 'success') {
            throw new Error(data.message || '인페인팅 요청에 실패했습니다.');
        }

        referenceGenSession.resultSrc = data.image || data.src;
        referenceGenSession.currentSrc = referenceGenSession.resultSrc;

        const img = el('referenceGenImage');

        if (img) {
            img.onload = () => {
                setupReferenceGenOverlay();
                clearReferenceGenMask();
                referenceGenMaskVisible = false;
                applyReferenceGenMaskVisibility();
            };

            img.src = withCacheBuster(referenceGenSession.currentSrc);
        }

        showReferenceGenToast('인페인팅 결과를 받았습니다.');

    } catch (error) {
        alert(`인페인팅 실패: ${error.message || error}`);
    } finally {
        setReferenceGenProcessing(false);
    }
}

async function exportReferenceGenToCanvas() {
    if (!referenceGenSession || !referenceGenSession.currentSrc) {
        alert('내보낼 참조 이미지가 없습니다.');
        return;
    }

    if (!currentCanvasWidth || !currentCanvasHeight) {
        alert('먼저 캔버스를 생성해 주세요.');
        return;
    }

    try {
        await addReferenceGenImageLayerCoverCanvas({
            src: referenceGenSession.currentSrc,
            name: `참조 이미지 ${referenceGenSession.width}×${referenceGenSession.height}`,
            promptInfo: referenceGenSession.promptInfo
        });

        closeReferenceGen();
        showReferenceGenToast('참조 이미지를 캔버스 크기에 맞춰 크게 내보냈습니다.');

    } catch (error) {
        alert(`내보내기 실패: ${error.message || error}`);
    }
}

async function addReferenceGenImageLayerCoverCanvas({ src, name, promptInfo }) {
    const info = await loadImageInfo(src);

    const imageWidth = info.width || referenceGenSession?.width || 512;
    const imageHeight = info.height || referenceGenSession?.height || 1664;

    /*
        내보내기 배치 규칙:
        - 비율 유지
        - 가로 또는 세로 중 하나는 현재 캔버스와 정확히 같게
        - 나머지 한 축은 캔버스보다 크거나 같게
        - 즉 contain이 아니라 cover 방식
    */
    const scale = Math.max(
        currentCanvasWidth / imageWidth,
        currentCanvasHeight / imageHeight
    );

    const layerWidth = Math.round(imageWidth * scale);
    const layerHeight = Math.round(imageHeight * scale);

    const layerX = Math.round((currentCanvasWidth - layerWidth) / 2);
    const layerY = Math.round((currentCanvasHeight - layerHeight) / 2);

    const newLayerId = layerIdSeq++;

    const layer = {
        id: newLayerId,
        promptOwnerId: newLayerId,
        name: name || `참조 이미지 ${imageWidth}×${imageHeight}`,
        visible: true,
        type: 'image',
        src: withCacheBuster(src),
        sourcePath: '',
        promptInfo: normalizePromptInfoForReferenceGenExport(promptInfo),
        promptControlGroups: [],
        imageWidth,
        imageHeight,
        x: layerX,
        y: layerY,
        layerWidth,
        layerHeight
    };

    canvasLayers.unshift(layer);
    activeLayerId = layer.id;

    selectedLayerIds.clear();
    selectedLayerIds.add(Number(layer.id));

    renderCanvas(currentCanvasWidth, currentCanvasHeight);
    renderLayerList();
    renderCanvasLayersOnSurface();
    saveCanvasState();
}

function normalizePromptInfoForReferenceGenExport(promptInfo) {
    if (typeof normalizePromptInfo === 'function') {
        return normalizePromptInfo(promptInfo || {});
    }

    return promptInfo || {};
}

function setReferenceGenProcessing(isProcessing, message = '처리 중...') {
    const loading = el('referenceGenLoading');
    const text = el('referenceGenLoadingText');

    if (text) {
        text.innerText = message;
    }

    if (loading) {
        loading.classList.toggle('show', Boolean(isProcessing));
        loading.style.display = isProcessing ? 'flex' : '';
    }
}

function withCacheBuster(src) {
    if (!src) return src;

    if (src.startsWith('data:')) {
        return src;
    }

    const separator = src.includes('?') ? '&' : '?';
    return `${src}${separator}t=${Date.now()}`;
}

function showReferenceGenToast(message) {
    if (typeof showToast === 'function') {
        showToast(message);
        return;
    }

    console.log(message);
}
