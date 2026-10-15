import test from 'node:test';
import assert from 'node:assert/strict';
import { MachineController, advance, canCancel, type RunView } from '../src/controller.ts';
import { skillRun } from './support/skill-run.ts';
import type { Bridge, Command, HostEvent } from '../src/bridge.ts';

const step = (key: string) => ({ key, domain: 'config', action: 'write-file', summary: `write ${key}`, touches: [key], interruptible: false });
const status = (fields = {}) => ({ at: 'now', policy: 'notify', paused: null, trusted: true, pending: [], drift: [], conflicts: [], probeErrors: [], counts: { pending: 0, held: 0, ready: 0, drift: 0 }, ...fields });
const inspection = (keys: string[]) => ({
  profile: { repo: '/r', revision: 'abc', overrides: '/s/overrides.json', issues: [] },
  items: keys.map((key) => ({ key, domain: 'config', target: 'claude', label: key, group: 'Files', state: 'repo-ahead', disposition: 'apply' })),
  probeErrors: [],
  status: status(),
});
const plan = (keys: string[]) => ({ kind: 'apply', steps: keys.map(step), skipped: [] });
const event = (runId: string, progress: unknown, generation = 1): HostEvent => ({ generation, version: 3, event: 'progress', runId, progress } as HostEvent);

type Handler = (args?: Readonly<Record<string, unknown>>) => unknown;
function fake(handlers: Partial<Record<Command, Handler>>, generation = 1) {
  const calls: Array<[Command, unknown]> = [];
  let receive: (event: HostEvent) => void = () => {};
  const bridge: Bridge = {
    subscribe: async (r) => {
      calls.push(['subscribe' as Command, undefined]);
      receive = r;
      return () => {};
    },
    invoke: async (command, args) => {
      calls.push([command, args]);
      const handler = handlers[command];
      const data = handler ? await handler(args) : command === 'agent_status' ? status() : null;
      return { generation, data };
    },
  };
  return { bridge, calls, emit: (e: HostEvent) => receive(e) };
}

test('connect subscribes, learns the generation, then inspects', async () => {
  const f = fake({ inspect_machine: () => inspection(['config:a']) });
  const c = new MachineController(f.bridge);
  await c.connect();
  assert.deepEqual(f.calls.map(([name]) => name), ['subscribe', 'agent_generation', 'take_review_request', 'agent_status', 'inspect_machine']);
  assert.equal(c.state.connection, 'connected');
  assert.equal(c.snapshot().inspection?.items.length, 1);
});

test('a failed inspect keeps the app connected and shows why', async () => {
  const f = fake({ inspect_machine: () => { throw new Error("REPO_NOT_FOUND: the recorded checkout /old is not a nortuscc checkout. Run 'nortuscc setup --dir <checkout>'"); } });
  const c = new MachineController(f.bridge);
  await c.connect();
  assert.equal(c.state.connection, 'connected');
  assert.equal(c.state.inspection, null);
  assert.match(c.state.detail, /\/old/);
});

test('toggling excludes a key from the preview and clears a stale preview', async () => {
  const f = fake({ inspect_machine: () => inspection(['config:a', 'config:b']), preview_plan: () => ({ planId: 'p1', plan: plan(['config:a']) }) });
  const c = new MachineController(f.bridge);
  await c.connect();
  await c.previewPlan();
  assert.equal(c.state.preview?.planId, 'p1');
  c.toggle('config:b');
  assert.equal(c.state.preview, null);
  await c.previewPlan();
  assert.deepEqual(f.calls.filter(([n]) => n === 'preview_plan').map(([, a]) => a), [{ exclude: [] }, { exclude: ['config:b'] }]);
});

test('apply replays early events, tracks steps, and re-inspects when done', async () => {
  let inspects = 0;
  const f = fake({
    inspect_machine: () => (++inspects, inspection(['config:a', 'config:b'])),
    preview_plan: () => ({ planId: 'p1', plan: plan(['config:a', 'config:b']) }),
    apply_plan: () => {
      f.emit(event('r1', { type: 'started', index: 0, total: 2, step: step('config:a') }));
      return { status: 'started', runId: 'r1' };
    },
  });
  const c = new MachineController(f.bridge);
  await c.connect();
  await c.previewPlan();
  await c.apply();
  assert.deepEqual(f.calls.find(([n]) => n === 'apply_plan')?.[1], { planId: 'p1' });
  assert.deepEqual(c.state.run?.steps.map((s) => s.status), ['running', 'pending']);
  f.emit(event('other', { type: 'done', ok: 9, failed: 0 }));
  f.emit(event('r1', { type: 'done', ok: 9, failed: 0 }, 0));
  assert.equal(c.state.run?.outcome, 'running');
  f.emit(event('r1', { type: 'finished', index: 0, total: 2, key: 'config:a', outcome: 'ok', note: '' }));
  f.emit(event('r1', { type: 'started', index: 1, total: 2, step: step('config:b') }));
  f.emit(event('r1', { type: 'finished', index: 1, total: 2, key: 'config:b', outcome: 'failed', note: 'disk full' }));
  f.emit(event('r1', { type: 'done', ok: 1, failed: 1, backups: '/b/nortuscc-1' }));
  assert.equal(c.state.run?.outcome, 'done');
  assert.equal(c.state.run?.backups, '/b/nortuscc-1');
  assert.deepEqual(c.state.run?.steps.map((s) => [s.status, s.note]), [['ok', ''], ['failed', 'disk full']]);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(inspects, 2);
  assert.equal(c.state.preview, null);
});

test('a terminal event buffered during the apply request re-inspects exactly once', async () => {
  let inspects = 0;
  const f = fake({
    inspect_machine: () => (++inspects, inspection(['config:a'])),
    preview_plan: () => ({ planId: 'p1', plan: plan(['config:a']) }),
    apply_plan: () => {
      f.emit(event('r1', { type: 'started', index: 0, total: 1, step: step('config:a') }));
      f.emit(event('r1', { type: 'finished', index: 0, total: 1, key: 'config:a', outcome: 'ok', note: '' }));
      f.emit(event('r1', { type: 'done', ok: 1, failed: 0 }));
      return { status: 'started', runId: 'r1' };
    },
  });
  const c = new MachineController(f.bridge);
  await c.connect();
  await c.previewPlan();
  await c.apply();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(c.state.run?.outcome, 'done');
  assert.equal(c.state.preview, null);
  assert.equal(c.state.pending, false);
  assert.equal(inspects, 2);
});

test('a stale apply replaces the preview and starts nothing', async () => {
  const f = fake({
    inspect_machine: () => inspection(['config:a']),
    preview_plan: () => ({ planId: 'p1', plan: plan(['config:a']) }),
    apply_plan: () => ({ status: 'stale', planId: 'p2', plan: plan(['config:a', 'config:new']) }),
  });
  const c = new MachineController(f.bridge);
  await c.connect();
  await c.previewPlan();
  await c.apply();
  assert.equal(c.state.run, null);
  assert.equal(c.state.preview?.planId, 'p2');
  assert.match(c.state.detail, /changed since this preview/);
});

test('cancel reaches the agent and a cancelled run keeps unstarted steps pending', async () => {
  const f = fake({
    inspect_machine: () => inspection(['config:a', 'config:b']),
    preview_plan: () => ({ planId: 'p1', plan: plan(['config:a', 'config:b']) }),
    apply_plan: () => ({ status: 'started', runId: 'r1' }),
    cancel_apply: () => ({ cancelled: true }),
  });
  const c = new MachineController(f.bridge);
  await c.connect();
  await c.previewPlan();
  await c.apply();
  f.emit(event('r1', { type: 'started', index: 0, total: 2, step: step('config:a') }));
  await c.cancel();
  assert.ok(f.calls.some(([n]) => n === 'cancel_apply'));
  f.emit(event('r1', { type: 'finished', index: 0, total: 2, key: 'config:a', outcome: 'cancelled', note: 'cancelled' }));
  f.emit(event('r1', { type: 'cancelled', remaining: ['config:b'] }));
  assert.equal(c.state.run?.outcome, 'cancelled');
  assert.deepEqual(c.state.run?.steps.map((s) => s.status), ['cancelled', 'pending']);
});

test('a disconnect fails the running run; restart clears it and ignores the old generation', async () => {
  let generation = 1;
  const f = fake({
    inspect_machine: () => inspection(['config:a']),
    preview_plan: () => ({ planId: 'p1', plan: plan(['config:a']) }),
    apply_plan: () => ({ status: 'started', runId: 'r1' }),
    restart_agent: () => ((generation = 2), null),
  });
  const bridge: Bridge = { ...f.bridge, invoke: async (command, args) => ({ ...(await f.bridge.invoke(command, args)), generation }) };
  const c = new MachineController(bridge);
  await c.connect();
  await c.previewPlan();
  await c.apply();
  f.emit({ generation: 1, event: 'disconnected', detail: 'Backend exited; restart explicitly' });
  assert.equal(c.state.connection, 'disconnected');
  assert.equal(c.state.run?.outcome, 'failed');
  await c.restart();
  assert.equal(c.state.connection, 'connected');
  assert.equal(c.state.run, null);
  f.emit({ generation: 1, event: 'disconnected', detail: 'late' });
  assert.equal(c.state.connection, 'connected');
});

// A promise the test settles by hand, to hold a bridge call open.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('a disconnect that arrives before connect learns its generation wins and skips the inspect', async () => {
  const f = fake({
    agent_generation: () => (f.emit({ generation: 1, event: 'disconnected', detail: 'Backend exited; restart explicitly' }), null),
    inspect_machine: () => inspection(['config:a']),
  });
  const c = new MachineController(f.bridge);
  await c.connect();
  assert.equal(c.state.connection, 'disconnected');
  assert.equal(c.state.detail, 'Backend exited; restart explicitly');
  assert.equal(c.state.pending, false);
  assert.equal(c.state.initialReadPending, false);
  assert.equal(c.state.waitingForReport, false);
  assert.equal(f.calls.some(([n]) => n === 'inspect_machine'), false);
});

test('a disconnect that arrives before restart learns its generation wins and skips the inspect', async () => {
  let generation = 1;
  const f = fake({
    inspect_machine: () => inspection(['config:a']),
    restart_agent: () => {
      generation = 2;
      f.emit({ generation: 2, event: 'disconnected', detail: 'Fresh backend exited' });
      return null;
    },
  });
  const bridge: Bridge = { ...f.bridge, invoke: async (command, args) => ({ ...(await f.bridge.invoke(command, args)), generation }) };
  const c = new MachineController(bridge);
  await c.connect();
  await c.restart();
  assert.equal(c.state.connection, 'disconnected');
  assert.equal(c.state.detail, 'Fresh backend exited');
  assert.equal(c.state.initialReadPending, false);
  assert.equal(c.state.waitingForReport, false);
  assert.equal(c.state.pending, false);
  assert.equal(f.calls.filter(([n]) => n === 'inspect_machine').length, 1);
});

test('dispose while subscribe is pending unregisters and makes no request', async () => {
  const subscribed = deferred<() => void>();
  let unlistened = 0;
  const invoked: Command[] = [];
  const bridge: Bridge = {
    subscribe: () => subscribed.promise,
    invoke: async (command) => (invoked.push(command), { generation: 1, data: null }),
  };
  const c = new MachineController(bridge);
  const connecting = c.connect();
  c.dispose();
  subscribed.resolve(() => { unlistened++; });
  await connecting;
  assert.equal(unlistened, 1);
  assert.deepEqual(invoked, []);
});

test('a superseded preview reply does not change state', async () => {
  let generation = 1;
  const slow = deferred<unknown>();
  let previews = 0;
  const f = fake({
    inspect_machine: () => inspection(['config:a', 'config:b']),
    preview_plan: () => (++previews === 1 ? slow.promise : { planId: 'p2', plan: plan(['config:a']) }),
    restart_agent: () => ((generation = 2), null),
  });
  // Replies carry the generation current when they return, so the late reply matches the new backend.
  const bridge: Bridge = { ...f.bridge, invoke: async (command, args) => ({ ...(await f.bridge.invoke(command, args)), generation }) };
  const c = new MachineController(bridge);
  await c.connect();
  const first = c.previewPlan();
  f.emit({ generation: 1, event: 'disconnected', detail: 'Backend exited; restart explicitly' });
  await c.restart();
  c.toggle('config:b');
  await c.previewPlan();
  const before = c.state;
  slow.resolve({ planId: 'p1', plan: plan(['config:a', 'config:b']) });
  await first;
  assert.equal(c.state, before);
  assert.equal(c.state.preview?.planId, 'p2');
});

test('a cancel rejection that arrives after a restart does not change state', async () => {
  let generation = 1;
  const cancelled = deferred<unknown>();
  const f = fake({
    inspect_machine: () => inspection(['config:a']),
    preview_plan: () => ({ planId: 'p1', plan: plan(['config:a']) }),
    apply_plan: () => ({ status: 'started', runId: 'r1' }),
    cancel_apply: () => cancelled.promise,
    restart_agent: () => ((generation = 2), null),
  });
  const bridge: Bridge = { ...f.bridge, invoke: async (command, args) => ({ ...(await f.bridge.invoke(command, args)), generation }) };
  const c = new MachineController(bridge);
  await c.connect();
  await c.previewPlan();
  await c.apply();
  const cancelling = c.cancel();
  f.emit({ generation: 1, event: 'disconnected', detail: 'Backend exited; restart explicitly' });
  await c.restart();
  const before = c.state;
  cancelled.reject(new Error('Backend exited; restart explicitly'));
  await cancelling;
  assert.equal(c.state, before);
  assert.equal(c.state.connection, 'connected');
});

test('advance ignores nothing it should not', () => {
  const run: RunView = { runId: 'r', steps: [{ key: 'a', summary: 'a', status: 'pending', note: '' }], outcome: 'running', summary: '' };
  assert.equal(advance(run, { type: 'failed', message: 'another nortuscc run (pid 4) holds /s/apply.lock' }).summary, 'another nortuscc run (pid 4) holds /s/apply.lock');
  assert.equal(advance(run, { type: 'failed', message: 'x' }).outcome, 'failed');
});

test('startup NO_REPORT keeps the connection and a later status recovers inspection', async () => {
  const f = fake({ agent_status: () => { throw new Error('NO_REPORT: starting'); }, inspect_machine: () => inspection(['config:a']) });
  const c = new MachineController(f.bridge);
  await c.connect();
  assert.equal(c.state.connection, 'connected');
  assert.equal(c.state.inspection, null);
  assert.match(c.state.detail, /first inspection/i);
  assert.equal(c.state.waitingForReport, true);
  f.emit({ generation: 1, version: 3, event: 'status', status: status() } as HostEvent);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(c.snapshot().inspection?.items.length, 1);
  assert.equal(c.state.status?.policy, 'notify');
});
test('first-report recheck is read-only and becomes ready from an actual report', async () => {
  let reportReady = false;
  const f = fake({ agent_status: () => { if (!reportReady) throw new Error('NO_REPORT: starting'); return status(); }, inspect_machine: () => inspection(['config:a']) });
  const c = new MachineController(f.bridge);
  await c.connect();
  assert.equal(c.state.initialReadPending, false);
  assert.equal(c.state.waitingForReport, true);
  await c.inspect();
  assert.equal(c.state.waitingForReport, true);
  reportReady = true;
  await c.inspect();
  assert.equal(c.state.waitingForReport, false);
  assert.equal(c.state.initialReadPending, false);
  assert.equal(c.state.inspection?.items[0]?.key, 'config:a');
  assert.deepEqual(f.calls.filter(([name]) => !['subscribe', 'agent_generation', 'take_review_request', 'agent_status', 'inspect_machine'].includes(name)), []);
});
test('early initial apply or failed status exposes real operation state while an optional read is held', async () => {
  for (const fields of [{ applying: true }, { error: 'JOB_FAILED', detail: 'fixture failure' }]) {
    const held = deferred<unknown>();
    const called = deferred<void>();
    const f = fake({
      agent_generation: () => { f.emit({ generation: 1, version: 3, event: 'status', status: status(fields) } as HostEvent); return null; },
      take_review_request: () => { called.resolve(); return held.promise; },
      agent_status: () => { throw new Error('NO_REPORT: obsolete response'); },
      inspect_machine: () => inspection(['config:a']), cancel_apply: () => ({ cancelled: true }),
    });
    const c = new MachineController(f.bridge);
    const connecting = c.connect();
    await called.promise;
    const pending = c.state.initialReadPending;
    if (fields.applying) await c.cancel();
    held.resolve(null); await connecting;
    assert.equal(pending, false, JSON.stringify(fields));
    assert.equal(c.state.waitingForReport, false);
    assert.doesNotMatch(c.state.detail, /obsolete response/);
    if (fields.applying) assert.ok(f.calls.some(([name]) => name === 'cancel_apply'));
  }
});
test('terminal startup failures and disposal clear startup waiting instead of hiding recovery', async () => {
  for (const failure of ['UNAUTHORIZED: bad token', 'MALFORMED: incompatible response', 'TIMEOUT: no response']) {
    const f = fake({ agent_status: () => { throw new Error(failure); } });
    const c = new MachineController(f.bridge);
    await c.connect();
    assert.equal(c.state.waitingForReport, false);
    assert.equal(c.state.initialReadPending, false);
    assert.equal(c.state.detail, failure);
  }
  const held = deferred<unknown>();
  const f = fake({ agent_generation: () => held.promise });
  const c = new MachineController(f.bridge);
  const connecting = c.connect();
  c.dispose(); held.resolve(null); await connecting;
  assert.equal(c.state.connection, 'disconnected');
  assert.equal(c.state.initialReadPending, false);
  assert.equal(c.state.waitingForReport, false);
});
test('a current failure during initial inspection is not replaced by its older successful reply', async () => {
  const held = deferred<unknown>();
  const called = deferred<void>();
  const f = fake({ inspect_machine: () => { called.resolve(); return held.promise; } });
  const c = new MachineController(f.bridge);
  const connecting = c.connect();
  await called.promise;
  f.emit({ generation: 1, version: 3, event: 'status', status: status({ error: 'JOB_FAILED', detail: 'current failure' }) } as HostEvent);
  assert.equal(c.state.initialReadPending, false);
  held.resolve(inspection(['config:a'])); await connecting;
  assert.equal(c.state.status?.error, 'JOB_FAILED');
  assert.match(c.state.detail, /current failure/);
  assert.equal(c.state.waitingForReport, false);
});
test('a held initial status reply cannot replace a newer current apply or failed event', async () => {
  for (const fields of [{ applying: true }, { error: 'JOB_FAILED', detail: 'newer failure' }]) {
    const held = deferred<unknown>(); const called = deferred<void>();
    const f = fake({ agent_status: () => { called.resolve(); return held.promise; }, inspect_machine: () => inspection(['config:a']) });
    const c = new MachineController(f.bridge);
    const connecting = c.connect(); await called.promise;
    f.emit({ generation: 1, version: 3, event: 'status', status: status(fields) } as HostEvent);
    held.resolve(status()); await connecting;
    assert.equal(c.state.status?.applying, fields.applying);
    assert.equal(c.state.status?.error, fields.error);
    assert.equal(c.state.initialReadPending, false);
    assert.equal(c.state.waitingForReport, false);
    assert.equal(f.calls.some(([name]) => name === 'inspect_machine'), false);
  }
});
test('restart waits for fresh initialization and old status or disposed replies cannot restore startup', async () => {
  let first = true;
  const restarting = deferred<unknown>(); const restarted = deferred<void>();
  const f = fake({
    agent_status: () => { if (first) throw new Error('NO_REPORT: starting'); return status(); },
    restart_agent: () => { restarted.resolve(); return restarting.promise; },
    inspect_machine: () => inspection(['config:a']),
  });
  let generation = 1;
  const bridge: Bridge = { ...f.bridge, invoke: async (command, args) => ({ ...(await f.bridge.invoke(command, args)), generation }) };
  const c = new MachineController(bridge); await c.connect();
  assert.equal(c.state.waitingForReport, true);
  const restart = c.restart(); await restarted.promise;
  assert.equal(c.state.initialReadPending, true);
  assert.equal(c.state.waitingForReport, false);
  f.emit({ generation: 1, version: 3, event: 'status', status: status({ applying: true }) } as HostEvent);
  generation = 2; first = false; restarting.resolve(null); await restart;
  assert.equal(c.state.status?.applying, undefined);
  assert.equal(c.state.initialReadPending, false);
  assert.equal(c.state.waitingForReport, false);
  c.dispose();
  f.emit({ generation: 2, version: 3, event: 'status', status: status() } as HostEvent);
  assert.equal(c.state.connection, 'disconnected');
  assert.equal(c.state.initialReadPending, false);
});
test('explicit inspection recovers an initial failed report after the local problem is repaired', async () => {
  const f = fake({ agent_status: () => status({ error: 'JOB_FAILED', detail: 'configuration invalid' }), inspect_machine: () => inspection(['config:a']) });
  const c = new MachineController(f.bridge); await c.connect();
  assert.equal(c.state.status?.error, 'JOB_FAILED');
  assert.equal(c.state.initialReadPending, false);
  await c.inspect();
  assert.equal(c.state.inspection?.items[0]?.key, 'config:a');
  assert.equal(c.state.status?.error, undefined);
});
test('reconnect to a new generation never presents the previous session report as current', async () => {
  let generation = 1;
  const f = fake({ agent_status: () => { if (generation === 2) throw new Error('NO_REPORT: starting'); return status(); }, inspect_machine: () => inspection(['config:a']) });
  const bridge: Bridge = { ...f.bridge, invoke: async (command, args) => ({ ...(await f.bridge.invoke(command, args)), generation }) };
  const c = new MachineController(bridge); await c.connect();
  assert.equal(c.state.inspection?.items.length, 1);
  generation = 2; await c.connect();
  assert.equal(c.state.status, null);
  assert.equal(c.state.inspection, null);
  assert.equal(c.state.waitingForReport, true);
  f.emit({ generation: 1, version: 3, event: 'status', status: status() } as HostEvent);
  assert.equal(c.state.status, null);
  assert.equal(c.state.waitingForReport, true);
});
test('NO_REPORT after a completed inspection is a visible refusal without a first-report wait', async () => {
  let noReport = false;
  const f = fake({ agent_status: () => { if (noReport) throw new Error('NO_REPORT: report unavailable'); return status(); }, inspect_machine: () => inspection(['config:a']) });
  const c = new MachineController(f.bridge); await c.connect();
  noReport = true; await c.inspect();
  assert.equal(c.state.waitingForReport, false);
  assert.equal(c.state.initialReadPending, false);
  assert.match(c.state.detail, /NO_REPORT: report unavailable/);
  assert.equal(f.calls.filter(([name]) => name === 'inspect_machine').length, 1);
});

test('status events show pauses and errors and ignore old generations', async () => {
  const f = fake({ inspect_machine: () => inspection(['config:a']) });
  const c = new MachineController(f.bridge);
  await c.connect();
  f.emit({ generation: 0, version: 3, event: 'status', status: status({ policy: 'manual' }) } as HostEvent);
  assert.equal(c.state.status?.policy, 'notify');
  f.emit({ generation: 1, version: 3, event: 'status', status: status({ paused: { reason: 'failed run', at: 'now' }, error: 'JOB_FAILED', detail: 'disk full' }) } as HostEvent);
  assert.equal(c.state.status?.paused?.reason, 'failed run');
  assert.match(c.state.detail, /disk full/);
});

test('a paused auto-apply still permits a person to apply, and PAUSED is visible', async () => {
  const f = fake({
    inspect_machine: () => ({ ...inspection(['config:a']), status: status({ policy: 'auto-apply', paused: { reason: 'failed', at: 'now' } }) }),
    preview_plan: () => ({ planId: 'p1', plan: plan(['config:a']) }),
    apply_plan: () => { throw new Error('PAUSED: a person must review'); },
  });
  const c = new MachineController(f.bridge);
  await c.connect();
  await c.previewPlan();
  await c.apply();
  assert.ok(f.calls.some(([name]) => name === 'apply_plan'));
  assert.equal(c.state.connection, 'connected');
  assert.match(c.state.detail, /PAUSED/);
});

test('live applying status prevents preview and restart until idle', async () => {
  const f = fake({ inspect_machine: () => inspection(['config:a']) });
  const c = new MachineController(f.bridge);
  await c.connect();
  f.emit({ generation: 1, version: 3, event: 'status', status: status({ applying: true }) } as HostEvent);
  await c.previewPlan();
  await c.restart();
  assert.equal(f.calls.some(([name]) => name === 'preview_plan' || name === 'restart_agent'), false);
});

test('UNAUTHORIZED makes the agent offline and explicit restart works', async () => {
  let rejected = true;
  const f = fake({
    agent_status: () => { if (rejected) throw new Error('UNAUTHORIZED: token rotated'); return status(); },
    restart_agent: () => { rejected = false; return { hello: { agentVersion: '0.1.0', protocol: 3, policy: 'notify', paused: null } }; },
    inspect_machine: () => inspection(['config:a']),
  });
  const c = new MachineController(f.bridge);
  await c.connect();
  assert.equal(c.state.connection, 'disconnected');
  assert.match(c.state.detail, /UNAUTHORIZED/);
  await c.restart();
  assert.equal(c.state.connection, 'connected');
  assert.equal(c.state.hello?.protocol, 3);
  assert.equal(c.snapshot().inspection?.items.length, 1);
});

test('incompatible establishment requires explicit restart or reinstall', async () => {
  const f = fake({ agent_generation: () => ({ hello: { agentVersion: 'old', protocol: 2, policy: 'notify', paused: null } }) });
  const c = new MachineController(f.bridge);
  await c.connect();
  assert.equal(c.state.connection, 'disconnected');
  assert.match(c.state.detail, /restart|reinstall/i);
  assert.equal(f.calls.some(([name]) => name === 'inspect_machine'), false);
});

test('a usable status arriving during startup NO_REPORT recovers after pending settles', async () => {
  const f = fake({
    agent_status: () => {
      f.emit({ generation: 1, version: 3, event: 'status', status: status() } as HostEvent);
      throw new Error('NO_REPORT: starting');
    },
    inspect_machine: () => inspection(['config:a']),
  });
  const c = new MachineController(f.bridge);
  await c.connect();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(c.snapshot().inspection?.items.length, 1);
});

test('status updates retain progress detail while a manual run is active', async () => {
  const f = fake({ inspect_machine: () => inspection(['config:a']), preview_plan: () => ({ planId: 'p1', plan: plan(['config:a']) }), apply_plan: () => ({ status: 'started', runId: 'r1' }) });
  const c = new MachineController(f.bridge);
  await c.connect();
  await c.previewPlan();
  await c.apply();
  f.emit(event('r1', { type: 'started', index: 0, total: 1, step: step('config:a') }));
  const detail = c.state.detail;
  f.emit({ generation: 1, version: 3, event: 'status', status: status({ applying: true }) } as HostEvent);
  assert.equal(c.state.detail, detail);
});

test('a manual terminal event re-inspects after status reported an active apply', async () => {
  let inspects = 0;
  const f = fake({ inspect_machine: () => (++inspects, inspection(['config:a'])), preview_plan: () => ({ planId: 'p1', plan: plan(['config:a']) }), apply_plan: () => ({ status: 'started', runId: 'r1' }) });
  const c = new MachineController(f.bridge);
  await c.connect();
  await c.previewPlan();
  await c.apply();
  f.emit({ generation: 1, version: 3, event: 'status', status: status({ applying: true }) } as HostEvent);
  f.emit(event('r1', { type: 'done', ok: 1, failed: 0 }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(inspects, 2);
});

test('a startup status before the generation reply survives a NO_REPORT reply', async () => {
  const f = fake({
    agent_generation: () => { f.emit({ generation: 1, version: 3, event: 'status', status: status() } as HostEvent); return null; },
    agent_status: () => { throw new Error('NO_REPORT: starting'); },
    inspect_machine: () => inspection(['config:a']),
  });
  const c = new MachineController(f.bridge);
  await c.connect();
  assert.equal(c.snapshot().inspection?.items.length, 1);
});

test('a status reply outside the strict v3 contract goes offline with recovery instructions', async () => {
  const f = fake({ agent_status: () => status({ extra: 1 }) });
  const c = new MachineController(f.bridge);
  await c.connect();
  assert.equal(c.state.connection, 'disconnected');
  assert.match(c.state.detail, /restart|reinstall/i);
});

test('explicit inspect refreshes an external apply status and recovers when its lock clears', async () => {
  let applying = true;
  const f = fake({ agent_status: () => status({ applying }), inspect_machine: () => inspection(['config:a']) });
  const c = new MachineController(f.bridge);
  await c.connect();
  assert.equal(c.state.status?.applying, true);
  assert.equal(c.state.inspection, null);
  await c.inspect();
  assert.equal(f.calls.filter(([name]) => name === 'agent_status').length, 2);
  assert.equal(c.state.inspection, null);
  applying = false;
  await c.inspect();
  assert.equal(c.snapshot().inspection?.items.length, 1);
  assert.equal(c.state.status?.applying, undefined);
});

test('a failed status refresh remains visible instead of using a cached idle status', async () => {
  let statuses = 0;
  let inspects = 0;
  const f = fake({
    agent_status: () => { if (++statuses > 1) throw new Error('INTERNAL: status unavailable'); return status(); },
    inspect_machine: () => (++inspects, inspection(['config:a'])),
  });
  const c = new MachineController(f.bridge);
  await c.connect();
  await c.inspect();
  assert.match(c.state.detail, /INTERNAL: status unavailable/);
  assert.equal(c.state.connection, 'connected');
  assert.equal(inspects, 1);
  assert.equal(c.state.pending, false);
});

test('a stale apply refreshes live activity and preserves its replacement preview for another apply', async () => {
  let applies = 0;
  const f = fake({
    agent_status: () => status({ applying: false }),
    inspect_machine: () => inspection(['config:a']),
    preview_plan: () => ({ planId: 'p1', plan: plan(['config:a']) }),
    apply_plan: () => {
      if (++applies > 1) return { status: 'started', runId: 'r2' };
      f.emit({ generation: 1, version: 3, event: 'status', status: status({ applying: true }) } as HostEvent);
      return { status: 'stale', planId: 'p2', plan: plan(['config:a', 'config:new']) };
    },
  });
  const c = new MachineController(f.bridge);
  await c.connect();
  await c.previewPlan();
  await c.apply();
  assert.equal(c.state.status?.applying, false);
  assert.equal(c.state.preview?.planId, 'p2');
  assert.match(c.state.detail, /changed since this preview/);
  await c.apply();
  assert.deepEqual(f.calls.filter(([name]) => name === 'apply_plan').map(([, args]) => args), [{ planId: 'p1' }, { planId: 'p2' }]);
  assert.equal(f.calls.filter(([name]) => name === 'preview_plan').length, 1);
  assert.equal(f.calls.filter(([name]) => name === 'inspect_machine').length, 1);
  assert.equal(c.state.run?.runId, 'r2');
});

test('an apply preparation refusal refreshes live activity without discarding the preview or refusal', async () => {
  let applies = 0;
  const f = fake({
    agent_status: () => status({ applying: false }),
    inspect_machine: () => inspection(['config:a']),
    preview_plan: () => ({ planId: 'p1', plan: plan(['config:a']) }),
    apply_plan: () => {
      if (++applies > 1) return { status: 'started', runId: 'r2' };
      f.emit({ generation: 1, version: 3, event: 'status', status: status({ applying: true }) } as HostEvent);
      throw new Error('INSPECT_FAILED: preparation failed');
    },
  });
  const c = new MachineController(f.bridge);
  await c.connect();
  await c.previewPlan();
  await c.apply();
  assert.equal(c.state.status?.applying, false);
  assert.equal(c.state.preview?.planId, 'p1');
  assert.match(c.state.detail, /INSPECT_FAILED: preparation failed/);
  await c.apply();
  assert.equal(applies, 2);
  assert.equal(c.state.run?.runId, 'r2');
});

for (const refusal of [false, true]) test(`apply settlement respects a live external lock after ${refusal ? 'refusal' : 'stale preview'}`, async () => {
  let applying = false;
  const f = fake({
    agent_status: () => status({ applying }),
    inspect_machine: () => inspection(['config:a']),
    preview_plan: () => ({ planId: 'p1', plan: plan(['config:a']) }),
    apply_plan: () => {
      applying = true;
      f.emit({ generation: 1, version: 3, event: 'status', status: status({ applying: true }) } as HostEvent);
      if (refusal) throw new Error('LOCKED: external process holds the apply lock');
      return { status: 'stale', planId: 'p2', plan: plan(['config:new']) };
    },
  });
  const c = new MachineController(f.bridge);
  await c.connect();
  await c.previewPlan();
  await c.apply();
  assert.equal(f.calls.filter(([name]) => name === 'agent_status').length, 2);
  assert.equal(c.state.status?.applying, true);
  assert.equal(c.state.preview?.planId, refusal ? 'p1' : 'p2');
  await c.apply();
  await c.previewPlan();
  assert.equal(f.calls.filter(([name]) => name === 'apply_plan').length, 1);
  assert.equal(f.calls.filter(([name]) => name === 'preview_plan').length, 1);
});

test('a fresh app cancels a surviving manual apply without inventing a local run', async () => {
  let applying = true;
  const f = fake({ agent_status: () => status({ applying }), cancel_apply: () => ({ cancelled: true }), inspect_machine: () => inspection(['config:a']) });
  const c = new MachineController(f.bridge);
  await c.connect();
  await c.cancel();
  assert.deepEqual(f.calls.filter(([name]) => name === 'cancel_apply'), [['cancel_apply', undefined]]);
  assert.equal(c.state.run, null);
  assert.equal(c.state.status?.applying, true);
  assert.match(c.state.detail, /requested|waiting/i);
  f.emit(event('surviving', { type: 'cancelled', remaining: [] }));
  assert.equal(c.state.run, null);
  assert.equal(c.state.status?.applying, true);
  applying = false;
  f.emit({ generation: 1, version: 3, event: 'status', status: status({ applying: false }) } as HostEvent);
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(c.state.inspection?.items.length, 1);
  assert.equal(c.state.pending, false);
});

test('a false cancel leaves external activity visible until authoritative idle status', async () => {
  let applying = false;
  let inspects = 0;
  const f = fake({ agent_status: () => status({ applying }), cancel_apply: () => ({ cancelled: false }), inspect_machine: () => (++inspects, inspection(['config:a'])) });
  const c = new MachineController(f.bridge);
  await c.connect();
  applying = true;
  f.emit({ generation: 1, version: 3, event: 'status', status: status({ applying: true }) } as HostEvent);
  await c.cancel();
  assert.equal(f.calls.filter(([name]) => name === 'cancel_apply').length, 1);
  assert.equal(c.state.status?.applying, true);
  assert.equal(c.state.run, null);
  assert.doesNotMatch(c.state.detail, /cancelled/i);
  await c.previewPlan();
  await c.restart();
  assert.equal(f.calls.some(([name]) => name === 'preview_plan' || name === 'restart_agent'), false);
  f.emit({ generation: 0, version: 3, event: 'status', status: status({ applying: false }) } as HostEvent);
  assert.equal(c.state.status?.applying, true);
  applying = false;
  f.emit({ generation: 1, version: 3, event: 'status', status: status({ applying: false }) } as HostEvent);
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(inspects, 2, 'idle refreshes an inspection from before the external apply');
  assert.equal(c.state.status?.applying, undefined);
});

test('an external cancel reply cannot overwrite idle recovery that superseded it', async () => {
  let applying = true;
  const cancelled = deferred<unknown>();
  const f = fake({ agent_status: () => status({ applying }), cancel_apply: () => cancelled.promise, inspect_machine: () => inspection(['config:a']) });
  const c = new MachineController(f.bridge);
  await c.connect();
  const cancelling = c.cancel();
  assert.equal(f.calls.filter(([name]) => name === 'cancel_apply').length, 1);
  applying = false;
  f.emit({ generation: 1, version: 3, event: 'status', status: status({ applying: false }) } as HostEvent);
  await new Promise((done) => setTimeout(done, 0));
  const before = c.state;
  cancelled.resolve({ cancelled: true });
  await cancelling;
  assert.equal(c.state, before);
});

test('an external cancel reply from another generation is ignored', async () => {
  const f = fake({ agent_status: () => status({ applying: true }), cancel_apply: () => ({ cancelled: true }) });
  const bridge: Bridge = { ...f.bridge, invoke: async (command, args) => ({ ...(await f.bridge.invoke(command, args)), generation: command === 'cancel_apply' ? 0 : 1 }) };
  const c = new MachineController(bridge);
  await c.connect();
  const before = c.state;
  await c.cancel();
  assert.equal(f.calls.filter(([name]) => name === 'cancel_apply').length, 1);
  assert.equal(c.state, before);
});

test('the shared Cancel button gate enables connected external activity and refuses idle or offline state', () => {
  const c = new MachineController(null);
  for (const [connection, applying, expected] of [
    ['connected', true, true], ['connected', false, false], ['connecting', true, false],
    ['disconnected', true, false], ['browser', true, false],
  ] as const) {
    assert.equal(canCancel({ ...c.state, connection, status: { ...status({ applying }), policy: 'notify' }, run: null }), expected);
  }
});

const review = (generation = 1): HostEvent => ({ generation, event: 'review-requested' } as HostEvent);
const settle = () => new Promise((done) => setTimeout(done, 0));

test('review requests focus and refresh without preview, apply or cancel', async () => {
  const f = fake({ inspect_machine: () => inspection(['config:a']) });
  const c = new MachineController(f.bridge);
  await c.connect();
  f.emit(review(2));
  assert.equal(c.state.reviewRequested, 0);
  f.emit(review());
  await settle();
  assert.equal(c.state.reviewRequested, 1);
  assert.equal(f.calls.filter(([name]) => name === 'take_review_request').length, 2, 'live route consumes its native pending flag');
  assert.equal(f.calls.filter(([name]) => name === 'inspect_machine').length, 2);
  assert.equal(f.calls.some(([name]) => ['preview_plan', 'apply_plan', 'cancel_apply'].includes(name)), false);
});

for (const pending of [false, true]) test(`startup preserves ${pending ? 'native pending' : 'preconnect event'} review routing`, async () => {
  const f = fake({
    agent_generation: () => { if (!pending) { f.emit(review(2)); f.emit(review()); } return null; },
    take_review_request: () => ({ requested: pending }),
    inspect_machine: () => inspection(['config:a']),
  });
  const c = new MachineController(f.bridge);
  await c.connect();
  assert.equal(c.state.reviewRequested, 1);
  assert.equal(c.state.inspection?.items.length, 1);
  assert.equal(f.calls.filter(([name]) => name === 'inspect_machine').length, 1);
});

test('an optional native route failure leaves the agent connected', async () => {
  const f = fake({ take_review_request: () => { throw new Error('CLOSED: route unavailable'); }, inspect_machine: () => inspection(['config:a']) });
  const c = new MachineController(f.bridge);
  await c.connect();
  assert.equal(c.state.connection, 'connected');
  assert.equal(c.state.inspection?.items.length, 1);
});

test('review during a pending refresh waits and then refreshes safely', async () => {
  const refresh = deferred<unknown>();
  let count = 0;
  const f = fake({ inspect_machine: () => ++count === 2 ? refresh.promise : inspection(['config:a']) });
  const c = new MachineController(f.bridge);
  await c.connect();
  const inspecting = c.inspect();
  await settle();
  f.emit(review());
  assert.equal(count, 2);
  assert.equal(c.state.reviewRequested, 1);
  refresh.resolve(inspection(['config:a']));
  await inspecting;
  await settle();
  assert.equal(count, 3);
});

test('review during apply waits for idle without cancelling or replacing the run', async () => {
  let applying = false;
  const f = fake({ agent_status: () => status({ applying }), inspect_machine: () => inspection(['config:a']), preview_plan: () => ({ planId: 'p1', plan: plan(['config:a']) }), apply_plan: () => ({ status: 'started', runId: 'r1' }) });
  const c = new MachineController(f.bridge);
  await c.connect();
  await c.previewPlan();
  await c.apply();
  applying = true;
  f.emit(review());
  await settle();
  assert.equal(c.state.run?.runId, 'r1');
  assert.equal(c.state.run?.outcome, 'running');
  assert.equal(f.calls.filter(([name]) => name === 'inspect_machine').length, 1);
  applying = false;
  f.emit(event('r1', { type: 'done', ok: 1, failed: 0 }));
  await settle();
  assert.equal(f.calls.filter(([name]) => name === 'inspect_machine').length, 2);
  assert.equal(f.calls.some(([name]) => name === 'cancel_apply'), false);
});

test('a pending route reply from another generation cannot request review', async () => {
  const f = fake({ take_review_request: () => ({ requested: true }), inspect_machine: () => inspection(['config:a']) });
  const bridge: Bridge = { ...f.bridge, invoke: async (command, args) => ({ ...(await f.bridge.invoke(command, args)), generation: command === 'take_review_request' ? 2 : 1 }) };
  const c = new MachineController(bridge);
  await c.connect();
  assert.equal(c.state.reviewRequested, 0);
});

test('review during external apply refreshes after authoritative idle', async () => {
  let applying = true;
  const f = fake({ agent_status: () => status({ applying }), inspect_machine: () => inspection(['config:a']) });
  const c = new MachineController(f.bridge);
  await c.connect();
  f.emit(review());
  await settle();
  assert.equal(f.calls.some(([name]) => name === 'inspect_machine'), false);
  applying = false;
  f.emit({ generation: 1, version: 3, event: 'status', status: status({ applying: false }) } as HostEvent);
  await settle();
  assert.equal(f.calls.filter(([name]) => name === 'inspect_machine').length, 1);
  assert.equal(c.state.reviewRequested, 1);
});

test('browser preview remains inert', async () => {
  const c = new MachineController(null);
  await c.connect();
  await c.inspect();
  await c.previewPlan();
  await c.apply();
  assert.equal(c.state.connection, 'browser');
  assert.equal(c.state.reviewRequested, 0);
  assert.equal(c.state.inspection, null);
});

test('a review refresh refusal is visible and does not retry indefinitely', async () => {
  let statuses = 0;
  const f = fake({ agent_status: () => { if (++statuses > 1) throw new Error('INTERNAL: status unavailable'); return status(); }, inspect_machine: () => inspection(['config:a']) });
  const c = new MachineController(f.bridge);
  await c.connect();
  f.emit(review());
  await settle();
  assert.equal(statuses, 2);
  assert.equal(c.state.pending, false);
  assert.equal(c.state.connection, 'connected');
  assert.match(c.state.detail, /status unavailable/);
});
test('malformed inspection and plan replies never expose rejected values', async () => {
  for (const command of ['inspect_machine', 'preview_plan', 'apply_plan'] as const) {
    const f = fake({ inspect_machine: () => inspection(['config:a']), preview_plan: () => ({ planId: 'p1', plan: plan(['config:a']) }), apply_plan: () => ({ status: 'started', runId: 'r1' }), [command]: () => ({ token: 'DO-NOT-PRINT' }) });
    const c = new MachineController(f.bridge);
    await c.connect();
    if (command !== 'inspect_machine') await c.previewPlan();
    if (command === 'apply_plan') await c.apply();
    assert.doesNotMatch(c.state.detail, /DO-NOT-PRINT|token/, command);
    assert.match(c.state.detail, /incompatible agent response/, command);
  }
});

test('a shared operation started by another client appears in app activity and refreshes on completion', async () => {
  const f = fake({inspect_machine: () => inspection(['config:a'])}); const c = new MachineController(f.bridge); await c.connect();
  f.emit(event('mcp-run', {type:'started',index:0,total:1,step:step('config:a')}));
  assert.equal(c.state.run?.runId, 'mcp-run'); assert.equal(c.state.run?.steps[0]?.status, 'running'); assert.equal(canCancel(c.state), true);
  f.emit(event('mcp-run', {type:'finished',index:0,total:1,key:'config:a',outcome:'ok',note:'applied'}));
  assert.equal(c.state.run?.steps[0]?.note, 'applied');
  f.emit(event('mcp-run', {type:'done',ok:1,failed:0})); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(c.state.run?.outcome, 'done'); assert.equal(f.calls.filter(([name]) => name === 'inspect_machine').length, 2);
});

test('reconnecting during a run keeps only observed steps and renders subsequent progress safely', () => {
  let run: RunView = {runId:'reconnected',steps:[],outcome:'running',summary:'Applying'};
  run=advance(run,{type:'started',index:1,total:3,step:step('config:b') as any});
  run=advance(run,{type:'finished',index:1,total:3,key:'config:b',outcome:'ok',note:'applied b'});
  run=advance(run,{type:'started',index:2,total:3,step:step('config:c') as any});
  assert.deepEqual(run.steps.map(step=>[step.key,step.status]),[['config:b','ok'],['config:c','running']]);
  run=advance(run,{type:'finished',index:2,total:3,key:'config:c',outcome:'failed',note:'failed c'});
  assert.deepEqual(run.steps.map(step=>[step.key,step.status,step.note]),[['config:b','ok','applied b'],['config:c','failed','failed c']]);
});


const operationHello = { hello: { agentVersion: 'fixture', protocol: 3, policy: 'manual', paused: null, operationsProtocol: 1, operations: { available: true } } };
test('reconnect restores an addition receipt independently of first inspection and follows its terminal result', async () => {
  let run = skillRun({ state: 'running', result: null, installation: undefined });
  const f = fake({ agent_generation: () => operationHello, agent_status: () => status({ applying: true }),
    list_operation_runs: () => ({ runs: [run], nextBefore: null }), get_operation_run: () => run,
    inspect_machine: () => inspection([]) });
  const c = new MachineController(f.bridge); await c.connect();
  assert.equal(c.state.run?.receipt?.intentState, 'saved');
  assert.equal(c.state.run?.outcome, 'running');
  assert.equal(c.state.inspection, null);
  run = skillRun();
  f.emit(event(run.runId, { type: 'done', ok: 3, failed: 0 })); await settle();
  assert.equal(c.state.run?.receipt?.installation?.state, 'verified');
  assert.equal(c.state.run?.outcome, 'done');
  assert.deepEqual(f.calls.find(([n]) => n === 'list_operation_runs')?.[1], { limit: 1 });
  assert.deepEqual(f.calls.find(([n]) => n === 'get_operation_run')?.[1], { runId: run.runId });
});

test('a delayed durable terminal receipt cannot replace a different live legacy run', async () => {
  const held = deferred<unknown>();
  const f = fake({ agent_generation: () => operationHello, list_operation_runs: () => held.promise, inspect_machine: () => inspection([]) });
  const c = new MachineController(f.bridge); const connecting = c.connect(); await settle();
  f.emit(event('legacy-run', { type: 'started', index: 0, total: 1, step: step('config:a') }));
  held.resolve({ runs: [skillRun()], nextBefore: null }); await connecting;
  assert.equal(c.state.run?.runId, 'legacy-run'); assert.equal(c.state.run?.receipt, undefined);
});

test('durable lookup replies from a previous session cannot restore stale receipts', async () => {
  const held = deferred<unknown>(); let requests = 0;
  const f = fake({ agent_generation: () => operationHello, list_operation_runs: () => ++requests === 1 ? held.promise : { runs: [], nextBefore: null }, inspect_machine: () => inspection([]) });
  const c = new MachineController(f.bridge); const first = c.connect(); await settle();
  await c.connect(); held.resolve({ runs: [skillRun()], nextBefore: null }); await first;
  assert.equal(c.state.run, null);
});


test('durable failed installation overrides a completed progress count without sharing suggestions', async () => {
  let run = skillRun({ state: 'running', installation: undefined, result: null });
  const f = fake({ agent_generation: () => operationHello, list_operation_runs: () => ({ runs: [run], nextBefore: null }),
    get_operation_run: () => run, inspect_machine: () => inspection([]) });
  const c = new MachineController(f.bridge); await c.connect();
  run = skillRun({ state: 'failed', installation: { ...skillRun().installation!, state: 'failed', message: 'Native catalog unavailable', nextActions: [] } });
  f.emit(event(run.runId, { type: 'done', ok: 3, failed: 0 })); await settle();
  assert.equal(c.state.run?.outcome, 'failed');
  assert.equal(c.state.run?.summary, 'Native catalog unavailable');
  assert.deepEqual(c.state.run?.receipt?.installation?.nextActions, []);
});

test('a mismatched run lookup cannot attach another receipt to live progress', async () => {
  const f = fake({ agent_generation: () => operationHello, list_operation_runs: () => ({ runs: [], nextBefore: null }),
    get_operation_run: () => skillRun({ runId: 'other' }), inspect_machine: () => inspection([]) });
  const c = new MachineController(f.bridge); await c.connect();
  f.emit(event('live', { type: 'started', index: 0, total: 1, step: step('config:a') })); await settle();
  assert.equal(c.state.run?.runId, 'live'); assert.equal(c.state.run?.receipt, undefined); assert.equal(c.state.run?.outcome, 'running');
});
