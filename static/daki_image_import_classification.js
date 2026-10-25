/* Read-only meaning annotations: retain character text, weights and unknown tags. */
(function (root, factory) {
    const api = factory(root, typeof module === 'object' && module.exports
        ? require('./canvas_daki_prompt_rules.js') : root.CanvasDakiPromptRules);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.DakiImageImportClassification = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function (root, rules) {
    'use strict';

    function groupCharacters(characters, records) {
        const metadata = new Map(records.map(item => [rules.key(item.token), item]));
        const groups = [];
        let classifiedCount = 0, unknownCount = 0, invalidCharacters = 0;
        characters.forEach((text, characterIndex) => {
            const parsed = rules.inspect(text);
            if (!parsed.valid) { invalidCharacters++; return; }
            const byRegion = new Map();
            for (const token of parsed.tokens) {
                const record = metadata.get(rules.key(token));
                const canonical = record && typeof record.tag === 'string' ? rules.canonicalRegions(record) : null;
                if (!canonical?.mapped.length) { unknownCount++; continue; }
                const regions = canonical.mapped.map(region => canonical.chestClothing && region === 'chest' ? 'clothes' : region);
                for (const region of new Set(regions)) {
                    if (!byRegion.has(region)) byRegion.set(region, new Set());
                    byRegion.get(region).add(rules.key(token));
                }
                classifiedCount++;
            }
            for (const [region, kept] of byRegion) {
                const excluded = parsed.tokens.filter(token => !kept.has(rules.key(token)));
                groups.push({region, characterIndex, prompt: rules.filter(text, excluded)});
            }
        });
        return {groups, classifiedCount, unknownCount, invalidCharacters};
    }

    async function classify(characters, {signal, fetcher = root.fetch.bind(root)} = {}) {
        const tokens = [...new Set(characters.flatMap(text => rules.inspect(text).tokens))]
            .filter(token => token.length <= 500);
        const records = [];
        let start = 0;
        while (start < tokens.length) {
            const batch = []; let length = 0;
            while (start < tokens.length && batch.length < 2000 && length + tokens[start].length <= 50000) {
                const token = tokens[start++]; batch.push(token); length += token.length;
            }
            const response = await fetcher('/api/daki/tag-catalog/classify', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({tokens: batch}), signal,
            });
            const result = await response.json();
            if (!response.ok || result.status !== 'success' || !Array.isArray(result.items)
                    || result.items.length !== batch.length
                    || result.items.some((item, index) => item?.token !== batch[index])) {
                throw new Error(result.message || '부위 분류를 불러오지 못했습니다. 직접 지정하거나 다시 시도해 주세요.');
            }
            records.push(...result.items);
        }
        return groupCharacters(characters, records);
    }

    return {classify, groupCharacters};
});
