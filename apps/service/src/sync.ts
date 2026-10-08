import { createHash } from 'node:crypto';
import { Effect } from 'effect';
import { decodeHosted, formatSyncQuery, parseSyncQuery, SyncResponseSchema } from '@nortuscc/hosted-protocol';
import type { AuthenticatedPrincipal } from './auth.ts';
import type { DecisionDocument } from './documents.ts';
import type { ServiceRequest, ServiceResponse } from './service.ts';
import type { Store } from './store.ts';
import { ServiceFailure } from './errors.ts';
import { accountSetups } from './setups.ts';
import { revisionRange } from './revisions.ts';

export function projectDecision(d: DecisionDocument) {
  return { setupId:d.setupId,itemId:d.itemId,revision:d.revision,decision:d.decision,decidedAt:d.decidedAt,machineId:d.machineId };
}
export function syncRoute(request: ServiceRequest, principal: AuthenticatedPrincipal, store: Store['Service'], pollAfter: number): Effect.Effect<ServiceResponse | undefined,ServiceFailure> {
  return Effect.gen(function* () {
    if (request.method !== 'GET' || request.path.split('?')[0] !== '/v1/sync') return undefined;
    const query = yield* Effect.try({ try:() => parseSyncQuery(new URLSearchParams(request.path.split('?')[1])),catch:() => new ServiceFailure({ code:'invalid' }) });
    const { snapshot,account,setups } = yield* accountSetups(store,principal.accountId);
    if (query.since > account.seq) return yield* Effect.fail(new ServiceFailure({ code:'invalid' }));
    for (const cursor of query.setups) {
      const owned = setups.find(({ setup }) => setup.setupId === cursor.setupId);
      if (!owned) return yield* Effect.fail(new ServiceFailure({ code:'not_found' }));
      if (cursor.revision > owned.setup.latestRevision) return yield* Effect.fail(new ServiceFailure({ code:'invalid' }));
    }
    const machine = snapshot.documents.find((d) => d.type === 'machine' && d.machineId === principal.machineId);
    if (!machine || machine.type !== 'machine') return yield* Effect.fail(new ServiceFailure({ code:'unauthenticated' }));
    const revisions = [];
    for (const { setup,snapshot:setupSnapshot } of setups) {
      const after = query.setups.find((s) => s.setupId === setup.setupId)?.revision ?? 0;
      const range = yield* Effect.try({ try:() => revisionRange(setupSnapshot,setup.latestRevision,after),catch:(e) => e as ServiceFailure });
      for (const r of range) revisions.push({ setupId:r.setupId,number:r.number,commitSha:r.commitSha,tag:r.tag,changelog:r.changelog,items:r.items,requiredEnv:r.requiredEnv });
    }
    const body = { seq:account.seq,decisions:snapshot.documents.filter((d): d is DecisionDocument => d.type === 'decision' && d.seq > query.since).sort((a,b) => a.seq - b.seq).map(projectDecision),
      revisions,machine:{ policy:machine.policy,reportStatus:machine.reportStatus },setups:setups.map(({ setup:s }) => ({ setupId:s.setupId,name:s.name,repoUrl:s.repoUrl,latestRevision:s.latestRevision })),pollAfter };
    yield* Effect.try({ try:() => decodeHosted(SyncResponseSchema,body),catch:() => new ServiceFailure({ code:'unavailable' }) });
    const etag = `"${createHash('sha256').update(JSON.stringify([formatSyncQuery(query).toString(),body])).digest('hex')}"`;
    if (request.headers['if-none-match'] === etag) return { status:304,headers:{ etag } };
    return { status:200,body,headers:{ etag } };
  });
}
