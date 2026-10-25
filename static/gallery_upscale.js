/* ==========================================================
   갤러리 업스케일
   - 우클릭 메뉴에 업스케일 버튼 추가
   - 목표 해상도 기반 업스케일
   - 서버 백그라운드 작업 큐 진행상황 표시
========================================================== */

let galleryUpscaleModelPanel = null;
if (window.UpscaleModelPanel?.create) {
    galleryUpscaleModelPanel = window.UpscaleModelPanel.create({
        prefix: 'galleryUpscale',
        layerId: 'galleryUpscaleLayer',
        engineSelectId: 'galleryUpscaleEngine',
        resolutionSectionId: 'galleryUpscaleResolutionSection',
        qualitySectionId: 'galleryUpscaleQualitySection',
        startButtonId: 'galleryUpscaleStart',
        getTargetDimensions: getGalleryUpscaleInputSize,
        getQuality: getSelectedGalleryUpscaleQuality,
        sourceDimensions: () => ({
            width: galleryUpscaleSession?.imageWidth || 0,
            height: galleryUpscaleSession?.imageHeight || 0
        }),
        sourceIdentity: () => galleryUpscaleSession
            ? `${galleryUpscaleSession.originalPath}\u0000${galleryUpscaleSession.originalSrc}`
            : ''
    });
}

window.addEventListener('load', () => {
    ensureGalleryUpscaleContextButton();
    pollGalleryUpscaleJobsOnce();
});

function ensureGalleryUpscaleContextButton() {
    const menu = document.getElementById('imageContextMenu');
    if (!menu || menu.dataset.upscaleButtonReady === '1') return;

    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'galleryContextUpscale';
    button.className = 'image-context-item';
    button.innerText = '업스케일';
    button.onclick = openGalleryUpscaleFromContext;

    const inpaintButton = document.getElementById('galleryContextInpaint');

    if (inpaintButton && inpaintButton.parentNode === menu) {
        inpaintButton.insertAdjacentElement('afterend', button);
    } else {
        menu.appendChild(button);
    }

    menu.dataset.upscaleButtonReady = '1';
}

function getSelectedGalleryUpscaleQuality() {
    return document.querySelector('input[name="galleryUpscaleQuality"]:checked')?.value || 'standard';
}

function getGalleryUpscaleInputSize() {
    const width = Math.max(64, Math.min(20000, parseInt(document.getElementById('galleryUpscaleWidthInput')?.value, 10) || 2500));
    const height = Math.max(64, Math.min(20000, parseInt(document.getElementById('galleryUpscaleHeightInput')?.value, 10) || 8000));

    return { width, height };
}

function applyGalleryUpscaleMultiplierPreset(multiplier) {
    if (!galleryUpscaleSession) return;
    applyGalleryUpscalePreset(
        Math.round(galleryUpscaleSession.imageWidth * multiplier),
        Math.round(galleryUpscaleSession.imageHeight * multiplier)
    );
}

function applyGalleryUpscalePreset(width, height) {
    const widthInput = document.getElementById('galleryUpscaleWidthInput');
    const heightInput = document.getElementById('galleryUpscaleHeightInput');

    if (widthInput) widthInput.value = width;
    if (heightInput) heightInput.value = height;

    galleryUpscaleLastEditedAxis = 'width';
    updateGalleryUpscaleRatioInfo();
}

function handleGalleryUpscaleWidthInput() {
    galleryUpscaleLastEditedAxis = 'width';

    if (document.getElementById('galleryUpscaleRatioLock')?.checked && galleryUpscaleSession?.imageWidth && galleryUpscaleSession?.imageHeight) {
        const width = parseInt(document.getElementById('galleryUpscaleWidthInput')?.value, 10) || 2500;
        const ratio = galleryUpscaleSession.imageHeight / Math.max(1, galleryUpscaleSession.imageWidth);
        document.getElementById('galleryUpscaleHeightInput').value = Math.round(width * ratio);
    }

    updateGalleryUpscaleRatioInfo();
}

function handleGalleryUpscaleHeightInput() {
    galleryUpscaleLastEditedAxis = 'height';

    if (document.getElementById('galleryUpscaleRatioLock')?.checked && galleryUpscaleSession?.imageWidth && galleryUpscaleSession?.imageHeight) {
        const height = parseInt(document.getElementById('galleryUpscaleHeightInput')?.value, 10) || 8000;
        const ratio = galleryUpscaleSession.imageWidth / Math.max(1, galleryUpscaleSession.imageHeight);
        document.getElementById('galleryUpscaleWidthInput').value = Math.round(height * ratio);
    }

    updateGalleryUpscaleRatioInfo();
}

function updateGalleryUpscaleRatioInfo() {
    const fit = Boolean(document.getElementById('galleryUpscaleFit516')?.checked);
    const info = document.getElementById('galleryUpscaleRatioInfo');
    if (!info) return;

    const size = getGalleryUpscaleInputSize();
    const mp = (size.width * size.height / 1000000).toFixed(1);
    if (fit) {
        const unit = Math.floor(Math.min(size.width / 5, size.height / 16));
        info.innerText = `${size.width} × ${size.height}px로 확대 → 중앙 자르기 ${unit * 5} × ${unit * 16}px (5:16)`;
        return;
    }

    if (!galleryUpscaleSession?.imageWidth || !galleryUpscaleSession?.imageHeight) {
        info.innerText = `목표 해상도 ${size.width} × ${size.height}px · 약 ${mp}MP`;
        return;
    }

    const sx = size.width / Math.max(1, galleryUpscaleSession.imageWidth);
    const sy = size.height / Math.max(1, galleryUpscaleSession.imageHeight);

    info.innerText = `목표 해상도 ${size.width} × ${size.height}px · 약 ${mp}MP · 원본 대비 ${sx.toFixed(2)}x / ${sy.toFixed(2)}x`;
}

let galleryUpscaleContextOpenRequest = 0;

async function openGalleryUpscaleFromContext() {
    const openRequest = ++galleryUpscaleContextOpenRequest;
    const contextSource = activeImageContext;
    const context = contextSource ? {
        ...contextSource,
        projectContext: contextSource.projectContext ? {...contextSource.projectContext} : null
    } : null;
    if (!context?.projectContext && /^__daki_(shared|tests|personal|drafts)__\//.test(context?.path || '')) return sendContextImageToCanvas();
    closeImageContextMenu();

    if (!context || !context.imgSrc || !context.path) {
        alert('업스케일할 이미지 경로가 없습니다.');
        return;
    }

    try {
        const img = await loadImageElement(context.imgSrc);
        if (openRequest !== galleryUpscaleContextOpenRequest || activeImageContext !== contextSource) return;

        galleryUpscaleSession = {
            originalPath: context.path || '',
            originalSrc: context.imgSrc || '',
            projectContext: context.projectContext,
            name: getImageFileName(context.path || context.imgSrc),
            imageWidth: img.naturalWidth || img.width || 0,
            imageHeight: img.naturalHeight || img.height || 0
        };

        const meta = document.getElementById('galleryUpscaleMeta');
        if (meta) {
            meta.innerText = `${galleryUpscaleSession.name} · 원본 ${galleryUpscaleSession.imageWidth} × ${galleryUpscaleSession.imageHeight}px`;
        }

        applyGalleryUpscaleMultiplierPreset(2);

        const layer = document.getElementById('galleryUpscaleLayer');
        if (layer) layer.style.display = 'flex';
        galleryUpscaleModelPanel?.open();

    } catch (error) {
        if (openRequest === galleryUpscaleContextOpenRequest && activeImageContext === contextSource) {
            alert(`업스케일 창 열기 실패: ${error.message || error}`);
        }
    }
}

function closeGalleryUpscaleModal() {
    const layer = document.getElementById('galleryUpscaleLayer');
    if (layer) layer.style.display = 'none';
    galleryUpscaleModelPanel?.close();
}

async function startGalleryUpscale() {
    const session = galleryUpscaleSession;
    if (!session?.originalPath) {
        alert('업스케일할 이미지가 없습니다.');
        return;
    }
    if (session.startPending) return;

    session.startPending = true;
    try {
        let prepared = null;
        if (galleryUpscaleModelPanel) {
            prepared = await galleryUpscaleModelPanel.prepare();
            const layer = document.getElementById('galleryUpscaleLayer');
            if (!prepared || galleryUpscaleSession !== session || layer?.style.display !== 'flex') return;
        }

        const size = prepared
            ? {width: prepared.target_width, height: prepared.target_height}
            : getGalleryUpscaleInputSize();
        const engine = prepared?.engine || document.getElementById('galleryUpscaleEngine')?.value || 'realcugan';
        const quality = prepared?.quality || getSelectedGalleryUpscaleQuality();

        if (size.width * size.height > 130000000) {
            alert('목표 해상도가 너무 큽니다. 130MP 이하로 설정해 주세요.');
            return;
        }

        const payload = {
            source_path: session.originalPath,
            target_width: size.width,
            target_height: size.height,
            engine,
            quality
        };
        if (engine !== 'nai' && document.getElementById('galleryUpscaleFit516')?.checked) payload.fit_5_16 = true;
        if (session.projectContext) payload.projectContext = {...session.projectContext};
        if (prepared?.nai_confirmed) payload.nai_confirmed = true;

        const response = await fetch('/api/gallery/upscale/start', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (!response.ok || data.status !== 'started') {
            throw new Error(data.message || '업스케일 작업 시작 실패');
        }

        if (galleryUpscaleSession === session) {
            showToast('업스케일 작업을 시작했습니다. 다른 작업을 계속할 수 있습니다.');
            closeGalleryUpscaleModal();
            showGalleryUpscaleJobsPanel();
        }
        startGalleryUpscalePolling();

    } catch (error) {
        if (galleryUpscaleSession === session) alert(`업스케일 시작 실패: ${error.message || error}`);
    } finally {
        session.startPending = false;
    }
}

function showGalleryUpscaleJobsPanel() {
    const panel = document.getElementById('galleryUpscaleJobPanel');
    if (panel) panel.classList.add('show');
}

function hideGalleryUpscaleJobsPanel() {
    const panel = document.getElementById('galleryUpscaleJobPanel');
    if (panel) panel.classList.remove('show');
}

function startGalleryUpscalePolling() {
    if (galleryUpscalePollTimer) return;

    pollGalleryUpscaleJobsOnce();

    galleryUpscalePollTimer = setInterval(() => {
        pollGalleryUpscaleJobsOnce();
    }, 1600);
}

function isGalleryUpscaleActiveJob(job) {
    return job && ['queued', 'running'].includes(job.status);
}

function isGalleryUpscaleTerminalJob(job) {
    return job && ['done', 'error', 'cancelled'].includes(job.status);
}

function stopGalleryUpscalePollingIfIdle(jobs) {
    const hasActive = jobs.some(job => ['queued', 'running'].includes(job.status));

    if (!hasActive && galleryUpscalePollTimer) {
        clearInterval(galleryUpscalePollTimer);
        galleryUpscalePollTimer = null;
    }
}

async function pollGalleryUpscaleJobsOnce() {
    try {
        const response = await fetch('/api/gallery/upscale/jobs');
        const data = await response.json();

        if (!response.ok || data.status !== 'success') {
            throw new Error(data.message || '업스케일 작업 목록을 읽지 못했습니다.');
        }

        const jobs = Array.isArray(data.jobs) ? data.jobs : [];
        const hasActiveJobs = jobs.some(isGalleryUpscaleActiveJob);
        const isFirstPoll = !galleryUpscalePollingInitialized;

        // 갤러리에 다시 들어왔을 때 이미 끝나 있던 작업은
        // 새 완료 알림/자동 갱신/패널 자동 표시 대상으로 보지 않는다.
        if (isFirstPoll) {
            jobs.forEach((job) => {
                if (job.status === 'done') {
                    galleryUpscaleKnownDoneJobs.add(job.id);
                }

                if (isGalleryUpscaleTerminalJob(job)) {
                    galleryUpscaleKnownTerminalJobs.add(job.id);
                }
            });

            galleryUpscalePollingInitialized = true;
        }

        renderGalleryUpscaleJobs(jobs);

        if (!isFirstPoll) {
            for (const job of jobs) {
                const isDone = job.status === 'done';
                const isTerminal = isGalleryUpscaleTerminalJob(job);

                if (isDone && !galleryUpscaleKnownDoneJobs.has(job.id)) {
                    galleryUpscaleKnownDoneJobs.add(job.id);
                    const projectId = job.projectId || job.projectContext?.projectId;
                    if (job.destination === 'project' && projectId) {
                        const projectName = job.projectName || projectId;
                        const side = job.side || job.projectContext?.side;
                        const sideLabel = side === 'back' ? '뒷면' : '앞면';
                        showToast(`${projectName} · ${sideLabel} 후보에 업스케일 결과를 추가했습니다.`);
                        await window.Daki?.refreshProject?.(projectId);
                    } else {
                        showToast('업스케일이 완료되었습니다.');
                        await loadData();
                    }
                }

                if (isTerminal) {
                    galleryUpscaleKnownTerminalJobs.add(job.id);
                }
            }
        }

        // 자동으로 패널을 여는 건 진행 중인 작업이 있을 때만.
        // 완료/실패/취소만 남아 있으면 갤러리 재진입 시 패널을 띄우지 않는다.
        if (hasActiveJobs) {
            showGalleryUpscaleJobsPanel();
            startGalleryUpscalePolling();
        }

        stopGalleryUpscalePollingIfIdle(jobs);

    } catch (error) {
        console.warn('Upscale job polling failed:', error);
    }
}


function renderGalleryUpscaleJobs(jobs) {
    const list = document.getElementById('galleryUpscaleJobList');
    if (!list) return;

    if (!jobs.length) {
        list.innerHTML = '<div class="gallery-upscale-job-empty">업스케일 작업이 없습니다.</div>';
        return;
    }

    const activeJobs = jobs.filter(isGalleryUpscaleActiveJob);
    const freshTerminalJobs = jobs.filter((job) => {
        return isGalleryUpscaleTerminalJob(job) && !galleryUpscaleKnownTerminalJobs.has(job.id);
    });

    const visibleJobs = [...activeJobs, ...freshTerminalJobs].slice(0, 8);

    if (!visibleJobs.length) {
        list.innerHTML = '<div class="gallery-upscale-job-empty">진행 중인 업스케일 작업이 없습니다.</div>';
        return;
    }

    list.innerHTML = visibleJobs.map((job) => {
        const progress = Math.max(0, Math.min(100, Number(job.progress || 0)));
        const statusLabel = getGalleryUpscaleStatusLabel(job.status);
        const canCancel = ['queued', 'running'].includes(job.status);

        return `
            <div class="gallery-upscale-job-item">
                <div class="gallery-upscale-job-title">
                    <span>${escapeHtml(job.source_name || getImageFileName(job.source_path || 'image.png'))}</span>
                    <strong>${escapeHtml(statusLabel)}</strong>
                </div>

                <div class="gallery-upscale-job-meta">
                    ${escapeHtml(String(job.target_width || '?'))} × ${escapeHtml(String(job.target_height || '?'))}
                    · ${escapeHtml(getGalleryUpscaleQualityLabel(job.quality))}
                </div>

                <div class="gallery-upscale-progress">
                    <div class="gallery-upscale-progress-bar" style="width:${progress}%"></div>
                </div>

                <div class="gallery-upscale-job-message">
                    ${escapeHtml(job.error || job.message || '')}
                </div>

                <div class="gallery-upscale-job-actions">
                    ${
                        job.result_src
                            ? `<button onclick="openZoom('${escapeHtml(job.result_src)}')">보기</button>`
                            : ''
                    }
                    ${
                        canCancel
                            ? `<button onclick="cancelGalleryUpscaleJob('${escapeHtml(job.id)}')">취소</button>`
                            : ''
                    }
                </div>
            </div>
        `;
    }).join('');
}

function getGalleryUpscaleStatusLabel(status) {
    if (status === 'queued') return '대기';
    if (status === 'running') return '처리 중';
    if (status === 'done') return '완료';
    if (status === 'error') return '실패';
    if (status === 'cancelled') return '취소됨';
    return status || '';
}

function getGalleryUpscaleQualityLabel(quality) {
    if (quality === 'fast') return '빠른 처리';
    if (quality === 'high') return '최종본 고품질';
    return '균형 처리';
}

async function cancelGalleryUpscaleJob(jobId) {
    try {
        const response = await fetch(`/api/gallery/upscale/cancel/${encodeURIComponent(jobId)}`, {
            method: 'POST'
        });

        const data = await response.json();

        if (!response.ok || data.status !== 'success') {
            throw new Error(data.message || '취소 실패');
        }

        showToast('업스케일 취소를 요청했습니다.');
        await pollGalleryUpscaleJobsOnce();

    } catch (error) {
        alert(`업스케일 취소 실패: ${error.message || error}`);
    }
}
