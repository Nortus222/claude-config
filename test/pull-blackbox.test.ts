import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNTIME_INSTALL } from '../bin/launcher.mjs';
import { git, installerCalls, machine, readJson, runCli, type Machine } from './support/cli.ts';

// `nortuscc pull` from the outside: a temp machine, a temp repo cloned from a bare origin that a
// second clone advances, fake installers, and a fake npm so no real install ever runs.

const origin = (m: Machine) => join(m.home, 'origin.git');

// Commits `files` on origin from a second clone, as another machine pushing would.
function upstream(m: Machine, files: Record<string, string>, message = 'upstream change'): void {
  const other = join(m.home, 'other');
  if (!existsSync(other)) git(m.home, 'clone', '-q', origin(m), other);
  else git(other, 'pull', '-q');
  for (const [path, text] of Object.entries(files)) writeFileSync(join(other, path), text);
  git(other, 'add', '.');
  git(other, 'commit', '-qm', message);
  git(other, 'push', '-q');
}

// A stand-in for npm's JS entry point: records each invocation's argv and cwd, installs nothing.
function fakeNpm(m: Machine): { env: Record<string, string>; calls: () => Array<{ args: string[]; cwd: string }> } {
  const cli = join(m.home, 'npm-cli.js');
  const log = join(m.home, 'npm.log');
  writeFileSync(cli, `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
`);
  return {
    env: { npm_execpath: cli },
    calls: () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [],
  };
}

const pull = (m: Machine, args: string[] = [], env: Record<string, string> = {}) => runCli(m, ['pull', ...args], { env });

test('a fast-forward applies main when Git defaults to another branch', async (t) => {
  const env = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'init.defaultBranch',
    GIT_CONFIG_VALUE_0: 'alternate-main',
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, env);
  const m = machine();
  t.after(() => {
    rmSync(m.home, { recursive: true, force: true });
    rmSync(m.bin, { recursive: true, force: true });
  });
  upstream(m, { 'claude/CLAUDE.md': '# from main\n' });

  const result = await pull(m);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readFileSync(join(m.claude, 'CLAUDE.md'), 'utf8').replace(/\r\n/g, '\n'), '# from main\n');
  assert.equal(git(m.repo, 'rev-parse', 'HEAD'), git(origin(m), 'rev-parse', 'main'));
});

test('a fast-forward from origin is applied to the machine', async () => {
  const m = machine();
  upstream(m, { 'claude/CLAUDE.md': '# from another machine\n' });

  const result = await pull(m);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readFileSync(join(m.claude, 'CLAUDE.md'), 'utf8'), '# from another machine\n');
  assert.equal(git(m.repo, 'rev-parse', 'HEAD'), git(origin(m), 'rev-parse', 'main'));
});

test('a diverged origin exits 1 with the two-line message, no stack trace, and never applies', async () => {
  const m = machine();
  upstream(m, { 'claude/CLAUDE.md': '# from another machine\n' });
  writeFileSync(join(m.repo, 'claude', 'CLAUDE.md'), '# local unpushed change\n');
  git(m.repo, 'commit', '-qam', 'local unpushed change');
  const head = git(m.repo, 'rev-parse', 'HEAD');

  const result = await pull(m);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\nnortuscc: the checkout cannot fast-forward to its upstream\.\nThe remote has diverged; resolve it in the repo before applying\./);
  assert.doesNotMatch(result.stderr, /at\s+.*:\d+:\d+/);
  assert.equal(git(m.repo, 'rev-parse', 'HEAD'), head);
  assert.equal(existsSync(join(m.claude, 'CLAUDE.md')), false, 'apply must never run after a failed pull');
});

test('a changed package-lock.json reinstalls the runtime in the repo before applying', async () => {
  const m = machine();
  const npm = fakeNpm(m);
  const lock = readJson(join(m.repo, 'package-lock.json'));
  upstream(m, {
    'package-lock.json': JSON.stringify({ ...lock, name: 'nortuscc-changed' }, null, 2) + '\n',
    'claude/CLAUDE.md': '# with a new lockfile\n',
  });

  const result = await pull(m, [], npm.env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /nortuscc: package-lock\.json changed; reinstalling runtime dependencies/);
  const calls = npm.calls();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.args, RUNTIME_INSTALL);
  assert.equal(calls[0]!.args.slice(0, 2).join(' '), 'ci --omit=dev');
  assert.equal(calls[0]!.cwd.replace(/^\/private/, ''), m.repo.replace(/^\/private/, ''));
  assert.equal(readFileSync(join(m.claude, 'CLAUDE.md'), 'utf8'), '# with a new lockfile\n');
});

test('a failed runtime reinstall exits 1 naming the command, and never applies', async () => {
  const m = machine();
  const cli = join(m.home, 'npm-fails.js');
  writeFileSync(cli, 'process.exit(3);\n');
  const lock = readJson(join(m.repo, 'package-lock.json'));
  upstream(m, { 'package-lock.json': JSON.stringify({ ...lock, name: 'nortuscc-changed' }, null, 2) + '\n' });

  const result = await pull(m, [], { npm_execpath: cli });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /nortuscc: could not install dependencies \(npm exited with 3\); run 'npm ci --omit=dev .*' in /);
  assert.equal(existsSync(join(m.claude, 'CLAUDE.md')), false);
});

test('an unchanged package-lock.json installs nothing', async () => {
  const m = machine();
  const npm = fakeNpm(m);
  upstream(m, { 'claude/CLAUDE.md': '# only rules changed\n' });

  const result = await pull(m, [], npm.env);
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /reinstalling runtime dependencies/);
  assert.deepEqual(npm.calls(), []);
});

test('an invalid --target exits 2 before anything is pulled', async () => {
  const m = machine();
  upstream(m, { 'claude/CLAUDE.md': '# not yet\n' });
  const head = git(m.repo, 'rev-parse', 'HEAD');

  const result = await pull(m, ['--target', 'bogus']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /nortuscc: /);
  assert.equal(git(m.repo, 'rev-parse', 'HEAD'), head);
  assert.equal(existsSync(join(m.claude, 'CLAUDE.md')), false);
});

test('a newly declared integration upstream is reported with its fix, not installed', async () => {
  const m = machine();
  const document = readJson(join(m.repo, 'integrations.json'));
  document.integrations.push({
    id: 'pull-test', label: 'pull-test-plugin', target: 'claude', type: 'plugin', default: true, plugin: 'pull-test@pull-test',
  });
  upstream(m, { 'integrations.json': JSON.stringify(document, null, 2) + '\n' });

  const result = await pull(m);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^integrations$/m);
  assert.match(result.stdout, /pull-test-plugin/);
  assert.match(result.stdout, /nortuscc apply --install/);
  assert.deepEqual(installerCalls(m), []);
});

test('an invalid integrations.json upstream is reported as an invalid manifest after applying', async () => {
  const m = machine();
  upstream(m, {
    'integrations.json': JSON.stringify({ version: 1, integrations: [{ id: 'x', label: 'x', target: 'cursor', type: 'plugin', default: true, plugin: 'a@b' }] }) + '\n',
  });

  const result = await pull(m);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^apply$/m);
  assert.equal(readFileSync(join(m.claude, 'CLAUDE.md'), 'utf8'), readFileSync(join(m.repo, 'claude', 'CLAUDE.md'), 'utf8'));
  assert.match(result.stdout, /^integrations$/m);
  assert.match(result.stdout, /manifest\s+invalid/);
  assert.doesNotMatch(result.stdout, /nortuscc apply --install/);
  assert.deepEqual(installerCalls(m), []);
});

test('--install skips the pending-integrations report', async () => {
  const m = machine();
  const result = await pull(m, ['--install', '--yes', '--no-hooks', '--no-mcp', '--no-plugins', '--no-skills']);
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /^ {2}nortuscc apply --install$/m);
});

test('arguments reach apply: --take-repo resolves a conflict', async () => {
  const m = machine();
  assert.equal((await runCli(m, ['apply'])).code, 0);
  writeFileSync(join(m.claude, 'CLAUDE.md'), '# local change\n');
  writeFileSync(join(m.repo, 'claude', 'CLAUDE.md'), '# repo change\n');
  git(m.repo, 'commit', '-qam', 'repo change');

  const refused = await pull(m);
  assert.equal(refused.code, 1);
  assert.equal(readFileSync(join(m.claude, 'CLAUDE.md'), 'utf8'), '# local change\n');

  const taken = await pull(m, ['--take-repo']);
  assert.equal(taken.code, 0, taken.stderr);
  assert.equal(readFileSync(join(m.claude, 'CLAUDE.md'), 'utf8'), '# repo change\n');
});

test('--target narrows the apply to that agent', async () => {
  const m = machine();
  upstream(m, { 'claude/CLAUDE.md': '# claude\n', 'codex/AGENTS.md': '# codex\n' });

  const result = await pull(m, ['--target', 'codex']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readFileSync(join(m.codex, 'AGENTS.md'), 'utf8'), '# codex\n');
  assert.equal(existsSync(join(m.claude, 'CLAUDE.md')), false);
});

test('an invalid overrides.json refuses pull with exit 1 before the repo moves', async () => {
  const m = machine();
  upstream(m, { 'claude/CLAUDE.md': '# from another machine\n' });
  const head = git(m.repo, 'rev-parse', 'HEAD');
  mkdirSync(m.state, { recursive: true });
  writeFileSync(join(m.state, 'overrides.json'), '{ "version": 1, "manageConfig": false, }\n');

  const result = await pull(m);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /overrides\.json: not valid JSON/);
  assert.match(result.stderr, /overrides\.json is not valid, so nothing was changed; fix it by hand and re-run\./);
  assert.equal(git(m.repo, 'rev-parse', 'HEAD'), head);
  assert.equal(existsSync(join(m.claude, 'CLAUDE.md')), false);
});
