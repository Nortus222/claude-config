import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Effect, Layer } from 'effect';
import { nodeProcesses, Processes, type MachinePathsValue } from '@nortuscc/machine';
import type { SyncRevision } from '@nortuscc/hosted-protocol';
import * as sync from '../src/index.ts';
import { tempRepo } from './support/repo.ts';

const URL = 'https://github.com/example/followed.git';
const docs = { 'claude/CLAUDE.md': '# first\n' };
const fixture = () => {
  const repo = tempRepo(docs);
  const origin = join(repo.root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  repo.git('remote', 'add', 'origin', origin); repo.git('push', '-q', 'origin', 'main');
  const paths: MachinePathsValue = { repo: join(repo.root, 'missing-cli-checkout'), stateRoot: join(repo.root, 'state'), backups: join(repo.root, 'backups'), claude: join(repo.root, 'claude'), codex: join(repo.root, 'codex'), codexOpenRouter: join(repo.root, 'glm'), agentsSkills: join(repo.root, 'skills') };
  let offline = false;
  let records: SyncRevision[] = [];
  const calls: string[][] = [];
  const processes = Layer.effect(Processes, Effect.gen(function* () {
    const real = yield* Processes;
    return { run: (command: Parameters<Processes['Service']['run']>[0]) => {
      assert.equal(command.cmd, 'git', 'never run real gh');
      assert.notEqual(command.cwd, paths.repo, 'never read the CLI checkout');
      calls.push([...command.args]);
      if (offline && command.args.includes('fetch')) return Effect.succeed({ code: 128, stdout: '', stderr: 'offline' });
      return real.run({ ...command, args: command.args.map(arg => arg === URL && (command.args.includes('fetch') || command.args.includes('ls-remote')) ? origin : arg), stderr: 'capture' });
    } };
  })).pipe(Layer.provide(nodeProcesses()));
  const layer = (setupId: string | null = null, profile = 'default') => sync.followedSetupSourceLayer(paths, { repoUrl: URL, profile, setupId }, {
    processes, records: Effect.suspend(() => offline ? Effect.fail(new Error('service unreachable')) : Effect.succeed(records)),
  });
  const run = <A, E>(f: (s: sync.SetupSource['Service']) => Effect.Effect<A, E>, setupId: string | null = null, profile = 'default') => Effect.runPromise(sync.SetupSource.use(f).pipe(Effect.provide(layer(setupId, profile))));
  const publish = () => {
    const record: SyncRevision = { setupId: 'setup-1', number: 1, commitSha: repo.first, tag: 'v1', changelog: '', requiredEnv: [], items: [{ id: 'file:claude:CLAUDE.md', kind: 'file', change: 'added' }] };
    repo.git('tag', record.tag, record.commitSha); repo.git('push', '-q', 'origin', `refs/tags/${record.tag}`); records = [record]; return record;
  };
  const text = (snapshot: sync.Snapshot) => readFileSync(join(snapshot.repo, 'claude/CLAUDE.md'), 'utf8');
  return { ...repo, paths, calls, run, publish, text, offline: () => { offline = true; }, setRecords: (next: SyncRevision[]) => { records = next; } };
};

test('a followed source exposes its profile name', async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  for (const setupId of [null, 'setup-1']) {
    await t.test(setupId === null ? 'direct Git' : 'hosted setup', async () => {
      await f.run(s => Effect.sync(() => assert.equal(s.profile, 'personal')), setupId, 'personal');
    });
  }
});

test('following from Git applies the fetched main of the private clone without reading the CLI checkout', async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const next = f.commit({ 'claude/CLAUDE.md': '# fetched\n' }); f.git('push', '-q', 'origin', 'main');
  await f.run(s => Effect.gen(function* () {
    assert.deepEqual(yield* s.fetch, { head: next });
    assert.equal(f.text(yield* s.load(next)), '# fetched\n');
    assert.equal(f.text((yield* s.effective([])).effective), '# fetched\n');
  }));
  const clone = join(f.paths.stateRoot, 'agent/follow', `${createHash('sha256').update(URL).digest('hex').slice(0, 16)}.git`);
  assert.equal(execFileSync('git', ['--git-dir', clone, 'rev-parse', '--is-bare-repository'], { encoding: 'utf8' }).trim(), 'true');
  assert.equal(existsSync(f.paths.repo), false);
  const fetch = f.calls.find(args => args.includes('fetch'))!;
  assert.ok(fetch.includes('credential.helper=!gh auth git-credential'));
});

test('following through a setup applies only announced revisions', async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true })); const announced = f.publish();
  const unannounced = f.commit({ 'claude/CLAUDE.md': '# unannounced\n' }); f.git('push', '-q', 'origin', 'main');
  await f.run(s => Effect.gen(function* () {
    const { head } = yield* s.fetch; assert.deepEqual(head, announced);
    assert.equal(f.text(yield* s.load(head)), '# first\n');
    const denied = yield* s.load(unannounced).pipe(Effect.result); assert.equal(denied._tag, 'Failure');
    const accepted = [{ setupId: 'setup-1', itemId: 'file:claude:CLAUDE.md', revision: 1, commit: null, decision: 'accept' as const, decidedAt: '2026-10-15T00:00:00Z', machineId: null, source: 'local' as const }];
    assert.equal(f.text((yield* s.effective(accepted)).effective), '# first\n');
  }), 'setup-1');
});

test('with the service unreachable the machine stays on its last verified revision', async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true })); const announced = f.publish();
  await f.run(s => s.load(announced), 'setup-1');
  f.commit({ 'claude/CLAUDE.md': '# unannounced\n' }); f.git('push', '-q', 'origin', 'main'); f.offline();
  await f.run(s => Effect.gen(function* () {
    const { head } = yield* s.fetch; assert.deepEqual(head, announced);
    assert.equal(f.text(yield* s.load(head)), '# first\n');
  }), 'setup-1');
});

test('a tag with a different commit is refused', async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true })); const announced = f.publish();
  const next = f.commit({ 'claude/CLAUDE.md': '# other\n' }); f.setRecords([{ ...announced, commitSha: next }]);
  const result = await f.run(s => s.load({ ...announced, commitSha: next }).pipe(Effect.result), 'setup-1');
  assert.equal(result._tag, 'Failure');
  if (result._tag === 'Failure') assert.equal(result.failure._tag, 'RevisionMismatch');
});

test('proveReadAccess reports denial distinctly from network failure', async () => {
  for (const [stderr, tag] of [['Permission denied (publickey)', 'AccessDenied'], ['Could not resolve host', 'GitFailed']]) {
    const result = await Effect.runPromise(sync.proveReadAccess(URL, '/empty-hooks').pipe(Effect.result, Effect.provide(Layer.succeed(Processes, { run: () => Effect.succeed({ code: 128, stdout: '', stderr }) }))));
    assert.equal(result._tag, 'Failure'); if (result._tag === 'Failure') assert.equal(result.failure._tag, tag);
  }
});

test('a migrated checkout baseline keeps undecided incoming items at their applied values', async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const next = f.commit({ 'claude/CLAUDE.md': '# incoming\n' }); f.git('push', '-q', 'origin', 'main');
  await f.run(s => Effect.gen(function* () {
    yield* s.fetch;
    execFileSync('git', ['--git-dir', sync.followedClone(f.paths, URL), 'update-ref', 'refs/nortuscc/migration/applied', f.first]);
    const result = yield* s.effective([]);
    assert.equal(result.applied.revision, f.first);
    assert.equal(f.text(result.effective), '# first\n');
    const accepted = yield* s.effective([{ setupId: 'local', itemId: 'file:claude:CLAUDE.md', revision: null, commit: next, decision: 'accept', decidedAt: '2026-10-15T00:00:00Z', machineId: null, source: 'local' }]);
    assert.equal(f.text(accepted.effective), '# incoming\n');
  }));
});
