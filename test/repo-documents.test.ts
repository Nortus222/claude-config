// Policy for this repository's own committed documents: what it declares, allows and manages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect } from 'effect';
import { FILES, loadProfile, nodeFiles, TARGETS } from '@nortuscc/profile-engine';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const config = await Effect.runPromise(loadProfile(REPO).pipe(Effect.provide(nodeFiles)));
const declared = config.integrations.map((i) => i.declaration);

test('the committed documents resolve without issues', () => {
  assert.deepEqual(config.issues, []);
  const ids = declared.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length);
});

// Superpowers ships from official marketplaces both agents already know, so no marketplace and no
// hook is declared (context-mode and claude-mem were dropped after a hook-latency audit).
test('superpowers is the only declared plugin, once per agent, with no marketplace or hook', () => {
  assert.deepEqual(
    declared.filter((d) => d.type === 'plugin').map((d) => [d.id, d.target, d.plugin]),
    [
      ['superpowers-claude', 'claude', 'superpowers@claude-plugins-official'],
      ['superpowers-codex', 'codex', 'superpowers@openai-curated'],
    ],
  );
  assert.deepEqual(declared.filter((d) => d.type === 'marketplace' || d.type === 'hook'), []);
});

// `allow` silences the undeclared report where an extra is present and does nothing where it is
// not; declaring one instead would offer it in every machine's installer.
test('dx-devextreme and the plugins Codex bundles are allowed, never declared', () => {
  const plugins = config.allow.plugins ?? [];
  const marketplaces = config.allow.marketplaces ?? [];
  for (const plugin of [
    'dx-devextreme@DevExpress-agent-skills',
    'documents@openai-primary-runtime', 'pdf@openai-primary-runtime', 'spreadsheets@openai-primary-runtime',
    'presentations@openai-primary-runtime', 'template-creator@openai-primary-runtime',
    'codex-app-tools@openai-bundled', 'sites@openai-bundled', 'browser@openai-bundled',
    'unified-computer-use@openai-bundled', 'chrome@openai-bundled', 'computer-use@openai-bundled',
    'visualize@openai-bundled',
  ]) {
    assert.ok(plugins.includes(plugin), `${plugin} must be allowed`);
  }
  for (const marketplace of ['DevExpress-agent-skills', 'openai-primary-runtime', 'openai-bundled']) {
    assert.ok(marketplaces.includes(marketplace), `${marketplace} must be allowed`);
  }
  // superpowers is declared from openai-curated; allowing it too would hide a failed install.
  assert.ok(!marketplaces.includes('openai-curated'));
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const extras = declared.filter((d) =>
    text(d.plugin).startsWith('dx-devextreme') || text(d.marketplace).includes('DevExpress')
    || text(d.plugin).endsWith('@openai-bundled') || text(d.plugin).endsWith('@openai-primary-runtime'));
  assert.deepEqual(extras, []);
});

test('every managed file has its repo source and a relative destination in its own agent home', () => {
  for (const file of FILES) {
    assert.ok(existsSync(join(REPO, file.src)), `missing from the repo: ${file.src}`);
    assert.ok(!isAbsolute(file.dest) && !file.dest.split(/[\\/]/).includes('..'), `dest escapes its home: ${file.dest}`);
    assert.ok(file.home.startsWith(file.target), `${file.id} lands outside ${file.target}'s homes`);
  }
  assert.deepEqual([...new Set(FILES.map((f) => f.target))].sort(), [...TARGETS].sort());
});

// Settings are synced key by key; a whole-file copy would replace a machine's permissions and UI
// preferences. Helper wrappers and the cache-repair hook were retired, not relocated.
test('no whole-file settings, helper or hook is managed, and the retired assets stay gone', () => {
  assert.equal(FILES.some((f) => /bin|hooks/.test(f.src)), false);
  assert.equal(FILES.some((f) => /settings/.test(f.src) && f.mode !== 'merge-keys'), false);
  for (const path of ['claude/settings.json', 'claude/bin/sp', 'claude/bin/sdd-pkg.sh', 'claude/hooks/context-mode-cache-heal.mjs']) {
    assert.equal(existsSync(join(REPO, path)), false, `${path} must no longer be tracked`);
  }
  for (const path of ['claude/CLAUDE.md', 'codex/AGENTS.md']) {
    assert.doesNotMatch(readFileSync(join(REPO, path), 'utf8'), /sdd-pkg|\.claude\/bin\/sp/, path);
  }
});
