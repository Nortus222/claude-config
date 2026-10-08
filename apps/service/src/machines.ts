import { Effect } from 'effect';
import { decodeRequestBody, MachinePatchSchema, MAX_MACHINES, type MachineRecord } from '@nortuscc/hosted-protocol';
import type { AccountDocument, MachineDocument, ServiceDocument } from './documents.ts';
import type { PartitionSnapshot, Store, Mutation } from './store.ts';
import { ServiceFailure } from './errors.ts';
import type { AuthenticatedPrincipal } from './auth.ts';
import type { ServiceRequest, ServiceResponse } from './service.ts';

export function activeAccount(snapshot: PartitionSnapshot): AccountDocument {
  const account = snapshot.documents.find((d) => d.type === 'account');
  if (snapshot.closed || !account || account.type !== 'account' || account.state !== 'active') throw new ServiceFailure({ code: 'unauthenticated' });
  return account;
}

// Re-read and guard active lifecycle on each bounded account CAS attempt.
export function changeAccount<A>(store: Store['Service'], accountId: string,
  plan: (snapshot: PartitionSnapshot, account: AccountDocument) => { mutations: readonly Mutation[]; value: A }) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 32; attempt++) {
      const snapshot = yield* store.readPartition('accounts', accountId);
      const account = yield* Effect.try({ try: () => activeAccount(snapshot), catch: () => new ServiceFailure({ code: 'unauthenticated' }) });
      const result = yield* Effect.try({ try: () => plan(snapshot, account), catch: (error) => error instanceof ServiceFailure ? error : new ServiceFailure({ code: 'invalid' }) });
      if (yield* store.commitPartition('accounts', accountId, snapshot.version, result.mutations)) return result.value;
    }
    return yield* Effect.fail(new ServiceFailure({ code: 'unavailable' }));
  });
}
// Durable authenticated receipt allocation defines service arrival order across replicas.
export function reserveReceipt(store: Store['Service'], accountId: string) {
  return changeAccount(store,accountId,(_snapshot,account) => {
    const previous = account.lastReceipt ?? 0;
    if (!Number.isSafeInteger(previous) || previous < 0 || previous >= Number.MAX_SAFE_INTEGER) throw new ServiceFailure({ code:'unavailable' });
    const ticket = previous + 1;
    return { mutations:[{ type:'upsert',document:{ ...account,lastReceipt:ticket } }],value:ticket };
  });
}
export function projectMachine(machine: MachineDocument, documents: readonly ServiceDocument[]): MachineRecord {
  const status = documents.find((d) => d.type === 'status' && d.machineId === machine.machineId);
  return { machineId: machine.machineId, name: machine.name, os: machine.os, agents: machine.agents, policy: machine.policy,
    reportStatus: machine.reportStatus, createdAt: machine.createdAt, lastSeenAt: machine.lastSeenAt,
    status: machine.reportStatus && status?.type === 'status' ? status.summary : null };
}
export function registerMachine(store: Store['Service'], machine: MachineDocument) {
  return changeAccount(store, machine.accountId, (snapshot, account) => {
    if (snapshot.documents.some((d) => d.id === machine.id || (d.type === 'issuanceFence' && d.machineId === machine.machineId))) throw new ServiceFailure({ code: 'sign_in_expired' });
    if (snapshot.documents.filter((d) => d.type === 'machine').length >= MAX_MACHINES) throw new ServiceFailure({ code: 'limit_reached' });
    return { mutations: [{ type: 'upsert', document: machine }, { type: 'upsert', document: { ...account, seq: account.seq + 1 } }], value: machine };
  });
}
export function machineRoute(request: ServiceRequest, principal: AuthenticatedPrincipal, store: Store['Service']): Effect.Effect<ServiceResponse | undefined, ServiceFailure> {
  return Effect.gen(function* () {
    const { method, path } = request;
    if (method === 'GET' && path === '/v1/machines') {
      const snapshot = yield* store.readPartition('accounts', principal.accountId);
      yield* Effect.try({ try: () => activeAccount(snapshot), catch: () => new ServiceFailure({ code: 'unauthenticated' }) });
      return { status: 200, body: { machines: snapshot.documents.filter((d): d is MachineDocument => d.type === 'machine').map((d) => projectMachine(d, snapshot.documents)) } };
    }
    const match = /^\/v1\/machines\/([A-Za-z0-9-]{1,100})$/.exec(path);
    const signout = method === 'POST' && path === '/v1/auth/sign-out';
    if (!signout && (!match || !['PATCH', 'DELETE'].includes(method))) return undefined;
    const patch = method === 'PATCH' ? yield* Effect.try({ try: () => decodeRequestBody(MachinePatchSchema, request.body), catch: () => new ServiceFailure({ code: 'invalid' }) }) : undefined;
    const receipt = patch ? yield* reserveReceipt(store,principal.accountId) : 0;
    return yield* changeAccount<ServiceResponse>(store, principal.accountId, (snapshot, account) => {
      const machineId = signout ? principal.machineId : match![1];
      const machine = snapshot.documents.find((d) => d.type === 'machine' && d.machineId === machineId);
      if (!machine || machine.type !== 'machine') throw new ServiceFailure({ code: 'not_found' });
      if (patch) {
        const nameWins = patch.name !== undefined && receipt > (machine.fieldReceipts?.name ?? 0);
        const policyWins = patch.policy !== undefined && receipt > (machine.fieldReceipts?.policy ?? 0);
        const statusWins = patch.reportStatus !== undefined && receipt > (machine.fieldReceipts?.reportStatus ?? 0);
        if (!nameWins && !policyWins && !statusWins) return { mutations:[],value:{ status:200,body:projectMachine(machine,snapshot.documents) } };
        const changed: MachineDocument = { ...machine,
          ...(nameWins ? { name:patch.name! } : {}),
          ...(policyWins ? { policy:patch.policy! } : {}),
          ...(statusWins ? { reportStatus:patch.reportStatus! } : {}),
          fieldReceipts:{ ...machine.fieldReceipts,...(nameWins ? { name:receipt } : {}),...(policyWins ? { policy:receipt } : {}),...(statusWins ? { reportStatus:receipt } : {}) },
        };
        const mutations: Mutation[] = [{ type:'upsert',document:changed }];
        if (changed.name !== machine.name || changed.policy !== machine.policy || changed.reportStatus !== machine.reportStatus) mutations.push({ type:'upsert',document:{ ...account,seq:account.seq + 1 } });
        if (statusWins && patch.reportStatus === false) mutations.push({ type:'delete',id:`status:${machineId}` });
        return { mutations,value:{ status:200,body:projectMachine(changed,snapshot.documents) } };
      }
      const mutations: Mutation[] = [{ type:'upsert',document:{ ...account,seq:account.seq + 1 } }];
      mutations.push(signout ? { type: 'upsert', document: { ...machine, tokenHash: null } } : { type: 'delete', id: machine.id }, { type: 'delete', id: `status:${machineId}` });
      return { mutations, value: { status: 204 } };
    });
  });
}
