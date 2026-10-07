import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MachinePathsValue } from '@nortuscc/machine';
import { connectAgent, type AgentConnection } from '../src/agent-client.ts';
import { reminder, remindAfter } from '../src/reminder.ts';

// reminder against a minimal protocol v3 server in this process; no real home or agent is touched.
const skip = process.platform === 'win32' ? 'the agent serves no socket on Windows' : false;
const TOKEN = 'the-token';

const send = (socket: Socket, record: unknown) => socket.write(JSON.stringify(record) + '\n');

async function serve(counts: { pending: number; held: number; ready?: number }, delayMs = 0) {
  const stateRoot = mkdtempSync('/tmp/nac-');
  const dir = join(stateRoot, 'agent');
  mkdirSync(dir);
  writeFileSync(join(dir, 'agent.token'), TOKEN);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      let newline;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        const result = request.command === 'hello'
          ? { agentVersion: 'v', protocol: 3, policy: 'notify', paused: null }
          : { counts: { ready: 0, drift: 0, ...counts } };
        const answer = () => { if (!socket.destroyed) send(socket, { version: 3, id: request.id, ok: true, result }); };
        if (request.command === 'hello' || delayMs === 0) answer();
        else setTimeout(answer, delayMs);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(join(dir, 'agent.sock'), resolve));
  const paths: MachinePathsValue = {
    repo: stateRoot, claude: stateRoot, codex: stateRoot, codexOpenRouter: stateRoot, agentsSkills: stateRoot, stateRoot, backups: stateRoot,
  };
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(stateRoot, { recursive: true, force: true });
  };
  return { paths, close };
}

const run = async (paths: MachinePathsValue, extra: { connect?: typeof connectAgent; budgetMs?: number } = {}) => {
  const lines: string[] = [];
  await reminder(paths, { connect: connectAgent, write: (line) => lines.push(line), ...extra });
  return lines;
};

test('reminder prints the plural line when pending and held items wait', { skip }, async () => {
  const f = await serve({ pending: 2, held: 1, ready: 1 });
  try {
    assert.deepEqual(await run(f.paths), ['2 items wait for you: run nortuscc agent review']);
  } finally {
    await f.close();
  }
});

test('reminder prints the singular line for one item', { skip }, async () => {
  const f = await serve({ pending: 1, held: 1 });
  try {
    assert.deepEqual(await run(f.paths), ['1 item waits for you: run nortuscc agent review']);
  } finally {
    await f.close();
  }
});

test('reminder ignores pending items nobody has to decide on', { skip }, async () => {
  const f = await serve({ pending: 3, held: 0, ready: 0 });
  try {
    assert.deepEqual(await run(f.paths), []);
  } finally {
    await f.close();
  }
});

test('reminder prints nothing when nothing waits', { skip }, async () => {
  const f = await serve({ pending: 0, held: 0 });
  try {
    assert.deepEqual(await run(f.paths), []);
  } finally {
    await f.close();
  }
});

test('reminder prints nothing when no agent answers', async () => {
  const stateRoot = mkdtempSync('/tmp/nac-');
  try {
    const paths = { repo: stateRoot, claude: stateRoot, codex: stateRoot, codexOpenRouter: stateRoot, agentsSkills: stateRoot, stateRoot, backups: stateRoot };
    assert.deepEqual(await run(paths), []);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('reminder prints nothing, within the budget, when the agent is slow', { skip }, async () => {
  const f = await serve({ pending: 3, held: 0 }, 1000);
  try {
    const started = Date.now();
    assert.deepEqual(await run(f.paths, { budgetMs: 100 }), []);
    assert.ok(Date.now() - started < 500, 'returned within the budget');
  } finally {
    await f.close();
  }
});

test('reminder swallows a connect that throws and one that never settles', async () => {
  const paths = {} as MachinePathsValue;
  assert.deepEqual(await run(paths, { connect: () => { throw new Error('boom'); } }), []);
  const started = Date.now();
  assert.deepEqual(await run(paths, { connect: () => new Promise<AgentConnection>(() => {}), budgetMs: 50 }), []);
  assert.ok(Date.now() - started < 500);
});

test('remindAfter asks only for an interactive verb on a terminal, and survives failing paths', { skip }, async () => {
  const f = await serve({ pending: 1, held: 1 });
  try {
    const attempt = async (verb: string | undefined, interactive: boolean, paths = async () => f.paths) => {
      const lines: string[] = [];
      await remindAfter(verb, { interactive, paths, write: (line) => lines.push(line) });
      return lines;
    };
    assert.deepEqual(await attempt('status', true), ['1 item waits for you: run nortuscc agent review']);
    assert.deepEqual(await attempt('status', false), []);
    assert.deepEqual(await attempt('agent', true), []);
    assert.deepEqual(await attempt(undefined, true), []);
    assert.deepEqual(await attempt('status', true, async () => { throw new Error('no paths'); }), []);
  } finally {
    await f.close();
  }
});
