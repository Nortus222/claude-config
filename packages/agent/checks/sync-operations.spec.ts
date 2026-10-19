import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeOperationInput, operationDefinitions } from '../src/operations/index.ts';
test('sync has dedicated bounded reads and exact typed local versus hosted identities', () => {
  for (const name of ['inspectSetups', 'incomingChanges', 'prepareTrustRequest'])
    assert.ok(name in operationDefinitions, name);
  const change = {
    kind: 'syncDecision',
    setupId: 'local',
    revision: { kind: 'local', commit: 'a'.repeat(40) },
    itemId: 'file:claude:CLAUDE.md',
    action: 'accept',
  };
  assert.deepEqual(decodeOperationInput('previewChange', { change }).change, change);
  assert.throws(() =>
    decodeOperationInput('previewChange', { change: { ...change, revision: { kind: 'local', commit: 'abcdef' } } }),
  );
  assert.throws(() =>
    decodeOperationInput('previewChange', { change: { ...change, revision: { kind: 'hosted', number: 1 } } }),
  );
});

import { Effect } from 'effect';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { acquireApplyLock, DecisionsStore, OverridesStore, skillsDomain } from '@nortuscc/machine';
import { startAgent, makeSession, type AgentSession } from '../src/index.ts';
import { operationDigest } from '../src/runs.ts';
import { agentMachine } from './support/agent-machine.ts';
import { setupFixture, HEAD, APPLIED, EFFORT } from './support/setup-fixture.ts';
const submit = (session: AgentSession, planId: string, requestId = 'sync') =>
  Effect.gen(function* () {
    const request = { planId, requestId, inputDigest: operationDigest(planId), actor: 'mcp' as const };
    const accepted = yield* session.runs.submit(request);
    yield* Effect.callback<void>((resume) => {
      const off = session.runs.subscribe(accepted.runId, (run) => {
        if (run.result) resume(Effect.void);
      });
      return Effect.sync(off);
    });
    while (yield* session.running) yield* Effect.yieldNow;
    return { run: yield* session.runs.get(accepted.runId), request };
  });
const change = (action: 'accept' | 'hold' | 'release' | 'takeTheirs' = 'accept') => ({
  kind: 'syncDecision' as const,
  setupId: 'local',
  revision: { kind: 'local' as const, commit: HEAD },
  itemId: EFFORT,
  action,
});
test('actual session reads known trusted setups, bounded offers, stale cursors and read-only unknown trust', async () => {
  const m = agentMachine(),
    setup = setupFixture(join(m.root, 'snapshots'));
  try {
    await m.run(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* startAgent(() => m.domains, { deferStart: true });
          const s = yield* makeSession(handle, { domains: () => m.domains, signal: new AbortController().signal });
          const before = m.read(join(m.paths.stateRoot, 'agent/setups.json'));
          const trust = yield* s.prepareTrustRequest(decodeOperationInput('prepareTrustRequest', { setupId: 'local' }));
          assert.equal(trust.trusted, false);
          assert.equal(trust.action, 'open-app-repository-trust');
          assert.equal(m.read(join(m.paths.stateRoot, 'agent/setups.json')), before);
          assert.equal(
            (yield* Effect.flip(s.incomingChanges(decodeOperationInput('incomingChanges', { setupId: 'local' })))).code,
            'APP_UNAVAILABLE',
          );
        }),
      ),
      setup.source,
    );
    await m.trust();
    await m.run(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* startAgent(() => m.domains, { deferStart: true });
          const s = yield* makeSession(handle, { domains: () => m.domains, signal: new AbortController().signal });
          yield* s.inspect('mcp');
          const setups = yield* s.inspectSetups(decodeOperationInput('inspectSetups', {}));
          assert.equal(setups.items[0]?.trusted, true);
          const first = yield* s.incomingChanges(
            decodeOperationInput('incomingChanges', { setupId: 'local', limit: 1 }),
          );
          assert.ok(first.nextCursor);
          assert.deepEqual(first.revision, { kind: 'local', commit: HEAD });
          assert.doesNotMatch(JSON.stringify(first), /console.log|SessionStart|session.mjs/);
          m.write(join(m.paths.stateRoot, 'sync.json'), JSON.stringify({ version: 1, held: { [EFFORT]: APPLIED } }));
          assert.equal(
            (yield* Effect.flip(
              s.incomingChanges(
                decodeOperationInput('incomingChanges', { setupId: 'local', limit: 1, cursor: first.nextCursor! }),
              ),
            )).code,
            'UNKNOWN_PLAN',
          );
          yield* Effect.flip(s.incomingChanges(decodeOperationInput('incomingChanges', { setupId: '../../private' })));
        }),
      ),
      setup.source,
    );
  } finally {
    rmSync(m.root, { recursive: true, force: true });
  }
});
test('take theirs uses the bound body under lock and retains reset facts on failure and same-request retry', async () => {
  const m = agentMachine(),
    setup = setupFixture(join(m.root, 'snapshots'));
  await m.trust();
  m.write(
    join(m.paths.stateRoot, 'overrides.json'),
    JSON.stringify({
      version: 2,
      settings: { 'claude:settings.json': { effortLevel: 'low' } },
      future: { kept: true },
    }),
  );
  let calls = 0,
    scheduled = 0;
  try {
    await m.run(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* startAgent(() => m.domains, { deferStart: true });
          const overrides = yield* OverridesStore;
          const wrapped = {
            ...handle,
            decideAll: () => Effect.die('public mutator must not run'),
            mutationBodies: {
              ...handle.mutationBodies,
              decideAll: (_ds: unknown, actor: unknown) =>
                Effect.gen(function* () {
                  calls++;
                  assert.equal(actor, 'mcp');
                  assert.equal(
                    (yield* overrides.read).value.settings?.['claude:settings.json']?.effortLevel,
                    undefined,
                  );
                  assert.equal((yield* Effect.result(Effect.scoped(acquireApplyLock)))._tag, 'Failure');
                  return yield* Effect.fail(new Error('PRIVATE failure'));
                }).pipe(Effect.provideService(importPaths, m.paths)),
            },
            request: (trigger: Parameters<typeof handle.request>[0]) =>
              trigger === 'inspect'
                ? handle.request(trigger)
                : Effect.gen(function* () {
                    scheduled++;
                    yield* Effect.scoped(acquireApplyLock).pipe(Effect.orDie);
                    return (yield* handle.status)!;
                  }).pipe(Effect.provideService(importPaths, m.paths)),
          };
          const s = yield* makeSession(wrapped as typeof handle, {
            domains: () => m.domains,
            signal: new AbortController().signal,
          });
          yield* s.inspect('mcp');
          const p = yield* s.previewChange(change('takeTheirs'));
          const { run, request } = yield* submit(s, p.planId);
          assert.equal(run.state, 'failed');
          assert.ok(run.parity?.committedKeys.includes('sync:override'));
          assert.ok(!run.parity?.committedKeys.includes('sync:decision'));
          assert.ok(run.parity?.backupIds.length);
          assert.doesNotMatch(JSON.stringify(run), /PRIVATE/);
          assert.equal((yield* s.runs.submit(request)).runId, run.runId);
          assert.equal(calls, 1);
        }),
      ),
      setup.source,
    );
    assert.equal(JSON.parse(m.read(join(m.paths.stateRoot, 'overrides.json'))!).future.kept, true);
  } finally {
    rmSync(m.root, { recursive: true, force: true });
  }
});
import { MachinePaths as importPaths } from '@nortuscc/machine';
test('stale source/trust/override baselines and malformed holds refuse before durable acceptance', async () => {
  for (const kind of ['trust', 'override', 'holds', 'revision'] as const) {
    const m = agentMachine(),
      setup = setupFixture(join(m.root, 'snapshots'));
    await m.trust();
    try {
      await m.run(
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* startAgent(() => m.domains, { deferStart: true }),
              s = yield* makeSession(handle, { domains: () => m.domains, signal: new AbortController().signal });
            yield* s.inspect('mcp');
            const p = yield* s.previewChange(change());
            if (kind === 'trust') m.write(join(m.paths.stateRoot, 'agent/setups.json'), '{"version":1,"setups":[]}');
            if (kind === 'override')
              m.write(join(m.paths.stateRoot, 'overrides.json'), '{"version":2,"manageConfig":false}');
            if (kind === 'holds') m.write(join(m.paths.stateRoot, 'sync.json'), 'PRIVATE invalid');
            if (kind === 'revision') setup.unavailable.add('load');
            const result = yield* Effect.result(
              s.runs.submit({
                planId: p.planId,
                requestId: kind,
                inputDigest: operationDigest(p.planId),
                actor: 'mcp',
              }),
            );
            assert.equal(result._tag, 'Failure');
            assert.equal((yield* s.runs.list({ limit: 10 })).runs.length, 0);
          }),
        ),
        setup.source,
      );
    } finally {
      rmSync(m.root, { recursive: true, force: true });
    }
  }
});
import { AgentStateStore } from '../src/state.ts';
test('acceptance schedules only after lock release; automatic policy keeps code-running items held', async () => {
  const m = agentMachine(),
    setup = setupFixture(join(m.root, 'snapshots'), {
      headFiles: { 'skills-manifest.txt': '[owner/repo]\nnew-code\n' },
    });
  await m.trust();
  let after = false;
  try {
    await m.run(
      Effect.scoped(
        Effect.gen(function* () {
          yield* (yield* AgentStateStore).update((s) => ({ ...s, policy: 'auto-apply' }));
          const handle = yield* startAgent(() => [...m.domains, skillsDomain], { deferStart: true });
          const wrapped = {
            ...handle,
            request: (trigger: Parameters<typeof handle.request>[0]) =>
              Effect.gen(function* () {
                if (trigger === 'decide') {
                  yield* Effect.scoped(acquireApplyLock).pipe(Effect.orDie);
                  after = true;
                }
                return yield* handle.request(trigger);
              }).pipe(Effect.provideService(importPaths, m.paths)),
          };
          const s = yield* makeSession(wrapped, {
            domains: () => [...m.domains, skillsDomain],
            signal: new AbortController().signal,
          });
          yield* s.inspect('mcp');
          const p = yield* s.previewChange(change());
          const { run } = yield* submit(s, p.planId);
          assert.equal(run.state, 'succeeded');
          while (!after) yield* Effect.yieldNow;
          yield* handle.request('inspect');
          const status = yield* handle.status;
          assert.equal(status!.pending.find((p) => p.itemId === 'integration:hk')?.verdict.kind, 'held');
          assert.equal(status!.pending.find((p) => p.itemId === 'skill:owner/repo/new-code')?.verdict.kind, 'held');
          assert.equal(JSON.parse(m.read(join(m.paths.claude, 'settings.json'))!).effortLevel, 'high');
          const choices = yield* (yield* DecisionsStore).read;
          assert.equal(choices.find((d) => d.itemId === EFFORT)?.decision, 'accept');
        }),
      ),
      setup.source,
    );
  } finally {
    rmSync(m.root, { recursive: true, force: true });
  }
});
test('hosted exact number and commit queue locally; stale account and offer refuse', async () => {
  const m = agentMachine(),
    setup = setupFixture(join(m.root, 'snapshots'));
  await m.trust();
  let account = 'account-1',
    number = 4,
    calls = 0;
  const hostedChange = {
    ...change(),
    setupId: 'hosted-setup',
    revision: { kind: 'hosted' as const, number: 4, commitSha: HEAD },
  };
  try {
    await m.run(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* startAgent(() => m.domains, { deferStart: true });
          const source = {
            ...setup.service,
            setupId: 'hosted-setup',
            trusted: Effect.succeed(true),
            fetch: Effect.sync(() => ({
              head: {
                setupId: 'hosted-setup',
                number,
                commitSha: HEAD,
                tag: `v${number}`,
                items: [{ id: EFFORT, kind: 'setting' as const, change: 'added' as const }],
                changelog: 'PRIVATE',
                requiredEnv: [],
              },
            })),
          };
          const wrapped = {
            ...handle,
            selectOperationSetup: () =>
              Effect.sync(() => ({
                setupId: 'hosted-setup',
                accountId: account,
                repository: 'https://github.com/example/setup',
                trusted: true,
                source,
              })),
            mutationBodies: {
              ...handle.mutationBodies,
              decideAll: (
                ds: readonly import('@nortuscc/machine').Decision[],
                actor: import('@nortuscc/machine').Actor,
              ) =>
                Effect.sync(() => {
                  calls++;
                  assert.equal(actor, 'mcp');
                  assert.equal(ds[0]?.revision, 4);
                  assert.equal(ds[0]?.commit, null);
                }),
            },
          };
          const s = yield* makeSession(wrapped, { domains: () => m.domains, signal: new AbortController().signal });
          const p = yield* s.previewChange(hostedChange);
          assert.match(JSON.stringify(p), /queued locally/);
          const { run } = yield* submit(s, p.planId);
          assert.equal(run.state, 'succeeded');
          assert.equal(calls, 1);
          const stale = yield* s.previewChange(hostedChange);
          account = 'account-2';
          yield* Effect.flip(
            s.runs.submit({
              planId: stale.planId,
              requestId: 'account-change',
              inputDigest: operationDigest(stale.planId),
              actor: 'mcp',
            }),
          );
          assert.equal(calls, 1);
          number = 5;
          yield* Effect.flip(s.previewChange(hostedChange));
          yield* Effect.flip(s.previewChange({ ...hostedChange, revision: { kind: 'local', commit: HEAD } }));
        }),
      ),
      setup.source,
    );
  } finally {
    rmSync(m.root, { recursive: true, force: true });
  }
});
import { makeHostedRuntime, SetupsStore } from '../src/index.ts';
import { Processes } from '@nortuscc/machine';
import type { HostedClient, HostedState } from '@nortuscc/hosted-client';
import { tempRepo } from '../../sync/checks/support/repo.ts';
test('real hosted selector verifies tagged repository and account consent before queued take-theirs', async () => {
  const repo = tempRepo({ 'claude/settings.keys.json': '{"effortLevel":"high"}' }),
    m = agentMachine(),
    local = setupFixture(join(m.root, 'local'));
  repo.git('tag', 'v1');
  const url = 'https://github.com/example/hosted';
  let state: HostedState = {
    accountId: 'account-1',
    login: 'fixture',
    machineId: 'machine-1',
    auth: 'signed-in',
    setups: [{ setupId: 'setup-1', name: 'fixture', repoUrl: url, profile: 'default', owned: true, latestRevision: 1 }],
    machine: null,
    lastSyncAt: null,
    retryAt: '9999-01-01T00:00:00Z',
    pollAfter: 900,
    error: null,
  };
  const revision = {
    setupId: 'setup-1',
    number: 1,
    commitSha: repo.first,
    tag: 'v1',
    changelog: 'PRIVATE REPOSITORY TEXT',
    requiredEnv: [],
    items: [{ id: EFFORT, kind: 'setting' as const, change: 'added' as const }],
  };
  const second = repo.commit({ 'claude/settings.keys.json': '{"effortLevel":"high","theme":"dark"}' });
  repo.git('tag', 'v2');
  const records: import('@nortuscc/hosted-protocol').SyncRevision[] = [
    revision,
    {
      ...revision,
      number: 2,
      commitSha: second,
      tag: 'v2',
      items: [{ id: 'setting:claude:settings.json#theme', kind: 'setting' as const, change: 'added' as const }],
    },
  ];
  state = { ...state, setups: state.setups.map((s) => ({ ...s, latestRevision: 2 })) };
  let calls = 0;
  try {
    await m.run(
      Effect.scoped(
        Effect.gen(function* () {
          yield* (yield* SetupsStore).write([
            {
              setupId: 'setup-1',
              accountId: 'account-1',
              repoUrl: url,
              checkout: null,
              trustedAt: '2026-10-14T00:00:00Z',
            },
          ]);
          const overrides = yield* OverridesStore,
            decisions = yield* DecisionsStore;
          const client: HostedClient = {
            registerSetup: () => Effect.die('Unexpected setup registration'),
            publishRevision: () => Effect.die('Unexpected publication'),
            listRevisions: () => Effect.succeed([]),
            publicSetup: () => Effect.die('Unexpected public setup read'),
            subscribe: () => Effect.void,
            unsubscribe: () => Effect.void,
            signInFlow: Effect.succeed(null),
            state: Effect.sync(() => state),
            revisions: () => Effect.sync(() => records),
            recover: () => Effect.sync(() => state),
            sync: () => Effect.sync(() => state),
            startSignIn: () => Effect.die('unused'),
            pollSignIn: () => Effect.die('unused'),
            signOut: () => Effect.void,
            enqueueMachine: () => Effect.void,
            reportStatus: () => Effect.void,
            enqueueDecision: (d, actor) =>
              Effect.gen(function* () {
                calls++;
                assert.equal(actor, 'mcp');
                assert.equal(d.commit, null);
                assert.equal(d.revision, 1);
                assert.equal((yield* overrides.read).value.settings?.['claude:settings.json']?.effortLevel, undefined);
                yield* decisions.record(d);
              }).pipe(Effect.orDie),
          };
          const processes = yield* Processes;
          const redirected = {
            ...processes,
            run: (command: Parameters<Processes['Service']['run']>[0]) =>
              processes.run({
                ...command,
                args: command.args.map((arg) => (arg === url && command.args.includes('fetch') ? repo.dir : arg)),
                stderr: 'capture' as const,
              }),
          };
          const runtime = yield* makeHostedRuntime(client, { domains: () => m.domains, os: 'macos' }).pipe(
            Effect.provideService(Processes, redirected),
          );
          yield* runtime.runJobs;
          const handle = yield* startAgent(() => m.domains, { deferStart: true, hosted: runtime });
          const session = yield* makeSession(handle, {
            domains: () => m.domains,
            signal: new AbortController().signal,
          });
          const setups = yield* session.inspectSetups(decodeOperationInput('inspectSetups', {}));
          assert.equal(setups.items.find((s) => s.setupId === 'setup-1')?.trusted, true);
          const offered = yield* session.incomingChanges(
            decodeOperationInput('incomingChanges', { setupId: 'setup-1' }),
          );
          assert.deepEqual(offered.revision, { kind: 'hosted', number: 2, commitSha: second });
          assert.deepEqual(offered.items.find((i) => i.itemId === EFFORT)?.revision, {
            kind: 'hosted',
            number: 1,
            commitSha: repo.first,
          });
          assert.doesNotMatch(JSON.stringify(offered), /PRIVATE/);
          m.write(
            join(m.paths.stateRoot, 'overrides.json'),
            '{"version":2,"settings":{"claude:settings.json":{"effortLevel":"low"}}}',
          );
          const c = {
            ...change('takeTheirs'),
            setupId: 'setup-1',
            revision: offered.items.find((i) => i.itemId === EFFORT)!.revision,
          };
          const p = yield* session.previewChange(c);
          assert.equal((yield* overrides.read).value.settings?.['claude:settings.json']?.effortLevel, 'low');
          const { run } = yield* submit(session, p.planId, 'verified-hosted');
          assert.equal(run.state, 'succeeded');
          assert.equal(calls, 1);
          const superseded = yield* session.previewChange({ ...c, action: 'hold' });
          const third = repo.commit({ 'claude/settings.keys.json': '{"effortLevel":"max","theme":"dark"}' });
          repo.git('tag', 'v3');
          records.push({
            ...revision,
            number: 3,
            commitSha: third,
            tag: 'v3',
            items: [{ id: EFFORT, kind: 'setting', change: 'changed' }],
          });
          state = { ...state, setups: state.setups.map((s) => ({ ...s, latestRevision: 3 })) };
          yield* Effect.flip(
            session.runs.submit({
              planId: superseded.planId,
              requestId: 'superseded',
              inputDigest: operationDigest(superseded.planId),
              actor: 'mcp',
            }),
          );
          yield* Effect.flip(session.previewChange({ ...c, action: 'hold' }));
          const fresh = yield* session.previewChange({
            ...c,
            revision: { kind: 'hosted', number: 3, commitSha: third },
            action: 'hold',
          });
          state = { ...state, accountId: 'account-2' };
          yield* Effect.flip(
            session.runs.submit({
              planId: fresh.planId,
              requestId: 'different-account',
              inputDigest: operationDigest(fresh.planId),
              actor: 'mcp',
            }),
          );
          assert.equal(calls, 1);
          const trust = yield* session.prepareTrustRequest(
            decodeOperationInput('prepareTrustRequest', { setupId: 'setup-1' }),
          );
          assert.equal(trust.trusted, false);
          assert.equal((yield* (yield* SetupsStore).read)?.[0]?.accountId, 'account-1');
        }),
      ),
      local.source,
    );
  } finally {
    rmSync(m.root, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});
test('dedicated sync reads refuse mixed observation generations and inspection identities', async () => {
  for (const seam of ['generation', 'inspection'] as const)
    for (const name of ['inspectSetups', 'incomingChanges', 'prepareTrustRequest'] as const) {
      const m = agentMachine(),
        setup = setupFixture(join(m.root, 'snapshots'));
      await m.trust();
      try {
        await m.run(
          Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* startAgent(() => m.domains, { deferStart: true });
              yield* handle.request('inspect');
              let generation = 0,
                inspection = yield* handle.inspection;
              const wrapped = {
                ...handle,
                generation: Effect.sync(() => generation),
                inspection: Effect.sync(() => inspection),
                selectOperationSetup: (id: string) =>
                  handle.selectOperationSetup!(id).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        if (seam === 'generation') generation++;
                        else inspection = { ...inspection! };
                      }),
                    ),
                  ),
              };
              const session = yield* makeSession(wrapped, {
                domains: () => m.domains,
                signal: new AbortController().signal,
              });
              const args = decodeOperationInput(name, name === 'inspectSetups' ? {} : { setupId: 'local' });
              const result = yield* Effect.result(
                name === 'inspectSetups'
                  ? session.inspectSetups(args as never).pipe(Effect.asVoid)
                  : name === 'incomingChanges'
                    ? session.incomingChanges(args as never).pipe(Effect.asVoid)
                    : session.prepareTrustRequest(args as never).pipe(Effect.asVoid),
              );
              assert.equal(result._tag, 'Failure');
              if (result._tag === 'Failure') assert.equal(result.failure.code, 'UNKNOWN_PLAN');
            }),
          ),
          setup.source,
        );
      } finally {
        rmSync(m.root, { recursive: true, force: true });
      }
    }
});

import { tempSetup, json } from '../../sync/checks/support/repo.ts';
import { setupSourceLayer, normalizeRepoUrl } from '@nortuscc/sync';
test('local A/B/C hold is discoverable through incomingChanges and releasable from its exact row', async () => {
  const repo = tempSetup(),
    m = agentMachine();
  Object.assign(m.paths, { repo: repo.checkout });
  const itemId = 'setting:claude:settings.json#model';
  const added = repo.push({
    'claude/settings.keys.json': json({ theme: 'auto', effortLevel: 'high', model: 'test-model' }),
  });
  const removed = repo.push({ 'claude/settings.keys.json': json({ theme: 'auto', effortLevel: 'high' }) });
  m.write(
    join(m.paths.stateRoot, 'agent/setups.json'),
    json({
      version: 1,
      setups: [
        {
          setupId: null,
          repoUrl: normalizeRepoUrl(repo.origin),
          checkout: repo.checkout,
          trustedAt: new Date().toISOString(),
        },
      ],
    }),
  );
  m.write(join(m.paths.stateRoot, 'state.json'), json({ version: 1, files: {}, applied: { commit: added } }));
  m.write(join(m.paths.stateRoot, 'sync.json'), json({ version: 1, held: { [itemId]: repo.first } }));
  try {
    await m.run(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* startAgent(() => [], { deferStart: true });
          const session = yield* makeSession(handle, { domains: () => [], signal: new AbortController().signal });
          yield* session.inspect('mcp');
          const incoming = yield* session.incomingChanges(
            decodeOperationInput('incomingChanges', { setupId: 'local' }),
          );
          const row = incoming.items.find((item) => item.itemId === itemId);
          assert.deepEqual(row, {
            itemId,
            revision: { kind: 'local', commit: removed },
            kind: 'setting',
            change: 'unchanged',
            held: true,
            conflict: false,
          });
          const preview = yield* session.previewChange({
            kind: 'syncDecision',
            setupId: 'local',
            itemId: row!.itemId,
            revision: row!.revision,
            action: 'release',
          });
          const { run } = yield* submit(session, preview.planId);
          assert.equal(run.state, 'succeeded');
          assert.ok(run.parity?.committedKeys.includes('sync:hold'));
          const after = yield* session.incomingChanges(decodeOperationInput('incomingChanges', { setupId: 'local' }));
          assert.equal(
            after.items.some((item) => item.itemId === itemId),
            false,
          );
        }),
      ),
      setupSourceLayer(m.paths),
    );
    assert.deepEqual(JSON.parse(m.read(join(m.paths.stateRoot, 'sync.json'))!).held, {});
  } finally {
    rmSync(m.root, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});
