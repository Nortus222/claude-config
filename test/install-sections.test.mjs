import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configSection, defaultInstallDeps } from '../src/install-sections.mjs';

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
writeFileSync(join(repo, 'integrations.json'), JSON.stringify({
  version: 1,
  integrations: [{
    id: 'superpowers-codex',
    label: 'superpowers',
    target: 'codex',
    type: 'plugin',
    default: true,
    plugin: 'superpowers@openai-curated',
  }],
}) + '\n');
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

test('Codex configuration entries each get a stable, unique id', () => {
  const items = configSection('codex').items();
  assert.deepEqual(items.map((i) => i.id), [
    'config:codex:AGENTS.md',
    'config:codex:models-static.json',
    'config:codex:config.toml',
  ]);
});

test('an unavailable Codex CLI warns without invalidating the integrations manifest', async () => {
  const codexState = {
    plugins: new Set(),
    marketplaces: new Set(),
    errors: ['could not list Codex plugins: could not launch `codex`: ENOENT'],
  };

  const deps = await defaultInstallDeps('all', { codexState });
  assert.deepEqual(deps.integrationErrors, []);
  assert.deepEqual(deps.warnings, codexState.errors);

  const codexPlugin = deps.sections.integrations.items().find((item) => item.id === 'plugin:superpowers-codex');
  assert.equal(codexPlugin.state, 'blocked');
  assert.equal(codexPlugin.default, false, 'a command that cannot run must not be selected by --yes');
});

test('a Claude-only install does not probe the Codex CLI', async () => {
  let calls = 0;
  await defaultInstallDeps('claude', {
    codexProbe: { capture: async () => { calls += 1; return { ok: false, stdout: '', note: 'ENOENT' }; } },
  });
  assert.equal(calls, 0);
});

test('disabled Codex plugins do not require a Codex CLI probe', async () => {
  let calls = 0;
  await defaultInstallDeps('all', {
    probeCodex: false,
    codexProbe: { capture: async () => { calls += 1; return { ok: false, stdout: '', note: 'ENOENT' }; } },
  });
  assert.equal(calls, 0);
});
