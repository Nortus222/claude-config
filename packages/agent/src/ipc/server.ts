import { HostedFailure } from '@nortuscc/hosted-client';
import { disabledHostedState } from '../hosted.ts';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { Cause, Data, Effect, FiberSet } from 'effect';
import { HistoryStore, liveLockHolder, type Decision, type MachinePathsValue } from '@nortuscc/machine';
import type { AgentHandle } from '../agent.ts';
import { AgentClock } from '../clock.ts';
import type { Notifier, Notification } from '../notifier.ts';
import type { AgentStatus } from '../job.ts';
import type { AgentServices } from '../layer.ts';
import { AgentStateStore } from '../state.ts';
import {
  decodeHostedState, decodeSignInResult, decodeMessage, decodeRequest, MAX_RECORD_BYTES, PROTOCOL_VERSION, toWireStatus,
  type ErrorCode, type HelloResult, type HistoryResult, type Request, type RunProgress,
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
const MAX_SOCKET_PATH = process.platform === 'linux' ? 107 : 103;

type Client = 'app' | 'cli';
type Connection = {
  readonly socket: Socket;
  client: Client | undefined;
  subscribed: boolean;
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

// Serves protocol v3 on <stateRoot>/agent/agent.sock until the scope closes. Writes a fresh token
// first; the caller holds agent.lock, so a socket already there is stale and replaced. Closing the
// scope closes the server and every connection and removes the socket and the token.
export const serveIpc = (input: {
  readonly paths: MachinePathsValue;
  readonly handle: AgentHandle;
  readonly session: AgentSession;
  readonly agentVersion: string;
  readonly onShutdown: () => void;
  readonly handshakeMs?: number;
  readonly notifier?: Notifier;
  readonly notificationTimeoutMs?: number;
}) =>
  Effect.gen(function* () {
    const { handle, session } = input;
    const dir = join(input.paths.stateRoot, 'agent');
    const socketPath = join(dir, 'agent.sock');
    const tokenPath = join(dir, 'agent.token');
    const length = Buffer.byteLength(socketPath);
    if (length > MAX_SOCKET_PATH) {
      return yield* Effect.fail(new ServeFailed({
        reason: `the socket path ${socketPath} is ${length} bytes, too long for a Unix socket (at most ${MAX_SOCKET_PATH})`,
      }));
    }

    // node:fs directly: the machine's Fs has no mkdir, chmod or mode-aware write. Every path here
    // comes from `input.paths`.
    yield* attempt(`create ${dir}`, async () => {
      await mkdir(dir, { recursive: true });
      await chmod(dir, 0o700);
    });
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => Promise.all([rm(socketPath, { force: true }), rm(tokenPath, { force: true })]).then(() => {}, () => {})));
    const token = randomBytes(32).toString('base64url');
    const expected = digest(token);
    yield* attempt(`write ${tokenPath}`, async () => {
      await writeFile(tokenPath, token, { mode: 0o600 });
      await chmod(tokenPath, 0o600);
    });
    yield* attempt(`remove ${socketPath}`, () => rm(socketPath, { force: true }));

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
    const fanOut = (origin: Connection, runId: string, progress: RunProgress) => {
      const capped =
        progress.type === 'finished' ? { ...progress, note: truncate(progress.note, MAX_NOTE_LENGTH) }
        : progress.type === 'failed' ? { ...progress, message: truncate(progress.message, MAX_NOTE_LENGTH) }
        : progress;
      const message = { version: PROTOCOL_VERSION, event: 'progress', runId, progress: capped };
      for (const conn of new Set([origin, ...subscribers()])) event(conn, message);
    };

    const liveStatus = (status: AgentStatus) =>
      Effect.map(session.running, (running) => ({
        ...toWireStatus(status), applying: running || liveLockHolder(join(input.paths.stateRoot, 'apply.lock')) !== undefined,
      }));
    const unsubscribe = handle.onStatus((status) => {
      void run(Effect.map(liveStatus(status), (status) => {
        const message = { version: PROTOCOL_VERSION, event: 'status', status };
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

    const hello = Effect.gen(function* () {
      const state = yield* (yield* AgentStateStore).read;
      const result: HelloResult = {
        agentVersion: input.agentVersion,
        protocol: PROTOCOL_VERSION,
        policy: state.policy,
        paused: state.paused === null ? null : { reason: state.paused.reason, at: state.paused.at },
      };
      return result;
    });
    // Until the start job finishes there is no status; answering at once beats making a client wait for a job.
    const latest = Effect.flatMap(handle.status, (status) =>
      (status === undefined ? Effect.fail(new SessionError('NO_REPORT', 'the agent is still starting')) : Effect.succeed(status)));
    const wire = <R>(effect: Effect.Effect<AgentStatus, unknown, R>): Effect.Effect<Handled, unknown, R> =>
      Effect.flatMap(effect, (status) => Effect.map(liveStatus(status), (result) => ({ result })));

    const dispatch = (conn: Connection, request: Request, client: Client): Effect.Effect<Handled, unknown, AgentServices> => {
      const hosted = handle.hosted;
      const hostedResult = (effect: Effect.Effect<unknown, unknown>) => Effect.andThen(effect,
        Effect.map(hosted?.state ?? Effect.succeed(disabledHostedState), (s) => ({ result: decodeHostedState(s) })));
      const unavailable = Effect.fail(new SessionError('NOT_SIGNED_IN', 'Hosted mode is not configured'));
      switch (request.command) {
        case 'hostedState': return hostedResult(Effect.void);
        case 'signIn': return hosted ? Effect.map(hosted.signIn(request.name), (s) => ({ result: decodeSignInResult(s) })) : unavailable;
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
          return Effect.map(hello, (result) => ({ result }));
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
        case 'history':
          return Effect.gen(function* () {
            const events = yield* (yield* HistoryStore).read;
            // Per-instant append order stays stable when a clock rollback adds an older month.
            const sequences = new Map<number, number>();
            const ordered = events.flatMap((event) => {
              const at = Date.parse(event.at);
              if (!Number.isFinite(at)) return [];
              const seq = sequences.get(at) ?? 0;
              sequences.set(at, seq + 1);
              return [{ event, at, seq }];
            }).sort((a, b) => b.at - a.at || b.seq - a.seq);
            const before = request.before;
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
            return { result };
          });
        case 'subscribe':
          return Effect.sync(() => {
            conn.subscribed = true;
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
      const onError = (error: Error) => resume(Effect.fail(new ServeFailed({ reason: `listen on ${socketPath}: ${error.message}` })));
      server.once('error', onError);
      server.listen(socketPath, () => {
        server.off('error', onError);
        resume(Effect.void);
      });
    });
    server.on('error', () => {});
    yield* attempt(`chmod ${socketPath}`, () => chmod(socketPath, 0o600));
  });
