import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Effect } from 'effect';
import {
  Backups,
  canonical,
  Fs,
  FsFailed,
  MachinePaths,
  OverridesStore,
  type Decision,
  type MutationObserver,
  type Processes,
} from '@nortuscc/machine';
import { INTEGRATIONS_SOURCE, type DesiredConfig, type MachineOverrides } from '@nortuscc/profile-engine';
import { desiredOfDocuments, worktreeDocuments } from './documents.ts';
import { diffItems, itemValues, parseItemId } from './items.ts';
import { withoutOverride } from './plan.ts';
import { LOCAL_SETUP, type SetupSource, type Revision } from './source.ts';
import { SyncStore, type Holds } from './store.ts';
export type SyncDecisionChange = {
  readonly kind: 'syncDecision';
  readonly setupId: string;
  readonly revision:
    | { readonly kind: 'local'; readonly commit: string }
    | { readonly kind: 'hosted'; readonly number: number; readonly commitSha: string };
  readonly itemId: string;
  readonly action: 'accept' | 'hold' | 'release' | 'takeTheirs';
};
export type SyncDecisionInput = {
  source: SetupSource['Service'];
  // The batch owner validates the complete composition after preparing every independent decision.
  deferComposition?: boolean;
  // Legacy CLI applies valid independent domains and reports the refused integrations manifest separately.
  validation?: 'cli-independent-integrations';
  change: SyncDecisionChange;
  overrides: MachineOverrides;
  holds: Holds;
  decisions: readonly Decision[];
  now: Date;
};
export type PreparedSyncDecision = {
  change: SyncDecisionChange;
  nextOverrides: MachineOverrides;
  previousOverrides: MachineOverrides;
  nextHolds: Holds;
  decision: Decision;
  baselineDigest: string;
  readonly previousHolds: Holds;
  readonly files: Readonly<Record<string, string | null>>;
  readonly unchanged: boolean;
  readonly sourceImpact: {
    source: string;
    skills: readonly string[];
    before: string | null;
    after: string | null;
  } | null;
};
export type SyncDecisionResult = {
  overrideReset: boolean;
  holdUpdated: boolean;
  decision: 'recorded' | 'queued' | 'unchanged';
  itemId: string;
};
const refused = () => new Error('Sync source, revision or item is unavailable');
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const invalidProfile = (desired: DesiredConfig, independentIntegrations = false) =>
  desired.issues.some(issue => !(independentIntegrations && issue.layer === 'base' && issue.source === INTEGRATIONS_SOURCE));
// Verify the source's exact offer before reading snapshots. Values remain inside the owner.
export const observeSyncSource = (source: SetupSource['Service'], decisions: readonly Decision[], independentIntegrations = false, knownHead?: Revision) =>
  Effect.gen(function* () {
    if (source.trusted && !(yield* source.trusted)) return yield* Effect.fail(refused());
    const head = knownHead ?? (yield* source.fetch).head;
    const offered = yield* source.load(head);
    const effective = yield* source.effective(decisions);
    const before = yield* worktreeDocuments(effective.applied.repo),
      after = yield* worktreeDocuments(offered.repo);
    if (invalidProfile(desiredOfDocuments(before), independentIntegrations) || invalidProfile(desiredOfDocuments(after), independentIntegrations))
      return yield* Effect.fail(refused());
    const changes = diffItems(itemValues(before), itemValues(after));
    const offers = source.offeredItems
      ? yield* source.offeredItems
      : [...new Set([...itemValues(before).keys(), ...itemValues(after).keys()])].map((itemId) => ({
          itemId,
          revision: head,
        }));
    if (knownHead === undefined && canonical((yield* source.fetch).head) !== canonical(head)) return yield* Effect.fail(refused());
    return { head, offered, effective, before, after, changes, offers };
  });
export const prepareSyncDecision = (
  input: SyncDecisionInput,
): Effect.Effect<PreparedSyncDecision, unknown, Fs | Processes | MachinePaths> =>
  Effect.gen(function* () {
    const { change, source } = input;
    if ((source.setupId ?? LOCAL_SETUP) !== change.setupId || !parseItemId(change.itemId))
      return yield* Effect.fail(refused());
    const independentIntegrations = input.validation === 'cli-independent-integrations' && change.setupId === LOCAL_SETUP
      && change.revision.kind === 'local' && parseItemId(change.itemId)?.kind !== 'integration';
    const observed = yield* observeSyncSource(source, input.decisions, independentIntegrations);
    const offeredItem = observed.offers.find((item) => item.itemId === change.itemId);
    // An existing local hold can be released even when both snapshots omit its item.
    const releaseLocalHold =
      typeof observed.head === 'string' && change.action === 'release' && Object.hasOwn(input.holds, change.itemId);
    const head = offeredItem?.revision ?? (releaseLocalHold ? observed.head : undefined);
    if (head === undefined) return yield* Effect.fail(refused());
    yield* source.load(head);
    const local = typeof head === 'string';
    if (
      local
        ? change.revision.kind !== 'local' ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(change.revision.commit) ||
          change.revision.commit !== head
        : change.revision.kind !== 'hosted' ||
          head.setupId !== change.setupId ||
          change.revision.number !== head.number ||
          change.revision.commitSha !== head.commitSha
    )
      return yield* Effect.fail(refused());
    const held = local
      ? Object.hasOwn(input.holds, change.itemId)
      : input.decisions.some(
          (d) =>
            d.setupId === change.setupId &&
            d.itemId === change.itemId &&
            d.decision === 'skip' &&
            d.revision === (typeof head === 'object' ? head.number : null),
        );
    const unchanged = change.action === 'release' && !held;
    if (
      !unchanged &&
      !observed.changes.some((c) => c.itemId === change.itemId) &&
      !(change.action === 'release' && held) &&
      !(input.deferComposition && (itemValues(observed.before).has(change.itemId) || itemValues(observed.after).has(change.itemId)))
    )
      return yield* Effect.fail(refused());
    if (unchanged && !itemValues(observed.before).has(change.itemId) && !itemValues(observed.after).has(change.itemId))
      return yield* Effect.fail(refused());
    if (!local && !head.items.some((c) => c.id === change.itemId)) return yield* Effect.fail(refused());
    const nextOverrides =
      change.action === 'takeTheirs' ? withoutOverride(input.overrides, change.itemId) : input.overrides;
    if (change.action === 'takeTheirs' && nextOverrides === input.overrides) return yield* Effect.fail(refused());
    const nextHolds = { ...input.holds };
    if (local && !unchanged) {
      if (change.action === 'hold') {
        const applied = observed.effective.applied.revision;
        if (typeof applied !== 'string') return yield* Effect.fail(refused());
        nextHolds[change.itemId] = input.holds[change.itemId] ?? applied;
      } else delete nextHolds[change.itemId];
    }
    const decision: Decision = {
      setupId: change.setupId,
      itemId: change.itemId,
      revision: local ? null : head.number,
      commit: local ? head : null,
      decision: change.action === 'hold' ? 'skip' : 'accept',
      decidedAt: input.now.toISOString(),
      machineId: null,
      source: 'local',
    };
    if (
      input.decisions.some(
        (d) =>
          d.setupId === change.setupId && d.itemId === change.itemId && Date.parse(d.decidedAt) > input.now.getTime(),
      )
    )
      return yield* Effect.fail(refused());
    const proposed = input.decisions.filter(
      (d) =>
        !(
          d.setupId === decision.setupId &&
          d.itemId === decision.itemId &&
          d.revision === decision.revision &&
          d.commit === decision.commit
        ),
    );
    // Composition owns source-wide pin validity. An individual hold must not create incompatible source pins.
    let nextDesired = observed.effective.effective.desired;
    if (!unchanged && !input.deferComposition) {
      const overrides = {
        value: nextOverrides,
        issues: [],
        source: join((yield* MachinePaths).stateRoot, 'overrides.json'),
      };
      const effective = yield* source.effective([...proposed, decision], { overrides, holds: nextHolds });
      nextDesired = effective.effective.desired;
      if (invalidProfile(nextDesired, independentIntegrations)) return yield* Effect.fail(refused());
    }
    const ref = parseItemId(change.itemId);
    const sourceImpact =
      ref?.kind === 'skill'
        ? {
            source: ref.source,
            skills: [
              ...new Set(
                [...observed.effective.effective.desired.skills, ...nextDesired.skills]
                  .filter((s) => s.source === ref.source)
                  .map((s) => s.name),
              ),
            ].sort(),
            before: observed.effective.effective.desired.skills.find((s) => s.source === ref.source)?.pin?.ref ?? null,
            after: nextDesired.skills.find((s) => s.source === ref.source)?.pin?.ref ?? null,
          }
        : null;
    const fs = yield* Fs,
      paths = yield* MachinePaths;
    const files = Object.fromEntries(
      yield* Effect.forEach(['overrides.json', 'state.json', 'sync.json', 'decisions.json', 'agent/setups.json'], (name) =>
        Effect.map(
          fs.readBytes(join(paths.stateRoot, name)),
          (bytes) => [name, bytes === undefined ? null : createHash('sha256').update(bytes).digest('hex')] as const,
        ),
      ),
    );
    return {
      files,
      sourceImpact,
      change,
      nextOverrides,
      previousOverrides: input.overrides,
      nextHolds,
      previousHolds: input.holds,
      decision,
      unchanged,
      baselineDigest: digest({
        files,
        change,
        overrides: input.overrides,
        holds: input.holds,
        decisions: input.decisions,
        head,
        before: observed.before,
        after: observed.after,
      }),
    };
  });
// The caller holds the common mutation lock. Checkpoints retain completed effects if a later write fails.
export const persistSyncDecision = (
  prepared: PreparedSyncDecision,
  recordDecision: (decisions: readonly Decision[]) => Effect.Effect<void, unknown>,
  observer: MutationObserver,
): Effect.Effect<SyncDecisionResult, unknown, Fs | MachinePaths | OverridesStore | SyncStore | Backups> =>
  Effect.gen(function* () {
    const result: SyncDecisionResult = {
      overrideReset: false,
      holdUpdated: false,
      decision: 'unchanged',
      itemId: prepared.change.itemId,
    };
    if (prepared.unchanged) return result;
    const paths = yield* MachinePaths,
      backups = yield* Backups,
      overrides = yield* OverridesStore,
      sync = yield* SyncStore;
    const fs = yield* Fs;
    const expected = { ...prepared.files };
    const fileDigest = (name: string) =>
      Effect.map(fs.readBytes(join(paths.stateRoot, name)), (bytes) =>
        bytes === undefined ? null : createHash('sha256').update(bytes).digest('hex'),
      );
    const guard = Effect.gen(function* () {
      for (const [name, hash] of Object.entries(expected))
        if ((yield* fileDigest(name)) !== hash) return yield* Effect.fail(refused());
    });
    yield* guard;
    if (
      canonical((yield* overrides.read).value) !== canonical(prepared.previousOverrides) ||
      canonical(yield* sync.read) !== canonical(prepared.previousHolds)
    )
      return yield* Effect.fail(refused());
    if (canonical(prepared.previousOverrides) !== canonical(prepared.nextOverrides)) {
      yield* observer.pending('sync:override');
      yield* guard;
      yield* overrides
        .write(prepared.nextOverrides, prepared.previousOverrides)
        .pipe(
          Effect.provideService(Backups, {
            ...backups,
            preserve: (...args) =>
              backups
                .preserve(...args)
                .pipe(
                  Effect.tap(() =>
                    guard.pipe(
                      Effect.mapError(
                        () =>
                          new FsFailed({ op: 'sync', path: paths.stateRoot, reason: 'choices changed during backup' }),
                      ),
                    ),
                  ),
                ),
          }),
        );
      expected['overrides.json'] = yield* fileDigest('overrides.json');
      result.overrideReset = true;
      yield* observer.committed('sync:override');
    }
    if (canonical(prepared.previousHolds) !== canonical(prepared.nextHolds)) {
      yield* observer.pending('sync:hold');
      yield* backups.preserve(join(paths.stateRoot, 'sync.json'), 'sync.json', undefined, { private: true });
      const before = yield* fs.readText(join(paths.stateRoot, 'sync.json'));
      yield* guard;
      yield* sync.write(prepared.nextHolds, { held: prepared.previousHolds, bytes: before });
      expected['sync.json'] = yield* fileDigest('sync.json');
      result.holdUpdated = true;
      yield* observer.committed('sync:hold');
    }
    yield* observer.pending('sync:decision');
    yield* guard;
    yield* recordDecision([prepared.decision]);
    result.decision = prepared.change.revision.kind === 'hosted' ? 'queued' : 'recorded';
    yield* observer.committed('sync:decision');
    return result;
  });
