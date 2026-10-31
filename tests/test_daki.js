const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {deleteRequest, deletionMessage, formatProjectDate, sortProjectItems, isActive} = require('../static/daki.js');

function response(status, result) {
    return {status, ok: status >= 200 && status < 300, json: async () => result};
}

const references = [
    {project_name: 'Sample project', side: 'front'},
    {project_name: 'Sample project', side: 'back'},
];

function warning() {
    return response(409, {status: 'error', code: 'daki_references', references});
}

test('cancelled warning never retries or adds approval to the original payload', async () => {
    const payload = {path: 'sample/front.png'};
    const requests = [];
    const prompts = [];
    const initial = warning();
    const reply = await deleteRequest('/api/gallery/trash_image', payload,
        async (url, options) => { requests.push({url, options}); return initial; },
        message => { prompts.push(message); return false; });

    assert.equal(reply.cancelled, true);
    assert.equal(reply.response, initial);
    assert.equal(reply.result.code, 'daki_references');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/api/gallery/trash_image');
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(requests[0].options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(requests[0].options.body), payload);
    assert.deepEqual(payload, {path: 'sample/front.png'});
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /Sample project · 앞면/);
    assert.match(prompts[0], /Sample project · 뒷면/);
});

test('approved warning retries once with all original fields and explicit approval', async () => {
    const payload = {paths: ['sample/front.png', 'sample/back.png'], permanent: false};
    const requests = [];
    let prompts = 0;
    const success = response(200, {status: 'success', deleted: 2});
    const reply = await deleteRequest('/api/delete', payload,
        async (url, options) => {
            requests.push({url, body: JSON.parse(options.body)});
            return requests.length === 1 ? warning() : success;
        }, () => { prompts++; return true; });

    assert.equal(reply.response, success);
    assert.deepEqual(reply.result, {status: 'success', deleted: 2});
    assert.equal(reply.cancelled, false);
    assert.equal(prompts, 1);
    assert.deepEqual(requests, [
        {url: '/api/delete', body: payload},
        {url: '/api/delete', body: {...payload, confirm_daki: true}},
    ]);
    assert.equal(Object.hasOwn(payload, 'confirm_daki'), false);
});

test('async reference-warning callbacks can cancel or approve while synchronous callers remain supported', async () => {
    const cancelledRequests = [];
    const cancelled = await deleteRequest('/api/delete', {path: 'sample/a.png'},
        async (url, options) => { cancelledRequests.push(JSON.parse(options.body)); return warning(); },
        async () => false);
    assert.equal(cancelled.cancelled, true);
    assert.deepEqual(cancelledRequests, [{path: 'sample/a.png'}]);

    const approvedRequests = [];
    const approved = await deleteRequest('/api/delete', {path: 'sample/a.png'},
        async (url, options) => {
            approvedRequests.push(JSON.parse(options.body));
            return approvedRequests.length === 1 ? warning() : response(200, {status: 'success'});
        },
        async () => true);
    assert.equal(approved.result.status, 'success');
    assert.deepEqual(approvedRequests, [
        {path: 'sample/a.png'},
        {path: 'sample/a.png', confirm_daki: true},
    ]);
});

test('a repeated reference conflict after approval is returned without another prompt or retry', async () => {
    let requests = 0;
    let prompts = 0;
    const reply = await deleteRequest('/api/delete', {path: 'sample/a.png'},
        async () => { requests++; return warning(); },
        () => { prompts++; return true; });

    assert.equal(requests, 2);
    assert.equal(prompts, 1);
    assert.equal(reply.response.status, 409);
    assert.equal(reply.cancelled, false);
});

test('success, unrelated conflicts and other errors pass through without confirmation or retry', async () => {
    for (const initial of [
        response(200, {status: 'success'}),
        response(409, {status: 'error', code: 'another_conflict'}),
        response(403, {status: 'error', code: 'daki_references'}),
        response(500, {status: 'error', message: 'Synthetic server failure'}),
    ]) {
        let requests = 0;
        const reply = await deleteRequest('/api/delete', {path: 'sample/a.png'},
            async () => { requests++; return initial; },
            () => { assert.fail('This response must not ask for Daki approval'); });
        assert.equal(requests, 1);
        assert.equal(reply.response, initial);
        assert.deepEqual(reply.result, await initial.json());
        assert.equal(reply.cancelled, false);
    }
});

test('transport failure rejects without prompting or retrying', async () => {
    const error = new Error('Synthetic connection failure');
    let requests = 0;
    await assert.rejects(deleteRequest('/api/delete', {path: 'sample/a.png'},
        async () => { requests++; throw error; },
        () => { assert.fail('A failed request must not ask for approval'); }), error);
    assert.equal(requests, 1);
});

test('invalid JSON rejects without treating a conflict as an approved delete', async () => {
    const error = new SyntaxError('Synthetic invalid JSON');
    let requests = 0;
    await assert.rejects(deleteRequest('/api/delete', {path: 'sample/a.png'},
        async () => {
            requests++;
            return {status: 409, ok: false, json: async () => { throw error; }};
        }, () => { assert.fail('Invalid JSON must not ask for approval'); }), error);
    assert.equal(requests, 1);
});

test('transport failure after approval is propagated without a third attempt', async () => {
    const error = new Error('Synthetic retry connection failure');
    let requests = 0;
    let prompts = 0;
    await assert.rejects(deleteRequest('/api/delete', {path: 'sample/a.png'},
        async () => {
            if (++requests === 1) return warning();
            throw error;
        }, () => { prompts++; return true; }), error);
    assert.equal(requests, 2);
    assert.equal(prompts, 1);
});

test('warning names both sides, deduplicates references and explains broken original links', () => {
    const message = deletionMessage([...references, references[0]]);
    assert.equal(message.split('Sample project · 앞면').length - 1, 1);
    assert.equal(message.split('Sample project · 뒷면').length - 1, 1);
    assert.match(message, /원본 연결이 끊길 수 있습니다/);
    assert.match(message, /그래도 삭제하시겠습니까/);
});

test('warning limits project entries and counts remaining unique references', () => {
    const many = Array.from({length: 11}, (_, index) => ({project_name: `Project ${index}`, side: 'front'}));
    const message = deletionMessage([...many, many[0]]);
    assert.match(message, /Project 7 · 앞면/);
    assert.doesNotMatch(message, /Project 8 · 앞면/);
    assert.match(message, /외 3개/);
});

test('project dates format valid ISO values in local time and reject missing or invalid values', () => {
    const source = '2025-04-03T13:05:00Z';
    const date = new Date(source);
    const pad = value => String(value).padStart(2, '0');
    const expected = `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;

    assert.equal(formatProjectDate(source), expected);
    assert.equal(formatProjectDate('2025-04-03'), formatProjectDate('2025-04-03T00:00:00Z'));
    for (const value of [undefined, null, '', 'yesterday', '2025-02-30T12:00:00Z', '2025-04-03 13:05:00']) {
        assert.equal(formatProjectDate(value), '알 수 없음');
    }
});

test('project sorting is stable, keeps missing dates last in either direction, and does not mutate input', () => {
    const items = [
        {name: 'older-created', created_at: '2023-01-01T00:00:00Z', updated_at: '2024-05-01T00:00:00Z'},
        {name: 'newer', created_at: '2020-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z'},
        {name: 'same-update', created_at: '2021-01-01T00:00:00Z', updated_at: '2024-05-01T00:00:00Z'},
        {name: 'unknown', created_at: null, updated_at: 'invalid', added_at: '2026-01-01T00:00:00Z'},
    ];
    const initial = [...items];
    const names = mode => sortProjectItems(items, mode).map(item => item.name);

    assert.deepEqual(names('original'), ['older-created', 'newer', 'same-update', 'unknown']);
    assert.deepEqual(names('updated-desc'), ['newer', 'older-created', 'same-update', 'unknown']);
    assert.deepEqual(names('updated-asc'), ['older-created', 'same-update', 'newer', 'unknown']);
    assert.deepEqual(names('created-desc'), ['older-created', 'same-update', 'newer', 'unknown']);
    assert.deepEqual(names('created-asc'), ['newer', 'same-update', 'older-created', 'unknown']);
    assert.deepEqual(names('unknown-mode'), names('original'));
    assert.notEqual(sortProjectItems(items, 'original'), items);
    assert.deepEqual(items, initial);
});

test('a reference conflict without reference details can still be cancelled safely', async () => {
    let requests = 0;
    const reply = await deleteRequest('/api/delete', {path: 'sample/a.png'},
        async () => {
            requests++;
            return response(409, {status: 'error', code: 'daki_references'});
        }, message => {
            assert.match(message, /원본 연결이 끊길 수 있습니다/);
            return false;
        });
    assert.equal(requests, 1);
    assert.equal(reply.cancelled, true);
});

test('daki routes preserve project links and let gallery navigation override the direct daki URL', () => {
    for (const [path, active] of [
        ['/', false], ['/#gallery', false], ['/#daki', true], ['/#project=sample', true],
        ['/daki', true], ['/daki#daki', true], ['/daki#project=sample', true],
        ['/daki#gallery', false], ['/daki#gallery&project=sample', false], ['/#unrelated', false],
        ['/#daki&library=worldcups&gallery_key=test%3Asample', true],
    ]) {
        assert.equal(isActive(new URL(path, 'http://localhost')), active, path);
    }
});

function inlineLibraryFixture(path = '/#daki', readyState = 'loading', deferDraftFolders = false) {
    class Element {
        constructor(tagName = '') {
            this.children = [];
            this.dataset = {};
            this.classes = new Set();
            this.attributes = {};
            this.listeners = new Map();
            this.tagName = tagName.toUpperCase();
            this.parentNode = null;
            this.disabled = false;
            this.classList = {
                contains: name => this.classes.has(name),
                add: name => this.classes.add(name),
                remove: name => this.classes.delete(name),
                toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name),
            };
        }
        get isConnected() {
            for (let node = this; node; node = node.parentNode) if (node.isDocumentRoot) return true;
            return false;
        }
        get firstChild() { return this.children[0] || null; }
        set className(value) { this.classes = new Set(value.split(' ')); }
        appendChild(node) {
            if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1);
            node.parentNode = this;
            this.children.push(node);
            return node;
        }
        append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
        replaceChildren(...nodes) {
            this.children.forEach(node => { node.parentNode = null; });
            this.children = [];
            this.append(...nodes);
        }
        replaceChild(node, old) {
            const index = this.children.indexOf(old);
            if (index >= 0) {
                old.parentNode = null;
                if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1);
                node.parentNode = this;
                this.children[index] = node;
            }
            return old;
        }
        setAttribute(name, value) { this.attributes[name] = value; }
        removeAttribute(name) { delete this.attributes[name]; }
        addEventListener(name, callback) { this.listeners.set(name, callback); }
        focus(options) { this.focusOptions = options; if (this.ownerDocument) this.ownerDocument.activeElement = this; }
        showModal() { this.open = true; }
        close() {
            const wasOpen = this.open;
            this.open = false;
            if (wasOpen) this.listeners.get('close')?.({target: this});
        }
        getBoundingClientRect() { return this.rect || {left: 100, top: 100, right: 500, bottom: 500}; }
        querySelector(selector) {
            assert.equal(selector, '.daki-nav');
            return this.children.find(node => node.classList.contains('daki-nav')) || null;
        }
        querySelectorAll(selector) {
            assert.equal(selector, '.flex-masonry');
            const found = [];
            const visit = node => {
                if (node.classList.contains('flex-masonry')) found.push(node);
                node.children.forEach(visit);
            };
            this.children.forEach(visit);
            return found;
        }
    }
    const ids = ['nav-tabs', 'content', 'dakiLibrary', 'dakiContent', 'dakiPageStatus', 'dakiTitle', 'dakiSubtitle', 'dakiBack'];
    const nodes = new Map(ids.map(id => [id, new Element()]));
    const body = new Element();
    body.isDocumentRoot = true;
    body.appendChild(nodes.get('dakiLibrary'));
    nodes.get('dakiLibrary').appendChild(nodes.get('dakiContent'));
    const galleryImage = new Element();
    galleryImage.selected = true;
    galleryImage.addEventListener('click', () => 'gallery action');
    nodes.get('content').appendChild(galleryImage);
    const domEvents = new Map();
    const windowEvents = new Map();
    const requests = [];
    const previewSessions = [];
    const confirmations = [];
    const detailOpens = [];
    const detailCloses = [];
    let confirmImpl = () => true;
    const doc = {
        body,
        readyState,
        activeElement: null,
        getElementById: id => nodes.get(id) || null,
        createElement: tagName => { const item = new Element(tagName); item.ownerDocument = doc; return item; },
        addEventListener: (name, callback) => domEvents.set(name, callback),
    };
    const win = {
        document: doc,
        location: new URL(path, 'http://localhost'),
        scrollY: 640,
        scrollTo(x, y) { this.scrollY = y; },
        addEventListener: (name, callback) => windowEvents.set(name, callback),
        confirm: message => { confirmations.push(message); return confirmImpl(message); },
        fetch: (url, options = {}) => url === '/api/daki/settings'
            ? Promise.resolve(response(200, {status: 'success', enabled: true}))
            : url.startsWith('/api/daki/draft-folders?project=') && !deferDraftFolders
                ? Promise.resolve(response(200, {status: 'success', folders: []}))
            : new Promise(resolve => requests.push({
                url,
                options,
                reply: (data, status = 200) => resolve(response(status, {status: status >= 200 && status < 300 ? 'success' : 'error', ...data})),
            })),
        DakiCanvasPreviews: {
            create() {
                const session = {observations: [], disposed: false};
                previewSessions.push(session);
                return {
                    observe: (container, projectId, canvas) => session.observations.push({container, projectId, canvas}),
                    dispose: () => { session.disposed = true; },
                };
            },
        },
        DakiProjectDetails: {
            open: options => { detailOpens.push(options); return Promise.resolve(true); },
            close: restoreFocus => detailCloses.push(restoreFocus),
        },
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../static/daki.js'), 'utf8'), {window: win, URLSearchParams});
    return {
        nodes, doc, win, requests, previewSessions, galleryImage, windowEvents, confirmations, detailOpens, detailCloses,
        initialize: () => domEvents.get('DOMContentLoaded')(),
        navigate: hash => { win.location.hash = hash; return windowEvents.get('hashchange')(); },
        setConfirm: fn => { confirmImpl = fn; },
    };
}

function descendants(node) {
    return [node, ...(node.children || []).flatMap(descendants)];
}

function classed(node, className) {
    return descendants(node).filter(item => item.classList.contains(className));
}

test('project list exposes deletion outside its navigation link and refreshes after confirmed removal', async () => {
    const f = inlineLibraryFixture('/#daki');
    const actions = [];
    f.win.DakiProjectRemoval = {close() {}, createButton(options) {
        actions.push(options);
        const button = f.doc.createElement('button'); button.textContent = '프로젝트 삭제';
        return button;
    }};
    await f.initialize();
    f.requests.shift().reply({projects: [{id:'synthetic',name:'Synthetic',candidates:{front:[],back:[]},canvases:{front:[],back:[]}}]});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(actions.length, 1);
    assert.equal(actions[0].isCurrent(), true);
    const card = classed(f.nodes.get('dakiContent'), 'daki-project-list-card')[0];
    assert.equal(card.tagName, 'DIV');
    assert.equal(classed(card, 'daki-project-list-link')[0].tagName, 'A');
    assert.equal(classed(card, 'daki-project-list-actions')[0].children[0].textContent, '프로젝트 삭제');
    const deletion = actions[0].onDeleted({warning:'Synthetic warning'});
    f.requests.shift().reply({projects:[]}); await deletion;
    assert.equal(classed(f.nodes.get('dakiContent'), 'daki-project-list-card').length, 0);
    assert.equal(f.nodes.get('dakiPageStatus').textContent, 'Synthetic warning');
    assert.equal(actions[0].isCurrent(), false);
});

test('project cards distinguish upscaled pictures with one badge', async () => {
    const f = await projectPageFixture({
        id: 'sample', name: 'Synthetic',
        candidates: {front: [
            {id: 'original', path: 'source.png'},
            {id: 'result', path: 'result.png', upscale: {is_upscaled: true}},
        ], back: []},
        canvases: {front: [], back: []},
    });
    const badges = classed(f.nodes.get('dakiContent'), 'daki-project-kind');
    assert.equal(badges.filter(b => b.dataset.kind === 'upscale').length, 1);
    assert.equal(badges.find(b => b.dataset.kind === 'upscale').textContent, '⬆ UPSCALE');
    assert.equal(badges.filter(b => b.dataset.kind === 'image').length, 1);
});

async function projectPageFixture(project, configure) {
    const f = inlineLibraryFixture(`/#project=${encodeURIComponent(project.id)}`);
    configure?.(f);
    await f.initialize();
    f.requests.shift().reply({project});
    await new Promise(resolve => setImmediate(resolve));
    return f;
}

function projectAction(f, cardClass, label) {
    const card = classed(f.nodes.get('dakiContent'), cardClass)[0];
    return classed(card, 'gallery-card-action-btn').find(button => button.textContent === label);
}

function projectDeleteDialog(f) {
    return classed(f.doc.body, 'daki-project-delete-dialog')[0];
}

function projectDeleteDialogControl(f, label) {
    return classed(projectDeleteDialog(f), 'daki-project-delete-confirm').find(button => button.textContent === label);
}

function clickProjectDeleteConfirm(button) {
    let prevented = 0;
    button.onclick({defaultPrevented: false, preventDefault: () => prevented++});
    return prevented;
}

test('draft folders are shown only inside their project and never as a Daki root library', async () => {
    const f = inlineLibraryFixture('/#project=sample', 'loading', true);
    await f.initialize();
    f.requests.shift().reply({project: {id: 'sample', name: 'Synthetic project', candidates: {front: [], back: []}}});
    await new Promise(resolve => setImmediate(resolve));
    const request = f.requests.shift();
    assert.equal(request.url, '/api/daki/draft-folders?project=sample');
    request.reply({folders: [
        {id: 'mine', name: 'Synthetic draft session', project_id: 'sample', count: 3, selected_count: 1},
        {id: 'other', name: 'Unrelated session', project_id: 'other-project', count: 2, selected_count: 0},
    ]});
    await new Promise(resolve => setImmediate(resolve));
    const folderLinks = descendants(f.nodes.get('dakiContent')).filter(item => item.href?.includes('&folder='));
    assert.equal(folderLinks.length, 1);
    assert.equal(folderLinks[0].href, '#daki&library=drafts&project=sample&folder=mine');
    const navigating = f.navigate('#daki');
    f.requests.shift().reply({projects: []}); await navigating;
    assert.equal(descendants(f.nodes.get('dakiContent')).some(item => item.href?.includes('library=drafts')), false);
});

test('a late project-folder response cannot populate a departed project', async () => {
    const f = inlineLibraryFixture('/#project=sample', 'loading', true);
    await f.initialize();
    f.requests.shift().reply({project: {id: 'sample', name: 'Synthetic project', candidates: {front: [], back: []}}});
    await new Promise(resolve => setImmediate(resolve));
    const pending = f.requests.shift();
    await f.navigate('#gallery');
    const before = [...f.nodes.get('dakiContent').children];
    pending.reply({folders: [{id: 'late', name: 'Late folder', project_id: 'sample', count: 0, selected_count: 0}]});
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.nodes.get('dakiContent').children, before);
    assert.equal(descendants(f.nodes.get('dakiContent')).some(item => item.href?.includes('&folder=late')), false);
});

test('deferred startup waits for the worldcup module before rendering a direct result URL', async () => {
    const f = inlineLibraryFixture('/#daki&library=worldcups&result=synthetic', 'interactive');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.requests.length, 0, 'must not fall back to projects before later deferred scripts run');
    const calls = [];
    f.win.DakiWorldCup = {leave() {}, render: params => calls.push(params.get('result'))};
    await f.initialize();
    assert.deepEqual(calls, ['synthetic']);
    assert.equal(f.requests.length, 0);
});

test('returning from daki preserves the gallery DOM, selection, handlers and scroll position', async () => {
    const f = inlineLibraryFixture('/daki');
    const imageHandler = f.galleryImage.listeners.get('click');
    await f.initialize();
    assert.equal(f.nodes.get('dakiLibrary').hidden, false);
    assert.equal(f.win.scrollY, 0);
    const pending = f.requests.shift();
    assert.equal(pending.url, '/api/daki/projects');

    f.nodes.get('nav-tabs').listeners.get('click')({target: {closest: () => ({})}});
    assert.equal(f.win.location.hash, '#gallery');
    assert.equal(f.nodes.get('dakiLibrary').hidden, true);
    assert.equal(f.win.scrollY, 640);
    await f.navigate('#gallery');
    pending.reply({projects: []});
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(f.nodes.get('dakiContent').children.length, 0);
    assert.equal(f.nodes.get('content').children[0], f.galleryImage);
    assert.equal(f.galleryImage.selected, true);
    assert.equal(f.galleryImage.listeners.get('click'), imageHandler);
    assert.equal(f.doc.body.classList.contains('gallery-daki-active'), false);
});

test('late list responses cannot overwrite a newer project and rebuilt navigation retains the active item', async () => {
    const f = inlineLibraryFixture();
    await f.initialize();
    const staleList = f.requests.shift();
    const projectLoad = f.navigate('#project=sample');
    const projectRequest = f.requests.shift();
    assert.equal(projectRequest.url, '/api/daki/projects/sample');
    projectRequest.reply({project: {id: 'sample', name: 'Selected project', candidates: {front: [], back: []}}});
    await projectLoad;
    const projectNodes = [...f.nodes.get('dakiContent').children];
    staleList.reply({projects: []});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.nodes.get('dakiTitle').textContent, 'Selected project');
    const generate = classed(f.nodes.get('dakiContent'), 'daki-project-generate-link')
        .filter(item => !item.classList.contains('daki-project-import-button')
            && !item.classList.contains('daki-project-settings-button'));
    assert.equal(generate.length, 1);
    assert.equal(generate[0].textContent, '시안 만들기');
    assert.equal(generate[0].href, '#daki&library=drafts&project=sample&new=1');
    const imports = classed(f.nodes.get('dakiContent'), 'daki-project-import-button');
    assert.equal(imports.length, 1);
    assert.equal(imports[0].textContent, '그림 가져오기');
    let importOptions;
    f.win.DakiImageImport = {open: options => { importOptions = options; }};
    imports[0].onclick();
    assert.equal(importOptions.projectId, 'sample');
    assert.equal(importOptions.projectName, 'Selected project');
    const linkedSettings = classed(f.nodes.get('dakiContent'), 'daki-project-settings-button');
    assert.equal(linkedSettings.length, 1);
    let settingsOptions;
    f.win.DakiProjectSettings = {open: options => { settingsOptions = options; }};
    linkedSettings[0].onclick();
    assert.equal(settingsOptions.projectId, 'sample');
    assert.equal(settingsOptions.projectName, 'Selected project');
    assert.equal(settingsOptions.opener, linkedSettings[0]);
    assert.deepEqual(f.nodes.get('dakiContent').children, projectNodes);

    const navigation = f.nodes.get('nav-tabs');
    navigation.replaceChildren();
    f.win.Daki.mountNavigation(navigation);
    f.win.Daki.mountNavigation(navigation);
    assert.equal(navigation.children.length, 1);
    const link = navigation.children[0];
    assert.equal(link.hidden, false);
    assert.equal(link.classList.contains('active'), true);
    assert.equal(link.attributes['aria-current'], 'page');
    await f.navigate('#gallery');
    assert.equal(link.classList.contains('active'), false);
    assert.equal(Object.hasOwn(link.attributes, 'aria-current'), false);
});

test('project list prefers the first canvas per side and falls back to the first image candidate', async () => {
    const f = inlineLibraryFixture();
    await f.initialize();
    const request = f.requests.shift();
    request.reply({projects: [{
        id: 'sample', name: 'Synthetic project',
        candidates: {front: [{path: 'front-candidate.png'}], back: [{path: 'back-candidate.png'}]},
        canvases: {
            front: [
                {id: 'front-first', name: 'Front', side: 'front', revision: 2},
                {id: 'front-second', name: 'Later front', side: 'front', revision: 1},
            ],
            back: [],
        },
    }]});
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(f.previewSessions[0].observations.map(({projectId, canvas}) => [projectId, canvas.id]), [['sample', 'front-first']]);
    const projectCard = classed(f.nodes.get('dakiContent'), 'daki-project-card').find(card => card.href === '#project=sample');
    assert.ok(projectCard);
    const faces = classed(projectCard, 'daki-project-preview-face');
    assert.equal(faces.length, 2);
    assert.equal(faces[0].children.length, 0, 'canvas preview is delegated to the shared preview manager');
    assert.equal(faces[1].children[0].src, '/image/back-candidate.png?preview=768');
    assert.equal(f.nodes.get('dakiTitle').textContent, 'Daki 프로젝트');
    const libraryLinks = classed(f.nodes.get('dakiContent'), 'daki-project-card').map(card => card.href);
    assert.deepEqual(libraryLinks.filter(href => href.startsWith('#daki&library=')).sort(), [
        '#daki&library=personal', '#daki&library=shared', '#daki&library=worldcups',
    ]);
    assert.equal(classed(f.nodes.get('dakiContent'), 'daki-project-controls').length, 0);
    assert.equal(f.doc.body.classList.contains('daki-project-active'), false);
    assert.equal(f.win.Daki.mountNavigation(f.nodes.get('nav-tabs')), undefined);
    assert.equal(f.nodes.get('nav-tabs').children[0].textContent, 'Daki');
});

test('project sides combine canvas and image cards in one gallery grid with kind badges', async () => {
    const f = inlineLibraryFixture('/#project=sample');
    let layout = {columns: 3, fixed: false};
    f.win.getGalleryGridLayout = () => layout;
    await f.initialize();
    const request = f.requests.shift();
    request.reply({project: {
        id: 'sample', name: 'Synthetic project',
        candidates: {
            front: [{id: 'front-image', path: 'front-image.png', width: 1024, height: 3072, created_at: '2025-04-03T13:05:00Z', added_at: '2030-01-01T00:00:00Z'}],
            back: [{id: 'back-image', path: 'back-image.png'}],
        },
        canvases: {
            front: [{id: 'front-a', name: 'Front A', side: 'front', revision: 1, width: 800, height: 600, layerCount: 3, created_at: '2024-03-02T04:05:00Z', updated_at: '2025-06-07T08:09:00Z'}],
            back: [{id: 'back-a', name: 'Back A', side: 'back', revision: 2, width: 600, height: 800, layerCount: 4}],
        },
    }});
    await new Promise(resolve => setImmediate(resolve));

    const panels = classed(f.nodes.get('dakiContent'), 'daki-side');
    assert.equal(panels.length, 2);
    const titles = panels.map(panel => classed(panel, 'section-title')[0]);
    assert.deepEqual(titles.map(title => title.textContent), ['앞면', '뒷면']);
    assert.deepEqual(titles.map(title => title.children[0].textContent), ['2개', '2개']);
    const grids = classed(f.nodes.get('dakiContent'), 'daki-project-items');
    assert.equal(grids.length, 2);
    assert.ok(grids.every(grid => !grid.classList.contains('gallery-fixed-size-grid')));
    const cards = classed(f.nodes.get('dakiContent'), 'daki-project-canvas');
    assert.equal(cards.length, 2);
    assert.ok(cards.every(card => card.tagName === 'DIV'));
    const previews = cards.map(card => classed(card, 'daki-canvas-preview')[0]);
    assert.deepEqual(previews.map(preview => [preview.href, preview.target, preview.rel]), [
        ['/canvas?project=sample&canvas=front-a', '_blank', 'noopener'],
        ['/canvas?project=sample&canvas=back-a', '_blank', 'noopener'],
    ]);
    assert.deepEqual(f.previewSessions[0].observations.map(({canvas}) => canvas.id), ['front-a', 'back-a']);
    assert.equal(classed(cards[0], 'daki-canvas-preview').length, 1);
    assert.equal(classed(cards[0], 'daki-project-canvas-info')[0].children[0].children[0].title, 'Front A');
    assert.deepEqual(classed(cards[0], 'daki-project-dates')[0].children.map(item => item.textContent), [
        '생성', formatProjectDate('2024-03-02T04:05:00Z'), '수정', formatProjectDate('2025-06-07T08:09:00Z'),
    ]);
    const opens = cards.map(card => classed(card, 'daki-project-canvas-open')[0]);
    assert.deepEqual(opens.map(open => [open.textContent, open.href, open.target, open.rel]), [
        ['캔버스 열기 ↗', '/canvas?project=sample&canvas=front-a', '_blank', 'noopener'],
        ['캔버스 열기 ↗', '/canvas?project=sample&canvas=back-a', '_blank', 'noopener'],
    ]);
    assert.ok(cards.every(card => classed(card, 'daki-project-card-actions').length === 1));
    assert.ok(cards.every(card => classed(card, 'gallery-card-action-btn').some(button => button.textContent === '캔버스 삭제')));
    const candidateCards = classed(f.nodes.get('dakiContent'), 'daki-candidate');
    assert.equal(candidateCards.length, 2);
    assert.deepEqual(candidateCards.map(card => classed(card, 'daki-image-dimensions')[0].textContent),
        ['1024 × 3072 px', '크기 확인 불가']);
    assert.equal(classed(cards[0], 'daki-project-canvas-info')[0].children[1].textContent,
        '800 × 600 px · 레이어 3개');
    assert.deepEqual(classed(candidateCards[0], 'daki-project-dates')[0].children.map(item => item.textContent), [
        '생성', formatProjectDate('2025-04-03T13:05:00Z'), '수정', '알 수 없음',
    ], 'candidate dates use original-file timestamps and do not fall back to added_at');
    assert.ok(classed(candidateCards[0], 'daki-project-canvas-details').length === 0);
    assert.ok(candidateCards.every(card => classed(card, 'daki-project-card-actions').length === 1));
    assert.ok(candidateCards.every(card => classed(card, 'gallery-card-action-btn').some(button => button.textContent === '그림 삭제')));
    assert.deepEqual(JSON.parse(JSON.stringify(grids.map(grid => grid.galleryZoomImages.map(image => image.path)))), [['front-image.png'], ['back-image.png']]);
    const sort = classed(f.nodes.get('dakiContent'), 'daki-project-sort')[0];
    assert.equal(sort.value, 'original');
    assert.deepEqual(sort.children.map(option => [option.value, option.textContent]), [
        ['original', '기존 순서'], ['updated-desc', '수정일 최신순'], ['updated-asc', '수정일 오래된순'],
        ['created-desc', '생성일 최신순'], ['created-asc', '생성일 오래된순'],
    ]);
    for (const [index, panel] of panels.entries()) {
        const badges = classed(panel, 'daki-project-kind');
        assert.deepEqual(badges.map(badge => [badge.textContent, badge.dataset.kind]), [
            ['캔버스', 'canvas'], ['그림', 'image'],
        ]);
        assert.equal(classed(panel, 'daki-empty')[0].hidden, true);
        assert.equal(classed(panel, 'daki-project-canvas-list').length, 0);
        assert.equal(classed(panel, 'daki-candidates').length, 0);
        assert.equal(grids[index].children.length, 3, 'regular layout keeps the existing masonry columns');
    }
    assert.equal(cards[0].children[0].dataset.kind, 'canvas', 'canvas badge stays outside its replaceable preview');
    assert.equal(candidateCards[0].children[0].dataset.kind, 'image');
    assert.equal(descendants(f.nodes.get('dakiContent')).some(node => node.textContent === '태그 그림 이상형 월드컵'), false);

    layout = {columns: 3, fixed: true};
    f.windowEvents.get('resize')();
    assert.ok(grids.every(grid => grid.classList.contains('gallery-fixed-size-grid')));
    assert.deepEqual(grids.map(grid => grid.children.map(item => item.classList.contains('daki-project-canvas') ? 'canvas' : 'image')),
        [['canvas', 'image'], ['canvas', 'image']]);

    await f.navigate('#gallery');
    assert.equal(f.previewSessions[0].disposed, true);
});

test('project reference panel follows navigation and page lifecycle', async () => {
    const f = inlineLibraryFixture('/#project=sample');
    const panels = [];
    f.win.DakiProjectReference = {mount(options) {
        const panel = {options, disposed: false};
        panels.push(panel);
        return {dispose() { panel.disposed = true; }};
    }};
    const replyProject = async id => {
        f.requests.shift().reply({project: {id, name: 'Synthetic project', candidates: {front: [], back: []}}});
        await new Promise(resolve => setImmediate(resolve));
    };
    await f.initialize();
    await replyProject('sample');
    assert.equal(panels[0].options.projectId, 'sample');
    assert.equal(panels[0].options.container, f.nodes.get('dakiContent'));
    assert.equal(panels[0].options.isCurrent(), true);
    const navigation = f.navigate('#project=next');
    assert.equal(panels[0].disposed, true);
    assert.equal(panels[0].options.isCurrent(), false);
    await replyProject('next');
    await navigation;
    assert.equal(panels[1].options.projectId, 'next');
    assert.equal(panels[1].options.isCurrent(), true);
    f.windowEvents.get('pagehide')();
    assert.equal(panels[1].disposed, true);
    const restore = f.windowEvents.get('pageshow')({persisted: true});
    await replyProject('next');
    await restore;
    assert.equal(panels.length, 3);
    await f.navigate('#gallery');
    assert.equal(panels[2].disposed, true);
    assert.equal(panels[2].options.isCurrent(), false);
});

function projectGridLabels(f, sideIndex = 0) {
    const grid = classed(f.nodes.get('dakiContent'), 'daki-project-items')[sideIndex];
    return grid.children.flatMap(column => column.children).map(card => card.classList.contains('daki-project-canvas')
        ? classed(card, 'daki-project-canvas-heading')[0].children[0].textContent
        : classed(card, 'gallery-card-actions')[0].children[0].textContent);
}

test('project sort selector reorders both sides in memory without rebuilding cards or fetching', async () => {
    const f = await projectPageFixture({
        id: 'sample', name: 'Synthetic project',
        candidates: {
            front: [
                {id: 'middle-image', name: 'Middle image', path: 'middle.png', created_at: '2022-01-01T00:00:00Z', updated_at: '2024-06-01T00:00:00Z'},
                {id: 'new-image', name: 'Newest image', path: 'new.png', created_at: '2025-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z'},
                {id: 'unknown-image', name: 'Unknown image', path: 'unknown.png', added_at: '2027-01-01T00:00:00Z'},
            ],
            back: [{id: 'back-image', name: 'Back image', path: 'back.png', created_at: '2021-01-01T00:00:00Z', updated_at: '2023-01-01T00:00:00Z'}],
        },
        canvases: {
            front: [
                {id: 'old-canvas', name: 'Old canvas', width: 800, height: 600, layerCount: 1, created_at: '2023-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z'},
                {id: 'new-canvas', name: 'New canvas', width: 800, height: 600, layerCount: 1, created_at: '2024-01-01T00:00:00Z', updated_at: '2025-05-01T00:00:00Z'},
            ],
            back: [{id: 'back-canvas', name: 'Back canvas', width: 600, height: 800, layerCount: 1, created_at: '2020-01-01T00:00:00Z', updated_at: '2022-01-01T00:00:00Z'}],
        },
    }, fixture => { fixture.win.getGalleryGridLayout = () => ({columns: 1, fixed: false}); });
    const grids = classed(f.nodes.get('dakiContent'), 'daki-project-items');
    const originalCards = grids.map(grid => [...grid.children[0].children]);
    const sort = classed(f.nodes.get('dakiContent'), 'daki-project-sort')[0];
    assert.deepEqual(projectGridLabels(f), ['Old canvas', 'New canvas', 'Middle image', 'Newest image', 'Unknown image']);
    assert.deepEqual(projectGridLabels(f, 1), ['Back canvas', 'Back image']);
    assert.deepEqual(Array.from(grids[0].galleryZoomImages, image => image.path), ['middle.png', 'new.png', 'unknown.png']);

    sort.value = 'updated-desc';
    sort.onchange();
    assert.deepEqual(projectGridLabels(f), ['Newest image', 'New canvas', 'Middle image', 'Old canvas', 'Unknown image']);
    assert.deepEqual(projectGridLabels(f, 1), ['Back image', 'Back canvas']);
    assert.deepEqual(Array.from(grids[0].galleryZoomImages, image => image.path), ['new.png', 'middle.png', 'unknown.png']);
    for (const [index, grid] of grids.entries()) {
        const liveCards = grid.children[0].children;
        assert.equal(liveCards.length, originalCards[index].length);
        assert.ok(liveCards.every(card => originalCards[index].includes(card)), 'sorting moves the existing card nodes');
    }
    assert.equal(f.requests.length, 0, 'sorting does not refetch project data');

    sort.value = 'created-asc';
    sort.onchange();
    assert.deepEqual(projectGridLabels(f), ['Middle image', 'Old canvas', 'New canvas', 'Newest image', 'Unknown image']);
    for (const [index, grid] of grids.entries()) {
        assert.ok(grid.children[0].children.every(card => originalCards[index].includes(card)));
    }
    assert.equal(f.requests.length, 0);
});

test('canvas detail buttons pass the selected canvas and current-view guard to the details module', async () => {
    const canvas = {id: 'front', name: 'Front draft', width: 800, height: 600, layerCount: 2, created_at: '2025-04-03T13:05:00Z', state: {layers: []}};
    const f = await projectPageFixture({
        id: 'sample', name: 'Synthetic project', candidates: {front: [], back: []},
        canvases: {front: [canvas], back: []},
    });
    const button = classed(f.nodes.get('dakiContent'), 'daki-project-canvas-details')[0];
    assert.equal(button.textContent, '상세 정보');
    button.onclick();

    assert.equal(f.detailOpens.length, 1);
    const options = f.detailOpens[0];
    assert.equal(options.projectId, 'sample');
    assert.equal(options.canvas, canvas);
    assert.equal(options.opener, button);
    assert.equal(options.isCurrent(), true);
    assert.equal(typeof options.formatDate, 'function');
    assert.equal(options.formatDate(canvas.created_at), formatProjectDate(canvas.created_at));

    const navigating = f.navigate('#daki');
    const listRequest = f.requests.shift();
    assert.equal(options.isCurrent(), false, 'the captured button cannot act after navigation');
    assert.equal(f.detailCloses.at(-1), false, 'page rendering closes details without forcing focus back');
    listRequest.reply({projects: []});
    await navigating;
});

test('canvas links open a reusable modal and confirmation allows one native open', async () => {
    const f = await projectPageFixture({
        id: 'sample', name: 'Synthetic project', candidates: {front: [], back: []},
        canvases: {
            front: [{id: 'front', name: 'Front draft', width: 800, height: 600, layerCount: 1}],
            back: [{id: 'back', name: 'Back draft', width: 600, height: 800, layerCount: 2}],
        },
    });
    const cards = classed(f.nodes.get('dakiContent'), 'daki-project-canvas');
    const frontLinks = [classed(cards[0], 'daki-canvas-preview')[0], classed(cards[0], 'daki-project-canvas-open')[0]];
    const backPreview = classed(cards[1], 'daki-canvas-preview')[0];
    const open = (link, extra = {}) => {
        let prevented = 0;
        link.onclick({defaultPrevented: false, preventDefault: () => prevented++, ...extra});
        assert.equal(prevented, 1, 'the link itself never opens immediately');
    };

    open(frontLinks[0], {ctrlKey: true});
    const modal = classed(f.doc.body, 'daki-canvas-open-dialog')[0];
    assert.ok(modal);
    assert.equal(modal.id, 'dakiCanvasOpenDialog');
    assert.equal(modal.open, true);
    assert.equal(modal.attributes['aria-labelledby'], 'dakiCanvasOpenTitle');
    assert.equal(modal.attributes['aria-describedby'], 'dakiCanvasOpenDescription');
    assert.equal(classed(modal, 'daki-canvas-open-side')[0].textContent, '앞면');
    assert.equal(classed(modal, 'daki-canvas-open-name')[0].textContent, 'Front draft');
    assert.equal(classed(modal, 'daki-canvas-open-description')[0].textContent, '선택한 캔버스를 새 창에서 엽니다.');
    const cancel = classed(modal, 'daki-canvas-open-cancel')[0];
    const confirm = classed(modal, 'daki-canvas-open-confirm')[0];
    assert.equal(f.doc.activeElement, cancel, 'safe cancel action receives initial focus');
    assert.equal(confirm.href, frontLinks[0].href);
    assert.equal(confirm.target, '_blank');
    assert.equal(confirm.rel, 'noopener');

    open(frontLinks[1], {detail: 0});
    assert.equal(classed(f.doc.body, 'daki-canvas-open-dialog').length, 1, 'reopening reuses the modal');
    assert.equal(classed(modal, 'daki-canvas-open-name')[0].textContent, 'Front draft');
    open(backPreview);
    assert.equal(classed(modal, 'daki-canvas-open-side')[0].textContent, '뒷면');
    assert.equal(classed(modal, 'daki-canvas-open-name')[0].textContent, 'Back draft');
    assert.equal(confirm.href, backPreview.href);
    assert.equal(f.confirmations.length, 0, 'opening the modal does not use browser confirm');

    let prevented = 0;
    confirm.onclick({defaultPrevented: false, preventDefault: () => prevented++});
    assert.equal(prevented, 0, 'accepting leaves the confirmation anchor native default intact');
    assert.equal(modal.open, false);
    assert.equal(confirm.href, backPreview.href, 'href remains available to the accepted native click');
    confirm.onclick({defaultPrevented: false, preventDefault: () => prevented++});
    assert.equal(prevented, 1, 'a second activation without pending selection is blocked');
    assert.equal(f.confirmations.length, 0);
});

test('cancel, close, Escape, and backdrop dismissal do not open and restore focus', async () => {
    const f = await projectPageFixture({
        id: 'sample', name: 'Synthetic project', candidates: {front: [], back: []},
        canvases: {front: [{id: 'canvas', name: 'Front draft', width: 800, height: 600, layerCount: 1}], back: []},
    });
    const preview = classed(f.nodes.get('dakiContent'), 'daki-canvas-preview')[0];
    const open = () => {
        let prevented = 0;
        preview.onclick({defaultPrevented: false, preventDefault: () => prevented++});
        assert.equal(prevented, 1);
    };
    const dismissAndCheck = (dismiss, label) => {
        open();
        const modal = classed(f.doc.body, 'daki-canvas-open-dialog')[0];
        const confirm = classed(modal, 'daki-canvas-open-confirm')[0];
        dismiss(modal);
        assert.equal(modal.open, false, `${label} closes the modal`);
        assert.equal(f.doc.activeElement, preview, `${label} restores focus to the opener`);
        assert.equal(preview.focusOptions.preventScroll, true);
        let prevented = 0;
        confirm.onclick({defaultPrevented: false, preventDefault: () => prevented++});
        assert.equal(prevented, 1, `${label} clears the pending open`);
    };

    dismissAndCheck(modal => classed(modal, 'daki-canvas-open-cancel')[0].onclick(), 'cancel button');
    dismissAndCheck(modal => classed(modal, 'daki-canvas-open-close')[0].onclick(), 'close button');
    dismissAndCheck(modal => {
        let stopped = 0;
        modal.listeners.get('keydown')({
            key: 'Escape',
            stopPropagation: () => stopped++,
            preventDefault: () => assert.fail('Escape keydown must retain the native dialog cancel default'),
        });
        assert.equal(stopped, 1, 'Escape keydown does not reach the background handler');
        let prevented = 0;
        modal.listeners.get('cancel')({preventDefault: () => prevented++});
        assert.equal(prevented, 1, 'Escape cancel event is intercepted');
    }, 'Escape');
    dismissAndCheck(modal => modal.close(), 'external close');
    dismissAndCheck(modal => modal.listeners.get('click')({
        target: modal, clientX: 20, clientY: 20,
    }), 'backdrop click');
    assert.equal(f.confirmations.length, 0);
});

test('a queued close event cannot clear a newly opened canvas selection', async () => {
    const f = await projectPageFixture({
        id: 'sample', name: 'Synthetic project', candidates: {front: [], back: []},
        canvases: {
            front: [{id: 'front', name: 'Front draft', width: 800, height: 600, layerCount: 1}],
            back: [{id: 'back', name: 'Back draft', width: 600, height: 800, layerCount: 2}],
        },
    });
    const cards = classed(f.nodes.get('dakiContent'), 'daki-project-canvas');
    const front = classed(cards[0], 'daki-canvas-preview')[0];
    const back = classed(cards[1], 'daki-canvas-preview')[0];
    front.onclick({defaultPrevented: false, preventDefault() {}});
    const modal = classed(f.doc.body, 'daki-canvas-open-dialog')[0];
    const confirm = classed(modal, 'daki-canvas-open-confirm')[0];
    modal.open = false;
    back.onclick({defaultPrevented: false, preventDefault() {}});
    modal.listeners.get('close')({target: modal});

    assert.equal(modal.open, true);
    assert.equal(classed(modal, 'daki-canvas-open-name')[0].textContent, 'Back draft');
    assert.equal(confirm.href, back.href);
    let prevented = 0;
    confirm.onclick({defaultPrevented: false, preventDefault: () => prevented++});
    assert.equal(prevented, 0, 'current selection remains confirmable after the stale close event');
});

test('middle click opens the modal, right click and already prevented events are ignored', async () => {
    const f = await projectPageFixture({
        id: 'sample', name: 'Synthetic project', candidates: {front: [], back: []},
        canvases: {front: [{id: 'canvas', name: 'Front draft', width: 800, height: 600, layerCount: 1}], back: []},
    });
    const preview = classed(f.nodes.get('dakiContent'), 'daki-canvas-preview')[0];
    preview.onauxclick({button: 2, defaultPrevented: false, preventDefault: () => assert.fail('Right-click stays native')});
    assert.equal(classed(f.doc.body, 'daki-canvas-open-dialog').length, 0);
    preview.onauxclick({button: 1, defaultPrevented: true, preventDefault: () => assert.fail('Already prevented events stay untouched')});
    assert.equal(classed(f.doc.body, 'daki-canvas-open-dialog').length, 0);

    let prevented = 0;
    preview.onauxclick({button: 1, defaultPrevented: false, preventDefault: () => prevented++});
    const modal = classed(f.doc.body, 'daki-canvas-open-dialog')[0];
    assert.equal(prevented, 1);
    assert.equal(modal.open, true);
    assert.equal(f.confirmations.length, 0);
});

test('navigation and pagehide close the modal without restoring focus and block stale opens', async () => {
    const makeFixture = () => projectPageFixture({
        id: 'sample', name: 'Synthetic project', candidates: {front: [], back: []},
        canvases: {front: [{id: 'canvas', name: 'Front draft', width: 800, height: 600, layerCount: 1}], back: []},
    });
    for (const [label, close] of [
        ['navigation', f => f.navigate('#gallery')],
        ['pagehide', f => f.windowEvents.get('pagehide')()],
    ]) {
        const f = await makeFixture();
        const preview = classed(f.nodes.get('dakiContent'), 'daki-canvas-preview')[0];
        preview.onclick({defaultPrevented: false, preventDefault() {}});
        const modal = classed(f.doc.body, 'daki-canvas-open-dialog')[0];
        const confirm = classed(modal, 'daki-canvas-open-confirm')[0];
        const initialFocus = f.doc.activeElement;
        await close(f);
        assert.equal(modal.open, false, `${label} closes the modal`);
        assert.equal(f.doc.activeElement, initialFocus, `${label} does not force focus back to the old opener`);
        let prevented = 0;
        confirm.onclick({defaultPrevented: false, preventDefault: () => prevented++});
        assert.equal(prevented, 1, `${label} invalidates the pending open`);
        assert.equal(f.confirmations.length, 0);
    }
});

test('project delete buttons open their themed dialog without using browser confirm', async () => {
    const f = await projectPageFixture({
        id: 'sample', name: 'Synthetic project', candidates: {front: [], back: []},
        canvases: {front: [{id: 'canvas', name: 'Front draft', width: 800, height: 600, layerCount: 1}], back: []},
    });
    const button = projectAction(f, 'daki-project-canvas', '캔버스 삭제');
    assert.equal(classed(button, 'daki-canvas-preview').length, 0);
    const deletion = button.onclick();

    const modal = projectDeleteDialog(f);
    assert.equal(modal.id, 'dakiProjectDeleteDialog');
    assert.equal(modal.open, true);
    assert.equal(classed(modal, 'daki-project-delete-title')[0].textContent, '캔버스를 삭제할까요?');
    assert.equal(classed(modal, 'daki-project-delete-name')[0].textContent, 'Front draft');
    assert.equal(classed(modal, 'daki-project-delete-side')[0].textContent, '앞면');
    assert.equal(classed(f.doc.body, 'daki-canvas-open-dialog').length, 0);
    assert.equal(f.confirmations.length, 0);
    assert.equal(f.requests.length, 0);
    classed(modal, 'daki-project-delete-cancel')[0].onclick();
    await deletion;
});

test('project delete dialogs resolve safely on navigation and pagehide without moving focus', async () => {
    const makeFixture = () => projectPageFixture({
        id: 'sample', name: 'Synthetic project', candidates: {front: [{id: 'image', name: 'Front image', path: 'front.png'}], back: []},
        canvases: {front: [], back: []},
    });
    for (const [label, leave] of [
        ['navigation', f => f.navigate('#gallery')],
        ['pagehide', f => f.windowEvents.get('pagehide')()],
    ]) {
        const f = await makeFixture();
        const button = projectAction(f, 'daki-candidate', '그림 삭제');
        const deletion = button.onclick();
        const modal = projectDeleteDialog(f);
        const initialFocus = f.doc.activeElement;
        await leave(f);
        await deletion;

        assert.equal(modal.open, false, `${label} closes the pending modal`);
        assert.equal(f.doc.activeElement, initialFocus, `${label} does not force focus to the old button`);
        assert.equal(button.disabled, false);
        assert.equal(f.requests.length, 0);
        assert.equal(f.confirmations.length, 0);
    }
});

test('project delete dialogs return focus after close, Escape, and backdrop dismissal', async t => {
    for (const [label, dismiss] of [
        ['close button', modal => classed(modal, 'daki-project-delete-close')[0].onclick()],
        ['Escape', modal => {
            let stopped = 0, prevented = 0;
            modal.listeners.get('keydown')({key: 'Escape', stopPropagation: () => stopped++, preventDefault: () => assert.fail('Escape keydown keeps native cancel behavior')});
            modal.listeners.get('cancel')({preventDefault: () => prevented++});
            assert.equal(stopped, 1);
            assert.equal(prevented, 1);
        }],
        ['native close', modal => modal.close()],
        ['backdrop', modal => modal.listeners.get('click')({target: modal, clientX: 20, clientY: 20})],
    ]) {
        await t.test(label, async () => {
            const f = await projectPageFixture({
                id: 'sample', name: 'Synthetic project', candidates: {front: [{id: 'image', name: 'Front image', path: 'front.png'}], back: []},
                canvases: {front: [], back: []},
            });
            const button = projectAction(f, 'daki-candidate', '그림 삭제');
            const deletion = button.onclick();
            const modal = projectDeleteDialog(f);
            dismiss(modal);
            await deletion;

            assert.equal(modal.open, false);
            assert.equal(f.doc.activeElement, button);
            assert.equal(button.focusOptions.preventScroll, true);
            assert.equal(button.disabled, false);
            assert.equal(f.requests.length, 0);
        });
    }
});

test('canvas deletion uses its encoded project and canvas IDs, then refreshes the current side count', async () => {
    const project = {
        id: 'project one', name: 'Synthetic project',
        candidates: {front: [], back: []},
        canvases: {front: [{id: 'canvas/one', name: 'Front draft', width: 800, height: 600, layerCount: 3}], back: []},
    };
    const f = await projectPageFixture(project);
    const button = projectAction(f, 'daki-project-canvas', '캔버스 삭제');
    assert.equal(button.isConnected, true);
    const deletion = button.onclick();
    const modal = projectDeleteDialog(f);
    assert.equal(modal.open, true);
    assert.equal(classed(modal, 'daki-project-delete-title')[0].textContent, '캔버스를 삭제할까요?');
    assert.match(classed(modal, 'daki-project-delete-description')[0].textContent, /저장된 레이어·마스크·프롬프트를 삭제합니다/);
    assert.match(classed(modal, 'daki-project-delete-description')[0].textContent, /원본 그림과 이미 내보낸 결과는 유지됩니다/);
    assert.equal(button.disabled, false, 'keep the opener focusable while awaiting the dialog');
    assert.equal(f.confirmations.length, 0);
    clickProjectDeleteConfirm(projectDeleteDialogControl(f, '캔버스 삭제'));
    await new Promise(resolve => setImmediate(resolve));
    const request = f.requests.shift();
    assert.equal(request.url, '/api/daki/projects/project%20one/canvases/canvas%2Fone');
    assert.equal(request.options.method, 'DELETE');
    assert.equal(Object.hasOwn(request.options, 'body'), false);
    assert.equal(button.disabled, true, 'disable only while the delete request is active');
    request.reply({status: 'success'});
    await new Promise(resolve => setImmediate(resolve));
    const refreshed = f.requests.shift();
    assert.equal(refreshed.url, '/api/daki/projects/project%20one');
    refreshed.reply({project: {id: project.id, name: project.name, candidates: {front: [], back: []}, canvases: {front: [], back: []}}});
    await deletion;

    const frontPanel = classed(f.nodes.get('dakiContent'), 'daki-side')[0];
    assert.equal(classed(frontPanel, 'daki-project-canvas').length, 0);
    assert.equal(classed(frontPanel, 'daki-candidate').length, 0);
    assert.equal(classed(frontPanel, 'section-title')[0].children[0].textContent, '0개');
    assert.equal(classed(frontPanel, 'daki-empty')[0].hidden, false);
});

test('the selected project sort mode remains active after a deletion refresh', async () => {
    const project = {
        id: 'sample', name: 'Synthetic project',
        candidates: {front: [
            {id: 'older', name: 'Older image', path: 'older.png', created_at: '2023-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z'},
            {id: 'newer', name: 'Newer image', path: 'newer.png', created_at: '2024-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z'},
        ], back: []},
        canvases: {front: [], back: []},
    };
    const f = await projectPageFixture(project, fixture => { fixture.win.getGalleryGridLayout = () => ({columns: 1, fixed: false}); });
    const sort = classed(f.nodes.get('dakiContent'), 'daki-project-sort')[0];
    sort.value = 'updated-desc';
    sort.onchange();
    assert.deepEqual(projectGridLabels(f), ['Newer image', 'Older image']);

    const olderCard = classed(f.nodes.get('dakiContent'), 'daki-candidate')
        .find(card => classed(card, 'gallery-card-actions')[0].children[0].textContent === 'Older image');
    const remove = classed(olderCard, 'gallery-card-action-btn').find(button => button.textContent === '그림 삭제');
    const deletion = remove.onclick();
    clickProjectDeleteConfirm(projectDeleteDialogControl(f, '그림 삭제'));
    await new Promise(resolve => setImmediate(resolve));
    const deletionRequest = f.requests.shift();
    assert.equal(deletionRequest.url, '/api/daki/projects/sample/candidates/older/delete');
    deletionRequest.reply({status: 'success'});
    await new Promise(resolve => setImmediate(resolve));
    const refresh = f.requests.shift();
    assert.equal(refresh.url, '/api/daki/projects/sample');
    refresh.reply({project: {
        ...project,
        candidates: {front: [project.candidates.front[1]], back: []},
    }});
    await deletion;

    assert.equal(classed(f.nodes.get('dakiContent'), 'daki-project-sort')[0].value, 'updated-desc');
    assert.deepEqual(projectGridLabels(f), ['Newer image']);
});

test('cancelling the initial project deletion dialog does not send a request and restores focus', async () => {
    const f = await projectPageFixture({
        id: 'sample', name: 'Synthetic project', candidates: {front: [{id: 'image', name: 'Front image', path: 'front.png'}], back: []},
        canvases: {front: [], back: []},
    });
    const button = projectAction(f, 'daki-candidate', '그림 삭제');
    const deletion = button.onclick();
    const modal = projectDeleteDialog(f);
    assert.equal(classed(modal, 'daki-project-delete-title')[0].textContent, '그림을 삭제할까요?');
    assert.match(classed(modal, 'daki-project-delete-description')[0].textContent, /원본 그림 파일과 함께 저장된 메타데이터를 영구 삭제합니다/);
    assert.match(classed(modal, 'daki-project-delete-description')[0].textContent, /다른 프로젝트나 캔버스에서 이 그림을 사용하는 경우 연결이 끊길 수 있습니다/);
    classed(modal, 'daki-project-delete-cancel')[0].onclick();
    await deletion;

    assert.equal(f.confirmations.length, 0);
    assert.equal(f.requests.length, 0);
    assert.equal(button.disabled, false);
    assert.equal(f.doc.activeElement, button);
    assert.equal(button.focusOptions.preventScroll, true);
    assert.equal(classed(f.nodes.get('dakiContent'), 'daki-candidate').length, 1);
});

test('picture deletion retries a Daki reference warning once after confirmation', async () => {
    const project = {
        id: 'project/one', name: 'Synthetic project', candidates: {front: [{id: 'candidate/one', name: 'Front image', path: 'front.png'}], back: []},
        canvases: {front: [], back: []},
    };
    const f = await projectPageFixture(project);
    const button = projectAction(f, 'daki-candidate', '그림 삭제');
    const deletion = button.onclick();
    const initialDialog = projectDeleteDialog(f);
    assert.equal(classed(initialDialog, 'daki-project-delete-title')[0].textContent, '그림을 삭제할까요?');
    clickProjectDeleteConfirm(projectDeleteDialogControl(f, '그림 삭제'));
    await new Promise(resolve => setImmediate(resolve));
    const first = f.requests.shift();
    assert.equal(first.url, '/api/daki/projects/project%2Fone/candidates/candidate%2Fone/delete');
    assert.equal(first.options.method, 'POST');
    assert.deepEqual(JSON.parse(first.options.body), {});
    first.reply({code: 'daki_references', references: [{project_name: 'Another project', side: 'back'}]}, 409);
    await new Promise(resolve => setImmediate(resolve));
    const warningDialog = projectDeleteDialog(f);
    assert.equal(warningDialog, initialDialog, 'the Daki warning reuses the same dialog');
    assert.equal(classed(warningDialog, 'daki-project-delete-title')[0].textContent, '사용 중인 그림을 삭제할까요?');
    assert.equal(classed(warningDialog, 'daki-project-delete-side')[0].textContent, '앞면');
    assert.equal(classed(warningDialog, 'daki-project-delete-name')[0].textContent, 'Front image');
    assert.equal(classed(warningDialog, 'daki-project-delete-confirm')[0].textContent, '그래도 삭제');
    assert.match(classed(warningDialog, 'daki-project-delete-description')[0].textContent, /Another project · 뒷면/);
    assert.match(classed(warningDialog, 'daki-project-delete-description')[0].textContent, /원본 연결이 끊길 수 있습니다/);
    assert.equal(button.disabled, false, 'keep the opener focusable while asking about shared references');
    assert.equal(f.confirmations.length, 0);
    clickProjectDeleteConfirm(projectDeleteDialogControl(f, '그래도 삭제'));
    await new Promise(resolve => setImmediate(resolve));
    const retry = f.requests.shift();
    assert.equal(retry.url, first.url);
    assert.deepEqual(JSON.parse(retry.options.body), {confirm_daki: true});
    assert.equal(button.disabled, true, 're-disable the action for the confirmed retry');
    assert.equal(f.confirmations.length, 0);
    retry.reply({status: 'success'});
    await new Promise(resolve => setImmediate(resolve));
    const refreshed = f.requests.shift();
    assert.equal(refreshed.url, '/api/daki/projects/project%2Fone');
    refreshed.reply({project: {id: project.id, name: project.name, candidates: {front: [], back: []}, canvases: {front: [], back: []}}});
    await deletion;

    assert.equal(classed(f.nodes.get('dakiContent'), 'daki-candidate').length, 0);
    assert.equal(classed(classed(f.nodes.get('dakiContent'), 'daki-side')[0], 'section-title')[0].children[0].textContent, '0개');
});

test('picture deletion keeps a successful backend warning in the refreshed project status', async () => {
    const project = {
        id: 'sample', name: 'Synthetic project', candidates: {front: [{id: 'image', name: 'Front image', path: 'front.png'}], back: []},
        canvases: {front: [], back: []},
    };
    const f = await projectPageFixture(project);
    const deletion = projectAction(f, 'daki-candidate', '그림 삭제').onclick();
    clickProjectDeleteConfirm(projectDeleteDialogControl(f, '그림 삭제'));
    await new Promise(resolve => setImmediate(resolve));
    f.requests.shift().reply({warning: 'Synthetic index warning'});
    await new Promise(resolve => setImmediate(resolve));
    f.requests.shift().reply({project: {id: project.id, name: project.name, candidates: {front: [], back: []}, canvases: {front: [], back: []}}});
    await deletion;

    assert.equal(f.nodes.get('dakiPageStatus').textContent, 'Synthetic index warning');
    assert.equal(classed(f.nodes.get('dakiContent'), 'daki-candidate').length, 0);
});

test('cancelling the Daki reference warning keeps a picture and re-enables its action', async () => {
    const f = await projectPageFixture({
        id: 'sample', name: 'Synthetic project', candidates: {front: [{id: 'image', name: 'Front image', path: 'front.png'}], back: []},
        canvases: {front: [], back: []},
    });
    const button = projectAction(f, 'daki-candidate', '그림 삭제');
    const deletion = button.onclick();
    clickProjectDeleteConfirm(projectDeleteDialogControl(f, '그림 삭제'));
    await new Promise(resolve => setImmediate(resolve));
    const request = f.requests.shift();
    request.reply({code: 'daki_references', references: [{project_name: 'Another project', side: 'front'}]}, 409);
    await new Promise(resolve => setImmediate(resolve));
    const warningDialog = projectDeleteDialog(f);
    assert.equal(classed(warningDialog, 'daki-project-delete-confirm')[0].textContent, '그래도 삭제');
    classed(warningDialog, 'daki-project-delete-cancel')[0].onclick();
    await deletion;

    assert.equal(f.confirmations.length, 0);
    assert.equal(f.requests.length, 0);
    assert.equal(button.disabled, false);
    assert.equal(f.doc.activeElement, button);
    assert.equal(classed(f.nodes.get('dakiContent'), 'daki-candidate').length, 1);
});

test('a missing picture remains deletable from its project', async () => {
    const project = {
        id: 'sample', name: 'Synthetic project', candidates: {front: [{id: 'missing-image', name: 'Missing front', path: 'missing.png', missing: true}], back: []},
        canvases: {front: [], back: []},
    };
    const f = await projectPageFixture(project);
    const card = classed(f.nodes.get('dakiContent'), 'daki-candidate')[0];
    assert.equal(classed(card, 'daki-missing-image')[0].textContent, '원본을 찾을 수 없음');
    const button = projectAction(f, 'daki-candidate', '그림 삭제');
    const deletion = button.onclick();
    clickProjectDeleteConfirm(projectDeleteDialogControl(f, '그림 삭제'));
    await new Promise(resolve => setImmediate(resolve));
    const request = f.requests.shift();
    assert.equal(request.url, '/api/daki/projects/sample/candidates/missing-image/delete');
    request.reply({status: 'success'});
    await new Promise(resolve => setImmediate(resolve));
    const refreshed = f.requests.shift();
    refreshed.reply({project: {id: project.id, name: project.name, candidates: {front: [], back: []}, canvases: {front: [], back: []}}});
    await deletion;

    assert.equal(classed(f.nodes.get('dakiContent'), 'daki-candidate').length, 0);
});

test('repeated clicks while project deletion is pending send only one request', async () => {
    const f = await projectPageFixture({
        id: 'sample', name: 'Synthetic project', candidates: {front: [], back: []},
        canvases: {front: [{id: 'canvas', name: 'Front draft', width: 800, height: 600, layerCount: 1}], back: []},
    });
    const button = projectAction(f, 'daki-project-canvas', '캔버스 삭제');
    const deletion = button.onclick();
    const duplicate = button.onclick();
    assert.equal(projectDeleteDialog(f).open, true);
    assert.equal(f.confirmations.length, 0);
    assert.equal(button.disabled, false, 'confirmation does not disable its focus target');
    assert.equal(f.requests.length, 0);
    clickProjectDeleteConfirm(projectDeleteDialogControl(f, '캔버스 삭제'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.confirmations.length, 0);
    assert.equal(button.disabled, true);
    assert.equal(f.requests.length, 1);
    f.requests.shift().reply({status: 'success'});
    await new Promise(resolve => setImmediate(resolve));
    f.requests.shift().reply({project: {id: 'sample', name: 'Synthetic project', candidates: {front: [], back: []}, canvases: {front: [], back: []}}});
    await Promise.all([deletion, duplicate]);
});

test('project deletion errors preserve the cards, show a status, and re-enable the action', async () => {
    const f = await projectPageFixture({
        id: 'sample', name: 'Synthetic project', candidates: {front: [{id: 'image', name: 'Front image', path: 'front.png'}], back: []},
        canvases: {front: [], back: []},
    });
    const button = projectAction(f, 'daki-candidate', '그림 삭제');
    const deletion = button.onclick();
    clickProjectDeleteConfirm(projectDeleteDialogControl(f, '그림 삭제'));
    await new Promise(resolve => setImmediate(resolve));
    f.requests.shift().reply({message: 'Synthetic delete failure'}, 500);
    await deletion;

    assert.equal(f.nodes.get('dakiPageStatus').textContent, 'Synthetic delete failure');
    assert.equal(button.disabled, false);
    assert.equal(button.isConnected, true);
    assert.equal(classed(f.nodes.get('dakiContent'), 'daki-candidate').length, 1);
    assert.equal(f.requests.length, 0);
});

test('late project deletion responses do not repaint the gallery after navigation', async t => {
    for (const [label, status, payload] of [
        ['success', 200, {status: 'success'}],
        ['error', 500, {message: 'Late failure'}],
        ['reference conflict', 409, {code: 'daki_references', references: [{project_name: 'Other project', side: 'back'}]}],
    ]) {
        await t.test(label, async () => {
            const f = await projectPageFixture({
                id: 'sample', name: 'Synthetic project',
                candidates: {front: [{id: 'image', name: 'Front image', path: 'front.png'}], back: []},
                canvases: {front: [], back: []},
            });
            const button = projectAction(f, 'daki-candidate', '그림 삭제');
            const deletion = button.onclick();
            clickProjectDeleteConfirm(projectDeleteDialogControl(f, '그림 삭제'));
            await new Promise(resolve => setImmediate(resolve));
            const request = f.requests.shift();
            const oldNodes = [...f.nodes.get('dakiContent').children];
            await f.navigate('#gallery');
            const statusText = f.nodes.get('dakiPageStatus').textContent;
            request.reply(payload, status);
            await deletion;

            assert.deepEqual(f.nodes.get('dakiContent').children, oldNodes);
            assert.equal(f.nodes.get('dakiPageStatus').textContent, statusText);
            if (status === 409) {
                assert.equal(f.confirmations.length, 0);
                assert.equal(projectDeleteDialog(f).open, false, 'a stale deletion does not open a reference prompt');
            }
            assert.equal(f.requests.length, 0);
        });
    }
});

test('project tools omit tags and tournaments while keeping both side jumps and generation', async () => {
    const f = inlineLibraryFixture('/#project=sample');
    const state = {enabled: true, zoomEnabled: false, selectedTagId: 'keep', definitions: [{id: 'keep', type: 'text', value: 'Keep'}]};
    f.win.getGalleryTagState = () => state;
    f.win.DakiGalleryFilters = {create() { assert.fail('Projects do not load tag filters or tournament history'); }};
    f.win.applySelectedGalleryTagToImage = () => assert.fail('Project image clicks must not assign tags');
    f.win.renderGalleryImageTagButton = () => assert.fail('Project cards must not show tag buttons');
    const zoomed = [];
    f.win.openZoom = src => zoomed.push(src);
    await f.initialize();
    f.requests.shift().reply({project: {
        id: 'sample', name: 'Synthetic project',
        candidates: {front: [{id: 'image', path: 'sample/front.png'}], back: []},
        canvases: {front: [], back: []},
    }});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.doc.body.classList.contains('daki-project-active'), true);
    const content = f.nodes.get('dakiContent');
    const controls = classed(content, 'daki-project-controls')[0];
    assert.equal(classed(controls, 'daki-image-tools').length, 0);
    assert.equal(classed(controls, 'daki-gallery-filters').length, 0);
    assert.equal(classed(controls, 'daki-project-worldcup').length, 0);
    assert.equal(classed(controls, 'daki-project-generate-link')[0].href, '#daki&library=drafts&project=sample&new=1');
    classed(content, 'zoomable')[0].onclick({preventDefault() {}});
    assert.deepEqual(zoomed, ['/image/sample/front.png']);
    assert.equal(state.enabled, true, 'Leaving project view must preserve other libraries tag mode');
    const panels = classed(content, 'daki-side');
    const jumps = classed(controls, 'daki-project-side-jump');
    assert.deepEqual(jumps.map(button => button.textContent), ['앞면 1', '뒷면 0']);
    const scrolled = [], focused = [];
    panels.forEach((panel, index) => {
        const title = classed(panel, 'section-title')[0];
        title.scrollIntoView = options => { assert.equal(options.block, 'start'); scrolled.push(index); };
        title.focus = options => { assert.equal(options.preventScroll, true); focused.push(index); };
    });
    jumps[1].onclick(); jumps[0].onclick();
    assert.deepEqual(scrolled, [1, 0]); assert.deepEqual(focused, [1, 0]);
    assert.equal(f.win.location.hash, '#project=sample');
    assert.ok(panels.every(panel => !panel.hidden));
    assert.equal(classed(panels[0], 'daki-candidate').length, 1);
    await f.navigate('#gallery');
    assert.equal(f.doc.body.classList.contains('daki-project-active'), false);
});

test('empty project sides show a combined canvas-or-picture message', async () => {
    const f = inlineLibraryFixture('/#project=sample');
    await f.initialize();
    f.requests.shift().reply({project: {
        id: 'sample', name: 'Synthetic project', candidates: {front: [], back: []},
        canvases: {front: [], back: []},
    }});
    await new Promise(resolve => setImmediate(resolve));
    const panels = classed(f.nodes.get('dakiContent'), 'daki-side');
    assert.deepEqual(panels.map(panel => classed(panel, 'daki-empty')[0].textContent), [
        '앞면에 캔버스나 그림이 아직 없습니다.', '뒷면에 캔버스나 그림이 아직 없습니다.',
    ]);
    assert.ok(panels.every(panel => classed(panel, 'daki-empty')[0].hidden === false));
});

test('pagehide disposes the active page preview manager', async () => {
    const f = inlineLibraryFixture('/#project=sample');
    await f.initialize();
    f.requests.shift().reply({project: {
        id: 'sample', name: 'Synthetic project', candidates: {front: [], back: []},
        canvases: {front: [], back: []},
    }});
    await new Promise(resolve => setImmediate(resolve));
    f.windowEvents.get('pagehide')();
    assert.equal(f.previewSessions[0].disposed, true);
});

test('a bfcache pageshow rebuilds previews while a normal pageshow does not reload', async () => {
    const f = inlineLibraryFixture('/#project=sample');
    await f.initialize();
    f.requests.shift().reply({project: {
        id: 'sample', name: 'Synthetic project', candidates: {front: [], back: []},
        canvases: {front: [], back: []},
    }});
    await new Promise(resolve => setImmediate(resolve));
    f.windowEvents.get('pagehide')();
    assert.equal(f.previewSessions[0].disposed, true);

    await f.windowEvents.get('pageshow')({persisted: false});
    assert.equal(f.requests.length, 0);
    assert.equal(f.previewSessions.length, 1);

    const restored = f.windowEvents.get('pageshow')({persisted: true});
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].url, '/api/daki/projects/sample');
    f.requests.shift().reply({project: {
        id: 'sample', name: 'Synthetic project', candidates: {front: [], back: []},
        canvases: {front: [], back: []},
    }});
    await restored;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.previewSessions.length, 2);
    assert.equal(f.previewSessions[1].disposed, false);
});

test('Daki images support normal zoom, click tagging, zoom tagging and consumed long presses', () => {
    const f = inlineLibraryFixture();
    const path = '__daki_personal__/sample.png';
    const state = {enabled: false, zoomEnabled: false};
    const zooms = [], tags = [];
    f.win.getGalleryTagState = () => state;
    f.win.openZoom = src => zooms.push(src);
    f.win.applySelectedGalleryTagToImage = value => tags.push(value);
    const card = {dataset: {}}, img = {};
    f.win.Daki.bindImage(card, img, path);
    const click = () => img.onclick({preventDefault() {}});
    click();
    state.enabled = true;
    click();
    state.zoomEnabled = true;
    click();
    f.win.consumeGalleryRadialTagClick = () => true;
    click();
    assert.deepEqual(zooms, [`/image/${path}`, `/image/${path}`]);
    assert.deepEqual(tags, [path]);
    assert.equal(card.dataset.path, path);
});

test('Daki project image context menus carry the explicit face and candidate identity', () => {
    const f = inlineLibraryFixture();
    const path = '__daki_personal__/same-image.png';
    const contexts = [
        {projectId: 'project-one', side: 'front', candidateId: 'candidate-front'},
        {projectId: 'project-one', side: 'back', candidateId: 'candidate-back'},
        {projectId: 'project-two', side: 'front', candidateId: 'candidate-other'},
    ];
    const opened = [];
    f.win.openImageContextMenu = (...args) => opened.push(args);

    for (const projectContext of contexts) {
        const card = {dataset: {}}, img = {};
        f.win.Daki.bindImage(card, img, path, projectContext);
        img.oncontextmenu({type: 'contextmenu'});
    }

    assert.deepEqual(opened.map(args => args[1]), [path, path, path]);
    assert.deepEqual(opened.map(args => args[3]), contexts);
});

test('Daki tag toolbar selects existing tags and opens the shared tag manager', () => {
    const f = inlineLibraryFixture();
    const state = {enabled: false, zoomEnabled: false, selectedTagId: '', definitions: [{id: 'keep', type: 'text', value: 'Keep'}]};
    f.win.getGalleryTagState = () => state;
    f.win.toggleGalleryTagAssignmentMode = () => { state.enabled = !state.enabled; };
    f.win.toggleGalleryZoomActionMode = action => { assert.equal(action, 'tag'); state.zoomEnabled = !state.zoomEnabled; };
    f.win.selectGalleryTagForAssignment = tag => { state.selectedTagId = tag; };
    let managerOpened = false;
    f.win.openGalleryTagManager = () => { managerOpened = true; };
    const toolbar = f.win.Daki.createImageTools();
    const [actions, choices] = toolbar.children;
    choices.children[1].onclick();
    assert.equal(state.enabled, true);
    assert.equal(state.selectedTagId, 'keep');
    actions.children[1].onclick();
    toolbar.refreshTags();
    assert.equal(state.zoomEnabled, true);
    assert.equal(actions.children[1].attributes['aria-pressed'], 'true');
    assert.equal(choices.children[1].attributes['aria-pressed'], 'true');
    assert.match(toolbar.children[2].textContent, /확대하고/);
    actions.children[2].onclick();
    assert.equal(managerOpened, true);
});

test('Daki personal library delegates rendering and leaves it on navigation', async () => {
    const f = inlineLibraryFixture('/#daki&library=personal');
    let renders = 0, leaves = 0;
    f.win.DakiPersonalStyles = {
        render(params, container) {
            renders++;
            assert.equal(params.get('library'), 'personal');
            assert.equal(container, f.nodes.get('dakiContent'));
        },
        leave() { leaves++; },
    };
    await f.initialize();
    assert.equal(renders, 1);
    assert.equal(f.requests.length, 0);
    await f.navigate('#gallery');
    assert.equal(leaves, 2);
});

test('Daki saved worldcups route delegates history and leaves it on navigation', async () => {
    const f = inlineLibraryFixture('/#daki&library=worldcups&result=synthetic');
    let renders = 0, leaves = 0;
    f.win.DakiWorldCup = {
        render(params, container) {
            renders++;
            assert.equal(params.get('result'), 'synthetic');
            assert.equal(container, f.nodes.get('dakiContent'));
        }, leave() { leaves++; },
    };
    await f.initialize();
    assert.equal(renders, 1); assert.equal(f.requests.length, 0);
    await f.navigate('#gallery'); assert.equal(leaves, 2);
});

test('Daki draft library delegates generation and stops polling on gallery navigation', async () => {
    const f = inlineLibraryFixture('/#daki&library=drafts');
    let renders = 0, leaves = 0;
    f.win.DakiDrafts = {
        render(params, container) {
            renders++;
            assert.equal(params.get('library'), 'drafts');
            assert.equal(container, f.nodes.get('dakiContent'));
        }, leave() { leaves++; },
    };
    await f.initialize();
    assert.equal(renders, 1); assert.equal(f.requests.length, 0);
    await f.navigate('#gallery'); assert.equal(leaves, 2);
});

test('Daki dictionary keeps the library shell and leaves on navigation and pagehide', async () => {
    const f = inlineLibraryFixture('/#daki&library=dictionary');
    f.nodes.set('dakiCreate', f.doc.createElement('button'));
    let renders = 0, leaves = 0;
    f.win.DakiDictionary = {
        render(params, container) {
            renders++;
            assert.equal(params.get('library'), 'dictionary');
            assert.equal(container, f.nodes.get('dakiContent'));
        }, leave() { leaves++; },
    };
    await f.initialize();
    assert.equal(renders, 1);
    assert.equal(f.requests.length, 0);
    assert.equal(f.nodes.get('dakiCreate').hidden, true);
    await f.navigate('#gallery');
    assert.equal(leaves, 2);
    f.windowEvents.get('pagehide')();
    assert.equal(leaves, 3);
});

test('refreshProject reloads only the currently displayed project without navigating', async () => {
    const f = inlineLibraryFixture('/#daki&project=sample');
    await f.initialize();
    f.requests.shift().reply({project: {
        id: 'sample', name: 'Synthetic project', candidates: {front: [], back: []},
        canvases: {front: [], back: []},
    }});
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(await f.win.Daki.refreshProject('other'), false);
    assert.equal(f.requests.length, 0);

    const refresh = f.win.Daki.refreshProject('sample');
    assert.equal(f.requests[0].url, '/api/daki/projects/sample');
    assert.equal(f.win.location.hash, '#daki&project=sample');
    f.requests.shift().reply({project: {
        id: 'sample', name: 'Synthetic project', candidates: {front: [], back: []},
        canvases: {front: [], back: []},
    }});
    assert.equal(await refresh, true);
    assert.equal(f.win.location.hash, '#daki&project=sample');
});


test('project view tag boundary excludes draft context and other libraries', () => {
    const {isProjectView} = require('../static/daki.js');
    assert.equal(isProjectView(new URL('http://localhost/#project=sample')), true);
    for (const hash of ['#daki', '#gallery&project=sample', '#project=', '#daki&library=drafts&project=sample', '#daki&library=shared&batch=sample', '#daki&library=personal']) {
        assert.equal(isProjectView(new URL('http://localhost/' + hash)), false, hash);
    }
});

test('shared tag row toolbars retain mode controls without a duplicate tag chooser', () => {
    const f = inlineLibraryFixture();
    f.win.getGalleryTagState = () => ({enabled: true, zoomEnabled: false, definitions: []});
    const toolbar = f.win.Daki.createImageTools({tagChoices: false});
    assert.equal(classed(toolbar, 'daki-tag-choices').length, 0);
    assert.equal(classed(toolbar, 'gallery-tag-assignment-actions')[0].children.length, 3);
    assert.match(classed(toolbar, 'daki-tag-hint')[0].textContent, /태그 필터는 잠시 해제/);
});
