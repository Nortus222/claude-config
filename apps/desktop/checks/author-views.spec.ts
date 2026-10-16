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
  const html=render(PublishView,f);assert.match(html,/ABCD-1234/);assert.match(html,/<button[^>]*>Open GitHub<\/button>/);assert.doesNotMatch(html,/<a /);
});
test('GitHub links open natively by fixed name, never as webview anchors',async t=>{
  const f=await authorFixture(t);const opened:unknown[]=[];const invoke=f.bridge.invoke;
  f.bridge.invoke=async(command,args)=>{if(command==='open_github_link'){opened.push(args);return {generation:1,data:{opened:true}};}return invoke(command,args);};
  f.controller.state={...f.controller.state,gh:{state:'missing'}};
  assert.match(render(PublishView,f),/<button[^>]*>Install GitHub CLI<\/button>/);
  await f.controller.openGitHub('installCli');await f.controller.openGitHub('deviceLogin');
  assert.deepEqual(opened,[{link:'installCli'},{link:'deviceLogin'}]);
  f.bridge.invoke=async()=>{throw 'Unable to open GitHub';};await f.controller.openGitHub('installCli');
  assert.equal(f.controller.state.error,'Unable to open GitHub');assert.equal(f.controller.state.failedAction,'openGitHub');
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
    f.controller.state={...f.controller.state,gh:{state},error:state==='missing'?'gh is not installed':null,errorCode:state==='missing'?'APP_UNAVAILABLE':null};
    const html=render(PublishView,f);assert.ok(html.includes(wording));assert.ok(html.includes(action));
  }
});

test('an author page shows the follow-first message when no repository is followed', async t => {
  const f = await authorFixture(t);
  f.controller.state = { ...f.controller.state, profiles: null, upstreams: null };
  f.handlers.authorProfiles = f.handlers.upstreams = () => {
    throw Object.assign(new Error('Follow your setup repository first'), { code: 'APP_UNAVAILABLE' });
  };
  await f.controller.reload();
  for (const View of [ProfilesView, UpstreamsView]) {
    const html = render(View, f);
    assert.match(html, /Follow your setup repository first/);
    assert.match(html, /Open Changes to follow a profile/);
    assert.doesNotMatch(html, /Check repository trust in Settings/);
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
test('profile issues read as text and the selected profile shows its own', async t => {
  const f = await authorFixture(t);
  const issue = (profile: string, message: string) => ({ profile, issues: [{ layer: 'profile' as const, source: `profiles/${profile}.json`, path: 'extends', message }] });
  f.controller.state = {...f.controller.state, profiles:{...f.controller.state.profiles!,issues:[issue('broken','Invalid parent'), issue(f.controller.state.selectedProfile,'Unknown skill source')]}};
  const html = render(ProfilesView,f);
  assert.doesNotMatch(html,/&quot;layer&quot;|\{&quot;/);
  assert.match(html,/broken<\/strong>: Invalid parent \(<code>extends<\/code>\)/);
  assert.match(html,new RegExp(`<h3>${f.controller.state.selectedProfile}</h3>[\\s\\S]*Unknown skill source`));
  assert.equal(html.match(/Unknown skill source/g)?.length, 1, 'the selected profile\'s issue is listed once, under it');
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


test('No access names the repository before profiles can be loaded and offers a reload', async t => {
  const f = await authorFixture(t);
  f.controller.state = { ...f.controller.state, profiles: null, error: 'No access to https://github.com/example/setup.git', errorCode: 'UNAUTHORIZED' };
  const html = render(ProfilesView, f);
  assert.match(html, /No access to https:\/\/github.com\/example\/setup.git/);
  assert.match(html, /<button[^>]*>Reload profiles<\/button>/);
  assert.match(render(PublishView, f), /No access to https:\/\/github.com\/example\/setup.git[\s\S]*<button[^>]*>Retry<\/button>/);
});

test('a corrupt draft has a Delete action beside its diagnostic', async t => {
  const f = await authorFixture(t);
  f.controller.state = { ...f.controller.state, drafts: [{ id: '00000000-0000-4000-8000-000000000002', error: 'Invalid JSON' }] };
  const html = render(PublishView, f);
  assert.match(html, /A saved draft can&#x27;t be read: Invalid JSON/);
  assert.doesNotMatch(html, /00000000-0000/);
  assert.match(html, /<button>Delete unreadable draft<\/button>/);
});

test('Retry shows a pending sign-in code without launching another login', async t => {
  const f = await authorFixture(t); await f.controller.signIn();
  f.handlers.getRun = () => authorRun({ kind: 'ghLogin' }, { ghCode: { code: 'NEW1-CODE', url: 'https://github.com/login/device' } });
  await f.controller.reload();
  const html = render(PublishView, f);
  assert.match(html, /NEW1-CODE/);
  assert.match(html, /<button>Retry<\/button>/);
  assert.doesNotMatch(html, /<button[^>]*>Sign in with GitHub<\/button>/);
});


test('truncated draft previews disclose that publication includes the full files', async t => {
  const f = await authorFixture(t); await f.controller.includeSkill('team', 'owner/repo', 'tdd', true);
  f.handlers.draftPreview = () => draftPreview({ truncated: true, diff: [{ path: 'claude/CLAUDE.md', before: 'old', after: 'partial', truncated: true }] });
  await f.controller.previewDraft();
  assert.match(render(PublishView, f), /Diff preview is truncated. Publication includes the full files./);
});

const words = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&');
const UUID_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const previewed = async (t: Parameters<typeof authorFixture>[0], fields = {}) => {
  const f = await authorFixture(t); await f.controller.includeSkill('team', 'owner/repo', 'tdd', true);
  f.handlers.draftPreview = () => draftPreview(fields); await f.controller.previewDraft();
  return f;
};

test('Publish is a screen that lists each changed item per profile in words', async t => {
  const f = await previewed(t, { items: [
    { profile: 'team', itemId: 'skill:mattpocock/skills/tdd', kind: 'skill', change: 'added' },
    { profile: 'base', itemId: 'setting:claude:settings.json#model', kind: 'setting', change: 'changed' },
    { profile: 'team', itemId: 'file:claude:CLAUDE.md', kind: 'file', change: 'removed' },
  ] });
  const html = render(PublishView, f), text = words(html);
  assert.match(html, /<p class="eyebrow">MY PROFILES<\/p><h1>Publish<\/h1>/);
  assert.match(text, /team: adds skill tdd from mattpocock\/skills/);
  assert.match(text, /base: changes Claude setting model/);
  assert.match(text, /team: removes Claude instructions \(CLAUDE\.md\)/);
  assert.doesNotMatch(html, /skill:mattpocock|setting:claude/);
});

test('a truncated item list says that publication includes every change', async t => {
  const f = await previewed(t, { itemsTruncated: true });
  assert.match(words(render(PublishView, f)), /Showing the first 1 changed item\. Publishing includes every change\./);
});

test('file changes are hunks inside a Files disclosure, never whole Before and After panes', async t => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
  const after = before.replace('line 10', 'line ten');
  const f = await previewed(t, { diff: [{ path: 'claude/CLAUDE.md', before, after }, { path: 'profiles/new.json', before: null, after: '{}' }] });
  const html = render(PublishView, f);
  assert.match(html, /<details[^>]*><summary>Files \(2\)<\/summary>/);
  assert.match(html, /-line 10/); assert.match(html, /\+line ten/);
  assert.match(html, /line 7/); assert.doesNotMatch(html, /line 6\b/);
  assert.match(words(html), /profiles\/new\.json \(new file\)/);
  assert.doesNotMatch(html, />Before<|>After<|aria-label="Before |aria-label="After /);
});

test('draft options name a relative date and a change count, never an ID', async t => {
  const f = await authorFixture(t); await f.controller.includeSkill('team', 'owner/repo', 'tdd', true);
  const createdAt = new Date(Date.now() - 2 * 3600_000).toISOString();
  const drafts = f.controller.state.drafts.map(d => 'intents' in d ? { ...d, createdAt } : d);
  f.controller.state = { ...f.controller.state, drafts, draft: drafts.find(d => 'intents' in d) as typeof f.controller.state.draft };
  const html = render(PublishView, f);
  assert.match(html, /<option value="[^"]+"[^>]*>Draft from 2 hours ago · 1 change<\/option>/);
  assert.doesNotMatch(words(html), UUID_TEXT);
});

test('Profiles and Upstreams have no publish panel and link to Publish from a draft line', async t => {
  const f = await authorFixture(t); await f.controller.includeSkill('team', 'owner/repo', 'tdd', true);
  for (const View of [ProfilesView, UpstreamsView]) {
    const html = renderToStaticMarkup(createElement(View, { state: f.controller.state, controller: f.controller, onOpenPublish: () => {} }));
    assert.doesNotMatch(html, /Publish panel|Preview draft|GitHub|Publication outcome/);
    assert.match(html, /Saved to draft · 1 change · <button[^>]*>Review and publish →<\/button>/);
    assert.match(html, /<p class="eyebrow">MY PROFILES<\/p>/);
    assert.doesNotMatch(render(View, f), /Review and publish/, 'no link without a Publish screen to open');
  }
});

test('Profiles names a running author action and a failed draft save in words, without run IDs', async t => {
  const f = await authorFixture(t);
  f.controller.state = { ...f.controller.state, run: authorRun({ kind: 'ghLogin' }, { state: 'running' }) };
  assert.match(render(ProfilesView, f), /Sign in to GitHub… <button[^>]*>Cancel<\/button>/);
  f.controller.state = { ...f.controller.state, run: authorRun({ kind: 'editDraft', draftId: null, intent: { kind: 'unpin', source: 'owner/repo' } }, { state: 'failed', result: { status: 'interrupted', message: 'Draft is locked' } }) };
  const html = render(ProfilesView, f);
  assert.match(html, /Save draft failed\. Draft is locked/);
  assert.doesNotMatch(html, /author-run/);
});

test('a preview error renders beside Preview, not at the top of the screen', async t => {
  const f = await authorFixture(t); await f.controller.includeSkill('team', 'owner/repo', 'tdd', true);
  f.handlers.draftPreview = () => { throw Object.assign(new Error('INTERNAL: Main is unreachable'), { code: 'INTERNAL' }); };
  await f.controller.previewDraft();
  const html = render(PublishView, f);
  assert.equal(html.match(/Main is unreachable/g)?.length, 1);
  assert.doesNotMatch(html, /INTERNAL/);
  const at = html.indexOf('Main is unreachable');
  assert.ok(at > html.indexOf('>Preview draft</button>') && at < html.indexOf('>Publish</button>'), 'the error follows Preview and precedes Publish');
  assert.doesNotMatch(html, /Action (succeeded|failed)/);
});

test('publishing asks once, naming the repository and the affected profiles', async t => {
  const f = await previewed(t, { affectedProfiles: ['base', 'team'] });
  f.controller.askPublish();
  const html = render(PublishView, f);
  assert.match(words(html), /Publish 1 change to example\/setup\? This pushes to main and updates base and team\./);
  assert.match(html, /<button class="primary">Confirm publish<\/button>/);
});

test('deleting a draft asks once and names the draft', async t => {
  const f = await authorFixture(t); await f.controller.includeSkill('team', 'owner/repo', 'tdd', true);
  f.controller.askDelete();
  const html = render(PublishView, f);
  assert.match(words(html), /Delete the draft from .+ with 1 change\? This can't be undone\./);
  assert.match(html, /<button[^>]*>Delete draft<\/button>[\s\S]*<button[^>]*>Keep draft<\/button>/);
});
test('an interrupted author run on Publish counts its effects and keeps the run ID and keys under Details', async t => {
  const f = await authorFixture(t);
  const interrupted = authorRun({ kind: 'deleteDraft', draftId }, { state: 'interrupted', result: { status: 'interrupted', message: 'Restarted' },
    parity: { kind: 'deleteDraft', state: 'partial', committedKeys: ['draft:written-key'], remainingKeys: ['draft:remaining-key'], backupIds: ['backup-author'] } });
  f.controller.state = { ...f.controller.state, run: interrupted };
  const html = render(PublishView, f), visible = html.replace(/<details[\s\S]*?<\/details>/g, '');
  assert.match(visible, /Delete draft was interrupted/); assert.match(visible, /1 change was written and 1 was not/);
  assert.doesNotMatch(visible, /author-run|draft:written-key|draft:remaining-key|backup-author/);
  for (const text of ['author-run', 'draft:written-key', 'draft:remaining-key']) assert.ok(html.includes(text), text);
});
