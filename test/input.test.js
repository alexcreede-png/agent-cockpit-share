'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function harness(failPaste = false) {
  const calls = [], timers = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/tmux.js'), 'utf8'), {
    module, __dirname: path.join(__dirname, '../lib'),
    setTimeout(fn, ms) { timers.push(ms); queueMicrotask(fn); },
    require(id) {
      if (id !== 'child_process') return require(id);
      return { execFile(bin, args, opts, cb) {
        calls.push(args.slice(4));
        const command = args[4];
        queueMicrotask(() => cb(failPaste && command === 'paste-buffer' ? new Error('paste failed') : null,
          command === 'capture-pane' ? 'stable prompt' : '', ''));
      } };
    },
  });
  return { api: module.exports, calls, timers };
}

test('single-line message waits for paste processing before exactly one Enter', async () => {
  const h = harness();
  await h.api.sendText('shell-demo', 'hello');
  assert.deepEqual(h.calls.map(c => c[0]), ['set-buffer', 'paste-buffer', 'capture-pane', 'capture-pane', 'capture-pane', 'send-keys']);
  assert.equal(h.timers.reduce((a,b) => a+b, 0), 600);
  assert.equal(h.calls.at(-1).at(-1), 'Enter');
});
test('concurrent messages and quick keys stay in input order', async () => {
  const h = harness();
  await Promise.all([h.api.sendText('shell-demo', 'first\nsecond'), h.api.sendText('shell-demo', 'third'), h.api.sendKey('shell-demo', 'Escape')]);
  const inputs = h.calls.filter(c => ['set-buffer','send-keys'].includes(c[0])).map(c => c.at(-1));
  assert.deepEqual(inputs, ['first\nsecond', 'Enter', 'third', 'Enter', 'Escape']);
});
test('empty messages and failed pastes never send Enter', async () => {
  const h = harness(true);
  await assert.rejects(h.api.sendText('shell-demo', ' '), /empty/);
  await assert.rejects(h.api.sendText('shell-demo', 'hello'), /paste failed/);
  assert.equal(h.calls.some(c => c[0] === 'send-keys'), false);
});
