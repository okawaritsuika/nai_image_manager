(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CanvasRetouchLiquify = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const MODES = new Set(['push', 'expand', 'shrink', 'clockwise', 'counterclockwise']);

    function number(value) {
        try {
            return Number(value);
        } catch (error) {
            return NaN;
        }
    }

    function clamp(value, min, max, fallback) {
        if (value == null || (typeof value === 'string' && value.trim() === '')) return fallback;
        const normalized = number(value);
        return Number.isFinite(normalized) ? Math.max(min, Math.min(max, normalized)) : fallback;
    }

    function create(stroke, imageData, documentWidth, documentHeight, options = {}) {
        const width = imageData && imageData.width;
        const height = imageData && imageData.height;
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
                width > 1600 || height > 1600) {
            throw new RangeError('Liquify preview dimensions must be integers between 1 and 1600 pixels.');
        }
        const data = imageData.data;
        if (!(data instanceof Uint8ClampedArray) || data.length !== width * height * 4) {
            throw new RangeError('Liquify preview data must contain one RGBA byte per channel.');
        }

        const docWidth = number(documentWidth);
        const docHeight = number(documentHeight);
        if (!Number.isFinite(docWidth) || !Number.isFinite(docHeight) || docWidth <= 0 || docHeight <= 0) {
            throw new RangeError('Liquify document dimensions must be positive and finite.');
        }

        const settings = stroke || {};
        const scale = Math.min(1, 1600 / Math.max(docWidth, docHeight));
        const radius = Math.max(1, clamp(settings.radius, 1, 800, 80) * scale);
        const strength = clamp(settings.strength, .01, 1, .35);
        const mode = MODES.has(settings.mode) ? settings.mode : 'push';
        const paintOptions = options || {};
        const opacity = clamp(paintOptions.opacity, 0, 1, 1);
        const mask = paintOptions.mask == null ? null : paintOptions.mask;
        if (mask && (!(mask instanceof Uint8ClampedArray) || mask.length !== data.length)) {
            throw new RangeError('Liquify mask data must match the preview RGBA dimensions.');
        }

        let processedCount = 0;
        let hasLastPoint = false;
        let lastX = 0;
        let lastY = 0;
        let scratch = new Uint8Array(0);

        function processDab(cx, cy, dx, dy, bounds) {
            if (opacity <= 0 || (mode === 'push' && dx === 0 && dy === 0)) return;

            const left = Math.max(0, Math.floor(cx - radius));
            const top = Math.max(0, Math.floor(cy - radius));
            const right = Math.min(width, Math.ceil(cx + radius));
            const bottom = Math.min(height, Math.ceil(cy + radius));
            if (right <= left || bottom <= top) return;

            const patchWidth = right - left;
            const patchHeight = bottom - top;
            const pixelCount = patchWidth * patchHeight;
            const byteCount = pixelCount * 4;
            if (scratch.length < byteCount) {
                scratch = new Uint8Array(Math.max(byteCount, scratch.length * 2, 64));
            }

            const radiusSquared = radius * radius;
            const pushX = dx * strength;
            const pushY = dy * strength;
            for (let patchY = 0; patchY < patchHeight; patchY += 1) {
                const y = top + patchY;
                const ry = y - cy;
                for (let patchX = 0; patchX < patchWidth; patchX += 1) {
                    const x = left + patchX;
                    const rx = x - cx;
                    const distanceSquared = rx * rx + ry * ry;
                    const scratchIndex = (patchY * patchWidth + patchX) * 4;
                    scratch[scratchIndex + 3] = 0;
                    if (distanceSquared >= radiusSquared) continue;

                    const falloffBase = Math.max(0, 1 - distanceSquared / radiusSquared);
                    const falloff = falloffBase * falloffBase;
                    const pixelIndex = (y * width + x) * 4;
                    const maskAmount = mask ? mask[pixelIndex] / 255 : 1;
                    const amount = maskAmount * opacity;
                    if (amount <= 0) continue;

                    let sourceX = x;
                    let sourceY = y;
                    if (mode === 'push') {
                        sourceX -= pushX * falloff;
                        sourceY -= pushY * falloff;
                    } else if (mode === 'expand' || mode === 'shrink') {
                        const factor = (mode === 'shrink' ? 1 : -1) * strength * .14 * falloff;
                        sourceX += rx * factor;
                        sourceY += ry * factor;
                    } else {
                        const angle = strength * .22 * falloff * (mode === 'clockwise' ? 1 : -1);
                        const cosine = Math.cos(angle);
                        const sine = Math.sin(angle);
                        sourceX = cx + cosine * rx + sine * ry;
                        sourceY = cy - sine * rx + cosine * ry;
                    }

                    sourceX = Math.max(0, Math.min(width - 1, sourceX));
                    sourceY = Math.max(0, Math.min(height - 1, sourceY));
                    const x0 = Math.floor(sourceX);
                    const y0 = Math.floor(sourceY);
                    const x1 = Math.min(width - 1, x0 + 1);
                    const y1 = Math.min(height - 1, y0 + 1);
                    const fx = sourceX - x0;
                    const fy = sourceY - y0;
                    const topLeft = (y0 * width + x0) * 4;
                    const topRight = (y0 * width + x1) * 4;
                    const bottomLeft = (y1 * width + x0) * 4;
                    const bottomRight = (y1 * width + x1) * 4;
                    let changed = false;
                    for (let channel = 0; channel < 3; channel += 1) {
                        const sampled = (data[topLeft + channel] * (1 - fx) + data[topRight + channel] * fx) * (1 - fy) +
                            (data[bottomLeft + channel] * (1 - fx) + data[bottomRight + channel] * fx) * fy;
                        const roundedSample = Math.floor(sampled + .5);
                        const result = Math.floor(data[pixelIndex + channel] +
                            (roundedSample - data[pixelIndex + channel]) * amount + .5);
                        scratch[scratchIndex + channel] = result;
                        if (result !== data[pixelIndex + channel]) changed = true;
                    }
                    if (changed) scratch[scratchIndex + 3] = 1;
                }
            }

            // Defer writes until every source sample for this dab has read the same image.
            for (let patchY = 0; patchY < patchHeight; patchY += 1) {
                const y = top + patchY;
                for (let patchX = 0; patchX < patchWidth; patchX += 1) {
                    const scratchIndex = (patchY * patchWidth + patchX) * 4;
                    if (!scratch[scratchIndex + 3]) continue;
                    const x = left + patchX;
                    const pixelIndex = (y * width + x) * 4;
                    data[pixelIndex] = scratch[scratchIndex];
                    data[pixelIndex + 1] = scratch[scratchIndex + 1];
                    data[pixelIndex + 2] = scratch[scratchIndex + 2];
                    if (!bounds.hasChanges) {
                        bounds.left = x;
                        bounds.top = y;
                        bounds.right = x + 1;
                        bounds.bottom = y + 1;
                        bounds.hasChanges = true;
                    } else {
                        bounds.left = Math.min(bounds.left, x);
                        bounds.top = Math.min(bounds.top, y);
                        bounds.right = Math.max(bounds.right, x + 1);
                        bounds.bottom = Math.max(bounds.bottom, y + 1);
                    }
                }
            }
        }

        function pointAt(points, index) {
            const point = points[index];
            if (!Array.isArray(point) || point.length < 2) return null;
            const x = point[0];
            const y = point[1];
            return Number.isFinite(x) && Number.isFinite(y) ? {x: x * scale, y: y * scale} : null;
        }

        function append(points) {
            if (!Array.isArray(points) || points.length <= processedCount) return null;
            const bounds = {hasChanges: false, left: 0, top: 0, right: 0, bottom: 0};
            const spacing = Math.max(1, radius * .22);

            for (let index = processedCount; index < points.length; index += 1) {
                processedCount = index + 1;
                const point = pointAt(points, index);
                if (!point) continue;
                if (!hasLastPoint) {
                    lastX = point.x;
                    lastY = point.y;
                    hasLastPoint = true;
                    processDab(lastX, lastY, 0, 0, bounds);
                    continue;
                }

                const startX = lastX;
                const startY = lastY;
                const dx = point.x - startX;
                const dy = point.y - startY;
                const distance = Math.hypot(dx, dy);
                if (!Number.isFinite(distance)) {
                    lastX = point.x;
                    lastY = point.y;
                    continue;
                }

                const steps = Math.max(1, Math.min(1000, Math.ceil(distance / spacing)));
                let previousDabX = startX;
                let previousDabY = startY;
                for (let step = 1; step <= steps; step += 1) {
                    const ratio = step / steps;
                    const dabX = startX + dx * ratio;
                    const dabY = startY + dy * ratio;
                    processDab(dabX, dabY, dabX - previousDabX, dabY - previousDabY, bounds);
                    previousDabX = dabX;
                    previousDabY = dabY;
                }
                lastX = point.x;
                lastY = point.y;
            }

            if (!bounds.hasChanges) return null;
            return {left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom};
        }

        return {append};
    }

    return {create};
});
