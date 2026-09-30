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

function frontend({ failSend = false, failEnd = false } = {}) {
  class Element {
    constructor() {
      this.children = []; this.dataset = {}; this.style = {}; this.value = ''; this.hidden = false;
      this.textContent = ''; this.className = ''; this.clientWidth = 0; this.scrollHeight = 0;
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
    addEventListener() {}
    click() { return this.onclick?.(); }
  }
  const elements = new Map();
  const el = (id) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const document = {
    querySelector: (s) => el(s), querySelectorAll: () => [], createElement: () => new Element(),
    documentElement: { dataset: {}, style: { setProperty() {} } }, addEventListener() {},
  };
  const calls = [], uploads = [], terminals = [], sockets = [], timers = [];
  let finishSend;
  class XHR {
    constructor() { this.upload = {}; uploads.push(this); }
    open(method, path) { this.path = path; }
    setRequestHeader() {}
    send(file) { this.file = file; }
    complete(path) { this.status = 200; this.responseText = JSON.stringify({ path }); this.onload(); }
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
  const window = { addEventListener() {}, MediaRecorder: null, visualViewport: null };
  window.parent = window;
  const context = vm.createContext({
    document, window, navigator: {}, matchMedia: () => ({ matches: true }), XMLHttpRequest: XHR,
    Terminal: FakeTerminal, WebSocket: FakeSocket, FitAddon: { FitAddon: class { fit() {} } },
    AbortController,
    location: { hash: '', protocol: 'https:', host: 'example.test' }, history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {} }, ResizeObserver: class { observe() {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, canceled: false }); return timers.length; },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].canceled = true; },
    setInterval: () => 1, clearInterval() {},
    addEventListener() {}, innerHeight: 800, fetch: async (path, opts = {}) => {
      calls.push({ path, opts });
      if (path === '/api/sessions/a/keys') await new Promise((resolve) => { finishSend = resolve; });
      const body = path === '/api/state' ? { lanes: [], sessions: [], transcribe: false } : {};
      const failed = (failSend && path === '/api/sessions/a/keys') || (failEnd && path === '/api/sessions/a/end');
      return { ok: !failed, status: failed ? 503 : 200,
        headers: { get: () => path.includes('/history') ? 'text/plain' : 'application/json' },
        json: async () => failed ? { error: 'unavailable' } : body, text: async () => '' };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'), context);
  return { context, el, calls, uploads, terminals, sockets, timers, finishSend: () => finishSend?.() };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

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
