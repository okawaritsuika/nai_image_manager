const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../static/daki_dictionary_download.js'), 'utf8');
const standaloneHtml = fs.readFileSync(require.resolve('../static/daki_dictionary/index.html'), 'utf8');
const shellHtml = fs.readFileSync(require.resolve('../index.html'), 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

class FakeNode {
  constructor() {
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.title = '';
    this.attributes = new Map();
    this.listeners = new Map();
  }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  dispatch(type) {
    for (const callback of this.listeners.get(type) || []) callback({type, currentTarget: this, target: this});
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
}

const idleSnapshot = (available = true) => ({available, image_status: {}, job: {
  id: null, status: 'idle', phase: '', phase_current: 0, phase_total: 0, message: '', installed: 0,
}});
const jsonResponse = (data, ok = true) => ({ok, json: async () => data});
const settle = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

function fixture({fetchImpl, available = true} = {}) {
  const downloadButton = new FakeNode();
  const statusRow = new FakeNode();
  const statusLine = new FakeNode();
  const stopButton = new FakeNode();
  const nodes = new Map([
    ['#dictionaryDownloadImages', downloadButton],
    ['#dictionaryImagePackStatus', statusLine],
    ['#dictionaryStopImagePack', stopButton],
    ['.image-pack-status-row', statusRow],
  ]);
  const host = {querySelector: selector => nodes.get(selector) || null};
  const document = {
    visibilityState: 'visible',
    listeners: new Map(),
    addEventListener(type, callback) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); },
    dispatch(type) { for (const callback of this.listeners.get(type) || []) callback({type}); },
  };
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  const root = {
    document,
    fetch(url, options) {
      requests.push({url, options});
      if (fetchImpl) return fetchImpl(url, options, requests.length - 1);
      return Promise.resolve(jsonResponse(idleSnapshot(available)));
    },
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, {callback, delay});
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(source, {window: root, AbortController});
  const controller = root.DakiDictionaryDownload.mount(host, {onInstalled: (...args) => installed.push(args)});
  const installed = [];
  return {root, host, controller, document, requests, timers, installed, downloadButton, statusRow, statusLine, stopButton,
    runTimer: async () => {
      const entry = [...timers.entries()].sort((a, b) => a[1].delay - b[1].delay)[0];
      assert.ok(entry, 'a poll should be scheduled');
      timers.delete(entry[0]);
      entry[1].callback();
      await settle();
    }};
}

test('mount checks availability with GET only and does not start a download', async () => {
  const f = fixture();
  await settle();

  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, '/api/daki/dictionary/image-pack');
  assert.equal(f.requests[0].options.method || 'GET', 'GET');
  assert.equal(f.downloadButton.disabled, false);
  assert.equal(f.downloadButton.textContent, '예시 이미지 다운로드');
  assert.equal(f.statusRow.hidden, true);
  assert.equal(f.stopButton.hidden, true);
  assert.equal(f.installed.length, 0);
  f.controller.dispose();
});

test('manual start is single-flight and shows human-readable download progress', async () => {
  const start = deferred();
  const f = fixture({fetchImpl: (url, options) => options.method === 'POST'
    ? start.promise : Promise.resolve(jsonResponse(idleSnapshot()))});
  await settle();

  f.downloadButton.dispatch('click');
  f.downloadButton.dispatch('click');
  assert.equal(f.requests.filter(request => request.options.method === 'POST').length, 1);
  const post = f.requests.find(request => request.options.method === 'POST');
  assert.equal(post.url, '/api/daki/dictionary/image-pack');
  assert.equal(post.options.body, '{}');
  assert.equal(f.downloadButton.disabled, true);
  assert.equal(f.downloadButton.textContent, '다운로드 시작 중…');

  start.resolve(jsonResponse({available: true, image_status: {}, job: {
    id: 'download-1', status: 'running', phase: 'download', phase_current: 5 * 1024 * 1024,
    phase_total: 20 * 1024 * 1024, message: '압축 파일 받는 중', installed: 0,
  }}));
  await settle();
  assert.equal(f.statusRow.hidden, false);
  assert.match(f.statusLine.textContent, /5MB \/ 20MB \(25%\)/);
  assert.match(f.statusLine.textContent, /압축 파일 받는 중/);
  assert.equal(f.stopButton.hidden, false);
  assert.equal(f.downloadButton.disabled, true);
  f.controller.dispose();
});

test('running extraction reports image counts and stop is single-flight', async () => {
  let job = {id: 'extract-1', status: 'running', phase: 'extract', phase_current: 3, phase_total: 8,
    message: '압축 해제 중', installed: 0};
  const stop = deferred();
  const f = fixture({fetchImpl: (url, options) => {
    if (url.endsWith('/stop')) return stop.promise;
    if (options.method === 'POST') return Promise.resolve(jsonResponse({available: true, image_status: {}, job}));
    return Promise.resolve(jsonResponse({available: true, image_status: {}, job}));
  }});
  await settle();
  assert.match(f.statusLine.textContent, /3 \/ 8장/);
  assert.equal(f.stopButton.disabled, false);

  f.stopButton.dispatch('click');
  f.stopButton.dispatch('click');
  assert.equal(f.requests.filter(request => request.url.endsWith('/stop')).length, 1);
  assert.equal(f.requests.find(request => request.url.endsWith('/stop')).options.body, '{}');
  assert.equal(f.stopButton.disabled, true);

  job = {...job, status: 'stopping', message: '중지 요청 처리 중'};
  stop.resolve(jsonResponse({available: true, image_status: {}, job}));
  await settle();
  assert.equal(f.stopButton.textContent, '중지 중…');
  assert.equal(f.statusRow.hidden, false);
  f.controller.dispose();
});

test('completed job refreshes image status once for its id, including after visibility resume', async () => {
  let job = {id: null, status: 'idle', phase: '', phase_current: 0, phase_total: 0, message: '', installed: 0};
  const f = fixture({fetchImpl: (url, options) => {
    if (options.method === 'POST') {
      job = {id: 'completed-1', status: 'running', phase: 'extract', phase_current: 1, phase_total: 12,
        message: '압축 해제 중', installed: 0};
    }
    return Promise.resolve(jsonResponse({available: true, image_status: {}, job}));
  }});
  await settle();
  f.downloadButton.dispatch('click');
  await settle();
  job = {...job, status: 'completed', phase_current: 12, installed: 12, message: '이미지 연결 완료'};
  await f.runTimer();

  assert.equal(f.installed.length, 1);
  assert.equal(f.installed[0][0].id, 'completed-1');
  assert.equal(f.statusLine.textContent, '예시 이미지 연결 완료 · 12장');
  f.document.visibilityState = 'hidden';
  f.document.dispatch('visibilitychange');
  f.document.visibilityState = 'visible';
  f.document.dispatch('visibilitychange');
  await settle();
  assert.equal(f.installed.length, 1);
  f.controller.dispose();
});

test('failed job shows its message and allows a manual retry', async () => {
  let job = {id: 'failed-1', status: 'failed', phase: 'download', phase_current: 0, phase_total: 100,
    message: '다운로드 서버에 연결하지 못했습니다.', installed: 0};
  const f = fixture({fetchImpl: (_url, options) => {
    if (options.method === 'POST') job = {id: 'retry-1', status: 'running', phase: 'download', phase_current: 0,
      phase_total: 100, message: '다시 다운로드합니다.', installed: 0};
    return Promise.resolve(jsonResponse({available: true, image_status: {}, job}));
  }});
  await settle();
  assert.equal(f.statusLine.textContent, '다운로드 서버에 연결하지 못했습니다.');
  assert.equal(f.downloadButton.disabled, false);
  f.downloadButton.dispatch('click');
  await settle();
  assert.equal(f.requests.filter(request => request.options.method === 'POST').length, 1);
  assert.equal(f.statusLine.textContent.includes('다시 다운로드합니다.'), true);
  f.controller.dispose();
});

test('already connected images disable the sample download button without changing the connection', async () => {
  const f = fixture({available: false});
  await settle();

  assert.equal(f.downloadButton.disabled, true);
  assert.equal(f.downloadButton.textContent, '이미지 연결됨');
  f.downloadButton.dispatch('click');
  await settle();
  assert.equal(f.requests.filter(request => request.options.method === 'POST').length, 0);
  assert.equal(f.requests.length, 1);
  f.controller.dispose();
});

test('a hidden view aborts a pending status read and reloads availability when shown again', async () => {
  const pendingRead = deferred();
  let getCount = 0;
  const f = fixture({fetchImpl: () => {
    getCount += 1;
    return getCount === 1 ? pendingRead.promise : Promise.resolve(jsonResponse(idleSnapshot()));
  }});
  await settle();
  const firstRead = f.requests[0].options.signal;
  f.document.visibilityState = 'hidden';
  f.document.dispatch('visibilitychange');
  assert.equal(firstRead.aborted, true);
  pendingRead.resolve(jsonResponse(idleSnapshot(false)));
  await settle();
  assert.equal(f.downloadButton.textContent, '다운로드 준비 중…');
  assert.equal(f.downloadButton.disabled, true);

  f.document.visibilityState = 'visible';
  f.document.dispatch('visibilitychange');
  await settle();
  assert.equal(getCount, 2);
  assert.equal(f.downloadButton.textContent, '예시 이미지 다운로드');
  assert.equal(f.downloadButton.disabled, false);
  f.controller.dispose();
});

test('polling pauses while hidden and resumes with a fresh status read', async () => {
  const job = {id: 'running-1', status: 'running', phase: 'extract', phase_current: 1, phase_total: 6,
    message: '압축 해제 중', installed: 0};
  const f = fixture({fetchImpl: () => Promise.resolve(jsonResponse({available: true, image_status: {}, job}))});
  await settle();
  assert.equal(f.timers.size, 1);
  f.document.visibilityState = 'hidden';
  f.document.dispatch('visibilitychange');
  assert.equal(f.timers.size, 0);

  f.document.visibilityState = 'visible';
  f.document.dispatch('visibilitychange');
  await settle();
  assert.equal(f.requests.length, 2);
  assert.equal(f.timers.size, 1);
  f.controller.dispose();
  assert.equal(f.timers.size, 0);
});

test('hidden views pause polling and dispose ignores a late start response without stopping the backend job', async () => {
  const pendingStart = deferred();
  const f = fixture({fetchImpl: (url, options) => options.method === 'POST'
    ? pendingStart.promise : Promise.resolve(jsonResponse(idleSnapshot()))});
  await settle();
  f.downloadButton.dispatch('click');
  assert.equal(f.requests.filter(request => request.options.method === 'POST').length, 1);
  f.controller.dispose();
  pendingStart.resolve(jsonResponse({available: true, image_status: {}, job: {
    id: 'late-start', status: 'completed', phase: 'extract', phase_current: 1, phase_total: 1,
    message: '완료', installed: 1,
  }}));
  await settle();

  assert.equal(f.installed.length, 0);
  assert.equal(f.requests.some(request => request.url.endsWith('/stop')), false);
  assert.equal(f.timers.size, 0);
});

test('a GET started while manual start is pending cannot replace the newer POST state', async () => {
  const staleRead = deferred();
  const pendingStart = deferred();
  let getCount = 0;
  const f = fixture({fetchImpl: (url, options) => {
    if (options.method === 'POST') return pendingStart.promise;
    getCount += 1;
    if (getCount === 2) return staleRead.promise;
    return Promise.resolve(jsonResponse({available: true, image_status: {}, job: {
      id: null, status: 'idle', phase: '', phase_current: 0, phase_total: 0, message: '', installed: 0,
    }}));
  }});
  await settle();

  f.downloadButton.dispatch('click');
  f.document.visibilityState = 'hidden';
  f.document.dispatch('visibilitychange');
  f.document.visibilityState = 'visible';
  f.document.dispatch('visibilitychange');
  assert.equal(getCount, 2);
  pendingStart.resolve(jsonResponse({available: true, image_status: {}, job: {
      id: 'new-job', status: 'running', phase: 'extract', phase_current: 2, phase_total: 9,
      message: '새 작업 진행 중', installed: 0,
    }}));
  await settle();
  assert.match(f.statusLine.textContent, /새 작업 진행 중/);

  staleRead.resolve(jsonResponse(idleSnapshot()));
  await settle();
  assert.equal(f.statusLine.textContent.includes('새 작업 진행 중'), true);
  assert.equal(f.downloadButton.disabled, true);
  f.controller.dispose();
});

test('missing optional controls leave the old dictionary page untouched', () => {
  const root = {document: {}, fetch() { throw new Error('must not fetch'); }};
  vm.runInNewContext(source, {window: root, AbortController});
  const handle = root.DakiDictionaryDownload.mount({querySelector: () => null});
  assert.doesNotThrow(() => handle.dispose());
});

test('standalone and embedded templates load the helper before the dictionary app', () => {
  for (const html of [standaloneHtml, shellHtml]) {
    const helper = html.indexOf('<script src="/static/daki_dictionary_download.js" defer></script>');
    const app = html.indexOf('<script src="/static/daki_dictionary/app.js" defer></script>');
    assert.ok(helper >= 0 && app > helper);
  }
});

test('download status row is a visible top-level sibling between the toolbar and workspace', () => {
  assert.match(standaloneHtml,
    /<\/header>\s*<div class="image-pack-status-row" hidden>[\s\S]*?<\/div>\s*<main class="workspace/);
  const detailsStart = standaloneHtml.indexOf('<details class="image-connection-details">');
  const detailsEnd = standaloneHtml.indexOf('</details>', detailsStart);
  const rowStart = standaloneHtml.indexOf('<div class="image-pack-status-row"');
  assert.ok(detailsStart >= 0 && detailsEnd > detailsStart && rowStart >= 0);
  assert.equal(rowStart > detailsStart && rowStart < detailsEnd, false);
});
