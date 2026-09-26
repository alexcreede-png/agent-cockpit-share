'use strict';
// Agent Cockpit — loopback web server fronted by `tailscale serve`.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const tmux = require('./lib/tmux');
const guard = require('./lib/guard');
const { classify } = require('./lib/status');
const { prepareSocket, lockSocket } = require('./lib/socket');
const pairing = require('./lib/pairing');
const uploads = require('./lib/uploads');
const voice = require('./lib/transcribe');
const config = require('./lib/config').load();

const PORT = config.port;
const PUBLIC_HOST = config.publicHost;
const LOCAL_HOSTS = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
const CFG = {
  hosts: [PUBLIC_HOST, ...LOCAL_HOSTS].filter(Boolean),
  localHosts: LOCAL_HOSTS,
  user: config.user,
  allowLocal: config.allowLocal,
};
const NOTIFY = config.notify && !!config.notifyCommand;
tmux.configure({ sessionClosedCommand: config.sessionClosedCommand, uploadsDir: config.uploadsDir });

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- status poller + alerts ----------
const trackers = new Map();   // name → classifier tracker
const statusOf = new Map();   // name → status string
const lastAlert = new Map();  // name → ms

function alert(name, event) {
  const now = Date.now();
  if (now - (lastAlert.get(name) || 0) < 120000) return;
  lastAlert.set(name, now);
  const what = event === 'needs-you' ? 'is waiting for your approval' : 'finished and is waiting';
  log('alert', name, event, NOTIFY ? 'notify' : 'notify-off');
  if (!NOTIFY) return;
  // Session name and a link only — never screen content.
  const [cmd, ...args] = config.notifyCommand;
  execFile(cmd, [...args, `COCKPIT — ${name} ${what}\nhttps://${PUBLIC_HOST}/#${name}`],
    { timeout: 30000 }, () => {});
}

async function poll() {
  let sessions = [];
  try { sessions = await tmux.list(); } catch (e) { log('list failed', e.message); }
  const live = new Set(sessions.map((s) => s.name));
  for (const k of trackers.keys()) if (!live.has(k)) { trackers.delete(k); statusOf.delete(k); }
  await Promise.all(sessions.map(async (s) => {
    let screen = '';
    try { screen = await tmux.capture(s.name, 40); } catch { return; }
    const r = classify(trackers.get(s.name), screen, Date.now(), s.dead);
    trackers.set(s.name, r.tracker);
    statusOf.set(s.name, r.status);
    if (r.event) alert(s.name, r.event);
  }));
}
setInterval(poll, 2000).unref();
poll();

// ---------- http ----------
const PUB = path.join(__dirname, 'public');
const NM = path.join(__dirname, 'node_modules');
const STATIC = {
  '/': [path.join(PUB, 'index.html'), 'text/html; charset=utf-8'],
  '/app.js': [path.join(PUB, 'app.js'), 'text/javascript'],
  '/style.css': [path.join(PUB, 'style.css'), 'text/css'],
  '/manifest.webmanifest': [path.join(PUB, 'manifest.webmanifest'), 'application/manifest+json'],
  '/icon.svg': [path.join(PUB, 'icon.svg'), 'image/svg+xml'],
  '/vendor/xterm.js': [path.join(NM, '@xterm/xterm/lib/xterm.js'), 'text/javascript'],
  '/vendor/xterm.css': [path.join(NM, '@xterm/xterm/css/xterm.css'), 'text/css'],
  '/vendor/addon-fit.js': [path.join(NM, '@xterm/addon-fit/lib/addon-fit.js'), 'text/javascript'],
};

const FRAME_ANCESTORS = config.frameAncestors.length ? config.frameAncestors.join(' ') : "'none'";
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; " +
  `frame-ancestors ${FRAME_ANCESTORS}`;

function send(res, code, body, type = 'application/json') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': CSP });
  res.end(buf);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 65536) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

async function requireSession(name) {
  if (!guard.validSessionName(name)) return null;
  return (await tmux.list()).find((s) => s.name === name) || null;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'GET' && STATIC[p]) {
    const [file, type] = STATIC[p];
    return fs.readFile(file, (err, data) => (err ? send(res, 404, 'not found', 'text/plain') : send(res, 200, data, type)));
  }
  if (req.method === 'GET' && p === '/api/state') {
    const sessions = (await tmux.list()).map((s) => ({ ...s, status: statusOf.get(s.name) || (s.dead ? 'exited' : 'idle') }));
    return send(res, 200, { lanes: Object.keys(tmux.LANES), sessions, notify: NOTIFY, projectsRoot: config.projectsRoot,
      transcribe: !!config.transcribeCommand, uploadMaxMB: config.uploadMaxMB });
  }
  if (req.method === 'GET' && p === '/api/projects') return send(res, 200, guard.listProjects(config));

  if (req.method === 'POST' && p === '/api/sessions') {
    const body = await readJson(req);
    if (!tmux.LANES[body.lane]) return send(res, 400, { error: 'unknown lane' });
    const project = guard.resolveProject(body.project, config);
    if (!project) return send(res, 403, { error: 'project not allowed' });
    const prompt = typeof body.prompt === 'string' ? body.prompt.slice(0, 8000) : '';
    const name = await tmux.create({ lane: body.lane, project, prompt });
    log('created', name, body.lane);
    return send(res, 200, { name });
  }

  if (req.method === 'POST' && p === '/api/transcribe') {
    if (!config.transcribeCommand) return send(res, 404, { error: 'transcription not configured' });
    const text = await voice.fromRequest(req, { dir: config.uploadsDir, command: config.transcribeCommand, maxBytes: 25 << 20 });
    log('transcribed', text.length, 'chars');
    return send(res, 200, { text });
  }

  const m = p.match(/^\/api\/sessions\/([^/]+)\/(keys|end|history|upload|size)$/);
  if (m) {
    const s = await requireSession(m[1]);
    if (!s) return send(res, 404, { error: 'no such session' });
    if (req.method === 'GET' && m[2] === 'history') {
      const lines = Math.min(Math.max(Number(url.searchParams.get('lines')) || 2000, 50), 20000);
      return send(res, 200, await tmux.capture(s.name, lines), 'text/plain; charset=utf-8');
    }
    if (req.method === 'POST' && m[2] === 'keys') {
      const body = await readJson(req);
      if (typeof body.key === 'string') {
        if (!tmux.KEYS.has(body.key) && !/^[0-9yn]$/.test(body.key)) return send(res, 400, { error: 'key not allowed' });
        await tmux.sendKey(s.name, body.key);
      }
      else if (typeof body.text === 'string') await tmux.sendText(s.name, body.text.slice(0, 20000));
      else return send(res, 400, { error: 'text or key required' });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && m[2] === 'upload') {
      const saved = await uploads.save(req, { dir: config.uploadsDir, session: s.name,
        filename: decodeURIComponent(req.headers['x-filename'] || ''), maxBytes: config.uploadMaxMB * 1048576 });
      log('upload', s.name, saved.bytes, 'bytes');
      return send(res, 200, saved);
    }
    if (req.method === 'POST' && m[2] === 'size') {
      const body = await readJson(req);
      const cols = Math.min(Math.max(body.cols | 0, 20), 400), rows = Math.min(Math.max(body.rows | 0, 5), 200);
      await tmux.resize(s.name, cols, rows);
      return send(res, 200, { cols, rows });
    }
    if (req.method === 'POST' && m[2] === 'end') {
      await tmux.kill(s.name);
      log('ended', s.name);
      return send(res, 200, { ok: true });
    }
  }
  send(res, 404, { error: 'not found' });
}

const devices = config.pairing ? pairing.store(config.stateDir) : null;
const paired = (req) => !devices || devices.check(pairing.readToken(req));

// Trade a one-time code (from `npm run pair` on the Mac) for a device cookie.
async function pair(req, res) {
  const body = await readJson(req);
  const token = devices.redeem(body.code, req.headers['user-agent']);
  if (!token) { log('pair failed'); return send(res, 403, { error: 'wrong or expired code' }); }
  log('paired a device');
  res.setHeader('Set-Cookie', pairing.cookieHeader(token, !CFG.localHosts.includes(req.headers.host)));
  // Also returned so a framed page (where the cookie is blocked) can keep it itself.
  return send(res, 200, { ok: true, token });
}

const server = http.createServer((req, res) => {
  const refused = guard.checkRequest(req, CFG);
  if (refused) { log('refused', refused, req.method, req.url.split('?')[0]); return send(res, 403, { error: 'forbidden' }); }
  const p = req.url.split('?')[0];
  if (devices && req.method === 'POST' && p === '/api/pair') {
    return pair(req, res).catch((e) => { log('error', e.message); if (!res.headersSent) send(res, 400, { error: e.message }); });
  }
  // The page and its scripts are public code; everything else needs a paired device.
  if (!(req.method === 'GET' && STATIC[p]) && !paired(req)) { log('unpaired', req.method, p); return send(res, 401, { error: 'unpaired' }); }
  handle(req, res).catch((e) => { log('error', e.message); if (!res.headersSent) send(res, e.status || 500, { error: e.message }); });
});

// ---------- live terminal over WebSocket ----------
// Browsers that offer subprotocols need one echoed back; "cockpit" is ours (the other carries the token).
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20,
  handleProtocols: (protocols) => (protocols.has('cockpit') ? 'cockpit' : false) });
server.on('upgrade', async (req, socket, head) => {
  const refused = guard.checkRequest(req, CFG);
  const url = new URL(req.url, 'http://x');
  const name = url.searchParams.get('name');
  const reason = refused || (!paired(req) && 'unpaired');
  if (reason || url.pathname !== '/ws/attach' || !(await requireSession(name).catch(() => null))) {
    log('ws refused', reason || 'bad-target');
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => attach(ws, name, url));
});

function attach(ws, name, url) {
  const cols = Math.min(Math.max(Number(url.searchParams.get('cols')) || 80, 20), 400);
  const rows = Math.min(Math.max(Number(url.searchParams.get('rows')) || 24, 5), 200);
  const term = pty.spawn('tmux', tmux.attachArgs(name), {
    name: 'xterm-256color', cols, rows, cwd: process.env.HOME,
    env: { ...process.env, TERM: 'xterm-256color', TMUX: '' },
  });
  term.onData((d) => { if (ws.readyState === 1) ws.send(d); });
  term.onExit(() => ws.close());
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === 'in' && typeof msg.d === 'string') term.write(msg.d);
    else if (msg.t === 'resize') term.resize(Math.min(Math.max(msg.c | 0, 20), 400), Math.min(Math.max(msg.r | 0, 5), 200));
  });
  ws.on('close', () => { try { term.kill(); } catch {} });
}

const where = config.socketPath ? `unix:${config.socketPath}` : `127.0.0.1:${PORT}`;
const ready = () => log(`cockpit on ${where} public=${PUBLIC_HOST} notify=${NOTIFY} local=${CFG.allowLocal} pairing=${!!devices}`);
if (config.socketPath) {
  prepareSocket(config.socketPath);
  server.listen(config.socketPath, () => { lockSocket(config.socketPath); ready(); });
} else {
  server.listen(PORT, '127.0.0.1', ready);
}
