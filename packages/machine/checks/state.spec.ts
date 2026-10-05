import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import {
  emptyState, hashText, machinePaths, nodeFs, parseState, StateStore, stateStore, withBaseline, withoutBaseline,
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
  writeFileSync(join(paths.claude, '.nortuscc-lock.json'), JSON.stringify({ repo: '/r', files: { 'CLAUDE.md': baseline, 'settings.json': baseline } }));
  const state = await run((s) => s.read);
  assert.equal(state.repo, '/r');
  assert.deepEqual(state.files, { 'claude:CLAUDE.md': baseline });
  assert.ok(existsSync(join(paths.stateRoot, 'state.json')));
  assert.ok(existsSync(join(paths.claude, '.nortuscc-lock.json')));
});

test('skillsOnly is strict and configTargets is kept only when valid', () => {
  assert.equal(parseState(JSON.stringify({ skillsOnly: 'yes', files: {} }))!.skillsOnly, false);
  assert.deepEqual(parseState(JSON.stringify({ configTargets: ['codex', 'codex'], files: {} }))!.configTargets, ['codex']);
  assert.equal(parseState(JSON.stringify({ configTargets: ['nope'], files: {} }))!.configTargets, undefined);
  assert.equal(parseState('[]'), undefined);
});

test('update writes the legacy layout and baselines round-trip', async () => {
  const { paths, run } = machine();
  const now = new Date('2026-10-05T00:00:00.000Z');
  await run((s) => s.update((state) => withBaseline(withBaseline(state, 'claude:CLAUDE.md', 'sha256:a', now), 'x', 'sha256:b', now)));
  await run((s) => s.update((state) => withoutBaseline(state, 'x')));
  const text = readFileSync(join(paths.stateRoot, 'state.json'), 'utf8');
  assert.ok(text.endsWith('}\n'));
  assert.deepEqual(JSON.parse(text), {
    version: 1, repo: null, skillsOnly: false,
    files: { 'claude:CLAUDE.md': { hash: 'sha256:a', appliedAt: '2026-10-05T00:00:00.000Z' } },
  });
});
