import { Effect } from 'effect';
import { Fs, nodeFs } from '@nortuscc/machine';
import type { Git } from './git.ts';
import { watchCheckout } from './local.ts';
import type { SourceReport, WatchedSource } from './model.ts';
import { watchUpstreamWithServices } from './upstream.ts';

export type WatchOptions = { readonly cacheDir: string }; // holds one bare clone per source URL

// One source's upstream report, with its local checkout's edits when it has one.
export const watchSourceWithServices = (source: WatchedSource, options: WatchOptions): Effect.Effect<SourceReport, never, Git | Fs> =>
  Effect.gen(function* () {
    const report = yield* watchUpstreamWithServices(source, options);
    if (source.checkout === undefined) return report;
    return { ...report, local: yield* watchCheckout(source.checkout) };
  });

// Every source's report, in input order, watching up to two at once. Ordinary read failures
// become reports; cleanup defects remain failures.
export const watchSourcesWithServices = (
  sources: ReadonlyArray<WatchedSource>,
  options: WatchOptions,
): Effect.Effect<SourceReport[], never, Git | Fs> =>
  Effect.forEach(sources, (source) => watchSourceWithServices(source, options), { concurrency: 2 });

export const watchSource = (...args: Parameters<typeof watchSourceWithServices>) => watchSourceWithServices(...args).pipe(Effect.provide(nodeFs));
export const watchSources = (sources:ReadonlyArray<WatchedSource>,options:WatchOptions) => Effect.forEach(sources,source=>watchSource(source,options),{concurrency:4});
