import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cliVersion } from '../src/cli-version.mjs';

const TIP = '1111111111111111111111111111111111111111';

// A fake git that answers the four questions cliVersion asks, so the logic is
// tested without a network or a remote.
function fakeGit({ branch = 'main', remote = 'origin', tip = TIP, hasTip = true, lsRemoteFails = false }) {
  return (args) => {
    const verb = args[2];
    if (verb === 'rev-parse') return branch;
    if (verb === 'remote') return remote;
    if (verb === 'ls-remote') {
      if (lsRemoteFails) throw Object.assign(new Error('fatal: could not read'), { stderr: 'fatal: could not read from remote' });
      return tip ? `${tip}\trefs/heads/${branch}` : '';
    }
    if (verb === 'cat-file') {
      if (!hasTip) throw new Error('not found');
      return '';
    }
    return '';
  };
}

function inCheckout(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), `nortuscc-${prefix}-`));
  mkdirSync(join(dir, '.git'), { recursive: true });
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// npx-from-GitHub runs from a package directory, not a checkout. There is
// nothing to update, because every invocation resolves the repo itself — so
// this must be silent rather than reported as a problem.
test('a directory that is not a checkout is unmanaged, not behind', () => {
  const plain = mkdtempSync(join(tmpdir(), 'nortuscc-noncheckout-'));
  try {
    assert.deepEqual(cliVersion({ root: plain, run: fakeGit({}) }), { state: 'unmanaged' });
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

test('a checkout that already has the remote tip is current', () => {
  inCheckout('cli-current', (dir) => {
    assert.deepEqual(cliVersion({ root: dir, run: fakeGit({ hasTip: true }) }), { state: 'current' });
  });
});

test('a checkout missing the remote tip is behind, and names where to look', () => {
  inCheckout('cli-behind', (dir) => {
    const res = cliVersion({ root: dir, run: fakeGit({ hasTip: false }) });
    assert.equal(res.state, 'behind');
    assert.equal(res.sha, TIP.slice(0, 7));
    assert.equal(res.branch, 'main');
    assert.equal(res.remote, 'origin');
  });
});

// The integration checkout is routinely ahead by commits that have not been
// pushed. Having the remote's tip is what "no pull needed" means, so ahead and
// equal both read as current — a commit count would send the owner to pull away
// their own work.
test('a checkout ahead of the remote is current, not behind', () => {
  inCheckout('cli-ahead', (dir) => {
    // Ahead means the remote tip is an ancestor here: we have it.
    assert.equal(cliVersion({ root: dir, run: fakeGit({ hasTip: true }) }).state, 'current');
  });
});

// Offline is not up to date. Saying 'current' would be a claim nothing verified.
test('an unreachable remote is unknown, not current', () => {
  inCheckout('cli-offline', (dir) => {
    const res = cliVersion({ root: dir, run: fakeGit({ lsRemoteFails: true }) });
    assert.equal(res.state, 'unknown');
    assert.match(res.note, /could not read/);
  });
});

test('a detached HEAD has no branch to compare', () => {
  inCheckout('cli-detached', (dir) => {
    assert.deepEqual(cliVersion({ root: dir, run: fakeGit({ branch: 'HEAD' }) }), { state: 'unmanaged' });
  });
});

test('a checkout with no remote is unmanaged', () => {
  inCheckout('cli-no-remote', (dir) => {
    assert.deepEqual(cliVersion({ root: dir, run: fakeGit({ remote: '' }) }), { state: 'unmanaged' });
  });
});

test('a branch the remote does not publish is unmanaged', () => {
  inCheckout('cli-unpublished', (dir) => {
    assert.deepEqual(cliVersion({ root: dir, run: fakeGit({ tip: '' }) }), { state: 'unmanaged' });
  });
});

// Against real git, so the ls-remote parsing and the cat-file existence test
// are the ones git actually performs rather than ones this test invented.
test('against a real repository, a fetched-behind clone reads as behind', () => {
  const origin = mkdtempSync(join(tmpdir(), 'nortuscc-cli-origin-'));
  const clone = mkdtempSync(join(tmpdir(), 'nortuscc-cli-clone-'));
  const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  try {
    execFileSync('git', ['init', '--quiet', '-b', 'main', origin]);
    writeFileSync(join(origin, 'a.txt'), 'one\n');
    g(origin, '-c', 'user.email=t@e.com', '-c', 'user.name=T', 'add', '.');
    g(origin, '-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '--quiet', '-m', 'one');

    execFileSync('git', ['clone', '--quiet', origin, clone]);
    assert.equal(cliVersion({ root: clone }).state, 'current', 'a fresh clone has the tip');

    writeFileSync(join(origin, 'b.txt'), 'two\n');
    g(origin, '-c', 'user.email=t@e.com', '-c', 'user.name=T', 'add', '.');
    g(origin, '-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '--quiet', '-m', 'two');

    const res = cliVersion({ root: clone });
    assert.equal(res.state, 'behind', 'a commit on the remote it does not have');
    assert.equal(res.sha, g(origin, 'rev-parse', 'HEAD').slice(0, 7));
  } finally {
    rmSync(origin, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  }
});

// --- what status does with it ------------------------------------------------

const emptyCodex = { plugins: new Set(), marketplaces: new Set(), errors: [] };

async function statusWith(deps) {
  const home = mkdtempSync(join(tmpdir(), 'nortuscc-cli-status-'));
  const repo = join(home, 'repo');
  mkdirSync(join(repo, 'claude'), { recursive: true });
  mkdirSync(join(repo, 'codex'), { recursive: true });
  writeFileSync(join(repo, 'claude', 'CLAUDE.md'), '# r\n');
  writeFileSync(join(repo, 'codex', 'AGENTS.md'), '# r\n');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });

  const saved = { ...process.env };
  process.env.NORTUSCC_CLAUDE_DIR = join(home, '.claude');
  process.env.NORTUSCC_CODEX_DIR = join(home, '.codex');
  process.env.NORTUSCC_REPO_DIR = repo;
  process.env.NORTUSCC_STATE_DIR = join(home, 'state');
  process.env.NORTUSCC_AGENTS_DIR = join(home, '.agents', 'skills');

  // Sync the managed files and record their baselines, so the machine starts
  // genuinely in agreement. Without this every assertion about the exit code
  // would pass on config drift instead of on the thing under test.
  const { SYNC } = await import('../src/manifest.mjs');
  const { hashFile, readLock, writeLock, setBaseline } = await import('../src/lock.mjs');
  const { resolveEntry } = await import('../src/resolve.mjs');
  const { copyFileSync } = await import('node:fs');
  const lock = readLock();
  for (const entry of SYNC) {
    const { src, dest } = resolveEntry(entry);
    copyFileSync(src, dest);
    setBaseline(lock, `${entry.target}:${entry.dest}`, hashFile(src));
  }
  writeLock(lock);

  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  try {
    const { run } = await import('../src/commands/status.mjs');
    const code = await run([], { codexState: emptyCodex, ...deps });
    return { code, output: chunks.join('') };
  } finally {
    process.stdout.write = original;
    for (const k of ['NORTUSCC_CLAUDE_DIR', 'NORTUSCC_CODEX_DIR', 'NORTUSCC_REPO_DIR', 'NORTUSCC_STATE_DIR', 'NORTUSCC_AGENTS_DIR']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(home, { recursive: true, force: true });
  }
}

const behind = () => ({ state: 'behind', sha: 'abc1234', branch: 'main', remote: 'origin' });

test('accepting the prompt pulls, and stops rather than reporting from stale code', async () => {
  const pulls = [];
  const { code, output } = await statusWith({
    cliState: behind,
    isTTY: true,
    confirm: async () => true,
    pull: async (args) => { pulls.push(args); return 0; },
  });

  assert.equal(pulls.length, 1, 'the pull ran');
  assert.equal(code, 0);
  assert.match(output, /Re-run/, 'the user is told to re-run rather than shown a stale report');
  assert.doesNotMatch(output, /everything is in agreement/, 'no verdict from the old code');
});

test('declining leaves the machine alone and exits non-zero', async () => {
  const pulls = [];
  const { code, output } = await statusWith({
    cliState: behind,
    isTTY: true,
    confirm: async () => false,
    pull: async (args) => { pulls.push(args); return 0; },
  });

  assert.equal(pulls.length, 0, 'nothing was pulled');
  // The same machine reports 0 with a current CLI, so the 1 is the decline
  // rather than drift the fixture happened to have.
  assert.equal((await statusWith({ cliState: () => ({ state: 'current' }), isTTY: true })).code, 0);
  assert.equal(code, 1, 'a declined update is drift');
  assert.match(output, /nortuscc\s+behind/);
  assert.match(output, /nortuscc pull/, 'the command is named, since the prompt is gone');
});

// A scheduled status has nothing to answer a prompt. It must report and exit,
// never block.
test('without a terminal it never prompts, and exits non-zero', async () => {
  let asked = false;
  const { code, output } = await statusWith({
    cliState: behind,
    isTTY: false,
    confirm: async () => { asked = true; return true; },
    pull: async () => 0,
  });

  assert.equal(asked, false, 'a run with no terminal is never asked');
  assert.equal(code, 1);
  assert.match(output, /nortuscc\s+behind/);
});

// Being offline is ordinary and offers nothing to do, unlike an exposure read
// that failed against local files.
test('an unreachable remote is reported but does not fail the run', async () => {
  const clean = await statusWith({ cliState: () => ({ state: 'current' }), isTTY: true });
  assert.equal(clean.code, 0, 'the fixture machine must start genuinely clean');

  const { code, output } = await statusWith({
    cliState: () => ({ state: 'unknown', note: 'offline' }),
    isTTY: true,
    confirm: async () => { throw new Error('must not prompt on unknown'); },
  });

  assert.match(output, /nortuscc\s+unknown/);
  assert.equal(code, 0, 'offline is not drift, and must not be asked about');
});

test('a current or unmanaged CLI prints no cli section at all', async () => {
  for (const state of ['current', 'unmanaged']) {
    const { output } = await statusWith({ cliState: () => ({ state }), isTTY: true });
    assert.doesNotMatch(output, /^cli$/m, `${state} should be silent`);
  }
});
