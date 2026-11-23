// Match the 8-by-8 cells used by prepare_inpaint_mask_bytes, in source image coordinates.
globalThis.InpaintGridBrush = (() => {
    const cell = 8;

    function visitStrokeRows({width, height}, from, to, diameter, visit) {
        const radius = diameter / 2;
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const length = Math.hypot(dx, dy);
        const normalX = length ? -dy * radius / length : 0;
        const normalY = length ? dx * radius / length : 0;
        const top = Math.max(0, Math.floor((Math.min(from.y, to.y) - radius) / cell) * cell);
        const bottom = Math.min(height, Math.max(from.y, to.y) + radius);
        let bounds = null;

        for (let y = top; y < bottom; y += cell) {
            const rowEnd = Math.min(y + cell, height);
            let left = Infinity;
            let right = -Infinity;

            // The round-ended stroke intersects each grid row in one continuous span.
            for (const end of [from, to]) {
                const distance = Math.max(y - end.y, end.y - rowEnd, 0);
                if (distance >= radius) continue;
                const reach = Math.sqrt(radius * radius - distance * distance);
                left = Math.min(left, end.x - reach);
                right = Math.max(right, end.x + reach);
            }
            if (dy !== 0) {
                for (const side of [-1, 1]) {
                    const edgeY = from.y + side * normalY;
                    const t1 = (y - edgeY) / dy;
                    const t2 = (rowEnd - edgeY) / dy;
                    const start = Math.max(0, Math.min(t1, t2));
                    const end = Math.min(1, Math.max(t1, t2));
                    if (start > end) continue;
                    const edgeX = from.x + side * normalX;
                    const x1 = edgeX + start * dx;
                    const x2 = edgeX + end * dx;
                    left = Math.min(left, x1, x2);
                    right = Math.max(right, x1, x2);
                }
            }
            if (left >= width || right <= 0) continue;
            left = Math.max(0, Math.floor(left / cell) * cell);
            right = Math.min(width, Math.ceil(right / cell) * cell);
            if (left >= right) continue;
            visit(left, y, right, rowEnd);
            if (!bounds) bounds = {left, top: y, right, bottom: rowEnd};
            else {
                bounds.left = Math.min(bounds.left, left);
                bounds.right = Math.max(bounds.right, right);
                bounds.bottom = rowEnd;
            }
        }
        return bounds;
    }

    function paint(ctx, from, to, diameter, color, erase) {
        ctx.save();
        ctx.fillStyle = color;
        ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
        const bounds = visitStrokeRows(ctx.canvas, from, to, diameter, (left, top, right, bottom) => {
            ctx.fillRect(left, top, right - left, bottom - top);
        });
        ctx.restore();
        return bounds;
    }

    function showCursor(cursor, overlay, point, diameter, erase) {
        const rightEdge = [];
        const leftEdge = [];
        let start;
        visitStrokeRows(overlay, point, point, diameter, (left, top, right, bottom) => {
            if (!rightEdge.length) start = `M${left} ${top}`;
            rightEdge.push(`H${right}V${bottom}`);
            leftEdge.push(`H${left}V${top}`);
        });
        if (!rightEdge.length) {
            cursor.style.display = 'none';
            return;
        }

        cursor.firstElementChild.setAttribute('d', start + rightEdge.join('') + leftEdge.reverse().join('') + 'Z');
        cursor.setAttribute('viewBox', `0 0 ${overlay.width} ${overlay.height}`);
        for (const key of ['left', 'top', 'width', 'height']) cursor.style[key] = overlay.style[key];
        cursor.classList.toggle('eraser', erase);
        cursor.style.display = 'block';
    }

    return {paint, showCursor};
})();
