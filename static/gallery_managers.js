// Gallery feature functions; shared state is declared in index.js.
async function toggleStats() {
    const layer = document.getElementById('statsLayer');
    if (!layer) return;

    if (layer.style.display === 'flex') {
        layer.style.display = 'none';
    } else {
        layer.style.display = 'flex';
        await loadStats();
    }
}

async function loadStats() {
    const body = document.getElementById('statsBody');
    if (!body) return;

    body.innerHTML = '<div style="text-align:center; padding:50px; color:#6f42c1;">📊 아카이브 데이터 정밀 분석 중...</div>';

    try {
        const res = await fetch(`/api/stats?threshold=${statsThreshold}&include_daki=${includeDaki}`);
        const data = await res.json();

        let html = `
            <div style="margin-bottom:20px; display:flex; flex-wrap:wrap; align-items:center; gap:20px; background:#1a1a24; padding:15px; border-radius:10px; border:1px solid #333;">
                <div style="display:flex; align-items:center; gap:10px;">
                    <span style="font-size:13px; color:#888;">최소 보유량:</span>
                    <input type="number" value="${statsThreshold}" onchange="statsThreshold=parseInt(this.value)||0; loadStats();"
                            style="background:#000; border:1px solid #444; color:#fff; padding:5px 10px; border-radius:5px; width:70px;">
                </div>
                <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:13px; color:#eee;">
                    <input type="checkbox" ${includeDaki ? 'checked' : ''} onchange="includeDaki=this.checked; loadStats();"
                            style="accent-color:#39ff14; width:16px; height:16px;">
                    다키마쿠라 데이터 포함
                </label>
            </div>

            <div class="stats-grid">
                <div class="stat-box"><span>총 파일 수</span><span class="stat-val">${data.summary.total_count.toLocaleString()}</span></div>
                <div class="stat-box"><span>전체 야짤 비율</span><span class="stat-val" style="color:#ff007c;">${data.summary.nsfw_ratio}%</span></div>
                <div class="stat-box"><span>수집 캐릭터 수</span><span class="stat-val" style="color:#39ff14;">${data.summary.char_count}</span></div>
            </div>

            <table class="stats-table">
                <thead>
                    <tr>
                        <th style="width:50px;">순위</th>
                        <th>캐릭터</th>
                        <th style="width:70px;">전체</th>
                        <th style="width:70px; color:#39ff14;">일반</th>
                        <th style="width:70px; color:#ff007c;">R-19</th>
                        <th style="width:160px;">분포도</th>
                    </tr>
                </thead>
                <tbody>`;

        data.list.forEach((s, i) => {
            const safePer = s.total > 0 ? Math.round((s.safe / s.total) * 100) : 0;
            const nsfwPer = 100 - safePer;
            const isDaki = s.name.includes('(다키)');

            html += `
                <tr>
                    <td style="color:#666;">${i+1}</td>
                    <td style="font-weight:bold; color:${isDaki ? '#39ff14' : '#eee'}">${s.name}</td>
                    <td style="font-weight:900;">${s.total}</td>
                    <td style="color:#39ff14;">${s.safe}</td>
                    <td style="color:#ff007c;">${s.nsfw}</td>
                    <td>
                        <div class="bar-wrap">
                            <div class="bar-fill" style="width:${safePer}%; background:#39ff14; float:left;"></div>
                            <div class="bar-fill" style="width:${nsfwPer}%; background:#ff007c; float:left;"></div>
                        </div>
                        <span style="font-size:11px; color:#888;">${safePer}%</span>
                    </td>
                </tr>`;
        });

        html += `</tbody></table>`;
        body.innerHTML = html;
    } catch(e) {
        console.error("Stats loading error:", e);
        body.innerHTML = '<div style="color:#ff4d4d; padding:20px;">데이터를 불러오지 못했습니다. 서버가 실행 중인지 확인하세요.</div>';
    }
}

async function toggleBrandManager() {
    const layer = document.getElementById('brandLayer');
    if (layer.style.display === 'flex') {
        layer.style.display = 'none';
    } else {
        layer.style.display = 'flex';
        await loadBrandMgrData();
    }
}

async function loadBrandMgrData() {
    const container = document.getElementById('brandMgrTableContainer');
    container.innerHTML = '<div style="text-align:center; padding:50px; color:#ff007c;">📊 브랜드 데이터를 집계 중입니다...</div>';

    try {
        const res = await fetch('/api/brand_stats');
        const text = await res.text();

        let brandData = null;
        try {
            brandData = text ? JSON.parse(text) : null;
        } catch (parseError) {
            throw new Error(`브랜드 API가 JSON이 아닌 응답을 보냈습니다. HTTP ${res.status}`);
        }

        if (!res.ok || (brandData && brandData.status === 'error')) {
            throw new Error(brandData?.message || `HTTP ${res.status}`);
        }

        renderBrandMgrTable(brandData);
    } catch(e) {
        container.innerHTML = `<div style="color:red; padding:20px;">브랜드 데이터 로드 실패: ${escapeHtml(e.message || e)}</div>`;
    }
}

// index.html 내 renderBrandMgrTable 함수 수정
function renderBrandMgrTable(data) {
    const container = document.getElementById('brandMgrTableContainer');
    let html = `<table class="stats-table">
        <thead>
            <tr>
                <th style="text-align:center; width:60px;">노출</th>
                <th>브랜드 (English)</th>
                <th style="width:280px;">한국어 명칭</th>
                <th style="width:80px;">파일 수</th>
                <th style="width:80px;">R-19</th>
            </tr>
        </thead>
        <tbody>`;

    data.forEach(b => {
        if(b.name === "Unknown") return;
        const safeId = b.raw_name.replace(/[^a-zA-Z0-9]/g, '_');

        // 🌟 [수정] 10장 미만은 무조건 체크 해제 상태로 보이게 로직 강화
        // 사용자가 명시적으로 켠 것(is_visible=1)이 아니라면, 10장 미만은 false 처리
        let isChecked = false;
        if (b.is_visible === 1) {
            isChecked = true;
        } else if (b.is_visible === 0) {
            isChecked = false;
        } else {
            // 아직 설정값이 없는 신규 데이터만 10장 법칙 적용
            isChecked = b.total >= 10;
        }

        // 만약 '설정은 1인데 짤은 10장 미만'인 모순된 경우에도
        // 일단 사용자님이 한번 저장하기 전까지는 10장 법칙을 우선 적용하고 싶다면 아래 주석 해제:
        if (b.total < 10 && b.is_visible !== 1) isChecked = false;

        html += `
            <tr class="brand-row" data-raw="${b.raw_name}" data-name="${(b.name || '').toLowerCase()}" data-kr="${(b.name_kr || '').toLowerCase()}">
                <td style="text-align:center;">
                    <input type="checkbox" class="brand-vis-check" ${isChecked ? 'checked' : ''}
                            style="width:18px; height:18px; accent-color:#39ff14; cursor:pointer;">
                </td>
                <td style="color:#aaa; font-size:13px;">${b.name}</td>
                <td>
                    <input type="text" value="${b.name_kr || ''}" class="brand-kr-input" placeholder="비워두면 영어 이름 사용"
                            style="background:#1a1a24; border:1px solid #333; color:#fff; width:95%; padding:8px; border-radius:5px;">
                </td>
                <td style="font-weight:bold;">${b.total.toLocaleString()}</td>
                <td style="color:#ff007c;">${Math.round((b.nsfw/b.total)*100 || 0)}%</td>
            </tr>`;
    });
    html += `</tbody></table>`;
    container.innerHTML = html;
}

function filterBrandMgrTable() {
    const term = document.getElementById('brand-mgr-search').value.toLowerCase();
    document.querySelectorAll('.brand-row').forEach(row => {
        const en = (row.getAttribute('data-name') || '').toLowerCase();
        const krInput = row.querySelector('.brand-kr-input');
        const kr = ((krInput && krInput.value) || row.getAttribute('data-kr') || '').toLowerCase();
        row.style.display = (en.includes(term) || kr.includes(term)) ? '' : 'none';
    });
}

async function saveAllBrandChanges() {
    const btn = document.getElementById('bulkSaveBtn');
    const rows = document.querySelectorAll('.brand-row');
    const updateData = [];

    rows.forEach(row => {
        const rawName = row.getAttribute('data-raw');
        const krName = row.querySelector('.brand-kr-input').value.trim();
        const isVisible = row.querySelector('.brand-vis-check').checked ? 1 : 0;
        updateData.push({ raw_name: rawName, brand_kr: krName, is_visible: isVisible });
    });

    btn.innerText = "⏳ 서버에 기록 중...";
    btn.disabled = true;

    try {
        const res = await fetch('/api/bulk_update_brands', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(updateData)
        });
        const result = await res.json();

        if (result.status === 'success') {
            btn.innerText = "✅ 저장 완료!";
            btn.style.background = "#fff";

            // 메인 화면 필터 갱신을 위해 데이터 재로드
            loadData();

            setTimeout(() => {
                btn.innerText = "🚀 모든 변경사항 일괄 저장";
                btn.style.background = "#39ff14";
                btn.disabled = false;
            }, 2000);
        }
    } catch(e) {
        alert("일괄 저장 실패!");
        btn.disabled = false;
    }
}
// 🌟 현재 화면(검색 결과 포함)에 보이는 모든 체크박스 조작
function setAllBrandCheck(status) {
    const rows = document.querySelectorAll('.brand-row');
    rows.forEach(row => {
        if (row.style.display !== 'none') {
            row.querySelector('.brand-vis-check').checked = status;
        }
    });
}

function openGalleryTagManager() {
    const layer = document.getElementById('galleryTagManagerLayer');
    if (!layer) return;

    pendingGalleryTagImageDataUrl = '';
    syncGalleryTagTypeInput();
    renderGalleryTagManagerList();
    updateGalleryTextTagPreview();
    layer.style.display = 'flex';
}

function closeGalleryTagManager() {
    const layer = document.getElementById('galleryTagManagerLayer');
    if (layer) layer.style.display = 'none';
}

function syncGalleryTagTypeInput() {
    const preview = document.getElementById('galleryTagImagePreview');
    if (preview) {
        preview.innerHTML = pendingGalleryTagImageDataUrl
            ? `<img src="${escapeHtml(pendingGalleryTagImageDataUrl)}" alt="">`
            : '';
    }

    updateGalleryTextTagPreview();
}

function updateGalleryTextTagPreview() {
    const input = document.getElementById('galleryTagTextInput');
    const textColorInput = document.getElementById('galleryTagTextColorInput');
    const bgColorInput = document.getElementById('galleryTagBgColorInput');
    const preview = document.getElementById('galleryTagTextPreview');

    if (!preview) return;

    const text = String(input?.value || '').trim() || '확인';
    const textColor = textColorInput?.value || '#ffffff';
    const bgColor = bgColorInput?.value || '#2563eb';

    preview.textContent = text;
    preview.style.color = textColor;
    preview.style.background = bgColor;
}

document.addEventListener('change', (event) => {
    if (event.target && event.target.id === 'galleryTagImageInput') {
        const file = event.target.files && event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = () => {
            pendingGalleryTagImageDataUrl = String(reader.result || '');
            syncGalleryTagTypeInput();
            addGalleryImageTagFromManager();
        };
        reader.readAsDataURL(file);
    }
});

document.addEventListener('input', (event) => {
    if (
        event.target &&
        ['galleryTagTextInput', 'galleryTagTextColorInput', 'galleryTagBgColorInput'].includes(event.target.id)
    ) {
        updateGalleryTextTagPreview();
    }
});

function makeGalleryTagId(name) {
    const base = String(name || 'tag')
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[^\w가-힣ㄱ-ㅎㅏ-ㅣ-]+/g, '_')
        .replace(/^_+|_+$/g, '') || `tag_${Date.now()}`;

    let id = base;
    let seq = 2;
    const used = new Set(galleryTagDefs.map(tag => String(tag.id)));

    while (used.has(id)) {
        id = `${base}_${seq++}`;
    }

    return id;
}

function addGalleryImageTagFromManager() {
    if (!pendingGalleryTagImageDataUrl) {
        alert('추가할 태그 그림을 선택하세요.');
        return;
    }

    galleryTagDefs.push({
        id: makeGalleryTagId(`image_tag_${Date.now()}`),
        type: 'image',
        value: pendingGalleryTagImageDataUrl
    });

    pendingGalleryTagImageDataUrl = '';

    const fileInput = document.getElementById('galleryTagImageInput');
    if (fileInput) fileInput.value = '';

    const preview = document.getElementById('galleryTagImagePreview');
    if (preview) preview.innerHTML = '';

    renderGalleryTagManagerList();
}

function addGalleryTextTagFromManager() {
    const textInput = document.getElementById('galleryTagTextInput');
    const textColorInput = document.getElementById('galleryTagTextColorInput');
    const bgColorInput = document.getElementById('galleryTagBgColorInput');

    const value = String(textInput?.value || '').trim();

    if (!value) {
        alert('글자 태그 내용을 입력하세요.');
        return;
    }

    galleryTagDefs.push({
        id: makeGalleryTagId(value),
        type: 'text',
        value: value.slice(0, 12),
        textColor: textColorInput?.value || '#ffffff',
        bgColor: bgColorInput?.value || '#2563eb'
    });

    if (textInput) textInput.value = '';

    updateGalleryTextTagPreview();
    renderGalleryTagManagerList();
}

function deleteGalleryTagFromManager(tagId) {
    const tag = getGalleryTagDef(tagId);
    if (!tag) return;

    const usedCount = Object.values(galleryImageTags || {}).filter(id => String(id) === String(tagId)).length;

    const label = tag.type === 'text' ? `'${tag.value}'` : '이 그림';
    const ok = confirm(
        usedCount > 0
            ? `${label} 태그를 삭제할까요?\n이 태그가 붙은 이미지 ${usedCount}개의 태그도 함께 제거됩니다.`
            : `${label} 태그를 삭제할까요?`
    );

    if (!ok) return;

    galleryTagDefs = galleryTagDefs.filter(item => String(item.id) !== String(tagId));

    Object.keys(galleryImageTags || {}).forEach(path => {
        if (String(galleryImageTags[path]) === String(tagId)) {
            delete galleryImageTags[path];
        }
    });

    const currentNode = currentPath[currentPath.length - 1];
    if (currentNode && Array.isArray(currentNode.images)) {
        currentNode.images.forEach(item => {
            if (String(item.gallery_tag || '') === String(tagId)) {
                item.gallery_tag = '';
            }
        });
    }

    if (currentGalleryTagFilter === tagId) {
        currentGalleryTagFilter = 'ALL';
    }

    renderGalleryTagManagerList();
    renderGalleryTagFilterBar();
    renderView();
}

function renderGalleryTagManagerList() {
    const list = document.getElementById('galleryTagManagerList');
    if (!list) return;

    if (!galleryTagDefs.length) {
        list.innerHTML = '<div style="color:#888; padding:20px; text-align:center;">등록된 태그가 없습니다.</div>';
        return;
    }

    list.innerHTML = galleryTagDefs.map((tag, index) => {
        const usedCount = Object.values(galleryImageTags || {}).filter(id => String(id) === String(tag.id)).length;
        const iconHtml = renderGalleryTagIcon(tag);
        const typeLabel = tag.type === 'text' ? '글자' : '그림';

        return `
            <div class="gallery-tag-manager-row simple">
                <div class="gallery-tag-manager-icon">${iconHtml}</div>
                <div class="gallery-tag-manager-count">${typeLabel} · 사용 ${usedCount}개</div>
                <button type="button" class="gallery-tag-delete-btn" onclick="deleteGalleryTagFromManager('${escapeHtml(tag.id)}')">삭제</button>
            </div>
        `;
    }).join('');
}

async function saveGalleryTagsFromManager() {
    try {
        const res = await fetch('/api/gallery/tags', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ tags: galleryTagDefs })
        });

        const json = await res.json();

        if (!res.ok || json.status !== 'success') {
            throw new Error(json.message || '태그 저장 실패');
        }

        galleryTagDefs = json.tags || galleryTagDefs;
        galleryImageTags = json.image_tags || galleryImageTags;

        renderGalleryTagFilterBar();
        renderView();
        closeGalleryTagManager();
        showToast('태그 설정을 저장했습니다.');
    } catch (error) {
        alert(`태그 저장 실패: ${error.message || error}`);
    }
}

// 🌟 [추가] 그림체(아티스트) 관리 스크립트
async function toggleArtStyleManager() {
    const layer = document.getElementById('artStyleLayer');
    if (layer.style.display === 'flex') {
        layer.style.display = 'none';
    } else {
        layer.style.display = 'flex';
        await loadArtStyleData();
    }
}

// [수정] 그림체 데이터 로드 및 필터 상태 강제 적용
async function loadArtStyleData() {
    const container = document.getElementById('artStyleTableContainer');
    container.innerHTML = '<div style="text-align:center; padding:50px; color:#f1c40f;">📊 그림체 데이터를 집계 중입니다...</div>';

    try {
        const res = await fetch('/api/art_style_stats');
        const text = await res.text();

        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch (parseError) {
            throw new Error(`그림체 API가 JSON이 아닌 응답을 보냈습니다. HTTP ${res.status}`);
        }

        if (!res.ok || (data && data.status === 'error')) {
            throw new Error(data?.message || `HTTP ${res.status}`);
        }

        renderArtStyleTable(data);
        filterArtStyleTable();

    } catch(e) {
        container.innerHTML = `<div style="color:red; padding:20px;">그림체 데이터 로드 실패: ${escapeHtml(e.message || e)}</div>`;
    }
}

function renderArtStyleTable(data) {
    const container = document.getElementById('artStyleTableContainer');

    // 🌟 [추가] 서버에서 에러 응답 시 화면 멈춤 현상(무한 로딩) 해결
    if (data && data.status === 'error') {
        container.innerHTML = `<div style="text-align:center; padding:50px; color:#ff4d4d; font-weight:bold;">오류 발생: ${escapeHtml(data.message)}</div>`;
        return;
    }

    if (!data || data.length === 0) {
        container.innerHTML = '<div style="text-align:center; padding:50px; color:#888;">수집된 그림체(아티스트)가 없습니다. 스캔 버튼을 눌러주세요.</div>';
        return;
    }

    let html = `<table class="stats-table" style="width:100%; border-collapse:collapse; table-layout: fixed;">
        <thead>
            <tr>
                <th style="width:200px;">그림체 (아티스트)</th>
                <th style="width:200px;">한국어 명칭</th>
                <th style="width:80px; text-align:center;">보유 수</th>
                <th style="width:300px;">미리보기 샘플 (클릭시 확대)</th>
            </tr>
        </thead>
        <tbody>`;

    data.forEach((a, i) => {
        const safeId = a.artist_name.replace(/[^a-zA-Z0-9]/g, '') + '_' + i;

        let samplesHtml = a.samples.map(p => {
            const encP = encodeURIComponent(p);
            const zoomP = JSON.stringify(`/image/${p}`).replace(/"/g, '&quot;');
            return `<img src="/image/${encP}" loading="lazy" style="height:65px; width:65px; object-fit:cover; border-radius:5px; border:1px solid #444; cursor:pointer; transition:0.2s;" onmouseover="this.style.borderColor='#f1c40f'" onmouseout="this.style.borderColor='#444'" onclick="openZoom(${zoomP})">`
        }).join('');

        const safeArtistName = JSON.stringify(a.artist_name).replace(/"/g, '&quot;');

        html += `
            <tr class="art-row" data-name="${a.artist_name.toLowerCase()}">
                <td>
                    <div style="display:flex; align-items:center; justify-content:space-between; gap:5px;">
                        <div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color:#f1c40f; font-weight:bold; font-size:13px;" title="${a.artist_name}">
                            ${a.artist_name}
                        </div>
                        <button onclick="openArtStyleDetail(${safeArtistName})" style="background:#f1c40f; color:#000; border:none; border-radius:3px; padding:3px 6px; cursor:pointer; font-size:11px; font-weight:bold; flex-shrink:0;">🔍확대</button>
                    </div>
                </td>
                <td>
                    <input type="text" value="${a.name_kr || ''}" class="art-kr-input" placeholder="커스텀 이름 입력"
                            style="background:#1a1a24; border:1px solid #333; color:#fff; width:90%; padding:8px; border-radius:5px;">
                </td>
                <td style="font-weight:bold; color:#fff; text-align:center;">${(a.count || 0).toLocaleString()}</td>
                <td>
                    <div style="display:flex; gap:15px; align-items:center;">
                        <button onclick="refreshRandomArtist(${safeArtistName}, 'samples_${safeId}')" style="background:#222; border:1px solid #444; color:#fff; padding:6px 12px; font-weight:bold; border-radius:5px; cursor:pointer; flex-shrink:0;">🔄 변경</button>
                        <div id="samples_${safeId}" style="display:flex; gap:8px; overflow:hidden;">${samplesHtml}</div>
                    </div>
                </td>
            </tr>`;
    });
    html += `</tbody></table>`;
    container.innerHTML = html;
}

async function refreshRandomArtist(artistName, containerId) {
    try {
        const res = await fetch(`/api/random_artist_images?artist=${encodeURIComponent(artistName)}`);
        const data = await res.json();
        if(data.samples) {
            const html = data.samples.map(p =>
                `<img src="/image/${encodeURIComponent(p)}" style="height:65px; width:65px; object-fit:cover; border-radius:5px; border:1px solid #444; cursor:pointer; transition:0.2s;" onmouseover="this.style.borderColor='#f1c40f'" onmouseout="this.style.borderColor='#444'" onclick="openZoom('/image/${encodeURIComponent(p)}')">`
            ).join('');
            document.getElementById(containerId).innerHTML = html;
        }
    } catch(e) { console.error(e); }
}

// 🌟 [추가] 현재 선택된 필터 상태를 저장하는 전역 변수
let currentArtStyleFilter = 'all';

// 🌟 [추가] 그림체 필터 변경 및 버튼 스타일 업데이트 함수
function setArtStyleFilter(type) {
    currentArtStyleFilter = type;

    document.getElementById('btnFilterAll').style.background = (type === 'all') ? '#f1c40f' : 'transparent';
    document.getElementById('btnFilterAll').style.color = (type === 'all') ? '#000' : '#fff';

    document.getElementById('btnFilterStd').style.background = (type === 'std') ? '#f1c40f' : 'transparent';
    document.getElementById('btnFilterStd').style.color = (type === 'std') ? '#000' : '#fff';

    document.getElementById('btnFilterWeight').style.background = (type === 'weight') ? '#f1c40f' : 'transparent';
    document.getElementById('btnFilterWeight').style.color = (type === 'weight') ? '#000' : '#fff';

    filterArtStyleTable();
}

// 🌟 [수정] 검색어와 필터 타입(조합형 vs 가중치)을 동시에 검사하는 필터링 로직
function filterArtStyleTable() {
    const searchInput = document.getElementById('art-style-search');
    if(!searchInput) return;
    const query = searchInput.value.toLowerCase();
    const rows = document.querySelectorAll('.art-row');

    rows.forEach(row => {
        const name = row.getAttribute('data-name');
        if(!name) return;
        const krInput = row.querySelector('.art-kr-input');
        const krName = krInput ? krInput.value.toLowerCase() : '';

        const isWeight = name.startsWith('[가중치]');

        let typeMatch = true;
        if (currentArtStyleFilter === 'std' && isWeight) typeMatch = false;
        if (currentArtStyleFilter === 'weight' && !isWeight) typeMatch = false;

        if (typeMatch && (name.includes(query) || krName.includes(query))) {
            row.style.display = '';
        } else {
            row.style.display = 'none';
        }
    });
}

// 🌟 [추가] 그림체 상세 보기 팝업 제어 스크립트
// 🌟 [수정] 텍스트 내의 이중 이스케이프된 줄바꿈까지 완벽하게 처리하여 깨끗하게 표시
function openArtStyleDetail(fullText) {
    let formattedText = String(fullText || '')
        .replace(/\\\\n/g, '\n')  // 이중 역슬래시 처리
        .replace(/\\n/g, '\n');   // 단일 역슬래시 처리

    // 가중치 태그가 없는 일반 조합형일 경우에만 쉼표를 줄바꿈으로 변환
    if (!formattedText.startsWith('[가중치]') && formattedText.includes(', ')) {
        formattedText = formattedText.split(', ').join('\n');
    }

    document.getElementById('artStyleDetailArea').value = formattedText;
    document.getElementById('artStyleDetailLayer').style.display = 'flex';
}

function closeArtStyleDetail() {
    document.getElementById('artStyleDetailLayer').style.display = 'none';
}

function copyArtStyleDetail() {
    const area = document.getElementById('artStyleDetailArea');
    area.select();
    document.execCommand('copy');
    showToast("📋 클립보드에 복사되었습니다.");
}

async function saveAllArtStyleChanges() {
    const btn = document.getElementById('bulkSaveArtBtn');
    const rows = document.querySelectorAll('.art-row');
    const updateData = [];

    rows.forEach(row => {
        // 🌟 [수정] 구조 변경에 맞게 제목 텍스트 추출 방식 변경
        const enName = row.querySelector('td div div').getAttribute('title');
        const krName = row.querySelector('.art-kr-input').value.trim();
        updateData.push({ artist_name: enName, name_kr: krName });
    });

    btn.innerText = "⏳ 서버에 기록 중...";
    btn.disabled = true;

    try {
        const res = await fetch('/api/bulk_update_art_styles', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(updateData)
        });
        const result = await res.json();
        if (result.status === 'success') {
            btn.innerText = "✅ 저장 완료!";
            btn.style.background = "#fff";
            setTimeout(() => {
                btn.innerText = "🚀 일괄 저장";
                btn.style.background = "#39ff14";
                btn.disabled = false;
            }, 2000);
        }
    } catch(e) {
        alert("일괄 저장에 실패했습니다!");
        btn.disabled = false;
    }
}
