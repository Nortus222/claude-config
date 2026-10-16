import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OfferedSetup, SetupView, StartupBoundary, updateAttention, SettingsView, ShellView, screenForReview, followFromSettings, navBadges, type Screen } from '../src/views.tsx';
import { UpdateController, type UpdateViewState } from '../src/update-controller.ts';
import { UpdateView } from '../src/update-view.tsx';
import { SetupController } from '../src/setup-controller.ts';
import { AccountController } from '../src/account-controller.ts';
import { MachineController } from '../src/controller.ts';
import type { Bridge, HostEvent } from '../src/bridge.ts';

function heldReply<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
const machine = () => new MachineController(null);
const navLabels = (markup: string) => [...markup.matchAll(/<button[^>]*>([^<]+)/g)].map(match => match[1]);
test('navigation lists seven screens in THIS MAC and MY PROFILES groups plus Settings, under the Nortuscc brand', () => {
  const c = machine();
  const markup = renderToStaticMarkup(createElement(ShellView, { screen: 'home', navigate: () => {}, machine: c.state, children: createElement('p', null, 'Home body') }));
  assert.deepEqual(navLabels(markup), ['Home', 'Changes', 'Skills', 'Profiles', 'Upstreams', 'Publish', 'Settings']);
  const groups = [...markup.matchAll(/role="group" aria-labelledby="([^"]+)"><p class="[^"]*" id="\1">([^<]+)<\/p>(.*?)<\/div>/g)]
    .map(([, , label, body]) => [label, navLabels(body)]);
  assert.deepEqual(groups, [['THIS MAC', ['Home', 'Changes', 'Skills']], ['MY PROFILES', ['Profiles', 'Upstreams', 'Publish']]]);
  assert.match(markup, /<h2>Nortuscc<\/h2>/);
  assert.match(markup, /<button aria-current="page">Home<\/button>/);
  for (const gone of ['Review &amp; apply', 'Resolved', 'Overview', 'Setup', 'Claude Config', 'Inspect, review, then apply']) assert.doesNotMatch(markup, new RegExp(gone));
});
test('navigation badges count undecided incoming changes and drafts and flag an app update', () => {
  const markup = renderToStaticMarkup(createElement(ShellView, { screen: 'changes', navigate: () => {}, badges: { changes: 3, publish: 1, settings: true }, children: null }));
  assert.match(markup, />Changes<span class="nav-badge" aria-label="3 incoming changes">3<\/span><\/button>/);
  assert.match(markup, />Publish<span class="nav-badge" aria-label="1 draft not published">1<\/span><\/button>/);
  assert.match(markup, />Settings<span class="nav-badge" aria-label="App update available">Update<\/span><\/button>/);
  assert.match(markup, /<button>Home<\/button>/);
  const quiet = renderToStaticMarkup(createElement(ShellView, { screen: 'changes', navigate: () => {}, badges: { changes: 0, publish: 0, settings: false }, children: null }));
  assert.doesNotMatch(quiet, /nav-badge/);
});
test('badge counts come from review rows not on hold, readable drafts and an available or verified update', async () => {
  const { review } = await import('./support/setup-sync.ts');
  const { draft } = await import('./support/author.ts');
  const rows = [...[true, false, false].map((held, index) => ({ itemId: `setting:${index}`, kind: 'setting' as const, change: 'changed' as const, held, conflict: false })),
    { itemId: 'setting:unchanged', kind: 'setting' as const, change: 'unchanged' as const, held: false, conflict: false }];
  const update = (phase: 'current' | 'available' | 'verified', enabled = true): UpdateViewState => ({ native: true, pending: false, retry: null, detail: '', deferred: false,
    update: { installedVersion: '0.1.5', enabled, automaticChecks: false, phase, availableVersion: '0.1.6', notes: null, downloadedBytes: 0, totalBytes: null, diagnostic: null } });
  const drafts = [draft, { id: 'broken', error: 'unreadable' }] as never;
  assert.deepEqual(navBadges({ review: review({ rows }) }, { drafts }, update('available')), { changes: 2, publish: 1, settings: true });
  assert.deepEqual(navBadges({ review: null }, { drafts: null }, update('verified', false)), { changes: 0, publish: 0, settings: false });
  assert.equal(navBadges({ review: null }, { drafts: null }, update('verified')).settings, true);
  assert.equal(navBadges({ review: null }, { drafts: null }, update('current')).settings, false);
});
test('every screen shows one disconnected banner with the reason and a Reconnect action', () => {
  const c = machine(); let reconnects = 0;
  const state = { ...c.state, connection: 'disconnected' as const, detail: 'Agent request timed out; restart explicitly' };
  const markup = renderToStaticMarkup(createElement(ShellView, { screen: 'skills', navigate: () => {}, machine: state, onReconnect: () => { reconnects++; }, children: null }));
  assert.match(markup, /class="[^"]*shell-banner[^"]*" role="alert"[\s\S]*Agent request timed out; restart explicitly[\s\S]*>Reconnect<\/button>/);
  assert.equal(markup.match(/shell-banner/g)?.length, 1);
  const connected = renderToStaticMarkup(createElement(ShellView, { screen: 'skills', navigate: () => {}, machine: { ...state, connection: 'connected' as const }, onReconnect: () => {}, children: null }));
  assert.doesNotMatch(connected, /shell-banner/);
  assert.equal(reconnects, 0);
});
test('Settings reconnects the agent and keeps its version under Details', () => {
  const c = machine(); const account = new AccountController(null, c);
  const hello = { agentVersion: 'a'.repeat(64), protocol: 3 as const, policy: 'manual' as const, paused: null };
  const markup = renderToStaticMarkup(createElement(SettingsView, { machine: { ...c.state, connection: 'connected', hello }, state: account.state, controller: account, machineController: c }));
  assert.match(markup, />Reconnect agent<\/button>/);
  assert.match(markup, /<details class="settings-details"><summary>Details<\/summary><p class="agent-version">Agent version a{64}<\/p><\/details>/);
  assert.match(markup, /<h1>Settings<\/h1>/); assert.doesNotMatch(markup, /eyebrow/);
  assert.doesNotMatch(markup, /Restart \/ reinstall agent|THIS MACHINE|protocol 3/);
});
test('a disabled Reconnect agent says why, next to it and as its title', () => {
  const c = machine(); const account = new AccountController(null, c);
  const applying = { at: '2026-10-11T12:00:00Z', policy: 'notify' as const, paused: null, trusted: true, applying: true, pending: [], drift: [], conflicts: [], probeErrors: [], counts: { pending: 0, held: 0, ready: 0, drift: 0 } };
  const markup = renderToStaticMarkup(createElement(SettingsView, { machine: { ...c.state, connection: 'connected', status: applying }, state: account.state, controller: account, machineController: c }));
  assert.match(markup, /Available when the current apply finishes\.[\s\S]*<button disabled="" title="Available when the current apply finishes\.">Reconnect agent<\/button>/);
  const idle = renderToStaticMarkup(createElement(SettingsView, { machine: { ...c.state, connection: 'connected', status: { ...applying, applying: false } }, state: account.state, controller: account, machineController: c }));
  assert.match(idle, /<button>Reconnect agent<\/button>/);
});
const status = { at: '2026-10-11T12:00:00Z', policy: 'notify' as const, paused: { at: 'now', reason: 'Cancelled' }, trusted: false, pending: [], drift: [], conflicts: [], probeErrors: [], counts: { pending: 3, held: 1, ready: 2, drift: 0 } };
const hosted = { enabled: true, recovered: true, signingIn: false, accountId: null, login: null, machineId: null, auth: 'signed-out' as const, setups: [], machine: null, lastSyncAt: null, retryAt: null, pollAfter: 900, error: null };
test('an existing installation waiting for native setup does not flash first-run consent', async () => {
  const setupReply = heldReply<unknown>();
  const generationReply = heldReply<unknown>();
  const generationCalled = heldReply<void>();
  const statusReply = heldReply<unknown>();
  const statusCalled = heldReply<void>();
  const inspectionReply = heldReply<unknown>();
  const inspectionCalled = heldReply<void>();
  const calls: string[] = [];
  const bridge: Bridge = {
    subscribe: async () => () => {},
    invoke: async (command) => {
      calls.push(command);
      const data = command === 'desktop_setup_state' ? await setupReply.promise
        : command === 'agent_generation' ? (generationCalled.resolve(), await generationReply.promise)
        : command === 'agent_status' ? (statusCalled.resolve(), await statusReply.promise)
        : command === 'inspect_machine' ? (inspectionCalled.resolve(), await inspectionReply.promise)
        : null;
      return { generation: 1, data };
    },
  };
  const c = new MachineController(bridge);
  const setup = new SetupController(bridge, c);
  const renderStartup = () => renderToStaticMarkup(createElement(StartupBoundary, { setup: setup.state, setupController: setup, machine: c.state, machineController: c, updates: createElement('p', null, 'Updates remain available'), children: createElement('p', null, 'Operational view') }));
  const check = setup.check();
  const waiting = renderStartup();
  setupReply.resolve({ needsSetup: false, repo: '/existing', gitAvailable: true, canInstallGit: true, defaultRepoUrl: 'https://github.com/Nortus222/claude-config.git' });
  await generationCalled.promise;
  const connecting = renderStartup();
  generationReply.resolve({ hello: { agentVersion: 'fixture', protocol: 3, policy: 'notify', paused: null } });
  await statusCalled.promise;
  const readingStatus = renderStartup();
  statusReply.resolve(status);
  await inspectionCalled.promise;
  const inspecting = renderStartup();
  inspectionReply.resolve({ profile: { repo: '/existing', revision: 'fixture', overrides: '/fixture/overrides', issues: [] }, items: [], probeErrors: [], status });
  await check;
  try {
    assert.match(waiting, /Checking local setup/);
    assert.match(waiting, /Opening Nortuscc/); assert.match(waiting, /NORTUSCC \/ THIS MAC/);
    assert.doesNotMatch(waiting, /Claude Config|CLAUDE CONFIG/);
    assert.match(waiting, /aria-busy="true"/);
    assert.match(waiting, /role="status" aria-live="polite"/);
    assert.match(waiting, /aria-current="step"[^>]*>.*?Local setup/);
    assert.doesNotMatch(waiting, /Local setup[^<]*<[^>]*>Complete|Agent connection[^<]*<[^>]*>Complete|[0-9]+%/);
    assert.match(waiting, /Updates remain available/);
    assert.doesNotMatch(waiting, /FIRST RUN|Set up this Mac|Configurations to manage|Use this repository and set up/);
    assert.match(connecting, /Connecting to the local agent/);
    assert.match(connecting, /Local setup<\/span><span[^>]*>Complete/);
    assert.match(connecting, /aria-current="step"[^>]*>.*?Agent connection/);
    assert.match(connecting, /Updates remain available/);
    assert.doesNotMatch(connecting, /role="alert"|Last inspection:|<strong>/);
    for (const markup of [readingStatus, inspecting]) {
      assert.match(markup, /Loading your configuration/);
      assert.match(markup, /Agent connection<\/span><span[^>]*>Complete/);
      assert.match(markup, /aria-current="step"[^>]*>.*?Local inspection/);
      assert.match(markup, /Updates remain available/);
      assert.doesNotMatch(markup, /FIRST RUN|role="alert"|Last inspection:|<strong>/);
    }
    assert.equal(c.state.connection, 'connected');
    assert.equal(c.state.inspection?.profile.repo, '/existing');
    assert.equal(calls.includes('setup_desktop'), false);
  } finally { setup.dispose(); c.dispose(); }
});
test('an early active apply leaves the startup boundary for the operational screens', async () => {
  const routing = heldReply<unknown>(); const routed = heldReply<void>();
  let receive: (event: HostEvent) => void = () => {};
  const bridge: Bridge = {
    subscribe: async (listener) => { receive = listener; return () => {}; },
    invoke: async (command) => {
      if (command === 'agent_generation') receive({ generation: 1, version: 3, event: 'status', status: { ...status, applying: true } });
      return { generation: 1, data: command === 'desktop_setup_state' ? { needsSetup: false, repo: '/existing', gitAvailable: true, canInstallGit: true, defaultRepoUrl: 'https://github.com/Nortus222/claude-config.git' }
        : command === 'take_review_request' ? (routed.resolve(), await routing.promise)
        : command === 'agent_status' ? { ...status, applying: true } : null };
    },
  };
  const c = new MachineController(bridge); const setup = new SetupController(bridge, c);
  const check = setup.check(); await routed.promise;
  const markup = renderToStaticMarkup(createElement(StartupBoundary, { setup: setup.state, setupController: setup, machine: c.state, machineController: c, updates: null,
    children: createElement('p', null, 'Operational view') }));
  routing.resolve(null); await check;
  assert.doesNotMatch(markup, /Opening Nortuscc|FIRST RUN/);
  assert.match(markup, /Operational view/);
  setup.dispose(); c.dispose();
});
test('setup failure renders retained setup recovery and Updates without first-run consent', async () => {
  const bridge: Bridge = { subscribe: async () => () => {}, invoke: async () => { throw new Error('fixture private error'); } };
  const c = new MachineController(bridge); const setup = new SetupController(bridge, c);
  await setup.check();
  const markup = renderToStaticMarkup(createElement(StartupBoundary, { setup: setup.state, setupController: setup, machine: c.state, machineController: c,
    updates: createElement('p', null, 'Updates remain available'), children: createElement('p', null, 'Operational view') }));
  assert.match(markup, /role="alert"|Recheck setup|existing setup has been retained|Updates remain available/);
  assert.doesNotMatch(markup, /FIRST RUN|Configurations to manage|Use this repository and set up|fixture private error|Operational view/);
  assert.match(markup, /aria-busy="false"/);
  assert.doesNotMatch(markup, /startup-activity|aria-current="step"/);
  setup.dispose(); c.dispose();
});
test('initial NO_REPORT shows startup progress until real status and inspection arrive', async () => {
  const inspectionReply = heldReply<unknown>();
  const inspectionCalled = heldReply<void>();
  const inspected = heldReply<void>();
  let receive: (event: HostEvent) => void = () => {};
  let reportReady = false;
  const bridge: Bridge = {
    subscribe: async (listener) => { receive = listener; return () => {}; },
    invoke: async (command) => {
      if (command === 'agent_status' && !reportReady) throw new Error('NO_REPORT: agent has not responded yet');
      const data = command === 'desktop_setup_state' ? { needsSetup: false, repo: '/existing', gitAvailable: true, canInstallGit: true, defaultRepoUrl: 'https://github.com/Nortus222/claude-config.git' }
        : command === 'agent_generation' ? { hello: { agentVersion: 'fixture', protocol: 3, policy: 'notify', paused: null } }
        : command === 'agent_status' ? status
        : command === 'inspect_machine' ? (inspectionCalled.resolve(), await inspectionReply.promise)
        : null;
      return { generation: 1, data };
    },
  };
  const c = new MachineController(bridge);
  const setup = new SetupController(bridge, c);
  c.subscribe(() => { if (c.state.inspection !== null) inspected.resolve(); });
  const boundary = () => renderToStaticMarkup(createElement(StartupBoundary, { setup: setup.state, setupController: setup, machine: c.state, machineController: c, updates: null,
    children: createElement('p', null, `Operational view: ${c.state.status?.at ?? 'no status'}`) }));
  await setup.check();
  const waiting = boundary();
  reportReady = true;
  receive({ generation: 1, version: 3, event: 'status', status });
  await inspectionCalled.promise;
  const inspecting = boundary();
  inspectionReply.resolve({ profile: { repo: '/existing', revision: 'fixture', overrides: '/fixture/overrides', issues: [] }, items: [], probeErrors: [], status });
  await inspected.promise; await new Promise((resolve) => setTimeout(resolve, 0));
  const ready = boundary();
  try {
    assert.equal(c.state.connection, 'connected');
    assert.doesNotMatch(waiting, /NO_REPORT|agent has not responded|role="alert"/);
    assert.match(waiting, /starting|waiting|inspection/i);
    assert.doesNotMatch(waiting, /Operational view|<strong>/);
    assert.doesNotMatch(inspecting, /NO_REPORT|agent has not responded|role="alert"/);
    assert.match(ready, /Operational view: 2026-10-11T12:00:00Z/);
  } finally { setup.dispose(); c.dispose(); }
});
test('a failed initial inspection remains visible with a read-only retry after valid status', async () => {
  let fail = true;
  const bridge: Bridge = {
    subscribe: async () => () => {},
    invoke: async (command) => {
      if (command === 'inspect_machine' && fail) throw new Error('INSPECT_FAILED: fixture read failed');
      return { generation: 1, data: command === 'desktop_setup_state' ? { needsSetup: false, repo: '/existing', gitAvailable: true, canInstallGit: true, defaultRepoUrl: 'https://github.com/Nortus222/claude-config.git' }
        : command === 'agent_status' ? status
        : command === 'inspect_machine' ? { profile: { repo: '/existing', revision: 'fixture', overrides: '/fixture/overrides', issues: [] }, items: [], probeErrors: [], status } : null };
    },
  };
  const c = new MachineController(bridge); const setup = new SetupController(bridge, c);
  await setup.check();
  let rechecks = 0;
  const render = () => renderToStaticMarkup(createElement(StartupBoundary, { setup: setup.state, setupController: setup, machine: c.state, machineController: c, updates: null,
    children: createElement(ShellView, { screen: 'home', navigate: () => {}, machine: c.state, onReconnect: () => {}, onRecheck: () => { rechecks++; }, children: createElement('p', null, 'Home body') }) }));
  const markup = render();
  assert.match(markup, /class="alert shell-banner" role="alert"><div><strong>This Mac couldn’t be inspected.<\/strong> <span>fixture read failed<\/span>/);
  assert.match(markup, />Check again<\/button>/);
  assert.match(markup, /Home body/);
  assert.doesNotMatch(markup, /Opening Nortuscc|FIRST RUN|INSPECT_FAILED|>Reconnect</);
  fail = false;
  await c.inspect();
  const recovered = render();
  assert.doesNotMatch(recovered, /shell-banner|fixture read failed|Check again/);
  assert.equal(rechecks, 0);
  setup.dispose(); c.dispose();
});
test('first run displays fixed consent, all four choices and explicit Git installer/recheck', () => {
  const c = machine(); const setup = new SetupController(null, c);
  const state = { ...setup.state, phase: 'needed' as const, setup: { needsSetup: true, repo: null, gitAvailable: false, canInstallGit: true, defaultRepoUrl: 'https://github.com/Nortus222/claude-config.git' as const } };
  const markup = renderToStaticMarkup(createElement(SetupView, { state, controller: setup }));
  for (const label of ['https://github.com/Nortus222/claude-config.git', 'Claude and Codex', 'Claude only', 'Codex only', 'Neither', 'Install Git', 'Recheck Git', 'Use this repository and set up']) assert.ok(markup.includes(label), label);
  assert.match(markup, /Apple/);
  assert.match(markup, /NORTUSCC \/ FIRST RUN/); assert.doesNotMatch(markup, /Claude Config|CLAUDE CONFIG/);
  const browser = renderToStaticMarkup(createElement(SetupView, { state: setup.state, controller: setup }));
  assert.match(browser, /disabled=""/); assert.match(browser, /Native setup actions are disabled/);
});
test('before sign-in reporting is unchecked and native browser actions are disabled', () => {
  const c = machine(); const account = new AccountController(null, c);
  const markup = renderToStaticMarkup(createElement(SettingsView, { machine: c.state, state: { ...account.state, hosted }, controller: account, machineController: c }));
  assert.match(markup, /type="checkbox" disabled=""/); assert.doesNotMatch(markup, /checked=""/);
  assert.match(markup, /Sign in with GitHub/); assert.match(markup, /Reconnect agent/);
  assert.doesNotMatch(markup, /Open GitHub/);
});
test('pending sign-in shows only transient code, explicit browser action and cancel, with actual backoff', () => {
  const c = machine(); const account = new AccountController(null, c);
  const markup = renderToStaticMarkup(createElement(SettingsView, { machine: { ...c.state, connection: 'connected', status }, state: { ...account.state, flow: 'pending', code: { userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 }, hosted: { ...hosted, signingIn: true, retryAt: '2026-10-11T12:10:00Z', error: 'rate_limited' } }, controller: account, machineController: c }));
  assert.match(markup, /ABCD-1234/); assert.match(markup, /Open GitHub/); assert.match(markup, /Cancel sign-in/); assert.match(markup, /Retry after:.*2026-10-11T12:10:00Z/); assert.match(markup, /rate_limited/);
  assert.doesNotMatch(markup, /Sign in with GitHub/);
});
test('signed-in settings show identity, queue acknowledgement and profile following', () => {
  const c = machine(); const account = new AccountController(null, c);
  const markup = renderToStaticMarkup(createElement(SettingsView, { machine: { ...c.state, connection: 'connected', status }, state: { ...account.state, hosted: { ...hosted, auth: 'signed-in', accountId: 'account-a', login: 'fixture-login', machineId: 'machine-a', machine: { policy: 'notify', reportStatus: false }, setups: [{ setupId: 'setup-a', name: 'Offered fixture', repoUrl: 'https://example.com/fixture.git', profile: 'default', owned: true, latestRevision: 0 }], lastSyncAt: '2026-10-11T12:00:00Z' }, detail: 'Machine settings queued.' }, controller: account, machineController: c }));
  for (const label of ['Signed in as fixture-login', 'Sign out', 'Sync now / retry', 'New machine name', 'Queue name change', 'Resume automatic apply', 'https://example.com/fixture', 'Machine settings queued']) assert.ok(markup.includes(label), label);
  assert.doesNotMatch(markup, /Sign in with GitHub|checked=""/);
  assert.match(markup, /Follow this profile/);
  assert.doesNotMatch(markup, /Trust on this Mac|I trust this repository/);
});
test('item notifications open Changes; agent failures open Home', () => {
  for (const screen of ['home', 'skills', 'settings', 'publish', 'changes'] as const satisfies readonly Screen[]) assert.equal(screenForReview(screen, 1, 2, { ...status, paused: null }), 'changes');
  assert.equal(screenForReview('home', 1, 2, null), 'changes');
  assert.equal(screenForReview('publish', 1, 2, status), 'home', 'a paused agent sent the failure notification');
  assert.equal(screenForReview('skills', 1, 2, { ...status, paused: null, error: 'JOB_FAILED' }), 'home');
  assert.equal(screenForReview('settings', 2, 2, null), 'settings');
});

test('startup updates stay compact until a real update needs attention or a failed read needs retry', async () => {
  const bridge: Bridge = { subscribe: async () => () => {}, invoke: async () => ({ generation: 1, data: null }) };
  const c = new MachineController(bridge); const setup = new SetupController(bridge, c);
  const render = (updates: UpdateController) => renderToStaticMarkup(createElement(StartupBoundary, {
    setup: setup.state, setupController: setup, machine: c.state, machineController: c, updatesAttention: updateAttention(updates.state),
    updates: createElement(UpdateView, { state: updates.state, controller: updates }), children: null,
  }));
  try {
    for (const phase of ['idle', 'available', 'downloading', 'verified', 'error'] as const) {
      const updates = new UpdateController({ invoke: async () => ({ installedVersion: '0.1.5', enabled: true, automaticChecks: false, phase, availableVersion: phase === 'idle' ? null : '0.1.6', notes: null, downloadedBytes: 0, totalBytes: null, diagnostic: phase === 'error' ? 'Download failed.' : null }) }, () => () => {});
      await updates.start();
      const markup = render(updates);
      assert.match(markup, phase === 'idle' ? /<details class="startup-update-panel"><summary>/ : /<details class="startup-update-panel" open=""><summary>/);
      assert.match(markup, /Installed version: 0.1.5/);
      if (phase === 'available') { assert.match(markup, /Download update/); updates.defer(); assert.equal(updateAttention(updates.state), null); }
      if (phase === 'downloading') {
        assert.match(markup, /Total size is unknown/);
        assert.match(markup, /<progress aria-label="Update download"><\/progress>/);
        assert.match(markup, /<button>Cancel<\/button>/);
      }
      if (phase === 'verified') assert.match(markup, /Install and restart/);
      if (phase === 'error') assert.match(markup, /role="alert"[^>]*>Download failed/);
      updates.dispose();
    }
    const failed = new UpdateController({ invoke: async () => { throw new Error('private transport detail'); } }, () => () => {});
    await failed.start();
    assert.match(render(failed), /<details class="startup-update-panel" open=""><summary>/);
    assert.match(render(failed), /Retry check/);
    assert.doesNotMatch(render(failed), /private transport detail/);
    failed.dispose();
  } finally { setup.dispose(); c.dispose(); }
});


test('following an offered profile in Settings lands on Changes with the follow preview', async t => {
  const { fixture, run } = await import('./support/setup-sync.ts');
  const { SetupSyncController } = await import('../src/setup-sync-controller.ts');
  const f = await fixture(); const sync = new SetupSyncController(f.bridge, f.machine);
  t.after(() => { sync.dispose(); f.machine.dispose(); });
  f.handlers.inspectShareLink = input => ({ setupId: input.setupId, name: 'Team', repoUrl: 'https://github.com/example/profiles.git', profile: 'small', latestRevision: 0, access: 'readable' });
  f.handlers.previewChange = input => ({ planId: 'plan', scope: { kind: 'machine' }, generation: '1', change: input.change, plan: { kind: 'operation', steps: [], skipped: [] }, nextActions: [], droppedChoices: { holds: [], overrides: [] }, actionEffects: ['Inspect only'] });
  const account = new AccountController(null, f.machine);
  const visited: Screen[] = [];
  const element = OfferedSetup({ setup: { setupId: 'shared', name: 'Team', repoUrl: 'https://github.com/example/profiles.git', profile: 'small', owned: true, latestRevision: 0 }, controller: account, disabled: false, onFollowProfile: followFromSettings(sync, screen => visited.push(screen)) });
  const html = renderToStaticMarkup(element);
  assert.match(html, /Follow this profile/); assert.doesNotMatch(html, /Trust on this Mac/);
  const find = (node: any): any => !node || typeof node !== 'object' ? null : node.type === 'button' ? node : [node.props?.children].flat().map(find).find(Boolean);
  const button = find(element);
  await button.props.onClick();
  assert.deepEqual(visited, ['changes']);
  f.handlers.listRuns = () => ({ runs: [run({ state: 'succeeded', result: { status: 'done', ok: 1, failed: 0 } })], nextBefore: null });
  sync.enter(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sync.state.preview?.change, { kind: 'followProfile', repoUrl: 'https://github.com/example/profiles.git', profile: 'small', setupId: 'shared' });
  assert.equal(f.calls.some(call => call.name === 'applyChange'), false);
});
