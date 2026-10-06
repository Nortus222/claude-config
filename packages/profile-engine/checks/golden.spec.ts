// Golden expectations: how the CLI read each document before the engine replaced its readers,
// frozen as literals so the engine keeps reading every edge case the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect } from 'effect';
import {
  FILES, loadProfile, nodeFiles, overridesFromLegacyState,
  type DesiredConfig, type Input, type MachineOverrides,
} from '../src/index.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

const load = (dir: string, overrides?: Input<MachineOverrides>) =>
  Effect.runPromise(loadProfile(dir, { overrides }).pipe(Effect.provide(nodeFiles)));

function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'profile-golden-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

type Skill = { name: string; source: string; exact: boolean; optional: boolean };
type Expected = {
  keys?: Record<string, unknown>;
  skills?: Skill[];
  integrations?: unknown[];
  allow?: Record<string, string[]>;
  refused?: boolean;
};

// Compares settings keys, skills and integrations with what the CLI read from the same documents.
function assertReads(config: DesiredConfig, expected: Expected, label: string): void {
  const keys = config.files.find((f) => f.id === 'claude:settings.json')!.keys!;
  const engineKeys = Object.keys(keys).length
    ? Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v.value]))
    : undefined;
  assert.deepEqual(engineKeys, expected.keys, `${label}: settings keys`);
  assert.deepEqual(
    config.skills.map((s) => ({ name: s.name, source: s.source, exact: s.exact, optional: s.optional })),
    expected.skills ?? [],
    `${label}: skills`,
  );
  assert.ok(config.skills.every((s) => s.install === !s.optional), `${label}: default selection`);
  assert.deepEqual(config.integrations.map((i) => i.declaration), expected.integrations ?? [], `${label}: integrations`);
  assert.deepEqual(config.allow, expected.allow ?? {}, `${label}: allow`);
  assert.equal(
    config.issues.some((i) => i.source === 'integrations.json'),
    expected.refused === true,
    `${label}: integrations refusal`,
  );
  assert.ok(config.integrations.every((i) => i.enabled === i.declaration.default), `${label}: enabled`);
}

// This repository's documents are valid, so the CLI read them verbatim: every owned settings key,
// every declared integration and allow entry, and every skill line of the manifest in order under
// its `[source] markers` header. The repo's manifest has no edge cases, so a line reader suffices.
function manifestSkills(text: string): Skill[] {
  const skills: Skill[] = [];
  let header: { source: string; exact: boolean; optional: boolean } | undefined;
  for (const line of text.split(/\r?\n/).map((l) => l.trim())) {
    if (!line || line.startsWith('#')) continue;
    const match = /^\[([^\]]+)\]\s*(.*)$/.exec(line);
    if (match) {
      const markers = match[2]!.split(/\s+/);
      header = { source: match[1]!, exact: markers.includes('exact'), optional: markers.includes('optional') };
    } else if (header) {
      skills.push({ name: line, ...header });
    }
  }
  return skills;
}

test("this repository's configuration resolves as the CLI reads it", async () => {
  const config = await load(REPO);
  assert.deepEqual(config.issues, []);
  const read = (path: string) => readFileSync(join(REPO, path), 'utf8');
  const integrations = JSON.parse(read('integrations.json'));
  const skills = manifestSkills(read('skills-manifest.txt'));
  assert.ok(skills.some((s) => s.optional) && skills.some((s) => !s.optional), 'repo: both selections exercised');
  const expected = {
    keys: JSON.parse(read('claude/settings.keys.json')),
    skills,
    integrations: integrations.integrations,
    allow: integrations.allow ?? {},
  };
  assertReads(config, expected, 'repo');
});

// Which agents' files the CLI managed for each state.json it could find: [] when skills-only.
const MANAGED_TARGETS: Array<[string | undefined, string[]]> = [
  [undefined, ['claude', 'codex']],
  ['{', ['claude', 'codex']],
  ['{"files":{}}', ['claude', 'codex']],
  ['{"files":{},"skillsOnly":true}', []],
  ['{"files":{},"skillsOnly":"true"}', ['claude', 'codex']],
  ['{"skillsOnly":true}', ['claude', 'codex']],
  ['{"files":{},"configTargets":["claude"]}', ['claude']],
  ['{"files":{},"configTargets":["codex"]}', ['codex']],
  ['{"files":{},"configTargets":[]}', []],
  ['{"files":{},"configTargets":["codex","codex"]}', ['codex']],
  ['{"files":{},"configTargets":["cursor"]}', ['claude', 'codex']],
  ['{"files":{},"skillsOnly":true,"configTargets":["claude"]}', []],
];

test('managed files match the CLI for every legacy state record', async () => {
  for (const [state, targets] of MANAGED_TARGETS) {
    const config = await load(REPO, overridesFromLegacyState(state));
    assert.deepEqual(
      config.files.filter((f) => f.managed).map((f) => f.id),
      FILES.filter((f) => targets.includes(f.target)).map((f) => f.id),
      String(state),
    );
  }
});

const plugin = { id: 'sp', label: 'sp', target: 'claude', type: 'plugin', default: true, plugin: 'sp@x' };
const hook = { id: 'h', label: 'h', target: 'claude', type: 'hook', default: false, event: 'Stop', file: 'hooks/h.sh' };
const integrationsDoc = (integrations: unknown[], extra: object = {}) =>
  JSON.stringify({ version: 1, integrations, ...extra });

const FIXTURES: Record<string, Record<string, string>> = {
  'empty repo': {},
  'manifest edge cases': {
    'skills-manifest.txt': 'orphan\r\n[a/b] exact optional typo\r\n  x  \r\n[a/b]\r\ny\r\n[c/d]\n# note\nz\n[e/f]\n',
  },
  'settings not json': { 'claude/settings.keys.json': '{' },
  'settings array': { 'claude/settings.keys.json': '[]' },
  'settings empty': { 'claude/settings.keys.json': '{}' },
  'settings secret name': { 'claude/settings.keys.json': '{"env":{"API_KEY":"x"}}' },
  'settings secret value': { 'claude/settings.keys.json': '{"a":["ghp_abcdefgh123"]}' },
  'settings valid': { 'claude/settings.keys.json': '{"theme":"auto","worktree":{"x":[1]}}' },
  'integrations not json': { 'integrations.json': '{' },
  'integrations wrong version': { 'integrations.json': JSON.stringify({ version: 2, integrations: [] }) },
  'integrations no array': { 'integrations.json': JSON.stringify({ version: 1 }) },
  'integrations duplicate': { 'integrations.json': integrationsDoc([plugin, plugin]) },
  'integrations secret': { 'integrations.json': integrationsDoc([{ ...plugin, note: 'sk-abcdef12' }]) },
  'integrations requiresEnv': { 'integrations.json': integrationsDoc([{ ...plugin, requiresEnv: ['API_KEY'] }]) },
  'hook shipped': { 'integrations.json': integrationsDoc([hook]), 'hooks/h.sh': '#!/bin/sh\n' },
  'hook missing': { 'integrations.json': integrationsDoc([hook]) },
  'allow valid': { 'integrations.json': integrationsDoc([plugin], { allow: { plugins: ['a@b'], skills: ['s'] } }) },
  'allow unknown category': { 'integrations.json': integrationsDoc([plugin], { allow: { widgets: ['a'] } }) },
};

// What the CLI read from each fixture; an omitted field is empty (no keys, skills or integrations).
const READS: Record<string, Expected> = {
  'empty repo': {},
  'manifest edge cases': {
    skills: [
      { name: 'x', source: 'a/b', exact: true, optional: true },
      { name: 'y', source: 'a/b', exact: false, optional: false },
      { name: 'z', source: 'c/d', exact: false, optional: false },
    ],
  },
  'settings not json': {},
  'settings array': {},
  'settings empty': {},
  'settings secret name': {},
  'settings secret value': {},
  'settings valid': { keys: { theme: 'auto', worktree: { x: [1] } } },
  'integrations not json': { refused: true },
  'integrations wrong version': { refused: true },
  'integrations no array': { refused: true },
  'integrations duplicate': { refused: true },
  'integrations secret': { refused: true },
  'integrations requiresEnv': { integrations: [{ ...plugin, requiresEnv: ['API_KEY'] }] },
  'hook shipped': { integrations: [hook] },
  'hook missing': { refused: true },
  'allow valid': { integrations: [plugin], allow: { plugins: ['a@b'], skills: ['s'] } },
  'allow unknown category': { refused: true },
};

const market = { id: 'm', label: 'm', target: 'claude', type: 'marketplace', default: true };
// Every integration refusal the engine's own tests list; the CLI refused each one too.
const REFUSALS: Record<string, string> = {
  'invalid json': '{',
  'not an object': '[]',
  'wrong version': JSON.stringify({ version: 2, integrations: [] }),
  'no integrations array': JSON.stringify({ version: 1 }),
  'item not an object': integrationsDoc(['x']),
  'missing id': integrationsDoc([{ ...plugin, id: '' }]),
  'duplicate id': integrationsDoc([plugin, plugin]),
  'missing label': integrationsDoc([{ ...plugin, label: '' }]),
  'unsupported target': integrationsDoc([{ ...plugin, target: 'cursor' }]),
  'unknown type': integrationsDoc([{ ...plugin, type: 'widget' }]),
  'default not boolean': integrationsDoc([{ ...plugin, default: 'yes' }]),
  'plugin without name': integrationsDoc([{ ...plugin, plugin: '' }]),
  'marketplace without source': integrationsDoc([{ ...market, name: 'm' }]),
  'marketplace without name': integrationsDoc([{ ...market, marketplace: 'o/r' }]),
  'mcp without command': integrationsDoc([{ id: 'c', label: 'c', target: 'codex', type: 'mcp', default: true }]),
  'hook without event': integrationsDoc([{ ...hook, event: '' }]),
  'hook without file': integrationsDoc([{ ...hook, file: '' }]),
  'hook file not in repo': integrationsDoc([hook]),
  'requiresEnv not names': integrationsDoc([{ ...plugin, requiresEnv: [1] }]),
  'secret field name': integrationsDoc([{ ...plugin, token: 'x' }]),
  'secret value': integrationsDoc([{ ...plugin, note: 'sk-abcdef12' }]),
  'secret value in a list': integrationsDoc([{ ...plugin, args: ['ok', 'ghp_abcdefgh1'] }]),
  'allow not an object': integrationsDoc([plugin], { allow: [] }),
  'allow unknown category': integrationsDoc([plugin], { allow: { widgets: [] } }),
  'allow not ids': integrationsDoc([plugin], { allow: { plugins: [''] } }),
};

for (const [label, text] of Object.entries(REFUSALS)) {
  test(`refusal agrees with the CLI: ${label}`, () =>
    withTempDir(async (dir) => {
      writeFileSync(join(dir, 'integrations.json'), text);
      const config = await load(dir);
      assertReads(config, { refused: true }, label);
      assert.deepEqual(config.integrations, [], `${label}: no integrations`);
      assert.ok(config.issues.some((i) => i.source === 'integrations.json'), `${label}: engine issue`);
    }));
}

for (const [label, files] of Object.entries(FIXTURES)) {
  test(`fixture agrees with the CLI: ${label}`, () =>
    withTempDir(async (dir) => {
      for (const [relative, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, relative)), { recursive: true });
        writeFileSync(join(dir, relative), text);
      }
      assertReads(await load(dir), READS[label]!, label);
    }));
}
