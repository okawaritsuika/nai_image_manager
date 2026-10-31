/* Browser-extension connection and progress for shared-style collection. */
(function (root) {
    'use strict';
    const doc = root.document;
    const endpoint = '/api/daki/shared-styles/sync';
    let revision = 0, dialog, timer;
    let completionHandler, notifiedJob, mutationPending = false;
    let activeRequestPending = false, activeControls, activeRefresh;
    const node = (tag, className, text) => {
        const element = doc.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    };
    const phaseLabels = {
        resolve: '최신 버전 확인',
        download: '이미지팩 다운로드',
        verify: '파일 확인',
        recommendation_download: '추천수 자료 다운로드',
        recommendation_verify: '추천수 자료 확인',
        recommendations: '추천수 읽기',
        inspect: '그림체 검사',
        publish: '목록 반영',
        complete: '완료',
    };
    const validCount = value => Number.isSafeInteger(value) && value >= 0;
    const formatCount = value => value.toLocaleString('ko-KR');
    const formatMegabytes = value => (value / 1000000).toLocaleString('ko-KR', {maximumFractionDigits: 1}) + ' MB';
    function jobProgress(job) {
        if (!job || typeof job !== 'object') return {label: '', text: '', percent: null};
        const count = key => validCount(job[key]) ? formatCount(job[key]) : null;
        const statePrefix = job.status === 'failed' ? '실패 · ' : job.status === 'stopped' ? '중지됨 · ' : '';
        if (job.source !== 'huggingface') {
            const readCounts = [];
            if (count('scanned_posts') !== null) readCounts.push(`확인한 글 ${count('scanned_posts')}`);
            if (count('downloaded_images') !== null) readCounts.push(`받은 그림 ${count('downloaded_images')}`);
            const details = [typeof job.message === 'string' && job.message.trim() ? job.message.trim() : null,
                ...readCounts].filter(Boolean).join(' · ');
            return {label: '아카라이브 가져오기', text: `${statePrefix}${details || '진행 상황 확인 중'}`, percent: null};
        }

        const phase = typeof job.phase === 'string' ? job.phase : '';
        const label = phase === 'complete' ? '목록 반영' : phaseLabels[phase];
        if (phase === 'complete' && job.status === 'completed' && job.published === true) {
            return {label: '완료', text: '완료', percent: 100};
        }
        if (label) {
            let detail = '단계 확인 중';
            let percent = null;
            if (['download', 'verify', 'recommendation_download', 'recommendation_verify'].includes(phase)) {
                const current = validCount(job.phase_current) ? job.phase_current : null;
                const total = validCount(job.phase_total) && job.phase_total > 0 ? job.phase_total : null;
                if (current !== null && total !== null) {
                    percent = Math.min(100, Math.floor(current / total * 100));
                    detail = `${formatMegabytes(current)} / ${formatMegabytes(total)} · ${percent}%`;
                } else if (current !== null) {
                    detail = `${formatMegabytes(current)} · 전체 용량 확인 중`;
                }
            } else if (phase === 'inspect') {
                const processed = count('processed_images');
                const total = validCount(job.total_images) && job.total_images > 0 ? job.total_images : null;
                if (processed !== null && total !== null) {
                    percent = Math.min(100, Math.floor(job.processed_images / total * 100));
                    detail = `${processed} / ${formatCount(total)}장 · ${percent}%`;
                } else if (processed !== null) {
                    detail = `${processed}장 · 전체 확인 중`;
                }
            } else if (phase === 'publish') {
                const newStyles = count(job.published === true ? 'added' : 'prepared');
                detail = job.published === true
                    ? `목록 반영됨 · 새 그림체 ${newStyles ?? '확인 중'}개`
                    : `목록 반영 중 · 새 그림체 ${newStyles ?? '확인 중'}개`;
            }
            const text = phase === 'publish' ? `${statePrefix}${detail}`
                : phase === 'inspect' || ['download', 'verify', 'recommendation_download', 'recommendation_verify'].includes(phase)
                    ? `${statePrefix}${label} ${detail}` : `${statePrefix}${label} · ${detail}`;
            return {label, text, percent};
        }

        // Older Hugging Face snapshots expose only download bytes. Once that
        // transfer is complete, do not keep presenting its 100% as job progress.
        if (job.status === 'running') {
            const downloaded = validCount(job.downloaded_bytes) ? job.downloaded_bytes : null;
            const total = validCount(job.total_bytes) && job.total_bytes > 0 ? job.total_bytes : null;
            if (downloaded !== null && total !== null && downloaded >= total) {
                const images = count('downloaded_images');
                return {label: '다운로드 이후 처리',
                    text: `다운로드 이후 처리 중${images === null ? '' : ` · 확인한 그림 ${images}장`}`, percent: null};
            }
            if (downloaded !== null && total !== null) {
                const percent = Math.min(99, Math.floor(downloaded / total * 100));
                return {label: '이미지팩 다운로드',
                    text: `이미지팩 다운로드 ${formatMegabytes(downloaded)} / ${formatMegabytes(total)} · ${percent}%`, percent};
            }
            if (downloaded !== null) {
                return {label: '이미지팩 다운로드',
                    text: `이미지팩 다운로드 ${formatMegabytes(downloaded)} · 전체 용량 확인 중`, percent: null};
            }
        }
        return {label: '', text: '', percent: null};
    }
    function jobText(job) {
        if (!job) return '아카라이브 수집은 기간을 선택하세요. Hugging Face 최신판은 로그인 없이 갱신할 수 있습니다.';
        const huggingFace = job.source === 'huggingface';
        let text = '';
        const hasImageFailures = Number.isSafeInteger(job.failed_images) && job.failed_images > 0;
        const labels = {running: '수집 중', completed: hasImageFailures ? '수집 완료(일부 이미지 실패)' : '수집 완료', failed: '수집 실패', stopped: '수집 중지됨'};
        const count = key => Number.isSafeInteger(job[key]) && job[key] >= 0 ? job[key].toLocaleString('ko-KR') : '0';
        const source = huggingFace ? 'Hugging Face · ' : '';
        const hasPhase = huggingFace && typeof job.phase === 'string' && Object.hasOwn(phaseLabels, job.phase);
        let downloadProgress = '';
        if (huggingFace && Number.isSafeInteger(job.downloaded_bytes) && job.downloaded_bytes >= 0) {
            const megabytes = value => (value / 1000000).toLocaleString('ko-KR', {maximumFractionDigits: 1}) + ' MB';
            downloadProgress = ' · 다운로드 ' + megabytes(job.downloaded_bytes);
            if (Number.isSafeInteger(job.total_bytes) && job.total_bytes > 0) downloadProgress += ' / ' + megabytes(job.total_bytes);
        }
        if (huggingFace) {
            const state = `${source}${labels[job.status] || job.status}${hasPhase ? '' : downloadProgress}`;
            if (job.status === 'running') {
                text = hasPhase
                    ? `${source}${labels[job.status] || job.status} · 추가 예정 ${count('prepared')} · 필터 제외 ${count('filtered')} · 건너뜀 ${count('skipped')}`
                    : `${state} · 준비 ${count('prepared')} · 필터 제외 ${count('filtered')}`;
            } else if (job.status === 'completed' && job.published === true) {
                const updated = Number.isSafeInteger(job.updated) && job.updated > 0 ? ` · 갱신 ${count('updated')}` : '';
                text = `${state} · 추가 ${count('added')}${updated} · 필터 제외 ${count('filtered')} · 건너뜀 ${count('skipped')}`;
            } else if (job.published === true) {
                const updated = Number.isSafeInteger(job.updated) && job.updated > 0 ? ` · 갱신 ${count('updated')}` : '';
                text = `${state} · 카탈로그 반영 · 추가 ${count('added')}${updated} · 필터 제외 ${count('filtered')} · 건너뜀 ${count('skipped')}`;
            } else {
                const outcome = job.published === false ? ' · 기존 목록 유지'
                    : ['failed', 'stopped'].includes(job.status) ? ' · 반영 여부 확인 불가' : ' · 목록 미반영';
                text = `${state} · 준비 ${count('prepared')} · 필터 제외 ${count('filtered')} · 건너뜀 ${count('skipped')}${outcome}`;
            }
            const version = typeof job.archive_filename === 'string'
                ? job.archive_filename.match(/^NAImakeArtistGroup_shared_images_(\d{4})(\d{2})(\d{2})_webp\.zip$/) : null;
            if (version) text += ` · 자료 버전 ${version[1]}-${version[2]}-${version[3]}`;
            const stoppingMessage = '현재 요청이 끝나면 수집을 중지합니다.';
            if (job.message && (!hasPhase || job.status !== 'running' || job.message === stoppingMessage)) {
                text += ` · ${job.message}`;
            }
        } else {
            const filtered = Number.isSafeInteger(job.filtered) && job.filtered >= 0 ? ` · 필터 제외 ${count('filtered')}` : '';
            text = `${source}${labels[job.status] || job.status}${downloadProgress} · 확인한 글 ${count('scanned_posts')} · 받은 그림 ${count('downloaded_images')} · 추가 ${count('added')} · 건너뜀 ${count('skipped')}${filtered}` + (job.message ? ` · ${job.message}` : '');
        }
        if (Number.isSafeInteger(job.post_limited) && job.post_limited > 0) text += ` · 게시물 제한 ${count('post_limited')}`;
        if (hasImageFailures) {
            text += ` · 이미지 실패 ${count('failed_images')}` + (job.last_image_error ? ` · 최근 오류: ${job.last_image_error}` : '');
        }
        return text;
    }
    function notifyActivityCompletion(job) {
        if (!job || job.status === 'running') return;
        const key = job.started_at || JSON.stringify([job.source, job.status, job.added, job.updated, job.filtered]);
        if (notifiedJob === key) return;
        notifiedJob = key;
        completionHandler?.(job);
    }
    function leave(resumeActivity = true) {
        const pending = activeRequestPending;
        revision++; root.clearTimeout(timer);
        if (dialog?.open) dialog.close();
        dialog?.remove(); dialog = null;
        activeRequestPending = false; activeControls = activeRefresh = null;
        if (resumeActivity) root.DakiStyleSyncActivity?.detach({check: pending});
    }
    function open({onComplete} = {}) {
        if (dialog?.open) return;
        leave(false);
        if (typeof onComplete === 'function') completionHandler = onComplete;
        root.DakiStyleSyncActivity?.attach();
        const token = revision;
        const modal = dialog = node('dialog', 'daki-dialog daki-style-sync-dialog');
        modal.setAttribute('aria-labelledby', 'dakiStyleSyncTitle');
        const title = node('h2', '', '공유 그림체 최신화'); title.id = 'dakiStyleSyncTitle';
        const header = node('header'); header.appendChild(title);
        const form = node('form');
        const description = node('p', 'daki-test-note', 'NAI · 🔞 NAI의 ‘그림체·공유’ 글을 가져옵니다.');
        const help = node('details', 'daki-style-sync-help');
        help.setAttribute('name', 'dakiStyleSyncHelp');
        help.appendChild(node('summary', '', '아카라이브 로그인 연결 방법'));
        const helpBody = node('div', 'daki-style-sync-help-body');
        const download = node('a', 'daki-style-sync-download', '확장 프로그램 ZIP 다운로드');
        download.href = endpoint + '/extension'; download.download = 'daki-shared-styles-extension.zip';
        helpBody.append(download,
            node('p', 'daki-test-note', 'ZIP 압축을 푼 뒤 Chrome의 chrome://extensions에서 개발자 모드를 켜고 ‘압축해제된 확장 프로그램을 로드합니다’를 눌러 nai_arca_session_bridge 폴더를 선택하세요. 같은 브라우저에서 아카라이브에 로그인한 뒤 확장 프로그램 아이콘을 열어 ‘현재 로그인 연결’을 누르세요.'),
            node('p', 'daki-test-note', '최근 게시일~오늘을 자동 입력하며 직접 변경할 수 있습니다. 연결 결과는 NAI Image Manager(5000)와 NAImakeArtistGroup(5001)에 각각 표시됩니다. 앱 실행 후 ‘연결 상태 확인’을 누르세요.'));
        help.appendChild(helpBody);
        const dates = node('div', 'daki-style-toolbar');
        const today = new Date();
        const todayText = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')].join('-');
        let datesEdited = false, loadingDefaults = true;
        function validDate(value) {
            if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
            const parsed = new Date(value + 'T00:00:00Z');
            return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
        }
        function dateField(text, name) {
            const label = node('label', '', text);
            const input = node('input', 'filter-select'); input.type = 'date'; input.name = name;
            input.required = true; input.value = todayText; input.setAttribute('aria-label', text);
            input.oninput = input.onchange = () => { datesEdited = true; };
            label.appendChild(input); dates.appendChild(label); return input;
        }
        const startDate = dateField('시작일', 'start_date'), endDate = dateField('종료일', 'end_date');
        const connection = node('p', 'daki-test-note', '확장 프로그램 연결 상태 확인 중…');
        const phaseProgress = node('div', 'daki-style-sync-progress'); phaseProgress.hidden = true;
        const phaseProgressText = node('div', 'gallery-index-progress-meta daki-style-sync-progress-meta');
        const phaseMeter = node('div', 'gallery-index-meter daki-style-sync-progress-meter');
        phaseMeter.setAttribute('role', 'progressbar');
        phaseMeter.setAttribute('aria-valuemin', '0'); phaseMeter.setAttribute('aria-valuemax', '100');
        const phaseFill = node('div', 'gallery-index-progress-fill'); phaseMeter.appendChild(phaseFill);
        phaseProgress.append(phaseProgressText, phaseMeter);
        const status = node('p', 'daki-test-note'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        const note = node('p', 'daki-test-note'); note.hidden = true;
        const actions = node('div', 'daki-dialog-actions daki-style-toolbar');
        function button(text, action) {
            const element = node('button', 'nav-btn', text); element.type = 'button'; element.onclick = action; return element;
        }
        const check = button('연결 상태 확인', () => request());
        const start = button('가져오기 시작', () => submit()); start.className = 'daki-primary';
        const initialImport = button('Hugging Face 새 그림체 추가', () => submitInitialImport());
        const initialSection = node('section', 'daki-style-sync-initial');
        initialSection.append(node('h3', '', 'Hugging Face 최신판'),
            node('p', 'daki-test-note', 'V5 Full · V5 Full Medium의 새 그림체를 추가합니다. 로그인 없이 사용하며 기존 그림과 테스트는 유지합니다.'));
        function tagField(labelText, name, placeholder) {
            const label = node('label', 'daki-style-sync-field');
            const input = node('textarea'); input.setAttribute('data-prompt-autocomplete', ''); input.name = name; input.rows = 2; input.placeholder = placeholder;
            input.setAttribute('aria-label', labelText); label.appendChild(input);
            return {label, input};
        }
        function splitTags(value) {
            return String(value || '').split(/[,\r\n]+/).map(tag => tag.trim()).filter(Boolean);
        }
        function filterEditor(prefix) {
            const section = node('section', 'daki-style-sync-filters');
            const realisticLabel = node('label', 'daki-style-sync-realistic');
            const excludeRealistic = node('input'); excludeRealistic.type = 'checkbox'; excludeRealistic.name = `${prefix}exclude_realistic`;
            excludeRealistic.checked = true; excludeRealistic.setAttribute('aria-label', '실사 그림체 제외 (realistic · photorealistic)');
            realisticLabel.append(excludeRealistic, node('span', '', '실사 그림체 제외 (realistic · photorealistic)'));
            const includeField = tagField('포함 태그', `${prefix}include_query`, 'watercolor, sketch');
            includeField.input.maxLength = 20000;
            const excludeField = tagField('제외 태그', `${prefix}exclude_tags`, 'monochrome');
            const recommendationRow = node('div', 'daki-style-sync-recommendation-row');
            const recommendationLabel = node('label', 'daki-style-sync-recommendation-toggle');
            const limitLowRecommendations = node('input');
            limitLowRecommendations.type = 'checkbox'; limitLowRecommendations.name = `${prefix}limit_low_recommendations`;
            limitLowRecommendations.checked = false; limitLowRecommendations.setAttribute('aria-label', '추천수 제한');
            recommendationLabel.append(limitLowRecommendations, node('span', '', '추천수'));
            const recommendationThreshold = node('input');
            recommendationThreshold.type = 'number'; recommendationThreshold.name = `${prefix}recommendation_threshold`;
            recommendationThreshold.value = '10'; recommendationThreshold.step = '1';
            recommendationThreshold.min = '0'; recommendationThreshold.max = String(Number.MAX_SAFE_INTEGER);
            recommendationThreshold.setAttribute('aria-label', '추천수 제한 임계값');
            recommendationRow.append(recommendationLabel, recommendationThreshold, node('span', '', '이하: 게시물당 1개'));
            const toggle = node('div', 'daki-style-sync-filter-toggle');
            const includeButton = button('포함 태그', () => setMode('include'));
            const excludeButton = button('제외 태그', () => setMode('exclude'));
            toggle.append(includeButton, excludeButton);
            let mode = 'include', edited = false;
            function setMode(next) {
                mode = next;
                includeField.label.hidden = mode !== 'include';
                excludeField.label.hidden = mode !== 'exclude';
                includeButton.setAttribute('aria-pressed', String(mode === 'include'));
                excludeButton.setAttribute('aria-pressed', String(mode === 'exclude'));
            }
            const inputs = [excludeRealistic, includeField.input, excludeField.input,
                limitLowRecommendations, recommendationThreshold];
            inputs.forEach(input => { input.oninput = input.onchange = () => { edited = true; }; });
            section.append(realisticLabel, toggle, includeField.label, excludeField.label, recommendationRow);
            setMode('include');
            function collect() {
                let lowRecommendationLimit = null;
                if (limitLowRecommendations.checked === true) {
                    const rawThreshold = String(recommendationThreshold.value || '').trim();
                    const threshold = Number(rawThreshold);
                    if (!rawThreshold || !Number.isSafeInteger(threshold) || threshold < 0) {
                        throw new Error('추천수 제한은 0 이상의 정수로 입력해 주세요.');
                    }
                    lowRecommendationLimit = threshold;
                }
                return {exclude_realistic: excludeRealistic.checked === true,
                    include_query: String(includeField.input.value || '').trim(),
                    exclude_tags: splitTags(excludeField.input.value),
                    low_recommendation_limit: lowRecommendationLimit};
            }
            function restore(filters) {
                if (edited || !filters || typeof filters !== 'object') return;
                if (typeof filters.exclude_realistic === 'boolean') excludeRealistic.checked = filters.exclude_realistic;
                if (Number.isSafeInteger(filters.low_recommendation_limit) && filters.low_recommendation_limit >= 0) {
                    limitLowRecommendations.checked = true;
                    recommendationThreshold.value = String(filters.low_recommendation_limit);
                } else {
                    limitLowRecommendations.checked = false;
                    recommendationThreshold.value = '10';
                }
                const tagText = value => Array.isArray(value) ? value.join(', ') : typeof value === 'string' ? value : null;
                const excludes = tagText(filters.exclude_tags);
                if (typeof filters.include_query === 'string') {
                    includeField.input.value = filters.include_query;
                } else if (Array.isArray(filters.include_tags)) {
                    const legacyTags = filters.include_tags
                        .map(tag => String(tag || '').trim().replace(/\s+/g, '_'))
                        .filter(Boolean);
                    const separator = filters.include_mode === 'all' ? ', ' : ' || ';
                    includeField.input.value = legacyTags.join(separator);
                } else if (typeof filters.include_tags === 'string') {
                    const legacyTags = splitTags(filters.include_tags)
                        .map(tag => tag.replace(/\s+/g, '_'));
                    const separator = filters.include_mode === 'all' ? ', ' : ' || ';
                    includeField.input.value = legacyTags.join(separator);
                }
                if (excludes !== null) excludeField.input.value = excludes;
            }
            return {section, inputs, collect, restore};
        }
        const huggingFaceFilters = filterEditor('');
        const arcaFilters = filterEditor('arca_');
        const queryHelp = node('details', 'daki-style-sync-help');
        queryHelp.setAttribute('name', 'dakiStyleSyncHelp');
        queryHelp.appendChild(node('summary', '', '포함 검색 문법과 예시'));
        const queryHelpBody = node('div', 'daki-style-sync-help-body');
        queryHelpBody.appendChild(node('p', 'daki-test-note', '빈칸은 제한 없음. 포함·제외는 함께 적용하며 원본 긍정 프롬프트만 검색합니다. 포함: 쉼표·공백·줄바꿈=모두, ||=하나 이상, 여러 단어는 blue_hair. 제외: 쉼표·줄바꿈 구분, 하나라도 정확히 일치하면 제외. 추천수 제한: 기존 그림체가 있는 글은 건너뛰고, 미확인 추천수는 제한하지 않습니다.'));
        const examples = node('div', 'daki-style-sync-examples');
        for (const [query, description] of [
            ['watercolor, sketch', '두 태그 모두 포함'],
            ['watercolor || sketch', '둘 중 하나 포함'],
            ['watercolor, sketch || ink', 'watercolor와 sketch가 모두 있거나 ink 포함'],
            ['%hair%', 'hair가 들어간 태그와 부분 일치'],
        ]) {
            const example = node('p', 'daki-test-note');
            example.append(node('code', '', query), node('span', '', ` — ${description}`));
            examples.appendChild(example);
        }
        queryHelpBody.appendChild(examples);
        queryHelp.appendChild(queryHelpBody);
        initialSection.append(huggingFaceFilters.section, initialImport);
        const stop = button('수집 중지', () => request('/stop', {}));
        const close = button('닫기', () => modal.close());
        const arcaSection = node('section', 'daki-style-sync-source');
        const arcaActions = node('div', 'daki-style-sync-source-actions');
        arcaActions.append(check, start);
        const arcaHeading = node('div', 'daki-style-sync-source-heading');
        arcaHeading.append(node('h3', '', '아카라이브 기간별 가져오기'), connection);
        dates.className += ' daki-style-sync-dates';
        arcaSection.append(arcaHeading, description, dates, arcaFilters.section, arcaActions);
        const columns = node('div', 'daki-style-sync-columns');
        columns.append(initialSection, arcaSection);
        actions.append(note, stop, close);
        form.append(columns, help, queryHelp, phaseProgress, status, actions); modal.append(header, form);
        let busy = false, connected = false, job = null, completed = null, refreshQueued = false;
        const current = () => revision === token && modal.open;
        const filterInputs = [...huggingFaceFilters.inputs, ...arcaFilters.inputs];
        function collectFilters(editor) {
            try {
                return editor.collect();
            } catch (error) {
                status.textContent = error.message;
                return null;
            }
        }
        function controls() {
            const running = job?.status === 'running';
            const pending = busy || mutationPending;
            check.disabled = pending; start.disabled = pending || running || !connected;
            initialImport.disabled = pending || running;
            filterInputs.forEach(input => { input.disabled = pending || running; });
            stop.disabled = pending || !running; startDate.disabled = endDate.disabled = running || (pending && !loadingDefaults);
        }
        activeControls = controls;
        activeRefresh = () => {
            if (!current()) return;
            if (busy) { refreshQueued = true; return; }
            return request();
        };
        function display(result) {
            connected = result.connected === true; job = result.job;
            connection.textContent = connected ? '확장 프로그램 연결됨' : '확장 프로그램 미연결';
            connection.title = connected ? '확장 프로그램 연결됨' : '아래 아카라이브 로그인 연결 방법을 확인해 주세요.';
            const guidance = {
                running: '창을 닫아도 수집은 계속됩니다. 화면 왼쪽 아래에서 진행 상황을 확인할 수 있습니다.',
                completed: '수집이 완료되었습니다. 창을 닫으면 추가된 그림체를 확인할 수 있습니다.',
                failed: '수집이 중단되었습니다. 오류 내용을 확인한 뒤 다시 시작해 주세요.',
                stopped: '수집이 중지되었습니다. 다시 시작하면 이미 가져온 그림은 건너뜁니다.',
            };
            const huggingFace = job?.source === 'huggingface';
            const interruptedHuggingFace = huggingFace && ['failed', 'stopped'].includes(job?.status);
            note.textContent = interruptedHuggingFace && job.published === false
                ? '기존 공유 그림체 목록은 그대로 유지됩니다. 다시 실행하면 안전하게 새로 준비합니다.'
                : interruptedHuggingFace && job.published === true
                    ? '공유 목록은 반영되었습니다. 반영 이후 단계가 완료되지 않았습니다.'
                    : interruptedHuggingFace
                        ? '작업이 중단됐지만 목록 반영 여부를 확인할 수 없습니다.'
                        : huggingFace && job?.status === 'completed' && job.published === true
                    ? '최신 V5 Full/Medium 그림체를 공유 목록에 반영했습니다.'
                    : huggingFace && job?.status === 'completed'
                        ? job.published === false
                            ? '작업은 완료됐지만 공유 목록에는 반영되지 않았습니다. 기존 목록을 유지합니다.'
                            : '작업은 끝났지만 목록 반영 여부를 확인할 수 없습니다.'
                        : guidance[job?.status] || '';
            note.hidden = !note.textContent;
            const progress = typeof root.DakiStyleSync?.jobProgress === 'function' ? root.DakiStyleSync.jobProgress(job) : null;
            const progressPercent = Number.isSafeInteger(progress?.percent) && progress.percent >= 0 && progress.percent <= 100
                ? progress.percent : null;
            phaseProgress.hidden = !progress?.text;
            phaseProgressText.textContent = progress?.text || '';
            phaseMeter.className = `gallery-index-meter daki-style-sync-progress-meter${progressPercent === null ? ' is-indeterminate' : ''}`;
            if (progress?.label) phaseMeter.setAttribute('aria-label', `${progress.label} 진행률`);
            else phaseMeter.removeAttribute('aria-label');
            if (progressPercent === null) phaseMeter.removeAttribute('aria-valuenow');
            else phaseMeter.setAttribute('aria-valuenow', String(progressPercent));
            phaseFill.style.width = progressPercent === null ? '38%' : `${progressPercent}%`;
            if (!job) { status.textContent = '아카라이브 수집은 기간을 선택하세요. Hugging Face 최신판은 로그인 없이 갱신할 수 있습니다.'; return; }
            status.textContent = jobText(job);
            if (!huggingFace && job.status === 'completed' && Number.isSafeInteger(job.failed_images) && job.failed_images > 0) {
                note.textContent = '받을 수 있는 이미지의 수집을 마쳤습니다. 실패한 이미지는 같은 기간으로 다시 실행하면 재시도합니다.';
            }
            if (job.status !== 'running') completed = job;
        }
        async function request(suffix = '', body, applyDefaults = false) {
            if (!current() || busy || (body !== undefined && mutationPending)) return;
            root.clearTimeout(timer); busy = true; activeRequestPending = true;
            if (body !== undefined) mutationPending = true;
            controls();
            try {
                const response = await root.fetch(endpoint + suffix, {method: body === undefined ? 'GET' : 'POST',
                    headers: {'Content-Type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
                const result = await response.json();
                if (!response.ok || result.status !== 'success') throw new Error(result.message || '수집 상태를 확인하지 못했습니다.');
                if (!current()) {
                    // A start/stop accepted after closing still belongs to the
                    // server job. Background tracking must not lose its reply.
                    if (body !== undefined) root.DakiStyleSyncActivity?.observe(result.job, {started: suffix === ''});
                    return;
                }
                if (applyDefaults && !datesEdited) {
                    const defaults = result.defaults || {};
                    const end = validDate(defaults.end_date) ? defaults.end_date : todayText;
                    const start = validDate(defaults.start_date) && defaults.start_date <= end ? defaults.start_date : end;
                    startDate.value = start; endDate.value = end;
                }
                if (applyDefaults && result.job) {
                    const source = result.job.source;
                    const savedFilters = source === 'huggingface' ? huggingFaceFilters
                        : source === 'arca' || !source ? arcaFilters : null;
                    savedFilters?.restore(result.job.filters);
                }
                display(result);
                root.DakiStyleSyncActivity?.observe(result.job, {started: body !== undefined && suffix === ''});
                if (job?.status === 'running') timer = root.setTimeout(() => request(), 1000);
            } catch (error) {
                if (current()) {
                    status.textContent = error.message + ' ‘연결 상태 확인’으로 다시 확인하세요.';
                    note.textContent = ''; note.hidden = true;
                }
            } finally {
                if (applyDefaults) loadingDefaults = false;
                busy = false;
                if (body !== undefined) mutationPending = false;
                if (current()) {
                    activeRequestPending = false;
                    controls();
                    if (refreshQueued) { refreshQueued = false; request(); }
                } else if (body !== undefined) {
                    activeControls?.();
                    activeRefresh?.();
                }
            }
        }
        function submit() {
            if (busy || mutationPending || job?.status === 'running' || !connected) return;
            if (!validDate(startDate.value) || !validDate(endDate.value) || startDate.value > endDate.value) {
                status.textContent = '시작일과 종료일을 확인해 주세요. 시작일은 종료일보다 늦을 수 없습니다.'; return;
            }
            const filters = collectFilters(arcaFilters);
            if (!filters) return;
            completed = null; notifiedJob = null;
            return request('', {start_date: startDate.value, end_date: endDate.value, filters});
        }
        function submitInitialImport() {
            if (busy || mutationPending || job?.status === 'running') return;
            const filters = collectFilters(huggingFaceFilters);
            if (!filters) return;
            completed = null; notifiedJob = null;
            return request('', {source: 'huggingface', filters});
        }
        form.onsubmit = event => { event.preventDefault(); return submit(); };
        modal.addEventListener('close', () => {
            const notify = revision === token && completed;
            if (revision === token) {
                const pending = activeRequestPending;
                revision++; root.clearTimeout(timer); dialog = null;
                activeRequestPending = false; activeControls = activeRefresh = null;
                root.DakiStyleSyncActivity?.detach({check: pending});
            }
            modal.remove();
            if (notify) notifyActivityCompletion(completed);
        }, {once: true});
        doc.body.appendChild(modal); modal.showModal(); controls();
        return request('', undefined, true);
    }
    root.DakiStyleSync = {open, leave, jobText, jobProgress, notifyActivityCompletion};
    root.addEventListener?.('pagehide', () => leave(false));
})(window);
