(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CanvasRetouchSurface = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const TILE_EDGE = 1024;
    const BRUSH = () => (typeof globalThis !== 'undefined' ? globalThis.CanvasRetouchBrush : null);
    const LIQUIFY = () => (typeof globalThis !== 'undefined' ? globalThis.CanvasRetouchLiquify : null);

    function positiveInteger(value, label) {
        const number = Number(value);
        if (!Number.isInteger(number) || number <= 0) throw new RangeError(label + ' must be a positive integer.');
        return number;
    }

    function imageWidth(image) {
        return image && image.naturalWidth !== undefined ? Number(image.naturalWidth) : Number(image?.width);
    }

    function imageHeight(image) {
        return image && image.naturalHeight !== undefined ? Number(image.naturalHeight) : Number(image?.height);
    }

    function makeCanvas(document, width, height) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d', {willReadFrequently: true});
        if (!context) throw new Error('A 2D canvas context is required for native retouch pixels.');
        return {canvas, context};
    }

    function clearCanvas(canvas) {
        if (!canvas) return;
        canvas.width = 0;
        canvas.height = 0;
    }

    function copyInto(context, source, width, height) {
        context.clearRect(0, 0, width, height);
        context.drawImage(source, 0, 0, width, height);
    }

    function clonePixelsCanvas(document, source, width, height) {
        const copy = makeCanvas(document, width, height);
        copyInto(copy.context, source, width, height);
        return copy;
    }

    function cleanPoints(points) {
        if (!Array.isArray(points)) return [];
        const result = [];
        for (const point of points) {
            if (!point || point.length < 2) continue;
            const x = Number(point[0]);
            const y = Number(point[1]);
            if (Number.isFinite(x) && Number.isFinite(y)) result.push([x, y]);
        }
        return result;
    }

    function samePoint(left, right) {
        return left[0] === right[0] && left[1] === right[1];
    }

    function prefixMatches(previous, next) {
        if (next.length < previous.length) return false;
        for (let index = 0; index < previous.length; index += 1) {
            if (!samePoint(previous[index], next[index])) return false;
        }
        return true;
    }

    function copyStroke(stroke, kind) {
        return {
            brush: kind === 'airbrush' ? 'airbrush' : stroke.brush,
            tool: kind,
            radius: stroke.radius,
            hardness: stroke.hardness,
            flow: stroke.flow,
            opacity: stroke.opacity,
            color: stroke.color,
            mode: stroke.mode,
            strength: stroke.strength,
            points: []
        };
    }

    function copyLayer(layer) {
        const mask = layer.mask || {};
        const opacity = layer.opacity === undefined ? 1 : Number(layer.opacity);
        return {
            type: layer.type,
            visible: layer.visible !== false,
            opacity,
            mask: {
                base: mask.base,
                strokeCount: Array.isArray(mask.strokes) ? mask.strokes.length : (mask.strokes ? 1 : 0),
                hasShape: Boolean(mask.shape)
            },
            params: {mode: layer.params?.mode || 'normal'}
        };
    }

    function brushRadius(stroke) {
        const value = Number(stroke.radius);
        return Number.isFinite(value) ? Math.max(1, Math.min(800, value)) : 80;
    }

    function create(options) {
        const args = options || {};
        const host = args.host;
        if (!host || typeof host.appendChild !== 'function' || !host.ownerDocument ||
                typeof host.ownerDocument.createElement !== 'function') {
            throw new TypeError('A host element with an owner document is required.');
        }
        const width = positiveInteger(args.width, 'Surface width');
        const height = positiveInteger(args.height, 'Surface height');
        const source = args.source;
        if (!source || imageWidth(source) !== width || imageHeight(source) !== height) {
            throw new RangeError('Decoded source dimensions must match the native surface dimensions.');
        }

        const document = host.ownerDocument;
        const surface = document.createElement('div');
        surface.className = 'canvas-retouch-native-surface';
        Object.assign(surface.style, {
            position: 'absolute', inset: '0', width: '100%', height: '100%',
            pointerEvents: 'none', zIndex: '0'
        });

        const tiles = new Map();
        const stagedTiles = new Set();
        let originalSource = source;
        let active = null;
        let pending = [];
        const provisional = new Set();
        let provisionalRegions;
        let comparison = false;
        let comparisonSplit = 50;
        let destroyed = false;
        let readCanvas = null;
        let readContext = null;
        let gpuView = null;
        let idleFrame = null;

        function adjacent(tile) {
            const result = [];
            for (let dy = -TILE_EDGE; dy <= TILE_EDGE; dy += TILE_EDGE) {
                for (let dx = -TILE_EDGE; dx <= TILE_EDGE; dx += TILE_EDGE) {
                    const neighbor = tileAt(tile.x + dx, tile.y + dy);
                    if (neighbor) result.push(neighbor);
                }
            }
            return result;
        }

        function mergeRects(left, right) {
            if (!left) return {...right};
            return {x: Math.min(left.x, right.x), y: Math.min(left.y, right.y),
                width: Math.max(left.x + left.width, right.x + right.width) - Math.min(left.x, right.x),
                height: Math.max(left.y + left.height, right.y + right.height) - Math.min(left.y, right.y)};
        }

        function mergeDamage(left, right) {
            const rect = mergeRects(left, right);
            return {...rect, from: left?.from ?? right.from};
        }

        function revise(tile, damage) {
            const from = tile.revision;
            tile.revision += 1;
            const rect = damage === undefined ? {x: 0, y: 0, width: tile.width, height: tile.height} : damage;
            const clipped = {x: Math.max(0, rect.x), y: Math.max(0, rect.y),
                width: Math.min(tile.width, rect.x + rect.width) - Math.max(0, rect.x),
                height: Math.min(tile.height, rect.y + rect.height) - Math.max(0, rect.y)};
            if (clipped.width > 0 && clipped.height > 0) {
                tile.damage = mergeDamage(tile.damage, {...clipped, from});
            }
            for (const neighbor of adjacent(tile)) neighbor.textureRevision += 1;
        }

        function touch(tile, damage) {
            if (damage === null) return;
            revise(tile, damage);
            gpuView?.schedule();
        }

        function hydrate(tile) {
            let changed = false;
            if (!tile.hydrated && originalSource) {
                tile.context.drawImage(originalSource, tile.x, tile.y, tile.width, tile.height,
                    0, 0, tile.width, tile.height);
                tile.hydrated = true;
                changed = true;
            }
            if (!stagedTiles.delete(tile)) {
                if (changed) revise(tile);
                return;
            }
            for (const patch of tile.staged) writePatch(patch, tile, tile.context);
            tile.staged = null;
            revise(tile);
        }

        function drainStaged(deadline) {
            idleFrame = null;
            for (const tile of stagedTiles) {
                if (!deadline.didTimeout && deadline.timeRemaining() < 3) break;
                hydrate(tile);
                if (deadline.didTimeout) break;
            }
            scheduleDrain();
        }

        function scheduleDrain() {
            if (stagedTiles.size && idleFrame === null && globalThis.requestIdleCallback) {
                idleFrame = globalThis.requestIdleCallback(drainStaged, {timeout: 200});
            }
        }

        function keyFor(x, y) { return x + ',' + y; }

        function tileAt(x, y) {
            return tiles.get(keyFor(Math.floor(x / TILE_EDGE), Math.floor(y / TILE_EDGE)));
        }

        function makeTile(x, y, tileWidth, tileHeight) {
            const made = makeCanvas(document, tileWidth, tileHeight);
            made.canvas.className = 'canvas-retouch-native-tile';
            Object.assign(made.canvas.style, {
                position: 'absolute', left: (x / width * 100) + '%', top: (y / height * 100) + '%',
                width: (tileWidth / width * 100) + '%', height: (tileHeight / height * 100) + '%',
                pointerEvents: 'none'
            });
            const tile = {
                x, y, width: tileWidth, height: tileHeight,
                key: keyFor(Math.floor(x / TILE_EDGE), Math.floor(y / TILE_EDGE)),
                hydrated: false,
                damage: null,
                revision: 0,
                textureRevision: 0,
                canvas: made.canvas, context: made.context,
                confirmed: null, confirmedContext: null,
                original: null, originalContext: null
            };
            tile.fillTexture = (resource, lod) => fillTexture(tile, resource, lod);
            surface.appendChild(tile.canvas);
            return tile;
        }

        function fillTexture(tile, resource, lod) {
            const ctx = resource.getContext('2d');
            const x = tile.x - lod, y = tile.y - lod;
            const right = x + resource.width * lod, bottom = y + resource.height * lod;
            ctx.clearRect(0, 0, resource.width, resource.height);
            ctx.imageSmoothingQuality = 'high';
            for (const neighbor of adjacent(tile)) {
                const left = Math.max(x, neighbor.x), top = Math.max(y, neighbor.y);
                const w = Math.min(right, neighbor.x + neighbor.width) - left;
                const h = Math.min(bottom, neighbor.y + neighbor.height) - top;
                if (w <= 0 || h <= 0) continue;
                ctx.drawImage(neighbor.canvas, left - neighbor.x, top - neighbor.y, w, h,
                    (left - x) / lod, (top - y) / lod, w / lod, h / lod);
            }
        }

        function closeSnapshot(state) {
            if (!state) return;
            state.brush?.dispose?.();
            state.brush = null;
            if (!state.snapshot) return;
            if (state.snapshot.owned !== false) clearCanvas(state.snapshot.canvas);
            state.snapshot = null;
        }

        function ensureConfirmed(tile) {
            hydrate(tile);
            if (!tile.confirmed) {
                const copied = clonePixelsCanvas(document, tile.canvas, tile.width, tile.height);
                tile.confirmed = copied.canvas;
                tile.confirmedContext = copied.context;
            }
        }

        function releaseConfirmed(tile) {
            clearCanvas(tile.confirmed);
            tile.confirmed = tile.confirmedContext = null;
        }

        function releaseUnusedConfirmed(keys) {
            const used = visibleOptimisticKeys();
            for (const key of keys) {
                if (!used.has(key)) releaseConfirmed(tiles.get(key));
            }
        }

        function ensureOriginal(tile) {
            if (!tile.original && originalSource) {
                const copied = makeCanvas(document, tile.width, tile.height);
                copied.context.drawImage(originalSource, tile.x, tile.y, tile.width, tile.height,
                    0, 0, tile.width, tile.height);
                copied.canvas.className = 'canvas-retouch-native-original';
                copied.canvas.hidden = true;
                Object.assign(copied.canvas.style, {
                    position: 'absolute', left: (tile.x / width * 100) + '%', top: (tile.y / height * 100) + '%',
                    width: (tile.width / width * 100) + '%', height: (tile.height / height * 100) + '%',
                    pointerEvents: 'none'
                });
                tile.original = copied.canvas;
                tile.originalContext = copied.context;
                surface.appendChild(tile.original);
            }
            return tile.original;
        }

        function updateComparisonTile(tile) {
            const splitX = width * comparisonSplit / 100;
            const visibleWidth = Math.max(0, Math.min(tile.width, splitX - tile.x));
            if (!comparison) {
                tile.canvas.hidden = false;
                tile.canvas.style.clipPath = 'none';
                if (tile.original) tile.original.hidden = true;
                return;
            }
            tile.canvas.hidden = visibleWidth >= tile.width;
            if (visibleWidth <= 0) tile.canvas.style.clipPath = 'none';
            else if (visibleWidth < tile.width) tile.canvas.style.clipPath = 'inset(0 0 0 ' + (visibleWidth / tile.width * 100) + '%)';
            if (!tile.original) return;
            tile.original.hidden = visibleWidth <= 0;
            if (tile.original.hidden) return;
            if (visibleWidth >= tile.width) tile.original.style.clipPath = 'none';
            else tile.original.style.clipPath = 'inset(0 ' + (100 - visibleWidth / tile.width * 100) + '% 0 0)';
        }

        function newBrush(stroke, tile) {
            const brush = BRUSH();
            if (!brush || typeof brush.create !== 'function') return null;
            return brush.create(stroke, tile.width, tile.height, tile.width, tile.height,
                {origin: [tile.x, tile.y], scale: 1});
        }

        function ensureActiveSnapshot(activeStroke, tile) {
            if (!activeStroke.states.has(tile.key)) {
                ensureConfirmed(tile);
                const alreadyOptimistic = provisional.has(tile.key) || pending.some(entry => entry.tiles.has(tile.key));
                const snapshot = alreadyOptimistic
                    ? {...clonePixelsCanvas(document, tile.canvas, tile.width, tile.height), owned: true}
                    : {canvas: tile.confirmed, context: tile.confirmedContext, owned: false};
                activeStroke.states.set(tile.key, {snapshot, brush: null});
                activeStroke.tiles.add(tile.key);
            }
            return activeStroke.states.get(tile.key);
        }

        function readNative(box, confirmed = false) {
            const patchWidth = box.right - box.left;
            const patchHeight = box.bottom - box.top;
            if (!readCanvas) {
                const made = makeCanvas(document, patchWidth, patchHeight);
                readCanvas = made.canvas;
                readContext = made.context;
            } else {
                if (readCanvas.width < patchWidth) readCanvas.width = patchWidth;
                if (readCanvas.height < patchHeight) readCanvas.height = patchHeight;
            }
            readContext.clearRect(0, 0, patchWidth, patchHeight);
            const firstX = Math.floor(box.left / TILE_EDGE);
            const firstY = Math.floor(box.top / TILE_EDGE);
            const lastX = Math.floor((box.right - 1) / TILE_EDGE);
            const lastY = Math.floor((box.bottom - 1) / TILE_EDGE);
            for (let tileY = firstY; tileY <= lastY; tileY += 1) {
                for (let tileX = firstX; tileX <= lastX; tileX += 1) {
                    const tile = tiles.get(keyFor(tileX, tileY));
                    if (!tile) continue;
                    hydrate(tile);
                    const left = Math.max(box.left, tile.x);
                    const top = Math.max(box.top, tile.y);
                    const right = Math.min(box.right, tile.x + tile.width);
                    const bottom = Math.min(box.bottom, tile.y + tile.height);
                    if (confirmed && !tile.confirmed) ensureConfirmed(tile);
                    const image = confirmed ? tile.confirmed : tile.canvas;
                    readContext.drawImage(image, left - tile.x, top - tile.y, right - left, bottom - top,
                        left - box.left, top - box.top, right - left, bottom - top);
                }
            }
            return readContext.getImageData(0, 0, patchWidth, patchHeight);
        }

        function writeNative(pixels, left, top, target = null, confirmed = false, trackEntry = null, dirty = null) {
            const patchLeft = left + (dirty?.left || 0);
            const patchTop = top + (dirty?.top || 0);
            const right = left + (dirty?.right ?? pixels.width);
            const bottom = top + (dirty?.bottom ?? pixels.height);
            if (right <= patchLeft || bottom <= patchTop) return;
            const firstX = Math.floor(patchLeft / TILE_EDGE);
            const firstY = Math.floor(patchTop / TILE_EDGE);
            const lastX = Math.floor((right - 1) / TILE_EDGE);
            const lastY = Math.floor((bottom - 1) / TILE_EDGE);
            for (let tileY = firstY; tileY <= lastY; tileY += 1) {
                for (let tileX = firstX; tileX <= lastX; tileX += 1) {
                    const tile = tiles.get(keyFor(tileX, tileY));
                    if (!tile) continue;
                    hydrate(tile);
                    const writeLeft = Math.max(patchLeft, tile.x);
                    const writeTop = Math.max(patchTop, tile.y);
                    const writeRight = Math.min(right, tile.x + tile.width);
                    const writeBottom = Math.min(bottom, tile.y + tile.height);
                    const partWidth = writeRight - writeLeft;
                    const partHeight = writeBottom - writeTop;
                    const sourceLeft = writeLeft - left;
                    const sourceTop = writeTop - top;
                    if (confirmed) {
                        ensureConfirmed(tile);
                        tile.confirmedContext.putImageData(pixels, left - tile.x, top - tile.y,
                            sourceLeft, sourceTop, partWidth, partHeight);
                    } else {
                        if (target) ensureActiveSnapshot(target, tile);
                        else if (trackEntry) ensureConfirmed(tile);
                        tile.context.putImageData(pixels, left - tile.x, top - tile.y,
                            sourceLeft, sourceTop, partWidth, partHeight);
                        touch(tile, {x: writeLeft - tile.x, y: writeTop - tile.y,
                            width: partWidth, height: partHeight});
                        if (target) target.tiles.add(tile.key);
                        if (trackEntry) trackEntry.tiles.add(tile.key);
                    }
                }
            }
        }

        function newLiquify(entry, target = null, confirmed = false, trackEntry = null) {
            const liquify = LIQUIFY();
            if (!liquify || typeof liquify.createNative !== 'function') return null;
            return liquify.createNative(entry.stroke, {
                width, height, opacity: entry.layer.opacity,
                read: box => readNative(box, confirmed),
                write: (pixels, left, top, dirty) =>
                    writeNative(pixels, left, top, target, confirmed, trackEntry, dirty)
            });
        }

        function applyStrokeToContext(stroke, layer, tile, context) {
            const brush = newBrush(stroke, tile);
            if (!brush) return null;
            try {
                brush.append(stroke.points);
                return brush.paint(context, {mode: layer.params.mode, opacity: layer.opacity});
            } finally {
                brush.dispose?.();
            }
        }

        function activeState(activeStroke, tile) {
            const state = ensureActiveSnapshot(activeStroke, tile);
            state.brush = newBrush(activeStroke.stroke, tile);
            if (state.brush) state.brush.append(activeStroke.points);
            return state;
        }

        function restoreActiveState(activeStroke, tile, state) {
            if (!state?.snapshot) return;
            const damage = state.brush ? state.brush.paint(tile.context, {
                mode: activeStroke.layer.params.mode,
                opacity: activeStroke.layer.opacity,
                baseContext: state.snapshot.context
            }) : null;
            touch(tile, damage);
        }

        function addBoundsTiles(keys, left, top, right, bottom) {
            const clippedLeft = Math.max(0, left);
            const clippedTop = Math.max(0, top);
            const clippedRight = Math.min(width, right);
            const clippedBottom = Math.min(height, bottom);
            if (clippedRight <= clippedLeft || clippedBottom <= clippedTop) return;
            const firstTileX = Math.floor(clippedLeft / TILE_EDGE);
            const firstTileY = Math.floor(clippedTop / TILE_EDGE);
            const lastTileX = Math.floor(Math.max(clippedLeft, clippedRight - 1e-9) / TILE_EDGE);
            const lastTileY = Math.floor(Math.max(clippedTop, clippedBottom - 1e-9) / TILE_EDGE);
            for (let tileY = firstTileY; tileY <= lastTileY; tileY += 1) {
                for (let tileX = firstTileX; tileX <= lastTileX; tileX += 1) keys.add(keyFor(tileX, tileY));
            }
        }

        function segmentTileKeys(stroke, previousPoints, points, startIndex) {
            const result = new Set();
            const radius = brushRadius(stroke.stroke);
            if (!previousPoints.length && points.length) {
                const first = points[0];
                addBoundsTiles(result, first[0] - radius - 1, first[1] - radius - 1,
                    first[0] + radius + 1, first[1] + radius + 1);
            }
            for (let index = Math.max(1, startIndex); index < points.length; index += 1) {
                const from = points[index - 1];
                const to = points[index];
                if (!from || !to) continue;
                addBoundsTiles(result, Math.min(from[0], to[0]) - radius - 1,
                    Math.min(from[1], to[1]) - radius - 1,
                    Math.max(from[0], to[0]) + radius + 1,
                    Math.max(from[1], to[1]) + radius + 1);
            }
            return result;
        }

        function processActiveAppend(activeStroke, nextPoints, previousLength) {
            if (activeStroke.kind === 'liquify') {
                activeStroke.points = nextPoints;
                activeStroke.stroke.points = nextPoints;
                activeStroke.engine?.append(nextPoints);
                return;
            }
            const changedKeys = segmentTileKeys(activeStroke, activeStroke.points, nextPoints, previousLength);
            activeStroke.points = nextPoints;
            activeStroke.stroke.points = nextPoints;
            for (const key of changedKeys) {
                const [tileX, tileY] = key.split(',').map(Number);
                const tile = tiles.get(key);
                if (!tile || tileX * TILE_EDGE !== tile.x || tileY * TILE_EDGE !== tile.y) continue;
                let state = activeStroke.states.get(key);
                if (!state) state = activeState(activeStroke, tile);
                if (state.brush) state.brush.append(nextPoints);
                restoreActiveState(activeStroke, tile, state);
            }
        }

        function replayEntry(entry, target = null, confirmed = false) {
            if (entry.kind === 'liquify') {
                const engine = newLiquify(entry, target, confirmed, target || confirmed ? null : entry);
                engine?.append(entry.stroke.points);
                return;
            }
            for (const key of entry.tiles) {
                const tile = tiles.get(key);
                if (!tile) continue;
                if (confirmed) ensureConfirmed(tile);
                const context = confirmed ? tile.confirmedContext : tile.context;
                const damage = applyStrokeToContext(entry.stroke, entry.layer, tile, context);
                if (!confirmed) touch(tile, damage);
            }
        }

        function rebuildOptimistic(keys) {
            for (const key of keys) {
                const tile = tiles.get(key);
                if (!tile) continue;
                ensureConfirmed(tile);
                copyInto(tile.context, tile.confirmed, tile.width, tile.height);
                touch(tile);
            }
            for (const entry of pending) replayEntry(entry);
            if (!active) return;

            const priorActiveTiles = new Set(active.tiles);
            for (const state of active.states.values()) closeSnapshot(state);
            active.states.clear();
            active.tiles.clear();
            if (active.kind === 'liquify') {
                active.engine = newLiquify(active, active, false);
                active.engine?.append(active.points);
                return;
            }
            for (const key of priorActiveTiles) {
                const tile = tiles.get(key);
                if (!tile || !keys.has(key)) continue;
                const state = ensureActiveSnapshot(active, tile);
                state.brush = newBrush(active.stroke, tile);
                if (state.brush) {
                    state.brush.append(active.points);
                    restoreActiveState(active, tile, state);
                }
            }
        }

        function visibleOptimisticKeys() {
            const keys = new Set(provisional);
            for (const entry of pending) for (const key of entry.tiles) keys.add(key);
            if (active) for (const key of active.tiles) keys.add(key);
            return keys;
        }

        function patchTiles(region) {
            const result = [];
            const firstX = Math.floor(region.x / TILE_EDGE);
            const firstY = Math.floor(region.y / TILE_EDGE);
            const lastX = Math.floor((region.x + region.width - 1) / TILE_EDGE);
            const lastY = Math.floor((region.y + region.height - 1) / TILE_EDGE);
            for (let tileY = firstY; tileY <= lastY; tileY += 1) {
                for (let tileX = firstX; tileX <= lastX; tileX += 1) {
                    const tile = tiles.get(keyFor(tileX, tileY));
                    if (tile) result.push(tile);
                }
            }
            return result;
        }

        function validRegion(region) {
            if (!region || !Number.isInteger(region.x) || !Number.isInteger(region.y) ||
                    !Number.isInteger(region.width) || !Number.isInteger(region.height) ||
                    region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 ||
                    region.x + region.width > width || region.y + region.height > height) {
                throw new RangeError('Patch region must be an integer rectangle inside the native surface.');
            }
        }

        try {
            for (let y = 0; y < height; y += TILE_EDGE) {
                for (let x = 0; x < width; x += TILE_EDGE) {
                    const tile = makeTile(x, y, Math.min(TILE_EDGE, width - x), Math.min(TILE_EDGE, height - y));
                    tiles.set(tile.key, tile);
                }
            }
            host.appendChild(surface);
        } catch (error) {
            for (const tile of tiles.values()) clearCanvas(tile.canvas);
            surface.remove?.();
            throw error;
        }

        gpuView = globalThis.CanvasEditorView?.create({host, workspace: args.workspace, width, height,
            tiles: (region, _lod, options) => {
                const visible = patchTiles(region);
                for (const tile of visible) hydrate(tile);
                if (!options?.nearest && stagedTiles.size) {
                    for (const tile of visible) for (const neighbor of adjacent(tile)) hydrate(neighbor);
                }
                return visible;
            },
            setFallback: visible => {
                if (visible && !destroyed) for (const tile of tiles.values()) hydrate(tile);
                surface.hidden = !visible;
            }
        });

        if (!gpuView) {
            try {
                for (const tile of tiles.values()) hydrate(tile);
            } catch (error) {
                destroyed = true;
                for (const tile of tiles.values()) clearCanvas(tile.canvas);
                surface.remove?.();
                if (surface.parentNode === host) host.removeChild(surface);
                throw error;
            }
        }

        function beginStroke(stroke, layer, version) {
            const kind = stroke && (stroke.brush === 'airbrush' || stroke.tool === 'airbrush') ? 'airbrush' :
                stroke && stroke.tool === 'liquify' ? 'liquify' : null;
            if (destroyed || active || !kind ||
                    !layer || layer.type !== (kind === 'airbrush' ? 'paint' : 'liquify') || layer.visible === false ||
                    !Number.isFinite(Number(layer.opacity === undefined ? 1 : layer.opacity)) ||
                    Number(layer.opacity === undefined ? 1 : layer.opacity) <= 0 ||
                    !layer.mask || layer.mask.base !== 1 ||
                    (Array.isArray(layer.mask.strokes) && layer.mask.strokes.length > 0) ||
                    (!Array.isArray(layer.mask.strokes) && Boolean(layer.mask.strokes)) ||
                    Boolean(layer.mask.shape) || !Number.isFinite(version)) return false;
            if (kind === 'airbrush' && !BRUSH()?.create) return false;
            if (kind === 'liquify' && !LIQUIFY()?.createNative) return false;
            const strokeCopy = copyStroke(stroke, kind);
            const layerCopy = copyLayer(layer);
            active = {kind, version, stroke: strokeCopy, layer: layerCopy, points: [], states: new Map(), tiles: new Set(), engine: null};
            const points = cleanPoints(stroke.points);
            if (!points.length) {active = null; return false;}
            if (kind === 'liquify') active.engine = newLiquify(active, active, false);
            processActiveAppend(active, points, 0);
            return true;
        }

        function appendStroke(points) {
            if (destroyed || !active) return false;
            const clean = cleanPoints(points);
            if (clean.length === active.points.length && prefixMatches(active.points, clean)) return false;
            if (!prefixMatches(active.points, clean)) {
                for (const [key, state] of active.states) {
                    const tile = tiles.get(key);
                    if (tile && state.snapshot) {
                        copyInto(tile.context, state.snapshot.canvas, tile.width, tile.height);
                        touch(tile);
                    }
                    closeSnapshot(state);
                }
                active.points = [];
                active.stroke.points = [];
                active.states.clear();
                active.tiles.clear();
                if (active.kind === 'liquify') active.engine = newLiquify(active, active, false);
                processActiveAppend(active, clean, 0);
                return true;
            }
            processActiveAppend(active, clean, active.points.length);
            return true;
        }

        function endStroke(commit = true) {
            if (!active) return;
            const ended = active;
            active = null;
            if (commit) {
                pending.push({kind: ended.kind, version: ended.version, stroke: ended.stroke,
                    layer: ended.layer, tiles: new Set(ended.tiles)});
                for (const state of ended.states.values()) closeSnapshot(state);
                ended.states.clear();
                return;
            }
            for (const [key, state] of ended.states) {
                const tile = tiles.get(key);
                if (tile && state.snapshot) {
                    copyInto(tile.context, state.snapshot.canvas, tile.width, tile.height);
                    touch(tile);
                }
                closeSnapshot(state);
            }
            releaseUnusedConfirmed(ended.tiles);
        }

        function clearOptimistic(keepProvisional = false) {
            if (keepProvisional && !active && !pending.length) return;
            const keys = visibleOptimisticKeys();
            provisional.clear();
            if (active) {
                for (const state of active.states.values()) closeSnapshot(state);
                active.states.clear();
                active = null;
            }
            pending = [];
            for (const key of keys) {
                const tile = tiles.get(key);
                if (tile?.confirmed) {
                    copyInto(tile.context, tile.confirmed, tile.width, tile.height);
                    touch(tile);
                    releaseConfirmed(tile);
                }
            }
        }

        function retirePending(version) {
            const acknowledged = pending.filter(entry => entry.version <= version);
            pending = pending.filter(entry => entry.version > version);
            return acknowledged;
        }

        function acknowledge(version) {
            if (destroyed || !Number.isFinite(version)) return false;
            const acknowledged = pending.filter(entry => entry.version <= version);
            if (!acknowledged.length && !provisional.size) return false;
            const keys = new Set(provisional);
            provisional.clear();
            for (const entry of acknowledged) {
                for (const key of entry.tiles) keys.add(key);
            }
            retirePending(version);
            for (const key of visibleOptimisticKeys()) keys.add(key);
            rebuildOptimistic(keys);
            releaseUnusedConfirmed(keys);
            return true;
        }

        function replacePatches(patches, ackVersion) {
            if (destroyed) return false;
            if (!Number.isFinite(ackVersion)) throw new RangeError('Acknowledgement version must be finite.');
            for (const {image, pixels, region} of patches) {
                validRegion(region);
                const source = pixels || image;
                if (!source || imageWidth(source) !== region.width || imageHeight(source) !== region.height) {
                    throw new RangeError('Patch image dimensions must exactly match its region.');
                }
            }
            const keys = visibleOptimisticKeys();
            const pixelCount = patches.reduce((total, {region}) => total + region.width * region.height, 0);
            const stage = surface.hidden && globalThis.requestIdleCallback && pixelCount > 4_194_304 &&
                patches.every(patch => patch.pixels);
            if (stage && pixelCount === width * height) {
                for (const tile of stagedTiles) tile.staged = null;
                stagedTiles.clear();
            }
            for (const patch of patches) for (const tile of patchTiles(patch.region)) {
                const optimistic = keys.has(tile.key);
                if (optimistic) ensureConfirmed(tile);
                else {
                    if (tile.confirmed) releaseConfirmed(tile);
                    if (stage) {
                        tile.staged ||= [];
                        tile.staged.push(patch);
                        stagedTiles.add(tile);
                        continue;
                    }
                    hydrate(tile);
                }
                const damage = writePatch(patch, tile, optimistic ? tile.confirmedContext : tile.context);
                if (!optimistic) touch(tile, damage);
            }
            provisional.clear();
            retirePending(ackVersion);
            for (const key of visibleOptimisticKeys()) keys.add(key);
            rebuildOptimistic(keys);
            releaseUnusedConfirmed(keys);
            if (stage) {gpuView?.schedule(); scheduleDrain();}
            return true;
        }

        function writePatch({image, pixels, region}, tile, context) {
            const left = Math.max(region.x, tile.x), top = Math.max(region.y, tile.y);
            const right = Math.min(region.x + region.width, tile.x + tile.width);
            const bottom = Math.min(region.y + region.height, tile.y + tile.height);
            const patchX = left - region.x, patchY = top - region.y;
            const tileX = left - tile.x, tileY = top - tile.y;
            const patchWidth = right - left, patchHeight = bottom - top;
            if (pixels) {
                context.putImageData(pixels, region.x - tile.x, region.y - tile.y,
                    patchX, patchY, patchWidth, patchHeight);
            } else {
                context.clearRect(tileX, tileY, patchWidth, patchHeight);
                context.drawImage(image, patchX, patchY, patchWidth, patchHeight,
                    tileX, tileY, patchWidth, patchHeight);
            }
            return {x: tileX, y: tileY, width: patchWidth, height: patchHeight};
        }

        function showViewport(patches) {
            if (destroyed || active || pending.length || !patches.length) return;
            for (const {region} of patches) validRegion(region);
            const regions = patches.map(({region: {x, y, width, height}}) => [x, y, width, height].join(',')).join(';');
            // Slider changes repeatedly replace the same rectangle. Keep its
            // confirmed tiles, including pixels outside the viewport.
            if (!provisional.size || regions !== provisionalRegions) clearOptimistic();
            provisionalRegions = regions;
            const changed = new Map();
            for (const patch of patches) {
                for (const tile of patchTiles(patch.region)) {
                    ensureConfirmed(tile);
                    const damage = writePatch(patch, tile, tile.context);
                    provisional.add(tile.key);
                    changed.set(tile, mergeRects(changed.get(tile), damage));
                }
            }
            for (const [tile, damage] of changed) touch(tile, damage);
        }

        function replacePatch(image, region, ackVersion) {
            return replacePatches([{image, region}], ackVersion);
        }

        function setComparison(enabled, splitPercent) {
            if (destroyed) return;
            const next = Boolean(enabled);
            const value = Number(splitPercent);
            const split = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 50;
            if (comparison === next && (!next || comparisonSplit === split)) return;
            comparison = next;
            comparisonSplit = split;
            gpuView?.setPaused(comparison);
            if (comparison && originalSource) {
                const splitX = width * comparisonSplit / 100;
                for (const tile of tiles.values()) {
                    if (splitX > tile.x) ensureOriginal(tile);
                    updateComparisonTile(tile);
                }
            } else {
                for (const tile of tiles.values()) updateComparisonTile(tile);
            }
        }

        function sampleAt(point, original = false) {
            if (destroyed || !point || point.length < 2) return new Uint8ClampedArray(4);
            const xValue = Number(point[0]);
            const yValue = Number(point[1]);
            if (!Number.isFinite(xValue) || !Number.isFinite(yValue)) return new Uint8ClampedArray(4);
            const x = Math.max(0, Math.min(width - 1, Math.floor(xValue)));
            const y = Math.max(0, Math.min(height - 1, Math.floor(yValue)));
            const tile = tileAt(x, y);
            if (!tile) return new Uint8ClampedArray(4);
            hydrate(tile);
            let context = tile.context;
            if (original) {
                ensureOriginal(tile);
                context = tile.originalContext;
            }
            return new Uint8ClampedArray(context.getImageData(x - tile.x, y - tile.y, 1, 1).data);
        }

        function inspectRegion(region, original) {
            validRegion(region);
            const {x, y, width: w, height: h} = region;
            if (!original) return readNative({left: x, top: y, right: x + w, bottom: y + h});
            const {canvas, context} = makeCanvas(document, w, h);
            try {
                context.drawImage(originalSource, x, y, w, h, 0, 0, w, h);
                return context.getImageData(0, 0, w, h);
            } finally {clearCanvas(canvas);}
        }

        function destroy() {
            if (destroyed) return;
            destroyed = true;
            gpuView?.destroy();
            if (idleFrame !== null) globalThis.cancelIdleCallback?.(idleFrame);
            stagedTiles.clear();
            if (active) for (const state of active.states.values()) closeSnapshot(state);
            active = null;
            pending = [];
            provisional.clear();
            comparison = false;
            for (const tile of tiles.values()) {
                clearCanvas(tile.confirmed);
                clearCanvas(tile.original);
                clearCanvas(tile.canvas);
                tile.confirmed = tile.confirmedContext = null;
                tile.original = tile.originalContext = null;
            }
            tiles.clear();
            clearCanvas(readCanvas);
            readCanvas = readContext = null;
            surface.remove?.();
            if (surface.parentNode === host) host.removeChild(surface);
            originalSource = null;
        }

        return {replacePatch, replacePatches, acknowledge, beginStroke, appendStroke, endStroke, clearOptimistic,
            showViewport, setComparison, sampleAt, inspectRegion, destroy, scheduleView: () => gpuView?.schedule(),
            presentView: () => gpuView?.present(), viewStats: () => gpuView?.stats()};
    }

    return {create};
});
