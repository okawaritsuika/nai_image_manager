/* ==========================================================
   NAI Image Manager Style Lab - 통합 자바스크립트 로직 (연구소 + 추출기)
   ========================================================== */

// --- [0] 전역 상수 및 상태 변수 ---
let defaultQualityTags = "-3.00::artist collaboration::, year 2025, year 2024, -1::clean text::, -1::flat color::, natural, incredibly absurdres, very aesthetic, highres, masterpiece, best quality, amazing quality, -3::simple illustration::, best illustration, novel illustration, uncensored, ";

let manualTiers = [
    { count: 1, min: 1.2, max: 1.5 },
    { count: 2, min: 0.8, max: 1.1 }
];
let pendingGroupDeletions = new Set();
let pendingArtistDeletions = new Set();
let currentImageBase64 = null;
let stylesData = {};
let artistsData = {};
let pinnedArtists = [];
let currentStyleTags = [];
let saveQueue = Promise.resolve(); // 동시 저장 방지용 (직렬화)

// --- [1] 공통 유틸리티 및 API 래퍼 ---
const el = (id) => document.getElementById(id);

async function apiFetch(url, options = {}) {
    try {
        const response = await fetch(url, options);
        // JSON 파싱 시도 (빈 응답 대응)
        const text = await response.text();
        const data = text ? JSON.parse(text) : {};
        if (!response.ok) throw new Error(data.error || `HTTP Error ${response.status}`);
        return data;
    } catch (error) {
        console.error(`API Error (${url}):`, error);
        showToast(`오류 발생: ${error.message}`);
        throw error;
    }
}

function showToast(message) {
    const toast = document.createElement('div');
    toast.style.cssText = `
        position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%);
        background: var(--accent-blue); color: white; padding: 12px 25px;
        border-radius: 30px; z-index: 9999; font-weight: bold;
        box-shadow: 0 4px 15px rgba(0,0,0,0.3); animation: fadeInOut 2s forwards;
    `;
    toast.innerText = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
}

// --- [2] 초기 로딩 및 설정 관리 ---
window.onload = async function() {
    try {
        const data = await apiFetch('/api/lab/config');
        applyInitialConfig(data);
        await fetchArtists();
        await fetchStyles();
        renderPinnedArtists();
        
        let savedTarget = localStorage.getItem('qualityWheelTarget');
        if (savedTarget && el('qualityWheelTarget')) el('qualityWheelTarget').value = savedTarget;
        
        updateSpecialButtonsText();
        checkAnlas();
        initDropZone(); 
    } catch(e) { console.error("Initial load error:", e); }
};

function applyInitialConfig(data) {
    if (data.key) el('apiKey').value = data.key;
    if (data.subject_prompt) el('subjectPrompt').value = data.subject_prompt;
    
    if (data.default_quality) defaultQualityTags = data.default_quality;
    el('qualityPrompt').value = data.quality_prompt || defaultQualityTags;
    if (data.daki_prompt) el('dakiPrompt').value = data.daki_prompt;

    if (data.style_prompt) {
        try { 
            currentStyleTags = JSON.parse(data.style_prompt); 
            renderStyleTags(); 
        } catch(e) { console.warn("Style Prompt parsing failed."); }
    }

    if (data.char_prompt) el('charPrompt').value = data.char_prompt;
    if (data.negative_prompt) el('negPrompt').value = data.negative_prompt;
    if (data.res_preset) { 
        el('resPreset').value = data.res_preset; 
        updateResolution(); 
    }
    
    if (data.scale !== undefined) el('scale').value = data.scale;
    if (data.cfg_rescale !== undefined) el('cfgRescale').value = data.cfg_rescale;
    if (data.steps !== undefined) el('steps').value = data.steps;
    if (data.sampler !== undefined) el('sampler').value = data.sampler;

    if (data.use_daki !== undefined) {
        el('useDakimakuraSetting').checked = data.use_daki;
        toggleDakiVisibility(); 
    }
}

async function saveConfig(silent = false) {
    try {
        await apiFetch('/api/lab/config', { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({
                key: el('apiKey').value,
                subject_prompt: el('subjectPrompt').value,
                style_prompt: JSON.stringify(currentStyleTags),
                quality_prompt: el('qualityPrompt').value,
                default_quality: defaultQualityTags,
                daki_prompt: el('dakiPrompt').value,
                char_prompt: el('charPrompt').value,
                negative_prompt: el('negPrompt').value,
                res_preset: el('resPreset').value,
                scale: parseFloat(el('scale').value),
                cfg_rescale: parseFloat(el('cfgRescale').value),
                steps: parseInt(el('steps').value),
                sampler: el('sampler').value,
                use_daki: el('useDakimakuraSetting').checked 
            }) 
        });
        if (!silent) showToast("✅ 설정이 저장되었습니다.");
    } catch (e) { /* Error handled in apiFetch */ }
}

// --- [3] 모달 및 UI 제어 ---
function openSettings() { el('settingsModal').style.display = 'flex'; }
function closeSettings() { el('settingsModal').style.display = 'none'; }
function openStorageModal() { el('storageModal').style.display = 'flex'; renderStorageList(); }
function closeStorageModal() { el('storageModal').style.display = 'none'; }
function closeSaveStyleModal() { el('saveStyleModal').style.display = 'none'; }
function closeQualityManager() { if (el('qualityManagerModal')) el('qualityManagerModal').style.display = 'none'; }
function closeExtractorModal() { el('extractorModal').style.display = 'none'; }

async function openExtractorModal() {
    el('extractorModal').style.display = 'flex';
    await updateNextStyleName(); 
}

function switchTab(tab) {
    const btnBase = el('btn-tab-base'), btnNeg = el('btn-tab-negative');
    const tabBase = el('tab-base'), tabNeg = el('tab-negative');

    if (tab === 'base') {
        btnBase.classList.add('active'); btnNeg.classList.remove('active');
        tabBase.style.display = 'block'; tabNeg.style.display = 'none';
    } else {
        btnNeg.classList.add('active'); btnBase.classList.remove('active');
        tabBase.style.display = 'none'; tabNeg.style.display = 'block';
    }
}

function toggleCollapse(element) { 
    element.classList.toggle('active'); 
}

function toggleSubCollapse(element) {
    const content = element.nextElementSibling;
    const icon = element.querySelector('.toggle-icon');
    if (content.style.display === 'none') {
        content.style.display = 'block'; 
        icon.style.transform = 'rotate(0deg)';
    } else {
        content.style.display = 'none'; 
        icon.style.transform = 'rotate(-90deg)';
    }
}

function toggleDakiVisibility() {
    const isUse = el('useDakimakuraSetting').checked;
    if (el('dakiSection')) el('dakiSection').style.display = isUse ? 'block' : 'none';
    saveConfig(true); 
}

function toggleStyleLink() {
    el('styleLinkContainer').style.display = el('useStyleLink').checked ? 'block' : 'none';
}

function toggleWeightMode() {
    const mode = el('weightMode').value;
    el('modeSimple').style.display = (mode === 'simple') ? 'block' : 'none';
    el('modeAutoTier').style.display = (mode === 'auto_tier') ? 'block' : 'none';
    el('modeManualTier').style.display = (mode === 'manual_tier') ? 'block' : 'none';
    el('modeFixed').style.display = (mode === 'fixed') ? 'block' : 'none';
}

// --- [4] 프롬프트 및 가중치 제어 ---
function updateSpecialButtonsText() {
    let targetTag = (el('qualityWheelTarget')?.value.trim()) || 'artist collaboration';
    localStorage.setItem('qualityWheelTarget', targetTag);
    
    let qVal = el('qualityPrompt').value;
    let escapedTarget = targetTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let qRegex = new RegExp(`([-0-9.]+)::${escapedTarget}::`);
    let qMatch = qVal.match(qRegex);
    
    const displayElem = el('qualityBtn');
    if (displayElem) {
        if (qMatch) {
            displayElem.innerHTML = `[${targetTag}] : <span class="value">${parseFloat(qMatch[1]).toFixed(2)}</span>`;
        } else {
            displayElem.innerHTML = qVal.includes(targetTag) ? `[${targetTag}] : 포함됨` : `Quality Tags 편집`;
        }
    }

    // Dakimakura tag button update
    const dakiBtn = el('dakiBtn');
    let dVal = el('dakiPrompt') ? el('dakiPrompt').value : "";
    let dTarget = 'dakimakura (medium), white sheet';
    let dEscaped = dTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let dRegex = new RegExp(`([-0-9.]+)::${dEscaped}::`);
    let dMatch = dVal.match(dRegex);

    if (dakiBtn) {
        if (dMatch) {
            dakiBtn.innerText = `[dakimakura] : ${parseFloat(dMatch[1]).toFixed(2)}`;
        } else {
            dakiBtn.innerText = dVal.includes(dTarget) ? `[dakimakura] : 적용됨` : `Dakimakura Tags : 미적용`;
        }
    }
}

function handleSpecialTagWheel(event, type) {
    let ta = el(type === 'quality' ? 'qualityPrompt' : 'dakiPrompt');
    // 편집 모드(textarea가 화면에 표시된 상태)일 경우 휠 이벤트 무시
    if (ta && !ta.classList.contains('hidden') && ta.style.display !== 'none') {
        return; // 일반적인 텍스트 스크롤 허용
    }

    event.preventDefault();
    const delta = event.deltaY < 0 ? 0.05 : -0.05;
    let targetTag = type === 'quality' ? (el('qualityWheelTarget').value || 'artist collaboration') : 'dakimakura (medium), white sheet';
    let val = ta.value || (type === 'quality' ? DEFAULT_QUALITY_TAGS : "");
    
    let regex = new RegExp(`([-0-9.]+)::${targetTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}::`);
    let match = val.match(regex);
    
    if (match) {
        ta.value = val.replace(match[0], `${(parseFloat(match[1]) + delta).toFixed(2)}::${targetTag}::`);
    } else {
        ta.value = `${(type === 'quality' ? 1.0 : 3.0) + delta}::${targetTag}::, ` + val;
    }
    updateSpecialButtonsText();
}

document.addEventListener('wheel', function(e) {
    if (e.target.tagName === 'INPUT' && e.target.type === 'number') {
        if (document.activeElement !== e.target && !e.target.matches(':hover')) return;
        e.preventDefault();
        const step = parseFloat(e.target.step) || 1;
        const delta = e.deltaY < 0 ? step : -step;
        let newVal = (parseFloat(e.target.value) || 0) + delta;
        if (e.target.min !== "" && newVal < parseFloat(e.target.min)) newVal = parseFloat(e.target.min);
        if (e.target.max !== "" && newVal > parseFloat(e.target.max)) newVal = parseFloat(e.target.max);
        e.target.value = (step % 1 !== 0) ? newVal.toFixed(2) : newVal;
        e.target.dispatchEvent(new Event('change')); 
        e.target.dispatchEvent(new Event('input'));
    }
}, { passive: false });

function toggleQualityTags() {
    const display = el('qualityBtn');
    const textarea = el('qualityPrompt');
    const card = display.closest('.quality-control-card');
    
    if (textarea.classList.contains('hidden')) {
        display.classList.add('hidden');
        textarea.classList.remove('hidden');
        if (card) card.classList.add('editing');
        textarea.focus();
    } else {
        display.classList.remove('hidden');
        textarea.classList.add('hidden');
        if (card) card.classList.remove('editing');
        updateSpecialButtonsText();
    }
}

function toggleDakiTags() {
    const btn = el('dakiBtn'), ta = el('dakiPrompt');
    if (btn.style.display !== 'none') { 
        btn.style.display = 'none'; 
        ta.style.display = 'block'; 
        ta.focus(); 
    } else { 
        btn.style.display = 'block'; 
        ta.style.display = 'none'; 
        updateSpecialButtonsText(); 
    }
}

function toggleStyleTags() {
    const visual = el('stylePromptVisual');
    const ta = el('stylePromptTextArea');
    if (visual.style.display !== 'none') {
        visual.style.display = 'none'; 
        ta.style.display = 'block';
        ta.value = currentStyleTags.map(t => `${t.weight.toFixed(2)}::artist:${t.name}::`).join(', '); 
        ta.focus();
    } else {
        visual.style.display = 'flex'; 
        ta.style.display = 'none';
        let str = ta.value, regex = /([0-9.]+)::artist:([^:]+)::/g, match, tags = [];
        while ((match = regex.exec(str)) !== null) tags.push({weight: parseFloat(match[1]), name: match[2]});
        currentStyleTags = tags; 
        renderStyleTags();
    }
}

function handleTagWheel(event, idx) {
    event.preventDefault();
    const delta = event.deltaY < 0 ? 0.05 : -0.05;
    currentStyleTags[idx].weight = parseFloat((currentStyleTags[idx].weight + delta).toFixed(2));
    renderStyleTags();
}

function getStylePromptText() {
    const ta = el('stylePromptTextArea');
    return ta.style.display === 'block' ? ta.value.trim() : currentStyleTags.map(t => `${t.weight.toFixed(2)}::artist:${t.name}::`).join(', ');
}

function getFullPrompt() {
    let subject = el('subjectPrompt').value.trim();
    let styleStr = getStylePromptText();
    let qualityStr = el('qualityPrompt').value.trim();
    const isDakiUse = el('useDakimakuraSetting').checked;
    let daki = isDakiUse ? el('dakiPrompt').value.trim() : "";
    return [subject, styleStr, qualityStr, daki].filter(Boolean).join(', ');
}

// --- [5] 작가 및 그룹 관리 (렌더링 & API) ---
// ... (rest of the code remains the same, I will use a separate replace for calculateWeights and applyStyleToPrompt)
async function fetchArtists() {
    try {
        artistsData = await apiFetch('/api/artists');
        renderArtistGroups(); 
        renderRandomGroupInputs();
    } catch (e) { /* error toast via apiFetch */ }
}

async function saveArtistsData() {
    await apiFetch('/api/artists', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify(artistsData) 
    });
}

function renderArtistGroups() {
    const container = el('artistGroupsContainer');
    const collapsedStates = {};
    container.querySelectorAll('.artist-category').forEach(cat => {
        const groupName = cat.dataset.groupname;
        const content = cat.nextElementSibling;
        if (groupName && content) collapsedStates[groupName] = content.style.display === 'none';
    });

    container.innerHTML = '';
    container.style.display = 'flex'; container.style.flexDirection = 'column'; container.style.gap = '2px';

    for (let groupName in artistsData) {
        let isPending = pendingGroupDeletions.has(groupName);
        let groupStyle = isPending ? "opacity: 0.5; background: #3b1a1a; border-color: #ff4d4d;" : "background:var(--btn-secondary); border-color: var(--border-color);";
        let nameStyle = isPending ? "text-decoration: line-through; color: #ff4d4d;" : "";
        let btnIcon = isPending ? "↩️" : "✕";
        
        let isCollapsed = collapsedStates[groupName] === undefined ? true : collapsedStates[groupName];
        let displayState = isPending ? 'none' : (isCollapsed ? 'none' : 'block');
        let iconTransform = isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)';

        let html = `
            <div class="artist-category" data-groupname="${groupName}" ${isPending ? '' : 'onclick="toggleSubCollapse(this)"'} style="cursor:pointer; padding:8px 10px; border-radius:6px; border:1px solid; display: flex; justify-content: space-between; align-items: center; min-height: 34px; margin-top: 4px; ${groupStyle}">
                <span style="display:flex; align-items:center; gap:8px; flex: 1;">
                    <span class="toggle-icon" style="transform: ${iconTransform};">▼</span>
                    <span style="font-size: 13px; font-weight: 500; ${nameStyle}">${groupName} <span style="color:var(--text-muted); font-size:11px;">(${artistsData[groupName].length}명)</span></span>
                </span>
                <div style="display: flex; gap: 6px;" onclick="event.stopPropagation()">
                    <button class="icon-btn" onclick="editGroup('${groupName}')" style="display:${isPending ? 'none' : 'flex'};">✏️</button>
                    <button class="icon-btn danger" onclick="deleteGroup('${groupName}')">${btnIcon}</button>
                </div>
            </div>
            <div class="sub-collapsible-content" style="display:${displayState}; padding-left:12px; margin-bottom:12px; margin-top:4px;">
                <div class="artist-list" id="list_${groupName}">
        `;

        artistsData[groupName].forEach(artist => {
            let artistKey = JSON.stringify({group: groupName, artist: artist});
            let isArtistPending = pendingArtistDeletions.has(artistKey);
            let artistStyle = isArtistPending ? "opacity: 0.5; background: #3b1a1a; text-decoration: line-through; color: #ff4d4d;" : "";
            
            html += `
            <div class="artist-item" style="padding: 6px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); ${artistStyle}">
                <label style="flex:1; cursor:pointer; display:flex; align-items:center; font-size:12px;">
                    <input type="checkbox" class="artist-cb" data-group="${groupName}" value="${artist}" ${isArtistPending ? 'disabled' : ''} style="width:14px; margin-right:8px;">
                    <span>${artist}</span>
                </label>
                <div style="display:flex; gap: 4px;">
                    <button class="icon-btn" onclick="addPinnedArtist('${artist}')" style="display:${isArtistPending ? 'none' : 'flex'};">📌</button>
                    <button class="icon-btn danger" onclick="removeArtist('${groupName}', '${artist}')">${isArtistPending ? '↩️' : '✕'}</button>
                </div>
            </div>`;
        });

        html += `</div>
                <div style="display:flex; gap:6px; margin-top:6px;">
                    <input type="text" id="newArtist_${groupName}" placeholder="태그 입력" style="flex: 1;">
                    <button class="secondary" onclick="addNewArtist('${groupName}')">추가</button>
                </div>
            </div>`;
        container.innerHTML += html;
    }

    bindCheckboxEvents();
    const bulkContainer = el('bulkDeleteContainer');
    if (bulkContainer) {
        bulkContainer.style.display = pendingGroupDeletions.size > 0 ? 'block' : 'none';
        if (pendingGroupDeletions.size > 0) el('bulkDeleteBtn').innerText = `🗑️ 삭제 대기 중인 ${pendingGroupDeletions.size}개 그룹 일괄 삭제`;
    }
}

function bindCheckboxEvents() {
    document.querySelectorAll('.artist-cb').forEach(cb => {
        cb.addEventListener('change', () => { updateCheckedCount(); applyStyleToPrompt(true); });
    });
    updateCheckedCount();
}

function updateCheckedCount() {
    el('checkedCount').innerText = `${document.querySelectorAll('.artist-cb:checked').length}명 선택됨`;
}

function clearCheckedArtists() {
    document.querySelectorAll('.artist-cb').forEach(cb => cb.checked = false);
    updateCheckedCount();
}

async function addNewArtist(groupName) {
    const artistName = el(`newArtist_${groupName}`).value.trim();
    if (!artistName) return;
    if (artistsData[groupName].includes(artistName)) return alert("이미 존재하는 작가입니다.");
    artistsData[groupName].push(artistName); 
    await saveArtistsData(); 
    renderArtistGroups(); 
    renderRandomGroupInputs();
}

async function removeArtist(groupName, artistName) {
    if(!confirm(`정말 '${artistName}' 작가를 삭제하시겠습니까?`)) return;
    artistsData[groupName] = artistsData[groupName].filter(a => a !== artistName);
    await saveArtistsData(); 
    renderArtistGroups(); 
    renderRandomGroupInputs();
}

async function addNewGroup() {
    const groupName = el('newGroupName').value.trim();
    if (!groupName) return;
    if (artistsData[groupName]) return alert("이미 존재하는 그룹입니다.");
    artistsData[groupName] = []; 
    el('newGroupName').value = '';
    await saveArtistsData(); 
    renderArtistGroups(); 
    renderRandomGroupInputs();
}

async function deleteGroup(groupName) {
    if (pendingGroupDeletions.has(groupName)) pendingGroupDeletions.delete(groupName);
    else pendingGroupDeletions.add(groupName);
    renderArtistGroups();
}

async function commitGroupDeletions() {
    if (!confirm(`정말 일괄 삭제하시겠습니까?\n(이 작업은 되돌릴 수 없습니다.)`)) return;
    pendingArtistDeletions.forEach(itemStr => { 
        try { 
            let item = JSON.parse(itemStr); 
            artistsData[item.group] = artistsData[item.group].filter(a => a !== item.artist); 
        } catch(e) {} 
    });
    pendingArtistDeletions.clear();
    pendingGroupDeletions.forEach(g => delete artistsData[g]);
    pendingGroupDeletions.clear();
    await saveArtistsData(); 
    renderArtistGroups(); 
    renderRandomGroupInputs();
}

async function editGroup(oldGroupName) {
    const newGroupName = prompt(`새 이름을 입력하세요:`, oldGroupName);
    if (!newGroupName || newGroupName.trim() === '' || newGroupName === oldGroupName) return;
    if (artistsData[newGroupName]) return alert("이미 존재하는 그룹입니다.");
    artistsData[newGroupName] = [...artistsData[oldGroupName]]; 
    delete artistsData[oldGroupName];
    await saveArtistsData(); 
    renderArtistGroups(); 
    renderRandomGroupInputs();
}

// --- [6] 필수 작가(Pinned) 및 무작위 뽑기 ---
function renderPinnedArtists() {
    const container = el('pinnedArtistsContainer');
    const countBadge = el('pinnedCount');
    container.innerHTML = '';
    if (countBadge) countBadge.innerText = `${pinnedArtists.length}명`;

    if (pinnedArtists.length === 0) {
        container.innerHTML = '<div style="font-size: 11px; color: var(--text-muted); padding: 2px 0;">등록된 고정 작가가 없습니다.</div>';
        return;
    }

    let html = '';
    pinnedArtists.forEach((p, idx) => {
        html += `
            <div class="pinned-item" style="padding: 3px 6px; display: flex; justify-content: space-between; align-items: center; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 4px; min-height: 24px;">
                <span style="font-weight: 600; color: var(--text-main); font-size: 11px;">${p.name}</span>
                <div style="display: flex; gap: 4px; align-items: center;">
                    <input type="number" value="${p.weight}" step="0.01" onchange="updatePinnedWeight(${idx}, this.value)" style="width: 50px; padding: 1px; text-align: center; font-size: 11px; height: 18px;">
                    <button class="icon-btn danger" onclick="removePinnedArtist(${idx})" style="width: 18px; height: 18px; font-size: 9px; padding: 0;">✕</button>
                </div>
            </div>`;
    });
    container.innerHTML = html;
}

function addPinnedArtist(name) {
    if(pinnedArtists.find(p => p.name === name)) return alert(`'${name}' 작가는 이미 등록되어 있습니다.`);
    pinnedArtists.push({name: name, weight: 1.0}); 
    renderPinnedArtists();
}

function addManualPinned() {
    const name = el('newPinnedName').value.trim();
    const weight = parseFloat(el('newPinnedWeight').value) || 1.0;
    if(!name) return;
    if(pinnedArtists.find(p => p.name === name)) return alert("이미 등록된 작가입니다.");
    pinnedArtists.push({name: name, weight: weight});
    el('newPinnedName').value = ''; 
    renderPinnedArtists();
}

function removePinnedArtist(idx) { pinnedArtists.splice(idx, 1); renderPinnedArtists(); }
function updatePinnedWeight(idx, val) { pinnedArtists[idx].weight = parseFloat(val) || 1.0; }

function renderRandomGroupInputs() {
    const container = el('randomGroupInputs');
    container.innerHTML = '';
    for (let groupName in artistsData) {
        container.innerHTML += `
            <div style="display:inline-flex; align-items:center; background:var(--card-bg); padding:0 8px; border-radius:6px; border:1px solid var(--border-color); height:28px; gap:6px;">
                <input type="checkbox" class="group-exclude-cb" data-group="${groupName}" style="width:13px; margin:0;">
                <span title="체크 시 제외">🚫</span>
                <span style="font-weight:600; font-size:11px; color:var(--text-main);">${groupName}</span>
                <input type="number" id="rand_count_${groupName}" value="0" min="0" max="${artistsData[groupName].length}" style="width:34px; padding:2px; font-size:11px; height:18px; text-align:center;">
            </div>`;
    }
}

function pickRandomArtists() {
    clearCheckedArtists();
    let selectedSet = new Set();
    let checkboxes = Array.from(document.querySelectorAll('.artist-cb'));
    let pickedFromGroups = 0;
    let excludedGroups = new Set();
    
    document.querySelectorAll('.group-exclude-cb:checked').forEach(cb => excludedGroups.add(cb.dataset.group));

    for (let groupName in artistsData) {
        let input = el(`rand_count_${groupName}`);
        if (!input) continue;
        let count = parseInt(input.value) || 0;
        if (count > 0) {
            let available = checkboxes.filter(cb => cb.dataset.group === groupName && !selectedSet.has(cb.value));
            available.sort(() => 0.5 - Math.random());
            available.slice(0, count).forEach(cb => { 
                cb.checked = true; 
                selectedSet.add(cb.value); 
                pickedFromGroups++; 
            });
        }
    }

    let allCount = parseInt(el('randomAllCount').value) || 0;
    if (allCount > 0) {
        let includeGroupPicks = el('includeGroupPicks');
        let pickCount = (includeGroupPicks && includeGroupPicks.checked) ? Math.max(0, allCount - pickedFromGroups) : allCount;
        
        if (pickCount > 0) {
            let remaining = checkboxes.filter(cb => !selectedSet.has(cb.value) && !excludedGroups.has(cb.dataset.group));
            remaining.sort(() => 0.5 - Math.random());
            remaining.slice(0, pickCount).forEach(cb => { 
                cb.checked = true; 
                selectedSet.add(cb.value); 
            });
        }
    }
    updateCheckedCount(); 
    applyStyleToPrompt(true);
}

// --- [7] 그림체 가중치 분배 및 스타일 UI 렌더링 ---
function getRandomWeight(min, max) { return (min === max) ? min.toFixed(2) : (Math.random() * (max - min) + min).toFixed(2); }
function formatArtistName(name) { let n = name.trim(); if (/\d$/.test(n)) n += ' '; return n; }

function renderStyleTags() {
    const container = el('stylePromptVisual');
    container.innerHTML = '';
    if (currentStyleTags.length === 0) {
        container.innerHTML = '<span style="color: var(--text-muted); font-size: 12px; line-height: 28px;">왼쪽에서 작가를 추가하세요. (더블클릭 시 편집창 전환)</span>';
        return;
    }
    
    currentStyleTags.forEach((tag, idx) => {
        let bg = '#2a2a35', color = '#a0a0b0';
        const w = tag.weight;
        if (w < 0.6) { bg = '#2a2a35'; color = '#a0a0b0'; }
        else if (w < 0.9) { bg = 'rgba(108, 92, 231, 0.2)'; color = '#8c7df0'; }
        else if (w < 1.2) { bg = 'rgba(0, 184, 148, 0.2)'; color = '#00b894'; }
        else if (w < 1.5) { bg = 'rgba(253, 203, 110, 0.2)'; color = '#fdcb6e'; }
        else { bg = 'rgba(255, 77, 77, 0.2)'; color = '#ff4d4d'; }
        
        container.innerHTML += `<span onwheel="handleTagWheel(event, ${idx})" style="background: ${bg}; color: ${color}; padding: 3px 8px; border-radius: 12px; font-size: 12px; font-weight: bold; cursor: ns-resize;">${w.toFixed(2)}::artist:${tag.name}::</span>`;
    });
}

function renderManualTiers() {
    const container = el('manualTiersContainer');
    container.innerHTML = '';
    manualTiers.forEach((tier, index) => {
        container.innerHTML += `
            <div class="flex-row" style="margin-bottom: 4px;">
                <span style="font-size: 11px; width: 40px;">구간 ${index + 1}</span>
                <input type="number" id="tier_c_${index}" value="${tier.count}" style="width: 40px;">명 | 
                <input type="number" id="tier_min_${index}" value="${tier.min}" step="0.1" style="width: 50px;"> ~
                <input type="number" id="tier_max_${index}" value="${tier.max}" step="0.1" style="width: 50px;">
                <button class="icon-btn danger" onclick="removeManualTier(${index})">✕</button>
            </div>`;
    });
}

function addManualTier() { manualTiers.push({count: 1, min: 0.5, max: 1.0}); renderManualTiers(); }
function removeManualTier(index) { manualTiers.splice(index, 1); renderManualTiers(); }
function getManualTiersData() {
    return manualTiers.map((t, i) => ({
        count: parseInt(el(`tier_c_${i}`).value) || 1,
        min: parseFloat(el(`tier_min_${i}`).value) || 0.5,
        max: parseFloat(el(`tier_max_${i}`).value) || 1.5
    }));
}

// 가중치 계산 로직 분리 (SRP 준수)
function calculateWeights(checkboxes, mode) {
    let newStyleTags = [];
    if (mode === 'auto_tier') {
        let numTiers = Math.max(1, Math.min(parseInt(el('autoTierCount').value) || 3, checkboxes.length));
        const totalMin = parseFloat(el('autoMin').value) || 0.3;
        const totalMax = parseFloat(el('autoMax').value) || 1.5;
        let step = (totalMax - totalMin) / numTiers;
        let baseSize = Math.floor(checkboxes.length / numTiers);
        let remainder = checkboxes.length % numTiers;
        
        let currentArtistIdx = 0;
        for (let t = 0; t < numTiers; t++) {
            let tierMax = totalMax - (t * step);
            let tierMin = totalMax - ((t + 1) * step);
            let countForThisTier = baseSize + (t < remainder ? 1 : 0);
            for (let i = 0; i < countForThisTier; i++) {
                newStyleTags.push({
                    name: formatArtistName(checkboxes[currentArtistIdx].value), 
                    weight: parseFloat(getRandomWeight(tierMin, tierMax))
                });
                currentArtistIdx++;
            }
        }
    } else if (mode === 'manual_tier') {
        let tiersData = getManualTiersData();
        let currentArtistIdx = 0;
        for (let t = 0; t < tiersData.length; t++) {
            for (let i = 0; i < tiersData[t].count; i++) {
                if (currentArtistIdx >= checkboxes.length) break;
                newStyleTags.push({
                    name: formatArtistName(checkboxes[currentArtistIdx].value), 
                    weight: parseFloat(getRandomWeight(tiersData[t].min, tiersData[t].max))
                });
                currentArtistIdx++;
            }
        }
        while (currentArtistIdx < checkboxes.length) {
            let lastTier = tiersData[tiersData.length - 1] || {min: 0.5, max: 1.0};
            newStyleTags.push({
                name: formatArtistName(checkboxes[currentArtistIdx].value), 
                weight: parseFloat(getRandomWeight(lastTier.min, lastTier.max))
            });
            currentArtistIdx++;
        }
    } else if (mode === 'fixed') {
        const fw = parseFloat(el('fixedWeight').value) || 1.0;
        checkboxes.forEach(cb => {
            newStyleTags.push({
                name: formatArtistName(cb.value), 
                weight: fw
            });
        });
    } else { // 'simple'
        const minW = parseFloat(el('simpleMin').value) || 1.0;
        const maxW = parseFloat(el('simpleMax').value) || 1.0;
        checkboxes.forEach(cb => {
            newStyleTags.push({
                name: formatArtistName(cb.value), 
                weight: parseFloat(getRandomWeight(minW, maxW))
            });
        });
    }
    return newStyleTags;
}

function recalculateWeightsOnly() {
    if (currentStyleTags.length === 0) return showToast("현재 적용된 작가가 없습니다.");
    
    const pinnedNames = pinnedArtists.map(p => formatArtistName(p.name));
    
    // 현재 프롬프트에 있는 작가들 중 pinned가 아닌 작가들만 추출하여 mock checkboxes 생성
    let mockCheckboxes = currentStyleTags
        .filter(t => !pinnedNames.includes(formatArtistName(t.name)))
        .map(t => ({ value: t.name }));

    if (mockCheckboxes.length === 0 && pinnedArtists.length === 0) {
        return;
    }

    let newStyleTags = [];
    mockCheckboxes.sort(() => 0.5 - Math.random());
    const mode = el('weightMode').value;
    const useStyleLink = el('useStyleLink')?.checked;

    // 1. 스타일 링크 처리
    let remainingCheckboxes = [];
    if (useStyleLink && mockCheckboxes.length > 0) {
        const selectedStyleName = el('linkStyleSelect')?.value;
        let originalWeightsMap = {};
        if (selectedStyleName && stylesData[selectedStyleName]) {
            try {
                let parsed = JSON.parse(stylesData[selectedStyleName]);
                if (Array.isArray(parsed)) {
                    parsed.forEach(t => originalWeightsMap[formatArtistName(t.name)] = t.weights || [t.weight]);
                }
            } catch(e) {}
        }

        mockCheckboxes.forEach(cb => {
            let artist = formatArtistName(cb.value);
            let origWeights = originalWeightsMap[artist];
            if (origWeights?.length > 0) {
                let origW = origWeights[Math.floor(Math.random() * origWeights.length)];
                let w = 1.0;
                if (origW > 1.5) w = parseFloat(getRandomWeight(1.51, 1.8));
                else if (origW > 1.0) w = parseFloat(getRandomWeight(1.1, 1.5));
                else if (origW > 0.5) w = parseFloat(getRandomWeight(0.51, 1.0));
                else w = parseFloat(getRandomWeight(0.1, 0.5));
                newStyleTags.push({name: artist, weight: w});
            } else {
                remainingCheckboxes.push(cb);
            }
        });
        mockCheckboxes = remainingCheckboxes;
    }

    // 2. 가중치 계산 및 결합
    if (mockCheckboxes.length > 0) {
        newStyleTags = newStyleTags.concat(calculateWeights(mockCheckboxes, mode));
    }

    pinnedArtists.forEach(p => {
        newStyleTags.push({name: formatArtistName(p.name), weight: parseFloat(p.weight)});
    });

    newStyleTags.sort((a, b) => a.weight - b.weight);
    
    // UI 반영
    currentStyleTags = newStyleTags;
    el('stylePromptVisual').style.display = 'flex';
    el('stylePromptTextArea').style.display = 'none';
    renderStyleTags();

    showToast("✅ 현재 작가를 유지하고 가중치만 변경되었습니다.");
}

function applyStyleToPrompt(silent = false) {
    const pinnedNames = pinnedArtists.map(p => p.name);
    let checkboxes = Array.from(document.querySelectorAll('.artist-cb:checked'))
                            .filter(cb => !pinnedNames.includes(cb.value));

    if (checkboxes.length === 0 && pinnedArtists.length === 0) {
        if (!silent) showToast("적용할 작가가 없습니다.");
        currentStyleTags = [];
        renderStyleTags();
        return;
    }

    let newStyleTags = [];
    checkboxes.sort(() => 0.5 - Math.random());
    const mode = el('weightMode').value;
    const useStyleLink = el('useStyleLink')?.checked;

    // 1. 스타일 링크 처리
    let remainingCheckboxes = [];
    if (useStyleLink && checkboxes.length > 0) {
        const selectedStyleName = el('linkStyleSelect')?.value;
        let originalWeightsMap = {};
        if (selectedStyleName && stylesData[selectedStyleName]) {
            try {
                let parsed = JSON.parse(stylesData[selectedStyleName]);
                if (Array.isArray(parsed)) {
                    parsed.forEach(t => originalWeightsMap[formatArtistName(t.name)] = t.weights || [t.weight]);
                }
            } catch(e) {}
        }

        checkboxes.forEach(cb => {
            let artist = formatArtistName(cb.value);
            let origWeights = originalWeightsMap[artist];
            if (origWeights?.length > 0) {
                let origW = origWeights[Math.floor(Math.random() * origWeights.length)];
                let w = 1.0;
                if (origW > 1.5) w = parseFloat(getRandomWeight(1.51, 1.8));
                else if (origW > 1.0) w = parseFloat(getRandomWeight(1.1, 1.5));
                else if (origW > 0.5) w = parseFloat(getRandomWeight(0.51, 1.0));
                else w = parseFloat(getRandomWeight(0.1, 0.5));
                newStyleTags.push({name: artist, weight: w});
            } else {
                remainingCheckboxes.push(cb);
            }
        });
        checkboxes = remainingCheckboxes;
    }

    // 2. 가중치 계산 및 결합
    if (checkboxes.length > 0) {
        newStyleTags = newStyleTags.concat(calculateWeights(checkboxes, mode));
    }

    pinnedArtists.forEach(p => {
        newStyleTags.push({name: formatArtistName(p.name), weight: parseFloat(p.weight)});
    });

    newStyleTags.sort((a, b) => a.weight - b.weight);
    
    // UI 반영
    currentStyleTags = newStyleTags;
    el('stylePromptVisual').style.display = 'flex';
    el('stylePromptTextArea').style.display = 'none';
    renderStyleTags();

    // Subject 프롬프트 정리
    let subjectEl = el('subjectPrompt');
    let subjectText = subjectEl.value.trim();
    if (subjectText && !subjectText.toLowerCase().includes('1girl')) {
        subjectEl.value = '1girl, ' + subjectText;
    }
    el('qualityPrompt').value = DEFAULT_QUALITY_TAGS;

    // Toast 제거 (에러 알림만 위에서 유지)
}

// --- [8] 스타일, 프리셋 저장 및 불러오기 ---
async function fetchStyles() {
    try {
        stylesData = await apiFetch('/api/styles');
        const select = el('savedStylesSelect'), linkSelect = el('linkStyleSelect');
        if (select) select.innerHTML = '<option value="">스타일을 선택하세요...</option>';
        if (linkSelect) linkSelect.innerHTML = '<option value="">(연동할 스타일 선택)</option>';
        for (let styleName in stylesData) {
            if (select) select.innerHTML += `<option value="${styleName}">${styleName}</option>`;
            if (linkSelect) linkSelect.innerHTML += `<option value="${styleName}">${styleName}</option>`;
        }
    } catch (e) { /* handled by apiFetch */ }
}

function openSaveStyleModal() {
    if (currentStyleTags.length === 0) return alert("저장할 그림체 태그가 없습니다.");
    el('saveStyleModal').style.display = 'flex';
    el('newStyleSetName').value = "";
    
    const artists = currentStyleTags.slice(0, 3).map(t => t.name).join(", ");
    const more = currentStyleTags.length > 3 ? ` 외 ${currentStyleTags.length - 3}명` : "";
    el('savePreviewContent').innerHTML = `
        <div style="color: var(--accent-blue); font-weight: bold;">[그림체]</div>
        <div style="margin-bottom: 8px;">${artists}${more}</div>
        <div style="color: var(--success); font-weight: bold;">[퀄리티]</div>
        <div style="font-size: 11px; opacity: 0.8;">현재 Quality Tags 포함 저장</div>
    `;
}

async function confirmSaveStyleSet() {
    const name = el('newStyleSetName').value.trim();
    if (!name) return alert("이름을 입력해주세요.");

    try {
        await apiFetch('/api/styles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: name,
                prompt: JSON.stringify({
                    styleTags: currentStyleTags,
                    qualityTags: el('qualityPrompt').value
                })
            })
        });
        closeSaveStyleModal();
        fetchStyles();
        showToast(`✅ [${name}] 저장되었습니다.`);
    } catch (e) { }
}

function renderStorageList() {
    const container = el('storageList');
    container.innerHTML = '';
    
    if (Object.keys(stylesData).length === 0) {
        container.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-muted);">저장된 데이터가 없습니다.</div>';
        return;
    }

    let styleSetsHtml = '<div style="font-size: 13px; font-weight: bold; margin: 5px 0 8px 0; color: var(--accent-blue);">🎨 그림체 세트 (클릭하여 덮어쓰기)</div>';
    let extractedHtml = '<div style="font-size: 13px; font-weight: bold; margin: 15px 0 8px 0; color: var(--success); border-top: 1px dashed var(--border-color); padding-top: 15px;">🧪 추출된 스타일 원본 (클릭 적용 불가 / 연동용)</div>';
    
    let hasStyleSets = false;
    let hasExtracted = false;

    for (let key in stylesData) {
        let isExtracted = false;
        let metaText = "그림체 태그 + 퀄리티 설정 포함";
        
        // JSON 파싱을 통해 타입 구분 (배열이면 추출된 스타일)
        try {
            const parsed = JSON.parse(stylesData[key]);
            if (Array.isArray(parsed)) {
                isExtracted = true;
                metaText = `추출된 작가 ${parsed.length}명 보관됨`;
            }
        } catch(e) {}

        const itemHtml = `
            <div class="storage-item">
                <div class="storage-info" ${isExtracted ? '' : `onclick="applyStyleSet('${key}')" style="cursor:pointer;"`}>
                    <div class="storage-name">${key}</div>
                    <div class="storage-meta">${metaText}</div>
                </div>
                <button class="icon-btn danger" onclick="deleteStyleSet('${key}')">✕</button>
            </div>
        `;

        if (isExtracted) {
            extractedHtml += itemHtml;
            hasExtracted = true;
        } else {
            styleSetsHtml += itemHtml;
            hasStyleSets = true;
        }
    }

    if (!hasStyleSets) styleSetsHtml += '<div style="font-size: 11px; color: var(--text-muted); padding: 4px;">저장된 그림체 세트가 없습니다.</div>';
    if (!hasExtracted) extractedHtml += '<div style="font-size: 11px; color: var(--text-muted); padding: 4px;">추출된 스타일이 없습니다.</div>';

    container.innerHTML = styleSetsHtml + extractedHtml;
}

let pendingApplyKey = null;

function applyStyleSet(key) {
    pendingApplyKey = key;
    el('applyConfirmMessage').innerHTML = `<strong>[${key}]</strong> 그림체 세트를 적용하시겠습니까?<br><span style="font-size: 12px; color: var(--text-muted);">현재 화면의 프롬프트 구성이 모두 덮어씌워집니다.</span>`;
    el('applyConfirmModal').style.display = 'flex';
    
    // 이전 이벤트 리스너 중복 방지 후 새로운 실행 함수 바인딩
    const btn = el('btnConfirmApply');
    btn.onclick = executeApplyStyleSet;
}

function closeApplyConfirmModal() {
    el('applyConfirmModal').style.display = 'none';
    pendingApplyKey = null;
}

function executeApplyStyleSet() {
    if (!pendingApplyKey) return;
    try {
        const data = JSON.parse(stylesData[pendingApplyKey]);
        if (data.styleTags) {
            currentStyleTags = data.styleTags;
            el('qualityPrompt').value = data.qualityTags || "";
            renderStyleTags();
            updateSpecialButtonsText();
            showToast(`✅ [${pendingApplyKey}] 적용 완료!`);
            closeStorageModal();
            closeApplyConfirmModal(); // 실행 후 모달 닫기
        }
    } catch(e) { 
        alert("데이터 형식 오류가 발생했습니다."); 
    }
}

let pendingDeleteKey = null;

// 삭제 확인 모달 열기
function deleteStyleSet(key) {
    pendingDeleteKey = key;
    const msgArea = el('deleteConfirmMessage');
    
    // 데이터 타입 판별 (배열이면 추출된 스타일)
    let isExtracted = false;
    try {
        const parsed = JSON.parse(stylesData[key]);
        if (Array.isArray(parsed)) isExtracted = true;
    } catch(e) {}

    const typeTitle = isExtracted ? '🧪 추출된 스타일' : '🎨 그림체 세트';
    let warningMsg = isExtracted 
        ? `<div style="margin-top: 10px; padding: 10px; background: rgba(255, 77, 77, 0.1); border-radius: 6px; border: 1px solid var(--danger); color: var(--danger); font-weight: bold;">
            ※ 주의: 이 작업을 수행하면 '목록 관리'의 작가 그룹도 함께 삭제됩니다.
           </div>`
        : `<div style="margin-top: 10px; color: var(--text-muted);">이 작업은 되돌릴 수 없으며, 저장된 프롬프트 정보가 사라집니다.</div>`;

    msgArea.innerHTML = `
        <div style="margin-bottom: 8px;">대상: <strong>${key}</strong> [${typeTitle}]</div>
        <div>해당 항목을 정말로 삭제하시겠습니까?</div>
        ${warningMsg}
    `;

    el('deleteConfirmModal').style.display = 'flex';
    el('btnConfirmDelete').onclick = executeDeleteStyleSet;
}

function closeDeleteConfirmModal() {
    el('deleteConfirmModal').style.display = 'none';
    pendingDeleteKey = null;
}

// 실제 삭제 실행 및 UI 동기화
async function executeDeleteStyleSet() {
    if (!pendingDeleteKey) return;
    const key = pendingDeleteKey;
    
    try {
        await apiFetch('/api/styles', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: key })
        });
        
        showToast(`✅ [${key}] 삭제 완료`);
        closeDeleteConfirmModal();
        
        // UI 전체 동기화 (보관함, 작가 목록, 무작위 설정)
        await fetchStyles(); 
        renderStorageList(); 
        await fetchArtists();
        renderArtistGroups();
        renderRandomGroupInputs();
    } catch (e) {
        console.error("삭제 처리 중 오류 발생:", e);
    }
}

// 퀄리티 매니저
async function openQualityManager() {
    el('qualityManagerModal').style.display = 'flex';
    await renderQualityGroups();
}

async function renderQualityGroups() {
    const container = el('qualityGroupList');
    container.innerHTML = '<div style="text-align:center; padding:20px; color:var(--accent-blue);">로드 중...</div>';
    try {
        const groups = await apiFetch('/api/lab/quality_presets');
        container.innerHTML = '';
        const keys = Object.keys(groups);
        if (keys.length === 0) {
            container.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-muted);">저장된 프리셋이 없습니다.</div>';
            return;
        }
        keys.forEach(key => {
            const item = document.createElement('div');
            item.className = 'storage-item quality-preset-item';
            item.innerHTML = `
                <div class="storage-info" onclick="applyQualityGroup('${key}')">
                    <div class="storage-name">${key}</div>
                    <div class="storage-meta">${groups[key]}</div>
                </div>
                <div style="display: flex; gap: 4px;">
                    <button class="icon-btn" style="width:auto; padding:0 8px; font-size:11px;" onclick="event.stopPropagation(); setDefaultQuality('${key}')" title="기본 퀄리티로 설정">⭐ 기본값</button>
                    <button class="icon-btn danger" onclick="event.stopPropagation(); deleteQualityGroup('${key}')">✕</button>
                </div>
            `;
            container.appendChild(item);
        });
    } catch (e) { container.innerHTML = '<div style="color:var(--danger);">데이터를 불러오지 못했습니다.</div>'; }
}

async function deleteQualityGroup(key) {
    if (!confirm(`'${key}' 프리셋을 삭제하시겠습니까?`)) return;
    try {
        let groups = await apiFetch('/api/lab/quality_presets');
        delete groups[key];
        await apiFetch('/api/lab/quality_presets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(groups)
        });
        await renderQualityGroups();
    } catch (e) { }
}

async function applyQualityGroup(key) {
    try {
        const groups = await apiFetch('/api/lab/quality_presets');
        if (groups[key]) {
            el('qualityPrompt').value = groups[key];
            updateSpecialButtonsText();
            closeQualityManager();
            saveConfig(true); 
        }
    } catch (e) { }
}

async function saveCurrentQualityGroup() {
    const nameInput = el('newQualityGroupName');
    const name = nameInput.value.trim();
    const currentTags = el('qualityPrompt').value.trim();

    if (!name) return alert("프리셋 이름을 입력하세요.");

    try {
        let groups = await apiFetch('/api/lab/quality_presets');
        groups[name] = currentTags;
        await apiFetch('/api/lab/quality_presets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(groups)
        });
        nameInput.value = '';
        await renderQualityGroups();
        showToast(`✅ [${name}] 저장 완료!`);
        setTimeout(() => closeQualityManager(), 500);
    } catch (e) { }
}

// --- [9] 생성(Generation) 및 해상도/비용(Anlas) 처리 ---
async function checkAnlas() {
    const key = el('apiKey').value.trim();
    const anlasEl = el('currentAnlas');
    if(!key) return anlasEl.innerText = "키를 입력해주세요";
    try {
        const data = await apiFetch('/api/anlas?key=' + encodeURIComponent(key));
        if (data.anlas !== undefined) { 
            anlasEl.innerText = data.anlas + " Anlas"; 
            anlasEl.style.color = 'var(--success)'; 
        } else {
            anlasEl.innerText = "조회 실패";
        }
    } catch(e) { anlasEl.innerText = "오류"; }
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

function onManualInput() { el('resPreset').value = 'manual'; calcAnlas(); }

function calcAnlas() {
    const w = parseInt(el('width')?.value) || 0;
    const h = parseInt(el('height')?.value) || 0;
    const steps = parseInt(el('steps')?.value) || 0;
    const ratioInfoElem = el('ratioInfo');
    const expectedAnlasElem = el('expectedAnlas');
    
    if (w > 0 && h > 0 && ratioInfoElem) {
        const matchRate = (100 - (Math.abs(16/5 - h/w) / (16/5)) * 100).toFixed(1);
        ratioInfoElem.innerText = `비율 5 : ${(h/w * 5).toFixed(2)} (일치율 ${matchRate}%)`;
        ratioInfoElem.style.color = matchRate >= 99 ? "var(--success)" : (matchRate >= 95 ? "#ff9f0a" : "var(--danger)");
    }
    
    if (!expectedAnlasElem) return;
    if (w * h <= 1048576 && steps <= 28) { 
        expectedAnlasElem.innerText = "비용: 0 (Opus)"; 
        expectedAnlasElem.style.color = "var(--success)"; 
    } else { 
        expectedAnlasElem.innerText = `예상: ${Math.max(2, Math.ceil((w * h * steps) / 1460000))} Anlas`; 
        expectedAnlasElem.style.color = "var(--danger)"; 
    }
}

async function generateImage() {
    const width = parseInt(el('width').value);
    const height = parseInt(el('height').value);
    
    if (width % 64 !== 0 || height % 64 !== 0) return alert("가로/세로 사이즈는 64의 배수여야 합니다.");
    if (width * height > 1048576 && !confirm("Anlas가 소모될 수 있습니다. 계속하시겠습니까?")) return;

    el('loadingIndicator').style.display = 'block'; 
    el('saveBtn').style.display = 'none'; 
    el('previewImage').style.display = 'none';

    try {
        const data = await apiFetch('/api/generate', { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({
                key: el('apiKey').value,
                base_prompt: getFullPrompt(),
                char_prompt: el('charPrompt').value,
                negative_prompt: el('negPrompt').value,
                width: width, height: height,
                scale: parseFloat(el('scale').value),
                cfg_rescale: parseFloat(el('cfgRescale').value),
                steps: parseInt(el('steps').value),
                sampler: el('sampler').value
            })
        });

        el('loadingIndicator').style.display = 'none';

        if (data.image) {
            currentImageBase64 = data.image;
            el('previewImage').src = currentImageBase64;
            el('previewImage').style.display = 'block';
            el('saveBtn').style.display = 'block';
            saveConfig(true);

            // 히스토리 항목 생성
            const historyImg = document.createElement('img');
            historyImg.src = currentImageBase64; 
            historyImg.className = 'history-item';
            historyImg.dataset.subject = el('subjectPrompt').value;
            historyImg.dataset.style = JSON.stringify(currentStyleTags);
            historyImg.dataset.quality = el('qualityPrompt').value;
            historyImg.dataset.daki = el('dakiPrompt').value;
            historyImg.dataset.char = el('charPrompt').value;
            historyImg.dataset.neg = el('negPrompt').value;
            
            historyImg.onclick = function() {
                el('previewImage').src = this.src; 
                currentImageBase64 = this.src; 
                el('saveBtn').style.display = 'block';
                el('subjectPrompt').value = this.dataset.subject || '';
                try { 
                    currentStyleTags = JSON.parse(this.dataset.style || '[]'); 
                    renderStyleTags(); 
                } catch(e) {}
                el('qualityPrompt').value = this.dataset.quality || '';
                el('dakiPrompt').value = this.dataset.daki || '';
                el('charPrompt').value = this.dataset.char || '';
                el('negPrompt').value = this.dataset.neg || '';
                updateSpecialButtonsText();
            };
            el('historyArea').prepend(historyImg);
            checkAnlas();
        }
    } catch (e) { 
        el('loadingIndicator').style.display = 'none'; 
    }
}

async function saveImage() {
    if (!currentImageBase64) return;
    try {
        const data = await apiFetch('/api/save', { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({
                image: currentImageBase64, 
                key: el('apiKey').value, 
                base_prompt: getFullPrompt(),
                char_prompt: el('charPrompt').value, 
                negative_prompt: el('negPrompt').value
            }) 
        });
        if (data.status === 'saved') showToast("✅ 저장 완료: " + data.path);
    } catch (e) {
        // 백업 플랜: 브라우저 다운로드
        const a = document.createElement('a');
        a.href = currentImageBase64;
        a.download = `NAIA_Lab_${new Date().getTime()}.png`;
        document.body.appendChild(a); 
        a.click(); 
        document.body.removeChild(a);
    }
}

// --- [10] 그림체 추출기 (Stealth PNG / Metadata 해독) ---
let isExtracting = false;
let accumulatedTags = [];
let currentExtractStyleName = "";
let processedImageCount = 0;

function initDropZone() {
    const dz = el('dropZone');
    if (!dz) return;
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('hover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('hover'));
    dz.addEventListener('drop', (e) => {
        e.preventDefault(); dz.classList.remove('hover');
        if (!isExtracting) {
            showToast("⚠️ 먼저 '▶️ 추출 시작' 버튼을 눌러주세요!");
            return;
        }
        Array.from(e.dataTransfer.files).forEach(file => processFile(file));
    });
}

function startExtraction() {
    const targetName = el('styleTargetName').value.trim();
    if (!targetName) return alert("저장할 스타일명을 입력하세요.");
    
    currentExtractStyleName = targetName;
    isExtracting = true;
    accumulatedTags = [];
    processedImageCount = 0;
    
    el('activeStyleNameDisplay').innerText = targetName;
    el('activePanel').style.display = 'block';
    el('startExtractBtn').disabled = true;
    el('styleTargetName').disabled = true;
    el('imgCount').innerText = `(0장)`;
    el('logArea').innerHTML = '';
    el('imageList').innerHTML = '';
}

function cancelExtraction() {
    isExtracting = false;
    el('activePanel').style.display = 'none';
    el('startExtractBtn').disabled = false;
    el('styleTargetName').disabled = false;
    
    accumulatedTags = [];
    processedImageCount = 0;
    showToast("❌ 수집이 취소되었습니다.");
}

async function stopExtraction() {
    isExtracting = false;
    el('activePanel').style.display = 'none';
    el('startExtractBtn').disabled = false;
    el('styleTargetName').disabled = false;
    
    if (accumulatedTags.length === 0) {
        showToast("수집된 태그가 없습니다.");
        return;
    }

    // 중복 제거 및 가중치 병합 (여기서는 최댓값 기준 또는 첫 번째 값 유지 등 가능하지만 단순 중복 제거로 처리)
    let uniqueTagsMap = new Map();
    accumulatedTags.forEach(t => {
        if (!uniqueTagsMap.has(t.name)) {
            uniqueTagsMap.set(t.name, t);
        } else {
            // 원한다면 평균을 내거나 최댓값을 쓸 수 있음. 현재는 기존 로직(Set)과 유사하게 최초 값 유지
        }
    });
    let finalTags = Array.from(uniqueTagsMap.values());

    await enqueueSave(currentExtractStyleName, finalTags);
    showToast(`✅ [${currentExtractStyleName}]에 총 ${finalTags.length}명의 작가가 저장되었습니다.`);
    fetchStyles(); // 목록 새로고침
    fetchArtists(); // 🌟 좌측 패널(작가 목록) 강제 새로고침 추가!
}

function processFile(file) {
    if (!file || !file.type.match('image.*')) return;
    
    const formData = new FormData();
    formData.append('file', file);
    
    // 미리보기 썸네일 표시용
    const fileUrl = URL.createObjectURL(file);

    fetch('/api/extract_metadata', {
        method: 'POST',
        body: formData
    })
    .then(response => response.json())
    .then(data => {
        if (data.error) {
            addLog(file.name, `오류 발생: ${data.error}`, 'error');
            return;
        }
        
        let prompt = data.prompt;
        if (prompt) {
            let tags = parseTagsFromPrompt(prompt);
            if (tags.length > 0) {
                accumulatedTags.push(...tags);
                processedImageCount++;
                
                // 중복을 제거한 유니크 작가 수 계산
                let uniqueArtistsCount = new Set(accumulatedTags.map(t => t.name)).size;
                
                el('imgCount').innerText = `(${processedImageCount}장, ${uniqueArtistsCount}명 발견)`;
                addLog(file.name, `작가태그 ${tags.length}개 발견 (총 유니크: ${uniqueArtistsCount}명)`, 'success');
                
                const thumb = document.createElement('img');
                thumb.src = fileUrl;
                el('imageList').appendChild(thumb);
            } else {
                addLog(file.name, "작가태그가 없습니다.", 'error');
            }
        } else {
            addLog(file.name, "메타데이터가 없습니다.", 'error');
        }
    })
    .catch(err => {
        addLog(file.name, `서버 통신 실패: ${err.message}`, 'error');
    });
}

function addLog(fileName, message, type) {
    const logDiv = document.createElement('div');
    logDiv.className = `log-item ${type === 'success' ? 'log-success' : 'log-error'}`;
    logDiv.innerText = `${type === 'error' ? '⚠️' : '✅'} [${fileName}] ${message}`;
    el('logArea').prepend(logDiv);
}

function parseTagsFromPrompt(prompt) {
    let tags = [];
    const regex = /([0-9.]+)::artist:([^:]+)::/g;
    let match;
    while ((match = regex.exec(prompt)) !== null) {
        tags.push({weight: parseFloat(match[1]), name: match[2].trim()});
    }
    return tags;
}

async function enqueueSave(baseName, tags) {
    try {
        let dataA = await apiFetch('/api/artists');
        if (!dataA[baseName]) dataA[baseName] = [];
        let set = new Set(dataA[baseName]);
        tags.forEach(t => set.add(t.name));
        dataA[baseName] = Array.from(set);
        await apiFetch('/api/artists', { 
            method: 'POST', 
            headers: {'Content-Type': 'application/json'}, 
            body: JSON.stringify(dataA) 
        });

        let dataS = await apiFetch('/api/styles');
        dataS[baseName] = JSON.stringify(tags);
        await apiFetch('/api/styles', { 
            method: 'POST', 
            headers: {'Content-Type': 'application/json'}, 
            body: JSON.stringify({name: baseName, prompt: dataS[baseName]}) 
        });
    } catch (e) { console.error(e); }
}

async function updateNextStyleName() {
    const input = el('styleTargetName');
    if (!input) return;

    try {
        const artistsData = await apiFetch('/api/artists');
        let maxN = 0;
        for (let key in artistsData) {
            let match = key.match(/^스타일\s*(\d+)/);
            if (match) {
                let n = parseInt(match[1]);
                if (n > maxN) maxN = n; 
            }
        }
        input.value = `스타일 ${maxN + 1}`;
    } catch (e) {
        input.value = "새 스타일"; 
    }
}
