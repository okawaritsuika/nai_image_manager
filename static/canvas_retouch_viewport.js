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

    function viewportRegion(documentWidth, documentHeight, imageRect, workspaceRect, dpr = 1, baseScale) {
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

        const desiredScale = Math.min(1, dpr * image.width / documentWidth);
        const previewScale = finite(baseScale) && baseScale > 0 && baseScale <= 1
            ? baseScale
            : Math.min(1, BASE_PREVIEW_EDGE / Math.max(documentWidth, documentHeight));
        if (!finite(desiredScale) || desiredScale <= previewScale * 1.05) return null;

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
        const originalUnderlayClipPath = underlayImage?.style?.clipPath || '';
        const originalUnderlayVisibility = underlayImage?.style?.visibility;
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
        let presented = null;
        let detailActive = false;
        let nativeUnderlayState = 'idle';
        let nativeUnderlayImage = null;
        let nativeUnderlayMounted = false;
        let nativeSampleCanvas = null;
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
            presented = null;
        }

        function cancelRequest() {
            const state = activeRequest;
            activeRequest = null;
            state?.controller.abort();
        }

        function cancelPending() {
            clearScheduledTimer();
            cancelRequest();
        }

        function hideTile() {
            canvas.style.display = 'none';
            canvas.width = 1;
            canvas.height = 1;
            restoreUnderlay();
        }

        function restoreUnderlay() {
            if (underlayImage?.style) underlayImage.style.clipPath = originalUnderlayClipPath;
            if (nativeUnderlayMounted && nativeUnderlayImage?.style) nativeUnderlayImage.style.clipPath = '';
        }

        function clipUnderlaysToTile(region) {
            const left = percent(region.x, documentWidth);
            const top = percent(region.y, documentHeight);
            const right = percent(region.x + region.width, documentWidth);
            const bottom = percent(region.y + region.height, documentHeight);
            // Keep the rest visible and prevent double compositing beneath transparent tile pixels.
            const clipPath = `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${left} ${top}, ${left} ${bottom}, ${right} ${bottom}, ${right} ${top}, ${left} ${top})`;
            if (underlayImage?.style) underlayImage.style.clipPath = clipPath;
            if (nativeUnderlayMounted && nativeUnderlayImage?.style) {
                nativeUnderlayImage.style.clipPath = clipPath;
            }
        }

        function mountNativeUnderlay() {
            if (nativeUnderlayMounted || !nativeUnderlayImage) return nativeUnderlayMounted;
            const image = nativeUnderlayImage;
            const style = image.style;
            if (!style) return false;
            try {
                image.setAttribute?.('aria-hidden', 'true');
                image.alt = '';
                image.draggable = false;
                Object.assign(style, {
                    position: 'absolute',
                    inset: '0',
                    width: '100%',
                    height: '100%',
                    pointerEvents: 'none',
                    display: 'none'
                });
                if (typeof host.insertBefore === 'function') host.insertBefore(image, canvas);
                else host.appendChild(image);
                nativeUnderlayMounted = true;
                return true;
            } catch (_) {
                nativeUnderlayState = 'failed';
                return false;
            }
        }

        function showNativeUnderlay() {
            if (destroyed || !detailActive || nativeUnderlayState !== 'ready'
                || !mountNativeUnderlay()) return;
            if (canvas.style.display === 'block' && presented) {
                clipUnderlaysToTile(presented.geometry.region);
            } else {
                restoreUnderlay();
            }
            if (nativeUnderlayImage.style.display !== 'block') nativeUnderlayImage.style.display = 'block';
            if (underlayImage?.style && underlayImage.style.visibility !== 'hidden') {
                underlayImage.style.visibility = 'hidden';
            }
        }

        function hideNativeUnderlay() {
            if (nativeUnderlayMounted && nativeUnderlayImage?.style) {
                if (nativeUnderlayImage.style.display !== 'none') nativeUnderlayImage.style.display = 'none';
                nativeUnderlayImage.style.clipPath = '';
            }
            if (underlayImage?.style && underlayImage.style.visibility !== originalUnderlayVisibility) {
                underlayImage.style.visibility = originalUnderlayVisibility;
            }
        }

        function ensureNativeUnderlay() {
            if (nativeUnderlayState !== 'idle' || typeof options.loadNativeUnderlay !== 'function') return;
            nativeUnderlayState = 'loading';
            let result;
            try { result = options.loadNativeUnderlay(); } catch (_) {
                nativeUnderlayState = 'failed';
                return;
            }
            Promise.resolve(result).then(image => {
                if (destroyed) return;
                if (!image || image.naturalWidth !== documentWidth
                    || image.naturalHeight !== documentHeight) {
                    nativeUnderlayState = 'failed';
                    return;
                }
                nativeUnderlayImage = image;
                nativeUnderlayState = 'ready';
                if (detailActive) showNativeUnderlay();
            }).catch(() => {
                if (!destroyed) nativeUnderlayState = 'failed';
            });
        }

        function setDetailActive(value) {
            const nextActive = Boolean(value);
            if (detailActive === nextActive) return;
            detailActive = nextActive;
            if (nextActive) {
                ensureNativeUnderlay();
                showNativeUnderlay();
            } else {
                hideNativeUnderlay();
            }
        }

        function invalidate() {
            if (destroyed) return;
            revision += 1;
            cancelPending();
            desired = null;
            releaseBitmaps();
            hideTile();
            options.onDetailStatus?.('idle');
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
            let baseScale;
            if (typeof options.getBaseScale === 'function') {
                try { baseScale = options.getBaseScale(); } catch (_) { baseScale = undefined; }
            }
            return viewportRegion(documentWidth, documentHeight, imageRect, workspaceRect,
                finite(dpr) && dpr > 0 ? dpr : 1, baseScale);
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

        function presentedMatches(target) {
            return Boolean(presented && presented.key === target.key);
        }

        function hasOriginalFor(target) {
            return presentedMatches(target) && Boolean(originalBitmap);
        }

        function targetFor(nextGeometry) {
            const nextGeometryKey = geometryKey(nextGeometry);
            if (desired && desired.geometryKey !== nextGeometryKey) {
                revision += 1;
                cancelPending();
                desired = null;
            }
            if (!desired) {
                desired = {
                    geometry: nextGeometry,
                    geometryKey: nextGeometryKey,
                    revision,
                    key: `${revision}:${nextGeometryKey}`
                };
            }
            return desired;
        }

        function schedule(immediate = false) {
            if (destroyed) return;
            const nextGeometry = geometry();
            if (!nextGeometry) {
                setDetailActive(false);
                if (desired) {
                    if (options.onLeaveDetail?.()) cancelPending();
                    else invalidate();
                }
                return;
            }
            setDetailActive(true);
            const target = targetFor(nextGeometry);
            if (activeRequest && activeRequest.key === target.key) {
                if (compare && !hasOriginalFor(target)) activeRequest.wantOriginal = true;
                return;
            }
            if (presentedMatches(target) && (!compare || originalBitmap)) {
                drawTile();
                return;
            }
            clearScheduledTimer();
            timer = timeout(() => {
                timer = null;
                void loadTile(target);
            }, immediate === true ? 0 : DEBOUNCE_MS);
        }

        function renderEdit(payload, signal) {
            if (destroyed || signal?.aborted) return false;
            const nextGeometry = geometry();
            if (!nextGeometry) return false;
            setDetailActive(true);
            // Editing is already serialized by the controller. Keep the last
            // tile visible and replace it only after the next crop has decoded.
            const target = targetFor(nextGeometry);
            cancelPending();
            return loadTile(target, {payload, signal});
        }

        function waitForRetry(signal, canContinue, delay) {
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
                }, delay);
            });
        }

        async function requestWithRetry(body, signal, canContinue) {
            let retries = 0;
            while (true) {
                if (signal.aborted || !canContinue()) throw abortError();
                try {
                    return await options.request(body, signal);
                } catch (error) {
                    if (error?.status !== 409) throw error;
                    const delay = options.getConflictRetryDelay
                        ? options.getConflictRetryDelay(retries)
                        : retries < MAX_CONFLICT_RETRIES ? RETRY_DELAY_MS : null;
                    if (!finite(delay)) throw error;
                    retries += 1;
                    await waitForRetry(signal, canContinue, delay);
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
            if (payload.native) body.native = true;
            if (original) body.original = true;
            return body;
        }

        async function loadTile(target, edit = null) {
            if (!current(target, null) || (!edit && !canRequest())) return false;
            const controller = new AbortControllerCtor();
            const state = {
                key: target.key,
                controller,
                wantOriginal: compare && !hasOriginalFor(target)
            };
            activeRequest = state;
            const onAbort = () => controller.abort();
            edit?.signal?.addEventListener('abort', onAbort, {once: true});
            const canContinue = () => current(target, state) && (edit !== null || canRequest());
            let nextEdited = null, nextOriginal = null;
            try {
                if (!edit) options.onDetailStatus?.('loading');
                const payload = edit ? edit.payload : clonePayload(options.getPayload());
                const load = async original => {
                    const body = bodyFor(payload, target, original);
                    const bitmap = edit ? await options.request(body, controller.signal)
                        : await requestWithRetry(body, controller.signal, canContinue);
                    if (!validBitmap(bitmap)) {
                        closeBitmap(bitmap);
                        throw new TypeError('Viewport request did not return a valid bitmap.');
                    }
                    return bitmap;
                };
                const targetWasPresented = presentedMatches(target);
                if (edit || !targetWasPresented || !editedBitmap) nextEdited = await load(false);
                if (!canContinue()) return false;
                if ((compare || state.wantOriginal)
                    && (!targetWasPresented || !originalBitmap)) {
                    nextOriginal = await load(true);
                }
                if (!canContinue()) return false;

                if (!targetWasPresented) {
                    if (compare && !nextOriginal) return false;
                    closeBitmap(editedBitmap);
                    closeBitmap(originalBitmap);
                    editedBitmap = nextEdited;
                    originalBitmap = nextOriginal;
                    nextEdited = null;
                    nextOriginal = null;
                    presented = target;
                } else {
                    if (nextEdited) {
                        closeBitmap(editedBitmap);
                        editedBitmap = nextEdited;
                        nextEdited = null;
                    }
                    if (nextOriginal) {
                        closeBitmap(originalBitmap);
                        originalBitmap = nextOriginal;
                        nextOriginal = null;
                    }
                }
                drawTile();
                if (!edit) options.onDetailStatus?.('ready');
                return true;
            } catch (error) {
                if (current(target, state)) {
                    if (edit) throw error;
                    if (error?.name !== 'AbortError') {
                        drawTile();
                        options.onDetailStatus?.('error');
                    }
                }
                return false;
            } finally {
                edit?.signal?.removeEventListener('abort', onAbort);
                closeBitmap(nextEdited);
                closeBitmap(nextOriginal);
                if (activeRequest === state) activeRequest = null;
            }
        }

        function drawTile() {
            if (destroyed || !presented || !editedBitmap || (compare && !originalBitmap)) {
                if (!destroyed) hideTile();
                return;
            }
            const {region} = presented.geometry;
            const width = editedBitmap.width, height = editedBitmap.height;
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width;
                canvas.height = height;
            }
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
                    context.clearRect(0, 0, width, height);
                    context.drawImage(originalBitmap, 0, 0, width, height);
                } else if (splitX > 0) {
                    context.save();
                    context.beginPath();
                    context.rect(0, 0, splitX, height);
                    context.clip();
                    context.clearRect(0, 0, width, height);
                    context.drawImage(originalBitmap, 0, 0, width, height);
                    context.restore();
                }
            }
            clipUnderlaysToTile(region);
            canvas.style.display = 'block';
        }

        function pointVisibleInWorkspace(x, y) {
            if (!finite(x) || !finite(y) || x < 0 || y < 0 || x >= documentWidth || y >= documentHeight) return false;
            if (typeof host.getBoundingClientRect !== 'function') return false;
            const image = bounds(host.getBoundingClientRect());
            const workspaceRect = clippedWorkspaceRect();
            if (!image || !workspaceRect) return false;
            const screenX = image.left + x * image.width / documentWidth;
            const screenY = image.top + y * image.height / documentHeight;
            return screenX >= workspaceRect.left && screenX < workspaceRect.left + workspaceRect.width
                && screenY >= workspaceRect.top && screenY < workspaceRect.top + workspaceRect.height;
        }

        function sampleNativeAt(x, y) {
            if (!detailActive || !nativeUnderlayMounted || !nativeUnderlayImage
                || nativeUnderlayImage.style?.display !== 'block' || !pointVisibleInWorkspace(x, y)) return null;
            if (!nativeSampleCanvas) {
                nativeSampleCanvas = document.createElement('canvas');
                nativeSampleCanvas.width = 1;
                nativeSampleCanvas.height = 1;
            }
            const context = nativeSampleCanvas.getContext('2d');
            if (!context) return null;
            context.clearRect(0, 0, 1, 1);
            context.drawImage(nativeUnderlayImage, Math.floor(x), Math.floor(y), 1, 1, 0, 0, 1, 1);
            return context.getImageData(0, 0, 1, 1)?.data ?? null;
        }

        function sampleAt(point) {
            if (!Array.isArray(point) || point.length < 2) return null;
            const [x, y] = point;
            if (canvas.style.display === 'block' && presented) {
                const {region} = presented.geometry;
                const localX = x - region.x, localY = y - region.y;
                if (localX >= 0 && localY >= 0 && localX < region.width && localY < region.height) {
                    const data = canvas.getContext('2d')?.getImageData(
                        Math.floor(localX * canvas.width / region.width),
                        Math.floor(localY * canvas.height / region.height), 1, 1,
                    )?.data;
                    if (data) return data;
                }
            }
            return sampleNativeAt(x, y);
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
            if (desired && compare && !hasOriginalFor(desired)) schedule();
        }

        function viewportEvent(event) {
            if (event && event.type === 'pointermove' && !(Number(event.buttons) > 0)) return;
            schedule(event?.type === 'pointerup' || event?.type === 'scrollend');
        }

        listen(workspace, 'scroll', viewportEvent, {passive: true});
        listen(workspace, 'scrollend', viewportEvent, {passive: true});
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
            cancelPending,
            schedule,
            renderEdit,
            sampleAt,
            setComparison,
            destroy() {
                if (destroyed) return;
                destroyed = true;
                setDetailActive(false);
                revision += 1;
                cancelPending();
                desired = null;
                releaseBitmaps();
                restoreUnderlay();
                nativeUnderlayImage?.remove?.();
                nativeUnderlayMounted = false;
                resizeObserver?.disconnect?.();
                resizeObserver = null;
                for (const [target, name, callback, listenerOptions] of listeners.splice(0)) {
                    target.removeEventListener?.(name, callback, listenerOptions);
                }
                canvas.remove?.();
            }
        };
    }

    return {create, viewportRegion, BASE_PREVIEW_EDGE};
});
