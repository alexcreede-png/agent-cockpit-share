'use strict';
const $ = (s) => document.querySelector(s);
const STATUS_LABEL = { working: 'working', 'needs-you': 'needs you', idle: 'idle', exited: 'exited' };
const QUICK_KEYS = [['Esc', 'Escape'], ['⏎', 'Enter'], ['↑', 'Up'], ['↓', 'Down'], ['Tab', 'Tab'],
  ['⇧Tab', 'BTab'], ['^C', 'C-c'], ['1', '1'], ['2', '2'], ['3', '3'], ['y', 'y'], ['n', 'n'], ['⌫', 'BSpace']];
const MESSAGE_MAX_CHARS = 20000, PROMPT_MAX_CHARS = 8000;
const touch = matchMedia('(pointer: coarse)').matches;

let state = { lanes: [], sessions: [] };
let current = null;          // session name open in the terminal view
let term, fit, ws, pollTimer;

// Paired-device token. Normally a cookie carries it; inside another site's frame (e.g. a dashboard app)
// the browser blocks that cookie, so the page keeps the token and sends it as a header.
const DEVICE_KEY = 'cockpit-device';
const device = {
  get() { try { return localStorage.getItem(DEVICE_KEY) || ''; } catch { return ''; } },
  set(v) { try { v ? localStorage.setItem(DEVICE_KEY, v) : localStorage.removeItem(DEVICE_KEY); } catch {} },
};
// ---------- embedding ----------
// Inside another site's frame (e.g. a dashboard app) WebKit may drop this frame's storage when
// the app closes. The parent page keeps a copy of the token and hands it back on load. Messages
// only ever go to, and are only accepted from, the origins allowed to frame us.
const framed = window.parent !== window;
if (framed) document.documentElement.dataset.embedded = 'true';
const BOOT_MS = Date.now();
let embedOrigins = [];
function tellParent(msg) {
  if (!framed) return;
  for (const o of embedOrigins) { try { window.parent.postMessage(msg, o); } catch {} }
}
window.addEventListener('message', (e) => {
  if (!framed || e.source !== window.parent || !embedOrigins.includes(e.origin)) return;
  const d = e.data || {};
  if (d.type === 'cockpit-device' && typeof d.token === 'string' && /^[A-Za-z0-9_-]{20,}$/.test(d.token)
      && d.token !== device.get()) {
    device.set(d.token);
    if (!$('#pair-view').hidden) show('list'); else refresh();
  }
});
const embedReady = framed
  ? fetch('/api/embed-origins').then((r) => r.json()).then((o) => { embedOrigins = Array.isArray(o) ? o : []; }).catch(() => {})
  : Promise.resolve();

const authHeaders = () => (device.get() ? { 'X-Cockpit-Device': device.get() } : {});

async function api(path, opts = {}) {
  const sent = device.get();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(path, { ...opts, signal: controller.signal, headers: { 'Content-Type': 'application/json', ...authHeaders() } });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))).error || res.status;
      // Only a token the server refused (e.g. revoked) is reported; merely having none yet is not,
      // or the parent would drop the copy it is about to hand back.
      if (err === 'unpaired' && sent) { device.set(''); tellParent({ type: 'cockpit-unpaired' }); }
      const error = new Error(err);
      error.status = res.status;
      throw error;
    }
    return (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  } finally {
    clearTimeout(timeout);
  }
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });

function show(view) {
  for (const v of ['list', 'new', 'term', 'pair']) $(`#${v}-view`).hidden = v !== view;
  if (view !== 'term') closeTerm();
  if (view === 'list') { history.replaceState(null, '', '#'); refresh(); }
}
document.querySelectorAll('[data-go]').forEach((b) => b.onclick = () => show(b.dataset.go));

// ---------- list ----------
function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}
let projectsRoot = '';
const projectLabel = (p) => {
  p = p || '';
  const root = projectsRoot.toLowerCase() + '/';
  return root.length > 1 && p.toLowerCase().startsWith(root) ? p.slice(root.length) : p;
};
const displayProject = (s) => s && projectLabel(s.project) || s?.name || '';
const shortSession = (name) => name.split('-').at(-1) || name.slice(-8);

function renderTermIdentity(s, name = current) {
  $('#t-name').textContent = displayProject(s) || name;
  $('#t-name').title = s ? `${displayProject(s)} — ${name}` : name;
  $('#t-name').setAttribute('aria-label', s ? `${displayProject(s)}, session ${name}` : name);
  $('#t-context').textContent = s ? `${s.lane || 'session'} · ${shortSession(name)}` : shortSession(name);
  const pill = $('#t-status');
  pill.className = 'pill ' + (s ? s.status : 'idle');
  pill.textContent = s ? STATUS_LABEL[s.status] || s.status : 'starting';
}

function renderList() {
  const ul = $('#sessions');
  const q = $('#session-search').value.trim().toLocaleLowerCase();
  const visible = state.sessions.filter((s) => `${s.name} ${s.lane || ''} ${projectLabel(s.project)}`.toLocaleLowerCase().includes(q));
  const existing = new Map([...ul.children].map((li) => [li.dataset.name, li]));
  visible.forEach((s, index) => {
    let li = existing.get(s.name);
    if (!li) {
      li = document.createElement('li');
      li.dataset.name = s.name;
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'session-button';
      b.innerHTML = '<span class="dot"></span><span class="name"></span><span class="pill"></span><span class="meta"></span>';
      b.onclick = () => openTerm(s.name);
      li.append(b);
    }
    const b = li.firstElementChild;
    b.querySelector('.dot').className = `dot ${s.status}`;
    b.querySelector('.name').textContent = displayProject(s);
    b.querySelector('.pill').className = `pill ${s.status}`;
    b.querySelector('.pill').textContent = STATUS_LABEL[s.status] || s.status;
    b.querySelector('.meta').textContent = `${s.lane || '?'} · ${shortSession(s.name)} · ${ago(s.created)}`;
    b.setAttribute('aria-label', `${displayProject(s)}, ${STATUS_LABEL[s.status] || s.status}, ${s.lane || 'unknown lane'}, session ${s.name}`);
    b.title = `${displayProject(s)} — ${s.name}`;
    if (ul.children[index] !== li) ul.insertBefore(li, ul.children[index] || null);
    existing.delete(s.name);
  });
  for (const li of existing.values()) li.remove();
  $('#list-state').hidden = !q || visible.length > 0;
  $('#list-state').textContent = q && !visible.length ? 'No matching sessions.' : '';
  $('#empty').hidden = state.sessions.length > 0 || !!q;
  const needs = state.sessions.filter((s) => s.status === 'needs-you').length;
  const working = state.sessions.filter((s) => s.status === 'working').length;
  $('#summary').textContent = state.sessions.length ? `${working} working · ${needs} need you` : '';
  document.title = needs ? `(${needs}) Agent Cockpit` : 'Agent Cockpit';
}
$('#session-search').oninput = renderList;

function connection(value) {
  const el = $('#connection-state');
  const text = value === 'connected' ? 'Connected' : value === 'reconnecting' ? 'Reconnecting…' : 'Offline';
  if (el.textContent !== text) el.textContent = text;
  el.setAttribute('aria-label', el.textContent);
  el.dataset.state = value;
}

let refreshBusy = false;
async function refresh() {
  if (refreshBusy) return;
  refreshBusy = true;
  try {
    const next = await api('/api/state');
    state = next;
    projectsRoot = state.projectsRoot || '';
    $('#conn').hidden = true;
    renderList();
    if (current && (mode !== 'live' || (ws && ws.readyState === 1))) connection('connected');
    if (current) {
      const s = state.sessions.find((x) => x.name === current);
      if (s) renderTermIdentity(s);
      else { $('#t-status').className = 'pill exited'; $('#t-status').textContent = 'gone'; }
    }
  } catch (e) {
    if (e.message === 'unpaired') {
      // Framed: the parent may still be handing back a token it kept; don't flash the pair screen.
      if (framed && Date.now() - BOOT_MS < 3000) { setTimeout(refresh, 500); return; }
      if ($('#pair-view').hidden) show('pair');
      return;
    }
    $('#conn').hidden = false;
    if (current) connection('offline');
    $('#list-state').hidden = true;
  } finally {
    refreshBusy = false;
  }
}

// ---------- pairing ----------
// This phone has no device cookie yet: trade the one-time code from `npm run pair` for one.
$('#pair-form').onsubmit = async (ev) => {
  ev.preventDefault();
  $('#pair-err').textContent = '';
  try {
    const r = await post('/api/pair', { code: $('#pair-code').value });
    device.set(r.token);
    tellParent({ type: 'cockpit-device', token: r.token });
    location.reload();
  } catch (e) {
    $('#pair-err').textContent = e.message === 'unpaired' ? 'Not paired.' : 'Wrong or expired code. Run npm run pair again.';
  }
};

// ---------- new session ----------
let pick = { lane: null, project: null }, projects = [], projectsLoading = false, starting = false, projectLoadId = 0;
$('#new-btn').onclick = async () => {
  const loadId = ++projectLoadId;
  show('new');
  $('#new-err').textContent = '';
  projectsLoading = true;
  $('#project-state').textContent = 'Loading projects…';
  $('#projects').replaceChildren();
  $('#lanes').replaceChildren(...state.lanes.map((l) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = l;
    b.className = pick.lane === l ? 'on' : '';
    b.setAttribute('aria-pressed', String(pick.lane === l));
    b.onclick = () => {
      pick.lane = l;
      [...$('#lanes').children].forEach((c) => { c.classList.toggle('on', c === b); c.setAttribute('aria-pressed', String(c === b)); });
      ready();
    };
    return b;
  }));
  ready();
  try {
    const loaded = await api('/api/projects');
    if (loadId !== projectLoadId) return;
    projects = loaded;
    projectsLoading = false;
    if (pick.project && !projects.some((p) => p.path === pick.project)) pick.project = null;
    renderProjects(); ready();
  } catch (err) {
    if (loadId !== projectLoadId) return;
    projectsLoading = false;
    projects = [];
    $('#project-state').textContent = 'Could not load projects. Go back and try again. ' + err.message;
    ready();
  }
};
function renderProjects() {
  if (projectsLoading) { $('#project-state').textContent = 'Loading projects…'; return; }
  const q = $('#project-filter').value.toLowerCase();
  const matches = projects.filter((p) => p.label.toLowerCase().includes(q));
  $('#projects').replaceChildren(...matches.slice(0, 80).map((p) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = p.label;
    b.className = pick.project === p.path ? 'on' : '';
    b.setAttribute('aria-pressed', String(pick.project === p.path));
    b.onclick = () => {
      pick.project = p.path;
      $('#projects').querySelectorAll('button').forEach((c) => { c.classList.toggle('on', c === b); c.setAttribute('aria-pressed', String(c === b)); });
      ready();
    };
    li.append(b);
    return li;
  }));
  $('#project-state').textContent = !projects.length ? 'No projects available.' : !matches.length ? 'No matching projects.' : matches.length > 80 ? `Showing first 80 of ${matches.length} projects. Refine your search.` : '';
}
$('#project-filter').oninput = () => { pick.project = null; renderProjects(); ready(); };
const ready = () => $('#start-btn').disabled = starting || projectsLoading || !(pick.lane && pick.project);
$('#start-btn').onclick = async () => {
  if (starting || $('#start-btn').disabled) return;
  if ($('#prompt').value.length > PROMPT_MAX_CHARS) {
    $('#new-err').textContent = 'First message is too long. Use 8,000 characters or fewer; your draft is kept.';
    return;
  }
  starting = true;
  $('#start-btn').disabled = true; $('#start-btn').textContent = 'Starting…';
  $('#new-err').textContent = '';
  try {
    const { name } = await post('/api/sessions', { lane: pick.lane, project: pick.project, prompt: $('#prompt').value });
    $('#prompt').value = '';
    await refresh();
    openTerm(name, { name, lane: pick.lane, project: pick.project, status: 'idle' });
  } catch (e) { $('#new-err').textContent = 'Could not start: ' + e.message; }
  finally { starting = false; $('#start-btn').textContent = 'Start'; ready(); }
};

// ---------- session view ----------
// Two ways to look at a session. "Read" is the scrollable transcript (tmux scrollback) refreshed
// while you watch: the phone's default, because swiping works. "Live" is the real terminal.
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
let mode = store.get('cockpit-mode') || ((framed || touch) ? 'read' : 'live');
let readerEpoch = 0, readerBusy = false;
let readTimer = null, lastText = null, lastSize = '', wsRetry = 0, wsTimer = null;
let liveEpoch = 0;
// Session names come from the server. Composer data remains in memory for this page only.
const composers = new Map();
const composer = (name) => {
  if (!composers.has(name)) composers.set(name, { draft: '', pending: [], feedback: { text: '', error: false } });
  return composers.get(name);
};
const activeComposer = () => current ? composer(current) : null;

function openTerm(name, session = state.sessions.find((s) => s.name === name)) {
  closeTerm();
  show('term');
  current = name;
  history.replaceState(null, '', '#' + name);
  renderTermIdentity(session, name);
  micState('idle');
  const c = composer(name);
  $('#input').value = c.draft;
  grow();
  renderPending();
  delivery(c.feedback.text, c.feedback.error);
  $('#send-btn').disabled = sending.has(name);
  $('#send-btn').textContent = sending.has(name) ? 'Sending…' : 'Send';
  disarm();
  connection('reconnecting');
  lastSize = '';
  setMode(mode);
  refresh();
}

function closeTerm() {
  if (current) composer(current).draft = $('#input').value;
  current = null;
  closeShortKeys(false);
  if (rec && rec.state === 'recording') rec.stop();
  stopReader(); stopLive();
}

function setMode(m) {
  mode = m; store.set('cockpit-mode', m);
  $('#mode-btn').textContent = m === 'read' ? 'Live' : 'Read';
  $('#mode-btn').setAttribute('aria-label', m === 'read' ? 'Switch to live terminal' : 'Switch to readable output');
  $('#reader').hidden = m !== 'read';
  $('#term').hidden = m !== 'live';
  $('#to-bottom').hidden = true;
  if (m === 'read') { stopLive(); startReader(); } else { stopReader(); startLive(); }
}
$('#mode-btn').onclick = () => current && setMode(mode === 'read' ? 'live' : 'read');

// Size the tmux window to what the phone can show, so agents wrap their output to fit.
function charBox(el) {
  const probe = document.createElement('span');
  probe.textContent = 'M'.repeat(40);
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
  el.appendChild(probe);
  const r = probe.getBoundingClientRect();
  probe.remove();
  return { w: r.width / 40, h: r.height };
}
function fitSession() {
  if (!current) return;
  let cols, rows;
  if (mode === 'live' && term) { cols = term.cols; rows = term.rows; }
  else {
    const el = $('#reader');
    if (!el.clientWidth) return;
    const cs = getComputedStyle(el), box = charBox(el);
    cols = Math.floor((el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) / box.w);
    rows = 60;   // read view scrolls, so rows only set how much of the screen stays "live"
  }
  const key = `${current}:${cols}x${rows}`;
  if (key === lastSize) return;
  lastSize = key;
  post(`/api/sessions/${current}/size`, { cols, rows }).catch(() => { if (lastSize === key) lastSize = ''; });
}

// --- read view
const nearBottom = (el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
let readerHeight = 0, readerFollow = true;
function compactReadHistory(text) {
  const out = [], blank = [];
  const flush = () => { out.push(...(blank.length >= 4 ? ['', ''] : blank)); blank.length = 0; };
  for (const line of text.replace(/\s+$/, '').split('\n')) {
    if (line.trim()) { flush(); out.push(line); }
    else blank.push(line);
  }
  flush();
  return out.join('\n');
}
function readerState(text, busy = false) {
  const status = $('#reader-state');
  if (status.textContent !== text) status.textContent = text;
  $('#reader').setAttribute('aria-busy', String(busy));
}
async function pullReader() {
  if (!current || mode !== 'read' || readerBusy) return;
  const name = current, epoch = readerEpoch;
  readerBusy = true;
  let text;
  try {
    text = await api(`/api/sessions/${name}/history?lines=3000`);
    if (name === current && epoch === readerEpoch) { note(''); connection('connected'); }
  } catch {
    if (name === current && epoch === readerEpoch) {
      note('Connection lost — retrying…'); connection('offline');
      readerState('Output unavailable. Retrying automatically.');
      if (lastText === null) $('#reader').textContent = 'Output unavailable. Retrying…';
    }
    return;
  } finally { if (epoch === readerEpoch) readerBusy = false; }
  if (name !== current || mode !== 'read' || epoch !== readerEpoch) return;
  text = compactReadHistory(text);
  readerState(text ? 'Output available.' : 'No output yet.');
  if (text === lastText) return;
  const el = $('#reader'), stick = lastText === null || readerFollow || nearBottom(el);
  lastText = text;
  el.textContent = text || 'No output yet.';
  if (stick) el.scrollTop = el.scrollHeight;
  readerFollow = stick;
  $('#to-bottom').hidden = nearBottom(el);
}
function startReader() {
  lastText = null;
  readerFollow = true;
  readerHeight = $('#reader').clientHeight;
  $('#reader').textContent = 'Loading…';
  readerState('Loading session output…', true);
  fitSession();
  pullReader();
  readTimer = setInterval(pullReader, 1500);
}
function stopReader() { clearInterval(readTimer); readTimer = null; readerEpoch++; readerBusy = false; }
$('#reader').addEventListener('scroll', () => {
  const el = $('#reader');
  // A resize may dispatch a native scroll event before ResizeObserver runs.
  if (el.clientHeight === readerHeight) readerFollow = nearBottom(el);
  $('#to-bottom').hidden = nearBottom(el);
}, { passive: true });
function scrollReaderToBottom() {
  const el = $('#reader');
  readerFollow = true;
  el.scrollTop = el.scrollHeight;
  $('#to-bottom').hidden = true;
}
$('#to-bottom').addEventListener('pointerdown', (e) => {
  if (document.activeElement !== $('#input')) return;
  e.preventDefault(); // Keep the iOS keyboard open; WebKit may suppress click after this.
  scrollReaderToBottom();
});
$('#to-bottom').onclick = scrollReaderToBottom;
// Preserve an at-bottom view when the keyboard changes the iframe height.
new ResizeObserver(() => {
  if (!current || mode !== 'read') return;
  const el = $('#reader'), resized = el.clientHeight !== readerHeight;
  readerHeight = el.clientHeight;
  if (resized && readerFollow) el.scrollTop = el.scrollHeight;
  $('#to-bottom').hidden = nearBottom(el);
}).observe($('#reader'));

// --- live terminal (reconnects by itself)
const liveActive = (name, terminal, epoch) =>
  current === name && mode === 'live' && term === terminal && liveEpoch === epoch;
function startLive() {
  const name = current, epoch = ++liveEpoch;
  connection('reconnecting');
  term = new Terminal({ fontSize: touch ? 11 : 13, fontFamily: 'ui-monospace, Menlo, monospace',
    theme: { background: '#0f1115' }, cursorBlink: false, scrollback: 5000, disableStdin: touch });
  const terminal = term;
  fit = new FitAddon.FitAddon();
  terminal.loadAddon(fit);
  terminal.open($('#term'));
  fit.fit();
  terminal.onData((d) => {
    if (!liveActive(name, terminal, epoch)) return;
    const sock = ws;
    if (sock && sock.readyState === 1) sock.send(JSON.stringify({ t: 'in', d }));
  });
  wsRetry = 0;
  connect(name, terminal, epoch);
}
function connect(name, terminal = term, epoch = liveEpoch) {
  if (!liveActive(name, terminal, epoch) || (ws && ws.readyState < 2)) return;
  clearTimeout(wsTimer);
  wsTimer = null;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const tok = device.get();
  const sock = new WebSocket(`${proto}://${location.host}/ws/attach?name=${encodeURIComponent(name)}&cols=${terminal.cols}&rows=${terminal.rows}`,
    tok ? ['cockpit', 'dev.' + tok] : undefined);
  const activeSocket = () => liveActive(name, terminal, epoch) && ws === sock;
  ws = sock;
  sock.onopen = () => {
    if (!activeSocket()) return;
    wsRetry = 0; note(''); connection('connected'); lastSize = ''; fitSession();
  };
  sock.onmessage = (e) => { if (activeSocket()) terminal.write(e.data); };
  sock.onclose = () => {
    if (!activeSocket()) return;
    ws = null;
    note('Reconnecting…');
    connection('reconnecting');
    const timer = setTimeout(() => {
      if (!liveActive(name, terminal, epoch) || wsTimer !== timer) return;
      wsTimer = null;
      connect(name, terminal, epoch);
    }, Math.min(1000 * 2 ** wsRetry++, 10000));
    wsTimer = timer;
  };
}
function stopLive() {
  liveEpoch++;
  clearTimeout(wsTimer);
  wsTimer = null;
  if (ws) { const s = ws; ws = null; s.onopen = s.onmessage = s.onclose = null; s.close(); }
  if (term) { term.dispose(); term = null; $('#term').replaceChildren(); }
  note('');
}
function refit() {
  if (!current) return;
  if (mode === 'live' && term) {
    fit.fit();
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'resize', c: term.cols, r: term.rows }));
  }
  fitSession();
}

// Status line over the session (reconnecting, upload errors, …).
let noteTimer;
function note(text, ms) {
  clearTimeout(noteTimer);
  $('#conn-note').textContent = text;
  $('#conn-note').hidden = !text;
  if (text && ms) noteTimer = setTimeout(() => note(''), ms);
}
const flash = (text) => note(text, 3500);

// Keep the layout pinned to the visible area (iOS keyboard, rubber-band scrolling).
function syncViewport() {
  const h = Math.min(innerHeight, window.visualViewport ? visualViewport.height : innerHeight);
  document.documentElement.style.setProperty('--app-h', h + 'px');
  if (window.scrollY) window.scrollTo(0, 0);
}
let fitTimer;
const onResize = () => { syncViewport(); clearTimeout(fitTimer); fitTimer = setTimeout(refit, 150); };
addEventListener('resize', onResize);
if (window.visualViewport) visualViewport.addEventListener('resize', onResize);
syncViewport();

// --- quick keys: the common actions fit without horizontal scrolling.
$('#keys').replaceChildren(...QUICK_KEYS.map(([label, key], index) => {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = label;
  b.setAttribute('aria-label', key === 'Enter' ? 'Submit current terminal input' : key);
  if (index > 3) b.className = 'extra-key';
  b.onclick = () => {
    if (current) post(`/api/sessions/${current}/keys`, { key })
      .then(() => { if (key === 'Enter') delivery('Enter sent to terminal'); setTimeout(pullReader, 300); })
      .catch((err) => delivery('Key failed: ' + err.message, true));
    closeShortKeys();
  };
  return b;
}));
const moreKeys = document.createElement('button');
moreKeys.type = 'button'; moreKeys.textContent = 'More keys'; moreKeys.setAttribute('aria-expanded', 'false');
moreKeys.onclick = () => {
  const expanded = $('#keys').classList.toggle('expanded');
  moreKeys.textContent = expanded ? 'Fewer keys' : 'More keys';
  moreKeys.setAttribute('aria-expanded', String(expanded));
  refit();
};
$('#keys').append(moreKeys);
const keysToggle = $('#keys-toggle');
function closeShortKeys(restoreFocus = true) {
  if (!$('#keys').classList.contains('short-open')) return;
  $('#keys').classList.remove('short-open');
  keysToggle.setAttribute('aria-expanded', 'false');
  keysToggle.setAttribute('aria-label', 'Show terminal keys');
  if (restoreFocus) keysToggle.focus();
}
keysToggle.onclick = () => {
  if ($('#keys').classList.contains('short-open')) closeShortKeys();
  else {
    $('#keys').classList.add('short-open');
    keysToggle.setAttribute('aria-expanded', 'true');
    keysToggle.setAttribute('aria-label', 'Hide terminal keys');
    $('#keys button').focus();
  }
};

function delivery(text, error = false) {
  const el = $('#delivery');
  el.textContent = text; el.hidden = !text; el.classList.toggle('error', error);
}
function sessionDelivery(name, text, error = false) {
  composer(name).feedback = { text, error };
  if (current === name) delivery(text, error);
}
const sending = new Set();
// Keep the draft visible until delivery succeeds. Never automatically retry an uncertain send.
$('#input-row').onsubmit = async (e) => {
  e.preventDefault();
  const name = current;
  if (!name || sending.has(name)) return;
  const c = composer(name);
  if (c.pending.some((p) => !p.path)) return delivery('Still uploading…');
  const draft = c.draft;
  const sent = [...c.pending];
  const text = [draft.trim(), ...sent.map((p) => p.path)].filter(Boolean).join('\n');
  if (!text) return;
  if (text.length > MESSAGE_MAX_CHARS) {
    sessionDelivery(name, 'Message is too long. Use 20,000 characters or fewer including attachment paths; your draft is kept.', true);
    return;
  }
  sending.add(name);
  $('#send-btn').disabled = true; $('#send-btn').textContent = 'Sending…';
  sessionDelivery(name, 'Sending to terminal…');
  try {
    await post(`/api/sessions/${name}/keys`, { text });
    if (c.draft === draft) c.draft = '';
    c.pending = c.pending.filter((p) => !sent.includes(p));
    sessionDelivery(name, 'Sent to terminal');
    if (current !== name) return;
    $('#input').value = c.draft; grow(); renderPending();
    if (mode === 'read') { const el = $('#reader'); el.scrollTop = el.scrollHeight; setTimeout(pullReader, 400); }
  } catch (err) {
    sessionDelivery(name, err.status === 413
      ? 'Message not sent. ' + err.message + ' Your draft is kept.'
      : 'Delivery unconfirmed. Check output before retrying. ' + err.message, true);
  } finally {
    sending.delete(name);
    if (current === name) { $('#send-btn').disabled = false; $('#send-btn').textContent = 'Send'; }
  }
};
const grow = () => { const t = $('#input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, innerHeight * .3) + 'px'; };
$('#input').oninput = () => { if (current) composer(current).draft = $('#input').value; grow(); };
$('#input').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !touch) { e.preventDefault(); $('#input-row').requestSubmit(); } };

// --- attachments (photo library, camera or Files on iOS)
const UPLOAD_TIMEOUT_MS = 60000;
let fileOwner = null;
$('#attach-btn').onclick = () => { if (current) { fileOwner = current; $('#file').click(); } };
$('#file').onchange = async () => {
  const files = [...$('#file').files];
  $('#file').value = '';
  const name = fileOwner || current;
  fileOwner = null;
  if (!name) return;
  const c = composer(name);
  for (const f of files) {
    if (state.uploadMaxMB && f.size > state.uploadMaxMB * 1048576) { if (current === name) flash(`${f.name} is over ${state.uploadMaxMB} MB`); continue; }
    const item = { name: f.name || 'photo', path: null, pct: 0, abort: null, removed: false };
    c.pending.push(item); if (current === name) renderPending();
    try {
      item.path = (await upload(name, f, (pct) => { item.pct = pct; if (current === name) renderPending(); },
        (abort) => { item.abort = abort; })).path;
    } catch (err) {
      c.pending = c.pending.filter((x) => x !== item);
      if (!item.removed) {
        sessionDelivery(name, 'Upload failed: ' + err.message + '. Draft kept; attach again if needed.', true);
        if (current === name) flash('Upload failed: ' + err.message);
      }
    }
    item.abort = null;
    if (current === name) renderPending();
  }
};
function upload(name, file, onProgress, onAbortReady) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', `/api/sessions/${name}/upload`);
    x.timeout = UPLOAD_TIMEOUT_MS;
    onAbortReady(() => x.abort());
    for (const [k, v] of Object.entries(authHeaders())) x.setRequestHeader(k, v);
    x.setRequestHeader('X-Filename', encodeURIComponent(file.name || 'photo.jpg'));
    x.setRequestHeader('Content-Type', 'application/octet-stream');
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round(100 * e.loaded / e.total)); };
    x.onload = () => {
      let b = {}; try { b = JSON.parse(x.responseText); } catch {}
      x.status === 200 ? resolve(b) : reject(new Error(b.error || `HTTP ${x.status}`));
    };
    x.onerror = () => reject(new Error('network error'));
    x.ontimeout = () => reject(new Error('timed out'));
    x.onabort = () => reject(new Error('canceled'));
    x.send(file);
  });
}
function renderPending() {
  const row = $('#attach-row');
  const pending = activeComposer()?.pending || [];
  row.hidden = !pending.length;
  row.replaceChildren(...pending.map((it) => {
    const chip = document.createElement('span');
    chip.className = 'chip' + (it.path ? '' : ' busy');
    const label = document.createElement('span');
    label.textContent = it.path ? it.name : `${it.name} · ${it.pct}%`;
    const x = document.createElement('button');
    x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', 'Remove ' + it.name);
    x.onclick = () => {
      const c = activeComposer();
      if (c) {
        it.removed = true;
        c.pending = c.pending.filter((p) => p !== it);
        it.abort?.();
        renderPending();
      }
    };
    chip.append(label, x);
    return chip;
  }));
}

// --- dictation: record on the phone, transcribe on the Mac, drop the text in the box to review
const TRANSCRIBE_TIMEOUT_MS = 60000;
let rec = null, recStart = 0, recTick = null, requestingMic = false;
const canRecord = () => !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
$('#mic-btn').onclick = async () => {
  if (rec) { if (rec.state === 'recording') rec.stop(); return; }
  const name = current;
  if (!name || requestingMic) return;
  requestingMic = true;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { if (current === name) flash('Microphone blocked. Allow it for this site in Safari settings.'); return; }
  finally { requestingMic = false; }
  if (current !== name) { stream.getTracks().forEach((t) => t.stop()); return; }
  const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
  const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks = [];
  r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  r.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(recTick);
    rec = null;
    const blob = new Blob(chunks, { type: (r.mimeType || type || 'audio/mp4').split(';')[0] });
    if (!blob.size) { if (current === name) micState('idle'); return; }
    if (current === name) micState('busy');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
    try {
      const res = await fetch('/api/transcribe', { method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': blob.type, ...authHeaders() }, body: blob });
      const b = await res.json().catch((err) => { if (controller.signal.aborted) throw err; return {}; });
      if (!res.ok) throw new Error(b.error || `HTTP ${res.status}`);
      if (b.text) {
        const c = composer(name);
        c.draft = (c.draft.trim() ? c.draft.trim() + ' ' : '') + b.text;
        if (current === name) { $('#input').value = c.draft; grow(); }
      } else if (current === name) flash('Didn’t catch anything');
    } catch (err) {
      const message = controller.signal.aborted ? 'Transcription timed out. Try again.' : 'Transcription failed: ' + err.message;
      sessionDelivery(name, message, true);
      if (current === name) flash(message);
    } finally {
      clearTimeout(timeout);
      if (current === name) micState('idle');
    }
  };
  rec = r;
  r.start();
  recStart = Date.now();
  micState('rec');
  recTick = setInterval(() => micState('rec'), 500);
};
function micState(s) {
  const b = $('#mic-btn');
  b.classList.toggle('rec', s === 'rec');
  b.classList.toggle('busy', s === 'busy');
  b.disabled = s === 'busy';
  const secs = Math.floor((Date.now() - recStart) / 1000);
  $('#mic-label').textContent = s === 'rec' ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : s === 'busy' ? '…' : '';
  b.setAttribute('aria-label', s === 'rec' ? 'Stop and transcribe' : 'Dictate');
}

// Two taps to end a session; no browser confirm dialog.
let armTimer;
let ending = false;
function disarm() { clearTimeout(armTimer); $('#kill-btn').classList.remove('armed'); $('#kill-btn').textContent = 'End'; }
$('#kill-btn').onclick = async () => {
  const b = $('#kill-btn');
  if (ending || !current) return;
  if (!b.classList.contains('armed')) { b.classList.add('armed'); b.textContent = 'Tap to end'; armTimer = setTimeout(disarm, 3000); return; }
  disarm();
  const name = current;
  ending = true; b.disabled = true; b.textContent = 'Ending…';
  try {
    await post(`/api/sessions/${name}/end`);
    if (current === name) show('list');
    composers.delete(name);
  } catch (err) {
    sessionDelivery(name, 'Could not end session. It may still be running. ' + err.message, true);
  } finally { ending = false; b.disabled = false; disarm(); }
};

// ---------- boot ----------
pollTimer = setInterval(refresh, 3000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  refresh();
  if (!current) return;
  if (mode === 'live' && (!ws || ws.readyState > 1)) { clearTimeout(wsTimer); wsRetry = 0; connect(current); }
  else pullReader();
});
// Framed: send our token to the parent (so it can restore it later), or say hello so it can
// hand back a token it kept.
embedReady.then(() => tellParent(device.get() ? { type: 'cockpit-device', token: device.get() } : { type: 'cockpit-hello' }));
refresh().then(() => {
  $('#mic-btn').hidden = !(state.transcribe && canRecord());
  const h = decodeURIComponent(location.hash.slice(1));
  if (h && state.sessions.some((s) => s.name === h)) openTerm(h);
});
