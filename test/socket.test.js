'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { prepareSocket, lockSocket } = require('../lib/socket');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-sock-')));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('creates a private directory and an owner-only socket', async () => {
  const sock = path.join(ROOT, 'run', 'c.sock');
  prepareSocket(sock);
  assert.equal(fs.statSync(path.dirname(sock)).mode & 0o777, 0o700);
  const srv = net.createServer();
  await new Promise((r) => srv.listen(sock, r));
  lockSocket(sock);
  assert.equal(fs.statSync(sock).mode & 0o777, 0o600);
  await new Promise((r) => srv.close(r));
});
test('refuses a directory others can reach', () => {
  const dir = path.join(ROOT, 'open');
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  assert.throws(() => prepareSocket(path.join(dir, 'c.sock')), /accessible to others/);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o755);
});
test('refuses to replace a non-socket file', () => {
  const dir = path.join(ROOT, 'priv');
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'c.sock'), 'x');
  assert.throws(() => prepareSocket(path.join(dir, 'c.sock')), /not a socket/);
});
test('refuses a relative path', () => assert.throws(() => prepareSocket('c.sock'), /absolute/));
