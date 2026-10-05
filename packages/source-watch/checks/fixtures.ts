import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import { Effect } from 'effect';
import { Git, nodeGit } from '../src/git.ts';

// Keep the developer's git configuration out of every fixture and every git the tests spawn.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.TZ = 'UTC';

export type Files = Readonly<Record<string, string | null>>; // null deletes the path

// A temporary directory removed when the test ends.
export function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'source-watch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let tick = 0;
// Runs git synchronously with a fixed identity and a clock that advances one minute per call.
export function gitSync(cwd: string, ...args: string[]): string {
  const date = new Date(Date.UTC(2026, 0, 1) + tick++ * 60_000).toISOString().replace('.000', '');
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com', GIT_COMMITTER_DATE: date,
    },
  }).trim();
}

export function writeFiles(dir: string, files: Files): void {
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path);
    if (text === null) rmSync(full, { recursive: true, force: true });
    else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
  }
}

// Writes the files, commits everything and returns the new commit's sha.
export function commitFiles(dir: string, message: string, files: Files = {}): string {
  writeFiles(dir, files);
  gitSync(dir, 'add', '-A');
  gitSync(dir, 'commit', '--quiet', '--allow-empty', '-m', message);
  return gitSync(dir, 'rev-parse', 'HEAD');
}

export type Repo = {
  readonly dir: string;
  readonly url: string; // file:// URL
  commit(message: string, files?: Files): string;
  tag(name: string): void;
};

export function makeRepo(root: string, name = 'upstream'): Repo {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  gitSync(dir, 'init', '--quiet', '--initial-branch=main');
  return {
    dir,
    url: pathToFileURL(dir).href,
    commit: (message, files) => commitFiles(dir, message, files),
    tag: (tag) => void gitSync(dir, 'tag', tag),
  };
}

// Runs an effect against real git, refusing every transport but file://.
export const runGit = <A, E>(effect: Effect.Effect<A, E, Git>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(nodeGit({ allowProtocols: 'file' }))));
