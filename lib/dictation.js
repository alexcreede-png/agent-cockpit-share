'use strict';
// Memory-only recovery. Tombstones are never evicted during a server run: once the
// identity budget is full we refuse new work, rather than accidentally rerun an old ID.
const crypto = require('crypto');
const LIMITS = Object.freeze({ jobs: 4, identities: 1024, jobMs: 12 * 60000, resultMs: 10 * 60000, textChars: 20000 });
const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
function createDictation({ process, now = Date.now, schedule = setTimeout, unschedule = clearTimeout, limits = LIMITS } = {}) {
  const epoch = crypto.randomBytes(16).toString('hex'), jobs = new Map();
  let active = 0;
  function validate(id, boot, task) {
    if (!/^[a-f0-9]{32}$/.test(id || '') || typeof task !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(task)) throw fail(400, 'invalid dictation identity');
    if (boot !== epoch) throw fail(410, 'Dictation server changed. Recovery is unavailable; discard this recording.');
    const job = jobs.get(id);
    if (job && job.task !== task) throw fail(409, 'dictation belongs to another task');
    return job;
  }
  function expire(job) {
    job.text = undefined; job.state = 'expired';
  }
  function view(job) {
    if (job.finished !== undefined && now() - job.finished >= limits.resultMs && job.state !== 'expired') expire(job);
    return { requestId: job.id, epoch, task: job.task, state: job.state,
      ...(job.state === 'complete' ? { text: job.text } : {}) };
  }
  function terminal(job, state) {
    if (job.finished !== undefined) return;
    job.state = state; job.finished = now(); job.text = undefined;
    unschedule(job.deadline);
    job.expiry = schedule(() => expire(job), limits.resultMs); job.expiry?.unref?.();
  }
  function stop(job, state) {
    terminal(job, state);
    job.controller.abort();
  }
  function status(id, boot, task) {
    const job = validate(id, boot, task);
    return job ? view(job) : { requestId: id, epoch, task, state: 'unknown' };
  }
  function submit(id, boot, task, request, options) {
    let job = validate(id, boot, task);
    if (job) { request.resume(); return view(job); }
    if (jobs.size >= limits.identities) throw fail(503, 'Dictation recovery is full. Restart Cockpit on your Mac before recording again.', 'DICTATION_CAPACITY');
    if (active >= limits.jobs) throw fail(503, 'The Mac is processing other recordings. Check again shortly.');
    job = { id, task, state: 'pending', controller: new AbortController() };
    jobs.set(id, job); active++;
    let accepted; job.ready = new Promise(resolve => { accepted = resolve; });
    job.deadline = schedule(() => stop(job, 'expired'), limits.jobMs); job.deadline?.unref?.();
    // Reserve synchronously before consuming any stream. Duplicate POSTs can only
    // observe this job, including while its original upload is still in flight.
    job.done = Promise.resolve().then(() => process(request, { ...options, signal: job.controller.signal, onAccepted: accepted }))
      .then(text => {
        if (job.finished !== undefined) return;
        if (typeof text !== 'string' || text.length > limits.textChars) { terminal(job, 'failed'); return; }
        terminal(job, 'complete'); job.text = text;
      }, err => { job.failureStatus = err?.status || 500; terminal(job, 'failed'); })
      .finally(() => { active--; accepted(); });
    return view(job);
  }
  function cancel(id, boot, task) {
    let job = validate(id, boot, task);
    if (!job) {
      if (jobs.size >= limits.identities) throw fail(503, 'Dictation recovery capacity reached');
      // A cancel arriving before its upload must still prevent that upload starting.
      job = { id, task, controller: new AbortController() }; jobs.set(id, job);
    }
    stop(job, 'cancelled'); job.text = undefined;
    if (job.state === 'complete') job.state = 'cancelled';
    return view(job);
  }
  function cancelTask(task) {
    for (const job of jobs.values()) if (job.task === task) cancel(job.id, epoch, task);
  }
  async function legacy(request, options) {
    const id = crypto.randomBytes(16).toString('hex');
    submit(id, epoch, 'legacy', request, options);
    const job = jobs.get(id); await job.done;
    if (job.state !== 'complete') throw fail(job.failureStatus || 500, 'Transcription failed');
    const text = job.text; expire(job); return text;
  }
  return { epoch, submit, status, cancel, cancelTask, legacy, accepted: id => jobs.get(id)?.ready };
}
module.exports = { createDictation, LIMITS };
