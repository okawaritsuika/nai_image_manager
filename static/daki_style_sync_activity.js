/* Background progress for shared-style synchronization. */
(function (root) {
    'use strict';

    const endpoint = '/api/daki/shared-styles/sync';
    const statuses = new Set(['running', 'completed', 'failed', 'stopped']);
    let attached = false;
    let suspended = false;
    let bootstrapped = false;
    let generation = 0;
    let timer = null;
    let activeRead = null;
    let tracked = false;
    let trackedJob = null;
    let trackedIdentity = null;
    let trackedKey = null;
    let nextAnonymousKey = 0;
    let dismissedKey = null;
    let connectionWarning = false;
    const notifiedKeys = new Set();
    let view = null;

    const node = (tag, className, text) => {
        const element = root.document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    };

    function refreshPanel() {
        if (typeof root.refreshGalleryJobPanelVisibility === 'function') {
            root.refreshGalleryJobPanelVisibility();
        }
    }

    function buildView() {
        if (view) return view;
        const body = root.document?.getElementById('dakiStyleSyncJobBody');
        if (!body) return null;

        const title = node('div', 'gallery-index-job-title');
        title.appendChild(node('strong', '', '공유 그림체 최신화'));
        const state = node('span', 'gallery-index-status');
        title.appendChild(state);

        const message = node('p', 'gallery-index-job-message');
        message.setAttribute('role', 'status');
        message.setAttribute('aria-live', 'polite');

        const progressLabel = node('div', 'gallery-index-progress-meta');
        const progressText = node('span', 'daki-style-sync-activity-progress-text');
        progressLabel.appendChild(progressText);
        const meter = node('div', 'gallery-index-meter');
        meter.setAttribute('role', 'progressbar');
        meter.setAttribute('aria-valuemin', '0');
        meter.setAttribute('aria-valuemax', '100');
        const fill = node('div', 'gallery-index-progress-fill');
        meter.appendChild(fill);

        const actions = node('div', 'gallery-index-job-actions');
        const details = node('button', '', '자세히 보기');
        details.type = 'button';
        details.addEventListener('click', () => root.DakiStyleSync?.open?.());
        const dismiss = node('button', '', '알림 닫기');
        dismiss.type = 'button';
        dismiss.addEventListener('click', dismissActivity);
        actions.append(details, dismiss);

        body.append(title, message, progressLabel, meter, actions);
        view = {body, state, message, progressLabel, progressText, meter, fill, dismiss};
        return view;
    }

    function refreshView() {
        const elements = buildView();
        if (!elements) return;
        const visible = tracked && trackedJob && !attached && trackedKey !== dismissedKey;
        elements.body.hidden = !visible;
        if (!visible) {
            refreshPanel();
            return;
        }

        const status = trackedJob.status;
        const stateClasses = status === 'running' ? 'running'
            : status === 'failed' || status === 'stopped' ? 'error' : 'done';
        const labels = {running: '진행중', completed: '완료', failed: '실패', stopped: '중지'};
        elements.state.className = `gallery-index-status ${stateClasses}`;
        elements.state.textContent = labels[status] || '상태 확인';

        const formatter = root.DakiStyleSync?.jobText;
        const summary = typeof formatter === 'function'
            ? String(formatter(trackedJob) ?? '')
            : '공유 그림체 작업 진행 상황을 확인할 수 없습니다.';
        elements.message.textContent = connectionWarning
            ? `${summary} · 진행 상태 연결을 다시 확인하고 있습니다.`
            : summary;

        const progressFormatter = root.DakiStyleSync?.jobProgress;
        const progress = typeof progressFormatter === 'function' ? progressFormatter(trackedJob) : null;
        const progressPercent = Number.isSafeInteger(progress?.percent) && progress.percent >= 0 && progress.percent <= 100
            ? progress.percent : null;
        const hasProgress = typeof progress?.text === 'string' && progress.text.length > 0;
        elements.progressLabel.hidden = !hasProgress;
        elements.meter.hidden = !hasProgress;
        elements.progressText.textContent = hasProgress ? progress.text : '';
        elements.meter.className = `gallery-index-meter${progressPercent === null ? ' is-indeterminate' : ''}`;
        if (hasProgress && progress?.label) elements.meter.setAttribute('aria-label', `${progress.label} 진행률`);
        else elements.meter.removeAttribute('aria-label');
        if (progressPercent === null) elements.meter.removeAttribute('aria-valuenow');
        else elements.meter.setAttribute('aria-valuenow', String(progressPercent));
        elements.fill.style.width = progressPercent === null ? '38%' : `${progressPercent}%`;

        elements.dismiss.hidden = status === 'running';
        refreshPanel();
    }

    function cancelTimer() {
        if (timer !== null) root.clearTimeout(timer);
        timer = null;
    }

    function invalidateReads() {
        generation++;
        cancelTimer();
    }

    function schedule(delay) {
        if (attached || suspended || !tracked || trackedJob?.status !== 'running' || timer !== null) return;
        timer = root.setTimeout(() => {
            timer = null;
            return readStatus();
        }, delay);
    }

    function identityOf(job) {
        return typeof job?.started_at === 'string' && job.started_at.trim()
            ? job.started_at.trim() : null;
    }

    function sameTrackedJob(job) {
        if (!tracked) return false;
        const identity = identityOf(job);
        return identity === null ? trackedIdentity === null : identity === trackedIdentity;
    }

    function track(job, {started = false} = {}) {
        const identity = identityOf(job);
        if (started && !sameTrackedJob(job)) {
            trackedKey = identity === null
                ? `anonymous-${++nextAnonymousKey}`
                : `job-${String(job.source || '')}-${identity}`;
        } else if (!tracked || !sameTrackedJob(job)) {
            trackedKey = identity === null
                ? `anonymous-${++nextAnonymousKey}`
                : `job-${String(job.source || '')}-${identity}`;
        }
        tracked = true;
        trackedIdentity = identity;
        trackedJob = job;
        connectionWarning = false;
    }

    function notifyCompletion(job) {
        if (attached || job.status === 'running' || !trackedKey || notifiedKeys.has(trackedKey)) return;
        const notify = root.DakiStyleSync?.notifyActivityCompletion;
        if (typeof notify !== 'function') return;
        notifiedKeys.add(trackedKey);
        try {
            notify(job);
        } catch (error) {
            root.console?.warn?.('공유 그림체 완료 알림을 처리하지 못했습니다.', error);
        }
    }

    function clearTracked() {
        tracked = false;
        trackedJob = null;
        trackedIdentity = null;
        trackedKey = null;
        connectionWarning = false;
        refreshView();
    }

    function acceptObserved(job, options = {}) {
        if (!job || typeof job !== 'object' || !statuses.has(job.status)) {
            if (trackedJob?.status === 'running') schedule(1000);
            return;
        }
        const started = options.started === true;
        if (job.status === 'running') {
            track(job, {started});
        } else if (started || sameTrackedJob(job)) {
            track(job, {started});
        } else {
            if (trackedJob?.status === 'running') schedule(1000);
            return;
        }
        refreshView();
        if (job.status === 'running') schedule(1000);
        else notifyCompletion(job);
    }

    function handleReadJob(job) {
        if (!job || typeof job !== 'object' || !statuses.has(job.status)) {
            if (trackedJob?.status === 'running') {
                connectionWarning = true;
                refreshView();
                schedule(2000);
            }
            return;
        }
        if (job.status === 'running') {
            track(job);
            refreshView();
            schedule(1000);
            return;
        }
        if (sameTrackedJob(job)) {
            track(job);
            refreshView();
            notifyCompletion(job);
            return;
        }
        if (trackedJob?.status === 'running') schedule(1000);
    }

    function readFailed(request) {
        if (request.token !== generation || attached || suspended) return;
        if (tracked && trackedJob?.status === 'running') {
            connectionWarning = true;
            refreshView();
            schedule(2000);
        }
    }

    function readStatus() {
        if (attached || suspended) return Promise.resolve();
        if (activeRead?.token === generation) return activeRead.promise;

        const request = {token: ++generation, promise: null};
        request.promise = (async () => {
            try {
                const response = await root.fetch(endpoint, {method: 'GET', cache: 'no-store'});
                if (request.token !== generation || attached || suspended) return;
                const result = await response.json();
                if (request.token !== generation || attached || suspended) return;
                if (!response.ok || result?.status !== 'success') throw new Error('공유 그림체 상태 요청 실패');
                handleReadJob(result.job);
            } catch (error) {
                readFailed(request);
            } finally {
                if (activeRead === request) activeRead = null;
            }
        })();
        activeRead = request;
        return request.promise;
    }

    function attach() {
        if (attached) return;
        attached = true;
        invalidateReads();
        refreshView();
    }

    function observe(job, {started = false} = {}) {
        invalidateReads();
        if (job === null) {
            clearTracked();
            return;
        }
        acceptObserved(job, {started});
    }

    function detach({check = false} = {}) {
        const wasAttached = attached;
        attached = false;
        if (wasAttached) {
            refreshView();
            if (check) {
                readStatus();
                return;
            }
        }
        if (trackedJob?.status === 'running') schedule(1000);
    }

    function dismissActivity() {
        if (!tracked || !trackedJob || trackedJob.status === 'running') return;
        dismissedKey = trackedKey;
        refreshView();
    }

    function onPageHide() {
        suspended = true;
        attached = false;
        invalidateReads();
    }

    function onPageShow(event) {
        if (!event?.persisted) return;
        suspended = false;
        refreshView();
        if (attached) return;
        if (!bootstrapped || trackedJob?.status === 'running') readStatus();
    }

    const api = {attach, observe, detach};
    root.DakiStyleSyncActivity = api;

    if (root.document) {
        root.addEventListener?.('pagehide', onPageHide);
        root.addEventListener?.('pageshow', onPageShow);
        const bootstrap = () => {
            if (bootstrapped) return;
            bootstrapped = true;
            readStatus();
        };
        if (root.document.readyState === 'loading') {
            root.document.addEventListener?.('DOMContentLoaded', bootstrap, {once: true});
        } else {
            bootstrap();
        }
    }
})(window);
