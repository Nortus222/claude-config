import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Effect, Exit, type Scope } from 'effect';
import { acquireApplyLock, machinePaths, type MachinePaths } from '../src/index.ts';

const setup = () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'machine-lock-'));
  const layer = machinePaths({
    repo: stateRoot, claude: stateRoot, codex: stateRoot, codexOpenRouter: stateRoot,
    agentsSkills: stateRoot, stateRoot, backups: join(stateRoot, 'backups'),
  });
  return { lock: join(stateRoot, 'apply.lock'), run: <A, E>(e: Effect.Effect<A, E, MachinePaths | Scope.Scope>) => Effect.runPromiseExit(Effect.scoped(e).pipe(Effect.provide(layer))) };
};

test('the lock exists while held and is removed after', async () => {
  const { lock, run } = setup();
  const exit = await run(Effect.andThen(acquireApplyLock, Effect.sync(() => existsSync(lock))));
  assert.ok(Exit.isSuccess(exit) && exit.value === true);
  assert.equal(existsSync(lock), false);
});

test('a lock held by a live process fails with LockHeld', async () => {
  const { lock, run } = setup();
  writeFileSync(lock, JSON.stringify({ pid: process.ppid, startedAt: 'x' }));
  const exit = await run(acquireApplyLock);
  assert.ok(Exit.isFailure(exit) && String(exit.cause).includes('LockHeld'));
  assert.equal(existsSync(lock), true);
});

test('a lock left by a dead process is taken over', async () => {
  const { lock, run } = setup();
  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(lock, JSON.stringify({ pid: Number(dead), startedAt: 'x' }));
  assert.ok(Exit.isSuccess(await run(acquireApplyLock)));
  assert.equal(existsSync(lock), false);
});

test('an unreadable lock file is taken over', async () => {
  const { lock, run } = setup();
  mkdirSync(join(lock, '..'), { recursive: true });
  writeFileSync(lock, 'garbage');
  assert.ok(Exit.isSuccess(await run(acquireApplyLock)));
});
