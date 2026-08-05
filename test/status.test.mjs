import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  copyFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'nortuscc-status-'));
process.env.NORTUSCC_CLAUDE_DIR = join(home, '.claude');
mkdirSync(process.env.NORTUSCC_CLAUDE_DIR, { recursive: true });

// Redirect the skills dir (and, via skills.mjs, the sibling .skill-lock.json)
// so these tests never read the real ~/.agents/skills or the real, unrecoverable
// ~/.agents/.skill-lock.json.
process.env.NORTUSCC_AGENTS_DIR = join(home, '.agents', 'skills');

// Set up a fixture repo with empty settings.json so tests don't read plugins from the real repo
const fixtureRepo = mkdtempSync(join(tmpdir(), 'nortuscc-repo-'));
process.env.NORTUSCC_REPO_DIR = fixtureRepo;
mkdirSync(join(fixtureRepo, 'claude'), { recursive: true });
writeFileSync(join(fixtureRepo, 'claude', 'settings.json'), JSON.stringify({}));
writeFileSync(join(fixtureRepo, 'claude', 'CLAUDE.md'), '# Test');
// The link entries need real directories to point at. Without them the links
// these tests create dangle, which is now (correctly) reported as broken-link
// rather than as a clean machine.
mkdirSync(join(fixtureRepo, 'claude', 'bin'), { recursive: true });
mkdirSync(join(fixtureRepo, 'claude', 'hooks'), { recursive: true });

const { configReport, run } = await import('../src/commands/status.mjs');

test('configReport returns one row per manifest entry', async () => {
  const { SYNC } = await import('../src/manifest.mjs');
  const rows = configReport();
  assert.equal(rows.length, SYNC.length);
  for (const row of rows) {
    assert.ok(row.dest, 'each row names its destination');
    assert.ok(['link', 'copy'].includes(row.mode));
    assert.ok(typeof row.state === 'string' && row.state.length > 0);
  }
});

test('an empty claude dir reports nothing as clean', () => {
  const rows = configReport();
  const clean = rows.filter((r) => r.state === 'clean' || r.state === 'linked');
  assert.equal(clean.length, 0, 'a bare machine has no synced files yet');
});

test('link entries report missing on a bare machine', () => {
  const rows = configReport().filter((r) => r.mode === 'link');
  for (const row of rows) assert.equal(row.state, 'missing');
});

test('copy entries report unmanaged on a bare machine', () => {
  const rows = configReport().filter((r) => r.mode === 'copy');
  for (const row of rows) assert.equal(row.state, 'unmanaged');
});

test('run() returns 1 on a dirty machine and does not write lockfile', async () => {
  const { lockPath } = await import('../src/resolve.mjs');
  const lockFile = lockPath();

  // Capture initial state
  let lockExistedBefore = false;
  let lockContentBefore = null;
  let lockMtimeBefore = null;

  try {
    lockContentBefore = readFileSync(lockFile);
    const stat = statSync(lockFile);
    lockMtimeBefore = stat.mtimeMs;
    lockExistedBefore = true;
  } catch {
    lockExistedBefore = false;
  }

  // Run the command
  const exitCode = await run();

  // Verify exit code is 1 (dirty machine)
  assert.equal(exitCode, 1, 'run() returns 1 on a machine with drift');

  // Verify lockfile was not created/modified
  if (lockExistedBefore) {
    const lockContentAfter = readFileSync(lockFile);
    const statAfter = statSync(lockFile);
    assert.deepEqual(lockContentAfter, lockContentBefore, 'lockfile content unchanged');
    assert.equal(statAfter.mtimeMs, lockMtimeBefore, 'lockfile mtime unchanged');
  } else {
    try {
      readFileSync(lockFile);
      assert.fail('lockfile should not be created by run()');
    } catch (e) {
      assert.equal(e.code, 'ENOENT', 'lockfile does not exist after run()');
    }
  }

  // Verify backup directory was not created
  const { backupRoot } = await import('../src/resolve.mjs');
  const backupDir = backupRoot();
  try {
    statSync(backupDir);
    assert.fail('backup directory should not be created by run()');
  } catch (e) {
    assert.equal(e.code, 'ENOENT', 'backup directory not created by run()');
  }
});

test('run() returns 0 on a clean machine', async () => {
  // Set up a genuinely clean machine: all entries in non-actionable states
  const { SYNC } = await import('../src/manifest.mjs');
  const { hashFile, readLock, writeLock, setBaseline } = await import('../src/lock.mjs');
  const { ensureLink } = await import('../src/link.mjs');
  const { resolveEntry, claudeDir } = await import('../src/resolve.mjs');

  const claude = claudeDir();

  // For all link entries: create the symlinks
  for (const entry of SYNC) {
    if (entry.mode === 'link') {
      const { src, dest } = resolveEntry(entry);
      await ensureLink(dest, src);
    }
  }

  // For all copy entries: copy the file to dest and seed lockfile with its hash
  const lock = readLock();
  for (const entry of SYNC) {
    if (entry.mode === 'copy') {
      const { src, dest } = resolveEntry(entry);
      const hash = hashFile(src);
      if (hash) {
        // Copy the repo file to the local destination
        copyFileSync(src, dest);
        // Seed the baseline hash in the lockfile
        setBaseline(lock, entry.dest, hash);
      }
    }
  }
  writeLock(lock);

  // Now run the command on this clean machine
  const exitCode = await run();

  // Verify exit code is 0
  assert.equal(exitCode, 0, 'run() returns 0 on a clean machine');
});

test('unknown mode is surfaced with correct state and note', async () => {
  // Inject a bogus mode entry and verify it surfaces as unknown-mode with appropriate note
  const bogusEntry = { src: 'repo/some-file', dest: 'some-file', mode: 'bogus' };
  const rows = configReport([bogusEntry]);

  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.dest, 'some-file');
  assert.equal(row.mode, 'bogus');
  assert.equal(row.state, 'unknown-mode', 'unknown mode is surfaced as unknown-mode state');

  // Verify the note appears in formatted output
  const { formatRow } = await import('../src/report.mjs');
  const formatted = formatRow(row.dest, row.state, 'manifest entry has an unrecognized mode');
  assert.ok(
    formatted.includes('unknown-mode'),
    'unknown-mode state appears in formatted output',
  );
  assert.ok(
    formatted.includes('unrecognized mode'),
    'descriptive note appears in formatted output',
  );
});

// Finding 4: Strengthen read-only safety net with full directory snapshot
function snapshotDirectory(dir) {
  // Recursively snapshot a directory's contents
  const snapshot = {};
  try {
    const walk = (path, prefix) => {
      const entries = readdirSync(path, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(path, entry.name);
        const key = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(fullPath, key);
        } else {
          snapshot[key] = readFileSync(fullPath);
        }
      }
    };
    walk(dir, '');
  } catch (e) {
    // Directory doesn't exist yet
  }
  return snapshot;
}

test('run() does not write any files to claude dir and does not create new directories', async () => {
  // Use a fresh, isolated temp directory for this test to avoid state leakage from other tests
  const isolatedHome = mkdtempSync(join(tmpdir(), 'nortuscc-readonly-'));
  const isolatedClaudeDir = join(isolatedHome, '.claude');
  mkdirSync(isolatedClaudeDir, { recursive: true });

  // Set up an isolated repo fixture
  const isolatedRepo = mkdtempSync(join(tmpdir(), 'nortuscc-repo-readonly-'));
  mkdirSync(join(isolatedRepo, 'claude', 'bin'), { recursive: true });
  mkdirSync(join(isolatedRepo, 'claude', 'hooks'), { recursive: true });
  writeFileSync(join(isolatedRepo, 'claude', 'settings.json'), JSON.stringify({}));
  writeFileSync(join(isolatedRepo, 'claude', 'CLAUDE.md'), '# Test');

  // Set up an isolated agents/skills fixture too (fix round 1, finding 3: the
  // original snapshot only covered the claude dir, so a write in the new
  // skills-reading code path — installedSkillNames(), readSkillLock() — would
  // have gone undetected).
  const isolatedAgentsSkillsDir = join(isolatedHome, '.agents', 'skills');
  mkdirSync(join(isolatedAgentsSkillsDir, 'sample-skill'), { recursive: true });
  writeFileSync(
    join(isolatedHome, '.agents', '.skill-lock.json'),
    JSON.stringify({ skills: { 'sample-skill': { source: 'a/b' } } }),
  );

  // Save original env vars and override with isolated paths
  const origClaudeDir = process.env.NORTUSCC_CLAUDE_DIR;
  const origRepoDir = process.env.NORTUSCC_REPO_DIR;
  const origAgentsDir = process.env.NORTUSCC_AGENTS_DIR;
  process.env.NORTUSCC_CLAUDE_DIR = isolatedClaudeDir;
  process.env.NORTUSCC_REPO_DIR = isolatedRepo;
  process.env.NORTUSCC_AGENTS_DIR = isolatedAgentsSkillsDir;

  try {
    // Reimport to get fresh functions bound to isolated paths
    const { run: isolatedRun } = await import('../src/commands/status.mjs');
    const { SYNC } = await import('../src/manifest.mjs');
    const { hashFile, readLock, writeLock, setBaseline } = await import('../src/lock.mjs');
    const { ensureLink } = await import('../src/link.mjs');
    const { resolveEntry } = await import('../src/resolve.mjs');

    // Take a pristine snapshot before any setup (kept for parity with the
    // pre-existing claude-dir check below; the agents/skills fixture doesn't
    // change during setup, so only "after setup" and "after run()" are compared).
    const snapshotBefore = snapshotDirectory(isolatedClaudeDir);

    // Set up a clean machine: all entries in non-actionable states
    for (const entry of SYNC) {
      if (entry.mode === 'link') {
        const { src, dest } = resolveEntry(entry);
        await ensureLink(dest, src);
      }
    }

    const lock = readLock();
    for (const entry of SYNC) {
      if (entry.mode === 'copy') {
        const { src, dest } = resolveEntry(entry);
        const hash = hashFile(src);
        if (hash) {
          copyFileSync(src, dest);
          setBaseline(lock, entry.dest, hash);
        }
      }
    }
    writeLock(lock);

    // Snapshot after setup but before run()
    const snapshotAfterSetup = snapshotDirectory(isolatedClaudeDir);
    // The agents/skills fixture (and the sibling .skill-lock.json) are not
    // touched by the setup above, so its "after setup" and "pristine" snapshots
    // of isolatedHome/.agents are the same tree; re-snapshot here anyway to
    // pin down exactly what run() is allowed to see.
    const skillsSnapshotAfterSetup = snapshotDirectory(isolatedHome);

    // Run the command on clean machine
    await isolatedRun();

    // Snapshot after run()
    const snapshotAfter = snapshotDirectory(isolatedClaudeDir);
    const skillsSnapshotAfter = snapshotDirectory(isolatedHome);

    // Verify no new files or directories were created
    const keysBefore = Object.keys(snapshotAfterSetup).sort();
    const keysAfter = Object.keys(snapshotAfter).sort();

    assert.deepEqual(
      keysAfter,
      keysBefore,
      'run() created no new files or directories in claude dir',
    );

    // Verify no files were modified
    for (const key of keysBefore) {
      assert.deepEqual(
        snapshotAfter[key],
        snapshotAfterSetup[key],
        `run() did not modify ${key}`,
      );
    }

    // Same checks for ~/.agents (skills dir + .skill-lock.json): status reads
    // both via skills.mjs, and must not write either.
    const skillsKeysBefore = Object.keys(skillsSnapshotAfterSetup).sort();
    const skillsKeysAfter = Object.keys(skillsSnapshotAfter).sort();

    assert.deepEqual(
      skillsKeysAfter,
      skillsKeysBefore,
      'run() created no new files or directories under ~/.agents',
    );

    for (const key of skillsKeysBefore) {
      assert.deepEqual(
        skillsSnapshotAfter[key],
        skillsSnapshotAfterSetup[key],
        `run() did not modify ${key} under ~/.agents`,
      );
    }
  } finally {
    // Restore original env vars
    process.env.NORTUSCC_CLAUDE_DIR = origClaudeDir;
    process.env.NORTUSCC_REPO_DIR = origRepoDir;
    process.env.NORTUSCC_AGENTS_DIR = origAgentsDir;
  }
});

// Fix round 1, finding 2: the wiring from reconcile()'s output to run()'s exit
// code and printed section had no test that constructs a real source-grouped
// manifest with a skill genuinely missing from the agents skills dir. Without
// this, deleting the `&& skills.missing.length === 0` clause in status.mjs
// left the whole suite green.
test('run() returns 1 when a manifest skill is missing, and names it in the output', async () => {
  const isolatedHome = mkdtempSync(join(tmpdir(), 'nortuscc-skills-missing-'));
  const isolatedClaudeDir = join(isolatedHome, '.claude');
  mkdirSync(isolatedClaudeDir, { recursive: true });

  const isolatedRepo = mkdtempSync(join(tmpdir(), 'nortuscc-repo-skills-missing-'));
  mkdirSync(join(isolatedRepo, 'claude', 'bin'), { recursive: true });
  mkdirSync(join(isolatedRepo, 'claude', 'hooks'), { recursive: true });
  writeFileSync(join(isolatedRepo, 'claude', 'settings.json'), JSON.stringify({}));
  writeFileSync(join(isolatedRepo, 'claude', 'CLAUDE.md'), '# Test');
  // A real source-grouped manifest naming two skills.
  writeFileSync(join(isolatedRepo, 'skills-manifest.txt'), '[a/b]\nhave\nwant\n');

  // Only 'have' is actually installed; 'want' is genuinely missing.
  const isolatedAgentsSkillsDir = join(isolatedHome, '.agents', 'skills');
  mkdirSync(join(isolatedAgentsSkillsDir, 'have'), { recursive: true });

  const origClaudeDir = process.env.NORTUSCC_CLAUDE_DIR;
  const origRepoDir = process.env.NORTUSCC_REPO_DIR;
  const origAgentsDir = process.env.NORTUSCC_AGENTS_DIR;
  process.env.NORTUSCC_CLAUDE_DIR = isolatedClaudeDir;
  process.env.NORTUSCC_REPO_DIR = isolatedRepo;
  process.env.NORTUSCC_AGENTS_DIR = isolatedAgentsSkillsDir;

  const originalWrite = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (chunk) => {
    chunks.push(chunk.toString());
    return true;
  };

  try {
    const { run: isolatedRun } = await import('../src/commands/status.mjs');
    const { SYNC } = await import('../src/manifest.mjs');
    const { hashFile, readLock, writeLock, setBaseline } = await import('../src/lock.mjs');
    const { ensureLink } = await import('../src/link.mjs');
    const { resolveEntry } = await import('../src/resolve.mjs');

    // Bring config to a clean state so the missing skill is the only thing
    // that can make this run dirty — isolates the wiring under test.
    for (const entry of SYNC) {
      if (entry.mode === 'link') {
        const { src, dest } = resolveEntry(entry);
        await ensureLink(dest, src);
      }
    }
    const lock = readLock();
    for (const entry of SYNC) {
      if (entry.mode === 'copy') {
        const { src, dest } = resolveEntry(entry);
        const hash = hashFile(src);
        if (hash) {
          copyFileSync(src, dest);
          setBaseline(lock, entry.dest, hash);
        }
      }
    }
    writeLock(lock);

    const exitCode = await isolatedRun();

    assert.equal(exitCode, 1, 'a manifest skill missing from the agents skills dir makes the run dirty');
    const output = chunks.join('');
    assert.ok(output.includes('want'), 'the missing skill name is named in the printed output');
  } finally {
    process.stdout.write = originalWrite;
    process.env.NORTUSCC_CLAUDE_DIR = origClaudeDir;
    process.env.NORTUSCC_REPO_DIR = origRepoDir;
    process.env.NORTUSCC_AGENTS_DIR = origAgentsDir;
  }
});

// --- shared fixture for the end-to-end reporting tests below -----------------

// Builds an isolated machine that is genuinely clean — links pointing at real
// repo directories, baselines recorded for both copied files — and hands it to
// fn with the env overrides in place. Each test then breaks exactly one thing,
// so what it asserts is the only thing that could have caused the report.
async function onCleanMachine(prefix, fn) {
  const isolatedHome = mkdtempSync(join(tmpdir(), `nortuscc-${prefix}-home-`));
  const isolatedClaudeDir = join(isolatedHome, '.claude');
  const isolatedAgentsSkillsDir = join(isolatedHome, '.agents', 'skills');
  mkdirSync(isolatedClaudeDir, { recursive: true });
  mkdirSync(isolatedAgentsSkillsDir, { recursive: true });

  const isolatedRepo = mkdtempSync(join(tmpdir(), `nortuscc-${prefix}-repo-`));
  mkdirSync(join(isolatedRepo, 'claude', 'bin'), { recursive: true });
  mkdirSync(join(isolatedRepo, 'claude', 'hooks'), { recursive: true });
  writeFileSync(join(isolatedRepo, 'claude', 'bin', 'sp'), '#!/bin/sh\n');
  writeFileSync(join(isolatedRepo, 'claude', 'settings.json'), JSON.stringify({}));
  writeFileSync(join(isolatedRepo, 'claude', 'CLAUDE.md'), '# Test');

  const saved = {
    claude: process.env.NORTUSCC_CLAUDE_DIR,
    repo: process.env.NORTUSCC_REPO_DIR,
    agents: process.env.NORTUSCC_AGENTS_DIR,
  };
  process.env.NORTUSCC_CLAUDE_DIR = isolatedClaudeDir;
  process.env.NORTUSCC_REPO_DIR = isolatedRepo;
  process.env.NORTUSCC_AGENTS_DIR = isolatedAgentsSkillsDir;

  try {
    const { run: isolatedRun } = await import('../src/commands/status.mjs');
    const { SYNC } = await import('../src/manifest.mjs');
    const { hashFile, readLock, writeLock, setBaseline } = await import('../src/lock.mjs');
    const { ensureLink } = await import('../src/link.mjs');
    const { resolveEntry } = await import('../src/resolve.mjs');

    for (const entry of SYNC) {
      if (entry.mode === 'link') {
        const { src, dest } = resolveEntry(entry);
        ensureLink(dest, src, entry.dest);
      }
    }
    const lock = readLock();
    for (const entry of SYNC) {
      if (entry.mode === 'copy') {
        const { src, dest } = resolveEntry(entry);
        const hash = hashFile(src);
        if (hash) {
          copyFileSync(src, dest);
          setBaseline(lock, entry.dest, hash);
        }
      }
    }
    writeLock(lock);

    return await fn({
      home: isolatedHome,
      claude: isolatedClaudeDir,
      agents: isolatedAgentsSkillsDir,
      repo: isolatedRepo,
      run: isolatedRun,
    });
  } finally {
    process.env.NORTUSCC_CLAUDE_DIR = saved.claude;
    process.env.NORTUSCC_REPO_DIR = saved.repo;
    process.env.NORTUSCC_AGENTS_DIR = saved.agents;
  }
}

async function runCaptured(run) {
  const chunks = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(chunk.toString());
    return true;
  };
  try {
    const code = await run();
    return { code, output: chunks.join('') };
  } finally {
    process.stdout.write = originalWrite;
  }
}

// C1: with the repo's claude/bin moved away, status used to print "bin linked"
// and "everything is in agreement" with exit 0, while `cat ~/.claude/bin/sp`
// failed. That is the design's §1 problem statement restated verbatim, and
// ~/.claude/bin/sp is what the global CLAUDE.md tells every agent to run.
test('status reports a link whose repo target has vanished, and exits non-zero', async () => {
  await onCleanMachine('broken-link', async (fx) => {
    const clean = await runCaptured(fx.run);
    assert.equal(clean.code, 0, 'the fixture machine must start genuinely clean');
    assert.match(clean.output, /everything is in agreement/);

    // The repo path goes away: a deleted worktree, or a moved clone.
    rmSync(join(fx.repo, 'claude', 'bin'), { recursive: true, force: true });

    const dirty = await runCaptured(fx.run);
    assert.equal(dirty.code, 1, 'a dangling bin link must make status exit non-zero');
    assert.match(dirty.output, /bin\s+broken-link/, 'the dangling link is named and its state reported');
    assert.doesNotMatch(
      dirty.output,
      /everything is in agreement/,
      'a machine whose bin link leads nowhere is not in agreement',
    );
  });
});

// I2: status used to point at `nortuscc apply --take-repo | --take-local`.
// Following the second half of that gives exit 2, since apply refuses a flag
// that runs against its own direction.
test('the conflict suggestion names, for each direction, the command that accepts the flag', async () => {
  await onCleanMachine('conflict-advice', async (fx) => {
    assert.equal((await runCaptured(fx.run)).code, 0, 'the fixture machine must start genuinely clean');

    // Both sides move apart after the recorded baseline: a genuine conflict.
    writeFileSync(join(fx.claude, 'CLAUDE.md'), '# local change');
    writeFileSync(join(fx.repo, 'claude', 'CLAUDE.md'), '# repo change');

    const { code, output } = await runCaptured(fx.run);
    assert.equal(code, 1);
    assert.match(output, /CLAUDE\.md\s+conflict/);
    assert.match(output, /nortuscc apply --take-repo/, 'apply is the command that resolves in the repo\'s favour');
    assert.match(output, /nortuscc capture --take-local/, 'capture is the command that keeps the local version');
    assert.doesNotMatch(
      output,
      /apply --take-local/,
      'apply --take-local exits 2 with a refusal, so status must never suggest it',
    );
    assert.doesNotMatch(
      output,
      /capture --take-repo/,
      'capture --take-repo exits 2 with a refusal, so status must never suggest it',
    );
  });
});

