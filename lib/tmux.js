'use strict';
// Thin wrapper over the cockpit's dedicated tmux server.
const { execFile } = require('child_process');
const path = require('path');
const crypto = require('crypto');

const CONF = path.join(__dirname, '..', 'tmux.conf');
const BASE = ['-L', 'cockpit', '-f', CONF];

// Each lane runs in a login shell so it gets the owner's normal PATH and profile.
// The optional first prompt travels in an env var, never spliced into the command.
const LANES = {
  claude: 'exec claude ${COCKPIT_PROMPT:+"$COCKPIT_PROMPT"}',
  codex: 'exec codex ${COCKPIT_PROMPT:+"$COCKPIT_PROMPT"}',
  grok: 'exec grok ${COCKPIT_PROMPT:+"$COCKPIT_PROMPT"}',
  agy: 'exec agy ${COCKPIT_PROMPT:+"$COCKPIT_PROMPT"}',
  shell: 'exec "${SHELL:-/bin/zsh}" -l',
};

// Named keys the phone's quick-key row may send.
const KEYS = new Set(['Enter', 'Escape', 'Tab', 'BTab', 'Up', 'Down', 'Left', 'Right',
  'C-c', 'C-d', 'BSpace', 'PageUp', 'PageDown']);

// Optional tmux hook run when a session closes (set per machine in cockpit.config.json).
let sessionClosedCommand = '';
function configure(opts) { sessionClosedCommand = opts.sessionClosedCommand || ''; }

function tmux(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('tmux', [...BASE, ...args], { timeout: 5000, maxBuffer: 8 << 20, ...opts },
      (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout)));
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

async function create({ lane, project, prompt, env = {} }) {
  if (!LANES[lane]) throw new Error('unknown lane');
  const name = sessionName(lane, project);
  const envArgs = [];
  for (const [k, v] of Object.entries({ ...env, COCKPIT_PROMPT: prompt || '', COCKPIT_SESSION: name })) {
    envArgs.push('-e', `${k}=${v}`);
  }
  await tmux(['new-session', '-d', '-s', name, '-c', project, '-x', '120', '-y', '40', ...envArgs,
    '/bin/zsh', '-lc', LANES[lane]]);
  await tmux(['set-option', '-t', name, '@lane', lane]);
  await tmux(['set-option', '-t', name, '@project', project]);
  // Global hooks live on the server, which only exists once a session does.
  if (sessionClosedCommand) await tmux(['set-hook', '-g', 'session-closed', `run-shell -b ${JSON.stringify(sessionClosedCommand)}`]);
  return name;
}

const capture = (name, lines = 60) =>
  tmux(['capture-pane', '-p', '-J', '-t', `=${name}:`, '-S', String(-lines)]);

async function sendText(name, text) {
  if (text) await tmux(['send-keys', '-t', `=${name}:`, '-l', text]);
  await tmux(['send-keys', '-t', `=${name}:`, 'Enter']);
}

async function sendKey(name, key) {
  if (!KEYS.has(key) && !/^[0-9yn]$/.test(key)) throw new Error('key not allowed');
  await tmux(['send-keys', '-t', `=${name}:`, key]);
}

const kill = (name) => tmux(['kill-session', '-t', `=${name}`]);

// argv for attaching an interactive client (spawned under a pty by the server).
const attachArgs = (name) => [...BASE, 'attach-session', '-t', `=${name}`];

module.exports = { configure, LANES, KEYS, list, create, capture, sendText, sendKey, kill, attachArgs, tmux };
