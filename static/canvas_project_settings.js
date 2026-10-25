/* Project recipes group existing text; only generation settings change canvas values. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root?.document) return;
    const doc = root.document;
    const controller = api.create({
        getLink: () => root.CanvasProject?.localLink(),
        fetch: (...args) => root.fetch(...args),
        styleRules: root.CanvasStyleLink,
        setStyle: value => getCanvasStyleLink()?.restore(value),
        setInpaint: value => root.CanvasInpaintSettings?.update(value),
        save: () => saveCanvasState(),
        render: () => {
            if (doc.getElementById('clipPromptModalOverlay')?.classList.contains('open')) renderAllClipPromptTokens();
            renderReferenceStylePromptPreview();
        },
        canApply: () => !doc.getElementById('clipPromptModalOverlay')?.classList.contains('open')
            && !doc.getElementById('canvasInpaintSettingsDialog')?.open
            && doc.getElementById('referenceGenPromptLayer')?.style.display !== 'flex'
            && doc.getElementById('canvasStyleLinkModal')?.style.display !== 'flex',
        status: (state, message) => {
            const label = doc.getElementById('canvasProjectSettingsMessage');
            if (label) { label.textContent = message; label.dataset.state = state; }
            const retry = doc.getElementById('canvasProjectSettingsRetry');
            if (retry) retry.hidden = state !== 'error';
        },
    });
    root.CanvasProjectSettings = controller;
    let channel;
    let timer;
    const refresh = () => { if (!doc.hidden) void controller.refresh(); };
    const changed = message => {
        if (message?.projectId === root.CanvasProject?.localLink()?.projectId) refresh();
    };
    function start() {
        if (timer) return;
        if (typeof root.BroadcastChannel === 'function') {
            channel = new root.BroadcastChannel('naim-project-canvas-settings');
            channel.onmessage = event => changed(event.data);
        }
        timer = root.setInterval(refresh, 5000);
        controller.linkChanged();
    }
    root.addEventListener('daki-project-settings-changed', event => changed(event.detail));
    root.addEventListener('focus', refresh);
    doc.addEventListener('visibilitychange', refresh);
    root.addEventListener('pagehide', () => {
        root.clearInterval(timer); timer = null;
        channel?.close(); channel = null;
        controller.cancel();
    });
    root.addEventListener('pageshow', start);
    doc.addEventListener('DOMContentLoaded', start);
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
    const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    const key = link => link ? `${link.projectId}:${link.canvasId}:${link.side}` : '';
    const prompt = value => {
        const result = {basePrompt: typeof value?.basePrompt === 'string' ? value.basePrompt : '',
            negativePrompt: typeof value?.negativePrompt === 'string' ? value.negativePrompt : ''};
        if (Array.isArray(value?.charPrompts) && value.charPrompts.length <= 22
            && value.charPrompts.every(item => typeof item === 'string' && item.length <= 100000)) {
            result.charPrompts = value.charPrompts.slice();
        }
        return result;
    };

    function create(options) {
        let saved = null;
        let contextKey = '';
        let epoch = 0;
        let pending = null;
        let aborter = null;
        let again = false;
        const status = options.status || (() => {});
        const render = options.render || (() => {});
        const snapshot = () => clone(saved);

        function cancel() {
            epoch += 1;
            aborter?.abort();
            aborter = null;
            pending = null;
            again = false;
        }

        function restore(value) {
            cancel();
            contextKey = '';
            saved = value && /^[a-f0-9]{32}$/.test(value.projectId)
                && ['front', 'back'].includes(value.side) && Number.isSafeInteger(value.revision)
                && value.revision >= 0 ? {
                    projectId: value.projectId, side: value.side, revision: value.revision,
                    style: clone(value.style), prompt: prompt(value.prompt),
                    inpaintSettings: clone(value.inpaintSettings),
                    expanded: {base: value.expanded?.base === true, negative: value.expanded?.negative === true,
                        ...(Array.isArray(value.expanded?.characters) && value.expanded.characters.length <= 22
                            && value.expanded.characters.every(item => typeof item === 'boolean')
                            ? {characters: value.expanded.characters.slice()} : {})},
                } : null;
        }

        function apply(settings, link) {
            if (!settings || !Number.isSafeInteger(settings.revision) || settings.revision < 0
                || !settings.prompts || !Object.hasOwn(settings, 'style')
                || !Object.hasOwn(settings, 'inpaintSettings')) throw new Error('프로젝트 연동 설정 형식이 올바르지 않습니다.');
            const same = saved?.projectId === link.projectId && saved?.side === link.side;
            if (same && saved.revision === settings.revision) return false;
            if (same && saved.revision > settings.revision) return false;
            if (options.canApply && !options.canApply()) {
                status('waiting', '프롬프트·설정 편집창을 닫으면 프로젝트 변경이 반영됩니다.');
                return false;
            }
            const nextPrompt = prompt(settings.prompts[link.side]);
            if ((!same || !equal(saved.style, settings.style)) && (settings.style || (same && saved.style))) {
                options.setStyle(settings.style
                    ? {mode: 'manual', style: clone(settings.style)} : {mode: 'off', style: null});
            }
            if (settings.inpaintSettings && (!same || !equal(saved.inpaintSettings, settings.inpaintSettings))) {
                options.setInpaint(clone(settings.inpaintSettings));
            }
            const samePrompt = same && equal(saved.prompt, nextPrompt);
            const expanded = samePrompt
                ? {...saved.expanded, ...(saved.expanded.characters ? {characters: saved.expanded.characters.slice()} : {})}
                : {base: false, negative: false,
                    ...(nextPrompt.charPrompts ? {characters: Array(nextPrompt.charPrompts.length).fill(false)} : {})};
            saved = {projectId: link.projectId, side: link.side, revision: settings.revision,
                style: clone(settings.style), prompt: nextPrompt, inpaintSettings: clone(settings.inpaintSettings), expanded};
            render();
            options.save();
            return true;
        }

        async function refresh() {
            const link = options.getLink();
            if (!link) return;
            if (key(link) !== contextKey) {
                cancel();
                contextKey = key(link);
            }
            if (pending) { again = true; return pending; }
            const token = epoch;
            const capturedKey = contextKey;
            aborter = new AbortController();
            const signal = aborter.signal;
            const current = () => token === epoch && key(options.getLink()) === capturedKey;
            pending = (async () => {
                try {
                    const response = await options.fetch('/api/daki/projects/' + encodeURIComponent(link.projectId) + '/canvas-settings', {signal});
                    const result = await response.json();
                    if (!current()) return;
                    if (!response.ok || result.status !== 'success') throw new Error(result.message || '연동 설정을 불러오지 못했습니다.');
                    apply(result.settings, link);
                    if (saved?.projectId === link.projectId && saved?.side === link.side
                        && saved.revision === result.settings.revision) {
                        const active = saved.style || saved.prompt.basePrompt || saved.prompt.negativePrompt
                            || saved.prompt.charPrompts?.some(value => value.length > 0) || saved.inpaintSettings;
                        status('saved', active ? '프로젝트 연동 적용됨 · 기존 프롬프트 유지' : '프로젝트 연동 설정 없음');
                    }
                } catch (error) {
                    if (current() && error.name !== 'AbortError') status('error', '프로젝트 연동 설정 확인 실패. ' + error.message);
                } finally {
                    if (token === epoch) {
                        pending = null; aborter = null;
                        if (again) { again = false; void refresh(); }
                    }
                }
            })();
            return pending;
        }

        function linkChanged() {
            const next = key(options.getLink());
            if (next === contextKey) return;
            cancel();
            contextKey = next;
            // Disconnecting stops propagation but keeps the last copied settings and groups.
            if (next) void refresh();
            else status('idle', '');
        }

        function groupParts(field, parts, characterIndex = null) {
            const isCharacter = typeof field === 'string' && field.startsWith('char-')
                && Number.isSafeInteger(characterIndex) && characterIndex >= 0 && characterIndex < 22;
            if (!saved || (!['base', 'negative'].includes(field) && !isCharacter) || !options.styleRules) return parts;
            const link = options.getLink();
            if (link && (saved.projectId !== link.projectId || saved.side !== link.side)) return parts;
            const characterRecipe = isCharacter ? saved.prompt.charPrompts?.[characterIndex] : null;
            if (isCharacter && (typeof characterRecipe !== 'string' || !characterRecipe.trim())) return parts;
            const occupied = new Set(parts.filter(part => part.type === 'style').flatMap(part => part.indexes));
            const available = parts.filter(part => part.type !== 'style' && !occupied.has(part.index));
            const sideName = saved.side === 'front' ? '앞면' : '뒷면';
            const expanded = isCharacter ? saved.expanded.characters?.[characterIndex] === true
                : saved.expanded[field] === true;
            const grouped = options.styleRules.groupParts({library: 'project',
                name: isCharacter ? `${sideName} 캐릭터 ${characterIndex + 1}` : `${sideName} 프롬프트`,
                positive: isCharacter ? characterRecipe : saved.prompt.basePrompt,
                negative: isCharacter ? '' : saved.prompt.negativePrompt},
            isCharacter ? 'base' : field, available,
            expanded);
            const marker = grouped.find(part => part.type === 'style');
            if (!marker) return parts;
            const indexes = new Set(marker.indexes);
            const result = [];
            for (const part of parts) {
                if (part.index === marker.indexes[0]) result.push({...marker, projectPrompt: true,
                    ...(isCharacter ? {characterIndex} : {})});
                if (part.type === 'style' || expanded || !indexes.has(part.index)) result.push(part);
            }
            return result;
        }

        function toggleExpanded(field, characterIndex = null) {
            if (!saved) return;
            if (field === 'base' || field === 'negative') {
                saved.expanded[field] = !saved.expanded[field];
            } else if (typeof field === 'string' && field.startsWith('char-')
                && Number.isSafeInteger(characterIndex) && characterIndex >= 0 && characterIndex < 22
                && typeof saved.prompt.charPrompts?.[characterIndex] === 'string'
                && saved.prompt.charPrompts[characterIndex].trim()) {
                const characters = Array.isArray(saved.expanded.characters)
                    ? saved.expanded.characters.slice()
                    : Array(saved.prompt.charPrompts.length).fill(false);
                while (characters.length <= characterIndex) characters.push(false);
                characters[characterIndex] = !characters[characterIndex];
                saved.expanded.characters = characters;
            } else return;
            render();
            options.save();
        }
        return {snapshot, restore, refresh, linkChanged, groupParts, toggleExpanded, cancel};
    }
    return {create};
});
