const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {deleteRequest} = require('../static/daki.js');

const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
    class Element {
        constructor(tagName, ownerDocument) {
            this.tagName = tagName.toUpperCase();
            this.ownerDocument = ownerDocument;
            this.children = [];
            this.parentNode = null;
            this.attributes = {};
            this.dataset = {};
            this.listeners = new Map();
            this.classes = new Set();
            this.hidden = false;
            this.disabled = false;
            this.open = false;
            this.style = {};
            this._textContent = '';
            this.classList = {
                add: (...names) => names.forEach(name => this.classes.add(name)),
                remove: (...names) => names.forEach(name => this.classes.delete(name)),
                contains: name => this.classes.has(name),
                toggle: (name, force) => {
                    const enabled = force === undefined ? !this.classes.has(name) : !!force;
                    if (enabled) this.classes.add(name); else this.classes.delete(name);
                    return enabled;
                },
            };
        }
        get className() { return [...this.classes].join(' '); }
        set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
        get textContent() { return this._textContent + this.children.map(child => child.textContent).join(''); }
        set textContent(value) {
            this.children.forEach(child => { child.parentNode = null; });
            this.children = [];
            this._textContent = String(value ?? '');
        }
        get isConnected() {
            for (let item = this; item; item = item.parentNode) if (item.isDocumentRoot) return true;
            return false;
        }
        appendChild(child) {
            if (child.parentNode) {
                const old = child.parentNode.children.indexOf(child);
                if (old >= 0) child.parentNode.children.splice(old, 1);
            }
            child.parentNode = this;
            this.children.push(child);
            return child;
        }
        append(...children) { children.forEach(child => this.appendChild(child)); }
        replaceChildren(...children) {
            this.children.forEach(child => { child.parentNode = null; });
            this.children = [];
            this._textContent = '';
            this.append(...children);
        }
        setAttribute(name, value) { this.attributes[name] = String(value); }
        getAttribute(name) { return this.attributes[name] ?? null; }
        addEventListener(name, callback) {
            const listeners = this.listeners.get(name) || [];
            listeners.push(callback);
            this.listeners.set(name, listeners);
        }
        dispatch(name, event = {}) {
            const current = {target: this, preventDefault() { this.defaultPrevented = true; }, ...event};
            for (const callback of this.listeners.get(name) || []) callback(current);
            return current;
        }
        focus(options) { this.focusOptions = options; this.ownerDocument.activeElement = this; }
        showModal() { this.open = true; }
        close() {
            if (!this.open) return;
            this.open = false;
            if (this.ownerDocument.queueCloseEvents) this.ownerDocument.queuedCloseEvents.push(() => this.dispatch('close'));
            else this.dispatch('close');
        }
        getBoundingClientRect() { return {left: 100, top: 100, right: 500, bottom: 500}; }
    }

    const doc = {
        activeElement: null,
        queueCloseEvents: false,
        queuedCloseEvents: [],
        createElement(tagName) { return new Element(tagName, doc); },
        getElementById(id) {
            const visit = item => {
                if (item.id === id) return item;
                for (const child of item.children) {
                    const found = visit(child);
                    if (found) return found;
                }
                return null;
            };
            return visit(doc.body);
        },
    };
    doc.body = new Element('body', doc);
    doc.body.isDocumentRoot = true;
    const requests = [];
    const errors = [];
    const deleted = [];
    let current = true;
    let browserConfirms = 0;
    const win = {
        document: doc,
        confirm() { browserConfirms++; throw new Error('Browser confirm should not be used'); },
        fetch(url, options) {
            return new Promise((resolve, reject) => requests.push({
                url, options,
                reply(result, status = 200) {
                    resolve({ok: status >= 200 && status < 300, status, json: async () => result});
                },
                fail(error = new Error('Synthetic network failure')) { reject(error); },
            }));
        },
        Daki: {
            deleteRequest,
            folderCard(name, href, count, subtitle, src) {
                const link = doc.createElement('a');
                link.className = 'card daki-project-card';
                link.href = href;
                link.append(doc.createElement('div'), doc.createElement('div'));
                link.children[0].className = 'card-body';
                link.children[1].className = 'card-header';
                link.children[1].textContent = `${name} ${subtitle}`;
                link.dataset.src = src || '';
                return link;
            },
        },
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../static/daki_draft_folder_actions.js'), 'utf8'), {window: win});
    const api = win.DakiDraftFolderActions;
    function action(folder = {id: 'folder-1', name: 'Synthetic folder', count: 3}) {
        const button = api.createDeleteButton(folder, {
            isCurrent: () => current,
            onDeleted: result => deleted.push(result),
            onError: message => errors.push(message),
        });
        assert.ok(button);
        doc.body.appendChild(button);
        return button;
    }
    return {
        api, doc, win, requests, errors, deleted,
        action,
        setCurrent(value) { current = value; },
        queueCloseEvents(value) { doc.queueCloseEvents = value; },
        dispatchQueuedClose() { assert.ok(doc.queuedCloseEvents.length); doc.queuedCloseEvents.shift()(); },
        modal() { return doc.getElementById('dakiDraftFolderDeleteDialog'); },
        controls(className) {
            const dialog = this.modal();
            const found = [];
            const visit = item => {
                if (item.classList.contains(className)) found.push(item);
                item.children.forEach(visit);
            };
            if (dialog) visit(dialog);
            return found;
        },
        confirm() { this.controls('daki-draft-folder-delete-confirm')[0].onclick({defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }}); },
        cancel() { this.controls('daki-draft-folder-delete-cancel')[0].onclick(); },
        browserConfirms: () => browserConfirms,
    };
}

test('folder cards keep the original link and place their delete action outside the anchor', () => {
    const f = fixture();
    const card = f.api.createCard({id: 'folder one', name: '<img onerror=synthetic>', count: 4, selected_count: 2, src: '/synthetic.png'}, {
        href: '#daki&library=drafts&folder=folder%20one', isCurrent: () => true,
    });
    assert.equal(card.classList.contains('card'), true);
    assert.equal(card.children.length, 2);
    const [link, footer] = card.children;
    assert.equal(link.tagName, 'A');
    assert.equal(link.classList.contains('card'), false);
    assert.equal(link.href, '#daki&library=drafts&folder=folder%20one');
    assert.equal(link.textContent, '<img onerror=synthetic> 시안 · 4장 · 2장 선택됨');
    assert.equal(link.children[0].classList.contains('card-body'), true);
    assert.equal(footer.classList.contains('daki-draft-folder-actions'), true);
    assert.equal(footer.children[0].textContent, '폴더 삭제');
    assert.equal(footer.children[0].parentNode, footer);
    assert.equal(footer.children[0].parentNode.parentNode, card);

    const legacy = {id: 'legacy', name: '기존 시안', legacy: true, count: 12};
    assert.equal(f.api.createDeleteButton(legacy), null);
    const legacyCard = f.api.createCard(legacy, {href: '#legacy'});
    assert.equal(legacyCard.children.length, 1);
    assert.equal(f.requests.length, 0);
});

test('initial confirmation explains scope; cancel sends no delete and restores focus', async () => {
    const f = fixture(), opener = f.action({id: 'folder/one', name: '<folder name>', count: 7});
    const deletion = opener.onclick();
    const dialog = f.modal();
    assert.equal(dialog.open, true);
    assert.equal(dialog.getAttribute('aria-labelledby'), 'dakiDraftFolderDeleteTitle');
    assert.equal(dialog.getAttribute('aria-describedby'), 'dakiDraftFolderDeleteDescription');
    assert.equal(f.controls('daki-draft-folder-delete-name')[0].textContent, '<folder name>');
    assert.equal(f.controls('daki-draft-folder-delete-count')[0].textContent, '시안 7장');
    assert.match(f.controls('daki-draft-folder-delete-description')[0].textContent, /모든 시안\(선택한 결과 포함\).*저장된 생성 설정을 영구 삭제/);
    assert.equal(f.doc.activeElement, f.controls('daki-draft-folder-delete-cancel')[0]);
    f.cancel();
    await deletion;

    assert.equal(dialog.open, false);
    assert.equal(f.doc.activeElement, opener);
    assert.equal(opener.focusOptions.preventScroll, true);
    assert.equal(f.requests.length, 0);
    assert.equal(f.deleted.length, 0);
    assert.equal(f.browserConfirms(), 0);
});

test('confirmed deletion posts the encoded folder id once and reports the successful result', async () => {
    const f = fixture(), opener = f.action({id: 'folder/one', name: 'Synthetic folder', count: 3});
    const deletion = opener.onclick();
    f.confirm();
    await flush();
    assert.equal(f.requests.length, 1);
    const request = f.requests.shift();
    assert.equal(request.url, '/api/daki/draft-folders/folder%2Fone/delete');
    assert.equal(request.options.method, 'POST');
    assert.deepEqual(JSON.parse(request.options.body), {});
    assert.equal(opener.disabled, true);
    request.reply({status: 'success', deleted_folder_id: 'folder/one', project_id: 'project-1', deleted_ids: ['draft-1'], warning: 'Synthetic index warning'});
    await deletion;

    assert.equal(opener.disabled, false);
    assert.equal(f.errors.length, 0);
    assert.equal(f.deleted.length, 1);
    assert.deepEqual(f.deleted[0], {status: 'success', deleted_folder_id: 'folder/one', project_id: 'project-1', deleted_ids: ['draft-1'], warning: 'Synthetic index warning'});
    assert.equal(f.browserConfirms(), 0);
});

test('Daki reference cancellation does not retry; approval adds confirm_daki once', async t => {
    await t.test('cancel', async () => {
        const f = fixture(), opener = f.action();
        const deletion = opener.onclick(); f.confirm(); await flush();
        f.requests.shift().reply({status: 'error', code: 'daki_references', references: [{project_name: 'Other project', side: 'back'}]}, 409);
        await flush();
        const dialog = f.modal();
        assert.equal(dialog.open, true);
        assert.equal(f.doc.getElementById('dakiDraftFolderDeleteTitle').textContent, '사용 중인 시안도 삭제할까요?');
        assert.equal(f.controls('daki-draft-folder-delete-confirm')[0].textContent, '그래도 삭제');
        assert.match(f.controls('daki-draft-folder-delete-description')[0].textContent, /Other project · 뒷면/);
        f.cancel(); await deletion;
        assert.equal(f.requests.length, 0);
        assert.equal(f.deleted.length, 0);
        assert.equal(opener.disabled, false);
    });
    await t.test('approve', async () => {
        const f = fixture(), opener = f.action({id: 'folder/one', name: 'Synthetic folder'});
        const deletion = opener.onclick(); f.confirm(); await flush();
        const first = f.requests.shift();
        first.reply({status: 'error', code: 'daki_references', references: [{project_name: 'Other project', side: 'front'}]}, 409);
        await flush();
        assert.equal(f.modal().open, true);
        f.confirm(); await flush();
        const retry = f.requests.shift();
        assert.equal(retry.url, first.url);
        assert.deepEqual(JSON.parse(retry.options.body), {confirm_daki: true});
        retry.reply({status: 'success', deleted_folder_id: 'folder/one', deleted_ids: []});
        await deletion;
        assert.equal(f.requests.length, 0);
        assert.equal(f.deleted.length, 1);
        assert.equal(opener.disabled, false);
    });
});

test('network and server errors leave the action retryable and do not report deletion', async t => {
    for (const [name, respond] of [
        ['http error', request => request.reply({status: 'error', message: 'Folder still running'}, 409)],
        ['transport error', request => request.fail(new Error('Synthetic connection failure'))],
    ]) {
        await t.test(name, async () => {
            const f = fixture(), opener = f.action();
            const deletion = opener.onclick(); f.confirm(); await flush();
            respond(f.requests.shift());
            await deletion;
            assert.equal(opener.disabled, false);
            assert.equal(opener.isConnected, true);
            assert.equal(f.errors.length, 1);
            assert.match(f.errors[0], /Folder still running|Synthetic connection failure/);
            assert.equal(f.deleted.length, 0);
        });
    }
});

test('duplicate activations while confirmation or request is pending stay single-shot', async () => {
    const f = fixture(), opener = f.action();
    const first = opener.onclick();
    const duplicate = opener.onclick();
    assert.equal(f.modal().open, true);
    assert.equal(f.requests.length, 0);
    f.confirm(); await flush();
    assert.equal(f.requests.length, 1);
    f.requests.shift().reply({status: 'success', deleted_folder_id: 'folder-1', deleted_ids: []});
    await Promise.all([first, duplicate]);
    assert.equal(f.deleted.length, 1);
});

test('cancel, close, Escape, backdrop, and native close resolve without deleting and restore focus', async t => {
    const cases = [
        ['cancel button', (f, dialog) => f.cancel()],
        ['close button', f => f.controls('daki-draft-folder-delete-close')[0].onclick()],
        ['Escape', (f, dialog) => {
            let stopped = 0;
            dialog.dispatch('keydown', {key: 'Escape', stopPropagation() { stopped++; }});
            assert.equal(stopped, 1);
            let prevented = 0;
            dialog.dispatch('cancel', {preventDefault() { prevented++; }});
            assert.equal(prevented, 1);
        }],
        ['backdrop', (f, dialog) => dialog.dispatch('click', {target: dialog, clientX: 20, clientY: 20})],
        ['native close', (f, dialog) => dialog.close()],
    ];
    for (const [name, dismiss] of cases) {
        await t.test(name, async () => {
            const f = fixture(), opener = f.action();
            const deletion = opener.onclick();
            const dialog = f.modal();
            dismiss(f, dialog);
            await deletion;
            assert.equal(dialog.open, false);
            assert.equal(f.doc.activeElement, opener);
            assert.equal(opener.focusOptions.preventScroll, true);
            assert.equal(f.requests.length, 0);
            assert.equal(opener.disabled, false);
        });
    }
});

test('leaving the page cancels a pending confirmation without restoring focus or sending a request', async () => {
    const f = fixture(), opener = f.action();
    const deletion = opener.onclick();
    f.setCurrent(false);
    f.api.close(false);
    await deletion;
    assert.equal(f.modal().open, false);
    assert.notEqual(f.doc.activeElement, opener);
    assert.equal(f.requests.length, 0);
});

test('a stale confirmation click cannot authorize deletion after the view changes', async () => {
    const f = fixture(), opener = f.action();
    const deletion = opener.onclick();
    const confirm = f.controls('daki-draft-folder-delete-confirm')[0];
    f.setCurrent(false);
    let prevented = 0;
    confirm.onclick({defaultPrevented: false, preventDefault() { prevented++; }});
    await deletion;
    assert.equal(prevented, 1);
    assert.equal(f.requests.length, 0);
    assert.equal(f.deleted.length, 0);
});

test('late successful responses after navigation do not call the view callback', async () => {
    const f = fixture(), opener = f.action();
    const deletion = opener.onclick(); f.confirm(); await flush();
    const request = f.requests.shift();
    f.setCurrent(false);
    request.reply({status: 'success', deleted_folder_id: 'folder-1', deleted_ids: []});
    await deletion;
    assert.equal(f.deleted.length, 0);
    assert.equal(f.errors.length, 0);
    assert.equal(opener.disabled, false);
});

test('a queued old close event cannot cancel a newly opened confirmation', async () => {
    const f = fixture(); f.queueCloseEvents(true);
    const firstButton = f.action({id: 'first', name: 'First'});
    const first = firstButton.onclick();
    f.cancel(); await first;
    assert.equal(f.doc.queuedCloseEvents.length, 1);

    const nextButton = f.action({id: 'second', name: 'Second'});
    const next = nextButton.onclick();
    const dialog = f.modal();
    f.dispatchQueuedClose();
    assert.equal(dialog.open, true);
    assert.equal(f.controls('daki-draft-folder-delete-name')[0].textContent, 'Second');
    f.confirm(); await flush();
    f.requests.shift().reply({status: 'success', deleted_folder_id: 'second', deleted_ids: []});
    await next;
    assert.equal(f.deleted.length, 1);
});
