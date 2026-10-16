import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { Processes, backupsForRun, machinePaths, nodeFs, nodeProcesses, type Command, type MachinePathsValue } from '@nortuscc/machine';
import { AuthorWorkspace, authorWorkspaceLayer } from '../src/author/workspace.ts';

const fixture = (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), 'author-workspace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH!, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'gitconfig') };
  const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const checkout = join(root, 'checkout'); mkdirSync(checkout);
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(checkout, 'init', '-q', '-b', 'main');
  git(checkout, 'config', 'user.name', 'Fixture'); git(checkout, 'config', 'user.email', 'fixture@example.test');
  writeFileSync(join(checkout, 'config.json'), 'first\n');
  git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'initial');
  git(checkout, 'remote', 'add', 'origin', origin); git(checkout, 'push', '-q', 'origin', 'main');
  const first = git(origin, 'rev-parse', 'main');
  const paths: MachinePathsValue = { repo: checkout, stateRoot: join(root, 'state'), backups: join(root, 'state', 'backups'), claude: join(root, 'claude'), codex: join(root, 'codex'), codexOpenRouter: join(root, 'glm'), agentsSkills: join(root, 'skills') };
  let intercept: ((command: Command) => Effect.Effect<import('@nortuscc/machine').Completed, import('@nortuscc/machine').LaunchFailed> | undefined) | undefined;
  const calls: Command[] = [];
  const processes = Layer.effect(Processes, Effect.map(Processes, real => ({ run: (command: Command) => {
    calls.push(command);
    const replacement = intercept?.(command); if (replacement) return replacement;
    if (command.cmd === 'gh') {
      assert.deepEqual(command.args, ['api', 'user']);
      return Effect.succeed({ code: 0, stdout: JSON.stringify({ login: 'author-fixture', id: 42 }) });
    }
    assert.equal(command.cmd, 'git');
    return real.run(command);
  } }))).pipe(Layer.provide(nodeProcesses({ env })));
  const base = Layer.mergeAll(machinePaths(paths), nodeFs, processes);
  const layer = authorWorkspaceLayer({ env }).pipe(Layer.provide(Layer.merge(base, backupsForRun().pipe(Layer.provide(base)))));
  const run = <A, E>(f: (w: AuthorWorkspace['Service']) => Effect.Effect<A, E>) => Effect.runPromise(AuthorWorkspace.use(f).pipe(Effect.provide(layer)));
  const changeRemote = () => {
    writeFileSync(join(checkout, 'rival.txt'), 'another author\n');
    git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'rival'); git(checkout, 'push', '-q', 'origin', 'main');
  };
  return { root, checkout, origin, first, paths, git, run, calls, changeRemote, intercept: (f: typeof intercept) => { intercept = f; } };
};

test('fresh resets the private clone to origin/main and never writes the configured checkout', async t => {
  const s = fixture(t);
  writeFileSync(join(s.checkout, 'config.json'), 'owner changes\n');
  const fresh = await s.run(w => w.fresh(s.origin));
  assert.equal(fresh.dir, join(s.paths.stateRoot, 'agent', 'author', createHash('sha256').update(s.origin).digest('hex').slice(0, 16)));
  assert.equal(fresh.base, s.first);
  writeFileSync(join(fresh.dir, 'config.json'), 'abandoned edit\n');
  writeFileSync(join(fresh.dir, 'untracked.txt'), 'abandoned addition\n');
  const again = await s.run(w => w.fresh(s.origin));
  assert.deepEqual(again, fresh);
  assert.equal(readFileSync(join(fresh.dir, 'config.json'), 'utf8'), 'first\n');
  assert.equal(existsSync(join(fresh.dir, 'untracked.txt')), false);
  assert.equal(readFileSync(join(s.checkout, 'config.json'), 'utf8'), 'owner changes\n');
  const backups = readdirSync(s.paths.backups, { recursive: true });
  assert.ok(backups.some(p => p.toString().endsWith('config.json')));
  assert.ok(backups.some(p => p.toString().endsWith('untracked.txt')));
  for (const command of s.calls.filter(c => c.cmd === 'git')) {
    assert.equal(command.envAllow?.length, 0);
    assert.equal(command.env?.GIT_TERMINAL_PROMPT, '0');
    assert.ok(command.args.some(a => a.startsWith('core.hooksPath=')));
  }
});

test('commitAndPush records the commit before pushing and obtains missing identity from gh', async t => {
  const s = fixture(t); const fresh = await s.run(w => w.fresh(s.origin));
  let recorded = '';
  const outcome = await s.run(w => w.commitAndPush({ ...fresh, files: { 'config.json': null, 'nested/new.txt': 'published\n' }, message: 'publish fixture', onCommit: sha => Effect.sync(() => {
    assert.equal(s.git(fresh.dir, 'rev-parse', 'HEAD'), sha);
    assert.equal(s.git(s.origin, 'rev-parse', 'main'), fresh.base);
    recorded = sha;
  }) }));
  assert.deepEqual(outcome, { kind: 'pushed', commit: recorded });
  assert.equal(s.git(s.origin, 'show', 'main:nested/new.txt'), 'published');
  assert.equal(s.git(s.origin, 'show', '-s', '--format=%ae', 'main'), '42+author-fixture@users.noreply.github.com');
  assert.equal(s.git(s.origin, 'show', '-s', '--format=%an', 'main'), 'author-fixture');
});

test('a push rejected because main moved is reported as moved', async t => {
  const s = fixture(t); const fresh = await s.run(w => w.fresh(s.origin));
  const result = await s.run(w => w.commitAndPush({ ...fresh, files: { 'config.json': 'draft\n' }, message: 'draft', onCommit: () => Effect.sync(s.changeRemote) }));
  assert.deepEqual(result, { kind: 'moved' });
  assert.equal(s.git(s.origin, 'show', 'main:config.json'), 'first');
});

test('push denial and transport failure remain distinct when main has not moved', async t => {
  const s = fixture(t); const fresh = await s.run(w => w.fresh(s.origin));
  for (const [stderr, expected] of [['remote: Permission to fixture denied\nfatal: unable to access: The requested URL returned error: 403', 'denied'], ['fatal: Could not resolve host: example.test', 'failed']] as const) {
    s.intercept(c => c.args.includes('push') ? Effect.succeed({ code: 128, stdout: '', stderr }) : undefined);
    const result = await s.run(w => w.commitAndPush({ ...fresh, files: { 'config.json': `${expected}\n` }, message: 'draft', onCommit: () => Effect.void }));
    assert.equal(result.kind, expected);
    await s.run(w => w.fresh(s.origin));
  }
});

test('tag succeeds again when the remote tag already points at the commit and rejects a collision', async t => {
  const s = fixture(t); const fresh = await s.run(w => w.fresh(s.origin));
  await s.run(w => w.tag(fresh.dir, fresh.base));
  await s.run(w => w.tag(fresh.dir, fresh.base));
  assert.equal(s.git(s.origin, 'rev-parse', `refs/tags/nortuscc/${fresh.base}`), fresh.base);
  s.changeRemote();
  s.git(s.origin, 'update-ref', `refs/tags/nortuscc/${fresh.base}`, s.git(s.origin, 'rev-parse', 'main'));
  await assert.rejects(s.run(w => w.tag(fresh.dir, fresh.base)), /GitFailed/);
});

test('isPublished is true once main contains the commit, false otherwise, and unknown offline', async t => {
  const s = fixture(t); const fresh = await s.run(w => w.fresh(s.origin));
  assert.equal(await s.run(w => w.isPublished(fresh.dir, fresh.base)), true);
  let commit = '';
  s.intercept(c => c.args.includes('push') ? Effect.succeed({ code: 1, stdout: '', stderr: 'network unavailable' }) : undefined);
  await s.run(w => w.commitAndPush({ ...fresh, files: { 'config.json': 'unpublished\n' }, message: 'draft', onCommit: sha => Effect.sync(() => { commit = sha; }) }));
  assert.equal(await s.run(w => w.isPublished(fresh.dir, commit)), false);
  s.intercept(undefined); s.git(fresh.dir, 'push', '-q', 'origin', 'HEAD:main');
  assert.equal(await s.run(w => w.isPublished(fresh.dir, commit)), true);
  s.intercept(c => c.args.includes('fetch') ? Effect.succeed({ code: 128, stdout: '' }) : undefined);
  assert.equal(await s.run(w => w.isPublished(fresh.dir, commit)), 'unknown');
});

test('workspace rejects writes outside its private clone and through a symlink', async t => {
  const s = fixture(t); const fresh = await s.run(w => w.fresh(s.origin));
  const bad = await s.run(w => w.commitAndPush({ dir: s.checkout, base: s.first, files: { 'config.json': 'bad' }, message: 'bad', onCommit: () => Effect.void }));
  assert.equal(bad.kind, 'failed');
  assert.equal(readFileSync(join(s.checkout, 'config.json'), 'utf8'), 'first\n');
  const external = join(s.root, 'external'); mkdirSync(external); writeFileSync(join(external, 'keep'), 'keep\n');
  symlinkSync(external, join(fresh.dir, 'redirect'));
  for (const path of ['../external/keep', 'redirect/keep', '.git/config']) {
    const result = await s.run(w => w.commitAndPush({ ...fresh, files: { [path]: 'bad' }, message: 'bad', onCommit: () => Effect.void }));
    assert.equal(result.kind, 'failed');
  }
  assert.equal(readFileSync(join(external, 'keep'), 'utf8'), 'keep\n');
});

test('commitAndPush preserves an existing clone identity and disables repository hooks', async t => {
  const s = fixture(t); const fresh = await s.run(w => w.fresh(s.origin));
  s.git(fresh.dir, 'config', 'user.name', 'Existing Author');
  s.git(fresh.dir, 'config', 'user.email', 'existing@example.test');
  const hooks = join(s.root, 'hooks'); mkdirSync(hooks);
  const marker = join(s.root, 'hook-ran');
  writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  s.git(fresh.dir, 'config', 'core.hooksPath', hooks);
  s.intercept(c => c.cmd === 'gh' ? Effect.die('must not replace existing identity') : undefined);
  const result = await s.run(w => w.commitAndPush({ ...fresh, files: { 'config.json': 'updated\n' }, message: 'update', onCommit: () => Effect.void }));
  assert.equal(result.kind, 'pushed');
  assert.equal(s.git(s.origin, 'show', '-s', '--format=%ae', 'main'), 'existing@example.test');
  assert.equal(existsSync(marker), false);
});

test('isPublished recognizes a commit after main advances to its descendant', async t => {
  const s = fixture(t); const fresh = await s.run(w => w.fresh(s.origin));
  s.changeRemote();
  assert.notEqual(s.git(s.origin, 'rev-parse', 'main'), fresh.base);
  assert.equal(await s.run(w => w.isPublished(fresh.dir, fresh.base)), true);
});

test('fresh refuses an existing unrelated directory without changing its files', async t => {
  const s = fixture(t);
  const dir = join(s.paths.stateRoot, 'agent', 'author', createHash('sha256').update(s.origin).digest('hex').slice(0, 16));
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'keep'), 'keep\n');
  await assert.rejects(s.run(w => w.fresh(s.origin)), /GitFailed/);
  assert.equal(readFileSync(join(dir, 'keep'), 'utf8'), 'keep\n');
  assert.equal(existsSync(join(dir, '.git')), false);
});

test('fresh refuses a clone whose Git work tree was redirected', async t => {
  const s = fixture(t); const fresh = await s.run(w => w.fresh(s.origin));
  s.git(fresh.dir, 'config', 'core.worktree', s.checkout);
  writeFileSync(join(s.checkout, 'config.json'), 'owner changes\n');
  await assert.rejects(s.run(w => w.fresh(s.origin)), /GitFailed/);
  assert.equal(readFileSync(join(s.checkout, 'config.json'), 'utf8'), 'owner changes\n');
});

test('commitAndPush reports protected main as denied', async t => {
  const s = fixture(t); const fresh = await s.run(w => w.fresh(s.origin));
  s.intercept(c => c.args.includes('push') ? Effect.succeed({ code: 1, stdout: '', stderr: 'remote: error: GH006: Protected branch update failed for refs/heads/main.\nremote: Changes must be made through a pull request.' }) : undefined);
  const result = await s.run(w => w.commitAndPush({ ...fresh, files: { 'config.json': 'updated\n' }, message: 'update', onCommit: () => Effect.void }));
  assert.equal(result.kind, 'denied');
});

test('commitAndPush reports unreadable GitHub identity without publishing', async t => {
  const s = fixture(t); const fresh = await s.run(w => w.fresh(s.origin));
  s.intercept(c => c.cmd === 'gh' ? Effect.succeed({ code: 0, stdout: 'null' }) : undefined);
  const result = await s.run(w => w.commitAndPush({ ...fresh, files: { 'config.json': 'updated\n' }, message: 'update', onCommit: () => Effect.die('must not commit without identity') }));
  assert.equal(result.kind, 'failed');
  assert.equal(s.git(s.origin, 'rev-parse', 'main'), fresh.base);
});


test('SSH publishing fails unattended instead of waiting for a passphrase', async t => {
  const s = fixture(t);
  s.intercept(command => command.cmd === 'git' && command.args.includes('clone')
    ? Effect.succeed({ code: 128, stdout: '', stderr: command.env?.GIT_SSH_COMMAND === 'ssh -o BatchMode=yes' ? 'Permission denied (publickey)' : 'Passphrase prompt would block' }) : undefined);
  await assert.rejects(s.run(workspace => workspace.fresh('git@github.com:example/setup.git')), (error: any) => {
    assert.equal(error.reason, 'Permission denied (publickey)');
    return true;
  });
});
