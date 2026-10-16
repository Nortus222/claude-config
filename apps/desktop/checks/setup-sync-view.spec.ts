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
