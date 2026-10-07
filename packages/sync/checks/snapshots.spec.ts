import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pruneSnapshots, SNAPSHOT_FORMAT, snapshotFor, snapshotKey, SNAPSHOTS_KEPT, STALE_STAGING_MS } from '../src/index.ts';
import { runSync, tempRepo } from './support/repo.ts';

const NONE = { value: {}, source: 'overrides.json', issues: [] };
const EFFORT = 'setting:claude:settings.json#effortLevel';

test('a snapshot is keyed by commit and holds, and reused', async () => {
  const repo = tempRepo();
  const stateRoot = join(repo.root, 'state');
  const input = { repo: repo.dir, stateRoot, commit: repo.first, held: {}, overrides: NONE };
  const first = await runSync(snapshotFor({ ...input, now: new Date('2026-10-07T00:00:00.000Z') }));
  assert.equal(first.repo.startsWith(join(stateRoot, 'snapshots')), true);
  writeFileSync(join(first.repo, 'claude/CLAUDE.md'), '# touched\n');
  const again = await runSync(snapshotFor({ ...input, now: new Date('2026-10-07T01:00:00.000Z') }));
  assert.equal(again.repo, first.repo);
  assert.equal(readFileSync(join(again.repo, 'claude/CLAUDE.md'), 'utf8'), '# touched\n');
  assert.equal(JSON.parse(readFileSync(join(again.repo, '.snapshot.json'), 'utf8')).usedAt, '2026-10-07T01:00:00.000Z');
  const held = await runSync(snapshotFor({ ...input, held: { [EFFORT]: repo.first }, now: new Date() }));
  assert.notEqual(held.repo, first.repo);
});

test(`pruning keeps the ${SNAPSHOTS_KEPT} most recently used, the ones in use, and no staging leftovers, and nothing it did not create`, async () => {
  const repo = tempRepo();
  const stateRoot = join(repo.root, 'state');
  const repos: string[] = [];
  for (let i = 0; i < 7; i++) {
    const commit = repo.commit({ 'claude/CLAUDE.md': `# ${i}\n` });
    const snapshot = await runSync(snapshotFor({
      repo: repo.dir, stateRoot, commit, held: {}, overrides: NONE, now: new Date(Date.UTC(2026, 9, 7, i)),
    }));
    repos.push(snapshot.repo);
  }
  const now = new Date(Date.UTC(2026, 9, 8));
  const crashed = `.staging-${'0'.repeat(32)}-${now.getTime() - 2 * STALE_STAGING_MS}-${randomUUID()}`;
  mkdirSync(join(stateRoot, 'snapshots', crashed));
  mkdirSync(join(stateRoot, 'snapshots', 'not-a-snapshot'));
  await runSync(pruneSnapshots(stateRoot, [repos[0]!], now));
  const left = readdirSync(join(stateRoot, 'snapshots')).sort();
  assert.deepEqual(left, [repos[0]!, ...repos.slice(2)].map((r) => r.split(/[\\/]/).pop()!).concat('not-a-snapshot').sort());
  assert.equal(existsSync(join(stateRoot, 'snapshots', crashed)), false);
});

test('the snapshot key covers the composition format, so a new format never reuses old folders', async () => {
  const repo = tempRepo();
  const stateRoot = join(repo.root, 'state');
  const key = { commit: repo.first, held: {} };
  const snapshot = await runSync(snapshotFor({ ...key, repo: repo.dir, stateRoot, overrides: NONE, now: new Date() }));
  assert.equal(snapshot.repo, join(stateRoot, 'snapshots', snapshotKey(key)));
  assert.notEqual(snapshotKey(key, SNAPSHOT_FORMAT + 1), snapshotKey(key));
});

test('pruning removes only a staging folder older than the stale age, never a fresh or undated one', async () => {
  const repo = tempRepo();
  const stateRoot = join(repo.root, 'state');
  const root = join(stateRoot, 'snapshots');
  const now = new Date('2026-10-07T12:00:00.000Z');
  const key = snapshotKey({ commit: repo.first, held: {} });
  const fresh = `.staging-${key}-${now.getTime()}-${randomUUID()}`;
  const old = `.staging-${key}-${now.getTime() - 2 * 60 * 60 * 1000}-${randomUUID()}`;
  const legacy = `.staging-${key}-${randomUUID()}`;
  for (const name of [fresh, old, legacy]) mkdirSync(join(root, name), { recursive: true });
  await runSync(pruneSnapshots(stateRoot, [], now));
  assert.deepEqual(readdirSync(root).sort(), [fresh, legacy].sort());
});
