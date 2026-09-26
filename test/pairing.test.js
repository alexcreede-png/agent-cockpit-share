'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pairing = require('../lib/pairing');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-pair-')));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const fresh = () => pairing.store(path.join(ROOT, `s${n++}`));

test('state dir is owner-only and files are 0600', () => {
  const dir = path.join(ROOT, 'perm');
  const s = pairing.store(dir);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const { code } = s.newCode();
  assert.equal(fs.statSync(path.join(dir, 'pair-code.json')).mode & 0o777, 0o600);
  s.redeem(code, 'phone');
  assert.equal(fs.statSync(path.join(dir, 'devices.json')).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(path.join(dir, 'devices.json'), 'utf8').includes(code));
});
test('refuses a state dir others can reach', () => {
  const dir = path.join(ROOT, 'open');
  fs.mkdirSync(dir); fs.chmodSync(dir, 0o755);
  assert.throws(() => pairing.store(dir), /accessible to others/);
});
test('a code pairs once and the token then passes', () => {
  const s = fresh();
  const { code } = s.newCode();
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);
  const token = s.redeem(code.slice(0, 4).toLowerCase() + '-' + code.slice(4), 'phone');
  assert.ok(token && token.length >= 40);
  assert.ok(s.check(token));
  assert.equal(s.redeem(code), null, 'code is single-use');
  assert.ok(!s.check('x'.repeat(43)));
  assert.ok(!s.check(undefined));
});
test('expired code is refused', () => {
  const s = fresh();
  const { code } = s.newCode(0);
  assert.equal(s.redeem(code, '', pairing.CODE_TTL_MS + 1), null);
});
test('five wrong guesses burn the code', () => {
  const s = fresh();
  const { code } = s.newCode();
  for (let i = 0; i < pairing.CODE_TRIES; i++) assert.equal(s.redeem('WRONGGGG'), null);
  assert.equal(s.redeem(code), null);
});
test('no pending code means nothing redeems', () => assert.equal(fresh().redeem('ABCDEFGH'), null));
test('revoke removes a device; all removes every device', () => {
  const s = fresh();
  const a = s.redeem(s.newCode().code, 'a');
  const b = s.redeem(s.newCode().code, 'b');
  const [first] = s.list();
  assert.equal(s.revoke(first.id), 1);
  assert.ok(!s.check(a) && s.check(b));
  assert.equal(s.revoke('all'), 1);
  assert.ok(!s.check(b));
});
test('cookie parsing and flags', () => {
  assert.equal(pairing.readCookie({ headers: { cookie: 'x=1; cockpit_device=abc_DEF-123; y=2' } }), 'abc_DEF-123');
  assert.equal(pairing.readCookie({ headers: {} }), null);
  const c = pairing.cookieHeader('tok', true);
  for (const f of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/']) assert.ok(c.includes(f), f);
  assert.ok(!pairing.cookieHeader('tok', false).includes('Secure'));
});
