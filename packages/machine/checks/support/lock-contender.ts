import { Effect } from 'effect';
import { acquireApplyLock, machinePaths } from '../../src/index.ts';

// Tries to take apply.lock under argv[2], holds it for argv[3] ms, and prints 'acquired' or 'held'.
const stateRoot = process.argv[2]!;
const holdMs = Number(process.argv[3]);
const layer = machinePaths({
  repo: stateRoot, claude: stateRoot, codex: stateRoot, codexOpenRouter: stateRoot,
  agentsSkills: stateRoot, stateRoot, backups: stateRoot,
});
const outcome = await Effect.runPromise(
  Effect.scoped(Effect.andThen(acquireApplyLock, Effect.as(Effect.sleep(holdMs), 'acquired'))).pipe(
    Effect.catchTag('LockHeld', () => Effect.succeed('held')),
    Effect.provide(layer),
  ),
);
process.stdout.write(outcome);
