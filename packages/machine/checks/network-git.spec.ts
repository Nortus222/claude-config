import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { LaunchFailed, NETWORK_OUTPUT_BYTES, networkFailure, networkGit, nodeProcesses, Processes, type Command } from '../src/index.ts';

// Records every command; `core.sshCommand` answers `sshCommand`, or exit 1 (unset) without one. The
// network command itself answers `ran`.
const recording = (sshCommand?: string, ran: Effect.Effect<{ code: number; stdout: string; stderr?: string }, LaunchFailed> = Effect.succeed({ code: 0, stdout: '', stderr: '' })) => {
  const calls: Command[] = [];
  const layer = Layer.succeed(Processes, {
    run: (command) => {
      calls.push(command);
      if (command.args.includes('core.sshCommand')) return Effect.succeed(sshCommand === undefined ? { code: 1, stdout: '' } : { code: 0, stdout: `${sshCommand}\n` });
      return ran;
    },
  });
  return { calls, layer };
};
const network = (calls: ReadonlyArray<Command>) => calls.find((c) => !c.args.includes('core.sshCommand'))!;

test('networkGit keeps the configured core.sshCommand and adds batch mode to it', async () => {
  const { calls, layer } = recording('ssh -i ~/.ssh/work');
  assert.equal(await Effect.runPromise(networkGit('git fetch', { args: ['fetch', 'origin'], cwd: '/repo' }).pipe(Effect.provide(layer))), undefined);
  const config = calls.find((c) => c.args.includes('core.sshCommand'))!;
  assert.deepEqual(config.args, ['config', '--get', 'core.sshCommand']);
  assert.equal(config.cwd, '/repo', 'read where the command runs, so repository config applies');
  const run = network(calls);
  assert.equal(run.cwd, '/repo');
  assert.deepEqual(run.env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: 'ssh -i ~/.ssh/work -o BatchMode=yes' });
  assert.deepEqual(run.args, ['-c', 'credential.interactive=never', '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=30', 'fetch', 'origin']);
  assert.equal(run.output, 'capture');
  assert.equal(run.stderr, 'capture');
  assert.deepEqual(run.captureLimit, { stdout: NETWORK_OUTPUT_BYTES, stderr: NETWORK_OUTPUT_BYTES });
  assert.equal(NETWORK_OUTPUT_BYTES, 64 * 1024);
});

test('without configured ssh, networkGit runs plain ssh in batch mode', async () => {
  const { calls, layer } = recording();
  await Effect.runPromise(networkGit('git clone', { args: ['clone', 'u', '/d'], cwd: '/d' }).pipe(Effect.provide(layer)));
  assert.equal(network(calls).env?.GIT_SSH_COMMAND, 'ssh -o BatchMode=yes');
});

// A scratch directory inside a repository (a dotfiles repo at ~/.config holding ~/.config/nortuscc/tmp) must not
// lend that repository's core.sshCommand to a clone. Real git reads the config; the clone itself is not run.
test('outside a repository, ssh config never comes from a repository above the scratch directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-ssh-ceiling-'));
  const env = { PATH: process.env.PATH ?? '', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'no-global') };
  execFileSync('git', ['init', '-q', root], { env });
  execFileSync('git', ['-C', root, 'config', 'core.sshCommand', 'ssh -i dotfiles-key'], { env });
  const scratch = join(root, 'nortuscc', 'tmp', 'trees-x');
  mkdirSync(scratch, { recursive: true });
  const real = Effect.runSync(Effect.gen(function* () { return yield* Processes; }).pipe(Effect.provide(nodeProcesses({ env }))));
  const sshFor = async (outsideRepository: boolean) => {
    const calls: Command[] = [];
    const layer = Layer.succeed(Processes, { run: (command) => {
      calls.push(command);
      return command.args.includes('core.sshCommand') ? real.run(command) : Effect.succeed({ code: 0, stdout: '', stderr: '' });
    } });
    await Effect.runPromise(networkGit('git clone', { args: ['clone', 'u', scratch], cwd: scratch, ...(outsideRepository ? { outsideRepository } : {}) })
      .pipe(Effect.provide(layer)));
    return network(calls).env?.GIT_SSH_COMMAND;
  };
  assert.equal(await sshFor(false), 'ssh -i dotfiles-key -o BatchMode=yes', 'the fixture repository above is discoverable');
  assert.equal(await sshFor(true), 'ssh -o BatchMode=yes');
  rmSync(root, { recursive: true, force: true });
});

test('stderr past the capture limit becomes a clean cause, not a failure', async () => {
  const { layer } = recording(undefined, Effect.fail(new LaunchFailed({ cmd: 'git', reason: 'capture byte limit exceeded' })));
  assert.equal(await Effect.runPromise(networkGit('git clone', { args: ['clone', 'u', '/d'], cwd: '/d' }).pipe(Effect.provide(layer))),
    'git clone failed: its output exceeded 64 KiB');
  const other = recording(undefined, Effect.fail(new LaunchFailed({ cmd: 'git', reason: 'spawn git ENOENT' })));
  const exit = await Effect.runPromiseExit(networkGit('git clone', { args: ['clone', 'u', '/d'], cwd: '/d' }).pipe(Effect.provide(other.layer)));
  assert.equal(exit._tag, 'Failure', 'a git that cannot launch stays a launch failure');
});

test('a real git flooding stderr is stopped at the limit and answers why', { skip: process.platform === 'win32' }, async () => {
  const bin = mkdtempSync(join(tmpdir(), 'machine-noisy-git-'));
  writeFileSync(join(bin, 'git'), [
    '#!/usr/bin/env node',
    "if (process.argv.includes('core.sshCommand')) process.exit(1);",
    "process.stderr.write('x'.repeat(200 * 1024), () => process.exit(128));",
  ].join('\n') + '\n');
  chmodSync(join(bin, 'git'), 0o755);
  const failure = await Effect.runPromise(networkGit('git fetch', { args: ['fetch'], cwd: bin }, 5000)
    .pipe(Effect.provide(nodeProcesses({ path: `${bin}:${process.env.PATH ?? ''}` }))));
  assert.equal(failure, 'git fetch failed: its output exceeded 64 KiB');
});

test('URL credentials longer than 512 characters are still redacted', () => {
  const token = 't'.repeat(600);
  const https = networkFailure('git fetch', { code: 128,
    stderr: `fatal: unable to access 'https://x-access-token:${token}@github.com/o/r.git/': Could not resolve host: github.com\n` });
  assert.equal(https, "Couldn't reach github.com: Could not resolve host: github.com");
  const other = networkFailure('git fetch', { code: 128, stderr: `fatal: could not read from https://bob:${token}@example.com/repo.git\n` });
  assert.ok(!other.includes(token.slice(0, 20)), other);
  assert.equal(other, 'git fetch failed: could not read from https://example.com/repo.git');
  assert.equal(networkFailure('git fetch', { code: 128, stderr: `fatal: could not read from https://bob:p@${token}@example.com/repo.git\n` }),
    'git fetch failed: could not read from https://example.com/repo.git', 'userinfo ends at its last @');
});

test('long hostile stderr is classified quickly', () => {
  const hostile = [
    `fatal: unable to access 'https://${'a'.repeat(100_000)}`,
    `fatal: unable to access 'https://${'@'.repeat(100_000)}': x`,
    `fatal: unable to access 'https://${'a:'.repeat(50_000)}@h': x`,
    `fatal: ${'https://'.repeat(20_000)}`,
    `fatal: https://${'a'.repeat(100_000)} ${'b@'.repeat(10_000)}`,
    `ssh: connect to host ${'h'.repeat(100_000)} port 22: x`,
  ];
  for (const line of hostile) {
    const started = performance.now();
    networkFailure('git fetch', { code: 128, stderr: `${line}\n`.repeat(3) });
    const took = performance.now() - started;
    assert.ok(took < 200, `took ${took.toFixed(1)} ms for ${line.slice(0, 40)}`);
  }
});
