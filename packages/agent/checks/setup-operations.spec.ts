import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { DecisionsStore, HistoryStore, nodeProcesses, Processes } from '@nortuscc/machine';
import { startAgent, makeSession, type AgentSession } from '../src/index.ts';
import { decodeOperationInput } from '../src/operations/index.ts';
import { operationDigest } from '../src/runs.ts';
import { AgentStateStore } from '../src/state.ts';
import { RunStore, RunStoreError } from '../src/run-store.ts';
import { agentMachine } from './support/agent-machine.ts';
import { setupFixture, HEAD, APPLIED, EFFORT, HOOK } from './support/setup-fixture.ts';

const change = (choices: { itemId: string; action: 'accept' | 'hold' | 'release' | 'takeTheirs' }[]) => ({
  kind: 'setupApply' as const, setupId: 'local', revision: { kind: 'local' as const, commit: HEAD }, choices,
});
const finish = (s: AgentSession, planId: string) => Effect.gen(function* () {
  const run = yield* s.runs.submit({ planId, requestId: 'setup-apply', inputDigest: operationDigest(planId), actor: 'app' });
  while (!(yield* s.runs.get(run.runId)).result || (yield* s.running)) yield* Effect.yieldNow;
  return yield* s.runs.get(run.runId);
});
const withSetup = async (body: (m: ReturnType<typeof agentMachine>, setup: ReturnType<typeof setupFixture>, s: AgentSession, handle: import('../src/agent.ts').AgentHandle) => Effect.Effect<void, unknown, import('../src/layer.ts').AgentServices | import('effect').Scope.Scope | import('@nortuscc/sync').SetupSource>, headFiles?: Record<string, string>) => {
  const m = agentMachine();
  const setup = setupFixture(join(m.root, 'snapshots'), { composeStateRoot: m.paths.stateRoot, headFiles });
  await m.trust();
  try {
    await m.run(Effect.scoped(Effect.gen(function* () {
      const handle = yield* startAgent(() => m.domains, { deferStart: true });
      const s = yield* makeSession(handle, { domains: () => m.domains, signal: new AbortController().signal });
      yield* body(m, setup, s, handle);
    })), setup.source);
  } finally { rmSync(m.root, { recursive: true, force: true }); }
};
const durableFiles = (root: string) => Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
  .filter(e => e.isFile() && !e.parentPath.includes('/snapshots/'))
  .map(e => [join(e.parentPath, e.name), readFileSync(join(e.parentPath, e.name), 'utf8')]));

test('refetch reports incoming items without scheduling a job or touching machine intent', async () => {
  await withSetup((m, setup, s, handle) => Effect.gen(function* () {
    yield* (yield* AgentStateStore).update(state => ({ ...state, policy: 'auto-apply' }));
    m.write(join(m.paths.stateRoot, 'overrides.json'), '{"version":2,"manageConfig":true}\n');
    m.write(join(m.paths.stateRoot, 'sync.json'), '{"version":1,"held":{}}\n');
    yield* (yield* HistoryStore).append({ kind: 'apply-started', actor: 'agent', runId: 'interrupted-automatic', automatic: true, keys: ['config:claude:settings.json#effortLevel'] });
    const before = durableFiles(m.paths.stateRoot), generation = yield* handle.generation!;
    const review = yield* s.setupReview(decodeOperationInput('setupReview', { setupId: 'local', refetch: true, limit: 20 }));
    assert.equal(review.generation, generation);
    assert.ok(review.rows.some(row => row.itemId === EFFORT && row.after === '"high"'));
    assert.ok(setup.calls.includes('fetch'));
    assert.equal(yield* handle.generation!, generation);
    assert.equal(yield* handle.status, undefined);
    assert.deepEqual(durableFiles(m.paths.stateRoot), before);
  }));
});

test('setup apply persists every choice and applies them in one run', async () => {
  await withSetup((m, _setup, s) => Effect.gen(function* () {
    const preview = yield* s.previewChange(change([{ itemId: EFFORT, action: 'accept' }, { itemId: HOOK, action: 'hold' }]));
    const run = yield* finish(s, preview.planId);
    assert.equal(run.state, 'succeeded');
    assert.equal((yield* s.runs.list({ limit: 10 })).runs.length, 1);
    const decisions = yield* (yield* DecisionsStore).read;
    assert.equal(decisions.find(d => d.itemId === EFFORT)?.decision, 'accept');
    assert.equal(decisions.find(d => d.itemId === HOOK)?.decision, 'skip');
    assert.equal(JSON.parse(m.read(join(m.paths.stateRoot, 'sync.json'))!).held[HOOK], APPLIED);
    const settings = JSON.parse(m.read(join(m.paths.claude, 'settings.json'))!);
    assert.equal(settings.effortLevel, 'high');
    assert.equal(settings.hooks, undefined);
    assert.ok(run.parity?.committedKeys.includes('sync:decision'));
    assert.equal(run.parity?.remainingKeys.length, 0);
  }));
});

test("take setup value resets only that item's override after a backup", async () => {
  await withSetup((m, _setup, s) => Effect.gen(function* () {
    const original = '{"version":2,"settings":{"claude:settings.json":{"effortLevel":"low","theme":"light"}}}\n';
    m.write(join(m.paths.stateRoot, 'overrides.json'), original);
    const preview = yield* s.previewChange(change([{ itemId: EFFORT, action: 'takeTheirs' }, { itemId: HOOK, action: 'hold' }]));
    const run = yield* finish(s, preview.planId);
    assert.equal(run.state, 'succeeded');
    assert.deepEqual(JSON.parse(m.read(join(m.paths.stateRoot, 'overrides.json'))!).settings, { 'claude:settings.json': { theme: 'light' } });
    const saved = readdirSync(m.paths.backups, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => readFileSync(join(e.parentPath, e.name), 'utf8'));
    assert.ok(saved.includes(original));
    assert.equal(JSON.parse(m.read(join(m.paths.claude, 'settings.json'))!).effortLevel, 'high');
  }));
});

test('mixed actions inside one pin group are refused before any write', async () => {
  const source = 'owner/repo';
  await withSetup((m, _setup, s) => Effect.gen(function* () {
    const before = durableFiles(m.paths.stateRoot);
    const error = yield* Effect.flip(s.previewChange(change([
      { itemId: `skill:${source}/one`, action: 'accept' }, { itemId: `skill:${source}/two`, action: 'hold' },
    ])));
    assert.equal(error.message, `Choices for ${source} must match: its items share one pin.`);
    assert.deepEqual(durableFiles(m.paths.stateRoot), before);
  }), { 'skills-manifest.txt': `[${source}]\none\ntwo\n`, 'skill-pins.json': JSON.stringify({ version: 1, pins: { [source]: '1'.repeat(40) } }) });
});

test('a stale review revision returns a fresh preview instead of applying', async () => {
  await withSetup((m, _setup, s) => Effect.gen(function* () {
    const preview = yield* s.previewChange(change([{ itemId: EFFORT, action: 'accept' }, { itemId: HOOK, action: 'hold' }]));
    m.write(join(m.paths.stateRoot, 'overrides.json'), '{"version":2,"manageConfig":false}');
    const result = yield* Effect.flip(s.runs.submit({ planId: preview.planId, requestId: 'stale', inputDigest: operationDigest(preview.planId), actor: 'app' }));
    assert.equal(result.code, 'STALE_PLAN');
    assert.ok(result.preview);
    assert.notEqual(result.preview!.planId, preview.planId);
    assert.equal((yield* s.runs.list({ limit: 10 })).runs.length, 0);
    assert.equal(m.read(join(m.paths.claude, 'settings.json')), undefined);
  }));
});

test('setup review caps UTF-8 text and marks truncated rows while retaining machine values', async () => {
  await withSetup((m, _setup, s) => Effect.gen(function* () {
    m.write(join(m.paths.stateRoot, 'overrides.json'), '{"version":2,"settings":{"claude:settings.json":{"effortLevel":"low"}}}');
    const review = yield* s.setupReview(decodeOperationInput('setupReview', { setupId: 'local', refetch: false, limit: 100 }));
    const file = review.rows.find(row => row.itemId === 'file:claude:CLAUDE.md')!;
    assert.equal(file.truncated, true);
    assert.equal(Buffer.byteLength(file.after!), 65_536);
    assert.equal(file.after!.includes('\ufffd'), false);
    assert.equal(review.rows.find(row => row.itemId === EFFORT)?.mine, '"low"');
  }), { 'claude/CLAUDE.md': '😀'.repeat(20_000) });
});

test('setup review pages are bound to the exact holds and overrides', async () => {
  await withSetup((m, _setup, s) => Effect.gen(function* () {
    const first = yield* s.setupReview(decodeOperationInput('setupReview', { setupId: 'local', refetch: true, limit: 1 }));
    assert.ok(first.nextCursor);
    const next = yield* s.setupReview(decodeOperationInput('setupReview', { setupId: 'local', refetch: false, limit: 1, cursor: first.nextCursor! }));
    assert.notEqual(first.rows[0]?.itemId, next.rows[0]?.itemId);
    m.write(join(m.paths.stateRoot, 'sync.json'), JSON.stringify({ version: 1, held: { [EFFORT]: APPLIED } }));
    const error = yield* Effect.flip(s.setupReview(decodeOperationInput('setupReview', { setupId: 'local', refetch: false, limit: 1, cursor: first.nextCursor! })));
    assert.equal(error.code, 'UNKNOWN_PLAN');
  }));
});

test('setup review includes held items even when both revisions omit the item', async () => {
  await withSetup((m, _setup, s) => Effect.gen(function* () {
    const absent = 'setting:claude:settings.json#removed';
    m.write(join(m.paths.stateRoot, 'sync.json'), JSON.stringify({ version: 1, held: { [absent]: APPLIED } }));
    const review = yield* s.setupReview(decodeOperationInput('setupReview', { setupId: 'local', refetch: true, limit: 100 }));
    assert.ok(review.rows.some(row => row.itemId === absent && row.held));
    assert.equal(review.rows.find(row => row.itemId === absent)?.change, 'unchanged');
    const preview = yield* s.previewChange(change([{ itemId: absent, action: 'release' }]));
    assert.equal((yield* finish(s, preview.planId)).state, 'succeeded');
    assert.deepEqual(JSON.parse(m.read(join(m.paths.stateRoot, 'sync.json'))!).held, { [EFFORT]: APPLIED, [HOOK]: APPLIED });
  }));
});

test('accepting an incoming item preserves its machine override', async () => {
  await withSetup((m, _setup, s) => Effect.gen(function* () {
    const original = '{"version":2,"settings":{"claude:settings.json":{"effortLevel":"low"}}}\n';
    m.write(join(m.paths.stateRoot, 'overrides.json'), original);
    const preview = yield* s.previewChange(change([{ itemId: EFFORT, action: 'accept' }]));
    assert.equal((yield* finish(s, preview.planId)).state, 'succeeded');
    assert.equal(m.read(join(m.paths.stateRoot, 'overrides.json')), original);
    assert.equal(JSON.parse(m.read(join(m.paths.claude, 'settings.json'))!).effortLevel, 'low');
  }));
});

import { setupSourceLayer, normalizeRepoUrl, hostedSetupSourceLayer, SetupSource, commitDocuments, diffItems, itemValues } from '@nortuscc/sync';
import { tempSetup, json } from '../../sync/checks/support/repo.ts';
test('after setup apply, accepted rows leave the review and unchosen rows show as held', async () => {
  const repo = tempSetup(), m = agentMachine();
  Object.assign(m.paths, { repo: repo.checkout });
  const head = repo.push({ 'claude/settings.keys.json': json({ theme: 'auto', effortLevel: 'medium' }),
    'integrations.json': json({ version: 1, integrations: [{ id: 'hk', label: 'hook', type: 'hook', target: 'claude', default: true, event: 'SessionStart', file: 'hooks/session.mjs' }] }), 'hooks/session.mjs': 'new hook\n' });
  m.write(join(m.paths.stateRoot, 'agent/setups.json'), json({ version: 1, setups: [{ setupId: null, repoUrl: normalizeRepoUrl(repo.origin), checkout: repo.checkout, trustedAt: '2026-10-15T00:00:00Z' }] }));
  m.write(join(m.paths.stateRoot, 'state.json'), json({ version: 1, files: {}, applied: { commit: repo.first, at: '2026-10-15T00:00:00Z' } }));
  try {
    await m.run(Effect.scoped(Effect.gen(function* () {
      const handle = yield* startAgent(() => m.domains, { deferStart: true });
      const session = yield* makeSession(handle, { domains: () => m.domains, signal: new AbortController().signal });
      const preview = yield* session.previewChange({ ...change([{ itemId: EFFORT, action: 'accept' }]), revision: { kind: 'local', commit: head } });
      const run = yield* finish(session, preview.planId);
      assert.equal(run.state, 'succeeded');
      assert.equal(JSON.parse(m.read(join(m.paths.claude, 'settings.json'))!).effortLevel, 'medium');
      assert.equal(JSON.parse(m.read(join(m.paths.stateRoot, 'sync.json')) ?? '{}').held?.[HOOK], repo.first);
      assert.equal(JSON.parse(m.read(join(m.paths.stateRoot, 'state.json'))!).applied.commit, head);
      const review = yield* session.setupReview(decodeOperationInput('setupReview', { setupId: 'local', refetch: false, limit: 100 }));
      assert.equal(review.rows.some(row => row.itemId === EFFORT), false);
      assert.equal(review.rows.find(row => row.itemId === HOOK)?.held, true);
      assert.ok(run.parity?.committedKeys.includes('sync:applied'));
      assert.equal(run.steps.at(-1)?.key, 'sync:applied');
      const saved = readdirSync(m.paths.backups, { recursive: true, withFileTypes: true }).filter(e => e.isFile() && e.name === 'state.json');
      assert.ok(saved.some(e => JSON.parse(readFileSync(join(e.parentPath, e.name), 'utf8')).applied.commit === repo.first));
    })), setupSourceLayer(m.paths));
  } finally { rmSync(m.root, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true }); }
});

test('an interruption before settlement leaves the applied baseline unchanged and the run interrupted', async () => {
  await withSetup((m, _setup, _s, handle) => Effect.gen(function* () {
    m.write(join(m.paths.stateRoot, 'state.json'), json({ version: 1, files: {}, applied: { commit: APPLIED, at: '2026-10-15T00:00:00Z' } }));
    const store = yield* RunStore;
    let interrupted = false;
    const session = yield* makeSession(handle, { domains: () => m.domains, signal: new AbortController().signal }).pipe(Effect.provideService(RunStore, {
      ...store, write: receipt => {
        if (!interrupted && receipt.inFlight === 'sync:applied') {
          interrupted = true;
          return Effect.fail(new RunStoreError('process lost before baseline settlement'));
        }
        return store.write(receipt);
      },
    }));
    const preview = yield* session.previewChange(change([{ itemId: EFFORT, action: 'accept' }]));
    const run = yield* finish(session, preview.planId);
    assert.equal(run.state, 'interrupted');
    assert.equal(JSON.parse(m.read(join(m.paths.stateRoot, 'state.json'))!).applied.commit, APPLIED);
    assert.equal(JSON.parse(m.read(join(m.paths.claude, 'settings.json'))!).effortLevel, 'high');
    assert.ok(run.parity?.remainingKeys.includes('sync:applied'));
    assert.ok(run.parity?.committedKeys.includes('sync:hold'));
  }));
});

test('hosted setup apply records freshly observed settings and retains unchosen item origins', async () => {
  const repo = tempSetup(), m = agentMachine();
  const url = 'https://github.com/example/setup.git';
  Object.assign(m.paths, { repo: repo.checkout });
  repo.inCheckout('remote', 'set-url', 'origin', url);
  const head = repo.push({ 'claude/settings.keys.json': json({ theme: 'light', effortLevel: 'medium' }) });
  repo.inCheckout('fetch', repo.origin, 'main');
  repo.inCheckout('tag', 'v1', repo.first);
  repo.inCheckout('tag', 'v2', head);
  repo.inCheckout('push', repo.origin, 'refs/tags/v1', 'refs/tags/v2');
  m.write(join(m.paths.stateRoot, 'agent/setups.json'), json({ version: 1, setups: [{ setupId: 'setup-1', repoUrl: normalizeRepoUrl(url), accountId: 'account-1', checkout: repo.checkout, trustedAt: '2026-10-15T00:00:00Z' }] }));
  const state = json({ version: 1, files: {}, applied: { commit: repo.first, at: '2026-10-15T00:00:00Z' } });
  m.write(join(m.paths.stateRoot, 'state.json'), state);
  const processes = Layer.effect(Processes, Effect.gen(function* () {
    const real = yield* Processes;
    return { run: (command: Parameters<typeof real.run>[0]) => real.run({ ...command, args: command.args.map(arg => arg === url ? repo.origin : arg) }) };
  })).pipe(Layer.provide(nodeProcesses()));
  try {
    await m.run(Effect.scoped(Effect.gen(function* () {
      const before = yield* commitDocuments(repo.checkout, repo.first), after = yield* commitDocuments(repo.checkout, head);
      const record = (number: number, commitSha: string, old: typeof before, next: typeof before) => ({ setupId: 'setup-1', number, commitSha, tag: `v${number}`, changelog: '', requiredEnv: [],
        items: diffItems(itemValues(old), itemValues(next)).map(c => ({ id: c.itemId, kind: c.kind, change: c.before === undefined ? 'added' as const : c.after === undefined ? 'removed' as const : 'changed' as const })) });
      const source = yield* SetupSource.pipe(Effect.provide(hostedSetupSourceLayer(m.paths, { setupId: 'setup-1', accountId: 'account-1', currentAccountId: Effect.succeed('account-1'), repoUrl: url,
        records: Effect.succeed([record(1, repo.first, {}, before), record(2, head, before, after)]), processes })));
      const baseline = yield* source.baseline!;
      const handle = yield* startAgent(() => m.domains, { deferStart: true });
      const decisions = yield* DecisionsStore;
      const session = yield* makeSession({ ...handle,
        selectOperationSetup: () => Effect.succeed({ setupId: 'setup-1', trusted: true, accountId: 'account-1', repository: normalizeRepoUrl(url), source }),
        mutationBodies: { ...handle.mutationBodies, decideAll: rows => Effect.forEach(rows, row => decisions.record(row), { discard: true }) },
      }, { domains: () => m.domains, signal: new AbortController().signal });
      const preview = yield* session.previewChange({ ...change([{ itemId: EFFORT, action: 'accept' }]), setupId: 'setup-1', revision: { kind: 'hosted', number: 2, commitSha: head } });
      const run = yield* finish(session, preview.planId);
      assert.equal(run.state, 'succeeded');
      const settled = yield* source.baseline!;
      assert.equal(settled.origins[EFFORT], head);
      assert.equal(settled.origins['setting:claude:settings.json#theme'], baseline.origins['setting:claude:settings.json#theme']);
      const review = yield* session.setupReview(decodeOperationInput('setupReview', { setupId: 'setup-1', refetch: false, limit: 100 }));
      assert.equal(review.rows.some(row => row.itemId === EFFORT), false);
      assert.equal(review.rows.find(row => row.itemId === 'setting:claude:settings.json#theme')?.held, true);
      assert.equal(m.read(join(m.paths.stateRoot, 'sync.json')), undefined);
      assert.ok(run.parity?.committedKeys.includes('sync:applied'));
      assert.equal(JSON.parse(m.read(join(m.paths.stateRoot, 'state.json'))!).applied.commit, repo.first);
      const saved = readdirSync(m.paths.backups, { recursive: true, withFileTypes: true }).filter(e => e.isFile() && e.name === 'setup-1.json');
      assert.ok(saved.some(e => JSON.stringify(JSON.parse(readFileSync(join(e.parentPath, e.name), 'utf8'))) === JSON.stringify(baseline)));
    })));
  } finally { rmSync(m.root, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true }); }
});

test('a source revision changed after preview returns a replacement bound to the fresh revision', async () => {
  await withSetup((m, setup, _s, handle) => Effect.gen(function* () {
    const next = 'c'.repeat(40);
    let head = HEAD;
    const source = { ...setup.service, fetch: Effect.sync(() => ({ head })),
      effective: (decisions: readonly import('@nortuscc/machine').Decision[], choices?: Parameters<typeof setup.service.effective>[1]) => setup.service.effective(decisions.map(d => ({ ...d, commit: d.commit === next ? HEAD : d.commit })), choices),
      load: (revision: import('@nortuscc/sync').Revision) => setup.service.load(revision === next ? HEAD : revision) };
    const session = yield* makeSession({ ...handle, selectOperationSetup: () => Effect.succeed({ setupId: 'local', trusted: true, accountId: null, repository: null, source }) }, { domains: () => m.domains, signal: new AbortController().signal });
    const preview = yield* session.previewChange(change([{ itemId: EFFORT, action: 'accept' }, { itemId: HOOK, action: 'hold' }]));
    head = next;
    const result = yield* Effect.flip(session.runs.submit({ planId: preview.planId, requestId: 'stale-revision', inputDigest: operationDigest(preview.planId), actor: 'app' }));
    assert.equal(result.code, 'STALE_PLAN');
    assert.equal(result.preview?.change.kind, 'setupApply');
    if (result.preview?.change.kind === 'setupApply') assert.deepEqual(result.preview.change.revision, { kind: 'local', commit: next });
    assert.equal((yield* session.runs.list({ limit: 10 })).runs.length, 0);
    assert.equal(m.read(join(m.paths.stateRoot, 'decisions.json')), undefined);
  }));
});

test('an unchanged incoming item can resolve its override independently of accepting a source change', async () => {
  await withSetup((m, _setup, s) => Effect.gen(function* () {
    const theme = 'setting:claude:settings.json#theme';
    m.write(join(m.paths.stateRoot, 'overrides.json'), '{"version":2,"settings":{"claude:settings.json":{"theme":"light"}}}');
    const review = yield* s.setupReview(decodeOperationInput('setupReview', { setupId: 'local', refetch: false, limit: 100 }));
    assert.ok(review.rows.some(row => row.itemId === theme && row.conflict));
    assert.equal(review.rows.find(row => row.itemId === theme)?.change, 'unchanged');
    const preview = yield* s.previewChange(change([{ itemId: theme, action: 'takeTheirs' }]));
    assert.equal((yield* finish(s, preview.planId)).state, 'succeeded');
    assert.equal(JSON.parse(m.read(join(m.paths.claude, 'settings.json'))!).theme, 'dark');
  }));
});

test('applying without naming an override-only item creates no hold or decision for it', async () => {
  await withSetup((m, _setup, s) => Effect.gen(function* () {
    const theme = 'setting:claude:settings.json#theme';
    const overrides = '{"version":2,"settings":{"claude:settings.json":{"theme":"light"}}}';
    m.write(join(m.paths.stateRoot, 'overrides.json'), overrides);
    const preview = yield* s.previewChange(change([{ itemId: EFFORT, action: 'accept' }]));
    assert.equal((yield* finish(s, preview.planId)).state, 'succeeded');
    const holds = JSON.parse(m.read(join(m.paths.stateRoot, 'sync.json'))!).held;
    assert.equal(Object.hasOwn(holds, theme), false);
    assert.equal(holds[HOOK], APPLIED);
    const decisions = yield* (yield* DecisionsStore).read;
    assert.equal(decisions.some(d => d.itemId === theme), false);
    assert.equal(decisions.find(d => d.itemId === EFFORT)?.decision, 'accept');
    assert.equal(m.read(join(m.paths.stateRoot, 'overrides.json')), overrides);
    assert.equal(JSON.parse(m.read(join(m.paths.stateRoot, 'state.json'))!).applied.commit, HEAD);
  }));
});

test('review without refetch reuses the inspected source revision and schedules no job', async () => {
  await withSetup((_m, setup, s) => Effect.gen(function* () {
    yield* s.inspect('app');
    setup.calls.length = 0;
    const review = yield* s.setupReview(decodeOperationInput('setupReview', { setupId: 'local', refetch: false, limit: 100 }));
    assert.deepEqual(review.revision, { kind: 'local', commit: HEAD });
    assert.equal(setup.calls.includes('fetch'), false);
    yield* s.setupReview(decodeOperationInput('setupReview', { setupId: 'local', refetch: true, limit: 100 }));
    assert.equal(setup.calls.includes('fetch'), true);
  }));
});

test('hosted batches queue each exact item revision locally without creating local holds', async () => {
  await withSetup((m, setup, _s, handle) => Effect.gen(function* () {
    const record = (number: number, itemId: string) => ({ setupId: 'hosted-setup', number, commitSha: HEAD, tag: `v${number}`, changelog: '', requiredEnv: [], items: [{ id: itemId, kind: itemId === EFFORT ? 'setting' as const : 'integration' as const, change: 'added' as const }] });
    const settingRevision = record(2, EFFORT), hookRevision = record(4, HOOK);
    const source = { ...setup.service, setupId: 'hosted-setup', trusted: Effect.succeed(true),
      fetch: Effect.succeed({ head: hookRevision }),
      offeredItems: Effect.succeed([{ itemId: EFFORT, revision: settingRevision }, { itemId: HOOK, revision: hookRevision }]),
      effective: (decisions: readonly import('@nortuscc/machine').Decision[], choices?: Parameters<typeof setup.service.effective>[1]) => setup.service.effective(decisions.map(d => ({ ...d, setupId: 'local', commit: HEAD, revision: null })), choices),
    };
    const queued: import('@nortuscc/machine').Decision[] = [];
    const store = yield* DecisionsStore;
    const session = yield* makeSession({ ...handle,
      selectOperationSetup: () => Effect.succeed({ setupId: 'hosted-setup', trusted: true, accountId: 'account-1', repository: null, source }),
      mutationBodies: { ...handle.mutationBodies, decideAll: (decisions, actor) => Effect.gen(function* () {
        assert.equal(actor, 'app');
        for (const decision of decisions) { queued.push(decision); yield* store.record(decision); }
      }) },
    }, { domains: () => m.domains, signal: new AbortController().signal });
    const preview = yield* session.previewChange({ ...change([{ itemId: EFFORT, action: 'accept' }, { itemId: HOOK, action: 'hold' }]), setupId: 'hosted-setup', revision: { kind: 'hosted', number: 4, commitSha: HEAD } });
    const run = yield* finish(session, preview.planId);
    assert.equal(run.state, 'succeeded');
    assert.deepEqual(queued.map(d => [d.itemId, d.revision, d.commit, d.decision]), [[EFFORT, 2, null, 'accept'], [HOOK, 4, null, 'skip']]);
    assert.equal(m.read(join(m.paths.stateRoot, 'sync.json')), undefined);
    assert.equal((yield* session.runs.list({ limit: 10 })).runs.length, 1);
    assert.equal(run.parity?.committedKeys.includes('sync:applied'), false);
    assert.equal(JSON.parse(m.read(join(m.paths.stateRoot, 'state.json')) ?? '{}').applied, undefined);
    assert.ok('actionEffects' in preview && preview.actionEffects?.some(effect => effect.includes('baseline stays unchanged')));
  }));
});

test('hook body-only changes appear in review with both executable bodies', async () => {
  const m = agentMachine();
  const { HEAD_FILES } = await import('./support/setup-fixture.ts');
  const setup = setupFixture(join(m.root, 'snapshots'), { composeStateRoot: m.paths.stateRoot,
    appliedFiles: { ...HEAD_FILES, 'claude/hooks/session.mjs': 'old hook\n' },
    headFiles: { 'claude/hooks/session.mjs': 'new hook\n' } });
  await m.trust();
  try {
    await m.run(Effect.scoped(Effect.gen(function* () {
      const handle = yield* startAgent(() => m.domains, { deferStart: true });
      const session = yield* makeSession(handle, { domains: () => m.domains, signal: new AbortController().signal });
      const review = yield* session.setupReview(decodeOperationInput('setupReview', { setupId: 'local', refetch: true, limit: 100 }));
      const row = review.rows.find(row => row.itemId === HOOK);
      assert.equal(row?.change, 'changed');
      assert.match(row!.before!, /old hook/);
      assert.match(row!.after!, /new hook/);
    })), setup.source);
  } finally { rmSync(m.root, { recursive: true, force: true }); }
});

test('an omitted hook keeps its held body while an independent item settles', async () => {
  const m = agentMachine();
  const { HEAD_FILES } = await import('./support/setup-fixture.ts');
  const setup = setupFixture(join(m.root, 'snapshots'), { composeStateRoot: m.paths.stateRoot,
    appliedFiles: { ...HEAD_FILES, 'claude/hooks/session.mjs': 'old hook\n' },
    headFiles: { 'claude/hooks/session.mjs': 'new hook\n' } });
  await m.trust();
  try {
    await m.run(Effect.scoped(Effect.gen(function* () {
      const handle = yield* startAgent(() => m.domains, { deferStart: true });
      const session = yield* makeSession(handle, { domains: () => m.domains, signal: new AbortController().signal });
      const before = durableFiles(m.paths.stateRoot);
      const preview = yield* session.previewChange(change([{ itemId: EFFORT, action: 'accept' }]));
      assert.deepEqual(durableFiles(m.paths.stateRoot), before);
      assert.equal((yield* finish(session, preview.planId)).state, 'succeeded');
      assert.equal(JSON.parse(m.read(join(m.paths.stateRoot, 'sync.json'))!).held[HOOK], APPLIED);
      assert.equal(JSON.parse(m.read(join(m.paths.stateRoot, 'state.json'))!).applied.commit, HEAD);
      assert.equal(readFileSync(join(m.root, 'snapshots/composed/claude/hooks/session.mjs'), 'utf8'), 'old hook\n');
    })), setup.source);
  } finally { rmSync(m.root, { recursive: true, force: true }); }
});

test('unchosen source pin groups are held together while an independent setting is accepted', async () => {
  await withSetup((m, _setup, s) => Effect.gen(function* () {
    const preview = yield* s.previewChange(change([{ itemId: EFFORT, action: 'accept' }]));
    assert.equal((yield* finish(s, preview.planId)).state, 'succeeded');
    const holds = JSON.parse(m.read(join(m.paths.stateRoot, 'sync.json'))!).held;
    assert.equal(holds['skill:owner/repo/one'], APPLIED);
    assert.equal(holds['skill:owner/repo/two'], APPLIED);
    assert.equal(JSON.parse(m.read(join(m.paths.stateRoot, 'state.json'))!).applied.commit, HEAD);
  }), { 'skills-manifest.txt': '[owner/repo]\none\ntwo\n', 'skill-pins.json': json({ version: 1, pins: { 'owner/repo': '1'.repeat(40) } }) });
});

test('large setup reviews paginate within the IPC record limit without dropping rows', async () => {
  const settings = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`custom${i}`, 'x'.repeat(70_000)]));
  await withSetup((_m, _setup, s) => Effect.gen(function* () {
    const first = yield* s.setupReview(decodeOperationInput('setupReview', { setupId: 'local', refetch: true, limit: 100 }));
    assert.ok(Buffer.byteLength(JSON.stringify(first)) < 1_048_576);
    assert.ok(first.nextCursor);
    const second = yield* s.setupReview(decodeOperationInput('setupReview', { setupId: 'local', refetch: false, limit: 100, cursor: first.nextCursor! }));
    const ids = [...first.rows, ...second.rows].filter(row => row.itemId.startsWith('setting:claude:settings.json#custom')).map(row => row.itemId);
    assert.equal(new Set(ids).size, 20);
    assert.equal(second.nextCursor, null);
  }), { 'claude/settings.keys.json': JSON.stringify(settings) });
});

test('setup review refuses an inspection replaced while the source is being read', async () => {
  await withSetup((m, _setup, _s, handle) => Effect.gen(function* () {
    yield* handle.request('inspect');
    let inspection = yield* handle.inspection;
    const wrapped = { ...handle, inspection: Effect.sync(() => inspection),
      selectOperationSetup: (id: string) => handle.selectOperationSetup!(id).pipe(Effect.tap(() => Effect.sync(() => { inspection = { ...inspection! }; }))) };
    const session = yield* makeSession(wrapped, { domains: () => m.domains, signal: new AbortController().signal });
    const error = yield* Effect.flip(session.setupReview(decodeOperationInput('setupReview', { setupId: 'local', refetch: true, limit: 100 })));
    assert.equal(error.code, 'UNKNOWN_PLAN');
  }));
});

test('setup review output rejects text exceeding the UTF-8 byte cap', async () => {
  const { decodeOperationOutput } = await import('../src/operations/index.ts');
  assert.throws(() => decodeOperationOutput('setupReview', { generation: 1, setupId: 'local', revision: { kind: 'local', commit: HEAD }, rows: [{ itemId: EFFORT, kind: 'setting', change: 'changed', held: false, conflict: false, after: '😀'.repeat(20_000) }], pinGroups: [], nextCursor: null }));
});

test('review without refetch keeps the latest refetched revision instead of an older machine inspection', async () => {
  await withSetup((m, setup, _s, handle) => Effect.gen(function* () {
    yield* handle.request('inspect');
    const next = 'c'.repeat(40);
    const source = { ...setup.service, fetch: Effect.succeed({ head: next }),
      load: (revision: import('@nortuscc/sync').Revision) => setup.service.load(revision === next ? HEAD : revision) };
    const session = yield* makeSession({ ...handle, selectOperationSetup: () => Effect.succeed({ setupId: 'local', trusted: true, accountId: null, repository: null, source }) }, { domains: () => m.domains, signal: new AbortController().signal });
    const fresh = yield* session.setupReview(decodeOperationInput('setupReview', { setupId: 'local', refetch: true, limit: 100 }));
    const read = yield* session.setupReview(decodeOperationInput('setupReview', { setupId: 'local', refetch: false, limit: 100 }));
    assert.deepEqual(read.revision, fresh.revision);
    assert.deepEqual(read.revision, { kind: 'local', commit: next });
  }));
});

test('setup review shows a profile file exclusion instead of unchanged file text', async () => {
  const m = agentMachine();
  const { SetupSource } = await import('@nortuscc/sync');
  const files = { 'profiles/child.json': '{}', 'claude/CLAUDE.md': '# same rules\n' };
  const setup = setupFixture(join(m.root, 'snapshots'), { appliedFiles: files, headFiles: { ...files, 'profiles/child.json': json({ files: { 'claude:CLAUDE.md': null } }) } });
  await m.trust();
  try {
    await m.run(Effect.scoped(Effect.gen(function* () {
      const handle = yield* startAgent(() => m.domains, { deferStart: true });
      const session = yield* makeSession(handle, { domains: () => m.domains, signal: new AbortController().signal });
      const review = yield* session.setupReview(decodeOperationInput('setupReview', { setupId: 'local', refetch: true, limit: 100 }));
      const row = review.rows.find(row => row.itemId === 'file:claude:CLAUDE.md')!;
      assert.equal(row.before, '# same rules\n');
      assert.deepEqual(JSON.parse(row.after!), { managed: false });
    })), Layer.succeed(SetupSource, { ...setup.service, profile: 'child' }));
  } finally { rmSync(m.root, { recursive: true, force: true }); }
});
