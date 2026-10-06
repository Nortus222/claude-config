import { Effect } from 'effect';
import { Processes, type LaunchFailed } from '@nortuscc/machine';
import { readDocuments, type Documents } from './documents.ts';
import { RevisionUnavailable } from './source.ts';

// Read-only git in `repo`, stdout captured; stderr goes where the caller's Processes sends it.
const git = (repo: string, args: ReadonlyArray<string>) =>
  Processes.use((p) => p.run({ cmd: 'git', args: [...args], cwd: repo, output: 'capture' }));

// The full SHA of the commit a revision names, or undefined when this repository has none.
export const revParse = (repo: string, revision: string): Effect.Effect<string | undefined, LaunchFailed, Processes> =>
  revision.startsWith('-')
    ? Effect.succeed(undefined)
    : Effect.map(git(repo, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]), ({ code, stdout }) =>
      (code === 0 && stdout.trim() !== '' ? stdout.trim() : undefined));

// A commit's profile documents, read from git objects alone.
export const commitDocuments = (repo: string, commit: string): Effect.Effect<Documents, RevisionUnavailable | LaunchFailed, Processes> =>
  Effect.gen(function* () {
    const sha = yield* revParse(repo, commit);
    if (sha === undefined) return yield* Effect.fail(new RevisionUnavailable({ revision: commit, reason: 'no such commit in the checkout' }));
    const listed = yield* git(repo, ['ls-tree', '-r', '-z', '--name-only', sha]);
    if (listed.code !== 0) return yield* Effect.fail(new RevisionUnavailable({ revision: commit, reason: 'its tree could not be listed' }));
    const tree = new Set(listed.stdout.split('\0').filter(Boolean));
    return yield* readDocuments((path) =>
      Effect.gen(function* () {
        if (!tree.has(path)) return undefined;
        const blob = yield* git(repo, ['cat-file', 'blob', `${sha}:${path}`]);
        if (blob.code !== 0) return yield* Effect.fail(new RevisionUnavailable({ revision: commit, reason: `${path} could not be read` }));
        return blob.stdout;
      }));
  });
