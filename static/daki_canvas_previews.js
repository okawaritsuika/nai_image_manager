/* Lazy, page-scoped previews for canvases linked to Daki projects. */
(function (root) {
    'use strict';

    const ERROR_TEXT = '통합 그림을 표시할 수 없습니다.';

    function create() {
        const controller = new root.AbortController();
        const signal = controller.signal;
        const entries = new Map();
        const queue = [];
        const observed = new Map();
        let running = 0;
        let disposed = false;
        let observer = null;

        function setBusy(container, busy) {
            container.setAttribute('aria-busy', String(busy));
            if (busy) container.setAttribute('role', 'status');
        }

        function loading(container) {
            container.textContent = '불러오는 중…';
            container.classList?.remove('daki-warning');
            setBusy(container, true);
        }

        function failure(container) {
            if (disposed) return;
            container.textContent = ERROR_TEXT;
            container.classList?.add('daki-warning');
            container.setAttribute('role', 'status');
            setBusy(container, false);
        }

        function success(container, canvas, dataUrl) {
            if (disposed) return;
            const img = root.document.createElement('img');
            img.src = dataUrl;
            img.alt = `${canvas.name} · 통합 미리보기`;
            img.title = img.alt;
            img.className = 'daki-canvas-preview-image';
            container.replaceChildren(img);
            container.classList?.remove('daki-warning');
            container.removeAttribute('role');
            setBusy(container, false);
        }

        function finish(entry, error, dataUrl) {
            if (disposed) return;
            entry.state = error ? 'failed' : 'ready';
            entry.error = error || null;
            entry.dataUrl = dataUrl || null;
            for (const subscriber of entry.subscribers) {
                if (observer && observed.delete(subscriber.container)) observer.unobserve(subscriber.container);
                if (error) failure(subscriber.container);
                else success(subscriber.container, subscriber.canvas, dataUrl);
            }
            entry.subscribers.length = 0;
        }

        function addPreviewParameter(src, layer) {
            const dimension = (...values) => values.map(Number).find(value => Number.isFinite(value) && value > 0);
            const width = dimension(layer.layerWidth, layer.imageWidth);
            const height = dimension(layer.layerHeight, layer.imageHeight);
            if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return src;

            const url = new URL(src, root.location.href);
            if (url.origin !== root.location.origin
                || !(url.pathname.startsWith('/image/') || url.pathname.startsWith('/canvas-imports/'))) return src;
            url.searchParams.set('preview', '768');
            return url.href;
        }

        function loadImage(src, layer) {
            signal.throwIfAborted();
            return new Promise((resolve, reject) => {
                const img = new root.Image();
                let settled = false;
                const cleanup = () => {
                    img.removeEventListener('load', onLoad);
                    img.removeEventListener('error', onError);
                    signal.removeEventListener('abort', onAbort);
                };
                const settle = (callback, value) => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    callback(value);
                };
                const onLoad = () => settle(resolve, img);
                const onError = () => settle(reject, new Error('이미지를 불러올 수 없습니다.'));
                const onAbort = () => {
                    img.src = '';
                    settle(reject, signal.reason || new Error('미리보기 생성이 취소되었습니다.'));
                };
                img.addEventListener('load', onLoad);
                img.addEventListener('error', onError);
                signal.addEventListener('abort', onAbort, {once: true});
                try {
                    img.src = addPreviewParameter(src, layer);
                } catch (error) {
                    settle(reject, error);
                }
            });
        }

        async function render(entry) {
            let state = entry.compositeState;
            if (entry.kind === 'project') {
                const {projectId, canvas} = entry;
                const response = await root.fetch(
                    `/api/daki/projects/${encodeURIComponent(projectId)}/canvases/${encodeURIComponent(canvas.id)}`,
                    {signal}
                );
                signal.throwIfAborted();
                const result = await response.json();
                signal.throwIfAborted();
                const detail = result?.canvas;
                if (!response.ok || result?.status !== 'success'
                    || String(result.project?.id) !== String(projectId)
                    || String(detail?.id) !== String(canvas.id)
                    || detail?.side !== canvas.side
                    || !detail?.state || !Array.isArray(detail.state.layers)) {
                    throw new Error('캔버스 응답을 확인할 수 없습니다.');
                }
                state = detail.state;
            }
            return root.renderMergedCanvasToDataUrl({
                state,
                maxDimension: 768,
                loadImage,
                signal,
            });
        }

        function pump() {
            while (!disposed && running < 2 && queue.length) {
                const entry = queue.shift();
                if (entry.state !== 'queued') continue;
                entry.state = 'loading';
                running++;
                render(entry).then(
                    dataUrl => finish(entry, null, dataUrl),
                    error => { if (!signal.aborted) finish(entry, error); }
                ).finally(() => {
                    running--;
                    pump();
                });
            }
        }

        function enqueue(entry) {
            if (disposed || entry.state !== 'waiting') return;
            entry.state = 'queued';
            queue.push(entry);
            pump();
        }

        if (typeof root.IntersectionObserver === 'function') {
            observer = new root.IntersectionObserver(records => {
                for (const record of records) {
                    if (!record.isIntersecting && !(record.intersectionRatio > 0)) continue;
                    const entry = observed.get(record.target);
                    observed.delete(record.target);
                    observer.unobserve(record.target);
                    if (entry) enqueue(entry);
                }
            }, {rootMargin: '200px'});
        }

        function observe(container, projectId, canvas) {
            if (disposed) return;
            loading(container);
            if (!projectId || !canvas?.id || canvas?.revision === undefined || canvas?.revision === null || !canvas?.side) {
                failure(container);
                return;
            }
            const key = JSON.stringify(['project', String(projectId), String(canvas.id), String(canvas.revision)]);
            let entry = entries.get(key);
            if (!entry) {
                entry = {kind: 'project', projectId, canvas, state: 'waiting', subscribers: [], key};
                entries.set(key, entry);
            }
            const subscriber = {container, canvas};
            if (entry.state === 'ready') {
                success(container, canvas, entry.dataUrl);
                return;
            }
            if (entry.state === 'failed') {
                failure(container);
                return;
            }
            entry.subscribers.push(subscriber);
            if (observer) {
                observed.set(container, entry);
                observer.observe(container);
            } else enqueue(entry);
        }

        function observeState(container, item) {
            if (disposed) return;
            loading(container);
            if (!item?.id || item.savedAt === undefined || item.savedAt === null
                || !item.state || !Array.isArray(item.state.layers)) {
                failure(container);
                return;
            }
            const key = JSON.stringify(['saved', String(item.id), String(item.savedAt)]);
            let entry = entries.get(key);
            if (!entry) {
                entry = {
                    kind: 'saved',
                    canvas: {name: String(item.name || '이름 없는 캔버스')},
                    compositeState: item.state,
                    state: 'waiting',
                    subscribers: [],
                    key,
                };
                entries.set(key, entry);
            }
            const subscriber = {container, canvas: entry.canvas};
            if (entry.state === 'ready') {
                success(container, entry.canvas, entry.dataUrl);
                return;
            }
            if (entry.state === 'failed') {
                failure(container);
                return;
            }
            entry.subscribers.push(subscriber);
            if (observer) {
                observed.set(container, entry);
                observer.observe(container);
            } else enqueue(entry);
        }

        function dispose() {
            if (disposed) return;
            disposed = true;
            observer?.disconnect();
            observed.clear();
            queue.length = 0;
            entries.clear();
            controller.abort();
        }

        return {observe, observeState, dispose};
    }

    root.DakiCanvasPreviews = {create};
})(typeof window === 'undefined' ? globalThis : window);
