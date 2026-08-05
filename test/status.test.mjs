import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'nortuscc-status-'));
process.env.NORTUSCC_CLAUDE_DIR = join(home, '.claude');
mkdirSync(process.env.NORTUSCC_CLAUDE_DIR, { recursive: true });

const { configReport } = await import('../src/commands/status.mjs');

test('configReport returns one row per manifest entry', async () => {
  const { SYNC } = await import('../src/manifest.mjs');
  const rows = configReport();
  assert.equal(rows.length, SYNC.length);
  for (const row of rows) {
    assert.ok(row.dest, 'each row names its destination');
    assert.ok(['link', 'copy'].includes(row.mode));
    assert.ok(typeof row.state === 'string' && row.state.length > 0);
  }
});

test('an empty claude dir reports nothing as clean', () => {
  const rows = configReport();
  const clean = rows.filter((r) => r.state === 'clean' || r.state === 'linked');
  assert.equal(clean.length, 0, 'a bare machine has no synced files yet');
});

test('link entries report missing on a bare machine', () => {
  const rows = configReport().filter((r) => r.mode === 'link');
  for (const row of rows) assert.equal(row.state, 'missing');
});

test('copy entries report unmanaged on a bare machine', () => {
  const rows = configReport().filter((r) => r.mode === 'copy');
  for (const row of rows) assert.equal(row.state, 'unmanaged');
});
