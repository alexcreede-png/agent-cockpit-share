'use strict';
// Synthetic Gemini bridge lifecycle check on a unique tmux server. No provider runs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-agy-hangup-')));
const socket = 'cockpit-agy-hangup-' + process.pid;
const tmux = cp.execFileSync('/bin/zsh', ['-lc', 'command -v tmux'], { encoding: 'utf8' }).trim();
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
const run = args => cp.execFileSync(tmux, ['-L', socket, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
let wrapper, child;
fs.writeFileSync(path.join(root, 'agy'), `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(path.join(root, 'child.json'))}, JSON.stringify({pid:process.pid}));
fs.writeSync(3, 'I1027 01:02:03.123456 123 server.go:1225] Created conversation 11111111-1111-4111-8111-111111111111 (backend=BACKEND_TYPE_UNSPECIFIED)\\n');
process.stdout.write('SYNTHETIC_READY'); process.stdin.resume();
`, { mode: 0o700 });
(async () => {
  try {
    // Set PATH inside the command because a login shell may replace inherited PATH.
    run(['-f', '/dev/null', 'new-session', '-d', '-s', 'owned', '-c', root,
      '-e', 'COCKPIT_SESSION=agy-test', '-e', 'COCKPIT_READER_TOKEN=' + 'a'.repeat(64),
      '-e', 'COCKPIT_READER_BINDING=' + path.join(root, 'binding.json'),
      'exec /usr/bin/env ' + quote('PATH=' + root) + ' ' + quote(process.execPath) + ' ' + quote(path.resolve(__dirname, 'agy.js'))]);
    wrapper = Number(run(['display-message', '-p', '-t', '=owned:', '#{pane_pid}']));
    for (let n = 0; n < 100 && !fs.existsSync(path.join(root, 'binding.json')); n++) await wait(50);
    assert.ok(fs.existsSync(path.join(root, 'binding.json')), 'synthetic child creates identity');
    child = JSON.parse(fs.readFileSync(path.join(root, 'child.json'))).pid;
    assert.match(run(['capture-pane', '-p', '-t', '=owned:']), /SYNTHETIC_READY/);
    assert.equal(await require('../lib/agy-reader').ownsProcess({ wrapperPid: wrapper, childPid: child }), true, 'live reader marker and child ownership');
    run(['kill-session', '-t', '=owned']);
    for (let n = 0; n < 100 && (alive(wrapper) || alive(child)); n++) await wait(50);
    assert.equal(alive(wrapper), false, 'bridge exits after terminal hangup');
    assert.equal(alive(child), false, 'owned child exits and is reaped');
    console.log('PASS synthetic Gemini identity → terminal hangup → wrapper and child reaped');
  } finally {
    try { run(['kill-server']); } catch {}
    // Only PIDs obtained from this isolated fixture are eligible for failed-test cleanup.
    for (const pid of [child, wrapper]) if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    console.log('Owned fixture artifacts:', root);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
