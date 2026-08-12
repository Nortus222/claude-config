import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'nortuscc-copy-'));
process.env.NORTUSCC_CLAUDE_DIR = join(home, '.claude');
process.env.NORTUSCC_STATE_DIR = join(home, 'state');
mkdirSync(process.env.NORTUSCC_CLAUDE_DIR, { recursive: true });

const { inspectCopy, applyCopy, captureCopy } = await import('../src/copy.mjs');
const { hashText, readLock, setBaseline } = await import('../src/lock.mjs');

let n = 0;
function pair(repoText, localText) {
  n += 1;
  const src = join(home, `repo-${n}.json`);
  const dest = join(process.env.NORTUSCC_CLAUDE_DIR, `local-${n}.json`);
  writeFileSync(src, repoText);
  if (localText !== null) writeFileSync(dest, localText);
  return { src, dest, rel: `local-${n}.json` };
}

test('repo-ahead applies and updates the baseline', () => {
  const { src, dest, rel } = pair('v2', 'v1');
  const lock = readLock();
  setBaseline(lock, rel, hashText('v1'));

  assert.equal(inspectCopy(src, dest, lock.files[rel].hash).state, 'repo-ahead');

  const res = applyCopy(src, dest, rel, lock, {});
  assert.equal(res.action, 'copied');
  assert.equal(readFileSync(dest, 'utf8'), 'v2');
  assert.equal(lock.files[rel].hash, hashText('v2'));
});

test('local-ahead is skipped by apply and taken by capture', () => {
  const { src, dest, rel } = pair('v1', 'v2');
  const lock = readLock();
  setBaseline(lock, rel, hashText('v1'));

  assert.equal(inspectCopy(src, dest, lock.files[rel].hash).state, 'local-ahead');

  assert.equal(applyCopy(src, dest, rel, lock, {}).action, 'skipped');
  assert.equal(readFileSync(dest, 'utf8'), 'v2', 'apply must not clobber a local edit');

  assert.equal(captureCopy(src, dest, rel, lock, {}).action, 'copied');
  assert.equal(readFileSync(src, 'utf8'), 'v2');
  assert.equal(lock.files[rel].hash, hashText('v2'));
});

test('a conflict is refused by both directions and backs the loser up', () => {
  const { src, dest, rel } = pair('repo-change', 'local-change');
  const lock = readLock();
  setBaseline(lock, rel, hashText('base'));

  assert.equal(inspectCopy(src, dest, lock.files[rel].hash).state, 'conflict');

  const a = applyCopy(src, dest, rel, lock, {});
  assert.equal(a.action, 'refused');
  assert.ok(a.backedUp, 'a refusal must still preserve the local file');
  assert.equal(readFileSync(a.backedUp, 'utf8'), 'local-change');
  assert.equal(readFileSync(dest, 'utf8'), 'local-change', 'refusing must change nothing');

  assert.equal(captureCopy(src, dest, rel, lock, {}).action, 'refused');
  assert.equal(readFileSync(src, 'utf8'), 'repo-change');
});

test('force resolves a conflict in the requested direction', () => {
  const { src, dest, rel } = pair('repo-change', 'local-change');
  const lock = readLock();
  setBaseline(lock, rel, hashText('base'));

  const res = applyCopy(src, dest, rel, lock, { force: true });
  assert.equal(res.action, 'copied');
  assert.equal(readFileSync(dest, 'utf8'), 'repo-change');
  assert.equal(lock.files[rel].hash, hashText('repo-change'));
});

test('unmanaged backs up the local file before first write', () => {
  const { src, dest, rel } = pair('from-repo', 'pre-existing');
  const lock = readLock();

  assert.equal(inspectCopy(src, dest, undefined).state, 'unmanaged');

  const res = applyCopy(src, dest, rel, lock, {});
  assert.equal(res.action, 'copied');
  assert.ok(res.backedUp);
  assert.equal(readFileSync(res.backedUp, 'utf8'), 'pre-existing');
  assert.equal(readFileSync(dest, 'utf8'), 'from-repo');
});

test('a clean file is skipped and nothing is rewritten', () => {
  const { src, dest, rel } = pair('same', 'same');
  const lock = readLock();
  setBaseline(lock, rel, hashText('same'));
  assert.equal(applyCopy(src, dest, rel, lock, {}).action, 'skipped');
});

test('a missing local file is restored by apply', () => {
  const { src, dest, rel } = pair('v1', null);
  const lock = readLock();
  setBaseline(lock, rel, hashText('v1'));
  assert.equal(applyCopy(src, dest, rel, lock, {}).action, 'copied');
  assert.equal(readFileSync(dest, 'utf8'), 'v1');
});

test('capture backs up the repo file before first write', () => {
  const { src, dest, rel } = pair('repo-original', 'local-content');
  const lock = readLock();

  assert.equal(inspectCopy(src, dest, undefined).state, 'unmanaged');

  const res = captureCopy(src, dest, rel, lock, {});
  assert.equal(res.action, 'copied');
  assert.ok(res.backedUp, 'overwriting the repo file must back it up');
  assert.equal(readFileSync(res.backedUp, 'utf8'), 'repo-original');
  assert.equal(readFileSync(src, 'utf8'), 'local-content');
});

test('a genuinely clean apply run leaves the lock entry untouched', () => {
  const { src, dest, rel } = pair('same', 'same');
  const lock = readLock();
  setBaseline(lock, rel, hashText('same'));
  const before = lock.files[rel];

  assert.equal(applyCopy(src, dest, rel, lock, {}).action, 'skipped');
  assert.equal(lock.files[rel], before, 'a clean run must not restamp the baseline');
});

test('a convergent apply run refreshes a stale baseline', () => {
  const { src, dest, rel } = pair('converged', 'converged');
  const lock = readLock();
  setBaseline(lock, rel, hashText('old-baseline'));

  assert.equal(applyCopy(src, dest, rel, lock, {}).action, 'skipped');
  assert.equal(lock.files[rel].hash, hashText('converged'), 'baseline must refresh on convergence');
});

test('a genuinely clean capture run leaves the lock entry untouched', () => {
  const { src, dest, rel } = pair('same', 'same');
  const lock = readLock();
  setBaseline(lock, rel, hashText('same'));
  const before = lock.files[rel];

  assert.equal(captureCopy(src, dest, rel, lock, {}).action, 'skipped');
  assert.equal(lock.files[rel], before, 'a clean run must not restamp the baseline');
});

test('a convergent capture run refreshes a stale baseline', () => {
  const { src, dest, rel } = pair('converged', 'converged');
  const lock = readLock();
  setBaseline(lock, rel, hashText('old-baseline'));

  assert.equal(captureCopy(src, dest, rel, lock, {}).action, 'skipped');
  assert.equal(lock.files[rel].hash, hashText('converged'), 'baseline must refresh on convergence');
});
