import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import type { DesiredConfig } from '@nortuscc/profile-engine';
import {
  MachinePaths, machinePaths, nodeFs, nodeProcesses, Processes, updateItems,
  type Command, type Completed, type MachinePathsValue, type Observed,
} from '@nortuscc/machine';
import { select as realSelect } from '../src/select.ts';
import { choices, exitCode, parseFlags, reportLines, runUpdate, seedKeys, type UpdateDeps } from '../src/commands/update.ts';

// ---- pure ----

const EMPTY: DesiredConfig = { files: [], skills: [], integrations: [], allow: {}, issues: [] };

// Observed items exactly as inspectUpdates builds them, from the legacy plan buckets.
const items = (spec: {
  current?: string[];
  outdated?: { name: string; from: string | null; to: string; source?: string }[];
  gone?: string[];
  unknown?: string[];
  local?: string[];
  available?: string[];
  offPin?: { name: string; from: string | null; to: string | null }[];
}): Observed[] => updateItems({
  current: (spec.current ?? []).map((name) => ({ name, source: 'o/r' })),
  outdated: (spec.outdated ?? []).map((o) => ({ source: 'o/r', ...o })),
  gone: (spec.gone ?? []).map((name) => ({ name, source: 'o/r', path: `s/${name}` })),
  unknown: (spec.unknown ?? []).map((name) => ({ name, source: 'o/r' })),
  local: spec.local ?? [],
  available: (spec.available ?? []).map((name) => ({ name, source: 'o/r' })),
  offPin: (spec.offPin ?? []).map((o) => ({ source: 'o/r', ...o })),
}, EMPTY);

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('exitCode is 1 for an off-pin skill left in place', () => {
  assert.equal(exitCode({ items: items({ offPin: [{ name: 'p', from: B, to: A }] }), failed: false }), 1);
});

test('exitCode does not count an off-pin skill named in repinnedNames', () => {
  assert.equal(exitCode({ items: items({ offPin: [{ name: 'p', from: B, to: A }] }), failed: false, repinnedNames: ['p'] }), 0);
});

test('reportLines counts off-pin skills and details each with the status note', () => {
  const lines = reportLines(items({ offPin: [{ name: 'p', from: B, to: A }, { name: 'q', from: B, to: null }] }));
  assert.match(lines.join('\n'), /off-pin\s+2\s+p, q/);
  assert.ok(lines.some((l) => /^\s+p\s+off-pin\s+installed at bbbbbbb, pinned to aaaaaaa  o\/r$/.test(l)));
  assert.ok(lines.some((l) => /^\s+q\s+off-pin\s+installed at bbbbbbb, unpinned  o\/r$/.test(l)));
});

test('exitCode is 0 when everything is current', () => {
  assert.equal(exitCode({ items: items({ current: ['a'] }), failed: false }), 0);
});

test('exitCode is 1 for a gone skill even with nothing outdated', () => {
  assert.equal(exitCode({ items: items({ gone: ['a'] }), failed: false }), 1);
});

test('exitCode is 1 for an unreachable source', () => {
  assert.equal(exitCode({ items: items({ unknown: ['a'] }), failed: false }), 1);
});

test('exitCode is 1 when the updater failed', () => {
  assert.equal(exitCode({ items: items({ outdated: [{ name: 'a', from: 'x', to: 'y' }] }), failed: true }), 1);
});

test('exitCode ignores local skills, which are informational', () => {
  assert.equal(exitCode({ items: items({ local: ['mine'] }), failed: false }), 0);
});

test('exitCode is 0 for an outdated skill left alone — declining is not a failure', () => {
  assert.equal(exitCode({ items: items({ outdated: [{ name: 'a', from: 'x', to: 'y' }] }), failed: false }), 0);
});

test('exitCode does not count a gone skill named in prunedNames toward exit 1', () => {
  assert.equal(exitCode({ items: items({ gone: ['a'] }), failed: false, prunedNames: ['a'] }), 0);
});

test('exitCode is 1 when the machine could not be read', () => {
  assert.equal(exitCode({ items: [], failed: false, probeErrors: ['skills: list /s: not a directory'] }), 1);
});

test('exitCode ignores available skills', () => {
  assert.equal(exitCode({ items: items({ available: ['wizard'] }), failed: false }), 0);
});

test('reportLines shows both SHAs for an outdated skill', () => {
  const text = reportLines(items({ outdated: [{ name: 'tdd', from: 'abcdef1234', to: '1234567890' }] })).join('\n');
  assert.match(text, /tdd/);
  assert.match(text, /abcdef1/);
  assert.match(text, /1234567/);
  assert.match(text, /tdd\s+outdated\s+abcdef1 -> 1234567  o\/r/);
});

test('reportLines counts each bucket and names an unreachable skill', () => {
  const text = reportLines(items({
    current: ['c'], gone: ['g'], unknown: ['u'], local: ['l'], available: ['a'],
  })).join('\n');
  assert.match(text, /current\s+1/);
  assert.match(text, /gone\s+1\s+g/);
  assert.match(text, /unreachable\s+1\s+u/);
  assert.match(text, /local\s+1\s+l/);
  assert.match(text, /available\s+1\s+a/);
});

test('reportLines says so when nothing is installed', () => {
  assert.match(reportLines([]).join('\n'), /skills\s+none\s+nothing installed to check/);
});

test('reportLines gone footer names the gone skills and points at --prune', () => {
  const text = reportLines(items({ outdated: [{ name: 'stale', from: 'a', to: 'b' }], gone: ['vanished'] })).join('\n');
  const footer = text.split('\n').filter((l) => /gone upstream|nortuscc update --prune/.test(l)).join('\n');
  assert.match(footer, /vanished/);
  assert.doesNotMatch(footer, /\bstale\b/);
  assert.doesNotMatch(text, /skills remove|nortuscc capture/);
});

test('parseFlags reads --add as a comma list', () => {
  assert.deepEqual(parseFlags(['--add', 'a,b']).add, ['a', 'b']);
});

test('parseFlags accepts --add=a,b', () => {
  assert.deepEqual(parseFlags(['--add=a,b']).add, ['a', 'b']);
});

test('parseFlags rejects --add with no names', () => {
  // There is deliberately no way to adopt a whole repo from a flag.
  assert.match(parseFlags(['--add']).error!, /--add/);
  assert.match(parseFlags(['--add', '--prune']).error!, /--add/);
});

test('parseFlags reads --prune as a boolean', () => {
  assert.equal(parseFlags(['--prune']).prune, true);
  assert.equal(parseFlags([]).prune, false);
});

test('parseFlags refuses --check with an action flag', () => {
  assert.match(parseFlags(['--check', '--prune']).error!, /--check/);
  assert.match(parseFlags(['--check', '--add', 'x']).error!, /--check/);
  assert.match(parseFlags(['--check', '--yes']).error!, /--check/);
});

test('parseFlags refuses an unknown flag', () => {
  assert.match(parseFlags(['--chek']).error!, /--chek/);
});

test('parseFlags refuses a bare positional argument', () => {
  assert.match(parseFlags(['tdd']).error!, /tdd/);
});

const PICK = items({
  current: ['fine'],
  outdated: [{ name: 'tdd', from: 'aaaaaaa1', to: 'bbbbbbb2' }],
  gone: ['to-issues'],
  local: ['mine'],
  available: ['wizard'],
});

test('choices offers one row per actionable skill and nothing for current or local', () => {
  assert.deepEqual(choices(PICK, new Set()).map((r) => r.key), ['skill:tdd', 'skill:to-issues', 'skill:wizard']);
});

test('choices groups rows as update, remove and add in that order', () => {
  assert.deepEqual(choices(PICK, new Set()).map((r) => r.group), ['update', 'remove', 'add']);
});

test('choices checks outdated by default and leaves remove and add clear', () => {
  assert.deepEqual(choices(PICK, new Set()).map((r) => r.checked), [true, false, false]);
});

test('choices checks a seeded row', () => {
  assert.equal(choices(PICK, new Set(['skill:wizard'])).find((r) => r.key === 'skill:wizard')!.checked, true);
});

test('choices notes carry the legacy text and the source', () => {
  assert.deepEqual(choices(PICK, new Set()).map((r) => r.note),
    ['aaaaaaa -> bbbbbbb  o/r', 'gone upstream  o/r', 'available  o/r']);
});

test('choices labels rows with the bare skill name', () => {
  assert.deepEqual(choices(PICK, new Set()).map((r) => r.label), ['tdd', 'to-issues', 'wizard']);
});

test('choices offers an off-pin skill as a checked update row with its note', () => {
  const rows = choices(items({ offPin: [{ name: 'p', from: B, to: A }] }), new Set());
  assert.deepEqual(rows, [{ key: 'skill:p', group: 'update', label: 'p', note: 'installed at bbbbbbb, pinned to aaaaaaa  o/r', checked: true }]);
});

test('choices on items with nothing actionable is empty', () => {
  assert.deepEqual(choices(items({ current: ['a'], local: ['b'] }), new Set()), []);
});

test('seedKeys with --prune checks every gone skill', () => {
  assert.deepEqual([...seedKeys(PICK, { add: [], prune: true })], ['skill:to-issues']);
});

test('seedKeys with named adds checks only those', () => {
  assert.deepEqual([...seedKeys(PICK, { add: ['wizard'], prune: false })], ['skill:wizard']);
});

test('seedKeys ignores a named add that is not available', () => {
  assert.deepEqual([...seedKeys(PICK, { add: ['nope', 'tdd'], prune: false })], []);
});

test('seedKeys with neither flag seeds nothing', () => {
  assert.deepEqual([...seedKeys(PICK, { add: [], prune: false })], []);
});

// ---- orchestration: a temp machine, real git sources, a fake installer ----

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();

// A local source repo with one folder per skill under s/.
function sourceRepo(dir: string, folders: string[]) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  for (const name of folders) {
    mkdirSync(join(dir, 's', name), { recursive: true });
    writeFileSync(join(dir, 's', name, 'SKILL.md'), `# ${name}\n`);
  }
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'skills');
  return { url: `file://${dir}`, tree: (name: string) => git(dir, 'rev-parse', `HEAD:s/${name}`) };
}

const CURRENT = '<current upstream tree>';

type Behaviour = {
  readonly fail?: 'add' | 'update' | 'remove';
  // add blocks until interrupted.
  readonly block?: 'add';
  // `git clone` of a source blocks until interrupted.
  readonly blockClone?: boolean;
  // The hash `update` records: absent means the upstream tree, null leaves the lock alone.
  readonly updateTo?: string | null;
};

type Options = {
  // Folders the o/r source offers.
  readonly upstream?: string[];
  // name -> recorded hash (CURRENT for the upstream tree). Each is in the store and linked for Claude.
  readonly installed?: Record<string, string>;
  readonly manifest?: string;
  readonly unreachable?: boolean;
  // Lock entries that replace the generated ones (another source, say).
  readonly lockOverride?: Record<string, object>;
};

function machine(options: Options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'nortuscc-update-ts-'));
  const paths: MachinePathsValue = {
    repo: join(home, 'repo'), claude: join(home, '.claude'), codex: join(home, '.codex'),
    codexOpenRouter: join(home, '.codex-openrouter'), agentsSkills: join(home, '.agents', 'skills'),
    stateRoot: join(home, 'state'), backups: join(home, 'state', 'backups'),
  };
  for (const dir of [paths.repo, paths.claude, paths.codex, paths.agentsSkills]) mkdirSync(dir, { recursive: true });
  const manifestFile = join(paths.repo, 'skills-manifest.txt');
  if (options.manifest !== undefined) writeFileSync(manifestFile, options.manifest);

  const src = sourceRepo(join(home, 'upstream'), options.upstream ?? ['stale', 'fresh']);
  const sourceUrl = options.unreachable ? `file://${join(home, 'missing')}` : src.url;
  const entry = (name: string, hash: string) => ({ source: 'o/r', sourceUrl, skillPath: `s/${name}/SKILL.md`, skillFolderHash: hash });
  const lockFile = join(home, '.agents', '.skill-lock.json');
  const readLock = (): Record<string, Record<string, unknown>> => JSON.parse(readFileSync(lockFile, 'utf8')).skills;
  const writeLock = (skills: object) => writeFileSync(lockFile, JSON.stringify({ skills }));

  const lock: Record<string, object> = {};
  for (const [name, hash] of Object.entries(options.installed ?? { stale: 'old', fresh: CURRENT })) {
    mkdirSync(join(paths.agentsSkills, name), { recursive: true });
    writeFileSync(join(paths.agentsSkills, name, 'SKILL.md'), `# ${name}\n`);
    mkdirSync(join(paths.claude, 'skills', name), { recursive: true });
    lock[name] = entry(name, hash === CURRENT ? src.tree(name) : hash);
  }
  writeLock({ ...lock, ...options.lockOverride });

  const commands: Command[] = [];
  // Whether a backup of each removed skill existed at the moment the remover ran.
  const backedUpAtRemove: Record<string, boolean> = {};
  const backupOf = (name: string) =>
    existsSync(paths.backups) && readdirSync(paths.backups).some((run) => existsSync(join(paths.backups, run, 'skills', name, 'SKILL.md')));

  const processes = (behaviour: Behaviour) => {
    const real = Effect.runSync(Effect.gen(function* () { return yield* Processes; }).pipe(Effect.provide(nodeProcesses())));
    return Layer.succeed(Processes, {
      run: (command: Command) => {
        if (command.cmd === 'git') {
          if (behaviour.blockClone && command.args[0] === 'clone') {
            commands.push(command);
            return Effect.never;
          }
          return real.run(command);
        }
        commands.push(command);
        const [, , verb, ...rest] = command.args;
        if (verb === behaviour.block) return Effect.never;
        return Effect.sync((): Completed => {
          if (verb === behaviour.fail) return { code: 1, stdout: '' };
          const valuesOf = (flag: string) => {
            const at = rest.indexOf(flag);
            if (at < 0) return [];
            const end = rest.findIndex((a, i) => i > at && a.startsWith('--'));
            return rest.slice(at + 1, end < 0 ? undefined : end);
          };
          const positional = rest.slice(0, rest.findIndex((a) => a.startsWith('--')));
          const skills = readLock();
          if (verb === 'add') {
            const agents = valuesOf('--agent');
            for (const n of valuesOf('--skill')) {
              mkdirSync(join(paths.agentsSkills, n), { recursive: true });
              skills[n] = entry(n, src.tree(n));
              if (agents.includes('claude-code')) mkdirSync(join(paths.claude, 'skills', n), { recursive: true });
            }
          } else if (verb === 'update') {
            if (behaviour.updateTo !== null) {
              for (const n of positional) skills[n] = { ...skills[n], skillFolderHash: behaviour.updateTo ?? src.tree(n) };
            }
          } else if (verb === 'remove') {
            for (const n of positional) {
              backedUpAtRemove[n] = backupOf(n);
              rmSync(join(paths.agentsSkills, n), { recursive: true, force: true });
              rmSync(join(paths.claude, 'skills', n), { recursive: true, force: true });
              delete skills[n];
            }
          }
          writeLock(skills);
          return { code: 0, stdout: '' };
        });
      },
    });
  };

  const deps = (over: Partial<UpdateDeps> & { behaviour?: Behaviour } = {}): UpdateDeps => ({
    layer: Layer.mergeAll(machinePaths(paths), nodeFs, processes(over.behaviour ?? {})),
    select: async () => { throw new Error('the picker was not expected to open'); },
    isTTY: true,
    ...over,
  });

  const npx = () => commands.filter((c) => c.cmd === 'npx').map((c) => c.args.slice(2));
  const manifest = () => (existsSync(manifestFile) ? readFileSync(manifestFile, 'utf8') : null);
  return { home, paths, src, deps, npx, commands, manifest, backedUpAtRemove, backupOf, readLock };
}

// Runs one update with stdout and stderr captured. `watch` sees stdout as it grows. The test
// runner reports through stdout in binary frames while a run is in flight, so non-string
// chunks pass through.
async function go(args: string[], deps: UpdateDeps, watch?: (out: string[]) => void) {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  const into = (sink: string[], stream: NodeJS.WriteStream, original: typeof process.stdout.write) =>
    ((chunk: unknown, ...rest: unknown[]) => {
      if (typeof chunk !== 'string') return (original as (...a: unknown[]) => boolean).call(stream, chunk, ...rest);
      sink.push(chunk);
      return true;
    }) as typeof process.stdout.write;
  process.stdout.write = into(out, process.stdout, stdout);
  process.stderr.write = into(err, process.stderr, stderr);
  watch?.(out);
  let code: number;
  try {
    code = await runUpdate(args, deps);
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  return { code, out: out.join(''), err: err.join('') };
}

const WITH_WIZARD = ['stale', 'fresh', 'wizard'];

test('a usage error exits 2 before touching the machine', async () => {
  const m = machine();
  // Building this layer is the first touch of the machine; it must never happen on a usage error.
  const untouchable = Layer.mergeAll(
    Layer.effect(MachinePaths, Effect.die(new Error('the machine was touched'))), nodeFs, nodeProcesses(),
  );
  const result = await go(['--check', '--yes'], m.deps({ layer: untouchable }));
  assert.equal(result.code, 2);
  assert.equal((await go(['--target', 'bogus'], m.deps({ layer: untouchable }))).code, 2);
  assert.match(result.err, /--check is mutually exclusive/);
  const unknown = await go(['--dry-run'], m.deps());
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /--dry-run/);
  assert.match(unknown.err, /Usage: nortuscc update/);
});

// Outdated alone is a suggestion, not a --check failure — only `gone` and
// `unknown` are unresolved problems `exitCode` treats as exit 1.
test('--check reports outdated skills and updates nothing', async () => {
  const m = machine();
  const result = await go(['--check'], m.deps());
  assert.equal(result.code, 0, 'outdated alone does not fail --check');
  assert.match(result.out, /outdated\s+1\s+stale/);
  assert.match(result.out, /^Run: nortuscc update$/m);
  assert.deepEqual(m.npx(), [], '--check must never write');
  assert.equal(existsSync(m.paths.backups), false, '--check must never take a backup either');
});

test('--check never prompts', async () => {
  const m = machine({ upstream: WITH_WIZARD });
  const result = await go(['--check'], m.deps({ select: async () => { throw new Error('select must not be called under --check'); } }));
  assert.equal(result.code, 0);
});

test('an all-current machine exits 0 and updates nothing', async () => {
  const m = machine({ installed: { stale: CURRENT, fresh: CURRENT } });
  const result = await go([], m.deps());
  assert.equal(result.code, 0);
  assert.deepEqual(m.npx(), []);
});

test('a confirmed run backs up and updates only the outdated skills', async () => {
  const m = machine();
  const result = await go([], m.deps({ select: async () => ['skill:stale'] }));
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(m.npx(), [['update', 'stale', '--global', '--yes']], 'only the outdated skill may be updated');
  assert.equal(m.backupOf('stale'), true);
  assert.equal(m.backupOf('fresh'), false);
  assert.match(result.out, /\nupdating 1 skill\(s\)\n/);
  assert.match(result.out, new RegExp(`backed up -> ${m.paths.backups}/nortuscc-`));
});

test('--yes skips the prompt entirely', async () => {
  const m = machine();
  const result = await go(['--yes'], m.deps({ select: async () => { throw new Error('select must not be called under --yes'); } }));
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(m.npx(), [['update', 'stale', '--global', '--yes']]);
});

test('no TTY and no --yes refuses with exit 2 rather than hanging', async () => {
  const m = machine({ upstream: WITH_WIZARD });
  const result = await go([], m.deps({ select: realSelect, isTTY: false }));
  assert.equal(result.code, 2);
  assert.match(result.err, /no terminal to choose on/);
  assert.deepEqual(m.npx(), []);
});

test('an unreachable source exits 1 and updates nothing', async () => {
  const m = machine({ unreachable: true });
  const result = await go(['--yes'], m.deps());
  assert.equal(result.code, 1);
  assert.match(result.out, /unreachable\s+2\s+fresh, stale/);
  assert.deepEqual(m.npx(), [], 'the updater must never be invoked when a source is unreachable');
});

test('a failing updater exits 1', async () => {
  const m = machine();
  const result = await go(['--yes'], m.deps({ behaviour: { fail: 'update' } }));
  assert.equal(result.code, 1);
  assert.match(result.out, /\nskills:update: npx exited with 1\n/);
  assert.match(result.out, /Something failed above\. The backup is listed above\./);
});

test('a skill whose folder vanished upstream is never sent to the updater', async () => {
  const m = machine({ upstream: ['fresh'] });
  const result = await go(['--yes'], m.deps());
  assert.equal(result.code, 1);
  assert.match(result.out, /gone\s+1\s+stale/);
  assert.deepEqual(m.npx(), [], 'a gone skill has nowhere to update from');
});

test('the closing report names the hash the lock actually moved to', async () => {
  const m = machine();
  const result = await go([], m.deps({ select: async () => ['skill:stale'], behaviour: { updateTo: 'newhash1234' } }));
  assert.match(result.out, /stale\s+updated\s+old -> newhash/);
  assert.doesNotMatch(result.out, /unchanged/);
});

test('an unmoved lock (no writer touched it) still reports unchanged', async () => {
  const m = machine();
  const result = await go([], m.deps({ select: async () => ['skill:stale'], behaviour: { updateTo: null } }));
  assert.match(result.out, /skills\s+unchanged\s+the updater reported no change/);
  assert.doesNotMatch(result.out, /stale\s+updated/);
});

test('two sources: an unreachable one only marks its own skills unknown', async () => {
  const m = machine({
    lockOverride: {
      fresh: { source: 'o/other', sourceUrl: 'file:///nonexistent/other', skillPath: 's/fresh/SKILL.md', skillFolderHash: 'same' },
    },
  });
  const result = await go(['--check'], m.deps());
  assert.equal(result.code, 1);
  assert.match(result.out, /outdated\s+1\s+stale/);
  assert.match(result.out, /unreachable\s+1\s+fresh/);
});

test('gone with nothing outdated prints the prune pointer and --check exits 1', async () => {
  const m = machine({ upstream: ['fresh'], installed: { vanished: 'old', fresh: CURRENT } });
  const result = await go(['--check'], m.deps());
  assert.equal(result.code, 1);
  assert.match(result.out, /nortuscc update --prune/);
  // The gone footer's own advice starts with the same words, so match the whole line.
  assert.doesNotMatch(result.out, /^Run: nortuscc update$/m, 'nothing is outdated, so that suggestion must not appear');
});

test('the gone footer names the gone skills, not just a bare pronoun', async () => {
  const m = machine({ upstream: ['stale'], installed: { stale: 'old', vanished: 'old2' } });
  const result = await go(['--check'], m.deps());
  const footer = result.out.split('\n').filter((l) => /gone upstream|nortuscc update --prune/.test(l)).join('\n');
  assert.match(footer, /vanished/, 'the footer must name the gone skill');
  assert.doesNotMatch(footer, /\bstale\b/, 'the footer must not name an outdated skill');
});

test('a long skill name keeps the outdated detail rows aligned', async () => {
  const m = machine({ upstream: ['setup-matt-pocock-skills', 'tdd'], installed: { 'setup-matt-pocock-skills': 'old', tdd: 'old2' } });
  const result = await go(['--check'], m.deps());
  const detail = result.out.split('\n').filter((l) => /outdated/.test(l) && / -> /.test(l));
  assert.equal(detail.length, 2, 'both skills should have a detail row');
  assert.equal(detail[0]!.indexOf('outdated'), detail[1]!.indexOf('outdated'));
});

// Pinning a source in the manifest is what stops `update` offering the rest of it.
test('an exact source is never scanned, so nothing from it is offered', async () => {
  const m = machine({ upstream: WITH_WIZARD, manifest: '[o/r] exact\nfresh\nstale\n' });
  const result = await go(['--check'], m.deps());
  assert.match(result.out, /outdated\s+1\s+stale/);
  assert.doesNotMatch(result.out, /wizard/, 'nothing from a pinned source is offered');

  const open = machine({ upstream: WITH_WIZARD, manifest: '[o/r]\nfresh\nstale\n' });
  assert.match((await go(['--check'], open.deps())).out, /available\s+1\s+wizard/, 'an unpinned source is still scanned');
});

test('the picker drives what gets executed', async () => {
  const m = machine({ upstream: WITH_WIZARD });
  await go([], m.deps({ select: async () => ['skill:stale'] }));
  assert.deepEqual(m.npx(), [['update', 'stale', '--global', '--yes']]);
});

test('--add and --prune pre-tick their rows in the picker, not just under --yes', async () => {
  const m = machine({ upstream: ['fresh', 'wizard', 'gizmo'] });
  let rows: readonly { key: string; group: string; checked: boolean }[] = [];
  let title = '';
  await go(['--add', 'wizard', '--prune'], m.deps({
    select: async (offered: typeof rows, options: { title: string }) => { rows = offered; title = options.title; return []; },
  } as Partial<UpdateDeps>));
  const byKey = Object.fromEntries(rows.map((r) => [r.key, [r.group, r.checked]]));
  assert.deepEqual(byKey['skill:wizard'], ['add', true], '--add wizard must pre-tick its row');
  assert.deepEqual(byKey['skill:gizmo'], ['add', false], 'a skill not named by --add must not be pre-ticked');
  assert.deepEqual(byKey['skill:stale'], ['remove', true], '--prune must pre-tick the gone row');
  assert.equal(title, 'choose what to adopt, refresh and prune');
});

test('a cancelled picker changes nothing and exits 0', async () => {
  const m = machine({ upstream: WITH_WIZARD });
  const result = await go([], m.deps({ select: async () => null, isTTY: true }));
  assert.equal(result.code, 0);
  assert.match(result.out, /nothing selected/);
  assert.deepEqual(m.npx(), []);
});

test('--yes --add adopts exactly the named skills', async () => {
  const m = machine({ upstream: [...WITH_WIZARD, 'gizmo'] });
  const result = await go(['--yes', '--add', 'wizard'], m.deps());
  assert.equal(result.code, 0, result.err);
  const adds = m.npx().filter((a) => a[0] === 'add');
  assert.deepEqual(adds, [['add', 'o/r', '--skill', 'wizard', '--agent', 'claude-code', 'codex', '--global', '--yes']]);
  assert.match(result.out, /\ninstalling 1 skill\(s\) from o\/r\n/);
  assert.match(result.out, /wizard\s+added\s+o\/r/);
});

test('a scripted --add naming an unmatched skill reports it and exits non-zero', async () => {
  const m = machine({ upstream: WITH_WIZARD });
  const result = await go(['--yes', '--add', 'does-not-exist'], m.deps());
  assert.match(result.out, /--add named skill\(s\) not found upstream \(already installed, misspelled, or not offered by a known source\): does-not-exist/);
  assert.equal(result.code, 1, 'a named --add skill that matched nothing must not exit clean');
});

test('an unmatched --add name blames an unreachable source when one exists, not just a typo', async () => {
  const m = machine({ upstream: WITH_WIZARD, unreachable: true });
  const result = await go(['--yes', '--add', 'wizard'], m.deps());
  assert.equal(result.code, 1);
  assert.match(result.out, /wizard/);
  assert.match(result.out, /could not be reached \(o\/r\)/);
});

test('removals are backed up before anything is removed', async () => {
  const m = machine({ upstream: ['fresh'] });
  const result = await go(['--yes', '--prune'], m.deps());
  assert.deepEqual(m.npx().filter((a) => a[0] === 'remove'), [['remove', 'stale', '--global', '--yes']]);
  assert.deepEqual(m.backedUpAtRemove, { stale: true }, 'prune is the first thing that deletes a skill outright');
  assert.match(result.out, /\nremoving 1 skill\(s\)\n/);
  assert.match(result.out, /stale\s+removed/);
});

test('a pruned gone skill no longer forces exit 1', async () => {
  const m = machine({ upstream: ['fresh'] });
  assert.equal((await go(['--yes', '--prune'], m.deps())).code, 0, 'a gone skill that was dealt with is not still a problem');
});

test('the manifest is written after adopting', async () => {
  const m = machine({ upstream: WITH_WIZARD, manifest: '[o/r]\nfresh\nstale\n' });
  const result = await go(['--yes', '--add', 'wizard'], m.deps());
  assert.match(m.manifest()!, /^wizard$/m, 'the manifest must actually name the skill that was adopted');
  assert.match(result.out, /\nskills-manifest\.txt written — 3 skill\(s\)\nRun: nortuscc push -m "\.\.\."   to share it\n/);
});

test('the manifest is left alone when nothing was adopted or pruned', async () => {
  const m = machine({ upstream: WITH_WIZARD, manifest: '[o/r]\nfresh\nstale\n' });
  const result = await go(['--yes'], m.deps());
  assert.equal(m.manifest(), '[o/r]\nfresh\nstale\n', 'a plain refresh changes no manifest entry');
  assert.doesNotMatch(result.out, /skills-manifest\.txt/);
});

test('pruning an optional skill removes its declaration while preserving unselected optional skills', async () => {
  const m = machine({ upstream: ['fresh'], manifest: '[o/r] optional\nfresh\nstale\nunselected\n' });
  await go(['--yes', '--prune'], m.deps());
  const written = m.manifest()!;
  assert.doesNotMatch(written, /^stale$/m);
  assert.match(written, /^unselected$/m);
  assert.match(written, /^\[o\/r\] optional$/m);
});

// The shrink guard protects every other machine's manifest from one machine's incomplete skill set.
test('a shrink larger than what was pruned leaves a populated manifest alone', async () => {
  const before = '[o/r]\na\nb\nc\nd\ne\nf\n';
  const m = machine({ upstream: ['fresh'], manifest: before });
  const result = await go(['--yes', '--prune'], m.deps());
  assert.equal(m.manifest(), before, 'a shrink bigger than the prune must never be written');
  assert.match(result.out, /skills-manifest\.txt left alone/);
  assert.match(result.out, /would drop 6 entr\(ies\)/);
  assert.match(result.out, /\ba\b.*\bb\b.*\bc\b.*\bd\b.*\be\b.*\bf\b/);
  assert.doesNotMatch(result.out, /Run: nortuscc push/);
});

// A failed removal must never be reported as 'removed': the backup is now the skill's only copy.
test('a failing remover reports the skill as failed, not removed', async () => {
  const m = machine({ upstream: ['fresh'] });
  const result = await go(['--yes', '--prune'], m.deps({ behaviour: { fail: 'remove' } }));
  assert.equal(result.code, 1);
  assert.match(result.out, /stale\s+failed\s+remove failed — see output above/);
  assert.doesNotMatch(result.out, /stale\s+removed/);
});

test('a failing installer reports the skill as failed, not added', async () => {
  const m = machine({ upstream: WITH_WIZARD });
  const result = await go(['--yes', '--add', 'wizard'], m.deps({ behaviour: { fail: 'add' } }));
  assert.equal(result.code, 1);
  assert.match(result.out, /wizard\s+failed\s+o\/r — install failed, see output above/);
  assert.doesNotMatch(result.out, /wizard\s+added/);
});

test('cancelling mid-update stops before the manifest and exits non-zero', async () => {
  const manifest = '[o/r]\nfresh\nstale\n';
  const m = machine({ upstream: WITH_WIZARD, manifest });
  const controller = new AbortController();
  let poll: ReturnType<typeof setInterval> | undefined;
  const result = await go(['--yes', '--add', 'wizard'], m.deps({ behaviour: { block: 'add' }, signal: controller.signal }), (out) => {
    poll = setInterval(() => {
      if (m.npx().some((a) => a[0] === 'add')) {
        clearInterval(poll);
        controller.abort();
      }
    }, 5);
  });
  clearInterval(poll);
  assert.equal(result.code, 1);
  assert.match(result.out, /cancelled — not run: skills:expose, skills:manifest/);
  assert.equal(m.manifest(), manifest, 'the manifest must not be rewritten after a cancel');
  assert.ok(m.npx().some((a) => a[0] === 'add'), 'the installer had started');
});

test('--target claude adopts for Claude only', async () => {
  const m = machine({ upstream: WITH_WIZARD });
  const result = await go(['--target', 'claude', '--yes', '--add', 'wizard'], m.deps());
  assert.equal(result.code, 0, result.err);
  const add = m.npx().find((a) => a[0] === 'add')!;
  assert.deepEqual(add.slice(add.indexOf('--agent') + 1, add.indexOf('--global')), ['claude-code']);
});

test('an unreadable store exits 1 and says why', async () => {
  const m = machine();
  rmSync(m.paths.agentsSkills, { recursive: true, force: true });
  writeFileSync(m.paths.agentsSkills, 'not a directory');
  const result = await go(['--yes'], m.deps());
  assert.equal(result.code, 1);
  assert.match(result.err, /^skills: /m);
  assert.deepEqual(m.npx(), []);
  assert.equal((await go(['--check'], m.deps())).code, 1);
});

test('Ctrl-C while sources are being checked cancels before the picker and exits 1', async () => {
  const m = machine({ upstream: WITH_WIZARD });
  const controller = new AbortController();
  let picked = false;
  const timer = setTimeout(() => controller.abort(), 50);
  const result = await go([], m.deps({
    behaviour: { blockClone: true }, signal: controller.signal,
    select: async () => { picked = true; return []; },
  }));
  clearTimeout(timer);
  assert.equal(result.code, 1);
  assert.match(result.out, /\ncancelled\n/);
  assert.equal(picked, false, 'the picker must not open after a cancel');
  assert.deepEqual(m.npx(), []);
  assert.ok(m.commands.some((c) => c.cmd === 'git' && c.args[0] === 'clone'), 'the clone had started');
});
