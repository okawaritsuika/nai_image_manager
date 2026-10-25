/* Explicitly choose or generate a tag example without changing the dictionary prompt. */
(function (root) {
    'use strict';
    const doc = root.document, catalog = '/api/daki/tag-catalog/', drafts = '/api/daki/drafts';
    let current = null, serial = 0;
    function node(tag, className, text) {
        const item = doc.createElement(tag);
        if (className) item.className = className;
        if (text !== undefined) item.textContent = text;
        return item;
    }
    function button(text, action, className = 'nav-btn') {
        const item = node('button', className, text); item.type = 'button'; item.onclick = action; return item;
    }
    async function api(url, body) {
        const response = await root.fetch(url, {method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
            headers: {'Content-Type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
        const data = await response.json();
        if (!response.ok || data.status !== 'success') {
            const error = new Error(data.message || '예시 그림을 불러오지 못했습니다.'); error.httpStatus = response.status; throw error;
        }
        return data;
    }
    function localImage(value) { return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : ''; }
    function close() {
        if (!current) return;
        const state = current;
        if (state.dialog.open) state.dialog.close();
        state.finish();
    }
    function open({tag, mode = 'existing', onSaved} = {}) {
        if (!tag?.tag || !['existing', 'generate'].includes(mode)) return null;
        close();
        const originalFocus = doc.activeElement, generating = mode === 'generate';
        const dialog = node('dialog', 'daki-dialog daki-tag-examples');
        const title = node('h2', '', generating ? '태그 예시 새로 생성' : '기존 그림에서 예시 고르기');
        title.id = 'dakiTagExamplesTitle' + (++serial); dialog.setAttribute('aria-labelledby', title.id);
        const header = node('header', 'daki-tag-examples-header'), heading = node('div');
        heading.append(title, node('p', '', `${tag.label_ko || tag.tag} · ${tag.tag}`)); header.append(heading, button('닫기', close));
        const status = node('p', 'daki-tag-examples-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        const body = node('div', 'daki-tag-examples-body');
        dialog.append(header, body, status);
        const state = {dialog, closed: false, token: 0, timer: null, editor: null, approval: null, finish: null};
        current = state;
        function live() { return current === state && !state.closed && dialog.open; }
        state.finish = () => {
            if (state.closed) return;
            state.closed = true; state.token++; root.clearTimeout(state.timer);
            state.approval?.abort(); state.editor?.dispose();
            if (current === state) current = null;
            dialog.remove();
            if (originalFocus?.isConnected) originalFocus.focus({preventScroll: true});
        };
        dialog.addEventListener('close', state.finish);
        dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
        doc.body.appendChild(dialog); dialog.showModal();
        if (generating) generation(); else existing();
        return dialog;

        function preview(parent) {
            const frame = node('section', 'daki-tag-examples-preview'); frame.setAttribute('aria-label', '선택한 예시 그림');
            const image = node('img'), caption = node('p', '', '그림을 선택하세요.'); image.hidden = true;
            frame.append(image, caption); parent.appendChild(frame);
            image.onerror = () => { image.hidden = true; caption.textContent = '그림을 불러오지 못했습니다.'; };
            return item => {
                image.hidden = !item;
                if (item) image.src = localImage(item.src); else image.removeAttribute('src');
                image.alt = item?.name || (tag.label_ko || tag.tag) + ' 예시';
                caption.textContent = item?.name || (item ? '결과를 확인한 뒤 예시로 추가하세요.' : '그림을 선택하세요.');
            };
        }
        async function save(path, setBusy) {
            if (!live() || !path) return;
            setBusy(true); status.textContent = '예시를 추가하는 중…';
            try {
                const result = await api(catalog + 'examples', {tag: tag.tag, path});
                if (live()) onSaved?.(result);
                if (live()) close();
            } catch (error) { if (live()) status.textContent = error.message; }
            finally { if (live()) setBusy(false); }
        }
        function existing() {
            let page = 1, pages = 1, selected = null, busy = false, loading = false;
            body.appendChild(node('p', 'daki-tag-examples-hint', '이 태그가 포함된 기존 그림에서 예시를 선택하세요.'));
            const layout = node('div', 'daki-tag-examples-selection'), column = node('section');
            const count = node('p'), grid = node('div', 'daki-tag-examples-grid'); grid.setAttribute('aria-label', '태그가 포함된 그림');
            const controls = node('div', 'daki-tag-examples-pages'), pageLabel = node('span');
            const previous = button('이전', () => load(page - 1)), next = button('다음', () => load(page + 1));
            previous.setAttribute('aria-label', '이전 그림 페이지'); next.setAttribute('aria-label', '다음 그림 페이지');
            controls.append(previous, pageLabel, next); column.append(count, grid, controls); layout.appendChild(column);
            const showPreview = preview(layout); body.appendChild(layout);
            const actions = node('footer', 'daki-tag-examples-actions');
            const reload = button('다시 불러오기', () => load(page)); reload.hidden = true;
            const add = button('예시로 추가', () => { if (!busy && !loading) return save(selected?.path, value => { busy = value; sync(); }); }, 'nav-btn daki-primary');
            actions.append(reload, add); body.appendChild(actions);
            function sync() {
                add.disabled = busy || loading || !selected;
                previous.disabled = busy || loading || page <= 1; next.disabled = busy || loading || page >= pages;
                reload.disabled = busy || loading;
                for (const card of grid.children) card.disabled = busy || loading;
            }
            async function load(nextPage) {
                if (!live() || busy || loading) return;
                const token = ++state.token; loading = true; selected = null; showPreview(null); grid.replaceChildren(); sync();
                count.textContent = '태그가 포함된 그림을 찾는 중…'; status.textContent = ''; reload.hidden = true;
                try {
                    const result = await api(catalog + 'candidates?' + new URLSearchParams({tag: tag.tag, page: nextPage}));
                    if (!live() || token !== state.token) return;
                    page = result.page; pages = result.pages; count.textContent = `${result.total.toLocaleString()}장`; pageLabel.textContent = `${page} / ${pages}`;
                    for (const item of result.items) {
                        const card = button('', () => {
                            if (busy || loading) return;
                            selected = item; showPreview(item);
                            for (const choice of grid.children) choice.setAttribute('aria-pressed', String(choice === card));
                            sync();
                        }, 'daki-tag-examples-card');
                        card.setAttribute('aria-label', item.name || '예시 후보'); card.setAttribute('aria-pressed', 'false');
                        const image = node('img'); image.src = localImage(item.src); image.alt = item.name || ''; image.loading = 'lazy';
                        image.onerror = () => { image.hidden = true; card.appendChild(node('span', '', '미리보기 없음')); };
                        card.append(image, node('span', '', item.name || '예시 후보')); grid.appendChild(card);
                    }
                    if (!result.items.length) grid.appendChild(node('p', '', '이 태그가 포함된 그림이 없습니다. 새 예시를 생성할 수 있습니다.'));
                } catch (error) {
                    if (live() && token === state.token) { status.textContent = error.message; count.textContent = '그림을 찾지 못했습니다.'; reload.hidden = false; }
                } finally { if (live() && token === state.token) { loading = false; sync(); } }
            }
            load(1);
        }
        async function generation() {
            let record = null, busy = false, uncertain = false;
            body.appendChild(node('p', 'daki-tag-examples-hint', '프롬프트를 직접 입력하거나 그림체를 골라 한 장 생성하세요. 결과를 확인하고 예시로 추가할 수 있습니다.'));
            const layout = node('div', 'daki-tag-examples-generation'), form = node('form'); form.noValidate = true;
            const fields = node('fieldset', 'daki-tag-examples-fields'); fields.disabled = true;
            fields.appendChild(node('p', '', '생성 설정을 불러오는 중…')); form.appendChild(fields); layout.appendChild(form);
            const resultPanel = node('section', 'daki-tag-examples-result'), showPreview = preview(resultPanel);
            const resultStatus = node('p'); resultPanel.appendChild(resultStatus);
            const add = button('예시로 추가', () => { if (!busy && record?.status === 'completed') return save(record.path, value => { busy = value; sync(); }); }, 'nav-btn daki-primary');
            const retry = button('실패한 그림 다시 생성', () => { if (!busy && record?.status === 'failed') return generate(true); }); retry.hidden = true;
            const reload = button('결과 다시 확인', () => refresh()); reload.hidden = true;
            resultPanel.append(add, retry, reload); layout.appendChild(resultPanel); body.appendChild(layout);
            const actions = node('div', 'daki-tag-examples-actions'), create = node('button', 'nav-btn daki-primary', '예시 한 장 생성'); create.type = 'submit';
            actions.appendChild(create); form.appendChild(actions);
            const note = node('p', 'daki-tag-examples-hint', '태그 예시용 그림은 시안 폴더와 별도로 보관됩니다. 창을 닫아도 생성은 계속되며, 생성 기록에서 결과를 다시 확인하고 예시로 추가할 수 있습니다.');
            const historyTools = node('div', 'daki-tag-examples-actions');
            const history = node('select'); history.hidden = true; history.setAttribute('aria-label', '태그 예시 생성 기록');
            const historyLoad = button('생성 기록 불러오기', loadHistory);
            let historyRecords = [];
            historyTools.append(historyLoad, history); body.append(note, historyTools);
            const running = () => ['pending', 'running'].includes(record?.status);
            function sync() {
                const disabled = busy || running() || uncertain;
                fields.disabled = disabled || !state.editor; create.disabled = disabled || !state.editor;
                create.textContent = running() ? '그림 생성 중…' : busy ? '요청하는 중…' : '예시 한 장 생성';
                add.disabled = busy || record?.status !== 'completed'; retry.disabled = disabled; reload.disabled = busy;
                retry.hidden = record?.status !== 'failed';
                historyLoad.disabled = history.disabled = busy || running();
            }
            async function loadHistory() {
                if (!live() || busy || running()) return;
                busy = true; const token = ++state.token; sync();
                status.textContent = '태그 예시 생성 기록을 불러오는 중…';
                try {
                    const data = await api(drafts + '?purpose=tag_example');
                    if (!live() || token !== state.token) return;
                    historyRecords = data.drafts;
                    history.replaceChildren();
                    const placeholder = node('option', '', '생성한 태그 예시 선택'); placeholder.value = ''; history.appendChild(placeholder);
                    for (const item of historyRecords) {
                        const date = new Date(item.created_at);
                        const time = Number.isNaN(date.getTime()) ? item.id.slice(0, 8) : date.toLocaleString('ko-KR');
                        const label = ({completed: '완료', failed: '실패', running: '생성 중'})[item.status] || item.status;
                        const option = node('option', '', `${time} · ${label} · ${item.width} × ${item.height}`);
                        option.value = item.id; history.appendChild(option);
                    }
                    history.value = ''; history.hidden = !historyRecords.length;
                    uncertain = false;
                    status.textContent = historyRecords.length ? '기록을 선택하면 오른쪽에서 결과를 확인할 수 있습니다.' : '별도로 저장한 태그 예시 생성 기록이 없습니다.';
                } catch (error) { if (live() && token === state.token) status.textContent = error.message; }
                finally { busy = false; if (live()) sync(); }
            }
            history.onchange = () => {
                if (!live() || busy || running()) return;
                const item = historyRecords.find(value => value.id === history.value);
                if (!item) return;
                state.token++; root.clearTimeout(state.timer);
                update(item); status.textContent = ''; schedule();
            };
            function update(value) {
                record = value;
                if (record.status === 'completed') {
                    showPreview({src: drafts + '/' + encodeURIComponent(record.id) + '/image?full=1'});
                    resultStatus.textContent = `${record.width} × ${record.height} · 생성 완료`;
                    root.NovelAIAccount?.refresh(true);
                } else {
                    showPreview(null);
                    resultStatus.textContent = record.status === 'failed' ? record.error || '생성에 실패했습니다.' : '그림을 생성하는 중…';
                    if (record.status === 'failed') root.NovelAIAccount?.refresh(true);
                }
                sync();
            }
            function schedule() {
                root.clearTimeout(state.timer);
                if (live() && running()) state.timer = root.setTimeout(refresh, 1000);
            }
            async function refresh() {
                if (!live() || busy || !record) return;
                const token = ++state.token, id = record.id;
                reload.hidden = true;
                try {
                    const data = await api(drafts + '/' + encodeURIComponent(id));
                    if (!live() || token !== state.token) return;
                    if (data.draft.id !== id) throw new Error('생성 결과가 일치하지 않습니다. 다시 확인해 주세요.');
                    update(data.draft); status.textContent = ''; schedule();
                } catch (error) { if (live() && token === state.token) { status.textContent = error.message; reload.hidden = false; } }
            }
            async function generate(retrying = false) {
                if (!live() || busy || running() || uncertain || !state.editor) return;
                const settings = retrying ? record?.settings : state.editor.read(); if (!settings) return;
                const snapshot = JSON.parse(JSON.stringify(settings));
                const steps = snapshot.model === 'nai-diffusion-5-full-medium' ? 14 : snapshot.options?.steps ?? 28;
                const body = retrying ? {allow_anlas: false} : {...snapshot, purpose: 'tag_example', allow_anlas: false};
                const url = retrying ? drafts + '/' + encodeURIComponent(record.id) + '/retry' : drafts;
                let sent = false; busy = true; state.token++; root.clearTimeout(state.timer); sync();
                try {
                    if (root.requiresAnlasCost(snapshot.width, snapshot.height, steps)) {
                        status.textContent = 'Anlas 사용을 확인해 주세요.';
                        state.approval = new root.AbortController();
                        const approved = await root.showAnlasWarningModal({width: snapshot.width, height: snapshot.height, steps,
                            title: '태그 예시 생성 Anlas 사용 경고', detail: '현재 설정으로 예시 한 장을 생성합니다. Anlas가 소모될 수 있습니다.',
                            parent: dialog, signal: state.approval.signal});
                        state.approval = null;
                        if (!live()) return;
                        if (!approved) { status.textContent = '생성을 취소했습니다.'; return; }
                        body.allow_anlas = true;
                    }
                    status.textContent = '생성을 요청하는 중…'; sent = true;
                    const data = await api(url, body);
                    if (!live()) return;
                    update(data.draft); reload.hidden = true;
                    status.textContent = data.draft.status === 'completed' ? '그림을 확인한 뒤 예시로 추가하세요.' : '생성이 끝나면 결과가 표시됩니다.';
                } catch (error) {
                    if (live()) {
                        uncertain = sent && !error.httpStatus;
                        status.textContent = uncertain ? '요청 결과를 확인하지 못했습니다. 생성 기록을 불러와 생성 여부를 확인해 주세요.' : error.message;
                    }
                } finally {
                    busy = false;
                    // Refresh any surrounding view; ordinary folders exclude tag examples.
                    if (sent) root.dispatchEvent?.(new root.Event('daki-drafts-changed'));
                    if (live()) { sync(); schedule(); }
                }
            }
            form.onsubmit = event => { event.preventDefault(); return generate(); }; sync();
            try {
                const editor = await root.DakiDraftEditor.create({settings: {prompt: tag.tag}, tagBrowserEnabled: false});
                if (!live()) { editor.dispose(); return; }
                state.editor = editor; fields.replaceChildren(editor.element); sync();
            } catch (error) { if (live()) { fields.replaceChildren(node('p', '', '생성 설정을 불러오지 못했습니다.')); status.textContent = error.message; } }
        }
    }
    root.DakiTagExamples = {open, close};
})(window);
