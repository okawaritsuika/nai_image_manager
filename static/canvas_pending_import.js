globalThis.CanvasPendingImport = (() => {
    const headKey = 'naia_canvas_pending_import';
    const tailKey = headKey + '_queue';
    function same(a, b) {
        if (!a || !b) return false;
        if (a.transferId || b.transferId) return Boolean(a.transferId && a.transferId === b.transferId);
        return a.src === b.src && a.importedAt === b.importedAt;
    }
    function head() {
        try {
            const item = JSON.parse(localStorage.getItem(headKey));
            return item && typeof item.src === 'string' && item.src ? item : null;
        } catch (error) {
            if (error instanceof SyntaxError) return null;
            throw error;
        }
    }
    function tail() {
        const raw = localStorage.getItem(tailKey);
        if (!raw) return [];
        const items = JSON.parse(raw);
        if (!Array.isArray(items)) throw new Error('가져오기 대기 목록을 읽을 수 없습니다.');
        return items;
    }
    function writeTail(items) {
        if (items.length) localStorage.setItem(tailKey, JSON.stringify(items));
        else localStorage.removeItem(tailKey);
    }
    function promote(items) {
        const next = items[0];
        // Publish before trimming. An interrupted write leaves a duplicate that the next ack skips.
        localStorage.setItem(headKey, JSON.stringify(next));
        try { writeTail(items.slice(1)); } catch (_) { /* The complete queue is still on disk. */ }
        return next;
    }
    function edit(action) {
        const locks = globalThis.navigator?.locks;
        return locks ? locks.request(headKey, action) : action();
    }
    function enqueue(payload) {
        const transferId = globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
        const item = {...payload, transferId};
        return edit(() => {
            let current = head();
            const items = tail();
            if (!current && items.length) {
                current = items.shift();
                localStorage.setItem(headKey, JSON.stringify(current));
            }
            if (!current) localStorage.setItem(headKey, JSON.stringify(item));
            else {
                if (same(items[0], current)) items.shift();
                items.push(item);
                writeTail(items);
            }
            return item;
        });
    }
    function peek() {
        const current = head();
        if (current || !localStorage.getItem(tailKey)) return current;
        return edit(() => {
            const pending = head();
            if (pending) return pending;
            const items = tail();
            return items.length ? promote(items) : null;
        });
    }
    function acknowledge(item) {
        return edit(() => {
            const current = head();
            if (!same(current, item)) return false;
            const items = tail();
            if (same(current, items[0])) items.shift();
            if (items.length) promote(items);
            else {
                if (localStorage.getItem(tailKey)) localStorage.removeItem(tailKey);
                localStorage.removeItem(headKey);
            }
            return true;
        });
    }
    function withHead(item, action) {
        const run = () => same(head(), item) ? action() : 'stale';
        const locks = globalThis.navigator?.locks;
        if (!locks) return run();
        // Only competing actions on this item share this lock. Enqueueing uses a separate, short storage lock.
        const id = item.transferId || JSON.stringify([item.src, item.importedAt]);
        return locks.request(headKey + ':' + id, {ifAvailable: true}, lock => lock ? run() : 'busy');
    }
    return {enqueue, peek, acknowledge, withHead, same, isHead: item => same(head(), item),
        hasPending: () => Boolean(localStorage.getItem(headKey) || localStorage.getItem(tailKey))};
})();
