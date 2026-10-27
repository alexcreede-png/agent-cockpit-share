'use strict';
// Narrow, bounded projection of the installed Antigravity 1.4.7 protobuf schema.
// Read only user-visible text; never recursively search blobs for strings.
const { TextDecoder } = require('node:util');
const utf8 = new TextDecoder('utf-8', { fatal: true });
const MAX_BLOB = 4 * 1024 * 1024;
const MAX_TEXT = 2 * 1024 * 1024;
// Installed1.4.7 tool/system step IDs. Visible errors/questions, generic and unknown
// step types require terminal output rather than silently losing their content.
const NON_MESSAGE = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 21, 23, 24, 25, 28,
  29, 31, 32, 33, 34, 38, 39, 40, 41, 42, 45, 47, 49, 51, 52, 53,
  54, 55, 56, 57, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 73, 74,
  75, 76, 77, 78, 79, 80, 81, 83, 84, 85, 86, 87, 88, 89, 91, 92,
  93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108,
  109, 110, 111, 112, 113, 114, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125,
  126, 127, 128, 129, 130, 131, 133, 134, 135, 136, 137, 139, 140,
]);

function fields(input) {
  const b = Buffer.from(input), result = new Map();
  if (b.length > MAX_BLOB) throw new Error('Message exceeds reader limit');
  let offset = 0, count = 0;
  function integer() {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      if (offset >= b.length) throw new Error('Incomplete message');
      const byte = b[offset++];
      value |= BigInt(byte & 127) << BigInt(i * 7);
      if (byte < 128) {
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Integer exceeds reader limit');
        return Number(value);
      }
    }
    throw new Error('Invalid integer');
  }
  while (offset < b.length) {
    if (++count > 10000) throw new Error('Too many message fields');
    const tag = integer(), number = Math.floor(tag / 8), wire = tag % 8;
    if (!number || number > 536870911) throw new Error('Invalid field');
    let value;
    if (wire === 0) value = integer();
    else {
      const size = wire === 2 ? integer() : wire === 1 ? 8 : wire === 5 ? 4 : -1;
      if (size < 0 || size > b.length - offset) throw new Error('Invalid message field');
      value = b.subarray(offset, offset + size); offset += size;
    }
    if (!result.has(number)) result.set(number, []);
    result.get(number).push({ wire, value });
  }
  return result;
}

function one(f, n, wire, fallback) {
  const values = f.get(n);
  if (!values) return fallback;
  if (values.length !== 1 || values[0].wire !== wire) throw new Error('Ambiguous message field');
  return values[0].value;
}
const text = (f, n) => utf8.decode(one(f, n, 2, Buffer.alloc(0)));
const int = (f, n) => one(f, n, 0, 0);

function metadataFromBlob(blob) {
  const f = fields(blob), workspaces = [];
  for (const item of f.get(1) || []) {
    if (item.wire !== 2) throw new Error('Invalid workspace metadata');
    workspaces.push(text(fields(item.value), 1));
  }
  const timestamp = fields(one(f, 2, 2, Buffer.alloc(0)));
  const seconds = int(timestamp, 1), nanos = int(timestamp, 2);
  if (nanos >= 1e9 || !seconds) throw new Error('Invalid creation time');
  return { workspaces, created: seconds * 1000 + Math.floor(nanos / 1e6), rootId: text(f, 6) };
}

function messagesFromSteps(rows) {
  if (!Array.isArray(rows) || rows.length > 10000) throw new Error('Conversation exceeds reader limit');
  const messages = []; let total = 0, previous = -1;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.idx) || row.idx <= previous) throw new Error('Invalid message order');
    previous = row.idx;
    if (row.step_format !== 0) throw new Error('Unsupported message format');
    if (row.step_type !== 14 && row.step_type !== 15) {
      if (!NON_MESSAGE.has(row.step_type)) throw new Error('Unsupported or visible terminal step');
      continue;
    }
    const f = fields(row.step_payload);
    if (int(f, 1) !== row.step_type) throw new Error('Message type mismatch');
    const role = row.step_type === 14 ? 'user' : 'assistant';
    const p = fields(one(f, role === 'user' ? 19 : 20, 2, Buffer.alloc(0)));
    let body;
    if (role === 'assistant') {
      // response / modified_response only. Thinking, signatures and tool calls are excluded.
      body = text(p, 8) || text(p, 1);
    } else {
      body = text(p, 2) || text(p, 1);
      if (!body) body = (p.get(3) || []).map(item => {
        if (item.wire !== 2) throw new Error('Invalid user item');
        return text(fields(item.value), 1);
      }).filter(Boolean).join('\n');
      if (p.has(5) || p.has(9)) body += '\n[Attachment]';
    }
    if (!body.trim()) continue;
    total += Buffer.byteLength(body);
    if (total > MAX_TEXT) throw new Error('Conversation exceeds reader limit');
    messages.push({ id: `agy-${row.idx}`, role, text: body });
  }
  return messages;
}

module.exports = { fields, metadataFromBlob, messagesFromSteps, MAX_TEXT };
