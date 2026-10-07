import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Effect, Layer } from 'effect';
import { nodeProcesses, Processes, type Decision, type MachinePathsValue } from '@nortuscc/machine';
import type { SyncRevision } from '@nortuscc/hosted-protocol';
import * as sync from '../src/index.ts';
import { json, tempRepo, withDocuments } from './support/repo.ts';

const URL = 'https://github.com/example/hosted.git';
const EFFORT = 'setting:claude:settings.json#effortLevel';
const THEME = 'setting:claude:settings.json#theme';
const FILE = 'file:claude:CLAUDE.md';
const initial = { 'claude/settings.keys.json': json({ theme: 'auto', effortLevel: 'high' }), 'claude/CLAUDE.md': '# first\n' };
const accept = (itemId: string, revision = 1): Decision => ({ setupId: 'setup-1', itemId, revision, commit: null, decision: 'accept', decidedAt: '2026-10-07T00:00:00Z', machineId: null, source: 'local' });

const fixture = (base: Readonly<Record<string, string>> = initial) => {
  const repo = tempRepo(base);
  const origin = join(repo.root, 'origin.git');
  const checkout = join(repo.root, 'checkout');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  repo.git('remote', 'add', 'origin', origin);
  repo.git('push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', origin, checkout]);
  execFileSync('git', ['-C', checkout, 'remote', 'set-url', 'origin', URL]);
  const paths: MachinePathsValue = { repo: checkout, stateRoot: join(repo.root, 'state'), backups: join(repo.root, 'backups'), claude: join(repo.root, 'claude'), codex: join(repo.root, 'codex'), codexOpenRouter: join(repo.root, 'glm'), agentsSkills: join(repo.root, 'skills') };
  const write = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  let account: string | null = 'account-1';
  let offline = false;
  let records: SyncRevision[] = [];
  const calls: string[][] = [];
  let afterFetch: (() => void) | undefined;
  const processes = Layer.effect(Processes, Effect.gen(function* () {
    const real = yield* Processes;
    return { run: (command: Parameters<Processes['Service']['run']>[0]) => {
      calls.push([...command.args]);
      if (offline && command.args.includes('fetch')) return Effect.succeed({ code: 128, stdout: '' });
      return real.run({ ...command, args: command.args.map((arg) => arg === URL && command.args.includes('fetch') ? origin : arg), stderr: 'capture' }).pipe(Effect.tap(() => Effect.sync(() => { if (command.args.includes('fetch')) afterFetch?.(); })));
    } };
  })).pipe(Layer.provide(nodeProcesses()));
  const trust = (checkoutValue: string | null = checkout, accountId: string | null = 'account-1', repoUrl = URL) => write(join(paths.stateRoot, 'agent', 'setups.json'), json({ version: 1, setups: [{ setupId: 'setup-1', repoUrl: sync.normalizeRepoUrl(repoUrl), checkout: checkoutValue, trustedAt: '2026-10-07T00:00:00Z', ...(accountId ? { accountId } : {}) }] }));
  const layer = (accountId = 'account-1', repoUrl = URL) => {
    assert.equal(typeof sync.hostedSetupSourceLayer, 'function', 'hosted SetupSource is exported');
    return sync.hostedSetupSourceLayer(paths, { accountId, currentAccountId: Effect.sync(() => account), setupId: 'setup-1', repoUrl, records: Effect.sync(() => records), processes });
  };
  const source = <A, E>(f: (source: sync.SetupSource['Service']) => Effect.Effect<A, E>, accountId = 'account-1', repoUrl = URL) => Effect.runPromise(Effect.result(sync.SetupSource.use(f)).pipe(Effect.provide(layer(accountId, repoUrl))));
  let docs: Readonly<Record<string, string>> = {};
  const publish = (changes: Readonly<Record<string, string | null>> = {}, annotated = false) => {
    const before = docs;
    docs = records.length === 0 ? base : withDocuments(docs, changes);
    const commitSha = records.length === 0 ? repo.first : repo.commit(changes);
    const number = records.length + 1;
    const tag = `v${number}`;
    repo.git('tag', ...(annotated ? ['-a', '-m', tag] : []), tag, commitSha);
    repo.git('push', '-q', 'origin', 'main', `refs/tags/${tag}`);
    const record: SyncRevision = { setupId: 'setup-1', number, commitSha, tag, changelog: '', requiredEnv: [], items: sync.diffItems(sync.itemValues(before), sync.itemValues(docs)).map((c) => ({ id: c.itemId, kind: c.kind, change: c.before === undefined ? 'added' : c.after === undefined ? 'removed' : 'changed' })) };
    records.push(record);
    return record;
  };
  const textAt = (repo: string, path: string) => existsSync(join(repo, path)) ? readFileSync(join(repo, path), 'utf8') : undefined;
  trust();
  return { afterFetch: (f: () => void) => { afterFetch = f; }, ...repo, checkout, origin, paths, trust, source, publish, write, calls, textAt, records: () => records, setRecords: (r: SyncRevision[]) => { records = r; }, offline: () => { offline = true; }, online: () => { offline = false; }, account: (a: string | null) => { account = a; } };
};
const fails = (result: { _tag: string; failure?: { _tag: string } }, tag: string) => { assert.equal(result._tag, 'Failure'); assert.equal(result.failure?._tag, tag); };
const keys = (s: ReturnType<typeof fixture>, repo: string) => JSON.parse(s.textAt(repo, 'claude/settings.keys.json') ?? '{}');

for (const annotated of [false, true]) test(`load verifies ${annotated ? 'annotated' : 'lightweight'} tag and first revision against empty`, async (t) => {
  const s = fixture(); t.after(() => rmSync(s.root, { recursive: true, force: true }));
  const r = s.publish({}, annotated);
  writeFileSync(join(s.checkout, 'claude/CLAUDE.md'), '# dirty\n');
  const result = await s.source((source) => source.load(r));
  assert.equal(result._tag, 'Success');
  if (result._tag === 'Success') assert.equal(s.textAt(result.success.repo, 'claude/CLAUDE.md'), '# first\n');
  assert.equal(s.textAt(s.checkout, 'claude/CLAUDE.md'), '# dirty\n');
});

test('missing tag and SHA-only fork object never prove provenance', async (t) => {
  const s = fixture(); t.after(() => rmSync(s.root, { recursive: true, force: true })); const r = s.publish();
  s.git('push', '-q', 'origin', ':refs/tags/v1');
  fails(await s.source((source) => source.load(r)), 'RevisionUnavailable');
  assert.equal(execFileSync('git', ['-C', s.checkout, 'rev-parse', r.commitSha], { encoding: 'utf8' }).trim(), r.commitSha);
});

test('mismatched tag and advertised items are rejected before content can contribute', async (t) => {
  const s = fixture(); t.after(() => rmSync(s.root, { recursive: true, force: true })); const r = s.publish();
  const other = s.commit({ 'claude/CLAUDE.md': '# fork\n' });
  s.git('push', '-q', 'origin', 'main');
  execFileSync('git', ['-C', s.origin, 'update-ref', 'refs/tags/v1', other]);
  fails(await s.source((source) => source.load(r)), 'RevisionMismatch');
  execFileSync('git', ['-C', s.origin, 'update-ref', 'refs/tags/v1', r.commitSha]);
  s.setRecords([{ ...r, items: [] }]);
  fails(await s.source((source) => source.load({ ...r, items: [] })), 'RevisionMismatch');
});

test('offline uses only previously verified exact records, successful retarget refuses fallback', async (t) => {
  const s = fixture(); t.after(() => rmSync(s.root, { recursive: true, force: true })); const r = s.publish();
  assert.equal((await s.source((source) => source.load(r)))._tag, 'Success');
  s.offline();
  assert.equal((await s.source((source) => source.load(r)))._tag, 'Success');
  s.setRecords([{ ...r, tag: 'different' }]);
  fails(await s.source((source) => source.load({ ...r, tag: 'different' })), 'RevisionUnavailable');
  s.setRecords([r]); s.online();
  const other = s.commit({ 'claude/CLAUDE.md': '# retarget\n' });
  s.git('push', '-q', 'origin', 'main');
  execFileSync('git', ['-C', s.origin, 'update-ref', 'refs/tags/v1', other]);
  fails(await s.source((source) => source.effective([accept(FILE)])), 'RevisionMismatch');
});

test('unbound, different account, corrupt trust and changed origin authorize no fetch or snapshot', async (t) => {
  const s = fixture(); t.after(() => rmSync(s.root, { recursive: true, force: true })); const r = s.publish();
  for (const accountId of [null, 'account-2']) {
    s.trust(s.checkout, accountId); s.calls.length = 0;
    fails(await s.source((source) => source.load(r)), 'RevisionUnavailable');
    assert.equal(s.calls.length, 0);
  }
  s.trust(); s.account('account-2'); s.calls.length = 0;
  fails(await s.source((source) => source.current), 'RevisionUnavailable'); assert.equal(s.calls.length, 0);
  s.account('account-1'); s.write(join(s.paths.stateRoot, 'agent', 'setups.json'), '{ broken');
  fails(await s.source((source) => source.fetch), 'RevisionUnavailable'); assert.equal(s.calls.length, 0);
  s.trust(); execFileSync('git', ['-C', s.checkout, 'remote', 'set-url', 'origin', 'https://github.com/example/changed.git']);
  fails(await s.source((source) => source.effective([])), 'RevisionUnavailable');
  assert.equal(s.calls.some((args) => args.includes('fetch')), false);
});

test('accept carries until that item changes, all earlier records are verified', async (t) => {
  const s = fixture(); t.after(() => rmSync(s.root, { recursive: true, force: true }));
  s.publish(); const r2 = s.publish({ 'claude/settings.keys.json': json({ theme: 'light', effortLevel: 'medium' }) });
  s.publish({ 'claude/CLAUDE.md': '# third\n' });
  let result = await s.source((source) => source.effective([accept(EFFORT, r2.number)]));
  assert.equal(result._tag, 'Success');
  if (result._tag === 'Success') { assert.deepEqual(keys(s, result.success.effective.repo), { theme: 'auto', effortLevel: 'medium' }); assert.equal(result.success.applied.revision, null); }
  s.publish({ 'claude/settings.keys.json': json({ theme: 'light', effortLevel: 'max' }) });
  result = await s.source((source) => source.effective([accept(EFFORT, 2)]));
  assert.equal(result._tag, 'Success'); if (result._tag === 'Success') assert.equal(keys(s, result.success.effective.repo).effortLevel, 'high');
  s.setRecords(s.records().map((r) => r.number === 1 ? { ...r, items: [] } : r));
  fails(await s.source((source) => source.effective([accept(EFFORT, 4)])), 'RevisionMismatch');
});

test('linked baseline imports applied commit and root holds once, never dirty content or local decisions', async (t) => {
  const s = fixture(); t.after(() => rmSync(s.root, { recursive: true, force: true })); s.publish();
  const r = s.publish({ 'claude/settings.keys.json': json({ theme: 'light', effortLevel: 'medium' }) });
  s.write(join(s.paths.stateRoot, 'state.json'), json({ version: 1, repo: null, files: {}, applied: { commit: r.commitSha, at: '2026-10-07T00:00:00Z' } }));
  s.write(join(s.paths.stateRoot, 'sync.json'), json({ version: 1, held: { [EFFORT]: s.first } }));
  writeFileSync(join(s.checkout, 'claude/settings.keys.json'), json({ theme: 'dirty', effortLevel: 'dirty' }));
  const result = await s.source((source) => source.effective([]));
  assert.equal(result._tag, 'Success'); if (result._tag === 'Success') assert.deepEqual(keys(s, result.success.effective.repo), { theme: 'light', effortLevel: 'high' });
  const baseline = await s.source((source) => source.baseline!);
  assert.equal(baseline._tag, 'Success'); if (baseline._tag === 'Success') { assert.equal(baseline.success.revisionApplied, 0); assert.equal(baseline.success.origins[EFFORT], s.first); assert.equal(baseline.success.origins[THEME], r.commitSha); }
  assert.equal(existsSync(join(s.paths.stateRoot, 'decisions.json')), false);
});

test('new private clone starts empty; selected positive evidence advances only accepted unconflicted values', async (t) => {
  const s = fixture(); t.after(() => rmSync(s.root, { recursive: true, force: true })); const r = s.publish(); s.trust(null);
  let result = await s.source((source) => source.effective([accept(EFFORT)]));
  assert.equal(result._tag, 'Success'); if (result._tag === 'Success') { assert.deepEqual(keys(s, result.success.applied.repo), {}); assert.deepEqual(keys(s, result.success.effective.repo), { effortLevel: 'high' }); }
  await s.source((source) => source.recordApplied!({ revision: r, decisions: [accept(EFFORT)], observed: [EFFORT], released: [] }));
  let baseline = await s.source((source) => source.baseline!);
  assert.equal(baseline._tag, 'Success'); if (baseline._tag === 'Success') assert.deepEqual(baseline.success, { revisionApplied: 1, origins: { [EFFORT]: r.commitSha } });
  const r2 = s.publish({ 'claude/settings.keys.json': json({ theme: 'light', effortLevel: 'medium' }) });
  await s.source((source) => source.recordApplied!({ revision: r2, decisions: [accept(EFFORT, 2)], observed: [], released: [] }));
  baseline = await s.source((source) => source.baseline!); if (baseline._tag === 'Success') assert.equal(baseline.success.revisionApplied, 1);
  fails(await s.source((source) => source.recordApplied!({ revision: r2, decisions: [accept(EFFORT, 2)], observed: [THEME], released: [] })), 'RevisionMismatch');
  s.write(join(s.paths.stateRoot, 'overrides.json'), json({ version: 1, settings: { 'claude:settings.json': { effortLevel: 'max' } } }));
  result = await s.source((source) => source.effective([accept(EFFORT, 2)]));
  if (result._tag === 'Success') assert.deepEqual(result.success.conflicts, [EFFORT]);
  fails(await s.source((source) => source.recordApplied!({ revision: r2, decisions: [accept(EFFORT, 2)], observed: [EFFORT], released: [] })), 'RevisionMismatch');
});

test('removal requires explicit release evidence; absent observations never advance it', async (t) => {
  const s = fixture(); t.after(() => rmSync(s.root, { recursive: true, force: true })); s.publish();
  const r = s.publish({ 'claude/CLAUDE.md': null });
  await s.source((source) => source.recordApplied!({ revision: r, decisions: [accept(FILE, 2)], observed: [], released: [] }));
  fails(await s.source((source) => source.recordApplied!({ revision: r, decisions: [accept(FILE, 2)], observed: [FILE], released: [] })), 'RevisionMismatch');
  const saved = await s.source((source) => source.recordApplied!({ revision: r, decisions: [accept(FILE, 2)], observed: [], released: [FILE] }));
  assert.equal(saved._tag, 'Success');
  const result = await s.source((source) => source.effective([]));
  assert.equal(result._tag, 'Success'); if (result._tag === 'Success') assert.equal(s.textAt(result.success.applied.repo, 'claude/CLAUDE.md'), undefined);
});

test('revision helpers retain commit serialization and numeric identity', () => {
  assert.equal(typeof sync.revisionCommit, 'function');
  const r: SyncRevision = { setupId: 'setup-1', number: 7, commitSha: 'a'.repeat(40), tag: 'v7', changelog: '', requiredEnv: [], items: [] };
  assert.equal(sync.revisionCommit(r), r.commitSha); assert.equal(sync.revisionIdentity(r), 7); assert.equal(sync.revisionSetupId(r), 'setup-1');
  assert.equal(sync.revisionIdentity(r.commitSha), r.commitSha); assert.equal(sync.revisionSetupId(r.commitSha), 'local');
});

test('a retained source stops when the active account changes', async (t) => {
  const s = fixture(); t.after(() => rmSync(s.root, { recursive: true, force: true })); const r = s.publish();
  await s.source((source) => Effect.gen(function* () {
    yield* source.load(r);
    s.account('account-2'); s.calls.length = 0;
    const result = yield* Effect.result(source.load(r));
    fails(result, 'RevisionUnavailable');
    assert.equal(s.calls.length, 0);
  }));
});

test('stale inspection evidence cannot advance origins after a later publication', async (t) => {
  const s = fixture(); t.after(() => rmSync(s.root, { recursive: true, force: true })); const r = s.publish();
  s.publish({ 'claude/settings.keys.json': json({ theme: 'auto', effortLevel: 'medium' }) });
  fails(await s.source((source) => source.recordApplied!({ revision: r, decisions: [accept(EFFORT, 2)], observed: [EFFORT], released: [] })), 'RevisionMismatch');
  const baseline = await s.source((source) => source.baseline!);
  if (baseline._tag === 'Success') assert.equal(baseline.success.revisionApplied, 0);
});

test('account change during Git verification prevents subsequent Git and snapshot operations', async (t) => {
  const s = fixture(); t.after(() => rmSync(s.root, { recursive: true, force: true })); const r = s.publish();
  s.afterFetch(() => s.account('account-2'));
  fails(await s.source((source) => source.load(r)), 'RevisionUnavailable');
  assert.equal(s.calls.filter((args) => args.includes('fetch')).length, 1);
  assert.equal(s.calls.some((args) => args.includes('ls-tree')), false);
});

test('another bound account with reused setup and metadata starts with empty clone and no verification cache', async (t) => {
  const s = fixture(); t.after(() => rmSync(s.root, { recursive: true, force: true })); const r = s.publish(); s.trust(null);
  assert.equal((await s.source((source) => source.recordApplied!({ revision: r, decisions: [accept(EFFORT)], observed: [EFFORT], released: [] })))._tag, 'Success');
  s.account('account-2'); s.trust(null, 'account-2');
  const baseline = await s.source((source) => source.baseline!, 'account-2');
  assert.equal(baseline._tag, 'Success'); if (baseline._tag === 'Success') assert.deepEqual(baseline.success, { revisionApplied: 0, origins: {} });
  s.offline();
  fails(await s.source((source) => source.load(r), 'account-2'), 'RevisionUnavailable');
});

test('a first publication with empty Git documents has an empty verified diff', async (t) => {
  const s = fixture({}); t.after(() => rmSync(s.root, { recursive: true, force: true })); const r = s.publish();
  assert.deepEqual(r.items, []);
  assert.equal((await s.source((source) => source.load(r)))._tag, 'Success');
});

test('a newly consented repository URL with reused setup ID has no previous baseline or verified refs', async (t) => {
  const s = fixture(); t.after(() => rmSync(s.root, { recursive: true, force: true })); const r = s.publish(); s.trust(null);
  await s.source((source) => source.recordApplied!({ revision: r, decisions: [accept(EFFORT)], observed: [EFFORT], released: [] }));
  const otherUrl = 'https://github.com/example/other.git';
  s.trust(null, 'account-1', otherUrl);
  const baseline = await s.source((source) => source.baseline!, 'account-1', otherUrl);
  assert.equal(baseline._tag, 'Success'); if (baseline._tag === 'Success') assert.deepEqual(baseline.success, { revisionApplied: 0, origins: {} });
  s.offline();
  fails(await s.source((source) => source.load(r), 'account-1', otherUrl), 'RevisionUnavailable');
});

test('service-free metadata errors become generic unavailable errors without metadata diagnostics', async (t) => {
  const s = fixture(); t.after(() => rmSync(s.root, { recursive: true, force: true })); s.publish();
  const effect = sync.SetupSource.use((source) => source.fetch).pipe(Effect.provide(sync.hostedSetupSourceLayer(s.paths, { accountId: 'account-1', currentAccountId: Effect.succeed('account-1'), setupId: 'setup-1', repoUrl: URL, records: Effect.fail(new Error('private rejected content')), processes: Layer.succeed(Processes, { run: () => Effect.succeed({ code: 0, stdout: URL }) }) })));
  const result = await Effect.runPromise(Effect.result(effect));
  fails(result, 'RevisionUnavailable');
  if (result._tag === 'Failure') assert.equal(result.failure.message.includes('private rejected content'), false);
});

test('source-wide held pin cannot become HEAD provenance for a differently composed accepted sibling', async (t) => {
  const source = 'example/skills';
  const a = `skill:${source}/a`;
  const oldPin = 'a'.repeat(40);
  const newPin = 'b'.repeat(40);
  const s = fixture({ 'skills-manifest.txt': `[${source}]\na\nb\n`, 'skill-pins.json': json({ version: 1, pins: { [source]: oldPin } }) });
  t.after(() => rmSync(s.root, { recursive: true, force: true })); s.publish();
  const r = s.publish({ 'skill-pins.json': json({ version: 1, pins: { [source]: newPin } }) });
  const composed = await s.source((service) => service.effective([accept(a, 2)]));
  assert.equal(composed._tag, 'Success');
  if (composed._tag === 'Success') assert.equal(composed.success.effective.desired.skills.find((skill) => skill.name === 'a')?.pin?.ref, oldPin);
  fails(await s.source((service) => service.recordApplied!({ revision: r, decisions: [accept(a, 2)], observed: [a], released: [] })), 'RevisionMismatch');
  const baseline = await s.source((service) => service.baseline!);
  assert.equal(baseline._tag, 'Success'); if (baseline._tag === 'Success') assert.equal(baseline.success.origins[a], s.first);
});

test('partial pin adoption refuses provenance that cannot materialize the positively observed selected value', async (t) => {
  const source = 'example/skills';
  const a = `skill:${source}/a`;
  const b = `skill:${source}/b`;
  const oldPin = 'a'.repeat(40);
  const newPin = 'b'.repeat(40);
  const s = fixture({ 'skills-manifest.txt': `[${source}]\na\nb\n`, 'skill-pins.json': json({ version: 1, pins: { [source]: oldPin } }) });
  t.after(() => rmSync(s.root, { recursive: true, force: true })); s.publish();
  const r = s.publish({ 'skill-pins.json': json({ version: 1, pins: { [source]: newPin } }) });
  const decisions = [accept(a, 2), accept(b, 2)];
  const composed = await s.source((service) => service.effective(decisions));
  assert.equal(composed._tag, 'Success');
  if (composed._tag === 'Success') assert.equal(composed.success.effective.desired.skills.find((skill) => skill.name === 'a')?.pin?.ref, newPin);
  fails(await s.source((service) => service.recordApplied!({ revision: r, decisions, observed: [a], released: [] })), 'RevisionMismatch');
  assert.equal((await s.source((service) => service.recordApplied!({ revision: r, decisions, observed: [a, b], released: [] })))._tag, 'Success');
});
