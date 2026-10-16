import test from 'node:test';
import assert from 'node:assert/strict';
import { MachineController, advance, type RunView } from '../src/controller.ts';
import { skillRun } from './support/skill-run.ts';
import { authorRun } from './support/author.ts';
import type { Bridge, Command, HostEvent } from '../src/bridge.ts';

const step = (key: string) => ({ key, domain: 'config', action: 'write-file', summary: `write ${key}`, touches: [key], interruptible: false });
const status = (fields = {}) => ({ at: 'now', policy: 'notify' as const, paused: null, trusted: true, pending: [], drift: [], conflicts: [], probeErrors: [], counts: { pending: 0, held: 0, ready: 0, drift: 0 }, ...fields });
const inspection = (keys: string[]) => ({
  profile: { repo: '/r', revision: 'abc', overrides: '/s/overrides.json', issues: [] },
  items: keys.map((key) => ({ key, domain: 'config', target: 'claude', label: key, group: 'Files', state: 'repo-ahead', disposition: 'apply' })),
  probeErrors: [],
  status: status(),
});
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

test('an agent run tracks its steps from progress events and re-inspects when done', async () => {
  let inspects = 0;
  const f = fake({ inspect_machine: () => (++inspects, inspection(['config:a', 'config:b'])) });
  const c = new MachineController(f.bridge);
  await c.connect();
  f.emit(event('r1', { type: 'started', index: 0, total: 2, step: step('config:a') }));
  assert.deepEqual(c.state.run?.steps.map((s) => s.status), ['running']);
  assert.equal(c.state.status?.applying, true);
  f.emit(event('other', { type: 'done', ok: 9, failed: 0 }));
  f.emit(event('r1', { type: 'done', ok: 9, failed: 0 }, 0));
  assert.equal(c.state.run?.outcome, 'running');
  f.emit(event('r1', { type: 'finished', index: 0, total: 2, key: 'config:a', outcome: 'ok', note: '' }));
  f.emit(event('r1', { type: 'started', index: 1, total: 2, step: step('config:b') }));
  f.emit(event('r1', { type: 'finished', index: 1, total: 2, key: 'config:b', outcome: 'failed', note: 'disk full' }));
  f.emit(event('r1', { type: 'done', ok: 1, failed: 1, backups: '/b/nortuscc-1' }));
  assert.equal(c.state.run?.outcome, 'done');
  assert.equal(c.state.run?.backups, '/b/nortuscc-1');
  assert.equal(c.state.run?.failed, 1);
  assert.deepEqual(c.state.run?.steps.map((s) => [s.status, s.note]), [['ok', ''], ['failed', 'disk full']]);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(inspects, 2);
  assert.notEqual(c.state.status?.applying, true);
});

test('a cancelled agent run reports how many steps did not start', async () => {
  const f = fake({ inspect_machine: () => inspection(['config:a', 'config:b']) });
  const c = new MachineController(f.bridge);
  await c.connect();
  f.emit(event('r1', { type: 'started', index: 0, total: 2, step: step('config:a') }));
  f.emit(event('r1', { type: 'finished', index: 0, total: 2, key: 'config:a', outcome: 'cancelled', note: 'cancelled' }));
  f.emit(event('r1', { type: 'cancelled', remaining: ['config:b'] }));
  assert.equal(c.state.run?.outcome, 'cancelled');
  assert.equal(c.state.run?.summary, 'Cancelled; 1 not started');
  assert.deepEqual(c.state.run?.steps.map((s) => s.status), ['cancelled']);
});

test('a disconnect fails the running run; restart clears it and ignores the old generation', async () => {
  let generation = 1;
  const f = fake({
    inspect_machine: () => inspection(['config:a']),
    restart_agent: () => ((generation = 2), null),
  });
  const bridge: Bridge = { ...f.bridge, invoke: async (command, args) => ({ ...(await f.bridge.invoke(command, args)), generation }) };
  const c = new MachineController(bridge);
  await c.connect();
  f.emit(event('r1', { type: 'started', index: 0, total: 1, step: step('config:a') }));
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

test('a superseded inspection reply does not change state', async () => {
  let generation = 1;
  const slow = deferred<unknown>();
  let inspects = 0;
  const f = fake({
    inspect_machine: () => (++inspects === 2 ? slow.promise : inspection(['config:a'])),
    restart_agent: () => ((generation = 2), null),
  });
  // Replies carry the generation current when they return, so the late reply matches the new backend.
  const bridge: Bridge = { ...f.bridge, invoke: async (command, args) => ({ ...(await f.bridge.invoke(command, args)), generation }) };
  const c = new MachineController(bridge);
  await c.connect();
  const first = c.inspect();
  await new Promise((r) => setTimeout(r, 0));
  f.emit({ generation: 1, event: 'disconnected', detail: 'Backend exited; restart explicitly' });
  await c.restart();
  const before = c.state;
  slow.resolve(inspection(['config:a', 'config:stale']));
  await first;
  assert.equal(c.state, before);
  assert.deepEqual(c.state.inspection?.items.map((item) => item.key), ['config:a']);
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
      inspect_machine: () => inspection(['config:a']),
    });
    const c = new MachineController(f.bridge);
    const connecting = c.connect();
    await called.promise;
    const pending = c.state.initialReadPending;
    held.resolve(null); await connecting;
    assert.equal(pending, false, JSON.stringify(fields));
    assert.equal(c.state.waitingForReport, false);
    assert.doesNotMatch(c.state.detail, /obsolete response/);
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

test('live applying status prevents restart until idle', async () => {
  const f = fake({ inspect_machine: () => inspection(['config:a']) });
  const c = new MachineController(f.bridge);
  await c.connect();
  f.emit({ generation: 1, version: 3, event: 'status', status: status({ applying: true }) } as HostEvent);
  await c.restart();
  assert.equal(f.calls.some(([name]) => name === 'restart_agent'), false);
});

test('an agent OVERSIZED refusal on a healthy connection is shown as an error, not a lost connection', async () => {
  const f = fake({ inspect_machine: () => { throw new Error('OVERSIZED: Result exceeds 1048576 bytes'); } });
  const c = new MachineController(f.bridge);
  await c.connect();
  assert.equal(c.state.connection, 'connected');
  assert.equal(c.state.inspection, null);
  assert.match(c.state.detail, /Result exceeds 1048576 bytes/);
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

test('status updates retain progress detail while a run is active', async () => {
  const f = fake({ inspect_machine: () => inspection(['config:a']) });
  const c = new MachineController(f.bridge);
  await c.connect();
  f.emit(event('r1', { type: 'started', index: 0, total: 1, step: step('config:a') }));
  const detail = c.state.detail;
  f.emit({ generation: 1, version: 3, event: 'status', status: status({ applying: true }) } as HostEvent);
  assert.equal(c.state.detail, detail);
});

test('a terminal event re-inspects after status reported an active apply', async () => {
  let inspects = 0;
  const f = fake({ inspect_machine: () => (++inspects, inspection(['config:a'])) });
  const c = new MachineController(f.bridge);
  await c.connect();
  f.emit(event('r1', { type: 'started', index: 0, total: 1, step: step('config:a') }));
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

test('a surviving external apply stays external without inventing a local run', async () => {
  let applying = true;
  const f = fake({ agent_status: () => status({ applying }), inspect_machine: () => inspection(['config:a']) });
  const c = new MachineController(f.bridge);
  await c.connect();
  assert.equal(c.state.run, null);
  assert.equal(c.state.status?.applying, true);
  f.emit(event('surviving', { type: 'cancelled', remaining: [] }));
  assert.equal(c.state.run, null);
  assert.equal(c.state.status?.applying, true);
  applying = false;
  f.emit({ generation: 1, version: 3, event: 'status', status: status({ applying: false }) } as HostEvent);
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(c.state.inspection?.items.length, 1);
  assert.equal(c.state.pending, false);
});

test('external activity stays visible and blocks restart until authoritative idle status', async () => {
  let applying = false;
  let inspects = 0;
  const f = fake({ agent_status: () => status({ applying }), inspect_machine: () => (++inspects, inspection(['config:a'])) });
  const c = new MachineController(f.bridge);
  await c.connect();
  applying = true;
  f.emit({ generation: 1, version: 3, event: 'status', status: status({ applying: true }) } as HostEvent);
  assert.equal(c.state.status?.applying, true);
  assert.equal(c.state.run, null);
  await c.restart();
  assert.equal(f.calls.some(([name]) => name === 'restart_agent'), false);
  f.emit({ generation: 0, version: 3, event: 'status', status: status({ applying: false }) } as HostEvent);
  assert.equal(c.state.status?.applying, true);
  applying = false;
  f.emit({ generation: 1, version: 3, event: 'status', status: status({ applying: false }) } as HostEvent);
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(inspects, 2, 'idle refreshes an inspection from before the external apply');
  assert.equal(c.state.status?.applying, undefined);
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

test('review during a run waits for idle without replacing the run', async () => {
  let applying = false;
  const f = fake({ agent_status: () => status({ applying }), inspect_machine: () => inspection(['config:a']) });
  const c = new MachineController(f.bridge);
  await c.connect();
  f.emit(event('r1', { type: 'started', index: 0, total: 1, step: step('config:a') }));
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
  await c.restart();
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
test('a malformed inspection reply never exposes rejected values', async () => {
  const f = fake({ inspect_machine: () => ({ token: 'DO-NOT-PRINT' }) });
  const c = new MachineController(f.bridge);
  await c.connect();
  assert.doesNotMatch(c.state.detail, /DO-NOT-PRINT|token/);
  assert.match(c.state.detail, /incompatible agent response/);
});

test('a shared operation started by another client appears in app activity and refreshes on completion', async () => {
  const f = fake({inspect_machine: () => inspection(['config:a'])}); const c = new MachineController(f.bridge); await c.connect();
  f.emit(event('mcp-run', {type:'started',index:0,total:1,step:step('config:a')}));
  assert.equal(c.state.run?.runId, 'mcp-run'); assert.equal(c.state.run?.steps[0]?.status, 'running'); assert.equal(c.state.status?.applying, true);
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
  assert.deepEqual(f.calls.find(([n]) => n === 'list_operation_runs')?.[1], { limit: 50 });
  assert.deepEqual(f.calls.find(([n]) => n === 'get_operation_run')?.[1], { runId: run.runId });
});

test('run discovery skips author runs such as a waiting GitHub sign-in or a publish', async () => {
  const login = authorRun({ kind: 'ghLogin' }, { runId: 'login-run', state: 'running', result: null });
  const publish = authorRun({ kind: 'publishDraft', draftId: 'd', digest: 'a'.repeat(64) }, { runId: 'publish-run' });
  let runs = [login, publish];
  const f = fake({ agent_generation: () => operationHello, list_operation_runs: () => ({ runs, nextBefore: null }), get_operation_run: () => skillRun(),
    inspect_machine: () => inspection([]) });
  const c = new MachineController(f.bridge); await c.connect();
  const adopted = () => c.state.run as RunView | null;
  assert.equal(adopted(), null, 'an author run never becomes the machine run');
  runs = [login, publish, skillRun()];
  f.emit({ generation: 1, version: 3, event: 'operation-run', runId: 'login-run' }); await settle();
  assert.equal(adopted()?.runId, skillRun().runId, 'the newest machine run is still discovered');
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


for (const entry of ['connect', 'restart'] as const) for (const outcome of ['verified', 'failed', 'needsInspection'] as const)
  test(`${entry} preserves ${outcome} completion observed during initial durable discovery`, async () => {
    const list = deferred<unknown>(); const listed = deferred<void>();
    let discovering = entry === 'connect';
    const initial = skillRun({ state: 'running', installation: undefined, result: null });
    const completed = outcome === 'verified' ? skillRun() : skillRun({ state: outcome === 'failed' ? 'failed' : 'interrupted',
      result: { status: outcome === 'failed' ? 'failed' : 'interrupted', message: 'Inspect retained installation' },
      installation: { ...skillRun().installation!, state: outcome, message: 'Inspect retained installation', nextActions: [] } });
    const f = fake({ agent_generation: () => discovering ? operationHello : null,
      restart_agent: () => { discovering = true; return operationHello; },
      agent_status: () => status({ applying: discovering }), inspect_machine: () => inspection([]),
      list_operation_runs: () => { listed.resolve(); return list.promise; }, get_operation_run: () => completed });
    const c = new MachineController(f.bridge);
    if (entry === 'restart') await c.connect();
    const connecting = entry === 'connect' ? c.connect() : c.restart();
    await listed.promise;
    assert.equal(c.snapshot().run, null);
    f.emit(event(initial.runId, outcome === 'verified' ? { type: 'done', ok: 3, failed: 0 }
      : { type: 'failed', message: 'Inspect retained installation' }));
    list.resolve({ runs: [initial], nextBefore: null });
    await connecting; await settle();
    assert.equal(c.state.run?.outcome, outcome === 'verified' ? 'done' : outcome === 'needsInspection' ? 'interrupted' : 'failed');
    assert.equal(c.state.run?.receipt?.installation?.state, outcome);
    assert.equal(c.state.run?.receipt?.installation?.nextActions.length, outcome === 'verified' ? 2 : 0);
    assert.deepEqual(c.state.run?.receipt?.intent.skillAddition?.declaration, completed.intent.skillAddition?.declaration);
    assert.deepEqual(f.calls.filter(([command]) => command === 'get_operation_run').map(([, args]) => args), [{ runId: initial.runId }]);
    discovering = false;
    f.emit({ generation: 1, version: 3, event: 'status', status: { ...status({ applying: false }), policy: 'notify' } }); await settle();
    assert.equal(c.state.run?.outcome, outcome === 'verified' ? 'done' : outcome === 'needsInspection' ? 'interrupted' : 'failed');
    assert.equal(c.state.pending, false); assert.equal(c.state.inspection?.items.length, 0);
    c.dispose();
  });

test('initial durable discovery does not authorize an unrelated terminal run', async () => {
  const list = deferred<unknown>(); const listed = deferred<void>();
  const f = fake({ agent_generation: () => operationHello, agent_status: () => status({ applying: true }),
    list_operation_runs: () => { listed.resolve(); return list.promise; }, get_operation_run: () => skillRun({ runId: 'other' }) });
  const c = new MachineController(f.bridge); const connecting = c.connect(); await listed.promise;
  f.emit(event('other', { type: 'done', ok: 3, failed: 0 }));
  list.resolve({ runs: [skillRun({ state: 'running', installation: undefined, result: null })], nextBefore: null });
  await connecting;
  assert.equal(c.state.run?.runId, 'addition-run'); assert.equal(c.state.run?.outcome, 'running');
  assert.equal(f.calls.some(([command]) => command === 'get_operation_run'), false);
  c.dispose();
});


test('a terminal lookup discovered during connect cannot replace a newer live legacy run', async () => {
  const list = deferred<unknown>(); const listed = deferred<void>();
  const terminal = deferred<unknown>(); const queried = deferred<void>();
  const f = fake({ agent_generation: () => operationHello, agent_status: () => status({ applying: true }),
    list_operation_runs: () => { listed.resolve(); return list.promise; }, get_operation_run: args => {
      if (args?.runId !== 'addition-run') throw new Error('UNKNOWN_RUN');
      queried.resolve(); return terminal.promise;
    } });
  const c = new MachineController(f.bridge); const connecting = c.connect(); await listed.promise;
  f.emit(event('addition-run', { type: 'done', ok: 3, failed: 0 }));
  list.resolve({ runs: [skillRun({ state: 'running', installation: undefined, result: null })], nextBefore: null });
  await queried.promise;
  f.emit(event('legacy-run', { type: 'started', index: 0, total: 1, step: step('config:a') }));
  terminal.resolve(skillRun()); await connecting;
  assert.equal(c.state.run?.runId, 'legacy-run'); assert.equal(c.state.run?.outcome, 'running');
  assert.equal(c.state.run?.receipt, undefined);
  c.dispose();
});

test('a terminal lookup discovered during connect cannot cross a restart session', async () => {
  const list = deferred<unknown>(); const listed = deferred<void>(); let reads = 0; let restarted = false;
  const terminal = deferred<unknown>(); const queried = deferred<void>();
  const f = fake({ agent_generation: () => operationHello,
    restart_agent: () => { restarted = true; return operationHello; },
    agent_status: () => status({ applying: !restarted }), inspect_machine: () => inspection([]),
    list_operation_runs: () => { if (++reads === 1) { listed.resolve(); return list.promise; } return { runs: [], nextBefore: null }; },
    get_operation_run: () => { queried.resolve(); return terminal.promise; } });
  const c = new MachineController(f.bridge); const connecting = c.connect(); await listed.promise;
  f.emit(event('addition-run', { type: 'done', ok: 3, failed: 0 }));
  list.resolve({ runs: [skillRun({ state: 'running', installation: undefined, result: null })], nextBefore: null });
  await queried.promise;
  f.emit({ generation: 1, event: 'disconnected', detail: 'Fixture disconnected' });
  await c.restart(); terminal.resolve(skillRun()); await connecting;
  assert.equal(c.state.run, null); assert.equal(c.state.connection, 'connected');
  assert.equal(c.state.pending, false);
  c.dispose();
});


for (const entry of ['connect', 'restart'] as const) for (const order of ['A then B', 'B then A'] as const)
  for (const outcome of ['verified', 'failed', 'needsInspection'] as const)
    test(`${entry} preserves ${outcome} discovery with two terminal events ${order}`, async () => {
      const list = deferred<unknown>(); const listed = deferred<void>(); let discovering = entry === 'connect';
      const completed = outcome === 'verified' ? skillRun() : skillRun({ state: outcome === 'failed' ? 'failed' : 'interrupted',
        result: { status: outcome === 'failed' ? 'failed' : 'interrupted', message: 'Inspect retained installation' },
        installation: { ...skillRun().installation!, state: outcome, nextActions: [] } });
      const f = fake({ agent_generation: () => discovering ? operationHello : null,
        restart_agent: () => { discovering = true; return operationHello; }, agent_status: () => status({ applying: discovering }),
        inspect_machine: () => inspection([]), list_operation_runs: () => { listed.resolve(); return list.promise; },
        get_operation_run: () => completed });
      const c = new MachineController(f.bridge); if (entry === 'restart') await c.connect();
      const connecting = entry === 'connect' ? c.connect() : c.restart(); await listed.promise;
      const a = event('addition-run', { type: 'done', ok: 3, failed: 0 });
      // A later empty reconcile can complete without ever emitting a started event.
      const b = event('later-empty-run', { type: 'done', ok: 0, failed: 0 });
      for (const terminal of order === 'A then B' ? [a, b] : [b, a]) f.emit(terminal);
      list.resolve({ runs: [skillRun({ state: 'running', result: null, installation: undefined })], nextBefore: null });
      await connecting;
      assert.equal(c.state.run?.runId, 'addition-run');
      assert.equal(c.state.run?.outcome, outcome === 'verified' ? 'done' : outcome === 'needsInspection' ? 'interrupted' : 'failed');
      assert.equal(c.state.run?.receipt?.installation?.state, outcome);
      assert.equal(c.state.run?.receipt?.installation?.nextActions.length, outcome === 'verified' ? 2 : 0);
      assert.deepEqual(f.calls.filter(([command]) => command === 'get_operation_run').map(([, args]) => args), [{ runId: 'addition-run' }]);
      c.dispose();
    });

test('completion tracking retains a match at its finite bound and deduplicates repeated terminals', async () => {
  const list = deferred<unknown>(); const listed = deferred<void>();
  const f = fake({ agent_generation: () => operationHello, agent_status: () => status({ applying: true }),
    list_operation_runs: () => { listed.resolve(); return list.promise; }, get_operation_run: () => skillRun() });
  const c = new MachineController(f.bridge); const connecting = c.connect(); await listed.promise;
  for (let i = 0; i < 10_001; i++) f.emit(event('addition-run', { type: 'done', ok: 3, failed: 0 }));
  for (let i = 1; i < 10_000; i++) f.emit(event(`empty-${i}`, { type: 'done', ok: 0, failed: 0 }));
  list.resolve({ runs: [skillRun({ state: 'running', result: null, installation: undefined })], nextBefore: null });
  await connecting;
  assert.equal(c.state.run?.outcome, 'done'); assert.equal(c.state.connection, 'connected');
  assert.deepEqual(f.calls.filter(([command]) => command === 'get_operation_run').map(([, args]) => args), [{ runId: 'addition-run' }]);
  c.dispose();
});

for (const entry of ['connect', 'restart'] as const) test(`${entry} completion tracking overflow discards stale discovery and permits explicit reconnect`, async () => {
  const list = deferred<unknown>(); const listed = deferred<void>(); let reads = 0; let discovering = entry === 'connect'; let recovering = false;
  const f = fake({ agent_generation: () => discovering ? operationHello : null,
    restart_agent: () => { discovering = true; return operationHello; }, agent_status: () => status({ applying: discovering && !recovering }),
    inspect_machine: () => inspection([]), get_operation_run: () => skillRun(),
    list_operation_runs: () => { if (++reads === 1) { listed.resolve(); return list.promise; } return { runs: [skillRun()], nextBefore: null }; } });
  const c = new MachineController(f.bridge); if (entry === 'restart') await c.connect();
  const connecting = entry === 'connect' ? c.connect() : c.restart(); await listed.promise;
  f.emit(event('addition-run', { type: 'done', ok: 3, failed: 0 }));
  for (let i = 1; i <= 10_000; i++) f.emit(event(`empty-${i}`, { type: 'done', ok: 0, failed: 0 }));
  // Overflow stays invalid even when a matching event arrives again afterward.
  f.emit(event('addition-run', { type: 'done', ok: 3, failed: 0 }));
  list.resolve({ runs: [skillRun({ state: 'running', result: null, installation: undefined })], nextBefore: null });
  await connecting;
  assert.equal(c.snapshot().run, null); assert.equal(c.state.connection, 'disconnected'); assert.equal(c.state.pending, false);
  assert.match(c.state.initialReadError ?? '', /Run activity exceeded.*Reconnect/);
  assert.equal(f.calls.some(([command]) => command === 'get_operation_run'), false);
  recovering = true; await c.connect();
  assert.equal(c.state.connection, 'connected'); assert.equal(c.state.initialReadError, null);
  assert.equal(c.state.run?.outcome, 'done'); assert.equal(c.state.run?.receipt?.installation?.state, 'verified');
  c.dispose();
});

for (const prior of ['none', 'settled'] as const) test(`semantic activity discovers a run with ${prior} prior view`, async () => {
  let run = skillRun({ runId: 'semantic', state: 'running', result: null }); let lists = 0;
  const f = fake({ agent_generation: () => operationHello, inspect_machine: () => inspection([]),
    list_operation_runs: () => ({ runs: ++lists === 1 ? prior === 'settled' ? [skillRun({ runId: 'old' })] : [] : [run], nextBefore: null }), get_operation_run: () => run });
  const c = new MachineController(f.bridge); await c.connect();
  f.emit({ generation: 1, version: 3, event: 'operation-run', runId: 'semantic' } as HostEvent);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(c.state.run?.runId, 'semantic'); assert.equal(c.state.run?.outcome, 'running');
  run = skillRun({ runId: 'semantic' });
  f.emit({ generation: 1, version: 3, event: 'operation-run', runId: 'semantic' } as HostEvent);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(c.state.run?.outcome, 'done'); c.dispose();
});

test('terminal-first semantic activity refreshes without a synthetic step or reconnect', async () => {
  let lists = 0;
  const f = fake({ agent_generation: () => operationHello, inspect_machine: () => inspection([]),
    list_operation_runs: () => ({ runs: ++lists === 1 ? [] : [skillRun()], nextBefore: null }), get_operation_run: () => skillRun() });
  const c = new MachineController(f.bridge); await c.connect();
  f.emit({ generation: 1, version: 3, event: 'operation-run', runId: 'addition-run' } as HostEvent);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(c.state.run?.outcome, 'done'); assert.deepEqual(c.state.run?.steps, []); c.dispose();
});

test('semantic completion during discovery wins over an earlier receipt read', async () => {
 const first=deferred<unknown>(); let reads=0;
 const f=fake({agent_generation:()=>operationHello,inspect_machine:()=>inspection([]),
  list_operation_runs:()=>++reads===1?{runs:[],nextBefore:null}:reads===2?first.promise:{runs:[skillRun()],nextBefore:null}});
 const c=new MachineController(f.bridge);await c.connect();
 const notice:HostEvent={generation:1,version:3,event:'operation-run',runId:'addition-run'};
 f.emit(notice);f.emit(notice);await new Promise(resolve=>setTimeout(resolve,0));
 first.resolve({runs:[skillRun({state:'running',result:null})],nextBefore:null});await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(c.state.run?.outcome,'done');assert.equal(reads,3);c.dispose();
});
test('semantic discovery cannot replace an active run or cross a connection generation', async () => {
 const held=deferred<unknown>();let listed=0;
 const f=fake({agent_generation:()=>operationHello,inspect_machine:()=>inspection([]),list_operation_runs:()=>++listed===2?held.promise:{runs:listed===1?[]:[skillRun({runId:'current',state:'running',result:null})],nextBefore:null}});
 const c=new MachineController(f.bridge);await c.connect();
 f.emit({generation:1,version:3,event:'operation-run',runId:'addition-run'});
 await c.connect();held.resolve({runs:[skillRun()],nextBefore:null});await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(c.state.run?.runId,'current');
 const count=f.calls.filter(([command])=>command==='get_operation_run').length;
 f.emit({generation:1,version:3,event:'operation-run',runId:'other'});
 f.emit({generation:0,version:3,event:'operation-run',runId:'current'});
 assert.equal(f.calls.filter(([command])=>command==='get_operation_run').length,count);c.dispose();
});

test('receipt invalidations refresh completed effects after a partial snapshot', async () => {
 let run=skillRun({state:'running',result:null,steps:[{key:'first',outcome:'ok',note:'First committed'}]});
 const f=fake({agent_generation:()=>operationHello,inspect_machine:()=>inspection([]),list_operation_runs:()=>({runs:[run],nextBefore:null}),get_operation_run:()=>run});
 const c=new MachineController(f.bridge);await c.connect();
 run=skillRun({steps:[{key:'first',outcome:'ok',note:'First committed'},{key:'second',outcome:'ok',note:'Second committed'}]});
 f.emit({generation:1,version:3,event:'operation-run',runId:run.runId});await new Promise(resolve=>setTimeout(resolve,0));
 assert.deepEqual(c.state.run?.steps.map(step=>step.key),['first','second']);c.dispose();
});

import { decodeRunView } from '@nortuscc/agent/operations';

const signInRun = (id = 'authorization', state: 'awaiting-user' | 'needsInspection' | 'expired' = 'awaiting-user', expiresAt = new Date(Date.now() + 60_000).toISOString()) => decodeRunView({
  runId: id, actor: 'mcp', state: 'succeeded', operation: 'applyChange', scope: { kind: 'machine' },
  intent: { requestId: id, inputDigest: 'a'.repeat(64), planId: id, change: { kind: 'signIn' },
    parity: { kind: 'signIn', generation: '1', baselineDigest: 'a'.repeat(64), planDigest: 'b'.repeat(64), plannedKeys: [] } },
  intentSaved: false, steps: [], result: { status: 'done', ok: 0, failed: 0 },
  parity: { kind: 'signIn', state: 'committed', committedKeys: [], remainingKeys: [], backupIds: [],
    signIn: { kind: 'signIn', state, expiresAt, ...(state === 'awaiting-user' ? { userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device' } : {}) } },
});
// The device code and link a view may show: only while the run's challenge is current and unexpired.
const paintChallenge = (controller: MachineController) => {
  const run = controller.state.run, parity = run?.receipt?.parity;
  const signIn = parity?.kind === 'signIn' ? parity.signIn : undefined;
  return run?.challengeCurrent !== false && signIn?.state === 'awaiting-user' && Date.parse(signIn.expiresAt) > Date.now()
    ? `${signIn.verificationUri} ${signIn.userCode}` : '';
};
const settleReceipt = () => new Promise(resolve => setTimeout(resolve, 0));

for (const prior of ['none', 'settled'] as const) test(`old receipt scrub cannot supersede pending running discovery with ${prior} prior view`, async t => {
  const pending = deferred<unknown>();
  const old = signInRun('old', 'needsInspection'); let lists = 0;
  const f = fake({ agent_generation: () => operationHello, inspect_machine: () => inspection([]),
    list_operation_runs: () => ++lists === 1 ? { runs: prior === 'settled' ? [old] : [], nextBefore: null } : lists === 2 ? pending.promise : { runs: [skillRun({ runId: 'new', state: 'running', result: null })], nextBefore: null },
    get_operation_run: () => old });
  const c = new MachineController(f.bridge); t.after(() => c.dispose()); await c.connect();
  f.emit({ generation: 1, version: 3, event: 'operation-run', runId: 'new' });
  f.emit({ generation: 1, version: 3, event: 'operation-run', runId: 'old' });
  await settleReceipt(); pending.resolve({ runs: [skillRun({ runId: 'new', state: 'running', result: null })], nextBefore: null }); await settleReceipt();
  assert.deepEqual(f.calls.filter(([name]) => name === 'get_operation_run').map(([, args]) => args), prior === 'settled' ? [{ runId: 'old' }] : []);
  assert.equal(c.state.run?.runId, 'new'); assert.equal(c.state.run?.outcome, 'running');
});

for (const transition of ['pending', 'completed', 'replaced', 'signed-out', 'read-failed'] as const) test(`sign-in status rechecks safe authority after ${transition}`, async t => {
  const pending = deferred<unknown>();
  const f = fake({ agent_generation: () => operationHello, inspect_machine: () => inspection([]),
    list_operation_runs: () => ({ runs: [signInRun()], nextBefore: null }), get_operation_run: () => pending.promise });
  const c = new MachineController(f.bridge); t.after(() => c.dispose()); await c.connect();
  assert.match(paintChallenge(c), /ABCD-EFGH/);
  f.emit({ generation: 1, version: 3, event: 'status', status: status() });
  assert.doesNotMatch(paintChallenge(c), /ABCD-EFGH|https:\/\/github.com\/login\/device/);
  assert.equal(f.calls.filter(([name]) => name === 'get_operation_run').length, 1);
  if (transition === 'read-failed') pending.reject(new Error('fixture unavailable'));
  else pending.resolve(signInRun('authorization', transition === 'pending' ? 'awaiting-user' : 'needsInspection'));
  await settleReceipt();
  assert.equal(f.calls.filter(([name]) => name === 'get_operation_run').length, 1);
  if (transition === 'pending') assert.match(paintChallenge(c), /ABCD-EFGH/);
  else assert.doesNotMatch(paintChallenge(c), /ABCD-EFGH|https:\/\/github.com\/login\/device/);
});

test('sign-in expiry updates rendered challenge without an unrelated event', async t => {
  const expiresAt = new Date(Date.now() + 200).toISOString();
  const f = fake({ agent_generation: () => operationHello, inspect_machine: () => inspection([]),
    list_operation_runs: () => ({ runs: [signInRun('expiring', 'awaiting-user', expiresAt)], nextBefore: null }) });
  const c = new MachineController(f.bridge); t.after(() => c.dispose()); await c.connect();
  let markup = paintChallenge(c); let renders = 0;
  c.subscribe(() => { renders++; markup = paintChallenge(c); });
  assert.match(markup, /ABCD-EFGH/);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(expiresAt) - Date.now()) + 30));
  assert.ok(renders > 0); assert.doesNotMatch(markup, /ABCD-EFGH|https:\/\/github.com\/login\/device/);
});

test('sign-in refresh cannot restore a challenge after reconnect or disposal', async t => {
  const pending = deferred<unknown>(); let lists = 0;
  const f = fake({ agent_generation: () => operationHello, inspect_machine: () => inspection([]),
    list_operation_runs: () => ({ runs: [++lists === 1 ? signInRun() : skillRun({ runId: 'current' })], nextBefore: null }), get_operation_run: () => pending.promise });
  const c = new MachineController(f.bridge); t.after(() => c.dispose()); await c.connect();
  f.emit({ generation: 1, version: 3, event: 'status', status: status() });
  await c.connect(); pending.resolve(signInRun()); await settleReceipt();
  assert.equal(c.state.run?.runId, 'current'); assert.doesNotMatch(paintChallenge(c), /ABCD-EFGH/);
  c.dispose(); const disposed = c.state; await settleReceipt(); assert.equal(c.state, disposed);
});

test('sign-in replacement invalidates the previous safe read and expiry timer', async t => {
  const pending = deferred<unknown>();
  const expiresAt = new Date(Date.now() + 200).toISOString(); let lists = 0;
  const f = fake({ agent_generation: () => operationHello, inspect_machine: () => inspection([]),
    list_operation_runs: () => ({ runs: [++lists === 1 ? signInRun('old', 'awaiting-user', expiresAt) : signInRun('new')], nextBefore: null }),
    get_operation_run: args => args?.runId === 'old' ? pending.promise : signInRun('new') });
  const c = new MachineController(f.bridge); t.after(() => c.dispose()); await c.connect();
  f.emit({ generation: 1, version: 3, event: 'status', status: status() });
  f.emit({ generation: 1, version: 3, event: 'operation-run', runId: 'new' }); await settleReceipt();
  pending.resolve(signInRun('old', 'awaiting-user', expiresAt)); await settleReceipt();
  assert.equal(c.state.run?.runId, 'new'); assert.match(paintChallenge(c), /ABCD-EFGH/);
  let renders = 0; c.subscribe(() => renders++);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(expiresAt) - Date.now()) + 30));
  assert.equal(renders, 0); assert.match(paintChallenge(c), /ABCD-EFGH/);
});

test('sign-in superseded safe reads and disconnect cannot redisplay a challenge', async t => {
  const pending = deferred<unknown>(); let reads = 0;
  const f = fake({ agent_generation: () => operationHello, inspect_machine: () => inspection([]),
    list_operation_runs: () => ({ runs: [signInRun()], nextBefore: null }),
    get_operation_run: () => ++reads === 1 ? pending.promise : signInRun('authorization', 'needsInspection') });
  const c = new MachineController(f.bridge); t.after(() => c.dispose()); await c.connect();
  f.emit({ generation: 1, version: 3, event: 'status', status: status() });
  f.emit({ generation: 1, version: 3, event: 'status', status: status() }); await settleReceipt();
  pending.resolve(signInRun()); await settleReceipt();
  assert.doesNotMatch(paintChallenge(c), /ABCD-EFGH/);
  await c.connect(); assert.match(paintChallenge(c), /ABCD-EFGH/);
  f.emit({ generation: 1, event: 'disconnected', detail: 'fixture disconnected' });
  assert.doesNotMatch(paintChallenge(c), /ABCD-EFGH/);
});

for (const prior of ['none', 'settled'] as const) for (const firstReply of ['new', 'old'] as const) test(`terminal discovery survives old scrub with ${prior} prior view and ${firstReply} reply first`, async t => {
  const newer = deferred<unknown>(); const older = deferred<unknown>(); const old = signInRun('old', 'needsInspection'); let lists = 0;
  const f = fake({ agent_generation: () => operationHello, inspect_machine: () => inspection([]),
    list_operation_runs: () => ++lists === 1 ? { runs: prior === 'settled' ? [old] : [], nextBefore: null } : lists === 2 ? newer.promise : { runs: [skillRun({ runId: 'new' })], nextBefore: null },
    get_operation_run: () => older.promise });
  const c = new MachineController(f.bridge); t.after(() => c.dispose()); await c.connect();
  f.emit({ generation: 1, version: 3, event: 'operation-run', runId: 'new' });
  f.emit({ generation: 1, version: 3, event: 'operation-run', runId: 'old' });
  if (firstReply === 'new') { newer.resolve({ runs: [skillRun({ runId: 'new' })], nextBefore: null }); await settleReceipt(); older.resolve(old); }
  else { older.resolve(old); await settleReceipt(); newer.resolve({ runs: [skillRun({ runId: 'new' })], nextBefore: null }); }
  await settleReceipt(); assert.equal(c.state.run?.runId, 'new'); assert.equal(c.state.run?.outcome, 'done');
});

for (const prior of ['none', 'settled'] as const) for (const notices of ['old-new', 'new-old'] as const)
  for (const release of ['before-second-notice', 'after-second-notice'] as const)
    test(`owner acceptance order wins ${notices} discovery with ${prior} view and ${release}`, async t => {
      const firstList = deferred<unknown>(); let lists = 0;
      const old = skillRun({ runId: 'old' }); const newer = skillRun({ runId: 'new' });
      let owner = prior === 'settled' ? [skillRun({ runId: 'prior' })] : [];
      const f = fake({ agent_generation: () => operationHello, inspect_machine: () => inspection([]),
        list_operation_runs: () => ++lists === 2 ? firstList.promise : { runs: owner.slice(0, 1), nextBefore: null },
        get_operation_run: () => { throw new Error('Unknown discovery must use owner acceptance order'); } });
      const c = new MachineController(f.bridge); t.after(() => c.dispose()); await c.connect();
      owner = notices === 'old-new' ? [old] : [newer, old];
      const snapshot = { runs: owner.slice(0, 1), nextBefore: null };
      f.emit({ generation: 1, version: 3, event: 'operation-run', runId: notices === 'old-new' ? 'old' : 'new' });
      if (release === 'before-second-notice') { firstList.resolve(snapshot); await settleReceipt(); }
      // Acceptance order is independent of notification and reply delivery.
      owner = [newer, old];
      f.emit({ generation: 1, version: 3, event: 'operation-run', runId: notices === 'old-new' ? 'new' : 'old' });
      if (release === 'after-second-notice') firstList.resolve(snapshot);
      await settleReceipt(); assert.equal(c.state.run?.runId, 'new'); assert.equal(c.state.run?.outcome, 'done');
      assert.equal(lists, 3); assert.equal(f.calls.filter(([name]) => name === 'get_operation_run').length, 0);
    });

for (const result of ['awaiting-user', 'needsInspection', 'failed'] as const) test(`initial sign-in list is fenced by status before ${result} revalidation`, async t => {
  const initial = deferred<unknown>(); const listed = deferred<void>(); const validated = deferred<unknown>();
  const f = fake({ agent_generation: () => operationHello, inspect_machine: () => inspection([]),
    list_operation_runs: () => { listed.resolve(); return initial.promise; }, get_operation_run: () => validated.promise });
  const c = new MachineController(f.bridge); t.after(() => c.dispose());
  const renders: string[] = []; c.subscribe(() => renders.push(paintChallenge(c)));
  const connecting = c.connect(); await listed.promise;
  f.emit({ generation: 1, version: 3, event: 'status', status: status() }); const afterStatus = renders.length;
  initial.resolve({ runs: [signInRun()], nextBefore: null }); await settleReceipt();
  assert.equal(f.calls.filter(([name]) => name === 'get_operation_run').length, 1);
  assert.ok(renders.slice(afterStatus).every(markup => !/ABCD-EFGH|https:\/\/github.com\/login\/device/.test(markup)));
  if (result === 'failed') validated.reject(new Error('fixture unavailable'));
  else validated.resolve(signInRun('authorization', result));
  await connecting; await settleReceipt();
  if (result === 'awaiting-user') assert.match(paintChallenge(c), /ABCD-EFGH/);
  else assert.doesNotMatch(paintChallenge(c), /ABCD-EFGH|https:\/\/github.com\/login\/device/);
});

test('initial terminal-selected sign-in get is fenced by status before its first display', async t => {
  const initial = deferred<unknown>(); const listed = deferred<void>(); const read = deferred<unknown>(); const queried = deferred<void>(); let gets = 0;
  const f = fake({ agent_generation: () => operationHello, inspect_machine: () => inspection([]),
    list_operation_runs: () => { listed.resolve(); return initial.promise; },
    get_operation_run: () => { if (++gets === 1) { queried.resolve(); return read.promise; } return signInRun('authorization', 'needsInspection'); } });
  const c = new MachineController(f.bridge); t.after(() => c.dispose());
  const renders: string[] = []; c.subscribe(() => renders.push(paintChallenge(c)));
  const connecting = c.connect(); await listed.promise;
  f.emit(event('authorization', { type: 'done', ok: 0, failed: 0 }));
  initial.resolve({ runs: [signInRun()], nextBefore: null }); await queried.promise;
  f.emit({ generation: 1, version: 3, event: 'status', status: status() }); const afterStatus = renders.length;
  read.resolve(signInRun()); await connecting; await settleReceipt();
  assert.equal(gets, 2); assert.ok(renders.slice(afterStatus).every(markup => !/ABCD-EFGH|https:\/\/github.com\/login\/device/.test(markup)));
});

test('unknown semantic invalidations coalesce to one in-flight acceptance-ordered list and one follow-up', async t => {
  const pending = deferred<unknown>(); let lists = 0; let active = 0; let maximum = 0;
  let owner = skillRun({ runId: 'old' });
  const f = fake({ agent_generation: () => operationHello, inspect_machine: () => inspection([]),
    list_operation_runs: async args => {
      assert.deepEqual(args, { limit: 50 }); lists++; active++; maximum = Math.max(maximum, active);
      try { return lists === 1 ? { runs: [], nextBefore: null } : lists === 2 ? await pending.promise : { runs: [owner], nextBefore: null }; }
      finally { active--; }
    } });
  const c = new MachineController(f.bridge); t.after(() => c.dispose()); await c.connect();
  f.emit({ generation: 1, version: 3, event: 'operation-run', runId: 'old' });
  owner = skillRun({ runId: 'latest' });
  for (let i = 0; i < 100; i++) f.emit({ generation: 1, version: 3, event: 'operation-run', runId: `scrub-${i}` });
  assert.equal(lists, 2); pending.resolve({ runs: [skillRun({ runId: 'old' })], nextBefore: null }); await settleReceipt();
  assert.equal(lists, 3); assert.equal(maximum, 1); assert.equal(c.state.run?.runId, 'latest');
});

test('different-run discovery deferred by an active run flushes after its terminal safe read', async t => {
  let current = skillRun({ runId: 'active', state: 'running', result: null }); let latest = current; let lists = 0;
  const f = fake({ agent_generation: () => operationHello, inspect_machine: () => inspection([]),
    list_operation_runs: () => { lists++; return { runs: [latest], nextBefore: null }; }, get_operation_run: () => current });
  const c = new MachineController(f.bridge); t.after(() => c.dispose()); await c.connect();
  latest = skillRun({ runId: 'latest' });
  f.emit({ generation: 1, version: 3, event: 'operation-run', runId: 'latest' });
  assert.equal(lists, 1); assert.equal(c.state.run?.runId, 'active');
  current = skillRun({ runId: 'active' });
  f.emit({ generation: 1, version: 3, event: 'operation-run', runId: 'active' }); await settleReceipt();
  assert.equal(lists, 2); assert.equal(c.state.run?.runId, 'latest');
});

test('initial sign-in revalidation cannot cross a reconnect or restore a replaced run', async t => {
  const initial = deferred<unknown>(); const listed = deferred<void>(); const validated = deferred<unknown>(); let lists = 0;
  const f = fake({ agent_generation: () => operationHello, inspect_machine: () => inspection([]),
    list_operation_runs: () => { if (++lists === 1) { listed.resolve(); return initial.promise; } return { runs: [skillRun({ runId: 'replacement' })], nextBefore: null }; },
    get_operation_run: () => validated.promise });
  const c = new MachineController(f.bridge); t.after(() => c.dispose());
  const renders: string[] = []; c.subscribe(() => renders.push(paintChallenge(c)));
  const connecting = c.connect(); await listed.promise;
  f.emit({ generation: 1, version: 3, event: 'status', status: status() });
  initial.resolve({ runs: [signInRun()], nextBefore: null }); await settleReceipt();
  await c.connect(); validated.resolve(signInRun()); await connecting; await settleReceipt();
  assert.equal(c.state.run?.runId, 'replacement');
  assert.ok(renders.every(markup => !/ABCD-EFGH|https:\/\/github.com\/login\/device/.test(markup)));
});

test('initial listing cannot overwrite newer same-run terminal progress and targeted receipt', async t => {
  const initial = deferred<unknown>(); const listed = deferred<void>();
  const f = fake({ agent_generation: () => operationHello, inspect_machine: () => inspection([]),
    list_operation_runs: () => { listed.resolve(); return initial.promise; }, get_operation_run: () => skillRun({ runId: 'same' }) });
  const c = new MachineController(f.bridge); t.after(() => c.dispose()); const connecting = c.connect(); await listed.promise;
  f.emit(event('same', { type: 'started', index: 0, total: 1, step: step('config:a') }));
  f.emit(event('same', { type: 'done', ok: 1, failed: 0 })); await settleReceipt();
  assert.equal(c.state.run?.outcome, 'done');
  initial.resolve({ runs: [skillRun({ runId: 'same', state: 'running', result: null })], nextBefore: null }); await connecting;
  assert.equal(c.state.run?.outcome, 'done'); assert.equal(c.state.run?.receipt?.state, 'succeeded');
});

for (const state of ['interrupted', 'abandoned'] as const) {
  test(`durable ${state} runs keep their own outcome instead of appearing failed`, async () => {
    const run = skillRun({ state, result: { status: 'interrupted', message: 'Inspect retained effects' } });
    const f = fake({ agent_generation: () => operationHello, list_operation_runs: () => ({ runs: [run], nextBefore: null }), inspect_machine: () => inspection([]) });
    const c = new MachineController(f.bridge);
    try { await c.connect(); assert.equal(c.state.run?.outcome, state); }
    finally { c.dispose(); }
  });
}

test('only a matching status cause refreshes the current shared run', async () => {
  let run = skillRun({ state: 'running', result: null });
  const f = fake({ agent_generation: () => operationHello, list_operation_runs: () => ({ runs: [run], nextBefore: null }), get_operation_run: () => run, inspect_machine: () => inspection([]) });
  const c = new MachineController(f.bridge);
  try {
    await c.connect(); run = skillRun();
    f.emit({ generation: 1, version: 3, event: 'status', runId: 'other', status: status({ applying: false }) }); await settleReceipt();
    assert.equal(c.state.run?.outcome, 'running'); assert.equal(f.calls.some(([command]) => command === 'get_operation_run'), false);
    f.emit({ generation: 1, version: 3, event: 'status', runId: 'addition-run', status: status({ applying: false }) }); await settleReceipt();
    assert.equal(c.state.run?.outcome, 'done');
  } finally { c.dispose(); }
});
