import { Effect } from 'effect';
import { skillFolders } from './discover.ts';
import { DIFF_FLAGS, Git, GitFailed, LOG_FORMAT, parseLog } from './git.ts';
import type { LocalReport, LocalSkill } from './model.ts';

type Run = (args: ReadonlyArray<string>, ok?: ReadonlyArray<number>) => Effect.Effect<string, GitFailed>;

// Paths from `git status --porcelain=v1 -z`. A rename or copy entry is followed by its original
// path, which is skipped.
export function parseStatus(out: string): Array<{ path: string; untracked: boolean }> {
  const tokens = out.split('\0');
  const entries: Array<{ path: string; untracked: boolean }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.length < 4) continue;
    const xy = token.slice(0, 2);
    entries.push({ path: token.slice(3), untracked: xy === '??' });
    if (xy[0] === 'R' || xy[0] === 'C') i++;
  }
  return entries;
}

// Edits in the author's checkout not yet pushed: commits ahead of its upstream and uncommitted
// paths, with each touched skill's SKILL.md diff. Read-only: it never fetches. Edits are
// measured from the merge base with the upstream, or from HEAD when there is none or it shares no history. A path that
// is not a git work tree, or any git failure, reads as `not-a-repo`.
export const watchCheckout = (path: string): Effect.Effect<LocalReport, never, Git> =>
  inspect(path).pipe(
    Effect.catch(() =>
      Effect.succeed({ path, status: 'not-a-repo', unpushed: [], uncommitted: [], skills: [] } satisfies LocalReport),
    ),
  );

const inspect = (path: string): Effect.Effect<LocalReport, GitFailed, Git> =>
  Effect.gen(function* () {
    const git = yield* Git;
    const top = (yield* git.run(['rev-parse', '--show-toplevel'], { cwd: path })).trim();
    const run: Run = (args, ok) => git.run(args, ok === undefined ? { cwd: top } : { cwd: top, ok });

    const branch = yield* run(['rev-parse', '--abbrev-ref', 'HEAD']).pipe(
      Effect.map((out) => out.trim()),
      Effect.orElseSucceed(() => ''),
    );
    const entries = parseStatus(yield* run(['status', '--porcelain=v1', '-z', '--untracked-files=all']));
    const hasUpstream = yield* run(['rev-parse', '--verify', '--quiet', '@{u}']).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    const since = hasUpstream
      ? (yield* run(['merge-base', 'HEAD', '@{u}']).pipe(
          Effect.map((out) => out.trim()),
          Effect.orElseSucceed(() => 'HEAD'),
        ))
      : 'HEAD';
    const unpushed = hasUpstream ? parseLog(yield* run(['log', LOG_FORMAT, '@{u}..HEAD'])) : [];

    const tracked = (yield* run(['diff', '--name-only', '-z', since]).pipe(Effect.orElseSucceed(() => '')))
      .split('\0')
      .filter((p) => p !== '');
    const changed = [...tracked, ...entries.map((e) => e.path)];
    const untracked = new Set(entries.filter((e) => e.untracked).map((e) => e.path));
    const folders = skillFolders(
      (yield* run(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter((p) => p !== ''),
    );

    const skills: LocalSkill[] = [];
    for (const [name, folder] of [...folders].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (!changed.some((p) => p.startsWith(`${folder}/`))) continue;
      const file = `${folder}/SKILL.md`;
      const skillMd = untracked.has(file)
        ? yield* run(['diff', ...DIFF_FLAGS, '--no-index', '--', '/dev/null', file], [0, 1])
        : yield* run(['diff', ...DIFF_FLAGS, since, '--', file]);
      skills.push(skillMd === '' ? { name, path: folder } : { name, path: folder, skillMd });
    }

    const uncommitted = entries.map((e) => e.path).sort();
    const status = !hasUpstream ? 'no-upstream' : unpushed.length > 0 || uncommitted.length > 0 ? 'edits' : 'clean';
    return {
      path,
      status,
      ...(branch === '' ? {} : { branch }),
      unpushed,
      uncommitted,
      skills,
    } satisfies LocalReport;
  });
