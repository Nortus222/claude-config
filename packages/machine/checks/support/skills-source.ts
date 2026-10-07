import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Effect, Layer } from 'effect';
import { nodeProcesses, Processes, type Command, type MachinePathsValue } from '../../src/index.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();

export type Files = Record<string, string | { readonly text: string; readonly mode: 0o755 }>;

// A local skill source repo. Each skill `<name>` lives at `skills/<name>/`.
export const skillSource = (home: string) => {
  const dir = join(home, 'upstream');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'uploadpack.allowFilter', 'true');
  // Replaces the work tree's files with `files` and commits; returns the commit sha.
  const commit = (files: Files) => {
    for (const entry of git(dir, 'ls-files', '-z').split('\0').filter(Boolean)) rmSync(join(dir, entry));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), typeof content === 'string' ? content : content.text);
      if (typeof content !== 'string') chmodSync(join(dir, path), content.mode);
    }
    git(dir, 'add', '-A');
    // Windows chmod cannot set Git's executable bit; set the fixture's committed mode explicitly.
    for (const [path, content] of Object.entries(files)) {
      git(dir, 'update-index', typeof content === 'string' ? '--chmod=-x' : '--chmod=+x', '--', path);
    }
    git(dir, 'commit', '-qm', 'c', '--allow-empty');
    return git(dir, 'rev-parse', 'HEAD');
  };
  const branch = (name: string, at: string) => git(dir, 'branch', name, at);
  return { dir, url: pathToFileURL(dir).href, commit, branch };
};

const lockFile = (paths: MachinePathsValue) => join(paths.agentsSkills, '..', '.skill-lock.json');
export const readLock = (paths: MachinePathsValue): Record<string, Record<string, unknown>> =>
  existsSync(lockFile(paths)) ? JSON.parse(readFileSync(lockFile(paths), 'utf8')).skills : {};

// Simulates `npx -y skills add|remove …` against `source`: `add o/r#<ref>` copies `skills/<name>/` at a
// branch named `<ref>` when one exists, else at the commit `<ref>` (the installer's `--branch` first rule),
// and records the lock entry. Every other command runs for real. `partial` makes `add` write only `writes`
// (default: every named skill) and then exit with `exit`, like an installer that fails midway.
export const fakeInstaller = (
  paths: MachinePathsValue,
  source: { dir: string; url: string },
  partial?: { readonly exit: number; readonly writes?: ReadonlyArray<string> },
) => {
  const commands: Command[] = [];
  const fake = (command: Command) => {
    const [, , verb, ...rest] = command.args;
    const valuesOf = (flag: string) => {
      const at = rest.indexOf(flag);
      if (at < 0) return [];
      const end = rest.findIndex((a, i) => i > at && a.startsWith('--'));
      return rest.slice(at + 1, end < 0 ? undefined : end);
    };
    const lock = readLock(paths);
    if (verb === 'remove') {
      for (const n of rest.filter((a) => !a.startsWith('--'))) {
        rmSync(join(paths.agentsSkills, n), { recursive: true, force: true });
        delete lock[n];
      }
    } else if (verb === 'add') {
      const [arg] = rest;
      const hash = arg!.lastIndexOf('#');
      const name = hash < 0 ? arg! : arg!.slice(0, hash);
      const ref = hash < 0 ? 'HEAD' : arg!.slice(hash + 1);
      let rev = ref;
      try { rev = git(source.dir, 'rev-parse', '--verify', '-q', `refs/heads/${ref}`); } catch { /* not a branch */ }
      for (const n of valuesOf('--skill')) {
        if (partial?.writes && !partial.writes.includes(n)) continue;
        const out = mkdtempSync(join(tmpdir(), 'fake-installer-'));
        try {
          const archive = execFileSync('git', ['archive', rev, `skills/${n}`], { cwd: source.dir });
          execFileSync('tar', ['-x', '-C', out], { input: archive });
          rmSync(join(paths.agentsSkills, n), { recursive: true, force: true });
          mkdirSync(paths.agentsSkills, { recursive: true });
          cpSync(join(out, 'skills', n), join(paths.agentsSkills, n), { recursive: true });
        } finally {
          rmSync(out, { recursive: true, force: true });
        }
        lock[n] = { source: name, sourceUrl: source.url, skillPath: `skills/${n}/SKILL.md`, ...(hash < 0 ? {} : { ref }) };
        if (valuesOf('--agent').includes('claude-code')) mkdirSync(join(paths.claude, 'skills', n), { recursive: true });
      }
    } else {
      return { code: 2, stdout: '' };
    }
    mkdirSync(dirname(lockFile(paths)), { recursive: true });
    writeFileSync(lockFile(paths), JSON.stringify({ skills: lock }));
    return { code: verb === 'add' && partial ? partial.exit : 0, stdout: '' };
  };
  const layer = Layer.effect(Processes, Effect.gen(function* () {
    const real = yield* Processes;
    return {
      run: (command: Command) => command.cmd === 'npx'
        ? Effect.sync(() => (commands.push(command), fake(command)))
        : real.run(command),
    };
  })).pipe(Layer.provide(nodeProcesses()));
  return { commands, layer };
};
