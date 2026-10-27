'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch {}
const { messagesFromSteps, metadataFromBlob } = require('../lib/agy-messages');
const { createAgyReader } = require('../lib/agy-reader');
const { identityCollector } = require('../lib/agy-bridge');

function vi(n) { const b = []; do { b.push((n % 128) | (n >= 128 ? 128 : 0)); n = Math.floor(n / 128); } while (n); return Buffer.from(b); }
const num = (n, x) => Buffer.concat([vi(n * 8), vi(x)]);
const bytes = (n, x) => { const b = Buffer.from(x); return Buffer.concat([vi(n * 8 + 2), vi(b.length), b]); };
const proto = (...parts) => Buffer.concat(parts);
const row = (idx, type, content, format = 0) => ({ idx, step_type: type, step_format: format,
  step_payload: proto(num(1, type), num(4, 3), bytes(type === 14 ? 19 : 20, content)) });
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

test('Gemini projection preserves complete visible text and omits internal content', () => {
  const answer = 'BEGIN\n' + 'A readable line.\n'.repeat(2000) + 'END';
  const result = messagesFromSteps([
    row(0, 14, proto(bytes(2, 'Please explain'), bytes(3, bytes(1, 'Please explain')), bytes(12, 'PRIVATE CONFIG'))),
    row(1, 15, proto(bytes(1, 'original'), bytes(8, answer), bytes(3, 'PRIVATE THOUGHT'), bytes(16, 'PRIVATE RAW THOUGHT'), bytes(7, 'PRIVATE TOOL'))),
    row(2, 28, bytes(1, 'PRIVATE COMMAND')),
    row(3, 15, bytes(3, 'PRIVATE THOUGHT ONLY')),
  ]);
  assert.deepEqual(result, [{ id: 'agy-0', role: 'user', text: 'Please explain' }, { id: 'agy-1', role: 'assistant', text: answer }]);
});

test('user items and attachment indicators do not expose scope or configuration', () => {
  const result = messagesFromSteps([row(0, 14, proto(bytes(3, proto(bytes(1, 'Visible text'), bytes(2, 'PRIVATE SCOPE'))), bytes(9, 'PRIVATE MEDIA')))]);
  assert.equal(result[0].text, 'Visible text\n[Attachment]');
});

test('malformed, oversized, mismatched and future-format messages fail closed', () => {
  for (const bad of [
    [{ ...row(0, 14, bytes(2, 'text')), step_type: 15 }],
    [row(0, 15, bytes(1, 'text'), 1)],
    [row(0, 15, proto(bytes(1, 'a'), bytes(1, 'b')))],
    [row(0, 15, bytes(1, Buffer.from([0xff])))],
    [row(0, 15, bytes(1, 'x'.repeat(2 * 1024 * 1024 + 1)))],
    [{ ...row(0, 15, bytes(1, 'ok')), step_payload: Buffer.from([0x12, 0x20, 0x01]) }],
    [row(1, 15, bytes(1, 'a')), row(1, 15, bytes(1, 'b'))],
  ]) assert.throws(() => messagesFromSteps(bad));
});

test('only complete anchored new-conversation log events establish identity', () => {
  const seen = [], collect = identityCollector(v => seen.push(v));
  const line = `I1027 01:02:03.123456    123 server.go:1225] Created conversation ${ID} (backend=BACKEND_TYPE_UNSPECIFIED)\n`;
  collect('I1027 01:02:03.1 123 input_loop.go:106] HandleUserInput called with text: "' + line.trim() + '"\n');
  collect(line.slice(0, 30)); assert.equal(seen.length, 0); collect(line.slice(30));
  assert.deepEqual(seen, [{ id: ID, ambiguous: false }]);
  collect(line); assert.equal(seen.length, 1);
  collect('x'.repeat(20000) + line); assert.equal(seen.length, 1);
  collect(line.replace(ID, OTHER)); assert.deepEqual(seen[1], { id: OTHER, ambiguous: true });
});

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-agy-reader-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), stateDir = path.join(root, 'state'), agyHome = path.join(root, 'agy');
  for (const dir of [project, path.join(stateDir, 'agy-bindings'), path.join(agyHome, 'conversations')]) fs.mkdirSync(dir, { recursive: true });
  const now = Date.now(), token = 'a'.repeat(64), name = 'agy-owned-test';
  const binding = { version: 1, session: name, token, wrapperPid: 111, childPid: 222, started: now, observed: now + 1, project, id: ID, ambiguous: false };
  const recordFile = path.join(stateDir, 'agy-bindings', name + '.json');
  const dbFile = path.join(agyHome, 'conversations', ID + '.db');
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE trajectory_meta(cascade_id TEXT); CREATE TABLE trajectory_metadata_blob(id TEXT, data BLOB); CREATE TABLE steps(idx INTEGER, step_type INTEGER, step_format INTEGER, step_payload BLOB)');
  db.prepare('INSERT INTO trajectory_meta VALUES (?)').run(ID);
  const metadata = proto(bytes(1, bytes(1, pathToFileURL(project).href)), bytes(2, num(1, Math.floor(now / 1000))), bytes(6, ID));
  db.prepare('INSERT INTO trajectory_metadata_blob VALUES (?,?)').run('main', metadata);
  const message = row(0, 15, bytes(1, 'Owned complete answer'));
  db.prepare('INSERT INTO steps VALUES (?,?,?,?)').run(message.idx, message.step_type, message.step_format, message.step_payload); db.close();
  const save = () => fs.writeFileSync(recordFile, JSON.stringify(binding)); save();
  let processValid = true;
  const options = { stateDir, agyHome, readerIdentity: async () => ({ pid: 111, token }), verifyProcess: async () => processValid };
  const session = { name, lane: 'agy', project, created: now, dead: false };
  return { root, project, binding, save, dbFile, recordFile, options, session, metadata, setProcess: x => { processValid = x; } };
}

test('owned database projects complete messages and survives reader reconstruction', { skip: !DatabaseSync }, async t => {
  const f = fixture(t);
  assert.equal(metadataFromBlob(f.metadata).rootId, ID);
  for (let i = 0; i < 2; i++) assert.deepEqual(await createAgyReader(f.options)(f.session), {
    source: 'conversation', messages: [{ id: 'agy-0', role: 'assistant', text: 'Owned complete answer' }],
  });
});

test('an empty conversation or unavailable SQLite keeps terminal setup visible', { skip: !DatabaseSync }, async t => {
  const f = fixture(t);
  const unavailable = createAgyReader({ ...f.options, Database: class { constructor() { throw new Error('Unavailable'); } } });
  assert.equal(await unavailable(f.session), null);
  const db = new DatabaseSync(f.dbFile); db.exec('DELETE FROM steps'); db.close();
  assert.equal(await createAgyReader(f.options)(f.session), null);
});

test('wrong process, token, session, old creation, ambiguity and ended pane refuse reading', { skip: !DatabaseSync }, async t => {
  const f = fixture(t), read = createAgyReader(f.options), initial = { ...f.binding };
  for (const change of [{ wrapperPid: 333 }, { childPid: -1 }, { token: 'b'.repeat(64) }, { session: 'another' },
    { started: f.session.created - 10000 }, { ambiguous: true }, { id: '../unsafe' }, { observed: f.session.created - 1 }]) {
    Object.assign(f.binding, initial, change); f.save(); assert.equal(await read(f.session), null);
  }
  Object.assign(f.binding, initial); f.save(); f.setProcess(false); assert.equal(await read(f.session), null);
  f.setProcess(true); assert.equal(await read({ ...f.session, dead: true }), null);
});

test('mismatched database identity or workspace never reads message text', { skip: !DatabaseSync }, async t => {
  const f = fixture(t), read = createAgyReader(f.options);
  const db = new DatabaseSync(f.dbFile);
  db.prepare('UPDATE trajectory_meta SET cascade_id=?').run(OTHER); assert.equal(await read(f.session), null);
  db.prepare('UPDATE trajectory_meta SET cascade_id=?').run(ID);
  const foreign = path.join(f.root, 'other-project'); fs.mkdirSync(foreign);
  db.prepare('UPDATE trajectory_metadata_blob SET data=?').run(proto(bytes(1, bytes(1, pathToFileURL(foreign).href)),
    bytes(2, num(1, Math.floor(f.binding.started / 1000))), bytes(6, ID)));
  assert.equal(await read(f.session), null); db.close();
});

test('redirected binding/database paths and malformed database fall back', { skip: !DatabaseSync }, async t => {
  const f = fixture(t), read = createAgyReader(f.options), moved = f.dbFile + '.moved';
  fs.renameSync(f.dbFile, moved); fs.symlinkSync(moved, f.dbFile); assert.equal(await read(f.session), null);
  fs.unlinkSync(f.dbFile); fs.writeFileSync(f.dbFile, 'not a sqlite database'); assert.equal(await read(f.session), null);
  fs.unlinkSync(f.dbFile); fs.renameSync(moved, f.dbFile);
  fs.renameSync(f.recordFile, f.recordFile + '.moved'); fs.symlinkSync(f.recordFile + '.moved', f.recordFile);
  assert.equal(await read(f.session), null);
});

test('ended/rebound identity during a database read is never published', { skip: !DatabaseSync }, async t => {
  const f = fixture(t); let calls = 0;
  const options = { ...f.options, readerIdentity: async () => ({ pid: 111, token: (++calls === 1 ? 'a' : 'b').repeat(64) }) };
  assert.equal(await createAgyReader(options)(f.session), null); assert.equal(calls, 2);
  calls = 0;
  assert.equal(await createAgyReader({ ...f.options, verifyProcess: async () => ++calls === 1 })(f.session), null);
  assert.equal(calls, 2);
});

test('visible terminal steps and unknown types/formats cannot silently truncate a conversation', () => {
  const answer = row(0, 15, bytes(1, 'Earlier complete answer'));
  for (const type of [17, 27, 82, 90, 132, 138, 999]) {
    assert.throws(() => messagesFromSteps([answer, row(1, type, bytes(1, 'New visible content'))]));
  }
  assert.throws(() => messagesFromSteps([answer, row(1, 28, bytes(1, 'future tool encoding'), 1)]));
  assert.throws(() => messagesFromSteps([answer, row(1, 999, bytes(1, 'future visible encoding'), 1)]));
});
