import { randomUUID } from 'node:crypto';
import { Cause, Effect } from 'effect';
import { authorDigest, canonical, HistoryStore, inspectBackupFolders, planBackupPrune, executeBackupPrune } from '@nortuscc/machine';
import { AgentClock } from '../clock.ts';
import type { RunLifecycle } from '../runs.ts';
import type { AgentServices } from '../layer.ts';
import { SessionError } from '../ipc/session.ts';
import { decodeOperationInput, decodeOperationOutput, type OperationInput, type OperationOutput, type OperationPlan } from './index.ts';
import { parityObserver, type PreparedParityChange } from './parity.ts';

const digest = (value: unknown) => authorDigest(canonical(value))!;
const stale = () => new SessionError('UNKNOWN_PLAN', 'Backup inventory changed; preview again');
const failed = () => new SessionError('INTERNAL', 'Backup retention stopped; inspect History and the recorded run before retrying');

export const readBackupOperation = (
  input: OperationInput<'listBackups'>, generation: number,
): Effect.Effect<OperationOutput<'listBackups'>, SessionError, AgentServices> => Effect.gen(function* () {
  const args = yield* Effect.try({try: () => decodeOperationInput('listBackups', input), catch: () => new SessionError('INVALID_REQUEST', 'Invalid backup inventory request')});
  if (args.scope.kind !== 'machine') return yield* Effect.fail(new SessionError('UNSUPPORTED_SCOPE', 'Backup operations support machine scope only'));
  const folders = yield* inspectBackupFolders();
  const binding = digest({ folders, generation });
  let offset = 0;
  if (args.cursor) {
    const cursor = yield* Effect.try({
      try: () => JSON.parse(Buffer.from(args.cursor!, 'base64url').toString('utf8')), catch: stale,
    });
    if (!cursor || Object.keys(cursor).sort().join() !== 'binding,offset' || cursor.binding !== binding
      || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > folders.length) {
      return yield* Effect.fail(stale());
    }
    offset = cursor.offset;
  }
  const page = folders.slice(offset, offset + args.limit);
  const output = { generation: String(generation), folders: page,
    nextCursor: offset + page.length < folders.length
      ? Buffer.from(JSON.stringify({ binding, offset: offset + page.length })).toString('base64url') : null,
  };
  if (digest(yield* inspectBackupFolders()) !== digest(folders)) return yield* Effect.fail(stale());
  return yield* Effect.try({ try: () => decodeOperationOutput('listBackups', output), catch: failed });
}).pipe(Effect.catchCause(cause => {
  const error = Cause.squash(cause);
  return Effect.fail(error instanceof SessionError ? error : new SessionError('INSPECT_FAILED', 'Backup inventory is unavailable'));
}));

export const prepareBackupOperation = (
  generation: number,
): Effect.Effect<PreparedParityChange, SessionError, AgentServices> => Effect.gen(function* () {
  const context = yield* Effect.context<AgentServices>();
  const retention = yield* planBackupPrune(yield* (yield* AgentClock).now);
  const steps: OperationPlan['steps'] = retention.folderIds.map(id => ({
    key: id, domain: 'backups', action: 'prune-backups', summary: `Remove expired backup ${id}`,
    touches: [id], interruptible: false,
  }));
  const plan: OperationPlan = { kind: 'operation', steps, skipped: [] };
  const acceptance = { kind: 'pruneBackups' as const, generation: String(generation),
    baselineDigest: retention.inventoryDigest, planDigest: digest(plan), plannedKeys: retention.folderIds, retention,
  };
  const preview = yield* Effect.try({
    try: () => decodeOperationOutput('previewChange', { planId: randomUUID(), scope: { kind: 'machine' },
      generation: String(generation), change: { kind: 'pruneBackups' }, plan, retention, nextActions: [],
      actionEffects: [`Remove exactly ${retention.folderIds.length} expired backup folders without backing them up. Keep newest 20, folders at most 90 days old and the latest History reference.${retention.limited ? ' This is a limited batch; preview again for further cleanup.' : ''}`],
    }), catch: failed,
  });
  const revalidate = Effect.gen(function* () {
    if (canonical(yield* planBackupPrune(new Date(retention.evaluatedAt))) !== canonical(retention)) {
      return yield* Effect.fail(stale());
    }
  }).pipe(Effect.provideContext(context), Effect.catchCause(() => Effect.fail(stale())));
  return { preview, acceptance, revalidate,
    execute: (lifecycle: RunLifecycle, signal: AbortSignal) => Effect.gen(function* () {
      const observed = yield* parityObserver(lifecycle, acceptance);
      const history = yield* HistoryStore;
      let index = 0;
      const result = yield* executeBackupPrune(retention, lifecycle.actor, {
        pending: id => Effect.gen(function* () {
          if (signal.aborted) return yield* Effect.fail(failed());
          yield* lifecycle.progress({ type: 'started', index, total: steps.length, step: steps[index]! });
          yield* observed.observer.pending(id);
        }),
        committed: id => Effect.gen(function* () {
          yield* observed.observer.committed(id);
          yield* lifecycle.progress({ type: 'finished', index: index++, total: steps.length, key: id,
            outcome: 'ok', note: 'Backup removal observed',
          });
        }),
      }).pipe(Effect.provideService(HistoryStore, { ...history, append: event => event.kind === 'backups-pruned' ? history.append({ ...event,
        operation: 'applyChange', scope: { kind: 'machine' }, requestId: lifecycle.requestId, runId: lifecycle.runId,
      }) : history.append(event) }));
      if (result.failedId) return yield* Effect.fail(failed());
    }).pipe(Effect.provideContext(context), Effect.catchCause(() => Effect.fail(failed()))),
  };
}).pipe(Effect.catchCause(() => Effect.fail(failed())));
