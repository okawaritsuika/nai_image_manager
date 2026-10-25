// Edit only the selected layer. Commit each stroke to a new asset, never its source file.
let canvasLayerEraserEnabled = false;
let canvasLayerEraserSize = 64;
let canvasLayerEraserSession = null;
let canvasLayerEraserRevision = 0;
const canvasLayerEraserWrites = new WeakSet();

function getCanvasEraserLayer() {
    const layer = findCanvasLayer(activeLayerId)?.layer;
    return layer && (layer.type === 'selection' || (['image', 'clip'].includes(layer.type) && layer.src)) ? layer : null;
}

function getCanvasEraserTargets(layer = getCanvasEraserLayer()) {
    if (!layer) return [];
    if (layer.type !== 'selection') return [layer];
    const targets = [];
    const visit = node => {
        if (node.type === 'clip' && node.renderOnCanvas && node.src) targets.push(node);
        if (node.children) node.children.forEach(visit);
    };
    (layer.children || []).forEach(visit);
    return targets;
}

function getCanvasEraserGroupUndo(layer) {
    const batch = layer?.eraserGroupHistory?.at(-1);
    return batch?.length && batch.every(item => findCanvasLayer(item.id)?.layer.src === item.after) ? batch : null;
}

function updateCanvasEraserControls(message = '') {
    const layer = getCanvasEraserLayer();
    const busy = layer && (canvasLayerEraserWrites.has(layer) || getCanvasEraserTargets(layer).some(target => canvasLayerEraserWrites.has(target)));
    const button = el('layerEraserToolBtn');
    if (button) {
        button.classList.toggle('active', canvasLayerEraserEnabled);
        button.setAttribute('aria-pressed', String(canvasLayerEraserEnabled));
    }
    const undo = el('layerEraserUndoBtn');
    if (undo) undo.disabled = !layer || busy || (layer.type === 'selection' ? !getCanvasEraserGroupUndo(layer) : (!layer.eraserUndoSources?.length || layer.eraserLatestSrc !== layer.src));
    const hint = el('layerEraserHint');
    if (hint) hint.hidden = !message && !busy && !canvasLayerEraserEnabled;
    if (hint) hint.textContent = message || (busy ? '지운 그림을 저장하는 중…' : canvasLayerEraserEnabled
        ? (layer?.type === 'selection' ? '이 선택 영역의 인페인팅 결과 전체를 함께 지웁니다. 숨긴 결과도 포함합니다.' : '선택한 그림만 투명하게 지웁니다. 다른 그림은 레이어 목록에서 선택하세요.')
        : '그림 레이어 선택 → 지우개 켜기 → 그림 위에서 드래그. Ctrl+Z: 지우기 되돌리기');
}

function setCanvasLayerEraserEnabled(enabled) {
    canvasLayerEraserEnabled = Boolean(enabled);
    if (canvasLayerEraserEnabled) {
        if (isLayerMoveMode) toggleLayerMoveMode();
        if (isImageResizeMode) toggleImageResizeMode();
        if (isCanvasResizeMode) setCanvasResizeMode(false);
    }
    syncCanvasLayerEraser();
}

function toggleCanvasLayerEraser() {
    if (!canvasLayerEraserEnabled && !getCanvasEraserTargets().length) {
        alert('레이어 목록에서 지울 그림, 인페인팅 결과 또는 결과가 있는 선택 영역을 먼저 선택해 주세요.');
        return;
    }
    setCanvasLayerEraserEnabled(!canvasLayerEraserEnabled);
}

function setCanvasLayerEraserSize(value) {
    canvasLayerEraserSize = Math.max(1, Math.min(512, Math.round(Number(value) || 1)));
    el('layerEraserSize').value = canvasLayerEraserSize;
    el('layerEraserSizeValue').textContent = `${canvasLayerEraserSize}px`;
}

function disposeCanvasLayerEraserSession() {
    const session = canvasLayerEraserSession;
    canvasLayerEraserSession = null;
    if (!session) return;
    session.stroke = null;
    if (session.pointerId != null && session.surface.hasPointerCapture?.(session.pointerId)) {
        session.surface.releasePointerCapture(session.pointerId);
    }
    for (const entry of session.entries || [session]) {
        entry.preview?.remove();
        if (entry.image) entry.image.style.display = '';
    }
    session.cursor.remove();
}

async function syncCanvasLayerEraser() {
    const revision = ++canvasLayerEraserRevision;
    disposeCanvasLayerEraserSession();
    const surface = el('canvasSurface');
    if (!surface) return;
    bindCanvasLayerEraser(surface);
    surface.classList.toggle('layer-eraser-mode', canvasLayerEraserEnabled);
    updateCanvasEraserControls();
    if (!canvasLayerEraserEnabled) return;
    const owner = getCanvasEraserLayer();
    const targets = getCanvasEraserTargets(owner);
    if (!targets.length) {
        updateCanvasEraserControls('그림 또는 인페인팅 결과가 있는 선택 영역을 선택해 주세요.');
        return;
    }
    if ([owner, ...targets].some(layer => canvasLayerEraserWrites.has(layer))) return;
    updateCanvasEraserControls('지울 그림을 준비하는 중…');
    try {
        const entries = [];
        // Decode sequentially to avoid a burst of simultaneous full-resolution image loads.
        for (const layer of targets) {
            const source = layer.src;
            const original = await loadImageElementForClip(source);
            if (revision !== canvasLayerEraserRevision || layer.src !== source) return;
            const canvas = document.createElement('canvas');
            canvas.width = original.naturalWidth;
            canvas.height = original.naturalHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(original, 0, 0);
            const node = surface.querySelector(`.image-layer[data-layer-id="${Number(layer.id)}"]`);
            entries.push({layer, source, canvas, ctx, node, surface});
        }
        if (entries.some(entry => entry.layer.src !== entry.source)) return;
        for (const entry of entries) {
            if (!entry.node) continue; // Hidden results are edited without making them visible.
            entry.image = entry.node.querySelector('img');
            entry.preview = document.createElement('canvas');
            entry.preview.className = 'canvas-layer-eraser-preview';
            const rect = entry.node.getBoundingClientRect();
            const ratio = window.devicePixelRatio || 1;
            entry.preview.width = Math.max(1, Math.round(rect.width * ratio));
            entry.preview.height = Math.max(1, Math.round(rect.height * ratio));
            refreshCanvasEraserPreview(entry);
            entry.image.style.display = 'none';
            entry.node.appendChild(entry.preview);
        }
        const cursor = document.createElement('div');
        cursor.className = 'canvas-layer-eraser-cursor';
        cursor.hidden = true;
        surface.appendChild(cursor);
        canvasLayerEraserSession = {owner, entries, surface, cursor, stroke: null};
        updateCanvasEraserControls();
    } catch (error) {
        if (revision === canvasLayerEraserRevision) updateCanvasEraserControls(error.message);
    }
}

function refreshCanvasEraserPreview(entry) {
    if (!entry.preview) return;
    const ctx = entry.preview.getContext('2d');
    ctx.clearRect(0, 0, entry.preview.width, entry.preview.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(entry.canvas, 0, 0, entry.preview.width, entry.preview.height);
}

function canvasLayerEraserPoint(event, session) {
    const scale = getCanvasDisplayScale();
    const surfaceRect = session.surface?.getBoundingClientRect();
    const rect = session.node ? session.node.getBoundingClientRect() : {
        left: surfaceRect.left + session.layer.x * scale, top: surfaceRect.top + session.layer.y * scale,
        width: session.layer.layerWidth * scale, height: session.layer.layerHeight * scale
    };
    return {x: (event.clientX - rect.left) * session.layer.layerWidth / rect.width,
        y: (event.clientY - rect.top) * session.layer.layerHeight / rect.height};
}

function drawCanvasLayerEraserSegment(session, from, to, diameter) {
    const {ctx, canvas, layer} = session;
    ctx.save();
    // Work in canvas-layout pixels so a stretched layer still has a round on-screen brush.
    ctx.setTransform(canvas.width / layer.layerWidth, 0, 0, canvas.height / layer.layerHeight, 0, 0);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = diameter;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(to.x, to.y, diameter / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    refreshCanvasEraserPreview(session);
}

async function commitCanvasLayerEraserStroke(session) {
    const entries = session.entries ? session.entries.filter(entry => entry.touched) : [session];
    const owner = session.owner || session.layer;
    const locked = [...new Set([owner, ...entries.map(entry => entry.layer)])];
    if (!entries.length || locked.some(layer => canvasLayerEraserWrites.has(layer))) return;
    locked.forEach(layer => canvasLayerEraserWrites.add(layer));
    updateCanvasEraserControls();
    try {
        const results = [];
        for (const entry of entries) results.push(await saveClipDataUrlToServer(entry.canvas.toDataURL('image/png')));
        // Publish a group stroke atomically; late saves must not overwrite newer results.
        if (findCanvasLayer(owner.id)?.layer !== owner || entries.some(({layer, source}) =>
            findCanvasLayer(layer.id)?.layer !== layer || layer.src !== source)) return;
        const batch = entries.map(({layer, source}, index) => ({id: layer.id, before: source, after: results[index]}));
        entries.forEach(({layer, source}, index) => {
            const history = layer.eraserLatestSrc === source ? (layer.eraserUndoSources || []) : [];
            layer.eraserUndoSources = [...history, source].slice(-20);
            layer.eraserOriginalSrc = layer.eraserOriginalSrc || source;
            layer.eraserLatestSrc = results[index];
            layer.src = results[index];
        });
        if (owner.type === 'selection') owner.eraserGroupHistory = [...(owner.eraserGroupHistory || []), batch].slice(-20);
        clearClipMergedSourcePreviewCache();
        saveCanvasState();
    } catch (error) {
        alert(`지우기 저장 실패: ${error.message}\n이 획은 적용되지 않았습니다.`);
    } finally {
        locked.forEach(layer => canvasLayerEraserWrites.delete(layer));
        renderLayerList();
        renderCanvasLayersOnSurface();
    }
}

function undoCanvasLayerEraserStroke() {
    const layer = getCanvasEraserLayer();
    if (!layer || [layer, ...getCanvasEraserTargets(layer)].some(target => canvasLayerEraserWrites.has(target))) return;
    if (layer.type === 'selection') {
        const batch = getCanvasEraserGroupUndo(layer);
        if (!batch) return;
        batch.forEach(item => {
            const target = findCanvasLayer(item.id).layer;
            target.src = item.before;
            target.eraserLatestSrc = item.before;
            if (target.eraserUndoSources?.at(-1) === item.before) target.eraserUndoSources.pop();
        });
        layer.eraserGroupHistory.pop();
    } else {
        if (layer.eraserLatestSrc !== layer.src || !layer.eraserUndoSources?.length) return;
        layer.src = layer.eraserUndoSources.pop();
        layer.eraserLatestSrc = layer.src;
    }
    clearClipMergedSourcePreviewCache();
    saveCanvasState();
    renderLayerList();
    renderCanvasLayersOnSurface();
}

function drawCanvasEraserEvent(session, event, first = false) {
    for (const entry of session.entries) {
        const point = canvasLayerEraserPoint(event, entry);
        const from = first ? point : entry.previous;
        const radius = session.diameter / 2;
        if (Math.max(from.x, point.x) + radius >= 0 && Math.min(from.x, point.x) - radius <= entry.layer.layerWidth &&
            Math.max(from.y, point.y) + radius >= 0 && Math.min(from.y, point.y) - radius <= entry.layer.layerHeight) {
            drawCanvasLayerEraserSegment(entry, from, point, session.diameter);
            entry.touched = true;
        }
        entry.previous = point;
    }
}

function bindCanvasLayerEraser(surface) {
    if (surface.dataset.layerEraserBound) return;
    surface.dataset.layerEraserBound = '1';
    const stop = event => { event.preventDefault(); event.stopImmediatePropagation(); };
    for (const type of ['mousedown', 'click', 'dblclick', 'contextmenu']) {
        surface.addEventListener(type, event => { if (canvasLayerEraserEnabled) stop(event); }, true);
    }
    surface.addEventListener('pointerdown', event => {
        if (!canvasLayerEraserEnabled || event.button !== 0) return;
        stop(event);
        const session = canvasLayerEraserSession;
        if (!session || session.stroke || canvasLayerEraserWrites.has(session.owner)) return;
        session.stroke = true;
        session.pointerId = event.pointerId;
        session.diameter = canvasLayerEraserSize;
        surface.setPointerCapture(event.pointerId);
        drawCanvasEraserEvent(session, event, true);
    }, true);
    surface.addEventListener('pointermove', event => {
        const session = canvasLayerEraserSession;
        if (!canvasLayerEraserEnabled || !session) return;
        const surfaceRect = surface.getBoundingClientRect();
        const size = canvasLayerEraserSize * getCanvasDisplayScale();
        Object.assign(session.cursor.style, {left: `${event.clientX - surfaceRect.left}px`, top: `${event.clientY - surfaceRect.top}px`,
            width: `${size}px`, height: `${size}px`});
        session.cursor.hidden = false;
        if (!session.stroke || session.pointerId !== event.pointerId) return;
        stop(event);
        drawCanvasEraserEvent(session, event);
    }, true);
    surface.addEventListener('pointerup', event => {
        const session = canvasLayerEraserSession;
        if (!session?.stroke || session.pointerId !== event.pointerId) return;
        stop(event);
        drawCanvasEraserEvent(session, event);
        session.stroke = null;
        surface.releasePointerCapture(event.pointerId);
        commitCanvasLayerEraserStroke(session);
    }, true);
    for (const type of ['pointercancel', 'lostpointercapture']) {
        surface.addEventListener(type, event => {
            if (canvasLayerEraserSession?.stroke && canvasLayerEraserSession.pointerId === event.pointerId) syncCanvasLayerEraser();
        });
    }
    surface.addEventListener('pointerleave', () => {
        if (canvasLayerEraserSession) canvasLayerEraserSession.cursor.hidden = true;
    });
}

window.addEventListener('blur', () => {
    if (canvasLayerEraserSession?.stroke) syncCanvasLayerEraser();
});
document.addEventListener('keydown', event => {
    if (!canvasLayerEraserEnabled || event.target.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
        event.preventDefault(); event.stopImmediatePropagation(); undoCanvasLayerEraserStroke();
    }
}, true);
