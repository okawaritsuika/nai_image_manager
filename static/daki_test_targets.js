/* Choose active style IDs using existing gallery tags or saved tournament ranks. */
(function (root) {
    'use strict';
    function create({catalog, onChange}) {
        const doc = root.document;
        const styles = catalog.styles;
        const library = catalog.library || 'shared';
        const activeIds = new Set(styles.map(style => style.id));
        const node = (tag, className, text) => {
            const item = doc.createElement(tag);
            if (className) item.className = className;
            if (text !== undefined) item.textContent = text;
            return item;
        };
        const element = node('section', 'daki-test-settings-section daki-test-targets');
        const heading = node('div', 'daki-test-section-heading');
        heading.append(node('h3', '', '생성 대상'), node('p', '', '현재 그림체 목록에서 조건에 맞는 그림체만 새 테스트로 만듭니다.'));
        element.appendChild(heading);
        const controls = node('div', 'daki-test-target-controls'); element.appendChild(controls);
        function field(parent, name, label, tag = 'select') {
            const wrapper = node('label', '', label), input = node(tag);
            input.name = name; input.setAttribute('aria-label', label); wrapper.appendChild(input); parent.appendChild(wrapper);
            return input;
        }
        function option(select, value, label) { const item = node('option', '', label); item.value = value; select.appendChild(item); }
        const modeRow = node('div', 'daki-test-target-mode-row'); controls.appendChild(modeRow);
        const modeInput = field(modeRow, 'daki_target_mode', '대상 선택');
        [['all', '전체 그림체'], ['tag', '태그 붙은 그림체'], ['worldcup', '월드컵 순위로 선택'], ['manual', '갤러리에서 선택']]
            .forEach(([value, label]) => option(modeInput, value, label));
        const galleryButton = node('button', 'nav-btn', '갤러리에서 선택');
        galleryButton.type = 'button'; galleryButton.classList?.add?.('daki-test-target-gallery-open');
        modeRow.appendChild(galleryButton);
        const tagPanel = node('div', 'daki-test-target-panel'); controls.appendChild(tagPanel);
        const sourceInput = field(tagPanel, 'daki_target_source', '태그 기준 그림');
        option(sourceInput, 'representative', '대표 그림'); option(sourceInput, 'test', '기존 테스트 그림');
        const testPanel = node('div', 'daki-test-target-test'); tagPanel.appendChild(testPanel);
        const testInput = field(testPanel, 'daki_target_test', '기준 테스트');
        const tagField = node('div', 'daki-test-target-tag-field');
        const tagChoices = node('div', 'daki-test-target-tags');
        tagChoices.setAttribute('role', 'group'); tagChoices.setAttribute('aria-label', '사용할 태그');
        tagField.append(node('span', 'daki-test-target-tag-label', '사용할 태그'), tagChoices); tagPanel.appendChild(tagField);
        const cupPanel = node('div', 'daki-test-target-panel'); controls.appendChild(cupPanel);
        const cupInput = field(cupPanel, 'daki_target_worldcup', '기준 월드컵 기록');
        const rankInput = field(cupPanel, 'daki_target_rank', '몇 위까지', 'input');
        Object.assign(rankInput, {type: 'number', min: 1, max: 10000, step: 1, value: '1'});
        cupPanel.appendChild(node('p', 'daki-test-target-note', '공동 순위는 모두 포함합니다. 현재 목록에서 삭제된 그림체는 제외합니다.'));
        const count = node('p', 'daki-test-target-count'); element.appendChild(count);
        const status = node('p', 'daki-test-target-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); element.appendChild(status);
        const retry = node('button', '', '목록 다시 불러오기'); retry.type = 'button'; retry.hidden = true; element.appendChild(retry);
        let disposed = false, mode = 'all', source = 'representative', selectedTag = 'tagged', selectedTest = '', selectedCup = '';
        let selectedStyleIds = [], activePicker = null, manualCatalog = null;
        const state = () => ({status: 'idle', data: null, error: '', token: 0, id: ''});
        const lists = {tests: state(), cups: state()}, details = {tests: state(), cups: state()};
        const urls = {tests: '/api/daki/style-tests', cups: '/api/daki/worldcups'};
        const labels = {tests: '기존 테스트', cups: '월드컵 기록'};
        const failed = error => ({styleIds: [], count: 0, error});
        function relevantRecord(record) {
            const key = String(record.gallery_key || '');
            return key.startsWith('test:') || (library === 'personal' ? key === 'personal' : key.startsWith('shared:'));
        }
        function styleFromPath(path) {
            if (typeof path !== 'string') return '';
            const shared = path.match(/^__daki_shared__\/([A-Za-z0-9_-]{1,128})\.png$/);
            const personal = path.match(/^__daki_personal__\/(personal_[a-f0-9]{32})\.png$/);
            const test = path.match(/^__daki_tests__\/[a-f0-9]{32}\/([A-Za-z0-9_-]{1,128})\.png$/);
            return [shared, personal, test].find(match => match?.[0] === path)?.[1] || '';
        }
        function uniqueCurrent(ids) { return [...new Set(ids.filter(id => activeIds.has(id)))]; }
        function selectedDetail(kind, id) {
            const list = lists[kind], detail = details[kind];
            const object = labels[kind] + (kind === 'tests' ? '를' : '을');
            if (list.status === 'idle' || list.status === 'loading') return {error: `${labels[kind]} 목록을 불러오는 중입니다.`};
            if (list.status === 'error') return {error: list.error};
            if (!list.data.length) return {error: kind === 'tests' ? '저장된 테스트가 없습니다.' : '현재 그림체에 사용할 월드컵 기록이 없습니다.'};
            if (!id) return {error: `${object} 선택해 주세요.`};
            if (!list.data.some(item => item.id === id)) return {error: `선택한 ${object} 찾을 수 없습니다. 다시 선택해 주세요.`};
            if (detail.id !== id || detail.status === 'idle' || detail.status === 'loading') return {error: `${labels[kind]}의 그림 정보를 불러오는 중입니다.`};
            if (detail.status === 'error') return {error: detail.error};
            return {value: detail.data};
        }
        function selection() {
            if (mode === 'all') return {styleIds: null, count: styles.length, error: ''};
            if (mode === 'manual') {
                const ids = uniqueCurrent(selectedStyleIds);
                return ids.length ? {styleIds: ids, count: ids.length, error: ''}
                    : failed('갤러리에서 테스트할 그림체를 하나 이상 선택해 주세요.');
            }
            let ids;
            if (mode === 'tag') {
                const definitions = root.getGalleryTagState?.().definitions || [];
                if (selectedTag !== 'tagged' && !definitions.some(tag => String(tag.id) === selectedTag.slice(4))) return failed('선택한 태그가 없어졌습니다. 태그를 다시 선택해 주세요.');
                let candidates;
                if (source === 'test') {
                    const result = selectedDetail('tests', selectedTest);
                    if (result.error) return failed(result.error);
                    candidates = result.value.items.filter(item => item.status === 'completed' && item.src)
                        .map(item => ({id: item.style_id, path: `__daki_tests__/${selectedTest}/${item.style_id}.png`}));
                } else candidates = styles.filter(style => library !== 'personal' || style.source_path)
                    .map(style => ({id: style.id, path: `__daki_${library === 'personal' ? 'personal' : 'shared'}__/${style.id}.png`}));
                ids = uniqueCurrent(candidates.filter(item => {
                    const tag = root.getGalleryImageTagId?.(item.path);
                    return selectedTag === 'tagged' ? !!tag && tag !== 'NONE' : String(tag || '') === selectedTag.slice(4);
                }).map(item => item.id));
            } else {
                const maxRank = Number(rankInput.value);
                if (!rankInput.value.trim() || !Number.isInteger(maxRank) || maxRank < 1 || maxRank > 10000) return failed('순위는 1~10000 사이의 정수로 입력해 주세요.');
                const result = selectedDetail('cups', selectedCup);
                if (result.error) return failed(result.error);
                ids = uniqueCurrent(result.value.participants.map((item, index) => ({item, index}))
                    .filter(({item}) => Number.isInteger(item.rank) && item.rank > 0 && item.rank <= maxRank)
                    .sort((left, right) => left.item.rank - right.item.rank || left.index - right.index)
                    .map(({item}) => styleFromPath(item.path)));
            }
            return ids.length ? {styleIds: ids, count: ids.length, error: ''} : failed('조건에 맞는 현재 그림체가 없습니다. 태그나 순위 조건을 바꿔 주세요.');
        }
        function describe(item, kind) {
            const date = new Date(item.created_at);
            const when = Number.isNaN(date.getTime()) ? '' : date.toLocaleString('ko-KR');
            return kind === 'tests' ? item.name ? [item.name, when].filter(Boolean).join(' · ') : when ? when + ' 테스트' : '이름 없는 테스트'
                : [String(item.gallery_key || '').startsWith('test:') ? '기존 테스트' : '대표 그림',
                    item.title || '월드컵', item.tag?.label, when].filter(Boolean).join(' · ');
        }
        function listOptions(kind) {
            const input = kind === 'tests' ? testInput : cupInput;
            const selected = kind === 'tests' ? selectedTest : selectedCup;
            input.replaceChildren(); option(input, '', `${labels[kind]} 선택`);
            (lists[kind].data || []).forEach(item => option(input, item.id, describe(item, kind)));
            if (selected && !(lists[kind].data || []).some(item => item.id === selected)) option(input, selected, '선택한 기록을 찾을 수 없음');
            input.value = selected;
        }
        function refreshTags() {
            const definitions = root.getGalleryTagState?.().definitions || [];
            tagChoices.replaceChildren();
            function choice(value, label, tag) {
                const button = node('button', 'gallery-tag-filter-chip');
                button.type = 'button'; button.value = value; button.title = label; button.setAttribute('aria-label', label);
                if (tag && root.renderGalleryTagIcon) button.innerHTML = root.renderGalleryTagIcon(tag);
                else button.textContent = label;
                button.onclick = () => { selectedTag = value; sync(); };
                tagChoices.appendChild(button);
            }
            choice('tagged', '태그 붙은 그림 모두');
            definitions.forEach((tag, index) => choice('tag:' + tag.id, tag.type === 'text' ? tag.value : `그림 태그 ${index + 1}`, tag));
        }
        function sync(notify = true) {
            if (disposed) return;
            tagPanel.hidden = mode !== 'tag'; testPanel.hidden = source !== 'test'; cupPanel.hidden = mode !== 'worldcup';
            sourceInput.disabled = mode !== 'tag';
            for (const button of tagChoices.children) {
                const active = button.value === selectedTag;
                button.disabled = mode !== 'tag';
                button.className = 'gallery-tag-filter-chip' + (active ? ' active' : '');
                button.setAttribute('aria-pressed', String(active));
            }
            testInput.disabled = mode !== 'tag' || source !== 'test' || lists.tests.status === 'loading';
            cupInput.disabled = mode !== 'worldcup' || lists.cups.status === 'loading';
            rankInput.disabled = mode !== 'worldcup';
            const kind = mode === 'worldcup' ? 'cups' : mode === 'tag' && source === 'test' ? 'tests' : '';
            retry.hidden = !kind || (lists[kind].status !== 'error' && details[kind].status !== 'error');
            retry.textContent = kind && lists[kind].status !== 'error' ? '그림 정보 다시 불러오기' : '목록 다시 불러오기';
            const result = selection();
            galleryButton.disabled = mode !== 'manual' && !!result.error;
            count.textContent = `대상 ${result.count}개 / 현재 그림체 ${styles.length}개`;
            status.textContent = result.error;
            if (notify) onChange?.();
        }
        async function api(url) {
            const response = await root.fetch(url, {cache: 'no-store'});
            const result = await response.json();
            if (!response.ok || result.status === 'error') throw new Error(result.message || '정보를 불러오지 못했습니다.');
            return result;
        }
        async function loadList(kind, force = false) {
            const resource = lists[kind];
            if (!force && ['ready', 'loading'].includes(resource.status)) return;
            const token = ++resource.token;
            resource.status = 'loading'; resource.error = ''; sync();
            try {
                const result = await api(urls[kind]);
                if (disposed || token !== resource.token) return;
                resource.data = kind === 'tests' ? result.batches : result.records.filter(relevantRecord);
                resource.status = 'ready'; listOptions(kind);
            } catch (error) {
                if (disposed || token !== resource.token) return;
                resource.status = 'error'; resource.error = `${labels[kind]} 목록을 불러오지 못했습니다: ${error.message}`;
            } finally { if (!disposed && token === resource.token) sync(); }
        }
        async function loadDetail(kind, id) {
            const resource = details[kind], token = ++resource.token;
            resource.id = id; resource.data = null; resource.error = ''; resource.status = id ? 'loading' : 'idle'; sync();
            if (!id) return;
            try {
                const result = await api(urls[kind] + '/' + encodeURIComponent(id));
                if (disposed || token !== resource.token) return;
                const value = kind === 'tests' ? result.batch : result.record;
                if (value.id !== id || kind === 'cups' && !relevantRecord(value)) throw new Error('선택한 기록과 응답이 일치하지 않습니다.');
                resource.data = value; resource.status = 'ready';
            } catch (error) {
                if (disposed || token !== resource.token) return;
                resource.status = 'error'; resource.error = `${labels[kind]}의 그림 정보를 불러오지 못했습니다: ${error.message}`;
            } finally { if (!disposed && token === resource.token) sync(); }
        }
        modeInput.onchange = () => {
            mode = modeInput.value;
            if (mode === 'worldcup') loadList('cups');
            else if (mode === 'tag' && source === 'test') loadList('tests');
            sync();
        };
        galleryButton.onclick = () => {
            if (disposed || activePicker && !activePicker.closed || !root.DakiTestTargetGallery?.open) return;
            const result = selection();
            if (mode !== 'manual' && result.error) return;
            let scopedCatalog = manualCatalog || catalog;
            if (mode !== 'manual') {
                const ids = result.styleIds === null ? styles.map(style => style.id) : result.styleIds;
                const byId = new Map(styles.map(style => [style.id, style]));
                let scoped = ids.map(id => byId.get(id)).filter(Boolean);
                if (mode === 'tag' && source === 'test') {
                    const images = new Map(details.tests.data.items.filter(item => item.status === 'completed' && item.src)
                        .map(item => [item.style_id, item]));
                    scoped = scoped.map(style => {
                        const image = images.get(style.id);
                        return {...style, src: image.src, preview_kind: 'test',
                            recommendation_count: image.recommendation_count ?? style.recommendation_count,
                            sort_date: image.sort_date || style.sort_date};
                    });
                }
                scopedCatalog = {...catalog, styles: scoped};
            }
            const allowed = new Set(scopedCatalog.styles.map(style => style.id));
            const picker = root.DakiTestTargetGallery.open({catalog: scopedCatalog, selectedIds: selectedStyleIds.filter(id => allowed.has(id)), onApply: ids => {
                if (disposed) return;
                manualCatalog = scopedCatalog;
                selectedStyleIds = uniqueCurrent(Array.isArray(ids) ? ids.filter(id => typeof id === 'string' && allowed.has(id)) : []);
                mode = 'manual'; modeInput.value = mode; sync();
            }, onClose: () => { if (activePicker === picker) activePicker = null; }});
            activePicker = picker || null;
        };
        sourceInput.onchange = () => { source = sourceInput.value; if (source === 'test') loadList('tests'); sync(); };
        testInput.onchange = () => { selectedTest = testInput.value; loadDetail('tests', selectedTest); };
        cupInput.onchange = () => { selectedCup = cupInput.value; loadDetail('cups', selectedCup); };
        rankInput.oninput = () => sync();
        retry.onclick = () => {
            const kind = mode === 'worldcup' ? 'cups' : 'tests';
            return lists[kind].status === 'error' ? loadList(kind, true) : loadDetail(kind, kind === 'tests' ? selectedTest : selectedCup);
        };
        const onTagsUpdated = () => { if (!disposed) { refreshTags(); sync(); } };
        const onCupsUpdated = () => { if (!disposed && lists.cups.status !== 'idle') loadList('cups', true); };
        root.addEventListener('gallery-tags-updated', onTagsUpdated);
        root.addEventListener('daki-worldcups-updated', onCupsUpdated);
        function dispose() {
            disposed = true;
            activePicker?.close?.(); activePicker = null;
            for (const resource of [...Object.values(lists), ...Object.values(details)]) resource.token++;
            root.removeEventListener('gallery-tags-updated', onTagsUpdated);
            root.removeEventListener('daki-worldcups-updated', onCupsUpdated);
        }
        modeInput.value = mode; sourceInput.value = source;
        refreshTags(); listOptions('tests'); listOptions('cups'); sync(false);
        return {element, selection, dispose};
    }
    root.DakiTestTargets = {create};
})(typeof window === 'undefined' ? globalThis : window);
