function normalizeCharPromptList(value) {
    if (Array.isArray(value)) {
        return value
            .map((item) => String(item || '').trim())
            .filter(Boolean);
    }

    if (value && typeof value === 'object') {
        const arrayValue =
            value.charPrompts ||
            value.char_prompts ||
            value.characterPrompts;

        if (Array.isArray(arrayValue)) {
            return arrayValue
                .map((item) => String(item || '').trim())
                .filter(Boolean);
        }

        const singleValue =
            value.charPrompt ||
            value.char_prompt ||
            value.characterPrompt ||
            '';

        if (String(singleValue || '').trim()) {
            return [String(singleValue).trim()];
        }

        return [];
    }

    const text = String(value || '').trim();
    return text ? [text] : [];
}

function buildLegacyCharPromptText(list) {
    return normalizeCharPromptList(list).join(', ');
}

function getGalleryInpaintCharPromptValues() {
    return [...document.querySelectorAll('#galleryInpaintCharPromptList textarea')]
        .map((textarea) => String(textarea.value || '').trim())
        .filter(Boolean);
}

function setGalleryInpaintCharPromptValues(values) {
    const container = document.getElementById('galleryInpaintCharPromptList');
    if (!container) return;

    const list = normalizeCharPromptList(values);
    container.innerHTML = '';

    if (!list.length) {
        addGalleryInpaintCharPromptEditor('');
        return;
    }

    list.forEach((value) => addGalleryInpaintCharPromptEditor(value));
}

function addGalleryInpaintCharPromptEditor(initialValue = '') {
    const container = document.getElementById('galleryInpaintCharPromptList');
    if (!container) return;

    const id = `gicp${galleryInpaintCharPromptSeq++}`;
    const index = container.querySelectorAll('.gallery-inpaint-char-prompt-item').length + 1;

    const item = document.createElement('div');
    item.className = 'gallery-inpaint-char-prompt-item';
    item.dataset.charPromptId = id;
    item.style.cssText = `
        border:1px solid #333;
        border-radius:10px;
        padding:10px;
        margin-bottom:10px;
        background:#0a0a10;
    `;

    const header = document.createElement('div');
    header.style.cssText = `
        display:flex;
        justify-content:space-between;
        align-items:center;
        gap:8px;
        margin-bottom:6px;
    `;

    const title = document.createElement('div');
    title.className = 'gallery-inpaint-char-prompt-title';
    title.style.cssText = 'font-size:12px; font-weight:900; color:#00f2ff;';
    title.innerText = `Character Prompt ${index}`;

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'gallery-inpaint-tool-btn danger';
    deleteBtn.style.cssText = 'padding:4px 8px; font-size:12px;';
    deleteBtn.innerText = '삭제';
    deleteBtn.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        removeGalleryInpaintCharPromptEditor(id);
    };

    const textarea = document.createElement('textarea'); textarea.setAttribute('data-prompt-autocomplete', '');
    textarea.id = `galleryInpaintCharPrompt-${id}`;
    textarea.rows = 4;
    textarea.value = initialValue || '';

    header.appendChild(title);
    header.appendChild(deleteBtn);
    item.appendChild(header);
    item.appendChild(textarea);
    container.appendChild(item);

    refreshGalleryInpaintCharPromptIndexes();
}

function removeGalleryInpaintCharPromptEditor(id) {
    const container = document.getElementById('galleryInpaintCharPromptList');
    if (!container) return;

    const item = container.querySelector(`.gallery-inpaint-char-prompt-item[data-char-prompt-id="${id}"]`);
    if (item) item.remove();

    if (!container.querySelector('.gallery-inpaint-char-prompt-item')) {
        addGalleryInpaintCharPromptEditor('');
        return;
    }

    refreshGalleryInpaintCharPromptIndexes();
}

function refreshGalleryInpaintCharPromptIndexes() {
    document.querySelectorAll('#galleryInpaintCharPromptList .gallery-inpaint-char-prompt-title')
        .forEach((title, index) => {
            title.innerText = `Character Prompt ${index + 1}`;
        });
}

function normalizeGalleryPromptInfo(data) {
    data = data || {};

    const rawCharPrompts =
        Array.isArray(data.charPrompts) && data.charPrompts.length
            ? data.charPrompts
            : Array.isArray(data.char_prompts) && data.char_prompts.length
                ? data.char_prompts
                : data.charPrompt || data.char_prompt || data.characterPrompt || '';

    const charPrompts = normalizeCharPromptList(rawCharPrompts);

    const baseCaption = String(
        data.baseCaption ||
        data.base_caption ||
        ''
    ).trim();

    const basePrompt = String(
        data.basePrompt ||
        data.prompt ||
        data.base_prompt ||
        baseCaption ||
        ''
    ).trim();

    return {
        basePrompt,
        baseCaption: baseCaption || basePrompt,
        charPrompts,
        charPrompt: buildLegacyCharPromptText(charPrompts),
        negativePrompt: data.negativePrompt || data.negative_prompt || data.uc || '',
        strength: Number(data.strength ?? 0.65),
        noise: Number(data.noise ?? 0.2),
        model: String(data.model || 'nai-diffusion-5-full'),
        cfg_rescale: Number(data.cfg_rescale === '' ? 0.4 : data.cfg_rescale ?? 0.4),
        noise_schedule: String(data.noise_schedule || 'native'),
        sampler: data.sampler || 'k_euler_ancestral',
        steps: Number(data.steps || 28),
        cfg: Number(data.cfg || data.scale || 6),
        seed: Number(data.seed ?? -1),
        logoRemoval: Boolean(data.logoRemoval || data.removeLogo || data.logo_removal)
    };
}

async function fetchPromptInfoForGalleryPath(path) {
    if (!path) return normalizeGalleryPromptInfo({});

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

        return normalizeGalleryPromptInfo(json.data || {});
    } catch (e) {
        console.warn('Prompt info load failed:', e);
        return normalizeGalleryPromptInfo({});
    }
}

let galleryInpaintContextOpenRequest = 0;

async function openGalleryInpaintFromContext() {
    const openRequest = ++galleryInpaintContextOpenRequest;
    const contextSource = activeImageContext;
    const context = contextSource ? {
        ...contextSource,
        projectContext: contextSource.projectContext ? {...contextSource.projectContext} : null
    } : null;
    closeImageContextMenu();

    if (!context || !context.imgSrc) {
        alert('인페인팅할 이미지가 없습니다.');
        return;
    }

    try {
        const img = await loadImageElement(context.imgSrc);
        if (openRequest !== galleryInpaintContextOpenRequest || activeImageContext !== contextSource) return;
        const promptInfo = await fetchPromptInfoForGalleryPath(context.path || '');
        if (openRequest !== galleryInpaintContextOpenRequest || activeImageContext !== contextSource) return;

        if (isGalleryInpaintProcessing) setGalleryInpaintProcessing(false);

        galleryInpaintSession = {
            originalPath: context.path || '',
            originalSrc: context.imgSrc,
            currentSrc: context.imgSrc,
            projectContext: context.projectContext,
            tempSessionId: createGalleryInpaintTempSessionId(),
            name: getImageFileName(context.path || context.imgSrc),
            imageWidth: img.naturalWidth || img.width,
            imageHeight: img.naturalHeight || img.height,
            promptInfo,
            resultSrc: '',
            maskDataUrl: '',
            saved: false
        };

        openGalleryInpaint();
    } catch (e) {
        if (openRequest === galleryInpaintContextOpenRequest && activeImageContext === contextSource) {
            alert(`인페인팅 창 열기 실패: ${e.message || e}`);
        }
    }
}

function createGalleryInpaintTempSessionId() {
    return `gallery_inpaint_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function cleanupGalleryInpaintTempSession(session) {
    const sessionId = session?.tempSessionId;
    if (!sessionId) return;

    try {
        await fetch('/api/canvas/cleanup_import_session', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                category: GALLERY_INPAINT_TEMP_CATEGORY,
                sessionId
            })
        });
    } catch (error) {
        console.warn('Gallery inpaint temp cleanup failed:', error);
    }
}

function openGalleryInpaint() {
    if (!galleryInpaintSession) return;

    const layer = document.getElementById('galleryInpaintLayer');
    const img = document.getElementById('galleryInpaintImage');
    const meta = document.getElementById('galleryInpaintMeta');

    layer.style.display = 'flex';
    img.src = galleryInpaintSession.currentSrc;
    meta.innerText = `${galleryInpaintSession.name} · ${galleryInpaintSession.imageWidth} × ${galleryInpaintSession.imageHeight}px`;

    const promptInfo = normalizeGalleryPromptInfo(galleryInpaintSession.promptInfo || {});
    galleryInpaintSession.promptInfo = promptInfo;

    const logoCheck = document.getElementById('galleryInpaintLogoRemovalCheck');
    if (logoCheck) {
        logoCheck.checked = Boolean(promptInfo.logoRemoval);
    }

    galleryInpaintMaskVisible = true;

    resetGalleryInpaintMask();
    bindGalleryInpaintEditor();
    applyGalleryInpaintMaskVisibility();
}

function closeGalleryInpaint() {
    if (
        galleryInpaintSession?.resultSrc &&
        !galleryInpaintSession.saved
    ) {
        const ok = confirm('저장하지 않은 인페인팅 결과가 있습니다. 닫으면 결과가 폐기됩니다. 닫을까요?');
        if (!ok) return;
    }

    const layer = document.getElementById('galleryInpaintLayer');
    if (layer) layer.style.display = 'none';

    hideGalleryInpaintBrushCursor();

    const sessionToCleanup = galleryInpaintSession;
    galleryInpaintSession = null;
    galleryInpaintMaskCanvas = null;
    galleryInpaintMaskCtx = null;
    galleryInpaintPainting = false;
    galleryInpaintLastPoint = null;
    cleanupGalleryInpaintTempSession(sessionToCleanup);
}

function resetGalleryInpaintMask() {
    if (!galleryInpaintSession) return;

    galleryInpaintMaskCanvas = document.createElement('canvas');
    galleryInpaintMaskCanvas.width = galleryInpaintSession.imageWidth;
    galleryInpaintMaskCanvas.height = galleryInpaintSession.imageHeight;
    galleryInpaintMaskCtx = galleryInpaintMaskCanvas.getContext('2d');
    galleryInpaintMaskCtx.clearRect(0, 0, galleryInpaintMaskCanvas.width, galleryInpaintMaskCanvas.height);

    galleryInpaintSession.maskDataUrl = '';
}

function bindGalleryInpaintEditor() {
    const wrap = document.getElementById('galleryInpaintImageWrap');
    const img = document.getElementById('galleryInpaintImage');
    const overlay = document.getElementById('galleryInpaintOverlay');

    if (!wrap || !img || !overlay || !galleryInpaintMaskCanvas) return;

    const syncOverlay = () => {
        const imgRect = img.getBoundingClientRect();
        const wrapRect = wrap.getBoundingClientRect();

        overlay.style.left = `${imgRect.left - wrapRect.left + wrap.scrollLeft}px`;
        overlay.style.top = `${imgRect.top - wrapRect.top + wrap.scrollTop}px`;
        overlay.style.width = `${imgRect.width}px`;
        overlay.style.height = `${imgRect.height}px`;

        overlay.width = galleryInpaintMaskCanvas.width;
        overlay.height = galleryInpaintMaskCanvas.height;

        redrawGalleryInpaintOverlay();
    };

    img.onload = syncOverlay;
    requestAnimationFrame(syncOverlay);
    window.addEventListener('resize', syncOverlay);

    overlay.onpointerdown = (event) => {
        event.preventDefault();
        event.stopPropagation();

        updateGalleryInpaintBrushCursor(event, overlay);

        galleryInpaintPainting = true;
        overlay.setPointerCapture(event.pointerId);

        galleryInpaintLastPoint = getGalleryInpaintPoint(event, overlay);
        drawGalleryInpaintPoint(galleryInpaintLastPoint.x, galleryInpaintLastPoint.y);
        redrawGalleryInpaintOverlay();
    };

    overlay.onpointermove = (event) => {
        updateGalleryInpaintBrushCursor(event, overlay);

        if (!galleryInpaintPainting) return;

        const point = getGalleryInpaintPoint(event, overlay);

        if (galleryInpaintLastPoint) {
            drawGalleryInpaintLine(galleryInpaintLastPoint, point);
        } else {
            drawGalleryInpaintPoint(point.x, point.y);
        }

        galleryInpaintLastPoint = point;
        redrawGalleryInpaintOverlay();
    };

    overlay.onmouseenter = (event) => {
        updateGalleryInpaintBrushCursor(event, overlay);
    };

    overlay.onmouseleave = () => {
        if (!galleryInpaintPainting) {
            hideGalleryInpaintBrushCursor();
        }
    };

    overlay.onpointerup = (event) => {
        galleryInpaintPainting = false;
        galleryInpaintLastPoint = null;
        try { overlay.releasePointerCapture(event.pointerId); } catch (e) {}

        galleryInpaintSession.maskDataUrl = galleryInpaintMaskCanvas.toDataURL('image/png');
    };

    overlay.onpointercancel = () => {
        galleryInpaintPainting = false;
        galleryInpaintLastPoint = null;
        galleryInpaintSession.maskDataUrl = galleryInpaintMaskCanvas.toDataURL('image/png');
        hideGalleryInpaintBrushCursor();
    };
}

function getGalleryInpaintPoint(event, overlay) {
    const rect = overlay.getBoundingClientRect();
    const scaleX = overlay.width / rect.width;
    const scaleY = overlay.height / rect.height;

    return {
        x: (event.clientX - rect.left) * scaleX,
        y: (event.clientY - rect.top) * scaleY
    };
}

function drawGalleryInpaintPoint(x, y) {
    if (!galleryInpaintMaskCtx) return;

    galleryInpaintMaskCtx.save();

    if (galleryInpaintTool === 'eraser') {
        galleryInpaintMaskCtx.globalCompositeOperation = 'destination-out';
        galleryInpaintMaskCtx.fillStyle = 'rgba(0,0,0,1)';
    } else {
        galleryInpaintMaskCtx.globalCompositeOperation = 'source-over';
        galleryInpaintMaskCtx.fillStyle = 'rgba(0, 128, 255, 1)';
    }

    galleryInpaintMaskCtx.beginPath();
    galleryInpaintMaskCtx.arc(x, y, galleryInpaintBrushSize / 2, 0, Math.PI * 2);
    galleryInpaintMaskCtx.fill();
    galleryInpaintMaskCtx.restore();
}

function drawGalleryInpaintLine(from, to) {
    if (!galleryInpaintMaskCtx) return;

    galleryInpaintMaskCtx.save();

    if (galleryInpaintTool === 'eraser') {
        galleryInpaintMaskCtx.globalCompositeOperation = 'destination-out';
        galleryInpaintMaskCtx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
        galleryInpaintMaskCtx.globalCompositeOperation = 'source-over';
        galleryInpaintMaskCtx.strokeStyle = 'rgba(0, 128, 255, 1)';
    }

    galleryInpaintMaskCtx.lineWidth = galleryInpaintBrushSize;
    galleryInpaintMaskCtx.lineCap = 'round';
    galleryInpaintMaskCtx.lineJoin = 'round';
    galleryInpaintMaskCtx.beginPath();
    galleryInpaintMaskCtx.moveTo(from.x, from.y);
    galleryInpaintMaskCtx.lineTo(to.x, to.y);
    galleryInpaintMaskCtx.stroke();
    galleryInpaintMaskCtx.restore();
}

function updateGalleryInpaintBrushCursor(event, overlay) {
    if (!galleryInpaintMaskVisible) {
        hideGalleryInpaintBrushCursor();
        return;
    }
    galleryInpaintLastPointerEvent = event;
    const cursor = document.getElementById('galleryInpaintBrushCursor');
    if (!cursor || !overlay) return;

    const rect = overlay.getBoundingClientRect();

    if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
    ) {
        cursor.style.display = 'none';
        return;
    }

    const displayScale = rect.width / Math.max(1, overlay.width);
    const displaySize = Math.max(4, galleryInpaintBrushSize * displayScale);

    cursor.style.display = 'block';
    cursor.style.width = `${displaySize}px`;
    cursor.style.height = `${displaySize}px`;
    cursor.style.left = `${event.clientX}px`;
    cursor.style.top = `${event.clientY}px`;
    cursor.classList.toggle('eraser', galleryInpaintTool === 'eraser');
}

function hideGalleryInpaintBrushCursor() {
    const cursor = document.getElementById('galleryInpaintBrushCursor');
    if (cursor) cursor.style.display = 'none';
}

function redrawGalleryInpaintOverlay() {
    const overlay = document.getElementById('galleryInpaintOverlay');
    if (!overlay || !galleryInpaintMaskCanvas) return;

    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    ctx.globalAlpha = 0.45;
    ctx.drawImage(galleryInpaintMaskCanvas, 0, 0);
    ctx.globalAlpha = 1;

    applyGalleryInpaintMaskVisibility();
}

function toggleGalleryInpaintMaskVisible() {
    galleryInpaintMaskVisible = !galleryInpaintMaskVisible;
    applyGalleryInpaintMaskVisibility();
}

function applyGalleryInpaintMaskVisibility() {
    const overlay = document.getElementById('galleryInpaintOverlay');
    const btn = document.getElementById('galleryInpaintMaskToggleBtn');
    const cursor = document.getElementById('galleryInpaintBrushCursor');

    if (overlay) {
        overlay.style.opacity = galleryInpaintMaskVisible ? '1' : '0';
    }

    if (cursor) {
        cursor.style.display = galleryInpaintMaskVisible ? cursor.style.display : 'none';
    }

    if (btn) {
        btn.innerText = galleryInpaintMaskVisible ? '선택범위 숨김' : '선택범위 표시';
        btn.classList.toggle('active', !galleryInpaintMaskVisible);
    }
}

function setGalleryInpaintTool(tool, button) {
    galleryInpaintTool = tool === 'eraser' ? 'eraser' : 'brush';

    document.querySelectorAll('.gallery-inpaint-tool-btn').forEach(btn => {
        btn.classList.remove('active');
    });

    document.querySelectorAll('.gallery-inpaint-tool-wrap').forEach(wrap => {
        wrap.classList.remove('open');
    });

    if (button) {
        button.classList.add('active');
        const wrap = button.closest('.gallery-inpaint-tool-wrap');
        if (wrap) wrap.classList.add('open');
    }
    const overlay = document.getElementById('galleryInpaintOverlay');
    if (overlay && galleryInpaintLastPointerEvent) {
        updateGalleryInpaintBrushCursor(galleryInpaintLastPointerEvent, overlay);
    }
}

function setGalleryInpaintBrushSize(value) {
    galleryInpaintBrushSize = Math.max(8, Math.min(320, parseInt(value, 10) || 96));

    document.querySelectorAll('.gallery-inpaint-size-popover input[type="range"]').forEach(input => {
        input.value = String(galleryInpaintBrushSize);
    });

    document.querySelectorAll('.gallery-inpaint-size-readout').forEach(node => {
        node.innerText = `${galleryInpaintBrushSize}px`;
    });
    const overlay = document.getElementById('galleryInpaintOverlay');
    if (overlay && galleryInpaintLastPointerEvent) {
        updateGalleryInpaintBrushCursor(galleryInpaintLastPointerEvent, overlay);
    }
}

function isGalleryLogoRemovalEnabled() {
    const check = document.getElementById('galleryInpaintLogoRemovalCheck');

    if (check) {
        return Boolean(check.checked);
    }

    return Boolean(galleryInpaintSession?.promptInfo?.logoRemoval);
}

function getEffectiveGalleryInpaintPromptInfo() {
    const baseInfo = normalizeGalleryPromptInfo(galleryInpaintSession?.promptInfo || {});
    const logoRemovalEnabled = isGalleryLogoRemovalEnabled();

    return normalizeGalleryPromptInfo({
        ...baseInfo,
        basePrompt: buildGalleryLogoRemovalBasePrompt(
            baseInfo.basePrompt || baseInfo.baseCaption || '',
            logoRemovalEnabled
        ),
        logoRemoval: logoRemovalEnabled
    });
}

function openGalleryInpaintPrompt() {
    if (!galleryInpaintSession) return;

    const p = normalizeGalleryPromptInfo(galleryInpaintSession.promptInfo || {});
    setGenerationSettings('galleryInpaint', p);

    document.getElementById('galleryInpaintBasePrompt').value = p.basePrompt || '';
    setGalleryInpaintCharPromptValues(
        p.charPrompts && p.charPrompts.length
            ? p.charPrompts
            : p.charPrompt || ''
    );
    document.getElementById('galleryInpaintNegativePrompt').value = p.negativePrompt || '';
    document.getElementById('galleryInpaintStrength').value = p.strength ?? 0.65;
    document.getElementById('galleryInpaintNoise').value = p.noise ?? 0.2;

    document.getElementById('galleryInpaintPromptLayer').style.display = 'flex';
}

function closeGalleryInpaintPrompt() {
    const layer = document.getElementById('galleryInpaintPromptLayer');
    if (layer) layer.style.display = 'none';
}

function saveGalleryInpaintPrompt() {
    if (!galleryInpaintSession) return;

    const settings = readGenerationSettings('galleryInpaint');
    if (!settings) return;
    const previousPromptInfo = normalizeGalleryPromptInfo(galleryInpaintSession.promptInfo || {});
    const charPrompts = getGalleryInpaintCharPromptValues();

    const basePromptInput = String(document.getElementById('galleryInpaintBasePrompt').value || '').trim();

    const basePrompt =
        basePromptInput ||
        previousPromptInfo.basePrompt ||
        previousPromptInfo.baseCaption ||
        '';
    const logoRemovalEnabled = isGalleryLogoRemovalEnabled();

    galleryInpaintSession.promptInfo = normalizeGalleryPromptInfo({
        ...(galleryInpaintSession.promptInfo || {}),
        basePrompt,
        baseCaption: previousPromptInfo.baseCaption || basePrompt,
        charPrompts,
        charPrompt: buildLegacyCharPromptText(charPrompts),
        negativePrompt: document.getElementById('galleryInpaintNegativePrompt').value || previousPromptInfo.negativePrompt || '',
        ...settings,
        logoRemoval: logoRemovalEnabled
    });

    closeGalleryInpaintPrompt();
}

async function requestGalleryInpaint() {
    const session = galleryInpaintSession;
    if (!session || session.requestPending) return;

    const mask = session.maskDataUrl || '';
    if (!mask) {
        alert('인페인팅할 영역을 먼저 칠해 주세요.');
        return;
    }

    session.requestPending = true;

    try {
        const safePromptInfo = getEffectiveGalleryInpaintPromptInfo();
        session.promptInfo = safePromptInfo;

        const requestWidth = session.imageWidth;
        const requestHeight = session.imageHeight;
        const requestSteps = parseInt(safePromptInfo.steps || 28, 10) || 28;

        const canUseAnlas = await showAnlasWarningModal({
            width: requestWidth,
            height: requestHeight,
            steps: requestSteps,
            title: '갤러리 인페인팅 Anlas 사용 경고',
            detail: '현재 인페인팅 요청은 무료 범위를 벗어나 Anlas가 소모될 수 있습니다.'
        });

        if (!canUseAnlas || galleryInpaintSession !== session) return;

        setGalleryInpaintProcessing(true, '인페인팅 처리 중...');

        const payload = {
            image: session.currentSrc,
            mask,
            width: requestWidth,
            height: requestHeight,
            promptInfo: safePromptInfo,
            tempCategory: GALLERY_INPAINT_TEMP_CATEGORY,
            tempSessionId: session.tempSessionId
        };
        if (session.projectContext) {
            payload.source_path = session.originalPath;
            payload.projectContext = {...session.projectContext};
        }

        const response = await fetch('/api/canvas/inpaint', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (!response.ok || data.status !== 'success') {
            throw new Error(data.message || '인페인팅 요청에 실패했습니다.');
        }

        if (session.projectContext) {
            if (data.destination !== 'project' || !data.path || !data.src) {
                throw new Error('프로젝트 후보 저장 결과를 확인할 수 없습니다.');
            }
            if (galleryInpaintSession !== session) {
                await window.Daki?.refreshProject?.(data.projectId || session.projectContext.projectId);
                return;
            }
            session.resultSrc = data.src;
            session.currentSrc = data.src;
            session.saved = true;
            session.savedPath = data.path;
            session.autoSavedToProject = true;
        } else {
            if (galleryInpaintSession !== session) return;
            session.resultSrc = `${data.src}?t=${Date.now()}`;
            session.currentSrc = session.resultSrc;
            session.saved = false;
            session.autoSavedToProject = false;
        }

        const img = document.getElementById('galleryInpaintImage');
        if (img) {
            img.src = session.currentSrc;
        }

        // 완료 후에는 선택범위를 숨긴 상태로 전환
        galleryInpaintMaskVisible = false;
        applyGalleryInpaintMaskVisibility();

        if (session.projectContext) {
            const projectName = data.projectName || data.projectId || session.projectContext.projectId;
            const side = data.side || session.projectContext.side;
            const sideLabel = side === 'back' ? '뒷면' : '앞면';
            showToast(`${projectName} · ${sideLabel} 후보에 인페인팅 결과를 추가했습니다.`);
            await window.Daki?.refreshProject?.(data.projectId || session.projectContext.projectId);
        } else {
            showToast('인페인팅 결과를 받았습니다.');
        }
    } catch (e) {
        if (galleryInpaintSession === session) alert(`인페인팅 실패: ${e.message || e}`);
    } finally {
        session.requestPending = false;
        if (galleryInpaintSession === session) setGalleryInpaintProcessing(false);
    }
}

async function overwriteGalleryInpaintResult() {
    if (!galleryInpaintSession || !galleryInpaintSession.resultSrc) {
        alert('먼저 인페인팅 결과를 만들어 주세요.');
        return;
    }

    if (!galleryInpaintSession.originalPath) {
        alert('원본 경로가 없어 덮어쓸 수 없습니다.');
        return;
    }

    if (!confirm('현재 인페인팅 결과로 원본 이미지를 덮어쓸까요?')) return;

    try {
        const sessionToCleanup = { ...galleryInpaintSession };
        const safePromptInfo = getEffectiveGalleryInpaintPromptInfo();
        galleryInpaintSession.promptInfo = safePromptInfo;

        const response = await fetch('/api/gallery/overwrite_image', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                source_image: galleryInpaintSession.resultSrc,
                target_path: galleryInpaintSession.originalPath,
                promptInfo: safePromptInfo
            })
        });

        const data = await response.json();

        if (!response.ok || data.status !== 'success') {
            throw new Error(data.message || '덮어쓰기 실패');
        }

        const refreshedPath = data.path || galleryInpaintSession.originalPath;
        const refreshedSrc = markGalleryImageUpdated(refreshedPath);

        galleryInpaintSession.originalPath = refreshedPath;
        galleryInpaintSession.currentSrc = refreshedSrc;
        galleryInpaintSession.resultSrc = refreshedSrc;
        galleryInpaintSession.saved = true;
        galleryInpaintSession.savedPath = refreshedPath;
        galleryInpaintSession.tempSessionId = '';

        const inpaintImg = document.getElementById('galleryInpaintImage');
        if (inpaintImg) {
            inpaintImg.src = refreshedSrc;
        }

        if (activeImageContext) {
            activeImageContext.path = refreshedPath;
            activeImageContext.imgSrc = refreshedSrc;
        }

        updateGalleryImageDomAfterOverwrite(refreshedPath, refreshedSrc);

        showToast('원본 이미지를 덮어썼습니다.');
        await loadData();

        // loadData가 전체를 다시 그린 뒤에도 한 번 더 적용
        updateGalleryImageDomAfterOverwrite(refreshedPath, refreshedSrc);
        await cleanupGalleryInpaintTempSession(sessionToCleanup);
        closeGalleryInpaint();
    } catch (e) {
        alert(`덮어쓰기 실패: ${e.message || e}`);
    }
}

async function saveGalleryInpaintResultAsNew() {
    const session = galleryInpaintSession;
    if (!session || !session.resultSrc) {
        alert('먼저 인페인팅 결과를 만들어 주세요.');
        return;
    }

    if (session.autoSavedToProject) {
        showToast('인페인팅 결과는 이미 프로젝트 후보로 저장되었습니다.');
        return;
    }

    try {
        const sessionToCleanup = { ...galleryInpaintSession };
        const safePromptInfo = getEffectiveGalleryInpaintPromptInfo();
        galleryInpaintSession.promptInfo = safePromptInfo;
        
        const response = await fetch('/api/gallery/save_inpaint_as_new', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                source_image: galleryInpaintSession.resultSrc,
                source_path: galleryInpaintSession.originalPath || '',
                promptInfo: safePromptInfo
            })
        });

        const data = await response.json();

        if (!response.ok || data.status !== 'success') {
            throw new Error(data.message || '새로 저장 실패');
        }

        galleryInpaintSession.saved = true;
        galleryInpaintSession.savedPath = data.path || '';
        galleryInpaintSession.tempSessionId = '';

        showToast('인페인팅 결과를 새 파일로 저장했습니다.');
        await loadData();
        await cleanupGalleryInpaintTempSession(sessionToCleanup);
        closeGalleryInpaint();
    } catch (e) {
        alert(`새로 저장 실패: ${e.message || e}`);
    }
}


function setGalleryInpaintProcessing(isLoading, message = '인페인팅 처리 중...') {
    isGalleryInpaintProcessing = Boolean(isLoading);
    galleryInpaintLoadingMessage = message || '인페인팅 처리 중...';

    const layer = document.getElementById('galleryInpaintLoading');
    const text = document.getElementById('galleryInpaintLoadingText');

    if (text) {
        text.innerText = galleryInpaintLoadingMessage;
    }

    if (layer) {
        layer.classList.toggle('show', isGalleryInpaintProcessing);
    }

    const toolbarButtons = document.querySelectorAll('#galleryInpaintLayer .gallery-inpaint-tool-btn');
    toolbarButtons.forEach((btn) => {
        btn.disabled = isGalleryInpaintProcessing;
    });
}


