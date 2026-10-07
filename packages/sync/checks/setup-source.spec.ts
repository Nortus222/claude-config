import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Effect } from 'effect';
import type { Decision, MachinePathsValue } from '@nortuscc/machine';
import { normalizeRepoUrl, SetupSource, setupSourceLayer } from '../src/index.ts';
import { json, tempSetup } from './support/repo.ts';

const EFFORT = 'setting:claude:settings.json#effortLevel';

const setup = () => {
  const s = tempSetup();
  const stateRoot = join(s.root, 'state');
  const paths: MachinePathsValue = {
    repo: s.checkout, claude: join(s.root, '.claude'), codex: join(s.root, '.codex'), codexOpenRouter: join(s.root, '.codex-openrouter'),
    agentsSkills: join(s.root, '.agents'), stateRoot, backups: join(stateRoot, 'backups'),
  };
  const write = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  const trust = (repoUrl: string | null) =>
    write(join(stateRoot, 'agent', 'setups.json'), json({ version: 1, setups: [{ setupId: null, repoUrl, checkout: s.checkout, trustedAt: '2026-10-07T00:00:00.000Z' }] }));
  const source = <A, E>(f: (service: SetupSource['Service']) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.result(SetupSource.use(f)).pipe(Effect.provide(setupSourceLayer(paths))));
  const tracked = () => s.inCheckout('rev-parse', 'refs/remotes/origin/main');
  return { ...s, stateRoot, write, trust, source, tracked };
};

const accept = (itemId: string, commit: string): Decision => ({
  setupId: 'local', itemId, revision: null, commit, decision: 'accept', decidedAt: '2026-10-07T00:00:00.000Z', machineId: null, source: 'local',
});

test('fetch refuses an origin that is not the trusted repository, and fetches nothing', async () => {
  const s = setup();
  s.trust('github.com/someone/else');
  s.push({ 'claude/CLAUDE.md': '# newer\n' });
  const fetched = await s.source((source) => source.fetch);
  assert.ok(fetched._tag === 'Failure');
  assert.equal(fetched.failure._tag, 'RevisionUnavailable');
  assert.equal(s.tracked(), s.first);
});

test('fetch moves only the tracked remote ref: never HEAD or the working tree', async () => {
  const s = setup();
  s.trust(normalizeRepoUrl(s.origin));
  const pushed = s.push({ 'claude/CLAUDE.md': '# newer\n' });
  writeFileSync(join(s.checkout, 'claude/CLAUDE.md'), '# being edited\n');
  const fetched = await s.source((source) => source.fetch);
  assert.ok(fetched._tag === 'Success');
  assert.equal(fetched.success.head, pushed);
  assert.equal(s.tracked(), pushed);
  assert.equal(s.inCheckout('rev-parse', 'HEAD'), s.first);
  assert.equal(readFileSync(join(s.checkout, 'claude/CLAUDE.md'), 'utf8'), '# being edited\n');
});

test('load refuses a commit that is not on the tracked branch', async () => {
  const s = setup();
  s.trust(normalizeRepoUrl(s.origin));
  s.inCheckout('checkout', '-q', '-b', 'side');
  writeFileSync(join(s.checkout, 'claude/CLAUDE.md'), '# side\n');
  s.inCheckout('commit', '-qam', 'side');
  const side = s.inCheckout('rev-parse', 'HEAD');
  s.inCheckout('checkout', '-q', 'main');
  const loaded = await s.source((source) => source.load(side));
  assert.ok(loaded._tag === 'Failure');
  assert.equal(loaded.failure._tag, 'RevisionMismatch');
});

test('load of a missing object is RevisionUnavailable', async () => {
  const s = setup();
  s.trust(normalizeRepoUrl(s.origin));
  const loaded = await s.source((source) => source.load('f'.repeat(40)));
  assert.ok(loaded._tag === 'Failure');
  assert.equal(loaded.failure._tag, 'RevisionUnavailable');
});

test('load composes a verified commit from git objects into a snapshot folder', async () => {
  const s = setup();
  s.trust(normalizeRepoUrl(s.origin));
  const pushed = s.push({ 'claude/CLAUDE.md': '# newer\n' });
  await s.source((source) => source.fetch);
  const loaded = await s.source((source) => source.load(pushed));
  assert.ok(loaded._tag === 'Success');
  assert.equal(loaded.success.repo.startsWith(join(s.stateRoot, 'snapshots')), true);
  assert.equal(readFileSync(join(loaded.success.repo, 'claude/CLAUDE.md'), 'utf8'), '# newer\n');
});

test('effective takes accepted items at head, holds undecided ones at the applied commit, and lists accepted conflicts', async () => {
  const s = setup();
  s.trust(normalizeRepoUrl(s.origin));
  const head = s.push({ 'claude/settings.keys.json': json({ theme: 'light', effortLevel: 'medium' }) });
  await s.source((source) => source.fetch);
  s.write(join(s.stateRoot, 'state.json'), json({ version: 1, repo: null, files: {}, applied: { commit: s.first, at: '2026-10-07T00:00:00.000Z' } }));
  s.write(join(s.stateRoot, 'overrides.json'), json({ version: 1, settings: { 'claude:settings.json': { effortLevel: 'max' } } }));
  const resolved = await s.source((source) => source.effective([accept(EFFORT, head)]));
  assert.ok(resolved._tag === 'Success');
  const { applied, effective, conflicts } = resolved.success;
  const keysAt = (repo: string) => JSON.parse(readFileSync(join(repo, 'claude/settings.keys.json'), 'utf8'));
  assert.equal(applied.revision, s.first);
  assert.deepEqual(keysAt(applied.repo), { theme: 'auto', effortLevel: 'high' });
  assert.deepEqual(keysAt(effective.repo), { theme: 'auto', effortLevel: 'medium' });
  assert.deepEqual(conflicts, [EFFORT]);
  assert.equal(readdirSync(join(s.stateRoot, 'snapshots')).length, 2);
});

test('effective without a recorded applied commit measures from the checkout HEAD', async () => {
  const s = setup();
  s.trust(normalizeRepoUrl(s.origin));
  s.push({ 'claude/CLAUDE.md': '# newer\n' });
  await s.source((source) => source.fetch);
  const resolved = await s.source((source) => source.effective([]));
  assert.ok(resolved._tag === 'Success');
  assert.equal(resolved.success.applied.revision, s.first);
  assert.equal(readFileSync(join(resolved.success.effective.repo, 'claude/CLAUDE.md'), 'utf8'), '# rules\n');
});

const failsUnavailable = (result: { readonly _tag: string; readonly failure?: { readonly _tag: string } }) => {
  assert.equal(result._tag, 'Failure');
  assert.equal(result.failure?._tag, 'RevisionUnavailable');
};

test('fetch refuses a setup that is not trusted, or trusts no repository', async () => {
  const s = setup();
  s.push({ 'claude/CLAUDE.md': '# newer\n' });
  failsUnavailable(await s.source((source) => source.fetch));
  s.trust(null);
  failsUnavailable(await s.source((source) => source.fetch));
  assert.equal(s.tracked(), s.first);
});

test('fetch refuses a branch that tracks a remote other than origin', async () => {
  const s = setup();
  s.trust(normalizeRepoUrl(s.origin));
  s.inCheckout('remote', 'add', 'mirror', s.origin);
  s.inCheckout('fetch', '-q', 'mirror');
  s.inCheckout('branch', '-q', '--set-upstream-to=mirror/main');
  failsUnavailable(await s.source((source) => source.fetch));
});

test('load refuses a local commit that was never pushed', async () => {
  const s = setup();
  s.trust(normalizeRepoUrl(s.origin));
  writeFileSync(join(s.checkout, 'claude/CLAUDE.md'), '# local\n');
  s.inCheckout('commit', '-qam', 'local');
  const loaded = await s.source((source) => source.load(s.inCheckout('rev-parse', 'HEAD')));
  assert.ok(loaded._tag === 'Failure');
  assert.equal(loaded.failure._tag, 'RevisionMismatch');
});

test('effective refuses an origin that is not the trusted repository, even with a fetched ref', async () => {
  const s = setup();
  s.push({ 'claude/CLAUDE.md': '# newer\n' });
  s.inCheckout('fetch', '-q', 'origin');
  s.trust('github.com/someone/else');
  failsUnavailable(await s.source((source) => source.effective([])));
  s.trust(null);
  failsUnavailable(await s.source((source) => source.effective([])));
});

test('effective reads state.json without writing, and fails on one it cannot parse', async () => {
  const s = setup();
  s.trust(normalizeRepoUrl(s.origin));
  const legacy = json({ version: 1, repo: null, files: { 'settings.json': { hash: 'x', appliedAt: '2026-10-07T00:00:00.000Z' } } });
  s.write(join(s.root, '.claude', '.nortuscc-lock.json'), legacy);
  const resolved = await s.source((source) => source.effective([]));
  assert.ok(resolved._tag === 'Success');
  assert.equal(existsSync(join(s.stateRoot, 'state.json')), false);
  s.write(join(s.stateRoot, 'state.json'), '{ not json');
  await assert.rejects(s.source((source) => source.effective([])));
  assert.equal(readFileSync(join(s.stateRoot, 'state.json'), 'utf8'), '{ not json');
});

test('fetch refuses an own entry for another checkout, even with the trusted origin', async () => {
  const s = setup();
  s.write(join(s.stateRoot, 'agent', 'setups.json'), json({
    version: 1, setups: [{ setupId: null, repoUrl: normalizeRepoUrl(s.origin), checkout: join(s.root, 'elsewhere'), trustedAt: '2026-10-07T00:00:00.000Z' }],
  }));
  s.push({ 'claude/CLAUDE.md': '# newer\n' });
  failsUnavailable(await s.source((source) => source.fetch));
  assert.equal(s.tracked(), s.first);
});

test('current is the checkout HEAD with holds applied, and needs no trust', async () => {
  const s = setup();
  writeFileSync(join(s.checkout, 'claude/settings.keys.json'), json({ theme: 'light', effortLevel: 'medium' }));
  s.inCheckout('commit', '-qam', 'local');
  s.write(join(s.stateRoot, 'sync.json'), json({ version: 1, held: { [EFFORT]: s.first } }));
  const current = await s.source((source) => source.current);
  assert.ok(current._tag === 'Success');
  assert.equal(current.success.repo.startsWith(join(s.stateRoot, 'snapshots')), true);
  assert.deepEqual(JSON.parse(readFileSync(join(current.success.repo, 'claude/settings.keys.json'), 'utf8')), { theme: 'light', effortLevel: 'high' });
  assert.equal(existsSync(join(s.stateRoot, 'agent', 'setups.json')), false);
});

test('local source never grants hosted tag provenance merely from a reachable commit', async () => {
  const s = setup(); s.trust(normalizeRepoUrl(s.origin));
  const record = { setupId: 'hosted-1', number: 1, commitSha: s.first, tag: 'absent', changelog: '', requiredEnv: [], items: [] };
  const result = await s.source((source) => source.load(record));
  assert.ok(result._tag === 'Failure');
  assert.equal(result.failure._tag, 'RevisionMismatch');
});
