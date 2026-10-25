/* Generation-only prompt editor; project assignment belongs to the result gallery. */
(function (root) {
    'use strict';
    const doc = root.document;
    const mediumModel = 'nai-diffusion-5-full-medium';
    const models = {'nai-diffusion-5-full': 'NovelAI V5 Full', [mediumModel]: 'NovelAI V5 Full Medium',
        'nai-diffusion-4-5-full': 'NovelAI V4.5 Full'};
    const optionDefaults = {steps: 28, cfg: 5, cfg_rescale: 0, sampler: 'k_euler_ancestral', noise_schedule: 'karras',
        deliberate_euler_ancestral_bug: false, prefer_brownian: true, dynamic_thresholding: false, legacy_v3_extend: false};
    const mediumOptions = {steps: 14, cfg_rescale: 0, sampler: 'k_euler_ancestral', noise_schedule: 'karras'};
    let serial = 0;
    const node = (tag, className, text) => {
        const item = doc.createElement(tag);
        if (className) item.className = className;
        if (text !== undefined) item.textContent = text;
        return item;
    };
    function button(label, action, className = 'nav-btn') {
        const item = node('button', className, label); item.type = 'button'; item.onclick = action; return item;
    }
    function addOptions(select, choices) {
        for (const [value, label] of choices) { const option = node('option', '', label); option.value = value; select.appendChild(option); }
    }
    async function api(url, body) {
        const response = await root.fetch(url, {method: body === undefined ? 'GET' : 'POST',
            headers: {'Content-Type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
        const result = await response.json();
        if (!response.ok || result.status !== 'success') throw new Error(result.message || '자료를 불러오지 못했습니다.');
        return result;
    }
    function replacePrefix(text, previous, next) {
        let rest = text.trim(); previous = (previous || '').trim();
        if (previous && rest.startsWith(previous) && (!rest.slice(previous.length) || /^[,\s]/.test(rest.slice(previous.length)))) {
            rest = rest.slice(previous.length).replace(/^[,\s]+/, '');
        }
        return [(next || '').trim(), rest].filter(Boolean).join(', ');
    }

    async function create({settings = {}, onChange, tagBrowserEnabled = true} = {}) {
        const prefix = 'dakiDraftEditor' + (++serial) + '-';
        const element = node('section', 'daki-draft-editor');
        const fields = {}, characters = [], panels = [], preservedOptions = {}, promptGroups = new Map();
        let disposed = false, limits = null, style = null, activeInput, translationRevision = 0;
        let picker = null, pickerRevision = 0, wasMedium = false, fullOptions = {};
        function field(key, label, tag = 'input', type = 'text', parent = element) {
            const wrapper = node('label', 'daki-draft-field');
            wrapper.appendChild(node('span', '', label));
            const input = node(tag); input.name = key; input.id = prefix + key;
            input.setAttribute('aria-label', label);
            if (tag === 'input') input.type = type;
            wrapper.appendChild(input); parent.appendChild(wrapper); fields[key] = input;
            input.oninput = changed; input.onchange = changed;
            return input;
        }
        const top = node('div', 'daki-draft-editor-top'); element.appendChild(top);
        const styleName = node('span', 'daki-draft-style-name', '그림체 직접 입력');
        top.append(button('그림체 고르기', openPicker), styleName);
        const basics = node('div', 'daki-draft-basics'); element.appendChild(basics);
        const model = field('model', '모델', 'select', '', basics); addOptions(model, Object.entries(models));
        const size = field('size', '크기 프리셋', 'select', '', basics); addOptions(size, [['custom', '직접 입력']]);
        const sizes = node('div', 'daki-draft-dimensions'); basics.appendChild(sizes);
        const width = field('width', '너비', 'input', 'number', sizes);
        sizes.appendChild(button('⇄', () => { const old = width.value; width.value = height.value; height.value = old; changed(); }));
        sizes.children[1].setAttribute('aria-label', '너비와 높이 바꾸기');
        const height = field('height', '높이', 'input', 'number', sizes);
        const seed = field('seed', '시드', 'input', 'number', basics); seed.min = -1; seed.max = 4294967295; seed.step = 1;
        seed.parentNode.appendChild(node('small', '', '−1은 매번 새 시드'));
        const mediumNote = node('p', 'daki-draft-medium-note', 'Medium: 14 스텝 · Euler Ancestral · Karras 고정. CFG Rescale과 입력한 Nega는 적용되지 않으며 모델의 고정 네거티브를 사용합니다.');
        element.appendChild(mediumNote);
        const prompts = node('section', 'daki-draft-prompts'); element.appendChild(prompts);
        const tabs = node('div', 'daki-style-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '프롬프트 종류'); prompts.appendChild(tabs);
        const promptTools = node('div', 'daki-draft-prompt-tools');
        const targetLabel = node('span', 'daki-draft-target-label');
        const tagButton = button('태그 사전', () => {
            const target = activeInput;
            if (disposed || !tagBrowserEnabled) return;
            if (!root.DakiTagBrowser) { status.textContent = '태그 사전을 불러오지 못했습니다. 새로고침해 주세요.'; return; }
            if (!target || disabled(target)) { root.DakiTagBrowser.open(); return; }
            root.DakiTagBrowser.open({targetLabel: target.getAttribute('aria-label'), onInsert(tag) {
                if (disposed || !target.isConnected || disabled(target)) return;
                const start = target.selectionStart ?? target.value.length, end = target.selectionEnd ?? start;
                if ([...promptGroups.values()].some(controller => controller.insertTag?.(target, tag, start, end))) return;
                const before = target.value.slice(0, start), after = target.value.slice(end);
                const inserted = (before && !/[,\s]$/.test(before) ? ', ' : '') + tag + (after && !/^[,\s]/.test(after) ? ', ' : '');
                target.value = before + inserted + after;
                target.setSelectionRange?.(before.length + inserted.length, before.length + inserted.length);
                changed();
            }});
        });
        tagButton.hidden = tagButton.disabled = !tagBrowserEnabled;
        const translateButton = button('한국어로 미리 보기', translate);
        promptTools.append(targetLabel, tagButton, translateButton); prompts.appendChild(promptTools);
        for (const [key, label] of [['prompt', 'Base'], ['negative_prompt', 'Nega'], ['characters', '캐릭터']]) {
            const index = panels.length, tab = button(label, () => activate(index));
            tab.id = prefix + 'tab-' + key; tab.setAttribute('role', 'tab');
            const panel = node('div', 'daki-draft-prompt-panel'); panel.id = prefix + 'panel-' + key;
            panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id); tab.setAttribute('aria-controls', panel.id);
            let input;
            if (key !== 'characters') { input = promptField(key, label + ' 프롬프트', panel); input.rows = 9; }
            tab.onkeydown = event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? panels.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : panels.length - 1)) % panels.length;
                activate(next); panels[next].tab.focus();
            };
            panels.push({tab, panel, input}); tabs.appendChild(tab); prompts.appendChild(panel);
        }
        const characterPanel = panels[2].panel;
        const characterTools = node('div', 'daki-draft-character-tools'); characterPanel.appendChild(characterTools);
        const positioning = field('character_positioning', '캐릭터 배치', 'select', '', characterTools);
        addOptions(positioning, [['auto', '자동 배치'], ['custom', '좌표 지정']]);
        const addCharacter = button('＋ 캐릭터', () => { appendCharacter(); sync(); changed(); }); characterTools.appendChild(addCharacter);
        const characterCount = node('span', 'daki-draft-character-count'); characterTools.appendChild(characterCount);
        const characterList = node('div', 'daki-draft-character-list'); characterPanel.appendChild(characterList);
        const translation = node('section', 'daki-draft-translation'); translation.hidden = true;
        translation.appendChild(node('b', '', '한국어 미리 보기 · 영문 원본은 유지됩니다.'));
        const translated = node('pre'); translation.appendChild(translated); prompts.appendChild(translation);
        const advanced = node('details', 'daki-draft-advanced'); advanced.appendChild(node('summary', '', '고급 생성 설정')); element.appendChild(advanced);
        const advancedGrid = node('div', 'daki-draft-options'); advanced.appendChild(advancedGrid);
        for (const [key, label, min, max, step] of [['steps', '스텝', 1, 50, 1], ['cfg', 'CFG', 1, 20, .1], ['cfg_rescale', 'CFG Rescale', 0, 1, .01]]) {
            const input = field(key, label, 'input', 'number', advancedGrid); Object.assign(input, {min, max, step});
        }
        for (const [key, label, choices] of [
            ['sampler', '샘플러', ['k_euler_ancestral', 'k_euler', 'k_dpmpp_2m', 'k_dpmpp_2m_sde', 'k_dpmpp_2s_ancestral', 'k_dpmpp_sde']],
            ['noise_schedule', '노이즈 스케줄', ['native', 'karras', 'exponential', 'polyexponential']]]) {
            addOptions(field(key, label, 'select', '', advancedGrid), choices.map(value => [value, value]));
        }
        const preview = node('details', 'daki-draft-english-preview'); preview.appendChild(node('summary', '', '전송할 영문 프롬프트')); element.appendChild(preview);
        const previewText = node('pre'); preview.appendChild(previewText);
        const status = node('p', 'daki-draft-editor-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); element.appendChild(status);

        function disabled(input) { return input.disabled || input.matches?.(':disabled'); }
        function promptField(key, label, parent) {
            const entry = node('div', 'daki-draft-prompt-entry'); parent.appendChild(entry);
            const input = field(key, label, 'textarea', '', entry); input.maxLength = 30000;
            input.placeholder = '영문 태그 또는 문장을 입력하세요.';
            input.onfocus = () => setActive(input);
            if (root.DakiPromptGroups?.create) {
                const controller = root.DakiPromptGroups.create({input, label, onChange: changed, onFocus: setActive});
                promptGroups.set(input, controller);
            }
            return input;
        }
        function firstPromptInput(input) {
            return input ? (promptGroups.get(input)?.firstInput?.() || input) : null;
        }
        function setActive(input) {
            activeInput = input; targetLabel.textContent = input?.getAttribute('aria-label') || '캐릭터 없이도 태그 사전을 볼 수 있습니다.';
            translateButton.disabled = !input || disabled(input);
            translationRevision++; translation.hidden = true;
        }
        function activate(index) {
            panels.forEach((entry, offset) => {
                entry.panel.hidden = offset !== index; entry.tab.tabIndex = offset === index ? 0 : -1;
                entry.tab.setAttribute('aria-selected', String(offset === index));
            });
            setActive(firstPromptInput(panels[index].input || characters[0]?.prompt));
        }
        function appendCharacter(value = {}, restoring = false) {
            if (!restoring && characters.length >= (model.value === 'nai-diffusion-4-5-full' ? 6 : 22)) return;
            const row = node('section', 'daki-draft-character');
            const header = node('div', 'daki-draft-character-heading');
            const title = node('b'); header.appendChild(title); row.appendChild(header);
            const key = 'character-' + (++serial);
            const prompt = promptField(key + '-prompt', '캐릭터 프롬프트', row);
            const negative = promptField(key + '-negative', '캐릭터 네거티브', row); prompt.rows = negative.rows = 3;
            const coordinates = node('div', 'daki-draft-coordinates'); row.appendChild(coordinates);
            const x = field(key + '-x', '가로 위치 (0~1)', 'input', 'number', coordinates);
            const y = field(key + '-y', '세로 위치 (0~1)', 'input', 'number', coordinates);
            for (const input of [x, y]) Object.assign(input, {min: 0, max: 1, step: .01});
            prompt.value = value.prompt || ''; negative.value = value.negative_prompt || ''; x.value = value.x ?? .5; y.value = value.y ?? .5;
            promptGroups.get(prompt)?.reset(); promptGroups.get(negative)?.reset();
            const entry = {row, title, prompt, negative, x, y, coordinates}; characters.push(entry); characterList.appendChild(row);
            header.appendChild(button('삭제', () => {
                const wasActive = activeInput === prompt || activeInput === negative || inside(activeInput, row);
                removePrompt(prompt); removePrompt(negative);
                for (const input of [prompt, negative, x, y]) delete fields[input.name];
                characters.splice(characters.indexOf(entry), 1); row.remove();
                if (wasActive) setActive(firstPromptInput(characters[0]?.prompt));
                sync(); changed();
            }));
            if (panels[2].panel.hidden === false && !activeInput) setActive(firstPromptInput(prompt));
        }
        function inside(target, container) {
            for (let item = target; item; item = item.parentNode) if (item === container) return true;
            return false;
        }
        function removePrompt(input) {
            promptGroups.get(input)?.dispose(); promptGroups.delete(input);
        }
        function sync() {
            const medium = model.value === mediumModel;
            if (medium && !wasMedium) {
                fullOptions = Object.fromEntries(Object.keys(mediumOptions).map(key => [key, fields[key].value]));
                for (const [key, value] of Object.entries(mediumOptions)) fields[key].value = value;
            } else if (!medium && wasMedium) {
                for (const [key, value] of Object.entries(fullOptions)) fields[key].value = value;
            }
            wasMedium = medium; mediumNote.hidden = !medium;
            for (const key of Object.keys(mediumOptions)) fields[key].disabled = medium;
            fields.negative_prompt.disabled = medium;
            const max = model.value === 'nai-diffusion-4-5-full' ? 6 : 22;
            characters.forEach((entry, index) => {
                entry.title.textContent = '캐릭터 ' + (index + 1); entry.negative.disabled = medium;
                entry.coordinates.hidden = positioning.value !== 'custom';
                entry.x.disabled = entry.y.disabled = positioning.value !== 'custom';
            });
            addCharacter.disabled = characters.length >= max;
            characterCount.textContent = `${characters.length} / ${max}`;
            promptGroups.forEach(controller => controller.refresh());
            translateButton.disabled = !activeInput || disabled(activeInput);
            const dimensions = `${width.value}x${height.value}`;
            size.value = [...size.querySelectorAll('option')].some(option => option.value === dimensions) ? dimensions : 'custom';
        }
        function number(input) { return input.value.trim() === '' ? NaN : Number(input.value); }
        function draft() {
            promptGroups.forEach(controller => controller.flush());
            return {prompt: fields.prompt.value, negative_prompt: fields.negative_prompt.value, model: model.value,
                width: number(width), height: number(height), seed: number(seed), character_positioning: positioning.value,
                char_prompts: characters.map(entry => ({prompt: entry.prompt.value, negative_prompt: entry.negative.value,
                    x: number(entry.x), y: number(entry.y)})),
                options: Object.fromEntries(Object.entries(optionDefaults).map(([key, value]) => [key,
                    typeof value === 'boolean' ? preservedOptions[key] : typeof value === 'number' ? number(fields[key]) : fields[key].value])),
                style: style ? {...style} : null};
        }
        function showEnglish(value) {
            const medium = value.model === mediumModel;
            previewText.textContent = ['Base\n' + value.prompt, 'Nega\n' + (medium ? '(Medium 모델의 고정 네거티브 사용)' : value.negative_prompt),
                ...value.char_prompts.flatMap((item, index) => ['캐릭터 ' + (index + 1) + '\n' + item.prompt,
                    ...(medium ? [] : ['캐릭터 ' + (index + 1) + ' Nega\n' + item.negative_prompt])])].join('\n\n');
        }
        function changed() {
            if (disposed) return;
            translationRevision++; translation.hidden = true; status.textContent = '';
            sync(); const value = draft(); showEnglish(value); onChange?.(value);
        }
        function setSettings(value = {}) {
            if (disposed) return;
            pickerRevision++; if (picker?.open) picker.close();
            translationRevision++; translation.hidden = true; wasMedium = false;
            for (const [key, fallback] of Object.entries({prompt: '', negative_prompt: '', model: 'nai-diffusion-5-full', width: 512,
                height: 768, seed: -1, character_positioning: 'auto'})) fields[key].value = value[key] ?? fallback;
            for (const [key, fallback] of Object.entries(optionDefaults)) {
                // Preserve imported compatibility flags without exposing generation controls for them.
                if (typeof fallback === 'boolean') preservedOptions[key] = value.options?.[key] ?? fallback;
                else fields[key].value = value.options?.[key] ?? fallback;
            }
            style = value.style ? {...value.style} : null; styleName.textContent = style?.name || '그림체 직접 입력';
            promptGroups.get(fields.prompt)?.reset(); promptGroups.get(fields.negative_prompt)?.reset();
            characters.forEach(entry => { removePrompt(entry.prompt); removePrompt(entry.negative); });
            characters.splice(0); characterList.replaceChildren();
            // Keep every loaded character so changing to a smaller model requires explicit removal.
            (value.char_prompts || []).forEach(item => appendCharacter(item, true));
            activate(0); sync(); showEnglish(draft());
            if (style) {
                promptGroups.get(fields.prompt)?.groupPrefix(style.positive, style.name);
                promptGroups.get(fields.negative_prompt)?.groupPrefix(style.negative, style.name);
            }
            setActive(promptGroups.get(fields.prompt)?.firstInput?.() || fields.prompt);
            status.textContent = '';
        }
        function read() {
            if (disposed) return null;
            const value = draft(); let error = '';
            if (!limits) error = '크기 설정을 불러온 뒤 생성할 수 있습니다.';
            else if (!models[value.model]) error = '지원되는 모델을 선택해 주세요.';
            else if (![value.width, value.height].every(n => Number.isInteger(n) && n >= limits.min && n <= limits.max && n % limits.step === 0)
                || value.width * value.height > limits.max_pixels) error = `크기는 ${limits.min}~${limits.max}px 사이의 ${limits.step} 배수, 최대 ${limits.max_pixels.toLocaleString('ko-KR')}픽셀로 입력해 주세요.`;
            else if (!Number.isInteger(value.seed) || value.seed < -1 || value.seed > 4294967295) error = '시드는 −1 또는 0~4294967295 정수로 입력해 주세요.';
            else if (value.char_prompts.length > (value.model === 'nai-diffusion-4-5-full' ? 6 : 22)) error = '이 모델의 최대 캐릭터 수에 맞게 캐릭터를 줄여 주세요.';
            else if (!['auto', 'custom'].includes(value.character_positioning)) error = '캐릭터 배치를 선택해 주세요.';
            else if (value.character_positioning === 'custom' && value.char_prompts.some(item => ![item.x, item.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1))) error = '캐릭터 좌표는 0~1 사이로 입력해 주세요.';
            if (!error && [value.prompt, value.negative_prompt, ...value.char_prompts.flatMap(item => [item.prompt, item.negative_prompt])].some(text => text.length > 30000)) error = '프롬프트는 각각 30,000자까지 입력할 수 있습니다.';
            if (value.model === mediumModel) Object.assign(value.options, mediumOptions);
            for (const [key, low, high, integer] of [['steps', 1, 50, true], ['cfg', 1, 20, false], ['cfg_rescale', 0, 1, false]]) {
                const n = value.options[key];
                if (!error && (!Number.isFinite(n) || n < low || n > high || integer && !Number.isInteger(n))) error = `${key}: ${low}~${high} 범위로 입력해 주세요.`;
            }
            for (const key of ['sampler', 'noise_schedule']) {
                if (!error && ![...fields[key].querySelectorAll('option')].some(option => option.value === value.options[key])) error = '지원되는 생성 설정을 선택해 주세요.';
            }
            if (error) { status.textContent = error; return null; }
            value.prompt = value.prompt.trim(); value.negative_prompt = value.negative_prompt.trim();
            value.char_prompts = value.char_prompts.map(item => ({...item, prompt: item.prompt.trim(), negative_prompt: item.negative_prompt.trim(),
                ...(value.character_positioning === 'auto' ? {x: .5, y: .5} : {})}));
            status.textContent = ''; return value;
        }
        async function translate() {
            const target = activeInput;
            if (!target || disabled(target)) return;
            let controller = null, text = target.value;
            for (const candidate of promptGroups.values()) {
                const value = candidate.valueFor?.(target);
                if (value !== null && value !== undefined) { controller = candidate; text = value; break; }
            }
            if (!text.trim()) return;
            const token = ++translationRevision;
            translation.hidden = false; translated.textContent = '번역을 불러오는 중…';
            try {
                const result = await api('/api/daki/tag-catalog/translate', {text});
                const currentText = controller ? controller.valueFor(target) : target.value;
                if (disposed || token !== translationRevision || target !== activeInput || currentText !== text) return;
                translated.textContent = result.text;
            } catch (error) { if (!disposed && token === translationRevision) translated.textContent = error.message; }
        }
        async function openPicker() {
            if (disposed) return;
            if (picker?.open) picker.close();
            const dialog = picker = node('dialog', 'daki-dialog daki-draft-style-picker');
            const header = node('div', 'daki-draft-picker-header'); header.append(node('h2', '', '그림체 고르기'), button('닫기', () => dialog.close()));
            const controls = node('div', 'daki-draft-picker-controls');
            const library = node('select'); library.setAttribute('aria-label', '그림체 라이브러리');
            addOptions(library, [['shared', '공유 그림체'], ['personal', '개인 그림체'], ['tests', '기존 테스트'], ['worldcups', '월드컵 결과']]); library.value = style?.library || 'shared';
            const record = node('select'); record.hidden = true; record.setAttribute('aria-label', '기준 기록');
            const search = node('input'); search.type = 'search'; search.placeholder = '그림체 이름 검색'; search.setAttribute('aria-label', '그림체 이름 검색');
            controls.append(library, record, search);
            const note = node('p', '', '선택한 그림의 원본 그림체에서 Base·Nega, 모델·생성 설정을 가져옵니다. 테스트는 그림을 고르는 데만 사용하며, 현재 크기·시드·캐릭터는 유지됩니다.');
            const message = node('p'); message.setAttribute('role', 'status');
            const tagFilters = root.DakiGalleryFilters.create({title: '그림체 선택', tagOnly: true, onChange: filter});
            const grid = node('div', 'daki-draft-picker-grid'); dialog.append(header, controls, tagFilters.element, note, message, grid); doc.body.appendChild(dialog);
            let rows = [], detailToken = 0, activeStyles = new Map(), recordIds = new Set();
            const live = token => !disposed && picker === dialog && dialog.open && token === pickerRevision;
            const sourceKey = source => source.library + ':' + source.id;
            function sourceFromPath(path) {
                if (typeof path !== 'string') return null;
                for (const [kind, expression] of [
                    ['shared', /^__daki_shared__\/([A-Za-z0-9_-]{1,128})\.png$/],
                    ['personal', /^__daki_personal__\/(personal_[a-f0-9]{32})\.png$/],
                    ['test', /^__daki_tests__\/[a-f0-9]{32}\/([A-Za-z0-9_-]{1,128})\.png$/]]) {
                    const match = path.match(expression);
                    if (match?.[0] === path) return {id: match[1], library: kind === 'test' ? (match[1].startsWith('personal_') ? 'personal' : 'shared') : kind};
                }
                return null;
            }
            function describe(entry) {
                const date = new Date(entry.created_at);
                return [entry.name || entry.title || '이름 없는 기록', Number.isNaN(date.getTime()) ? '' : date.toLocaleString('ko-KR')].filter(Boolean).join(' · ');
            }
            function filter() {
                const query = search.value.trim().toLowerCase();
                const matches = new Set(tagFilters.apply(rows).filter(row => row.name.toLowerCase().includes(query)));
                rows.forEach(row => { row.card.hidden = !matches.has(row); });
                if (!rows.length) return;
                const unavailable = [...matches].filter(row => row.card.disabled).length;
                message.textContent = matches.size ? `${matches.size} / ${rows.length}개 그림 · 선택 가능 ${matches.size - unavailable}개`
                    + (unavailable ? ` · 원본 연결 불가 ${unavailable}개` : '') : '태그와 검색 조건에 맞는 그림체가 없습니다.';
            }
            function render(items, token, emptyText) {
                message.textContent = emptyText;
                grid.replaceChildren();
                rows = items.map(item => {
                    const original = item.source && activeStyles.get(sourceKey(item.source));
                    const reason = original ? '' : item.source ? '삭제되었거나 현재 목록에 없는 원본 그림체' : '원본 그림체 연결이 없는 그림';
                    const card = button('', () => { if (!reason) return choose(original, item.source.library, token); }, 'item-box daki-draft-picker-card');
                    card.disabled = !!reason;
                    if (item.src) { const image = node('img'); image.src = item.src; image.alt = ''; image.loading = 'lazy'; card.appendChild(image); }
                    else card.appendChild(node('span', 'daki-draft-picker-placeholder', '🖼️'));
                    if (item.rankLabel) card.appendChild(node('span', 'daki-draft-picker-rank', item.rankLabel));
                    card.appendChild(node('span', 'gallery-card-actions', item.name));
                    if (reason) card.appendChild(node('span', 'daki-draft-picker-unavailable', reason));
                    card.setAttribute('aria-label', item.name + (reason ? ' · ' + reason : ' 적용'));
                    grid.appendChild(card); return {name: item.name, path: item.path, card};
                });
                filter();
            }
            async function load() {
                const token = ++pickerRevision; detailToken++; rows = []; grid.replaceChildren(); message.textContent = '그림체를 불러오는 중…';
                const selectedLibrary = library.value;
                const history = selectedLibrary === 'tests' || selectedLibrary === 'worldcups';
                record.hidden = !history; record.disabled = true; record.replaceChildren(); recordIds = new Set(); activeStyles = new Map();
                record.setAttribute('aria-label', selectedLibrary === 'tests' ? '기준 테스트' : '기준 월드컵');
                addOptions(record, [['', selectedLibrary === 'tests' ? '테스트 선택' : '월드컵 기록 선택']]); record.value = '';
                try {
                    if (history) {
                        const [result, shared, personal] = await Promise.all([
                            api('/api/daki/' + (selectedLibrary === 'tests' ? 'style-tests' : 'worldcups')),
                            api('/api/daki/shared-styles'), api('/api/daki/personal-styles')]);
                        if (!live(token)) return;
                        for (const [kind, catalog] of [['shared', shared], ['personal', personal]]) {
                            catalog.styles.forEach(item => activeStyles.set(sourceKey({id: item.id, library: kind}), item));
                        }
                        const entries = selectedLibrary === 'tests' ? result.batches : result.records;
                        entries.filter(entry => typeof entry.id === 'string' && /^[a-f0-9]{32}$/.test(entry.id) && entry.id.length === 32).forEach(entry => {
                            recordIds.add(entry.id); addOptions(record, [[entry.id, describe(entry)]]);
                        });
                        record.disabled = !recordIds.size;
                        message.textContent = recordIds.size ? '기록을 선택하면 그 안의 그림을 볼 수 있습니다.' : '저장된 기록이 없습니다.';
                    } else {
                        const result = await api('/api/daki/' + (selectedLibrary === 'personal' ? 'personal-styles' : 'shared-styles'));
                        if (!live(token)) return;
                        result.styles.forEach(item => activeStyles.set(sourceKey({id: item.id, library: selectedLibrary}), item));
                        render(result.styles.map(item => ({...item, path: `__daki_${selectedLibrary}__/${item.id}.png`,
                            source: {id: item.id, library: selectedLibrary}})), token, '등록된 그림체가 없습니다.');
                    }
                } catch (error) { if (live(token)) message.textContent = error.message; }
            }
            async function loadRecord() {
                const token = ++pickerRevision; detailToken++; rows = []; grid.replaceChildren();
                const selectedLibrary = library.value, id = record.value;
                if (!recordIds.has(id)) { message.textContent = '기록을 선택해 주세요.'; return; }
                message.textContent = '기록의 그림을 불러오는 중…';
                try {
                    const result = await api('/api/daki/' + (selectedLibrary === 'tests' ? 'style-tests/' : 'worldcups/') + encodeURIComponent(id));
                    if (!live(token)) return;
                    let items;
                    if (selectedLibrary === 'tests') {
                        items = result.batch.items.filter(item => item.status === 'completed' && item.src).map(item => ({
                            name: item.name, src: item.src, path: `__daki_tests__/${id}/${item.style_id}.png`,
                            source: sourceFromPath(`__daki_tests__/${id}/${item.style_id}.png`)}));
                    } else {
                        const ranked = result.record.participants.map((item, index) => ({item, index}));
                        const rankCounts = new Map(); ranked.forEach(({item}) => rankCounts.set(item.rank, (rankCounts.get(item.rank) || 0) + 1));
                        items = ranked.sort((a, b) => a.item.rank - b.item.rank || a.index - b.index).map(({item}) => ({
                            name: item.name, src: item.src, path: item.path, source: sourceFromPath(item.path),
                            rankLabel: Number.isInteger(item.rank) && item.rank > 0 ? (rankCounts.get(item.rank) > 1 ? '공동 ' : '') + item.rank + '위' : ''}));
                    }
                    render(items, token, '완성된 그림이 없습니다.');
                } catch (error) { if (live(token)) message.textContent = error.message; }
            }
            async function choose(item, libraryName, token) {
                const detail = ++detailToken; message.textContent = item.name + ' 설정을 불러오는 중…';
                try {
                    const result = await api('/api/daki/' + (libraryName === 'personal' ? 'personal-styles/' : 'shared-styles/') + encodeURIComponent(item.id));
                    if (!live(token) || detail !== detailToken) return;
                    const chosen = result.style;
                    if (chosen.id !== item.id) throw new Error('선택한 원본 그림체를 찾을 수 없습니다.');
                    if (!models[chosen.model]) throw new Error('지원되지 않는 모델의 그림체입니다.');
                    if (characters.length > (chosen.model === 'nai-diffusion-4-5-full' ? 6 : 22)) throw new Error('이 그림체 모델의 캐릭터 수에 맞게 캐릭터를 줄인 뒤 적용해 주세요.');
                    fields.prompt.value = replacePrefix(fields.prompt.value, style?.positive, chosen.positive);
                    fields.negative_prompt.value = replacePrefix(fields.negative_prompt.value, style?.negative, chosen.negative);
                    wasMedium = false; model.value = chosen.model;
                    for (const [key, fallback] of Object.entries(optionDefaults)) {
                        if (typeof fallback === 'boolean') preservedOptions[key] = chosen.options?.[key] ?? fallback;
                        else fields[key].value = chosen.options?.[key] ?? fallback;
                    }
                    style = {id: chosen.id, name: chosen.name, library: libraryName, positive: chosen.positive || '', negative: chosen.negative || ''};
                    styleName.textContent = style.name; dialog.close(); activate(0); changed();
                    promptGroups.get(fields.prompt)?.groupPrefix(style.positive, style.name);
                    promptGroups.get(fields.negative_prompt)?.groupPrefix(style.negative, style.name);
                    setActive(promptGroups.get(fields.prompt)?.firstInput?.() || fields.prompt);
                } catch (error) { if (live(token) && detail === detailToken) message.textContent = error.message; }
            }
            dialog.addEventListener('close', () => { pickerRevision++; detailToken++; tagFilters.dispose(); dialog.remove(); if (picker === dialog) picker = null; }, {once: true});
            library.onchange = load; record.onchange = loadRecord; search.oninput = filter; dialog.showModal(); await load();
        }
        // Select emits input before change; only sync after applying its new dimensions.
        size.oninput = null;
        size.onchange = () => {
            if (size.value !== 'custom') { const [w, h] = size.value.split('x'); width.value = w; height.value = h; }
            changed();
        };
        setSettings(settings);
        status.textContent = '크기 프리셋을 불러오는 중…';
        try {
            const result = await api('/api/daki/style-tests/options');
            if (!disposed) {
                limits = result.size_limits;
                for (const preset of result.size_presets) {
                    const group = node('optgroup'); group.label = preset.label;
                    addOptions(group, preset.sizes.map(([w, h]) => [`${w}x${h}`, root.formatGenerationSize(w, h, limits)])); size.appendChild(group);
                }
                for (const input of [width, height]) Object.assign(input, {min: limits.min, max: limits.max, step: limits.step});
                sync(); status.textContent = '';
            }
        } catch (error) { if (!disposed) status.textContent = '크기 설정을 불러오지 못했습니다: ' + error.message; }
        return {element, read, setSettings, dispose() {
            if (disposed) return;
            disposed = true; translationRevision++; pickerRevision++; if (picker?.open) picker.close();
            promptGroups.forEach(controller => controller.dispose()); promptGroups.clear();
        }};
    }
    root.DakiDraftEditor = {create};
})(window);
