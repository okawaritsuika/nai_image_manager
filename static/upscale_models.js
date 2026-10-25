/* Shared model controls for gallery and canvas upscale dialogs. */
(function installUpscaleModelPanel(global) {
    const MODEL_INFO = {
        realcugan: {
            name: 'Real-CUGAN',
            description: '기존 로컬 엔진입니다. 애니 그림의 선과 디테일 복원에 적합합니다.'
        },
        waifu2x: {
            name: 'Waifu2x CUNet',
            description: '기존 로컬 엔진입니다. 원본 선화와 색을 보존하고 노이즈를 줄이는 데 적합합니다.'
        },
        illustrationjanai: {
            name: 'IllustrationJaNai V3detail FDAT M 4×',
            description: '중간 확대용 모델입니다. NVIDIA GPU용 선택 다운로드이며, 첫 새 모델 설치에서 큰 공용 실행 환경을 함께 받을 수 있습니다.'
        },
        animesharp: {
            name: 'AnimeSharp V4 RCAN 2×',
            description: '최종 확대용 모델입니다. NVIDIA GPU용 선택 다운로드이며, 첫 새 모델 설치에서 큰 공용 실행 환경을 함께 받을 수 있습니다.'
        },
        nai: {
            name: 'NovelAI · 5:16 자동 맞춤',
            description: '중앙을 자동으로 자르고 64px 배수 입력 크기로 맞춘 뒤 NovelAI에서 업스케일합니다.'
        },
        lanczos: {
            name: 'Lanczos',
            description: '설치가 필요 없는 빠른 리사이즈입니다.'
        }
    };
    const MANAGED_MODEL_IDS = ['realcugan', 'waifu2x', 'illustrationjanai', 'animesharp'];
    const NEW_MODEL_IDS = ['illustrationjanai', 'animesharp'];
    const VALID_STATES = new Set(['installed', 'missing', 'downloading', 'error', 'cancelled']);

    function create(config) {
        const doc = global.document;
        const byId = (suffix) => doc?.getElementById(`${config.prefix}${suffix}`) || null;
        const select = doc?.getElementById(config.engineSelectId) || null;
        const layer = doc?.getElementById(config.layerId) || null;
        const ui = {
            name: byId('ModelName'),
            state: byId('ModelState'),
            description: byId('ModelDescription'),
            message: byId('ModelMessage'),
            progressArea: byId('ModelProgressArea'),
            progressBar: byId('ModelProgressBar'),
            progressText: byId('ModelProgressText'),
            download: byId('ModelDownload'),
            cancel: byId('ModelCancel'),
            remove: byId('ModelDelete'),
            retry: byId('ModelRetry'),
            naiRetry: byId('NaiRetry'),
            naiPreview: byId('NaiPreview'),
            naiSteps: byId('NaiSteps'),
            website: byId('WaifuWebsite'),
            websiteInfo: byId('WaifuInfo'),
            resolution: doc?.getElementById(config.resolutionSectionId) || null,
            quality: doc?.getElementById(config.qualitySectionId) || null,
            start: doc?.getElementById(config.startButtonId) || null
        };
        let isOpen = false;
        let epoch = 0;
        let selectionVersion = 0;
        let statusTimer = null;
        let statusPromise = null;
        let statusAbort = null;
        let previewPromise = null;
        let previewAbort = null;
        let mutationAbort = null;
        let mutationPending = false;
        let mutationVersion = 0;
        let preparePending = false;
        let callerStartDisabled = Boolean(ui.start?.disabled);
        let panelStartBlocked = false;
        let models = new Map();
        let statusLoaded = false;
        let statusError = '';
        let operationError = '';
        let previewError = '';
        let previewPlan = null;

        function text(node, value) {
            if (node) node.textContent = String(value ?? '');
        }

        function hidden(node, value) {
            if (node) node.hidden = Boolean(value);
        }

        function setDataState(node, value) {
            if (!node) return;
            if (node.dataset) node.dataset.state = value;
            else node.setAttribute?.('data-state', value);
        }

        function setProgress(value) {
            const numeric = Math.max(0, Math.min(100, Number(value) || 0));
            if (ui.progressBar) ui.progressBar.style.width = `${numeric}%`;
            const progress = ui.progressArea?.querySelector?.('[role="progressbar"]');
            progress?.setAttribute?.('aria-valuenow', String(numeric));
            return numeric;
        }

        function formatBytes(value) {
            const bytes = Number(value);
            if (!Number.isFinite(bytes) || bytes <= 0) return '';
            const units = ['B', 'KB', 'MB', 'GB', 'TB'];
            let amount = bytes;
            let unit = 0;
            while (amount >= 1024 && unit < units.length - 1) {
                amount /= 1024;
                unit++;
            }
            return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
        }

        function selectedEngine() {
            const value = select?.value || 'realcugan';
            return MODEL_INFO[value] ? value : 'realcugan';
        }

        function selectedModel() {
            return models.get(selectedEngine()) || null;
        }

        function stateLabel(state) {
            return ({
                installed: '설치됨',
                missing: '설치 필요',
                downloading: '다운로드 중',
                error: '오류',
                cancelled: '취소됨',
                loading: '확인 중',
                unknown: '상태 확인 필요',
                unavailable: '상태 정보 없음',
                'not-required': '설치 불필요'
            })[state] || '상태 확인 필요';
        }

        function canPrepare(engine) {
            if (engine === 'lanczos') return true;
            if (engine === 'nai') return Boolean(previewPlan && !previewError);
            if (operationError || statusError || !statusLoaded) return false;
            const model = models.get(engine);
            return Boolean(model && model.state === 'installed' && model.installed === true);
        }

        function render() {
            const engine = selectedEngine();
            const info = MODEL_INFO[engine];
            const model = models.get(engine) || null;
            const isNai = engine === 'nai';
            const isLanczos = engine === 'lanczos';
            const disableControls = mutationPending || preparePending;

            // Keep the caller's disabled state separate from the panel's readiness lock.
            if (ui.start && !panelStartBlocked) callerStartDisabled = ui.start.disabled;
            panelStartBlocked = !canPrepare(engine) || mutationPending || preparePending;
            if (ui.start) ui.start.disabled = callerStartDisabled || panelStartBlocked;

            hidden(ui.resolution, isNai);
            hidden(ui.quality, !['realcugan', 'waifu2x'].includes(engine));
            hidden(ui.website, engine !== 'waifu2x');
            hidden(ui.websiteInfo, engine !== 'waifu2x');
            hidden(ui.naiPreview, !isNai);
            hidden(ui.download, true);
            hidden(ui.cancel, true);
            hidden(ui.remove, true);
            hidden(ui.retry, true);
            hidden(ui.naiRetry, !isNai || !previewError);
            hidden(ui.progressArea, true);
            if (ui.download) ui.download.disabled = disableControls;
            if (ui.cancel) ui.cancel.disabled = disableControls;
            if (ui.remove) ui.remove.disabled = disableControls;
            if (ui.retry) ui.retry.disabled = disableControls;
            if (ui.naiRetry) ui.naiRetry.disabled = disableControls;

            text(ui.name, model?.name || info.name);
            const description = model?.description || info.description;
            const byteInfo = model && model.state !== 'installed' ? formatBytes(model.download_bytes) : '';
            const runtimeInfo = model?.requires_runtime && !model?.runtime_installed
                ? ' 공용 실행 환경을 포함하며, 설치 후 약 5.3GB를 사용합니다.'
                : '';
            text(ui.description, `${description}${byteInfo ? ` 필요한 다운로드 용량: ${byteInfo}.` : ''}${runtimeInfo}`);

            if (isLanczos) {
                text(ui.state, stateLabel('not-required'));
                setDataState(ui.state, 'installed');
                text(ui.message, '로컬 설치 없이 바로 사용할 수 있습니다.');
                return;
            }

            if (isNai) {
                text(ui.state, previewError ? '크기 확인 실패' : previewPlan ? '크기 확인됨' : '크기 확인 중');
                setDataState(ui.state, previewError ? 'error' : previewPlan ? 'installed' : 'loading');
                text(ui.message, previewError || (previewPlan ? '미리보기 크기를 확인했습니다. 실행 전 한 번 더 확인합니다.' : '5:16 중앙 크롭 및 NAI 입력 크기를 계산합니다.'));
                if (ui.naiRetry) ui.naiRetry.disabled = disableControls;
                return;
            }

            if (operationError) {
                text(ui.state, stateLabel('unknown'));
                setDataState(ui.state, 'unknown');
                text(ui.message, operationError);
                hidden(ui.retry, false);
                return;
            }

            if (statusError) {
                text(ui.state, stateLabel('unknown'));
                setDataState(ui.state, 'unknown');
                text(ui.message, statusError);
                hidden(ui.retry, false);
                return;
            }

            if (!statusLoaded || !model) {
                const state = model?.state || (statusLoaded ? 'unavailable' : 'loading');
                text(ui.state, stateLabel(state));
                setDataState(ui.state, state === 'unavailable' ? 'unknown' : state);
                text(ui.message, model?.message || (statusLoaded ? '서버 응답에 이 모델의 상태가 없습니다. 다시 확인해 주세요.' : '설치 상태를 확인하고 있습니다.'));
                hidden(ui.retry, false);
                return;
            }

            const state = VALID_STATES.has(model.state)
                ? model.state
                : (model.installed ? 'installed' : 'unavailable');
            const canDelete = model.can_delete ?? (model.installed === true);
            text(ui.state, stateLabel(state));
            setDataState(ui.state, state === 'unavailable' ? 'unknown' : state);
            const hasDownloadByteProgress = state === 'downloading'
                && Number.isFinite(model.downloaded_bytes)
                && model.downloaded_bytes >= 0
                && Number.isFinite(model.download_bytes)
                && model.download_bytes > 0;
            const progress = setProgress(hasDownloadByteProgress
                ? model.downloaded_bytes / model.download_bytes * 100
                : model.progress);
            if (state === 'downloading') {
                hidden(ui.progressArea, false);
                text(ui.message, model.message || '모델 파일을 다운로드하고 있습니다.');
                const downloaded = formatBytes(model.downloaded_bytes);
                const total = formatBytes(model.download_bytes);
                const progressLabel = hasDownloadByteProgress
                    ? (progress >= 100 ? '다운로드 100% · 설치 중' : `다운로드 ${progress.toFixed(1)}%`)
                    : `${progress}%`;
                text(ui.progressText, `${progressLabel}${downloaded && total ? ` · ${downloaded} / ${total}` : ''}`);
                hidden(ui.cancel, false);
            } else if (state === 'installed' && model.installed === true) {
                text(ui.message, model.message || '이 모델을 사용할 수 있습니다.');
                hidden(ui.remove, !canDelete);
            } else if (state === 'missing' || state === 'cancelled' || state === 'error') {
                text(ui.message, model.message || (state === 'cancelled' ? '다운로드가 취소되었습니다.' : state === 'error' ? '설치 중 오류가 발생했습니다. 다시 시도할 수 있습니다.' : '아직 설치되지 않았습니다. 다운로드를 시작해 주세요.'));
                hidden(ui.download, false);
                hidden(ui.remove, !canDelete);
                if (state === 'error') hidden(ui.retry, false);
            } else {
                text(ui.state, stateLabel('unavailable'));
                setDataState(ui.state, 'unknown');
                text(ui.message, model.message || '서버에서 이 모델의 설치 상태를 확인하지 못했습니다. 다시 확인해 주세요.');
                hidden(ui.remove, !canDelete);
                hidden(ui.retry, false);
            }
            if (ui.download) ui.download.disabled = disableControls;
            if (ui.cancel) ui.cancel.disabled = disableControls;
            if (ui.remove) ui.remove.disabled = disableControls;
            if (ui.retry) ui.retry.disabled = disableControls;
        }

        function normalizeModel(item) {
            if (!item || !MANAGED_MODEL_IDS.includes(item.id)) return null;
            const state = VALID_STATES.has(item.state)
                ? item.state
                : (item.installed === true ? 'installed' : 'unavailable');
            return {...item, state};
        }

        function readModels(payload) {
            let list = Array.isArray(payload?.models) ? payload.models : null;
            if (!list && Array.isArray(payload?.model)) list = payload.model;
            if (!list && payload?.model && typeof payload.model === 'object') list = [payload.model];
            if (!list && payload?.id) list = [payload];
            if (!list) throw new Error('모델 상태 응답 형식이 올바르지 않습니다.');
            return list.map(normalizeModel).filter(Boolean);
        }

        async function parseResponse(response) {
            const payload = await response.json();
            if (!response.ok || payload?.status !== 'success') {
                const error = new Error(payload?.message || '모델 요청에 실패했습니다.');
                error.status = response.status;
                throw error;
            }
            return payload;
        }

        function refreshStatus() {
            if (!isOpen) return Promise.resolve(null);
            if (statusPromise) return statusPromise;
            const requestEpoch = epoch;
            const controller = new AbortController();
            statusAbort = controller;
            const request = (async () => {
                try {
                    const response = await global.fetch('/api/upscale/models', {signal: controller.signal});
                    const payload = await parseResponse(response);
                    const list = readModels(payload);
                    if (!isOpen || requestEpoch !== epoch) return null;
                    models = new Map(list.map(model => [model.id, model]));
                    statusLoaded = true;
                    statusError = '';
                    render();
                    return list;
                } catch (error) {
                    if (!isOpen || requestEpoch !== epoch || error?.name === 'AbortError') return null;
                    statusError = `설치 상태를 불러오지 못했습니다: ${error.message || error}. 다시 확인해 주세요.`;
                    render();
                    return null;
                } finally {
                    if (requestEpoch === epoch && statusPromise === request) {
                        statusPromise = null;
                        statusAbort = null;
                    }
                }
            })();
            statusPromise = request;
            return request;
        }

        function sourceSize() {
            const dimensions = config.sourceDimensions?.() || {};
            return {
                width: Math.round(Number(dimensions.width) || 0),
                height: Math.round(Number(dimensions.height) || 0)
            };
        }

        function sourceIdentity() {
            return config.sourceIdentity?.();
        }

        function sameIdentity(first, second) {
            if (Object.is(first, second)) return true;
            return Array.isArray(first)
                && Array.isArray(second)
                && first.length === second.length
                && first.every((value, index) => Object.is(value, second[index]));
        }

        function sameSize(first, second) {
            return first?.width === second?.width && first?.height === second?.height;
        }

        function formatDimensions(width, height) {
            return `${Number(width).toLocaleString()} × ${Number(height).toLocaleString()}px`;
        }

        function formatNaiSteps(plan) {
            const cropWidth = Number(plan.crop_width) || Math.max(0, Number(plan.crop_box?.[2]) - Number(plan.crop_box?.[0])) || Number(plan.input_width);
            const cropHeight = Number(plan.crop_height) || Math.max(0, Number(plan.crop_box?.[3]) - Number(plan.crop_box?.[1])) || Number(plan.input_height);
            const originalWidth = Number(plan.source_width) || sourceSize().width;
            const originalHeight = Number(plan.source_height) || sourceSize().height;
            return `원본 ${formatDimensions(originalWidth, originalHeight)} → 중앙 크롭 ${formatDimensions(cropWidth, cropHeight)} → NAI 입력 ${formatDimensions(plan.input_width, plan.input_height)} → 2× 출력 ${formatDimensions(plan.output_width, plan.output_height)}`;
        }

        function validPlan(plan) {
            return ['input_width', 'input_height', 'output_width', 'output_height']
                .every(key => Number.isFinite(Number(plan?.[key])) && Number(plan[key]) > 0);
        }

        function refreshPreview() {
            if (!isOpen || selectedEngine() !== 'nai') return Promise.resolve(null);
            if (previewPromise) return previewPromise;
            const requestEpoch = epoch;
            const requestSelection = selectionVersion;
            const dimensions = sourceSize();
            const identity = sourceIdentity();
            if (dimensions.width < 1 || dimensions.height < 1) {
                previewError = '원본 이미지 크기를 확인할 수 없어 미리보기를 만들지 못했습니다.';
                previewPlan = null;
                render();
                return Promise.resolve(null);
            }
            previewError = '';
            previewPlan = null;
            render();
            const controller = new AbortController();
            previewAbort = controller;
            const request = (async () => {
                try {
                    const response = await global.fetch('/api/upscale/nai/preview', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify(dimensions),
                        signal: controller.signal
                    });
                    const payload = await parseResponse(response);
                    const plan = payload.plan;
                    if (!validPlan(plan)) throw new Error('크기 미리보기 응답이 올바르지 않습니다.');
                    if (!isOpen || requestEpoch !== epoch || requestSelection !== selectionVersion || selectedEngine() !== 'nai' || !sameSize(dimensions, sourceSize()) || !sameIdentity(identity, sourceIdentity())) return null;
                    previewPlan = plan;
                    previewError = '';
                    text(ui.naiSteps, formatNaiSteps(plan));
                    render();
                    return plan;
                } catch (error) {
                    if (!isOpen || requestEpoch !== epoch || requestSelection !== selectionVersion || !sameSize(dimensions, sourceSize()) || !sameIdentity(identity, sourceIdentity()) || error?.name === 'AbortError') return null;
                    previewPlan = null;
                    previewError = `NAI 크기 미리보기를 불러오지 못했습니다: ${error.message || error}`;
                    render();
                    return null;
                } finally {
                    if (requestEpoch === epoch && previewPromise === request) {
                        previewPromise = null;
                        previewAbort = null;
                    }
                }
            })();
            previewPromise = request;
            return request;
        }

        function startPolling() {
            if (statusTimer !== null) return;
            statusTimer = global.setInterval(() => {
                if (isOpen) refreshStatus();
            }, 1600);
        }

        function open() {
            if (isOpen) return Promise.resolve();
            isOpen = true;
            epoch++;
            operationError = '';
            statusError = '';
            render();
            startPolling();
            const tasks = [refreshStatus()];
            if (selectedEngine() === 'nai') tasks.push(refreshPreview());
            return Promise.allSettled(tasks);
        }

        function close() {
            isOpen = false;
            epoch++;
            mutationVersion++;
            mutationPending = false;
            preparePending = false;
            previewPlan = null;
            previewError = '';
            if (statusTimer !== null) {
                global.clearInterval(statusTimer);
                statusTimer = null;
            }
            statusAbort?.abort();
            previewAbort?.abort();
            mutationAbort?.abort();
            statusPromise = null;
            previewPromise = null;
            statusAbort = null;
            previewAbort = null;
            mutationAbort = null;
            render();
        }

        function confirmDelete(model) {
            const othersKnown = NEW_MODEL_IDS.every(id => models.has(id));
            const isLastNewModel = NEW_MODEL_IDS.includes(model.id)
                && model.runtime_installed
                && othersKnown
                && NEW_MODEL_IDS.filter(id => id !== model.id).every(id => {
                    const other = models.get(id);
                    return other?.installed !== true
                        && other?.state !== 'downloading'
                        && (other?.can_delete ?? other?.installed) !== true;
                });
            const runtimeCopy = isLastNewModel
                ? ' 이 모델이 마지막으로 설치된 신규 모델이므로 공용 실행 환경도 함께 삭제됩니다.'
                : (model.requires_runtime ? ' 이 모델이 마지막 신규 모델이면 공용 실행 환경도 함께 삭제됩니다.' : '');
            return global.confirm(
                `선택한 ${model.name || MODEL_INFO[model.id]?.name || '모델'}만 삭제합니다. 원본 이미지와 업스케일 결과는 보존됩니다.${runtimeCopy}\n계속할까요?`
            );
        }

        async function mutate(action) {
            if (!isOpen || mutationPending) return;
            const model = selectedModel();
            const engine = selectedEngine();
            if (!model || !MANAGED_MODEL_IDS.includes(engine)) return;
            if (action === 'delete' && !confirmDelete(model)) return;

            mutationPending = true;
            operationError = '';
            const requestVersion = ++mutationVersion;
            const requestEpoch = epoch;
            const controller = new AbortController();
            mutationAbort = controller;
            render();
            try {
                const response = await global.fetch(`/api/upscale/models/${encodeURIComponent(engine)}/${action}`, {
                    method: 'POST',
                    signal: controller.signal
                });
                const payload = await parseResponse(response);
                if (!isOpen || requestEpoch !== epoch || requestVersion !== mutationVersion) return;
                const list = readModels(payload);
                if (list.length) {
                    for (const item of list) models.set(item.id, item);
                    statusLoaded = true;
                    statusError = '';
                }
                render();
            } catch (error) {
                if (!isOpen || requestEpoch !== epoch || requestVersion !== mutationVersion || error?.name === 'AbortError') return;
                operationError = `요청을 완료하지 못했습니다: ${error.message || error}. 상태를 다시 확인해 주세요.`;
                render();
            } finally {
                if (requestEpoch === epoch && requestVersion === mutationVersion) {
                    mutationPending = false;
                    mutationAbort = null;
                    render();
                    refreshStatus();
                }
            }
        }

        function retryStatus() {
            operationError = '';
            statusError = '';
            render();
            return refreshStatus();
        }

        function onSelectionChanged() {
            selectionVersion++;
            operationError = '';
            previewAbort?.abort();
            previewPromise = null;
            previewPlan = null;
            previewError = '';
            render();
            if (isOpen && selectedEngine() === 'nai') refreshPreview();
        }

        select?.addEventListener?.('change', onSelectionChanged);
        ui.download?.addEventListener?.('click', () => mutate('download'));
        ui.cancel?.addEventListener?.('click', () => mutate('cancel'));
        ui.remove?.addEventListener?.('click', () => mutate('delete'));
        ui.retry?.addEventListener?.('click', retryStatus);
        ui.naiRetry?.addEventListener?.('click', refreshPreview);
        global.addEventListener?.('beforeunload', close);
        render();

        function getTargetSize() {
            const size = config.getTargetDimensions?.() || {};
            const width = Math.round(Number(size.width) || 0);
            const height = Math.round(Number(size.height) || 0);
            if (width < 1 || height < 1) {
                text(ui.message, '목표 해상도를 확인해 주세요.');
                return null;
            }
            return {width, height};
        }

        async function prepare() {
            if (ui.start && !panelStartBlocked) callerStartDisabled = ui.start.disabled;
            if (!isOpen || preparePending || callerStartDisabled) return null;
            preparePending = true;
            const prepareEpoch = epoch;
            const prepareSelection = selectionVersion;
            const prepareIdentity = sourceIdentity();
            render();
            try {
                const engine = selectedEngine();
                if (engine === 'nai') {
                    const plan = await refreshPreview();
                    if (!plan || !isOpen || prepareEpoch !== epoch || prepareSelection !== selectionVersion || selectedEngine() !== 'nai' || !sameIdentity(prepareIdentity, sourceIdentity())) return null;
                    const dimensions = sourceSize();
                    if (Number(plan.source_width) !== dimensions.width || Number(plan.source_height) !== dimensions.height) {
                        previewPlan = null;
                        previewError = '원본 크기가 바뀌었습니다. 미리보기를 다시 확인해 주세요.';
                        render();
                        return null;
                    }
                    const summary = formatNaiSteps(plan);
                    const accepted = global.confirm(
                        `NovelAI 업스케일을 시작합니다. 원본은 보존되며 중앙을 잘라 5:16 비율과 64px 배수 입력 크기에 맞춥니다.\n${summary}\n\nAnlas가 소모될 수 있습니다. 정확한 비용은 이 앱에서 계산하지 않습니다.\n계속하시겠습니까?`
                    );
                    if (!accepted || !isOpen || prepareEpoch !== epoch || prepareSelection !== selectionVersion) return null;
                    return {
                        engine: 'nai',
                        target_width: Number(plan.output_width),
                        target_height: Number(plan.output_height),
                        quality: 'standard',
                        nai_confirmed: true
                    };
                }

                if (!['lanczos', ...MANAGED_MODEL_IDS].includes(engine)) return null;
                if (engine !== 'lanczos') {
                    if (!statusLoaded && !statusPromise) await refreshStatus();
                    else if (statusPromise) await statusPromise;
                    if (!isOpen || prepareEpoch !== epoch || prepareSelection !== selectionVersion || !sameIdentity(prepareIdentity, sourceIdentity())) return null;
                    const model = models.get(engine);
                    if (!statusLoaded || statusError || operationError || !model || model.state !== 'installed' || model.installed !== true) {
                        if (model?.message) text(ui.message, model.message);
                        else if (!statusError) text(ui.message, '모델을 설치한 뒤 업스케일을 시작해 주세요.');
                        render();
                        return null;
                    }
                }

                const size = getTargetSize();
                if (!size) return null;
                const quality = ['realcugan', 'waifu2x'].includes(engine)
                    ? (config.getQuality?.() || 'standard')
                    : 'standard';
                return {
                    engine,
                    target_width: size.width,
                    target_height: size.height,
                    quality
                };
            } finally {
                if (prepareEpoch === epoch) {
                    preparePending = false;
                    render();
                }
            }
        }

        return {open, close, prepare, refresh: retryStatus};
    }

    global.UpscaleModelPanel = {create};
})(window);
