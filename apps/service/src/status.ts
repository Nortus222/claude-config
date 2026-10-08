import { Effect } from 'effect';
import { decodeRequestBody, StatusSummarySchema } from '@nortuscc/hosted-protocol';
import type { AuthenticatedPrincipal } from './auth.ts';
import type { ServiceRequest, ServiceResponse } from './service.ts';
import type { Store } from './store.ts';
import { ServiceFailure } from './errors.ts';
import { ownedSetup } from './setups.ts';
import { revisionRange } from './revisions.ts';
import { changeAccount } from './machines.ts';

export function statusRoute(request: ServiceRequest, principal: AuthenticatedPrincipal, store: Store['Service']): Effect.Effect<ServiceResponse | undefined,ServiceFailure> {
  return Effect.gen(function* () {
    if (request.method !== 'PUT' || request.path !== '/v1/machines/self/status') return undefined;
    const summary = yield* Effect.try({ try:() => decodeRequestBody(StatusSummarySchema,request.body),catch:() => new ServiceFailure({ code:'invalid' }) });
    for (const report of summary.setups) {
      const { setup,snapshot } = yield* ownedSetup(store,principal.accountId,report.setupId);
      if (report.revisionApplied > setup.latestRevision) return yield* Effect.fail(new ServiceFailure({ code:'invalid' }));
      const history = yield* Effect.try({ try:() => revisionRange(snapshot,setup.latestRevision,0),catch:(e) => e as ServiceFailure });
      const known = new Set(history.flatMap((r) => r.items.map((i) => i.id)));
      if ([...report.adopted,...report.skipped,...report.pending,...report.waitingForPerson].some((id) => !known.has(id))) return yield* Effect.fail(new ServiceFailure({ code:'invalid' }));
    }
    return yield* changeAccount<ServiceResponse>(store,principal.accountId,(snapshot,_account) => {
      const machine = snapshot.documents.find((d) => d.type === 'machine' && d.machineId === principal.machineId);
      if (!machine || machine.type !== 'machine') throw new ServiceFailure({ code:'unauthenticated' });
      if (!machine.reportStatus) throw new ServiceFailure({ code:'status_disabled' });
      return { mutations:[{ type:'upsert',document:{ type:'status',version:1,id:`status:${principal.machineId}`,accountId:principal.accountId,machineId:principal.machineId,summary } }],value:{ status:204 } };
    });
  });
}
