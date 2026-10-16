import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Effect, Layer } from 'effect';
import { loadProfile, nodeFiles } from '@nortuscc/profile-engine';
import type { Decision } from '@nortuscc/machine';
import { desiredOfDocuments, patchItem, revisionCommit, type Revision } from '@nortuscc/sync';
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
  readonly appliedFiles?: Readonly<Record<string, string>>;
  readonly headFiles?: Readonly<Record<string, string>>;
  readonly rejectHead?: boolean;
  readonly composeStateRoot?: string;
  // Calls that fail with RevisionUnavailable; the returned `unavailable` set can change between jobs.
  readonly unavailable?: ReadonlyArray<SourceCall>;
};

// Two setup snapshots with recorded calls. composeStateRoot enables per-item composition using
// real profile documents and the fixture machine's current overrides and holds.
export const setupFixture = (root: string, options: FixtureOptions = {}) => {
  const dirs: Readonly<Record<string, string>> = { [APPLIED]: join(root, 'applied'), [HEAD]: join(root, 'head') };
  const files: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    [APPLIED]: { ...APPLIED_FILES, ...options.appliedFiles },
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
    effective: (decisions, choices) =>
      Effect.gen(function* () {
        yield* called('effective');
        if (unavailable.has('effective')) return yield* down('effective', HEAD);
        const applied = yield* snapshot(APPLIED);
        if (options.composeStateRoot) {
          const read = (name: string) => {
            const path = join(options.composeStateRoot!, name);
            return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
          };
          const holds = choices?.holds ?? read('sync.json').held ?? {};
          const overrides = choices?.overrides.value ?? (() => { const { version, ...value } = read('overrides.json'); return value; })();
          let documents = files[APPLIED]!;
          for (const id of Object.keys(holds).sort()) documents = patchItem(documents, id, files[holds[id]] ?? {});
          const current = documents;
          for (const decision of decisions) {
            if (decision.commit === HEAD && decision.decision === 'accept' && !Object.hasOwn(holds, decision.itemId)) {
              documents = patchItem(documents, decision.itemId, files[HEAD]!);
            }
          }
          const repo = join(root, 'composed');
          for (const [path, text] of Object.entries(documents)) {
            mkdirSync(dirname(join(repo, path)), { recursive: true });
            writeFileSync(join(repo, path), text);
          }
          return { applied: { desired: desiredOfDocuments(current), repo: applied.repo, revision: APPLIED },
            effective: { desired: desiredOfDocuments(documents, { value: overrides, issues: [], source: 'fixture' }), repo }, conflicts: [] };
        }
        const accepted = decisions.some((d) => d.commit === HEAD && d.decision === 'accept');
        return { applied: { ...applied, revision: APPLIED }, effective: accepted ? yield* snapshot(HEAD) : applied, conflicts: [] };
      }),
    current: Effect.andThen(called('current'), Effect.suspend(() => (unavailable.has('current') ? down('current', 'HEAD') : snapshot(HEAD)))),
  };
  return { dirs, service, unavailable, calls, source: Layer.succeed(SetupSource, service) };
};
