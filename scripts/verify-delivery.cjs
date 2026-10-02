'use strict';
// Browser → real cockpit HTTP server → isolated tmux → terminal fixture → rendered history.
// No existing configuration or sessions. Retains synthetic artifacts for inspection.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const net = require('node:net');
const { webkit, chromium } = require('playwright');
const root = process.env.COCKPIT_SOURCE_ROOT ? path.resolve(process.env.COCKPIT_SOURCE_ROOT) : path.resolve(__dirname, '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-delivery-')));
const socket = `cockpit-delivery-${process.pid}`;
const tmux = cp.execFileSync('/bin/zsh', ['-lc', 'command -v tmux'], {encoding:'utf8'}).trim();
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
fs.mkdirSync(path.join(tmp, 'bin'));
const project = path.join(tmp, 'projects', 'example');
fs.mkdirSync(project, {recursive:true});
const receipt = path.join(tmp, 'received.jsonl');
fs.writeFileSync(path.join(tmp, 'bin', 'tmux'), `#!/bin/sh\n[ "$1" = '-L' ] && [ "$2" = 'cockpit' ] || exit 97\nshift 2\nexec ${quote(tmux)} -L ${quote(socket)} "$@"\n`, {mode:0o700});
const fixture = path.join(tmp, 'terminal.cjs');
fs.writeFileSync(fixture, `
'use strict';
const fs = require('fs');
process.stdin.setRawMode(true);
process.stdout.write('\\x1b[?2004hDELIVERY FIXTURE READY\\r\\n');
let stream='', draft='', count=0;
process.stdin.on('data', data => {
  stream += data.toString();
  while (stream.length) {
    if (stream.startsWith('\\x1b[200~')) {
      const end=stream.indexOf('\\x1b[201~',6);
      if (end<0) return;
      draft += stream.slice(6,end).replaceAll('\\r','\\n'); stream=stream.slice(end+6); continue;
    }
    if (stream[0]==='\\x1b' && stream.length<6) return;
    const char=stream[0];stream=stream.slice(1);
    if (char==='\\r') {
      count++; fs.appendFileSync(${JSON.stringify(receipt)},JSON.stringify({count,text:draft})+'\\n');
      if (draft.startsWith('dense:')) for(let i=1;i<=95;i++) process.stdout.write('DENSE '+i+' '+draft+'\\r\\n');
      process.stdout.write('ACTUAL REPLY '+count+': '+draft.replaceAll('\\n',' | ')+'\\r\\n');draft='';
    } else draft+=char;
  }
});
`);
const shell = path.join(tmp, 'fixture-shell');
fs.writeFileSync(shell, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)}\n`, {mode:0o700});
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({user:'test@example.com', projectsRoot:path.join(tmp,'projects'),stateDir:path.join(tmp,'state'),uploadsDir:path.join(tmp,'uploads')}));
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(check, label, ms=10000) {
  const until=Date.now()+ms;
  while(Date.now()<until) {if(await check())return;await pause(80);}
  throw new Error('Timed out: '+label);
}
const readReceipts = () => fs.existsSync(receipt) ? fs.readFileSync(receipt,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)) : [];
async function freePort() {
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));return port;
}
(async()=>{
  const port=await freePort(),base=`http://127.0.0.1:${port}`;
  const child=cp.spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PATH:path.join(tmp,'bin')+':'+process.env.PATH,SHELL:shell,COCKPIT_CONFIG:path.join(tmp,'config.json'),COCKPIT_SOCKET:'',COCKPIT_PORT:String(port),COCKPIT_ALLOW_LOCAL:'1',COCKPIT_PAIRING:'0',COCKPIT_NOTIFY:'0'},stdio:['ignore','pipe','pipe']});
  let logs='', name=null;
  child.stdout.on('data',data=>logs+=data);child.stderr.on('data',data=>logs+=data);
  const post=async(route,body={})=>{const response=await fetch(base+route,{signal:AbortSignal.timeout(5000),method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200,await response.clone().text());return response.json();};
  try {
    await waitFor(()=>logs.includes('cockpit on'),'owned server startup');
    for(const [engineName,engine] of [['webkit',webkit],['chromium',chromium]]) {
      const executablePath=process.env[`COCKPIT_${engineName.toUpperCase()}_EXECUTABLE`];
      const browser=await engine.launch({headless:true,...(executablePath?{executablePath}:{})});
      try {
        const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
        const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
        await page.goto(base);
        await page.locator('#new-btn').click();
        await page.locator('#lanes').getByRole('button',{name:'shell',exact:true}).click();
        await page.locator('#projects').getByRole('button',{name:'example',exact:true}).click();
        await page.locator('#start-btn').click();
        await page.locator('#reader').filter({hasText:'DELIVERY FIXTURE READY'}).waitFor();
        name=decodeURIComponent(new URL(page.url()).hash.slice(1));assert.ok(name.startsWith('shell-example-'));
        const initial=readReceipts().length;
        const messages=[`${engineName} unique single reply`,`${engineName} first line\nsecond line`, `dense:${engineName} final marker`];
        for(let index=0;index<messages.length;index++) {
          await page.locator('#input').fill(messages[index]);
          await page.locator('#send-btn').tap();
          await waitFor(()=>readReceipts().length===initial+index+1,'exact terminal submission');
          assert.equal(readReceipts().at(-1).text,messages[index]);
          const reply=`ACTUAL REPLY ${index+1}: ${messages[index].replaceAll('\n',' | ')}`;
          await page.locator('#reader').filter({hasText:reply}).waitFor();
          assert.equal(await page.locator('#input').inputValue(),'');
          assert.equal((await page.locator('#reader').textContent()).split(reply).length-1,1,'one rendered actual reply');
        }
        await page.setViewportSize({width:390,height:296});await pause(250);
        const tail=()=>page.locator('#reader').evaluate(el=>({top:el.scrollTop,max:el.scrollHeight-el.clientHeight,height:el.clientHeight}));
        let bounds=await tail();assert.ok(bounds.height>=60,JSON.stringify(bounds));assert.ok(bounds.max-bounds.top<3,JSON.stringify(bounds));
        await page.locator('#reader').evaluate(el=>{el.scrollTop=0;});
        await page.locator('#to-bottom').waitFor({state:'visible'});
        await page.locator('#input').focus();await page.locator('#to-bottom').tap();
        assert.equal(await page.locator('#input').evaluate(el=>document.activeElement===el),true);
        bounds=await tail();assert.ok(bounds.max-bounds.top<3,JSON.stringify(bounds));
        await page.screenshot({path:path.join(tmp,engineName+'-real-delivery.png')});
        await pause(1700);assert.equal(readReceipts().length,initial+3,'polling/resize never duplicate delivery');
        assert.deepEqual(errors,[]);
        await page.locator('#kill-btn').click();await page.locator('#kill-btn').click();
        await page.locator('#list-view').waitFor({state:'visible'});name=null;
        assert.equal((await(await fetch(base+'/api/state')).json()).sessions.length,0);
        console.log(`${engineName}: real browser Send → isolated tmux fixture → rendered single/multiline replies, exactly-once submit, shrink/Latest focus, end PASS`);
      } finally {await browser.close();}
    }
  } finally {
    // The server can create a session before the browser has captured its name.
    // Enumerate only this test server, whose every tmux call is isolated by the shim.
    try {
      const owned=await(await fetch(base+'/api/state',{signal:AbortSignal.timeout(5000)})).json();
      for(const session of owned.sessions || []) await post(`/api/sessions/${session.name}/end`).catch(()=>{});
    } catch {}
    // Failure-path fallback uses the exact socket we created, never the default server.
    try {cp.execFileSync(tmux,['-L',socket,'kill-server'],{stdio:'ignore',timeout:5000});} catch {}
    child.kill('SIGTERM');
    fs.writeFileSync(path.join(tmp,'server.log'),logs);
    console.log('Retained synthetic evidence:',tmp,'owned socket:',socket);
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
