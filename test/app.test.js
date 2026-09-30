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
  const calls = [], uploads = [];
  let finishSend;
  class XHR {
    constructor() { this.upload = {}; uploads.push(this); }
    open(method, path) { this.path = path; }
    setRequestHeader() {}
    send(file) { this.file = file; }
    complete(path) { this.status = 200; this.responseText = JSON.stringify({ path }); this.onload(); }
  }
  const window = { addEventListener() {}, MediaRecorder: null, visualViewport: null };
  window.parent = window;
  const context = vm.createContext({
    document, window, navigator: {}, matchMedia: () => ({ matches: true }), XMLHttpRequest: XHR,
    AbortController,
    location: { hash: '', protocol: 'https:', host: 'example.test' }, history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {} }, ResizeObserver: class { observe() {} },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
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
  return { context, el, calls, uploads, finishSend: () => finishSend?.() };
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
