import { Effect } from 'effect';
import { HistoryStore, MachinePaths, Processes, type Actor } from '@nortuscc/machine';
import { normalizeRepoUrl, SetupsStore, type TrustedSetup } from '@nortuscc/sync';
import { AgentClock } from './clock.ts';

// Trusts this machine's own checkout, by its normalized origin URL, as the one `setupId: null`
// entry. Only a person on this machine calls it, when installing the agent; re-running it keeps an
// entry that already matches and otherwise replaces any own entry. undefined, writing nothing,
// when setups.json cannot be read.
export const trustOwnSetup = (actor: Actor) =>
  Effect.gen(function* () {
    const store = yield* SetupsStore;
    const setups = yield* store.read;
    if (setups === undefined) return undefined;
    const paths = yield* MachinePaths;
    const repoUrl = yield* (yield* Processes).run({ cmd: 'git', args: ['-C', paths.repo, 'remote', 'get-url', 'origin'], output: 'capture' }).pipe(
      Effect.map(({ code, stdout }) => (code === 0 && stdout.trim() !== '' ? normalizeRepoUrl(stdout.trim()) : null)),
      Effect.catchTag('LaunchFailed', () => Effect.succeed(null)),
    );
    const own = setups.find((s) => s.setupId === null && s.checkout === paths.repo && s.repoUrl === repoUrl);
    if (own) return own;
    const entry: TrustedSetup = { setupId: null, repoUrl, checkout: paths.repo, trustedAt: (yield* (yield* AgentClock).now).toISOString() };
    yield* store.write([...setups.filter((s) => s.setupId !== null), entry]);
    yield* (yield* HistoryStore).append({ kind: 'setup-trusted', actor, setupId: null, repoUrl });
    return entry;
  });
