import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Effect, Layer } from 'effect';
import { Processes, LaunchFailed, type Command } from '@nortuscc/machine';
import { gitAuthArgs, proveReadAccess } from '../src/git-auth.ts';

const run = <A, E>(effect: Effect.Effect<A, E, Processes>, run: Processes['Service']['run']) =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.succeed(Processes, { run }))));

test('proveReadAccess passes the gh credential helper and disables prompts', async () => {
  const commands: Command[] = [];
  await run(proveReadAccess('https://github.com/a/repo.git', '/empty-hooks'), command => {
    commands.push(command);
    return Effect.succeed({ code: 0, stdout: 'ref: refs/heads/main\tHEAD\n' });
  });
  assert.deepEqual(gitAuthArgs('/empty-hooks'), ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', '-c', 'core.hooksPath=/empty-hooks']);
  assert.deepEqual(commands.map(c => [c.cmd, c.args, c.env, c.output, c.stderr]), [[
    'git', [...gitAuthArgs('/empty-hooks'), 'ls-remote', '--symref', '--', 'https://github.com/a/repo.git', 'HEAD'],
    { GIT_TERMINAL_PROMPT: '0' }, 'capture', 'capture',
  ]]);
});

test('an authentication failure is AccessDenied and a network failure is GitFailed', async () => {
  for (const [stderr, tag] of [
    ['fatal: Authentication failed', 'AccessDenied'],
    ['remote: Repository not found.', 'AccessDenied'],
    ["fatal: repository 'https://github.com/a/repo.git/' not found", 'AccessDenied'],
    ["fatal: unable to access 'https://github.com/a/repo.git/': The requested URL returned error: 403", 'AccessDenied'],
    ["fatal: unable to access 'https://github.com/a/repo.git/': The requested URL returned error: 404", 'AccessDenied'],
    ['git@github.com: Permission denied (publickey).', 'AccessDenied'],
    ['fatal: could not read Username for https://github.com: terminal prompts disabled', 'AccessDenied'],
    ['fatal: unable to access: Could not resolve host: github.com', 'GitFailed'],
    ['fatal: connection timed out', 'GitFailed'],
  ]) {
    const error = await run(Effect.flip(proveReadAccess('https://github.com/a/repo.git', '/hooks')), () => Effect.succeed({ code: 128, stdout: '', stderr }));
    assert.equal(error._tag, tag, stderr);
  }
});

test('a Git launch failure is GitFailed', async () => {
  const error = await run(Effect.flip(proveReadAccess('url', '/hooks')), () => Effect.fail(new LaunchFailed({ cmd: 'git', reason: 'not installed' })));
  assert.equal(error._tag, 'GitFailed');
});
