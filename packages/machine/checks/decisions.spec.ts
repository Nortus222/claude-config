import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Exit, Layer } from 'effect';
import { DecisionsInvalid, DecisionsStore, decisionsStore, machinePaths, nodeFs, type Decision } from '../src/index.ts';

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-decisions-'));
  const stateRoot = join(root, 'state');
  const paths = {
    repo: root, claude: root, codex: root, codexOpenRouter: root, agentsSkills: root, stateRoot, backups: join(stateRoot, 'backups'),
  };
  const layer = decisionsStore.pipe(Layer.provide(Layer.mergeAll(machinePaths(paths), nodeFs)));
  const run = <A, E>(f: (d: DecisionsStore['Service']) => Effect.Effect<A, E>) =>
    Effect.runPromiseExit(DecisionsStore.use(f).pipe(Effect.provide(layer)));
  const ok = async <A, E>(f: (d: DecisionsStore['Service']) => Effect.Effect<A, E>) => {
    const exit = await run(f);
    assert.ok(Exit.isSuccess(exit), String(exit));
    return exit.value;
  };
  return { stateRoot, file: join(stateRoot, 'decisions.json'), run, ok };
};

const decision = (over: Partial<Decision> = {}): Decision => ({
  setupId: 'local', itemId: 'setting:claude:settings.json#effortLevel', revision: null, commit: 'a'.repeat(40),
  decision: 'accept', decidedAt: '2026-10-06T12:00:00.000Z', machineId: null, source: 'local', ...over,
});

test('a machine with no decisions.json has no decisions', async () => {
  const { ok } = setup();
  assert.deepEqual(await ok((d) => d.read), []);
});

test('a recorded decision round-trips through a versioned file', async () => {
  const { ok, file, stateRoot } = setup();
  assert.equal(await ok((d) => d.record(decision())), true);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 1, decisions: [decision()] });
  assert.deepEqual(await ok((d) => d.read), [decision()]);
  assert.deepEqual(readdirSync(stateRoot), ['decisions.json']);
});

test('a newer decision for the same setup and item replaces the older one; others stay', async () => {
  const { ok } = setup();
  const other = decision({ itemId: 'integration:hk' });
  await ok((d) => d.record(decision()));
  await ok((d) => d.record(other));
  const skip = decision({ decision: 'skip', decidedAt: '2026-10-06T13:00:00.000Z' });
  assert.equal(await ok((d) => d.record(skip)), true);
  assert.deepEqual(await ok((d) => d.read), [skip, other]);
});

test('an older decision does not replace a newer one', async () => {
  const { ok } = setup();
  await ok((d) => d.record(decision({ decidedAt: '2026-10-06T13:00:00.000Z' })));
  assert.equal(await ok((d) => d.record(decision({ decision: 'skip', decidedAt: '2026-10-06T12:00:00.000Z' }))), false);
  assert.equal((await ok((d) => d.read))[0]?.decision, 'accept');
});

test('an invalid file is never rewritten', async () => {
  const { run, file, stateRoot } = setup();
  mkdirSync(stateRoot, { recursive: true });
  for (const text of ['{ broken', JSON.stringify({ version: 1, decisions: [{ ...decision(), revision: 3 }] })]) {
    writeFileSync(file, text);
    const read = await run((d) => d.read);
    assert.ok(Exit.isFailure(read) && String(read.cause).includes('DecisionsInvalid'));
    const record = await run((d) => d.record(decision()));
    assert.ok(Exit.isFailure(record));
    assert.equal(readFileSync(file, 'utf8'), text);
  }
});

test('DecisionsInvalid says which file and why', () => {
  assert.equal(
    new DecisionsInvalid({ path: '/s/decisions.json', reason: 'not valid JSON' }).message,
    '/s/decisions.json is not valid (not valid JSON); fix it by hand',
  );
});

test('a malformed decision is refused before anything is written', async () => {
  const { run, file, stateRoot } = setup();
  const bad = [
    decision({ revision: 2 }),
    decision({ commit: null }),
    decision({ setupId: '' }),
    decision({ decidedAt: 'yesterday' }),
    decision({ commit: null, revision: 1.5 }),
  ];
  for (const b of bad) {
    const exit = await run((d) => d.record(b));
    assert.ok(Exit.isFailure(exit) && String(exit.cause).includes('DecisionsInvalid'));
  }
  assert.throws(() => readdirSync(stateRoot));
  mkdirSync(stateRoot, { recursive: true });
  const text = JSON.stringify({ version: 1, decisions: [decision()] });
  writeFileSync(file, text);
  assert.ok(Exit.isFailure(await run((d) => d.record(decision({ commit: null })))));
  assert.equal(readFileSync(file, 'utf8'), text);
});

test('an equal decidedAt replaces the stored decision', async () => {
  const { ok } = setup();
  await ok((d) => d.record(decision()));
  assert.equal(await ok((d) => d.record(decision({ decision: 'skip' }))), true);
  assert.deepEqual((await ok((d) => d.read)).map((d) => d.decision), ['skip']);
});

test('authoritative replacement ignores clocks and removes obsolete hosted decisions only', async () => {
  const { ok } = setup();
  await ok((d) => d.record(decision()));
  await ok((d) => d.record(decision({ setupId: 'setup1', revision: 2, commit: null })));
  const synced = decision({ setupId: 'setup1', revision: 3, commit: null, decision: 'skip',
    decidedAt: '2020-01-01T00:00:00Z', source: 'synced' });
  await ok((d) => d.replaceHosted(['setup1'], [synced]));
  assert.deepEqual(await ok((d) => d.read), [decision(), synced]);
  await ok((d) => d.replaceHosted(['setup1'], []));
  assert.deepEqual(await ok((d) => d.read), [decision()]);
});

test('concurrent record and authoritative writers preserve unrelated decisions', async () => {
  const { ok } = setup();
  await ok((d) => Effect.all(Array.from({ length: 20 }, (_, index) => index % 2 === 0
    ? d.record(decision({ itemId: `integration:${index}` }))
    : d.replaceHosted([`setup${index}`], [decision({ setupId: `setup${index}`, revision: 1, commit: null })])),
  { concurrency: 'unbounded' }));
  assert.equal((await ok((d) => d.read)).length, 20);
});
