'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createStarter, MAX_RECORD_BYTES } = require('../lib/starts');
const { fakeMachine, serverHarness } = require('./helpers/start-harness');
const pairing = require('../lib/pairing');

const ID = 'phone-start-request_01';
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-start-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'projects', 'example'); fs.mkdirSync(project, { recursive: true });
  const stateDir = path.join(root, 'state');
  const payload = { lane: 'grok', project, prompt: 'Synthetic first message 🌿\nSecond line' };
  const machine = fakeMachine();
  const restart = () => createStarter({ stateDir, tmux: machine.loadTmux() });
  const recordFile = path.join(stateDir, 'start-requests', hash(ID) + '.json');
  const config = { stateDir, port: 9999, publicHost: '', allowLocal: true, user: 'example@example.com',
    projectsRoot: path.join(root, 'projects'), forbiddenPaths: [], pairing: false, frameAncestors: [],
    uploadsDir: '', notify: false, socketPath: '', grokHome: path.join(root, 'fake-provider') };
  return { root, payload, machine, restart, recordFile, stateDir, config };
}
const errorCode = (code) => (e) => e.code === code && e.status === 409;

test('concurrent identical requests reserve before side effects and create only once', async (t) => {
  const f = fixture(t), starter = f.restart();
  let sawReservation = false;
  f.machine.before = async (args) => {
    if (args[0] !== 'new-session') return;
    const r = JSON.parse(fs.readFileSync(f.recordFile, 'utf8'));
    assert.equal(r.name, args[args.indexOf('-s') + 1]);
    assert.deepEqual(Object.keys(r).sort(), ['digest', 'name', 'version']);
    sawReservation = true;
    await new Promise((r) => setImmediate(r));
  };
  const results = await Promise.all(Array.from({ length: 20 }, () => starter.start(f.payload, ID)));
  assert.ok(sawReservation);
  assert.equal(f.machine.creates(), 1);
  assert.equal(new Set(results.map((r) => r.name)).size, 1);
  assert.equal(results.filter((r) => !r.reused).length, 1);
  assert.ok(results.every((r) => r.requestId === ID));
  const raw = fs.readFileSync(f.recordFile, 'utf8');
  for (const secret of [f.payload.prompt, f.payload.project, ID]) assert.equal(raw.includes(secret), false);
  assert.ok(Buffer.byteLength(raw) < MAX_RECORD_BYTES);
  for (const dir of [f.stateDir, path.dirname(f.recordFile)]) assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(f.recordFile).mode & 0o777, 0o600);
});

test('lost HTTP response and full server reconstruction reconcile the same result', async (t) => {
  const f = fixture(t);
  const first = await serverHarness(f.config, f.machine, { dropResponse: true }).request({ ...f.payload, requestId: ID });
  assert.equal(first.status, 200); assert.equal(first.body, null);
  const name = [...f.machine.sessions.keys()][0];
  const response = await serverHarness(f.config, f.machine).request({ ...f.payload, requestId: ID });
  assert.deepEqual(response, { status: 200, body: { name, requestId: ID, reused: true } });
  assert.equal(f.machine.creates(), 1);
});

test('mismatched prompt, lane or project refuses without changing the original reservation', async (t) => {
  const f = fixture(t), starter = f.restart();
  const original = await starter.start(f.payload, ID), raw = fs.readFileSync(f.recordFile, 'utf8');
  for (const change of [{ prompt: 'Different' }, { lane: 'agy' }, { project: f.root }]) {
    await assert.rejects(starter.start({ ...f.payload, ...change }, ID), errorCode('START_REQUEST_MISMATCH'));
  }
  assert.equal(fs.readFileSync(f.recordFile, 'utf8'), raw);
  assert.equal((await starter.start(f.payload, ID)).name, original.name);
  assert.equal(f.machine.creates(), 1);
});

test('malformed request IDs reject before state access or tmux creation', async (t) => {
  const f = fixture(t), starter = f.restart();
  for (const id of [null, '', 'short', 42, {}, [], 'x'.repeat(129), '../' + 'x'.repeat(20),
    'x'.repeat(16) + '\n', 'x'.repeat(16) + ' ', 'x'.repeat(16) + '\0', '🌿'.repeat(16)]) {
    await assert.rejects(starter.start(f.payload, id), (e) => e.code === 'START_INVALID_REQUEST_ID' && e.status === 400);
  }
  assert.equal(f.machine.creates(), 0);
  assert.equal(fs.existsSync(f.stateDir), false);
});

test('a create timeout after the side effect recovers by exact ownership without another launch', async (t) => {
  const f = fixture(t); f.machine.failAfterCreate = true;
  const result = await f.restart().start(f.payload, ID);
  assert.equal(result.reused, false);
  assert.equal(f.machine.sessions.get(result.name).metadata['@lane'], 'grok');
  assert.equal((await f.restart().start(f.payload, ID)).name, result.name);
  assert.equal(f.machine.creates(), 1);
});

test('partial metadata failure remains recoverable across restart and never cancels any session', async (t) => {
  const f = fixture(t); f.machine.failMetadata = '@project';
  f.machine.sessions.set('unrelated-task', { name: 'unrelated-task', env: {}, metadata: {}, dead: false });
  await assert.rejects(f.restart().start(f.payload, ID), errorCode('START_UNCONFIRMED'));
  const name = JSON.parse(fs.readFileSync(f.recordFile, 'utf8')).name;
  assert.ok(f.machine.sessions.has(name));
  assert.equal(f.machine.sessions.get(name).metadata['@lane'], 'grok');
  assert.equal(f.machine.sessions.get(name).metadata['@project'], undefined);
  f.machine.failMetadata = false;
  const result = await f.restart().start(f.payload, ID);
  assert.equal(result.name, name); assert.equal(result.reused, true);
  assert.equal(f.machine.sessions.get(name).metadata['@project'], f.payload.project);
  assert.ok(f.machine.sessions.has('unrelated-task'));
  assert.equal(f.machine.calls.some((c) => c[0] === 'kill-session'), false);
  assert.equal(f.machine.creates(), 1);
});

test('reserved but unprovable start never launches again, even after restart', async (t) => {
  const f = fixture(t); f.machine.failCreate = true;
  const first = await serverHarness(f.config, f.machine).request({ ...f.payload, requestId: ID });
  assert.equal(first.status, 409); assert.equal(first.body.code, 'START_UNCONFIRMED');
  f.machine.failCreate = false;
  const retry = await serverHarness(f.config, f.machine).request({ ...f.payload, requestId: ID });
  assert.deepEqual(retry, first);
  assert.equal(f.machine.creates(), 1); assert.equal(f.machine.sessions.size, 0);
});

test('crash between reservation and create fails closed after restart', async (t) => {
  const f = fixture(t);
  // Terminate a separate process at the real implementation's first side-effect boundary.
  const child = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const { createStarter } = require(process.argv[1]);
    const x = JSON.parse(fs.readFileSync(0, 'utf8'));
    createStarter({stateDir:x.stateDir, tmux:{create(){process.exit(0);}}})
      .start(x.payload, x.id).catch(() => process.exit(1));
  `, path.resolve(__dirname, '../lib/starts.js')], {
    input: JSON.stringify({ stateDir: f.stateDir, payload: f.payload, id: ID }), encoding: 'utf8', timeout: 5000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.ok(JSON.parse(fs.readFileSync(f.recordFile, 'utf8')).name);
  await assert.rejects(f.restart().start(f.payload, ID), errorCode('START_UNCONFIRMED'));
  assert.equal(f.machine.creates(), 0);
});

test('overlapping independent server instances cannot both launch a reserved request', async (t) => {
  const f = fixture(t), a = f.restart(), b = f.restart();
  let release, entered;
  const gate = new Promise((r) => { release = r; });
  const started = new Promise((r) => { entered = r; });
  f.machine.before = async (args) => {
    if (args[0] === 'new-session') { entered(); await gate; }
  };
  const pending = a.start(f.payload, ID);
  await started;
  try {
    await assert.rejects(b.start(f.payload, ID), errorCode('START_UNCONFIRMED'));
  } finally { release(); }
  const first = await pending, retry = await b.start(f.payload, ID);
  assert.equal(retry.name, first.name); assert.equal(retry.reused, true);
  assert.equal(f.machine.creates(), 1);
});

test('a different session at the planned name cannot be adopted, mutated or cancelled', async (t) => {
  const f = fixture(t), first = await f.restart().start(f.payload, ID);
  f.machine.sessions.set(first.name, { name: first.name, env: { COCKPIT_START_TOKEN: 'unrelated' }, metadata: {}, dead: false });
  const before = f.machine.calls.length;
  await assert.rejects(f.restart().start(f.payload, ID), errorCode('START_UNCONFIRMED'));
  assert.deepEqual(f.machine.sessions.get(first.name).metadata, {});
  assert.equal(f.machine.calls.slice(before).some((c) => ['set-option', 'kill-session'].includes(c[0])), false);
  assert.equal(f.machine.creates(), 1);
});

test('inspection failures retain the reservation and retry recovers without launching', async (t) => {
  const f = fixture(t); f.machine.failInspect = true;
  await assert.rejects(f.restart().start(f.payload, ID), errorCode('START_UNCONFIRMED'));
  f.machine.failInspect = false;
  assert.equal((await f.restart().start(f.payload, ID)).reused, true);
  assert.equal(f.machine.creates(), 1);
});

test('dead and explicitly deleted sessions never recreate their old request', async (t) => {
  const f = fixture(t), first = await f.restart().start(f.payload, ID);
  f.machine.sessions.get(first.name).dead = true;
  await assert.rejects(f.restart().start(f.payload, ID), errorCode('START_SESSION_ENDED'));
  const ended = await serverHarness(f.config, f.machine).request({}, { url: `/api/sessions/${first.name}/end` });
  assert.equal(ended.status, 200);
  await assert.rejects(f.restart().start(f.payload, ID), errorCode('START_UNCONFIRMED'));
  assert.equal(f.machine.creates(), 1);
});

test('unsafe, oversized, torn and symlinked records fail closed with bounded reads', async (t) => {
  const f = fixture(t), starter = f.restart();
  await starter.start(f.payload, ID);
  const valid = fs.readFileSync(f.recordFile);
  for (const content of ['', '{"partial":', 'x'.repeat(MAX_RECORD_BYTES + 1),
    JSON.stringify({ version: 1, name: ['grok-start-' + 'a'.repeat(32)], digest: 'a'.repeat(64) })]) {
    fs.writeFileSync(f.recordFile, content);
    await assert.rejects(f.restart().start(f.payload, ID), errorCode('START_UNCONFIRMED'));
  }
  fs.writeFileSync(f.recordFile, valid); fs.chmodSync(f.recordFile, 0o644);
  await assert.rejects(f.restart().start(f.payload, ID), errorCode('START_UNCONFIRMED'));
  fs.chmodSync(f.recordFile, 0o600);
  fs.renameSync(f.recordFile, f.recordFile + '.original');
  fs.symlinkSync(f.recordFile + '.original', f.recordFile);
  await assert.rejects(f.restart().start(f.payload, ID), errorCode('START_UNCONFIRMED'));
  assert.equal(f.machine.creates(), 1);
});

test('open state directories refuse without permission changes or side effects', async (t) => {
  const f = fixture(t); fs.mkdirSync(f.stateDir, { mode: 0o755 }); fs.chmodSync(f.stateDir, 0o755);
  await assert.rejects(f.restart().start(f.payload, ID), errorCode('START_UNCONFIRMED'));
  assert.equal(fs.statSync(f.stateDir).mode & 0o777, 0o755);
  assert.equal(f.machine.creates(), 0);
});

test('old clients without an ID retain independent creates and the exact legacy response', async (t) => {
  const f = fixture(t), server = serverHarness(f.config, f.machine);
  const a = await server.request(f.payload), b = await server.request(f.payload);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.deepEqual(Object.keys(a.body), ['name']);
  assert.notEqual(a.body.name, b.body.name); assert.equal(f.machine.creates(), 2);
  assert.equal(fs.existsSync(path.dirname(f.recordFile)), false);
});

test('create route preserves guard, pairing, project and payload checks before reservations', async (t) => {
  const f = fixture(t); f.config.pairing = true;
  const devices = pairing.store(f.stateDir), token = devices.redeem(devices.newCode().code, 'synthetic phone');
  const server = serverHarness(f.config, f.machine);
  const body = { ...f.payload, requestId: ID };
  assert.equal((await server.request(body)).status, 401);
  assert.equal((await server.request(body, { headers: { host: 'attacker.invalid' } })).status, 403);
  assert.equal((await server.request(body, { headers: { origin: 'https://attacker.invalid', 'x-cockpit-device': token } })).status, 403);
  const options = { headers: { 'x-cockpit-device': token } };
  assert.equal((await server.request({ ...body, project: f.root }, options)).status, 403);
  assert.equal((await server.request({ ...body, prompt: 'x'.repeat(8001) }, options)).status, 413);
  assert.equal((await server.request({ ...body, lane: '__proto__' }, options)).status, 400);
  assert.equal(fs.existsSync(path.dirname(f.recordFile)), false);
  assert.equal(f.machine.creates(), 0);
  const malformed = await server.request({ ...body, requestId: null }, options);
  assert.equal(malformed.status, 400); assert.equal(malformed.body.code, 'START_INVALID_REQUEST_ID');
  const valid = await server.request(body, options);
  assert.equal(valid.status, 200); assert.equal(valid.body.requestId, ID);
  const mismatch = await server.request({ ...body, prompt: 'Different' }, options);
  assert.equal(mismatch.status, 409); assert.equal(mismatch.body.code, 'START_REQUEST_MISMATCH');
  assert.equal(f.machine.creates(), 1);
});

// A pane can disappear after requireSession succeeds while the phone polls history.
test('numeric process failures return an error and leave the HTTP handler available', async (t) => {
  const f = fixture(t), server = serverHarness(f.config, f.machine);
  const started = await server.request({ ...f.payload, requestId: ID });
  assert.equal(started.status, 200);
  f.machine.before = async (args) => {
    if (args[0] === 'capture-pane') throw Object.assign(new Error('pane ended during capture'), { code: 1 });
  };
  const failed = await server.request({}, { method: 'GET', url: `/api/sessions/${started.body.name}/history` });
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, { error: 'pane ended during capture' });
  const projects = await server.request({}, { method: 'GET', url: '/api/projects' });
  assert.equal(projects.status, 200);
  assert.ok(Array.isArray(projects.body));
});

test('saved conversation yields to a current terminal error or approval and resumes after recovery', async t => {
  const f = fixture(t), saved = { source: 'conversation', messages: [{ id: '1', role: 'assistant', text: 'Earlier answer' }] };
  const server = serverHarness(f.config, f.machine, { readConversation: async () => saved });
  const started = await server.request({ ...f.payload, requestId: ID });
  const read = () => server.request({}, { method: 'GET', url: `/api/sessions/${started.body.name}/history?format=reader` });
  f.machine.screen = 'Earlier answer\nReady for another message';
  assert.deepEqual((await read()).body, saved);
  for (const message of ['Error: connection interrupted; please retry.', 'Authentication required. Sign in to continue.', 'RESOURCE_EXHAUSTED: quota exceeded', 'Allow this command?\n1. Yes\n2. No']) {
    f.machine.screen = 'Earlier answer\n' + message;
    assert.equal((await read()).body, f.machine.screen);
  }
  f.machine.screen = 'New answer\nReady for another message';
  assert.deepEqual((await read()).body, saved);
});
