import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configSection } from '../src/install-sections.mjs';

// A fixture repo/home, isolated from the real machine — configSection calls
// resolveEntry() and readLock() under the hood, both of which read these env
// vars, so this file needs the same isolation apply.test.mjs/capture.test.mjs
// already use rather than a hand-written items() fixture.
const home = mkdtempSync(join(tmpdir(), 'nortuscc-install-sections-'));
const repo = join(home, 'repo');
const claude = join(home, '.claude');
const codex = join(home, '.codex');
mkdirSync(join(repo, 'claude'), { recursive: true });
mkdirSync(join(repo, 'codex'), { recursive: true });
writeFileSync(join(repo, 'claude', 'CLAUDE.md'), '# test\n');
writeFileSync(join(repo, 'codex', 'AGENTS.md'), '# test codex\n');
writeFileSync(join(repo, 'claude', 'settings.keys.json'), JSON.stringify({ theme: 'auto' }) + '\n');
mkdirSync(claude, { recursive: true });
mkdirSync(codex, { recursive: true });

process.env.NORTUSCC_REPO_DIR = repo;
process.env.NORTUSCC_CLAUDE_DIR = claude;
process.env.NORTUSCC_CODEX_DIR = codex;
process.env.NORTUSCC_STATE_DIR = join(home, 'state');
process.env.NORTUSCC_AGENTS_DIR = join(home, '.agents', 'skills');

// Claude now owns two SYNC entries (its instruction file and its settings
// keys). Before this fix both items() rows carried id `config:claude`, and
// since src/commands/install.mjs:79 selects with `chosen.has(item.id)`, a
// picker or --yes run could not offer or decline one without the other. No
// hand-written fixture (see test/install.test.mjs, test/install-plan.test.mjs)
// exercises real id generation, so this pins it against the real manifest.
test('configSection items carry one id per entry, not one per target', () => {
  const items = configSection('claude').items();
  const ids = items.map((i) => i.id);

  assert.deepEqual(ids, ['config:claude:CLAUDE.md', 'config:claude:settings.json']);
  assert.equal(new Set(ids).size, ids.length, 'every item has its own id');
});

test('a target with a single entry still gets a stable, unique id', () => {
  const items = configSection('codex').items();
  assert.deepEqual(items.map((i) => i.id), ['config:codex:AGENTS.md']);
});
