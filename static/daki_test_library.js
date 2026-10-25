/* Named test galleries and adding recipes to an existing test. */
(function (root) {
    'use strict';
    const doc = root.document;
    const endpoint = '/api/daki/style-tests/';
    let active = null;
    let revision = 0;
    const node = (tag, className, text) => {
        const item = doc.createElement(tag);
        if (className) item.className = className;
        if (text !== undefined) item.textContent = text;
        return item;
    };
    function button(text, action, className = '') {
        const item = node('button', className, text); item.type = 'button'; item.onclick = action; return item;
    }
    async function api(url, method = 'GET', body) {
        const response = await root.fetch(url, {method, headers: {'Content-Type': 'application/json'},
            ...(body === undefined ? {} : {body: JSON.stringify(body)})});
        const result = await response.json();
        if (!response.ok || result.status !== 'success') throw new Error(result.message || '테스트를 저장하지 못했습니다. 다시 시도해 주세요.');
        return result;
    }
    function leave() {
        revision++;
        if (active?.open) active.close();
        active = null;
    }
    function dialogFor(title, className) {
        leave();
        const token = revision;
        const originalFocus = doc.activeElement;
        const dialog = active = node('dialog', `daki-dialog daki-test-library-dialog ${className}`);
        const form = node('form');
        const heading = node('h2', '', title); heading.id = 'dakiTestLibraryTitle';
        dialog.setAttribute('aria-labelledby', heading.id);
        const header = node('header', 'daki-test-library-header'); header.appendChild(heading);
        const body = node('div', 'daki-test-library-body');
        const status = node('p', 'daki-test-library-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        const footer = node('div', 'daki-dialog-actions daki-test-library-actions');
        let busy = false;
        const cancel = button('취소', () => { if (!busy) dialog.close(); }); footer.appendChild(cancel);
        form.append(header, body, status, footer); dialog.appendChild(form); doc.body.appendChild(dialog);
        dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
        dialog.addEventListener('close', () => {
            if (active === dialog) { active = null; revision++; }
            dialog.remove();
            if (originalFocus?.isConnected) originalFocus.focus({preventScroll: true});
        });
        return {dialog, form, body, status, footer, live: () => token === revision && active === dialog && dialog.open,
            isBusy: () => busy, setBusy(value) {
                busy = value;
                form.querySelectorAll('input, button').forEach(input => { input.disabled = value; });
            }};
    }
    function rename(batch, onSaved) {
        const ui = dialogFor('테스트 이름 변경', 'daki-test-rename-dialog');
        const label = node('label', 'daki-test-library-name', '테스트 이름');
        const name = node('input'); name.name = 'name'; name.type = 'text'; name.required = true; name.maxLength = 120;
        name.autocomplete = 'off'; name.value = batch.name || ''; label.appendChild(name); ui.body.appendChild(label);
        ui.body.appendChild(node('p', 'daki-test-library-note', '지정한 이름으로 저장된 테스트 갤러리에 표시됩니다.'));
        const save = button('이름 저장', null, 'daki-primary'); save.type = 'submit'; ui.footer.appendChild(save);
        ui.form.onsubmit = async event => {
            event.preventDefault();
            if (ui.isBusy()) return;
            const value = name.value.trim();
            if (!value || value.length > 120) { ui.status.textContent = '테스트 이름을 1~120자로 입력해 주세요.'; name.focus(); return; }
            ui.setBusy(true); ui.status.textContent = '이름을 저장하는 중…';
            try {
                const result = await api(endpoint + encodeURIComponent(batch.id) + '/name', 'PUT', {name: value});
                if (!ui.live()) return;
                ui.dialog.close(); onSaved?.(result.batch);
            } catch (error) { if (ui.live()) ui.status.textContent = error.message; }
            finally { if (ui.live()) ui.setBusy(false); }
        };
        ui.dialog.showModal(); name.focus({preventScroll: true});
    }
    function append(batch, onSaved) {
        const ui = dialogFor('테스트에 그림체 추가', 'daki-test-append-dialog');
        const existing = new Set((batch.items || []).map(item => item.style_id));
        const selected = new Set();
        let entries = [];
        let loading = false;
        let loadFailed = false;
        let loadRevision = 0;
        ui.body.appendChild(node('p', 'daki-test-library-note', '이미 포함된 그림체는 제외했습니다. 추가한 그림체는 대기 목록에 들어가며, 현재 테스트 설정으로 이어서 생성할 수 있습니다.'));
        const toolbar = node('div', 'daki-style-toolbar daki-test-library-search');
        const search = node('input', 'filter-select'); search.type = 'search'; search.placeholder = '그림체 이름 검색';
        search.setAttribute('aria-label', '추가할 그림체 이름 검색');
        const selectAll = button('전체 선택', () => {
            const shown = filtered();
            const remove = shown.length > 0 && shown.every(entry => selected.has(entry.style.id));
            shown.forEach(entry => remove ? selected.delete(entry.style.id) : selected.add(entry.style.id)); render();
        });
        const create = button('＋ 새 개인 그림체', () => {
            root.DakiPersonalStyles.openEditor({onSaved: style => { if (ui.live()) return reload(style.id); }});
        });
        toolbar.append(search, selectAll, create); ui.body.appendChild(toolbar);
        const count = node('p', 'daki-test-library-count'); count.setAttribute('aria-live', 'polite'); ui.body.appendChild(count);
        const list = node('div', 'daki-test-style-list'); list.setAttribute('role', 'group'); list.setAttribute('aria-label', '추가할 그림체 목록'); ui.body.appendChild(list);
        const retry = button('다시 불러오기', () => reload()); retry.hidden = true; ui.body.appendChild(retry);
        const save = button('선택한 그림체 추가', null, 'daki-primary'); save.type = 'submit'; ui.footer.appendChild(save);
        function filtered() {
            const query = search.value.trim().toLowerCase();
            return entries.filter(entry => entry.style.name.toLowerCase().includes(query));
        }
        function render() {
            const shown = filtered();
            list.replaceChildren();
            for (const entry of shown) {
                entry.checkbox.checked = selected.has(entry.style.id);
                list.appendChild(entry.card);
            }
            if (!shown.length) list.appendChild(node('p', 'daki-empty', loading ? '그림체를 불러오는 중…'
                : entries.length ? '검색한 그림체가 없습니다.' : '추가할 그림체가 없습니다. 새 개인 그림체를 등록할 수 있습니다.'));
            count.textContent = `${shown.length}개 표시 · ${selected.size}개 선택`;
            selectAll.disabled = ui.isBusy() || loading || !shown.length;
            selectAll.textContent = shown.length && shown.every(entry => selected.has(entry.style.id)) ? '표시 항목 선택 해제' : '표시 항목 전체 선택';
            save.disabled = ui.isBusy() || loading || loadFailed || !selected.size;
        }
        function cardFor(style, source) {
            const card = node('label', 'item-box daki-test-style-choice');
            const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.setAttribute('aria-label', `${style.name} 선택`);
            checkbox.onchange = () => { if (checkbox.checked) selected.add(style.id); else selected.delete(style.id); render(); };
            const preview = node('div', 'daki-test-style-preview');
            if (style.src) {
                const img = node('img'); img.src = style.src; img.alt = style.name; img.loading = 'lazy';
                img.onerror = () => { preview.textContent = '대표 그림을 찾을 수 없음'; }; preview.appendChild(img);
            } else preview.textContent = '대표 그림 없음';
            const caption = node('div', 'daki-test-style-caption');
            caption.append(node('span', 'daki-test-style-source', source), node('strong', '', style.name));
            card.append(checkbox, preview, caption); return {style, card, checkbox};
        }
        async function reload(selectId) {
            const token = ++loadRevision;
            loading = true; loadFailed = false; entries = []; retry.hidden = true; ui.status.textContent = ''; render();
            try {
                const sources = ['공유 그림체', '개인 그림체'];
                const catalogs = await Promise.allSettled([api('/api/daki/shared-styles'), api('/api/daki/personal-styles')]);
                if (!ui.live() || token !== loadRevision) return;
                const seen = new Set(existing);
                entries = catalogs.flatMap((catalog, index) => catalog.status === 'fulfilled'
                    ? catalog.value.styles.filter(style => { if (seen.has(style.id)) return false; seen.add(style.id); return true; })
                        .map(style => cardFor(style, sources[index])) : []);
                const available = new Set(entries.map(entry => entry.style.id));
                for (const id of selected) if (!available.has(id)) selected.delete(id);
                if (selectId && available.has(selectId)) { selected.add(selectId); search.value = ''; }
                const failed = catalogs.flatMap((catalog, index) => catalog.status === 'rejected'
                    ? [`${sources[index]} 목록을 불러오지 못했습니다: ${catalog.reason.message}`] : []);
                loadFailed = failed.length === catalogs.length;
                retry.hidden = !failed.length;
                if (failed.length) ui.status.textContent = failed.join(' / ') + (loadFailed ? '' : ' · 불러온 그림체는 추가할 수 있습니다.');
            } catch (error) {
                if (!ui.live() || token !== loadRevision) return;
                loadFailed = true; entries = []; selected.clear();
                ui.status.textContent = '그림체 목록을 불러오지 못했습니다: ' + error.message; retry.hidden = false;
            } finally { if (ui.live() && token === loadRevision) { loading = false; render(); } }
        }
        search.oninput = render;
        ui.form.onsubmit = async event => {
            event.preventDefault();
            if (ui.isBusy() || loading || loadFailed || !selected.size) return;
            ui.setBusy(true); ui.status.textContent = '그림체를 대기 목록에 추가하는 중…';
            try {
                const result = await api(endpoint + encodeURIComponent(batch.id) + '/styles', 'POST', {style_ids: [...selected]});
                if (!ui.live()) return;
                ui.dialog.close(); onSaved?.(result.batch);
            } catch (error) { if (ui.live()) ui.status.textContent = error.message; }
            finally { if (ui.live()) { ui.setBusy(false); render(); } }
        };
        ui.dialog.showModal(); search.focus({preventScroll: true}); reload();
    }
    root.DakiTestLibrary = {rename, append, leave};
})(typeof window === 'undefined' ? globalThis : window);
