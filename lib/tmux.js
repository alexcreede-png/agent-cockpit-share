'use strict';
// Thin wrapper over the cockpit's dedicated tmux server.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONF = path.join(__dirname, '..', 'tmux.conf');
const BASE = ['-L', 'cockpit', '-f', CONF];

// Each lane runs in a login shell so it gets the owner's normal PATH and profile.
// The optional first prompt travels in an env var, never spliced into the command.
// Claude and Codex also get this session's upload folder as an extra directory, so files sent
// from the phone can be read without a permission prompt or a settings change. The prompt goes
// after an end-of-options delimiter so message text cannot become a CLI option or subcommand.
// Upload options precede that delimiter; each expansion is one word (zsh does not split).
const LANES = {
  claude: 'exec claude ${COCKPIT_UPLOADS:+"--add-dir=$COCKPIT_UPLOADS"} ${COCKPIT_PROMPT:+--} ${COCKPIT_PROMPT:+"$COCKPIT_PROMPT"}',
  codex: 'exec codex ${COCKPIT_UPLOADS:+"--add-dir=$COCKPIT_UPLOADS"} ${COCKPIT_PROMPT:+--} ${COCKPIT_PROMPT:+"$COCKPIT_PROMPT"}',
  grok: 'exec grok ${COCKPIT_PROMPT:+--} ${COCKPIT_PROMPT:+"$COCKPIT_PROMPT"}',
  agy: 'exec agy ${COCKPIT_PROMPT:+"--prompt-interactive=$COCKPIT_PROMPT"}',
  shell: 'exec "${SHELL:-/bin/zsh}" -l',
};

// Named keys the phone's quick-key row may send.
const KEYS = new Set(['Enter', 'Escape', 'Tab', 'BTab', 'Up', 'Down', 'Left', 'Right',
  'C-c', 'C-d', 'BSpace', 'PageUp', 'PageDown']);

// Optional tmux hook run when a session closes (set per machine in cockpit.config.json).
let sessionClosedCommand = '';
let uploadsDir = '';
let readerDir = '';
function configure(opts) {
  sessionClosedCommand = opts.sessionClosedCommand || '';
  uploadsDir = opts.uploadsDir || '';
  readerDir = opts.stateDir ? path.join(opts.stateDir, 'agy-bindings') : '';
}

function tmux(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const { input, ...execOpts } = opts;
    const child = execFile('tmux', [...BASE, ...args], { timeout: 5000, maxBuffer: 8 << 20, ...execOpts },
      (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout)));
    if (input !== undefined) {
      // execFile reports process failure; a closed stdin must not become an uncaught EPIPE.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

async function list() {
  let out;
  try {
    out = await tmux(['list-panes', '-a', '-F',
      '#{session_name}\t#{@lane}\t#{@project}\t#{session_created}\t#{pane_dead}\t#{pane_dead_status}\t#{session_attached}']);
  } catch (e) {
    if (/no server running|error connecting|No such file/i.test(e.stderr || '')) return [];
    throw e;
  }
  const seen = new Set();
  return out.split('\n').filter(Boolean).map((l) => {
    const [name, lane, project, created, dead, deadStatus, attached] = l.split('\t');
    return { name, lane, project, created: Number(created) * 1000, dead: dead === '1',
      exitCode: deadStatus === '' ? null : Number(deadStatus), attached: Number(attached) };
  }).filter((s) => !seen.has(s.name) && seen.add(s.name));
}

function sessionName(lane, projectPath) {
  const slug = path.basename(projectPath).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'proj';
  return `${lane}-${slug}-${crypto.randomBytes(2).toString('hex')}`;
}

async function create({ lane, project, prompt, env = {}, name = sessionName(lane, project), startToken }) {
  if (typeof lane !== 'string' || !Object.hasOwn(LANES, lane)) throw new Error('unknown lane');
  let uploads = '';
  if (uploadsDir) {
    uploads = path.join(uploadsDir, name);
    fs.mkdirSync(uploads, { recursive: true, mode: 0o700 });
  }
  const envArgs = [];
  let command = LANES[lane];
  const readerEnv = {};
  if (lane === 'agy' && readerDir) {
    fs.mkdirSync(readerDir, { recursive: true, mode: 0o700 });
    readerEnv.COCKPIT_READER_BINDING = path.join(readerDir, name + '.json');
    readerEnv.COCKPIT_READER_TOKEN = crypto.randomBytes(32).toString('hex');
    readerEnv.COCKPIT_NODE = process.execPath;
    readerEnv.COCKPIT_AGY_BRIDGE = path.join(__dirname, '..', 'scripts', 'agy.js');
    command = 'exec "$COCKPIT_NODE" "$COCKPIT_AGY_BRIDGE" ${COCKPIT_PROMPT:+"--prompt-interactive=$COCKPIT_PROMPT"}';
  }
  // Claude Code's agent view (← on an empty prompt) lists and can attach to every Claude session
  // on the machine, which would bypass forbiddenPaths from the phone. Off for cockpit sessions only.
  const lock = { CLAUDE_CODE_DISABLE_AGENT_VIEW: '1' };
  for (const [k, v] of Object.entries({ ...env, ...lock, ...readerEnv, COCKPIT_PROMPT: prompt || '', COCKPIT_SESSION: name, COCKPIT_UPLOADS: uploads,
    ...(startToken ? { COCKPIT_START_TOKEN: startToken } : {}) })) {
    envArgs.push('-e', `${k}=${v}`);
  }
  await tmux(['new-session', '-d', '-s', name, '-c', project, '-x', '120', '-y', '40', ...envArgs,
    '/bin/zsh', '-lc', command]);
  await setMetadata(name, lane, project);
  // Global hooks live on the server, which only exists once a session does.
  if (sessionClosedCommand) await tmux(['set-hook', '-g', 'session-closed', `run-shell -b ${JSON.stringify(sessionClosedCommand)}`]);
  return name;
}

async function setMetadata(name, lane, project) {
  // set-option resolves a target-window; the colon is needed for exact session matching.
  await tmux(['set-option', '-t', `=${name}:`, '@lane', lane]);
  await tmux(['set-option', '-t', `=${name}:`, '@project', project]);
}

// Only the exact reserved name is inspected. The marker is installed by new-session itself,
// before later metadata commands can fail. No transcript/list scan or cleanup of other panes.
async function reconcileStart({ name, startToken, lane, project }) {
  if (!/^(claude|codex|grok|agy|shell)-start-[a-f0-9]{32}$(?![\s\S])/.test(name) || !/^[a-f0-9]{64}$(?![\s\S])/.test(startToken)) {
    throw new Error('invalid planned start');
  }
  const inspect = async () => {
    const token = await tmux(['show-environment', '-t', `=${name}`, 'COCKPIT_START_TOKEN'], { maxBuffer: 1024 });
    if (token.trim() !== `COCKPIT_START_TOKEN=${startToken}`) throw new Error('start ownership unconfirmed');
    const out = await tmux(['display-message', '-p', '-t', `=${name}:`, '#{session_name}\t#{pane_dead}'], { maxBuffer: 1024 });
    const [actual, dead] = out.trim().split('\t');
    if (actual !== name || !['0', '1'].includes(dead)) throw new Error('start identity unconfirmed');
    return dead === '1' ? 'ended' : 'existing';
  };
  const outcome = await inspect();
  if (outcome === 'ended') return outcome;
  await setMetadata(name, lane, project);
  return inspect();
}

async function paneIdentity(name) {
  const value = await tmux(['display-message', '-p', '-t', `=${name}:`, '#{pane_pid}']);
  const pid = Number(value.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? { pid } : null;
}

async function readerIdentity(name) {
  const identity = await paneIdentity(name);
  if (!identity) return null;
  const value = await tmux(['show-environment', '-t', `=${name}`, 'COCKPIT_READER_TOKEN']);
  const match = value.trim().match(/^COCKPIT_READER_TOKEN=([a-f0-9]{64})$/);
  return match ? { ...identity, token: match[1] } : null;
}

const capture = (name, lines = 60) =>
  tmux(['capture-pane', '-p', '-J', '-t', `=${name}:`, '-S', String(-lines)]);

// Serialize input per session so simultaneous sends cannot interleave text and Enter.
const inputQueues = new Map();
function queueInput(name, action) {
  const next = (inputQueues.get(name) || Promise.resolve()).catch(() => {}).then(action);
  inputQueues.set(name, next);
  next.finally(() => { if (inputQueues.get(name) === next) inputQueues.delete(name); }).catch(() => {});
  return next;
}

// Paste every message, including one-line dictation. Fast literal typing followed immediately
// by Enter trips CLI paste guards. Wait for rendering to settle before submitting exactly once.
async function sendText(name, text) {
  if (!text || !text.trim()) throw new Error('message is empty');
  return queueInput(name, async () => {
    const target = `=${name}:`;
    const buf = `cockpit-${name}-${crypto.randomBytes(4).toString('hex')}`;
    // Stream the payload: tmux command arguments have a smaller limit than our message cap.
    await tmux(['load-buffer', '-b', buf, '-'], { input: text });
    await tmux(['paste-buffer', '-p', '-d', '-b', buf, '-t', target]);
    let prev = null, stable = 0;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const screen = await capture(name, 15);
      stable = screen === prev ? stable + 1 : 0;
      if (stable >= 2) break;
      prev = screen;
    }
    await tmux(['send-keys', '-t', target, 'Enter']);
  });
}

async function sendKey(name, key) {
  if (!KEYS.has(key) && !/^[0-9yn]$/.test(key)) throw new Error('key not allowed');
  await queueInput(name, () => tmux(['send-keys', '-t', `=${name}:`, key]));
}

// Fit the window to the phone (read view and live terminal both call this).
const resize = (name, cols, rows) =>
  tmux(['resize-window', '-t', `=${name}:`, '-x', String(cols), '-y', String(rows)]);

const kill = (name) => tmux(['kill-session', '-t', `=${name}`]);

// argv for attaching an interactive client (spawned under a pty by the server).
const attachArgs = (name) => [...BASE, 'attach-session', '-t', `=${name}`];

module.exports = { configure, LANES, KEYS, list, create, reconcileStart, paneIdentity, readerIdentity, capture, sendText, sendKey, resize, kill, attachArgs, tmux };
