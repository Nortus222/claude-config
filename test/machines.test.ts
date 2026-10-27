import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { machine, runCli } from './support/cli.ts';
import { listenAgent, shortTempDir } from './support/agent-endpoint.ts';

const MACHINES = {
  tailscale: 'ready', self: { nodeId: 'n-self', name: 'Desk', os: 'macOS' },
  machines: [
    { nodeId: 'n-lap', name: 'Laptop', os: 'Windows', reach: 'ok', lastReachedAt: null },
    { nodeId: 'n-nas', name: 'Nas', os: 'Linux', reach: 'offline', lastReachedAt: null },
  ],
};
const run = (state: string) => ({
  runId: 'run1', state, operation: 'applyChange', scope: { kind: 'machine' }, intentSaved: true, steps: [], result: null,
  intent: { requestId: 'req1', inputDigest: '0'.repeat(64), planId: 'plan1', change: { kind: 'resume' },
    parity: { kind: 'resume', generation: 'g1', baselineDigest: '0'.repeat(64), planDigest: '0'.repeat(64), plannedKeys: [] } },
});

// A stub agent answering the machine operations; `seen` records each operation request.
async function stub(t: import('node:test').TestContext) {
  const m = { ...machine({ repo: 'checkout' }), state: shortTempDir('nmc-') };
  t.after(() => rmSync(m.state, { recursive: true, force: true }));
  mkdirSync(join(m.state, 'agent')); writeFileSync(join(m.state, 'agent', 'agent.token'), 'tok');
  const seen: any[] = [];
  const answer = (request: any): unknown => {
    if (request.command === 'hello') return { agentVersion: 'fake', protocol: 3, policy: 'notify', paused: null };
    seen.push(request);
    const { operation, input } = request;
    if (operation === 'myMachines') return MACHINES;
    if (operation === 'setRemoteAccess') return { enabled: input.enabled, tailscale: 'ready', self: null, listening: input.enabled };
    if (operation === 'machineSkills') return { inspectedAt: 'now', skills: [{ source: 'a/b', name: 'tidy', state: 'installed', choice: null, from: null }] };
    if (operation === 'applySkillOnMachines') return { results: [
      { machine: 'n-lap', name: 'Laptop', outcome: { status: 'started', runId: 'run1' } },
      { machine: 'n-nas', name: 'Nas', outcome: { status: 'offline' } },
    ] };
    if (operation === 'machineRun') return run('succeeded');
    throw new Error(operation);
  };
  const server = createServer((socket) => {
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk;
      let newline;
      while ((newline = text.indexOf('\n')) >= 0) {
        const request = JSON.parse(text.slice(0, newline)); text = text.slice(newline + 1);
        socket.write(JSON.stringify({ version: 3, id: request.id, ok: true, result: answer(request) }) + '\n');
      }
    });
  });
  await listenAgent(server, join(m.state, 'agent'));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { m, seen };
}

test('machines lists names, systems and reach', async (t) => {
  const { m } = await stub(t);
  const r = await runCli(m, ['machines']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Laptop\tWindows\treachable/);
  assert.match(r.stdout, /Nas\tLinux\toffline/);
});

test('machines skills resolves a name ignoring case, and this', async (t) => {
  const { m, seen } = await stub(t);
  const r = await runCli(m, ['machines', 'skills', 'laptop']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /a\/b tidy\tinstalled/);
  assert.equal(seen.find((s) => s.operation === 'machineSkills').input.machine, 'n-lap');
  await runCli(m, ['machines', 'skills', 'this']);
  assert.equal(seen.filter((s) => s.operation === 'machineSkills')[1].input.machine, 'this');
});

test('machines install --on all prints a line per machine and exits 1 when one is offline', async (t) => {
  const { m, seen } = await stub(t);
  const r = await runCli(m, ['machines', 'install', 'a/b', 'tidy', '--on', 'all']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /Laptop: installed/);
  assert.match(r.stdout, /Nas: offline/);
  const input = seen.find((s) => s.operation === 'applySkillOnMachines').input;
  assert.equal(input.machines, 'all');
  assert.equal(input.action, 'install');
  assert.ok(input.requestId);
});

test('machines remove --on names sends their node ids and exits 0 when all succeed', async (t) => {
  const { m, seen } = await stub(t);
  const r = await runCli(m, ['machines', 'remove', 'a/b', 'tidy', '--on', 'LAPTOP']);
  assert.match(r.stdout, /Laptop: installed|Laptop: removed/);
  assert.deepEqual(seen.find((s) => s.operation === 'applySkillOnMachines').input.machines, ['n-lap']);
});

test('an unknown machine name exits 2 and lists the known ones', async (t) => {
  const { m, seen } = await stub(t);
  const r = await runCli(m, ['machines', 'install', 'a/b', 'tidy', '--on', 'Toaster']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Toaster.*Laptop, Nas/);
  assert.equal(seen.some((s) => s.operation === 'applySkillOnMachines'), false);
});

test('machines remote on sends setRemoteAccess enabled', async (t) => {
  const { m, seen } = await stub(t);
  const r = await runCli(m, ['machines', 'remote', 'on']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(seen.find((s) => s.operation === 'setRemoteAccess').input, { scope: { kind: 'machine' }, enabled: true });
});

test('without the agent, machines says so and that remote actions need it', async (t) => {
  const m = { ...machine({ repo: 'checkout' }), state: shortTempDir('nmc-') };
  t.after(() => rmSync(m.state, { recursive: true, force: true }));
  const r = await runCli(m, ['machines']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /the agent is not running.*Remote actions need the agent\./);
});
