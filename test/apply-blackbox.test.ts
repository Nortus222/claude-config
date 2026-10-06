import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { overridesFromLegacyState, type MachineOverrides } from '@nortuscc/profile-engine';
import { installerCalls, machine, probeCalls, readJson, runCli, type Machine } from './support/cli.ts';

// `nortuscc apply` from the outside: a temp machine, a temp repo and fake installers.

const apply = (m: Machine, ...args: string[]) => runCli(m, ['apply', ...args]);
const statePath = (m: Machine) => join(m.state, 'state.json');
const overridesPath = (m: Machine) => join(m.state, 'overrides.json');
const read = (path: string) => readFileSync(path, 'utf8');
const isEmpty = (dir: string) => !existsSync(dir) || readdirSync(dir).length === 0;

// The machine's recorded config choice, wherever it is kept: overrides.json, else state.json's
// legacy fields (how the TypeScript commands read it).
function recordedChoice(m: Machine): MachineOverrides {
  if (existsSync(overridesPath(m))) {
    const { version: _version, ...value } = readJson(overridesPath(m));
    return value;
  }
  return overridesFromLegacyState(existsSync(statePath(m)) ? read(statePath(m)) : undefined).value;
}

const declaredKeys = (m: Machine) => readJson(join(m.repo, 'claude', 'settings.keys.json'));

test('apply on a bare machine writes every managed file and baselines each', async () => {
  const m = machine();
  const result = await apply(m);
  assert.equal(result.code, 0, result.stderr);

  assert.equal(read(join(m.claude, 'CLAUDE.md')), read(join(m.repo, 'claude', 'CLAUDE.md')));
  assert.equal(read(join(m.codex, 'AGENTS.md')), read(join(m.repo, 'codex', 'AGENTS.md')));
  assert.deepEqual(readJson(join(m.claude, 'settings.json')), declaredKeys(m));
  assert.ok(existsSync(join(m.openrouter, 'config.toml')));
  assert.ok(existsSync(join(m.openrouter, 'models-static.json')));

  const state = readJson(statePath(m));
  assert.deepEqual(Object.keys(state.files).sort(), [
    'claude:CLAUDE.md',
    'codex:AGENTS.md',
    'codex:config.toml',
    'codex:models-static.json',
    ...Object.keys(declaredKeys(m)).map((k) => `claude:settings.json#${k}`),
  ].sort());
  for (const baseline of Object.values<{ hash: string }>(state.files)) assert.match(baseline.hash, /^sha256:/);

  assert.match(result.stdout, /CLAUDE\.md\s+copied/);
  assert.match(result.stdout, /Restart the affected agent/);
  // Nothing existed, so nothing needed backing up; and apply alone installs nothing.
  assert.equal(existsSync(join(m.state, 'backups')), false);
  assert.deepEqual(installerCalls(m), []);
});

test('a second apply exits 0, stays silent and does not rewrite state.json', async () => {
  const m = machine();
  assert.equal((await apply(m)).code, 0);
  const bytes = read(statePath(m));
  const mtime = statSync(statePath(m)).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));

  const second = await apply(m);
  assert.equal(second.code, 0, second.stderr);
  assert.doesNotMatch(second.stdout, /Restart the affected agent/);
  assert.doesNotMatch(second.stdout, /copied/);
  assert.equal(read(statePath(m)), bytes);
  assert.equal(statSync(statePath(m)).mtimeMs, mtime);
});

test('--target claude writes nothing for Codex, and --target codex nothing for Claude', async () => {
  const claudeOnly = machine();
  assert.equal((await apply(claudeOnly, '--target', 'claude')).code, 0);
  assert.ok(existsSync(join(claudeOnly.claude, 'CLAUDE.md')));
  assert.ok(isEmpty(claudeOnly.codex));
  assert.ok(isEmpty(claudeOnly.openrouter));

  const codexOnly = machine();
  assert.equal((await apply(codexOnly, '--target', 'codex')).code, 0);
  assert.ok(existsSync(join(codexOnly.codex, 'AGENTS.md')));
  assert.ok(isEmpty(codexOnly.claude));
});

test('--target claude --install --yes never reaches for the Codex CLI', async () => {
  const m = machine();
  const result = await apply(m, '--target', 'claude', '--install', '--yes');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(probeCalls(m), []);
  assert.deepEqual(installerCalls(m).filter((c) => c.cmd === 'codex'), []);
  for (const call of installerCalls(m).filter((c) => c.cmd === 'npx')) {
    const at = call.args.indexOf('--agent');
    assert.deepEqual(call.args.slice(at, at + 2), ['--agent', 'claude-code']);
    assert.notEqual(call.args[at + 2], 'codex');
  }
});

test('an invalid --target exits 2 before anything is written', async () => {
  const m = machine();
  const result = await apply(m, '--target', 'cursor');
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--target must be claude\|codex\|all/);
  assert.ok(isEmpty(m.claude));
  assert.ok(isEmpty(m.codex));
});

test('a local edit is left alone; a conflict is refused; --take-repo resolves it with a backup', async () => {
  const m = machine();
  assert.equal((await apply(m)).code, 0);
  const local = join(m.claude, 'CLAUDE.md');

  writeFileSync(local, '# edited locally\n');
  const kept = await apply(m);
  assert.equal(kept.code, 0, kept.stderr);
  assert.doesNotMatch(kept.stdout, /CLAUDE\.md\s+copied/);
  assert.equal(read(local), '# edited locally\n');

  writeFileSync(join(m.repo, 'claude', 'CLAUDE.md'), '# changed in the repo\n');
  const refused = await apply(m);
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /CLAUDE\.md\s+refused\s+conflict — nothing changed/);
  assert.match(refused.stdout, /1 conflict\(s\) refused/);
  assert.match(refused.stdout, /nortuscc apply --take-repo/);
  assert.equal(read(local), '# edited locally\n');

  const taken = await apply(m, '--take-repo');
  assert.equal(taken.code, 0, taken.stderr);
  assert.equal(read(local), '# changed in the repo\n');
  assert.match(taken.stdout, /CLAUDE\.md\s+copied\s+backed up -> /);
  assert.match(taken.stdout, /Restart the affected agent/);
  // --take-repo on a CLAUDE.md conflict forces nothing that was not in dispute.
  assert.doesNotMatch(taken.stdout, /settings\.json\s+copied/);
});

test('a configuration conflict stops apply --install before anything is installed', async () => {
  const m = machine();
  assert.equal((await apply(m)).code, 0);
  writeFileSync(join(m.claude, 'CLAUDE.md'), '# local\n');
  writeFileSync(join(m.repo, 'claude', 'CLAUDE.md'), '# repo\n');

  const result = await apply(m, '--install', '--yes');
  assert.equal(result.code, 1);
  assert.deepEqual(installerCalls(m), []);
});

test('an unparseable local settings.json is refused, reported apart from conflicts, and left untouched', async () => {
  const m = machine();
  assert.equal((await apply(m)).code, 0);
  const settings = join(m.claude, 'settings.json');
  writeFileSync(settings, '{ not json');

  const result = await apply(m);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /settings\.json\s+refused\s+could not be parsed as JSON/);
  assert.match(result.stdout, /1 settings file\(s\) could not be parsed/);
  // Neither flag can fix invalid JSON, so neither is offered.
  assert.doesNotMatch(result.stdout, /--take-repo/);
  assert.doesNotMatch(result.stdout, /--take-local/);
  assert.equal(read(settings), '{ not json');
});

test('apply sets the declared settings keys and leaves every other key alone', async () => {
  const m = machine();
  writeFileSync(join(m.repo, 'claude', 'settings.keys.json'), JSON.stringify({ theme: 'dark' }) + '\n');
  const settings = join(m.claude, 'settings.json');
  mkdirSync(m.claude, { recursive: true });
  writeFileSync(settings, JSON.stringify({ theme: 'auto', permissions: { allow: ['Bash(ls:*)'] } }) + '\n');

  const result = await apply(m);
  assert.equal(result.code, 0, result.stderr);
  const after = readJson(settings);
  assert.equal(after.theme, 'dark');
  assert.deepEqual(after.permissions, { allow: ['Bash(ls:*)'] });
});

test('--take-local is refused on apply, alone or with --take-repo', async () => {
  const m = machine();
  const alone = await apply(m, '--take-local');
  assert.equal(alone.code, 2);
  assert.match(alone.stderr, /has no effect on apply/);
  assert.match(alone.stderr, /capture --take-local/);

  const both = await apply(m, '--take-repo', '--take-local');
  assert.equal(both.code, 2);
  assert.match(both.stderr, /mutually exclusive/);
  assert.ok(isEmpty(m.claude));
});

test('--skills-only is recorded and honoured; --with-config manages config once', async () => {
  const m = machine();
  const skillsOnly = await apply(m, '--skills-only');
  assert.equal(skillsOnly.code, 0, skillsOnly.stderr);
  assert.match(skillsOnly.stdout, /configuration\s+skills-only\s+not managed on this machine/);
  assert.ok(isEmpty(m.claude));
  assert.ok(isEmpty(m.codex));
  assert.equal(recordedChoice(m).manageConfig, false);

  const plain = await apply(m);
  assert.equal(plain.code, 0, plain.stderr);
  assert.match(plain.stdout, /skills-only/);
  assert.ok(isEmpty(m.claude));

  const before = recordedChoice(m);
  const once = await apply(m, '--with-config');
  assert.equal(once.code, 0, once.stderr);
  assert.ok(existsSync(join(m.claude, 'CLAUDE.md')));
  assert.ok(existsSync(join(m.codex, 'AGENTS.md')));
  assert.deepEqual(recordedChoice(m), before);
});

test('--no-skills-only records config as managed again and writes it', async () => {
  const m = machine();
  assert.equal((await apply(m, '--skills-only')).code, 0);
  const result = await apply(m, '--no-skills-only');
  assert.equal(result.code, 0, result.stderr);
  assert.ok(existsSync(join(m.claude, 'CLAUDE.md')));
  const choice = recordedChoice(m);
  assert.notEqual(choice.manageConfig, false);
  assert.equal(choice.configTargets, undefined);
});

test('the config choice apply records lives in overrides.json', { todo: 'cutover' }, async () => {
  const m = machine();
  assert.equal((await apply(m, '--skills-only')).code, 0);
  assert.equal(readJson(overridesPath(m)).manageConfig, false);
  assert.equal((await apply(m, '--no-skills-only')).code, 0);
  const overrides = readJson(overridesPath(m));
  assert.equal(overrides.manageConfig, true);
  assert.equal(overrides.configTargets, undefined);
});

test('a legacy skills-only state.json is honoured and migrated into overrides.json', { todo: 'cutover' }, async () => {
  const m = machine();
  mkdirSync(m.state, { recursive: true });
  writeFileSync(statePath(m), JSON.stringify({ version: 1, repo: null, skillsOnly: true, files: {} }, null, 2) + '\n');

  const result = await apply(m);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(isEmpty(m.claude));
  assert.ok(isEmpty(m.codex));
  assert.equal(readJson(overridesPath(m)).manageConfig, false);
  assert.equal('skillsOnly' in readJson(statePath(m)), false);
});

test('apply --install --yes on a fresh machine installs the declared defaults', async () => {
  const m = machine();
  const result = await apply(m, '--install', '--yes');
  assert.equal(result.code, 0, result.stderr);

  const calls = installerCalls(m);
  assert.deepEqual(calls.filter((c) => c.cmd !== 'npx'), [
    { cmd: 'claude', args: ['plugin', 'install', 'superpowers@claude-plugins-official'] },
    { cmd: 'codex', args: ['plugin', 'add', 'superpowers@openai-curated'] },
  ]);
  const adds = calls.filter((c) => c.cmd === 'npx');
  assert.ok(adds.length > 0);
  for (const call of adds) {
    assert.deepEqual(call.args.slice(0, 3), ['-y', 'skills', 'add']);
    const at = call.args.indexOf('--agent');
    assert.deepEqual(call.args.slice(at, at + 3), ['--agent', 'claude-code', 'codex']);
  }
  const sources = adds.map((c) => c.args[3]);
  assert.deepEqual([...new Set(sources)], sources, 'one call per source');
  // Optional skills are offered, never installed by --yes.
  assert.ok(!sources.includes('Nortus222/agent-skills'));
  assert.match(result.stdout, /^install$/m);
  assert.match(result.stdout, /superpowers\s+installed/);

  const again = await apply(m, '--install', '--yes');
  assert.equal(again.code, 0, again.stderr);
  assert.equal(installerCalls(m).length, calls.length, 'a satisfied machine installs nothing');
});

test('apply --install --yes --no-plugins --no-skills runs no installer and still writes config', async () => {
  const m = machine();
  const result = await apply(m, '--install', '--yes', '--no-plugins', '--no-skills');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(installerCalls(m), []);
  assert.ok(existsSync(join(m.claude, 'CLAUDE.md')));
});

test('apply --install with no terminal and no --yes refuses with exit 2', async () => {
  const m = machine();
  const result = await apply(m, '--install');
  assert.equal(result.code, 2);
  assert.match(result.stderr, /no terminal to choose on/);
  assert.match(result.stderr, /--yes/);
  assert.deepEqual(installerCalls(m), []);
});

test('apply --skills is deprecated and installs the required skills', async () => {
  const m = machine();
  const result = await apply(m, '--skills');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /--skills is deprecated; use 'nortuscc apply --install --no-hooks --no-mcp --no-plugins'/);
  const calls = installerCalls(m);
  assert.ok(calls.length > 0);
  assert.ok(calls.every((c) => c.cmd === 'npx'), 'skills only: no plugin installer runs');
});

test('an unknown --no-* opt-out exits 2 and names the valid ones', async () => {
  const m = machine();
  const result = await apply(m, '--install', '--no-foo');
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unknown option --no-foo \(expected one of --no-hooks, --no-mcp, --no-plugins, --no-skills\)/);
  assert.deepEqual(installerCalls(m), []);
});
