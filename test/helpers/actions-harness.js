'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fakeMachine, serverHarness } = require('./start-harness');

function actionFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-actions-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'projects', 'example'); fs.mkdirSync(project, { recursive: true });
  const config = { stateDir: path.join(root, 'state'), port: 9999, publicHost: '', allowLocal: true,
    user: 'example@example.test', projectsRoot: path.dirname(project), forbiddenPaths: [], pairing: false,
    frameAncestors: [], uploadsDir: '', notify: false, socketPath: '', grokHome: path.join(root, 'fake-provider') };
  const machine = fakeMachine();
  for (const name of ['a', 'b']) machine.sessions.set(name, { name, env: {}, metadata: { '@lane': 'shell', '@project': project }, dead: false });
  const restart = () => serverHarness(config, machine, { readConversation: async () => null });
  let server = restart();
  const request = (body, url = '/api/sessions/a/keys', method = 'POST') => server.request(body, { url, method });
  const fetchResponse = r => ({ ok: r.status >= 200 && r.status < 300, status: r.status,
    headers: { get: () => typeof r.body === 'string' ? 'text/plain' : 'application/json' },
    json: async () => r.body, text: async () => r.body });
  return { config, machine, request, restart() { server = restart(); }, fetchResponse,
    fetch: async (url, opts) => fetchResponse(await request(opts.body ? JSON.parse(opts.body) : {}, url, opts.method || 'GET')) };
}
module.exports = { actionFixture };
