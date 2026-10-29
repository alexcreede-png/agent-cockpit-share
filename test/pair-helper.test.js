'use strict';
// Execute only a copied launcher and synthetic pair CLI; never load the real pairing store.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const HELPER = 'Pair-a-phone.command';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-helper-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'Cockpit checkout with spaces');
  const home = path.join(root, 'Fake home');
  const elsewhere = path.join(root, 'Unrelated working folder');
  for (const dir of [path.join(checkout, 'scripts'), path.join(home, '.local/bin'), elsewhere]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.copyFileSync(path.join(REPO, HELPER), path.join(checkout, HELPER));
  const calls = path.join(root, 'pair-calls.jsonl');
  const nodeCalls = path.join(root, 'node-calls.jsonl');
  const state = path.join(root, 'pairing-state');
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'untouched'), 'synthetic state must stay unchanged');
  fs.writeFileSync(path.join(checkout, 'scripts/pair.js'), `
    const fs = require('node:fs');
    fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify({
      cwd: process.cwd(), args: process.argv.slice(1), state: process.env.COCKPIT_STATE_DIR
    }) + '\\n');
    if (process.env.FIXTURE_FAIL) { console.error('Synthetic configuration error'); process.exit(7); }
    console.log('Pair code: ABCD-EFGH');
    console.log('Open the cockpit on your phone and enter it before 12:34:56 PM. It works once.');
  `);
  // A fake existing Node installation, found even with Finder's minimal PATH.
  fs.writeFileSync(path.join(home, '.local/bin/node'), `#!/bin/bash
printf '%s\\n' "$*" >> "$FIXTURE_NODE_CALLS"
exec "$FIXTURE_RUNTIME" "$@"
`, { mode: 0o755 });
  const env = {
    PATH: '/usr/bin:/bin', HOME: home,
    FIXTURE_RUNTIME: process.execPath, FIXTURE_CALLS: calls, FIXTURE_NODE_CALLS: nodeCalls,
    COCKPIT_STATE_DIR: state,
  };
  return { root, checkout, home, elsewhere, calls, nodeCalls, state, env };
}

function start(t, f, extraEnv = {}) {
  const child = spawn(path.join(f.checkout, HELPER), [], {
    cwd: f.elsewhere, env: { ...f.env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '';
  child.stdout.on('data', b => { output += b; });
  child.stderr.on('data', b => { output += b; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, output }));
  });
  async function until(text) {
    if (output.includes(text)) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Missing output: ${text}\n${output}`)), 5000);
      function finish(error) {
        clearTimeout(timer);
        child.stdout.off('data', check);
        child.off('close', closed);
        if (error) reject(error); else resolve();
      }
      function check() { if (output.includes(text)) finish(); }
      function closed() { finish(new Error(`Exited before: ${text}\n${output}`)); }
      child.stdout.on('data', check);
      child.once('close', closed);
    });
  }
  return { child, done, until };
}

function assertNoPairing(f) {
  assert.equal(fs.existsSync(f.calls), false);
  assert.equal(fs.existsSync(f.nodeCalls), false);
  assert.deepEqual(fs.readdirSync(f.state), ['untouched']);
  assert.equal(fs.readFileSync(path.join(f.state, 'untouched'), 'utf8'), 'synthetic state must stay unchanged');
}

test('Finder helper waits for confirmation, calls its own CLI once, and keeps code/expiry readable', async t => {
  const f = fixture(t);
  assert.equal(fs.statSync(path.join(f.checkout, HELPER)).mode & 0o111, 0o111);
  const run = start(t, f);
  await run.until('to stop: ');
  assertNoPairing(f);
  assert.equal(run.child.exitCode, null);
  run.child.stdin.write('\n');
  await run.until('Press Return to finish');
  assert.equal(run.child.exitCode, null, 'result waits for acknowledgement');
  assert.deepEqual(fs.readFileSync(f.calls, 'utf8').trim().split('\n').map(JSON.parse), [{
    cwd: f.checkout, args: [path.join(f.checkout, 'scripts/pair.js')], state: f.state,
  }]);
  assert.deepEqual(fs.readFileSync(f.nodeCalls, 'utf8').trim().split('\n'), [path.join(f.checkout, 'scripts/pair.js')]);
  run.child.stdin.end('\n');
  const result = await run.done;
  assert.equal(result.code, 0);
  assert.match(result.output, /Pair code: ABCD-EFGH/);
  assert.match(result.output, /before 12:34:56 PM\. It works once\./);
  assert.match(result.output, /replaces any unused code/);
  assert.match(result.output, /Pairing code/);
});

for (const input of ['cancel\n\n', 'no\n\n', '']) {
  test(`cancellation or closed input leaves pairing untouched (${JSON.stringify(input)})`, async t => {
    const f = fixture(t);
    const run = start(t, f);
    run.child.stdin.end(input);
    const result = await run.done;
    assert.equal(result.code, 0);
    assert.match(result.output, /Cancelled\. No pairing state changed\. Reopen this file/);
    assertNoPairing(f);
  });
}

test('missing runtime resolver explains next steps and never calls the pair CLI', async t => {
  const f = fixture(t);
  // Bash's startup fixture substitutes only command lookup, independent of host Node installs.
  const resolver = path.join(f.root, 'missing-runtime-resolver.sh');
  fs.writeFileSync(resolver, `command() {
    if [ "$1" = '-v' ] && [ "$2" = 'node' ]; then return 1; fi
    builtin command "$@"
  }\n`);
  const run = start(t, f, { BASH_ENV: resolver });
  run.child.stdin.end('\n\n');
  const result = await run.done;
  assert.equal(result.code, 1);
  assert.match(result.output, /Node\.js could not be found\. No pairing state changed/);
  assert.match(result.output, /Node\.js 22 or newer/);
  assert.match(result.output, /open Terminal in this Agent Cockpit folder/);
  assert.match(result.output, /npm run pair/);
  assertNoPairing(f);
});

test('pair CLI failure is shown once, preserves exit status, and waits for acknowledgement', async t => {
  const f = fixture(t);
  const run = start(t, f, { FIXTURE_FAIL: '1' });
  run.child.stdin.write('\n');
  await run.until('Press Return to finish');
  assert.equal(run.child.exitCode, null);
  run.child.stdin.end('\n');
  const result = await run.done;
  assert.equal(result.code, 7);
  assert.match(result.output, /Synthetic configuration error/);
  assert.match(result.output, /Could not create a pairing code/);
  assert.match(result.output, /npm run pair/);
  assert.equal(fs.readFileSync(f.calls, 'utf8').trim().split('\n').length, 1);
  assert.doesNotMatch(result.output, /Pair code:/);
});

test('distributed helper is executable and private allowlist export preserves it', t => {
  assert.equal(fs.statSync(path.join(REPO, HELPER)).mode & 0o777, 0o755);
  const exportScript = path.join(REPO, 'scripts/export-share.sh');
  // The sanitized distribution intentionally excludes the private exporter.
  // Its actual helper execution is covered above; private checkout also checks export.
  if (!fs.existsSync(exportScript)) return;
  const f = fixture(t);
  const source = fs.readFileSync(exportScript, 'utf8');
  const files = source.match(/FILES=\(([\s\S]*?)\)/)[1].trim().split(/\s+/);
  // Run the real exporter on a synthetic source tree: no real config or private checkout export.
  for (const file of files) {
    const target = path.join(f.checkout, file);
    if (fs.existsSync(target)) continue;
    if (['lib', 'public', 'test'].includes(file)) fs.mkdirSync(target);
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '');
    }
  }
  const exporter = path.join(f.checkout, 'scripts/export-share.sh');
  fs.writeFileSync(exporter, source);
  fs.writeFileSync(path.join(f.checkout, 'cockpit.config.json'), JSON.stringify({
    user: 'synthetic-private-login@example.invalid', publicHost: 'synthetic-private-host.private-tail.invalid',
  }));
  const dest = path.join(f.root, 'Public export with spaces');
  const result = spawnSync('/bin/bash', [exporter, dest], {
    cwd: f.elsewhere, env: { ...f.env, PATH: `${path.join(f.home, '.local/bin')}:${process.env.PATH}` },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /export-share: clean copy/);
  const exported = path.join(dest, HELPER);
  assert.ok(fs.existsSync(exported), `Export contents: ${fs.readdirSync(dest).join(', ')}\n${result.stdout}${result.stderr}`);
  assert.equal(fs.readFileSync(exported, 'utf8'), fs.readFileSync(path.join(REPO, HELPER), 'utf8'));
  assert.equal(fs.statSync(exported).mode & 0o777, 0o755);
  assert.equal(fs.existsSync(path.join(dest, 'cockpit.config.json')), false);
  assert.equal(fs.existsSync(f.calls), false, 'export never runs the pair CLI');
});
