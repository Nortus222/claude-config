import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountController, type AccountTimers } from '../src/account-controller.ts';
import { MachineController } from '../src/controller.ts';
import type { Bridge, Command, HostEvent } from '../src/bridge.ts';
export const status = (fields = {}) => ({ at: 'now', policy: 'notify', paused: null, trusted: true, pending: [], drift: [], conflicts: [], probeErrors: [], counts: { pending: 0, held: 0, ready: 0, drift: 0 }, ...fields });
export const hosted = (fields = {}) => ({ enabled: true, recovered: true, signingIn: false, accountId: null, login: null, machineId: null, auth: 'signed-out', setups: [], machine: null, lastSyncAt: null, retryAt: null, pollAfter: 900, error: null, ...fields });
export const signedIn = (fields = {}) => hosted({ auth: 'signed-in', accountId: 'account-a', login: 'fixture-login', machineId: 'machine-a', machine: { policy: 'notify', reportStatus: false }, ...fields });
export const code = { userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', interval: 5, expiresIn: 900 };
function fixture(handlers: Partial<Record<Command, (args?: Readonly<Record<string, unknown>>) => unknown>> = {}) {
  const calls: Array<[Command, unknown]> = [];
  let receive: (event: HostEvent) => void = () => {};
  let generation = 1;
  let now = 0;
  let task: (() => void) | undefined;
  let delay = 0;
  const timers: AccountTimers = { now: () => now, set: (callback, ms) => { task = callback; delay = ms; return 1; }, clear: () => { task = undefined; } };
  const bridge: Bridge = { subscribe: async (callback) => { receive = callback; return () => {}; }, invoke: async (command, args) => {
    calls.push([command, args]); const g = generation;
    const data = handlers[command] ? await handlers[command]!(args) : command === 'agent_status' ? status() : command === 'hosted_state' ? hosted() : command === 'inspect_machine' ? { profile: { repo: '/fixture', revision: 'fixture', overrides: '/fixture/overrides', issues: [] }, items: [], probeErrors: [] } : null;
    return { generation: g, data };
  } };
  const machine = new MachineController(bridge);
  const account = new AccountController(bridge, machine, timers);
  return { calls, machine, account, emit: (event: HostEvent) => receive(event), setGeneration: (value: number) => { generation = value; }, tick: async (ms = delay) => { now += ms; const callback = task; task = undefined; callback?.(); await account.idle(); }, hasTimer: () => !!task, delay: () => delay };
}
test('sign in explicitly defaults status sharing off and code stays pending until authenticated', async () => {
  let state = hosted();
  const f = fixture({ sign_in: () => { state = hosted({ signingIn: true }); return code; }, hosted_state: () => state });
  await f.machine.connect(); await f.account.refresh(); await f.account.signIn();
  assert.deepEqual(f.calls.find(([command]) => command === 'sign_in')?.[1], { reportStatus: false });
  assert.equal(f.account.state.flow, 'pending'); assert.equal(f.account.state.code?.userCode, 'ABCD-1234');
  await f.tick(); assert.equal(f.account.state.flow, 'pending');
  state = signedIn(); await f.tick();
  assert.equal(f.account.state.flow, 'success'); assert.equal(f.account.state.code, null); assert.equal(f.hasTimer(), false);
});
test('cancel serializes behind pending sign in and never reintroduces its late code', async () => {
  let resolve!: (value: unknown) => void;
  const f = fixture({ sign_in: () => new Promise((r) => { resolve = r; }), sign_out: () => hosted() });
  await f.machine.connect(); await f.account.refresh();
  const signing = f.account.signIn(); await Promise.resolve();
  const cancelled = f.account.signOut();
  assert.equal(f.account.state.code, null);
  assert.equal(f.calls.some(([command]) => command === 'sign_out'), false);
  resolve(code); await signing; await cancelled;
  assert.equal(f.account.state.flow, 'cancelled'); assert.equal(f.account.state.code, null); assert.equal(f.hasTimer(), false);
});
test('disconnect, restart and dispose fence late replies and stop pending polling', async () => {
  for (const action of ['disconnect', 'restart', 'dispose', 'machine-dispose']) {
    let resolve!: (value: unknown) => void;
    const f = fixture({ sign_in: () => new Promise((r) => { resolve = r; }) });
    await f.machine.connect(); await f.account.refresh();
    const signing = f.account.signIn(); await Promise.resolve();
    if (action === 'disconnect') f.emit({ generation: 1, event: 'disconnected', detail: 'fixture' });
    if (action === 'restart') { f.setGeneration(2); await f.machine.restart(); }
    if (action === 'dispose') f.account.dispose();
    if (action === 'machine-dispose') f.machine.dispose();
    resolve(code); await signing;
    assert.equal(f.account.state.code, null, action); assert.equal(f.hasTimer(), false, action);
  }
});
test('pending code expires on an injected bounded timer without revoking account credentials', async () => {
  const f = fixture({ sign_in: () => ({ ...code, expiresIn: 2, interval: 9999 }), sign_out: () => hosted() });
  await f.machine.connect(); await f.account.refresh(); await f.account.signIn();
  assert.equal(f.delay(), 2000);
  await f.tick();
  assert.equal(f.account.state.flow, 'expired'); assert.equal(f.account.state.code, null);
  assert.equal(f.calls.filter(([command]) => command === 'sign_out').length, 0); assert.equal(f.hasTimer(), false);
});
test('pending backoff stays visible and uses bounded polling, then terminal expiry stops it', async () => {
  let state = hosted({ signingIn: true, retryAt: '2026-10-11T12:00:00Z', error: 'rate_limited' });
  const f = fixture({ sign_in: () => code, hosted_state: () => state });
  await f.machine.connect(); await f.account.refresh();
  assert.equal(f.account.state.flow, 'pending'); assert.equal(f.delay(), 60000);
  state = hosted({ error: 'sign_in_expired' }); await f.tick();
  assert.equal(f.account.state.flow, 'expired'); assert.equal(f.hasTimer(), false);
});
test('an account change clears the transient code and stops old-account polling', async () => {
  let state = hosted({ accountId: 'old-account' });
  const f = fixture({ hosted_state: () => state, sign_in: () => code });
  await f.machine.connect(); await f.account.refresh(); await f.account.signIn();
  state = hosted({ accountId: 'other-account', signingIn: true }); await f.tick();
  assert.equal(f.account.state.code, null); assert.equal(f.hasTimer(), false);
});
test('strict malformed account and sign-in responses never print rejected values', async () => {
  for (const command of ['hosted_state', 'sign_in', 'sign_out', 'sync_now', 'machine_settings', 'trust_setup', 'set_policy', 'resume_agent', 'open_device_login'] as const) {
    const setup = { setupId: 'setup-a', name: 'Fixture', repoUrl: 'https://example.com/fixture.git', profile: 'default', owned: true, latestRevision: 0 };
    const f = fixture({ hosted_state: () => command === 'hosted_state' ? { ...hosted(), token: 'SECRET' } : signedIn({ setups: [setup] }), [command]: () => ({ token: 'SECRET', unknown: 'SECRET' }), agent_status: () => status({ paused: { at: 'now', reason: 'fixture' } }) });
    await f.machine.connect(); await f.account.refresh();
    if (command === 'sign_in' || command === 'open_device_login') {
      const signedOut = fixture({ hosted_state: () => hosted(), sign_in: () => command === 'sign_in' ? { ...code, token: 'SECRET' } : code, open_device_login: () => ({ opened: true, token: 'SECRET' }) });
      await signedOut.machine.connect(); await signedOut.account.refresh(); await signedOut.account.signIn();
      if (command === 'open_device_login') await signedOut.account.openGitHub();
      assert.equal(signedOut.account.state.flow, 'error'); assert.doesNotMatch(signedOut.account.state.detail, /SECRET|token/); assert.equal(signedOut.hasTimer(), false);
      continue;
    }
    if (command === 'sign_out') await f.account.signOut();
    if (command === 'sync_now') await f.account.syncNow();
    if (command === 'machine_settings') await f.account.machineSettings({ name: 'New name' });
    if (command === 'trust_setup') await f.account.trustSetup('setup-a', true);
    if (command === 'set_policy') await f.account.setPolicy('manual');
    if (command === 'resume_agent') await f.account.resume();
    assert.equal(f.account.state.flow, 'error', command); assert.doesNotMatch(f.account.state.detail, /SECRET|token/);
  }
});
test('only a consented offered setup ID can be trusted, with an honest acknowledgement', async () => {
  const state = signedIn({ setups: [{ setupId: 'setup-a', name: 'Fixture', repoUrl: 'https://example.com/fixture.git', profile: 'default', owned: true, latestRevision: 0 }] });
  const f = fixture({ hosted_state: () => state, trust_setup: () => state });
  await f.machine.connect(); await f.account.refresh();
  await f.account.trustSetup('setup-a', false); await f.account.trustSetup('unknown', true);
  assert.equal(f.calls.some(([command]) => command === 'trust_setup'), false);
  await f.account.trustSetup('setup-a', true);
  assert.deepEqual(f.calls.find(([command]) => command === 'trust_setup')?.[1], { setupId: 'setup-a' });
  assert.match(f.account.state.detail, /acknowledged/);
});
test('name and reporting changes acknowledge a local queue; policy keeps pauses until explicit resume', async () => {
  const pause = { at: 'now', reason: 'Cancelled' };
  const f = fixture({ hosted_state: () => signedIn(), machine_settings: () => signedIn(), set_policy: () => status({ policy: 'manual', paused: pause }), resume_agent: () => status({ policy: 'manual' }) });
  await f.machine.connect(); await f.account.refresh();
  await f.account.machineSettings({ name: 'Office Mac', reportStatus: false });
  assert.match(f.account.state.detail, /queued/);
  await f.account.setPolicy('manual');
  assert.deepEqual(f.machine.state.status?.paused, pause);
  await f.account.resume(); assert.equal(f.machine.state.status?.paused, null);
});
test('authenticated accounts cannot be replaced and browser/local-only review needs no account', async () => {
  const f = fixture({ hosted_state: () => signedIn() });
  await f.machine.connect(); await f.account.refresh(); await f.account.signIn();
  assert.equal(f.calls.some(([command]) => command === 'sign_in'), false);
  const disabled = fixture({ hosted_state: () => hosted({ enabled: false }) });
  await disabled.machine.connect(); await disabled.account.refresh(); await disabled.account.signIn();
  assert.equal(disabled.machine.state.connection, 'connected'); assert.equal(disabled.calls.some(([command]) => command === 'sign_in'), false);
  const browser = new AccountController(null, new MachineController(null));
  await browser.refresh(); await browser.signIn(); await browser.syncNow(); await browser.signOut();
  assert.equal(browser.state.hosted, null);
});

test('completion at the code deadline reads authoritative sign-in and never signs out', async () => {
  let state = hosted();
  const f = fixture({ sign_in: () => ({ ...code, expiresIn: 1 }), hosted_state: () => state });
  await f.machine.connect(); await f.account.refresh(); await f.account.signIn();
  state = signedIn(); await f.tick(1000);
  assert.equal(f.account.state.hosted?.auth, 'signed-in');
  assert.equal(f.account.state.flow, 'success');
  assert.equal(f.account.state.code, null);
  assert.equal(f.calls.some(([command]) => command === 'sign_out'), false);
});
test('sign-out fences an older in-flight hosted reply and stops its poll timer', async () => {
  let resolve!: (value: unknown) => void;
  let slow = false;
  const f = fixture({ hosted_state: () => slow ? new Promise((r) => { resolve = r; }) : hosted(), sign_in: () => code, sign_out: () => hosted() });
  await f.machine.connect(); await f.account.refresh(); await f.account.signIn();
  slow = true;
  const refresh = f.account.refresh(); await Promise.resolve();
  const signOut = f.account.signOut(); resolve(hosted({ signingIn: true }));
  await refresh; await signOut;
  assert.equal(f.account.state.flow, 'cancelled'); assert.equal(f.account.state.code, null); assert.equal(f.hasTimer(), false);
});
test('a pending timer and late browser acknowledgement cannot survive disconnect or disposal', async () => {
  for (const action of ['disconnect', 'dispose']) {
    let resolve!: (value: unknown) => void;
    const f = fixture({ sign_in: () => code, open_device_login: () => new Promise((r) => { resolve = r; }) });
    await f.machine.connect(); await f.account.refresh(); await f.account.signIn();
    assert.equal(f.hasTimer(), true);
    const opening = f.account.openGitHub(); await Promise.resolve();
    if (action === 'disconnect') f.emit({ generation: 1, event: 'disconnected', detail: 'fixture' }); else f.account.dispose();
    const detail = f.account.state.detail;
    resolve({ opened: true }); await opening;
    assert.equal(f.hasTimer(), false); assert.equal(f.account.state.detail, detail);
  }
});
test('a status reply from another generation cannot alter the current machine view', async () => {
  const f = fixture({ hosted_state: () => { f.setGeneration(2); return signedIn(); }, set_policy: () => status({ policy: 'manual' }) });
  await f.machine.connect(); await f.account.refresh();
  const statusBefore = f.machine.state.status;
  await f.account.setPolicy('manual');
  assert.equal(f.account.state.hosted?.auth, 'signed-in');
  assert.equal(f.machine.state.status, statusBefore);
});
test('an explicit reporting choice is sent locally with sign-in and fixed browser action needs a person', async () => {
  const f = fixture({ sign_in: () => code, open_device_login: () => ({ opened: true }) });
  await f.machine.connect(); await f.account.refresh();
  f.account.chooseReporting(true); await f.account.signIn('Office Mac');
  assert.deepEqual(f.calls.find(([command]) => command === 'sign_in')?.[1], { name: 'Office Mac', reportStatus: true });
  assert.equal(f.calls.some(([command]) => command === 'open_device_login'), false);
  await f.account.openGitHub();
  assert.equal(f.calls.filter(([command]) => command === 'open_device_login').length, 1);
  assert.equal(f.calls.find(([command]) => command === 'open_device_login')?.[1], undefined);
});
test('sync refresh shows returned freshness and recovery errors without inventing success', async () => {
  const f = fixture({ hosted_state: () => signedIn(), sync_now: () => signedIn({ lastSyncAt: '2026-10-11T12:00:00Z', retryAt: '2026-10-11T12:10:00Z', error: 'network' }) });
  await f.machine.connect(); await f.account.refresh(); await f.account.syncNow();
  assert.equal(f.account.state.hosted?.lastSyncAt, '2026-10-11T12:00:00Z');
  assert.equal(f.account.state.hosted?.retryAt, '2026-10-11T12:10:00Z');
  assert.equal(f.account.state.hosted?.error, 'network');
  assert.doesNotMatch(f.account.state.detail, /Sync complete|Synced successfully/);
});

test('ordinary inspection refresh preserves the account flow within its current machine session', async () => {
  const f = fixture({ sign_in: () => code });
  await f.machine.connect(); await f.account.refresh(); await f.account.signIn();
  const before = f.machine.sessionToken();
  await f.machine.inspect();
  assert.deepEqual(f.machine.sessionToken(), before);
  assert.equal(f.account.state.flow, 'pending');
  assert.equal(f.account.state.code?.userCode, 'ABCD-1234');
  assert.equal(f.hasTimer(), true);
});
