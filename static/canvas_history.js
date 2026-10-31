(function (root) {
    'use strict';

    function createCanvasHistory(options = {}) {
        const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 50;
        const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(0, Math.floor(options.maxBytes)) : 32 * 1024 * 1024;
        const collectRefs = typeof options.collectRefs === 'function' ? options.collectRefs : null;
        let history = [];
        let historyBytes = 0;
        let current = null;

        function entryFor(state, key) {
            const text = JSON.stringify(state);
            if (typeof text !== 'string') throw new TypeError('Canvas history state must be JSON-serializable');
            const entryKey = key === undefined ? text : key;
            const keyBytes = typeof entryKey === 'string' && entryKey !== text ? entryKey.length * 2 : 0;
            const collectedRefs = collectRefs ? collectRefs(state) : [];
            if (!Array.isArray(collectedRefs) || collectedRefs.some(ref => typeof ref !== 'string')) {
                throw new TypeError('Canvas history collectRefs must return an array of strings');
            }
            const refs = [...new Set(collectedRefs)];
            const refsBytes = refs.reduce((total, ref) => total + ref.length * 2, 0);
            return {text, key: entryKey, refs, bytes: text.length * 2 + keyBytes + refsBytes};
        }

        function copy(entry) {
            return JSON.parse(entry.text);
        }

        function trim() {
            while (history.length > 0 &&
                (history.length > limit || historyBytes + current.bytes > maxBytes)) {
                historyBytes -= history.shift().bytes;
            }
        }

        return {
            reset(state, key) {
                current = entryFor(state, key);
                history = [];
                historyBytes = 0;
            },
            replaceCurrent(state, key) {
                current = entryFor(state, key);
                trim();
            },
            record(state, key) {
                const next = entryFor(state, key);
                if (current === null) {
                    current = next;
                    return false;
                }
                if (Object.is(next.key, current.key)) {
                    current = next;
                    trim();
                    return false;
                }
                history.push(current);
                historyBytes += current.bytes;
                current = next;
                trim();
                return true;
            },
            undo() {
                if (history.length === 0) return null;
                current = history.pop();
                historyBytes -= current.bytes;
                return copy(current);
            },
            states() {
                return current === null ? [] : history.concat(current).map(copy);
            },
            importRefs() {
                const refs = new Set();
                for (const entry of history) entry.refs.forEach(ref => refs.add(ref));
                if (current) current.refs.forEach(ref => refs.add(ref));
                return [...refs];
            },
            get canUndo() {
                return history.length > 0;
            },
            clear() {
                history = [];
                historyBytes = 0;
                current = null;
            }
        };
    }

    const api = {createCanvasHistory};
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CanvasHistory = api;
})(typeof globalThis === 'object' ? globalThis : this);
