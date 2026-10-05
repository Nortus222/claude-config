import { existsSync } from 'node:fs';
import { Data, Effect } from 'effect';
import { skillFolders } from './discover.ts';
import { Git, type GitFailed } from './git.ts';
import type { WatchedSource } from './model.ts';
import { redact } from './redact.ts';
import { cacheFolder } from './upstream.ts';

export type SkillMove = { readonly name: string; readonly status: 'unchanged' | 'changed' | 'removed' | 'missing' };
export type PinImpact = {
  readonly source: string; // redacted
  readonly from?: { readonly ref: string; readonly sha: string }; // absent when unpinned: compared against HEAD
  readonly to: { readonly ref: string; readonly sha: string };
  readonly skills: ReadonlyArray<SkillMove>; // every declared skill, in declared order
};

// A pin's target or baseline is not a commit in the source. `reason` is redacted.
export class RefMissing extends Data.TaggedError('RefMissing')<{ readonly reason: string }> {}

type Run = (args: ReadonlyArray<string>, ok?: ReadonlyArray<number>) => Effect.Effect<string, GitFailed>;

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

// What pinning `source` to `ref` does to each of its declared skills, compared with its current
// pin (or HEAD, which an unpinned source installs). Pins are per source, so one skill's update
// moves them all. Reuses the watcher's cache, cloning it when absent and never refreshing it,
// except to fetch a full-sha target or baseline by id.
export const pinImpact = (
  source: WatchedSource,
  ref: string,
  options: { readonly cacheDir: string },
): Effect.Effect<PinImpact, GitFailed | RefMissing, Git> =>
  Effect.gen(function* () {
    const git = yield* Git;
    const dir = cacheFolder(options.cacheDir, source.url);
    const run: Run = (args, ok) => git.run(args, ok === undefined ? { cwd: dir } : { cwd: dir, ok });
    if (!existsSync(dir)) yield* git.run(['clone', '--bare', '--filter=blob:none', '--quiet', '--', source.url, dir]);

    const resolve = (rev: string) =>
      findCommit(run, rev).pipe(
        Effect.flatMap((sha) =>
          sha === undefined
            ? Effect.fail(new RefMissing({ reason: redact(`'${rev}' is not in ${source.url}`) }))
            : Effect.succeed(sha),
        ),
      );
    const to = yield* resolve(ref);
    const from = source.baseline === undefined ? (yield* run(['rev-parse', 'HEAD'])).trim() : yield* resolve(source.baseline);

    const before = yield* skillsAt(run, from);
    const after = yield* skillsAt(run, to);
    const skills = yield* Effect.forEach(source.skills, (name) =>
      move(run, from, to, before.get(name), after.get(name)).pipe(Effect.map((status): SkillMove => ({ name, status }))),
    );
    return {
      source: redact(source.source),
      ...(source.baseline === undefined ? {} : { from: { ref: source.baseline, sha: from } }),
      to: { ref, sha: to },
      skills,
    } satisfies PinImpact;
  });

// The watcher's rule: a ref git could read as an option is never passed to it, and a full sha
// the cache lacks is fetched by id once.
const findCommit = (run: Run, ref: string): Effect.Effect<string | undefined, GitFailed> =>
  Effect.gen(function* () {
    if (ref.startsWith('-')) return undefined;
    const resolve = run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], [0, 1]).pipe(
      Effect.map((out) => out.trim()),
    );
    let sha = yield* resolve;
    if (sha === '' && FULL_SHA.test(ref)) {
      yield* run(['fetch', '--quiet', 'origin', ref]).pipe(Effect.ignore);
      sha = yield* resolve;
    }
    return sha === '' ? undefined : sha;
  });

const skillsAt = (run: Run, sha: string) =>
  run(['ls-tree', '-r', '--name-only', '-z', sha]).pipe(
    Effect.map((out) => skillFolders(out.split('\0').filter((path) => path !== ''))),
  );

// One skill between two revisions, given its folder at each (undefined when absent).
const move = (
  run: Run,
  from: string,
  to: string,
  before: string | undefined,
  after: string | undefined,
): Effect.Effect<SkillMove['status'], GitFailed> =>
  Effect.gen(function* () {
    if (after === undefined) return before === undefined ? 'missing' : 'removed';
    if (before === undefined) return 'changed';
    const tree = (sha: string, path: string) => run(['rev-parse', `${sha}:${path}`]).pipe(Effect.map((out) => out.trim()));
    return (yield* tree(from, before)) === (yield* tree(to, after)) ? 'unchanged' : 'changed';
  });
