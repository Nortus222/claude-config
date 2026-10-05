import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import type { DesiredConfig, ResolvedSkill } from '@nortuscc/profile-engine';
import { inspectSkills, machinePaths, nodeFs } from '../src/index.ts';

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

test('an unreadable store is a probe error and every declared skill reads as missing', async () => {
  if (process.getuid?.() === 0) return;
  const m = skillsMachine();
  mkdirSync(m.paths.agentsSkills, { recursive: true });
  chmodSync(m.paths.agentsSkills, 0o000);
  try {
    const report = await m.run(inspectSkills(desiredWith([skill('want', 'o/r')])));
    assert.equal(report.probeErrors.length, 1);
    assert.match(report.probeErrors[0]!, new RegExp(`^could not read ${m.paths.agentsSkills}: `));
    assert.deepEqual(report.items.map((i) => [i.key, i.state]), [['skill:want', 'missing']]);
  } finally {
    chmodSync(m.paths.agentsSkills, 0o755);
  }
});

test('an unreadable agent directory is a probe error, not a link item', async () => {
  if (process.getuid?.() === 0) return;
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
