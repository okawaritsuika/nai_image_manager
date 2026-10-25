/* Download public shared style-test packs into the existing editable test library. */
(function (root) {
    'use strict';
    const doc = root.document;
    const catalogUrl = '/api/daki/style-test-packs';
    const jobUrl = catalogUrl + '/job';
    const stopUrl = catalogUrl + '/stop';
    const terminal = new Set(['completed', 'stopped', 'failed']);
    const activeStatuses = new Set(['running', 'stopping']);
    const phaseLabels = {resolve: '목록 확인 중', download: '다운로드', verify: '검증', extract: '압축 해제',
        install: '테스트 저장 중', complete: '완료'};
    const settledJobs = new Set();
    let session = null;

    const node = (tag, className, text) => {
        const item = doc.createElement(tag);
        if (className) item.className = className;
        if (text !== undefined) item.textContent = text;
        return item;
    };
    function button(text, action, className = '') {
        const item = node('button', className, text);
        item.type = 'button'; item.onclick = action;
        return item;
    }
    function current(value) { return value === session && value.alive; }
    function isActiveJob(job) { return !!job && activeStatuses.has(job.status); }
    function formatBytes(value) {
        const units = ['B', 'KB', 'MB', 'GB'];
        let amount = value, unit = 0;
        while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
        return `${unit ? amount.toFixed(amount >= 10 ? 0 : 1) : amount} ${units[unit]}`;
    }
    function validatePacks(packs) {
        if (!Array.isArray(packs)) throw new Error('공유 테스트 목록 응답이 올바르지 않습니다.');
        const seen = new Set();
        return packs.map(pack => {
            if (!pack || typeof pack.id !== 'string' || !/^[a-f0-9]{32}$/i.test(pack.id) || seen.has(pack.id) ||
                typeof pack.name !== 'string' || !Number.isSafeInteger(pack.image_count) || pack.image_count < 1 ||
                !Number.isSafeInteger(pack.bytes) || pack.bytes < 1 || typeof pack.installed !== 'boolean') {
                throw new Error('공유 테스트 목록 응답이 올바르지 않습니다.');
            }
            seen.add(pack.id);
            return pack;
        });
    }
    function validateJob(job) {
        if (job === null) return null;
        if (!job || typeof job.id !== 'string' || !/^[a-f0-9]{32}$/i.test(job.id) ||
            !['running', 'stopping', ...terminal].includes(job.status) || typeof job.message !== 'string' ||
            typeof job.pack_name !== 'string' || !Number.isSafeInteger(job.completed_packs) || job.completed_packs < 0 ||
            !Number.isSafeInteger(job.total_packs) || job.total_packs < 0 ||
            !Number.isSafeInteger(job.installed) || job.installed < 0 || !Number.isSafeInteger(job.skipped) || job.skipped < 0 ||
            typeof job.phase !== 'string' || !Number.isSafeInteger(job.phase_current) || job.phase_current < 0 ||
            !Number.isSafeInteger(job.phase_total) || job.phase_total < 0) {
            throw new Error('공유 테스트 다운로드 진행 응답이 올바르지 않습니다.');
        }
        return job;
    }
    async function api(value, url, method = 'GET', body) {
        const response = await root.fetch(url, {method, headers: {'Content-Type': 'application/json'},
            ...(value.controller ? {signal: value.controller.signal} : {}),
            ...(body === undefined ? {} : {body: JSON.stringify(body)})});
        const result = await response.json();
        if (!response.ok || result.status !== 'success') throw new Error(result.message || '공유 테스트를 불러오지 못했습니다.');
        return result;
    }
    function clearPoll(value) {
        if (value.pollTimer !== null) root.clearTimeout(value.pollTimer);
        value.pollTimer = null;
    }
    function removeDialog(value) {
        const dialog = value.dialog;
        if (!dialog) return;
        value.dialog = null;
        if (dialog.open) dialog.close();
        dialog.remove();
    }
    function dispose(value, close = true) {
        if (!value || !value.alive) return;
        value.alive = false;
        clearPoll(value);
        value.controller?.abort();
        if (session === value) session = null;
        if (close) removeDialog(value);
    }
    function makeDialog(value) {
        const dialog = value.dialog = node('dialog', 'daki-dialog daki-test-packs-dialog');
        const originalFocus = doc.activeElement;
        const heading = node('h2', '', '공유 테스트 다운로드');
        heading.id = 'dakiTestPacksTitle';
        dialog.setAttribute('aria-labelledby', heading.id);
        const header = node('header', 'daki-test-packs-header');
        const close = button('닫기', () => dialog.close(), 'daki-test-packs-close');
        close.setAttribute('aria-label', '공유 테스트 다운로드 창 닫기');
        header.append(heading, close);
        const body = node('main', 'daki-test-packs-body');
        body.appendChild(node('p', 'daki-test-packs-note',
            '창을 닫아도 다운로드는 계속됩니다. 다운로드한 테스트는 기존 테스트 목록에서 열어 편집하고, 그림체를 추가하거나 생성할 수 있습니다.'));
        const toolbar = node('div', 'daki-test-packs-toolbar');
        const selectAll = button('받지 않은 테스트 모두 선택', () => {
            const missing = value.packs.filter(pack => !pack.installed);
            const allSelected = missing.length > 0 && missing.every(pack => value.selected.has(pack.id));
            missing.forEach(pack => allSelected ? value.selected.delete(pack.id) : value.selected.add(pack.id));
            render(value, false);
        });
        toolbar.appendChild(selectAll);
        const list = node('div', 'daki-test-packs-list');
        list.setAttribute('role', 'group'); list.setAttribute('aria-label', '다운로드할 공유 테스트');
        const empty = node('p', 'daki-test-packs-empty');
        const status = node('p', 'daki-test-packs-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        const progress = node('progress', 'daki-test-packs-progress'); progress.setAttribute('aria-label', '공유 테스트 다운로드 진행률');
        progress.hidden = true;
        const progressDetail = node('p', 'daki-test-packs-progress-detail'); progressDetail.hidden = true;
        const retry = button('다시 불러오기', () => loadCatalog(value)); retry.hidden = true;
        body.append(toolbar, list, empty, status, progress, progressDetail, retry);
        const footer = node('footer', 'daki-test-packs-actions');
        const start = button('선택한 테스트 다운로드', () => startDownload(value), 'daki-primary');
        const stop = button('다운로드 중지', () => stopDownload(value)); stop.hidden = true;
        footer.append(stop, start, button('닫기', () => dialog.close()));
        dialog.append(header, body, footer);
        dialog.addEventListener('close', () => {
            dialog.remove();
            if (value.dialog === dialog) value.dialog = null;
            if (current(value) && originalFocus?.isConnected) originalFocus.focus({preventScroll: true});
            if (!current(value)) return;
            if (!isActiveJob(value.job) && !value.startPending) dispose(value, false);
        });
        value.ui = {dialog, close, list, empty, status, progress, progressDetail, retry, selectAll, start, stop};
        doc.body.appendChild(dialog);
        dialog.showModal(); close.focus({preventScroll: true});
        render(value);
    }
    function jobStatus(job) {
        if (job.status === 'running' || job.status === 'stopping') {
            const phase = phaseLabels[job.phase] || '진행 중';
            const progress = job.phase === 'download' || job.phase === 'verify'
                ? `${formatBytes(job.phase_current)} / ${formatBytes(job.phase_total)}`
                : job.phase === 'extract' ? `${job.phase_current}/${job.phase_total}장` : '';
            const pack = job.pack_name ? `${job.pack_name} · ` : '';
            return `${pack}${phase}${progress ? ` ${progress}` : ''}${job.status === 'stopping' ? ' · 중지하는 중' : ''}`;
        }
        const label = job.status === 'completed' ? '다운로드 완료' : job.status === 'stopped' ? '다운로드 중지' : '다운로드 실패';
        const summary = `${job.completed_packs}/${job.total_packs}개 테스트 완료 · 저장 ${job.installed}개 · 건너뜀 ${job.skipped}개`;
        return [label, job.message, summary].filter(Boolean).join(' · ');
    }
    function render(value, rebuildList = true) {
        const ui = value.ui;
        if (!ui || !ui.dialog.open || !current(value)) return;
        const activeJob = isActiveJob(value.job);
        const busy = value.requestBusy || value.loading || value.startPending;
        if (rebuildList) ui.list.replaceChildren();
        if (value.loading) ui.empty.textContent = '공유 테스트 목록을 불러오는 중…';
        else if (value.loadError) ui.empty.textContent = '공유 테스트 목록을 불러오지 못했습니다.';
        else if (!value.packs.length) ui.empty.textContent = '다운로드할 공유 테스트가 없습니다.';
        else if (value.packs.every(pack => pack.installed)) ui.empty.textContent = '모든 공유 테스트가 이미 저장되어 있습니다.';
        else ui.empty.textContent = '';
        ui.empty.hidden = !ui.empty.textContent;
        if (rebuildList) {
            for (const pack of value.packs) {
                const row = node('label', 'daki-test-packs-row');
                const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = !pack.installed && value.selected.has(pack.id);
                checkbox.disabled = pack.installed || activeJob || busy || value.loadError;
                checkbox.setAttribute('aria-label', pack.name + ' 선택');
                checkbox.onchange = () => {
                    if (checkbox.checked) value.selected.add(pack.id); else value.selected.delete(pack.id);
                    render(value, false);
                };
                const details = node('span', 'daki-test-packs-copy');
                details.append(node('span', 'daki-test-packs-name', pack.name),
                    node('span', 'daki-test-packs-count', `${pack.image_count.toLocaleString('ko-KR')}장 · ${formatBytes(pack.bytes)}`));
                const badge = node('span', `daki-test-packs-badge${pack.installed ? ' is-installed' : ''}`, pack.installed ? '저장됨' : '다운로드 가능');
                row.append(checkbox, details, badge); ui.list.appendChild(row);
            }
        } else {
            ui.list.querySelectorAll('input').forEach((checkbox, index) => {
                const pack = value.packs[index];
                checkbox.checked = !!pack && !pack.installed && value.selected.has(pack.id);
                checkbox.disabled = !pack || pack.installed || activeJob || busy || value.loadError;
            });
        }
        const missing = value.packs.filter(pack => !pack.installed);
        const allSelected = missing.length > 0 && missing.every(pack => value.selected.has(pack.id));
        ui.selectAll.textContent = allSelected ? '받지 않은 테스트 선택 해제' : '받지 않은 테스트 모두 선택';
        ui.selectAll.disabled = busy || activeJob || value.loadError || !missing.length;
        ui.status.textContent = value.job ? [jobStatus(value.job), value.message].filter(Boolean).join(' · ') : value.message;
        ui.progress.hidden = !value.job;
        ui.progressDetail.hidden = !value.job || !activeJob;
        if (value.job) {
            ui.progress.max = Math.max(1, value.job.phase_total);
            ui.progress.value = Math.min(value.job.phase_current, ui.progress.max);
            ui.progressDetail.textContent = `${value.job.completed_packs}/${value.job.total_packs}개 테스트 · ${value.job.installed}개 저장 · ${value.job.skipped}개 건너뜀`;
        }
        ui.retry.hidden = !value.loadError;
        ui.retry.disabled = busy;
        ui.start.disabled = busy || activeJob || value.loadError || !value.selected.size || !value.packs.length;
        ui.stop.hidden = !activeJob || value.job.status === 'stopping';
        ui.stop.disabled = busy || !activeJob || value.job.status === 'stopping';
    }
    function refreshAfterJob(value, jobId) {
        if (!current(value) || !value.dialog?.open || value.refreshingJobs.has(jobId)) return;
        value.refreshingJobs.add(jobId);
        value.refreshPacksPending = true;
    }
    function finishRequest(value) {
        if (!current(value)) return;
        value.requestBusy = false; render(value);
        if (value.refreshPacksPending) {
            value.refreshPacksPending = false;
            loadCatalog(value, false).catch(() => {});
            return;
        }
        schedulePoll(value);
    }
    function setJob(value, rawJob, {notifySettled = false, refreshPacks = false} = {}) {
        if (!current(value)) return;
        const job = validateJob(rawJob);
        value.job = job;
        value.message = '';
        if (job && terminal.has(job.status)) {
            clearPoll(value);
            if (!settledJobs.has(job.id)) {
                settledJobs.add(job.id);
                if (notifySettled && job.installed > 0) {
                    try { Promise.resolve(value.onComplete?.(job)).catch(() => {}); } catch (_) { /* The root view owns callback errors. */ }
                }
            }
            if (refreshPacks) refreshAfterJob(value, job.id);
        } else schedulePoll(value);
        render(value);
    }
    function schedulePoll(value) {
        clearPoll(value);
        if (!current(value) || !isActiveJob(value.job)) return;
        value.pollTimer = root.setTimeout(() => poll(value), 900);
    }
    async function poll(value) {
        if (!current(value) || value.requestBusy || !isActiveJob(value.job)) return;
        value.pollTimer = null; value.requestBusy = true; render(value);
        try {
            const result = await api(value, jobUrl);
            if (!current(value)) return;
            const wasActive = isActiveJob(value.job);
            setJob(value, result.job, {notifySettled: wasActive, refreshPacks: wasActive});
        } catch (error) {
            if (!current(value)) return;
            value.message = error.message; render(value);
        } finally {
            finishRequest(value);
            if (current(value) && !value.dialog?.open && !isActiveJob(value.job)) dispose(value, false);
        }
    }
    async function loadCatalog(value, initial = false) {
        if (!current(value) || value.requestBusy) return;
        value.loading = true; value.loadError = false; value.message = initial ? '공유 테스트 목록을 불러오는 중…' : value.message;
        value.requestBusy = true; render(value);
        try {
            const result = await api(value, catalogUrl);
            if (!current(value)) return;
            const packs = validatePacks(result.packs);
            const previous = value.selected;
            value.selected = new Set(value.loaded ? packs.filter(pack => !pack.installed && previous.has(pack.id)).map(pack => pack.id)
                : packs.filter(pack => !pack.installed).map(pack => pack.id));
            value.packs = packs; value.loaded = true; value.loading = false; value.loadError = false; value.message = '';
            setJob(value, result.job);
        } catch (error) {
            if (!current(value)) return;
            value.loading = false; value.loadError = true; value.message = error.message;
        } finally { finishRequest(value); }
    }
    async function startDownload(value) {
        if (!current(value) || value.requestBusy || value.startPending || isActiveJob(value.job)) return;
        const packIds = value.packs.filter(pack => !pack.installed && value.selected.has(pack.id)).map(pack => pack.id);
        if (!packIds.length) return;
        clearPoll(value); value.requestBusy = true; value.startPending = true; value.message = '선택한 공유 테스트를 다운로드하는 중…'; render(value);
        try {
            const result = await api(value, catalogUrl, 'POST', {pack_ids: packIds});
            if (!current(value)) return;
            value.startPending = false;
            if (!result.job) throw new Error('공유 테스트 다운로드 진행 응답이 올바르지 않습니다.');
            setJob(value, result.job, {notifySettled: true, refreshPacks: !!result.job && terminal.has(result.job.status)});
        } catch (error) {
            if (!current(value)) return;
            value.startPending = false; value.message = error.message;
        } finally {
            finishRequest(value);
            if (current(value) && !value.dialog?.open && !isActiveJob(value.job)) dispose(value, false);
        }
    }
    async function stopDownload(value) {
        if (!current(value) || value.requestBusy || !isActiveJob(value.job) || value.job.status === 'stopping') return;
        clearPoll(value); value.requestBusy = true; value.message = '다운로드 중지를 요청하는 중…'; render(value);
        try {
            const result = await api(value, stopUrl, 'POST', {});
            if (!current(value)) return;
            const wasActive = isActiveJob(value.job);
            setJob(value, result.job, {notifySettled: wasActive, refreshPacks: wasActive});
        } catch (error) {
            if (!current(value)) return;
            value.message = error.message;
        } finally { finishRequest(value); }
    }
    function open(options = {}) {
        if (session?.alive && session.dialog?.open) return;
        if (session?.alive && (isActiveJob(session.job) || session.startPending)) {
            session.onComplete = options.onComplete || session.onComplete;
            makeDialog(session); render(session); schedulePoll(session); return;
        }
        if (session?.alive) dispose(session);
        const controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
        const value = session = {alive: true, controller, onComplete: options.onComplete,
            dialog: null, ui: null, packs: [], selected: new Set(), loaded: false, loading: true, loadError: false,
            message: '공유 테스트 목록을 불러오는 중…', job: null, requestBusy: false, startPending: false,
            pollTimer: null, refreshingJobs: new Set(), refreshPacksPending: false};
        makeDialog(value);
        return loadCatalog(value, true);
    }
    function leave() {
        if (session) dispose(session);
    }
    root.DakiTestPacks = {open, leave};
})(typeof window === 'undefined' ? globalThis : window);
