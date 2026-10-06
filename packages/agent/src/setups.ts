import { join } from 'node:path';
import { Context, Effect, Layer } from 'effect';
import { Fs, HistoryStore, MachinePaths, Processes, type Actor, type FsFailed } from '@nortuscc/machine';
import { AgentClock } from './clock.ts';

// A setup this machine applies. P2 has only the own checkout, `setupId: null`.
export type TrustedSetup = {
  readonly setupId: string | null;
  readonly repoUrl: string | null;
  readonly checkout: string | null;
  readonly trustedAt: string;
};

const LOCAL_PATH = /^(?:[/.~]|[a-z]:[\\/])/i;
const tidy = (text: string) => text.replace(/\/+$/, '').replace(/\.git$/i, '');

// One form per repository, so a checkout's origin and a hosted setup's URL compare equal: no
// scheme, credentials or port, no `.git`, and the SSH form rewritten. Remote paths are
// lower-cased whole; local paths keep their case.
export const normalizeRepoUrl = (url: string): string => {
  const text = url.trim();
  if (/^file:\/\//i.test(text)) return tidy(decodeURIComponent(new URL(text).pathname));
  if (LOCAL_PATH.test(text)) return tidy(text);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const parsed = new URL(text);
    return tidy(`${parsed.hostname}${parsed.pathname}`).toLowerCase();
  }
  const scp = /^(?:[^@/]+@)?([^:/]+):\/?(.+)$/.exec(text);
  return tidy(scp ? `${scp[1]}/${scp[2]}` : text).toLowerCase();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSetup = (value: unknown): value is TrustedSetup =>
  isRecord(value)
  && (value.setupId === null || typeof value.setupId === 'string')
  && (value.repoUrl === null || typeof value.repoUrl === 'string')
  && (value.checkout === null || typeof value.checkout === 'string')
  && typeof value.trustedAt === 'string';

export class SetupsStore extends Context.Service<
  SetupsStore,
  {
    // undefined when the file cannot be read as a whole: nothing is trusted, and nothing rewrites it.
    readonly read: Effect.Effect<ReadonlyArray<TrustedSetup> | undefined, FsFailed>;
    readonly write: (setups: ReadonlyArray<TrustedSetup>) => Effect.Effect<void, FsFailed>;
  }
>()('agent/SetupsStore') {}

// <stateRoot>/agent/setups.json. Only a person on this machine changes trust.
export const setupsStore = Layer.effect(
  SetupsStore,
  Effect.gen(function* () {
    const paths = yield* MachinePaths;
    const fs = yield* Fs;
    const path = join(paths.stateRoot, 'agent', 'setups.json');
    return {
      read: Effect.map(fs.readText(path), (text): ReadonlyArray<TrustedSetup> | undefined => {
        if (text === undefined) return [];
        try {
          const value: unknown = JSON.parse(text);
          return isRecord(value) && Array.isArray(value.setups) && value.setups.every(isSetup) ? value.setups : undefined;
        } catch {
          return undefined;
        }
      }),
      write: (setups: ReadonlyArray<TrustedSetup>) =>
        fs.writeTextAtomic(path, JSON.stringify({ version: 1, setups }, null, 2) + '\n'),
    };
  }),
);

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
