import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer, Stream } from 'effect';
import type { DesiredConfig, ResolvedSkill } from '@nortuscc/profile-engine';
import {
  backupsForRun, bundledScripts, compareInstall, execute, machinePaths, nodeFs, nodeProcesses, pinnedTrees, plan, selectAll, skillsDomain,
  type MachineReport, type Observed, type Plan, type Progress, type TreeEntry,
} from '../src/index.ts';
import { fakeInstaller, readLock, skillSource } from './support/skills-source.ts';

const SHA = 'a'.repeat(40);

const machine = () => {
  const home = mkdtempSync(join(tmpdir(), 'machine-verify-'));
  const paths = {
    repo: join(home, 'repo'), claude: join(home, '.claude'), codex: join(home, '.codex'),
    codexOpenRouter: join(home, '.codex-openrouter'), agentsSkills: join(home, '.agents', 'skills'),
    stateRoot: join(home, 'state'), backups: join(home, 'state', 'backups'),
  };
  mkdirSync(paths.repo, { recursive: true });
  return { home, paths };
};

// ---- pure ----

test('bundledScripts flags executables, script extensions and scripts/ or bin/ folders', () => {
  const cases: [string, string, boolean][] = [
    ['SKILL.md', '100644', false],
    ['run.sh', '100644', true],
    ['scripts/x.txt', '100644', true],
    ['tool', '100755', true],
    ['docs/bin.md', '100644', false],
    ['lib/bin/x', '100644', true],
    ['Setup.PS1', '100644', true],
  ];
  for (const [path, mode, expected] of cases) {
    assert.deepEqual(bundledScripts([{ mode, path }]), expected ? [path] : [], path);
  }
  assert.deepEqual(bundledScripts([{ mode: '100644', path: 'z.py' }, { mode: '100644', path: 'a.js' }]), ['a.js', 'z.py']);
});

const blob = (path: string, sha: string, mode = '100644'): TreeEntry => ({ mode, path, sha });

test('compareInstall finds differing, missing and extra files', () => {
  const pinned = [blob('SKILL.md', 's1'), blob('a.md', 'a1')];
  assert.deepEqual(compareInstall(pinned, new Map([['SKILL.md', 's1'], ['a.md', 'a1']]), SHA), []);
  assert.deepEqual(compareInstall(pinned, new Map([['SKILL.md', 's1'], ['a.md', 'a2']]), SHA), ['a.md differs']);
  assert.deepEqual(compareInstall(pinned, new Map([['SKILL.md', 's1']]), SHA), ['a.md missing']);
  assert.deepEqual(compareInstall(pinned, new Map([['SKILL.md', 's1'], ['a.md', 'a1'], ['b.md', 'b1']]), SHA), ['b.md not in aaaaaaa']);
  assert.deepEqual(compareInstall(pinned, new Map([['b.md', 'b1'], ['SKILL.md', 'x']]), SHA),
    ['SKILL.md differs', 'a.md missing', 'b.md not in aaaaaaa']);
});

test('compareInstall skips what the installer does not copy and accepts dereferenced links', () => {
  const pinned = [
    blob('SKILL.md', 's1'), blob('metadata.json', 'm'), blob('__pycache__/x.pyc', 'p'), blob('sub/.git/config', 'g'),
    blob('mod', 'c', '160000'), blob('link', 'l', '120000'), blob('file-link', 'l2', '120000'),
  ];
  const installed = new Map([['SKILL.md', 's1'], ['link/inner.md', 'i'], ['file-link', 'whatever']]);
  assert.deepEqual(compareInstall(pinned, installed, SHA), []);
  assert.deepEqual(compareInstall(pinned, new Map([['SKILL.md', 's1'], ['file-link', 'w']]), SHA), ['link missing']);
});

// ---- pinnedTrees: real git ----

test('pinnedTrees lists a folder at a fetched commit, and is null for a commit the source lacks', async () => {
  const m = machine();
  const src = skillSource(m.home);
  const first = src.commit({ 'skills/tdd/SKILL.md': 'one', 'skills/tdd/scripts/run.sh': { text: 'x', mode: 0o755 }, 'other/x': 'x' });
  src.commit({ 'skills/tdd/SKILL.md': 'two' });
  const layer = Layer.mergeAll(machinePaths(m.paths), nodeFs, nodeProcesses());
  const run = <A>(e: Effect.Effect<A, never, any>) => Effect.runPromise(e.pipe(Effect.provide(layer)) as Effect.Effect<A>);
  const trees = (await run(pinnedTrees(src.url, first, ['skills/tdd', '.'])))!;
  assert.deepEqual(trees.get('skills/tdd')!.map((e) => [e.mode, e.path]), [['100644', 'SKILL.md'], ['100755', 'scripts/run.sh']]);
  assert.deepEqual(trees.get('.')!.map((e) => e.path), ['other/x', 'skills/tdd/SKILL.md', 'skills/tdd/scripts/run.sh']);
  assert.equal(await run(pinnedTrees(src.url, SHA, ['skills/tdd'])), null);
  assert.deepEqual(readdirSync(join(m.paths.stateRoot, 'tmp')), []);
});

// ---- end to end through execute ----

const skill = (name: string, sha: string): ResolvedSkill => ({
  name, source: 'o/r', exact: false, optional: false, install: true, from: { layer: 'base', source: 'test' },
  pin: { ref: sha, from: { layer: 'pin', source: 'skill-pins.json' } },
} as ResolvedSkill);
const desiredWith = (skills: ResolvedSkill[]): DesiredConfig => ({ files: [], skills, integrations: [], allow: {}, issues: [] });
const item = (name: string, state: string): Observed =>
  ({ key: `skill:${name}`, domain: 'skills', label: name, group: 'o/r', state, disposition: 'apply' });

const runPinned = async (m: ReturnType<typeof machine>, src: ReturnType<typeof skillSource>, sha: string, state = 'missing') => {
  const installer = fakeInstaller(m.paths, src);
  const layer = backupsForRun().pipe(Layer.provideMerge(Layer.mergeAll(machinePaths(m.paths), nodeFs, installer.layer)));
  const r: MachineReport = { desired: desiredWith([skill('tdd', sha)]), items: [item('tdd', state)], probeErrors: [] };
  const p: Plan = plan('apply', r, selectAll, [skillsDomain]);
  const events: Progress[] = [...await Effect.runPromise(Stream.runCollect(execute(p, r, [skillsDomain])).pipe(Effect.provide(layer)))];
  const step = events.find((e) => e.type === 'finished') as Extract<Progress, { type: 'finished' }>;
  const done = events.at(-1) as Extract<Progress, { type: 'done' }>;
  return { step, done, installer };
};

test('a pinned install that matches its commit is verified', async () => {
  const m = machine();
  const src = skillSource(m.home);
  const sha = src.commit({ 'skills/tdd/SKILL.md': '# tdd\n' });
  const { step, done } = await runPinned(m, src, sha);
  assert.deepEqual([done.ok, done.failed], [1, 0]);
  assert.equal(step.note, `verified 1 skill(s) at ${sha.slice(0, 7)}`);
});

test('a verified install names the scripts it bundles', async () => {
  const m = machine();
  const src = skillSource(m.home);
  const sha = src.commit({ 'skills/tdd/SKILL.md': '# tdd\n', 'skills/tdd/run.sh': { text: 'echo hi\n', mode: 0o755 } });
  const { step } = await runPinned(m, src, sha);
  assert.equal(step.note, `verified 1 skill(s) at ${sha.slice(0, 7)}; bundles scripts, review: tdd (run.sh)`);
});

test('an install of a branch named like the pin is removed, and the previous version stays backed up', async () => {
  const m = machine();
  const src = skillSource(m.home);
  const sha = src.commit({ 'skills/tdd/SKILL.md': '# pinned\n' });
  const trap = src.commit({ 'skills/tdd/SKILL.md': '# hijacked\n', 'skills/tdd/evil.sh': 'x' });
  src.branch(sha, trap);
  mkdirSync(join(m.paths.agentsSkills, 'tdd'), { recursive: true });
  writeFileSync(join(m.paths.agentsSkills, 'tdd', 'SKILL.md'), '# previous\n');
  const { step, done, installer } = await runPinned(m, src, sha, 'off-pin');
  assert.deepEqual([done.ok, done.failed], [0, 1]);
  assert.match(step.note, new RegExp(`^removed tdd: does not match ${sha.slice(0, 7)} \\(`));
  assert.equal(existsSync(join(m.paths.agentsSkills, 'tdd')), false);
  assert.equal(readLock(m.paths).tdd, undefined);
  assert.equal(readFileSync(join(done.backups!, 'skills', 'tdd', 'SKILL.md'), 'utf8'), '# previous\n');
  assert.deepEqual(installer.commands.map((c) => c.args[2]), ['add', 'remove']);
});

test('a verified re-expose still names the scripts it bundles', async () => {
  const m = machine();
  const src = skillSource(m.home);
  const sha = src.commit({ 'skills/tdd/SKILL.md': '# tdd\n', 'skills/tdd/bin/x': 'x' });
  mkdirSync(join(m.paths.agentsSkills, 'tdd'), { recursive: true });
  mkdirSync(join(m.paths.agentsSkills, '..'), { recursive: true });
  writeFileSync(join(m.paths.agentsSkills, '..', '.skill-lock.json'), JSON.stringify({ skills: { tdd: { source: 'o/r', ref: sha } } }));
  const installer = fakeInstaller(m.paths, src);
  const layer = backupsForRun().pipe(Layer.provideMerge(Layer.mergeAll(machinePaths(m.paths), nodeFs, installer.layer)));
  const r: MachineReport = { desired: desiredWith([skill('tdd', sha)]), items: [{ ...item('stale', 'outdated'), group: 'x/y' }], probeErrors: [] };
  const p = plan('update', r, { ...selectAll, targets: ['claude'] }, [skillsDomain]);
  const expose: Plan = { kind: 'update', steps: p.steps.filter((s) => s.key === 'skills:expose').map((s) => ({ ...s, touches: [] })), skipped: [] };
  const events: Progress[] = [...await Effect.runPromise(Stream.runCollect(execute(expose, r, [skillsDomain])).pipe(Effect.provide(layer)))];
  const step = events.find((e) => e.type === 'finished') as Extract<Progress, { type: 'finished' }>;
  assert.equal(step.outcome, 'ok');
  assert.equal(step.note, 're-exposed 1 skill(s) to claude-code; o/r: bundles scripts, review: tdd (bin/x)');
});
