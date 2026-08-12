import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'nortuscc-apply-'));
const claude = join(home, '.claude');
const codex = join(home, '.codex');
mkdirSync(claude, { recursive: true });
mkdirSync(codex, { recursive: true });
process.env.NORTUSCC_CLAUDE_DIR = claude;
// Both agent dirs must be redirected, not just Claude's. apply writes one file
// per manifest entry, so leaving the Codex side unset points AGENTS.md at the
// developer's real ~/.codex and the suite writes to the live machine.
process.env.NORTUSCC_CODEX_DIR = codex;
// Machine state no longer lives under ~/.claude, so redirecting the agent dirs
// is no longer enough to keep a run off the developer's machine.
process.env.NORTUSCC_STATE_DIR = join(home, 'state');

const { run, summarizeSkillsInstall } = await import('../src/commands/apply.mjs');
const { SYNC } = await import('../src/manifest.mjs');
const { resolveEntry } = await import('../src/resolve.mjs');
const { readLock } = await import('../src/lock.mjs');
const { statePath, backupRoot } = await import('../src/resolve.mjs');

test('apply on a bare machine copies every managed file', async () => {
  const code = await run([]);
  assert.equal(code, 0);

  for (const entry of SYNC) {
    const { dest } = resolveEntry(entry);
    assert.ok(existsSync(dest), `${entry.dest} should exist after apply`);
  }
});

// --target is the whole point of tagging entries, and "did not write the other
// agent's file" is the half that a filter bug leaves silently broken: writing
// too much still leaves the named target correct.
test('apply --target claude writes CLAUDE.md and never touches the Codex side', async () => {
  const soloHome = mkdtempSync(join(tmpdir(), 'nortuscc-apply-solo-'));
  const soloClaude = join(soloHome, '.claude');
  const soloCodex = join(soloHome, '.codex');
  mkdirSync(soloClaude, { recursive: true });
  mkdirSync(soloCodex, { recursive: true });

  const saved = [process.env.NORTUSCC_CLAUDE_DIR, process.env.NORTUSCC_CODEX_DIR];
  process.env.NORTUSCC_CLAUDE_DIR = soloClaude;
  process.env.NORTUSCC_CODEX_DIR = soloCodex;
  try {
    assert.equal(await run(['--target', 'claude']), 0);
    assert.ok(existsSync(join(soloClaude, 'CLAUDE.md')), 'the named target is written');
    assert.equal(existsSync(join(soloCodex, 'AGENTS.md')), false, 'the other target is untouched');
  } finally {
    [process.env.NORTUSCC_CLAUDE_DIR, process.env.NORTUSCC_CODEX_DIR] = saved;
  }
});

test('apply --target codex writes AGENTS.md and never touches the Claude side', async () => {
  const soloHome = mkdtempSync(join(tmpdir(), 'nortuscc-apply-solo-codex-'));
  const soloClaude = join(soloHome, '.claude');
  const soloCodex = join(soloHome, '.codex');
  mkdirSync(soloClaude, { recursive: true });
  mkdirSync(soloCodex, { recursive: true });

  const saved = [process.env.NORTUSCC_CLAUDE_DIR, process.env.NORTUSCC_CODEX_DIR];
  process.env.NORTUSCC_CLAUDE_DIR = soloClaude;
  process.env.NORTUSCC_CODEX_DIR = soloCodex;
  try {
    assert.equal(await run(['--target', 'codex']), 0);
    assert.ok(existsSync(join(soloCodex, 'AGENTS.md')), 'the named target is written');
    assert.equal(existsSync(join(soloClaude, 'CLAUDE.md')), false, 'the other target is untouched');
  } finally {
    [process.env.NORTUSCC_CLAUDE_DIR, process.env.NORTUSCC_CODEX_DIR] = saved;
  }
});

test('an invalid --target exits 2 before apply writes anything', async () => {
  const soloHome = mkdtempSync(join(tmpdir(), 'nortuscc-apply-badtarget-'));
  const soloClaude = join(soloHome, '.claude');
  const soloCodex = join(soloHome, '.codex');
  mkdirSync(soloClaude, { recursive: true });
  mkdirSync(soloCodex, { recursive: true });

  const saved = [process.env.NORTUSCC_CLAUDE_DIR, process.env.NORTUSCC_CODEX_DIR];
  process.env.NORTUSCC_CLAUDE_DIR = soloClaude;
  process.env.NORTUSCC_CODEX_DIR = soloCodex;
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(await run(['--target', 'cursor']), 2);
    assert.equal(existsSync(join(soloClaude, 'CLAUDE.md')), false);
    assert.equal(existsSync(join(soloCodex, 'AGENTS.md')), false);
  } finally {
    console.error = originalError;
    [process.env.NORTUSCC_CLAUDE_DIR, process.env.NORTUSCC_CODEX_DIR] = saved;
  }
});

// Baselines are keyed by target. Keying by dest alone would let a future
// entry pair — say two agents that both call their file AGENTS.md — silently
// share one baseline, so each agent's apply would read the other's hash as
// its own and report a clean machine that had never been synced.
test('apply records a baseline per target, never one shared by dest name', async () => {
  const lock = readLock();
  for (const entry of SYNC) {
    const key = `${entry.target}:${entry.dest}`;
    assert.ok(lock.files[key], `no baseline recorded for ${key}`);
    assert.match(lock.files[key].hash, /^sha256:/);
    assert.equal(lock.files[entry.dest], undefined, `${entry.dest} must not be keyed without its target`);
  }
});

test('apply on a bare machine creates no backup directory (nothing needed backing up)', () => {
  assert.equal(existsSync(backupRoot()), false, 'a first apply with no pre-existing files must not touch backups/');
});

test('apply is idempotent — a second run changes nothing and still exits 0', async () => {
  const before = readFileSync(join(claude, 'CLAUDE.md'), 'utf8');
  const code = await run([]);
  assert.equal(code, 0);
  assert.equal(readFileSync(join(claude, 'CLAUDE.md'), 'utf8'), before);
});

test('a clean second run does not rewrite the lockfile at all', async () => {
  const lockBytesBefore = readFileSync(statePath(), 'utf8');
  const mtimeBefore = statSync(statePath()).mtimeMs;

  // Force the clock forward so a spurious rewrite would show up as a changed
  // mtime even on filesystems with coarse mtime resolution.
  await new Promise((r) => setTimeout(r, 20));

  const code = await run([]);
  assert.equal(code, 0);
  assert.equal(readFileSync(statePath(), 'utf8'), lockBytesBefore, 'lockfile bytes must be untouched on a clean run');
  assert.equal(statSync(statePath()).mtimeMs, mtimeBefore, 'lockfile must not be rewritten on a clean run');
});

test('apply leaves a local-only edit alone and exits 0', async () => {
  const f = join(claude, 'CLAUDE.md');
  writeFileSync(f, '# edited locally\n');
  const code = await run([]);
  assert.equal(code, 0);
  assert.equal(readFileSync(f, 'utf8'), '# edited locally\n', 'apply must not clobber a local edit');
});

test('apply --take-repo overwrites the local edit', async () => {
  const f = join(claude, 'CLAUDE.md');
  writeFileSync(f, '# still edited\n');
  const code = await run(['--take-repo']);
  assert.equal(code, 0);
  assert.notEqual(readFileSync(f, 'utf8'), '# still edited\n');
});

// Fix round 1, finding 1: --take-local was parsed but never wired to
// anything in apply.mjs (only --take-repo fed applyCopy's `force`), so it was
// silently accepted and did nothing — a conflict stayed refused regardless.
// apply only ever moves repo -> machine, so "keep the local version" is not
// a resolution apply can perform at all; it must refuse the flag outright
// and point at capture, not attempt and fail silently.
test('apply --take-local is refused outright — the flag does not fit apply\'s direction', async () => {
  const lockBytesBefore = readFileSync(statePath(), 'utf8');
  let stderr = '';
  const originalError = console.error;
  console.error = (msg) => { stderr += String(msg) + '\n'; };
  let code;
  try {
    code = await run(['--take-local']);
  } finally {
    console.error = originalError;
  }
  assert.notEqual(code, 0, '--take-local must not be silently accepted by apply');
  assert.match(stderr, /capture --take-local/, 'must point the user at the command that actually supports it');
  assert.equal(readFileSync(statePath(), 'utf8'), lockBytesBefore, 'a refused flag must not touch the lockfile');
});

// Fix round 1, finding 2: bootstrap.sh printed a restart reminder on every
// run; the CLI dropped it entirely. settings.json/CLAUDE.md are only read at
// Claude Code startup, so a successful apply that changed one has no visible
// effect until the user restarts. Gated on actually having changed something,
// so a clean re-run stays silent (idempotency).
test('apply prints a restart reminder when it actually changed a copied file', async () => {
  writeFileSync(join(claude, 'CLAUDE.md'), '# yet another local edit\n');
  let output = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = function (chunk) {
    output += chunk.toString();
    return true;
  };
  let code;
  try {
    code = await run(['--take-repo']);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(code, 0);
  assert.match(output, /Restart Claude Code/, 'a run that changed a file must remind the user to restart');
});

test('a clean apply run prints no restart reminder', async () => {
  let output = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = function (chunk) {
    output += chunk.toString();
    return true;
  };
  let code;
  try {
    code = await run([]);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(code, 0);
  assert.doesNotMatch(output, /Restart Claude Code/, 'a no-op run must stay silent — no false reminder');
});

test('an unknown mode is reported and left alone, not treated as a conflict', async () => {
  const bogusEntry = { target: 'claude', src: 'claude/CLAUDE.md', dest: 'some-file', mode: 'bogus' };
  const lockBytesBefore = readFileSync(statePath(), 'utf8');

  const code = await run([], [bogusEntry]);

  // BLOCKED like conflict and missing-repo, but not itself a refused conflict:
  // apply cannot remediate a mode it does not understand, so it must not
  // affect the exit code, must not write anything for that entry, and must
  // not touch the lockfile.
  assert.equal(code, 0);
  assert.equal(existsSync(join(claude, 'some-file')), false, 'apply must not write an entry with an unknown mode');
  assert.equal(readFileSync(statePath(), 'utf8'), lockBytesBefore, 'an unknown-mode entry must not touch the lockfile');
});

// Fix round 2, finding 1: installGroups' per-source results were discarded,
// so a failed install still reported "installed" and exited 0. These tests
// drive the reporting logic directly with crafted results — never through a
// real install — matching the reviewer's guidance that dryRun already covers
// installGroups' own wiring and no injectable-spawn seam is needed here.
test('summarizeSkillsInstall reports every skill installed when every source succeeds', () => {
  const missing = [
    { name: 'one', source: 'a/b' },
    { name: 'two', source: 'a/b' },
    { name: 'three', source: 'c/d' },
  ];
  const results = [
    { source: 'a/b', ok: true },
    { source: 'c/d', ok: true },
  ];
  const summary = summarizeSkillsInstall(missing, results);
  assert.equal(summary.failed, 0);
  assert.equal(summary.lines.length, 1);
  assert.match(summary.lines[0], /installed/);
  assert.match(summary.lines[0], /one/);
  assert.match(summary.lines[0], /two/);
  assert.match(summary.lines[0], /three/);
});

test('summarizeSkillsInstall reports every skill failed when every source fails, and counts them', () => {
  const missing = [
    { name: 'one', source: 'a/b' },
    { name: 'two', source: 'c/d' },
  ];
  const results = [
    { source: 'a/b', ok: false },
    { source: 'c/d', ok: false },
  ];
  const summary = summarizeSkillsInstall(missing, results);
  assert.equal(summary.failed, 2);
  assert.equal(summary.lines.length, 1);
  assert.match(summary.lines[0], /failed/);
});

test('summarizeSkillsInstall keeps a partial failure visible as partial — not collapsed either way', () => {
  const missing = [
    { name: 'good', source: 'a/b' },
    { name: 'bad', source: 'c/d' },
  ];
  const results = [
    { source: 'a/b', ok: true },
    { source: 'c/d', ok: false },
  ];
  const summary = summarizeSkillsInstall(missing, results);
  assert.equal(summary.failed, 1);
  // Both an "installed" row (for the source that succeeded) and a "failed"
  // row (for the source that didn't) must be present — a partial failure is
  // neither total success nor total failure.
  assert.equal(summary.lines.length, 2);
  const joined = summary.lines.join('\n');
  assert.match(joined, /installed/);
  assert.match(joined, /good/);
  assert.match(joined, /failed/);
  assert.match(joined, /bad/);
});

test('summarizeSkillsInstall with nothing missing reports nothing and fails nothing', () => {
  const summary = summarizeSkillsInstall([], []);
  assert.deepEqual(summary, { lines: [], failed: 0 });
});
