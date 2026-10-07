import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import {
  emptyState, hashText, machinePaths, nodeFs, parseState, StateStore, stateStore, withApplied, withBaseline, withoutBaseline,
} from '../src/index.ts';

const machine = () => {
  const home = mkdtempSync(join(tmpdir(), 'machine-state-'));
  const paths = {
    repo: join(home, 'repo'), claude: join(home, '.claude'), codex: join(home, '.codex'),
    codexOpenRouter: join(home, '.codex-openrouter'), agentsSkills: join(home, '.agents', 'skills'),
    stateRoot: join(home, 'state'), backups: join(home, 'state', 'backups'),
  };
  const layer = stateStore.pipe(Layer.provide(Layer.mergeAll(machinePaths(paths), nodeFs)));
  const run = <A, E>(f: (store: StateStore['Service']) => Effect.Effect<A, E>) =>
    Effect.runPromise(StateStore.use(f).pipe(Effect.provide(layer)));
  return { paths, run };
};

test('hashText is prefixed and ignores CRLF', () => {
  assert.match(hashText('a'), /^sha256:[0-9a-f]{64}$/);
  assert.equal(hashText('a\r\nb'), hashText('a\nb'));
});

test('a bare machine reads as empty state', async () => {
  const { run } = machine();
  assert.deepEqual(await run((s) => s.read), emptyState);
});

test('a malformed state file reads as empty and is not migrated over', async () => {
  const { paths, run } = machine();
  mkdirSync(paths.stateRoot, { recursive: true });
  writeFileSync(join(paths.stateRoot, 'state.json'), '{"files": []}');
  mkdirSync(paths.claude, { recursive: true });
  writeFileSync(join(paths.claude, '.nortuscc-lock.json'), JSON.stringify({ repo: '/r', files: {} }));
  assert.deepEqual(await run((s) => s.read), emptyState);
});

test('the legacy lock migrates once, carrying repo and the CLAUDE.md baseline only', async () => {
  const { paths, run } = machine();
  mkdirSync(paths.claude, { recursive: true });
  const baseline = { hash: 'sha256:1', appliedAt: '2026-01-01T00:00:00.000Z' };
  const lockText = JSON.stringify({ repo: '/r', files: { 'CLAUDE.md': baseline, 'settings.json': baseline } });
  writeFileSync(join(paths.claude, '.nortuscc-lock.json'), lockText);
  const state = await run((s) => s.read);
  assert.equal(state.repo, '/r');
  assert.deepEqual(state.files, { 'claude:CLAUDE.md': baseline });
  assert.ok(existsSync(join(paths.stateRoot, 'state.json')));
  assert.equal(readFileSync(join(paths.claude, '.nortuscc-lock.json'), 'utf8'), lockText);
});

test('a corrupt legacy lock is skipped: empty state, nothing written', async () => {
  const { paths, run } = machine();
  mkdirSync(paths.claude, { recursive: true });
  writeFileSync(join(paths.claude, '.nortuscc-lock.json'), '{ broken');
  assert.deepEqual(await run((s) => s.read), emptyState);
  assert.equal(existsSync(join(paths.stateRoot, 'state.json')), false);
});

test('parseState drops the legacy machine choices', () => {
  assert.deepEqual(
    parseState(JSON.stringify({ repo: '/r', skillsOnly: true, configTargets: ['codex'], files: {} })),
    { version: 1, repo: '/r', files: {} },
  );
  assert.equal(parseState('[]'), undefined);
});

const legacyState = { version: 1, repo: null, skillsOnly: true, configTargets: ['codex'], files: {} };
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

test('the first state write migrates the legacy choices into overrides.json', async () => {
  const { paths, run } = machine();
  mkdirSync(paths.stateRoot, { recursive: true });
  writeFileSync(join(paths.stateRoot, 'state.json'), JSON.stringify(legacyState));
  await run((s) => s.update((state) => state));
  const overridesText = readFileSync(join(paths.stateRoot, 'overrides.json'), 'utf8');
  assert.ok(overridesText.endsWith('}\n'));
  assert.deepEqual(JSON.parse(overridesText), { version: 1, manageConfig: false, configTargets: ['codex'] });
  assert.deepEqual(readJson(join(paths.stateRoot, 'state.json')), { version: 1, repo: null, files: {} });
});

test('an existing overrides.json is left alone and state.json still loses the legacy choices', async () => {
  const { paths, run } = machine();
  mkdirSync(paths.stateRoot, { recursive: true });
  writeFileSync(join(paths.stateRoot, 'state.json'), JSON.stringify(legacyState));
  writeFileSync(join(paths.stateRoot, 'overrides.json'), '{"version":1}');
  await run((s) => s.update((state) => state));
  assert.equal(readFileSync(join(paths.stateRoot, 'overrides.json'), 'utf8'), '{"version":1}');
  assert.deepEqual(readJson(join(paths.stateRoot, 'state.json')), { version: 1, repo: null, files: {} });
});

test('a state write without legacy choices creates no overrides.json', async () => {
  const { paths, run } = machine();
  mkdirSync(paths.stateRoot, { recursive: true });
  writeFileSync(join(paths.stateRoot, 'state.json'), JSON.stringify({ version: 1, repo: null, files: {} }));
  await run((s) => s.update((state) => state));
  assert.equal(existsSync(join(paths.stateRoot, 'overrides.json')), false);
});

test('reading state never creates overrides.json', async () => {
  const { paths, run } = machine();
  mkdirSync(paths.stateRoot, { recursive: true });
  writeFileSync(join(paths.stateRoot, 'state.json'), JSON.stringify(legacyState));
  assert.deepEqual(await run((s) => s.read), { version: 1, repo: null, files: {} });
  assert.equal(existsSync(join(paths.stateRoot, 'overrides.json')), false);
});

test('update writes the legacy layout and baselines round-trip', async () => {
  const { paths, run } = machine();
  const now = new Date('2026-10-05T00:00:00.000Z');
  await run((s) => s.update((state) => withBaseline(withBaseline(state, 'claude:CLAUDE.md', 'sha256:a', now), 'x', 'sha256:b', now)));
  await run((s) => s.update((state) => withoutBaseline(state, 'x')));
  const text = readFileSync(join(paths.stateRoot, 'state.json'), 'utf8');
  assert.ok(text.endsWith('}\n'));
  assert.deepEqual(JSON.parse(text), {
    version: 1, repo: null,
    files: { 'claude:CLAUDE.md': { hash: 'sha256:a', appliedAt: '2026-10-05T00:00:00.000Z' } },
  });
});

const APPLIED = 'c'.repeat(40);

test('applied is written, read back, and kept by later baseline writes', async () => {
  const { paths, run } = machine();
  await run((s) => s.write(withApplied(emptyState, APPLIED, new Date('2026-10-07T00:00:00.000Z'))));
  await run((s) => s.update((state) => withBaseline(state, 'claude:CLAUDE.md', 'sha256:1')));
  const written = JSON.parse(readFileSync(join(paths.stateRoot, 'state.json'), 'utf8'));
  assert.deepEqual(written.applied, { commit: APPLIED, at: '2026-10-07T00:00:00.000Z' });
  assert.deepEqual((await run((s) => s.read)).applied, written.applied);
});

test('a state with no applied commit writes none', async () => {
  const { paths, run } = machine();
  await run((s) => s.write(emptyState));
  assert.equal('applied' in JSON.parse(readFileSync(join(paths.stateRoot, 'state.json'), 'utf8')), false);
});

test('a malformed applied record is dropped and the rest of the state kept', () => {
  for (const applied of [{ commit: 'main', at: '2026-10-07T00:00:00.000Z' }, { commit: APPLIED, at: 'yesterday' }, 'abc']) {
    assert.deepEqual(parseState(JSON.stringify({ version: 1, repo: '/r', files: {}, applied })), { version: 1, repo: '/r', files: {} });
  }
});

test('a SHA-256 applied commit is accepted', () => {
  const applied = { commit: 'd'.repeat(64), at: '2026-10-07T00:00:00.000Z' };
  assert.deepEqual(parseState(JSON.stringify({ version: 1, repo: null, files: {}, applied }))?.applied, applied);
});
