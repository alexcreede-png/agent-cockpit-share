'use strict';
// Device pairing. Tailscale proves *who* is asking, but anything on the Mac that can reach the
// loopback port can fake those headers. So each phone also pairs once: `npm run pair` on the Mac
// prints a short one-time code, the phone enters it, and gets a long random device cookie. Every
// request after that must carry the cookie. Only hashes are stored, in an owner-only directory.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COOKIE = 'cockpit_device';
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_TRIES = 5;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const MAX_AGE_S = 400 * 24 * 3600;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Create the state directory owner-only, or refuse if someone else can reach it.
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.statSync(dir);
  if (!st.isDirectory() || st.uid !== process.getuid()) throw new Error(`cockpit: ${dir} must be a directory you own`);
  if (st.mode & 0o077) throw new Error(`cockpit: ${dir} must not be accessible to others (chmod 700 it)`);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function store(dir) {
  ensureDir(dir);
  const devicesFile = path.join(dir, 'devices.json');
  const codeFile = path.join(dir, 'pair-code.json');
  const devices = () => readJson(devicesFile, []);

  return {
    // Mac side: make a fresh one-time code (replaces any earlier one).
    newCode(now = Date.now()) {
      const bytes = crypto.randomBytes(8);
      const code = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
      writeJson(codeFile, { hash: sha(code), expires: now + CODE_TTL_MS, tries: 0 });
      return { code, expires: now + CODE_TTL_MS };
    },

    // Phone side: trade a code for a device token. Returns the token, or null.
    redeem(code, label, now = Date.now()) {
      const pending = readJson(codeFile, null);
      if (!pending) return null;
      const clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (now > pending.expires || pending.tries >= CODE_TRIES) { fs.rmSync(codeFile, { force: true }); return null; }
      if (!same(sha(clean), pending.hash)) {
        pending.tries += 1;
        if (pending.tries >= CODE_TRIES) fs.rmSync(codeFile, { force: true }); else writeJson(codeFile, pending);
        return null;
      }
      fs.rmSync(codeFile, { force: true });
      const token = crypto.randomBytes(32).toString('base64url');
      const id = crypto.randomBytes(3).toString('hex');
      writeJson(devicesFile, [...devices(), { id, hash: sha(token), label: String(label || '').slice(0, 80), created: new Date(now).toISOString() }]);
      return token;
    },

    // Every request: is this cookie value a paired device?
    check(token) {
      if (typeof token !== 'string' || token.length < 20) return false;
      const h = sha(token);
      return devices().some((d) => same(d.hash, h));
    },

    list: () => devices().map(({ id, label, created }) => ({ id, label, created })),
    revoke(id) {
      const before = devices();
      const after = id === 'all' ? [] : before.filter((d) => d.id !== id);
      writeJson(devicesFile, after);
      return before.length - after.length;
    },
  };
}

function readCookie(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]+)`));
  return m ? m[1] : null;
}

function cookieHeader(token, secure) {
  return `${COOKIE}=${token}; Path=/; Max-Age=${MAX_AGE_S}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

module.exports = { store, readCookie, cookieHeader, COOKIE, CODE_TTL_MS, CODE_TRIES };
