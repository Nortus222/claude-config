import { projectHistoryEvent } from '../operations/history.ts';
import { HostedFailure } from '@nortuscc/hosted-client';
import { disabledHostedState } from '../hosted.ts';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { Cause, Data, Effect, FiberSet, Schema } from 'effect';
import { Fs, HistoryStore, liveLockHolder, type Decision, type MachinePathsValue } from '@nortuscc/machine';
import type { AgentHandle } from '../agent.ts';
import { AgentClock } from '../clock.ts';
import type { Notifier, Notification } from '../notifier.ts';
import type { AgentStatus } from '../job.ts';
import type { AgentServices } from '../layer.ts';
import { TARGETS, decodeOverrides, overridesFromLegacyState } from '@nortuscc/profile-engine';
import { AGENT_PIPE_FILE, SetupsStore, newPipeName, revisionCommit, revisionSetupId } from '@nortuscc/sync';
import { operationDefinitions, decodeOperationOutput, capabilityInventory, projectContext, HistoryTimeSchema } from '../operations/index.ts';
import { operationDigest, RunError } from '../runs.ts';
import { AgentStateStore } from '../state.ts';
import {
  toWireHostedState, decodeSignInResult, decodeMessage, decodeRequest, MAX_RECORD_BYTES, PROTOCOL_VERSION, toWireStatus,
  type AppRuntime, type ErrorCode, type HelloResult, type HistoryResult, type Request, type RunProgress,
} from './protocol.ts';
import { SessionError, type AgentSession } from './session.ts';

// The socket could not be set up: its directory, token or listener.
export class ServeFailed extends Data.TaggedError('ServeFailed')<{ readonly reason: string }> {
  override get message() {
    return `the agent cannot serve its socket: ${this.reason}`;
  }
}

// How long a new connection may stay silent before it is closed.
export const HANDSHAKE_MS = 10_000;
const NOTIFICATION_ACK_MS = 5000;
const MAX_NOTE_LENGTH = 4096;
// How long a refused connection may take to read its refusal.
const REFUSED_MS = 1000;
// How long shutdown may wait for its reply to reach a client that never reads.
const SHUTDOWN_MS = 1000;
// sun_path holds 104 bytes on macOS and the BSDs and 108 on Linux, including the terminating NUL.
const maxSocketPath = (platform: NodeJS.Platform) => platform === 'linux' ? 107 : 103;

type Client = 'app' | 'cli' | 'mcp';
type Connection = {
  readonly socket: Socket;
  client: Client | undefined;
  subscribed: boolean;
  operationEvents?: boolean;
  runtimeId?: string;
  receipts: Map<string, string>;
  pendingNotification?: { id: string; receipt: string; deadline: number; finish: (delivered: boolean) => void };
  timer: ReturnType<typeof setTimeout> | undefined;
};
// A handler's result, what to do once its reply is written, and what to do once it is flushed.
type Handled = { readonly result: unknown; readonly after?: () => void; readonly flushed?: () => void };

// Cuts `text` to at most `max` UTF-16 units without splitting a surrogate pair.
const truncate = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
};

const describe = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'object' && error !== null && '_tag' in error && typeof error._tag === 'string') return error._tag;
  return String(error);
};

const attempt = (what: string, run: () => Promise<unknown>) =>
  Effect.tryPromise({ try: run, catch: (error) => new ServeFailed({ reason: `${what}: ${describe(error)}` }) }).pipe(Effect.asVoid);

const digest = (text: string) => createHash('sha256').update(text).digest();

// The request's id when it has a usable one, so even a rejected request is answered by id.
const idOf = (raw: unknown) =>
  typeof raw === 'object' && raw !== null && 'id' in raw && typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 100 ? raw.id : 'invalid';

// Serves protocol v3 until the scope closes: on <stateRoot>/agent/agent.sock, or on Windows on a
// fresh named pipe whose name it writes to agent/agent.pipe once listening (ADR 0040). Writes a
// fresh token first; the caller holds agent.lock, so a socket or agent.pipe already there is stale
// and replaced. Closing the scope closes the server and every connection and removes the socket or
// agent.pipe, and the token.
export const serveIpc = (input: {
  readonly paths: MachinePathsValue;
  readonly platform: NodeJS.Platform;
  readonly handle: AgentHandle;
  readonly session: AgentSession;
  readonly agentVersion: string;
  readonly appRuntime?: AppRuntime;
  readonly onShutdown: () => void;
  readonly handshakeMs?: number;
  readonly notifier?: Notifier;
  readonly notificationTimeoutMs?: number;
}) =>
  Effect.gen(function* () {
    const { handle, session } = input;
    const dir = join(input.paths.stateRoot, 'agent');
    const pipe = input.platform === 'win32';
    // The endpoint is the address `listen` takes; `endpointFile` is what clients find it by.
    const endpoint = pipe ? newPipeName() : join(dir, 'agent.sock');
    const endpointFile = pipe ? join(dir, AGENT_PIPE_FILE) : endpoint;
    const tokenPath = join(dir, 'agent.token');
    const length = Buffer.byteLength(endpoint);
    const max = maxSocketPath(input.platform);
    if (!pipe && length > max) {
      return yield* Effect.fail(new ServeFailed({
        reason: `the socket path ${endpoint} is ${length} bytes, too long for a Unix socket (at most ${max})`,
      }));
    }

    // node:fs directly: the machine's Fs has no mkdir, chmod or mode-aware write. Every path here
    // comes from `input.paths`.
    yield* attempt(`create ${dir}`, async () => {
      await mkdir(dir, { recursive: true });
      await chmod(dir, 0o700);
    });
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => Promise.all([rm(endpointFile, { force: true }), rm(tokenPath, { force: true })]).then(() => {}, () => {})));
    const writePrivate = (path: string, text: string) => attempt(`write ${path}`, async () => {
      await writeFile(path, text, { mode: 0o600 });
      await chmod(path, 0o600);
    });
    const token = randomBytes(32).toString('base64url');
    const expected = digest(token);
    yield* writePrivate(tokenPath, token);
    yield* attempt(`remove ${endpointFile}`, () => rm(endpointFile, { force: true }));

    // Handlers run in this scope: closing it interrupts any still running.
    const run = yield* FiberSet.makeRuntime<AgentServices>();
    const connections = new Set<Connection>();
    // `closing` after a shutdown request; `stopped` once the scope closes.
    let closing = false;
    let stopped = false;
    let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
    let shutdownCalled = false;
    const finishShutdown = () => {
      clearTimeout(shutdownTimer);
      shutdownTimer = undefined;
      if (stopped || shutdownCalled) return;
      shutdownCalled = true;
      input.onShutdown();
    };

    // `flushed` runs once the line is handed to the OS, or at once when it cannot be written.
    const write = (conn: Connection, message: unknown, flushed?: () => void): boolean => {
      let line: string;
      try {
        line = JSON.stringify(decodeMessage(message)) + '\n';
      } catch {
        return false;
      }
      if (!conn.socket.destroyed && conn.socket.writable) conn.socket.write(line, () => flushed?.());
      else flushed?.();
      return true;
    };
    // Events over the record limit are dropped, never written.
    const event = (conn: Connection, message: { readonly event: string }) => {
      const line = JSON.stringify(message);
      if (Buffer.byteLength(line) + 1 > MAX_RECORD_BYTES) {
        process.stderr.write(`nortuscc agent: dropped a ${message.event} event over ${MAX_RECORD_BYTES} bytes\n`);
        return;
      }
      write(conn, JSON.parse(line));
    };
    const reject = (conn: Connection, id: string, code: ErrorCode, message: string, flushed?: () => void) =>
      void write(conn, { version: PROTOCOL_VERSION, id, ok: false, error: { code, message: truncate(message, 500) } }, flushed);
    const reply = (conn: Connection, id: string, result: unknown, flushed?: () => void) => {
      const line = JSON.stringify({ version: PROTOCOL_VERSION, id, ok: true, result });
      if (Buffer.byteLength(line) + 1 > MAX_RECORD_BYTES) return reject(conn, id, 'OVERSIZED', `Result exceeds ${MAX_RECORD_BYTES} bytes`, flushed);
      if (!write(conn, JSON.parse(line), flushed)) reject(conn, id, 'INTERNAL', 'The result does not match the protocol', flushed);
    };
    const refuse = (conn: Connection, id: string) => {
      reject(conn, id, 'UNAUTHORIZED', 'Send hello with the token from agent.token first');
      // Flushes the reply, then closes both directions; the timer covers a peer that never reads.
      conn.socket.end(() => conn.socket.destroy());
      clearTimeout(conn.timer);
      conn.timer = setTimeout(() => conn.socket.destroy(), REFUSED_MS);
    };
    const subscribers = () => [...connections].filter((c) => c.subscribed);

    // Run events go to the client that applied and to every subscriber. Domains may put captured
    // installer output in a note; capping it keeps every event within the record limit.
    const fanOut = (origin: Connection | undefined, runId: string, progress: RunProgress) => {
      const capped =
        progress.type === 'finished' ? { ...progress, note: truncate(progress.note, MAX_NOTE_LENGTH) }
        : progress.type === 'failed' ? { ...progress, message: truncate(progress.message, MAX_NOTE_LENGTH) }
        : progress;
      const message = { version: PROTOCOL_VERSION, event: 'progress', runId, progress: capped };
      for (const conn of new Set([...(origin ? [origin] : []), ...subscribers()])) event(conn, message);
    };

    // Only app subscribers receive receipt invalidations. Legacy progress remains unchanged.
    const disposeRuns = session.runs.onChange(runId => {
      const message = { version: PROTOCOL_VERSION, event: 'operation-run', runId };
      for (const conn of subscribers()) if (conn.client === 'app' && conn.operationEvents) event(conn, message);
    });
    yield* Effect.addFinalizer(() => Effect.sync(disposeRuns));

    const disposeProgress = session.onProgress((runId, progress) => fanOut(undefined, runId, progress));
    yield* Effect.addFinalizer(() => Effect.sync(disposeProgress));

    const liveStatus = (status: AgentStatus) =>
      Effect.map(session.running, (running) => ({
        ...toWireStatus(status), applying: running || liveLockHolder(join(input.paths.stateRoot, 'apply.lock')) !== undefined,
      }));
    const unsubscribe = handle.onStatus((status, cause) => {
      void run(Effect.map(liveStatus(status), (status) => {
        const message = { version: PROTOCOL_VERSION, event: 'status', status, ...(cause ? { runId: cause.runId } : {}) };
        for (const conn of subscribers()) event(conn, message);
      }));
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

    // Only OS posting acknowledged by the selected app counts as delivery.
    const deliverNotification = (notification: Notification) => {
      const apps = subscribers().filter((c) => c.client === 'app');
      const ackMs = input.notificationTimeoutMs ?? NOTIFICATION_ACK_MS;
      return {
        // One interval per app, plus a bounded allowance for scheduling and cleanup.
        timeoutMs: (apps.length + 1) * ackMs,
        deliver: Effect.gen(function* () {
          for (const conn of apps) {
            if (conn.socket.destroyed) continue;
            const delivered = yield* Effect.callback<boolean>((resume) => {
              const receipt = randomBytes(32).toString('base64url');
              let finished = false;
              const finish = (delivered: boolean) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                conn.pendingNotification = undefined;
                resume(Effect.succeed(delivered));
              };
              const timer = setTimeout(() => finish(false), ackMs);
              conn.pendingNotification = { id: notification.id, receipt, deadline: Date.now() + ackMs, finish };
              const message = { version: PROTOCOL_VERSION, event: 'notification', notification, receipt };
              event(conn, message);
              return Effect.sync(() => finish(false));
            });
            if (delivered) return true;
          }
          return false;
        }),
      };
    };
    input.notifier?.setConnected(deliverNotification);
    yield* Effect.addFinalizer(() => Effect.sync(() => input.notifier?.setConnected(undefined)));

    const identity = (expectedRuntimeId?: string) => Effect.gen(function* () {
      const state = yield* (yield* AgentStateStore).read;
      const runtime = input.appRuntime;
      let reason: string | undefined;
      // The Windows app never takes over a CLI-installed agent (ADR 0040), so it names the hand-over instead.
      if (input.platform === 'win32' && state.installedBy === 'cli') reason = 'The command-line tool manages this agent; run `nortuscc agent uninstall`, then restart the agent from the desktop app or reopen the app.';
      else if (!runtime || state.installedBy !== 'app') reason = 'Open the installed desktop app to configure its background agent.';
      else if (!(runtime.platform === 'darwin' && runtime.target === 'darwin-arm64') && !(runtime.platform === 'win32' && runtime.target === 'win32-x64')) reason = 'MCP requires the supported macOS arm64 or Windows x64 desktop runtime.';
      else if (state.agentVersion !== input.agentVersion || runtime.runtimeId !== input.agentVersion || state.appPath === undefined || dirname(state.appPath) !== runtime.appDirectory) reason = 'The app runtime changed; reopen the installed desktop app to reconnect.';
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
    const hello = (client: Client, expectedRuntimeId?: string) => Effect.gen(function* () {
      const { state, app, operations } = yield* identity(expectedRuntimeId);
      const result: HelloResult = {
        agentVersion: input.agentVersion, protocol: PROTOCOL_VERSION, policy: state.policy,
        paused: state.paused === null ? null : { reason: state.paused.reason, at: state.paused.at },
        ...(input.appRuntime || client === 'mcp' ? { operationsProtocol: 1 as const, app, operations } : {}),
      };
      return result;
    });
    const context = (expectedRuntimeId?: string) => Effect.gen(function* () {
      const { state, app, operations } = yield* identity(expectedRuntimeId);
      const inspection = yield* handle.inspection;
      const hosted = handle.hosted ? yield* handle.hosted.state : undefined;
      const trustedSetups = yield* (yield* SetupsStore).read;
      const fs = yield* Fs;
      const overrideText = yield* fs.readText(join(input.paths.stateRoot, 'overrides.json'));
      const choices = overrideText === undefined
        ? overridesFromLegacyState(yield* fs.readText(join(input.paths.stateRoot, 'state.json')))
        : decodeOverrides((() => { try { return JSON.parse(overrideText); } catch { return null; } })(), 'overrides.json');
      const pending = yield* fs.exists(join(input.paths.stateRoot, 'agent/pending-update.json'));
      const mutation = pending ? {available:false,reason:'Desktop update recovery is pending; open the app before changing the machine.'} : operations;
      const diagnostics = [...(pending ? [mutation.reason!] : []), ...(operations.available ? [] : [operations.reason!]), ...(choices.issues.length ? ['Machine target choices are invalid; repair the machine overrides.'] : []), ...(!inspection ? ['Inspect the machine to load setup and target context.'] : [])];
      return projectContext({ app, agent: { version: input.agentVersion, protocol: PROTOCOL_VERSION },
        targets: choices.issues.length ? [] : (choices.value.manageConfig === false ? [] : choices.value.configTargets ?? (inspection ? TARGETS : [])),
        setups: hosted?.enabled ? { state: 'available', items: hosted.setups.map(s => ({setupId:s.setupId, trusted: trustedSetups?.some(t => t.setupId === s.setupId && t.accountId === hosted.accountId) ?? false, revision:s.latestRevision})) }
          : inspection ? {state:'available',items:[{setupId: inspection.revision ? revisionSetupId(inspection.revision) : 'local', trusted:inspection.trusted, revision: inspection.revision ? revisionCommit(inspection.revision) : null}]}
          : {state:'unknown',reason:'The agent has no setup inspection yet.'},
        profiles: {state:'unavailable',reason:'Profile discovery is not available in the machine reconciliation workflow.'},
        account: hosted?.enabled ? hosted.auth === 'signed-in' && hosted.accountId ? {state:'signed-in',accountId:hosted.accountId} : {state:hosted.auth === 'unauthenticated' ? 'unauthenticated' : 'signed-out'} : {state:'unavailable',reason:'Hosted mode is not configured.'},
        policy:state.policy, paused:state.paused === null ? null : {reason:state.paused.reason,at:state.paused.at},
        scopes:{machine:operations,user:{available:false,reason:'User mutations are not supported.'},profile:{available:false,reason:'Profile mutations are not supported.'}},
        capabilities:Object.fromEntries(Object.entries(capabilityInventory).map(([name,capability]) => [name,name === 'getContext' ? {available:true} : name in operationDefinitions && operationDefinitions[name as keyof typeof operationDefinitions].mutation ? mutation : name in operationDefinitions ? operations : capability])), diagnostics,
      });
    });
    // Until the start job finishes there is no status; answering at once beats making a client wait for a job.
    const latest = Effect.flatMap(handle.status, (status) =>
      (status === undefined ? Effect.fail(new SessionError('NO_REPORT', 'the agent is still starting')) : Effect.succeed(status)));
    const wire = <R>(effect: Effect.Effect<AgentStatus, unknown, R>): Effect.Effect<Handled, unknown, R> =>
      Effect.flatMap(effect, (status) => Effect.map(liveStatus(status), (result) => ({ result })));

    const decodeHistoryTime = Schema.decodeUnknownSync(HistoryTimeSchema);
    const historyPage = (request: { readonly before?: HistoryResult['nextBefore']; readonly limit: number }) => Effect.gen(function* () {
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

    const dispatch = (conn: Connection, request: Request, client: Client): Effect.Effect<Handled, unknown, AgentServices> => {
      if (client === 'mcp' && !['hello', 'operation'].includes(request.command)) return Effect.fail(new SessionError('UNAUTHORIZED', 'MCP connections use shared operations only; open the app for consent and service management.'));
      const hosted = handle.hosted;
      const hostedResult = (effect: Effect.Effect<unknown, unknown>) => Effect.andThen(effect,
        Effect.map(hosted?.state ?? Effect.succeed(disabledHostedState), (s) => ({ result: toWireHostedState(s) })));
      const unavailable = Effect.fail(new SessionError('NOT_SIGNED_IN', 'Hosted mode is not configured'));
      switch (request.command) {
        case 'operation': return Effect.gen(function* () {
          const name = request.operation;
          const args = request.input;
          if (args.scope.kind !== 'machine') return yield* Effect.fail(new SessionError('UNSUPPORTED_SCOPE', 'This operation supports machine scope only; use the owning app workflow for user or profile changes.'));
          if (name !== 'getContext' && client === 'mcp') {
            const current = yield* identity(conn.runtimeId);
            if (!current.operations.available || conn.runtimeId !== input.appRuntime?.runtimeId) return yield* Effect.fail(new SessionError('APP_UNAVAILABLE', current.operations.reason ?? 'The connected app runtime changed; reconnect through the installed desktop app.'));
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
            case 'getContext': result = yield* context(conn.runtimeId); break;
            case 'inspect': result = yield* session.inspect(client); break;
            case 'previewChange': result = yield* session.previewChange(request.input.change); break;
            case 'applyChange': {
              const apply = request.input;
              result = yield* session.runs.submit({ planId: apply.planId, requestId: apply.requestId, inputDigest: operationDigest(apply.planId), actor: client }).pipe(
                Effect.map(run => ({status:'started',run})),
                Effect.catch(error => error.code === 'STALE_PLAN' && error.preview ? Effect.succeed({status:'stale',preview:error.preview}) : Effect.fail(error)),
              ); break;
            }
            case 'getRun': result = yield* session.runs.get(request.input.runId); break;
            case 'listRuns': result = yield* session.runs.list(request.input); break;
            case 'cancelRun':
            case 'abandonRun': {
              const fs = yield* Fs;
              const path = join(input.paths.stateRoot, 'agent/pending-update.json');
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
            default: { const exhaustive: never = request; return exhaustive; }
          }
          return { result: decodeOperationOutput(name, result) };
        });
        case 'hostedState': return hostedResult(Effect.void);
        case 'signIn': return hosted ? Effect.map(hosted.signIn(request.name, request.reportStatus), (s) => ({ result: decodeSignInResult(s) })) : unavailable;
        case 'signOut': return hosted ? hostedResult(hosted.signOut()) : unavailable;
        case 'syncNow': return hosted ? hostedResult(hosted.sync()) : unavailable;
        case 'trustSetup': return hosted ? hostedResult(hosted.trust(request.setupId, client)) : unavailable;
        case 'machineSettings': return hosted ? hostedResult(hosted.machine(request.patch, client)) : unavailable;
        case 'notification':
          if (client !== 'app') return Effect.fail(new SessionError('UNAUTHORIZED', 'Notifications require an app connection'));
          return Effect.gen(function* () {
            const notification = input.notifier ? yield* input.notifier.get(request.notificationId) : undefined;
            for (const connection of connections) {
              for (const [id, bound] of connection.receipts) {
                if (input.notifier?.receipt(id) !== bound) connection.receipts.delete(id);
              }
            }
            let receipt = notification === undefined ? undefined : input.notifier?.receipt(request.notificationId);
            if (receipt !== undefined && [...connections].some((c) => c !== conn && c.receipts.get(request.notificationId) === receipt)) receipt = undefined;
            if (receipt !== undefined) conn.receipts.set(request.notificationId, receipt);
            return { result: { notification: notification ?? null, receipt: receipt ?? null } };
          });
        case 'notificationAck':
          if (client !== 'app') return Effect.fail(new SessionError('UNAUTHORIZED', 'Notifications require an app connection'));
          return Effect.sync(() => {
            const pending = conn.pendingNotification;
            if (pending?.id === request.notificationId && pending.receipt === request.receipt && Date.now() < pending.deadline) {
              pending.finish(request.delivered);
              return { result: { accepted: true } };
            }
            const bound = conn.receipts.get(request.notificationId);
            const accepted = bound === request.receipt && (input.notifier?.acknowledge(request.notificationId, request.delivered, request.receipt) ?? false);
            if (bound === request.receipt) conn.receipts.delete(request.notificationId);
            return { result: { accepted } };
          });
        case 'hello':
          return Effect.map(hello(client, conn.runtimeId), (result) => ({ result }));
        case 'status':
          return wire(latest);
        case 'inspect':
          return Effect.map(session.inspect(client), (result) => ({ result }));
        case 'preview':
          return Effect.map(session.preview(request.exclude), (result) => ({ result }));
        case 'apply':
          return Effect.suspend(() => {
            // Events wait for the reply, so the reply always precedes them.
            let replied = false;
            const queued: Array<readonly [string, RunProgress]> = [];
            const emit = (runId: string, progress: RunProgress) => {
              try {
                if (replied) fanOut(conn, runId, progress);
                else queued.push([runId, progress]);
              } catch {}
            };
            return Effect.map(session.apply(request.planId, client, emit), (result) => ({
              result,
              after: () => {
                replied = true;
                for (const [runId, progress] of queued.splice(0)) fanOut(conn, runId, progress);
              },
            }));
          });
        case 'cancel':
          return Effect.map(session.cancel, (cancelled) => ({ result: { cancelled } }));
        case 'decide':
          return wire(Effect.gen(function* () {
            const decidedAt = (yield* (yield* AgentClock).now).toISOString();
            const decisions = request.items.map((item): Decision => ({
              setupId: item.setupId, itemId: item.id, revision: typeof item.revision === 'number' ? item.revision : null, commit: typeof item.revision === 'string' ? item.revision : null, decision: item.decision,
              decidedAt, machineId: null, source: 'local',
            }));
            return yield* handle.decideAll(decisions, client);
          }));
        case 'setPolicy':
          return wire(handle.setPolicy(request.policy, client));
        case 'resume':
          return wire(handle.resume(client));
        case 'history': return Effect.map(historyPage(request), result => ({result}));
        case 'subscribe':
          return Effect.sync(() => {
            conn.subscribed = true;
            conn.operationEvents = client === 'app' && request.operationsProtocol === 1;
            return { result: { subscribed: true } };
          });
        case 'shutdown':
          return Effect.sync(() => {
            closing = true;
            // Give the reply time to flush before shutdown closes every socket.
            shutdownTimer = setTimeout(finishShutdown, SHUTDOWN_MS);
            return { result: { shutdown: true }, flushed: finishShutdown };
          });
      }
    };

    const answer = (conn: Connection, request: Request, client: Client) =>
      void run(dispatch(conn, request, client).pipe(
        Effect.matchCause({
          onSuccess: (handled) => {
            reply(conn, request.id, handled.result, handled.flushed);
            handled.after?.();
          },
          onFailure: (cause) => {
            if (Cause.hasInterruptsOnly(cause)) return reject(conn, request.id, 'SHUTDOWN', 'The agent is shutting down');
            const error = Cause.squash(cause);
            if (error instanceof HostedFailure) reject(conn, request.id, error.code === 'unauthenticated' ? 'NOT_SIGNED_IN' : 'INTERNAL', error.message);
            else if (error instanceof RunError) reject(conn, request.id, error.code as ErrorCode, error.message);
            else if (error instanceof SessionError) reject(conn, request.id, error.code, error.message);
            else reject(conn, request.id, 'INTERNAL', describe(error));
          },
        }),
      ));

    // One complete record, or `undefined` when it exceeded the record limit.
    const onRecord = (conn: Connection, record: Buffer | undefined) => {
      if (conn.timer !== undefined) {
        clearTimeout(conn.timer);
        conn.timer = undefined;
      }
      let raw: unknown;
      let parsed = record !== undefined;
      if (record !== undefined) {
        try {
          raw = JSON.parse(record.toString('utf8'));
        } catch {
          parsed = false;
        }
      }
      let request: Request | undefined;
      try {
        if (parsed) request = decodeRequest(raw);
      } catch {}
      // Until a valid hello, anything else closes the connection.
      if (conn.client === undefined || request?.command === 'hello') {
        if (request?.command !== 'hello' || !timingSafeEqual(digest(request.token), expected)) return refuse(conn, request?.id ?? idOf(raw));
        conn.client ??= request.client;
        if (request.client === 'mcp' && conn.client === 'mcp') conn.runtimeId ??= request.runtimeId;
      }
      if (record === undefined) return reject(conn, 'invalid', 'OVERSIZED', `Record exceeds ${MAX_RECORD_BYTES} bytes`);
      if (!parsed) return reject(conn, 'invalid', 'MALFORMED', 'Expected a JSON record');
      if (request === undefined) return reject(conn, idOf(raw), 'INVALID_REQUEST', 'Invalid protocol version, command or arguments');
      if (closing) return reject(conn, request.id, 'SHUTDOWN', 'The agent is shutting down');
      answer(conn, request, conn.client);
    };

    // JSON lines of at most MAX_RECORD_BYTES; an oversized record is discarded up to its newline.
    const accept = (socket: Socket) => {
      if (stopped) return void socket.destroy();
      const conn: Connection = { socket, client: undefined, subscribed: false, receipts: new Map(), timer: undefined };
      conn.timer = setTimeout(() => socket.destroy(), input.handshakeMs ?? HANDSHAKE_MS);
      connections.add(conn);
      let buffer = Buffer.alloc(0);
      let oversized = false;
      socket.on('data', (chunk: Buffer) => {
        let offset = 0;
        while (offset < chunk.length && !socket.destroyed && !socket.writableEnded) {
          const newline = chunk.indexOf(10, offset);
          const end = newline < 0 ? chunk.length : newline;
          const part = chunk.subarray(offset, end);
          if (!oversized && buffer.length + part.length <= MAX_RECORD_BYTES) buffer = Buffer.concat([buffer, part]);
          else {
            oversized = true;
            buffer = Buffer.alloc(0);
          }
          if (newline < 0) break;
          onRecord(conn, oversized ? undefined : buffer);
          buffer = Buffer.alloc(0);
          oversized = false;
          offset = newline + 1;
        }
      });
      socket.on('error', () => socket.destroy());
      socket.on('close', () => {
        conn.pendingNotification?.finish(false);
        conn.receipts.clear();
        clearTimeout(conn.timer);
        connections.delete(conn);
      });
    };

    const server = createServer(accept);
    yield* Effect.addFinalizer(() =>
      Effect.callback<void>((resume) => {
        closing = true;
        stopped = true;
        clearTimeout(shutdownTimer);
        shutdownTimer = undefined;
        for (const conn of connections) {
          clearTimeout(conn.timer);
          conn.pendingNotification?.finish(false);
          conn.socket.destroy();
        }
        connections.clear();
        if (!server.listening) return resume(Effect.void);
        server.close(() => resume(Effect.void));
      }));
    yield* Effect.callback<void, ServeFailed>((resume) => {
      const onError = (error: Error) => resume(Effect.fail(new ServeFailed({ reason: `listen on ${endpoint}: ${error.message}` })));
      server.once('error', onError);
      server.listen(endpoint, () => {
        server.off('error', onError);
        resume(Effect.void);
      });
    });
    server.on('error', () => {});
    // A pipe name is published only once listening, so a client never finds a name nobody holds,
    // and by rename, so a client never reads it half-written.
    if (pipe) {
      const partial = `${endpointFile}.partial`;
      yield* writePrivate(partial, `${endpoint}\n`);
      yield* attempt(`write ${endpointFile}`, () => rename(partial, endpointFile));
    } else yield* attempt(`chmod ${endpoint}`, () => chmod(endpoint, 0o600));
  });
