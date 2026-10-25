const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createCanvasDialogController, CANVAS_DIALOGS} = require('../static/canvas_dialogs.js');

function fixture() {
    const nodes = new Map();
    const observers = [];
    const doc = {activeElement: null, listeners: new Map(), getElementById: id => nodes.get(id) || null};
    doc.addEventListener = (type, callback) => {
        if (!doc.listeners.has(type)) doc.listeners.set(type, []);
        doc.listeners.get(type).push(callback);
    };
    class Node {
        constructor(id, tagName = 'DIV') {
            this.id = id;
            this.tagName = tagName;
            this.children = [];
            this.parentNode = null;
            this.style = {display: 'block', visibility: 'visible'};
            this.inert = false;
            this.disabled = false;
            this.hidden = false;
            this.tabIndex = ['BUTTON', 'INPUT', 'TEXTAREA', 'SUMMARY'].includes(tagName) ? 0 : -1;
            this.listeners = new Map();
            nodes.set(id, this);
        }
        append(node) { this.children.push(node); node.parentNode = this; return node; }
        get isConnected() { return this === doc.body || Boolean(this.parentNode?.isConnected); }
        contains(node) { return node === this || this.children.some(child => child.contains(node)); }
        closest(selector) {
            if (selector === '[inert]' && this.inert) return this;
            return this.parentNode?.closest(selector) || null;
        }
        getClientRects() {
            for (let node = this; node; node = node.parentNode) {
                if (node.hidden || node.style.display === 'none') return [];
            }
            return [{}];
        }
        matches(selector) {
            if (selector === ':disabled') return this.disabled;
            if (selector === '.prompt-token-edit') return this.className === 'prompt-token-edit';
            return false;
        }
        querySelectorAll(selector = '') {
            return this.children.flatMap(child => [child, ...child.querySelectorAll(selector)])
                .filter(node => node.tabIndex >= 0 && (node.tagName !== 'SUMMARY' || selector.includes('summary')));
        }
        focus(options) { doc.activeElement = this; this.focusOptions = options; }
        addEventListener(type, callback) { this.listeners.set(type, callback); }
    }
    doc.body = new Node('body', 'BODY');
    const main = doc.body.append(new Node('canvasWorkspace', 'MAIN'));
    const opener = main.append(new Node('opener', 'BUTTON'));
    const previouslyInert = doc.body.append(new Node('already-inert'));
    previouslyInert.inert = true;
    const callbacks = [];
    const win = {
        getComputedStyle: node => node.style,
        MutationObserver: class {
            constructor(callback) { this.callback = callback; observers.push(this); }
            observe(node, options) { this.node = node; this.options = options; }
        }
    };
    for (const config of CANVAS_DIALOGS) {
        const modal = doc.body.append(new Node(config.id));
        modal.style.display = 'none';
        const isInput = ['canvasWidthInput', 'canvasSaveNameInput'].includes(config.focus);
        modal.append(new Node(config.focus, isInput ? 'INPUT' : 'H3'));
        modal.append(new Node(`${config.id}-first`, 'BUTTON'));
        modal.append(new Node(`${config.id}-last`, 'BUTTON'));
        win[config.close] = () => { callbacks.push(config.close); modal.style.display = 'none'; };
        for (const portalConfig of config.portals || []) {
            const portal = doc.body.append(new Node(portalConfig.id));
            portal.style.display = 'none';
            portal.append(new Node(`${portalConfig.id}-input`, 'INPUT'));
            win[portalConfig.close] = () => { callbacks.push(portalConfig.close); portal.style.display = 'none'; };
        }
    }
    const controller = createCanvasDialogController(doc, win);
    const notify = node => observers.filter(observer => observer.node === node).forEach(observer => observer.callback());
    const show = id => { const node = nodes.get(id); node.style.display = 'flex'; notify(node); };
    const hide = id => { const node = nodes.get(id); node.style.display = 'none'; notify(node); };
    const key = (name, options = {}) => {
        const event = {key: name, target: doc.activeElement, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...options};
        for (const callback of doc.listeners.get('keydown') || []) callback(event);
        return event;
    };
    opener.focus();
    controller.initialize();
    return {doc, win, nodes, observers, controller, show, hide, key, callbacks, opener, main, Node};
}

test('only registered roots are observed, with no subtree observer or idle keyboard changes', () => {
    const f = fixture();
    f.controller.initialize();
    assert.equal(f.observers.length, CANVAS_DIALOGS.length);
    for (const observer of f.observers) {
        assert.ok(CANVAS_DIALOGS.some(config => config.id === observer.node.id));
        assert.deepEqual(observer.options, {attributes: true, attributeFilter: ['style', 'class', 'hidden']});
    }
    assert.equal(f.key('Tab').defaultPrevented, undefined);
    assert.equal(f.main.inert, false);
});

test('new canvas focuses its input, contains Tab in both directions and restores the opener', () => {
    const f = fixture();
    f.show('canvasCreateModal');
    assert.equal(f.doc.activeElement.id, 'canvasWidthInput');
    assert.equal(f.main.inert, true);
    const last = f.nodes.get('canvasCreateModal-last');
    f.key('Tab', {shiftKey: true});
    assert.equal(f.doc.activeElement, last);
    f.key('Tab');
    assert.equal(f.doc.activeElement.id, 'canvasWidthInput');
    const escape = f.key('Escape');
    assert.equal(escape.defaultPrevented, true);
    assert.deepEqual(f.callbacks, ['closeCanvasDialog']);
    assert.equal(f.doc.activeElement, f.opener);
    assert.equal(f.main.inert, false);
    assert.equal(f.nodes.get('already-inert').inert, true);
});

test('prompt disclosures remain in keyboard order instead of redirecting Tab to the first control', () => {
    const f = fixture();
    const modal = f.nodes.get('clipPromptModalOverlay');
    const summary = modal.append(new f.Node('auto-settings-summary', 'SUMMARY'));
    const after = modal.append(new f.Node('after-summary', 'BUTTON'));
    f.show('clipPromptModalOverlay');
    summary.focus();
    assert.equal(f.key('Tab').defaultPrevented, undefined);
    assert.equal(f.doc.activeElement, summary);
    after.focus();
    assert.equal(f.key('Tab').defaultPrevented, true);
    assert.equal(f.doc.activeElement.id, 'clipPromptModalOverlay-first');
});

test('long prompt starts at its title and a nested group dialog returns to its initiating control', () => {
    const f = fixture();
    f.show('clipPromptModalOverlay');
    assert.equal(f.doc.activeElement.id, 'clipPromptTitle');
    assert.equal(f.doc.activeElement.focusOptions, undefined);
    f.key('Tab');
    const groupOpener = f.doc.activeElement;
    f.show('clipPromptGroupModal');
    assert.equal(f.doc.activeElement.id, 'clipPromptGroupTitle');
    assert.equal(f.nodes.get('clipPromptModalOverlay').inert, true);
    f.key('Escape');
    assert.equal(f.doc.activeElement, groupOpener);
    assert.equal(f.nodes.get('clipPromptModalOverlay').inert, false);
    assert.equal(f.main.inert, true);
    f.key('Escape');
    assert.equal(f.doc.activeElement, f.opener);
});

test('saved list and save options work with existing close callbacks, including a callback that keeps a dialog open', () => {
    const f = fixture();
    f.show('savedCanvasSetupsModal');
    assert.equal(f.doc.activeElement.id, 'savedCanvasSetupsTitle');
    f.hide('savedCanvasSetupsModal');
    assert.equal(f.doc.activeElement, f.opener);
    f.show('canvasSaveOptionsModal');
    assert.equal(f.doc.activeElement.id, 'canvasSaveNameInput');
    let called = 0;
    f.win.closeCanvasSaveOptionsModal = () => called++;
    f.key('Escape');
    assert.equal(called, 1);
    assert.equal(f.nodes.get('canvasSaveOptionsModal').style.display, 'flex');
    assert.equal(f.main.inert, true);
});

test('translation portal remains reachable and Escape closes that popup without closing the prompt', () => {
    const f = fixture();
    f.show('clipPromptModalOverlay');
    f.nodes.get('tagTranslationModal').style.display = 'block';
    const input = f.nodes.get('tagTranslationModal-input');
    input.focus();
    assert.equal(input.closest('[inert]'), null);
    for (const callback of f.doc.listeners.get('focusin')) callback({target: input});
    assert.equal(f.doc.activeElement, input);
    f.key('Escape');
    assert.deepEqual(f.callbacks, ['closeTagTranslationModal']);
    assert.equal(f.nodes.get('clipPromptModalOverlay').style.display, 'flex');
    assert.equal(f.doc.activeElement.id, 'clipPromptTitle');
});

test('saved canvas native preview stays interactive and contains keyboard focus above the gallery', () => {
    const f = fixture();
    const preview = f.nodes.get('savedCanvasPreviewDialog');
    preview.tagName = 'DIALOG';
    f.show('savedCanvasSetupsModal');
    preview.style.display = 'flex';
    preview.open = true;
    const input = f.nodes.get('savedCanvasPreviewDialog-input');
    input.focus();
    assert.equal(input.closest('[inert]'), null);
    f.key('Tab');
    assert.equal(f.doc.activeElement, input);
    for (const callback of f.doc.listeners.get('focusin')) callback({target: input});
    assert.equal(f.doc.activeElement, input);
    f.key('Escape');
    assert.deepEqual(f.callbacks, ['closeSavedCanvasSetupPreview']);
    assert.equal(f.nodes.get('savedCanvasSetupsModal').style.display, 'flex');
});

test('IME and inline token Escape remain local; input typing and native clipboard defaults are preserved', () => {
    const f = fixture();
    f.show('clipPromptModalOverlay');
    assert.equal(f.key('Escape', {isComposing: true}).defaultPrevented, undefined);
    const token = f.nodes.get('clipPromptModalOverlay').append(new f.Node('token', 'INPUT'));
    token.className = 'prompt-token-edit';
    token.focus();
    assert.equal(f.key('Escape').defaultPrevented, undefined);
    assert.equal(f.key('x').defaultPrevented, undefined);
    const copy = f.key('c', {ctrlKey: true});
    f.nodes.get('clipPromptModalOverlay').listeners.get('keydown')(copy);
    assert.equal(copy.stopped, true);
    assert.equal(copy.defaultPrevented, undefined);
    assert.deepEqual(f.callbacks, []);
});

test('recreated portal menus isolate canvas shortcuts without preventing native clipboard behavior', () => {
    const f = fixture();
    f.show('clipPromptModalOverlay');
    for (let attempt = 0; attempt < 2; attempt++) {
        const old = f.nodes.get('temporaryClipPromptGroupMenu');
        old.parentNode.children = old.parentNode.children.filter(node => node !== old);
        old.parentNode = null;
        const menu = f.doc.body.append(new f.Node('temporaryClipPromptGroupMenu'));
        const button = menu.append(new f.Node(`temporary-action-${attempt}`, 'BUTTON'));
        f.win.closeTemporaryClipPromptGroupMenu = () => {
            f.callbacks.push('closeTemporaryClipPromptGroupMenu');
            menu.style.display = 'none';
        };
        button.focus();
        if (attempt === 0) {
            for (const callback of f.doc.listeners.get('focusin')) callback({target: button});
            assert.ok(menu.listeners.has('paste'));
        }
        const copy = f.key('c', {ctrlKey: true});
        menu.listeners.get('keydown')(copy);
        assert.equal(copy.stopped, true);
        assert.equal(copy.defaultPrevented, undefined);
        assert.equal(button.closest('[inert]'), null);
        f.key('Escape');
        assert.equal(f.nodes.get('clipPromptModalOverlay').style.display, 'flex');
        assert.equal(f.doc.activeElement.id, 'clipPromptTitle');
    }
    assert.deepEqual(f.callbacks, ['closeTemporaryClipPromptGroupMenu', 'closeTemporaryClipPromptGroupMenu']);
});

test('hidden and disabled controls are skipped, removed openers fall back to the canvas workspace', () => {
    const f = fixture();
    f.show('savedCanvasSetupsModal');
    f.nodes.get('savedCanvasSetupsModal-last').disabled = true;
    const hidden = f.nodes.get('savedCanvasSetupsModal').append(new f.Node('hidden', 'BUTTON'));
    hidden.hidden = true;
    f.key('Tab');
    assert.equal(f.doc.activeElement.id, 'savedCanvasSetupsModal-first');
    f.key('Tab');
    assert.equal(f.doc.activeElement.id, 'savedCanvasSetupsModal-first');
    f.opener.parentNode = null;
    f.key('Escape');
    assert.equal(f.doc.activeElement, f.main);
});

test('HTML gives each registered dialog a labelled title and loads the controller after existing callbacks', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'canvas.html'), 'utf8');
    assert.equal((html.match(/role="dialog" aria-modal="true"/g) || []).length, CANVAS_DIALOGS.length);
    for (const title of ['canvasCreateTitle', 'clipPromptTitle', 'clipPromptGroupTitle', 'savedCanvasSetupsTitle', 'canvasSaveOptionsTitle', 'canvasStyleLinkTitle']) {
        assert.ok(html.includes(`aria-labelledby="${title}"`));
        assert.ok(html.includes(`id="${title}" tabindex="-1"`));
    }
    assert.ok(html.includes('label for="canvasSaveNameInput"'));
    assert.ok(html.indexOf('/static/canvas_dialogs.js') > html.indexOf('/static/canvas_reference.js'));
});
