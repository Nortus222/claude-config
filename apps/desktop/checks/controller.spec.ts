import test from 'node:test';
import assert from 'node:assert/strict';
import { MachineController, advance, type RunView } from '../src/controller.ts';
import type { Bridge, Command, HostEvent } from '../src/bridge.ts';

const step = (key: string) => ({ key, domain: 'config', action: 'write-file', summary: `write ${key}`, touches: [key], interruptible: false });
const inspection = (keys: string[]) => ({
  profile: { repo: '/r', revision: 'abc', overrides: '/s/overrides.json', issues: [] },
  items: keys.map((key) => ({ key, domain: 'config', target: 'claude', label: key, group: 'Files', state: 'repo-ahead', disposition: 'apply' })),
  probeErrors: [],
});
const plan = (keys: string[]) => ({ kind: 'apply', steps: keys.map(step), skipped: [] });
const event = (runId: string, progress: unknown, generation = 1): HostEvent => ({ generation, version: 2, event: 'progress', runId, progress } as HostEvent);

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
      const data = handler ? await handler(args) : null;
      return { generation, data };
    },
  };
  return { bridge, calls, emit: (e: HostEvent) => receive(e) };
}

test('connect subscribes, learns the generation, then inspects', async () => {
  const f = fake({ inspect_machine: () => inspection(['config:a']) });
  const c = new MachineController(f.bridge);
  await c.connect();
  assert.deepEqual(f.calls.map(([name]) => name), ['subscribe', 'backend_generation', 'inspect_machine']);
  assert.equal(c.state.connection, 'connected');
  assert.equal(c.state.inspection?.items.length, 1);
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

test('cancel reaches the backend and a cancelled run keeps unstarted steps pending', async () => {
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
    restart_backend: () => ((generation = 2), null),
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

test('advance ignores nothing it should not', () => {
  const run: RunView = { runId: 'r', steps: [{ key: 'a', summary: 'a', status: 'pending', note: '' }], outcome: 'running', summary: '' };
  assert.equal(advance(run, { type: 'failed', message: 'another nortuscc run (pid 4) holds /s/apply.lock' }).summary, 'another nortuscc run (pid 4) holds /s/apply.lock');
  assert.equal(advance(run, { type: 'failed', message: 'x' }).outcome, 'failed');
});
