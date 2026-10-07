import test from 'node:test';
import assert from 'node:assert/strict';
import { MachineController, advance, type RunView } from '../src/controller.ts';
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
  assert.deepEqual(f.calls.map(([name]) => name), ['subscribe', 'agent_generation', 'agent_status', 'inspect_machine']);
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
  assert.match(c.state.detail, /starting/i);
  f.emit({ generation: 1, version: 3, event: 'status', status: status() } as HostEvent);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(c.snapshot().inspection?.items.length, 1);
  assert.equal(c.state.status?.policy, 'notify');
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
