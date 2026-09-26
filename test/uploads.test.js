'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
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
  assert.match(path.basename(r.path), /^\d{8}-\d{6}-a\.txt$/);
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
