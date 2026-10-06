import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Effect, Exit, type Scope } from 'effect';
import { acquireApplyLock, machinePaths, takeOver, type MachinePaths } from '../src/index.ts';

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

test('the lock is removed when the scoped effect fails', async () => {
  const { lock, run } = setup();
  const exit = await run(Effect.andThen(acquireApplyLock, Effect.fail('x')));
  assert.ok(Exit.isFailure(exit));
  assert.equal(existsSync(lock), false);
});

test('the lock is removed when the scoped effect is interrupted', async () => {
  const { lock, run } = setup();
  const exit = await run(Effect.andThen(acquireApplyLock, Effect.interrupt));
  assert.ok(Exit.isFailure(exit));
  assert.equal(existsSync(lock), false);
});

test('release leaves a lock that holds another pid', async () => {
  const { lock, run } = setup();
  const exit = await run(Effect.andThen(acquireApplyLock, Effect.sync(() => writeFileSync(lock, JSON.stringify({ pid: process.ppid, startedAt: 'x' })))));
  assert.ok(Exit.isSuccess(exit));
  assert.equal(existsSync(lock), true);
});

test('no temp files are left behind', async () => {
  const { lock, run } = setup();
  await run(Effect.andThen(acquireApplyLock, Effect.sync(() => readdirSync(dirname(lock)))));
  assert.deepEqual(readdirSync(dirname(lock)), []);
});

test('a takeover removes the lock it read', () => {
  const { lock } = setup();
  writeFileSync(lock, '{"pid":1999999}');
  assert.equal(takeOver(lock, '{"pid":1999999}'), true);
  assert.equal(existsSync(lock), false);
  assert.deepEqual(readdirSync(dirname(lock)), []);
});

test('a takeover puts back a lock that changed since it was read', () => {
  const { lock } = setup();
  const live = JSON.stringify({ pid: process.ppid, startedAt: 'now' });
  writeFileSync(lock, live);
  assert.equal(takeOver(lock, '{"pid":1999999}'), false);
  assert.equal(readFileSync(lock, 'utf8'), live);
  assert.deepEqual(readdirSync(dirname(lock)), ['apply.lock']);
});

test('a takeover of a lock already gone reports it free', () => {
  const { lock } = setup();
  assert.equal(takeOver(lock, '{"pid":1999999}'), true);
});

test('concurrent takeovers of a dead lock admit exactly one run', async () => {
  const { lock } = setup();
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  writeFileSync(lock, JSON.stringify({ pid: dead, startedAt: 'then' }));
  const contender = join(import.meta.dirname, 'support', 'lock-contender.ts');
  const outcomes = await Promise.all(Array.from({ length: 8 }, () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [contender, dirname(lock), '5000'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', reject);
    child.on('close', () => resolve(out));
  })));
  assert.equal(outcomes.filter((o) => o === 'acquired').length, 1, outcomes.join(','));
  assert.equal(outcomes.filter((o) => o === 'held').length, 7, outcomes.join(','));
  assert.equal(existsSync(lock), false);
});
