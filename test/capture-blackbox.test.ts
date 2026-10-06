import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, machine, readJson, runCli, type Machine } from './support/cli.ts';

// `nortuscc capture` from the outside: a temp machine, a temp repo copy and fake installers.

const capture = (m: Machine, ...args: string[]) => runCli(m, ['capture', ...args]);
const apply = (m: Machine, ...args: string[]) => runCli(m, ['apply', ...args]);
const statePath = (m: Machine) => join(m.state, 'state.json');
const read = (path: string) => readFileSync(path, 'utf8');
// Repo paths capture changed in the working tree, relative to the repo.
const changed = (m: Machine) => git(m.repo, 'status', '--porcelain').split('\n').filter(Boolean).map((l) => l.replace(/^\s*\S+\s+/, '')).sort();

async function applied(): Promise<Machine> {
  const m = machine();
  const result = await apply(m);
  assert.equal(result.code, 0, result.stderr);
  return m;
}

// A store holding `installed`, a skill lock naming `lock`, and a repo manifest of `manifest`.
function skills(m: Machine, options: { installed: string[]; lock: Record<string, unknown>; manifest?: string }) {
  for (const name of options.installed) mkdirSync(join(m.agents, name), { recursive: true });
  mkdirSync(join(m.agents, '..'), { recursive: true });
  writeFileSync(join(m.agents, '..', '.skill-lock.json'), JSON.stringify({ skills: options.lock }));
  if (options.manifest !== undefined) writeFileSync(join(m.repo, 'skills-manifest.txt'), options.manifest);
}

test('a local edit is captured into the repo, naming the backup of the repo file it displaced', async () => {
  const m = await applied();
  const repoFile = join(m.repo, 'claude', 'CLAUDE.md');
  const before = read(repoFile);
  writeFileSync(join(m.claude, 'CLAUDE.md'), '# captured edit\n');

  const result = await capture(m);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(read(repoFile), '# captured edit\n');
  const backup = result.stdout.match(/CLAUDE\.md\s+copied\s+backed up -> (\S+)/);
  assert.ok(backup, result.stdout);
  assert.match(backup[1]!, /CLAUDE\.md\.repo$/);
  assert.equal(read(backup[1]!), before);
  // Only the instruction file moved; nothing else in the repo did.
  assert.deepEqual(changed(m), ['claude/CLAUDE.md']);
});

test('a clean capture captures nothing and does not rewrite state.json', async () => {
  const m = await applied();
  const bytes = read(statePath(m));
  const mtime = statSync(statePath(m)).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));

  const result = await capture(m);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^capture$/m);
  assert.doesNotMatch(result.stdout, /copied/);
  assert.equal(read(statePath(m)), bytes);
  assert.equal(statSync(statePath(m)).mtimeMs, mtime);
  assert.deepEqual(changed(m), []);
  assert.equal(existsSync(join(m.state, 'backups')), false);
});

test('a conflict is refused with exit 1; --take-local keeps the local version', async () => {
  const m = await applied();
  const repoFile = join(m.repo, 'claude', 'CLAUDE.md');
  writeFileSync(join(m.claude, 'CLAUDE.md'), '# local\n');
  writeFileSync(repoFile, '# repo\n');

  const refused = await capture(m);
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /CLAUDE\.md\s+refused\s+conflict — nothing changed/);
  assert.match(refused.stdout, /1 conflict\(s\) refused\. Use --take-local to keep the local version\./);
  assert.equal(read(repoFile), '# repo\n');

  const taken = await capture(m, '--take-local');
  assert.equal(taken.code, 0, taken.stderr);
  assert.match(taken.stdout, /CLAUDE\.md\s+copied/);
  assert.equal(read(repoFile), '# local\n');
});

test('--take-repo is refused on capture, alone or with --take-local', async () => {
  const m = await applied();
  const bytes = read(statePath(m));
  writeFileSync(join(m.claude, 'CLAUDE.md'), '# local\n');

  const alone = await capture(m, '--take-repo');
  assert.equal(alone.code, 2);
  assert.match(alone.stderr, /--take-repo has no effect on capture/);
  assert.match(alone.stderr, /nortuscc apply --take-repo/);

  const both = await capture(m, '--take-repo', '--take-local');
  assert.equal(both.code, 2);
  assert.match(both.stderr, /mutually exclusive/);

  assert.equal(read(statePath(m)), bytes);
  assert.deepEqual(changed(m), []);
});

test('an invalid --target exits 2 before anything is written', async () => {
  const m = await applied();
  writeFileSync(join(m.claude, 'CLAUDE.md'), '# local\n');
  const result = await capture(m, '--target', 'cursor');
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--target must be claude\|codex\|all/);
  assert.deepEqual(changed(m), []);
});

test('a local settings key is captured without adopting undeclared keys', async () => {
  const m = machine();
  const keys = join(m.repo, 'claude', 'settings.keys.json');
  writeFileSync(keys, JSON.stringify({ theme: 'auto' }) + '\n');
  mkdirSync(m.claude, { recursive: true });
  writeFileSync(join(m.claude, 'settings.json'), JSON.stringify({ theme: 'dark', permissions: { allow: [] } }) + '\n');

  const result = await capture(m, '--target', 'claude');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /settings\.json\s+copied/);
  assert.deepEqual(readJson(keys), { theme: 'dark' });
});

test('a local value that looks like a credential is refused and the repo file is left alone', async () => {
  const m = machine();
  const keys = join(m.repo, 'claude', 'settings.keys.json');
  writeFileSync(keys, JSON.stringify({ theme: 'auto' }) + '\n');
  assert.equal((await apply(m, '--target', 'claude')).code, 0);
  const before = read(keys);
  writeFileSync(join(m.claude, 'settings.json'), JSON.stringify({ theme: 'sk-abcdefgh12345678' }) + '\n');

  const result = await capture(m, '--target', 'claude');
  assert.equal(result.code, 1);
  assert.match(result.stdout, /settings\.json\s+refused\s+looks like a credential — nothing captured/);
  assert.match(result.stdout, /1 key\(s\) held a value that looks like a credential and were left uncaptured\./);
  assert.match(result.stdout, /fix the local value, then re-run capture/);
  // No flag can force a credential into a committed file, so none is offered.
  assert.doesNotMatch(result.stdout, /--take-local/);
  assert.equal(read(keys), before);
});

test('an unparseable local settings file is refused apart from conflicts', async () => {
  const m = await applied();
  writeFileSync(join(m.claude, 'settings.json'), '{ not json');
  const result = await capture(m);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /settings\.json\s+refused\s+could not be parsed as JSON/);
  assert.match(result.stdout, /1 settings file\(s\) could not be parsed/);
  assert.doesNotMatch(result.stdout, /--take-local/);
  assert.deepEqual(changed(m), []);
});

test('repo-owned files are never captured, even with --take-local', async () => {
  const m = await applied();
  const config = join(m.openrouter, 'config.toml');
  const repoConfig = join(m.repo, 'codex', 'openrouter-glm', 'config.toml');
  const before = read(repoConfig);
  writeFileSync(config, `${read(config)}\napi_key = "sk-or-secret"\n`);

  const result = await capture(m, '--target', 'codex', '--take-local');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /config\.toml\s+repo-owned\s+local changes are never captured/);
  assert.match(result.stdout, /models-static\.json\s+repo-owned\s+local changes are never captured/);
  assert.equal(read(repoConfig), before);
  assert.deepEqual(changed(m), []);
});

test('--target codex captures only Codex files and never writes claude/', async () => {
  const m = await applied();
  writeFileSync(join(m.claude, 'CLAUDE.md'), '# claude edit\n');
  writeFileSync(join(m.codex, 'AGENTS.md'), '# codex edit\n');

  const codex = await capture(m, '--target', 'codex');
  assert.equal(codex.code, 0, codex.stderr);
  assert.match(codex.stdout, /AGENTS\.md\s+copied/);
  assert.doesNotMatch(codex.stdout, /CLAUDE\.md/);
  assert.deepEqual(changed(m), ['codex/AGENTS.md']);

  const claude = await capture(m, '--target', 'claude');
  assert.equal(claude.code, 0, claude.stderr);
  assert.deepEqual(changed(m), ['claude/CLAUDE.md', 'codex/AGENTS.md']);
});

test('capture never adopts local integrations or MCP configuration into the repo', async () => {
  const m = await applied();
  const integrations = read(join(m.repo, 'integrations.json'));
  mkdirSync(join(m.claude, 'plugins'), { recursive: true });
  writeFileSync(
    join(m.claude, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'claude-mem@thedotmack': [{ scope: 'user', version: '13.13.1' }] } }),
  );
  writeFileSync(join(m.claude, 'plugins', 'known_marketplaces.json'), JSON.stringify({ thedotmack: {} }));
  writeFileSync(join(m.codex, 'config.toml'), '[mcp_servers.private]\ncommand="secret"\n');
  writeFileSync(join(m.codex, 'AGENTS.md'), '# codex edit\n');

  assert.equal((await capture(m)).code, 0);
  assert.equal(read(join(m.repo, 'integrations.json')), integrations);
  assert.deepEqual(changed(m), ['codex/AGENTS.md']);
});

test('the skills manifest is regenerated from installed skills, grouped by source, without local or ghost skills', async () => {
  const m = await applied();
  skills(m, {
    installed: ['alpha', 'beta', 'gamma', 'homegrown'],
    lock: { alpha: { source: 'foo/bar' }, beta: { source: 'foo/bar' }, gamma: { source: 'baz/qux' }, homegrown: {}, ghost: { source: 'foo/bar' } },
    manifest: '[foo/bar]\nalpha\n',
  });

  const result = await capture(m);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /skills-manifest\s+written\s+3 skill\(s\)/);
  const written = read(join(m.repo, 'skills-manifest.txt'));
  assert.match(written, /^# Regenerate with: nortuscc capture$/m);
  assert.ok(written.endsWith('[baz/qux]\ngamma\n\n[foo/bar]\nalpha\nbeta\n'), written);
  assert.doesNotMatch(written, /homegrown|ghost/);
  assert.deepEqual(changed(m), ['skills-manifest.txt']);
});

test('a smaller manifest is refused unless --allow-shrink, and ghosts cannot mask the shrink', async () => {
  const m = await applied();
  const manifest = '[foo/bar]\nalpha\nbeta\n';
  // beta is listed but not installed; two ghost lock entries would pad a lock-based count past the guard.
  skills(m, {
    installed: ['alpha'],
    lock: { alpha: { source: 'foo/bar' }, beta: { source: 'foo/bar' }, ghost1: { source: 'foo/bar' }, ghost2: { source: 'foo/bar' } },
    manifest,
  });

  const refused = await capture(m);
  assert.equal(refused.code, 0, refused.stderr);
  assert.match(refused.stdout, /skills-manifest\s+refused\s+would drop 1 entr\(ies\); pass --allow-shrink/);
  assert.equal(read(join(m.repo, 'skills-manifest.txt')), manifest);

  const shrunk = await capture(m, '--allow-shrink');
  assert.equal(shrunk.code, 0, shrunk.stderr);
  assert.match(shrunk.stdout, /skills-manifest\s+written\s+1 skill\(s\)/);
  assert.ok(read(join(m.repo, 'skills-manifest.txt')).endsWith('[foo/bar]\nalpha\n'));
});

test('a skills-only machine captures no configuration and records nothing', async () => {
  const m = await applied();
  // The machine's recorded choice, as a never-migrated state.json carries it.
  const state = readJson(statePath(m));
  writeFileSync(statePath(m), JSON.stringify({ ...state, skillsOnly: true }, null, 2) + '\n');
  writeFileSync(join(m.claude, 'CLAUDE.md'), '# local\n');

  const recorded = await capture(m);
  assert.equal(recorded.code, 0, recorded.stderr);
  assert.match(recorded.stdout, /configuration\s+skills-only\s+not managed on this machine/);
  assert.doesNotMatch(recorded.stdout, /CLAUDE\.md/);
  assert.deepEqual(changed(m), []);

  // The flag alone is honoured for the run and recorded nowhere.
  const flagged = await applied();
  writeFileSync(join(flagged.claude, 'CLAUDE.md'), '# local\n');
  const once = await capture(flagged, '--skills-only');
  assert.equal(once.code, 0, once.stderr);
  assert.match(once.stdout, /configuration\s+skills-only/);
  assert.deepEqual(changed(flagged), []);
  assert.equal(existsSync(join(flagged.state, 'overrides.json')), false);
  assert.equal('skillsOnly' in readJson(statePath(flagged)), false);
});
