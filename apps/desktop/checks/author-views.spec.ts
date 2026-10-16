import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProfilesView } from '../src/profiles-view.tsx';
import { UpstreamsView } from '../src/upstreams-view.tsx';
import { PublishView } from '../src/publish-view.tsx';
import { authorFixture, authorRun, draftPreview, draftId } from './support/author.ts';

const render = (View: typeof PublishView, f: Awaited<ReturnType<typeof authorFixture>>) => renderToStaticMarkup(createElement(View,{state:f.controller.state,controller:f.controller}));
const publicationRun = (fields={}) => authorRun({kind:'publishDraft',draftId,digest:'b'.repeat(64)}, {state:'failed',result:{status:'needs-preview',message:'Main moved'},...fields});
test('a needs-preview outcome asks for a new preview',async t=>{
  const f=await authorFixture(t);f.controller.state={...f.controller.state,publicationRun:publicationRun()};
  const html=render(PublishView,f);assert.match(html,/Needs preview/);assert.match(html,/>Preview draft</);assert.doesNotMatch(html,/>Published</);
});
test('a published but unannounced run offers Announce',async t=>{
  const f=await authorFixture(t);f.controller.state={...f.controller.state,publicationRun:publicationRun({result:{status:'done',ok:1,failed:0},publication:{commit:'c'.repeat(40),pushed:true,tagged:false,announced:[],pending:['team'],unannounceable:[{profile:'team',reason:'Account unavailable'}]},publicationRecovery:{published:true,action:'announce'}})};
  const html=render(PublishView,f);assert.match(html,/Published, not yet announced/);assert.match(html,/>Announce</);assert.match(html,/Can&#x27;t announce: Account unavailable/);
});
test('uncertain pushes offer Re-check without claiming publication',async t=>{
  const f=await authorFixture(t);f.controller.state={...f.controller.state,publicationRun:publicationRun({publicationRecovery:{published:'unknown',action:'re-check'}})};
  const html=render(PublishView,f);assert.match(html,/Push outcome unknown/);assert.match(html,/>Re-check</);assert.doesNotMatch(html,/>Published</);
});
test('Sign in shows gh\'s one-time code and an Open GitHub link',async t=>{
  const f=await authorFixture(t);f.handlers.getRun=()=>authorRun({kind:'ghLogin'},{ghCode:{code:'ABCD-1234',url:'https://github.com/login/device'}});await f.controller.signIn();
  const html=render(PublishView,f);assert.match(html,/ABCD-1234/);assert.match(html,/<a[^>]*href="https:\/\/github.com\/login\/device"[^>]*>Open GitHub<\/a>/);
});
test('an unavailable source shows that its list could not be read and offers no checkboxes',async t=>{
  const f=await authorFixture(t);f.handlers.upstreams=()=>({sources:[{source:'owner/repo',inProfiles:['team'],pin:null,discovery:{kind:'unavailable',source:'owner/repo',reason:'unparseable'}}]});await f.controller.reload();
  const html=render(UpstreamsView,f);assert.match(html,/Couldn&#x27;t read this source&#x27;s skill list/);assert.doesNotMatch(html,/type="checkbox"/);
});
test('invalid draft intents disable Publish and show their reasons alongside plain-text diffs',async t=>{
  const f=await authorFixture(t);await f.controller.includeSkill('team','owner/repo','tdd',true);f.handlers.draftPreview=()=>draftPreview({invalid:[{index:0,reason:'Skill disappeared'}],diff:[{path:'file',before:null,after:'<script>alert(1)</script>'}]});await f.controller.previewDraft();
  const html=render(PublishView,f);assert.match(html,/<button[^>]*disabled=""[^>]*>Publish<\/button>/);assert.match(html,/Skill disappeared/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
});
test('profiles show origins, read-only text and an unselected capture choice with affected profiles',async t=>{
  const f=await authorFixture(t);await f.controller.selectProfile('team');await f.controller.selectFile('claude:CLAUDE.md');await f.controller.captureFile('claude:CLAUDE.md');
  const html=render(ProfilesView,f);assert.match(html,/From base/);assert.match(html,/repo text/);assert.match(html,/Update shared file/);assert.match(html,/Give this profile its own copy/);assert.match(html,/Affected profiles: base, team/);assert.doesNotMatch(html,/type="radio"[^>]*checked/);
});
test('GitHub prerequisite states have distinct wording and actions',async t=>{
  const f=await authorFixture(t);
  for(const [state,wording,action] of [['missing','GitHub CLI is not installed','Install GitHub CLI'],['signed-out','Not signed in to GitHub, or GitHub is unreachable','Sign in with GitHub'],['ready','GitHub is ready','Retry']] as const){
    f.controller.state={...f.controller.state,gh:{state}};const html=render(PublishView,f);assert.ok(html.includes(wording));assert.ok(html.includes(action));
  }
});

test('Profiles and Upstreams remain keyboard navigation destinations', async () => {
  const { ShellView } = await import('../src/views.tsx');
  const html = renderToStaticMarkup(createElement(ShellView, {screen:'profiles',navigate:()=>{},children:null}));
  assert.match(html, /<button aria-current="page">Profiles<\/button>/);
  assert.match(html, /<button>Upstreams<\/button>/);
});
test('valid profiles remain visible beside per-profile diagnostics', async t => {
  const f = await authorFixture(t);
  f.controller.state = {...f.controller.state, profiles:{...f.controller.state.profiles!,issues:[{profile:'broken',issues:[{layer:'profile',source:'profiles/broken.json',path:'extends',message:'Invalid parent'}]}]}};
  const html = render(ProfilesView,f);
  assert.match(html,/Invalid parent/);assert.match(html,/<option value="base"[^>]*>base<\/option>/);
});
test('a succeeded run without push evidence does not claim publication', async t => {
  const f = await authorFixture(t);
  f.controller.state = {...f.controller.state,publicationRun:publicationRun({state:'succeeded',result:{status:'done',ok:1,failed:0}})};
  const html = render(PublishView,f);assert.match(html,/Push is not confirmed/);assert.doesNotMatch(html,/>Published</);
});


test('profile resolution failures disable Publish and show the profile reason', async t => {
  const f = await authorFixture(t); await f.controller.includeSkill('team', 'owner/repo', 'tdd', true);
  f.handlers.draftPreview = () => draftPreview({ invalid: [{ index: null, profile: 'other', reason: 'other: missing parent profile' }] });
  await f.controller.previewDraft();
  const html = render(PublishView, f);
  assert.match(html, /other: missing parent profile/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Publish<\/button>/);
});

test('an announced profile shows its follow link and a Copy button', async t => {
  const f = await authorFixture(t);
  f.controller.state = { ...f.controller.state, profiles: { ...f.controller.state.profiles!, profiles: f.controller.state.profiles!.profiles.map(profile => ({ ...profile, setupId: profile.name === 'team' ? 'team-setup' : null })) } };
  await f.controller.selectProfile('team');
  const html = render(ProfilesView, f);
  assert.match(html, /nortuscc:\/\/follow\/team-setup/);
  assert.match(html, /<button[^>]*aria-label="Copy follow link for team"[^>]*>Copy<\/button>/);
  await f.controller.selectProfile('base');
  assert.doesNotMatch(render(ProfilesView, f), /nortuscc:\/\/follow\//);
});
