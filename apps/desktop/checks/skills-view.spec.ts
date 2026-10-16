import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MachineController, type ViewState } from '../src/controller.ts';
import { SkillsController, type SkillsViewState } from '../src/skills-controller.ts';
import { SkillsView, filterSkills, rowState } from '../src/skills-view.tsx';
import { ShellView } from '../src/views.tsx';
import { inventory, updates, row, receipt, preview, status } from './support/skills-data.ts';
const render = (fields: Partial<SkillsViewState> = {}, machineFields: Partial<ViewState> = {}) => {
  const machine = new MachineController(null), controller = new SkillsController(null, machine);
  const state = { ...controller.state, native: true, view: inventory(), ...fields } as SkillsViewState;
  return renderToStaticMarkup(createElement(SkillsView, { state, machine: { ...machine.state, connection: 'connected', initialReadPending: false, status: status(), ...machineFields }, controller }));
};
test('Skills navigation opens a real page with an honest browser empty state', () => {
  const machine = new MachineController(null), controller = new SkillsController(null, machine);
  const html = renderToStaticMarkup(createElement(ShellView, { screen: 'skills', navigate: () => {}, children: createElement(SkillsView, { state: controller.state, machine: machine.state, controller }) }));
  assert.match(html, /aria-current="page">Skills/); assert.match(html, /Open the desktop app/); assert.doesNotMatch(html, /type="radio"|Check upstream/);
});
test('On, Off and Default show the inherited value and source of the saved choice', () => {
  const html = render({ view: inventory([row(), row('optional', { defaultEnabled: false, enabled: false }), row('chosen', { choice: true })]) });
  assert.match(html, /role="radiogroup" aria-label="tdd on this Mac"/); assert.match(html, /Default · On/); assert.match(html, /Default · Off/);
  assert.match(html, /From the profile/); assert.match(html, /Your choice on this Mac/); assert.match(html, /owner\/skills/);
  assert.match(html, /Search skills/); assert.match(html, /aria-label="Show"/);
});
test('saving never presents the proposed choice as the saved choice', () => {
  const html = render({ saving: { source: 'owner/skills', name: 'tdd', choice: 'off' }, operation: 'save', detail: 'Saving the choice for tdd' });
  assert.match(html, /Saving/); assert.match(html, /checked="" value="inherit"/); assert.doesNotMatch(html, /checked="" value="off"|Saved tdd/);
  assert.match(html, /aria-busy="true"/);
});
test('installation text follows observed state and owned disable rules', () => {
  assert.match(rowState(row('tdd', { choice: false }), { state: 'disabled', disposition: 'apply' }).detail!, /backup/);
  assert.match(rowState(row('tdd', { choice: false }), { state: 'disabled', disposition: 'blocked', note: 'ownership unknown' }).detail!, /Nothing will be removed/);
  assert.match(rowState(row('optional', { defaultEnabled: false }), { state: 'ok', disposition: 'in-sync' }).detail!, /Previously installed/);
  assert.equal(rowState(row(), undefined).installed, 'Unknown');
});
test('local search and filters retain source-qualified identities', () => {
  const view = inventory([row(), row('optional', { choice: false }), row('tdd', { source: 'other/skills' })]);
  assert.deepEqual(filterSkills(view, updates(), 'OTHER', 'all').flatMap(s => s.skills.map(r => r.source)), ['other/skills']);
  assert.deepEqual(filterSkills(view, updates(), '', 'choices').flatMap(s => s.skills.map(r => r.name)), ['optional']);
  assert.deepEqual(filterSkills(view, updates(), '', 'updates').flatMap(s => s.skills.map(r => r.source)), ['owner/skills']);
});
test('upstream checks show eligibility and repair prerequisites before explicit preview and apply', () => {
  const base = updates().items[0]!;
  const check = updates({ items: [base, { ...base, key: 'native', name: 'native', repairRoute: 'addition', prerequisite: '<script>repair</script>' }] });
  const html = render({ view: inventory([row(), row('native')]), check, selected: ['skills:update:tdd'] });
  assert.match(html, /Check upstream/); assert.match(html, /Update available/); assert.match(html, /Select tdd for update/);
  assert.doesNotMatch(html, /Select native for update|<script>|>Apply update/); assert.match(html, /&lt;script&gt;repair&lt;\/script&gt;/);
  const planned = render({ check: updates(), preview: preview({ kind: 'update', only: ['skills:update:tdd'], authorManifest: false }), selected: ['skills:update:tdd'] });
  assert.match(planned, /Planned update steps/); assert.match(planned, />Apply update/);
});
test('running and interrupted shared receipts display their state without claiming installation', () => {
  const html = render({ run: receipt(), saving: { source: 'owner/skills', name: 'tdd', choice: 'off' } });
  assert.match(html, /running/); assert.match(html, />Cancel<\/button>/); assert.doesNotMatch(html, /Saved|Installed successfully/);
  assert.match(render({ run: receipt('interrupted'), stale: 'Reload Skills to confirm the choice.' }), /interrupted/);
});
test('unavailable and partial data stay visible, and empty profiles invent no rows', () => {
  assert.match(render({ check: updates({ unavailable: true, items: [] }) }), /unavailable/i);
  assert.match(render({ view: inventory([], { limitReason: 'result-bytes' }) }), /incomplete/i);
  const empty = render({ view: inventory([]) }); assert.match(empty, /declares no skills/); assert.doesNotMatch(empty, /type="radio"/);
});
test('a stale choice preview displays the proposed change and offers an explicit retry', () => {
  const html = render({ preview: preview(), detail: 'The machine changed. Review the new plan and apply again.' });
  assert.match(html, /Save choice/); assert.match(html, /Review &amp; apply makes installation changes/); assert.match(html, />Retry saving choice<\/button>/);
});
