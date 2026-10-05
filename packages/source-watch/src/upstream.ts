import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { skillFolders } from './discover.ts';
import { DIFF_FLAGS, Git, GitFailed, LOG_FORMAT, parseLog } from './git.ts';
import type { Revision, SkillChange, SourceReport, SourceStatus, WatchedSource } from './model.ts';
import { redact } from './redact.ts';

type Run = (args: ReadonlyArray<string>, ok?: ReadonlyArray<number>) => Effect.Effect<string, GitFailed>;

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

// Where a source's bare partial clone lives: named by a hash, so no URL (or credential in one)
// reaches the filesystem.
export function cacheFolder(cacheDir: string, url: string): string {
  return join(cacheDir, createHash('sha256').update(url).digest('hex').slice(0, 16));
}

// One source's upstream: its latest revision, how that relates to the baseline, the commits
// between them and what changed in the setup's skills. Any git failure becomes an
// `unreachable` report, so one source never fails another.
export const watchUpstream = (
  source: WatchedSource,
  options: { readonly cacheDir: string },
): Effect.Effect<SourceReport, never, Git> =>
  inspect(source, options.cacheDir).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        source: redact(source.source),
        url: redact(source.url),
        status: 'unreachable',
        reason: error.reason,
        commits: [],
        skills: [],
        added: [],
      } satisfies SourceReport),
    ),
  );

const inspect = (source: WatchedSource, cacheDir: string): Effect.Effect<SourceReport, GitFailed, Git> =>
  Effect.gen(function* () {
    const git = yield* Git;
    const dir = cacheFolder(cacheDir, source.url);
    const run: Run = (args, ok) => git.run(args, ok === undefined ? { cwd: dir } : { cwd: dir, ok });

    if (existsSync(dir)) yield* run(['fetch', '--prune', '--quiet', 'origin', '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*']);
    else yield* git.run(['clone', '--bare', '--filter=blob:none', '--quiet', '--', source.url, dir]);

    const latest = yield* revision(run, 'HEAD');
    const atLatest = yield* skillsAt(run, latest.sha);
    const report = { source: redact(source.source), url: redact(source.url), latest, commits: [], added: [] };

    if (source.baseline === undefined) {
      const skills = source.skills.map((name): SkillChange => {
        const path = atLatest.get(name);
        return path === undefined
          ? { name, status: 'missing', commits: [], files: [] }
          : { name, path, status: 'unchanged', commits: [], files: [] };
      });
      return { ...report, status: 'unpinned', skills } satisfies SourceReport;
    }

    const sha = yield* findCommit(run, source.baseline);
    if (sha === undefined) {
      return {
        ...report,
        status: 'baseline-missing',
        reason: redact(`baseline '${source.baseline}' is not in ${source.url}`),
        skills: [],
      } satisfies SourceReport;
    }

    const mergeBase = (yield* run(['merge-base', sha, latest.sha], [0, 1])).trim();
    const status: SourceStatus = sha === latest.sha ? 'up-to-date' : mergeBase === sha ? 'ahead' : 'diverged';
    const commits = parseLog(yield* run(['log', LOG_FORMAT, `${sha}..${latest.sha}`]));
    const atBaseline = yield* skillsAt(run, sha);
    const skills = yield* Effect.forEach(source.skills, (name) =>
      compareSkill(run, name, sha, latest.sha, atBaseline.get(name), atLatest.get(name)),
    );
    const declared = new Set(source.skills);
    const added = source.exact
      ? []
      : [...atLatest.keys()].filter((name) => !atBaseline.has(name) && !declared.has(name)).sort();
    const baseline = { ref: source.baseline, ...(yield* revision(run, sha)) };
    return { ...report, status, baseline, commits, skills, added } satisfies SourceReport;
  });

// A commit's sha, strict ISO committer date and the tags pointing at it.
const revision = (run: Run, rev: string): Effect.Effect<Revision, GitFailed> =>
  Effect.gen(function* () {
    const [sha = '', date = ''] = (yield* run(['log', '-1', '--format=%H%x1f%cI', rev])).trim().split('\x1f');
    const tags = (yield* run(['tag', '--points-at', sha])).split('\n').filter((tag) => tag !== '');
    return { sha, date, tags };
  });

// Resolves a baseline ref to a commit sha. A full sha the clone lacks (on no branch, say) is
// fetched by id once. A ref that git could read as an option is never passed to it.
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

const treeSha = (run: Run, sha: string, path: string) =>
  run(['rev-parse', `${sha}:${path}`]).pipe(Effect.map((out) => out.trim()));

// One declared skill between two revisions, given its folder at each (undefined when absent).
// A skill only at `to` is changed, and its SKILL.md diffs against nothing; a moved folder
// diffs its old SKILL.md against its new one.
const compareSkill = (
  run: Run,
  name: string,
  from: string,
  to: string,
  before: string | undefined,
  after: string | undefined,
): Effect.Effect<SkillChange, GitFailed> =>
  Effect.gen(function* () {
    const none = { name, commits: [], files: [] };
    if (after === undefined) {
      return before === undefined
        ? ({ ...none, status: 'missing' } satisfies SkillChange)
        : ({ ...none, path: before, status: 'removed' } satisfies SkillChange);
    }
    if (before !== undefined && (yield* treeSha(run, from, before)) === (yield* treeSha(run, to, after))) {
      return { ...none, path: after, status: 'unchanged' } satisfies SkillChange;
    }

    const folders = before === undefined || before === after ? [after] : [before, after];
    const skillFiles = new Set(folders.map((folder) => `${folder}/SKILL.md`));
    const commits = (yield* run(['log', '--format=%H', `${from}..${to}`, '--', ...folders]))
      .split('\n')
      .filter((sha) => sha !== '');
    const files = (yield* run(['diff', '--name-only', '-z', from, to, '--', ...folders]))
      .split('\0')
      .filter((path) => path !== '' && !skillFiles.has(path));
    const skillMd =
      before === undefined
        ? yield* run(['diff', ...DIFF_FLAGS, from, to, '--', `${after}/SKILL.md`])
        : yield* run(['diff', ...DIFF_FLAGS, `${from}:${before}/SKILL.md`, `${to}:${after}/SKILL.md`]);
    return {
      name,
      path: after,
      status: 'changed',
      commits,
      files,
      ...(skillMd === '' ? {} : { skillMd }),
    } satisfies SkillChange;
  });
