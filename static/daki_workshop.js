let dakiArtStyleData = {
    saved_styles: [],
    weighted_artists: []
};
let dakiArtStyleActiveTab = 'saved_styles';
let selectedDakiArtStyle = null;

let activeTagTranslationOriginalTarget = '';
let activeTagTranslationParts = [];
let activeTagTranslationJoiner = ' ';
let currentImageBase64 = null;
let tagDictionary = {};
let promptViewMode = 'buttons';
let promptGroups = [];
let selectedPromptGroup = null;
let selectedTagDictionaryItem = null;
let tagDictionarySearchTimer = null;
let tagDictionaryBrowseState = null;
let activeImageContext = null;
let currentSavedPath = '';
let activeTagTranslationTarget = null;
let generatedDakiImages = [];
let currentDakiTempId = '';
let dakiGallerySaveInProgress = false;
let promptGroupSearchText = '';
let promptGroupActiveTag = 'ALL';
let promptGroupVisibleLimit = 80;
const PROMPT_GROUP_PAGE_SIZE = 80;

const el = (id) => document.getElementById(id);
const staticPromptFields = [
    { key: 'base', inputId: 'basePrompt', tokensId: 'basePromptTokens' },
    { key: 'negative', inputId: 'negPrompt', tokensId: 'negativePromptTokens' }
];

let charPromptEditorSeq = 1;

function getPromptFields() {
    const dynamicCharFields = [...document.querySelectorAll('#charPromptList .char-prompt-item')]
        .map((node) => {
            const id = node.dataset.charPromptId;
            return {
                key: `char-${id}`,
                inputId: `charPrompt-${id}`,
                tokensId: `charPromptTokens-${id}`,
                isChar: true
            };
        });

    return [...staticPromptFields, ...dynamicCharFields];
}

function getCharacterPromptValues() {
    return [...document.querySelectorAll('#charPromptList textarea')]
        .map((textarea) => String(textarea.value || '').trim())
        .filter(Boolean);
}

function setCharacterPromptValues(values) {
    const list = normalizeCharPromptList(values);
    const container = el('charPromptList');
    if (!container) return;

    container.innerHTML = '';

    if (!list.length) {
        addCharacterPromptEditor('');
        return;
    }

    list.forEach((value) => addCharacterPromptEditor(value));
}

function addCharacterPromptEditor(initialValue = '') {
    const container = el('charPromptList');
    if (!container) return;

    const id = `cp${charPromptEditorSeq++}`;
    const index = container.querySelectorAll('.char-prompt-item').length + 1;

    const item = document.createElement('div');
    item.className = 'char-prompt-item';
    item.dataset.charPromptId = id;
    item.style.cssText = 'border:1px solid var(--border-color); border-radius:10px; padding:10px; margin-bottom:10px; background:var(--bg-color);';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;';

    const title = document.createElement('div');
    title.className = 'char-prompt-title';
    title.style.cssText = 'font-size:12px; font-weight:800;';
    title.innerText = `Character Prompt ${index}`;

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'danger';
    deleteBtn.style.cssText = 'padding:4px 8px; font-size:12px;';
    deleteBtn.innerText = '삭제';
    deleteBtn.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        removeCharacterPromptEditor(id);
    };

    const tokens = document.createElement('div');
    tokens.id = `charPromptTokens-${id}`;
    tokens.className = 'prompt-token-surface compact';

    const textarea = document.createElement('textarea');
    textarea.id = `charPrompt-${id}`;
    textarea.className = 'prompt-raw-textarea';
    textarea.rows = 2;
    textarea.value = initialValue || '';

    header.appendChild(title);
    header.appendChild(deleteBtn);
    item.appendChild(header);
    item.appendChild(tokens);
    item.appendChild(textarea);
    container.appendChild(item);

    bindPromptInputs();
    renderAllPromptTokens();
    applyPromptViewMode();
    refreshCharacterPromptIndexes();
}

function removeCharacterPromptEditor(id) {
    const container = el('charPromptList');
    if (!container) return;

    const item = container.querySelector(`.char-prompt-item[data-char-prompt-id="${id}"]`);
    if (item) item.remove();

    if (!container.querySelector('.char-prompt-item')) {
        addCharacterPromptEditor('');
        return;
    }

    bindPromptInputs();
    renderAllPromptTokens();
    applyPromptViewMode();
    refreshCharacterPromptIndexes();

    // 삭제 후 설정에 바로 반영
    saveConfig(true);
}

function refreshCharacterPromptIndexes() {
    [...document.querySelectorAll('#charPromptList .char-prompt-item')].forEach((item, index) => {
        const title = item.querySelector('.char-prompt-title');
        if (title) title.innerText = `Character Prompt ${index + 1}`;
    });
}

async function apiFetch(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(data.message || data.error || `HTTP Error ${response.status}`);
    return data;
}

function normalizeSharedPromptGroups(groups) {
    if (!Array.isArray(groups)) return [];

    const result = [];

    groups.forEach((group) => {
        if (!group || typeof group !== 'object') return;

        const name = String(group.name || '').trim();
        const prompts = Array.isArray(group.prompts)
            ? group.prompts.map(prompt => String(prompt || '').trim()).filter(Boolean)
            : [];

        if (!name || !prompts.length) return;

        const tags = Array.isArray(group.tags)
            ? group.tags.map(tag => String(tag || '').trim().replace(/^#+/, '')).filter(Boolean)
            : String(group.tags || '')
                .split(/[,#\n]+/)
                .map(tag => tag.trim().replace(/^#+/, ''))
                .filter(Boolean);

        result.push({
            name,
            prompts,
            tags: [...new Set(tags)],
            collapsed: group.collapsed === undefined ? true : Boolean(group.collapsed)
        });
    });

    const map = new Map();
    result.forEach((group) => map.set(group.name, group));

    return [...map.values()];
}

function mergePromptGroupLists(baseGroups, incomingGroups) {
    const map = new Map();

    normalizeSharedPromptGroups(baseGroups).forEach((group) => {
        map.set(group.name, group);
    });

    normalizeSharedPromptGroups(incomingGroups).forEach((group) => {
        map.set(group.name, group);
    });

    return [...map.values()];
}

function getPromptGroupTagsFromInput(value) {
    return String(value || '')
        .split(/[,#\n]+/)
        .map(tag => tag.trim().replace(/^#+/, ''))
        .filter(Boolean)
        .filter((tag, index, arr) => arr.indexOf(tag) === index);
}

function getAllPromptGroupTags() {
    const tags = new Set();

    normalizeSharedPromptGroups(promptGroups).forEach((group) => {
        (group.tags || []).forEach((tag) => tags.add(tag));
    });

    return [...tags].sort((a, b) => a.localeCompare(b));
}

function promptGroupMatchesManagerFilter(group) {
    const search = String(promptGroupSearchText || '').trim().toLowerCase();
    const tag = String(promptGroupActiveTag || 'ALL');

    if (tag !== 'ALL' && !(group.tags || []).includes(tag)) {
        return false;
    }

    if (!search) return true;

    const haystack = [
        group.name,
        (group.tags || []).join(' '),
        (group.prompts || []).join(' ')
    ].join(' ').toLowerCase();

    return haystack.includes(search);
}

function getFilteredPromptGroupsForManager() {
    return normalizeSharedPromptGroups(promptGroups)
        .map((group, index) => ({ group, index }))
        .filter(({ group }) => promptGroupMatchesManagerFilter(group));
}

function ensurePromptGroupManagerControls() {
    const list = el('promptGroupList');
    if (!list || el('promptGroupManagerControls')) return;

    const controls = document.createElement('div');
    controls.id = 'promptGroupManagerControls';
    controls.style.cssText = `
        display:flex;
        flex-direction:column;
        gap:8px;
        margin-bottom:12px;
        padding:10px;
        border:1px solid var(--border-color);
        border-radius:10px;
        background:rgba(255,255,255,0.03);
    `;

    controls.innerHTML = `
        <div style="display:flex; gap:8px; align-items:center;">
            <input id="promptGroupSearchInput"
                   type="text"
                   placeholder="그룹명 / 태그 / 프롬프트 검색..."
                   style="flex:1; min-width:0; padding:9px 11px; border-radius:8px; border:1px solid var(--border-color); background:var(--bg-color); color:var(--text-color);">
            <select id="promptGroupTagFilter"
                    style="width:160px; padding:9px 34px 9px 10px; border-radius:8px; border:1px solid var(--border-color); background-color:var(--bg-color); color:var(--text-color); appearance:none; background-image:url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%228%22 viewBox=%220 0 12 8%22%3E%3Cpath fill=%22%23d1d5db%22 d=%22M1.41.59 6 5.17 10.59.59 12 2l-6 6-6-6z%22/%3E%3C/svg%3E'); background-repeat:no-repeat; background-position:right 13px center;">
                <option value="ALL">전체 태그</option>
            </select>
        </div>
        <div id="promptGroupManagerSummary" style="font-size:12px; color:var(--text-muted);"></div>
    `;

    list.parentNode.insertBefore(controls, list);

    const searchInput = el('promptGroupSearchInput');
    const tagFilter = el('promptGroupTagFilter');

    if (searchInput) {
        searchInput.value = promptGroupSearchText;
        searchInput.oninput = () => {
            promptGroupSearchText = searchInput.value || '';
            promptGroupVisibleLimit = PROMPT_GROUP_PAGE_SIZE;
            renderPromptGroupList();
        };
    }

    if (tagFilter) {
        tagFilter.onchange = () => {
            promptGroupActiveTag = tagFilter.value || 'ALL';
            promptGroupVisibleLimit = PROMPT_GROUP_PAGE_SIZE;
            renderPromptGroupList();
        };
    }
}

function updatePromptGroupTagFilterOptions() {
    const select = el('promptGroupTagFilter');
    if (!select) return;

    const previous = promptGroupActiveTag || 'ALL';
    const tags = getAllPromptGroupTags();

    select.innerHTML = '<option value="ALL">전체 태그</option>';

    tags.forEach((tag) => {
        const option = document.createElement('option');
        option.value = tag;
        option.innerText = `#${tag}`;
        select.appendChild(option);
    });

    select.value = tags.includes(previous) ? previous : 'ALL';
    promptGroupActiveTag = select.value;
}

async function savePromptGroupManagerState(silent = true) {
    promptGroups = normalizeSharedPromptGroups(promptGroups);
    await saveSharedPromptGroupsForDaki(silent);
    await saveConfig(true);
    renderAllPromptTokens();
}

async function updatePromptGroupFromManager(index, patch, options = {}) {
    const group = promptGroups[index];
    if (!group) return;

    promptGroups[index] = {
        ...group,
        ...patch
    };

    promptGroups = normalizeSharedPromptGroups(promptGroups);

    await savePromptGroupManagerState(options.silent !== false);
    renderPromptGroupList();
}

function togglePromptGroupCollapsed(index) {
    const group = promptGroups[index];
    if (!group) return;

    promptGroups[index] = {
        ...group,
        collapsed: !Boolean(group.collapsed)
    };

    renderPromptGroupList();
}

function renderPromptGroupTagChips(container, tags) {
    container.innerHTML = '';

    if (!tags || !tags.length) {
        const empty = document.createElement('span');
        empty.style.cssText = 'font-size:11px; color:var(--text-muted);';
        empty.innerText = '태그 없음';
        container.appendChild(empty);
        return;
    }

    tags.forEach((tag) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.innerText = `#${tag}`;
        chip.style.cssText = `
            border:none;
            border-radius:999px;
            padding:3px 8px;
            font-size:11px;
            font-weight:800;
            background:rgba(255,255,255,0.09);
            color:var(--text-color);
            cursor:pointer;
        `;
        chip.onclick = () => {
            promptGroupActiveTag = tag;
            promptGroupVisibleLimit = PROMPT_GROUP_PAGE_SIZE;
            renderPromptGroupList();
        };
        container.appendChild(chip);
    });
}

async function saveSharedPromptGroupsForDaki(silent = true) {
    await apiFetch(`/api/shared_prompt_groups?t=${Date.now()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ groups: promptGroups })
    });

    if (!silent) showToast('프롬프트 그룹을 저장했습니다.');
}

async function loadSharedPromptGroupsForDaki(mergeLocal = true) {
    try {
        const localGroups = normalizeSharedPromptGroups(promptGroups);
        const data = await apiFetch(`/api/shared_prompt_groups?t=${Date.now()}`, {
            cache: 'no-store'
        });
        const sharedGroups = normalizeSharedPromptGroups(data.groups || []);

        promptGroups = mergeLocal
            ? mergePromptGroupLists(sharedGroups, localGroups)
            : sharedGroups;

        if (mergeLocal && JSON.stringify(promptGroups) !== JSON.stringify(sharedGroups)) {
            await saveSharedPromptGroupsForDaki(true);
        }

        renderAllPromptTokens();

        const modal = el('promptGroupModal');
        if (modal && modal.style.display === 'flex') {
            renderPromptGroupList();
        }
    } catch (error) {
        console.warn('공용 프롬프트 그룹 로드 실패:', error);
    }
}

function showToast(message) {
    const toast = document.createElement('div');
    toast.style.cssText = `
        position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%);
        background: var(--success); color: white; padding: 12px 25px;
        border-radius: 30px; z-index: 9999; font-weight: bold;
        box-shadow: 0 4px 15px rgba(0,0,0,0.3); animation: fadeInOut 2s forwards;
    `;
    toast.innerText = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
}

window.onload = async function() {
    try {
        await fetchTagDictionary();
        const data = await apiFetch('/api/lab/config');
        applyInitialConfig(data);
        await loadSharedPromptGroupsForDaki(true);
        bindPromptInputs();
        renderAllPromptTokens();
        renderAllPromptTokens();
        applyPromptViewMode();
        updateResolution();
        checkAnlas();
        bindDakiContextMenu();
        await fetchGeneratedDakiImages();
    } catch (error) {
        console.error('Initial load error:', error);
    }
};

async function fetchTagDictionary() {
    try {
        const data = await apiFetch('/api/tag_dictionary');
        tagDictionary = data.tags || {};
    } catch (error) {
        console.warn('Tag dictionary load failed:', error);
        tagDictionary = {};
    }
}

function applyInitialConfig(data) {
    if (data.key) el('apiKey').value = data.key;
    el('basePrompt').value = data.daki_base_prompt || data.base_prompt || [
        data.subject_prompt,
        data.style_prompt,
        data.quality_prompt,
        data.daki_prompt
    ].filter(Boolean).join(', ');
    setCharacterPromptValues(
        Array.isArray(data.char_prompts)
            ? data.char_prompts
            : normalizeCharPromptList(data.char_prompt || '')
    );
    if (data.negative_prompt) el('negPrompt').value = data.negative_prompt;
    if (data.res_preset) {
        el('resPreset').value = data.res_preset;
    }
    if (data.scale !== undefined) el('scale').value = data.scale;
    if (data.cfg_rescale !== undefined) el('cfgRescale').value = data.cfg_rescale;
    if (data.steps !== undefined) el('steps').value = data.steps;
    if (data.sampler !== undefined) el('sampler').value = data.sampler;
    if (Array.isArray(data.daki_prompt_groups)) promptGroups = data.daki_prompt_groups;
}

async function saveConfig(silent = false) {
    try {
        await apiFetch('/api/lab/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                key: el('apiKey').value,
                daki_base_prompt: el('basePrompt').value,
                char_prompts: getCharacterPromptValues(),
                char_prompt: buildLegacyCharPromptText(getCharacterPromptValues()),
                negative_prompt: el('negPrompt').value,
                res_preset: el('resPreset').value,
                scale: parseFloat(el('scale').value),
                cfg_rescale: parseFloat(el('cfgRescale').value),
                steps: parseInt(el('steps').value),
                sampler: el('sampler').value,
                daki_prompt_groups: promptGroups,
                shared_prompt_groups: promptGroups
            })
        });
        if (!silent) showToast('설정이 저장되었습니다.');
    } catch (error) {
        showToast(`오류 발생: ${error.message}`);
    }
}

function openSettings() {
    el('settingsModal').style.display = 'flex';
}

function closeSettings() {
    el('settingsModal').style.display = 'none';
}

function openTagDictionary() {
    const modal = el('tagDictionaryModal');
    if (!modal) return;

    modal.style.display = 'flex';

    const input = el('tagSearchInput');
    if (input) {
        input.focus();
        if (input.value.trim()) {
            searchTagDictionary(true);
        } else {
            loadTagDictionaryHome();
        }
    } else {
        loadTagDictionaryHome();
    }
}

function closeTagDictionary() {
    const modal = el('tagDictionaryModal');
    if (modal) modal.style.display = 'none';
}

function setTagDictionaryStatus(message) {
    const results = el('tagDictionaryResults');
    if (!results) return;
    results.innerHTML = `<div class="tag-dictionary-empty">${escapeHtml(message)}</div>`;
}

function searchTagDictionary(force = false) {
    clearTimeout(tagDictionarySearchTimer);
    tagDictionarySearchTimer = setTimeout(() => runTagDictionarySearch(), force ? 0 : 180);
}

async function runTagDictionarySearch() {
    const input = el('tagSearchInput');
    const query = input?.value.trim() || '';

    if (!query) {
        await loadTagDictionaryHome();
        return;
    }

    tagDictionaryBrowseState = null;
    setTagDictionaryStatus('검색 중...');

    try {
        const data = await apiFetch(`/api/tag_dictionary/search?q=${encodeURIComponent(query)}`);
        renderTagDictionaryResults(data.items || []);
    } catch (error) {
        setTagDictionaryStatus(`검색 실패: ${error.message}`);
    }
}

function renderTagDictionaryResults(items) {
    const results = el('tagDictionaryResults');
    if (!results) return;
    results.innerHTML = '';

    if (!items.length) {
        setTagDictionaryStatus('검색 결과가 없습니다.');
        return;
    }

    appendTagDictionaryRows(results, items);
}

function selectTagDictionaryRow(item, row) {
    selectedTagDictionaryItem = item;
    document.querySelectorAll('.tag-dictionary-row.active').forEach((node) => node.classList.remove('active'));
    if (row) row.classList.add('active');

    if (el('tagNameInput')) el('tagNameInput').value = item.tag || '';
    if (el('tagKoInput')) el('tagKoInput').value = item.ko || '';
    if (el('tagGroupInput')) el('tagGroupInput').value = item.group_ko || item.group || '';
    if (el('tagDictionaryMeta')) {
        el('tagDictionaryMeta').innerText = `Danbooru: ${item.category_ko || '일반'} · ${Number(item.post_count || 0).toLocaleString()} posts`;
    }
}

async function saveTagDictionaryOverride() {
    const tag = el('tagNameInput')?.value.trim();
    if (!tag) {
        showToast('저장할 태그를 선택하세요.');
        return;
    }

    try {
        await apiFetch('/api/tag_dictionary/override', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tag,
                ko: el('tagKoInput')?.value.trim() || '',
                group: el('tagGroupInput')?.value.trim() || ''
            })
        });
        await fetchTagDictionary();
        renderAllPromptTokens();

        const query = el('tagSearchInput')?.value.trim() || '';
        if (query) {
            searchTagDictionary(true);
        } else if (tagDictionaryBrowseState) {
            browseTagDictionary(
                tagDictionaryBrowseState.type,
                tagDictionaryBrowseState.value,
                tagDictionaryBrowseState.label,
                0,
                false,
                { bucket: tagDictionaryBrowseState.bucket || 'all' }
            );
        } else {
            loadTagDictionaryHome();
        }

        showToast('태그 사전이 저장되었습니다.');
    } catch (error) {
        showToast(`저장 실패: ${error.message}`);
    }
}

function bindPromptInputs() {
    getPromptFields().forEach((field) => {
        const input = el(field.inputId);
        if (!input || input.dataset.promptBound === '1') return;
        input.dataset.promptBound = '1';
        input.addEventListener('input', () => renderPromptTokens(field.key));
        input.addEventListener('blur', () => saveConfig(true));
        input.addEventListener('mouseup', handlePromptSelection);
        input.addEventListener('keyup', handlePromptSelection);
    });
}

function togglePromptViewMode() {
    promptViewMode = promptViewMode === 'buttons' ? 'text' : 'buttons';
    if (promptViewMode === 'buttons') renderAllPromptTokens();
    applyPromptViewMode();
}

function applyPromptViewMode() {
    const useText = promptViewMode === 'text';
    getPromptFields().forEach((field) => {
        const input = el(field.inputId);
        const surface = el(field.tokensId);
        if (input) input.style.display = useText ? 'block' : 'none';
        if (surface) surface.style.display = useText ? 'none' : 'flex';
    });
    const toggle = el('promptViewToggle');
    if (toggle) toggle.innerText = useText ? '버튼 보기' : '텍스트 편집';
}

function renderAllPromptTokens() {
    getPromptFields().forEach((field) => renderPromptTokens(field.key));
}

function getPromptField(fieldKey) {
    return getPromptFields().find((field) => field.key === fieldKey);
}

function parsePromptTokens(promptText) {
    return String(promptText || '')
        .split(',')
        .map((token) => token.trim())
        .filter(Boolean);
}

function normalizeTokenForGroup(token) {
    return stripWeightMarkers(token).toLowerCase().replace(/\s+/g, ' ').trim();
}

function applyPromptGroups(tokens) {
    const parts = [];
    let index = 0;

    while (index < tokens.length) {
        const matched = promptGroups.find((group) => {
            const groupTokens = Array.isArray(group.prompts) ? group.prompts : [];
            if (!groupTokens.length || index + groupTokens.length > tokens.length) return false;
            return groupTokens.every((prompt, offset) =>
                normalizeTokenForGroup(prompt) === normalizeTokenForGroup(tokens[index + offset])
            );
        });

        if (matched) {
            const groupTokens = matched.prompts;
            parts.push({
                type: 'group',
                name: matched.name,
                tokens: tokens.slice(index, index + groupTokens.length)
            });
            index += groupTokens.length;
        } else {
            parts.push({ type: 'token', token: tokens[index], index });
            index += 1;
        }
    }

    return parts;
}

function applyPromptGroupsWithIndexes(indexedTokens) {
    const parts = [];
    let index = 0;

    while (index < indexedTokens.length) {
        const matched = promptGroups.find((group) => {
            const groupTokens = Array.isArray(group.prompts) ? group.prompts : [];
            if (!groupTokens.length || index + groupTokens.length > indexedTokens.length) return false;
            return groupTokens.every((prompt, offset) =>
                normalizeTokenForGroup(prompt) === normalizeTokenForGroup(indexedTokens[index + offset].token)
            );
        });

        if (matched) {
            const groupTokens = matched.prompts;
            const matchedTokens = indexedTokens.slice(index, index + groupTokens.length);
            parts.push({
                type: 'group',
                name: matched.name,
                tokens: matchedTokens.map((part) => part.token),
                indexes: matchedTokens.map((part) => part.index)
            });
            index += groupTokens.length;
        } else {
            parts.push({
                type: 'token',
                token: indexedTokens[index].token,
                index: indexedTokens[index].index
            });
            index += 1;
        }
    }

    return parts;
}

function applyWeightedRanges(tokens) {
    const parts = [];
    let index = 0;

    while (index < tokens.length) {
        const token = tokens[index];
        const leadingWeightMatch = token.match(/^([-+]?\d+(?:\.\d+)?)::\s*(.*)$/);
        const isSingleWeightedToken = leadingWeightMatch && /\s*::$/.test(token);

        if (leadingWeightMatch && !isSingleWeightedToken) {
            let end = index + 1;
            while (end < tokens.length && !/\s*::$/.test(tokens[end])) end += 1;

            if (end < tokens.length) {
                parts.push({
                    type: 'weightedRange',
                    prefix: `${leadingWeightMatch[1]}::`,
                    suffix: '::',
                    tokens: tokens.slice(index, end + 1),
                    startIndex: index
                });
                index = end + 1;
                continue;
            }
        }

        parts.push({ type: 'token', token, index });
        index += 1;
    }

    return parts;
}

function joinPromptTokens(tokens) {
    return tokens.map((token) => token.trim()).filter(Boolean).join(', ');
}

function getEditableTokenValue(token) {
    return stripWeightMarkers(token);
}

function rebuildTokenValue(originalToken, editedValue) {
    const leadingWeightMatch = originalToken.match(/^([-+]?\d+(?:\.\d+)?)::\s*(.*)$/);
    const trailingWeightMatch = originalToken.match(/^(.*?)\s*::$/);
    const prefix = leadingWeightMatch ? `${leadingWeightMatch[1]}::` : '';
    const suffix = trailingWeightMatch ? '::' : '';
    return `${prefix}${editedValue.trim()}${suffix}`;
}

function stripWeightMarkers(token) {
    return String(token || '')
        .replace(/^[-+]?\d+(?:\.\d+)?::\s*/, '')
        .replace(/\s*::$/, '')
        .trim();
}

function normalizeLookupKey(value) {
    return String(value || '')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '_');
}

function findTagMetadata(token) {
    const editable = stripWeightMarkers(token);
    const parts = editable.split(/\s+/).filter(Boolean);

    for (let start = 0; start < parts.length; start++) {
        const candidate = parts.slice(start).join('_').toLowerCase();
        if (tagDictionary[candidate]?.ko) return tagDictionary[candidate];
    }

    return tagDictionary[normalizeLookupKey(editable)] || null;
}

function formatTokenLabel(token) {
    const cleanToken = stripWeightMarkers(token);
    const meta = findTagMetadata(token);
    let label = cleanToken;

    if (meta && meta.ko) {
        label = `${meta.group_ko || meta.group || '기타'} / ${meta.ko} | ${cleanToken}`;
    }
    return label;
}

function getTagColor(token) {
    const meta = findTagMetadata(token);
    return meta?.color || '#64748b';
}

function appendPromptText(surface, text) {
    const span = document.createElement('span');
    span.className = 'prompt-token-text';
    span.innerText = text;
    surface.appendChild(span);
}

function renderPromptPart(surface, fieldKey, token, index) {
    const leadingWeightMatch = token.match(/^([-+]?\d+(?:\.\d+)?)::\s*(.*)$/);
    const trailingWeightMatch = token.match(/^(.*?)\s*::$/);
    if (leadingWeightMatch && trailingWeightMatch) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `prompt-token-btn weighted-single ${findTagMetadata(token)?.ko ? 'has-ko' : ''}`;
        button.style.setProperty('--tag-color', getTagColor(token));
        button.innerText = `${leadingWeightMatch[1]}:: ${formatTokenLabel(token)} ::`;
        button.title = '더블 클릭해서 프롬프트 내용만 수정';
        button.ondblclick = () => startTokenEdit(fieldKey, index, token, button);
        button.oncontextmenu = (event) => {
            event.preventDefault();
            event.stopPropagation();
            openTagTranslationModal(stripWeightMarkers(token), event);
        };
        surface.appendChild(button);
        return;
    }

    if (leadingWeightMatch) appendPromptText(surface, `${leadingWeightMatch[1]}::`);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = `prompt-token-btn ${findTagMetadata(token)?.ko ? 'has-ko' : ''}`;
    button.style.setProperty('--tag-color', getTagColor(token));
    button.innerText = formatTokenLabel(token);
    button.title = '더블 클릭해서 프롬프트 내용만 수정';
    button.ondblclick = () => startTokenEdit(fieldKey, index, token, button);
    button.oncontextmenu = (event) => {
        event.preventDefault();
        event.stopPropagation();
        openTagTranslationModal(stripWeightMarkers(token), event);
    };
    surface.appendChild(button);

    if (trailingWeightMatch) appendPromptText(surface, '::');
}

function renderWeightedRangePart(surface, fieldKey, part) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'prompt-token-btn weighted-range';
    button.title = part.tokens.join(', ');
    button.ondblclick = () => startWeightedRangeEdit(fieldKey, part, button);

    const prefix = document.createElement('span');
    prefix.className = 'prompt-token-range-marker';
    prefix.innerText = part.prefix;
    button.appendChild(prefix);

    renderWeightedRangeInnerParts(button, part);

    const suffix = document.createElement('span');
    suffix.className = 'prompt-token-range-marker';
    suffix.innerText = part.suffix;
    button.appendChild(suffix);

    surface.appendChild(button);
}

function renderWeightedRangeInnerParts(button, part) {
    applyPromptGroups(part.tokens).forEach((groupedPart) => {
        if (groupedPart.type === 'group') {
            const chip = document.createElement('span');
            chip.className = 'prompt-token-inner-chip group';
            chip.style.setProperty('--group-color', getPromptGroupColor(groupedPart.name));
            chip.innerText = `[${groupedPart.name}]`;
            chip.title = groupedPart.tokens.join(', ');

            chip.oncontextmenu = (event) => {
                event.preventDefault();
                event.stopPropagation();

                // 그룹 칩은 여러 태그라 애매하므로 첫 번째 태그 기준
                const firstToken = groupedPart.tokens?.[0] || '';
                openTagTranslationModal(stripWeightMarkers(firstToken), event);
            };

            button.appendChild(chip);
            return;
        }

        const token = groupedPart.token;
        const chip = document.createElement('span');
        chip.className = `prompt-token-inner-chip ${findTagMetadata(token)?.ko ? 'has-ko' : ''}`;
        chip.style.setProperty('--tag-color', getTagColor(token));
        chip.innerText = formatTokenLabel(token);
        chip.title = stripWeightMarkers(token);

        chip.oncontextmenu = (event) => {
            event.preventDefault();
            event.stopPropagation();
            openTagTranslationModal(stripWeightMarkers(token), event);
        };

        button.appendChild(chip);
    });
}

function startWeightedRangeEdit(fieldKey, part, button) {
    const editor = document.createElement('input');
    editor.type = 'text';
    editor.className = 'prompt-token-edit';
    editor.value = part.tokens.map(stripWeightMarkers).join(', ');
    editor.onkeydown = (event) => {
        if (event.key === 'Enter') finishWeightedRangeEdit(fieldKey, part, editor.value);
        if (event.key === 'Escape') renderPromptTokens(fieldKey);
    };
    editor.onblur = () => finishWeightedRangeEdit(fieldKey, part, editor.value);
    button.replaceWith(editor);
    editor.focus();
    editor.select();
}

function finishWeightedRangeEdit(fieldKey, part, editedValue) {
    const field = getPromptField(fieldKey);
    if (!field) return;
    const input = el(field.inputId);
    if (!input) return;

    const tokens = parsePromptTokens(input.value);
    const replacement = parsePromptTokens(editedValue);
    if (!replacement.length) return;

    replacement[0] = `${part.prefix}${replacement[0]}`;
    replacement[replacement.length - 1] = `${replacement[replacement.length - 1]}${part.suffix}`;
    tokens.splice(part.startIndex, part.tokens.length, ...replacement);
    input.value = joinPromptTokens(tokens);
    renderPromptTokens(fieldKey);
    saveConfig(true);
}

function getPromptGroupColor(name) {
    let hash = 0;
    for (let i = 0; i < String(name || '').length; i++) {
        hash = ((hash << 5) - hash) + String(name).charCodeAt(i);
        hash |= 0;
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue} 70% 48%)`;
}

function renderPromptGroupButton(surface, groupPart) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'prompt-token-btn group';
    button.style.setProperty('--group-color', getPromptGroupColor(groupPart.name));
    button.innerText = `[${groupPart.name}]`;
    button.title = groupPart.tokens.join(', ');
    surface.appendChild(button);
}

function renderTokenSequenceWithWeightedRanges(surface, fieldKey, sequence) {
    const weightedParts = applyWeightedRanges(sequence.map((part) => part.token));

    weightedParts.forEach((part) => {
        if (part.type === 'weightedRange') {
            const mappedStart = sequence[part.startIndex]?.index ?? part.startIndex;
            renderWeightedRangePart(surface, fieldKey, {
                ...part,
                startIndex: mappedStart
            });
            return;
        }

        const original = sequence[part.index];
        if (!original) return;
        renderPromptPart(surface, fieldKey, part.token, original.index);
    });
}

function renderPromptTokens(fieldKey) {
    const field = getPromptField(fieldKey);
    if (!field) return;

    const input = el(field.inputId);
    const surface = el(field.tokensId);
    if (!input || !surface) return;

    const tokens = parsePromptTokens(input.value);
    surface.innerHTML = '';

    if (!tokens.length) {
        const empty = document.createElement('span');
        empty.style.cssText = 'color: var(--text-muted); font-size: 12px;';
        empty.innerText = '프롬프트를 입력하면 버튼으로 표시됩니다.';
        surface.appendChild(empty);
        return;
    }

    const groupedParts = applyPromptGroupsWithIndexes(tokens.map((token, index) => ({ token, index })));
    let pendingTokens = [];
    groupedParts.forEach((part) => {
        if (part.type === 'group') {
            renderTokenSequenceWithWeightedRanges(surface, fieldKey, pendingTokens);
            pendingTokens = [];
            renderPromptGroupButton(surface, part);
            return;
        }
        pendingTokens.push(part);
    });
    renderTokenSequenceWithWeightedRanges(surface, fieldKey, pendingTokens);

}

function startTokenEdit(fieldKey, index, token, button) {
    const editor = document.createElement('input');
    editor.type = 'text';
    editor.className = 'prompt-token-edit';
    editor.value = getEditableTokenValue(token);
    editor.onkeydown = (event) => {
        if (event.key === 'Enter') finishTokenEdit(fieldKey, index, token, editor.value);
        if (event.key === 'Escape') renderPromptTokens(fieldKey);
    };
    editor.onblur = () => finishTokenEdit(fieldKey, index, token, editor.value);
    button.replaceWith(editor);
    editor.focus();
    editor.select();
}

function finishTokenEdit(fieldKey, index, originalToken, editedValue) {
    const field = getPromptField(fieldKey);
    if (!field) return;
    const input = el(field.inputId);
    if (!input) return;

    const tokens = parsePromptTokens(input.value);
    if (index < 0 || index >= tokens.length) return;
    const rebuilt = rebuildTokenValue(originalToken, editedValue);
    if (rebuilt) tokens[index] = rebuilt;
    else tokens.splice(index, 1);
    input.value = joinPromptTokens(tokens);
    renderPromptTokens(fieldKey);
    saveConfig(true);
}

function switchPromptTab(tab) {
    const btnBase = el('btn-tab-base');
    const btnNegative = el('btn-tab-negative');
    const tabBase = el('tab-base');
    const tabNegative = el('tab-negative');

    if (tab === 'base') {
        btnBase.classList.add('active');
        btnNegative.classList.remove('active');
        tabBase.style.display = 'block';
        tabNegative.style.display = 'none';
    } else {
        btnNegative.classList.add('active');
        btnBase.classList.remove('active');
        tabNegative.style.display = 'block';
        tabBase.style.display = 'none';
    }
}

function handlePromptSelection(event) {
    if (promptViewMode !== 'text') return;
    const input = event.target;
    if (!input || !getPromptFields().some((field) => field.inputId === input.id)) return;

    const start = input.selectionStart;
    const end = input.selectionEnd;
    const selectedText = input.value.slice(start, end).trim();
    const popover = el('groupSelectionPopover');
    const nameBox = el('promptGroupNameBox');
    const startButton = el('btnStartPromptGroup');
    if (!popover) return;

    if (!selectedText || start === end) {
        hideGroupSelectionPopover();
        return;
    }

    selectedPromptGroup = { inputId: input.id, start, end, text: selectedText };
    const rect = input.getBoundingClientRect();
    popover.style.left = `${Math.min(rect.left + 12, window.innerWidth - 240)}px`;
    popover.style.top = `${Math.max(12, rect.top - 48)}px`;
    popover.style.display = 'block';
    if (nameBox) nameBox.style.display = 'none';
    if (startButton) startButton.style.display = 'inline-block';
}

function hideGroupSelectionPopover() {
    const popover = el('groupSelectionPopover');
    if (popover) popover.style.display = 'none';
    selectedPromptGroup = null;
}

function showPromptGroupNameInput() {
    const nameBox = el('promptGroupNameBox');
    const startButton = el('btnStartPromptGroup');
    const input = el('promptGroupNameInput');
    if (startButton) startButton.style.display = 'none';
    if (nameBox) nameBox.style.display = 'flex';
    if (input) {
        input.value = '';
        input.focus();
    }
}

async function saveSelectedPromptGroup() {
    if (!selectedPromptGroup) return;

    const name = el('promptGroupNameInput')?.value.trim();
    const prompts = parsePromptTokens(selectedPromptGroup.text);

    if (!name || !prompts.length) return;

    promptGroups = promptGroups.filter((group) => group.name !== name);
    promptGroups.push({ name, prompts, tags: [], collapsed: true });
    promptGroups = normalizeSharedPromptGroups(promptGroups);

    await saveSharedPromptGroupsForDaki(false);
    await saveConfig(true);

    hideGroupSelectionPopover();
    renderAllPromptTokens();
    renderPromptGroupList();
}

async function openPromptGroupManager() {
    await loadSharedPromptGroupsForDaki(false);
    promptGroupVisibleLimit = PROMPT_GROUP_PAGE_SIZE;
    ensurePromptGroupManagerControls();
    renderPromptGroupList();
    el('promptGroupModal').style.display = 'flex';
}

function closePromptGroupManager() {
    el('promptGroupModal').style.display = 'none';
}

function renderPromptGroupList() {
    const list = el('promptGroupList');
    if (!list) return;

    ensurePromptGroupManagerControls();
    updatePromptGroupTagFilterOptions();

    list.innerHTML = '';

    const filtered = getFilteredPromptGroupsForManager();
    const visibleItems = filtered.slice(0, promptGroupVisibleLimit);
    const summary = el('promptGroupManagerSummary');

    if (summary) {
        summary.innerText = `전체 ${promptGroups.length}개 · 표시 ${visibleItems.length}/${filtered.length}개`;
    }

    if (!filtered.length) {
        const empty = document.createElement('div');
        empty.style.cssText = 'color: var(--text-muted); font-size: 13px; padding:14px;';
        empty.innerText = promptGroups.length ? '검색/태그 조건에 맞는 그룹이 없습니다.' : '저장된 그룹이 없습니다.';
        list.appendChild(empty);
        return;
    }

    visibleItems.forEach(({ group, index }) => {
        const row = document.createElement('div');
        row.style.cssText = `
            border:1px solid var(--border-color);
            border-radius:12px;
            padding:10px;
            background:var(--bg-color);
            display:grid;
            grid-template-columns:minmax(0,1fr) 52px;
            gap:10px;
            margin-bottom:10px;
        `;

        const body = document.createElement('div');
        body.style.cssText = 'min-width:0; display:flex; flex-direction:column; gap:8px;';

        const top = document.createElement('div');
        top.style.cssText = 'display:flex; gap:8px; align-items:center;';

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.innerText = group.collapsed ? '펼치기' : '접기';
        toggle.style.cssText = 'width:58px; padding:6px 0; font-size:12px;';
        toggle.onclick = () => togglePromptGroupCollapsed(index);

        const nameInput = document.createElement('input');
        nameInput.value = group.name || '';
        nameInput.placeholder = '그룹명';
        nameInput.style.cssText = `
            flex:1;
            min-width:0;
            padding:7px 9px;
            border-radius:8px;
            border:1px solid var(--border-color);
            background:rgba(255,255,255,0.04);
            color:var(--text-color);
            font-weight:900;
        `;

        top.appendChild(toggle);
        top.appendChild(nameInput);

        const tagInput = document.createElement('input');
        tagInput.value = (group.tags || []).join(', ');
        tagInput.placeholder = '태그 입력: 그림체, 고퀄, 자주씀';
        tagInput.style.cssText = `
            width:100%;
            box-sizing:border-box;
            padding:7px 9px;
            border-radius:8px;
            border:1px solid var(--border-color);
            background:rgba(255,255,255,0.04);
            color:var(--text-color);
            font-size:12px;
        `;

        const chips = document.createElement('div');
        chips.style.cssText = 'display:flex; gap:5px; flex-wrap:wrap;';
        renderPromptGroupTagChips(chips, group.tags || []);

        const preview = document.createElement('div');
        preview.style.cssText = `
            font-size:12px;
            color:var(--text-muted);
            overflow:hidden;
            text-overflow:ellipsis;
            white-space:nowrap;
            border-top:1px dashed var(--border-color);
            padding-top:8px;
        `;
        preview.innerText = (group.prompts || []).join(', ');

        const promptArea = document.createElement('textarea');
        promptArea.value = (group.prompts || []).join(', ');
        promptArea.rows = 5;
        promptArea.style.cssText = `
            width:100%;
            box-sizing:border-box;
            resize:vertical;
            min-height:86px;
            max-height:220px;
            padding:8px 9px;
            border-radius:8px;
            border:1px solid var(--border-color);
            background:rgba(255,255,255,0.04);
            color:var(--text-color);
            font-size:12px;
            line-height:1.45;
        `;

        body.appendChild(top);
        body.appendChild(tagInput);
        body.appendChild(chips);

        if (group.collapsed) {
            body.appendChild(preview);
        } else {
            body.appendChild(promptArea);
        }

        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex; flex-direction:column; gap:8px; align-items:flex-end; justify-content:flex-start;';

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'success';
        saveBtn.innerText = '저장';
        saveBtn.style.cssText = `
            width:44px;
            height:32px;
            padding:0;
            font-size:12px;
            border-radius:8px;
        `;
        saveBtn.onclick = async () => {
            const nextName = nameInput.value.trim();
            const nextTags = getPromptGroupTagsFromInput(tagInput.value);
            const nextPrompts = group.collapsed
                ? (group.prompts || [])
                : parsePromptTokens(promptArea.value);

            if (!nextName) {
                showToast('그룹명을 입력하세요.');
                return;
            }

            if (!nextPrompts.length) {
                showToast('프롬프트 내용이 비어 있습니다.');
                return;
            }

            await updatePromptGroupFromManager(index, {
                name: nextName,
                tags: nextTags,
                prompts: nextPrompts,
                collapsed: Boolean(promptGroups[index]?.collapsed)
            }, { silent: false });
        };

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'danger';
        del.innerText = '삭제';
        del.style.cssText = `
            width:44px;
            height:32px;
            padding:0;
            font-size:12px;
            border-radius:8px;
        `;
        del.onclick = () => deletePromptGroup(index);

        actions.appendChild(saveBtn);
        actions.appendChild(del);
        row.appendChild(body);
        row.appendChild(actions);
        list.appendChild(row);
    });

    if (filtered.length > visibleItems.length) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'secondary';
        more.style.cssText = 'width:100%; padding:10px; margin-top:4px;';
        more.innerText = `더 보기 (${visibleItems.length}/${filtered.length})`;
        more.onclick = () => {
            promptGroupVisibleLimit += PROMPT_GROUP_PAGE_SIZE;
            renderPromptGroupList();
        };
        list.appendChild(more);
    }
}

async function deletePromptGroup(index) {
    promptGroups.splice(index, 1);
    promptGroups = normalizeSharedPromptGroups(promptGroups);

    await saveSharedPromptGroupsForDaki(false);
    await saveConfig(true);

    renderPromptGroupList();
    renderAllPromptTokens();
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function updateResolution() {
    const presetValue = el('resPreset')?.value;
    if (presetValue && presetValue !== 'manual') {
        const res = presetValue.split('x');
        el('width').value = res[0];
        el('height').value = res[1];
    }
    calcAnlas();
}

function onManualInput() {
    el('resPreset').value = 'manual';
    calcAnlas();
}

function calcAnlas() {
    const w = parseInt(el('width')?.value) || 0;
    const h = parseInt(el('height')?.value) || 0;
    const steps = parseInt(el('steps')?.value) || 0;
    const ratioInfoElem = el('ratioInfo');
    const expectedAnlasElem = el('expectedAnlas');

    if (w > 0 && h > 0 && ratioInfoElem) {
        const matchRate = (100 - (Math.abs(16 / 5 - h / w) / (16 / 5)) * 100).toFixed(1);
        ratioInfoElem.innerText = `비율 5 : ${(h / w * 5).toFixed(2)} (일치율 ${matchRate}%)`;
        ratioInfoElem.style.color = matchRate >= 99 ? 'var(--success)' : (matchRate >= 95 ? '#ff9f0a' : 'var(--danger)');
    }

    if (!expectedAnlasElem) return;
    if (w * h <= 1048576 && steps <= 28) {
        expectedAnlasElem.innerText = '비용: 0 (Opus)';
        expectedAnlasElem.style.color = 'var(--success)';
    } else {
        expectedAnlasElem.innerText = `예상: ${Math.max(2, Math.ceil((w * h * steps) / 1460000))} Anlas`;
        expectedAnlasElem.style.color = 'var(--danger)';
    }
}

document.addEventListener('wheel', function(e) {
    if (e.target.tagName === 'INPUT' && e.target.type === 'number') {
        if (document.activeElement !== e.target && !e.target.matches(':hover')) return;
        e.preventDefault();
        const step = parseFloat(e.target.step) || 1;
        const delta = e.deltaY < 0 ? step : -step;
        let newVal = (parseFloat(e.target.value) || 0) + delta;
        if (e.target.min !== '' && newVal < parseFloat(e.target.min)) newVal = parseFloat(e.target.min);
        if (e.target.max !== '' && newVal > parseFloat(e.target.max)) newVal = parseFloat(e.target.max);
        e.target.value = (step % 1 !== 0) ? newVal.toFixed(2) : newVal;
        e.target.dispatchEvent(new Event('change'));
        e.target.dispatchEvent(new Event('input'));
        calcAnlas();
    }
}, { passive: false });

async function checkAnlas() {
    const anlasEl = el('currentAnlas');
    const key = el('apiKey').value.trim();
    if (!key) {
        anlasEl.innerText = 'API Key 없음';
        return;
    }
    try {
        const data = await apiFetch(`/api/anlas?key=${encodeURIComponent(key)}`);
        if (data.anlas !== undefined) {
            anlasEl.innerText = `${data.anlas.toLocaleString()} Anlas`;
        } else {
            anlasEl.innerText = '조회 실패';
        }
    } catch (error) {
        anlasEl.innerText = '오류';
    }
}

async function generateImage() {
    const width = parseInt(el('width').value);
    const height = parseInt(el('height').value);

    if (width % 64 !== 0 || height % 64 !== 0) {
        alert('가로/세로 사이즈는 64의 배수여야 합니다.');
        return;
    }
    if (width * height > 1048576 && !confirm('Anlas가 소모될 수 있습니다. 계속하시겠습니까?')) return;

    el('loadingIndicator').style.display = 'block';
    el('saveBtn').style.display = 'none';
    el('previewImage').style.display = 'none';

    try {
        const data = await apiFetch('/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                key: el('apiKey').value,
                base_prompt: el('basePrompt').value.trim(),
                char_prompts: getCharacterPromptValues(),
                char_prompt: buildLegacyCharPromptText(getCharacterPromptValues()),
                negative_prompt: el('negPrompt').value,
                width,
                height,
                scale: parseFloat(el('scale').value),
                cfg_rescale: parseFloat(el('cfgRescale').value),
                steps: parseInt(el('steps').value),
                sampler: el('sampler').value,
                persist_temp: true
            })
        });

        el('loadingIndicator').style.display = 'none';

        if (data.image) {
            const item = normalizeGeneratedDakiItem({
                id: data.temp_id,
                src: data.temp_src || data.image,
                image: data.image,
                name: data.name || 'daki_generated.png',
                prompt: data.prompt || getCurrentDakiPromptInfo()
            });

            currentImageBase64 = item.src;
            currentDakiTempId = item.id;
            currentSavedPath = '';

            el('previewImage').src = item.src;
            el('previewImage').style.display = 'block';

            upsertGeneratedDakiImage(item, true);
            saveConfig(true);
            checkAnlas();
        }
    } catch (error) {
        el('loadingIndicator').style.display = 'none';
        showToast(`오류 발생: ${error.message}`);
    }
}

async function loadTagDictionaryHome() {
    tagDictionaryBrowseState = null;
    selectedTagDictionaryItem = null;

    if (el('tagNameInput')) el('tagNameInput').value = '';
    if (el('tagKoInput')) el('tagKoInput').value = '';
    if (el('tagGroupInput')) el('tagGroupInput').value = '';
    if (el('tagDictionaryMeta')) el('tagDictionaryMeta').innerText = '분류를 선택하거나 검색하세요.';

    setTagDictionaryStatus('분류를 불러오는 중...');

    try {
        const data = await apiFetch('/api/tag_dictionary/groups');
        renderTagDictionaryHome(data);
    } catch (error) {
        setTagDictionaryStatus(`분류 로드 실패: ${error.message}`);
    }
}

function renderTagDictionaryHome(data) {
    const results = el('tagDictionaryResults');
    if (!results) return;

    results.innerHTML = `
        <div class="tag-dictionary-home">
            <div class="tag-dictionary-home-title">앱 분류</div>
            <div id="tagAppGroupGrid" class="tag-dictionary-group-grid"></div>

            <div class="tag-dictionary-home-title" style="margin-top:14px;">Danbooru 기본 분류</div>
            <div id="tagDanbooruCategoryGrid" class="tag-dictionary-group-grid"></div>
        </div>
    `;

    renderTagDictionaryGroupCards(el('tagAppGroupGrid'), data.app_groups || []);
    renderTagDictionaryGroupCards(el('tagDanbooruCategoryGrid'), data.danbooru_categories || []);
}

function renderTagDictionaryGroupCards(container, groups) {
    if (!container) return;
    container.innerHTML = '';

    groups.forEach((group) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'tag-dictionary-group-card';
        card.style.setProperty('--tag-color', group.color || '#64748b');
        card.innerHTML = `
            <span class="tag-dictionary-group-label">${escapeHtml(group.label || group.value)}</span>
            <span class="tag-dictionary-group-count">${Number(group.count || 0).toLocaleString()} tags</span>
        `;

        card.onclick = () => browseTagDictionary(
            group.type,
            group.value,
            group.label,
            0,
            false,
            { bucket: group.bucket || 'all' }
        );

        container.appendChild(card);
    });
}

async function browseTagDictionary(type, value, label, offset = 0, append = false, extra = {}) {
    const bucket = extra.bucket || 'all';
    tagDictionaryBrowseState = { type, value, label, bucket };

    if (!append) {
        setTagDictionaryStatus(`${label} 항목을 불러오는 중...`);
    }

    try {
        const params = new URLSearchParams({
            type,
            value,
            offset: String(offset),
            bucket
        });

        const data = await apiFetch(`/api/tag_dictionary/browse?${params.toString()}`);

        if (data.mode === 'groups') {
            renderTagDictionaryDetailGroups(data.label || label, data.groups || []);
            return;
        }

        renderTagDictionaryBrowse(data.label || label, data.items || [], data, append);

    } catch (error) {
        setTagDictionaryStatus(`분류 로드 실패: ${error.message}`);
    }
}

function renderTagDictionaryDetailGroups(label, groups) {
    const results = el('tagDictionaryResults');
    if (!results) return;

    results.innerHTML = `
        <div class="tag-dictionary-breadcrumb">
            <button type="button" class="secondary" onclick="loadTagDictionaryHome()">← 분류 목록</button>
            <span>${escapeHtml(label || '분류')}</span>
        </div>
        <div id="tagDictionaryDetailGrid" class="tag-dictionary-group-grid"></div>
    `;

    renderTagDictionaryGroupCards(el('tagDictionaryDetailGrid'), groups);
}

function renderTagDictionaryBrowse(label, items, data, append = false) {
    const results = el('tagDictionaryResults');
    if (!results) return;

    if (!append) {
        results.innerHTML = `
            <div class="tag-dictionary-breadcrumb">
                <button type="button" class="secondary" onclick="loadTagDictionaryHome()">← 분류 목록</button>
                <span>${escapeHtml(label || '분류')}</span>
            </div>
            <div id="tagDictionaryBrowseList"></div>
            <div id="tagDictionaryMoreArea"></div>
        `;
    }

    const list = el('tagDictionaryBrowseList');
    if (!list) return;

    if (!items.length && !append) {
        list.innerHTML = `<div class="tag-dictionary-empty">이 분류에 표시할 태그가 없습니다.</div>`;
    } else {
        appendTagDictionaryRows(list, items);
    }

    const moreArea = el('tagDictionaryMoreArea');
    if (moreArea) {
        moreArea.innerHTML = '';

        if (data.has_more && tagDictionaryBrowseState) {
            const moreBtn = document.createElement('button');
            moreBtn.type = 'button';
            moreBtn.className = 'secondary';
            moreBtn.style.width = '100%';
            moreBtn.style.marginTop = '10px';
            moreBtn.innerText = '더 보기';

            moreBtn.onclick = () => browseTagDictionary(
                tagDictionaryBrowseState.type,
                tagDictionaryBrowseState.value,
                tagDictionaryBrowseState.label,
                data.next_offset || 0,
                true,
                { bucket: tagDictionaryBrowseState.bucket || 'all' }
            );

            moreArea.appendChild(moreBtn);
        }
    }
}

function appendTagDictionaryRows(container, items) {
    items.forEach((item) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'tag-dictionary-row';
        row.style.setProperty('--tag-color', item.color || '#64748b');

        row.innerHTML = `
            <span class="tag-dictionary-name">${escapeHtml(item.tag)}</span>
            <span class="tag-dictionary-ko">${escapeHtml(item.group_ko || item.group || item.category_ko || '미분류')} / ${escapeHtml(item.ko || '번역 없음')}</span>
            <span class="tag-dictionary-count">${Number(item.post_count || 0).toLocaleString()}</span>
        `;

        row.onclick = () => selectTagDictionaryRow(item, row);
        container.appendChild(row);
    });
}

function renderTagDictionaryResults(items) {
    const results = el('tagDictionaryResults');
    if (!results) return;
    results.innerHTML = '';

    if (!items.length) {
        setTagDictionaryStatus('검색 결과가 없습니다.');
        return;
    }

    appendTagDictionaryRows(results, items);
}

function getCurrentDakiPromptInfo() {
    const charPrompts = getCharacterPromptValues();

    return {
        basePrompt: el('basePrompt')?.value.trim() || '',
        baseCaption: el('basePrompt')?.value.trim() || '',
        charPrompts,
        charPrompt: buildLegacyCharPromptText(charPrompts),
        negativePrompt: el('negPrompt')?.value || '',
        negative_prompt: el('negPrompt')?.value || '',
        uc: el('negPrompt')?.value || '',
        width: parseInt(el('width')?.value || '0', 10) || '',
        height: parseInt(el('height')?.value || '0', 10) || '',
        scale: parseFloat(el('scale')?.value || '0') || '',
        cfg_rescale: parseFloat(el('cfgRescale')?.value || '0') || '',
        steps: parseInt(el('steps')?.value || '0', 10) || '',
        sampler: el('sampler')?.value || ''
    };
}

function normalizeGeneratedDakiItem(item) {
    item = item || {};
    return {
        id: String(item.id || item.temp_id || `local_${Date.now()}_${Math.random().toString(16).slice(2)}`),
        src: item.src || item.temp_src || item.image || '',
        name: item.name || 'daki_generated.png',
        prompt: item.prompt || {},
        path: item.path || '',
        createdAt: item.createdAt || ''
    };
}

function upsertGeneratedDakiImage(item, selectIt = false) {
    const normalized = normalizeGeneratedDakiItem(item);
    generatedDakiImages = generatedDakiImages.filter(existing => existing.id !== normalized.id);
    generatedDakiImages.unshift(normalized);
    renderGeneratedDakiHistory();

    if (selectIt) {
        selectGeneratedDakiImage(normalized.id);
    }

    updateDakiGallerySaveButton();
}

async function fetchGeneratedDakiImages() {
    try {
        const data = await apiFetch('/api/daki/generated_temp');
        generatedDakiImages = Array.isArray(data.items)
            ? data.items.map(normalizeGeneratedDakiItem)
            : [];
        renderGeneratedDakiHistory();

        if (generatedDakiImages.length && !currentImageBase64) {
            selectGeneratedDakiImage(generatedDakiImages[0].id);
        }

        updateDakiGallerySaveButton();
    } catch (error) {
        console.warn('다키 생성 기록 로드 실패:', error);
        generatedDakiImages = [];
        renderGeneratedDakiHistory();
        updateDakiGallerySaveButton();
    }
}

function renderGeneratedDakiHistory() {
    const area = el('historyArea');
    if (!area) return;

    area.innerHTML = '';

    if (!generatedDakiImages.length) {
        area.innerHTML = '<div style="font-size:12px; color:var(--text-muted); padding:16px; text-align:center;">생성 기록이 없습니다.</div>';
        return;
    }

    generatedDakiImages.forEach((item) => {
        const wrap = document.createElement('div');
        wrap.className = 'daki-history-wrap';
        wrap.style.cssText = `
            position: relative;
            margin-bottom: 10px;
            border-radius: 10px;
            overflow: hidden;
            border: 1px solid ${item.id === currentDakiTempId ? 'var(--success)' : 'var(--border-color)'};
            background: var(--bg-color);
        `;

        const img = document.createElement('img');
        img.src = item.src;
        img.className = 'history-item';
        img.style.display = 'block';
        img.style.width = '100%';
        img.style.cursor = 'pointer';

        img.onclick = () => selectGeneratedDakiImage(item.id);
        img.oncontextmenu = (event) => {
            openImageContextMenu(event, {
                src: item.src,
                path: item.path || '',
                name: item.name || 'daki_generated.png',
                prompt: item.prompt || {}
            });
        };

        const del = document.createElement('button');
        del.type = 'button';
        del.title = '생성 기록 삭제';
        del.setAttribute('aria-label', '생성 기록 삭제');
        del.style.cssText = `
            position: absolute;
            top: 6px;
            right: 6px;
            width: 28px;
            height: 28px;
            padding: 0;
            border-radius: 999px;
            border: 1px solid rgba(255,255,255,0.55);
            background: rgba(0,0,0,0.78);
            cursor: pointer;
            z-index: 3;
            box-shadow: 0 2px 8px rgba(0,0,0,0.35);
            display: block;
            overflow: hidden;
        `;

        const lineA = document.createElement('span');
        const lineB = document.createElement('span');

        [lineA, lineB].forEach((line) => {
            line.style.cssText = `
                position: absolute;
                left: 50%;
                top: 50%;
                width: 14px;
                height: 2px;
                border-radius: 999px;
                background: #fff;
                transform-origin: center;
                pointer-events: none;
            `;
            del.appendChild(line);
        });

        lineA.style.transform = 'translate(-50%, -50%) rotate(45deg)';
        lineB.style.transform = 'translate(-50%, -50%) rotate(-45deg)';

        del.onclick = (event) => deleteGeneratedDakiImage(item.id, event);

        wrap.appendChild(img);
        wrap.appendChild(del);
        area.appendChild(wrap);
    });
}

function selectGeneratedDakiImage(id) {
    const item = generatedDakiImages.find(entry => entry.id === id);
    if (!item) return;

    currentDakiTempId = item.id;
    currentImageBase64 = item.src;
    currentSavedPath = item.path || '';

    const preview = el('previewImage');
    if (preview) {
        preview.src = item.src;
        preview.style.display = 'block';
    }

    const prompt = item.prompt || {};
    el('basePrompt').value = prompt.basePrompt || prompt.base_prompt || prompt.prompt || '';
    setCharacterPromptValues(prompt.charPrompts || prompt.char_prompts || prompt.charPrompt || prompt.char_prompt || '');
    el('negPrompt').value = prompt.negativePrompt || prompt.negative_prompt || prompt.uc || '';

    renderAllPromptTokens();
    renderGeneratedDakiHistory();
    updateDakiGallerySaveButton();
}

async function deleteGeneratedDakiImage(id, event = null) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }

    const item = generatedDakiImages.find(entry => entry.id === id);
    if (!item) return;

    try {
        if (!String(id).startsWith('local_')) {
            await apiFetch('/api/daki/generated_temp/delete', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ id })
            });
        }

        generatedDakiImages = generatedDakiImages.filter(entry => entry.id !== id);

        if (currentDakiTempId === id) {
            currentDakiTempId = '';
            currentImageBase64 = null;
            currentSavedPath = '';

            if (generatedDakiImages.length) {
                selectGeneratedDakiImage(generatedDakiImages[0].id);
                return;
            }

            const preview = el('previewImage');
            if (preview) {
                preview.src = '';
                preview.style.display = 'none';
            }
        }

        renderGeneratedDakiHistory();
        updateDakiGallerySaveButton();
    } catch (error) {
        alert(`삭제 실패: ${error.message || error}`);
    }
}

function updateDakiGallerySaveButton() {
    const btn = el('saveBtn');
    if (!btn) return;

    const count = generatedDakiImages.filter(item => !String(item.id).startsWith('local_')).length;
    btn.style.display = count > 0 ? 'block' : 'none';
    btn.innerText = count > 0 ? `생성물 ${count}장 갤러리 저장` : '생성물 전체 갤러리 저장';
}

function openDakiGallerySaveModal() {
    const ids = generatedDakiImages.filter(item => !String(item.id).startsWith('local_')).map(item => item.id);

    if (!ids.length) {
        alert('갤러리에 저장할 생성물이 없습니다.');
        return;
    }

    const summary = el('dakiGallerySaveSummary');
    if (summary) {
        summary.innerText = `현재 임시 보관 중인 생성물 ${ids.length}장을 갤러리에 저장합니다.`;
    }

    const modal = el('dakiGallerySaveModal');
    if (modal) modal.style.display = 'flex';
}

function closeDakiGallerySaveModal() {
    const modal = el('dakiGallerySaveModal');
    if (modal) modal.style.display = 'none';
}

async function saveGeneratedDakiImagesToGallery() {
    if (dakiGallerySaveInProgress) return;

    const ids = generatedDakiImages.filter(item => !String(item.id).startsWith('local_')).map(item => item.id);

    if (!ids.length) {
        alert('갤러리에 저장할 생성물이 없습니다.');
        return;
    }

    const options = {
        useClassifier: Boolean(el('dakiSaveUseClassifier')?.checked),
        ignoreNsfw: Boolean(el('dakiSaveIgnoreNsfw')?.checked),
        ignoreCharacter: Boolean(el('dakiSaveIgnoreCharacter')?.checked),
        useAiNsfw: Boolean(el('dakiSaveUseAiNsfw')?.checked),
        useGpu: Boolean(el('dakiSaveUseGpu')?.checked),
        deleteAfterSave: Boolean(el('dakiSaveDeleteAfter')?.checked)
    };

    dakiGallerySaveInProgress = true;

    const submitBtn = el('dakiGallerySaveSubmitBtn');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.dataset.originalText = submitBtn.innerText;
        submitBtn.innerText = '저장 중...';
    }

    try {
        const data = await apiFetch('/api/daki/save_generated_to_gallery', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ ids, options })
        });

        closeDakiGallerySaveModal();
        showToast(`갤러리 저장 완료: ${data.saved_count || ids.length}장`);

        if (data.warning || (Array.isArray(data.cleanup_errors) && data.cleanup_errors.length)) {
            console.warn('다키 갤러리 저장 경고:', data.warning, data.cleanup_errors);
        }

        if (options.deleteAfterSave) {
            generatedDakiImages = Array.isArray(data.remaining)
                ? data.remaining.map(normalizeGeneratedDakiItem)
                : [];
            currentDakiTempId = '';
            currentImageBase64 = null;
            currentSavedPath = '';

            if (generatedDakiImages.length) {
                selectGeneratedDakiImage(generatedDakiImages[0].id);
            } else {
                const preview = el('previewImage');
                if (preview) {
                    preview.src = '';
                    preview.style.display = 'none';
                }
                renderGeneratedDakiHistory();
            }
        } else {
            await fetchGeneratedDakiImages();
        }

        updateDakiGallerySaveButton();
    } catch (error) {
        alert(`갤러리 저장 실패: ${error.message || error}`);
        await fetchGeneratedDakiImages();
    } finally {
        dakiGallerySaveInProgress = false;

        const submitBtn = el('dakiGallerySaveSubmitBtn');
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerText = submitBtn.dataset.originalText || '갤러리에 저장';
        }
    }
}

async function saveImage() {
    openDakiGallerySaveModal();
}

function bindDakiContextMenu() {
    document.addEventListener('click', (event) => {
        const menu = el('imageContextMenu');
        if (menu && menu.style.display === 'block' && !menu.contains(event.target)) {
            closeImageContextMenu();
        }
    });

    document.addEventListener('scroll', () => closeImageContextMenu(), true);

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            closeImageContextMenu();
        }
    });

    const preview = el('previewImage');
    if (preview) {
        preview.oncontextmenu = (event) => {
            if (!preview.src) return;

            openImageContextMenu(event, {
                src: preview.src,
                path: currentSavedPath || '',
                name: 'daki_preview.png',
                prompt: getCurrentDakiPromptInfo()
            });
        };
    }
}

function openImageContextMenu(event, context) {
    event.preventDefault();
    event.stopPropagation();

    activeImageContext = {
        src: context.src || '',
        imgSrc: context.src || '',
        path: context.path || '',
        name: context.name || 'image.png',
        prompt: context.prompt || null
    };

    const menu = el('imageContextMenu');
    if (!menu) return;

    menu.style.display = 'block';

    const margin = 12;
    const menuWidth = menu.offsetWidth || 220;
    const menuHeight = menu.offsetHeight || 220;
    const left = Math.min(event.clientX, window.innerWidth - menuWidth - margin);
    const top = Math.min(event.clientY, window.innerHeight - menuHeight - margin);

    menu.style.left = `${Math.max(margin, left)}px`;
    menu.style.top = `${Math.max(margin, top)}px`;
}

function closeImageContextMenu() {
    const menu = el('imageContextMenu');
    if (menu) menu.style.display = 'none';
}

function getImageFileName(imagePath) {
    return decodeURIComponent(String(imagePath || '').split('/').pop() || 'image.png');
}

async function copyContextImage() {
    closeImageContextMenu();
    if (!activeImageContext) return;

    try {
        if (!navigator.clipboard || !window.ClipboardItem) {
            throw new Error('현재 브라우저가 이미지 복사를 지원하지 않습니다.');
        }

        const response = await fetch(activeImageContext.imgSrc);
        const blob = await response.blob();
        await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
        showToast('이미지를 클립보드에 복사했습니다.');
    } catch (error) {
        alert(`이미지 복사 실패: ${error.message || error}`);
    }
}

function saveContextImage() {
    closeImageContextMenu();
    if (!activeImageContext) return;

    const link = document.createElement('a');
    link.href = activeImageContext.imgSrc;
    link.download = activeImageContext.name || getImageFileName(activeImageContext.path || 'daki_image.png');
    document.body.appendChild(link);
    link.click();
    link.remove();
}

async function revealContextImage() {
    closeImageContextMenu();
    if (!activeImageContext) return;

    if (!activeImageContext.path) {
        alert('아직 서버에 저장되지 않은 이미지입니다. 먼저 결과물 저장을 누르면 경로 탐색이 가능합니다.');
        return;
    }

    try {
        const res = await fetch('/api/reveal_in_explorer', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ path: activeImageContext.path })
        });
        const json = await res.json();
        if (json.status !== 'success') throw new Error(json.message || '경로를 열 수 없습니다.');
    } catch (error) {
        alert(`경로 탐색 실패: ${error.message || error}`);
    }
}

function openPromptViewer() {
    closeImageContextMenu();
    if (!activeImageContext) return;

    const layer = el('promptLayer');
    if (!layer) return;

    layer.style.display = 'flex';
    el('promptTitle').textContent = `📝 Prompt Viewer - ${activeImageContext.name || 'daki image'}`;

    const prompt = activeImageContext.prompt || {};
    el('promptBodyContent').innerHTML = `
        <div class="prompt-section-card" style="margin-bottom:12px;">
            <div class="prompt-block-title">Base Prompt</div>
            <div class="prompt-text">${escapeHtml(prompt.basePrompt || '').replace(/\n/g, '<br>') || '<span style="color:var(--text-muted);">없음</span>'}</div>
        </div>
        <div class="prompt-section-card" style="margin-bottom:12px;">
            ${(() => {
                const charPrompts = Array.isArray(prompt.charPrompts) && prompt.charPrompts.length
                    ? prompt.charPrompts
                    : normalizeCharPromptList(prompt.charPrompt || '');

                if (!charPrompts.length) {
                    return `
                        <div class="prompt-block">
                            <div class="prompt-block-title">Character Prompt</div>
                            <div class="prompt-text"><span style="color:var(--text-muted);">없음</span></div>
                        </div>
                    `;
                }

                return charPrompts.map((text, idx) => `
                    <div class="prompt-block">
                        <div class="prompt-block-title">Character Prompt ${idx + 1}</div>
                        <div class="prompt-text">${escapeHtml(text).replace(/\n/g, '<br>')}</div>
                    </div>
                `).join('');
            })()}
        </div>
        <div class="prompt-section-card">
            <div class="prompt-block-title">Negative Prompt</div>
            <div class="prompt-text">${escapeHtml(prompt.negativePrompt || '').replace(/\n/g, '<br>') || '<span style="color:var(--text-muted);">없음</span>'}</div>
        </div>
    `;
}

function closePromptViewer() {
    const layer = el('promptLayer');
    if (layer) layer.style.display = 'none';
}

async function sendContextImageToCanvas() {
    closeImageContextMenu();
    if (!activeImageContext) return;

    try {
        let src = activeImageContext.imgSrc;

        // base64 이미지는 localStorage에 직접 넣으면 용량 초과가 날 수 있으므로 서버 임시 파일로 변환
        if (src.startsWith('data:image/')) {
            const data = await apiFetch('/api/canvas/import_base64', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ image: src })
            });

            if (data.status !== 'success') {
                throw new Error(data.message || '임시 이미지 저장 실패');
            }

            src = data.src;
        }

        const payload = {
            src,
            path: activeImageContext.path || '',
            name: activeImageContext.name || getImageFileName(activeImageContext.path || src),
            promptInfo: activeImageContext.prompt || null,
            importedAt: Date.now()
        };

        localStorage.setItem('naia_canvas_pending_import', JSON.stringify(payload));
        location.href = '/canvas';

    } catch (error) {
        alert(`캔버스로 가져오기 실패: ${error.message || error}`);
    }
}

function openTagTranslationModal(tag, event = null) {
    const built = buildTagTranslationParts(tag);

    activeTagTranslationOriginalTarget = built.original;
    activeTagTranslationParts = built.parts;
    activeTagTranslationJoiner = built.joiner;
    activeTagTranslationTarget = built.original;

    if (!activeTagTranslationTarget) return;

    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }

    const popover = document.getElementById('tagTranslationModal');
    const content = popover?.querySelector('.modal-content');
    const tagLabel = document.getElementById('tagTranslationTargetTag');
    const input = document.getElementById('tagTranslationInput');

    if (!popover || !content) return;

    if (tagLabel) tagLabel.innerText = activeTagTranslationTarget;
    if (input) input.value = '';

    renderTagTranslationPartPicker();

    // 기존 중앙 모달 overlay를 작은 고정 팝오버처럼 강제 변경
    popover.style.display = 'block';
    popover.style.position = 'fixed';
    popover.style.inset = 'auto';
    popover.style.width = 'auto';
    popover.style.height = 'auto';
    popover.style.background = 'transparent';
    popover.style.zIndex = '30000';
    popover.style.pointerEvents = 'none';

    content.style.pointerEvents = 'auto';
    content.style.width = '320px';
    content.style.maxWidth = 'calc(100vw - 24px)';
    content.style.padding = '12px';
    content.style.borderRadius = '12px';
    content.style.boxShadow = '0 16px 45px rgba(0,0,0,0.55)';

    const margin = 12;
    const x = event ? event.clientX + 10 : window.innerWidth / 2 - 160;
    const y = event ? event.clientY + 10 : window.innerHeight / 2 - 120;

    // 일단 위치 지정 후 실제 크기 측정
    popover.style.left = `${x}px`;
    popover.style.top = `${y}px`;

    requestAnimationFrame(() => {
        const rect = content.getBoundingClientRect();

        const nextLeft = Math.min(
            Math.max(margin, x),
            window.innerWidth - rect.width - margin
        );

        const nextTop = Math.min(
            Math.max(margin, y),
            window.innerHeight - rect.height - margin
        );

        popover.style.left = `${nextLeft}px`;
        popover.style.top = `${nextTop}px`;

        if (input) {
            input.focus();
            input.select();
        }
    });

    bindTagTranslationPopoverOutsideClose();
}

function stripTagTranslationTarget(tag) {
    return String(tag || '')
        .replace(/^[-+]?\d+(?:\.\d+)?::\s*/, '')
        .replace(/\s*::$/, '')
        .trim();
}

function bindTagTranslationPopoverOutsideClose() {
    if (window.__tagTranslationPopoverBound) return;
    window.__tagTranslationPopoverBound = true;

}

function closeTagTranslationModal() {
    activeTagTranslationTarget = null;
    activeTagTranslationOriginalTarget = '';
    activeTagTranslationParts = [];
    activeTagTranslationJoiner = ' ';

    const popover = document.getElementById('tagTranslationModal');
    if (popover) {
        popover.style.display = 'none';
    }
}

async function saveTagTranslationFromModal() {
    const input = document.getElementById('tagTranslationInput');
    const raw = input ? input.value.trim() : '';

    const targetTag = getEffectiveTagTranslationTarget();

    if (!targetTag) {
        alert('저장할 태그 단어를 하나 이상 활성화해 주세요.');
        return;
    }

    if (!raw) {
        alert('저장할 내용을 입력해 주세요.');
        return;
    }

    try {
        const response = await fetch('/api/tag_dictionary/save_app_translation', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                tag: targetTag,
                input: raw
            })
        });

        const data = await response.json();
        if (!response.ok || data.status !== 'success') {
            throw new Error(data.message || '저장 실패');
        }

        applySavedTagTranslationLocally(targetTag, data.category, data.ko);

        // 다키 제작소라면
        if (typeof fetchTagDictionary === 'function') {
            await fetchTagDictionary();
        }
        if (typeof renderAllPromptTokens === 'function') {
            renderAllPromptTokens();
        }

        // 캔버스라면
        if (typeof fetchClipTagDictionary === 'function') {
            await fetchClipTagDictionary();
        }
        if (typeof renderAllClipPromptTokens === 'function') {
            renderAllClipPromptTokens();
        }

        closeTagTranslationModal();

    } catch (error) {
        alert(`태그 번역 저장 실패: ${error.message || error}`);
    }
}

function applySavedTagTranslationLocally(tag, category, ko) {
    if (!window.tagDictionaryAppCategories) {
        window.tagDictionaryAppCategories = {};
    }

    if (!window.tagDictionaryAppCategories[category]) {
        window.tagDictionaryAppCategories[category] = {};
    }

    window.tagDictionaryAppCategories[category][tag] = ko;

    if (typeof renderTagDictionary === 'function') {
        renderTagDictionary();
    }
}

function buildTagTranslationParts(rawTag) {
    const clean = stripTagTranslationTarget(rawTag);

    if (!clean) {
        return {
            original: '',
            parts: [],
            joiner: ' '
        };
    }

    const joiner = clean.includes('_') && !clean.includes(' ')
        ? '_'
        : ' ';

    const parts = clean
        .split(/[ _]+/)
        .map((part) => part.trim())
        .filter(Boolean)
        .map((text) => ({
            text,
            active: true
        }));

    return {
        original: clean,
        parts,
        joiner
    };
}

function getEffectiveTagTranslationTarget() {
    if (!activeTagTranslationParts.length) {
        return activeTagTranslationOriginalTarget || activeTagTranslationTarget || '';
    }

    return activeTagTranslationParts
        .filter((part) => part.active)
        .map((part) => part.text)
        .join(activeTagTranslationJoiner)
        .trim();
}

function renderTagTranslationPartPicker() {
    const picker = document.getElementById('tagTranslationPartPicker');
    const effective = document.getElementById('tagTranslationEffectiveTag');
    const label = document.getElementById('tagTranslationTargetTag');

    if (label) {
        label.innerText = activeTagTranslationOriginalTarget || '';
    }

    if (!picker) return;

    picker.innerHTML = '';

    if (!activeTagTranslationParts.length || activeTagTranslationParts.length <= 1) {
        picker.style.display = 'none';

        if (effective) {
            effective.innerText = '';
        }

        return;
    }

    picker.style.display = 'flex';

    activeTagTranslationParts.forEach((part, index) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `tag-translation-part-btn ${part.active ? 'active' : 'inactive'}`;
        btn.innerText = part.text;
        btn.onclick = () => toggleTagTranslationPart(index);

        btn.style.cssText = `
            border: 1px solid ${part.active ? 'var(--success)' : 'var(--border-color)'};
            background: ${part.active ? 'rgba(0,184,148,0.16)' : 'var(--btn-secondary)'};
            color: ${part.active ? 'var(--success)' : 'var(--text-muted)'};
            border-radius: 999px;
            padding: 5px 9px;
            font-size: 11px;
            font-weight: 800;
            cursor: pointer;
        `;

        picker.appendChild(btn);
    });

    updateTagTranslationEffectiveLabel();
}

function toggleTagTranslationPart(index) {
    if (!activeTagTranslationParts[index]) return;

    activeTagTranslationParts[index].active = !activeTagTranslationParts[index].active;

    renderTagTranslationPartPicker();
}

function updateTagTranslationEffectiveLabel() {
    const effective = document.getElementById('tagTranslationEffectiveTag');
    if (!effective) return;

    const tag = getEffectiveTagTranslationTarget();

    effective.innerText = tag
        ? `저장 대상: ${tag}`
        : '저장 대상이 없습니다. 하나 이상 활성화하세요.';

    effective.style.color = tag ? 'var(--text-muted)' : 'var(--danger)';
}

async function openDakiArtStyleModal() {
    const modal = el('dakiArtStyleModal');
    if (!modal) return;

    modal.style.display = 'flex';

    await fetchDakiArtStyleSources();

    dakiArtStyleActiveTab = 'saved_styles';
    selectedDakiArtStyle = null;

    switchDakiArtStyleTab('saved_styles');
}

function closeDakiArtStyleModal() {
    const modal = el('dakiArtStyleModal');
    if (modal) modal.style.display = 'none';
}

async function fetchDakiArtStyleSources() {
    try {
        const data = await apiFetch('/api/daki/art_style_sources');
        dakiArtStyleData = {
            saved_styles: Array.isArray(data.saved_styles) ? data.saved_styles : [],
            weighted_artists: Array.isArray(data.weighted_artists) ? data.weighted_artists : []
        };
    } catch (error) {
        showToast(`그림체 목록 로드 실패: ${error.message}`);
        dakiArtStyleData = {
            saved_styles: [],
            weighted_artists: []
        };
    }
}

function switchDakiArtStyleTab(tab) {
    dakiArtStyleActiveTab = tab === 'weighted_artists' ? 'weighted_artists' : 'saved_styles';
    selectedDakiArtStyle = null;

    const savedBtn = el('dakiStyleTabSaved');
    const weightedBtn = el('dakiStyleTabWeighted');

    if (savedBtn) savedBtn.classList.toggle('active', dakiArtStyleActiveTab === 'saved_styles');
    if (weightedBtn) weightedBtn.classList.toggle('active', dakiArtStyleActiveTab === 'weighted_artists');

    renderDakiArtStyleList();
    renderDakiArtStyleDetail(null);
}

function renderDakiArtStyleList() {
    const list = el('dakiArtStyleList');
    if (!list) return;

    const query = (el('dakiArtStyleSearchInput')?.value || '').trim().toLowerCase();
    const items = dakiArtStyleData[dakiArtStyleActiveTab] || [];

    const filtered = items.filter((item) => {
        const haystack = [
            item.name,
            item.name_kr,
            item.prompt,
            item.raw_artist
        ].filter(Boolean).join(' ').toLowerCase();

        return !query || haystack.includes(query);
    });

    list.innerHTML = '';

    if (!filtered.length) {
        list.innerHTML = `<div class="daki-art-style-empty">표시할 그림체가 없습니다.</div>`;
        renderDakiArtStyleDetail(null);
        return;
    }

    filtered.forEach((item, index) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'daki-art-style-row';

        const title = item.name_kr
            ? `${item.name_kr} / ${item.name}`
            : item.name || '이름 없음';

        const promptPreview = String(item.prompt || '').slice(0, 120);

        const badge = item.source === 'saved_styles'
            ? '보관함'
            : `${Number(item.count || 0).toLocaleString()}장`;

        row.innerHTML = `
            <div style="min-width:0;">
                <div class="daki-art-style-row-title">${escapeHtml(title)}</div>
                <div class="daki-art-style-row-prompt">${escapeHtml(promptPreview || '프롬프트 없음')}</div>
            </div>
            <div class="daki-art-style-row-badge">${escapeHtml(badge)}</div>
        `;

        row.onclick = () => {
            selectedDakiArtStyle = item;

            document.querySelectorAll('.daki-art-style-row.active')
                .forEach((node) => node.classList.remove('active'));

            row.classList.add('active');
            renderDakiArtStyleDetail(item);
        };

        list.appendChild(row);

        if (index === 0) {
            selectedDakiArtStyle = item;
            row.classList.add('active');
            renderDakiArtStyleDetail(item);
        }
    });
}

function renderDakiArtStyleDetail(item) {
    const detail = el('dakiArtStyleDetail');
    if (!detail) return;

    if (!item) {
        detail.innerHTML = `<div class="daki-art-style-empty">왼쪽에서 그림체를 선택하세요.</div>`;
        return;
    }

    const title = item.name_kr
        ? `${item.name_kr} / ${item.name}`
        : item.name || '이름 없음';

    const sourceLabel = item.source === 'saved_styles'
        ? '그림체 보관함'
        : 'ART STYLE MANAGER · 가중치 / 원본 순서';

    const samples = Array.isArray(item.samples) ? item.samples : [];

    detail.innerHTML = `
        <div class="daki-art-style-detail-title">${escapeHtml(title)}</div>
        <div class="daki-art-style-detail-meta">
            ${escapeHtml(sourceLabel)}
            ${item.count ? ` · 사용 이미지 ${Number(item.count).toLocaleString()}장` : ''}
        </div>

        ${
            samples.length
                ? `<div class="daki-art-style-samples">
                    ${samples.map((path) => `
                        <img src="/image/${encodeURIComponent(path).replace(/%2F/g, '/')}" alt="">
                    `).join('')}
                </div>`
                : ''
        }

        <div class="daki-art-style-prompt-box">
            ${escapeHtml(item.prompt || '프롬프트 없음')}
        </div>

        <div class="daki-art-style-actions">
            <button class="secondary" onclick="copyDakiArtStylePrompt()">복사</button>
            <button class="success" onclick="importSelectedDakiArtStylePrompt()">가져오기</button>
        </div>
    `;
}

function copyDakiArtStylePrompt() {
    if (!selectedDakiArtStyle?.prompt) return;

    navigator.clipboard?.writeText(selectedDakiArtStyle.prompt)
        .then(() => showToast('그림체 프롬프트를 복사했습니다.'))
        .catch(() => {
            const box = document.createElement('textarea');
            box.value = selectedDakiArtStyle.prompt;
            document.body.appendChild(box);
            box.select();
            document.execCommand('copy');
            box.remove();
            showToast('그림체 프롬프트를 복사했습니다.');
        });
}

function importSelectedDakiArtStylePrompt() {
    if (!selectedDakiArtStyle?.prompt) {
        showToast('가져올 프롬프트가 없습니다.');
        return;
    }

    appendPromptToBasePrompt(selectedDakiArtStyle.prompt);

    saveConfig(true);
    renderAllPromptTokens();
    closeDakiArtStyleModal();

    showToast('그림체 프롬프트를 Base Prompt에 추가했습니다.');
}

function appendPromptToBasePrompt(promptText) {
    const input = el('basePrompt');
    if (!input) return;

    const current = String(input.value || '').trim();
    const incoming = String(promptText || '').trim();

    if (!incoming) return;

    if (!current) {
        input.value = incoming;
        return;
    }

    const currentTokens = parsePromptTokens(current).map(normalizeTokenForGroup);
    const incomingTokens = parsePromptTokens(incoming);

    const tokensToAdd = incomingTokens.filter((token) => {
        return !currentTokens.includes(normalizeTokenForGroup(token));
    });

    if (!tokensToAdd.length) {
        showToast('이미 포함된 그림체 프롬프트입니다.');
        return;
    }

    input.value = `${current}, ${tokensToAdd.join(', ')}`;
}

function normalizeCharPromptList(value) {
    if (Array.isArray(value)) {
        return value
            .map((item) => String(item || '').trim())
            .filter(Boolean);
    }

    if (value && typeof value === 'object') {
        if (Array.isArray(value.charPrompts)) {
            return value.charPrompts
                .map((item) => String(item || '').trim())
                .filter(Boolean);
        }

        if (typeof value.charPrompt === 'string' && value.charPrompt.trim()) {
            return [value.charPrompt.trim()];
        }

        if (typeof value.characterPrompt === 'string' && value.characterPrompt.trim()) {
            return [value.characterPrompt.trim()];
        }
    }

    if (typeof value === 'string' && value.trim()) {
        return [value.trim()];
    }

    return [];
}

function buildLegacyCharPromptText(list) {
    return normalizeCharPromptList(list).join(', ');
}
