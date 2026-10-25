
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const clone = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
const settings = {prompt: 'synthetic draft', negative_prompt: '', model: 'nai-diffusion-5-full', width: 512, height: 768,
    seed: -1, char_prompts: [], options: {steps: 28}};
function draft(id, status = 'completed', changes = {}) {
    return {id, status, created_at: '2026-10-12T01:00:00Z', updated_at: '2026-10-12T01:01:00Z', settings: clone(settings),
        width: 512, height: 768, seed: 123, path: `__daki_drafts__/${id}.png`, selected: false,
        ...(status === 'completed' ? {src: `/api/daki/drafts/${id}/image`} : {}), ...changes};
}
function folder(changes = {}) {
    return {id: 'folder-1', name: 'Synthetic folder', project_id: 'project-1', settings: clone(settings), count: 0, selected_count: 0, ...changes};
}
function fixture() {
    class Element {
        constructor(tag) {
            this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.dataset = {}; this.text = '';
            this.hidden = false; this.disabled = false; this.checked = false; this.value = ''; this.listeners = {};
            this.className = ''; this.parentNode = null; this.open = false; this.classList = {
                add: (...names) => { this.className = [...new Set((this.className + ' ' + names.join(' ')).trim().split(/\s+/))].join(' '); },
                remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
                contains: name => this.className.split(/\s+/).includes(name),
            };
        }
        appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
        append(...children) { children.forEach(child => this.appendChild(child)); }
        replaceChildren(...children) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.text = ''; this.append(...children); }
        set textContent(value) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.text = String(value); }
        get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
        setAttribute(key, value) { this.attributes[key] = String(value); }
        getAttribute(key) { return this.attributes[key] ?? null; }
        addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
        removeEventListener(type, callback) { this.listeners[type] = (this.listeners[type] || []).filter(item => item !== callback); }
        dispatch(type) { (this.listeners[type] || []).forEach(callback => callback({target: this, preventDefault() {}})); }
        showModal() { this.open = true; }
        close() { if (!this.open) return; this.open = false; this.dispatch('close'); }
        focus() {}
        remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(item => item !== this); this.parentNode = null; }
        descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
    }
    const ids = ['dakiTitle', 'dakiSubtitle', 'dakiBack', 'dakiPageStatus', 'dakiContent'];
    const nodes = Object.fromEntries(ids.map(id => [id, new Element('div')]));
    const body = new Element('body');
    const requests = [], pending = [], adds = [], editorInstances = [], timers = new Map(), framing = [], warnings = [], approvals = [];
    const confirmCalls = [], confirmValues = [], events = new Map(), folderActionCalls = [], folderActionCloses = [];
    let framingClosed = 0, value = clone(settings), active = true, nextTimer = 0, deferEditor;
    const win = {
        location: {hash: ''},
        addEventListener(type, callback) { events.set(type, callback); },
        removeEventListener(type, callback) { if (events.get(type) === callback) events.delete(type); },
        dispatchEvent() {}, CustomEvent: function (type) { this.type = type; },
        confirm(message) { confirmCalls.push(message); return confirmValues.length ? confirmValues.shift() : true; },
        document: {body, createElement: tag => new Element(tag), getElementById: id => nodes[id]},
        Daki: {
            isActive: () => active, createImageTools: () => new Element('div'),
            createGrid(className) { const grid = new Element('div'); grid.className = className; grid.setItems = items => grid.replaceChildren(...items); return grid; },
            folderCard(name, href, count, subtitle, src) { const card = new Element('a'); card.className = 'card'; card.href = href; card.textContent = `${name} ${count} ${subtitle}`; card.dataset.src = src || ''; return card; },
            bindImage(card, image, path) { card.dataset.path = path; }, openAdd: data => adds.push(data),
            async deleteRequest(url, payload) {
                const send = async body => {
                    const response = await win.fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
                    return {response, result: await response.json(), cancelled: false};
                };
                const reply = await send(payload);
                if (reply.response.status !== 409 || reply.result.code !== 'daki_references') return reply;
                if (!win.confirm('reference check')) return {...reply, cancelled: true};
                return send({...payload, confirm_daki: true});
            },
        },
        DakiDraftFolderActions: {
            createCard(item, options) {
                folderActionCalls.push({type: 'card', folder: item, options});
                const link = win.Daki.folderCard(item.name, options.href, item.count, `시안 · ${item.count}장 · ${item.selected_count || 0}장 선택됨`, item.src);
                link.className = 'daki-project-card daki-draft-folder-link';
                const card = new Element('div'); card.className = 'card daki-project-card daki-draft-folder-card'; card.appendChild(link);
                const remove = this.createDeleteButton(item, options); if (remove) card.appendChild(remove);
                return card;
            },
            createDeleteButton(item, options) {
                folderActionCalls.push({type: 'delete', folder: item, options});
                if (item.legacy || item.id === 'legacy') return null;
                const remove = new Element('button'); remove.textContent = '폴더 삭제'; remove.onclick = () => {};
                return remove;
            },
            close(restoreFocus) { folderActionCloses.push(restoreFocus); },
        },
        DakiGalleryFilters: {create({onChange}) { return {element: new Element('div'), apply: items => items, dispose() {}, setResultCount() {}, refresh: onChange}; }},
        DakiTagBrowser: {close() {}},
        DakiDraftFraming: {open: options => framing.push(options), close() { framingClosed++; }},
        DakiDraftEditor: {async create(options) {
            const instance = {element: new Element('section'), initial: options.settings, disposed: false,
                read: () => clone(value), setSettings(newValue) { value = clone(newValue); options.onChange?.(value); }, dispose() { this.disposed = true; }};
            editorInstances.push(instance); if (deferEditor) await deferEditor; return instance;
        }},
        fetch(url, options) {
            requests.push({url, method: options.method, body: options.body ? JSON.parse(options.body) : undefined});
            return new Promise((resolve, reject) => pending.push({resolve, reject}));
        },
        setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); },
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../static/common_anlas_warning.js'), 'utf8'), {window: win});
    win.showAnlasWarningModal = options => { warnings.push(clone(options)); return new Promise(resolve => approvals.push(resolve)); };
    win.requiresAnlasCost = (width, height, steps) => width > 512 || height > 768 || steps > 28;
    vm.runInNewContext(fs.readFileSync(require.resolve('../static/daki_drafts.js'), 'utf8'), {window: win});
    const content = nodes.dakiContent;
    const elements = (tag, base = content) => base.descendants().filter(element => !tag || element.tagName === tag.toUpperCase());
    const byClass = (className, base = content) => elements('', base).filter(element => element.className.split(/\s+/).includes(className));
    const f = {
        win, nodes, body, content, requests, pending, adds, editors: editorInstances, timers, framing, events, warnings, approvals, confirmCalls,
        folderActionCalls, folderActionCloses,
        framingClosed: () => framingClosed,
        elements, byClass,
        button(label, base = content) { const result = elements('button', base).find(element => element.textContent === label); assert.ok(result, `button: ${label}`); return result; },
        confirmNext(value) { confirmValues.push(value); },
        warning(value) { assert.ok(approvals.length); approvals.shift()(value); return flush(); },
        value(newValue) { value = newValue; },
        defer(promise) { deferEditor = promise; },
        replyAt(index, data, status = 200) { assert.ok(pending[index], 'pending request'); const item = pending.splice(index, 1)[0]; item.resolve({ok: status < 400, status, json: async () => ({status: status < 400 ? 'success' : 'error', ...data})}); },
        reply(data, status = 200) { this.replyAt(0, data, status); },
        fail(error = new Error('Synthetic transport failure')) { assert.ok(pending.length); pending.shift().reject(error); },
        async mountRoot({projectId = 'project-1', folders = [], newFolder = false} = {}) {
            const params = new URLSearchParams(projectId ? `project=${projectId}${newFolder ? '&new=1' : ''}` : '');
            const opening = win.DakiDrafts.render(params, content);
            if (projectId) { this.reply({project: {id: projectId, name: 'Synthetic project'}}); await flush(); }
            if (projectId) { this.reply({folders}); }
            await opening;
        },
        async mountFolder({records = [], selectedFolder = folder(), projectId = 'project-1', edit = false} = {}) {
            const params = new URLSearchParams(`${projectId ? `project=${projectId}&` : ''}folder=${selectedFolder.id}${edit ? '&edit=1' : ''}`);
            const opening = win.DakiDrafts.render(params, content);
            if (projectId) { this.reply({project: {id: projectId, name: 'Synthetic project'}}); await flush(); }
            this.reply({folder: selectedFolder, drafts: records}); await flush();
            if (selectedFolder.project_id && !projectId) { this.reply({project: {id: selectedFolder.project_id, name: 'Synthetic project'}}); }
            await opening;
        },
        submit() { return elements('form')[0].onsubmit({preventDefault() {}}); },
        poll() { const entry = timers.entries().next().value; assert.ok(entry, 'scheduled poll'); timers.delete(entry[0]); return entry[1](); },
        leave() { active = false; win.DakiDrafts.leave(); },
        dialog() { return elements('dialog', body)[0]; },
    };
    return f;
}
test('draft folders require a project and never expose a global root list', async () => {
    const f = fixture(); const opening = f.win.DakiDrafts.render(new URLSearchParams(), f.content); await opening;
    assert.equal(f.requests.length, 0); assert.match(f.content.textContent, /프로젝트를 연 뒤/);
    assert.equal(f.nodes.dakiBack.href, '#daki'); assert.equal(f.elements('a').at(-1).href, '#daki');
});

test('project folder index filters the virtual legacy folder and creates a named folder without generating', async () => {
    const f = fixture(), rootPromise = f.win.DakiDrafts.render(new URLSearchParams('project=project-1'), f.content);
    f.reply({project: {id: 'project-1', name: 'Synthetic project'}}); await flush();
    assert.equal(f.requests[1].url, '/api/daki/draft-folders?project=project-1');
    f.reply({folders: [folder({count: 2, selected_count: 1}), {id: 'legacy', name: '기존 시안', legacy: true},
        folder({id: 'foreign', name: 'Other project folder', project_id: 'other-project'})]}); await rootPromise;
    assert.equal(f.elements('a').length, 1); assert.match(f.content.textContent, /Synthetic folder/);
    f.button('새 시안 만들기').onclick(); const dialog = f.dialog();
    const input = f.elements('input', dialog)[0]; input.value = '  이름 있는 폴더  ';
    const creating = f.elements('form', dialog)[0].onsubmit({preventDefault() {}});
    assert.equal(f.requests.at(-1).method, 'POST');
    assert.deepEqual(clone(f.requests.at(-1).body), {name: '이름 있는 폴더', project_id: 'project-1', settings: {}});
    f.reply({folder: folder({id: 'new-id', name: '이름 있는 폴더'})}, 201); await creating;
    assert.equal(f.win.location.hash, '#daki&library=drafts&project=project-1&folder=new-id&edit=1');
    assert.equal(f.requests.filter(request => request.url === '/api/daki/drafts').length, 0);
});

test('project folder cards receive current-view deletion actions that refresh their list', async () => {
    const f = fixture(), opening = f.win.DakiDrafts.render(new URLSearchParams('project=project-1'), f.content);
    f.reply({project: {id: 'project-1', name: 'Synthetic project'}}); await flush();
    f.reply({folders: [folder({count: 4, selected_count: 2})]}); await opening;

    const cardAction = f.folderActionCalls.find(call => call.type === 'card');
    assert.ok(cardAction);
    assert.equal(cardAction.folder.id, 'folder-1');
    assert.equal(cardAction.options.href, '#daki&library=drafts&project=project-1&folder=folder-1');
    assert.equal(cardAction.options.isCurrent(), true);
    assert.equal(f.elements('a').length, 1, 'the folder still has one opening link');
    assert.ok(f.elements('button').some(item => item.textContent === '폴더 삭제'));

    const refreshing = cardAction.options.onDeleted({warning: 'Synthetic index warning'});
    await flush();
    assert.equal(f.requests.at(-1).url, '/api/daki/draft-folders?project=project-1');
    f.reply({folders: []}); await refreshing;
    assert.equal(f.nodes.dakiPageStatus.textContent, '');
    assert.match(f.content.textContent, /시안 폴더가 없습니다/);
    assert.equal(f.byClass('daki-draft-status')[0].textContent, 'Synthetic index warning');

    f.leave();
    assert.equal(cardAction.options.isCurrent(), false);
    assert.equal(f.folderActionCloses.at(-1), false);
});

test('real folder gallery adds a deletion action that returns to its project', async () => {
    const f = fixture(); await f.mountFolder({selectedFolder: folder()});
    const call = f.folderActionCalls.find(item => item.type === 'delete');
    assert.ok(call);
    assert.equal(call.folder.id, 'folder-1');
    assert.equal(call.options.isCurrent(), true);
    const action = f.button('폴더 삭제');
    assert.ok(action);

    call.options.onError('Synthetic folder deletion failure');
    assert.match(f.byClass('daki-draft-status')[0].textContent, /Synthetic folder deletion failure/);
    call.options.onDeleted({status: 'success', project_id: 'project-1'});
    assert.equal(f.win.location.hash, '#project=project-1');
    f.leave();
    assert.equal(call.options.isCurrent(), false);
    assert.equal(f.folderActionCloses.at(-1), false);
});

test('project-scoped new=1 opens the folder name dialog after loading the project index', async () => {
    const f = fixture(), opening = f.win.DakiDrafts.render(new URLSearchParams('project=project-1&new=1'), f.content);
    f.reply({project: {id: 'project-1', name: 'Synthetic project'}}); await flush();
    f.reply({folders: []}); await opening;
    assert.ok(f.dialog()); assert.equal(f.elements('input', f.dialog())[0].required, false);
    f.leave(); assert.equal(f.dialog(), undefined);
});

test('blank folder names are sent for server numbering and open the created folder', async () => {
    const f = fixture(); await f.mountRoot({newFolder: true});
    const dialog = f.dialog(), input = f.elements('input', dialog)[0];
    input.value = '   ';
    const creating = f.elements('form', dialog)[0].onsubmit({preventDefault() {}});
    assert.deepEqual(clone(f.requests.at(-1).body), {name: '', project_id: 'project-1', settings: {}});
    f.reply({folder: folder({id: 'automatic-id', name: '시안1'})}, 201); await creating;
    assert.equal(f.win.location.hash, '#daki&library=drafts&project=project-1&folder=automatic-id&edit=1');
    assert.equal(f.dialog(), undefined);
});

test('direct folder URLs resolve and validate their project before rendering', async () => {
    const f = fixture(), opening = f.win.DakiDrafts.render(new URLSearchParams('folder=folder-1'), f.content);
    f.reply({folder: folder(), drafts: [draft('a')]}); await flush();
    assert.equal(f.requests[1].url, '/api/daki/projects/project-1');
    f.reply({project: {id: 'project-1', name: 'Synthetic project'}}); await opening;
    assert.equal(f.nodes.dakiBack.href, '#project=project-1'); assert.match(f.nodes.dakiSubtitle.textContent, /Synthetic project/);
    const g = fixture(), wrong = g.win.DakiDrafts.render(new URLSearchParams('project=other&folder=folder-1'), g.content);
    g.reply({project: {id: 'other', name: 'Other project'}}); await flush(); g.reply({folder: folder(), drafts: []}); await wrong;
    assert.match(g.nodes.dakiPageStatus.textContent, /속하지 않습니다/); assert.equal(g.requests.length, 2);
});

test('folder gallery uses folder detail only, shows selection separately from project addition, and keeps explicit add', async () => {
    const f = fixture(); await f.mountFolder({records: [draft('a'), draft('b', 'failed', {error: 'Synthetic failure'})]});
    assert.equal(f.requests.filter(item => item.url === '/api/daki/drafts').length, 0);
    assert.equal(f.requests[1].url, '/api/daki/draft-folders/folder-1');
    assert.equal(f.elements('a').filter(item => item.textContent === '시안 수정').length, 1); assert.equal(f.adds.length, 0);
    const card = f.content.descendants().find(item => item.dataset.path === '__daki_drafts__/a.png');
    assert.ok(card); assert.equal(card.children[0].tagName, 'IMG'); assert.equal(card.children[1].className, 'daki-draft-fit-action');
    const title = card.descendants().find(item => item.tagName === 'STRONG'); assert.equal(title.title, title.textContent);
    f.button('프로젝트에 추가').onclick();
    assert.deepEqual(clone(f.adds), [{path: '__daki_drafts__/a.png', imgSrc: '/image/__daki_drafts__/a.png', projectId: 'project-1'}]);
    assert.equal(f.elements('input').filter(item => item.getAttribute('aria-label') === '결과로 선택').length, 1);
});

test('selection is persisted on its own endpoint and a failure restores the prior checkbox state', async () => {
    const f = fixture(); await f.mountFolder({records: [draft('a')]});
    const checkbox = f.elements('input').find(item => item.getAttribute('aria-label') === '결과로 선택');
    checkbox.checked = true; const saving = checkbox.onchange();
    assert.equal(f.requests.at(-1).url, '/api/daki/drafts/a/selection');
    assert.deepEqual(f.requests.at(-1).body, {selected: true});
    f.reply({draft: draft('a', 'completed', {selected: true})}); await saving;
    assert.equal(f.elements('input').find(item => item.getAttribute('aria-label') === '결과로 선택').checked, true);
    const next = f.elements('input').find(item => item.getAttribute('aria-label') === '결과로 선택'); next.checked = false;
    const failing = next.onchange(); f.reply({message: 'Selection rejected'}, 500); await failing;
    assert.equal(f.elements('input').find(item => item.getAttribute('aria-label') === '결과로 선택').checked, true);
    assert.match(f.content.textContent, /Selection rejected/);
});
test('opening a folder generator loads its saved settings and never generates or attaches automatically', async () => {
    const saved = {...clone(settings), prompt: 'folder prompt'};
    const f = fixture(); await f.mountFolder({records: [draft('a')], selectedFolder: folder({settings: saved}), edit: true});
    assert.deepEqual(clone(f.editors[0].initial), saved); assert.equal(f.adds.length, 0);
    assert.equal(f.requests.filter(request => request.method === 'POST').length, 0);
    assert.equal(f.elements('form')[0].noValidate, true);
    assert.equal(f.byClass('daki-draft-workspace').length, 1); assert.equal(f.byClass('daki-draft-history-card').length, 1);
    assert.equal(f.elements('img').find(image => image.className === 'daki-draft-preview-image').src, '/api/daki/drafts/a/image?full=1');
});

test('generation snapshots editor values, sends folder_id once, blocks duplicate submits and polls only the folder', async () => {
    const f = fixture(); await f.mountFolder({edit: true});
    f.value({...settings, options: {...settings.options, cfg_rescale: .57142}});
    const creation = f.submit(); f.submit(); assert.equal(f.requests.length, 3);
    f.value({...settings, prompt: 'edited after submission'});
    assert.equal(f.requests[2].url, '/api/daki/drafts');
    assert.equal(f.requests[2].body.prompt, settings.prompt); assert.equal(f.requests[2].body.allow_anlas, false);
    assert.equal(f.requests[2].body.folder_id, 'folder-1'); assert.equal(f.requests[2].body.options.cfg_rescale, .57142);
    f.reply({draft: draft('new', 'running')}); await creation;
    assert.equal(f.button('시안 생성 중…').disabled, true); assert.equal(f.timers.size, 1);
    const poll = f.poll(); assert.equal(f.requests.at(-1).url, '/api/daki/draft-folders/folder-1');
    f.reply({folder: folder(), drafts: [draft('new')]}); await poll;
    assert.equal(f.button('시안 한 장 생성').disabled, false); assert.equal(f.timers.size, 0);
    assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
});

test('paid generation cancellation and approval preserve the frozen request; Medium uses its free effective 14 steps', async () => {
    const f = fixture(); await f.mountFolder({edit: true});
    const selected = {...settings, width: 640, height: 2048, options: {steps: 29}}; f.value(selected);
    const cancelled = f.submit(); f.submit(); assert.equal(f.warnings.length, 1); assert.equal(f.requests.length, 2);
    assert.equal(f.button('요청하는 중…').disabled, true); await f.warning(false); await cancelled;
    assert.equal(f.requests.length, 2); assert.equal(f.button('시안 한 장 생성').disabled, false);
    const accepted = f.submit(); selected.options.steps = 50; await f.warning(true);
    assert.equal(f.requests[2].body.options.steps, 29); assert.equal(f.requests[2].body.allow_anlas, true);
    f.reply({draft: draft('new')}); await accepted;
    const g = fixture(); await g.mountFolder({edit: true});
    g.value({...settings, model: 'nai-diffusion-5-full-medium', options: {steps: 50}});
    const medium = g.submit(); assert.equal(g.warnings.length, 0); assert.equal(g.requests[2].body.allow_anlas, false);
    g.reply({draft: draft('medium')}); await medium;
});

test('failed drafts retry only after explicit paid approval using their saved settings', async () => {
    const failed = draft('failed', 'failed', {settings: {...clone(settings), width: 640, height: 2048, options: {steps: 35}}, error: 'Synthetic failure'});
    const f = fixture(); await f.mountFolder({records: [failed], edit: true}); f.value(settings);
    const retry = f.button('다시 생성').onclick(); assert.equal(f.requests.length, 2);
    assert.deepEqual([f.warnings[0].width, f.warnings[0].height, f.warnings[0].steps], [640, 2048, 35]);
    await f.warning(true); assert.equal(f.requests[2].url, '/api/daki/drafts/failed/retry');
    assert.deepEqual(f.requests[2].body, {allow_anlas: true});
    f.reply({draft: draft('failed', 'running')}); await retry; assert.equal(f.timers.size, 1);
});

test('paid retry cancellation and navigation during confirmation cannot start a generation', async () => {
    const failed = draft('failed', 'failed', {settings: {...clone(settings), options: {steps: 29}}});
    const f = fixture(); await f.mountFolder({records: [failed], edit: true});
    const cancelled = f.button('다시 생성').onclick(); await f.warning(false); await cancelled; assert.equal(f.requests.length, 2);
    const stale = f.button('다시 생성').onclick(); f.leave(); f.content.textContent = 'New page';
    await f.warning(true); await stale; assert.equal(f.requests.length, 2); assert.equal(f.content.textContent, 'New page');
});

test('unknown generation outcomes require a folder refresh before another charged request', async () => {
    const f = fixture(); await f.mountFolder({edit: true}); const creating = f.submit();
    f.fail(); await creating; assert.equal(f.button('시안 한 장 생성').disabled, true);
    f.submit(); assert.equal(f.requests.length, 3);
    const refresh = f.button('폴더 다시 불러오기').onclick(); f.reply({folder: folder(), drafts: [draft('accepted')]}); await refresh;
    assert.equal(f.button('시안 한 장 생성').disabled, false);
    assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
});

test('invalid editor values and server validation errors do not start background generation', async () => {
    const f = fixture(); await f.mountFolder({edit: true}); f.value(null); f.submit(); assert.equal(f.requests.length, 2);
    f.value(settings); const creating = f.submit(); f.reply({message: 'Anlas permission needed'}, 409); await creating;
    assert.equal(f.button('시안 한 장 생성').disabled, false); assert.match(f.content.textContent, /Anlas permission needed/);
    assert.equal(f.requests.length, 3); assert.equal(f.timers.size, 0);
});
test('folder settings can be saved without generation and restored only into the matching folder', async () => {
    const f = fixture(); await f.mountFolder({records: [draft('a')], edit: true});
    f.value({...settings, prompt: 'saved folder prompt'}); const saving = f.button('설정 저장').onclick();
    assert.equal(f.requests.at(-1).url, '/api/daki/draft-folders/folder-1'); assert.equal(f.requests.at(-1).method, 'PUT');
    assert.deepEqual(f.requests.at(-1).body.settings.prompt, 'saved folder prompt'); assert.equal(f.requests.filter(request => request.method === 'POST').length, 0);
    f.reply({folder: folder({settings: {...settings, prompt: 'saved folder prompt'}})}); await saving;
    assert.match(f.content.textContent, /폴더 설정을 저장했습니다/);
    const legacy = fixture(); await legacy.mountFolder({selectedFolder: folder({id: 'legacy', project_id: null, legacy: true}), records: [], projectId: '', edit: true});
    assert.equal(legacy.button('설정 저장').disabled, true);
});

test('unsaved editor changes do not replace persisted folder settings when the folder is reopened', async () => {
    const saved = {...clone(settings), prompt: 'persisted prompt'}, f = fixture();
    await f.mountFolder({selectedFolder: folder({settings: saved}), edit: true});
    f.editors[0].setSettings({...settings, prompt: 'unsaved prompt'});
    f.win.DakiDrafts.leave(); f.content.replaceChildren();
    const reopening = f.win.DakiDrafts.render(new URLSearchParams('folder=folder-1&edit=1'), f.content);
    f.reply({folder: folder({settings: saved}), drafts: []}); await flush();
    f.reply({project: {id: 'project-1', name: 'Synthetic project'}}); await reopening;
    assert.equal(f.editors[1].initial.prompt, 'persisted prompt');
});

test('generator preview selection is independent of prompt settings and late polling cannot steal a manual preview', async () => {
    const f = fixture(); await f.mountFolder({records: [draft('a'), draft('b'), draft('running', 'running')], edit: true});
    const before = f.elements('img').find(image => image.className === 'daki-draft-preview-image'); assert.equal(before.src, '/api/daki/drafts/a/image?full=1');
    f.value({...settings, prompt: 'editor remains unchanged'});
    const poll = f.poll();
    const previews = f.byClass('daki-draft-history-preview'); previews[1].onclick();
    assert.equal(f.elements('img').find(image => image.className === 'daki-draft-preview-image').src, '/api/daki/drafts/b/image?full=1');
    assert.equal(f.editors[0].read().prompt, 'editor remains unchanged');
    f.reply({folder: folder(), drafts: [draft('a'), draft('b'), draft('running', 'running')]}); await poll;
    assert.equal(f.elements('img').find(image => image.className === 'daki-draft-preview-image').src, '/api/daki/drafts/b/image?full=1');
});

test('gallery bulk cleanup asks first and sends an exact unselected snapshot with selected protection', async () => {
    const records = [draft('keep', 'completed', {selected: true}), draft('remove-1'), draft('remove-2')];
    const f = fixture(); await f.mountFolder({records});
    const remove = f.button('선택 외 삭제'); assert.equal(remove.disabled, false);
    f.confirmNext(false); await remove.onclick(); assert.equal(f.requests.length, 2);
    f.confirmNext(true); const deleting = remove.onclick();
    assert.equal(f.requests.at(-1).url, '/api/daki/draft-folders/folder-1/delete-drafts');
    assert.deepEqual(f.requests.at(-1).body, {ids: ['remove-1', 'remove-2'], preserve_selected: true});
    f.reply({folder: folder({count: 1, selected_count: 1}), drafts: [records[0]], deleted_ids: ['remove-1', 'remove-2'], failed_ids: [], skipped_ids: []});
    await deleting; assert.equal(f.byClass('daki-draft-card').length, 1); assert.match(f.content.textContent, /2장을 삭제했습니다/);
});

test('individual deletion confirms exact ID and handles reference confirmation without broadening the snapshot', async () => {
    const f = fixture(); await f.mountFolder({records: [draft('only')]});
    const deleting = f.button('삭제').onclick();
    assert.deepEqual(f.requests.at(-1).body, {ids: ['only'], preserve_selected: false});
    f.reply({code: 'daki_references', references: []}, 409); await flush();
    assert.deepEqual(f.requests.at(-1).body, {ids: ['only'], preserve_selected: false, confirm_daki: true});
    f.reply({folder: folder(), drafts: [], deleted_ids: ['only'], failed_ids: [], skipped_ids: []}); await deleting;
    assert.equal(f.byClass('daki-draft-card').length, 0); assert.match(f.content.textContent, /1장을 삭제했습니다/);
});

test('generator cleanup is disabled without both selected and unselected results and preserves IDs on execution', async () => {
    const f = fixture(); await f.mountFolder({records: [draft('keep', 'completed', {selected: true}), draft('remove')], edit: true});
    const bulk = f.button('선택 외 삭제'); assert.equal(bulk.disabled, false);
    const deleting = bulk.onclick(); assert.deepEqual(f.requests.at(-1).body, {ids: ['remove'], preserve_selected: true});
    f.reply({folder: folder(), drafts: [draft('keep', 'completed', {selected: true})], deleted_ids: ['remove'], failed_ids: [], skipped_ids: []}); await deleting;
    assert.equal(bulk.disabled, true);
});

test('a late folder poll cannot overwrite a completed selection mutation', async () => {
    const f = fixture(); await f.mountFolder({records: [draft('a'), draft('running', 'running')], edit: true});
    const poll = f.poll(); const checkbox = f.elements('input').find(item => item.getAttribute('aria-label') === '결과로 선택');
    checkbox.checked = true; const selection = checkbox.onchange();
    f.events.get('daki-drafts-changed')();
    f.replyAt(1, {draft: draft('a', 'completed', {selected: true})}); await selection;
    f.replyAt(0, {folder: folder(), drafts: [draft('a'), draft('running', 'running')]}); await poll;
    f.replyAt(0, {folder: folder(), drafts: [draft('a'), draft('running', 'running')]}); await flush();
    assert.equal(f.elements('input').find(item => item.getAttribute('aria-label') === '결과로 선택').checked, true);
});
test('a direct project folder uses folder.project_id for explicit project addition', async () => {
    const f = fixture(); await f.mountFolder({records: [draft('a')], projectId: ''});
    assert.equal(f.requests[1].url, '/api/daki/projects/project-1');
    f.button('프로젝트에 추가').onclick(); assert.equal(f.adds[0].projectId, 'project-1');
    assert.equal(f.nodes.dakiBack.href, '#project=project-1');
});

test('gallery settings restore reopens the same folder editor with the chosen record settings', async () => {
    const record = draft('saved', 'completed', {settings: {...clone(settings), prompt: 'record-specific prompt'}});
    const f = fixture(); await f.mountFolder({records: [record]});
    f.elements('a').find(item => item.textContent === '설정 불러오기').onclick();
    const opening = f.win.DakiDrafts.render(new URLSearchParams('project=project-1&folder=folder-1&edit=1'), f.content);
    f.reply({project: {id: 'project-1', name: 'Synthetic project'}}); await flush();
    f.reply({folder: folder(), drafts: [record]}); await opening;
    assert.equal(f.editors.length, 1); assert.equal(f.editors[0].initial.prompt, 'record-specific prompt');
    assert.equal(f.requests.filter(request => request.method === 'POST').length, 0);
});

test('empty folders show a clear center state and no cleanup can run without a selected result', async () => {
    const f = fixture(); await f.mountFolder({records: [], edit: true});
    assert.match(f.content.textContent, /첫 시안을 생성하면 큰 미리보기가 여기에 표시됩니다/);
    assert.equal(f.button('선택 외 삭제').disabled, true); assert.equal(f.requests.filter(request => request.method === 'POST').length, 0);
});

test('framing creates a separate copy, selects its preview, and never attaches it or removes the original', async () => {
    const original = draft('original'), f = fixture(); await f.mountFolder({records: [original], edit: true});
    f.button('5:16 맞추기 (선택)').onclick(); assert.equal(f.framing[0].record.id, 'original');
    assert.equal(f.adds.length, 0); assert.equal(f.requests.length, 2);
    const copy = draft('copy', 'completed', {framing: {mode: 'pad', source_id: 'original'}});
    f.framing[0].onSaved(copy);
    assert.equal(f.elements('img').find(image => image.className === 'daki-draft-preview-image').src, '/api/daki/drafts/copy/image?full=1');
    assert.equal(f.byClass('daki-draft-history-card').length, 2); assert.match(f.content.textContent, /투명 여백을 붙인 사본/);
    f.button('프로젝트에 추가').onclick(); assert.equal(f.adds[0].path, copy.path);
    const prior = f.framingClosed(); f.leave(); assert.equal(f.framingClosed(), prior + 1);
});

test('leaving clears folder polling and listeners, disposes the editor, and ignores late responses', async () => {
    const f = fixture(); await f.mountFolder({records: [draft('running', 'running')], edit: true});
    assert.equal(f.timers.size, 1); assert.ok(f.events.has('daki-drafts-changed'));
    const poll = f.poll(); f.leave(); assert.equal(f.timers.size, 0); assert.equal(f.events.has('daki-drafts-changed'), false);
    assert.equal(f.editors[0].disposed, true); f.content.textContent = 'New page';
    f.reply({folder: folder(), drafts: [draft('done')]}); await poll; assert.equal(f.content.textContent, 'New page');
});

test('leaving while a paid confirmation is open cannot start a request', async () => {
    const f = fixture(); await f.mountFolder({edit: true});
    f.value({...settings, width: 640, height: 2048}); const creating = f.submit();
    f.leave(); f.content.textContent = 'Other page'; await f.warning(true); await creating;
    assert.equal(f.requests.length, 2); assert.equal(f.content.textContent, 'Other page');
});
test('partial cleanup refreshes the folder and reports server-protected or failed results', async () => {
    const f = fixture(); await f.mountFolder({records: [draft('keep', 'completed', {selected: true}), draft('candidate')]});
    const deleting = f.button('선택 외 삭제').onclick();
    f.reply({folder: folder(), drafts: [draft('keep', 'completed', {selected: true}), draft('candidate')],
        deleted_ids: [], failed_ids: [], skipped_ids: ['candidate']}); await flush();
    assert.equal(f.requests.at(-1).url, '/api/daki/draft-folders/folder-1');
    f.reply({folder: folder({count: 2, selected_count: 1}), drafts: [draft('keep', 'completed', {selected: true}), draft('candidate')]});
    await deleting; assert.match(f.content.textContent, /보호되어 건너뜀 1장/);
    assert.match(f.content.textContent, /2장 · 1장 선택됨/);
});

test('a reference-confirmation cancellation leaves the explicit deletion untouched', async () => {
    const f = fixture(); await f.mountFolder({records: [draft('linked')]});
    f.confirmNext(true); f.confirmNext(false); const deleting = f.button('삭제').onclick();
    f.reply({code: 'daki_references', references: []}, 409); await deleting;
    assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
    assert.equal(f.byClass('daki-draft-card').length, 1); assert.match(f.content.textContent, /삭제를 취소했습니다/);
});

test('free Medium retry retains its saved settings and does not show an Anlas modal', async () => {
    const saved = {...clone(settings), model: 'nai-diffusion-5-full-medium', options: {steps: 50}};
    const f = fixture(); await f.mountFolder({records: [draft('medium-failed', 'failed', {settings: saved})], edit: true});
    const retry = f.button('다시 생성').onclick(); assert.equal(f.warnings.length, 0);
    assert.deepEqual(f.requests.at(-1).body, {allow_anlas: false});
    f.reply({draft: draft('medium-failed', 'running', {settings: saved})}); await retry;
});
test('a framing copy survives a folder refresh that began before the copy was saved', async () => {
    const f = fixture(); await f.mountFolder({records: [draft('ready'), draft('running', 'running')], edit: true});
    const stalePoll = f.poll(); f.button('5:16 맞추기 (선택)').onclick();
    const copy = draft('framed-copy', 'completed', {framing: {mode: 'cover', source_id: 'ready'}});
    f.framing[0].onSaved(copy);
    f.reply({folder: folder(), drafts: [draft('ready'), draft('running', 'running')]}); await stalePoll;
    assert.equal(f.byClass('daki-draft-history-card').length, 3);
    assert.equal(f.elements('img').find(image => image.className === 'daki-draft-preview-image').src, '/api/daki/drafts/framed-copy/image?full=1');
    assert.equal(f.adds.length, 0);
});

test('record-settings transfer is limited to its folder and does not leak across folder navigation', async () => {
    const record = draft('source', 'completed', {settings: {...clone(settings), prompt: 'record-only prompt'}});
    const f = fixture(); await f.mountFolder({records: [record]});
    f.elements('a').find(item => item.textContent === '설정 불러오기').onclick();
    const opening = f.win.DakiDrafts.render(new URLSearchParams('project=project-1&folder=folder-2&edit=1'), f.content);
    f.reply({project: {id: 'project-1', name: 'Synthetic project'}}); await flush();
    f.reply({folder: folder({id: 'folder-2', name: 'Second folder', settings: {...settings, prompt: 'second-folder settings'}}), drafts: []});
    await opening; assert.equal(f.editors[0].initial.prompt, 'second-folder settings');
});
test('failed gallery result opens the generator with saved settings and retries only after explicit approval', async () => {
    const saved = {...clone(settings), prompt: 'failed record prompt', width: 640, height: 2048, options: {steps: 35}};
    const failed = draft('failed-record', 'failed', {settings: saved, error: 'Synthetic failure'});
    const f = fixture(); await f.mountFolder({records: [draft('completed'), failed]});
    const open = f.elements('a').find(item => item.textContent === '생성창에서 다시 시도');
    assert.ok(open); assert.equal(open.href, '#daki&library=drafts&project=project-1&folder=folder-1&edit=1'); open.onclick();
    assert.equal(f.requests.filter(request => request.method === 'POST').length, 0);
    const navigating = f.win.DakiDrafts.render(new URLSearchParams('project=project-1&folder=folder-1&edit=1'), f.content);
    f.reply({project: {id: 'project-1', name: 'Synthetic project'}}); await flush();
    f.reply({folder: folder(), drafts: [draft('completed'), failed]}); await navigating;
    assert.equal(f.editors[0].initial.prompt, 'failed record prompt');
    assert.match(f.content.textContent, /생성 실패/);
    const active = f.byClass('daki-draft-history-card').find(item => item.classList.contains('is-active'));
    assert.ok(active.textContent.includes('실패'));
    const retry = f.button('다시 생성').onclick(); assert.deepEqual([f.warnings[0].width, f.warnings[0].height, f.warnings[0].steps], [640, 2048, 35]);
    await f.warning(true); assert.equal(f.requests.at(-1).url, '/api/daki/drafts/failed-record/retry');
    f.reply({draft: draft('failed-record', 'running', {settings: saved})}); await retry;
});

test('failed folder refresh keeps its reload button visible and a successful reload restores controls', async () => {
    const f = fixture(); await f.mountFolder({edit: true});
    f.events.get('daki-drafts-changed')(); f.fail(new Error('Temporary folder read failure')); await flush();
    const reload = f.button('폴더 다시 불러오기'); assert.equal(reload.hidden, false);
    assert.equal(f.button('시안 한 장 생성').disabled, true);
    const retry = reload.onclick(); f.reply({folder: folder(), drafts: []}); await retry;
    assert.equal(reload.hidden, true); assert.equal(f.button('시안 한 장 생성').disabled, false);
});

test('history list scrolling stays in place while selection updates rebuild its rows', async () => {
    const f = fixture(); await f.mountFolder({records: [draft('a'), draft('b')], edit: true});
    const list = f.byClass('daki-draft-history-list')[0]; list.scrollTop = 132;
    const checkbox = f.elements('input').find(item => item.getAttribute('aria-label') === '결과로 선택');
    checkbox.checked = true; const selecting = checkbox.onchange();
    f.reply({draft: draft('a', 'completed', {selected: true})}); await selecting;
    assert.equal(list.scrollTop, 132);
});
