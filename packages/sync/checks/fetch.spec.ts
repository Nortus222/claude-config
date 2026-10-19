import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { nodeProcesses, Processes, type Command } from '@nortuscc/machine';
import { fetchTracked, STALL_LIMIT_ARGS } from '../src/index.ts';

const UPSTREAM = { remote: 'origin', branch: 'main', ref: 'refs/remotes/origin/main' };

// Records every command; `core.sshCommand` answers `sshCommand`, or exit 1 (unset) without one.
// The fetch itself answers `fetched`.
const recording = (sshCommand?: string, fetched: { code: number; stdout: string; stderr?: string } = { code: 0, stdout: '' }) => {
  const calls: Command[] = [];
  const layer = Layer.succeed(Processes, {
    run: (command) => {
      calls.push(command);
      if (command.args.includes('core.sshCommand')) {
        return Effect.succeed(sshCommand === undefined ? { code: 1, stdout: '' } : { code: 0, stdout: `${sshCommand}\n` });
      }
      return Effect.succeed(command.args.includes('fetch') ? fetched : { code: 0, stdout: '' });
    },
  });
  return { calls, layer };
};

const fetchCall = (calls: ReadonlyArray<Command>) => calls.find((c) => c.args.includes('fetch'))!;

test('fetchTracked never prompts, aborts a stalled transfer, and captures stderr', async () => {
  const { calls, layer } = recording();
  assert.equal(await Effect.runPromise(fetchTracked('/repo', UPSTREAM).pipe(Effect.provide(layer))), undefined);
  const fetch = fetchCall(calls);
  assert.equal(fetch.env?.GIT_TERMINAL_PROMPT, '0');
  assert.equal(fetch.env?.GCM_INTERACTIVE, 'never');
  assert.equal(fetch.env?.GIT_SSH_COMMAND, 'ssh -o BatchMode=yes');
  const at = fetch.args.indexOf('fetch');
  assert.deepEqual(fetch.args.slice(0, at), ['-c', 'credential.interactive=never', '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=30']);
  assert.deepEqual(STALL_LIMIT_ARGS, ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=30']);
  assert.equal(fetch.output, 'capture');
  assert.equal(fetch.stderr, 'capture', "git's stderr never reaches the agent log raw");
});

test('an unreachable host becomes one redacted cause naming the host', async () => {
  const stderr = "fatal: unable to access 'https://x-access-token:ghs_secret@github.com/Nortus222/claude-config.git/': Failed to connect to github.com port 443 after 1036778 ms: Timeout was reached\n";
  const { layer } = recording(undefined, { code: 128, stdout: '', stderr });
  const failure = await Effect.runPromise(fetchTracked('/repo', UPSTREAM).pipe(Effect.provide(layer)));
  assert.equal(failure, "Couldn't reach github.com: Failed to connect to github.com port 443 after 1036778 ms: Timeout was reached");
});

test('an ssh connection failure names the host it could not reach', async () => {
  const stderr = 'ssh: connect to host github.com port 22: Operation timed out\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\n';
  const { layer } = recording(undefined, { code: 128, stdout: '', stderr });
  assert.equal(await Effect.runPromise(fetchTracked('/repo', UPSTREAM).pipe(Effect.provide(layer))),
    "Couldn't reach github.com: Operation timed out");
});

test('any other fetch failure keeps its fatal line with URL credentials removed', async () => {
  const stderr = 'warning: redirecting\nfatal: could not read from https://bob:hunter2@example.com/repo.git\n';
  const { layer } = recording(undefined, { code: 128, stdout: '', stderr });
  const failure = await Effect.runPromise(fetchTracked('/repo', UPSTREAM).pipe(Effect.provide(layer)));
  assert.equal(failure, 'git fetch of origin/main failed: could not read from https://example.com/repo.git');
  const silent = recording(undefined, { code: 1, stdout: '', stderr: '' });
  assert.equal(await Effect.runPromise(fetchTracked('/repo', UPSTREAM).pipe(Effect.provide(silent.layer))),
    'git fetch of origin/main exited with code 1');
});

test('fetchTracked keeps a configured core.sshCommand and adds batch mode to it', async () => {
  const { calls, layer } = recording('ssh -i k');
  await Effect.runPromise(fetchTracked('/repo', UPSTREAM).pipe(Effect.provide(layer)));
  assert.equal(fetchCall(calls).env?.GIT_SSH_COMMAND, 'ssh -i k -o BatchMode=yes');
});

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
};

test('a fetch that hangs times out, its whole process group is killed, and it answers why', { skip: process.platform === 'win32' }, async () => {
  const bin = mkdtempSync(join(tmpdir(), 'sync-fetch-bin-'));
  const pids = join(bin, 'pids');
  // A fake git whose fetch starts a helper (as git-remote-https would) and then hangs; both record their pids.
  writeFileSync(join(bin, 'git'), [
    '#!/usr/bin/env node',
    "const { spawn } = require('node:child_process');",
    "const { appendFileSync } = require('node:fs');",
    "if (!process.argv.includes('fetch')) process.exit(1);",
    "const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });",
    `appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n' + helper.pid + '\\n');`,
    'setTimeout(() => {}, 60_000);',
  ].join('\n') + '\n');
  chmodSync(join(bin, 'git'), 0o755);
  const repo = mkdtempSync(join(tmpdir(), 'sync-fetch-repo-'));
  const started = Date.now();
  const failure = await Effect.runPromise(fetchTracked(repo, UPSTREAM, { timeoutMs: 2000 })
    .pipe(Effect.provide(nodeProcesses({ path: `${bin}:${process.env.PATH ?? ''}` }))));
  assert.equal(failure, 'git fetch of origin/main timed out after 2 s');
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
  const recorded = readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number);
  assert.equal(recorded.length, 2);
  const deadline = Date.now() + 2000;
  while (recorded.some(alive) && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
  assert.deepEqual(recorded.filter(alive), [], 'git and its helper are both gone');
});
