'use strict';
// Real HTTP + isolated tmux: dropped response, process restart, concurrent retries and end.
// No provider executable, existing configuration, session or transcript is accessed.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const cp=require('node:child_process'),net=require('node:net'),http=require('node:http');
const root=path.resolve(__dirname,'..'),tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cockpit-start-acceptance-')));
const socket='cockpit-start-acceptance-'+process.pid;
const tmux=cp.execFileSync('/bin/zsh',['-lc','command -v tmux'],{encoding:'utf8'}).trim();
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
fs.mkdirSync(path.join(tmp,'bin'));const project=path.join(tmp,'projects','example');fs.mkdirSync(project,{recursive:true});
fs.writeFileSync(path.join(tmp,'bin','tmux'),`#!/bin/sh\n[ "$1" = '-L' ] && [ "$2" = 'cockpit' ] || exit 97\nshift 2\nexec ${quote(tmux)} -L ${quote(socket)} "$@"\n`,{mode:0o700});
fs.writeFileSync(path.join(tmp,'config.json'),JSON.stringify({user:'test@example.com',projectsRoot:path.join(tmp,'projects'),stateDir:path.join(tmp,'state'),grokHome:path.join(tmp,'fake-provider'),uploadsDir:path.join(tmp,'uploads')}));
const pause=ms=>new Promise(r=>setTimeout(r,ms));let child,base,logs='';
async function startServer(port){
 let ready=false;
 child=cp.spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PATH:path.join(tmp,'bin')+':'+process.env.PATH,COCKPIT_CONFIG:path.join(tmp,'config.json'),COCKPIT_PORT:String(port),COCKPIT_SOCKET:'',COCKPIT_ALLOW_LOCAL:'1',COCKPIT_PAIRING:'0',COCKPIT_NOTIFY:'0'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',d=>{logs+=d;if(String(d).includes('cockpit on'))ready=true;});child.stderr.on('data',d=>logs+=d);
 for(let n=0;n<100&&!ready&&child.exitCode===null;n++)await pause(50);
 assert.ok(ready,'owned server became ready');
}
async function stopServer(){if(!child||child.exitCode!==null)return;const c=child;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('owned web server did not stop')),5000);c.once('exit',()=>{clearTimeout(timer);resolve();});c.kill('SIGTERM');});}
async function post(route,body){const r=await fetch(base+route,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});return {status:r.status,body:await r.json()};}
const state=async()=>await(await fetch(base+'/api/state',{signal:AbortSignal.timeout(5000)})).json();
(async()=>{const proof={};try{
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));base='http://127.0.0.1:'+port;
 await startServer(port);assert.equal((await state()).startRecovery,true);
 const payload={lane:'shell',project,prompt:'',requestId:'owned-lost-response_01'};
 // Close the first HTTP response without reading its body; the pane already exists.
 await new Promise((resolve,reject)=>{const req=http.request(base+'/api/sessions',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'}},res=>{try{assert.equal(res.statusCode,200);res.destroy();resolve();}catch(e){reject(e);}});req.on('error',reject);req.end(JSON.stringify(payload));});
 let sessions=(await state()).sessions;assert.equal(sessions.length,1);const name=sessions[0].name;
 await stopServer();await startServer(port);
 const retry=await post('/api/sessions',payload);assert.equal(retry.status,200);assert.equal(retry.body.name,name);assert.equal(retry.body.reused,true);assert.equal((await state()).sessions.length,1);
 proof.responseLossAndRestart={sameName:true,createdCount:1};
 const concurrent={...payload,requestId:'owned-concurrent-start_02'};
 const many=await Promise.all(Array.from({length:12},()=>post('/api/sessions',concurrent)));
 assert.ok(many.every(r=>r.status===200));assert.equal(new Set(many.map(r=>r.body.name)).size,1);assert.equal(many.filter(r=>!r.body.reused).length,1);assert.equal((await state()).sessions.length,2);
 proof.concurrent={requests:12,createdCount:1};
 const mismatch=await post('/api/sessions',{...payload,prompt:'changed'});assert.equal(mismatch.status,409);assert.equal(mismatch.body.code,'START_REQUEST_MISMATCH');
 // Real pane exit is distinct from deleting the session; both must refuse recreation.
 await post('/api/sessions/'+name+'/keys',{text:'exit'});
 for(let n=0;n<40;n++){sessions=(await state()).sessions;if(sessions.find(s=>s.name===name)?.dead)break;await pause(50);}
 assert.equal(sessions.find(s=>s.name===name)?.dead,true);
 const dead=await post('/api/sessions',payload);assert.equal(dead.status,409);assert.equal(dead.body.code,'START_SESSION_ENDED');
 assert.equal((await post('/api/sessions/'+name+'/end',{})).status,200);
 const ended=await post('/api/sessions',payload);assert.equal(ended.status,409);assert.equal(ended.body.code,'START_UNCONFIRMED');assert.equal((await state()).sessions.length,1);
 proof.ended={deadCode:dead.body.code,deletedCode:ended.body.code,recreated:false};
 const invalid=await post('/api/sessions',{...payload,requestId:'bad'});assert.equal(invalid.status,400);
 assert.equal((await state()).sessions.length,1);proof.invalid={status:invalid.status,noCreation:true};
 proof.at=new Date().toISOString();proof.socket=socket;fs.writeFileSync(path.join(tmp,'acceptance.json'),JSON.stringify(proof,null,2));
 console.log(JSON.stringify(proof,null,2));console.log('PASS real isolated start recovery; only synthetic shell sessions used.');
}finally{
 try{cp.execFileSync(tmux,['-L',socket,'kill-server'],{stdio:'ignore',timeout:5000});}catch{}
 await stopServer();fs.writeFileSync(path.join(tmp,'server.log'),logs);console.log('Retained synthetic evidence:',tmp);
}})().catch(e=>{console.error(e);process.exitCode=1});
