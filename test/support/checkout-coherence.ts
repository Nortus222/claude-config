import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Only this new canonical temporary repository may reach real Git. No transport or checkout verbs.
export function coherenceFixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'nortuscc-coherence-')));
  const repo = join(home, 'repo');
  mkdirSync(repo);
  mkdirSync(join(home, 'empty-template'));
  const env = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'xdg'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0',
    GIT_TEMPLATE_DIR: join(home, 'empty-template'), GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: '/usr/bin/false',
    GIT_ASKPASS: '/usr/bin/false', SSH_ASKPASS: '/usr/bin/false',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  const allowed = new Set(['init', 'add', 'write-tree', 'commit-tree', 'update-ref', 'rev-parse', 'merge-base', 'show', 'diff', 'ls-tree', 'cat-file']);
  const git = (...args: string[]) => {
    assert.ok(home.startsWith(realpathSync(tmpdir()) + '/'));
    assert.equal(realpathSync(repo), repo);
    assert.ok(allowed.has(args[0]!), `forbidden fixture Git: ${args[0]}`);
    return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'commit.gpgSign=false', ...args], { cwd: repo, env, encoding: 'utf8' }).trim();
  };
  git('init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'claude'));
  writeFileSync(join(repo, 'claude', 'CLAUDE.md'), 'fixture rules\n');
  writeFileSync(join(repo, 'claude', 'settings.keys.json'), '{"fixture":true}\n');
  writeFileSync(join(repo, 'integrations.json'), '{"version":1,"integrations":[]}\n');
  writeFileSync(join(repo, 'skills-manifest.txt'), '');
  git('add', '.');
  const tree = git('write-tree');
  const A = git('commit-tree', tree, '-m', 'A');
  const B = git('commit-tree', tree, '-p', A, '-m', 'B');
  const C = git('commit-tree', tree, '-p', A, '-m', 'C');
  const D = git('commit-tree', tree, '-p', B, '-m', 'D');
  git('update-ref', 'refs/heads/main', A);
  const paths = { repo, claude: join(home, '.claude'), codex: join(home, '.codex'),
    codexOpenRouter: join(home, '.codex-openrouter'), agentsSkills: join(home, '.agents', 'skills'),
    stateRoot: join(home, '.config', 'nortuscc'), backups: join(home, '.config', 'nortuscc', 'backups') };
  const state = (applied: unknown = B) => {
    mkdirSync(paths.stateRoot, { recursive: true });
    writeFileSync(join(paths.stateRoot, 'state.json'), JSON.stringify({ version: 1, repo, files: {},
      ...(applied === undefined ? {} : { applied: { commit: applied, at: '2026-10-14T00:00:00.000Z' } }) }));
  };
  const index = () => readFileSync(join(repo, '.git', 'index'));
  return { home, repo, env, git, A, B, C, D, paths, state, index };
}
