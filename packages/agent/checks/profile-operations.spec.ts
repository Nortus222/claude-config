import { HostedFailure, type HostedClient, type HostedState } from '@nortuscc/hosted-client';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { nodeProcesses, Processes, StateStore } from '@nortuscc/machine';
import { FollowedStore, SyncStore, SetupSource, followedSetupSourceLayer } from '@nortuscc/sync';
import { startAgent, makeSession, makeHostedRuntime } from '../src/index.ts';
import { prepareProfileOperation, readProfileOperation } from '../src/operations/profiles.ts';
import { operationDigest } from '../src/runs.ts';
import { agentMachine } from './support/agent-machine.ts';

const url = 'https://github.com/example/profiles.git';
const shared = { setupId: 'shared', name: 'Team', repoUrl: url, profile: 'small', latestRevision: 0 };
const git = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8' }).trim();
const scope = { kind: 'machine' } as const;
const change = { kind: 'followProfile', repoUrl: url, profile: 'small', setupId: null } as const;
async function fixture(t: test.TestContext, denied = false) {
  const m = agentMachine(); t.after(() => rmSync(m.root, { recursive: true, force: true }));
  git(m.paths.repo, 'checkout', '-qb', 'main');
  m.write(join(m.paths.repo, 'profiles', 'default.json'), '{}');
  m.write(join(m.paths.repo, 'profiles', 'small.json'), JSON.stringify({ files: { 'claude:settings.json': null } }));
  m.write(join(m.paths.repo, 'claude/settings.keys.json'), '{"theme":"dark"}');
  git(m.paths.repo, 'add', '.'); git(m.paths.repo, 'commit', '-qm', 'profiles');
  const commit = git(m.paths.repo, 'rev-parse', 'HEAD');
  m.write(join(m.paths.stateRoot, 'state.json'), JSON.stringify({ version: 1, files: {}, repo: null, applied: { commit, at: '2026-10-16T12:00:00.000Z' } }));
  const origin = join(m.root, 'origin.git');
  git(m.root, 'init', '-q', '--bare', '-b', 'main', origin);
  const calls: string[] = [];
  const network = { offline: false };
  const hosted = { publicSetup: () => Effect.succeed(shared), subscribe: (id: string) => Effect.sync(() => { calls.push(`subscribe:${id}`); }), unsubscribe: (id: string) => Effect.sync(() => { calls.push(`unsubscribe:${id}`); }) };
  const processes = Layer.effect(Processes, Effect.gen(function* () {
    const real = yield* Processes;
    return { run: request => {
      if (request.args?.includes('ls-remote') && denied) return Effect.succeed({ code: 128, stdout: '', stderr: 'Permission denied' });
      const remoteRead = request.args.includes('fetch') || request.args.includes('ls-remote');
      if (remoteRead && network.offline) return Effect.die(new Error('profile listing attempted network access'));
      if (remoteRead) git(m.paths.repo, 'push', '-q', origin, 'main', '--tags');
      return real.run({ ...request, args: request.args.map(arg => arg === url && remoteRead ? origin : arg) });
    } } satisfies Processes['Service'];
  })).pipe(Layer.provide(nodeProcesses()));
  return { m, commit, calls, hosted, processes, network };
}

test('switching profile previews and then removes holds for items the new profile lacks', async t => {
  const f = await fixture(t); const { m } = f;
  await m.run(Effect.scoped(Effect.gen(function* () {
    yield* (yield* FollowedStore).write({ ...change, profile: 'default' });
    yield* (yield* SyncStore).write({ 'setting:claude:settings.json#theme': f.commit });
    const handle = yield* startAgent(() => m.domains, { deferStart: true });
    const session = yield* makeSession(handle, { domains: () => m.domains, signal: new AbortController().signal });
    const preview = yield* session.previewChange(change);
    assert.ok('droppedChoices' in preview);
    assert.deepEqual(preview.droppedChoices.holds, ['setting:claude:settings.json#theme']);
    assert.equal((yield* (yield* FollowedStore).read)?.profile, 'default');
    const run = yield* session.runs.submit({ planId: preview.planId, requestId: 'switch', inputDigest: operationDigest(preview.planId), actor: 'app' });
    while (!(yield* session.runs.get(run.runId)).result || (yield* session.running)) yield* Effect.yieldNow;
    assert.equal((yield* session.runs.get(run.runId)).state, 'succeeded');
    assert.deepEqual(yield* (yield* SyncStore).read, {});
    assert.equal((yield* (yield* FollowedStore).read)?.profile, 'small');
    const selected = yield* handle.selectOperationSetup!('local');
    assert.equal(selected.source?.profile, 'small');
    const saved = readdirSync(m.paths.backups, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => readFileSync(join(e.parentPath, e.name), 'utf8'));
    assert.ok(saved.some(text => text.includes('setting:claude:settings.json#theme')));
  })).pipe(Effect.provide(f.processes)));
});

test('following a link to an unreadable repo is refused before subscribing', async t => {
  const f = await fixture(t, true);
  await f.m.run(Effect.scoped(Effect.gen(function* () {
    const real = yield* startAgent(() => f.m.domains, { deferStart: true });
    const handle = { ...real, profileHosted: f.hosted };
    const result = yield* readProfileOperation(handle, 'inspectShareLink', { scope, setupId: 'shared' });
    assert.equal(result.access, 'denied');
    const prepared = yield* Effect.exit(prepareProfileOperation(handle, { ...change, setupId: 'shared' }, 0));
    assert.equal(prepared._tag, 'Failure'); assert.deepEqual(f.calls, []);
    assert.equal(yield* (yield* FollowedStore).read, undefined);
  })).pipe(Effect.provide(f.processes)));
});

test('following a readable link subscribes and refetches without applying', async t => {
  const f = await fixture(t);
  await f.m.run(Effect.scoped(Effect.gen(function* () {
    const real = yield* startAgent(() => f.m.domains, { deferStart: true });
    let refetched = 0;
    const handle = { ...real, profileHosted: f.hosted, freshInspection: Effect.sync(() => { refetched++; return { status: { at: '2026-10-16T12:00:00Z', policy: 'notify' as const, paused: null, trusted: true, pending: [], drift: [], conflicts: [], probeErrors: [] } }; }) };
    const session = yield* makeSession(handle, { domains: () => f.m.domains, signal: new AbortController().signal });
    const preview = yield* session.previewChange({ ...change, setupId: 'shared' });
    const run = yield* session.runs.submit({ planId: preview.planId, requestId: 'follow', inputDigest: operationDigest(preview.planId), actor: 'app' });
    while (!(yield* session.runs.get(run.runId)).result || (yield* session.running)) yield* Effect.yieldNow;
    assert.equal((yield* session.runs.get(run.runId)).state, 'succeeded');
    assert.deepEqual(f.calls, ['subscribe:shared']); assert.equal(refetched, 1);
    assert.equal(f.m.read(join(f.m.paths.claude, 'settings.json')), undefined);
  }).pipe(Effect.provide(f.processes))));
});

test('after switching to a profile newer than the applied commit, declining an incoming item is a valid hold', async t => {
  const f = await fixture(t);
  f.m.write(join(f.m.paths.repo, 'profiles/personal.json'), '{}');
  git(f.m.paths.repo, 'add', '.'); git(f.m.paths.repo, 'commit', '-qm', 'new profile');
  await f.m.run(Effect.scoped(Effect.gen(function* () {
    const handle = yield* startAgent(() => f.m.domains, { deferStart: true });
    yield* (yield* FollowedStore).write({ repoUrl: url, profile: 'personal', setupId: null });
    const session = yield* makeSession(handle, { domains: () => f.m.domains, signal: new AbortController().signal });
    const review = yield* session.setupReview({ scope, setupId: 'local', refetch: true, limit: 100 });
    assert.equal(review.rows.find(row => row.itemId === 'setting:claude:settings.json#theme')?.change, 'added');
    const preview = yield* session.previewChange({ kind: 'setupApply', setupId: 'local', revision: review.revision, choices: [{ itemId: 'setting:claude:settings.json#theme', action: 'hold' }] });
    const run = yield* session.runs.submit({ planId: preview.planId, requestId: 'hold-new-profile', inputDigest: operationDigest(preview.planId), actor: 'app' });
    while (!(yield* session.runs.get(run.runId)).result || (yield* session.running)) yield* Effect.yieldNow;
    assert.equal((yield* session.runs.get(run.runId)).state, 'succeeded');
    assert.equal(f.m.read(join(f.m.paths.claude, 'settings.json')), undefined);
  })).pipe(Effect.provide(f.processes)));
});

test('switch previews remove stale holds and obsolete overrides while preserving machine-wide intent', async t => {
  const f = await fixture(t);
  f.m.write(join(f.m.paths.repo, 'profiles/new.json'), '{}');
  git(f.m.paths.repo, 'add', '.'); git(f.m.paths.repo, 'commit', '-qm', 'new profile');
  const original = { version: 2, manageConfig: true, configTargets: ['claude'], settings: { 'claude:settings.json': { theme: 'light', obsolete: 'value' } }, skills: { old: false }, integrations: { old: false }, privateExtension: 'keep' };
  f.m.write(join(f.m.paths.stateRoot, 'overrides.json'), JSON.stringify(original));
  await f.m.run(Effect.scoped(Effect.gen(function* () {
    yield* (yield* SyncStore).write({ 'setting:claude:settings.json#theme': f.commit });
    const handle = yield* startAgent(() => f.m.domains, { deferStart: true });
    const session = yield* makeSession(handle, { domains: () => f.m.domains, signal: new AbortController().signal });
    const preview = yield* session.previewChange({ ...change, profile: 'new' });
    assert.ok('droppedChoices' in preview);
    assert.deepEqual(preview.droppedChoices, { holds: ['setting:claude:settings.json#theme'], overrides: ['integrations.old', 'settings.claude:settings.json.obsolete', 'skills.old'] });
    const run = yield* session.runs.submit({ planId: preview.planId, requestId: 'switch-choices', inputDigest: operationDigest(preview.planId), actor: 'app' });
    while (!(yield* session.runs.get(run.runId)).result || (yield* session.running)) yield* Effect.yieldNow;
    assert.equal((yield* session.runs.get(run.runId)).state, 'succeeded');
    const saved = JSON.parse(f.m.read(join(f.m.paths.stateRoot, 'overrides.json'))!);
    assert.equal(saved.manageConfig, true); assert.deepEqual(saved.configTargets, ['claude']);
    assert.deepEqual(saved.settings, { 'claude:settings.json': { theme: 'light' } });
    assert.equal(saved.privateExtension, 'keep'); assert.deepEqual(saved.skills, {}); assert.deepEqual(saved.integrations, {});
  })).pipe(Effect.provide(f.processes)));
});

test('a profile preview refuses changed machine choices before saving the selection', async t => {
  const f = await fixture(t);
  await f.m.run(Effect.scoped(Effect.gen(function* () {
    const handle = yield* startAgent(() => f.m.domains, { deferStart: true });
    const session = yield* makeSession(handle, { domains: () => f.m.domains, signal: new AbortController().signal });
    const preview = yield* session.previewChange(change);
    f.m.write(join(f.m.paths.stateRoot, 'sync.json'), JSON.stringify({ version: 1, held: { 'setting:claude:settings.json#theme': f.commit } }));
    const result = yield* Effect.exit(session.runs.submit({ planId: preview.planId, requestId: 'stale-profile', inputDigest: operationDigest(preview.planId), actor: 'app' }));
    assert.equal(result._tag, 'Failure'); assert.equal(yield* (yield* FollowedStore).read, undefined);
  })).pipe(Effect.provide(f.processes)));
});

test('profile inventory reads verified repository declarations independently of obsolete machine overrides', async t => {
  const f = await fixture(t);
  f.m.write(join(f.m.paths.repo, 'profiles/child.json'), '{"extends":"default"}');
  git(f.m.paths.repo, 'add', '.'); git(f.m.paths.repo, 'commit', '-qm', 'child profile');
  f.m.write(join(f.m.paths.stateRoot, 'overrides.json'), '{"version":2,"skills":{"obsolete":false}}');
  await f.m.run(Effect.scoped(Effect.gen(function* () {
    const handle = yield* startAgent(() => f.m.domains, { deferStart: true });
    yield* (yield* FollowedStore).write({ repoUrl: url, profile: 'default', setupId: null });
    const session = yield* makeSession(handle, { domains: () => f.m.domains, signal: new AbortController().signal });
    yield* session.previewChange({ ...change, profile: 'default' });
    const profiles = yield* session.inspectProfiles({ scope });
    assert.deepEqual(profiles.available, [{ name: 'child', extends: 'default' }, { name: 'default', extends: null }, { name: 'small', extends: null }]);
    assert.equal(profiles.followed?.profile, 'default');
  })).pipe(Effect.provide(f.processes)));
});

test('a followed profile missing at Git head is unavailable instead of an empty setup', async t => {
  const f = await fixture(t);
  const source = followedSetupSourceLayer(f.m.paths, { repoUrl: url, profile: 'missing', setupId: null }, { processes: f.processes });
  await f.m.run(Effect.gen(function* () {
    const selected = yield* SetupSource;
    const head = (yield* selected.fetch).head;
    assert.equal((yield* Effect.exit(selected.load(head)))._tag, 'Failure');
  }), source);
});

test('a first hosted follow subscribes before requesting subscriber-only revision metadata', async t => {
  const f = await fixture(t); git(f.m.paths.repo, 'tag', 'v1');
  let subscribed = false;
  const calls: string[] = [];
  const state: HostedState = { accountId: 'account', login: 'owner', machineId: 'machine', auth: 'signed-in', setups: [], machine: null, lastSyncAt: null, retryAt: null, pollAfter: 900, error: null };
  const client: HostedClient = {
    publicSetup: () => Effect.succeed({ ...shared, latestRevision: 1 }),
    subscribe: () => Effect.sync(() => { subscribed = true; calls.push('subscribe'); }), unsubscribe: () => Effect.void,
    listRevisions: () => Effect.suspend(() => {
      calls.push('revisions');
      return subscribed ? Effect.succeed([{ setupId: 'shared', number: 1, commitSha: f.commit, tag: 'v1', changelog: '', requiredEnv: [], items: [], publishedAt: '2026-10-16T12:00:00Z', machineId: 'publisher' }]) : Effect.fail(new HostedFailure({ code: 'not_found' }));
    }),
    state: Effect.succeed(state), recover: () => Effect.succeed(state), sync: () => Effect.succeed(state), revisions: () => Effect.succeed([]),
    signInFlow: Effect.succeed(null), startSignIn: () => Effect.die('unused'), pollSignIn: () => Effect.die('unused'), signOut: () => Effect.void,
    registerSetup: () => Effect.die('unused'), publishRevision: () => Effect.die('unused'), enqueueDecision: () => Effect.void, enqueueMachine: () => Effect.void, reportStatus: () => Effect.void,
  };
  await f.m.run(Effect.scoped(Effect.gen(function* () {
    const runtime = yield* makeHostedRuntime(client, { domains: () => f.m.domains, os: 'macos' });
    const handle = yield* startAgent(() => f.m.domains, { deferStart: true, hosted: runtime });
    const session = yield* makeSession(handle, { domains: () => f.m.domains, signal: new AbortController().signal });
    const preview = yield* session.previewChange({ ...change, setupId: 'shared' });
    assert.equal(calls.length, 0);
    const run = yield* session.runs.submit({ planId: preview.planId, requestId: 'first-subscription', inputDigest: operationDigest(preview.planId), actor: 'app' });
    while (!(yield* session.runs.get(run.runId)).result || (yield* session.running)) yield* Effect.yieldNow;
    assert.equal((yield* session.runs.get(run.runId)).state, 'succeeded');
    assert.equal(calls[0], 'subscribe'); assert.ok(calls.includes('revisions'));
    assert.deepEqual(yield* handle.operationSetupIds!, ['shared']);
    assert.equal((yield* handle.selectOperationSetup!('shared')).source?.profile, 'small');
    assert.equal(f.m.read(join(f.m.paths.claude, 'settings.json')), undefined);
  })).pipe(Effect.provide(f.processes)));
});

test('following another repository previews unresolvable holds for release', async t => {
  const f = await fixture(t);
  await f.m.run(Effect.scoped(Effect.gen(function* () {
    yield* (yield* FollowedStore).write({ repoUrl: 'https://github.com/old/setup.git', profile: 'default', setupId: null });
    yield* (yield* SyncStore).write({ 'skill:old/repo/gone': 'e'.repeat(40), 'setting:claude:settings.json#theme': 'e'.repeat(40) });
    const handle = yield* startAgent(() => f.m.domains, { deferStart: true });
    const session = yield* makeSession(handle, { domains: () => f.m.domains, signal: new AbortController().signal });
    const preview = yield* session.previewChange({ ...change, profile: 'default' });
    assert.ok('droppedChoices' in preview);
    assert.deepEqual(preview.droppedChoices.holds, ['setting:claude:settings.json#theme', 'skill:old/repo/gone']);
    assert.equal((yield* (yield* FollowedStore).read)?.repoUrl, 'https://github.com/old/setup.git');
  })).pipe(Effect.provide(f.processes)));
});


test('listing profiles does not fetch', async t => {
  const f = await fixture(t);
  await f.m.run(Effect.scoped(Effect.gen(function* () {
    const real = yield* startAgent(() => f.m.domains, { deferStart: true });
    yield* prepareProfileOperation(real, change, 0);
    yield* (yield* FollowedStore).write({ repoUrl: url, profile: 'default', setupId: null });
    const handle = { ...real, exclusive: () => Effect.die(new Error('profile listing acquired the mutation lock')) };
    const session = yield* makeSession(handle, { domains: () => f.m.domains, signal: new AbortController().signal });
    f.network.offline = true;
    const profiles = yield* session.inspectProfiles({ scope });
    assert.deepEqual(profiles.available.map(profile => profile.name), ['default', 'small']);
    assert.equal(profiles.followed?.profile, 'default');
  })).pipe(Effect.provide(f.processes)));
});

test('following a different repository starts from no applied baseline and previews dropping its holds', async t => {
  const f = await fixture(t);
  const before = { version: 1, repo: '/previous', files: { 'claude:CLAUDE.md': { hash: 'keep', appliedAt: '2026-10-16T12:00:00Z' } }, applied: { commit: 'e'.repeat(40), at: '2026-10-16T12:00:00Z' }, mcpRouting: { keep: true } };
  f.m.write(join(f.m.paths.stateRoot, 'state.json'), JSON.stringify(before));
  f.m.write(join(f.m.paths.stateRoot, 'overrides.json'), '{"version":2,"settings":{"claude:settings.json":{"theme":"light"}}}');
  await f.m.run(Effect.scoped(Effect.gen(function* () {
    yield* (yield* FollowedStore).write({ repoUrl: 'https://github.com/old/setup.git', profile: 'default', setupId: null });
    // This commit is readable in both clones: repository identity, not reachability, invalidates the hold.
    yield* (yield* SyncStore).write({ 'setting:claude:settings.json#theme': f.commit });
    const handle = yield* startAgent(() => f.m.domains, { deferStart: true });
    const session = yield* makeSession(handle, { domains: () => f.m.domains, signal: new AbortController().signal });
    const preview = yield* session.previewChange({ ...change, profile: 'default' });
    assert.ok('droppedChoices' in preview);
    assert.deepEqual(preview.droppedChoices.holds, ['setting:claude:settings.json#theme']);
    assert.ok(preview.actionEffects.some(effect => /applied baseline/i.test(effect)));
    assert.ok(preview.plan.steps.some(step => /baseline/.test(step.key)));
    assert.equal((yield* (yield* StateStore).read).applied?.commit, before.applied.commit);
    const run = yield* session.runs.submit({ planId: preview.planId, requestId: 'different-repository', inputDigest: operationDigest(preview.planId), actor: 'app' });
    while (!(yield* session.runs.get(run.runId)).result || (yield* session.running)) yield* Effect.yieldNow;
    assert.equal((yield* session.runs.get(run.runId)).state, 'succeeded');
    const { applied: _applied, ...retained } = before;
    assert.deepEqual(yield* (yield* StateStore).read, retained);
    assert.deepEqual(yield* (yield* SyncStore).read, {});
    const saved = readdirSync(f.m.paths.backups, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => readFileSync(join(e.parentPath, e.name), 'utf8'));
    assert.ok(saved.some(text => text === JSON.stringify(before)));
    const review = yield* session.setupReview({ scope, setupId: 'local', refetch: true, limit: 100 });
    assert.ok(review.rows.length > 0);
    assert.ok(review.rows.every(row => row.change === 'added' && row.before === undefined));
    const held = yield* session.previewChange({ kind: 'setupApply', setupId: 'local', revision: review.revision, choices: [{ itemId: 'setting:claude:settings.json#theme', action: 'hold' }] });
    const holdRun = yield* session.runs.submit({ planId: held.planId, requestId: 'hold-new-repository', inputDigest: operationDigest(held.planId), actor: 'app' });
    while (!(yield* session.runs.get(holdRun.runId)).result || (yield* session.running)) yield* Effect.yieldNow;
    assert.equal((yield* session.runs.get(holdRun.runId)).state, 'succeeded');
    assert.equal(f.m.read(join(f.m.paths.claude, 'settings.json')), undefined);
    const nextReview = yield* session.setupReview({ scope, setupId: 'local', refetch: true, limit: 100 });
    assert.equal(nextReview.rows.find(row => row.itemId === 'setting:claude:settings.json#theme')?.held, true);
  })).pipe(Effect.provide(f.processes)));
});

test('a same-repository profile switch preserves its applied baseline', async t => {
  const f = await fixture(t);
  await f.m.run(Effect.scoped(Effect.gen(function* () {
    yield* (yield* FollowedStore).write({ repoUrl: url, profile: 'default', setupId: null });
    const handle = yield* startAgent(() => f.m.domains, { deferStart: true });
    const session = yield* makeSession(handle, { domains: () => f.m.domains, signal: new AbortController().signal });
    const preview = yield* session.previewChange(change);
    assert.equal(preview.plan.steps.some(step => /baseline/.test(step.key)), false);
    const run = yield* session.runs.submit({ planId: preview.planId, requestId: 'same-repository', inputDigest: operationDigest(preview.planId), actor: 'app' });
    while (!(yield* session.runs.get(run.runId)).result || (yield* session.running)) yield* Effect.yieldNow;
    assert.equal((yield* session.runs.get(run.runId)).state, 'succeeded');
    assert.equal((yield* (yield* StateStore).read).applied?.commit, f.commit);
  })).pipe(Effect.provide(f.processes)));
});

test('a failed inspection after following names the saved profile and the failing step', async t => {
  const f = await fixture(t);
  await f.m.run(Effect.scoped(Effect.gen(function* () {
    const real = yield* startAgent(() => f.m.domains, { deferStart: true });
    const handle = { ...real, freshInspection: Effect.fail(new Error('disk full')) };
    const session = yield* makeSession(handle, { domains: () => f.m.domains, signal: new AbortController().signal });
    const preview = yield* session.previewChange(change);
    const run = yield* session.runs.submit({ planId: preview.planId, requestId: 'inspection-failed', inputDigest: operationDigest(preview.planId), actor: 'app' });
    while (!(yield* session.runs.get(run.runId)).result || (yield* session.running)) yield* Effect.yieldNow;
    const result = (yield* session.runs.get(run.runId)).result;
    assert.ok(result && 'message' in result);
    assert.match(result.message, /Now following small; checking for changes failed: disk full.*Reload to retry/);
    assert.equal((yield* (yield* FollowedStore).read)?.profile, 'small');
  })).pipe(Effect.provide(f.processes)));
});

test('a failed subscription after following names the saved profile and preserves the cause', async t => {
  const f = await fixture(t);
  await f.m.run(Effect.scoped(Effect.gen(function* () {
    const real = yield* startAgent(() => f.m.domains, { deferStart: true });
    const handle = { ...real, profileHosted: { ...f.hosted, subscribe: () => Effect.fail(new HostedFailure({ code: 'network' })) } };
    const session = yield* makeSession(handle, { domains: () => f.m.domains, signal: new AbortController().signal });
    const preview = yield* session.previewChange({ ...change, setupId: 'shared' });
    const run = yield* session.runs.submit({ planId: preview.planId, requestId: 'subscribe-failed', inputDigest: operationDigest(preview.planId), actor: 'app' });
    while (!(yield* session.runs.get(run.runId)).result || (yield* session.running)) yield* Effect.yieldNow;
    const result = (yield* session.runs.get(run.runId)).result;
    assert.ok(result && 'message' in result);
    assert.match(result.message, /Now following small; subscribing.*failed: Hosted operation failed \(network\)/);
  })).pipe(Effect.provide(f.processes)));
});

test('switching from a shared link previews stopping its updates before Apply', async t => {
  const f = await fixture(t);
  await f.m.run(Effect.scoped(Effect.gen(function* () {
    yield* (yield* FollowedStore).write({ repoUrl: url, profile: 'default', setupId: 'previous' });
    const real = yield* startAgent(() => f.m.domains, { deferStart: true });
    const handle = { ...real, profileHosted: f.hosted };
    const session = yield* makeSession(handle, { domains: () => f.m.domains, signal: new AbortController().signal });
    for (const setupId of [null, 'shared']) {
      const preview = yield* session.previewChange({ ...change, setupId });
      assert.ok('droppedChoices' in preview);
      assert.ok(preview.plan.steps.some(step => step.key === 'profile:unsubscribe'));
      assert.ok(preview.actionEffects.some(effect => /Stops following updates through the shared link/.test(effect)));
    }
    assert.deepEqual(f.calls, []);
  })).pipe(Effect.provide(f.processes)));
});


test('following a different repository resets a previously used shared-link baseline after backing it up', async t => {
  const f = await fixture(t);
  const repoKey = createHash('sha256').update(JSON.stringify('github.com/example/profiles')).digest('hex');
  const baselinePath = join(f.m.paths.stateRoot, 'agent', 'baselines', 'followed', repoKey, 'shared.json');
  const baseline = { revisionApplied: 1, origins: { 'setting:claude:settings.json#theme': f.commit } };
  f.m.write(baselinePath, JSON.stringify(baseline));
  const source = followedSetupSourceLayer(f.m.paths, { repoUrl: url, profile: 'small', setupId: 'shared' }, { processes: f.processes });
  assert.deepEqual(await f.m.run(SetupSource.use(source => source.baseline!), source), baseline);
  await f.m.run(Effect.scoped(Effect.gen(function* () {
    yield* (yield* FollowedStore).write({ repoUrl: 'https://github.com/old/setup.git', profile: 'default', setupId: null });
    const real = yield* startAgent(() => f.m.domains, { deferStart: true });
    const handle = { ...real, profileHosted: f.hosted, freshInspection: Effect.succeed({ status: { at: '2026-10-16T12:00:00Z', policy: 'notify' as const, paused: null, trusted: true, pending: [], drift: [], conflicts: [], probeErrors: [] } }) };
    const session = yield* makeSession(handle, { domains: () => f.m.domains, signal: new AbortController().signal });
    const preview = yield* session.previewChange({ ...change, setupId: 'shared' });
    const run = yield* session.runs.submit({ planId: preview.planId, requestId: 'different-hosted-repository', inputDigest: operationDigest(preview.planId), actor: 'app' });
    while (!(yield* session.runs.get(run.runId)).result || (yield* session.running)) yield* Effect.yieldNow;
    assert.equal((yield* session.runs.get(run.runId)).state, 'succeeded');
    assert.deepEqual(yield* SetupSource.use(source => source.baseline!).pipe(Effect.provide(source)), { revisionApplied: 0, origins: {} });
    const saved = readdirSync(f.m.paths.backups, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => readFileSync(join(e.parentPath, e.name), 'utf8'));
    assert.ok(saved.includes(JSON.stringify(baseline)));
  })).pipe(Effect.provide(f.processes)));
});
