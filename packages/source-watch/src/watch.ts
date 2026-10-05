import { Effect } from 'effect';
import type { Git } from './git.ts';
import { watchCheckout } from './local.ts';
import type { SourceReport, WatchedSource } from './model.ts';
import { watchUpstream } from './upstream.ts';

export type WatchOptions = { readonly cacheDir: string }; // holds one bare clone per source URL

// One source's upstream report, with its local checkout's edits when it has one.
export const watchSource = (source: WatchedSource, options: WatchOptions): Effect.Effect<SourceReport, never, Git> =>
  Effect.gen(function* () {
    const report = yield* watchUpstream(source, options);
    if (source.checkout === undefined) return report;
    return { ...report, local: yield* watchCheckout(source.checkout) };
  });

// Every source's report, in input order, watching up to four at once. Never fails: a source
// that cannot be read says so in its own report.
export const watchSources = (
  sources: ReadonlyArray<WatchedSource>,
  options: WatchOptions,
): Effect.Effect<SourceReport[], never, Git> =>
  Effect.forEach(sources, (source) => watchSource(source, options), { concurrency: 4 });
