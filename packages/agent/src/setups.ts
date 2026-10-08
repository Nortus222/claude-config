import { HostedFailure, type HostedState } from '@nortuscc/hosted-client';
import { Effect } from 'effect';
import { HistoryStore, MachinePaths, Processes, type Actor } from '@nortuscc/machine';
import { normalizeRepoUrl, SetupsStore, type TrustedSetup } from '@nortuscc/sync';
import { AgentClock } from './clock.ts';

// Grants local consent to this checkout and origin. Reinstall preserves a matching linked
// identity and account binding; a changed origin starts fresh local consent. An unreadable
// trust file is left untouched. Only a person on this machine calls it.
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
    const own = setups.find((s) => s.checkout === paths.repo && (s.repoUrl === null ? null : normalizeRepoUrl(s.repoUrl)) === repoUrl);
    if (own) return own;
    const entry: TrustedSetup = { setupId: null, repoUrl, checkout: paths.repo, trustedAt: (yield* (yield* AgentClock).now).toISOString() };
    yield* store.write([...setups.filter((s) => s.setupId !== null && s.checkout !== paths.repo), entry]);
    yield* (yield* HistoryStore).append({ kind: 'setup-trusted', actor, setupId: null, repoUrl });
    return entry;
  });

// Explicit offered-setup consent. The caller serializes this with jobs and the shared apply lock.
export const trustHostedSetup = (setupId: string, state: HostedState, actor: Actor) =>
  Effect.gen(function* () {
    if (state.accountId === null) return yield* Effect.fail(new HostedFailure({ code: 'unauthenticated' }));
    const offered = state.setups.find((s) => s.setupId === setupId);
    if (!offered) return yield* Effect.fail(new HostedFailure({ code: 'invalid_request' }));
    const store = yield* SetupsStore;
    const setups = yield* store.read;
    if (setups === undefined) return yield* Effect.fail(new HostedFailure({ code: 'storage' }));
    const repoUrl = normalizeRepoUrl(offered.repoUrl);
    if (repoUrl === null) return yield* Effect.fail(new HostedFailure({ code: 'invalid_request' }));
    const existing = setups.find((s) => s.setupId === setupId && s.accountId === state.accountId);
    if (existing) {
      if (existing.repoUrl === null || normalizeRepoUrl(existing.repoUrl) !== repoUrl) return yield* Effect.fail(new HostedFailure({ code: 'invalid_request' }));
      return existing;
    }
    const paths = yield* MachinePaths;
    const origin = yield* (yield* Processes).run({ cmd: 'git', args: ['-C', paths.repo, 'remote', 'get-url', 'origin'], output: 'capture' }).pipe(
      Effect.map((r) => r.code === 0 ? normalizeRepoUrl(r.stdout.trim()) : null),
      Effect.catchTag('LaunchFailed', () => Effect.succeed(null)),
    );
    const checkout = origin === repoUrl ? paths.repo : null;
    const entry: TrustedSetup = { accountId: state.accountId, setupId, repoUrl: offered.repoUrl, checkout, trustedAt: (yield* (yield* AgentClock).now).toISOString() };
    yield* store.write([...setups.filter((s) => checkout === null || s.checkout !== checkout), entry]);
    yield* (yield* HistoryStore).append({ kind: 'setup-trusted', actor, setupId, repoUrl });
    return entry;
  }).pipe(Effect.mapError((error) => error instanceof HostedFailure ? error : new HostedFailure({ code: 'storage' })));
