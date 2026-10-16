import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { Processes, backupsForRun, canonical, machinePaths, nodeFs, nodeProcesses, decisionsStore, historyStore, type Command, type Completed, type LaunchFailed } from '@nortuscc/machine';
import { machineGit } from '@nortuscc/source-watch';
import { HostedFailure, HostedTransport, MachineTokenStore, hostedStore, makeHostedClient, type HostedRequest, type HostedResponse } from '@nortuscc/hosted-client';
import { hostedSetupSourceLayer, SetupSource, worktreeDocuments, itemValues } from '@nortuscc/sync';
import { parseSyncQuery, type RevisionRecord, type SetupRecord } from '@nortuscc/hosted-protocol';
import { authorWorkspaceLayer, GIT_TIMEOUT_MS } from '../src/author/workspace.ts';
import { DraftStore, DraftStoreError, draftStore, type Draft } from '../src/author/drafts.ts';
import { boundedPreview, makeAuthorPublisher } from '../src/author/publish.ts';
import { makeAgentRuns, operationDigest, type RunLifecycle } from '../src/runs.ts';
import { RunStore, RunStoreError, runStore } from '../src/run-store.ts';
import type { SessionError } from '../src/ipc/session.ts';
import type { PreparedParityChange } from '../src/operations/parity.ts';

const fixture = async (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), 'author-publish-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH!, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'gitconfig') };
  const origin = join(root, 'origin.git');
  const repoUrl = 'https://github.com/fixture/config';
  const git = (dir: string, ...args: string[]) => execFileSync('git', [...(args.some(arg => ['clone', 'fetch', 'push', 'ls-remote'].includes(arg)) ? ['-c', `url.${origin}.insteadOf=${repoUrl}`] : []), '-C', dir, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const checkout = join(root, 'checkout'); mkdirSync(checkout);
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(checkout, 'init', '-q', '-b', 'main'); git(checkout, 'config', 'user.name', 'Fixture'); git(checkout, 'config', 'user.email', 'fixture@example.test');
  const docs = { 'profiles/base.json': '{}\n', 'profiles/personal.json': '{"extends":"base"}\n',
    'profiles/other.json': '{"files":{"claude:CLAUDE.md":null}}\n', 'claude/CLAUDE.md': 'old\n', 'skills-manifest.txt': '' };
  for (const [path, text] of Object.entries(docs)) { mkdirSync(join(checkout, path, '..'), { recursive: true }); writeFileSync(join(checkout, path), text); }
  git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'initial'); git(checkout, 'remote', 'add', 'origin', origin); git(checkout, 'push', '-q', 'origin', 'main');
  const first = git(origin, 'rev-parse', 'main');
  let intercept: ((c: Command) => Effect.Effect<Completed, LaunchFailed> | undefined) | undefined;
  const processes = Layer.effect(Processes, Effect.map(Processes, real => ({ run: (c: Command) => {
    const replacement = intercept?.(c); if (replacement) return replacement;
    if (c.cmd === 'gh') {
      if (c.args[0] === '--version' || c.args[0] === 'auth') return Effect.succeed({ code: 0, stdout: '' });
      assert.deepEqual(c.args, ['api', 'user']);
      return Effect.succeed({ code: 0, stdout: '{"login":"fixture","id":42}' });
    }
    assert.equal(c.cmd, 'git');
    const transport = c.args.some(arg => ['clone', 'fetch', 'push', 'ls-remote'].includes(arg));
    return real.run({ ...c, args: transport ? ['-c', `url.${origin}.insteadOf=${repoUrl}`, ...c.args] : c.args });
  } }))).pipe(Layer.provide(nodeProcesses({ env })));
  const paths = { repo: checkout, stateRoot: join(root, 'state'), backups: join(root, 'backups'), claude: root, codex: root, codexOpenRouter: root, agentsSkills: root };
  const base = Layer.mergeAll(machinePaths(paths), nodeFs, processes);
  const backups = backupsForRun().pipe(Layer.provide(base));
  const workspaceRouted = authorWorkspaceLayer({ env }).pipe(Layer.provide(Layer.merge(base, backups)));
  const stores = Layer.mergeAll(draftStore, runStore, hostedStore, decisionsStore, historyStore()).pipe(Layer.provide(Layer.merge(base, backups)));
  const setups: SetupRecord[] = []; const revisions: RevisionRecord[] = [];
  let hostedFailure = false; let lostHostedReply: 'network' | 'revision_conflict' | undefined;
  let failedProfile: string | undefined;
  const transport = Layer.succeed(HostedTransport, { request: (req: HostedRequest) => Effect.suspend((): Effect.Effect<HostedResponse, HostedFailure> => {
    if (req.path === '/auth/device/start') return Effect.succeed({ status: 200, body: { pendingId: 'pending', userCode: 'ABCD', verificationUri: 'https://github.com/login/device', interval: 1, expiresIn: 120 } });
    if (req.path === '/auth/device/poll') return Effect.succeed({ status: 200, body: { accountId: 'account1', login: 'fixture', machineId: 'machine1', token: `nmt_account1_machine1_${'s'.repeat(43)}`, defaultPolicy: 'notify' } });
    if (hostedFailure) return Effect.fail(new HostedFailure({ code: 'network' }));
    if (req.path.startsWith('/sync?')) {
      const cursors = new Map(parseSyncQuery(new URL(req.path, 'https://fixture.test').searchParams).setups.map(s => [s.setupId, s.revision]));
      return Effect.succeed({ status: 200, body: { seq: setups.length + revisions.length, decisions: [], revisions: revisions.filter(r => r.number > (cursors.get(r.setupId) ?? 0)).map(({ publishedAt: _publishedAt, machineId: _machineId, ...revision }) => revision),
      setups: setups.map(s => ({ setupId: s.setupId, name: s.name, repoUrl: s.repoUrl, profile: s.profile, latestRevision: s.latestRevision, owned: true })), machine: { policy: 'notify', reportStatus: true }, pollAfter: 900 } });
    }
    if (req.path === '/setups') {
      const body = req.body as { name: string; repoUrl: string; profile: string };
      const setup = { ...body, setupId: `setup${setups.length + 1}`, latestRevision: 0, createdAt: '2026-10-16T00:00:00Z' }; setups.push(setup);
      return Effect.succeed({ status: 201, body: setup });
    }
    const id = req.path.split('/')[2]!;
    if (req.method === 'GET') return Effect.succeed({ status: 200, body: { revisions: revisions.filter(r => r.setupId === id), nextAfter: null } });
    const body = req.body as Omit<RevisionRecord, 'setupId' | 'publishedAt' | 'machineId'>;
    const setup = setups.find(s => s.setupId === id)!;
    if (setup.profile === failedProfile) return Effect.fail(new HostedFailure({ code: 'network' }));
    if (body.number !== setup.latestRevision + 1) return Effect.fail(new HostedFailure({ code: 'revision_conflict', status: 409 }));
    const record = { ...body, setupId: id, publishedAt: '2026-10-16T00:00:00Z', machineId: 'machine1' }; revisions.push(record); setups[setups.indexOf(setup)] = { ...setup, latestRevision: setup.latestRevision + 1 };
    if (lostHostedReply) { const code = lostHostedReply; lostHostedReply = undefined; return Effect.fail(new HostedFailure({ code, ...(code === 'revision_conflict' ? { status: 409 } : {}) })); }
    return Effect.succeed({ status: 201, body: record });
  }) });
  let token: string | undefined;
  const credentials = Layer.succeed(MachineTokenStore, { read: () => Effect.succeed(token), write: value => Effect.sync(() => { token = value; }), remove: () => Effect.sync(() => { token = undefined; }) });
  const layer = Layer.mergeAll(base, workspaceRouted, stores, machineGit({ env, timeoutMs: GIT_TIMEOUT_MS, maxBytes: 1024 * 1024 }).pipe(Layer.provide(processes)), transport, credentials);
  return await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* RunStore;
    let clock = Date.parse('2026-10-16T00:00:00Z');
    const client = yield* makeHostedClient({ now: () => new Date(clock), readPolicy: Effect.succeed({ policy: 'notify', policySource: 'default' }), onPolicy: () => Effect.void });
    yield* client.startSignIn({ os: 'macos', agents: ['claude'] }); clock += 1000; yield* client.pollSignIn();
    const owner = yield* makeAuthorPublisher(client);
    const withDrafts = (service: DraftStore['Service']) => run(makeAuthorPublisher(client).pipe(Effect.provideService(DraftStore, service), Effect.provide(layer)));
    const drafts = yield* DraftStore; const runStore = yield* RunStore;
    const run = <A, E>(body: Effect.Effect<A, E>) => Effect.runPromise(body);
    const save = (intents: Draft['intents'] = [{ kind: 'captureFile', profile: 'base', fileId: 'claude:CLAUDE.md', text: 'new\n', choice: { kind: 'updateShared' } }]) => {
      const draft: Draft = { version: 1, id: randomUUID(), repoUrl, createdAt: new Date(clock).toISOString(), intents };
      return run(drafts.write(draft)).then(() => draft);
    };
    const execute = (prepared: PreparedParityChange, receiptStore = store, final: Parameters<RunLifecycle['finished']>[0] = { type: 'done', ok: 1, failed: 0 }) => run(Effect.scoped(Effect.gen(function* () {
      const runs = yield* makeAgentRuns({ start: (_, lifecycle) => Effect.gen(function* () {
        yield* lifecycle.accepted(prepared.preview.change, prepared.acceptance.plannedKeys, undefined, prepared.acceptance);
        yield* prepared.execute(lifecycle, new AbortController().signal);
        yield* lifecycle.finished(final);
        return { status: 'started' as const, runId: lifecycle.runId };
      }), cancel: () => Effect.void });
      const id = randomUUID(); const accepted = yield* runs.submit({ requestId: id, inputDigest: operationDigest(id), planId: id, actor: 'app' });
      return yield* runs.get(accepted.runId);
    })).pipe(Effect.provideService(RunStore, receiptStore)));
    return { paths, processes, repoUrl, owner, withDrafts, client, drafts, runStore, save, execute, run, git, origin, checkout, first, revisions, setups,
      intercept: (f: typeof intercept) => { intercept = f; }, failHosted: (value: boolean) => { hostedFailure = value; }, loseHostedReply: (code: 'network' | 'revision_conflict' = 'network') => { lostHostedReply = code; }, failProfile: (profile?: string) => { failedProfile = profile; },
      move: (path = 'rival.txt', text = 'rival\n') => { git(checkout, 'pull', '-q', '--ff-only', 'origin', 'main'); mkdirSync(join(checkout, path, '..'), { recursive: true }); writeFileSync(join(checkout, path), text); git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'rival'); git(checkout, 'push', '-q', 'origin', 'main'); },
    };
  }).pipe(Effect.provide(layer))));
};

const publish = async (f: Awaited<ReturnType<typeof fixture>>, draft: Draft) => {
  const preview = await f.run(f.owner.previewDraft(draft.id));
  return f.execute(await f.run(f.owner.preparePublish({ kind: 'publishDraft', draftId: draft.id, digest: preview.digest })));
};

test('publish pushes the previewed diff, tags it and announces each pending profile', async t => {
  const f = await fixture(t); const draft = await f.save(); const preview = await f.run(f.owner.previewDraft(draft.id));
  assert.deepEqual(preview.affectedProfiles, ['base', 'personal']);
  assert.deepEqual(preview.diff, [{ path: 'claude/CLAUDE.md', before: 'old\n', after: 'new\n' }]);
  const result = await publish(f, draft); const commit = f.git(f.origin, 'rev-parse', 'main');
  assert.equal(f.git(f.origin, 'show', 'main:claude/CLAUDE.md'), 'new');
  assert.equal(f.git(f.origin, 'rev-parse', `refs/tags/nortuscc/${commit}`), commit);
  assert.equal(result.result?.status, 'succeeded');
  assert.deepEqual(result.publication, { commit, pushed: true, tagged: true, announced: ['base', 'other', 'personal'], pending: [] });
  assert.equal(await f.run(f.drafts.read(draft.id)), undefined);
  assert.equal(f.revisions.length, 3);
});

test('draft preview names each changed resolved item per affected profile', async t => {
  const f = await fixture(t);
  const draft = await f.save([
    { kind: 'captureFile', profile: 'base', fileId: 'claude:CLAUDE.md', text: 'new\n', choice: { kind: 'updateShared' } },
    { kind: 'createProfile', profile: 'team', extends: 'other' },
  ]);
  const preview = await f.run(f.owner.previewDraft(draft.id));
  assert.deepEqual(preview.affectedProfiles, ['base', 'personal', 'team']);
  assert.deepEqual(preview.items, [
    { profile: 'base', itemId: 'file:claude:CLAUDE.md', kind: 'file', change: 'changed' },
    { profile: 'personal', itemId: 'file:claude:CLAUDE.md', kind: 'file', change: 'changed' },
    ...preview.items.filter(item => item.profile === 'team'),
  ]);
  assert.ok(preview.items.some(item => item.profile === 'team' && item.change === 'added'));
  assert.ok(preview.items.every(item => item.profile !== 'other'));
  assert.equal(preview.itemsTruncated, undefined);
  assert.equal(preview.digest, createHash('sha256').update(canonical(preview.diff)).digest('hex'));
});

test('items stay bounded and say when truncated', async t => {
  const f = await fixture(t);
  f.move('skills-manifest.txt', '[owner/many]\n' + Array.from({ length: 1005 }, (_, index) => `skill-${String(index).padStart(4, '0')}`).join('\n') + '\n');
  const draft = await f.save([{ kind: 'createProfile', profile: 'team', extends: 'base' }]);
  const preview = await f.run(f.owner.previewDraft(draft.id));
  assert.equal(preview.items.length, 1000);
  assert.equal(preview.itemsTruncated, true);
  assert.deepEqual(preview.affectedProfiles, ['team']);
  assert.ok(preview.items.every(item => item.profile === 'team' && item.change === 'added'));
  assert.ok(Buffer.byteLength(JSON.stringify(preview)) < 1_048_576);
});

test('items with long multi-byte IDs stay within a byte budget beside a full diff', () => {
  const id = (index: number) => `skill:owner/repo/${'界'.repeat(490)}${String(index).padStart(4, '0')}`;
  const items = Array.from({ length: 1000 }, (_, index) => ({ profile: 'team', itemId: id(index), kind: 'skill' as const, change: 'added' as const }));
  const diff = Array.from({ length: 40 }, (_, index) => ({ path: `profiles/p${index}.json`, before: 'é'.repeat(10_000), after: 'ü'.repeat(10_000) }));
  const preview = boundedPreview({ draftId: randomUUID(), base: 'a'.repeat(40), digest: 'b'.repeat(64), diff, invalid: [], affectedProfiles: ['team'], items });
  assert.equal(preview.itemsTruncated, true); assert.equal(preview.truncated, true);
  assert.ok(preview.items.length > 0 && preview.items.length < 1000);
  assert.deepEqual(preview.items, items.slice(0, preview.items.length));
  assert.ok(Buffer.byteLength(JSON.stringify(preview)) < 600_000, String(Buffer.byteLength(JSON.stringify(preview))));
});

test('publish refuses when the replayed diff no longer matches the preview', async t => {
  const f = await fixture(t); const draft = await f.save(); const preview = await f.run(f.owner.previewDraft(draft.id));
  const prepared = await f.run(f.owner.preparePublish({ kind: 'publishDraft', draftId: draft.id, digest: preview.digest }));
  await f.run(f.drafts.write({ ...draft, intents: [{ ...draft.intents[0]!, text: 'changed\n' } as Draft['intents'][number]] }));
  const result = await f.execute(prepared);
  assert.equal(result.result?.status, 'needs-preview'); assert.deepEqual(result.publication?.pending, []); assert.equal(f.git(f.origin, 'rev-parse', 'main'), f.first);
});

test('a push rejected because main moved asks for a new preview and pushes nothing', async t => {
  const f = await fixture(t); const draft = await f.save();
  f.intercept(c => { if (c.args.includes('push') && c.args.includes('HEAD:main')) f.move(); return undefined; });
  const result = await publish(f, draft);
  assert.equal(result.result?.status, 'needs-preview'); assert.equal(f.git(f.origin, 'show', 'main:claude/CLAUDE.md'), 'old');
  assert.equal(f.revisions.length, 0);
});

test('a hosted failure after push leaves the run published but not yet announced', async t => {
  const f = await fixture(t); const draft = await f.save(); f.failHosted(true);
  const result = await publish(f, draft);
  assert.equal(result.result?.status, 'succeeded'); assert.equal(result.publication?.pushed, true);
  assert.deepEqual(result.publication?.pending, ['base', 'other', 'personal']); assert.ok(await f.run(f.drafts.read(draft.id)));
});

test('announce twice registers each profile revision once after a lost hosted reply', async t => {
  const f = await fixture(t); const draft = await f.save(); f.loseHostedReply(); const original = await publish(f, draft);
  for (let i = 0; i < 2; i++) {
    const prepared = await f.run(f.owner.prepareAnnounce({ kind: 'announcePublication', runId: original.runId }));
    const result = await f.execute(prepared); assert.deepEqual(result.publication?.pending, []);
  }
  assert.equal(f.revisions.length, 3); assert.ok(f.revisions.every(r => r.number === 1));
});

test('after a crash between commit and push, recovery reports not pushed', async t => {
  const f = await fixture(t); const draft = await f.save();
  f.intercept(c => c.args.includes('push') && c.args.includes('HEAD:main') ? Effect.die('process stopped') : undefined);
  await assert.rejects(publish(f, draft), /process stopped/);
  const receipt = (await f.run(f.runStore.read))[0]!;
  assert.ok(receipt.view.publication?.commit);
  f.intercept(undefined);
  const recovery = await f.run(f.owner.recoverPublication(receipt.view));
  assert.equal(recovery.published, false); assert.equal(recovery.action, 're-preview');
});

test('a profile unchanged since its announcement gets no additional revision', async t => {
  const f = await fixture(t); await publish(f, await f.save());
  await publish(f, await f.save([{ kind: 'captureFile', profile: 'base', fileId: 'claude:CLAUDE.md', text: 'next\n', choice: { kind: 'updateShared' } }]));
  const other = f.setups.find(setup => setup.profile === 'other')!;
  assert.equal(f.revisions.filter(revision => revision.setupId === other.setupId).length, 1);
});

test('a successful push with a lost reply continues tagging and announcing', async t => {
  const f = await fixture(t); const draft = await f.save();
  f.intercept(c => { if (c.args.includes('push') && c.args.includes('HEAD:main')) {
    f.git(c.cwd!, 'push', '-q', 'origin', 'HEAD:main'); return Effect.succeed({ code: 1, stdout: '', stderr: 'reply lost' });
  } return undefined; });
  const result = await publish(f, draft);
  assert.equal(result.result?.status, 'succeeded'); assert.equal(result.publication?.tagged, true); assert.equal(f.revisions.length, 3);
});

test('main advancing after preview requires preview again even when the draft diff is unchanged', async t => {
  const f = await fixture(t); const draft = await f.save(); const preview = await f.run(f.owner.previewDraft(draft.id));
  f.move(); const moved = f.git(f.origin, 'rev-parse', 'main');
  const result = await f.execute(await f.run(f.owner.preparePublish({ kind: 'publishDraft', draftId: draft.id, digest: preview.digest })));
  assert.equal(result.result?.status, 'needs-preview'); assert.equal(f.git(f.origin, 'rev-parse', 'main'), moved);
});

test('push denial records the repository permission failure', async t => {
  const f = await fixture(t); const draft = await f.save();
  f.intercept(c => c.args.includes('HEAD:main') ? Effect.succeed({ code: 1, stdout: '', stderr: 'Permission denied' }) : undefined);
  const result = await publish(f, draft);
  assert.deepEqual(result.result, { status: 'failed', message: 'No permission to push to https://github.com/fixture/config' });
  assert.equal(result.publication?.pushed, false); assert.equal(f.revisions.length, 0);
});

test('a tag failure retains a published run and Announce repairs it', async t => {
  const f = await fixture(t); const draft = await f.save();
  f.intercept(c => c.args.includes('push') && c.args.some(a => a.startsWith('refs/tags/')) ? Effect.succeed({ code: 1, stdout: '', stderr: 'offline' }) : undefined);
  const original = await publish(f, draft);
  assert.equal(original.result?.status, 'succeeded'); assert.equal(original.publication?.tagged, false); assert.equal(f.revisions.length, 0);
  f.intercept(undefined);
  const result = await f.execute(await f.run(f.owner.prepareAnnounce({ kind: 'announcePublication', runId: original.runId })));
  assert.equal(result.publication?.tagged, true); assert.deepEqual(result.publication?.pending, []);
});

test('announce does not publish an empty revision', async t => {
  const f = await fixture(t); const draft = await f.save();
  f.intercept(c => c.args.includes('push') && c.args.some(a => a.startsWith('refs/tags/')) ? Effect.succeed({ code: 1, stdout: '', stderr: 'offline' }) : undefined);
  const original = await publish(f, draft);
  assert.deepEqual(original.publication?.pending, ['base', 'other', 'personal']);
  f.intercept(undefined);
  // Another announcement reaches the server after preview, without changing this profile's values.
  const other = await f.run(f.client.registerSetup({ name: 'other', repoUrl: f.repoUrl, profile: 'other' }));
  await f.run(f.client.publishRevision(other.setupId, { number: 1, commitSha: f.first, tag: `nortuscc/${f.first}`, changelog: '',
    items: [{ id: 'file:claude:CLAUDE.md', kind: 'file', change: 'added' }], requiredEnv: [] }));
  const result = await f.execute(await f.run(f.owner.prepareAnnounce({ kind: 'announcePublication', runId: original.runId })));
  assert.equal(f.revisions.filter(revision => revision.setupId === other.setupId).length, 1);
  assert.ok(f.revisions.every(revision => revision.items.length > 0));
  assert.deepEqual(result.publication?.pending, []);
  assert.deepEqual(result.publication?.announced, ['base', 'personal']);
  assert.deepEqual(result.publication?.unannounceable ?? [], []);
  assert.equal((await f.run(f.owner.recoverPublication(original))).action, null);
  assert.equal(await f.run(f.drafts.read(draft.id)), undefined);
});

test('announcement compares against the previous announced commit and includes skipped changes', async t => {
  const f = await fixture(t); await publish(f, await f.save());
  f.move('codex/AGENTS.md', 'unannounced instructions\n');
  const result = await publish(f, await f.save([{ kind: 'captureFile', profile: 'base', fileId: 'claude:CLAUDE.md', text: 'third\n', choice: { kind: 'updateShared' } }]));
  assert.deepEqual(result.publication?.pending, []);
  const latest = f.revisions.filter(r => r.number === 2);
  assert.equal(latest.length, 3);
  for (const record of latest.filter(record => f.setups.find(setup => setup.setupId === record.setupId)!.profile !== 'other')) assert.deepEqual(record.items, [
    { id: 'file:claude:CLAUDE.md', kind: 'file', change: 'changed' },
    { id: 'file:codex:AGENTS.md', kind: 'file', change: 'added' },
  ]);
  const other = f.setups.find(setup => setup.profile === 'other')!;
  assert.deepEqual(latest.find(record => record.setupId === other.setupId)!.items, [{ id: 'file:codex:AGENTS.md', kind: 'file', change: 'added' }]);
});

test('announcing an older run does not append a revision after a newer commit', async t => {
  const f = await fixture(t); f.failHosted(true); const draft = await f.save(); const old = await publish(f, draft); f.failHosted(false);
  const latest = await publish(f, await f.save([{ kind: 'captureFile', profile: 'base', fileId: 'claude:CLAUDE.md', text: 'later\n', choice: { kind: 'updateShared' } }]));
  const count = f.revisions.length;
  const result = await f.execute(await f.run(f.owner.prepareAnnounce({ kind: 'announcePublication', runId: old.runId })));
  assert.equal(f.revisions.length, count); assert.deepEqual(result.publication?.pending, []);
  assert.deepEqual(result.publication?.unannounceable?.map(p => p.profile), ['base', 'other', 'personal']);
  assert.ok(result.publication?.unannounceable?.every(p => /newer|divergent/i.test(p.reason)));
  assert.equal((await f.run(f.owner.recoverPublication(result))).action, null);
  assert.equal((await f.run(f.owner.recoverPublication(old))).action, null);
  assert.equal(await f.run(f.drafts.read(draft.id)), undefined);
  assert.ok(f.revisions.every(r => r.commitSha === latest.publication?.commit));
});

test('recovery recognizes a published commit after main advances and stays uncertain offline', async t => {
  const f = await fixture(t); f.failHosted(true); const original = await publish(f, await f.save()); f.move();
  assert.deepEqual(await f.run(f.owner.recoverPublication(original)), { published: true, action: 'announce' });
  f.intercept(c => c.args.includes('fetch') ? Effect.succeed({ code: 1, stdout: '', stderr: 'offline' }) : undefined);
  assert.deepEqual(await f.run(f.owner.recoverPublication(original)), { published: 'unknown', action: 're-check' });
});

test('an invalid intent never publishes the valid portion of a draft', async t => {
  const f = await fixture(t); const draft = await f.save([{ kind: 'createProfile', profile: 'new', extends: 'missing' }]);
  const preview = await f.run(f.owner.previewDraft(draft.id)); assert.equal(preview.invalid.length, 1);
  const result = await publish(f, draft); assert.equal(result.result?.status, 'needs-preview'); assert.deepEqual(result.publication?.pending, []); assert.equal(f.git(f.origin, 'rev-parse', 'main'), f.first);
});

test('a draft edited after publication is retained when its older commit is announced', async t => {
  const f = await fixture(t); const draft = await f.save(); f.failHosted(true); const original = await publish(f, draft);
  const edited: Draft = { ...draft, intents: [{ kind: 'createProfile', profile: 'next', extends: null }] }; await f.run(f.drafts.write(edited)); f.failHosted(false);
  await f.execute(await f.run(f.owner.prepareAnnounce({ kind: 'announcePublication', runId: original.runId })));
  assert.deepEqual(await f.run(f.drafts.read(draft.id)), edited);
});

test('announcement includes the enabled integrations required environment names', async t => {
  const f = await fixture(t);
  f.move('integrations.json', JSON.stringify({ version: 1, integrations: [{ id: 'server', label: 'Server', target: 'codex', type: 'mcp', command: 'server', default: true, requiresEnv: ['SERVER_KEY'] }] }));
  await publish(f, await f.save());
  assert.equal(f.revisions.length, 3); assert.deepEqual(f.revisions[0]!.requiredEnv, ['SERVER_KEY']);
});

test('an existing commit with contradictory hosted items cannot be announced', async t => {
  const f = await fixture(t); const original = await publish(f, await f.save());
  f.revisions[0] = { ...f.revisions[0]!, items: [] };
  const result = await f.execute(await f.run(f.owner.prepareAnnounce({ kind: 'announcePublication', runId: original.runId })));
  assert.deepEqual(result.publication?.pending, []); assert.equal(f.revisions.length, 3);
  assert.deepEqual(result.publication?.unannounceable, [{ profile: 'base', reason: 'Existing hosted revision has different publication metadata' }]);
});

test('a failed durable commit checkpoint prevents the push', async t => {
  const f = await fixture(t); const draft = await f.save(); const preview = await f.run(f.owner.previewDraft(draft.id));
  const prepared = await f.run(f.owner.preparePublish({ kind: 'publishDraft', draftId: draft.id, digest: preview.digest }));
  const store = f.runStore;
  const failure = { ...store, write: (receipt: Parameters<typeof store.write>[0]) => receipt.view.publication?.commit
    ? Effect.fail(new RunStoreError('receipt unavailable')) : store.write(receipt) };
  await assert.rejects(f.execute(prepared, failure), /receipt unavailable/);
  assert.equal(f.git(f.origin, 'rev-parse', 'main'), f.first); assert.equal(f.revisions.length, 0);
});

test('a committed publication returning 409 is reconciled without another revision', async t => {
  const f = await fixture(t); f.loseHostedReply('revision_conflict'); const original = await publish(f, await f.save());
  const result = await f.execute(await f.run(f.owner.prepareAnnounce({ kind: 'announcePublication', runId: original.runId })));
  assert.deepEqual(result.publication?.pending, []); assert.equal(f.revisions.length, 3);
  assert.ok(f.revisions.every(r => r.number === 1));
});

test('partial hosted success records each profile and retry only appends the missing revision', async t => {
  const f = await fixture(t); const draft = await f.save(); f.failProfile('personal'); const original = await publish(f, draft);
  assert.deepEqual(original.publication?.announced, ['base', 'other']); assert.deepEqual(original.publication?.pending, ['personal']);
  assert.ok(await f.run(f.drafts.read(draft.id))); f.failProfile();
  const result = await f.execute(await f.run(f.owner.prepareAnnounce({ kind: 'announcePublication', runId: original.runId })));
  assert.deepEqual(result.publication?.pending, []); assert.equal(f.revisions.length, 3);
  assert.equal(await f.run(f.drafts.read(draft.id)), undefined);
});

test('preview preserves existing source ignores while replaying another ignore', async t => {
  const f = await fixture(t);
  const before = JSON.stringify({ version: 1, ignored: { 'owner/keep': 'a'.repeat(40) } }, null, 2) + '\n';
  f.move('source-ignores.json', before);
  const draft = await f.save([{ kind: 'ignore', source: 'owner/new', revision: 'b'.repeat(40) }]);
  const preview = await f.run(f.owner.previewDraft(draft.id));
  assert.equal(preview.diff[0]?.before, before);
  const result = await publish(f, draft); assert.equal(result.result?.status, 'succeeded');
  const ignored = JSON.parse(f.git(f.origin, 'show', 'main:source-ignores.json')).ignored;
  assert.deepEqual(ignored, { 'owner/keep': 'a'.repeat(40), 'owner/new': 'b'.repeat(40) });
});

test('switching a profile to an existing file with identical bytes changes no resolved values', async t => {
  const f = await fixture(t); await publish(f, await f.save()); f.move('claude/same.md', 'new\n');
  const draft = await f.save([{ kind: 'setFile', profile: 'base', fileId: 'claude:CLAUDE.md', path: 'claude/same.md' }]);
  const preview = await f.run(f.owner.previewDraft(draft.id));
  assert.deepEqual(preview.affectedProfiles, []);
});

test('a defect after push succeeds with pending announcements and Announce completes it', async t => {
  const f = await fixture(t); const draft = await f.save();
  f.intercept(c => c.args.includes('ls-remote') ? Effect.die('process stopped after push') : undefined);
  const published = await publish(f, draft);
  assert.equal(published.result?.status, 'succeeded');
  assert.match(published.result!.message, /announcement/i);
  const receipt = (await f.run(f.runStore.read))[0]!; f.intercept(undefined);
  assert.deepEqual(await f.run(f.owner.recoverPublication(receipt.view)), { published: true, action: 'announce' });
  const result = await f.execute(await f.run(f.owner.prepareAnnounce({ kind: 'announcePublication', runId: receipt.view.runId })));
  assert.deepEqual(result.publication?.pending, []); assert.equal(f.revisions.length, 3);
  const original = (await f.run(f.runStore.read)).find(r => r.view.runId === receipt.view.runId)!;
  assert.equal(original.view.state, 'succeeded');
});

test('a failure after publication retains success and reports the failure as a note', async t => {
  const f = await fixture(t); const draft = await f.save(); const preview = await f.run(f.owner.previewDraft(draft.id));
  const prepared = await f.run(f.owner.preparePublish({ kind: 'publishDraft', draftId: draft.id, digest: preview.digest }));
  const result = await f.execute(prepared, f.runStore, { type: 'failed', message: 'Final session checkpoint failed' });
  assert.equal(result.result?.status, 'succeeded'); assert.equal(result.publication?.pushed, true);
  assert.match(result.result!.message, /Final session checkpoint failed/);
});

test('a push that lands while the follow-up fetch fails is still treated as published', async t => {
  const f = await fixture(t); const draft = await f.save(); let pushed = false; let fetches = 0;
  f.intercept(c => {
    if (c.args.includes('HEAD:main')) {
      f.git(c.cwd!, 'push', '-q', 'origin', 'HEAD:main'); pushed = true;
      return Effect.succeed({ code: 1, stdout: '', stderr: 'reply lost' });
    }
    if (pushed && c.args.includes('fetch') && fetches++ === 0) return Effect.succeed({ code: 1, stdout: '', stderr: 'offline' });
    return undefined;
  });
  const result = await publish(f, draft);
  assert.equal(result.result?.status, 'succeeded'); assert.equal(result.publication?.pushed, true);
  assert.equal(result.publication?.tagged, true); assert.equal(f.revisions.length, 3);
  assert.equal(await f.run(f.drafts.read(draft.id)), undefined);
});

test('an unknown push outcome offers re-check and can later be announced', async t => {
  const f = await fixture(t); const draft = await f.save(); let pushed = false;
  f.intercept(c => {
    if (c.args.includes('HEAD:main')) {
      f.git(c.cwd!, 'push', '-q', 'origin', 'HEAD:main'); pushed = true;
      return Effect.succeed({ code: 1, stdout: '', stderr: 'reply lost' });
    }
    return pushed && c.args.includes('fetch') ? Effect.succeed({ code: 1, stdout: '', stderr: 'Permission denied' }) : undefined;
  });
  const result = await publish(f, draft);
  assert.equal(result.state, 'interrupted'); assert.equal(result.result?.status, 'interrupted');
  assert.match(result.result!.message, /push outcome is unknown/i);
  assert.deepEqual(result.publication?.pending, []);
  assert.deepEqual(await f.run(f.owner.recoverPublication(result)), { published: 'unknown', action: 're-check' });
  assert.ok(await f.run(f.drafts.read(draft.id)));
  f.intercept(undefined);
  assert.deepEqual(await f.run(f.owner.recoverPublication(result)), { published: true, action: 'announce' });
  const announced = await f.execute(await f.run(f.owner.prepareAnnounce({ kind: 'announcePublication', runId: result.runId })));
  assert.equal(announced.result?.status, 'succeeded'); assert.equal(f.revisions.length, 3);
});

test('missing drafts and runs without publications keep actionable invalid-request errors', async t => {
  const f = await fixture(t); const missing = randomUUID();
  for (const effect of [f.owner.previewDraft(missing), f.owner.preparePublish({ kind: 'publishDraft', draftId: missing, digest: 'a'.repeat(64) })]) {
    const error = await f.run(Effect.flip(effect as Effect.Effect<unknown, SessionError>));
    assert.equal(error.code, 'INVALID_REQUEST'); assert.match(error.message, /Draft does not exist/);
  }
  const error = await f.run(f.owner.prepareAnnounce({ kind: 'announcePublication', runId: missing }).pipe(Effect.flip));
  assert.equal(error.code, 'INVALID_REQUEST'); assert.match(error.message, /Run has no publication/);
});

test('preview and publish distinguish GitHub sign-in from repository access', async t => {
  const f = await fixture(t); const draft = await f.save();
  const preview = await f.run(f.owner.previewDraft(draft.id));
  for (const signedOut of [true, false]) {
    f.intercept(c => {
      if (c.cmd === 'gh' && c.args[0] === 'auth') return Effect.succeed({ code: signedOut ? 1 : 0, stdout: '' });
      return c.args.includes('fetch') ? Effect.succeed({ code: 1, stdout: '', stderr: 'Repository not found' }) : undefined;
    });
    for (const effect of [f.owner.previewDraft(draft.id), f.owner.preparePublish({ kind: 'publishDraft', draftId: draft.id, digest: preview.digest })]) {
      const error = await f.run(Effect.flip(effect as Effect.Effect<unknown, SessionError>));
      assert.equal(error.code, signedOut ? 'NOT_SIGNED_IN' : 'UNAUTHORIZED');
      assert.match(error.message, signedOut ? /gh.*sign.*in/i : /access.*repository/i);
    }
  }
});

for (const [name, settings, integrations, reason] of [
  ['invalid required environment names', {}, { 'mcp-server:sample': { requiresEnv: ['BAD-NAME'] } }, /environment/i],
  ['unsupported item identities', { 'has space': true }, {}, /item/i],
  ['more than 500 first-publication items', Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`key${i}`, true])), {}, /500|item/i],
] as const) test(`publication records ${name} as terminal and releases the draft`, async t => {
  const f = await fixture(t);
  if (Object.keys(settings).length) f.move('claude/settings.keys.json', JSON.stringify(settings));
  if (Object.keys(integrations).length) f.move('integrations.json', JSON.stringify({ version: 1, integrations: Object.entries(integrations).map(([id, fields]) => ({ id, label: 'Server', target: 'codex', type: 'mcp', command: 'server', default: true, ...fields })) }));
  const draft = await f.save(); const result = await publish(f, draft);
  assert.equal(result.result?.status, 'succeeded'); assert.deepEqual(result.publication?.pending, []);
  assert.deepEqual(result.publication?.unannounceable?.map(p => p.profile), ['base', 'other', 'personal']);
  assert.ok(result.publication?.unannounceable?.every(p => reason.test(p.reason)));
  assert.equal((await f.run(f.owner.recoverPublication(result))).action, null);
  assert.equal(await f.run(f.drafts.read(draft.id)), undefined); assert.equal(f.revisions.length, 0);
  const retried = await f.execute(await f.run(f.owner.prepareAnnounce({ kind: 'announcePublication', runId: result.runId })));
  assert.deepEqual(retried.publication?.pending, []);
  assert.deepEqual(retried.publication?.unannounceable, result.publication?.unannounceable);
  assert.equal(f.revisions.length, 0);
});

test('draft cleanup failure is a note on a successful published run', async t => {
  const f = await fixture(t); const draft = await f.save();
  const owner = await f.withDrafts({ ...f.drafts, delete: () => Effect.fail(new DraftStoreError('disk unavailable')) });
  const preview = await f.run(owner.previewDraft(draft.id));
  const result = await f.execute(await f.run(owner.preparePublish({ kind: 'publishDraft', draftId: draft.id, digest: preview.digest })));
  assert.equal(result.result?.status, 'succeeded'); assert.equal(result.publication?.pushed, true);
  assert.deepEqual(result.publication?.pending, []); assert.match(result.result!.message, /draft cleanup/i);
  assert.ok(await f.run(f.drafts.read(draft.id))); assert.equal(f.revisions.length, 3);
});


test('publishing a settings capture keeps private machine keys out of Git', async t => {
  const f = await fixture(t);
  f.move('claude/settings.keys.json', '{"model":"old"}');
  const draft = await f.save([{ kind: 'captureFile', profile: 'base', fileId: 'claude:settings.json', text: JSON.stringify({ model: 'new', permissions: {}, enabledPlugins: {}, env: { TOKEN: 'secret' }, hooks: { Stop: '/private/hook' } }), choice: { kind: 'updateShared' } }]);
  const result = await publish(f, draft);
  assert.equal(result.publication?.pushed, true);
  assert.deepEqual(JSON.parse(f.git(f.origin, 'show', 'main:claude/settings.keys.json')), { model: 'new' });
});


test('preview rejects resolution issues in every profile before publishing', async t => {
  const f = await fixture(t);
  f.move('profiles/other.json', '{"extends":"missing"}');
  const before = f.git(f.origin, 'rev-parse', 'main');
  const draft = await f.save();
  const preview = await f.run(f.owner.previewDraft(draft.id));
  assert.ok(preview.invalid.some(issue => issue.reason.includes('other') && issue.reason.includes('missing')));
  const result = await publish(f, draft);
  assert.equal(result.result?.status, 'needs-preview');
  assert.equal(f.git(f.origin, 'rev-parse', 'main'), before);
  assert.equal(f.revisions.length, 0);
});

test('announce refuses a previously published profile with resolution issues', async t => {
  const f = await fixture(t); f.failHosted(true);
  const original = await publish(f, await f.save());
  f.move('profiles/personal.json', '{"extends":"missing"}');
  const commit = f.git(f.origin, 'rev-parse', 'main');
  const receipt = (await f.run(f.runStore.read)).find(r => r.view.runId === original.runId)!;
  await f.run(f.runStore.write({ ...receipt, view: { ...receipt.view, publication: { ...receipt.view.publication!, commit } } }));
  f.failHosted(false);
  const result = await f.execute(await f.run(f.owner.prepareAnnounce({ kind: 'announcePublication', runId: original.runId })));
  assert.ok(result.publication?.unannounceable?.some(issue => issue.profile === 'personal' && issue.reason.includes('missing')));
  assert.ok(!f.revisions.some(revision => f.setups.find(s => s.setupId === revision.setupId)?.profile === 'personal'));
});


test('a profile changed by a hand push is announced on the next publish', async t => {
  const f = await fixture(t);
  await publish(f, await f.save());
  f.move('claude/personal.md', 'hand-pushed rules\n');
  f.move('profiles/personal.json', '{"extends":"base","files":{"claude:CLAUDE.md":"claude/personal.md"}}');
  const draft = await f.save([{ kind: 'captureFile', profile: 'base', fileId: 'claude:CLAUDE.md', text: 'next\n', choice: { kind: 'updateShared' } }]);
  const preview = await f.run(f.owner.previewDraft(draft.id));
  assert.deepEqual(preview.affectedProfiles, ['base']);
  const result = await publish(f, draft);
  assert.deepEqual(result.publication?.announced, ['base', 'personal']);
  const personal = f.setups.find(setup => setup.profile === 'personal')!;
  const revision = f.revisions.filter(revision => revision.setupId === personal.setupId).at(-1)!;
  assert.equal(revision.commitSha, result.publication?.commit);
  assert.deepEqual(revision.items, [{ id: 'file:claude:CLAUDE.md', kind: 'file', change: 'changed' }]);
  const unchanged = await f.save([{ kind: 'captureFile', profile: 'base', fileId: 'claude:CLAUDE.md', text: 'last\n', choice: { kind: 'updateShared' } }]);
  const last = await publish(f, unchanged);
  assert.deepEqual(last.publication?.announced, ['base']);
});


test('a follower verifies and loads the same profile items announced by publishing a draft', async t => {
  const f = await fixture(t);
  const first = await publish(f, await f.save());
  f.move('codex/AGENTS.md', 'hand-pushed instructions\n');
  const second = await publish(f, await f.save([{ kind: 'captureFile', profile: 'personal', fileId: 'claude:CLAUDE.md', text: 'follower rules\n', choice: { kind: 'ownCopy', repoPath: 'claude/personal.md' } }]));
  const setup = f.setups.find(setup => setup.profile === 'personal')!;
  const records = f.revisions.filter(record => record.setupId === setup.setupId).map(({ publishedAt: _, machineId: __, ...revision }) => revision);
  assert.equal(records.length, 2);
  assert.equal(records[0]!.commitSha, first.publication?.commit);
  assert.equal(records[1]!.commitSha, second.publication?.commit);
  const paths = { ...f.paths, stateRoot: join(f.paths.stateRoot, 'follower'), repo: join(f.paths.stateRoot, 'absent-checkout') };
  const layer = hostedSetupSourceLayer(paths, { accountId: 'follower', currentAccountId: Effect.succeed('follower'), setupId: setup.setupId,
    repoUrl: f.repoUrl, profile: 'personal', followed: { repoUrl: f.repoUrl, profile: 'personal', setupId: setup.setupId }, records: Effect.succeed(records), processes: f.processes });
  const loaded = await Effect.runPromise(SetupSource.use(source => Effect.gen(function* () {
    const head = yield* source.fetch;
    assert.equal(typeof head.head === 'string' ? head.head : head.head.commitSha, second.publication?.commit);
    const snapshot = yield* source.load(head.head);
    const documents = yield* worktreeDocuments(snapshot.repo);
    return { snapshot, documents, items: [...itemValues(documents, 'personal').keys()] };
  })).pipe(Effect.provide(layer), Effect.provide(nodeFs)));
  assert.deepEqual(loaded.snapshot.desired.issues, []);
  assert.equal(loaded.documents['claude/personal.md'], 'follower rules\n');
  assert.equal(loaded.documents['codex/AGENTS.md'], 'hand-pushed instructions\n');
  assert.deepEqual(loaded.items, ['file:claude:CLAUDE.md', 'file:codex:AGENTS.md']);
  assert.deepEqual(records[1]!.items, [{ id: 'file:claude:CLAUDE.md', kind: 'file', change: 'changed' }, { id: 'file:codex:AGENTS.md', kind: 'file', change: 'added' }]);
});


test('diff previews fit IPC while their digest and publication retain every byte', async t => {
  const f = await fixture(t);
  f.move('claude/CLAUDE.md', '\t'.repeat(600_000));
  const text = 'x'.repeat(200_000) + 'full tail';
  const draft = await f.save([{ kind: 'captureFile', profile: 'base', fileId: 'claude:CLAUDE.md', text, choice: { kind: 'updateShared' } }]);
  const preview = await f.run(f.owner.previewDraft(draft.id));
  assert.equal((preview.diff[0] as any).truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(preview)) < 1_048_576);
  const changed = await f.run(f.owner.previewDraftValue({ ...draft, intents: [{ ...draft.intents[0]!, text: text + 'changed' } as Draft['intents'][number]] }));
  assert.equal(changed.diff[0]!.after, preview.diff[0]!.after);
  assert.notEqual(changed.digest, preview.digest);
  const result = await f.execute(await f.run(f.owner.preparePublish({ kind: 'publishDraft', draftId: draft.id, digest: preview.digest })));
  assert.equal(result.publication?.pushed, true);
  assert.equal(f.git(f.origin, 'show', 'main:claude/CLAUDE.md'), text);
});

test('many changed files share a bounded preview budget without dropping published files', async t => {
  const f = await fixture(t);
  const text = '\t'.repeat(100_000);
  const draft = await f.save(Array.from({ length: 20 }, (_, index) => ({ kind: 'captureFile' as const, profile: 'personal', fileId: 'claude:CLAUDE.md', text, choice: { kind: 'ownCopy' as const, repoPath: `claude/capture-${index}.md` } })));
  const preview = await f.run(f.owner.previewDraft(draft.id));
  assert.equal((preview as any).truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(preview)) < 1_048_576);
  const result = await publish(f, draft);
  assert.equal(result.publication?.pushed, true);
  for (let index = 0; index < 20; index++) assert.equal(f.git(f.origin, 'cat-file', '-s', `main:claude/capture-${index}.md`), '100000');
});


test('profiles without an announced revision publish their complete initial values', async t => {
  const f = await fixture(t);
  const result = await publish(f, await f.save());
  assert.deepEqual(result.publication?.announced, ['base', 'other', 'personal']);
  const setup = f.setups.find(setup => setup.profile === 'other')!;
  assert.deepEqual(f.revisions.find(record => record.setupId === setup.setupId)!.items, [{ id: 'file:claude:CLAUDE.md', kind: 'file', change: 'added' }]);
});
