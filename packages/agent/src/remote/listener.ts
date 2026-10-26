import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Deferred, Effect, Exit, FiberSet, type Scope } from 'effect';
import { REMOTE_ORIGINS, type RemoteOrigin } from '@nortuscc/machine';
import type { OperationDispatch } from '../ipc/operation-dispatch.ts';
import { MAX_RECORD_BYTES, type ErrorCode } from '../ipc/protocol.ts';
import { failureOf, truncate } from '../ipc/server.ts';
import { SessionError } from '../ipc/session.ts';
import type { AgentServices } from '../layer.ts';
import { decodeOperationInput, type OperationName } from '../operations/index.ts';
import type { RemoteStore } from './remote-store.ts';
import { callerDecision, type TailscaleAccess, type TsSelf, type WhoisResult } from './tailscale.ts';

export const REMOTE_PORT = 47821;
export const REMOTE_PROTOCOL = 1;
// The operations another of the owner's machines may run here; the grid and fan-out retries need no more (ADR 0041).
export const REMOTE_OPERATIONS = ['inspect', 'inspectIntent', 'applyChange', 'previewChange', 'getRun', 'listRuns', 'getContext'] as const satisfies ReadonlyArray<OperationName>;
type RemoteOperation = typeof REMOTE_OPERATIONS[number];

const RECHECK = '30 seconds';
const WHOIS_MS = 60_000;
// An unknown caller is asked about again only after this, so refused traffic cannot flood the LocalAPI.
const UNKNOWN_MS = 5000;
const REFUSAL_LOG_MS = 60_000;
const MAX_CONNECTIONS = 64;
// As long as the session retains a plan.
const PLAN_MS = 600_000;
const MAX_PLANS = 256;
const HEADERS_MS = 10_000;
const REQUEST_MS = 30_000;

export type RemoteReply = { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: { readonly code: ErrorCode; readonly message: string } };
export type RemoteHello = { readonly protocol: typeof REMOTE_PROTOCOL; readonly agentVersion: string; readonly machine: { readonly name: string; readonly os: string }; readonly operations: ReadonlyArray<string> };

// Only Tailscale's own ranges, 100.64.0.0/10 and fd7a:115c:a1e0::/48: never a wildcard, loopback or LAN address.
export const tailscaleAddresses = (ips: ReadonlyArray<string>): string[] => ips.filter((ip) => {
  const v4 = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip);
  if (v4) return Number(v4[1]) >= 64 && Number(v4[1]) <= 127;
  return /^fd7a:115c:a1e0:/i.test(ip);
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hostPort = (host: string, port: number) => `${host.includes(':') ? `[${host}]` : host}:${port}`;
const stderrLog = (text: string) => { try { process.stderr.write(`nortuscc agent: ${text}\n`); } catch {} };

const respond = (res: ServerResponse, status: number, body: unknown, close = false) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', ...(close ? { connection: 'close' } : {}) });
  res.end(text);
};
const fail = (res: ServerResponse, status: number, code: ErrorCode, message: string, close = false) =>
  respond(res, status, { ok: false, error: { code, message: truncate(message, 500) } } satisfies RemoteReply, close);

// The body; 'oversized' once it passes the record limit; 'aborted' when the request closes unfinished.
const readBody = (req: IncomingMessage) => Effect.callback<Buffer | 'oversized' | 'aborted'>((resume) => {
  if (Number(req.headers['content-length'] ?? 0) > MAX_RECORD_BYTES) return resume(Effect.succeed('oversized'));
  // The caller may have gone while it was being identified.
  if (req.destroyed) return resume(Effect.succeed('aborted'));
  const chunks: Buffer[] = [];
  let size = 0;
  const off = () => {
    req.off('data', onData);
    req.off('end', onEnd);
    req.off('close', onClose);
    req.off('error', onClose);
  };
  const finish = (body: Buffer | 'oversized' | 'aborted') => { off(); chunks.length = 0; resume(Effect.succeed(body)); };
  const onData = (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_RECORD_BYTES) finish('oversized');
    else chunks.push(chunk);
  };
  const onEnd = () => finish(Buffer.concat(chunks));
  const onClose = () => finish('aborted');
  req.on('data', onData);
  req.on('end', onEnd);
  req.on('close', onClose);
  req.on('error', onClose);
  return Effect.sync(off);
});

// `addresses` are those asked for; `listening` those that bound.
type Bound = { readonly addresses: ReadonlyArray<string>; listening: ReadonlyArray<string>; servers: ReadonlyArray<Server>; self: TsSelf; hosts: ReadonlySet<string> };

// Serves REMOTE_OPERATIONS to the owner's other machines until the scope closes (ADR 0041). It listens
// only while remote access is on and Tailscale is running, on this node's Tailscale addresses, and
// re-reads both every 30 s and whenever remote access is switched. Every request must come from a
// node Tailscale's `whois` names as another untagged, unshared node of this user; it then runs as
// `{ actor: 'remote', machine, origin }`, `origin` naming the caller's app, CLI or MCP. Refusals go
// to `log` (once a minute per address), never History. `bind` picks the addresses to listen on (tests pass loopback); `onRequests` observes how many
// requests are in flight.
export const serveRemote = (deps: {
  readonly dispatch: OperationDispatch;
  readonly tailscale: TailscaleAccess['Service'];
  readonly store: RemoteStore['Service'];
  readonly agentVersion: string;
  readonly bind?: (ips: string[]) => string[];
  readonly port?: number;
  readonly log?: (line: string) => void;
  readonly onRequests?: (inFlight: number) => void;
}): Effect.Effect<never, never, Scope.Scope | AgentServices> =>
  Effect.gen(function* () {
    const run = yield* FiberSet.makeRuntime<AgentServices>();
    const bind = deps.bind ?? tailscaleAddresses;
    const port = deps.port ?? REMOTE_PORT;
    const log = deps.log ?? stderrLog;
    const logged = new Map<string, number>();
    const refuse = (res: ServerResponse, ip: string | undefined, reason: string) => {
      const now = Date.now();
      if ((logged.get(ip ?? '') ?? 0) <= now) {
        for (const [key, until] of logged) if (until <= now) logged.delete(key);
        logged.set(ip ?? '', now + REFUSAL_LOG_MS);
        log(`refused a remote request from ${ip ?? 'an unknown address'}: ${reason}`);
      }
      fail(res, 403, 'FORBIDDEN', 'This machine accepts requests only from its owner\'s other machines.', true);
    };
    const callers = new Map<string, { readonly who: WhoisResult | null; readonly until: number }>();
    const asking = new Map<string, Deferred.Deferred<WhoisResult | null>>();
    let inFlight = 0;
    const track = (delta: number) => { inFlight += delta; deps.onRequests?.(inFlight); };
    const plans = new Map<string, { readonly machine: string; readonly until: number }>();
    let current: Bound | undefined;

    const hostsFor = (addresses: ReadonlyArray<string>, self: TsSelf) =>
      new Set([...addresses.map((a) => hostPort(a, port)), ...(self.dnsName ? [hostPort(self.dnsName.replace(/\.$/, ''), port)] : [])].map((h) => h.toLowerCase()));

    // Tailscale's answer for this caller: one question per IP at a time, reused for a minute (5 s
    // when Tailscale does not know the caller).
    const identify = (ip: string, remotePort: number) => Effect.suspend((): Effect.Effect<WhoisResult | null> => {
      const now = Date.now();
      const hit = callers.get(ip);
      if (hit && hit.until > now) return Effect.succeed(hit.who);
      const waiting = asking.get(ip);
      if (waiting) return Deferred.await(waiting);
      const answer = Deferred.makeUnsafe<WhoisResult | null>();
      asking.set(ip, answer);
      return deps.tailscale.whois(hostPort(ip, remotePort)).pipe(
        Effect.tap((who) => Effect.sync(() => {
          for (const [key, entry] of callers) if (entry.until <= now) callers.delete(key);
          callers.set(ip, { who, until: now + (who ? WHOIS_MS : UNKNOWN_MS) });
        })),
        Effect.onExit((exit) => Effect.sync(() => {
          asking.delete(ip);
          Deferred.doneUnsafe(answer, Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.succeed(null));
        })),
      );
    });

    const operate = (machine: string, body: Buffer) => Effect.gen(function* () {
      let raw: unknown;
      try { raw = JSON.parse(body.toString('utf8')); } catch { return yield* Effect.fail(new SessionError('MALFORMED', 'Expected a JSON body')); }
      if (!isRecord(raw)) return yield* Effect.fail(new SessionError('INVALID_REQUEST', 'Expected { protocol, origin, operation, input }'));
      if (raw.protocol !== REMOTE_PROTOCOL) return yield* Effect.fail(new SessionError('INCOMPATIBLE', `This machine speaks remote protocol ${REMOTE_PROTOCOL}.`));
      // What started the request on the calling machine, recorded with its run.
      if (!(REMOTE_ORIGINS as ReadonlyArray<unknown>).includes(raw.origin)) return yield* Effect.fail(new SessionError('INVALID_INPUT', 'Expected origin app, cli or mcp'));
      const origin = raw.origin as RemoteOrigin;
      const name = raw.operation;
      if (!(REMOTE_OPERATIONS as ReadonlyArray<unknown>).includes(name)) return yield* Effect.fail(new SessionError('UNSUPPORTED_OPERATION', `${String(name)} is not available to other machines.`));
      const operation = name as RemoteOperation;
      const change = isRecord(raw.input) && isRecord(raw.input.change) ? raw.input.change.kind : undefined;
      if (operation === 'previewChange' && change !== 'skillNow') return yield* Effect.fail(new SessionError('UNSUPPORTED_OPERATION', 'Other machines may preview only skillNow changes.'));
      let input: unknown;
      try { input = decodeOperationInput(operation, raw.input); } catch { return yield* Effect.fail(new SessionError('INVALID_REQUEST', `Invalid input for ${operation}`)); }
      const now = Date.now();
      for (const [id, plan] of plans) if (plan.until <= now) plans.delete(id);
      if (operation === 'applyChange' && plans.get((input as { planId: string }).planId)?.machine !== machine)
        return yield* Effect.fail(new SessionError('UNSUPPORTED_OPERATION', 'Other machines may apply only plans they previewed here.'));
      const result = yield* deps.dispatch({ actor: 'remote', machine, origin }, operation, input);
      if (operation === 'previewChange') {
        if (plans.size >= MAX_PLANS) plans.delete(plans.keys().next().value!);
        plans.set((result as { planId: string }).planId, { machine, until: now + PLAN_MS });
      }
      return result;
    });

    const handler = (bound: Bound) => (req: IncomingMessage, res: ServerResponse) => {
      const ip = req.socket.remoteAddress;
      const remotePort = req.socket.remotePort;
      // A browser always names its origin on a POST; DNS rebinding names a foreign host.
      if (req.headers.origin !== undefined) return refuse(res, ip, 'it came from a browser page');
      if (!bound.hosts.has((req.headers.host ?? '').toLowerCase())) return refuse(res, ip, `it named the host ${JSON.stringify(req.headers.host ?? '')}`);
      if (ip === undefined || remotePort === undefined) return refuse(res, ip, 'its address is unknown');
      track(1);
      void run(Effect.gen(function* () {
        const decision = callerDecision(yield* identify(ip, remotePort), bound.self);
        if (!decision.allow) return refuse(res, ip, `the caller is ${decision.reason}`);
        if (req.url === '/v1/hello') {
          if (req.method !== 'GET') return fail(res, 405, 'INVALID_REQUEST', 'Use GET /v1/hello');
          return respond(res, 200, { protocol: REMOTE_PROTOCOL, agentVersion: deps.agentVersion, machine: { name: bound.self.hostName, os: bound.self.os }, operations: REMOTE_OPERATIONS } satisfies RemoteHello);
        }
        if (req.url !== '/v1/operation') return fail(res, 404, 'INVALID_REQUEST', 'Unknown path');
        if (req.method !== 'POST') return fail(res, 405, 'INVALID_REQUEST', 'Use POST /v1/operation');
        const body = yield* readBody(req);
        if (body === 'aborted') return;
        // Drained, so the refusal reaches the caller before the connection closes.
        if (body === 'oversized') {
          req.resume();
          return fail(res, 413, 'OVERSIZED', `Body exceeds ${MAX_RECORD_BYTES} bytes`, true);
        }
        const reply = yield* operate(decision.machine, body).pipe(Effect.matchCause({
          onSuccess: (result): RemoteReply => ({ ok: true, result }),
          onFailure: (cause): RemoteReply => ({ ok: false, error: failureOf(cause) }),
        }));
        if (!reply.ok) return fail(res, 200, reply.error.code, reply.error.message);
        if (Buffer.byteLength(JSON.stringify(reply)) > MAX_RECORD_BYTES) return fail(res, 200, 'OVERSIZED', `Result exceeds ${MAX_RECORD_BYTES} bytes`);
        respond(res, 200, reply);
      }).pipe(
        Effect.catchCause(() => Effect.sync(() => { if (!res.headersSent) fail(res, 500, 'INTERNAL', 'The request failed'); })),
        Effect.ensuring(Effect.sync(() => track(-1))),
      ));
    };

    const open = (addresses: ReadonlyArray<string>, self: TsSelf) => Effect.gen(function* () {
      const bound: Bound = { addresses, listening: [], servers: [], self, hosts: new Set() };
      for (const address of addresses) {
        const server = createServer(handler(bound));
        server.headersTimeout = HEADERS_MS;
        server.requestTimeout = REQUEST_MS;
        server.maxConnections = MAX_CONNECTIONS;
        const ok = yield* Effect.callback<boolean>((resume) => {
          server.once('error', (error) => { log(`cannot listen for remote requests on ${hostPort(address, port)}: ${error.message}`); resume(Effect.succeed(false)); });
          server.listen({ host: address, port, exclusive: true }, () => resume(Effect.succeed(true)));
        });
        if (!ok) continue;
        server.on('error', () => {});
        bound.servers = [...bound.servers, server];
        bound.listening = [...bound.listening, address];
      }
      bound.hosts = hostsFor(bound.listening, self);
      return bound;
    });

    const close = Effect.suspend(() => {
      const closing = current;
      current = undefined;
      callers.clear();
      logged.clear();
      if (!closing) return Effect.void;
      return Effect.forEach(closing.servers, (server) => Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
        server.closeAllConnections();
      }), { discard: true });
    });
    yield* Effect.addFinalizer(() => Effect.andThen(close, deps.store.setListening(false)));

    const reconcile = Effect.gen(function* () {
      const enabled = yield* deps.store.get.pipe(Effect.map((s) => s.enabled), Effect.orElseSucceed(() => false));
      // Tailscale is never asked anything while remote access is off.
      const status = enabled ? yield* deps.tailscale.status() : 'not-running';
      const self = typeof status === 'string' ? undefined : status.self;
      const addresses = self ? bind(self.ips) : [];
      if (current && self && current.addresses.length === addresses.length && current.addresses.every((a, i) => a === addresses[i])) {
        current.self = self;
        current.hosts = hostsFor(current.listening, self);
        return;
      }
      yield* close;
      if (self && addresses.length > 0) {
        const bound = yield* open(addresses, self);
        if (bound.servers.length > 0) current = bound;
      }
      yield* deps.store.setListening(current !== undefined);
    });

    return yield* Effect.forever(Effect.gen(function* () {
      const changed = yield* deps.store.changed;
      yield* reconcile;
      yield* Effect.raceFirst(Effect.sleep(RECHECK), changed);
    }));
  });
