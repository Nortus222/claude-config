import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Effect, Layer } from 'effect';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  Backups,
  FsFailed,
  backupsForRun,
  machinePaths,
  nodeFs,
  nodeProcesses,
  OverridesStore,
  overridesStore,
} from '@nortuscc/machine';
import {
  desiredOfDocuments,
  SyncStore,
  syncStore,
  prepareSyncDecision,
  persistSyncDecision,
  type SetupSource,
} from '../src/index.ts';
const OLD = 'a'.repeat(40),
  HEAD = 'b'.repeat(40),
  ID = 'setting:claude:settings.json#theme';
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'sync-decisions-'));
  const paths = {
    repo: join(root, 'head'),
    stateRoot: join(root, 'state'),
    backups: join(root, 'backups'),
    claude: join(root, 'claude'),
    codex: join(root, 'codex'),
    codexOpenRouter: join(root, 'openrouter'),
    agentsSkills: join(root, 'skills'),
  };
  const snapshot = (name: string, theme: string) => {
    const repo = join(root, name);
    mkdirSync(join(repo, 'claude'), { recursive: true });
    const docs = { 'claude/settings.keys.json': JSON.stringify({ theme, model: 'kept' }) };
    writeFileSync(join(repo, 'claude/settings.keys.json'), docs['claude/settings.keys.json']);
    return { repo, desired: desiredOfDocuments(docs) };
  };
  const old = snapshot('old', 'auto'),
    head = snapshot('head', 'light');
  const source: SetupSource['Service'] = {
    fetch: Effect.succeed({ head: HEAD }),
    load: () => Effect.succeed(head),
    current: Effect.succeed(old),
    effective: () => Effect.succeed({ applied: { ...old, revision: OLD }, effective: head, conflicts: [] }),
  };
  const services = Layer.mergeAll(overridesStore, syncStore, backupsForRun(new Date())).pipe(
    Layer.provideMerge(Layer.mergeAll(machinePaths(paths), nodeFs, nodeProcesses())),
  );
  const run = <A, E, R>(e: Effect.Effect<A, E, R>) =>
    Effect.runPromise(e.pipe(Effect.provide(services)) as Effect.Effect<A, E>);
  return { root, paths, source, run, close: () => rmSync(root, { recursive: true, force: true }) };
};
test('take theirs resets and backs up before recording; failed recording preserves observed partial facts', async () => {
  const f = fixture();
  try {
    mkdirSync(f.paths.stateRoot, { recursive: true });
    const bytes = JSON.stringify({
      version: 2,
      settings: { 'claude:settings.json': { theme: 'dark', model: 'kept' } },
      future: { kept: true },
    });
    writeFileSync(join(f.paths.stateRoot, 'overrides.json'), bytes);
    const events: string[] = [];
    await f.run(
      Effect.gen(function* () {
        const overrides = (yield* (yield* OverridesStore).read).value;
        const prepared = yield* prepareSyncDecision({
          source: f.source,
          change: {
            kind: 'syncDecision',
            setupId: 'local',
            revision: { kind: 'local', commit: HEAD },
            itemId: ID,
            action: 'takeTheirs',
          },
          overrides,
          holds: {},
          decisions: [],
          now: new Date(),
        });
        const context = yield* Effect.context<OverridesStore | Backups>();
        const result = yield* Effect.result(
          persistSyncDecision(
            prepared,
            () =>
              Effect.gen(function* () {
                assert.equal(
                  (yield* (yield* OverridesStore).read).value.settings?.['claude:settings.json']?.theme,
                  undefined,
                );
                const folder = yield* (yield* Backups).dir;
                assert.equal(readFileSync(join(folder!, 'overrides.json'), 'utf8'), bytes);
                return yield* Effect.fail(new Error('decision failed'));
              }).pipe(Effect.provideContext(context)),
            {
              pending: (k) => Effect.sync(() => events.push(`pending:${k}`)),
              committed: (k) => Effect.sync(() => events.push(`committed:${k}`)),
            },
          ),
        );
        assert.equal(result._tag, 'Failure');
      }),
    );
    assert.ok(events.includes('committed:sync:override'));
    assert.ok(!events.includes('committed:sync:decision'));
    const saved = JSON.parse(readFileSync(join(f.paths.stateRoot, 'overrides.json'), 'utf8'));
    assert.equal(saved.settings['claude:settings.json'].model, 'kept');
    assert.deepEqual(saved.future, { kept: true });
  } finally {
    f.close();
  }
});
test('decision preparation rejects stale full revisions and unknown items without effects', async () => {
  const f = fixture();
  try {
    for (const change of [
      { revision: { kind: 'local' as const, commit: OLD }, itemId: ID },
      { revision: { kind: 'local' as const, commit: HEAD }, itemId: 'integration:absent' },
    ]) {
      await assert.rejects(
        f.run(
          prepareSyncDecision({
            source: f.source,
            change: { kind: 'syncDecision', setupId: 'local', action: 'accept', ...change },
            overrides: {},
            holds: {},
            decisions: [],
            now: new Date(),
          }),
        ),
      );
    }
  } finally {
    f.close();
  }
});
test('release without a hold is explicit unchanged; holds and unrelated choices are retained', async () => {
  const f = fixture();
  try {
    await f.run(
      Effect.gen(function* () {
        const input = {
          source: f.source,
          change: {
            kind: 'syncDecision' as const,
            setupId: 'local',
            revision: { kind: 'local' as const, commit: HEAD },
            itemId: ID,
            action: 'release' as const,
          },
          overrides: {},
          holds: { 'file:claude:CLAUDE.md': OLD },
          decisions: [],
          now: new Date(),
        };
        const prepared = yield* prepareSyncDecision(input);
        let called = false;
        const result = yield* persistSyncDecision(
          prepared,
          () =>
            Effect.sync(() => {
              called = true;
            }),
          { pending: () => Effect.void, committed: () => Effect.void },
        );
        assert.equal(result.decision, 'unchanged');
        assert.equal(called, false);
        assert.deepEqual(prepared.nextHolds, input.holds);
        const held = yield* prepareSyncDecision({ ...input, change: { ...input.change, action: 'hold' } });
        assert.deepEqual(held.nextHolds, { ...input.holds, [ID]: OLD });
        assert.equal(held.decision.decision, 'skip');
        const released = yield* prepareSyncDecision({ ...input, holds: { ...input.holds, [ID]: OLD } });
        assert.deepEqual(released.nextHolds, input.holds);
        assert.equal(released.decision.decision, 'accept');
      }),
    );
  } finally {
    f.close();
  }
});
import { tempSetup, json } from './support/repo.ts';
import { setupSourceLayer, normalizeRepoUrl } from '../src/index.ts';
import { SetupSource as SourceService } from '../src/index.ts';
test('real local tentative holds retain source-wide pin consequences without writing choices or moving HEAD', async () => {
  const setup = tempSetup(),
    f = fixture();
  f.paths.repo = setup.checkout;
  const skill = 'skill:mattpocock/skills/tdd',
    sibling = 'skill:mattpocock/skills/diagnose';
  const offered = setup.push({
    'skill-pins.json': json({ version: 1, pins: { 'mattpocock/skills': 'c'.repeat(40) } }),
  });
  mkdirSync(join(f.paths.stateRoot, 'agent'), { recursive: true });
  writeFileSync(
    join(f.paths.stateRoot, 'agent/setups.json'),
    json({
      version: 1,
      setups: [
        {
          setupId: null,
          repoUrl: normalizeRepoUrl(setup.origin),
          checkout: setup.checkout,
          trustedAt: new Date().toISOString(),
        },
      ],
    }),
  );
  writeFileSync(
    join(f.paths.stateRoot, 'state.json'),
    json({ version: 1, files: {}, applied: { commit: setup.first } }),
  );
  try {
    await f.run(
      Effect.gen(function* () {
        const source = yield* SourceService;
        const prepared = yield* prepareSyncDecision({
          source,
          change: {
            kind: 'syncDecision',
            setupId: 'local',
            revision: { kind: 'local', commit: offered },
            itemId: skill,
            action: 'hold',
          },
          overrides: {},
          holds: {},
          decisions: [],
          now: new Date(),
        });
        assert.equal(prepared.nextHolds[skill], setup.first);
        assert.deepEqual(prepared.sourceImpact?.skills, ['diagnose', 'tdd']);
        assert.equal(prepared.sourceImpact?.after, 'a'.repeat(40));
        const accepted = { ...prepared.decision, itemId: sibling, decision: 'accept' as const };
        const withHeld = yield* source.effective([accepted], {
          overrides: { value: {}, source: 'fixture', issues: [] },
          holds: { [skill]: setup.first },
        });
        assert.equal(withHeld.effective.desired.skills.find((s) => s.name === 'diagnose')?.pin?.ref, 'a'.repeat(40));
        assert.deepEqual(yield* (yield* SyncStore).read, {});
        assert.equal(setup.inCheckout('rev-parse', 'HEAD'), setup.first);
      }).pipe(Effect.provide(setupSourceLayer(f.paths))),
    );
  } finally {
    f.close();
    rmSync(setup.root, { recursive: true, force: true });
  }
});
test('external edits during backups refuse replacement and retain an earlier observed reset', async () => {
  for (const at of ['override', 'hold', 'decision'] as const) {
    const f = fixture();
    const committed: string[] = [];
    let records = 0;
    try {
      mkdirSync(f.paths.stateRoot, { recursive: true });
      writeFileSync(
        join(f.paths.stateRoot, 'overrides.json'),
        JSON.stringify({ version: 2, settings: { 'claude:settings.json': { theme: 'dark', model: 'kept' } } }),
      );
      writeFileSync(join(f.paths.stateRoot, 'sync.json'), JSON.stringify({ version: 1, held: { [ID]: OLD } }));
      await f.run(
        Effect.gen(function* () {
          const overrides = yield* OverridesStore,
            backups = yield* Backups;
          const prepared = yield* prepareSyncDecision({
            source: f.source,
            change: {
              kind: 'syncDecision',
              setupId: 'local',
              revision: { kind: 'local', commit: HEAD },
              itemId: ID,
              action: 'takeTheirs',
            },
            overrides: (yield* overrides.read).value,
            holds: yield* (yield* SyncStore).read,
            decisions: [],
            now: new Date(),
          });
          const guarded = {
            ...backups,
            preserve: (...args: Parameters<typeof backups.preserve>) =>
              backups.preserve(...args).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (at === 'override' && args[0].endsWith('overrides.json'))
                      writeFileSync(args[0], '{"version":2,"manageConfig":false}');
                    if (at === 'hold' && args[0].endsWith('sync.json'))
                      writeFileSync(
                        args[0],
                        JSON.stringify({ version: 1, held: { [ID]: OLD, 'file:claude:CLAUDE.md': OLD } }),
                      );
                  }),
                ),
              ),
          };
          const result = yield* Effect.result(
            persistSyncDecision(
              prepared,
              () =>
                Effect.sync(() => {
                  records++;
                }),
              {
                pending: () => Effect.void,
                committed: (key) =>
                  Effect.sync(() => {
                    committed.push(key);
                    if (at === 'decision' && key === 'sync:override')
                      writeFileSync(join(f.paths.stateRoot, 'decisions.json'), '{"version":1,"decisions":[]}');
                  }),
              },
            ).pipe(Effect.provideService(Backups, guarded)),
          );
          assert.equal(result._tag, 'Failure');
          assert.equal(records, 0);
        }),
      );
      assert.equal(committed.includes('sync:override'), at !== 'override');
      assert.equal(committed.includes('sync:hold'), false);
      if (at === 'override')
        assert.equal(JSON.parse(readFileSync(join(f.paths.stateRoot, 'overrides.json'), 'utf8')).manageConfig, false);
      if (at === 'hold')
        assert.ok(JSON.parse(readFileSync(join(f.paths.stateRoot, 'sync.json'), 'utf8')).held['file:claude:CLAUDE.md']);
    } finally {
      f.close();
    }
  }
});
test('hold persistence failure leaves the completed reset and original hold without recording a decision', async () => {
  const f = fixture();
  try {
    mkdirSync(f.paths.stateRoot, { recursive: true });
    writeFileSync(
      join(f.paths.stateRoot, 'overrides.json'),
      '{"version":2,"settings":{"claude:settings.json":{"theme":"dark"}}}',
    );
    writeFileSync(join(f.paths.stateRoot, 'sync.json'), JSON.stringify({ version: 1, held: { [ID]: OLD } }));
    const committed: string[] = [];
    let recorded = false;
    await f.run(
      Effect.gen(function* () {
        const overrides = yield* OverridesStore,
          sync = yield* SyncStore;
        const prepared = yield* prepareSyncDecision({
          source: f.source,
          change: {
            kind: 'syncDecision',
            setupId: 'local',
            revision: { kind: 'local', commit: HEAD },
            itemId: ID,
            action: 'takeTheirs',
          },
          overrides: (yield* overrides.read).value,
          holds: yield* sync.read,
          decisions: [],
          now: new Date(),
        });
        const result = yield* Effect.result(
          persistSyncDecision(
            prepared,
            () =>
              Effect.sync(() => {
                recorded = true;
              }),
            {
              pending: () => Effect.void,
              committed: (k) =>
                Effect.sync(() => {
                  committed.push(k);
                }),
            },
          ).pipe(
            Effect.provideService(SyncStore, {
              ...sync,
              write: () => Effect.fail(new FsFailed({ op: 'fixture', path: 'fixture', reason: 'failure' })),
            }),
          ),
        );
        assert.equal(result._tag, 'Failure');
        assert.equal((yield* overrides.read).value.settings?.['claude:settings.json']?.theme, undefined);
        assert.equal((yield* sync.read)[ID], OLD);
        assert.deepEqual(committed, ['sync:override']);
        assert.equal(recorded, false);
      }),
    );
  } finally {
    f.close();
  }
});

test('local A/B/C hold remains releasable after the added item disappears', async () => {
  const setup = tempSetup(),
    f = fixture();
  f.paths.repo = setup.checkout;
  const itemId = 'setting:claude:settings.json#model';
  const added = setup.push({
    'claude/settings.keys.json': json({ theme: 'auto', effortLevel: 'high', model: 'test-model' }),
  });
  const removed = setup.push({ 'claude/settings.keys.json': json({ theme: 'auto', effortLevel: 'high' }) });
  const holds = { [itemId]: setup.first, 'file:claude:CLAUDE.md': setup.first };
  mkdirSync(join(f.paths.stateRoot, 'agent'), { recursive: true });
  writeFileSync(
    join(f.paths.stateRoot, 'agent/setups.json'),
    json({
      version: 1,
      setups: [
        {
          setupId: null,
          repoUrl: normalizeRepoUrl(setup.origin),
          checkout: setup.checkout,
          trustedAt: new Date().toISOString(),
        },
      ],
    }),
  );
  writeFileSync(join(f.paths.stateRoot, 'state.json'), json({ version: 1, files: {}, applied: { commit: added } }));
  writeFileSync(join(f.paths.stateRoot, 'sync.json'), json({ version: 1, held: holds }));
  try {
    await f.run(
      Effect.gen(function* () {
        const source = yield* SourceService;
        const input = {
          source,
          change: {
            kind: 'syncDecision' as const,
            setupId: 'local',
            revision: { kind: 'local' as const, commit: removed },
            itemId,
            action: 'release' as const,
          },
          overrides: {},
          holds,
          decisions: [],
          now: new Date(),
        };
        for (const action of ['accept', 'hold', 'takeTheirs'] as const)
          assert.equal(
            (yield* Effect.result(prepareSyncDecision({ ...input, change: { ...input.change, action } })))._tag,
            'Failure',
          );
        assert.equal(
          (yield* Effect.result(
            prepareSyncDecision({ ...input, change: { ...input.change, revision: { kind: 'local', commit: added } } }),
          ))._tag,
          'Failure',
        );
        assert.equal((yield* Effect.result(prepareSyncDecision({ ...input, holds: {} })))._tag, 'Failure');
        const prepared = yield* prepareSyncDecision(input);
        assert.deepEqual(prepared.nextHolds, { 'file:claude:CLAUDE.md': setup.first });
        const result = yield* persistSyncDecision(
          prepared,
          (decisions) =>
            Effect.sync(() => {
              assert.equal(decisions[0]?.commit, removed);
              assert.equal(decisions[0]?.decision, 'accept');
            }),
          { pending: () => Effect.void, committed: () => Effect.void },
        );
        assert.equal(result.holdUpdated, true);
        assert.equal(result.decision, 'recorded');
        assert.deepEqual(yield* (yield* SyncStore).read, prepared.nextHolds);
        assert.equal(setup.inCheckout('rev-parse', 'HEAD'), setup.first);
      }).pipe(Effect.provide(setupSourceLayer(f.paths))),
    );
  } finally {
    f.close();
    rmSync(setup.root, { recursive: true, force: true });
  }
});
