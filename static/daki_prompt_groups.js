(function (root) {
    'use strict';
    const doc = root.document;
    const make = (tag, className, text) => {
        const item = doc.createElement(tag);
        if (className) item.className = className;
        if (text !== undefined) item.textContent = text;
        return item;
    };
    const button = (label, action, className = '') => {
        const item = make('button', className, label);
        item.type = 'button'; item.onclick = action;
        return item;
    };
    const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

    function create({input, label, onChange, onFocus} = {}) {
        if (!input || !input.parentNode) throw new TypeError('A prompt textarea is required.');
        const element = make('section', 'daki-prompt-groups');
        const toolbar = make('div', 'daki-prompt-groups-toolbar');
        const nameInput = make('input', 'daki-prompt-group-name');
        nameInput.type = 'text'; nameInput.maxLength = 60; nameInput.value = '임시 그룹';
        nameInput.setAttribute('aria-label', '임시 묶음 이름');
        const groupButton = button('선택 영역 묶기', groupSelection, 'daki-prompt-group-create');
        const viewButton = button('묶음 보기', toggleView, 'daki-prompt-group-view-toggle');
        const hint = make('p', 'daki-prompt-groups-hint', '임시 묶음 · 태그 내용은 그대로 전송됩니다.');
        const status = make('p', 'daki-prompt-groups-status');
        status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        const view = make('div', 'daki-prompt-groups-view');
        toolbar.append(nameInput, groupButton, viewButton);
        element.append(toolbar, hint, status, view);
        input.parentNode.parentNode.appendChild(element);

        let parts = [{type: 'text', text: input.value || ''}];
        let lastValue = input.value || '', groupedView = false, disposed = false;
        let lastFocusedInput = input, lastFocusedPart = null, editors = [];
        const sourceFocus = input.onfocus;
        input.onfocus = event => { lastFocusedInput = input; lastFocusedPart = null; sourceFocus?.(event); };

        function hasGroups() { return parts.some(part => part.type === 'group'); }
        function canonical() { return parts.map(part => part.text).join(''); }
        function isDisabled() { return !!(input.disabled || input.matches?.(':disabled') || element.matches?.(':disabled')); }
        function setStatus(message = '') { status.textContent = message; }
        function notifyFocus(target) {
            lastFocusedInput = target;
            onFocus?.(target);
        }
        function refresh() {
            if (disposed) return;
            const disabled = isDisabled();
            const wrapper = input.parentNode;
            wrapper.hidden = groupedView;
            view.hidden = !groupedView;
            nameInput.disabled = groupButton.disabled = disabled;
            viewButton.disabled = disabled;
            viewButton.hidden = !hasGroups();
            viewButton.textContent = groupedView ? '전체 텍스트 편집' : '묶음 보기';
            editors.forEach(({textarea}) => { textarea.disabled = disabled; });
            view.querySelectorAll('button').forEach(item => { item.disabled = disabled; });
        }
        function saveSegment(part, textarea) {
            if (disposed) return;
            part.text = textarea.value;
            input.value = canonical(); lastValue = input.value;
            setStatus(); onChange?.();
        }
        function render() {
            if (disposed) return;
            editors = [];
            view.replaceChildren();
            parts.forEach((part, index) => {
                if (part.type === 'group') {
                    const details = make('details', 'daki-prompt-group');
                    details.open = !part.collapsed;
                    const summary = make('summary', 'daki-prompt-group-summary', part.name);
                    summary.setAttribute('aria-label', part.name + ' 묶음');
                    details.ontoggle = () => { part.collapsed = !details.open; };
                    const textarea = make('textarea', 'daki-prompt-group-text', part.text); textarea.setAttribute('data-prompt-autocomplete', '');
                    textarea.value = part.text;
                    textarea.rows = 3; textarea.maxLength = 30000;
                    textarea.setAttribute('aria-label', label + ' · ' + part.name);
                    textarea.onfocus = () => { lastFocusedPart = part; notifyFocus(textarea); };
                    textarea.oninput = textarea.onchange = () => saveSegment(part, textarea);
                    const ungroup = button('그룹 해제', () => ungroupPart(part), 'daki-prompt-group-remove');
                    const content = make('div', 'daki-prompt-group-content');
                    content.append(textarea, ungroup); details.append(summary, content); view.appendChild(details);
                    editors.push({part, textarea, index});
                } else {
                    const textarea = make('textarea', 'daki-prompt-text-segment'); textarea.setAttribute('data-prompt-autocomplete', '');
                    textarea.value = part.text; textarea.rows = part.text ? 2 : 1; textarea.maxLength = 30000;
                    textarea.setAttribute('aria-label', label + ' · 묶음 사이 텍스트');
                    textarea.onfocus = () => { lastFocusedPart = part; notifyFocus(textarea); };
                    textarea.oninput = textarea.onchange = () => saveSegment(part, textarea);
                    view.appendChild(textarea); editors.push({part, textarea, index});
                }
            });
            refresh();
        }
        function focusPart(part) {
            const entry = editors.find(item => item.part === part);
            if (entry) { entry.textarea.focus(); return; }
            const textEntry = editors.find(item => item.part.type === 'text');
            if (textEntry) textEntry.textarea.focus();
        }
        function adjacentText(groupPart) {
            const index = parts.indexOf(groupPart);
            return parts.slice(index + 1).find(part => part.type === 'text')
                || parts.slice(0, index).reverse().find(part => part.type === 'text');
        }
        function flush() {
            if (disposed) return input.value;
            const current = input.value || '';
            if (current !== lastValue) {
                const hadGroups = hasGroups();
                parts = [{type: 'text', text: current}];
                lastValue = current; groupedView = false;
                lastFocusedInput = input; lastFocusedPart = null;
                if (hadGroups) setStatus('전체 텍스트가 바뀌어 이전 임시 묶음을 해제했습니다.');
                render();
                return current;
            }
            if (groupedView) {
                editors.forEach(({part, textarea}) => { part.text = textarea.value; });
                input.value = canonical(); lastValue = input.value;
            }
            return input.value;
        }
        function groupSelection() {
            if (disposed || isDisabled()) return;
            flush();
            const target = groupedView ? (lastFocusedInput || input) : input;
            const start = target.selectionStart, end = target.selectionEnd;
            if (!Number.isInteger(start) || !Number.isInteger(end) || start >= end) {
                setStatus('묶을 프롬프트 범위를 먼저 선택해 주세요.'); return;
            }
            let globalStart = start, globalEnd = end;
            if (target !== input) {
                const owner = editors.find(item => item.textarea === target);
                if (!owner || owner.part.type !== 'text') {
                    setStatus('기존 묶음 안에서는 새 묶음을 만들 수 없습니다.'); return;
                }
                const ownerStart = parts.slice(0, parts.indexOf(owner.part)).reduce((sum, part) => sum + part.text.length, 0);
                globalStart += ownerStart; globalEnd += ownerStart;
            }
            const name = nameInput.value.trim().slice(0, 60) || '임시 그룹';
            const before = [], after = [];
            let selected = '', offset = 0, overlapsGroup = false;
            for (const part of parts) {
                const partStart = offset, partEnd = offset + part.text.length, length = part.text.length;
                offset = partEnd;
                if (part.type === 'group') {
                    if (globalStart < partEnd && globalEnd > partStart) { overlapsGroup = true; break; }
                    (partEnd <= globalStart ? before : after).push(part);
                    continue;
                }
                if (partEnd <= globalStart) { before.push(part); continue; }
                if (partStart >= globalEnd) { after.push(part); continue; }
                const leftEnd = clamp(globalStart - partStart, 0, length);
                const rightStart = clamp(globalEnd - partStart, 0, length);
                if (leftEnd > 0) before.push({type: 'text', text: part.text.slice(0, leftEnd)});
                else if (partStart < globalStart) before.push({type: 'text', text: ''});
                selected += part.text.slice(leftEnd, rightStart);
                if (rightStart < length) after.push({type: 'text', text: part.text.slice(rightStart)});
                else if (partEnd > globalEnd) after.push({type: 'text', text: ''});
            }
            if (overlapsGroup) { setStatus('기존 묶음과 겹치지 않는 텍스트 범위를 선택해 주세요.'); return; }
            if (selected !== input.value.slice(globalStart, globalEnd)) {
                setStatus('선택한 범위를 확인할 수 없습니다. 전체 텍스트 편집에서 다시 선택해 주세요.'); return;
            }
            const group = {type: 'group', text: selected, name, collapsed: true};
            if (!before.length || before.at(-1).type !== 'text') before.push({type: 'text', text: ''});
            if (!after.length || after[0].type !== 'text') after.unshift({type: 'text', text: ''});
            parts = [...before, group, ...after];
            groupedView = true; lastValue = canonical(); input.value = lastValue; setStatus(); render();
            focusPart(adjacentText(group));
        }
        function ungroupPart(group) {
            if (disposed || isDisabled()) return;
            const index = parts.indexOf(group);
            if (index < 0) return;
            const text = {type: 'text', text: group.text};
            parts.splice(index, 1, text);
            input.value = canonical(); lastValue = input.value;
            if (!hasGroups()) groupedView = false;
            setStatus(); render();
            if (groupedView) focusPart(text); else input.focus();
        }
        function toggleView() {
            if (disposed || isDisabled() || !hasGroups()) return;
            flush(); groupedView = !groupedView; render();
            if (groupedView) {
                const part = lastFocusedPart && parts.includes(lastFocusedPart) ? lastFocusedPart : parts.find(item => item.type === 'text');
                focusPart(part);
            } else { lastFocusedInput = input; lastFocusedPart = null; input.focus(); }
        }
        function groupPrefix(prefix, name) {
            if (disposed) return false;
            flush();
            const current = input.value || '', trimmed = String(prefix || '').trim();
            if (!trimmed || hasGroups() || !current.startsWith(trimmed)) return false;
            const suffix = current.slice(trimmed.length);
            if (suffix && !/^[,\s]/.test(suffix)) return false;
            const group = {type: 'group', text: trimmed, name: String(name || '').trim().slice(0, 60) || '임시 그룹', collapsed: true};
            parts = [{type: 'text', text: ''}, group, {type: 'text', text: suffix}];
            groupedView = true; lastValue = current; setStatus(); render();
            return true;
        }
        function firstInput() {
            const target = groupedView ? (editors.find(item => item.part.type === 'text')?.textarea || editors[0]?.textarea || input) : input;
            lastFocusedInput = target;
            lastFocusedPart = editors.find(item => item.textarea === target)?.part || null;
            return target;
        }
        function valueFor(target) {
            if (disposed) return null;
            flush();
            return target === input || editors.some(item => item.textarea === target) ? input.value : null;
        }
        function insertTag(target, tag, start, end) {
            if (disposed || isDisabled()) return false;
            flush();
            const owner = editors.find(item => item.textarea === target);
            if (!groupedView || !owner) return false;
            const partStart = parts.slice(0, parts.indexOf(owner.part)).reduce((sum, part) => sum + part.text.length, 0);
            const globalStart = partStart + start, globalEnd = partStart + end;
            const beforeText = target.value.slice(0, start), afterText = target.value.slice(end);
            const before = input.value.slice(0, globalStart), after = input.value.slice(globalEnd);
            const insertion = (before && !/[,\s]$/.test(before) ? ', ' : '') + tag
                + (after && !/^[,\s]/.test(after) ? ', ' : '');
            target.value = beforeText + insertion + afterText;
            target.setSelectionRange?.(beforeText.length + insertion.length, beforeText.length + insertion.length);
            saveSegment(owner.part, target);
            return true;
        }
        function reset() {
            if (disposed) return;
            parts = [{type: 'text', text: input.value || ''}];
            lastValue = input.value || ''; groupedView = false; lastFocusedPart = null;
            setStatus(); render();
        }
        function dispose() {
            if (disposed) return;
            disposed = true; input.onfocus = sourceFocus; element.remove(); editors = [];
        }
        render();
        return {element, flush, refresh, reset, groupPrefix, firstInput, valueFor, insertTag, dispose};
    }

    root.DakiPromptGroups = {create};
})(window);
