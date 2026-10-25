(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CanvasDakiPromptRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const BODY_REGIONS = new Set([
        'whole', 'hair', 'face', 'chest', 'back', 'arms', 'hands',
        'abdomen', 'pelvis', 'legs', 'feet',
    ]);
    const REGION_NAMES = {
        hair: '머리카락', face: '얼굴', chest: '가슴·어깨', back: '등',
        arms: '팔', hands: '손', abdomen: '배·허리', pelvis: '골반',
        legs: '다리', feet: '발',
    };
    const WEIGHT_OPEN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)::/;

    function key(text) {
        if (typeof text !== 'string') return '';
        return text.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function isSpace(char) {
        return char !== undefined && /\s/.test(char);
    }

    function parse(text) {
        if (typeof text !== 'string') return null;
        const length = text.length;
        let cursor = 0;
        let failed = false;

        function isEscaped(index) {
            let slashes = 0;
            for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) slashes += 1;
            return slashes % 2 === 1;
        }

        function atWeightClose(index, parentClose) {
            if (text.slice(index, index + 2) !== '::') return false;
            let next = index + 2;
            while (isSpace(text[next])) next += 1;
            return next >= length || text[next] === ',' || (parentClose && text[next] === parentClose);
        }

        function atListClose(stop) {
            if (stop.type === 'char') return text[cursor] === stop.char;
            return stop.type === 'weight' && atWeightClose(cursor, stop.parentClose);
        }

        function parseList(stop = { type: 'end' }) {
            const start = cursor;
            const items = [];
            let closed = false;
            while (cursor < length) {
                if (atListClose(stop)) {
                    closed = true;
                    break;
                }
                if (text[cursor] === '}' || text[cursor] === ']') {
                    failed = true;
                    break;
                }

                const segmentStart = cursor;
                while (isSpace(text[cursor])) cursor += 1;
                const leading = text.slice(segmentStart, cursor);
                let node = null;
                const nodeStart = cursor;
                const weightMatch = text.slice(cursor).match(WEIGHT_OPEN);

                if (text[cursor] === '{' || text[cursor] === '[') {
                    const open = text[cursor];
                    const close = open === '{' ? '}' : ']';
                    cursor += 1;
                    const child = parseList({ type: 'char', char: close });
                    if (failed || !child.closed || text[cursor] !== close) {
                        failed = true;
                        break;
                    }
                    cursor += 1;
                    node = {
                        type: 'group', open, close, child: child.list,
                        start: nodeStart, end: cursor,
                    };
                } else if (weightMatch) {
                    const open = weightMatch[0];
                    cursor += open.length;
                    const child = parseList({ type: 'weight', parentClose: stop.type === 'char' ? stop.char : null });
                    if (failed || !child.closed || text.slice(cursor, cursor + 2) !== '::') {
                        failed = true;
                        break;
                    }
                    cursor += 2;
                    node = {
                        type: 'weight', open, close: '::', child: child.list,
                        start: nodeStart, end: cursor,
                    };
                } else {
                    while (cursor < length) {
                        const char = text[cursor];
                        if (isEscaped(cursor)) {
                            cursor += 1;
                            continue;
                        }
                        if (char === ',' || (stop.type === 'char' && char === stop.char)) break;
                        if (stop.type === 'weight' && atWeightClose(cursor, stop.parentClose)) break;
                        if (text.slice(cursor, cursor + 2) === '::') {
                            failed = true;
                            break;
                        }
                        if (char === '{' || char === '[' || char === '}' || char === ']') {
                            failed = true;
                            break;
                        }
                        cursor += 1;
                    }
                    if (failed) break;
                    let end = cursor;
                    while (end > nodeStart && isSpace(text[end - 1])) end -= 1;
                    node = {
                        type: 'leaf', text: text.slice(nodeStart, end),
                        start: nodeStart, end,
                    };
                    cursor = end;
                }

                const nodeEnd = cursor;
                while (isSpace(text[cursor])) cursor += 1;
                const trailing = text.slice(nodeEnd, cursor);
                if (cursor < length && text[cursor] !== ',' && !atListClose(stop)) {
                    // Envelopes are only safe to unwrap when they cover a whole prompt item.
                    failed = true;
                    break;
                }
                items.push({ node, leading, trailing, rawStart: segmentStart, rawEnd: cursor });

                if (text[cursor] === ',') {
                    items[items.length - 1].commaAfter = text[cursor];
                    cursor += 1;
                    continue;
                }
                if (atListClose(stop)) {
                    closed = true;
                    break;
                }
                if (cursor >= length) {
                    closed = stop.type === 'end';
                    break;
                }
            }

            if (!failed && cursor >= length && stop.type !== 'end') closed = false;
            if (stop.type === 'end' && cursor >= length) closed = true;
            const end = cursor;
            return {
                closed,
                list: { type: 'list', items, start, end, raw: text.slice(start, end) },
            };
        }

        const result = parseList();
        if (failed || !result.closed || cursor !== length) return null;
        return result.list;
    }

    function collectLeaves(list, output = []) {
        for (const item of list.items) {
            const node = item.node;
            if (!node) continue;
            if (node.type === 'leaf') {
                const token = node.text.trim();
                if (token) output.push(token);
            } else collectLeaves(node.child, output);
        }
        return output;
    }

    function inspect(text) {
        const tree = parse(text);
        return tree
            ? { valid: true, tokens: collectLeaves(tree) }
            : { valid: false, tokens: [] };
    }

    function listHasLeaves(list) {
        return list.items.some(({ node }) => node && (node.type === 'leaf' || listHasLeaves(node.child)));
    }

    function filterList(list, excluded) {
        let changed = false;
        const rendered = [];
        const original = list.items;

        for (let index = 0; index < original.length; index += 1) {
            const item = original[index];
            if (!item.node) {
                rendered.push({ item, text: '', index, hasLeaves: false });
                continue;
            }
            const result = filterNode(item.node, excluded);
            if (result.changed) changed = true;
            if (result.removed) {
                changed = true;
                continue;
            }
            rendered.push({ item, text: result.text, index, hasLeaves: result.hasLeaves });
        }

        if (!changed) return { changed: false, text: list.raw, removed: false, hasLeaves: listHasLeaves(list) };
        const withLeaves = rendered.filter((entry) => entry.hasLeaves);
        if (!withLeaves.length) return { changed: true, text: '', removed: true };

        const firstOriginal = original[0];
        const lastOriginal = original[original.length - 1];
        const leading = firstOriginal?.leading || '';
        const trailing = lastOriginal?.trailing || '';
        const survivors = withLeaves;
        let body = '';
        for (let i = 0; i < survivors.length; i += 1) {
            const entry = survivors[i];
            if (i > 0) {
                const previous = survivors[i - 1];
                let separator = ', ';
                if (previous.index + 1 === entry.index) {
                    separator = previous.item.trailing + ',' + entry.item.leading;
                } else if (original[previous.index]?.commaAfter) {
                    separator = original[previous.index].trailing + ',' + (original[previous.index + 1]?.leading || '');
                    if (!separator.includes(',')) separator = ', ';
                }
                body += separator;
            }
            body += entry.text;
        }
        return { changed: true, text: leading + body + trailing, removed: false, hasLeaves: true };
    }

    function filterNode(node, excluded) {
        if (node.type === 'leaf') {
            return excluded.has(key(node.text))
                ? { changed: true, removed: true, text: '', hasLeaves: false }
                : { changed: false, removed: false, text: node.text, hasLeaves: true };
        }
        const child = filterList(node.child, excluded);
        if (!child.changed) return { changed: false, removed: false, text: node.open + child.text + node.close, hasLeaves: child.hasLeaves };
        if (child.removed) return { changed: true, removed: true, text: '', hasLeaves: false };
        return { changed: true, removed: false, text: node.open + child.text + node.close, hasLeaves: child.hasLeaves };
    }

    function filter(text, excludedTokens) {
        const tree = parse(text);
        if (!tree) return text;
        const excluded = new Set();
        if (excludedTokens && typeof excludedTokens[Symbol.iterator] === 'function') {
            for (const token of excludedTokens) {
                if (typeof token === 'string') {
                    const normalized = key(token);
                    if (normalized) excluded.add(normalized);
                }
            }
        }
        if (!excluded.size) return text;
        const tokens = collectLeaves(tree);
        if (!tokens.some((token) => excluded.has(key(token)))) return text;
        const result = filterList(tree, excluded);
        return result.text;
    }

    function canonicalRegions(classification) {
        const rawRegions = Array.isArray(classification.regions) ? classification.regions : [];
        if (!rawRegions.length || rawRegions.some((entry) => key(String(entry)) === 'whole')) return null;
        const sections = Array.isArray(classification.sections)
            ? classification.sections.map((entry) => key(String(entry)))
            : [];
        const tag = key(typeof classification.tag === 'string' ? classification.tag : '');
        const mapped = [];
        let chestClothing = false;

        for (const rawRegion of rawRegions) {
            const region = key(String(rawRegion));
            if (!BODY_REGIONS.has(region) || region === 'whole') return null;
            if (region === 'chest' && (sections.includes('clothes') || sections.includes('chest.clothes'))) chestClothing = true;
            if (region === 'face') {
                const faceSections = sections.filter((section) => section.startsWith('face.') || !section.includes('.'));
                if (faceSections.length) {
                    for (const section of faceSections) mapped.push(section === 'hair' || section === 'face.hair' ? 'hair' : 'face');
                } else {
                    mapped.push(tag === 'face.hair' ? 'hair' : 'face');
                }
            } else if (region === 'arms') {
                const armSections = sections.filter((section) => section.startsWith('arms.') || !section.includes('.'));
                if (armSections.length) {
                    for (const section of armSections) mapped.push(section === 'hands' || section === 'arms.hands' ? 'hands' : 'arms');
                } else {
                    mapped.push(tag === 'arms.hands' ? 'hands' : 'arms');
                }
            } else {
                mapped.push(region);
            }
        }
        return { mapped: Array.from(new Set(mapped)), chestClothing };
    }

    function candidates(promptInfo, classifications, region, protectedTokens = {}) {
        if (!BODY_REGIONS.has(region) || region === 'whole') return [];
        const classificationMap = new Map();
        for (const item of Array.isArray(classifications) ? classifications : []) {
            if (!item || typeof item.token !== 'string' || typeof item.tag !== 'string') continue;
            const itemKey = key(item.token);
            if (itemKey && !classificationMap.has(itemKey)) classificationMap.set(itemKey, item);
        }

        const fields = [];
        if (promptInfo && typeof promptInfo.basePrompt === 'string') fields.push(['base', promptInfo.basePrompt]);
        if (promptInfo && Array.isArray(promptInfo.charPrompts)) {
            promptInfo.charPrompts.forEach((prompt, index) => {
                if (typeof prompt === 'string') fields.push([`char-${index}`, prompt]);
            });
        }

        const protectedByField = new Map();
        if (protectedTokens && typeof protectedTokens === 'object') {
            for (const [field, tokens] of Object.entries(protectedTokens)) {
                const values = Array.isArray(tokens) ? tokens : tokens instanceof Set ? Array.from(tokens) : [];
                protectedByField.set(field, new Set(values.filter((token) => typeof token === 'string').map(key)));
            }
        }

        const groupMap = new Map();
        const seen = new Set();
        for (const [field, prompt] of fields) {
            const protectedKeys = protectedByField.get(field) || new Set();
            for (const token of inspect(prompt).tokens) {
                const itemKey = key(token);
                const identity = `${field}\u0000${itemKey}`;
                if (!itemKey || seen.has(identity)) continue;
                seen.add(identity);
                if (protectedKeys.has(itemKey)) continue;
                const classification = classificationMap.get(itemKey);
                if (!classification || typeof classification.tag !== 'string') continue;
                const mapped = canonicalRegions(classification);
                if (!mapped || !mapped.mapped.length) continue;
                if (mapped.mapped.includes(region) || (region === 'back' && mapped.chestClothing)) continue;
                const groupRegion = mapped.mapped[0];
                if (groupRegion === 'whole' || !REGION_NAMES[groupRegion]) continue;
                if (!groupMap.has(groupRegion)) groupMap.set(groupRegion, []);
                groupMap.get(groupRegion).push({ field, token, key: itemKey });
            }
        }

        return Array.from(groupMap, ([groupRegion, items]) => ({
            region: groupRegion,
            name: REGION_NAMES[groupRegion],
            items,
        }));
    }

    return { inspect, key, filter, candidates, canonicalRegions };
});
