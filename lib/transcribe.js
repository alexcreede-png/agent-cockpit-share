'use strict';
// Voice notes use the configured local command; audio is a private temporary file
// only for upload/queued processing, removed before the processing promise settles.
const fs = require('fs');
const uploads = require('./uploads');
const EXT = { 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac', 'audio/webm': '.webm',
  'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/mpeg': '.mp3' };
const extFor = (type) => EXT[String(type || '').split(';')[0].trim().toLowerCase()] || '.m4a';

function createTranscriber({ execFile = require('child_process').execFile } = {}) {
  let queue = Promise.resolve(); // one model process at a time
  function transcribe(audioFile, command, timeoutMs = 180000, signal) {
    const [cmd, ...args] = command;
    let started = false;
    const run = () => new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('dictation cancelled'));
      started = true;
      let child, settled = false;
      const abort = () => { if (!settled) child?.kill('SIGKILL'); };
      // execFile's AbortSignal can invoke its callback before the child closes and
      // uses spawn's default signal. Kill our direct child explicitly, then let the
      // ordinary close callback settle the serial queue and release its audio.
      child = execFile(cmd, [...args, audioFile], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
        settled = true; signal?.removeEventListener('abort', abort);
        if (err) return reject(new Error((String(stderr).trim().split('\n').pop() || err.message).slice(0, 300)));
        if (signal?.aborted) return reject(new Error('dictation cancelled'));
        resolve(String(stdout).trim());
      });
      if (signal && !settled) {
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }
    });
    const p = queue.then(run, run); queue = p.then(() => undefined, () => undefined);
    // A cancelled queued job releases its own audio promptly, without breaking the
    // serialization chain or starting a second model alongside the active one.
    if (!signal) return p;
    return new Promise((resolve, reject) => {
      const abort = () => { if (!started) reject(new Error('dictation cancelled')); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      p.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  async function fromRequest(req, { dir, command, maxBytes, signal, onAccepted }) {
    let file, uploading = true;
    const abort = () => { if (uploading) req.destroy(new Error('dictation cancelled')); };
    try {
      if (signal?.aborted) throw new Error('dictation cancelled');
      signal?.addEventListener('abort', abort, { once: true });
      const saved = await uploads.save(req, { dir, session: '.voice',
        filename: `recording${extFor(req.headers['content-type'])}`, maxBytes });
      file = saved.path; uploading = false; onAccepted?.();
      return await transcribe(file, command, 180000, signal);
    } catch (err) {
      if (err.status === 413) err.message = 'recording too long';
      throw err;
    } finally {
      uploading = false; signal?.removeEventListener('abort', abort);
      if (file) await fs.promises.rm(file, { force: true });
    }
  }
  return { transcribe, fromRequest };
}
module.exports = { ...createTranscriber(), createTranscriber, extFor };
