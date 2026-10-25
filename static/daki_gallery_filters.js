/* Gallery-local tag/recommendation filters and one selected sort order. */
(function (root) {
    'use strict';
    const endpoint = '/api/daki/worldcups';
    function create({galleryKey, title, onChange, tagOnly = false, shareTagAssignment = false, recommendationOf, dateOf}) {
        const doc = root.document;
        const recommendationsEnabled = !tagOnly && typeof recommendationOf === 'function';
        const datesEnabled = !tagOnly && typeof dateOf === 'function';
        const worldcupPrefix = recommendationsEnabled || datesEnabled;
        const dateLabel = '그림체 작성일·추가일';
        const node = (tag, className, text) => {
            const item = doc.createElement(tag);
            if (className) item.className = className;
            if (text !== undefined) item.textContent = text;
            return item;
        };
        const element = node('div', 'daki-gallery-filters');
        const controls = node('div', 'daki-gallery-filter-controls');
        const tags = node('div', 'gallery-tag-filter-bar daki-filter-tags');
        tags.setAttribute('role', 'group'); tags.setAttribute('aria-label', `${title} 태그 필터`);
        const sort = node('div', 'gallery-sort-view-controls daki-filter-sort');
        const ranking = node('select', 'filter-select'); ranking.setAttribute('aria-label', `${title} ${recommendationsEnabled || datesEnabled ? '그림 정렬' : '월드컵 기록으로 정렬'}`);
        sort.append(node('span', 'daki-filter-label', 'SORT'), ranking);
        const history = node('a', 'gallery-tag-filter-chip daki-filter-history', '월드컵 기록'); history.href = '#daki&library=worldcups&gallery_key=' + encodeURIComponent(galleryKey);
        const retry = node('button', 'gallery-tag-filter-chip daki-filter-retry', '기록 다시 불러오기'); retry.type = 'button'; retry.hidden = true;
        controls.append(tags);
        const recommendationRange = node('div', 'daki-filter-recommendations');
        const minimum = node('select', 'filter-select');
        const resultCount = node('span', 'daki-filter-count');
        resultCount.setAttribute('role', 'status'); resultCount.setAttribute('aria-live', 'polite');
        if (recommendationsEnabled) {
            recommendationRange.setAttribute('role', 'group'); recommendationRange.setAttribute('aria-label', `${title} 추천수 필터`);
            minimum.setAttribute('aria-label', `${title} 추천수 기준`);
            option(minimum, '', '전체');
            for (let count = 10; count <= 100; count += 10) option(minimum, String(count), `${count} 이상`);
            minimum.value = ''; minimum.onchange = changed;
            recommendationRange.append(node('span', 'daki-filter-label', '추천수'), minimum);
            controls.append(recommendationRange);
        }
        if (!tagOnly) controls.append(sort, history, retry);
        if (recommendationsEnabled) controls.append(resultCount);
        const status = node('p', 'daki-gallery-filter-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        element.append(controls);
        if (!tagOnly) element.append(status);
        let disposed = false;
        let tagFilter = 'all';
        let selectedRecord = '';
        let recommendationOrder = '';
        let dateOrder = '';
        let ranks = null;
        let activeRecord = null;
        let listRevision = 0;
        let detailRevision = 0;
        let records = [];

        function changed() { if (!disposed) onChange?.(); }
        function option(select, value, label) {
            const item = node('option', '', label); item.value = value; select.appendChild(item);
        }
        function setResultCount(visible, total) {
            if (!disposed && recommendationsEnabled) resultCount.textContent = `${visible.toLocaleString('ko-KR')}장 남음 / 전체 ${total.toLocaleString('ko-KR')}장`;
        }
        function selectedSortValue() {
            return dateOrder ? 'date:' + dateOrder : recommendationOrder ? 'recommendation:' + recommendationOrder
                : selectedRecord ? (worldcupPrefix ? 'worldcup:' : '') + selectedRecord : '';
        }
        function refreshSortOptions() {
            ranking.replaceChildren(); option(ranking, '', '기본 순서');
            if (recommendationsEnabled) {
                option(ranking, 'recommendation:desc', '추천수 많은 순');
                option(ranking, 'recommendation:asc', '추천수 적은 순');
            }
            if (datesEnabled) {
                option(ranking, 'date:desc', '최신순');
                option(ranking, 'date:asc', '오래된순');
            }
            records.forEach(record => option(ranking, (worldcupPrefix ? 'worldcup:' : '') + record.id, recordLabel(record)));
            ranking.value = selectedSortValue();
        }
        function markTags() {
            for (const button of tags.children) {
                const active = button.value === tagFilter;
                button.className = 'gallery-tag-filter-chip' + (active ? ' active' : '');
                button.setAttribute('aria-pressed', String(active));
            }
        }
        function markAssignmentTags(selectedTagId) {
            for (const button of tags.children) {
                const selected = String(button.value) === String(selectedTagId);
                button.className = 'gallery-tag-filter-chip' + (selected ? ' gallery-tag-assignment-selected' : '');
                button.setAttribute('aria-pressed', String(selected));
            }
        }
        function tagButton(value, label, tag) {
            const button = node('button', 'gallery-tag-filter-chip');
            button.type = 'button'; button.value = value; button.title = label; button.setAttribute('aria-label', label);
            if (tag && root.renderGalleryTagIcon) button.innerHTML = root.renderGalleryTagIcon(tag);
            else if (value === 'all') button.appendChild(node('span', 'gallery-tag-filter-all-dot', 'ALL'));
            else button.textContent = value === 'tagged' ? '태그 있음' : label;
            button.onclick = () => { tagFilter = value; markTags(); changed(); };
            tags.appendChild(button);
        }
        function assignmentTagButton(tag, label) {
            const button = node('button', 'gallery-tag-filter-chip');
            button.type = 'button'; button.value = String(tag.id); button.title = label; button.setAttribute('aria-label', label);
            if (tag.id === 'NONE') button.textContent = '×';
            else if (root.renderGalleryTagIcon) button.innerHTML = root.renderGalleryTagIcon(tag);
            else button.textContent = label;
            button.onclick = () => {
                root.selectGalleryTagForAssignment?.(tag.id);
                refreshTags(false);
            };
            tags.appendChild(button);
        }
        function refreshTags(notify = true) {
            if (disposed) return;
            const state = root.getGalleryTagState?.() || {};
            const definitions = state.definitions || [];
            const assignmentMode = shareTagAssignment && !tagOnly && !!state.enabled;
            tags.setAttribute('aria-label', assignmentMode ? `${title} 적용할 태그 선택` : `${title} 태그 필터`);
            if (tagFilter.startsWith('tag:') && !definitions.some(tag => String(tag.id) === tagFilter.slice(4))) tagFilter = 'all';
            tags.replaceChildren();
            if (assignmentMode) {
                assignmentTagButton({id: 'NONE', type: 'text', value: '태그 제거'}, '태그 제거');
                definitions.forEach((tag, index) => assignmentTagButton(tag, tag.type === 'text' ? tag.value : `그림 태그 ${index + 1}`));
                markAssignmentTags(state.selectedTagId);
            } else {
                tagButton('all', '전체 그림'); tagButton('tagged', '태그 붙은 그림');
                definitions.forEach((tag, index) => tagButton('tag:' + tag.id, tag.type === 'text' ? tag.value : `그림 태그 ${index + 1}`, tag));
                markTags();
            }
            if (notify) changed();
        }
        function recordLabel(record) {
            const date = new Date(record.created_at);
            const when = Number.isNaN(date.getTime()) ? '' : date.toLocaleString('ko-KR');
            return [record.title || '월드컵', record.tag?.label || record.tag?.id || '태그', when].filter(Boolean).join(' · ');
        }
        function dateStatus() {
            return `${dateLabel} ${dateOrder === 'desc' ? '최신순' : '오래된순'} · 날짜를 알 수 없는 항목은 마지막에 표시합니다.`;
        }
        function rankingStatus() {
            status.textContent = dateOrder ? dateStatus()
                : recommendationOrder ? `추천수 ${recommendationOrder === 'desc' ? '많은' : '적은'} 순 · 추천수가 없는 그림은 마지막에 표시합니다.`
                : activeRecord ? `${recordLabel(activeRecord)} 순위 적용 중 · 공동 순위는 현재 그림 순서를 유지합니다.`
                : selectedRecord ? '선택한 월드컵의 순위를 불러오는 중…'
                    : records.length ? '월드컵 기록을 선택하면 순위가 높은 그림부터 표시합니다.' : '저장된 월드컵 기록이 없습니다.';
        }
        function resetRanking(message) {
            const hadRanking = !!selectedRecord || !!ranks;
            detailRevision++; selectedRecord = ''; ranks = null; activeRecord = null; ranking.value = selectedSortValue();
            status.textContent = message;
            if (hadRanking) changed();
        }
        async function api(url) {
            const response = await root.fetch(url, {cache: 'no-store'});
            const result = await response.json();
            if (!response.ok || result.status === 'error') throw new Error(result.message || '월드컵 기록을 불러오지 못했습니다.');
            return result;
        }
        async function loadRecords() {
            const token = ++listRevision;
            retry.hidden = true;
            status.textContent = dateOrder ? `${dateStatus()} 월드컵 기록을 불러오는 중…` : '월드컵 기록을 불러오는 중…';
            try {
                const result = await api(endpoint + '?gallery_key=' + encodeURIComponent(galleryKey));
                if (disposed || token !== listRevision) return;
                records = result.records.filter(record => record.gallery_key === galleryKey);
                refreshSortOptions();
                if (selectedRecord && !records.some(record => record.id === selectedRecord)) {
                    resetRanking('선택한 월드컵 기록을 찾을 수 없어 기본 순서로 표시합니다.');
                } else rankingStatus();
            } catch (error) {
                if (disposed || token !== listRevision) return;
                records = []; refreshSortOptions(); retry.hidden = false;
                resetRanking(`${error.message} ${recommendationsEnabled ? '추천수 정렬·필터와 태그 필터' : '기본 순서와 태그 필터'}를 사용할 수 있습니다.${dateOrder ? ` ${dateStatus()} 정렬을 계속 적용합니다.` : ''}`);
            }
        }
        async function selectRanking() {
            const token = ++detailRevision;
            const value = ranking.value;
            dateOrder = datesEnabled && ['date:desc', 'date:asc'].includes(value) ? value.slice(5) : '';
            recommendationOrder = recommendationsEnabled && ['recommendation:desc', 'recommendation:asc'].includes(value) ? value.slice(15) : '';
            selectedRecord = dateOrder || recommendationOrder ? '' : worldcupPrefix ? value.replace(/^worldcup:/, '') : value;
            ranks = null; activeRecord = null;
            const id = selectedRecord;
            rankingStatus(); changed();
            if (!id) return;
            try {
                const {record} = await api(endpoint + '/' + encodeURIComponent(id));
                if (disposed || token !== detailRevision || id !== selectedRecord) return;
                if (record.gallery_key !== galleryKey) throw new Error('현재 갤러리의 월드컵 기록이 아닙니다.');
                const participants = record.participants.filter(item => item.path && Number.isInteger(item.rank) && item.rank > 0);
                if (!participants.length) throw new Error('월드컵 기록에 순위 정보가 없습니다.');
                ranks = new Map(participants.map(item => [item.path, item.rank])); activeRecord = record;
                rankingStatus(); changed();
            } catch (error) {
                if (disposed || token !== detailRevision) return;
                retry.hidden = false;
                resetRanking(`${error.message} 기본 순서로 표시합니다.`);
            }
        }
        function apply(items, pathOf = item => item.path) {
            if (disposed) return [...items];
            let result = items.map((item, index) => ({item, index, path: String(pathOf(item) || '')}));
            const assignmentMode = shareTagAssignment && !tagOnly && !!root.getGalleryTagState?.()?.enabled;
            if (!assignmentMode && tagFilter !== 'all') result = result.filter(entry => {
                const tag = entry.path && root.getGalleryImageTagId?.(entry.path);
                return tagFilter === 'tagged' ? !!tag && tag !== 'NONE' : String(tag || '') === tagFilter.slice(4);
            });
            if (recommendationsEnabled) {
                const min = minimum.value === '' ? null : Number(minimum.value);
                result = result.map(entry => {
                    const value = recommendationOf(entry.item);
                    return {...entry, recommendation: Number.isSafeInteger(value) && value >= 0 ? value : null};
                });
                if (min !== null) result = result.filter(entry => entry.recommendation !== null && entry.recommendation >= min);
                if (recommendationOrder) result.sort((left, right) => {
                    if (left.recommendation === right.recommendation) return left.index - right.index;
                    if (left.recommendation === null) return 1;
                    if (right.recommendation === null) return -1;
                    return recommendationOrder === 'desc' ? right.recommendation - left.recommendation : left.recommendation - right.recommendation;
                });
            }
            if (dateOrder) result = result.map(entry => {
                const value = dateOf(entry.item);
                const timestamp = typeof value === 'string' && value.trim() ? new Date(value).getTime() : NaN;
                return {...entry, timestamp: Number.isFinite(timestamp) ? timestamp : null};
            }).sort((left, right) => {
                if (left.timestamp === right.timestamp) return left.index - right.index;
                if (left.timestamp === null) return 1;
                if (right.timestamp === null) return -1;
                return dateOrder === 'desc' ? right.timestamp - left.timestamp : left.timestamp - right.timestamp;
            });
            if (ranks) result.sort((left, right) => {
                const leftRank = ranks.get(left.path) ?? Infinity, rightRank = ranks.get(right.path) ?? Infinity;
                return leftRank === rightRank ? left.index - right.index : leftRank < rightRank ? -1 : 1;
            });
            return result.map(entry => entry.item);
        }
        function dispose() {
            disposed = true; listRevision++; detailRevision++;
            root.removeEventListener('gallery-tags-updated', onTagsUpdated);
            if (!tagOnly) root.removeEventListener('daki-worldcups-updated', onRecordsUpdated);
        }
        const onTagsUpdated = () => refreshTags();
        const onRecordsUpdated = () => { if (!disposed) loadRecords(); };
        refreshTags(false);
        root.addEventListener('gallery-tags-updated', onTagsUpdated);
        if (!tagOnly) {
            ranking.onchange = selectRanking;
            retry.onclick = loadRecords;
            refreshSortOptions();
            root.addEventListener('daki-worldcups-updated', onRecordsUpdated);
            loadRecords();
        }
        return {element, apply, dispose, setResultCount};
    }
    root.DakiGalleryFilters = {create};
})(typeof window === 'undefined' ? globalThis : window);
