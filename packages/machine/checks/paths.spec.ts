import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Exit } from 'effect';
import { homeDir, pathsFromEnvironment, RepoNotFound } from '../src/index.ts';

const scratch = () => mkdtempSync(join(tmpdir(), 'machine-paths-'));
const checkout = (dir: string) => { mkdirSync(join(dir, '.git'), { recursive: true }); return dir; };
const resolve = (input: Parameters<typeof pathsFromEnvironment>[0]) => Effect.runPromise(pathsFromEnvironment(input));

test('defaults live under the home directory', async () => {
  const home = scratch();
  const paths = await resolve({ env: {}, home, platform: 'darwin', fallbackRepo: '/cli' });
  assert.deepEqual(paths, {
    repo: '/cli',
    claude: join(home, '.claude'),
    codex: join(home, '.codex'),
    codexOpenRouter: join(home, '.codex-openrouter'),
    agentsSkills: join(home, '.agents', 'skills'),
    stateRoot: join(home, '.config', 'nortuscc'),
    backups: join(home, '.config', 'nortuscc', 'backups'),
  });
});

test('every NORTUSCC_ variable overrides its path', async () => {
  const paths = await resolve({
    env: {
      NORTUSCC_REPO_DIR: '/r', NORTUSCC_CLAUDE_DIR: '/c', NORTUSCC_CODEX_DIR: '/x/.codex',
      NORTUSCC_AGENTS_DIR: '/a', NORTUSCC_STATE_DIR: '/s',
    },
    home: scratch(), platform: 'linux',
  });
  assert.equal(paths.repo, '/r');
  assert.equal(paths.claude, '/c');
  assert.equal(paths.codex, '/x/.codex');
  assert.equal(paths.codexOpenRouter, '/x/.codex-openrouter');
  assert.equal(paths.agentsSkills, '/a');
  assert.equal(paths.backups, '/s/backups');
});

test('the OpenRouter variable beats the Codex sibling rule', async () => {
  const paths = await resolve({
    env: { NORTUSCC_CODEX_DIR: '/x/.codex', NORTUSCC_OPENROUTER_CODEX_DIR: '/o' }, home: scratch(), platform: 'linux', fallbackRepo: '/cli',
  });
  assert.equal(paths.codexOpenRouter, '/o');
});

test('windows keeps state under APPDATA', async () => {
  const paths = await resolve({ env: { APPDATA: '/appdata' }, home: scratch(), platform: 'win32', fallbackRepo: '/cli' });
  assert.equal(paths.stateRoot, join('/appdata', 'nortuscc'));
});

test('the recorded repo is used when it is a git checkout', async () => {
  const home = scratch();
  const repo = checkout(join(home, 'claude-config'));
  mkdirSync(join(home, '.config', 'nortuscc'), { recursive: true });
  writeFileSync(join(home, '.config', 'nortuscc', 'state.json'), JSON.stringify({ repo, files: {} }));
  assert.equal((await resolve({ env: {}, home, platform: 'darwin', fallbackRepo: '/cli' })).repo, repo);
});

test('a stale record warns once and falls back', async () => {
  const home = scratch();
  mkdirSync(join(home, '.config', 'nortuscc'), { recursive: true });
  writeFileSync(join(home, '.config', 'nortuscc', 'state.json'), JSON.stringify({ repo: '/gone', files: {} }));
  const warnings: string[] = [];
  const paths = await resolve({ env: {}, home, platform: 'darwin', fallbackRepo: '/cli', warn: (m) => warnings.push(m) });
  assert.equal(paths.repo, '/cli');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /'\/gone' is not a git checkout/);
});

test('a corrupt state file falls through to the legacy lock', async () => {
  const home = scratch();
  const repo = checkout(join(home, 'legacy-checkout'));
  mkdirSync(join(home, '.config', 'nortuscc'), { recursive: true });
  writeFileSync(join(home, '.config', 'nortuscc', 'state.json'), '{not json');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', '.nortuscc-lock.json'), JSON.stringify({ repo }));
  assert.equal((await resolve({ env: {}, home, platform: 'darwin' })).repo, repo);
});

test('no record and no fallback fails with RepoNotFound', async () => {
  const exit = await Effect.runPromiseExit(pathsFromEnvironment({ env: {}, home: scratch(), platform: 'darwin' }));
  assert.ok(Exit.isFailure(exit));
  assert.ok(Exit.isFailure(exit) && String(exit.cause).includes('RepoNotFound'));
  assert.ok(RepoNotFound);
});

test('homeDir maps an engine home to its directory', async () => {
  const paths = await resolve({ env: {}, home: '/h', platform: 'linux', fallbackRepo: '/cli' });
  assert.equal(homeDir(paths, 'codex-openrouter'), '/h/.codex-openrouter');
  assert.equal(homeDir(paths, 'claude'), '/h/.claude');
});
