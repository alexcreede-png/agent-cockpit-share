'use strict';
// Request and path policy. Pure functions so they can be unit-tested.
const fs = require('fs');
const path = require('path');

// `paths` is { projectsRoot, forbiddenPaths } from lib/config.js. Comparisons ignore case
// because the default macOS volume does.
const under = (p, dir) => { const l = p.toLowerCase(), d = dir.toLowerCase(); return l === d || l.startsWith(d + '/'); };

// Paths the owner has fenced off; the cockpit never opens or lists them.
function isForbiddenPath(p, paths) {
  return paths.forbiddenPaths.some((f) => under(p, f));
}

// Resolve a requested project dir; returns the real path or null if not allowed.
function resolveProject(requested, paths) {
  if (typeof requested !== 'string' || !requested.startsWith('/')) return null;
  let real;
  try {
    real = fs.realpathSync(requested);
    if (!fs.statSync(real).isDirectory()) return null;
  } catch {
    return null;
  }
  const l = real.toLowerCase();
  let root = paths.projectsRoot;
  try { root = fs.realpathSync(root); } catch {}
  if (!l.startsWith(root.toLowerCase() + '/')) return null;
  if (isForbiddenPath(real, paths)) return null;
  return real;
}

// Top-level project dirs plus second-level git checkouts (e.g. my-app/repo).
function listProjects(paths) {
  const root = paths.projectsRoot;
  const out = [];
  const visible = (d) => d.isDirectory() && !d.name.startsWith('.');
  for (const d of fs.readdirSync(root, { withFileTypes: true }).filter(visible)) {
    const top = path.join(root, d.name);
    if (isForbiddenPath(top, paths)) continue;
    let mtime = 0;
    try { mtime = fs.statSync(top).mtimeMs; } catch { continue; }
    out.push({ path: top, label: d.name, mtime });
    let kids = [];
    try { kids = fs.readdirSync(top, { withFileTypes: true }).filter(visible); } catch {}
    for (const k of kids) {
      const sub = path.join(top, k.name);
      if (k.name === 'node_modules' || k.name === 'worktrees') continue;
      if (fs.existsSync(path.join(sub, '.git')) && !isForbiddenPath(sub, paths)) {
        out.push({ path: sub, label: d.name + '/' + k.name, mtime });
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).map(({ path: p, label }) => ({ path: p, label }));
}

const SESSION_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const validSessionName = (n) => typeof n === 'string' && SESSION_NAME.test(n);

// Every HTTP request and WebSocket upgrade passes through here.
// Returns null when allowed, or a short reason string when refused.
function checkRequest(req, cfg) {
  const host = req.headers.host || '';
  if (!cfg.hosts.includes(host)) return 'host';
  const local = cfg.localHosts.includes(host);
  if (!local) {
    const who = req.headers['tailscale-user-login'];
    if (!who || who.toLowerCase() !== cfg.user.toLowerCase()) return 'identity';
  } else if (!cfg.allowLocal) {
    return 'local-disabled';
  }
  // Anything that can change state must come from our own page (blocks cross-site
  // WebSocket hijacking and CSRF; a browser always sends Origin on these).
  const mutating = req.method !== 'GET' || /websocket/i.test(req.headers.upgrade || '');
  if (mutating) {
    const origin = req.headers.origin;
    const ok = origin === 'https://' + host || (local && origin === 'http://' + host);
    if (!ok) return 'origin';
  }
  return null;
}

module.exports = { isForbiddenPath, resolveProject, listProjects, validSessionName, checkRequest };
