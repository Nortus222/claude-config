import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Exit, Layer, Stream } from 'effect';
import type { DesiredConfig } from '@nortuscc/profile-engine';
import {
  Backups, backupsForRun, execute, Fs, FsFailed, inspect, machinePaths, nodeFs, nodeProcesses, plan, Processes, samePlan, selectAll,
  type Domain, type MachinePaths, type MachineReport, type Observed, type Plan, type Progress, type Step,
} from '../src/index.ts';

const desired: DesiredConfig = { files: [], skills: [], integrations: [], allow: {}, issues: [] };
const item = (key: string, disposition: Observed['disposition'] = 'apply'): Observed =>
  ({ key, domain: 'config', target: 'claude', label: key, group: 'g', state: 's', disposition });
const empty: MachineReport = { desired, items: [], probeErrors: [] };
const step = (key: string, interruptible = false): Step =>
  ({ key, domain: 'config', action: 'write-file', summary: key, touches: [], interruptible });

const fake = <R = never>(run: Domain<R>['run'], items: Observed[] = [], name: Domain['name'] = 'config'): Domain<R> => ({
  name,
  inspect: () => Effect.succeed({ items, probeErrors: ['codex unreadable'] }),
  steps: (selected, _selection, _kind, _desired) => ({
    steps: selected.filter((o) => o.disposition === 'apply').map((o) => step(o.key, o.key.startsWith('proc'))),
    skipped: selected.filter((o) => o.disposition === 'blocked').map((o) => ({ key: o.key, reason: 'conflict' })),
  }),
  run,
});

const machine = () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'machine-run-'));
  const paths = { repo: stateRoot, claude: stateRoot, codex: stateRoot, codexOpenRouter: stateRoot, agentsSkills: stateRoot, stateRoot, backups: join(stateRoot, 'backups') };
  const layer = backupsForRun().pipe(Layer.provideMerge(Layer.mergeAll(machinePaths(paths), nodeFs)));
  const collect = (stream: Stream.Stream<Progress, unknown, Backups | MachinePaths>) =>
    Effect.runPromiseExit(Stream.runCollect(stream).pipe(Effect.map((c) => [...c]), Effect.provide(layer)));
  return { stateRoot, collect };
};

test('inspect concatenates items and probe errors', async () => {
  const report = await Effect.runPromise(inspect(desired, [fake(() => Effect.succeed({ ok: true }), [item('a')])]));
  assert.deepEqual(report.items.map((o) => o.key), ['a']);
  assert.deepEqual(report.probeErrors, ['codex unreadable']);
});

test('plan applies only/exclude, then lets the domain decide', () => {
  const report: MachineReport = { desired, items: [item('a'), item('b'), item('c', 'blocked'), item('d')], probeErrors: [] };
  const result = plan('apply', report, { ...selectAll, exclude: ['d'] }, [fake(() => Effect.succeed({ ok: true }))]);
  assert.deepEqual(result.steps.map((s) => s.key), ['a', 'b']);
  assert.deepEqual(result.skipped, [{ key: 'd', reason: 'not selected' }, { key: 'c', reason: 'conflict' }]);
  assert.equal(result.kind, 'apply');
});

test('execute reports each step and isolates failures', async () => {
  const { collect } = machine();
  const domain = fake((s) => s.key === 'b' ? Effect.fail('nope') : s.key === 'c' ? Effect.die(new Error('boom')) : Effect.succeed({ ok: true, note: 'written' }));
  const exit = await collect(execute({ kind: 'apply', steps: [step('a'), step('b'), step('c')], skipped: [] }, empty, [domain]));
  assert.ok(Exit.isSuccess(exit));
  const events = Exit.isSuccess(exit) ? exit.value : [];
  assert.deepEqual(events.map((e) => e.type === 'finished' ? `${e.key}:${e.outcome}` : e.type),
    ['started', 'a:ok', 'started', 'b:failed', 'started', 'c:failed', 'done']);
  assert.deepEqual(events.at(-1), { type: 'done', ok: 1, failed: 2, backups: undefined });
});

test('a held lock fails the run before any step', async () => {
  const { stateRoot, collect } = machine();
  writeFileSync(join(stateRoot, 'apply.lock'), JSON.stringify({ pid: process.ppid }));
  let ran = false;
  const exit = await collect(execute({ kind: 'apply', steps: [step('a')], skipped: [] }, empty, [fake(() => Effect.sync(() => { ran = true; return { ok: true }; }))]));
  assert.ok(Exit.isFailure(exit) && String(exit.cause).includes('LockHeld'));
  assert.equal(ran, false);
});

test('an already-aborted signal runs nothing and releases the lock', async () => {
  const { stateRoot, collect } = machine();
  const controller = new AbortController();
  controller.abort();
  const exit = await collect(execute({ kind: 'apply', steps: [step('a'), step('b')], skipped: [] }, empty, [fake(() => Effect.die('must not run'))], { signal: controller.signal }));
  assert.ok(Exit.isSuccess(exit));
  assert.deepEqual(Exit.isSuccess(exit) && exit.value, [{ type: 'cancelled', remaining: ['a', 'b'], backups: undefined }]);
  assert.equal(existsSync(join(stateRoot, 'apply.lock')), false);
});

test('cancelling mid-run finishes the file step and stops before the next', async () => {
  const { collect } = machine();
  const controller = new AbortController();
  const domain = fake((s) => s.key === 'a'
    ? Effect.sleep('50 millis').pipe(Effect.tap(() => Effect.sync(() => controller.abort())), Effect.as({ ok: true }))
    : Effect.die('must not run'));
  const exit = await collect(execute({ kind: 'apply', steps: [step('a'), step('b')], skipped: [] }, empty, [domain], { signal: controller.signal }));
  const events = Exit.isSuccess(exit) ? exit.value : [];
  assert.deepEqual(events.map((e) => e.type === 'finished' ? `${e.key}:${e.outcome}` : e.type), ['started', 'a:ok', 'cancelled']);
  assert.deepEqual((events.at(-1) as { remaining: readonly string[] }).remaining, ['b']);
});

test('cancelling interrupts an interruptible step and runs its finalizer', async () => {
  const { collect } = machine();
  const controller = new AbortController();
  let finalized = false;
  const domain = fake(() => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { finalized = true; }))));
  setTimeout(() => controller.abort(), 30);
  const exit = await collect(execute({ kind: 'apply', steps: [step('proc-a', true), step('b')], skipped: [] }, empty, [domain], { signal: controller.signal }));
  const events = Exit.isSuccess(exit) ? exit.value : [];
  assert.deepEqual(events.map((e) => e.type === 'finished' ? `${e.key}:${e.outcome}` : e.type), ['started', 'proc-a:cancelled', 'cancelled']);
  assert.equal(finalized, true);
});

test('a domain whose run throws synchronously finishes failed and the run continues', async () => {
  const { collect } = machine();
  const domain = fake((s) => { if (s.key === 'a') throw new Error('sync'); return Effect.succeed({ ok: true }); });
  const exit = await collect(execute({ kind: 'apply', steps: [step('a'), step('b')], skipped: [] }, empty, [domain]));
  const events = Exit.isSuccess(exit) ? exit.value : [];
  assert.deepEqual(events.map((e) => e.type === 'finished' ? `${e.key}:${e.outcome}` : e.type),
    ['started', 'a:failed', 'started', 'b:ok', 'done']);
});

test('a lock acquisition defect fails the stream instead of hanging', async () => {
  const { stateRoot } = machine();
  const file = join(stateRoot, 'not-a-dir');
  writeFileSync(file, '');
  const paths = { repo: file, claude: file, codex: file, codexOpenRouter: file, agentsSkills: file, stateRoot: join(file, 'sub'), backups: join(file, 'b') };
  const layer = backupsForRun().pipe(Layer.provideMerge(Layer.mergeAll(machinePaths(paths), nodeFs)));
  const run = Effect.runPromiseExit(
    Stream.runCollect(execute({ kind: 'apply', steps: [step('a')], skipped: [] }, empty, [fake(() => Effect.succeed({ ok: true }))])).pipe(Effect.provide(layer)),
  );
  const timeout = new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 3000).unref());
  const result = await Promise.race([run, timeout]);
  assert.notEqual(result, 'hung');
  assert.ok(typeof result !== 'string' && Exit.isFailure(result));
});

test('done reports the run folder once a step moved a file aside', async () => {
  const { stateRoot, collect } = machine();
  const file = join(stateRoot, 'victim.txt');
  writeFileSync(file, 'x');
  const domain = fake(() => Effect.gen(function* () {
    yield* (yield* Backups).moveAside(file, 'victim.txt', 'claude');
    return { ok: true };
  }));
  const exit = await collect(execute({ kind: 'apply', steps: [step('a')], skipped: [] }, empty, [domain]));
  const events = Exit.isSuccess(exit) ? exit.value : [];
  const last = events.at(-1) as { type: string; backups?: string };
  assert.equal(last.type, 'done');
  assert.ok(last.backups?.startsWith(join(stateRoot, 'backups', 'nortuscc-')));
  assert.equal(existsSync(join(last.backups!, 'claude', 'victim.txt')), true);
});

test('run receives the step and the report the plan came from', async () => {
  const { collect } = machine();
  const report: MachineReport = { desired, items: [item('a')], probeErrors: [] };
  const seen: string[] = [];
  const domain = fake((s, r) => Effect.sync(() => { seen.push(`${s.key}:${r.items.map((o) => o.state).join()}`); return { ok: true }; }));
  await collect(execute({ kind: 'apply', steps: [step('a')], skipped: [] }, report, [domain]));
  assert.deepEqual(seen, ['a:s']);
});

test('a step failing with FsFailed finishes failed with a note naming the path', async () => {
  const { collect } = machine();
  const domain = fake(() => Effect.fail(new FsFailed({ op: 'write', path: '/x/settings.json', reason: 'EACCES' })));
  const exit = await collect(execute({ kind: 'apply', steps: [step('a')], skipped: [] }, empty, [domain]));
  const events = Exit.isSuccess(exit) ? exit.value : [];
  const finished = events.find((e) => e.type === 'finished');
  assert.equal(finished?.type === 'finished' && finished.outcome, 'failed');
  assert.ok(finished?.type === 'finished' && finished.note.includes('/x/settings.json'));
});

test('a failure with an empty message falls back to its tag', async () => {
  const { collect } = machine();
  const domain = fake(() => Effect.fail({ _tag: 'Opaque' }));
  const exit = await collect(execute({ kind: 'apply', steps: [step('a')], skipped: [] }, empty, [domain]));
  const finished = (Exit.isSuccess(exit) ? exit.value : []).find((e) => e.type === 'finished');
  assert.equal(finished?.type === 'finished' && finished.note, 'Opaque');
});

// Typecheck-level: domains needing different services mix without casts, and R is their union.
test('domains requiring different services mix in inspect, plan and execute', async () => {
  const { stateRoot } = machine();
  const files = fake((s) => Fs.use((fs) => fs.writeTextAtomic(join(stateRoot, s.key), s.key)).pipe(Effect.as({ ok: true })), [item('f')]);
  const procs = fake(
    () => Processes.use((p) => p.run({ cmd: process.execPath, args: ['-e', ''], output: 'capture' })).pipe(Effect.map((c) => ({ ok: c.code === 0 }))),
    [{ ...item('p'), domain: 'integrations' }],
    'integrations',
  );
  const domains = [files, procs] as const;
  const paths = { repo: stateRoot, claude: stateRoot, codex: stateRoot, codexOpenRouter: stateRoot, agentsSkills: stateRoot, stateRoot, backups: join(stateRoot, 'backups') };
  const layer = backupsForRun().pipe(Layer.provideMerge(Layer.mergeAll(machinePaths(paths), nodeFs, nodeProcesses())));
  const events = await Effect.runPromise(Effect.gen(function* () {
    const report = yield* inspect(desired, domains);
    const chosen = plan('apply', report, selectAll, domains);
    return [...yield* Stream.runCollect(execute(chosen, report, domains))];
  }).pipe(Effect.provide(layer)));
  assert.deepEqual(events.at(-1), { type: 'done', ok: 2, failed: 0, backups: undefined });
});

test('samePlan compares kind, steps and skipped in order', () => {
  const a: Plan = { kind: 'apply', steps: [step('a'), step('b')], skipped: [{ key: 'c', reason: 'conflict' }] };
  assert.equal(samePlan(a, { kind: 'apply', steps: [step('a'), step('b')], skipped: [{ key: 'c', reason: 'conflict' }] }), true);
  assert.equal(samePlan(a, { ...a, kind: 'capture' }), false);
  assert.equal(samePlan(a, { ...a, steps: [step('b'), step('a')] }), false);
  assert.equal(samePlan(a, { ...a, steps: [step('a'), { ...step('b'), touches: ['/x'] }] }), false);
  assert.equal(samePlan(a, { ...a, skipped: [{ key: 'c', reason: 'other' }] }), false);
  assert.equal(samePlan(a, { ...a, skipped: [] }), false);
});

test('samePlan compares step targets', () => {
  const a: Plan = { kind: 'update', steps: [{ ...step('a'), targets: ['claude'] }], skipped: [] };
  assert.equal(samePlan(a, { ...a, steps: [{ ...step('a'), targets: ['claude'] }] }), true);
  assert.equal(samePlan(a, { ...a, steps: [{ ...step('a'), targets: ['claude', 'codex'] }] }), false);
  assert.equal(samePlan(a, { ...a, steps: [step('a')] }), false);
});

test('plan hands each domain the desired config the report came from', () => {
  const report: MachineReport = { desired, items: [item('a')], probeErrors: [] };
  let seen: DesiredConfig | undefined;
  const domain: Domain = {
    ...fake(() => Effect.succeed({ ok: true })),
    steps: (_items, _selection, _kind, given) => { seen = given; return { steps: [], skipped: [] }; },
  };
  plan('apply', report, selectAll, [domain]);
  assert.equal(seen, desired);
});
