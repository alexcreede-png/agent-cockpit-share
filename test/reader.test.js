'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { createReader, messagesFromUpdates } = require('../lib/reader');
const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const event = (kind, text, eventId, sessionId = id) => JSON.stringify({params:{sessionId,_meta:{eventId},update:{sessionUpdate:kind,content:{type:'text',text}}}});
test('complete messages survive beyond the terminal viewport without thoughts or tools', () => {
  const answer = Array.from({length:300},(_,i)=>`Paragraph ${i}: a complete sentence.\n\n`).join('');
  const lines = [event('user_message_chunk','Question','1'),event('agent_thought_chunk','PRIVATE THOUGHT','2'),event('tool_call','PRIVATE TOOL','3'),event('agent_message_chunk',answer.slice(0,200),'4'),event('agent_message_chunk',answer.slice(200),'5'),event('agent_message_chunk',answer.slice(200),'5'),event('agent_message_chunk','WRONG SESSION','6',other),'{"partial":'];
  assert.deepEqual(messagesFromUpdates(lines.join('\n'),id),[{id:'0',role:'user',text:'Question'},{id:'1',role:'assistant',text:answer}]);
});
test('tool and completed-turn boundaries separate assistant messages', () => {
  const text = [event('agent_message_chunk','Checking.','a'),event('tool_call','','b'),event('agent_message_chunk','Answer.','c'),event('turn_completed','','d'),event('user_message_chunk','Next','e')].join('\n');
  assert.deepEqual(messagesFromUpdates(text,id).map(m=>m.text),['Checking.','Answer.','Next']);
});
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(),'cockpit-reader-'));
  const project=path.join(home,'project');await fs.mkdir(project);
  const created=Date.now(), session={name:'grok-example-abcd',lane:'grok',project,created};
  const registry=[{pid:123,session_id:id,cwd:project,opened_at:new Date(created).toISOString()}];
  const file=path.join(home,'sessions',encodeURIComponent(project),id,'updates.jsonl');
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,event('agent_message_chunk','Full answer','1')+'\n');
  const save=()=>fs.writeFile(path.join(home,'active_sessions.json'),JSON.stringify(registry)); await save();
  const read=createReader({grokHome:home,paneIdentity:async()=>({pid:123})});
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  return {home,project,session,registry,file,save,read};
}
test('exact process and project binding reads full conversation and refreshes appended output',async t=>{
  const f=await fixture(t);assert.equal((await f.read(f.session)).messages[0].text,'Full answer');
  await fs.appendFile(f.file,event('agent_message_chunk',' continues','2')+'\n');
  assert.equal((await f.read(f.session)).messages[0].text,'Full answer continues');
});
test('wrong process, old registration and different project cannot select a conversation',async t=>{
  const f=await fixture(t);f.registry[0].pid=124;await f.save();assert.equal(await f.read(f.session),null);
  f.registry[0].pid=123;f.registry[0].opened_at=new Date(f.session.created-10000).toISOString();await f.save();assert.equal(await f.read(f.session),null);
  f.registry[0].opened_at=new Date().toISOString();f.registry[0].cwd=f.home;await f.save();assert.equal(await f.read(f.session),null);
});
test('ambiguous registry, invalid UUID and symlink targets fail closed',async t=>{
  const f=await fixture(t);f.registry.push({...f.registry[0],session_id:other});await f.save();assert.equal(await f.read(f.session),null);
  f.registry.pop();f.registry[0].session_id='../escape';await f.save();assert.equal(await f.read(f.session),null);
  f.registry[0].session_id=id;await f.save();await fs.rename(f.file,f.file+'.original');await fs.symlink(f.file+'.original',f.file);assert.equal(await f.read(f.session),null);
});
test('non-Grok sessions use the unchanged terminal fallback',async t=>{
  const f=await fixture(t);assert.equal(await f.read({...f.session,lane:'codex'}),null);
});

test('malformed complete records fail rather than presenting an incomplete conversation',()=>{
  assert.throws(()=>messagesFromUpdates('{broken}\n'+event('agent_message_chunk','Tail only','a'),id),/invalid record/);
});
