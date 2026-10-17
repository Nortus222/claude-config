import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeOperationInput,operationDefinitions} from '../src/operations/index.ts';
import {projectHistoryEvent} from '../src/operations/history.ts';

test('retention has strict bounded read and path-free change contracts',()=>{
 assert.ok('listBackups' in operationDefinitions);
 assert.equal(decodeOperationInput('listBackups',{limit:1}).limit,1);
 assert.deepEqual(decodeOperationInput('previewChange',{change:{kind:'pruneBackups'}}).change,{kind:'pruneBackups'});
 for(const input of [{limit:101},{limit:1,path:'/private'},{limit:1,cursor:'x'.repeat(513)}])assert.throws(()=>decodeOperationInput('listBackups',input));
 for(const extra of [{folderIds:['x']},{retentionDays:1},{path:'/private'}])assert.throws(()=>decodeOperationInput('previewChange',{change:{kind:'pruneBackups',...extra}}));
});
test('unknown and malformed History never reflect private fields',()=>{
 const base={at:'2026-10-15T00:00:00.000Z',actor:'mcp'};
 for(const raw of [{...base,kind:'future',message:'SECRET',runId:'SECRET',signInFlow:'SECRET'},{...base,kind:'decided',setupId:{token:'SECRET'},decision:'accept'},{...base,kind:'backups-pruned',folders:'SECRET'}]){
   assert.deepEqual(projectHistoryEvent(raw),{...base,kind:'unknown',message:'Unsupported historical event'});
 }
 assert.deepEqual(projectHistoryEvent({...base,kind:'decided',setupId:'setup',itemId:'skill:source/name',revision:2,commit:null,decision:'accept',token:'SECRET'}),{...base,kind:'decided',detail:{kind:'decision',setupId:'setup',itemId:'skill:source/name',revision:2,commit:null,choice:'accept'}});
});

import {Effect} from 'effect';
import {existsSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {Fs,FsFailed,HistoryStore} from '@nortuscc/machine';
import {startAgent,makeSession} from '../src/index.ts';
import {RunStore,RunStoreError} from '../src/run-store.ts';
import {operationDigest} from '../src/runs.ts';
import {agentMachine} from './support/agent-machine.ts';
const folder=(days:number)=>`nortuscc-${new Date(Date.UTC(2020,0,1)-days*86400000).toISOString().replace(/[:.]/g,'-')}`;
for(const mode of ['done','remove-two','receipt','history','pruned-history'] as const)test(`retention durable ${mode} preserves exact observed facts and same-request retry`,async()=>{
 const m=agentMachine();
 const names=Array.from({length:23},(_,i)=>folder(i));
 for(const id of names)mkdirSync(join(m.paths.backups,id),{recursive:true});
 try{await m.run(Effect.scoped(Effect.gen(function*(){
   const fs=yield* Fs,history=yield* HistoryStore,store=yield* RunStore;
   let removals=0,backupCopies=0,receiptFailed=false;
   const h=yield* startAgent(()=>m.domains,{deferStart:true});
   const session=yield* makeSession(h,{domains:()=>m.domains,signal:new AbortController().signal}).pipe(
    Effect.provideService(Fs,{...fs,copy:()=>{backupCopies++;return Effect.die('backup-of-backups')},remove:path=>Effect.suspend(()=>{assert.ok(existsSync(join(m.paths.stateRoot,'apply.lock')));removals++;return mode==='remove-two'&&removals===2?Effect.fail(new FsFailed({op:'remove',path,reason:'PRIVATE'})):fs.remove(path)})}),
    Effect.provideService(HistoryStore,{...history,append:event=>(mode==='history'&&removals>0 || mode==='pruned-history'&&event.kind==='backups-pruned')?Effect.fail(new FsFailed({op:'history',path:'PRIVATE',reason:'PRIVATE'})):history.append(event)}),
    Effect.provideService(RunStore,{...store,write:receipt=>mode==='receipt'&&receipt.view.parity?.committedKeys.length===1&&!receiptFailed?(receiptFailed=true,Effect.fail(new RunStoreError('disk full writing https://u:PRIVATE@h GITHUB_TOKEN=PRIVATE'))):store.write(receipt)}),
   );
   const first=yield* session.listBackups(decodeOperationInput('listBackups',{limit:1}));assert.equal(first.folders[0]?.id,names[0]);assert.ok(first.nextCursor);
   const second=yield* session.listBackups(decodeOperationInput('listBackups',{limit:1,cursor:first.nextCursor!}));assert.equal(second.folders[0]?.id,names[1]);
   const preview=yield* session.previewChange({kind:'pruneBackups'});assert.equal(preview.change.kind,'pruneBackups');
   if(preview.change.kind!=='pruneBackups'||!('retention' in preview))throw new Error('missing retention');
   assert.deepEqual(preview.retention.folderIds,names.slice(20));
   const request={planId:preview.planId,requestId:mode,inputDigest:operationDigest(preview.planId),actor:'mcp' as const};
   const accepted=yield* session.runs.submit(request);
   while(!(yield* session.runs.get(accepted.runId)).result)yield* Effect.yieldNow;
   while(yield* session.running)yield* Effect.yieldNow;
   const run=yield* session.runs.get(accepted.runId);
   assert.equal(run.state,mode==='done'?'succeeded':mode==='receipt'?'interrupted':'failed');
   assert.deepEqual(run.parity?.committedKeys,mode==='done'||mode==='pruned-history'?names.slice(20):[names[20]]);
   assert.equal(run.parity?.state,mode==='done'?'committed':'needsInspection');
   assert.equal(removals,mode==='done'||mode==='pruned-history'?3:mode==='remove-two'?2:1);assert.equal(backupCopies,0);
   const again=yield* session.runs.submit(request);assert.equal(again.runId,run.runId);
   assert.equal((yield* Effect.flip(session.listBackups(decodeOperationInput('listBackups',{limit:1,cursor:first.nextCursor!})))).code,'UNKNOWN_PLAN');
   assert.doesNotMatch(JSON.stringify(run),/PRIVATE|signInFlow|pendingId|userCode/);
   // The receipt failure's real cause reaches the run; its credential-shaped parts do not (PRIVATE above).
   if(mode==='receipt')assert.match(JSON.stringify(run.result),/Couldn't save the run record: disk full writing https:\/\/\[redacted\]h GITHUB_TOKEN=\[redacted\]/);
   const events=yield* history.read;
   if(mode!=='history'&&mode!=='pruned-history')assert.deepEqual(events.flatMap(e=>e.kind==='backups-pruned'?e.folders:[]),(mode==='done'?names.slice(20):[names[20]!]).map(id=>join(m.paths.backups,id)));
   const pending=run.parity?.remainingKeys??[];for(const id of pending)assert.ok(existsSync(join(m.paths.backups,id)));
   const restarted=yield* makeSession(h,{domains:()=>m.domains,signal:new AbortController().signal});
   const recovered=yield* restarted.runs.get(run.runId);assert.deepEqual(recovered.parity,run.parity);
   assert.equal((yield* restarted.runs.submit(request)).runId,run.runId);
   for(const id of pending)assert.ok(existsSync(join(m.paths.backups,id)));
 })));}finally{rmSync(m.root,{recursive:true,force:true})}
});

import {AgentClock} from '../src/clock.ts';
test('read cursors bind generation and in-flight reads refuse a changed observation',async()=>{
 const m=agentMachine();for(let i=0;i<2;i++)mkdirSync(join(m.paths.backups,folder(i)),{recursive:true});
 try{await m.run(Effect.scoped(Effect.gen(function*(){
  const h=yield* startAgent(()=>m.domains,{deferStart:true});let generation=0,mutate=false;
  const s=yield* makeSession({...h,generation:Effect.sync(()=>generation++)},{domains:()=>m.domains,signal:new AbortController().signal});
  assert.equal((yield* Effect.flip(s.listBackups(decodeOperationInput('listBackups',{limit:1})))).code,'UNKNOWN_PLAN');
  generation=0;
  const stable=yield* makeSession({...h,generation:Effect.sync(()=>generation)},{domains:()=>m.domains,signal:new AbortController().signal});
  const first=yield* stable.listBackups(decodeOperationInput('listBackups',{limit:1}));generation++;
  assert.equal((yield* Effect.flip(stable.listBackups(decodeOperationInput('listBackups',{limit:1,cursor:first.nextCursor!})))).code,'UNKNOWN_PLAN');
  const fs=yield* Fs;
  const racing=yield* makeSession({...h,generation:Effect.succeed(0)},{domains:()=>m.domains,signal:new AbortController().signal}).pipe(Effect.provideService(Fs,{...fs,list:path=>Effect.gen(function*(){
   const names=yield* fs.list(path);if(path===m.paths.backups&&!mutate){mutate=true;mkdirSync(join(m.paths.backups,folder(2)))}return names;
  })}));
  assert.equal((yield* Effect.flip(racing.listBackups(decodeOperationInput('listBackups',{limit:1})))).code,'UNKNOWN_PLAN');
 })));}finally{rmSync(m.root,{recursive:true,force:true})}
});

test('retention keeps the preview evaluation time when the clock crosses ninety days',async()=>{
 const m=agentMachine();let now=new Date('2026-10-15T00:00:00Z');
 const ids=Array.from({length:21},(_,i)=>`nortuscc-${new Date(now.getTime()-(i<20?i:90)*86400000).toISOString().replace(/[:.]/g,'-')}`);
 for(const id of ids)mkdirSync(join(m.paths.backups,id),{recursive:true});
 try{await m.run(Effect.scoped(Effect.gen(function*(){
  const h=yield* startAgent(()=>m.domains,{deferStart:true});
  const s=yield* makeSession(h,{domains:()=>m.domains,signal:new AbortController().signal});
  const preview=yield* s.previewChange({kind:'pruneBackups'});
  assert.ok('retention'in preview);if(!('retention'in preview))return;
  assert.deepEqual(preview.retention.folderIds,[]);now=new Date(now.getTime()+1);
  const accepted=yield* s.runs.submit({planId:preview.planId,requestId:'fixed-time',inputDigest:operationDigest(preview.planId),actor:'mcp'});
  while(!(yield* s.runs.get(accepted.runId)).result)yield* Effect.yieldNow;
  assert.equal((yield* s.runs.get(accepted.runId)).state,'succeeded');assert.ok(existsSync(join(m.paths.backups,ids[20]!)));
  while(yield* s.running)yield* Effect.yieldNow;
  const next=yield* s.previewChange({kind:'pruneBackups'});assert.ok('retention'in next&&next.retention.folderIds.includes(ids[20]!));
 })).pipe(Effect.provideService(AgentClock,{now:Effect.sync(()=>now),sleep:()=>Effect.never,random:Effect.succeed(.5)})));}finally{rmSync(m.root,{recursive:true,force:true})}
});
