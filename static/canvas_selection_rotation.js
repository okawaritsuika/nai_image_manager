(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CanvasSelectionRotation = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
    'use strict';

    const TRIG_EPSILON = 1e-12;

    function finiteOr(value, fallback = 0) {
        return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    }

    function angle(value) {
        if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
        const normalized = ((value + 180) % 360 + 360) % 360 - 180;
        return Object.is(normalized, -0) ? 0 : normalized;
    }

    function snapAngle(value) {
        const degrees = finiteOr(value);
        const nearest = Math.round(degrees / 90) * 90;
        return Math.abs(degrees - nearest) <= 5 ? (nearest || 0) : degrees;
    }

    function rotationFor(selection) {
        const radians = angle(selection?.rotation) * Math.PI / 180;
        let cos = Math.cos(radians);
        let sin = Math.sin(radians);
        if (Math.abs(cos) < TRIG_EPSILON) cos = 0;
        if (Math.abs(sin) < TRIG_EPSILON) sin = 0;
        if (Math.abs(cos - 1) < TRIG_EPSILON) cos = 1;
        if (Math.abs(cos + 1) < TRIG_EPSILON) cos = -1;
        if (Math.abs(sin - 1) < TRIG_EPSILON) sin = 1;
        if (Math.abs(sin + 1) < TRIG_EPSILON) sin = -1;
        return {cos, sin};
    }

    function geometry(selection) {
        const x = finiteOr(selection?.x);
        const y = finiteOr(selection?.y);
        const width = finiteOr(selection?.layerWidth);
        const height = finiteOr(selection?.layerHeight);
        return {x, y, width, height, centerX: x + width / 2, centerY: y + height / 2};
    }

    function rotatePoint(x, y, centerX, centerY, cos, sin) {
        const offsetX = x - centerX;
        const offsetY = y - centerY;
        return {
            x: centerX + offsetX * cos - offsetY * sin,
            y: centerY + offsetX * sin + offsetY * cos
        };
    }

    function corners(selection) {
        const box = geometry(selection);
        const {cos, sin} = rotationFor(selection);
        return [
            rotatePoint(box.x, box.y, box.centerX, box.centerY, cos, sin),
            rotatePoint(box.x + box.width, box.y, box.centerX, box.centerY, cos, sin),
            rotatePoint(box.x + box.width, box.y + box.height, box.centerX, box.centerY, cos, sin),
            rotatePoint(box.x, box.y + box.height, box.centerX, box.centerY, cos, sin)
        ];
    }

    function bounds(selection) {
        const box = geometry(selection);
        if (angle(selection?.rotation) === 0) {
            return {
                x: Math.round(box.x),
                y: Math.round(box.y),
                width: Math.round(box.width),
                height: Math.round(box.height)
            };
        }

        const points = corners(selection);
        const minX = Math.floor(Math.min(...points.map(point => point.x)) + TRIG_EPSILON);
        const minY = Math.floor(Math.min(...points.map(point => point.y)) + TRIG_EPSILON);
        const maxX = Math.ceil(Math.max(...points.map(point => point.x)) - TRIG_EPSILON);
        const maxY = Math.ceil(Math.max(...points.map(point => point.y)) - TRIG_EPSILON);
        return {x: minX, y: minY, width: maxX - minX, height: maxY - minY};
    }

    function localPoint(rect, point) {
        const box = geometry(rect);
        const {cos, sin} = rotationFor(rect);
        const x = point.x - box.centerX;
        const y = point.y - box.centerY;
        return {x: x * cos + y * sin + box.width / 2,
            y: -x * sin + y * cos + box.height / 2};
    }

    function containsPoint(rect, point) {
        const local = localPoint(rect, point);
        const box = geometry(rect);
        return local.x >= 0 && local.x <= box.width && local.y >= 0 && local.y <= box.height;
    }

    function intersects(first, second) {
        const a = corners(first);
        const b = corners(second);
        if (geometry(first).width <= 0 || geometry(first).height <= 0 ||
            geometry(second).width <= 0 || geometry(second).height <= 0) return false;
        // Project onto each rectangle's two axes. Bounding boxes include empty
        // corner regions after rotation and cannot decide the visible overlap.
        for (const rect of [first, second]) {
            const {cos, sin} = rotationFor(rect);
            for (const [x, y] of [[cos, sin], [-sin, cos]]) {
                const ap = a.map(point => point.x * x + point.y * y);
                const bp = b.map(point => point.x * x + point.y * y);
                if (Math.max(...ap) <= Math.min(...bp) + TRIG_EPSILON ||
                    Math.max(...bp) <= Math.min(...ap) + TRIG_EPSILON) return false;
            }
        }
        return true;
    }

    function resize(start, handle, dx, dy, snap) {
        const box = geometry(start);
        const {cos, sin} = rotationFor(start);
        const localDx = finiteOr(dx) * cos + finiteOr(dy) * sin;
        const localDy = -finiteOr(dx) * sin + finiteOr(dy) * cos;
        const movesLeft = handle.includes('l');
        const movesRight = handle.includes('r');
        const movesTop = handle.includes('t');
        const movesBottom = handle.includes('b');
        const width = snap(movesLeft ? box.width - localDx : movesRight ? box.width + localDx : box.width);
        const height = snap(movesTop ? box.height - localDy : movesBottom ? box.height + localDy : box.height);
        const anchorSignX = movesLeft ? 1 : -1;
        const anchorSignY = movesTop ? 1 : -1;
        const anchor = rotatePoint(
            box.centerX + anchorSignX * box.width / 2,
            box.centerY + anchorSignY * box.height / 2,
            box.centerX,
            box.centerY,
            cos,
            sin
        );
        const centerX = anchor.x - (anchorSignX * width / 2 * cos - anchorSignY * height / 2 * sin);
        const centerY = anchor.y - (anchorSignX * width / 2 * sin + anchorSignY * height / 2 * cos);
        return {
            x: centerX - width / 2,
            y: centerY - height / 2,
            layerWidth: width,
            layerHeight: height
        };
    }

    return Object.freeze({angle, snapAngle, corners, bounds, localPoint, containsPoint, intersects, resize});
});
