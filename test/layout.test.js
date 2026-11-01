'use strict';
// Phone typing layout: the keyboard leaves a short frame, so guidance and
// secondary task details must step aside while the message box has focus.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('short focused frame hides guidance and secondary task details only', () => {
  const block = css.match(/@media \(max-height: 520px\) \{([\s\S]*?)\n\}/);
  assert.ok(block, 'typing layout rule exists');
  for (const id of ['#startup-note', '#reader-tools', '#t-context', '#output-source']) {
    assert.ok(block[1].includes(`#term-view:has(#input:focus) ${id}`), `${id} steps aside while typing`);
  }
  for (const kept of ['#t-name', '#t-status', '#mode-btn', '#kill-btn', '#keys-toggle', '#send-btn']) {
    const hides = block[1].split('\n').some(line => line.includes(kept) && /display:\s*none/.test(line));
    assert.ok(!hides, `${kept} stays visible while typing`);
  }
});

test('Controls stays in the message row so response keys remain reachable', () => {
  const row = html.match(/<form id="input-row"[\s\S]*?<\/form>/)[0];
  assert.ok(row.includes('id="keys-toggle"'));
});

test('very short focused frame (landscape keyboard) also steps the task bar aside', () => {
  const block = css.match(/@media \(max-height: 300px\) \{([\s\S]*?)\n\}/);
  assert.ok(block, 'landscape typing rule exists');
  assert.ok(block[1].includes('#term-view:has(#input:focus) > .bar { display: none; }'));
});

test('the mic icon stays centred when it has no recording label', () => {
  assert.ok(css.includes('#mic-label:empty { display: none; }'));
});
