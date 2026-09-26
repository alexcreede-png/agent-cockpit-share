'use strict';
const $ = (s) => document.querySelector(s);
const STATUS_LABEL = { working: 'working', 'needs-you': 'needs you', idle: 'idle', exited: 'exited' };
const QUICK_KEYS = [['Esc', 'Escape'], ['⏎', 'Enter'], ['↑', 'Up'], ['↓', 'Down'], ['Tab', 'Tab'],
  ['⇧Tab', 'BTab'], ['^C', 'C-c'], ['1', '1'], ['2', '2'], ['3', '3'], ['y', 'y'], ['n', 'n'], ['⌫', 'BSpace']];
const touch = matchMedia('(pointer: coarse)').matches;

let state = { lanes: [], sessions: [] };
let current = null;          // session name open in the terminal view
let term, fit, ws, pollTimer;

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
  return (res.headers.get('content-type') || '').includes('json') ? res.json() : res.text();
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });

function show(view) {
  for (const v of ['list', 'new', 'term']) $(`#${v}-view`).hidden = v !== view;
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
  } catch { $('#conn').hidden = false; }
}

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

// ---------- terminal ----------
function openTerm(name) {
  closeTerm();
  show('term');
  current = name;
  history.replaceState(null, '', '#' + name);
  $('#t-name').textContent = name;
  $('#history').hidden = true; $('#term').hidden = false; $('#hist-btn').textContent = 'History';
  disarm();
  term = new Terminal({ fontSize: touch ? 11 : 13, fontFamily: 'ui-monospace, Menlo, monospace',
    theme: { background: '#0f1115' }, cursorBlink: false, scrollback: 5000,
    disableStdin: touch, convertEol: false });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('#term'));
  fit.fit();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/attach?name=${encodeURIComponent(name)}&cols=${term.cols}&rows=${term.rows}`);
  ws.onmessage = (e) => term.write(e.data);
  ws.onclose = () => { if (current === name && term) term.write('\r\n\x1b[90m[disconnected — go back and reopen]\x1b[0m\r\n'); };
  term.onData((d) => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'in', d })));
  refresh();
}
function closeTerm() {
  current = null;
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  if (term) { term.dispose(); term = null; }
}
function refit() {
  if (!term || $('#term').hidden) return;
  fit.fit();
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'resize', c: term.cols, r: term.rows }));
}
addEventListener('resize', () => setTimeout(refit, 50));
if (window.visualViewport) visualViewport.addEventListener('resize', () => setTimeout(refit, 50));

$('#keys').replaceChildren(...QUICK_KEYS.map(([label, key]) => {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = label;
  b.onclick = () => current && post(`/api/sessions/${current}/keys`, { key }).catch(() => {});
  return b;
}));

$('#input-row').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('#input').value;
  if (!current) return;
  $('#input').value = ''; grow();
  await post(`/api/sessions/${current}/keys`, { text }).catch((err) => { $('#input').value = text; alertLine(err); });
};
const grow = () => { const t = $('#input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, innerHeight * .3) + 'px'; };
$('#input').oninput = grow;
$('#input').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !touch) { e.preventDefault(); $('#input-row').requestSubmit(); } };
const alertLine = (err) => term && term.write(`\r\n\x1b[33m[send failed: ${err.message}]\x1b[0m\r\n`);

$('#hist-btn').onclick = async () => {
  const showing = !$('#history').hidden;
  if (showing) { $('#history').hidden = true; $('#term').hidden = false; $('#hist-btn').textContent = 'History'; return refit(); }
  $('#history').textContent = 'Loading…';
  $('#history').hidden = false; $('#term').hidden = true; $('#hist-btn').textContent = 'Live';
  $('#history').textContent = await api(`/api/sessions/${current}/history?lines=3000`).catch((e) => 'Failed: ' + e.message);
  $('#history').scrollTop = $('#history').scrollHeight;
};

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
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); if (current && ws && ws.readyState !== 1) openTerm(current); } });
refresh().then(() => {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h && state.sessions.some((s) => s.name === h)) openTerm(h);
});
