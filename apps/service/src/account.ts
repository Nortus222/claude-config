import { Effect } from 'effect';
import { AccountExportSchema, decodeHosted } from '@nortuscc/hosted-protocol';
import type { AuthenticatedPrincipal } from './auth.ts';
import type { AccountDocument, DecisionDocument, MachineDocument } from './documents.ts';
import type { ServiceRequest, ServiceResponse } from './service.ts';
import { MAX_PARTITION_MUTATIONS, type Store, type PartitionSnapshot } from './store.ts';
import { ServiceFailure } from './errors.ts';
import { accountSetups, projectSetup } from './setups.ts';
import { projectRevision, revisionRange } from './revisions.ts';
import { projectDecision } from './sync.ts';
import { projectMachine } from './machines.ts';

export function accountRoute(request: ServiceRequest, principal: AuthenticatedPrincipal, store: Store['Service'], now: () => number): Effect.Effect<ServiceResponse | undefined,ServiceFailure> {
  return Effect.gen(function* () {
    if (request.method === 'DELETE' && request.path === '/v1/account') {
      yield* deleteAccount(store,principal,now);
      return { status:204 };
    }
    if (request.method !== 'GET' || request.path !== '/v1/account/export') return undefined;
    const { account,snapshot,setups } = yield* accountSetups(store,principal.accountId);
    const revisions = [];
    for (const { setup,snapshot:setupSnapshot } of setups) {
      const all = yield* Effect.try({ try:() => revisionRange(setupSnapshot,setup.latestRevision,0),catch:(e) => e as ServiceFailure });
      revisions.push(...all.map(projectRevision));
    }
    const body = { account:{ accountId:account.accountId,githubId:account.githubId,login:account.login,seq:account.seq,defaultPolicy:account.defaultPolicy,createdAt:account.createdAt },
      machines:snapshot.documents.filter((d): d is MachineDocument => d.type === 'machine').map((d) => projectMachine(d,snapshot.documents)),
      setups:setups.map(({ setup }) => projectSetup(setup)),revisions,
      decisions:snapshot.documents.filter((d): d is DecisionDocument => d.type === 'decision').sort((a,b) => a.seq - b.seq).map(projectDecision) };
    return { status:200,body:yield* Effect.try({ try:() => decodeHosted(AccountExportSchema,body),catch:() => new ServiceFailure({ code:'unavailable' }) }) };
  });
}

// Close before sweeping so even a paused absent-partition creator loses its CAS.
function closePartition(store: Store['Service'], container: 'accounts' | 'setups', key: string) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 32; attempt++) {
      const snapshot = yield* store.readPartition(container,key);
      if (snapshot.closed || (yield* store.closePartition(container,key,snapshot.version))) return;
    }
    return yield* Effect.fail(new ServiceFailure({ code:'unavailable' }));
  });
}

// Keep recovery credentials and the account cleanup index in one final atomic delete.
function sweepPartition(store: Store['Service'], container: 'accounts' | 'setups', key: string) {
  return Effect.gen(function* () {
    let conflicts = 0;
    for (;;) {
      const snapshot = yield* store.readPartition(container,key);
      if (!snapshot.closed) return yield* Effect.fail(new ServiceFailure({ code:'unavailable' }));
      if (!snapshot.documents.length) return;
      const ordinary = snapshot.documents.filter((d) => d.type !== 'account' && d.type !== 'machine');
      const targets = container === 'accounts' && ordinary.length ? ordinary : snapshot.documents;
      // The final account plus at most 25 machines must fit one batch.
      if (container === 'accounts' && !ordinary.length && targets.length > MAX_PARTITION_MUTATIONS) return yield* Effect.fail(new ServiceFailure({ code:'unavailable' }));
      if (yield* store.commitPartition(container,key,snapshot.version,targets.slice(0,MAX_PARTITION_MUTATIONS).map(({ id }) => ({ type:'delete',id })))) conflicts = 0;
      else if (++conflicts === 32) return yield* Effect.fail(new ServiceFailure({ code:'unavailable' }));
    }
  });
}

// Numeric GitHub identities remain reusable. Never mutate a replacement mapping.
function changeIdentity(store: Store['Service'], account: AccountDocument, remove: boolean) {
  return Effect.gen(function* () {
    const key = `github:${account.githubId}`;
    for (let attempt = 0; attempt < 32; attempt++) {
      const snapshot = yield* store.readPartition('identities',key);
      const identity = snapshot.documents.find((d) => d.type === 'identity');
      if (!identity || identity.accountId !== account.accountId) return;
      if (!remove && identity.state === 'deleting') return;
      if (yield* store.commitPartition('identities',key,snapshot.version,[remove ? { type:'delete',id:key } : { type:'upsert',document:{ ...identity,state:'deleting' } }])) return;
    }
    return yield* Effect.fail(new ServiceFailure({ code:'unavailable' }));
  });
}

function beginDeletion(store: Store['Service'], principal: AuthenticatedPrincipal, now: () => number) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 32; attempt++) {
      const snapshot: PartitionSnapshot = yield* store.readPartition('accounts',principal.accountId);
      const account = snapshot.documents.find((d): d is AccountDocument => d.type === 'account');
      if (!account) {
        if (snapshot.closed && snapshot.documents.length === 0) return undefined;
        return yield* Effect.fail(new ServiceFailure({ code:'unauthenticated' }));
      }
      if (account.state === 'deleting' && account.deletion) return account;
      if (snapshot.closed || account.state !== 'active') return yield* Effect.fail(new ServiceFailure({ code:'unauthenticated' }));
      const deleting: AccountDocument = { ...account,state:'deleting',deletion:{ startedAt:new Date(now()).toISOString(),remainingSetupIds:account.setups.map((s) => s.setupId) } };
      if (yield* store.commitPartition('accounts',principal.accountId,snapshot.version,[{ type:'upsert',document:deleting }])) return deleting;
    }
    return yield* Effect.fail(new ServiceFailure({ code:'unavailable' }));
  });
}

function deleteAccount(store: Store['Service'], principal: AuthenticatedPrincipal, now: () => number) {
  return Effect.gen(function* () {
    const account = yield* beginDeletion(store,principal,now);
    if (account) {
      // Session claim writes only target an existing version; removing it fences every delayed claim.
      const snapshot = yield* store.readPartition('accounts',account.accountId);
      for (const reservation of snapshot.documents) {
        if (reservation.type !== 'deviceReservation') continue;
        const sessionId = reservation.sessionId;
        let removed = false;
        for (let attempt = 0; attempt < 32; attempt++) {
          const snapshot = yield* store.readPartition('identities',sessionId);
          if (snapshot.version === null || (yield* store.commitPartition('identities',sessionId,snapshot.version,[{ type:'delete',id:sessionId }]))) { removed = true; break; }
        }
        if (!removed) return yield* Effect.fail(new ServiceFailure({ code:'unavailable' }));
      }
      // The complete reservation index stays durable until all setup targets are empty.
      for (const setupId of account.deletion!.remainingSetupIds) {
        yield* closePartition(store,'setups',setupId);
        yield* sweepPartition(store,'setups',setupId);
      }
      yield* changeIdentity(store,account,false);
      yield* closePartition(store,'accounts',account.accountId);
      yield* sweepPartition(store,'accounts',account.accountId);
    }
    // An already authenticated concurrent deletion can finish this last transition too.
    yield* changeIdentity(store,account ?? principal.account,true);
  });
}
