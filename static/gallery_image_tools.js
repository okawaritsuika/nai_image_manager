(function (root) {
    'use strict';

    const FORMAT_STORAGE_KEY = 'naim_show_image_formats_v1';
    const KNOWN_FORMATS = new Set(['PNG', 'JPEG', 'WEBP', 'BMP', 'GIF']);
    const MAX_FORMAT_BATCH = 200;
    const MAX_WEBP_PATHS = 10000;

    function normalizeFormat(value) {
        const format = String(value || '').trim().toUpperCase();
        return KNOWN_FORMATS.has(format) ? format : 'UNKNOWN';
    }

    function uniquePaths(paths) {
        const result = [];
        const seen = new Set();
        for (const value of Array.isArray(paths) ? paths : []) {
            const path = String(value || '').trim();
            if (!path || seen.has(path)) continue;
            seen.add(path);
            result.push(path);
        }
        return result;
    }

    function collectCurrentFolderPaths(doc, dakiActive) {
        const scope = doc?.getElementById(dakiActive ? 'dakiContent' : 'content');
        if (!scope) return [];
        const paths = [];
        const grids = scope.querySelectorAll?.('.flex-masonry') || [];
        let hasGalleryImageList = false;
        for (const grid of grids) {
            if (Array.isArray(grid.galleryZoomImages)) {
                hasGalleryImageList = true;
                grid.galleryZoomImages.forEach(image => paths.push(image?.path));
            }
        }
        if (!hasGalleryImageList) {
            scope.querySelectorAll?.('.item-box[data-path]').forEach(card => paths.push(card.dataset?.path));
        }
        return uniquePaths(paths);
    }

    function createGalleryImageTools(host = root) {
        const doc = host.document;
        let enabled = true;
        try {
            enabled = host.localStorage?.getItem(FORMAT_STORAGE_KEY) !== 'false';
        } catch (_) {
            enabled = true;
        }

        const formatCache = new Map();
        const formatTitles = new Map();
        const cardsByPath = new Map();
        const cardRecords = new WeakMap();
        const allCards = new Set();
        const queuedPaths = new Set();
        const inFlightPaths = new Map();
        let formatObserver = null;
        let formatAbort = null;
        let formatQueueScheduled = false;
        let formatRequestActive = false;
        let formatRevision = 0;
        let formatRequestId = 0;
        let dialog = null;
        let jobNotice = null;
        let selectedPaths = [];
        let baseSelectedPaths = [];
        let allowTagExclusions = false;
        let excludedTagIds = new Set();
        let excludeAllTagged = false;
        let conversionFinishedForSelection = false;
        let selectedLocation = {kind: '현재 폴더', name: '갤러리 홈', path: '갤러리 홈', breadcrumb: '갤러리 홈'};
        let job = null;
        let jobPaths = [];
        let jobRequestRevision = 0;
        let jobStatusAbort = null;
        let pollTimer = null;
        let pollAbort = null;
        let pollRevision = 0;
        let pageActive = true;
        let startPending = false;
        let keepOriginal = true;
        let progressView = false;
        let selectedProjectContext = null;
        let jobTargetPath = '';
        let startRequestError = '';
        let pendingTotal = 0;
        let pendingKeepOriginal = true;
        const dismissedJobIds = new Set();
        const refreshedJobs = new Set();

        function weakReference(value) {
            return typeof WeakRef === 'function' ? new WeakRef(value) : {deref: () => value};
        }

        function liveCards(path) {
            const references = cardsByPath.get(path);
            if (!references) return [];
            const result = [];
            for (const reference of [...references]) {
                const card = reference.deref();
                if (!card || card.isConnected === false) {
                    references.delete(reference);
                    continue;
                }
                result.push(card);
            }
            if (!references.size) cardsByPath.delete(path);
            return result;
        }

        function rememberCard(card, path) {
            let references = cardsByPath.get(path);
            if (!references) cardsByPath.set(path, references = new Set());
            references.add(weakReference(card));
            allCards.add(weakReference(card));
        }

        function displayFormat(format) {
            if (format === 'JPEG') return 'JPG';
            if (format === 'UNKNOWN') return '?';
            return format;
        }

        function updateCard(card, path) {
            const record = cardRecords.get(card);
            if (!record || record.path !== path || !record.badge) return;
            const format = formatCache.get(path);
            record.badge.textContent = format ? displayFormat(format) : '?';
            record.badge.title = formatTitles.get(path) || (format && format !== 'UNKNOWN' ? `실제 파일 형식: ${format}` : format === 'UNKNOWN' ? '형식 확인 불가' : '형식 확인 대기 중');
            card.classList?.toggle('gallery-image-format-visible', enabled);
        }

        function updatePath(path) {
            liveCards(path).forEach(card => updateCard(card, path));
        }

        function observeCard(card, path) {
            if (!enabled || !card || formatCache.has(path)) return;
            if (formatObserver) {
                formatObserver.observe(card);
                return;
            }
            enqueuePath(path);
        }

        function installFormatObserver() {
            if (formatObserver || typeof host.IntersectionObserver !== 'function') return;
            formatObserver = new host.IntersectionObserver(entries => {
                for (const entry of entries) {
                    const card = entry.target;
                    const record = cardRecords.get(card);
                    if (!record) {
                        formatObserver?.unobserve(card);
                        continue;
                    }
                    if (card.isConnected === false) {
                        formatObserver?.unobserve(card);
                    } else if (entry.isIntersecting) {
                        formatObserver?.unobserve(card);
                        enqueuePath(record.path);
                    }
                }
            }, {rootMargin: '320px'});
        }

        function scheduleFormatQueue() {
            if (formatQueueScheduled || formatRequestActive || !enabled) return;
            formatQueueScheduled = true;
            Promise.resolve().then(() => {
                formatQueueScheduled = false;
                return flushFormatQueue();
            });
        }

        function enqueuePath(path) {
            if (!enabled || !path || formatCache.has(path) || inFlightPaths.has(path)) return;
            queuedPaths.add(path);
            scheduleFormatQueue();
        }

        async function flushFormatQueue() {
            if (!enabled || formatRequestActive || !queuedPaths.size) return;
            const paths = [...queuedPaths].slice(0, MAX_FORMAT_BATCH);
            paths.forEach(path => queuedPaths.delete(path));
            const requestId = ++formatRequestId;
            paths.forEach(path => inFlightPaths.set(path, requestId));
            const revision = formatRevision;
            const controller = typeof host.AbortController === 'function' ? new host.AbortController() : null;
            formatAbort = controller;
            formatRequestActive = true;
            try {
                const response = await host.fetch('/api/gallery/image-formats', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({paths}),
                    ...(controller ? {signal: controller.signal} : {})
                });
                const payload = await response.json();
                if (revision !== formatRevision || !enabled) return;
                if (!response.ok || payload?.status !== 'success' || !payload.formats || typeof payload.formats !== 'object') {
                    throw new Error(payload?.message || '이미지 형식을 확인하지 못했습니다.');
                }
                for (const path of paths) {
                    const format = normalizeFormat(payload.formats[path]);
                    formatCache.set(path, format);
                    formatTitles.delete(path);
                    updatePath(path);
                }
            } catch (error) {
                if (revision !== formatRevision || error?.name === 'AbortError') return;
                for (const path of paths) {
                    formatCache.set(path, 'UNKNOWN');
                    formatTitles.set(path, '형식 확인 불가');
                    updatePath(path);
                }
            } finally {
                if (formatAbort === controller) formatAbort = null;
                paths.forEach(path => {
                    if (inFlightPaths.get(path) === requestId) inFlightPaths.delete(path);
                });
                if (formatRequestId === requestId) {
                    formatRequestActive = false;
                    if (enabled && queuedPaths.size) scheduleFormatQueue();
                }
            }
        }

        function applyEnabledToCards() {
            for (const reference of [...allCards]) {
                const card = reference.deref();
                if (!card || card.isConnected === false) {
                    allCards.delete(reference);
                    continue;
                }
                const record = cardRecords.get(card);
                if (!record) continue;
                updateCard(card, record.path);
                if (enabled && !formatCache.has(record.path)) observeCard(card, record.path);
            }
        }

        function setEnabled(value) {
            const nextEnabled = Boolean(value);
            if (enabled === nextEnabled) return;
            enabled = nextEnabled;
            if (enabled) {
                installFormatObserver();
            } else {
                formatRevision++;
                formatRequestId++;
                formatObserver?.disconnect();
                formatObserver = null;
                formatAbort?.abort();
                formatAbort = null;
                formatRequestActive = false;
                queuedPaths.clear();
                inFlightPaths.clear();
                formatQueueScheduled = false;
            }
            try {
                host.localStorage?.setItem(FORMAT_STORAGE_KEY, String(enabled));
            } catch (_) {
                // The control remains usable for this page when storage is unavailable.
            }
            applyEnabledToCards();
        }

        function ensureFormatControl() {
            const checkbox = doc?.getElementById('toggle-image-formats');
            if (checkbox) {
                checkbox.checked = enabled;
                checkbox.addEventListener('change', () => setEnabled(checkbox.checked));
            }
            const folderButton = doc?.getElementById('galleryWebpCurrentFolder');
            folderButton?.addEventListener('click', () => openCurrentFolder());
        }

        function badgeFor(card) {
            let badge = card.querySelector?.('.gallery-image-format-badge');
            if (!badge && doc?.createElement) {
                badge = doc.createElement('span');
                badge.className = 'gallery-image-format-badge';
                badge.setAttribute('aria-label', '실제 이미지 파일 형식');
                card.appendChild(badge);
            }
            return badge || null;
        }

        function makeElement(tag, className = '', text = '') {
            const element = doc.createElement(tag);
            if (className) element.className = className;
            if (text) element.textContent = text;
            return element;
        }

        function decorate(card, path) {
            path = String(path || card?.dataset?.path || '').trim();
            if (!card || !path || !card.classList || !doc) return;
            card.classList.toggle('gallery-image-format-below-upscale', Boolean(card.querySelector?.('.gallery-upscale-badge')));
            const previous = cardRecords.get(card);
            if (previous?.path === path && previous.badge) {
                updateCard(card, path);
                if (enabled && !formatCache.has(path)) observeCard(card, path);
                return;
            }
            if (previous?.path && previous.path !== path) {
                const oldReferences = cardsByPath.get(previous.path);
                oldReferences?.forEach(reference => {
                    if (reference.deref() === card) oldReferences.delete(reference);
                });
                if (!oldReferences?.size) cardsByPath.delete(previous.path);
            }
            previous?.badge?.remove?.();
            const badge = badgeFor(card);
            if (!badge) return;
            const record = {path, badge};
            cardRecords.set(card, record);
            rememberCard(card, path);
            updateCard(card, path);
            if (enabled && formatCache.has(path)) updatePath(path);
            else if (enabled) observeCard(card, path);
        }

        function isDakiActive() {
            try { return Boolean(host.Daki?.isActive?.()); }
            catch (_) { return false; }
        }

        function collectPaths() {
            return collectCurrentFolderPaths(doc, isDakiActive());
        }

        function currentLocation() {
            if (isDakiActive()) {
                const name = String(doc?.getElementById('dakiTitle')?.textContent || '').trim() || 'Daki';
                const path = `Daki / ${name}`;
                return {kind: 'Daki 현재 보기', name, path, breadcrumb: path};
            }
            let value = null;
            try { value = host.getGalleryWebpLocation?.(); }
            catch (_) { value = null; }
            const fallback = String(doc?.getElementById('breadcrumb-path')?.textContent || '').trim() || '갤러리 홈';
            const path = String(value?.path || '').trim() || String(value?.breadcrumb || '').trim() || fallback;
            const breadcrumb = String(value?.breadcrumb || '').trim();
            return {
                kind: String(value?.kind || '').trim() || '현재 폴더',
                name: String(value?.name || '').trim() || path.split(/[\\/]/).filter(Boolean).at(-1) || fallback,
                path,
                breadcrumb,
            };
        }

        function selectedImageLocation(path) {
            const value = String(path || '');
            return {
                kind: '선택한 그림',
                name: value.split(/[\\/]/).filter(Boolean).at(-1) || value,
                path: value,
                breadcrumb: '',
            };
        }

        function updateLocationCard() {
            const kind = query('.gallery-image-tools-location-kind');
            const name = query('.gallery-image-tools-location-name');
            const breadcrumb = query('.gallery-image-tools-location-breadcrumb');
            const path = query('.gallery-image-tools-location-path');
            if (kind) kind.textContent = selectedLocation.kind;
            if (name) {
                name.textContent = selectedLocation.name;
                name.title = selectedLocation.name;
            }
            if (path) {
                path.textContent = selectedLocation.path;
                path.title = selectedLocation.path;
            }
            if (breadcrumb) {
                const showBreadcrumb = Boolean(selectedLocation.breadcrumb && selectedLocation.breadcrumb !== selectedLocation.path);
                breadcrumb.hidden = !showBreadcrumb;
                breadcrumb.textContent = showBreadcrumb ? selectedLocation.breadcrumb : '';
                breadcrumb.title = showBreadcrumb ? selectedLocation.breadcrumb : '';
            }
        }

        function isDialogOpen() {
            return Boolean(dialog && (dialog.open || dialog.hasAttribute?.('open')));
        }

        function makeDialog() {
            if (dialog || !doc?.createElement || !doc.body) return dialog;
            dialog = doc.createElement('dialog');
            dialog.id = 'galleryImageToolsDialog';
            dialog.className = 'daki-dialog gallery-image-tools-dialog';
            dialog.setAttribute('aria-labelledby', 'galleryImageToolsTitle');
            const header = makeElement('header', 'gallery-image-tools-header');
            const heading = makeElement('div', 'gallery-image-tools-heading');
            const title = makeElement('h2', '', 'WebP로 변환');
            title.id = 'galleryImageToolsTitle';
            const subtitle = makeElement('p', 'gallery-image-tools-subtitle', '이미지를 더 작은 WebP 파일로 저장합니다.');
            heading.append(title, subtitle);
            const close = makeElement('button', 'gallery-image-tools-close', '×');
            close.type = 'button';
            close.setAttribute('aria-label', '닫기');
            header.append(heading, close);

            const body = makeElement('div', 'gallery-image-tools-body');
            const location = makeElement('section', 'gallery-image-tools-location');
            const locationKind = makeElement('span', 'gallery-image-tools-location-kind');
            const locationSummary = makeElement('div', 'gallery-image-tools-location-summary');
            const locationName = makeElement('strong', 'gallery-image-tools-location-name');
            const target = makeElement('span', 'gallery-image-tools-target');
            const breadcrumb = makeElement('p', 'gallery-image-tools-location-breadcrumb');
            const locationPath = makeElement('p', 'gallery-image-tools-location-path');
            locationSummary.append(locationName, target);
            location.append(locationKind, locationSummary, breadcrumb, locationPath);

            const quality = makeElement('div', 'gallery-image-tools-quality');
            const qualityCopy = makeElement('div', 'gallery-image-tools-quality-copy');
            const qualityLabel = makeElement('label', 'gallery-image-tools-quality-label', '품질');
            qualityLabel.htmlFor = 'galleryImageToolsQuality';
            const qualityHelp = makeElement('p', 'gallery-image-tools-quality-help', '90은 권장 품질입니다. 숫자가 높을수록 선명하고 용량이 커집니다.');
            qualityCopy.append(qualityLabel, qualityHelp);
            const qualityInput = makeElement('input');
            qualityInput.id = 'galleryImageToolsQuality';
            qualityInput.type = 'number'; qualityInput.min = '1'; qualityInput.max = '100';
            qualityInput.step = '1'; qualityInput.value = '90'; qualityInput.inputMode = 'numeric';
            const qualityField = makeElement('div', 'gallery-image-tools-quality-field');
            qualityField.append(qualityInput, makeElement('span', '', '/ 100'));
            quality.append(qualityCopy, qualityField);
            const tagExclusion = makeElement('section', 'gallery-image-tools-tag-exclusion');
            tagExclusion.hidden = true;
            const tagTitle = makeElement('h3', 'gallery-image-tools-tag-title', '태그 제외');
            const tagHelp = makeElement('p', 'gallery-image-tools-tag-help', '갤러리에 직접 붙인 태그가 있는 그림을 변환 대상에서 뺍니다.');
            const allTaggedLabel = makeElement('label', 'gallery-image-tools-exclude-all-row');
            const allTaggedInput = makeElement('input', 'gallery-image-tools-exclude-all-tagged');
            allTaggedInput.type = 'checkbox';
            const allTaggedText = makeElement('span', '', '태그 있는 그림 모두 제외');
            allTaggedLabel.append(allTaggedInput, allTaggedText);
            const tagOptions = makeElement('div', 'gallery-image-tools-tag-options');
            const tagEmpty = makeElement('p', 'gallery-image-tools-tag-empty', '이 폴더에 태그가 붙은 그림이 없습니다.');
            tagEmpty.hidden = true;
            const tagSummary = makeElement('p', 'gallery-image-tools-tag-summary');
            tagSummary.setAttribute('aria-live', 'polite');
            tagExclusion.append(tagTitle, tagHelp, allTaggedLabel, tagOptions, tagEmpty, tagSummary);
            const storage = makeElement('fieldset', 'gallery-image-tools-storage');
            storage.appendChild(makeElement('legend', '', '어떻게 저장할까요?'));
            for (const [value, title, description] of [
                [true, '원본 유지 + WebP 추가', '원본과 기존 연결을 유지하고, 같은 폴더에 WebP를 추가합니다. 저장 공간이 더 필요합니다.'],
                [false, '원본을 WebP로 교체', '변환 결과를 검증한 뒤 원본을 삭제하고, 기존 연결을 WebP로 갱신합니다.']
            ]) {
                const card = makeElement('label', 'gallery-image-tools-storage-card');
                const input = makeElement('input', `gallery-image-tools-storage-${value ? 'add' : 'replace'}`);
                input.type = 'radio'; input.name = 'galleryWebpStorage'; input.value = String(value);
                input.checked = value === keepOriginal;
                const copy = makeElement('span', 'gallery-image-tools-storage-copy');
                copy.append(makeElement('strong', '', title), makeElement('span', '', description));
                card.append(input, copy);
                storage.appendChild(card);
                input.addEventListener('change', () => {
                    if (!input.checked || startPending || job?.status === 'running') return;
                    keepOriginal = value;
                    updateStartButton();
                });
            }
            const warning = makeElement('p', 'gallery-image-tools-warning', '메타데이터를 보존합니다. 이미 WebP인 그림과 같은 이름의 WebP가 있는 그림은 건너뜁니다.');
            const scope = makeElement('p', 'gallery-image-tools-scope');
            const jobSection = makeElement('section', 'gallery-image-tools-job');
            const jobTitle = makeElement('h3', 'gallery-image-tools-section-title', '실행 준비');
            const status = makeElement('p', 'gallery-image-tools-status');
            status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
            const progress = makeElement('progress', 'gallery-image-tools-progress');
            progress.max = 1; progress.value = 0; progress.setAttribute('aria-label', 'WebP 변환 진행');
            const progressText = makeElement('p', 'gallery-image-tools-progress-text');
            progressText.setAttribute('aria-live', 'polite');
            const jobTarget = makeElement('p', 'gallery-image-tools-job-target');
            const counters = makeElement('div', 'gallery-image-tools-counters');
            for (const [key, label] of [['converted', '변환'], ['skipped', '건너뜀'], ['failed', '실패']]) {
                const counter = makeElement('div', `gallery-image-tools-stat gallery-image-tools-stat-${key}`);
                counter.append(makeElement('strong', 'gallery-image-tools-stat-value', '0'), makeElement('span', 'gallery-image-tools-stat-label', label));
                counters.appendChild(counter);
            }
            const bytes = makeElement('p', 'gallery-image-tools-bytes');
            const details = makeElement('ol', 'gallery-image-tools-details');
            jobSection.append(jobTitle, jobTarget, status, progress, progressText, counters, bytes, details);
            body.append(location, storage, quality, tagExclusion, scope, warning, jobSection);

            const footer = makeElement('footer', 'gallery-image-tools-footer');
            const cancel = makeElement('button', 'gallery-image-tools-cancel', '중지');
            cancel.type = 'button';
            const back = makeElement('button', 'gallery-image-tools-back', '설정으로 돌아가기');
            back.type = 'button';
            back.hidden = true;
            const start = makeElement('button', 'gallery-image-tools-start daki-primary', 'WebP로 변환');
            start.type = 'button';
            footer.append(cancel, back, start);

            dialog.append(header, body, footer);
            doc.body.appendChild(dialog);
            close.addEventListener('click', closeDialog);
            start.addEventListener('click', startConversion);
            cancel.addEventListener('click', cancelConversion);
            back.addEventListener('click', () => {
                setProgressView(false);
                updateStartButton();
            });
            allTaggedInput.addEventListener('change', () => {
                excludeAllTagged = Boolean(allTaggedInput.checked);
                updateTagExclusions({renderOptions: false});
            });
            dialog.addEventListener('close', () => {
                if (!isDialogOpen()) {
                    updateJobNotice();
                    schedulePolling();
                } else {
                    updateJobNotice();
                }
            });
            return dialog;
        }

        function makeJobNotice() {
            if (jobNotice || !doc?.createElement || !doc.body) return jobNotice;
            jobNotice = makeElement('section', 'gallery-webp-job-notice');
            jobNotice.setAttribute('aria-label', 'WebP 변환 진행 상황');
            jobNotice.setAttribute('role', 'status');
            jobNotice.setAttribute('aria-live', 'polite');
            const title = makeElement('h2', 'gallery-webp-job-notice-title', 'WebP 변환');
            const status = makeElement('p', 'gallery-webp-job-notice-status');
            const target = makeElement('p', 'gallery-webp-job-notice-target');
            const progress = makeElement('progress', 'gallery-webp-job-notice-progress');
            progress.max = 1;
            progress.value = 0;
            progress.setAttribute('aria-label', 'WebP 변환 진행');
            const counters = makeElement('p', 'gallery-webp-job-notice-counters');
            const reason = makeElement('p', 'gallery-webp-job-notice-reason');
            const actions = makeElement('div', 'gallery-webp-job-notice-actions');
            const details = makeElement('button', 'gallery-webp-job-notice-details', '자세히');
            details.type = 'button';
            details.hidden = false;
            const stop = makeElement('button', 'gallery-webp-job-notice-stop', '중지');
            stop.type = 'button';
            const close = makeElement('button', 'gallery-webp-job-notice-close', '닫기');
            close.type = 'button';
            actions.append(details, stop, close);
            jobNotice.append(title, status, target, progress, counters, reason, actions);
            doc.body.appendChild(jobNotice);
            details.addEventListener('click', openJobDetails);
            stop.addEventListener('click', cancelConversion);
            close.addEventListener('click', dismissJobNotice);
            return jobNotice;
        }

        function updateJobNotice() {
            const notice = makeJobNotice();
            if (!notice) return;
            const id = String(job?.id || '');
            const running = job?.status === 'running';
            const terminal = Boolean(id && job?.status && job.status !== 'idle' && !running);
            const dismissed = terminal && dismissedJobIds.has(id);
            const visible = !isDialogOpen() && (startPending || running || Boolean(startRequestError) || (terminal && !dismissed));
            notice.hidden = !visible;
            if (!visible) return;

            const pending = startPending;
            const value = pending ? {
                status: 'running', total: pendingTotal, processed: 0,
                converted: 0, skipped: 0, failed: 0,
            } : job || {};
            const total = Math.max(0, Number(value.total) || 0);
            const processed = Math.max(0, Number(value.processed) || 0);
            const progress = notice.querySelector('.gallery-webp-job-notice-progress');
            if (progress) {
                progress.max = Math.max(1, total);
                if (pending || (running && total === 1 && processed === 0)) {
                    progress.removeAttribute('value');
                } else {
                    progress.value = Math.min(processed, total || processed);
                    progress.setAttribute('value', String(progress.value));
                }
            }
            const status = notice.querySelector('.gallery-webp-job-notice-status');
            if (status) {
                const modalStatus = dialog?.querySelector('.gallery-image-tools-status')?.textContent || '';
                status.textContent = pending
                    ? '서버에 변환 작업을 요청하는 중입니다. 창을 닫아도 요청과 변환은 계속됩니다.'
                    : startRequestError || modalStatus || (running ? '변환 중입니다. 창을 닫아도 계속됩니다.' : '변환 결과가 준비되었습니다.');
                status.classList.toggle('is-error', Boolean(startRequestError) || Boolean(dialog?.querySelector('.gallery-image-tools-status')?.classList.contains('is-error')));
            }
            const target = notice.querySelector('.gallery-webp-job-notice-target');
            if (target) {
                const path = String(pending ? jobTargetPath || selectedPaths[0] || '' : getJobTargetPath());
                target.textContent = path;
                target.title = path;
                target.hidden = !path;
            }
            const counters = notice.querySelector('.gallery-webp-job-notice-counters');
            let failed = 0;
            let skipped = 0;
            if (counters) {
                const converted = Math.max(0, Number(value.converted) || 0);
                skipped = Math.max(0, Number(value.skipped) || 0);
                failed = Math.max(0, Number(value.failed) || 0);
                const percent = total ? Math.floor(Math.min(processed, total) * 100 / total) : 0;
                counters.textContent = `처리 ${processed.toLocaleString()} / ${total.toLocaleString()}장 · ${percent}% · 변환 ${converted.toLocaleString()} · 건너뜀 ${skipped.toLocaleString()} · 실패 ${failed.toLocaleString()}`;
            }
            const reason = notice.querySelector('.gallery-webp-job-notice-reason');
            if (reason) {
                const first = Array.isArray(value.details) ? value.details[0] : null;
                const message = String(first?.message || first?.reason || '').trim();
                reason.textContent = message;
                reason.hidden = !message || failed === 0;
            }
            const stop = notice.querySelector('.gallery-webp-job-notice-stop');
            if (stop) stop.hidden = !running || Boolean(job?.cancel_requested) || !job?.id;
            const close = notice.querySelector('.gallery-webp-job-notice-close');
            if (close) close.hidden = !(terminal || startRequestError);
        }

        function dismissJobNotice() {
            const id = String(job?.id || '');
            if (id && job?.status && job.status !== 'idle' && job.status !== 'running') dismissedJobIds.add(id);
            startRequestError = '';
            updateJobNotice();
        }

        function openJobDetails() {
            if (!showDialog()) return;
            setProgressView(true);
            if (startPending) {
                renderJob({status: 'running', total: pendingTotal, processed: 0,
                    converted: 0, skipped: 0, failed: 0, source_bytes: 0, target_bytes: 0,
                    details: [], cancel_requested: false, keep_original: pendingKeepOriginal});
                setStatus('서버에 변환 작업을 요청하는 중입니다.');
            } else if (job && job.status !== 'idle' && !startRequestError) {
                renderJob(job);
            }
            updateStartButton();
        }

        function query(selector) {
            return makeDialog()?.querySelector(selector) || null;
        }

        function queryAll(selector) {
            return makeDialog()?.querySelectorAll(selector) || [];
        }

        function setStatus(message, isError = false) {
            const status = query('.gallery-image-tools-status');
            if (!status) return;
            status.textContent = message || '';
            status.classList.toggle('is-error', Boolean(isError));
            updateJobNotice();
        }

        function setProgressView(value) {
            progressView = Boolean(value) && !allowTagExclusions;
            if (dialog) dialog.classList.toggle('is-progress-view', progressView);
        }

        function snapshotProjectContext(value) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
            let prototype;
            try { prototype = Object.getPrototypeOf(value); }
            catch (_) { return null; }
            if (prototype !== Object.prototype && prototype !== null) return null;
            return {projectId: value.projectId, side: value.side, candidateId: value.candidateId};
        }

        function getJobTargetPath() {
            return String(jobPaths[0] || jobTargetPath || selectedPaths[0] || '');
        }

        function updateStartButton() {
            const button = query('.gallery-image-tools-start');
            if (button) {
                const invalidCount = selectedPaths.length === 0 || selectedPaths.length > MAX_WEBP_PATHS;
                button.disabled = startPending || invalidCount || job?.status === 'running';
                button.textContent = !allowTagExclusions && keepOriginal ? 'WebP 추가 저장' : 'WebP로 교체';
                button.hidden = progressView;
            }
            const back = query('.gallery-image-tools-back');
            if (back) {
                back.hidden = !progressView;
                back.disabled = startPending || job?.status === 'running';
            }
            const subtitle = query('.gallery-image-tools-subtitle');
            if (subtitle) subtitle.textContent = progressView
                ? '변환 진행 상황과 결과를 확인합니다.'
                : '이미지를 더 작은 WebP 파일로 저장합니다.';
            const panel = query('.gallery-image-tools-job');
            if (panel) panel.setAttribute('aria-busy', String(startPending || job?.status === 'running'));
            const target = query('.gallery-image-tools-job-target');
            if (target) {
                const path = getJobTargetPath();
                target.textContent = path;
                target.title = path;
            }
            const storage = query('.gallery-image-tools-storage');
            if (storage) { storage.hidden = allowTagExclusions; storage.disabled = startPending || job?.status === 'running'; }
            const add = query('.gallery-image-tools-storage-add');
            const replace = query('.gallery-image-tools-storage-replace');
            if (add) add.checked = keepOriginal;
            if (replace) replace.checked = !keepOriginal;
            updateExclusionControls();
            updateJobNotice();
        }

        function readAttachedTags(paths) {
            const pathIds = new Map();
            const counts = new Map();
            for (const path of paths) {
                let id = '';
                try { id = String(host.getGalleryImageTagId?.(path) || '').trim(); }
                catch (_) { id = ''; }
                pathIds.set(path, id);
                if (id) counts.set(id, (counts.get(id) || 0) + 1);
            }

            let definitions = [];
            try {
                const state = host.getGalleryTagState?.();
                if (Array.isArray(state?.definitions)) definitions = state.definitions;
            } catch (_) { /* Missing tag state is treated as unknown tagged images. */ }
            const definitionById = new Map();
            definitions.forEach(tag => {
                const id = String(tag?.id ?? '').trim();
                if (id) definitionById.set(id, tag);
            });

            const options = [...counts].map(([id, count]) => {
                const definition = definitionById.get(id);
                const fallback = !definition || !definition.value;
                const name = fallback
                    ? `알 수 없는 태그 (${id})`
                    : definition.type === 'text' ? String(definition.value) : `그림 태그 ${definitions.indexOf(definition) + 1}`;
                return {id, count, definition: fallback ? null : definition, name};
            });
            return {pathIds, options};
        }

        function renderTagOptions(options) {
            const list = query('.gallery-image-tools-tag-options');
            const empty = query('.gallery-image-tools-tag-empty');
            if (!list || !empty) return;
            list.replaceChildren();
            empty.hidden = options.length > 0;
            for (const item of options) {
                const row = makeElement('label', 'gallery-image-tools-tag-option');
                row.dataset.tagId = item.id;
                const checkbox = makeElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = excludedTagIds.has(item.id);
                checkbox.dataset.tagId = item.id;
                checkbox.setAttribute('aria-label', `${item.name} ${item.count}장`);
                const icon = makeElement('span', 'gallery-image-tools-tag-icon');
                icon.setAttribute('aria-hidden', 'true');
                if (item.definition?.type === 'text') {
                    icon.classList.add('is-text-tag');
                    icon.textContent = '가';
                    icon.style.color = item.definition.textColor || '#ffffff';
                    icon.style.backgroundColor = item.definition.bgColor || '#2563eb';
                } else if (item.definition && typeof host.renderGalleryTagIcon === 'function') {
                    try {
                        const html = host.renderGalleryTagIcon(item.definition);
                        if (typeof html === 'string') icon.innerHTML = html;
                        else icon.textContent = item.name;
                    } catch (_) { icon.textContent = item.name; }
                } else {
                    icon.textContent = '?';
                }
                const name = makeElement('span', 'gallery-image-tools-tag-name', item.name);
                name.title = item.name;
                const count = makeElement('span', 'gallery-image-tools-tag-count', `${item.count}장`);
                row.append(checkbox, icon, name, count);
                row.classList.toggle('is-selected', checkbox.checked);
                row.classList.toggle('is-disabled', excludeAllTagged);
                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) excludedTagIds.add(item.id);
                    else excludedTagIds.delete(item.id);
                    row.classList.toggle('is-selected', checkbox.checked);
                    updateTagExclusions({renderOptions: false});
                });
                list.appendChild(row);
            }
        }

        function updateExclusionControls() {
            const allCheckbox = query('.gallery-image-tools-exclude-all-tagged');
            const busy = startPending || job?.status === 'running';
            const disabled = !allowTagExclusions || busy;
            if (allCheckbox) {
                allCheckbox.checked = excludeAllTagged;
                allCheckbox.disabled = disabled;
            }
            queryAll('.gallery-image-tools-tag-option').forEach(row => {
                const checkbox = row.querySelector('input');
                if (!checkbox) return;
                checkbox.checked = excludedTagIds.has(String(checkbox.dataset.tagId || ''));
                checkbox.disabled = disabled || excludeAllTagged;
                row.classList.toggle('is-selected', checkbox.checked);
                row.classList.toggle('is-disabled', checkbox.disabled);
            });
        }

        function updateTagExclusions({renderOptions = true} = {}) {
            const section = query('.gallery-image-tools-tag-exclusion');
            if (section) section.hidden = !allowTagExclusions;
            if (allowTagExclusions) {
                const {pathIds, options} = readAttachedTags(baseSelectedPaths);
                selectedPaths = baseSelectedPaths.filter(path => {
                    const id = pathIds.get(path) || '';
                    return !id || !(excludeAllTagged || excludedTagIds.has(id));
                });
                if (renderOptions) renderTagOptions(options);
            } else {
                selectedPaths = baseSelectedPaths.slice();
            }

            const target = query('.gallery-image-tools-target');
            if (target) target.textContent = selectedPaths.length > MAX_WEBP_PATHS
                ? `대상 ${selectedPaths.length.toLocaleString()}장`
                : `변환 대상 ${selectedPaths.length.toLocaleString()}장`;
            if (allowTagExclusions) {
                const summary = query('.gallery-image-tools-tag-summary');
                if (summary) {
                    const excluded = baseSelectedPaths.length - selectedPaths.length;
                    summary.textContent = `전체 ${baseSelectedPaths.length.toLocaleString()}장 · 태그 제외 ${excluded.toLocaleString()}장 · 변환 ${selectedPaths.length.toLocaleString()}장`;
                }
            }

            if (!startPending && job?.status !== 'running') {
                if (selectedPaths.length === 0) {
                    setStatus(baseSelectedPaths.length && allowTagExclusions
                        ? '태그 제외 후 변환할 그림이 없습니다.'
                        : '현재 폴더에 표시된 그림이 없습니다.', true);
                } else if (selectedPaths.length > MAX_WEBP_PATHS) {
                    setStatus(`한 번에 최대 ${MAX_WEBP_PATHS.toLocaleString()}장까지 선택할 수 있습니다.`, true);
                } else {
                    const status = query('.gallery-image-tools-status');
                    if (status?.classList.contains('is-error') && /태그 제외 후 변환할 그림이 없습니다|한 번에 최대/.test(status.textContent)) {
                        setStatus('');
                    }
                }
            }
            updateStartButton();
        }

        function setSelectedPaths(paths, scopeText = '', location = currentLocation(), allowExclusions = false) {
            baseSelectedPaths = uniquePaths(paths);
            allowTagExclusions = Boolean(allowExclusions);
            setProgressView(false);
            if (!startPending && job?.status !== 'running') {
                jobPaths = [];
                jobTargetPath = '';
                startRequestError = '';
            }
            keepOriginal = !allowTagExclusions;
            excludedTagIds = new Set();
            excludeAllTagged = false;
            conversionFinishedForSelection = false;
            selectedLocation = {
                kind: String(location?.kind || '현재 폴더'),
                name: String(location?.name || '갤러리 홈'),
                path: String(location?.path || '갤러리 홈'),
                breadcrumb: String(location?.breadcrumb || ''),
            };
            updateLocationCard();
            updateTagExclusions();
            const scope = query('.gallery-image-tools-scope');
            if (scope) scope.textContent = scopeText;
            const progress = query('.gallery-image-tools-progress');
            if (progress) { progress.max = 1; progress.value = 0; progress.setAttribute('value', '0'); }
            const progressText = query('.gallery-image-tools-progress-text');
            if (progressText) progressText.textContent = '';
            const details = query('.gallery-image-tools-details');
            if (details) { details.replaceChildren(); details.hidden = true; }
            if (selectedPaths.length > MAX_WEBP_PATHS) setStatus(`한 번에 최대 ${MAX_WEBP_PATHS.toLocaleString()}장까지 선택할 수 있습니다.`, true);
            else if (!selectedPaths.length) {
                setStatus(baseSelectedPaths.length && allowTagExclusions
                    ? '태그 제외 후 변환할 그림이 없습니다.'
                    : '현재 폴더에 표시된 그림이 없습니다.', true);
            } else setStatus('');
            updateStartButton();
        }

        function showDialog() {
            makeDialog();
            if (!dialog) return false;
            if (!isDialogOpen()) {
                if (typeof dialog.showModal === 'function') dialog.showModal();
                else { dialog.setAttribute('open', ''); dialog.open = true; }
            }
            updateJobNotice();
            return true;
        }

        async function openForPaths(paths, scopeText = '', location = currentLocation(), allowExclusions = false,
                                    projectContext = null) {
            selectedProjectContext = snapshotProjectContext(projectContext);
            setSelectedPaths(paths, scopeText, location, allowExclusions);
            if (!showDialog()) return;
            stopPolling();
            await loadJobStatus();
        }

        function openCurrentFolder() {
            const paths = collectPaths();
            const scopeText = '표시된 그림만 변환 · 하위 폴더 제외';
            return openForPaths(paths, scopeText, currentLocation(), true);
        }

        function openContext(path, projectContext = null) {
            if (!path) {
                selectedProjectContext = null;
                setStatus('선택한 그림 경로를 확인할 수 없습니다.', true);
                return Promise.resolve();
            }
            return openForPaths([path], '선택한 그림 한 장만 변환', selectedImageLocation(path), false, projectContext);
        }

        function jobError(payload, response) {
            return payload?.message || payload?.error || `요청 실패 (HTTP ${response.status})`;
        }

        function setJob(value) {
            if (!value || typeof value !== 'object') return;
            job = value;
            if (value.status !== 'idle') startRequestError = '';
            if (value.status === 'running') {
                setProgressView(true);
                if (jobPaths[0]) jobTargetPath = jobPaths[0];
                else if (!jobTargetPath) jobTargetPath = selectedPaths[0] || '';
            }
            renderJob(value);
            updateStartButton();
            if (value.status === 'running') schedulePolling();
            else stopPolling();
        }

        function formatMiB(value) {
            const number = Number(value);
            return Number.isFinite(number) && number > 0 ? `${(number / (1024 * 1024)).toFixed(2)} MiB` : '0.00 MiB';
        }

        function renderJob(value) {
            const processed = Math.max(0, Number(value.processed) || 0);
            const total = Math.max(0, Number(value.total) || 0);
            const idle = value.status === 'idle';
            const jobTitle = query('.gallery-image-tools-section-title');
            if (jobTitle) jobTitle.textContent = idle ? '실행 준비' : value.status === 'running' ? '진행 중인 작업' : '최근 변환 결과';
            const progress = query('.gallery-image-tools-progress');
            if (progress) {
                progress.max = Math.max(1, total);
                const indeterminate = progressView && value.status === 'running' && total === 1 && processed === 0;
                if (indeterminate) {
                    progress.removeAttribute('value');
                } else {
                    progress.value = Math.min(processed, total || processed);
                    progress.setAttribute('value', String(progress.value));
                }
                progress.hidden = idle;
            }
            const progressText = query('.gallery-image-tools-progress-text');
            if (progressText) {
                const percent = total ? Math.floor(Math.min(processed, total) * 100 / total) : 0;
                progressText.textContent = idle ? '' : progressView
                    ? `${processed.toLocaleString()} / ${total.toLocaleString()}장 · ${percent}%`
                    : `${processed.toLocaleString()} / ${total.toLocaleString()}`;
                progressText.hidden = idle;
            }
            const jobTarget = query('.gallery-image-tools-job-target');
            if (jobTarget) {
                const path = getJobTargetPath();
                jobTarget.textContent = path;
                jobTarget.title = path;
            }
            const counters = query('.gallery-image-tools-counters');
            if (counters) counters.hidden = idle;
            for (const key of ['converted', 'skipped', 'failed']) {
                const output = query(`.gallery-image-tools-stat-${key} .gallery-image-tools-stat-value`);
                if (output) output.textContent = String(Math.max(0, Number(value[key]) || 0));
            }
            const bytes = query('.gallery-image-tools-bytes');
            if (bytes) {
                bytes.textContent = idle ? '' : value.keep_original
                    ? `원본 유지 · WebP ${formatMiB(value.target_bytes)} 추가`
                    : `원본 ${formatMiB(value.source_bytes)} → WebP ${formatMiB(value.target_bytes)}`;
                bytes.hidden = idle;
            }
            const details = query('.gallery-image-tools-details');
            if (details) {
                details.replaceChildren();
                const rows = Array.isArray(value.details) ? value.details.slice(0, 30) : [];
                rows.forEach(detail => {
                    const item = doc.createElement('li');
                    const path = doc.createElement('span');
                    path.className = 'gallery-image-tools-detail-path';
                    path.textContent = String(detail?.path || '');
                    const message = doc.createElement('span');
                    message.className = 'gallery-image-tools-detail-message';
                    message.textContent = String(detail?.message || '');
                    item.append(path, message);
                    details.appendChild(item);
                });
                if (Array.isArray(value.details) && value.details.length > rows.length) {
                    const more = doc.createElement('li');
                    more.textContent = `외 ${value.details.length - rows.length}건`;
                    details.appendChild(more);
                }
                details.hidden = rows.length === 0;
            }
            const cancel = query('.gallery-image-tools-cancel');
            const cancelRequested = Boolean(value.cancel_requested);
            if (cancel) cancel.disabled = value.status !== 'running' || !value.id || cancelRequested;
            if (value.status === 'error') setStatus('변환 작업이 실패했습니다. 대상을 확인한 뒤 다시 실행할 수 있습니다.', true);
            else if (value.status === 'cancelled') setStatus('변환 작업이 중지되었습니다.');
            else if (value.status === 'completed') {
                const failed = Math.max(0, Number(value.failed) || 0);
                const skipped = Math.max(0, Number(value.skipped) || 0);
                const converted = Math.max(0, Number(value.converted) || 0);
                if (failed) setStatus(`변환 작업이 끝났습니다. ${failed.toLocaleString()}장 실패 · ${converted.toLocaleString()}장 변환 · ${skipped.toLocaleString()}장 건너뜀.`, true);
                else if (total > 0 && skipped >= total && converted === 0) {
                    const first = Array.isArray(value.details) ? value.details[0] : null;
                    const reason = String(first?.message || first?.reason || '').trim();
                    setStatus(reason ? `변환 안 됨 · ${reason}` : '모든 대상이 건너뛰어졌습니다.');
                }
                else setStatus('변환 작업이 완료되었습니다.');
            }
            else if (value.status === 'running' && cancelRequested) setStatus('중지 요청됨 · 현재 파일 정리 중');
            else if (value.status === 'running') setStatus('변환 중입니다. 창을 닫아도 서버 작업은 계속됩니다.');
            else if (value.status === 'idle' && selectedPaths.length > MAX_WEBP_PATHS) {
                setStatus(`한 번에 최대 ${MAX_WEBP_PATHS.toLocaleString()}장까지 선택할 수 있습니다.`, true);
            } else if (value.status === 'idle' && selectedPaths.length) setStatus('실행 준비가 되었습니다.');
        }

        async function loadJobStatus() {
            jobStatusAbort?.abort();
            jobStatusAbort = null;
            const revision = ++jobRequestRevision;
            const controller = typeof host.AbortController === 'function' ? new host.AbortController() : null;
            jobStatusAbort = controller;
            try {
                const response = await host.fetch('/api/gallery/webp', {cache: 'no-store', ...(controller ? {signal: controller.signal} : {})});
                const payload = await response.json();
                if (revision !== jobRequestRevision || !isDialogOpen()) return;
                if (!response.ok || payload?.status !== 'success' || !payload.job) {
                    throw new Error(jobError(payload, response));
                }
                setJob(payload.job);
                if (payload.job.status !== 'running' && Number(payload.job.converted) > 0) {
                    await handleJobFinished(payload.job);
                }
            } catch (error) {
                if (revision === jobRequestRevision && isDialogOpen() && error?.name !== 'AbortError') setStatus(`작업 상태를 불러오지 못했습니다: ${error.message || error}`, true);
            } finally {
                if (jobStatusAbort === controller) jobStatusAbort = null;
            }
        }

        function schedulePolling() {
            if (!pageActive || pollTimer !== null || job?.status !== 'running') return;
            pollTimer = host.setTimeout(() => {
                pollTimer = null;
                pollJobStatus();
            }, 1000);
        }

        function stopPolling() {
            pollRevision++;
            if (pollTimer !== null) host.clearTimeout(pollTimer);
            pollTimer = null;
            pollAbort?.abort();
            pollAbort = null;
        }

        async function pollJobStatus() {
            if (job?.status !== 'running') return;
            const revision = pollRevision;
            const controller = typeof host.AbortController === 'function' ? new host.AbortController() : null;
            pollAbort = controller;
            try {
                const response = await host.fetch('/api/gallery/webp', {
                    cache: 'no-store', ...(controller ? {signal: controller.signal} : {})
                });
                const payload = await response.json();
                if (revision !== pollRevision) return;
                if (!response.ok || payload?.status !== 'success' || !payload.job) {
                    throw new Error(jobError(payload, response));
                }
                const previous = job;
                setJob(payload.job);
                if (previous?.status === 'running' && payload.job.status !== 'running') {
                    await handleJobFinished(payload.job);
                }
            } catch (error) {
                if (revision === pollRevision && error?.name !== 'AbortError') {
                    setStatus(`작업 상태 확인 실패: ${error.message || error}`, true);
                    schedulePolling();
                }
            } finally {
                if (pollAbort === controller) pollAbort = null;
            }
        }

        function updateVisibleImageSources(paths) {
            const versions = new Map();
            for (const path of paths) {
                const versioned = host.markGalleryImageUpdated?.(path);
                if (versioned) versions.set(path, versioned);
            }
            if (!versions.size || !doc?.querySelectorAll) return;
            doc.querySelectorAll('.item-box[data-path]').forEach(card => {
                const versioned = versions.get(card.dataset?.path);
                const image = card.querySelector?.('img.zoomable');
                if (!versioned || !image) return;
                image.src = image.src?.includes('preview=768')
                    ? `${versioned}${versioned.includes('?') ? '&' : '?'}preview=768`
                    : versioned;
            });
        }

        async function refreshAfterConversion(paths) {
            if (paths.length) invalidate(paths);
            else invalidate();
            updateVisibleImageSources(paths);
            if (isDakiActive()) {
                const params = new URLSearchParams(String(host.location?.hash || '').replace(/^#/, ''));
                const projectId = params.get('project');
                if (projectId && host.Daki?.refreshProject) {
                    await host.Daki.refreshProject(projectId);
                    updateVisibleImageSources(paths);
                } else if (typeof host.dispatchEvent === 'function') {
                    const event = typeof host.HashChangeEvent === 'function'
                        ? new host.HashChangeEvent('hashchange')
                        : new host.Event('hashchange');
                    host.dispatchEvent(event);
                }
            } else if (typeof host.loadData === 'function') {
                await host.loadData();
            }
            paths.forEach(path => {
                if (enabled) enqueuePath(path);
            });
        }

        async function handleJobFinished(value) {
            const id = String(value?.id || '');
            if (!id || refreshedJobs.has(id)) return;
            refreshedJobs.add(id);
            conversionFinishedForSelection = true;
            const paths = jobPaths.length ? jobPaths.slice() : collectPaths();
            if (Number(value.converted) > 0) await refreshAfterConversion(paths);
            updateStartButton();
        }

        async function startConversion() {
            if (startPending || job?.status === 'running') return;
            if (allowTagExclusions) updateTagExclusions();
            if (selectedPaths.length === 0) { setStatus('변환할 그림이 없습니다.', true); return; }
            if (selectedPaths.length > MAX_WEBP_PATHS) { setStatus(`한 번에 최대 ${MAX_WEBP_PATHS.toLocaleString()}장까지 변환할 수 있습니다.`, true); return; }
            const qualityInput = query('.gallery-image-tools-quality input');
            const quality = Number(qualityInput?.value);
            if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
                setStatus('품질은 1에서 100 사이의 정수로 입력해 주세요.', true);
                qualityInput?.focus();
                return;
            }
            jobRequestRevision++;
            jobStatusAbort?.abort();
            jobStatusAbort = null;
            const submittedPaths = selectedPaths.slice();
            const submittedContext = snapshotProjectContext(selectedProjectContext);
            jobPaths = [];
            jobTargetPath = submittedPaths[0] || '';
            pendingTotal = submittedPaths.length;
            pendingKeepOriginal = keepOriginal;
            startRequestError = '';
            startPending = true;
            if (!allowTagExclusions) {
                setProgressView(true);
                renderJob({status: 'running', total: selectedPaths.length, processed: 0,
                    converted: 0, skipped: 0, failed: 0, source_bytes: 0, target_bytes: 0,
                    details: [], cancel_requested: false, keep_original: keepOriginal});
                setStatus('서버에 변환 작업을 요청하는 중입니다.');
            }
            updateStartButton();
            if (allowTagExclusions) setStatus('서버에 변환 작업을 요청하는 중입니다.');
            try {
                const response = await host.fetch('/api/gallery/webp', {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({paths: submittedPaths, quality,
                        ...(!allowTagExclusions ? {keep_original: keepOriginal} : {}),
                        ...(submittedContext ? {projectContext: submittedContext} : {})})
                });
                const payload = await response.json();
                if (!response.ok || payload?.status !== 'success' || !payload.job) {
                    throw new Error(jobError(payload, response));
                }
                startPending = false;
                jobPaths = submittedPaths;
                jobTargetPath = submittedPaths[0] || '';
                startRequestError = '';
                conversionFinishedForSelection = false;
                setJob(payload.job);
                if (payload.job.status !== 'running') await handleJobFinished(payload.job);
            } catch (error) {
                startRequestError = `변환을 시작하지 못했습니다: ${error.message || error}`;
                setStatus(startRequestError, true);
            } finally {
                startPending = false;
                updateStartButton();
            }
        }

        async function cancelConversion() {
            if (!job?.id || job.status !== 'running') return;
            stopPolling();
            const button = query('.gallery-image-tools-cancel');
            if (button) button.disabled = true;
            setStatus('중지 요청을 보내는 중입니다.');
            try {
                const response = await host.fetch('/api/gallery/webp/cancel', {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({id: job.id})
                });
                const payload = await response.json();
                if (!response.ok || payload?.status !== 'success' || !payload.job) throw new Error(jobError(payload, response));
                const previous = job;
                setJob(payload.job);
                if (previous?.status === 'running' && payload.job.status !== 'running') await handleJobFinished(payload.job);
            } catch (error) {
                setStatus(`중지 요청 실패: ${error.message || error}`, true);
                if (button) button.disabled = false;
                if (job?.status === 'running') schedulePolling();
            }
        }

        function closeDialog() {
            jobRequestRevision++;
            jobStatusAbort?.abort();
            jobStatusAbort = null;
            if (!dialog) return;
            if (typeof dialog.close === 'function' && isDialogOpen()) dialog.close();
            else { dialog.open = false; dialog.removeAttribute('open'); }
            updateJobNotice();
            if (!isDialogOpen()) schedulePolling();
        }

        function invalidate(paths) {
            const targets = Array.isArray(paths)
                ? uniquePaths(paths)
                : [...new Set([...formatCache.keys(), ...cardsByPath.keys()])];
            const pathsToRequeue = new Set([...inFlightPaths.keys(), ...targets]);
            formatRevision++;
            formatRequestId++;
            formatAbort?.abort();
            formatAbort = null;
            formatRequestActive = false;
            inFlightPaths.clear();
            targets.forEach(path => {
                formatCache.delete(path);
                formatTitles.delete(path);
            });
            pathsToRequeue.forEach(path => {
                liveCards(path).forEach(card => {
                    const record = cardRecords.get(card);
                    if (record?.badge) {
                        record.badge.textContent = '?';
                        record.badge.title = '형식 확인 대기 중';
                    }
                    if (enabled) observeCard(card, path);
                });
            });
            if (enabled && queuedPaths.size) scheduleFormatQueue();
        }

        function cleanup() {
            pageActive = false;
            formatRevision++;
            formatRequestId++;
            formatObserver?.disconnect();
            formatObserver = null;
            formatAbort?.abort();
            formatAbort = null;
            formatRequestActive = false;
            queuedPaths.clear();
            inFlightPaths.clear();
            formatQueueScheduled = false;
            stopPolling();
            jobRequestRevision++;
            jobStatusAbort?.abort();
            jobStatusAbort = null;
        }

        function restoreAfterPageShow(event) {
            if (!event?.persisted) return;
            pageActive = true;
            const checkbox = doc?.getElementById('toggle-image-formats');
            if (checkbox) checkbox.checked = enabled;
            if (enabled) {
                installFormatObserver();
                applyEnabledToCards();
            }
            updateJobNotice();
            if (job?.status === 'running') schedulePolling();
        }

        function initialize() {
            ensureFormatControl();
            if (enabled) installFormatObserver();
            if (typeof host.addEventListener === 'function') {
                host.addEventListener('pagehide', cleanup);
                host.addEventListener('pageshow', restoreAfterPageShow);
                host.addEventListener('gallery-tags-updated', () => {
                    if (!isDialogOpen() || !allowTagExclusions || startPending || job?.status === 'running' || conversionFinishedForSelection) return;
                    updateTagExclusions();
                });
            }
        }

        return {initialize, decorate, openContext, openCurrentFolder, close: closeDialog, invalidate, collectPaths,
            get enabled() { return enabled; }, get formatCache() { return formatCache; }, get job() { return job; }};
    }

    const api = createGalleryImageTools(root);
    if (root && typeof root === 'object') root.GalleryImageTools = api;
    if (root.document) {
        if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', () => api.initialize(), {once: true});
        else api.initialize();
    }
    if (typeof module === 'object' && module.exports) {
        module.exports = {createGalleryImageTools, normalizeFormat, uniquePaths, collectCurrentFolderPaths};
    }
})(typeof window !== 'undefined' ? window : globalThis);
