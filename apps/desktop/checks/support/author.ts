import type test from 'node:test';
import { AuthorController } from '../../src/author-controller.ts';
import { fixture, preview, run } from './setup-sync.ts';
import { decodeRunView, type OperationChange, type OperationOutput } from '@nortuscc/agent/operations';
export const draftId = '00000000-0000-4000-8000-000000000001';
export const repoUrl = 'https://github.com/example/setup.git';
export const draft = { version: 1 as const, id: draftId, repoUrl, createdAt: '2026-10-16T12:00:00.000Z', intents: [] as Extract<OperationChange, {kind:'editDraft'}>['intent'][] };
export const draftPreview = (fields = {}): OperationOutput<'draftPreview'> => ({ draftId, base: 'a'.repeat(40), digest: 'b'.repeat(64), diff: [{path:'profiles/team.json', before:'{}', after:'{"skills":[]}'}], invalid: [], affectedProfiles: ['team'], ...fields });
export const authorRun = (change: OperationChange = {kind:'ghLogin'}, fields = {}) => decodeRunView({ ...Object.fromEntries(Object.entries(run()).filter(([key]) => key !== 'parity')), runId:'author-run', intent: {requestId:'request',inputDigest:'a'.repeat(64),planId:'plan',change,
  parity: {kind:change.kind,generation:'1',baselineDigest:'a'.repeat(64),planDigest:'a'.repeat(64),plannedKeys:[],...(['publishDraft','announcePublication'].includes(change.kind)?{publication:{repoUrl,base:'a'.repeat(40),draftId,draftDigest:'b'.repeat(64),profiles:['team'],accountId:null},...(change.kind==='announcePublication'?{commit:'c'.repeat(40)}:{})}:{draftId})}}, ...fields });
export async function authorFixture(t: test.TestContext, options: {maintenance?:()=>boolean} = {}) {
  const f = await fixture(); let saved = {...draft, intents:[...draft.intents]}; let latest = authorRun();
  Object.assign(f.handlers, {
    authorProfiles: () => ({repoUrl,profiles:[{name:'base',extends:null,skills:[],files:[{fileId:'claude:CLAUDE.md',path:'claude/CLAUDE.md',from:'base'}]},
      {name:'team',extends:'base',skills:[],files:[{fileId:'claude:CLAUDE.md',path:'claude/CLAUDE.md',from:'base'}]}]}),
    authorFile: () => ({path:'claude/CLAUDE.md',text:'repo text',truncated:false}),
    machineFile: () => ({fileId:'claude:CLAUDE.md',exists:true,text:'machine text',truncated:false}),
    upstreams: () => ({sources:[{source:'owner/repo',inProfiles:[],pin:null,discovery:{kind:'complete',source:'owner/repo',commit:'a'.repeat(40),skills:[{name:'tdd',description:'Test first'}]}}]}),
    drafts: () => ({drafts:saved.intents.length?[saved]:[]}), draftPreview: () => draftPreview(), ghState: () => ({state:'ready'}),
    previewChange: (input: any) => preview({change:input.change,...(['editDraft','removeDraftIntent','deleteDraft','ghLogin'].includes(input.change.kind)?{draftId,draft:input.change.kind==='ghLogin'?null:draftPreview()}:{} )}),
    applyChange: () => {
      const change = f.calls.filter(c=>c.name==='previewChange').at(-1)!.input.change;
      if(change.kind==='editDraft') saved={...saved,intents:[...saved.intents,change.intent]};
      if(change.kind==='removeDraftIntent') saved={...saved,intents:saved.intents.filter((_,i)=>i!==change.index)};
      latest=authorRun(change,{state:change.kind==='ghLogin'?'running':'succeeded',result:change.kind==='ghLogin'?null:{status:'done',ok:1,failed:0}});
      return {status:'started',run:latest};
    },getRun:()=>latest,
  });
  const controller = new AuthorController(f.bridge,f.machine,options);
  t.after(()=>{controller.dispose();f.machine.dispose();}); await controller.reload();
  return {...f,controller};
}
