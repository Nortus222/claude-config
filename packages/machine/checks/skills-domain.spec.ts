import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer, Stream } from 'effect';
import type { DesiredConfig, ResolvedSkill } from '@nortuscc/profile-engine';
import {
  backupsForRun, emitManifest, execute, inspectSkills, machinePaths, nodeFs, plan, Processes, samePlan, selectAll, skillsDomain,
  type Command, type MachinePathsValue, type MachineReport, type Observed, type Plan, type Progress,
} from '../src/index.ts';

const skillsMachine = () => {
  const home = mkdtempSync(join(tmpdir(), 'machine-skills-'));
  const paths = {
    repo: join(home, 'repo'), claude: join(home, '.claude'), codex: join(home, '.codex'),
    codexOpenRouter: join(home, '.codex-openrouter'), agentsSkills: join(home, '.agents', 'skills'),
    stateRoot: join(home, 'state'), backups: join(home, 'state', 'backups'),
  };
  const layer = Layer.mergeAll(machinePaths(paths), nodeFs);
  const run = <A, E>(effect: Effect.Effect<A, E, any>) => Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E>);
  return { home, paths, layer, run };
};

const skill = (name: string, source: string, over: Partial<ResolvedSkill> = {}): ResolvedSkill => ({
  name, source, exact: false, optional: false, install: true, from: { layer: 'base', source: 'test' }, ...over,
});
const desiredWith = (skills: ResolvedSkill[]): DesiredConfig => ({ files: [], skills, integrations: [], allow: {}, issues: [] });
const writeLock = (paths: { agentsSkills: string }, skills: unknown) => {
  mkdirSync(join(paths.agentsSkills, '..'), { recursive: true });
  writeFileSync(join(paths.agentsSkills, '..', '.skill-lock.json'), JSON.stringify({ skills }));
};

test('inspect reports ok, missing, optional, extra and local skills', async () => {
  const m = skillsMachine();
  for (const n of ['have', 'extra', 'mine']) mkdirSync(join(m.paths.agentsSkills, n), { recursive: true });
  writeLock(m.paths, { have: { source: 'o/r' }, extra: { source: 'x/y' } });
  // Both agents see `have`, so no link items.
  mkdirSync(join(m.paths.claude, 'skills', 'have'), { recursive: true });
  const report = await m.run(inspectSkills(desiredWith([
    skill('have', 'o/r'), skill('want', 'o/r'), skill('maybe', 'o/r', { optional: true, install: false }),
  ])));
  assert.deepEqual(report.items.map((i) => [i.key, i.state, i.disposition, i.target]), [
    ['skill:have', 'ok', 'in-sync', undefined],
    ['skill:want', 'missing', 'apply', undefined],
    ['skill:maybe', 'missing', 'excluded', undefined],
    ['skill:extra', 'extra', 'undeclared', undefined],
    ['skill:mine', 'local', 'excluded', undefined],
  ]);
  const by = (k: string) => report.items.find((i) => i.key === k)!;
  assert.equal(by('skill:maybe').note, 'optional');
  assert.equal(by('skill:extra').note, 'not in the manifest');
  assert.equal(by('skill:extra').group, 'x/y');
  assert.equal(by('skill:mine').note, 'authored locally');
  assert.equal(by('skill:mine').group, '');
  assert.equal(by('skill:have').group, 'o/r');
  assert.equal(by('skill:have').label, 'have');
  assert.deepEqual(by('skill:have').from, { layer: 'base', source: 'test' });
  assert.deepEqual(report.probeErrors, []);
});

test('a non-optional skill this machine opted out of is noted as not chosen, not optional', async () => {
  const m = skillsMachine();
  mkdirSync(m.paths.agentsSkills, { recursive: true });
  const report = await m.run(inspectSkills(desiredWith([skill('skipped', 'o/r', { optional: false, install: false })])));
  assert.deepEqual(report.items.map((i) => [i.key, i.state, i.disposition, i.note]),
    [['skill:skipped', 'missing', 'excluded', 'not chosen for this machine']]);
});

test('a manifest skill installed from a different source still counts as present', async () => {
  const m = skillsMachine();
  mkdirSync(join(m.paths.agentsSkills, 'thing'), { recursive: true });
  mkdirSync(join(m.paths.claude, 'skills', 'thing'), { recursive: true });
  writeLock(m.paths, { thing: { source: 'z/z' } });
  const report = await m.run(inspectSkills(desiredWith([skill('thing', 'a/b')])));
  assert.deepEqual(report.items.map((i) => [i.key, i.state]), [['skill:thing', 'ok']]);
});

test('a non-string lock source is not a source: the skill is local', async () => {
  const m = skillsMachine();
  mkdirSync(join(m.paths.agentsSkills, 'odd'), { recursive: true });
  writeLock(m.paths, { odd: { source: 5 } });
  const report = await m.run(inspectSkills(desiredWith([])));
  assert.deepEqual(report.items.map((i) => [i.key, i.state, i.group]), [['skill:odd', 'local', '']]);
});

test('a skill one agent cannot load becomes a per-agent link item', async () => {
  const m = skillsMachine();
  mkdirSync(join(m.paths.agentsSkills, 'tdd'), { recursive: true }); // Codex reads the store; Claude has no link
  const report = await m.run(inspectSkills(desiredWith([skill('tdd', 'o/r')])));
  const links = report.items.filter((i) => i.key.startsWith('skill-link:'));
  assert.deepEqual(links.map((i) => [i.key, i.target, i.state, i.disposition]),
    [['skill-link:claude:tdd', 'claude', 'unlinked', 'apply']]);
  assert.equal(links[0]!.group, 'o/r');
  assert.equal(links[0]!.label, 'tdd');
  assert.equal(links[0]!.note, 'not loadable by claude-code');
});

test('items are ordered: declared, undeclared, then links in declared order with claude before codex', async () => {
  const m = skillsMachine();
  for (const n of ['a', 'b', 'z']) mkdirSync(join(m.paths.agentsSkills, n), { recursive: true });
  // Codex reads the store; Claude lacks `b` and `a`. Codex's own directory lacks nothing the store has.
  const report = await m.run(inspectSkills(desiredWith([skill('b', 'o/r'), skill('a', 'o/r')])));
  assert.deepEqual(report.items.map((i) => i.key), [
    'skill:b', 'skill:a', 'skill:z', 'skill-link:claude:b', 'skill-link:claude:a',
  ]);
});

test('an unreadable store is a probe error and every declared skill reads as unknown and blocked', async (t) => {
  if (process.platform === 'win32') return t.skip('Windows chmod does not deny directory access');
  if (process.getuid?.() === 0) return t.skip('permissions are not enforced for root');
  const m = skillsMachine();
  mkdirSync(m.paths.agentsSkills, { recursive: true });
  chmodSync(m.paths.agentsSkills, 0o000);
  try {
    const desired = desiredWith([skill('want', 'o/r'), skill('maybe', 'o/r', { optional: true, install: false })]);
    const report = await m.run(inspectSkills(desired));
    assert.equal(report.probeErrors.length, 1);
    assert.ok(report.probeErrors[0]!.startsWith(`could not read ${m.paths.agentsSkills}: `));
    assert.deepEqual(report.items.map((i) => [i.key, i.state, i.disposition, i.note]), [
      ['skill:want', 'unknown', 'blocked', 'store unreadable'],
      ['skill:maybe', 'unknown', 'blocked', 'store unreadable'],
    ]);
    const p = plan('apply', { desired, ...report }, selectAll, [skillsDomain]);
    assert.deepEqual(p.steps, []);
    assert.deepEqual(p.skipped, [
      { key: 'skill:want', reason: 'store unreadable' },
      { key: 'skill:maybe', reason: 'store unreadable' },
    ]);
  } finally {
    chmodSync(m.paths.agentsSkills, 0o755);
  }
});

test('an unreadable agent directory is a probe error, not a link item', async (t) => {
  if (process.platform === 'win32') return t.skip('Windows chmod does not deny directory access');
  if (process.getuid?.() === 0) return t.skip('permissions are not enforced for root');
  const m = skillsMachine();
  mkdirSync(join(m.paths.agentsSkills, 'tdd'), { recursive: true });
  mkdirSync(join(m.paths.claude, 'skills'), { recursive: true });
  chmodSync(join(m.paths.claude, 'skills'), 0o000);
  try {
    const report = await m.run(inspectSkills(desiredWith([skill('tdd', 'o/r')])));
    assert.equal(report.probeErrors.length, 1);
    assert.match(report.probeErrors[0]!, /claude-code/);
    assert.deepEqual(report.items.filter((i) => i.key.startsWith('skill-link:')), []);
  } finally {
    chmodSync(join(m.paths.claude, 'skills'), 0o755);
  }
});

// ---- steps: pure planning ----

const item = (name: string, state: string, disposition: Observed['disposition'], group = 'o/r', extra: Partial<Observed> = {}): Observed =>
  ({ key: `skill:${name}`, domain: 'skills', label: name, group, state, disposition, ...extra });
const report = (items: Observed[], skills: ResolvedSkill[] = []): MachineReport =>
  ({ desired: desiredWith(skills), items, probeErrors: [] });

test('an update plan removes, refreshes, adopts, re-exposes, then writes the manifest', () => {
  const r = report([item('old', 'gone', 'apply'), item('stale', 'outdated', 'apply'), item('new', 'available', 'excluded', 'x/y'),
    item('far', 'unknown', 'blocked')]);
  const p = plan('update', r, { ...selectAll, targets: ['claude'] }, [skillsDomain]);
  assert.deepEqual(p.steps.map((s) => [s.key, s.action, s.touches, s.targets]), [
    ['skills:remove', 'remove', ['skills/old'], undefined],
    ['skills:update', 'update-skills', ['skills/stale'], undefined],
    ['skills:install:x/y', 'install-skills', ['skills/new'], ['claude']],
    ['skills:expose', 'install-skills', ['skills/stale'], ['claude']],
    ['skills:manifest', 'write-manifest', ['skills-manifest.txt'], undefined],
  ]);
  assert.deepEqual(p.steps.map((s) => [s.summary, s.interruptible]), [
    ['removing 1 skill(s)', true],
    ['updating 1 skill(s)', true],
    ['installing 1 skill(s) from x/y', true],
    ['re-exposing skills to claude-code', true],
    ['write skills-manifest.txt', false],
  ]);
  assert.ok(p.steps.every((s) => s.domain === 'skills'));
  assert.deepEqual(p.skipped, [{ key: 'skill:far', reason: 'source unreachable' }]);
});

test('a refresh alone writes no manifest; nothing selected plans nothing', () => {
  const r = report([item('stale', 'outdated', 'apply'), item('new', 'available', 'excluded')]);
  assert.deepEqual(plan('update', r, { ...selectAll, only: ['skill:stale'] }, [skillsDomain]).steps.map((s) => s.key),
    ['skills:update', 'skills:expose']);
  assert.deepEqual(plan('update', r, { ...selectAll, only: [] }, [skillsDomain]).steps, []);
});

test('update installs one step per source in code-point order and re-exposes to every selected agent', () => {
  const r = report([item('z2', 'available', 'excluded', 'z/z'), item('b', 'available', 'excluded', 'a/a'),
    item('a', 'available', 'excluded', 'a/a'), item('z1', 'available', 'excluded', 'z/z')]);
  const p = plan('update', r, selectAll, [skillsDomain]);
  assert.deepEqual(p.steps.map((s) => [s.key, s.touches, s.summary]), [
    ['skills:install:a/a', ['skills/a', 'skills/b'], 'installing 2 skill(s) from a/a'],
    ['skills:install:z/z', ['skills/z1', 'skills/z2'], 'installing 2 skill(s) from z/z'],
    ['skills:expose', [], 're-exposing skills to claude-code, codex'],
    ['skills:manifest', ['skills-manifest.txt'], 'write skills-manifest.txt'],
  ]);
});

test('apply installs missing skills and re-exposes unlinked ones for the selected agents, per source', () => {
  const r = report([
    item('want', 'missing', 'apply'), item('maybe', 'missing', 'excluded'),
    { ...item('tdd', 'unlinked', 'apply'), key: 'skill-link:claude:tdd', target: 'claude' },
    { ...item('cx', 'unlinked', 'apply'), key: 'skill-link:codex:cx', target: 'codex' },
  ]);
  const p = plan('apply', r, { ...selectAll, targets: ['claude'] }, [skillsDomain]);
  assert.deepEqual(p.steps.map((s) => [s.key, s.touches, s.targets]), [['skills:install:o/r', ['skills/tdd', 'skills/want'], ['claude']]]);
  assert.equal(p.steps[0]!.summary, 'installing 2 skill(s) from o/r');
  assert.deepEqual(p.skipped, [{ key: 'skill:maybe', reason: 'optional, not chosen' }]);
  const declined = plan('apply', r, { ...selectAll, declined: ['skills'] }, [skillsDomain]);
  assert.deepEqual(declined.steps, []);
  assert.deepEqual(declined.skipped, [
    { key: 'skill:want', reason: 'skills declined' },
    { key: 'skill-link:claude:tdd', reason: 'skills declined' },
    { key: 'skill-link:codex:cx', reason: 'skills declined' },
  ]);
});

test('uninstall and capture plan no skill steps', () => {
  const r = report([item('want', 'missing', 'apply'), item('old', 'gone', 'apply')]);
  for (const kind of ['uninstall', 'capture'] as const) {
    assert.deepEqual(plan(kind, r, selectAll, [skillsDomain]), { kind, steps: [], skipped: [] });
  }
});

test('the same report and selection always plan the same steps', () => {
  const r = report([item('b', 'missing', 'apply', 'z/z'), item('a', 'missing', 'apply', 'a/a')]);
  assert.ok(samePlan(plan('apply', r, selectAll, [skillsDomain]), plan('apply', r, selectAll, [skillsDomain])));
});

// ---- run: through execute, real files, a fake installer ----

const lockFile = (paths: MachinePathsValue) => join(paths.agentsSkills, '..', '.skill-lock.json');
const readLock = (paths: MachinePathsValue): Record<string, Record<string, unknown>> =>
  existsSync(lockFile(paths)) ? JSON.parse(readFileSync(lockFile(paths), 'utf8')).skills : {};

// A `Processes` that records every Command and simulates `npx -y skills <verb> …` on the temp store,
// lock and ~/.claude/skills. `behaviour.fail` names a verb that exits 1 instead of doing anything.
const fakeInstaller = (paths: MachinePathsValue, behaviour: { readonly fail?: 'add' | 'update' | 'remove' } = {}) => {
  const commands: Command[] = [];
  const layer = Layer.succeed(Processes, {
    run: (command: Command) => Effect.sync(() => {
      commands.push(command);
      const [, , verb, ...rest] = command.args;
      if (command.cmd !== 'npx' || command.args[1] !== 'skills') return { code: 127, stdout: '' };
      if (verb === behaviour.fail) return { code: 1, stdout: '' };
      // Values of a variadic flag: everything after it up to the next `--` flag.
      const valuesOf = (flag: string) => {
        const at = rest.indexOf(flag);
        if (at < 0) return [];
        const end = rest.findIndex((a, i) => i > at && a.startsWith('--'));
        return rest.slice(at + 1, end < 0 ? undefined : end);
      };
      const positional = rest.slice(0, rest.findIndex((a) => a.startsWith('--')));
      const lock = readLock(paths);
      if (verb === 'remove') {
        for (const n of positional) {
          rmSync(join(paths.agentsSkills, n), { recursive: true, force: true });
          delete lock[n];
        }
      } else if (verb === 'update') {
        for (const n of positional) if (lock[n]) lock[n] = { ...lock[n], skillFolderHash: 'new' };
      } else if (verb === 'add') {
        const [source] = positional;
        const agents = valuesOf('--agent');
        for (const n of valuesOf('--skill')) {
          mkdirSync(join(paths.agentsSkills, n), { recursive: true });
          lock[n] = { source };
          if (agents.includes('claude-code')) mkdirSync(join(paths.claude, 'skills', n), { recursive: true });
        }
      } else {
        return { code: 2, stdout: '' };
      }
      mkdirSync(join(paths.agentsSkills, '..'), { recursive: true });
      writeFileSync(lockFile(paths), JSON.stringify({ skills: lock }));
      return { code: 0, stdout: '' };
    }),
  });
  return { commands, layer };
};

const runMachine = (behaviour: { readonly fail?: 'add' | 'update' | 'remove' } = {}) => {
  const m = skillsMachine();
  mkdirSync(m.paths.repo, { recursive: true });
  const installer = fakeInstaller(m.paths, behaviour);
  const layer = backupsForRun().pipe(Layer.provideMerge(Layer.mergeAll(machinePaths(m.paths), nodeFs, installer.layer)));
  const go = async (p: Plan, r: MachineReport): Promise<Progress[]> =>
    [...await Effect.runPromise(Stream.runCollect(execute(p, r, [skillsDomain])).pipe(Effect.provide(layer)))];
  const argv = () => installer.commands.map((c) => [c.cmd, ...c.args].join(' '));
  const install = (name: string, source = 'o/r', claude = true) => {
    mkdirSync(join(m.paths.agentsSkills, name), { recursive: true });
    writeFileSync(join(m.paths.agentsSkills, name, 'SKILL.md'), `# ${name}\n`);
    if (claude) mkdirSync(join(m.paths.claude, 'skills', name), { recursive: true });
    writeLock(m.paths, { ...readLock(m.paths), [name]: { source } });
  };
  return { ...m, go, argv, install };
};

const finished = (events: Progress[], key: string) =>
  events.find((e): e is Extract<Progress, { type: 'finished' }> => e.type === 'finished' && e.key === key);

test('an update backs up the skill folder before running the installer', async () => {
  const m = runMachine();
  m.install('stale');
  const r = report([item('stale', 'outdated', 'apply')], [skill('stale', 'o/r')]);
  const p = plan('update', r, selectAll, [skillsDomain]);
  assert.deepEqual(p.steps.map((s) => s.key), ['skills:update', 'skills:expose']);
  const events = await m.go(p, r);
  const done = events.at(-1) as Extract<Progress, { type: 'done' }>;
  assert.equal(done.type, 'done');
  assert.ok(done.backups?.startsWith(join(m.paths.backups, 'nortuscc-')));
  assert.deepEqual(events.at(-1), { type: 'done', ok: 2, failed: 0, backups: done.backups });
  assert.equal(readFileSync(join(done.backups!, 'skills', 'stale', 'SKILL.md'), 'utf8'), '# stale\n');
  assert.deepEqual(m.argv(), ['npx -y skills update stale --global --yes']);
});

test('the manifest is written to paths.repo only', async () => {
  const m = runMachine();
  m.install('old');
  m.install('stale');
  writeFileSync(join(m.paths.repo, 'skills-manifest.txt'), '[o/r]\nold\nstale\n');
  const r = report([item('old', 'gone', 'apply'), item('stale', 'ok', 'in-sync')], [skill('old', 'o/r'), skill('stale', 'o/r')]);
  const p = plan('update', r, selectAll, [skillsDomain]);
  assert.deepEqual(p.steps.map((s) => s.key), ['skills:remove', 'skills:expose', 'skills:manifest']);
  const events = await m.go(p, r);
  assert.equal(readFileSync(join(m.paths.repo, 'skills-manifest.txt'), 'utf8'),
    emitManifest([{ source: 'o/r', skills: ['stale'], exact: false, optional: false }]));
  assert.match(finished(events, 'skills:manifest')!.note, /^written — 1 skill\(s\)/);
  assert.equal(existsSync(join(m.paths.agentsSkills, 'old')), false);
  const done = events.at(-1) as Extract<Progress, { type: 'done' }>;
  assert.equal(existsSync(join(done.backups!, 'skills', 'old', 'SKILL.md')), true);
});

test('the shrink guard leaves the manifest alone when it would drop skills this machine merely lacks', async () => {
  const m = runMachine();
  m.install('old');
  m.install('stale');
  const names = ['a', 'b', 'c', 'd', 'e', 'f'];
  const text = `[o/r]\n${['old', 'stale', ...names].join('\n')}\n`;
  writeFileSync(join(m.paths.repo, 'skills-manifest.txt'), text);
  const r = report([item('old', 'gone', 'apply')], ['old', 'stale', ...names].map((n) => skill(n, 'o/r')));
  const events = await m.go(plan('update', r, selectAll, [skillsDomain]), r);
  const note = finished(events, 'skills:manifest')!;
  assert.equal(note.outcome, 'ok');
  assert.match(note.note, /^left alone — would drop 6 entr\(ies\)/);
  assert.equal(readFileSync(join(m.paths.repo, 'skills-manifest.txt'), 'utf8'), text);
});

test('--target claude installs for claude-code only', async () => {
  const m = runMachine();
  const r = report([item('want', 'missing', 'apply')], [skill('want', 'o/r')]);
  const p = plan('apply', r, { ...selectAll, targets: ['claude'] }, [skillsDomain]);
  assert.deepEqual(p.steps.map((s) => [s.key, s.targets]), [['skills:install:o/r', ['claude']]]);
  const events = await m.go(p, r);
  assert.equal(finished(events, 'skills:install:o/r')!.outcome, 'ok');
  assert.deepEqual(m.argv(), ['npx -y skills add o/r --skill want --agent claude-code --global --yes']);
});

// Issue #104: an off-pin skill whose pin was removed is reinstalled by a ref-less `add`, which replaces its folder.
test('an unpinned install backs up the skill folders it replaces', async () => {
  const m = runMachine();
  m.install('tdd');
  const r = report([item('tdd', 'off-pin', 'apply'), item('want', 'missing', 'apply')], [skill('tdd', 'o/r'), skill('want', 'o/r')]);
  const p = plan('apply', r, { ...selectAll, targets: ['claude'] }, [skillsDomain]);
  assert.deepEqual(p.steps.map((s) => s.key), ['skills:install:o/r']);
  const events = await m.go(p, r);
  const done = events.at(-1) as Extract<Progress, { type: 'done' }>;
  assert.equal(done.type, 'done');
  assert.equal(readFileSync(join(done.backups!, 'skills', 'tdd', 'SKILL.md'), 'utf8'), '# tdd\n');
  // Nothing was installed yet, so nothing is backed up.
  assert.equal(existsSync(join(done.backups!, 'skills', 'want')), false);
  assert.deepEqual(m.argv(), ['npx -y skills add o/r --skill tdd want --agent claude-code --global --yes']);
});

const exposeStep = plan('update', report([item('x', 'outdated', 'apply')]), { ...selectAll, targets: ['claude'] }, [skillsDomain])
  .steps.find((s) => s.key === 'skills:expose')!;
const exposeOnly = (): Plan => ({ kind: 'update', steps: [{ ...exposeStep, touches: [] }], skipped: [] });

test('the expose step re-adds a declared skill an agent cannot load', async () => {
  const m = runMachine();
  m.install('tdd', 'o/r', false);
  const r = report([], [skill('tdd', 'o/r')]);
  const events = await m.go(exposeOnly(), r);
  assert.deepEqual(m.argv(), ['npx -y skills add o/r --skill tdd --agent claude-code --global --yes']);
  const result = finished(events, 'skills:expose')!;
  assert.equal(result.outcome, 'ok');
  assert.equal(result.note, 're-exposed 1 skill(s) to claude-code');
});

test('an unreadable agent directory is not a reason to reinstall', async (t) => {
  if (process.platform === 'win32') return t.skip('Windows chmod does not deny directory access');
  if (process.getuid?.() === 0) return t.skip('permissions are not enforced for root');
  const m = runMachine();
  m.install('tdd', 'o/r', false);
  mkdirSync(join(m.paths.claude, 'skills'), { recursive: true });
  chmodSync(join(m.paths.claude, 'skills'), 0o000);
  try {
    const r = report([], [skill('tdd', 'o/r')]);
    const events = await m.go(exposeOnly(), r);
    assert.deepEqual(m.argv(), []);
    const result = finished(events, 'skills:expose')!;
    assert.equal(result.outcome, 'ok');
    assert.match(result.note, /could not read the skill directory for claude-code/);
  } finally {
    chmodSync(join(m.paths.claude, 'skills'), 0o755);
  }
});

test('a failing installer fails its own step and later steps still run', async () => {
  const m = runMachine({ fail: 'update' });
  m.install('old');
  m.install('stale');
  writeFileSync(join(m.paths.repo, 'skills-manifest.txt'), '[o/r]\nold\nstale\n');
  const r = report([item('old', 'gone', 'apply'), item('stale', 'outdated', 'apply')], [skill('old', 'o/r'), skill('stale', 'o/r')]);
  const events = await m.go(plan('update', r, selectAll, [skillsDomain]), r);
  assert.deepEqual(events.filter((e) => e.type === 'finished').map((e) => e.type === 'finished' && [e.key, e.outcome, e.note]), [
    ['skills:remove', 'ok', ''],
    ['skills:update', 'failed', 'npx exited with 1'],
    ['skills:expose', 'ok', ''],
    ['skills:manifest', 'ok', 'written — 1 skill(s)'],
  ]);
  assert.deepEqual((events.at(-1) as Extract<Progress, { type: 'done' }>).failed, 1);
});
