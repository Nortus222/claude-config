import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { Cause, Effect, Exit } from 'effect';
import {
  authorDigest,
  Backups,
  backupsForRun,
  canonical,
  DecisionsStore,
  Fs,
  MachinePaths,
  OverridesStore,
} from '@nortuscc/machine';
import {
  observeSyncSource,
  overrideOf,
  parseItemId,
  persistSyncDecision,
  prepareSyncDecision,
  SyncStore,
  type SyncDecisionChange,
} from '@nortuscc/sync';
import type { AgentHandle } from '../agent.ts';
import { AgentClock } from '../clock.ts';
import { SessionError } from '../ipc/session.ts';
import type { AgentServices } from '../layer.ts';
import { decodeOperationOutput, type OperationInput, type OperationOutput, type OperationPlan } from './index.ts';
import { parityObserver, type PreparedParityChange } from './parity.ts';
import { safeOwnerString } from './safety.ts';
const digest = (v: unknown) => authorDigest(canonical(v))!;
const stale = () =>
  new SessionError('UNKNOWN_PLAN', 'Sync source, trust, account or choices changed; preview again');
const failed = () =>
  new SessionError(
    'INTERNAL',
    'The sync decision did not finish; check for new changes and preview again. Backups are in ~/.config/nortuscc/backups',
  );
const select = (handle: AgentHandle, id: string) =>
  handle.selectOperationSetup?.(id) ??
  Effect.fail(new SessionError('APP_UNAVAILABLE', 'Setup selection is unavailable'));
const safeSetup = (value: { setupId: string; repository: string | null; accountId: string | null }) =>
  [value.setupId, value.repository, value.accountId].every((s) => s === null || safeOwnerString(s));
type ReadName = 'inspectSetups' | 'incomingChanges' | 'prepareTrustRequest';
export const readSyncOperation = <N extends ReadName>(
  handle: AgentHandle,
  name: N,
  input: OperationInput<N>,
  generation: number,
): Effect.Effect<OperationOutput<N>, SessionError, AgentServices> =>
  Effect.gen(function* () {
    const page = (items: readonly unknown[], binding: unknown, args: { cursor?: string; limit: number }) =>
      Effect.gen(function* () {
        const bound = digest({ generation, name, binding, items });
        let offset = 0;
        if (args.cursor) {
          const cursor = yield* Effect.try({
            try: () => JSON.parse(Buffer.from(args.cursor!, 'base64url').toString('utf8')),
            catch: stale,
          });
          if (
            cursor.binding !== bound ||
            !Number.isSafeInteger(cursor.offset) ||
            cursor.offset < 0 ||
            cursor.offset > items.length ||
            Object.keys(cursor).sort().join() !== 'binding,offset'
          )
            return yield* Effect.fail(stale());
          offset = cursor.offset;
        }
        const selected = items.slice(offset, offset + args.limit);
        return {
          items: selected,
          nextCursor:
            offset + selected.length < items.length
              ? Buffer.from(JSON.stringify({ binding: bound, offset: offset + selected.length })).toString('base64url')
              : null,
        };
      });
    let output: unknown;
    if (name === 'inspectSetups') {
      const ids = yield* (handle.operationSetupIds ?? Effect.succeed(['local']));
      if (ids.length > 1000)
        return yield* Effect.fail(new SessionError('OVERSIZED', 'Setup inventory exceeds supported bounds'));
      const items = [];
      for (const id of ids) {
        const selected = yield* select(handle, id);
        if (!safeSetup(selected))
          return yield* Effect.fail(new SessionError('OVERSIZED', 'Setup identity is unavailable'));
        items.push({
          setupId: id,
          trusted: selected.trusted,
          repository: selected.repository,
          accountId: selected.accountId,
        });
      }
      output = {
        generation: String(generation),
        ...(yield* page(items, ids, input as OperationInput<'inspectSetups'>)),
      };
    } else {
      const args = input as OperationInput<'incomingChanges'>;
      const selected = yield* select(handle, args.setupId);
      if (!safeSetup(selected))
        return yield* Effect.fail(new SessionError('OVERSIZED', 'Setup identity is unavailable'));
      if (name === 'prepareTrustRequest')
        output = {
          generation: String(generation),
          setupId: args.setupId,
          repository: selected.repository,
          trusted: selected.trusted,
          action: 'open-app-repository-trust',
        };
      else {
        if (!selected.trusted || !selected.source)
          return yield* Effect.fail(
            new SessionError('APP_UNAVAILABLE', 'Open repository trust in the app before inspecting incoming changes'),
          );
        const decisions = yield* (yield* DecisionsStore).read,
          holds = yield* (yield* SyncStore).read,
          overrides = yield* (yield* OverridesStore).read;
        if (overrides.issues.length)
          return yield* Effect.fail(
            new SessionError('PROFILE_INVALID', 'Repair machine overrides before inspecting incoming changes'),
          );
        const observed = yield* observeSyncSource(selected.source, decisions).pipe(Effect.timeout('20 seconds'));
        const revision =
          typeof observed.head === 'string'
            ? { kind: 'local' as const, commit: observed.head }
            : { kind: 'hosted' as const, number: observed.head.number, commitSha: observed.head.commitSha };
        const rows = observed.changes.map((c) => {
          const offer = observed.offers.find((item) => item.itemId === c.itemId);
          if (!offer) throw new Error('Offered item identity is unavailable');
          const revision =
            typeof offer.revision === 'string'
              ? { kind: 'local' as const, commit: offer.revision }
              : { kind: 'hosted' as const, number: offer.revision.number, commitSha: offer.revision.commitSha };
          return {
            itemId: c.itemId,
            revision,
            kind: c.kind,
            change: c.before === undefined ? 'added' : c.after === undefined ? 'removed' : 'changed',
            held:
              revision.kind === 'local'
                ? Object.hasOwn(holds, c.itemId)
                : decisions.some(
                    (d) =>
                      d.setupId === args.setupId &&
                      d.itemId === c.itemId &&
                      d.revision === revision.number &&
                      d.decision === 'skip',
                  ),
            conflict: overrideOf(c.itemId, overrides.value) !== undefined,
          };
        });
        // A local hold still needs a release action when it no longer produces a delta.
        if (revision.kind === 'local') {
          for (const itemId of Object.keys(holds)) {
            if (rows.some((row) => row.itemId === itemId)) continue;
            const ref = parseItemId(itemId);
            if (!ref) throw new Error('Held item identity is unavailable');
            rows.push({
              itemId,
              revision,
              kind: ref.kind,
              change: 'unchanged',
              held: true,
              conflict: overrideOf(itemId, overrides.value) !== undefined,
            });
          }
          rows.sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
        }
        if (rows.some((r) => !safeOwnerString(r.itemId)))
          return yield* Effect.fail(new SessionError('OVERSIZED', 'Incoming item identity is unavailable'));
        const fresh = yield* select(handle, args.setupId);
        if (canonical({ ...fresh, source: undefined }) !== canonical({ ...selected, source: undefined }))
          return yield* Effect.fail(stale());
        output = {
          generation: String(generation),
          setupId: args.setupId,
          revision,
          ...(yield* page(
            rows,
            {
              setup: selected.setupId,
              account: selected.accountId,
              repository: selected.repository,
              revision,
              holds,
              decisions,
              overrides: overrides.value,
            },
            args,
          )),
        };
      }
    }
    if (Buffer.byteLength(JSON.stringify(output)) > 65536)
      return yield* Effect.fail(new SessionError('OVERSIZED', 'Sync result exceeds supported bounds'));
    return yield* Effect.try({
      try: () => decodeOperationOutput(name, output),
      catch: () => new SessionError('OVERSIZED', 'Sync result contains unsupported owner identities'),
    });
  }).pipe(
    Effect.timeout('20 seconds'),
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause);
      return Effect.fail(
        error instanceof SessionError ? error : new SessionError('INSPECT_FAILED', 'Sync inputs are unavailable'),
      );
    }),
  );

export const prepareSyncOperation = (
  handle: AgentHandle,
  change: SyncDecisionChange,
  generation: number,
): Effect.Effect<PreparedParityChange, SessionError, AgentServices> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<AgentServices>();
    const fs = yield* Fs,
      paths = yield* MachinePaths,
      clock = yield* AgentClock;
    const now = yield* clock.now;
    const observe = Effect.gen(function* () {
      const selected = yield* select(handle, change.setupId);
      if (!selected.trusted || !selected.source)
        return yield* Effect.fail(
          new SessionError('APP_UNAVAILABLE', 'Open repository trust in the app before deciding'),
        );
      if (!safeSetup(selected) || !safeOwnerString(change.itemId))
        return yield* Effect.fail(new SessionError('OVERSIZED', 'Sync identity is unavailable'));
      const overrides = yield* (yield* OverridesStore).read;
      if (overrides.issues.length)
        return yield* Effect.fail(new SessionError('PROFILE_INVALID', 'Repair machine overrides before deciding'));
      const holds = yield* (yield* SyncStore).read,
        decisions = yield* (yield* DecisionsStore).read;
      const prepared = yield* prepareSyncDecision({
        source: selected.source,
        change,
        overrides: overrides.value,
        holds,
        decisions,
        now,
      }).pipe(Effect.timeout('20 seconds'));
      const files = yield* Effect.forEach(['overrides.json', 'sync.json', 'decisions.json', 'agent/setups.json'], (p) =>
        Effect.map(fs.readBytes(join(paths.stateRoot, p)), authorDigest),
      );
      return {
        prepared,
        binding: digest({
          baseline: prepared.baselineDigest,
          files,
          account: selected.accountId,
          repository: selected.repository,
          trusted: selected.trusted,
        }),
      };
    }).pipe(Effect.timeout('20 seconds'));
    const first = yield* observe;
    const prepared = first.prepared;
    const keys = prepared.unchanged
      ? []
      : [
          ...(canonical(prepared.nextOverrides) !== canonical(prepared.previousOverrides) ? ['sync:override'] : []),
          ...(canonical(prepared.nextHolds) !== canonical(prepared.previousHolds) ? ['sync:hold'] : []),
          'sync:decision',
        ];
    if (
      prepared.sourceImpact &&
      [
        prepared.sourceImpact.source,
        ...prepared.sourceImpact.skills,
        prepared.sourceImpact.before,
        prepared.sourceImpact.after,
      ].some((s) => s !== null && !safeOwnerString(s))
    )
      return yield* Effect.fail(new SessionError('OVERSIZED', 'Source pin impact is unavailable'));
    const plan: OperationPlan = {
      kind: 'operation',
      steps: keys.map((key) => ({
        key,
        domain: 'sync',
        action: 'save-decision',
        summary:
          key === 'sync:override'
            ? 'Back up and reset the selected machine override'
            : key === 'sync:hold'
              ? 'Back up and update the selected hold'
              : 'Save the exact offered item decision',
        touches: [change.itemId],
        interruptible: false,
      })),
      skipped: [],
    };
    const acceptance = {
      kind: 'syncDecision' as const,
      generation: String(generation),
      baselineDigest: first.binding,
      planDigest: digest(plan),
      plannedKeys: keys,
    };
    const preview = yield* Effect.try({
      try: () =>
        decodeOperationOutput('previewChange', {
          planId: randomUUID(),
          scope: { kind: 'machine' },
          generation: String(generation),
          change,
          sourceImpact: prepared.sourceImpact,
          plan,
          nextActions: [],
          actionEffects: [
            prepared.unchanged
              ? 'This item is not held; release makes no change'
              : 'Save this item choice; unrelated choices remain',
            'Acceptance permits policy-dependent scheduling after release; code-running additions remain classified and held',
            change.revision.kind === 'hosted'
              ? 'Hosted decisions are queued locally; server persistence is not confirmed'
              : 'The exact local full commit is recorded',
            'Holding a skill retains its source-wide pin; other skills from that source can be affected',
          ],
        }),
      catch: () => new SessionError('OVERSIZED', 'Sync preview exceeds supported bounds'),
    });
    if (Buffer.byteLength(JSON.stringify(preview)) > 65536)
      return yield* Effect.fail(new SessionError('OVERSIZED', 'Sync preview exceeds supported bounds'));
    const revalidate = Effect.gen(function* () {
      if ((yield* observe).binding !== first.binding) return yield* Effect.fail(stale());
    }).pipe(
      Effect.provideContext(context),
      Effect.catchCause(() => Effect.fail(stale())),
    );
    return {
      preview,
      acceptance,
      revalidate,
      afterRelease: 'decide' as const,
      execute: (lifecycle: import('../runs.ts').RunLifecycle, signal: AbortSignal) =>
        Effect.flatMap(clock.now, (at) =>
          Effect.gen(function* () {
            const observed = yield* parityObserver(lifecycle, acceptance),
              backups = yield* Backups;
            const checkpoint = () =>
              Effect.gen(function* () {
                const folder = yield* backups.dir;
                yield* observed.checkpoint({ backupIds: folder ? [basename(folder)] : [] });
              });
            const observer = {
              pending: (key: string) =>
                Effect.gen(function* () {
                  if (signal.aborted) return yield* Effect.fail(failed());
                  const index = keys.indexOf(key);
                  yield* lifecycle.progress({ type: 'started', index, total: keys.length, step: plan.steps[index]! });
                  yield* observed.observer.pending(key);
                }),
              committed: (key: string) =>
                Effect.gen(function* () {
                  const folder = yield* backups.dir;
                  const prior = observed.evidence();
                  yield* observed.checkpoint({
                    state: 'partial',
                    committedKeys: [...new Set([...prior.committedKeys, key])],
                    remainingKeys: prior.remainingKeys.filter((k) => k !== key),
                    backupIds: folder ? [basename(folder)] : prior.backupIds,
                  });
                  yield* lifecycle.progress({
                    type: 'finished',
                    index: keys.indexOf(key),
                    total: keys.length,
                    key,
                    outcome: 'ok',
                    note:
                      key === 'sync:decision' && change.revision.kind === 'hosted'
                        ? 'Decision queued locally'
                        : 'Sync effect observed',
                  });
                }),
            };
            const result = yield* Effect.exit(persistSyncDecision(
              prepared,
              (decisions) => handle.mutationBodies.decideAll(decisions, lifecycle.actor),
              observer,
            ));
            yield* checkpoint();
            if(Exit.isFailure(result))return yield* Effect.failCause(result.cause);
          }).pipe(Effect.provide(backupsForRun(at)), Effect.provideContext(context), Effect.mapError(failed)),
        ),
    };
  }).pipe(
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause);
      return Effect.fail(
        error instanceof SessionError
          ? error
          : new SessionError('APP_UNAVAILABLE', 'Sync inputs are unavailable; preview again'),
      );
    }),
  );
