import test from 'node:test';
import assert from 'node:assert/strict';
import { flush, deferred } from './support/setup-sync.ts';

import { authorFixture, authorRun, draftPreview } from './support/author.ts';

test('including a skill adds an intent and shows it in the draft', async t=>{
  const f=await authorFixture(t); await f.controller.includeSkill('team','owner/repo','tdd',true);
  assert.deepEqual(f.controller.state.draft?.intents,[{kind:'includeSkill',profile:'team',source:'owner/repo',name:'tdd'}]);
  assert.equal(f.controller.state.preview,null);
});
test('Publish is disabled while any intent is invalid',async t=>{
  const f=await authorFixture(t); await f.controller.includeSkill('team','owner/repo','tdd',true);
  f.handlers.draftPreview=()=>draftPreview({invalid:[{index:0,reason:'Skill disappeared'}]}); await f.controller.previewDraft(); await f.controller.publish();
  assert.equal(f.controller.state.canPublish,false);
  assert.equal(f.calls.some(c=>c.name==='previewChange'&&c.input.change.kind==='publishDraft'),false);
});
test('Sign in shows gh\'s one-time code',async t=>{
  const f=await authorFixture(t); f.handlers.getRun=()=>authorRun({kind:'ghLogin'},{ghCode:{code:'ABCD-1234',url:'https://github.com/login/device'}});
  await f.controller.signIn();assert.equal(f.controller.state.run?.ghCode?.code,'ABCD-1234');
});
test('capture freezes machine text after an explicit shared or own-copy choice',async t=>{
  const f=await authorFixture(t); await f.controller.selectProfile('team');await f.controller.captureFile('claude:CLAUDE.md');
  assert.deepEqual(f.controller.state.capture?.affectedProfiles,['base','team']);
  assert.equal(f.calls.some(c=>c.name==='applyChange'),false);
  await f.controller.saveCapture({kind:'ownCopy',repoPath:'claude/team.md'});
  assert.deepEqual(f.controller.state.draft?.intents[0],{kind:'captureFile',profile:'team',fileId:'claude:CLAUDE.md',text:'machine text',choice:{kind:'ownCopy',repoPath:'claude/team.md'}});
});
test('oversized or absent machine files cannot be captured',async t=>{
  const f=await authorFixture(t);
  for(const fields of [{exists:true,truncated:true},{exists:false,truncated:false}]){
    f.handlers.machineFile=()=>({fileId:'claude:CLAUDE.md',text:'partial',...fields});await f.controller.captureFile('claude:CLAUDE.md');
    await f.controller.saveCapture({kind:'updateShared'}); assert.equal(f.controller.state.capture,null);assert.ok(f.controller.state.error);
  }
  assert.equal(f.calls.some(c=>c.name==='applyChange'),false);
});
test('disconnect fences late reads and reconnect uses getRun for pending sign-in',async t=>{
  const f=await authorFixture(t);await f.controller.signIn();const late=deferred<unknown>();f.handlers.authorFile=()=>late.promise;
  const reading=f.controller.selectFile('claude:CLAUDE.md'); f.emit({event:'disconnected',detail:'lost'});late.resolve({path:'old',text:'stale',truncated:false});await reading;
  assert.equal(f.controller.state.file,null);
  f.handlers.getRun=()=>authorRun({kind:'ghLogin'},{state:'interrupted',result:{status:'interrupted',message:'Restarted'}}); await f.reconnect();
  assert.equal(f.controller.state.run?.state,'interrupted');assert.equal(f.controller.state.preview,null);
});
test('only matching run events can refresh a receipt and older reads cannot replace newer ones',async t=>{
  const f=await authorFixture(t);await f.controller.signIn();const count=f.calls.length;
  f.emit({version:3,event:'operation-run',runId:'other'});await flush();assert.equal(f.calls.length,count);
  const late=deferred<unknown>();f.handlers.getRun=()=>late.promise;f.emit({version:3,event:'operation-run',runId:'author-run'});
  f.handlers.getRun=()=>authorRun({kind:'ghLogin'},{state:'succeeded',result:{status:'done',ok:1,failed:0}});f.emit({version:3,event:'operation-run',runId:'author-run'});await flush();
  late.resolve(authorRun());await flush();assert.equal(f.controller.state.run?.state,'succeeded');
});
test('maintenance discards publish previews and blocks draft writes',async t=>{
  let maintenance=false;const f=await authorFixture(t,{maintenance:()=>maintenance});await f.controller.includeSkill('team','owner/repo','tdd',true);await f.controller.previewDraft();
  assert.ok(f.controller.state.preview);maintenance=true;f.controller.refresh();const count=f.calls.length;await f.controller.publish();await f.controller.includeSkill('team','owner/repo','tdd',false);
  assert.equal(f.controller.state.preview,null);assert.equal(f.calls.length,count);
});

test('a lost Apply reply blocks further writes until runs are inspected', async t => {
  const f = await authorFixture(t); f.handlers.applyChange = () => { throw new Error('Reply lost'); };
  await f.controller.includeSkill('team', 'owner/repo', 'tdd', true);
  await f.controller.includeSkill('team', 'owner/repo', 'tdd', true);
  assert.equal(f.calls.filter(c => c.name === 'applyChange').length, 1);
  assert.match(f.controller.state.error ?? '', /not known whether it finished/);
});
test('draft selection waits for profiles when independent reads finish out of order', async t => {
  const f = await authorFixture(t); await f.controller.includeSkill('team', 'owner/repo', 'tdd', true);
  const profiles = f.controller.state.profiles!; f.controller.state = { ...f.controller.state, profiles: null, draft: null };
  const delayed = deferred<unknown>(); f.handlers.authorProfiles = () => delayed.promise;
  const loading = f.controller.reload(); await flush(); delayed.resolve(profiles); await loading;
  assert.equal(f.controller.state.draft?.intents.length, 1);
});
test('publish uses only the reviewed plan and a stale acceptance requires a fresh preview', async t => {
  const f = await authorFixture(t); await f.controller.includeSkill('team', 'owner/repo', 'tdd', true); await f.controller.previewDraft();
  const preview = f.controller.state.preview!; const planId = preview.planId;
  f.handlers.applyChange = () => ({ status: 'stale', preview });
  await f.controller.publish(); await f.controller.publish();
  assert.equal(f.calls.filter(c => c.name === 'applyChange').length, 2);
  assert.equal(f.calls.filter(c => c.name === 'applyChange').at(-1)?.input.planId, planId);
  assert.equal(f.controller.state.preview, null); assert.match(f.controller.state.message, /Needs preview/);
});
test('Re-check reads the original publication and Announce uses that run without publishing again', async t => {
  const f = await authorFixture(t);
  const { draftId } = await import('./support/author.ts');
  const run = authorRun({kind:'publishDraft',draftId,digest:'b'.repeat(64)}, {state:'interrupted',result:{status:'interrupted',message:'Push unknown'},publicationRecovery:{published:'unknown',action:'re-check'}});
  f.controller.state={...f.controller.state,publicationRun:run};
  f.handlers.getRun=()=>({...run,publicationRecovery:{published:true,action:'announce'},publication:{commit:'c'.repeat(40),pushed:true,tagged:false,pending:['team'],announced:[]}});
  await f.controller.recheck(); await f.controller.announce();
  assert.deepEqual(f.calls.filter(c=>c.name==='previewChange').at(-1)?.input.change,{kind:'announcePublication',runId:run.runId});
});
test('disposal fences in-flight replies and prevents any further agent requests',async t=>{
  const f=await authorFixture(t);const late=deferred<unknown>();f.handlers.authorFile=()=>late.promise;
  const reading=f.controller.selectFile('claude:CLAUDE.md');f.controller.dispose();const state=f.controller.state;const count=f.calls.length;
  late.resolve({path:'old',text:'stale',truncated:false});await reading;await f.controller.reload();await f.controller.signIn();
  assert.equal(f.controller.state,state);assert.equal(f.calls.length,count);
});

test('an interrupted sign-in can be re-previewed without automatically starting another login', async t => {
  const f = await authorFixture(t);
  f.controller.state = { ...f.controller.state, run: authorRun({kind:'ghLogin'}, {state:'interrupted', result:{status:'interrupted',message:'Restarted'}}) };
  await f.controller.repreview();
  assert.equal(f.controller.state.preview?.change.kind, 'ghLogin');
  assert.equal(f.calls.some(c=>c.name==='applyChange'), false);
  await f.controller.applyReviewed();
  assert.equal(f.controller.state.run?.state,'running');
});

test('a terminal draft receipt blocks the next edit until the saved draft has been read',async t=>{
  const f=await authorFixture(t);await f.controller.signIn();
  const delayed=deferred<unknown>();f.handlers.drafts=()=>delayed.promise;
  f.handlers.getRun=()=>authorRun({kind:'ghLogin'},{state:'succeeded',result:{status:'done',ok:1,failed:0}});
  f.emit({version:3,event:'operation-run',runId:'author-run'});await flush();
  assert.equal(f.controller.state.canWrite,false);
  delayed.resolve({drafts:[]});await flush();assert.equal(f.controller.state.canWrite,true);
});
test('a late run discovery cannot replace a new publication receipt',async t=>{
  const f=await authorFixture(t);await f.controller.includeSkill('team','owner/repo','tdd',true);await f.controller.previewDraft();
  const delayed=deferred<unknown>();f.handlers.listRuns=()=>delayed.promise;
  f.controller.enter();await flush();await f.controller.publish();
  delayed.resolve({runs:[authorRun({kind:'ghLogin'},{runId:'old',state:'interrupted',result:{status:'interrupted',message:'Old'}})],nextBefore:null});await flush();
  assert.equal(f.controller.state.run?.runId,'author-run');
});

test('Announce repairs a missing tag even when no profile announcements remain', async t => {
  const f=await authorFixture(t);const {draftId}=await import('./support/author.ts');
  f.controller.state={...f.controller.state,publicationRun:authorRun({kind:'publishDraft',draftId,digest:'b'.repeat(64)},{state:'succeeded',result:{status:'succeeded',message:'Tag pending'},publication:{commit:'c'.repeat(40),pushed:true,tagged:false,announced:[],pending:[]}})};
  await f.controller.announce();
  assert.equal(f.calls.filter(c=>c.name==='previewChange').at(-1)?.input.change.kind,'announcePublication');
});


test('finishing a publication refreshes the profile follow links', async t => {
  const f = await authorFixture(t);
  await f.controller.includeSkill('team', 'owner/repo', 'tdd', true);
  await f.controller.previewDraft();
  const profiles = f.controller.state.profiles!;
  f.handlers.authorProfiles = () => ({ ...profiles, profiles: profiles.profiles.map(profile => ({ ...profile, setupId: 'announced-setup' })) });
  f.handlers.getRun = () => authorRun({ kind: 'publishDraft', draftId: f.controller.state.draft!.id, digest: 'b'.repeat(64) }, { runId: 'new-publication', state: 'succeeded', result: { status: 'succeeded', message: 'Published and announced' } });
  f.handlers.applyChange = () => ({ status: 'started', run: f.handlers.getRun({}) });
  await f.controller.publish();
  assert.equal(f.controller.state.profiles?.profiles.find(profile => profile.name === 'team')?.setupId, 'announced-setup');
});


test('Retry re-reads the active sign-in run when its code arrives without an event', async t => {
  const f = await authorFixture(t);
  await f.controller.signIn();
  assert.equal(f.controller.snapshot().run?.ghCode, undefined);
  f.handlers.getRun = () => authorRun({ kind: 'ghLogin' }, { ghCode: { code: 'NEW1-CODE', url: 'https://github.com/login/device' } });
  await f.controller.reload();
  assert.equal(f.controller.state.run?.ghCode?.code, 'NEW1-CODE');
  assert.equal(f.calls.filter(call => call.name === 'applyChange').length, 1);
});

test('saving a capture blocked by another operation preserves it despite an older succeeded run', async t => {
  const f = await authorFixture(t);
  await f.controller.includeSkill('team', 'owner/repo', 'tdd', true);
  await f.controller.captureFile('claude:CLAUDE.md');
  const capture = f.controller.state.capture;
  f.machine.state = { ...f.machine.state, pending: true }; f.controller.refresh();
  const applies = f.calls.filter(call => call.name === 'applyChange').length;
  await f.controller.saveCapture({ kind: 'updateShared' });
  assert.equal(f.calls.filter(call => call.name === 'applyChange').length, applies);
  assert.equal(f.controller.state.capture, capture);
});

test('a capture remains when the returned receipt confirms a different draft change', async t => {
  const f = await authorFixture(t);
  await f.controller.captureFile('claude:CLAUDE.md');
  const capture = f.controller.state.capture;
  f.handlers.getRun = () => authorRun({ kind: 'ghLogin' }, { state: 'succeeded', result: { status: 'done', ok: 1, failed: 0 } });
  await f.controller.saveCapture({ kind: 'updateShared' });
  assert.equal(f.controller.state.capture, capture);
});

test('repository access errors leave drafts available and Retry can recover', async t => {
  const f = await authorFixture(t);
  const profiles = f.controller.state.profiles!;
  f.controller.state = { ...f.controller.state, profiles: null };
  f.handlers.authorProfiles = () => { throw Object.assign(new Error('No access to https://github.com/example/setup.git'), { code: 'UNAUTHORIZED' }); };
  f.handlers.drafts = () => ({ drafts: [{ id: '00000000-0000-4000-8000-000000000002', error: 'Unreadable draft' }] });
  await f.controller.reload();
  assert.equal(f.controller.state.errorCode, 'UNAUTHORIZED');
  assert.equal(f.controller.state.drafts.length, 1);
  f.handlers.authorProfiles = () => profiles;
  await f.controller.reload();
  assert.equal(f.controller.state.error, null);
  assert.equal(f.controller.state.profiles?.repoUrl, profiles.repoUrl);
});

test('deleting a corrupt draft removes it after its own successful receipt', async t => {
  const f = await authorFixture(t); let deleted = false;
  const id = '00000000-0000-4000-8000-000000000002';
  f.handlers.drafts = () => ({ drafts: deleted ? [] : [{ id, error: 'Unreadable draft' }] });
  f.handlers.applyChange = () => { deleted = true; return { status: 'started', run: authorRun({ kind: 'deleteDraft', draftId: id }, { state: 'succeeded', result: { status: 'done', ok: 1, failed: 0 } }) }; };
  f.handlers.getRun = () => authorRun({ kind: 'deleteDraft', draftId: id }, { state: 'succeeded', result: { status: 'done', ok: 1, failed: 0 } });
  await f.controller.reload(); await f.controller.deleteDraft(id);
  assert.deepEqual(f.controller.state.drafts, []);
  assert.deepEqual(f.calls.find(call => call.name === 'previewChange')?.input.change, { kind: 'deleteDraft', draftId: id });
});


test('run discovery pages past unrelated history to find the newest login and publication', async t => {
  const f = await authorFixture(t); const { run } = await import('./support/setup-sync.ts'); const { draftId } = await import('./support/author.ts');
  const login = authorRun({ kind: 'ghLogin' }, { runId: 'login', state: 'succeeded', result: { status: 'done', ok: 1, failed: 0 } });
  const published = authorRun({ kind: 'publishDraft', draftId, digest: 'b'.repeat(64) }, { runId: 'publication', state: 'succeeded', result: { status: 'succeeded', message: 'Published' } });
  f.handlers.listRuns = (input: any) => !input.before ? { runs: [run()], nextBefore: 'older' } : input.before === 'older'
    ? { runs: [login], nextBefore: 'oldest' } : { runs: [published], nextBefore: null };
  f.handlers.getRun = (input: any) => input.runId === 'login' ? login : published;
  await f.controller.reload();
  assert.equal(f.controller.state.run?.runId, 'login');
  assert.equal(f.controller.state.publicationRun?.runId, 'publication');
  assert.deepEqual(f.calls.filter(call => call.name === 'listRuns').slice(-3).map(call => call.input.before ?? null), [null, 'older', 'oldest']);
});

test('run discovery stops after five pages of unrelated history', async t => {
  const f = await authorFixture(t); const { run } = await import('./support/setup-sync.ts');
  const before = f.calls.filter(call => call.name === 'listRuns').length;
  f.handlers.listRuns = () => ({ runs: [run()], nextBefore: 'more' });
  await f.controller.reload();
  assert.equal(f.calls.filter(call => call.name === 'listRuns').length - before, 5);
});

test('a failed action is recorded so its error renders beside its button, and the next action clears it', async t => {
  const f = await authorFixture(t); await f.controller.includeSkill('team', 'owner/repo', 'tdd', true);
  f.handlers.draftPreview = () => { throw new Error('Main is unreachable'); };
  await f.controller.previewDraft();
  assert.equal(f.controller.state.failedAction, 'preview');
  f.handlers.draftPreview = () => draftPreview();
  await f.controller.previewDraft();
  assert.equal(f.controller.state.failedAction, null); assert.equal(f.controller.state.error, null);
});

test('finished runs leave no generic action status behind', async t => {
  const f = await authorFixture(t); await f.controller.includeSkill('team', 'owner/repo', 'tdd', true);
  assert.equal(f.controller.state.run?.state, 'succeeded');
  assert.equal(f.controller.state.message, '');
});

test('Publish and Delete ask first, and any other action dismisses the question', async t => {
  const f = await authorFixture(t); await f.controller.includeSkill('team', 'owner/repo', 'tdd', true); await f.controller.previewDraft();
  f.controller.askPublish(); assert.deepEqual(f.controller.state.confirming, { action: 'publish' });
  await f.controller.previewDraft(); assert.equal(f.controller.state.confirming, null);
  const id = f.controller.state.draft!.id;
  f.controller.askDelete(); assert.deepEqual(f.controller.state.confirming, { action: 'deleteDraft', draftId: id });
  f.controller.dismiss(); assert.equal(f.controller.state.confirming, null);
  f.controller.askDelete(); await f.controller.deleteDraft(id);
  assert.equal(f.controller.state.confirming, null);
  assert.deepEqual(f.calls.filter(c => c.name === 'previewChange').at(-1)?.input.change, { kind: 'deleteDraft', draftId: id });
});
