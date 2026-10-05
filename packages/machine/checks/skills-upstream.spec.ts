import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import type { DesiredConfig } from '@nortuscc/profile-engine';
import {
  availableSkills, inspectSource, inspectUpdates, machinePaths, nodeFs, nodeProcesses, planUpdates, skillFolder,
  sourcesOf, updatableSkills, upstreamSkills,
} from '../src/index.ts';

const skillsMachine = () => {
  const home = mkdtempSync(join(tmpdir(), 'machine-upstream-'));
  const paths = {
    repo: join(home, 'repo'), claude: join(home, '.claude'), codex: join(home, '.codex'),
    codexOpenRouter: join(home, '.codex-openrouter'), agentsSkills: join(home, '.agents', 'skills'),
    stateRoot: join(home, 'state'), backups: join(home, 'state', 'backups'),
  };
  const layer = Layer.mergeAll(machinePaths(paths), nodeFs);
  return { home, paths, layer };
};

const lockOf = (skills: Record<string, unknown>) => ({ skills });

const ENTRY = {
  source: 'mattpocock/skills',
  sourceType: 'github',
  sourceUrl: 'https://github.com/mattpocock/skills.git',
  skillPath: 'skills/engineering/tdd/SKILL.md',
  skillFolderHash: 'aaa',
};

test('skillFolder strips the SKILL.md filename', () => {
  assert.equal(skillFolder('skills/engineering/tdd/SKILL.md'), 'skills/engineering/tdd');
});

test('skillFolder maps a root SKILL.md to the root tree', () => {
  assert.equal(skillFolder('SKILL.md'), '.');
});

test('updatableSkills keeps only skills that are installed', () => {
  const entries = updatableSkills(lockOf({ tdd: ENTRY, absent: ENTRY }), ['tdd']);
  assert.deepEqual(entries.map((e) => e.name), ['tdd']);
  assert.equal(entries[0]!.path, 'skills/engineering/tdd');
  assert.equal(entries[0]!.hash, 'aaa');
});

test('updatableSkills skips entries with no recorded source', () => {
  const lock = lockOf({ mine: { skillPath: 'SKILL.md' } });
  assert.deepEqual(updatableSkills(lock, ['mine']), []);
});

test('updatableSkills survives a malformed lock without throwing', () => {
  assert.deepEqual(updatableSkills(null as never, ['x']), []);
  assert.deepEqual(updatableSkills({ skills: 'nope' } as never, ['x']), []);
  assert.deepEqual(updatableSkills(lockOf({ x: 5 }), ['x']), []);
});

test('sourcesOf dedupes by sourceUrl and collects every path', () => {
  const entries = [
    { name: 'a', source: 's/one', sourceUrl: 'u1', path: 'p/a', hash: 'x' },
    { name: 'b', source: 's/one', sourceUrl: 'u1', path: 'p/b', hash: 'y' },
    { name: 'c', source: 's/two', sourceUrl: 'u2', path: 'p/c', hash: 'z' },
  ];
  assert.deepEqual(sourcesOf(entries, new Set()), [
    { source: 's/one', sourceUrl: 'u1', paths: ['p/a', 'p/b'], exact: false },
    { source: 's/two', sourceUrl: 'u2', paths: ['p/c'], exact: false },
  ]);
});

// The manifest pins by source name, which is what it writes; sourcesOf groups
// by url, which is what gets cloned. This is where the two meet.
test('sourcesOf marks the sources the manifest pinned', () => {
  const entries = [
    { name: 'unslop', source: 'cursor/plugins', sourceUrl: 'u1', path: 'pstack/skills/unslop', hash: 'x' },
    { name: 'tdd', source: 'm/s', sourceUrl: 'u2', path: 'p/tdd', hash: 'y' },
  ];
  const grouped = sourcesOf(entries, new Set(['cursor/plugins']));
  assert.equal(grouped.find((g) => g.source === 'cursor/plugins')!.exact, true);
  assert.equal(grouped.find((g) => g.source === 'm/s')!.exact, false);
});

test('planUpdates calls a matching tree SHA current', () => {
  const remote = new Map([['u', new Map([['p/tdd', 'aaa']])]]);
  const lock = lockOf({ tdd: { ...ENTRY, sourceUrl: 'u', skillPath: 'p/tdd/SKILL.md' } });
  const plan = planUpdates({ lock, installed: ['tdd'], remoteTrees: remote });
  assert.deepEqual(plan.current, ['tdd']);
  assert.deepEqual(plan.outdated, []);
});

test('planUpdates reports a differing tree SHA as outdated, with both SHAs', () => {
  const remote = new Map([['u', new Map([['p/tdd', 'bbb']])]]);
  const lock = lockOf({ tdd: { ...ENTRY, sourceUrl: 'u', skillPath: 'p/tdd/SKILL.md' } });
  const plan = planUpdates({ lock, installed: ['tdd'], remoteTrees: remote });
  assert.deepEqual(plan.outdated, [
    { name: 'tdd', source: 'mattpocock/skills', from: 'aaa', to: 'bbb' },
  ]);
});

test('planUpdates treats a path missing upstream as gone, never as outdated', () => {
  const remote = new Map([['u', new Map([['p/tdd', null]])]]);
  const lock = lockOf({ tdd: { ...ENTRY, sourceUrl: 'u', skillPath: 'p/tdd/SKILL.md' } });
  const plan = planUpdates({ lock, installed: ['tdd'], remoteTrees: remote });
  assert.deepEqual(plan.gone, [{ name: 'tdd', source: 'mattpocock/skills', path: 'p/tdd' }]);
  assert.deepEqual(plan.outdated, []);
});

test('planUpdates marks every skill of an unreachable source unknown', () => {
  const lock = lockOf({
    tdd: { ...ENTRY, sourceUrl: 'u', skillPath: 'p/tdd/SKILL.md' },
    review: { ...ENTRY, sourceUrl: 'u', skillPath: 'p/review/SKILL.md' },
  });
  const plan = planUpdates({ lock, installed: ['tdd', 'review'], remoteTrees: new Map() });
  assert.deepEqual(plan.unknown.map((u) => u.name), ['review', 'tdd']);
  assert.deepEqual(plan.current, []);
});

test('planUpdates isolates an unreachable source from a reachable one', () => {
  const remote = new Map([['ok', new Map([['p/a', 'same']])]]);
  const lock = lockOf({
    a: { ...ENTRY, sourceUrl: 'ok', skillPath: 'p/a/SKILL.md', skillFolderHash: 'same' },
    b: { ...ENTRY, sourceUrl: 'down', skillPath: 'p/b/SKILL.md' },
  });
  const plan = planUpdates({ lock, installed: ['a', 'b'], remoteTrees: remote });
  assert.deepEqual(plan.current, ['a']);
  assert.deepEqual(plan.unknown.map((u) => u.name), ['b']);
});

test('planUpdates lists an installed skill with no source as local', () => {
  const lock = lockOf({ mine: { skillPath: 'SKILL.md' } });
  const plan = planUpdates({ lock, installed: ['mine'], remoteTrees: new Map() });
  assert.deepEqual(plan.local, ['mine']);
  assert.deepEqual(plan.unknown, []);
});

test('planUpdates treats a sourced entry with no recorded hash as outdated from null', () => {
  const remote = new Map([['u', new Map([['p/tdd', 'bbb']])]]);
  const lock = lockOf({
    tdd: { source: 's/one', sourceUrl: 'u', skillPath: 'p/tdd/SKILL.md' },
  });
  const plan = planUpdates({ lock, installed: ['tdd'], remoteTrees: remote });
  assert.deepEqual(plan.outdated, [{ name: 'tdd', source: 's/one', from: null, to: 'bbb' }]);
});

test('planUpdates ignores lock entries for skills that are not installed', () => {
  const remote = new Map([['u', new Map([['p/tdd', 'bbb']])]]);
  const lock = lockOf({ tdd: { ...ENTRY, sourceUrl: 'u', skillPath: 'p/tdd/SKILL.md' } });
  const plan = planUpdates({ lock, installed: [], remoteTrees: remote });
  assert.deepEqual(plan, { current: [], outdated: [], gone: [], unknown: [], local: [] });
});

test('upstreamSkills names a skill after its folder', () => {
  assert.deepEqual(upstreamSkills(['skills/engineering/tdd/SKILL.md']), [
    { path: 'skills/engineering/tdd', name: 'tdd' },
  ]);
});

test('upstreamSkills sorts by name', () => {
  const names = upstreamSkills(['s/zebra/SKILL.md', 's/apple/SKILL.md']).map((s) => s.name);
  assert.deepEqual(names, ['apple', 'zebra']);
});

test('upstreamSkills drops a SKILL.md nested inside another skill', () => {
  // A SKILL.md under an existing skill's folder is a sub-resource, not a
  // second skill — counting it would invent one that could never install.
  const found = upstreamSkills(['s/tdd/SKILL.md', 's/tdd/references/deep/SKILL.md']);
  assert.deepEqual(found.map((s) => s.name), ['tdd']);
});

test('upstreamSkills drops a nested SKILL.md regardless of which order the paths arrive in', () => {
  // Without the shallowest-first sort, the parent's SKILL.md is not yet in
  // `kept` by the time the nested one is checked, so it fails the
  // `startsWith` test and survives as a phantom skill named "deep".
  const found = upstreamSkills(['s/tdd/references/deep/SKILL.md', 's/tdd/SKILL.md']);
  assert.deepEqual(found.map((s) => s.name), ['tdd']);
});

test('upstreamSkills keeps siblings that merely share a prefix', () => {
  const found = upstreamSkills(['s/tdd/SKILL.md', 's/tdd-extra/SKILL.md']);
  assert.deepEqual(found.map((s) => s.name), ['tdd', 'tdd-extra']);
});

test('upstreamSkills skips a repo-root SKILL.md', () => {
  // Its installed name comes from the repo, which this listing cannot derive.
  assert.deepEqual(upstreamSkills(['SKILL.md', 's/tdd/SKILL.md']).map((s) => s.name), ['tdd']);
});

test('upstreamSkills on nothing is empty', () => {
  assert.deepEqual(upstreamSkills([]), []);
});

test('availableSkills excludes what is already installed', () => {
  const bySource = new Map([['o/r', [{ path: 's/tdd', name: 'tdd' }, { path: 's/new', name: 'new' }]]]);
  assert.deepEqual(availableSkills({ upstreamBySource: bySource, installed: ['tdd'] }), [
    { name: 'new', source: 'o/r' },
  ]);
});

test('availableSkills is empty when a source offers nothing new', () => {
  const bySource = new Map([['o/r', [{ path: 's/tdd', name: 'tdd' }]]]);
  assert.deepEqual(availableSkills({ upstreamBySource: bySource, installed: ['tdd'] }), []);
});

test('availableSkills reports each source separately', () => {
  const bySource = new Map([
    ['o/one', [{ path: 's/a', name: 'a' }]],
    ['o/two', [{ path: 's/b', name: 'b' }]],
  ]);
  assert.deepEqual(availableSkills({ upstreamBySource: bySource, installed: [] }), [
    { name: 'a', source: 'o/one' },
    { name: 'b', source: 'o/two' },
  ]);
});

test('availableSkills lists a name offered by two sources only once', () => {
  const bySource = new Map([
    ['o/one', [{ path: 's/dup', name: 'dup' }]],
    ['o/two', [{ path: 's/dup', name: 'dup' }]],
  ]);
  const found = availableSkills({ upstreamBySource: bySource, installed: [] });
  assert.equal(found.length, 1, 'installing the same name twice is not a thing that can happen');
  assert.equal(found[0]!.source, 'o/one', 'the first source in iteration order wins');
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();

function sourceRepo(home: string) {
  const dir = join(home, 'upstream');
  mkdirSync(dir);
  git(dir, 'init', '-q');
  for (const p of ['s/a', 's/b', 's/b/nested']) {
    mkdirSync(join(dir, p), { recursive: true });
    writeFileSync(join(dir, p, 'SKILL.md'), p);
  }
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'i');
  return { url: `file://${dir}`, tree: (p: string) => git(dir, 'rev-parse', `HEAD:${p}`) };
}

test('inspectSource reads folder trees and every SKILL.md, and cleans up its clone', async () => {
  const m = skillsMachine();
  const src = sourceRepo(m.home);
  const layer = Layer.mergeAll(m.layer, nodeProcesses());
  const found = await Effect.runPromise(inspectSource(src.url, ['s/a', 's/missing', '.'], true).pipe(Effect.provide(layer)));
  assert.equal(found!.trees.get('s/a'), src.tree('s/a'));
  assert.equal(found!.trees.get('s/missing'), null);
  assert.equal(found!.trees.get('.'), src.tree(''));
  assert.deepEqual(found!.skillPaths.sort(), ['s/a/SKILL.md', 's/b/SKILL.md', 's/b/nested/SKILL.md']);
  assert.deepEqual(readdirSync(join(m.paths.stateRoot, 'tmp')), []);
});

test('an exact source is not listed, and an unreachable one is null', async () => {
  const m = skillsMachine();
  const src = sourceRepo(m.home);
  const layer = Layer.mergeAll(m.layer, nodeProcesses());
  const pinned = await Effect.runPromise(inspectSource(src.url, ['s/a'], false).pipe(Effect.provide(layer)));
  assert.deepEqual(pinned!.skillPaths, []);
  assert.equal(await Effect.runPromise(inspectSource(`file://${join(m.home, 'nope')}`, ['s/a'], true).pipe(Effect.provide(layer))), null);
});

test('inspectUpdates turns the plan into skill items', async () => {
  const m = skillsMachine();
  const src = sourceRepo(m.home);
  const layer = Layer.mergeAll(m.layer, nodeProcesses());
  mkdirSync(join(m.paths.agentsSkills, 'a'), { recursive: true });
  mkdirSync(join(m.paths.agentsSkills, 'stale'), { recursive: true });
  writeFileSync(join(m.paths.agentsSkills, '..', '.skill-lock.json'), JSON.stringify({
    skills: {
      a: { source: 'o/r', sourceUrl: src.url, skillPath: 's/a/SKILL.md', skillFolderHash: src.tree('s/a') },
      stale: { source: 'o/r', sourceUrl: src.url, skillPath: 's/b/SKILL.md', skillFolderHash: 'old0000' },
    },
  }));
  const from = { layer: 'base', source: 'profile.json' } as never;
  const desired: DesiredConfig = {
    files: [], integrations: [], allow: {}, issues: [],
    skills: [{ name: 'a', source: 'o/r', exact: false, optional: false, install: true, from }],
  } as never;
  const { items, probeErrors } = await Effect.runPromise(inspectUpdates(desired).pipe(Effect.provide(layer)));
  assert.deepEqual(probeErrors, []);
  assert.deepEqual(items, [
    { key: 'skill:a', domain: 'skills', label: 'a', group: 'o/r', state: 'current', disposition: 'in-sync', from },
    { key: 'skill:stale', domain: 'skills', label: 'stale', group: 'o/r', state: 'outdated', disposition: 'apply',
      note: `old0000 -> ${src.tree('s/b').slice(0, 7)}` },
    { key: 'skill:b', domain: 'skills', label: 'b', group: 'o/r', state: 'available', disposition: 'excluded', note: 'available' },
  ]);
});
