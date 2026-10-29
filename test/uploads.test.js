'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable, PassThrough } = require('stream');
const crypto = require('crypto');
const up = require('../lib/uploads');
const voice = require('../lib/transcribe');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-up-'));
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test('safeName strips directories and odd characters', () => {
  assert.equal(up.safeName('../../etc/passwd'), 'passwd');
  assert.equal(up.safeName('.hidden'), 'hidden');
  assert.equal(up.safeName('my photo (1).HEIC'), 'my_photo_1_.HEIC');
  assert.equal(up.safeName(''), 'upload');
  assert.ok(up.safeName('x'.repeat(300)).length <= 80);
});

test('save writes the file inside <dir>/<session>', async () => {
  const r = await up.save(Readable.from([Buffer.from('hello')]), { dir: DIR, session: 's1', filename: 'a.txt', maxBytes: 100 });
  assert.equal(path.dirname(r.path), path.join(DIR, 's1'));
  assert.match(path.basename(r.path), /^\d{8}-\d{6}-[a-f0-9-]{36}-a\.txt$/);
  assert.equal(fs.readFileSync(r.path, 'utf8'), 'hello');
  assert.equal(r.bytes, 5);
});

test('save rejects oversize uploads with 413 and leaves nothing behind', async () => {
  const big = Readable.from([Buffer.alloc(60), Buffer.alloc(60)]);
  await assert.rejects(up.save(big, { dir: DIR, session: 's2', filename: 'big.bin', maxBytes: 100 }), (e) => e.status === 413);
  // Cleanup is asynchronous; allow up to a second for the partial file to go.
  for (let i = 0; i < 20 && fs.readdirSync(path.join(DIR, 's2')).length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(fs.readdirSync(path.join(DIR, 's2')), []);
});

test('transcribe runs the configured command with the audio path last', async () => {
  const text = await voice.transcribe('/tmp/clip.m4a', ['/bin/echo', 'heard']);
  assert.equal(text, 'heard /tmp/clip.m4a');
});

test('transcribe surfaces command failure', async () => {
  await assert.rejects(voice.transcribe('/tmp/x', ['/usr/bin/false']));
});

test('audio types map to file extensions', () => {
  assert.equal(voice.extFor('audio/mp4'), '.m4a');
  assert.equal(voice.extFor('audio/webm;codecs=opus'), '.webm');
  assert.equal(voice.extFor(''), '.m4a');
});

function freezeClock(t) {
  const RealDate = Date;
  t.mock.method(global, 'Date', class extends RealDate {
    constructor(...args) { super(...(args.length ? args : ['2026-01-01T12:00:00.000Z'])); }
  });
  t.mock.method(Date, 'now', () => 1767268800000);
}

test('same-name uploads at the same instant preserve separate contents', async (t) => {
  freezeClock(t);
  const options = { dir: DIR, session: 'concurrent', filename: 'photo.jpg', maxBytes: 100 };
  const settled = await Promise.allSettled(['first', 'second'].map(text => up.save(Readable.from([text]), options)));
  assert.deepEqual(settled.map(r => r.status), ['fulfilled', 'fulfilled']);
  const results = settled.map(r => r.value);
  assert.notEqual(results[0].path, results[1].path);
  assert.deepEqual(results.map(r => fs.readFileSync(r.path, 'utf8')), ['first', 'second']);
});

test('exclusive-open collision never removes an existing attachment', async (t) => {
  freezeClock(t);
  t.mock.method(crypto, 'randomUUID', () => 'fixed-collision');
  const options = { dir: DIR, session: 'collision', filename: 'photo.jpg', maxBytes: 100 };
  const first = await up.save(Readable.from(['keep this']), options);
  await assert.rejects(up.save(Readable.from(['replacement']), options), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(first.path, 'utf8'), 'keep this');
});

test('concurrent recordings use their own audio and remove only their own files', async (t) => {
  freezeClock(t);
  const request = text => Object.assign(Readable.from([text]), { headers: { 'content-type': 'audio/mp4' } });
  const command = [process.execPath, '-e', "setTimeout(() => process.stdout.write(require('fs').readFileSync(process.argv[1])), 30)"];
  const settled = await Promise.allSettled(['AAAAA', 'BBBBB'].map(text => voice.fromRequest(request(text), { dir: DIR, command, maxBytes: 100 })));
  assert.deepEqual(settled.map(r => r.status), ['fulfilled', 'fulfilled']);
  const results = settled.map(r => r.value);
  assert.deepEqual(results, ['AAAAA', 'BBBBB']);
  assert.deepEqual(fs.readdirSync(path.join(DIR, '.voice')), []);
});

test('oversized recording rejects only after its partial file is cleaned up', async () => {
  const req = Object.assign(Readable.from([Buffer.alloc(101)]), { headers: { 'content-type': 'audio/mp4' } });
  await assert.rejects(voice.fromRequest(req, { dir: DIR, command: ['/usr/bin/false'], maxBytes: 100 }), e => e.status === 413);
  assert.deepEqual(fs.readdirSync(path.join(DIR, '.voice')), []);
});

test('interrupted upload rejects after removing its own partial file', async () => {
  const stream = new PassThrough();
  const pending = up.save(stream, { dir: DIR, session: 'interrupted', filename: 'partial.txt', maxBytes: 100 });
  stream.write('partial');
  stream.emit('aborted');
  await assert.rejects(pending, /upload interrupted/);
  assert.deepEqual(fs.readdirSync(path.join(DIR, 'interrupted')), []);
  stream.destroy();
});

test('failed transcription removes its recording before returning the error', async () => {
  const req = Object.assign(Readable.from(['audio']), { headers: { 'content-type': 'audio/webm' } });
  await assert.rejects(voice.fromRequest(req, { dir: DIR, command: ['/usr/bin/false'], maxBytes: 100 }));
  assert.deepEqual(fs.readdirSync(path.join(DIR, '.voice')), []);
});
