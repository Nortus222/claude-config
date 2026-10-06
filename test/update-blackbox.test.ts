import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { writeFakeBin } from './support/cli.ts';

const exec = promisify(execFile);
const REPO = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(REPO, 'bin', 'nortuscc.mjs');
const CHECKOUT_MANIFEST = join(REPO, 'skills-manifest.txt');
const hashOf = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();

// A local source repo `o/r` with three skills, plus the tree SHA of each folder.
function upstream() {
  const dir = mkdtempSync(join(tmpdir(), 'nortuscc-upstream-'));
  git(dir, 'init', '-q');
  for (const name of ['stale', 'fresh', 'wizard']) {
    mkdirSync(join(dir, 's', name), { recursive: true });
    writeFileSync(join(dir, 's', name, 'SKILL.md'), `# ${name}\n`);
  }
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'skills');
  const tree = (name: string) => git(dir, 'rev-parse', `HEAD:s/${name}`);
  return { url: `file://${dir}`, trees: { stale: tree('stale'), fresh: tree('fresh'), wizard: tree('wizard') } };
}

// Models the installer's surface: the shared store, the lock, and Claude's links.
const FAKE_NPX = `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
const argv = process.argv.slice(2);
appendFileSync(process.env.NORTUSCC_TEST_LOG, JSON.stringify(argv) + '\\n');
const verb = argv[2];
if (process.env.NORTUSCC_TEST_FAIL === verb) process.exit(1);
const store = process.env.NORTUSCC_AGENTS_DIR;
const lockPath = join(dirname(store), '.skill-lock.json');
const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : { skills: {} };
const upstream = JSON.parse(readFileSync(process.env.NORTUSCC_TEST_UPSTREAM, 'utf8'));
const names = (from) => { const out = []; for (let i = from; i < argv.length && !argv[i].startsWith('--'); i++) out.push(argv[i]); return out; };
const claudeLink = (n) => join(process.env.NORTUSCC_CLAUDE_DIR, 'skills', n);
if (verb === 'add') {
  const agents = argv.includes('--agent') ? names(argv.indexOf('--agent') + 1) : [];
  for (const n of names(argv.indexOf('--skill') + 1)) {
    mkdirSync(join(store, n), { recursive: true });
    lock.skills[n] = upstream[n];
    if (agents.includes('claude-code')) mkdirSync(claudeLink(n), { recursive: true });
  }
} else if (verb === 'update') {
  for (const n of names(3)) lock.skills[n] = { ...lock.skills[n], skillFolderHash: upstream[n].skillFolderHash };
} else if (verb === 'remove') {
  for (const n of names(3)) { rmSync(join(store, n), { recursive: true, force: true }); rmSync(claudeLink(n), { recursive: true, force: true }); delete lock.skills[n]; }
}
writeFileSync(lockPath, JSON.stringify(lock));
`;

type Trees = Record<'stale' | 'fresh' | 'wizard', string>;
type Machine = { env: NodeJS.ProcessEnv; repo: string; state: string; store: string; log: string; trees: Trees };

// installed: name -> lock hash. Every installed skill is in the store and linked for Claude.
function machine(options: { installed: Record<string, string>; manifest: string; unreachable?: boolean; extraLock?: Record<string, object> }): Machine {
  const up = upstream();
  const home = mkdtempSync(join(tmpdir(), 'nortuscc-update-bb-'));
  const m = {
    repo: join(home, 'repo'), claude: join(home, '.claude'), codex: join(home, '.codex'),
    store: join(home, '.agents', 'skills'), state: join(home, 'state'), log: join(home, 'npx.log'), bin: join(home, 'bin'),
  };
  for (const dir of [m.repo, m.claude, m.codex, m.store, m.bin]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(m.repo, 'skills-manifest.txt'), options.manifest);
  const sourceUrl = options.unreachable ? `file://${join(home, 'missing')}` : up.url;
  const entry = (name: string, hash: string) => ({ source: 'o/r', sourceUrl, skillPath: `s/${name}/SKILL.md`, skillFolderHash: hash });
  const lock: Record<string, object> = { ...options.extraLock };
  for (const [name, hash] of Object.entries(options.installed)) {
    mkdirSync(join(m.store, name), { recursive: true });
    writeFileSync(join(m.store, name, 'SKILL.md'), `# ${name}\n`);
    mkdirSync(join(m.claude, 'skills', name), { recursive: true });
    lock[name] = entry(name, hash);
  }
  writeFileSync(join(home, '.agents', '.skill-lock.json'), JSON.stringify({ skills: lock }));
  const upstreamFile = join(home, 'upstream.json');
  writeFileSync(upstreamFile, JSON.stringify(Object.fromEntries(
    Object.entries(up.trees).map(([name, hash]) => [name, entry(name, hash)]),
  )));
  writeFakeBin(m.bin, 'npx', FAKE_NPX);
  const env = {
    ...process.env,
    PATH: `${m.bin}${delimiter}${process.env.PATH}`,
    NORTUSCC_REPO_DIR: m.repo, NORTUSCC_CLAUDE_DIR: m.claude, NORTUSCC_CODEX_DIR: m.codex,
    NORTUSCC_AGENTS_DIR: m.store, NORTUSCC_STATE_DIR: m.state,
    NORTUSCC_TEST_LOG: m.log, NORTUSCC_TEST_UPSTREAM: upstreamFile,
  };
  return { repo: m.repo, state: m.state, store: m.store, log: m.log, env, trees: up.trees };
}

async function update(m: Machine, args: string[], extraEnv: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [BIN, 'update', ...args], { env: { ...m.env, ...extraEnv } });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const failure = err as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

const calls = (m: Machine): string[][] =>
  existsSync(m.log) ? readFileSync(m.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

const MANIFEST = '[o/r]\nfresh\nstale\n';
const checkoutBefore = hashOf(CHECKOUT_MANIFEST);

test('update --check reports outdated and current skills and runs nothing', async () => {
  const m = machine({ installed: { stale: 'old0000aaaa', fresh: '' }, manifest: MANIFEST });
  // `fresh` must hold its real tree SHA to read as current.
  const lockPath = join(m.store, '..', '.skill-lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  lock.skills.fresh.skillFolderHash = m.trees.fresh;
  writeFileSync(lockPath, JSON.stringify(lock));
  const result = await update(m, ['--check']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /current\s+1/);
  assert.match(result.stdout, /outdated\s+1\s+stale/);
  assert.match(result.stdout, /available\s+1\s+wizard/);
  assert.match(result.stdout, /Run: nortuscc update/);
  assert.deepEqual(calls(m), []);
});

test('update --yes backs up and refreshes the outdated skill only', async () => {
  const m = machine({ installed: { stale: 'old0000aaaa' }, manifest: '[o/r]\nstale\n' });
  const result = await update(m, ['--yes']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(calls(m), [['-y', 'skills', 'update', 'stale', '--global', '--yes']]);
  const runs = readdirSync(join(m.state, 'backups'));
  assert.equal(runs.length, 1);
  assert.ok(existsSync(join(m.state, 'backups', runs[0]!, 'skills', 'stale', 'SKILL.md')));
  assert.match(result.stdout, new RegExp(`stale\\s+updated\\s+old0000 -> ${m.trees.stale.slice(0, 7)}`));
  assert.match(result.stdout, /backed up -> /);
});

test('update --yes --add adopts the named skill for both agents and records it in the manifest', async () => {
  const m = machine({ installed: { stale: 'old0000aaaa' }, manifest: '[o/r]\nstale\n' });
  const result = await update(m, ['--yes', '--add', 'wizard']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(calls(m).find((c) => c[2] === 'add'),
    ['-y', 'skills', 'add', 'o/r', '--skill', 'wizard', '--agent', 'claude-code', 'codex', '--global', '--yes']);
  assert.match(result.stdout, /wizard\s+added\s+o\/r/);
  assert.match(readFileSync(join(m.repo, 'skills-manifest.txt'), 'utf8'), /^wizard$/m);
  assert.match(result.stdout, /skills-manifest\.txt written/);
});

test('update --target claude installs for Claude only', async () => {
  const m = machine({ installed: { stale: 'old0000aaaa' }, manifest: '[o/r]\nstale\n' });
  const result = await update(m, ['--target', 'claude', '--yes', '--add', 'wizard']);
  assert.equal(result.code, 0, result.stderr);
  const add = calls(m).find((c) => c[2] === 'add')!;
  assert.deepEqual(add.slice(add.indexOf('--agent'), add.indexOf('--global')), ['--agent', 'claude-code']);
});

test('update --yes --prune removes a skill gone upstream and drops it from the manifest', async () => {
  const m = machine({ installed: { stale: 'old0000aaaa', ghost: 'g' }, manifest: '[o/r]\nghost\nstale\n' });
  const result = await update(m, ['--yes', '--prune']);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(calls(m).some((c) => c.join(' ') === '-y skills remove ghost --global --yes'));
  assert.match(result.stdout, /ghost\s+removed/);
  const manifest = readFileSync(join(m.repo, 'skills-manifest.txt'), 'utf8');
  assert.doesNotMatch(manifest, /^ghost$/m);
  assert.match(manifest, /^\[o\/r\]\nstale$/m);
});

test('a gone skill left alone exits 1 and points at --prune', async () => {
  const m = machine({ installed: { ghost: 'g' }, manifest: '[o/r]\nghost\n' });
  const result = await update(m, ['--check']);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /gone\s+1\s+ghost/);
  assert.match(result.stdout, /nortuscc update --prune/);
});

test('an unreachable source exits 1 and runs nothing', async () => {
  const m = machine({ installed: { stale: 'old0000aaaa' }, manifest: '[o/r]\nstale\n', unreachable: true });
  const result = await update(m, ['--yes']);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /unreachable\s+1\s+stale/);
  assert.deepEqual(calls(m), []);
});

test('a failing updater exits 1 and says so', async () => {
  const m = machine({ installed: { stale: 'old0000aaaa' }, manifest: '[o/r]\nstale\n' });
  const result = await update(m, ['--yes'], { NORTUSCC_TEST_FAIL: 'update' });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /Something failed above/);
});

test('no terminal and no --yes refuses with exit 2', async () => {
  const m = machine({ installed: { stale: 'old0000aaaa' }, manifest: '[o/r]\nstale\n' });
  const result = await update(m, []);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /no terminal to choose on/);
  assert.deepEqual(calls(m), []);
});

test('--check with an action flag is a usage error', async () => {
  const m = machine({ installed: {}, manifest: MANIFEST });
  const result = await update(m, ['--check', '--prune']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--check is mutually exclusive/);
});

test("no run rewrites the checkout's own skills-manifest.txt", () => {
  assert.equal(hashOf(CHECKOUT_MANIFEST), checkoutBefore);
});
