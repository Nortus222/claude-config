import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { Effect, Layer } from 'effect';
import { nodeFs, Processes, type MachinePathsValue } from '@nortuscc/machine';
import { unitPath, type ServiceTarget } from '@nortuscc/agent';
import { restartAfterPull } from '../src/agent-service.ts';

// restartAfterPull against a temporary home and a recording Processes: no service manager runs.
function setup(lockPid?: number) {
  const home = mkdtempSync(join(tmpdir(), 'agent-service-'));
  const stateRoot = join(home, 'state');
  const paths: MachinePathsValue = {
    repo: home, claude: home, codex: home, codexOpenRouter: home, agentsSkills: home, stateRoot, backups: join(home, 'backups'),
  };
  const target: ServiceTarget = { platform: 'linux', home, uid: 501, user: 'me', stateRoot };
  mkdirSync(join(stateRoot, 'agent'), { recursive: true });
  writeFileSync(join(stateRoot, 'agent', 'agent.json'), JSON.stringify({ version: 1, policy: 'notify', policySource: 'default', paused: null, installedBy: 'cli', agentVersion: 'old' }));
  mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
  writeFileSync(unitPath(target), 'stale');
  if (lockPid !== undefined) writeFileSync(join(stateRoot, 'apply.lock'), JSON.stringify({ pid: lockPid }));
  const calls: string[] = [];
  const processes = Layer.succeed(Processes, {
    run: (command) => Effect.sync(() => {
      calls.push([command.cmd, ...command.args].join(' '));
      return { code: 0, stdout: '' };
    }),
  });
  const version = () => JSON.parse(readFileSync(join(stateRoot, 'agent', 'agent.json'), 'utf8')).agentVersion;
  return { paths, target, calls, processes, version };
}

async function captured(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const log = mock.method(console, 'log', (...args: unknown[]) => { lines.push(args.join(' ')); });
  const error = mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.join(' ')); });
  try {
    await run();
  } finally {
    log.mock.restore();
    error.mock.restore();
  }
  return lines.join('\n');
}

test('an apply holding the lock past the timeout leaves the agent alone and says how to restart it', async () => {
  const s = setup(process.pid);
  const out = await captured(() => Effect.runPromise(
    restartAfterPull(s.paths, { target: s.target, timeoutMs: 50, pollMs: 10 }).pipe(Effect.provide(Layer.merge(nodeFs, s.processes))),
  ));
  assert.match(out, /^nortuscc: an apply is running; the agent was not restarted\. Run: nortuscc agent install$/m);
  assert.deepEqual(s.calls, []);
  assert.equal(s.version(), 'old');
});

test('a lock left by a dead process does not hold the restart back', async () => {
  const s = setup(spawnSync(process.execPath, ['-e', '']).pid);
  const out = await captured(() => Effect.runPromise(
    restartAfterPull(s.paths, { target: s.target, timeoutMs: 50, pollMs: 10 }).pipe(Effect.provide(Layer.merge(nodeFs, s.processes))),
  ));
  assert.ok(s.calls.includes('systemctl --user restart nortuscc-agent.service'), JSON.stringify(s.calls));
  assert.match(out, /^agent restarted on [0-9a-f]{7}$/m);
  assert.notEqual(s.version(), 'old');
});
