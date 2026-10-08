import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Effect, Layer } from 'effect';
import { loadProfile, nodeFiles } from '@nortuscc/profile-engine';
import type { Decision } from '@nortuscc/machine';
import { revisionCommit, type Revision } from '@nortuscc/sync';
import { RevisionMismatch, RevisionUnavailable, SetupSource, type Snapshot } from '../../src/index.ts';

export const APPLIED = 'a'.repeat(40);
export const HEAD = 'b'.repeat(40);
export const EFFORT = 'setting:claude:settings.json#effortLevel';
export const HOOK = 'integration:hk';

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

// The applied commit owns `theme`; the new commit on the tracked branch adds an inert settings key and a hook.
export const APPLIED_FILES: Readonly<Record<string, string>> = { 'claude/settings.keys.json': json({ theme: 'dark' }) };
export const HEAD_FILES: Readonly<Record<string, string>> = {
  'claude/settings.keys.json': json({ theme: 'dark', effortLevel: 'high' }),
  'integrations.json': json({
    version: 1,
    integrations: [{ id: 'hk', label: 'session hook', target: 'claude', type: 'hook', default: true, event: 'SessionStart', file: 'claude/hooks/session.mjs' }],
  }),
  'claude/hooks/session.mjs': 'console.log("session");\n',
};

export const accept = (itemId: string, commit = HEAD): Decision => ({
  setupId: 'local', itemId, revision: null, commit, decision: 'accept',
  decidedAt: '2026-10-06T00:00:00.000Z', machineId: null, source: 'local',
});

export type SourceCall = 'fetch' | 'load' | 'effective' | 'current';
export type FixtureOptions = {
  readonly headFiles?: Readonly<Record<string, string>>;
  readonly rejectHead?: boolean;
  // Calls that fail with RevisionUnavailable; the returned `unavailable` set can change between jobs.
  readonly unavailable?: ReadonlyArray<SourceCall>;
};

// Two commits of a setup repo as directories, and a fake #43 SetupSource over them. Until #43
// composes effective configurations item by item, the fake takes the whole head commit once any
// of its items is accepted; sort.spec covers per-item skipping. The checkout's HEAD (`current`) is
// the head commit. `calls` lists every call the job made, in order.
export const setupFixture = (root: string, options: FixtureOptions = {}) => {
  const dirs: Readonly<Record<string, string>> = { [APPLIED]: join(root, 'applied'), [HEAD]: join(root, 'head') };
  const files: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    [APPLIED]: APPLIED_FILES,
    [HEAD]: { ...HEAD_FILES, ...options.headFiles },
  };
  for (const revision of [APPLIED, HEAD]) {
    for (const [relative, text] of Object.entries(files[revision]!)) {
      const path = join(dirs[revision]!, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
  }
  const unavailable = new Set<SourceCall>(options.unavailable);
  const calls: Array<SourceCall> = [];
  const called = (call: SourceCall) => Effect.sync(() => void calls.push(call));
  const down = (call: SourceCall, revision: Revision) =>
    Effect.fail(new RevisionUnavailable({ revision, reason: `${call} is unavailable` }));
  const snapshot = (revision: string) =>
    loadProfile(dirs[revision]!).pipe(
      Effect.provide(nodeFiles),
      Effect.orDie,
      Effect.map((desired): Snapshot => ({ desired, repo: dirs[revision]! })),
    );
  const service: SetupSource['Service'] = {
    fetch: Effect.andThen(called('fetch'), Effect.suspend(() => (unavailable.has('fetch') ? down('fetch', HEAD) : Effect.succeed({ head: HEAD })))),
    load: (revision) =>
      Effect.gen(function* () {
        yield* called('load');
        if (unavailable.has('load')) return yield* down('load', revision);
        if (options.rejectHead && revision === HEAD) return yield* Effect.fail(new RevisionMismatch({ revision, reason: 'not on the tracked branch' }));
        if (dirs[revisionCommit(revision)] === undefined) return yield* Effect.fail(new RevisionUnavailable({ revision, reason: 'unknown commit' }));
        return yield* snapshot(revisionCommit(revision));
      }),
    effective: (decisions) =>
      Effect.gen(function* () {
        yield* called('effective');
        if (unavailable.has('effective')) return yield* down('effective', HEAD);
        const applied = yield* snapshot(APPLIED);
        const accepted = decisions.some((d) => d.commit === HEAD && d.decision === 'accept');
        return { applied: { ...applied, revision: APPLIED }, effective: accepted ? yield* snapshot(HEAD) : applied, conflicts: [] };
      }),
    current: Effect.andThen(called('current'), Effect.suspend(() => (unavailable.has('current') ? down('current', 'HEAD') : snapshot(HEAD)))),
  };
  return { dirs, service, unavailable, calls, source: Layer.succeed(SetupSource, service) };
};
