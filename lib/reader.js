'use strict';
// Read only an exact process-bound conversation. Never select the newest session or scan logs.
const fs = require('node:fs/promises');
const path = require('node:path');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_BYTES = 32 * 1024 * 1024;

function messagesFromUpdates(text, sessionId) {
  const messages = [], seen = new Set();
  let active = null, total = 0;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch {
      if (index === lines.length - 1) break; // In-flight final line may be incomplete.
      throw new Error('Conversation contains an invalid record');
    }
    const p = event.params;
    if (!p || p.sessionId !== sessionId) continue;
    const id = p._meta?.eventId;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const u = p.update || {}, kind = u.sessionUpdate;
    if (kind === 'tool_call' || kind === 'turn_completed') { active = null; continue; }
    const role = kind === 'user_message_chunk' ? 'user' : kind === 'agent_message_chunk' ? 'assistant' : null;
    if (!role) continue; // Never expose thoughts, raw tool arguments/results, or system prompts.
    const content = u.content || {};
    const value = content.type === 'text' && typeof content.text === 'string' ? content.text
      : role === 'user' && content.type === 'image' ? '\n[Image attachment]\n' : '';
    if (!value) continue;
    if (!active || active.role !== role) {
      active = { id: String(messages.length), role, text: '' };
      messages.push(active);
    }
    active.text += value;
    total += value.length;
    if (total > 2 * 1024 * 1024) throw new Error('Conversation exceeds reader limit');
  }
  return messages.filter(m => m.text.trim());
}

function createReader({ grokHome, paneIdentity }) {
  const bindings = new Map(), cache = new Map();
  return async function read(session) {
    if (session.lane !== 'grok') return null;
    const identity = await paneIdentity(session.name);
    if (!identity || !Number.isSafeInteger(identity.pid)) return null;
    const key = `${identity.pid}:${session.created}:${session.project}`;
    let entries;
    try { entries = JSON.parse(await fs.readFile(path.join(grokHome, 'active_sessions.json'), 'utf8')); }
    catch { return null; }
    if (!Array.isArray(entries)) return null;
    const matches = [];
    const projectStat = await fs.stat(session.project);
    for (const e of entries) {
      if (e.pid !== identity.pid || !UUID.test(e.session_id || '') || typeof e.cwd !== 'string'
          || !(Date.parse(e.opened_at) >= session.created - 5000)) continue;
      try {
        const cwdStat = await fs.stat(e.cwd);
        if (cwdStat.dev === projectStat.dev && cwdStat.ino === projectStat.ino) matches.push(e);
      } catch { /* A missing project cannot establish identity. */ }
    }
    if (matches.length > 1) return null;
    let binding = bindings.get(session.name);
    if (matches.length === 1) {
      binding = { key, id: matches[0].session_id, cwd: matches[0].cwd };
      bindings.set(session.name, binding);
    }
    if (!binding || binding.key !== key) return null;
    const base = await fs.realpath(path.join(grokHome, 'sessions'));
    const candidate = path.join(base, encodeURIComponent(binding.cwd), binding.id, 'updates.jsonl');
    let file;
    try { file = await fs.realpath(candidate); } catch { return null; }
    if (file !== candidate) return null; // Do not follow a symlink to another conversation.
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const version = `${file}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    const previous = cache.get(session.name);
    if (previous?.version === version) return previous.result;
    const messages = messagesFromUpdates(await fs.readFile(file, 'utf8'), binding.id);
    const result = { source: 'conversation', messages };
    cache.set(session.name, { version, result });
    return result;
  };
}
module.exports = { createReader, messagesFromUpdates };
