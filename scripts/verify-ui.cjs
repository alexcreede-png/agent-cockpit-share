'use strict';
// Optional browser acceptance suite. Uses installed Playwright; no production data or sessions.
// NODE_PATH may point to a preinstalled Playwright package. Browser paths can be supplied with
// COCKPIT_WEBKIT_EXECUTABLE / COCKPIT_CHROMIUM_EXECUTABLE when using an existing browser bundle.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { webkit, chromium } = require('playwright');
const { WebSocketServer } = require('ws');
const root = process.env.COCKPIT_SOURCE_ROOT ? path.resolve(process.env.COCKPIT_SOURCE_ROOT) : path.resolve(__dirname, '..');
const artifacts = process.env.COCKPIT_ARTIFACT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-ui-'));
fs.mkdirSync(artifacts, { recursive: true });
const names = ['codex-example-project-alpha-1234', 'grok-example-project-beta-5678'];
const output = Array.from({ length: 90 }, (_, i) => `Output line ${i + 1}: readable text should wrap inside the session, with enough room for the message composer.`).join('\n');
let fixture;
function reset() {
  fixture = { offline: false, endError: false, sendError: false, projectError: false, uploadPending: null,
    holdUpload: false, holdSend: false, sendPending: null, transcribePending: null, connections: [], sent: [], sessions: names.map((name, i) => ({ name, lane: i ? 'grok' : 'codex', project: `/example/${i ? 'beta' : 'alpha'}`, created: Date.now(), status: i ? 'needs-you' : 'idle' })) };
}
const files = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript'],
  '/style.css': ['public/style.css', 'text/css'],
  '/icon.svg': ['public/icon.svg', 'image/svg+xml'],
  '/manifest.webmanifest': ['public/manifest.webmanifest', 'application/manifest+json'],
  '/vendor/xterm.js': ['node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript'],
  '/vendor/xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', 'text/css'],
  '/vendor/addon-fit.js': ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript'],
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const reply = (status, value, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type });
    res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
  };
  if (url.pathname === '/host') return reply(200, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;background:#101216;color:#eee;font:16px system-ui}header{height:90px;padding:30px 16px}iframe{display:block;width:calc(100% - 24px);height:610px;margin:0 12px;border:1px solid #30343c;border-radius:12px}footer{padding:24px}</style><header>Example host</header><iframe title="Cockpit" src="/"></iframe><footer>Host navigation</footer>`, 'text/html; charset=utf-8');
  if (files[url.pathname]) {
    const [file, type] = files[url.pathname];
    return reply(200, fs.readFileSync(path.join(root, file)), type);
  }
  if (url.pathname === '/api/embed-origins') return reply(200, [`http://127.0.0.1:${server.address().port}`]);
  if (fixture.offline) return reply(503, { error: 'Synthetic offline check' });
  if (url.pathname === '/api/state') return reply(200, { lanes: ['codex', 'grok', 'shell'], sessions: fixture.sessions, projectsRoot: '/example', uploadMaxMB: 2, transcribe: true });
  if (url.pathname === '/api/transcribe') { for await (const _chunk of req) {} fixture.transcribePending = () => reply(200, { text: 'dictated for alpha' }); return; }
  if (url.pathname === '/api/projects') return fixture.projectError ? reply(503, { error: 'Project list unavailable' }) : reply(200, [{ path: '/example/alpha', label: 'Alpha project' }, { path: '/example/beta', label: 'Beta project' }]);
  if (url.pathname === '/api/sessions' && req.method === 'POST') return reply(200, { name: names[0] });
  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(history|keys|end|size|upload)$/);
  if (!match) return reply(404, { error: 'Not found' });
  const [, name, action] = match;
  if (action === 'history') return reply(200, output, 'text/plain; charset=utf-8');
  if (action === 'keys') {
    let body = ''; for await (const chunk of req) body += chunk;
    fixture.sent.push({ name, ...JSON.parse(body) });
    const finish = () => fixture.sendError ? reply(503, { error: 'Synthetic delivery failure' }) : reply(200, { ok: true });
    if (fixture.holdSend) fixture.sendPending = finish; else finish(); return;
  }
  if (action === 'upload') {
    for await (const _chunk of req) { /* consume synthetic upload */ }
    const finish = () => reply(200, { path: `/example/uploads/${name}/sample.txt` });
    if (fixture.holdUpload) fixture.uploadPending = finish; else finish();
    return;
  }
  if (action === 'end') {
    if (fixture.endError) return reply(503, { error: 'Synthetic end failure' });
    fixture.sessions = fixture.sessions.filter(s => s.name !== name);
  }
  return reply(200, { ok: true });
});
const terminalServer = new WebSocketServer({ server, path: '/ws/attach' });
terminalServer.on('connection', (socket, request) => {
  socket.sessionName = new URL(request.url, 'http://localhost').searchParams.get('name');
  fixture.connections.push(socket);
  socket.send(`Synthetic live terminal: ${socket.sessionName}\r\n`);
  socket.on('message', raw => { const msg = JSON.parse(raw); if (msg.t === 'in') socket.send('Input received\r\n'); });
});
const pause = ms => new Promise(r => setTimeout(r, ms));
async function waitUntil(fn, description, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await pause(50); }
  throw new Error('Timed out: ' + description);
}
async function run(engineName, engine) {
  reset();
  const executablePath = process.env[`COCKPIT_${engineName.toUpperCase()}_EXECUTABLE`];
  const browser = await engine.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
      window.MediaRecorder = class { static isTypeSupported() { return true; } constructor() { this.mimeType = 'audio/webm'; this.state = 'inactive'; } start() { this.state = 'recording'; } stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['synthetic audio'], { type: 'audio/webm' }) }); this.onstop?.(); } };
    });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/host`);
    const frame = page.frameLocator('iframe');
    const sessions = frame.locator('#sessions');
    await sessions.getByRole('button').first().waitFor();
    await frame.locator('#session-search').fill('no matching project');
    assert.equal(await sessions.getByRole('button').count(), 0);
    assert.ok((await frame.locator('#list-state').innerText()).length > 0);
    await frame.locator('#session-search').fill('');
    const alpha = () => sessions.getByRole('button', { name: new RegExp(names[0]) });
    const beta = () => sessions.getByRole('button', { name: new RegExp(names[1]) });
    await alpha().focus(); await pause(3200);
    assert.equal(await alpha().evaluate(el => document.activeElement === el), true, 'polling preserves session-button focus');
    await alpha().press('Enter');
    await frame.locator('#reader').waitFor({ state: 'visible' });
    await frame.locator('#input').fill('Alpha draft');
    await frame.locator('[data-go="list"]:visible').click(); await beta().click();
    assert.equal(await frame.locator('#input').inputValue(), '', 'new session starts with its own draft');
    await frame.locator('#input').fill('Beta draft');
    await frame.locator('[data-go="list"]:visible').click(); await alpha().click();
    assert.equal(await frame.locator('#input').inputValue(), 'Alpha draft');
    fixture.holdUpload = true;
    await frame.locator('#file').setInputFiles({ name: 'sample.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic attachment') });
    await waitUntil(() => fixture.uploadPending, 'upload request');
    await frame.locator('[data-go="list"]:visible').click(); await beta().click();
    fixture.uploadPending(); fixture.holdUpload = false;
    await pause(150);
    assert.equal(await frame.locator('#attach-row').innerText(), '', 'late upload does not enter another session');
    assert.equal(await frame.locator('#input').inputValue(), 'Beta draft');
    await frame.locator('[data-go="list"]:visible').click(); await alpha().click();
    await frame.locator('#attach-row').getByText('sample.txt', { exact: false }).waitFor();
    fixture.sendError = true; await frame.locator('#send-btn').click();
    await frame.locator('#delivery.error').waitFor();
    assert.equal(await frame.locator('#input').inputValue(), 'Alpha draft');
    fixture.sendError = false; await frame.locator('#send-btn').click();
    await waitUntil(async () => await frame.locator('#input').inputValue() === '', 'successful send clears original draft');
    assert.equal(fixture.sent.at(-1).name, names[0]);
    assert.match(fixture.sent.at(-1).text, /sample\.txt/);
    fixture.holdSend = true; await frame.locator('#input').fill('Alpha in flight'); await frame.locator('#send-btn').click();
    await waitUntil(() => fixture.sendPending, 'pending send');
    await frame.locator('[data-go="list"]:visible').click(); await beta().click();
    fixture.sendPending(); fixture.holdSend = false; await pause(100);
    assert.equal(await frame.locator('#input').inputValue(), 'Beta draft', 'late send completion preserves another draft');
    await frame.locator('[data-go="list"]:visible').click(); await alpha().click();
    assert.equal(await frame.locator('#input').inputValue(), '', 'sent draft clears in original session');
    await frame.locator('#mic-btn').click();
    await frame.locator('[data-go="list"]:visible').click(); await beta().click();
    await waitUntil(() => fixture.transcribePending, 'transcription request'); fixture.transcribePending(); await pause(100);
    assert.equal(await frame.locator('#input').inputValue(), 'Beta draft', 'late dictation stays out of current session');
    await frame.locator('[data-go="list"]:visible').click(); await alpha().click();
    assert.match(await frame.locator('#input').inputValue(), /dictated for alpha/, 'dictation returns to originating draft');
    fixture.endError = true; await frame.locator('#kill-btn').click(); await frame.locator('#kill-btn').click();
    await pause(150);
    assert.equal(await frame.locator('#term-view').isVisible(), true, 'failed end retains session view');
    assert.ok(await frame.locator('#delivery.error').isVisible(), 'failed end is visible');
    fixture.endError = false;
    await frame.locator('#mode-btn').click(); await frame.locator('#term .xterm-screen').waitFor();
    await waitUntil(() => fixture.connections.length > 0, 'live terminal attachment');
    const beforeReconnect = fixture.connections.length;
    fixture.connections.at(-1).terminate();
    await waitUntil(() => fixture.connections.length > beforeReconnect, 'active socket reconnect');
    await frame.locator('#connection-state[data-state="connected"]').waitFor();
    assert.equal([...terminalServer.clients].filter(socket => socket.readyState === 1).length, 1, 'one active socket after reconnect');
    await frame.locator('[data-go="list"]:visible').click(); await beta().click();
    await waitUntil(() => fixture.connections.at(-1).sessionName === names[1], 'new session socket');
    await waitUntil(async () => frame.locator('#term').evaluate(() => {
      const buffer = term.buffer.active;
      return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString() || '').join('').includes('grok-example-project-beta-5678');
    }), 'new session output');
    assert.equal(await frame.locator('#term').evaluate(() => {
      const buffer = term.buffer.active;
      return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString() || '').join('').includes('codex-example-project-alpha-1234');
    }), false, 'previous session output never appears in new terminal');
    await frame.locator('[data-go="list"]:visible').click(); await alpha().click();
    await frame.locator('#mode-btn').click(); await frame.locator('#reader').waitFor({state:'visible'});
    await frame.locator('#reader').filter({hasText:'Output line 90'}).waitFor();
    await frame.locator('#reader').evaluate(el => { el.scrollTop = 50; }); await pause(1700);
    assert.equal(await frame.locator('#reader').evaluate(el => Math.round(el.scrollTop)), 50);
    await frame.locator('#to-bottom').click();
    for (const width of [320, 390, 430, 1280]) {
      await page.setViewportSize({ width, height: width > 500 ? 900 : 844 }); await pause(250);
      const box = await frame.locator('body').evaluate(() => ({ width: innerWidth, overflow: document.body.scrollWidth > innerWidth, inputBottom: document.querySelector('#input-row').getBoundingClientRect().bottom, height: innerHeight, readerOverflow: document.querySelector('#reader').scrollWidth > document.querySelector('#reader').clientWidth }));
      assert.equal(box.overflow, false); assert.equal(box.readerOverflow, false); assert.ok(box.inputBottom <= box.height, JSON.stringify(box));
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('iframe').evaluate(el => { el.style.height = '300px'; }); await pause(250);
    assert.ok(await frame.locator('#reader').evaluate(el => el.clientHeight >= 60), 'short frame keeps readable space');
    await page.locator('iframe').evaluate(el => { el.style.height = '610px'; }); await pause(250);
    if (await frame.locator('#to-bottom').isVisible()) await frame.locator('#to-bottom').click();
    await page.screenshot({ path: path.join(artifacts, `${engineName}-session.png`) });
    await frame.locator('[data-go="list"]:visible').click();
    await page.screenshot({ path: path.join(artifacts, `${engineName}-sessions.png`) });
    await frame.locator('#new-btn').click();
    await frame.locator('#lanes').getByRole('button', { name: /codex/i }).click();
    await frame.locator('#projects').getByRole('button', { name: /Alpha project/i }).click();
    assert.equal(await frame.locator('#start-btn').isEnabled(), true);
    await page.screenshot({ path: path.join(artifacts, `${engineName}-new.png`) });
    await frame.locator('#start-btn').click(); await frame.locator('#term-view').waitFor({state:'visible'});
    fixture.offline = true; await pause(3300);
    assert.match(await frame.locator('#connection-state').innerText(), /offline|retry|connect|unreachable/i);
    fixture.offline = false; await pause(3300);
    assert.doesNotMatch(await frame.locator('#connection-state').innerText(), /offline|lost/i);
    assert.deepEqual(errors, []);
    console.log(`${engineName}: keyboard/focus, drafts, delayed upload, failed send/end, scroll, live reconnect/session isolation, responsive layouts and new-session flow PASS`);
  } finally { await browser.close(); }
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run('webkit', webkit); await run('chromium', chromium); console.log('Screenshots:', artifacts); }
  finally { for (const client of terminalServer.clients) client.terminate(); terminalServer.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
