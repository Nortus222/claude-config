import { Effect } from 'effect';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { desiredFixture } from './fixture.ts';
import type { Progress } from './protocol.ts';

/** Scope owns the fixture directory and child until completion or interruption. */
export function fixtureOperation(
  operationId: string,
  sessionDirectory: string,
  emit: (progress: Progress) => void,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(sessionDirectory, 'operation-'))),
        (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
      );
      const child = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const child = spawn(
            process.execPath,
            [...process.execArgv, process.argv[1]!, '--fixture-child', directory],
            { stdio: ['pipe', 'ignore', 'inherit'] },
          );
          await once(child, 'spawn');
          process.stderr.write(
            JSON.stringify({ event: 'resource', operationId, directory, childPid: child.pid }) +
              '\n',
          );
          return child;
        }),
        (child) =>
          Effect.promise(async () => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            const exited = once(child, 'exit');
            child.stdin!.end();
            const force = setTimeout(() => child.kill('SIGKILL'), 1000);
            try {
              await exited;
            } finally {
              clearTimeout(force);
            }
          }),
      );
      for (let step = 1; step <= 8; step++) {
        yield* Effect.sleep('180 millis');
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error('Fixture child exited early');
        emit({
          version: 1,
          event: 'progress',
          operationId,
          state: 'running',
          percent: step * 10,
          detail: `Writing fixture step ${step} of 8`,
        });
      }
      yield* Effect.promise(() =>
        writeFile(join(directory, 'agent.json'), JSON.stringify(desiredFixture(), null, 2)),
      );
    }),
  );
}
