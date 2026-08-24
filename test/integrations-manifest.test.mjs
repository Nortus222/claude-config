import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateIntegrations, TYPES } from '../src/integrations/manifest.mjs';

const repo = mkdtempSync(join(tmpdir(), 'nortuscc-integrations-'));
mkdirSync(join(repo, 'claude', 'hooks'), { recursive: true });
writeFileSync(join(repo, 'claude', 'hooks', 'present.mjs'), '// hook\n');

function manifest(...integrations) {
  return { version: 1, integrations };
}

const PLUGIN = {
  id: 'context-mode-claude',
  label: 'context-mode',
  target: 'claude',
  type: 'plugin',
  default: true,
  plugin: 'context-mode@context-mode',
};

test('valid manifest accepts stable IDs, targets, types, and env names', () => {
  const result = validateIntegrations(manifest(PLUGIN), { repo });
  assert.deepEqual(result.errors, []);
  assert.equal(result.integrations.length, 1);
  assert.equal(result.integrations[0].id, 'context-mode-claude');
});

test('manifest rejects duplicate IDs and probable secret values', () => {
  const result = validateIntegrations(
    manifest(
      { id: 'x', label: 'x', target: 'codex', type: 'mcp', default: true, command: 'srv', token: 'sk-live-secret' },
      { id: 'x', label: 'x2', target: 'codex', type: 'mcp', default: true, command: 'srv' },
    ),
    { repo },
  );
  assert.match(result.errors.join('\n'), /duplicate.*x/i);
  assert.match(result.errors.join('\n'), /secret/i);
});

// Environment-variable *names* are exactly what may be committed; their values
// are exactly what may not. A validator that rejected the names would make the
// only safe way to describe a credential impossible to express.
test('requiresEnv names are accepted, not mistaken for secrets', () => {
  const result = validateIntegrations(
    manifest({
      id: 'openai-mcp',
      label: 'openai',
      target: 'codex',
      type: 'mcp',
      default: false,
      command: 'openai-mcp',
      requiresEnv: ['OPENAI_API_KEY'],
    }),
    { repo },
  );
  assert.deepEqual(result.errors, []);
});

test('manifest rejects an unknown type', () => {
  const result = validateIntegrations(
    manifest({ id: 'w', label: 'w', target: 'claude', type: 'widget', default: false }),
    { repo },
  );
  assert.match(result.errors.join('\n'), /type/i);
  assert.match(result.errors.join('\n'), /widget/);
});

test('manifest rejects an unsupported target', () => {
  const result = validateIntegrations(
    manifest({ ...PLUGIN, id: 'c', target: 'cursor' }),
    { repo },
  );
  assert.match(result.errors.join('\n'), /target/i);
  assert.match(result.errors.join('\n'), /cursor/);
});

test('manifest rejects an entry missing its id or label', () => {
  const result = validateIntegrations(
    manifest({ target: 'claude', type: 'plugin', default: true, plugin: 'a@b' }),
    { repo },
  );
  assert.ok(result.errors.length > 0);
  assert.match(result.errors.join('\n'), /id/i);
});

// A hook declaration names a file this repo ships. If the file is not there,
// the adapter would install a registration pointing at nothing — a hook that
// fails at every session start rather than at validation time.
test('manifest rejects a hook whose referenced file is absent from the repo', () => {
  const present = validateIntegrations(
    manifest({
      id: 'h1', label: 'h', target: 'claude', type: 'hook', default: false,
      event: 'SessionStart', file: 'claude/hooks/present.mjs',
    }),
    { repo },
  );
  assert.deepEqual(present.errors, []);

  const absent = validateIntegrations(
    manifest({
      id: 'h2', label: 'h', target: 'claude', type: 'hook', default: false,
      event: 'SessionStart', file: 'claude/hooks/gone.mjs',
    }),
    { repo },
  );
  assert.match(absent.errors.join('\n'), /gone\.mjs/);
});

test('manifest rejects a non-object, a wrong version, and a non-array integrations field', () => {
  assert.ok(validateIntegrations(null, { repo }).errors.length > 0);
  assert.ok(validateIntegrations({ version: 2, integrations: [] }, { repo }).errors.length > 0);
  assert.ok(validateIntegrations({ version: 1, integrations: {} }, { repo }).errors.length > 0);
});

test('every declared type has a name the runner orders', () => {
  assert.deepEqual([...TYPES].sort(), ['hook', 'marketplace', 'mcp', 'plugin']);
});

// A rejected manifest yields no integrations at all. Handing back the entries
// that happened to parse would let a caller install "most of" a manifest the
// validator refused.
test('a manifest with any error yields no integrations', () => {
  const result = validateIntegrations(
    manifest(PLUGIN, { id: 'bad', label: 'bad', target: 'cursor', type: 'plugin', default: true, plugin: 'a@b' }),
    { repo },
  );
  assert.ok(result.errors.length > 0);
  assert.deepEqual(result.integrations, []);
});

// --- the repository's own manifest ------------------------------------------

test('the committed integrations.json is valid and declares the agreed defaults', async () => {
  const realRepo = fileURLToPath(new URL('..', import.meta.url));
  const { readIntegrations } = await import('../src/integrations/manifest.mjs');
  const { integrations, errors } = readIntegrations({ repo: realRepo });

  assert.deepEqual(errors, [], 'the committed manifest must validate');

  const byId = new Map(integrations.map((i) => [i.id, i]));
  assert.ok(byId.has('superpowers-claude'));
  assert.equal(byId.get('superpowers-claude').plugin, 'superpowers@claude-plugins-official');
  assert.ok(byId.has('superpowers-codex'));
  assert.equal(byId.get('superpowers-codex').plugin, 'superpowers@openai-curated');

  const plugins = integrations.filter((i) => i.type === 'plugin').map((i) => i.plugin);
  assert.deepEqual(plugins, ['superpowers@claude-plugins-official', 'superpowers@openai-curated'], 'superpowers is the only declared plugin');
});

// context-mode and claude-mem were dropped on 2026-08-20 after a cost audit:
// between them they accounted for 762s of the 773s of hook latency measured
// over a 13-day window. Superpowers ships from configured official marketplaces
// for both agents, so no extra marketplace needs declaring here.
test('the committed manifest declares no marketplace and includes Codex superpowers', async () => {
  const realRepo = fileURLToPath(new URL('..', import.meta.url));
  const { readIntegrations } = await import('../src/integrations/manifest.mjs');
  const { integrations } = readIntegrations({ repo: realRepo });

  assert.deepEqual(integrations.filter((i) => i.type === 'marketplace'), []);
  assert.deepEqual(
    integrations.filter((i) => i.target === 'codex').map((i) => i.plugin),
    ['superpowers@openai-curated'],
  );
});

// dx-devextreme is wanted on one machine only. `allow` is the mechanism for
// exactly that: it silences the undeclared report where the plugin is present
// and does nothing at all where it is not. Declaring it as an integration
// instead would offer it in every machine's installer, which is the one
// outcome this must not have.
test('dx-devextreme is allowed as a machine-local extra, never declared', async () => {
  const realRepo = fileURLToPath(new URL('..', import.meta.url));
  const { readIntegrations } = await import('../src/integrations/manifest.mjs');
  const { integrations, allow, errors } = readIntegrations({ repo: realRepo });

  assert.deepEqual(errors, []);

  // Matched on the same key the undeclared report prints, so a mismatch here
  // shows up as drift that never clears.
  assert.ok(allow.plugins.includes('dx-devextreme@DevExpress-agent-skills'));
  assert.ok(allow.marketplaces.includes('DevExpress-agent-skills'));

  // The load-bearing half: nothing about it is installable.
  const named = integrations.filter(
    (i) => i.plugin?.startsWith('dx-devextreme') || i.marketplace?.includes('DevExpress'),
  );
  assert.deepEqual(named, [], 'an allowed extra must not also be a declared integration');
});

// The design retires the private cache-repair hook rather than relocating it:
// context-mode's native installation owns its own hooks.
test('the committed manifest declares no hook at all', async () => {
  const realRepo = fileURLToPath(new URL('..', import.meta.url));
  const { readIntegrations } = await import('../src/integrations/manifest.mjs');
  const { integrations } = readIntegrations({ repo: realRepo });
  assert.deepEqual(integrations.filter((i) => i.type === 'hook'), []);
});

test('every committed integration has a unique id', async () => {
  const realRepo = fileURLToPath(new URL('..', import.meta.url));
  const { readIntegrations } = await import('../src/integrations/manifest.mjs');
  const { integrations } = readIntegrations({ repo: realRepo });
  const ids = integrations.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('a manifest with no allow list yields an empty one', () => {
  const result = validateIntegrations(manifest(PLUGIN), { repo });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.allow, {});
});

test('allow accepts known categories with string ids', () => {
  const value = { ...manifest(PLUGIN), allow: { agents: ['awesome-claude-agents'], plugins: [] } };
  const result = validateIntegrations(value, { repo });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.allow.agents, ['awesome-claude-agents']);
});

// Fail-closed, like every other check here: a typo that silently allows nothing
// is worse than one that says so.
test('allow rejects an unknown category', () => {
  const value = { ...manifest(PLUGIN), allow: { plugin: ['x'] } };
  const result = validateIntegrations(value, { repo });
  assert.ok(result.errors.some((e) => /unknown category 'plugin'/.test(e)));
  assert.deepEqual(result.integrations, []);
});

test('allow rejects a non-array value and a non-string id', () => {
  const bad = validateIntegrations({ ...manifest(PLUGIN), allow: { agents: 'x' } }, { repo });
  assert.ok(bad.errors.some((e) => /must be a list of ids/.test(e)));

  const worse = validateIntegrations({ ...manifest(PLUGIN), allow: { agents: [5] } }, { repo });
  assert.ok(worse.errors.some((e) => /must be a list of ids/.test(e)));
});

test('allow must be an object', () => {
  const result = validateIntegrations({ ...manifest(PLUGIN), allow: ['agents'] }, { repo });
  assert.ok(result.errors.some((e) => /'allow' must be an object/.test(e)));
});
