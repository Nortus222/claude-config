import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { machinePaths, nodeFs, OverridesStore, overridesStore } from '../src/index.ts';

const machine = () => {
  const home = mkdtempSync(join(tmpdir(), 'machine-overrides-'));
  const stateRoot = join(home, 'state');
  mkdirSync(stateRoot, { recursive: true });
  const paths = {
    repo: join(home, 'repo'), claude: join(home, '.claude'), codex: join(home, '.codex'),
    codexOpenRouter: join(home, '.codex-openrouter'), agentsSkills: join(home, '.agents', 'skills'),
    stateRoot, backups: join(stateRoot, 'backups'),
  };
  const layer = overridesStore.pipe(Layer.provide(Layer.mergeAll(machinePaths(paths), nodeFs)));
  const run = <A, E>(f: (store: OverridesStore['Service']) => Effect.Effect<A, E>) =>
    Effect.runPromise(OverridesStore.use(f).pipe(Effect.provide(layer)));
  return { stateRoot, run };
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
