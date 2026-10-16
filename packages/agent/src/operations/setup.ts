import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { Cause, Effect, Layer } from 'effect';
import {
  authorDigest, Backups, backupsForRun, canonical, DecisionsStore, Fs, inspect, MachinePaths,
  machinePaths, OverridesStore, peekMachineState, plan, selectAll, StateStore,
  type MutationObserver,
} from '@nortuscc/machine';
import {
  composeSetupChoices, desiredOfDocuments, itemIdOf, itemValues, overrideOf, parseItemId, persistSyncDecision, prepareSyncDecision,
  setupPinGroups, revisionSetupId, withoutOverride, SyncStore, validateSetupComposition, validateSetupPinChoices, worktreeDocuments,
  type Revision, type SyncDecisionChange,
} from '@nortuscc/sync';
import type { AgentHandle } from '../agent.ts';
import { AgentClock } from '../clock.ts';
import { SessionError } from '../ipc/session.ts';
import { MAX_RECORD_BYTES } from '../ipc/protocol.ts';
import { inspectSetupSource, type JobInspection } from '../job.ts';
import type { AgentServices } from '../layer.ts';
import { recordedRun } from '../apply.ts';
import { decodeOperationOutput, SETUP_TEXT_MAX_BYTES, type OperationPlan, type OperationInput, type SetupApplyChange, type SetupReview } from './index.ts';
import { parityObserver, type PreparedParityChange } from './parity.ts';

const SETUP_INSPECT_TIMEOUT = '20 seconds';
const SETUP_PREVIEW_MAX_BYTES = 65_536;
const SETUP_REVIEW_MAX_BYTES = MAX_RECORD_BYTES - 4096;
const digest = (value: unknown) => authorDigest(canonical(value))!;
const stale = () => new SessionError('UNKNOWN_PLAN', 'Setup choices changed; review and preview again');
const mapError = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return Effect.fail(error instanceof SessionError ? error : new SessionError('INSPECT_FAILED', 'Setup inputs are unavailable; review again'));
};
const select = (handle: AgentHandle, setupId: string) => Effect.gen(function* () {
  const selected = yield* (handle.selectOperationSetup?.(setupId) ?? Effect.fail(new SessionError('APP_UNAVAILABLE', 'Setup selection is unavailable')));
  if (!selected.trusted || !selected.source) return yield* Effect.fail(new SessionError('APP_UNAVAILABLE', 'Open repository trust in the app before reviewing setup changes'));
  return { ...selected, source: selected.source };
});
const revisionOf = (head: import('@nortuscc/sync').Revision): SyncDecisionChange['revision'] => typeof head === 'string'
  ? { kind: 'local', commit: head } : { kind: 'hosted', number: head.number, commitSha: head.commitSha };
const mineOf = (id: string, overrides: import('@nortuscc/profile-engine').MachineOverrides): string | undefined => {
  const ref = parseItemId(id);
  const value = ref?.kind === 'setting' ? overrides.settings?.[ref.fileId]?.[ref.key]
    : ref?.kind === 'skill' ? overrides.skills?.[ref.name] : ref?.kind === 'integration' ? overrides.integrations?.[ref.id] : undefined;
  return value === undefined ? undefined : canonical(value);
};
// Read caches retain only the verified source head. Apply always observes and revalidates afresh.
const reviewedHeads = new WeakMap<AgentHandle, Map<string, { revision: Revision; inspection: JobInspection | undefined; identity: string }>>();
const inputs = (handle: AgentHandle, setupId: string, refetch = true) => Effect.gen(function* () {
  const selected = yield* select(handle, setupId);
  const overrides = yield* (yield* OverridesStore).read;
  if (overrides.issues.length) return yield* Effect.fail(new SessionError('PROFILE_INVALID', 'Repair machine overrides before reviewing setup changes'));
  const holds = yield* (yield* SyncStore).read, decisions = yield* (yield* DecisionsStore).read;
  const inspection = yield* handle.inspection;
  const identity = digest({ account: selected.accountId, repository: selected.repository });
  const cached = reviewedHeads.get(handle)?.get(setupId);
  const revision = cached?.identity === identity && cached.inspection === inspection ? cached.revision
    : inspection?.revision && revisionSetupId(inspection.revision) === setupId ? inspection.revision : undefined;
  const observed = yield* inspectSetupSource(selected.source, decisions, { refetch, revision });
  const heads = reviewedHeads.get(handle) ?? new Map();
  heads.set(setupId, { revision: observed.head, inspection, identity });
  reviewedHeads.set(handle, heads);
  return { selected, overrides, holds, decisions, observed };
});

export const readSetupReview = (handle: AgentHandle, input: OperationInput<'setupReview'>, generation: number): Effect.Effect<SetupReview, SessionError, AgentServices> =>
  Effect.gen(function* () {
    const { selected, overrides, holds, decisions, observed } = yield* inputs(handle, input.setupId, input.refetch);
    const before = itemValues(observed.before), after = itemValues(observed.after);
    const pinGroups = setupPinGroups(observed.before, observed.after, Object.keys(holds));
    const textOf = (documents: import('@nortuscc/sync').Documents, id: string, value: string | undefined) => {
      const ref = parseItemId(id), desired = desiredOfDocuments(documents);
      const file = ref?.kind === 'file' ? desired.files.find(file => file.id === ref.fileId) : undefined;
      if (file) return documents[file.src];
      const declaration = ref?.kind === 'integration' ? desired.integrations.find(item => item.id === ref.id)?.declaration : undefined;
      return declaration?.type === 'hook' && typeof declaration.file === 'string'
        ? `${value}\n\n${declaration.file}\n${documents[declaration.file] ?? ''}` : value;
    };
    const inventory = [...new Set([...before.keys(), ...after.keys()])];
    const rowIds = new Set([...observed.changes.map(c => c.itemId), ...Object.keys(holds),
      ...inventory.filter(id => overrideOf(id, overrides.value) !== undefined
        || textOf(observed.before, id, before.get(id)) !== textOf(observed.after, id, after.get(id)))]);
    for (const group of pinGroups) if (group.itemIds.some(id => rowIds.has(id))) for (const id of group.itemIds) rowIds.add(id);
    const rows: SetupReview['rows'] = [...rowIds].sort().map(itemId => {
      const ref = parseItemId(itemId)!;
      const change = { itemId, kind: ref.kind, before: before.get(itemId), after: after.get(itemId) };
      const values = { before: textOf(observed.before, itemId, change.before), after: textOf(observed.after, itemId, change.after), mine: mineOf(itemId, overrides.value) };
      let truncated = false;
      const bounded = Object.fromEntries(Object.entries(values).flatMap(([key, value]) => {
        if (value === undefined) return [];
        if (Buffer.byteLength(value) <= SETUP_TEXT_MAX_BYTES) return [[key, value]];
        truncated = true;
        let bytes = 0, text = '';
        for (const point of value) { const size = Buffer.byteLength(point); if (bytes + size > SETUP_TEXT_MAX_BYTES) break; text += point; bytes += size; }
        return [[key, text]];
      }));
      const offer = observed.offers.find(item => item.itemId === change.itemId);
      return { itemId: change.itemId, kind: change.kind,
        change: change.before === undefined ? 'added' as const : change.after === undefined ? 'removed' as const : 'changed' as const,
        held: Object.hasOwn(holds, change.itemId) || decisions.some(d => d.setupId === input.setupId && d.itemId === change.itemId && d.decision === 'skip' && d.revision === (typeof offer?.revision === 'object' ? offer.revision.number : -1)),
        conflict: overrideOf(change.itemId, overrides.value) !== undefined, ...bounded, ...(truncated ? { truncated: true as const } : {}) };
    });
    const binding = digest({ generation, rows, pinGroups, revision: observed.head, holds, decisions, overrides, account: selected.accountId, repository: selected.repository });
    let offset = 0;
    if (input.cursor) {
      const cursor = yield* Effect.try({ try: () => JSON.parse(Buffer.from(input.cursor!, 'base64url').toString()), catch: stale });
      if (cursor.binding !== binding || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > rows.length) return yield* Effect.fail(stale());
      offset = cursor.offset;
    }
    const fresh = yield* select(handle, input.setupId);
    if (fresh.accountId !== selected.accountId || fresh.repository !== selected.repository) return yield* Effect.fail(stale());
    const page = rows.slice(offset, offset + input.limit);
    const result = () => ({ generation, setupId: input.setupId, revision: revisionOf(observed.head), rows: page, pinGroups,
      nextCursor: offset + page.length < rows.length ? Buffer.from(JSON.stringify({ binding, offset: offset + page.length })).toString('base64url') : null });
    while (Buffer.byteLength(JSON.stringify(result())) > SETUP_REVIEW_MAX_BYTES && page.length > 1) page.pop();
    if (Buffer.byteLength(JSON.stringify(result())) > SETUP_REVIEW_MAX_BYTES)
      return yield* Effect.fail(new SessionError('OVERSIZED', 'Setup review identity inventory exceeds the record limit'));
    return decodeOperationOutput('setupReview', result());
  }).pipe(Effect.timeout(SETUP_INSPECT_TIMEOUT), Effect.catchCause(mapError));

export const prepareSetupApply = (handle: AgentHandle, change: SetupApplyChange, generation: number): Effect.Effect<PreparedParityChange, SessionError, AgentServices> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<AgentServices>();
    const paths = yield* MachinePaths, fs = yield* Fs, clock = yield* AgentClock, stateStore = yield* StateStore;
    const now = yield* clock.now;
    const observe = Effect.gen(function* () {
      const input = yield* inputs(handle, change.setupId);
      if (canonical(revisionOf(input.observed.head)) !== canonical(change.revision)) return yield* Effect.fail(stale());
      const seen = new Set<string>();
      for (const choice of change.choices) {
        if (seen.has(choice.itemId)) return yield* Effect.fail(new SessionError('INVALID_REQUEST', 'Choose each setup item once'));
        seen.add(choice.itemId);
      }
      yield* Effect.try({ try: () => validateSetupPinChoices(setupPinGroups(input.observed.before, input.observed.after, Object.keys(input.holds)), change.choices),
        catch: error => new SessionError('INVALID_REQUEST', (error as Error).message) });
      const prepared = [];
      for (const choice of change.choices) {
        const offer = input.observed.offers.find(item => item.itemId === choice.itemId);
        const revision = offer ? revisionOf(offer.revision) : change.revision;
        prepared.push(yield* prepareSyncDecision({ source: input.selected.source, change: { kind: 'syncDecision', setupId: change.setupId, revision, ...choice },
          overrides: input.overrides.value, holds: input.holds, decisions: input.decisions, now, deferComposition: true }));
      }
      let nextOverrides = input.overrides.value;
      const nextHolds = { ...input.holds };
      const nextDecisions = [...input.decisions];
      for (const item of prepared) {
        if (item.unchanged) continue;
        if (item.change.action === 'takeTheirs') {
          nextOverrides = withoutOverride(nextOverrides, item.change.itemId);
        }
        if (Object.hasOwn(item.nextHolds, item.change.itemId)) nextHolds[item.change.itemId] = item.nextHolds[item.change.itemId]!;
        else delete nextHolds[item.change.itemId];
        const index = nextDecisions.findIndex(d => d.setupId === change.setupId && d.itemId === item.change.itemId);
        if (index < 0) nextDecisions.push(item.decision); else nextDecisions[index] = item.decision;
      }
      const effective = yield* input.selected.source.effective(nextDecisions, { holds: nextHolds, overrides: { ...input.overrides, value: nextOverrides } });
      if (effective.effective.desired.issues.length) return yield* Effect.fail(new SessionError('PROFILE_INVALID', 'Selected setup choices cannot be composed'));
      const accepted = nextDecisions.filter(d => d.setupId === change.setupId && d.decision === 'accept' && input.observed.offers.some(o => o.itemId === d.itemId && (typeof o.revision === 'string' ? d.commit === o.revision : d.revision === o.revision.number))).map(d => d.itemId);
      const expected = yield* Effect.try({ try: () => composeSetupChoices({ current: input.observed.before, offered: input.observed.after, accepted, holds: nextHolds }),
        catch: error => new SessionError('INVALID_REQUEST', (error as Error).message) });
      const actual = yield* worktreeDocuments(effective.effective.repo);
      yield* Effect.try({ try: () => validateSetupComposition(expected, actual), catch: error => new SessionError('INVALID_REQUEST', (error as Error).message) });
      const jobPaths = { ...paths, repo: effective.effective.repo };
      const domains = handle.operationDomains?.(jobPaths);
      if (!domains) return yield* Effect.fail(new SessionError('APP_UNAVAILABLE', 'Setup machine domains are unavailable'));
      const report = yield* inspect(effective.effective.desired, domains).pipe(Effect.provideService(StateStore, { ...stateStore, read: peekMachineState }), Effect.provideService(MachinePaths, jobPaths));
      const ids = new Set(change.choices.filter(c => c.action !== 'hold').map(c => c.itemId));
      const only = report.items.filter(item => ids.has(itemIdOf(item.key, report.desired) ?? '')).map(item => item.key);
      const planned = plan('apply', report, { ...selectAll, only }, domains);
      const files = yield* Effect.forEach(['overrides.json', 'sync.json', 'state.json', 'decisions.json', 'agent/setups.json'], name => fs.readBytes(join(paths.stateRoot, name)).pipe(Effect.map(authorDigest)));
      return { input, prepared, nextHolds, nextOverrides, nextDecisions, jobPaths, domains, report, planned,
        binding: digest({ files, desired: report.desired, rows: report.items.filter(r => only.includes(r.key)), planned, actual, account: input.selected.accountId, repository: input.selected.repository, prepared: prepared.map(p => p.baselineDigest) }) };
    }).pipe(Effect.timeout(SETUP_INSPECT_TIMEOUT));
    const first = yield* observe.pipe(Effect.provide(backupsForRun(now)));
    const writes = first.prepared.filter(p => !p.unchanged);
    const keys = [...(canonical(first.nextOverrides) !== canonical(first.input.overrides.value) ? ['sync:override'] : []),
      ...(canonical(first.nextHolds) !== canonical(first.input.holds) ? ['sync:hold'] : []), ...(writes.length ? ['sync:decision'] : [])];
    const publicPlan: OperationPlan = { kind: 'operation' as const, steps: [
      ...keys.map(key => ({ key, domain: 'sync' as const, action: 'save-decision' as const, summary: 'Back up and save the reviewed setup choices', touches: change.choices.map(c => c.itemId), interruptible: false })),
      ...first.planned.steps.map(step => ({ ...step, summary: 'Apply the selected setup item using its existing owner' })),
    ], skipped: first.planned.skipped };
    const acceptance = { kind: 'setupApply' as const, generation: String(generation), baselineDigest: first.binding, planDigest: digest(publicPlan), plannedKeys: publicPlan.steps.map(s => s.key) };
    const preview = yield* Effect.try({ try: () => decodeOperationOutput('previewChange', { planId: randomUUID(), scope: { kind: 'machine' }, generation: String(generation), change, plan: publicPlan, nextActions: [],
      actionEffects: ['Save every reviewed choice and apply the selected machine plan in this run', 'Machine overrides stay unless takeTheirs explicitly resets that item after a backup'] }), catch: () => new SessionError('OVERSIZED', 'Setup preview exceeds supported limits') });
    if (Buffer.byteLength(JSON.stringify(preview)) > SETUP_PREVIEW_MAX_BYTES) return yield* Effect.fail(new SessionError('OVERSIZED', 'Setup preview exceeds supported limits'));
    return { preview, acceptance,
      revalidate: Effect.gen(function* () { if ((yield* observe).binding !== first.binding) return yield* Effect.fail(stale()); }).pipe(Effect.provide(backupsForRun(now)), Effect.provideContext(context), Effect.catchCause(() => Effect.fail(stale()))),
      execute: (lifecycle, signal) => Effect.gen(function* () {
        const at = yield* clock.now;
        yield* Effect.gen(function* () {
          const backups = yield* Backups, observed = yield* parityObserver(lifecycle, acceptance);
          const checkpoint = () => Effect.gen(function* () { const folder = yield* backups.dir; yield* observed.checkpoint({ backupIds: folder ? [basename(folder)] : observed.evidence().backupIds }); });
          const observer: MutationObserver = { pending: key => Effect.gen(function* () {
            if (signal.aborted) return yield* Effect.fail(new SessionError('INTERNAL', 'Setup apply cancelled'));
            yield* observed.observer.pending(key);
            const index = publicPlan.steps.findIndex(s => s.key === key);
            yield* lifecycle.progress({ type: 'started', index, total: publicPlan.steps.length, step: publicPlan.steps[index]! });
          }), committed: key => Effect.gen(function* () {
            yield* observed.observer.committed(key); yield* checkpoint();
            yield* lifecycle.progress({ type: 'finished', index: publicPlan.steps.findIndex(s => s.key === key), total: publicPlan.steps.length, key, outcome: 'ok', note: 'Setup choice saved' });
          }) };
          if (writes.length) yield* persistSyncDecision({ ...writes[0]!, nextOverrides: first.nextOverrides, nextHolds: first.nextHolds },
            () => Effect.gen(function* () {
              yield* backups.preserve(join(paths.stateRoot, 'decisions.json'), 'decisions.json', undefined, { private: true });
              yield* handle.mutationBodies.decideAll(writes.map(p => p.decision), lifecycle.actor);
            }), observer).pipe(Effect.onExit(() => checkpoint()));
          const ran = yield* recordedRun(first.planned, first.report, first.domains, { runId: lifecycle.runId, actor: lifecycle.actor, automatic: false, signal,
            operation: { operation: 'applyChange', scope: { kind: 'machine' }, requestId: lifecycle.requestId },
            checkpoint: event => Effect.gen(function* () {
              if (event.type === 'started') yield* observed.observer.pending(event.step.key);
              if (event.type === 'finished' && event.outcome === 'ok') yield* observed.observer.committed(event.key);
              yield* checkpoint();
              const index = event.index + keys.length;
              yield* lifecycle.progress(event.type === 'started' ? { ...event, index, total: publicPlan.steps.length, step: publicPlan.steps[index]! }
                : { ...event, index, total: publicPlan.steps.length, note: event.outcome === 'ok' ? 'Machine effect observed' : 'Machine effect incomplete; inspect backups' });
            }),
          });
          if (ran.steps.some(step => step.outcome !== 'ok')) return yield* Effect.fail(new SessionError('INTERNAL', 'Setup machine plan stopped; inspect recorded effects'));
        }).pipe(Effect.provide(backupsForRun(at).pipe(Layer.provideMerge(machinePaths(first.jobPaths)))));
      }).pipe(Effect.provideContext(context), Effect.catchCause(mapError)),
    } satisfies PreparedParityChange;
  }).pipe(Effect.catchCause(mapError));
