'use strict';
// Voice notes from the phone are transcribed on this machine by `transcribeCommand` from the config
// (the audio file path is appended as the last argument; the command prints the text).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

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
  const folder = path.join(dir, '.voice');
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, `${Date.now()}-${process.pid}${extFor(req.headers['content-type'])}`);
  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(file, { mode: 0o600 });
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { req.unpipe(out); out.destroy(); reject(Object.assign(new Error('recording too long'), { status: 413 })); }
      });
      req.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      req.pipe(out);
    });
    return await transcribe(file, command);
  } finally {
    fs.rm(file, { force: true }, () => {});
  }
}

module.exports = { transcribe, fromRequest, extFor };
