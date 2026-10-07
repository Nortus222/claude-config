import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseSkillsManifest } from '@nortuscc/profile-engine';
import { git, installerCalls, machine, readJson, runCli, writeFakeBin, type Machine } from './support/cli.ts';

// update, setup, uninstall, capture and push with held items (sync.json written by hand; `nortuscc sync` writes it).

const EFFORT = 'setting:claude:settings.json#effortLevel';
const KEYS = (m: Machine) => join(m.repo, 'claude', 'settings.keys.json');

const hold = (m: Machine, held: Record<string, string>) => {
  mkdirSync(m.state, { recursive: true });
  writeFileSync(join(m.state, 'sync.json'), JSON.stringify({ version: 1, held }, null, 2) + '\n');
};

// Commits settings.keys.json changed by `change` (unpushed, so the CLI stays current); answers the commit before it.
const commitKeys = (m: Machine, change: (keys: Record<string, unknown>) => Record<string, unknown>): string => {
  const before = git(m.repo, 'rev-parse', 'HEAD');
  writeFileSync(KEYS(m), JSON.stringify(change(readJson(KEYS(m))), null, 2) + '\n');
  git(m.repo, 'commit', '-qam', 'settings change');
  return before;
};

test('setup keeps a held settings key at its held value', async () => {
  const m = machine();
  const old = readJson(KEYS(m)).effortLevel;
  hold(m, { [EFFORT]: commitKeys(m, (k) => ({ ...k, effortLevel: 'medium' })) });
  const result = await runCli(m, ['setup', '--yes']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(readJson(join(m.claude, 'settings.json')).effortLevel, old);
});

test('uninstall sees a held key the checkout dropped, and refuses it changed locally', async () => {
  const m = machine();
  hold(m, { [EFFORT]: commitKeys(m, ({ effortLevel: _dropped, ...rest }) => rest) });
  const applied = await runCli(m, ['apply']);
  assert.equal(applied.code, 0, applied.stderr);
  const settings = join(m.claude, 'settings.json');
  writeFileSync(settings, JSON.stringify({ ...readJson(settings), effortLevel: 'mine' }, null, 2) + '\n');
  const result = await runCli(m, ['uninstall', '--yes']);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /settings\.json\s+changed/);
  assert.equal(readJson(settings).effortLevel, 'mine');
});

test('an invalid sync.json refuses uninstall and is left as it was', async () => {
  const m = machine();
  mkdirSync(m.state, { recursive: true });
  const text = '{ "version": 1, "held": { "nonsense": "x" } }\n';
  writeFileSync(join(m.state, 'sync.json'), text);
  const result = await runCli(m, ['uninstall', '--yes']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /sync\.json is not valid/);
  assert.equal(readFileSync(join(m.state, 'sync.json'), 'utf8'), text);
});

// `pinme` from a local upstream `o/r`, installed at `sha` and pinned there in a committed checkout. Answers that commit.
function pinnedSkill(m: Machine): { sha: string; upstream: string; pinned: string } {
  const upstream = mkdtempSync(join(tmpdir(), 'nortuscc-holds-upstream-'));
  git(upstream, 'init', '-q');
  mkdirSync(join(upstream, 's', 'pinme'), { recursive: true });
  writeFileSync(join(upstream, 's', 'pinme', 'SKILL.md'), '# pinme\n');
  git(upstream, 'add', '.');
  git(upstream, 'commit', '-qm', 'pinme');
  const sha = git(upstream, 'rev-parse', 'HEAD');
  writeFileSync(join(m.repo, 'skills-manifest.txt'), '[o/r]\npinme\n');
  writeFileSync(join(m.repo, 'skill-pins.json'), JSON.stringify({ version: 1, pins: { 'o/r': sha } }, null, 2) + '\n');
  git(m.repo, 'add', '.');
  git(m.repo, 'commit', '-qm', 'pin pinme');
  const stored = join(m.agents, 'pinme');
  mkdirSync(stored, { recursive: true });
  writeFileSync(join(stored, 'SKILL.md'), '# pinme\n');
  mkdirSync(join(m.claude, 'skills'), { recursive: true });
  symlinkSync(stored, join(m.claude, 'skills', 'pinme'), 'dir');
  mkdirSync(join(m.codex, 'skills', 'pinme'), { recursive: true });
  writeFileSync(join(dirname(m.agents), '.skill-lock.json'), JSON.stringify({ skills: { pinme: {
    source: 'o/r', sourceUrl: `file://${upstream}`, skillPath: 's/pinme/SKILL.md', skillFolderHash: 'x', ref: sha,
  } } }));
  return { sha, upstream, pinned: git(m.repo, 'rev-parse', 'HEAD') };
}

test('update leaves a skill held at an older pin alone', async () => {
  const m = machine();
  const { pinned } = pinnedSkill(m);
  writeFileSync(join(m.repo, 'skill-pins.json'), JSON.stringify({ version: 1, pins: { 'o/r': 'b'.repeat(40) } }, null, 2) + '\n');
  git(m.repo, 'commit', '-qam', 'move the pin');
  hold(m, { 'skill:o/r/pinme': pinned });
  const result = await runCli(m, ['update', '--check']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /off-pin/);
});

// Without the hold, pinme reads `gone`: the checkout dropped its pin, upstream deleted it, and the lock records no ref.
function goneUnlessHeld(m: Machine): void {
  const { pinned, upstream } = pinnedSkill(m);
  git(upstream, 'rm', '-rq', 's/pinme');
  git(upstream, 'commit', '-qm', 'delete pinme');
  writeFileSync(join(m.repo, 'skill-pins.json'), JSON.stringify({ version: 1, pins: {} }, null, 2) + '\n');
  git(m.repo, 'commit', '-qam', 'drop the pin');
  const lockPath = join(dirname(m.agents), '.skill-lock.json');
  const lock = readJson(lockPath);
  delete lock.skills.pinme.ref;
  writeFileSync(lockPath, JSON.stringify(lock));
  hold(m, { 'skill:o/r/pinme': pinned });
}

// --check, not --yes --prune: with the hold, pinme reads off-pin (the lock records no ref), and the default
// fake npx cannot model the pinned reinstall that --yes would run.
test('update --check does not report a held skill as gone, nor offer to prune it', async () => {
  const m = machine();
  goneUnlessHeld(m);
  const result = await runCli(m, ['update', '--check']);
  assert.doesNotMatch(result.stdout, /gone/);
  assert.doesNotMatch(result.stdout, /--prune/);
});

test('an invalid sync.json refuses update', async () => {
  const m = machine();
  mkdirSync(m.state, { recursive: true });
  writeFileSync(join(m.state, 'sync.json'), '{ "version": 2 }\n');
  const result = await runCli(m, ['update', '--check']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /sync\.json is not valid/);
});

// Installs like the real installer on `-y skills add <source> --skill <names…> --agent <agents…>`: a store
// folder, a lock entry from `u/v` (NORTUSCC_TEST_UV_URL), and a Claude link. Other verbs exit 0.
const UV_NPX = `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
const argv = process.argv.slice(2);
if (argv[0] === '-y' && argv[1] === 'skills' && argv[2] === 'add') {
  appendFileSync(process.env.NORTUSCC_TEST_LOG, JSON.stringify({ cmd: 'npx', args: argv }) + '\\n');
  const after = (flag) => { const out = []; for (let i = argv.indexOf(flag) + 1; i > 0 && i < argv.length && !argv[i].startsWith('--'); i++) out.push(argv[i]); return out; };
  const store = process.env.NORTUSCC_AGENTS_DIR;
  const lockPath = join(dirname(store), '.skill-lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const url = process.env.NORTUSCC_TEST_UV_URL;
  for (const n of after('--skill')) {
    mkdirSync(join(store, n), { recursive: true });
    writeFileSync(join(store, n, 'SKILL.md'), '# ' + n + '\\n');
    const tree = execFileSync('git', ['-C', url.slice('file://'.length), 'rev-parse', 'HEAD:s/' + n], { encoding: 'utf8' }).trim();
    lock.skills[n] = { source: 'u/v', sourceUrl: url, skillPath: 's/' + n + '/SKILL.md', skillFolderHash: tree };
    if (after('--agent').includes('claude-code')) {
      const placed = join(process.env.NORTUSCC_CLAUDE_DIR, 'skills', n);
      mkdirSync(dirname(placed), { recursive: true });
      if (!existsSync(placed)) symlinkSync(join(store, n), placed, 'dir');
    }
    if (after('--agent').includes('codex')) mkdirSync(join(process.env.NORTUSCC_CODEX_DIR, 'skills', n), { recursive: true });
  }
  writeFileSync(lockPath, JSON.stringify(lock));
}
`;

// A local upstream `u/v` offering `fresh` and `wizard`, with `fresh` installed from it. Answers its path.
function uvSource(m: Machine): string {
  const uv = mkdtempSync(join(tmpdir(), 'nortuscc-holds-uv-'));
  git(uv, 'init', '-q');
  for (const name of ['fresh', 'wizard']) {
    mkdirSync(join(uv, 's', name), { recursive: true });
    writeFileSync(join(uv, 's', name, 'SKILL.md'), `# ${name}\n`);
  }
  git(uv, 'add', '.');
  git(uv, 'commit', '-qm', 'skills');
  const stored = join(m.agents, 'fresh');
  mkdirSync(stored, { recursive: true });
  writeFileSync(join(stored, 'SKILL.md'), '# fresh\n');
  mkdirSync(join(m.claude, 'skills'), { recursive: true });
  symlinkSync(stored, join(m.claude, 'skills', 'fresh'), 'dir');
  mkdirSync(join(m.codex, 'skills', 'fresh'), { recursive: true });
  const lockPath = join(dirname(m.agents), '.skill-lock.json');
  const lock = existsSync(lockPath) ? readJson(lockPath) : { skills: {} };
  lock.skills.fresh = { source: 'u/v', sourceUrl: `file://${uv}`, skillPath: 's/fresh/SKILL.md', skillFolderHash: git(uv, 'rev-parse', 'HEAD:s/fresh') };
  writeFileSync(lockPath, JSON.stringify(lock));
  writeFakeBin(m.bin, 'npx', UV_NPX);
  return uv;
}

test('update writes the manifest into the checkout, with a held skill as the checkout declares it', async () => {
  const m = machine();
  const { pinned } = pinnedSkill(m);
  const uv = uvSource(m);
  writeFileSync(join(m.repo, 'skills-manifest.txt'), '[u/v]\nfresh\n');
  writeFileSync(join(m.repo, 'skill-pins.json'), JSON.stringify({ version: 1, pins: {} }, null, 2) + '\n');
  git(m.repo, 'commit', '-qam', 'drop pinme, add u/v');
  hold(m, { 'skill:o/r/pinme': pinned });
  const result = await runCli(m, ['update', '--yes', '--add', 'wizard'], { env: { NORTUSCC_TEST_UV_URL: `file://${uv}` } });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /skills-manifest\.txt written — 2 skill\(s\)/);
  const manifest = readFileSync(join(m.repo, 'skills-manifest.txt'), 'utf8');
  assert.deepEqual(parseSkillsManifest(manifest).map((g) => [g.source, g.skills]), [['u/v', ['fresh', 'wizard']]]);
});

test('update reports a manifest it could not carry back to the checkout, and still closes its report', async () => {
  const m = machine();
  const { pinned } = pinnedSkill(m);
  const uv = uvSource(m);
  writeFileSync(join(m.repo, 'skills-manifest.txt'), '[u/v]\nfresh\n');
  writeFileSync(join(m.repo, 'skill-pins.json'), JSON.stringify({ version: 1, pins: {} }, null, 2) + '\n');
  git(m.repo, 'commit', '-qam', 'drop pinme, add u/v');
  hold(m, { 'skill:o/r/pinme': pinned });
  // A read-only checkout directory refuses the atomic write's temp file.
  chmodSync(m.repo, 0o555);
  try {
    const result = await runCli(m, ['update', '--yes', '--add', 'wizard'], { env: { NORTUSCC_TEST_UV_URL: `file://${uv}` } });
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /skills-manifest\.txt failed — /);
    assert.doesNotMatch(result.stdout, /nortuscc push/);
    assert.match(result.stdout, /wizard\s+added/);
  } finally {
    chmodSync(m.repo, 0o755);
  }
  assert.equal(readFileSync(join(m.repo, 'skills-manifest.txt'), 'utf8'), '[u/v]\nfresh\n');
});

test('update does not offer or adopt a skill held absent', async () => {
  const m = machine();
  const uv = uvSource(m);
  const manifest = join(m.repo, 'skills-manifest.txt');
  writeFileSync(manifest, '[u/v]\nfresh\n');
  git(m.repo, 'add', '.');
  git(m.repo, 'commit', '-qm', 'u/v');
  const without = git(m.repo, 'rev-parse', 'HEAD');
  writeFileSync(manifest, '[u/v]\nfresh\nwizard\n');
  git(m.repo, 'commit', '-qam', 'add wizard');
  hold(m, { 'skill:u/v/wizard': without });
  const result = await runCli(m, ['update', '--yes', '--add', 'wizard'], { env: { NORTUSCC_TEST_UV_URL: `file://${uv}` } });
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /available/);
  assert.match(result.stdout, /not found upstream.*wizard/s);
  assert.equal(existsSync(join(m.agents, 'wizard')), false);
  assert.equal(readFileSync(manifest, 'utf8'), '[u/v]\nfresh\nwizard\n');
});

test('capture --take-local never writes a held key back into the checkout', async () => {
  const m = machine();
  hold(m, { [EFFORT]: commitKeys(m, (k) => ({ ...k, effortLevel: 'medium' })) });
  assert.equal((await runCli(m, ['apply'])).code, 0);
  const settings = join(m.claude, 'settings.json');
  writeFileSync(settings, JSON.stringify({ ...readJson(settings), effortLevel: 'mine' }, null, 2) + '\n');
  const result = await runCli(m, ['capture', '--take-local']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(readJson(KEYS(m)).effortLevel, 'medium');
  assert.match(result.stdout, /settings\.json\s+held/);
});

test('capture leaves a held key that changed locally as the checkout declares it', async () => {
  const m = machine();
  hold(m, { [EFFORT]: commitKeys(m, (k) => ({ ...k, effortLevel: 'medium' })) });
  assert.equal((await runCli(m, ['apply'])).code, 0);
  const settings = join(m.claude, 'settings.json');
  writeFileSync(settings, JSON.stringify({ ...readJson(settings), effortLevel: 'mine' }, null, 2) + '\n');
  const result = await runCli(m, ['capture']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /settings\.json\s+held/);
  assert.equal(readJson(KEYS(m)).effortLevel, 'medium');
});

test('push publishes nothing for a held key', async () => {
  const m = machine();
  hold(m, { [EFFORT]: commitKeys(m, (k) => ({ ...k, effortLevel: 'medium' })) });
  git(m.repo, 'push', '-q');
  assert.equal((await runCli(m, ['apply'])).code, 0);
  const settings = join(m.claude, 'settings.json');
  writeFileSync(settings, JSON.stringify({ ...readJson(settings), effortLevel: 'mine' }, null, 2) + '\n');
  const origin = git(m.repo, 'rev-parse', 'origin/main');
  const result = await runCli(m, ['push', '--take-local', '-m', 'x']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(git(m.repo, 'rev-parse', 'origin/main'), origin);
  assert.equal(readJson(KEYS(m)).effortLevel, 'medium');
});

test('capture lists each held skill in the manifest as the checkout declares it, without refusing a shrink', async () => {
  const m = machine();
  const manifest = join(m.repo, 'skills-manifest.txt');
  writeFileSync(manifest, '[foo/bar]\nalpha\nold\n');
  git(m.repo, 'commit', '-qam', 'alpha and old');
  const earlier = git(m.repo, 'rev-parse', 'HEAD');
  writeFileSync(manifest, '[foo/bar]\nalpha\nnew\n');
  git(m.repo, 'commit', '-qam', 'old -> new');
  // old: held, dropped by head, still installed. new: held, added by head, not installed here.
  hold(m, { 'skill:foo/bar/old': earlier, 'skill:foo/bar/new': earlier });
  for (const name of ['alpha', 'old']) mkdirSync(join(m.agents, name), { recursive: true });
  writeFileSync(join(m.agents, '..', '.skill-lock.json'), JSON.stringify({ skills: { alpha: { source: 'foo/bar' }, old: { source: 'foo/bar' } } }));
  const applied = await runCli(m, ['apply']);
  assert.equal(applied.code, 0, applied.stdout + applied.stderr);
  const result = await runCli(m, ['capture']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /refused/);
  assert.deepEqual(parseSkillsManifest(readFileSync(manifest, 'utf8')).map((g) => [g.source, g.skills]), [['foo/bar', ['alpha', 'new']]]);
});
