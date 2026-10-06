import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Effect, Layer } from 'effect';
import { loadProfile, nodeFiles } from '@nortuscc/profile-engine';
import { nodeFs, nodeProcesses, type Fs, type Processes } from '@nortuscc/machine';

export const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
export const IDENTITY = ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'];
export const SHA_A = 'a'.repeat(40);

// A small setup: two settings keys, an instruction file, two skill groups with one pin, and a hook
// that ships its file next to a plugin.
export const BASE: Readonly<Record<string, string>> = {
  'claude/settings.keys.json': json({ theme: 'auto', effortLevel: 'high' }),
  'claude/CLAUDE.md': '# rules\n',
  'skills-manifest.txt': '[mattpocock/skills]\ntdd\ndiagnose\n\n[anthropics/skills] optional\npdf\n',
  'skill-pins.json': json({ version: 1, pins: { 'mattpocock/skills': SHA_A } }),
  'integrations.json': json({
    version: 1,
    integrations: [
      { id: 'hk', label: 'session hook', target: 'claude', type: 'hook', default: true, event: 'SessionStart', file: 'claude/hooks/hk.mjs' },
      { id: 'sp', label: 'superpowers', target: 'claude', type: 'plugin', default: true, plugin: 'superpowers@official' },
    ],
  }),
  'claude/hooks/hk.mjs': 'console.log("hk");\n',
};

// `documents` with `changes` applied; null removes a document.
export const withDocuments = (
  documents: Readonly<Record<string, string>>,
  changes: Readonly<Record<string, string | null>>,
): Readonly<Record<string, string>> => {
  const out: Record<string, string> = { ...documents };
  for (const [path, text] of Object.entries(changes)) {
    if (text === null) delete out[path];
    else out[path] = text;
  }
  return out;
};

// A git repository at <root>/repo holding `files` in one commit. `commit` writes changes (null
// deletes) and answers the new SHA.
export const tempRepo = (files: Readonly<Record<string, string>> = BASE) => {
  const root = mkdtempSync(join(tmpdir(), 'sync-'));
  const dir = join(root, 'repo');
  mkdirSync(dir);
  const git = (...args: string[]) => execFileSync('git', [...IDENTITY, ...args], { cwd: dir, encoding: 'utf8' }).trim();
  const write = (changes: Readonly<Record<string, string | null>>) => {
    for (const [path, text] of Object.entries(changes)) {
      const full = join(dir, path);
      if (text === null) rmSync(full, { force: true });
      else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, text);
      }
    }
  };
  const commit = (changes: Readonly<Record<string, string | null>>, message = 'change') => {
    write(changes);
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  const first = commit(files, 'initial');
  return { root, dir, git, write, commit, first };
};

export const runSync = <A, E>(effect: Effect.Effect<A, E, Fs | Processes>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(nodeFs, nodeProcesses()))));

// The error `effect` fails with; fails the test when it succeeds.
export const failureOf = async <A, E>(effect: Effect.Effect<A, E, Fs | Processes>): Promise<E> => {
  const result = await runSync(Effect.result(effect));
  if (result._tag !== 'Failure') assert.fail('expected a failure');
  return result.failure;
};

export const load = (dir: string) => Effect.runPromise(loadProfile(dir).pipe(Effect.provide(nodeFiles)));
