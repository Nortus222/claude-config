import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { Processes, HistoryStore, Fs, FsFailed, type Command } from '@nortuscc/machine';
import { AgentStateStore, makeNotifier, type Notification, type AgentStatus, type Pending } from '../src/index.ts';
import { agentMachine } from './support/agent-machine.ts';

const item = (itemId: string, held = true): Pending => ({ key: itemId, itemId, verdict: held ? { kind: 'held', reason: 'not a known item' } : { kind: 'inert' } });
const status = (pending: readonly Pending[] = [], fields: Partial<AgentStatus> = {}): AgentStatus => ({ at: 'now', policy: 'notify', paused: null, trusted: true, pending, drift: [], conflicts: [], probeErrors: [], ...fields });
const fixture = (t: { after: (f: () => void) => void }, platform = 'darwin', run: (c: Command) => Effect.Effect<{ code: number; stdout: string }> = () => Effect.succeed({ code: 1, stdout: '' })) => {
  const m = agentMachine(); t.after(() => rmSync(m.root, { recursive: true, force: true }));
  const create = () => m.run(makeNotifier({ platform, timeoutMs: 15 }).pipe(Effect.provideService(Processes, { run })));
  const path = join(m.paths.stateRoot, 'agent', 'notified.json');
  return { m, create, path };
};

test('sorted unique batches deduplicate across restart and recurrence', async (t) => {
  const f = fixture(t); const seen: Notification[] = [];
  let n = await f.create(); n.setConnected((v) => Effect.sync(() => { seen.push(v); return true; }));
  await Effect.runPromise(n.notify(status([item('b'), item('a'), item('a')])));
  n = await f.create(); n.setConnected((v) => Effect.sync(() => { seen.push(v); return true; }));
  await Effect.runPromise(n.notify(status([item('a'), item('b')])));
  await Effect.runPromise(n.notify(status()));
  await Effect.runPromise(n.notify(status([item('a'), item('b')])));
  assert.equal(seen.length, 1); assert.match(seen[0]!.id, /^[a-f0-9]{64}$/);
  assert.deepEqual(await Effect.runPromise(n.get(seen[0]!.id)), seen[0]);
  assert.equal(await Effect.runPromise(n.get('unknown')), undefined);
});

test('held items notify on every policy and ready items only on notify', async (t) => {
  for (const policy of ['manual', 'notify', 'auto-apply'] as const) {
    const f = fixture(t); const seen: Notification[] = []; const n = await f.create();
    n.setConnected((v) => Effect.sync(() => { seen.push(v); return true; }));
    await Effect.runPromise(n.notify(status([item('ready', false)], { policy })));
    assert.equal(seen.length, policy === 'notify' ? 1 : 0);
    await Effect.runPromise(n.notify(status([item('held')], { policy })));
    assert.equal(seen.length, policy === 'notify' ? 2 : 1);
  }
});

test('new failures pause and rejection coalesce and remain distinct by durable identity', async (t) => {
  const f = fixture(t); const n = await f.create(); const seen: Notification[] = [];
  n.setConnected((v) => Effect.sync(() => { seen.push(v); return true; }));
  const append = (runId: string) => f.m.run(HistoryStore.use((h) => Effect.all([
    h.append({ actor: 'cli', kind: 'apply-finished', runId, steps: [{ key: 'x', outcome: 'failed', note: 'bad' }], backup: null, result: 'done' }),
    h.append({ actor: 'agent', kind: 'paused', reason: 'bad', runId }),
    h.append({ actor: 'agent', kind: 'revision-rejected', setupId: 's', revision: runId }),
  ])));
  await append('r1'); await Effect.runPromise(n.notify(status())); assert.equal(seen.length, 1);
  await Effect.runPromise(n.notify(status([], { at: 'later' }))); assert.equal(seen.length, 1);
  await append('r2'); await Effect.runPromise(n.notify(status())); assert.equal(seen.length, 2);
  assert.notEqual(seen[0]!.id, seen[1]!.id);
});

test('successful or cancelled runs and historical ready batches are silent', async (t) => {
  const f = fixture(t); const n = await f.create(); let delivered = 0;
  n.setConnected(() => Effect.sync(() => { delivered++; return true; }));
  for (const result of ['done', 'cancelled'] as const) await f.m.run(HistoryStore.use((h) => h.append({ actor: 'agent', kind: 'apply-finished', runId: result, steps: [{ key: 'x', outcome: result === 'done' ? 'ok' : 'cancelled', note: '' }], backup: null, result })));
  await f.m.run(HistoryStore.use((h) => h.append({ actor: 'agent', kind: 'ready', items: [{ itemId: 'old', reason: 'inert' }] })));
  await Effect.runPromise(n.notify(status([item('old', false)], { policy: 'auto-apply', autoApply: { kind: 'ran', runId: 'done', result: 'done', failed: 0, backup: null } })));
  assert.equal(delivered, 0);
});

test('inspection error identity excludes poll timestamp and bounds text', async (t) => {
  const f = fixture(t); const n = await f.create(); const seen: Notification[] = [];
  n.setConnected((v) => Effect.sync(() => { seen.push(v); return true; }));
  await Effect.runPromise(n.notify(status([], { error: 'JOB_FAILED', detail: 'x'.repeat(2000) })));
  await Effect.runPromise(n.notify(status([], { at: 'later', error: 'JOB_FAILED', detail: 'x'.repeat(2000) })));
  assert.equal(seen.length, 1); assert.ok(seen[0]!.title.length <= 100); assert.ok(seen[0]!.body.length <= 500);
});

test('registered app payload and ACK waiter exist before launch; open exit alone is insufficient', async (t) => {
  const commands: Command[] = []; let ack = false;
  const f = fixture(t, 'darwin', (c) => Effect.gen(function* () {
    commands.push(c); const id = c.args.at(-1)!;
    assert.ok(yield* notifier.get(id));
    if (ack) assert.equal(notifier.acknowledge(id, true, notifier.receipt(id)!), true);
    return { code: 0, stdout: '' };
  }));
  await f.m.run(AgentStateStore.use((s) => s.update((v) => ({ ...v, installedBy: 'app', appPath: '/Applications/Test.app/Contents/MacOS/Test' }))));
  const notifier = await f.create();
  await Effect.runPromise(notifier.notify(status([item('x')]))); assert.equal(commands.length, 1);
  ack = true; await Effect.runPromise(notifier.notify(status([item('x')]))); assert.equal(commands.length, 2);
  await Effect.runPromise(notifier.notify(status([item('x')]))); assert.equal(commands.length, 2);
  assert.deepEqual(commands[0]!.args.slice(0, -1), ['-g', '-a', '/Applications/Test.app', '--args', '--notify']);
  assert.equal(notifier.acknowledge(commands[0]!.args.at(-1)!, true, 'expired'), false);
});

test('connected refusal or timeout falls through to Linux; successful delivery deduplicates', async (t) => {
  for (const timeout of [false, true]) {
    const calls: Command[] = []; const f = fixture(t, 'linux', (c) => Effect.sync(() => { calls.push(c); return { code: 0, stdout: '' }; }));
    const n = await f.create(); n.setConnected(() => timeout ? Effect.never : Effect.succeed(false));
    await Effect.runPromise(n.notify(status([item('x')]))); await Effect.runPromise(n.notify(status([item('x')])));
    assert.equal(calls.length, 1); assert.equal(calls[0]!.cmd, 'notify-send'); assert.equal(calls[0]!.output, 'capture');
  }
});

test('no channel is retryable and never scans or launches an unregistered path', async (t) => {
  const calls: Command[] = []; const f = fixture(t, 'darwin', (c) => Effect.sync(() => { calls.push(c); return { code: 0, stdout: '' }; }));
  await f.m.run(AgentStateStore.use((s) => s.update((v) => ({ ...v, installedBy: 'cli', appPath: '/Applications/Test.app/Contents/MacOS/Test' }))));
  const n = await f.create(); await Effect.runPromise(n.notify(status([item('x')]))); assert.equal(calls.length, 0);
  let deliveries = 0; n.setConnected(() => Effect.sync(() => { deliveries++; return true; }));
  await Effect.runPromise(n.notify(status([item('x')]))); assert.equal(deliveries, 1);
});

test('concurrent identical batches serialize and corrupt stores are preserved', async (t) => {
  const f = fixture(t); const n = await f.create(); let delivered = 0;
  n.setConnected(() => Effect.sync(() => { delivered++; return true; }));
  await Effect.runPromise(Effect.all([n.notify(status([item('x')])), n.notify(status([item('x')]))], { concurrency: 'unbounded' })); assert.equal(delivered, 1);
  f.m.write(f.path, '{broken'); await Effect.runPromise(n.notify(status([item('y')])));
  assert.equal(f.m.read(f.path), '{broken'); assert.equal(delivered, 1);
});

test('unreadable and unwritable ledgers never fail jobs or post unpersisted payloads', async (t) => {
  for (const failure of ['read', 'write'] as const) {
    const f = fixture(t); let delivered = 0;
    const n = await f.m.run(Effect.gen(function* () {
      const fs = yield* Fs;
      return yield* makeNotifier({ platform: 'darwin', timeoutMs: 10 }).pipe(Effect.provideService(Fs, {
        ...fs,
        readText: (path) => failure === 'read' && path === f.path ? Effect.fail(new FsFailed({ op: 'test', path, reason: 'denied' })) : fs.readText(path),
        writeTextAtomic: (path, value) => failure === 'write' && path === f.path ? Effect.fail(new FsFailed({ op: 'test', path, reason: 'denied' })) : fs.writeTextAtomic(path, value),
      }), Effect.provideService(Processes, { run: () => Effect.succeed({ code: 1, stdout: '' }) }));
    }));
    n.setConnected(() => Effect.sync(() => { delivered++; return true; }));
    await Effect.runPromise(n.notify(status([item('x')])));
    assert.equal(delivered, 0); assert.equal(await Effect.runPromise(n.get('unknown')), undefined);
  }
});

test('native app refusal and Linux nonzero stay retryable, connected success stops fallback', async (t) => {
  const calls: Command[] = []; let n: import('../src/notifier.ts').Notifier;
  const f = fixture(t, 'linux', (c) => Effect.sync(() => {
    calls.push(c); if (c.cmd === '/opt/Test') assert.equal(n.acknowledge(c.args[1]!, false, n.receipt(c.args[1]!)!), true);
    return { code: c.cmd === '/opt/Test' ? 0 : 1, stdout: '' };
  }));
  await f.m.run(AgentStateStore.use((s) => s.update((v) => ({ ...v, installedBy: 'app', appPath: '/opt/Test' }))));
  n = await f.create();
  await Effect.runPromise(n.notify(status([item('x')]))); await Effect.runPromise(n.notify(status([item('x')])));
  assert.deepEqual(calls.map((c) => c.cmd), ['/opt/Test', 'notify-send', '/opt/Test', 'notify-send']);
  n.setConnected(() => Effect.succeed(true)); await Effect.runPromise(n.notify(status([item('x')])));
  assert.equal(calls.length, 4);
  const restarted = await f.create(); restarted.setConnected(() => Effect.die(new Error('must deduplicate')));
  await Effect.runPromise(restarted.notify(status([item('x')]))); assert.equal(calls.length, 4);
});

test('ACK deadline rejects late acknowledgments even while launch is stuck', async (t) => {
  let accepted: boolean | undefined; let n: import('../src/notifier.ts').Notifier;
  const f = fixture(t, 'darwin', (c) => Effect.promise(async () => {
    const receipt = n.receipt(c.args.at(-1)!)!;
    await new Promise((resolve) => setTimeout(resolve, 30));
    accepted = n.acknowledge(c.args.at(-1)!, true, receipt);
    return { code: 0, stdout: '' };
  }));
  await f.m.run(AgentStateStore.use((s) => s.update((v) => ({ ...v, installedBy: 'app', appPath: '/Applications/Test.app/Contents/MacOS/Test' }))));
  n = await f.create(); await Effect.runPromise(n.notify(status([item('x')])));
  await new Promise((resolve) => setTimeout(resolve, 40)); assert.equal(accepted, false);
});

test('unreadable app registration still permits Linux fallback', async (t) => {
  let delivered = 0; const f = fixture(t, 'linux');
  const n = await f.m.run(makeNotifier({ platform: 'linux', timeoutMs: 10 }).pipe(
    Effect.provideService(AgentStateStore, { read: Effect.fail(new FsFailed({ op: 'read', path: 'agent.json', reason: 'denied' })), update: () => Effect.die('unused') }),
    Effect.provideService(Processes, { run: () => Effect.sync(() => { delivered++; return { code: 0, stdout: '' }; }) }),
  ));
  await Effect.runPromise(n.notify(status([item('x')]))); assert.equal(delivered, 1);
});

test('held and ready items coalesce, and obsolete undelivered item batches stay silent', async (t) => {
  const f = fixture(t); const n = await f.create();
  await Effect.runPromise(n.notify(status([item('obsolete')])));
  const seen: Notification[] = []; n.setConnected((v) => Effect.sync(() => { seen.push(v); return true; }));
  await Effect.runPromise(n.notify(status([item('held'), item('ready', false)])));
  assert.equal(seen.length, 1);
  await Effect.runPromise(n.notify(status([item('ready', false), item('held')])));
  assert.equal(seen.length, 1);
});

test('new faults after restart never renotify previously delivered fault identities', async (t) => {
  const f = fixture(t); const seen: Notification[] = [];
  const first = await f.create(); first.setConnected((v) => Effect.sync(() => { seen.push(v); return true; }));
  await Effect.runPromise(first.notify(status([], { error: 'JOB_FAILED', detail: 'first' })));
  const restarted = await f.create(); restarted.setConnected((v) => Effect.sync(() => { seen.push(v); return true; }));
  await Effect.runPromise(restarted.notify(status([], { error: 'JOB_FAILED', detail: 'first', paused: { at: 'pause1', reason: 'paused' } })));
  await Effect.runPromise(restarted.notify(status([], { paused: { at: 'pause1', reason: 'paused' } })));
  assert.equal(seen.length, 2);
});

test('an apply with failed steps notifies even when its run later cancels', async (t) => {
  const f = fixture(t); const n = await f.create(); let delivered = 0;
  n.setConnected(() => Effect.sync(() => { delivered++; return true; }));
  await f.m.run(HistoryStore.use((h) => h.append({ actor: 'app', kind: 'apply-finished', runId: 'failed-then-cancelled', result: 'cancelled', backup: null, steps: [{ key: 'failed', outcome: 'failed', note: 'bad' }, { key: 'cancelled', outcome: 'cancelled', note: '' }] })));
  await Effect.runPromise(n.notify(status())); assert.equal(delivered, 1);
});

test('a late helper ACK cannot acknowledge a later retry of the same durable batch', async (t) => {
  let n: import('../src/notifier.ts').Notifier; let firstReceipt: string | undefined; let launches = 0;
  const receipts: string[] = []; const outcomes: boolean[] = [];
  const f = fixture(t, 'darwin', (c) => Effect.sync(() => {
    const id = c.args.at(-1)!; const active = n.receipt(id)!; launches++;
    receipts.push(active);
    if (launches === 1) firstReceipt = active;
    else {
      outcomes.push(n.acknowledge(id, true, firstReceipt!), n.acknowledge(id, true, active));
    }
    return { code: 0, stdout: '' };
  }));
  await f.m.run(AgentStateStore.use((s) => s.update((v) => ({ ...v, installedBy: 'app', appPath: '/Applications/Test.app/Contents/MacOS/Test' }))));
  n = await f.create(); await Effect.runPromise(n.notify(status([item('x')])));
  await Effect.runPromise(n.notify(status([item('x')])));
  await Effect.runPromise(n.notify(status([item('x')])));
  assert.equal(launches, 2);
  assert.deepEqual(outcomes, [false, true]);
  assert.notEqual(receipts[0], receipts[1]);
  for (const receipt of receipts) assert.match(receipt, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});

test('bounded notification text preserves whole Unicode characters at the UTF16 limit', async (t) => {
  const f = fixture(t); const n = await f.create(); const seen: Notification[] = [];
  n.setConnected((v) => Effect.sync(() => { seen.push(v); return true; }));
  await Effect.runPromise(n.notify(status([], { error: 'JOB_FAILED', detail: 'x'.repeat(499) + '😀' })));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.body, 'x'.repeat(499));
  assert.ok(seen[0]!.body.length <= 500);
  await Effect.runPromise(n.notify(status([], { error: 'JOB_FAILED', detail: 'x'.repeat(498) + '😀' })));
  assert.equal(seen[1]!.body, 'x'.repeat(498) + '😀');
  assert.equal(seen[1]!.body.length, 500);
});
