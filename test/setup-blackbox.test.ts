import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { overridesFromLegacyState, type MachineOverrides } from '@nortuscc/profile-engine';
import { RUNTIME_INSTALL } from '../bin/launcher.mjs';
import { git, machine, readJson, REPO, runCli, type Machine } from './support/cli.ts';

// `nortuscc setup` from the outside: a temp machine, a temp repo, fake installers, and for the
// clone paths a fake `git` and a fake npm, so nothing reaches the network or the real home.

const statePath = (m: Machine) => join(m.state, 'state.json');
const overridesPath = (m: Machine) => join(m.state, 'overrides.json');
const read = (path: string) => readFileSync(path, 'utf8');
const lines = (path: string) => existsSync(path) ? read(path).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

// A `git` first on PATH that logs every argv, answers `clone <url> <dir>` by copying
// FAKE_GIT_SOURCE into <dir>, and passes everything else to the real git.
function fakeGit(m: Machine, source?: string): { env: Record<string, string>; calls: () => string[][] } {
  const dir = mkdtempSync(join(tmpdir(), 'nortuscc-fake-git-'));
  const log = join(m.home, 'git.log');
  const path = join(dir, 'git');
  writeFileSync(path, `#!/usr/bin/env node
import { appendFileSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + '\\n');
if (argv[0] === 'clone') {
  cpSync(process.env.FAKE_GIT_SOURCE, argv[argv.length - 1], { recursive: true });
  process.exit(0);
}
const real = spawnSync(${JSON.stringify(REAL_GIT)}, argv, { stdio: 'inherit' });
process.exit(real.status ?? 1);
`);
  chmodSync(path, 0o755);
  return {
    env: { PATH: `${dir}${delimiter}${m.bin}${delimiter}${process.env.PATH}`, ...(source ? { FAKE_GIT_SOURCE: source } : {}) },
    calls: () => lines(log),
  };
}

// A stand-in for npm's JS entry point: records each invocation's argv and cwd, installs nothing.
function fakeNpm(m: Machine): { env: Record<string, string>; calls: () => Array<{ args: string[]; cwd: string }> } {
  const cli = join(m.home, 'npm-cli.js');
  const log = join(m.home, 'npm.log');
  writeFileSync(cli, `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
`);
  return { env: { npm_execpath: cli }, calls: () => lines(log) };
}

// The machine's recorded config choice, wherever it is kept: overrides.json, else state.json's
// legacy fields (how the TypeScript commands read it).
function recordedChoice(m: Machine): MachineOverrides {
  if (existsSync(overridesPath(m))) {
    const { version: _version, ...value } = readJson(overridesPath(m));
    return value;
  }
  return overridesFromLegacyState(existsSync(statePath(m)) ? read(statePath(m)) : undefined).value;
}

const realpath = (p: string) => p.replace(/^\/private/, '');

test('setup --yes records the repo, then applies, installs and reports status', async () => {
  const m = machine();
  const result = await runCli(m, ['setup', '--yes']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(readJson(statePath(m)).repo, m.repo);
  assert.match(result.stdout, new RegExp(`repo: ${m.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(result.stdout, /commit: [0-9a-f]{7,}/);
  assert.equal(read(join(m.claude, 'CLAUDE.md')), read(join(m.repo, 'claude', 'CLAUDE.md')));
  const [beforeStatus, afterStatus] = result.stdout.split('--- status ---');
  assert.ok(afterStatus !== undefined, 'setup ends with its status report');
  assert.match(beforeStatus!, /CLAUDE\.md\s+copied/);
  assert.match(beforeStatus!, /\ninstall\n|nothing to install/);
  assert.match(afterStatus!, /\nconfig\n/);
});

// Shared by the conflict cases: a baseline, then both sides change CLAUDE.md.
async function conflicted(): Promise<Machine> {
  const m = machine();
  assert.equal((await runCli(m, ['setup', '--yes'])).code, 0);
  writeFileSync(join(m.claude, 'CLAUDE.md'), '# local change\n');
  writeFileSync(join(m.repo, 'claude', 'CLAUDE.md'), '# repo change\n');
  git(m.repo, 'commit', '-qam', 'repo change');
  return m;
}

test('a conflict stops setup with exit 1 before its status report', async () => {
  const m = await conflicted();
  const result = await runCli(m, ['setup', '--yes']);
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stdout, /--- status ---/);
  assert.equal(read(join(m.claude, 'CLAUDE.md')), '# local change\n');
});

test('setup --take-repo resolves the conflict in the repo\'s favour', async () => {
  const m = await conflicted();
  const result = await runCli(m, ['setup', '--yes', '--take-repo']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(read(join(m.claude, 'CLAUDE.md')), '# repo change\n');
});

// An interrupted clone leaves the directory behind; recording it would poison every later run.
test('--dir naming an existing directory that is not a checkout is refused and the record kept', async () => {
  const m = machine();
  mkdirSync(m.state, { recursive: true });
  writeFileSync(statePath(m), JSON.stringify({ version: 1, repo: m.repo, files: {} }));
  const partial = mkdtempSync(join(tmpdir(), 'nortuscc-interrupted-clone-'));
  writeFileSync(join(partial, 'partial'), 'left behind by an interrupted clone\n');

  const result = await runCli(m, ['setup', '--yes', '--dir', partial, '--repo', 'file:///nortuscc-never-cloned']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /exists but is not a git checkout/);
  assert.doesNotMatch(result.stdout, new RegExp(`repo: ${partial}`));
  assert.equal(readJson(statePath(m)).repo, m.repo);
});

test('--dir naming an existing checkout is used as it is, never cloned', async () => {
  const m = machine();
  const fake = fakeGit(m);
  const result = await runCli(m, ['setup', '--yes', '--dir', m.repo, '--repo', 'file:///nortuscc-never-cloned'], {
    env: { ...fake.env, NORTUSCC_REPO_DIR: '' },
  });
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.deepEqual(fake.calls().filter((argv) => argv.includes('clone')), []);
  assert.doesNotMatch(result.stdout, /cloning/);
  assert.equal(readJson(statePath(m)).repo, m.repo);
});

test('managed setup prints the T3 Code provider handoff without asking for a secret', async () => {
  const m = machine();
  const result = await runCli(m, ['setup', '--yes', '--target', 'codex']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /T3 Code provider handoff/);
  assert.match(result.stdout, /Codex · GLM Flash/);
  assert.match(result.stdout, /OPENROUTER_API_KEY/);
  assert.doesNotMatch(result.stdout, /sk-or-/);
});

test('setup --skills-only records the choice, writes no configuration and skips the handoff', async () => {
  const m = machine();
  const result = await runCli(m, ['setup', '--yes', '--skills-only']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.doesNotMatch(result.stdout, /T3 Code provider handoff/);
  assert.match(result.stdout, /skills-only: this machine keeps its own agent configuration/);
  assert.equal(existsSync(join(m.claude, 'CLAUDE.md')), false);
  assert.equal(existsSync(join(m.codex, 'AGENTS.md')), false);
  assert.equal(existsSync(join(m.openrouter, 'config.toml')), false);
  assert.equal(recordedChoice(m).manageConfig, false);
});

test('without a terminal and without --yes, setup refuses and changes nothing', async () => {
  const m = machine();
  const result = await runCli(m, ['setup']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--yes/);
  assert.equal(existsSync(statePath(m)), false);
  assert.equal(existsSync(join(m.claude, 'CLAUDE.md')), false);
});

// An npx copy runs from npm's cache under node_modules: it clones a durable checkout, installs its
// runtime and the global command from it, then hands the run to that checkout's own CLI.
test('an npx copy clones, installs the runtime and the command, then hands off to the checkout', { todo: 'lands with the launcher change' }, async () => {
  const m = machine();
  const copy = join(mkdtempSync(join(tmpdir(), 'nortuscc-npx-')), 'node_modules', 'nortuscc');
  mkdirSync(copy, { recursive: true });
  cpSync(join(REPO, 'bin'), join(copy, 'bin'), { recursive: true });
  cpSync(join(REPO, 'package.json'), join(copy, 'package.json'));

  // The repo the fake clone copies: the harness repo, its CLI a stub that records its argv.
  const source = join(m.home, 'source');
  cpSync(m.repo, source, { recursive: true });
  const handoffLog = join(m.home, 'handoff.log');
  mkdirSync(join(source, 'bin'), { recursive: true });
  writeFileSync(join(source, 'bin', 'nortuscc.mjs'), `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(handoffLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
`);
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'stub cli');

  const dest = join(m.home, 'claude-config');
  const fake = fakeGit(m, source);
  const npm = fakeNpm(m);
  const result = await runCli(m, ['setup', '--yes', '--dir', dest, '--repo', 'https://example.invalid/claude-config.git'], {
    bin: join(copy, 'bin', 'nortuscc.mjs'),
    env: { ...fake.env, ...npm.env, NORTUSCC_REPO_DIR: '' },
  });
  assert.equal(result.code, 0, result.stderr + result.stdout);

  assert.deepEqual(fake.calls().filter((argv) => argv[0] === 'clone'), [['clone', 'https://example.invalid/claude-config.git', dest]]);
  const calls = npm.calls();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]!.args, RUNTIME_INSTALL);
  assert.equal(realpath(calls[0]!.cwd), realpath(dest));
  assert.deepEqual(calls[1]!.args, ['install', '--global', '--no-audit', '--no-fund', dest]);
  assert.deepEqual(lines(handoffLog), [['setup', '--dir', dest, '--yes']]);
});
