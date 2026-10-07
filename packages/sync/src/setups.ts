import { join } from 'node:path';
import { Context, Effect, Layer } from 'effect';
import { Fs, MachinePaths, type FsFailed } from '@nortuscc/machine';

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
// lower-cased whole; local paths keep their case. null when the URL will not parse: the repository
// is then unknown, as it is without an origin.
export const normalizeRepoUrl = (url: string): string | null => {
  const text = url.trim();
  try {
    if (/^file:\/\//i.test(text)) return tidy(decodeURIComponent(new URL(text).pathname));
    if (LOCAL_PATH.test(text)) return tidy(text);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
      const parsed = new URL(text);
      return tidy(`${parsed.hostname}${parsed.pathname}`).toLowerCase();
    }
  } catch {
    return null;
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
>()('sync/SetupsStore') {}

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
