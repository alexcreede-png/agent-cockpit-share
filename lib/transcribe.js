'use strict';
// Voice notes from the phone are transcribed on this machine by `transcribeCommand` from the config
// (the audio file path is appended as the last argument; the command prints the text).
const fs = require('fs');
const { execFile } = require('child_process');
const uploads = require('./uploads');

const EXT = { 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac', 'audio/webm': '.webm',
  'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/mpeg': '.mp3' };
const extFor = (type) => EXT[String(type || '').split(';')[0].trim().toLowerCase()] || '.m4a';

let queue = Promise.resolve();   // one transcription at a time; models are memory-hungry

function transcribe(audioFile, command, timeoutMs = 180000) {
  const [cmd, ...args] = command;
  const run = () => new Promise((resolve, reject) => {
    execFile(cmd, [...args, audioFile], { timeout: timeoutMs, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((String(stderr).trim().split('\n').pop() || err.message).slice(0, 300)));
      resolve(String(stdout).trim());
    });
  });
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

// Write the request body to a temp file, transcribe it, always delete the audio.
async function fromRequest(req, { dir, command, maxBytes }) {
  let file;
  try {
    // Share the exclusive-write/owned-cleanup contract with attachments. Concurrent
    // requests must never truncate, transcribe or remove one another's recordings.
    const saved = await uploads.save(req, { dir, session: '.voice',
      filename: `recording${extFor(req.headers['content-type'])}`, maxBytes });
    file = saved.path;
    return await transcribe(file, command);
  } catch (err) {
    if (err.status === 413) err.message = 'recording too long';
    throw err;
  } finally {
    if (file) await fs.promises.rm(file, { force: true });
  }
}

module.exports = { transcribe, fromRequest, extFor };
