import { Effect } from 'effect';
import { AccountExportSchema, decodeHosted } from '@nortuscc/hosted-protocol';
import type { AuthenticatedPrincipal } from './auth.ts';
import type { DecisionDocument, MachineDocument } from './documents.ts';
import type { ServiceRequest, ServiceResponse } from './service.ts';
import type { Store } from './store.ts';
import { ServiceFailure } from './errors.ts';
import { accountSetups, projectSetup } from './setups.ts';
import { projectRevision, revisionRange } from './revisions.ts';
import { projectDecision } from './sync.ts';
import { projectMachine } from './machines.ts';

export function accountRoute(request: ServiceRequest, principal: AuthenticatedPrincipal, store: Store['Service']): Effect.Effect<ServiceResponse | undefined,ServiceFailure> {
  return Effect.gen(function* () {
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
