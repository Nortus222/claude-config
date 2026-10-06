import { Effect } from 'effect';
import { HistoryStore, MachinePaths, Processes, type Actor } from '@nortuscc/machine';
import { normalizeRepoUrl, SetupsStore, type TrustedSetup } from '@nortuscc/sync';
import { AgentClock } from './clock.ts';

// Trusts this machine's own checkout as `setupId: null`, once. Installing the agent is a person on
// this machine acting; until the installer (#79) exists, starting the agent is that act.
export const ensureOwnSetup = (actor: Actor) =>
  Effect.gen(function* () {
    const store = yield* SetupsStore;
    const setups = yield* store.read;
    if (setups === undefined) return undefined;
    const own = setups.find((s) => s.setupId === null);
    if (own) return own;
    const paths = yield* MachinePaths;
    const repoUrl = yield* (yield* Processes).run({ cmd: 'git', args: ['-C', paths.repo, 'remote', 'get-url', 'origin'], output: 'capture' }).pipe(
      Effect.map(({ code, stdout }) => (code === 0 && stdout.trim() !== '' ? normalizeRepoUrl(stdout.trim()) : null)),
      Effect.catchTag('LaunchFailed', () => Effect.succeed(null)),
    );
    const entry: TrustedSetup = { setupId: null, repoUrl, checkout: paths.repo, trustedAt: (yield* (yield* AgentClock).now).toISOString() };
    yield* store.write([...setups, entry]);
    yield* (yield* HistoryStore).append({ kind: 'setup-trusted', actor, setupId: null, repoUrl });
    return entry;
  });
