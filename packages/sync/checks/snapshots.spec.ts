import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pruneSnapshots, snapshotFor, SNAPSHOTS_KEPT } from '../src/index.ts';
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
  writeFileSync(join(stateRoot, 'snapshots', '.staging-crashed'), 'x');
  mkdirSync(join(stateRoot, 'snapshots', 'not-a-snapshot'));
  await runSync(pruneSnapshots(stateRoot, [repos[0]!]));
  const left = readdirSync(join(stateRoot, 'snapshots')).sort();
  assert.deepEqual(left, [repos[0]!, ...repos.slice(2)].map((r) => r.split(/[\\/]/).pop()!).concat('not-a-snapshot').sort());
  assert.equal(existsSync(join(stateRoot, 'snapshots', '.staging-crashed')), false);
});
