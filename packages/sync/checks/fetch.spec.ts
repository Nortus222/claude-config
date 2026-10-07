import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { nodeProcesses, Processes, type Command } from '@nortuscc/machine';
import { fetchTracked } from '../src/index.ts';

const UPSTREAM = { remote: 'origin', branch: 'main', ref: 'refs/remotes/origin/main' };

// Records every command; `core.sshCommand` answers `sshCommand`, or exit 1 (unset) without one.
const recording = (sshCommand?: string) => {
  const calls: Command[] = [];
  const layer = Layer.succeed(Processes, {
    run: (command) => {
      calls.push(command);
      if (command.args.includes('core.sshCommand')) {
        return Effect.succeed(sshCommand === undefined ? { code: 1, stdout: '' } : { code: 0, stdout: `${sshCommand}\n` });
      }
      return Effect.succeed({ code: 0, stdout: '' });
    },
  });
  return { calls, layer };
};

const fetchCall = (calls: ReadonlyArray<Command>) => calls.find((c) => c.args.includes('fetch'))!;

test('fetchTracked never prompts: no terminal prompt, no credential prompt, ssh in batch mode', async () => {
  const { calls, layer } = recording();
  assert.equal(await Effect.runPromise(fetchTracked('/repo', UPSTREAM).pipe(Effect.provide(layer))), true);
  const fetch = fetchCall(calls);
  assert.equal(fetch.env?.GIT_TERMINAL_PROMPT, '0');
  assert.equal(fetch.env?.GCM_INTERACTIVE, 'never');
  assert.equal(fetch.env?.GIT_SSH_COMMAND, 'ssh -o BatchMode=yes');
  const at = fetch.args.indexOf('fetch');
  assert.deepEqual(fetch.args.slice(0, at), ['-c', 'credential.interactive=never']);
});

test('fetchTracked keeps a configured core.sshCommand and adds batch mode to it', async () => {
  const { calls, layer } = recording('ssh -i k');
  await Effect.runPromise(fetchTracked('/repo', UPSTREAM).pipe(Effect.provide(layer)));
  assert.equal(fetchCall(calls).env?.GIT_SSH_COMMAND, 'ssh -i k -o BatchMode=yes');
});

test('a fetch that hangs times out, is killed, and answers false', { skip: process.platform === 'win32' }, async () => {
  const bin = mkdtempSync(join(tmpdir(), 'sync-fetch-bin-'));
  writeFileSync(join(bin, 'git'), '#!/usr/bin/env node\nsetTimeout(() => {}, 60_000);\n');
  chmodSync(join(bin, 'git'), 0o755);
  const repo = mkdtempSync(join(tmpdir(), 'sync-fetch-repo-'));
  const started = Date.now();
  const fetched = await Effect.runPromise(fetchTracked(repo, UPSTREAM, { timeoutMs: 300 })
    .pipe(Effect.provide(nodeProcesses({ path: `${bin}:${process.env.PATH ?? ''}` }))));
  assert.equal(fetched, false);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
});
