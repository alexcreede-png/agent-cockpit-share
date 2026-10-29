'use strict';
// The phone app is one classic script: a duplicate top-level name or a syntax error kills the
// whole page. Compile it here so that fails in CI instead of on the phone.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

test('public/app.js compiles as a script', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(src, { filename: 'app.js' }));
});

function frontend({ failSend = false, failSendStatus = 503, failEnd = false, voiceStall = false, voiceBodyStall = false, dictation = false, history = '', terminalHistory, historyError = false, createFlow = false, startRecovery = false, savedStarts = new Map(), storageDenied = false, cryptoDenied = false, requestHook, initialHash = '' } = {}) {
  class Element {
    constructor() {
      this.children = []; this.dataset = {}; this.style = {}; this.value = ''; this.hidden = false;
      this.textContent = ''; this.className = ''; this.clientWidth = 0; this.clientHeight = 0;
      this.scrollHeight = 0; this.scrollTop = 0; this.listeners = {};
      this.classList = {
        add: (c) => { this.className = [...new Set([...this.className.split(' '), c])].join(' ').trim(); },
        remove: (c) => { this.className = this.className.split(' ').filter((x) => x !== c).join(' '); },
        contains: (c) => this.className.split(' ').includes(c),
        toggle: (c, force) => {
          const on = force === undefined ? !this.classList.contains(c) : force;
          this.classList[on ? 'add' : 'remove'](c); return on;
        },
      };
    }
    set innerHTML(value) {
      this.children = []; this._text = '';
      for (const match of value.matchAll(/class="([^"]+)"/g)) { const n = new Element(); n.className = match[1]; this.append(n); }
    }
    insertBefore(node, before) {
      this.children = this.children.filter(n => n !== node);
      const index = this.children.indexOf(before);
      this.children.splice(index < 0 ? this.children.length : index, 0, node); node.parent = this;
    }
    get textContent() { return this._text || this.children.map(n => n.textContent).join(''); }
    set textContent(value) { this._text = value; this.children = []; }
    get firstElementChild() { return this.children[0]; }
    appendChild(node) { this.append(node); return node; }
    querySelectorAll(selector) {
      const classes = selector.split('.').filter(Boolean);
      return this.children.flatMap(n => [n, ...n.querySelectorAll(selector)])
        .filter(n => classes.every(c => n.classList.contains(c)));
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    replaceChildren(...nodes) { this._text = ''; this.children = []; this.append(...nodes); }
    append(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); }
    setAttribute(k, v) { this[k] = v; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    fire(type, event = {}) { for (const fn of this.listeners[type] || []) fn(event); }
    click() { return this.onclick?.(); }
    focus() { document.activeElement = this; }
  }
  const elements = new Map();
  const el = (id) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const document = {
    querySelector: (s) => el(s), querySelectorAll: () => [], createElement: () => new Element(),
    documentElement: { dataset: {}, style: { setProperty() {} } }, addEventListener() {},
  };
  const calls = [], uploads = [], terminals = [], sockets = [], timers = [], observers = [];
  let historyText = history, failHistory = historyError;
  const setup = { startRecovery, projectError: false, createError: false, loseResponse: false, errorCode: '', errorStatus: 503, badReply: false, holdCreate: false, finishCreate: null, sessions: null };
  const exampleProjects = [{path:'/example/alpha',label:'Alpha project'},{path:'/example/beta',label:'Beta project'}];
  let finishSend;
  class XHR {
    constructor() { this.upload = {}; uploads.push(this); }
    open(method, path) { this.path = path; }
    setRequestHeader() {}
    send(file) { this.file = file; }
    complete(path) { this.status = 200; this.responseText = JSON.stringify({ path }); this.onload(); }
    timeoutNow() { this.ontimeout?.(); }
    abort() { this.aborted = true; this.onabort?.(); }
  }
  class FakeMediaRecorder {
    static isTypeSupported() { return true; }
    constructor() { this.mimeType = 'audio/webm'; this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['synthetic audio'], { type: 'audio/webm' }) });
      this.onstop?.();
    }
  }
  class FakeTerminal {
    constructor() { this.cols = 80; this.rows = 24; this.writes = []; terminals.push(this); }
    loadAddon() {}
    open() {}
    onData(fn) { this.input = fn; }
    write(data) { this.writes.push(data); }
    dispose() { this.disposed = true; }
  }
  class FakeSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
  }
  const windowEvents = new Map();
  const window = { addEventListener(type, fn) { const listeners = windowEvents.get(type) || []; listeners.push(fn); windowEvents.set(type, listeners); }, MediaRecorder: voiceStall || voiceBodyStall || dictation ? FakeMediaRecorder : null, visualViewport: null };
  window.parent = window;
  const location = { hash: initialHash, protocol: 'https:', host: 'example.test' };
  const routeHistory = [initialHash]; let routeIndex = 0;
  const navHistory = {
    replaceState(state, title, hash) { routeHistory[routeIndex] = location.hash = hash; },
    pushState(state, title, hash) { routeHistory.splice(++routeIndex); routeHistory.push(location.hash = hash); },
    back() { if (routeIndex > 0) { location.hash = routeHistory[--routeIndex]; for (const fn of windowEvents.get('popstate') || []) fn(); } },
    forward() { if (routeIndex < routeHistory.length - 1) { location.hash = routeHistory[++routeIndex]; for (const fn of windowEvents.get('popstate') || []) fn(); } },
  };
  const context = vm.createContext({
    document, window, navigator: voiceStall || voiceBodyStall || dictation ? { mediaDevices: { getUserMedia: async () => { if (setup.micPermission) await setup.micPermission; return { getTracks: () => [{ stop() { setup.micStops = (setup.micStops || 0) + 1; } }] }; } } } : {},
    matchMedia: () => ({ matches: true }), XMLHttpRequest: XHR, MediaRecorder: FakeMediaRecorder, Blob,
    Terminal: FakeTerminal, WebSocket: FakeSocket, FitAddon: { FitAddon: class { fit() {} } },
    AbortController,
    crypto: { getRandomValues: (bytes) => { if (cryptoDenied) throw new Error('unavailable'); return require('node:crypto').randomFillSync(bytes); } },
    sessionStorage: {
      getItem: k => { if (storageDenied) throw new Error('denied'); return savedStarts.get(k) || null; },
      setItem: (k,v) => { if (storageDenied) throw new Error('denied'); savedStarts.set(k,v); },
      removeItem: k => { if (storageDenied) throw new Error('denied'); savedStarts.delete(k); },
    },
    location, history: navHistory,
    localStorage: { getItem: () => null, setItem() {} }, ResizeObserver: class {
      constructor(fn) { this.fn = fn; observers.push(this); }
      observe(element) { this.element = element; }
    },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, canceled: false }); return timers.length; },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].canceled = true; },
    setInterval: () => 1, clearInterval() {},
    addEventListener() {}, innerHeight: 800, fetch: async (path, opts = {}) => {
      calls.push({ path, opts });
      if (requestHook) { const response = await requestHook(path, opts); if (response) return response; }
      const responseHistory = !path.includes('format=reader') && terminalHistory !== undefined ? terminalHistory : historyText;
      if (voiceStall && path === '/api/transcribe') return new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
      if (voiceBodyStall && path === '/api/transcribe') return {
        ok: true,
        json: () => new Promise((resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
      };
      if (path === '/api/sessions/a/keys') await new Promise((resolve) => { finishSend = resolve; });
      if (createFlow && path === '/api/sessions' && setup.holdCreate) {
        await new Promise(resolve => { setup.finishCreate = resolve; });
      }
      if (path === '/api/sessions' && setup.loseResponse) throw new Error('response lost');
      const body = path === '/api/state' ? { startRecovery: setup.startRecovery, lanes: createFlow ? ['claude','codex','grok','agy','shell'] : [], sessions: setup.sessions ?? [...new Set(['a','b','synthetic-created',vm.runInContext('current', context)].filter(Boolean))].map(name => ({name,lane:'grok',project:'/example/project',status:'idle'})), actionEpoch: 'synthetic-epoch', dictationEpoch: 'synthetic-voice-epoch', transcribe: false }
        : path.endsWith('/keys') ? {ok:true,actionId:JSON.parse(opts.body).actionId} : path === '/api/projects' ? exampleProjects : path === '/api/sessions' ? {name:'synthetic-created', ...(setup.badReply ? {} : {requestId: JSON.parse(opts.body).requestId}), reused: false} : {};
      const failed = (setup.projectError && path === '/api/projects') || ((setup.createError || setup.errorCode) && path === '/api/sessions') || (failHistory && path.includes('/history')) || (failSend && path === '/api/sessions/a/keys') || (failEnd && path === '/api/sessions/a/end');
      return { ok: !failed, status: failed ? (path === '/api/sessions' && (setup.errorCode || setup.createError) ? setup.errorStatus : failSendStatus) : 200,
        headers: { get: () => path.includes('/history') && typeof responseHistory === 'string' ? 'text/plain' : 'application/json' },
        json: async () => path.includes('/history') && !failed ? responseHistory : failed ? { error: 'unavailable', code: setup.errorCode, requestId: path === '/api/sessions' ? JSON.parse(opts.body).requestId : undefined, name: 'synthetic-created' } : body,
        text: async () => path.includes('/history') ? responseHistory : '' };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'), context);
  return { context, el, calls, uploads, terminals, sockets, timers, observers, setup, savedStarts,
    setHistory: (text) => { historyText = text; }, setHistoryError: (value) => { failHistory = value; }, finishSend: () => finishSend?.() };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('read view follows the tail through sparse and dense resizes, but preserves deliberate scrollback', async () => {
  for (const history of ['Earlier output\n' + '\n'.repeat(40) + 'Prompt>',
    Array.from({ length: 90 }, (_, i) => `Output ${i}`).join('\n')]) {
    const h = frontend({ history });
    const reader = h.el('#reader');
    reader.clientHeight = 400; reader.scrollHeight = 1000;
    await tick();
    vm.runInContext("openTerm('a')", h.context);
    await tick();
    assert.equal(reader.textContent, history.includes('Earlier output')
      ? 'Earlier output\n\n\nPrompt>' : history);
    reader.scrollTop = 600; reader.fire('scroll');
    const resize = () => h.observers.find((o) => o.element === reader).fn();

    // WebKit may send a native scroll before ResizeObserver; it is not user scrollback.
    reader.clientHeight = 180; reader.scrollTop = 540; reader.fire('scroll'); resize();
    assert.equal(reader.scrollTop, 1000);
    await vm.runInContext('pullReader()', h.context); // unchanged history
    assert.equal(reader.scrollTop, 1000);

    // Chromium may resize without a scroll event first; growing also keeps the tail.
    reader.clientHeight = 400; reader.scrollTop = 600; resize();
    assert.equal(reader.scrollTop, 1000);
    reader.scrollTop = 100; reader.fire('scroll');
    reader.clientHeight = 180; reader.fire('scroll'); resize();
    assert.equal(reader.scrollTop, 100, 'manual scrollback survives resize');
    await vm.runInContext('pullReader()', h.context);
    assert.equal(reader.scrollTop, 100, 'unchanged polling preserves scrollback');

    h.el('#to-bottom').click();
    assert.equal(reader.scrollTop, 1000, 'Latest restores tail following');
    reader.clientHeight = 400; reader.scrollTop = 600; reader.fire('scroll'); resize();
    assert.equal(reader.scrollTop, 1000);
  }
});

test('read view compacts only large empty-row runs and preserves content and normal spacing', async () => {
  const history = ['  indented', '', '  ', '', 'next', '', '', '', '', '  final'].join('\n');
  const h = frontend({ history });
  await tick();
  vm.runInContext("openTerm('a')", h.context);
  await tick();
  assert.equal(h.el('#reader').textContent,
    ['  indented', '', '  ', '', 'next', '', '', '  final'].join('\n'));
});

test('successful empty history replaces Loading and later output appears', async () => {
  const h = frontend({ history: '' });
  await tick();
  vm.runInContext("openTerm('a')", h.context);
  await tick();
  assert.equal(h.el('#reader').textContent, 'No output yet.');
  assert.equal(h.el('#connection-state').textContent, 'Connected');
  h.setHistory('First response\nPrompt>');
  await vm.runInContext('pullReader()', h.context);
  assert.equal(h.el('#reader').textContent, 'First response\nPrompt>');
});

test('drafts and delayed send completion stay with their original session', async () => {
  const h = frontend();
  await tick();
  vm.runInContext("openTerm('a')", h.context);
  h.el('#input').value = 'message A'; h.el('#input').oninput();
  const send = h.el('#input-row').onsubmit({ preventDefault() {} });
  await tick();
  vm.runInContext("openTerm('b')", h.context);
  h.el('#input').value = 'message B'; h.el('#input').oninput();
  h.finishSend(); await send;
  assert.equal(vm.runInContext("composer('a').draft", h.context), '');
  assert.equal(h.el('#input').value, 'message B');
  vm.runInContext("openTerm('a')", h.context);
  assert.equal(h.el('#input').value, '');
  vm.runInContext("openTerm('b')", h.context);
  assert.equal(h.el('#input').value, 'message B');
});

test('upload completion remains attached to the original session', async () => {
  const h = frontend();
  await tick();
  vm.runInContext("openTerm('a')", h.context);
  h.el('#file').files = [{ name: 'one.txt', size: 4 }];
  const upload = h.el('#file').onchange();
  await tick();
  vm.runInContext("openTerm('b')", h.context);
  h.uploads[0].complete('/tmp/a/one.txt'); await upload;
  assert.equal(h.el('#attach-row').hidden, true);
  vm.runInContext("openTerm('a')", h.context);
  assert.equal(h.el('#attach-row').hidden, false);
  assert.equal(h.el('#attach-row').children.length, 1);
});

test('stalled upload times out, keeps the draft and frees Send in its own session', async () => {
  const h = frontend();
  await tick();
  vm.runInContext("openTerm('a')", h.context);
  h.el('#input').value = 'Draft survives'; h.el('#input').oninput();
  h.el('#file').files = [{ name: 'stalled.txt', size: 4 }];
  const upload = h.el('#file').onchange();
  await tick();
  assert.equal(h.uploads[0].timeout, 60000);
  vm.runInContext("openTerm('b')", h.context);
  h.el('#input').value = 'B draft'; h.el('#input').oninput();
  h.uploads[0].timeoutNow(); await upload;
  assert.equal(h.el('#input').value, 'B draft');
  assert.equal(h.el('#attach-row').hidden, true);
  vm.runInContext("openTerm('a')", h.context);
  assert.equal(h.el('#input').value, 'Draft survives');
  assert.equal(h.el('#attach-row').hidden, true);
  assert.match(h.el('#delivery').textContent, /Upload failed: timed out/);
  const send = h.el('#input-row').onsubmit({ preventDefault() {} });
  await tick();
  assert.equal(h.calls.filter((c) => c.path === '/api/sessions/a/keys').length, 1);
  h.finishSend(); await send;
  assert.equal(h.el('#input').value, '');
});

test('canceled upload aborts quietly and a new attachment can be sent', async () => {
  const h = frontend();
  await tick();
  vm.runInContext("openTerm('a')", h.context);
  h.el('#input').value = 'With file'; h.el('#input').oninput();
  h.el('#file').files = [{ name: 'old.txt', size: 4 }];
  const first = h.el('#file').onchange();
  await tick();
  h.el('#attach-row').children[0].children[1].click();
  await first;
  assert.equal(h.uploads[0].aborted, true);
  assert.equal(h.el('#attach-row').hidden, true);
  assert.equal(h.el('#delivery').hidden, true);
  h.el('#file').files = [{ name: 'new.txt', size: 4 }];
  const retry = h.el('#file').onchange();
  await tick();
  h.uploads[1].complete('/tmp/a/new.txt'); await retry;
  const send = h.el('#input-row').onsubmit({ preventDefault() {} });
  await tick();
  const request = h.calls.find((c) => c.path === '/api/sessions/a/keys');
  assert.match(JSON.parse(request.opts.body).text, /With file\n\/tmp\/a\/new.txt/);
  h.finishSend(); await send;
  assert.equal(h.el('#attach-row').hidden, true);
});

test('stalled transcription times out without changing the session draft', async () => {
  const h = frontend({ voiceStall: true });
  await tick();
  vm.runInContext("openTerm('a')", h.context);
  h.el('#input').value = 'Typed first'; h.el('#input').oninput();
  await h.el('#mic-btn').click();
  h.el('#mic-btn').click();
  const timer = h.timers.find((t) => t.ms === 60000 && !t.canceled);
  assert.ok(timer);
  timer.fn(); await tick();
  assert.equal(h.el('#input').value, 'Typed first');
  assert.equal(h.el('#mic-btn').disabled, true, 'recording retained until check or discard');
  assert.match(h.el('#delivery').textContent, /Transcription timed out/);
  assert.equal(vm.runInContext("dictations.get('a').blob.size", h.context), 15);
});

test('transcription timeout also covers a stalled response body', async () => {
  const h = frontend({ voiceBodyStall: true });
  await tick();
  vm.runInContext("openTerm('a')", h.context);
  await h.el('#mic-btn').click();
  h.el('#mic-btn').click();
  await tick(); // Let fetch headers resolve so JSON body consumption has begun.
  const timer = h.timers.find((t) => t.ms === 60000 && !t.canceled);
  assert.ok(timer);
  timer.fn(); await tick();
  assert.equal(h.el('#mic-btn').disabled, true, 'recording retained until check or discard');
  assert.match(h.el('#delivery').textContent, /Transcription timed out/);
  assert.equal(vm.runInContext("dictations.get('a').blob.size", h.context), 15);
});

test('failed send retains the draft and failed end keeps the session open', async () => {
  const h = frontend({ failSend: true, failEnd: true });
  await tick();
  vm.runInContext("openTerm('a')", h.context);
  h.el('#input').value = 'keep this'; h.el('#input').oninput();
  const send = h.el('#input-row').onsubmit({ preventDefault() {} });
  await tick(); h.finishSend(); await send;
  assert.equal(h.el('#input').value, 'keep this');
  assert.match(h.el('#delivery').textContent, /unconfirmed/);
  h.el('#kill-btn').click();
  await h.el('#kill-btn').click();
  assert.equal(vm.runInContext('current', h.context), 'a');
  assert.equal(h.el('#term-view').hidden, false);
  assert.match(h.el('#delivery').textContent, /End unconfirmed/);
});

test('project identity is spoken plainly while the internal name remains in the title', () => {
  const h = frontend();
  vm.runInContext("projectsRoot = '/example/projects'; renderTermIdentity({ name: 'codex-agent-cockpit-1234', lane: 'codex', project: '/example/projects/agent-cockpit', status: 'working' }, 'codex-agent-cockpit-1234')", h.context);
  assert.equal(h.el('#t-name').textContent, 'agent-cockpit');
  assert.equal(h.el('#t-name')['aria-label'], 'agent-cockpit');
  assert.match(h.el('#t-name').title, /codex-agent-cockpit-1234/);
  assert.equal(h.el('#t-context').textContent, 'Codex');
});

test('late socket and terminal events cannot cross into another session or a reopened view', () => {
  const h = frontend();
  vm.runInContext("openTerm('a'); setMode('live')", h.context);
  const aTerm = h.terminals[0], aSocket = h.sockets[0];
  const oldA = { open: aSocket.onopen, message: aSocket.onmessage, close: aSocket.onclose, input: aTerm.input };
  aSocket.readyState = 1;
  oldA.open(); oldA.message({ data: 'A output' }); oldA.input('A input');
  assert.deepEqual(aTerm.writes, ['A output']);
  assert.deepEqual(aSocket.sent.at(-1), { t: 'in', d: 'A input' });

  vm.runInContext("openTerm('b')", h.context);
  const bTerm = h.terminals[1], bSocket = h.sockets[1];
  oldA.open(); oldA.message({ data: 'late A' }); oldA.close(); oldA.input('late A input');
  assert.deepEqual(bTerm.writes, []);
  assert.deepEqual(bSocket.sent, []);
  assert.equal(h.el('#connection-state').dataset.state, 'reconnecting');
  assert.equal(h.sockets.length, 2);

  bSocket.readyState = 1;
  bSocket.onopen(); bSocket.onmessage({ data: 'B output' }); bTerm.input('B input');
  assert.deepEqual(bTerm.writes, ['B output']);
  assert.deepEqual(bSocket.sent.at(-1), { t: 'in', d: 'B input' });
  const oldB = { open: bSocket.onopen, message: bSocket.onmessage, close: bSocket.onclose, input: bTerm.input };
  vm.runInContext("openTerm('b')", h.context);
  const reopened = h.terminals[2], reopenedSocket = h.sockets[2];
  oldB.open(); oldB.message({ data: 'late B' }); oldB.close(); oldB.input('late B input');
  assert.deepEqual(reopened.writes, []);
  assert.deepEqual(reopenedSocket.sent, []);
  assert.equal(h.sockets.length, 3);
});

test('Read and Live switches reject events from disposed terminals', () => {
  const h = frontend();
  vm.runInContext("openTerm('a'); setMode('live')", h.context);
  const oldTerm = h.terminals[0], oldSocket = h.sockets[0];
  const oldMessage = oldSocket.onmessage, oldInput = oldTerm.input;
  vm.runInContext("setMode('read'); setMode('live')", h.context);
  const currentTerm = h.terminals[1], currentSocket = h.sockets[1];
  oldMessage({ data: 'stale output' }); oldInput('stale input');
  assert.deepEqual(currentTerm.writes, []);
  assert.deepEqual(currentSocket.sent, []);
  currentSocket.readyState = 1;
  currentSocket.onmessage({ data: 'fresh output' }); currentTerm.input('fresh input');
  assert.deepEqual(currentTerm.writes, ['fresh output']);
  assert.deepEqual(currentSocket.sent.at(-1), { t: 'in', d: 'fresh input' });
});

test('active close reconnects once, while a superseded retry cannot duplicate a socket', () => {
  const h = frontend();
  vm.runInContext("openTerm('a'); setMode('live')", h.context);
  const first = h.sockets[0];
  first.readyState = 3; first.onclose();
  const retry = h.timers.find((t) => t.ms === 1000 && !t.canceled);
  assert.ok(retry);
  vm.runInContext("connect('a'); connect('a')", h.context);
  assert.equal(h.sockets.length, 2);
  first.onopen(); first.onmessage({ data: 'late closed socket' }); first.onclose();
  assert.deepEqual(h.terminals[0].writes, []);
  assert.equal(h.el('#connection-state').dataset.state, 'reconnecting');
  retry.fn(); // A queued callback may run despite cancellation.
  assert.equal(h.sockets.length, 2);
  const second = h.sockets[1];
  second.readyState = 1; second.onopen();
  second.readyState = 3; second.onclose();
  const nextRetry = h.timers.findLast((t) => t.ms === 1000 && !t.canceled);
  nextRetry.fn();
  assert.equal(h.sockets.length, 3);
});


test('initial history failure reports retrying and recovery updates separate status without announcing transcript', async () => {
  const h = frontend({ historyError: true });
  await tick();
  vm.runInContext("openTerm('a')", h.context);
  await tick();
  assert.match(h.el('#reader').textContent, /unavailable.*Retrying/);
  assert.match(h.el('#reader-state').textContent, /Retrying automatically/);
  assert.equal(h.el('#reader')['aria-busy'], 'false');
  h.setHistoryError(false);
  await vm.runInContext('pullReader()', h.context);
  assert.equal(h.el('#reader-state').textContent, 'No output yet.');
  h.setHistory('Recovered response');
  await vm.runInContext('pullReader()', h.context);
  assert.equal(h.el('#reader').textContent, 'Recovered response');
  assert.equal(h.el('#reader-state').textContent, 'Output available.');
  h.setHistoryError(true);
  await vm.runInContext('pullReader()', h.context);
  assert.equal(h.el('#reader').textContent, 'Recovered response', 'failed poll keeps already captured output');
});

test('oversized composed message including attachment paths keeps draft and never sends', async () => {
  const h = frontend();
  await tick();
  vm.runInContext("openTerm('a'); composer('a').pending.push({name:'sample.txt',path:'/example/sample.txt'})", h.context);
  h.el('#input').value = 'x'.repeat(19990); h.el('#input').oninput();
  await h.el('#input-row').onsubmit({ preventDefault() {} });
  assert.equal(h.calls.filter(c => c.path.endsWith('/keys')).length, 0);
  assert.equal(h.el('#input').value.length, 19990);
  assert.equal(vm.runInContext("composer('a').pending.length", h.context), 1);
  assert.match(h.el('#delivery').textContent, /too long.*including attachment paths/);
  assert.equal(h.el('#send-btn').disabled, false);
});

test('oversized initial prompt keeps draft and never creates a session', async () => {
  const h = frontend();
  await tick();
  h.el('#prompt').value = 'x'.repeat(8001);
  h.el('#start-btn').disabled = false;
  await h.el('#start-btn').click();
  assert.equal(h.calls.filter(c => c.path === '/api/sessions').length, 0);
  assert.equal(h.el('#prompt').value.length, 8001);
  assert.match(h.el('#new-err').textContent, /too long/);
});


test('explicit server length rejection reports not sent and retains the draft', async () => {
  const h = frontend({failSend: true, failSendStatus: 413});
  await tick();
  vm.runInContext("openTerm('a')", h.context);
  h.el('#input').value = 'keep me'; h.el('#input').oninput();
  const send = h.el('#input-row').onsubmit({preventDefault(){}});
  await tick(); h.finishSend(); await send;
  assert.equal(h.el('#input').value, 'keep me');
  assert.match(h.el('#delivery').textContent, /Message not sent.*draft is kept/);
  assert.doesNotMatch(h.el('#delivery').textContent, /unconfirmed/);
});


test('state success cannot mask failed Read capture or retain Live connection during mode change', async () => {
  const h = frontend({historyError:true});
  await tick();
  vm.runInContext("openTerm('a')",h.context);
  await tick();
  assert.equal(h.el('#connection-state').dataset.state,'offline');
  await vm.runInContext('refresh()',h.context);
  assert.equal(h.el('#connection-state').dataset.state,'offline');
  assert.equal(h.el('#t-status').textContent,'Idle', 'successful state does not mask failed capture');
  assert.match(h.el('#reader').textContent,/unavailable/);
  vm.runInContext("setMode('live')",h.context);
  const socket=h.sockets.at(-1); socket.readyState=1; socket.onopen();
  assert.equal(h.el('#connection-state').dataset.state,'connected');
  vm.runInContext("setMode('read')",h.context);
  assert.equal(h.el('#connection-state').dataset.state,'reconnecting');
  await tick();
  assert.equal(h.el('#connection-state').dataset.state,'offline');
  h.setHistoryError(false);
  h.setHistory('Recovered');
  await vm.runInContext('pullReader()',h.context);
  assert.equal(h.el('#connection-state').dataset.state,'connected');
});


test('captured Read geometry accepts immediate scrollback and unchanged polling keeps resize tail following', async () => {
  const h=frontend({history:'Dense output'});
  await tick();
  const reader=h.el('#reader');reader.clientHeight=426;reader.scrollHeight=1000;
  vm.runInContext("openTerm('a')",h.context);await tick();
  reader.clientHeight=437;h.setHistory('Updated dense output');
  await vm.runInContext('pullReader()',h.context);
  reader.scrollTop=50;reader.fire('scroll');
  h.observers.find(o=>o.element===reader).fn();
  assert.equal(reader.scrollTop,50,'capture/status height change cannot erase immediate scrollback');
  h.el('#to-bottom').click();
  reader.clientHeight=180;reader.scrollTop=600;
  await vm.runInContext('pullReader()',h.context);
  assert.equal(reader.scrollTop,1000,'same text polling follows shrink before pending observer');
  h.observers.find(o=>o.element===reader).fn();
  assert.equal(reader.scrollTop,1000);
});


// Exercise actual app handlers with a synthetic HTTP boundary; layout/hit targets live in verify-ui.
async function setupTask(options = {}) {
  const h = frontend({createFlow:true, ...options});
  await tick(); h.el('#new-btn').click(); await tick();
  h.el('#lanes').children.find(b => b.dataset.lane === 'grok').click();
  h.el('#projects').children[0].firstElementChild.click();
  return h;
}

test('setup uses human assistant names, keeps other choices available and retains project while searching', async () => {
  const h = await setupTask();
  assert.deepEqual(h.el('#lanes').children.map(b => b.textContent), ['Grok','Gemini / Antigravity']);
  assert.deepEqual(h.el('#other-lanes').children.map(b => b.textContent), ['Claude','Codex','Terminal']);
  h.el('#project-filter').value = 'Beta'; h.el('#project-filter').oninput();
  assert.equal(h.el('#projects').children.length,1);
  assert.match(h.el('#selected-project').textContent,/Alpha project/);
  assert.equal(h.el('#start-btn').disabled,false);
  assert.equal(h.calls.filter(c=>c.path === '/api/sessions').length,0);
});

test('failed create retains project, assistant and draft, with safe uncertain-delivery guidance', async () => {
  const h = await setupTask();
  h.el('#prompt').value = 'Please help in Alpha'; h.setup.createError = true;
  await h.el('#start-btn').click();
  const request = h.calls.find(c=>c.path === '/api/sessions');
  assert.deepEqual(JSON.parse(request.opts.body),{lane:'grok',project:'/example/alpha',prompt:'Please help in Alpha'});
  assert.equal(h.el('#prompt').value,'Please help in Alpha');
  assert.match(h.el('#selected-project').textContent,/Alpha project/);
  assert.equal(h.el('#lanes').children[0]['aria-pressed'],'true');
  assert.equal(h.el('#start-btn').disabled,false);
  assert.match(h.el('#new-err').textContent,/Check Your tasks before trying again/);
  assert.doesNotMatch(h.el('#new-err').textContent,/unavailable/);
});

test('project refetch failure and inline retry preserve choices and first message', async () => {
  const h = await setupTask();
  h.el('#prompt').value = 'Retained draft';
  h.setup.projectError = true; h.el('#new-btn').click(); await tick();
  assert.equal(h.el('#retry-projects').hidden,false);
  assert.equal(h.el('#start-btn').disabled,true);
  assert.match(h.el('#selected-project').textContent,/Alpha project/);
  h.setup.projectError = false; await h.el('#retry-projects').click();
  assert.equal(h.el('#retry-projects').hidden,true);
  assert.equal(h.el('#start-btn').disabled,false);
  assert.equal(h.el('#prompt').value,'Retained draft');
});

test('Gemini choice posts agy and a late successful create cannot replace another view', async () => {
  const h = await setupTask();
  h.el('#lanes').children.find(b=>b.dataset.lane==='agy').click();
  h.el('#prompt').value = 'Gemini task'; h.setup.holdCreate = true;
  const launch = h.el('#start-btn').click(); await tick();
  assert.deepEqual(JSON.parse(h.calls.find(c=>c.path==='/api/sessions').opts.body), {lane:'agy',project:'/example/alpha',prompt:'Gemini task'});
  vm.runInContext("show('list')",h.context);
  h.setup.finishCreate(); await launch;
  assert.equal(h.el('#list-view').hidden,false);
  assert.equal(h.el('#term-view').hidden,true);
});

test('Terminal launches without a prompt and keeps a draft for returning to an assistant', async () => {
  const h = await setupTask();
  h.el('#prompt').value = 'Keep for Grok';
  h.el('#other-lanes').children.find(b=>b.dataset.lane==='shell').click();
  assert.equal(h.el('#prompt').disabled,true);
  await h.el('#start-btn').click();
  assert.deepEqual(JSON.parse(h.calls.find(c=>c.path==='/api/sessions').opts.body), {lane:'shell',project:'/example/alpha',prompt:''});
  h.el('#new-btn').click(); await tick();
  h.el('#lanes').children.find(b=>b.dataset.lane==='grok').click();
  assert.equal(h.el('#prompt').disabled,false);
  assert.equal(h.el('#prompt').value,'Keep for Grok');
});


test('opening setup before initial state arrives fills assistant choices when state recovers', async () => {
  const h = frontend({createFlow:true});
  h.el('#new-btn').click();
  assert.equal(h.el('#lanes').children.length,0);
  await tick();
  assert.deepEqual(h.el('#lanes').children.map(b=>b.textContent),['Grok','Gemini / Antigravity']);
});

test('an assistant can open without a first message', async () => {
  const h = await setupTask();
  await h.el('#start-btn').click();
  assert.deepEqual(JSON.parse(h.calls.find(c=>c.path==='/api/sessions').opts.body),{lane:'grok',project:'/example/alpha',prompt:''});
  assert.equal(h.el('#term-view').hidden,false);
});


const startCalls = h => h.calls.filter(c => c.path === '/api/sessions');
const startBody = h => JSON.parse(startCalls(h).at(-1).opts.body);
const storageKey = 'cockpit-pending-start-v1';
const pendingFixture = () => ({ version: 1, created: Date.now(), draft: 'Original task', filter: 'Alpha',
  request: {lane:'grok',project:'/example/alpha',prompt:'Original task',requestId:'original_request_123456789'} });
const separateTask = h => { h.el('#different-task').click(); h.el('#confirm-different').click(); };

test('response loss checks the same immutable request, with no duplicate automatic POST', async () => {
  const h = await setupTask({startRecovery:true});
  h.el('#prompt').value = 'Original task'; h.setup.loseResponse = true;
  await h.el('#start-btn').click();
  const original = startBody(h);
  assert.match(original.requestId,/^[a-f0-9]{48}$/);
  assert.equal(h.savedStarts.size,1);
  assert.equal(h.el('#start-btn').textContent,'Check start');
  assert.equal(h.el('#prompt').disabled,true);
  assert.equal(h.el('#project-filter').disabled,true);
  assert.ok(h.el('#lanes').children.every(b=>b.disabled));
  assert.ok(h.el('#projects').children.every(li=>li.firstElementChild.disabled));
  assert.match(h.el('#pending-info').textContent,/24 hours/);
  // Even synthetic/programmatic input changes cannot alter the captured request.
  h.el('#prompt').value = 'Changed task'; h.el('#prompt').oninput();
  h.el('#lanes').children.find(b=>b.dataset.lane==='agy').click();
  h.el('#projects').children[1].firstElementChild.click();
  await vm.runInContext('refresh()',h.context);
  assert.equal(startCalls(h).length,1,'polling cannot retry a start');
  h.setup.loseResponse = false;
  await h.el('#start-btn').click();
  assert.deepEqual(startBody(h),original);
  assert.equal(startCalls(h)[1].opts.body,startCalls(h)[0].opts.body,'wire body is unchanged');
  assert.equal(h.savedStarts.size,0);
  assert.equal(h.el('#prompt').value,'Changed task','confirmation cannot clear a newer draft');
  assert.equal(h.el('#start-state').textContent,'Task opened.');
});

test('reload restores pending choices and draft without sending; explicit check uses original ID', async () => {
  const h = await setupTask({startRecovery:true});
  h.el('#prompt').value = 'Original task'; h.el('#project-filter').value = 'Alpha';
  h.setup.loseResponse = true; await h.el('#start-btn').click();
  const original = startBody(h);
  const restored = frontend({createFlow:true,startRecovery:true,savedStarts:h.savedStarts});
  await tick(); restored.el('#new-btn').click(); await tick();
  assert.equal(restored.el('#prompt').value,'Original task');
  assert.equal(restored.el('#project-filter').value,'Alpha');
  assert.equal(restored.el('#lanes').children[0]['aria-pressed'],'true');
  assert.match(restored.el('#selected-project').textContent,/Alpha project/);
  assert.equal(restored.el('#prompt').disabled,true);
  assert.equal(startCalls(restored).length,0);
  await restored.el('#start-btn').click();
  assert.deepEqual(startBody(restored),original);
  assert.equal(restored.el('#prompt').value,'');
  assert.equal(restored.savedStarts.size,0);
});

test('different task requires an explained explicit choice, then generates a fresh ID only on launch', async () => {
  const h = await setupTask({startRecovery:true});
  h.setup.loseResponse = true; h.el('#prompt').value = 'First task';
  await h.el('#start-btn').click(); const old = startBody(h);
  h.el('#different-task').click();
  assert.equal(h.el('#different-confirm').hidden,false);
  assert.equal(startCalls(h).length,1);
  h.el('#keep-start').click();
  assert.equal(h.el('#different-confirm').hidden,true);
  assert.equal(h.el('#prompt').disabled,true);
  separateTask(h);
  assert.equal(h.el('#prompt').disabled,false);
  assert.equal(h.savedStarts.size,0);
  assert.equal(startCalls(h).length,1);
  h.el('#prompt').value = 'Second task'; h.setup.loseResponse = false;
  await h.el('#start-btn').click();
  assert.notEqual(startBody(h).requestId,old.requestId);
  assert.equal(startBody(h).prompt,'Second task');
});

test('malformed, stale, oversized or unexpected pending storage is discarded safely without POST', async () => {
  const stale = pendingFixture(); stale.created -= 25 * 60 * 60 * 1000;
  const future = pendingFixture(); future.created += 120000;
  const badId = pendingFixture(); badId.request.requestId = 'invalid';
  const changed = pendingFixture(); changed.draft = 'Different prompt';
  const extras = pendingFixture(); extras.token = 'never accepted';
  const badLane = pendingFixture(); badLane.request.lane = '__proto__';
  const longPrompt = pendingFixture(); longPrompt.request.prompt = longPrompt.draft = 'x'.repeat(8001);
  for (const raw of ['{broken', 'null', 'x'.repeat(131073), ...[stale,future,badId,changed,extras,badLane,longPrompt].map(JSON.stringify)]) {
    const savedStarts = new Map([[storageKey,raw]]);
    const h = frontend({createFlow:true,startRecovery:true,savedStarts});
    await tick(); h.el('#new-btn').click(); await tick();
    assert.equal(startCalls(h).length,0);
    assert.equal(savedStarts.size,0);
    assert.equal(h.el('#prompt').value,'');
    assert.match(h.el('#pending-info').textContent,/unavailable or expired.*Check Your tasks/);
  }
});

test('storage denial keeps in-memory checking and truthfully warns that reload recovery is unavailable', async () => {
  const h = await setupTask({startRecovery:true,storageDenied:true});
  h.el('#prompt').value='Memory only'; h.setup.loseResponse=true;
  await h.el('#start-btn').click(); const first = startBody(h);
  assert.match(h.el('#pending-info').textContent,/Reload recovery is unavailable.*Keep this page open/);
  assert.doesNotMatch(h.el('#pending-info').textContent,/Saved in this tab/);
  h.setup.loseResponse=false; await h.el('#start-btn').click();
  assert.deepEqual(startBody(h),first);
});

test('missing secure randomness never falls back to a weak ID or sends a request', async () => {
  const h = await setupTask({startRecovery:true,cryptoDenied:true});
  h.el('#prompt').value='Keep me'; await h.el('#start-btn').click();
  assert.equal(startCalls(h).length,0);
  assert.equal(h.el('#prompt').value,'Keep me');
  assert.match(h.el('#new-err').textContent,/Can’t prepare a safe start/);
});

test('capability absence keeps legacy failures honest and cannot check a restored ID on an old server', async () => {
  const h = await setupTask(); h.setup.loseResponse = true;
  await h.el('#start-btn').click();
  assert.equal(startBody(h).requestId,undefined);
  assert.notEqual(h.el('#start-btn').textContent,'Check start');
  assert.match(h.el('#start-capability').textContent,/Start checks aren’t available/);
  assert.match(h.el('#new-err').textContent,/Check Your tasks before trying again/);
  assert.doesNotMatch(h.el('#new-err').textContent,/won’t open a second/);
  const restored = frontend({createFlow:true,savedStarts:new Map([[storageKey,JSON.stringify(pendingFixture())]])});
  await tick(); restored.el('#new-btn').click(); await tick();
  assert.equal(restored.el('#start-btn').disabled,true);
  assert.match(restored.el('#pending-info').textContent,/can’t safely check/);
  assert.equal(startCalls(restored).length,0);
});

test('START errors retain identity, expose recovery guidance and never silently start anew', async () => {
  for (const [code, pattern, disabled] of [
    ['START_UNCONFIRMED',/Check start.*original request/,false],
    ['START_SESSION_ENDED',/has ended.*won’t restart/,true],
    ['START_REQUEST_MISMATCH',/different details.*Check Your tasks/,true],
    ['START_INVALID_REQUEST_ID',/couldn’t use.*Check Your tasks/,true],
  ]) {
    const h = await setupTask({startRecovery:true});
    h.setup.errorCode=code;
    h.setup.errorStatus=code==='START_INVALID_REQUEST_ID'?400:409;
    await h.el('#start-btn').click();
    assert.match(h.el('#new-err').textContent,pattern);
    assert.equal(h.el('#start-btn').disabled,disabled);
    assert.equal(h.savedStarts.size,1);
    assert.equal(startCalls(h).length,1);
    assert.equal(JSON.parse(h.savedStarts.get(storageKey)).request.requestId,startBody(h).requestId);
    const surfaced = await vm.runInContext("post('/api/sessions', pendingStart.request).catch(e => ({code:e.code,requestId:e.requestId,sessionName:e.sessionName,status:e.status}))",h.context);
    assert.equal(surfaced.code,code); assert.equal(surfaced.requestId,startBody(h).requestId);
    assert.equal(surfaced.sessionName,'synthetic-created');
  }
});

test('success missing matching requestId stays pending, never implying readiness', async () => {
  const h = await setupTask({startRecovery:true}); h.setup.badReply=true;
  h.el('#prompt').value='Original'; await h.el('#start-btn').click();
  assert.equal(h.el('#term-view').hidden,true);
  assert.equal(h.savedStarts.size,1);
  assert.equal(h.el('#prompt').value,'Original');
  assert.match(h.el('#new-err').textContent,/Start wasn’t confirmed/);
});

test('late completion cannot navigate away, clear a newer draft or remove a newer pending launch', async () => {
  const h = await setupTask({startRecovery:true});
  h.el('#prompt').value='Old task'; h.setup.holdCreate=true;
  const oldLaunch=h.el('#start-btn').click(); await tick();
  const finishOld=h.setup.finishCreate, oldId=startBody(h).requestId;
  separateTask(h);
  h.el('#prompt').value='New task'; h.el('#prompt').oninput();
  const newLaunch=h.el('#start-btn').click(); await tick();
  const finishNew=h.setup.finishCreate, newId=startBody(h).requestId;
  assert.notEqual(newId,oldId);
  vm.runInContext("show('list')",h.context);
  finishOld(); await oldLaunch;
  assert.equal(h.el('#list-view').hidden,false);
  assert.equal(h.el('#prompt').value,'New task');
  assert.equal(JSON.parse(h.savedStarts.get(storageKey)).request.requestId,newId);
  finishNew(); await newLaunch;
  assert.equal(h.el('#list-view').hidden,false);
  assert.equal(h.el('#prompt').value,'New task','late success preserves the draft after leaving setup');
  assert.equal(h.savedStarts.size,0);
});


test('checking an existing pending launch does not depend on a fresh project list or editable choices', async () => {
  const h=await setupTask({startRecovery:true}); h.setup.loseResponse=true;
  h.el('#prompt').value='Original'; await h.el('#start-btn').click(); const original=startBody(h);
  h.setup.projectError=true; h.el('#new-btn').click(); await tick();
  assert.equal(h.el('#retry-projects').hidden,false);
  assert.equal(h.el('#start-btn').disabled,false,'the original request remains checkable');
  h.setup.loseResponse=false; await h.el('#start-btn').click();
  assert.deepEqual(startBody(h),original);
});

test('capability loss disables an existing check until the server advertises support again', async () => {
  const h=await setupTask({startRecovery:true}); h.setup.loseResponse=true;
  await h.el('#start-btn').click(); const original=startBody(h);
  h.setup.startRecovery=false; await vm.runInContext('refresh()',h.context);
  assert.equal(h.el('#start-btn').disabled,true);
  assert.doesNotMatch(h.el('#pending-info').textContent,/won’t open a second/);
  h.setup.startRecovery=true; await vm.runInContext('refresh()',h.context);
  assert.equal(h.el('#start-btn').disabled,false);
  h.setup.loseResponse=false; await h.el('#start-btn').click();
  assert.deepEqual(startBody(h),original);
});

test('ordinary start rejection keeps original payload until an explicit different-task choice', async () => {
  const h=await setupTask({startRecovery:true});
  h.el('#prompt').value='Original'; h.setup.createError=true; h.setup.errorStatus=403;
  await h.el('#start-btn').click(); const original=startBody(h);
  assert.equal(h.el('#prompt').disabled,true);
  assert.equal(h.savedStarts.size,1);
  assert.match(h.el('#new-err').textContent,/Could not open this task.*original choices/);
  h.setup.createError=false; await h.el('#start-btn').click();
  assert.deepEqual(startBody(h),original);
});

test('pending Terminal reload keeps the assistant draft while always checking an empty shell prompt', async () => {
  const h=await setupTask({startRecovery:true});
  h.el('#prompt').value='Retained assistant message';
  h.el('#other-lanes').children.find(b=>b.dataset.lane==='shell').click();
  h.setup.loseResponse=true; await h.el('#start-btn').click(); const original=startBody(h);
  assert.equal(original.prompt,'');
  const restored=frontend({createFlow:true,startRecovery:true,savedStarts:h.savedStarts});
  await tick(); restored.el('#new-btn').click(); await tick();
  assert.equal(restored.el('#prompt').value,'Retained assistant message');
  assert.equal(restored.el('#prompt').disabled,true);
  await restored.el('#start-btn').click(); assert.deepEqual(startBody(restored),original);
  assert.equal(restored.el('#startup-note').hidden,true,'shell tasks do not need assistant startup help');
  restored.el('#new-btn').click(); await tick();
  restored.el('#lanes').children.find(b=>b.dataset.lane==='grok').click();
  assert.equal(restored.el('#prompt').value,'Retained assistant message');
  assert.equal(restored.el('#prompt').disabled,false);
});


test('Grok startup Read removes centering only and preserves the complete warning and choices', () => {
  const h = frontend();
  const screen = '         Do you trust the contents of this directory?\n      /example/project\n    Grok Build may run or modify contents in this directory,\n         posing security risks.\n       Yes, proceed                 y\n       No, quit                     n';
  h.context.startupScreen = screen;
  const readable = vm.runInContext("compactReadHistory(startupScreen, 'grok')", h.context);
  assert.equal(readable, screen.split('\n').map(line => line.trimStart()).join('\n'));
  assert.equal(vm.runInContext("compactReadHistory(startupScreen, 'agy')", h.context), screen);
  assert.equal(vm.runInContext("compactReadHistory('    example code', 'grok')", h.context), '    example code');
});


const ownedConversation = messages => ({ source: 'conversation', messages });
const shownMessages = [
  { id: 'u1', role: 'user', text: 'A synthetic first message' },
  { id: 'a1', role: 'assistant', text: 'A synthetic reply' },
];
const openNewAssistant = h => vm.runInContext("refresh = async () => {}; openTerm('a', {name:'a',lane:'grok',status:'idle'}, true)", h.context);

test('generic startup help is dismissible per task and terminal replies never establish acceptance', async () => {
  const h = frontend({history: 'Assistant: Ready. First message accepted.'});
  await tick(); openNewAssistant(h); await tick();
  assert.equal(h.el('#startup-note').hidden,false);
  assert.equal(h.el('#output-source').textContent,'Terminal output');
  assert.equal(h.el('#reader').textContent,'Assistant: Ready. First message accepted.');
  assert.equal(h.el('#reader').children.length,0,'terminal text is never fabricated into chat messages');
  assert.equal(h.el('#answer-start').hidden,true);
  assert.equal(h.el('#reader-tools').hidden,true,'fallback labeling adds no reader toolbar');
  assert.equal(h.el('#dismiss-startup').hidden,false);
  h.el('#dismiss-startup').click();
  assert.equal(h.el('#startup-note').hidden,true);
  vm.runInContext("openTerm('b', {name:'b',lane:'agy',status:'idle'}, true)",h.context); await tick();
  assert.equal(h.el('#startup-note').hidden,false,'a separate task owns separate help');
  openNewAssistant(h); await tick();
  assert.equal(h.el('#startup-note').hidden,true,'reopening cannot undo dismissal');
});

test('owned displayed messages remove generic help without changing status, drafts or delivery feedback', async () => {
  for (const messages of [shownMessages.slice(0,1),shownMessages.slice(1),shownMessages]) {
    const h=frontend({history:ownedConversation(messages)}); await tick(); openNewAssistant(h);
    h.el('#input').value='A later unsent message'; h.el('#input').oninput();
    vm.runInContext("sessionDelivery('a', 'Delivery unconfirmed. Check output before retrying.', true)",h.context);
    await tick();
    assert.equal(h.el('#startup-note').hidden,true);
    assert.equal(h.el('#output-source').textContent,'Conversation');
    assert.equal(h.el('#reader')['aria-label'],'Conversation');
    assert.equal(h.el('#reader').querySelectorAll('.message').length,messages.length);
    assert.equal(h.el('#t-status').textContent,'Idle','displayed messages never establish readiness');
    assert.equal(h.el('#input').value,'A later unsent message');
    assert.match(h.el('#delivery').textContent,/Delivery unconfirmed/);
    assert.equal(h.el('#answer-start').hidden,!messages.some(m=>m.role==='assistant'));
    h.setHistory('A later terminal setup question?'); await vm.runInContext('pullReader()',h.context);
    assert.equal(h.el('#output-source').textContent,'Terminal output');
    assert.equal(h.el('#reader').textContent,'A later terminal setup question?');
    assert.equal(h.el('#reader').children.length,0);
    assert.equal(h.el('#answer-start').hidden,true);
    assert.equal(h.el('#startup-note').hidden,true,'known displayed history does not need generic startup help again');
  }
});

test('empty conversation and a successful send keep generic help; no acknowledgement proves message acceptance', async () => {
  const h=frontend({history:ownedConversation([])}); await tick(); openNewAssistant(h); await tick();
  assert.equal(h.el('#startup-note').hidden,false);
  h.el('#input').value='Synthetic message'; h.el('#input').oninput();
  const sending=h.el('#input-row').onsubmit({preventDefault(){}}); await tick(); h.finishSend(); await sending;
  assert.equal(h.el('#startup-note').hidden,false);
  assert.equal(h.el('#t-status').textContent,'Idle');
  assert.equal(h.el('#reader').querySelectorAll('.message').length,0);
  assert.equal(h.el('#delivery').textContent,'Sent to terminal');
});

test('Needs you preserves the raw setup question and opens Respond controls only on explicit action', async () => {
  const question='Do you trust the contents of this project?\n> Yes, I trust this folder\n  No, exit\n↑/↓ Navigate · enter Confirm';
  const h=frontend({history:question}); await tick(); openNewAssistant(h); await tick();
  h.el('#dismiss-startup').click();
  const before=h.calls.filter(c=>c.path.endsWith('/keys')).length;
  vm.runInContext("renderTermIdentity({name:'a',lane:'agy',status:'needs-you'})",h.context); await tick();
  assert.equal(h.el('#startup-note').hidden,false,'generic dismissal cannot suppress attention guidance');
  assert.equal(h.el('#dismiss-startup').hidden,true);
  assert.equal(h.el('#startup-respond').hidden,false);
  assert.match(h.el('#startup-help').textContent,/Review.*question.*Respond/);
  assert.equal(h.el('#keys-toggle').textContent,'Respond');
  assert.equal(h.el('#reader').textContent,question);
  assert.equal(h.el('#keys').classList.contains('short-open'),false);
  h.el('#startup-respond').click();
  assert.equal(h.el('#keys').classList.contains('short-open'),true);
  assert.equal(h.el('#keys-toggle')['aria-expanded'],'true');
  assert.equal(h.calls.filter(c=>c.path.endsWith('/keys')).length,before,'opening Respond never answers a question');
  assert.equal(h.el('#reader').textContent,question);
  vm.runInContext("renderTermIdentity({name:'a',lane:'agy',status:'working'})",h.context);
  assert.equal(h.el('#startup-note').hidden,true);
  assert.equal(h.el('#keys-toggle').textContent,'Controls');
});

test('output labels follow Read/Live and selected-task guards ignore old source responses', async () => {
  const h=frontend({history:ownedConversation(shownMessages)}); await tick(); openNewAssistant(h); await tick();
  assert.equal(h.el('#output-source').textContent,'Conversation');
  vm.runInContext("setMode('live')",h.context);
  assert.equal(h.el('#output-source').textContent,'Live terminal');
  assert.equal(h.el('#answer-start').hidden,true);
  const fetch=h.context.fetch;
  let finishHistory;
  h.context.fetch=async (path,opts)=>path.includes('/history') ? new Promise(resolve=>{finishHistory=resolve;}) : fetch(path,opts);
  vm.runInContext("setMode('read')",h.context); await tick();
  assert.equal(h.el('#output-source').textContent,'Loading output…');
  const finishA=finishHistory;
  vm.runInContext("openTerm('b', {name:'b',lane:'agy',status:'needs-you'})",h.context); await tick();
  // Capture b's completion separately; an old a response must not relabel this task.
  const finishB=finishHistory;
  finishB({ok:true,headers:{get:()=> 'text/plain'},text:async()=> 'A setup question for b'}); await tick();
  assert.equal(h.el('#output-source').textContent,'Terminal output');
  assert.equal(h.el('#startup-note').hidden,false);
  finishA({ok:true,headers:{get:()=> 'application/json'},json:async()=> ownedConversation(shownMessages)}); await tick();
  assert.equal(h.el('#output-source').textContent,'Terminal output');
  assert.equal(h.el('#reader').textContent,'A setup question for b');
  assert.equal(h.el('#startup-note').hidden,false);
});


test('Respond navigation stays open; Enter closes only after success and rejected keys remain retryable', async () => {
  for (const failSend of [false,true]) {
    const h=frontend({failSend,failSendStatus:400,history:'A setup question'}); await tick(); openNewAssistant(h); await tick();
    vm.runInContext("renderTermIdentity({name:'a',lane:'grok',status:'needs-you'})",h.context); await tick();
    h.el('#startup-respond').click();
    const up=h.el('#keys').children.find(b=>b.textContent==='↑');
    const navigation=up.click(); await tick(); h.finishSend(); await navigation;
    assert.equal(h.el('#keys').classList.contains('short-open'),true);
    const enter=h.el('#keys').children.find(b=>b.textContent==='Enter');
    const confirmation=enter.click(); await tick();
    assert.equal(h.el('#keys').classList.contains('short-open'),true,'waits for acknowledged key delivery');
    h.finishSend(); await confirmation;
    assert.equal(h.el('#keys').classList.contains('short-open'),failSend);
    assert.equal(enter.disabled,false);
    if (!failSend) assert.equal(h.context.document.activeElement,h.el('#startup-respond'),'focus returns to the Respond button that opened controls');
    const sent=h.calls.filter(c=>c.path.endsWith('/keys')).map(c=>({key:JSON.parse(c.opts.body).key}));
    assert.deepEqual(sent,[{key:'Up'},{key:'Enter'}],'only explicitly chosen response keys are sent');
  }
});


test('Needs you shows the current raw question even when an owned conversation already exists', async () => {
  const question='Do you trust the contents of this project?\n> Yes, I trust this folder\n  No, exit';
  const h=frontend({history:ownedConversation(shownMessages),terminalHistory:question});
  await tick(); openNewAssistant(h); await tick();
  assert.equal(h.el('#startup-note').hidden,true);
  assert.equal(h.el('#output-source').textContent,'Conversation');
  vm.runInContext("renderTermIdentity({name:'a',lane:'grok',status:'needs-you'})",h.context); await tick();
  await vm.runInContext('pullReader()',h.context);
  assert.equal(h.el('#reader').textContent,question);
  assert.equal(h.el('#output-source').textContent,'Terminal output');
  assert.equal(h.el('#answer-start').hidden,true);
  assert.equal(h.el('#startup-note').hidden,false);
  assert.equal(h.calls.filter(c=>c.path.endsWith('/keys')).length,0);
  vm.runInContext("renderTermIdentity({name:'a',lane:'grok',status:'working'})",h.context); await tick();
  await vm.runInContext('pullReader()',h.context);
  assert.equal(h.el('#output-source').textContent,'Conversation');
  assert.equal(h.el('#reader').querySelectorAll('.message').length,2);
  assert.equal(h.el('#startup-note').hidden,true);
});

test('a conversation response from before Needs you cannot replace the current question', async () => {
  const question='Choose a setup option';
  const h=frontend({history:'Earlier output',terminalHistory:question}); await tick(); openNewAssistant(h); await tick();
  const fetch=h.context.fetch;
  let finishOld;
  h.context.fetch=async (path,opts)=>path.includes('format=reader') ? new Promise(resolve=>{finishOld=resolve;}) : fetch(path,opts);
  const oldPull=vm.runInContext('pullReader()',h.context); await tick();
  vm.runInContext("renderTermIdentity({name:'a',lane:'grok',status:'needs-you'})",h.context); await tick();
  finishOld({ok:true,headers:{get:()=> 'application/json'},json:async()=> ownedConversation(shownMessages)}); await oldPull;
  assert.equal(h.el('#reader').textContent,question, 'raw read proceeds independently of the old conversation');
  await vm.runInContext('pullReader()',h.context);
  assert.equal(h.el('#reader').textContent,question);
  assert.equal(h.el('#output-source').textContent,'Terminal output');
  assert.equal(h.el('#startup-note').hidden,false);
});

// Interruption regressions use the actual HTTP handler and actual tmux input queue.
// Only HTTP/process transports are synthetic; no live sessions or network exist.
const { actionFixture } = require('./helpers/actions-harness');
const keyButton = (h, key) => h.el('#keys').children.find(b => b.dataset.key === key);
const terminalInputs = f => f.machine.calls.filter(c => c[0] === 'send-keys').map(c => [c[c.indexOf('-t') + 1], c.at(-1)]);

test('tap order survives delayed first HTTP arrival; another task proceeds and composer shares the queue', async t => {
  const f = actionFixture(t); let release, held = false;
  const h = frontend({ requestHook: async (url, opts) => {
    if (!held && url === '/api/sessions/a/keys') {
      held = true; await new Promise(r => { release = r; });
    }
    return f.fetch(url, opts);
  } });
  await tick(); vm.runInContext("openTerm('a')", h.context); await tick();
  const up = keyButton(h, 'Up').click();
  const enter = keyButton(h, 'Enter').click();
  h.el('#input').value = 'Composer follows keys'; h.el('#input').oninput();
  const send = h.el('#input-row').onsubmit({ preventDefault() {} });
  await tick();
  assert.equal(h.calls.filter(c => c.path === '/api/sessions/a/keys').length, 1, 'Enter cannot overtake delayed Up');
  vm.runInContext("openTerm('b')", h.context); await tick();
  await keyButton(h, 'Down').click();
  assert.deepEqual(terminalInputs(f), [['=b:', 'Down']], 'other task is independent');
  release(); await Promise.all([up, enter, send]);
  assert.deepEqual(terminalInputs(f), [['=b:', 'Down'], ['=a:', 'Up'], ['=a:', 'Enter'], ['=a:', 'Enter']]);
  const payloads = h.calls.filter(c => c.path === '/api/sessions/a/keys').map(c => JSON.parse(c.opts.body));
  assert.deepEqual(payloads.map(b => b.key || b.text), ['Up', 'Enter', 'Composer follows keys']);
  assert.equal(new Set(payloads.map(b => b.actionId)).size, 3);
  assert.equal(vm.runInContext('current', h.context), 'b');
});

test('lost Enter acknowledgement blocks repeated Enter, cancels queued composer and checks without execution', async t => {
  const f = actionFixture(t); let lost = false, captured;
  const h = frontend({ requestHook: async (url, opts) => {
    const response = await f.fetch(url, opts);
    if (!lost && url.endsWith('/keys')) { lost = true; captured = JSON.parse(opts.body); throw new Error('response lost after execution'); }
    return response;
  } });
  await tick(); vm.runInContext("openTerm('a')", h.context); await tick();
  const enter = keyButton(h, 'Enter').click();
  h.el('#input').value = 'Draft stays'; h.el('#input').oninput();
  const send = h.el('#input-row').onsubmit({ preventDefault() {} });
  await Promise.all([enter, send]);
  assert.match(h.el('#delivery').textContent, /Delivery unconfirmed.*do not repeat Enter/);
  assert.doesNotMatch(h.el('#delivery').textContent, /Key failed/);
  assert.equal(keyButton(h, 'Enter').disabled, true); assert.equal(h.el('#send-btn').disabled, true);
  await keyButton(h, 'Enter').click(); await h.el('#input-row').onsubmit({ preventDefault() {} });
  assert.deepEqual(terminalInputs(f), [['=a:', 'Enter']]);
  assert.equal(h.el('#input').value, 'Draft stays');
  await vm.runInContext('checkDelivery.onclick()', h.context);
  assert.deepEqual(terminalInputs(f), [['=a:', 'Enter']]);
  assert.equal(h.el('#input').value, 'Draft stays', 'cancelled composer was never delivered');
  assert.match(h.el('#delivery').textContent, /Delivery confirmed/);
  const checks = h.calls.filter(c => c.path.endsWith('/keys')).map(c => JSON.parse(c.opts.body));
  assert.deepEqual(checks, [captured, { ...captured, check: true }]);
});

test('uncertain navigation cancels queued Enter and composer; restart checks remain unconfirmed until review', async t => {
  const f = actionFixture(t); let lost = false;
  const h = frontend({ requestHook: async (url, opts) => {
    const response = await f.fetch(url, opts);
    if (!lost && url.endsWith('/keys')) { lost = true; throw new Error('lost acknowledgement'); }
    return response;
  } });
  await tick(); vm.runInContext("openTerm('a')", h.context); await tick();
  const up = keyButton(h, 'Up').click(), enter = keyButton(h, 'Enter').click();
  await Promise.all([up, enter]);
  assert.deepEqual(terminalInputs(f), [['=a:', 'Up']]);
  f.restart(); await vm.runInContext('checkDelivery.onclick()', h.context);
  assert.match(h.el('#delivery').textContent, /still unconfirmed.*server restart/);
  assert.equal(keyButton(h, 'Enter').disabled, true);
  await vm.runInContext('refresh()', h.context);
  assert.equal(keyButton(h, 'Enter').disabled, true, 'polling cannot clear uncertainty');
  vm.runInContext('reviewDelivery.onclick()', h.context);
  assert.match(h.el('#delivery').textContent, /Previous delivery remains unconfirmed/);
  assert.equal(keyButton(h, 'Enter').disabled, false);
  assert.deepEqual(terminalInputs(f), [['=a:', 'Up']], 'review does not send input');
});

test('explicit key rejection cancels queued Enter with definite not-sent feedback', async () => {
  const h = frontend({ failSend: true, failSendStatus: 400 }); await tick();
  vm.runInContext("openTerm('a')", h.context); await tick();
  const up = keyButton(h, 'Up').click(), enter = keyButton(h, 'Enter').click();
  await tick(); h.finishSend(); await Promise.all([up, enter]);
  assert.equal(h.calls.filter(c => c.path.endsWith('/keys')).length, 1);
  assert.match(h.el('#delivery').textContent, /Key not sent/);
  assert.doesNotMatch(h.el('#delivery').textContent, /unconfirmed/);
  assert.equal(keyButton(h, 'Enter').disabled, false);
});

test('lost End response then confirmed absence settles, preserves draft/output and stops stale retries', async t => {
  const f = actionFixture(t); f.machine.screen = 'Last output to keep';
  let lost = false;
  const h = frontend({ requestHook: async (url, opts) => {
    const response = await f.fetch(url, opts);
    if (!lost && url.endsWith('/end')) { lost = true; throw new Error('end response lost'); }
    return response;
  } });
  await tick(); vm.runInContext("openTerm('a')", h.context); await tick();
  h.el('#input').value = 'Unsent draft'; h.el('#input').oninput();
  assert.equal(h.el('#reader').textContent, 'Last output to keep');
  h.el('#kill-btn').click(); await h.el('#kill-btn').click(); await tick();
  await vm.runInContext('refresh()', h.context);
  assert.match(h.el('#t-status').textContent, /Ended.*unavailable/);
  assert.equal(h.el('#input').value, 'Unsent draft');
  assert.equal(h.el('#reader').textContent, 'Last output to keep');
  assert.equal(vm.runInContext('readTimer', h.context), null);
  assert.equal(h.el('#send-btn').disabled, true); assert.equal(keyButton(h, 'Enter').disabled, true);
  assert.equal(h.el('#kill-btn').disabled, true); assert.equal(h.el('#mode-btn').disabled, true);
  assert.doesNotMatch(h.el('#delivery').textContent, /still be running|Retrying/);
  assert.equal(h.el('#conn-note').hidden, true, 'ended notice does not cover retained output');
  assert.match(h.el('#delivery').textContent, /Your draft is kept/);
  const count = h.calls.length;
  await vm.runInContext('pullReader(); connect(current); fitSession()', h.context);
  await keyButton(h, 'Enter').click(); await h.el('#kill-btn').click();
  await h.el('#input-row').onsubmit({ preventDefault() {} });
  assert.equal(h.calls.length, count, 'stale callbacks and task controls do not retry');
});

test('definitive history 404 settles independently of state; ended Live keeps output and suppresses queued reconnect', async () => {
  const h = frontend(); await tick(); vm.runInContext("openTerm('a'); setMode('live')", h.context);
  const socket = h.sockets.at(-1), terminal = h.terminals.at(-1);
  socket.readyState = 1; socket.onopen(); socket.onmessage({ data: 'Saved live output' });
  socket.onclose(); const retry = h.timers.find(t => t.ms === 1000 && !t.canceled);
  vm.runInContext("settleTask('a')", h.context); retry.fn();
  assert.deepEqual(terminal.writes, ['Saved live output']); assert.equal(terminal.disposed, undefined);
  assert.equal(h.sockets.length, 1); assert.equal(vm.runInContext('wsTimer', h.context), null);

  const missing = frontend({ historyError: true, failSendStatus: 404 }); await tick();
  vm.runInContext("openTerm('a')", missing.context); await tick();
  assert.equal(vm.runInContext("endedTasks.has('a')", missing.context), true);
  assert.equal(missing.el('#send-btn').disabled, true);
  assert.doesNotMatch(missing.el('#reader-state').textContent, /Retrying/);
});

test('composer paste/Enter completes before later quick keys on the same task', async t => {
  const f = actionFixture(t); let release, held = false;
  const h = frontend({ requestHook: async (url, opts) => {
    if (!held && url.endsWith('/keys')) { held = true; await new Promise(r => { release = r; }); }
    return f.fetch(url, opts);
  } });
  await tick(); vm.runInContext("openTerm('a')", h.context); await tick();
  h.el('#input').value = 'Message first'; h.el('#input').oninput();
  const send = h.el('#input-row').onsubmit({ preventDefault() {} });
  const up = keyButton(h, 'Up').click(), enter = keyButton(h, 'Enter').click();
  await tick();
  assert.equal(h.calls.filter(c => c.path.endsWith('/keys')).length, 1);
  release(); await Promise.all([send, up, enter]);
  assert.deepEqual(terminalInputs(f), [['=a:', 'Enter'], ['=a:', 'Up'], ['=a:', 'Enter']]);
  assert.equal(h.el('#input').value, '');
});

test('late lost delivery after confirmed absence cannot replace ended feedback or clear the draft', async t => {
  const f = actionFixture(t); let release, reached;
  const pendingResponse = new Promise(r => { reached = r; });
  const h = frontend({ requestHook: async (url, opts) => {
    const response = await f.fetch(url, opts);
    if (url.endsWith('/keys')) { await new Promise(r => { release = r; reached(); }); throw new Error('late response lost'); }
    return response;
  } });
  await tick(); vm.runInContext("openTerm('a')", h.context); await tick();
  h.el('#input').value = 'Keep this draft'; h.el('#input').oninput();
  const send = h.el('#input-row').onsubmit({ preventDefault() {} }); await pendingResponse;
  f.machine.sessions.delete('a'); await vm.runInContext('refresh()', h.context);
  release(); await send;
  assert.equal(h.el('#input').value, 'Keep this draft');
  assert.match(h.el('#delivery').textContent, /Task ended or unavailable/);
  assert.equal(h.el('#send-btn').disabled, true);
  assert.equal(vm.runInContext("actionState('a').uncertain", h.context), null);
});

test('a successful HTTP response with an unmatched receipt cannot release queued Enter', async () => {
  const h = frontend({ requestHook: async url => url.endsWith('/keys') ? {
    ok: true, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, actionId: 'other-action' }),
  } : null });
  await tick(); vm.runInContext("openTerm('a')", h.context); await tick();
  await Promise.all([keyButton(h, 'Up').click(), keyButton(h, 'Enter').click()]);
  assert.equal(h.calls.filter(c => c.path.endsWith('/keys')).length, 1);
  assert.match(h.el('#delivery').textContent, /Delivery unconfirmed/);
  assert.equal(keyButton(h, 'Enter').disabled, true);
  await vm.runInContext('checkDelivery.onclick()', h.context);
  assert.match(h.el('#delivery').textContent, /still unconfirmed.*receipt did not match/);
  assert.equal(keyButton(h, 'Enter').disabled, true);
});

test('reload during in-flight input keeps controls blocked without persisting or resending input', async () => {
  const h = frontend(); await tick(); vm.runInContext("openTerm('a')", h.context); await tick();
  const enter = keyButton(h, 'Enter').click(); await tick();
  const markerKey = 'cockpit-pending-actions-v1';
  assert.deepEqual(JSON.parse(h.savedStarts.get(markerKey)), ['a'], 'marker reserved before acknowledgement');
  const reloaded = frontend({ savedStarts: h.savedStarts }); await tick();
  vm.runInContext("openTerm('a')", reloaded.context); await tick();
  assert.match(reloaded.el('#delivery').textContent, /unconfirmed after reload.*cannot check/);
  assert.equal(keyButton(reloaded, 'Enter').disabled, true);
  assert.equal(reloaded.el('#send-btn').disabled, true);
  assert.equal(reloaded.calls.filter(c => c.path.endsWith('/keys')).length, 0);
  await vm.runInContext('checkDelivery.onclick()', reloaded.context);
  assert.equal(reloaded.calls.filter(c => c.path.endsWith('/keys')).length, 0, 'missing original reference cannot be checked or resent');
  vm.runInContext('reviewDelivery.onclick()', reloaded.context);
  assert.equal(keyButton(reloaded, 'Enter').disabled, false);
  assert.match(reloaded.el('#delivery').textContent, /Previous delivery remains unconfirmed/);
  h.finishSend(); await enter;
});

test('unavailable action recovery storage refuses input before any terminal request', async () => {
  const h = frontend({ storageDenied: true }); await tick(); vm.runInContext("openTerm('a')", h.context); await tick();
  await keyButton(h, 'Enter').click();
  assert.equal(h.calls.filter(c => c.path.endsWith('/keys')).length, 0);
  assert.match(h.el('#delivery').textContent, /Key not sent.*reload recovery is unavailable/);
});

test('a state request begun before opening a task cannot settle that newly opened task as absent', async () => {
  let release, first = true;
  const h = frontend({ requestHook: async url => {
    if (url !== '/api/state' || !first) return null;
    first = false; await new Promise(r => { release = r; });
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ sessions: [], lanes: [], actionEpoch: 'synthetic-epoch' }) };
  } });
  vm.runInContext("openTerm('a')", h.context);
  release(); await tick();
  assert.equal(vm.runInContext("endedTasks.has('a')", h.context), false);
  await vm.runInContext('refresh()', h.context);
  assert.equal(h.el('#send-btn').disabled, false);
});

const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
async function recordClip(h) {
  await h.el('#mic-btn').click(); await h.el('#mic-btn').click(); await tick();
}
function voiceReply(call, state, text) {
  return { requestId: call.opts.headers['X-Dictation-Id'], epoch: call.opts.headers['X-Dictation-Epoch'],
    task: call.opts.headers['X-Dictation-Task'], state, ...(text !== undefined ? { text } : {}) };
}

function heldDictationState() {
  let release;
  const h = frontend({ dictation: true, requestHook: async (path, opts) => {
    if (path === '/api/state' && release) {
      const resume = release;
      release = null;
      return new Promise(resume);
    }
    if (path === '/api/transcribe') return jsonResponse(voiceReply({ opts }, 'pending'));
    if (path.includes('/cancel?')) return jsonResponse({ state: 'cancelled' });
  } });
  h.holdState = sessions => {
    let finish;
    release = resolve => { finish = () => resolve({ ...jsonResponse({
      sessions, lanes: [], actionEpoch: 'synthetic-epoch', dictationEpoch: 'synthetic-voice-epoch',
    }), headers: { get: () => 'application/json' } }); };
    const pending = vm.runInContext('refresh()', h.context);
    return async () => { assert.ok(finish, 'state request reached the hold'); finish(); await pending; };
  };
  return h;
}

test('state from before task B opened cannot end its newer active or uploaded recording', async () => {
  for (const uploaded of [false, true]) {
    const h = heldDictationState(); await tick();
    vm.runInContext("openTerm('a')", h.context); await tick();
    const release = h.holdState([{ name: 'a', status: 'idle' }]);
    vm.runInContext("openTerm('b', { name: 'b', lane: 'grok', status: 'idle' }, true)", h.context);
    h.el('#input').value = 'B draft'; h.el('#input').oninput();
    await h.el('#mic-btn').click();
    if (uploaded) { await h.el('#mic-btn').click(); await tick(); }
    await release();
    assert.equal(vm.runInContext("endedTasks.has('b')", h.context), false);
    assert.equal(h.el('#input').value, 'B draft');
    assert.equal(h.el('#send-btn').disabled, false);
    assert.notEqual(h.el('#connection-state').dataset.state, 'ended');
    assert.equal(h.calls.filter(c => c.path.includes('/cancel?')).length, 0);
    if (uploaded) assert.equal(vm.runInContext("dictations.get('b').blob.size", h.context), 15);
    else assert.equal(vm.runInContext("recTask === 'b' && rec.state === 'recording'", h.context), true);
  }
});

test('old view response cannot end an existing dictation after reopening the same task', async () => {
  const h = heldDictationState(); await tick();
  vm.runInContext("openTerm('a')", h.context); await recordClip(h); await tick();
  const release = h.holdState([]);
  vm.runInContext("openTerm('a')", h.context);
  await release();
  assert.equal(vm.runInContext("endedTasks.has('a')", h.context), false);
  assert.equal(vm.runInContext("dictations.get('a').blob.size", h.context), 15);
  assert.equal(h.calls.filter(c => c.path.includes('/cancel?')).length, 0);
});

test('state response cannot discard a background dictation created after its request began', async () => {
  const h = heldDictationState(); await tick();
  vm.runInContext("openTerm('a')", h.context); await tick();
  const release = h.holdState([{ name: 'a', status: 'idle' }]);
  vm.runInContext("openTerm('b')", h.context); await recordClip(h);
  vm.runInContext("openTerm('c')", h.context);
  await release();
  assert.equal(vm.runInContext("endedTasks.has('b')", h.context), false);
  assert.equal(vm.runInContext("dictations.get('b').blob.size", h.context), 15);
  assert.equal(vm.runInContext("endedTasks.has('c')", h.context), false);
  assert.equal(h.calls.filter(c => c.path.includes('/cancel?')).length, 0);
});

test('authoritative same-view task end still discards active and uploaded recordings', async () => {
  for (const sessions of [[], [{ name: 'a', dead: true }], [{ name: 'a', status: 'exited' }]]) {
    for (const uploaded of [false, true]) {
      const h = heldDictationState(); await tick();
      vm.runInContext("openTerm('a')", h.context); await tick();
      // Begin the request before recording: same-view authority must still apply.
      const release = h.holdState(sessions);
      h.el('#input').value = 'Kept draft'; h.el('#input').oninput();
      await h.el('#mic-btn').click();
      if (uploaded) { await h.el('#mic-btn').click(); await tick(); }
      await release();
      assert.equal(vm.runInContext("endedTasks.has('a')", h.context), true);
      assert.equal(vm.runInContext('rec', h.context), null);
      assert.equal(vm.runInContext('dictations.size', h.context), 0);
      assert.equal(h.el('#input').value, 'Kept draft');
      assert.equal(h.el('#send-btn').disabled, true);
      assert.equal(h.setup.micStops, 1);
      assert.equal(h.calls.filter(c => c.path.includes('/cancel?')).length, uploaded ? 1 : 0);
    }
  }
});

test('state request still cleans up its original background dictation across navigation', async () => {
  const h = heldDictationState(); await tick();
  vm.runInContext("openTerm('a')", h.context); await recordClip(h); await tick();
  const release = h.holdState([{ name: 'b', status: 'idle' }]);
  vm.runInContext("openTerm('b')", h.context);
  h.el('#input').value = 'Other draft'; h.el('#input').oninput();
  await release();
  assert.equal(vm.runInContext("endedTasks.has('a')", h.context), true);
  assert.equal(vm.runInContext('dictations.size', h.context), 0);
  assert.equal(vm.runInContext("endedTasks.has('b')", h.context), false);
  assert.equal(h.el('#input').value, 'Other draft');
  assert.equal(h.calls.filter(c => c.path.includes('/cancel?')).length, 1);
});

test('state request cannot discard a replacement background recording for the same task', async () => {
  const h = heldDictationState(); await tick();
  vm.runInContext("openTerm('a')", h.context); await recordClip(h); await tick();
  const originalId = vm.runInContext("dictations.get('a').id", h.context);
  const release = h.holdState([]);
  vm.runInContext('cancelDictation.onclick()', h.context);
  await recordClip(h);
  vm.runInContext("openTerm('b')", h.context);
  await release();
  assert.equal(vm.runInContext("endedTasks.has('a')", h.context), false);
  assert.notEqual(vm.runInContext("dictations.get('a').id", h.context), originalId);
  assert.equal(vm.runInContext("dictations.get('a').blob.size", h.context), 15);
  assert.equal(h.calls.filter(c => c.path.includes('/cancel?')).length, 1, 'only explicit discard cancels');
});

test('lost upload response keeps audio; read-only checks recover original-task text once without sending', async () => {
  let upload, ready = false;
  const h = frontend({ dictation: true, requestHook: async (path, opts) => {
    if (path === '/api/transcribe') {
      upload = { path, opts };
      return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('response lost'))));
    }
    if (path.startsWith('/api/transcribe/')) return jsonResponse(voiceReply(upload, ready ? 'complete' : 'pending', ready ? 'recovered words' : undefined));
  } });
  await tick(); vm.runInContext("openTerm('a')", h.context);
  h.el('#input').value = 'Original'; h.el('#input').oninput(); await recordClip(h);
  h.timers.find(t => t.ms === 60000 && !t.canceled).fn(); await tick();
  assert.equal(vm.runInContext("dictations.get('a').blob.size", h.context), 15);
  await vm.runInContext('checkDictation.onclick()', h.context);
  assert.equal(h.calls.filter(c => c.path === '/api/transcribe').length, 1);
  assert.equal(h.calls.filter(c => c.path.includes('/api/transcribe/') && c.opts.method === 'GET').length, 1);
  vm.runInContext("openTerm('b')", h.context);
  h.el('#input').value = 'Other task'; h.el('#input').oninput();
  ready = true;
  // An explicit check made for a keeps ownership even if its response arrives while b is open.
  await vm.runInContext("requestDictation(dictations.get('a'))", h.context);
  assert.equal(h.el('#input').value, 'Other task');
  vm.runInContext("openTerm('a')", h.context);
  assert.equal(h.el('#input').value, 'Original recovered words');
  await vm.runInContext('checkDictation.onclick()', h.context);
  assert.equal(h.el('#input').value, 'Original recovered words');
  assert.equal(h.calls.filter(c => c.path.endsWith('/keys')).length, 0, 'dictation never sends input');
  assert.equal(vm.runInContext('dictations.size', h.context), 0);
  assert.ok(h.calls.some(c => c.path.includes('/cancel?')), 'accepted text is released on server');
  assert.ok([...h.savedStarts.values()].every(v => !v.includes('recovered words')), 'result not persisted in storage');
});

test('explicit retry first reads unknown status, then reuses exact original identity/audio', async () => {
  let reached = false; const uploaded = [];
  const h = frontend({ dictation: true, requestHook: async (path, opts) => {
    if (path === '/api/transcribe') {
      uploaded.push({ path, opts });
      if (!reached) throw new Error('offline before upload');
      return jsonResponse(voiceReply(uploaded[0], 'complete', 'same audio recovered'));
    }
    if (path.startsWith('/api/transcribe/')) return jsonResponse(voiceReply(uploaded[0], 'unknown'));
  } });
  await tick(); vm.runInContext("openTerm('a')", h.context); await recordClip(h);
  assert.equal(uploaded.length, 1);
  await vm.runInContext('checkDictation.onclick()', h.context);
  assert.equal(uploaded.length, 1, 'checking unknown never uploads');
  reached = true;
  await vm.runInContext('retryDictation.onclick()', h.context);
  assert.equal(uploaded.length, 2);
  assert.match(uploaded[0].opts.headers['X-Dictation-Id'], /^[a-f0-9]{32}$/);
  assert.equal(uploaded[1].opts.headers['X-Dictation-Id'], uploaded[0].opts.headers['X-Dictation-Id']);
  assert.equal(uploaded[1].opts.body, uploaded[0].opts.body);
  assert.equal(h.el('#input').value, 'same audio recovered');
  const actions = h.calls.filter(c => c.path.startsWith('/api/transcribe'));
  assert.deepEqual(actions.slice(0, 4).map(c => c.opts.method), ['POST', 'GET', 'GET', 'POST']);
});

test('retry discovers an accepted job and retrieves its result without uploading again', async () => {
  let original;
  const h = frontend({ dictation: true, requestHook: async (path, opts) => {
    if (path === '/api/transcribe') { original = { opts }; throw new Error('lost reply'); }
    if (path.startsWith('/api/transcribe/')) return jsonResponse(voiceReply(original, 'complete', 'already done'));
  } });
  await tick(); vm.runInContext("openTerm('a')", h.context); await recordClip(h);
  // It was previously unknown; retry still reads again before considering a POST.
  vm.runInContext("dictations.get('a').phase = 'unknown'", h.context);
  await vm.runInContext('retryDictation.onclick()', h.context);
  assert.equal(h.calls.filter(c => c.path === '/api/transcribe').length, 1);
  assert.equal(h.el('#input').value, 'already done');
});

test('discard during upload suppresses late text and allows a new recording with a new ID', async () => {
  let finish; const uploaded = [];
  const h = frontend({ dictation: true, requestHook: async (path, opts) => {
    if (path === '/api/transcribe') { uploaded.push({ opts }); return new Promise(resolve => { finish = resolve; }); }
    if (path.includes('/cancel?')) return jsonResponse({ state: 'cancelled' });
  } });
  await tick(); vm.runInContext("openTerm('a')", h.context);
  h.el('#input').value = 'Keep draft'; h.el('#input').oninput(); await recordClip(h);
  const oldFinish = finish;
  vm.runInContext('cancelDictation.onclick()', h.context);
  assert.equal(uploaded[0].opts.signal.aborted, true);
  assert.equal(vm.runInContext('dictations.size', h.context), 0);
  oldFinish(jsonResponse(voiceReply(uploaded[0], 'complete', 'LATE'))); await tick();
  assert.equal(h.el('#input').value, 'Keep draft');
  await recordClip(h);
  assert.notEqual(uploaded[1].opts.headers['X-Dictation-Id'], uploaded[0].opts.headers['X-Dictation-Id']);
  assert.equal(h.calls.filter(c => c.path.endsWith('/keys')).length, 0);
  vm.runInContext('cancelDictation.onclick()', h.context);
  finish(jsonResponse(voiceReply(uploaded[1], 'complete', 'ALSO LATE'))); await tick();
  assert.equal(h.el('#input').value, 'Keep draft');
});

test('task end, including unconfirmed End, discards recording and suppresses late completion', async () => {
  for (const failEnd of [false, true]) {
    let finish, original;
    const h = frontend({ dictation: true, failEnd, requestHook: async (path, opts) => {
      if (path === '/api/transcribe') { original = { opts }; return new Promise(resolve => { finish = resolve; }); }
      if (path.includes('/cancel?')) return jsonResponse({ state: 'cancelled' });
    } });
    await tick(); vm.runInContext("openTerm('a')", h.context);
    h.el('#input').value = 'Typed'; h.el('#input').oninput(); await recordClip(h);
    h.el('#kill-btn').click(); await h.el('#kill-btn').click();
    finish(jsonResponse(voiceReply(original, 'complete', 'late after end'))); await tick();
    assert.equal(h.el('#input').value, 'Typed');
    await vm.runInContext('checkDictation.onclick()', h.context);
    assert.equal(h.calls.filter(c => c.path === '/api/transcribe').length, 1);
    assert.equal(vm.runInContext('dictations.size', h.context), 0);
  }
});

test('missing original task while checking prevents late status text from entering its draft', async () => {
  let original, finish;
  const h = frontend({ dictation: true, requestHook: async (path, opts) => {
    if (path === '/api/transcribe') { original = { opts }; return jsonResponse(voiceReply(original, 'pending')); }
    if (path.startsWith('/api/transcribe/') && opts.method === 'GET') return new Promise(resolve => { finish = resolve; });
    if (path.includes('/cancel?')) return jsonResponse({ state: 'cancelled' });
  } });
  await tick(); vm.runInContext("openTerm('a')", h.context); await recordClip(h);
  const pending = vm.runInContext('checkDictation.onclick()', h.context); await tick();
  h.setup.sessions = [{ name: 'b', lane: 'shell', project: '/example' }];
  await vm.runInContext('refresh()', h.context);
  finish(jsonResponse(voiceReply(original, 'complete', 'late unavailable task'))); await pending;
  assert.equal(h.el('#input').value, ''); assert.equal(vm.runInContext('dictations.size', h.context), 0);
  assert.match(h.el('#delivery').textContent, /ended|unavailable/i);
});

test('failed, expired, stale-boot and mismatched receipts retain audio without automatic retries or text', async () => {
  for (const state of ['failed', 'expired', 'stale', 'mismatch']) {
    const h = frontend({ dictation: true, requestHook: async (path, opts) => {
      if (path === '/api/transcribe') {
        if (state === 'stale') return jsonResponse({ error: 'server changed' }, 410);
        const reply = voiceReply({ opts }, state === 'mismatch' ? 'complete' : state, 'untrusted');
        if (state === 'mismatch') reply.task = 'b';
        return jsonResponse(reply);
      }
    } });
    await tick(); vm.runInContext("openTerm('a')", h.context); await recordClip(h);
    assert.equal(h.el('#input').value, '');
    assert.equal(vm.runInContext("dictations.get('a').blob.size", h.context), 15);
    assert.equal(h.calls.filter(c => c.path === '/api/transcribe').length, 1);
    assert.equal(h.calls.filter(c => c.path.endsWith('/keys')).length, 0);
    vm.runInContext('cancelDictation.onclick()', h.context);
  }
});

test('page retention expires, requests cancellation and frees recording without storing audio/text', async () => {
  let original;
  const h = frontend({ dictation: true, requestHook: async (path, opts) => {
    if (path === '/api/transcribe') { original = { opts }; return jsonResponse(voiceReply(original, 'pending')); }
    if (path.includes('/cancel?')) return jsonResponse({ state: 'cancelled' });
  } });
  await tick(); vm.runInContext("openTerm('a')", h.context); await recordClip(h);
  h.timers.find(t => t.ms === 15 * 60000 && !t.canceled).fn(); await tick();
  assert.equal(vm.runInContext('dictations.size', h.context), 0);
  assert.match(h.el('#delivery').textContent, /expired after 15 minutes/);
  assert.equal(h.calls.filter(c => c.path === '/api/transcribe').length, 1);
  assert.ok(h.calls.some(c => c.path.includes('/cancel?')));
  const reloaded = frontend({ dictation: true, savedStarts: h.savedStarts }); await tick();
  assert.equal(vm.runInContext('dictations.size', reloaded.context), 0);
  assert.equal(reloaded.calls.filter(c => c.path === '/api/transcribe').length, 0);
});

test('discard while recording stops it without uploading or appending any text', async () => {
  const h = frontend({ dictation: true });
  await tick(); vm.runInContext("openTerm('a')", h.context);
  h.el('#input').value = 'Keep'; h.el('#input').oninput();
  await h.el('#mic-btn').click();
  assert.equal(vm.runInContext('dictationControls.hidden', h.context), false);
  vm.runInContext('cancelDictation.onclick()', h.context); await tick();
  assert.equal(h.calls.filter(c => c.path === '/api/transcribe').length, 0);
  assert.equal(vm.runInContext('rec', h.context), null);
  assert.equal(vm.runInContext('dictations.size', h.context), 0);
  assert.equal(h.el('#input').value, 'Keep');
});

test('background task disappearance discards its recording while leaving the selected task alone', async () => {
  let finish, original;
  const h = frontend({ dictation: true, requestHook: async (path, opts) => {
    if (path === '/api/transcribe') { original = { opts }; return new Promise(resolve => { finish = resolve; }); }
    if (path.includes('/cancel?')) return jsonResponse({ state: 'cancelled' });
  } });
  await tick(); vm.runInContext("openTerm('a')", h.context); await recordClip(h);
  vm.runInContext("openTerm('b')", h.context);
  h.el('#input').value = 'Other'; h.el('#input').oninput();
  h.setup.sessions = [{ name: 'b', lane: 'shell', project: '/example' }];
  await vm.runInContext('refresh()', h.context);
  finish(jsonResponse(voiceReply(original, 'complete', 'late background text'))); await tick();
  assert.equal(h.el('#input').value, 'Other');
  assert.equal(vm.runInContext("composer('a').draft", h.context), '');
  assert.equal(vm.runInContext('dictations.size', h.context), 0);
});

test('microphone permission resolving after End or a task switch cannot start abandoned recording', async () => {
  for (const action of ['end', 'switch']) {
    const h = frontend({ dictation: true, failEnd: true });
    await tick(); vm.runInContext("openTerm('a')", h.context);
    let release; h.setup.micPermission = new Promise(resolve => { release = resolve; });
    const permission = h.el('#mic-btn').click();
    if (action === 'end') { h.el('#kill-btn').click(); await h.el('#kill-btn').click(); }
    else vm.runInContext("openTerm('b'); openTerm('a')", h.context);
    release(); await permission;
    assert.equal(vm.runInContext('rec', h.context), null);
    assert.equal(h.setup.micStops, 1);
    assert.equal(h.calls.filter(c => c.path === '/api/transcribe').length, 0);
  }
});

test('suspended-page expiry rejects a late result even before its cleanup timer has fired', async () => {
  let original, finish;
  const h = frontend({ dictation: true, requestHook: async (path, opts) => {
    if (path === '/api/transcribe') { original = { opts }; return new Promise(resolve => { finish = resolve; }); }
    if (path.includes('/cancel?')) return jsonResponse({ state: 'cancelled' });
  } });
  await tick(); vm.runInContext("openTerm('a')", h.context); await recordClip(h);
  vm.runInContext("dictations.get('a').created -= 15 * 60000 + 1", h.context);
  finish(jsonResponse(voiceReply(original, 'complete', 'too late'))); await tick();
  assert.equal(h.el('#input').value, ''); assert.equal(vm.runInContext('dictations.size', h.context), 0);
  assert.match(h.el('#delivery').textContent, /expired/);
});

test('four page recordings bound admission; discard frees a slot and a fifth task can record', async () => {
  let count = 0;
  const h = frontend({ dictation: true, requestHook: async (path, opts) => {
    if (path === '/api/transcribe') { count++; return jsonResponse(voiceReply({ opts }, 'pending')); }
    if (path.includes('/cancel?')) return jsonResponse({ state: 'cancelled' });
  } });
  await tick();
  h.setup.sessions = ['a', 'b', 'c', 'd', 'e'].map(name => ({ name, lane: 'shell', project: '/example' }));
  for (const name of ['a', 'b', 'c', 'd']) { vm.runInContext(`openTerm('${name}')`, h.context); await recordClip(h); }
  vm.runInContext("openTerm('e')", h.context); await h.el('#mic-btn').click();
  assert.equal(count, 4); assert.equal(vm.runInContext('dictations.size', h.context), 4);
  assert.match(h.el('#delivery').textContent, /Four recordings/);
  vm.runInContext("discardDictation('a')", h.context); await recordClip(h);
  assert.equal(count, 5); assert.equal(vm.runInContext('dictations.size', h.context), 4);
});

test('recording duration and byte bounds stop capture without uploading oversized audio', async () => {
  let count = 0;
  const h = frontend({ dictation: true, requestHook: async (path, opts) => {
    if (path === '/api/transcribe') { count++; return jsonResponse(voiceReply({ opts }, 'pending')); }
    if (path.includes('/cancel?')) return jsonResponse({ state: 'cancelled' });
  } });
  await tick(); vm.runInContext("openTerm('a')", h.context); await h.el('#mic-btn').click();
  h.timers.find(t => t.ms === 120000 && !t.canceled).fn(); await tick();
  assert.equal(vm.runInContext('rec', h.context), null); assert.equal(count, 1);
  vm.runInContext('cancelDictation.onclick()', h.context);
  await h.el('#mic-btn').click();
  vm.runInContext('rec.ondataavailable({ data: { size: 25 * 1048576 + 1 } })', h.context); await tick();
  assert.equal(vm.runInContext('rec', h.context), null); assert.equal(count, 1);
  assert.equal(vm.runInContext('dictations.size', h.context), 0);
});

test('pairing prevents a second code redemption while the first is pending', async () => {
  let finishPair;
  const h = frontend({ requestHook: async (path) => {
    if (path !== '/api/pair') return;
    await new Promise(resolve => { finishPair = resolve; });
    return {ok:false,status:403,json:async()=>({error:'wrong or expired code'})};
  } });
  await tick();
  h.el('#pair-code').value = 'ABCD-EFGH';
  const first = h.el('#pair-form').onsubmit({preventDefault(){}});
  await tick();
  assert.equal(h.el('#pair-submit').disabled, true);
  await h.el('#pair-form').onsubmit({preventDefault(){}});
  assert.equal(h.calls.filter(c => c.path === '/api/pair').length, 1);
  finishPair(); await first;
  assert.equal(h.el('#pair-submit').disabled, false);
  assert.match(h.el('#pair-err').textContent, /incorrect or has expired/);
  assert.equal(h.el('#pair-code').value, 'ABCD-EFGH');
});

test('pairing distinguishes uncertain transport from rejected codes and forbidden connections', async () => {
  for (const failure of ['network','forbidden']) {
    const h = frontend({ requestHook: async path => {
      if (path !== '/api/pair') return;
      if (failure === 'network') throw new Error('network failed');
      return {ok:false,status:403,json:async()=>({error:'forbidden'})};
    }});
    await tick();
    await h.el('#pair-form').onsubmit({preventDefault(){}});
    const message = h.el('#pair-err').textContent;
    assert.match(message, failure === 'network' ? /Couldn’t confirm.*Reload/ : /connection is not allowed/);
    assert.doesNotMatch(message, /incorrect or has expired/);
    assert.equal(h.calls.filter(c => c.path === '/api/pair').length, 1);
    assert.equal(h.el('#pair-submit').disabled, false);
  }
});

test('accepted dictation completes through read-only polling without another upload or send', async () => {
  let original, checks = 0;
  const h = frontend({ dictation: true, requestHook: async (path, opts) => {
    if (path === '/api/transcribe') { original = { opts }; return jsonResponse(voiceReply(original, 'pending')); }
    if (path.includes('/cancel?')) return jsonResponse({state:'cancelled'});
    if (path.startsWith('/api/transcribe/')) {
      checks++; return jsonResponse(voiceReply(original, checks < 2 ? 'pending' : 'complete', checks < 2 ? undefined : 'Automatic result'));
    }
  }});
  await tick(); vm.runInContext("openTerm('a')",h.context); await recordClip(h);
  h.el('#input').value = 'Original'; h.el('#input').oninput();
  vm.runInContext("openTerm('b')",h.context);
  h.el('#input').value = 'Other task'; h.el('#input').oninput();
  for (let i=0;i<2;i++) {
    const timer = h.timers.find(t=>t.ms===2000&&!t.canceled); assert.ok(timer);
    await timer.fn(); await tick();
  }
  assert.equal(h.el('#input').value,'Other task');
  assert.equal(vm.runInContext("composer('a').draft",h.context),'Original Automatic result');
  assert.equal(h.calls.filter(c=>c.path==='/api/transcribe').length,1);
  assert.equal(h.calls.filter(c=>c.path.endsWith('/keys')).length,0);
  assert.equal(h.timers.some(t=>t.ms===2000&&!t.canceled),false);
});

test('poll transport failure stops automatic checks and discard cancels pending checks', async () => {
  let original;
  const h = frontend({dictation:true,requestHook:async(path,opts)=>{
    if(path==='/api/transcribe'){original={opts};return jsonResponse(voiceReply(original,'pending'));}
    if(path.includes('/cancel?'))return jsonResponse({state:'cancelled'});
    if(path.startsWith('/api/transcribe/'))throw new Error('lost response');
  }});
  await tick();vm.runInContext("openTerm('a')",h.context);await recordClip(h);
  await h.timers.find(t=>t.ms===2000&&!t.canceled).fn();await tick();
  assert.equal(h.timers.some(t=>t.ms===2000&&!t.canceled),false);
  assert.equal(vm.runInContext("dictations.get('a').phase",h.context),'unconfirmed');
  assert.equal(vm.runInContext('checkDictation.hidden',h.context),false);
  assert.equal(h.calls.filter(c=>c.path==='/api/transcribe').length,1);
  vm.runInContext("dictations.get('a').phase='pending';scheduleDictationCheck(dictations.get('a'))",h.context);
  const timer=h.timers.find(t=>t.ms===2000&&!t.canceled);assert.ok(timer);
  vm.runInContext('cancelDictation.onclick()',h.context);await tick();
  assert.equal(timer.canceled,true);
  const count=h.calls.length;await timer.fn();assert.equal(h.calls.length,count);
});

test('permanent dictation capacity gives a restart action instead of an endless check loop', async () => {
  const h=frontend({dictation:true,requestHook:async(path)=>path==='/api/transcribe'
    ?jsonResponse({error:'recovery full',code:'DICTATION_CAPACITY'},503):undefined});
  await tick();vm.runInContext("openTerm('a')",h.context);await recordClip(h);
  assert.match(h.el('#delivery').textContent,/restart Cockpit/);
  assert.doesNotMatch(h.el('#delivery').textContent,/check status|Check dictation/);
  assert.equal(vm.runInContext('checkDictation.hidden',h.context),true);
  assert.equal(vm.runInContext('retryDictation.hidden',h.context),true);
  assert.equal(h.calls.filter(c=>c.path==='/api/transcribe').length,1);
});


test('Done and repeated Respond close response controls without sending terminal input', async () => {
  const h=frontend({history:'An assistant question'}); await tick(); openNewAssistant(h); await tick();
  vm.runInContext("renderTermIdentity({name:'a',lane:'agy',status:'needs-you'})",h.context); await tick();
  const before=h.calls.filter(c=>c.path.endsWith('/keys')).length;
  h.el('#input').value='Keep this draft'; h.el('#input').oninput();
  h.el('#startup-respond').click();
  const done=h.el('#keys').querySelector('.controls-heading').children.find(b=>b.textContent==='Done');
  assert.equal(h.context.document.activeElement,done,'phone panel opens on a non-sending control');
  done.click();
  assert.equal(h.el('#keys').classList.contains('short-open'),false);
  assert.equal(h.el('#startup-respond')['aria-expanded'],'false');
  assert.equal(h.context.document.activeElement,h.el('#startup-respond'));
  h.el('#startup-respond').click(); h.el('#startup-respond').click();
  assert.equal(h.el('#keys').classList.contains('short-open'),false);
  assert.equal(h.el('#keys-toggle')['aria-expanded'],'false');
  assert.equal(h.el('#input').value,'Keep this draft');
  assert.equal(h.calls.filter(c=>c.path.endsWith('/keys')).length,before);
  h.el('#keys-toggle').click(); done.click();
  assert.equal(h.context.document.activeElement,h.el('#keys-toggle'));
  assert.equal(h.calls.filter(c=>c.path.endsWith('/keys')).length,before);
});


test('browser Back and Forward restore list, new-task draft and the correct task without sending input', async () => {
  const h=frontend({createFlow:true,startRecovery:true}); await tick();
  assert.equal(h.context.location.hash,'#');
  h.el('#new-btn').click(); await tick();
  h.el('#prompt').value='A first-message draft'; h.el('#prompt').oninput();
  assert.equal(h.context.location.hash,'#@new');
  vm.runInContext("openTerm('a')",h.context); await tick();
  h.el('#input').value='Draft for A'; h.el('#input').oninput();
  vm.runInContext("openTerm('b')",h.context); await tick();
  h.el('#input').value='Draft for B'; h.el('#input').oninput();
  h.context.history.back(); await tick();
  assert.equal(vm.runInContext('current',h.context),'a');
  assert.equal(h.el('#input').value,'Draft for A');
  h.context.history.back(); await tick();
  assert.equal(vm.runInContext('activeView',h.context),'new');
  assert.equal(h.el('#prompt').value,'A first-message draft');
  h.context.history.back(); await tick();
  assert.equal(vm.runInContext('activeView',h.context),'list');
  assert.equal(vm.runInContext('current',h.context),null);
  h.context.history.forward(); h.context.history.forward(); h.context.history.forward(); await tick();
  assert.equal(vm.runInContext('current',h.context),'b');
  assert.equal(h.el('#input').value,'Draft for B');
  assert.equal(h.calls.filter(c=>c.path.endsWith('/keys') || (c.path==='/api/sessions' && c.opts.method==='POST')).length,0);
});

test('malformed and unavailable task fragments return to list; pairing cannot be navigated around', async () => {
  const h=frontend(); await tick();
  for (const hash of ['#%broken','#missing']) {
    h.context.location.hash=hash; vm.runInContext('restoreRoute()',h.context); await tick();
    assert.equal(vm.runInContext('activeView',h.context),'list');
    assert.equal(h.context.location.hash,'#');
  }
  vm.runInContext("show('pair')",h.context);
  h.context.location.hash='#a'; vm.runInContext('restoreRoute()',h.context);
  assert.equal(vm.runInContext('activeView',h.context),'pair');
  assert.equal(vm.runInContext('current',h.context),null);
});

const loadedRouteState = () => ({ok:true,headers:{get:()=> 'application/json'},json:async()=>({lanes:['grok'],sessions:[{name:'a',lane:'grok',project:'/example/project',status:'idle'}],actionEpoch:'synthetic-epoch'})});

test('Back preserves a task destination until delayed initial state arrives', async () => {
  let resolveInitial, held=true;
  const h=frontend({initialHash:'#a',requestHook:(path)=>{
    if(path==='/api/state'&&held){held=false;return new Promise(resolve=>{resolveInitial=resolve;});}
  }});
  await tick(); h.el('#new-btn').click(); await tick();
  h.el('#prompt').value='Keep the new-task draft';h.el('#prompt').oninput();
  h.context.history.back();
  assert.equal(h.context.location.hash,'#a');
  assert.equal(vm.runInContext('current',h.context),null);
  resolveInitial(loadedRouteState()); await tick(); await tick();
  assert.equal(vm.runInContext('current',h.context),'a');
  assert.equal(h.context.location.hash,'#a');
  assert.equal(h.el('#prompt').value,'Keep the new-task draft');
});

test('failed initial state keeps a deep link for retry without overriding newer navigation', async () => {
  for (const navigate of [false,true]) {
    let fail=true;
    const h=frontend({initialHash:'#a',requestHook:(path)=>{
      if(path==='/api/state'&&fail)return Promise.reject(new Error('offline'));
    }});
    await tick(); await tick();
    assert.equal(h.context.location.hash,'#a');
    assert.equal(vm.runInContext('current',h.context),null);
    if(navigate)h.el('#new-btn').click();
    fail=false;await vm.runInContext('refresh()',h.context);await tick();
    assert.equal(vm.runInContext('activeView',h.context),navigate?'new':'term');
    assert.equal(h.context.location.hash,navigate?'#@new':'#a');
    assert.equal(vm.runInContext('current',h.context),navigate?null:'a');
  }
});


test('reopening an ended task never attributes another task output in Read or Live', async () => {
  for (const selectedMode of ['read', 'live']) {
    const h = frontend({ history: 'Output owned by A' }); await tick();
    vm.runInContext(`openTerm('a'); setMode('${selectedMode}')`, h.context); await tick();
    if (selectedMode === 'live') {
      const sock = h.sockets.at(-1); sock.readyState = 1; sock.onopen(); sock.onmessage({data:'Live output owned by A'});
    }
    h.setup.sessions = [{name:'a',lane:'grok',status:'exited'},{name:'b',lane:'grok',status:'idle'}];
    await vm.runInContext('refresh()', h.context);
    h.setHistory('Output owned by B');
    vm.runInContext("openTerm('b')", h.context); await tick();
    if (selectedMode === 'live') {
      const sock = h.sockets.at(-1); sock.readyState = 1; sock.onopen(); sock.onmessage({data:'Live output owned by B'});
    }
    const before = h.calls.filter(c => c.path.includes('/a/history')).length;
    vm.runInContext("openTerm('a')", h.context); await tick();
    assert.equal(h.el('#reader').hidden, false, 'ended reopen has a visible truthful output state');
    assert.match(h.el('#reader').textContent, /No output retained/);
    assert.doesNotMatch(h.el('#reader').textContent, /owned by B/);
    assert.equal(h.el('#term').hidden, true);
    assert.equal(h.el('#term').children.length, 0);
    assert.equal(h.calls.filter(c => c.path.includes('/a/history')).length, before, 'ended tasks are not retried');
    assert.equal(h.el('#send-btn').disabled, true);
  }
});

test('held older conversation cannot block current raw question or enable unseen response keys', async () => {
  let holdOld = false, finishOld, finishQuestion;
  const h = frontend({history:ownedConversation(shownMessages), requestHook: async url => {
    if (holdOld && url.includes('/history')) return new Promise(resolve => {
      if (url.includes('format=reader')) finishOld = resolve; else finishQuestion = resolve;
    });
  }});
  await tick(); vm.runInContext("openTerm('a')", h.context); await tick();
  holdOld = true;
  const oldRead = vm.runInContext('pullReader()', h.context); await tick();
  vm.runInContext("renderTermIdentity({name:'a',lane:'grok',status:'needs-you'})", h.context); await tick();
  assert.equal(typeof finishQuestion, 'function', 'raw question starts without waiting for the older conversation');
  assert.equal(keyButton(h,'Enter').disabled, true);
  assert.equal(h.el('#send-btn').disabled, true);
  h.el('#startup-respond').click(); await keyButton(h,'Enter').click();
  assert.equal(h.calls.filter(c=>c.path.endsWith('/keys')).length, 0);
  finishOld({ok:true,headers:{get:()=> 'application/json'},json:async()=>ownedConversation(shownMessages)});
  await oldRead;
  assert.equal(keyButton(h,'Enter').disabled, true, 'stale conversation does not establish readiness');
  finishQuestion({ok:true,headers:{get:()=> 'text/plain'},text:async()=> 'Current raw question: choose an option'}); await tick();
  assert.equal(h.el('#reader').textContent, 'Current raw question: choose an option');
  assert.equal(keyButton(h,'Enter').disabled, false);
  assert.equal(h.calls.filter(c=>c.path.endsWith('/keys')).length, 0, 'loading output never sends');
});

test('attention read failures, empty captures and conversation replies keep every input path blocked until raw output recovers', async () => {
  const h = frontend({history:'Initial answer'}); await tick(); vm.runInContext("openTerm('a')", h.context); await tick();
  h.setup.sessions = [{name:'a',lane:'grok',status:'needs-you'}];
  h.setHistoryError(true); await vm.runInContext('refresh()', h.context); await tick();
  const assertBlocked = async () => {
    assert.equal(keyButton(h,'Enter').disabled, true);
    assert.equal(h.el('#send-btn').disabled, true);
    assert.equal(h.el('#startup-respond').disabled, true);
    h.el('#input').value = 'Keep this unsent'; h.el('#input').oninput();
    h.el('#startup-respond').click(); await keyButton(h,'Enter').click();
    await h.el('#input-row').onsubmit({preventDefault(){}});
    assert.equal(h.calls.filter(c=>c.path.endsWith('/keys')).length, 0);
    assert.equal(h.el('#input').value, 'Keep this unsent');
  };
  await assertBlocked(); h.setHistoryError(false);
  for (const invalid of ['', '   \n', ownedConversation(shownMessages)]) {
    h.setHistory(invalid); await vm.runInContext('pullReader()', h.context); await assertBlocked();
  }
  h.setHistory('Raw current question'); await vm.runInContext('pullReader()', h.context);
  assert.equal(keyButton(h,'Enter').disabled, false);
  h.setHistoryError(true); await vm.runInContext('pullReader()', h.context);
  assert.equal(h.el('#reader').textContent, 'Raw current question', 'last capture may remain visible on failure');
  await assertBlocked();
  h.setHistoryError(false); await vm.runInContext('pullReader()', h.context);
  assert.equal(keyButton(h,'Enter').disabled, false, 'same-text successful recovery establishes readiness again');
});

test('mode changes and task navigation invalidate question reads, queued keys and Live stdin', async () => {
  const reads = []; let hold = false;
  const h = frontend({history:'Initial answer', requestHook: async url => {
    if (hold && url.includes('/history')) return new Promise(resolve => reads.push({url, resolve}));
  }});
  await tick(); vm.runInContext("openTerm('a')", h.context); await tick();
  h.setup.sessions = [{name:'a',lane:'grok',status:'needs-you'},{name:'b',lane:'grok',status:'idle'}];
  hold = true; await vm.runInContext('refresh()', h.context); await tick();
  const reply = (read, text) => read.resolve({ok:true,headers:{get:()=> 'text/plain'},text:async()=>text});
  const first = reads.at(-1);
  vm.runInContext("setMode('live')", h.context);
  const sock=h.sockets.at(-1), terminal=h.terminals.at(-1); sock.readyState=1; sock.onopen();
  const sent=sock.sent.length; terminal.input('\r');
  assert.equal(sock.sent.length, sent, 'Live Enter cannot bypass unread question');
  reply(first, 'Stale before Live'); await tick();
  assert.equal(keyButton(h,'Enter').disabled,true);
  h.el('#startup-respond').click(); await tick();
  assert.equal(h.el('#reader').hidden,false,'Respond in Live loads Read first');
  assert.equal(keyButton(h,'Enter').disabled,true);
  reply(reads.at(-1), 'Current question A'); await tick();
  assert.equal(h.el('#reader').textContent,'Current question A');
  const queued = vm.runInContext("enqueueAction('a', {key:'Enter'}); setMode('live')", h.context);
  await queued; await tick();
  assert.equal(h.calls.filter(c=>c.path.endsWith('/keys')).length,0,'mode change cancels an undispatched queued response');
  vm.runInContext("setMode('read')",h.context); await tick(); const beforeNavigation=reads.at(-1);
  vm.runInContext("openTerm('b'); openTerm('a')",h.context); await tick(); const afterNavigation=reads.at(-1);
  reply(beforeNavigation,'Stale before navigation'); await tick();
  assert.equal(keyButton(h,'Enter').disabled,true);
  assert.doesNotMatch(h.el('#reader').textContent,/Stale before navigation/);
  reply(afterNavigation,'Reopened current question A'); await tick();
  assert.equal(h.el('#reader').textContent,'Reopened current question A');
  assert.equal(keyButton(h,'Enter').disabled,false);
  assert.equal(h.calls.filter(c=>c.path.endsWith('/keys')).length,0);
});

test('uncertain delivery checks and manual review cannot bypass a pending current-question read', async () => {
  let hold = false, finishQuestion;
  const h = frontend({history:'Current question', requestHook: async (url,opts) => {
    if (hold && url.includes('/history')) return new Promise(resolve=>{finishQuestion=resolve;});
    if (url.endsWith('/keys')) {
      const body=JSON.parse(opts.body);
      if (!body.check) { hold=true; throw new Error('lost acknowledgement'); }
      return {ok:true,headers:{get:()=> 'application/json'},json:async()=>({ok:true,actionId:body.actionId})};
    }
  }});
  await tick(); vm.runInContext("openTerm('a')",h.context); await tick();
  h.setup.sessions=[{name:'a',lane:'grok',status:'needs-you'}];
  await vm.runInContext('refresh()',h.context); await tick();
  h.el('#startup-respond').click(); await keyButton(h,'Enter').click(); await tick();
  assert.equal(vm.runInContext("!!actionState('a').uncertain",h.context),true);
  assert.equal(vm.runInContext('reviewDelivery.disabled',h.context),true);
  vm.runInContext('reviewDelivery.onclick()',h.context);
  assert.equal(vm.runInContext("!!actionState('a').uncertain",h.context),true,'manual review cannot acknowledge unseen output');
  await vm.runInContext('checkDelivery.onclick()',h.context);
  assert.equal(vm.runInContext("!!actionState('a').uncertain",h.context),false);
  assert.equal(keyButton(h,'Enter').disabled,true,'receipt proves delivery only, never question readiness');
  finishQuestion({ok:true,headers:{get:()=> 'text/plain'},text:async()=> 'Question after uncertain action'}); await tick();
  assert.equal(h.el('#reader').textContent,'Question after uncertain action');
  assert.equal(keyButton(h,'Enter').disabled,false);
  assert.equal(h.calls.filter(c=>c.path.endsWith('/keys')&&!JSON.parse(c.opts.body).check).length,1,'no automatic repeat');
});

test('leaving and reentering attention invalidates queued responses and older raw captures', async () => {
  let hold = false; const reads=[];
  const h=frontend({history:'Initial answer',requestHook:async url=> {
    if (hold && url.includes('/history')) return new Promise(resolve=>reads.push(resolve));
  }});
  await tick(); vm.runInContext("openTerm('a')",h.context); await tick();
  h.setup.sessions=[{name:'a',lane:'grok',status:'needs-you'}];
  h.setHistory('First question'); await vm.runInContext('refresh()',h.context); await tick();
  assert.equal(keyButton(h,'Enter').disabled,false);
  hold=true;
  const oldRead=vm.runInContext('pullReader()',h.context); await tick(); const old=reads.at(-1);
  vm.runInContext("enqueueAction('a',{key:'Enter'}); renderTermIdentity({name:'a',lane:'grok',status:'working'})",h.context);
  await tick(); assert.equal(h.calls.filter(c=>c.path.endsWith('/keys')).length,0,'attention ending cancels a queued response');
  vm.runInContext("renderTermIdentity({name:'a',lane:'grok',status:'needs-you'})",h.context); await tick(); const fresh=reads.at(-1);
  old({ok:true,headers:{get:()=> 'text/plain'},text:async()=> 'Old raw question'}); await oldRead;
  assert.equal(keyButton(h,'Enter').disabled,true);
  assert.doesNotMatch(h.el('#reader').textContent,/Old raw question/);
  fresh({ok:true,headers:{get:()=> 'text/plain'},text:async()=> 'New raw question'}); await tick();
  assert.equal(h.el('#reader').textContent,'New raw question');
  assert.equal(keyButton(h,'Enter').disabled,false);
});

test('first opening a task already reported ended shows no retained output and starts no reader or socket', async () => {
  for (const selectedMode of ['read','live']) {
    const h=frontend({history:'Other task output'}); await tick();
    vm.runInContext(`openTerm('b'); setMode('${selectedMode}')`,h.context); await tick();
    h.setup.sessions=[{name:'a',lane:'grok',status:'exited'},{name:'b',lane:'grok',status:'idle'}];
    await vm.runInContext('refresh()',h.context);
    const sockets=h.sockets.length;
    vm.runInContext("openTerm('a')",h.context); await tick();
    assert.equal(h.calls.filter(c=>c.path.includes('/a/history')).length,0);
    assert.equal(h.sockets.length,sockets);
    assert.match(h.el('#reader').textContent,/No output retained/);
    assert.equal(h.el('#reader').hidden,false);
    assert.equal(h.el('#term').hidden,true);
  }
});

test('confirmed new task survives Back and Forward while task-state refresh fails or predates the start', async () => {
  for (const scenario of ['failed', 'older']) {
    let stateMode = 'normal', releaseOld;
    const h = await setupTask({startRecovery:true,requestHook:(path)=>{
      if(path !== '/api/state') return;
      if(stateMode === 'failed') return Promise.reject(new Error('offline'));
      if(stateMode === 'hold') return new Promise(resolve=>{releaseOld=resolve;});
    }});
    h.setup.sessions = [{name:'a',lane:'grok',status:'idle'}];
    await vm.runInContext('refresh()',h.context);
    let older;
    if(scenario === 'older') {stateMode='hold';older=vm.runInContext('refresh()',h.context);await tick();}
    else stateMode='failed';
    await h.el('#start-btn').click();await tick();
    assert.equal(vm.runInContext('current',h.context),'synthetic-created');
    h.el('#input').value='New task draft';h.el('#input').oninput();
    h.context.history.back();h.context.history.forward();await tick();
    assert.equal(h.context.location.hash,'#synthetic-created');
    assert.equal(vm.runInContext('current',h.context),'synthetic-created');
    assert.equal(h.el('#input').value,'New task draft');
    if(scenario === 'older') {
      stateMode='failed';releaseOld(loadedRouteState());await older;await tick();
      assert.equal(vm.runInContext("endedTasks.has('synthetic-created')",h.context),false,'a snapshot begun before confirmation cannot end the task');
      h.context.history.back();h.context.history.forward();await tick();
      assert.equal(vm.runInContext('current',h.context),'synthetic-created');
    }
    stateMode='normal';h.setup.sessions=[{name:'synthetic-created',lane:'grok',project:'/example/alpha',status:'idle'}];
    await vm.runInContext('refresh()',h.context);await tick();
    assert.equal(h.context.location.hash,'#synthetic-created');
    assert.equal(vm.runInContext('current',h.context),'synthetic-created');
    assert.equal(startCalls(h).length,1);
    assert.equal(h.calls.filter(c=>c.path.endsWith('/keys')).length,0);
    // A later successful absence is authoritative; confirmed starts are not immortal.
    h.setup.sessions=[];await vm.runInContext('refresh()',h.context);
    assert.equal(vm.runInContext("endedTasks.has('synthetic-created')",h.context),true);
    h.context.history.back();h.context.history.forward();await tick();
    assert.equal(vm.runInContext('activeView',h.context),'list');
    assert.equal(h.context.location.hash,'#');
  }
});
