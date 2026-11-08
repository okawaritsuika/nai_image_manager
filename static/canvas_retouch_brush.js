(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CanvasRetouchBrush = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const MODES = new Set(['normal', 'soft-light', 'color', 'multiply', 'screen']);
    const MODE_INDEX = {normal: 0, 'soft-light': 1, color: 2, multiply: 3, screen: 4};
    const SOFT_LIGHT_DENOMINATOR = 1 - Math.exp(-4.5);
    let wasmBrush, wasmRequested = false, wasmPromise = null;
    let wasmHeapTop = 0;
    let wasmBlendScratch = null;
    const wasmFreeBlocks = [];

    function prepareNative() {
        if (wasmRequested) return wasmPromise || Promise.resolve(false);
        if (!globalThis.document || !globalThis.location || !globalThis.WebAssembly ||
                typeof globalThis.fetch !== 'function') return Promise.resolve(false);
        wasmRequested = true;
        wasmPromise = fetch('/static/canvas_editor/brush.wasm?v=5').then(response => {
            if (!response.ok) throw new Error('Native brush kernel is unavailable.');
            return response.arrayBuffer();
        }).then(WebAssembly.instantiate).then(({instance}) => {
            wasmBrush = instance.exports;
            wasmHeapTop = Math.ceil(wasmBrush.__heap_base.value / 16) * 16;
            wasmBlendScratch = null;
            wasmFreeBlocks.length = 0;
            return true;
        }).catch(() => false); // The same blend calculation is available in JavaScript.
        return wasmPromise;
    }

    function ensureMemory(memory, end) {
        const available = memory.buffer.byteLength;
        if (end > available) memory.grow(Math.ceil((end - available) / 65536));
    }

    function allocateBytes(byteLength) {
        if (!wasmBrush || !Number.isFinite(byteLength) || byteLength <= 0) return null;
        const size = Math.ceil(byteLength / 16) * 16;
        let index = wasmFreeBlocks.findIndex(block => block.size >= size);
        let block;
        if (index >= 0) {
            block = wasmFreeBlocks[index];
            wasmFreeBlocks.splice(index, 1);
            if (block.size > size) {
                wasmFreeBlocks.push({ptr: block.ptr + size, size: block.size - size});
                block = {ptr: block.ptr, size};
            }
        } else {
            block = {ptr: wasmHeapTop, size};
            try {
                ensureMemory(wasmBrush.memory, block.ptr + block.size);
            } catch (_) {
                return null;
            }
            wasmHeapTop += size;
        }
        return block;
    }

    function releaseBytes(block) {
        if (block) wasmFreeBlocks.push(block);
    }

    function reserveBlendScratch(byteLength) {
        const size = Math.ceil(byteLength / 16) * 16;
        if (wasmBlendScratch && wasmBlendScratch.size >= size) return wasmBlendScratch;
        const block = allocateBytes(size);
        if (!block) return null;
        releaseBytes(wasmBlendScratch);
        wasmBlendScratch = block;
        return block;
    }

    function allocateCoverage(coverage) {
        if (!wasmBrush?.add_dab_region || !wasmBrush?.blend_rgba_region) return null;
        const block = allocateBytes(coverage.byteLength);
        if (!block) return null;
        try {
            const view = new Float32Array(wasmBrush.memory.buffer, block.ptr, coverage.length);
            view.set(coverage);
            return {block, memory: wasmBrush.memory, length: coverage.length};
        } catch (_) {
            releaseBytes(block);
            return null;
        }
    }

    function accumulateDabLegacy(coverage, box, stride, cx, cy, radius, hardness, flow) {
        if (!wasmBrush?.add_dab) return false;
        const {memory, add_dab, __heap_base} = wasmBrush;
        const start = __heap_base.value;
        const width = box.right - box.left, height = box.bottom - box.top;
        try {
            ensureMemory(memory, start + width * height * 4);
            const region = new Float32Array(memory.buffer, start, width * height);
            for (let y = 0; y < height; y += 1) {
                const offset = (box.top + y) * stride + box.left;
                region.set(coverage.subarray(offset, offset + width), y * width);
            }
            add_dab(start, width, height, cx - box.left, cy - box.top, radius, hardness, flow);
            for (let y = 0; y < height; y += 1) {
                coverage.set(region.subarray(y * width, (y + 1) * width), (box.top + y) * stride + box.left);
            }
            return true;
        } catch (_) {
            wasmBrush = null;
            return false;
        }
    }

    function blendPatchLegacy(pixels, coverage, box, stride, color, strokeOpacity, layerOpacity, mode) {
        if (!wasmBrush?.blend_rgba) return false;
        const {memory, blend_rgba, __heap_base} = wasmBrush;
        const start = __heap_base.value;
        const coverageStart = start + pixels.byteLength;
        const end = coverageStart + pixels.byteLength;
        try {
            ensureMemory(memory, end);
            const rgba = new Uint8Array(memory.buffer, start, pixels.byteLength);
            const weights = new Float32Array(memory.buffer, coverageStart, pixels.length / 4);
            rgba.set(pixels);
            const width = box.right - box.left;
            for (let y = box.top; y < box.bottom; y += 1) {
                const offset = y * stride + box.left;
                weights.set(coverage.subarray(offset, offset + width), (y - box.top) * width);
            }
            const rgb = (color[0] << 16) | (color[1] << 8) | color[2];
            blend_rgba(start, coverageStart, weights.length, rgb, strokeOpacity, layerOpacity,
                MODE_INDEX[mode] || 0);
            pixels.set(rgba);
            return true;
        } catch (_) {
            wasmBrush = null;
            return false;
        }
    }

    function blendNativePatch(pixels, native, box, stride, color, strokeOpacity, layerOpacity, mode) {
        if (!native || !wasmBrush?.blend_rgba_region) return false;
        const block = reserveBlendScratch(pixels.byteLength);
        if (!block) return false;
        try {
            ensureMemory(native.memory, block.ptr + pixels.byteLength);
            const rgba = new Uint8Array(native.memory.buffer, block.ptr, pixels.byteLength);
            rgba.set(pixels);
            const width = box.right - box.left;
            const height = box.bottom - box.top;
            const rgb = (color[0] << 16) | (color[1] << 8) | color[2];
            wasmBrush.blend_rgba_region(block.ptr, native.block.ptr, width, box.left, box.top, stride,
                width, height, rgb, strokeOpacity, layerOpacity, MODE_INDEX[mode] || 0);
            pixels.set(rgba);
            return true;
        } catch (_) {
            wasmBrush = null;
            return false;
        }
    }

    function clamp(value, min, max, fallback) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
    }

    function parseColor(value) {
        if (typeof value === 'string') {
            const match = /^#([0-9a-f]{6})$/i.exec(value);
            if (match) {
                const number = parseInt(match[1], 16);
                return [number >> 16, (number >> 8) & 255, number & 255];
            }
        }
        if (value && typeof value.length === 'number' && value.length >= 3) {
            return [0, 1, 2].map(index => Math.round(clamp(value[index], 0, 255, 0)));
        }
        return [230, 186, 164];
    }

    function luminance(color) {
        return color[0] * .3 + color[1] * .59 + color[2] * .11;
    }

    function clipColor(color) {
        let result = color.slice();
        const lightness = luminance(result);
        const minimum = Math.min(result[0], result[1], result[2]);
        if (minimum < 0) {
            const denominator = Math.max(lightness - minimum, 1e-6);
            result = result.map(channel => lightness + (channel - lightness) * lightness / denominator);
        }
        const maximum = Math.max(result[0], result[1], result[2]);
        if (maximum > 1) {
            const denominator = Math.max(maximum - lightness, 1e-6);
            result = result.map(channel => lightness + (channel - lightness) * (1 - lightness) / denominator);
        }
        return result.map(channel => Math.max(0, Math.min(1, channel)));
    }

    function blendColor(base, brush) {
        const lightness = luminance(base);
        const brushLightness = luminance(brush);
        return clipColor(brush.map(channel => channel + lightness - brushLightness));
    }

    function blendChannel(base, brush, mode) {
        if (mode === 'soft-light') {
            const curve = base <= .25 ? ((16 * base - 12) * base + 4) * base : Math.sqrt(base);
            return brush <= .5
                ? base - (1 - 2 * brush) * base * (1 - base)
                : base + (2 * brush - 1) * (curve - base);
        }
        if (mode === 'multiply') return base * brush;
        if (mode === 'screen') return 1 - (1 - base) * (1 - brush);
        return brush;
    }

    function blendAt(data, index, color, weight, mode) {
        if (weight <= 0) return;
        const base = [data[index] / 255, data[index + 1] / 255, data[index + 2] / 255];
        const brush = [color[0] / 255, color[1] / 255, color[2] / 255];
        let changed;
        if (mode === 'color') {
            changed = blendColor(base, brush);
        } else {
            changed = base.map((channel, offset) => blendChannel(channel, brush[offset], mode));
        }
        for (let offset = 0; offset < 3; offset += 1) {
            const value = base[offset] + (changed[offset] - base[offset]) * weight;
            data[index + offset] = Math.max(0, Math.min(255, Math.floor(value * 255 + .5)));
        }
    }

    function blendPixels(baseRGBA, color, weight, mode) {
        const result = new Uint8ClampedArray(baseRGBA);
        const amount = clamp(weight, 0, 1, 0);
        const normalizedMode = MODES.has(mode) ? mode : 'normal';
        blendAt(result, 0, parseColor(color), amount, normalizedMode);
        return result;
    }

    function create(stroke, width, height, documentWidth, documentHeight, options) {
        prepareNative();
        const previewWidth = Math.round(Number(width));
        const previewHeight = Math.round(Number(height));
        const docWidth = Number(documentWidth);
        const docHeight = Number(documentHeight);
        if (!Number.isFinite(previewWidth) || !Number.isFinite(previewHeight) ||
                previewWidth < 1 || previewHeight < 1 || previewWidth > 1600 || previewHeight > 1600) {
            throw new RangeError('Airbrush preview dimensions must be between 1 and 1600 pixels.');
        }
        if (!Number.isFinite(docWidth) || !Number.isFinite(docHeight) || docWidth <= 0 || docHeight <= 0) {
            throw new RangeError('Airbrush document dimensions must be positive.');
        }

        const placement = options || {};
        let originX = 0;
        let originY = 0;
        if (Object.prototype.hasOwnProperty.call(placement, 'origin')) {
            const origin = placement.origin;
            if (!Array.isArray(origin) || origin.length !== 2 ||
                    !Number.isFinite(origin[0]) || !Number.isFinite(origin[1])) {
                throw new RangeError('Airbrush origin must contain two finite coordinates.');
            }
            originX = origin[0];
            originY = origin[1];
        }
        const hasExplicitScale = Object.prototype.hasOwnProperty.call(placement, 'scale');
        const explicitScale = placement.scale;
        if (hasExplicitScale && (!Number.isFinite(explicitScale) || explicitScale <= 0 || explicitScale > 1)) {
            throw new RangeError('Airbrush scale must be greater than zero and at most one.');
        }

        const settings = stroke || {};
        const radiusDocument = clamp(settings.radius, 1, 800, 80);
        const scale = hasExplicitScale ? explicitScale : Math.min(previewWidth / docWidth, previewHeight / docHeight);
        const radius = Math.max(.5, radiusDocument * scale);
        const hardness = clamp(settings.hardness, 0, 1, .3);
        const flow = clamp(settings.flow, 0, 1, .04);
        const strokeOpacity = clamp(settings.opacity, 0, 1, .1);
        const color = parseColor(settings.color);
        const feather = Math.max(1 - hardness, 1e-6);
        const falloffEnd = Math.exp(-4.5);
        const spacing = Math.max(1, radiusDocument * .2);
        let coverage = new Float32Array(previewWidth * previewHeight);
        let nativeCoverage = null;
        let disposed = false;
        let bounds = null, dirty = null;
        let processedCount = 0;
        let lastPoint = null;
        let remainingDistance = spacing;
        let maskIdentity = null;
        let maskPixels = null;
        let maskCanvas = null;
        let maskContext = null;

        function coverageData() {
            if (nativeCoverage) {
                coverage = new Float32Array(nativeCoverage.memory.buffer, nativeCoverage.block.ptr, nativeCoverage.length);
            }
            return coverage;
        }

        function promoteCoverage() {
            if (!nativeCoverage && wasmBrush?.add_dab_region && wasmBrush?.blend_rgba_region) {
                nativeCoverage = allocateCoverage(coverage);
                if (nativeCoverage) coverageData();
            }
            return coverageData();
        }

        function include(box, left, top, right, bottom) {
            if (!box) return {left, top, right, bottom};
            box.left = Math.min(box.left, left);
            box.top = Math.min(box.top, top);
            box.right = Math.max(box.right, right);
            box.bottom = Math.max(box.bottom, bottom);
            return box;
        }

        function addDab(documentX, documentY) {
            if (disposed || flow <= 0) return;
            const centerX = (documentX - originX) * scale;
            const centerY = (documentY - originY) * scale;
            const left = Math.max(0, Math.floor(centerX - radius - .5));
            const top = Math.max(0, Math.floor(centerY - radius - .5));
            const right = Math.min(previewWidth, Math.ceil(centerX + radius - .5) + 1);
            const bottom = Math.min(previewHeight, Math.ceil(centerY + radius - .5) + 1);
            if (right <= left || bottom <= top) return;

            bounds = include(bounds, left, top, right, bottom);
            dirty = include(dirty, left, top, right, bottom);

            const values = promoteCoverage();
            if (nativeCoverage && wasmBrush?.add_dab_region) {
                try {
                    wasmBrush.add_dab_region(nativeCoverage.block.ptr, previewWidth, left, top, right, bottom,
                        centerX, centerY, radius, hardness, flow);
                    return;
                } catch (_) {
                    wasmBrush = null;
                    coverageData();
                }
            } else if (!nativeCoverage && accumulateDabLegacy(values,
                {left, top, right, bottom}, previewWidth, centerX, centerY, radius, hardness, flow)) {
                return;
            }

            const denominator = SOFT_LIGHT_DENOMINATOR;
            const radiusSquared = radius * radius;
            for (let y = top; y < bottom; y += 1) {
                const dy = y + .5 - centerY;
                if (Math.abs(dy) > radius + 1) continue;
                const rowExtent = Math.sqrt(Math.max(0, radiusSquared - dy * dy)) + 1;
                const rowLeft = Math.max(left, Math.floor(centerX - rowExtent - .5));
                const rowRight = Math.min(right, Math.ceil(centerX + rowExtent - .5) + 1);
                for (let x = rowLeft; x < rowRight; x += 1) {
                    const dx = x + .5 - centerX;
                    const distance = Math.sqrt(dx * dx + dy * dy) / radius;
                    if (distance >= 1) continue;
                    const q = Math.max(0, Math.min(1, (distance - hardness) / feather));
                    const falloff = q === 0 ? 1 : Math.max(0, (Math.exp(-4.5 * q * q) - falloffEnd) / denominator);
                    const index = y * previewWidth + x;
                    values[index] += (1 - values[index]) * falloff * flow;
                }
            }
        }

        function pointAt(points, index) {
            const point = points[index];
            if (!point || point.length < 2) return null;
            const x = Number(point[0]);
            const y = Number(point[1]);
            return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
        }

        function append(points) {
            if (disposed || !Array.isArray(points) || points.length <= processedCount) return;
            coverageData();
            if (!lastPoint) {
                const first = pointAt(points, 0);
                processedCount = 1;
                if (!first) return;
                lastPoint = first;
                addDab(first[0], first[1]);
            }

            for (let index = processedCount; index < points.length; index += 1) {
                const current = pointAt(points, index);
                processedCount = index + 1;
                if (!current || !lastPoint) continue;
                const start = lastPoint;
                const dx = current[0] - start[0];
                const dy = current[1] - start[1];
                const length = Math.hypot(dx, dy);
                if (length === 0) {
                    addDab(current[0], current[1]);
                    lastPoint = current;
                    continue;
                }

                let distance = remainingDistance;
                while (distance <= length + 1e-9) {
                    const sampleDistance = Math.min(distance, length);
                    const ratio = sampleDistance / length;
                    addDab(start[0] + dx * ratio, start[1] + dy * ratio);
                    distance += spacing;
                }
                remainingDistance = distance - length;
                lastPoint = current;
            }
        }

        function getMaskPixels(mask) {
            if (maskIdentity === mask && maskPixels) return maskPixels;
            const doc = typeof document !== 'undefined' ? document : null;
            if (!doc || typeof doc.createElement !== 'function') {
                throw new Error('A document canvas is required to paint a masked airbrush preview.');
            }
            if (!maskCanvas) {
                maskCanvas = doc.createElement('canvas');
                maskCanvas.width = previewWidth;
                maskCanvas.height = previewHeight;
                maskContext = maskCanvas.getContext('2d', {willReadFrequently: true});
            }
            maskContext.clearRect(0, 0, previewWidth, previewHeight);
            maskContext.drawImage(mask, 0, 0, previewWidth, previewHeight);
            maskPixels = maskContext.getImageData(0, 0, previewWidth, previewHeight).data;
            maskIdentity = mask;
            return maskPixels;
        }

        function paint(context, options) {
            if (disposed || !bounds || strokeOpacity <= 0 || flow <= 0) return;
            const paintOptions = options || {};
            const layerOpacity = clamp(paintOptions.opacity, 0, 1, 1);
            if (layerOpacity <= 0) return;
            const mode = MODES.has(paintOptions.mode) ? paintOptions.mode : 'normal';
            const mask = paintOptions.mask || null;
            const maskData = mask ? getMaskPixels(mask) : null;
            const patch = paintOptions.baseContext ? dirty : bounds;
            if (!patch) return;
            dirty = null;
            const {left, top, right, bottom} = patch;
            const patchWidth = right - left;
            const patchHeight = bottom - top;
            const imageData = (paintOptions.baseContext || context).getImageData(left, top, patchWidth, patchHeight);
            const pixels = imageData.data;
            promoteCoverage();
            if (!maskData && blendNativePatch(pixels, nativeCoverage, patch, previewWidth,
                color, strokeOpacity, layerOpacity, mode)) {
                context.putImageData(imageData, left, top);
                return {x: left, y: top, width: patchWidth, height: patchHeight};
            }
            const values = coverageData();
            if (!maskData && !nativeCoverage && blendPatchLegacy(pixels, values, patch, previewWidth,
                color, strokeOpacity, layerOpacity, mode)) {
                context.putImageData(imageData, left, top);
                return;
            }
            for (let y = 0; y < patchHeight; y += 1) {
                const globalY = top + y;
                for (let x = 0; x < patchWidth; x += 1) {
                    const globalX = left + x;
                    const globalIndex = globalY * previewWidth + globalX;
                    const maskFactor = maskData ? maskData[(globalIndex * 4)] / 255 : 1;
                    const coverageByte = Math.floor(values[globalIndex] * maskFactor * 255 + .5);
                    const weight = (coverageByte / 255) * strokeOpacity * layerOpacity;
                    if (weight <= 0) continue;
                    blendAt(pixels, (y * patchWidth + x) * 4, color, weight, mode);
                }
            }
            context.putImageData(imageData, left, top);
            return {x: left, y: top, width: patchWidth, height: patchHeight};
        }

        function dispose() {
            if (disposed) return;
            disposed = true;
            if (nativeCoverage) releaseBytes(nativeCoverage.block);
            nativeCoverage = null;
            coverage = null;
            bounds = dirty = null;
            if (maskCanvas) {maskCanvas.width = 0; maskCanvas.height = 0;}
            maskCanvas = maskContext = maskPixels = maskIdentity = null;
        }

        return {append, paint, dispose};
    }

    prepareNative();
    return {create, blendPixels, prepareNative};
});
