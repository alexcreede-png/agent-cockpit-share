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
function show(view) {
  activeView = view; viewEpoch++;
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
// Exact start time distinguishes same-project tasks without relying on internal IDs.
function taskTime(s) {
  const peers = state.sessions.filter(x => x.project === s.project && x.lane === s.lane);
  return peers.length > 1 ? new Date(s.created).toLocaleString([], {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
  }) : ago(s.created);
}

function renderTermIdentity(s, name = current) {
  $('#t-name').textContent = displayProject(s) || name;
  $('#t-name').title = s ? `${displayProject(s)} — ${name}` : name;
  $('#t-name').setAttribute('aria-label', s ? displayProject(s) : 'Task');
  $('#t-context').textContent = s ? assistantName(s.lane) : 'Starting task';
  const pill = $('#t-status');
  pill.className = 'pill ' + (s ? s.status : 'idle');
  pill.textContent = s ? STATUS_LABEL[s.status] || s.status : 'starting';
  $('#keys-toggle').textContent = s?.status === 'needs-you' ? 'Respond' : 'Controls';
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
    b.querySelector('.meta').textContent = `${assistantName(s.lane)} · ${taskTime(s)}`;
    b.setAttribute('aria-label', `${displayProject(s)}, ${STATUS_LABEL[s.status] || s.status}, ${assistantName(s.lane)}, ${taskTime(s)}`);
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
    const lanesChanged = JSON.stringify(state.lanes) !== JSON.stringify(next.lanes);
    const recoveryChanged = state.startRecovery !== next.startRecovery;
    state = next;
    if (activeView === 'new' && (lanesChanged || recoveryChanged)) { renderAssistants(); ready(); }
    projectsRoot = state.projectsRoot || '';
    $('#conn').hidden = true;
    renderList();
    if (current && mode === 'live' && ws && ws.readyState === 1) connection('connected');
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
$('#new-btn').onclick = () => {
  show('new'); renderAssistants(); ready();
  $('#new-view .form').scrollTop = 0;
  if (!starting && !pendingStart) $('#start-state').textContent = '';
  loadProjects(); // Navigation keeps choices, search and draft; it never starts a task.
};
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
    $('#start-state').textContent = 'Terminal created. The assistant may still need setup or sign-in; check its output before sending again.';
    recoveryNotice = '';
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
// Session names come from the server. Composer data remains in memory for this page only.
const composers = new Map();
const composer = (name) => {
  if (!composers.has(name)) composers.set(name, { draft: '', pending: [], feedback: { text: '', error: false } });
  return composers.get(name);
};
const activeComposer = () => current ? composer(current) : null;

function openTerm(name, session = state.sessions.find((s) => s.name === name), justCreated = false) {
  $('#startup-note').textContent = justCreated
    ? 'Terminal created. Check the output for setup or sign-in. This doesn’t confirm your first message was accepted.' : '';
  $('#startup-note').hidden = !justCreated;
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
  $('#answer-start').hidden = true;
  $('#reader-tools').hidden = true;
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
  if (!current || mode !== 'read' || readerBusy) return;
  const name = current, epoch = readerEpoch;
  readerBusy = true;
  let text;
  try {
    text = await api(`/api/sessions/${name}/history?lines=3000&format=reader`);
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
  const conversation = text && typeof text === 'object' && text.source === 'conversation' && Array.isArray(text.messages) ? text : null;
  const messages = conversation ? conversation.messages : null;
  text = conversation ? JSON.stringify(messages) : compactReadHistory(typeof text === 'string' ? text : '', state.sessions.find(s => s.name === name)?.lane);
  readerState(text ? 'Output available.' : 'No output yet.');
  const el = $('#reader'), resized = el.clientHeight !== readerHeight;
  readerHeight = el.clientHeight;
  if (text === lastText) {
    if (resized && readerFollow) el.scrollTop = el.scrollHeight;
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
    $('#reader-tools').hidden = true;
    el.textContent = text || 'No output yet.';
    if (stick) el.scrollTop = el.scrollHeight;
    readerFollow = stick;
  }
  $('#to-bottom').hidden = nearBottom(el);
}
function startReader() {
  connection('reconnecting');
  lastText = null;
  readerFollow = true;
  readerHeight = $('#reader').clientHeight;
  $('#reader').classList.remove('conversation');
  $('#answer-start').hidden = true;
  $('#reader-tools').hidden = true;
  $('#reader').textContent = 'Loading…';
  readerState('Loading task output…', true);
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
  b.onclick = async () => {
    const name = current;
    if (!name || b.disabled) return;
    b.disabled = true;
    try {
      await post(`/api/sessions/${name}/keys`, { key });
      if (key === 'Enter') sessionDelivery(name, 'Enter sent to terminal');
      if (current !== name) return;
      if (['Enter', 'Escape', 'C-c', 'C-d'].includes(key)) closeShortKeys();
      setTimeout(pullReader, 300);
    } catch (err) {
      sessionDelivery(name, 'Key failed: ' + err.message, true);
    } finally { b.disabled = false; }
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
  keysToggle.setAttribute('aria-label', 'Show response controls');
  if (restoreFocus) keysToggle.focus();
}
keysToggle.onclick = () => {
  if ($('#keys').classList.contains('short-open')) closeShortKeys();
  else {
    $('#keys').classList.add('short-open');
    keysToggle.setAttribute('aria-expanded', 'true');
    keysToggle.setAttribute('aria-label', 'Hide response controls');
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
    sessionDelivery(name, 'Could not end task. It may still be running. ' + err.message, true);
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
recoveryUI();
refresh().then(() => {
  $('#mic-btn').hidden = !(state.transcribe && canRecord());
  const h = decodeURIComponent(location.hash.slice(1));
  if (h && state.sessions.some((s) => s.name === h)) openTerm(h);
});
