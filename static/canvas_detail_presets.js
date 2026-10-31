(function (root) {
    'use strict';

    const API_PATH = '/api/canvas/detail-presets';
    const EMPTY_CATALOG = () => ({common: {revision: 0, items: []}, project: null, projectId: null});

    function appendPromptText(current, incoming) {
        const oldText = typeof current === 'string' ? current : '';
        const addedText = typeof incoming === 'string' ? incoming : '';
        if (!addedText.trim()) return oldText;
        if (!oldText) return addedText;
        if (oldText.endsWith(',')) return oldText + ' ' + addedText;
        if (/,[\t \r\n]+$/.test(oldText)) return oldText + addedText;
        return oldText + ', ' + addedText;
    }

    function appendPromptPair(base, negative, preset) {
        return {
            base: appendPromptText(base, preset?.base),
            negative: appendPromptText(negative, preset?.negative)
        };
    }

    function filterPresets(items, search, category) {
        const needle = String(search || '').trim().toLocaleLowerCase();
        const chosenCategory = String(category || '');
        return (Array.isArray(items) ? items : []).filter(item => {
            if (chosenCategory && item.category !== chosenCategory) return false;
            if (!needle) return true;
            return [item.name, item.category, item.base, item.negative]
                .some(value => String(value || '').toLocaleLowerCase().includes(needle));
        });
    }

    function linkSnapshot(link) {
        if (!link || typeof link.projectId !== 'string' || !link.projectId) return null;
        return {projectId: link.projectId, projectName: String(link.projectName || link.name || '연결된 프로젝트')};
    }

    function normalizeCatalog(payload, expectedProjectId) {
        if (!payload || payload.status !== 'success' || !payload.common
            || !Number.isSafeInteger(payload.common.revision) || !Array.isArray(payload.common.items)) {
            throw new Error(payload?.message || '디테일 프리셋 목록 응답이 올바르지 않습니다.');
        }
        let project = null;
        if (expectedProjectId && payload.project) {
            if (!Number.isSafeInteger(payload.project.revision) || !Array.isArray(payload.project.items)) {
                throw new Error('프로젝트 디테일 프리셋 목록 응답이 올바르지 않습니다.');
            }
            project = {revision: payload.project.revision, items: payload.project.items};
        }
        return {
            common: {revision: payload.common.revision, items: payload.common.items},
            project,
            projectId: expectedProjectId || null
        };
    }

    function createCanvasDetailPresetsController(options = {}) {
        const win = options.window || root;
        const doc = options.document || win.document;
        const fetchRequest = options.fetch || win.fetch?.bind(win);
        const getLink = options.getLink || (() => win.CanvasProject?.localLink?.() || null);
        const getInputs = options.getInputs || (() => ({
            base: doc?.getElementById('clipInstancePromptInput'),
            negative: doc?.getElementById('clipInstanceNegativePromptInput')
        }));
        const getUuid = options.randomUUID || (() => win.crypto?.randomUUID?.());
        const AbortControllerClass = options.AbortController || win.AbortController || globalThis.AbortController;
        const state = {
            pickerOpen: false,
            managerOpen: false,
            managerSession: 0,
            managerStale: false,
            managerBusy: false,
            managerScope: 'common',
            managerContextProjectId: null,
            lastProjectId: linkSnapshot(getLink())?.projectId || null,
            catalog: {picker: EMPTY_CATALOG(), manager: EMPTY_CATALOG()},
            errors: {picker: '', manager: ''},
            readGeneration: {picker: 0, manager: 0},
            reads: {picker: null, manager: null},
            editing: null,
            pendingCreate: null,
            deleteConfirmId: null
        };
        let pickerUi = null;
        let managerUi = null;
        let disposed = false;

        function currentLink() { return linkSnapshot(getLink()); }
        function sameProject(projectId) { return (currentLink()?.projectId || null) === projectId; }
        function element(tag, className, text) {
            const node = doc.createElement(tag);
            if (className) node.className = className;
            if (text !== undefined) node.textContent = text;
            return node;
        }
        function labelFor(text, control) {
            const label = element('label', '', text);
            label.htmlFor = control.id;
            return label;
        }
        function abortRead(target) {
            const record = state.reads[target];
            if (record?.controller) record.controller.abort();
            state.reads[target] = null;
            state.readGeneration[target] += 1;
        }
        function abortAllReads() {
            abortRead('picker');
            abortRead('manager');
        }

        async function responseJson(response) {
            let payload;
            try { payload = await response.json(); }
            catch (_) { throw new Error('디테일 프리셋 응답을 읽지 못했습니다.'); }
            if (!response.ok || payload?.status !== 'success') {
                const error = new Error(payload?.message || '디테일 프리셋 요청을 완료하지 못했습니다.');
                error.status = response.status;
                throw error;
            }
            return payload;
        }

        function isTargetOpen(target) {
            return target === 'picker' ? state.pickerOpen : state.managerOpen;
        }

        function renderPickerCategories() {
            if (!pickerUi) return;
            const selected = pickerUi.category.value;
            const catalog = state.catalog.picker;
            const items = [...(catalog?.common?.items || []), ...(catalog?.project?.items || [])];
            const categories = [...new Set(items.map(item => String(item.category || '')).filter(Boolean))]
                .sort((a, b) => a.localeCompare(b, 'ko'));
            pickerUi.category.replaceChildren();
            const all = element('option', '', '모든 카테고리');
            all.value = '';
            pickerUi.category.appendChild(all);
            for (const category of categories) {
                const option = element('option', '', category);
                option.value = category;
                pickerUi.category.appendChild(option);
            }
            pickerUi.category.value = categories.includes(selected) ? selected : '';
        }

        function renderPickerList() {
            if (!pickerUi) return;
            const inputs = getInputs() || {};
            const canInsert = Boolean(inputs.base && inputs.negative && !inputs.base.disabled && !inputs.negative.disabled);
            const catalog = state.catalog.picker;
            const allItems = [...(catalog?.common?.items || []).map(item => ({...item, scope: 'common'})),
                ...(catalog?.project?.items || []).map(item => ({...item, scope: 'project'}))];
            const matches = filterPresets(allItems, pickerUi.search.value, pickerUi.category.value);
            pickerUi.list.replaceChildren();
            pickerUi.search.disabled = false;
            pickerUi.category.disabled = !allItems.length;
            if (!catalog) {
                pickerUi.listState.textContent = state.errors.picker || '불러오는 중…';
                pickerUi.listState.hidden = false;
                pickerUi.retry.hidden = !state.errors.picker;
                return;
            }
            pickerUi.retry.hidden = true;
            if (!allItems.length) {
                pickerUi.listState.textContent = '등록된 디테일 프리셋이 없습니다.';
                pickerUi.listState.hidden = false;
                return;
            }
            if (!matches.length) {
                pickerUi.listState.textContent = '검색 결과가 없습니다.';
                pickerUi.listState.hidden = false;
                return;
            }
            pickerUi.listState.hidden = true;
            for (const item of matches) {
                const button = element('button', 'canvas-detail-preset-chip');
                button.type = 'button';
                button.disabled = !canInsert;
                button.title = `Base: ${item.base || ''}\nNegative: ${item.negative || ''}`;
                button.setAttribute('aria-label', `${item.name}, ${item.scope === 'common' ? '공통' : '프로젝트'} 프리셋 추가`);
                const name = element('span', 'canvas-detail-preset-chip-name', item.name);
                const badge = element('span', 'canvas-detail-preset-badge', item.scope === 'common' ? '공통' : '프로젝트');
                button.append(name, badge);
                button.addEventListener('click', () => {
                    const current = getInputs() || {};
                    if (!current.base || !current.negative || current.base.disabled || current.negative.disabled) {
                        renderPickerList();
                        pickerUi.status.textContent = '클립을 선택한 뒤 프리셋을 추가해 주세요.';
                        return;
                    }
                    const appended = appendPromptPair(current.base.value, current.negative.value, item);
                    current.base.value = appended.base;
                    current.negative.value = appended.negative;
                    pickerUi.status.textContent = `‘${item.name}’ 프리셋이 Base와 Negative에 추가되었습니다.`;
                });
                pickerUi.list.appendChild(button);
            }
        }

        function ensurePicker() {
            if (pickerUi) return pickerUi;
            const host = doc?.getElementById('clipDetailPresetPicker');
            if (!host) return null;
            const picker = element('div', 'canvas-detail-preset-container');
            const details = element('details', 'canvas-detail-preset-picker');
            const header = element('div', 'canvas-detail-preset-picker-header');
            const summary = element('summary', '', '디테일 프리셋');
            const manage = element('button', 'secondary canvas-detail-preset-manage-trigger', '관리');
            manage.type = 'button';
            manage.addEventListener('click', () => openManager());
            const body = element('div', 'canvas-detail-preset-picker-body');
            body.appendChild(element('p', 'canvas-detail-preset-help', '누르면 Base·Negative에 함께 추가됩니다. 여러 개를 넣을 수 있습니다.'));
            const filters = element('div', 'canvas-detail-preset-filters');
            const search = element('input', '');
            search.type = 'search';
            search.id = 'canvasDetailPresetSearch';
            search.autocomplete = 'off';
            const category = element('select', '');
            category.id = 'canvasDetailPresetCategory';
            filters.append(labelFor('디테일 프리셋 검색', search), search,
                labelFor('카테고리', category), category);
            const list = element('div', 'canvas-detail-preset-chip-list');
            const listState = element('p', 'canvas-detail-preset-state');
            listState.setAttribute('role', 'status');
            const status = element('p', 'canvas-detail-preset-status');
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            const retry = element('button', 'secondary canvas-detail-preset-retry', '다시 불러오기');
            retry.type = 'button';
            retry.hidden = true;
            retry.addEventListener('click', () => refreshPicker());
            body.append(filters, list, listState, retry, status);
            details.append(summary, body);
            header.append(details, manage);
            picker.appendChild(header);
            host.replaceChildren(picker);
            search.addEventListener('input', () => renderPickerList());
            category.addEventListener('change', () => renderPickerList());
            details.addEventListener('toggle', () => { if (details.open) renderPickerList(); });
            pickerUi = {host, picker, details, manage, search, category, list, listState, retry, status};
            renderPickerCategories();
            return pickerUi;
        }

        function setManagerStatus(message, kind = '') {
            if (!managerUi) return;
            managerUi.status.textContent = message;
            managerUi.status.dataset.state = kind;
            managerUi.reload.hidden = kind !== 'conflict' && kind !== 'error';
        }

        function currentScopeItems() {
            const catalog = state.catalog.manager;
            if (!catalog) return [];
            return state.managerScope === 'project' ? (catalog.project?.items || []) : catalog.common.items;
        }

        function currentRevision() {
            const catalog = state.catalog.manager;
            if (!catalog) return null;
            if (state.managerScope === 'project') return catalog.project?.revision ?? null;
            return catalog.common.revision;
        }

        function managerCanMutate() {
            return Boolean(state.managerOpen && state.catalog.manager && !state.errors.manager
                && !state.managerBusy && !state.managerStale && sameProject(state.managerContextProjectId));
        }

        function getDraft() {
            if (!managerUi) return {name: '', category: '', base: '', negative: ''};
            return {
                name: managerUi.name.value,
                category: managerUi.category.value,
                base: managerUi.base.value,
                negative: managerUi.negative.value
            };
        }

        function baselineDraft() {
            return state.editing?.baseline || {name: '', category: '', base: '', negative: ''};
        }

        function isDraftDirty() {
            return JSON.stringify(getDraft()) !== JSON.stringify(baselineDraft());
        }

        function setDraft(draft) {
            managerUi.name.value = draft?.name || '';
            managerUi.category.value = draft?.category || '';
            managerUi.base.value = draft?.base || '';
            managerUi.negative.value = draft?.negative || '';
        }

        function resetDraft() {
            state.editing = null;
            state.pendingCreate = null;
            setDraft({name: '', category: '', base: '', negative: ''});
            managerUi.formMessage.textContent = '';
            for (const field of [managerUi.name, managerUi.category, managerUi.base, managerUi.negative]) setFieldState(field, false);
            setManagerStatus('새 프리셋 입력 중입니다.');
            renderManagerList();
            syncManagerControls();
        }

        function setFieldState(node, invalid) {
            if (invalid) node.setAttribute('aria-invalid', 'true');
            else node.removeAttribute('aria-invalid');
        }

        function validateDraft(draft) {
            if (!draft.name.trim()) return '이름을 입력해 주세요.';
            if (draft.name.length > 80) return '이름은 80자 이내로 입력해 주세요.';
            if (!draft.category.trim()) return '카테고리를 입력해 주세요.';
            if (draft.category.length > 40) return '카테고리는 40자 이내로 입력해 주세요.';
            if (draft.base.length > 10000 || draft.negative.length > 10000) return 'Base와 Negative는 각각 10000자 이내로 입력해 주세요.';
            if (!draft.base.trim() && !draft.negative.trim()) return 'Base 또는 Negative 중 하나는 입력해 주세요.';
            return '';
        }

        function syncManagerControls() {
            if (!managerUi || !state.managerOpen) return;
            const unavailable = state.managerBusy || state.managerStale;
            for (const control of [managerUi.name, managerUi.category, managerUi.base, managerUi.negative,
                managerUi.scope, managerUi.newButton, managerUi.save]) {
                control.disabled = unavailable;
            }
            managerUi.projectOption.disabled = !currentLink();
            managerUi.scope.disabled = unavailable || Boolean(state.editing);
            managerUi.save.disabled = unavailable || !state.catalog.manager || Boolean(state.errors.manager);
            managerUi.reload.disabled = state.managerBusy;
            managerUi.projectLabel.textContent = currentLink()?.projectName || '프로젝트 연결 없음';
            managerUi.contextWarning.hidden = !state.managerStale;
            if (state.managerStale) managerUi.contextWarning.textContent = '프로젝트 연결이 변경되었습니다. 현재 내용을 저장할 수 없습니다. 창을 닫고 다시 열어 최신 내용을 확인해 주세요.';
            renderManagerList();
        }

        function renderManagerList() {
            if (!managerUi) return;
            const list = managerUi.list;
            list.replaceChildren();
            if (!state.catalog.manager) {
                const message = element('p', 'canvas-detail-preset-state', state.errors.manager || '불러오는 중…');
                list.appendChild(message);
                return;
            }
            if (state.managerScope === 'project' && !state.catalog.manager.project) {
                list.appendChild(element('p', 'canvas-detail-preset-state', '현재 프로젝트 프리셋이 없습니다.'));
                return;
            }
            const items = currentScopeItems();
            if (!items.length) {
                list.appendChild(element('p', 'canvas-detail-preset-state', '이 범위에 프리셋이 없습니다.'));
                return;
            }
            for (const item of items) {
                const card = element('article', 'canvas-detail-preset-manager-card');
                if (state.editing?.scope === state.managerScope && state.editing.id === item.id) {
                    card.className += ' is-selected';
                    card.setAttribute('aria-current', 'true');
                }
                const heading = element('div', 'canvas-detail-preset-manager-card-heading');
                heading.append(element('strong', 'canvas-detail-preset-manager-name', item.name),
                    element('span', 'canvas-detail-preset-manager-category', item.category || '분류 없음'));
                const preview = element('p', 'canvas-detail-preset-manager-preview',
                    `Base: ${item.base || '—'}\nNegative: ${item.negative || '—'}`);
                const actions = element('div', 'canvas-detail-preset-actions');
                const edit = element('button', 'secondary', '수정');
                edit.type = 'button';
                edit.disabled = state.managerBusy || state.managerStale || Boolean(state.errors.manager);
                edit.addEventListener('click', () => beginEdit(item));
                actions.appendChild(edit);
                const copy = element('button', 'secondary', state.managerScope === 'project' ? '공통에 복사' : '프로젝트에 복사');
                copy.type = 'button';
                copy.disabled = state.managerBusy || state.managerStale || Boolean(state.errors.manager) || !currentLink();
                copy.addEventListener('click', () => copyToOtherScope(item));
                actions.appendChild(copy);
                if (state.deleteConfirmId === item.id) {
                    const confirm = element('div', 'canvas-detail-preset-delete-confirm');
                    confirm.appendChild(element('span', '', `‘${item.name}’을(를) 삭제할까요?`));
                    const yes = element('button', 'danger', '삭제');
                    yes.type = 'button';
                    yes.disabled = state.managerBusy || state.managerStale || Boolean(state.errors.manager);
                    yes.addEventListener('click', () => deletePreset(item));
                    const no = element('button', 'secondary', '취소');
                    no.type = 'button';
                    no.disabled = state.managerBusy;
                    no.addEventListener('click', () => { state.deleteConfirmId = null; renderManagerList(); });
                    confirm.append(yes, no);
                    actions.appendChild(confirm);
                } else {
                    const remove = element('button', 'danger', '삭제');
                    remove.type = 'button';
                    remove.disabled = state.managerBusy || state.managerStale || Boolean(state.errors.manager);
                    remove.addEventListener('click', () => {
                        state.deleteConfirmId = item.id;
                        setManagerStatus('삭제할 프리셋을 확인해 주세요.');
                        renderManagerList();
                    });
                    actions.appendChild(remove);
                }
                card.append(heading, preview, actions);
                list.appendChild(card);
            }
        }

        function beginEdit(item) {
            state.managerScope = state.managerScope === 'project' ? 'project' : 'common';
            state.editing = {
                scope: state.managerScope,
                id: item.id,
                baseline: {name: item.name, category: item.category || '', base: item.base || '', negative: item.negative || ''}
            };
            state.pendingCreate = null;
            state.deleteConfirmId = null;
            setDraft(state.editing.baseline);
            managerUi.scope.value = state.managerScope;
            setManagerStatus(`‘${item.name}’ 프리셋 수정 중입니다.`);
            syncManagerControls();
            managerUi.name.focus();
        }

        function copyToOtherScope(item) {
            state.managerScope = state.managerScope === 'project' ? 'common' : 'project';
            state.editing = null;
            state.pendingCreate = null;
            state.deleteConfirmId = null;
            managerUi.scope.value = state.managerScope;
            setDraft({name: item.name, category: item.category || '', base: item.base || '', negative: item.negative || ''});
            setManagerStatus(`${state.managerScope === 'project' ? '프로젝트' : '공통'}에 복사할 내용을 입력했습니다. 저장하면 새 프리셋으로 등록됩니다.`);
            syncManagerControls();
            managerUi.name.focus();
        }

        function ensureManager() {
            if (managerUi) return managerUi;
            const overlay = doc?.getElementById('canvasDetailPresetModal');
            if (!overlay) return null;
            overlay.setAttribute('role', overlay.getAttribute('role') || 'dialog');
            overlay.setAttribute('aria-modal', overlay.getAttribute('aria-modal') || 'true');
            overlay.setAttribute('aria-labelledby', 'canvasDetailPresetTitle');
            const panel = element('section', 'canvas-detail-preset-dialog');
            const header = element('header', 'canvas-detail-preset-dialog-header');
            const title = element('h2', '', '디테일 프리셋 관리');
            title.id = 'canvasDetailPresetTitle';
            title.tabIndex = -1;
            const close = element('button', 'secondary canvas-detail-preset-close', '닫기');
            close.type = 'button';
            close.setAttribute('aria-label', '디테일 프리셋 관리 닫기');
            close.addEventListener('click', () => closeManager());
            header.append(title, close);
            const body = element('div', 'canvas-detail-preset-dialog-body');
            const context = element('div', 'canvas-detail-preset-context');
            context.append(element('span', 'canvas-detail-preset-context-label', '현재 프로젝트'),
                element('strong', 'canvas-detail-preset-project-name'));
            const contextWarning = element('p', 'canvas-detail-preset-warning');
            contextWarning.hidden = true;
            contextWarning.setAttribute('role', 'alert');
            const scopeRow = element('div', 'canvas-detail-preset-scope-row');
            const scope = element('select', '');
            scope.id = 'canvasDetailPresetScope';
            const commonOption = element('option', '', '공통');
            commonOption.value = 'common';
            const projectOption = element('option', '', '현재 프로젝트');
            projectOption.value = 'project';
            scope.append(commonOption, projectOption);
            scopeRow.append(labelFor('관리 범위', scope), scope);
            const statusRow = element('div', 'canvas-detail-preset-manager-status-row');
            const status = element('p', 'canvas-detail-preset-manager-status');
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            const reload = element('button', 'secondary', '최신 목록 다시 불러오기');
            reload.type = 'button';
            reload.hidden = true;
            reload.addEventListener('click', () => reloadManagerPreservingDraft());
            statusRow.append(status, reload);
            const listHeading = element('div', 'canvas-detail-preset-list-heading');
            listHeading.append(element('h3', '', '등록된 프리셋'));
            const newButton = element('button', 'secondary', '새 프리셋');
            newButton.type = 'button';
            newButton.addEventListener('click', () => resetDraft());
            listHeading.appendChild(newButton);
            const list = element('div', 'canvas-detail-preset-manager-list');
            const form = element('form', 'canvas-detail-preset-form');
            form.id = 'canvasDetailPresetForm';
            form.noValidate = true;
            const name = element('input', '');
            name.type = 'text'; name.id = 'canvasDetailPresetName'; name.maxLength = 80; name.autocomplete = 'off';
            const category = element('input', '');
            category.type = 'text'; category.id = 'canvasDetailPresetCategoryInput'; category.maxLength = 40; category.autocomplete = 'off';
            const base = element('textarea', ''); base.setAttribute('data-prompt-autocomplete', '');
            base.id = 'canvasDetailPresetBase'; base.maxLength = 10000; base.rows = 4;
            const negative = element('textarea', ''); negative.setAttribute('data-prompt-autocomplete', '');
            negative.id = 'canvasDetailPresetNegative'; negative.maxLength = 10000; negative.rows = 4;
            const nameGroup = element('div', 'canvas-detail-preset-form-group');
            nameGroup.append(labelFor('이름', name), name);
            const categoryGroup = element('div', 'canvas-detail-preset-form-group');
            categoryGroup.append(labelFor('카테고리', category), category);
            const nameCategory = element('div', 'canvas-detail-preset-name-category');
            nameCategory.append(nameGroup, categoryGroup);
            const baseGroup = element('div', 'canvas-detail-preset-form-group');
            baseGroup.append(labelFor('Base', base), base);
            const negativeGroup = element('div', 'canvas-detail-preset-form-group');
            negativeGroup.append(labelFor('Negative', negative), negative);
            const formMessage = element('p', 'canvas-detail-preset-form-message');
            formMessage.setAttribute('role', 'status');
            form.append(nameCategory, baseGroup, negativeGroup, formMessage);
            const footer = element('footer', 'canvas-detail-preset-dialog-footer');
            const save = element('button', 'primary', '저장');
            save.type = 'submit';
            save.setAttribute('form', form.id);
            save.addEventListener('click', event => {
                // Native form submission remains available; this keeps delegated fake DOMs simple.
                if (typeof form.requestSubmit === 'function') return;
                event.preventDefault?.();
                saveDraft();
            });
            const footerClose = element('button', 'secondary', '닫기');
            footerClose.type = 'button';
            footerClose.addEventListener('click', () => closeManager());
            footer.append(save, footerClose);
            panel.append(header, statusRow, body, footer);
            body.append(context, contextWarning, scopeRow, listHeading, list, form);
            overlay.replaceChildren(panel);
            overlay.hidden = true;
            form.addEventListener('submit', event => { event.preventDefault(); saveDraft(); });
            scope.addEventListener('change', () => {
                const next = scope.value === 'project' && currentLink() ? 'project' : 'common';
                if (isDraftDirty()) {
                    scope.value = state.managerScope;
                    setManagerStatus('저장하지 않은 입력이 있어 범위를 바꾸지 않았습니다. 저장하거나 새 프리셋을 눌러 주세요.');
                    return;
                }
                state.managerScope = next;
                state.deleteConfirmId = null;
                setManagerStatus('');
                syncManagerControls();
            });
            for (const field of [name, category, base, negative]) {
                field.addEventListener('input', () => {
                    formMessage.textContent = '';
                    setFieldState(field, false);
                });
            }
            managerUi = {overlay, panel, title, close, body, projectLabel: context.querySelector('.canvas-detail-preset-project-name'),
                contextWarning, scope, projectOption, status, reload, newButton, list, form, name, category, base, negative,
                formMessage, save, footerClose};
            syncManagerControls();
            return managerUi;
        }

        function setManagerBusy(value) {
            state.managerBusy = value;
            syncManagerControls();
            if (managerUi) {
                managerUi.reload.disabled = value;
                managerUi.close.disabled = false;
                managerUi.footerClose.disabled = false;
            }
        }

        function buildGetUrl(projectId) {
            return API_PATH + (projectId ? '?project_id=' + encodeURIComponent(projectId) : '');
        }

        function applyCatalog(target, payload, expectedProjectId) {
            const catalog = normalizeCatalog(payload, expectedProjectId);
            state.catalog[target] = catalog;
            state.errors[target] = '';
            if (target === 'picker') {
                renderPickerCategories();
                renderPickerList();
            } else {
                managerUi.scope.value = state.managerScope;
                managerUi.projectLabel.textContent = currentLink()?.projectName || '프로젝트 연결 없음';
                setManagerStatus('');
                syncManagerControls();
            }
            return catalog;
        }

        async function loadCatalog(target) {
            if (disposed || !isTargetOpen(target) || !fetchRequest) return;
            const link = currentLink();
            const projectId = link?.projectId || null;
            const ui = target === 'picker' ? ensurePicker() : ensureManager();
            if (!ui) return;
            abortRead(target);
            const generation = state.readGeneration[target];
            const controller = AbortControllerClass ? new AbortControllerClass() : null;
            state.reads[target] = {controller, generation, projectId};
            state.catalog[target] = null;
            state.errors[target] = '';
            if (target === 'picker') {
                pickerUi.listState.hidden = false;
                pickerUi.listState.textContent = '불러오는 중…';
                pickerUi.retry.hidden = true;
                pickerUi.list.replaceChildren();
            } else {
                managerUi.list.replaceChildren(element('p', 'canvas-detail-preset-state', '불러오는 중…'));
                managerUi.save.disabled = true;
            }
            const ticket = generation;
            try {
                const response = await fetchRequest(buildGetUrl(projectId), {
                    method: 'GET', ...(controller ? {signal: controller.signal} : {})
                });
                const payload = await responseJson(response);
                if (disposed || ticket !== state.readGeneration[target] || !isTargetOpen(target) || !sameProject(projectId)) return;
                applyCatalog(target, payload, projectId);
            } catch (error) {
                if (error?.name === 'AbortError' || disposed || ticket !== state.readGeneration[target]
                    || !isTargetOpen(target) || !sameProject(projectId)) return;
                state.catalog[target] = null;
                state.errors[target] = error.message || '디테일 프리셋을 불러오지 못했습니다.';
                if (target === 'picker') {
                    pickerUi.list.replaceChildren();
                    pickerUi.listState.hidden = false;
                    pickerUi.listState.textContent = state.errors.picker;
                pickerUi.retry.hidden = false;
                    pickerUi.status.textContent = '';
                } else {
                    managerUi.list.replaceChildren(element('p', 'canvas-detail-preset-state', state.errors.manager));
                    setManagerStatus(state.errors.manager, 'error');
                    syncManagerControls();
                }
            } finally {
                if (state.reads[target]?.generation === ticket) state.reads[target] = null;
            }
        }

        function refreshPicker() {
            if (disposed) return;
            if (!ensurePicker()) return;
            state.pickerOpen = true;
            renderPickerList();
            void loadCatalog('picker');
        }

        function closePicker() {
            state.pickerOpen = false;
            abortRead('picker');
        }

        function openManager() {
            if (disposed || !ensureManager()) return;
            if (state.managerOpen) return;
            state.managerOpen = true;
            state.managerSession += 1;
            state.managerStale = false;
            state.managerContextProjectId = currentLink()?.projectId || null;
            state.managerScope = 'common';
            state.editing = null;
            state.pendingCreate = null;
            state.deleteConfirmId = null;
            setDraft({name: '', category: '', base: '', negative: ''});
            managerUi.overlay.hidden = false;
            setManagerStatus('불러오는 중…');
            syncManagerControls();
            managerUi.title.focus();
            void loadCatalog('manager');
        }

        function closeManager() {
            if (!state.managerOpen || !managerUi) return;
            state.managerOpen = false;
            state.managerSession += 1;
            managerUi.overlay.hidden = true;
            abortRead('manager');
            state.catalog.manager = null;
            state.errors.manager = '';
            if (state.pickerOpen) void loadCatalog('picker');
        }

        async function reloadManagerPreservingDraft() {
            if (!state.managerOpen || state.managerBusy) return;
            const managerSession = state.managerSession;
            const draft = getDraft();
            const editing = state.editing ? {...state.editing, baseline: {...state.editing.baseline}} : null;
            const pendingCreate = state.pendingCreate ? {...state.pendingCreate} : null;
            state.managerStale = !sameProject(state.managerContextProjectId);
            // A conflict reload uses the captured project context. A changed link requires closing/reopening first.
            if (state.managerStale) {
                setManagerStatus('프로젝트 연결이 바뀌었습니다. 창을 닫고 다시 열어 주세요.', 'error');
                return;
            }
            state.errors.manager = '';
            await loadCatalog('manager');
            if (state.managerOpen && state.managerSession === managerSession && sameProject(state.managerContextProjectId)) {
                if (!state.catalog.manager || state.errors.manager) return;
                setDraft(draft);
                state.editing = editing;
                state.pendingCreate = pendingCreate;
                setManagerStatus('최신 목록을 불러왔습니다. 입력 내용을 검토한 뒤 저장해 주세요.');
                syncManagerControls();
            }
        }

        function mutationScope() {
            const link = currentLink();
            return {
                scope: state.managerScope,
                projectId: link?.projectId || null,
                contextProjectId: state.managerContextProjectId,
                revision: currentRevision()
            };
        }

        async function mutation(method, body, capture) {
            if (state.managerBusy) return false;
            if (capture.contextProjectId !== (currentLink()?.projectId || null)) {
                state.managerStale = true;
                setManagerStatus('프로젝트 연결이 변경되었습니다. 현재 편집 내용을 저장하지 않았습니다. 창을 닫고 다시 열어 주세요.', 'error');
                syncManagerControls();
                return false;
            }
            if (capture.scope === 'project' && !capture.projectId) {
                setManagerStatus('프로젝트 범위 프리셋은 프로젝트 연결이 필요합니다.', 'error');
                return false;
            }
            if (!Number.isSafeInteger(capture.revision)) {
                setManagerStatus('최신 프리셋 목록을 불러온 뒤 다시 시도해 주세요.', 'error');
                return false;
            }
            const contextId = capture.contextProjectId;
            const managerSession = state.managerSession;
            setManagerBusy(true);
            setManagerStatus(method === 'DELETE' ? '삭제하는 중…' : '저장하는 중…');
            try {
                const response = await fetchRequest(API_PATH, {
                    method,
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(body)
                });
                const payload = await responseJson(response);
                if (!sameProject(contextId) || state.managerContextProjectId !== contextId
                    || state.managerSession !== managerSession || !state.managerOpen) {
                    return false;
                }
                applyCatalog('manager', payload, contextId);
                state.errors.manager = '';
                return true;
            } catch (error) {
                if (sameProject(contextId) && state.managerOpen && state.managerContextProjectId === contextId
                    && state.managerSession === managerSession) {
                    if (error.status === 409) {
                        state.errors.manager = 'conflict';
                        setManagerStatus('다른 창에서 목록이 변경되었습니다. 최신 목록을 불러와 내용을 검토한 뒤 다시 저장해 주세요.', 'conflict');
                    } else {
                        setManagerStatus(error.message || '저장하지 못했습니다. 입력 내용은 유지됩니다.', 'error');
                    }
                }
                return false;
            } finally {
                if (state.managerSession === managerSession) {
                    setManagerBusy(false);
                } else {
                    // Do not render an old operation's response into a reopened manager session.
                    state.managerBusy = false;
                    if (state.managerOpen) void loadCatalog('manager');
                }
                if (state.pickerOpen && sameProject(contextId) && !state.managerOpen) void loadCatalog('picker');
            }
        }

        async function saveDraft() {
            if (state.managerBusy || !state.managerOpen) return;
            if (!managerCanMutate()) {
                if (state.managerStale) setManagerStatus('프로젝트 연결이 변경되었습니다. 창을 닫고 다시 열어 주세요.', 'error');
                return;
            }
            const draft = getDraft();
            const invalid = validateDraft(draft);
            for (const [field, value] of [[managerUi.name, !draft.name.trim() || draft.name.length > 80],
                [managerUi.category, !draft.category.trim() || draft.category.length > 40], [managerUi.base, draft.base.length > 10000],
                [managerUi.negative, draft.negative.length > 10000]]) setFieldState(field, value);
            if (invalid) {
                managerUi.formMessage.textContent = invalid;
                setManagerStatus('입력 내용을 확인해 주세요.');
                return;
            }
            const capture = mutationScope();
            if (!capture.contextProjectId && currentLink()?.projectId) capture.contextProjectId = currentLink().projectId;
            if (!Number.isSafeInteger(capture.revision)) {
                managerUi.formMessage.textContent = '최신 목록을 불러온 뒤 저장해 주세요.';
                return;
            }
            const editing = state.editing;
            let method;
            let id;
            if (editing) {
                if (editing.scope !== capture.scope) {
                    setManagerStatus('수정 중인 프리셋의 범위는 바꿀 수 없습니다.');
                    return;
                }
                method = 'PUT';
                id = editing.id;
            } else {
                method = 'POST';
                const key = `${capture.scope}:${capture.projectId || ''}`;
                if (!state.pendingCreate || state.pendingCreate.key !== key) {
                    const createdId = getUuid();
                    if (typeof createdId !== 'string' || !createdId) {
                        setManagerStatus('이 브라우저에서 안전한 프리셋 ID를 만들 수 없습니다.', 'error');
                        return;
                    }
                    state.pendingCreate = {key, id: createdId};
                }
                id = state.pendingCreate.id;
            }
            const body = {scope: capture.scope, projectId: capture.projectId, revision: capture.revision,
                preset: {id, name: draft.name, category: draft.category, base: draft.base, negative: draft.negative}};
            const succeeded = await mutation(method, body, capture);
            if (succeeded) {
                state.editing = null;
                state.pendingCreate = null;
                state.deleteConfirmId = null;
                setDraft({name: '', category: '', base: '', negative: ''});
                managerUi.formMessage.textContent = '';
                for (const field of [managerUi.name, managerUi.category, managerUi.base, managerUi.negative]) setFieldState(field, false);
                setManagerStatus(method === 'PUT' ? '프리셋을 수정했습니다.' : '새 프리셋을 저장했습니다.');
                syncManagerControls();
                if (pickerUi) {
                    // Preserve picker query and category; replace only its catalog data and cards.
                    state.catalog.picker = state.catalog.manager;
                    renderPickerCategories();
                    renderPickerList();
                }
            }
        }

        async function deletePreset(item) {
            if (!managerCanMutate() || state.managerBusy) return;
            const managerSession = state.managerSession;
            const capture = mutationScope();
            const body = {scope: capture.scope, projectId: capture.projectId, revision: capture.revision, id: item.id};
            const succeeded = await mutation('DELETE', body, capture);
            if (!state.managerOpen || state.managerSession !== managerSession) return;
            if (succeeded) {
                if (state.editing?.id === item.id && state.editing.scope === capture.scope) {
                    state.editing = null;
                    setDraft({name: '', category: '', base: '', negative: ''});
                }
                state.deleteConfirmId = null;
                setManagerStatus(`‘${item.name}’ 프리셋을 삭제했습니다.`);
                syncManagerControls();
                if (pickerUi) {
                    state.catalog.picker = state.catalog.manager;
                    renderPickerCategories();
                    renderPickerList();
                }
            } else {
                state.deleteConfirmId = item.id;
                renderManagerList();
            }
        }

        function linkChanged() {
            const nextProjectId = currentLink()?.projectId || null;
            if (nextProjectId === state.lastProjectId) return;
            state.lastProjectId = nextProjectId;
            abortAllReads();
            state.catalog.picker = null;
            state.catalog.manager = null;
            state.errors.picker = '';
            state.errors.manager = '';
            if (pickerUi) {
                pickerUi.list.replaceChildren();
                pickerUi.listState.hidden = false;
                pickerUi.listState.textContent = state.pickerOpen ? '프로젝트 연결이 바뀌었습니다. 불러오는 중…' : '';
            }
            if (state.managerOpen) {
                state.managerStale = true;
                setManagerStatus('프로젝트 연결이 변경되어 현재 편집 내용을 저장할 수 없습니다.', 'error');
                syncManagerControls();
            }
            if (state.pickerOpen) void loadCatalog('picker');
            if (state.managerOpen) void loadCatalog('manager');
        }

        function dispose() {
            disposed = true;
            state.pickerOpen = false;
            state.managerOpen = false;
            abortAllReads();
        }

        if (win?.addEventListener) win.addEventListener('pagehide', dispose, {once: true});

        return {refreshPicker, closePicker, openManager, closeManager, linkChanged, dispose,
            getState: () => ({...state, catalog: {...state.catalog}})};
    }

    const api = {appendPromptText, appendPromptPair, filterPresets, normalizeCatalog, createCanvasDetailPresetsController};
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root === 'object' && root.document) {
        root.CanvasDetailPresets = root.CanvasDetailPresets || createCanvasDetailPresetsController({window: root});
    }
})(typeof window !== 'undefined' ? window : globalThis);
