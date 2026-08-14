import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfigMode, SKILLS_ONLY, WITH_CONFIG_ALWAYS, WITH_CONFIG_ONCE } from '../src/config-mode.mjs';

// --- flag parsing ------------------------------------------------------------

// Global flags, like --target: a command that never heard of them must not
// report them as unknown options, so they never reach its own parser.
test('the mode flags are stripped from what the command parses', () => {
  const { rest } = parseConfigMode(
    ['--target', 'claude', SKILLS_ONLY, '--yes', WITH_CONFIG_ONCE],
    { recorded: false },
  );
  assert.deepEqual(rest, ['--target', 'claude', '--yes']);
});

test('a recorded skills-only machine manages no config', () => {
  const { manageConfig, persist } = parseConfigMode([], { recorded: true });
  assert.equal(manageConfig, false);
  assert.equal(persist, null, 'reading the mode is not recording it');
});

test('a machine that never set the mode manages config', () => {
  assert.equal(parseConfigMode([], { recorded: false }).manageConfig, true);
});

// Setting the mode has to apply to the run that sets it, or `setup
// --skills-only` would sync the instruction files once on its way to recording
// that it should never sync them.
test('--skills-only takes effect on the very run that records it', () => {
  const { manageConfig, persist } = parseConfigMode([SKILLS_ONLY], { recorded: false });
  assert.equal(manageConfig, false);
  assert.equal(persist, true);
});

test('--no-skills-only records the mode off and manages config again', () => {
  const { manageConfig, persist } = parseConfigMode([WITH_CONFIG_ALWAYS], { recorded: true });
  assert.equal(manageConfig, true);
  assert.equal(persist, false);
});

// The per-run override widens one run without changing what the next one does.
test('--with-config overrides the recorded mode without recording anything', () => {
  const { manageConfig, persist } = parseConfigMode([WITH_CONFIG_ONCE], { recorded: true });
  assert.equal(manageConfig, true);
  assert.equal(persist, null, 'a one-off override must not persist');
});

// --- state ------------------------------------------------------------------

// async, and the body is awaited: a sync try/finally around a promise would
// delete the fixture before the command under test ever ran.
async function onIsolatedMachine(prefix, fn) {
  const home = mkdtempSync(join(tmpdir(), `nortuscc-${prefix}-`));
  const claude = join(home, '.claude');
  const codex = join(home, '.codex');
  const repo = join(home, 'repo');
  mkdirSync(claude, { recursive: true });
  mkdirSync(codex, { recursive: true });
  mkdirSync(join(repo, 'claude'), { recursive: true });
  mkdirSync(join(repo, 'codex'), { recursive: true });
  writeFileSync(join(repo, 'claude', 'CLAUDE.md'), '# from the repo\n');
  writeFileSync(join(repo, 'codex', 'AGENTS.md'), '# from the repo\n');

  const saved = {
    claude: process.env.NORTUSCC_CLAUDE_DIR,
    codex: process.env.NORTUSCC_CODEX_DIR,
    repo: process.env.NORTUSCC_REPO_DIR,
    state: process.env.NORTUSCC_STATE_DIR,
    agents: process.env.NORTUSCC_AGENTS_DIR,
  };
  process.env.NORTUSCC_CLAUDE_DIR = claude;
  process.env.NORTUSCC_CODEX_DIR = codex;
  process.env.NORTUSCC_REPO_DIR = repo;
  process.env.NORTUSCC_STATE_DIR = join(home, 'state');
  process.env.NORTUSCC_AGENTS_DIR = join(home, '.agents', 'skills');

  try {
    return await fn({ home, claude, codex, repo });
  } finally {
    for (const [k, v] of Object.entries({
      NORTUSCC_CLAUDE_DIR: saved.claude,
      NORTUSCC_CODEX_DIR: saved.codex,
      NORTUSCC_REPO_DIR: saved.repo,
      NORTUSCC_STATE_DIR: saved.state,
      NORTUSCC_AGENTS_DIR: saved.agents,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

// Every state record written before the flag existed describes a machine that
// does manage its instruction files, so absence must not read as skills-only.
test('a state record with no skillsOnly field manages config', async () => {
  await onIsolatedMachine('mode-legacy-state', async () => {
    const { readLock, writeLock } = await import('../src/lock.mjs');
    const lock = readLock();
    delete lock.skillsOnly;
    writeLock(lock);
    assert.equal(readLock().skillsOnly, false);
  });
});

test('the mode round-trips through machine state', async () => {
  await onIsolatedMachine('mode-roundtrip', async () => {
    const { readLock, writeLock } = await import('../src/lock.mjs');
    const lock = readLock();
    lock.skillsOnly = true;
    writeLock(lock);
    assert.equal(readLock().skillsOnly, true);
  });
});

// --- what the mode actually protects ----------------------------------------

// The whole point. A user who installed this CLI for its skill set has their
// own CLAUDE.md; apply must not overwrite it from a repo that is not theirs.
test('apply writes no instruction file on a skills-only machine', async () => {
  await onIsolatedMachine('mode-apply', async (fx) => {
    const { run } = await import('../src/commands/apply.mjs');
    const { readLock, writeLock } = await import('../src/lock.mjs');

    const lock = readLock();
    lock.skillsOnly = true;
    writeLock(lock);

    writeFileSync(join(fx.claude, 'CLAUDE.md'), '# mine, written by hand\n');

    const code = await captureOut(() => run([]));
    assert.equal(code.value, 0);
    assert.equal(
      readFileSync(join(fx.claude, 'CLAUDE.md'), 'utf8'),
      '# mine, written by hand\n',
      'the machine keeps its own instruction file',
    );
    assert.equal(existsSync(join(fx.codex, 'AGENTS.md')), false, 'and is given no new one');
    assert.match(code.output, /skills-only/, 'the report says the section was not managed');
  });
});

// Recorded by the commands that already write state, so the flag is typed once
// rather than remembered on every later run.
test('apply records the mode, and honours it on the run that sets it', async () => {
  await onIsolatedMachine('mode-apply-persist', async (fx) => {
    const { run } = await import('../src/commands/apply.mjs');
    const { readLock } = await import('../src/lock.mjs');

    await captureOut(() => run(['--skills-only']));

    assert.equal(readLock().skillsOnly, true, 'the choice is remembered');
    assert.equal(
      existsSync(join(fx.claude, 'CLAUDE.md')),
      false,
      'and takes effect immediately, not from the next run onward',
    );

    // A later bare run still honours it, with no flag repeated.
    await captureOut(() => run([]));
    assert.equal(existsSync(join(fx.claude, 'CLAUDE.md')), false);
  });
});

// --with-config is the escape hatch, and it has to actually reach the copy.
test('--with-config syncs config once on a skills-only machine', async () => {
  await onIsolatedMachine('mode-apply-override', async (fx) => {
    const { run } = await import('../src/commands/apply.mjs');
    const { readLock, writeLock } = await import('../src/lock.mjs');

    const lock = readLock();
    lock.skillsOnly = true;
    writeLock(lock);

    await captureOut(() => run(['--with-config']));
    assert.equal(readFileSync(join(fx.claude, 'CLAUDE.md'), 'utf8'), '# from the repo\n');

    // The override was for that run only; the machine is still skills-only.
    assert.equal(readLock().skillsOnly, true);
  });
});

// Skills-only cuts both directions: a machine whose rules are its own must not
// publish them into someone else's config repo on the first push.
test('capture writes no instruction file into the repo on a skills-only machine', async () => {
  await onIsolatedMachine('mode-capture', async (fx) => {
    const { run } = await import('../src/commands/capture.mjs');
    const { readLock, writeLock } = await import('../src/lock.mjs');

    const lock = readLock();
    lock.skillsOnly = true;
    writeLock(lock);

    writeFileSync(join(fx.claude, 'CLAUDE.md'), '# private rules\n');

    await captureOut(() => run([]));
    assert.equal(
      readFileSync(join(fx.repo, 'claude', 'CLAUDE.md'), 'utf8'),
      '# from the repo\n',
      'the private file never reached the repo',
    );
  });
});

test('status reports the section as unmanaged rather than clean', async () => {
  await onIsolatedMachine('mode-status', async () => {
    const { run } = await import('../src/commands/status.mjs');
    const { readLock, writeLock } = await import('../src/lock.mjs');

    const lock = readLock();
    lock.skillsOnly = true;
    writeLock(lock);

    const emptyCodex = { plugins: new Set(), marketplaces: new Set(), errors: [] };
    const { output } = await captureOut(() => run([], { codexState: emptyCodex }));
    assert.match(output, /instruction files\s+skills-only/, 'the skipped row is printed');
    assert.doesNotMatch(output, /CLAUDE\.md\s+clean/, 'never reported as managed and clean');
  });
});

async function captureOut(fn) {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    const value = await fn();
    return { value, output: chunks.join('') };
  } finally {
    process.stdout.write = original;
  }
}
