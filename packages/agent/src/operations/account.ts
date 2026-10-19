import { randomUUID } from 'node:crypto';
import { Cause, Effect } from 'effect';
import { authorDigest, canonical } from '@nortuscc/machine';
import { DeviceStartResponseSchema, decodeHosted } from '@nortuscc/hosted-protocol';
import type { AgentHandle } from '../agent.ts';
import { AgentClock } from '../clock.ts';
import { disabledHostedState } from '../hosted.ts';
import { AgentStateStore } from '../state.ts';
import type { AgentServices } from '../layer.ts';
import type { RunLifecycle } from '../runs.ts';
import { SessionError } from '../ipc/session.ts';
import {
  decodeOperationInput, decodeOperationOutput, SignInRunResultSchema, type OperationChange, type OperationInput,
  type OperationOutput, type OperationPlan, type ParityRunEvidence,
} from './index.ts';
import { parityObserver, type PreparedParityChange } from './parity.ts';
import { safeOwnerString } from './safety.ts';

export type AccountChange = Extract<OperationChange, {
  kind: 'setPolicy' | 'resume' | 'signIn' | 'signOut' | 'syncAccount' | 'patchMachineMetadata';
}>;
export const isAccountChange = (change: OperationChange): change is AccountChange =>
  ['setPolicy', 'resume', 'signIn', 'signOut', 'syncAccount', 'patchMachineMetadata'].includes(change.kind);
const digest = (value: unknown) => authorDigest(canonical(value))!;
const stale = () => new SessionError('UNKNOWN_PLAN', 'Account, machine metadata or policy changed; preview again');
const unavailable = () => new SessionError('APP_UNAVAILABLE', 'Configure the hosted account connection in the app before this operation');
const failed = () => new SessionError('INTERNAL', 'The account change did not finish; reload the account and preview again');
const unsafeObservation = () => new SessionError('OVERSIZED', 'Account observation contains unsupported owner data');
const safe = (value: unknown): boolean => {
  if (typeof value === 'string') return !value.includes('nmt_') && safeOwnerString(value);
  if (Array.isArray(value)) return value.every(safe);
  if (value !== null && typeof value === 'object') return Object.values(value).every(safe);
  return true;
};
const safeFailure = (cause: Cause.Cause<unknown>, fallback: () => SessionError) => {
  const error = Cause.squash(cause);
  return Effect.fail(error instanceof SessionError ? error : fallback());
};

export const readAccountOperation = <N extends 'agentStatus' | 'accountState'>(
  handle: AgentHandle, name: N, input: OperationInput<N>, generation: number,
): Effect.Effect<OperationOutput<N>, SessionError, AgentServices> => Effect.gen(function* () {
  const args = yield* Effect.try({
    try: () => decodeOperationInput(name, input),
    catch: () => new SessionError('INVALID_REQUEST', 'Invalid account read'),
  });
  if (args.scope.kind !== 'machine')
    return yield* Effect.fail(new SessionError('UNSUPPORTED_SCOPE', 'Account operations support machine scope only'));
  const hosted = yield* (handle.hosted?.state ?? Effect.succeed(disabledHostedState));
  let items: readonly unknown[];
  if (name === 'agentStatus') {
    const local = yield* (yield* AgentStateStore).read;
    const status = yield* handle.status;
    if (args.section === 'status') {
      items = [{ policy: local.policy, paused: local.paused !== null, trusted: status?.trusted ?? false, error: status?.error ?? null }];
    } else if (args.section === 'pending') {
      if ((status?.pending.length ?? 0) > 10000) return yield* Effect.fail(unsafeObservation());
      items = (status?.pending ?? []).map(p => ({ key: p.key, itemId: p.itemId, verdict: p.verdict.kind }));
    } else {
      items = args.section === 'drift' ? status?.drift ?? [] : status?.conflicts ?? [];
    }
  } else if (args.section === 'account') {
    items = [{ accountId: hosted.accountId, login: hosted.login, machineId: hosted.machineId,
      auth: hosted.auth, recovered: hosted.recovered, signingIn: hosted.signingIn,
      lastSyncAt: hosted.lastSyncAt, retryAt: hosted.retryAt, error: hosted.error === null ? null : 'hosted-unavailable' }];
  } else if (args.section === 'setups') {
    if (hosted.setups.length > 10000) return yield* Effect.fail(unsafeObservation());
    items = hosted.setups.map(s => ({ setupId: s.setupId, name: s.name, repoUrl: s.repoUrl,
      profile: s.profile, owned: s.owned, latestRevision: s.latestRevision,
      ...(s.closed === undefined ? {} : { closed: s.closed }) }));
  } else {
    items = [{ effective: hosted.machine, confirmed: hosted.confirmedMachine ?? null, persistence: hosted.machinePersistence ?? 'unknown' }];
  }
  if (items.length > 10000 || !safe(items)) return yield* Effect.fail(unsafeObservation());
  const binding = digest({ name, section: args.section, generation, items, account: hosted.accountId });
  let offset = 0;
  if (args.cursor) {
    const cursor = yield* Effect.try({
      try: () => JSON.parse(Buffer.from(args.cursor!, 'base64url').toString('utf8')), catch: stale,
    });
    if (cursor === null || typeof cursor !== 'object' || cursor.binding !== binding
      || Object.keys(cursor).sort().join() !== 'binding,offset' || !Number.isSafeInteger(cursor.offset)
      || cursor.offset < 0 || cursor.offset > items.length) return yield* Effect.fail(stale());
    offset = cursor.offset;
  }
  const page = items.slice(offset, offset + args.limit);
  const output = { generation: String(generation), section: args.section, items: page,
    nextCursor: offset + page.length < items.length
      ? Buffer.from(JSON.stringify({ binding, offset: offset + page.length })).toString('base64url') : null,
    ...(name === 'accountState' ? { enabled: hosted.enabled } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(output)) > 65536)
    return yield* Effect.fail(new SessionError('OVERSIZED', 'Account observation exceeds supported bounds'));
  return yield* Effect.try({ try: () => decodeOperationOutput(name, output), catch: unsafeObservation });
}).pipe(Effect.catchCause(cause => safeFailure(cause, () => new SessionError('INSPECT_FAILED', 'Account observation is unavailable'))));

const actions = {
  setPolicy: 'set-policy', resume: 'resume', signIn: 'sign-in', signOut: 'sign-out',
  syncAccount: 'sync-account', patchMachineMetadata: 'patch-machine',
} as const;
const effects = {
  setPolicy: 'Manual requires explicit application; notify reports changes; auto-apply applies accepted inert changes while code-running items remain held',
  resume: 'Clear an existing failure pause without changing policy',
  signIn: 'Start device authorization; complete it through the existing browser flow. Initiation does not mean authenticated. The display challenge expires within 15 minutes',
  signOut: 'Sign out using the existing account and credential owner',
  syncAccount: 'Run existing account sync; afterwards reload to see synced values and any queued writes',
  patchMachineMetadata: 'Queue machine metadata locally; server persistence is not yet confirmed',
};

// Calls only under-lock bodies; the session schedules follow-up work after releasing locks.
export const prepareAccountOperation = (
  handle: AgentHandle, change: AccountChange, generation: number,
): Effect.Effect<PreparedParityChange, SessionError, AgentServices> => Effect.gen(function* () {
  const context = yield* Effect.context<AgentServices>();
  const state = yield* AgentStateStore, clock = yield* AgentClock;
  const local = change.kind === 'setPolicy' || change.kind === 'resume';
  if (!local && !handle.mutationBodies.hosted) return yield* Effect.fail(unavailable());
  if (!safe(change)) return yield* Effect.fail(new SessionError('INVALID_REQUEST', 'Account metadata contains unsupported values'));
  const observe = Effect.gen(function* () {
    return { local: yield* state.read, hosted: yield* (handle.hosted?.state ?? Effect.succeed(disabledHostedState)) };
  });
  const first = yield* observe;
  if (!local && (!first.hosted.enabled || first.hosted.error === 'invalid_url')) return yield* Effect.fail(unavailable());
  if ((change.kind === 'patchMachineMetadata' || change.kind === 'syncAccount') && first.hosted.auth !== 'signed-in')
    return yield* Effect.fail(new SessionError('APP_UNAVAILABLE', 'Sign in through the app before changing or syncing hosted machine metadata'));
  const key = `account:${change.kind}`;
  const step = { key, summary: effects[change.kind], touches: [key], interruptible: false,
    ...(local ? { domain: 'agent' as const, action: actions[change.kind] }
      : { domain: 'account' as const, action: actions[change.kind] }),
  } as OperationPlan['steps'][number];
  const plan: OperationPlan = { kind: 'operation', steps: [step], skipped: [] };
  const acceptance = { kind: change.kind, generation: String(generation), baselineDigest: digest(first),
    planDigest: digest(plan), plannedKeys: [key] };
  const preview = yield* Effect.try({
    try: () => decodeOperationOutput('previewChange', { planId: randomUUID(), scope: { kind: 'machine' },
      generation: String(generation), change, plan, nextActions: [], actionEffects: [effects[change.kind]] }),
    catch: () => new SessionError('OVERSIZED', 'Account preview exceeds supported bounds'),
  });
  const revalidate = Effect.gen(function* () {
    if (digest(yield* observe) !== acceptance.baselineDigest) return yield* Effect.fail(stale());
  }).pipe(Effect.provideContext(context), Effect.catchCause(() => Effect.fail(stale())));
  return {
    preview, acceptance, revalidate,
    ...(change.kind === 'setPolicy' || change.kind === 'patchMachineMetadata' ? { afterRelease: 'policy' as const }
      : change.kind === 'resume' ? { afterRelease: 'resume' as const }
      : change.kind === 'syncAccount' ? { afterRelease: 'inspect' as const } : {}),
    execute: (lifecycle: RunLifecycle, signal: AbortSignal) => Effect.gen(function* () {
      const observed = yield* parityObserver(lifecycle, acceptance);
      if (signal.aborted) return yield* Effect.fail(failed());
      yield* lifecycle.progress({ type: 'started', index: 0, total: 1, step });
      yield* observed.observer.pending(key);
      let extra: Partial<ParityRunEvidence> = {};
      const bodies = handle.mutationBodies;
      switch (change.kind) {
        case 'setPolicy':
          yield* bodies.setPolicy(change.policy, lifecycle.actor);
          if (first.hosted.accountId !== null) extra = { metadata: 'locally-queued' };
          break;
        case 'resume':
          extra = { resumed: yield* bodies.resume(lifecycle.actor) };
          break;
        case 'signIn': {
          const at = (yield* clock.now).getTime();
          const started = yield* bodies.hosted!.signIn(change.name, change.reportStatus);
          const flow = yield* (handle.signInFlow ?? Effect.succeed(null));
          if (flow === null) return yield* Effect.fail(failed());
          yield* lifecycle.bindSignInFlow(flow);
          const challenge = yield* Effect.try({
            try: () => decodeHosted(DeviceStartResponseSchema, { pendingId: 'display', ...started }), catch: failed,
          });
          const expiresAt = new Date(at + Math.min(challenge.expiresIn * 1000, 900000)).toISOString();
          const signIn = yield* Effect.try({
            try: () => decodeHosted(SignInRunResultSchema, { kind: 'signIn', state: 'awaiting-user', userCode: challenge.userCode,
              verificationUri: challenge.verificationUri, expiresAt }), catch: failed,
          });
          extra = { signIn };
          break;
        }
        case 'signOut':
          yield* bodies.hosted!.signOut();
          break;
        case 'syncAccount': {
          const synced = yield* bodies.hosted!.sync();
          // A completed sync does not prove that an earlier patch survived the owner's invalid-entry drop.
          if (synced.machinePersistence === 'locally-queued') extra = { metadata: 'locally-queued' };
          break;
        }
        case 'patchMachineMetadata':
          yield* bodies.hosted!.machine(change.patch, lifecycle.actor);
          extra = { metadata: 'locally-queued' };
          break;
      }
      yield* observed.checkpoint({ ...extra, state: 'partial', committedKeys: [key], remainingKeys: [] });
      yield* lifecycle.progress({ type: 'finished', index: 0, total: 1, key, outcome: 'ok',
        note: change.kind === 'signIn' ? 'Device authorization initiated; waiting for the user'
          : 'metadata' in extra && extra.metadata === 'locally-queued' ? 'Metadata queued locally' : 'Owner operation observed',
      });
    }).pipe(Effect.provideContext(context), Effect.catchCause(() => Effect.fail(failed()))),
  };
}).pipe(Effect.catchCause(cause => safeFailure(cause, unavailable)));
