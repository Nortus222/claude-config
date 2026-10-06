import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { HistoryStore, historyStore, machinePaths, nodeFs } from '../src/index.ts';

// A temp state root; `dates` are handed out one per append, the last one repeating.
const setup = (dates: ReadonlyArray<string> = ['2026-10-06T12:00:00.000Z']) => {
  const root = mkdtempSync(join(tmpdir(), 'machine-history-'));
  const stateRoot = join(root, 'state');
  const paths = {
    repo: root, claude: root, codex: root, codexOpenRouter: root, agentsSkills: root, stateRoot, backups: join(stateRoot, 'backups'),
  };
  let next = 0;
  const now = () => new Date(dates[Math.min(next++, dates.length - 1)]!);
  const layer = historyStore(now).pipe(Layer.provide(Layer.mergeAll(machinePaths(paths), nodeFs)));
  const run = <A, E>(f: (h: HistoryStore['Service']) => Effect.Effect<A, E>) =>
    Effect.runPromise(HistoryStore.use(f).pipe(Effect.provide(layer)));
  return { dir: join(stateRoot, 'history'), run };
};

const HELD = { kind: 'held', actor: 'agent', items: [{ itemId: 'integration:hk', reason: 'integration' }] } as const;

test('a machine with no History reads as empty', async () => {
  const { run } = setup();
  assert.deepEqual(await run((h) => h.read), []);
});

test('each event is one stamped line in its month file', async () => {
  const { dir, run } = setup();
  await run((h) => h.append(HELD));
  assert.deepEqual(readdirSync(dir), ['2026-10.jsonl']);
  const text = readFileSync(join(dir, '2026-10.jsonl'), 'utf8');
  assert.ok(text.startsWith('{"v":1,"at":"2026-10-06T12:00:00.000Z","kind":"held"'));
  assert.equal(text.split('\n').length, 2);
  assert.deepEqual(await run((h) => h.read), [{
    v: 1, at: '2026-10-06T12:00:00.000Z', kind: 'held', actor: 'agent', items: [{ itemId: 'integration:hk', reason: 'integration' }],
  }]);
});

test('events roll over into the next month file and read back in order', async () => {
  const { dir, run } = setup(['2026-09-30T23:59:59.000Z', '2026-10-01T00:00:00.000Z']);
  await run((h) => h.append({ kind: 'paused', actor: 'agent', reason: 'a step failed' }));
  await run((h) => h.append({ kind: 'resumed', actor: 'cli', reason: 'person' }));
  assert.deepEqual(readdirSync(dir), ['2026-09.jsonl', '2026-10.jsonl']);
  assert.deepEqual((await run((h) => h.read)).map((e) => e.kind), ['paused', 'resumed']);
});

test('a torn last line is skipped and the next event still lands on its own line', async () => {
  const { dir, run } = setup();
  mkdirSync(dir, { recursive: true });
  const first = { v: 1, at: '2026-10-06T11:00:00.000Z', kind: 'resumed', actor: 'cli', reason: 'person' };
  writeFileSync(join(dir, '2026-10.jsonl'), `${JSON.stringify(first)}\n{"v":1,"at":"2026-10-06T11:30`);
  assert.deepEqual(await run((h) => h.read), [first]);
  await run((h) => h.append(HELD));
  assert.deepEqual((await run((h) => h.read)).map((e) => e.kind), ['resumed', 'held']);
});

test('an unreadable line in the middle is skipped, not fatal', async () => {
  const { dir, run } = setup();
  mkdirSync(dir, { recursive: true });
  const a = { v: 1, at: '2026-10-06T11:00:00.000Z', kind: 'paused', actor: 'agent', reason: 'r' };
  const b = { v: 1, at: '2026-10-06T11:10:00.000Z', kind: 'resumed', actor: 'cli', reason: 'r' };
  writeFileSync(join(dir, '2026-10.jsonl'), `${JSON.stringify(a)}\nnot json\n[1,2]\n${JSON.stringify(b)}\n`);
  assert.deepEqual((await run((h) => h.read)).map((e) => e.kind), ['paused', 'resumed']);
});

test('reading History marks an apply whose backup folder was pruned', async () => {
  const { run } = setup();
  const finished = (runId: string, backup: string) =>
    ({ kind: 'apply-finished', actor: 'agent', runId, steps: [], backup, result: 'done' } as const);
  await run((h) => h.append(finished('r1', '/b/nortuscc-1')));
  await run((h) => h.append(finished('r2', '/b/nortuscc-2')));
  await run((h) => h.append({ kind: 'backups-pruned', actor: 'agent', folders: ['/b/nortuscc-1'] }));
  const [first, second] = await run((h) => h.read);
  assert.ok(first?.kind === 'apply-finished' && second?.kind === 'apply-finished');
  assert.equal(first.backup, 'pruned');
  assert.equal(first.prunedFolder, '/b/nortuscc-1');
  assert.equal(first.prunedAt, '2026-10-06T12:00:00.000Z');
  assert.equal(second.backup, '/b/nortuscc-2');
  assert.equal(second.prunedFolder, undefined);
});
