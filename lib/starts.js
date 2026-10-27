'use strict';
// Immutable reservations: never forget a request or infer permission to launch from absence
// of its pane. A torn record is deliberately unusable, rather than permission to try again.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_RECORD_BYTES = 1024;
const validRequestId = (id) => typeof id === 'string' && id.length >= 16 && id.length <= 128 && !/[^A-Za-z0-9_-]/.test(id);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function failure(code, requestId, name) {
  const messages = {
    START_INVALID_REQUEST_ID: 'requestId must be 16–128 letters, digits, underscores or hyphens.',
    START_REQUEST_MISMATCH: 'This requestId was already used for a different start. Reuse the original request unchanged.',
    START_UNCONFIRMED: 'Start outcome is unconfirmed. Retry the same request to reconcile. Check the task list before explicitly starting a new request.',
    START_SESSION_ENDED: 'This start belongs to an ended session. It will not be started again. Use a new requestId only for an intentional new task.',
  };
  return Object.assign(new Error(messages[code]), { status: code === 'START_INVALID_REQUEST_ID' ? 400 : 409,
    code, requestId: validRequestId(requestId) ? requestId : undefined, sessionName: name });
}

function syncDir(dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function privateDir(dir) {
  // Flush directory ancestry too, including when stateDir itself is new. Do not change
  // permissions on pre-existing directories or follow a symlink at the configured boundary.
  if (!fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (!fs.existsSync(parent)) privateDir(parent);
    fs.mkdirSync(dir, { mode: 0o700 });
  }
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o077)) {
    throw new Error('start state must be an owner-only directory');
  }
  syncDir(dir);
  syncDir(path.dirname(dir));
}

function readRecord(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) || st.nlink !== 1 ||
        st.size < 1 || st.size > MAX_RECORD_BYTES) throw new Error('invalid start record');
    const buf = Buffer.alloc(MAX_RECORD_BYTES + 1);
    const count = fs.readSync(fd, buf, 0, buf.length, 0);
    if (count !== st.size) throw new Error('changed start record');
    const record = JSON.parse(buf.subarray(0, count).toString('utf8'));
    if (!record || record.version !== 1 || typeof record.name !== 'string' ||
        !/^(claude|codex|grok|agy|shell)-start-[a-f0-9]{32}$(?![\s\S])/.test(record.name) ||
        typeof record.digest !== 'string' || !/^[a-f0-9]{64}$(?![\s\S])/.test(record.digest) ||
        Object.keys(record).sort().join(',') !== 'digest,name,version') throw new Error('invalid start record');
    return record;
  } finally { fs.closeSync(fd); }
}

function reserve(file, record, dir) {
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  try {
    fs.writeFileSync(fd, JSON.stringify(record) + '\n');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  // Flush the new directory entry before anything can start. No rewrite or cleanup window.
  syncDir(dir);
  return true;
}

function createStarter({ stateDir, tmux }) {
  const dir = path.join(stateDir, 'start-requests');
  const queues = new Map();
  async function reconcile(record, payload, requestId, reused) {
    let outcome;
    try { outcome = await tmux.reconcileStart({ ...payload, name: record.name, startToken: sha(record.name + '\0' + record.digest) }); }
    catch { throw failure('START_UNCONFIRMED', requestId, record.name); }
    if (outcome === 'ended') throw failure('START_SESSION_ENDED', requestId, record.name);
    if (outcome !== 'existing') throw failure('START_UNCONFIRMED', requestId, record.name);
    // This confirms only an owned live tmux pane, never CLI readiness or prompt acceptance.
    return { name: record.name, requestId, reused };
  }
  async function start(payload, requestId) {
    // Absence alone selects the legacy path; null/empty/otherwise malformed IDs are errors.
    if (requestId === undefined) return { name: await tmux.create(payload) };
    if (!validRequestId(requestId)) throw failure('START_INVALID_REQUEST_ID', requestId);
    const key = sha(requestId);
    const action = async () => {
      const digest = sha(JSON.stringify([payload.lane, payload.project, payload.prompt]));
      const file = path.join(dir, key + '.json');
      let record, fresh;
      try {
        privateDir(stateDir);
        privateDir(dir);
        record = { version: 1, name: `${payload.lane}-start-${crypto.randomBytes(16).toString('hex')}`, digest };
        fresh = reserve(file, record, dir);
        if (!fresh) record = readRecord(file);
      } catch { throw failure('START_UNCONFIRMED', requestId); }
      if (record.digest !== digest) throw failure('START_REQUEST_MISMATCH', requestId);
      if (fresh) {
        try { await tmux.create({ ...payload, name: record.name, startToken: sha(record.name + '\0' + digest) }); }
        catch { /* A timeout or metadata failure may already have made the pane. Prove it below. */ }
      }
      return reconcile(record, payload, requestId, !fresh);
    };
    const next = (queues.get(key) || Promise.resolve()).catch(() => {}).then(action);
    queues.set(key, next);
    next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
    return next;
  }
  return { start };
}

module.exports = { createStarter, validRequestId, MAX_RECORD_BYTES };
