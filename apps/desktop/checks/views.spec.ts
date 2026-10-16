import test from 'node:test';
import { skillRun } from './support/skill-run.ts';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SetupView, StartupBoundary, updateAttention, SettingsView, OverviewView, ResolvedView, ShellView, screenForReview } from '../src/views.tsx';
import { UpdateController } from '../src/update-controller.ts';
import { UpdateView } from '../src/update-view.tsx';
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
  const markup = renderToStaticMarkup(createElement(SettingsView, { machine: { ...c.state, connection: 'connected', status }, state: { ...account.state, hosted: { ...hosted, auth: 'signed-in', accountId: 'account-a', login: 'fixture-login', machineId: 'machine-a', machine: { policy: 'notify', reportStatus: false }, setups: [{ setupId: 'setup-a', name: 'Offered fixture', repoUrl: 'https://example.com/fixture.git', profile: 'default', owned: true, latestRevision: 0 }], lastSyncAt: '2026-10-11T12:00:00Z' }, detail: 'Machine settings queued.' }, controller: account, machineController: c }));
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


test('addition view separates saved intent, native evidence limits and blocked suggestions', () => {
  const c = machine(); const receipt = skillRun();
  c.state = { ...c.state, run: { runId: receipt.runId, steps: [], outcome: 'done', summary: '', receipt } };
  const markup = renderToStaticMarkup(createElement(ReviewView, { state: c.state, controller: c }));
  for (const text of ['Machine intent: saved', 'Installation: verified', 'owner/repo', 'design-review', 'claude', 'Codex also scans', 'does not attest the selected source or invocation authorization', 'Managed startup remains active', 'Do you want to share it with your other machines?', 'Promote to profile', 'personal sharing workflow', 'profile publication workflow', 'Required destination: user', 'Required destination: profile']) assert.ok(markup.includes(text), text);
  assert.doesNotMatch(markup, /Requested via/);
  assert.doesNotMatch(markup, /<button[^>]*>.*?(Share|Promote)/);
});
for (const intentState of ['saved', 'needsInspection'] as const) for (const installationState of ['failed', 'cancelled', 'needsInspection', undefined] as const) test(`addition view preserves ${intentState} intent without success or suggestions for ${installationState}`, () => {
  const c = machine(); const original = skillRun();
  const receipt = skillRun({ state: 'failed', intentSaved: intentState === 'saved', intentState, installation: installationState ? { ...original.installation!, state: installationState, nextActions: [] } : undefined });
  c.state = { ...c.state, run: { runId: receipt.runId, steps: [], outcome: 'failed', summary: '', receipt } };
  const markup = renderToStaticMarkup(createElement(ReviewView, { state: c.state, controller: c }));
  assert.match(markup, new RegExp(`Machine intent: ${intentState === 'saved' ? 'saved' : 'needs inspection'}`));
  assert.match(markup, new RegExp(`Installation: ${installationState === 'needsInspection' ? 'needs inspection' : installationState ?? 'not verified'}`));
  assert.doesNotMatch(markup, /Do you want to share|Promote to profile|Installation: verified/);
});


test('addition view displays the receipt owner actor when present', () => {
  const c = machine(); const receipt = skillRun({ actor: 'mcp' });
  c.state = { ...c.state, run: { runId: receipt.runId, steps: [], outcome: 'done', summary: '', receipt } };
  assert.match(renderToStaticMarkup(createElement(ReviewView, { state: c.state, controller: c })), /Requested via mcp/);
});

import { decodeRunView, type OperationChange } from '@nortuscc/agent/operations';
const semanticRun = (change: OperationChange, extra: object = {}) => {
  const author = { checkout: '/author', realCheckout: '/author', gitDir: '/author/.git', head: 'c'.repeat(40), files: [] };
  return decodeRunView({ runId: 'semantic', actor: 'mcp', state: 'failed', operation: 'applyChange', scope: {kind:'machine'},
    intent: {requestId:'semantic-request', inputDigest:'a'.repeat(64), planId:'p', change,
      parity: {kind:change.kind, generation:'1', baselineDigest:'a'.repeat(64), planDigest:'b'.repeat(64), plannedKeys:['first','second'], ...(change.kind==='capture'?{author}:{})}},
    intentSaved:false, steps:[], result:{status:'failed',message:'Inspect effects'},
    parity: {kind:change.kind,state:'needsInspection',committedKeys:['first'],remainingKeys:['second'],backupIds:['backup'],...extra},
  });
};
const semanticMarkup = (receipt: ReturnType<typeof semanticRun>) => {
  const c = machine(); c.state={...c.state,run:{runId:receipt.runId,outcome:'failed',summary:'Inspect effects',steps:[],receipt}};
  return renderToStaticMarkup(createElement(ReviewView,{controller:c,state:c.state}));
};
test('semantic run view shows author destination, partial evidence and exact attribution', () => {
  const text = semanticMarkup(semanticRun({kind:'capture',only:['config:claude:CLAUDE.md'],takeLocal:true,allowShrink:false}));
  for(const expected of ['Capture configuration','Author destination','/author','Committed effects','Remaining effects','first','second','backup','uncertain','semantic-request','Requested via mcp']) assert.ok(text.includes(expected),expected);
  assert.doesNotMatch(text,/share it with your other machines/);
});
test('metadata run distinguishes local queueing from confirmed persistence', () => {
  const text=semanticMarkup(semanticRun({kind:'patchMachineMetadata',patch:{name:'fixture'}},{metadata:'locally-queued'}));
  assert.match(text,/locally queued/); assert.match(text,/not confirmed/);
});
for(const state of ['awaiting-user','expired','needsInspection'] as const) test(`sign-in view treats ${state} as initiation only`, () => {
  const text=semanticMarkup(semanticRun({kind:'signIn'},{signIn:{kind:'signIn',state,expiresAt:'2099-10-15T00:00:00.000Z',...(state==='awaiting-user'?{userCode:'ABCD-EFGH',verificationUri:'https://github.com/login/device'}:{})}}));
  assert.match(text,/authorization initiation/); assert.match(text,/2099-10-15/);
  if(state==='awaiting-user')assert.match(text,/ABCD-EFGH/);
  else {assert.match(text,/challenge unavailable/i);assert.doesNotMatch(text,/ABCD-EFGH|login\/device/);}
  assert.doesNotMatch(text,/Authenticated|Authentication failed/);
});

test('machine intent view names reset rather than implying an installation effect', () => {
 const text=semanticMarkup(semanticRun({kind:'machineIntent',patch:{kind:'manageConfig',action:'reset'}},{intentState:'saved',routingEffects:[]}));
 assert.match(text,/manageConfig: reset/);assert.match(text,/does not physically remove content/);
});
