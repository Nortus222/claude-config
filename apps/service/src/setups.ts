import { Effect } from 'effect';
import { decodeRequestBody, MAX_SETUPS, SetupRegistrationSchema, type SetupRecord } from '@nortuscc/hosted-protocol';
import type { AuthenticatedPrincipal } from './auth.ts';
import type { AccountDocument, SetupDocument, SetupReservation } from './documents.ts';
import type { Store, PartitionSnapshot } from './store.ts';
import type { ServiceRequest, ServiceResponse } from './service.ts';
import { ServiceFailure } from './errors.ts';
import { activeAccount, changeAccount } from './machines.ts';
import { newId } from './ids.ts';

export function projectSetup(setup: SetupDocument): SetupRecord {
  return { setupId:setup.setupId,name:setup.name,repoUrl:setup.repoUrl,latestRevision:setup.latestRevision,createdAt:setup.createdAt };
}
export function ownedSetup(store: Store['Service'], accountId: string, setupId: string) {
  return Effect.gen(function* () {
    const snapshot = yield* store.readPartition('setups',setupId);
    const setup = snapshot.documents.find((d): d is SetupDocument => d.type === 'setup');
    if (!setup || setup.ownerAccountId !== accountId) return yield* Effect.fail(new ServiceFailure({ code:'not_found' }));
    return { snapshot,setup };
  });
}
// Only durable account reservations may initialize a missing setup partition.
function materialize(store: Store['Service'], accountId: string, reservation: SetupReservation) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 32; attempt++) {
      const accountSnapshot = yield* store.readPartition('accounts',accountId);
      const account = yield* Effect.try({ try:() => activeAccount(accountSnapshot),catch:() => new ServiceFailure({ code:'unauthenticated' }) });
      if (!account.setups.some((s) => s.setupId === reservation.setupId)) return yield* Effect.fail(new ServiceFailure({ code:'not_found' }));
      const snapshot = yield* store.readPartition('setups',reservation.setupId);
      const existing = snapshot.documents.find((d): d is SetupDocument => d.type === 'setup');
      if (existing) {
        if (existing.ownerAccountId !== accountId || existing.name !== reservation.name || existing.repoUrl !== reservation.repoUrl || existing.createdAt !== reservation.createdAt) return yield* Effect.fail(new ServiceFailure({ code:'unavailable' }));
        return existing;
      }
      if (reservation.state === 'ready' || snapshot.version !== null) return yield* Effect.fail(new ServiceFailure({ code:'not_found' }));
      const setup: SetupDocument = { type:'setup',version:1,id:reservation.setupId,setupId:reservation.setupId,ownerAccountId:accountId,name:reservation.name,repoUrl:reservation.repoUrl,
        createdAt:reservation.createdAt,latestRevision:0,publicationDay:null,publicationsToday:0 };
      if (yield* store.commitPartition('setups',setup.setupId,snapshot.version,[{ type:'upsert',document:setup }])) return setup;
    }
    return yield* Effect.fail(new ServiceFailure({ code:'unavailable' }));
  });
}
// Advance only the unseen publication range; an older observation cannot regress it.
export function reconcileSetup(store: Store['Service'], accountId: string, setup: SetupDocument) {
  return changeAccount(store,accountId,(_snapshot,account) => {
    const reservation = account.setups.find((s) => s.setupId === setup.setupId);
    if (!reservation) throw new ServiceFailure({ code:'not_found' });
    const delta = Math.max(0,setup.latestRevision - reservation.publishedHead);
    if (reservation.state === 'ready' && delta === 0) return { mutations:[],value:undefined };
    return { mutations:[{ type:'upsert',document:{ ...account,seq:account.seq + delta + (reservation.state === 'reserved' ? 1 : 0),setups:account.setups.map((s) => s.setupId === setup.setupId ? { ...s,state:'ready' as const,publishedHead:Math.max(s.publishedHead,setup.latestRevision) } : s) } }],value:undefined };
  });
}
export interface AccountSetups { readonly snapshot: PartitionSnapshot; readonly account: AccountDocument; readonly setups: readonly { setup: SetupDocument; snapshot: PartitionSnapshot }[] }
// Repair reservations before advertising them, then retain one account snapshot for seq/decisions.
export function accountSetups(store: Store['Service'], accountId: string): Effect.Effect<AccountSetups,ServiceFailure> {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 32; attempt++) {
      const snapshot = yield* store.readPartition('accounts',accountId);
      const account = yield* Effect.try({ try:() => activeAccount(snapshot),catch:() => new ServiceFailure({ code:'unauthenticated' }) });
      if (account.setups.some((s) => s.state === 'reserved')) {
        for (const reservation of account.setups.filter((s) => s.state === 'reserved')) {
          const setup = yield* materialize(store,accountId,reservation);
          yield* reconcileSetup(store,accountId,setup);
        }
        continue;
      }
      const setups: { setup: SetupDocument; snapshot: PartitionSnapshot }[] = [];
      for (const reservation of account.setups) setups.push(yield* ownedSetup(store,accountId,reservation.setupId));
      // A failed checkpoint must not hide an already committed setup head.
      let reconciled = false;
      for (const { setup } of setups) if (setup.latestRevision > account.setups.find((s) => s.setupId === setup.setupId)!.publishedHead) {
        reconciled = (yield* reconcileSetup(store,accountId,setup).pipe(Effect.map(() => true),Effect.catch((error) => error.code === 'unavailable' || error.code === 'rate_limited' ? Effect.succeed(false) : Effect.fail(error)))) || reconciled;
      }
      if (reconciled) continue;
      return { snapshot,account,setups };
    }
    return yield* Effect.fail(new ServiceFailure({ code:'unavailable' }));
  });
}
export function setupRoute(request: ServiceRequest, principal: AuthenticatedPrincipal, store: Store['Service'], now: () => number): Effect.Effect<ServiceResponse | undefined,ServiceFailure> {
  return Effect.gen(function* () {
    if (request.path !== '/v1/setups') return undefined;
    if (request.method === 'GET') return { status:200,body:{ setups:(yield* accountSetups(store,principal.accountId)).setups.map(({ setup }) => projectSetup(setup)) } };
    if (request.method !== 'POST') return undefined;
    const registration = yield* Effect.try({ try:() => decodeRequestBody(SetupRegistrationSchema,request.body),catch:() => new ServiceFailure({ code:'invalid' }) });
    const reservation: SetupReservation = { setupId:newId(now()),...registration,createdAt:new Date(now()).toISOString(),state:'reserved',publishedHead:0 };
    yield* changeAccount(store,principal.accountId,(_snapshot,account) => {
      if (account.setups.length >= MAX_SETUPS) throw new ServiceFailure({ code:'limit_reached' });
      return { mutations:[{ type:'upsert',document:{ ...account,setups:[...account.setups,reservation] } }],value:undefined };
    });
    const setup = yield* materialize(store,principal.accountId,reservation);
    yield* reconcileSetup(store,principal.accountId,setup);
    return { status:201,body:projectSetup(setup) };
  });
}
