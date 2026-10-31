(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) {
        root.PromptAutocomplete = api;
        if (root.document && root.addEventListener) api.installPromptAutocomplete(root.document, root);
    }
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    let nextPopupId = 1;

    function delimiterAt(value, index) {
        const character = value[index];
        if (character === ',' || character === '\r' || character === '\n') return 1;
        if (character === '|' && value[index + 1] === '|') return 2;
        return 0;
    }

    function outerPairBounds(text, open, close) {
        if (text.length < 2 || text[0] !== open || text[text.length - 1] !== close) return null;
        let depth = 0;
        for (let index = 0; index < text.length; index += 1) {
            if (text[index] === open) depth += 1;
            else if (text[index] === close) {
                depth -= 1;
                if (depth === 0 && index !== text.length - 1) return null;
                if (depth < 0) return null;
            }
        }
        return depth === 0 ? {start: 1, end: text.length - 1} : null;
    }

    function stripBalancedWrappers(value, start, end, includeParentheses) {
        let changed = true;
        while (changed && end - start >= 2) {
            changed = false;
            const pairs = [['{', '}'], ['[', ']']];
            if (includeParentheses) pairs.push(['(', ')']);
            for (const [open, close] of pairs) {
                const pair = outerPairBounds(value.slice(start, end), open, close);
                if (!pair) continue;
                start += pair.start;
                end = start - pair.start + pair.end;
                ({start, end} = trimBounds(value, start, end));
                changed = true;
                break;
            }
        }
        return {start, end};
    }

    function trimBounds(value, start, end) {
        while (start < end && /\s/.test(value[start])) start += 1;
        while (end > start && /\s/.test(value[end - 1])) end -= 1;
        return {start, end};
    }

    function findChunk(value, from, to, selectionStart, selectionEnd) {
        let chunkStart = from, chunkEnd = to;
        for (let index = from; index < to;) {
            const length = delimiterAt(value, index);
            if (!length) { index += 1; continue; }
            const delimiterEnd = index + length;
            if (delimiterEnd <= selectionStart) chunkStart = delimiterEnd;
            if (index >= selectionEnd) { chunkEnd = index; break; }
            if (index < selectionEnd && delimiterEnd > selectionStart) return null;
            index = delimiterEnd;
        }
        return {chunkStart, chunkEnd};
    }

    function findCurrentPromptToken(value, selectionStart, selectionEnd = selectionStart) {
        const text = String(value ?? '');
        const start = Number.isInteger(selectionStart) ? selectionStart : text.length;
        const end = Number.isInteger(selectionEnd) ? selectionEnd : start;
        if (start < 0 || end < start || end > text.length) return null;

        let weightedBody = null;
        const weightedPattern = /([+-]?(?:\d+(?:\.\d+)?|\.\d+)::)([\s\S]*?)::/g;
        let match;
        while ((match = weightedPattern.exec(text))) {
            const bodyStart = match.index + match[1].length;
            const bodyEnd = bodyStart + match[2].length;
            const matchEnd = match.index + match[0].length;
            if ((start >= bodyStart && end <= bodyEnd)
                || (start >= bodyEnd && start <= matchEnd && end === start)) {
                weightedBody = {start: bodyStart, end: bodyEnd};
                break;
            }
        }
        const chunk = weightedBody
            ? findChunk(text, weightedBody.start, weightedBody.end, start, end)
            : findChunk(text, 0, text.length, start, end);
        if (!chunk) return null;
        const {chunkStart, chunkEnd} = chunk;

        let tokenStart = chunkStart, tokenEnd = chunkEnd;
        ({start: tokenStart, end: tokenEnd} = trimBounds(text, tokenStart, tokenEnd));
        if (tokenStart > tokenEnd) tokenStart = tokenEnd;

        let contentStart = tokenStart, contentEnd = tokenEnd;
        let wrapped = !!weightedBody;
        const weightPrefix = !weightedBody && /^([+-]?(?:\d+(?:\.\d+)?|\.\d+)::)/.exec(text.slice(contentStart, contentEnd));
        if (weightPrefix) {
            contentStart += weightPrefix[1].length;
            if (text.slice(contentEnd - 2, contentEnd) === '::') contentEnd -= 2;
            wrapped = true;
        }
        const beforeBalanced = {start: contentStart, end: contentEnd};
        ({start: contentStart, end: contentEnd} = stripBalancedWrappers(text, contentStart, contentEnd,
            !!weightedBody || !!weightPrefix));
        if (contentStart !== beforeBalanced.start || contentEnd !== beforeBalanced.end) wrapped = true;
        while (contentStart < contentEnd && (text[contentStart] === '{' || text[contentStart] === '[')) {
            contentStart += 1;
            wrapped = true;
        }
        while (contentEnd > contentStart && (text[contentEnd - 1] === '}' || text[contentEnd - 1] === ']')) {
            contentEnd -= 1;
            wrapped = true;
        }
        if (weightedBody || weightPrefix) {
            if (contentStart < contentEnd && text[contentStart] === '('
                && text.indexOf(')', contentStart + 1) < 0) {
                contentStart += 1;
                wrapped = true;
            }
        }
        if (contentEnd > contentStart && text[contentStart] === '%') {
            contentStart += 1;
            wrapped = true;
        }
        if (contentEnd > contentStart && text[contentEnd - 1] === '%') {
            contentEnd -= 1;
            wrapped = true;
        }
        ({start: contentStart, end: contentEnd} = trimBounds(text, contentStart, contentEnd));
        const query = text.slice(contentStart, contentEnd).trim();
        return {
            chunkStart,
            chunkEnd,
            tokenStart,
            tokenEnd,
            contentStart,
            contentEnd,
            query,
            isWrapped: wrapped || contentStart !== tokenStart || contentEnd !== tokenEnd,
            atPromptEnd: chunkEnd === text.length
        };
    }

    function replaceCurrentPromptToken(value, tag, selectionStart, selectionEnd = selectionStart, options = {}) {
        const text = String(value ?? '');
        const token = findCurrentPromptToken(text, selectionStart, selectionEnd);
        const englishTag = String(tag ?? '').trim().replace(/_/g, ' ');
        if (!token || !englishTag || /[,\r\n]/.test(englishTag)) return null;

        let result = text.slice(0, token.contentStart) + englishTag + text.slice(token.contentEnd);
        let caret = token.contentStart + englishTag.length;
        if (options.appendDelimiter && options.isTextarea && token.atPromptEnd && !token.isWrapped) {
            result = result.slice(0, token.tokenEnd + englishTag.length - (token.contentEnd - token.contentStart))
                + ', ' + result.slice(token.tokenEnd + englishTag.length - (token.contentEnd - token.contentStart));
            caret += 2;
        }

        const maxLength = Number(options.maxLength);
        if (Number.isFinite(maxLength) && maxLength >= 0 && result.length > maxLength) return null;
        return {value: result, selectionStart: caret, selectionEnd: caret, token};
    }

    function measurePromptCaret(element, win = element?.ownerDocument?.defaultView, doc = element?.ownerDocument) {
        const fallback = () => element?.getBoundingClientRect?.() || null;
        if (!element || !doc?.createElement || !doc?.body || !win?.getComputedStyle
            || !Number.isFinite(element.offsetWidth) || element.offsetWidth <= 0
            || !Number.isFinite(element.offsetHeight) || element.offsetHeight <= 0
            || !Number.isFinite(element.clientWidth) || !Number.isFinite(element.clientHeight)) return fallback();
        const controlRect = fallback();
        if (!controlRect) return null;

        let mirror = null;
        try {
            const computed = win.getComputedStyle(element);
            if (!computed) return controlRect;
            const value = String(element.value ?? '');
            let selectionStart = 0, selectionEnd = 0;
            try {
                selectionStart = Number.isInteger(element.selectionStart) ? element.selectionStart : value.length;
                selectionEnd = Number.isInteger(element.selectionEnd) ? element.selectionEnd : selectionStart;
            } catch (_) { selectionStart = selectionEnd = value.length; }
            const caret = selectionStart === selectionEnd ? selectionStart
                : element.selectionDirection === 'backward' ? selectionStart : selectionEnd;
            const prefix = value.slice(0, Math.max(0, Math.min(value.length, caret)));
            const suffix = value.slice(prefix.length);
            const isTextarea = String(element.tagName || '').toUpperCase() === 'TEXTAREA';
            const readStyle = (camel, cssName) => computed[camel] || computed.getPropertyValue?.(cssName) || '';
            const setStyle = (target, property, valueToSet) => { if (valueToSet !== '') target.style[property] = valueToSet; };
            const numberStyle = (camel, cssName) => {
                const parsed = Number.parseFloat(readStyle(camel, cssName));
                return Number.isFinite(parsed) ? parsed : 0;
            };
            const borderLeft = numberStyle('borderLeftWidth', 'border-left-width');
            const borderRight = numberStyle('borderRightWidth', 'border-right-width');
            const borderTop = numberStyle('borderTopWidth', 'border-top-width');
            const borderBottom = numberStyle('borderBottomWidth', 'border-bottom-width');
            const scaleX = element.offsetWidth ? controlRect.width / element.offsetWidth : 1;
            const scaleY = element.offsetHeight ? controlRect.height / element.offsetHeight : 1;
            if (!(scaleX > 0) || !(scaleY > 0)) return controlRect;

            mirror = doc.createElement('div');
            mirror.setAttribute('aria-hidden', 'true');
            mirror.style.position = 'fixed';
            mirror.style.left = '0px';
            mirror.style.top = '0px';
            mirror.style.visibility = 'hidden';
            mirror.style.pointerEvents = 'none';
            mirror.style.overflow = 'hidden';
            mirror.style.boxSizing = 'border-box';
            mirror.style.width = `${element.clientWidth + borderLeft + borderRight}px`;
            mirror.style.height = `${element.offsetHeight}px`;
            mirror.style.borderLeftWidth = `${borderLeft}px`;
            mirror.style.borderRightWidth = `${borderRight}px`;
            mirror.style.borderTopWidth = `${borderTop}px`;
            mirror.style.borderBottomWidth = `${borderBottom}px`;
            mirror.style.borderStyle = 'solid';
            mirror.style.borderColor = 'transparent';

            const copiedStyles = [
                ['fontFamily', 'font-family'], ['fontSize', 'font-size'], ['fontWeight', 'font-weight'],
                ['fontStyle', 'font-style'], ['fontVariant', 'font-variant'], ['fontStretch', 'font-stretch'],
                ['lineHeight', 'line-height'], ['letterSpacing', 'letter-spacing'], ['wordSpacing', 'word-spacing'],
                ['textTransform', 'text-transform'], ['textIndent', 'text-indent'], ['textAlign', 'text-align'],
                ['direction', 'direction'], ['tabSize', 'tab-size'], ['paddingTop', 'padding-top'],
                ['paddingRight', 'padding-right'], ['paddingBottom', 'padding-bottom'], ['paddingLeft', 'padding-left'],
                ['wordBreak', 'word-break']
            ];
            for (const [camel, cssName] of copiedStyles) setStyle(mirror, camel, readStyle(camel, cssName));

            const wrapOff = isTextarea && String(element.getAttribute?.('wrap') || element.wrap || '').toLowerCase() === 'off';
            const whiteSpace = isTextarea ? (wrapOff ? 'pre' : 'pre-wrap') : 'pre';
            const overflowWrap = isTextarea && !wrapOff ? 'break-word' : 'normal';
            mirror.style.whiteSpace = whiteSpace;
            mirror.style.overflowWrap = overflowWrap;
            mirror.style.wordWrap = overflowWrap;
            if (!isTextarea) {
                mirror.style.display = 'flex';
                mirror.style.alignItems = 'center';
            }

            const content = doc.createElement('div');
            content.style.boxSizing = 'border-box';
            content.style.width = '100%';
            content.style.minWidth = '0';
            content.style.whiteSpace = whiteSpace;
            content.style.overflowWrap = overflowWrap;
            content.style.wordWrap = overflowWrap;
            setStyle(content, 'wordBreak', readStyle('wordBreak', 'word-break'));
            setStyle(content, 'fontFamily', readStyle('fontFamily', 'font-family'));
            setStyle(content, 'fontSize', readStyle('fontSize', 'font-size'));
            setStyle(content, 'fontWeight', readStyle('fontWeight', 'font-weight'));
            setStyle(content, 'fontStyle', readStyle('fontStyle', 'font-style'));
            setStyle(content, 'fontVariant', readStyle('fontVariant', 'font-variant'));
            setStyle(content, 'fontStretch', readStyle('fontStretch', 'font-stretch'));
            setStyle(content, 'lineHeight', readStyle('lineHeight', 'line-height'));
            setStyle(content, 'letterSpacing', readStyle('letterSpacing', 'letter-spacing'));
            setStyle(content, 'wordSpacing', readStyle('wordSpacing', 'word-spacing'));
            setStyle(content, 'textTransform', readStyle('textTransform', 'text-transform'));
            setStyle(content, 'textIndent', readStyle('textIndent', 'text-indent'));
            setStyle(content, 'textAlign', readStyle('textAlign', 'text-align'));
            setStyle(content, 'direction', readStyle('direction', 'direction'));
            setStyle(content, 'tabSize', readStyle('tabSize', 'tab-size'));

            const textNode = doc.createTextNode(prefix);
            const anchor = doc.createElement('span');
            anchor.textContent = suffix || '\u200b';
            content.appendChild(textNode);
            content.appendChild(anchor);
            mirror.appendChild(content);
            doc.body.appendChild(mirror);

            const anchorRects = anchor.getClientRects?.();
            if (!anchorRects?.length) return controlRect;
            const anchorRect = anchorRects[0];
            const mirrorRect = mirror.getBoundingClientRect?.() || {left: 0, top: 0};
            const scrollLeft = Number(element.scrollLeft) || 0;
            const scrollTop = Number(element.scrollTop) || 0;
            let left = controlRect.left + (anchorRect.left - mirrorRect.left - scrollLeft) * scaleX;
            let top = controlRect.top + (anchorRect.top - mirrorRect.top - scrollTop) * scaleY;
            const innerLeft = controlRect.left + borderLeft * scaleX;
            const innerRight = controlRect.right - borderRight * scaleX;
            const innerTop = controlRect.top + borderTop * scaleY;
            const innerBottom = controlRect.bottom - borderBottom * scaleY;
            const height = Math.max(1, (anchorRect.height || Number.parseFloat(readStyle('lineHeight', 'line-height')) || 16) * scaleY);
            left = Math.max(innerLeft, Math.min(innerRight, left));
            top = Math.max(innerTop, Math.min(Math.max(innerTop, innerBottom - height), top));
            return {left, right: left, top, bottom: Math.min(innerBottom, top + height), width: 0, height};
        } catch (_) {
            return controlRect;
        } finally {
            mirror?.remove?.();
        }
    }

    function isEditor(node) {
        if (!node || node.nodeType !== 1 || node.hasAttribute?.('data-prompt-autocomplete') !== true) return false;
        const tagName = String(node.tagName || '').toUpperCase();
        if (tagName !== 'TEXTAREA' && tagName !== 'INPUT') return false;
        if (tagName === 'INPUT' && !['', 'text', 'search'].includes(String(node.type || '').toLowerCase())) return false;
        return !node.disabled && !node.readOnly && !node.hasAttribute?.('readonly') && !node.hasAttribute?.('disabled');
    }

    function installPromptAutocomplete(doc, win, options = {}) {
        if (!doc || !win) return {dispose() {}};
        const fetcher = options.fetch || win.fetch?.bind(win) || (typeof fetch === 'function' ? fetch : null);
        const setTimer = options.setTimeout || win.setTimeout?.bind(win) || setTimeout;
        const clearTimer = options.clearTimeout || win.clearTimeout?.bind(win) || clearTimeout;
        const debounceMs = Number.isFinite(options.debounceMs) ? Math.max(0, options.debounceMs) : 150;
        let active = null;
        let popup = null;
        let listbox = null;
        let statusNode = null;
        let mountedRoot = null;
        let timer = null;
        let requestController = null;
        let requestVersion = 0;
        let currentItems = [];
        let currentItemsState = null;
        let currentItemsVersion = -1;
        let activeIndex = -1;
        let ariaBefore = null;
        let popupObserver = null;
        let disposed = false;

        const attributeValue = (element, name) => element?.getAttribute?.(name) ?? null;
        const restoreAttribute = (element, name, value) => {
            if (!element) return;
            if (value === null) element.removeAttribute(name);
            else element.setAttribute(name, value);
        };
        const isVisible = element => {
            if (!element || !element.isConnected || element.hidden || element.inert || element.closest?.('[hidden], [inert]')) return false;
            const style = win.getComputedStyle?.(element);
            if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
            if (typeof element.getClientRects === 'function' && element.getClientRects().length === 0) return false;
            return true;
        };
        const isCurrentEditor = element => isEditor(element) && isVisible(element);
        const selection = element => {
            let start = element.value?.length || 0, end = start;
            try {
                if (Number.isInteger(element.selectionStart)) start = element.selectionStart;
                if (Number.isInteger(element.selectionEnd)) end = element.selectionEnd;
            } catch (_) { /* Some input types do not expose selection ranges. */ }
            return {start, end};
        };
        const selectionState = element => {
            const range = selection(element);
            const token = findCurrentPromptToken(element.value || '', range.start, range.end);
            return token ? {value: element.value || '', start: range.start, end: range.end, query: token.query, token} : null;
        };

        function findLayerRoot(element) {
            for (let node = element; node && node !== doc.body && node !== doc.documentElement; node = node.parentElement) {
                const tag = String(node.tagName || '').toUpperCase();
                const id = String(node.id || '').toLowerCase();
                const classes = String(node.className || '').toLowerCase();
                const isDialog = (tag === 'DIALOG' && node.open)
                    || node.getAttribute?.('role') === 'dialog'
                    || /(?:^|\s)(?:modal|modal-overlay|modal-backdrop)(?:\s|$)/.test(classes)
                    || id.includes('modal') || /overlay$/.test(id);
                if (isDialog && isVisible(node)) return node;
            }
            return doc.body || doc.documentElement;
        }

        function ensurePopup() {
            if (popup) return;
            popup = doc.createElement('div');
            popup.className = 'prompt-autocomplete-popup';
            popup.hidden = true;
            popup.setAttribute('data-prompt-autocomplete-popup', '');
            statusNode = doc.createElement('div');
            statusNode.className = 'prompt-autocomplete-status';
            statusNode.setAttribute('role', 'status');
            statusNode.setAttribute('aria-live', 'polite');
            listbox = doc.createElement('div');
            listbox.className = 'prompt-autocomplete-listbox';
            listbox.id = `promptAutocompleteListbox${nextPopupId++}`;
            listbox.setAttribute('role', 'listbox');
            popup.append(statusNode, listbox);
            popup.addEventListener('mousedown', event => {
                if (event.target === popup || event.target === listbox || event.target === statusNode) event.preventDefault();
            });
        }

        function setStatus(message) {
            if (statusNode) statusNode.textContent = message || '';
        }

        function updateActiveDescendant() {
            if (!active || !listbox || activeIndex < 0 || activeIndex >= currentItems.length) {
                if (active) active.removeAttribute('aria-activedescendant');
                return;
            }
            const option = listbox.children[activeIndex];
            if (option?.id) active.setAttribute('aria-activedescendant', option.id);
        }

        function renderItems(items, state = null, version = -1) {
            currentItems = items;
            currentItemsState = state;
            currentItemsVersion = version;
            activeIndex = -1;
            listbox.replaceChildren();
            updateActiveDescendant();
            items.forEach((item, index) => {
                const tag = typeof item?.tag === 'string' ? item.tag.trim() : '';
                if (!tag || /[,\r\n]/.test(tag)) return;
                const option = doc.createElement('div');
                option.className = 'prompt-autocomplete-option';
                option.id = `${listbox.id}-option-${index}`;
                option.setAttribute('role', 'option');
                option.setAttribute('aria-selected', 'false');
                const english = doc.createElement('span');
                english.className = 'prompt-autocomplete-tag';
                english.textContent = tag.replace(/_/g, ' ');
                option.appendChild(english);
                const korean = typeof item.ko === 'string' ? item.ko.trim() : '';
                if (korean && korean.toLocaleLowerCase() !== tag.toLocaleLowerCase()
                    && korean.toLocaleLowerCase() !== tag.replace(/_/g, ' ').toLocaleLowerCase()) {
                    const label = doc.createElement('span');
                    label.className = 'prompt-autocomplete-ko';
                    label.textContent = korean;
                    option.appendChild(label);
                }
                option.addEventListener('mouseenter', () => setActive(index));
                option.addEventListener('mousedown', event => {
                    event.preventDefault();
                    choose(index);
                });
                listbox.appendChild(option);
            });
            positionPopup();
        }

        function setActive(index) {
            if (!currentItems.length) return;
            activeIndex = Math.max(0, Math.min(currentItems.length - 1, index));
            [...listbox.children].forEach((option, optionIndex) => {
                option.setAttribute('aria-selected', optionIndex === activeIndex ? 'true' : 'false');
            });
            updateActiveDescendant();
            listbox.children[activeIndex]?.scrollIntoView?.({block: 'nearest'});
        }

        function openPopup(element) {
            ensurePopup();
            if (active !== element) {
                if (active) closePopup();
                active = element;
                ariaBefore = {
                    controls: attributeValue(element, 'aria-controls'),
                    expanded: attributeValue(element, 'aria-expanded'),
                    descendant: attributeValue(element, 'aria-activedescendant')
                };
            }
            const nextRoot = findLayerRoot(element);
            if (popup.parentNode !== nextRoot) {
                popup.remove();
                nextRoot.appendChild(popup);
                mountedRoot = nextRoot;
            }
            popup.hidden = false;
            if (!popup.hasAttribute('popover')) popup.setAttribute('popover', 'manual');
            if (typeof popup.showPopover === 'function' && !popup.matches?.(':popover-open')) {
                try { popup.showPopover(); } catch (_) { /* High z-index remains as a fallback. */ }
            }
            element.setAttribute('aria-controls', listbox.id);
            element.setAttribute('aria-expanded', 'true');
            positionPopup();
        }

        function abortPending() {
            if (timer !== null) clearTimer(timer);
            timer = null;
            if (requestController) requestController.abort();
            requestController = null;
        }

        function closePopup() {
            abortPending();
            requestVersion += 1;
            if (popup) {
                if (typeof popup.hidePopover === 'function') {
                    try { popup.hidePopover(); } catch (_) { /* Popup may already be outside the top layer. */ }
                }
                popup.hidden = true;
                popup.remove();
            }
            if (active && ariaBefore) {
                restoreAttribute(active, 'aria-controls', ariaBefore.controls);
                restoreAttribute(active, 'aria-expanded', ariaBefore.expanded);
                restoreAttribute(active, 'aria-activedescendant', ariaBefore.descendant);
            }
            active = null;
            ariaBefore = null;
            mountedRoot = null;
            currentItems = [];
            currentItemsState = null;
            currentItemsVersion = -1;
            activeIndex = -1;
            if (listbox) listbox.replaceChildren();
            if (statusNode) statusNode.textContent = '';
            if (popupObserver) { popupObserver.disconnect(); popupObserver = null; }
        }

        function observeActive() {
            if (popupObserver) popupObserver.disconnect();
            const Observer = win.MutationObserver;
            if (!active || typeof Observer !== 'function' || !doc.body) return;
            popupObserver = new Observer(() => {
                if (active && (!active.isConnected || !isVisible(active) || !isCurrentEditor(active))) closePopup();
            });
            try {
                popupObserver.observe(doc.body, {childList: true, subtree: true});
                for (let node = active; node && node !== doc.body; node = node.parentElement) {
                    popupObserver.observe(node, {attributes: true, attributeFilter: ['hidden', 'class', 'style', 'open', 'inert']});
                }
            } catch (_) { popupObserver.disconnect(); popupObserver = null; }
        }

        function positionPopup() {
            if (!popup || popup.hidden || !active || !isCurrentEditor(active)) return;
            const controlRect = active.getBoundingClientRect?.();
            const caretRect = measurePromptCaret(active, win, doc) || controlRect;
            if (!controlRect || !caretRect) return;
            const viewportWidth = Math.max(1, win.innerWidth || doc.documentElement?.clientWidth || 1);
            const viewportHeight = Math.max(1, win.innerHeight || doc.documentElement?.clientHeight || 1);
            const width = Math.max(1, Math.min(Math.max(controlRect.width || 0, 320), 480, viewportWidth - 16));
            const left = Math.max(8, Math.min(caretRect.left + 4, viewportWidth - width - 8));
            const below = Math.max(0, viewportHeight - caretRect.bottom - 8);
            const above = Math.max(0, caretRect.top - 8);
            const useBelow = below >= Math.min(180, above) || below >= above;
            const available = useBelow ? below : above;
            const maxHeight = Math.max(0, Math.min(280, available));
            popup.style.position = 'fixed';
            popup.style.left = `${left}px`;
            popup.style.width = `${width}px`;
            popup.style.maxHeight = `${maxHeight}px`;
            popup.style.top = useBelow ? `${Math.min(viewportHeight - 8, caretRect.bottom + 4)}px` : 'auto';
            popup.style.bottom = useBelow ? 'auto' : `${Math.max(8, viewportHeight - caretRect.top + 4)}px`;
        }

        function matchesRequest(element, expectedVersion, expectedState) {
            if (disposed || requestVersion !== expectedVersion || active !== element || !isCurrentEditor(element)
                || doc.activeElement !== element || element.isComposing) return false;
            const current = selectionState(element);
            return !!current && current.value === expectedState.value && current.start === expectedState.start
                && current.end === expectedState.end && current.query === expectedState.query;
        }

        async function requestSuggestions(element, version, expectedState) {
            if (!fetcher || !matchesRequest(element, version, expectedState)) return;
            const AbortControllerClass = win.AbortController || (typeof AbortController === 'function' ? AbortController : null);
            requestController = AbortControllerClass ? new AbortControllerClass() : null;
            setStatus('태그 검색 중…');
            renderItems([]);
            try {
                const url = `/api/prompt-tags/suggest?q=${encodeURIComponent(expectedState.query)}&limit=12`;
                const response = await fetcher(url, requestController ? {signal: requestController.signal} : undefined);
                if (!matchesRequest(element, version, expectedState)) return;
                if (!response?.ok) throw new Error('suggestion request failed');
                const payload = await response.json();
                if (!matchesRequest(element, version, expectedState)) return;
                if (payload?.status !== 'success' || !Array.isArray(payload.items)) throw new Error('invalid suggestion response');
                const items = payload.items.filter(item => item && typeof item.tag === 'string' && item.tag.trim()
                    && !/[,\r\n]/.test(item.tag));
                setStatus(items.length ? '' : '추천 결과가 없습니다.');
                renderItems(items, expectedState, version);
            } catch (error) {
                if (error?.name === 'AbortError' || !matchesRequest(element, version, expectedState)) return;
                setStatus('태그 추천을 불러오지 못했습니다.');
                renderItems([]);
            }
        }

        function updateFor(element) {
            if (!isCurrentEditor(element) || element.isComposing || doc.activeElement !== element) {
                if (active) closePopup();
                return;
            }
            const state = selectionState(element);
            abortPending();
            if (!state?.query || state.query.length > 100 || state.token.tokenEnd - state.token.tokenStart > 100) {
                closePopup();
                return;
            }
            openPopup(element);
            requestVersion += 1;
            const version = requestVersion;
            setStatus('태그 검색 중…');
            renderItems([]);
            timer = setTimer(() => {
                timer = null;
                requestSuggestions(element, version, state);
            }, debounceMs);
            observeActive();
        }

        function getEditorFromEvent(event) {
            const target = event?.target;
            if (isEditor(target)) return target;
            return target?.closest?.('input[data-prompt-autocomplete], textarea[data-prompt-autocomplete]') || null;
        }

        function handleInput(event) {
            const editor = getEditorFromEvent(event);
            if (editor && !editor.isComposing && !event.isComposing) updateFor(editor);
        }

        function handleFocusIn(event) {
            const editor = getEditorFromEvent(event);
            if (editor && isCurrentEditor(editor)) {
                if (active !== editor) closePopup();
                editor.isComposing = false;
                updateFor(editor);
            } else if (!popup?.contains?.(event.target)) closePopup();
        }

        function handleFocusOut(event) {
            if (event.target !== active) return;
            if (popup?.contains?.(event.relatedTarget)) return;
            closePopup();
        }

        function handleCompositionStart(event) {
            const editor = getEditorFromEvent(event);
            if (!editor) return;
            editor.isComposing = true;
            if (active === editor) closePopup();
        }

        function handleCompositionEnd(event) {
            const editor = getEditorFromEvent(event);
            if (!editor) return;
            editor.isComposing = false;
            updateFor(editor);
        }

        function choose(index) {
            if (!active || !currentItems.length) return false;
            if (!currentItemsState || !matchesRequest(active, currentItemsVersion, currentItemsState)) {
                const editor = active;
                updateFor(editor);
                return false;
            }
            const item = currentItems[index];
            if (!item || typeof item.tag !== 'string') return false;
            const element = active;
            const range = selection(element);
            const result = replaceCurrentPromptToken(element.value || '', item.tag, range.start, range.end, {
                maxLength: element.maxLength,
                appendDelimiter: String(element.tagName).toUpperCase() === 'TEXTAREA',
                isTextarea: String(element.tagName).toUpperCase() === 'TEXTAREA'
            });
            if (!result) {
                setStatus('입력 길이를 초과해 적용하지 못했습니다.');
                return false;
            }
            element.value = result.value;
            try { element.setSelectionRange?.(result.selectionStart, result.selectionEnd); } catch (_) { /* Selection may not be supported. */ }
            const EventClass = win.Event;
            if (typeof EventClass === 'function') {
                element.dispatchEvent(new EventClass('input', {bubbles: true}));
                element.dispatchEvent(new EventClass('change', {bubbles: true}));
            } else if (doc.createEvent) {
                for (const type of ['input', 'change']) {
                    const event = doc.createEvent('Event');
                    event.initEvent(type, true, false);
                    element.dispatchEvent(event);
                }
            }
            closePopup();
            return true;
        }

        function consumeKey(event) {
            event.preventDefault();
            event.stopPropagation();
        }

        function handleKeyDown(event) {
            if (!active || event.defaultPrevented || event.isComposing || event.keyCode === 229
                || event.ctrlKey || event.metaKey || event.altKey || active.isComposing
                || doc.activeElement !== active) return;
            if (event.key === 'Tab' && event.shiftKey) {
                closePopup();
            } else if (event.key === 'Escape') {
                consumeKey(event);
                closePopup();
            } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && currentItems.length) {
                consumeKey(event);
                const delta = event.key === 'ArrowDown' ? 1 : -1;
                const next = activeIndex < 0 ? (delta > 0 ? 0 : currentItems.length - 1)
                    : (activeIndex + delta + currentItems.length) % currentItems.length;
                setActive(next);
            } else if ((event.key === 'Enter' || event.key === 'Tab') && currentItems.length) {
                consumeKey(event);
                choose(activeIndex < 0 ? 0 : activeIndex);
            }
        }

        function handleSelectionChange() {
            if (active && doc.activeElement === active && !active.isComposing) updateFor(active);
        }

        function handlePointerDown(event) {
            if (popup?.contains?.(event.target) || event.target === active) return;
            closePopup();
        }

        function handleScroll(event) {
            if (!popup || popup.hidden || popup.contains?.(event.target)) return;
            if (!active || !isCurrentEditor(active)) closePopup();
            else positionPopup();
        }

        function dispose() {
            if (disposed) return;
            disposed = true;
            closePopup();
            doc.removeEventListener('input', handleInput, true);
            doc.removeEventListener('focusin', handleFocusIn, true);
            doc.removeEventListener('focusout', handleFocusOut, true);
            doc.removeEventListener('compositionstart', handleCompositionStart, true);
            doc.removeEventListener('compositionend', handleCompositionEnd, true);
            doc.removeEventListener('selectionchange', handleSelectionChange, true);
            doc.removeEventListener('click', handlePointerDown, true);
            win.removeEventListener('mousedown', handlePointerDown, true);
            win.removeEventListener('keydown', handleKeyDown, true);
            win.removeEventListener('resize', positionPopup);
            win.removeEventListener('scroll', handleScroll, true);
            win.removeEventListener('pagehide', dispose);
        }

        doc.addEventListener('input', handleInput, true);
        doc.addEventListener('focusin', handleFocusIn, true);
        doc.addEventListener('focusout', handleFocusOut, true);
        doc.addEventListener('compositionstart', handleCompositionStart, true);
        doc.addEventListener('compositionend', handleCompositionEnd, true);
        doc.addEventListener('selectionchange', handleSelectionChange, true);
        doc.addEventListener('click', handlePointerDown, true);
        win.addEventListener('mousedown', handlePointerDown, true);
        win.addEventListener('keydown', handleKeyDown, true);
        win.addEventListener('resize', positionPopup);
        win.addEventListener('scroll', handleScroll, true);
        win.addEventListener('pagehide', dispose);

        return {dispose, close: closePopup, update: updateFor};
    }

    return {findCurrentPromptToken, replaceCurrentPromptToken, measurePromptCaret, installPromptAutocomplete};
});
