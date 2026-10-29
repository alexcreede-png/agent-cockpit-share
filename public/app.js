'use strict';
const $ = (s) => document.querySelector(s);
const STATUS_LABEL = { working: 'Working', 'needs-you': 'Needs you', idle: 'Idle', exited: 'Ended' };
const ASSISTANTS = {
  grok: { name: 'Grok', hint: 'Work with Grok in your project.' },
  agy: { name: 'Gemini / Antigravity', hint: 'Opens Antigravity on your Mac. Its selected model may vary.' },
  claude: { name: 'Claude', hint: 'Work with Claude in your project.' },
  codex: { name: 'Codex', hint: 'Work with Codex in your project.' },
  shell: { name: 'Terminal', hint: 'Advanced: opens a command line on your Mac.' },
};
const assistantName = (lane) => ASSISTANTS[lane]?.name || lane || 'Assistant';
const QUICK_KEYS = [['Escape', 'Escape'], ['Enter', 'Enter'], ['↑', 'Up'], ['↓', 'Down'], ['Tab', 'Tab'],
  ['⇧Tab', 'BTab'], ['^C', 'C-c'], ['1', '1'], ['2', '2'], ['3', '3'], ['y', 'y'], ['n', 'n'], ['⌫', 'BSpace']];
const MESSAGE_MAX_CHARS = 20000, PROMPT_MAX_CHARS = 8000;
const touch = matchMedia('(pointer: coarse)').matches;

let state = { lanes: [], sessions: [] };
let stateLoaded = false, pendingRoute = null;
// Positive start receipts outlive a stale list, until a newer state request validates them.
const confirmedStarts = new Map();
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
      const body = await res.json().catch(() => ({}));
      const err = body.error || res.status;
      // Only a token the server refused (e.g. revoked) is reported; merely having none yet is not,
      // or the parent would drop the copy it is about to hand back.
      if (err === 'unpaired' && sent) { device.set(''); tellParent({ type: 'cockpit-unpaired' }); }
      const error = new Error(err);
      error.status = res.status;
      error.code = body.code; error.requestId = body.requestId; error.sessionName = body.name;
      throw error;
    }
    return (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  } finally {
    clearTimeout(timeout);
  }
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });

let activeView = 'list', viewEpoch = 0;
function routeURL(view, name, replace = false) {
  const hash = view === 'new' ? '#@new' : view === 'term' ? '#' + encodeURIComponent(name) : '#';
  if (location.hash !== hash) history[replace ? 'replaceState' : 'pushState'](null, '', hash);
}
function show(view, recordHistory = true, preserveURL = false) {
  pendingRoute = null;
  activeView = view; viewEpoch++;
  for (const v of ['list', 'new', 'term', 'pair']) $(`#${v}-view`).hidden = v !== view;
  if (view !== 'term') closeTerm();
  if (!preserveURL && (view === 'list' || view === 'new')) routeURL(view, null, !recordHistory);
  if (view === 'list') refresh();
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
// Exact start time distinguishes same-project tasks without relying on internal IDs.
function taskTime(s) {
  const peers = state.sessions.filter(x => x.project === s.project && x.lane === s.lane);
  return peers.length > 1 ? new Date(s.created).toLocaleString([], {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
  }) : ago(s.created);
}


// Start timestamps have second precision. Distinguish simultaneous same-project tasks
// with their existing name suffix, never an ordinal that changes as rows move or end.
function taskTag(s) {
  if (!s) return '';
  const peers = state.sessions.filter(x => x.project === s.project && x.lane === s.lane
    && Math.floor(x.created / 1000) === Math.floor(s.created / 1000));
  if (peers.length < 2) return '';
  const short = x => /-([0-9a-f]{4}|[0-9a-f]{32})$/.exec(x.name)?.[1].slice(-6) || x.name;
  const tag = short(s);
  return peers.some(x => x.name !== s.name && short(x) === tag) ? s.name : tag;
}
function taskContext(s) {
  const tag = taskTag(s);
  return `${assistantName(s.lane)}${tag ? ` · Task ${tag}` : ''}`;
}

function renderTermIdentity(s, name = current) {
  $('#t-name').textContent = displayProject(s) || name;
  $('#t-name').title = s ? `${displayProject(s)} — ${name}` : name;
  $('#t-name').setAttribute('aria-label', s ? displayProject(s) : 'Task');
  $('#t-context').textContent = s ? taskContext(s) : 'Starting task';
  const pill = $('#t-status');
  pill.className = 'pill ' + (s ? s.status : 'idle');
  pill.textContent = s ? STATUS_LABEL[s.status] || s.status : 'starting';
  const attentionChanged = needsResponse !== (s?.status === 'needs-you');
  needsResponse = s?.status === 'needs-you';
  $('#keys-toggle').textContent = needsResponse ? 'Respond' : 'Controls';
  if (attentionChanged && current) {
    const wasReading = mode === 'read' && (readTimer !== null || readerBusy);
    actionState(current).generation++; // Cancel responses queued for the previous attention state.
    stopReader(); // A previous conversation/question cannot own this attention state.
    closeShortKeys(false);
    if (wasReading) startReader();
    renderTaskControls();
  }
  renderStartupHelp();
}

function renderList() {
  const ul = $('#sessions');
  const q = $('#session-search').value.trim().toLocaleLowerCase();
  const visible = state.sessions.filter((s) => `${s.name} ${assistantName(s.lane)} ${projectLabel(s.project)}`.toLocaleLowerCase().includes(q));
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
    b.querySelector('.meta').textContent = `${taskContext(s)} · ${taskTime(s)}`;
    b.setAttribute('aria-label', `${displayProject(s)}, ${STATUS_LABEL[s.status] || s.status}, ${taskContext(s)}, ${taskTime(s)}`);
    b.title = `${displayProject(s)} — ${s.name}`;
    if (ul.children[index] !== li) ul.insertBefore(li, ul.children[index] || null);
    existing.delete(s.name);
  });
  for (const li of existing.values()) li.remove();
  $('#list-state').hidden = !q || visible.length > 0;
  $('#list-state').textContent = q && !visible.length ? 'No matching tasks.' : '';
  $('#empty').hidden = state.sessions.length > 0 || !!q;
  const needs = state.sessions.filter((s) => s.status === 'needs-you').length;
  const working = state.sessions.filter((s) => s.status === 'working').length;
  $('#summary').textContent = state.sessions.length ? `${state.sessions.length} ${state.sessions.length === 1 ? 'task' : 'tasks'} · ${working} working · ${needs} need you` : 'Tasks run on your Mac.';
  document.title = needs ? `(${needs}) Agent Cockpit` : 'Agent Cockpit';
}
$('#session-search').oninput = renderList;

function connection(value) {
  const el = $('#connection-state');
  const text = value === 'ended' ? 'Ended / unavailable' : value === 'connected' ? 'Connected' : value === 'reconnecting' ? 'Reconnecting…' : 'Offline';
  if (el.textContent !== text) el.textContent = text;
  el.setAttribute('aria-label', el.textContent);
  el.dataset.state = value;
}

let refreshBusy = false;
async function refresh() {
  if (refreshBusy) return;
  refreshBusy = true;
  const viewed = current, epoch = viewEpoch;
  const requestedDictations = new Map(dictations);
  const requestedStarts = new Map(confirmedStarts);
  try {
    const next = await api('/api/state');
    const lanesChanged = JSON.stringify(state.lanes) !== JSON.stringify(next.lanes);
    const recoveryChanged = state.startRecovery !== next.startRecovery;
    for (const [name, session] of requestedStarts) {
      if (confirmedStarts.get(name) === session) confirmedStarts.delete(name);
    }
    state = { ...next, sessions: [...next.sessions] }; stateLoaded = true;
    for (const [name, session] of confirmedStarts) {
      if (!state.sessions.some(s => s.name === name)) state.sessions.push(session);
    }
    // This response can only settle background recordings it was requested for.
    // The current task is reconciled below through the view-generation guard.
    for (const [name, recording] of requestedDictations) {
      if (name === current || dictations.get(name) !== recording) continue;
      const task = state.sessions.find(s => s.name === name);
      if (!task || task.dead || task.status === 'exited') settleTask(name);
    }
    if (activeView === 'new' && (lanesChanged || recoveryChanged)) { renderAssistants(); ready(); }
    projectsRoot = state.projectsRoot || '';
    $('#conn').hidden = true;
    renderList();
    if (current && mode === 'live' && ws && ws.readyState === 1) connection('connected');
    if (current && current === viewed && viewEpoch === epoch) {
      const s = state.sessions.find((x) => x.name === current);
      if (!s || s.dead || s.status === 'exited') settleTask(current);
      else if (!endedTasks.has(current)) renderTermIdentity(s);
    }
    const deferred = pendingRoute; pendingRoute = null;
    if (deferred && deferred.hash === location.hash && deferred.epoch === viewEpoch) restoreRoute();
  } catch (e) {
    if (e.message === 'unpaired') {
      // Framed: the parent may still be handing back a token it kept; don't flash the pair screen.
      if (framed && Date.now() - BOOT_MS < 3000) { setTimeout(refresh, 500); return; }
      if ($('#pair-view').hidden) show('pair');
      return;
    }
    $('#conn').hidden = false;
    if (current && !endedTasks.has(current)) connection('offline');
    $('#list-state').hidden = true;
  } finally {
    refreshBusy = false;
  }
}

// ---------- pairing ----------
// This phone has no device cookie yet: trade the one-time code from `npm run pair` for one.
let pairingBusy = false;
$('#pair-form').onsubmit = async (ev) => {
  ev.preventDefault();
  if (pairingBusy) return;
  pairingBusy = true;
  const button = $('#pair-submit');
  button.disabled = true; button.textContent = 'Connecting…';
  $('#pair-err').textContent = '';
  try {
    const r = await post('/api/pair', { code: $('#pair-code').value });
    device.set(r.token);
    tellParent({ type: 'cockpit-device', token: r.token });
    location.reload();
  } catch (e) {
    $('#pair-err').textContent = e.message === 'wrong or expired code'
      ? 'That code is incorrect or has expired. Get a new code from your Mac and try again.'
      : e.message === 'forbidden'
        ? 'This connection is not allowed. Open Cockpit through Tailscale and try again.'
        : 'Couldn’t confirm the connection. Reload this page. If it still asks for a code, get a new one from your Mac.';
  } finally {
    pairingBusy = false;
    button.disabled = false; button.textContent = 'Connect this phone';
  }
};

// ---------- new session ----------
let pick = { lane: null, project: null }, projects = [], projectsLoading = false, starting = false, projectLoadId = 0;
let projectsFailed = false;
// Only one pending launch is kept, in this tab, for at most 24 hours. No device token or
// terminal/composer data belongs here. A retry always uses this frozen original request.
const START_KEY = 'cockpit-pending-start-v1', START_MAX_CHARS = 131072, START_MAX_AGE = 24 * 60 * 60 * 1000;
let pendingStart = null, pendingProblem = '', recoverySaved = false, recoveryNotice = '', draftRevision = 0;
function validPending(value) {
  const r = value?.request;
  return value && Object.keys(value).sort().join(',') === 'created,draft,filter,request,version'
    && value.version === 1 && Number.isFinite(value.created)
    && Date.now() - value.created <= START_MAX_AGE && value.created <= Date.now() + 60000
    && r && Object.keys(r).sort().join(',') === 'lane,project,prompt,requestId'
    && Object.hasOwn(ASSISTANTS, r.lane) && typeof r.project === 'string'
    && r.project.startsWith('/') && r.project.length <= 4096 && !/[\x00-\x1f\x7f]/.test(r.project)
    && typeof r.prompt === 'string' && r.prompt.length <= PROMPT_MAX_CHARS
    && (r.lane !== 'shell' || r.prompt === '')
    && typeof r.requestId === 'string' && r.requestId.length >= 16 && r.requestId.length <= 128 && !/[^A-Za-z0-9_-]/.test(r.requestId)
    && typeof value.draft === 'string' && value.draft.length <= PROMPT_MAX_CHARS
    && (r.lane === 'shell' || value.draft === r.prompt)
    && typeof value.filter === 'string' && value.filter.length <= 256;
}
function freezePending(value) { Object.freeze(value.request); return Object.freeze(value); }
function savePending() {
  recoverySaved = false;
  try {
    const raw = JSON.stringify(pendingStart);
    if (!validPending(pendingStart) || raw.length > START_MAX_CHARS) return;
    sessionStorage.setItem(START_KEY, raw);
    recoverySaved = sessionStorage.getItem(START_KEY) === raw;
  } catch { /* In-memory checking still works; the UI must explain reload limits. */ }
}
function removePending() {
  try { sessionStorage.removeItem(START_KEY); } catch {}
  recoverySaved = false;
}
function restorePending() {
  try {
    const raw = sessionStorage.getItem(START_KEY);
    if (!raw) return;
    if (raw.length > START_MAX_CHARS) throw new Error('oversized');
    const value = JSON.parse(raw);
    if (!validPending(value)) throw new Error('invalid or expired');
    pendingStart = freezePending(value); recoverySaved = true;
    pick = { lane: value.request.lane, project: value.request.project };
    $('#prompt').value = value.draft; $('#project-filter').value = value.filter;
  } catch {
    removePending();
    recoveryNotice = 'Saved start recovery is unavailable or expired. Check Your tasks before starting again.';
  }
}
function recoveryUI() {
  const pending = !!pendingStart;
  $('#new-btn').textContent = $('#empty-new-btn').textContent = pending ? 'Check start' : 'New task';
  $('#pending-list').textContent = pending ? 'A start needs checking. Use Check start to recover it.' : recoveryNotice;
  $('#pending-list').hidden = !$('#pending-list').textContent;
  $('#pending-info').textContent = pending
    ? 'This start is kept unchanged. Check start uses the same request; it won’t open a second terminal. '
      + (recoverySaved ? 'Saved in this tab for up to 24 hours; closing the tab may lose recovery.' : 'Reload recovery is unavailable. Keep this page open to check this start.')
    : recoveryNotice;
  // Capability is required even for a restored request: an older server may ignore its ID.
  if (pending && state.startRecovery !== true) $('#pending-info').textContent =
    'This Mac can’t safely check the saved start right now. Check Your tasks or reconnect to the updated Mac. '
    + (recoverySaved ? 'The original request is kept in this tab.' : 'Keep this page open; reload recovery is unavailable.');
  $('#start-capability').textContent = !pending && state.startRecovery !== true
    ? 'Start checks aren’t available on this Mac. If a start is unconfirmed, check Your tasks before trying again.' : '';
  $('#different-task').hidden = !pending;
  if (!pending) $('#different-confirm').hidden = true;
  $('#prompt').disabled = pending || pick.lane === 'shell';
  $('#project-filter').disabled = pending;
  for (const container of [$('#lanes'), $('#other-lanes')]) for (const b of container.children) b.disabled = pending;
  for (const row of $('#projects').children) row.firstElementChild.disabled = pending;
}
restorePending();
$('#prompt').oninput = () => { draftRevision++; };
$('#different-task').onclick = () => { $('#different-confirm').hidden = false; $('#confirm-different').focus(); };
$('#keep-start').onclick = () => { $('#different-confirm').hidden = true; $('#different-task').focus(); };
$('#confirm-different').onclick = () => {
  if (!pendingStart) return;
  // An explicit separate task invalidates all callbacks from the old attempt, even in flight.
  pendingStart = null; pendingProblem = ''; starting = false; draftRevision++; viewEpoch++;
  removePending(); recoveryNotice = '';
  $('#new-err').textContent = ''; $('#start-state').textContent = '';
  renderAssistants(); renderProjects(); ready(); $('#prompt').focus();
};

function renderAssistants() {
  const buttons = (lanes) => lanes.map((lane) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = assistantName(lane); b.dataset.lane = lane;
    b.className = pick.lane === lane ? 'on' : '';
    b.setAttribute('aria-pressed', String(pick.lane === lane));
    b.onclick = () => { if (pendingStart) return; pick.lane = lane; draftRevision++; updateAssistantChoice(); ready(); };
    return b;
  });
  $('#lanes').replaceChildren(...buttons(['grok', 'agy'].filter((l) => state.lanes.includes(l))));
  const others = state.lanes.filter((l) => !['grok', 'agy'].includes(l));
  $('#other-lanes').replaceChildren(...buttons(others));
  $('#more-assistants').hidden = !others.length;
  if (others.includes(pick.lane)) $('#more-assistants').open = true;
  updateAssistantChoice();
}
function updateAssistantChoice() {
  for (const container of [$('#lanes'), $('#other-lanes')]) {
    for (const b of container.children) {
      const selected = b.dataset.lane === pick.lane;
      b.classList.toggle('on', selected); b.setAttribute('aria-pressed', String(selected));
    }
  }
  $('#assistant-help').textContent = !state.lanes.length ? 'Assistants haven’t loaded. Checking the connection to your Mac…'
    : pick.lane && !state.lanes.includes(pick.lane) ? (pendingStart ? 'This assistant is unavailable. The original start is kept for checking.' : 'This assistant is unavailable. Choose another assistant.')
    : ASSISTANTS[pick.lane]?.hint || 'Choose who you’d like to work with.';
  $('#prompt-help').textContent = pick.lane === 'shell'
    ? 'Terminal opens without sending a first message. Enter commands after it opens.'
    : 'Optional. Leave this blank to open the assistant and write your message there.';
  $('#prompt').disabled = !!pendingStart || pick.lane === 'shell'; // Keep an existing assistant draft, but never send it to a shell.
}
async function loadProjects() {
  const loadId = ++projectLoadId;
  projectsLoading = true; projectsFailed = false;
  $('#retry-projects').hidden = true;
  renderProjects(); ready();
  try {
    const loaded = await api('/api/projects');
    if (loadId !== projectLoadId) return;
    projects = loaded; projectsLoading = false;
    renderProjects(); ready();
  } catch {
    if (loadId !== projectLoadId) return;
    projectsLoading = false; projectsFailed = true;
    renderProjects(); ready();
  }
}
function openNewTask(recordHistory = true) {
  show('new', recordHistory); renderAssistants(); ready();
  $('#new-view .form').scrollTop = 0;
  if (!starting && !pendingStart) $('#start-state').textContent = '';
  loadProjects(); // Navigation keeps choices, search and draft; it never starts a task.
}
$('#new-btn').onclick = () => openNewTask();
$('#empty-new-btn').onclick = () => $('#new-btn').click();
$('#retry-projects').onclick = loadProjects;
function renderProjects() {
  const q = $('#project-filter').value.trim().toLocaleLowerCase();
  const matches = projects.filter((p) => p.label.toLocaleLowerCase().includes(q));
  $('#projects').replaceChildren(...matches.slice(0, 80).map((p) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = p.label; b.dataset.project = p.path;
    b.className = pick.project === p.path ? 'on' : '';
    b.setAttribute('aria-pressed', String(pick.project === p.path));
    b.onclick = () => {
      if (pendingStart) return;
      pick.project = p.path; draftRevision++;
      for (const row of $('#projects').children) {
        const button = row.firstElementChild, selected = button.dataset.project === pick.project;
        button.classList.toggle('on', selected); button.setAttribute('aria-pressed', String(selected));
      }
      ready();
    };
    li.append(b);
    return li;
  }));
  $('#retry-projects').hidden = !projectsFailed;
  $('#project-state').textContent = projectsLoading ? 'Loading projects…' : projectsFailed
    ? 'Can’t load projects from the Mac. Your selection is kept. Try again when connected.'
    : !projects.length ? 'No projects available on the Mac.' : !matches.length ? 'No matching projects. Try another search.'
    : matches.length > 80 ? `Showing 80 of ${matches.length}. Search to narrow the list.` : '';
}
$('#project-filter').oninput = () => { renderProjects(); ready(); };
function ready() {
  const selected = projects.find((p) => p.path === pick.project);
  $('#selected-project').textContent = pick.project ? `Selected: ${selected?.label || projectLabel(pick.project)}` : 'No project selected';
  if (pick.project && !selected && !projectsLoading && !projectsFailed) $('#selected-project').textContent += pendingStart
    ? ' (not currently listed; original start kept)' : ' (unavailable — choose another project)';
  $('#selected-project').classList.toggle('has-selection', !!pick.project);
  const validProject = !!selected && !projectsLoading && !projectsFailed;
  recoveryUI();
  $('#start-btn').disabled = !!starting || (pendingStart
    ? state.startRecovery !== true || ['START_SESSION_ENDED', 'START_REQUEST_MISMATCH', 'START_INVALID_REQUEST_ID'].includes(pendingProblem)
    : !(state.lanes.includes(pick.lane) && validProject));
  $('#start-btn').textContent = starting ? (starting.checking ? 'Checking start…' : `Opening ${assistantName(starting.request.lane)}…`) : pendingStart ? 'Check start'
    : pick.lane ? `Open ${assistantName(pick.lane)}` : 'Choose an assistant';
}
$('#start-btn').onclick = async () => {
  if (starting || $('#start-btn').disabled) return;
  if (!pendingStart && pick.lane !== 'shell' && $('#prompt').value.length > PROMPT_MAX_CHARS) {
    $('#new-err').textContent = 'First message is too long. Use 8,000 characters or fewer; your draft is kept.';
    return;
  }
  const checking = !!pendingStart;
  let record = pendingStart;
  if (!record && state.startRecovery === true) {
    let requestId;
    try {
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      requestId = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    } catch {
      $('#new-err').textContent = 'Can’t prepare a safe start in this browser. Your draft is kept. Check Your tasks or reopen the app.';
      return;
    }
    record = freezePending({ version: 1, created: Date.now(), draft: $('#prompt').value,
      filter: $('#project-filter').value.slice(0, 256), request: {
        lane: pick.lane, project: pick.project, prompt: pick.lane === 'shell' ? '' : $('#prompt').value, requestId,
      } });
    pendingStart = record; pendingProblem = ''; savePending();
  }
  const request = record?.request || Object.freeze({ lane: pick.lane, project: pick.project, prompt: pick.lane === 'shell' ? '' : $('#prompt').value });
  const attempt = { request, record, checking, epoch: viewEpoch, revision: draftRevision };
  starting = attempt; ready();
  $('#start-state').textContent = checking ? 'Checking the original start on your Mac…' : `Opening ${assistantName(request.lane)} on your Mac…`;
  $('#new-err').textContent = '';
  try {
    const result = await post('/api/sessions', request);
    // A partial/old-server reply cannot establish that this exact request was confirmed.
    if (!result || typeof result.name !== 'string' || !result.name || (record && result.requestId !== request.requestId)) throw new Error('Unconfirmed start');
    if (starting !== attempt || (record && pendingStart !== record)) return;
    if (record) { pendingStart = null; pendingProblem = ''; removePending(); }
    const sameDraft = draftRevision === attempt.revision && pick.lane === request.lane && pick.project === request.project
      && $('#prompt').value === request.prompt;
    if (request.lane !== 'shell' && sameDraft && viewEpoch === attempt.epoch) $('#prompt').value = '';
    $('#start-state').textContent = 'Task opened.';
    recoveryNotice = '';
    const confirmed = { name: result.name, lane: request.lane, project: request.project, status: 'idle', created: Date.now() };
    confirmedStarts.set(result.name, confirmed);
    if (!state.sessions.some(s => s.name === result.name)) state.sessions = [...state.sessions, confirmed];
    await refresh();
    // Navigation and an intentionally newer request take priority over a late response.
    if (activeView === 'new' && viewEpoch === attempt.epoch && starting === attempt) {
      openTerm(result.name, { name: result.name, lane: request.lane, project: request.project, status: 'idle' }, true);
    }
  } catch (e) {
    if (starting !== attempt || (record && pendingStart !== record)) return;
    $('#start-state').textContent = '';
    pendingProblem = record ? e.code || '' : '';
    $('#new-err').textContent = !record
      ? (e.status >= 400 && e.status < 500
        ? 'Could not open this task. Check your assistant and project, then try again. Your choices and message are kept.'
        : 'Start wasn’t confirmed. Check Your tasks before trying again. Your choices and message are kept.')
      : e.code === 'START_SESSION_ENDED' ? 'This task has ended. Checking won’t restart it. Start a different task only if you intend to begin again.'
      : e.code === 'START_REQUEST_MISMATCH' ? 'The Mac reports different details for this start. It can’t be checked here. Check Your tasks before starting a different task.'
      : e.code === 'START_INVALID_REQUEST_ID' ? 'The Mac couldn’t use this start reference. Check Your tasks before starting a different task.'
      : e.status >= 400 && e.status < 500 && e.code !== 'START_UNCONFIRMED'
        ? 'Could not open this task. Your original choices and message are kept. Check start again, or choose a different task to change them.'
        : 'Start wasn’t confirmed. Tap Check start to check the original request. It won’t open a second terminal.';
  } finally {
    if (starting === attempt) { starting = false; ready(); }
  }
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
let needsResponse = false, outputSource = null, questionReady = false;
const questionBlocked = (name = current) => name === current && needsResponse && (!questionReady || mode !== 'read');
function invalidateQuestion() {
  questionReady = false;
  if (current && needsResponse) actionState(current).generation++;
}
// Page-only help state belongs to the task, never to a delivery acknowledgement.
const startupHelp = new Map();
function renderStartupHelp() {
  const help = startupHelp.get(current);
  const generic = !!help && !help.dismissed && !help.hasMessages;
  $('#startup-note').hidden = !!taskActions.get(current)?.uncertain || endedTasks.has(current) || (!needsResponse && !generic);
  $('#startup-help').textContent = needsResponse
    ? (questionBlocked() ? (mode === 'read' ? 'Loading the current question. You can respond when it appears.' : 'Tap Respond to read the current question before answering.') : 'Review the assistant’s question, then choose Respond.')
    : 'Review any setup questions before sending a message.';
  $('#startup-respond').hidden = !needsResponse;
  $('#dismiss-startup').hidden = needsResponse || !generic;
}
$('#dismiss-startup').onclick = () => {
  const help = startupHelp.get(current);
  if (help) help.dismissed = true;
  renderStartupHelp();
  $('#mode-btn').focus({ preventScroll: true });
};
function labelOutput(source) {
  outputSource = source;
  const label = source === 'conversation' ? 'Conversation' : source === 'terminal' ? 'Terminal output'
    : source === 'live' ? 'Live terminal' : 'Loading output…';
  $('#output-source').textContent = label;
  $('#output-source').hidden = source === 'conversation'; // The Conversation toolbar already labels this source.
  $('#reader-tools').hidden = source !== 'conversation';
  $('#reader').setAttribute('aria-label', source === 'conversation' ? 'Conversation' : 'Terminal output');
}
// Session names come from the server. Composer data remains in memory for this page only.
const composers = new Map();
const composer = (name) => {
  if (!composers.has(name)) composers.set(name, { draft: '', pending: [], feedback: { text: '', error: false } });
  return composers.get(name);
};
const activeComposer = () => current ? composer(current) : null;

// A task's queue is shared by response keys and composer sends. A rejected or
// uncertain action cancels already queued successors; they require a fresh tap.
const taskActions = new Map(), endedTasks = new Set();
// A bounded tab-local marker is written BEFORE dispatch. Reload cannot silently
// enable another Enter after an in-flight action. No input/output is stored here.
const ACTION_PENDING_KEY = 'cockpit-pending-actions-v1';
let savedActionTasks = new Set(), actionStorageUnavailable = false;
try {
  const raw = sessionStorage.getItem(ACTION_PENDING_KEY);
  if (raw) {
    if (raw.length > 16384) throw new Error('oversized');
    const names = JSON.parse(raw);
    if (!Array.isArray(names) || names.length > 64 || names.some(n => typeof n !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(n))) throw new Error('invalid');
    savedActionTasks = new Set(names);
  }
} catch { actionStorageUnavailable = true; }
function saveActionMarker(name, pending) {
  if (actionStorageUnavailable) throw new Error('Safe reload recovery is unavailable. Keep this page open; action not sent.');
  const names = new Set(savedActionTasks);
  pending ? names.add(name) : names.delete(name);
  if (names.size > 64) throw new Error('Too many unresolved tasks. Review pending task output first.');
  const raw = JSON.stringify([...names]);
  if (names.size) sessionStorage.setItem(ACTION_PENDING_KEY, raw);
  else sessionStorage.removeItem(ACTION_PENDING_KEY);
  if ((sessionStorage.getItem(ACTION_PENDING_KEY) || '[]') !== raw) throw new Error('Safe reload recovery could not be saved.');
  savedActionTasks = names;
}
function actionState(name) {
  if (!taskActions.has(name)) taskActions.set(name, { tail: Promise.resolve(), generation: 0, uncertain: savedActionTasks.has(name) ? { reloaded: true } : null, pending: 0 });
  return taskActions.get(name);
}
function renderTaskControls() {
  if (!current) return;
  const ended = endedTasks.has(current), a = actionState(current);
  const blocked = ended || !!a.uncertain || questionBlocked();
  if (blocked) closeShortKeys(false);
  renderStartupHelp();
  for (const b of $('#keys').children) if (b.dataset.key) b.disabled = blocked;
  $('#send-btn').disabled = blocked || sending.has(current);
  $('#send-btn').textContent = sending.has(current) ? 'Sending…' : 'Send';
  for (const id of ['#kill-btn', '#mode-btn', '#keys-toggle', '#startup-respond', '#attach-btn']) $(id).disabled = ended;
  for (const id of ['#keys-toggle', '#startup-respond']) $(id).disabled = ended || !!a.uncertain || (mode === 'read' && questionBlocked());
  $('#mic-btn').disabled = ended || ending || dictations.has(current) || $('#mic-btn').classList.contains('busy');
  recoveryControls.hidden = checkDelivery.hidden = reviewDelivery.hidden = !a.uncertain || ended;
  checkDelivery.hidden = checkDelivery.hidden || !a.uncertain?.request;
  checkDelivery.disabled = !!a.checking;
  reviewDelivery.disabled = !!a.checking || questionBlocked();
}
function settleTask(name) {
  endedTasks.add(name);
  discardDictation(name);
  try { saveActionMarker(name, false); } catch { /* The settled task remains disabled. */ }
  const a = actionState(name); a.generation++;
  if (current !== name) return;
  composer(name).draft = $('#input').value;
  stopReader(); stopLive(true); closeShortKeys(false);
  needsResponse = false;
  $('#t-status').className = 'pill exited'; $('#t-status').textContent = 'Ended / unavailable';
  $('#startup-note').hidden = true;
  connection('ended');
  note('');
  readerState('Task ended or unavailable. Output retries stopped.');
  sessionDelivery(name, 'Task ended or unavailable. Your draft is kept.', true);
  renderTaskControls();
}
function enqueueAction(name, payload, onAck = () => {}) {
  const a = actionState(name), generation = a.generation;
  if (endedTasks.has(name) || a.uncertain || questionBlocked(name)) return Promise.resolve(false);
  a.pending++;
  const next = a.tail.then(async () => {
    if (endedTasks.has(name) || a.uncertain || questionBlocked(name) || generation !== a.generation) return false;
    let request, attempted = false;
    try {
      // A fresh random ID and boot identity bind this exact input. Checking never
      // executes unknown input, even if the first request did not reach the Mac.
      if (!state.actionEpoch) throw new Error('Delivery checking unavailable. Refresh and review output.');
      const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
      request = { ...payload, actionId: Array.from(bytes, x => x.toString(16).padStart(2, '0')).join(''), actionEpoch: state.actionEpoch };
      saveActionMarker(name, true);
      attempted = true;
      const receipt = await post(`/api/sessions/${name}/keys`, request);
      if (receipt?.ok !== true || receipt.actionId !== request.actionId) throw new Error('Delivery receipt did not match this action.');
      saveActionMarker(name, false);
      if (!endedTasks.has(name)) onAck();
      return true;
    } catch (err) {
      if (endedTasks.has(name)) return false;
      a.generation++; // Never release queued Enter after a failed navigation/paste.
      if (err.status === 404 || err.status === 410) { settleTask(name); return false; }
      const rejected = [400, 401, 403, 413].includes(err.status) || err.code === 'ACTION_CAPACITY' || err.code === 'ACTION_INVALID';
      if (rejected || !attempted) {
        try { saveActionMarker(name, false); } catch { /* No terminal effect occurred. */ }
        sessionDelivery(name, (payload.text !== undefined ? 'Message not sent. ' : 'Key not sent. ') + err.message + ' Your draft is kept.', true);
      } else {
        a.uncertain = { request, onAck };
        if (current === name && needsResponse) {
          stopReader();
          if (mode === 'read') startReader();
        }
        sessionDelivery(name, 'Delivery unconfirmed — do not repeat Enter. Check delivery first.', true);
      }
      return false;
    } finally {
      if (current === name) renderTaskControls();
    }
  });
  a.tail = next.catch(() => {});
  return next.finally(() => { a.pending--; });
}
const checkDelivery = document.createElement('button');
checkDelivery.className = 'text-button';
checkDelivery.type = 'button'; checkDelivery.textContent = 'Check delivery'; checkDelivery.hidden = true;
const reviewDelivery = document.createElement('button');
reviewDelivery.className = 'text-button';
reviewDelivery.type = 'button'; reviewDelivery.textContent = 'Reviewed — enable actions'; reviewDelivery.hidden = true;
reviewDelivery.setAttribute('aria-label', 'I reviewed current output; enable new actions with previous delivery still unconfirmed');
const recoveryControls = document.createElement('div');
recoveryControls.className = 'reader-tools'; recoveryControls.hidden = true;
recoveryControls.append(checkDelivery, reviewDelivery);
$('#term-view').append(recoveryControls);
checkDelivery.onclick = async () => {
  const name = current;
  if (!name || endedTasks.has(name)) return;
  const a = actionState(name), uncertain = a.uncertain;
  if (!uncertain?.request || a.checking) return;
  a.checking = true; renderTaskControls();
  try {
    const receipt = await post(`/api/sessions/${name}/keys`, { ...uncertain.request, check: true });
    if (receipt?.ok !== true || receipt.actionId !== uncertain.request.actionId) throw new Error('Delivery receipt did not match this action.');
    if (endedTasks.has(name) || a.uncertain !== uncertain) return;
    saveActionMarker(name, false);
    a.uncertain = null; uncertain.onAck();
    sessionDelivery(name, 'Delivery confirmed to terminal. Cancelled actions were not sent. Review current output before responding.');
  } catch (err) {
    if (err.status === 404 || err.status === 410) settleTask(name);
    else if (!endedTasks.has(name)) sessionDelivery(name, 'Delivery still unconfirmed. ' + err.message + ' Review output; do not repeat Enter automatically.', true);
  } finally { a.checking = false; if (current === name) renderTaskControls(); }
};
reviewDelivery.onclick = () => {
  if (!current || endedTasks.has(current)) return;
  const a = actionState(current);
  if (a.checking || questionBlocked()) return;
  try { saveActionMarker(current, false); } catch {
    sessionDelivery(current, 'Reload recovery could not be cleared. Controls remain disabled; keep this page open.', true); return;
  }
  a.uncertain = null; a.generation++;
  sessionDelivery(current, 'Previous delivery remains unconfirmed. New actions may repeat its effect; choose only after reviewing output.', true);
  renderTaskControls();
};

function openTerm(name, session = state.sessions.find((s) => s.name === name), justCreated = false, recordHistory = true) {
  if (justCreated && session?.lane !== 'shell' && !startupHelp.has(name)) {
    startupHelp.set(name, { dismissed: false, hasMessages: false });
  }
  closeTerm();
  show('term');
  current = name;
  routeURL('term', name, !recordHistory);
  renderTermIdentity(session, name);
  micState('idle');
  renderDictation();
  const c = composer(name);
  $('#input').value = c.draft;
  grow();
  renderPending();
  delivery(c.feedback.text, c.feedback.error, c.feedback.openBrowser);
  if (actionState(name).uncertain?.reloaded) sessionDelivery(name, 'Previous delivery is unconfirmed after reload. This page cannot check its receipt. Review current output before enabling new actions; do not repeat Enter automatically.', true);
  renderTaskControls();
  disarm();
  connection('reconnecting');
  lastSize = '';
  if (endedTasks.has(name) || session?.dead || session?.status === 'exited') {
    // Output belongs only to the open view. Reopening does not retain transcripts.
    $('#reader').hidden = false; $('#term').hidden = true;
    $('#reader').classList.add('empty-output');
    $('#reader').textContent = 'No output retained for this ended task.\n\nOutput is available only while you keep the task open.';
    $('#answer-start').hidden = $('#to-bottom').hidden = true;
    labelOutput('terminal');
    settleTask(name);
  } else setMode(mode);
  refresh();
}

function closeTerm() {
  micGeneration++;
  if (current) composer(current).draft = $('#input').value;
  stopReader();
  current = null;
  needsResponse = false;
  $('#reader').textContent = '';
  $('#reader').classList.remove('conversation');
  $('#reader').classList.remove('empty-output');
  lastText = null;
  closeShortKeys(false);
  if (rec && rec.state === 'recording') rec.stop();
  stopLive();
}

function setMode(m) {
  if (endedTasks.has(current)) return;
  stopReader(); closeShortKeys(false);
  mode = m; store.set('cockpit-mode', m);
  $('#mode-btn').textContent = m === 'read' ? 'Live' : 'Read';
  $('#mode-btn').setAttribute('aria-label', m === 'read' ? 'Switch to live terminal' : 'Switch to readable output');
  $('#reader').hidden = m !== 'read';
  $('#answer-start').hidden = true;
  labelOutput(m === 'live' ? 'live' : null);
  renderStartupHelp();
  $('#term').hidden = m !== 'live';
  $('#to-bottom').hidden = true;
  if (m === 'read') { stopLive(); startReader(); } else startLive();
  renderTaskControls();
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
  if (!current || endedTasks.has(current)) return;
  let cols, rows;
  if (mode === 'live' && term) { cols = term.cols; rows = term.rows; }
  else {
    const el = $('#reader');
    if (!el.clientWidth) return;
    const cs = getComputedStyle(el), box = charBox(el);
    cols = Math.floor((el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) / box.w);
    // Grok’s centered startup dialog clips content at phone terminal widths.
    // Read wraps the captured text; Live still uses the actual terminal geometry.
    if (state.sessions.find(s => s.name === current)?.lane === 'grok') cols = Math.max(100, cols);
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
function renderConversation(el, messages) {
  el.classList.add('conversation');
  $('#reader-tools').hidden = false;
  const existing = new Map(Array.from(el.children).map(n => [n.dataset.messageId, n]));
  if (!el.querySelector('.message')) el.textContent = '';
  for (const message of messages) {
    let node = existing.get(message.id);
    if (!node) {
      node = document.createElement('article');
      node.className = 'message ' + (message.role === 'user' ? 'user' : 'assistant');
      node.dataset.messageId = message.id;
      const label = document.createElement('div'); label.className = 'message-label';
      label.textContent = message.role === 'user' ? 'You' : 'Assistant';
      const body = document.createElement('div'); body.className = 'message-body';
      node.append(label, body); el.appendChild(node);
    }
    existing.delete(message.id);
    node.className = 'message ' + (message.role === 'user' ? 'user' : 'assistant');
    node.querySelector('.message-label').textContent = message.role === 'user' ? 'You' : 'Assistant';
    const body = node.querySelector('.message-body');
    if (body.dataset.text !== message.text) {
      body.dataset.text = message.text;
      body.textContent = '';
      const blocks = message.text.split(/```[^\n]*\n([\s\S]*?)(?:```|$)/g);
      blocks.forEach((text, i) => {
        const block = document.createElement(i % 2 ? 'pre' : 'div');
        block.textContent = text; body.appendChild(block);
      });
    }
  }
  for (const node of existing.values()) node.remove();
  if (!messages.length) el.textContent = 'Your conversation will appear here.';
  $('#answer-start').hidden = !messages.some(m => m.role === 'assistant');
}
function latestAnswerStart() {
  const el = $('#reader'), answers = el.querySelectorAll('.message.assistant');
  if (!answers.length) return;
  readerFollow = false;
  el.scrollTop = Math.max(0, answers[answers.length - 1].offsetTop - 12);
  $('#to-bottom').hidden = nearBottom(el);
}
$('#answer-start').onclick = latestAnswerStart;
$('#answer-start').addEventListener('pointerdown', e => {
  if (document.activeElement === $('#input')) { e.preventDefault(); latestAnswerStart(); }
});
function compactReadHistory(text, lane) {
  // Preserve the request verbatim, removing only centering whitespace from the observed
  // Grok startup dialog. Never infer a permission or send a response from captured text.
  if (lane === 'grok' && text.includes('Do you trust the contents of this directory?')
      && text.includes('Grok Build may run or modify contents')
      && /Yes, proceed\s+y/.test(text) && /No, quit\s+n/.test(text)) {
    text = text.split('\n').map(line => line.trimStart()).join('\n');
  }
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
  if (!current || endedTasks.has(current) || mode !== 'read' || readerBusy) return;
  const name = current, epoch = readerEpoch, reviewQuestion = needsResponse;
  readerBusy = true;
  let text;
  try {
    // Setup/approval questions and their choices live in the terminal, even when
    // an owned saved conversation exists. Never replace that question with old chat.
    text = await api(`/api/sessions/${name}/history?lines=3000${reviewQuestion ? '' : '&format=reader'}`);
    if (name === current && epoch === readerEpoch) { note(''); connection('connected'); }
  } catch (err) {
    if (name === current && epoch === readerEpoch) {
      if (err.status === 404 || err.status === 410) { settleTask(name); return; }
      if (reviewQuestion) { invalidateQuestion(); renderTaskControls(); }
      note('Connection lost — retrying…'); connection('offline');
      readerState('Output unavailable. Retrying automatically.');
      if (lastText === null) $('#reader').textContent = 'Output unavailable. Retrying…';
    }
    return;
  } finally { if (epoch === readerEpoch) readerBusy = false; }
  if (name !== current || mode !== 'read' || epoch !== readerEpoch || reviewQuestion !== needsResponse) return;
  // A raw question must be nonempty terminal text, never a saved conversation.
  if (reviewQuestion && (typeof text !== 'string' || !text.trim())) {
    invalidateQuestion(); renderTaskControls();
    $('#reader').textContent = 'Current question unavailable. Retrying…';
    lastText = null;
    readerState('Current question unavailable. Response keys disabled.');
    return;
  }
  const conversation = text && typeof text === 'object' && text.source === 'conversation' && Array.isArray(text.messages) ? text : null;
  const messages = conversation ? conversation.messages : null;
  const source = conversation ? 'conversation' : 'terminal';
  const sourceChanged = outputSource !== source;
  labelOutput(source);
  // The owned conversation proves these displayed messages exist. It says nothing
  // about a later pending send, and never changes task status or delivery feedback.
  if (messages?.some(m => m.role === 'user' || m.role === 'assistant')) {
    const help = startupHelp.get(name);
    if (help) help.hasMessages = true;
    renderStartupHelp();
  }
  text = conversation ? JSON.stringify(messages) : compactReadHistory(typeof text === 'string' ? text : '', state.sessions.find(s => s.name === name)?.lane);
  readerState(text ? 'Output available.' : 'No output yet.');
  const el = $('#reader'), resized = el.clientHeight !== readerHeight;
  readerHeight = el.clientHeight;
  if (text === lastText && !sourceChanged) {
    if (resized && readerFollow) el.scrollTop = el.scrollHeight;
    if (reviewQuestion) { questionReady = true; renderTaskControls(); }
    return;
  }
  const stick = lastText === null || readerFollow || nearBottom(el);
  const first = lastText === null, oldTop = el.scrollTop;
  lastText = text;
  if (conversation) {
    renderConversation(el, messages);
    if (first) latestAnswerStart();
    else {
      // Keep the start of a growing answer readable instead of chasing its last line.
      el.scrollTop = oldTop;
      readerFollow = nearBottom(el);
    }
  } else {
    el.classList.remove('conversation');
    $('#answer-start').hidden = true;
    el.textContent = text || 'No output yet.';
    if (stick) el.scrollTop = el.scrollHeight;
    readerFollow = stick;
  }
  $('#to-bottom').hidden = nearBottom(el);
  if (reviewQuestion) { questionReady = true; renderTaskControls(); }
}
function startReader() {
  connection('reconnecting');
  lastText = null;
  readerFollow = true;
  readerHeight = $('#reader').clientHeight;
  $('#reader').classList.remove('conversation');
  $('#answer-start').hidden = true;
  labelOutput(null);
  $('#reader').textContent = 'Loading…';
  readerState('Loading task output…', true);
  fitSession();
  pullReader();
  readTimer = setInterval(pullReader, 1500);
}
function stopReader() { invalidateQuestion(); clearInterval(readTimer); readTimer = null; readerEpoch++; readerBusy = false; }
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
// WKWebView can perform a separate mouse/touch focus transfer after pointerdown.
for (const [button, action] of [[$('#to-bottom'), scrollReaderToBottom], [$('#answer-start'), latestAnswerStart]]) {
  button.addEventListener('mousedown', e => e.preventDefault());
  button.addEventListener('touchstart', e => {
    if (document.activeElement === $('#input')) {
      e.preventDefault(); action(); $('#input').focus({ preventScroll: true });
    }
  }, { passive: false });
}

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
  current === name && !endedTasks.has(name) && mode === 'live' && term === terminal && liveEpoch === epoch;
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
    if (!liveActive(name, terminal, epoch) || questionBlocked(name) || actionState(name).uncertain || actionState(name).pending) return;
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
function stopLive(preserveOutput = false) {
  liveEpoch++;
  clearTimeout(wsTimer);
  wsTimer = null;
  if (ws) { const s = ws; ws = null; s.onopen = s.onmessage = s.onclose = null; s.close(); }
  if (term && !preserveOutput) { term.dispose(); term = null; $('#term').replaceChildren(); }
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
  b.setAttribute('aria-label', key === 'Enter' ? 'Submit current terminal input' : key === 'Escape' ? 'Send Escape to terminal' : key);
  if (index > 3) b.className = 'extra-key';
  b.dataset.key = key;
  b.onclick = async () => {
    const name = current;
    if (!name || b.disabled || endedTasks.has(name)) return;
    await enqueueAction(name, { key }, () => {
      if (key === 'Enter') sessionDelivery(name, 'Enter sent to terminal');
      if (current !== name) return;
      if (['Enter', 'Escape', 'C-c', 'C-d'].includes(key)) closeShortKeys();
      setTimeout(pullReader, 300);
    });
  };
  return b;
}));
const keysHelp = document.createElement('p');
keysHelp.className = 'keys-help';
keysHelp.textContent = 'Follow the question’s keys. Use ↑ / ↓ and Enter for menus.';
$('#keys').append(keysHelp);
const moreKeys = document.createElement('button');
moreKeys.type = 'button'; moreKeys.textContent = 'More keys'; moreKeys.setAttribute('aria-expanded', 'false');
moreKeys.onclick = () => {
  const expanded = $('#keys').classList.toggle('expanded');
  moreKeys.textContent = expanded ? 'Fewer keys' : 'More keys';
  moreKeys.setAttribute('aria-expanded', String(expanded));
  refit();
};
$('#keys').append(moreKeys);
const controlsHeading = document.createElement('div');
controlsHeading.className = 'controls-heading';
const controlsTitle = document.createElement('span'); controlsTitle.textContent = 'Response controls';
const closeControls = document.createElement('button');
closeControls.type = 'button'; closeControls.textContent = 'Done';
closeControls.setAttribute('aria-label', 'Close response controls without sending a key');
closeControls.onclick = () => closeShortKeys();
controlsHeading.append(controlsTitle, closeControls);
$('#keys').insertBefore(controlsHeading, $('#keys').firstElementChild);
const keysToggle = $('#keys-toggle');
let responseTrigger = null;
function closeShortKeys(restoreFocus = true) {
  if (!$('#keys').classList.contains('short-open')) return;
  $('#keys').classList.remove('short-open');
  keysToggle.setAttribute('aria-expanded', 'false');
  $('#startup-respond').setAttribute('aria-expanded', 'false');
  keysToggle.setAttribute('aria-label', 'Show response controls');
  if (restoreFocus) (responseTrigger ? (responseTrigger.hidden ? $('#mode-btn') : responseTrigger) : keysToggle).focus();
  responseTrigger = null;
}
function openResponseControls(trigger = keysToggle) {
  if (!current || endedTasks.has(current) || actionState(current).uncertain) return;
  if (needsResponse && mode !== 'read') { setMode('read'); return; }
  if (questionBlocked()) return;
  responseTrigger = trigger;
  $('#keys').classList.add('short-open');
  keysToggle.setAttribute('aria-expanded', 'true');
  $('#startup-respond').setAttribute('aria-expanded', 'true');
  keysToggle.setAttribute('aria-label', 'Hide response controls');
  if (matchMedia('(max-width: 600px), (max-height: 400px)').matches) closeControls.focus();
  else $('#keys button[data-key]').focus();
}
keysToggle.onclick = () => {
  if ($('#keys').classList.contains('short-open')) closeShortKeys();
  else openResponseControls();
};
$('#startup-respond').onclick = () => {
  if ($('#keys').classList.contains('short-open')) closeShortKeys();
  else openResponseControls($('#startup-respond'));
};
$('#keys').onkeydown = (event) => {
  if (event.key !== 'Escape' || !$('#keys').classList.contains('short-open')) return;
  event.preventDefault();
  event.stopPropagation();
  closeShortKeys();
};

function delivery(text, error = false, openBrowser = false) {
  const el = $('#delivery');
  el.textContent = text; el.hidden = !text; el.classList.toggle('error', error);
  if (text && openBrowser) {
    const link = document.createElement('a');
    link.className = 'browser-handoff'; link.textContent = 'Open in browser';
    // The task route is shareable; credentials, drafts and query strings are not.
    link.href = `${location.origin}${location.pathname}${location.hash}`;
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    el.append(link);
  }
}
function sessionDelivery(name, text, error = false, openBrowser = false) {
  composer(name).feedback = { text, error, openBrowser };
  if (current === name) delivery(text, error, openBrowser);
}
const sending = new Set();
// Keep the draft visible until delivery succeeds. Never automatically retry an uncertain send.
$('#input-row').onsubmit = async (e) => {
  e.preventDefault();
  const name = current;
  if (!name || sending.has(name) || endedTasks.has(name) || actionState(name).uncertain || questionBlocked(name)) return;
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
    await enqueueAction(name, { text }, () => {
      if (c.draft === draft) c.draft = '';
      c.pending = c.pending.filter((p) => !sent.includes(p));
      sessionDelivery(name, 'Sent to terminal');
      if (current !== name) return;
      $('#input').value = c.draft; grow(); renderPending();
      if (mode === 'read') { const el = $('#reader'); el.scrollTop = el.scrollHeight; setTimeout(pullReader, 400); }
    });
  } finally {
    sending.delete(name);
    if (current === name) renderTaskControls();
  }
};
const grow = () => { const t = $('#input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, innerHeight * .3) + 'px'; };
$('#input').oninput = () => { if (current) composer(current).draft = $('#input').value; grow(); };
$('#input').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !touch) { e.preventDefault(); $('#input-row').requestSubmit(); } };

// --- attachments (photo library, camera or Files on iOS)
const UPLOAD_TIMEOUT_MS = 60000;
let fileOwner = null;
$('#attach-btn').onclick = () => { if (current && !endedTasks.has(current)) { fileOwner = current; $('#file').click(); } };
$('#file').onchange = async () => {
  const files = [...$('#file').files];
  $('#file').value = '';
  const name = fileOwner || current;
  fileOwner = null;
  if (!name || endedTasks.has(name)) return;
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

// --- Dictation recovery lives only in this page. Status polling never re-uploads audio.
const TRANSCRIBE_TIMEOUT_MS = 60000, DICTATION_PAGE_MS = 15 * 60000, DICTATION_POLL_MS = 2000;
const dictations = new Map();
let rec = null, recTask = null, recStart = 0, recTick = null, requestingMic = false, micGeneration = 0;
const canRecord = () => !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
const dictationControls = document.createElement('div');
dictationControls.className = 'reader-tools dictation-recovery'; dictationControls.hidden = true;
const dictationLabel = document.createElement('span');
const checkDictation = document.createElement('button'), retryDictation = document.createElement('button'), cancelDictation = document.createElement('button');
for (const [button, label] of [[checkDictation, 'Check dictation'], [retryDictation, 'Retry upload'], [cancelDictation, 'Discard dictation']]) {
  button.type = 'button'; button.className = 'text-button'; button.textContent = label;
}
dictationControls.append(dictationLabel, checkDictation, retryDictation, cancelDictation);
$('#term-view').append(dictationControls);
function renderDictation() {
  const d = dictations.get(current), recording = rec && recTask === current;
  dictationControls.hidden = !d && !recording;
  dictationLabel.textContent = recording ? 'Recording…' : d ? (d.phase === 'pending' ? 'Converting recording…'
    : d.busy ? 'Checking recording…' : d.phase === 'unknown' ? 'Ready to retry' : 'Recording needs attention') : '';
  dictationLabel.setAttribute('aria-label', d?.message || 'Dictation recovery');
  checkDictation.hidden = !d || ['pending', 'failed', 'expired', 'cancelled', 'unavailable'].includes(d.phase);
  retryDictation.hidden = !d || d.phase !== 'unknown';
  checkDictation.disabled = retryDictation.disabled = !!d?.busy;
  cancelDictation.disabled = false;
  micState(rec && recTask === current ? 'rec' : d?.busy ? 'busy' : 'idle');
  $('#mic-btn').disabled = !!d || ending || endedTasks.has(current);
}
function dictationPath(d) {
  return `/api/transcribe/${d.id}?epoch=${encodeURIComponent(d.epoch)}&task=${encodeURIComponent(d.name)}`;
}
function ownsDictation(d) { return dictations.get(d.name) === d && !endedTasks.has(d.name); }
function scheduleDictationCheck(d) {
  clearTimeout(d.poll);
  if (!ownsDictation(d) || d.phase !== 'pending' || document.hidden) return;
  d.poll = setTimeout(() => requestDictation(d), DICTATION_POLL_MS);
}
function expirePageDictation(d) {
  if (!ownsDictation(d)) return false;
  if (Date.now() - d.created < DICTATION_PAGE_MS) return false;
  discardDictation(d.name); sessionDelivery(d.name, 'Page recording expired after 15 minutes. Recovery is unavailable.', true);
  return true;
}
function acceptDictation(d, receipt) {
  if (!ownsDictation(d) || expirePageDictation(d)) return;
  if (receipt?.requestId !== d.id || receipt.epoch !== d.epoch || receipt.task !== d.name) throw new Error('Dictation receipt did not match this recording.');
  if (!['unknown', 'pending', 'complete', 'failed', 'expired', 'cancelled'].includes(receipt.state)) throw new Error('Unrecognized dictation status.');
  d.phase = receipt.state;
  if (receipt.state === 'complete') {
    if (typeof receipt.text !== 'string' || receipt.text.length > MESSAGE_MAX_CHARS) throw new Error('Invalid dictation result.');
    const c = composer(d.name);
    c.draft = (c.draft.trim() ? c.draft.trim() + ' ' : '') + receipt.text;
    if (current === d.name) { $('#input').value = c.draft; grow(); }
    clearTimeout(d.expiry); clearTimeout(d.poll); d.blob = null; dictations.delete(d.name);
    // Remove the bounded result from the Mac once it is safely in the page draft.
    post(dictationPath(d).replace('?', '/cancel?')).catch(() => {});
    sessionDelivery(d.name, receipt.text ? 'Dictation added to draft. Review before Send.' : 'Didn’t catch anything.');
    return;
  }
  d.message = receipt.state === 'pending' ? 'Turning your recording into text. Keep this page open.'
    : receipt.state === 'unknown' ? 'The Mac has not received this recording. Retry upload to send it again.'
    : receipt.state === 'failed' ? 'The recording could not be converted. Discard it, then record again.'
    : receipt.state === 'expired' ? 'This recording expired. Discard it, then record again.'
    : 'This recording was cancelled. Discard it to record again.';
  sessionDelivery(d.name, d.message, receipt.state !== 'pending');
}
async function requestDictation(d, upload = false) {
  if (!ownsDictation(d) || d.busy || expirePageDictation(d)) return;
  clearTimeout(d.poll);
  d.busy = true; const controller = new AbortController(); d.controller = controller;
  const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
  if (current === d.name) renderDictation();
  try {
    const response = await fetch(upload ? '/api/transcribe' : dictationPath(d), {
      method: upload ? 'POST' : 'GET', signal: controller.signal,
      headers: { ...authHeaders(), ...(upload ? { 'Content-Type': d.blob.type,
        'X-Dictation-Id': d.id, 'X-Dictation-Epoch': d.epoch, 'X-Dictation-Task': d.name } : {}) },
      ...(upload ? { body: d.blob } : {}),
    });
    const receipt = await response.json();
    if (!response.ok) {
      const error = new Error(receipt.error || `HTTP ${response.status}`); error.status = response.status; error.code = receipt.code; throw error;
    }
    acceptDictation(d, receipt);
  } catch (err) {
    if (!ownsDictation(d)) return;
    d.phase = err.code === 'DICTATION_CAPACITY' ? 'unavailable' : [400, 409, 410, 413].includes(err.status) ? 'failed' : 'unconfirmed';
    d.message = d.phase === 'unavailable' ? 'Dictation recovery is full. Discard this recording and restart Cockpit on your Mac before recording again.'
      : d.phase === 'failed' ? (err.status === 410 ? 'This recording is no longer available. Discard it, then refresh before recording again.'
        : err.status === 413 ? 'This recording is too large. Discard it and record a shorter message.'
        : 'This recording could not be accepted. Discard it, then refresh before recording again.')
      : controller.signal.aborted ? 'Transcription timed out. Recording kept; use Check dictation to recover it.'
      : 'Couldn’t confirm dictation. Recording kept; use Check dictation to recover it.';
    sessionDelivery(d.name, d.message, true);
  } finally {
    clearTimeout(timer); d.busy = false;
    scheduleDictationCheck(d);
    if (current === d.name) renderDictation();
  }
}
checkDictation.onclick = () => { const d = dictations.get(current); if (d) return requestDictation(d); };
retryDictation.onclick = async () => {
  const d = dictations.get(current);
  if (!d || d.phase !== 'unknown' || d.busy) return;
  await requestDictation(d); // A read first: a lost upload response may already have a job.
  if (ownsDictation(d) && d.phase === 'unknown') return requestDictation(d, true);
};
function discardDictation(name) {
  micGeneration++;
  if (rec && recTask === name) { rec.discarded = true; if (rec.state === 'recording') rec.stop(); }
  const d = dictations.get(name);
  if (d) {
    dictations.delete(name); d.blob = null; clearTimeout(d.expiry); clearTimeout(d.poll); d.controller?.abort();
    post(dictationPath(d).replace('?', '/cancel?')).catch(() => {});
  }
  if (current === name) renderDictation();
}
cancelDictation.onclick = () => {
  const name = current; discardDictation(name);
  if (name) sessionDelivery(name, 'Dictation discarded. Late text will not be added.');
};
function microphonePermissionDenied(error) {
  return error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
}
function microphoneFailureMessage(error) {
  if (microphonePermissionDenied(error)) return framed
    ? 'Microphone access is unavailable inside this app. Open Cockpit in your browser to try Dictate there. Your draft stays on this page.'
    : 'Microphone access was denied. Check this site’s microphone permission in your browser, then try Dictate again.';
  if (error?.name === 'NotFoundError') return 'No microphone was found. Connect one or type your message.';
  if (error?.name === 'NotReadableError') return 'Microphone could not start. Check that it is connected and available, then try Dictate again.';
  return 'Microphone did not start. Try Dictate again or type your message.';
}
$('#mic-btn').onclick = async () => {
  if (rec) { if (rec.state === 'recording') rec.stop(); return; }
  const name = current;
  if (!name || requestingMic || ending || endedTasks.has(name) || dictations.has(name)) return;
  if (!state.dictationEpoch) return sessionDelivery(name, 'Dictation recovery unavailable. Refresh before recording.', true);
  if (dictations.size >= 4) return sessionDelivery(name, 'Four recordings are already kept on this page. Check or discard one first.', true);
  let id;
  try { const bytes = new Uint8Array(16); crypto.getRandomValues(bytes); id = Array.from(bytes, x => x.toString(16).padStart(2, '0')).join(''); }
  catch { return sessionDelivery(name, 'Safe dictation identity unavailable. Recording not started.', true); }
  const epoch = state.dictationEpoch, generation = micGeneration;
  const feedbackBeforePermission = composer(name).feedback;
  requestingMic = true;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (error) {
    if (current === name && generation === micGeneration && !ending && !endedTasks.has(name)
        && composer(name).feedback === feedbackBeforePermission) {
      sessionDelivery(name, microphoneFailureMessage(error), true, framed && microphonePermissionDenied(error));
    }
    return;
  }
  finally { requestingMic = false; }
  if (current !== name || endedTasks.has(name) || ending || generation !== micGeneration) { stream.getTracks().forEach((t) => t.stop()); return; }
  const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
  let r;
  try { r = new MediaRecorder(stream, type ? { mimeType: type } : undefined); }
  catch { stream.getTracks().forEach(t => t.stop()); return sessionDelivery(name, 'Recording unavailable.', true); }
  const chunks = []; let bytes = 0;
  r.ondataavailable = (e) => {
    bytes += e.data.size;
    if (bytes > 25 * 1048576) { r.discarded = true; chunks.length = 0; if (r.state === 'recording') r.stop(); }
    else if (e.data.size && !r.discarded) chunks.push(e.data);
  };
  const recordingTimer = setTimeout(() => { if (r.state === 'recording') r.stop(); }, 120000);
  r.onstop = () => {
    stream.getTracks().forEach((t) => t.stop()); clearTimeout(recordingTimer); clearInterval(recTick);
    rec = null; recTask = null;
    if (r.discarded || endedTasks.has(name)) { chunks.length = 0; if (current === name) renderDictation(); return; }
    const blob = new Blob(chunks, { type: (r.mimeType || type || 'audio/mp4').split(';')[0] }); chunks.length = 0;
    if (!blob.size) { if (current === name) renderDictation(); return; }
    const d = { id, epoch, name, blob, created: Date.now(), phase: 'unconfirmed', busy: false };
    dictations.set(name, d);
    d.expiry = setTimeout(() => {
      if (!ownsDictation(d)) return;
      discardDictation(name); sessionDelivery(name, 'Page recording expired after 15 minutes. Recovery is unavailable.', true);
    }, DICTATION_PAGE_MS);
    requestDictation(d, true);
  };
  rec = r; recTask = name;
  try { r.start(1000); }
  catch { r.discarded = true; stream.getTracks().forEach(t => t.stop()); clearTimeout(recordingTimer); rec = null; recTask = null; return sessionDelivery(name, 'Recording could not start.', true); }
  recStart = Date.now(); renderDictation(); recTick = setInterval(() => micState('rec'), 500);
};
function micState(s) {
  const b = $('#mic-btn');
  b.classList.toggle('rec', s === 'rec');
  b.classList.toggle('busy', s === 'busy');
  b.disabled = s === 'busy' || ending || endedTasks.has(current);
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
  if (ending || !current || endedTasks.has(current)) return;
  if (!b.classList.contains('armed')) { b.classList.add('armed'); b.textContent = 'Tap to end'; armTimer = setTimeout(disarm, 3000); return; }
  disarm();
  const name = current;
  discardDictation(name);
  ending = true; b.disabled = true; b.textContent = 'Ending…';
  try {
    await post(`/api/sessions/${name}/end`);
    settleTask(name);
  } catch (err) {
    if (err.status === 404 || err.status === 410) settleTask(name);
    else if (!endedTasks.has(name)) {
      sessionDelivery(name, 'End unconfirmed. Check task status; it may still be running. ' + err.message, true);
      refresh();
    }
  } finally { ending = false; disarm(); renderTaskControls(); }
};

// ---------- boot ----------
pollTimer = setInterval(refresh, 3000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  for (const d of dictations.values()) if (d.phase === 'pending') requestDictation(d);
  refresh();
  if (!current || endedTasks.has(current)) return;
  if (mode === 'live' && (!ws || ws.readyState > 1)) { clearTimeout(wsTimer); wsRetry = 0; connect(current); }
  else pullReader();
});
// Framed: send our token to the parent (so it can restore it later), or say hello so it can
// hand back a token it kept.
embedReady.then(() => tellParent(device.get() ? { type: 'cockpit-device', token: device.get() } : { type: 'cockpit-hello' }));
recoveryUI();
function restoreRoute() {
  // History changes navigate only. They never start a task or repeat terminal input.
  if (activeView === 'pair') return;
  let name;
  try { name = decodeURIComponent(location.hash.slice(1)); } catch { name = ''; }
  if (name && name !== '@new' && !stateLoaded) {
    // An empty initial array is not evidence that this task is unavailable.
    // Show the connection/list state without destroying the pending destination.
    if (activeView !== 'list') show('list', false, true);
    pendingRoute = { hash: location.hash, epoch: viewEpoch };
    return;
  }
  pendingRoute = null;
  if (name === '@new') {
    if (activeView !== 'new') openNewTask(false);
  } else if (name && state.sessions.some(s => s.name === name)) {
    if (activeView !== 'term' || current !== name) openTerm(name, undefined, false, false);
  } else if (activeView !== 'list' || name || location.hash !== '#') show('list', false);
}
window.addEventListener('popstate', restoreRoute);
window.addEventListener('hashchange', restoreRoute);
const initialViewEpoch = viewEpoch;
refresh().then(() => {
  $('#mic-btn').hidden = !(state.transcribe && canRecord());
  // A late initial response must not reopen a task after deliberate navigation.
  if (viewEpoch === initialViewEpoch) restoreRoute();
});
