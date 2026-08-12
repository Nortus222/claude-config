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
process.env.NORTUSCC_CODEX_DIR = join(home, '.codex');
mkdirSync(process.env.NORTUSCC_CLAUDE_DIR, { recursive: true });
mkdirSync(process.env.NORTUSCC_CODEX_DIR, { recursive: true });

// Redirect the skills dir (and, via skills.mjs, the sibling .skill-lock.json)
// so these tests never read the real ~/.agents/skills or the real, unrecoverable
// ~/.agents/.skill-lock.json.
process.env.NORTUSCC_AGENTS_DIR = join(home, '.agents', 'skills');
process.env.NORTUSCC_STATE_DIR = join(home, 'state');

// A fixture repo carrying one instruction file per target, so tests never read
// the real repo's tracked files.
const fixtureRepo = mkdtempSync(join(tmpdir(), 'nortuscc-repo-'));
process.env.NORTUSCC_REPO_DIR = fixtureRepo;
mkdirSync(join(fixtureRepo, 'claude'), { recursive: true });
mkdirSync(join(fixtureRepo, 'codex'), { recursive: true });
writeFileSync(join(fixtureRepo, 'claude', 'CLAUDE.md'), '# Test');
writeFileSync(join(fixtureRepo, 'codex', 'AGENTS.md'), '# Test codex');

const { configReport, run: rawRun } = await import('../src/commands/status.mjs');

// Codex answers "what is installed?" through its own CLI, so status would
// otherwise spawn the real `codex` against the developer's machine. Every run
// in this file gets an empty probe unless the test says otherwise.
const emptyCodex = () => ({ plugins: new Set(), marketplaces: new Set(), errors: [] });
const run = (args = [], deps = {}) => rawRun(args, { codexState: emptyCodex(), ...deps });

test('configReport returns one row per manifest entry', async () => {
  const { SYNC } = await import('../src/manifest.mjs');
  const rows = configReport();
  assert.equal(rows.length, SYNC.length);
  for (const row of rows) {
    assert.ok(row.dest, 'each row names its destination');
    assert.equal(row.mode, 'copy');
    assert.ok(typeof row.state === 'string' && row.state.length > 0);
  }
});

test('an empty agent dir reports nothing as clean', () => {
  const rows = configReport();
  const clean = rows.filter((r) => r.state === 'clean');
  assert.equal(clean.length, 0, 'a bare machine has no synced files yet');
});

test('copy entries report unmanaged on a bare machine', () => {
  const rows = configReport().filter((r) => r.mode === 'copy');
  assert.ok(rows.length > 0, 'the manifest must actually have copy entries to check');
  for (const row of rows) assert.equal(row.state, 'unmanaged');
});

// status is the read-only verb, so its target filter is the one users reach
// for first — and a filter that reports too much is exactly as wrong as one
// that reports too little.
test('a target narrows the config report to that agent alone', async () => {
  const { SYNC } = await import('../src/manifest.mjs');
  const { entriesForTarget } = await import('../src/targets.mjs');

  const claudeRows = configReport(entriesForTarget(SYNC, 'claude'));
  assert.deepEqual(claudeRows.map((r) => r.dest), ['CLAUDE.md']);

  const codexRows = configReport(entriesForTarget(SYNC, 'codex'));
  assert.deepEqual(codexRows.map((r) => r.dest), ['AGENTS.md']);
});

test('an invalid --target makes status exit 2 without reporting', async () => {
  const originalError = console.error;
  let stderr = '';
  console.error = (msg) => { stderr += String(msg) + '\n'; };
  try {
    assert.equal(await run(['--target', 'cursor']), 2);
  } finally {
    console.error = originalError;
  }
  assert.match(stderr, /claude\|codex\|all/);
});

test('run() returns 1 on a dirty machine and does not write lockfile', async () => {
  const { statePath } = await import('../src/resolve.mjs');
  const lockFile = statePath();

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
  const { resolveEntry } = await import('../src/resolve.mjs');

  // Copy each managed file to its destination and seed the lockfile with its hash
  const lock = readLock();
  for (const entry of SYNC) {
    const { src, dest } = resolveEntry(entry);
    const hash = hashFile(src);
    if (hash) {
      copyFileSync(src, dest);
      setBaseline(lock, `${entry.target}:${entry.dest}`, hash);
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
  const bogusEntry = { target: 'claude', src: 'repo/some-file', dest: 'some-file', mode: 'bogus' };
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
  const isolatedCodexDir = join(isolatedHome, '.codex');
  mkdirSync(isolatedClaudeDir, { recursive: true });
  mkdirSync(isolatedCodexDir, { recursive: true });

  // Set up an isolated repo fixture
  const isolatedRepo = mkdtempSync(join(tmpdir(), 'nortuscc-repo-readonly-'));
  mkdirSync(join(isolatedRepo, 'claude'), { recursive: true });
  mkdirSync(join(isolatedRepo, 'codex'), { recursive: true });
  writeFileSync(join(isolatedRepo, 'claude', 'CLAUDE.md'), '# Test');
  writeFileSync(join(isolatedRepo, 'codex', 'AGENTS.md'), '# Test codex');

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
  const origCodexDir = process.env.NORTUSCC_CODEX_DIR;
  const origRepoDir = process.env.NORTUSCC_REPO_DIR;
  const origAgentsDir = process.env.NORTUSCC_AGENTS_DIR;
  const origStateDir = process.env.NORTUSCC_STATE_DIR;
  process.env.NORTUSCC_CLAUDE_DIR = isolatedClaudeDir;
  process.env.NORTUSCC_CODEX_DIR = isolatedCodexDir;
  process.env.NORTUSCC_REPO_DIR = isolatedRepo;
  process.env.NORTUSCC_AGENTS_DIR = isolatedAgentsSkillsDir;
  process.env.NORTUSCC_STATE_DIR = join(isolatedHome, 'state');

  try {
    // Reimport to get fresh functions bound to isolated paths
    const { run: rawIsolatedRun } = await import('../src/commands/status.mjs');
    const isolatedRun = (args = [], runDeps = {}) =>
      rawIsolatedRun(args, { codexState: emptyCodex(), ...runDeps });
    const { SYNC } = await import('../src/manifest.mjs');
    const { hashFile, readLock, writeLock, setBaseline } = await import('../src/lock.mjs');
    const { resolveEntry } = await import('../src/resolve.mjs');

    // Take a pristine snapshot before any setup (kept for parity with the
    // pre-existing claude-dir check below; the agents/skills fixture doesn't
    // change during setup, so only "after setup" and "after run()" are compared).
    const snapshotBefore = snapshotDirectory(isolatedClaudeDir);

    // Set up a clean machine: every managed file present and baselined
    const lock = readLock();
    for (const entry of SYNC) {
      const { src, dest } = resolveEntry(entry);
      const hash = hashFile(src);
      if (hash) {
        copyFileSync(src, dest);
        setBaseline(lock, `${entry.target}:${entry.dest}`, hash);
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
    process.env.NORTUSCC_CODEX_DIR = origCodexDir;
    process.env.NORTUSCC_REPO_DIR = origRepoDir;
    process.env.NORTUSCC_AGENTS_DIR = origAgentsDir;
    process.env.NORTUSCC_STATE_DIR = origStateDir;
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
  const isolatedCodexDir = join(isolatedHome, '.codex');
  mkdirSync(isolatedClaudeDir, { recursive: true });
  mkdirSync(isolatedCodexDir, { recursive: true });

  const isolatedRepo = mkdtempSync(join(tmpdir(), 'nortuscc-repo-skills-missing-'));
  mkdirSync(join(isolatedRepo, 'claude'), { recursive: true });
  mkdirSync(join(isolatedRepo, 'codex'), { recursive: true });
  writeFileSync(join(isolatedRepo, 'claude', 'CLAUDE.md'), '# Test');
  writeFileSync(join(isolatedRepo, 'codex', 'AGENTS.md'), '# Test codex');
  // A real source-grouped manifest naming two skills.
  writeFileSync(join(isolatedRepo, 'skills-manifest.txt'), '[a/b]\nhave\nwant\n');

  // Only 'have' is actually installed; 'want' is genuinely missing.
  const isolatedAgentsSkillsDir = join(isolatedHome, '.agents', 'skills');
  mkdirSync(join(isolatedAgentsSkillsDir, 'have'), { recursive: true });

  const origClaudeDir = process.env.NORTUSCC_CLAUDE_DIR;
  const origCodexDir = process.env.NORTUSCC_CODEX_DIR;
  const origRepoDir = process.env.NORTUSCC_REPO_DIR;
  const origAgentsDir = process.env.NORTUSCC_AGENTS_DIR;
  const origStateDir = process.env.NORTUSCC_STATE_DIR;
  process.env.NORTUSCC_CLAUDE_DIR = isolatedClaudeDir;
  process.env.NORTUSCC_CODEX_DIR = isolatedCodexDir;
  process.env.NORTUSCC_REPO_DIR = isolatedRepo;
  process.env.NORTUSCC_AGENTS_DIR = isolatedAgentsSkillsDir;
  process.env.NORTUSCC_STATE_DIR = join(isolatedHome, 'state');

  const originalWrite = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (chunk) => {
    chunks.push(chunk.toString());
    return true;
  };

  try {
    const { run: rawIsolatedRun } = await import('../src/commands/status.mjs');
    const isolatedRun = (args = [], runDeps = {}) =>
      rawIsolatedRun(args, { codexState: emptyCodex(), ...runDeps });
    const { SYNC } = await import('../src/manifest.mjs');
    const { hashFile, readLock, writeLock, setBaseline } = await import('../src/lock.mjs');
    const { resolveEntry } = await import('../src/resolve.mjs');

    // Bring config to a clean state so the missing skill is the only thing
    // that can make this run dirty — isolates the wiring under test.
    const lock = readLock();
    for (const entry of SYNC) {
      const { src, dest } = resolveEntry(entry);
      const hash = hashFile(src);
      if (hash) {
        copyFileSync(src, dest);
        setBaseline(lock, `${entry.target}:${entry.dest}`, hash);
      }
    }
    writeLock(lock);

    // 'have' is installed, so status would otherwise ask the real installer
    // which agents can see it — a network call, and a spawn the constraints
    // forbid. The stub answers for both agents.
    const exitCode = await isolatedRun([], {
      inspectExposure: () => ({ list: { 'claude-code': ['have'], codex: ['have'] }, errors: [] }),
    });

    assert.equal(exitCode, 1, 'a manifest skill missing from the agents skills dir makes the run dirty');
    const output = chunks.join('');
    assert.ok(output.includes('want'), 'the missing skill name is named in the printed output');
  } finally {
    process.stdout.write = originalWrite;
    process.env.NORTUSCC_CLAUDE_DIR = origClaudeDir;
    process.env.NORTUSCC_CODEX_DIR = origCodexDir;
    process.env.NORTUSCC_REPO_DIR = origRepoDir;
    process.env.NORTUSCC_AGENTS_DIR = origAgentsDir;
    process.env.NORTUSCC_STATE_DIR = origStateDir;
  }
});

// --- shared fixture for the end-to-end reporting tests below -----------------

// Builds an isolated machine that is genuinely clean — every managed file
// present with its baseline recorded — and hands it to fn with the env
// overrides in place. Each test then breaks exactly one thing, so what it
// asserts is the only thing that could have caused the report.
async function onCleanMachine(prefix, fn) {
  const isolatedHome = mkdtempSync(join(tmpdir(), `nortuscc-${prefix}-home-`));
  const isolatedClaudeDir = join(isolatedHome, '.claude');
  const isolatedCodexDir = join(isolatedHome, '.codex');
  const isolatedAgentsSkillsDir = join(isolatedHome, '.agents', 'skills');
  mkdirSync(isolatedClaudeDir, { recursive: true });
  mkdirSync(isolatedCodexDir, { recursive: true });
  mkdirSync(isolatedAgentsSkillsDir, { recursive: true });

  const isolatedRepo = mkdtempSync(join(tmpdir(), `nortuscc-${prefix}-repo-`));
  mkdirSync(join(isolatedRepo, 'claude'), { recursive: true });
  mkdirSync(join(isolatedRepo, 'codex'), { recursive: true });
  writeFileSync(join(isolatedRepo, 'claude', 'CLAUDE.md'), '# Test');
  writeFileSync(join(isolatedRepo, 'codex', 'AGENTS.md'), '# Test codex');

  const saved = {
    claude: process.env.NORTUSCC_CLAUDE_DIR,
    codex: process.env.NORTUSCC_CODEX_DIR,
    repo: process.env.NORTUSCC_REPO_DIR,
    agents: process.env.NORTUSCC_AGENTS_DIR,
    state: process.env.NORTUSCC_STATE_DIR,
  };
  process.env.NORTUSCC_CLAUDE_DIR = isolatedClaudeDir;
  process.env.NORTUSCC_CODEX_DIR = isolatedCodexDir;
  process.env.NORTUSCC_REPO_DIR = isolatedRepo;
  process.env.NORTUSCC_AGENTS_DIR = isolatedAgentsSkillsDir;
  process.env.NORTUSCC_STATE_DIR = join(isolatedHome, 'state');

  try {
    const { run: rawIsolatedRun } = await import('../src/commands/status.mjs');
    const isolatedRun = (args = [], runDeps = {}) =>
      rawIsolatedRun(args, { codexState: emptyCodex(), ...runDeps });
    const { SYNC } = await import('../src/manifest.mjs');
    const { hashFile, readLock, writeLock, setBaseline } = await import('../src/lock.mjs');
    const { resolveEntry } = await import('../src/resolve.mjs');

    const lock = readLock();
    for (const entry of SYNC) {
      const { src, dest } = resolveEntry(entry);
      const hash = hashFile(src);
      if (hash) {
        copyFileSync(src, dest);
        setBaseline(lock, `${entry.target}:${entry.dest}`, hash);
      }
    }
    writeLock(lock);

    return await fn({
      home: isolatedHome,
      claude: isolatedClaudeDir,
      codex: isolatedCodexDir,
      agents: isolatedAgentsSkillsDir,
      repo: isolatedRepo,
      run: isolatedRun,
    });
  } finally {
    process.env.NORTUSCC_CLAUDE_DIR = saved.claude;
    process.env.NORTUSCC_CODEX_DIR = saved.codex;
    process.env.NORTUSCC_REPO_DIR = saved.repo;
    process.env.NORTUSCC_AGENTS_DIR = saved.agents;
    process.env.NORTUSCC_STATE_DIR = saved.state;
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

// C1 restated for the copy-only model. The original form of this test moved
// the repo's claude/bin away and proved status stopped claiming agreement.
// Directory links are gone, but the failure it guards is not: when the repo
// path behind a managed file disappears — a deleted worktree, a moved clone —
// status must say so rather than report a machine in agreement.
test('status reports a managed file whose repo source has vanished, and exits non-zero', async () => {
  await onCleanMachine('missing-repo', async (fx) => {
    const clean = await runCaptured(fx.run);
    assert.equal(clean.code, 0, 'the fixture machine must start genuinely clean');
    assert.match(clean.output, /everything is in agreement/);

    rmSync(join(fx.repo, 'codex', 'AGENTS.md'), { force: true });

    const dirty = await runCaptured(fx.run);
    assert.equal(dirty.code, 1, 'a vanished repo source must make status exit non-zero');
    assert.match(dirty.output, /AGENTS\.md\s+missing-repo/, 'the file is named and its state reported');
    assert.doesNotMatch(
      dirty.output,
      /everything is in agreement/,
      'a machine whose repo source is gone is not in agreement',
    );
  });
});

// The Codex half of the same guarantee the conflict test makes for Claude:
// a drifted AGENTS.md has to be visible, and has to be attributed to Codex
// rather than folded into the Claude row.
test('status reports Codex drift under its own destination name', async () => {
  await onCleanMachine('codex-drift', async (fx) => {
    assert.equal((await runCaptured(fx.run)).code, 0, 'the fixture machine must start genuinely clean');

    writeFileSync(join(fx.codex, 'AGENTS.md'), '# codex local change');

    const { code, output } = await runCaptured(fx.run);
    assert.equal(code, 1);
    assert.match(output, /AGENTS\.md\s+local-ahead/);
  });
});

// The successor to the broken-symlink scan: a skill present in the shared
// store but invisible to one selected agent is partially installed, and a
// machine in that state is not in agreement. Asked of the installer rather
// than inferred from a directory layout it owns.
test('status reports a skill one selected agent cannot see, and exits non-zero', async () => {
  await onCleanMachine('partial-skill', async (fx) => {
    mkdirSync(join(fx.agents, 'review'), { recursive: true });
    writeFileSync(join(fx.repo, 'skills-manifest.txt'), '[a/b]\nreview\n');
    writeFileSync(
      join(fx.home, '.agents', '.skill-lock.json'),
      JSON.stringify({ skills: { review: { source: 'a/b' } } }),
    );

    const seenByBoth = () => ({ list: { 'claude-code': ['review'], codex: ['review'] }, errors: [] });
    const clean = await runCaptured(() => fx.run([], { inspectExposure: seenByBoth }));
    assert.equal(clean.code, 0, 'a skill both agents can see leaves the machine in agreement');

    const claudeOnly = () => ({ list: { 'claude-code': ['review'], codex: [] }, errors: [] });
    const { code, output } = await runCaptured(() => fx.run([], { inspectExposure: claudeOnly }));

    assert.equal(code, 1, 'a partially exposed skill must make status exit non-zero');
    assert.match(output, /partial/, 'the partial row is printed');
    assert.match(output, /review/, 'the skill is named');
    assert.match(output, /codex/, 'the agent that cannot see it is named');
    assert.doesNotMatch(output, /everything is in agreement/);
  });
});

// A listing that could not be read is not a listing of nothing. Reporting it
// as "no skills exposed" would drive a reinstall of every shared skill.
test('an unreadable skill listing is reported as unknown, not as nothing exposed', async () => {
  await onCleanMachine('exposure-error', async (fx) => {
    mkdirSync(join(fx.agents, 'review'), { recursive: true });
    writeFileSync(join(fx.repo, 'skills-manifest.txt'), '[a/b]\nreview\n');
    writeFileSync(
      join(fx.home, '.agents', '.skill-lock.json'),
      JSON.stringify({ skills: { review: { source: 'a/b' } } }),
    );

    const broken = () => ({ list: {}, errors: ['could not list skills for codex'] });
    const { code, output } = await runCaptured(() => fx.run([], { inspectExposure: broken }));

    assert.equal(code, 1);
    assert.match(output, /unknown/);
    assert.doesNotMatch(output, /everything is in agreement/);
  });
});

// The report is filtered by target end to end: a Codex run must not name a
// Claude plugin or Claude's instruction file, and vice versa.
test('Codex status omits Claude integrations', async () => {
  await onCleanMachine('codex-only-report', async (fx) => {
    writeFileSync(
      join(fx.repo, 'integrations.json'),
      JSON.stringify({
        version: 1,
        integrations: [
          { id: 'cm-claude', label: 'context-mode', target: 'claude', type: 'plugin', default: true, plugin: 'context-mode@context-mode' },
          { id: 'srv-codex', label: 'files server', target: 'codex', type: 'mcp', default: true, command: 'mcp-files' },
        ],
      }),
    );

    const codex = await runCaptured(() => fx.run(['--target', 'codex']));
    assert.match(codex.output, /AGENTS\.md/);
    assert.match(codex.output, /Codex MCP|files server/);
    assert.doesNotMatch(codex.output, /Claude plugins/);
    assert.doesNotMatch(codex.output, /CLAUDE\.md/);

    const claude = await runCaptured(() => fx.run(['--target', 'claude']));
    assert.match(claude.output, /CLAUDE\.md/);
    assert.doesNotMatch(claude.output, /AGENTS\.md/);
    assert.doesNotMatch(claude.output, /files server/);
  });
});

// status is the read-only verb: it reports what an install would do and never
// does it.
test('status reports a missing integration as actionable without installing it', async () => {
  await onCleanMachine('integration-actionable', async (fx) => {
    writeFileSync(
      join(fx.repo, 'integrations.json'),
      JSON.stringify({
        version: 1,
        integrations: [
          { id: 'cm-claude', label: 'context-mode', target: 'claude', type: 'plugin', default: true, plugin: 'context-mode@context-mode' },
        ],
      }),
    );

    const { code, output } = await runCaptured(() => fx.run(['--target', 'claude']));
    assert.equal(code, 1, 'a declared integration this machine lacks is actionable');
    assert.match(output, /context-mode/);
    assert.match(output, /apply --install/, 'the report names the command that would install it');
    assert.doesNotMatch(output, /everything is in agreement/);
  });
});

// An invalid manifest is reported, not acted on, and never silently ignored.
test('an invalid integrations.json is reported and makes status exit non-zero', async () => {
  await onCleanMachine('integration-invalid', async (fx) => {
    writeFileSync(
      join(fx.repo, 'integrations.json'),
      JSON.stringify({ version: 1, integrations: [{ id: 'x', label: 'x', target: 'cursor', type: 'plugin', default: true, plugin: 'a@b' }] }),
    );

    const { code, output } = await runCaptured(() => fx.run());
    assert.equal(code, 1);
    assert.match(output, /invalid/);
  });
});

// A bare machine has nothing canonical to ask about, and asking anyway would
// spawn the installer during a read-only command.
test('status never inspects exposure when no canonical skill is installed', async () => {
  await onCleanMachine('no-exposure-call', async (fx) => {
    let called = false;
    const spy = () => { called = true; return { list: {}, errors: [] }; };
    const { code } = await runCaptured(() => fx.run([], { inspectExposure: spy }));
    assert.equal(code, 0);
    assert.equal(called, false, 'a read-only command must not spawn the installer for nothing');
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

