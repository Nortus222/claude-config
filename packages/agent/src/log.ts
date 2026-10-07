import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { Effect } from 'effect';

const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

// Copy before truncating the active inode, so service-manager append descriptors stay on it.
export const rotateAgentLog = async (logPath: string): Promise<void> => {
  let size: number;
  try {
    size = (await fs.stat(logPath)).size;
  } catch (error) {
    if (absent(error)) return;
    throw error;
  }
  if (size < 1_048_576) return;

  const temporary = `${logPath}.${randomUUID()}.tmp`;
  try {
    await fs.copyFile(logPath, temporary, constants.COPYFILE_EXCL);
    for (const [source, target] of [['.2', '.3'], ['.1', '.2']]) {
      try {
        await fs.rename(logPath + source, logPath + target);
      } catch (error) {
        if (!absent(error)) throw error;
      }
    }
    await fs.rename(temporary, logPath + '.1');
    await fs.truncate(logPath, 0);
  } finally {
    await fs.rm(temporary, { force: true });
  }
};

// Run one check at a time while the owning scope holds agent.lock; drain it before releasing it.
export const startAgentLogRotation = (logPath: string, options: {
  readonly intervalMs?: number;
  readonly rotate?: (logPath: string) => Promise<void>;
  readonly report?: (error: unknown) => void;
} = {}) => Effect.acquireRelease(
  Effect.promise(async () => {
    const rotate = options.rotate ?? rotateAgentLog;
    const report = options.report ?? ((error: unknown) => console.error('Agent log rotation failed:', error));
    const check = async () => {
      try {
        await rotate(logPath);
      } catch (error) {
        // Diagnostic failures must not stop the agent either.
        try { report(error); } catch {}
      }
    };
    await check();
    let pending: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (pending) return;
      pending = check().finally(() => { pending = undefined; });
    }, options.intervalMs ?? 60_000);
    return async () => {
      clearInterval(timer);
      await pending;
    };
  }),
  (close) => Effect.promise(close),
).pipe(Effect.asVoid);
