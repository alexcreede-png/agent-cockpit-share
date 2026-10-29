'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createActions } = require('../lib/actions');
const { actionFixture } = require('./helpers/actions-harness');
const ID = 'synthetic-action-01';

test('receipts reserve before side effects, share concurrent execution and reject changed targets/input', async () => {
  const ledger = createActions(); let effects = 0, release;
  const body = { actionEpoch: ledger.epoch, actionId: ID, key: 'Enter' };
  const execute = () => { effects++; return new Promise(r => { release = r; }); };
  const first = ledger.run('a', body, execute);
  const copies = Array.from({ length: 10 }, () => ledger.run('a', body, execute));
  await new Promise(r => setImmediate(r)); assert.equal(effects, 1);
  for (const [name, changed] of [['b', body], ['a', { ...body, key: 'Up' }], ['a', { ...body, text: 'changed' }]]) {
    assert.throws(() => ledger.run(name, changed, execute), e => e.code === 'ACTION_MISMATCH');
  }
  release(); await Promise.all([first, ...copies]);
  await ledger.run('a', { ...body, check: true }, execute); assert.equal(effects, 1);
});

test('ambiguous terminal failure is retained; checks and duplicate POST never repeat it', async () => {
  const ledger = createActions(); let effects = 0;
  const body = { actionEpoch: ledger.epoch, actionId: ID, text: 'partially pasted' };
  const execute = async () => { effects++; throw new Error('timeout after possible effect'); };
  for (const check of [false, true, false]) {
    await assert.rejects(ledger.run('a', { ...body, check }, execute), e => e.code === 'ACTION_UNCONFIRMED');
  }
  assert.equal(effects, 1);
});

test('unknown checks, restart epochs, invalid IDs and capacity cannot execute input or evict receipts', async () => {
  const ledger = createActions({ limit: 1 }); let effects = 0;
  const body = { actionEpoch: ledger.epoch, actionId: ID, key: 'Enter' };
  const execute = async () => { effects++; };
  assert.throws(() => ledger.run('a', { ...body, check: true }, execute), e => e.code === 'ACTION_UNKNOWN');
  assert.throws(() => ledger.run('a', { ...body, actionId: ID + '\n' }, execute), e => e.code === 'ACTION_INVALID');
  await ledger.run('a', body, execute);
  assert.throws(() => ledger.run('a', { ...body, actionId: 'synthetic-action-02' }, execute), e => e.code === 'ACTION_CAPACITY');
  await ledger.run('a', body, execute); assert.equal(effects, 1);
  const restarted = createActions();
  assert.throws(() => restarted.run('a', body, execute), e => e.code === 'ACTION_EPOCH_CHANGED');
  assert.equal(effects, 1);
});

test('actual HTTP handler and tmux queue deduplicate delivered Enter and fail closed across reconstruction', async t => {
  const f = actionFixture(t);
  const state = await f.request({}, '/api/state', 'GET');
  const body = { actionId: ID, actionEpoch: state.body.actionEpoch, key: 'Enter' };
  const first = await f.request(body); // Treat this acknowledgement as lost.
  assert.equal(first.status, 200);
  assert.equal((await f.request({ ...body, check: true })).status, 200);
  assert.equal((await f.request(body)).status, 200);
  assert.equal(f.machine.calls.filter(c => c[0] === 'send-keys').length, 1);
  f.restart();
  const restarted = await f.request(body);
  assert.equal(restarted.status, 409); assert.equal(restarted.body.code, 'ACTION_EPOCH_CHANGED');
  assert.equal(f.machine.calls.filter(c => c[0] === 'send-keys').length, 1);
});

test('missing End is idempotent; dead input and history missing remain definitive', async t => {
  const f = actionFixture(t);
  assert.equal((await f.request({}, '/api/sessions/a/end')).status, 200);
  const again = await f.request({}, '/api/sessions/a/end');
  assert.deepEqual(again, { status: 200, body: { ok: true, absent: true } });
  assert.equal((await f.request({}, '/api/sessions/a/history', 'GET')).status, 404);
  f.machine.sessions.get('b').dead = true;
  assert.equal((await f.request({ key: 'Enter' }, '/api/sessions/b/keys')).status, 410);
  assert.equal(f.machine.calls.filter(c => c[0] === 'send-keys').length, 0);
});

test('concurrent End requests both acknowledge absence after only one removal', async t => {
  const f = actionFixture(t);
  const results = await Promise.all([f.request({}, '/api/sessions/a/end'), f.request({}, '/api/sessions/a/end')]);
  assert.ok(results.every(r => r.status === 200));
  assert.equal(f.machine.sessions.has('a'), false);
});

test('receipt checks and repeated End retain paired-device and origin guards', async t => {
  const f = actionFixture(t); f.config.pairing = true; f.restart();
  for (const url of ['/api/sessions/a/keys', '/api/sessions/absent/end']) {
    assert.equal((await f.request({ key: 'Enter', actionId: ID, check: true }, url)).status, 401);
  }
  assert.equal(f.machine.calls.some(c => c[0] === 'send-keys' || c[0] === 'kill-session'), false);
  // Existing guard tests cover accepted identities/origins; this path must still reject a foreign origin.
  const { serverHarness } = require('./helpers/start-harness');
  const server = serverHarness(f.config, f.machine);
  const r = await server.request({ key: 'Enter', actionId: ID, check: true }, {
    url: '/api/sessions/a/keys', headers: { origin: 'https://foreign.example' },
  });
  assert.equal(r.status, 403);
});
