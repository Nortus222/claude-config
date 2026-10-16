import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import type { DesiredConfig } from '@nortuscc/profile-engine';
import { Backups, backupsForRun, checkSkillOwnership, disableOwnedSkill, Fs, FsFailed,
  machinePaths, nodeFileIntegrity, nodeFs, skillLockPath } from '../src/index.ts';

const machine = (t: TestContext) => {
  const home = mkdtempSync(join(tmpdir(), 'skills-owned-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const paths = { repo: join(home, 'repo'), claude: join(home, '.claude'), codex: join(home, '.codex'),
    codexOpenRouter: join(home, '.codex-openrouter'), agentsSkills: join(home, '.agents', 'skills'),
    stateRoot: join(home, 'state'), backups: join(home, 'backups') };
  const desired: DesiredConfig = { files: [], integrations: [], allow: {}, issues: [], skills: [{ name: 'tdd', source: 'o/r',
    install: false, optional: true, exact: false, from: { layer: 'machine', source: 'test' } }] };
  const shared = join(paths.agentsSkills, 'tdd'), claude = join(paths.claude, 'skills', 'tdd'), codex = join(paths.codex, 'skills', 'tdd');
  mkdirSync(shared, { recursive: true }); writeFileSync(join(shared, 'SKILL.md'), '# owned\n');
  mkdirSync(join(paths.claude, 'skills'), { recursive: true }); symlinkSync(shared, claude);
  mkdirSync(join(paths.codex, 'skills'), { recursive: true }); cpSync(shared, codex, { recursive: true });
  const lock = skillLockPath(paths);
  const raw = JSON.stringify({ version: 7, unknown: { keep: true }, skills: { tdd: { source: 'o/r', unknown: 'kept until disabled' }, other: { source: 'a/b' } } });
  writeFileSync(lock, raw);
  const base = Layer.mergeAll(nodeFs, nodeFileIntegrity, machinePaths(paths));
  const layer = backupsForRun().pipe(Layer.provideMerge(base));
  const run = <A, E>(effect: Effect.Effect<A, E, any>, extra?: Layer.Layer<any, any, any>) =>
    Effect.runPromise(effect.pipe(Effect.provide(extra ? Layer.merge(layer, extra) : layer)) as Effect.Effect<A, E>);
  return { home, paths, desired, shared, claude, codex, lock, raw, layer, run };
};

test('scoped disable backs up shared, copied/link exposures and raw lock while preserving all other metadata', async (t) => {
  const m = machine(t);
  const result = await m.run(Effect.gen(function* () {
    const outcome = yield* disableOwnedSkill(m.desired, 'tdd');
    return { outcome, backup: yield* (yield* Backups).dir };
  }));
  assert.equal(result.outcome.ok, true);
  for (const path of [m.shared, m.claude, m.codex]) assert.equal(existsSync(path), false);
  assert.deepEqual(JSON.parse(readFileSync(m.lock, 'utf8')), { version: 7, unknown: { keep: true }, skills: { other: { source: 'a/b' } } });
  for (const prefix of ['', 'claude', 'codex']) assert.equal(readFileSync(join(result.backup!, prefix, 'skills', 'tdd', 'SKILL.md'), 'utf8'), '# owned\n');
  assert.equal(readFileSync(join(result.backup!, '.skill-lock.json'), 'utf8'), m.raw);
});

for (const kind of ['foreign', 'local', 'ambiguous', 'unsafe', 'malformed', 'symlink-lock', 'external-exposure', 'copied-edits', 'file-mode', 'directory-mode', 'inner-link', 'shared-link', 'exposure-root-link']) {
  test(`${kind} blocks the whole disable and preserves shared/exposures/lock`, { skip: process.platform === 'win32' && ['file-mode', 'directory-mode'].includes(kind) }, async (t) => {
    const m = machine(t); let desired = m.desired, name = 'tdd';
    switch (kind) {
      case 'foreign': writeFileSync(m.lock, JSON.stringify({ skills: { tdd: { source: 'z/z' } } })); break;
      case 'local': writeFileSync(m.lock, '{"skills":{}}'); break;
      case 'ambiguous': desired = { ...desired, skills: [...desired.skills, ...desired.skills] }; break;
      case 'unsafe': name = '../escape'; desired = { ...desired, skills: [{ ...desired.skills[0]!, name }] }; break;
      case 'malformed': writeFileSync(m.lock, '{malformed'); break;
      case 'symlink-lock': { const target = join(m.home, 'external-lock'); writeFileSync(target, m.raw); rmSync(m.lock); symlinkSync(target, m.lock); break; }
      case 'external-exposure': { const target = join(m.home, 'external'); mkdirSync(target); writeFileSync(join(target, 'SKILL.md'), 'external'); rmSync(m.claude); symlinkSync(target, m.claude); break; }
      case 'copied-edits': writeFileSync(join(m.codex, 'SKILL.md'), 'locally changed'); break;
      case 'directory-mode': chmodSync(m.codex, 0o700); break;
      case 'file-mode': chmodSync(join(m.codex, 'SKILL.md'), 0o700); break;
      case 'inner-link': symlinkSync('../elsewhere', join(m.codex, 'link')); break;
      case 'shared-link': { const target = join(m.home, 'external-shared'); cpSync(m.shared, target, { recursive: true }); rmSync(m.shared, { recursive: true }); symlinkSync(target, m.shared); break; }
      case 'exposure-root-link': { const root = join(m.paths.codex, 'skills'), target = join(m.home, 'external-exposures'); cpSync(root, target, { recursive: true }); rmSync(root, { recursive: true }); symlinkSync(target, root); break; }
    }
    const before = readFileSync(m.lock, 'utf8');
    const ownership = await m.run(checkSkillOwnership(desired, name)); assert.equal(ownership.kind, 'blocked');
    const result = await m.run(disableOwnedSkill(desired, name)); assert.equal(result.ok, false);
    assert.equal(existsSync(m.shared), true); assert.equal(existsSync(m.claude), true); assert.equal(existsSync(m.codex), true);
    assert.equal(readFileSync(m.lock, 'utf8'), before);
  });
}

test('backup failure leaves all destinations and lock unchanged', async (t) => {
  const m = machine(t); let count = 0;
  const failure = new FsFailed({ op: 'copy', path: m.lock, reason: 'fixture' });
  const backups = Layer.succeed(Backups, { dir: Effect.succeed(undefined), moveAside: () => Effect.fail(failure),
    preserve: () => ++count === 3 ? Effect.fail(failure) : Effect.succeed('backup') });
  await assert.rejects(m.run(disableOwnedSkill(m.desired, 'tdd'), backups), /FsFailed/);
  assert.equal(readFileSync(m.lock, 'utf8'), m.raw);
  for (const path of [m.shared, m.claude, m.codex]) assert.equal(existsSync(path), true);
});

test('failed deletion retains lock and shared identity so a scoped retry finishes remaining exposures', async (t) => {
  const m = machine(t);
  const fault = Layer.effect(Fs, Effect.gen(function* () {
    const real = yield* Fs;
    return { ...real, remove: (path: string) => path === m.codex
      ? Effect.fail(new FsFailed({ op: 'remove', path, reason: 'fixture' })) : real.remove(path) };
  })).pipe(Layer.provide(nodeFs));
  const first = await m.run(disableOwnedSkill(m.desired, 'tdd'), fault);
  assert.equal(first.ok, false); assert.match(first.note!, /incomplete/);
  assert.equal(existsSync(m.claude), false); assert.equal(existsSync(m.shared), true);
  assert.equal(readFileSync(m.lock, 'utf8'), m.raw);
  const second = await m.run(disableOwnedSkill(m.desired, 'tdd')); assert.equal(second.ok, true);
  assert.equal(existsSync(m.shared), false);
});

test('failed atomic lock patch reports removed content and permits metadata-only retry', async (t) => {
  const m = machine(t);
  const fault = Layer.effect(Fs, Effect.gen(function* () {
    const real = yield* Fs;
    return { ...real, writeTextAtomic: (path: string, text: string) => path === m.lock
      ? Effect.fail(new FsFailed({ op: 'write', path, reason: 'fixture' })) : real.writeTextAtomic(path, text) };
  })).pipe(Layer.provide(nodeFs));
  const first = await m.run(disableOwnedSkill(m.desired, 'tdd'), fault);
  assert.equal(first.ok, false); assert.match(first.note!, /content removed/i);
  assert.equal(existsSync(m.shared), false); assert.equal(readFileSync(m.lock, 'utf8'), m.raw);
  const second = await m.run(disableOwnedSkill(m.desired, 'tdd')); assert.equal(second.ok, true);
});

test('fresh copied-exposure edits after preview block deletion', async (t) => {
  const m = machine(t); assert.equal((await m.run(checkSkillOwnership(m.desired, 'tdd'))).kind, 'owned');
  writeFileSync(join(m.codex, 'SKILL.md'), 'new local bytes');
  const result = await m.run(disableOwnedSkill(m.desired, 'tdd')); assert.equal(result.ok, false);
  assert.equal(readFileSync(m.lock, 'utf8'), m.raw); assert.equal(existsSync(m.shared), true);
});


test('native selector ownership removes its exact lock key and keeps unrelated metadata', async t => {
  const m = machine(t);
  const desired = { ...m.desired, skills: [{ ...m.desired.skills[0]!, targets: ['claude' as const] }] };
  const skills = { 'TDD': { source: 'o/r', sourceType: 'github', skillPath: 'skills/tdd', skillFolderHash: 'native-hash' }, other: { source: 'a/b' } };
  writeFileSync(m.lock, JSON.stringify({ version: 3, skills }));
  assert.equal((await m.run(checkSkillOwnership(desired, 'tdd'))).kind, 'owned');
  assert.equal((await m.run(disableOwnedSkill(desired, 'tdd'))).ok, true);
  assert.deepEqual(JSON.parse(readFileSync(m.lock, 'utf8')), { version: 3, skills: { other: skills.other } });
});

test('ambiguous native selector aliases block disable without deleting destinations', async t => {
  const m = machine(t);
  const desired = { ...m.desired, skills: [{ ...m.desired.skills[0]!, targets: ['claude' as const] }] };
  writeFileSync(m.lock, JSON.stringify({ skills: { tdd: { source: 'o/r' }, TDD: { source: 'o/r' } } }));
  assert.equal((await m.run(checkSkillOwnership(desired, 'tdd'))).kind, 'blocked');
  assert.equal((await m.run(disableOwnedSkill(desired, 'tdd'))).ok, false);
  for (const path of [m.shared, m.claude, m.codex]) assert.equal(existsSync(path), true);
});
