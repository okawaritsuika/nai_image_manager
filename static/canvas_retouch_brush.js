(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CanvasRetouchBrush = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const MODES = new Set(['normal', 'soft-light', 'color', 'multiply', 'screen']);
    const SOFT_LIGHT_DENOMINATOR = 1 - Math.exp(-4.5);

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

    function create(stroke, width, height, documentWidth, documentHeight) {
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

        const settings = stroke || {};
        const radiusDocument = clamp(settings.radius, 1, 800, 80);
        const radius = Math.max(.5, radiusDocument * Math.min(previewWidth / docWidth, previewHeight / docHeight));
        const scale = Math.min(previewWidth / docWidth, previewHeight / docHeight);
        const hardness = clamp(settings.hardness, 0, 1, .3);
        const flow = clamp(settings.flow, 0, 1, .04);
        const strokeOpacity = clamp(settings.opacity, 0, 1, .1);
        const color = parseColor(settings.color);
        const spacing = Math.max(1, radiusDocument * .2);
        const coverage = new Float32Array(previewWidth * previewHeight);
        let bounds = null;
        let processedCount = 0;
        let lastPoint = null;
        let remainingDistance = spacing;
        let maskIdentity = null;
        let maskPixels = null;
        let maskCanvas = null;
        let maskContext = null;

        function addDab(documentX, documentY) {
            if (flow <= 0) return;
            const centerX = documentX * scale;
            const centerY = documentY * scale;
            const left = Math.max(0, Math.floor(centerX - radius - .5));
            const top = Math.max(0, Math.floor(centerY - radius - .5));
            const right = Math.min(previewWidth, Math.ceil(centerX + radius - .5) + 1);
            const bottom = Math.min(previewHeight, Math.ceil(centerY + radius - .5) + 1);
            if (right <= left || bottom <= top) return;

            if (bounds) {
                bounds.left = Math.min(bounds.left, left);
                bounds.top = Math.min(bounds.top, top);
                bounds.right = Math.max(bounds.right, right);
                bounds.bottom = Math.max(bounds.bottom, bottom);
            } else {
                bounds = {left, top, right, bottom};
            }

            const denominator = SOFT_LIGHT_DENOMINATOR;
            for (let y = top; y < bottom; y += 1) {
                const dy = y + .5 - centerY;
                for (let x = left; x < right; x += 1) {
                    const dx = x + .5 - centerX;
                    const distance = Math.hypot(dx, dy) / radius;
                    if (distance >= 1) continue;
                    const q = Math.max(0, Math.min(1, (distance - hardness) / Math.max(1 - hardness, 1e-6)));
                    const falloff = Math.max(0, Math.min(1, (Math.exp(-4.5 * q * q) - Math.exp(-4.5)) / denominator));
                    const index = y * previewWidth + x;
                    coverage[index] += (1 - coverage[index]) * falloff * flow;
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
            if (!Array.isArray(points) || points.length <= processedCount) return;
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
            if (!bounds || strokeOpacity <= 0 || flow <= 0) return;
            const paintOptions = options || {};
            const layerOpacity = clamp(paintOptions.opacity, 0, 1, 1);
            if (layerOpacity <= 0) return;
            const mode = MODES.has(paintOptions.mode) ? paintOptions.mode : 'normal';
            const mask = paintOptions.mask || null;
            const maskData = mask ? getMaskPixels(mask) : null;
            const {left, top, right, bottom} = bounds;
            const patchWidth = right - left;
            const patchHeight = bottom - top;
            const imageData = context.getImageData(left, top, patchWidth, patchHeight);
            const pixels = imageData.data;
            for (let y = 0; y < patchHeight; y += 1) {
                const globalY = top + y;
                for (let x = 0; x < patchWidth; x += 1) {
                    const globalX = left + x;
                    const globalIndex = globalY * previewWidth + globalX;
                    const maskFactor = maskData ? maskData[(globalIndex * 4)] / 255 : 1;
                    const coverageByte = Math.floor(coverage[globalIndex] * maskFactor * 255 + .5);
                    const weight = (coverageByte / 255) * strokeOpacity * layerOpacity;
                    if (weight <= 0) continue;
                    blendAt(pixels, (y * patchWidth + x) * 4, color, weight, mode);
                }
            }
            context.putImageData(imageData, left, top);
        }

        return {append, paint};
    }

    return {create, blendPixels};
});
