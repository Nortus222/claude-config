import { dirname, join } from 'node:path';
import { Effect, Schema } from 'effect';
import { Fs, HistoryStore, type FsFailed, type MachinePathsValue, type RemoteOrigin } from '@nortuscc/machine';
import type { HostedFailure } from '@nortuscc/hosted-client';
import { TARGETS, decodeOverrides, overridesFromLegacyState } from '@nortuscc/profile-engine';
import { SetupsStore, revisionCommit, revisionSetupId } from '@nortuscc/sync';
import type { AgentHandle } from '../agent.ts';
import type { AgentServices } from '../layer.ts';
import {
  operationDefinitions, decodeOperationOutput, capabilityInventory, projectContext, HistoryTimeSchema, type OperationInput, type OperationName,
} from '../operations/index.ts';
import { RemoteStore, remoteAccessView, shareCapability } from '../remote/remote-store.ts';
import { makeFanOut } from '../remote/fan-out.ts';
import { peerClient, type PeerClient } from '../remote/peer-client.ts';
import { projectHistoryEvent } from '../operations/history.ts';
import { operationDigest, type RunError } from '../runs.ts';
import { AgentStateStore } from '../state.ts';
import { PROTOCOL_VERSION, type AppRuntime, type HistoryResult } from './protocol.ts';
import { SessionError, type AgentSession } from './session.ts';

const decodeHistoryTime = Schema.decodeUnknownSync(HistoryTimeSchema);
// One page of the history, newest first, from the store.
export const historyPage = (request: { readonly before?: HistoryResult['nextBefore']; readonly limit: number }) => Effect.gen(function* () {
  const events = yield* (yield* HistoryStore).read;
  // Per-instant append order stays stable when a clock rollback adds an older month.
  const sequences = new Map<number, number>();
  const ordered = events.flatMap((event) => {
    let at: number;
    try { at = Date.parse(decodeHistoryTime(event.at)); }
    catch { return []; }
    if (!Number.isFinite(at)) return [];
    const seq = sequences.get(at) ?? 0;
    sequences.set(at, seq + 1);
    return [{ event, at, seq }];
  }).sort((a, b) => b.at - a.at || b.seq - a.seq);
  const before = request.before ?? undefined;
  const beforeAt = before === undefined ? Infinity : Date.parse(before.at);
  const matching = ordered.filter((e) =>
    e.at < beforeAt || (e.at === beforeAt && before !== undefined && e.seq < before.seq));
  const kept = matching.slice(0, request.limit);
  const last = kept.at(-1);
  const result: HistoryResult = {
    events: kept.map((e) => e.event),
    nextBefore: matching.length > kept.length && last !== undefined
      ? { at: new Date(last.at).toISOString(), seq: last.seq } : null,
  };
  return result;
});

// Who is asking: a local client of the socket, an MCP client bound to an app runtime, or another
// machine, with what started the request there.
export type OperationCaller =
  | { readonly actor: 'app' | 'cli' }
  | { readonly actor: 'mcp'; readonly runtimeId: string }
  | { readonly actor: 'remote'; readonly machine: string; readonly origin: RemoteOrigin };

// Runs one shared operation for a caller. `input` is already decoded for `operation` by the transport.
export type OperationDispatch = (caller: OperationCaller, operation: OperationName, input: unknown)
  => Effect.Effect<unknown, SessionError | RunError | HostedFailure | FsFailed, AgentServices>;

export type OperationDeps = {
  readonly session: AgentSession;
  readonly paths: MachinePathsValue;
  readonly handle: AgentHandle;
  readonly appRuntime?: AppRuntime;
  readonly agentVersion: string;
  readonly platform: NodeJS.Platform;
  // How this agent reaches the user's other machines; tests point it at loopback.
  readonly peers?: PeerClient;
};

// Whether the installed desktop app can serve this agent's operations, and who owns the agent.
export const makeIdentity = (deps: Pick<OperationDeps, 'appRuntime' | 'agentVersion' | 'platform'>) => (expectedRuntimeId?: string) => Effect.gen(function* () {
  const state = yield* (yield* AgentStateStore).read;
  const runtime = deps.appRuntime;
  let reason: string | undefined;
  // The Windows app never takes over a CLI-installed agent (ADR 0040), so it names the hand-over instead.
  if (deps.platform === 'win32' && state.installedBy === 'cli') reason = 'The command-line tool manages this agent; run `nortuscc agent uninstall`, then restart the agent from the desktop app or reopen the app.';
  else if (!runtime || state.installedBy !== 'app') reason = 'Open the installed desktop app to configure its background agent.';
  else if (!(runtime.platform === 'darwin' && runtime.target === 'darwin-arm64') && !(runtime.platform === 'win32' && runtime.target === 'win32-x64')) reason = 'MCP requires the supported macOS arm64 or Windows x64 desktop runtime.';
  else if (state.agentVersion !== deps.agentVersion || runtime.runtimeId !== deps.agentVersion || state.appPath === undefined || dirname(state.appPath) !== runtime.appDirectory) reason = 'The app runtime changed; reopen the installed desktop app to reconnect.';
  else if (expectedRuntimeId !== undefined && expectedRuntimeId !== runtime.runtimeId) reason = 'The client runtime does not match the app; reconnect through the installed desktop app.';
  else {
    const fs = yield* Fs;
    const text = yield* fs.readText(runtime.metadataPath);
    try {
      const metadata = JSON.parse(text ?? 'null');
      if (!metadata || metadata.agentVersion !== runtime.runtimeId || metadata.appVersion !== runtime.version || metadata.target !== runtime.target) reason = 'The installed app changed; reopen it before using MCP.';
    } catch { reason = 'Installed app metadata is unavailable; reopen or repair the desktop app.'; }
  }
  return { state, app: { ownership: state.installedBy ?? null, version: runtime?.version ?? null, runtimeId: runtime?.runtimeId ?? null },
    operations: reason ? { available: false, reason } : { available: true } };
  });

export const makeOperationDispatch = (deps: OperationDeps): OperationDispatch => {
  const { handle, session } = deps;
  const identity = makeIdentity(deps);
  const context = (expectedRuntimeId?: string) => Effect.gen(function* () {
    const { state, app, operations } = yield* identity(expectedRuntimeId);
    const inspection = yield* deps.handle.inspection;
    const hosted = deps.handle.hosted ? yield* deps.handle.hosted.state : undefined;
    const trustedSetups = yield* (yield* SetupsStore).read;
    const fs = yield* Fs;
    const overrideText = yield* fs.readText(join(deps.paths.stateRoot, 'overrides.json'));
    const choices = overrideText === undefined
      ? overridesFromLegacyState(yield* fs.readText(join(deps.paths.stateRoot, 'state.json')))
      : decodeOverrides((() => { try { return JSON.parse(overrideText); } catch { return null; } })(), 'overrides.json');
    const pending = yield* fs.exists(join(deps.paths.stateRoot, 'agent/pending-update.json'));
    const share = yield* shareCapability;
    const mutation = pending ? {available:false,reason:'Desktop update recovery is pending; open the app before changing the machine.'} : operations;
    const diagnostics = [...(pending ? [mutation.reason!] : []), ...(operations.available ? [] : [operations.reason!]), ...(choices.issues.length ? ['Machine target choices are invalid; repair the machine overrides.'] : []), ...(!inspection ? ['Inspect the machine to load setup and target context.'] : [])];
    return projectContext({ app, agent: { version: deps.agentVersion, protocol: PROTOCOL_VERSION },
      targets: choices.issues.length ? [] : (choices.value.manageConfig === false ? [] : choices.value.configTargets ?? (inspection ? TARGETS : [])),
      setups: hosted?.enabled ? { state: 'available', items: hosted.setups.map(s => ({setupId:s.setupId, trusted: trustedSetups?.some(t => t.setupId === s.setupId && t.accountId === hosted.accountId) ?? false, revision:s.latestRevision})) }
        : inspection ? {state:'available',items:[{setupId: inspection.revision ? revisionSetupId(inspection.revision) : 'local', trusted:inspection.trusted, revision: inspection.revision ? revisionCommit(inspection.revision) : null}]}
        : {state:'unknown',reason:'The agent has no setup inspection yet.'},
      profiles: {state:'unavailable',reason:'Profile discovery is not available in the machine reconciliation workflow.'},
      account: hosted?.enabled ? hosted.auth === 'signed-in' && hosted.accountId ? {state:'signed-in',accountId:hosted.accountId} : {state:hosted.auth === 'unauthenticated' ? 'unauthenticated' : 'signed-out'} : {state:'unavailable',reason:'Hosted mode is not configured.'},
      policy:state.policy, paused:state.paused === null ? null : {reason:state.paused.reason,at:state.paused.at},
      scopes:{machine:operations,user:{available:false,reason:'User mutations are not supported.'},profile:{available:false,reason:'Profile mutations are not supported.'}},
      capabilities:Object.fromEntries(Object.entries(capabilityInventory).map(([name,capability]) => [name,name === 'getContext' ? {available:true} : name === 'shareWithMyMachines' ? share : name in operationDefinitions && operationDefinitions[name as keyof typeof operationDefinitions].mutation ? mutation : name in operationDefinitions ? operations : capability])), diagnostics,
    });
  });
  const fanOut = makeFanOut({ dispatch: (caller, operation, input) => dispatch(caller, operation, input), peers: deps.peers ?? peerClient() });
  const dispatch: OperationDispatch = (caller, operation, rawInput) => Effect.gen(function* () {
    const actor = caller.actor;
    const request = { operation, input: rawInput } as { [N in OperationName]: { readonly operation: N; readonly input: OperationInput<N> } }[OperationName];
    const name = request.operation;
    const args = request.input;
    if (args.scope.kind !== 'machine') return yield* Effect.fail(new SessionError('UNSUPPORTED_SCOPE', 'This operation supports machine scope only; use the owning app workflow for user or profile changes.'));
    if (name === 'setRemoteAccess' && caller.actor !== 'app' && caller.actor !== 'cli') return yield* Effect.fail(new SessionError('FORBIDDEN', 'Remote access can only be changed at this machine.'));
    if (caller.actor === 'remote' && (name === 'myMachines' || name === 'machineSkills' || name === 'applySkillOnMachines' || name === 'machineRun')) return yield* Effect.fail(new SessionError('FORBIDDEN', 'Other machines cannot fan out from this one.'));
    if (name !== 'getContext' && caller.actor === 'mcp') {
      const current = yield* identity(caller.runtimeId);
      if (!current.operations.available || caller.runtimeId !== deps.appRuntime?.runtimeId) return yield* Effect.fail(new SessionError('APP_UNAVAILABLE', current.operations.reason ?? 'The connected app runtime changed; reconnect through the installed desktop app.'));
    }
    let result: unknown;
    switch (request.operation) {
      case 'authorProfiles': result = yield* session.authorProfiles(request.input); break;
      case 'machineFile': result = yield* session.machineFile(request.input); break;
      case 'authorFile': result = yield* session.authorFile(request.input); break;
      case 'upstreams': result = yield* session.upstreams(request.input); break;
      case 'discoverUpstream': result = yield* session.discoverUpstream(request.input); break;
      case 'upstreamSkill': result = yield* session.upstreamSkill(request.input); break;
      case 'drafts': result = yield* session.drafts(request.input); break;
      case 'draftPreview': result = yield* session.draftPreview(request.input); break;
      case 'ghState': result = yield* session.ghState(request.input); break;
      case 'listBackups': result = yield* session.listBackups(request.input); break;
      case 'agentStatus': result = yield* session.agentStatus(request.input); break;
      case 'accountState': result = yield* session.accountState(request.input); break;
      case 'watchSources': result = yield* session.watchSources(request.input); break;
      case 'inspectSourceDiff': result = yield* session.inspectSourceDiff(request.input); break;
      case 'pinImpact': result = yield* session.pinImpact(request.input); break;
      case 'draftChangelog': result = yield* session.draftChangelog(request.input); break;
      case 'inspectProfiles': result = yield* session.inspectProfiles(request.input); break;
      case 'inspectShareLink': result = yield* session.inspectShareLink(request.input); break;
      case 'inspectSetups': result = yield* session.inspectSetups(request.input); break;
      case 'setupReview': result = yield* session.setupReview(request.input); break;
      case 'incomingChanges': result = yield* session.incomingChanges(request.input); break;
      case 'prepareTrustRequest': result = yield* session.prepareTrustRequest(request.input); break;
      case 'inspectUpdates': result = yield* session.inspectUpdates(request.input); break;
      case 'inspectIntent': result = yield* session.inspectIntent(request.input); break;
      case 'resolveSkillCandidate': result = yield* session.resolveSkillCandidate(request.input); break;
      case 'getContext': result = yield* context(caller.actor === 'mcp' ? caller.runtimeId : undefined); break;
      case 'inspect': result = yield* session.inspect(actor, { cached: request.input.cached === true }); break;
      case 'previewChange': result = yield* session.previewChange(request.input.change); break;
      case 'applyChange': {
        const apply = request.input;
        result = yield* session.runs.submit({ planId: apply.planId, requestId: apply.requestId, inputDigest: operationDigest(apply.planId), actor, ...(caller.actor === 'remote' ? { remoteMachine: caller.machine, remoteOrigin: caller.origin } : {}) }).pipe(
          Effect.map(run => ({status:'started',run})),
          Effect.catch(error => error.code === 'STALE_PLAN' && error.preview ? Effect.succeed({status:'stale',preview:error.preview}) : Effect.fail(error)),
        ); break;
      }
      case 'getRun': result = yield* session.runs.get(request.input.runId); break;
      case 'listRuns': result = yield* session.runs.list(request.input); break;
      case 'cancelRun':
      case 'abandonRun': {
        const fs = yield* Fs;
        const path = join(deps.paths.stateRoot, 'agent/pending-update.json');
        const pending = yield* fs.readText(path).pipe(Effect.mapError(() => new SessionError('LOCKED', 'Desktop maintenance state is unavailable; open or repair the app.')));
        if (pending !== undefined || (yield* fs.exists(path))) return yield* Effect.fail(new SessionError('LOCKED', 'Desktop update recovery is pending; open the app before changing the machine.'));
        result = yield* (request.operation === 'cancelRun' ? session.runs.cancel(request.input.runId) : session.runs.abandon(request.input.runId)); break;
      }
      case 'history': {
        const history = request.input;
        const legacy = yield* historyPage(history);
        result = { ...legacy, events: legacy.events.flatMap(event => {
          const projected = projectHistoryEvent(event);
          return projected ? [projected] : [];
        }) }; break;
      }
      case 'remoteAccess': result = yield* remoteAccessView; break;
      case 'setRemoteAccess': {
        yield* (yield* RemoteStore).setEnabled(request.input.enabled);
        result = yield* remoteAccessView; break;
      }
      case 'myMachines': result = yield* fanOut.myMachines; break;
      case 'machineSkills': if (caller.actor !== 'remote') result = yield* fanOut.machineSkills(caller, request.input); break;
      case 'applySkillOnMachines': if (caller.actor !== 'remote') result = yield* fanOut.applySkillOnMachines(caller, request.input); break;
      case 'machineRun': if (caller.actor !== 'remote') result = yield* fanOut.machineRun(caller, request.input); break;
      default: { const exhaustive: never = request; return exhaustive; }
    }
    return decodeOperationOutput(name, result);
  });
  return dispatch;
};
