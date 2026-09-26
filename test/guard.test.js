'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const g = require('../lib/guard');
const { load } = require('../lib/config');

const PUB = 'my-mac.example-tailnet.ts.net:8444';
const USER = 'owner@example.com';
const cfg = { hosts: [PUB, '127.0.0.1:8826'], localHosts: ['127.0.0.1:8826'], user: USER, allowLocal: false };
const req = (h, method = 'GET') => ({ method, headers: h });
const me = { host: PUB, 'tailscale-user-login': USER };

// A throwaway projects tree: two projects, one fenced off, one nested git checkout.
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-test-')));
for (const d of ['projects/app', 'projects/app/repo/.git', 'projects/Secret/x', 'outside']) fs.mkdirSync(path.join(ROOT, d), { recursive: true });
const paths = { projectsRoot: path.join(ROOT, 'projects'), forbiddenPaths: [path.join(ROOT, 'projects/Secret')] };
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('tailnet GET from the owner is allowed', () => assert.equal(g.checkRequest(req(me), cfg), null));
test('unknown Host is refused (DNS rebinding)', () => assert.equal(g.checkRequest(req({ ...me, host: 'evil.com' }), cfg), 'host'));
test('missing identity is refused', () => assert.equal(g.checkRequest(req({ host: PUB }), cfg), 'identity'));
test('other tailnet user is refused', () => assert.equal(g.checkRequest(req({ ...me, 'tailscale-user-login': 'x@y.z' }), cfg), 'identity'));
test('POST needs same origin', () => {
  assert.equal(g.checkRequest(req(me, 'POST'), cfg), 'origin');
  assert.equal(g.checkRequest(req({ ...me, origin: 'https://evil.com' }, 'POST'), cfg), 'origin');
  assert.equal(g.checkRequest(req({ ...me, origin: 'https://' + PUB }, 'POST'), cfg), null);
});
test('cross-site websocket is refused', () => {
  const h = { ...me, upgrade: 'websocket', origin: 'https://my-mac.example-tailnet.ts.net:8443' };
  assert.equal(g.checkRequest(req(h), cfg), 'origin');
});
test('loopback refused unless enabled', () => {
  assert.equal(g.checkRequest(req({ host: '127.0.0.1:8826' }), cfg), 'local-disabled');
  assert.equal(g.checkRequest(req({ host: '127.0.0.1:8826' }), { ...cfg, allowLocal: true }), null);
});

test('forbidden paths are refused, case-insensitively', () => {
  assert.ok(g.isForbiddenPath(path.join(ROOT, 'projects/Secret/x'), paths));
  assert.ok(g.isForbiddenPath(path.join(ROOT, 'projects/secret'), paths));
  assert.ok(!g.isForbiddenPath(path.join(ROOT, 'projects/SecretSauce'), paths));
  assert.ok(!g.isForbiddenPath(path.join(ROOT, 'projects/app'), paths));
});
test('resolveProject confines to projects root', () => {
  assert.equal(g.resolveProject('/etc', paths), null);
  assert.equal(g.resolveProject(path.join(ROOT, 'projects/../outside'), paths), null);
  assert.equal(g.resolveProject(path.join(ROOT, 'projects/Secret/x'), paths), null);
  assert.equal(g.resolveProject('relative', paths), null);
  assert.equal(g.resolveProject(path.join(ROOT, 'projects/app'), paths), path.join(ROOT, 'projects/app'));
});
test('listProjects skips forbidden dirs and finds nested checkouts', () => {
  const labels = g.listProjects(paths).map((p) => p.label).sort();
  assert.deepEqual(labels, ['app', 'app/repo']);
});
test('config requires a user and a public host', () => {
  const f = path.join(ROOT, 'c.json');
  fs.writeFileSync(f, '{}');
  assert.throws(() => load(f, {}), /user/);
  fs.writeFileSync(f, JSON.stringify({ user: USER }));
  assert.throws(() => load(f, {}), /publicHost/);
  assert.equal(load(f, { COCKPIT_ALLOW_LOCAL: '1' }).publicHost, '');
  fs.writeFileSync(f, JSON.stringify({ user: USER, publicHost: PUB, notifyCommand: ['echo'] }));
  const c = load(f, {});
  assert.equal(c.notify, false);
  assert.deepEqual(c.notifyCommand, ['echo']);
  assert.equal(load(f, { COCKPIT_NOTIFY: '1' }).notify, true);
  fs.writeFileSync(f, JSON.stringify({ user: USER, publicHost: PUB, socketPath: '/s/c.sock' }));
  assert.equal(load(f, {}).socketPath, '/s/c.sock');
  assert.equal(load(f, { COCKPIT_SOCKET: '' }).socketPath, '');
});
test('session names are validated', () => {
  assert.ok(g.validSessionName('claude-agent-cockpit-1a2b'));
  for (const bad of ['', '-x', 'a;rm', 'A', '../x', 'x'.repeat(80)]) assert.ok(!g.validSessionName(bad), bad);
});
