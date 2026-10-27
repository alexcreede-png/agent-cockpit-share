'use strict';
// Actual server, reservation store and tmux wrapper; only process/network transports are fake.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

function load(file, overrides, extra = {}) {
  const module = { exports: {} }, realRequire = createRequire(file);
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, __dirname: path.dirname(file), Buffer, process, URL, setTimeout,
    require: (id) => Object.hasOwn(overrides, id) ? overrides[id] : realRequire(id), ...extra,
  }, { filename: file });
  return module.exports;
}

function fakeMachine() {
  const machine = { calls: [], sessions: new Map(), failCreate: false, failAfterCreate: false,
    failMetadata: false, failInspect: false, before: async () => {} };
  const lookup = (target) => {
    if (!target.startsWith('=')) throw new Error('fixture requires exact targets');
    const name = target.slice(1).replace(/:$/, '');
    const s = machine.sessions.get(name);
    if (!s) throw new Error('no such session');
    return s;
  };
  const execute = async (a) => {
    await machine.before(a);
    const value = (flag) => a[a.indexOf(flag) + 1];
    switch (a[0]) {
      case 'new-session': {
        if (machine.failCreate) throw new Error('create failed or timed out');
        const name = value('-s');
        if (machine.sessions.has(name)) throw new Error('duplicate session');
        const env = {};
        for (let i = 0; i < a.length; i++) if (a[i] === '-e') {
          const v = a[++i], j = v.indexOf('='); env[v.slice(0, j)] = v.slice(j + 1);
        }
        machine.sessions.set(name, { name, env, metadata: {}, dead: false });
        if (machine.failAfterCreate) throw new Error('response lost after create');
        return '';
      }
      case 'set-option': {
        if (!value('-t').endsWith(':')) throw new Error('set-option exact session requires target-window syntax');
        const s = lookup(value('-t'));
        if (machine.failMetadata === true || machine.failMetadata === a.at(-2)) throw new Error('metadata failed');
        s.metadata[a.at(-2)] = a.at(-1); return '';
      }
      case 'show-environment': {
        if (machine.failInspect) throw new Error('inspection failed');
        const s = lookup(value('-t')), key = a.at(-1);
        if (!s.env[key]) throw new Error('unknown variable');
        return `${key}=${s.env[key]}\n`;
      }
      case 'display-message': {
        const s = lookup(value('-t'));
        return `${s.name}\t${s.dead ? 1 : 0}\n`;
      }
      case 'list-panes': return [...machine.sessions.values()].map((s) =>
        `${s.name}\t${s.metadata['@lane'] || ''}\t${s.metadata['@project'] || ''}\t1\t${s.dead ? 1 : 0}\t\t0`).join('\n');
      case 'kill-session': { const s = lookup(value('-t')); machine.sessions.delete(s.name); return ''; }
      case 'capture-pane': lookup(value('-t')); return machine.screen || '';
      case 'set-hook': return '';
      default: throw new Error(`unexpected fake tmux command ${a[0]}`);
    }
  };
  machine.childProcess = { execFile(bin, args, opts, callback) {
    if (bin !== 'tmux' || args[0] !== '-L' || args[1] !== 'cockpit' || args[2] !== '-f' ||
        args[3] !== path.resolve(__dirname, '../../tmux.conf')) throw new Error('unsafe tmux transport');
    const a = args.slice(4); machine.calls.push(a);
    Promise.resolve().then(() => execute(a)).then((out) => callback(null, out, ''),
      (e) => callback(e, '', e.message));
    return { stdin: { on() {}, end() {} } };
  } };
  machine.loadTmux = () => load(path.resolve(__dirname, '../../lib/tmux.js'), { child_process: machine.childProcess });
  machine.creates = () => machine.calls.filter((c) => c[0] === 'new-session').length;
  return machine;
}

function serverHarness(config, machine, { dropResponse = false, readConversation } = {}) {
  let handler;
  const server = new EventEmitter(); server.listen = (...args) => args.at(-1)();
  const tmux = machine.loadTmux();
  load(path.resolve(__dirname, '../../server.js'), {
    http: { createServer(fn) { handler = fn; return server; } },
    ws: { WebSocketServer: class {} }, 'node-pty': { spawn() { throw new Error('no real pty'); } },
    './lib/config': { load: () => config }, './lib/tmux': tmux,
    ...(readConversation ? { './lib/reader': { ...require('../../lib/reader'), createReader: () => readConversation } } : {}),
  }, { setInterval: () => ({ unref() {} }), console: { log() {} } });
  return {
    async request(body, { url = '/api/sessions', method = 'POST', headers = {} } = {}) {
      const req = Readable.from([Buffer.from(JSON.stringify(body))]);
      req.url = url; req.method = method;
      req.headers = { host: '127.0.0.1:9999', origin: 'http://127.0.0.1:9999', ...headers };
      return new Promise((resolve) => {
        const res = { headersSent: false, setHeader() {},
          writeHead(status) { this.status = status; this.headersSent = true; },
          end(buf) { let body = buf.toString(); try { body = JSON.parse(body); } catch {} resolve({ status: this.status, body: dropResponse ? null : body }); } };
        handler(req, res);
      });
    },
  };
}

module.exports = { fakeMachine, serverHarness };
