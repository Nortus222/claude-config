import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement, ReactNode } from 'react';
import { decodeRunView } from '@nortuscc/agent/operations';
import { ProfileChoiceView, profileChoiceDue, followApplied } from '../src/profile-choice-view.tsx';
import { SetupSyncController } from '../src/setup-sync-controller.ts';
import { SetupController } from '../src/setup-controller.ts';
import { MachineController } from '../src/controller.ts';
import type { Bridge } from '../src/bridge.ts';
import { DEFAULT_REPO_URL } from '../shared/setup-protocol.ts';
import { fixture, flush, run } from './support/setup-sync.ts';

const followPreview = (change: unknown) => ({ planId: 'plan', scope: { kind: 'machine' }, generation: '1', change, plan: { kind: 'operation', steps: [], skipped: [] }, nextActions: [], droppedChoices: { holds: [], overrides: [] }, actionEffects: ['Inspect only'] });
const migrated = { followed: { repoUrl: DEFAULT_REPO_URL, profile: 'default', setupId: null }, available: [{ name: 'default', extends: null }, { name: 'team', extends: 'default' }] };

async function choice(t: test.TestContext, profiles: unknown = migrated) {
  const f = await fixture();
  f.handlers.inspectProfiles = () => profiles;
  f.handlers.previewChange = input => followPreview(input.change);
  const c = new SetupSyncController(f.bridge, f.machine); t.after(() => { c.dispose(); f.machine.dispose(); });
  c.enter(); await flush();
  let done = 0;
  const element = () => ProfileChoiceView({ state: c.state, controller: c, repoUrl: DEFAULT_REPO_URL, onDone: () => { done++; } });
  return { ...f, c, element, html: () => renderToStaticMarkup(element()), done: () => done };
}
// The first element in a rendered tree, depth first, that matches.
function find(node: ReactNode, match: (element: ReactElement<any>) => boolean): ReactElement<any> | undefined {
  if (Array.isArray(node)) { for (const child of node) { const found = find(child, match); if (found) return found; } return undefined; }
  if (!node || typeof node !== 'object' || !('props' in node)) return undefined;
  const element = node as ReactElement<any>;
  return match(element) ? element : find(element.props.children, match);
}
const text = (element: ReactElement<any>): string => [element.props.children].flat(Infinity).map((child: any) => typeof child === 'string' ? child : child?.props ? text(child) : '').join('');
const button = (element: ReactElement, label: string) => find(element, e => e.type === 'button' && text(e) === label);
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(match => match[1]!);

test('the profile choice is due once, only after a first-run bootstrap in this session, while connected', async () => {
  const hello = { agentVersion: 'fixture', protocol: 3, policy: 'notify', paused: null };
  const bridge: Bridge = { subscribe: async () => () => {}, invoke: async command => ({ generation: 1, data: command === 'desktop_setup_state'
    ? { needsSetup: true, repo: null, gitAvailable: true, canInstallGit: true, defaultRepoUrl: DEFAULT_REPO_URL } : command === 'setup_desktop' ? { hello } : null }) };
  const machine = new MachineController(bridge); const setup = new SetupController(bridge, machine);
  try {
    await setup.check();
    const connected = { connection: 'connected' as const };
    assert.equal(profileChoiceDue(setup.state, connected, false), false);
    await setup.bootstrap();
    assert.equal(profileChoiceDue(setup.state, connected, false), true);
    assert.equal(profileChoiceDue(setup.state, { connection: 'disconnected' }, false), false);
    assert.equal(profileChoiceDue(setup.state, connected, true), false);
    assert.equal(profileChoiceDue({ bootstrapped: false }, connected, false), false);
  } finally { setup.dispose(); machine.dispose(); }
});

test('the choice lists the checkout profiles, marks the current one and offers Keep', async t => {
  const { html } = await choice(t);
  const markup = html();
  assert.match(markup, /<h1>Choose a profile<\/h1>/);
  assert.match(markup, /aria-current="true"[^>]*>[\s\S]*?default[\s\S]*?Current/);
  assert.deepEqual(buttons(markup).filter(label => /^(Follow|Keep|Decide)/.test(label)), ['Follow team', 'Keep default']);
  assert.match(markup, /Follow a shared link instead/);
  assert.doesNotMatch(markup, /changes-preview/);
});

test('without a followed profile every profile can be followed and the choice can be left for later', async t => {
  const { html } = await choice(t, { followed: null, available: [{ name: 'default', extends: null }, { name: 'team', extends: 'default' }] });
  const markup = html();
  assert.deepEqual(buttons(markup).filter(label => /^(Follow|Keep|Decide)/.test(label)), ['Follow default', 'Follow team', 'Decide later']);
  assert.doesNotMatch(markup, /aria-current/);
});

test('Follow team previews a follow from the default repository and shows the Changes preview with one Apply', async t => {
  const { element, html, calls, c } = await choice(t);
  await button(element(), 'Follow team')!.props.onClick();
  assert.deepEqual(calls.filter(call => call.name === 'previewChange').at(-1)?.input.change, { kind: 'followProfile', repoUrl: DEFAULT_REPO_URL, profile: 'team', setupId: null });
  const markup = html();
  assert.match(markup, /<section class="card changes-preview"[\s\S]*Switch this Mac to team/);
  assert.deepEqual(buttons(markup).filter(label => /^(Apply|Switch to)/.test(label)), ['Switch to team']);
  assert.equal(c.state.eligibility.apply, true);
});

test('applying the follow settles the choice only when the follow run succeeds', async t => {
  const { c, handlers } = await choice(t);
  const follow = { kind: 'followProfile' as const, repoUrl: DEFAULT_REPO_URL, profile: 'team', setupId: null };
  const parity = { kind: 'followProfile' as const, generation: '1', baselineDigest: 'a'.repeat(64), planDigest: 'a'.repeat(64), plannedKeys: [] };
  const followRun = (fields = {}) => decodeRunView({ runId: 'follow-run', state: 'running', operation: 'applyChange', scope: { kind: 'machine' },
    intent: { requestId: 'request', inputDigest: 'a'.repeat(64), planId: 'plan', change: follow, parity }, intentSaved: false, steps: [], result: null, ...fields });
  await c.followRepository(DEFAULT_REPO_URL, 'team');
  handlers.applyChange = () => ({ status: 'started', run: followRun({ state: 'succeeded', result: { status: 'done', ok: 1, failed: 0 } }) });
  await c.apply();
  assert.equal(followApplied(c.state), true);
  assert.equal(followApplied({ run: followRun({ state: 'failed', result: { status: 'failed', message: 'No' } }) }), false);
  assert.equal(followApplied({ run: run({ state: 'succeeded', result: { status: 'done', ok: 1, failed: 0 } }) }), false);
  assert.equal(followApplied({ run: null }), false);
});

test('Keep goes straight to Home without previewing anything', async t => {
  const { element, calls, done } = await choice(t);
  const before = calls.length;
  button(element(), 'Keep default')!.props.onClick();
  assert.equal(done(), 1);
  assert.equal(calls.length, before);
});

test('a shared link is previewed through followSharedLink', async t => {
  const { element, calls, handlers, c } = await choice(t);
  handlers.inspectShareLink = input => ({ setupId: input.setupId, name: 'Team', repoUrl: 'https://github.com/example/profiles.git', profile: 'small', latestRevision: 0, access: 'readable' });
  const followed: string[] = [];
  const sharedLink = c.followSharedLink.bind(c);
  c.followSharedLink = async link => { followed.push(link); await sharedLink(link); };
  const form = find(element(), e => e.type === 'form')!;
  let prevented = false;
  await form.props.onSubmit({ preventDefault: () => { prevented = true; }, currentTarget: { elements: { namedItem: () => ({ value: ' nortuscc://follow/shared ' }) } } });
  assert.equal(prevented, true);
  assert.deepEqual(followed, [' nortuscc://follow/shared ']);
  assert.deepEqual(calls.find(call => call.name === 'inspectShareLink')?.input, { scope: { kind: 'machine' }, setupId: 'shared' });
  assert.deepEqual(c.state.preview?.change, { kind: 'followProfile', repoUrl: 'https://github.com/example/profiles.git', profile: 'small', setupId: 'shared' });
});
