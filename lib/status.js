'use strict';
// Infers what each session is doing from its screen, without touching agent settings.
const crypto = require('crypto');

// Text the agent CLIs show when they are blocked on the owner. Checked against the last lines only.
const NEEDS_YOU = [
  /Do you want to (proceed|make this edit|create|run|allow)/i,
  /\bAllow\b.*\?\s*$/im,
  /\bApprove\b.*\?/i,
  /\(y\/n\)|\[y\/N\]|\[Y\/n\]/,
  /Press Enter to (confirm|continue)/i,
  /❯\s*1\.\s*Yes/,
  /Waiting for (your )?(approval|confirmation)/i,
  /Enter to confirm/i,
  /\besc to cancel\b/i,
  /Do you trust|Yes, I trust this folder/i,
  /Trust this folder\?|Trust and continue/i,
];

const WORKING_WINDOW_MS = 4000;   // screen changed this recently → working
const FINISH_QUIET_MS = 20000;    // quiet this long after real work → "done, your turn"
const MIN_WORK_MS = 10000;        // work shorter than this doesn't earn a "done" alert

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex');

// Pure: (previous tracker, screen text, now, dead) → { tracker, status, event }
// event is 'needs-you' | 'done' | null and marks a transition worth alerting on.
function classify(prev, screen, now, dead) {
  const t = prev ? { ...prev } : { hash: null, lastChange: now - WORKING_WINDOW_MS, workStart: null, status: 'idle' };
  const h = hash(screen);
  if (h !== t.hash) {
    const first = t.hash === null;
    t.hash = h;
    if (!first) t.lastChange = now;
    if (t.workStart === null && prev) t.workStart = now;
  }
  const tail = screen.split('\n').filter((l) => l.trim()).slice(-15).join('\n');
  let status;
  if (dead) status = 'exited';
  else if (NEEDS_YOU.some((re) => re.test(tail))) status = 'needs-you';
  else if (now - t.lastChange < WORKING_WINDOW_MS) status = 'working';
  else status = 'idle';

  let event = null;
  if (status === 'needs-you' && t.status !== 'needs-you') event = 'needs-you';
  if (status === 'idle' && t.workStart !== null && now - t.lastChange >= FINISH_QUIET_MS) {
    if (t.lastChange - t.workStart >= MIN_WORK_MS) event = 'done';
    t.workStart = null;
  }
  if (status === 'needs-you' || status === 'exited') t.workStart = null;
  t.status = status;
  return { tracker: t, status, event };
}

module.exports = { classify, NEEDS_YOU, WORKING_WINDOW_MS, FINISH_QUIET_MS, MIN_WORK_MS };
