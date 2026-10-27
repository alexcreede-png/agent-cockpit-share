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

function frontend({ failSend = false, failSendStatus = 503, failEnd = false, voiceStall = false, voiceBodyStall = false, history = '', historyError = false, createFlow = false, startRecovery = false, savedStarts = new Map(), storageDenied = false, cryptoDenied = false } = {}) {
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
    get firstElementChild() { return this.children[0]; }
    replaceChildren(...nodes) { this.children = nodes; }
    append(...nodes) { this.children.push(...nodes); }
    remove() {}
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
  const setup = { startRecovery, projectError: false, createError: false, loseResponse: false, errorCode: '', errorStatus: 503, badReply: false, holdCreate: false, finishCreate: null };
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
  const window = { addEventListener() {}, MediaRecorder: voiceStall || voiceBodyStall ? FakeMediaRecorder : null, visualViewport: null };
  window.parent = window;
  const context = vm.createContext({
    document, window, navigator: voiceStall || voiceBodyStall ? { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } } : {},
    matchMedia: () => ({ matches: true }), XMLHttpRequest: XHR, MediaRecorder: FakeMediaRecorder, Blob,
    Terminal: FakeTerminal, WebSocket: FakeSocket, FitAddon: { FitAddon: class { fit() {} } },
    AbortController,
    crypto: { getRandomValues: (bytes) => { if (cryptoDenied) throw new Error('unavailable'); return require('node:crypto').randomFillSync(bytes); } },
    sessionStorage: {
      getItem: k => { if (storageDenied) throw new Error('denied'); return savedStarts.get(k) || null; },
      setItem: (k,v) => { if (storageDenied) throw new Error('denied'); savedStarts.set(k,v); },
      removeItem: k => { if (storageDenied) throw new Error('denied'); savedStarts.delete(k); },
    },
    location: { hash: '', protocol: 'https:', host: 'example.test' }, history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {} }, ResizeObserver: class {
      constructor(fn) { this.fn = fn; observers.push(this); }
      observe(element) { this.element = element; }
    },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, canceled: false }); return timers.length; },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].canceled = true; },
    setInterval: () => 1, clearInterval() {},
    addEventListener() {}, innerHeight: 800, fetch: async (path, opts = {}) => {
      calls.push({ path, opts });
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
      const body = path === '/api/state' ? { startRecovery: setup.startRecovery, lanes: createFlow ? ['claude','codex','grok','agy','shell'] : [], sessions: [], transcribe: false }
        : path === '/api/projects' ? exampleProjects : path === '/api/sessions' ? {name:'synthetic-created', ...(setup.badReply ? {} : {requestId: JSON.parse(opts.body).requestId}), reused: false} : {};
      const failed = (setup.projectError && path === '/api/projects') || ((setup.createError || setup.errorCode) && path === '/api/sessions') || (failHistory && path.includes('/history')) || (failSend && path === '/api/sessions/a/keys') || (failEnd && path === '/api/sessions/a/end');
      return { ok: !failed, status: failed ? (path === '/api/sessions' && (setup.errorCode || setup.createError) ? setup.errorStatus : failSendStatus) : 200,
        headers: { get: () => path.includes('/history') ? 'text/plain' : 'application/json' },
        json: async () => failed ? { error: 'unavailable', code: setup.errorCode, requestId: path === '/api/sessions' ? JSON.parse(opts.body).requestId : undefined, name: 'synthetic-created' } : body,
        text: async () => path.includes('/history') ? historyText : '' };
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
  assert.equal(h.el('#mic-btn').disabled, false);
  assert.match(h.el('#delivery').textContent, /Transcription timed out/);
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
  assert.equal(h.el('#mic-btn').disabled, false);
  assert.match(h.el('#delivery').textContent, /Transcription timed out/);
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
  assert.match(h.el('#delivery').textContent, /Could not end task/);
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
  assert.equal(h.el('#t-status').textContent,'gone', 'missing session is explicitly gone');
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
  assert.match(h.el('#start-state').textContent,/Terminal created.*setup or sign-in/);
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
  assert.match(restored.el('#startup-note').textContent,/doesn’t confirm.*accepted/);
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
