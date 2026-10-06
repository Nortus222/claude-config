import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseConfigMode, persisted, resolveConfigMode, SKILLS_ONLY, WITH_CONFIG_ALWAYS, WITH_CONFIG_ONCE,
} from '../src/config-mode.ts';

const resolve = (args: string[], overrides = {}) => resolveConfigMode(parseConfigMode(args), overrides);

// --- flag parsing ------------------------------------------------------------

// Global flags, like --target: a command that never heard of them must not
// report them as unknown options, so they never reach its own parser.
test('the mode flags are stripped from what the command parses', () => {
  const { rest } = parseConfigMode(['--target', 'claude', SKILLS_ONLY, '--yes', WITH_CONFIG_ONCE]);
  assert.deepEqual(rest, ['--target', 'claude', '--yes']);
});

test('no mode flag records nothing', () => {
  assert.deepEqual(parseConfigMode(['--yes']), { rest: ['--yes'], persist: null, once: false });
});

// --- resolution --------------------------------------------------------------

test('a recorded skills-only machine manages no config', () => {
  const mode = parseConfigMode([]);
  assert.equal(resolveConfigMode(mode, { manageConfig: false }).manageConfig, false);
  assert.equal(mode.persist, null, 'reading the mode is not recording it');
  assert.equal(persisted(mode, { manageConfig: false }), undefined);
});

test('a machine that never set the mode manages config for both agents', () => {
  const { manageConfig, configTargets, overrides } = resolve([]);
  assert.equal(manageConfig, true);
  assert.deepEqual(configTargets, ['claude', 'codex']);
  assert.deepEqual(overrides, {});
});

// Setting the mode has to apply to the run that sets it, or `setup
// --skills-only` would sync the instruction files once on its way to recording
// that it should never sync them.
test('--skills-only takes effect on the very run that records it', () => {
  const mode = parseConfigMode([SKILLS_ONLY]);
  const run = resolveConfigMode(mode, {});
  assert.equal(run.manageConfig, false);
  assert.equal(run.overrides.manageConfig, false, 'the run loads its profile with config unmanaged');
  assert.equal(mode.persist, true);
  assert.deepEqual(persisted(mode, {}), { manageConfig: false });
});

test('--skills-only keeps the rest of the recorded overrides', () => {
  const recorded = { configTargets: ['claude' as const], skills: { a: false } };
  assert.deepEqual(persisted(parseConfigMode([SKILLS_ONLY]), recorded), { ...recorded, manageConfig: false });
});

test('--no-skills-only records the mode off and manages both agents again', () => {
  const mode = parseConfigMode([WITH_CONFIG_ALWAYS]);
  const recorded = { manageConfig: false, configTargets: ['claude' as const], skills: { a: false } };
  const run = resolveConfigMode(mode, recorded);
  assert.equal(run.manageConfig, true);
  assert.deepEqual(run.configTargets, ['claude', 'codex']);
  assert.deepEqual(run.overrides, { skills: { a: false } });
  assert.equal(mode.persist, false);
  assert.deepEqual(persisted(mode, recorded), { skills: { a: false }, manageConfig: true });
});

// The per-run override widens one run without changing what the next one does.
test('--with-config overrides the recorded mode without recording anything', () => {
  const mode = parseConfigMode([WITH_CONFIG_ONCE]);
  const run = resolveConfigMode(mode, { manageConfig: false });
  assert.equal(run.manageConfig, true);
  assert.equal(run.overrides.manageConfig, undefined);
  assert.equal(mode.persist, null, 'a one-off override must not persist');
  assert.equal(persisted(mode, { manageConfig: false }), undefined);
});

test('a saved Claude selection narrows the run to Claude', () => {
  const run = resolve([], { configTargets: ['claude'] });
  assert.equal(run.manageConfig, true);
  assert.deepEqual(run.configTargets, ['claude']);
  assert.deepEqual(run.overrides, { configTargets: ['claude'] });
});

test('--with-config widens a saved Claude selection for one run and keeps the record', () => {
  const recorded = { configTargets: ['claude' as const] };
  const mode = parseConfigMode([WITH_CONFIG_ONCE]);
  const run = resolveConfigMode(mode, recorded);
  assert.deepEqual(run.configTargets, ['claude', 'codex']);
  assert.equal(run.overrides.configTargets, undefined);
  assert.equal(persisted(mode, recorded), undefined, 'one-time override keeps the saved selection');
});

test('the resolved targets are a fresh array each call', () => {
  const a = resolve([]).configTargets;
  a.push('claude');
  assert.deepEqual(resolve([]).configTargets, ['claude', 'codex']);
});
