// 🌟 커스텀 폴더 규칙 관리 스크립트
// 🌟 커스텀 폴더 + 기본 분류 통합 라우팅 스크립트
// 🌟 커스텀 폴더 규칙 관리 스크립트
// 🌟 커스텀 폴더 + 기본 분류 통합 라우팅 스크립트
let customRules = [];
let folderRulesBaselineJson = '';
const ROUTE_RULE_VIEW_MODE_KEY = 'naia_route_rule_view_mode_v1';
let folderRuleViewMode = localStorage.getItem(ROUTE_RULE_VIEW_MODE_KEY) || 'table';
const routeCardExpandedPathKeys = new Set();
const routeTreeExpandedPathKeys = new Set();
let pendingRouteRuleParentPath = null;
const routeCardSelectedPathKeys = new Set();
let routeCardLastClickedPathKey = '';
let routeCardSelectionBoxState = null;
let routeCardDragState = null;
let routeCardDropTarget = null;
let routeCardFlashPathKey = '';
let routeCardSuppressNextClickKey = '';
let routeTestTarget = 'all';
let routeTestTab = 'image';
let routeTestPromptMode = 'single';
let currentRouteFolderTestJobId = '';
let routeTestSelectedRulePaths = [];
let routeTestSelectedImageFiles = [];
let routeTestSelectedFolderPath = '';
const routeTestImagePreviewUrlMap = new WeakMap();

function getRouteTestImagePreviewUrl(file) {
    if (!file) return '';
    if (!routeTestImagePreviewUrlMap.has(file)) {
        routeTestImagePreviewUrlMap.set(file, URL.createObjectURL(file));
    }
    return routeTestImagePreviewUrlMap.get(file);
}

function revokeRouteTestImagePreviewUrl(file) {
    const url = routeTestImagePreviewUrlMap.get(file);
    if (url) {
        URL.revokeObjectURL(url);
        routeTestImagePreviewUrlMap.delete(file);
    }
}

function revokeRouteTestImagePreviewUrls() {
    routeTestSelectedImageFiles.forEach(file => revokeRouteTestImagePreviewUrl(file));
}

function escapeRouteHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function routePromptDedupeKey(value) {
    const text = String(value || '').trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
    return text.replace(/[\s_]+/g, '') || text;
}

function parseRouteTags(value) {
    const items = Array.isArray(value)
        ? value
        : String(value || '').split(/[,\n]+/);
    const tags = [];
    const seen = new Set();

    items.forEach((item) => {
        const tag = String(item || '').trim().replace(/\s+/g, ' ');
        if (!tag) return;

        const key = routePromptDedupeKey(tag);
        if (!key || seen.has(key)) return;

        seen.add(key);
        tags.push(tag);
    });

    return tags;
}

function parseRouteTagGroups(value) {
    const rawGroups = [];

    if (typeof value === 'string') {
        value.split(/\r?\n/).forEach((line) => {
            rawGroups.push(line.split(','));
        });
    } else if (Array.isArray(value)) {
        value.forEach((item) => {
            if (Array.isArray(item)) {
                rawGroups.push(item);
            } else if (typeof item === 'string') {
                rawGroups.push(item.split(','));
            } else {
                rawGroups.push([item]);
            }
        });
    }

    const groups = [];
    const seenGroups = new Set();

    rawGroups.forEach((group) => {
        const tags = parseRouteTags(group);
        if (!tags.length) return;

        const groupKey = tags.map(routePromptDedupeKey).join('\u001f');
        if (seenGroups.has(groupKey)) return;

        seenGroups.add(groupKey);
        groups.push(tags);
    });

    return groups;
}

function normalizeRouteRule(rule) {
    if (!rule || typeof rule !== 'object') {
        return null;
    }

    if (rule.type === 'default') {
        return {
            type: 'default',
            folder: rule.folder || 'Solo / Duo / Group'
        };
    }

    const folder = String(rule.folder || '').trim();

    const promptMode = rule.prompt_mode === 'group' ? 'group' : 'single';
    let tags = parseRouteTags(rule.tags || '');
    let tagGroups = parseRouteTagGroups(rule.tag_groups || []);
    let promptText = cleanRoutePromptRawText(rule.prompt_text);

    const condition = rule.condition === 'all' ? 'all' : 'any';
    const matchCount = Math.max(1, parseInt(rule.match_count || 1, 10) || 1);

    const children = Array.isArray(rule.children)
        ? rule.children.map(normalizeRouteRule).filter(Boolean).filter(r => r.type !== 'default')
        : [];

    if (!promptText) {
        if (promptMode === 'group' && tagGroups.length) {
            promptText = routeGroupsToText(tagGroups);
        } else if (tags.length) {
            promptText = tags.join('\n');
        }
    }

    if (promptText) {
        tags = parseRouteTags(promptText);
        tagGroups = parseRouteTagGroups(promptText);
    }

    if (promptMode === 'group' && !tagGroups.length && tags.length) {
        tagGroups = tags.map(tag => [tag]);
    }

    if (!folder || (!promptText && !tags.length && !tagGroups.length)) {
        return null;
    }

    return {
        type: 'custom',
        folder,
        prompt_text: promptText,
        tags,
        prompt_mode: promptMode,
        tag_groups: tagGroups,
        condition,
        match_count: matchCount,
        children
    };
}

function normalizeRouteRuleList(rules) {
    const normalized = (Array.isArray(rules) ? rules : [])
        .map(normalizeRouteRule)
        .filter(Boolean);

    if (!normalized.find(r => r.type === 'default')) {
        normalized.push({
            type: 'default',
            folder: 'Solo / Duo / Group'
        });
    }

    return normalized;
}

function getRouteRuleContainer(path) {
    let container = customRules;

    for (let i = 0; i < path.length - 1; i++) {
        const rule = container[path[i]];
        if (!rule || rule.type === 'default') {
            return null;
        }

        if (!Array.isArray(rule.children)) {
            rule.children = [];
        }

        container = rule.children;
    }

    return container;
}

function getRouteRuleByPath(path) {
    const container = getRouteRuleContainer(path);
    if (!container) return null;
    return container[path[path.length - 1]] || null;
}

function routeTreePathKey(path) {
    return Array.isArray(path) ? path.join('.') : '';
}

function toggleRouteTreeExpanded(path) {
    const rule = getRouteRuleByPath(path);
    const children = Array.isArray(rule?.children) ? rule.children : [];

    if (!children.length) {
        return;
    }

    const key = routeTreePathKey(path);
    if (!key && key !== '0') return;

    if (routeTreeExpandedPathKeys.has(key)) {
        routeTreeExpandedPathKeys.delete(key);
    } else {
        routeTreeExpandedPathKeys.add(key);
    }

    renderFolderMgrTable();
}

function expandRouteTreePath(path) {
    const key = routeTreePathKey(path);
    if (key || key === '0') {
        routeTreeExpandedPathKeys.add(key);
    }
}

function getRouteTreeRuleLabel(rule) {
    return String(rule?.folder || '(이름 없음)').trim() || '(이름 없음)';
}

function getRouteTreePromptPreview(rule) {
    const text = getRouteRulePromptText(rule);
    const compact = String(text || '')
        .replace(/\s+/g, ' ')
        .trim();

    if (!compact) return '감지 프롬프트 없음';
    return compact.length > 90 ? compact.slice(0, 90) + '...' : compact;
}

function getRouteTreeConditionLabel(rule) {
    const condition = rule?.condition === 'all' ? 'all' : 'any';
    const count = Math.max(1, parseInt(rule?.match_count || 1, 10) || 1);

    if (condition === 'all') return '전체 일치';
    return `${count}개 이상`;
}

function getRouteTreeModeLabel(rule) {
    return getRouteRulePromptMode(rule) === 'group' ? '묶음' : '개별';
}

function getRouteTreePromptCount(rule) {
    if (!rule || rule.type === 'default') return 0;

    if (getRouteRulePromptMode(rule) === 'group') {
        return parseRouteTagGroups(rule.tag_groups || rule.prompt_text || '').length;
    }

    return parseRouteTags(rule.tags || rule.prompt_text || '').length;
}

function getRouteTreeSiblingInfo(path) {
    const container = getRouteRuleContainer(path);
    const index = path[path.length - 1];

    return {
        container,
        index,
        canMoveUp: Array.isArray(container) && index > 0,
        canMoveDown: Array.isArray(container) && index < container.length - 1
    };
}

function getRouteRulePathLabel(path) {
    const names = [];
    let container = customRules;

    for (let i = 0; i < path.length; i++) {
        const rule = container[path[i]];
        if (!rule) break;
        names.push(String(rule.folder || '(이름 없음)').trim() || '(이름 없음)');
        container = Array.isArray(rule.children) ? rule.children : [];
    }

    return names.join(' > ');
}

function setRouteRuleAddTarget(path) {
    pendingRouteRuleParentPath = Array.isArray(path) ? [...path] : null;
    updateRouteRuleAddTargetUi();

    const panel = document.getElementById('folderMgrAddPanel')
        || document.getElementById('folderRuleAddPanel')
        || document.querySelector('.folder-rule-add-panel')
        || document.querySelector('.route-rule-add-panel');

    if (panel) {
        panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    const folderInput =
        document.getElementById('ruleFolderName')
        || document.getElementById('newFolderName')
        || document.getElementById('folderNameInput')
        || document.querySelector('[data-route-add-folder]');

    if (folderInput) {
        folderInput.focus();
        folderInput.select?.();
    }
}

function clearRouteRuleAddTarget() {
    pendingRouteRuleParentPath = null;
    updateRouteRuleAddTargetUi();
}

function updateRouteRuleAddTargetUi() {
    const notice = document.getElementById('routeRuleAddTargetNotice');
    const addTitle = document.getElementById('routeRuleAddTitle');
    const isChildMode = Array.isArray(pendingRouteRuleParentPath);
    const label = isChildMode ? getRouteRulePathLabel(pendingRouteRuleParentPath) : '';

    if (addTitle) {
        addTitle.innerText = isChildMode ? '하위 규칙 추가' : '새 상위 규칙 추가';
    }

    if (notice) {
        notice.style.display = isChildMode ? 'flex' : 'none';
        notice.innerHTML = isChildMode
            ? `
                <span>추가 대상: <b>${escapeRouteHtml(label)}</b> 아래</span>
                <button type="button" id="routeRuleAddTargetCancel" onclick="clearRouteRuleAddTarget()">하위 추가 취소</button>
              `
            : '';
    }
}

function beginRouteRuleChildAdd(path) {
    const rule = getRouteRuleByPath(path);
    if (!rule || rule.type === 'default') return;

    setRouteRuleAddTarget(path);
}

function cleanupRouteTreeExpandedKeys() {
    [...routeTreeExpandedPathKeys].forEach(key => {
        const path = key.split('.').map(v => parseInt(v, 10)).filter(v => Number.isFinite(v));
        if (!getRouteRuleByPath(path)) {
            routeTreeExpandedPathKeys.delete(key);
        }
    });
}

function routeCardPathKey(path) {
    return Array.isArray(path) ? path.join('.') : '';
}

function parseRouteCardPathKey(key) {
    const text = String(key || '');
    if (!text) return [];
    return text.split('.').map(v => parseInt(v, 10)).filter(v => Number.isFinite(v));
}

function routeCardParentPath(path) {
    return Array.isArray(path) ? path.slice(0, -1) : [];
}

function routeCardSameParent(a, b) {
    return routeCardPathKey(routeCardParentPath(a)) === routeCardPathKey(routeCardParentPath(b));
}

function getRouteRuleChildren(rule) {
    if (!rule || rule.type === 'default') return [];
    if (!Array.isArray(rule.children)) rule.children = [];
    return rule.children;
}

function getRouteCardPromptCount(rule) {
    if (!rule || rule.type === 'default') return 0;

    if (getRouteRulePromptMode(rule) === 'group') {
        return parseRouteTagGroups(rule.tag_groups || rule.prompt_text || '').length;
    }

    return parseRouteTags(rule.tags || rule.prompt_text || '').length;
}

function getRouteCardModeLabel(rule) {
    return getRouteRulePromptMode(rule) === 'group' ? '묶음' : '개별';
}

function getRouteCardRuleLabel(rule) {
    return String(rule?.folder || '(이름 없음)').trim() || '(이름 없음)';
}

function getRouteCardPathLabel(path) {
    const names = [];
    let container = customRules;

    for (let i = 0; i < path.length; i++) {
        const rule = container[path[i]];
        if (!rule) break;
        names.push(getRouteCardRuleLabel(rule));
        container = Array.isArray(rule.children) ? rule.children : [];
    }

    return names.join(' > ');
}

function getContainerByParentPath(parentPath) {
    if (!Array.isArray(parentPath) || !parentPath.length) return customRules;

    const parentRule = getRouteRuleByPath(parentPath);
    if (!parentRule || parentRule.type === 'default') return null;

    if (!Array.isArray(parentRule.children)) parentRule.children = [];
    return parentRule.children;
}

function getFolderRulesSnapshotJson() {
    try {
        return JSON.stringify(normalizeRouteRuleList(customRules));
    } catch (e) {
        return '';
    }
}

function setFolderRulesBaseline() {
    folderRulesBaselineJson = getFolderRulesSnapshotJson();
}

function hasUnsavedFolderRuleChanges() {
    return Boolean(folderRulesBaselineJson) && getFolderRulesSnapshotJson() !== folderRulesBaselineJson;
}

function forceCloseFolderMgr() {
    closeRouteRuleTester();
    closeTagsExpanded();
    document.getElementById('folderLayer').style.display = 'none';
}

function showUnsavedFolderRuleConfirm() {
    const ok = confirm('저장하지 않은 정밀 라우팅 규칙 수정이 있습니다.\n\n확인을 누르면 저장하지 않고 닫습니다.\n취소를 누르면 계속 수정합니다.');
    if (ok) forceCloseFolderMgr();
}

function openFolderMgr() {
    document.getElementById('folderLayer').style.display = 'flex';
    clearRouteRuleAddTarget();
    fetch('/api/custom_rules')
        .then(res => res.json())
        .then(data => {
            customRules = normalizeRouteRuleList(data.rules || []);
            renderFolderMgrTable();
            setFolderRulesBaseline();
            newRouteRulePromptMode = 'single';
            updateRouteModeButtons(activeRouteTagEditMode);
            updateRouteRuleAddTargetUi();
        });
}

function closeFolderMgr() {
    if (hasUnsavedFolderRuleChanges()) {
        showUnsavedFolderRuleConfirm();
        return;
    }
    forceCloseFolderMgr();
}

// 조건 선택 변경 시 개수 입력창 활성/비활성 처리
function toggleMatchCount() {
    const cond = document.getElementById('ruleCondition').value;
    const wrap = document.getElementById('matchCountWrapper');
    const input = document.getElementById('ruleMatchCount');

    if (cond === 'all') {
        wrap.style.opacity = '0.3';
        input.disabled = true;
    } else {
        wrap.style.opacity = '1';
        input.disabled = false;
    }
}

let activeRouteTagEditPath = null;
let activeRouteTagEditMode = 'single';
let newRouteRulePromptMode = 'single';

function getSafeRoutePromptMode(mode) {
    return mode === 'group' ? 'group' : 'single';
}

function getRouteRulePromptMode(rule) {
    return rule?.prompt_mode === 'group' ? 'group' : 'single';
}

function cleanRoutePromptRawText(value) {
    return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function routeGroupsToText(groups) {
    return parseRouteTagGroups(groups || [])
        .map(group => group.join(', '))
        .join('\n');
}

function getRouteRulePromptText(rule) {
    if (!rule || rule.type === 'default') return '';

    const raw = cleanRoutePromptRawText(rule.prompt_text);
    if (raw) return raw;

    if (Array.isArray(rule.tag_groups) && rule.tag_groups.length) {
        return routeGroupsToText(rule.tag_groups || []);
    }

    if (Array.isArray(rule.tags) && rule.tags.length) {
        return rule.tags.join('\n');
    }

    return '';
}

function getRoutePromptPreviewText(rawText) {
    return cleanRoutePromptRawText(rawText)
        .replace(/\n+/g, ' / ');
}

function syncRouteRulePromptFromText(rule, rawText, mode = null) {
    if (!rule || rule.type === 'default') return;

    const text = cleanRoutePromptRawText(rawText);

    rule.prompt_text = text;

    if (mode !== null) {
        rule.prompt_mode = getSafeRoutePromptMode(mode);
    } else {
        rule.prompt_mode = getRouteRulePromptMode(rule);
    }

    rule.tags = parseRouteTags(text);
    rule.tag_groups = parseRouteTagGroups(text);
}

function updateNewRulePromptText(rawText) {
    const input = document.getElementById('ruleTags');
    if (!input) return;

    const text = cleanRoutePromptRawText(rawText);
    input.dataset.promptText = text;
    input.value = getRoutePromptPreviewText(text);
}

function routeRuleToExpandedText(rule) {
    return getRouteRulePromptText(rule);
}

function updateRouteModeButtons(mode = activeRouteTagEditMode) {
    const safeMode = getSafeRoutePromptMode(mode);

    const expandedSingle = document.getElementById('ruleTagsExpandedSingleBtn');
    const expandedGroup = document.getElementById('ruleTagsExpandedGroupBtn');
    const newSingle = document.getElementById('newRuleSingleModeBtn');
    const newGroup = document.getElementById('newRuleGroupModeBtn');
    const title = document.getElementById('ruleTagsExpandedTitle');
    const hint = document.getElementById('ruleTagsExpandedHint');
    const textarea = document.getElementById('ruleTagsExpandedText');

    if (expandedSingle) expandedSingle.classList.toggle('active', safeMode === 'single');
    if (expandedGroup) expandedGroup.classList.toggle('active', safeMode === 'group');

    if (newSingle) newSingle.classList.toggle('active', newRouteRulePromptMode === 'single');
    if (newGroup) newGroup.classList.toggle('active', newRouteRulePromptMode === 'group');

    if (title) {
        title.innerText = safeMode === 'group'
            ? '📝 프롬프트 대량 입력 - 묶음'
            : '📝 프롬프트 대량 입력 - 개별';
    }

    if (hint) {
        hint.innerText = safeMode === 'group'
            ? '묶음: Enter 한 줄이 하나의 조건입니다. 한 줄 안의 콤마 항목은 모두 포함되어야 합니다.'
            : '개별: 콤마와 Enter를 모두 구분자로 보고 각각 하나의 조건으로 사용합니다.';
    }

    if (textarea) {
        textarea.classList.toggle('route-group-mode', safeMode === 'group');
        textarea.classList.toggle('route-single-mode', safeMode !== 'group');
    }
}

function setNewRouteRulePromptMode(mode) {
    newRouteRulePromptMode = getSafeRoutePromptMode(mode);
    updateRouteModeButtons(activeRouteTagEditMode);
}

function selectNewRouteRulePromptMode(mode) {
    newRouteRulePromptMode = getSafeRoutePromptMode(mode);

    const input = document.getElementById('ruleTags');
    if (input) {
        const raw = cleanRoutePromptRawText(input.dataset.promptText || input.value || '');
        input.dataset.promptText = raw;
        input.value = getRoutePromptPreviewText(raw);
    }

    updateRouteModeButtons(activeRouteTagEditMode);
}

function setRouteTagsExpandedMode(mode) {
    activeRouteTagEditMode = getSafeRoutePromptMode(mode);
    const textarea = document.getElementById('ruleTagsExpandedText');
    const raw = textarea ? textarea.value : '';

    if (activeRouteTagEditPath) {
        const rule = getRouteRuleByPath(activeRouteTagEditPath);
        if (rule && rule.type !== 'default') {
            syncRouteRulePromptFromText(rule, raw, activeRouteTagEditMode);
        }
    } else {
        newRouteRulePromptMode = activeRouteTagEditMode;
        updateNewRulePromptText(raw);
    }

    updateRouteModeButtons(activeRouteTagEditMode);
}

function openRouteRuleTagsExpanded(path, mode = null) {
    activeRouteTagEditPath = Array.isArray(path) ? path : null;

    const rule = activeRouteTagEditPath ? getRouteRuleByPath(activeRouteTagEditPath) : null;
    if (!rule || rule.type === 'default') return;

    activeRouteTagEditMode = getSafeRoutePromptMode(mode || getRouteRulePromptMode(rule));
    rule.prompt_mode = activeRouteTagEditMode;

    const layer = document.getElementById('ruleTagsExpandedLayer');
    const textarea = document.getElementById('ruleTagsExpandedText');

    if (!layer || !textarea) return;

    textarea.value = getRouteRulePromptText(rule);
    layer.style.display = 'flex';

    updateRouteModeButtons(activeRouteTagEditMode);
}

function applyRouteRuleTagsExpanded() {
    const raw = document.getElementById('ruleTagsExpandedText')?.value || '';
    const mode = getSafeRoutePromptMode(activeRouteTagEditMode);

    if (activeRouteTagEditPath) {
        const rule = getRouteRuleByPath(activeRouteTagEditPath);

        if (rule && rule.type !== 'default') {
            syncRouteRulePromptFromText(rule, raw, mode);

            activeRouteTagEditPath = null;
            closeTagsExpanded();
            renderFolderMgrTable();
            return;
        }
    }

    newRouteRulePromptMode = mode;
    updateNewRulePromptText(raw);

    closeTagsExpanded();
    updateRouteModeButtons(mode);
}

function openTagsExpanded(mode = null) {
    activeRouteTagEditPath = null;

    if (mode !== null) {
        activeRouteTagEditMode = getSafeRoutePromptMode(mode);
        newRouteRulePromptMode = activeRouteTagEditMode;
    } else {
        activeRouteTagEditMode = getSafeRoutePromptMode(newRouteRulePromptMode);
    }

    const layer = document.getElementById('ruleTagsExpandedLayer');
    const textarea = document.getElementById('ruleTagsExpandedText');
    const input = document.getElementById('ruleTags');

    if (!layer || !textarea) return;

    const raw = cleanRoutePromptRawText(input?.dataset?.promptText || input?.value || '');
    textarea.value = raw;

    layer.style.display = 'flex';
    updateRouteModeButtons(activeRouteTagEditMode);
}

function closeTagsExpanded() {
    const layer = document.getElementById('ruleTagsExpandedLayer');
    if (layer) layer.style.display = 'none';
}

function applyTagsExpanded() {
    applyRouteRuleTagsExpanded();
}

function setFolderRuleViewMode(mode) {
    folderRuleViewMode = mode === 'card' ? 'card' : 'table';
    localStorage.setItem(ROUTE_RULE_VIEW_MODE_KEY, folderRuleViewMode);
    routeCardSelectedPathKeys.clear();
    routeCardLastClickedPathKey = '';
    renderFolderMgrTable();
}

function renderFolderRuleViewModeToolbar() {
    return `
        <div class="route-rule-view-toolbar">
            <div class="route-rule-view-title">
                <b>정밀 라우팅 규칙 설정</b>
                <span>트리 보기와 카드 보기는 같은 규칙 데이터를 편집합니다.</span>
            </div>
            <div class="route-rule-view-buttons">
                <button type="button"
                        class="route-rule-view-btn ${folderRuleViewMode === 'table' ? 'active' : ''}"
                        onclick="setFolderRuleViewMode('table')">
                    트리 보기
                </button>
                <button type="button"
                        class="route-rule-view-btn ${folderRuleViewMode === 'card' ? 'active' : ''}"
                        onclick="setFolderRuleViewMode('card')">
                    카드 보기
                </button>
            </div>
        </div>
    `;
}

function renderFolderMgrTable() {
    const container = document.getElementById('folderMgrTableContainer');
    if (!container) return;

    const toolbarContainer = document.getElementById('folderMgrViewToolbarContainer');
    const toolbarHtml = renderFolderRuleViewModeToolbar();

    if (toolbarContainer) {
        toolbarContainer.innerHTML = toolbarHtml;
    }

    let html = toolbarContainer ? '' : toolbarHtml;

    if (folderRuleViewMode === 'card') {
        html += renderRouteRuleCardView();
        container.innerHTML = html;
        bindRouteCardPointerHandlers();
        return;
    }

    html += renderRouteRuleTreeView();
    container.innerHTML = html;
}

function renderRouteTagEditor(pathJson, rule, depth = 0) {
    const promptMode = getRouteRulePromptMode(rule);
    const rawText = getRouteRulePromptText(rule);
    const previewText = getRoutePromptPreviewText(rawText);

    return `
        <div style="
            display:flex;
            align-items:stretch;
            background:#222230;
            border:1px solid #3b3b4f;
            border-radius:8px;
            overflow:hidden;
            min-height:40px;
        ">
            <input type="text"
                   value="${escapeRouteHtml(previewText)}"
                   placeholder="감지할 프롬프트/태그 입력..."
                   onchange='updateRouteRuleTags(${pathJson}, this.value)'
                   style="
                       flex:1;
                       min-width:0;
                       padding:10px 12px;
                       background:none;
                       border:none;
                       color:#fff;
                       outline:none;
                       font-family:'Malgun Gothic';
                       font-size:${depth ? '12px' : '13px'};
                   ">
            <button type="button"
                    class="route-mode-btn route-mode-mini ${promptMode === 'single' ? 'active' : ''}"
                    onclick='setRouteRulePromptMode(${pathJson}, "single")'
                    title="개별 모드">
                개별
            </button>
            <button type="button"
                    class="route-mode-btn route-mode-mini ${promptMode === 'group' ? 'active' : ''}"
                    onclick='setRouteRulePromptMode(${pathJson}, "group")'
                    title="묶음 모드">
                묶음
            </button>
            <button type="button"
                    class="route-mode-btn route-mode-mini route-expand-mini"
                    onclick='openRouteRuleTagsExpanded(${pathJson})'
                    title="프롬프트 대량 입력">
                ⤢
            </button>
        </div>
    `;
}

function renderRouteRuleTreeView() {
    const normalRules = customRules
        .map((rule, index) => ({ rule, index }))
        .filter(item => item.rule && item.rule.type !== 'default');

    const defaultRule = customRules.find(rule => rule && rule.type === 'default');

    return `
        <div class="route-tree-view">
            <div class="route-tree-help">
                트리 보기는 빠른 인라인 편집용입니다. 펼침 버튼은 하위 규칙 표시용으로만 사용합니다. +하위는 기존 추가 입력창의 추가 대상을 바꿉니다.
            </div>

            <div class="route-tree-header dense">
                <span>규칙</span>
                <span>빠른 편집</span>
            </div>

            <div class="route-tree-list">
                ${
                    normalRules.length
                        ? normalRules.map(item => renderRouteTreeRuleNode(item.rule, [item.index], 0)).join('')
                        : '<div class="route-tree-empty">등록된 정밀 라우팅 규칙이 없습니다.</div>'
                }
            </div>

            ${
                defaultRule
                    ? `<div class="route-tree-default">기본 분류: ${escapeRouteHtml(defaultRule.folder || 'Solo / Duo / Group')}</div>`
                    : ''
            }
        </div>
    `;
}

function renderRouteTreeRuleNode(rule, path, depth) {
    if (!rule || rule.type === 'default') return '';

    const pathKey = routeTreePathKey(path);
    const pathJson = JSON.stringify(path);
    const children = Array.isArray(rule.children) ? rule.children : [];
    const childCount = children.length;
    const hasChildren = childCount > 0;
    const expanded = hasChildren && routeTreeExpandedPathKeys.has(pathKey);
    const promptCount = getRouteTreePromptCount(rule);
    const modeLabel = getRouteTreeModeLabel(rule);
    const siblingInfo = getRouteTreeSiblingInfo(path);

    const upBtn = siblingInfo.canMoveUp
        ? `<button type="button" class="route-tree-icon-btn" onclick='moveRule(${pathJson}, -1)' title="위로">▲</button>`
        : `<button type="button" class="route-tree-icon-btn disabled" disabled>▲</button>`;

    const downBtn = siblingInfo.canMoveDown
        ? `<button type="button" class="route-tree-icon-btn" onclick='moveRule(${pathJson}, 1)' title="아래로">▼</button>`
        : `<button type="button" class="route-tree-icon-btn disabled" disabled>▼</button>`;

    const expandButton = hasChildren
        ? `
            <button type="button"
                    class="route-tree-expand-btn"
                    onclick='toggleRouteTreeExpanded(${pathJson})'
                    title="${expanded ? '하위 규칙 접기' : '하위 규칙 펼치기'}">
                ${expanded ? '▾' : '▸'}
            </button>
        `
        : '<span class="route-tree-expand-spacer"></span>';

    return `
        <div class="route-tree-node ${expanded ? 'expanded' : ''} ${hasChildren ? 'has-children' : 'no-children'}"
             style="--depth:${depth};"
             data-route-tree-path="${escapeRouteHtml(pathKey)}">
            <div class="route-tree-summary dense">
                <div class="route-tree-rail">
                    ${expandButton}

                    <div class="route-tree-title-wrap">
                        <div class="route-tree-title">
                            ${depth === 0 ? '📁' : '↳'}
                            <span class="route-tree-depth-label">${depth > 0 ? `Lv.${depth}` : '상위'}</span>
                        </div>
                        <div class="route-tree-meta">
                            ${escapeRouteHtml(modeLabel)} ${promptCount}개 · 하위 ${childCount}개
                        </div>
                    </div>
                </div>

                <div class="route-tree-edit-panel">
                    <div class="route-tree-edit-top">
                        <div class="route-tree-folder-edit">
                            <input type="text"
                                   value="${escapeRouteHtml(rule.folder || '')}"
                                   placeholder="폴더명"
                                   onchange='updateRouteRuleField(${pathJson}, "folder", this.value)'>
                        </div>

                        <div class="route-tree-condition-edit">
                            <select onchange='updateRouteRuleField(${pathJson}, "condition", this.value)'>
                                <option value="any" ${rule.condition !== 'all' ? 'selected' : ''}>개수</option>
                                <option value="all" ${rule.condition === 'all' ? 'selected' : ''}>전체</option>
                            </select>

                            <input type="number"
                                   min="1"
                                   value="${Math.max(1, parseInt(rule.match_count || 1, 10) || 1)}"
                                   ${rule.condition === 'all' ? 'disabled' : ''}
                                   onchange='updateRouteRuleField(${pathJson}, "match_count", this.value)'>
                        </div>

                        <div class="route-tree-actions">
                            ${upBtn}
                            ${downBtn}
                            <button type="button" class="route-tree-mini-btn" onclick='addChildFolderRuleFromTree(${pathJson})'>+하위</button>
                            <button type="button" class="route-tree-mini-btn danger" onclick='deleteFolderRule(${pathJson})'>삭제</button>
                        </div>
                    </div>

                    <div class="route-tree-prompt-edit">
                        ${renderRouteTagEditor(pathJson, rule, depth)}
                    </div>
                </div>
            </div>

            ${
                expanded
                    ? `
                        <div class="route-tree-children">
                            ${children.map((child, index) => renderRouteTreeRuleNode(child, [...path, index], depth + 1)).join('')}
                        </div>
                    `
                    : ''
            }
        </div>
    `;
}

function renderRouteRuleCardView() {
    const normalRules = customRules
        .map((rule, index) => ({ rule, index }))
        .filter(item => item.rule && item.rule.type !== 'default');

    const defaultRule = customRules.find(rule => rule && rule.type === 'default');

    if (!normalRules.length) {
        return `
            <div class="route-card-view">
                <div class="route-card-empty">등록된 정밀 라우팅 규칙이 없습니다.</div>
            </div>
        `;
    }

    return `
        <div class="route-card-view">
            <div class="route-card-help">
                상위 규칙을 펼치면 하위 규칙이 우선순위 순서대로 표시됩니다.
                버튼 클릭은 선택, 더블클릭은 상세 편집, 드래그는 선택 그룹 이동입니다.
            </div>

            <div class="route-card-top-list route-card-top-chip-list">
                <div class="route-card-child-zone"
                    data-route-parent=""
                    data-route-depth="0">
                    <div class="route-card-child-grid">
                        ${normalRules.map(item => renderRouteChildButton(item.rule, [item.index], 0)).join('')}
                    </div>
                </div>
            </div>
            ${defaultRule ? `<div class="route-card-default-note">기본 분류: ${escapeRouteHtml(defaultRule.folder || 'Solo / Duo / Group')}</div>` : ''}
        </div>
    `;
}

function renderRouteTopRuleCard(rule, path) {
    const pathKey = routeCardPathKey(path);
    const expanded = routeCardExpandedPathKeys.has(pathKey);
    const children = getRouteRuleChildren(rule);
    const promptCount = getRouteCardPromptCount(rule);
    const childCount = children.length;

    return `
        <div class="route-top-card ${expanded ? 'expanded' : ''}" data-route-path="${escapeRouteHtml(pathKey)}">
            <div class="route-top-card-header">
                <button type="button"
                        class="route-card-expand-btn"
                        onclick='toggleRouteCardExpanded(${JSON.stringify(path)})'>
                    ${expanded ? '▾' : '▸'}
                </button>

                <div class="route-top-card-title" ondblclick='openRouteCardRuleEditor(${JSON.stringify(path)})'>
                    <div class="route-top-card-name">📁 ${escapeRouteHtml(getRouteCardRuleLabel(rule))}</div>
                    <div class="route-top-card-meta">
                        ${escapeRouteHtml(getRouteCardModeLabel(rule))}
                        ${promptCount}개 · 하위 ${childCount}개
                    </div>
                </div>

                <div class="route-top-card-actions">
                    <button type="button" onclick='beginRouteRuleChildAdd(${JSON.stringify(path)})'>+하위</button>
                    <button type="button" onclick='openRouteCardRuleEditor(${JSON.stringify(path)})'>편집</button>
                    <button type="button" class="danger" onclick='deleteFolderRule(${JSON.stringify(path)})'>삭제</button>
                </div>
            </div>

            ${expanded ? `
                <div class="route-card-children-wrap">
                    ${children.length ? renderRouteChildButtonGrid(children, path, 1) : '<div class="route-card-empty small">하위 규칙이 없습니다.</div>'}
                </div>
            ` : ''}
        </div>
    `;
}

function renderRouteChildButtonGrid(children, parentPath, depth) {
    const parentKey = routeCardPathKey(parentPath);

    return `
        <div class="route-card-child-zone"
             data-route-parent="${escapeRouteHtml(parentKey)}"
             data-route-depth="${depth}">
            <div class="route-card-child-grid">
                ${children.map((rule, index) => renderRouteChildButton(rule, [...parentPath, index], depth)).join('')}
            </div>
        </div>
    `;
}

function renderRouteChildButton(rule, path, depth) {
    const pathKey = routeCardPathKey(path);
    const expanded = routeCardExpandedPathKeys.has(pathKey);
    const selected = routeCardSelectedPathKeys.has(pathKey);
    const flash = routeCardFlashPathKey === pathKey;
    const children = getRouteRuleChildren(rule);
    const hasChildren = children.length > 0;
    const promptCount = getRouteCardPromptCount(rule);

    return `
        <div class="route-child-block ${hasChildren ? 'has-children' : ''} ${expanded && hasChildren ? 'expanded' : ''}"
             data-route-block-path="${escapeRouteHtml(pathKey)}">

            <div class="route-child-row">
                ${
                    hasChildren
                        ? `
                            <button type="button"
                                    class="route-child-expand-mini"
                                    title="${expanded ? '하위 규칙 접기' : '하위 규칙 펼치기'}"
                                    onclick='toggleRouteCardExpandedFromChip(event, ${JSON.stringify(path)})'
                                    onpointerdown="event.preventDefault(); event.stopPropagation();">
                                ${expanded ? '▾' : '▸'}
                            </button>
                        `
                        : ''
                }

                <button type="button"
                        class="route-child-chip ${selected ? 'selected' : ''} ${flash ? 'flash' : ''}"
                        data-route-path="${escapeRouteHtml(pathKey)}"
                        data-route-parent="${escapeRouteHtml(routeCardPathKey(routeCardParentPath(path)))}"
                        title="${escapeRouteHtml(getRouteCardPathLabel(path))}"
                        onclick='handleRouteCardChipClick(event, ${JSON.stringify(path)})'
                        ondblclick='handleRouteCardChipDoubleClick(event, ${JSON.stringify(path)})'>
                    <span class="route-child-chip-name">${escapeRouteHtml(getRouteCardRuleLabel(rule))}</span>
                    <span class="route-child-chip-meta">${escapeRouteHtml(getRouteCardModeLabel(rule))} ${promptCount}</span>
                    ${hasChildren ? `<span class="route-child-count-badge">하위 ${children.length}</span>` : ''}
                </button>

                ${hasChildren && expanded ? `
                    <button type="button"
                            class="route-child-add-btn"
                            title="이 규칙 아래에 하위 규칙 추가"
                            onclick='addChildFolderRuleFromCard(event, ${JSON.stringify(path)})'
                            onpointerdown="event.preventDefault(); event.stopPropagation();">
                        +하위
                    </button>
                ` : ''}
            </div>

            ${expanded && hasChildren ? `
                <div class="route-card-nested-section">
                    <div class="route-card-nested-title">
                        ${escapeRouteHtml(getRouteCardRuleLabel(rule))} 하위 규칙
                    </div>
                    ${renderRouteChildButtonGrid(children, path, depth + 1)}
                </div>
            ` : ''}
        </div>
    `;
}

function toggleRouteCardExpanded(path) {
    const key = routeCardPathKey(path);
    if (!key) return;

    if (routeCardExpandedPathKeys.has(key)) {
        routeCardExpandedPathKeys.delete(key);
    } else {
        routeCardExpandedPathKeys.add(key);
    }

    renderFolderMgrTable();
}

function toggleRouteCardExpandedFromChip(event, path) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }

    routeCardDragState = null;
    routeCardSelectionBoxState = null;
    document.body.classList.remove('route-card-dragging');
    clearRouteCardDropIndicator();

    toggleRouteCardExpanded(path);
}

function addChildFolderRuleFromCard(event, path) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }

    routeCardDragState = null;
    routeCardSelectionBoxState = null;
    document.body.classList.remove('route-card-dragging');
    clearRouteCardDropIndicator();

    beginRouteRuleChildAdd(path);
}

function addChildFolderRuleFromTree(path) {
    beginRouteRuleChildAdd(path);
}

function handleRouteCardChipClick(event, path) {
    if (event.detail >= 2) return;

    event.preventDefault();
    event.stopPropagation();

    const key = routeCardPathKey(path);

    if (routeCardSuppressNextClickKey === key) {
        routeCardSuppressNextClickKey = '';
        return;
    }

    if (event.shiftKey && routeCardLastClickedPathKey) {
        selectRouteCardRange(routeCardLastClickedPathKey, key);
        routeCardLastClickedPathKey = key;
        renderFolderMgrTable();
        return;
    }

    if (event.ctrlKey || event.metaKey) {
        if (routeCardSelectedPathKeys.has(key)) {
            routeCardSelectedPathKeys.delete(key);
        } else {
            routeCardSelectedPathKeys.add(key);
        }

        routeCardLastClickedPathKey = key;
        renderFolderMgrTable();
        return;
    }

    const onlyThisSelected =
        routeCardSelectedPathKeys.size === 1 &&
        routeCardSelectedPathKeys.has(key);

    routeCardSelectedPathKeys.clear();

    if (!onlyThisSelected) {
        routeCardSelectedPathKeys.add(key);
        routeCardLastClickedPathKey = key;
    } else {
        routeCardLastClickedPathKey = '';
    }

    renderFolderMgrTable();
}

function selectRouteCardRange(fromKey, toKey) {
    const fromPath = parseRouteCardPathKey(fromKey);
    const toPath = parseRouteCardPathKey(toKey);

    if (!routeCardSameParent(fromPath, toPath)) {
        routeCardSelectedPathKeys.add(toKey);
        return;
    }

    const parentPath = routeCardParentPath(toPath);
    const list = getContainerByParentPath(parentPath);
    if (!Array.isArray(list)) {
        routeCardSelectedPathKeys.add(toKey);
        return;
    }

    const fromIndex = fromPath[fromPath.length - 1];
    const toIndex = toPath[toPath.length - 1];
    const start = Math.min(fromIndex, toIndex);
    const end = Math.max(fromIndex, toIndex);

    for (let i = start; i <= end; i++) {
        routeCardSelectedPathKeys.add(routeCardPathKey([...parentPath, i]));
    }
}

function handleRouteCardChipDoubleClick(event, path) {
    event.preventDefault();
    event.stopPropagation();
    openRouteCardRuleEditor(path);
}

function openRouteCardRuleEditor(path) {
    const rule = getRouteRuleByPath(path);
    if (!rule || rule.type === 'default') return;

    ensureRouteCardRuleEditorLayer();

    const layer = document.getElementById('routeCardRuleEditorLayer');
    const title = document.getElementById('routeCardRuleEditorTitle');
    const folder = document.getElementById('routeCardRuleFolder');
    const modeSingle = document.getElementById('routeCardRuleModeSingle');
    const modeGroup = document.getElementById('routeCardRuleModeGroup');
    const prompt = document.getElementById('routeCardRulePrompt');
    const condition = document.getElementById('routeCardRuleCondition');
    const matchCount = document.getElementById('routeCardRuleMatchCount');
    const pathInput = document.getElementById('routeCardRulePath');

    pathInput.value = JSON.stringify(path);
    title.innerText = `규칙 상세 편집 - ${getRouteCardPathLabel(path)}`;
    folder.value = rule.folder || '';
    prompt.value = getRouteRulePromptText(rule);
    condition.value = rule.condition === 'all' ? 'all' : 'any';
    matchCount.value = String(Math.max(1, parseInt(rule.match_count || 1, 10) || 1));

    const mode = getRouteRulePromptMode(rule);
    modeSingle.classList.toggle('active', mode === 'single');
    modeGroup.classList.toggle('active', mode === 'group');
    prompt.classList.toggle('route-group-mode', mode === 'group');
    prompt.classList.toggle('route-single-mode', mode !== 'group');
    layer.dataset.promptMode = mode;

    layer.style.display = 'flex';
}

function ensureRouteCardRuleEditorLayer() {
    if (document.getElementById('routeCardRuleEditorLayer')) return;

    const layer = document.createElement('div');
    layer.id = 'routeCardRuleEditorLayer';
    layer.className = 'route-card-editor-layer';
    layer.innerHTML = `
        <div class="route-card-editor">
            <div class="route-card-editor-header">
                <h3 id="routeCardRuleEditorTitle">규칙 상세 편집</h3>
                <button type="button" onclick="closeRouteCardRuleEditor()">×</button>
            </div>

            <input id="routeCardRulePath" type="hidden">

            <div class="route-card-editor-body">
                <label>
                    <span>폴더명</span>
                    <input id="routeCardRuleFolder" type="text">
                </label>

                <div class="route-card-editor-mode-row">
                    <span>감지 방식</span>
                    <button id="routeCardRuleModeSingle" type="button" onclick="setRouteCardEditorMode('single')">개별</button>
                    <button id="routeCardRuleModeGroup" type="button" onclick="setRouteCardEditorMode('group')">묶음</button>
                </div>

                <label>
                    <span>감지 프롬프트</span>
                    <textarea data-prompt-autocomplete id="routeCardRulePrompt" rows="10"></textarea>
                </label>

                <div class="route-card-editor-grid">
                    <label>
                        <span>일치 조건</span>
                        <select id="routeCardRuleCondition">
                            <option value="any">일부 일치</option>
                            <option value="all">전체 일치</option>
                        </select>
                    </label>

                    <label>
                        <span>필요 개수</span>
                        <input id="routeCardRuleMatchCount" type="number" min="1" value="1">
                    </label>
                </div>
            </div>

            <div class="route-card-editor-footer">
                <button type="button" class="secondary" onclick="closeRouteCardRuleEditor()">취소</button>
                <button type="button" onclick="addChildFromRouteCardEditor()">+ 하위 규칙</button>
                <button type="button" class="danger" onclick="deleteRouteCardEditorRule()">삭제</button>
                <button type="button" class="primary" onclick="saveRouteCardRuleEditor()">적용</button>
            </div>
        </div>
    `;

    document.body.appendChild(layer);
}

function setRouteCardEditorMode(mode) {
    const layer = document.getElementById('routeCardRuleEditorLayer');
    const prompt = document.getElementById('routeCardRulePrompt');
    const safeMode = mode === 'group' ? 'group' : 'single';

    if (layer) layer.dataset.promptMode = safeMode;

    document.getElementById('routeCardRuleModeSingle')?.classList.toggle('active', safeMode === 'single');
    document.getElementById('routeCardRuleModeGroup')?.classList.toggle('active', safeMode === 'group');

    if (prompt) {
        prompt.classList.toggle('route-group-mode', safeMode === 'group');
        prompt.classList.toggle('route-single-mode', safeMode !== 'group');
    }
}

function closeRouteCardRuleEditor() {
    const layer = document.getElementById('routeCardRuleEditorLayer');
    if (layer) layer.style.display = 'none';
}

function getRouteCardEditorPath() {
    try {
        return JSON.parse(document.getElementById('routeCardRulePath')?.value || '[]');
    } catch (e) {
        return [];
    }
}

function saveRouteCardRuleEditor() {
    const path = getRouteCardEditorPath();
    const rule = getRouteRuleByPath(path);
    if (!rule || rule.type === 'default') return false;

    const folder = String(document.getElementById('routeCardRuleFolder')?.value || '').trim();
    const prompt = document.getElementById('routeCardRulePrompt')?.value || '';
    const mode = document.getElementById('routeCardRuleEditorLayer')?.dataset?.promptMode === 'group' ? 'group' : 'single';
    const condition = document.getElementById('routeCardRuleCondition')?.value === 'all' ? 'all' : 'any';
    const matchCount = Math.max(1, parseInt(document.getElementById('routeCardRuleMatchCount')?.value || '1', 10) || 1);

    if (!folder) {
        alert('폴더명을 입력하세요.');
        return false;
    }

    rule.folder = folder;
    rule.condition = condition;
    rule.match_count = matchCount;
    syncRouteRulePromptFromText(rule, prompt, mode);

    closeRouteCardRuleEditor();
    renderFolderMgrTable();
    return true;
}

function addChildFromRouteCardEditor() {
    const path = getRouteCardEditorPath();
    if (!saveRouteCardRuleEditor()) return;
    beginRouteRuleChildAdd(path);
}

function deleteRouteCardEditorRule() {
    const path = getRouteCardEditorPath();
    closeRouteCardRuleEditor();
    deleteFolderRule(path);
}

function getRouteCardSelectedSiblingPaths(parentPath) {
    const parentKey = routeCardPathKey(parentPath);

    return [...routeCardSelectedPathKeys]
        .map(parseRouteCardPathKey)
        .filter(path => routeCardPathKey(routeCardParentPath(path)) === parentKey)
        .sort((a, b) => a[a.length - 1] - b[b.length - 1]);
}

function moveRouteCardSelectedGroup(parentPath, targetIndex) {
    const list = getContainerByParentPath(parentPath);
    if (!Array.isArray(list)) return;

    const selectedPaths = getRouteCardSelectedSiblingPaths(parentPath);
    if (!selectedPaths.length) return;

    const selectedIndices = selectedPaths
        .map(path => path[path.length - 1])
        .filter(index => index >= 0 && index < list.length)
        .sort((a, b) => a - b);

    if (!selectedIndices.length) return;

    const selectedSet = new Set(selectedIndices);
    const movingItems = selectedIndices.map(index => list[index]);
    const remaining = list.filter((_, index) => !selectedSet.has(index));
    const beforeRemoved = selectedIndices.filter(index => index < targetIndex).length;
    let insertIndex = targetIndex - beforeRemoved;
    insertIndex = Math.max(0, Math.min(insertIndex, remaining.length));

    const nextList = [
        ...remaining.slice(0, insertIndex),
        ...movingItems,
        ...remaining.slice(insertIndex)
    ];

    list.splice(0, list.length, ...nextList);

    routeCardSelectedPathKeys.clear();
    movingItems.forEach(item => {
        const newIndex = list.indexOf(item);
        if (newIndex >= 0) {
            const newPath = [...parentPath, newIndex];
            const newKey = routeCardPathKey(newPath);
            routeCardSelectedPathKeys.add(newKey);
            routeCardFlashPathKey = newKey;
        }
    });

    setTimeout(() => {
        routeCardFlashPathKey = '';
        if (folderRuleViewMode === 'card') renderFolderMgrTable();
    }, 700);

    renderFolderMgrTable();
}

function bindRouteCardPointerHandlers() {
    const root = document.getElementById('folderMgrTableContainer');
    if (!root || root.dataset.routeCardBound === '1') return;

    root.dataset.routeCardBound = '1';
    root.addEventListener('pointerdown', handleRouteCardPointerDown);
    root.addEventListener('pointermove', handleRouteCardPointerMove);
    root.addEventListener('pointerup', handleRouteCardPointerUp);
    root.addEventListener('pointercancel', handleRouteCardPointerCancel);
}

function handleRouteCardPointerDown(event) {
    if (folderRuleViewMode !== 'card') return;

    if (event.target.closest('.route-child-expand-mini, .route-child-add-btn')) {
        return;
    }

    const chip = event.target.closest('.route-child-chip');
    const zone = event.target.closest('.route-card-child-zone');

    if (!chip && zone) {
        startRouteCardSelectionBox(event, zone);
        return;
    }

    if (!chip || event.button !== 0) return;

    const path = parseRouteCardPathKey(chip.dataset.routePath || '');
    const key = routeCardPathKey(path);

    routeCardDragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        path,
        key,
        dragging: false,
        parentPath: routeCardParentPath(path)
    };

    try {
        chip.setPointerCapture(event.pointerId);
    } catch (e) {}
}

function handleRouteCardPointerMove(event) {
    if (routeCardSelectionBoxState) {
        updateRouteCardSelectionBox(event);
        return;
    }

    if (!routeCardDragState || routeCardDragState.pointerId !== event.pointerId) return;

    const dx = event.clientX - routeCardDragState.startX;
    const dy = event.clientY - routeCardDragState.startY;

    if (!routeCardDragState.dragging && Math.hypot(dx, dy) > 6) {
        routeCardDragState.dragging = true;

        if (!routeCardSelectedPathKeys.has(routeCardDragState.key)) {
            routeCardSelectedPathKeys.clear();
            routeCardSelectedPathKeys.add(routeCardDragState.key);
            document.querySelectorAll('.route-child-chip.selected').forEach(node => node.classList.remove('selected'));
            [...document.querySelectorAll('.route-child-chip')]
                .find(node => node.dataset.routePath === routeCardDragState.key)
                ?.classList.add('selected');
        }

        document.body.classList.add('route-card-dragging');
    }

    if (routeCardDragState.dragging) {
        updateRouteCardDropTarget(event);
        event.preventDefault();
    }
}

function handleRouteCardPointerUp(event) {
    if (routeCardSelectionBoxState) {
        finishRouteCardSelectionBox();
        return;
    }

    if (!routeCardDragState || routeCardDragState.pointerId !== event.pointerId) return;

    const state = routeCardDragState;
    const dropTarget = routeCardDropTarget;
    routeCardDragState = null;
    routeCardDropTarget = null;
    document.body.classList.remove('route-card-dragging');
    clearRouteCardDropIndicator();

    if (state.dragging && dropTarget) {
        routeCardSuppressNextClickKey = state.key;
        moveRouteCardSelectedGroup(dropTarget.parentPath, dropTarget.targetIndex);
        event.preventDefault();
        event.stopPropagation();
    } else if (state.dragging) {
        routeCardSuppressNextClickKey = state.key;
    }
}

function handleRouteCardPointerCancel() {
    routeCardDragState = null;
    routeCardDropTarget = null;
    document.body.classList.remove('route-card-dragging');
    clearRouteCardDropIndicator();
    cancelRouteCardSelectionBox();
}

function updateRouteCardDropTarget(event) {
    const targetChip = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.route-child-chip');

    if (!targetChip) {
        clearRouteCardDropIndicator();
        routeCardDropTarget = null;
        return;
    }

    const targetPath = parseRouteCardPathKey(targetChip.dataset.routePath || '');
    const parentPath = routeCardParentPath(targetPath);

    if (!routeCardDragState || routeCardPathKey(parentPath) !== routeCardPathKey(routeCardDragState.parentPath)) {
        clearRouteCardDropIndicator();
        routeCardDropTarget = null;
        return;
    }

    const rect = targetChip.getBoundingClientRect();
    const targetIndex = targetPath[targetPath.length - 1] + (event.clientX > rect.left + rect.width / 2 ? 1 : 0);

    routeCardDropTarget = { parentPath, targetIndex };
    showRouteCardDropIndicator(targetChip, targetIndex > targetPath[targetPath.length - 1] ? 'after' : 'before');
}

function showRouteCardDropIndicator(chip, position) {
    document.querySelectorAll('.route-child-chip.drop-before, .route-child-chip.drop-after')
        .forEach(node => node.classList.remove('drop-before', 'drop-after'));

    chip.classList.add(position === 'after' ? 'drop-after' : 'drop-before');
}

function clearRouteCardDropIndicator() {
    document.querySelectorAll('.route-child-chip.drop-before, .route-child-chip.drop-after')
        .forEach(node => node.classList.remove('drop-before', 'drop-after'));
}

function startRouteCardSelectionBox(event, zone) {
    if (event.button !== 0) return;

    const box = document.createElement('div');
    box.className = 'route-card-selection-box';
    document.body.appendChild(box);

    routeCardSelectionBoxState = {
        pointerId: event.pointerId,
        zone,
        startX: event.clientX,
        startY: event.clientY,
        box
    };

    try {
        zone.setPointerCapture?.(event.pointerId);
    } catch (e) {}

    updateRouteCardSelectionBox(event);
}

function updateRouteCardSelectionBox(event) {
    const state = routeCardSelectionBoxState;
    if (!state) return;

    const left = Math.min(state.startX, event.clientX);
    const top = Math.min(state.startY, event.clientY);
    const width = Math.abs(event.clientX - state.startX);
    const height = Math.abs(event.clientY - state.startY);

    state.box.style.left = `${left}px`;
    state.box.style.top = `${top}px`;
    state.box.style.width = `${width}px`;
    state.box.style.height = `${height}px`;

    const boxRect = state.box.getBoundingClientRect();
    const chips = [...state.zone.querySelectorAll('.route-child-chip')];

    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) {
        routeCardSelectedPathKeys.clear();
    }

    chips.forEach(chip => {
        const rect = chip.getBoundingClientRect();
        const overlaps =
            rect.left < boxRect.right &&
            rect.right > boxRect.left &&
            rect.top < boxRect.bottom &&
            rect.bottom > boxRect.top;

        if (overlaps) {
            routeCardSelectedPathKeys.add(chip.dataset.routePath || '');
            chip.classList.add('selected');
        } else if (!routeCardSelectedPathKeys.has(chip.dataset.routePath || '')) {
            chip.classList.remove('selected');
        }
    });
}

function finishRouteCardSelectionBox() {
    if (!routeCardSelectionBoxState) return;

    routeCardSelectionBoxState.box.remove();
    routeCardSelectionBoxState = null;
    renderFolderMgrTable();
}

function cancelRouteCardSelectionBox() {
    if (routeCardSelectionBoxState?.box) {
        routeCardSelectionBoxState.box.remove();
    }
    routeCardSelectionBoxState = null;
}

function setRouteRulePromptMode(path, mode) {
    const rule = getRouteRuleByPath(path);
    if (!rule || rule.type === 'default') return;

    const text = getRouteRulePromptText(rule);
    syncRouteRulePromptFromText(rule, text, mode);
    renderFolderMgrTable();
}

function renderFolderRuleRows(rules, parentPath, depth) {
    let html = '';

    rules.forEach((rule, index) => {
        const path = [...parentPath, index];
        const pathJson = JSON.stringify(path);
        const container = getRouteRuleContainer(path) || rules;
        const isFirst = index === 0;
        const isLast = index === container.length - 1;
        const indent = depth * 26;

        let upBtn = `<button onclick='moveRule(${pathJson}, -1)' style="background:#3b3b4f; color:#fff; border:none; padding:6px 10px; border-radius:4px; cursor:pointer; margin-right:4px;">▲</button>`;
        let downBtn = `<button onclick='moveRule(${pathJson}, 1)' style="background:#3b3b4f; color:#fff; border:none; padding:6px 10px; border-radius:4px; cursor:pointer; margin-right:6px;">▼</button>`;

        if (isFirst) upBtn = `<span style="display:inline-block; width:32px; margin-right:4px;"></span>`;
        if (isLast) downBtn = `<span style="display:inline-block; width:32px; margin-right:6px;"></span>`;

        if (rule.type === 'default') {
            html += `<tr style="border-bottom:1px solid #2a2a35; background: rgba(0, 184, 148, 0.05);">
                <td style="padding:15px 10px; color:#00b894; font-weight:bold; font-size:15px;">📁 기본 분류 (Solo / Duo / Group)</td>
                <td style="padding:15px 10px; color:#666; font-size:13px;">위 규칙에 매칭되지 않으면 인원 수 기준으로 분리합니다.</td>
                <td style="padding:15px 10px; font-size:13px; color:#00b894; font-weight:bold;">종결</td>
                <td style="padding:15px 10px; text-align:center;">
                    ${upBtn}${downBtn}
                    <button disabled style="background:#222; color:#555; border:1px solid #333; padding:6px 12px; border-radius:6px; font-size:12px; font-weight:bold;">기본값</button>
                </td>
            </tr>`;
            return;
        }

        const condition = rule.condition === 'all' ? 'all' : 'any';
        const matchCount = Math.max(1, parseInt(rule.match_count || 1, 10) || 1);
        const childCount = Array.isArray(rule.children) ? rule.children.length : 0;

        html += `<tr style="border-bottom:1px solid #2a2a35; background:${depth ? '#151522' : '#1a1a24'};">
            <td style="padding:10px;">
                <div style="padding-left:${indent}px; display:flex; align-items:center; gap:6px;">
                    <span style="color:${depth ? '#74b9ff' : '#a29bfe'}; font-weight:bold;">${depth ? '↳' : '📁'}</span>
                    <input value="${escapeRouteHtml(rule.folder)}"
                           onchange='updateRouteRuleField(${pathJson}, "folder", this.value)'
                           style="width:100%; background:#222230; border:1px solid #3b3b4f; color:#fff; padding:8px; border-radius:6px; font-weight:bold;">
                </div>
            </td>
            <td style="padding:10px;">
                ${renderRouteTagEditor(pathJson, rule, depth)}
                ${childCount ? `<div style="margin-top:6px; color:#74b9ff; font-size:11px; font-weight:bold;">하위 규칙 ${childCount}개</div>` : ''}
            </td>
            <td style="padding:10px;">
                <select onchange='updateRouteRuleField(${pathJson}, "condition", this.value)'
                        style="width:100%; background:#222230; border:1px solid #3b3b4f; color:#fff; padding:7px; border-radius:6px; margin-bottom:6px;">
                    <option value="any" ${condition === 'any' ? 'selected' : ''}>지정 개수 이상</option>
                    <option value="all" ${condition === 'all' ? 'selected' : ''}>전체 일치</option>
                </select>
                <input type="number"
                       min="1"
                       value="${matchCount}"
                       onchange='updateRouteRuleField(${pathJson}, "match_count", this.value)'
                       ${condition === 'all' ? 'disabled' : ''}
                       style="width:100%; background:#222230; border:1px solid #3b3b4f; color:#00f2ff; padding:7px; border-radius:6px; text-align:center; font-weight:bold;">
            </td>
            <td style="padding:10px; text-align:center;">
                <div style="display:flex; flex-wrap:wrap; gap:5px; justify-content:center;">
                    ${upBtn}${downBtn}
                    <button onclick='addChildFolderRule(${pathJson})'
                            style="background:#0984e3; color:#fff; border:none; padding:6px 9px; border-radius:6px; cursor:pointer; font-size:12px; font-weight:bold;">+하위</button>
                    <button onclick='deleteFolderRule(${pathJson})'
                            style="background:#d63031; color:#fff; border:none; padding:6px 9px; border-radius:6px; cursor:pointer; font-size:12px; font-weight:bold;">삭제</button>
                </div>
            </td>
        </tr>`;

        if (Array.isArray(rule.children) && rule.children.length) {
            html += renderFolderRuleRows(rule.children, path, depth + 1);
        }
    });

    return html;
}

function updateRouteRuleField(path, field, value) {
    const rule = getRouteRuleByPath(path);
    if (!rule || rule.type === 'default') return;

    if (field === 'match_count') {
        rule.match_count = Math.max(1, parseInt(value || 1, 10) || 1);
    } else if (field === 'condition') {
        rule.condition = value === 'all' ? 'all' : 'any';
        renderFolderMgrTable();
    } else if (field === 'folder') {
        rule.folder = String(value || '').trim();
    }
}

function updateRouteRuleTags(path, value) {
    const rule = getRouteRuleByPath(path);
    if (!rule || rule.type === 'default') return;

    syncRouteRulePromptFromText(rule, value, getRouteRulePromptMode(rule));
}

function moveRule(path, dir) {
    const container = getRouteRuleContainer(path);
    if (!container) return;

    const index = path[path.length - 1];
    const next = index + dir;

    if (next < 0 || next >= container.length) return;

    const temp = container[index];
    container[index] = container[next];
    container[next] = temp;

    renderFolderMgrTable();
}

function addFolderRule() {
    const folderInput = document.getElementById('ruleFolderName');
    const tagsInput = document.getElementById('ruleTags');
    const condInput = document.getElementById('ruleCondition');
    const countInput = document.getElementById('ruleMatchCount');

    const folder = folderInput.value.trim();
    const promptMode = getSafeRoutePromptMode(newRouteRulePromptMode);
    const rawPromptText = cleanRoutePromptRawText(tagsInput.dataset.promptText || tagsInput.value || '');
    const tags = parseRouteTags(rawPromptText);
    const tagGroups = parseRouteTagGroups(rawPromptText);

    const condition = condInput.value === 'all' ? 'all' : 'any';
    const matchCount = Math.max(1, parseInt(countInput.value || 1, 10) || 1);

    if (!folder || (!rawPromptText && !tags.length && !tagGroups.length)) {
        return alert("이동할 폴더 이름과 감지 프롬프트를 모두 입력해주세요!");
    }

    const newRule = {
        type: 'custom',
        folder,
        prompt_text: rawPromptText,
        tags,
        prompt_mode: promptMode,
        tag_groups: tagGroups,
        condition,
        match_count: matchCount,
        children: []
    };

    const parentPath = Array.isArray(pendingRouteRuleParentPath)
        ? [...pendingRouteRuleParentPath]
        : null;

    if (parentPath) {
        const parentRule = getRouteRuleByPath(parentPath);

        if (!parentRule || parentRule.type === 'default') {
            alert('하위 규칙을 추가할 부모 규칙을 찾을 수 없습니다.');
            clearRouteRuleAddTarget();
            return;
        }

        if (!Array.isArray(parentRule.children)) {
            parentRule.children = [];
        }

        parentRule.children.push(newRule);
        routeTreeExpandedPathKeys.add(routeTreePathKey(parentPath));
        routeCardExpandedPathKeys.add(routeCardPathKey(parentPath));
        clearRouteRuleAddTarget();
    } else {
        const defaultIndex = customRules.findIndex(r => r.type === 'default');

        if (defaultIndex > -1) customRules.splice(defaultIndex, 0, newRule);
        else customRules.push(newRule);
    }

    folderInput.value = '';
    tagsInput.value = '';
    delete tagsInput.dataset.promptText;
    newRouteRulePromptMode = 'single';
    countInput.value = '1';
    condInput.value = 'any';
    updateRouteModeButtons(activeRouteTagEditMode);
    toggleMatchCount();
    renderFolderMgrTable();
}

function addChildFolderRule(parentPath) {
    const parentRule = getRouteRuleByPath(parentPath);
    if (!parentRule || parentRule.type === 'default') return;

    if (!Array.isArray(parentRule.children)) {
        parentRule.children = [];
    }

    parentRule.children.push({
        type: 'custom',
        folder: '새 하위 폴더',
        prompt_text: '',
        tags: [],
        prompt_mode: 'single',
        tag_groups: [],
        condition: 'any',
        match_count: 1,
        children: []
    });

    routeCardExpandedPathKeys.add(routeCardPathKey(parentPath));
    expandRouteTreePath(parentPath);
    renderFolderMgrTable();

    setTimeout(() => {
        const rows = document.querySelectorAll('#folderMgrTableContainer input');
        const lastInput = rows[rows.length - 1];
        if (lastInput) {
            lastInput.focus();
            lastInput.select();
        }
    }, 0);
}

function routeRuleHasPrompts(rule) {
    const promptMode = rule?.prompt_mode;
    const tags = parseRouteTags(rule?.tags || []);
    const tagGroups = parseRouteTagGroups(rule?.tag_groups || []);

    if (promptMode === 'single') {
        return tags.length > 0;
    }

    if (promptMode === 'group') {
        return tagGroups.some(group => Array.isArray(group) && group.length > 0);
    }

    return tags.length > 0 || tagGroups.some(group => Array.isArray(group) && group.length > 0);
}

function deleteFolderRule(path) {
    const container = getRouteRuleContainer(path);
    if (!container) return;

    const index = path[path.length - 1];
    const rule = container[index];

    if (!rule || rule.type === 'default') return;

    const childCount = Array.isArray(rule.children) ? rule.children.length : 0;
    const ok = childCount
        ? confirm(`'${rule.folder}' 규칙과 하위 규칙 ${childCount}개를 삭제할까요?`)
        : confirm(`'${rule.folder}' 규칙을 삭제할까요?`);

    if (!ok) return;

    container.splice(index, 1);
    cleanupRouteTreeExpandedKeys();
    renderFolderMgrTable();
}

function showFolderRuleNotice(title, message, type = 'success', onClose = null) {
    const old = document.getElementById('folderRuleNoticeLayer');
    if (old) old.remove();

    const color = type === 'error' ? '#ff6b6b' : '#0984e3';
    const icon = type === 'error' ? '⚠️' : '✅';

    const layer = document.createElement('div');
    layer.id = 'folderRuleNoticeLayer';
    layer.style.cssText = `
        position: fixed;
        inset: 0;
        z-index: 9000;
        background: rgba(0,0,0,0.72);
        display: flex;
        align-items: center;
        justify-content: center;
    `;

    layer.innerHTML = `
        <div style="
            width: 420px;
            max-width: calc(100vw - 40px);
            background: #1a1a24;
            border: 1px solid ${color};
            border-radius: 16px;
            box-shadow: 0 18px 60px rgba(0,0,0,0.75), 0 0 24px ${color}33;
            overflow: hidden;
        ">
            <div style="
                padding: 18px 22px;
                background: #121218;
                border-bottom: 1px solid #2a2a35;
                display: flex;
                align-items: center;
                gap: 10px;
            ">
                <span style="font-size:22px;">${icon}</span>
                <div style="font-size:17px; font-weight:900; color:${color};">${escapeRouteHtml(title)}</div>
            </div>

            <div style="
                padding: 22px;
                color: #ddd;
                font-size: 14px;
                line-height: 1.7;
                white-space: pre-line;
            ">${escapeRouteHtml(message)}</div>

            <div style="
                padding: 14px 22px 20px;
                display: flex;
                justify-content: flex-end;
                background: #161625;
            ">
                <button id="folderRuleNoticeOkBtn"
                        style="
                            background:${color};
                            color:#fff;
                            border:none;
                            padding:10px 24px;
                            border-radius:999px;
                            font-weight:900;
                            cursor:pointer;
                            box-shadow:0 6px 18px ${color}55;
                        ">
                    확인
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(layer);

    const close = () => {
        layer.remove();
        if (typeof onClose === 'function') onClose();
    };

    layer.querySelector('#folderRuleNoticeOkBtn').onclick = close;
}

function findInvalidRouteRules(rules, pathLabel = '') {
    const invalid = [];

    (Array.isArray(rules) ? rules : []).forEach((rule, index) => {
        if (!rule || rule.type === 'default') return;

        const label = pathLabel
            ? `${pathLabel} > ${rule.folder || '(폴더명 없음)'}`
            : `${rule.folder || '(폴더명 없음)'}`;

        if (!String(rule.folder || '').trim()) {
            invalid.push(`${label}: 폴더명이 비어 있습니다.`);
        }

        if (!routeRuleHasPrompts(rule)) {
            invalid.push(`${label}: 감지 프롬프트 / 태그가 비어 있습니다.`);
        }

        if (Array.isArray(rule.children) && rule.children.length) {
            invalid.push(...findInvalidRouteRules(rule.children, label));
        }
    });

    return invalid;
}

function openRouteRuleTester() {
    populateRouteTestRuleChecklist();
    document.getElementById('routeRuleTestLayer').style.display = 'flex';
    setRouteTestTarget(routeTestTarget || 'all');
    renderRouteTestMessage('현재 화면의 규칙으로 테스트합니다. 실제 파일은 이동하지 않습니다.');
}

function closeRouteRuleTester() {
    const layer = document.getElementById('routeRuleTestLayer');
    if (layer) layer.style.display = 'none';
}

function setRouteTestTarget(target) {
    routeTestTarget = ['all', 'single', 'prompt'].includes(target) ? target : 'all';

    document.getElementById('routeTestTargetAllBtn')?.classList.toggle('active', routeTestTarget === 'all');
    document.getElementById('routeTestTargetSingleBtn')?.classList.toggle('active', routeTestTarget === 'single');
    document.getElementById('routeTestTargetPromptBtn')?.classList.toggle('active', routeTestTarget === 'prompt');

    const checklistWrap = document.getElementById('routeTestRuleChecklistWrap');
    if (checklistWrap) {
        checklistWrap.style.display = routeTestTarget === 'single' ? 'block' : 'none';
    }

    const promptPane = document.getElementById('routeTestPromptRulePane');
    if (promptPane) {
        promptPane.style.display = routeTestTarget === 'prompt' ? 'block' : 'none';
    }

    if (routeTestTarget === 'single') {
        populateRouteTestRuleChecklist();
    }

    if (routeTestTarget === 'prompt') {
        updateRouteTestPromptModeButtons();
    }

    const inputModeSection = document.getElementById('routeTestInputModeSection');
    if (inputModeSection) inputModeSection.style.display = 'block';

    setRouteTestTab(routeTestTab || 'image');
}

function setRouteTestTab(tab) {
    routeTestTab = tab === 'folder' ? 'folder' : 'image';

    document.getElementById('routeTestTabImageBtn')?.classList.toggle('active', routeTestTab === 'image');
    document.getElementById('routeTestTabFolderBtn')?.classList.toggle('active', routeTestTab === 'folder');

    const imagePane = document.getElementById('routeTestImagePane');
    const folderPane = document.getElementById('routeTestFolderPane');

    if (imagePane) imagePane.style.display = routeTestTab === 'image' ? 'block' : 'none';
    if (folderPane) folderPane.style.display = routeTestTab === 'folder' ? 'block' : 'none';

    if (routeTestTab === 'image') {
        renderRouteTestSelectedImages();
    }
}

function flattenRouteRulesForSelect(rules = customRules, parentLabel = '', parentPath = []) {
    const rows = [];
    (Array.isArray(rules) ? rules : []).forEach((rule, index) => {
        if (!rule || rule.type === 'default') return;
        const folder = String(rule.folder || '(폴더명 없음)');
        const label = parentLabel ? `${parentLabel} > ${folder}` : folder;
        const path = [...parentPath, index];
        rows.push({ path, label, folder });
        rows.push(...flattenRouteRulesForSelect(rule.children || [], label, path));
    });
    return rows;
}

function getRoutePathKey(path) {
    return JSON.stringify(Array.isArray(path) ? path : []);
}

function populateRouteTestRuleChecklist() {
    const box = document.getElementById('routeTestRuleChecklist');
    if (!box) return;
    const rows = flattenRouteRulesForSelect(customRules);
    const selectedKeys = new Set(routeTestSelectedRulePaths.map(getRoutePathKey));

    if (!rows.length) {
        box.innerHTML = '<div class="route-test-empty">선택할 규칙이 없습니다.</div>';
        return;
    }

    box.innerHTML = rows.map(row => {
        const pathJson = JSON.stringify(row.path);
        const safeKey = routeTestRulePathDomKey(row.path);
        const checked = selectedKeys.has(pathJson) ? 'checked' : '';
        return `
            <label class="route-test-rule-check-item">
                <input type="checkbox"
                       value='${escapeRouteHtml(pathJson)}'
                       ${checked}
                       onchange='toggleRouteTestRuleSelection(${escapeRouteHtml(JSON.stringify(pathJson))}, this.checked)'>
                <span class="route-test-rule-check-name">${escapeRouteHtml(row.label)}</span>
                <button type="button"
                        class="route-test-rule-prompt-btn"
                        onclick='toggleRouteTestRulePromptPreview(event, ${escapeRouteHtml(JSON.stringify(pathJson))})'>
                    프롬프트 보기
                </button>
            </label>
            <div id="route-test-rule-preview-${safeKey}" class="route-test-rule-preview" style="display:none;"></div>
        `;
    }).join('');
}

function routeTestRulePathDomKey(path) {
    return String(getRoutePathKey(path)).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getRouteRulePromptPreviewHtml(rule, label = '') {
    if (!rule || rule.type === 'default') return '<div class="route-test-empty">규칙 정보가 없습니다.</div>';

    const mode = getRouteRulePromptMode(rule);
    const text = getRouteRulePromptText(rule);

    return `
        <div><b>규칙:</b> ${escapeHtml(label || rule.folder || '(이름 없음)')}</div>
        <div><b>모드:</b> ${mode === 'group' ? '묶음' : '개별'}</div>
        <pre>${escapeHtml(text || '(프롬프트 없음)')}</pre>
    `;
}

function toggleRouteTestRulePromptPreview(event, pathJson) {
    event.preventDefault();
    event.stopPropagation();

    let path = [];
    try { path = JSON.parse(pathJson); } catch (e) { path = []; }

    const rule = getRouteRuleByPath(path);
    const safeKey = routeTestRulePathDomKey(path);
    const box = document.getElementById(`route-test-rule-preview-${safeKey}`);
    if (!box) return;

    const nextOpen = box.style.display !== 'block';
    box.style.display = nextOpen ? 'block' : 'none';

    if (nextOpen) {
        const row = flattenRouteRulesForSelect(customRules).find(item => getRoutePathKey(item.path) === getRoutePathKey(path));
        box.innerHTML = getRouteRulePromptPreviewHtml(rule, row?.label || '');
    }
}

function toggleRouteTestRuleSelection(pathJson, checked) {
    let path = [];
    try { path = JSON.parse(pathJson); } catch (e) { path = []; }
    const key = getRoutePathKey(path);
    const map = new Map(routeTestSelectedRulePaths.map(item => [getRoutePathKey(item), item]));
    if (checked) map.set(key, path);
    else map.delete(key);
    routeTestSelectedRulePaths = [...map.values()];
    populateRouteTestRuleChecklist();
}

function setAllRouteTestRulesChecked(checked) {
    const rows = flattenRouteRulesForSelect(customRules);
    routeTestSelectedRulePaths = checked ? rows.map(row => row.path) : [];
    populateRouteTestRuleChecklist();
}

function getSelectedRouteTestRulePaths() {
    return routeTestTarget === 'single' ? routeTestSelectedRulePaths : [];
}

function getSelectedRouteTestRulePath() {
    return getSelectedRouteTestRulePaths()[0] || [];
}

function getRouteTestPayloadBase() {
    const rulePaths = getSelectedRouteTestRulePaths();
    return {
        rules: getCurrentRulesForRouteTest(),
        target_mode: routeTestTarget,
        scope: routeTestTarget === 'single' ? 'single' : 'all',
        rule_path: rulePaths[0] || [],
        rule_paths: rulePaths,
        prompt_rule_text: routeTestTarget === 'prompt' ? getRouteTestPromptRuleText() : '',
        prompt_rule_mode: routeTestPromptMode
    };
}

function getRouteTestGuardMessage() {
    if (routeTestTarget === 'single' && !getSelectedRouteTestRulePaths().length) {
        return '특정 규칙 테스트는 규칙을 하나 이상 선택해야 합니다.';
    }

    if (routeTestTarget === 'prompt' && !getRouteTestPromptRuleText().trim()) {
        return '프롬프트 입력 테스트는 임시 감지 규칙을 입력해야 합니다.';
    }

    if (routeTestTab === 'image' && !routeTestSelectedImageFiles.length) {
        return '테스트할 이미지를 선택하거나 끌어오세요.';
    }

    if (routeTestTab === 'folder' && !routeTestSelectedFolderPath) {
        return '테스트할 폴더를 선택하세요.';
    }

    return '';
}

function getCurrentRulesForRouteTest() {
    return normalizeRouteRuleList(customRules);
}

function renderRouteTestMessage(message) {
    const box = document.getElementById('routeTestResult');
    if (box) box.innerHTML = `<div class="route-test-empty">${escapeHtml(message)}</div>`;
}

async function runRouteRuleTest() {
    const guard = getRouteTestGuardMessage();
    if (guard) return renderRouteTestMessage(guard);
    if (routeTestTab === 'folder') return runRouteRuleFolderTest();
    return runRouteRuleImageTest();
}

async function postRouteTestJson(url, payload) {
    const res = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.status === 'error') throw new Error(data.message || '테스트 실패');
    return data;
}

function setRouteTestPromptMode(mode) {
    routeTestPromptMode = mode === 'group' ? 'group' : 'single';
    updateRouteTestPromptModeButtons();
}

function updateRouteTestPromptModeButtons() {
    document.getElementById('routeTestPromptSingleBtn')?.classList.toggle('active', routeTestPromptMode === 'single');
    document.getElementById('routeTestPromptGroupBtn')?.classList.toggle('active', routeTestPromptMode === 'group');

    const hint = document.getElementById('routeTestPromptModeHint');
    const textarea = document.getElementById('routeTestPromptText');

    if (hint) {
        hint.innerText = routeTestPromptMode === 'group'
            ? '묶음: Enter 한 줄이 하나의 조건입니다. 한 줄 안의 콤마 항목은 모두 포함되어야 통과합니다.'
            : '개별: 콤마와 Enter로 나눈 항목 중 지정 개수 이상 일치하면 통과합니다.';
    }

    if (textarea) {
        textarea.classList.toggle('route-group-mode', routeTestPromptMode === 'group');
        textarea.classList.toggle('route-single-mode', routeTestPromptMode !== 'group');
    }
}

function getRouteTestPromptRuleText() {
    return document.getElementById('routeTestPromptText')?.value || '';
}

function handleRouteTestImageDragOver(event) {
    event.preventDefault();
    event.stopPropagation();
    document.getElementById('routeTestImageDropZone')?.classList.add('drag-over');
}

function handleRouteTestImageDragLeave(event) {
    event.preventDefault();
    event.stopPropagation();
    document.getElementById('routeTestImageDropZone')?.classList.remove('drag-over');
}

function handleRouteTestImageDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    document.getElementById('routeTestImageDropZone')?.classList.remove('drag-over');
    const files = [...(event.dataTransfer?.files || [])].filter(file => file.type.startsWith('image/'));
    if (files.length) {
        handleRouteTestImageFiles(files);
    }
}

function handleRouteTestImageFiles(fileList) {
    const files = [...(fileList || [])].filter(file => file && file.type && file.type.startsWith('image/'));
    if (!files.length) return;
    const existing = new Set(routeTestSelectedImageFiles.map(file => `${file.name}|${file.size}|${file.lastModified}`));
    files.forEach(file => {
        const key = `${file.name}|${file.size}|${file.lastModified}`;
        if (!existing.has(key)) {
            routeTestSelectedImageFiles.push(file);
            existing.add(key);
        }
    });
    renderRouteTestSelectedImages();
}

function removeRouteTestSelectedImage(kind, index) {
    if (kind === 'file') {
        const file = routeTestSelectedImageFiles[index];
        revokeRouteTestImagePreviewUrl(file);
        routeTestSelectedImageFiles.splice(index, 1);
    }
    renderRouteTestSelectedImages();
}

function clearRouteTestImages() {
    revokeRouteTestImagePreviewUrls();
    routeTestSelectedImageFiles = [];
    renderRouteTestSelectedImages();
}

function renderRouteTestSelectedImages() {
    const box = document.getElementById('routeTestSelectedImages');
    if (!box) return;
    const chips = [];
    routeTestSelectedImageFiles.forEach((file, index) => {
        chips.push(`<span class="route-test-selected-chip">파일: ${escapeHtml(file.name)}<button type="button" onclick="removeRouteTestSelectedImage('file', ${index})">×</button></span>`);
    });
    box.innerHTML = chips.length ? chips.join('') : '<div class="route-test-empty">선택한 이미지가 없습니다.</div>';
}

async function pickRouteTestFolder() {
    try {
        renderRouteTestMessage('폴더 선택 창을 여는 중입니다...');

        const res = await fetch('/api/route_test/folder/pick', {
            method: 'POST'
        });
        const data = await res.json();

        if (!res.ok || data.status !== 'success') {
            throw new Error(data.message || '폴더 선택 실패');
        }

        routeTestSelectedFolderPath = data.folder_path || '';

        const label = document.getElementById('routeTestSelectedFolderLabel');
        const meta = document.getElementById('routeTestSelectedFolderMeta');

        if (label) label.innerText = data.folder_name || routeTestSelectedFolderPath || '선택 안 함';
        if (meta) meta.innerText = routeTestSelectedFolderPath || '폴더 경로 없음';

        renderRouteTestMessage('폴더를 선택했습니다. 테스트 실행을 눌러주세요.');
    } catch (e) {
        renderRouteTestMessage(e.message || String(e));
    }
}

async function runRouteRuleTextTest() {
    const prompt = getRouteTestPromptRuleText();
    if (!prompt.trim()) return renderRouteTestMessage('테스트할 프롬프트를 입력하세요.');
    renderRouteTestMessage('프롬프트 테스트 중입니다...');
    try {
        renderRouteTestResult(await postRouteTestJson('/api/route_test/text', {
            ...getRouteTestPayloadBase(),
            prompt
        }));
    } catch (e) {
        renderRouteTestMessage(e.message);
    }
}

async function runRouteRuleImageTest() {
    if (!routeTestSelectedImageFiles.length) {
        return renderRouteTestMessage('테스트할 이미지를 선택하거나 끌어오세요.');
    }

    renderRouteTestMessage('이미지 프롬프트를 읽는 중입니다...');
    try {
        const combinedResults = await runRouteTestFileUploadBatches(routeTestSelectedImageFiles, {
            batchSize: 40,
            renderProgress: false
        });

        renderRouteTestResult({
            status: 'success',
            input_type: 'images',
            target_mode: routeTestTarget,
            results: combinedResults
        });
    } catch (e) {
        renderRouteTestMessage(e.message);
    }
}

async function runRouteTestFileUploadBatches(files, options = {}) {
    const batchSize = Math.max(1, Number(options.batchSize || 40));
    const onlyUnmatched = Boolean(options.onlyUnmatched);
    const renderProgress = options.renderProgress !== false;
    const payloadBase = getRouteTestPayloadBase();
    const allResults = [];

    for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        const form = new FormData();
        form.append('rules', JSON.stringify(payloadBase.rules));
        form.append('target_mode', payloadBase.target_mode);
        form.append('scope', payloadBase.scope);
        form.append('rule_path', JSON.stringify(payloadBase.rule_path || []));
        form.append('rule_paths', JSON.stringify(payloadBase.rule_paths || []));
        form.append('prompt_rule_text', payloadBase.prompt_rule_text || '');
        form.append('prompt_rule_mode', payloadBase.prompt_rule_mode || 'single');

        batch.forEach(file => {
            form.append('files', file, file.webkitRelativePath || file.name);
        });

        const res = await fetch('/api/route_test/images_upload', {
            method: 'POST',
            body: form
        });
        const data = await res.json();

        if (data.status === 'error') {
            throw new Error(data.message || '파일 테스트 실패');
        }

        const batchResults = (data.results || []).map((item, index) => ({
            ...item,
            preview_url: item.preview_url || getRouteTestImagePreviewUrl(batch[index])
        }));
        const visibleResults = onlyUnmatched
            ? batchResults.filter(item => !routeTestResultMatched(item.result))
            : batchResults;

        allResults.push(...visibleResults);

        if (renderProgress) {
            renderRouteTestResult({
                status: 'success',
                input_type: 'folder_upload',
                target_mode: routeTestTarget,
                progress_text: `${Math.min(i + batch.length, files.length).toLocaleString()} / ${files.length.toLocaleString()} 처리 중`,
                results: allResults.slice(0, 500)
            });
        }

        await new Promise(resolve => setTimeout(resolve, 0));
    }

    return allResults.slice(0, 500);
}

async function runRouteRuleFolderTest() {
    const guard = getRouteTestGuardMessage();
    if (guard) return renderRouteTestMessage(guard);

    const sampleMode = document.getElementById('routeTestSampleMode')?.value || 'random100';
    if (sampleMode === 'all' && !confirm('전체 검사는 오래 걸릴 수 있습니다. 실제 파일은 이동하지 않고 프롬프트만 읽습니다. 계속할까요?')) return;

    renderRouteTestMessage('폴더 테스트를 시작합니다...');

    try {
        const data = await postRouteTestJson('/api/route_test/folder/start', {
            ...getRouteTestPayloadBase(),
            folder_path: routeTestSelectedFolderPath,
            include_subfolders: Boolean(document.getElementById('routeTestIncludeSubfolders')?.checked),
            sample_mode: sampleMode,
            only_unmatched: Boolean(document.getElementById('routeTestOnlyUnmatched')?.checked),
            max_display: 500
        });

        currentRouteFolderTestJobId = data.job_id || '';
        if (currentRouteFolderTestJobId) {
            pollRouteFolderTestJob(currentRouteFolderTestJobId);
        } else {
            renderRouteTestResult(data);
        }
    } catch (e) {
        renderRouteTestMessage(e.message || String(e));
    }
}

async function pollRouteFolderTestJob(jobId) {
    if (!jobId) return;
    try {
        const res = await fetch(`/api/route_test/folder/status/${encodeURIComponent(jobId)}`);
        const data = await res.json();
        if (data.status === 'error') throw new Error(data.message || '상태 조회 실패');
        renderRouteTestResult(data);
        const state = data.job?.state;
        if (state === 'running' || state === 'queued') {
            setTimeout(() => pollRouteFolderTestJob(jobId), 800);
        }
    } catch (e) {
        renderRouteTestMessage(e.message);
    }
}

async function cancelRouteFolderTest() {
    if (!currentRouteFolderTestJobId) return renderRouteTestMessage('진행 중인 폴더 테스트가 없습니다.');
    try {
        await fetch(`/api/route_test/folder/cancel/${encodeURIComponent(currentRouteFolderTestJobId)}`, {
            method: 'POST'
        });
        renderRouteTestMessage('폴더 테스트 중지를 요청했습니다.');
    } catch (e) {
        renderRouteTestMessage(e.message || String(e));
    }
}

function routeTestDetailText(detail) {
    if (!detail) return '';
    const matched = (detail.matched_tags || []).join(', ') || '없음';
    const missing = (detail.missing_tags || []).join(', ') || '없음';
    return `${detail.label || detail.folder || '규칙'}: ${detail.message || ''}<br>찾은 태그: ${escapeHtml(matched)}<br>부족한 태그: ${escapeHtml(missing)}`;
}

function routeTestResultMatched(result) {
    return Boolean(result?.matched || result?.default_reached);
}

function getRouteTestTargetModeFromMeta(meta = {}) {
    return meta.target_mode || meta.targetMode || routeTestTarget || 'all';
}

function getRouteTestResultMainLabel(result, meta = {}) {
    const targetMode = getRouteTestTargetModeFromMeta(meta);

    if (targetMode === 'prompt' || result?.scope === 'prompt') {
        return '임시 규칙 매칭 결과';
    }

    if (targetMode === 'single' || result?.scope === 'single' || Array.isArray(result?.selected_results)) {
        return '선택 규칙 결과';
    }

    return '예상 이동 폴더';
}

function getRouteTestSelectedSummary(result) {
    const selectedResults = Array.isArray(result?.selected_results) ? result.selected_results : [];
    const jobCount = Number(result?.job_count || selectedResults.length || 0);
    const matchedCount = selectedResults.filter(item => item.matched).length;
    return `검사 조합 ${jobCount}개 중 ${matchedCount}개 매칭`;
}

function getRouteTestSelectedSubSummary(result) {
    const selectedResults = Array.isArray(result?.selected_results) ? result.selected_results : [];
    const selectedCount = Number(result?.selected_rule_count || 0);
    const jobCount = Number(result?.job_count || selectedResults.length || 0);

    if (selectedCount > 0 && jobCount > 0 && selectedCount !== jobCount) {
        return `선택한 규칙 ${selectedCount}개 → 검사 조합 ${jobCount}개`;
    }

    if (selectedCount > 0) {
        return `선택한 규칙 ${selectedCount}개`;
    }

    return '';
}

function getRouteTestResultMainValue(result, meta = {}) {
    const targetMode = getRouteTestTargetModeFromMeta(meta);

    if (targetMode === 'prompt' || result?.scope === 'prompt') {
        return routeTestResultMatched(result) ? '매칭됨' : '매칭 안 됨';
    }

    if (Array.isArray(result?.selected_results)) {
        return getRouteTestSelectedSummary(result);
    }

    if (targetMode === 'single' || result?.scope === 'single') {
        return result?.rule_label || (result?.rule_chain || []).join(' > ') || result?.final_folder || '선택 규칙';
    }

    if (result?.final_folder) return result.final_folder;
    if (result?.default_reached) return 'Solo / Duo / Group';
    return '매칭 없음';
}

function routeTestRuleReasonText(result) {
    if (!result) return '';
    if (Array.isArray(result.selected_results)) {
        return getRouteTestSelectedSummary(result);
    }
    return (result.details || [])
        .map(detail => detail.message || '')
        .filter(Boolean)
        .join(' / ');
}

function collectRouteTestMatchedDetails(result) {
    const details = [];

    function addDetail(detail, labelPrefix = '') {
        if (!detail) return;
        if (detail.matched || (detail.matched_tags && detail.matched_tags.length)) {
            details.push({
                label: labelPrefix || detail.rule_label || detail.label || detail.folder || '규칙',
                message: detail.message || '',
                matched_tags: detail.matched_tags || [],
                missing_tags: detail.missing_tags || [],
                groups: detail.groups || []
            });
        }
    }

    if (Array.isArray(result?.selected_results)) {
        result.selected_results.forEach(item => {
            if (item.type === 'chain') {
                (item.details || []).forEach(chainItem => {
                    const inner = (chainItem.details || [chainItem]).find(Boolean) || chainItem;
                    addDetail(inner, chainItem.rule_label || item.rule_label || '선택 규칙');
                });
            } else {
                const inner = (item.details || [item]).find(Boolean) || item;
                addDetail(inner, item.rule_label || item.final_folder || '선택 규칙');
            }
        });
        return details;
    }

    (result?.details || []).forEach(detail => addDetail(detail));
    return details;
}

function renderRouteTestReasonBlock(result) {
    const matchedDetails = collectRouteTestMatchedDetails(result);

    if (!matchedDetails.length) {
        const missing = [];
        const addMissing = detail => (detail?.missing_tags || []).forEach(tag => missing.push(tag));

        if (Array.isArray(result?.selected_results)) {
            result.selected_results.forEach(item => {
                if (item.type === 'chain') {
                    (item.details || []).forEach(chainItem => (chainItem.details || [chainItem]).forEach(addMissing));
                } else {
                    (item.details || [item]).forEach(addMissing);
                }
            });
        } else if (Array.isArray(result?.details)) {
            result.details.forEach(addMissing);
        }

        return `
            <div class="route-test-reason-block">
                <b>매칭 이유</b>
                <div class="route-test-empty">통과한 조건이 없습니다.</div>
                ${missing.length ? `<div class="route-test-missing-tags">부족한 태그: ${escapeHtml([...new Set(missing)].join(', '))}</div>` : ''}
            </div>
        `;
    }

    const rows = matchedDetails.map(detail => {
        const matchedTags = detail.matched_tags?.length
            ? detail.matched_tags.map(tag => `<span class="route-test-hit-chip">${escapeHtml(tag)}</span>`).join('')
            : '<span class="route-test-empty">표시할 태그 없음</span>';

        return `
            <div class="route-test-reason-item">
                <div class="route-test-reason-title">${escapeHtml(detail.label)}</div>
                <div class="route-test-reason-message">${escapeHtml(detail.message || '조건이 통과했습니다.')}</div>
                <div class="route-test-hit-row">${matchedTags}</div>
            </div>
        `;
    }).join('');

    return `
        <div class="route-test-reason-block">
            <b>매칭 이유</b>
            ${rows}
        </div>
    `;
}

function toggleRouteTestPromptPreview(button) {
    const wrap = button?.closest?.('.route-test-prompt-preview') || button?.closest?.('.route-test-item-card') || button?.closest?.('.route-test-result');
    const body = wrap?.querySelector?.('.route-test-prompt-body');
    if (!body) return;

    const isOpen = body.style.display === 'block';
    body.style.display = isOpen ? 'none' : 'block';
    button.innerText = isOpen ? '프롬프트 보기' : '프롬프트 접기';
}

function openRouteTestImagePreview(src, title = '') {
    if (!src) return;

    let layer = document.getElementById('routeTestImagePreviewLayer');

    if (!layer) {
        layer = document.createElement('div');
        layer.id = 'routeTestImagePreviewLayer';
        layer.className = 'route-test-image-preview-layer';
        layer.innerHTML = `
            <div class="route-test-image-preview-card" onclick="event.stopPropagation()">
                <div class="route-test-image-preview-header">
                    <div id="routeTestImagePreviewTitle" class="route-test-image-preview-title"></div>
                    <button type="button" onclick="closeRouteTestImagePreview()">×</button>
                </div>
                <div class="route-test-image-preview-body">
                    <img id="routeTestImagePreviewImg" alt="" onclick="closeRouteTestImagePreview()">
                </div>
            </div>
        `;
        layer.onclick = closeRouteTestImagePreview;
        document.body.appendChild(layer);
    }

    const img = document.getElementById('routeTestImagePreviewImg');
    const titleEl = document.getElementById('routeTestImagePreviewTitle');

    if (img) {
        img.src = src;
        img.alt = title || 'route test image';
    }

    if (titleEl) {
        titleEl.innerText = title || '이미지 미리보기';
    }

    layer.classList.add('show');
}

function closeRouteTestImagePreview() {
    const layer = document.getElementById('routeTestImagePreviewLayer');
    const img = document.getElementById('routeTestImagePreviewImg');

    if (img) img.src = '';
    if (layer) layer.classList.remove('show');
}

function toggleRouteTestItemDetail(button) {
    const card = button?.closest?.('.route-test-item-card');
    const body = card?.querySelector?.('.route-test-item-detail');

    if (!body) return;

    const isOpen = body.style.display === 'block';
    body.style.display = isOpen ? 'none' : 'block';
    button.innerText = isOpen ? '상세보기' : '상세접기';
}

function renderRouteTestItemCard(item, meta = {}) {
    const result = item.result || {};
    const ok = item.status !== 'error' && routeTestResultMatched(result);
    const label = getRouteTestResultMainLabel(result, meta);
    const value = getRouteTestResultMainValue(result, meta);
    const subSummary = getRouteTestSelectedSubSummary(result);
    const promptText = item.prompt_text || item.promptPreview || item.prompt_preview || '';
    const previewUrl = item.preview_url || item.src || '';

    const promptBlock = promptText
        ? `
            <button type="button" class="route-test-small-btn" onclick="toggleRouteTestPromptPreview(this)">프롬프트 보기</button>
            <pre class="route-test-prompt-body" style="display:none;">${escapeHtml(promptText)}</pre>
        `
        : '<div class="route-test-empty">프롬프트 원문이 없습니다.</div>';

    const tokenText = Array.isArray(item.tokens) && item.tokens.length
        ? item.tokens.slice(0, 50).join(', ')
        : '';
    const previewArg = escapeRouteHtml(JSON.stringify(previewUrl));
    const titleArg = escapeRouteHtml(JSON.stringify(item.file_name || item.path || '이미지'));

    return `
        <div class="route-test-item-card compact">
            <div class="route-test-item-main">
                <div class="route-test-item-top">
                    <div class="route-test-item-title-block with-thumb">
                        ${
                            previewUrl
                                ? `
                                    <button type="button"
                                            class="route-test-inline-thumb"
                                            onclick="openRouteTestImagePreview(${previewArg}, ${titleArg})"
                                            title="이미지 미리보기">
                                        <img src="${escapeHtml(previewUrl)}" alt="${escapeHtml(item.file_name || item.path || '이미지')}" loading="lazy">
                                    </button>
                                  `
                                : `
                                    <div class="route-test-inline-thumb empty">
                                        <span>NO IMG</span>
                                    </div>
                                  `
                        }

                        <div class="route-test-title-text">
                            <div class="route-test-item-name">${escapeHtml(item.file_name || item.path || '이미지')}</div>
                            <div class="${ok ? 'route-test-success' : 'route-test-fail'}">
                                ${escapeHtml(item.status === 'error' ? '오류' : (ok ? '매칭' : '실패'))}
                            </div>
                        </div>
                    </div>
                    <div class="route-test-item-destination">
                        <span>${escapeHtml(label)}</span>
                        <b>${escapeHtml(value)}</b>
                        ${subSummary ? `<small>${escapeHtml(subSummary)}</small>` : ''}
                    </div>
                </div>

                <div class="route-test-item-actions">
                    <button type="button" class="route-test-small-btn" onclick="toggleRouteTestItemDetail(this)">상세보기</button>
                </div>

                ${item.message || item.error ? `<div class="route-test-error-text">${escapeHtml(item.message || item.error)}</div>` : ''}

                <div class="route-test-item-detail" style="display:none;">
                    ${renderRouteTestReasonBlock(result)}
                    <div class="route-test-prompt-preview">${promptBlock}</div>
                    ${tokenText ? `<div class="route-test-token-preview">입력 태그: ${escapeHtml(tokenText)}</div>` : ''}
                </div>
            </div>
        </div>
    `;
}

function renderSingleRouteTestResult(data) {
    const result = data.result || {};
    if (Array.isArray(result.selected_results)) {
        const success = Boolean(result.matched);
        const cls = success ? 'route-test-success' : 'route-test-fail';
        const label = getRouteTestResultMainLabel(result, data);
        const value = getRouteTestResultMainValue(result, data);
        const subSummary = getRouteTestSelectedSubSummary(result);

        return `
            <div class="${cls}">${success ? '✅ 조건에 매칭되었습니다' : '❌ 매칭되지 않았습니다'}</div>
            <div style="margin-top:10px;">${escapeHtml(label)}: <b>${escapeHtml(value)}</b></div>
            ${subSummary ? `<div style="margin-top:4px; color:#aaa; font-size:12px;">${escapeHtml(subSummary)}</div>` : ''}
            <div style="margin-top:12px;">${renderRouteTestReasonBlock(result)}</div>
            ${data.tokens ? `<div style="margin-top:12px; color:#aaa; font-size:12px;">입력 태그: ${escapeHtml(data.tokens.slice(0, 80).join(', '))}</div>` : ''}
        `;
    }

    const success = Boolean(result.matched || result.default_reached);
    const targetMode = getRouteTestTargetModeFromMeta(data);
    const title = success
        ? (targetMode === 'all' ? '✅ 라우팅 결과를 찾았습니다' : '✅ 조건에 매칭되었습니다')
        : '❌ 매칭되지 않았습니다';
    const cls = success ? 'route-test-success' : 'route-test-fail';
    const label = getRouteTestResultMainLabel(result, data);
    const value = getRouteTestResultMainValue(result, data);
    const chain = (result.rule_chain || []).join(' > ') || (result.default_reached ? '기본 분류' : '(없음)');
    return `
        <div class="${cls}">${title}</div>
        <div style="margin-top:10px;">${escapeHtml(label)}: <b>${escapeHtml(value)}</b></div>
        ${targetMode === 'all' ? `<div>사용된 규칙: ${escapeHtml(chain)}</div>` : ''}
        <div style="margin-top:12px;">${renderRouteTestReasonBlock(result)}</div>
        ${data.prompt_text ? `<div style="margin-top:12px;"><button type="button" class="route-test-small-btn" onclick="toggleRouteTestPromptPreview(this)">프롬프트 보기</button><pre class="route-test-prompt-body" style="display:none;">${escapeHtml(data.prompt_text)}</pre></div>` : ''}
        ${data.tokens ? `<div style="margin-top:12px; color:#aaa; font-size:12px;">입력 태그: ${escapeHtml(data.tokens.slice(0, 80).join(', '))}</div>` : ''}
    `;
}

function renderRouteTestResultsTable(results, meta = {}) {
    const progress = meta.progress_text
        ? `<div style="margin-bottom:8px;"><b>진행률:</b> ${escapeHtml(meta.progress_text)}</div>`
        : '';
    const resultTitle = meta.input_type === 'folder_upload' || meta.input_type === 'folder'
        ? '폴더 테스트 결과'
        : '이미지 테스트 결과';
    const cards = (results || []).map(item => renderRouteTestItemCard(item, meta)).join('');

    return `
        ${progress}
        <div><b>${resultTitle}:</b> ${(results || []).length}개</div>
        <div class="route-test-card-list">
            ${cards || '<div class="route-test-empty">표시할 결과가 없습니다.</div>'}
        </div>
    `;
}

function renderFolderRouteTestResult(job) {
    const total = job.total_count || 0;
    const processed = job.processed_count || 0;
    const percent = total ? Math.round((processed / total) * 100) : 100;
    const header = `
        <div><b>진행률:</b> ${processed} / ${total} (${percent}%) - ${escapeHtml(job.state || '')}</div>
        <div style="margin-top:6px;">매칭 ${job.matched_count || 0}개 / 실패 ${job.unmatched_count || 0}개 / 오류 ${job.error_count || 0}개</div>
        ${job.warning ? `<div class="route-test-fail" style="margin-top:8px;">${escapeHtml(job.warning)}</div>` : ''}
    `;

    return header + renderRouteTestResultsTable(job.results || [], {
        input_type: 'folder',
        target_mode: job.target_mode || routeTestTarget
    });
}

function renderRouteTestResult(data) {
    const box = document.getElementById('routeTestResult');
    if (!box) return;
    if (Array.isArray(data.results)) {
        box.innerHTML = renderRouteTestResultsTable(data.results, data);
    } else if (data.job) {
        box.innerHTML = renderFolderRouteTestResult(data.job);
    } else {
        box.innerHTML = renderSingleRouteTestResult(data);
    }
}

async function saveFolderRules(options = {}) {
    try {
        const invalidMessages = findInvalidRouteRules(customRules);

        if (invalidMessages.length) {
            showFolderRuleNotice(
                '저장할 수 없습니다',
                invalidMessages.slice(0, 8).join('\n') +
                    (invalidMessages.length > 8 ? `\n외 ${invalidMessages.length - 8}건` : ''),
                'error'
            );
            return;
        }

        customRules = normalizeRouteRuleList(customRules);

        const res = await fetch('/api/save_custom_rules', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ rules: customRules })
        });

        const data = await res.json();

        if (data.status === 'success') {
            setFolderRulesBaseline();
            showFolderRuleNotice(
                '저장 완료',
                '폴더 우선순위 및 정밀 라우팅 규칙이 저장되었습니다.\n기존 규칙 구조는 유지되고, 하위 규칙은 children 안에 저장됩니다.',
                'success',
                options.closeAfterSave === false ? null : forceCloseFolderMgr
            );
        } else {
            showFolderRuleNotice(
                '저장 실패',
                data.message || '서버에서 저장 실패 응답을 받았습니다.',
                'error'
            );
        }
    } catch (e) {
        showFolderRuleNotice(
            '서버 오류',
            e.message || '규칙 저장 중 서버 오류가 발생했습니다.',
            'error'
        );
    }
}

