/* A tournament only consumes the tagged images supplied by its gallery. */
(function (root) {
    'use strict';
    function taggedImages(images, getTag, tagId = '') {
        const seen = new Set();
        return images.filter(image => {
            if (!image.path || !image.src || seen.has(image.path)) return false;
            seen.add(image.path);
            const tag = getTag(image.path);
            return !!tag && tag !== 'NONE' && (!tagId || tag === tagId);
        });
    }
    function tournament(images, random = Math.random) {
        if (images.length < 2) throw new Error('태그가 붙은 그림이 두 장 이상 필요합니다.');
        let round = [...images];
        for (let i = round.length - 1; i > 0; i--) {
            const j = Math.floor(random() * (i + 1));
            [round[i], round[j]] = [round[j], round[i]];
        }
        const initial = [...round], choices = [];
        let winners = [], index = 0, roundNumber = 1;
        const history = [];
        function state() {
            return {pair: round.length > 1 ? round.slice(index, index + 2) : [],
                winner: round.length === 1 ? round[0] : null,
                round: roundNumber, remaining: round.length, match: index / 2 + 1,
                matches: Math.floor(round.length / 2), canUndo: !!history.length};
        }
        function choose(side) {
            if (round.length < 2 || ![0, 1].includes(side) || !round[index + side]) return state();
            history.push({round: [...round], winners: [...winners], index, roundNumber});
            choices.push(round[index + side].path);
            winners.push(round[index + side]); index += 2;
            if (index >= round.length - 1) {
                if (index === round.length - 1) winners.push(round[index]);
                round = winners; winners = []; index = 0; roundNumber++;
            }
            return state();
        }
        function undo() {
            const previous = history.pop();
            if (previous) { ({round, winners, index, roundNumber} = previous); choices.pop(); }
            return state();
        }
        function snapshot() {
            return {participants: initial.map(image => ({path: image.path, name: image.name})), choices: [...choices]};
        }
        return {state, choose, undo, snapshot};
    }
    let dialog, previewDialog, revision = 0;
    const endpoint = '/api/daki/worldcups';
    const baseHash = '#daki&library=worldcups';
    function node(tag, className, text) {
        const el = root.document.createElement(tag); if (className) el.className = className;
        if (text !== undefined) el.textContent = text; return el;
    }
    function button(text, fn) { const el = node('button', '', text); el.type = 'button'; el.onclick = fn; return el; }
    async function api(url, method = 'GET', body) {
        const response = await root.fetch(url, {method, headers: {'Content-Type': 'application/json'},
            ...(body === undefined ? {} : {body: JSON.stringify(body)})});
        const result = await response.json();
        if (!response.ok || result.status !== 'success') throw new Error(result.message || '월드컵 기록을 처리하지 못했습니다.');
        return result;
    }
    function newId() {
        if (root.crypto.randomUUID) return root.crypto.randomUUID().replaceAll('-', '');
        return [...root.crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
    }
    function historyHref(galleryKey) { return baseHash + (galleryKey ? '&gallery_key=' + encodeURIComponent(galleryKey) : ''); }
    function resultHref(id) { return baseHash + '&result=' + encodeURIComponent(id); }
    function fullSrc(src) { return src + (src.includes('?') ? '&' : '?') + 'full=1'; }
    function preview(image) {
        const viewer = previewDialog = node('dialog', 'daki-dialog daki-worldcup-preview');
        const full = node('img'); full.src = fullSrc(image.src); full.alt = image.name;
        const missing = node('p', 'daki-worldcup-missing', '원본 그림을 찾을 수 없습니다. 기록에는 참가 그림과 순위가 보관됩니다.'); missing.hidden = true;
        full.onerror = () => { full.hidden = true; missing.hidden = false; };
        viewer.append(button('닫기', () => viewer.close()), full, missing);
        viewer.addEventListener('close', () => { viewer.remove(); if (previewDialog === viewer) previewDialog = null; }, {once: true});
        root.document.body.appendChild(viewer); viewer.showModal();
    }
    function leave() {
        revision++;
        if (previewDialog?.open) previewDialog.close(); if (dialog?.open) dialog.close();
    }
    function open(images, title, galleryKey = '') { return openTournament(images, title, galleryKey); }
    function replay(record) {
        const byPath = new Map(record.participants.map(image => [image.path, image]));
        const entries = (record.initial_participants || record.participants).map(image => ({...image,
            src: byPath.get(image.path)?.src || '/image/' + image.path.split('/').map(encodeURIComponent).join('/')}));
        return openTournament(entries, record.title, record.gallery_key || '', record);
    }
    function openTournament(images, title, galleryKey, replayRecord = null) {
        leave();
        const doc = root.document;
        const previousFocus = doc.activeElement;
        const modal = dialog = node('dialog', 'daki-dialog daki-worldcup');
        modal.setAttribute('aria-labelledby', 'dakiWorldCupTitle');
        const header = node('header', 'daki-worldcup-header');
        const identity = node('div');
        const heading = node('h2', '', '태그 그림 이상형 월드컵'); heading.id = 'dakiWorldCupTitle';
        identity.append(heading, node('p', '', title));
        const closeButton = button('닫기', requestClose);
        header.append(identity, closeButton); modal.appendChild(header);
        const setup = node('section', 'daki-worldcup-setup');
        const label = node('p', '', '참가할 태그를 선택하세요.');
        const choices = node('div', 'daki-tag-choices'); choices.setAttribute('aria-label', '월드컵 참가 태그');
        const state = root.getGalleryTagState?.();
        let selectedTag = '';
        let selectedLabel = '';
        for (const [index, tag] of (state?.definitions || []).entries()) {
            const name = tag.type === 'text' ? tag.value : `그림 태그 ${index + 1}`;
            const choice = button(name, () => {
                selectedTag = tag.id;
                selectedLabel = name;
                [...choices.children].forEach(item => item.setAttribute('aria-pressed', String(item === choice)));
                refresh();
            });
            choice.className = 'gallery-tag-filter-chip';
            choice.setAttribute('aria-label', name); choice.setAttribute('aria-pressed', 'false');
            if (root.renderGalleryTagIcon) choice.innerHTML = root.renderGalleryTagIcon(tag);
            choices.appendChild(choice);
        }
        const count = node('p'); count.setAttribute('role', 'status');
        const start = button('월드컵 시작', begin); start.className = 'daki-primary';
        setup.append(label, choices, count, start); modal.appendChild(setup);
        const stage = node('section', 'daki-worldcup-stage'); stage.hidden = true; modal.appendChild(stage);
        const progress = node('p', 'daki-worldcup-progress'); progress.setAttribute('role', 'status');
        const pair = node('div', 'daki-worldcup-pair');
        const actions = node('div', 'daki-worldcup-actions');
        const undo = button('이전 선택 되돌리기', () => { if (!game.state().winner) show(game.undo()); });
        const restart = button('다시 시작', () => {
            if (game.state().winner) {
                if (run.record) beginRun(run.entries, run.tag, run.record.id);
            } else if (replayRecord) beginRun(images, replayRecord.tag, replayRecord.id);
            else { stage.hidden = true; setup.hidden = false; refresh(); start.focus(); }
        });
        const savedStatus = node('p', 'daki-worldcup-save-status'); savedStatus.setAttribute('role', 'status'); savedStatus.setAttribute('aria-live', 'polite');
        const saveActions = node('div', 'daki-worldcup-save-actions');
        const retrySave = button('저장 다시 시도', () => saveResult(run)); retrySave.hidden = true;
        const resultLink = node('a', 'nav-btn', '저장된 순위 보기'); resultLink.hidden = true; resultLink.onclick = requestClose;
        const historyLink = node('a', 'nav-btn', '월드컵 기록'); historyLink.href = historyHref(galleryKey); historyLink.onclick = requestClose;
        const completedNote = node('p', 'daki-worldcup-completed-note', '완료한 결과는 저장됩니다. 같은 그림으로 다시 진행하면 새 기록을 만듭니다.'); completedNote.hidden = true;
        saveActions.append(retrySave, resultLink, historyLink);
        actions.append(undo, restart); stage.append(progress, pair, actions, savedStatus, saveActions, completedNote);
        let game, run;
        function requestClose(event) {
            if (run?.saving || run?.payload && !run.record && !root.confirm('이번 월드컵 결과가 아직 저장되지 않았습니다. 지금 닫으면 결과를 잃게 됩니다. 저장하지 않고 닫으시겠습니까?')) {
                event?.preventDefault(); return false;
            }
            modal.close(); return true;
        }
        const getTag = path => root.getGalleryImageTagId?.(path);
        function candidates() { return selectedTag ? taggedImages(images, getTag, selectedTag) : []; }
        function refresh() {
            const length = candidates().length;
            count.textContent = selectedTag ? `${length}장 참가 · 선택한 태그의 그림만 참가합니다.` : '위에서 참가할 태그를 선택하세요.';
            start.disabled = length < 2;
            if (selectedTag && length < 2) count.textContent += ' 두 장 이상에 태그를 붙여 주세요.';
        }
        function begin() {
            const entries = candidates(); if (entries.length < 2) { refresh(); return; }
            beginRun(entries, {id: selectedTag, label: selectedLabel});
        }
        function beginRun(entries, tag, replayOf) {
            game = tournament(entries);
            run = {id: newId(), entries: entries.map(image => ({...image})), tag: {...tag}, replayOf,
                payload: null, saving: false, record: null, error: ''};
            setup.hidden = true; stage.hidden = false; show(game.state());
        }
        function showSave(target) {
            if (!modal.open || run !== target) return;
            savedStatus.textContent = target.saving ? '월드컵 결과를 저장하는 중… 저장 후 닫을 수 있습니다.'
                : target.record ? '월드컵 결과와 전체 순위를 저장했습니다.' : target.error ? '저장 실패: ' + target.error : '';
            closeButton.disabled = target.saving;
            historyLink.hidden = target.saving;
            retrySave.hidden = !target.error; retrySave.disabled = target.saving;
            resultLink.hidden = !target.record;
            if (target.record) resultLink.href = resultHref(target.record.id);
            restart.disabled = !!game.state().winner && !target.record;
        }
        async function saveResult(target) {
            if (!target?.payload || target.saving || target.record) return;
            target.saving = true; target.error = ''; showSave(target);
            try {
                const {record} = await api(endpoint, 'POST', target.payload);
                target.record = record;
                root.dispatchEvent?.(new root.CustomEvent('daki-worldcups-updated', {detail: {record}}));
            } catch (error) { target.error = error.message; }
            finally { target.saving = false; showSave(target); }
        }
        function show(value) {
            undo.disabled = !value.canUndo || !!value.winner;
            restart.textContent = value.winner ? '같은 그림으로 다시하기' : '다시 시작';
            restart.disabled = false;
            savedStatus.textContent = ''; retrySave.hidden = resultLink.hidden = true; completedNote.hidden = !value.winner;
            progress.textContent = value.winner ? '우승 그림체' : `${value.remaining === 2 ? '결승' : value.remaining + '강'} · ${value.match}/${value.matches} 경기 · 마음에 드는 그림을 선택하세요.`;
            pair.replaceChildren(); pair.classList.toggle('daki-worldcup-winner', !!value.winner);
            const entries = value.winner ? [value.winner] : value.pair;
            entries.forEach((image, side) => {
                const entry = node('article', 'daki-worldcup-entry');
                const choose = button('', () => { if (!value.winner) show(game.choose(side)); });
                choose.className = 'daki-worldcup-choice'; choose.disabled = !!value.winner;
                choose.setAttribute('aria-label', value.winner ? '우승: ' + image.name : image.name + ' 선택');
                const img = node('img'); img.src = image.src + (image.src.includes('?') ? '&' : '?') + 'full=1'; img.alt = image.name;
                const missing = node('span', 'daki-worldcup-missing', '원본 그림을 찾을 수 없음'); missing.hidden = true;
                img.onerror = () => { img.hidden = true; missing.hidden = false; };
                choose.append(img, missing, node('strong', '', image.name));
                const zoom = button('크게 보기', () => preview(image));
                entry.append(choose, zoom); pair.appendChild(entry);
            });
            if (value.winner) {
                if (!run.payload) run.payload = {id: run.id, title, gallery_key: galleryKey,
                    tag: {...run.tag}, ...game.snapshot(), ...(run.replayOf ? {replay_of: run.replayOf} : {})};
                saveResult(run); showSave(run);
            }
            pair.querySelector('button:not(:disabled)')?.focus({preventScroll: true});
        }
        root.addEventListener?.('gallery-tags-updated', refresh);
        modal.addEventListener('cancel', event => { event.preventDefault(); requestClose(); });
        modal.addEventListener('close', () => {
            if (previewDialog?.open) previewDialog.close();
            root.removeEventListener?.('gallery-tags-updated', refresh);
            modal.remove(); if (dialog === modal) dialog = null;
            if (previousFocus?.isConnected) previousFocus.focus({preventScroll: true});
        }, {once: true});
        doc.body.appendChild(modal); refresh(); modal.showModal();
        if (replayRecord) beginRun(images, replayRecord.tag, replayRecord.id);
        else choices.querySelector('button')?.focus();
        return modal;
    }
    function heading(title, subtitle, href, label) {
        const doc = root.document;
        doc.getElementById('dakiTitle').textContent = title;
        doc.getElementById('dakiSubtitle').textContent = subtitle;
        const back = doc.getElementById('dakiBack'); back.hidden = false; back.href = href; back.textContent = label;
    }
    function dateLabel(value) {
        const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('ko-KR');
    }
    function resultCard(image, tied) {
        const card = node('article', 'item-box daki-worldcup-rank-card');
        const img = node('img', 'zoomable'); img.src = image.src; img.alt = image.name; img.loading = 'lazy';
        img.tabIndex = 0; img.setAttribute('role', 'button'); img.setAttribute('aria-label', image.name + ' 크게 보기');
        const missing = node('div', 'daki-worldcup-missing daki-worldcup-missing-card', '원본 그림을 찾을 수 없음'); missing.hidden = true;
        img.onerror = () => { img.hidden = true; missing.hidden = false; };
        card.append(img, missing);
        root.Daki.bindImage(card, img, image.path);
        const label = node('div', 'gallery-card-actions daki-image-actions');
        label.append(node('strong', '', image.name), node('span', 'daki-worldcup-rank', `${tied ? '공동 ' : ''}${image.rank}위`),
            node('span', 'daki-worldcup-wins', `${image.wins}승`)); card.appendChild(label);
        return card;
    }
    async function render(params, container) {
        leave();
        const token = revision;
        const current = () => token === revision && root.Daki.isActive();
        const status = root.document.getElementById('dakiPageStatus');
        const galleryKey = params.get('gallery_key') || '';
        const id = params.get('result');
        heading('이상형 월드컵 기록', '완료한 대회와 참가 그림의 순위를 확인하세요.', '#daki', '← daki 프로젝트');
        status.textContent = '월드컵 기록을 불러오는 중…';
        try {
            if (id) {
                const {record} = await api(endpoint + '/' + encodeURIComponent(id));
                if (!current()) return;
                heading(record.title + ' · 순위', `${record.total}장 · ${record.tag.label} · ${dateLabel(record.created_at)}`,
                    historyHref(record.gallery_key), '← 월드컵 기록');
                const controls = node('div', 'daki-style-toolbar');
                const again = button('같은 그림으로 다시하기', () => replay(record)); again.className = 'nav-btn'; controls.appendChild(again);
                container.append(controls, node('p', 'daki-test-note', '같은 단계에서 탈락한 그림은 공동 순위입니다. 다시하기는 저장된 참가 그림과 태그로 새 대회를 만듭니다.'));
                const ranks = new Map(); record.participants.forEach(image => ranks.set(image.rank, (ranks.get(image.rank) || 0) + 1));
                container.appendChild(root.Daki.createGrid('daki-worldcup-rank-grid', record.participants.map(image => resultCard(image, ranks.get(image.rank) > 1))));
            } else {
                const {records} = await api(endpoint + (galleryKey ? '?gallery_key=' + encodeURIComponent(galleryKey) : ''));
                if (!current()) return;
                heading('이상형 월드컵 기록', `${records.length}개 대회${galleryKey ? ' · 현재 갤러리' : ''}`, '#daki', '← daki 프로젝트');
                const cards = records.map(record => root.Daki.folderCard(record.title, resultHref(record.id), record.total,
                    `${record.tag.label} · ${dateLabel(record.created_at)}`, record.winner?.src));
                if (cards.length) container.appendChild(root.Daki.createGrid('daki-worldcup-record-grid', cards, false));
                else container.appendChild(node('p', 'daki-empty', '저장된 월드컵이 없습니다. 갤러리에서 태그를 고르고 월드컵을 완료해 보세요.'));
            }
            status.textContent = '';
        } catch (error) {
            if (!current()) return;
            status.textContent = error.message;
            const retry = button('다시 불러오기', () => { container.replaceChildren(); return render(params, container); }); retry.className = 'nav-btn';
            container.appendChild(retry);
        }
    }
    root.DakiWorldCup = {open, leave, render, taggedImages, tournament};
})(typeof window === 'undefined' ? globalThis : window);
