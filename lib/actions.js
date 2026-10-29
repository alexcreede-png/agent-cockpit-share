'use strict';
const { randomBytes, createHash } = require('node:crypto');

// Receipts live for this server incarnation only. Never evict a receipt and then
// accept its ID again. At capacity, reject new actions before any terminal effect.
function createActions({ limit = 4096 } = {}) {
  const epoch = randomBytes(24).toString('hex');
  const records = new Map();
  const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
  function run(name, body, execute) {
    if (body.actionEpoch !== epoch) throw fail('ACTION_EPOCH_CHANGED', 'Delivery history unavailable after server restart. Review output; do not resend automatically.');
    if (typeof body.actionId !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$(?![\s\S])/.test(body.actionId)) {
      throw fail('ACTION_INVALID', 'Invalid action reference', 400);
    }
    const key = body.actionId;
    const digest = createHash('sha256').update(JSON.stringify([name, body.key ?? null, body.text ?? null])).digest('hex');
    const existing = records.get(key);
    if (existing) {
      if (existing.digest !== digest) throw fail('ACTION_MISMATCH', 'Action reference has different input');
      return existing.result;
    }
    // Checking is read-only, including if the original request never arrived.
    if (body.check) throw fail('ACTION_UNKNOWN', 'Delivery is unconfirmed. No receipt exists; review output before choosing another action.');
    if (records.size >= limit) throw fail('ACTION_CAPACITY', 'Delivery receipt capacity reached; action not sent.', 503);
    const record = { digest };
    records.set(key, record); // Reserve synchronously before any terminal call.
    record.result = Promise.resolve().then(execute).then(() => ({ ok: true, actionId: key }), () => {
      // tmux may have performed part or all of an action before reporting failure.
      throw fail('ACTION_UNCONFIRMED', 'Terminal delivery is unconfirmed. Review output before choosing another action.');
    });
    return record.result;
  }
  return { epoch, run };
}
module.exports = { createActions };
