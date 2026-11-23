// Shared by the editor and gallery. Gallery rendering supplies state explicitly;
// omitted state and geometry options keep the live editor's global defaults.
function getInitialImageLayerGeometry(imageWidth, imageHeight, options = null) {
    const canvasWidth = options?.canvasWidth || currentCanvasWidth || imageWidth || 960;
    const canvasHeight = options?.canvasHeight || currentCanvasHeight || imageHeight || 3072;
    const allowUpscale = options?.allowUpscale === true;

    const containScale = Math.min(
        canvasWidth / imageWidth,
        canvasHeight / imageHeight
    );
    const fitScale = allowUpscale ? containScale : Math.min(containScale, 1);
    const scale = options?.preserveOriginalSize ? 1 : fitScale;

    const width = Math.max(1, Math.round(imageWidth * scale));
    const height = Math.max(1, Math.round(imageHeight * scale));

    return {
        width,
        height,
        x: Math.round((canvasWidth - width) / 2),
        y: Math.round((canvasHeight - height) / 2)
    };
}

function normalizeImageLayerGeometry(layer, options = null) {
    if (!layer || layer.type !== 'image') return;

    const canvasWidth = options?.canvasWidth || currentCanvasWidth;
    const canvasHeight = options?.canvasHeight || currentCanvasHeight;
    const imageWidth = parseInt(layer.imageWidth, 10) || canvasWidth || 960;
    const imageHeight = parseInt(layer.imageHeight, 10) || canvasHeight || 3072;

    if (!Number.isFinite(layer.layerWidth) || !Number.isFinite(layer.layerHeight) || !layer.layerWidth || !layer.layerHeight) {
        const geometry = getInitialImageLayerGeometry(imageWidth, imageHeight, options);
        layer.layerWidth = geometry.width;
        layer.layerHeight = geometry.height;
    }

    if (!Number.isFinite(layer.x)) {
        layer.x = Math.round(((canvasWidth || imageWidth) - layer.layerWidth) / 2);
    }

    if (!Number.isFinite(layer.y)) {
        layer.y = Math.round(((canvasHeight || imageHeight) - layer.layerHeight) / 2);
    }
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

function collectDrawableImageLayersForClip(layers, output = [], selectionOverride = null) {
    // renderCanvasLayerStack과 같은 순서: 아래 레이어부터 위 레이어 순서
    [...layers].reverse().forEach((layer) => {
        if (!layer || !layer.visible) return;

        if (layer === selectionOverride?.selection) {
            for (const selectedLayer of selectionOverride.layers) output.push(selectedLayer);
            return;
        }
        if (layer.type === 'folder' || layer.type === 'selection') {
            layer.children = Array.isArray(layer.children) ? layer.children : [];
            collectDrawableImageLayersForClip(layer.children, output, selectionOverride);
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

function drawCanvasLayerImage(ctx, img, layer, offsetX = 0, offsetY = 0) {
    const x = (layer.x || 0) - offsetX;
    const y = (layer.y || 0) - offsetY;
    const width = layer.layerWidth || layer.imageWidth || img.naturalWidth || img.width;
    const height = layer.layerHeight || layer.imageHeight || img.naturalHeight || img.height;
    const rotation = layer.type === 'clip' ? layer.rotation : null;

    if (Number.isFinite(rotation) && rotation % 360 !== 0) {
        ctx.save();
        ctx.translate(x + width / 2, y + height / 2);
        ctx.rotate(rotation * Math.PI / 180);
        ctx.drawImage(img, -width / 2, -height / 2, width, height);
        ctx.restore();
        return;
    }

    ctx.drawImage(img, x, y, width, height);
}

// Snapshot layer geometry so resizing the editor or awaiting image decoding cannot
// change the pixels of an in-flight request. Preview and submission use this same compositor.
function createClipBoundarySource(selection, baseClip, anchor, merged) {
    const visible = collectDrawableImageLayersForClip(selection.children);
    const anchorId = anchor.boundaryBaseClipId === baseClip.id ? anchor.boundaryAnchorId : anchor.id;
    const original = merged || anchorId === baseClip.id ? baseClip
        : visible.find(layer => layer.type === 'clip' && layer.id === anchorId) || baseClip;
    const selectedLayers = visible.filter(layer => merged || layer.type !== 'clip'
        || layer === original || layer.boundaryBaseClipId === baseClip.id);
    // An editable original has no canvas pixels of its own. Insert its image below this
    // selection's results, keeping other visible layers at their actual stack positions.
    if (!baseClip.renderOnCanvas && baseClip.visible && (merged || original === baseClip)) selectedLayers.unshift(baseClip);
    const layers = collectDrawableImageLayersForClip(canvasLayers, [], {selection, layers: selectedLayers})
        .filter(layer => !layer.pinnedReference);
    const scene = layers.map(layer => {
        const geometry = {type: layer.type, src: layer.src, x: layer.x, y: layer.y,
            rotation: layer.rotation, layerWidth: layer.layerWidth, layerHeight: layer.layerHeight,
            imageWidth: layer.imageWidth, imageHeight: layer.imageHeight};
        normalizeImageLayerGeometry(geometry);
        return geometry;
    });
    const whiteBase = hasVisibleCanvasBaseLayer(canvasLayers);
    const images = new Map();
    return async (rect, maxDimension = Infinity) => {
        const scale = Math.min(1, maxDimension / Math.max(rect.width, rect.height));
        const output = document.createElement('canvas');
        output.width = Math.max(1, Math.round(rect.width * scale));
        output.height = Math.max(1, Math.round(rect.height * scale));
        const ctx = output.getContext('2d');
        if (whiteBase) {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, output.width, output.height);
        }
        ctx.scale(output.width / rect.width, output.height / rect.height);
        for (const layer of scene) {
            const b = CanvasSelectionRotation.bounds(layer);
            if (!rectsIntersect(rect.x, rect.y, rect.width, rect.height, b.x, b.y, b.width, b.height)) continue;
            if (!images.has(layer.src)) images.set(layer.src, loadImageElementForClip(layer.src));
            const image = await images.get(layer.src);
            drawCanvasLayerImage(ctx, image, layer, rect.x, rect.y);
        }
        return output;
    };
}

async function renderMergedCanvasToDataUrl(options = null) {
    const signal = options?.signal;
    signal?.throwIfAborted();

    const state = options?.state;
    const width = Number(state ? state.width : currentCanvasWidth);
    const height = Number(state ? state.height : currentCanvasHeight);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error('내보낼 캔버스가 없습니다.');
    }
    // Reference previews normalize a copy using their own dimensions, never the open canvas.
    const layers = state ? structuredClone(Array.isArray(state.layers) ? state.layers : []) : canvasLayers;

    const offscreen = document.createElement('canvas');
    const limit = Number(options?.maxDimension);
    const scale = Number.isFinite(limit) && limit > 0
        ? Math.min(1, limit / Math.max(width, height)) : 1;
    offscreen.width = Math.max(1, Math.round(width * scale));
    offscreen.height = Math.max(1, Math.round(height * scale));

    const ctx = offscreen.getContext('2d');
    ctx.scale(scale, scale);
    ctx.clearRect(0, 0, width, height);

    // 캔버스 베이스 레이어가 보이면 흰 배경 합성
    if (hasVisibleCanvasBaseLayer(layers)) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
    }

    const drawableLayers = collectDrawableImageLayersForClip(layers);

    for (const layer of drawableLayers) {
        if (layer.type === 'image') {
            if (layer.pinnedReference) continue;

            normalizeImageLayerGeometry(layer, {canvasWidth: width, canvasHeight: height});
        }

        if (!layer.src) continue;

        signal?.throwIfAborted();
        const img = options?.loadImage
            ? await options.loadImage(layer.src, layer)
            : await loadImageElementForClip(layer.src);
        signal?.throwIfAborted();

        drawCanvasLayerImage(ctx, img, layer);
    }

    signal?.throwIfAborted();
    options?.onComposite?.(offscreen);
    return offscreen.toDataURL('image/png');
}
