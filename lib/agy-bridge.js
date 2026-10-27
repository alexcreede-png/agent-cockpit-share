'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
// Match an observed CLI creation event, not a user's quoted prompt or a resumed ID.
const CREATED = new RegExp(`^I\\d{4} \\d{2}:\\d{2}:\\d{2}\\.\\d+\\s+\\d+ server\\.go:\\d+\\] Created conversation (${UUID}) \\(backend=[A-Z0-9_]+\\)$`);

function identityCollector(onCreated) {
  let buffer = '', dropping = false, id = null, ambiguous = false;
  return chunk => {
    for (const part of String(chunk).split(/(?<=\n)/)) {
      if (!dropping) buffer += part;
      if (buffer.length > 16384) { buffer = ''; dropping = true; }
      if (!part.endsWith('\n')) continue;
      if (!dropping) {
        const match = buffer.replace(/\r?\n$/, '').match(CREATED);
        if (match && match[1] !== id) {
          if (id !== null) ambiguous = true;
          id = match[1]; onCreated({ id, ambiguous });
        }
      }
      buffer = ''; dropping = false;
    }
  };
}

function run() {
  // Initialize Node's lazy TTY streams while the pane still exists. Opening them
  // for the first time during a macOS terminal hangup can block child cleanup.
  void process.stdin; void process.stdout; void process.stderr;
  const env = process.env, file = env.COCKPIT_READER_BINDING;
  const token = env.COCKPIT_READER_TOKEN, session = env.COCKPIT_SESSION;
  const enabled = typeof file === 'string' && path.isAbsolute(file)
    && /^[a-f0-9]{64}$/.test(token || '') && /^[a-zA-Z0-9_-]+$/.test(session || '');
  if (enabled) process.title = 'cockpit-agy-reader-active';
  let project;
  try { project = fs.realpathSync(process.cwd()); } catch { project = null; }
  const started = Date.now();
  const child = spawn('agy', [...(enabled ? ['--log-file=/dev/fd/3'] : []), ...process.argv.slice(2)], {
    stdio: ['inherit', 'inherit', 'inherit', ...(enabled ? ['pipe'] : [])],
  });
  if (enabled) {
    const collect = identityCollector(({ id, ambiguous }) => {
      if (!project) return;
      if (ambiguous) {
        // A live, independently checked invalidation survives a read-only/full disk.
        // Never continue trusting the first record when the second cannot be saved.
        process.title = 'cockpit-agy-reader-disabled';
        try { fs.unlinkSync(file); } catch {}
      }
      // Retain identity only. All other diagnostics, prompts and responses are discarded.
      const record = { version: 1, session, token, wrapperPid: process.pid, childPid: child.pid,
        started, observed: Date.now(), project, id, ambiguous };
      const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, file);
      } catch {
        // The interactive session remains usable when a reader identity cannot be saved.
        try { fs.unlinkSync(temporary); } catch {}
      }
    });
    child.stdio[3].setEncoding('utf8');
    child.stdio[3].on('data', collect);
    child.stdio[3].on('error', () => {});
  }
  child.on('error', () => { console.error('Antigravity could not start. Check that agy is installed on this Mac.'); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
  for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
}

module.exports = { identityCollector, run };
