import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { SYNC } from '../src/manifest.mjs';
import { resolveEntry, repoRoot, claudeDir } from '../src/resolve.mjs';

test('every manifest entry resolves to a path that exists in the repo', () => {
  assert.ok(SYNC.length > 0, 'manifest must not be empty');
  for (const entry of SYNC) {
    const { src } = resolveEntry(entry);
    assert.ok(existsSync(src), `manifest source missing from repo: ${entry.src}`);
  }
});

test('every manifest entry declares a valid mode', () => {
  for (const entry of SYNC) {
    assert.ok(['link', 'copy'].includes(entry.mode), `bad mode on ${entry.src}: ${entry.mode}`);
  }
});

test('manifest dest paths are relative and land under ~/.claude', () => {
  for (const entry of SYNC) {
    assert.ok(!entry.dest.startsWith('/'), `dest must be relative: ${entry.dest}`);
    const { dest } = resolveEntry(entry);
    assert.ok(dest.startsWith(claudeDir()), `dest escaped ~/.claude: ${dest}`);
  }
});

test('repoRoot points at the repo containing package.json', () => {
  assert.ok(existsSync(`${repoRoot()}/package.json`));
});
