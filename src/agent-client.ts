import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import type { MachinePathsValue } from '@nortuscc/machine';
import { decodeHelloResult, decodeMessage, PROTOCOL_VERSION, MAX_RECORD_BYTES, type HelloResult } from '@nortuscc/agent/ipc/protocol';

// The agent answered a request with an error, sent a record outside the protocol, or did not answer
// in time (code TIMEOUT).
export class AgentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
  }
}

// No socket, no token, a refused hello, no answer within the connect timeout, or the connection
// closed while a request was pending.
export class AgentUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentUnavailable';
  }
}

// One connection to this machine's agent: hello, then requests answered in order of their ids.
export type AgentConnection = {
  readonly hello: HelloResult;
  // Sends `command` (`{ command, ...arguments }`); rejects with AgentError, or AgentUnavailable when
  // the connection closes first. Without `timeoutMs` it waits the connection's default for the command.
  readonly request: <A>(command: object, options?: { timeoutMs?: number }) => Promise<A>;
  readonly onEvent: (listener: (event: unknown) => void) => () => void;
  // Called once when the socket closes or errors, including after `close`; at once if it already has.
  readonly onClose: (listener: () => void) => () => void;
  readonly close: () => void;
};

export const CONNECT_TIMEOUT_MS = 2000;
export const REQUEST_TIMEOUT_MS = 30_000;
// inspect runs a job, and apply re-inspects before it answers.
export const INSPECT_TIMEOUT_MS = 120_000;
const LONG_COMMANDS = new Set(['inspect', 'apply']);

type Pending = { readonly resolve: (result: unknown) => void; readonly reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> };

// Connects to <stateRoot>/agent/agent.sock with a token read fresh from agent.token and says hello.
// Connecting and the hello together must finish within `timeoutMs` (2 s by default). Later requests
// time out after `requestTimeoutMs` (30 s), or `inspectTimeoutMs` (120 s) for inspect and apply.
export const connectAgent = async (
  paths: MachinePathsValue,
  options: { timeoutMs?: number; requestTimeoutMs?: number; inspectTimeoutMs?: number; client?: 'app' | 'cli' } = {},
): Promise<AgentConnection> => {
  const dir = join(paths.stateRoot, 'agent');
  let token: string;
  try {
    token = (await readFile(join(dir, 'agent.token'), 'utf8')).trim();
  } catch {
    throw new AgentUnavailable('the agent has no token');
  }
  if (token.length === 0) throw new AgentUnavailable('the agent has no token');

  const socket = createConnection(join(dir, 'agent.sock'));
  const pending = new Map<string, Pending>();
  const listeners = new Set<(event: unknown) => void>();
  const closeListeners = new Set<() => void>();
  let closed = false;
  let next = 0;
  let failure: Error | undefined;

  // Rejects everything pending and closes the socket; later requests reject with the same error.
  const fail = (error: Error) => {
    failure ??= error;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
    socket.destroy();
  };

  const onRecord = (line: string) => {
    let message;
    try {
      message = decodeMessage(JSON.parse(line));
    } catch {
      return fail(new AgentError('MALFORMED', 'the agent sent a record outside protocol v3'));
    }
    if ('event' in message) {
      for (const listener of [...listeners]) {
        try {
          listener(message);
        } catch {
          // A listener's failure is its own: it must not break the connection or the other listeners.
        }
      }
      return;
    }
    const p = pending.get(message.id);
    if (p === undefined) return;
    pending.delete(message.id);
    clearTimeout(p.timer);
    if (message.ok) p.resolve(message.result);
    else p.reject(new AgentError(message.error.code, message.error.message));
  };

  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0 && failure === undefined) {
      if (newline + 1 > MAX_RECORD_BYTES) return fail(new AgentError('OVERSIZED', 'the agent sent an oversized record'));
      const line = buffer.subarray(0, newline).toString('utf8');
      buffer = buffer.subarray(newline + 1);
      onRecord(line);
    }
    if (buffer.length >= MAX_RECORD_BYTES) fail(new AgentError('OVERSIZED', 'the agent sent an oversized record'));
  });
  // As with event listeners: one failing listener must not stop the others.
  const tell = (listener: () => void) => {
    try {
      listener();
    } catch {}
  };
  const onClosed = () => {
    fail(new AgentUnavailable('the agent closed the connection'));
    if (closed) return;
    closed = true;
    for (const listener of [...closeListeners]) tell(listener);
    closeListeners.clear();
  };
  socket.on('error', onClosed);
  socket.on('close', onClosed);

  const request = <A>(command: object, opts: { timeoutMs?: number } = {}): Promise<A> =>
    new Promise<A>((resolve, reject) => {
      if (failure !== undefined) return reject(failure);
      const id = String(++next);
      const line = JSON.stringify({ ...command, version: PROTOCOL_VERSION, id }) + '\n';
      if (Buffer.byteLength(line) > MAX_RECORD_BYTES) return reject(new AgentError('OVERSIZED', 'the request exceeds the record limit'));
      const entry: Pending = { resolve: resolve as (result: unknown) => void, reject };
      const name = (command as { command?: unknown }).command;
      const timeout = opts.timeoutMs
        ?? (typeof name === 'string' && LONG_COMMANDS.has(name) ? options.inspectTimeoutMs ?? INSPECT_TIMEOUT_MS : options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
      entry.timer = setTimeout(() => {
        pending.delete(id);
        reject(new AgentError('TIMEOUT', 'the agent did not answer in time'));
      }, timeout);
      pending.set(id, entry);
      socket.write(line);
    });

  const timeoutMs = options.timeoutMs ?? CONNECT_TIMEOUT_MS;
  let hello: HelloResult;
  try {
    hello = decodeHelloResult(await request({ command: 'hello', token, client: options.client ?? 'cli' }, { timeoutMs }));
  } catch (error) {
    fail(new AgentError('CLOSED', 'the connection was abandoned'));
    throw new AgentUnavailable(`the agent did not accept the connection: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    hello,
    request,
    onEvent: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    onClose: (listener) => {
      if (closed) {
        queueMicrotask(() => tell(listener));
        return () => {};
      }
      closeListeners.add(listener);
      return () => void closeListeners.delete(listener);
    },
    close: () => fail(new AgentError('CLOSED', 'the connection was closed')),
  };
};
