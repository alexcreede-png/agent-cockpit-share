'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { metadataFromBlob, messagesFromSteps } = require('./agy-messages');
const execute = promisify(execFile);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_BYTES = 32 * 1024 * 1024;

async function sameDirectory(a, b) {
  const [x, y] = await Promise.all([fs.stat(a), fs.stat(b)]);
  return x.isDirectory() && y.isDirectory() && x.dev === y.dev && x.ino === y.ino;
}
async function ownsProcess(binding) {
  const options = { encoding: 'utf8', timeout: 2000, maxBuffer: 1 << 20 };
  const [parent, wrapper] = await Promise.all([
    execute('ps', ['-p', String(binding.childPid), '-o', 'ppid='], options),
    execute('ps', ['-p', String(binding.wrapperPid), '-o', 'args='], options),
  ]);
  return Number(parent.stdout.trim()) === binding.wrapperPid
    && wrapper.stdout.trim() === 'cockpit-agy-reader-active';
}
async function exactFile(base, relative, maxBytes) {
  const candidate = path.join(base, relative);
  if (await fs.realpath(candidate) !== candidate) throw new Error('Reader path redirected');
  const stat = await fs.stat(candidate);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error('Reader file unavailable');
  return { file: candidate, stat };
}

function createAgyReader({ stateDir, agyHome, readerIdentity, verifyProcess = ownsProcess, Database }) {
  let SQLite = Database;
  return async session => {
    if (session.lane !== 'agy' || session.dead || !readerIdentity || !stateDir || !agyHome
        || !/^[a-zA-Z0-9_-]+$/.test(session.name) || !Number.isFinite(session.created)) return null;
    try {
      const identity = await readerIdentity(session.name);
      if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0
          || !/^[a-f0-9]{64}$/.test(identity.token || '')) return null;
      const root = await fs.realpath(path.join(stateDir, 'agy-bindings'));
      const recordFile = await exactFile(root, session.name + '.json', 4096);
      const recordText = await fs.readFile(recordFile.file, 'utf8'), b = JSON.parse(recordText);
      if (b.version !== 1 || b.session !== session.name || b.token !== identity.token
          || b.wrapperPid !== identity.pid || !Number.isSafeInteger(b.childPid) || b.childPid <= 0
          || b.ambiguous !== false || !UUID.test(b.id || '') || typeof b.project !== 'string'
          || !Number.isFinite(b.started) || b.started < session.created - 5000
          || !Number.isFinite(b.observed) || b.observed < b.started || b.observed > Date.now() + 5000
          || !await sameDirectory(b.project, session.project)) return null;
      const conversations = await fs.realpath(path.join(agyHome, 'conversations'));
      const { file, stat } = await exactFile(conversations, b.id + '.db', MAX_BYTES);
      for (const suffix of ['-wal', '-shm']) {
        try { await exactFile(conversations, b.id + '.db' + suffix, MAX_BYTES); }
        catch (e) { if (e.code !== 'ENOENT') return null; }
      }
      // The CLI closes its database when idle. Ownership comes from its captured creation
      // event, the per-launch nonce and the still-exact wrapper/child process relationship.
      if (!await verifyProcess(b)) return null;
      if (!SQLite) SQLite = require('node:sqlite').DatabaseSync;
      const db = new SQLite(file, { readOnly: true, enableForeignKeyConstraints: false, allowExtension: false });
      let result;
      try {
        db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN');
        const meta = db.prepare('SELECT cascade_id FROM trajectory_meta LIMIT 2').all();
        if (meta.length !== 1 || meta[0].cascade_id !== b.id) return null;
        const rows = db.prepare('SELECT data FROM trajectory_metadata_blob WHERE id=? LIMIT 2').all('main');
        if (rows.length !== 1 || rows[0].data.length > 65536) return null;
        const info = metadataFromBlob(rows[0].data);
        if (info.rootId !== b.id || info.created < b.started - 5000 || info.created > b.observed + 5000
            || !info.workspaces.length || info.workspaces.length > 8) return null;
        for (const uri of info.workspaces) {
          if (!await sameDirectory(fileURLToPath(uri), session.project)) return null;
        }
        const size = db.prepare('SELECT count(*) AS count, sum(length(step_payload)) AS bytes FROM steps').get();
        if (size.count > 10000 || size.bytes > MAX_BYTES) return null;
        const steps = db.prepare('SELECT idx, step_type, step_format, step_payload FROM steps ORDER BY idx').all();
        const messages = messagesFromSteps(steps);
        if (!messages.length) return null; // Keep setup/errors visible before any saved message exists.
        result = { source: 'conversation', messages };
      } finally { db.close(); }
      // A replaced file or changed identity during the read cannot be published.
      const after = await exactFile(conversations, b.id + '.db', MAX_BYTES);
      if (after.stat.ino !== stat.ino || after.stat.dev !== stat.dev
          || await fs.readFile(recordFile.file, 'utf8') !== recordText) return null;
      const latest = await readerIdentity(session.name);
      if (!latest || latest.pid !== identity.pid || latest.token !== identity.token
          || !await verifyProcess(b)) return null;
      return result;
    } catch { return null; } // Unsupported CLI/schema/Node versions retain terminal output.
  };
}

module.exports = { createAgyReader, ownsProcess };
