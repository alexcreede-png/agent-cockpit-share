'use strict';
const $ = (s) => document.querySelector(s);
const STATUS_LABEL = { working: 'working', 'needs-you': 'needs you', idle: 'idle', exited: 'exited' };
const QUICK_KEYS = [['Esc', 'Escape'], ['⏎', 'Enter'], ['↑', 'Up'], ['↓', 'Down'], ['Tab', 'Tab'],
  ['⇧Tab', 'BTab'], ['^C', 'C-c'], ['1', '1'], ['2', '2'], ['3', '3'], ['y', 'y'], ['n', 'n'], ['⌫', 'BSpace']];
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
const authHeaders = () => (device.get() ? { 'X-Cockpit-Device': device.get() } : {});

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...authHeaders() } });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))).error || res.status;
    if (err === 'unpaired') device.set('');
    throw new Error(err);
  }
  return (res.headers.get('content-type') || '').includes('json') ? res.json() : res.text();
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

function renderList() {
  const ul = $('#sessions');
  ul.replaceChildren(...state.sessions.map((s) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot ${s.status}"></span><span class="name"></span><span class="pill ${s.status}"></span><span class="meta"></span>`;
    li.querySelector('.name').textContent = s.name;
    li.querySelector('.pill').textContent = STATUS_LABEL[s.status] || s.status;
    li.querySelector('.meta').textContent = `${s.lane || '?'} · ${projectLabel(s.project)} · ${ago(s.created)}`;
    li.onclick = () => openTerm(s.name);
    return li;
  }));
  $('#empty').hidden = state.sessions.length > 0;
  const needs = state.sessions.filter((s) => s.status === 'needs-you').length;
  const working = state.sessions.filter((s) => s.status === 'working').length;
  $('#summary').textContent = state.sessions.length ? `${working} working · ${needs} need you` : '';
  document.title = needs ? `(${needs}) Agent Cockpit` : 'Agent Cockpit';
}

async function refresh() {
  try {
    state = await api('/api/state');
    projectsRoot = state.projectsRoot || '';
    $('#conn').hidden = true;
    renderList();
    if (current) {
      const s = state.sessions.find((x) => x.name === current);
      const pill = $('#t-status');
      pill.className = 'pill ' + (s ? s.status : 'exited');
      pill.textContent = s ? STATUS_LABEL[s.status] : 'gone';
    }
  } catch (e) {
    if (e.message === 'unpaired') { if ($('#pair-view').hidden) show('pair'); return; }
    $('#conn').hidden = false;
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
    location.reload();
  } catch (e) {
    $('#pair-err').textContent = e.message === 'unpaired' ? 'Not paired.' : 'Wrong or expired code. Run npm run pair again.';
  }
};

// ---------- new session ----------
let pick = { lane: null, project: null }, projects = [];
$('#new-btn').onclick = async () => {
  show('new');
  $('#new-err').textContent = '';
  $('#lanes').replaceChildren(...state.lanes.map((l) => {
    const b = document.createElement('button');
    b.textContent = l;
    b.className = pick.lane === l ? 'on' : '';
    b.onclick = () => { pick.lane = l; [...$('#lanes').children].forEach((c) => c.className = c === b ? 'on' : ''); ready(); };
    return b;
  }));
  projects = await api('/api/projects').catch(() => []);
  renderProjects();
};
function renderProjects() {
  const q = $('#project-filter').value.toLowerCase();
  $('#projects').replaceChildren(...projects.filter((p) => p.label.toLowerCase().includes(q)).slice(0, 80).map((p) => {
    const li = document.createElement('li');
    li.textContent = p.label;
    li.className = pick.project === p.path ? 'on' : '';
    li.onclick = () => { pick.project = p.path; renderProjects(); ready(); };
    return li;
  }));
}
$('#project-filter').oninput = renderProjects;
const ready = () => $('#start-btn').disabled = !(pick.lane && pick.project);
$('#start-btn').onclick = async () => {
  $('#start-btn').disabled = true;
  try {
    const { name } = await post('/api/sessions', { lane: pick.lane, project: pick.project, prompt: $('#prompt').value });
    $('#prompt').value = '';
    await refresh();
    openTerm(name);
  } catch (e) { $('#new-err').textContent = 'Could not start: ' + e.message; ready(); }
};

// ---------- session view ----------
// Two ways to look at a session. "Read" is the scrollable transcript (tmux scrollback) refreshed
// while you watch: the phone's default, because swiping works. "Live" is the real terminal.
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
let mode = store.get('cockpit-mode') || (touch ? 'read' : 'live');
let readTimer = null, lastText = '', lastSize = '', wsRetry = 0, wsTimer = null;
let pending = [];   // uploads waiting to go out with the next message: { name, path, pct }

function openTerm(name) {
  closeTerm();
  show('term');
  current = name;
  history.replaceState(null, '', '#' + name);
  $('#t-name').textContent = name;
  disarm();
  pending = []; renderPending();
  lastSize = '';
  setMode(mode);
  refresh();
}

function closeTerm() {
  current = null;
  if (rec) rec.stop();
  stopReader(); stopLive();
}

function setMode(m) {
  mode = m; store.set('cockpit-mode', m);
  $('#mode-btn').textContent = m === 'read' ? 'Live' : 'Read';
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
  post(`/api/sessions/${current}/size`, { cols, rows }).catch(() => {});
}

// --- read view
const nearBottom = (el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
async function pullReader() {
  if (!current || mode !== 'read') return;
  const name = current;
  let text;
  try { text = await api(`/api/sessions/${name}/history?lines=3000`); } catch { return; }
  if (name !== current || mode !== 'read') return;
  text = text.replace(/\s+$/, '');
  if (text === lastText) return;
  const el = $('#reader'), stick = !lastText || nearBottom(el);
  lastText = text;
  el.textContent = text;
  if (stick) el.scrollTop = el.scrollHeight;
  $('#to-bottom').hidden = nearBottom(el);
}
function startReader() {
  lastText = '';
  $('#reader').textContent = 'Loading…';
  fitSession();
  pullReader();
  readTimer = setInterval(pullReader, 1500);
}
function stopReader() { clearInterval(readTimer); readTimer = null; }
$('#reader').addEventListener('scroll', () => { $('#to-bottom').hidden = nearBottom($('#reader')); }, { passive: true });
$('#to-bottom').onclick = () => { const el = $('#reader'); el.scrollTop = el.scrollHeight; $('#to-bottom').hidden = true; };

// --- live terminal (reconnects by itself)
function startLive() {
  term = new Terminal({ fontSize: touch ? 11 : 13, fontFamily: 'ui-monospace, Menlo, monospace',
    theme: { background: '#0f1115' }, cursorBlink: false, scrollback: 5000, disableStdin: touch });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('#term'));
  fit.fit();
  term.onData((d) => ws && ws.readyState === 1 && ws.send(JSON.stringify({ t: 'in', d })));
  wsRetry = 0;
  connect(current);
}
function connect(name) {
  if (current !== name || mode !== 'live' || !term) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const tok = device.get();
  const sock = new WebSocket(`${proto}://${location.host}/ws/attach?name=${encodeURIComponent(name)}&cols=${term.cols}&rows=${term.rows}`,
    tok ? ['cockpit', 'dev.' + tok] : undefined);
  ws = sock;
  sock.onopen = () => { wsRetry = 0; note(''); lastSize = ''; fitSession(); };
  sock.onmessage = (e) => term && term.write(e.data);
  sock.onclose = () => {
    if (ws !== sock || current !== name || mode !== 'live') return;
    ws = null;
    note('Reconnecting…');
    wsTimer = setTimeout(() => connect(name), Math.min(1000 * 2 ** wsRetry++, 10000));
  };
}
function stopLive() {
  clearTimeout(wsTimer);
  if (ws) { const s = ws; ws = null; s.onclose = null; s.close(); }
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
  const h = window.visualViewport ? visualViewport.height : innerHeight;
  document.documentElement.style.setProperty('--app-h', h + 'px');
  if (window.scrollY) window.scrollTo(0, 0);
}
let fitTimer;
const onResize = () => { syncViewport(); clearTimeout(fitTimer); fitTimer = setTimeout(refit, 150); };
addEventListener('resize', onResize);
if (window.visualViewport) visualViewport.addEventListener('resize', onResize);
syncViewport();

// --- quick keys
$('#keys').replaceChildren(...QUICK_KEYS.map(([label, key]) => {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = label;
  b.onclick = () => current && post(`/api/sessions/${current}/keys`, { key }).then(() => setTimeout(pullReader, 300)).catch(() => {});
  return b;
}));

// --- message box: text plus any uploaded file paths, sent as one message
$('#input-row').onsubmit = async (e) => {
  e.preventDefault();
  if (!current) return;
  if (pending.some((p) => !p.path)) return flash('Still uploading…');
  const typed = $('#input').value.trim();
  const sent = pending;
  const text = [typed, ...sent.map((p) => p.path)].filter(Boolean).join(' ');
  $('#input').value = ''; grow();
  pending = []; renderPending();
  try {
    await post(`/api/sessions/${current}/keys`, { text });
    if (mode === 'read') { const el = $('#reader'); el.scrollTop = el.scrollHeight; setTimeout(pullReader, 400); }
  } catch (err) {
    $('#input').value = typed; grow();
    pending = sent; renderPending();
    flash('Send failed: ' + err.message);
  }
};
const grow = () => { const t = $('#input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, innerHeight * .3) + 'px'; };
$('#input').oninput = grow;
$('#input').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !touch) { e.preventDefault(); $('#input-row').requestSubmit(); } };

// --- attachments (photo library, camera or Files on iOS)
$('#attach-btn').onclick = () => current && $('#file').click();
$('#file').onchange = async () => {
  const files = [...$('#file').files];
  $('#file').value = '';
  const name = current;
  for (const f of files) {
    if (state.uploadMaxMB && f.size > state.uploadMaxMB * 1048576) { flash(`${f.name} is over ${state.uploadMaxMB} MB`); continue; }
    const item = { name: f.name || 'photo', path: null, pct: 0 };
    pending.push(item); renderPending();
    try {
      item.path = (await upload(name, f, (pct) => { item.pct = pct; renderPending(); })).path;
    } catch (err) {
      pending = pending.filter((x) => x !== item);
      flash('Upload failed: ' + err.message);
    }
    renderPending();
  }
};
function upload(name, file, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', `/api/sessions/${name}/upload`);
    for (const [k, v] of Object.entries(authHeaders())) x.setRequestHeader(k, v);
    x.setRequestHeader('X-Filename', encodeURIComponent(file.name || 'photo.jpg'));
    x.setRequestHeader('Content-Type', 'application/octet-stream');
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round(100 * e.loaded / e.total)); };
    x.onload = () => {
      let b = {}; try { b = JSON.parse(x.responseText); } catch {}
      x.status === 200 ? resolve(b) : reject(new Error(b.error || `HTTP ${x.status}`));
    };
    x.onerror = () => reject(new Error('network error'));
    x.send(file);
  });
}
function renderPending() {
  const row = $('#attach-row');
  row.hidden = !pending.length;
  row.replaceChildren(...pending.map((it) => {
    const chip = document.createElement('span');
    chip.className = 'chip' + (it.path ? '' : ' busy');
    const label = document.createElement('span');
    label.textContent = it.path ? it.name : `${it.name} · ${it.pct}%`;
    const x = document.createElement('button');
    x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', 'Remove ' + it.name);
    x.onclick = () => { pending = pending.filter((p) => p !== it); renderPending(); };
    chip.append(label, x);
    return chip;
  }));
}

// --- dictation: record on the phone, transcribe on the Mac, drop the text in the box to review
let rec = null, recStart = 0, recTick = null;
const canRecord = () => !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
$('#mic-btn').onclick = async () => {
  if (rec) { rec.stop(); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { return flash('Microphone blocked. Allow it for this site in Safari settings.'); }
  const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
  const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks = [];
  r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  r.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(recTick);
    rec = null;
    const blob = new Blob(chunks, { type: (r.mimeType || type || 'audio/mp4').split(';')[0] });
    if (!current || !blob.size) return micState('idle');
    micState('busy');
    try {
      const res = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': blob.type, ...authHeaders() }, body: blob });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b.error || `HTTP ${res.status}`);
      if (b.text) { const i = $('#input'); i.value = (i.value.trim() ? i.value.trim() + ' ' : '') + b.text; grow(); }
      else flash('Didn’t catch anything');
    } catch (err) { flash('Transcription failed: ' + err.message); }
    micState('idle');
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
function disarm() { clearTimeout(armTimer); $('#kill-btn').classList.remove('armed'); $('#kill-btn').textContent = 'End'; }
$('#kill-btn').onclick = async () => {
  const b = $('#kill-btn');
  if (!b.classList.contains('armed')) { b.classList.add('armed'); b.textContent = 'Tap to end'; armTimer = setTimeout(disarm, 3000); return; }
  disarm();
  const name = current;
  await post(`/api/sessions/${name}/end`).catch(() => {});
  show('list');
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
refresh().then(() => {
  $('#mic-btn').hidden = !(state.transcribe && canRecord());
  const h = decodeURIComponent(location.hash.slice(1));
  if (h && state.sessions.some((s) => s.name === h)) openTerm(h);
});
