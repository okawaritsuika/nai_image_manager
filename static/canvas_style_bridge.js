// Canvas owns prompts and persistence; the style controller owns display-only links.
let canvasStyleLinkController = null;
let canvasStyleRefreshQueued = false;

function getCanvasStylePromptSource() {
    if (el('referenceGenPromptLayer')?.style.display === 'flex') {
        return {basePrompt: el('referenceGenBasePrompt')?.value || '', negativePrompt: el('referenceGenNegativePrompt')?.value || ''};
    }
    if (el('clipPromptModalOverlay')?.classList.contains('open')) {
        return {basePrompt: getClipPromptEditorValue('base'), negativePrompt: getClipPromptEditorValue('negative')};
    }
    if (hasSharedSelectionClipPrompt()) return getSharedSelectionClipPromptInfo();
    const images = getAllCanvasLayerNodes().filter(layer => layer?.type === 'image' && hasAnyPromptText(layer.promptInfo));
    return images.find(layer => layer.visible !== false)?.promptInfo || images[0]?.promptInfo || {};
}

function getCanvasStyleLink() {
    if (!canvasStyleLinkController && typeof CanvasStyleLink !== 'undefined') {
        canvasStyleLinkController = CanvasStyleLink.create({
            document,
            fetch: (...args) => fetch(...args),
            getPrompt: getCanvasStylePromptSource,
            onChange: () => saveCanvasState(),
            onRender: () => {
                if (el('clipPromptModalOverlay')?.classList.contains('open')) renderAllClipPromptTokens();
                renderReferenceStylePromptPreview();
            }
        });
        for (const id of ['clipStyleLinkToolbar', 'referenceStyleLinkToolbar']) {
            const host = el(id);
            if (host) canvasStyleLinkController.mount(host);
        }
    }
    return canvasStyleLinkController;
}

function refreshCanvasStyleLink() {
    if (canvasStyleRefreshQueued) return;
    canvasStyleRefreshQueued = true;
    queueMicrotask(() => {
        canvasStyleRefreshQueued = false;
        getCanvasStyleLink()?.refresh({load: true});
    });
}

function closeCanvasStyleLinkPicker() {
    getCanvasStyleLink()?.closePicker();
}

function openCanvasStyleLinkPicker() {
    getCanvasStyleLink()?.openPicker();
}

function buildCanvasStylePromptParts(fieldKey, indexedTokens) {
    const controller = getCanvasStyleLink();
    const styleParts = controller ? controller.groupParts(fieldKey, indexedTokens) : indexedTokens;
    const characterFields = typeof getClipPromptFields === 'function'
        ? getClipPromptFields().filter(field => field?.isChar)
        : [];
    const characterIndex = characterFields.findIndex(field => field.key === fieldKey);
    const projectSettings = window.CanvasProjectSettings;
    const styled = projectSettings
        ? (characterIndex >= 0
            ? projectSettings.groupParts(fieldKey, styleParts, characterIndex)
            : projectSettings.groupParts(fieldKey, styleParts)) || styleParts
        : styleParts;
    const result = [];
    let pending = [];
    for (const part of styled) {
        if (part.type === 'style') {
            result.push(...applyClipPromptGroupsWithIndexes(pending), part);
            pending = [];
        } else pending.push(part);
    }
    result.push(...applyClipPromptGroupsWithIndexes(pending));
    return result;
}

function renderCanvasStylePromptButton(surface, fieldKey, part, disabledState = null) {
    const button = document.createElement('button');
    button.type = 'button';
    const disabled = disabledState && isClipPromptGroupDisabledByControls(part.tokens, disabledState);
    button.className = `prompt-token-btn group canvas-style-token${disabled ? ' disabled-by-control' : ''}`;
    button.style.setProperty('--group-color', getClipPromptGroupColor(part.name));
    button.textContent = `[${part.projectPrompt ? part.name : '그림체: ' + part.name}] ${part.expanded ? '접기' : '펼치기'} · ${part.tokens.length}`;
    button.title = part.tokens.join(', ');
    button.setAttribute('aria-expanded', String(part.expanded));
    button.onclick = event => {
        event.preventDefault();
        event.stopPropagation();
        if (part.projectPrompt) {
            if (Number.isSafeInteger(part.characterIndex)) {
                window.CanvasProjectSettings?.toggleExpanded(fieldKey, part.characterIndex);
            } else window.CanvasProjectSettings?.toggleExpanded(fieldKey);
        }
        else getCanvasStyleLink()?.toggleExpanded(fieldKey);
    };
    // Style tags may be non-contiguous: never select the min/max index range.
    // Existing control groups still accept the precise token list via drag.
    if (disabledState && !part.expanded) {
        button.draggable = true;
        button.ondragstart = event => setClipPromptDragData(event, {
            field: fieldKey, type: 'group', name: part.name, tokens: part.tokens
        });
    }
    surface.appendChild(button);
}

function renderReferenceStylePromptPreview() {
    if (typeof referenceGenSession === 'undefined' || !referenceGenSession) return;
    const controller = getCanvasStyleLink();
    for (const [field, inputId, hostId] of [
        ['base', 'referenceGenBasePrompt', 'referenceGenBaseStylePreview'],
        ['negative', 'referenceGenNegativePrompt', 'referenceGenNegativeStylePreview']
    ]) {
        const input = el(inputId), host = el(hostId);
        if (!input || !host) continue;
        if (!input.dataset.canvasStyleBound) {
            input.dataset.canvasStyleBound = '1';
            input.addEventListener('input', renderReferenceStylePromptPreview);
        }
        const tokens = parseClipPromptTokens(input.value).map((token, index) => ({token, index}));
        const styleParts = controller ? controller.groupParts(field, tokens) : tokens;
        const parts = window.CanvasProjectSettings?.groupParts(field, styleParts) || styleParts;
        const matched = parts.some(part => part.type === 'style');
        host.replaceChildren();
        host.hidden = !matched;
        input.hidden = matched && input.dataset.canvasStyleEdit !== '1';
        if (!matched) continue;
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'secondary';
        edit.textContent = input.hidden ? '텍스트 편집' : '그림체 접어서 보기';
        edit.onclick = () => {
            input.dataset.canvasStyleEdit = input.hidden ? '1' : '0';
            renderReferenceStylePromptPreview();
            if (!input.hidden) input.focus();
        };
        host.appendChild(edit);
        if (!input.hidden) continue;
        const surface = document.createElement('div');
        surface.className = 'prompt-token-surface canvas-style-reference-preview';
        for (const part of parts) {
            if (part.type === 'style') renderCanvasStylePromptButton(surface, field, part);
            else {
                const token = document.createElement('span');
                token.className = 'canvas-style-reference-token';
                token.textContent = part.token;
                surface.appendChild(token);
            }
        }
        host.appendChild(surface);
    }
}

document.addEventListener('DOMContentLoaded', () => getCanvasStyleLink());
window.addEventListener('pagehide', () => canvasStyleLinkController?.dispose());
window.addEventListener('pageshow', event => {
    if (!event.persisted || !canvasStyleLinkController) return;
    const snapshot = canvasStyleLinkController.snapshot();
    canvasStyleLinkController = null;
    getCanvasStyleLink()?.restore(snapshot);
    refreshCanvasStyleLink();
});
