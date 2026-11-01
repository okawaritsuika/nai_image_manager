/* Shared source and original-model filtering for style lists and test targets. */
(function (root) {
    'use strict';
    const doc = root.document;
    const sources = [['all', '전체 출처'], ['naim', '기존 공유'], ['artist', '그림체 관리 공유'], ['personal', '개인']];
    const sourceTitles = {all: '전체 출처', naim: '기존 공유 그림체', artist: '그림체 관리 공유 그림체', personal: '개인 그림체'};
    const models = [['all', '전체 원본 모델'], ['v5', 'V5'], ['v4_5', 'V4.5'], ['other', '기타']];

    function modelFamily(style) {
        const family = style?.model_family;
        if (Object.prototype.hasOwnProperty.call(style || {}, 'model_family')) {
            return ['v5', 'v4_5', 'other'].includes(family) ? family : 'other';
        }
        const model = String(style?.model || '').trim();
        if (/\bnai-diffusion-5(?:-[a-z0-9]+)*\b|\bnaid5f\b|\b(?:novelai\s+diffusion\s+)?v5(?:\s+full(?:[\s-]+medium)?)?\b/i.test(model)) return 'v5';
        if (/\bnai-diffusion-4-5(?:-[a-z0-9]+)*\b|\b(?:novelai\s+diffusion\s+)?v4\.5\b/i.test(model)) return 'v4_5';
        return 'other';
    }

    function sourceLibrary(style) {
        if (!Object.prototype.hasOwnProperty.call(style || {}, 'source_library')) return 'naim';
        return style.source_library;
    }

    function matches(style, values = {}) {
        return (values.source === undefined || values.source === 'all' || sourceLibrary(style) === values.source)
            && (values.model === undefined || values.model === 'all' || modelFamily(style) === values.model);
    }

    function create({onChange, source = 'all', model = 'all', personal = false} = {}) {
        const element = doc.createElement('div');
        element.className = 'daki-style-scope';
        const fields = {};
        function field(name, label, options, value) {
            const wrapper = doc.createElement('label');
            const caption = doc.createElement('span'); caption.textContent = label;
            const select = doc.createElement('select'); select.className = 'filter-select'; select.name = 'daki_scope_' + name;
            select.setAttribute('aria-label', label);
            options.forEach(([optionValue, optionLabel]) => {
                const option = doc.createElement('option'); option.value = optionValue; option.textContent = optionLabel;
                select.appendChild(option);
            });
            select.value = value;
            if (name === 'source') select.title = sourceTitles[value] || sourceTitles.all;
            select.onchange = () => {
                if (name === 'source') select.title = sourceTitles[select.value] || sourceTitles.all;
                onChange?.(values());
            };
            wrapper.append(caption, select); element.appendChild(wrapper); fields[name] = select;
        }
        if (!personal) field('source', '출처', sources, source);
        field('model', '원본 모델', models, model);
        const values = () => ({source: personal ? 'personal' : fields.source.value, model: fields.model.value});
        return {
            element,
            apply(items, styleOf = item => item) { return items.filter(item => matches(styleOf(item), values())); },
            values,
        };
    }

    root.DakiStyleScope = {create, matches, modelFamily};
})(typeof window === 'undefined' ? globalThis : window);
