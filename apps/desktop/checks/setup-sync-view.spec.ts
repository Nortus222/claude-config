import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SetupSyncView } from '../src/setup-sync-view.tsx';
import { SetupSyncController } from '../src/setup-sync-controller.ts';
import { fixture, review } from './support/setup-sync.ts';

test('Setup shows accessible values and warns that unchosen incoming items will be held', async t => {
  const f = await fixture(); const c = new SetupSyncController(f.bridge, f.machine); t.after(() => { c.dispose(); f.machine.dispose(); }); await c.reload();
  const html = renderToStaticMarkup(createElement(SetupSyncView, { state: c.state, controller: c }));
  assert.match(html, /Current value of setting:a/); assert.match(html, /Offered value of setting:a/); assert.match(html, /mine/);
  assert.match(html, /Items you don&#x27;t choose will be held/); assert.doesNotMatch(html, />Apply reviewed choices</);
  assert.match(html, /keep this Mac&#x27;s override/); assert.match(html, /backed up first/);
});
test('pin-group refusal is rendered beside its source and unchanged siblings remain selectable', async t => {
  const f = await fixture(); f.handlers.setupReview = () => review({ rows: [{ itemId: 'skill:a', kind: 'skill', change: 'unchanged', held: false, conflict: false }], pinGroups: [{ source: 'owner/repo', itemIds: ['skill:a', 'skill:b'] }] });
  const c = new SetupSyncController(f.bridge, f.machine); t.after(() => { c.dispose(); f.machine.dispose(); }); await c.reload(); c.choose({ itemId: 'skill:a', action: 'accept' });
  f.handlers.previewChange = () => { throw new Error('Choices for owner/repo must match: its items share one pin.'); }; await c.preview();
  const html = renderToStaticMarkup(createElement(SetupSyncView, { state: c.state, controller: c }));
  assert.match(html, /<fieldset[^>]*class="setup-sync-pin"[\s\S]*owner\/repo[\s\S]*role="alert"/); assert.match(html, /Unchanged/); assert.match(html, /1 not on this page/);
});

test('the preview lists each staged action before Apply', async t => {
  const f = await fixture(); const c = new SetupSyncController(f.bridge, f.machine); t.after(() => { c.dispose(); f.machine.dispose(); });
  await c.reload(); c.choose({ itemId: 'setting:a', action: 'takeTheirs' }); await c.preview();
  const html = renderToStaticMarkup(createElement(SetupSyncView, { state: c.state, controller: c }));
  assert.match(html, /aria-label="Reviewed choices"[\s\S]*setting:a[\s\S]*Use the setup value/);
  assert.match(html, />Apply reviewed choices</);
});

test('profile controls show the followed identity and dropped choices before Apply', async t => {
  const f = await fixture();
  f.handlers.inspectProfiles = () => ({ followed: { repoUrl: 'https://github.com/example/profiles.git', profile: 'default', setupId: null }, available: [{ name: 'default', extends: null }, { name: 'small', extends: 'default' }] });
  f.handlers.previewChange = input => ({ planId: 'plan', scope: { kind: 'machine' }, generation: '1', change: input.change, plan: { kind: 'operation', steps: [], skipped: [] }, nextActions: [], droppedChoices: { holds: ['skill:owner/repo/old'], overrides: ['skills.old'] }, actionEffects: ['Inspect only'] });
  const c = new SetupSyncController(f.bridge, f.machine); t.after(() => { c.dispose(); f.machine.dispose(); });
  await c.reload(); await c.switchProfile('small');
  const html = renderToStaticMarkup(createElement(SetupSyncView, { state: c.state, controller: c }));
  assert.match(html, /Following default from https:\/\/github.com\/example\/profiles.git/);
  assert.match(html, /Switch profile/); assert.match(html, /Follow a shared link/);
  assert.ok(html.indexOf('skill:owner/repo/old') < html.indexOf('>Apply reviewed choices<'));
  assert.match(html, /Override: <code>skills.old/);
});


test('profile listing failures appear inline while the cached review stays visible', async t => {
  const f = await fixture();
  f.handlers.inspectProfiles = () => { throw new Error('Profile clone unavailable'); };
  const c = new SetupSyncController(f.bridge, f.machine); t.after(() => { c.dispose(); f.machine.dispose(); });
  await c.reload();
  const html = renderToStaticMarkup(createElement(SetupSyncView, { state: c.state, controller: c }));
  assert.match(html, /Profile clone unavailable/);
  assert.match(html, /Current value of setting:a/);
});
