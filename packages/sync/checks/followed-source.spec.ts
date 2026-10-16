import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Effect, Layer } from 'effect';
import { nodeFs, nodeProcesses, Processes, type MachinePathsValue } from '@nortuscc/machine';
import type { SyncRevision } from '@nortuscc/hosted-protocol';
import * as sync from '../src/index.ts';
import { tempRepo } from './support/repo.ts';

const URL = 'https://github.com/example/followed.git';
const docs = { 'claude/CLAUDE.md': '# first\n' };
const fixture = (documents: Readonly<Record<string, string>> = docs) => {
  const repo = tempRepo(documents);
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

test('a migrated machine without an applied commit keeps its migration baseline', async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const next = f.commit({ 'claude/CLAUDE.md': '# incoming\n' }); f.git('push', '-q', 'origin', 'main');
  await f.run(s => Effect.gen(function* () {
    yield* s.fetch;
    execFileSync('git', ['--git-dir', sync.followedClone(f.paths, URL), 'update-ref', 'refs/nortuscc/migration/applied', f.first]);
    mkdirSync(f.paths.stateRoot, { recursive: true });
    writeFileSync(join(f.paths.stateRoot, 'state.json'), JSON.stringify({ version: 1, repo: '/previous-checkout', files: { 'claude:CLAUDE.md': { hash: 'previous', appliedAt: '2026-10-15T00:00:00Z' } } }));
    const result = yield* s.effective([]);
    assert.equal(result.applied.revision, f.first);
    assert.equal(f.text(result.effective), '# first\n');
    const accepted = yield* s.effective([{ setupId: 'local', itemId: 'file:claude:CLAUDE.md', revision: null, commit: next, decision: 'accept', decidedAt: '2026-10-15T00:00:00Z', machineId: null, source: 'local' }]);
    assert.equal(f.text(accepted.effective), '# incoming\n');
  }));
});


test("a followed profile's items drive incoming changes", async t => {
  for (const changedProfile of ['personal', 'other']) {
    await t.test(`a change only in ${changedProfile}`, async t => {
      const f = fixture({
        ...docs,
        'profiles/default.json': '{}',
        'profiles/personal.json': '{}',
        'profiles/other.json': '{}',
        'claude/personal.md': '# profile change\n',
      });
      t.after(() => rmSync(f.root, { recursive: true, force: true }));
      const next = f.commit({ [`profiles/${changedProfile}.json`]: JSON.stringify({ files: { 'claude:CLAUDE.md': 'claude/personal.md' } }) });
      f.git('push', '-q', 'origin', 'main');
      await f.run(s => Effect.gen(function* () {
        yield* s.fetch;
        execFileSync('git', ['--git-dir', sync.followedClone(f.paths, URL), 'update-ref', 'refs/nortuscc/migration/applied', f.first]);
        const observed = yield* sync.observeSyncSource(s, []).pipe(Effect.provide(nodeFs));
        assert.deepEqual(observed.changes.map(change => change.itemId), changedProfile === 'personal' ? ['file:claude:CLAUDE.md'] : []);
        const text = (snapshot: sync.Snapshot) => readFileSync(join(snapshot.repo, snapshot.desired.files.find(file => file.id === 'claude:CLAUDE.md')!.src), 'utf8');
        assert.equal(text(observed.effective.effective), '# first\n', 'undecided profile changes retain the applied value');
        const accepted = yield* s.effective([{ setupId: 'local', itemId: 'file:claude:CLAUDE.md', revision: null, commit: next, decision: 'accept', decidedAt: '2026-10-15T00:00:00Z', machineId: null, source: 'local' }]);
        assert.equal(text(accepted.effective), changedProfile === 'personal' ? '# profile change\n' : '# first\n');
      }), null, 'personal');
    });
  }
});


test('an explicitly cleared applied baseline offers every item as added and does not reuse a migration baseline', async t => {
  for (const profile of ['default', 'personal']) {
    await t.test(profile, async t => {
      const f = fixture({ ...docs, [`profiles/${profile}.json`]: '{}' });
      t.after(() => rmSync(f.root, { recursive: true, force: true }));
      await f.run(s => Effect.gen(function* () {
        yield* s.fetch;
        execFileSync('git', ['--git-dir', sync.followedClone(f.paths, URL), 'update-ref', 'refs/nortuscc/migration/applied', f.first]);
        mkdirSync(f.paths.stateRoot, { recursive: true });
        const statePath = join(f.paths.stateRoot, 'state.json');
        writeFileSync(statePath, '{"version":1,"repo":null,"files":{}}');
        yield* sync.markFollowedBaselineEmpty(f.paths, { repoUrl: URL, profile: 'default', setupId: null }).pipe(Effect.provide(nodeProcesses()));
        const observed = yield* sync.observeSyncSource(s, []).pipe(Effect.provide(nodeFs));
        assert.deepEqual(observed.changes.map(({ itemId, kind, before }) => ({ itemId, kind, before })), [{ itemId: 'file:claude:CLAUDE.md', kind: 'file', before: undefined }]);
        assert.equal(f.text(observed.offered), '# first\n');
        assert.equal(observed.effective.applied.desired.issues.length, 0);
        assert.equal(existsSync(join(observed.effective.effective.repo, 'claude/CLAUDE.md')), false);
        const accepted = yield* s.effective([{ setupId: 'local', itemId: 'file:claude:CLAUDE.md', revision: null, commit: f.first, decision: 'accept', decidedAt: '2026-10-16T12:00:00Z', machineId: null, source: 'local' }]);
        assert.equal(f.text(accepted.effective), '# first\n');
        assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).applied, undefined);
        writeFileSync(statePath, JSON.stringify({ version: 1, repo: null, files: {}, applied: { commit: f.first, at: '2026-10-16T12:00:00Z' } }));
        const applied = yield* sync.observeSyncSource(s, []).pipe(Effect.provide(nodeFs));
        assert.deepEqual(applied.changes, []);
        assert.equal(applied.effective.applied.revision, f.first);
      }), null, profile);
    });
  }
});

for (const corrupt of ['{broken metadata', '[{}]']) test(`reachable hosted metadata repairs a corrupt verified cache: ${corrupt}`, async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const announced = f.publish();
  await f.run(s => s.load(announced), 'setup-1');
  const cacheDir = join(f.paths.stateRoot, 'agent/follow');
  const cache = readdirSync(cacheDir).find(name => name.endsWith('.json'))!;
  assert.ok(cache);
  writeFileSync(join(cacheDir, cache), corrupt);
  await f.run(s => Effect.gen(function* () {
    assert.deepEqual((yield* s.fetch).head, announced);
    assert.equal(f.text(yield* s.load(announced)), '# first\n');
  }), 'setup-1');
  assert.deepEqual(JSON.parse(readFileSync(join(cacheDir, cache), 'utf8')), [announced]);
  const backups = readdirSync(f.paths.backups, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => readFileSync(join(entry.parentPath, entry.name), 'utf8'));
  assert.ok(backups.includes(corrupt));
  f.offline();
  await f.run(s => Effect.gen(function* () {
    assert.deepEqual((yield* s.fetch).head, announced);
    assert.equal(f.text(yield* s.load(announced)), '# first\n');
  }), 'setup-1');
});

test('inspecting a followed profile lists each commit tree once', async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  await f.run(s => Effect.gen(function* () {
    yield* s.fetch;
    yield* s.effective([]);
    yield* s.current;
  }));
  // Every git process costs a fork; re-reading an immutable commit per caller multiplied startup.
  const listed = f.calls.filter(args => args[0] === 'ls-tree').map(args => args.at(-1));
  assert.ok(listed.length > 0);
  assert.deepEqual(listed, [...new Set(listed)]);
});
