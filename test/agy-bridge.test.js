'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const bridge = path.resolve(__dirname, '../scripts/agy.js');

test('bridge preserves CLI arguments and exit status while retaining only creation identity', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-agy-bridge-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'binding.json'), prompt = '--literal\n日本語 $HOME `not-a-command`';
  fs.writeFileSync(path.join(root, 'agy'), `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
if(args[0]!=='--log-file=/dev/fd/3')process.exit(63);
fs.writeSync(3,'I1027 01:02:03.123456 123 input_loop.go:106] PRIVATE RAW PROMPT AND DIAGNOSTIC\\n');
fs.writeSync(3,'I1027 01:02:03.123456 123 server.go:1225] Created conversation 11111111-1111-4111-8111-111111111111 (backend=BACKEND_TYPE_UNSPECIFIED)\\n');
process.stdout.write(JSON.stringify(args.slice(1)));
process.exitCode=17;
`, { mode: 0o700 });
  const result = spawnSync(process.execPath, [bridge, '--prompt-interactive=' + prompt], {
    cwd: root, env: { PATH: root, COCKPIT_READER_BINDING: file, COCKPIT_READER_TOKEN: 'a'.repeat(64), COCKPIT_SESSION: 'agy-test' },
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 17, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['--prompt-interactive=' + prompt]);
  const raw = fs.readFileSync(file, 'utf8'), record = JSON.parse(raw);
  assert.equal(record.session, 'agy-test'); assert.equal(record.project, root);
  assert.equal(record.id, '11111111-1111-4111-8111-111111111111');
  assert.ok(record.childPid > 0 && record.wrapperPid > 0 && record.childPid !== record.wrapperPid);
  assert.equal(raw.includes('PRIVATE'), false); assert.equal(raw.includes(prompt), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(root).sort(), ['agy', 'binding.json']);
});

test('bridge without an owned binding leaves the normal CLI invocation intact', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-agy-normal-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'agy'), `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));`, { mode: 0o700 });
  const result = spawnSync(process.execPath, [bridge], { cwd: root, env: { PATH: root }, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), []);
});

test('ambiguous identity disables live reader even when all binding mutations fail', async t => {
  const { spawn } = require('node:child_process');
  const { ownsProcess } = require('../lib/agy-reader');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-agy-ambiguous-')));
  const file = path.join(root, 'binding.json'), preload = path.join(root, 'fail-storage.cjs');
  fs.writeFileSync(preload, `const fs=require('node:fs');const write=fs.writeFileSync,unlink=fs.unlinkSync;let writes=0;
fs.writeFileSync=function(file,...args){if(String(file).startsWith(${JSON.stringify(file)}+'.')&&++writes>1)throw Object.assign(Error('full'),{code:'ENOSPC'});return write.call(this,file,...args)};
fs.unlinkSync=function(file,...args){if(file===${JSON.stringify(file)})throw Object.assign(Error('read only'),{code:'EROFS'});return unlink.call(this,file,...args)};`);
  fs.writeFileSync(path.join(root, 'agy'), `#!${process.execPath}
const fs=require('node:fs');const emit=id=>fs.writeSync(3,'I1027 01:02:03.123456 123 server.go:1225] Created conversation '+id+' (backend=BACKEND_TYPE_UNSPECIFIED)\\n');
emit('11111111-1111-4111-8111-111111111111');let second=false;setInterval(()=>{if(!second&&fs.existsSync('trigger')){second=true;emit('22222222-2222-4222-8222-222222222222')}},20);
`, { mode: 0o700 });
  const wrapper = spawn(process.execPath, [bridge], { cwd: root, env: { PATH: root, NODE_OPTIONS: '--require=' + preload,
    COCKPIT_READER_BINDING: file, COCKPIT_READER_TOKEN: 'a'.repeat(64), COCKPIT_SESSION: 'agy-test' }, stdio: 'ignore' });
  const exited = new Promise(resolve => wrapper.once('exit', resolve));
  let record;
  t.after(async () => { wrapper.kill('SIGTERM'); await exited; fs.rmSync(root, { recursive: true, force: true }); });
  for (let i = 0; i < 100 && !fs.existsSync(file); i++) await new Promise(r => setTimeout(r, 20));
  record = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(await ownsProcess(record), true, 'first bound identity is live');
  fs.writeFileSync(path.join(root, 'trigger'), 'second identity');
  let allowed = true;
  for (let i = 0; i < 100 && allowed; i++) { await new Promise(r => setTimeout(r, 20)); allowed = await ownsProcess(record); }
  assert.equal(allowed, false, 'process-level invalidation survives failed unlink and write');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).ambiguous, false, 'old record deliberately remains to exercise the failure');
});
