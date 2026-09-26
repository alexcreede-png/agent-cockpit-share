'use strict';
// Per-machine settings. Read from cockpit.config.json (gitignored) next to server.js; a few
// can be overridden by environment variables. See cockpit.config.example.json.
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = process.env.COCKPIT_CONFIG || path.join(__dirname, '..', 'cockpit.config.json');

function load(file = FILE, env = process.env) {
  let raw = {};
  if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const port = Number(env.COCKPIT_PORT || raw.port || 8826);
  const cfg = {
    port,
    // Tailscale login allowed to use the cockpit, e.g. "you@example.com".
    user: env.COCKPIT_USER || raw.user || '',
    // Host:port your phone uses, e.g. "my-mac.tailnet-name.ts.net:8444".
    publicHost: env.COCKPIT_PUBLIC_HOST || raw.publicHost || '',
    allowLocal: env.COCKPIT_ALLOW_LOCAL === '1',
    // Optional: listen on this owner-only Unix socket instead of a loopback TCP port, and point
    // `tailscale serve` at unix:<socketPath>. Needs the open-source tailscaled; see README "Security".
    // An empty COCKPIT_SOCKET forces TCP mode (for local testing).
    socketPath: env.COCKPIT_SOCKET !== undefined ? env.COCKPIT_SOCKET : (raw.socketPath || ''),
    projectsRoot: path.resolve(raw.projectsRoot || path.join(os.homedir(), 'projects')),
    // Directories (and everything under them) the cockpit must never open or list.
    forbiddenPaths: (raw.forbiddenPaths || []).flatMap((p) => {
      const abs = path.resolve(p);
      try { const real = fs.realpathSync(abs); return real === abs ? [abs] : [abs, real]; } catch { return [abs]; }
    }),
    // Optional alert command; the message is appended as the last argument.
    notifyCommand: Array.isArray(raw.notifyCommand) && raw.notifyCommand.length ? raw.notifyCommand : null,
    notify: env.COCKPIT_NOTIFY === '1',
    // Optional shell command run by tmux when a cockpit session closes (#{hook_session_name} works).
    sessionClosedCommand: typeof raw.sessionClosedCommand === 'string' ? raw.sessionClosedCommand : '',
  };
  if (!cfg.user) throw new Error(`cockpit: set "user" (your Tailscale login) in ${file}`);
  if (!cfg.publicHost && !cfg.allowLocal) throw new Error(`cockpit: set "publicHost" in ${file}`);
  return cfg;
}

module.exports = { load, FILE };
