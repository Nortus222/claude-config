import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, git, machine, runCli } from './support/cli.ts';

test('machine() makes a committed git repo whose claude/CLAUDE.md matches the checkout', () => {
  const m = machine();
  assert.notEqual(m.repo, REPO);
  assert.equal(readFileSync(join(m.repo, 'claude', 'CLAUDE.md'), 'utf8'), readFileSync(join(REPO, 'claude', 'CLAUDE.md'), 'utf8'));
  assert.equal(git(m.repo, 'status', '--porcelain'), '');
  assert.equal(git(m.repo, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/main');
  assert.ok(existsSync(join(m.bin, 'codex')));
});

test('runCli --help exits 0 and prints usage', async () => {
  const result = await runCli(machine({ repo: 'checkout' }), ['--help']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Usage: nortuscc/);
});
