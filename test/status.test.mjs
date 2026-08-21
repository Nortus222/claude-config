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
import { hashValue } from '../src/settings-keys.mjs';

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

// Seeds every managed entry into whichever repo/home the current env vars
// point at, so a test starts from a genuinely clean, non-actionable machine.
// A copy entry needs only its baseline hash recorded. A merge-keys entry has
// no fixture source of its own the way CLAUDE.md/AGENTS.md do here, so this
// also writes one first — otherwise it reads as missing-repo, which is just
// as blocked as a genuine manifest gap.
async function seedManagedEntries(lock) {
  const { SYNC } = await import('../src/manifest.mjs');
  const { hashFile, setBaseline } = await import('../src/lock.mjs');
  const { resolveEntry } = await import('../src/resolve.mjs');
  const { applyMerge } = await import('../src/merge-keys.mjs');

  for (const entry of SYNC) {
    const { src, dest, mode } = resolveEntry(entry);
    if (mode === 'copy') {
      const hash = hashFile(src);
      if (hash) {
        copyFileSync(src, dest);
        setBaseline(lock, `${entry.target}:${entry.dest}`, hash);
      }
    } else if (mode === 'merge-keys') {
      writeFileSync(src, JSON.stringify({ theme: 'auto' }) + '\n');
      applyMerge(src, dest, `${entry.target}:${entry.dest}`, lock, { relative: entry.dest, agent: entry.target });
    }
  }
}

test('configReport returns one row per manifest entry', async () => {
  const { SYNC } = await import('../src/manifest.mjs');
  const rows = configReport();
  assert.equal(rows.length, SYNC.length);
  // Paired positionally against SYNC — configReport preserves entry order —
  // rather than checked against the set of modes present anywhere in the
  // manifest: a set membership check can't catch a row reporting the wrong
  // mode for ITS entry as long as that mode exists somewhere else in SYNC
  // (e.g. configReport hardcoding 'copy' for the merge-keys entry would still
  // pass, since 'copy' is a mode SYNC does contain).
  rows.forEach((row, i) => {
    assert.ok(row.dest, 'each row names its destination');
    assert.equal(row.mode, SYNC[i].mode, `row ${i} carries its own entry's mode`);
    assert.ok(typeof row.state === 'string' && row.state.length > 0);
  });
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

  // Claude now owns two entries — its instruction file and its settings
  // keys — so narrowing to 'claude' reports both, never just the first.
  const claudeRows = configReport(entriesForTarget(SYNC, 'claude'));
  assert.deepEqual(claudeRows.map((r) => r.dest), ['CLAUDE.md', 'settings.json']);

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
  const { readLock, writeLock } = await import('../src/lock.mjs');

  const lock = readLock();
  await seedManagedEntries(lock);
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
    const { readLock, writeLock } = await import('../src/lock.mjs');

    // Take a pristine snapshot before any setup (kept for parity with the
    // pre-existing claude-dir check below; the agents/skills fixture doesn't
    // change during setup, so only "after setup" and "after run()" are compared).
    const snapshotBefore = snapshotDirectory(isolatedClaudeDir);

    // Set up a clean machine: every managed file present and baselined
    const lock = readLock();
    await seedManagedEntries(lock);
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
    const { readLock, writeLock } = await import('../src/lock.mjs');

    // Bring config to a clean state so the missing skill is the only thing
    // that can make this run dirty — isolates the wiring under test.
    const lock = readLock();
    await seedManagedEntries(lock);
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
    const { readLock, writeLock } = await import('../src/lock.mjs');

    const lock = readLock();
    await seedManagedEntries(lock);
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
    const restore = {
      NORTUSCC_CLAUDE_DIR: saved.claude,
      NORTUSCC_CODEX_DIR: saved.codex,
      NORTUSCC_REPO_DIR: saved.repo,
      NORTUSCC_AGENTS_DIR: saved.agents,
      NORTUSCC_STATE_DIR: saved.state,
    };
    for (const [key, value] of Object.entries(restore)) {
      // Restoring an env var that was unset before the test would otherwise
      // write the literal string "undefined", leaving it set for every test
      // that runs after.
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
// machine in that state is not in agreement. Read from each agent's own skills
// directory, which is where that agent loads from.
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

// The regression that made this whole check worthless. skillExposure has always
// separated "no selected agent can load this" from "some can", but status
// rendered only the partial row and gated agreement on it alone, so a skill
// loadable by nobody printed nothing and still reported a machine in
// agreement. That is the exact state 18 skills on the author's machine were
// in: recorded as installed, present in the store, placed for neither agent.
test('status reports a skill no selected agent can load, and exits non-zero', async () => {
  await onCleanMachine('unlinked-skill', async (fx) => {
    mkdirSync(join(fx.agents, 'wayfinder'), { recursive: true });
    writeFileSync(join(fx.repo, 'skills-manifest.txt'), '[a/b]\nwayfinder\n');
    writeFileSync(
      join(fx.home, '.agents', '.skill-lock.json'),
      JSON.stringify({ skills: { wayfinder: { source: 'a/b' } } }),
    );

    const seenByNeither = () => ({ list: { 'claude-code': [], codex: [] }, errors: [] });
    const { code, output } = await runCaptured(() => fx.run([], { inspectExposure: seenByNeither }));

    assert.equal(code, 1, 'a skill no agent can load must make status exit non-zero');
    assert.match(output, /unlinked/, 'the unlinked row is printed');
    assert.match(output, /wayfinder/, 'the skill is named');
    assert.doesNotMatch(output, /everything is in agreement/);
  });
});

// A status that names a problem and then suggests a command that cannot fix it
// is worse than one that stays quiet. `apply --install` builds its work from
// the skills the store lacks, so it finds nothing to do for a skill already in
// the store; re-placing that skill into an agent's directory is `update`'s job.
test('an exposure gap is pointed at update, not at apply --install', async () => {
  await onCleanMachine('exposure-advice', async (fx) => {
    mkdirSync(join(fx.agents, 'wayfinder'), { recursive: true });
    writeFileSync(join(fx.repo, 'skills-manifest.txt'), '[a/b]\nwayfinder\n');
    writeFileSync(
      join(fx.home, '.agents', '.skill-lock.json'),
      JSON.stringify({ skills: { wayfinder: { source: 'a/b' } } }),
    );

    const seenByNeither = () => ({ list: { 'claude-code': [], codex: [] }, errors: [] });
    const { output } = await runCaptured(() => fx.run([], { inspectExposure: seenByNeither }));

    assert.match(output, /nortuscc update/, 'the command that can re-place the skill is named');
    assert.doesNotMatch(
      output,
      /apply --install/,
      'nothing is missing from the store, so an install has nothing to offer',
    );
  });
});

// The default probe reads the real directories rather than taking an injected
// answer, so the wiring is exercised end to end at least once: without this,
// every exposure test could pass against a double while the real status
// command read the wrong place entirely.
//
// It also pins the asymmetry. A skill in the store is already loadable by
// Codex and not yet by Claude, so linking it for Claude is the whole repair —
// and the machine has to go quiet once that is done. Asserting a Codex
// placement here instead is what let status stay permanently non-zero.
test('with no probe injected, status reads the real directories and converges', async () => {
  await onCleanMachine('exposure-default-probe', async (fx) => {
    mkdirSync(join(fx.agents, 'wayfinder'), { recursive: true });
    writeFileSync(join(fx.repo, 'skills-manifest.txt'), '[a/b]\nwayfinder\n');
    writeFileSync(
      join(fx.home, '.agents', '.skill-lock.json'),
      JSON.stringify({ skills: { wayfinder: { source: 'a/b' } } }),
    );

    const unplaced = await runCaptured(() => fx.run());
    assert.equal(unplaced.code, 1, 'a store skill Claude cannot load is drift');
    assert.match(unplaced.output, /partial/);
    assert.match(unplaced.output, /claude-code/, 'Claude is the agent that cannot load it');
    assert.doesNotMatch(unplaced.output, /missing from.*codex/, 'Codex loads from the store');

    // A symlink into the shared store, matching what the real installer does
    // (see skill-links.mjs) rather than a bare directory: the undeclared
    // section now walks ~/.claude/skills for exactly this distinction, and a
    // plain directory here would misreport as a stray, undeclared skill.
    mkdirSync(join(fx.claude, 'skills'), { recursive: true });
    symlinkSync(join(fx.agents, 'wayfinder'), join(fx.claude, 'skills', 'wayfinder'));

    const placed = await runCaptured(() => fx.run());
    assert.equal(placed.code, 0, 'linking it for Claude alone brings the machine into agreement');
    assert.match(placed.output, /everything is in agreement/);
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

// Runs status against an isolated HOME and returns its printed output, so the
// section can be asserted on without reading the developer's real machine.
async function statusOutput(args = [], setup = () => {}, deps = {}) {
  const isolated = mkdtempSync(join(tmpdir(), 'nortuscc-undeclared-'));
  mkdirSync(join(isolated, '.claude'), { recursive: true });
  mkdirSync(join(isolated, '.codex'), { recursive: true });
  mkdirSync(join(isolated, '.agents', 'skills'), { recursive: true });
  const repoDir = mkdtempSync(join(tmpdir(), 'nortuscc-undeclared-repo-'));
  mkdirSync(join(repoDir, 'claude'), { recursive: true });
  mkdirSync(join(repoDir, 'codex'), { recursive: true });
  writeFileSync(join(repoDir, 'claude', 'CLAUDE.md'), '# Test');
  writeFileSync(join(repoDir, 'codex', 'AGENTS.md'), '# Test codex');
  setup(isolated, repoDir);

  const saved = { ...process.env };
  process.env.NORTUSCC_CLAUDE_DIR = join(isolated, '.claude');
  process.env.NORTUSCC_CODEX_DIR = join(isolated, '.codex');
  process.env.NORTUSCC_AGENTS_DIR = join(isolated, '.agents', 'skills');
  process.env.NORTUSCC_STATE_DIR = join(isolated, 'state');
  process.env.NORTUSCC_REPO_DIR = repoDir;

  // Bring the config rows to a clean state, so the inventory section is the
  // only thing that can make these runs dirty. Without this every row reads
  // 'unmanaged', status is dirty on its own account, and "everything is in
  // agreement" could never print — which is half of what this asserts.
  const { readLock, writeLock } = await import('../src/lock.mjs');
  const lock = readLock();
  await seedManagedEntries(lock);
  writeLock(lock);

  // Seeding rewrites the fixture's settings.keys.json, so a test that needs a
  // specific settings state has to set it up after that, not in `setup`.
  const { postSeed, ...runDeps } = deps;
  if (postSeed) postSeed(isolated, repoDir);

  const originalWrite = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (chunk) => { chunks.push(chunk.toString()); return true; };
  try {
    const { run: isolatedRun } = await import('../src/commands/status.mjs');
    const code = await isolatedRun(args, {
      codexState: emptyCodex(),
      inspectExposure: () => ({ list: {}, errors: [] }),
      cliState: () => ({ state: 'unmanaged' }),
      ...runDeps,
    });
    return { code, output: chunks.join('') };
  } finally {
    process.stdout.write = originalWrite;
    for (const key of ['NORTUSCC_CLAUDE_DIR', 'NORTUSCC_CODEX_DIR', 'NORTUSCC_AGENTS_DIR', 'NORTUSCC_STATE_DIR', 'NORTUSCC_REPO_DIR']) {
      // Restoring an env var that was unset before the test would otherwise
      // write the literal string "undefined", leaving it set for every test
      // that runs after.
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('a clean machine says every category is declared rather than staying silent', async () => {
  const { output } = await statusOutput();
  assert.match(output, /undeclared/);
  assert.match(output, /all categories\s+declared/);
});

test('an undeclared agent is named in the section', async () => {
  const { output } = await statusOutput([], (home) => {
    mkdirSync(join(home, '.claude', 'agents', 'awesome-claude-agents'), { recursive: true });
  });
  assert.match(output, /agents\s+awesome-claude-agents/);
});

// The false-green this whole section exists to close.
test('undeclared items suppress "everything is in agreement"', async () => {
  const clean = await statusOutput();
  assert.match(clean.output, /everything is in agreement/);

  const dirty = await statusOutput([], (home) => {
    mkdirSync(join(home, '.claude', 'agents', 'stray'), { recursive: true });
  });
  assert.doesNotMatch(dirty.output, /everything is in agreement/);
});

// Informational by default, so a scheduled run does not start failing the day
// this ships.
test('undeclared items alone do not change the exit code', async () => {
  const { code } = await statusOutput([], (home) => {
    mkdirSync(join(home, '.claude', 'agents', 'stray'), { recursive: true });
  });
  assert.equal(code, 0);
});

test('an unreadable category reports unknown rather than nothing', async () => {
  const { output } = await statusOutput([], (home) => {
    writeFileSync(join(home, '.claude', 'settings.json'), '{ not json');
  });
  assert.match(output, /hooks\s+unknown/);
});

test('--strict makes an undeclared item exit non-zero', async () => {
  const stray = (home) => mkdirSync(join(home, '.claude', 'agents', 'stray'), { recursive: true });
  assert.equal((await statusOutput([], stray)).code, 0);
  assert.equal((await statusOutput(['--strict'], stray)).code, 1);
});

test('--strict makes an unreadable category exit non-zero', async () => {
  const broken = (home) => writeFileSync(join(home, '.claude', 'settings.json'), '{ not json');
  assert.equal((await statusOutput(['--strict'], broken)).code, 1);
});

test('--strict on a clean machine still exits zero and agrees', async () => {
  const { code, output } = await statusOutput(['--strict']);
  assert.equal(code, 0);
  assert.match(output, /everything is in agreement/);
});

function withPlugin(home) {
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'superpowers@claude-plugins-official': [{ scope: 'user', version: '6.3.0' }] } }),
  );
  writeFileSync(
    join(home, '.claude', 'plugins', 'known_marketplaces.json'),
    JSON.stringify({ 'claude-plugins-official': {} }),
  );
}

test('--versions prints the installed version of a declared plugin', async () => {
  const setup = (home, repoDir) => {
    withPlugin(home);
    writeFileSync(
      join(repoDir, 'integrations.json'),
      JSON.stringify({
        version: 1,
        integrations: [{
          id: 'superpowers-claude', label: 'superpowers', target: 'claude',
          type: 'plugin', default: true, plugin: 'superpowers@claude-plugins-official',
        }],
      }),
    );
  };

  const plain = await statusOutput([], setup);
  assert.doesNotMatch(plain.output, /6\.3\.0/);

  const detailed = await statusOutput(['--versions'], setup);
  assert.match(detailed.output, /superpowers\s+installed\s+6\.3\.0/);
});

// An absent version must never be mistaken for a matching one.
test('--versions reports an unreadable version as unknown', async () => {
  const setup = (home, repoDir) => {
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ 'a@claude-plugins-official': true }));
    writeFileSync(join(home, '.claude', 'plugins', 'known_marketplaces.json'), JSON.stringify({ 'claude-plugins-official': {} }));
    writeFileSync(
      join(repoDir, 'integrations.json'),
      JSON.stringify({
        version: 1,
        integrations: [{ id: 'a', label: 'a', target: 'claude', type: 'plugin', default: true, plugin: 'a@claude-plugins-official' }],
      }),
    );
  };

  const { output } = await statusOutput(['--versions'], setup);
  assert.match(output, /a\s+installed\s+unknown/);
});

// --versions only adds a column; it must not swallow the pending list or the
// hint that repairs it. A machine missing a declared plugin has to keep
// naming `apply --install` whether or not --versions is passed.
test('--versions keeps the pending list and its repair hint for a missing plugin', async () => {
  const setup = (_home, repoDir) => {
    writeFileSync(
      join(repoDir, 'integrations.json'),
      JSON.stringify({
        version: 1,
        integrations: [{
          id: 'superpowers-claude', label: 'superpowers', target: 'claude',
          type: 'plugin', default: true, plugin: 'superpowers@claude-plugins-official',
        }],
      }),
    );
  };

  const { output } = await statusOutput(['--versions'], setup);
  assert.match(output, /superpowers/, 'the missing plugin is still named');
  assert.match(output, /apply --install/, 'the repair hint must survive --versions');
});

// The regression the fix above traded one loss for another: making
// pending.length === 0 the outer branch meant --versions only ever listed
// versions when NOTHING was pending, hiding an installed plugin's version
// the moment any other plugin was missing — precisely when diffing two
// machines' output is most wanted.
test('--versions shows an installed version alongside a pending plugin and its hint', async () => {
  const setup = (home, repoDir) => {
    withPlugin(home);
    writeFileSync(
      join(repoDir, 'integrations.json'),
      JSON.stringify({
        version: 1,
        integrations: [
          {
            id: 'superpowers-claude', label: 'superpowers', target: 'claude',
            type: 'plugin', default: true, plugin: 'superpowers@claude-plugins-official',
          },
          {
            id: 'gone-claude', label: 'gone', target: 'claude',
            type: 'plugin', default: true, plugin: 'gone@claude-plugins-official',
          },
        ],
      }),
    );
  };

  const { output } = await statusOutput(['--versions'], setup);
  assert.match(output, /superpowers\s+installed\s+6\.3\.0/, 'the installed plugin still shows its version');
  assert.match(output, /apply --install/, 'the repair hint must still name the missing plugin\'s fix');
});

// The join point of three seams that are each unit-tested on both sides and
// never together: the allow list undeclared() reads, the declared hook set
// declaredIds() is given, and the manifestDefects() spread. A mutation
// dropping any one of them passed the whole suite before this test existed.
test('undeclared honours allow, declared hooks, and manifest defects together', async () => {
  const setup = (home, repoDir) => {
    mkdirSync(join(repoDir, 'claude', 'hooks'), { recursive: true });
    writeFileSync(join(repoDir, 'claude', 'hooks', 'session.mjs'), '// test hook\n');
    writeFileSync(
      join(repoDir, 'integrations.json'),
      JSON.stringify({
        version: 1,
        allow: { agents: ['stray-agent'] },
        integrations: [
          {
            id: 'session-hook', label: 'session hook', target: 'claude',
            type: 'hook', default: true, event: 'SessionStart', file: 'claude/hooks/session.mjs',
          },
          {
            id: 'bad-plugin', label: 'bad plugin', target: 'claude',
            type: 'plugin', default: true, plugin: 'foo@undeclared-market',
          },
        ],
      }),
    );

    // An undeclared agent that only the allow entry above should silence.
    mkdirSync(join(home, '.claude', 'agents', 'stray-agent'), { recursive: true });

    // The declared hook, registered under the path nortuscc installs hooks to
    // (node <claudeDir>/hooks/<basename of file>), so it must read as
    // declared rather than undeclared.
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{
            hooks: [{ type: 'command', command: `node ${join(home, '.claude', 'hooks', 'session.mjs')}` }],
          }],
        },
      }),
    );
  };

  const { output } = await statusOutput([], setup);

  assert.doesNotMatch(output, /stray-agent/, 'the allow list must silence the item it names');
  assert.doesNotMatch(output, /hooks\s+SessionStart/, 'a declared hook must not be reported as undeclared');
  assert.match(output, /manifest\s+foo@undeclared-market/, 'an undeclared marketplace is still reported');
});

// A per-key baseline has to exist for a key to read as anything but
// 'unmanaged', so these tests seed the state file directly rather than running
// a second apply.
function seedKeyBaselines(home, values) {
  mkdirSync(join(home, 'state'), { recursive: true });
  const statePath = join(home, 'state', 'state.json');
  const existing = JSON.parse(readFileSync(statePath, 'utf8'));
  for (const [key, value] of Object.entries(values)) {
    existing.files[`claude:settings.json#${key}`] = { hash: hashValue(value), appliedAt: '2026-01-01T00:00:00.000Z' };
  }
  writeFileSync(statePath, JSON.stringify(existing));
}

test('a settings file whose owned keys all agree reports one row, not one per key', async () => {
  const { output } = await statusOutput([], () => {}, {
    postSeed: (home, repoDir) => {
      writeFileSync(
        join(repoDir, 'claude', 'settings.keys.json'),
        JSON.stringify({ theme: 'auto', tui: 'fullscreen' }),
      );
      writeFileSync(
        join(home, '.claude', 'settings.json'),
        JSON.stringify({ theme: 'auto', tui: 'fullscreen', permissions: {} }),
      );
      seedKeyBaselines(home, { theme: 'auto', tui: 'fullscreen' });
    },
  });

  assert.match(output, /settings\.json\s+clean/);
  assert.doesNotMatch(output, /settings\.json#/, 'no per-key rows while every key agrees');
});

test('a drifted key gets its own row and a matching key does not', async () => {
  const { output } = await statusOutput([], () => {}, {
    postSeed: (home, repoDir) => {
      writeFileSync(
        join(repoDir, 'claude', 'settings.keys.json'),
        JSON.stringify({ theme: 'dark', tui: 'fullscreen' }),
      );
      writeFileSync(
        join(home, '.claude', 'settings.json'),
        JSON.stringify({ theme: 'dark', tui: 'compact' }),
      );
      seedKeyBaselines(home, { theme: 'dark', tui: 'fullscreen' });
    },
  });

  assert.match(output, /settings\.json#tui/, 'the drifted key is named');
  assert.doesNotMatch(output, /settings\.json#theme/, 'the agreeing key is not');
});

// A fresh machine has no baseline for any key, so all four read 'unmanaged'.
// Four identical rows would be as useless as one hidden conflict.
test('a machine that has never synced reports one unmanaged row, not one per key', async () => {
  const { output } = await statusOutput([], () => {}, {
    postSeed: (home, repoDir) => {
      writeFileSync(
        join(repoDir, 'claude', 'settings.keys.json'),
        JSON.stringify({ theme: 'auto', tui: 'fullscreen' }),
      );
      writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ theme: 'auto' }));
      mkdirSync(join(home, 'state'), { recursive: true });
      const statePath = join(home, 'state', 'state.json');
      const existing = JSON.parse(readFileSync(statePath, 'utf8'));
      for (const key of Object.keys(existing.files)) {
        if (key.startsWith('claude:settings.json#')) delete existing.files[key];
      }
      writeFileSync(statePath, JSON.stringify(existing));
    },
  });

  assert.match(output, /settings\.json\s+unmanaged/);
  assert.doesNotMatch(output, /settings\.json#/);
});

// A repo file validateOwnedKeys refuses is present and readable, not absent —
// reporting 'missing-repo' would send the user chasing a file that is right
// there. This is the whole-branch reviewer's exact repro: a credential-shaped
// key in settings.keys.json.
test('a refused repo file is surfaced as invalid, not a false missing-repo', async () => {
  const { code, output } = await statusOutput([], () => {}, {
    postSeed: (home, repoDir) => {
      writeFileSync(join(repoDir, 'claude', 'settings.keys.json'), JSON.stringify({ apiKey: 'x' }));
    },
  });

  assert.match(output, /manifest\s+invalid\s+.*looks like a secret/, 'the actual complaint is printed');
  assert.doesNotMatch(output, /missing-repo/, 'must not read as absent when it is present and refused');
  assert.doesNotMatch(output, /absent from the repo/, 'the missing-repo note would be false here');
  assert.equal(code, 1, 'a refused repo file must not read as a clean machine');
});

// `settings.json#effortLevel` is 25 characters, past the section's shared
// 16-char default. The fixed width used to leave it unpadded (padEnd is a
// no-op once the label is already longer) while every shorter label in the
// same section still padded to 16 — misaligning the state column for every
// row but this one. labelWidth sizes the whole section to its longest label.
test('a long per-key label keeps the config section columns aligned', async () => {
  const { output } = await statusOutput([], () => {}, {
    postSeed: (home, repoDir) => {
      writeFileSync(
        join(repoDir, 'claude', 'settings.keys.json'),
        JSON.stringify({ effortLevel: 'high', tui: 'fullscreen' }),
      );
      writeFileSync(
        join(home, '.claude', 'settings.json'),
        JSON.stringify({ effortLevel: 'low', tui: 'fullscreen' }),
      );
      seedKeyBaselines(home, { effortLevel: 'high', tui: 'fullscreen' });
    },
  });

  // The row itself: its label is exactly as wide as the column, so a single
  // space separates it from its state either way — this alone would not have
  // caught the bug.
  assert.match(output, /settings\.json#effortLevel local-ahead/);
  // The regression: a short label in the same section padded only to 16
  // before this fix, giving 8 spaces here instead of the 17 a 25-wide column
  // requires.
  assert.match(output, /CLAUDE\.md {17}clean/, 'a short label pads out to the long label\'s width, not the 16-char default');
});

// The spec's own verification list names the blocked case alongside the
// per-key row and the clean case; this is the one that was never added. An
// unparseable local settings.json is neither a conflict --take-repo/--take-local
// can resolve nor a missing repo file — it is BLOCKED on its own account, and
// must read that way rather than as clean.
test('an unparseable local settings file is blocked, not clean', async () => {
  const { code, output } = await statusOutput([], () => {}, {
    // Seeding writes a valid settings.json, so the invalid one has to be
    // written after seeding, exactly like the postSeed cases above.
    postSeed: (home) => {
      writeFileSync(join(home, '.claude', 'settings.json'), '{ not json');
    },
  });

  assert.match(output, /settings\.json\s+unparseable-local/);
  assert.match(output, /could not be parsed/);
  assert.equal(code, 1, 'a blocked settings file must not read as a clean machine');
});
