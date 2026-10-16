import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Effect, Layer } from 'effect';
import { LaunchFailed, Processes } from '@nortuscc/machine';
import { ghLogin, ghStatus } from '../src/author/gh.ts';

const run = <A, E>(effect: Effect.Effect<A, E, Processes>, fake: Processes['Service']['run']) =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.succeed(Processes, { run: fake }))));

test('ghStatus distinguishes missing, signed out, ready and unexpected failures', async () => {
  assert.equal(await run(ghStatus(), () => Effect.fail(new LaunchFailed({ cmd: 'gh', reason: 'spawn gh ENOENT' }))), 'missing');
  for (const [code, expected] of [[0, 'ready'], [1, 'signed-out'], [4, 'signed-out'], [2, 'error']] as const) {
    assert.equal(await run(ghStatus(), command => {
      assert.equal(command.cmd, 'gh');
      if (command.args[0] === '--version') return Effect.succeed({ code: 0, stdout: 'gh version fixture' });
      assert.deepEqual(command.args, ['auth', 'status', '--hostname', 'github.com']);
      return Effect.succeed({ code, stdout: '', stderr: '' });
    }), expected);
  }
  assert.equal(await run(ghStatus(), () => Effect.fail(new LaunchFailed({ cmd: 'gh', reason: 'spawn gh EACCES' }))), 'error');
});

test('ghLogin reports the one-time code once while the process is running', async () => {
  const codes: Array<[string, string]> = [];
  let finished = false;
  const result = await run(ghLogin((code, url) => { assert.equal(finished, false); codes.push([code, url]); }), command => Effect.sync(() => {
    assert.equal(command.cmd, 'gh');
    assert.deepEqual(command.args, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key']);
    command.onOutput?.('stdout', 'one-time code: WRONG-CODE\n');
    command.onOutput?.('stderr', '! First copy your one-ti');
    command.onOutput?.('stderr', 'me code: ABCD-12');
    assert.deepEqual(codes, []);
    command.onOutput?.('stderr', '34\nPress Enter to open https://github.com/login/device\n');
    assert.deepEqual(codes, [['ABCD-1234', 'https://github.com/login/device']]);
    command.onOutput?.('stderr', 'one-time code: ABCD-1234\n');
    finished = true;
    return { code: 0, stdout: '', stderr: '' };
  }));
  assert.equal(result, 'ready');
  assert.equal(codes.length, 1);
});

test('ghLogin returns missing, signed-out or error when authorization cannot finish', async () => {
  assert.equal(await run(ghLogin(() => assert.fail('no code')), () => Effect.fail(new LaunchFailed({ cmd: 'gh', reason: 'spawn gh ENOENT' }))), 'missing');
  for (const [code, expected] of [[1, 'error'], [2, 'signed-out'], [4, 'signed-out']] as const) {
    assert.equal(await run(ghLogin(() => assert.fail('no code')), () => Effect.succeed({ code, stdout: '' })), expected);
  }
});
