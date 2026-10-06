import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { Effect } from 'effect';
import { Fs } from '../fs.ts';
import { MachinePaths } from '../paths.ts';
import { Processes } from '../processes.ts';
import { lockRef, short } from './pins.ts';
import { readSkillLock } from './store.ts';
import { skillFolder } from './upstream.ts';

// One entry of a pinned skill folder's tree; `path` is relative to the skill folder.
export type TreeEntry = { readonly mode: string; readonly path: string; readonly sha: string };

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

const SCRIPT_EXTENSIONS = new Set([
  '.sh', '.bash', '.zsh', '.fish', '.py', '.js', '.mjs', '.cjs', '.ts', '.rb', '.pl', '.php', '.ps1', '.bat', '.cmd', '.exe',
]);
const SKIPPED_DIRS = new Set(['.git', '__pycache__', '__pypackages__']);
const dirsOf = (path: string) => path.split('/').slice(0, -1);

// Whether the installer copies a pinned path: it drops `metadata.json` files and `.git`, `__pycache__`, `__pypackages__` dirs.
const copied = (path: string) => !path.endsWith('/metadata.json') && path !== 'metadata.json' && !dirsOf(path).some((d) => SKIPPED_DIRS.has(d));

// Paths in a skill folder that can run code: executable blobs, script extensions, or anything under scripts/ or bin/.
export const bundledScripts = (entries: ReadonlyArray<Pick<TreeEntry, 'mode' | 'path'>>): string[] =>
  entries
    .filter((e) => e.mode === '100755' || SCRIPT_EXTENSIONS.has(extname(e.path).toLowerCase())
      || dirsOf(e.path).some((d) => d === 'scripts' || d === 'bin'))
    .map((e) => e.path)
    .sort(byCodePoint);

// Compares the pinned tree of one skill folder at `sha` with what was installed (path → blob sha).
// Problems sorted by path; empty when the install is exactly what the commit holds.
export const compareInstall = (pinned: ReadonlyArray<TreeEntry>, installed: ReadonlyMap<string, string>, sha: string): string[] => {
  const problems: [string, string][] = [];
  const covered = new Set<string>();
  const links: string[] = [];
  const under = (path: string, link: string) => path === link || path.startsWith(`${link}/`);
  for (const entry of pinned) {
    if (entry.mode === '160000' || !copied(entry.path)) continue;
    if (entry.mode === '120000') {
      // The installer dereferences links, so only the presence of what it points at can be checked.
      links.push(entry.path);
      if (![...installed.keys()].some((p) => under(p, entry.path))) problems.push([entry.path, `${entry.path} missing`]);
      continue;
    }
    covered.add(entry.path);
    const got = installed.get(entry.path);
    if (got === undefined) problems.push([entry.path, `${entry.path} missing`]);
    else if (got !== entry.sha) problems.push([entry.path, `${entry.path} differs`]);
  }
  for (const path of installed.keys()) {
    if (!covered.has(path) && !links.some((l) => under(path, l))) problems.push([path, `${path} not in ${short(sha)}`]);
  }
  return problems.sort((a, b) => byCodePoint(a[0], b[0])).map(([, problem]) => problem);
};

// Fetches `sha` from `url` by id into a temporary blobless repo and lists each folder's tree ('.' is the whole tree).
// null: the commit could not be fetched or is not `sha`.
export const pinnedTrees = (url: string, sha: string, folders: ReadonlyArray<string>): Effect.Effect<
  Map<string, TreeEntry[]> | null, never, Fs | Processes | MachinePaths
> => Effect.gen(function* () {
  const fs = yield* Fs;
  const processes = yield* Processes;
  const dir = join((yield* MachinePaths).stateRoot, 'tmp', `pin-${randomUUID()}`);
  const git = (...args: string[]) => processes.run({ cmd: 'git', args, output: 'capture' });
  const body = Effect.gen(function* () {
    if ((yield* git('init', '--quiet', dir)).code !== 0) return null;
    if ((yield* git('-C', dir, 'fetch', '--quiet', '--depth', '1', '--filter=blob:none', '--', url, sha)).code !== 0) return null;
    const fetched = yield* git('-C', dir, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}');
    if (fetched.code !== 0 || fetched.stdout.trim() !== sha) return null;
    const trees = new Map<string, TreeEntry[]>();
    for (const folder of new Set(folders)) {
      const listed = yield* git('-C', dir, 'ls-tree', '-r', '-z', sha, ...(folder === '.' ? [] : ['--', `${folder}/`]));
      if (listed.code !== 0) return null;
      const entries: TreeEntry[] = [];
      for (const record of listed.stdout.split('\0').filter(Boolean)) {
        // Split at the first tab only: with -z a path is not quoted and may itself hold a tab.
        const tab = record.indexOf('\t');
        const [mode, , object] = record.slice(0, tab).split(' ');
        const path = record.slice(tab + 1);
        entries.push({ mode: mode!, sha: object!, path: folder === '.' ? path : path.slice(folder.length + 1) });
      }
      trees.set(folder, entries);
    }
    return trees;
  });
  return yield* body.pipe(
    Effect.catch(() => Effect.succeed(null)),
    Effect.ensuring(fs.remove(dir).pipe(Effect.ignore)),
  );
});

// Every file under an installed skill folder (links followed) → its blob sha. null: unreadable.
const installedHashes = (name: string) => Effect.gen(function* () {
  const fs = yield* Fs;
  const processes = yield* Processes;
  const root = join((yield* MachinePaths).agentsSkills, name);
  const files: string[] = [];
  const seen = new Set<string>();
  const walk = (rel: string): Effect.Effect<void, unknown> => Effect.gen(function* () {
    const abs = rel ? join(root, rel) : root;
    const real = yield* fs.realPath(abs);
    if (real === undefined || seen.has(real)) return;
    const kind = (yield* fs.stat(real))?.kind;
    if (kind === 'file') files.push(rel);
    if (kind !== 'directory') return;
    seen.add(real);
    for (const entry of (yield* fs.list(abs)) ?? []) yield* walk(rel ? `${rel}/${entry}` : entry);
  });
  const body = Effect.gen(function* () {
    yield* walk('');
    if (files.length === 0) return new Map<string, string>();
    const hashed = yield* processes.run({
      cmd: 'git', args: ['hash-object', '--no-filters', '--', ...files.map((f) => join(root, f))], output: 'capture',
    });
    const shas = hashed.stdout.split('\n').filter(Boolean);
    if (hashed.code !== 0 || shas.length !== files.length) return null;
    return new Map(files.map((f, i) => [f, shas[i]!] as const));
  });
  return yield* body.pipe(Effect.catch(() => Effect.succeed(null)));
});

// Verifies installed skills against the pinned commit: per-skill problems (`failed`) and, for skills that
// match, the bundled scripts worth reviewing (`scripts`, only skills that bundle any).
export const verifyPinned = (input: { source: string; sha: string; names: ReadonlyArray<string> }): Effect.Effect<
  { failed: Map<string, string[]>; scripts: Map<string, string[]> }, never, Fs | Processes | MachinePaths
> => Effect.gen(function* () {
  const lock = yield* readSkillLock;
  const failed = new Map<string, string[]>();
  const scripts = new Map<string, string[]>();
  const folders = new Map<string, string>();
  let url = `https://github.com/${input.source}.git`;
  let urlFromLock = false;
  for (const name of input.names) {
    const meta = lock.skills[name];
    const ref = lockRef(meta);
    const skillPath = isRecord(meta) ? str(meta.skillPath) : null;
    if (ref !== input.sha) failed.set(name, [`lock records ${ref ? short(ref) : 'no pin'}`]);
    else if (!skillPath) failed.set(name, ['lock records no skill path']);
    else {
      folders.set(name, skillFolder(skillPath));
      const sourceUrl = str((meta as Record<string, unknown>).sourceUrl);
      if (sourceUrl && !urlFromLock) [url, urlFromLock] = [sourceUrl, true];
    }
  }
  if (folders.size === 0) return { failed, scripts };
  const trees = yield* pinnedTrees(url, input.sha, [...folders.values()]);
  for (const [name, folder] of folders) {
    if (!trees) {
      failed.set(name, [`could not fetch ${short(input.sha)}`]);
      continue;
    }
    const pinned = trees.get(folder) ?? [];
    const installed = yield* installedHashes(name);
    const problems = installed ? compareInstall(pinned, installed, input.sha) : ['installed files unreadable'];
    if (problems.length) failed.set(name, problems);
    else {
      const found = bundledScripts(pinned.filter((e) => e.mode !== '160000' && copied(e.path)));
      if (found.length) scripts.set(name, found);
    }
  }
  return { failed, scripts };
});
