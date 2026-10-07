import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MachinePathsValue } from '@nortuscc/machine';
import { connectAgent } from '../src/agent-client.ts';
import { run, type AgentDeps } from '../src/commands/agent.ts';
import type { Choice } from '../src/select.ts';

// `nortuscc agent review` with an injected picker and confirm, over the real client and a scripted
// protocol v3 server in this process: no agent runs and nothing on the machine changes.
const skip = process.platform === 'win32' ? 'the agent serves no socket on Windows' : false;
const TOKEN = 'the-token';

const item = (key: string, label: string) => ({ key, domain: 'config', label, group: 'files', state: 'differs', disposition: 'apply' });
const ITEMS = [item('config:a', 'a.md'), item('config:b', 'b.md'), item('config:c', 'c.md')];
const STATUS = {
  at: '2026-10-06T12:00:00.000Z', policy: 'notify', paused: null, trusted: true,
  pending: [
    { key: 'config:a', itemId: 'a', verdict: 'inert' },
    { key: 'config:b', itemId: 'b', verdict: 'held', reason: 'the hook runs a command' },
  ],
  drift: ['config:c'], conflicts: [], probeErrors: [],
  counts: { pending: 2, held: 1, ready: 1, drift: 1 },
};
const INSPECTED = {
  profile: { repo: '/repo', revision: null, overrides: '/state/overrides.json', issues: [] },
  items: ITEMS, probeErrors: [], status: STATUS,
};

const step = (key: string) => ({ key, domain: 'config', action: 'write-file', summary: `write ${key}`, touches: [], interruptible: true });
const planWithout = (exclude: string[]) => ({
  kind: 'apply',
  steps: ITEMS.map((i) => i.key).filter((key) => !exclude.includes(key)).map(step),
  skipped: exclude.map((key) => ({ key, reason: 'excluded' })),
});

// `stale` answers apply with a new preview; `drop` closes the connection after the run's first step
// starts; `status` answers the status command, which goes unanswered without it, and `statusError`
// refuses it; `hang` leaves that command unanswered.
type Script = { stale?: boolean; drop?: boolean; status?: unknown; statusError?: { code: string; message: string }; hang?: string };
type Fake = { paths: MachinePathsValue; seen: Array<Record<string, unknown>>; close: () => Promise<void> };

const send = (socket: Socket, record: unknown) => socket.write(JSON.stringify(record) + '\n');
const ok = (socket: Socket, id: unknown, result: unknown) => send(socket, { version: 3, id, ok: true, result });
const progress = (socket: Socket, p: unknown) => send(socket, { version: 3, event: 'progress', runId: 'run-1', progress: p });

// Answers inspect, preview and apply as the agent would; apply streams a run of the previewed steps.
async function fake(script: Script = {}): Promise<Fake> {
  const stateRoot = mkdtempSync('/tmp/nar-');
  const dir = join(stateRoot, 'agent');
  mkdirSync(dir);
  writeFileSync(join(dir, 'agent.token'), TOKEN);
  const seen: Array<Record<string, unknown>> = [];
  const sockets = new Set<Socket>();
  let previewed: ReturnType<typeof planWithout> | undefined;
  const server: Server = createServer((socket) => {
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
        if (request.command === script.hang) continue;
        switch (request.command) {
          case 'hello':
            ok(socket, request.id, { agentVersion: 'v', protocol: 3, policy: 'notify', paused: null });
            break;
          case 'status':
            if (script.statusError !== undefined) send(socket, { version: 3, id: request.id, ok: false, error: script.statusError });
            else if (script.status !== undefined) ok(socket, request.id, script.status);
            break;
          case 'inspect':
            ok(socket, request.id, INSPECTED);
            break;
          case 'preview':
            previewed = planWithout(request.exclude);
            ok(socket, request.id, { planId: 'plan-1', plan: previewed });
            break;
          case 'apply': {
            if (script.stale) {
              ok(socket, request.id, { status: 'stale', planId: 'plan-2', plan: previewed });
              break;
            }
            ok(socket, request.id, { status: 'started', runId: 'run-1' });
            const steps = previewed!.steps;
            if (script.drop) {
              progress(socket, { type: 'started', index: 0, total: steps.length, step: steps[0] });
              socket.destroy();
              break;
            }
            steps.forEach((s, index) => {
              progress(socket, { type: 'started', index, total: steps.length, step: s });
              progress(socket, { type: 'finished', index, total: steps.length, key: s.key, outcome: 'ok', note: '' });
            });
            progress(socket, { type: 'done', ok: steps.length, failed: 0, backups: '/backups/run-1' });
            break;
          }
        }
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
  return { paths, seen, close };
}

// Captures console output while `body` runs. process.stdout itself is left alone: the test runner reports on it.
async function captured<T>(body: () => Promise<T>): Promise<{ result: T; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  console.log = (...args: unknown[]) => void out.push(args.join(' ') + '\n');
  console.error = (...args: unknown[]) => void err.push(args.join(' ') + '\n');
  try {
    return { result: await body(), stdout: out.join(''), stderr: err.join('') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

type Picker = (items: readonly Choice[]) => string[] | null;
const deps = (f: Fake, options: { pick?: Picker; yes?: boolean; shown?: Choice[][]; asked?: string[] } = {}): AgentDeps => ({
  isTTY: true,
  connect: () => connectAgent(f.paths),
  select: async (items) => {
    options.shown?.push(items.map((i) => ({ ...i })));
    return (options.pick ?? ((all) => all.filter((i) => i.checked).map((i) => i.key)))(items);
  },
  confirm: async (question) => {
    options.asked?.push(question);
    return options.yes ?? true;
  },
});

const commands = (f: Fake) => f.seen.map((r) => r.command);

test('agent review shows pending, held and drift rows and applies the checked items', { skip }, async () => {
  const f = await fake();
  try {
    const shown: Choice[][] = [];
    const asked: string[] = [];
    const { result, stdout } = await captured(() => run(['review'], deps(f, { shown, asked })));
    assert.equal(result, 0, stdout);
    assert.deepEqual(shown[0]!.map((c) => [c.key, c.group, c.checked]), [
      ['config:a', 'pending', true],
      ['config:b', 'held', true],
      ['config:c', 'drift', false],
    ]);
    assert.equal(shown[0]![0]!.label, 'a.md');
    assert.match(shown[0]![1]!.note, /the hook runs a command/);
    assert.deepEqual(commands(f), ['hello', 'inspect', 'preview', 'apply']);
    assert.deepEqual(f.seen[2]!.exclude, ['config:c']);
    assert.equal(f.seen[3]!.planId, 'plan-1');
    assert.deepEqual(asked, ['Apply these 2 step(s)?']);
    assert.match(stdout, /write config:a/);
    assert.match(stdout, /excluded/);
    assert.match(stdout, /^started 1\/2: write config:a$/m);
    assert.match(stdout, /^finished 2\/2: config:b ok$/m);
    assert.match(stdout, /^done: 2 ok, 0 failed; backups in \/backups\/run-1$/m);
  } finally {
    await f.close();
  }
});

test('agent review excludes an unchecked item from the preview', { skip }, async () => {
  const f = await fake();
  try {
    const { result } = await captured(() => run(['review'], deps(f, { pick: () => ['config:b', 'config:c'] })));
    assert.equal(result, 0);
    assert.deepEqual(f.seen.find((r) => r.command === 'preview')!.exclude, ['config:a']);
  } finally {
    await f.close();
  }
});

test('agent review applies nothing when the person declines', { skip }, async () => {
  const f = await fake();
  try {
    const { result, stdout } = await captured(() => run(['review'], deps(f, { yes: false })));
    assert.equal(result, 0);
    assert.deepEqual(commands(f), ['hello', 'inspect', 'preview']);
    assert.match(stdout, /nothing was applied/);
  } finally {
    await f.close();
  }
});

test('agent review exits 1 when the machine changed since the preview', { skip }, async () => {
  const f = await fake({ stale: true });
  try {
    const { result, stdout } = await captured(() => run(['review'], deps(f)));
    assert.equal(result, 1);
    assert.match(stdout, /^the machine changed; review again$/m);
  } finally {
    await f.close();
  }
});

test('agent review exits 1 promptly when the agent goes away during the run', { skip }, async () => {
  const f = await fake({ drop: true });
  try {
    const started = Date.now();
    const { result, stdout, stderr } = await captured(() => run(['review'], deps(f)));
    assert.equal(result, 1);
    assert.ok(Date.now() - started < 2000, 'did not wait for a terminal event');
    assert.match(stdout, /^started 1\/2: write config:a$/m);
    assert.equal(stderr.trim(), 'nortuscc: lost the agent during the run; check nortuscc agent status');
  } finally {
    await f.close();
  }
});

test('an agent command whose request goes unanswered exits 1 and says so', { skip }, async () => {
  const f = await fake();
  try {
    const { result, stderr } = await captured(() => run(['status'], { connect: () => connectAgent(f.paths, { requestTimeoutMs: 50 }) }));
    assert.equal(result, 1);
    assert.equal(stderr.trim(), 'nortuscc: the agent did not answer in time');
  } finally {
    await f.close();
  }
});

test('agent status prints the status error and exits 1', { skip }, async () => {
  const f = await fake({ status: { ...STATUS, error: 'JOB_FAILED', detail: 'the job stopped' } });
  try {
    const { result, stdout } = await captured(() => run(['status'], { connect: () => connectAgent(f.paths) }));
    assert.equal(result, 1);
    assert.match(stdout, /^policy: notify$/m);
    assert.match(stdout, /^error: JOB_FAILED: the job stopped$/m);
  } finally {
    await f.close();
  }
});

test('agent status says the agent is still starting and exits 1 before its first job', { skip }, async () => {
  const f = await fake({ statusError: { code: 'NO_REPORT', message: 'the agent is still starting' } });
  try {
    const { result, stdout, stderr } = await captured(() => run(['status'], { connect: () => connectAgent(f.paths) }));
    assert.equal(result, 1);
    assert.equal(stdout, '');
    assert.equal(stderr.trim(), 'nortuscc: the agent is still starting; try again in a moment');
  } finally {
    await f.close();
  }
});

for (const hang of ['inspect', 'preview']) {
  test(`agent review exits 130 on Ctrl-C while waiting for ${hang}, and applies nothing`, { skip }, async () => {
    const f = await fake({ hang });
    const controller = new AbortController();
    // Ctrl-C once the agent has the request it will never answer.
    const watch = setInterval(() => { if (f.seen.some((r) => r.command === hang)) controller.abort(); }, 5);
    try {
      const started = Date.now();
      const { result, stdout } = await captured(() => run(['review'], { ...deps(f), signal: controller.signal }));
      assert.equal(result, 130);
      assert.ok(Date.now() - started < 2000, 'waited for the agent after Ctrl-C');
      assert.match(stdout, /^cancelled; nothing was applied$/m);
      assert.equal(commands(f).includes('apply'), false);
    } finally {
      clearInterval(watch);
      await f.close();
    }
  });
}

test('agent review needs a terminal and exits 2 without one', async () => {
  let connected = false;
  const { result, stderr } = await captured(() => run(['review'], {
    isTTY: false,
    connect: async () => {
      connected = true;
      throw new Error('never');
    },
  }));
  assert.equal(result, 2);
  assert.equal(stderr.trim(), 'nortuscc: agent review needs a terminal');
  assert.equal(connected, false);
});
