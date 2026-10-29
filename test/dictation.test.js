'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, PassThrough } = require('node:stream');
const { createDictation, LIMITS } = require('../lib/dictation');
const { createTranscriber } = require('../lib/transcribe');
const { fakeMachine, serverHarness } = require('./helpers/start-harness');
const pairing = require('../lib/pairing');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(fn) {
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
  assert.fail('fixture did not settle');
}
const id = n => n.toString(16).padStart(32, '0');
function clock() {
  let time = 0; const timers = new Set();
  return { now: () => time, schedule(fn, ms) { const timer = { fn, at: time + ms }; timers.add(timer); return timer; },
    unschedule(timer) { timers.delete(timer); },
    advance(ms) { time += ms; for (const t of [...timers]) if (t.at <= time) { timers.delete(t); t.fn(); } } };
}
function fixture(t, limits = LIMITS, { ignoreProcessTimeout = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-voice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const processes = [], time = clock();
  const voice = createTranscriber({ execFile(cmd, args, opts, done) {
    assert.equal(cmd, 'synthetic-command');
    const audio = fs.readFileSync(args.at(-1), 'utf8');
    const timeout = ignoreProcessTimeout ? null : time.schedule(() => done(new Error('command timed out'), '', ''), opts.timeout);
    const child = { audio, opts, finish(text = audio) { time.unschedule(timeout); done(null, text, ''); } }; processes.push(child);
    return { kill(signal) { assert.equal(signal, 'SIGKILL'); time.unschedule(timeout); child.cancelled = true; done(new Error('cancelled'), '', ''); return true; } };
  } });
  const jobs = createDictation({ process: voice.fromRequest, ...time, limits });
  const options = { dir, command: ['synthetic-command'], maxBytes: 100 };
  const submit = (n, text = `audio ${n}`, task = 'a') => jobs.submit(id(n), jobs.epoch, task,
    Object.assign(Readable.from([text]), { headers: { 'content-type': 'audio/webm' } }), options);
  const status = (n, task = 'a') => jobs.status(id(n), jobs.epoch, task);
  const files = () => fs.existsSync(path.join(dir, '.voice')) ? fs.readdirSync(path.join(dir, '.voice')) : [];
  return { dir, processes, time, jobs, options, submit, status, files };
}

test('queued audio beyond 60s, lost upload receipt and repeated retrieval execute each recording once', async t => {
  const f = fixture(t);
  f.submit(1, 'first'); await f.jobs.accepted(id(1)); await until(() => f.processes.length === 1);
  f.submit(2, 'second'); await f.jobs.accepted(id(2)); // Ignore receipt, as if HTTP response was lost.
  f.time.advance(61000);
  for (let i = 0; i < 8; i++) {
    assert.equal(f.status(2).state, 'pending');
    f.submit(2, 'MUST NOT EXECUTE');
  }
  assert.equal(f.processes.length, 1, 'second process is still queued beyond browser timeout');
  assert.deepEqual(f.processes.map(p => p.audio), ['first']);
  f.processes[0].finish(); await until(() => f.processes.length === 2);
  assert.equal(f.processes[1].audio, 'second', 'retry never replaces original audio');
  f.processes[1].finish('recovered original'); await until(() => f.status(2).state === 'complete');
  for (let i = 0; i < 4; i++) assert.equal(f.status(2).text, 'recovered original');
  assert.equal(f.processes.length, 2);
  await until(() => f.files().length === 0);
});

test('read-only unknown lookup, task mismatch and stale boot never start processes', async t => {
  const f = fixture(t);
  for (let n = 1; n < 12; n++) assert.equal(f.status(n).state, 'unknown');
  assert.equal(f.files().length, 0); assert.equal(f.processes.length, 0);
  f.submit(1); await f.jobs.accepted(id(1)); await until(() => f.processes.length === 1);
  assert.throws(() => f.status(1, 'b'), e => e.status === 409);
  const restarted = createDictation({ process() { assert.fail('must not process stale requests'); }, ...f.time });
  assert.throws(() => restarted.submit(id(1), f.jobs.epoch, 'a', Readable.from(['x']), f.options), e => e.status === 410);
  f.processes[0].finish(); await until(() => f.files().length === 0);
});

test('discard before upload, during upload, queued and running stops late text and never restarts', async t => {
  const f = fixture(t);
  f.jobs.cancel(id(1), f.jobs.epoch, 'a'); f.submit(1);
  assert.equal(f.status(1).state, 'cancelled'); assert.equal(f.files().length, 0);
  const stream = Object.assign(new PassThrough(), { headers: { 'content-type': 'audio/webm' } });
  f.jobs.submit(id(2), f.jobs.epoch, 'a', stream, f.options);
  stream.write('partial'); await tick(); f.jobs.cancel(id(2), f.jobs.epoch, 'a');
  await until(() => f.files().length === 0);
  f.submit(3); await f.jobs.accepted(id(3)); await until(() => f.processes.length === 1);
  f.submit(4); await f.jobs.accepted(id(4)); assert.equal(f.files().length, 2);
  f.jobs.cancel(id(4), f.jobs.epoch, 'a'); await until(() => f.files().length === 1);
  f.jobs.cancelTask('a'); await until(() => f.files().length === 0);
  f.processes[0].finish('late text'); await tick();
  for (const n of [1, 2, 3, 4]) { assert.equal(f.status(n).text, undefined); f.submit(n); }
  assert.equal(f.processes.length, 1); assert.equal(f.processes[0].cancelled, true);
});

test('admission bounds include receiving/queued work; expiration removes results but preserves deduplication', async t => {
  const f = fixture(t, { ...LIMITS, jobs: 2, identities: 3 });
  f.submit(1); await f.jobs.accepted(id(1)); await until(() => f.processes.length === 1);
  f.submit(2); await f.jobs.accepted(id(2));
  assert.throws(() => f.submit(3), e => e.status === 503);
  f.processes[0].finish('kept briefly'); await until(() => f.processes.length === 2);
  f.processes[1].finish(); await until(() => f.status(1).state === 'complete' && f.status(2).state === 'complete');
  f.time.advance(LIMITS.resultMs + 1);
  assert.equal(f.status(1).state, 'expired'); assert.equal(f.status(1).text, undefined);
  f.submit(1); assert.equal(f.processes.length, 2, 'expired ID cannot execute again');
  f.submit(3); await f.jobs.accepted(id(3)); await until(() => f.processes.length === 3);
  f.processes[2].finish('x'.repeat(LIMITS.textChars + 1)); await until(() => f.status(3).state === 'failed');
  assert.equal(f.status(3).text, undefined);
  assert.throws(() => f.submit(4), e => e.status === 503 && e.code === 'DICTATION_CAPACITY' && /Restart Cockpit/.test(e.message), 'identity budget never evicts deduplication tombstones');
  await until(() => f.files().length === 0);
});

test('job deadline aborts hung upload and queued command; no expired queued command starts later', async t => {
  const f = fixture(t, LIMITS, { ignoreProcessTimeout: true });
  f.submit(1); await f.jobs.accepted(id(1)); await until(() => f.processes.length === 1);
  f.submit(2); await f.jobs.accepted(id(2));
  const stream = Object.assign(new PassThrough(), { headers: { 'content-type': 'audio/webm' } });
  f.jobs.submit(id(3), f.jobs.epoch, 'a', stream, f.options); stream.write('partial'); await tick();
  f.time.advance(LIMITS.jobMs + 1); await until(() => f.files().length === 0);
  assert.equal(f.processes.length, 1); assert.equal(f.processes[0].cancelled, true);
  for (const n of [1, 2, 3]) assert.equal(f.status(n).state, 'expired');
});

test('processing failure and interrupted/oversized streams clean up and do not rerun the same ID', async t => {
  const f = fixture(t);
  f.submit(1, 'x'.repeat(101)); await f.jobs.accepted(id(1)); assert.equal(f.status(1).state, 'failed');
  const stream = Object.assign(new PassThrough(), { headers: { 'content-type': 'audio/webm' } });
  f.jobs.submit(id(2), f.jobs.epoch, 'a', stream, f.options); stream.write('partial'); await tick(); stream.emit('aborted');
  await f.jobs.accepted(id(2)); assert.equal(f.status(2).state, 'failed');
  f.submit(1); f.submit(2); assert.equal(f.processes.length, 0); assert.equal(f.files().length, 0);
  stream.destroy();
});

function httpFixture(t) {
  const f = fixture(t), machine = fakeMachine();
  const project = path.join(f.dir, 'projects', 'example'); fs.mkdirSync(project, { recursive: true });
  for (const name of ['a', 'b']) machine.sessions.set(name, { name, env: {}, metadata: { '@lane': 'shell', '@project': project }, dead: false });
  const config = { stateDir: path.join(f.dir, 'state'), port: 9999, publicHost: 'voice.example-tailnet.test:8444', user: 'owner@example.test', allowLocal: true,
    projectsRoot: path.dirname(project), forbiddenPaths: [], pairing: true, frameAncestors: [], uploadsDir: f.dir,
    transcribeCommand: ['synthetic-command'], notify: false, socketPath: '', grokHome: path.join(f.dir, 'fake-provider') };
  const devices = pairing.store(config.stateDir), token = devices.redeem(devices.newCode().code, 'synthetic');
  const processing = [];
  const server = serverHarness(config, machine, { voice: { fromRequest: async (req, opts) => {
    opts.onAccepted?.(); return new Promise((resolve, reject) => { processing.push({ resolve, reject, signal: opts.signal });
      opts.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); });
  } }, dictation: { createDictation: options => createDictation({ ...options, ...f.time }) }, readConversation: async () => null });
  const request = (url, method = 'GET', headers = {}) => server.request({}, { url, method, headers: { 'x-cockpit-device': token, ...headers }, raw: Buffer.from('synthetic audio') });
  return { ...f, machine, request, server, token, processing };
}

test('actual HTTP routes enforce guard/pairing, task ownership, read-only checks and end cancellation', async t => {
  const f = httpFixture(t);
  const epoch = (await f.request('/api/state')).body.dictationEpoch;
  const status = `/api/transcribe/${id(1)}?epoch=${epoch}&task=a`;
  const headers = { 'x-dictation-id': id(1), 'x-dictation-epoch': epoch, 'x-dictation-task': 'a' };
  for (const [url, method] of [['/api/transcribe', 'POST'], [status, 'GET'], [status.replace('?', '/cancel?'), 'POST']]) {
    assert.equal((await f.request(url, method, { ...headers, 'x-cockpit-device': '' })).status, 401);
    if (method !== 'GET') assert.equal((await f.request(url, method, { ...headers, origin: 'https://evil.example' })).status, 403);
    assert.equal((await f.request(url, method, { ...headers, host: 'evil.example' })).status, 403);
    assert.equal((await f.request(url, method, { ...headers, host: 'voice.example-tailnet.test:8444', origin: 'https://voice.example-tailnet.test:8444' })).status, 403, 'Tailscale identity required');
  }
  assert.equal((await f.request(status)).body.state, 'unknown');
  assert.equal((await f.request('/api/transcribe', 'POST', headers)).status, 202);
  assert.equal((await f.request('/api/transcribe', 'POST', headers)).body.state, 'pending');
  assert.equal((await f.request(status.replace('task=a', 'task=b'))).status, 409);
  assert.equal((await f.request('/api/sessions/a/end', 'POST')).status, 200);
  assert.equal((await f.request(status)).body.state, 'cancelled');
  assert.equal((await f.request('/api/transcribe', 'POST', headers)).body.state, 'cancelled');
  assert.equal((await f.request('/api/transcribe', 'POST', { ...headers, 'x-dictation-id': id(2) })).status, 410);
});

test('legacy POST still waits for {text} and shares bounded admission with recoverable requests', async t => {
  const f = httpFixture(t);
  let settled = false;
  const legacy = f.request('/api/transcribe', 'POST').then(result => { settled = true; return result; });
  await until(() => f.processing.length === 1);
  assert.equal(settled, false, 'legacy response waits for transcription');
  const epoch = (await f.request('/api/state')).body.dictationEpoch;
  for (let n = 1; n <= 3; n++) assert.equal((await f.request('/api/transcribe', 'POST', {
    'x-dictation-id': id(n), 'x-dictation-epoch': epoch, 'x-dictation-task': 'a' })).status, 202);
  assert.equal((await f.request('/api/transcribe', 'POST')).status, 503);
  f.processing[0].resolve('legacy text');
  const result = await legacy;
  assert.equal(result.status, 200); assert.deepEqual(result.body, { text: 'legacy text' });
  for (const job of f.processing.slice(1)) job.resolve('recovered');
  await tick();
});

test('read-only status and duplicate POST with a naturally ended original task cannot return late text', async t => {
  const f = httpFixture(t);
  const epoch = (await f.request('/api/state')).body.dictationEpoch;
  const headers = { 'x-dictation-id': id(1), 'x-dictation-epoch': epoch, 'x-dictation-task': 'a' };
  await f.request('/api/transcribe', 'POST', headers);
  f.machine.sessions.get('a').dead = true;
  f.processing[0].resolve('late words'); await tick();
  assert.equal((await f.request(`/api/transcribe/${id(1)}?epoch=${epoch}&task=a`)).status, 410);
  assert.equal((await f.request('/api/transcribe', 'POST', headers)).status, 410);
  assert.equal(f.processing.length, 1);
});

test('180-second command timeout fails only that job, releases its audio and advances the queue', async t => {
  const f = fixture(t);
  f.submit(1, 'first stalls'); await f.jobs.accepted(id(1)); await until(() => f.processes.length === 1);
  f.submit(2, 'second succeeds'); await f.jobs.accepted(id(2));
  f.time.advance(60001); assert.equal(f.processes.length, 1); assert.equal(f.status(2).state, 'pending');
  f.time.advance(120000); await until(() => f.processes.length === 2);
  await until(() => f.status(1).state === 'failed');
  assert.equal(f.status(1).text, undefined); assert.equal(f.processes[1].audio, 'second succeeds');
  f.processes[1].finish('second result'); await until(() => f.status(2).state === 'complete');
  f.submit(1, 'retry must not run'); assert.equal(f.processes.length, 2);
  await until(() => f.files().length === 0);
});

test('End after original task disappeared still cancels its owned processing', async t => {
  const f = httpFixture(t);
  const epoch = (await f.request('/api/state')).body.dictationEpoch;
  await f.request('/api/transcribe', 'POST', { 'x-dictation-id': id(1), 'x-dictation-epoch': epoch, 'x-dictation-task': 'a' });
  f.machine.sessions.delete('a');
  assert.equal((await f.request('/api/sessions/a/end', 'POST')).body.absent, true);
  assert.equal(f.processing[0].signal.aborted, true);
  assert.equal((await f.request(`/api/transcribe/${id(1)}?epoch=${epoch}&task=a`)).body.state, 'cancelled');
});

test('concurrent Ends keep new uploads blocked until every in-flight End settles', async t => {
  const f = httpFixture(t);
  const epoch = (await f.request('/api/state')).body.dictationEpoch;
  const releases = [];
  f.machine.before = async command => {
    if (command[0] !== 'kill-session') return;
    const number = releases.length;
    await new Promise(resolve => releases.push(resolve));
    if (number === 0) throw new Error('first end failed');
  };
  const first = f.request('/api/sessions/a/end', 'POST'); await until(() => releases.length === 1);
  const second = f.request('/api/sessions/a/end', 'POST'); await until(() => releases.length === 2);
  releases[0](); assert.equal((await first).status, 500);
  assert.equal((await f.request('/api/transcribe', 'POST', {
    'x-dictation-id': id(2), 'x-dictation-epoch': epoch, 'x-dictation-task': 'a' })).status, 410);
  assert.equal(f.processing.length, 0);
  releases[1](); assert.equal((await second).status, 200);
});

test('real cancellation waits for the direct child to exit before the next transcription starts', async t => {
  const { execFile } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-direct-cancel-'));
  const children = [], closed = new Set();
  t.after(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); fs.rmSync(root, {recursive:true,force:true}); });
  let overlapped = false;
  const voice = createTranscriber({execFile(...args) {
    if (children.length && !closed.has(children[0])) overlapped = true;
    const child = execFile(...args); children.push(child); child.once('close', () => closed.add(child)); return child;
  }});
  const marker = path.join(root, 'started');
  const slow = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready');setTimeout(()=>console.log('late'),10000);`;
  const audio = text => Object.assign(Readable.from([text]), {headers:{'content-type':'audio/webm'}});
  const controller = new AbortController();
  const first = voice.fromRequest(audio('first'), {dir:root,command:[process.execPath,'-e',slow],maxBytes:100,signal:controller.signal});
  const outcome = first.then(() => 'unexpected success', () => 'cancelled');
  await until(() => fs.existsSync(marker));
  const second = voice.fromRequest(audio('second'), {dir:root,command:[process.execPath,'-e',"console.log(require('node:fs').readFileSync(process.argv[1],'utf8'))"],maxBytes:100});
  controller.abort();
  assert.equal(await outcome, 'cancelled');
  assert.equal(await second, 'second');
  assert.equal(overlapped, false, 'queue must wait for close, not merely an AbortError callback');
  assert.equal(children[0].signalCode, 'SIGKILL');
  assert.deepEqual(fs.readdirSync(path.join(root,'.voice')), []);
});

test('uploads already disconnected before admission release every slot without processing', async t => {
  const { IncomingMessage } = require('node:http');
  const { Socket } = require('node:net');
  const f = fixture(t);
  const accepted = [];
  for (let n = 1; n <= LIMITS.jobs; n++) {
    const request = new IncomingMessage(new Socket());
    request.headers = { 'content-type': 'audio/webm' };
    request.destroy(); await tick();
    f.jobs.submit(id(n), f.jobs.epoch, 'a', request, f.options);
    accepted.push(f.jobs.accepted(id(n)));
  }
  let done = false; Promise.all(accepted).then(() => { done = true; });
  await until(() => done);
  assert.equal(f.processes.length, 0); assert.deepEqual(f.files(), []);
  f.submit(10, 'new recording'); await f.jobs.accepted(id(10));
  await until(() => f.processes.length === 1);
  f.processes[0].finish(); await until(() => f.files().length === 0);
});

test('a captured task lookup cannot admit new dictation after successful End', async t => {
  const f = httpFixture(t);
  const epoch = (await f.request('/api/state')).body.dictationEpoch;
  let release, held = false;
  f.machine.after = async args => {
    if (args[0] === 'list-panes' && !held) {
      held = true; await new Promise(resolve => { release = resolve; });
    }
  };
  const uploading = f.request('/api/transcribe', 'POST', {
    'x-dictation-id': id(21), 'x-dictation-epoch': epoch, 'x-dictation-task': 'a' });
  await until(() => release);
  assert.equal((await f.request('/api/sessions/a/end', 'POST')).status, 200);
  release();
  assert.equal((await uploading).status, 410);
  assert.equal(f.processing.length, 0, 'a stale lookup must never start the model');
});

test('admission begun during End cannot outlive its in-flight ending guard', async t => {
  const f = httpFixture(t);
  const epoch = (await f.request('/api/state')).body.dictationEpoch;
  let finishEnd;
  f.machine.before = async args => {
    if (args[0] === 'kill-session') await new Promise(resolve => { finishEnd = resolve; });
  };
  const ending = f.request('/api/sessions/a/end', 'POST');
  await until(() => finishEnd);
  let finishLookup, held = false;
  f.machine.after = async args => {
    if (args[0] === 'list-panes' && !held) {
      held = true; await new Promise(resolve => { finishLookup = resolve; });
    }
  };
  const uploading = f.request('/api/transcribe', 'POST', {
    'x-dictation-id': id(22), 'x-dictation-epoch': epoch, 'x-dictation-task': 'a' });
  await until(() => finishLookup);
  finishEnd(); assert.equal((await ending).status, 200);
  finishLookup(); assert.equal((await uploading).status, 410);
  assert.equal(f.processing.length, 0, 'admissions created while ending must remain invalidated');
});
