import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import {
  addCommand, agentSkillsDirs, installedSkillNames, machinePaths, nodeFs, Processes, readExposure, readSkillLock,
  removeCommand, runInstaller, skillExposure, updateCommand, type Command,
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

test('a missing, unparseable or misshapen lock reads as empty', async () => {
  const { paths, run } = skillsMachine();
  assert.deepEqual(await run(readSkillLock), { skills: {} });
  mkdirSync(join(paths.agentsSkills, '..'), { recursive: true });
  for (const text of ['{nope', '[]', '{"skills": 3}']) {
    writeFileSync(join(paths.agentsSkills, '..', '.skill-lock.json'), text);
    assert.deepEqual(await run(readSkillLock), { skills: {} });
  }
  writeFileSync(join(paths.agentsSkills, '..', '.skill-lock.json'), '{"skills":{"a":{"source":"o/r"}}}');
  assert.deepEqual(await run(readSkillLock), { skills: { a: { source: 'o/r' } } });
});

test('installed names are the store directories and links, sorted', async () => {
  const { home, paths, run } = skillsMachine();
  assert.deepEqual(await run(installedSkillNames), []);
  mkdirSync(join(paths.agentsSkills, 'b'), { recursive: true });
  mkdirSync(join(paths.agentsSkills, 'a'));
  writeFileSync(join(paths.agentsSkills, 'README'), 'not a skill');
  symlinkSync(join(home, 'elsewhere'), join(paths.agentsSkills, 'c'));
  assert.deepEqual(await run(installedSkillNames), ['a', 'b', 'c']);
});

test('Claude loads from its own directory, Codex from the store and its own', () => {
  const { paths } = skillsMachine();
  assert.deepEqual(agentSkillsDirs(paths, 'claude'), [join(paths.claude, 'skills')]);
  assert.deepEqual(agentSkillsDirs(paths, 'codex'), [paths.agentsSkills, join(paths.codex, 'skills')]);
});

test('exposure follows links, ignores dot entries and counts the store for Codex', async () => {
  const { paths, run } = skillsMachine();
  mkdirSync(join(paths.agentsSkills, 'tdd'), { recursive: true });
  mkdirSync(join(paths.claude, 'skills'), { recursive: true });
  symlinkSync(join(paths.agentsSkills, 'tdd'), join(paths.claude, 'skills', 'tdd'));
  symlinkSync(join(paths.agentsSkills, 'removed'), join(paths.claude, 'skills', 'removed'));
  mkdirSync(join(paths.codex, 'skills', '.system'), { recursive: true });
  assert.deepEqual(await run(readExposure(['claude', 'codex'])), { list: { claude: ['tdd'], codex: ['tdd'] }, errors: [] });
});

test('a copied skill counts as exposed; an agent never given a skill exposes none', async () => {
  const { paths, run } = skillsMachine();
  mkdirSync(join(paths.claude, 'skills', 'copied'), { recursive: true });
  assert.deepEqual(await run(readExposure(['claude', 'codex'])), { list: { claude: ['copied'], codex: [] }, errors: [] });
});

test('a skill only in the store is exposed to Codex but not Claude', async () => {
  const { paths, run } = skillsMachine();
  mkdirSync(join(paths.agentsSkills, 'x'), { recursive: true });
  const { list } = await run(readExposure(['claude', 'codex']));
  assert.deepEqual(list, { claude: [], codex: ['x'] });
});

test('an unreadable agent directory is an error, never an empty list', async () => {
  if (process.getuid?.() === 0) return;
  const { paths, run } = skillsMachine();
  mkdirSync(join(paths.claude, 'skills'), { recursive: true });
  chmodSync(join(paths.claude, 'skills'), 0o000);
  try {
    const result = await run(readExposure(['claude']));
    assert.deepEqual(result.list, {});
    assert.match(result.errors[0]!, /could not read the skill directory for claude-code/);
  } finally {
    chmodSync(join(paths.claude, 'skills'), 0o755);
  }
});

test('a stray file where the skills directory should be is an error, not a throw', async () => {
  const { paths, run } = skillsMachine();
  mkdirSync(paths.claude, { recursive: true });
  writeFileSync(join(paths.claude, 'skills'), 'oops');
  const result = await run(readExposure(['claude']));
  assert.deepEqual(result.list, {});
  assert.equal(result.errors.length, 1);
});

test('skillExposure splits exposed, partial and missing', () => {
  assert.deepEqual(skillExposure({ names: ['a', 'b', 'c'], targets: ['claude', 'codex'], list: { claude: ['a', 'b'], codex: ['a'] } }),
    { exposed: ['a'], partial: [{ name: 'b', missing: ['codex'] }], missing: ['c'] });
  assert.deepEqual(skillExposure({ names: [], targets: ['codex'], list: { codex: ['x'] } }), { exposed: [], partial: [], missing: [] });
  assert.deepEqual(skillExposure({ names: ['a'], targets: ['claude'], list: {} }), { exposed: [], partial: [], missing: ['a'] });
});

test('installer argv: variadic names, explicit agents, global and non-interactive', () => {
  assert.deepEqual(addCommand({ source: 'o/r', skills: ['a', 'b'], targets: ['claude', 'codex'] }).args,
    ['-y', 'skills', 'add', 'o/r', '--skill', 'a', 'b', '--agent', 'claude-code', 'codex', '--global', '--yes']);
  assert.deepEqual(addCommand({ source: 'o/r', skills: ['a'], targets: ['claude'] }).args,
    ['-y', 'skills', 'add', 'o/r', '--skill', 'a', '--agent', 'claude-code', '--global', '--yes']);
  assert.deepEqual(updateCommand(['a', 'b']).args, ['-y', 'skills', 'update', 'a', 'b', '--global', '--yes']);
  assert.deepEqual(removeCommand(['a']).args, ['-y', 'skills', 'remove', 'a', '--global', '--yes']);
  assert.equal(addCommand({ source: 'o/r', skills: ['a'], targets: [] }).cmd, 'npx');
});

test('runInstaller reports a non-zero exit as a failed result', async () => {
  const seen: Command[] = [];
  const fake = Layer.succeed(Processes, { run: (c) => Effect.sync(() => { seen.push(c); return { code: 3, stdout: '' }; }) });
  const result = await Effect.runPromise(runInstaller(updateCommand(['a'])).pipe(Effect.provide(fake)));
  assert.deepEqual(result, { ok: false, note: 'npx exited with 3' });
  assert.equal(seen[0]!.output, 'inherit');
  const ok = Layer.succeed(Processes, { run: () => Effect.succeed({ code: 0, stdout: '' }) });
  assert.deepEqual(await Effect.runPromise(runInstaller(updateCommand(['a'])).pipe(Effect.provide(ok))), { ok: true, note: '' });
});
