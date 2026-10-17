import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SetupSyncView, SetupProfiles, IncomingRow, PinGroupRow, Segmented, NameList, RunCard, incomingEntries, pinMove } from '../src/setup-sync-view.tsx';
import { CopyDetails, RunPlaces } from '../src/run-recovery.tsx';
import { groupLabels, itemLabel } from '../src/copy.ts';
import { DEFAULT_REPO_URL } from '../shared/setup-protocol.ts';
import { SetupSyncController } from '../src/setup-sync-controller.ts';
import { fixture, review, run, localItems, localRun, localChange, flush } from './support/setup-sync.ts';

async function page(t: test.TestContext, prepare: (f: Awaited<ReturnType<typeof fixture>>) => void = () => {}) {
  const f = await fixture(); prepare(f);
  const c = new SetupSyncController(f.bridge, f.machine); t.after(() => { c.dispose(); f.machine.dispose(); });
  if (f.report.items.length) await f.machine.inspect();
  await c.reload();
  return { ...f, c, html: (props: { onOpenProfiles?: () => void; repoUrl?: string } = {}) => renderToStaticMarkup(createElement(SetupSyncView, { state: c.state, controller: c, ...props })) };
}
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(match => match[1]!);
// Buttons that start a change: the page has exactly one, inside the top preview panel.
// The list of profiles to follow only previews, so its Follow buttons are left out.
const applyButtons = (html: string) => buttons(html.replace(/<ul class="[^"]*profile-choice-list"[\s\S]*?<\/ul>/, '')).filter(text => /^(Apply|Switch to|Follow |Hold \d)/.test(text));
const panel = (html: string) => /<section class="card changes-preview"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
const details = (html: string) => html.slice(html.search(/<details class="[^"]*changes-details"/));
// What a reader sees or hears outside Details: text and accessible names.
const outsideDetails = (html: string) => {
  const visible = html.replace(/<details class="[^"]*(changes-details|run-details)"[\s\S]*?<\/details>/g, '');
  return [...visible.matchAll(/aria-label="([^"]*)"/g)].map(match => match[1]).join('\n') + '\n' + visible.replace(/<[^>]+>/g, '\n');
};
// Every radiogroup named `label` (rows can share a label), joined; and the radios in markup with their state.
const group = (html: string, label: string) => [...html.matchAll(/<div role="radiogroup" aria-label="([^"]*)"[^>]*>[\s\S]*?<\/div>/g)].filter(match => match[1] === label).map(match => match[0]).join('');
const radios = (html: string) => [...html.matchAll(/<button type="button" role="radio" aria-checked="(true|false)"[^>]*>([^<]*)<\/button>/g)].map(match => ({ checked: match[1] === 'true', text: match[2]! }));
// Markup as the text a reader sees, tags removed.
const plainText = (html: string) => html.replace(/<[^>]+>/g, '');
// The first element in a component's own output that matches; child components are not rendered.
function find(node: ReactNode, match: (element: ReactElement<any>) => boolean): ReactElement<any> | undefined {
  if (Array.isArray(node)) { for (const child of node) { const found = find(child, match); if (found) return found; } return undefined; }
  if (!node || typeof node !== 'object' || !('props' in node)) return undefined;
  const element = node as ReactElement<any>;
  return match(element) ? element : find(element.props.children, match);
}
const followProfiles = (f: Awaited<ReturnType<typeof fixture>>) => {
  f.handlers.inspectProfiles = () => ({ followed: { repoUrl: 'https://github.com/example/profiles.git', profile: 'default', setupId: null }, available: [{ name: 'default', extends: null }, { name: 'team', extends: 'default' }] });
};

test('Changes warns that unchosen incoming items will be held and names every choice of an overridden row', async t => {
  const { html } = await page(t); const text = html();
  assert.match(text, /<h1>Changes<\/h1>/); assert.doesNotMatch(text, /eyebrow/);
  assert.match(text, /Items you don&#x27;t choose will be held/); assert.deepEqual(applyButtons(text), []);
  // setting:a is overridden on this Mac, so it offers Hold, Take (keeping the override) and Replace mine.
  assert.deepEqual(radios(group(text, 'Choice for Item')).map(radio => radio.text), ['Hold', 'Take', 'Replace mine', 'Hold', 'Take']);
  assert.match(text, /title="Take your profile&#x27;s value · keep this Mac&#x27;s override"[^>]*>Take</);
  assert.match(text, /title="Use your profile&#x27;s value and remove this Mac&#x27;s override \(backed up first\)"[^>]*>Replace mine</);
  assert.match(text, />Overridden here</);
});

test('an incoming row hides its values behind Details until it is opened', async t => {
  const { c, html } = await page(t);
  const text = html();
  assert.match(text, /<button type="button" class="[^"]*" aria-expanded="false" aria-label="Values of Item">[\s\S]*?Details<\/button>/);
  assert.doesNotMatch(text, /aria-label="Current value of /);
  let toggled = 0;
  const props = { row: c.state.review!.rows[0]!, state: c.state, controller: c, onToggle: () => { toggled++; } };
  const closed = IncomingRow({ ...props, open: false });
  find(closed, element => element.props.text === 'Details')!.props.onToggle();
  assert.equal(toggled, 1);
  const open = renderToStaticMarkup(createElement(IncomingRow, { ...props, open: true }));
  const controls = /aria-expanded="true" aria-controls="([^"]+)"/.exec(open)?.[1];
  assert.ok(controls); assert.match(open, new RegExp(`id="${controls}"`));
  // Short values read on one line; a long or multi-line value keeps every value in its own box.
  assert.match(open, /<dl class="incoming-values">/);
  assert.match(open, /<dt>Current<\/dt><dd><code aria-label="Current value of Item">old<\/code>/); assert.match(open, /aria-label="Offered value of Item">new</);
  assert.match(open, /aria-label="This Mac&#x27;s value of Item">mine</);
  const long = renderToStaticMarkup(createElement(IncomingRow, { ...props, row: { ...props.row, after: '{\n  "a": 1\n}' }, open: true }));
  assert.doesNotMatch(long, /incoming-values/);
  assert.match(long, /aria-label="Current value of Item"><code>old</); assert.match(long, /aria-label="Offered value of Item"><code>\{\n  &quot;a&quot;: 1\n\}</);
});

test('an undecided row has no selected segment, and a choice selects exactly its segment', async t => {
  const { c, html } = await page(t);
  const undecided = radios(group(html(), 'Choice for Item'));
  assert.ok(undecided.length > 0); assert.ok(undecided.every(radio => !radio.checked));
  // With nothing chosen, the first segment is the one Tab reaches.
  assert.match(group(html(), 'Choice for Item'), /^<div role="radiogroup"[^>]*><button type="button" role="radio" aria-checked="false"[^>]*tabindex="0"/);
  c.choose({ itemId: 'setting:a', action: 'takeTheirs' });
  assert.deepEqual(radios(group(html(), 'Choice for Item')).slice(0, 3).map(radio => radio.checked), [false, false, true]);
  c.choose({ itemId: 'setting:a', action: 'hold' });
  assert.deepEqual(radios(group(html(), 'Choice for Item')).slice(0, 3).map(radio => radio.checked), [true, false, false]);
});

test('a held row reads Take as chosen after a bulk take', async t => {
  const { c, html } = await page(t, f => { f.handlers.setupReview = () => review({ rows: [{ itemId: 'setting:claude:settings.json#tui', kind: 'setting', change: 'changed', held: true, conflict: false, before: '"a"', after: '"b"' }] }); });
  assert.match(html(), />On hold</);
  c.chooseAll('accept');
  assert.deepEqual(c.state.choices, [{ itemId: 'setting:claude:settings.json#tui', action: 'accept' }]);
  assert.deepEqual(radios(group(html(), 'Choice for Claude setting tui')).map(radio => [radio.text, radio.checked]), [['Hold', false], ['Take', true]]);
});

test('the segmented control chooses on click and moves its choice with the arrow keys', () => {
  const chosen: string[] = [];
  const element = Segmented({ label: 'Choice', options: [{ value: 'hold', text: 'Hold' }, { value: 'accept', text: 'Take' }], selected: undefined, disabled: false, onSelect: value => { chosen.push(value); } });
  const [hold, take] = element.props.children as ReactElement<any>[];
  hold!.props.onClick(); assert.deepEqual(chosen, ['hold']);
  const key = (button: ReactElement<any>, name: string) => { let prevented = false; button.props.onKeyDown({ key: name, preventDefault: () => { prevented = true; }, currentTarget: { parentElement: null } }); return prevented; };
  assert.equal(key(hold!, 'ArrowRight'), true); assert.equal(key(take!, 'ArrowRight'), true); assert.equal(key(hold!, 'ArrowLeft'), true);
  assert.deepEqual(chosen, ['hold', 'accept', 'hold', 'accept']);
  assert.equal(key(hold!, 'Tab'), false); assert.equal(chosen.length, 4);
});

test('a pin group is one row whose Hold | Take decides for every member, with its members read-only below', async t => {
  const rows = ['a', 'b'].map(name => ({ itemId: `skill:owner/repo/${name}`, kind: 'skill' as const, change: 'changed' as const, held: false, conflict: false,
    before: '{"exact":false,"install":true,"optional":false,"pin":null}', after: `{"exact":false,"install":true,"optional":false,"pin":"${'1'.repeat(40)}"}` }));
  const { c, html } = await page(t, f => { f.handlers.setupReview = () => review({ rows: [...rows, { itemId: 'setting:claude:settings.json#loose', kind: 'setting', change: 'added', held: false, conflict: false, after: '1' }],
    pinGroups: [{ source: 'owner/repo', itemIds: ['skill:owner/repo/a', 'skill:owner/repo/b', 'skill:owner/repo/c'] }] }); });
  const text = html();
  assert.match(plainText(text), /Skills from owner\/repo · 3 skills · pin moves to 111111111111 · 1 on other pages/); assert.match(text, /Skills from <strong>owner\/repo<\/strong>/);
  assert.equal(radios(group(text, 'Choice for every skill from owner/repo')).length, 2);
  assert.ok(radios(group(text, 'Choice for every skill from owner/repo')).every(radio => !radio.checked));
  // Members have no controls of their own, and the loose row keeps its own.
  assert.doesNotMatch(text, /Choice for Skill/); assert.match(text, /aria-label="Choice for Claude setting loose"/);
  assert.doesNotMatch(text, /Skill <strong>a<\/strong>/);

  const props = { group: c.state.review!.pinGroups[0]!, rows: c.state.review!.rows.slice(0, 2), state: c.state, controller: c, open: false, isOpen: () => false, toggle: () => {} };
  let opened = 0;
  const row = PinGroupRow({ ...props, onToggle: () => { opened++; } });
  const segmented = find(row, element => element.type === Segmented)!;
  const take = (Segmented(segmented.props).props.children as ReactElement<any>[]).find(button => button.props.children === 'Take')!;
  take.props.onClick();
  assert.deepEqual(c.state.choices, [{ itemId: 'skill:owner/repo/a', action: 'accept' }, { itemId: 'skill:owner/repo/b', action: 'accept' }]);
  assert.deepEqual(radios(group(html(), 'Choice for every skill from owner/repo')).map(radio => [radio.text, radio.checked]), [['Hold', false], ['Take', true]]);
  find(row, element => element.props.text === 'Skills')!.props.onToggle(); assert.equal(opened, 1);

  const open = renderToStaticMarkup(createElement(PinGroupRow, { ...props, open: true, onToggle: () => {} }));
  assert.match(open, /aria-label="Skills from owner\/repo"[\s\S]*Skill <strong>a<\/strong> from owner\/repo[\s\S]*Skill <strong>b<\/strong>[\s\S]*Skill <strong>c<\/strong> from owner\/repo[\s\S]*On another page/);
  assert.doesNotMatch(open.slice(open.indexOf('incoming-members')), /role="radiogroup"/);
  assert.match(open, /aria-label="Values of Skill a from owner\/repo"/);
});

test('pin-group refusal is rendered on its group row, which still counts members on other pages', async t => {
  const { c, html, handlers } = await page(t, f => { f.handlers.setupReview = () => review({ rows: [{ itemId: 'skill:owner/repo/a', kind: 'skill', change: 'unchanged', held: false, conflict: false }], pinGroups: [{ source: 'owner/repo', itemIds: ['skill:owner/repo/a', 'skill:owner/repo/b'] }] }); });
  c.choose({ itemId: 'skill:owner/repo/a', action: 'accept' });
  handlers.previewChange = () => { throw new Error('Choices for owner/repo must match: its items share one pin.'); }; await c.preview();
  const text = html();
  assert.match(plainText(text), /Skills from owner\/repo · 2 skills · 1 on other pagesUnchanged/);
  assert.match(text, /Unchanged[\s\S]*?role="alert"[^>]*>Choices for owner\/repo must match/);
  assert.equal(text.match(/role="alert"/g)?.length, 1);
});

test('incoming entries keep review order, put each group where its first row is, and pinMove needs one new pin', () => {
  const row = (itemId: string) => ({ itemId, kind: 'setting' as const, change: 'changed' as const, held: false, conflict: false });
  const entries = incomingEntries({ rows: [row('setting:a'), row('skill:o/r/x'), row('setting:b'), row('skill:o/r/y')], pinGroups: [{ source: 'o/r', itemIds: ['skill:o/r/x', 'skill:o/r/y'] }, { source: 'gone', itemIds: ['skill:gone/z'] }] });
  assert.deepEqual(entries.map(entry => 'group' in entry ? `group ${entry.group.source} ${entry.rows.length}` : entry.row.itemId), ['setting:a', 'group o/r 2', 'setting:b']);
  const skill = (before: string | null, after: string | null) => ({ change: 'changed' as const, before: JSON.stringify({ pin: before }), after: JSON.stringify({ pin: after }) });
  assert.equal(pinMove([skill(null, 'abc'), skill('old', 'abc')]), 'abc');
  assert.equal(pinMove([skill(null, 'abc'), skill(null, 'def')]), null);
  assert.equal(pinMove([skill('abc', 'abc')]), null);
  assert.equal(pinMove([{ change: 'changed', before: 'a', after: 'not json' }]), null);
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
  assert.deepEqual(radios(group(text, 'Choice for every skill from owner/repo')).map(radio => radio.text), ['Hold', 'Take']);
  assert.doesNotMatch(text, /cursor\/plugins/);
});

test('the incoming preview sits at the top, lists each staged action and holds the one Apply', async t => {
  const { c, html } = await page(t); c.choose({ itemId: 'setting:a', action: 'takeTheirs' }); c.choose({ itemId: 'setting:b', action: 'hold' }); await c.preview();
  const text = html(), top = panel(text);
  assert.ok(text.indexOf('changes-preview') < text.indexOf('setup-sync-summary'));
  assert.match(plainText(top), /Replace mine 1 · backed up firstItem[\s\S]*Hold 1Item/);
  assert.match(top, /Items you don&#x27;t choose will be held/);
  // Apply and Cancel sit in the panel's head, before anything it lists.
  assert.deepEqual(applyButtons(text), ['Apply 1 incoming change']);
  assert.match(top, /<div class="card-head">[\s\S]*>Apply 1 incoming change<\/button><button>Cancel<\/button><\/div><\/div><div class="preview-lines">/);
});

test('an incoming preview groups its choices by action, one line each, with steps and left-out items folded away', async t => {
  const names = ['model', 'theme', 'tui', 'env.A', 'env.B', 'env.C', 'env.D', 'env.E', 'env.F', 'env.G'];
  const action = (index: number) => index < 3 ? 'accept' as const : index === 3 ? 'takeTheirs' as const : index === 4 ? 'release' as const : 'hold' as const;
  const choices = names.map((name, index) => ({ itemId: `setting:claude:settings.json#${name}`, action: action(index) }));
  const { c, html, handlers } = await page(t);
  handlers.previewChange = () => ({ planId: 'plan', scope: { kind: 'machine' }, generation: '1', change: { kind: 'setupApply', setupId: 'local', revision: { kind: 'local', commit: 'b'.repeat(40) }, choices },
    plan: { kind: 'apply', steps: [{ key: 'config:claude:settings.json#model', summary: 'Write Claude setting model', domain: 'config', action: 'merge-keys', touches: [], interruptible: true }],
      skipped: [{ key: 'config:claude:settings.json#tui', reason: 'Already matches your profile' }] }, nextActions: [], actionEffects: ['Save reviewed choices'] });
  c.choose({ itemId: 'setting:a', action: 'accept' }); await c.preview();
  const top = panel(html()), seen = plainText(top.replace(/<details[\s\S]*?<\/details>/g, ''));
  // Each line names its kind once; a single item reads as its whole label.
  assert.match(seen, /Take 3Claude settings: model, theme, tuiEnd/);
  assert.match(seen, /End hold and take 1Claude setting env\.BReplace/);
  assert.match(seen, /Replace mine 1 · backed up firstClaude setting env\.AHold/);
  assert.match(seen, /Hold 5Claude settings: env\.C, env\.D, env\.E, env\.F, env\.GItems/);
  assert.match(top, /<span class="name-group-head">Claude settings: <\/span><strong>model<\/strong>, <strong>theme<\/strong>/);
  // No per-item sentence, no repeated steps and no agent fine print outside the folds.
  assert.doesNotMatch(seen, /your profile&#x27;s value|Write Claude setting model|Save reviewed choices|Already matches/);
  assert.match(top, /<details class="preview-more"><summary>Steps \(1\)<\/summary>[\s\S]*Write Claude setting model[\s\S]*Save reviewed choices/);
  assert.match(top, /<details class="preview-more"><summary>1 left out<\/summary>[\s\S]*Already matches your profile/);
  assert.equal(top.match(/class="muted[^"]*"/g)?.length, 1);
});

test('a preview of many changes to this Mac shows the first names inline and the rest behind +N more', async t => {
  const keys = Array.from({ length: 40 }, (_, i) => `config:claude:settings.json#key${i}`);
  const { c, html, handlers } = await page(t, f => { f.report.items = keys.map(key => ({ key, domain: 'config', target: 'claude', label: key, group: 'claude', state: 'repo-ahead', disposition: 'apply', from: { layer: 'profile', source: 'personal' } })); });
  handlers.previewChange = input => ({ planId: 'plan', scope: { kind: 'machine' }, generation: '1', change: input.change, plan: { kind: 'operation', steps: [], skipped: [] }, nextActions: [] });
  await c.previewLocal();
  const top = panel(html());
  assert.match(top, /Apply 40 changes to this Mac/);
  // Twelve names under one "Claude settings", then +28 more.
  assert.equal(top.match(/<strong>key\d+<\/strong>/g)?.length, 12); assert.equal(top.match(/Claude settings: /g)?.length, 1);
  assert.match(top, /<strong>key11<\/strong><\/span><\/li><li class="name-more"><button type="button" class="link" aria-expanded="false">\+28 more<\/button><\/li>/);
  const list = renderToStaticMarkup(createElement(NameList, { label: 'Names', labels: keys.slice(0, 12).map(key => ({ lead: '', name: key, tail: '', text: key })) }));
  assert.doesNotMatch(list, /more/);
});

test('a name list groups items by kind in order of first appearance, with the kind once and in the plural', () => {
  const labels = ['setting:claude:settings.json#model', 'skill:mattpocock/skills/tdd', 'setting:claude:settings.json#theme', 'skill:mattpocock/skills/grill-me',
    'file:claude:CLAUDE.md', 'integration:browser', 'integration:github', 'skill:other/repo/x'].map(itemLabel);
  const text = plainText(renderToStaticMarkup(createElement(NameList, { label: 'Names', labels })));
  assert.equal(text, 'Claude settings: model, theme · Skills from mattpocock/skills: tdd, grill-me · Claude instructions (CLAUDE.md) · Integrations: browser, github · Skill x from other/repo');
  assert.deepEqual(groupLabels(['file:claude:a.json', 'file:claude:b.json'].map(itemLabel)).map(group => [group.heading, group.items.map(item => item.name)]), [['Claude files', ['a.json', 'b.json']]]);
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
  assert.match(text, /Following default from example\/profiles/);
  assert.match(text, /Profile/); assert.match(text, /Follow a shared link/);
  const visible = plainText(panel(text).replace(/<details[\s\S]*?<\/details>/g, ''));
  assert.match(visible, /Holds that end 1Skill old from owner\/repo/);
  assert.match(visible, /Overrides removed 1Skill old/);
});

test('a stale reconcile shows the updated plan with its notice', async t => {
  const { c, html, handlers } = await page(t, f => { f.report.items = localItems(); }); await c.previewLocal();
  const fresh = { ...c.state.preview!, planId: 'fresh' }; handlers.applyChange = () => ({ status: 'stale', preview: fresh }); await c.apply();
  const top = panel(html());
  assert.match(top, /This Mac changed. Review the updated plan./); assert.deepEqual(applyButtons(top), ['Apply 2 changes to this Mac']);
});
test('a stale incoming Apply asks to choose again beside the review, with no Apply offered', async t => {
  const { c, html, handlers } = await page(t); c.choose({ itemId: 'setting:a', action: 'accept' }); await c.preview();
  const fresh = { ...c.state.preview!, planId: 'fresh' }; handlers.applyChange = () => ({ status: 'stale', preview: fresh });
  handlers.setupReview = () => review({ rows: [{ itemId: 'setting:a', kind: 'setting', change: 'changed', held: false, conflict: false, before: 'old', after: 'newer' }] });
  await c.apply();
  const text = html();
  assert.equal(panel(text), ''); assert.deepEqual(applyButtons(text), []);
  assert.match(text, /Your profile changed. Review the new values and choose again./);
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

test('the Changes run card counts failed steps while running and when done', async t => {
  const steps = [{ key: 'setting:a', outcome: 'ok' as const, note: 'Written' }, { key: 'setting:b', outcome: 'failed' as const, note: 'Permission denied' }];
  const { c, html, handlers, emit } = await page(t);
  handlers.getRun = () => run({ steps });
  c.choose({ itemId: 'setting:a', action: 'accept' }); await c.preview(); await c.apply(); await flush();
  const card = () => /<section class="card changes-run[^"]*"[\s\S]*?<\/section>/.exec(html())?.[0] ?? '';
  assert.match(card(), /1 of 2 steps done, 1 failed\./);
  handlers.getRun = () => run({ state: 'failed', steps, result: { status: 'done', ok: 1, failed: 1 } });
  emit({ version: 3, event: 'operation-run', runId: 'setup-run' }); await flush();
  assert.match(card(), /1 change applied, 1 failed\./);
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
  assert.match(text, /aria-label="Values of Item"/);
});

test('the Changes heading counts incoming rows like Home and the badge: not unchanged, not on hold', async t => {
  const rows = [...Array.from({ length: 32 }, (_, i) => ({ itemId: `setting:s${i}`, kind: 'setting' as const, change: 'changed' as const, held: i < 4, conflict: false })),
    { itemId: 'setting:u', kind: 'setting' as const, change: 'unchanged' as const, held: false, conflict: false }];
  const { html } = await page(t, f => { f.handlers.setupReview = () => review({ rows }); });
  assert.match(html(), /<h2 id="changes-incoming-h">28 incoming changes from your profile · 4 on hold<\/h2>/);
  const quiet = await page(t, f => { f.handlers.setupReview = () => review({ rows: [rows.at(-1)] }); });
  assert.match(quiet.html(), /<h2 id="changes-incoming-h">Nothing incoming from your profile<\/h2>/);
  // With no rows at all, the section is one quiet line: no hold notice, Preview or bulk choices.
  const empty = (await page(t, f => { f.handlers.setupReview = () => review({ rows: [], pinGroups: [] }); })).html();
  const section = /<section class="card setup-sync-review"[\s\S]*?<\/section>/.exec(empty)?.[0] ?? '';
  assert.match(section, /Nothing incoming from your profile[\s\S]*You(&#x27;|')re up to date\./);
  for (const hidden of [/>Preview<\/button>/, /will be held/, /Take all incoming/, /choices? made/]) assert.doesNotMatch(section, hidden);
});

test('a failed run says why, lists its failed steps and counts, offers next steps, and names where to look', async t => {
  const cause = "Couldn't write Claude setting model: EACCES: permission denied";
  // The cause names the model step; grill failed on its own; CLAUDE.md never ran.
  const steps = [{ key: 'skill:tdd', outcome: 'ok' as const, note: 'Installed' }, { key: 'config:claude:settings.json#model', outcome: 'failed' as const, note: 'EACCES: permission denied' },
    { key: 'skill:grill', outcome: 'failed' as const, note: 'Download timed out' }, { key: 'config:claude:CLAUDE.md', outcome: 'failed' as const, note: 'Not written because an earlier step failed' }];
  const { c, html, handlers, emit, bridge, calls } = await page(t, f => { f.report.items = localItems(); });
  const invoked: { command: string; args: unknown }[] = [], invoke = bridge.invoke;
  bridge.invoke = async (command, args) => { invoked.push({ command, args }); if (command === 'reveal_place') throw new Error('There are no backups on this Mac yet.'); return invoke(command, args); };
  handlers.applyChange = () => ({ status: 'started', run: localRun() }); handlers.getRun = () => localRun();
  await c.previewLocal(); await c.apply(); await flush();
  handlers.getRun = () => localRun({ state: 'failed', steps, result: { status: 'failed', message: cause } });
  emit({ version: 3, event: 'operation-run', runId: 'local-run' }); await flush();
  const text = html(), card = /<section class="card changes-run run-failure"[\s\S]*?<\/section>/.exec(text)?.[0] ?? '';
  assert.match(card, /<span class="pill pill-danger">Failed<\/span>/);
  assert.match(card, /class="alert run-cause" role="status">Couldn&#x27;t write Claude setting model: EACCES: permission denied\.</);
  // Only the failure the cause doesn't name is listed; a step that never ran is not a failure.
  assert.match(card, /<ul class="changes-list run-failed" aria-label="Failed steps"><li><span class="changes-label">Skill <strong>grill<\/strong> from mattpocock\/skills<\/span><small>Download timed out\.<\/small><\/li><\/ul>/);
  assert.doesNotMatch(card.replace(/<details[\s\S]*<\/details>/, ''), /EACCES: permission denied\.<\/small>|CLAUDE\.md|earlier step/);
  assert.match(card, /1 change written · 1 not written\. Backups of what it replaced are kept\. Nothing is rolled back automatically\./);
  assert.deepEqual(buttons(card).filter(label => ['Check again', 'Re-preview', 'Copy details'].includes(label)), ['Check again', 'Re-preview', 'Copy details']);
  assert.doesNotMatch(card, /inspect/i);
  // Where to look: the agent log and the run's backups, each with Show in Finder, the run and its keys.
  const inside = /<details class="run-details">[\s\S]*<\/details>/.exec(card)?.[0] ?? '';
  assert.match(inside, /<dt>Agent log<\/dt><dd><code>~\/\.config\/nortuscc\/agent\/agent\.log<\/code> <button class="link" aria-label="Show the agent log in Finder">Show in Finder<\/button>/);
  assert.match(inside, /<code>~\/\.config\/nortuscc\/backups\/backup-1<\/code>[\s\S]*aria-label="Show the backups folder in Finder"/);
  assert.match(inside, /<code>local-run<\/code>/);
  assert.match(inside, /<dt>Failed<\/dt><dd><ul><li><code>config:claude:settings\.json#model<\/code> EACCES: permission denied<\/li><li><code>skill:grill<\/code> Download timed out<\/li><\/ul>/);
  assert.match(inside, /<dt>Not written<\/dt><dd><ul><li><code>config:claude:settings\.json#model<\/code><\/li><li><code>config:claude:CLAUDE\.md<\/code><\/li><\/ul>/);
  assert.doesNotMatch(outsideDetails(text), /local-run|backup-1|config:|skill:tdd/);

  // Copy details carries the plain-text account; Show in Finder names a place, never a path, and reports a refusal.
  const failure = RunCard({ run: c.state.run!, state: c.state, controller: c })!;
  const tree = (failure.type as (props: unknown) => ReactElement)(failure.props);
  assert.match(find(tree, element => element.type === CopyDetails)!.props.text, /^Apply changes to this Mac: Failed\nCause: Couldn't write Claude setting model[\s\S]*- Claude setting model \(config:claude:settings\.json#model\): EACCES: permission denied\n- Skill grill from mattpocock\/skills \(skill:grill\): Download timed out\nWritten: 1, not written: 1\nRun ID: local-run\nBackups: ~\/\.config\/nortuscc\/backups\/backup-1\nAgent log: ~\/\.config\/nortuscc\/agent\/agent\.log$/);
  const places = find(tree, element => element.type === RunPlaces)!;
  assert.equal(await places.props.onReveal('backups'), 'There are no backups on this Mac yet.');
  assert.deepEqual(invoked.filter(call => call.command === 'reveal_place'), [{ command: 'reveal_place', args: { place: 'backups' } }]);

  // Re-preview prepares a fresh plan for what is still waiting.
  await c.repreview();
  assert.deepEqual(calls.filter(call => call.name === 'previewChange').at(-1)?.input.change, localChange);
});

test('a run that finished with failed steps leads with its counts, and one with no reason says so plainly', async t => {
  const { c } = await page(t);
  const render = (fields: Partial<ReturnType<typeof run>>) => renderToStaticMarkup(createElement(RunCard, { run: run(fields), state: c.state, controller: c }));
  assert.match(render({ state: 'failed', steps: [{ key: 'setting:a', outcome: 'failed', note: 'Permission denied' }], result: { status: 'done', ok: 0, failed: 1 } }), /run-cause" role="status">0 changes applied, 1 failed\./);
  const legacy = render({ state: 'failed', result: { status: 'failed', message: 'Operation stopped; inspect before retrying' } });
  assert.match(legacy, /run-cause" role="status">It stopped before finishing, and the agent didn’t record why\.</); assert.doesNotMatch(legacy, /inspect/i);
  // A run that succeeded keeps its one quiet line.
  assert.doesNotMatch(render({ state: 'succeeded', result: { status: 'done', ok: 2, failed: 0 } }), /run-failure|Copy details/);
});

test('Abandon on Changes asks once and names the run', async t => {
  const interrupted = run({ state: 'interrupted', result: { status: 'interrupted', message: 'Restarted' } });
  const { c, html } = await page(t, f => { f.handlers.listRuns = () => ({ runs: [interrupted], nextBefore: null }); f.handlers.getRun = () => interrupted; });
  assert.match(html(), />Re-preview<\/button><button>Abandon<\/button>/);
  c.askAbandon(); const text = html();
  assert.match(text, /Abandon “Apply incoming changes”\? Its remaining steps won’t run\. Finished steps and backups are kept\./);
  assert.match(text, /<button class="danger">Abandon<\/button><button>Keep<\/button>/);
});

test('with nothing followed, Changes lists the setup repository profiles and Follow previews one', async t => {
  const { c, html, calls, handlers } = await page(t, f => {
    f.handlers.inspectProfiles = () => ({ followed: null, available: [{ name: 'default', extends: null }, { name: 'team', extends: 'default' }] });
  });
  handlers.previewChange = input => ({ planId: 'plan', scope: { kind: 'machine' }, generation: '1', change: input.change, plan: { kind: 'operation', steps: [], skipped: [] }, nextActions: [], droppedChoices: { holds: [], overrides: [] }, actionEffects: ['Inspect only'] });
  const text = html({ repoUrl: DEFAULT_REPO_URL });
  assert.match(text, /Profiles in Nortus222\/claude-config/);
  assert.deepEqual(buttons(text).filter(label => label.startsWith('Follow ')), ['Follow default', 'Follow team']);
  const element = SetupProfiles({ state: c.state, controller: c, repoUrl: DEFAULT_REPO_URL })!;
  const follow = (element.props.children[1].props.children as any[]).find(item => item.key === 'team').props.children[1];
  assert.equal(follow.props.disabled, false);
  follow.props.onClick(); await flush();
  assert.deepEqual(calls.filter(call => call.name === 'previewChange').at(-1)?.input.change, { kind: 'followProfile', repoUrl: DEFAULT_REPO_URL, profile: 'team', setupId: null });
  assert.match(panel(html()), /Follow team/);
  const followedPage = await page(t, followProfiles);
  assert.doesNotMatch(followedPage.html(), />Follow default</);
});

test('while this Mac is busy, Changes shows its progress in place of the review and On this Mac', async t => {
  const { c } = await page(t, f => { f.report.items = localItems(); });
  const busy = { kind: 'reconcile', description: 'Applying changes on this Mac', done: 12, total: 30, step: 'Install skill tdd from mattpocock/skills', runId: null };
  const html = renderToStaticMarkup(createElement(SetupSyncView, { state: { ...c.state, busy }, controller: c }));
  assert.match(html, /aria-label="This Mac is busy"[\s\S]*Applying changes on this Mac[\s\S]*12 of 30[\s\S]*Install skill tdd from mattpocock\/skills/);
  assert.doesNotMatch(html, /changes-incoming-h|changes-local-h|hasn(&#x27;|')t been checked/);
  const free = renderToStaticMarkup(createElement(SetupSyncView, { state: c.state, controller: c }));
  assert.match(free, /changes-incoming-h/); assert.match(free, /changes-local-h/); assert.doesNotMatch(free, /This Mac is busy/);
});
