import { Effect, Schema } from 'effect';
import { decodeHosted, jsonByteLength, utf8ByteLength, MAX_CHANGELOG_BYTES, MAX_ITEMS, MAX_REQUEST_BODY_BYTES, MAX_REVISION_BYTES, MAX_REVISIONS, RevisionItemSchema, RevisionPublicationSchema, RevisionRecordSchema, type RevisionRecord } from '@nortuscc/hosted-protocol';
import type { AuthenticatedPrincipal } from './auth.ts';
import type { RevisionDocument } from './documents.ts';
import type { ServiceRequest, ServiceResponse } from './service.ts';
import type { Store, PartitionSnapshot } from './store.ts';
import { activeAccount } from './machines.ts';
import { ownedSetup, reconcileSetup } from './setups.ts';
import { ServiceFailure } from './errors.ts';

// Relax only count/byte bounds for classification; all nested structure remains strict.
const PublicationStructureSchema = Schema.Struct({ ...RevisionPublicationSchema.fields,
  changelog:Schema.String,
  items:Schema.Array(RevisionItemSchema).check(Schema.makeFilter((items) => new Set(items.map((item) => item.id)).size === items.length)),
});
function decodePublication(body: unknown) {
  if (jsonByteLength(body) > MAX_REQUEST_BODY_BYTES) throw new ServiceFailure({ code:'payload_too_large' });
  const publication = decodeHosted(PublicationStructureSchema,body);
  if (publication.items.length > MAX_ITEMS) throw new ServiceFailure({ code:'limit_reached' });
  if (utf8ByteLength(publication.changelog) > MAX_CHANGELOG_BYTES || jsonByteLength(publication) > MAX_REVISION_BYTES) throw new ServiceFailure({ code:'payload_too_large' });
  return decodeHosted(RevisionPublicationSchema,publication);
}
export function projectRevision(revision: RevisionDocument): RevisionRecord {
  return { setupId:revision.setupId,number:revision.number,commitSha:revision.commitSha,tag:revision.tag,changelog:revision.changelog,items:revision.items,requiredEnv:revision.requiredEnv,publishedAt:revision.publishedAt,machineId:revision.machineId };
}
// Require contiguous immutable records up to the observed head, never advertise missing bytes.
export function revisionRange(snapshot: PartitionSnapshot, head: number, after: number): readonly RevisionDocument[] {
  const revisions = snapshot.documents.filter((d): d is RevisionDocument => d.type === 'revision' && d.number > after && d.number <= head).sort((a,b) => a.number - b.number);
  if (revisions.length !== head - after || revisions.some((r,i) => r.number !== after + i + 1)) throw new ServiceFailure({ code:'unavailable' });
  return revisions;
}
export function revisionRoute(request: ServiceRequest, principal: AuthenticatedPrincipal, store: Store['Service'], now: () => number): Effect.Effect<ServiceResponse | undefined,ServiceFailure> {
  return Effect.gen(function* () {
    const [path,query] = request.path.split('?');
    const match = /^\/v1\/setups\/([A-Za-z0-9-]{1,100})\/revisions$/.exec(path);
    if (!match || !['GET','POST'].includes(request.method)) return undefined;
    const setupId = match[1];
    if (request.method === 'GET') {
      const after = yield* Effect.try({ try:() => {
        const params = new URLSearchParams(query);
        if ([...params.keys()].some((key) => key !== 'after') || params.getAll('after').length > 1) throw new Error();
        const value = params.get('after') ?? '0';
        if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error();
        return Number(value);
      },catch:() => new ServiceFailure({ code:'invalid' }) });
      const { setup,snapshot } = yield* ownedSetup(store,principal.accountId,setupId);
      if (after > setup.latestRevision) return yield* Effect.fail(new ServiceFailure({ code:'invalid' }));
      const all = yield* Effect.try({ try:() => revisionRange(snapshot,setup.latestRevision,after),catch:(e) => e as ServiceFailure });
      const page = all.slice(0,MAX_REVISIONS);
      return { status:200,body:{ revisions:page.map(projectRevision),nextAfter:all.length > page.length ? page.at(-1)!.number : null } };
    }
    const publication = yield* Effect.try({ try:() => decodePublication(request.body),catch:(error) => error instanceof ServiceFailure ? error : new ServiceFailure({ code:'invalid' }) });
    const record: RevisionRecord = { ...publication,setupId,publishedAt:new Date(now()).toISOString(),machineId:principal.machineId };
    if (jsonByteLength(record) > MAX_REVISION_BYTES) return yield* Effect.fail(new ServiceFailure({ code:'payload_too_large' }));
    yield* Effect.try({ try:() => decodeHosted(RevisionRecordSchema,record),catch:() => new ServiceFailure({ code:'invalid' }) });
    for (let attempt = 0; attempt < 32; attempt++) {
      const account = yield* store.readPartition('accounts',principal.accountId);
      yield* Effect.try({ try:() => activeAccount(account),catch:() => new ServiceFailure({ code:'unauthenticated' }) });
      const { setup,snapshot } = yield* ownedSetup(store,principal.accountId,setupId);
      if (snapshot.version === null) return yield* Effect.fail(new ServiceFailure({ code:'not_found' }));
      if (record.number !== setup.latestRevision + 1) return yield* Effect.fail(new ServiceFailure({ code:'revision_conflict' }));
      const day = new Date(now()).toISOString().slice(0,10);
      const count = setup.publicationDay === day ? setup.publicationsToday : 0;
      if (count >= 100) return yield* Effect.fail(new ServiceFailure({ code:'rate_limited',retryAfter:Math.max(1,Math.ceil((Date.parse(`${day}T00:00:00.000Z`) + 86400000 - now()) / 1000)) }));
      const changed = { ...setup,latestRevision:record.number,publicationDay:day,publicationsToday:count + 1 };
      if (yield* store.commitPartition('setups',setupId,snapshot.version,[{ type:'upsert',document:changed },{ type:'upsert',document:{ ...record,type:'revision',version:1,id:`revision:${record.number}` } }])) {
        yield* reconcileSetup(store,principal.accountId,changed);
        return { status:201,body:record };
      }
    }
    return yield* Effect.fail(new ServiceFailure({ code:'unavailable' }));
  });
}
