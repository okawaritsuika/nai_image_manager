const liveParams = new URLSearchParams(location.search);
let liveMode = liveParams.get('mode') || 'existing';
let useCharId = liveParams.get('char_id') === '1';
let currentSessionName = '__ACTIVE_WORKSPACE__';
let currentPreview = null;
let selectedImagePath = '';
let liveRootTree = null;
let liveCurrentPath = [];
let characterIndexStatus = null;
let characterIndexPollTimer = null;
let liveWorkspaceTotal = 0;
let liveMaxScanAll = false;
let livePerFolderLimitAll = false;
let liveNoMetadataDisplayLimit = 500;
let liveTempRules = [];
let selectedTopRuleIndex = -1;
let candidateTags = [];
let candidateTagTextEditMode = false;
let candidateTagTextDraft = '';
let liveRulesLoaded = false;
let liveApplyPollTimer = null;
let liveApplyRunning = false;
let editingRuleTarget = null;
const liveRouteSelectedPathKeys = new Set();
let liveRouteLastClickedPathKey = '';
let liveRouteDragState = null;
let liveRouteDropTarget = null;
let liveRouteSuppressNextClickKey = '';
let liveFolderPointerState = null;
let liveSuppressFolderClick = false;
const liveRouteExpandedPathKeys = new Set();
let liveRouteInlineGroupState = {
    mode: 'button',
    parentKey: '',
    anchorKey: ''
};

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[ch]));
}

function imageUrl(path) {
    return `/workspace-image/${encodeURIComponent(path).replace(/%2F/g, '/')}`;
}

function closeLiveZoom() {
    const layer = document.getElementById('zoomLayer');
    const img = document.getElementById('zoomImg');
    if (layer) layer.style.display = 'none';
    if (img) img.src = '';
}

function openLiveZoom(src) {
    const layer = document.getElementById('zoomLayer');
    const img = document.getElementById('zoomImg');
    if (!layer || !img) return;
    img.src = src;
    layer.style.display = 'flex';
}

async function apiGet(url) {
    const res = await fetch(url, { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok || data.status === 'error') throw new Error(data.message || `HTTP ${res.status}`);
    return data;
}

async function apiPost(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
    });
    const data = await res.json();
    if (!res.ok || data.status === 'error') throw new Error(data.message || `HTTP ${res.status}`);
    return data;
}

function getMaxScanValue() {
    if (liveMaxScanAll) {
        return 0;
    }

    const value = parseInt($('maxScanInput')?.value || '50000', 10);
    return Number.isFinite(value) && value > 0 ? value : 50000;
}

function getPerFolderLimitValue() {
    if (livePerFolderLimitAll) {
        return getLiveUnlimitedFallbackValue();
    }

    const value = parseInt($('perFolderLimitInput')?.value || '300', 10);
    return Number.isFinite(value) && value > 0 ? value : 300;
}

function getLiveWorkspaceTotalValue() {
    const total = Number(liveWorkspaceTotal || 0);
    return Number.isFinite(total) && total > 0 ? total : 0;
}

function getLiveUnlimitedFallbackValue() {
    const total = getLiveWorkspaceTotalValue();
    return total > 0 ? total : 999999999;
}

function renderLiveLimitToggles() {
    const maxBtn = $('maxScanMaxToggle');
    const folderBtn = $('perFolderLimitMaxToggle');
    const maxInput = $('maxScanInput');
    const folderInput = $('perFolderLimitInput');

    if (maxBtn) {
        maxBtn.classList.toggle('active', !!liveMaxScanAll);
        maxBtn.textContent = liveMaxScanAll ? '\uCD5C\uB300 ON' : '\uCD5C\uB300';
    }

    if (folderBtn) {
        folderBtn.classList.toggle('active', !!livePerFolderLimitAll);
        folderBtn.textContent = livePerFolderLimitAll ? '\uCD5C\uB300 ON' : '\uCD5C\uB300';
    }

    if (maxInput) maxInput.disabled = !!liveMaxScanAll;
    if (folderInput) folderInput.disabled = !!livePerFolderLimitAll;
}

function toggleLiveMaxScan() {
    liveMaxScanAll = !liveMaxScanAll;
    renderLiveLimitToggles();
}

function toggleLivePerFolderLimitMax() {
    livePerFolderLimitAll = !livePerFolderLimitAll;
    renderLiveLimitToggles();
}

async function setLiveMode(mode) {
    liveMode = mode === 'new' ? 'new' : 'existing';
    setModeBadge();

    liveTempRules = [];
    selectedTopRuleIndex = -1;
    liveRulesLoaded = false;
    editingRuleTarget = null;
    clearLiveRouteSelection();
    $('previewGallery').innerHTML = '';

    await reloadLiveRules();
    await loadPreviewTree();
}

function setModeBadge() {
    const label = liveMode === 'new' ? '\uCC98\uC74C\uBD80\uD130 \uB9CC\uB4E4\uAE30' : '\uAE30\uC874 custom_rules \uC0AC\uC6A9';
    const charLabel = useCharId ? '\uCE90\uB9AD\uD130 \uD310\uBCC4 \uC0AC\uC6A9' : '\uCE90\uB9AD\uD130 \uD310\uBCC4 \uBB34\uC2DC';
    $('modeBadge').innerText = `${label} \u00B7 ${charLabel}`;

    const toggle = $('useCharIdToggle');
    if (toggle) {
        toggle.checked = useCharId;
        toggle.disabled = !characterIndexStatus || !characterIndexStatus.complete;
        toggle.onchange = async () => {
            if (toggle.checked && (!characterIndexStatus || !characterIndexStatus.complete)) {
                toggle.checked = false;
                useCharId = false;
                setModeBadge();
                alert('\uCE90\uB9AD\uD130 \uD310\uBCC4\uC744 \uC0AC\uC6A9\uD558\uB824\uBA74 \uBA3C\uC800 \uCE90\uB9AD\uD130 \uC778\uB371\uC2A4\uB97C \uC0DD\uC131\uD558\uC138\uC694. \uCE90\uB9AD\uD130 \uD310\uBCC4\uC744 \uB044\uB294 \uC0C1\uD0DC\uC5D0\uC11C\uB294 \uC7AC\uBD84\uB958\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.');
                return;
            }
            useCharId = !!toggle.checked;
            setModeBadge();
            await loadPreviewTree();
        };
    }
}

function liveCurrentNode() {
    return liveCurrentPath[liveCurrentPath.length - 1] || liveRootTree;
}

function liveGoToRoot() {
    if (!liveRootTree) return;
    liveCurrentPath = [liveRootTree];
    renderLiveTreeView();
}

function liveGoToTopFolder(index) {
    if (!liveRootTree || !Array.isArray(liveRootTree.folders)) return;
    const node = liveRootTree.folders[index];
    if (!node) return;
    liveCurrentPath = [liveRootTree, node];
    renderLiveTreeView();
}

function liveEnterFolder(pathJson) {
    const path = JSON.parse(pathJson);
    let node = liveRootTree;
    const nextPath = [liveRootTree];

    for (const name of path) {
        const child = (node.folders || []).find(f => f.name === name);
        if (!child) return;
        node = child;
        nextPath.push(node);
    }

    liveCurrentPath = nextPath;
    renderLiveTreeView();
}

function bindLiveFolderClickDragGuard(element, onClick) {
    if (!element || typeof onClick !== 'function') return;

    const begin = (event) => {
        liveFolderPointerState = {
            x: Number(event.clientX || 0),
            y: Number(event.clientY || 0),
            dragging: false
        };
    };

    const move = (event) => {
        if (!liveFolderPointerState) return;
        const dx = Number(event.clientX || 0) - liveFolderPointerState.x;
        const dy = Number(event.clientY || 0) - liveFolderPointerState.y;
        if (Math.hypot(dx, dy) >= 6) {
            liveFolderPointerState.dragging = true;
        }
    };

    const end = (event) => {
        const state = liveFolderPointerState;
        liveFolderPointerState = null;

        if (state && state.dragging) {
            liveSuppressFolderClick = true;
            event.preventDefault();
            event.stopPropagation();
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        onClick(event);
    };

    element.addEventListener('pointerdown', begin);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', end);
    element.addEventListener('pointercancel', () => {
        liveFolderPointerState = null;
    });
    element.addEventListener('click', (event) => {
        if (!liveSuppressFolderClick) return;
        event.preventDefault();
        event.stopPropagation();
        liveSuppressFolderClick = false;
    });
}

function liveBreadcrumbTo(index) {
    if (!liveRootTree) return;
    liveCurrentPath = liveCurrentPath.slice(0, index + 1);
    renderLiveTreeView();
}

function liveNodePathParts(node) {
    return String(node?.path || '').split('/').filter(Boolean);
}

function isLiveNoMetadataName(value) {
    const key = String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
    return key === '0_no_metadata' || key === 'no_metadata' || key.includes('no_metadata');
}

function isLiveNoMetadataNode(node) {
    if (!node) return false;
    if (isLiveNoMetadataName(node.name)) return true;

    const parts = liveNodePathParts(node);
    return parts.some(part => isLiveNoMetadataName(part));
}

function getLiveCurrentPathParts() {
    return liveCurrentPath
        .slice(1)
        .map(node => node?.name)
        .filter(Boolean);
}

function restoreLiveCurrentPathByParts(parts) {
    if (!liveRootTree || !Array.isArray(parts) || !parts.length) {
        liveCurrentPath = liveRootTree ? [liveRootTree] : [];
        return;
    }

    let node = liveRootTree;
    const nextPath = [liveRootTree];

    for (const name of parts) {
        const child = (node.folders || []).find(folder => folder.name === name);
        if (!child) break;

        node = child;
        nextPath.push(node);
    }

    liveCurrentPath = nextPath;
}

async function loadWorkspaceStatus() {
    const data = await apiGet('/api/live_classifier/workspace');
    const workspace = data.workspace || {};
    currentSessionName = workspace.session_name || '__ACTIVE_WORKSPACE__';
    liveWorkspaceTotal = Number(workspace.total || workspace.indexed || 0) || 0;
    renderLiveLimitToggles();

    const badge = $('workspaceStatusBadge');
    if (badge) {
        badge.textContent = `\uD604\uC7AC \uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4 \u00B7 ${workspace.indexed || 0}/${workspace.total || 0} \uC815\uC0C1 \u00B7 \uC624\uB958 ${workspace.errors || 0}`;
    }

    characterIndexStatus = workspace.character_index || null;
    renderCharacterIndexStatus();
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value || []));
}

function makeLiveRuleExportName() {
    const parts = [
        liveMode === 'new' ? 'new' : 'existing',
        useCharId ? 'char' : 'nochar',
        currentSessionName || 'workspace'
    ];

    return parts
        .join('_')
        .replace(/[<>:"/\\\\|?*]+/g, '_')
        .replace(/\s+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80) || 'live_rules';
}

async function saveLiveTempRulesJsonToServer() {
    try {
        if (candidateTagTextEditMode) {
            syncCandidateTagTextDraftFromTextarea();
        }

        if (!Array.isArray(liveTempRules) || !liveTempRules.length) {
            alert('저장할 임시 규칙이 없습니다.');
            return;
        }

        if (typeof recomputeAllLiveRouteOrTags === 'function') {
            recomputeAllLiveRouteOrTags();
        }

        const data = await apiPost('/api/live_classifier/export_rules', {
            name: makeLiveRuleExportName(),
            mode: liveMode,
            live_mode: liveMode,
            use_char_id: !!useCharId,
            workspace_session_name: currentSessionName || '',
            rules: cloneJson(liveTempRules)
        });

        const message = data.filename
            ? `임시 규칙 JSON을 서버에 저장했습니다. ${data.filename}`
            : '임시 규칙 JSON을 서버에 저장했습니다.';

        if (typeof showLiveFlashMessage === 'function') {
            showLiveFlashMessage(message);
        } else {
            alert(message);
        }
    } catch (error) {
        alert(`임시 규칙 JSON 저장 실패: ${error.message || error}`);
    }
}

function openLiveRuleExportModal() {
    const modal = $('liveRuleExportModal');
    if (modal) modal.style.display = 'flex';
    loadLiveRuleExportList();
}

function closeLiveRuleExportModal() {
    const modal = $('liveRuleExportModal');
    if (modal) modal.style.display = 'none';
}

async function loadLiveRuleExportList() {
    const list = $('liveRuleExportList');
    if (list) list.innerHTML = '\uBAA9\uB85D\uC744 \uBD88\uB7EC\uC624\uB294 \uC911...';

    try {
        const data = await apiGet('/api/live_classifier/rule_exports');
        const items = Array.isArray(data.items) ? data.items : [];
        if (!items.length) {
            if (list) list.innerHTML = '\uC800\uC7A5\uB41C \uADDC\uCE59 JSON\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.';
            return;
        }

        const html = items.map((item) => {
            const modifiedAt = item.modified_at
                ? new Date(Number(item.modified_at) * 1000).toLocaleString()
                : '-';
            return `
                <div style="display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; align-items:center; padding:8px 0; border-bottom:1px solid var(--border);">
                    <div>
                        <div style="font-weight:900; color:#fff;">${escapeHtml(item.filename || '')}</div>
                        <div style="color:var(--muted); font-size:12px;">mode ${escapeHtml(item.mode || '-')} · rules ${escapeHtml(item.rules_count || 0)} · ${escapeHtml(modifiedAt)}</div>
                    </div>
                    <button type="button" onclick="loadLiveRuleExportFile('${escapeHtml(item.filename || '')}')">\uBD88\uB7EC\uC624\uAE30</button>
                </div>
            `;
        }).join('');
        if (list) list.innerHTML = html;
    } catch (error) {
        if (list) list.innerHTML = `\uBAA9\uB85D \uB85C\uB4DC \uC2E4\uD328: ${escapeHtml(error.message || error)}`;
    }
}

async function backupCurrentLiveRulesBeforeImport() {
    if (!Array.isArray(liveTempRules) || !liveTempRules.length) {
        return null;
    }

    if (typeof recomputeAllLiveRouteOrTags === 'function') {
        recomputeAllLiveRouteOrTags();
    }

    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    return apiPost('/api/live_classifier/export_rules', {
        name: `auto_backup_before_import_${stamp}`,
        mode: liveMode,
        live_mode: liveMode,
        use_char_id: !!useCharId,
        workspace_session_name: currentSessionName || '',
        rules: cloneJson(liveTempRules)
    });
}

async function loadLiveRuleExportFile(filename) {
    const hasRules = Array.isArray(liveTempRules) && liveTempRules.length > 0;
    if (hasRules) {
        const ok = confirm('\uD604\uC7AC \uC784\uC2DC \uADDC\uCE59\uC744 JSON \uADDC\uCE59\uC73C\uB85C \uB36E\uC5B4\uC4F8\uAE4C\uC694? \uD604\uC7AC \uADDC\uCE59\uC740 \uC790\uB3D9 \uBC31\uC5C5 \uC800\uC7A5\uB429\uB2C8\uB2E4.');
        if (!ok) return;
    }

    try {
        if (hasRules) {
            await backupCurrentLiveRulesBeforeImport();
        }
        const data = await apiPost('/api/live_classifier/rule_exports/load', { filename });
        applyLoadedLiveRulesPayload(data);
        closeLiveRuleExportModal();
    } catch (error) {
        alert(`\uADDC\uCE59 JSON \uBD88\uB7EC\uC624\uAE30 \uC2E4\uD328: ${error.message || error}`);
    }
}

function applyLoadedLiveRulesPayload(payload) {
    const rules = Array.isArray(payload?.rules) ? payload.rules : [];
    liveTempRules = cloneJson(rules);
    selectedTopRuleIndex = liveTempRules.length ? 0 : -1;
    editingRuleTarget = null;
    clearLiveRouteSelection();
    if (selectedTopRuleIndex >= 0) {
        liveRouteSelectedPathKeys.add(liveRoutePathKey([selectedTopRuleIndex]));
        liveRouteLastClickedPathKey = liveRoutePathKey([selectedTopRuleIndex]);
    }
    renderLiveRuleEditor();
    loadPreviewTree();
    showLiveFlashMessage('\uADDC\uCE59 JSON\uC744 \uC784\uC2DC \uADDC\uCE59\uC73C\uB85C \uBD88\uB7EC\uC654\uC2B5\uB2C8\uB2E4.');
}

function openWorkspaceDiagnoseModal() {
    const modal = $('workspaceDiagnoseModal');
    if (modal) modal.style.display = 'flex';
    runWorkspaceDiagnose();
}

function closeWorkspaceDiagnoseModal() {
    const modal = $('workspaceDiagnoseModal');
    if (modal) modal.style.display = 'none';
}

async function runWorkspaceDiagnose() {
    const box = $('workspaceDiagnoseResult');
    if (box) box.innerHTML = 'workspace DB\uB97C \uC9C4\uB2E8\uD558\uB294 \uC911...';

    try {
        const data = await apiGet('/api/live_classifier/workspace/diagnose');
        const result = data.result || {};
        if (box) {
            box.innerHTML = `
                <div>total_rows: <b>${escapeHtml(result.total_rows || 0)}</b></div>
                <div>distinct_physical_paths: <b>${escapeHtml(result.distinct_physical_paths || 0)}</b></div>
                <div>duplicate_rows: <b>${escapeHtml(result.duplicate_rows || 0)}</b></div>
                <div>duplicate_physical_paths: <b>${escapeHtml(result.duplicate_physical_paths || 0)}</b></div>
                <div style="margin-top:8px; color:var(--muted);">${escapeHtml(JSON.stringify((result.samples || []).slice(0, 3), null, 2))}</div>
            `;
        }
    } catch (error) {
        if (box) box.innerHTML = `\uC9C4\uB2E8 \uC2E4\uD328: ${escapeHtml(error.message || error)}`;
    }
}

function setLiveApplyControlsDisabled(disabled) {
    const headerBtn = $('liveApplyRulesBtn');
    if (headerBtn) {
        headerBtn.disabled = !!disabled;
        headerBtn.textContent = disabled ? '⏳ 반영 중...' : '✅ 분류 반영';
    }

    const startBtn = document.querySelector('.live-apply-modal-actions button');
    if (startBtn) {
        startBtn.disabled = !!disabled;
        startBtn.textContent = disabled ? '반영 중...' : '분류 반영 시작';
    }

    ['liveApplyUseNsfw', 'liveApplyUseAiNsfw', 'liveApplyUseGpu'].forEach((id) => {
        const input = $(id);
        if (input) input.disabled = !!disabled;
    });
}

async function openLiveApplyOptionsModal() {
    const modal = $('liveApplyOptionsModal');
    const progress = $('liveApplyProgressBox');

    if (modal) {
        modal.style.display = 'flex';
    }

    try {
        const data = await apiGet('/api/live_classifier/apply_to_gallery/status');
        const job = data.job || {};
        if (job.running) {
            liveApplyRunning = true;
            setLiveApplyControlsDisabled(true);
            renderLiveApplyProgress(job);
            startLiveApplyPolling();
            return;
        }
    } catch (error) {
        console.warn('live apply status check failed', error);
    }

    liveApplyRunning = false;
    setLiveApplyControlsDisabled(false);
    if (progress) {
        progress.style.display = 'none';
        progress.innerHTML = '';
    }
}

function closeLiveApplyOptionsModal() {
    const modal = $('liveApplyOptionsModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

function renderLiveApplyProgress(job) {
    const progress = $('liveApplyProgressBox');
    const galleryState = $('galleryState');

    if (!job) return;
    if (job.running) {
        liveApplyRunning = true;
        setLiveApplyControlsDisabled(true);
    }

    const processed = Number(job.processed || 0);
    const total = Number(job.total || 0);
    const moved = Number(job.moved || 0);
    const skipped = Number(job.skipped || 0);
    const errors = Number(job.errors || 0);
    const percent = total > 0 ? Math.floor((processed / total) * 100) : 0;
    const message = job.error
        ? `오류: ${job.error}`
        : (job.message || '분류 반영 상태 확인 중...');

    const html = `
        <div><b>${escapeHtml(message)}</b></div>
        <div>${escapeHtml(processed)} / ${escapeHtml(total)} (${escapeHtml(percent)}%)</div>
        <div>이동 ${escapeHtml(moved)} · 건너뜀 ${escapeHtml(skipped)} · 오류 ${escapeHtml(errors)}</div>
        <div class="live-progress-bar"><div style="width:${Math.max(0, Math.min(100, percent))}%"></div></div>
        ${job.export_filename ? `<div class="live-apply-export-name">JSON: ${escapeHtml(job.export_filename)}</div>` : ''}
    `;

    if (progress) {
        progress.style.display = '';
        progress.innerHTML = html;
    }

    if (galleryState) {
        galleryState.style.display = '';
        galleryState.innerText = message;
    }
}

function stopLiveApplyPolling() {
    if (liveApplyPollTimer) {
        clearInterval(liveApplyPollTimer);
        liveApplyPollTimer = null;
    }
}

function startLiveApplyPolling() {
    stopLiveApplyPolling();

    liveApplyPollTimer = setInterval(async () => {
        try {
            const data = await apiGet('/api/live_classifier/apply_to_gallery/status');
            const job = data.job || {};
            renderLiveApplyProgress(job);

            if (job.running) {
                liveApplyRunning = true;
                setLiveApplyControlsDisabled(true);
            }

            if (!job.running) {
                stopLiveApplyPolling();
                liveApplyRunning = false;
                setLiveApplyControlsDisabled(false);

                if (job.error) {
                    alert(`분류 반영 실패: ${job.error}`);
                    return;
                }

                await loadWorkspaceStatus();

                if (typeof showLiveFlashMessage === 'function') {
                    showLiveFlashMessage('분류 반영이 완료되었습니다. 갤러리 인덱스를 갱신 중입니다.');
                }
            }
        } catch (error) {
            stopLiveApplyPolling();
            liveApplyRunning = false;
            setLiveApplyControlsDisabled(false);
            alert(`분류 반영 상태 확인 실패: ${error.message || error}`);
        }
    }, 1000);
}

async function startLiveApplyToGallery() {
    if (liveApplyRunning) {
        startLiveApplyPolling();
        return;
    }

    if (candidateTagTextEditMode) {
        syncCandidateTagTextDraftFromTextarea();
    }

    if (!Array.isArray(liveTempRules) || !liveTempRules.length) {
        alert('반영할 임시 규칙이 없습니다.');
        return;
    }

    if (useCharId && (!characterIndexStatus || !characterIndexStatus.complete)) {
        alert('캐릭터 판별을 사용하려면 먼저 캐릭터 인덱스를 생성하세요.');
        return;
    }

    if (!confirm('현재 미리보기 결과대로 실제 파일을 TOTAL_CLASSIFIED 안으로 이동할까요?\n\n이 작업은 파일 위치를 변경합니다.')) {
        return;
    }

    if (typeof recomputeAllLiveRouteOrTags === 'function') {
        recomputeAllLiveRouteOrTags();
    }

    const useNsfw = !!$('liveApplyUseNsfw')?.checked;
    const useAiNsfw = !!$('liveApplyUseAiNsfw')?.checked;
    const useGpu = !!$('liveApplyUseGpu')?.checked;

    try {
        liveApplyRunning = true;
        setLiveApplyControlsDisabled(true);

        const body = {
            name: makeLiveRuleExportName(),
            mode: liveMode,
            live_mode: liveMode,
            use_char_id: !!useCharId,
            use_nsfw: useNsfw,
            use_ai_nsfw: useAiNsfw,
            use_gpu: useGpu,
            per_group_limit: getPerFolderLimitValue(),
            max_scan: getMaxScanValue(),
            workspace_session_name: currentSessionName || '',
            rules: cloneJson(liveTempRules)
        };

        console.log('[live apply payload]', {
            liveMode,
            useCharId,
            rules_count: liveTempRules.length,
            folders: liveTempRules.map(rule => rule && rule.folder).filter(Boolean),
            body_preview: {
                ...body,
                rules_count: body.rules.length,
                rules: body.rules.slice(0, 5)
            }
        });

        const data = await apiPost('/api/live_classifier/apply_to_gallery', body);

        renderLiveApplyProgress(data.job || {});
        if (data.already_running) {
            liveApplyRunning = true;
            setLiveApplyControlsDisabled(true);
        }
        startLiveApplyPolling();
    } catch (error) {
        liveApplyRunning = false;
        setLiveApplyControlsDisabled(false);
        alert(`분류 반영 시작 실패: ${error.message || error}`);
    }
}

async function reloadLiveRules() {
    try {
        const data = await apiGet(`/api/live_classifier/rules?mode=${encodeURIComponent(liveMode)}`);
        liveTempRules = Array.isArray(data.rules) ? cloneJson(data.rules) : [];
        selectedTopRuleIndex = liveTempRules.length ? 0 : -1;
        editingRuleTarget = null;
        clearLiveRouteSelection();
        if (selectedTopRuleIndex >= 0) {
            liveRouteSelectedPathKeys.add(liveRoutePathKey([selectedTopRuleIndex]));
            liveRouteLastClickedPathKey = liveRoutePathKey([selectedTopRuleIndex]);
        }
        liveRulesLoaded = true;
        renderLiveRuleEditor();
    } catch (error) {
        alert(`\uADDC\uCE59 \uB85C\uB4DC \uC2E4\uD328: ${error.message}`);
    }
}

async function ensureLiveRulesLoaded() {
    if (liveRulesLoaded) {
        return;
    }

    const data = await apiGet(`/api/live_classifier/rules?mode=${encodeURIComponent(liveMode)}`);
    liveTempRules = Array.isArray(data.rules) ? cloneJson(data.rules) : [];
    selectedTopRuleIndex = liveTempRules.length ? 0 : -1;
    clearLiveRouteSelection();
    if (selectedTopRuleIndex >= 0) {
        liveRouteSelectedPathKeys.add(liveRoutePathKey([selectedTopRuleIndex]));
        liveRouteLastClickedPathKey = liveRoutePathKey([selectedTopRuleIndex]);
    }
    liveRulesLoaded = true;
    renderLiveRuleEditor();
}

async function loadCharacterIndexStatus() {
    try {
        const data = await apiGet('/api/live_classifier/character_index/status');
        characterIndexStatus = data.character_index;
        renderCharacterIndexStatus();
    } catch (error) {
        characterIndexStatus = null;
        $('characterIndexBox').innerText = `\uCE90\uB9AD\uD130 \uC778\uB371\uC2A4 \uC0C1\uD0DC \uD655\uC778 \uC2E4\uD328: ${error.message}`;
    }
}

function renderCharacterIndexStatus() {
    const box = $('characterIndexBox');
    if (!box) return;

    if (!characterIndexStatus) {
        box.innerText = '\uCE90\uB9AD\uD130 \uC778\uB371\uC2A4 \uC0C1\uD0DC \uC5C6\uC74C';
        const toggle = $('useCharIdToggle');
        if (toggle) {
            toggle.disabled = true;
            if (useCharId) {
                useCharId = false;
            }
            toggle.checked = false;
        }
        setModeBadge();
        return;
    }

    const total = Number(characterIndexStatus.total || 0);
    const indexed = Number(characterIndexStatus.indexed || 0);

    box.innerHTML = `
        \uCE90\uB9AD\uD130 \uC778\uB371\uC2A4: ${escapeHtml(indexed)} / ${escapeHtml(total)}<br>
        \uB204\uB77D: ${escapeHtml(characterIndexStatus.missing)}<br>
        \uC624\uB958: ${escapeHtml(characterIndexStatus.errors)}<br>
        \uC0C1\uD0DC: ${characterIndexStatus.complete ? '\uC644\uB8CC' : '\uBBF8\uC644\uB8CC'}
    `;

    const toggle = $('useCharIdToggle');
    if (toggle) {
        const hasCompleteIndex = !!characterIndexStatus.complete;
        toggle.disabled = !hasCompleteIndex;

        if (!hasCompleteIndex && useCharId) {
            useCharId = false;
            toggle.checked = false;
        } else {
            toggle.checked = !!useCharId;
        }
    }
    setModeBadge();
}

function renderLivePreviewStats(preview) {
    const stats = preview?.preview_stats || {};
    const total = Number(stats.total || 0);
    const classified = Number(stats.classified || 0);
    const unclassified = Number(stats.unclassified || Math.max(0, total - classified));
    const noMetadata = Number(stats.no_metadata || 0);
    const defaults = Number(stats.default || 0);
    const errors = Number(stats.error || 0);
    const box = $('summaryBox');

    if (!box) return;

    if (!total) {
        box.innerHTML = '';
        return;
    }

    box.innerHTML = `
        <b>\uBD84\uB958 \uC0C1\uD0DC</b><br>
        \uBBF8\uBD84\uB958: ${escapeHtml(unclassified)} / ${escapeHtml(total)}\uC7A5<br>
        \uBD84\uB958\uB428: ${escapeHtml(classified)}\uC7A5<br>
        NO_METADATA: ${escapeHtml(noMetadata)}\uC7A5<br>
        \uAE30\uBCF8/\uC624\uB958: ${escapeHtml(defaults)} / ${escapeHtml(errors)}\uC7A5<br>
        \uD45C\uC2DC \uC81C\uD55C: \uD3F4\uB354\uBCC4 ${escapeHtml(preview.per_folder_limit || getPerFolderLimitValue())}\uC7A5 \u00B7 NO_METADATA ${escapeHtml(preview.no_metadata_limit || liveNoMetadataDisplayLimit)}\uC7A5
    `;
}

function startCharacterIndexPolling() {
    if (characterIndexPollTimer) {
        clearInterval(characterIndexPollTimer);
        characterIndexPollTimer = null;
    }

    characterIndexPollTimer = setInterval(async () => {
        try {
            const data = await apiGet('/api/live_classifier/character_index/job_status');
            const job = data.job || {};
            characterIndexStatus = data.character_index || characterIndexStatus;

            renderCharacterIndexJob(job);

            if (!job.running) {
                clearInterval(characterIndexPollTimer);
                characterIndexPollTimer = null;
                await loadWorkspaceStatus();
            }
        } catch (error) {
            $('characterIndexBox').innerText = `\uCE90\uB9AD\uD130 \uC778\uB371\uC2A4 \uC0C1\uD0DC \uD655\uC778 \uC2E4\uD328: ${error.message}`;
        }
    }, 1000);
}


function renderCharacterIndexJob(job) {
    const box = $('characterIndexBox');
    if (!box) return;

    const processed = Number(job.processed || 0);
    const total = Number(job.total || 0);
    const errors = Number(job.errors || 0);
    const percent = total > 0 ? Math.floor((processed / total) * 100) : 0;

    if (job.running) {
        box.innerHTML = `
            <div>\uD83E\uDDEC \uCE90\uB9AD\uD130 \uC778\uB371\uC2A4 \uC0DD\uC131 \uC911...</div>
            <div>${escapeHtml(processed)} / ${escapeHtml(total)} (${escapeHtml(percent)}%)</div>
            <div>\uC624\uB958: ${escapeHtml(errors)}</div>
            <div class="live-progress-bar"><div style="width:${Math.max(0, Math.min(100, percent))}%"></div></div>
        `;
        return;
    }

    if (job.error) {
        box.innerHTML = `
            <div>\u274C \uCE90\uB9AD\uD130 \uC778\uB371\uC2A4 \uC2E4\uD328</div>
            <div>${escapeHtml(job.error)}</div>
        `;
        return;
    }

    renderCharacterIndexStatus();
}

async function buildCharacterIndexFromLive() {
    $('characterIndexBox').innerText = '\uCE90\uB9AD\uD130 \uC778\uB371\uC2A4 \uC0DD\uC131 \uC2DC\uC791 \uC911...';

    try {
        const data = await apiPost('/api/live_classifier/character_index/build', {
            max_scan: getMaxScanValue()
        });

        renderCharacterIndexJob(data.job || {});
        startCharacterIndexPolling();
    } catch (error) {
        $('characterIndexBox').innerText = `\uCE90\uB9AD\uD130 \uC778\uB371\uC2A4 \uC0DD\uC131 \uC2E4\uD328: ${error.message}`;
        alert(error.message);
    }
}

function normalizePromptTokenForRule(raw) {
    let text = String(raw || '').trim();

    if (!text) return '';

    const weightedMatch = text.match(/^[-+]?\d+(?:\.\d+)?::\s*(.*?)\s*::$/);
    if (weightedMatch) {
        text = weightedMatch[1].trim();
    }

    text = text.replace(/^[-+]?\d+(?:\.\d+)?::\s*/, '').trim();
    text = text.replace(/\s*::$/, '').trim();

    // tag:1.2 ?�거. artist:foo 같�? ?�임?�페?�스 ?�그???��??�다.
    text = text.replace(/:([-+]?\d+(?:\.\d+)?)$/, '').trim();

    while (
        (text.startsWith('(') && text.endsWith(')')) ||
        (text.startsWith('{') && text.endsWith('}')) ||
        (text.startsWith('[') && text.endsWith(']'))
    ) {
        text = text.slice(1, -1).trim();
    }

    return text;
}

function normalizePromptTokenKey(raw) {
    return normalizePromptTokenForRule(raw)
        .toLowerCase()
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function splitPromptTags(text) {
    const seen = new Set();

    return String(text || '')
        .split(/[,\n]+/)
        .map(v => normalizePromptTokenForRule(v))
        .map(v => v.trim())
        .filter(Boolean)
        .filter(v => {
            const key = normalizePromptTokenKey(v);
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

function addCandidateTag(tag, source = 'all') {
    const text = normalizePromptTokenForRule(tag);
    if (!text) return;

    const key = normalizePromptTokenKey(text);
    if (!key) return;

    if (candidateTagTextEditMode) {
        syncCandidateTagTextDraftFromTextarea();
        const current = parseCandidateTagText(candidateTagTextDraft);
        const exists = current.some(item => item.key === key);
        if (!exists) {
            current.push({ key, text, source });
        }
        candidateTags = current;
        candidateTagTextDraft = candidateTagsToText();
        renderCandidateTags();
        return;
    }

    if (candidateTags.some(item => item.key === key)) return;

    candidateTags.push({
        key,
        text,
        source
    });

    const folderInput = $('candidateFolderInput');
    if (folderInput && !folderInput.value.trim()) {
        folderInput.value = sanitizeRuleFolderName(text);
    }

    renderCandidateTags();
}

function removeCandidateTag(key) {
    candidateTags = candidateTags.filter(item => item.key !== key);
    renderCandidateTags();
}

function clearCandidateTags() {
    candidateTags = [];
    candidateTagTextDraft = '';
    renderCandidateTags();
}

function candidateTagsToText() {
    return candidateTags
        .map(item => normalizePromptTokenForRule(item.text))
        .filter(Boolean)
        .join(', ');
}

function parseCandidateTagText(text) {
    const seen = new Set();
    const result = [];

    String(text || '')
        .split(/[,\n]+/)
        .map(v => normalizePromptTokenForRule(v))
        .map(v => v.trim())
        .filter(Boolean)
        .forEach(tag => {
            const key = normalizePromptTokenKey(tag);
            if (!key || seen.has(key)) return;

            seen.add(key);
            result.push({
                key,
                text: tag,
                source: 'manual'
            });
        });

    return result;
}

function syncCandidateTagTextDraftFromTextarea() {
    const textarea = $('candidateTagTextarea');
    if (textarea) {
        candidateTagTextDraft = textarea.value;
    }
}

function toggleCandidateTagTextEdit() {
    if (!candidateTagTextEditMode) {
        candidateTagTextEditMode = true;
        candidateTagTextDraft = candidateTagsToText();
        renderCandidateTags();

        setTimeout(() => {
            const textarea = $('candidateTagTextarea');
            if (textarea) {
                textarea.focus();
                textarea.select();
            }
        }, 0);

        return;
    }

    syncCandidateTagTextDraftFromTextarea();
    candidateTags = parseCandidateTagText(candidateTagTextDraft);
    candidateTagTextEditMode = false;
    candidateTagTextDraft = '';
    renderCandidateTags();
}

function renderCandidateTags() {
    const box = $('candidateTagList');
    if (!box) return;

    const toggleBtn = $('candidateTagTextToggleBtn');
    if (toggleBtn) {
        toggleBtn.textContent = candidateTagTextEditMode ? '\uD0DC\uADF8 \uC801\uC6A9' : '\uC9C1\uC811 \uC785\uB825';
    }

    if (candidateTagTextEditMode) {
        const text = candidateTagTextDraft || candidateTagsToText();
        box.innerHTML = `
            <textarea id="candidateTagTextarea"
                      class="candidate-tag-textarea"
                      placeholder="&#49744;&#54364; &#46608;&#45716; &#51460;&#48148;&#45000;&#51004;&#47196; &#53468;&#44536;&#47484; &#51077;&#47141;&#54616;&#49464;&#50836;.">${escapeHtml(text)}</textarea>
            <div class="candidate-tag-text-help">&#49744;&#54364; &#46608;&#45716; &#51460;&#48148;&#45000;&#51004;&#47196; &#44396;&#48516;&#54633;&#45768;&#45796;. &#44032;&#51473;&#52824; &#47928;&#48277;&#51008; &#53468;&#44536; &#51201;&#50857; &#49884; &#51088;&#46041; &#51228;&#44144;&#46121;&#45768;&#45796;.</div>
        `;

        const textarea = $('candidateTagTextarea');
        if (textarea) {
            textarea.oninput = () => {
                candidateTagTextDraft = textarea.value;
            };
        }

        return;
    }

    if (!candidateTags.length) {
        box.innerHTML = '<div class="candidate-empty">\uC120\uD0DD\uB41C \uD0DC\uADF8 \uC5C6\uC74C</div>';
        return;
    }

    box.innerHTML = candidateTags.map(item => `
        <button class="candidate-tag" onclick="removeCandidateTag(${JSON.stringify(item.key).replace(/"/g, '&quot;')})">
            ${escapeHtml(item.text)} <span>\u00D7</span>
        </button>
    `).join('');
}

function renderClickablePromptTags(container, text, source) {
    const rawParts = String(text || '')
        .split(/[,\n]+/)
        .map(v => v.trim())
        .filter(Boolean);

    const seen = new Set();
    const items = [];

    rawParts.forEach(raw => {
        const clean = normalizePromptTokenForRule(raw);
        const key = normalizePromptTokenKey(clean);
        if (!clean || !key || seen.has(key)) return;

        seen.add(key);
        items.push({ raw, clean, key });
    });

    if (!items.length) {
        container.innerHTML = '<div class="empty">\uD45C\uC2DC\uD560 \uD0DC\uADF8 \uC5C6\uC74C</div>';
        return;
    }

    container.innerHTML = items.map(item => {
        const title = item.raw !== item.clean
            ? ` title="${escapeHtml(item.raw)}"`
            : '';

        return `
            <button class="prompt-token" onclick="addCandidateTag(${JSON.stringify(item.clean).replace(/"/g, '&quot;')}, '${source}')"${title}>
                ${escapeHtml(item.clean)}
            </button>
        `;
    }).join('');
}

function sanitizeRuleFolderName(value) {
    return normalizePromptTokenForRule(value)
        .trim()
        .replace(/[<>:"/\\|?*]+/g, '')
        .replace(/\s+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 120);
}

function buildRuleFromCandidate() {
    if (candidateTagTextEditMode) {
        syncCandidateTagTextDraftFromTextarea();
        candidateTags = parseCandidateTagText(candidateTagTextDraft);
    }

    const folder = sanitizeRuleFolderName($('candidateFolderInput')?.value || '');

    if (!folder) {
        alert('\uB300\uC0C1 \uD3F4\uB354\uBA85\uC744 \uC785\uB825\uD558\uC138\uC694.');
        return null;
    }

    if (!candidateTags.length) {
        alert('\uD504\uB86C\uD504\uD2B8 \uD0DC\uADF8\uB97C \uD558\uB098 \uC774\uC0C1 \uC120\uD0DD\uD558\uC138\uC694.');
        return null;
    }

    const conditionRaw = $('candidateConditionSelect')?.value || 'any';
    const condition = conditionRaw === 'count' ? 'any' : conditionRaw;

    let matchCount = 0;
    if (conditionRaw === 'count') {
        matchCount = parseInt($('candidateMatchCountInput')?.value || '2', 10);
        if (!Number.isFinite(matchCount) || matchCount < 1) matchCount = 2;
    }

    const normalizedTags = candidateTags
        .map(item => normalizePromptTokenForRule(item.text))
        .filter(Boolean);

    return {
        folder,
        prompt_mode: $('candidateScopeSelect')?.value || 'all',
        condition,
        condition_mode: conditionRaw,
        match_count: matchCount,
        tags: normalizedTags,
        prompt_text: normalizedTags.join(', '),
        live_direct_tags: [...normalizedTags],
        children: []
    };
}

function addCandidateAsTopRule() {
    const rule = buildRuleFromCandidate();
    if (!rule) return;

    setLiveRouteRuleDirectTags(rule, rule.tags);
    setLiveRouteRuleDirectCondition(rule, rule);
    liveTempRules.push(rule);
    recomputeAllLiveRouteOrTags();
    selectedTopRuleIndex = liveTempRules.length - 1;

    editingRuleTarget = null;
    liveRouteSelectedPathKeys.clear();
    liveRouteSelectedPathKeys.add(liveRoutePathKey([selectedTopRuleIndex]));
    liveRouteLastClickedPathKey = liveRoutePathKey([selectedTopRuleIndex]);

    clearCandidateTags();
    renderLiveRuleEditor();
}

function addCandidateAsChildRule() {
    const rule = buildRuleFromCandidate();
    if (!rule) return;

    const selectedPaths = [...liveRouteSelectedPathKeys]
        .map(parseLiveRoutePathKey)
        .filter(path => path.length > 0);

    let parentPath = null;

    if (selectedPaths.length === 1) {
        parentPath = selectedPaths[0];
    } else if (selectedTopRuleIndex >= 0) {
        parentPath = [selectedTopRuleIndex];
    }

    const parent = parentPath ? getLiveRouteRuleByPath(parentPath) : null;

    if (!parent) {
        alert('\uD558\uC704 \uADDC\uCE59\uC744 \uCD94\uAC00\uD560 \uADDC\uCE59\uC744 \uD558\uB098 \uC120\uD0DD\uD558\uC138\uC694.');
        return;
    }

    if (!Array.isArray(parent.children)) {
        parent.children = [];
    }

    setLiveRouteRuleDirectTags(rule, rule.tags);
    setLiveRouteRuleDirectCondition(rule, rule);
    parent.children.push(rule);
    recomputeAllLiveRouteOrTags();

    const childIndex = parent.children.length - 1;
    const childPath = [...parentPath, childIndex];

    editingRuleTarget = null;
    liveRouteSelectedPathKeys.clear();
    liveRouteSelectedPathKeys.add(liveRoutePathKey(childPath));
    liveRouteLastClickedPathKey = liveRoutePathKey(childPath);
    selectedTopRuleIndex = childPath[0];

    expandLiveRoutePath(parentPath);

    clearCandidateTags();
    renderLiveRuleEditor();
}

function ruleSummary(rule) {
    const tags = Array.isArray(rule.tags)
        ? rule.tags
        : splitPromptTags(rule.prompt_text || '');

    const scope = rule.prompt_mode || rule.scope || 'all';
    const condition = rule.condition || 'any';
    const conditionMode = rule.condition_mode || '';
    const matchCount = Number(rule.match_count || 0);

    const conditionLabel = conditionMode === 'count' || condition === 'count' || matchCount > 1
        ? `${Math.max(1, matchCount || 1)}\uAC1C \uC774\uC0C1`
        : condition === 'all'
            ? '\uBAA8\uB450'
            : '\uD558\uB098\uB77C\uB3C4';

    return {
        folder: rule.folder || '(\uD3F4\uB354 \uC5C6\uC74C)',
        tags,
        scope,
        conditionLabel
    };
}

function liveRoutePathKey(path) {
    return JSON.stringify(Array.isArray(path) ? path : []);
}

function parseLiveRoutePathKey(key) {
    try {
        const path = JSON.parse(key);
        return Array.isArray(path) ? path : [];
    } catch (e) {
        return [];
    }
}

function liveRouteParentPath(path) {
    return Array.isArray(path) ? path.slice(0, -1) : [];
}

function liveRouteSameParent(a, b) {
    return liveRoutePathKey(liveRouteParentPath(a)) === liveRoutePathKey(liveRouteParentPath(b));
}

function getLiveRouteContainerByParentPath(parentPath) {
    if (!Array.isArray(parentPath) || !parentPath.length) {
        return liveTempRules;
    }

    const parentRule = getLiveRouteRuleByPath(parentPath);
    if (!parentRule) return null;

    if (!Array.isArray(parentRule.children)) {
        parentRule.children = [];
    }

    return parentRule.children;
}

function getLiveRouteRuleByPath(path) {
    if (!Array.isArray(path) || !path.length) return null;

    let list = liveTempRules;
    let rule = null;

    for (const rawIndex of path) {
        const index = Number(rawIndex);
        if (!Array.isArray(list) || index < 0 || index >= list.length) {
            return null;
        }

        rule = list[index];
        list = rule.children || [];
    }

    return rule || null;
}

function collectLiveRouteRuleTags(rule) {
    const collected = [];
    const seen = new Set();

    function addTag(tag) {
        const clean = normalizePromptTokenForRule(tag);
        const key = normalizePromptTokenKey(clean);
        if (!clean || !key || seen.has(key)) return;
        seen.add(key);
        collected.push(clean);
    }

    function walk(item) {
        if (!item) return;

        if (Array.isArray(item.tags)) {
            item.tags.forEach(addTag);
        }

        splitPromptTags(item.prompt_text || '').forEach(addTag);

        if (Array.isArray(item.children)) {
            item.children.forEach(walk);
        }
    }

    walk(rule);
    return collected;
}

function makeLiveRouteGroupRule(folder, children) {
    const safeFolder = sanitizeRuleFolderName(folder || 'Group');
    const tags = [];

    const seen = new Set();
    (children || []).forEach(child => {
        collectLiveRouteRuleTags(child).forEach(tag => {
            const key = normalizePromptTokenKey(tag);
            if (!key || seen.has(key)) return;
            seen.add(key);
            tags.push(tag);
        });
    });

    return {
        folder: safeFolder,
        prompt_mode: 'all',
        condition: 'any',
        match_count: 1,
        tags,
        prompt_text: tags.join(', '),
        live_group_or_parent: true,
        children: children || []
    };
}

function mergeLiveRouteOrTagsIntoParent(parentRule, childRules) {
    if (!parentRule) return;

    const merged = [];
    const seen = new Set();

    function add(tag) {
        const clean = normalizePromptTokenForRule(tag);
        const key = normalizePromptTokenKey(clean);
        if (!clean || !key || seen.has(key)) return;
        seen.add(key);
        merged.push(clean);
    }

    if (Array.isArray(parentRule.tags)) {
        parentRule.tags.forEach(add);
    }

    splitPromptTags(parentRule.prompt_text || '').forEach(add);

    (childRules || []).forEach(child => {
        collectLiveRouteRuleTags(child).forEach(add);
    });

    parentRule.prompt_mode = parentRule.prompt_mode || 'all';
    parentRule.condition = 'any';
    parentRule.match_count = 1;
    parentRule.tags = merged;
    parentRule.prompt_text = merged.join(', ');
}

function normalizeLiveRouteTagList(values) {
    const seen = new Set();
    const result = [];

    (values || []).forEach(value => {
        const clean = normalizePromptTokenForRule(value);
        const key = normalizePromptTokenKey(clean);
        if (!clean || !key || seen.has(key)) return;
        seen.add(key);
        result.push(clean);
    });

    return result;
}

function getLiveRouteRuleDirectTags(rule) {
    if (!rule) return [];

    if (!Array.isArray(rule.live_direct_tags)) {
        const sourceTags = Array.isArray(rule.tags)
            ? rule.tags
            : splitPromptTags(rule.prompt_text || '');

        rule.live_direct_tags = normalizeLiveRouteTagList(sourceTags);
    }

    return normalizeLiveRouteTagList(rule.live_direct_tags);
}

function setLiveRouteRuleDirectTags(rule, tags) {
    if (!rule) return;
    rule.live_direct_tags = normalizeLiveRouteTagList(tags);
}

function ensureLiveRouteRuleDirectCondition(rule) {
    if (!rule) return;

    if (!rule.live_direct_prompt_mode) {
        rule.live_direct_prompt_mode = rule.prompt_mode || rule.scope || 'all';
    }

    if (!rule.live_direct_condition_mode) {
        if (rule.condition_mode) {
            rule.live_direct_condition_mode = rule.condition_mode;
        } else if (rule.condition === 'count' || Number(rule.match_count || 0) > 0) {
            rule.live_direct_condition_mode = 'count';
        } else {
            rule.live_direct_condition_mode = rule.condition || 'any';
        }
    }

    if (rule.live_direct_match_count === undefined || rule.live_direct_match_count === null) {
        rule.live_direct_match_count = Number(rule.match_count || 0);
    }

    if (!rule.live_direct_condition) {
        rule.live_direct_condition = rule.live_direct_condition_mode === 'count'
            ? 'any'
            : (rule.condition || 'any');
    }
}

function setLiveRouteRuleDirectCondition(rule, sourceRule) {
    if (!rule || !sourceRule) return;

    rule.live_direct_prompt_mode = sourceRule.prompt_mode || sourceRule.scope || 'all';
    rule.live_direct_condition = sourceRule.condition || 'any';
    rule.live_direct_condition_mode = sourceRule.condition_mode || sourceRule.condition || 'any';
    rule.live_direct_match_count = Number(sourceRule.match_count || 0);
}

function getLiveRouteRuleEditCondition(rule) {
    ensureLiveRouteRuleDirectCondition(rule);

    return {
        prompt_mode: rule.live_direct_prompt_mode || rule.prompt_mode || rule.scope || 'all',
        condition: rule.live_direct_condition || rule.condition || 'any',
        condition_mode: rule.live_direct_condition_mode || rule.condition_mode || rule.condition || 'any',
        match_count: Number(
            rule.live_direct_match_count !== undefined && rule.live_direct_match_count !== null
                ? rule.live_direct_match_count
                : rule.match_count || 0
        )
    };
}

function recomputeLiveRouteRuleOrTagsFromChildren(rule) {
    if (!rule) return;

    const ownTags = getLiveRouteRuleDirectTags(rule);
    const childTags = [];

    if (Array.isArray(rule.children)) {
        rule.children.forEach(child => {
            collectLiveRouteRuleTags(child).forEach(tag => childTags.push(tag));
        });
    }

    const merged = normalizeLiveRouteTagList([...ownTags, ...childTags]);

    rule.tags = merged;
    rule.prompt_text = merged.join(', ');

    if (Array.isArray(rule.children) && rule.children.length) {
        ensureLiveRouteRuleDirectCondition(rule);
        rule.prompt_mode = rule.prompt_mode || 'all';
        rule.condition = 'any';
        rule.condition_mode = 'any';
        rule.match_count = 1;
    }
}

function recomputeAllLiveRouteOrTags() {
    function walk(rule) {
        if (!rule) return;

        if (Array.isArray(rule.children)) {
            rule.children.forEach(walk);
        }

        recomputeLiveRouteRuleOrTagsFromChildren(rule);
    }

    liveTempRules.forEach(walk);
}

function canGroupLiveRouteSelection() {
    const paths = [...liveRouteSelectedPathKeys]
        .map(parseLiveRoutePathKey)
        .filter(path => path.length > 0);

    if (paths.length < 2) return false;

    const parentKey = liveRoutePathKey(liveRouteParentPath(paths[0]));
    return paths.every(path => liveRoutePathKey(liveRouteParentPath(path)) === parentKey);
}

function renderLiveRouteToolbarState() {
    renderLiveInlineGroupControl();
}

function getLiveRouteSelectedPaths() {
    return [...liveRouteSelectedPathKeys]
        .map(parseLiveRoutePathKey)
        .filter(path => path.length > 0);
}

function getLiveRouteSelectionParentKey() {
    const paths = getLiveRouteSelectedPaths();
    if (!paths.length) return '';

    const parentKey = liveRoutePathKey(liveRouteParentPath(paths[0]));
    return paths.every(path => liveRoutePathKey(liveRouteParentPath(path)) === parentKey)
        ? parentKey
        : '';
}

function getLiveRouteSelectedChipBounds() {
    const chips = [...liveRouteSelectedPathKeys]
        .map(key => document.querySelector(`.live-route-rule-chip[data-live-route-path="${CSS.escape(key)}"]`))
        .filter(Boolean);

    if (!chips.length) return null;

    const rects = chips.map(chip => chip.getBoundingClientRect());
    const left = Math.min(...rects.map(r => r.left));
    const right = Math.max(...rects.map(r => r.right));
    const top = Math.min(...rects.map(r => r.top));
    const bottom = Math.max(...rects.map(r => r.bottom));

    return { left, right, top, bottom, width: right - left, height: bottom - top };
}

function renderLiveInlineGroupControl() {
    const box = $('liveInlineGroupBox');
    const cardView = $('liveRouteCardView');
    if (!box || !cardView) return;

    if (!canGroupLiveRouteSelection()) {
        box.style.display = 'none';
        box.innerHTML = '';
        liveRouteInlineGroupState = { mode: 'button', parentKey: '', anchorKey: '' };
        return;
    }

    const bounds = getLiveRouteSelectedChipBounds();
    if (!bounds) {
        box.style.display = 'none';
        box.innerHTML = '';
        return;
    }

    const parentKey = getLiveRouteSelectionParentKey();
    const anchorKey = [...liveRouteSelectedPathKeys][0] || '';

    if (
        liveRouteInlineGroupState.parentKey !== parentKey ||
        liveRouteInlineGroupState.anchorKey !== anchorKey
    ) {
        liveRouteInlineGroupState = {
            mode: 'button',
            parentKey,
            anchorKey
        };
    }

    const viewRect = cardView.getBoundingClientRect();
    const left = Math.max(8, bounds.left - viewRect.left + bounds.width / 2);
    const top = Math.max(8, bounds.top - viewRect.top - 44);

    box.style.display = '';
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;

    if (liveRouteInlineGroupState.mode === 'input') {
        box.innerHTML = `
            <div class="inline-group-input-wrap">
                <input id="inlineGroupNameInput" type="text" value="New_Group" placeholder="\uC0C1\uC704 \uADDC\uCE59 \uC774\uB984">
                <button onclick="confirmInlineGroupRules()">\uC0DD\uC131</button>
                <button onclick="cancelInlineGroupRules()">\uCDE8\uC18C</button>
            </div>
        `;

        setTimeout(() => {
            const input = $('inlineGroupNameInput');
            if (input) {
                input.focus();
                input.select();
                input.onkeydown = (event) => {
                    if (event.key === 'Enter') {
                        confirmInlineGroupRules();
                    } else if (event.key === 'Escape') {
                        cancelInlineGroupRules();
                    }
                };
            }
        }, 0);

        return;
    }

    box.innerHTML = `
        <button class="inline-group-button" onclick="beginInlineGroupRules()">\uADF8\uB8F9\uBB36\uAE30</button>
    `;
}

function beginInlineGroupRules() {
    if (!canGroupLiveRouteSelection()) return;

    liveRouteInlineGroupState.mode = 'input';
    renderLiveInlineGroupControl();
}

function cancelInlineGroupRules() {
    liveRouteInlineGroupState.mode = 'button';
    renderLiveInlineGroupControl();
}

function confirmInlineGroupRules() {
    const input = $('inlineGroupNameInput');
    const name = input ? input.value.trim() : '';

    if (!name) {
        alert('\uC0C1\uC704 \uADDC\uCE59 \uC774\uB984\uC744 \uC785\uB825\uD558\uC138\uC694.');
        return;
    }

    groupSelectedLiveRouteRulesWithName(name);
}

function getLiveRouteSelectedSiblingPaths(parentPath) {
    const parentKey = liveRoutePathKey(parentPath);

    return [...liveRouteSelectedPathKeys]
        .map(parseLiveRoutePathKey)
        .filter(path => liveRoutePathKey(liveRouteParentPath(path)) === parentKey)
        .sort((a, b) => a[a.length - 1] - b[b.length - 1]);
}

function clearLiveRouteSelection() {
    liveRouteSelectedPathKeys.clear();
    liveRouteLastClickedPathKey = '';
}

function normalizeSelectedTopRuleFromSelection() {
    const selectedPaths = [...liveRouteSelectedPathKeys].map(parseLiveRoutePathKey);
    const topPath = selectedPaths.find(path => path.length === 1);

    if (topPath) {
        selectedTopRuleIndex = topPath[0];
        return;
    }

    const childPath = selectedPaths.find(path => path.length >= 2);
    if (childPath) {
        selectedTopRuleIndex = childPath[0];
    }
}

function renderLiveRuleEditor() {
    normalizeSelectedTopRuleFromSelection();
    renderLiveRouteTree();
    renderCandidateEditState();
    renderLiveInlineGroupControl();
    bindLiveRoutePointerHandlers();
}

function renderLiveRouteTree() {
    const root = $('liveRuleTree');
    if (!root) return;

    root.dataset.liveParentPath = '[]';

    if (!liveTempRules.length) {
        root.innerHTML = '<div class="rule-empty">\uC784\uC2DC \uC815\uBC00 \uB77C\uC6B0\uD305 \uADDC\uCE59 \uC5C6\uC74C</div>';
        return;
    }

    root.innerHTML = `
        <div class="live-route-top-list">
            ${liveTempRules.map((rule, index) => renderLiveRouteRuleBlock(rule, [index], 0)).join('')}
        </div>
    `;
}

function renderLiveRouteRuleBlock(rule, path, depth) {
    const s = ruleSummary(rule);
    const key = liveRoutePathKey(path);
    const selected = liveRouteSelectedPathKeys.has(key);
    const expanded = liveRouteExpandedPathKeys.has(key);
    const children = Array.isArray(rule.children) ? rule.children : [];
    const hasChildren = children.length > 0;
    const parentPath = liveRouteParentPath(path);

    return `
        <div class="live-route-rule-block ${hasChildren ? 'has-children' : ''} ${expanded ? 'expanded' : ''}"
             data-live-route-block-path="${escapeHtml(key)}"
             style="--route-depth:${depth};">
            <div class="live-route-rule-line">
                ${
                    hasChildren
                        ? `
                            <button type="button"
                                    class="live-route-expand-mini"
                                    title="${expanded ? '\uD558\uC704 \uADDC\uCE59 \uC811\uAE30' : '\uD558\uC704 \uADDC\uCE59 \uD3BC\uCE58\uAE30'}"
                                    onclick='toggleLiveRouteExpanded(event, ${JSON.stringify(path)})'
                                    onpointerdown="event.preventDefault(); event.stopPropagation();">
                                ${expanded ? '-' : '+'}
                            </button>
                        `
                        : `<span class="live-route-expand-spacer"></span>`
                }

                <button type="button"
                        class="live-route-rule-chip ${selected ? 'selected' : ''}"
                        data-live-route-path="${escapeHtml(key)}"
                        data-live-route-parent="${escapeHtml(liveRoutePathKey(parentPath))}"
                        title="${escapeHtml(s.tags.join(', '))}"
                        onclick='handleLiveRouteChipClick(event, ${JSON.stringify(path)})'
                        ondblclick='handleLiveRouteChipDoubleClick(event, ${JSON.stringify(path)})'>
                    <span class="live-route-chip-name">${escapeHtml(s.folder)}</span>
                    <span class="live-route-chip-sub">${escapeHtml(s.scope)} · ${escapeHtml(s.conditionLabel)} · \uAC1C\uBCC4 ${escapeHtml(s.tags.length)}\uAC1C</span>
                    ${hasChildren ? `<span class="live-route-child-count">\uD558\uC704 ${children.length}</span>` : ''}
                </button>
            </div>

            ${
                hasChildren && expanded
                    ? `
                        <div class="live-route-children-wrap">
                            ${children.map((child, index) => renderLiveRouteRuleBlock(child, [...path, index], depth + 1)).join('')}
                        </div>
                    `
                    : ''
            }
        </div>
    `;
}
function renderTopRules() {
    renderLiveRouteTree();
}

function renderChildRules() {
    renderLiveRouteTree();
}

function renderLiveRouteChip(rule, path, kind) {
    return renderLiveRouteRuleBlock(rule, path, kind === 'top' ? 0 : 1);
}

function toggleLiveRouteExpanded(event, path) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }

    const key = liveRoutePathKey(path);
    if (!key) return;

    if (liveRouteExpandedPathKeys.has(key)) {
        liveRouteExpandedPathKeys.delete(key);
    } else {
        liveRouteExpandedPathKeys.add(key);
    }

    liveRouteDragState = null;
    liveRouteDropTarget = null;
    clearLiveRouteDropTarget();
    document.body.classList.remove('live-route-dragging');

    renderLiveRuleEditor();
}

function expandLiveRoutePath(path) {
    if (!Array.isArray(path)) return;

    for (let i = 1; i <= path.length; i++) {
        liveRouteExpandedPathKeys.add(liveRoutePathKey(path.slice(0, i)));
    }
}

function handleLiveRouteChipClick(event, path) {
    if (event.detail >= 2) return;

    event.preventDefault();
    event.stopPropagation();

    const key = liveRoutePathKey(path);

    if (liveRouteSuppressNextClickKey === key) {
        liveRouteSuppressNextClickKey = '';
        return;
    }

    if (event.shiftKey && liveRouteLastClickedPathKey) {
        selectLiveRouteRange(liveRouteLastClickedPathKey, key);
        liveRouteLastClickedPathKey = key;
        renderLiveRuleEditor();
        return;
    }

    if (event.ctrlKey || event.metaKey) {
        if (liveRouteSelectedPathKeys.has(key)) {
            liveRouteSelectedPathKeys.delete(key);
        } else {
            liveRouteSelectedPathKeys.add(key);
        }

        liveRouteLastClickedPathKey = key;
        renderLiveRuleEditor();
        return;
    }

    // ?�일 ?�릭?� ??�� ?�당 버튼 ?�나�??�택?�다.
    // ?��? ?�택??버튼???�시 ?�릭?�도 ?�택 ?�제?��? ?�는??
    liveRouteSelectedPathKeys.clear();
    liveRouteSelectedPathKeys.add(key);
    liveRouteLastClickedPathKey = key;
    selectedTopRuleIndex = path[0] ?? selectedTopRuleIndex;

    renderLiveRuleEditor();
}

function selectLiveRouteRange(fromKey, toKey) {
    const fromPath = parseLiveRoutePathKey(fromKey);
    const toPath = parseLiveRoutePathKey(toKey);

    if (!liveRouteSameParent(fromPath, toPath)) {
        liveRouteSelectedPathKeys.add(toKey);
        return;
    }

    const parentPath = liveRouteParentPath(toPath);
    const list = getLiveRouteContainerByParentPath(parentPath);

    if (!Array.isArray(list)) {
        liveRouteSelectedPathKeys.add(toKey);
        return;
    }

    const fromIndex = fromPath[fromPath.length - 1];
    const toIndex = toPath[toPath.length - 1];
    const start = Math.min(fromIndex, toIndex);
    const end = Math.max(fromIndex, toIndex);

    for (let i = start; i <= end; i++) {
        liveRouteSelectedPathKeys.add(liveRoutePathKey([...parentPath, i]));
    }
}

function handleLiveRouteChipDoubleClick(event, path) {
    event.preventDefault();
    event.stopPropagation();
    beginEditLiveRouteRule(path);
}

function moveLiveRouteSelectedGroup(parentPath, targetIndex) {
    const list = getLiveRouteContainerByParentPath(parentPath);
    if (!Array.isArray(list)) return;

    const selectedPaths = getLiveRouteSelectedSiblingPaths(parentPath);
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

    liveRouteSelectedPathKeys.clear();

    movingItems.forEach(item => {
        const newIndex = list.indexOf(item);
        if (newIndex >= 0) {
            liveRouteSelectedPathKeys.add(liveRoutePathKey([...parentPath, newIndex]));
        }
    });

    normalizeSelectedTopRuleFromSelection();
    renderLiveRuleEditor();
}

function bindLiveRoutePointerHandlers() {
    const root = $('liveRouteCardView');
    if (!root || root.dataset.liveRouteBound === '1') return;

    root.dataset.liveRouteBound = '1';
    root.addEventListener('pointerdown', handleLiveRoutePointerDown);

    document.addEventListener('pointermove', handleLiveRoutePointerMove);
    document.addEventListener('pointerup', handleLiveRoutePointerUp);
    document.addEventListener('pointercancel', handleLiveRoutePointerCancel);
}

function handleLiveRoutePointerDown(event) {
    if (event.button !== 0) return;

    if (
        event.target.closest('.live-route-expand-mini') ||
        event.target.closest('.live-inline-group-box') ||
        event.target.closest('input, select, textarea')
    ) {
        return;
    }

    const chip = event.target.closest('.live-route-rule-chip');
    if (!chip) return;

    const path = parseLiveRoutePathKey(chip.dataset.liveRoutePath || '[]');
    if (!path.length) return;

    const parentPath = liveRouteParentPath(path);
    const key = liveRoutePathKey(path);

    liveRouteDragState = {
        parentPath,
        startX: event.clientX,
        startY: event.clientY,
        dragging: false,
        pointerId: event.pointerId,
        startKey: key,
        startPath: path,
        startedOnSelected: liveRouteSelectedPathKeys.has(key),
        clickHadModifier: !!(event.ctrlKey || event.metaKey || event.shiftKey)
    };

}

function handleLiveRoutePointerMove(event) {
    if (!liveRouteDragState) return;

    const dx = Math.abs(event.clientX - liveRouteDragState.startX);
    const dy = Math.abs(event.clientY - liveRouteDragState.startY);

    if (!liveRouteDragState.dragging && (dx > 6 || dy > 6)) {
        liveRouteDragState.dragging = true;
        document.body.classList.add('live-route-dragging');

        // ?�택 ????버튼??바로 ?�래그하�?�?버튼 ?�나�??�택?????�동?�다.
        if (!liveRouteDragState.startedOnSelected && !liveRouteDragState.clickHadModifier) {
            liveRouteSelectedPathKeys.clear();
            liveRouteSelectedPathKeys.add(liveRouteDragState.startKey);
            liveRouteLastClickedPathKey = liveRouteDragState.startKey;
            selectedTopRuleIndex = liveRouteDragState.startPath[0] ?? selectedTopRuleIndex;
        }

        document
            .querySelectorAll('.live-route-rule-chip.drag-source')
            .forEach(el => el.classList.remove('drag-source'));

        [...liveRouteSelectedPathKeys].forEach(key => {
            document
                .querySelector(`.live-route-rule-chip[data-live-route-path="${CSS.escape(key)}"]`)
                ?.classList.add('selected', 'drag-source');
        });

        renderLiveInlineGroupControl();
    }

    if (!liveRouteDragState.dragging) return;

    event.preventDefault();

    const targetChip = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.live-route-rule-chip');

    if (!targetChip) {
        clearLiveRouteDropTarget();
        return;
    }

    const targetPath = parseLiveRoutePathKey(targetChip.dataset.liveRoutePath || '[]');
    const selectedPaths = [...liveRouteSelectedPathKeys].map(parseLiveRoutePathKey);

    if (!targetPath.length) {
        clearLiveRouteDropTarget();
        return;
    }

    // ?�기 ?�신 ?�에???�롭?��? ?�는??
    if (selectedPaths.some(path => liveRoutePathKey(path) === liveRoutePathKey(targetPath))) {
        clearLiveRouteDropTarget();
        return;
    }

    // ?�기 ?�위로는 ?�롭?��? ?�는??
    if (selectedPaths.some(path => isLiveRouteAncestorPath(path, targetPath))) {
        clearLiveRouteDropTarget();
        return;
    }

    const rect = targetChip.getBoundingClientRect();
    const xRatio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5;
    const yRatio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;

    let mode = 'inside';

    // 가?�자�?= 같�? 부�????�치 ?�동
    // 중앙 = ?�당 규칙???�위 규칙?�로 ?�동
    if (xRatio < 0.2 || yRatio < 0.2) {
        mode = 'before';
    } else if (xRatio > 0.8 || yRatio > 0.8) {
        mode = 'after';
    }

    const targetParentPath = liveRouteParentPath(targetPath);

    if (mode === 'before' || mode === 'after') {
        const sourceParentKey = liveRoutePathKey(liveRouteDragState.parentPath);
        const targetParentKey = liveRoutePathKey(targetParentPath);

        if (sourceParentKey !== targetParentKey) {
            clearLiveRouteDropTarget();
            return;
        }
    }

    liveRouteDropTarget = {
        mode,
        targetPath,
        parentPath: targetParentPath,
        targetIndex: targetPath[targetPath.length - 1] + (mode === 'after' ? 1 : 0)
    };

    clearLiveRouteDropTargetClasses();

    if (mode === 'before') {
        targetChip.classList.add('drop-before');
    } else if (mode === 'after') {
        targetChip.classList.add('drop-after');
    } else {
        targetChip.classList.add('drop-inside', 'drop-parent-active');
    }
}
function handleLiveRoutePointerUp(event) {
    if (!liveRouteDragState) return;

    const wasDragging = !!liveRouteDragState.dragging;

    if (wasDragging && liveRouteDropTarget) {
        if (liveRouteDropTarget.mode === 'inside') {
            moveSelectedLiveRouteRulesIntoParent(liveRouteDropTarget.targetPath);
        } else {
            moveLiveRouteSelectedGroup(
                liveRouteDropTarget.parentPath,
                liveRouteDropTarget.targetIndex
            );
        }
    }

    if (wasDragging) {
        const targetChip = event.target.closest?.('.live-route-rule-chip');
        if (targetChip) {
            liveRouteSuppressNextClickKey = targetChip.dataset.liveRoutePath || '';
        }
    }

    liveRouteDragState = null;
    clearLiveRouteDropTarget();
    document.body.classList.remove('live-route-dragging');

    if (!wasDragging) {
        return;
    }

    renderLiveRuleEditor();
}
function handleLiveRoutePointerCancel() {
    liveRouteDragState = null;
    clearLiveRouteDropTarget();
    document.body.classList.remove('live-route-dragging');
}

function clearLiveRouteDropTargetClasses() {
    document
        .querySelectorAll('.live-route-rule-chip.drop-before, .live-route-rule-chip.drop-after, .live-route-rule-chip.drop-inside, .live-route-rule-chip.drop-parent-active')
        .forEach(el => el.classList.remove('drop-before', 'drop-after', 'drop-inside', 'drop-parent-active'));
}

function clearLiveRouteDropTarget() {
    liveRouteDropTarget = null;
    clearLiveRouteDropTargetClasses();

    document
        .querySelectorAll('.live-route-rule-chip.drag-source')
        .forEach(el => el.classList.remove('drag-source'));
}
function isLiveRouteAncestorPath(parentPath, childPath) {
    if (!Array.isArray(parentPath) || !Array.isArray(childPath)) return false;
    if (parentPath.length >= childPath.length) return false;

    return parentPath.every((value, index) => value === childPath[index]);
}

function removeLiveRouteRulesByPaths(paths) {
    const sorted = paths
        .filter(path => Array.isArray(path) && path.length > 0)
        .sort((a, b) => {
            if (a.length !== b.length) return b.length - a.length;
            const parentCompare = liveRoutePathKey(liveRouteParentPath(b)).localeCompare(liveRoutePathKey(liveRouteParentPath(a)));
            if (parentCompare !== 0) return parentCompare;
            return b[b.length - 1] - a[a.length - 1];
        });

    sorted.forEach(path => {
        const parentPath = liveRouteParentPath(path);
        const list = getLiveRouteContainerByParentPath(parentPath);
        const index = path[path.length - 1];

        if (Array.isArray(list) && index >= 0 && index < list.length) {
            list.splice(index, 1);
        }
    });
}

function moveSelectedLiveRouteRulesIntoParent(targetPath) {
    const targetRule = getLiveRouteRuleByPath(targetPath);
    if (!targetRule) return;

    const targetRef = targetRule;

    const selectedPaths = [...liveRouteSelectedPathKeys]
        .map(parseLiveRoutePathKey)
        .filter(path => path.length > 0)
        .filter(path => liveRoutePathKey(path) !== liveRoutePathKey(targetPath))
        .filter(path => !isLiveRouteAncestorPath(path, targetPath));

    if (!selectedPaths.length) return;

    const movingRules = selectedPaths
        .map(path => getLiveRouteRuleByPath(path))
        .filter(Boolean);

    if (!movingRules.length) return;

    removeLiveRouteRulesByPaths(selectedPaths);

    if (!Array.isArray(targetRef.children)) {
        targetRef.children = [];
    }

    targetRef.children.push(...movingRules);
    recomputeAllLiveRouteOrTags();

    const targetAfterMovePath = findLiveRouteRulePathByRef(targetRef);
    if (targetAfterMovePath) {
        expandLiveRoutePath(targetAfterMovePath);
        selectedTopRuleIndex = targetAfterMovePath[0] ?? selectedTopRuleIndex;
    }

    liveRouteSelectedPathKeys.clear();

    movingRules.forEach(rule => {
        const newPath = findLiveRouteRulePathByRef(rule);
        if (newPath) {
            liveRouteSelectedPathKeys.add(liveRoutePathKey(newPath));
        }
    });

    renderLiveRuleEditor();
}

function findLiveRouteRulePathByRef(targetRule) {
    let found = null;

    function walk(list, parentPath) {
        if (found || !Array.isArray(list)) return;

        list.forEach((rule, index) => {
            if (found) return;

            const path = [...parentPath, index];

            if (rule === targetRule) {
                found = path;
                return;
            }

            walk(rule.children || [], path);
        });
    }

    walk(liveTempRules, []);
    return found;
}

function selectTopRule(index) {
    selectedTopRuleIndex = index;
    renderLiveRuleEditor();
}

function moveArrayItem(arr, index, delta) {
    const next = index + delta;
    if (!Array.isArray(arr) || next < 0 || next >= arr.length) return index;

    const [item] = arr.splice(index, 1);
    arr.splice(next, 0, item);
    return next;
}

function moveTopRule(index, delta) {
    selectedTopRuleIndex = moveArrayItem(liveTempRules, index, delta);
    renderLiveRuleEditor();
}

function moveChildRule(index, delta) {
    const parent = liveTempRules[selectedTopRuleIndex];
    if (!parent || !Array.isArray(parent.children)) return;
    moveArrayItem(parent.children, index, delta);
    renderLiveRuleEditor();
}

function deleteTopRule(index) {
    if (!confirm('\uC0C1\uC704 \uADDC\uCE59\uC744 \uC0AD\uC81C\uD560\uAE4C\uC694? \uD558\uC704 \uADDC\uCE59\uB3C4 \uD568\uAED8 \uC0AD\uC81C\uB429\uB2C8\uB2E4.')) return;

    liveTempRules.splice(index, 1);

    if (selectedTopRuleIndex >= liveTempRules.length) {
        selectedTopRuleIndex = liveTempRules.length - 1;
    }

    renderLiveRuleEditor();
}

function deleteChildRule(index) {
    const parent = liveTempRules[selectedTopRuleIndex];
    if (!parent || !Array.isArray(parent.children)) return;

    parent.children.splice(index, 1);
    renderLiveRuleEditor();
}

function fillCandidateFromRule(rule) {
    $('candidateFolderInput').value = rule.folder || '';

    const editCondition = getLiveRouteRuleEditCondition(rule);
    $('candidateScopeSelect').value = editCondition.prompt_mode || 'all';

    if (editCondition.condition_mode === 'count' || editCondition.condition === 'count') {
        $('candidateConditionSelect').value = 'count';
        $('candidateMatchCountInput').value = Math.max(1, editCondition.match_count || 1);
    } else {
        $('candidateConditionSelect').value = editCondition.condition || 'any';
        $('candidateMatchCountInput').value = 2;
    }

    const editTags = getLiveRouteRuleDirectTags(rule);

    candidateTags = editTags.map(tag => {
        const text = normalizePromptTokenForRule(tag);
        return {
            key: normalizePromptTokenKey(text),
            text,
            source: 'edit'
        };
    }).filter(item => item.key && item.text);

    candidateTagTextDraft = candidateTagsToText();
    renderCandidateTags();
}

function readCandidateIntoRule(targetRule) {
    const rule = buildRuleFromCandidate();
    if (!rule) return false;

    targetRule.folder = rule.folder;
    targetRule.prompt_mode = rule.prompt_mode;
    targetRule.condition = rule.condition;
    targetRule.condition_mode = rule.condition_mode;
    targetRule.match_count = rule.match_count;
    targetRule.tags = rule.tags;
    targetRule.prompt_text = rule.prompt_text;
    targetRule.live_direct_tags = [...rule.tags];
    setLiveRouteRuleDirectCondition(targetRule, rule);

    if (!Array.isArray(targetRule.children)) {
        targetRule.children = [];
    }

    return true;
}

function editTopRule(index) {
    beginEditLiveRouteRule([index]);
}

function editChildRule(index) {
    if (selectedTopRuleIndex < 0) return;
    beginEditLiveRouteRule([selectedTopRuleIndex, index]);
}

function beginEditLiveRouteRule(path) {
    const rule = getLiveRouteRuleByPath(path);
    if (!rule) return;

    editingRuleTarget = { path: [...path] };

    if (path.length >= 1) {
        selectedTopRuleIndex = path[0];
    }

    liveRouteSelectedPathKeys.clear();
    liveRouteSelectedPathKeys.add(liveRoutePathKey(path));
    liveRouteLastClickedPathKey = liveRoutePathKey(path);

    fillCandidateFromRule(rule);
    renderLiveRuleEditor();

    const input = $('candidateFolderInput');
    if (input) input.focus();
}

function editSelectedLiveRouteRule() {
    const paths = [...liveRouteSelectedPathKeys].map(parseLiveRoutePathKey);
    if (paths.length !== 1) {
        alert('\uC218\uC815\uD560 \uADDC\uCE59\uC744 \uD558\uB098\uB9CC \uC120\uD0DD\uD558\uC138\uC694.');
        return;
    }

    beginEditLiveRouteRule(paths[0]);
}

function applyCandidateEdit() {
    if (!editingRuleTarget || !Array.isArray(editingRuleTarget.path)) {
        alert('\uC218\uC815 \uC911\uC778 \uADDC\uCE59\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.');
        return;
    }

    const targetRule = getLiveRouteRuleByPath(editingRuleTarget.path);

    if (!targetRule) {
        alert('\uC218\uC815\uD560 \uADDC\uCE59\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.');
        editingRuleTarget = null;
        renderLiveRuleEditor();
        return;
    }

    if (!readCandidateIntoRule(targetRule)) return;
    recomputeAllLiveRouteOrTags();

    if (editingRuleTarget && Array.isArray(editingRuleTarget.path)) {
        expandLiveRoutePath(editingRuleTarget.path);
        liveRouteSelectedPathKeys.clear();
        liveRouteSelectedPathKeys.add(liveRoutePathKey(editingRuleTarget.path));
        selectedTopRuleIndex = editingRuleTarget.path[0] ?? selectedTopRuleIndex;
    }

    editingRuleTarget = null;
    showLiveFlashMessage('\uADDC\uCE59 \uC218\uC815\uC774 \uC801\uC6A9\uB418\uC5C8\uC2B5\uB2C8\uB2E4.');
    renderLiveRuleEditor();
}

function showLiveFlashMessage(message) {
    let box = $('liveFlashMessage');

    if (!box) {
        box = document.createElement('div');
        box.id = 'liveFlashMessage';
        box.className = 'live-flash-message';
        document.body.appendChild(box);
    }

    box.textContent = message;
    box.classList.add('show');

    clearTimeout(box._hideTimer);
    box._hideTimer = setTimeout(() => {
        box.classList.remove('show');
    }, 1800);
}
function cancelCandidateEdit() {
    editingRuleTarget = null;
    clearCandidateTags();

    const folderInput = $('candidateFolderInput');
    if (folderInput) folderInput.value = '';

    renderLiveRuleEditor();
}

function renderCandidateEditState() {
    const applyBtn = $('applyCandidateEditBtn');
    const cancelBtn = $('cancelCandidateEditBtn');

    if (!applyBtn || !cancelBtn) return;

    const editing = !!editingRuleTarget;
    applyBtn.style.display = editing ? '' : 'none';
    cancelBtn.style.display = editing ? '' : 'none';

    if (editing) {
        applyBtn.textContent = '\uC120\uD0DD \uADDC\uCE59 \uC218\uC815 \uC801\uC6A9';
    }
}

function deleteSelectedLiveRouteRules() {
    const paths = [...liveRouteSelectedPathKeys]
        .map(parseLiveRoutePathKey)
        .filter(path => path.length > 0);

    if (!paths.length) {
        alert('\uC0AD\uC81C\uD560 \uADDC\uCE59\uC744 \uC120\uD0DD\uD558\uC138\uC694.');
        return;
    }

    if (!confirm(`\uC120\uD0DD\uD55C \uADDC\uCE59 ${paths.length}\uAC1C\uB97C \uC0AD\uC81C\uD560\uAE4C\uC694? \uD558\uC704 \uADDC\uCE59\uB3C4 \uD568\uAED8 \uC0AD\uC81C\uB429\uB2C8\uB2E4.`)) return;

    removeLiveRouteRulesByPaths(paths);
    recomputeAllLiveRouteOrTags();

    editingRuleTarget = null;
    clearLiveRouteSelection();

    if (selectedTopRuleIndex >= liveTempRules.length) {
        selectedTopRuleIndex = liveTempRules.length - 1;
    }

    renderLiveRuleEditor();
}

function groupSelectedLiveRouteRules() {
    beginInlineGroupRules();
}

function groupSelectedLiveRouteRulesWithName(folderName) {
    const selectedPaths = getLiveRouteSelectedPaths();

    if (selectedPaths.length < 2) {
        alert('\uBB36\uC744 \uADDC\uCE59\uC744 \uB450 \uAC1C \uC774\uC0C1 \uC120\uD0DD\uD558\uC138\uC694.');
        return;
    }

    const parentPath = liveRouteParentPath(selectedPaths[0]);
    const parentKey = liveRoutePathKey(parentPath);

    if (!selectedPaths.every(path => liveRoutePathKey(liveRouteParentPath(path)) === parentKey)) {
        alert('\uAC19\uC740 \uBD80\uBAA8 \uC548\uC758 \uADDC\uCE59\uB9CC \uBB36\uC744 \uC218 \uC788\uC2B5\uB2C8\uB2E4.');
        return;
    }

    const list = getLiveRouteContainerByParentPath(parentPath);
    if (!Array.isArray(list)) return;

    const indices = selectedPaths
        .map(path => path[path.length - 1])
        .filter(index => index >= 0 && index < list.length)
        .sort((a, b) => a - b);

    if (indices.length < 2) return;

    const selectedSet = new Set(indices);
    const children = indices.map(index => list[index]);
    const insertIndex = indices[0];
    const groupRule = makeLiveRouteGroupRule(folderName, children);
    setLiveRouteRuleDirectTags(groupRule, []);
    setLiveRouteRuleDirectCondition(groupRule, groupRule);
    const remaining = list.filter((_, index) => !selectedSet.has(index));

    remaining.splice(insertIndex, 0, groupRule);
    list.splice(0, list.length, ...remaining);
    recomputeAllLiveRouteOrTags();

    const newPath = [...parentPath, insertIndex];

    liveRouteSelectedPathKeys.clear();
    liveRouteSelectedPathKeys.add(liveRoutePathKey(newPath));
    liveRouteLastClickedPathKey = liveRoutePathKey(newPath);
    selectedTopRuleIndex = newPath[0] ?? 0;
    liveRouteInlineGroupState = { mode: 'button', parentKey: '', anchorKey: '' };

    expandLiveRoutePath(newPath);
    renderLiveRuleEditor();
}

async function loadPreviewTree(options = {}) {
    const preservePath = !!options.preservePath;
    const previousPathParts = preservePath ? getLiveCurrentPathParts() : [];

    try {
        await ensureLiveRulesLoaded();

        const data = await apiPost('/api/live_classifier/preview_tree', {
            mode: liveMode,
            rules: liveTempRules,
            use_char_id: useCharId,
            per_folder_limit: getPerFolderLimitValue(),
            no_metadata_limit: liveNoMetadataDisplayLimit
        });

        const preview = data.preview;
        if (!preview || !preview.has_preview) {
            liveRootTree = preview?.tree || null;
            liveCurrentPath = liveRootTree ? [liveRootTree] : [];
            $('previewGallery').innerHTML = '';
            $('liveNavTabs').innerHTML = '';
            $('liveBreadcrumbPath').innerHTML = '<span>\u2302 HOME</span>';
            $('galleryState').style.display = '';
            $('galleryState').innerText = '\uC800\uC7A5\uB41C \uBBF8\uB9AC\uBCF4\uAE30 \uACB0\uACFC\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4. \uC7AC\uBD84\uB958\uB97C \uB20C\uB7EC \uBBF8\uB9AC\uBCF4\uAE30\uB97C \uC0DD\uC131\uD558\uC138\uC694.';
            return;
        }

        renderPreviewTreePayload(preview, {
            preservePath,
            previousPathParts
        });
    } catch (error) {
        $('galleryState').style.display = '';
        $('galleryState').innerText = `\uBBF8\uB9AC\uBCF4\uAE30 \uB85C\uB4DC \uC2E4\uD328: ${error.message}`;
    }
}

async function loadRandomImage() {
    try {
        await ensureLiveRulesLoaded();

        const data = await apiPost('/api/live_classifier/random_image', {
            mode: liveMode,
            rules: liveTempRules,
            use_char_id: useCharId,
            unclassified_only: true
        });

        renderSelectedImage(data.item);

        if (data.fallback_all) {
            showLiveFlashMessage('\uBBF8\uBD84\uB958 \uC774\uBBF8\uC9C0\uAC00 \uC5C6\uC5B4 \uC804\uCCB4 \uC774\uBBF8\uC9C0\uC5D0\uC11C \uB79C\uB364\uC73C\uB85C \uBD88\uB7EC\uC654\uC2B5\uB2C8\uB2E4.');
        }
    } catch (error) {
        $('selectedImageBox').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    }
}

async function loadPrompt(path) {
    selectedImagePath = path;

    try {
        const data = await apiGet(`/api/live_classifier/prompt?path=${encodeURIComponent(path)}`);
        renderSelectedImage(data.item);
    } catch (error) {
        alert(`\uD504\uB86C\uD504\uD2B8 \uB85C\uB4DC \uC2E4\uD328: ${error.message}`);
    }
}

function renderSelectedImage(item) {
    if (!item) return;

    selectedImagePath = item.workspace_rel_path;
    $('selectedImageBox').innerHTML = `<img src="${imageUrl(item.workspace_rel_path)}" alt="">`;

    const meta = document.createElement('div');
    meta.className = 'selected-meta';
    meta.innerHTML = `
        <b>${escapeHtml(item.file_name || '')}</b><br>
        \uACBD\uB85C: ${escapeHtml(item.workspace_rel_path || '')}<br>
        \uD574\uC0C1\uB3C4: ${escapeHtml(item.width || 0)} \u00D7 ${escapeHtml(item.height || 0)}<br>
        \uBA54\uD0C0: ${escapeHtml(item.meta_source || 'none')}<br>
        \uC0C1\uD0DC: ${escapeHtml(item.status || '')}
    `;

    const oldMeta = document.querySelector('.selected-meta');
    if (oldMeta) oldMeta.remove();
    $('selectedImageBox').insertAdjacentElement('afterend', meta);

    $('basePromptBox').textContent = item.base_prompt || '';
    let baseTokenBox = document.getElementById('basePromptTokenBox');
    if (!baseTokenBox) {
        baseTokenBox = document.createElement('div');
        baseTokenBox.id = 'basePromptTokenBox';
        baseTokenBox.className = 'prompt-token-box';
        $('basePromptBox').insertAdjacentElement('afterend', baseTokenBox);
    }
    renderClickablePromptTags(baseTokenBox, item.base_prompt || '', 'base');

    const charBox = $('charPromptBox');
    charBox.innerHTML = '';
    const chars = Array.isArray(item.char_prompts) ? item.char_prompts : [];

    if (!chars.length) {
        charBox.innerHTML = '<div class="empty">Character Prompt \uC5C6\uC74C</div>';
        return;
    }

    chars.forEach((prompt, index) => {
        const div = document.createElement('div');
        div.className = 'char-prompt-item';
        const tokenBoxId = `charPromptTokenBox_${index}`;
        div.innerHTML = `
            <b>Character Prompt ${index + 1}</b><br>
            <div class="char-prompt-raw">${escapeHtml(prompt)}</div>
            <div id="${tokenBoxId}" class="prompt-token-box"></div>
        `;
        charBox.appendChild(div);
        renderClickablePromptTags(document.getElementById(tokenBoxId), prompt, 'char');
    });
}

async function runReclassify() {
    if (useCharId && (!characterIndexStatus || !characterIndexStatus.complete)) {
        alert('\uCE90\uB9AD\uD130 \uD310\uBCC4\uC744 \uC0AC\uC6A9\uD558\uB824\uBA74 \uBA3C\uC800 \uCE90\uB9AD\uD130 \uC778\uB371\uC2A4\uB97C \uC0DD\uC131\uD558\uC138\uC694. \uCE90\uB9AD\uD130 \uD310\uBCC4\uC744 \uB044\uB294 \uC0C1\uD0DC\uC5D0\uC11C\uB294 \uC7AC\uBD84\uB958\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.');
        return;
    }

    $('galleryState').style.display = '';
    $('galleryState').innerText = '\uC7AC\uBD84\uB958 \uC911\uC785\uB2C8\uB2E4. \uC774\uBBF8\uC9C0\uAC00 \uB9CE\uC73C\uBA74 \uC2DC\uAC04\uC774 \uAC78\uB9B4 \uC218 \uC788\uC2B5\uB2C8\uB2E4...';

    try {
        await apiPost('/api/live_classifier/reclassify', {
            mode: liveMode,
            rules: liveTempRules,
            use_char_id: useCharId,
            per_group_limit: getPerFolderLimitValue(),
            max_scan: getMaxScanValue()
        });

        $('galleryState').innerText = '\uC7AC\uBD84\uB958 \uACB0\uACFC\uB97C \uBD88\uB7EC\uC624\uB294 \uC911...';
        liveNoMetadataDisplayLimit = 500;
        await loadPreviewTree();
        await loadWorkspaceStatus();
    } catch (error) {
        $('galleryState').innerText = `\uC7AC\uBD84\uB958 \uC2E4\uD328: ${error.message}`;
    }
}

function renderPreviewTreePayload(preview, options = {}) {
    currentPreview = preview;
    liveRootTree = preview.tree;
    liveCurrentPath = [liveRootTree];

    if (options.preservePath) {
        restoreLiveCurrentPathByParts(options.previousPathParts || []);
    } else if (Array.isArray(liveRootTree.folders) && liveRootTree.folders.length) {
        liveCurrentPath = [liveRootTree, liveRootTree.folders[0]];
    }

    $('galleryState').style.display = 'none';
    renderLivePreviewStats(preview);

    renderLiveTreeView();
}

function renderLiveTreeView() {
    const nav = $('liveNavTabs');
    const bc = $('liveBreadcrumbPath');
    const cont = $('previewGallery');
    nav.innerHTML = '';
    cont.innerHTML = '';

    if (!liveRootTree) {
        $('galleryState').style.display = '';
        $('galleryState').innerText = '\uBBF8\uB9AC\uBCF4\uAE30 \uD2B8\uB9AC\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.';
        return;
    }

    (liveRootTree.folders || []).forEach((catNode, index) => {
        const btn = document.createElement('button');
        const isActive = liveCurrentPath[1] && liveCurrentPath[1].name === catNode.name;
        btn.className = `nav-btn ${isActive ? 'active' : ''}`;
        btn.innerText = String(catNode.name || '').replace(/^\d+_/, '');
        bindLiveFolderClickDragGuard(btn, () => liveGoToTopFolder(index));
        nav.appendChild(btn);
    });

    bc.innerHTML = `<span style="cursor:pointer;" onclick="liveGoToRoot()">\u2302 HOME</span>`;

    liveCurrentPath.forEach((node, idx) => {
        if (idx === 0) return;
        const label = idx === 1
            ? String(node.name || '').replace(/^\d+_/, '')
            : String(node.name || '').replace(/_\d+pcs$/i, '').replace(/_/g, ' ');
        const span = document.createElement('span');
        span.innerHTML = ` <span style="color:var(--accent)">\u203A</span> <span style="cursor:pointer; color:${idx === liveCurrentPath.length - 1 ? '#fff' : '#888'}">${escapeHtml(label)}</span>`;
        span.onclick = () => liveBreadcrumbTo(idx);
        bc.appendChild(span);
    });

    const currentNode = liveCurrentNode();
    const folders = Array.isArray(currentNode.folders) ? currentNode.folders : [];
    const images = Array.isArray(currentNode.images) ? currentNode.images : [];
    const majorFolders = folders.filter(f => Number(f.total_images || 0) >= 10);
    const minorFolders = folders.filter(f => Number(f.total_images || 0) < 10);

    if (majorFolders.length) renderLiveFolderGrid(cont, 'major', '\uBA54\uC778 \uADF8\uB8F9', majorFolders, '#00ff88');
    if (minorFolders.length) renderLiveFolderGrid(cont, 'minor', '\uB9C8\uC774\uB108 \uADF8\uB8F9', minorFolders, '#888');
    if (images.length) renderLiveImageGridLikeGallery(cont, `\uC774\uBBF8\uC9C0 (${images.length})`, images);

    if (isLiveNoMetadataNode(currentNode)) {
        renderLiveNoMetadataMoreButton(cont, currentNode, images.length);
    }

    if (!folders.length && !images.length) {
        const empty = document.createElement('div');
        empty.className = 'live-empty-folder';
        empty.textContent = '\uD45C\uC2DC\uD560 \uD3F4\uB354/\uC774\uBBF8\uC9C0\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.';
        cont.appendChild(empty);
    }
}

function renderLiveFolderGrid(container, id, title, folders, borderColor) {
    const wrapper = document.createElement('div');
    wrapper.className = 'collapsible-wrapper';
    const unique = `live-${id}-${Math.random().toString(36).slice(2)}`;
    const hId = `header-${unique}`;
    const cId = `content-${unique}`;
    wrapper.innerHTML = `
        <div class="section-header" id="${hId}" onclick="toggleLiveSection('${hId}', '${cId}')" style="border-left-color:${borderColor}">
            <span style="font-size:20px; font-weight:900; color:${borderColor}">${escapeHtml(title)} (${folders.length})</span>
            <span class="arrow">\u203A</span>
        </div>
        <div class="section-content" id="${cId}">
            <div class="flex-masonry" id="grid-${unique}"></div>
        </div>
    `;
    container.appendChild(wrapper);

    const grid = document.getElementById(`grid-${unique}`);
    const colCount = window.innerWidth <= 1400 ? 3 : 4;
    const cols = Array.from({ length: colCount }, () => {
        const col = document.createElement('div');
        col.className = 'flex-masonry-col';
        grid.appendChild(col);
        return col;
    });

    folders.forEach((child, idx) => {
        const card = document.createElement('div');
        card.className = 'card';
        const pathParts = liveNodePathParts(child);
        const pathJson = JSON.stringify(pathParts).replace(/'/g, '&#39;');
        bindLiveFolderClickDragGuard(card, () => liveEnterFolder(pathJson));
        const imgSrc = child.thumb ? imageUrl(child.thumb) : '';
        const nameRows = (child.char_names && child.char_names.length ? child.char_names : [child.name])
            .flatMap(n => String(n || '').split(/ and | _and_ /i))
            .map(n => `<div class="char-row"><span class="user-icon">\uD83D\uDC64</span><span class="char-name">${escapeHtml(n.trim().replace(/_/g, ' '))}</span></div>`)
            .join('');
        card.innerHTML = `
            <div class="card-body">
                ${imgSrc ? `<img src="${imgSrc}" class="card-main-img" loading="lazy">` : '<div style="height:150px;background:#222;"></div>'}
                <div class="count-badge"><span class="count-num">${Number(child.total_images || 0)}</span><span>FILES</span></div>
            </div>
            <div class="card-header">${nameRows}</div>
        `;
        cols[idx % colCount].appendChild(card);
    });
}

function renderLiveImageGridLikeGallery(container, title, images) {
    const sec = document.createElement('div');
    sec.className = 'section-title live-section-title';
    sec.innerHTML = `<span>${escapeHtml(title)}</span>`;
    container.appendChild(sec);

    const grid = document.createElement('div');
    grid.className = 'flex-masonry live-flex-masonry';
    const colCount = window.innerWidth <= 1400 ? 3 : 4;
    const cols = Array.from({ length: colCount }, () => {
        const col = document.createElement('div');
        col.className = 'flex-masonry-col';
        grid.appendChild(col);
        return col;
    });

    images.forEach((item, idx) => {
        const p = item.workspace_rel_path || item.path;
        const src = imageUrl(p);
        const safePath = JSON.stringify(p).replace(/"/g, '&quot;');
        const box = document.createElement('div');
        box.className = 'item-box live-item-box';
        box.onclick = () => loadPrompt(p);
        box.innerHTML = `
            <img src="${src}" loading="lazy" class="zoomable live-select-image"
                 onclick="event.stopPropagation(); loadPrompt(${safePath})">
            <div class="live-card-info">
                <div class="live-card-name">${escapeHtml(item.name || item.file_name || '')}</div>
                <div class="live-card-route">${escapeHtml(item.predicted_folder || '')}</div>
                ${
                    Array.isArray(item.detected_characters) && item.detected_characters.length
                        ? `<div class="live-card-chars">${escapeHtml(item.detected_characters.join(', '))}</div>`
                        : ''
                }
            </div>
        `;
        cols[idx % colCount].appendChild(box);
    });

    container.appendChild(grid);
}

function renderLiveNoMetadataMoreButton(container, node, visibleCount) {
    const total = Number(node?.total_images || 0);
    const shown = Number(visibleCount || 0);

    if (!total || shown >= total) return;

    const wrap = document.createElement('div');
    wrap.className = 'live-no-metadata-more';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = `NO_METADATA \uB354\uBCF4\uAE30 (${shown} / ${total})`;
    btn.onclick = async () => {
        liveNoMetadataDisplayLimit += 500;
        showLiveFlashMessage(`NO_METADATA \uD45C\uC2DC \uC81C\uD55C: ${liveNoMetadataDisplayLimit}\uC7A5`);
        await loadPreviewTree({ preservePath: true });
    };

    wrap.appendChild(btn);
    container.appendChild(wrap);
}

function toggleLiveSection(headerId, contentId) {
    const h = document.getElementById(headerId);
    const c = document.getElementById(contentId);
    if (!h || !c) return;
    h.classList.toggle('closed');
    c.classList.toggle('closed');
}

function applyLiveKoreanLabels() {
    document.title = 'NAI ImageManager - \uC2E4\uC2DC\uAC04 \uBD84\uB958';

    const setText = (selector, text) => {
        const el = document.querySelector(selector);
        if (el) el.textContent = text;
    };

    const setTexts = (selector, texts) => {
        document.querySelectorAll(selector).forEach((el, index) => {
            if (texts[index]) el.textContent = texts[index];
        });
    };

    setText('.live-title', '\u26A1 \uC2E4\uC2DC\uAC04 \uBD84\uB958');
    setText('#workspaceStatusBadge', '\uD604\uC7AC \uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4 \uD655\uC778 \uC911...');
    setText('.live-char-toggle span', '\uCE90\uB9AD\uD130 \uD310\uBCC4 \uC0AC\uC6A9');
    const charToggle = document.querySelector('.live-char-toggle');
    if (charToggle) {
        charToggle.title = '\uCD5C\uC885 \uBD84\uB958\uC5D0 \uCE90\uB9AD\uD130 \uD3F4\uB354 \uD310\uBCC4\uC744 \uBBF8\uB9AC\uBCF4\uAE30\uC5D0\uB3C4 \uC801\uC6A9\uD569\uB2C8\uB2E4.';
    }

    setTexts('.live-header-actions > button', [
        '\uD83C\uDFB2 \uB79C\uB364 \uC774\uBBF8\uC9C0',
        '\uD83D\uDD01 \uC7AC\uBD84\uB958',
        '\uAC24\uB7EC\uB9AC'
    ]);

    setTexts('.live-left > h3, .live-right > h3', [
        '\uADDC\uCE59 \uC0C1\uD0DC',
        '\uC120\uD0DD \uC774\uBBF8\uC9C0'
    ]);
    setText('.hint', '\uD504\uB86C\uD504\uD2B8 \uD0DC\uADF8\uB97C \uD074\uB9AD\uD574 \uC784\uC2DC \uADDC\uCE59\uC744 \uB9CC\uB4E4\uACE0 \uC7AC\uBD84\uB958\uB85C \uACB0\uACFC\uB97C \uD655\uC778\uD569\uB2C8\uB2E4.\\n\uC544\uC9C1 \uC2E4\uC81C custom_rules\uC5D0\uB294 \uC800\uC7A5\uB418\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.');

    setTexts('.live-control-block > label', [
        '\uBD84\uB958 \uBAA8\uB4DC',
        '\uCD5C\uB300 \uACC4\uC0B0 \uD69F\uC218',
        '\uD3F4\uB354\uBCC4 \uD45C\uC2DC \uD69F\uC218'
    ]);
    setText('#modeExistingBtn', '\uAE30\uC874 \uADDC\uCE59 \uC0AC\uC6A9');
    setText('#modeNewBtn', '\uCC98\uC74C\uBD80\uD130 \uB9CC\uB4E4\uAE30');
    setText('.live-control-block button[onclick="buildCharacterIndexFromLive()"]', '\uD83E\uDDEC \uCE90\uB9AD\uD130 \uC778\uB371\uC2A4 \uC0DD\uC131');

    setText('.live-rule-panel-header h3', '\uC784\uC2DC \uC815\uBC00 \uB77C\uC6B0\uD305 \uADDC\uCE59');
    setText('#liveApplyRulesBtn', '✅ 분류 반영');
    setText('#liveReloadRulesBtn', '초기화');
    setText('.live-rule-help', '\uC774 \uADDC\uCE59\uC740 \uC2E4\uC2DC\uAC04 \uBD84\uB958 \uD654\uBA74\uC5D0\uC11C\uB9CC \uC0AC\uC6A9\uB429\uB2C8\uB2E4. \uC544\uC9C1 custom_rules\uC5D0\uB294 \uC800\uC7A5\uB418\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.');
    setTexts('.live-route-toolbar button', [
        '+ \uC120\uD0DD \uADDC\uCE59\uC5D0 \uD558\uC704 \uCD94\uAC00',
        '\uC120\uD0DD \uADDC\uCE59 \uC218\uC815',
        '\uC120\uD0DD \uC0AD\uC81C'
    ]);
    setText('.live-route-card-hint', '\uD074\uB9AD: \uB2E8\uC77C \uC120\uD0DD \u00B7 Ctrl/Command \uD074\uB9AD: \uB2E4\uC911 \uC120\uD0DD \u00B7 Shift \uD074\uB9AD: \uBC94\uC704 \uC120\uD0DD \u00B7 \uB4DC\uB798\uADF8 \uAC00\uC7A5\uC790\uB9AC: \uC704\uCE58 \uC774\uB3D9 \u00B7 \uB4DC\uB798\uADF8 \uC911\uC559: \uD558\uC704 \uADDC\uCE59\uC73C\uB85C \uB123\uAE30 \u00B7 \uB354\uBE14\uD074\uB9AD: \uC218\uC815');

    setText('#liveBreadcrumbPath', '\u2302 HOME');
    setText('#galleryState', '\uD604\uC7AC \uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4\uB97C \uBD88\uB7EC\uC628 \uB4A4 \uC7AC\uBD84\uB958\uB97C \uB204\uB974\uC138\uC694.');
    setText('#selectedImageBox .empty', '\uC774\uBBF8\uC9C0\uB97C \uC120\uD0DD\uD558\uAC70\uB098 \uB79C\uB364 \uC774\uBBF8\uC9C0\uB97C \uBD88\uB7EC\uC624\uC138\uC694.');

    setText('.rule-candidate-panel h3', '\uADDC\uCE59 \uD6C4\uBCF4');
    setText('.rule-candidate-help', '\uD504\uB86C\uD504\uD2B8 \uD0DC\uADF8\uB97C \uD074\uB9AD\uD558\uBA74 \uC544\uB798 \uD6C4\uBCF4 \uBAA9\uB85D\uC5D0 \uCD94\uAC00\uB429\uB2C8\uB2E4.');
    setTexts('.rule-candidate-panel .rule-field label', [
        '\uB300\uC0C1 \uD3F4\uB354\uBA85',
        '\uAC80\uC0C9 \uBC94\uC704',
        '\uC870\uAC74',
        'N\uAC1C \uC774\uC0C1',
        '\uC120\uD0DD \uD0DC\uADF8'
    ]);
    const folderInput = document.querySelector('#candidateFolderInput');
    if (folderInput) folderInput.placeholder = '\uC608: FGO / Saber / Katsuragi_Lilja';
    setTexts('#candidateScopeSelect option', ['\uC804\uCCB4', 'Base Prompt', 'Character Prompt']);
    setTexts('#candidateConditionSelect option', ['\uD558\uB098\uB77C\uB3C4', '\uBAA8\uB450', 'N\uAC1C \uC774\uC0C1']);
    setText('#candidateTagTextToggleBtn', candidateTagTextEditMode ? '\uD0DC\uADF8 \uC801\uC6A9' : '\uC9C1\uC811 \uC785\uB825');
    setTexts('.rule-candidate-actions button', [
        '\uD0DC\uADF8 \uBE44\uC6B0\uAE30',
        '\uC0C1\uC704 \uADDC\uCE59 \uCD94\uAC00',
        '\uD558\uC704 \uADDC\uCE59 \uCD94\uAC00',
        '\uC218\uC815 \uC801\uC6A9',
        '\uC218\uC815 \uCDE8\uC18C'
    ]);
}

window.addEventListener('load', async () => {
    applyLiveKoreanLabels();
    setModeBadge();
    renderLiveLimitToggles();

    try {
        await loadWorkspaceStatus();
        await reloadLiveRules();
        await loadPreviewTree();
        await loadRandomImage();

        try {
            const jobData = await apiGet('/api/live_classifier/character_index/job_status');
            if (jobData.job && jobData.job.running) {
                renderCharacterIndexJob(jobData.job);
                startCharacterIndexPolling();
            }
        } catch (e) {}
    } catch (error) {
        $('galleryState').innerText = `\uCD08\uAE30\uD654 \uC2E4\uD328: ${error.message}`;
    }
});
