import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
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

const holder = (path: string): number | undefined => {
  try {
    const pid = JSON.parse(readFileSync(path, 'utf8')).pid;
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
};

// One machine-changing run at a time, across the CLI and the app. A lock whose owner died is taken over.
export const acquireApplyLock = Effect.gen(function* () {
  const { stateRoot } = yield* MachinePaths;
  const path = join(stateRoot, 'apply.lock');
  const claim = () => writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' });

  yield* Effect.acquireRelease(
    Effect.suspend(() => {
      mkdirSync(stateRoot, { recursive: true });
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          claim();
          return Effect.void;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return Effect.die(err);
          const pid = holder(path);
          if (pid !== undefined && alive(pid)) return Effect.fail(new LockHeld({ path, pid }));
          rmSync(path, { force: true });
        }
      }
      return Effect.fail(new LockHeld({ path, pid: holder(path) ?? 0 }));
    }),
    () => Effect.sync(() => {
      if (holder(path) === process.pid) rmSync(path, { force: true });
    }),
  );
});
