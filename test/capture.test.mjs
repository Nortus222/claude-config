import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A throwaway repo mirroring the manifest, so capture never writes to tracked
// files. Every override must be set before the modules are imported, since
// resolve.mjs reads them at call time but the commands capture paths eagerly.
const home = mkdtempSync(join(tmpdir(), 'nortuscc-capture-'));
const repo = join(home, 'repo');
const claude = join(home, '.claude');
const codex = join(home, '.codex');

mkdirSync(join(repo, 'claude'), { recursive: true });
mkdirSync(join(repo, 'codex'), { recursive: true });
writeFileSync(join(repo, 'claude', 'CLAUDE.md'), '# from repo\n');
writeFileSync(join(repo, 'codex', 'AGENTS.md'), '# codex from repo\n');
mkdirSync(claude, { recursive: true });
mkdirSync(codex, { recursive: true });

process.env.NORTUSCC_REPO_DIR = repo;
process.env.NORTUSCC_CLAUDE_DIR = claude;
process.env.NORTUSCC_CODEX_DIR = codex;
process.env.NORTUSCC_AGENTS_DIR = join(home, 'agents-skills');
process.env.NORTUSCC_STATE_DIR = join(home, 'state');

const { run: applyRun } = await import('../src/commands/apply.mjs');
const { run: captureRun, capturedPaths } = await import('../src/commands/capture.mjs');
const { statePath } = await import('../src/resolve.mjs');

const repoClaudeMd = join(repo, 'claude', 'CLAUDE.md');

test('seed the machine from the fixture repo', async () => {
  assert.equal(await applyRun([]), 0);
  assert.equal(readFileSync(join(claude, 'CLAUDE.md'), 'utf8'), '# from repo\n');
  assert.equal(readFileSync(join(codex, 'AGENTS.md'), 'utf8'), '# codex from repo\n');
});

test('capture with no local changes captures nothing', async () => {
  assert.equal(await captureRun([]), 0);
  assert.deepEqual(capturedPaths(), []);
});

test('capture copies a local edit back into the repo', async () => {
  writeFileSync(join(claude, 'CLAUDE.md'), '# captured edit\n');
  assert.equal(await captureRun([]), 0);
  assert.equal(readFileSync(repoClaudeMd, 'utf8'), '# captured edit\n');
  assert.ok(capturedPaths().includes('claude/CLAUDE.md'));
});

// A Claude-side edit must not drag the Codex file into the same capture, and
// vice versa: --target is what keeps one agent's local edit from being
// committed as if it were the other's.
test('capture --target claude captures only the Claude instruction file', async () => {
  writeFileSync(join(claude, 'CLAUDE.md'), '# claude only\n');
  writeFileSync(join(codex, 'AGENTS.md'), '# codex only\n');

  assert.equal(await captureRun(['--target', 'claude']), 0);
  assert.deepEqual(capturedPaths(), ['claude/CLAUDE.md']);
  assert.equal(readFileSync(join(repo, 'claude', 'CLAUDE.md'), 'utf8'), '# claude only\n');
  assert.equal(
    readFileSync(join(repo, 'codex', 'AGENTS.md'), 'utf8'),
    '# codex from repo\n',
    'the unselected target must be left exactly as the repo had it',
  );
});

test('capture --target codex then picks up the Codex edit that was left behind', async () => {
  assert.equal(await captureRun(['--target', 'codex']), 0);
  assert.deepEqual(capturedPaths(), ['codex/AGENTS.md']);
  assert.equal(readFileSync(join(repo, 'codex', 'AGENTS.md'), 'utf8'), '# codex only\n');
});

// Capture writes instruction files and the shared skill manifest, and nothing
// else. Local MCP servers, hooks and plugins are machine state — often with
// credentials in their arguments — and turning them into repository
// declarations is exactly what the design forbids.
test('capture never imports local MCP configuration', async () => {
  writeFileSync(join(repo, 'integrations.json'), JSON.stringify({ version: 1, integrations: [] }));
  const manifestBefore = readFileSync(join(repo, 'integrations.json'), 'utf8');

  writeFileSync(join(codex, 'config.toml'), '[mcp_servers.private]\ncommand="secret"\n');
  writeFileSync(join(codex, 'AGENTS.md'), '# codex local edit\n');

  assert.equal(await captureRun(['--target', 'codex']), 0);

  assert.equal(
    readFileSync(join(repo, 'integrations.json'), 'utf8'),
    manifestBefore,
    'capture must never write an integration declaration',
  );
  assert.deepEqual(capturedPaths(), ['codex/AGENTS.md']);
  assert.equal(existsSync(join(repo, 'config.toml')), false, 'local Codex configuration is never copied into the repo');
});

test('capture writes nothing outside the instruction files and the skill manifest', async () => {
  writeFileSync(join(claude, 'CLAUDE.md'), '# another local edit\n');
  await captureRun([]);
  for (const path of capturedPaths()) {
    assert.ok(
      path === 'skills-manifest.txt' || /^(claude|codex)\//.test(path),
      `capture wrote an unexpected path: ${path}`,
    );
  }
});

test('a second capture with nothing new captures nothing', async () => {
  assert.equal(await captureRun([]), 0);
  assert.deepEqual(capturedPaths(), []);
});

test('a clean second capture does not rewrite the lockfile at all', async () => {
  const lockBytesBefore = readFileSync(statePath(), 'utf8');
  const mtimeBefore = statSync(statePath()).mtimeMs;

  // Force the clock forward so a spurious rewrite would show up as a changed
  // mtime even on filesystems with coarse mtime resolution.
  await new Promise((r) => setTimeout(r, 20));

  const code = await captureRun([]);
  assert.equal(code, 0);
  assert.equal(readFileSync(statePath(), 'utf8'), lockBytesBefore, 'lockfile bytes must be untouched on a clean run');
  assert.equal(statSync(statePath()).mtimeMs, mtimeBefore, 'lockfile must not be rewritten on a clean run');
});

// Fix round 1, finding 1: apply's --take-local hole (see apply.test.mjs) has
// a mirror image here — capture's --take-repo was parsed but never wired to
// captureCopy's `force` (only --take-local was), so it was silently accepted
// and did nothing. capture only ever moves machine -> repo, so "keep the
// repo version" is not a resolution capture can perform at all; it must
// refuse the flag outright and point at apply, not attempt and fail silently.
test('capture --take-repo is refused outright — the flag does not fit capture\'s direction', async () => {
  const lockBytesBefore = readFileSync(statePath(), 'utf8');
  let stderr = '';
  const originalError = console.error;
  console.error = (msg) => { stderr += String(msg) + '\n'; };
  let code;
  try {
    code = await captureRun(['--take-repo']);
  } finally {
    console.error = originalError;
  }
  assert.notEqual(code, 0, '--take-repo must not be silently accepted by capture');
  assert.match(stderr, /apply --take-repo/, 'must point the user at the command that actually supports it');
  assert.equal(readFileSync(statePath(), 'utf8'), lockBytesBefore, 'a refused flag must not touch the lockfile');
  assert.deepEqual(capturedPaths(), [], 'a refused flag must not stage anything for commit');
});

test('an unknown mode is reported and left alone, not treated as a conflict', async () => {
  // `target` must be present: capture.mjs resolves an entry's paths before
  // checking its mode (see the merge-keys dispatch above it), so a target-less
  // entry now reaches resolveEntry regardless of mode.
  const bogusEntry = { target: 'claude', src: 'claude/CLAUDE.md', dest: 'some-file', mode: 'bogus' };
  const lockBytesBefore = readFileSync(statePath(), 'utf8');

  const code = await captureRun([], [bogusEntry]);

  // BLOCKED like conflict and missing-repo, but not itself a refused conflict:
  // capture cannot remediate a mode it does not understand, so it must not
  // affect the exit code, must not stage anything for that entry, and must
  // not touch the lockfile.
  assert.equal(code, 0);
  assert.deepEqual(capturedPaths(), []);
  assert.equal(readFileSync(statePath(), 'utf8'), lockBytesBefore, 'an unknown-mode entry must not touch the lockfile');
});

test('the manifest path resolves inside the fixture repo, never the real one', async () => {
  const { manifestPath } = await import('../src/skills.mjs');
  assert.equal(manifestPath(), join(repo, 'skills-manifest.txt'));
});

// Fix round 2, finding 2: the fixture above never populates a skill lock, so
// the manifest-write and shrink-guard branches capture.mjs added were never
// actually exercised by the suite (the whole block could be deleted with all
// tests still green). These tests populate .skill-lock.json — a sibling of
// NORTUSCC_AGENTS_DIR's directory, per skills.mjs's SKILL_LOCK() — to drive
// both branches for real, still entirely inside the fixture home.
const skillLockPath = join(home, '.skill-lock.json');
const { manifestPath, parseManifest } = await import('../src/skills.mjs');

// The manifest is regenerated from skills that are BOTH recorded in the lock
// and present on disk, so these fixtures have to create the folders too — a
// lock entry alone is no longer enough to reach the manifest.
const installSkill = (name) => mkdirSync(join(home, 'agents-skills', name), { recursive: true });

test('capture regenerates the manifest from the installed skills, grouped by source, excluding a local skill', async () => {
  for (const name of ['alpha', 'beta', 'gamma', 'homegrown']) installSkill(name);

  writeFileSync(
    skillLockPath,
    JSON.stringify({
      skills: {
        alpha: { source: 'foo/bar' },
        beta: { source: 'foo/bar' },
        gamma: { source: 'baz/qux' },
        // No recorded source: authored directly in ~/.agents/skills. Nothing
        // could install it, so it must never land in the manifest.
        homegrown: {},
      },
    }),
    'utf8',
  );

  const code = await captureRun([]);
  assert.equal(code, 0);

  const written = readFileSync(manifestPath(), 'utf8');
  assert.deepEqual(parseManifest(written), [
    { source: 'baz/qux', skills: ['gamma'], exact: false },
    { source: 'foo/bar', skills: ['alpha', 'beta'], exact: false },
  ]);
  assert.ok(!written.includes('homegrown'), 'a skill with no recorded source must never be written to the manifest');
  assert.ok(capturedPaths().includes('skills-manifest.txt'), 'a manifest write must be staged for commit');
});

test('capture refuses to shrink the manifest when fewer skills are installed than the manifest already lists', async () => {
  const before = readFileSync(manifestPath(), 'utf8');

  // Drop 'beta' from the lock. Its folder still exists, but a folder with no
  // recorded source could never be installed from anywhere, so it drops out of
  // the manifest too — leaving fewer skills than the 3 written above.
  writeFileSync(
    skillLockPath,
    JSON.stringify({
      skills: {
        alpha: { source: 'foo/bar' },
        gamma: { source: 'baz/qux' },
      },
    }),
    'utf8',
  );

  const code = await captureRun([]);
  assert.equal(code, 0);
  assert.equal(readFileSync(manifestPath(), 'utf8'), before, 'a shrinking manifest must be refused, not written');
  assert.ok(!capturedPaths().includes('skills-manifest.txt'), 'a refused write must not be staged for commit');
});

test('--allow-shrink permits writing a smaller manifest', async () => {
  const code = await captureRun(['--allow-shrink']);
  assert.equal(code, 0);

  const written = parseManifest(readFileSync(manifestPath(), 'utf8'));
  assert.deepEqual(written, [
    { source: 'baz/qux', skills: ['gamma'], exact: false },
    { source: 'foo/bar', skills: ['alpha'], exact: false },
  ]);
  assert.ok(capturedPaths().includes('skills-manifest.txt'));
});

// The lock outlives the folder. `npx skills remove` — or a hand-deleted
// directory — leaves the lock entry behind, so a manifest regenerated from the
// lock alone re-adds a skill that is not installed anywhere. On the owner's
// real machine that was two entries (`review`, `ubiquitous-language`), and it
// meant `capture` — and therefore `push` — would quietly hand every other
// machine two skills to install that this one had deliberately removed.
test('capture excludes a lock entry whose skill folder no longer exists', async () => {
  installSkill('alpha');
  installSkill('gamma');

  writeFileSync(
    skillLockPath,
    JSON.stringify({
      skills: {
        alpha: { source: 'foo/bar' },
        gamma: { source: 'baz/qux' },
        // Recorded in the lock, but its folder is gone from ~/.agents/skills.
        ghost: { source: 'foo/bar' },
      },
    }),
    'utf8',
  );

  const code = await captureRun([]);
  assert.equal(code, 0);

  const written = readFileSync(manifestPath(), 'utf8');
  assert.ok(!written.includes('ghost'), 'a lock entry with no folder on disk must never reach the manifest');
  assert.deepEqual(parseManifest(written), [
    { source: 'baz/qux', skills: ['gamma'], exact: false },
    { source: 'foo/bar', skills: ['alpha'], exact: false },
  ]);
});

test('a ghost lock entry cannot mask a genuine shrink', async () => {
  // The shrink guard counts entries, so a ghost inflating the count is not
  // merely cosmetic: it can hide the fact that this machine is missing a skill
  // the shared manifest lists, which is exactly what the guard exists to catch.
  const before = readFileSync(manifestPath(), 'utf8');

  writeFileSync(
    skillLockPath,
    JSON.stringify({
      skills: {
        alpha: { source: 'foo/bar' },
        // gamma's folder still exists but its lock entry is gone, so it drops
        // out — a real shrink from 2 to 1. Two ghosts would restore the count
        // to 3 under the old behaviour and let the write through.
        ghost1: { source: 'foo/bar' },
        ghost2: { source: 'foo/bar' },
      },
    }),
    'utf8',
  );

  const code = await captureRun([]);
  assert.equal(code, 0);
  assert.equal(readFileSync(manifestPath(), 'utf8'), before, 'ghosts must not pad the count past the shrink guard');
});

// M7: captureCopy has always backed the repo file up before overwriting it,
// but capture printed nothing about it — a push run wrote two backups into
// ~/.claude/backups/ completely silently. apply names the path; so must this.
test('capture names the backup it made of the repo file it overwrote', async () => {
  const repoBefore = readFileSync(repoClaudeMd, 'utf8');
  writeFileSync(join(claude, 'CLAUDE.md'), '# a later local edit\n');

  let output = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    output += chunk.toString();
    return true;
  };
  let code;
  try {
    code = await captureRun([]);
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.equal(code, 0);
  assert.equal(readFileSync(repoClaudeMd, 'utf8'), '# a later local edit\n');

  const match = output.match(/CLAUDE\.md\s+copied\s+backed up -> (\S+)/);
  assert.ok(match, `capture must print where the overwritten repo file went; got:\n${output}`);
  assert.equal(
    readFileSync(match[1], 'utf8'),
    repoBefore,
    'the printed path must hold the repo content capture displaced',
  );
});

// Discovering an extra must never write it into the manifest: that would
// convert drift into policy behind the user's back. capture has never read
// plugin, hook or MCP state, and this is what keeps it that way.
test('capture does not adopt undeclared items into integrations.json', async () => {
  const before = JSON.stringify({
    version: 1,
    integrations: [{
      id: 'superpowers-claude', label: 'superpowers', target: 'claude',
      type: 'plugin', default: true, plugin: 'superpowers@claude-plugins-official',
    }],
  });
  const manifestFile = join(repo, 'integrations.json');
  writeFileSync(manifestFile, before);

  // An undeclared plugin, marketplace and agent, all present on the machine.
  mkdirSync(join(claude, 'plugins'), { recursive: true });
  mkdirSync(join(claude, 'agents', 'stray'), { recursive: true });
  writeFileSync(
    join(claude, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'claude-mem@thedotmack': [{ scope: 'user', version: '13.13.1' }] } }),
  );
  writeFileSync(join(claude, 'plugins', 'known_marketplaces.json'), JSON.stringify({ thedotmack: {} }));

  await captureRun([]);

  assert.equal(readFileSync(manifestFile, 'utf8'), before, 'integrations.json is byte-identical after capture');
});

test('capture writes a local settings key back to the repo without adopting extras', async () => {
  const settingsSrc = join(repo, 'claude', 'settings.keys.json');
  writeFileSync(settingsSrc, JSON.stringify({ theme: 'auto' }) + '\n');
  writeFileSync(
    join(claude, 'settings.json'),
    JSON.stringify({ theme: 'dark', permissions: { allow: [] } }) + '\n',
  );

  await captureRun([]);

  const captured = JSON.parse(readFileSync(settingsSrc, 'utf8'));
  assert.equal(captured.theme, 'dark');
  assert.deepEqual(Object.keys(captured), ['theme'], 'capture never adopts an undeclared key');
});
