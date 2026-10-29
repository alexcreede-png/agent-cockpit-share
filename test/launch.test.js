'use strict';
// Exercise the actual launcher string in a real shell, with an isolated fake CLI.
// No login profiles, provider state, tmux servers or model requests are used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { LANES } = require('../lib/tmux');

test('agy interactive launcher delivers the whole first message as one option', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-launch-contract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'agy'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args.length > 1 || (args.length && !args[0].startsWith('--prompt-interactive='))) {
  console.error('Unexpected positional prompt'); process.exit(64);
}
process.stdout.write(JSON.stringify(args.length ? args[0].slice('--prompt-interactive='.length) : null));
`, { mode: 0o700 });
  const launch = (command, prompt) => spawnSync('/bin/zsh', ['-f', '-c', command], {
    cwd: dir, env: { PATH: dir, COCKPIT_PROMPT: prompt }, encoding: 'utf8', timeout: 5000,
  });
  // The fixture detects the original incompatibility, rather than accepting anything.
  assert.equal(launch('exec agy "$COCKPIT_PROMPT"', 'hello').status, 64);
  const messages = ['', 'Plan a kitchen garden', 'First line\nSecond line\n\nFinal line',
    '日本語 🌿 “quotes” and café', '--model=not-an-option --print',
    `Literal '$HOME' \\"quote\\"; $(touch SHOULD_NOT_EXIST) \`touch ALSO_NOT_EXIST\` & | < >`,
    'x'.repeat(7999) + '終'];
  for (const prompt of messages) {
    const result = launch(LANES.agy, prompt);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout), prompt || null);
  }
  assert.equal(fs.existsSync(path.join(dir, 'SHOULD_NOT_EXIST')), false);
  assert.equal(fs.existsSync(path.join(dir, 'ALSO_NOT_EXIST')), false);
});


test('positional launchers keep option-looking first messages literal and upload options separate', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-positional-launch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const lane of ['claude','codex','grok']) {
    fs.writeFileSync(path.join(dir,lane), `#!${process.execPath}
const args=process.argv.slice(2), options=[], positional=[]; let literal=false;
for (const arg of args) {
  if (!literal && arg==='--') { literal=true; continue; }
  if (!literal && arg.startsWith('--add-dir=')) options.push(arg.slice('--add-dir='.length));
  else if (!literal) { console.error('Prompt exposed to option/subcommand parsing'); process.exit(64); }
  else positional.push(arg);
}
process.stdout.write(JSON.stringify({options,positional}));
`, {mode:0o700});
  }
  const launch=(command,prompt,uploads)=>spawnSync('/bin/zsh',['-f','-c',command],{
    cwd:dir,env:{PATH:dir,COCKPIT_PROMPT:prompt,COCKPIT_UPLOADS:uploads},encoding:'utf8',timeout:5000,
  });
  assert.equal(launch('exec grok "$COCKPIT_PROMPT"','--help','').status,64,'detects original missing delimiter');
  for (const lane of ['claude','codex','grok']) for (const uploads of ['', '/example/uploads with spaces']) {
    for (const prompt of ['', '--help', '--', '-p', 'resume', 'First line\nSecond line', '日本語 🌿',
      "Literal '$HOME'; $(touch SHOULD_NOT_EXIST) `touch ALSO_NOT_EXIST` & | < >", 'x'.repeat(7999)+'終']) {
      const result=launch(LANES[lane],prompt,uploads);
      assert.equal(result.status,0,lane+': '+result.stderr);
      assert.deepEqual(JSON.parse(result.stdout),{options:lane!=='grok'&&uploads?[uploads]:[],positional:prompt?[prompt]:[]});
    }
  }
  assert.equal(fs.existsSync(path.join(dir,'SHOULD_NOT_EXIST')),false);
  assert.equal(fs.existsSync(path.join(dir,'ALSO_NOT_EXIST')),false);
});
