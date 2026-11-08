(function (root) {
    'use strict';

    function create() {
        if (!root.Worker || !root.WebAssembly || !root.ImageData) return null;
        let worker;
        try {worker = new Worker('/static/canvas_editor_worker.js?v=8');}
        catch (_) {return null;}
        const requests = new Map();
        let nextId = 0;
        let closed = false;
        let loadedSource;

        function destroy(error = new DOMException('The canvas worker was closed.', 'AbortError')) {
            if (closed) return;
            closed = true;
            worker.terminate();
            for (const request of requests.values()) request.reject(error);
            requests.clear();
        }

        worker.onerror = event => destroy(new Error(event.message || 'The canvas worker stopped.'));
        worker.onmessageerror = () => destroy(new Error('The canvas worker response could not be decoded.'));
        worker.onmessage = ({data}) => {
            const request = requests.get(data.id);
            if (!request) return;
            if (data.cancelled) {
                requests.delete(data.id);
                request.reject(new DOMException('The canvas update was superseded.', 'AbortError'));
            } else if (data.error) {
                requests.delete(data.id);
                request.reject(new Error(data.error));
            } else if (data.done) {
                requests.delete(data.id);
                request.resolve({revision: data.revision, patches: request.patches, png: data.png, timings: data.timings});
            } else if (data.viewportReady) {
                request.showViewport?.(request.viewport, data.timings);
                request.viewport = [];
            } else if (data.region && data.pixels) {
                const {width, height} = data.region;
                const bytes = data.pixels;
                const rgba = new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                try {
                    const output = data.provisional ? request.viewport : request.patches;
                    output.push({region: data.region, pixels: new ImageData(rgba, width, height)});
                }
                catch (error) {destroy(error);}
            }
        };

        function send(kind, body, showViewport) {
            if (closed) return Promise.reject(new Error('The canvas worker is unavailable.'));
            return new Promise((resolve, reject) => {
                const id = ++nextId;
                requests.set(id, {kind, resolve, reject, patches: [], viewport: [], showViewport});
                try {worker.postMessage({id, kind, body});}
                catch (error) {destroy(error);}
            });
        }

        function cancelUpdate() {
            if (closed) return;
            for (const [id, request] of requests) {
                if ((request.kind !== 'update' && request.kind !== 'viewport') || request.cancelRequested) continue;
                request.cancelRequested = true;
                worker.postMessage({id, kind: 'cancel'});
            }
        }

        const ready = send('warm');
        ready.catch(() => {});
        async function render(kind, body, showViewport) {
            const {source, ...records} = body;
            const result = await send(kind, source === loadedSource ? records : body, showViewport);
            loadedSource = source;
            return result;
        }

        return {ready, prepare: body => render('prepare', body),
            update: (body, showViewport) => render('update', body, showViewport),
            preview: body => render('viewport', body), mask: body => send('mask', body),
            exportImage: body => send('export', body), cancelUpdate, destroy};
    }

    root.CanvasEditorEngine = {create};
})(globalThis);
