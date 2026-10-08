import { Effect, Schema } from 'effect';
import { decodeHosted, DecisionSchema, DecisionsRequestSchema, jsonByteLength, MAX_DECISIONS, MAX_REQUEST_BODY_BYTES, type Decision, type DecisionResult } from '@nortuscc/hosted-protocol';
import type { AuthenticatedPrincipal } from './auth.ts';
import type { DecisionDocument } from './documents.ts';
import type { ServiceRequest, ServiceResponse } from './service.ts';
import type { Store, Mutation } from './store.ts';
import { ServiceFailure } from './errors.ts';
import { ownedSetup } from './setups.ts';
import { changeAccount, reserveReceipt } from './machines.ts';

// Decode structure first so private or malformed fields cannot masquerade as count overflow.
const DecisionStructureSchema = Schema.Struct({ decisions:Schema.Array(DecisionSchema).check(Schema.isMinLength(1)) });
function decodeDecisionRequest(body: unknown) {
  if (jsonByteLength(body) > MAX_REQUEST_BODY_BYTES) throw new ServiceFailure({ code:'payload_too_large' });
  const request = decodeHosted(DecisionStructureSchema,body);
  if (request.decisions.length > MAX_DECISIONS) throw new ServiceFailure({ code:'limit_reached' });
  return decodeHosted(DecisionsRequestSchema,request);
}
const keyOf = (d: Decision) => `decision:${d.setupId}:${d.itemId}`;
// Position order is preserved even when duplicate targets coalesce into one upsert.
export function decisionRoute(request: ServiceRequest, principal: AuthenticatedPrincipal, store: Store['Service'], now: () => number): Effect.Effect<ServiceResponse | undefined,ServiceFailure> {
  return Effect.gen(function* () {
    if (request.method !== 'PUT' || request.path !== '/v1/decisions') return undefined;
    const sent = yield* Effect.try({ try:() => decodeDecisionRequest(request.body),catch:(error) => error instanceof ServiceFailure ? error : new ServiceFailure({ code:'invalid' }) });
    const ticket = yield* reserveReceipt(store,principal.accountId);
    for (const setupId of new Set(sent.decisions.map((d) => d.setupId))) {
      const { snapshot } = yield* ownedSetup(store,principal.accountId,setupId);
      for (const decision of sent.decisions.filter((d) => d.setupId === setupId)) {
        const revision = snapshot.documents.find((d) => d.type === 'revision' && d.number === decision.revision);
        if (!revision || revision.type !== 'revision' || !revision.items.some((i) => i.id === decision.itemId)) return yield* Effect.fail(new ServiceFailure({ code:'invalid' }));
      }
    }
    const results: DecisionResult[] = []; let seq = principal.account.seq;
    while (results.length < sent.decisions.length) {
      const chunk: Decision[] = []; const keys = new Set<string>();
      for (const entry of sent.decisions.slice(results.length)) {
        if (chunk.length === 99 || (!keys.has(keyOf(entry)) && keys.size === 98)) break;
        chunk.push(entry); keys.add(keyOf(entry));
      }
      const outcome = yield* changeAccount(store,principal.accountId,(snapshot,account) => {
        const existing = new Map(snapshot.documents.filter((d): d is DecisionDocument => d.type === 'decision').map((d) => [d.id,d]));
        const writes = new Map<string,DecisionDocument>(); const positions: DecisionResult[] = []; let nextSeq = account.seq;
        for (const [offset,entry] of chunk.entries()) {
          const position = results.length + offset;
          const key = keyOf(entry); const previous = existing.get(key);
          const previousOrder = previous?.receipt ?? { ticket:0,position:0 };
          const laterReceipt = previousOrder.ticket > ticket || (previousOrder.ticket === ticket && previousOrder.position > position);
          if (previous && (previous.revision > entry.revision || (previous.revision === entry.revision && laterReceipt))) {
            positions.push({ setupId:entry.setupId,itemId:entry.itemId,outcome:'stale' });
            continue;
          }
          const document: DecisionDocument = { ...entry,type:'decision',version:1,id:key,accountId:principal.accountId,receipt:{ ticket,position },seq:++nextSeq,decidedAt:new Date(now()).toISOString(),machineId:principal.machineId };
          existing.set(key,document); writes.set(key,document); positions.push({ setupId:entry.setupId,itemId:entry.itemId,outcome:'stored' });
        }
        const mutations: Mutation[] = [...writes.values()].map((document) => ({ type:'upsert',document }));
        if (writes.size > 0) mutations.push({ type:'upsert',document:{ ...account,seq:nextSeq } });
        return { mutations,value:{ seq:nextSeq,positions } };
      }).pipe(Effect.map((value) => ({ complete:true as const,value })),Effect.catch((error) => error.code === 'unavailable' || error.code === 'rate_limited' ? Effect.succeed({ complete:false as const }) : Effect.fail(error)));
      if (!outcome.complete) break;
      seq = outcome.value.seq; results.push(...outcome.value.positions);
    }
    for (const entry of sent.decisions.slice(results.length)) results.push({ setupId:entry.setupId,itemId:entry.itemId,outcome:'unprocessed' });
    return { status:200,body:{ seq,results } };
  });
}
