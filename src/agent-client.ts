import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import type { MachinePathsValue } from '@nortuscc/machine';
import { decodeHelloResult, decodeMessage, PROTOCOL_VERSION, type HelloResult } from '@nortuscc/agent';

// The agent answered a request with an error, or the connection failed while it was pending.
export class AgentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
  }
}

// No socket, no token, a refused hello, or no answer within the connect timeout.
export class AgentUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentUnavailable';
  }
}

// One connection to this machine's agent: hello, then requests answered in order of their ids.
export type AgentConnection = {
  readonly hello: HelloResult;
  // Sends `command` (`{ command, ...arguments }`); rejects with AgentError.
  readonly request: <A>(command: object, options?: { timeoutMs?: number }) => Promise<A>;
  readonly onEvent: (listener: (event: unknown) => void) => () => void;
  readonly close: () => void;
};

export const CONNECT_TIMEOUT_MS = 2000;

type Pending = { readonly resolve: (result: unknown) => void; readonly reject: (error: AgentError) => void; timer?: ReturnType<typeof setTimeout> };

// Connects to <stateRoot>/agent/agent.sock with a token read fresh from agent.token and says hello.
// Connecting and the hello together must finish within `timeoutMs` (2 s by default).
export const connectAgent = async (
  paths: MachinePathsValue,
  options: { timeoutMs?: number; client?: 'cli' } = {},
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
  let next = 0;
  let failure: AgentError | undefined;

  // Rejects everything pending and closes the socket; later requests reject with the same error.
  const fail = (error: AgentError) => {
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
        } catch {}
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

  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0 && failure === undefined) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      onRecord(line);
    }
  });
  socket.on('error', () => {});
  socket.on('close', () => fail(new AgentError('CLOSED', 'the agent closed the connection')));

  const request = <A>(command: object, opts: { timeoutMs?: number } = {}): Promise<A> =>
    new Promise<A>((resolve, reject) => {
      if (failure !== undefined) return reject(failure);
      const id = String(++next);
      const entry: Pending = { resolve: resolve as (result: unknown) => void, reject };
      if (opts.timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          pending.delete(id);
          reject(new AgentError('TIMEOUT', `the agent did not answer within ${opts.timeoutMs} ms`));
        }, opts.timeoutMs);
      }
      pending.set(id, entry);
      socket.write(JSON.stringify({ ...command, version: PROTOCOL_VERSION, id }) + '\n');
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
    close: () => fail(new AgentError('CLOSED', 'the connection was closed')),
  };
};
