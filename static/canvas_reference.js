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
const REFERENCE_GEN_MASK_OVERLAY_ALPHA = 0.34;
let referenceGenZoom = 1;
const REFERENCE_GEN_ZOOM_MIN = 0.25;
const REFERENCE_GEN_ZOOM_MAX = 8;
let referenceGenPainting = false;
let referenceGenLastPoint = null;
let referenceGenLastPointerEvent = null;
let referenceGenMaskVisible = true;
let referenceGenCharPromptSeq = 1;
let referenceGenMaskCanvas = null;
let referenceGenMaskCtx = null;
let referenceGenInternalClipboard = null;
let referenceGenUpscaleLastEditedAxis = 'width';
let referenceGenUpscaleStartPending = false;
let referenceGenUpscaleModelPanel = null;
const REFERENCE_GEN_RESOLUTION_STEP = 64;
const REFERENCE_GEN_HIGH_AREA_LIMIT = 768 * 2496;
const REFERENCE_GEN_MAX_SIDE = 2496;

if (window.UpscaleModelPanel?.create) {
    referenceGenUpscaleModelPanel = window.UpscaleModelPanel.create({
        prefix: 'referenceGenUpscale',
        layerId: 'referenceGenUpscaleLayer',
        engineSelectId: 'referenceGenUpscaleEngine',
        resolutionSectionId: 'referenceGenUpscaleResolutionSection',
        qualitySectionId: 'referenceGenUpscaleQualitySection',
        startButtonId: 'referenceGenUpscaleStart',
        getTargetDimensions: getReferenceGenUpscaleInputSize,
        getQuality: getSelectedReferenceGenUpscaleQuality,
        sourceDimensions: () => ({
            width: referenceGenSession?.width || 0,
            height: referenceGenSession?.height || 0
        }),
        sourceIdentity: () => [referenceGenSession, referenceGenSession?.currentSrc || '']
    });
}

window.addEventListener('load', () => {
    bindCanvasSurfaceReferenceContextMenu();

    document.addEventListener('click', (event) => {
        const surfaceMenu = el('canvasSurfaceContextMenu');
        const referenceMenu = getReferenceGenClipboardContextMenu(false);

        if (
            surfaceMenu &&
            surfaceMenu.style.display === 'block' &&
            !surfaceMenu.contains(event.target)
        ) {
            closeCanvasSurfaceContextMenu();
        }

        if (
            referenceMenu &&
            referenceMenu.style.display === 'block' &&
            !referenceMenu.contains(event.target)
        ) {
            closeReferenceGenClipboardContextMenu();
        }

        if (!event.target.closest?.('.reference-gen-tool-wrap')) {
            document.querySelectorAll('.reference-gen-tool-wrap.open').forEach((wrap) => {
                wrap.classList.remove('open');
            });
        }

        const detailMenu = el('referenceGenDetailChoiceMenu');
        if (
            detailMenu &&
            detailMenu.style.display === 'block' &&
            !detailMenu.contains(event.target) &&
            !event.target.closest?.('[data-reference-gen-detail-choice]')
        ) {
            closeReferenceGenDetailChoice();
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;

        closeCanvasSurfaceContextMenu();
        closeReferenceGenClipboardContextMenu();
        closeReferenceGenUpscaleExportModal();
        closeReferenceGenDetailChoice();
    });

    document.addEventListener('scroll', () => {
        closeCanvasSurfaceContextMenu();
        closeReferenceGenClipboardContextMenu();
        closeReferenceGenDetailChoice();
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

function getReferenceGenClipboardContextMenu(createIfMissing = true) {
    let menu = el('referenceGenClipboardContextMenu');

    if (!menu && createIfMissing) {
        menu = document.createElement('div');
        menu.id = 'referenceGenClipboardContextMenu';
        menu.className = 'canvas-layer-context-menu reference-gen-clipboard-context-menu';
        menu.innerHTML = `
            <button class="canvas-layer-context-item" onclick="copyReferenceGenImageToClipboard()">
                복사
            </button>
            <button class="canvas-layer-context-item" onclick="pasteClipboardToReferenceGenImage()">
                가져오기
            </button>
        `;
        document.body.appendChild(menu);
    }

    return menu;
}

function openReferenceGenClipboardContextMenu(event) {
    if (!referenceGenSession?.currentSrc) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    closeCanvasImageLayerContextMenu();
    closeCanvasSelectionContextMenu();
    closeCanvasSurfaceContextMenu();
    closeClipOutputClipboardContextMenu();

    const menu = getReferenceGenClipboardContextMenu();
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

function closeReferenceGenClipboardContextMenu() {
    const menu = getReferenceGenClipboardContextMenu(false);
    if (menu) menu.style.display = 'none';
}

function buildReferenceGenClipboardPayload(src, width, height, promptInfo = null) {
    if (!src) return null;

    return {
        src,
        width: Math.max(1, Math.round(Number(width) || 1)),
        height: Math.max(1, Math.round(Number(height) || 1)),
        promptInfo: normalizeReferenceGenPromptInfo(promptInfo || referenceGenSession?.promptInfo || {}),
        copiedAt: Date.now()
    };
}

async function copyReferenceGenImageToClipboard() {
    closeReferenceGenClipboardContextMenu();

    if (!referenceGenSession?.currentSrc) {
        alert('복사할 참조 이미지가 없습니다.');
        return false;
    }

    referenceGenInternalClipboard = buildReferenceGenClipboardPayload(
        referenceGenSession.currentSrc,
        referenceGenSession.width,
        referenceGenSession.height,
        referenceGenSession.promptInfo
    );

    try {
        await writeClipOutputToSystemClipboard(referenceGenSession.currentSrc);
        showReferenceGenToast('참조 이미지를 클립보드에 복사했습니다.');
        return true;
    } catch (error) {
        alert(`참조 이미지 복사 실패: ${error.message || error}`);
        return false;
    }
}

async function getImageSizeFromDataUrl(dataUrl) {
    const image = await loadReferenceGenImage(dataUrl);
    return {
        width: image.naturalWidth || image.width || 1,
        height: image.naturalHeight || image.height || 1
    };
}

async function resizeReferenceGenImageToSessionSize(src, targetWidth, targetHeight) {
    const image = await loadReferenceGenImage(src);
    const sourceWidth = Math.max(1, image.naturalWidth || image.width || 1);
    const sourceHeight = Math.max(1, image.naturalHeight || image.height || 1);
    const width = Math.max(1, Math.round(Number(targetWidth) || 1));
    const height = Math.max(1, Math.round(Number(targetHeight) || 1));

    if (sourceWidth === width && sourceHeight === height) {
        return { src, sourceWidth, sourceHeight, width, height, resized: false };
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const scale = Math.max(width / sourceWidth, height / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    const drawX = (width - drawWidth) / 2;
    const drawY = (height - drawHeight) / 2;
    ctx.drawImage(image, drawX, drawY, drawWidth, drawHeight);

    return {
        src: canvas.toDataURL('image/png'),
        sourceWidth,
        sourceHeight,
        width,
        height,
        resized: true
    };
}

async function pasteClipboardToReferenceGenImage() {
    closeReferenceGenClipboardContextMenu();

    if (!referenceGenSession) {
        alert('참조 이미지 세션이 없습니다.');
        return false;
    }

    try {
        let clipboard = null;
        const externalImageDataUrl = await readExternalCanvasImageDataUrlFromSystemClipboard();

        if (externalImageDataUrl) {
            const size = await getImageSizeFromDataUrl(externalImageDataUrl);
            clipboard = buildReferenceGenClipboardPayload(
                externalImageDataUrl,
                size.width,
                size.height,
                referenceGenSession.promptInfo
            );
        } else if (referenceGenInternalClipboard?.src) {
            clipboard = referenceGenInternalClipboard;
        } else if (clipOutputInternalClipboard?.src) {
            clipboard = buildReferenceGenClipboardPayload(
                clipOutputInternalClipboard.src,
                clipOutputInternalClipboard.imageWidth || clipOutputInternalClipboard.layerWidth,
                clipOutputInternalClipboard.imageHeight || clipOutputInternalClipboard.layerHeight,
                clipOutputInternalClipboard.promptInfo || referenceGenSession.promptInfo
            );
        }

        if (!clipboard?.src) {
            alert('가져올 클립보드 이미지가 없습니다.');
            return false;
        }

        const targetWidth = Math.max(1, Math.round(Number(referenceGenSession.width) || 1));
        const targetHeight = Math.max(1, Math.round(Number(referenceGenSession.height) || 1));
        const fittedImage = await resizeReferenceGenImageToSessionSize(
            clipboard.src,
            targetWidth,
            targetHeight
        );
        const pastedSrc = String(fittedImage.src).startsWith('data:')
            ? await saveClipDataUrlToServer(fittedImage.src)
            : fittedImage.src;

        referenceGenSession.width = targetWidth;
        referenceGenSession.height = targetHeight;
        referenceGenSession.currentSrc = pastedSrc;
        referenceGenSession.originalSrc = pastedSrc;
        referenceGenSession.detailSourceSrc = pastedSrc;
        referenceGenSession.resultSrc = '';
        referenceGenSession.promptInfo = normalizeReferenceGenPromptInfo(
            clipboard.promptInfo || referenceGenSession.promptInfo
        );
        referenceGenSession.maskDataUrl = '';

        openReferenceGenLayer();
        const resizeText = fittedImage.resized
            ? ` (${fittedImage.sourceWidth}×${fittedImage.sourceHeight} → ${targetWidth}×${targetHeight} 비율 유지·중앙 조절)`
            : '';
        showReferenceGenToast(`클립보드 이미지를 참조 이미지로 가져왔습니다${resizeText}.`);
        return true;
    } catch (error) {
        alert(`참조 이미지 가져오기 실패: ${error.message || error}`);
        return false;
    }
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
    setReferenceGenPresetInfo(`선택 해상도: ${width} × ${height}`);
}

function getReferenceGenExpectedAnlasCost(width, height, steps = 28) {
    if (typeof window.getExpectedAnlasCost === 'function') {
        return window.getExpectedAnlasCost(width, height, steps);
    }

    const area = Math.max(0, Number(width) || 0) * Math.max(0, Number(height) || 0);
    if (area <= NAI_FREE_AREA_LIMIT && steps <= 28) return 0;
    return Math.max(2, Math.ceil((area * steps) / 1460000));
}

function setReferenceGenPresetInfo(message) {
    const info = el('referenceGenPresetInfo');
    if (info) info.innerText = message || '';
}

function getReferenceGenCanvasRatio() {
    const width = Math.max(1, Number(currentCanvasWidth) || 1);
    const height = Math.max(1, Number(currentCanvasHeight) || 1);
    return width / height;
}

function findReferenceGenCanvasRatioResolution(mode) {
    const targetRatio = getReferenceGenCanvasRatio();
    const maxArea = mode === 'paid' ? REFERENCE_GEN_HIGH_AREA_LIMIT : NAI_FREE_AREA_LIMIT;
    const minArea = mode === 'paid' ? NAI_FREE_AREA_LIMIT + 1 : 0;
    const ratioTolerance = mode === 'free' ? 0.02 : 0.000001;
    const candidates = [];

    for (let width = REFERENCE_GEN_RESOLUTION_STEP; width <= REFERENCE_GEN_MAX_SIDE; width += REFERENCE_GEN_RESOLUTION_STEP) {
        for (let height = REFERENCE_GEN_RESOLUTION_STEP; height <= REFERENCE_GEN_MAX_SIDE; height += REFERENCE_GEN_RESOLUTION_STEP) {
            const area = width * height;
            if (area > maxArea || area < minArea) continue;

            candidates.push({
                width,
                height,
                area,
                ratioError: Math.abs(Math.log((width / height) / targetRatio))
            });
        }
    }

    if (!candidates.length) return null;

    const bestRatioError = Math.min(...candidates.map((candidate) => candidate.ratioError));
    return candidates
        .filter((candidate) => candidate.ratioError <= bestRatioError + ratioTolerance)
        .sort((a, b) => b.area - a.area)[0] || null;
}

function applyReferenceGenCanvasRatioPreset(mode) {
    if (!currentCanvasWidth || !currentCanvasHeight) {
        alert('먼저 캔버스를 생성해 주세요.');
        return;
    }

    const presetMode = mode === 'paid' ? 'paid' : 'free';
    const result = findReferenceGenCanvasRatioResolution(presetMode);

    if (!result) {
        setReferenceGenPresetInfo('현재 캔버스 비율에 맞는 해상도 후보를 찾지 못했습니다.');
        return;
    }

    applyReferenceGenPreset(result.width, result.height);

    const ratio = (result.width / result.height).toFixed(4);
    const canvasRatio = getReferenceGenCanvasRatio().toFixed(4);
    const cost = getReferenceGenExpectedAnlasCost(result.width, result.height, 28);
    const label = presetMode === 'paid' ? '고해상도' : '무료 최대';
    const costLabel = cost > 0 ? `예상 ${cost} Anlas` : 'Anlas 0';

    setReferenceGenPresetInfo(
        `${label}: ${result.width} × ${result.height} · ${costLabel} · 캔버스 비율 ${canvasRatio} / 선택 비율 ${ratio}`
    );
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
            detailSourceSrc: savedSrc,
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

    referenceGenZoom = 1;

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
    const wrap = el('referenceGenImageWrap');

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
    bindReferenceGenWheelZoom();

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

        overlay.addEventListener('contextmenu', openReferenceGenClipboardContextMenu);

        overlay.addEventListener('touchstart', startReferenceGenMaskPaint, { passive: false });
        overlay.addEventListener('touchmove', moveReferenceGenMaskPaint, { passive: false });
        overlay.addEventListener('touchend', stopReferenceGenMaskPaint, { passive: false });
    }

    if (wrap && wrap.dataset.referenceGenContextBound !== '1') {
        wrap.dataset.referenceGenContextBound = '1';
        wrap.addEventListener('contextmenu', openReferenceGenClipboardContextMenu);
    }
}

function syncReferenceGenOverlayDisplaySize() {
    applyReferenceGenZoom();
}

function getReferenceGenBaseDisplaySize() {
    const imageWidth = Math.max(1, Number(referenceGenSession?.width) || 1);
    const imageHeight = Math.max(1, Number(referenceGenSession?.height) || 1);
    const maxViewportWidth = Math.min(900, Math.max(320, window.innerWidth * 0.86));
    const maxViewportHeight = Math.min(Math.max(360, window.innerHeight * 0.72), 9000);
    const fitScale = Math.min(
        1,
        maxViewportWidth / imageWidth,
        maxViewportHeight / imageHeight
    );

    return {
        width: Math.max(1, Math.round(imageWidth * fitScale)),
        height: Math.max(1, Math.round(imageHeight * fitScale)),
        maxViewportWidth,
        maxViewportHeight
    };
}

function applyReferenceGenZoom() {
    const img = el('referenceGenImage');
    const overlay = el('referenceGenOverlay');
    const wrap = el('referenceGenImageWrap');

    if (!img || !overlay || !wrap || !referenceGenSession) return;

    const baseSize = getReferenceGenBaseDisplaySize();
    const displayWidth = Math.max(1, Math.round(baseSize.width * referenceGenZoom));
    const displayHeight = Math.max(1, Math.round(baseSize.height * referenceGenZoom));
    const viewportWidth = Math.min(displayWidth, baseSize.maxViewportWidth);
    const viewportHeight = Math.min(displayHeight, baseSize.maxViewportHeight);

    wrap.style.width = `${Math.max(1, Math.round(viewportWidth))}px`;
    wrap.style.height = `${Math.max(1, Math.round(viewportHeight))}px`;
    wrap.style.maxWidth = 'min(900px, 86vw)';
    wrap.style.maxHeight = '72vh';
    wrap.style.overflow = 'auto';

    img.style.width = `${displayWidth}px`;
    img.style.height = `${displayHeight}px`;
    img.style.maxWidth = 'none';
    img.style.maxHeight = 'none';

    overlay.style.width = `${displayWidth}px`;
    overlay.style.height = `${displayHeight}px`;
}

function bindReferenceGenWheelZoom() {
    const wrap = el('referenceGenImageWrap');
    if (!wrap || wrap.dataset.referenceGenZoomWheelBound === '1') return;

    wrap.dataset.referenceGenZoomWheelBound = '1';
    wrap.addEventListener('wheel', handleReferenceGenWheelZoom, { passive: false });
}

function handleReferenceGenWheelZoom(event) {
    const wrap = el('referenceGenImageWrap');
    if (!wrap || !referenceGenSession) return;

    event.preventDefault();
    event.stopPropagation();

    const rect = wrap.getBoundingClientRect();
    const pointerX = event.clientX - rect.left + wrap.scrollLeft;
    const pointerY = event.clientY - rect.top + wrap.scrollTop;
    const oldZoom = referenceGenZoom;

    referenceGenZoom = clampZoom(
        referenceGenZoom * getWheelZoomFactor(event),
        REFERENCE_GEN_ZOOM_MIN,
        REFERENCE_GEN_ZOOM_MAX
    );

    if (referenceGenZoom === oldZoom) return;

    const ratio = referenceGenZoom / oldZoom;
    applyReferenceGenZoom();

    requestAnimationFrame(() => {
        wrap.scrollLeft = pointerX * ratio - (event.clientX - rect.left);
        wrap.scrollTop = pointerY * ratio - (event.clientY - rect.top);
        updateReferenceGenBrushCursor(referenceGenLastPointerEvent);
    });
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
    if (Number.isInteger(event?.button) && event.button !== 0) return;

    event.preventDefault();
    event.stopPropagation();

    referenceGenPainting = true;

    const point = getReferenceGenPointer(event);
    referenceGenLastPoint = point;

    drawReferenceGenMaskPoint(point);
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
}

function stopReferenceGenMaskPaint(event) {
    if (!referenceGenPainting) {
        return;
    }

    if (event) {
        event.preventDefault?.();
        event.stopPropagation?.();
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
    drawReferenceGenMaskOverlayPoint(point);
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
    drawReferenceGenMaskOverlayLine(from, to);
}

function clearReferenceGenOverlayPath(ctx, drawPath) {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(0, 0, 0, 1)';
    ctx.strokeStyle = 'rgba(0, 0, 0, 1)';
    drawPath(ctx);
    ctx.restore();
}

function redrawReferenceGenMaskOverlay() {
    const overlay = el('referenceGenOverlay');

    if (!overlay || !referenceGenMaskCanvas) return;

    const ctx = overlay.getContext('2d');

    ctx.clearRect(0, 0, overlay.width, overlay.height);

    // 갤러리 인페인팅과 같은 방식:
    // 실제 마스크는 불투명, 화면 표시만 반투명.
    ctx.save();
    ctx.globalAlpha = REFERENCE_GEN_MASK_OVERLAY_ALPHA;
    ctx.drawImage(referenceGenMaskCanvas, 0, 0, overlay.width, overlay.height);
    ctx.restore();

    applyReferenceGenMaskVisibility();
}

function drawReferenceGenMaskOverlayPoint(point) {
    const overlay = el('referenceGenOverlay');
    if (!overlay) return;

    const ctx = overlay.getContext('2d');
    const drawPath = (targetCtx) => {
        targetCtx.beginPath();
        targetCtx.arc(point.x, point.y, referenceGenBrushSize / 2, 0, Math.PI * 2);
        targetCtx.fill();
    };

    if (referenceGenTool === 'eraser') {
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.globalAlpha = 1;
        ctx.fillStyle = 'rgba(0, 0, 0, 1)';
        drawPath(ctx);
        ctx.restore();
    } else {
        clearReferenceGenOverlayPath(ctx, drawPath);
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = REFERENCE_GEN_MASK_OVERLAY_ALPHA;
        ctx.fillStyle = 'rgba(0, 210, 255, 1)';
        drawPath(ctx);
        ctx.restore();
    }

    applyReferenceGenMaskVisibility();
}

function drawReferenceGenMaskOverlayLine(from, to) {
    const overlay = el('referenceGenOverlay');
    if (!overlay) return;

    const ctx = overlay.getContext('2d');
    const drawPath = (targetCtx) => {
        targetCtx.lineWidth = referenceGenBrushSize;
        targetCtx.lineCap = 'round';
        targetCtx.lineJoin = 'round';
        targetCtx.beginPath();
        targetCtx.moveTo(from.x, from.y);
        targetCtx.lineTo(to.x, to.y);
        targetCtx.stroke();
    };

    if (referenceGenTool === 'eraser') {
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(0, 0, 0, 1)';
        drawPath(ctx);
        ctx.restore();
    } else {
        clearReferenceGenOverlayPath(ctx, drawPath);
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = REFERENCE_GEN_MASK_OVERLAY_ALPHA;
        ctx.strokeStyle = 'rgba(0, 210, 255, 1)';
        drawPath(ctx);
        ctx.restore();
    }

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
    return !getReferenceGenMaskBounds();
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
    setGenerationSettings('referenceGen', p);

    const baseInput = el('referenceGenBasePrompt');
    const negativeInput = el('referenceGenNegativePrompt');
    const cfgInput = el('referenceGenCfg');
    const seedInput = el('referenceGenSeed');
    const strengthInput = el('referenceGenStrength');
    const noiseInput = el('referenceGenNoise');

    if (baseInput) baseInput.value = p.basePrompt || '';
    if (negativeInput) negativeInput.value = p.negativePrompt || '';
    if (cfgInput) cfgInput.value = p.cfg || p.scale || 6;
    if (seedInput) seedInput.value = p.seed ?? -1;
    if (strengthInput) strengthInput.value = p.strength ?? 0.65;
    if (noiseInput) noiseInput.value = p.noise ?? 0.2;

    const charPrompts = normalizeReferenceGenCharPromptList(p);
    setReferenceGenCharPromptValues(charPrompts);
    if (typeof renderReferenceStylePromptPreview === 'function') renderReferenceStylePromptPreview();
}

function saveReferenceGenPrompt() {
    if (!referenceGenSession) {
        closeReferenceGenPrompt();
        return;
    }

    const promptInfo = buildReferenceGenPromptInfoFromInputs();
    if (!promptInfo) return;
    referenceGenSession.promptInfo = promptInfo;
    closeReferenceGenPrompt();
    showReferenceGenToast('참조 이미지 프롬프트를 저장했습니다.');
}

function buildReferenceGenPromptInfoFromInputs() {
    const settings = readGenerationSettings('referenceGen');
    if (!settings) return null;
    const charPrompts = getReferenceGenCharPromptValues();

    return normalizeReferenceGenPromptInfo({
        basePrompt: el('referenceGenBasePrompt')?.value || '',
        charPrompt: charPrompts.join(', '),
        charPrompts,
        negativePrompt: el('referenceGenNegativePrompt')?.value || '',
        ...settings
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
        <textarea data-prompt-autocomplete rows="4" id="referenceGenCharPromptInput-${id}"></textarea>
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

    const requestSteps = parseInt(referenceGenSession.promptInfo.steps || 28, 10) || 28;

    const canUseAnlas = await showAnlasWarningModal({
        width: referenceGenSession.width,
        height: referenceGenSession.height,
        steps: requestSteps,
        title: '참조 이미지 인페인팅 Anlas 사용 경고',
        detail: '현재 참조 이미지 인페인팅 요청은 무료 범위를 벗어나 Anlas가 소모될 수 있습니다.'
    });

    if (!canUseAnlas) return;

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
        if (data.promptInfo) {
            referenceGenSession.promptInfo = normalizeReferenceGenPromptInfo(data.promptInfo);
        }

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

const REFERENCE_GEN_DETAIL_OPTIONS = [
    { strength: 'gpt-prompt', label: 'GPT 원본 유지', hint: '현재 그림의 눈색·화풍 유지' },
    { strength: 'gpt-reference-prompt', label: 'GPT + 참조 이미지', hint: '2번째 그림의 캐릭터·눈동자 참조' }
];

function getReferenceGenMaskBounds() {
    if (!referenceGenMaskCanvas) return null;

    const sourceWidth = Math.max(1, referenceGenMaskCanvas.width);
    const sourceHeight = Math.max(1, referenceGenMaskCanvas.height);
    const probeScale = Math.min(1, 512 / Math.max(sourceWidth, sourceHeight));
    const probeWidth = Math.max(1, Math.round(sourceWidth * probeScale));
    const probeHeight = Math.max(1, Math.round(sourceHeight * probeScale));
    const probeCanvas = document.createElement('canvas');
    probeCanvas.width = probeWidth;
    probeCanvas.height = probeHeight;

    const probeCtx = probeCanvas.getContext('2d', { willReadFrequently: true });
    probeCtx.drawImage(referenceGenMaskCanvas, 0, 0, probeWidth, probeHeight);
    const data = probeCtx.getImageData(0, 0, probeWidth, probeHeight).data;
    let minX = probeWidth;
    let minY = probeHeight;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < probeHeight; y += 1) {
        for (let x = 0; x < probeWidth; x += 1) {
            if (data[(y * probeWidth + x) * 4 + 3] <= 8) continue;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        }
    }

    if (maxX < minX || maxY < minY) return null;

    return {
        left: Math.max(0, Math.floor(minX * sourceWidth / probeWidth)),
        top: Math.max(0, Math.floor(minY * sourceHeight / probeHeight)),
        right: Math.min(sourceWidth, Math.ceil((maxX + 1) * sourceWidth / probeWidth)),
        bottom: Math.min(sourceHeight, Math.ceil((maxY + 1) * sourceHeight / probeHeight))
    };
}

function formatCanvasAspectRatio(width, height) {
    let a = Math.max(1, Math.round(Number(width) || 1));
    let b = Math.max(1, Math.round(Number(height) || 1));
    const originalWidth = a;
    const originalHeight = b;

    while (b) {
        const remainder = a % b;
        a = b;
        b = remainder;
    }

    const divisor = Math.max(1, a);
    return `${originalWidth / divisor}:${originalHeight / divisor}`;
}

function buildGptDetailPrompt(mode, bounds = null, useCharacterReference = false) {
    const width = Math.max(1, Math.round(Number(referenceGenSession?.width) || 1));
    const height = Math.max(1, Math.round(Number(referenceGenSession?.height) || 1));
    const aspectRatio = formatCanvasAspectRatio(width, height);
    const detailMode = mode === 'eye' ? 'eye' : 'face';
    const subject = detailMode === 'eye' ? 'the eye and iris geometry' : 'the face and eye details';
    let targetInstruction = detailMode === 'eye'
        ? 'Target all visible eyes and irises in the first image. Do not modify the rest of the face or image.'
        : 'Target the entire visible face and its eyes in the first image. Do not modify hair, body, clothing, background, or composition.';

    if (bounds) {
        const boxWidth = Math.max(1, bounds.right - bounds.left);
        const boxHeight = Math.max(1, bounds.bottom - bounds.top);
        const leftPercent = (bounds.left / width * 100).toFixed(2);
        const topPercent = (bounds.top / height * 100).toFixed(2);
        const rightPercent = (bounds.right / width * 100).toFixed(2);
        const bottomPercent = (bounds.bottom / height * 100).toFixed(2);
        targetInstruction = `Target: ${subject} inside x=${bounds.left}..${bounds.right}, y=${bounds.top}..${bounds.bottom} (box ${boxWidth} x ${boxHeight}; ${leftPercent}%..${rightPercent}% from the left, ${topPercent}%..${bottomPercent}% from the top).`;
    }

    const redrawInstruction = detailMode === 'eye'
        ? 'Redraw only malformed eyelid, iris, pupil, eyelash, and highlight lines in the target. Make every curve smooth, clean, attractive, and coherent.'
        : 'Refine only malformed facial and eye lines in the target. Preserve the same expression, proportions, skin tone, and pose.';
    const colorInstruction = useCharacterReference
        ? 'The second attached image is the character reference. Match the character identity and drawing style from it. Change the iris color, iris pattern, pupil appearance, and catchlight design in the first image to match the second image. Changes to iris color and internal eye design are explicitly allowed, but do not recolor skin, hair, clothing, background, or lighting.'
        : 'Preserve the original character identity and original iris color from the first image. Do not borrow colors or identity from any other image.';
    const outsideTarget = bounds
        ? 'Outside the target box, preserve the source pixels, composition, and linework exactly.'
        : detailMode === 'eye'
            ? 'Outside the visible eye and iris regions, preserve the source pixels, face, composition, and linework exactly.'
            : 'Outside the visible face and eye regions, preserve the source pixels, composition, and linework exactly.';

    return [
        'Edit the first attached anime/illustration image with strict local changes only.',
        `The source canvas is ${width} x ${height} pixels with a ${aspectRatio} aspect ratio.`,
        targetInstruction,
        redrawInstruction,
        colorInstruction,
        `Request an output of exactly ${width} x ${height} pixels and preserve the ${aspectRatio} aspect ratio exactly. If that exact pixel size is unavailable, use the nearest supported resolution with the same ${aspectRatio} aspect ratio. Do not crop, rotate, or reframe it.`,
        `${outsideTarget} Keep the top, bottom, left, and right surrounding regions unchanged so the result can be placed directly over the original image.`,
        'Do not change the overall palette, skin tone, brightness, contrast, saturation, color temperature, lighting, pose, expression, line weight, or rendering style.',
        'Do not apply a global redraw, global denoise, global sharpening, relighting, or style transfer.',
        'Blend the repaired lines naturally at the target boundary without a rectangular seam, halo, blur, darkening, or color shift.',
        useCharacterReference
            ? 'Use the second image only as the character and eye reference. Keep the first image as the exact layout, pose, composition, and pixel-alignment source.'
            : 'Use only the first image as the visual source.',
        'Return one edited image only.'
    ].join('\n');
}

function openGptDetailPrompt(mode = 'eye', useCharacterReference = false) {
    if (!referenceGenSession) {
        alert('참조 이미지 세션이 없습니다.');
        return;
    }

    const bounds = getReferenceGenMaskBounds();
    const detailMode = mode === 'eye' ? 'eye' : 'face';
    const promptText = el('gptDetailPromptText');
    const meta = el('gptDetailPromptMeta');
    const layer = el('gptDetailPromptLayer');

    if (promptText) {
        promptText.value = buildGptDetailPrompt(detailMode, bounds, useCharacterReference);
    }
    if (meta) {
        const targetText = bounds
            ? `x ${bounds.left}-${bounds.right}, y ${bounds.top}-${bounds.bottom}`
            : `${detailMode === 'eye' ? '눈 전체' : '얼굴 전체'} 자동`;
        const referenceText = useCharacterReference ? ' · 2번째 그림 참조' : '';
        meta.innerText = `${referenceGenSession.width} × ${referenceGenSession.height}px · ${targetText}${referenceText}`;
    }
    if (layer) layer.style.display = 'flex';
}

function closeGptDetailPrompt() {
    const layer = el('gptDetailPromptLayer');
    if (layer) layer.style.display = 'none';
}

async function copyGptDetailPrompt() {
    const promptText = el('gptDetailPromptText');
    const value = String(promptText?.value || '').trim();
    if (!value) return;

    try {
        await navigator.clipboard.writeText(value);
    } catch (error) {
        promptText.focus();
        promptText.select();
        if (!document.execCommand('copy')) {
            alert('프롬프트를 복사할 수 없습니다. 텍스트를 직접 선택해 주세요.');
            return;
        }
    }

    showReferenceGenToast('ChatGPT용 프롬프트를 복사했습니다.');
}

function getReferenceGenDetailChoiceMenu() {
    let menu = el('referenceGenDetailChoiceMenu');
    if (menu) return menu;

    menu = document.createElement('div');
    menu.id = 'referenceGenDetailChoiceMenu';
    menu.style.cssText = `
        position: fixed;
        display: none;
        min-width: 170px;
        padding: 6px;
        border: 1px solid var(--border-color);
        border-radius: 8px;
        background: var(--card-bg, #181824);
        color: var(--text-main, #f5f5f7);
        box-shadow: 0 16px 42px rgba(0, 0, 0, 0.42);
        z-index: 99999;
    `;
    document.body.appendChild(menu);
    return menu;
}

function closeReferenceGenDetailChoice() {
    const menu = el('referenceGenDetailChoiceMenu');
    if (menu) menu.style.display = 'none';
}

function toggleReferenceGenDetailChoice(mode = 'face', anchor = null) {
    const detailMode = mode === 'eye' ? 'eye' : 'face';
    const menu = getReferenceGenDetailChoiceMenu();

    if (menu.style.display === 'block' && menu.dataset.mode === detailMode) {
        closeReferenceGenDetailChoice();
        return;
    }

    menu.dataset.mode = detailMode;
    menu.innerHTML = '';

    REFERENCE_GEN_DETAIL_OPTIONS.forEach((option) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.referenceGenDetailChoiceItem = option.strength;
        button.style.cssText = `
            width: 100%;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            padding: 9px 10px;
            border: 0;
            border-radius: 6px;
            background: transparent;
            color: var(--text-main, #f5f5f7);
            font-size: 13px;
            font-weight: 800;
            cursor: pointer;
            text-align: left;
        `;
        button.innerHTML = `<span>${option.label}</span><span style="font-size:11px; color:var(--text-muted, #a7a7b5); font-weight:700;">${option.hint}</span>`;
        button.onmouseenter = () => {
            button.style.background = 'rgba(255, 255, 255, 0.10)';
        };
        button.onmouseleave = () => {
            button.style.background = 'transparent';
        };
        button.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            closeReferenceGenDetailChoice();
            openGptDetailPrompt(detailMode, option.strength === 'gpt-reference-prompt');
        };
        menu.appendChild(button);
    });

    const rect = anchor?.getBoundingClientRect?.() || { left: 16, bottom: 16 };
    const margin = 10;
    menu.style.display = 'block';

    const width = menu.offsetWidth || 170;
    const height = menu.offsetHeight || 120;
    const left = Math.min(Math.max(margin, rect.left), window.innerWidth - width - margin);
    const top = Math.min(Math.max(margin, rect.bottom + 6), window.innerHeight - height - margin);

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
}

function getReferenceGenExportCoverSize(width = null, height = null) {
    const imageWidth = Math.max(1, Number(width || referenceGenSession?.width) || 1);
    const imageHeight = Math.max(1, Number(height || referenceGenSession?.height) || 1);

    if (!currentCanvasWidth || !currentCanvasHeight) {
        return {
            width: imageWidth,
            height: imageHeight
        };
    }

    const scale = Math.max(
        currentCanvasWidth / imageWidth,
        currentCanvasHeight / imageHeight
    );

    return {
        width: Math.max(1, Math.round(imageWidth * scale)),
        height: Math.max(1, Math.round(imageHeight * scale))
    };
}

function getReferenceGenSourceLayer() {
    if (!referenceGenSession?.sourceLayerId) return null;
    return findCanvasLayer(referenceGenSession.sourceLayerId)?.layer || null;
}

function isReferenceGenSourceClipSession() {
    const sourceLayer = getReferenceGenSourceLayer();
    return Boolean(referenceGenSession?.sourceLayerType === 'clip' && sourceLayer?.type === 'clip' && sourceLayer.src);
}

function getReferenceGenDefaultUpscaleSize() {
    if (isReferenceGenSourceClipSession()) {
        return {
            width: Math.max(1, Math.round(Number(referenceGenSession?.width) || 1)),
            height: Math.max(1, Math.round(Number(referenceGenSession?.height) || 1))
        };
    }

    return getReferenceGenExportCoverSize();
}

function getReferenceGenUpscaleInputSize() {
    const width = Math.max(64, Math.min(20000, parseInt(el('referenceGenUpscaleWidthInput')?.value, 10) || 2500));
    const height = Math.max(64, Math.min(20000, parseInt(el('referenceGenUpscaleHeightInput')?.value, 10) || 8000));

    return { width, height };
}

function getSelectedReferenceGenUpscaleQuality() {
    return document.querySelector('input[name="referenceGenUpscaleQuality"]:checked')?.value || 'standard';
}

function applyReferenceGenUpscalePreset(width, height) {
    const widthInput = el('referenceGenUpscaleWidthInput');
    const heightInput = el('referenceGenUpscaleHeightInput');

    if (widthInput) widthInput.value = Math.max(64, Math.min(20000, Math.round(Number(width) || 2500)));
    if (heightInput) heightInput.value = Math.max(64, Math.min(20000, Math.round(Number(height) || 8000)));

    referenceGenUpscaleLastEditedAxis = 'width';
    updateReferenceGenUpscaleInfo();
}

function applyReferenceGenUpscaleExportSizePreset() {
    const size = getReferenceGenDefaultUpscaleSize();
    applyReferenceGenUpscalePreset(size.width, size.height);
}

function applyReferenceGenUpscaleMultiplierPreset(multiplier) {
    if (!referenceGenSession) return;

    const scale = Math.max(1, Number(multiplier) || 1);
    applyReferenceGenUpscalePreset(
        Math.round(referenceGenSession.width * scale),
        Math.round(referenceGenSession.height * scale)
    );
}

function handleReferenceGenUpscaleWidthInput() {
    referenceGenUpscaleLastEditedAxis = 'width';

    if (el('referenceGenUpscaleRatioLock')?.checked && referenceGenSession?.width && referenceGenSession?.height) {
        const width = parseInt(el('referenceGenUpscaleWidthInput')?.value, 10) || 2500;
        const ratio = referenceGenSession.height / Math.max(1, referenceGenSession.width);
        const heightInput = el('referenceGenUpscaleHeightInput');
        if (heightInput) heightInput.value = Math.round(width * ratio);
    }

    updateReferenceGenUpscaleInfo();
}

function handleReferenceGenUpscaleHeightInput() {
    referenceGenUpscaleLastEditedAxis = 'height';

    if (el('referenceGenUpscaleRatioLock')?.checked && referenceGenSession?.width && referenceGenSession?.height) {
        const height = parseInt(el('referenceGenUpscaleHeightInput')?.value, 10) || 8000;
        const ratio = referenceGenSession.width / Math.max(1, referenceGenSession.height);
        const widthInput = el('referenceGenUpscaleWidthInput');
        if (widthInput) widthInput.value = Math.round(height * ratio);
    }

    updateReferenceGenUpscaleInfo();
}

function updateReferenceGenUpscaleInfo() {
    const fit = Boolean(el('referenceGenUpscaleFit516')?.checked);
    const info = el('referenceGenUpscaleInfo');
    if (!info) return;

    const size = getReferenceGenUpscaleInputSize();
    const mp = (size.width * size.height / 1000000).toFixed(1);
    if (fit) {
        const unit = Math.floor(Math.min(size.width / 5, size.height / 16));
        info.innerText = `${size.width} × ${size.height}px로 확대 → 중앙 자르기 ${unit * 5} × ${unit * 16}px (5:16)`;
        return;
    }

    if (!referenceGenSession?.width || !referenceGenSession?.height) {
        info.innerText = `목표 해상도 ${size.width} × ${size.height}px · 약 ${mp}MP`;
        return;
    }

    const sx = size.width / Math.max(1, referenceGenSession.width);
    const sy = size.height / Math.max(1, referenceGenSession.height);

    info.innerText = `목표 해상도 ${size.width} × ${size.height}px · 약 ${mp}MP · 원본 대비 ${sx.toFixed(2)}x / ${sy.toFixed(2)}x`;
}

function openReferenceGenUpscaleExportModal() {
    if (!referenceGenSession || !referenceGenSession.currentSrc) {
        alert('업스케일링할 참조 이미지가 없습니다.');
        return;
    }

    if (!currentCanvasWidth || !currentCanvasHeight) {
        alert('먼저 캔버스를 생성해 주세요.');
        return;
    }

    const meta = el('referenceGenUpscaleMeta');
    if (meta) {
        const exportSize = getReferenceGenDefaultUpscaleSize();
        meta.innerText = `원본 ${referenceGenSession.width} × ${referenceGenSession.height}px · 내보내기 기준 ${exportSize.width} × ${exportSize.height}px`;
    }

    applyReferenceGenUpscaleMultiplierPreset(2);

    const layer = el('referenceGenUpscaleLayer');
    if (layer) layer.style.display = 'flex';
    referenceGenUpscaleModelPanel?.open();
}

function closeReferenceGenUpscaleExportModal() {
    const layer = el('referenceGenUpscaleLayer');
    if (layer) layer.style.display = 'none';
    referenceGenUpscaleModelPanel?.close();
}

async function startReferenceGenUpscaleExport() {
    if (!referenceGenSession || !referenceGenSession.currentSrc) {
        alert('업스케일링할 참조 이미지가 없습니다.');
        return;
    }

    if (!currentCanvasWidth || !currentCanvasHeight) {
        alert('먼저 캔버스를 생성해 주세요.');
        return;
    }

    if (referenceGenUpscaleStartPending) return;
    referenceGenUpscaleStartPending = true;

    const session = referenceGenSession;
    const source = session.currentSrc;
    let processing = false;
    try {
        let prepared = null;
        if (referenceGenUpscaleModelPanel) {
            prepared = await referenceGenUpscaleModelPanel.prepare();
            const layer = el('referenceGenUpscaleLayer');
            if (
                !prepared
                || referenceGenSession !== session
                || session.currentSrc !== source
                || layer?.style.display !== 'flex'
            ) return;
        }

        const size = prepared
            ? {width: prepared.target_width, height: prepared.target_height}
            : getReferenceGenUpscaleInputSize();
        const engine = prepared?.engine || el('referenceGenUpscaleEngine')?.value || 'realcugan';
        const quality = prepared?.quality || getSelectedReferenceGenUpscaleQuality();

        if (size.width * size.height > 130000000) {
            alert('목표 해상도가 너무 큽니다. 130MP 이하로 설정해 주세요.');
            return;
        }

        const tempCategory = isReferenceGenSourceClipSession() ? 'canvas_inpaint' : 'canvas';
        closeReferenceGenUpscaleExportModal();
        setReferenceGenProcessing(true, '참조 이미지 업스케일링 처리 중...');
        processing = true;

        const response = await fetch('/api/canvas/reference_upscale', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                image: source,
                target_width: size.width,
                target_height: size.height,
                engine,
                quality,
                ...(engine !== 'nai' && el('referenceGenUpscaleFit516')?.checked ? {fit_5_16: true} : {}),
                ...(prepared?.nai_confirmed ? {nai_confirmed: true} : {}),
                tempCategory,
                sessionId: CANVAS_IMPORT_SESSION_ID
            })
        });

        const data = await response.json();

        if (!response.ok || data.status !== 'success') {
            throw new Error(data.message || '참조 이미지 업스케일링 실패');
        }

        if (referenceGenSession !== session || session.currentSrc !== source) return;

        await addReferenceGenResultToCanvas({
            src: data.src,
            name: `참조 이미지 업스케일 ${data.width || size.width}×${data.height || size.height}`,
            promptInfo: session.promptInfo,
            width: data.width || size.width,
            height: data.height || size.height
        });

        if (referenceGenSession === session && session.currentSrc === source) {
            closeReferenceGen();
            showReferenceGenToast('업스케일링한 참조 이미지를 내보냈습니다.');
        }
    } catch (error) {
        if (referenceGenSession === session && session.currentSrc === source) {
            alert(`업스케일링 내보내기 실패: ${error.message || error}`);
        }
    } finally {
        if (processing) setReferenceGenProcessing(false);
        referenceGenUpscaleStartPending = false;
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
        const clipSession = isReferenceGenSourceClipSession();

        await addReferenceGenResultToCanvas({
            src: referenceGenSession.currentSrc,
            name: `참조 이미지 ${referenceGenSession.width}×${referenceGenSession.height}`,
            promptInfo: referenceGenSession.promptInfo,
            width: referenceGenSession.width,
            height: referenceGenSession.height
        });

        closeReferenceGen();
        showReferenceGenToast(
            clipSession
                ? '디테일 결과를 선택 영역 클립으로 내보냈습니다.'
                : '참조 이미지를 비율 유지·중앙 맞춤으로 내보냈습니다.'
        );

    } catch (error) {
        alert(`내보내기 실패: ${error.message || error}`);
    }
}

async function addReferenceGenImageLayerFitCanvas(options) {
    const { src, name, promptInfo } = options || {};
    const info = await loadImageInfo(src);

    const imageWidth = info.width || referenceGenSession?.width || 512;
    const imageHeight = info.height || referenceGenSession?.height || 1664;

    const geometry = getInitialImageLayerGeometry(imageWidth, imageHeight, {
        allowUpscale: true
    });

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
        x: geometry.x,
        y: geometry.y,
        layerWidth: geometry.width,
        layerHeight: geometry.height
    };

    canvasLayers.unshift(layer);
    activeLayerId = layer.id;

    selectedLayerIds.clear();
    selectedLayerIds.add(Number(layer.id));

    renderCanvas(currentCanvasWidth, currentCanvasHeight);
    renderLayerList();
    saveCanvasState();
}

async function addReferenceGenResultToCanvas({ src, name, promptInfo, width, height }) {
    if (isReferenceGenSourceClipSession()) {
        return addReferenceGenClipToSourceSelection({ src, name, promptInfo, width, height });
    }

    return addReferenceGenImageLayerFitCanvas({ src, name, promptInfo });
}

async function addReferenceGenClipToSourceSelection({ src, name, promptInfo, width, height }) {
    const sourceClip = getReferenceGenSourceLayer();
    const selection = findSelectionParentForLayerId(sourceClip?.id);

    if (!sourceClip || sourceClip.type !== 'clip' || !selection) {
        return addReferenceGenImageLayerFitCanvas({ src, name, promptInfo });
    }

    const inpaintFolder = getOrCreateSelectionInpaintFolder(selection);
    const imageWidth = Math.max(1, Math.round(Number(width || sourceClip.imageWidth || sourceClip.layerWidth || 1)));
    const imageHeight = Math.max(1, Math.round(Number(height || sourceClip.imageHeight || sourceClip.layerHeight || 1)));

    const resultClip = {
        id: layerIdSeq++,
        name: name || `업스케일 ${inpaintFolder.children.filter((child) => child.type === 'clip').length + 1}`,
        visible: true,
        type: 'clip',
        renderOnCanvas: true,
        src: withCacheBuster(src),
        sourceSelectionId: selection.id,
        sourcePath: sourceClip.sourcePath || '',
        promptOwnerId: sourceClip.promptOwnerId || sourceClip.id,
        promptInfo: normalizePromptInfoForReferenceGenExport(promptInfo || sourceClip.promptInfo || {}),
        promptControlGroups: Array.isArray(sourceClip.promptControlGroups)
            ? structuredClone(sourceClip.promptControlGroups)
            : [],
        imageWidth,
        imageHeight,
        x: sourceClip.x ?? selection.x,
        y: sourceClip.y ?? selection.y,
        sourceSelectionX: sourceClip.sourceSelectionX ?? sourceClip.x ?? selection.x,
        sourceSelectionY: sourceClip.sourceSelectionY ?? sourceClip.y ?? selection.y,
        layerWidth: sourceClip.layerWidth || sourceClip.imageWidth || selection.layerWidth,
        layerHeight: sourceClip.layerHeight || sourceClip.imageHeight || selection.layerHeight,
        createdAt: Date.now(),
        sourceReferenceGenClipId: sourceClip.id
    };

    inpaintFolder.children.unshift(resultClip);
    selection.expanded = true;

    clearClipMergedSourcePreviewCache();
    clipMergedSourcePreviewSeq += 1;
    migrateAllSelectionClipsToSharedPromptOwner(resultClip.id);

    activeLayerId = resultClip.id;
    activeClipSelectionId = selection.id;
    checkedSelectionId = selection.id;
    isClipInpaintPreviewMode = true;

    selectedLayerIds.clear();
    selectedLayerIds.add(Number(resultClip.id));

    renderLayerList();
    renderCanvasLayersOnSurface();
    renderClipOutputPanel();
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
