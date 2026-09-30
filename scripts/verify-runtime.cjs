'use strict';
// Runtime acceptance test. Uses a unique tmux socket and synthetic temporary project only.
// A PATH shim routes every cockpit tmux call to the owned socket; production/default servers
// are never read, resized, or signaled. Temporary artifacts are retained for inspection.
const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process'),assert=require('assert/strict');
const WebSocket=require('ws');
const root=path.resolve(__dirname,'..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cockpit-smoke-'));const socket='cockpit-smoke-'+process.pid;
const tmux=cp.execFileSync('/bin/zsh',['-lc','command -v tmux'],{encoding:'utf8'}).trim();
fs.mkdirSync(path.join(tmp,'bin'));fs.mkdirSync(path.join(tmp,'projects'));fs.mkdirSync(path.join(tmp,'projects','example'));
fs.writeFileSync(path.join(tmp,'bin','tmux'),`#!/bin/sh\nshift 2\nexec '${tmux}' -L '${socket}' "$@"\n`,{mode:0o700});
fs.writeFileSync(path.join(tmp,'config.json'),JSON.stringify({user:'test@example.com',projectsRoot:path.join(tmp,'projects'),stateDir:path.join(tmp,'state'),uploadsDir:path.join(tmp,'uploads')}));
const port=18828,base=`http://127.0.0.1:${port}`;
const child=cp.spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PATH:path.join(tmp,'bin')+':'+process.env.PATH,COCKPIT_CONFIG:path.join(tmp,'config.json'),COCKPIT_PORT:String(port),COCKPIT_ALLOW_LOCAL:'1',COCKPIT_PAIRING:'0'},stdio:['ignore','pipe','pipe']});
let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function post(p,b){const r=await fetch(base+p,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(b)});assert.equal(r.status,200,await r.clone().text());return r.json();}
(async()=>{let name;try{
 for(let i=0;i<40&&!logs.includes('cockpit on');i++)await wait(100);assert.match(logs,/cockpit on/);
 ({name}=await post('/api/sessions',{lane:'shell',project:path.join(tmp,'projects','example')}));await wait(800);
 await post(`/api/sessions/${name}/keys`,{text:"printf 'SMOKE_%s\\n' 'REPLY'"});await wait(200);
 const screen=await(await fetch(`${base}/api/sessions/${name}/history`)).text();assert.match(screen,/SMOKE_REPLY/);
 await post(`/api/sessions/${name}/keys`,{key:'C-c'});
 await new Promise((resolve,reject)=>{const ws=new WebSocket(base.replace('http','ws')+`/ws/attach?name=${name}&cols=45&rows=25`,{origin:base});let out='', sent=false;const timer=setTimeout(()=>{ws.close();reject(Error('websocket timeout: '+out.slice(-800)));},5000);ws.on('message',d=>{out+=d;if(!sent){sent=true;ws.send(JSON.stringify({t:'in',d:"printf 'WS_%s\\n' 'REPLY'\r"}));}if(out.includes('WS_REPLY')){clearTimeout(timer);ws.close();resolve();}});ws.on('error',reject);});
 await post(`/api/sessions/${name}/end`,{});name=null;
 const state=await(await fetch(base+'/api/state')).json();assert.equal(state.sessions.length,0);
 console.log('PASS isolated tmux server: create → text → key → history → WebSocket → end; no existing sessions read');
 }finally{if(name)await post(`/api/sessions/${name}/end`,{}).catch(()=>{});child.kill('SIGTERM');console.log('Owned test server stopped.');}
})().catch(e=>{console.error(e);console.error(logs);process.exitCode=1});
