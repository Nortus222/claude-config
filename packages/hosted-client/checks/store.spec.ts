import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { machinePaths, nodeFs } from '@nortuscc/machine';
import { HostedStore, hostedStore, type HostedAccount } from '../src/index.ts';

const account = (accountId: string): HostedAccount => ({ accountId, login: 'ihor', machineId: 'machine1', auth: 'signed-in', seq: 0,
  cursors: [], setups: [], authoritative: [], outbox: [], machine: { policy: 'notify', reportStatus: true }, lastSyncAt: null, retryAt: null, error: null, pollAfter: 900 });
const revision = { setupId: 'setup1', number: 1, tag: 'r1', commitSha: 'a'.repeat(40), changelog: '', items: [], requiredEnv: [] };
const run = Effect.runPromise;

const setup = async (t: import('node:test').TestContext) => {
  const root = await mkdtemp(join(tmpdir(), 'hosted-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { repo: root, claude: root, codex: root, codexOpenRouter: root, agentsSkills: root, stateRoot: root, backups: join(root, 'backups') };
  const store = await run(HostedStore.pipe(Effect.provide(hostedStore.pipe(Layer.provide(Layer.mergeAll(machinePaths(paths), nodeFs))))));
  return { root, store };
};

test('serialized metadata writers preserve independent account additions', async (t) => {
  const { store } = await setup(t);
  await run(Effect.all(Array.from({ length: 20 }, (_, i) => store.update((d) => ({ ...d, accounts: [...d.accounts, account(`account${i}`)] }))), { concurrency: 'unbounded' }));
  assert.equal((await run(store.read)).accounts.length, 20);
});

test('cache refuses missing ranges, divergent records and unsafe identifiers without escaping its directory', async (t) => {
  const { store } = await setup(t);
  await assert.rejects(run(store.cache('account1', 'setup1', [{ ...revision, number: 2 }])), /invalid_response/);
  await run(store.cache('account1', 'setup1', [revision]));
  await assert.rejects(run(store.cache('account1', 'setup1', [{ ...revision, commitSha: 'b'.repeat(40) }])), /invalid_response/);
  await assert.rejects(run(store.cache('../escape', 'setup1', [revision])), /storage/);
  await assert.rejects(run(store.revisions('account1', '../escape')), /storage/);
  assert.deepEqual(await run(store.revisions('account1', 'setup1')), [revision]);
  assert.deepEqual(await run(store.revisions('account2', 'setup1')), []);
});

test('cache rejects corrupt, unknown-field and wrong-account documents without rewriting', async (t) => {
  const { root, store } = await setup(t);
  await run(store.cache('account1', 'setup1', [revision]));
  const file = join(root, 'agent', 'revisions', 'account1', 'setup1.json');
  for (const body of [
    { version: 1, accountId: 'account2', setupId: 'setup1', revisions: [revision] },
    { version: 1, accountId: 'account1', setupId: 'setup1', revisions: [{ ...revision, token: 'private' }] },
  ]) {
    const text = JSON.stringify(body); await writeFile(file, text);
    await assert.rejects(run(store.revisions('account1', 'setup1')), /storage/);
    await assert.rejects(run(store.cache('account1', 'setup1', [revision])), /storage/);
    assert.equal(await readFile(file, 'utf8'), text);
  }
});
