import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MachinePathsValue } from '@nortuscc/machine';
import { AgentError, AgentUnavailable, connectAgent } from '../src/agent-client.ts';

// connectAgent against a minimal protocol v3 server in this process: no agent runs.
const skip = process.platform === 'win32' ? 'the agent serves no socket on Windows' : false;
const TOKEN = 'the-token';

const STATUS = {
  at: '2026-10-06T12:00:00.000Z', policy: 'notify', paused: null, trusted: true, pending: [], drift: [], conflicts: [], probeErrors: [],
  counts: { pending: 0, held: 0, ready: 0, drift: 0 },
};

type Fake = { paths: MachinePathsValue; seen: Array<Record<string, unknown>>; close: () => Promise<void> };
type Answer = (request: Record<string, unknown>, socket: Socket) => void;

const send = (socket: Socket, record: unknown) => socket.write(JSON.stringify(record) + '\n');
const ok = (socket: Socket, id: unknown, result: unknown) => send(socket, { version: 3, id, ok: true, result });

// Answers hello with the token check, then hands every other request to `answer`. A short /tmp
// state root keeps the socket path under the Unix limit.
async function fake(answer: Answer = () => {}, options: { token?: boolean; listen?: boolean } = {}): Promise<Fake> {
  const stateRoot = mkdtempSync('/tmp/nac-');
  const dir = join(stateRoot, 'agent');
  mkdirSync(dir);
  if (options.token !== false) writeFileSync(join(dir, 'agent.token'), TOKEN);
  const seen: Array<Record<string, unknown>> = [];
  const sockets = new Set<Socket>();
  let server: Server | undefined;
  if (options.listen !== false) {
    server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      let pending = '';
      socket.on('data', (chunk) => {
        pending += chunk.toString('utf8');
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const request = JSON.parse(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          seen.push(request);
          if (request.command !== 'hello') answer(request, socket);
          else if (request.token !== TOKEN) {
            send(socket, { version: 3, id: request.id, ok: false, error: { code: 'UNAUTHORIZED', message: 'no' } });
            socket.end();
          } else ok(socket, request.id, { agentVersion: 'v', protocol: 3, policy: 'notify', paused: null });
        }
      });
    });
    await new Promise<void>((resolve) => server!.listen(join(dir, 'agent.sock'), resolve));
  }
  const paths: MachinePathsValue = {
    repo: stateRoot, claude: stateRoot, codex: stateRoot, codexOpenRouter: stateRoot, agentsSkills: stateRoot, stateRoot, backups: stateRoot,
  };
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    rmSync(stateRoot, { recursive: true, force: true });
  };
  return { paths, seen, close };
}

test('connectAgent says hello as the CLI with the token, then answers a request by its id', { skip }, async () => {
  const f = await fake((request, socket) => ok(socket, request.id, STATUS));
  try {
    const conn = await connectAgent(f.paths);
    try {
      assert.equal(conn.hello.policy, 'notify');
      const status = await conn.request<typeof STATUS>({ command: 'status' });
      assert.deepEqual(status, STATUS);
      assert.deepEqual(f.seen[0], { version: 3, id: f.seen[0]!.id, command: 'hello', token: TOKEN, client: 'cli' });
      assert.equal(f.seen[1]!.command, 'status');
      assert.equal(f.seen[1]!.version, 3);
      assert.notEqual(f.seen[1]!.id, f.seen[0]!.id);
    } finally {
      conn.close();
    }
  } finally {
    await f.close();
  }
});

test('responses out of order still settle the request they answer', { skip }, async () => {
  const held: Array<Record<string, unknown>> = [];
  const f = await fake((request, socket) => {
    held.push(request);
    if (held.length === 2) for (const r of [...held].reverse()) ok(socket, r.id, { policy: r.policy });
  });
  try {
    const conn = await connectAgent(f.paths);
    try {
      const [a, b] = await Promise.all([
        conn.request<{ policy: string }>({ command: 'setPolicy', policy: 'manual' }),
        conn.request<{ policy: string }>({ command: 'setPolicy', policy: 'notify' }),
      ]);
      assert.equal(a.policy, 'manual');
      assert.equal(b.policy, 'notify');
    } finally {
      conn.close();
    }
  } finally {
    await f.close();
  }
});

test('an error response rejects with AgentError carrying its code and message', { skip }, async () => {
  const f = await fake((request, socket) =>
    send(socket, { version: 3, id: request.id, ok: false, error: { code: 'PAUSED', message: 'the agent is paused' } }));
  try {
    const conn = await connectAgent(f.paths);
    try {
      await assert.rejects(conn.request({ command: 'resume' }), (error: unknown) =>
        error instanceof AgentError && error.code === 'PAUSED' && error.message === 'the agent is paused');
    } finally {
      conn.close();
    }
  } finally {
    await f.close();
  }
});

test('events reach every listener until it unsubscribes', { skip }, async () => {
  const f = await fake((request, socket) => {
    send(socket, { version: 3, event: 'status', status: STATUS });
    ok(socket, request.id, { subscribed: true });
  });
  try {
    const conn = await connectAgent(f.paths);
    try {
      const heard: unknown[] = [];
      const off = conn.onEvent((event) => heard.push(event));
      await conn.request({ command: 'subscribe' });
      assert.deepEqual(heard, [{ version: 3, event: 'status', status: STATUS }]);
      off();
      await conn.request({ command: 'subscribe' });
      assert.equal(heard.length, 1);
    } finally {
      conn.close();
    }
  } finally {
    await f.close();
  }
});

test('a record outside the protocol rejects the pending request', { skip }, async () => {
  const f = await fake((request, socket) => send(socket, { version: 3, id: request.id, ok: true }));
  try {
    const conn = await connectAgent(f.paths);
    try {
      await assert.rejects(conn.request({ command: 'status' }), AgentError);
    } finally {
      conn.close();
    }
  } finally {
    await f.close();
  }
});

test('a request past its timeout rejects', { skip }, async () => {
  const f = await fake();
  try {
    const conn = await connectAgent(f.paths);
    try {
      await assert.rejects(conn.request({ command: 'status' }, { timeoutMs: 50 }), (error: unknown) =>
        error instanceof AgentError && error.code === 'TIMEOUT');
    } finally {
      conn.close();
    }
  } finally {
    await f.close();
  }
});

test('a closed connection rejects what is still pending', { skip }, async () => {
  const f = await fake((_request, socket) => socket.destroy());
  try {
    const conn = await connectAgent(f.paths);
    try {
      await assert.rejects(conn.request({ command: 'status' }), AgentError);
    } finally {
      conn.close();
    }
  } finally {
    await f.close();
  }
});

test('connectAgent is AgentUnavailable with no token, no socket, a refused hello or a silent agent', { skip }, async () => {
  const noToken = await fake(undefined, { token: false });
  const noSocket = await fake(undefined, { listen: false });
  const refused = await fake();
  writeFileSync(join(refused.paths.stateRoot, 'agent', 'agent.token'), 'stale');
  // Accepts connections and never answers.
  const silentRoot = mkdtempSync('/tmp/nac-');
  mkdirSync(join(silentRoot, 'agent'));
  writeFileSync(join(silentRoot, 'agent', 'agent.token'), TOKEN);
  const sockets = new Set<Socket>();
  const silent = createServer((socket) => void sockets.add(socket));
  await new Promise<void>((resolve) => silent.listen(join(silentRoot, 'agent', 'agent.sock'), resolve));
  try {
    for (const f of [noToken, noSocket, refused]) await assert.rejects(connectAgent(f.paths), AgentUnavailable);
    const started = Date.now();
    await assert.rejects(connectAgent({ ...noToken.paths, stateRoot: silentRoot }, { timeoutMs: 100 }), AgentUnavailable);
    assert.ok(Date.now() - started < 2000, 'gave up at its timeout');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
    rmSync(silentRoot, { recursive: true, force: true });
    for (const f of [noToken, noSocket, refused]) await f.close();
  }
});
