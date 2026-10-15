import { Effect } from 'effect';
import { Fs, nodeFs } from '@nortuscc/machine';
import type { Git } from './git.ts';
import { watchCheckout } from './local.ts';
import type { SourceReport, WatchedSource } from './model.ts';
import { cacheFolder, watchUpstreamWithServices } from './upstream.ts';

export type WatchOptions = { readonly cacheDir: string; readonly toRevision?: string }; // holds one bare clone per source URL

// One source's upstream report, with its local checkout's edits when it has one.
export const watchSourceWithServices = (source: WatchedSource, options: WatchOptions): Effect.Effect<SourceReport, never, Git | Fs> =>
  Effect.gen(function* () {
    const report = yield* watchUpstreamWithServices(source, options);
    if (source.checkout === undefined) return report;
    return { ...report, local: yield* watchCheckout(source.checkout) };
  });

// Serialize aliases sharing a cache; at most two distinct caches read concurrently.
// Each declaration retains its own baseline, skills and optional target revision.
export const watchSourcesWithServices = (
  sources: ReadonlyArray<WatchedSource>,
  options: WatchOptions,
  revisions?: ReadonlyMap<string, string>,
): Effect.Effect<SourceReport[], never, Git | Fs> => {
  const groups = new Map<string, Array<{ source: WatchedSource; index: number }>>();
  sources.forEach((source, index) => {
    const key = cacheFolder(options.cacheDir, source.url);
    const group = groups.get(key) ?? [];
    group.push({ source, index });
    groups.set(key, group);
  });
  return Effect.forEach([...groups.values()], group =>
    Effect.forEach(group, ({ source, index }) =>
      watchSourceWithServices(source, {
        ...options,
        ...(revisions?.has(source.source) ? { toRevision: revisions.get(source.source)! } : {}),
      }).pipe(Effect.map(report => ({ index, report }))),
    { concurrency: 1 }),
  { concurrency: 2 }).pipe(
    Effect.map(groups => groups.flat().sort((a, b) => a.index - b.index).map(row => row.report)),
  );
};

export const watchSource = (...args: Parameters<typeof watchSourceWithServices>) =>
  watchSourceWithServices(...args).pipe(Effect.provide(nodeFs));
export const watchSources = (sources: ReadonlyArray<WatchedSource>, options: WatchOptions) =>
  watchSourcesWithServices(sources, options).pipe(Effect.provide(nodeFs));
