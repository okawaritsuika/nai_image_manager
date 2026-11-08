(function (root) {
    'use strict';

    const CACHE_LIMIT = 128 * 1024 * 1024;
    const REGION_UPLOAD = 'canvas-editor-region';
    const pendingRegions = new WeakMap();
    const registeredUploaders = new WeakSet();
    let pixi;

    function loadPixi() {
        pixi ||= new Promise((resolve, reject) => {
            if (root.PIXI) {resolve(root.PIXI); return;}
            const script = root.document.createElement('script');
            script.src = '/static/vendor/pixijs/pixi.min.js?v=8.22.0';
            script.onload = () => root.PIXI ? resolve(root.PIXI) : reject(new Error('PixiJS did not initialize.'));
            script.onerror = () => reject(new Error('PixiJS is unavailable.'));
            root.document.head.append(script);
        });
        return pixi;
    }

    function registerRegionUploader(library) {
        if (!library.ExtensionType?.TextureUploaderWebGL || !library.extensions?.add) return false;
        if (registeredUploaders.has(library)) return true;
        library.extensions.add({
            extension: {type: library.ExtensionType.TextureUploaderWebGL, name: REGION_UPLOAD},
            upload(source, target, gl) {
                const patch = pendingRegions.get(source);
                if (patch && target.width === source.pixelWidth && target.height === source.pixelHeight) {
                    gl.texSubImage2D(target.target, 0, patch.x, patch.y, target.format, target.type, patch.canvas);
                    patch.uploaded = true;
                } else {
                    // Pixi can reallocate an evicted GPU texture before an update.
                    gl.texImage2D(target.target, 0, target.internalFormat, source.pixelWidth,
                        source.pixelHeight, 0, target.format, target.type, source.resource);
                    target.width = source.pixelWidth;
                    target.height = source.pixelHeight;
                }
            }
        });
        registeredUploaders.add(library);
        return true;
    }

    function nextLod(scale, previous) {
        const ideal = Math.max(1, Math.min(64, 2 ** Math.floor(Math.log2(1 / scale))));
        if (!previous || ideal === previous) return ideal;
        if (ideal < previous && scale < 1.08 / previous) return previous;
        if (ideal > previous && scale > .92 / (previous * 2)) return previous;
        return ideal;
    }

    function create({host, workspace, width, height, tiles, overview, setFallback, onFailure}) {
        if (!workspace || !root.WebGL2RenderingContext || !root.ResizeObserver) return null;
        const cache = new Map();
        const retired = new Set();
        const projections = new Map();
        const metrics = {frames: 0, uploads: 0, partialUploads: 0, uploadBytes: 0, hits: 0, evictions: 0, lodChanges: 0,
            waitingFrames: 0, overviewFrames: 0, partialFrames: 0, peakBytes: 0, preparationMs: 0, submissionMs: 0};
        let library, app, scene, canvas, observer, regionCanvas, canUploadRegion;
        let frame = 0, bytes = 0, closed = false, paused = false;
        let lastWidth = 0, lastHeight = 0, lastResolution = 0;
        let requestedLod, displayedLod, nearest, ownsDisplay = false;
        let detailLod, overviewEntry;
        let displayed = [];

        function release(entry) {
            bytes -= entry.bytes;
            metrics.evictions += 1;
            entry.sprite.destroy({texture: true, textureSource: true});
        }

        function evict(key, entry) {
            cache.delete(key);
            if (entry.sprite.parent) retired.add(entry);
            else release(entry);
        }

        function clear() {
            scene?.removeChildren();
            releaseProjections();
            for (const [key, entry] of cache) evict(key, entry);
            for (const entry of retired) release(entry);
            retired.clear();
            displayed = [];
            requestedLod = displayedLod = detailLod = nearest = overviewEntry = undefined;
        }

        function releaseProjections() {
            for (const [key, entry] of projections) {
                if (entry.sprite.parent) continue;
                projections.delete(key);
                entry.sprite.destroy({texture: true, textureSource: false});
            }
        }

        function showFallback() {
            if (canvas) canvas.hidden = true;
            if (ownsDisplay) {ownsDisplay = false; setFallback(true);}
        }

        function destroy() {
            if (closed) return;
            closed = true;
            if (frame) root.cancelAnimationFrame(frame);
            workspace.removeEventListener('scroll', schedule);
            observer?.disconnect();
            canvas?.removeEventListener('webglcontextlost', fail);
            if (regionCanvas) {regionCanvas.width = 0; regionCanvas.height = 0;}
            clear();
            try {
                if (app?.renderer) app.destroy({removeView: true}, {children: true});
            } finally {setFallback(true);}
        }

        function fail() {
            try {destroy();} finally {onFailure?.();}
        }

        function fillLod(entry, tile, lod) {
            if (entry.padding) {tile.fillTexture(entry.resource, lod); return;}
            if (lod === 1 || tile.lod === lod) return;
            const ctx = entry.resource.getContext('2d');
            ctx.clearRect(0, 0, entry.resource.width, entry.resource.height);
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(tile.canvas, 0, 0, entry.resource.width, entry.resource.height);
        }

        function textureKey(tile, lod, pointSample) {
            return `${tile.key}/${lod}/${tile.fillTexture && !pointSample ? 1 : 0}`;
        }

        function uploadRegion(entry, tile, lod, pointSample) {
            const damage = tile.damage;
            if (!canUploadRegion || !pointSample || lod !== 1 || entry.padding || !damage ||
                entry.revision === undefined || entry.revision < damage.from ||
                damage.width * damage.height >= tile.width * tile.height / 2) return 0;
            const {x, y, width, height} = damage;
            regionCanvas ||= host.ownerDocument.createElement('canvas');
            if (regionCanvas.width !== width) regionCanvas.width = width;
            if (regionCanvas.height !== height) regionCanvas.height = height;
            const ctx = regionCanvas.getContext('2d');
            if (!ctx) return 0;
            ctx.globalCompositeOperation = 'copy';
            ctx.drawImage(tile.canvas, x, y, width, height, 0, 0, width, height);
            const patch = {x, y, canvas: regionCanvas, uploaded: false};
            const method = entry.source.uploadMethodId;
            pendingRegions.set(entry.source, patch);
            entry.source.uploadMethodId = REGION_UPLOAD;
            try {entry.source.update();}
            catch (_) {return 0;}
            finally {
                entry.source.uploadMethodId = method;
                pendingRegions.delete(entry.source);
            }
            return patch.uploaded ? width * height * 4 : entry.bytes;
        }

        function textureFor(tile, lod, pointSample) {
            const padding = tile.fillTexture && !pointSample ? 1 : 0;
            const key = textureKey(tile, lod, pointSample);
            let entry = cache.get(key);
            if (!entry || entry.tile !== tile) {
                if (entry) evict(key, entry);
                const useSource = !padding && (lod === 1 || tile.lod === lod);
                const resource = useSource ? tile.canvas : host.ownerDocument.createElement('canvas');
                if (!useSource) {
                    resource.width = Math.ceil(tile.width / lod) + 2 * padding;
                    resource.height = Math.ceil(tile.height / lod) + 2 * padding;
                }
                const source = new library.CanvasSource({resource, autoGenerateMipmaps: false});
                const bounds = tile.frame || (padding && {x: padding, y: padding,
                    width: tile.width / lod, height: tile.height / lod});
                const texture = new library.Texture({source, ...(bounds ? {
                    frame: new library.Rectangle(bounds.x, bounds.y, bounds.width, bounds.height)
                } : {})});
                const sprite = new library.Sprite({texture});
                sprite.position.set(tile.x, tile.y);
                sprite.width = tile.width;
                sprite.height = tile.height;
                entry = {tile, resource, source, sprite, padding, bytes: resource.width * resource.height * 4};
                cache.set(key, entry);
                bytes += entry.bytes;
                metrics.peakBytes = Math.max(metrics.peakBytes, bytes);
            }
            const revision = (padding && tile.textureRevision) || tile.revision;
            if (entry.revision !== revision) {
                const regionBytes = uploadRegion(entry, tile, lod, pointSample);
                if (regionBytes === 0) {
                    fillLod(entry, tile, lod);
                    entry.source.update();
                    if (entry.revision === undefined) app.renderer.texture?.initSource?.(entry.source);
                } else if (regionBytes < entry.bytes) {
                    metrics.partialUploads += 1;
                }
                if (tile.damage && lod === 1 && pointSample) tile.damage = null;
                entry.revision = revision;
                metrics.uploads += 1;
                metrics.uploadBytes += regionBytes || entry.bytes;
            } else metrics.hits += 1;
            cache.delete(key);
            cache.set(key, entry);
            return entry;
        }

        function prepareTiles(available, lod, pointSample, cachedOnly) {
            const missing = available.filter(tile => cache.get(textureKey(tile, lod, pointSample))?.tile !== tile);
            if (!missing.length) return true;
            if (cachedOnly) return false;
            const activeBytes = displayed.reduce((sum, entry) => sum + entry.bytes, 0);
            const required = missing.reduce((sum, tile) => sum + tile.canvas.width * tile.canvas.height * 4, 0);
            // A large visible set can use the normal atomic swap without trying
            // to keep a second set of the same size resident during preparation.
            if (activeBytes + required > CACHE_LIMIT) return true;
            const protectedKeys = new Set(available.map(tile => textureKey(tile, lod, pointSample)));
            for (const [key, entry] of cache) {
                if (bytes + required <= CACHE_LIMIT) break;
                if (!entry.sprite.parent && entry !== overviewEntry && !protectedKeys.has(key)) evict(key, entry);
            }
            const start = performance.now();
            for (let index = 0; index < missing.length; index += 1) {
                if (index > 0 && performance.now() - start > 4) return false;
                textureFor(missing[index], lod, pointSample);
            }
            return true;
        }

        function projectedEntry(coarse, tile) {
            let entry = projections.get(tile.key);
            if (entry) return entry;
            overviewEntry = textureFor(coarse, coarse.lod, false);
            const source = overviewEntry.source;
            if (source.scaleMode !== 'linear') source.scaleMode = 'linear';
            const {x, y} = coarse.frame || {x: 0, y: 0};
            const frame = new library.Rectangle(x + tile.x / coarse.lod, y + tile.y / coarse.lod,
                tile.width / coarse.lod, tile.height / coarse.lod);
            const sprite = new library.Sprite({texture: new library.Texture({source, frame})});
            sprite.position.set(tile.x, tile.y);
            sprite.width = tile.width;
            sprite.height = tile.height;
            entry = {sprite, source, bytes: 0, projection: true};
            projections.set(tile.key, entry);
            return entry;
        }

        function render(cachedOnly = false) {
            frame = 0;
            if (paused || closed || !app?.renderer) return;
            try {
                const started = performance.now();
                const docBox = host.getBoundingClientRect();
                const view = workspace.getBoundingClientRect();
                const viewLeft = Math.floor(view.left + workspace.clientLeft);
                const viewTop = Math.floor(view.top + workspace.clientTop);
                const drawWidth = workspace.clientWidth, drawHeight = workspace.clientHeight;
                const left = Math.max(docBox.left, viewLeft), top = Math.max(docBox.top, viewTop);
                const right = Math.min(docBox.right, viewLeft + drawWidth);
                const bottom = Math.min(docBox.bottom, viewTop + drawHeight);
                if (right <= left || bottom <= top) {canvas.hidden = true; return;}
                const resolution = root.devicePixelRatio || 1;
                const scaleX = docBox.width / width, scaleY = docBox.height / height;
                const scale = Math.max(scaleX, scaleY) * resolution;
                requestedLod = nextLod(scale, requestedLod);
                if (nearest === undefined) nearest = scale >= 1;
                else if (nearest && scale < .92) nearest = false;
                else if (!nearest && scale >= 1.08) nearest = true;
                const offsetX = viewLeft - docBox.left, offsetY = viewTop - docBox.top;
                const x = Math.floor((left - docBox.left) / scaleX), y = Math.floor((top - docBox.top) / scaleY);
                const box = {x, y, width: Math.min(width, Math.ceil((right - docBox.left) / scaleX)) - x,
                    height: Math.min(height, Math.ceil((bottom - docBox.top) / scaleY)) - y};
                let coarse = !ownsDisplay ? overview?.() : null;
                let lod = requestedLod;
                let visible = tiles(box, lod, {cachedOnly, nearest: lod === 1 && nearest});
                let incomplete, entries;
                if (visible && !Array.isArray(visible)) {
                    incomplete = visible;
                    prepareTiles(visible.partial, lod, lod === 1 && nearest, cachedOnly);
                    visible = null;
                }
                if (visible && visible.reduce((total, tile) => total +
                        (Math.ceil(tile.width / lod) + 2) * (Math.ceil(tile.height / lod) + 2) * 4, 0) > CACHE_LIMIT) {
                    visible = null;
                }
                if (visible && overview && !prepareTiles(visible, lod, lod === 1 && nearest, cachedOnly)) {
                    incomplete = {partial: visible, bounds: visible};
                    visible = null;
                    schedule();
                }
                if (!visible) {
                    metrics.waitingFrames += 1;
                    if (cachedOnly) schedule();
                    if (displayedLod && displayedLod !== lod) {
                        const old = tiles(box, displayedLod, {cachedOnly: true, nearest: displayedLod === 1 && nearest});
                        if (Array.isArray(old)) {lod = displayedLod; visible = old;}
                    }
                    if (!visible && overview && detailLod === lod && incomplete?.bounds) {
                        coarse ||= overview();
                        const prepared = new Map(incomplete.partial.filter(tile =>
                            cache.get(textureKey(tile, lod, lod === 1 && nearest))?.tile === tile)
                            .map(tile => [tile.key, tile]));
                        if (coarse && prepared.size) {
                            entries = incomplete.bounds.map(tile => prepared.has(tile.key)
                                ? textureFor(prepared.get(tile.key), lod, lod === 1 && nearest)
                                : projectedEntry(coarse, tile));
                            metrics.partialFrames += 1;
                        }
                    }
                    if (!visible && !entries && overview) {
                        coarse ||= overview();
                        if (coarse) {visible = [coarse]; lod = coarse.lod; metrics.overviewFrames += 1;}
                    }
                    if (!visible && !entries) return;
                }
                entries ||= visible.map(tile => textureFor(tile, lod, lod === 1 && nearest));
                if (visible && !visible[0]?.overview && visible[0]?.key !== 'overview') detailLod = lod;
                else if (visible) overviewEntry = entries[0];
                if (lastWidth !== drawWidth || lastHeight !== drawHeight || lastResolution !== resolution) {
                    app.renderer.resize(drawWidth, drawHeight, resolution);
                    lastWidth = drawWidth; lastHeight = drawHeight; lastResolution = resolution;
                }
                canvas.style.left = offsetX + 'px';
                canvas.style.top = offsetY + 'px';
                scene.position.set(-offsetX, -offsetY);
                scene.scale.set(scaleX, scaleY);
                if (entries.length !== displayed.length || entries.some((entry, index) => entry !== displayed[index])) {
                    scene.removeChildren();
                    for (const {sprite} of entries) scene.addChild(sprite);
                    displayed = entries;
                }
                for (const {source, projection} of entries) {
                    const mode = !projection && lod === 1 && nearest ? 'nearest' : 'linear';
                    if (source.scaleMode !== mode) source.scaleMode = mode;
                }
                const ready = performance.now();
                // WebGL uploads and draws are ordered on the same context. Present the
                // new sprite set before releasing textures used by the previous frame.
                app.render();
                metrics.frames += 1;
                metrics.preparationMs += ready - started;
                metrics.submissionMs += performance.now() - ready;
                if (displayedLod !== undefined && displayedLod !== lod) metrics.lodChanges += 1;
                displayedLod = lod;
                for (const entry of retired) release(entry);
                retired.clear();
                releaseProjections();
                for (const [key, entry] of cache) {
                    if (bytes <= CACHE_LIMIT) break;
                    if (!entry.sprite.parent && entry !== overviewEntry) evict(key, entry);
                }
                canvas.hidden = false;
                if (!ownsDisplay) {ownsDisplay = true; setFallback(false);}
            } catch (_) {fail();}
        }

        function schedule() {
            if (!closed && !paused && !frame && scene) frame = root.requestAnimationFrame(() => render());
        }

        function present() {
            if (!ownsDisplay || paused || closed) return;
            if (frame) root.cancelAnimationFrame(frame);
            render(true);
        }

        function setPaused(value) {
            if (paused === value || closed) return;
            paused = value;
            if (paused) showFallback();
            schedule();
        }

        (async () => {
            try {
                library = await loadPixi();
                if (closed) return;
                canUploadRegion = registerRegionUploader(library);
                const candidate = new library.Application();
                await candidate.init({preference: 'webgl', preferWebGLVersion: 2,
                    width: 1, height: 1, autoStart: false, autoDensity: true,
                    sharedTicker: false, backgroundAlpha: 0, antialias: false,
                    eventMode: 'none', powerPreference: 'high-performance'});
                if (closed) {candidate.destroy({removeView: true}, {children: true}); return;}
                app = candidate;
                if (!(app.renderer.gl instanceof root.WebGL2RenderingContext)) {fail(); return;}
                canUploadRegion &&= Boolean(app.renderer.texture?._uploads?.[REGION_UPLOAD]);
                canvas = app.canvas;
                canvas.className = 'canvas-editor-gpu-view';
                canvas.setAttribute('aria-hidden', 'true');
                canvas.hidden = true;
                Object.assign(canvas.style, {position: 'absolute', inset: 'auto', pointerEvents: 'none', zIndex: '0'});
                canvas.addEventListener('webglcontextlost', fail);
                scene = new library.Container();
                app.stage.addChild(scene);
                host.appendChild(canvas);
                observer = new root.ResizeObserver(schedule);
                observer.observe(host); observer.observe(workspace);
                workspace.addEventListener('scroll', schedule, {passive: true});
                schedule();
            } catch (_) {fail();}
        })();

        return {schedule, present, setPaused, destroy, clear,
            stats: () => ({...metrics, bytes, displayedLod, requestedLod, ownsDisplay})};
    }

    root.CanvasEditorView = {create};
})(globalThis);
