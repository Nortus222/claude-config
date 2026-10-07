import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { dirname, join } from 'node:path';
import { Effect, type Scope } from 'effect';
import { LockHeld } from './errors.ts';
import { MachinePaths } from './paths.ts';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const read = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

const holderOf = (text: string): number | undefined => {
  try {
    const pid = JSON.parse(text).pid;
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
};

// Slack for uptime's granularity, so a lock taken a moment ago never reads as from an earlier boot.
const BOOT_TOLERANCE_S = 5;

// Whether the lock in `text` was taken in an earlier boot, so its pid may name an unrelated process
// after an unclean shutdown. Uptime only grows within a boot, so a recorded uptime above the current
// one means a reboot; this never consults the wall clock, which can step. A reboot that outlasted the
// recorded uptime, or a lock without one, falls back to the pid rule: it can only miss, never declare
// a live holder stale.
const fromEarlierBoot = (text: string): boolean => {
  let recorded: unknown;
  try {
    recorded = JSON.parse(text).uptime;
  } catch {
    return false;
  }
  return typeof recorded === 'number' && Number.isFinite(recorded) && recorded > uptime() + BOOT_TOLERANCE_S;
};

// The pid holding the lock in `text`, or undefined when the lock is stale or unreadable.
const liveHolderOf = (text: string): number | undefined => {
  const pid = holderOf(text);
  return pid !== undefined && alive(pid) && !fromEarlierBoot(text) ? pid : undefined;
};

// The live process holding the pid lock at `path`, or undefined when it is absent, unreadable, left
// by a dead process or from an earlier boot by its recorded uptime.
export const liveLockHolder = (path: string): number | undefined => {
  const text = read(path);
  return text === undefined ? undefined : liveHolderOf(text);
};

// Removes the lock at `path` only if it still reads `seen`, and reports whether the path is free to
// claim. Renaming moves exactly one file, so of two processes taking over the same dead lock only one
// deletes it; a lock that changed since it was read is linked back. Only a third claimant landing in
// the microseconds before that link can still lose its lock.
export const takeOver = (path: string, seen: string): boolean => {
  const moved = `${path}.${process.pid}.${randomUUID()}.stale`;
  try {
    renameSync(path, moved);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw err;
  }
  try {
    if (read(moved) === seen) return true;
    try {
      linkSync(moved, path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    return false;
  } finally {
    rmSync(moved, { force: true });
  }
};

// Holds a pid lock at `path` for the current scope, creating its directory. A lock whose owner died,
// or that its recorded uptime places in an earlier boot, is taken over; one held by a live process
// fails with LockHeld.
export const acquirePidLock = (path: string): Effect.Effect<void, LockHeld, Scope.Scope> =>
  Effect.gen(function* () {
    // Link a fully written temp file into place: the lock is atomic to create and never seen half-written.
    const claim = () => {
      const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temp, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), uptime: uptime() }));
        linkSync(temp, path);
      } finally {
        rmSync(temp, { force: true });
      }
    };

    yield* Effect.acquireRelease(
      Effect.suspend(() => {
        mkdirSync(dirname(path), { recursive: true });
        let last = 0;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            claim();
            return Effect.void;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return Effect.die(err);
            const seen = read(path);
            if (seen === undefined) continue; // released meanwhile
            last = holderOf(seen) ?? 0;
            const pid = liveHolderOf(seen);
            if (pid !== undefined) return Effect.fail(new LockHeld({ path, pid }));
            takeOver(path, seen);
          }
        }
        return Effect.fail(new LockHeld({ path, pid: last }));
      }),
      () => Effect.sync(() => {
        const text = read(path);
        if (text !== undefined && holderOf(text) === process.pid) rmSync(path, { force: true });
      }),
    );
  });

// One machine-changing run at a time, across the CLI and the app.
export const acquireApplyLock = Effect.gen(function* () {
  const { stateRoot } = yield* MachinePaths;
  yield* acquirePidLock(join(stateRoot, 'apply.lock'));
});
