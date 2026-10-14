import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { Backups, backupsForRun, machinePaths, nodeFs, OverridesStore, overridesStore } from '../src/index.ts';

const machine = () => {
  const home = mkdtempSync(join(tmpdir(), 'machine-overrides-'));
  const stateRoot = join(home, 'state');
  mkdirSync(stateRoot, { recursive: true });
  const paths = {
    repo: join(home, 'repo'), claude: join(home, '.claude'), codex: join(home, '.codex'),
    codexOpenRouter: join(home, '.codex-openrouter'), agentsSkills: join(home, '.agents', 'skills'),
    stateRoot, backups: join(stateRoot, 'backups'),
  };
  const services = Layer.mergeAll(machinePaths(paths), nodeFs);
  const layer = Layer.mergeAll(overridesStore, backupsForRun()).pipe(Layer.provide(services));
  const run = <A, E>(f: (store: OverridesStore['Service']) => Effect.Effect<A, E, Backups>) =>
    Effect.runPromise(OverridesStore.use(f).pipe(Effect.provide(layer)));
  const readWithoutBackups = () => Effect.runPromise(OverridesStore.use(store => store.read).pipe(
    Effect.provide(overridesStore.pipe(Layer.provide(services))),
  ));
  return { paths, stateRoot, run, readWithoutBackups };
};

test('without overrides.json the legacy state fields are read', async () => {
  const { stateRoot, run } = machine();
  writeFileSync(join(stateRoot, 'state.json'), JSON.stringify({ skillsOnly: true, configTargets: ['codex'], files: {} }));
  const overrides = await run((s) => s.read);
  assert.deepEqual(overrides.value, { manageConfig: false, configTargets: ['codex'] });
  assert.equal(overrides.source, join(stateRoot, 'state.json'));
});

test('overrides.json wins over the legacy fields', async () => {
  const { stateRoot, run } = machine();
  writeFileSync(join(stateRoot, 'state.json'), JSON.stringify({ skillsOnly: true, files: {} }));
  writeFileSync(join(stateRoot, 'overrides.json'), JSON.stringify({ version: 1, skills: { tdd: false } }));
  const overrides = await run((s) => s.read);
  assert.deepEqual(overrides.value, { skills: { tdd: false } });
  assert.deepEqual(overrides.issues, []);
});

test('invalid JSON is one issue and no overrides, not a legacy fallback', async () => {
  const { stateRoot, run } = machine();
  writeFileSync(join(stateRoot, 'state.json'), JSON.stringify({ skillsOnly: true, files: {} }));
  writeFileSync(join(stateRoot, 'overrides.json'), '{oops');
  const overrides = await run((s) => s.read);
  assert.deepEqual(overrides.value, {});
  assert.equal(overrides.issues.length, 1);
  assert.equal(overrides.issues[0]!.layer, 'machine');
  assert.equal(overrides.issues[0]!.source, join(stateRoot, 'overrides.json'));
});

test('an unknown field is reported by the engine decoder', async () => {
  const { stateRoot, run } = machine();
  writeFileSync(join(stateRoot, 'overrides.json'), JSON.stringify({ version: 1, colour: 'blue' }));
  const overrides = await run((s) => s.read);
  assert.deepEqual(overrides.value, {});
  assert.equal(overrides.issues.length, 1);
});

test('write stamps the version and leaves state.json alone', async () => {
  const { stateRoot, run } = machine();
  const legacy = JSON.stringify({ skillsOnly: true, configTargets: ['codex'], files: {} });
  writeFileSync(join(stateRoot, 'state.json'), legacy);
  await run((s) => s.write({ manageConfig: false, configTargets: ['codex'] }));
  assert.deepEqual(JSON.parse(readFileSync(join(stateRoot, 'overrides.json'), 'utf8')), { version: 1, manageConfig: false, configTargets: ['codex'] });
  assert.equal(readFileSync(join(stateRoot, 'state.json'), 'utf8'), legacy);
});

test('version 2 writes preserve unknown fields and privately back up original bytes', async () => {
  const { stateRoot, run } = machine();
  const path = join(stateRoot, 'overrides.json');
  const original = '{ "version": 2, "future": { "value": 7 }, "skills": { "personal": false } }';
  writeFileSync(path, original);
  await run(s => s.write({ skillAdditions: [{ source: 'Owner/Repo', name: 'personal', targets: ['claude'] }], skills: { personal: true } }));
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 2, future: { value: 7 }, skills: { personal: true },
    skillAdditions: [{ source: 'owner/repo', name: 'personal', targets: ['claude'] }] });
  const backupRoot = join(stateRoot, 'backups');
  const backup = join(backupRoot, readdirSync(backupRoot)[0]!, 'overrides.json');
  assert.equal(readFileSync(backup, 'utf8'), original);
  assert.equal(statSync(backup).mode & 0o777, 0o600);
});

test('replacement and version migration preserve version 1 bytes', async () => {
  for (const additions of [false, true]) {
    const { stateRoot, run } = machine();
    const path = join(stateRoot, 'overrides.json');
    const original = '{ "version": 1, "manageConfig": false }';
    writeFileSync(path, original);
    await run(s => s.write(additions ? { skillAdditions: [{ source: 'a/b', name: 'personal', targets: ['codex'] }] } : { manageConfig: true }));
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, additions ? 2 : 1);
    const root = join(stateRoot, 'backups');
    assert.equal(readFileSync(join(root, readdirSync(root)[0]!, 'overrides.json'), 'utf8'), original);
  }
});

test('malformed current or proposed documents refuse writes and preserve bytes', async () => {
  for (const original of ['{oops', '{"version":1,"future":true}', '{"version":2,"skills":{"x":"yes"}}']) {
    const { stateRoot, run } = machine();
    const path = join(stateRoot, 'overrides.json');
    writeFileSync(path, original);
    await assert.rejects(run(s => s.write({ manageConfig: false })));
    assert.equal(readFileSync(path, 'utf8'), original);
  }
  const { stateRoot, run } = machine();
  const path = join(stateRoot, 'overrides.json');
  const original = '{"version":2,"future":true}';
  writeFileSync(path, original);
  await assert.rejects(run(s => s.write({ skillAdditions: [{ source: '/tmp/repo', name: 'bad', targets: [] }] })));
  assert.equal(readFileSync(path, 'utf8'), original);
});

test('a read-only store needs no Backups provider', async () => {
  const { stateRoot, readWithoutBackups } = machine();
  writeFileSync(join(stateRoot, 'overrides.json'), '{"version":2,"skillAdditions":[],"future":true}');
  assert.deepEqual((await readWithoutBackups()).value, { skillAdditions: [] });
});

test('an edit during backup is refused without replacing the new document', async () => {
  const { paths, stateRoot } = machine();
  const path = join(stateRoot, 'overrides.json');
  writeFileSync(path, '{"version":1}');
  const edited = '{"version":2,"future":true}';
  const services = Layer.mergeAll(machinePaths(paths), nodeFs);
  const backup = Layer.succeed(Backups, {
    dir: Effect.succeed(undefined), moveAside: () => Effect.succeed(undefined),
    preserve: () => Effect.sync(() => { writeFileSync(path, edited); return undefined; }),
  });
  await assert.rejects(Effect.runPromise(OverridesStore.use(s => s.write({ manageConfig: false })).pipe(
    Effect.provide(Layer.mergeAll(overridesStore, backup).pipe(Layer.provide(services))),
  )));
  assert.equal(readFileSync(path, 'utf8'), edited);
});
