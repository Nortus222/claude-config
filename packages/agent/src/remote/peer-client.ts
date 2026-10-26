import { request } from 'node:http';
import { Effect } from 'effect';
import { MAX_RECORD_BYTES } from '../ipc/protocol.ts';
import { SessionError } from '../ipc/session.ts';
import type { RemoteOrigin } from '@nortuscc/machine';
import { decodeOperationOutput, type OperationInput, type OperationOutput } from '../operations/index.ts';
import { REMOTE_PORT, REMOTE_PROTOCOL, type RemoteHello, type REMOTE_OPERATIONS } from './listener.ts';
import type { TsPeer } from './tailscale.ts';

export type RemoteOperation = typeof REMOTE_OPERATIONS[number];
export type PeerAddress = { readonly host: string; readonly port: number };

// Why a peer's agent could not be asked: nothing listens (`refused`), no answer in time (`timeout`),
// or the network did not reach it (`unreachable`).
export class PeerUnreachable extends Error {
  readonly reason: 'refused' | 'timeout' | 'unreachable';
  constructor(reason: PeerUnreachable['reason']) {
    super(`The machine ${reason === 'refused' ? 'refused the connection' : reason === 'timeout' ? 'did not answer in time' : 'could not be reached'}`);
    this.reason = reason;
  }
}

// Asks the owner's other machines' agents over Tailscale (ADR 0041). `origin` tells the peer what
// started the request here. A peer's error reply fails as a SessionError with the peer's code; an
// unreadable reply as INCOMPATIBLE.
export type PeerClient = {
  readonly hello: (peer: TsPeer) => Effect.Effect<RemoteHello, PeerUnreachable | SessionError>;
  readonly operation: <N extends RemoteOperation>(peer: TsPeer, name: N, input: OperationInput<N>, origin: RemoteOrigin) => Effect.Effect<OperationOutput<N>, PeerUnreachable | SessionError>;
};

export const HELLO_MS = 3000;
export const OPERATION_MS = 30_000;

const hostPort = (host: string, port: number) => `${host.includes(':') ? `[${host}]` : host}:${port}`;
const incompatible = (message: string) => new SessionError('INCOMPATIBLE', message);

type Reply = { readonly status: number; readonly body: unknown };

// One request with an overall deadline; the Host header names the address dialled, as the listener requires.
const send = (address: PeerAddress, method: 'GET' | 'POST', path: string, timeoutMs: number, body?: unknown) =>
  Effect.callback<Reply, PeerUnreachable | SessionError>((resume) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    let settled = false;
    const settle = (effect: Effect.Effect<Reply, PeerUnreachable | SessionError>) => { if (!settled) { settled = true; clearTimeout(timer); resume(effect); } };
    const req = request({ host: address.host, port: address.port, method, path, agent: false,
      headers: { host: hostPort(address.host, address.port), ...(text === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }) } }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RECORD_BYTES) { req.destroy(); settle(Effect.fail(incompatible('The machine answered with more than this app accepts'))); }
        else chunks.push(chunk);
      });
      res.on('end', () => {
        try { settle(Effect.succeed({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })); }
        catch { settle(Effect.fail(incompatible('The machine answered in a form this app does not understand'))); }
      });
      res.on('error', () => settle(Effect.fail(new PeerUnreachable('unreachable'))));
    });
    const timer = setTimeout(() => { settle(Effect.fail(new PeerUnreachable('timeout'))); req.destroy(); }, timeoutMs);
    req.on('error', (error: NodeJS.ErrnoException) => settle(Effect.fail(new PeerUnreachable(error.code === 'ECONNREFUSED' ? 'refused' : 'unreachable'))));
    req.end(text);
    return Effect.sync(() => { settled = true; clearTimeout(timer); req.destroy(); });
  });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
// The peer's `{ ok: false, error }` envelope as the error it names.
const refusal = (body: unknown) => {
  const error = isRecord(body) && body.ok === false && isRecord(body.error) ? body.error : undefined;
  return error && typeof error.code === 'string' && typeof error.message === 'string'
    ? new SessionError(error.code as SessionError['code'], error.message)
    : incompatible('The machine answered in a form this app does not understand');
};

// `address` finds a peer's listener (default: its first Tailscale address on REMOTE_PORT); tests
// point it at loopback and shorten the timeouts.
export const peerClient = (options: { readonly address?: (peer: TsPeer) => PeerAddress; readonly helloTimeoutMs?: number; readonly operationTimeoutMs?: number } = {}): PeerClient => {
  const address = (peer: TsPeer) => Effect.suspend(() => {
    if (options.address) return Effect.succeed(options.address(peer));
    const ip = peer.ips[0];
    return ip === undefined ? Effect.fail(new PeerUnreachable('unreachable')) : Effect.succeed({ host: ip, port: REMOTE_PORT });
  });
  return {
    hello: (peer) => Effect.gen(function* () {
      const reply = yield* send(yield* address(peer), 'GET', '/v1/hello', options.helloTimeoutMs ?? HELLO_MS);
      if (reply.status !== 200) return yield* Effect.fail(refusal(reply.body));
      const hello = reply.body;
      if (!isRecord(hello) || typeof hello.protocol !== 'number' || !isRecord(hello.machine) || !Array.isArray(hello.operations)) return yield* Effect.fail(refusal(hello));
      return hello as unknown as RemoteHello;
    }),
    operation: (peer, name, input, origin) => Effect.gen(function* () {
      const reply = yield* send(yield* address(peer), 'POST', '/v1/operation', options.operationTimeoutMs ?? OPERATION_MS, { protocol: REMOTE_PROTOCOL, origin, operation: name, input });
      const body = reply.body;
      if (!isRecord(body) || body.ok !== true) return yield* Effect.fail(refusal(body));
      return yield* Effect.try({ try: () => decodeOperationOutput(name, body.result), catch: () => incompatible(`The machine answered ${name} in a form this app does not understand`) });
    }),
  };
};
