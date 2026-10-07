import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, uptime } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Effect, Exit, type Scope } from 'effect';
import { acquireApplyLock, acquirePidLock, liveLockHolder, machinePaths, takeOver, type MachinePaths } from '../src/index.ts';

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

test('a pid lock on a custom path creates its parent, fails when a live pid holds it, and takes over a dead one', async () => {
  const { lock, run } = setup();
  const custom = join(dirname(lock), 'nested', 'x.lock');
  const held = await run(Effect.andThen(acquirePidLock(custom), Effect.sync(() => existsSync(custom))));
  assert.ok(Exit.isSuccess(held) && held.value === true);
  assert.equal(existsSync(custom), false);
  writeFileSync(custom, JSON.stringify({ pid: process.ppid, startedAt: 'x' }));
  const exit = await run(acquirePidLock(custom));
  assert.ok(Exit.isFailure(exit) && String(exit.cause).includes('LockHeld'));
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  writeFileSync(custom, JSON.stringify({ pid: dead, startedAt: 'x' }));
  assert.ok(Exit.isSuccess(await run(acquirePidLock(custom))));
  assert.equal(existsSync(custom), false);
});

test('liveLockHolder names a live holder only', () => {
  const { lock } = setup();
  assert.equal(liveLockHolder(lock), undefined);
  writeFileSync(lock, 'not json');
  assert.equal(liveLockHolder(lock), undefined);
  writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: 'x' }));
  assert.equal(liveLockHolder(lock), process.pid);
  writeFileSync(lock, JSON.stringify({ pid: spawnSync(process.execPath, ['-e', '']).pid, startedAt: 'x' }));
  assert.equal(liveLockHolder(lock), undefined);
});

// After an unclean shutdown the recorded pid may belong to an unrelated process of this boot.
test('a lock whose recorded uptime is above this boot\'s is taken over even when its pid is live', async () => {
  const { lock, run } = setup();
  writeFileSync(lock, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString(), uptime: uptime() + 1e9 }));
  assert.equal(liveLockHolder(lock), undefined);
  assert.ok(Exit.isSuccess(await run(acquireApplyLock)));
  assert.equal(existsSync(lock), false);
});

test('a live pid whose recorded uptime is at or below this boot\'s holds the lock', async () => {
  const { lock, run } = setup();
  for (const recorded of [0, uptime()]) {
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString(), uptime: recorded }));
    assert.equal(liveLockHolder(lock), process.ppid);
    const exit = await run(acquireApplyLock);
    assert.ok(Exit.isFailure(exit) && String(exit.cause).includes('LockHeld'), String(recorded));
    assert.equal(existsSync(lock), true);
  }
});

// The wall clock can step after boot, so it never decides staleness.
test('a live pid with an old startedAt and no recorded uptime holds the lock', async () => {
  const { lock, run } = setup();
  writeFileSync(lock, JSON.stringify({ pid: process.ppid, startedAt: '2000-01-01T00:00:00.000Z' }));
  assert.equal(liveLockHolder(lock), process.ppid);
  const exit = await run(acquireApplyLock);
  assert.ok(Exit.isFailure(exit) && String(exit.cause).includes('LockHeld'));
  assert.equal(existsSync(lock), true);
});

test('a lock records the uptime it was taken at', async () => {
  const { lock, run } = setup();
  const exit = await run(Effect.andThen(acquireApplyLock, Effect.sync(() => JSON.parse(readFileSync(lock, 'utf8')))));
  assert.ok(Exit.isSuccess(exit));
  const written = Exit.isSuccess(exit) ? exit.value : undefined;
  assert.equal(written.pid, process.pid);
  assert.ok(typeof written.uptime === 'number' && written.uptime <= uptime());
});
