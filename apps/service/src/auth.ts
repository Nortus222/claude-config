import { Effect } from 'effect';
import { decodeHosted, decodeRequestBody, DisplayNameSchema, DeviceStartRequestSchema, DeviceStartResponseSchema, DevicePollRequestSchema, DevicePollSuccessSchema, MachineTokenSchema } from '@nortuscc/hosted-protocol';
import type { AccountDocument, DeviceSessionDocument, IdentityDocument, MachineDocument } from './documents.ts';
import { ServiceFailure } from './errors.ts';
import type { GitHub } from './github.ts';
import { hashTokenSecret, machineToken, newId, newTokenSecret, verifyTokenSecret } from './ids.ts';
import type { Store, Mutation } from './store.ts';
import { activeAccount, changeAccount, registerMachine } from './machines.ts';
import type { ServiceConfig, ServiceResponse } from './service.ts';

export interface AuthenticatedPrincipal { readonly accountId: string; readonly machineId: string; readonly account: AccountDocument; readonly machine: MachineDocument }
const failure = (code: ConstructorParameters<typeof ServiceFailure>[0]['code']) => new ServiceFailure({ code });
const checked = <A>(f: () => A, code: ConstructorParameters<typeof ServiceFailure>[0]['code'] = 'invalid') => Effect.try({ try: f, catch: (e) => e instanceof ServiceFailure ? e : failure(code) });
export function authenticate(store: Store['Service'], authorization: string | undefined, deletionOnly = false): Effect.Effect<AuthenticatedPrincipal, ServiceFailure> {
  return Effect.gen(function* () {
    const token = yield* checked(() => {
      if (!authorization?.startsWith('Bearer ')) throw failure('unauthenticated');
      return decodeHosted(MachineTokenSchema, authorization.slice(7));
    }, 'unauthenticated');
    const match = /^nmt_([A-Za-z0-9-]+)_([A-Za-z0-9-]+)_([A-Za-z0-9_-]{43})$/.exec(token)!;
    const [, accountId, machineId, secret] = match;
    const snapshot = yield* store.readPartition('accounts', accountId);
    const account = yield* checked(() => {
      const deleting = snapshot.documents.find((d): d is AccountDocument => d.type === 'account' && d.state === 'deleting' && d.deletion !== undefined);
      return deletionOnly && deleting ? deleting : activeAccount(snapshot);
    }, 'unauthenticated');
    const machine = snapshot.documents.find((d) => d.type === 'machine' && d.machineId === machineId);
    if (!machine || machine.type !== 'machine' || !machine.tokenHash || !verifyTokenSecret(secret, machine.tokenHash)) return yield* Effect.fail(failure('unauthenticated'));
    return { accountId, machineId, account, machine };
  });
}
export function touchMachine(store: Store['Service'], principal: AuthenticatedPrincipal, now: number) {
  if (now - Date.parse(principal.machine.lastSeenAt) < 300000) return Effect.void;
  return changeAccount(store, principal.accountId, (snapshot) => {
    const machine = snapshot.documents.find((d) => d.type === 'machine' && d.machineId === principal.machineId);
    if (!machine || machine.type !== 'machine' || machine.tokenHash !== principal.machine.tokenHash) throw failure('unauthenticated');
    return { mutations: now - Date.parse(machine.lastSeenAt) >= 300000 ? [{ type: 'upsert' as const, document: { ...machine, lastSeenAt: new Date(now).toISOString() } }] : [], value: undefined };
  });
}

function ensureAccount(store: Store['Service'], user: { id: number; login: string }, config: ServiceConfig, now: number) {
  return Effect.gen(function* () {
    const key = `github:${user.id}`;
    let selectedAccountId: string | undefined;
    for (let attempt = 0; attempt < 32; attempt++) {
      const snapshot = yield* store.readPartition('identities', key);
      let identity = snapshot.documents.find((d): d is IdentityDocument => d.type === 'identity');
      if (identity?.state === 'deleting') {
        // Verified GitHub sign-in repairs the final crash window after token hashes are gone.
        const old = yield* store.readPartition('accounts', identity.accountId);
        if (selectedAccountId || !old.closed || old.documents.length !== 0) return yield* Effect.fail(failure('unauthenticated'));
        if (!(yield* store.commitPartition('identities', key, snapshot.version, [{ type: 'delete', id: key }]))) continue;
        continue;
      }
      if (!identity) {
        if (selectedAccountId) return yield* Effect.fail(failure('unauthenticated'));
        if (!config.openSignup && !config.allowlistedLogins.some((login) => login.toLowerCase() === user.login.toLowerCase())) return yield* Effect.fail(failure('not_allowlisted'));
        identity = { type: 'identity', version: 1, id: key, githubId: user.id, accountId: newId(now), state: 'reserved' };
        if (!(yield* store.commitPartition('identities', key, snapshot.version, [{ type: 'upsert', document: identity }]))) continue;
      }
      if (selectedAccountId && selectedAccountId !== identity.accountId) return yield* Effect.fail(failure('unauthenticated'));
      selectedAccountId = identity.accountId;
      const accountSnapshot = yield* store.readPartition('accounts', identity.accountId);
      if (accountSnapshot.closed) return yield* Effect.fail(failure('unauthenticated'));
      let account = accountSnapshot.documents.find((d): d is AccountDocument => d.type === 'account');
      if (!account) {
        // An active identity never recreates an absent account after deletion.
        if (identity.state !== 'reserved') return yield* Effect.fail(failure('unauthenticated'));
        account = { type: 'account', version: 1, id: 'account', accountId: identity.accountId, githubId: user.id, login: user.login,
          seq: 0, defaultPolicy: 'notify', createdAt: new Date(now).toISOString(), state: 'active', setups: [] };
        if (!(yield* store.commitPartition('accounts', identity.accountId, accountSnapshot.version, [{ type: 'upsert', document: account }]))) continue;
      }
      if (account.state !== 'active') return yield* Effect.fail(failure('unauthenticated'));
      if (identity.state === 'reserved') {
        const fresh = yield* store.readPartition('identities', key);
        const current = fresh.documents.find((d): d is IdentityDocument => d.type === 'identity');
        if (!current || current.accountId !== identity.accountId || current.state === 'deleting') return yield* Effect.fail(failure('unauthenticated'));
        if (!(yield* store.commitPartition('identities', key, fresh.version, [{ type: 'upsert', document: { ...current, state: 'active' } }]))) continue;
      }
      return account;
    }
    return yield* Effect.fail(failure('unavailable'));
  });
}

// Remove index entries only after their sessions are gone; deletion owns entries after its lifecycle CAS.
function removeSessionReservation(store: Store['Service'], accountId: string, sessionId: string) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 32; attempt++) {
      const snapshot = yield* store.readPartition('accounts',accountId);
      const account = snapshot.documents.find((d): d is AccountDocument => d.type === 'account');
      if (snapshot.closed || !account || account.state !== 'active' || !snapshot.documents.some((d) => d.type === 'deviceReservation' && d.sessionId === sessionId)) return;
      if (yield* store.commitPartition('accounts',accountId,snapshot.version,[{ type:'delete',id:sessionId }])) return;
    }
    return yield* Effect.fail(failure('unavailable'));
  });
}

// Cleanup after an uncertain issuance uses the stored claim, never a replayable token.
function cleanupSession(store: Store['Service'], session: DeviceSessionDocument, recovery: boolean) {
  return Effect.gen(function* () {
    if (session.claim) {
      const { accountId, machineId, tokenHash } = session.claim;
      for (let attempt = 0; attempt < 32; attempt++) {
        const snapshot = yield* store.readPartition('accounts', accountId);
        const account = snapshot.documents.find((d) => d.type === 'account');
        if (!account) break;
        const existing = snapshot.documents.find((d): d is MachineDocument => d.type === 'machine' && d.machineId === machineId);
        if (existing && existing.tokenHash !== tokenHash && existing.tokenHash !== null) break;
        const mutations: Mutation[] = [
          { type: 'delete', id: `machine:${machineId}` },
          { type: 'delete', id: `status:${machineId}` },
        ];
        // Fence delayed registration without consuming a public machine slot.
        mutations.push(recovery && account.state === 'active'
          ? { type: 'upsert', document: { type: 'issuanceFence', version: 1, id: `issuance:${machineId}`, accountId, machineId } }
          : { type: 'delete', id: `issuance:${machineId}` });
        if (yield* store.commitPartition('accounts', accountId, snapshot.version, mutations)) break;
        if (attempt === 31) return yield* Effect.fail(failure('unavailable'));
      }
    }
    for (let attempt = 0; attempt < 32; attempt++) {
      const snapshot = yield* store.readPartition('identities', session.id);
      if (snapshot.version === null || (yield* store.commitPartition('identities', session.id, snapshot.version, [{ type: 'delete', id: session.id }]))) break;
      if (attempt === 31) return yield* Effect.fail(failure('unavailable'));
    }
    if (session.claim) yield* removeSessionReservation(store,session.claim.accountId,session.id);
  });
}

// Fence stale claim/reset writes before recovering from the current persisted claim.
export function recoverExpiredDeviceSession(store: Store['Service'], key: string, now: number): Effect.Effect<void, ServiceFailure> {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 32; attempt++) {
      const snapshot = yield* store.readPartition('identities', key);
      const session = snapshot.documents.find((d): d is DeviceSessionDocument => d.type === 'deviceSession');
      if (!session || session.expiresAt > now) return;
      const expired: DeviceSessionDocument = { ...session, state: 'expired' };
      if (session.state !== 'expired' && !(yield* store.commitPartition('identities', key, snapshot.version, [{ type: 'upsert', document: expired }]))) continue;
      yield* cleanupSession(store, expired, true);
      return;
    }
    return yield* Effect.fail(failure('unavailable'));
  });
}
export function deviceStart(store: Store['Service'], github: GitHub['Service'], body: unknown, now: () => number): Effect.Effect<ServiceResponse, ServiceFailure> {
  return Effect.gen(function* () {
    const description = yield* checked(() => decodeRequestBody(DeviceStartRequestSchema, body));
    const upstream = yield* github.requestDevice();
    const createdAt = now();
    const pendingId = newId(createdAt);
    const response = yield* checked(() => decodeHosted(DeviceStartResponseSchema, { pendingId, userCode: upstream.userCode, verificationUri: upstream.verificationUri,
      interval: upstream.interval, expiresIn: Math.min(900, upstream.expiresIn) }), 'unavailable');
    const session: DeviceSessionDocument = { type: 'deviceSession', version: 1, id: `device:${pendingId}`, pendingId,
      deviceCode: upstream.deviceCode, description, createdAt, expiresAt: createdAt + response.expiresIn * 1000,
      interval: upstream.interval, nextPollAt: createdAt + upstream.interval * 1000, state: 'pending', claim: null };
    if (!(yield* store.commitPartition('identities', session.id, null, [{ type: 'upsert', document: session }]))) return yield* Effect.fail(failure('unavailable'));
    return { status: 200, body: response };
  });
}
export function devicePoll(store: Store['Service'], github: GitHub['Service'], body: unknown, config: ServiceConfig, now: () => number): Effect.Effect<ServiceResponse, ServiceFailure> {
  return Effect.gen(function* () {
    const request = yield* checked(() => decodeRequestBody(DevicePollRequestSchema, body));
    const key = `device:${request.pendingId}`;
    const snapshot = yield* store.readPartition('identities', key);
    const session = snapshot.documents.find((d): d is DeviceSessionDocument => d.type === 'deviceSession');
    if (!session) return yield* Effect.fail(failure('sign_in_expired'));
    if (session.expiresAt <= now()) { yield* recoverExpiredDeviceSession(store, key, now()); return yield* Effect.fail(failure('sign_in_expired')); }
    if (session.state !== 'pending') return yield* Effect.fail(failure('sign_in_expired'));
    if (session.nextPollAt > now()) return { status: 202, body: { interval: session.interval } };
    const claimed: DeviceSessionDocument = { ...session, state: 'claimed', claim: null };
    if (!(yield* store.commitPartition('identities', key, snapshot.version, [{ type: 'upsert', document: claimed }]))) return yield* Effect.fail(failure('sign_in_expired'));
    let owned = claimed;
    const issue = Effect.gen(function* () {
      const exchange = yield* github.exchange(session.deviceCode);
      if (now() >= session.expiresAt || exchange.type === 'expired' || exchange.type === 'denied') return yield* Effect.fail(failure('sign_in_expired'));
      if (exchange.type === 'pending' || exchange.type === 'slow-down') {
        const interval = session.interval + (exchange.type === 'slow-down' ? 5 : 0);
        const fresh = yield* store.readPartition('identities', key);
        if (!fresh.documents.some((d) => d.type === 'deviceSession' && d.state === 'claimed' && d.claim === null)) return yield* Effect.fail(failure('sign_in_expired'));
        if (!(yield* store.commitPartition('identities', key, fresh.version, [{ type: 'upsert', document: { ...session, interval, nextPollAt: now() + interval * 1000 } }]))) return yield* Effect.fail(failure('sign_in_expired'));
        return { status: 202, body: { interval } };
      }
      if (exchange.type !== 'success') return yield* Effect.fail(failure('unavailable'));
      const user = yield* github.user(exchange.token);
      yield* checked(() => { if (!Number.isSafeInteger(user.id) || user.id <= 0) throw failure('unavailable'); decodeHosted(DisplayNameSchema, user.login); }, 'unavailable');
      const account = yield* ensureAccount(store, user, config, now());
      const machineId = newId(now()); const secret = newTokenSecret();
      const token = machineToken(account.accountId, machineId, secret);
      const response = yield* checked(() => decodeHosted(DevicePollSuccessSchema, { accountId: account.accountId, login: user.login, machineId, token, defaultPolicy: account.defaultPolicy }), 'unavailable');
      owned = { ...claimed, claim: { claimId: newId(now()), accountId: account.accountId, machineId, tokenHash: hashTokenSecret(secret), claimedAt: now() } };
      const fresh = yield* store.readPartition('identities', key);
      if (now() >= session.expiresAt || fresh.version === null || !fresh.documents.some((d) => d.type === 'deviceSession' && d.state === 'claimed' && d.claim === null)) return yield* Effect.fail(failure('sign_in_expired'));
      // Deletion captures this account-local index before any account claim can persist.
      yield* changeAccount(store,account.accountId,() => ({
        mutations:[{ type:'upsert',document:{ type:'deviceReservation',version:1,id:key,accountId:account.accountId,sessionId:key } }],value:undefined,
      }));
      if (!(yield* store.commitPartition('identities', key, fresh.version, [{ type: 'upsert', document: owned }]))) return yield* Effect.fail(failure('sign_in_expired'));
      const timestamp = new Date(now()).toISOString();
      yield* registerMachine(store, { type: 'machine', version: 1, id: `machine:${machineId}`, accountId: account.accountId, machineId,
        ...session.description, policy: account.defaultPolicy, reportStatus: true, createdAt: timestamp, lastSeenAt: timestamp, tokenHash: owned.claim!.tokenHash });
      const complete = yield* store.readPartition('identities', key);
      if (now() >= session.expiresAt || !complete.documents.some((d) => d.type === 'deviceSession' && d.state === 'claimed' && d.claim?.claimId === owned.claim?.claimId)) return yield* Effect.fail(failure('sign_in_expired'));
      if (!(yield* store.commitPartition('identities', key, complete.version, [{ type: 'delete', id: key }]))) return yield* Effect.fail(failure('unavailable'));
      yield* removeSessionReservation(store,account.accountId,key);
      return { status: 200, body: response };
    });
    return yield* issue.pipe(Effect.catch((error) => cleanupSession(store, owned, false).pipe(Effect.andThen(Effect.fail(error)))));
  });
}
