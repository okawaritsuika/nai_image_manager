(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CanvasRetouchViewport = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
    'use strict';

    const MAX_EDGE = 4096;
    const MAX_PIXELS = 4194304;
    const BASE_PREVIEW_EDGE = 1600;
    const VIEW_MARGIN = 32;
    const DEBOUNCE_MS = 150;
    const RETRY_DELAY_MS = 300;
    const MAX_CONFLICT_RETRIES = 3;

    function finite(value) {
        return typeof value === 'number' && Number.isFinite(value);
    }

    function bounds(rect) {
        if (!rect || typeof rect !== 'object') return null;
        const {left, top, width, height} = rect;
        if (![left, top, width, height].every(finite) || width <= 0 || height <= 0) return null;
        return {left, top, right: left + width, bottom: top + height, width, height};
    }

    function outputScale(requested, width, height) {
        let scale = requested;
        for (let attempt = 0; attempt < 16; attempt += 1) {
            const outputWidth = Math.max(1, Math.ceil(width * scale));
            const outputHeight = Math.max(1, Math.ceil(height * scale));
            if (outputWidth <= MAX_EDGE && outputHeight <= MAX_EDGE
                && outputWidth * outputHeight <= MAX_PIXELS) return scale;
            const edgeScale = Math.min(MAX_EDGE / outputWidth, MAX_EDGE / outputHeight);
            const pixelScale = Math.sqrt(MAX_PIXELS / (outputWidth * outputHeight));
            scale *= Math.min(1, edgeScale, pixelScale) * (1 - 1e-12);
            if (!finite(scale) || scale <= 0) return null;
        }
        return null;
    }

    function viewportRegion(documentWidth, documentHeight, imageRect, workspaceRect, dpr = 1) {
        if (!Number.isInteger(documentWidth) || !Number.isInteger(documentHeight)
            || documentWidth <= 0 || documentHeight <= 0 || !finite(dpr) || dpr <= 0) return null;
        const image = bounds(imageRect), workspace = bounds(workspaceRect);
        if (!image || !workspace) return null;

        const visibleLeft = Math.max(image.left, workspace.left);
        const visibleTop = Math.max(image.top, workspace.top);
        const visibleRight = Math.min(image.right, workspace.right);
        const visibleBottom = Math.min(image.bottom, workspace.bottom);
        if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) return null;

        const screenLeft = Math.max(image.left, visibleLeft - VIEW_MARGIN);
        const screenTop = Math.max(image.top, visibleTop - VIEW_MARGIN);
        const screenRight = Math.min(image.right, visibleRight + VIEW_MARGIN);
        const screenBottom = Math.min(image.bottom, visibleBottom + VIEW_MARGIN);
        const x = Math.max(0, Math.min(documentWidth,
            Math.floor((screenLeft - image.left) * documentWidth / image.width)));
        const y = Math.max(0, Math.min(documentHeight,
            Math.floor((screenTop - image.top) * documentHeight / image.height)));
        const farX = Math.max(0, Math.min(documentWidth,
            Math.ceil((screenRight - image.left) * documentWidth / image.width)));
        const farY = Math.max(0, Math.min(documentHeight,
            Math.ceil((screenBottom - image.top) * documentHeight / image.height)));
        const width = farX - x, height = farY - y;
        if (width <= 0 || height <= 0) return null;

        const desiredScale = Math.min(1, Math.min(2, dpr) * image.width / documentWidth);
        const baseScale = Math.min(1, BASE_PREVIEW_EDGE / Math.max(documentWidth, documentHeight));
        if (!finite(desiredScale) || desiredScale <= baseScale * 1.05) return null;

        const cappedScale = Math.min(desiredScale, MAX_EDGE / width, MAX_EDGE / height,
            Math.sqrt(MAX_PIXELS / (width * height)));
        const scale = outputScale(cappedScale, width, height);
        if (scale === null) return null;
        return {region: {x, y, width, height}, scale};
    }

    function clonePayload(value) {
        if (root && typeof root.structuredClone === 'function') return root.structuredClone(value);
        if (typeof structuredClone === 'function') return structuredClone(value);
        return JSON.parse(JSON.stringify(value));
    }

    function closeBitmap(bitmap) {
        try { bitmap?.close?.(); } catch (_) { /* A released bitmap can already be closed by its owner. */ }
    }

    function percent(value, total) {
        return `${Number((value / total * 100).toFixed(6))}%`;
    }

    function abortError() {
        const error = new Error('Viewport request was cancelled.');
        error.name = 'AbortError';
        return error;
    }

    function create(options) {
        if (!options || !options.host || !options.workspace || typeof options.getPayload !== 'function'
            || typeof options.request !== 'function') {
            throw new TypeError('CanvasRetouchViewport.create requires host, workspace, getPayload, and request.');
        }
        const documentWidth = Number(options.documentWidth);
        const documentHeight = Number(options.documentHeight);
        if (!Number.isInteger(documentWidth) || !Number.isInteger(documentHeight)
            || documentWidth <= 0 || documentHeight <= 0) {
            throw new RangeError('CanvasRetouchViewport document dimensions must be positive integers.');
        }

        const host = options.host;
        const workspace = options.workspace;
        const underlayImage = host.children && host.children[0] ? host.children[0] : null;
        const originalUnderlayClipPath = underlayImage?.style
            ? underlayImage.style.clipPath
            : undefined;
        const document = host.ownerDocument || (root && root.document);
        if (!document || typeof document.createElement !== 'function') {
            throw new TypeError('CanvasRetouchViewport requires a document.');
        }
        const canvas = document.createElement('canvas');
        canvas.className = 'canvas-retouch-viewport';
        canvas.setAttribute?.('aria-hidden', 'true');
        canvas.width = 1;
        canvas.height = 1;
        Object.assign(canvas.style, {
            position: 'absolute',
            inset: 'auto',
            left: '0%',
            top: '0%',
            width: '0%',
            height: '0%',
            pointerEvents: 'none',
            display: 'none',
            imageRendering: 'auto'
        });
        const before = host.children && host.children.length > 1 ? host.children[1] : null;
        if (typeof host.insertBefore === 'function') host.insertBefore(canvas, before);
        else host.appendChild(canvas);

        const listeners = [];
        const timeout = (root && typeof root.setTimeout === 'function') ? root.setTimeout.bind(root) : setTimeout;
        const clearTimeoutFn = (root && typeof root.clearTimeout === 'function') ? root.clearTimeout.bind(root) : clearTimeout;
        const AbortControllerCtor = root && root.AbortController
            ? root.AbortController
            : (typeof AbortController === 'function' ? AbortController : null);
        if (!AbortControllerCtor) {
            canvas.remove?.();
            throw new TypeError('CanvasRetouchViewport requires AbortController.');
        }

        let destroyed = false;
        let revision = 0;
        let timer = null;
        let desired = null;
        let activeRequest = null;
        let editedBitmap = null;
        let originalBitmap = null;
        let renderedKey = null;
        let compare = false;
        let split = 50;
        let resizeObserver = null;

        function listen(target, name, callback, listenerOptions) {
            if (!target || typeof target.addEventListener !== 'function') return;
            target.addEventListener(name, callback, listenerOptions);
            listeners.push([target, name, callback, listenerOptions]);
        }

        function clearScheduledTimer() {
            if (timer === null) return;
            clearTimeoutFn(timer);
            timer = null;
        }

        function releaseBitmaps() {
            closeBitmap(editedBitmap);
            closeBitmap(originalBitmap);
            editedBitmap = null;
            originalBitmap = null;
            renderedKey = null;
        }

        function cancelRequest() {
            const state = activeRequest;
            activeRequest = null;
            state?.controller.abort();
        }

        function hideTile() {
            canvas.style.display = 'none';
            canvas.width = 1;
            canvas.height = 1;
            restoreUnderlayClipPath();
        }

        function restoreUnderlayClipPath() {
            if (originalUnderlayClipPath !== undefined && underlayImage?.style) {
                underlayImage.style.clipPath = originalUnderlayClipPath;
            }
        }

        function clipUnderlayToTile(region) {
            if (!underlayImage?.style) return;
            const left = percent(region.x, documentWidth);
            const top = percent(region.y, documentHeight);
            const right = percent(region.x + region.width, documentWidth);
            const bottom = percent(region.y + region.height, documentHeight);
            underlayImage.style.clipPath = `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${left} ${top}, ${left} ${bottom}, ${right} ${bottom}, ${right} ${top}, ${left} ${top})`;
        }

        function invalidate() {
            if (destroyed) return;
            revision += 1;
            clearScheduledTimer();
            desired = null;
            cancelRequest();
            releaseBitmaps();
            hideTile();
        }

        function clippedWorkspaceRect() {
            if (typeof workspace.getBoundingClientRect !== 'function') return null;
            const rect = bounds(workspace.getBoundingClientRect());
            if (!rect) return null;
            let left = rect.left, top = rect.top, right = rect.right, bottom = rect.bottom;
            const view = root && root.window && root.window !== root ? root.window : root;
            const innerWidth = view && Number(view.innerWidth);
            const innerHeight = view && Number(view.innerHeight);
            if (finite(innerWidth) && innerWidth > 0) {
                left = Math.max(0, left);
                right = Math.min(innerWidth, right);
            }
            if (finite(innerHeight) && innerHeight > 0) {
                top = Math.max(0, top);
                bottom = Math.min(innerHeight, bottom);
            }
            if (right <= left || bottom <= top) return null;
            return {left, top, width: right - left, height: bottom - top};
        }

        function geometry() {
            if (typeof host.getBoundingClientRect !== 'function') return null;
            const imageRect = host.getBoundingClientRect();
            const workspaceRect = clippedWorkspaceRect();
            const view = root && root.window && root.window !== root ? root.window : root;
            const dpr = view && Number(view.devicePixelRatio);
            return viewportRegion(documentWidth, documentHeight, imageRect, workspaceRect,
                finite(dpr) && dpr > 0 ? dpr : 1);
        }

        function geometryKey(value) {
            const {region, scale} = value;
            return `${region.x},${region.y},${region.width},${region.height}@${scale.toPrecision(12)}`;
        }

        function canRequest() {
            if (typeof options.canRequest !== 'function') return true;
            try { return options.canRequest() !== false; } catch (_) { return false; }
        }

        function current(target, state = activeRequest) {
            return !destroyed && desired && desired.key === target.key && revision === target.revision
                && (!state || activeRequest === state) && (!state || !state.controller.signal.aborted);
        }

        function currentAndRequestable(target, state) {
            return current(target, state) && canRequest();
        }

        function schedule() {
            if (destroyed) return;
            const nextGeometry = geometry();
            if (!nextGeometry) {
                if (desired || activeRequest || editedBitmap || originalBitmap || renderedKey) invalidate();
                return;
            }
            const nextGeometryKey = geometryKey(nextGeometry);
            if (desired && desired.geometryKey !== nextGeometryKey) invalidate();
            if (!desired) {
                desired = {
                    geometry: nextGeometry,
                    geometryKey: nextGeometryKey,
                    revision,
                    key: `${revision}:${nextGeometryKey}`
                };
            } else {
                desired.geometry = nextGeometry;
            }
            if (activeRequest && activeRequest.key === desired.key) return;
            if (renderedKey === desired.key && (!compare || originalBitmap)) {
                drawTile();
                return;
            }
            clearScheduledTimer();
            const target = desired;
            timer = timeout(() => {
                timer = null;
                void loadTile(target);
            }, DEBOUNCE_MS);
        }

        function waitForRetry(signal, canContinue) {
            if (signal.aborted || !canContinue()) return Promise.reject(abortError());
            return new Promise((resolve, reject) => {
                let waitTimer = null;
                const cleanup = () => signal.removeEventListener('abort', onAbort);
                const onAbort = () => {
                    if (waitTimer !== null) clearTimeoutFn(waitTimer);
                    cleanup();
                    reject(abortError());
                };
                signal.addEventListener('abort', onAbort, {once: true});
                waitTimer = timeout(() => {
                    cleanup();
                    if (signal.aborted || !canContinue()) reject(abortError());
                    else resolve();
                }, RETRY_DELAY_MS);
            });
        }

        async function requestWithRetry(body, signal, canContinue) {
            let retries = 0;
            while (true) {
                if (signal.aborted || !canContinue()) throw abortError();
                try {
                    return await options.request(body, signal);
                } catch (error) {
                    if (!error || error.status !== 409 || retries >= MAX_CONFLICT_RETRIES) throw error;
                    retries += 1;
                    await waitForRetry(signal, canContinue);
                }
            }
        }

        function validBitmap(bitmap) {
            return bitmap && Number.isInteger(bitmap.width) && Number.isInteger(bitmap.height)
                && bitmap.width > 0 && bitmap.height > 0
                && bitmap.width <= MAX_EDGE && bitmap.height <= MAX_EDGE
                && bitmap.width * bitmap.height <= MAX_PIXELS;
        }

        function bodyFor(payload, target, original = false) {
            const body = {
                source: payload.source,
                layers: payload.layers,
                region: {...target.geometry.region},
                scale: target.geometry.scale
            };
            if (original) body.original = true;
            return body;
        }

        async function loadTile(target) {
            if (!current(target, null) || !canRequest()) return;
            const controller = new AbortControllerCtor();
            const state = {key: target.key, controller};
            activeRequest = state;
            const canContinue = () => currentAndRequestable(target, state);
            try {
                const payload = clonePayload(options.getPayload());
                if (!editedBitmap) {
                    const bitmap = await requestWithRetry(bodyFor(payload, target), controller.signal, canContinue);
                    if (!validBitmap(bitmap)) {
                        closeBitmap(bitmap);
                        throw new TypeError('Viewport request did not return a valid bitmap.');
                    }
                    if (!canContinue()) {
                        closeBitmap(bitmap);
                        return;
                    }
                    editedBitmap = bitmap;
                }
                if (compare && !originalBitmap) {
                    const bitmap = await requestWithRetry(bodyFor(payload, target, true), controller.signal, canContinue);
                    if (!validBitmap(bitmap)) {
                        closeBitmap(bitmap);
                        throw new TypeError('Viewport request did not return a valid original bitmap.');
                    }
                    if (!canContinue()) {
                        closeBitmap(bitmap);
                        return;
                    }
                    originalBitmap = bitmap;
                }
                if (!current(target, state)) return;
                if (!compare || originalBitmap) {
                    renderedKey = target.key;
                    drawTile();
                } else {
                    hideTile();
                }
            } catch (error) {
                if (!destroyed && error?.name !== 'AbortError' && current(target, state)) {
                    if (editedBitmap && !compare) {
                        renderedKey = target.key;
                        drawTile();
                    } else {
                        hideTile();
                    }
                }
            } finally {
                if (activeRequest === state) activeRequest = null;
            }
        }

        function drawTile() {
            if (destroyed || !desired || !editedBitmap || (compare && !originalBitmap)) {
                if (!destroyed) hideTile();
                return;
            }
            const {region, scale} = desired.geometry;
            const width = editedBitmap.width, height = editedBitmap.height;
            canvas.width = width;
            canvas.height = height;
            canvas.style.left = percent(region.x, documentWidth);
            canvas.style.top = percent(region.y, documentHeight);
            canvas.style.width = percent(region.width, documentWidth);
            canvas.style.height = percent(region.height, documentHeight);
            const imageRect = host.getBoundingClientRect();
            canvas.style.imageRendering = imageRect.width > documentWidth ? 'pixelated' : 'auto';
            const context = canvas.getContext('2d');
            if (!context) {
                hideTile();
                return;
            }
            context.clearRect(0, 0, width, height);
            context.drawImage(editedBitmap, 0, 0, width, height);
            if (compare && originalBitmap) {
                const compareDocumentX = documentWidth * split / 100;
                const splitX = (compareDocumentX - region.x) / region.width * width;
                if (splitX >= width) {
                    context.drawImage(originalBitmap, 0, 0, width, height);
                } else if (splitX > 0) {
                    context.save();
                    context.beginPath();
                    context.rect(0, 0, splitX, height);
                    context.clip();
                    context.drawImage(originalBitmap, 0, 0, width, height);
                    context.restore();
                }
            }
            clipUnderlayToTile(region);
            canvas.style.display = 'block';
        }

        function setComparison(value, splitValue) {
            if (destroyed) return;
            const nextCompare = Boolean(value);
            const nextSplit = Number(splitValue);
            const normalizedSplit = finite(nextSplit) ? Math.max(0, Math.min(100, nextSplit)) : split;
            if (nextCompare === compare && normalizedSplit === split) return;
            compare = nextCompare;
            split = normalizedSplit;
            drawTile();
            if (desired && compare && !originalBitmap) schedule();
        }

        function viewportEvent(event) {
            if (event && event.type === 'pointermove' && !(Number(event.buttons) > 0)) return;
            schedule();
        }

        listen(workspace, 'scroll', viewportEvent, {passive: true});
        listen(workspace, 'wheel', viewportEvent, {passive: true});
        listen(workspace, 'pointermove', viewportEvent, {passive: true});
        listen(workspace, 'pointerup', viewportEvent, {passive: true});
        const view = root && root.window && root.window !== root ? root.window : root;
        listen(view, 'resize', schedule, {passive: true});
        if (root && typeof root.ResizeObserver === 'function') {
            try {
                resizeObserver = new root.ResizeObserver(schedule);
                resizeObserver.observe(host);
                resizeObserver.observe(workspace);
            } catch (_) {
                resizeObserver?.disconnect?.();
                resizeObserver = null;
            }
        }

        return {
            invalidate,
            schedule,
            setComparison,
            destroy() {
                if (destroyed) return;
                destroyed = true;
                revision += 1;
                clearScheduledTimer();
                desired = null;
                cancelRequest();
                releaseBitmaps();
                restoreUnderlayClipPath();
                resizeObserver?.disconnect?.();
                resizeObserver = null;
                for (const [target, name, callback, listenerOptions] of listeners.splice(0)) {
                    target.removeEventListener?.(name, callback, listenerOptions);
                }
                canvas.remove?.();
            }
        };
    }

    return {create, viewportRegion};
});
