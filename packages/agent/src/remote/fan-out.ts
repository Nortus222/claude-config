import { createHash } from 'node:crypto';
import { Cause, Effect } from 'effect';
import type { FsFailed } from '@nortuscc/machine';
import type { HostedFailure } from '@nortuscc/hosted-client';
import { normalizeSkillSource } from '@nortuscc/profile-engine';
import { AgentClock } from '../clock.ts';
import type { OperationCaller, OperationDispatch } from '../ipc/operation-dispatch.ts';
import { failureOf } from '../ipc/server.ts';
import { SessionError } from '../ipc/session.ts';
import type { AgentServices } from '../layer.ts';
import type { RunError } from '../runs.ts';
import { decodeOperationInput, type OperationInput, type OperationOutput } from '../operations/index.ts';
import { REMOTE_PROTOCOL } from './listener.ts';
import { PeerUnreachable, type PeerClient, type RemoteOperation } from './peer-client.ts';
import { RemoteStore, type KnownMachine } from './remote-store.ts';
import { TailscaleAccess, type TailscaleState, type TsPeer } from './tailscale.ts';

type Reach = OperationOutput<'myMachines'>['machines'][number]['reach'];
type Outcome = OperationOutput<'applySkillOnMachines'>['results'][number]['outcome'];
type Skill = OperationOutput<'machineSkills'>['skills'][number];
type Failure = SessionError | RunError | HostedFailure | FsFailed | PeerUnreachable;
// Fan-out runs only for a caller at this machine; other machines cannot fan out through it.
type LocalCaller = Exclude<OperationCaller, { readonly actor: 'remote' }>;

// Request IDs this agent fanned out, so a retry with the same caller request reaches the same runs.
const MAX_REQUESTS = 256;
const MAX_INTENT_PAGES = 50;
// How far back a retry looks for the run its request already started.
const MAX_RUN_PAGES = 5;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bounded = (text: string) => [...text].slice(0, 500).join('');

// Where a machine reference points now: this machine, a peer Tailscale reports online, or one that
// cannot be reached (offline or not one of the user's machines).
type Target =
  | { readonly kind: 'this'; readonly name: string }
  | { readonly kind: 'peer'; readonly peer: TsPeer; readonly name: string }
  | { readonly kind: 'offline'; readonly name: string }
  | { readonly kind: 'unknown' };

// The fan-out operations a local caller runs across the user's machines (ADR 0042). `this` runs
// through `dispatch` as the caller; another machine through `peers`, where it runs as the remote
// actor naming this machine. Nothing is queued for an unreachable machine.
export const makeFanOut = (deps: { readonly dispatch: OperationDispatch; readonly peers: PeerClient }) => {
  const requests = new Map<string, { readonly input: string; planId?: string; runId?: string }>();

  const tailnet = Effect.gen(function* () {
    const status = yield* (yield* TailscaleAccess).status();
    const known = yield* (yield* RemoteStore).get.pipe(Effect.map((s) => s.known), Effect.orElseSucceed((): ReadonlyArray<KnownMachine> => []));
    return { status, known };
  });

  const resolve = (ref: string) => Effect.gen(function* () {
    const { status, known } = yield* tailnet;
    if (ref === 'this') return { kind: 'this', name: typeof status === 'string' ? 'this machine' : status.self.hostName } satisfies Target;
    const peer = typeof status === 'string' ? undefined : status.peers.find((p) => p.nodeId === ref);
    if (peer?.online) return { kind: 'peer', peer, name: peer.hostName } satisfies Target;
    const name = peer?.hostName ?? known.find((k) => k.nodeId === ref)?.name;
    return (name === undefined ? { kind: 'unknown' } : { kind: 'offline', name }) satisfies Target as Target;
  });

  const offline = (name: string) => new SessionError('OFFLINE', `${name} can't be reached right now`);
  const unknown = () => new SessionError('UNKNOWN_KEY', 'That is not one of your machines on Tailscale');
  // One operation on a resolved machine, its input given without scope.
  const on = <N extends RemoteOperation>(caller: LocalCaller, target: Target, name: N, input: object): Effect.Effect<OperationOutput<N>, Failure, AgentServices> =>
    Effect.suspend(() => {
      const full = decodeOperationInput(name, { scope: { kind: 'machine' }, ...input });
      if (target.kind === 'this') return deps.dispatch(caller, name, full) as Effect.Effect<OperationOutput<N>, Failure, AgentServices>;
      if (target.kind === 'peer') return deps.peers.operation(target.peer, name, full, caller.actor);
      return Effect.fail(target.kind === 'offline' ? offline(target.name) : unknown());
    });
  // A peer that cannot be reached fails as OFFLINE.
  const asOffline = (name: string) => <A, R>(effect: Effect.Effect<A, Failure, R>) =>
    Effect.mapError(effect, (e): Exclude<Failure, PeerUnreachable> => e instanceof PeerUnreachable ? offline(name) : e);

  const reachOf = (peer: TsPeer) => deps.peers.hello(peer).pipe(
    Effect.map((hello): Reach => hello.protocol === REMOTE_PROTOCOL ? 'ok' : 'incompatible'),
    Effect.catch((error): Effect.Effect<Reach> => Effect.succeed(
      error instanceof PeerUnreachable
        ? error.reason === 'refused' ? 'remote-off' : error.reason === 'timeout' && /^windows$/i.test(peer.os) ? 'app-closed' : 'offline'
        // A peer that cannot check who is calling refuses everyone, as if remote access were off there.
        : error.code === 'FORBIDDEN' ? 'remote-off' : 'incompatible')),
  );

  const myMachines = Effect.gen(function* () {
    const { status, known } = yield* tailnet;
    const now = (yield* (yield* AgentClock).now).toISOString();
    const state: TailscaleState = typeof status === 'string' ? status : 'ready';
    const peers = typeof status === 'string' ? [] : status.peers;
    const ids = [...new Set([...peers.map((p) => p.nodeId), ...known.map((k) => k.nodeId)])];
    const machines = yield* Effect.forEach(ids, (nodeId) => Effect.gen(function* () {
      const peer = peers.find((p) => p.nodeId === nodeId);
      const remembered = known.find((k) => k.nodeId === nodeId);
      const reach: Reach = peer?.online ? yield* reachOf(peer) : 'offline';
      return { nodeId, name: peer?.hostName ?? remembered!.name, os: peer?.os ?? remembered!.os, reach,
        lastReachedAt: reach === 'ok' ? now : remembered?.lastReachedAt ?? null };
    }), { concurrency: 'unbounded' });
    const reached = machines.filter((m) => m.reach === 'ok').map(({ nodeId, name, os }) => ({ nodeId, name, os, lastReachedAt: now }));
    if (reached.length) yield* (yield* RemoteStore).remember(reached).pipe(Effect.ignore);
    machines.sort((a, b) => a.name.localeCompare(b.name) || a.nodeId.localeCompare(b.nodeId));
    return { tailscale: state, self: typeof status === 'string' ? null : { nodeId: status.self.nodeId, name: status.self.hostName, os: status.self.os }, machines };
  });

  // The target's declared skills from its effective intent, with installed state from its latest
  // inspection, plus what it has installed outside its configuration. Only `fresh` makes the target
  // inspect again, which waits out a run there and drops its pending previews.
  const machineSkills = (caller: LocalCaller, input: OperationInput<'machineSkills'>) => Effect.gen(function* () {
    const target = yield* resolve(input.machine);
    const name = target.kind === 'unknown' ? '' : target.name;
    const read = <N extends RemoteOperation>(op: N, args: object) => on(caller, target, op, args).pipe(asOffline(name));
    const inspected = yield* read('inspect', input.fresh ? {} : { cached: true });
    const declared: OperationOutput<'inspectIntent'>['items'][number][] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_INTENT_PAGES; page++) {
      const result = yield* read('inspectIntent', { section: 'skills', limit: 100, ...(cursor === undefined ? {} : { cursor }) });
      declared.push(...result.items);
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    // Skills in the shared store are `skill:<name>`; a skill put straight into an agent's own skills
    // folder is `undeclared:<target>:skills:<name>`, from no source the lock records.
    const items = new Map(inspected.items.filter((i) => i.key.startsWith('skill:')).map((i) => [i.key.slice('skill:'.length), i]));
    for (const i of inspected.items) {
      const direct = /^undeclared:[^:]+:skills:(.+)$/.exec(i.key)?.[1];
      if (direct !== undefined && !items.has(direct)) items.set(direct, { ...i, group: '' });
    }
    const skills: Skill[] = [];
    const names = new Set<string>();
    for (const item of declared) {
      if (item.kind !== 'skill') continue;
      names.add(item.name);
      const observed = items.get(item.name);
      const installed = observed !== undefined && (['ok', 'off-pin'].includes(observed.state) || (observed.state === 'disabled' && observed.disposition !== 'excluded'));
      const state = installed ? 'installed' : !item.enabled && item.choice === null ? 'profile-off' : 'absent';
      skills.push({ source: item.source, name: item.name, state, choice: item.choice, from: item.from });
    }
    for (const [skill, observed] of items) {
      if (names.has(skill)) continue;
      skills.push({ source: (observed.group && normalizeSkillSource(observed.group)) || null, name: skill, state: 'undeclared', choice: null, from: null });
    }
    return { inspectedAt: inspected.status?.at ?? (yield* (yield* AgentClock).now).toISOString(), skills };
  });

  // The run a request ID already started on a machine, among its most recent runs.
  const existingRun = (caller: LocalCaller, target: Target, requestId: string) => Effect.gen(function* () {
    let before: string | undefined;
    for (let page = 0; page < MAX_RUN_PAGES; page++) {
      const listed = yield* on(caller, target, 'listRuns', { limit: 100, ...(before === undefined ? {} : { before }) });
      const run = listed.runs.find((r) => r.intent.requestId === requestId);
      if (run) return run.runId;
      if (listed.nextBefore === null) return undefined;
      before = listed.nextBefore;
    }
    return undefined;
  }).pipe(Effect.orElseSucceed(() => undefined));

  // Preview then apply `skillNow` on one machine under a request ID derived from the caller's and the
  // change, so a retry, even after this agent restarts, reaches the run it started.
  const applyOn = (caller: LocalCaller, input: OperationInput<'applySkillOnMachines'>, ref: string) => Effect.gen(function* () {
    const target = yield* resolve(ref);
    const name = target.kind === 'unknown' ? ref : target.name;
    if (target.kind === 'offline') return { machine: ref, name, outcome: { status: 'offline' } as Outcome };
    if (target.kind === 'unknown') return { machine: ref, name, outcome: { status: 'refused', reason: unknown().message } as Outcome };
    const key = digest([caller.actor, input.requestId, ref]);
    const intent = digest([input.source, input.name, input.action, input.revision ?? null]);
    const requestId = digest([caller.actor, input.requestId, ref, intent]);
    const remembered = requests.get(key);
    if (remembered && remembered.input !== intent) return { machine: ref, name, outcome: { status: 'refused', reason: 'This request ID already belongs to a different change' } as Outcome };
    if (remembered?.runId) return { machine: ref, name, outcome: { status: 'started', runId: remembered.runId } as Outcome };
    const entry = remembered ?? { input: intent };
    if (!remembered) {
      if (requests.size >= MAX_REQUESTS) requests.delete(requests.keys().next().value!);
      requests.set(key, entry);
    }
    const apply = (planId: string) => on(caller, target, 'applyChange', { planId, requestId });
    const started = Effect.gen(function* () {
      // A retry after an uncertain apply re-applies the same plan, which the target answers with its run.
      const retried = entry.planId === undefined ? undefined : yield* apply(entry.planId).pipe(Effect.option);
      if (retried?._tag === 'Some') return retried.value;
      const preview = yield* on(caller, target, 'previewChange', { change: { kind: 'skillNow', source: input.source, name: input.name, action: input.action, ...(input.revision === undefined ? {} : { revision: input.revision }) } });
      entry.planId = preview.planId;
      return yield* apply(preview.planId);
    });
    const begun = (runId: string): Outcome => { entry.runId = runId; return { status: 'started', runId }; };
    return yield* started.pipe(
      Effect.map((applied): Outcome => applied.status === 'stale'
        ? { status: 'refused', reason: bounded(`${input.name} changed on ${name} while it was being prepared; try again`) }
        : begun(applied.run.runId)),
      Effect.catch((error): Effect.Effect<Outcome, never, AgentServices> => Effect.gen(function* () {
        if (error instanceof PeerUnreachable && error.reason !== 'timeout') return { status: 'offline' };
        // The request may already have a run: one this agent started before it restarted (the target
        // refuses the new plan as a conflict), or one whose acceptance did not answer in time.
        const uncertain = error instanceof PeerUnreachable || ('code' in error && error.code === 'REQUEST_CONFLICT');
        const runId = uncertain ? yield* existingRun(caller, target, requestId) : undefined;
        if (runId !== undefined) return begun(runId);
        return { status: 'refused', reason: bounded(error instanceof PeerUnreachable ? `${name} did not answer in time; try again with the same request` : failureOf(Cause.fail(error)).message) };
      })),
      Effect.map((outcome) => ({ machine: ref, name, outcome })),
    );
  });

  const applySkillOnMachines = (caller: LocalCaller, input: OperationInput<'applySkillOnMachines'>) => Effect.gen(function* () {
    const refs = input.machines === 'all'
      ? [...(yield* myMachines).machines.filter((m) => m.reach === 'ok').map((m) => m.nodeId), 'this']
      : [...new Set(input.machines)];
    return { results: yield* Effect.forEach(refs, (ref) => applyOn(caller, input, ref), { concurrency: 'unbounded' }) };
  });

  const machineRun = (caller: LocalCaller, input: OperationInput<'machineRun'>) => Effect.gen(function* () {
    const target = yield* resolve(input.machine);
    return yield* on(caller, target, 'getRun', { runId: input.runId }).pipe(asOffline(target.kind === 'unknown' ? '' : target.name));
  });

  return { myMachines, machineSkills, applySkillOnMachines, machineRun };
};
