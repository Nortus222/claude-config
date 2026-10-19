import { Effect } from 'effect';
import { MAX_SETUPS, type PublicSetup } from '@nortuscc/hosted-protocol';
import type { AuthenticatedPrincipal } from './auth.ts';
import type { SetupDocument, SubscriptionDocument } from './documents.ts';
import type { Store, PartitionSnapshot } from './store.ts';
import type { ServiceRequest, ServiceResponse } from './service.ts';
import { activeAccount, changeAccount } from './machines.ts';
import { ServiceFailure } from './errors.ts';

export function publicMetadata(setup: PublicSetup): PublicSetup {
  return { setupId:setup.setupId, name:setup.name, repoUrl:setup.repoUrl, profile:setup.profile, latestRevision:setup.latestRevision };
}
export function publicSetup(store: Store['Service'], setupId: string) {
  return Effect.gen(function* () {
    const snapshot = yield* store.readPartition('setups', setupId);
    const setup = snapshot.documents.find((d): d is SetupDocument => d.type === 'setup');
    if (snapshot.closed || !setup) return yield* Effect.fail(new ServiceFailure({ code:'not_found' }));
    return { setup, snapshot };
  });
}
// Revisions and personal decisions are readable only while the account follows the setup.
export function readableSetup(store: Store['Service'], accountId: string, setupId: string) {
  return Effect.gen(function* () {
    const accountSnapshot = yield* store.readPartition('accounts', accountId);
    yield* Effect.try({ try:() => activeAccount(accountSnapshot), catch:() => new ServiceFailure({ code:'unauthenticated' }) });
    const result = yield* publicSetup(store, setupId);
    if (result.setup.ownerAccountId !== accountId && !accountSnapshot.documents.some(d => d.type === 'subscription' && d.setupId === setupId)) {
      return yield* Effect.fail(new ServiceFailure({ code:'not_found' }));
    }
    return result;
  });
}
export interface SubscribedSetup {
  readonly setup: PublicSetup;
  readonly snapshot: PartitionSnapshot;
  readonly owned: false;
  readonly closed?: true;
}
export function subscribedSetups(store: Store['Service'], account: PartitionSnapshot): Effect.Effect<readonly SubscribedSetup[], ServiceFailure> {
  return Effect.gen(function* () {
    const result: SubscribedSetup[] = [];
    for (const subscription of account.documents.filter((d): d is SubscriptionDocument => d.type === 'subscription')) {
      const snapshot = yield* store.readPartition('setups', subscription.setupId);
      const setup = snapshot.documents.find((d): d is SetupDocument => d.type === 'setup');
      result.push({ setup:publicMetadata(setup && !snapshot.closed ? setup : subscription), snapshot, owned:false,
        ...(snapshot.closed || !setup ? { closed:true as const } : {}) });
    }
    return result;
  });
}
export function subscriptionRoute(request: ServiceRequest, principal: AuthenticatedPrincipal, store: Store['Service']): Effect.Effect<ServiceResponse | undefined, ServiceFailure> {
  return Effect.gen(function* () {
    const read = /^\/v1\/setups\/([A-Za-z0-9-]{1,100})\/public$/.exec(request.path);
    if (request.method === 'GET' && read) return { status:200, body:publicMetadata((yield* publicSetup(store, read[1])).setup) };
    const match = /^\/v1\/subscriptions\/([A-Za-z0-9-]{1,100})$/.exec(request.path);
    if (!match || !['PUT', 'DELETE'].includes(request.method)) return undefined;
    const setupId = match[1];
    const metadata = request.method === 'PUT' ? publicMetadata((yield* publicSetup(store, setupId)).setup) : undefined;
    yield* changeAccount(store, principal.accountId, (snapshot, account) => {
      const existing = snapshot.documents.find(d => d.type === 'subscription' && d.setupId === setupId);
      if (account.setups.some(s => s.setupId === setupId) || Boolean(existing) === Boolean(metadata)) return { mutations:[], value:undefined };
      const subscriptions = snapshot.documents.filter(d => d.type === 'subscription');
      if (metadata && account.setups.length + subscriptions.length >= MAX_SETUPS) throw new ServiceFailure({ code:'limit_reached' });
      return { mutations:[{ type:'upsert', document:{ ...account, seq:account.seq + 1 } }, metadata
        ? { type:'upsert', document:{ type:'subscription', version:1, id:`subscription:${setupId}`, accountId:principal.accountId, ...metadata } }
        : { type:'delete', id:existing!.id }], value:undefined };
    });
    return { status:204 };
  });
}
