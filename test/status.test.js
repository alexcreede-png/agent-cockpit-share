'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { classify } = require('../lib/status');

test('first sight of a static screen is idle, not work', () => {
  const r = classify(null, 'hello', 0, false);
  assert.equal(r.event, null);
  const r2 = classify(r.tracker, 'hello', 30000, false);
  assert.equal(r2.status, 'idle');
  assert.equal(r2.event, null);
});

test('long work then quiet fires one done event', () => {
  let r = classify(null, 's0', 0, false);
  for (let t = 2000; t <= 30000; t += 2000) r = classify(r.tracker, 's' + t, t, false);
  assert.equal(r.status, 'working');
  r = classify(r.tracker, 's30000', 40000, false);
  assert.equal(r.event, null);
  r = classify(r.tracker, 's30000', 51000, false);
  assert.equal(r.event, 'done');
  r = classify(r.tracker, 's30000', 60000, false);
  assert.equal(r.event, null);
});

test('brief change (e.g. echo of typing) does not fire done', () => {
  let r = classify(null, 'a', 0, false);
  r = classify(r.tracker, 'ab', 2000, false);
  r = classify(r.tracker, 'ab', 30000, false);
  assert.equal(r.event, null);
});

test('approval prompt is needs-you, fires once', () => {
  let r = classify(null, 'x', 0, false);
  const prompt = 'Edit file foo.ts\nDo you want to make this edit to foo.ts?\n❯ 1. Yes\n  2. No';
  r = classify(r.tracker, prompt, 2000, false);
  assert.equal(r.status, 'needs-you');
  assert.equal(r.event, 'needs-you');
  r = classify(r.tracker, prompt, 4000, false);
  assert.equal(r.event, null);
});

test('dead pane is exited', () => assert.equal(classify(null, 'bye', 0, true).status, 'exited'));

test('real Claude folder-trust screen is needs-you', () => {
  const screen = [' Accessing workspace:', ' /Users/you/projects/agent-cockpit',
    ' Claude Code\'ll be able to read, edit, and execute files here.', ' ❯ No, exit',
    '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel'].join('\n');
  assert.equal(classify(null, screen, 0, false).status, 'needs-you');
});

test('working spinner footer is not mistaken for a prompt', () => {
  assert.notEqual(classify(null, '✻ Thinking… (12s · esc to interrupt)', 0, false).status, 'needs-you');
});

test('first sighting reads idle immediately', () => assert.equal(classify(null, 'static', 0, false).status, 'idle'));

// Text captured from a disposable Codex folder-access screen; path omitted.
test('real Codex folder access screen asks for attention', () => {
  const screen = `Folder access
Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.
Folder settings can run code automatically, even without a model request.
› 1. Trust and continue
  2. Quit
  enter continue · esc quit`;
  const result = classify(null, screen, 0, false);
  assert.equal(result.status, 'needs-you');
});

// Text observed in fresh, owned installed-CLI panes; synthetic paths only.
test('Grok and Antigravity project trust screens request attention', () => {
  for (const screen of [
    'Do you trust the contents of this directory?\n/example/project\nGrok Build may run or modify contents in this directory,',
    'Do you trust the contents of this project?\nAntigravity CLI requires permission to read, edit, and execute files here.\n> Yes, I trust this folder',
  ]) {
    const first = classify(null, screen, 0, false);
    assert.equal(first.status, 'needs-you');
    assert.equal(classify(first.tracker, screen, 30000, false).status, 'needs-you');
  }
});
