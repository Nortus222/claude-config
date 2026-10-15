import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { rmSync } from 'node:fs';
import { decodeOperationInput, operationDefinitions } from '../src/operations/index.ts';
import { startAgent, makeSession, type AgentSession } from '../src/index.ts';
import { AgentStateStore } from '../src/state.ts';
import { operationDigest } from '../src/runs.ts';
import { agentMachine } from './support/agent-machine.ts';
import { setupFixture } from './support/setup-fixture.ts';

test('account and policy operations have strict bounded inputs and no pause, token or trust input', () => {
  assert.ok('agentStatus' in operationDefinitions);
  assert.ok('accountState' in operationDefinitions);
  for (const change of [{kind:'resume'}, {kind:'signIn'}, {kind:'signOut'}, {kind:'syncAccount'}, {kind:'setPolicy',policy:'manual'}, {kind:'patchMachineMetadata',patch:{name:'Work'}}])
    assert.deepEqual(decodeOperationInput('previewChange',{change}).change,change);
  for (const change of [{kind:'pause'}, {kind:'signIn',token:'secret'}, {kind:'patchMachineMetadata',patch:{}}, {kind:'patchMachineMetadata',patch:{trusted:true}}])
    assert.throws(()=>decodeOperationInput('previewChange',{change}));
  assert.throws(()=>decodeOperationInput('agentStatus',{section:'pending',limit:101}));
});
const submit = (s:AgentSession, planId:string, requestId:string) => Effect.gen(function* () {
  const request={planId,requestId,inputDigest:operationDigest(planId),actor:'mcp' as const};
  const accepted=yield* s.runs.submit(request);
  yield* Effect.callback<void>(resume=>{
    const off=s.runs.subscribe(accepted.runId,run=>{if(run.result)resume(Effect.void)});
    return Effect.sync(off);
  });
  while(yield* s.running)yield* Effect.yieldNow;
  return {run:yield* s.runs.get(accepted.runId),request};
});
test('local policy and resume use actual bodies, retain policy, and hosted operations require configuration',async()=>{
  const m=agentMachine(), f=setupFixture(m.root);
  try {await m.run(Effect.scoped(Effect.gen(function*(){
    const state=yield* AgentStateStore;
    const h=yield* startAgent(()=>m.domains,{deferStart:true});
    let scheduled=0;
    const s=yield* makeSession({...h,resume:()=>Effect.die('public wrapper'),setPolicy:()=>Effect.die('public wrapper'),request:trigger=>Effect.gen(function*(){yield* Effect.scoped(acquireApplyLock);scheduled++;return yield* h.request(trigger)}).pipe(Effect.provideService(MachinePaths,m.paths),Effect.orDie)},{domains:()=>m.domains,signal:new AbortController().signal});
    assert.equal((yield* s.accountState(decodeOperationInput('accountState',{section:'account'}))).enabled,false);
    for(const policy of ['manual','notify','auto-apply'] as const){
      const p=yield* s.previewChange({kind:'setPolicy',policy});
      assert.equal((yield* submit(s,p.planId,policy)).run.state,'succeeded');
      assert.equal((yield* state.read).policy,policy);
    }
    yield* state.update(v=>({...v,policy:'manual',paused:{at:'2026-10-15T00:00:00Z',reason:'fixture'}}));
    const p=yield* s.previewChange({kind:'resume'});
    assert.equal((yield* submit(s,p.planId,'resume')).run.state,'succeeded');
    assert.equal((yield* state.read).policy,'manual');assert.equal((yield* state.read).paused,null);
    assert.equal(yield* h.mutationBodies.resume('mcp'),false);
    while(scheduled<4)yield* Effect.yieldNow;
    const stalePolicy=yield* s.previewChange({kind:'setPolicy',policy:'notify'});
    yield* state.update(v=>({...v,policy:'auto-apply'}));
    assert.equal((yield* Effect.flip(s.runs.submit({planId:stalePolicy.planId,requestId:'stale-policy',inputDigest:operationDigest(stalePolicy.planId),actor:'mcp'}))).code,'UNKNOWN_PLAN');
    for(const kind of ['signIn','signOut','syncAccount'] as const)
      assert.equal((yield* Effect.flip(s.previewChange({kind}))).code,'APP_UNAVAILABLE');
  })),f.source);}finally{rmSync(m.root,{recursive:true,force:true})}
});

import { AgentClock } from '../src/clock.ts';
import { makeHostedRuntime } from '../src/hosted.ts';
import { HostedFailure, type HostedClient, type HostedState } from '@nortuscc/hosted-client';
import { RunStore, RunStoreError, type RunReceipt } from '../src/run-store.ts';
import { makeAgentRuns } from '../src/runs.ts';
import { acquireApplyLock, MachinePaths } from '@nortuscc/machine';
import type { AgentMutationBodies } from '../src/agent.ts';
import type { HostedRuntime } from '../src/hosted.ts';
type Equal<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;
const syncOwnerType:Equal<ReturnType<NonNullable<AgentMutationBodies['hosted']>['sync']>,HostedRuntime['sync']>=true;
const resumeOwnerType:Equal<Effect.Success<ReturnType<AgentMutationBodies['resume']>>,boolean>=true;
void syncOwnerType;void resumeOwnerType;
const baseState:HostedState={accountId:'account1',login:'person',machineId:'machine1',auth:'signed-in',setups:[],machine:{policy:'notify',reportStatus:true},confirmedMachine:{policy:'notify',reportStatus:true},machinePersistence:'confirmed',lastSyncAt:null,retryAt:'9999-01-01T00:00:00Z',pollAfter:900,error:null};
const fakeClient=(calls:string[],get:()=>HostedState,expiresIn=3600):HostedClient=>({
  state:Effect.sync(get),recover:()=>Effect.sync(get),sync:()=>Effect.sync(()=>{calls.push('sync');return get()}),revisions:()=>Effect.succeed([]),
  startSignIn:()=>Effect.sync(()=>{calls.push('signIn');return {userCode:'ABCD-EFGH',verificationUri:'https://github.com/login/device',interval:5,expiresIn}}),
  pollSignIn:()=>Effect.sync(()=>{calls.push('poll');return {status:'pending',pollAfter:5}}),signOut:()=>Effect.sync(()=>{calls.push('signOut')}),enqueueMachine:()=>Effect.void,enqueueDecision:()=>Effect.void,reportStatus:()=>Effect.void,
});
test('sign-in is initiation only, retries never restart it, expiry and scrub-save failure hide all public codes',async()=>{
  for(const failScrub of [false,true]){
    const m=agentMachine(),f=setupFixture(m.root),calls:string[]=[];
    let now=Date.parse('2026-10-15T00:00:00Z'),fail=false;
    const clock={now:Effect.sync(()=>new Date(now)),sleep:()=>Effect.never,random:Effect.succeed(.5)};
    try{await m.run(Effect.scoped(Effect.gen(function*(){
      const store=yield* RunStore;
      const runtime=yield* makeHostedRuntime(fakeClient(calls,()=>({...baseState,accountId:null,auth:'signed-out'}),failScrub?3600:120),{domains:()=>m.domains,os:'macos'});
      const h=yield* startAgent(()=>m.domains,{deferStart:true,hosted:runtime});
      const s=yield* makeSession(h,{domains:()=>m.domains,signal:new AbortController().signal}).pipe(Effect.provideService(RunStore,{read:store.read,write:r=>fail?Effect.fail(new RunStoreError('PRIVATE disk error')):store.write(r)}));
      const p=yield* s.previewChange({kind:'signIn',name:'Work',reportStatus:false});
      const {run,request}=yield* submit(s,p.planId,'sign-in');
      assert.equal(run.state,'succeeded');assert.equal(run.parity?.kind,'signIn');
      if(run.parity?.kind!=='signIn')throw new Error('missing sign in');
      assert.deepEqual(run.parity.signIn,{kind:'signIn',state:'awaiting-user',userCode:'ABCD-EFGH',verificationUri:'https://github.com/login/device',expiresAt:failScrub?'2026-10-15T00:15:00.000Z':'2026-10-15T00:02:00.000Z'});
      assert.equal((yield* s.runs.submit(request)).runId,run.runId);
      assert.equal(calls.filter(c=>c==='signIn').length,1);assert.equal(calls.includes('poll'),false);
      const account=yield* s.accountState(decodeOperationInput('accountState',{section:'account'}));
      assert.equal(account.section,'account');if(account.section==='account')assert.equal(account.items[0]?.auth,'signed-out');
      assert.doesNotMatch(JSON.stringify(yield* mHistory()),/ABCD-EFGH|nmt_|PRIVATE/);
      now+=failScrub?900000:120000;fail=failScrub;
      for(const view of [yield* s.runs.get(run.runId),(yield* s.runs.list({limit:10})).runs[0]!,yield* s.runs.submit(request)]){
        assert.doesNotMatch(JSON.stringify(view),/ABCD-EFGH|github.com\/login\/device|PRIVATE/);
        assert.equal(view.parity?.kind==='signIn'&&view.parity.signIn?.state,failScrub?'needsInspection':'expired');
      }
      fail=false;yield* s.runs.get(run.runId);
      assert.doesNotMatch(JSON.stringify(yield* store.read),/ABCD-EFGH|github.com\/login\/device/);
      assert.equal(calls.filter(c=>c==='signIn').length,1);
    })).pipe(Effect.provideService(AgentClock,clock)),f.source);}finally{rmSync(m.root,{recursive:true,force:true})}
  }
});
import { HistoryStore } from '@nortuscc/machine';
const mHistory=()=>HistoryStore.use(h=>h.read);

test('startup scrubs even completed unexpired initiation and a failed scrub cannot expose or replay it',async()=>{
  const m=agentMachine(),f=setupFixture(m.root),calls:string[]=[];
  const clock={now:Effect.succeed(new Date('2026-10-15T00:00:00Z')),sleep:()=>Effect.never,random:Effect.succeed(.5)};
  let saved:readonly RunReceipt[]=[];
  try{
    await m.run(Effect.scoped(Effect.gen(function*(){
      const runtime=yield* makeHostedRuntime(fakeClient(calls,()=>baseState),{domains:()=>m.domains,os:'macos'});
      const h=yield* startAgent(()=>m.domains,{deferStart:true,hosted:runtime}),s=yield* makeSession(h,{domains:()=>m.domains,signal:new AbortController().signal});
      const p=yield* s.previewChange({kind:'signIn'});yield* submit(s,p.planId,'restart');saved=yield* (yield* RunStore).read;
    })).pipe(Effect.provideService(AgentClock,clock)),f.source);
    for(const failed of [false,true]){
      let written:RunReceipt|undefined;
      await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
        const runs=yield* makeAgentRuns({now:clock.now,start:()=>Effect.die('must not replay'),cancel:()=>Effect.void});
        const prior=saved[0]!;
        for(const view of [yield* runs.get(prior.view.runId),(yield* runs.list({limit:10})).runs[0]!,yield* runs.submit({actor:prior.actor,planId:prior.view.intent.planId,requestId:prior.view.intent.requestId,inputDigest:prior.view.intent.inputDigest})]){
          assert.doesNotMatch(JSON.stringify(view),/ABCD-EFGH|github.com\/login\/device/);
          assert.equal(view.parity?.kind==='signIn'&&view.parity.signIn?.state,'needsInspection');
        }
      })).pipe(Effect.provideService(RunStore,{read:Effect.succeed(saved),write:r=>failed?Effect.fail(new RunStoreError('PRIVATE')):Effect.sync(()=>{written=r})})));
      if(!failed)assert.doesNotMatch(JSON.stringify(written),/ABCD-EFGH/);
    }
  }finally{rmSync(m.root,{recursive:true,force:true})}
});

test('hosted metadata queues under the shared lock, sync confirms only owner evidence, and stale accounts refuse',async()=>{
  const m=agentMachine(),f=setupFixture(m.root),calls:string[]=[];
  let state:HostedState={...baseState},failSync=true;
  const clock={now:Effect.succeed(new Date('2026-10-15T00:00:00Z')),sleep:()=>Effect.never,random:Effect.succeed(.5)};
  try{await m.run(Effect.scoped(Effect.gen(function*(){
    const client={...fakeClient(calls,()=>state),enqueueMachine:()=>Effect.gen(function*(){
      calls.push('machine');assert.equal((yield* Effect.result(Effect.scoped(acquireApplyLock)))._tag,'Failure');
      state={...state,machine:{policy:'manual',reportStatus:false},machinePersistence:'locally-queued'};
    }).pipe(Effect.provideService(MachinePaths,m.paths)),sync:()=>Effect.suspend(()=>{
      calls.push('sync');if(failSync)return Effect.fail(new HostedFailure({code:'network'}));
      state={...state,confirmedMachine:state.machine,machinePersistence:'confirmed'};return Effect.succeed(state);
    }),signOut:()=>Effect.fail(new HostedFailure({code:'network'}))};
    const runtime=yield* makeHostedRuntime(client,{domains:()=>m.domains,os:'macos'}),h=yield* startAgent(()=>m.domains,{deferStart:true,hosted:runtime});
    const s=yield* makeSession({...h,hosted:{...h.hosted!,machine:()=>Effect.die('public wrapper'),sync:()=>Effect.die('public wrapper')}},{domains:()=>m.domains,signal:new AbortController().signal});
    const staleQueue=yield* s.previewChange({kind:'patchMachineMetadata',patch:{name:'Work'}});
    state={...state,pendingMachinePatches:[{name:'Another queued name'}]};
    assert.equal((yield* Effect.flip(s.runs.submit({planId:staleQueue.planId,requestId:'stale-queue',inputDigest:operationDigest(staleQueue.planId),actor:'mcp'}))).code,'UNKNOWN_PLAN');
    assert.equal(calls.includes('machine'),false);
    const p=yield* s.previewChange({kind:'patchMachineMetadata',patch:{name:'Work',policy:'manual',reportStatus:false}});
    const {run}=yield* submit(s,p.planId,'metadata');assert.equal(run.state,'succeeded');assert.equal(run.parity?.kind==='patchMachineMetadata'&&run.parity.metadata,'locally-queued');
    const queued=yield* s.accountState(decodeOperationInput('accountState',{section:'machine'}));
    if(queued.section!=='machine')throw new Error('wrong section');assert.equal(queued.items[0]?.persistence,'locally-queued');assert.equal(queued.items[0]?.confirmed?.policy,'notify');
    let sync=yield* s.previewChange({kind:'syncAccount'});assert.equal((yield* submit(s,sync.planId,'offline')).run.state,'failed');assert.equal(state.machinePersistence,'locally-queued');
    failSync=false;sync=yield* s.previewChange({kind:'syncAccount'});const confirmed=yield* submit(s,sync.planId,'online');assert.equal(confirmed.run.state,'succeeded');assert.equal(confirmed.run.parity?.kind==='syncAccount'&&confirmed.run.parity.metadata,undefined);assert.equal(state.confirmedMachine?.policy,'manual');
    const stale=yield* s.previewChange({kind:'signOut'});state={...state,accountId:'account2'};
    assert.equal((yield* Effect.flip(s.runs.submit({planId:stale.planId,requestId:'stale',inputDigest:operationDigest(stale.planId),actor:'mcp'}))).code,'UNKNOWN_PLAN');
    const out=yield* s.previewChange({kind:'signOut'}),failed=yield* submit(s,out.planId,'out');assert.equal(failed.run.state,'failed');assert.deepEqual(failed.run.parity?.committedKeys,[]);
    assert.doesNotMatch(JSON.stringify(failed.run),/nmt_|token|network/);
  })).pipe(Effect.provideService(AgentClock,clock)),f.source);}finally{rmSync(m.root,{recursive:true,force:true})}
});

test('account reads bind section and observation cursors, reject unsafe owner data and generation changes',async()=>{
 const m=agentMachine(),f=setupFixture(m.root);
 let state={...baseState,setups:[{setupId:'setup1',name:'First',repoUrl:'https://github.com/owner/one',latestRevision:1},{setupId:'setup2',name:'Second',repoUrl:'https://github.com/owner/two',latestRevision:2}]};
 try{await m.run(Effect.scoped(Effect.gen(function*(){
  const h=yield* startAgent(()=>m.domains,{deferStart:true});
  let generation=0,reads=0,move=false;
  const wrapped={...h,generation:Effect.sync(()=>{if(move&&++reads===2)generation++;return generation}),hosted:{state:Effect.sync(()=>({...state,enabled:true as const,recovered:true,signingIn:false})),signIn:()=>Effect.die('unused'),signOut:()=>Effect.die('unused'),sync:()=>Effect.die('unused'),trust:()=>Effect.die('unused'),machine:()=>Effect.die('unused')}};
  const s=yield* makeSession(wrapped,{domains:()=>m.domains,signal:new AbortController().signal});
  const first=yield* s.accountState(decodeOperationInput('accountState',{section:'setups',limit:1}));assert.ok(first.nextCursor);
  const second=yield* s.accountState(decodeOperationInput('accountState',{section:'setups',limit:1,cursor:first.nextCursor!}));assert.equal(second.section==='setups'&&second.items[0]?.setupId,'setup2');
  yield* Effect.flip(s.accountState(decodeOperationInput('accountState',{section:'machine',cursor:first.nextCursor!})));
  state={...state,accountId:'account2'};assert.equal((yield* Effect.flip(s.accountState(decodeOperationInput('accountState',{section:'setups',cursor:first.nextCursor!})))).code,'UNKNOWN_PLAN');
  state={...state,login:'nmt_account1_machine1_'+ 's'.repeat(43)};
  assert.equal((yield* Effect.flip(s.accountState(decodeOperationInput('accountState',{section:'account'})))).code,'OVERSIZED');
  state={...state,login:'person'};
  for(const name of ['accountState','agentStatus'] as const){
    reads=0;move=true;
    const result=yield* Effect.result(name==='accountState'?s.accountState(decodeOperationInput(name,{section:'account'})).pipe(Effect.asVoid):s.agentStatus(decodeOperationInput(name,{section:'status'})).pipe(Effect.asVoid));
    assert.equal(result._tag,'Failure');if(result._tag==='Failure')assert.equal(result.failure.code,'UNKNOWN_PLAN');
  }
 })),f.source);}finally{rmSync(m.root,{recursive:true,force:true})}
});

import { Schema } from 'effect';
import { SignInRunResultSchema } from '../src/operations/index.ts';
test('sign-in display schemas bound the URI and forbid retained codes after expiry',()=>{
 const decode=Schema.decodeUnknownSync(SignInRunResultSchema,{onExcessProperty:'error'});
 const value={kind:'signIn',state:'awaiting-user',expiresAt:'2026-10-15T00:02:00Z',userCode:'ABCD',verificationUri:'https://github.com/login/device'};
 assert.doesNotThrow(()=>decode(value));
 assert.throws(()=>decode({...value,state:'expired'}));
 assert.throws(()=>decode({...value,verificationUri:'https://github.com/login/device'+' '.repeat(1000)}));
 assert.throws(()=>decode({...value,verificationUri:'https://example.com/login/device'}));
 assert.throws(()=>decode({...value,token:'nmt_private'}));
});
