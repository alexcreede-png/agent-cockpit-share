'use strict';
// Files sent from the phone are streamed to disk outside every project; the path is handed to the
// agent in the message box, so nothing lands in a repo by accident.
const fs = require('fs');
const path = require('path');

// Keep a readable, harmless name: no directories, no leading dots, no odd characters.
function safeName(name) {
  const base = path.basename(String(name || '')).normalize('NFC');
  const clean = base.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^[._]+/, '').slice(-80);
  return clean || 'upload';
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

// Stream `stream` to <dir>/<session>/<stamp>-<name>. Rejects with .status 413 past maxBytes.
function save(stream, { dir, session, filename, maxBytes }) {
  const folder = path.join(dir, session);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, `${stamp()}-${safeName(filename)}`);
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file, { flags: 'wx', mode: 0o600 });
    let size = 0, failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      stream.unpipe(out);
      // The file is opened asynchronously; delete it only once the stream has closed, or the
      // open can land after the delete and leave an empty file behind.
      out.once('close', () => fs.rm(file, { force: true }, () => reject(err)));
      out.destroy();
    };
    stream.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { stream.pause(); fail(Object.assign(new Error('file too large'), { status: 413 })); }
    });
    stream.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => { if (!failed) resolve({ path: file, bytes: size }); });
    stream.pipe(out);
  });
}

module.exports = { safeName, save, stamp };
