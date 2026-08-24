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

  const plugins = integrations.filter((i) => i.type === 'plugin').map((i) => i.plugin);
  assert.deepEqual(
    plugins,
    ['superpowers@claude-plugins-official', 'dx-devextreme@DevExpress-agent-skills'],
    'superpowers and dx-devextreme are the declared plugins',
  );
});

// context-mode and claude-mem were dropped on 2026-08-20 after a cost audit:
// between them they accounted for 762s of the 773s of hook latency measured
// over a 13-day window. superpowers ships from the official marketplace Claude
// Code already knows, so it needs no marketplace entry; DevExpress's does not
// ship with Claude Code, so dx-devextreme has to bring its own.
test('the committed manifest declares only the DevExpress marketplace, and nothing for codex', async () => {
  const realRepo = fileURLToPath(new URL('..', import.meta.url));
  const { readIntegrations } = await import('../src/integrations/manifest.mjs');
  const { integrations } = readIntegrations({ repo: realRepo });

  const marketplaces = integrations.filter((i) => i.type === 'marketplace');
  assert.deepEqual(marketplaces.map((i) => i.marketplace), ['DevExpress/agent-skills']);
  // The registered name is not derivable from the source, and inspection
  // matches on it: a wrong value here re-adds the marketplace every run.
  assert.deepEqual(marketplaces.map((i) => i.name), ['DevExpress-agent-skills']);

  assert.deepEqual(integrations.filter((i) => i.target === 'codex'), []);
});

// dx-devextreme is installed but disabled on the owner's machine. Declaring it
// stops `status` reporting it as undeclared drift; `default: false` keeps it
// off the pre-ticked set, so a new machine is offered it rather than given it.
test('dx-devextreme is declared, and declared off by default', async () => {
  const realRepo = fileURLToPath(new URL('..', import.meta.url));
  const { readIntegrations } = await import('../src/integrations/manifest.mjs');
  const { integrations } = readIntegrations({ repo: realRepo });

  const byId = new Map(integrations.map((i) => [i.id, i]));
  const plugin = byId.get('dx-devextreme-claude');
  const market = byId.get('devexpress-agent-skills-claude');

  assert.ok(plugin, 'the plugin is declared');
  assert.ok(market, 'the marketplace it comes from is declared too');
  assert.equal(plugin.default, false);
  assert.equal(market.default, false);
  assert.equal(plugin.target, 'claude');
  assert.equal(market.target, 'claude');
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
