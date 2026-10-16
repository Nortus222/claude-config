import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProfilesView } from '../src/profiles-view.tsx';
import { UpstreamsView } from '../src/upstreams-view.tsx';
import { PublishView } from '../src/publish-view.tsx';
import { authorFixture, authorRun, draftPreview, draftId, draft } from './support/author.ts';

const render = (View: typeof PublishView, f: Awaited<ReturnType<typeof authorFixture>>) => renderToStaticMarkup(createElement(View,{state:f.controller.state,controller:f.controller}));
const publicationRun = (fields={}) => authorRun({kind:'publishDraft',draftId,digest:'b'.repeat(64)}, {state:'failed',result:{status:'needs-preview',message:'Main moved'},...fields});
test('a needs-preview outcome asks for a new preview',async t=>{
  const f=await authorFixture(t);f.controller.state={...f.controller.state,publicationRun:publicationRun(),draft};
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
  const html=render(ProfilesView,f);assert.match(html,/from base/i);assert.match(html,/repo text/);assert.match(html,/Update shared file/);assert.match(html,/Give this profile its own copy/);assert.match(html,/Affected profiles: base, team/);assert.doesNotMatch(html,/type="radio"[^>]*checked/);
});
test('GitHub prerequisite states have distinct wording and actions',async t=>{
  const f=await authorFixture(t);
  for(const [state,wording,action] of [['missing','GitHub CLI is not installed','Install GitHub CLI'],['signed-out','Not signed in to GitHub, or GitHub is unreachable','Sign in with GitHub'],['ready','Publishing uses your GitHub CLI sign-in','Ready']] as const){
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
  assert.match(html,new RegExp(`Issues in ${f.controller.state.selectedProfile}</h3>[\\s\\S]*Unknown skill source`));
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
  assert.match(render(PublishView, f), /<button[^>]*>Reload<\/button>[\s\S]*No access to https:\/\/github.com\/example\/setup.git/);
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
  assert.match(html, /<h1>Publish<\/h1>/); assert.doesNotMatch(html, /eyebrow/);
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
    assert.doesNotMatch(html, /eyebrow/);
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

test('a diff hidden by the shortened preview says so instead of claiming only a newline changed', async t => {
  const f = await previewed(t, { diff: [{ path: 'claude/CLAUDE.md', before: 'same start', after: 'same start', truncated: true }, { path: 'codex/AGENTS.md', before: 'a', after: 'a\n' }] });
  const text = words(render(PublishView, f));
  assert.match(text, /claude\/CLAUDE\.mdThe change is beyond the shortened preview\./);
  assert.equal(text.match(/Only the final newline changes\./g)?.length, 1);
});

test('a failed Cancel of a publication shows its error on the outcome card', async t => {
  const f = await authorFixture(t);
  const publishing = authorRun({ kind: 'publishDraft', draftId, digest: 'b'.repeat(64) }, { state: 'running', result: null });
  f.controller.state = { ...f.controller.state, run: publishing, publicationRun: publishing };
  f.handlers.cancelRun = () => { throw new Error('BUSY: The push is already in progress.'); };
  await f.controller.cancel();
  const html = render(PublishView, f);
  const card = /<section class="card" aria-label="Publication outcome">[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
  assert.match(card, />Cancel<\/button>[\s\S]*role="alert">The push is already in progress\.</);
  assert.equal(html.match(/The push is already in progress/g)?.length, 1);
});

test('Abandon on Publish asks once and names the run before abandoning', async t => {
  const f = await authorFixture(t);
  const interrupted = authorRun({ kind: 'deleteDraft', draftId }, { state: 'interrupted', result: { status: 'interrupted', message: 'Restarted' } });
  f.handlers.listRuns = () => ({ runs: [interrupted], nextBefore: null }); f.handlers.getRun = () => interrupted; await f.controller.reload();
  assert.equal(f.controller.state.run?.state, 'interrupted');
  await f.controller.abandon(); assert.equal(f.calls.some(c => c.name === 'abandonRun'), false);
  f.controller.askAbandon();
  const text = words(render(PublishView, f));
  assert.match(text, /Abandon “Delete draft”\? Its remaining steps won’t run\. Finished steps and backups are kept\./);
  f.controller.dismiss(); assert.equal(f.controller.state.confirming, null);
  f.controller.askAbandon();
  f.handlers.abandonRun = () => ({ ...interrupted, state: 'abandoned' });
  await f.controller.abandon();
  assert.equal(f.calls.filter(c => c.name === 'abandonRun').length, 1); assert.equal(f.controller.state.run?.state, 'abandoned');
  assert.equal(f.controller.state.confirming, null);
});
test('without a draft, Publish shows one quiet line and no Review or Publish button', async t => {
  const f = await authorFixture(t);
  const html = render(PublishView, f);
  assert.equal(f.controller.state.draft, null);
  assert.match(html, /No draft yet\. Include a skill, pin a source or capture a file to start one\./);
  for (const hidden of [/aria-label="Review and publish"/, />Publish<\/button>/, />Preview draft<\/button>/, />New draft<\/button>/, />Delete draft<\/button>/]) assert.doesNotMatch(html, hidden);
});
test('Profiles groups resolved skills by source with Included and Excluded status, excluded ones collapsed', async t => {
  const f = await authorFixture(t);
  const skills = [{ source: 'owner/a', name: 'tdd', included: true, from: 'skills-manifest.txt' }, { source: 'owner/b', name: 'grill', included: true, from: 'profiles/base.json' },
    { source: 'owner/a', name: 'old', included: false, from: 'skills-manifest.txt' }];
  const profiles = f.controller.state.profiles!;
  f.controller.state = { ...f.controller.state, profiles: { ...profiles, profiles: profiles.profiles.map(p => p.name === f.controller.state.selectedProfile ? { ...p, skills } : p) } };
  const html = render(ProfilesView, f), text = html.replace(/<[^>]+>/g, '\n');
  assert.match(text, /2 included · 1 excluded/);
  assert.match(text, /owner\/a\n+tdd\n+From skills-manifest\.txt\n+Included[\s\S]*owner\/b\n+grill\n+From profiles\/base\.json\n+Included/);
  assert.doesNotMatch(text, /\nold\n/, 'excluded skills stay collapsed until asked for');
  assert.match(html, /<button class="link" aria-pressed="false">Show 1 excluded skill<\/button>/);
  assert.doesNotMatch(html, /<code>owner\/a:tdd<\/code>/);
});
