import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Exit, Layer, Stream } from 'effect';
import type { DesiredConfig } from '@nortuscc/profile-engine';
import {
  Backups, backupsForRun, execute, inspect, machinePaths, nodeFs, plan, selectAll,
  type Domain, type MachinePaths, type MachineReport, type Observed, type Progress, type Step,
} from '../src/index.ts';

const desired: DesiredConfig = { files: [], skills: [], integrations: [], allow: {}, issues: [] };
const item = (key: string, disposition: Observed['disposition'] = 'apply'): Observed =>
  ({ key, domain: 'config', target: 'claude', label: key, group: 'g', state: 's', disposition });
const step = (key: string, interruptible = false): Step =>
  ({ key, domain: 'config', action: 'write-file', summary: key, touches: [], interruptible });

const fake = (run: Domain['run'], items: Observed[] = []): Domain => ({
  name: 'config',
  inspect: () => Effect.succeed({ items, probeErrors: ['codex unreadable'] }),
  steps: (selected) => ({
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
  const exit = await collect(execute({ kind: 'apply', steps: [step('a'), step('b'), step('c')], skipped: [] }, [domain]));
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
  const exit = await collect(execute({ kind: 'apply', steps: [step('a')], skipped: [] }, [fake(() => Effect.sync(() => { ran = true; return { ok: true }; }))]));
  assert.ok(Exit.isFailure(exit) && String(exit.cause).includes('LockHeld'));
  assert.equal(ran, false);
});

test('an already-aborted signal runs nothing and releases the lock', async () => {
  const { stateRoot, collect } = machine();
  const controller = new AbortController();
  controller.abort();
  const exit = await collect(execute({ kind: 'apply', steps: [step('a'), step('b')], skipped: [] }, [fake(() => Effect.die('must not run'))], { signal: controller.signal }));
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
  const exit = await collect(execute({ kind: 'apply', steps: [step('a'), step('b')], skipped: [] }, [domain], { signal: controller.signal }));
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
  const exit = await collect(execute({ kind: 'apply', steps: [step('proc-a', true), step('b')], skipped: [] }, [domain], { signal: controller.signal }));
  const events = Exit.isSuccess(exit) ? exit.value : [];
  assert.deepEqual(events.map((e) => e.type === 'finished' ? `${e.key}:${e.outcome}` : e.type), ['started', 'proc-a:cancelled', 'cancelled']);
  assert.equal(finalized, true);
});
