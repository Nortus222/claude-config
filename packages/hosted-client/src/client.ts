import { Effect, Schema, Semaphore } from 'effect';
import { DecisionsStore, HistoryStore, type Actor, type Decision as LocalDecision } from '@nortuscc/machine';
import { DeviceStartRequestSchema, DeviceStartResponseSchema, DevicePollPendingSchema, DevicePollSuccessSchema,
  DecisionsRequestSchema, MachinePatchSchema, MachineRecordSchema, MachineTokenSchema, SyncResponseSchema, decodeDecisionsResponse,
  IsoTimeSchema,
  decodeHosted, decodeRequestBody, formatSyncQuery, jsonByteLength, MAX_DECISIONS, MAX_REQUEST_BODY_BYTES,
  type DeviceStartRequest, type MachinePatch, type Policy, type SyncRevision, type SyncedDecision, type SyncMachine, type SyncSetup } from '@nortuscc/hosted-protocol';
import { HostedFailure, HostedTransport, type HostedFailureCode, type HostedRequest } from './transport.ts';
import { MachineTokenStore } from './token.ts';
import { HostedStore, type HostedAccount, type HostedDocument, type OutboxEntry } from './store.ts';

export type HostedState = {
  readonly accountId: string | null; readonly login: string | null; readonly machineId: string | null;
  readonly auth: 'signed-in' | 'signed-out' | 'unauthenticated'; readonly setups: ReadonlyArray<SyncSetup>;
  readonly machine: SyncMachine | null; readonly lastSyncAt: string | null; readonly retryAt: string | null;
  readonly pollAfter: number; readonly error: HostedFailureCode | null;
};
export type SignInRequest = Omit<DeviceStartRequest, 'name'> & { readonly name?: string };
export type SignInStarted = { readonly userCode: string; readonly verificationUri: string; readonly interval: number; readonly expiresIn: number };
export type SignInPoll = { readonly status: 'pending'; readonly pollAfter: number } | { readonly status: 'success'; readonly accountId: string; readonly login: string; readonly machineId: string };
export type HostedClientOptions = {
  readonly now?: () => Date;
  readonly readPolicy: Effect.Effect<{ readonly policy: Policy; readonly policySource: 'default' | 'person' }, unknown>;
  // Updates policy fields only; this client records policy History, preserving the initiating actor.
  readonly onPolicy: (policy: Policy, origin: 'local' | 'synced') => Effect.Effect<void, unknown>;
};
export type HostedClient = {
  readonly state: Effect.Effect<HostedState, HostedFailure>;
  readonly revisions: (setupId: string) => Effect.Effect<ReadonlyArray<SyncRevision>, HostedFailure>;
  readonly startSignIn: (request: SignInRequest) => Effect.Effect<SignInStarted, HostedFailure>;
  readonly pollSignIn: () => Effect.Effect<SignInPoll, HostedFailure>;
  readonly signOut: () => Effect.Effect<void, HostedFailure>;
  // Repairs durable local decisions and policy before jobs, without making hosted requests.
  readonly recover: () => Effect.Effect<HostedState, HostedFailure>;
  readonly sync: () => Effect.Effect<HostedState, HostedFailure>;
  readonly enqueueDecision: (decision: LocalDecision, actor?: Actor) => Effect.Effect<void, HostedFailure>;
  readonly enqueueMachine: (patch: MachinePatch, actor?: Actor) => Effect.Effect<void, HostedFailure>;
};
const safeStorage = () => new HostedFailure({ code: 'storage' });
const invalidResponse = () => new HostedFailure({ code: 'invalid_response' });
const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown, request = false) => Effect.try({
  try: () => request ? decodeRequestBody(schema, value) : decodeHosted(schema, value),
  catch: () => new HostedFailure({ code: request ? 'invalid_request' : 'invalid_response' }),
});
const key = (d: { setupId: string; itemId: string }) => `${d.setupId}:${d.itemId}`;
const mergeDecisions = (before: ReadonlyArray<SyncedDecision>, incoming: ReadonlyArray<SyncedDecision>) => {
  const map = new Map(before.map((d) => [key(d), d]));
  for (const d of incoming) map.set(key(d), d);
  return [...map.values()];
};
const active = (doc: HostedDocument) => doc.accounts.find((a) => a.accountId === doc.activeAccountId);
const withoutEtag = (a: HostedAccount): HostedAccount => {
  const { etag: _etag, ...rest } = a;
  return rest;
};
const effectiveMachine = (a: HostedAccount): SyncMachine => {
  let machine = a.machine;
  for (const entry of a.outbox) if (entry.kind === 'machine') machine = { ...machine,
    ...(entry.patch.policy === undefined ? {} : { policy: entry.patch.policy }),
    ...(entry.patch.reportStatus === undefined ? {} : { reportStatus: entry.patch.reportStatus }) };
  return machine;
};
const project = (a: HostedAccount | undefined): HostedState => ({ accountId: a?.accountId ?? null, login: a?.login ?? null, machineId: a?.machineId ?? null,
  auth: a?.auth ?? 'signed-out', setups: a?.setups ?? [], machine: a ? effectiveMachine(a) : null, lastSyncAt: a?.lastSyncAt ?? null,
  retryAt: a?.retryAt ?? null, pollAfter: a?.pollAfter ?? 900, error: (a?.error as HostedFailureCode | null) ?? null });
const osNames = { macos: 'macOS', linux: 'Linux', windows: 'Windows' };

// Services are captured once. Device-flow state stays private to this client instance in the agent.
export const makeHostedClient = (options: HostedClientOptions): Effect.Effect<HostedClient, never,
  HostedTransport | MachineTokenStore | HostedStore | DecisionsStore | HistoryStore> => Effect.gen(function* () {
  const transport = yield* HostedTransport;
  const credentials = yield* MachineTokenStore;
  const store = yield* HostedStore;
  const decisions = yield* DecisionsStore;
  const history = yield* HistoryStore;
  const lock = yield* Semaphore.make(1);
  const now = options.now ?? (() => new Date());
  let pending: { pendingId: string; expiresAt: number; nextAt: number; interval: number } | undefined;
  const deadline = (seconds: number, jitter = false) => Effect.try({
    try: () => {
      const delay = seconds * 1000;
      const at = now().getTime() + delay;
      if (!Number.isSafeInteger(delay) || delay < 0 || delay * (jitter ? 1.2 : 1) > 2_147_483_647
        || !Number.isSafeInteger(at) || Math.abs(at) > 8_640_000_000_000_000) throw invalidResponse();
      return at;
    }, catch: invalidResponse,
  });
  const state = Effect.map(store.read, (doc) => project(active(doc)));
  const updateAccount = (accountId: string, change: (a: HostedAccount) => HostedAccount) => store.update((doc) => ({ ...doc, accounts: doc.accounts.map((a) => a.accountId === accountId ? change(a) : a) }));
  const requireAccount = Effect.flatMap(store.read, (doc) => {
    const a = active(doc);
    return a ? Effect.succeed(a) : Effect.fail(new HostedFailure({ code: 'unauthenticated' }));
  });
  const reconcile = (a: HostedAccount) => Effect.gen(function* () {
    const projection = new Map<string, LocalDecision>(a.authoritative.map((d) => [key(d), { ...d, commit: null, source: 'synced' }]));
    for (const e of a.outbox) if (e.kind === 'decision') projection.set(key(e.decision), { ...e.decision, decidedAt: e.decidedAt, commit: null, machineId: a.machineId, source: 'local' });
    const doc = yield* store.read;
    const current = yield* decisions.read.pipe(Effect.mapError(safeStorage));
    // Inactive account ownership survives a crash after switching the active checkpoint.
    // Include orphaned numeric projections after the final invalid intent was durably removed.
    const ids = [...new Set([...current.filter((d) => d.revision !== null && d.setupId !== 'local').map((d) => d.setupId),
      ...doc.accounts.flatMap((account) => [...account.setups.map((s) => s.setupId),
        ...account.authoritative.map((d) => d.setupId), ...account.outbox.flatMap((e) => e.kind === 'decision' ? [e.decision.setupId] : [])])])];
    yield* decisions.replaceHosted(ids, [...projection.values()]).pipe(Effect.mapError(safeStorage));
  });
  const applyPolicy = (a: HostedAccount, actor: Actor = 'agent') => Effect.gen(function* () {
    const chosen = [...a.outbox].reverse().find((e): e is Extract<OutboxEntry, { kind: 'machine' }> => e.kind === 'machine' && e.patch.policy !== undefined);
    const policy = chosen?.patch.policy ?? a.machine.policy;
    const origin = chosen ? 'local' as const : 'synced' as const;
    const before = yield* options.readPolicy.pipe(Effect.mapError(safeStorage));
    if (before.policy !== policy) yield* history.append({ kind: 'policy-changed', actor: chosen ? actor : 'sync', from: before.policy, to: policy, origin }).pipe(Effect.mapError(safeStorage));
    yield* options.onPolicy(policy, origin).pipe(Effect.mapError(safeStorage));
  });
  const persistFailure = (a: HostedAccount, failure: HostedFailure) => Effect.gen(function* () {
    // Durable backoff may exceed one timer wait. Saturate at the ISO schema's latest year.
    const retryAt = failure.retryAfter === undefined ? undefined : new Date(Math.min(
      Date.parse('9999-12-31T23:59:59.999Z'), now().getTime() + failure.retryAfter * 1000,
    )).toISOString();
    yield* updateAccount(a.accountId, (current) => ({ ...current,
      auth: failure.code === 'unauthenticated' ? 'unauthenticated' : current.auth,
      error: failure.code, retryAt: retryAt ?? current.retryAt,
    }));
  });
  const recoverAccount = Effect.gen(function* () {
    const a = active(yield* store.read);
    if (a) { yield* reconcile(a); yield* applyPolicy(a); }
    return a;
  });
  const request = (a: HostedAccount, req: Omit<HostedRequest, 'token'>) => Effect.gen(function* () {
    const token = yield* credentials.read();
    if (token === undefined) return yield* Effect.fail(new HostedFailure({ code: 'unauthenticated' }));
    const checked = yield* decode(MachineTokenSchema, token);
    const [, accountId, machineId] = checked.split('_');
    if (a.accountId !== accountId || a.machineId !== machineId) return yield* Effect.fail(new HostedFailure({ code: 'unauthenticated' }));
    return yield* transport.request({ ...req, token: checked });
  });
  const enqueue = (a: HostedAccount, entry: OutboxEntry, actor: Actor) => Effect.gen(function* () {
    const doc = yield* updateAccount(a.accountId, (current) => ({ ...current, outbox: [...current.outbox, entry] }));
    const next = active(doc)!;
    if (entry.kind === 'decision') yield* history.append({ actor, kind: 'decided', ...entry.decision, commit: null }).pipe(Effect.mapError(safeStorage));
    yield* reconcile(next);
    if (entry.kind === 'machine' && entry.patch.policy !== undefined) yield* applyPolicy(next, actor);
  });
  const drop = (a: HostedAccount, count: number) => Effect.gen(function* () {
    // History precedes removal: a crash may repeat this safe event, but cannot silently lose the intent.
    yield* history.append({ actor: 'agent', kind: 'outbox-dropped', accountId: a.accountId, count, code: 'invalid' }).pipe(Effect.mapError(safeStorage));
    const doc = yield* updateAccount(a.accountId, (current) => ({ ...current, outbox: current.outbox.slice(count) }));
    yield* reconcile(active(doc)!);
    yield* applyPolicy(active(doc)!);
  });
  const flush = (initial: HostedAccount) => Effect.gen(function* () {
    let a = initial;
    while (a.outbox.length > 0) {
      const head = a.outbox[0]!;
      if (head.kind === 'machine') {
        const result = yield* request(a, { method: 'PATCH', path: `/machines/${a.machineId}`, body: head.patch }).pipe(Effect.catch((error) => error.code === 'invalid'
          ? drop(a, 1).pipe(Effect.as(undefined)) : Effect.fail(error)));
        if (result !== undefined) {
          if (result.status !== 200) return yield* Effect.fail(invalidResponse());
          const machine = yield* decode(MachineRecordSchema, result.body);
          if (machine.machineId !== a.machineId) return yield* Effect.fail(invalidResponse());
          yield* updateAccount(a.accountId, (current) => ({ ...current, outbox: current.outbox.slice(1), machine: { policy: machine.policy, reportStatus: machine.reportStatus } }));
        }
      } else {
        const sent: Extract<OutboxEntry, { kind: 'decision' }>[] = [];
        for (const e of a.outbox) {
          if (e.kind !== 'decision' || sent.length === MAX_DECISIONS) break;
          if (jsonByteLength({ decisions: [...sent.map((s) => s.decision), e.decision] }) > MAX_REQUEST_BODY_BYTES) break;
          sent.push(e);
        }
        if (sent.length === 0) return yield* Effect.fail(new HostedFailure({ code: 'payload_too_large' }));
        const body = yield* decode(DecisionsRequestSchema, { decisions: sent.map((e) => e.decision) }, true);
        const result = yield* request(a, { method: 'PUT', path: '/decisions', body }).pipe(Effect.catch((error) => error.code === 'invalid'
          ? drop(a, sent.length).pipe(Effect.as(undefined)) : Effect.fail(error)));
        if (result !== undefined) {
          if (result.status !== 200) return yield* Effect.fail(invalidResponse());
          const reply = yield* Effect.try({ try: () => decodeDecisionsResponse(body, result.body), catch: invalidResponse });
          const prefix = reply.results.findIndex((r) => r.outcome === 'unprocessed');
          const count = prefix === -1 ? sent.length : prefix;
          const stored = sent.slice(0, count).flatMap((e, i) => reply.results[i]!.outcome === 'stored' ? [{ ...e.decision, decidedAt: e.decidedAt, machineId: a.machineId }] : []);
          const confirmed = new Map(a.authoritative.map((d) => [key(d), d]));
          for (const d of stored) {
            if (d.revision < (confirmed.get(key(d))?.revision ?? 0)) return yield* Effect.fail(invalidResponse());
            confirmed.set(key(d), d);
          }
          // Response sequence is deliberately excluded from the GET checkpoint.
          const doc = yield* updateAccount(a.accountId, (current) => ({ ...current, outbox: current.outbox.slice(count), authoritative: mergeDecisions(current.authoritative, stored) }));
          a = active(doc)!;
          yield* reconcile(a);
          if (prefix !== -1) break;
        }
      }
      a = active(yield* store.read)!;
    }
    yield* reconcile(a);
    yield* applyPolicy(a);
    return a;
  });
  const sync = () => Effect.gen(function* () {
    let a = yield* recoverAccount;
    if (!a || a.auth !== 'signed-in' || (a.retryAt !== null && Date.parse(a.retryAt) > now().getTime())) return project(a);
    const initial = a;
    const work = Effect.gen(function* () {
      a = yield* flush(initial);
      const query = { since: a.seq, setups: a.cursors };
      const result = yield* request(a, { method: 'GET', path: `/sync?${formatSyncQuery(query)}`, ...(a.etag === undefined ? {} : { etag: a.etag }) });
      if (result.status === 304) {
        const doc = yield* updateAccount(a.accountId, (current) => ({ ...current, lastSyncAt: now().toISOString(), retryAt: null, error: null,
          ...(result.etag === undefined ? {} : { etag: result.etag }) }));
        return project(active(doc));
      }
      if (result.status !== 200) return yield* Effect.fail(invalidResponse());
      const body = yield* decode(SyncResponseSchema, result.body);
      yield* deadline(body.pollAfter, true);
      if (body.seq < query.since) return yield* Effect.fail(invalidResponse());
      if (body.decisions.some((d) => d.revision < (a!.authoritative.find((old) => key(old) === key(d))?.revision ?? 0))) return yield* Effect.fail(invalidResponse());
      for (const cursor of query.setups) if (!body.setups.some((s) => s.setupId === cursor.setupId && s.latestRevision >= cursor.revision)) return yield* Effect.fail(invalidResponse());
      for (const setup of body.setups) {
        const since = query.setups.find((c) => c.setupId === setup.setupId)?.revision ?? 0;
        const records = body.revisions.filter((r) => r.setupId === setup.setupId);
        if (records.length !== setup.latestRevision - since || records.some((r, i) => r.number !== since + i + 1)) return yield* Effect.fail(invalidResponse());
        const cache = yield* store.revisions(a.accountId, setup.setupId);
        if (cache.length < since || cache.length > setup.latestRevision) return yield* Effect.fail(invalidResponse());
      }
      // Validate all ranges before any cache write; cache immutability handles cache-ahead replay.
      for (const setup of body.setups) yield* store.cache(a.accountId, setup.setupId, body.revisions.filter((r) => r.setupId === setup.setupId));
      const authoritative = mergeDecisions(a.authoritative, body.decisions);
      for (const d of body.decisions) {
        const previous = a.authoritative.find((old) => key(old) === key(d));
        if (d.machineId !== a.machineId && (!previous || previous.decision !== d.decision || previous.revision !== d.revision || previous.machineId !== d.machineId)) {
          yield* history.append({ kind: 'decided', actor: 'sync', machineId: d.machineId, setupId: d.setupId,
            itemId: d.itemId, revision: d.revision, commit: null, decision: d.decision }).pipe(Effect.mapError(safeStorage));
        }
      }
      // Persist incoming decisions with the checkpoint, then repair their local projection on restart.
      const doc = yield* updateAccount(a.accountId, (current) => ({ ...withoutEtag(current), seq: body.seq,
        cursors: body.setups.map((s) => ({ setupId: s.setupId, revision: s.latestRevision })), setups: body.setups,
        authoritative, machine: body.machine, pollAfter: body.pollAfter, lastSyncAt: now().toISOString(), retryAt: null, error: null,
        ...(result.etag === undefined ? {} : { etag: result.etag }) }));
      const next = active(doc)!;
      yield* reconcile(next); yield* applyPolicy(next);
      return project(next);
    });
    return yield* work.pipe(Effect.catch((error) => persistFailure(initial, error).pipe(Effect.andThen(Effect.fail(error)))));
  }).pipe(lock.withPermit);
  return {
    state,
    revisions: (setupId) => Effect.flatMap(store.read, (doc) => {
      const a = active(doc);
      return a ? store.revisions(a.accountId, setupId) : Effect.succeed([]);
    }),
    startSignIn: (input) => Effect.gen(function* () {
      const body = yield* decode(DeviceStartRequestSchema, { ...input, name: input.name ?? `${osNames[input.os]} machine` }, true);
      const reply = yield* transport.request({ method: 'POST', path: '/auth/device/start', body });
      if (reply.status !== 200) return yield* Effect.fail(invalidResponse());
      const response = yield* decode(DeviceStartResponseSchema, reply.body);
      const expiresAt = yield* deadline(response.expiresIn);
      const nextAt = yield* deadline(response.interval);
      pending = { pendingId: response.pendingId, expiresAt, nextAt, interval: response.interval };
      const { pendingId: _pendingId, ...safe } = response;
      return safe;
    }).pipe(lock.withPermit),
    pollSignIn: () => Effect.gen(function* () {
      if (!pending || now().getTime() >= pending.expiresAt) { pending = undefined; return yield* Effect.fail(new HostedFailure({ code: 'sign_in_expired' })); }
      if (now().getTime() < pending.nextAt) return { status: 'pending' as const, pollAfter: Math.ceil((pending.nextAt - now().getTime()) / 1000) };
      const flow = pending;
      flow.nextAt = yield* deadline(flow.interval);
      const reply = yield* transport.request({ method: 'POST', path: '/auth/device/poll', body: { pendingId: flow.pendingId } }).pipe(Effect.catch((error) => {
        if (error.code === 'sign_in_expired' || error.code === 'not_allowlisted') pending = undefined;
        return Effect.gen(function* () {
          if (error.retryAfter !== undefined) flow.nextAt = Math.max(flow.nextAt, yield* deadline(error.retryAfter));
          return yield* Effect.fail(error);
        });
      }));
      if (reply.status === 202) {
        const next = yield* decode(DevicePollPendingSchema, reply.body); flow.nextAt = yield* deadline(next.interval); flow.interval = next.interval;
        return { status: 'pending' as const, pollAfter: next.interval };
      }
      if (reply.status !== 200) return yield* Effect.fail(invalidResponse());
      const result = yield* decode(DevicePollSuccessSchema, reply.body);
      const before = yield* store.read;
      const same = before.accounts.find((a) => a.accountId === result.accountId);
      const policy = yield* options.readPolicy.pipe(Effect.mapError(safeStorage));
      let next: HostedAccount = same ? { ...same, login: result.login, machineId: result.machineId, auth: 'signed-in', retryAt: null, error: null } : {
        accountId: result.accountId, login: result.login, machineId: result.machineId, auth: 'signed-in', seq: 0, cursors: [], setups: [],
        authoritative: [], outbox: [], machine: { policy: result.defaultPolicy, reportStatus: true }, lastSyncAt: null, retryAt: null, error: null, pollAfter: 900,
      };
      if (policy.policySource === 'person') next = { ...next, outbox: [...next.outbox, { kind: 'machine', patch: { policy: policy.policy } }] };
      next = { ...withoutEtag(next), machine: { policy: result.defaultPolicy, reportStatus: true } };
      // Bind metadata first. A credential left from another account cannot pass request's identity check.
      yield* store.update((doc) => ({ ...doc, activeAccountId: next.accountId, accounts: [...doc.accounts.filter((a) => a.accountId !== next.accountId), next] }));
      yield* credentials.write(result.token);
      pending = undefined;
      yield* reconcile(next);
      yield* applyPolicy(next);
      return { status: 'success' as const, accountId: result.accountId, login: result.login, machineId: result.machineId };
    }).pipe(lock.withPermit),
    signOut: () => Effect.gen(function* () {
      pending = undefined;
      const metadata = yield* store.read.pipe(Effect.match({
        onFailure: (error) => ({ error, document: undefined }), onSuccess: (document) => ({ error: undefined, document }),
      }));
      const a = metadata.document ? active(metadata.document) : undefined;
      const revoke = a && a.auth === 'signed-in' ? request(a, { method: 'POST', path: '/auth/sign-out' }).pipe(Effect.flatMap((reply) => reply.status === 204 ? Effect.void : Effect.fail(invalidResponse()))) : Effect.void;
      // Local deletion always runs even when the service is offline. Its failure remains visible.
      const remoteError = yield* revoke.pipe(Effect.match({ onFailure: (e) => e, onSuccess: () => undefined }));
      yield* credentials.remove();
      if (metadata.error) return yield* Effect.fail(metadata.error);
      if (a) yield* updateAccount(a.accountId, (current) => ({ ...current, auth: 'signed-out', retryAt: null, error: remoteError?.code ?? null }));
      if (remoteError) return yield* Effect.fail(remoteError);
    }).pipe(lock.withPermit),
    sync,
    recover: () => recoverAccount.pipe(Effect.map(project), lock.withPermit),
    enqueueDecision: (decision, actor = 'agent') => Effect.gen(function* () {
      if (decision.commit !== null || decision.revision === null || decision.source !== 'local') return yield* Effect.fail(new HostedFailure({ code: 'invalid_request' }));
      yield* decode(IsoTimeSchema, decision.decidedAt, true);
      const checked = yield* decode(DecisionsRequestSchema, { decisions: [{ setupId: decision.setupId, itemId: decision.itemId, revision: decision.revision, decision: decision.decision }] }, true);
      const a = yield* requireAccount;
      yield* enqueue(a, { kind: 'decision', decision: checked.decisions[0]!, decidedAt: decision.decidedAt }, actor);
    }).pipe(lock.withPermit),
    enqueueMachine: (patch, actor = 'agent') => Effect.gen(function* () {
      const checked = yield* decode(MachinePatchSchema, patch, true); const a = yield* requireAccount;
      yield* enqueue(a, { kind: 'machine', patch: checked }, actor);
    }).pipe(lock.withPermit),
  } satisfies HostedClient;
});
