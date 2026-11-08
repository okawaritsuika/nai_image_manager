(function (root) {
    'use strict';

    const TILE_EDGE = 1024;
    const CPU_CACHE_LIMIT = 96 * 1024 * 1024;
    const SOURCE_ATLAS_CACHE_LIMIT = 160 * 1024 * 1024;
    const LOCAL_TILE_BUDGET_MS = 4;
    const IMAGE_DECODE_WAIT_MS = 250;
    let active, sourcePlan, rejectedPlan;

    function configureSources(layers, width, height, paused) {
        const previous = sourcePlan;
        sourcePlan = null;
        if (paused || !root.CanvasSourceTilesAvailable || !root.WebGL2RenderingContext ||
                width * height < 16_000_000 || layers.length > 32) return;
        if (sourcePlanContainsLayers(previous, layers, width, height)) {
            const layerIds = layers.map(layer => String(layer.id));
            sourcePlan = {...previous, baseId: layerIds[0], ids: new Set(layerIds)};
            return;
        }
        const sources = layers.map(layer => layer.src);
        if (new Set(sources).size < 4 || layers.some(layer => !['image', 'clip'].includes(layer.type) ||
                (layer.x || 0) !== 0 || (layer.y || 0) !== 0 || Number(layer.rotation || 0) % 360 !== 0 ||
                layer.layerWidth !== width || layer.layerHeight !== height ||
                Number(layer.imageWidth) !== width || Number(layer.imageHeight) !== height ||
                !/^\/(?:image|canvas-imports)\/[^?#]+$/.test(layer.src))) return;
        const layerIds = layers.map(layer => String(layer.id));
        const key = JSON.stringify([width, height, sources, layerIds]);
        if (key !== rejectedPlan) sourcePlan = {key, width, height, sources, layerIds,
            baseId: layerIds[0], ids: new Set(layerIds)};
    }

    function usesTiledSource(layer) {
        return sourcePlan?.ids.has(String(layer.id));
    }

    function showsSourceThumbnail(layer) {
        return sourcePlan?.baseId === String(layer.id);
    }

    function layerRecords(surface, layers) {
        const images = new Map([...surface.querySelectorAll('.canvas-render-layer.image-layer')]
            .map(node => [String(node.dataset.layerId), node.querySelector('img')]));
        return layers.filter(layer => images.get(String(layer.id))).map(layer => ({
            id: String(layer.id), image: images.get(String(layer.id)), src: layer.src,
            x: layer.x || 0, y: layer.y || 0,
            width: layer.layerWidth, height: layer.layerHeight,
            rotation: layer.type === 'clip' ? (Number(layer.rotation) || 0) % 360 : 0
        }));
    }

    function sourcePlanContainsRecords(plan, records) {
        if (!plan || !records.length || !Array.isArray(plan.layerIds)) return false;
        const sourcesById = new Map(plan.layerIds.map((id, index) => [id, plan.sources[index]]));
        let previousIndex = -1;
        return records.every(layer => {
            const index = plan.layerIds.indexOf(layer.id);
            if (index <= previousIndex || sourcesById.get(layer.id) !== layer.src ||
                    layer.x !== 0 || layer.y !== 0 || layer.width !== plan.width ||
                    layer.height !== plan.height || layer.rotation !== 0) return false;
            previousIndex = index;
            return true;
        });
    }

    function sourcePlanContainsLayers(plan, layers, width, height) {
        if (!plan || plan.width !== width || plan.height !== height || !layers.length ||
                !Array.isArray(plan.layerIds)) return false;
        const sourcesById = new Map(plan.layerIds.map((id, index) => [id, plan.sources[index]]));
        let previousIndex = -1;
        return layers.every(layer => {
            const id = String(layer.id);
            const index = plan.layerIds.indexOf(id);
            if (index <= previousIndex || sourcesById.get(id) !== layer.src ||
                    (layer.x || 0) !== 0 || (layer.y || 0) !== 0 ||
                    layer.layerWidth !== width || layer.layerHeight !== height ||
                    Number(layer.imageWidth) !== width || Number(layer.imageHeight) !== height ||
                    Number(layer.rotation || 0) % 360 !== 0) return false;
            previousIndex = index;
            return true;
        });
    }

    function samePlacement(left, right) {
        return left.src === right.src && left.x === right.x && left.y === right.y &&
            left.width === right.width && left.height === right.height && left.rotation === right.rotation;
    }

    function isVisibilitySubsetChange(previous, next) {
        if (!previous.length || !next.length || previous.length === next.length) return false;
        const previousById = new Map(previous.map(layer => [layer.id, layer]));
        const nextById = new Map(next.map(layer => [layer.id, layer]));
        const subset = previous.length > next.length ? nextById : previousById;
        const superset = previous.length > next.length ? previousById : nextById;
        return subset.size === Math.min(previous.length, next.length) &&
            [...subset].every(([id, layer]) => superset.has(id) && samePlacement(layer, superset.get(id)));
    }

    function sceneCacheKey(records, plan) {
        if (plan) return `tiles:${plan.key}:${JSON.stringify(records.map(layer => layer.id))}`;
        return `local:${JSON.stringify(records.map(({id, src, x, y, width, height, rotation}) =>
            [id, src, x, y, width, height, rotation]))}`;
    }

    function refresh({surface, workspace, width, height, layers, paused}) {
        if (!surface || !workspace || !root.CanvasEditorView || width * height < 4_000_000) {
            destroy(); return;
        }
        const records = layerRecords(surface, layers);
        if (!records.length || records.some(layer => !Number.isFinite(layer.width) || !Number.isFinite(layer.height) ||
            layer.width <= 0 || layer.height <= 0)) {destroy(); return;}
        if (active && (active.surface !== surface || active.width !== width || active.height !== height)) destroy();
        if (root.CanvasSourceTilesAvailable) configureSources(layers, width, height, paused);
        active ||= create(surface, workspace, width, height);
        active?.refresh(records, paused, sourcePlan);
    }

    function destroy() {
        active?.destroy();
        active = null;
        sourcePlan = null;
    }

    function create(surface, workspace, width, height) {
        const host = surface.ownerDocument.createElement('div');
        host.className = 'canvas-editor-scene';
        Object.assign(host.style, {position: 'absolute', inset: '0', pointerEvents: 'none'});
        const cache = new Map();
        const overviewLod = Math.max(16, 2 ** Math.ceil(Math.log2(Math.max(width, height) / 1024)));
        const metrics = {hits: 0, builds: 0, buildYields: 0, evictions: 0, peakBytes: 0, buildMs: 0, failures: 0,
            remoteLoads: 0, prefetches: 0, atlasHits: 0};
        const requests = new Map();
        const sourceAtlases = new Map(), atlasJobs = new Set();
        const renderJobs = new Map(), decodedSources = new WeakMap(), decodeJobs = new WeakMap(), decodeFailures = new WeakMap();
        let sourceAtlasBytes = 0;
        let records = [], bytes = 0, load = new AbortController(), coarse, retry, plan, failures = 0, closed = false;
        let lastRemoteBox, sceneKey = '';
        function fallback(visible) {surface.classList.toggle('canvas-editor-scene-active', !visible);}
        const view = root.CanvasEditorView.create({host, workspace, width, height,
            tiles: visibleTiles, overview, setFallback: fallback, onFailure: restoreOriginals});
        if (!view) return null;

        function intersect(layer, tile) {
            const {x, y, width: w, height: h, rotation} = layer;
            if (rotation) {
                const a = rotation * Math.PI / 180;
                const dx = (Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a))) / 2;
                const dy = (Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a))) / 2;
                return x + w / 2 + dx > tile.x && x + w / 2 - dx < tile.x + tile.width &&
                    y + h / 2 + dy > tile.y && y + h / 2 - dy < tile.y + tile.height;
            }
            return x + w > tile.x && x < tile.x + tile.width && y + h > tile.y && y < tile.y + tile.height;
        }

        function allocateTile(tile, lod) {
            const canvas = surface.ownerDocument.createElement('canvas');
            canvas.width = Math.ceil(tile.width / lod) + 2;
            canvas.height = Math.ceil(tile.height / lod) + 2;
            return {...tile, canvas, lod, revision: 0,
                frame: {x: 1, y: 1, width: tile.width / lod, height: tile.height / lod}};
        }

        function renderTile(tile, lod) {
            let job = renderJobs.get(tile.key);
            if (!job) {
                const result = allocateTile(tile, lod);
                const {canvas} = result;
                const sample = {x: tile.x - lod, y: tile.y - lod,
                    width: canvas.width * lod, height: canvas.height * lod};
                const ctx = canvas.getContext('2d');
                ctx.imageSmoothingQuality = 'high';
                ctx.setTransform(1 / lod, 0, 0, 1 / lod, -sample.x / lod, -sample.y / lod);
                job = {result, sample, ctx, index: 0, workMs: 0};
                renderJobs.set(tile.key, job);
            }
            const started = performance.now();
            while (job.index < records.length) {
                const layer = records[job.index++];
                const {sample, ctx} = job;
                if (!intersect(layer, sample)) continue;
                const {image, x, y, width: w, height: h, rotation} = layer;
                if (rotation) {
                    ctx.save();
                    ctx.translate(x + w / 2, y + h / 2);
                    ctx.rotate(rotation * Math.PI / 180);
                    ctx.drawImage(image, -w / 2, -h / 2, w, h);
                    ctx.restore();
                } else {
                    const left = Math.max(sample.x, x), top = Math.max(sample.y, y);
                    const right = Math.min(sample.x + sample.width, x + w);
                    const bottom = Math.min(sample.y + sample.height, y + h);
                    const sx = image.naturalWidth / w, sy = image.naturalHeight / h;
                    ctx.drawImage(image, (left - x) * sx, (top - y) * sy, (right - left) * sx, (bottom - top) * sy,
                        left, top, right - left, bottom - top);
                }
                if (performance.now() - started >= LOCAL_TILE_BUDGET_MS) break;
            }
            job.workMs += performance.now() - started;
            if (job.index < records.length) {
                metrics.buildYields += 1;
                return null;
            }
            renderJobs.delete(tile.key);
            metrics.builds += 1;
            metrics.buildMs += job.workMs;
            return job.result;
        }

        function imageSource(image) {
            return image.currentSrc || image.src || image.getAttribute?.('src') || '';
        }

        function ensureImageDecoded(image) {
            const source = imageSource(image);
            const pending = decodeJobs.get(image);
            if (!source || !image.complete || !image.naturalWidth ||
                    decodedSources.get(image) === source || pending?.source === source || decodeFailures.get(image) === source) return;
            if (typeof image.decode !== 'function') {
                decodedSources.set(image, source);
                return;
            }
            const job = {source};
            job.timeout = setTimeout(() => {
                if (decodeJobs.get(image) !== job) return;
                decodeFailures.set(image, source);
                decodeJobs.delete(image);
                if (!closed) view.schedule();
            }, IMAGE_DECODE_WAIT_MS);
            job.promise = Promise.resolve().then(() => image.decode()).then(() => {
                if (imageSource(image) === source) decodedSources.set(image, source);
            }).catch(() => {
                if (imageSource(image) === source) decodeFailures.set(image, source);
            }).finally(() => {
                clearTimeout(job.timeout);
                if (decodeJobs.get(image) === job) decodeJobs.delete(image);
                if (!closed) view.schedule();
            });
            decodeJobs.set(image, job);
            return job.promise;
        }

        function ready() {
            return records.length && records.every(({image}) => image.complete && image.naturalWidth &&
                (typeof image.decode !== 'function' || decodedSources.get(image) === imageSource(image) ||
                    decodeFailures.get(image) === imageSource(image)));
        }

        function tryTile(tile, lod) {
            if (retry !== undefined) return null;
            try {return renderTile(tile, lod);}
            catch (_) {
                renderJobs.delete(tile.key);
                metrics.failures += 1;
                retry = setTimeout(() => {retry = undefined; view.schedule();}, 150);
                return null;
            }
        }

        function remember(tile) {
            const previous = cache.get(tile.key);
            if (previous) bytes -= previous.canvas.width * previous.canvas.height * 4;
            cache.set(tile.key, tile);
            bytes += tile.canvas.width * tile.canvas.height * 4;
            metrics.peakBytes = Math.max(metrics.peakBytes, bytes);
            while (bytes > CPU_CACHE_LIMIT && cache.size > 1) {
                const [oldestKey, oldest] = cache.entries().next().value;
                cache.delete(oldestKey);
                bytes -= oldest.canvas.width * oldest.canvas.height * 4;
                metrics.evictions += 1;
            }
        }

        function atlasKey(sourcePlan, tile, lod) {
            return `${sourcePlan.key}|${tile.x}/${tile.y}/${tile.width}/${tile.height}/${lod}`;
        }

        function sceneTileKey(tile, key = sceneKey, lod = tile.lod) {
            return tile.overview ? `${key}|overview` : `${key}|${tile.x}/${tile.y}/${lod}`;
        }

        function dropAtlas(key, entry) {
            if (sourceAtlases.get(key) !== entry) return;
            sourceAtlases.delete(key);
            sourceAtlasBytes -= entry.size + entry.pixelBytes;
            entry.bitmap?.close();
            entry.bitmap = null;
        }

        function rememberAtlas(key, blob, bitmap) {
            const size = Number(blob?.size) || 0;
            const pixelBytes = bitmap.width * bitmap.height * 4;
            if (!size || size + pixelBytes > SOURCE_ATLAS_CACHE_LIMIT) return false;
            const previous = sourceAtlases.get(key);
            if (previous) dropAtlas(key, previous);
            const entry = {blob, size, bitmap, pixelBytes};
            sourceAtlases.set(key, entry);
            sourceAtlasBytes += size + pixelBytes;
            while (sourceAtlasBytes > SOURCE_ATLAS_CACHE_LIMIT && sourceAtlases.size) {
                const [oldestKey, oldest] = sourceAtlases.entries().next().value;
                dropAtlas(oldestKey, oldest);
            }
            return sourceAtlases.get(key) === entry && entry.bitmap === bitmap;
        }

        function retainAtlasBitmap(key, entry, bitmap) {
            if (sourceAtlases.get(key) !== entry || entry.bitmap) return false;
            const pixelBytes = bitmap.width * bitmap.height * 4;
            if (entry.size + pixelBytes > SOURCE_ATLAS_CACHE_LIMIT) return false;
            entry.bitmap = bitmap;
            entry.pixelBytes = pixelBytes;
            sourceAtlasBytes += pixelBytes;
            sourceAtlases.delete(key);
            sourceAtlases.set(key, entry);
            while (sourceAtlasBytes > SOURCE_ATLAS_CACHE_LIMIT && sourceAtlases.size) {
                const [oldestKey, oldest] = sourceAtlases.entries().next().value;
                dropAtlas(oldestKey, oldest);
            }
            return sourceAtlases.get(key) === entry && entry.bitmap === bitmap;
        }

        function compositeAtlasTile(tile, sourcePlan, bitmap, result = allocateTile(tile, tile.lod)) {
            result.key = tile.key;
            const {canvas} = result;
            const ctx = canvas.getContext('2d');
            for (let index = 0; index < sourcePlan.sources.length; index += 1) {
                if (!sourcePlan.visibleIds.has(sourcePlan.layerIds[index])) continue;
                ctx.drawImage(bitmap, 0, index * canvas.height, canvas.width, canvas.height,
                    0, 0, canvas.width, canvas.height);
            }
            return result;
        }

        function restoreCachedAtlas(tile, lod, sourcePlan) {
            const key = atlasKey(sourcePlan, tile, lod);
            const entry = sourceAtlases.get(key);
            if (!entry) return false;
            sourceAtlases.delete(key);
            sourceAtlases.set(key, entry);
            if (entry.bitmap) {
                const currentTile = {...tile, key: sceneTileKey(tile, sceneKey, lod), lod};
                const result = compositeAtlasTile(currentTile, plan, entry.bitmap);
                metrics.atlasHits += 1;
                if (result.key === `${sceneKey}|overview`) coarse = result;
                remember(result);
                return result;
            }
            if (atlasJobs.has(key)) return true;
            atlasJobs.add(key);
            root.createImageBitmap(entry.blob).then(bitmap => {
                let retained = false;
                try {
                    if (closed || !plan || plan.key !== sourcePlan.key) return;
                    const currentPlan = plan;
                    if (bitmap.width !== Math.ceil(tile.width / lod) + 2 ||
                            bitmap.height !== (Math.ceil(tile.height / lod) + 2) * currentPlan.sources.length) {
                        dropAtlas(key, entry);
                        return;
                    }
                    retained = retainAtlasBitmap(key, entry, bitmap);
                    const currentTile = {...tile, key: sceneTileKey(tile, sceneKey, lod), lod};
                    const result = compositeAtlasTile(currentTile, currentPlan, bitmap);
                    metrics.atlasHits += 1;
                    if (result.key === `${sceneKey}|overview`) coarse = result;
                    remember(result);
                } finally {if (!retained) bitmap.close();}
            }).catch(() => {
                dropAtlas(key, entry);
            }).finally(() => {
                atlasJobs.delete(key);
                if (!closed) view.schedule();
            });
            return true;
        }

        function clearAtlases() {
            for (const [key, entry] of sourceAtlases) dropAtlas(key, entry);
            atlasJobs.clear();
            sourceAtlasBytes = 0;
        }

        function cancelRequests(keep = new Set()) {
            for (const [key, controller] of requests) {
                if (keep.has(key)) continue;
                controller.abort();
                requests.delete(key);
            }
        }

        function restoreOriginals() {
            if (!plan) return;
            rejectedPlan = plan.key;
            if (sourcePlan?.key === plan.key || sourcePlanContainsRecords(plan, records)) sourcePlan = null;
            plan = null;
            cancelRequests();
            clearAtlases();
            renderJobs.clear();
            cache.clear(); bytes = 0;
            coarse = null;
            sceneKey = sceneCacheKey(records, null);
            view.setPaused(true);
            view.clear();
            for (const {image, src} of records) {
                image.addEventListener('load', () => {ensureImageDecoded(image); view.schedule();},
                    {once: true, signal: load.signal});
                image.src = src;
            }
            view.setPaused(false);
        }

        async function requestTile(tile, lod) {
            const current = plan;
            const requestKey = atlasKey(current, tile, lod);
            if (requests.size >= 2 || requests.has(requestKey) || retry !== undefined) return;
            const controller = new AbortController();
            requests.set(requestKey, controller);
            try {
                const result = allocateTile(tile, lod);
                const {canvas} = result;
                const sample = [tile.x - lod, tile.y - lod, canvas.width * lod, canvas.height * lod];
                const response = await root.fetch('/api/canvas/source-tile', {method: 'POST', signal: controller.signal,
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({sources: current.sources, document: [width, height], sample, lod})});
                if (!response.ok) {
                    if (response.status < 500 && response.status !== 429 && plan?.key === current.key &&
                            !controller.signal.aborted) {
                        restoreOriginals(); return;
                    }
                    throw new Error('The source tiles could not be prepared.');
                }
                const blob = await response.blob();
                const bitmap = await root.createImageBitmap(blob);
                let retained = false;
                try {
                    if (controller.signal.aborted || plan?.key !== current.key) return;
                    if (bitmap.width !== canvas.width || bitmap.height !== canvas.height * current.sources.length) {
                        if (plan?.key === current.key) restoreOriginals();
                        return;
                    }
                    retained = rememberAtlas(requestKey, blob, bitmap);
                    const currentPlan = plan;
                    const currentTile = {...tile, key: sceneTileKey(tile, sceneKey, lod), lod};
                    const currentResult = compositeAtlasTile(currentTile, currentPlan, bitmap, result);
                    metrics.remoteLoads += 1;
                    failures = 0;
                    if (currentResult.key === `${sceneKey}|overview`) coarse = currentResult;
                    remember(currentResult);
                } finally {if (!retained) bitmap.close();}
            } catch (_) {
                if (!controller.signal.aborted && plan?.key === current.key && retry === undefined) {
                    metrics.failures += 1;
                    if (++failures >= 3) restoreOriginals();
                    else retry = setTimeout(() => {retry = undefined; view.schedule();}, 300);
                }
            } finally {
                if (requests.get(requestKey) === controller) requests.delete(requestKey);
                if (!controller.signal.aborted) view.schedule();
            }
        }

        function overview() {
            const key = `${sceneKey}|overview`;
            if (!coarse) {
                coarse = cache.get(key) || null;
                if (coarse) {cache.delete(key); cache.set(key, coarse);}
            }
            if (!coarse && (plan || ready())) {
                const tile = {key, x: 0, y: 0, width, height, overview: true};
                if (plan) {
                    if (!restoreCachedAtlas(tile, overviewLod, plan)) requestTile(tile, overviewLod);
                }
                else {
                    coarse = tryTile(tile, overviewLod);
                    if (coarse) remember(coarse);
                }
            }
            return coarse;
        }

        function visibleTiles(box, lod, {cachedOnly = false} = {}) {
            if (!plan && !ready()) return null;
            if (plan && lod >= overviewLod) {
                if (!cachedOnly) cancelRequests(new Set([atlasKey(plan,
                    {x: 0, y: 0, width, height}, overviewLod)]));
                const whole = overview();
                return whole && whole.lod === lod ? [whole] : null;
            }
            const start = performance.now();
            const result = [];
            let pending = false;
            const lastX = box.x + box.width, lastY = box.y + box.height;
            const wanted = [];
            const viewBounds = [];
            const localTileKeys = new Set(!plan ? [`${sceneKey}|overview`] : []);
            const keep = new Set(plan ? [atlasKey(plan, {x: 0, y: 0, width, height}, overviewLod)] :
                [`${sceneKey}|overview`]);
            const edge = plan ? 512 : TILE_EDGE;
            for (let y = Math.floor(box.y / edge) * edge; y < lastY; y += edge) {
                for (let x = Math.floor(box.x / edge) * edge; x < lastX; x += edge) {
                    const key = `${sceneKey}|${x}/${y}/${lod}`;
                    const bounds = {key, x, y, width: Math.min(edge, width - x), height: Math.min(edge, height - y)};
                    viewBounds.push(bounds);
                    if (!plan) localTileKeys.add(key);
                    let tile = cache.get(key);
                    if (tile) {cache.delete(key); if (!cachedOnly) metrics.hits += 1;}
                    else if (cachedOnly) {pending = true; continue;}
                    else if (plan) {
                        const requestKey = atlasKey(plan, bounds, lod);
                        keep.add(requestKey);
                        const restored = restoreCachedAtlas(bounds, lod, plan);
                        if (restored && restored !== true) result.push(restored);
                        else {
                            if (!restored) wanted.push(bounds);
                            pending = true;
                        }
                        continue;
                    }
                    else if (performance.now() - start > 6 || retry !== undefined) {pending = true; continue;}
                    else {
                        tile = tryTile(bounds, lod);
                        if (!tile) {pending = true; continue;}
                        remember(tile);
                    }
                    cache.set(key, tile);
                    result.push(tile);
                }
            }
            if (!plan) {
                for (const key of renderJobs.keys()) if (!localTileKeys.has(key)) renderJobs.delete(key);
            }
            if (plan && !cachedOnly) {
                const previous = lastRemoteBox;
                lastRemoteBox = {x: box.x, y: box.y, lod};
                if (!pending && previous?.lod === lod) {
                    const dx = box.x - previous.x, dy = box.y - previous.y;
                    if (Math.max(Math.abs(dx), Math.abs(dy)) >= 8) {
                        const horizontal = Math.abs(dx) > Math.abs(dy);
                        const x = horizontal ? (dx > 0 ? Math.ceil(lastX / edge) * edge : (Math.floor(box.x / edge) - 1) * edge)
                            : Math.floor((box.x + box.width / 2) / edge) * edge;
                        const y = !horizontal ? (dy > 0 ? Math.ceil(lastY / edge) * edge : (Math.floor(box.y / edge) - 1) * edge)
                            : Math.floor((box.y + box.height / 2) / edge) * edge;
                        const key = `${sceneKey}|${x}/${y}/${lod}`;
                        const bounds = {key, x, y, width: Math.min(edge, width - x), height: Math.min(edge, height - y)};
                        const requestKey = atlasKey(plan, bounds, lod);
                        if (x >= 0 && y >= 0 && x < width && y < height && !cache.has(key)) {
                            keep.add(requestKey);
                            if (!requests.has(requestKey)) {
                                metrics.prefetches += 1;
                                if (!restoreCachedAtlas(bounds, lod, plan)) wanted.push(bounds);
                            }
                        }
                    }
                }
                cancelRequests(keep);
                for (const tile of wanted) requestTile(tile, lod);
            }
            const used = new Set(result);
            for (const [key, tile] of cache) {
                if (bytes <= CPU_CACHE_LIMIT) break;
                if (used.has(tile)) continue;
                cache.delete(key);
                metrics.evictions += 1;
                bytes -= tile.canvas.width * tile.canvas.height * 4;
            }
            if (pending) {if (!plan && !cachedOnly && retry === undefined) view.schedule(); return {partial: result, bounds: viewBounds};}
            return result;
        }

        function update(next, paused, nextPlan) {
            if (host.parentNode !== surface) surface.prepend(host);
            load.abort(); load = new AbortController();
            const retainSourceAtlas = sourcePlanContainsRecords(plan, next);
            const nextDataPlan = retainSourceAtlas ? plan : nextPlan;
            const nextVisibleIds = new Set(next.map(layer => layer.id));
            const nextPlanState = nextDataPlan ? {...nextDataPlan, visibleIds: nextVisibleIds} : null;
            const nextSceneKey = sceneCacheKey(next, nextPlanState);
            if (plan && !nextPlanState && !paused) {
                for (const {image, src} of next) if (image.getAttribute('src') !== src) image.src = src;
            }
            const sameScene = sceneKey === nextSceneKey && records.length === next.length && next.every((layer, i) =>
                layer.id === records[i].id && samePlacement(layer, records[i]));
            if (!sameScene) {
                const retainDisplay = isVisibilitySubsetChange(records, next);
                renderJobs.clear();
                if (!retainDisplay) {
                    view.setPaused(true);
                    view.clear();
                    cancelRequests();
                    cache.clear(); bytes = 0; coarse = null;
                }
                clearTimeout(retry); retry = undefined;
                failures = 0; lastRemoteBox = undefined;
                sceneKey = nextSceneKey;
                coarse = cache.get(`${sceneKey}|overview`) || null;
                if (coarse) {cache.delete(coarse.key); cache.set(coarse.key, coarse);}
            }
            records = next;
            if (!sameScene || !plan) plan = nextPlanState;
            for (const {image} of records) {
                if (!image.complete) image.addEventListener('load', () => {
                    if (!nextPlanState && !paused) ensureImageDecoded(image);
                    view.schedule();
                }, {once: true, signal: load.signal});
                else if (!nextPlanState && !paused) ensureImageDecoded(image);
            }
            view.setPaused(Boolean(paused));
            view.schedule();
        }

        return {surface, width, height, refresh: update, schedule: view.schedule, present: view.present,
            pause(paused) {if (paused) cancelRequests(); view.setPaused(paused);},
            stats: () => ({gpu: view.stats(), cpu: {...metrics, bytes, atlasBytes: sourceAtlasBytes}}),
            destroy() {closed = true; load.abort(); cancelRequests(); clearTimeout(retry); clearAtlases(); renderJobs.clear(); view.destroy(); cache.clear(); coarse = null; host.remove();}};
    }

    root.CanvasEditorScene = {refresh, destroy, configureSources, usesTiledSource, showsSourceThumbnail,
        schedule: () => active?.schedule(), present: () => active?.present(),
        pause: paused => active?.pause(paused),
        stats: () => active?.stats()};
})(globalThis);
