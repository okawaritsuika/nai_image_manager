(function (root, createApi) {
    const api = createApi(root?.document, root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CanvasExportFeedback = api;
})(typeof window === 'object' && window ? window : (typeof globalThis === 'object' ? globalThis : this), function (doc, root) {
    'use strict';

    const choiceDialogId = 'canvasExportResetChoiceDialog';
    const progressDialogId = 'canvasExportFeedbackDialog';
    let choiceDialog = null;
    let choiceElements = null;
    let activeChoice = null;
    let ignoredChoiceCloseEvents = 0;
    let progressDialog = null;
    let progressElements = null;
    let activeProgress = null;
    let ignoredProgressCloseEvents = 0;

    function element(tagName, id, className, text) {
        const node = doc.createElement(tagName);
        if (id) node.id = id;
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function append(parent, child) {
        parent.appendChild(child);
        return child;
    }

    function restoreOpener(opener, closingDialog) {
        if (!opener?.isConnected || typeof opener.focus !== 'function') return;
        const otherDialogOpen = Array.from(doc.querySelectorAll?.('dialog[open]') || [])
            .some(openDialog => openDialog !== closingDialog);
        if (!otherDialogOpen) opener.focus({preventScroll: true});
    }

    function ensureChoiceDialog() {
        if (choiceDialog) return;

        choiceDialog = element('dialog', choiceDialogId, 'canvas-export-feedback-dialog canvas-export-reset-choice');
        choiceDialog.setAttribute('aria-labelledby', 'canvasExportResetChoiceTitle');
        choiceDialog.setAttribute('aria-describedby', 'canvasExportResetChoiceDescription');

        const header = append(choiceDialog, element('header', null, 'canvas-export-feedback-header'));
        append(header, element('h2', 'canvasExportResetChoiceTitle', '', '내보내기 옵션'));

        const body = append(choiceDialog, element('div', null, 'canvas-export-feedback-body'));
        append(body, element('div', 'canvasExportResetChoiceContext', 'canvas-export-feedback-context'));
        append(body, element('p', null, 'canvas-export-feedback-question', '내보낸 그림 한 장으로 캔버스를 정리하고 저장할까요?'));
        append(body, element('p', 'canvasExportResetChoiceDescription', 'canvas-export-feedback-description',
            '내보내기가 성공한 뒤 이 캔버스의 기존 레이어와 클립을 한 장의 그림으로 바꾸고 저장합니다. 다른 열린 프로젝트 캔버스에는 영향을 주지 않습니다.'));

        const footer = append(choiceDialog, element('footer', null, 'canvas-export-feedback-footer'));
        const cancelButton = append(footer, element('button', 'canvasExportResetChoiceCancel', 'secondary', '취소'));
        const exportOnlyButton = append(footer, element('button', 'canvasExportResetChoiceOnly', 'secondary', '내보내기만'));
        const mergeButton = append(footer, element('button', 'canvasExportResetChoiceMerge', 'primary', '내보내고 정리·저장'));
        for (const button of [cancelButton, exportOnlyButton, mergeButton]) button.type = 'button';

        doc.body.appendChild(choiceDialog);
        choiceElements = {context: choiceDialog.children[1].children[0], cancelButton, exportOnlyButton, mergeButton};

        cancelButton.addEventListener('click', () => finishChoice(null));
        exportOnlyButton.addEventListener('click', () => finishChoice(false));
        mergeButton.addEventListener('click', () => finishChoice(true));
        choiceDialog.addEventListener('cancel', event => {
            event.preventDefault();
            finishChoice(null);
        });
        choiceDialog.addEventListener('close', () => {
            if (ignoredChoiceCloseEvents > 0) {
                ignoredChoiceCloseEvents--;
                return;
            }
            finishChoice(null);
        });
        stopEditKeyPropagation(choiceDialog);
    }

    function ensureProgressDialog() {
        if (progressDialog) return;

        progressDialog = element('dialog', progressDialogId, 'canvas-export-feedback-dialog canvas-export-progress-dialog');
        progressDialog.setAttribute('aria-labelledby', 'canvasExportFeedbackTitle');
        progressDialog.setAttribute('aria-describedby', 'canvasExportFeedbackDescription canvasExportFeedbackStage');

        const header = append(progressDialog, element('header', null, 'canvas-export-feedback-header'));
        append(header, element('h2', 'canvasExportFeedbackTitle', '', '통합 내보내기'));

        const body = append(progressDialog, element('div', null, 'canvas-export-feedback-body'));
        append(body, element('div', 'canvasExportFeedbackContext', 'canvas-export-feedback-context'));
        append(body, element('p', 'canvasExportFeedbackDescription', 'canvas-export-feedback-description',
            '완료한 처리 단계 기준입니다. 저장 단계는 파일 크기에 따라 오래 걸릴 수 있습니다.'));
        const stage = append(body, element('div', 'canvasExportFeedbackStage', 'canvas-export-feedback-stage', '준비 중'));
        stage.setAttribute('role', 'status');
        stage.setAttribute('aria-live', 'polite');

        const progressRow = append(body, element('div', null, 'canvas-export-feedback-progress-row'));
        const progressLabel = append(progressRow, element('label', 'canvasExportFeedbackProgressLabel', '', '단계 진행률'));
        const progress = append(progressRow, element('progress', 'canvasExportFeedbackProgress'));
        progress.max = 100;
        progress.value = 0;
        progress.setAttribute('aria-labelledby', progressLabel.id);
        const percent = append(progressRow, element('span', 'canvasExportFeedbackPercent', 'canvas-export-feedback-percent', '0%'));

        append(body, element('div', 'canvasExportFeedbackElapsed', 'canvas-export-feedback-elapsed', '경과 시간: 0초'));
        const footer = append(progressDialog, element('footer', null, 'canvas-export-feedback-footer'));
        const closeButton = append(footer, element('button', 'canvasExportFeedbackClose', 'primary', '닫기'));
        closeButton.type = 'button';
        closeButton.disabled = true;

        doc.body.appendChild(progressDialog);
        progressElements = {context: body.children[0], stage, progress, percent, elapsed: body.children[4], closeButton};

        closeButton.addEventListener('click', () => {
            if (activeProgress && activeProgress.state !== 'running') closeProgress(activeProgress, true);
        });
        progressDialog.addEventListener('cancel', event => {
            event.preventDefault();
        });
        progressDialog.addEventListener('close', () => {
            if (ignoredProgressCloseEvents > 0) {
                ignoredProgressCloseEvents--;
                return;
            }
            const current = activeProgress;
            if (!current) return;
            if (current.state === 'running') {
                // Keep the canvas modal while its export is still active.
                progressDialog.showModal();
                return;
            }
            closeProgress(current, true, true);
        });
        stopEditKeyPropagation(progressDialog);
    }

    function stopEditKeyPropagation(dialog) {
        for (const type of ['keydown', 'paste', 'copy', 'cut']) {
            dialog.addEventListener(type, event => event.stopPropagation());
        }
    }

    function finishChoice(value, restoreFocus = true) {
        const choice = activeChoice;
        if (!choice) return;
        activeChoice = null;
        if (choiceDialog.open) {
            ignoredChoiceCloseEvents++;
            choiceDialog.close();
        }
        choice.resolve(value);
        if (restoreFocus) restoreOpener(choice.opener, choiceDialog);
    }

    function chooseReset(contextLabel) {
        if (!doc?.body || activeChoice) return Promise.resolve(null);
        ensureChoiceDialog();
        choiceElements.context.textContent = contextLabel == null ? '' : String(contextLabel);

        return new Promise(resolve => {
            const choice = {opener: doc.activeElement, resolve};
            activeChoice = choice;
            try {
                choiceDialog.showModal();
                choiceElements.exportOnlyButton.focus();
            } catch (error) {
                if (activeChoice === choice) activeChoice = null;
                resolve(null);
            }
        });
    }

    function elapsedSeconds(startedAt) {
        return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    }

    function formatElapsed(seconds) {
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        if (minutes === 0) return `경과 시간: ${remainingSeconds}초`;
        if (remainingSeconds === 0) return `경과 시간: ${minutes}분`;
        return `경과 시간: ${minutes}분 ${remainingSeconds}초`;
    }

    function updateElapsed(record) {
        if (activeProgress !== record || record.state !== 'running') return;
        progressElements.elapsed.textContent = formatElapsed(elapsedSeconds(record.startedAt));
    }

    function clearProgressTimer(record) {
        if (record.timer === null) return;
        const clear = typeof root?.clearInterval === 'function' ? root.clearInterval.bind(root) : clearInterval;
        clear(record.timer);
        record.timer = null;
    }

    function closeProgress(record, restoreFocus = false, fromCloseEvent = false) {
        if (!record || record.state === 'closed') return;
        clearProgressTimer(record);
        record.state = 'closed';
        if (activeProgress === record) activeProgress = null;
        if (!fromCloseEvent && progressDialog?.open) {
            ignoredProgressCloseEvents++;
            progressDialog.close();
        }
        if (restoreFocus) restoreOpener(record.opener, progressDialog);
    }

    function noOpProgressHandle() {
        return {update() {}, finish() {}, fail() {}, close() {}};
    }

    function start(contextLabel) {
        if (!doc?.body) return noOpProgressHandle();
        if (activeProgress?.state === 'running') return noOpProgressHandle();
        if (activeProgress) closeProgress(activeProgress, false);
        ensureProgressDialog();

        const now = Date.now();
        const record = {opener: doc.activeElement, startedAt: now, state: 'running', timer: null};
        activeProgress = record;
        progressElements.context.textContent = contextLabel == null ? '' : String(contextLabel);
        progressElements.stage.textContent = '준비 중';
        progressElements.progress.value = 0;
        progressElements.percent.textContent = '0%';
        progressElements.elapsed.textContent = '경과 시간: 0초';
        progressElements.closeButton.disabled = true;
        progressDialog.removeAttribute('data-state');
        progressDialog.showModal();

        const schedule = typeof root?.setInterval === 'function' ? root.setInterval.bind(root) : setInterval;
        record.timer = schedule(() => updateElapsed(record), 1000);
        return {
            update(stage, completed, total) {
                if (activeProgress !== record || record.state !== 'running') return;
                progressElements.stage.textContent = stage == null ? '' : String(stage);
                const fraction = Number.isFinite(completed) && Number.isFinite(total) && total > 0
                    ? Math.max(0, Math.min(1, completed / total))
                    : 0;
                const percent = Math.floor(fraction * 100);
                progressElements.progress.value = percent;
                progressElements.percent.textContent = `${percent}%`;
            },
            finish(message) {
                if (activeProgress !== record || record.state !== 'running') return;
                record.state = 'finished';
                clearProgressTimer(record);
                progressElements.progress.value = 100;
                progressElements.percent.textContent = '100%';
                progressElements.stage.textContent = message == null ? '내보내기 완료' : String(message);
                progressDialog.setAttribute('data-state', 'finished');
                progressElements.closeButton.disabled = false;
                progressElements.closeButton.focus();
            },
            fail(message) {
                if (activeProgress !== record || record.state !== 'running') return;
                record.state = 'failed';
                clearProgressTimer(record);
                progressElements.stage.textContent = message == null ? '내보내기에 실패했습니다.' : String(message);
                progressDialog.setAttribute('data-state', 'failed');
                progressElements.closeButton.disabled = false;
                progressElements.closeButton.focus();
            },
            close() {
                closeProgress(record, true);
            }
        };
    }

    function handlePageHide() {
        finishChoice(null, false);
        if (activeProgress) closeProgress(activeProgress, false);
    }

    root?.addEventListener?.('pagehide', handlePageHide);

    return {chooseReset, start};
});
