import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer, Stream } from 'effect';
import type { DesiredConfig, ResolvedSkill } from '@nortuscc/profile-engine';
import {
  backupsForRun, checkUpdates, execute, inspectSkills, lockRef, machinePaths, nodeFs, pinnedSource, pinsBySource, plan, planUpdates, Processes,
  samePlan, selectAll, skillsDomain, splitPinned, updateItems,
  type Command, type MachinePathsValue, type MachineReport, type Observed, type Plan, type Progress,
} from '../src/index.ts';

const SHA = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);

const skillsMachine = () => {
  const home = mkdtempSync(join(tmpdir(), 'machine-pins-'));
  const paths = {
    repo: join(home, 'repo'), claude: join(home, '.claude'), codex: join(home, '.codex'),
    codexOpenRouter: join(home, '.codex-openrouter'), agentsSkills: join(home, '.agents', 'skills'),
    stateRoot: join(home, 'state'), backups: join(home, 'state', 'backups'),
  };
  const layer = Layer.mergeAll(machinePaths(paths), nodeFs);
  const run = <A, E>(effect: Effect.Effect<A, E, any>) => Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E>);
  return { home, paths, layer, run };
};

const pin = (ref: string) => ({ pin: { ref, from: { layer: 'pin', source: 'skill-pins.json' } } }) as Partial<ResolvedSkill>;
const skill = (name: string, source: string, over: Partial<ResolvedSkill> = {}): ResolvedSkill => ({
  name, source, exact: false, optional: false, install: true, from: { layer: 'base', source: 'test' }, ...over,
});
const desiredWith = (skills: ResolvedSkill[]): DesiredConfig => ({ files: [], skills, integrations: [], allow: {}, issues: [] });
const writeLock = (paths: { agentsSkills: string }, skills: unknown) => {
  mkdirSync(join(paths.agentsSkills, '..'), { recursive: true });
  writeFileSync(join(paths.agentsSkills, '..', '.skill-lock.json'), JSON.stringify({ skills }));
};

// ---- pure helpers ----

test('pinnedSource and splitPinned round-trip a pinned source', () => {
  assert.equal(pinnedSource('o/r', SHA), `o/r#${SHA}`);
  assert.equal(pinnedSource('o/r', undefined), 'o/r');
  assert.deepEqual(splitPinned(pinnedSource('o/r', SHA)), { source: 'o/r', sha: SHA });
  assert.deepEqual(splitPinned('o/r'), { source: 'o/r' });
  assert.deepEqual(splitPinned('o/r#main'), { source: 'o/r#main' });
  assert.deepEqual(splitPinned(`https://h/x.git#${SHA}`), { source: 'https://h/x.git', sha: SHA });
  assert.deepEqual(splitPinned(`a#b#${SHA}`), { source: 'a#b', sha: SHA });
});

test('lockRef reads a recorded ref and nothing else', () => {
  assert.equal(lockRef({ source: 'o/r', ref: SHA }), SHA);
  assert.equal(lockRef({ source: 'o/r' }), null);
  assert.equal(lockRef({ ref: '' }), null);
  assert.equal(lockRef({ ref: 5 }), null);
  assert.equal(lockRef(undefined), null);
});

test('pinsBySource maps each pinned source to its sha', () => {
  const pins = pinsBySource(desiredWith([skill('a', 'o/r', pin(SHA)), skill('b', 'o/r', pin(SHA)), skill('c', 'z/z')]));
  assert.deepEqual([...pins], [['o/r', SHA]]);
});

// ---- inspect ----

const inspectOne = async (declared: ResolvedSkill, lockEntry: unknown) => {
  const m = skillsMachine();
  mkdirSync(join(m.paths.agentsSkills, declared.name), { recursive: true });
  mkdirSync(join(m.paths.claude, 'skills', declared.name), { recursive: true });
  writeLock(m.paths, { [declared.name]: lockEntry });
  const report = await m.run(inspectSkills(desiredWith([declared])));
  return report.items.map((i) => [i.key, i.state, i.disposition, i.note]);
};

test('a pinned skill installed at its pin is ok', async () => {
  assert.deepEqual(await inspectOne(skill('a', 'o/r', pin(SHA)), { source: 'o/r', ref: SHA }),
    [['skill:a', 'ok', 'in-sync', undefined]]);
});

test('a pinned skill installed at another ref is off-pin', async () => {
  assert.deepEqual(await inspectOne(skill('a', 'o/r', pin(SHA)), { source: 'o/r', ref: NEXT }),
    [['skill:a', 'off-pin', 'apply', 'installed at bbbbbbb, pinned to aaaaaaa']]);
});

test('a pinned skill installed with no ref is off-pin', async () => {
  assert.deepEqual(await inspectOne(skill('a', 'o/r', pin(SHA)), { source: 'o/r' }),
    [['skill:a', 'off-pin', 'apply', 'installed at no pin, pinned to aaaaaaa']]);
});

test('an unpinned skill ignores the ref its lock records', async () => {
  assert.deepEqual(await inspectOne(skill('a', 'o/r'), { source: 'o/r', ref: SHA }),
    [['skill:a', 'ok', 'in-sync', undefined]]);
});

// ---- plan ----

const item = (name: string, state: string, disposition: Observed['disposition'], group = 'o/r', extra: Partial<Observed> = {}): Observed =>
  ({ key: `skill:${name}`, domain: 'skills', label: name, group, state, disposition, ...extra });
const report = (items: Observed[], skills: ResolvedSkill[] = []): MachineReport =>
  ({ desired: desiredWith(skills), items, probeErrors: [] });

test('apply installs missing and off-pin skills at their pin, one step per pinned source', () => {
  const items = [item('b', 'off-pin', 'apply'), item('a', 'missing', 'apply'), item('z', 'missing', 'apply', 'z/z')];
  const r = report(items, [skill('a', 'o/r', pin(SHA)), skill('b', 'o/r', pin(SHA)), skill('z', 'z/z')]);
  const p = plan('apply', r, selectAll, [skillsDomain]);
  assert.deepEqual(p.steps.map((s) => [s.key, s.touches]), [
    [`skills:install:o/r#${SHA}`, ['skills/a', 'skills/b']],
    ['skills:install:z/z', ['skills/z']],
  ]);
  const moved = report(items, [skill('a', 'o/r', pin(NEXT)), skill('b', 'o/r', pin(NEXT)), skill('z', 'z/z')]);
  assert.equal(samePlan(p, plan('apply', moved, selectAll, [skillsDomain])), false);
});

test('update reinstalls an off-pin skill with add at its pin, never with update', () => {
  const r = report([item('a', 'off-pin', 'apply')], [skill('a', 'o/r', pin(SHA))]);
  const p = plan('update', r, selectAll, [skillsDomain]);
  assert.deepEqual(p.steps.map((s) => [s.key, s.touches]), [
    [`skills:install:o/r#${SHA}`, ['skills/a']],
    ['skills:expose', []],
  ]);
});

test('apply re-exposes a pinned unlinked skill at its pin', () => {
  const r = report([{ ...item('a', 'unlinked', 'apply'), key: 'skill-link:claude:a', target: 'claude' }], [skill('a', 'o/r', pin(SHA))]);
  assert.deepEqual(plan('apply', r, selectAll, [skillsDomain]).steps.map((s) => s.key), [`skills:install:o/r#${SHA}`]);
});

// ---- update inspection ----

test('checkUpdates never clones a pinned source', async () => {
  const m = skillsMachine();
  for (const n of ['p', 'u']) mkdirSync(join(m.paths.agentsSkills, n), { recursive: true });
  writeLock(m.paths, {
    p: { source: 'p/p', sourceUrl: 'url-pinned', skillPath: 's/p/SKILL.md', ref: SHA },
    u: { source: 'u/u', sourceUrl: 'url-free', skillPath: 's/u/SKILL.md' },
  });
  const commands: Command[] = [];
  const processes = Layer.succeed(Processes, { run: (c: Command) => Effect.sync(() => (commands.push(c), { code: 1, stdout: '' })) });
  const desired = desiredWith([skill('p', 'p/p', pin(SHA)), skill('u', 'u/u')]);
  const result = await Effect.runPromise(checkUpdates(desired).pipe(Effect.provide(Layer.mergeAll(m.layer, processes))));
  const clones = commands.filter((c) => c.cmd === 'git' && c.args[0] === 'clone');
  assert.ok(clones.some((c) => c.args.includes('url-free')));
  assert.ok(!clones.some((c) => c.args.includes('url-pinned')));
  assert.deepEqual(result.current, [{ name: 'p', source: 'p/p' }]);
  assert.deepEqual(result.unknown, [{ name: 'u', source: 'u/u' }]);
});

test('planUpdates classifies pinned skills by their lock ref without a remote tree', () => {
  const entry = { source: 'o/r', sourceUrl: 'u', skillPath: 's/a/SKILL.md', skillFolderHash: 'h' };
  const lock = { skills: { a: { ...entry, ref: SHA }, b: { ...entry, skillPath: 's/b/SKILL.md', ref: NEXT }, c: entry } };
  const result = planUpdates({ lock, installed: ['a', 'b', 'c'], remoteTrees: new Map(), pins: new Map([['o/r', SHA]]) });
  assert.deepEqual(result.current, [{ name: 'a', source: 'o/r' }]);
  assert.deepEqual(result.unknown, []);
  assert.deepEqual(result.offPin, [
    { name: 'b', source: 'o/r', from: NEXT, to: SHA },
    { name: 'c', source: 'o/r', from: null, to: SHA },
  ]);
  const items = updateItems({ ...result, available: [] }, desiredWith([]));
  assert.deepEqual(items.filter((i) => i.state === 'off-pin').map((i) => [i.key, i.group, i.disposition, i.note]), [
    ['skill:b', 'o/r', 'apply', 'installed at bbbbbbb, pinned to aaaaaaa'],
    ['skill:c', 'o/r', 'apply', 'installed at no pin, pinned to aaaaaaa'],
  ]);
});

// ---- run: through execute, real files, a fake installer ----

const lockFile = (paths: MachinePathsValue) => join(paths.agentsSkills, '..', '.skill-lock.json');
const readLock = (paths: MachinePathsValue): Record<string, Record<string, unknown>> =>
  existsSync(lockFile(paths)) ? JSON.parse(readFileSync(lockFile(paths), 'utf8')).skills : {};

// Simulates `npx -y skills add <source>[#ref] …`, recording the `#ref` suffix into the lock as the installer does.
const fakeInstaller = (paths: MachinePathsValue) => {
  const commands: Command[] = [];
  const layer = Layer.succeed(Processes, {
    run: (command: Command) => Effect.sync(() => {
      commands.push(command);
      const [, , verb, ...rest] = command.args;
      if (command.cmd !== 'npx' || command.args[1] !== 'skills' || verb !== 'add') return { code: 2, stdout: '' };
      const valuesOf = (flag: string) => {
        const at = rest.indexOf(flag);
        if (at < 0) return [];
        const end = rest.findIndex((a, i) => i > at && a.startsWith('--'));
        return rest.slice(at + 1, end < 0 ? undefined : end);
      };
      const [arg] = rest;
      const hash = arg!.lastIndexOf('#');
      const source = hash < 0 ? arg : arg!.slice(0, hash);
      const ref = hash < 0 ? undefined : arg!.slice(hash + 1);
      const lock = readLock(paths);
      for (const n of valuesOf('--skill')) {
        rmSync(join(paths.agentsSkills, n), { recursive: true, force: true });
        mkdirSync(join(paths.agentsSkills, n), { recursive: true });
        lock[n] = { source, ...(ref ? { ref } : {}) };
        if (valuesOf('--agent').includes('claude-code')) mkdirSync(join(paths.claude, 'skills', n), { recursive: true });
      }
      writeFileSync(lockFile(paths), JSON.stringify({ skills: lock }));
      return { code: 0, stdout: '' };
    }),
  });
  return { commands, layer };
};

test('an off-pin reinstall backs up the installed folder and adds the skill at its pin', async () => {
  const m = skillsMachine();
  mkdirSync(m.paths.repo, { recursive: true });
  mkdirSync(join(m.paths.agentsSkills, 'a'), { recursive: true });
  writeFileSync(join(m.paths.agentsSkills, 'a', 'SKILL.md'), '# a\n');
  writeLock(m.paths, { a: { source: 'o/r', ref: NEXT } });
  const installer = fakeInstaller(m.paths);
  const layer = backupsForRun().pipe(Layer.provideMerge(Layer.mergeAll(machinePaths(m.paths), nodeFs, installer.layer)));
  const r = report([item('a', 'off-pin', 'apply')], [skill('a', 'o/r', pin(SHA))]);
  const p: Plan = plan('apply', r, selectAll, [skillsDomain]);
  const events: Progress[] = [...await Effect.runPromise(Stream.runCollect(execute(p, r, [skillsDomain])).pipe(Effect.provide(layer)))];
  const done = events.at(-1) as Extract<Progress, { type: 'done' }>;
  assert.deepEqual([done.type, done.ok, done.failed], ['done', 1, 0]);
  assert.equal(readFileSync(join(done.backups!, 'skills', 'a', 'SKILL.md'), 'utf8'), '# a\n');
  assert.deepEqual(installer.commands.map((c) => [c.cmd, ...c.args].join(' ')),
    [`npx -y skills add o/r#${SHA} --skill a --agent claude-code codex --global --yes`]);
  assert.equal(readLock(m.paths).a!.ref, SHA);
});

test('update re-exposes a pinned skill lacking an agent link at its pin, never at upstream HEAD', async () => {
  const m = skillsMachine();
  mkdirSync(m.paths.repo, { recursive: true });
  mkdirSync(join(m.paths.agentsSkills, 'a'), { recursive: true });
  writeFileSync(join(m.paths.agentsSkills, 'a', 'SKILL.md'), '# a\n');
  writeLock(m.paths, { a: { source: 'o/r', ref: SHA } });
  const installer = fakeInstaller(m.paths);
  const layer = backupsForRun().pipe(Layer.provideMerge(Layer.mergeAll(machinePaths(m.paths), nodeFs, installer.layer)));
  // `stale` makes the plan non-empty, so it carries an expose step; `a` lacks only its claude-code link.
  const r = report([item('stale', 'outdated', 'apply', 'x/y')], [skill('a', 'o/r', pin(SHA))]);
  const p = plan('update', r, { ...selectAll, targets: ['claude'] }, [skillsDomain]);
  const expose: Plan = { kind: 'update', steps: p.steps.filter((s) => s.key === 'skills:expose').map((s) => ({ ...s, touches: [] })), skipped: [] };
  const events: Progress[] = [...await Effect.runPromise(Stream.runCollect(execute(expose, r, [skillsDomain])).pipe(Effect.provide(layer)))];
  const done = events.at(-1) as Extract<Progress, { type: 'done' }>;
  assert.deepEqual([done.type, done.ok, done.failed], ['done', 1, 0]);
  assert.deepEqual(installer.commands.map((c) => [c.cmd, ...c.args].join(' ')),
    [`npx -y skills add o/r#${SHA} --skill a --agent claude-code --global --yes`]);
  assert.equal(readFileSync(join(done.backups!, 'skills', 'a', 'SKILL.md'), 'utf8'), '# a\n');
  assert.equal(readLock(m.paths).a!.ref, SHA);
});
