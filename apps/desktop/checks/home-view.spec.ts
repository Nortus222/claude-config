import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HomeView } from '../src/home-view.tsx';
import { HomeController } from '../src/home-controller.ts';
import { SetupSyncController } from '../src/setup-sync-controller.ts';
import type { UpdateViewState } from '../src/update-controller.ts';
import type { MachineBusy, ViewState } from '../src/controller.ts';
import { fixture, review, run, status } from './support/setup-sync.ts';
import { authorRun, draft, draftId } from './support/author.ts';

// 28 incoming, 4 on hold, and 3 unchanged rows (overrides and pin siblings) that count as neither.
const rows = [...Array.from({ length: 32 }, (_, i) => ({ itemId: `skill:owner/repo/s${i}`, kind: 'skill' as const, change: 'changed' as const, held: i < 4, conflict: false })),
  ...Array.from({ length: 3 }, (_, i) => ({ itemId: `skill:owner/repo/u${i}`, kind: 'skill' as const, change: 'unchanged' as const, held: false, conflict: false }))];
const followed = { repoUrl: 'https://github.com/Nortus222/claude-config.git', profile: 'personal', setupId: null };
const published = authorRun({ kind: 'publishDraft', draftId, digest: 'b'.repeat(64) }, { runId: 'publish-run', state: 'succeeded',
  publication: { commit: 'c'.repeat(40), pushed: true, tagged: true, announced: [], pending: ['team'] } });
const noUpdate: UpdateViewState = { native: true, update: null, pending: false, retry: null, detail: '', deferred: false };
const item = (key: string, disposition: 'apply' | 'capture') => ({ key, domain: 'config' as const, label: key, group: 'Claude', state: 'drift', disposition });

async function home(t: test.TestContext, options: { followed?: boolean; update?: UpdateViewState; navigate?: (screen: string) => void; busy?: MachineBusy } = {}) {
  const f = await fixture();
  f.handlers.inspectProfiles = () => ({ followed: options.followed === false ? null : followed, available: [{ name: 'personal', extends: null }] });
  f.handlers.setupReview = () => review({ rows });
  f.handlers.listRuns = () => ({ runs: [run({ state: 'interrupted' }), published], nextBefore: null });
  f.handlers.drafts = () => ({ drafts: [draft, { ...draft, id: '00000000-0000-4000-8000-000000000002' }] });
  const changes = new SetupSyncController(f.bridge, f.machine);
  const controller = new HomeController(f.bridge, f.machine);
  t.after(() => { controller.dispose(); changes.dispose(); f.machine.dispose(); });
  await changes.reload(); await controller.refresh();
  const machine: ViewState = { ...f.machine.state, status: status({ counts: { pending: 0, held: 0, ready: 0, drift: 0 } }),
    inspection: { ...f.machine.state.inspection!, items: [item('setting:claude:settings.json#model', 'apply'), item('file:claude:CLAUDE.md', 'apply'), item('setting:claude:settings.json#theme', 'apply'), item('file:codex:AGENTS.md', 'capture'), item('file:claude:CLAUDE.md#x', 'capture')] } };
  if (options.busy) Object.assign(machine, { busy: options.busy });
  const render = () => renderToStaticMarkup(createElement(HomeView, { machine, changes: changes.state, home: controller.state, update: options.update ?? noUpdate,
    navigate: options.navigate ?? (() => {}), controller }));
  return { f, controller, render, calls: f.calls };
}

test('Home counts incoming rows from the review, not the status pending count', async t => {
  const html = (await home(t)).render();
  assert.match(html, /28 incoming changes/);
  assert.match(html, /4 on hold/);
  assert.doesNotMatch(html, /\b0 incoming/);
});

test('Home names the followed profile and its repository', async t => {
  assert.match((await home(t)).render(), /Following <strong>personal<\/strong> from <strong>Nortus222\/claude-config<\/strong>/);
});

test('Home says when this Mac follows no profile', async t => {
  assert.match((await home(t, { followed: false })).render(), /This Mac doesn(’|&#x27;)t follow a profile yet/);
});

test('Home lists changes waiting on this Mac and files changed here', async t => {
  const html = (await home(t)).render();
  assert.match(html, /3 changes waiting to apply on this Mac/);
  assert.match(html, /2 items changed on this Mac/);
});

test('an interrupted setup apply is named in words with Review and Abandon', async t => {
  const html = (await home(t)).render();
  assert.match(html, /Apply incoming changes was interrupted[\s\S]*>Review<\/button>[\s\S]*>Abandon<\/button>/);
});

test('an interrupted run on Home says why, without the agent\'s inspect advice', async t => {
  const h = await home(t);
  h.f.handlers.listRuns = () => ({ runs: [run({ state: 'interrupted', result: { status: 'interrupted', message: 'Agent stopped before the run finished; inspect before trying again' } })], nextBefore: null });
  await h.controller.refresh();
  const html = h.render();
  assert.match(html, /Apply incoming changes was interrupted\. <span class="row-sub">Agent stopped before the run finished\.<\/span>/);
  assert.doesNotMatch(html, /inspect/i);
});

test('Abandon asks for confirmation naming its effect before calling abandonRun', async t => {
  const h = await home(t);
  h.controller.confirmAbandon('setup-run');
  const html = h.render();
  assert.match(html, /Abandon “Apply incoming changes”\?/);
  assert.match(html, /won(’|&#x27;)t run/);
  assert.match(html, />Keep<\/button>/);
  assert.equal(h.calls.some(call => call.name === 'abandonRun'), false);
  await h.controller.abandon();
  assert.equal(h.calls.filter(call => call.name === 'abandonRun').length, 1);
  assert.doesNotMatch(h.render(), /was interrupted/);
});

test('Home lists drafts and a publication that was not announced', async t => {
  const html = (await home(t)).render();
  assert.match(html, /2 drafts not published[\s\S]*>Open Publish<\/button>/);
  assert.match(html, /Published, not announced[\s\S]*>Open Publish<\/button>/);
});

test('Home lists a ready app update', async t => {
  const update: UpdateViewState = { ...noUpdate, update: { installedVersion: '0.1.0', enabled: true, automaticChecks: true, phase: 'verified', availableVersion: '0.2.0', notes: null, downloadedBytes: 0, totalBytes: null, diagnostic: null } };
  assert.match((await home(t, { update })).render(), /App update 0\.2\.0 is ready to install[\s\S]*>Open Settings<\/button>/);
  assert.doesNotMatch((await home(t)).render(), /App update/);
});

test('every line has its own next action', async t => {
  const html = (await home(t)).render();
  for (const line of html.match(/<li class="home-line[^"]*">[\s\S]*?<\/li>/g) ?? []) assert.ok(/<button/.test(line), line);
});

test('Home never reads author profiles and shows no ISO times, IDs or JSON', async t => {
  const h = await home(t);
  h.controller.confirmAbandon('setup-run');
  const html = h.render();
  assert.equal(h.calls.some(call => call.name === 'authorProfiles'), false);
  assert.doesNotMatch(html, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  assert.doesNotMatch(html, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  assert.doesNotMatch(html, /setup-run|publish-run|[0-9a-f]{40}/);
  assert.doesNotMatch(html, /[{}[\]]|&quot;/);
  assert.doesNotMatch(html, /setupApply|publishDraft|interrupted<|skill:|setting:|file:/);
});

test('Review opens the screen that adopts the interrupted run; other kinds offer Abandon only', async t => {
  const h = await home(t);
  const interrupted = (runId: string, change: object) => ({ ...run({ runId, state: 'interrupted' }), intent: { ...run().intent, change } }) as ReturnType<typeof run>;
  h.controller.state = { ...h.controller.state, runs: [
    interrupted('reconcile-run', { kind: 'reconcile', only: ['skill:tdd'] }),
    interrupted('delete-run', { kind: 'deleteDraft', draftId }),
    interrupted('prune-run', { kind: 'pruneBackups' }),
  ] };
  const lines = h.render().match(/<li class="home-line[^"]*">[\s\S]*?<\/li>/g) ?? [];
  const line = (title: string) => lines.find(text => text.includes(`${title} was interrupted`)) ?? '';
  assert.match(line('Apply changes to this Mac'), />Review<\/button>[\s\S]*>Abandon<\/button>/);
  assert.match(line('Delete draft'), />Review<\/button>[\s\S]*>Abandon<\/button>/);
  assert.doesNotMatch(line('Remove old backups'), />Review<\/button>/); assert.match(line('Remove old backups'), />Abandon<\/button>/);
});

test('a busy Mac shows what it is doing, how far it is and the step in flight, with a way to Changes', async t => {
  const busy: MachineBusy = { kind: 'setupApply', description: 'Applying incoming changes from your profile', done: 12, total: 30, step: 'Install skill tdd from mattpocock/skills', runId: 'run' };
  const visited: string[] = [];
  const h = await home(t, { busy, navigate: screen => visited.push(screen) });
  const line = (h.render().match(/<li class="home-line[^"]*">[\s\S]*?<\/li>/g) ?? [])[0] ?? '';
  assert.match(line, /Applying incoming changes from your profile[\s\S]*12 of 30/);
  assert.match(line, /<progress[^>]*value="12" max="30"/);
  assert.match(line, /Install skill tdd from mattpocock\/skills[\s\S]*>Open Changes<\/button>/);
  const known = await home(t, { busy: { ...busy, done: null, total: null, step: null } });
  assert.doesNotMatch(known.render(), /<progress| of 30/);
});
