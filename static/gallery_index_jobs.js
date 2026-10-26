/* Index dialogs and background progress. Gallery contents stay usable while rebuilding. */
let galleryIndexStatusTimer = null;
let galleryIndexStatusRequest = 0;
let galleryIndexJobSnapshot = null;
let galleryIndexBuildStarting = false;
const galleryIndexActivities = {gallery: null, prompt: null};

function showGalleryIndexDialog(layer) {
    if (!layer) return;
    if (layer.style.display !== 'flex') layer.galleryReturnFocus = document.activeElement;
    layer.style.display = 'flex';
    layer.setAttribute('aria-hidden', 'false');
    layer.querySelector('[role="dialog"]')?.focus();
    layer.onkeydown = event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            hideGalleryIndexDialog(layer);
        } else if (event.key === 'Tab') {
            const buttons = [...layer.querySelectorAll('button:not(:disabled)')].filter(button => !button.hidden);
            const first = buttons[0];
            const last = buttons[buttons.length - 1];
            if (event.shiftKey && (document.activeElement === first || document.activeElement === layer.querySelector('[role="dialog"]'))) {
                event.preventDefault();
                last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
            }
        }
    };
}

function hideGalleryIndexDialog(layer) {
    if (!layer) return;
    layer.style.display = 'none';
    layer.setAttribute('aria-hidden', 'true');
    layer.galleryReturnFocus?.focus();
}

function renderGalleryIndexMeter(job = {}, label = '인덱스 진행률') {
    const total = Math.max(0, Number(job.total || 0));
    const processed = Math.max(0, Number(job.processed || 0));
    const percent = total ? Math.min(100, Math.round(processed / total * 100)) : 0;
    return `
        <div class="gallery-index-progress-meta"><span>${total ? `${processed.toLocaleString()} / ${total.toLocaleString()}` : '대상 계산 중'}</span><b>${total ? `${percent}%` : '준비 중'}</b></div>
        <div class="gallery-index-meter" role="progressbar" aria-label="${escapeHtml(label)}" aria-valuemin="0" aria-valuemax="100" ${total ? `aria-valuenow="${percent}"` : ''}>
            <div class="gallery-index-progress-fill" style="width:${percent}%"></div>
        </div>`;
}

function renderGalleryIndexActivity(kind, job = {}) {
    const previous = galleryIndexActivities[kind];
    // Old completed jobs returned on page entry should not open a progress panel.
    if (!job.running && !previous) return;
    galleryIndexActivities[kind] = {...job};
    const box = document.getElementById(kind === 'gallery' ? 'galleryIndexJobBody' : 'galleryPromptIndexJobBody');
    const panel = document.getElementById('galleryIndexJobPanel');
    if (!box || !panel) return;
    const title = kind === 'gallery' ? '갤러리 목록 갱신' : '프롬프트 검색 인덱스';
    const state = job.error ? 'error' : job.running ? 'running' : 'done';
    box.hidden = false;
    panel.hidden = false;
    box.innerHTML = `
        <div class="gallery-index-job-title"><strong>${title}</strong><span class="gallery-index-status ${state}">${job.error ? '실패' : job.running ? '갱신 중' : '완료'}</span></div>
        <div class="gallery-index-job-message">${escapeHtml(job.error || job.message || '인덱스를 준비하고 있습니다.')}</div>
        ${job.running || job.total ? renderGalleryIndexMeter(job, `${title} 진행률`) : ''}
        <div class="gallery-index-job-actions">
            <button type="button" onclick="${kind === 'gallery' ? 'openGalleryIndexModal()' : 'openGalleryPromptIndexModal()'}">상세 보기</button>
            ${!job.running && !job.error && kind === 'gallery' ? '<button type="button" onclick="applyGalleryIndexUpdate()">갤러리에 반영</button>' : ''}
            ${!job.running ? `<button type="button" onclick="dismissGalleryIndexActivity('${kind}')">닫기</button>` : ''}
        </div>
    `;
}

function refreshGalleryJobPanelVisibility() {
    const panel = document.getElementById('galleryIndexJobPanel');
    if (panel) panel.hidden = !['galleryIndexJobBody', 'galleryPromptIndexJobBody', 'dakiStyleSyncJobBody'].some(id => {
        const body = document.getElementById(id);
        return body && !body.hidden;
    });
}

function dismissGalleryIndexActivity(kind) {
    galleryIndexActivities[kind] = null;
    const box = document.getElementById(kind === 'gallery' ? 'galleryIndexJobBody' : 'galleryPromptIndexJobBody');
    if (box) box.hidden = true;
    refreshGalleryJobPanelVisibility();
}

async function applyGalleryIndexUpdate() {
    closeGalleryIndexModal();
    dismissGalleryIndexActivity('gallery');
    await loadData();
}

function renderGalleryIndexProgress(job = {}) {
    galleryIndexJobSnapshot = job;
    renderGalleryIndexActivity('gallery', job);
    // Only the initial-index placeholder is updated; never replace the gallery.
    const initialProgress = document.getElementById('galleryIndexProgress');
    if (initialProgress) initialProgress.innerHTML = `<div class="gallery-index-job-message">${escapeHtml(job.error || job.message || '인덱스 준비 중')}</div>${renderGalleryIndexMeter(job)}`;

    const body = document.getElementById('galleryIndexModalBody');
    const state = job.error ? 'error' : job.running ? 'running' : job.done ? 'done' : '';
    if (body) body.innerHTML = `
        <div class="gallery-index-summary"><strong>갤러리를 계속 둘러보세요</strong><span class="gallery-index-status ${state}">${job.error ? '갱신 실패' : job.running ? '백그라운드 갱신 중' : job.done ? '갱신 완료' : '갱신 준비'}</span></div>
        <div class="gallery-index-stats">
            <div class="gallery-index-stat"><span>처리한 이미지</span><strong>${Number(job.processed || 0).toLocaleString()}<small>장</small></strong></div>
            <div class="gallery-index-stat"><span>이번 작업 대상</span><strong>${job.total ? `${Number(job.total).toLocaleString()}<small>장</small>` : '—'}</strong></div>
        </div>
        ${job.running || job.total ? renderGalleryIndexMeter(job) : ''}
        <p class="gallery-index-job-message${job.error ? ' error' : ''}" role="status">${escapeHtml(job.error || job.message || '현재 이미지와 폴더 목록을 다시 확인합니다.')}</p>
        <div class="gallery-index-detail-list">
            <div class="gallery-index-detail-row"><span>대상 범위</span><b>TOTAL_CLASSIFIED 전체</b></div>
            <div class="gallery-index-detail-row"><span>갱신 중 탐색</span><b>기존 인덱스로 계속 이용</b></div>
        </div>
        <p class="gallery-index-note">이 창을 닫아도 작업은 계속되며 화면 한쪽에서 진행률을 확인할 수 있습니다. 완료 후 ‘갤러리에 반영’을 누르면 새 목록을 불러옵니다.</p>`;
    const button = document.getElementById('galleryIndexBuildBtn');
    if (button) {
        button.disabled = Boolean(job.running || galleryIndexBuildStarting);
        button.textContent = job.running ? '갱신 진행 중' : '갤러리 목록 갱신 시작';
    }
}

function openGalleryIndexModal() {
    const layer = document.getElementById('galleryIndexModal');
    showGalleryIndexDialog(layer);
    renderGalleryIndexProgress(galleryIndexJobSnapshot || {});
    pollGalleryIndexStatus();
}

function closeGalleryIndexModal() {
    const layer = document.getElementById('galleryIndexModal');
    hideGalleryIndexDialog(layer);
}

async function startGalleryIndexRebuild() {
    if (galleryIndexBuildStarting || galleryIndexJobSnapshot?.running) return;
    galleryIndexBuildStarting = true;
    renderGalleryIndexProgress(galleryIndexJobSnapshot || {});
    try {
        const res = await fetch('/api/gallery/index/rebuild', {method: 'POST'});
        const json = await res.json();
        if (!res.ok || json.status === 'error') throw new Error(json.message || json.error || '인덱스 생성 시작 실패');
        // Record the start even if a very small rebuild has already finished.
        galleryIndexActivities.gallery = {running: true};
        renderGalleryIndexProgress(json);
        closeGalleryIndexModal();
        await pollGalleryIndexStatus();
    } catch (error) {
        showToast(`갤러리 목록 갱신 실패: ${error.message || error}`);
    } finally {
        galleryIndexBuildStarting = false;
        renderGalleryIndexProgress(galleryIndexJobSnapshot || {});
    }
}

async function pollGalleryIndexStatus() {
    const requestId = ++galleryIndexStatusRequest;
    if (galleryIndexStatusTimer) clearTimeout(galleryIndexStatusTimer);
    galleryIndexStatusTimer = null;
    try {
        const res = await fetch('/api/gallery/index/status', {cache: 'no-store'});
        const json = await res.json();
        if (requestId !== galleryIndexStatusRequest) return;
        if (!res.ok || json.status === 'error') throw new Error(json.message || json.error || '인덱스 상태 조회 실패');
        renderGalleryIndexProgress(json);
        if (json.running && !json.error) {
            galleryIndexStatusTimer = setTimeout(pollGalleryIndexStatus, 1000);
        } else if (!json.error && (json.full_index_built || json.done) && document.getElementById('galleryIndexProgress')) {
            // First-time creation has no gallery to preserve. Load it when ready.
            dismissGalleryIndexActivity('gallery');
            await loadData();
        } else if (!json.error && document.getElementById('galleryIndexProgress')) {
            // The initial-index page can be idle while its automatic rebuild starts.
            galleryIndexStatusTimer = setTimeout(pollGalleryIndexStatus, 1000);
        }
    } catch (error) {
        if (requestId !== galleryIndexStatusRequest) return;
        const initialProgress = document.getElementById('galleryIndexProgress');
        if (!galleryIndexJobSnapshot?.error && (initialProgress || galleryIndexJobSnapshot?.running)) {
            const message = '진행 상태 연결을 다시 확인하고 있습니다.';
            if (initialProgress) initialProgress.innerHTML = `<div class="gallery-index-job-message">${escapeHtml(message)}</div>${renderGalleryIndexMeter(galleryIndexJobSnapshot || {})}`;
            if (galleryIndexJobSnapshot?.running) {
                renderGalleryIndexActivity('gallery', {...galleryIndexJobSnapshot, message});
            }
            galleryIndexStatusTimer = setTimeout(pollGalleryIndexStatus, 2000);
        }
        console.warn('Gallery index status refresh failed:', error);
    }
}
