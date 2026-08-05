import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'nortuscc-lock-'));
process.env.NORTUSCC_CLAUDE_DIR = dir;

const { hashFile, hashText, readLock, writeLock, setBaseline } = await import('../src/lock.mjs');

test('hashText is stable and prefixed', () => {
  const h = hashText('hello');
  assert.match(h, /^sha256:[0-9a-f]{64}$/);
  assert.equal(h, hashText('hello'));
});

test('CRLF and LF hash identically', () => {
  assert.equal(hashText('a\r\nb\r\n'), hashText('a\nb\n'));
});

test('different content hashes differently', () => {
  assert.notEqual(hashText('a'), hashText('b'));
});

test('hashFile returns null for a missing file', () => {
  assert.equal(hashFile(join(dir, 'nope.txt')), null);
});

test('hashFile matches hashText for the same content', () => {
  const f = join(dir, 'x.txt');
  writeFileSync(f, 'contents\n');
  assert.equal(hashFile(f), hashText('contents\n'));
});

test('readLock returns an empty lock when no file exists', () => {
  const lock = readLock();
  assert.equal(lock.version, 1);
  assert.deepEqual(lock.files, {});
});

test('readLock survives a corrupt lockfile', () => {
  writeFileSync(join(dir, '.nortuscc-lock.json'), '{ not json');
  const lock = readLock();
  assert.deepEqual(lock.files, {});
  rmSync(join(dir, '.nortuscc-lock.json'));
});

test('writeLock then readLock round-trips', () => {
  const lock = readLock();
  setBaseline(lock, 'settings.json', hashText('v1'));
  lock.repo = '/some/repo';
  writeLock(lock);

  const again = readLock();
  assert.equal(again.repo, '/some/repo');
  assert.equal(again.files['settings.json'].hash, hashText('v1'));
  assert.match(again.files['settings.json'].appliedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('readLock rejects valid JSON with string files field', () => {
  writeFileSync(join(dir, '.nortuscc-lock.json'), JSON.stringify({version: 1, repo: null, files: 'not-an-object'}));
  const lock = readLock();
  assert.deepEqual(lock.files, {});
  assert.doesNotThrow(() => setBaseline(lock, 'x', hashText('test')));
  rmSync(join(dir, '.nortuscc-lock.json'));
});

test('readLock rejects valid JSON with array files field', () => {
  writeFileSync(join(dir, '.nortuscc-lock.json'), JSON.stringify({version: 1, repo: null, files: [1, 2, 3]}));
  const lock = readLock();
  assert.deepEqual(lock.files, {});
  assert.doesNotThrow(() => setBaseline(lock, 'y', hashText('test')));
  rmSync(join(dir, '.nortuscc-lock.json'));
});
