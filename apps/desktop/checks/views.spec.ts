import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SetupView, StartupBoundary, SettingsView, OverviewView, ResolvedView, ShellView, screenForReview } from '../src/views.tsx';
import { ReviewView } from '../src/review-view.tsx';
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
test('browser preview has only implemented navigation and real empty states', () => {
  const c = machine();
  const markup = renderToStaticMarkup(createElement(ShellView, { screen: 'overview', navigate: () => {}, children: createElement(OverviewView, { state: c.state, navigate: () => {} }) }));
  for (const name of ['Claude Config', 'Overview', 'Review &amp; apply', 'Resolved', 'Settings']) assert.match(markup, new RegExp(name));
  for (const name of ['Discover', 'Machines', 'History', 'Publish', 'Updates', 'fixture-login']) assert.doesNotMatch(markup, new RegExp(name));
  assert.match(markup, /Browser preview/);
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
  const renderStartup = () => renderToStaticMarkup(createElement(StartupBoundary, { setup: setup.state, setupController: setup, machine: c.state, machineController: c, updates: createElement('p', null, 'Updates remain available'), children: createElement(OverviewView, { state: c.state, navigate: () => {} }) }));
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
    assert.match(waiting, /Updates remain available/);
    assert.doesNotMatch(waiting, /FIRST RUN|Set up this Mac|Configurations to manage|Use this repository and set up/);
    assert.match(connecting, /Connecting to the local agent/);
    assert.match(connecting, /Updates remain available/);
    assert.doesNotMatch(connecting, /role="alert"|Last inspection:|<strong>/);
    for (const markup of [readingStatus, inspecting]) {
      assert.match(markup, /Reading local inspection/);
      assert.match(markup, /Updates remain available/);
      assert.doesNotMatch(markup, /FIRST RUN|role="alert"|Last inspection:|<strong>/);
    }
    assert.equal(c.state.connection, 'connected');
    assert.equal(c.state.inspection?.profile.repo, '/existing');
    assert.equal(calls.includes('setup_desktop'), false);
  } finally { setup.dispose(); c.dispose(); }
});
test('an early active apply leaves the startup boundary with cancellation available', async () => {
  const routing = heldReply<unknown>(); const routed = heldReply<void>();
  const calls: string[] = [];
  let receive: (event: HostEvent) => void = () => {};
  const bridge: Bridge = {
    subscribe: async (listener) => { receive = listener; return () => {}; },
    invoke: async (command) => {
      calls.push(command);
      if (command === 'agent_generation') receive({ generation: 1, version: 3, event: 'status', status: { ...status, applying: true } });
      return { generation: 1, data: command === 'desktop_setup_state' ? { needsSetup: false, repo: '/existing', gitAvailable: true, canInstallGit: true, defaultRepoUrl: 'https://github.com/Nortus222/claude-config.git' }
        : command === 'take_review_request' ? (routed.resolve(), await routing.promise)
        : command === 'agent_status' ? { ...status, applying: true }
        : command === 'cancel_apply' ? { cancelled: true } : null };
    },
  };
  const c = new MachineController(bridge); const setup = new SetupController(bridge, c);
  const check = setup.check(); await routed.promise;
  const markup = renderToStaticMarkup(createElement(StartupBoundary, { setup: setup.state, setupController: setup, machine: c.state, machineController: c, updates: null,
    children: createElement(ReviewView, { state: c.state, controller: c }) }));
  await c.cancel();
  routing.resolve(null); await check;
  assert.doesNotMatch(markup, /Opening Claude Config|FIRST RUN|disabled="">Cancel/);
  assert.match(markup, /Cancel<\/button>/);
  assert.ok(calls.includes('cancel_apply'));
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
  await setup.check();
  const waiting = renderToStaticMarkup(createElement(OverviewView, { state: c.state, navigate: () => {} }));
  reportReady = true;
  receive({ generation: 1, version: 3, event: 'status', status });
  await inspectionCalled.promise;
  const inspecting = renderToStaticMarkup(createElement(OverviewView, { state: c.state, navigate: () => {} }));
  inspectionReply.resolve({ profile: { repo: '/existing', revision: 'fixture', overrides: '/fixture/overrides', issues: [] }, items: [], probeErrors: [], status });
  await inspected.promise;
  const ready = renderToStaticMarkup(createElement(OverviewView, { state: c.state, navigate: () => {} }));
  try {
    assert.equal(c.state.connection, 'connected');
    assert.doesNotMatch(waiting, /NO_REPORT|agent has not responded|role="alert"/);
    assert.match(waiting, /starting|waiting|inspection/i);
    assert.doesNotMatch(waiting, /Last inspection:|<strong>/);
    assert.doesNotMatch(inspecting, /NO_REPORT|agent has not responded|role="alert"/);
    assert.match(ready, /Last inspection: 2026-10-11T12:00:00Z/);
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
  const markup = renderToStaticMarkup(createElement(StartupBoundary, { setup: setup.state, setupController: setup, machine: c.state, machineController: c, updates: null,
    children: createElement(OverviewView, { state: c.state, navigate: () => {}, controller: c }) }));
  assert.match(markup, /role="alert"[^>]*>INSPECT_FAILED: fixture read failed/);
  assert.match(markup, /Recheck inspection/);
  assert.doesNotMatch(markup, /Opening Claude Config|FIRST RUN/);
  fail = false;
  await c.inspect();
  const recovered = renderToStaticMarkup(createElement(OverviewView, { state: c.state, navigate: () => {}, controller: c }));
  assert.doesNotMatch(recovered, /INSPECT_FAILED|Recheck inspection/);
  setup.dispose(); c.dispose();
});
test('first run displays fixed consent, all four choices and explicit Git installer/recheck', () => {
  const c = machine(); const setup = new SetupController(null, c);
  const state = { ...setup.state, phase: 'needed' as const, setup: { needsSetup: true, repo: null, gitAvailable: false, canInstallGit: true, defaultRepoUrl: 'https://github.com/Nortus222/claude-config.git' as const } };
  const markup = renderToStaticMarkup(createElement(SetupView, { state, controller: setup }));
  for (const label of ['https://github.com/Nortus222/claude-config.git', 'Claude and Codex', 'Claude only', 'Codex only', 'Neither', 'Install Git', 'Recheck Git', 'Use this repository and set up']) assert.ok(markup.includes(label), label);
  assert.match(markup, /Apple/);
  const browser = renderToStaticMarkup(createElement(SetupView, { state: setup.state, controller: setup }));
  assert.match(browser, /disabled=""/); assert.match(browser, /Native setup actions are disabled/);
});
test('before sign-in reporting is unchecked and native browser actions are disabled', () => {
  const c = machine(); const account = new AccountController(null, c);
  const markup = renderToStaticMarkup(createElement(SettingsView, { machine: c.state, state: { ...account.state, hosted }, controller: account, machineController: c }));
  assert.match(markup, /type="checkbox" disabled=""/); assert.doesNotMatch(markup, /checked=""/);
  assert.match(markup, /Sign in with GitHub/); assert.match(markup, /Restart \/ reinstall agent/);
  assert.doesNotMatch(markup, /Open GitHub/);
});
test('pending sign-in shows only transient code, explicit browser action and cancel, with actual backoff', () => {
  const c = machine(); const account = new AccountController(null, c);
  const markup = renderToStaticMarkup(createElement(SettingsView, { machine: { ...c.state, connection: 'connected', status }, state: { ...account.state, flow: 'pending', code: { userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 }, hosted: { ...hosted, signingIn: true, retryAt: '2026-10-11T12:10:00Z', error: 'rate_limited' } }, controller: account, machineController: c }));
  assert.match(markup, /ABCD-1234/); assert.match(markup, /Open GitHub/); assert.match(markup, /Cancel sign-in/); assert.match(markup, /Retry after:.*2026-10-11T12:10:00Z/); assert.match(markup, /rate_limited/);
  assert.doesNotMatch(markup, /Sign in with GitHub/);
});
test('signed-in settings show identity, queue acknowledgement and explicit unchecked repository consent', () => {
  const c = machine(); const account = new AccountController(null, c);
  const markup = renderToStaticMarkup(createElement(SettingsView, { machine: { ...c.state, connection: 'connected', status }, state: { ...account.state, hosted: { ...hosted, auth: 'signed-in', accountId: 'account-a', login: 'fixture-login', machineId: 'machine-a', machine: { policy: 'notify', reportStatus: false }, setups: [{ setupId: 'setup-a', name: 'Offered fixture', repoUrl: 'https://example.com/fixture.git', latestRevision: 0 }], lastSyncAt: '2026-10-11T12:00:00Z' }, detail: 'Machine settings queued.' }, controller: account, machineController: c }));
  for (const label of ['Signed in as fixture-login', 'Sign out', 'Sync now / retry', 'New machine name', 'Queue name change', 'Resume automatic apply', 'https://example.com/fixture.git', 'I trust this repository', 'Machine settings queued']) assert.ok(markup.includes(label), label);
  assert.doesNotMatch(markup, /Sign in with GitHub|checked=""/);
  assert.match(markup, /button disabled="">Trust on this Mac/);
});
test('overview and resolved render only current inspection counts and provenance', () => {
  const c = machine();
  const state = { ...c.state, status, inspection: { profile: { repo: '/fixture', revision: 'fixture-revision', overrides: '/fixture/overrides', issues: [] }, items: [{ key: 'config:a', domain: 'config' as const, label: 'Fixture item', group: 'Files', state: 'repo-ahead', disposition: 'apply' as const, from: { layer: 'machine' as const, source: '/fixture/overrides' } }], probeErrors: [] } };
  const overview = renderToStaticMarkup(createElement(OverviewView, { state, navigate: () => {} }));
  assert.match(overview, /Pending.*<strong>3/); assert.match(overview, /Cancelled/); assert.match(overview, /2026-10-11T12:00:00Z/);
  const resolved = renderToStaticMarkup(createElement(ResolvedView, { state, controller: c }));
  assert.match(resolved, /Fixture item/); assert.match(resolved, /machine · \/fixture\/overrides/);
  assert.doesNotMatch(resolved, /type="checkbox"|Add override|Remove override|diff/i);
});
test('Review remains usable locally with selection, preview and external activity cancellation', () => {
  const c = machine();
  const markup = renderToStaticMarkup(createElement(ReviewView, { controller: c, state: { ...c.state, connection: 'connected', status: { ...status, applying: true } } }));
  assert.match(markup, /Review &amp; apply/); assert.match(markup, /Cancel<\/button>/); assert.doesNotMatch(markup, /disabled="">Cancel<\/button>/); assert.match(markup, /Automatic apply paused/);
});
test('new notification requests route every screen to Review without previewing or applying', () => {
  for (const screen of ['overview', 'resolved', 'settings', 'review'] as const) assert.equal(screenForReview(screen, 1, 2), 'review');
  assert.equal(screenForReview('settings', 2, 2), 'settings');
});
