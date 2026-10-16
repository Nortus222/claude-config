import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SetupSyncView } from '../src/setup-sync-view.tsx';
import { SetupSyncController } from '../src/setup-sync-controller.ts';
import { fixture, review, run, localItems, localRun, flush } from './support/setup-sync.ts';

async function page(t: test.TestContext, prepare: (f: Awaited<ReturnType<typeof fixture>>) => void = () => {}) {
  const f = await fixture(); prepare(f);
  const c = new SetupSyncController(f.bridge, f.machine); t.after(() => { c.dispose(); f.machine.dispose(); });
  if (f.report.items.length) await f.machine.inspect();
  await c.reload();
  return { ...f, c, html: (props: { onOpenProfiles?: () => void } = {}) => renderToStaticMarkup(createElement(SetupSyncView, { state: c.state, controller: c, ...props })) };
}
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(match => match[1]!);
// Buttons that start a change: the page has exactly one, inside the top preview panel.
const applyButtons = (html: string) => buttons(html).filter(text => /^(Apply|Switch to|Follow |Hold \d)/.test(text));
const panel = (html: string) => /<section class="card changes-preview"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
const details = (html: string) => html.slice(html.indexOf('<details class="changes-details"'));
// What a reader sees or hears outside Details: text and accessible names.
const outsideDetails = (html: string) => {
  const visible = html.replace(/<details class="(changes-details|run-details)"[\s\S]*?<\/details>/g, '');
  return [...visible.matchAll(/aria-label="([^"]*)"/g)].map(match => match[1]).join('\n') + '\n' + visible.replace(/<[^>]+>/g, '\n');
};
const followProfiles = (f: Awaited<ReturnType<typeof fixture>>) => {
  f.handlers.inspectProfiles = () => ({ followed: { repoUrl: 'https://github.com/example/profiles.git', profile: 'default', setupId: null }, available: [{ name: 'default', extends: null }, { name: 'team', extends: 'default' }] });
};

test('Changes shows accessible values and warns that unchosen incoming items will be held', async t => {
  const { html } = await page(t); const text = html();
  assert.match(text, /<p class="eyebrow">THIS MAC<\/p><h1>Changes<\/h1>/);
  assert.match(text, /aria-label="Current value of /); assert.match(text, /aria-label="Offered value of /); assert.match(text, /mine/);
  assert.match(text, /Items you don&#x27;t choose will be held/); assert.deepEqual(applyButtons(text), []);
  assert.match(text, /keep this Mac&#x27;s override/); assert.match(text, /backed up first/);
});
test('pin-group refusal is rendered beside its source and unchanged siblings remain selectable', async t => {
  const { c, html, handlers } = await page(t, f => { f.handlers.setupReview = () => review({ rows: [{ itemId: 'skill:owner/repo/a', kind: 'skill', change: 'unchanged', held: false, conflict: false }], pinGroups: [{ source: 'owner/repo', itemIds: ['skill:owner/repo/a', 'skill:owner/repo/b'] }] }); });
  c.choose({ itemId: 'skill:owner/repo/a', action: 'accept' });
  handlers.previewChange = () => { throw new Error('Choices for owner/repo must match: its items share one pin.'); }; await c.preview();
  const text = html();
  assert.match(text, /<fieldset[^>]*class="setup-sync-pin"[\s\S]*owner\/repo[\s\S]*role="alert"/); assert.match(text, /Unchanged/); assert.match(text, /1 not on this page/);
  assert.match(text, /Skill <strong>b<\/strong> from owner\/repo/);
});

test('a failed Preview is reported beside the Preview button, not at the top of the page', async t => {
  const { c, html, handlers } = await page(t); c.choose({ itemId: 'setting:a', action: 'accept' });
  handlers.previewChange = () => { throw 'INSPECT_FAILED: Reading the setup timed out after 20 seconds; try again'; }; await c.preview();
  assert.equal(c.state.error, null); assert.match(c.state.previewError ?? '', /timed out/);
  const text = html();
  assert.match(text, />Preview<\/button>[\s\S]*role="alert"[^>]*>Reading the setup timed out/); assert.doesNotMatch(text, /INSPECT_FAILED/);
  assert.doesNotMatch(text.slice(0, text.indexOf('setup-sync-summary')), /role="alert"/);
  c.choose({ itemId: 'setting:a', action: 'hold' }); assert.equal(c.state.previewError, null);
});

test('Changes offers take all, hold all and one control per pin group, and hides groups absent from the page', async t => {
  const { html } = await page(t, f => { f.handlers.setupReview = () => review({ rows: [{ itemId: 'skill:owner/repo/one', kind: 'skill', change: 'changed', held: false, conflict: false, before: 'a', after: 'b' }],
    pinGroups: [{ source: 'owner/repo', itemIds: ['skill:owner/repo/one'] }, { source: 'cursor/plugins', itemIds: ['skill:cursor/plugins/x'] }] }); });
  const text = html();
  assert.match(text, />Take all incoming</); assert.match(text, />Hold all incoming</);
  assert.match(text, /<fieldset[^>]*class="setup-sync-pin"[\s\S]*owner\/repo[\s\S]*>Take this group<[\s\S]*>Hold this group</);
  assert.doesNotMatch(text, /cursor\/plugins/);
});

test('the incoming preview sits at the top, lists each staged action and holds the one Apply', async t => {
  const { c, html } = await page(t); c.choose({ itemId: 'setting:a', action: 'takeTheirs' }); c.choose({ itemId: 'setting:b', action: 'hold' }); await c.preview();
  const text = html(), top = panel(text);
  assert.ok(text.indexOf('changes-preview') < text.indexOf('setup-sync-summary'));
  assert.match(top, /aria-label="Reviewed choices"[\s\S]*Use your profile/);
  assert.match(top, /Items you don&#x27;t choose will be held/);
  assert.deepEqual(applyButtons(text), ['Apply 1 incoming change']); assert.match(top, />Cancel<\/button>/);
});

test('a switch preview sits at the top with one Switch to team, keeps the select on team, no hold notice and no empty dropped lists', async t => {
  const { c, html, handlers } = await page(t, followProfiles);
  handlers.previewChange = input => ({ planId: 'plan', scope: { kind: 'machine' }, generation: '1', change: input.change, plan: { kind: 'operation', steps: [], skipped: [] }, nextActions: [], droppedChoices: { holds: [], overrides: [] }, actionEffects: ['Inspect only'] });
  await c.switchProfile('team');
  const text = html(), top = panel(text);
  assert.ok(text.indexOf('changes-preview') < text.indexOf('setup-sync-summary'));
  assert.match(top, /Switch this Mac to team/); assert.deepEqual(applyButtons(text), ['Switch to team']);
  assert.match(text, /<option value="team" selected="">team<\/option>/);
  assert.doesNotMatch(top, /held|Holds|Overrides/);
});

test('a switch preview names the dropped holds and overrides before its Apply', async t => {
  const { c, html, handlers } = await page(t, followProfiles);
  handlers.previewChange = input => ({ planId: 'plan', scope: { kind: 'machine' }, generation: '1', change: input.change, plan: { kind: 'operation', steps: [], skipped: [] }, nextActions: [], droppedChoices: { holds: ['skill:owner/repo/old'], overrides: ['skills.old'] }, actionEffects: ['Inspect only'] });
  await c.switchProfile('team');
  const text = html();
  assert.match(text, /Following default from https:\/\/github.com\/example\/profiles.git/);
  assert.match(text, /Profile/); assert.match(text, /Follow a shared link/);
  assert.ok(text.indexOf('Skill <strong>old</strong> from owner/repo') < text.indexOf('>Switch to team<'));
  assert.match(panel(text), /Overrides removed[\s\S]*Skill old/);
});

test('a stale Apply shows the updated plan with its notice', async t => {
  const { c, html, handlers } = await page(t); c.choose({ itemId: 'setting:a', action: 'accept' }); await c.preview();
  const fresh = { ...c.state.preview!, planId: 'fresh' }; handlers.applyChange = () => ({ status: 'stale', preview: fresh }); await c.apply();
  const top = panel(html());
  assert.match(top, /This Mac changed. Review the updated plan./); assert.deepEqual(applyButtons(top), ['Apply 1 incoming change']);
});

test('On this Mac lists items to apply with checkboxes, previews them, and keeps one Apply', async t => {
  const { c, html } = await page(t, f => { f.report.items = localItems(); });
  let text = html();
  assert.match(text, /2 changes waiting to apply on this Mac/);
  assert.match(text, /<input type="checkbox" aria-label="Include Claude setting model" checked=""/);
  assert.match(text, /Skill <strong>tdd<\/strong> from mattpocock\/skills/);
  c.toggleLocal('skill:tdd'); await c.previewLocal(); text = html();
  assert.match(panel(text), /Apply 1 change to this Mac/); assert.deepEqual(applyButtons(text), ['Apply 1 change to this Mac']);
  assert.doesNotMatch(panel(text), /held/);
});

test('capture items read Changed on this Mac, with Open Profiles only when offered', async t => {
  const { html } = await page(t, f => { f.report.items = localItems(); });
  const plain = html();
  assert.match(plain, /Changed on this Mac/); assert.match(plain, /Claude instructions \(<strong>CLAUDE.md<\/strong>\)/);
  assert.doesNotMatch(plain, />Open Profiles</);
  assert.match(plain, /Can’t be applied[\s\S]*Integration <strong>browser<\/strong>[\s\S]*Another browser server is configured by hand/);
  assert.match(html({ onOpenProfiles: () => {} }), /<button[^>]*>Open Profiles<\/button>/);
});

test('Details lists every inspected item with its layer and source, the repository, short revision, issues and probe failures', async t => {
  const { html } = await page(t, f => {
    f.report.items = localItems(); f.report.profile.revision = '0123456789abcdef0123';
    f.report.profile.issues = [{ layer: 'profile', source: 'personal', path: 'skills[2]', message: 'unknown skill source' }];
    f.report.probeErrors = ['config: could not read settings.json; check file access and permissions'];
  });
  const text = html(), inside = details(text);
  for (const item of localItems()) {
    assert.ok(inside.includes(`<code>${item.key}</code>`), item.key);
    assert.ok(inside.includes(`${item.from.layer} · ${item.from.source}`), item.key);
  }
  assert.match(inside, /<code>\/repo<\/code>/); assert.match(inside, /<code>0123456789ab<\/code>/); assert.doesNotMatch(inside, /0123456789abcdef/);
  assert.match(inside, /personal: skills\[2\], unknown skill source/); assert.match(inside, /could not read settings.json/);
  assert.match(text.slice(0, text.indexOf('changes-details')), /Your profile has 1 problem/);
});

test('outside Details there are no IDs, raw keys, run states or ISO times', async t => {
  const runId = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
  const { c, html, handlers } = await page(t, f => { f.report.items = localItems(); });
  handlers.applyChange = () => ({ status: 'started', run: run({ runId, state: 'succeeded', abandonedAt: '2026-10-16T12:00:00.000Z', steps: [{ key: 'setting:a', outcome: 'ok', note: 'Machine effect observed' }], result: { status: 'done', ok: 1, failed: 0 } }) });
  c.choose({ itemId: 'setting:a', action: 'accept' }); await c.preview(); await c.apply(); await flush();
  await c.previewLocal();
  const text = html(), seen = outsideDetails(text);
  assert.ok(c.state.run && c.state.preview);
  assert.match(seen, /Apply incoming changes/); assert.match(seen, /1 change applied/);
  for (const raw of [/Run succeeded/, /succeeded/, /[0-9a-f]{8}-[0-9a-f]{4}-/, /setup-run|request|backup-1/, /\d{4}-\d{2}-\d{2}T/, /setting:|config:|skill:|integration:/, /\b[A-Z][A-Z_]{3,}: /])
    assert.doesNotMatch(seen, raw);
});

test('an interrupted reconcile names its change and offers Re-preview and Abandon', async t => {
  const interrupted = localRun({ state: 'interrupted', result: { status: 'interrupted', message: 'Restarted' } });
  const { c, html } = await page(t, f => { f.report.items = localItems(); f.handlers.listRuns = () => ({ runs: [interrupted], nextBefore: null }); f.handlers.getRun = () => interrupted; });
  c.enter(); await flush();
  const text = html();
  assert.match(text, /Apply changes to this Mac was interrupted/); assert.match(text, /1 change was written and 1 was not/);
  assert.deepEqual(buttons(text).filter(b => b === 'Re-preview' || b === 'Abandon'), ['Re-preview', 'Abandon']);
  assert.doesNotMatch(outsideDetails(text), /local-run|backup-1|skill:tdd/);
});

test('profile listing failures appear inline while the cached review stays visible', async t => {
  const { html } = await page(t, f => { f.handlers.inspectProfiles = () => { throw new Error('Profile clone unavailable'); }; });
  const text = html();
  assert.match(text, /Profile clone unavailable/);
  assert.match(text, /aria-label="Current value of /);
});
