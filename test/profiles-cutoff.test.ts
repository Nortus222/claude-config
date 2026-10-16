import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { machine, runCli } from './support/cli.ts';

test('CLI refuses a setup that uses profiles with the desktop-app message', async () => {
  const m = machine();
  mkdirSync(join(m.repo, 'profiles'));
  for (const populated of [false, true]) {
    if (populated) writeFileSync(join(m.repo, 'profiles/default.json'), '{}');
    const result = await runCli(m, ['status']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /This setup uses profiles; use the desktop app\./);
  }
});

test('CLI profile cutoff precedes checkout coherence checks and choice migration', async () => {
  const m = machine();
  mkdirSync(join(m.repo, 'profiles'));
  mkdirSync(m.state, { recursive: true });
  writeFileSync(join(m.state, 'state.json'), JSON.stringify({ version: 1, files: {}, applied: { commit: 'f'.repeat(40), at: '2026-10-16T12:00:00Z' } }));
  const result = await runCli(m, ['apply']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /This setup uses profiles; use the desktop app\./);
});
