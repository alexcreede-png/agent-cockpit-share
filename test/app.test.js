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

function frontend({ failSend = false, failSendStatus = 503, failEnd = false, voiceStall = false, voiceBodyStall = false, history = '', historyError = false } = {}) {
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
  }
  const elements = new Map();
  const el = (id) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const document = {
    querySelector: (s) => el(s), querySelectorAll: () => [], createElement: () => new Element(),
    documentElement: { dataset: {}, style: { setProperty() {} } }, addEventListener() {},
  };
  const calls = [], uploads = [], terminals = [], sockets = [], timers = [], observers = [];
  let historyText = history, failHistory = historyError;
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
      const body = path === '/api/state' ? { lanes: [], sessions: [], transcribe: false } : {};
      const failed = (failHistory && path.includes('/history')) || (failSend && path === '/api/sessions/a/keys') || (failEnd && path === '/api/sessions/a/end');
      return { ok: !failed, status: failed ? failSendStatus : 200,
        headers: { get: () => path.includes('/history') ? 'text/plain' : 'application/json' },
        json: async () => failed ? { error: 'unavailable' } : body,
        text: async () => path.includes('/history') ? historyText : '' };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'), context);
  return { context, el, calls, uploads, terminals, sockets, timers, observers,
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
  assert.match(h.el('#delivery').textContent, /Could not end session/);
});

test('project identity is readable while full session name stays accessible', () => {
  const h = frontend();
  vm.runInContext("projectsRoot = '/example/projects'; renderTermIdentity({ name: 'codex-agent-cockpit-1234', lane: 'codex', project: '/example/projects/agent-cockpit', status: 'working' }, 'codex-agent-cockpit-1234')", h.context);
  assert.equal(h.el('#t-name').textContent, 'agent-cockpit');
  assert.match(h.el('#t-name')['aria-label'], /codex-agent-cockpit-1234/);
  assert.equal(h.el('#t-context').textContent, 'codex · 1234');
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
