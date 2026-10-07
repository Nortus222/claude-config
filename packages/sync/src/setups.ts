import { join } from 'node:path';
import { Context, Effect, Layer } from 'effect';
import { Fs, MachinePaths, type FsFailed } from '@nortuscc/machine';
export { normalizeRepoUrl } from '@nortuscc/hosted-protocol';

// A setup this machine applies. P2 has only the own checkout, `setupId: null`.
export type TrustedSetup = {
  readonly setupId: string | null;
  readonly repoUrl: string | null;
  readonly checkout: string | null;
  readonly trustedAt: string;
};

// The own setup trusted for `checkout`: an own entry for another checkout trusts nothing there.
export const ownSetup = (setups: ReadonlyArray<TrustedSetup> | undefined, checkout: string): TrustedSetup | undefined =>
  setups?.find((s) => s.setupId === null && s.checkout === checkout);

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
