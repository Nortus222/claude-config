// The CLI's own modules are the oracle: the engine must read today's documents exactly as they do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect } from 'effect';
import { SYNC } from '../../../src/manifest.mjs';
import { configEntries, parseConfigMode } from '../../../src/config-mode.mjs';
import { parseManifest } from '../../../src/skills.mjs';
import { validateIntegrations } from '../../../src/integrations/manifest.mjs';
import { validateOwnedKeys } from '../../../src/settings-keys.mjs';
import {
  FILES, loadProfile, nodeFiles, overridesFromLegacyState,
  type DesiredConfig, type FileEntry, type Input, type MachineOverrides,
} from '../src/index.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

const load = (dir: string, overrides?: Input<MachineOverrides>) =>
  Effect.runPromise(loadProfile(dir, { overrides }).pipe(Effect.provide(nodeFiles)));

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function parseOrUndefined(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// An engine file entry in the CLI's SYNC shape.
function toSyncEntry(file: FileEntry): Record<string, unknown> {
  return {
    target: file.target,
    ...(file.home !== file.target ? { machine: file.home } : {}),
    src: file.src,
    dest: file.dest,
    mode: file.mode,
    ...(file.preserveProjects ? { preserveProjects: true } : {}),
    ...(file.capture ? {} : { capture: false }),
  };
}

function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'profile-golden-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

// Compares settings, skills and integrations for one repo directory.
function assertDocumentsAgree(dir: string, config: DesiredConfig, label: string): void {
  const settingsText = readOptional(join(dir, 'claude/settings.keys.json'));
  const settingsValue = parseOrUndefined(settingsText);
  const legacyKeys =
    settingsValue === undefined || validateOwnedKeys(settingsValue).length > 0 ? undefined : settingsValue;
  const keys = config.files.find((f) => f.id === 'claude:settings.json')!.keys!;
  const engineKeys = Object.keys(keys).length
    ? Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v.value]))
    : undefined;
  assert.deepEqual(engineKeys, legacyKeys, `${label}: settings keys`);

  const groups = parseManifest(readOptional(join(dir, 'skills-manifest.txt')) ?? '');
  const legacySkills = groups.flatMap((g: { source: string; skills: string[]; exact: boolean; optional?: boolean }) =>
    g.skills.map((name) => ({ name, source: g.source, exact: g.exact, optional: g.optional === true })),
  );
  assert.deepEqual(
    config.skills.map((s) => ({ name: s.name, source: s.source, exact: s.exact, optional: s.optional })),
    legacySkills,
    `${label}: skills`,
  );
  assert.ok(config.skills.every((s) => s.install === !s.optional), `${label}: default selection`);

  const integrationsText = readOptional(join(dir, 'integrations.json'));
  const parsed = parseOrUndefined(integrationsText);
  const legacy =
    integrationsText === undefined
      ? { integrations: [], allow: {}, errors: [] }
      : parsed === undefined
        ? { integrations: [], allow: {}, errors: ['invalid json'] }
        : validateIntegrations(parsed, { repo: dir });
  assert.deepEqual(config.integrations.map((i) => i.declaration), legacy.integrations, `${label}: integrations`);
  assert.deepEqual(config.allow, legacy.allow, `${label}: allow`);
  assert.equal(
    config.issues.some((i) => i.source === 'integrations.json'),
    legacy.errors.length > 0,
    `${label}: integrations refusal`,
  );
  assert.ok(config.integrations.every((i) => i.enabled === i.declaration.default), `${label}: enabled`);
}

test('the built-in file table equals the CLI SYNC table', () => {
  assert.deepEqual(FILES.map(toSyncEntry), SYNC);
});

test("this repository's configuration resolves as the CLI reads it", async () => {
  const config = await load(REPO);
  assert.deepEqual(config.issues, []);
  assertDocumentsAgree(REPO, config, 'repo');
});

test('managed files match the CLI for every legacy state record', async () => {
  const states: Array<string | undefined> = [
    undefined,
    '{',
    '{"files":{}}',
    '{"files":{},"skillsOnly":true}',
    '{"files":{},"skillsOnly":"true"}',
    '{"skillsOnly":true}',
    '{"files":{},"configTargets":["claude"]}',
    '{"files":{},"configTargets":["codex"]}',
    '{"files":{},"configTargets":[]}',
    '{"files":{},"configTargets":["codex","codex"]}',
    '{"files":{},"configTargets":["cursor"]}',
    '{"files":{},"skillsOnly":true,"configTargets":["claude"]}',
  ];
  const saved = { state: process.env.NORTUSCC_STATE_DIR, claude: process.env.NORTUSCC_CLAUDE_DIR };
  for (const state of states) {
    await withTempDir(async (dir) => {
      const stateDir = join(dir, 'state');
      mkdirSync(stateDir);
      mkdirSync(join(dir, 'claude'));
      if (state !== undefined) writeFileSync(join(stateDir, 'state.json'), state);
      process.env.NORTUSCC_STATE_DIR = stateDir;
      process.env.NORTUSCC_CLAUDE_DIR = join(dir, 'claude');
      try {
        const mode = parseConfigMode([]);
        const expected = mode.manageConfig ? configEntries(SYNC, 'all', mode.configTargets) : [];
        const config = await load(REPO, overridesFromLegacyState(state));
        assert.deepEqual(config.files.filter((f) => f.managed).map(toSyncEntry), expected, String(state));
      } finally {
        if (saved.state === undefined) delete process.env.NORTUSCC_STATE_DIR;
        else process.env.NORTUSCC_STATE_DIR = saved.state;
        if (saved.claude === undefined) delete process.env.NORTUSCC_CLAUDE_DIR;
        else process.env.NORTUSCC_CLAUDE_DIR = saved.claude;
      }
    });
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

for (const [label, files] of Object.entries(FIXTURES)) {
  test(`fixture agrees with the CLI: ${label}`, () =>
    withTempDir(async (dir) => {
      for (const [relative, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, relative)), { recursive: true });
        writeFileSync(join(dir, relative), text);
      }
      assertDocumentsAgree(dir, await load(dir), label);
    }));
}
