import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Deferred, Effect, Fiber } from 'effect';
import { migrateFollowed, SetupsStore } from '@nortuscc/sync';
import { liveLockHolder } from '@nortuscc/machine';
import { Processes, type Command } from '@nortuscc/machine';
import { startAgent, makeSession, type AgentSession } from '../src/index.ts';
import { decodeOperationInput, decodeOperationOutput, type OperationName } from '../src/operations/index.ts';
import { decodeRequest } from '../src/ipc/protocol.ts';
import { RunStore, RunStoreError } from '../src/run-store.ts';
import { operationDigest } from '../src/runs.ts';
import { agentMachine } from './support/agent-machine.ts';
import { setupFixture } from './support/setup-fixture.ts';

const repoUrl = 'https://github.com/example/setup.git';
const sshRepoUrl = 'ssh://git@github.com/example/setup.git';
const fixture = async (t: import('node:test').TestContext, intercept?: (command: Command) => Effect.Effect<import('@nortuscc/machine').Completed, import('@nortuscc/machine').LaunchFailed> | undefined, authorClient?: import('@nortuscc/hosted-client').HostedClient, failChallenge = false) => {
  const commands: Command[] = [];
  const m = agentMachine(); t.after(() => rmSync(m.root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
  m.write(join(m.paths.repo, 'profiles/base.json'), '{}\n');
  m.write(join(m.paths.repo, 'profiles/personal.json'), '{"extends":"base"}\n');
  m.write(join(m.paths.repo, 'profiles/team.json'), '{"extends":"base"}\n');
  m.write(join(m.paths.repo, 'claude/CLAUDE.md'), 'old\n');
  git('-C', m.paths.repo, 'add', '.');
  git('-C', m.paths.repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture');
  git('-C', m.paths.repo, 'branch', '-M', 'main');
  const origin = join(m.root, 'origin.git'); git('clone', '--bare', m.paths.repo, origin);
  await m.trust();
  const setup = setupFixture(join(m.root, 'setup'), { headFiles: {} });
  const within = <A,E>(body: (s: AgentSession, handle: import('../src/agent.ts').AgentHandle) => Effect.Effect<A,E>) => m.run(Effect.scoped(Effect.gen(function* () {
    const processes = yield* Processes; const runStore = yield* RunStore;
    return yield* Effect.gen(function* () {
      const domains = () => []; const handle = yield* startAgent(domains, { deferStart: true });
      const session = yield* makeSession({ ...handle, ...(authorClient ? { authorClient } : {}) }, { domains, signal: new AbortController().signal });
      return yield* body(session, handle);
    }).pipe(Effect.provideService(Processes, { run: (c: Command) => {
      commands.push(c);
      const response = intercept?.(c); if (response) return response;
      if (c.cmd === 'gh') return Effect.succeed({ code: 0, stdout: c.args[0] === 'api' ? '{"login":"fixture","id":42}' : '' });
      assert.equal(c.cmd, 'git');
      const transport = c.args.some(a => ['clone', 'fetch', 'push', 'ls-remote'].includes(a));
      return processes.run({ ...c, args: transport ? [...[repoUrl, sshRepoUrl, 'ssh://github.com/example/setup.git'].flatMap(url => ['-c', `url.${origin}.insteadOf=${url}`]), ...c.args] : c.args });
    } }), Effect.provideService(RunStore, { ...runStore, write: receipt => failChallenge && receipt.view.ghCode ? Effect.fail(new RunStoreError('Challenge storage failed')) : runStore.write(receipt) }));
  })), setup.source);
  return { m, within, git, origin, commands };
};
const read = (s: AgentSession, name: string, input = {}) =>
  (s as unknown as Record<string, (input: unknown) => Effect.Effect<unknown>>)[name]!(decodeOperationInput(name as OperationName, input));
const apply = (s: AgentSession, planId: string, requestId: string) => Effect.gen(function* () {
  const accepted = yield* s.runs.submit({ planId, requestId, inputDigest: operationDigest(planId), actor: 'mcp' });
  yield* Effect.callback<void>(resume => { const off = s.runs.subscribe(accepted.runId, run => { if (run.result) resume(Effect.void); }); return Effect.sync(off); });
  while (yield* s.running) yield* Effect.yieldNow;
  return yield* s.runs.get(accepted.runId);
});

test('editDraft creates a draft and previewChange shows the replayed diff', async t => {
  const f = await fixture(t);
  await f.within(s => Effect.gen(function* () {
    const p = yield* s.previewChange({ kind: 'editDraft', draftId: null, intent: { kind: 'captureFile', profile: 'base', fileId: 'claude:CLAUDE.md', text: 'new\n', choice: { kind: 'updateShared' } } } as any);
    assert.ok('draft' in p); assert.deepEqual((p as any).draft.affectedProfiles, ['base', 'personal', 'team']);
    assert.ok((p as any).draft.diff.some((d: any) => d.path === 'claude/CLAUDE.md' && d.after === 'new\n'));
    assert.equal(((yield* read(s, 'drafts')) as any).drafts.length, 0);
    const run = yield* apply(s, p.planId, 'save-draft'); assert.equal(run.state, 'succeeded');
    assert.throws(() => decodeOperationOutput('getRun', { ...run, intent: { ...run.intent, parity: { ...run.intent.parity, kind: 'ghLogin' } } }));
    assert.throws(() => decodeOperationOutput('getRun', { ...run, parity: { ...run.parity, kind: 'ghLogin' } }));
    const drafts = ((yield* read(s, 'drafts')) as any).drafts; assert.equal(drafts.length, 1);
    const preview = yield* read(s, 'draftPreview', { draftId: drafts[0].id });
    assert.deepEqual((preview as any).affectedProfiles, ['base', 'personal', 'team']);
    assert.equal(f.m.read(join(f.m.paths.repo, 'claude/CLAUDE.md')), 'old\n');
  }));
});

test('source inputs refuse credentials and non-Git modes at IPC decode', () => {
  for (const source of ['https://user:secret@github.com/o/r.git', 'http://github.com/o/r', 'git@github.com:o/r', '/tmp/repo', 'file:///tmp/repo', 'https://github.com/o/r?x=y', 'https://github.com/o/r#main', 'https://github.com/o/r/tree/main', 'owner/repo\n', '--yes/x', '-owner/repo', 'owner/-repo']) {
    for (const input of [{ operation: 'discoverUpstream', input: { source } }, { operation: 'previewChange', input: { change: { kind: 'editDraft', draftId: null, intent: { kind: 'pin', source, commit: 'a'.repeat(40) } } } }])
      assert.throws(() => decodeRequest({ version: 3, id: 'x', command: 'operation', ...input }), source);
  }
  for (const source of ['owner/repo', 'Owner-1/repo.name', 'https://github.com/owner/repo', 'https://git.example.test/group/repo.git', 'https://git.example.test/repo.git', 'https://git.example.test/group/repo@name.git', 'HTTPS://git.example.test/repo.git'])
    assert.equal((decodeOperationInput('discoverUpstream' as OperationName, { source }) as any).source, source);
});

test('app and mcp clients can no longer write the author checkout directly', async t => {
  const f = await fixture(t); const index = readFileSync(join(f.m.paths.repo, '.git/index'));
  await f.within(s => Effect.gen(function* () {
    for (const change of [{ kind: 'capture', only: [], takeLocal: true, allowShrink: false }, { kind: 'sourceDecision', sourceId: 'owner/repo', action: 'unpin' }, { kind: 'update', only: [], authorManifest: true }]) {
      const error = yield* Effect.flip(s.previewChange(change as any)); assert.equal(error.code, 'INVALID_REQUEST');
    }
  }));
  assert.deepEqual(readFileSync(join(f.m.paths.repo, '.git/index')), index);
});

test('corrupt drafts remain visible and deletable through shared operations', async t => {
  const f = await fixture(t); const id = '00000000-0000-4000-8000-000000000001';
  f.m.write(join(f.m.paths.stateRoot, 'agent/author/drafts', id + '.json'), '{');
  await f.within(s => Effect.gen(function* () {
    const listed = (yield* read(s, 'drafts')) as any; assert.equal(listed.drafts[0].id, id); assert.equal(typeof listed.drafts[0].error, 'string');
    const p = yield* s.previewChange({ kind: 'deleteDraft', draftId: id } as any);
    assert.equal((yield* apply(s, p.planId, 'delete-corrupt')).state, 'succeeded');
    assert.deepEqual(yield* read(s, 'drafts'), { drafts: [] });
  }));
});

test('author reads resolve inheritance and own-copy drafts change only the chosen profile', async t => {
  const f = await fixture(t);
  await f.within(s => Effect.gen(function* () {
    const profiles = (yield* read(s, 'authorProfiles')) as any;
    assert.equal(profiles.repoUrl, repoUrl); assert.equal(profiles.profiles.find((p: any) => p.name === 'personal').extends, 'base');
    assert.deepEqual(yield* read(s, 'authorFile', { profile: 'personal', fileId: 'claude:CLAUDE.md' }), { path: 'claude/CLAUDE.md', text: 'old\n', truncated: false });
    assert.deepEqual(yield* read(s, 'ghState'), { state: 'ready' });
    assert.deepEqual(yield* read(s, 'upstreams'), { sources: [] });
    const p = yield* s.previewChange({ kind: 'editDraft', draftId: null, intent: { kind: 'captureFile', profile: 'personal', fileId: 'claude:CLAUDE.md', text: 'private copy\n', choice: { kind: 'ownCopy', repoPath: 'claude/personal.md' } } } as any);
    assert.deepEqual((p as any).draft.affectedProfiles, ['personal']);
    yield* apply(s, p.planId, 'own-copy');
    const id = (p as any).draftId;
    const removed = yield* s.previewChange({ kind: 'removeDraftIntent', draftId: id, index: 0 } as any);
    yield* apply(s, removed.planId, 'remove-intent');
    assert.deepEqual(((yield* read(s, 'drafts')) as any).drafts[0].intents, []);
    const deleted = yield* s.previewChange({ kind: 'deleteDraft', draftId: id } as any);
    yield* apply(s, deleted.planId, 'delete-draft');
    const backups = readdirSync(f.m.paths.backups).flatMap(dir => {
      try { return [readFileSync(join(f.m.paths.backups, dir, 'agent/author/drafts', id + '.json'), 'utf8')]; } catch { return []; }
    });
    assert.ok(backups.some(text => JSON.parse(text).intents.length === 1));
    assert.ok(backups.some(text => JSON.parse(text).intents.length === 0));
  }));
});

test('a retained draft edit refuses a newer saved draft without overwriting it', async t => {
  const f = await fixture(t);
  await f.within(s => Effect.gen(function* () {
    const p = yield* s.previewChange({ kind: 'editDraft', draftId: null, intent: { kind: 'createProfile', profile: 'new', extends: null } } as any);
    const id = (p as any).draftId;
    f.m.write(join(f.m.paths.stateRoot, 'agent/author/drafts', id + '.json'), 'newer draft');
    const error = yield* Effect.flip(s.runs.submit({ planId: p.planId, requestId: 'stale', inputDigest: operationDigest(p.planId), actor: 'app' }));
    assert.equal(error.code, 'UNKNOWN_PLAN');
    assert.equal(f.m.read(join(f.m.paths.stateRoot, 'agent/author/drafts', id + '.json')), 'newer draft');
  }));
});

test('ghLogin exposes its code while pending and clears it when the process ends', async t => {
  let finish!: () => void;
  let ready!: () => void; const challenged = new Promise<void>(resolve => { ready = resolve; });
  const f = await fixture(t, command => command.cmd === 'gh' && command.args[1] === 'login' ? Effect.callback(resume => {
    command.onOutput?.('stderr', 'First copy your one-time code: ABCD-1234\n'); ready();
    finish = () => resume(Effect.succeed({ code: 0, stdout: '' }));
  }) : undefined);
  await f.within(s => Effect.gen(function* () {
    const p = yield* s.previewChange({ kind: 'ghLogin' } as any);
    const accepted = yield* s.runs.submit({ planId: p.planId, requestId: 'login', inputDigest: operationDigest(p.planId), actor: 'mcp' });
    yield* Effect.promise(() => challenged);
    let run = yield* s.runs.get(accepted.runId);
    for (let i = 0; i < 100 && !run.ghCode; i++) { yield* Effect.yieldNow; run = yield* s.runs.get(accepted.runId); }
    assert.deepEqual(run.ghCode, { code: 'ABCD-1234', url: 'https://github.com/login/device' });
    finish();
    yield* Effect.callback<void>(resume => { const off = s.runs.subscribe(accepted.runId, run => { if (run.result) resume(Effect.void); }); return Effect.sync(off); });
    assert.equal((yield* s.runs.get(accepted.runId)).ghCode, null);
  }));
});

test('publish and announce route through durable shared changes and expose recovery', async t => {
  const { HostedFailure } = await import('@nortuscc/hosted-client');
  const state = { accountId: null, setups: [] };
  const client = { state: Effect.succeed(state), sync: () => Effect.fail(new HostedFailure({ code: 'unauthenticated' })) } as unknown as import('@nortuscc/hosted-client').HostedClient;
  const f = await fixture(t, undefined, client);
  await f.within(s => Effect.gen(function* () {
    const edit = yield* s.previewChange({ kind: 'editDraft', draftId: null, intent: { kind: 'captureFile', profile: 'base', fileId: 'claude:CLAUDE.md', text: 'published\n', choice: { kind: 'updateShared' } } } as any);
    yield* apply(s, edit.planId, 'publish-edit');
    const preview = (yield* read(s, 'draftPreview', { draftId: (edit as any).draftId })) as any;
    const p = yield* s.previewChange({ kind: 'publishDraft', draftId: preview.draftId, digest: preview.digest });
    const run = yield* apply(s, p.planId, 'publish');
    assert.equal(run.state, 'succeeded'); assert.equal(run.publication?.pushed, true);
    assert.deepEqual((yield* s.runs.get(run.runId)).publicationRecovery, { published: true, action: 'announce' });
    const commandCount = f.commands.length;
    const listed = yield* s.runs.list({ limit: 10 }); assert.ok(listed.runs.some(r => r.runId === run.runId));
    assert.equal(f.commands.length, commandCount, 'listing run receipts does not fetch each publication');
    const announce = yield* s.previewChange({ kind: 'announcePublication', runId: run.runId });
    assert.equal((yield* apply(s, announce.planId, 'announce')).state, 'succeeded');
  }));
});

test('a capture at the frozen-text byte limit can be saved in a durable draft run', async t => {
  const f = await fixture(t);
  await f.within(s => Effect.gen(function* () {
    const p = yield* s.previewChange({ kind: 'editDraft', draftId: null, intent: { kind: 'captureFile', profile: 'base', fileId: 'claude:CLAUDE.md', text: 'a'.repeat(262_144), choice: { kind: 'updateShared' } } } as any);
    assert.equal((yield* apply(s, p.planId, 'large-capture')).state, 'succeeded');
  }));
});

test('upstream discovery and immutable skill reads use machine-owned directories and keep browsing local', async t => {
  const transcript = readFileSync(new URL('../../source-watch/checks/fixtures/skills-list/singular.txt', import.meta.url), 'utf8');
  const sha = 'a'.repeat(40); const calls: Command[] = [];
  const f = await fixture(t, command => {
    calls.push(command);
    if (command.cmd === 'npx') return Effect.succeed({ code: 0, stdout: transcript });
    if (command.cmd !== 'git') return undefined;
    if (command.args.includes('ls-remote')) return Effect.succeed({ code: 0, stdout: `${sha}\tHEAD\n` });
    const args = command.args; const op = args.find(a => ['fetch','init','rev-parse','ls-tree','cat-file'].includes(a));
    if (command.cwd?.includes('skill-contents')) {
      if (op === 'fetch') return Effect.succeed({ code: 0, stdout: '' });
      if (op === 'rev-parse') return Effect.succeed({ code: 0, stdout: sha });
      if (op === 'ls-tree') return Effect.succeed({ code: 0, stdout: `100644 blob ${sha}\tskills/first/SKILL.md\0` });
      if (op === 'cat-file') return Effect.succeed({ code: 0, stdout: args.includes('-s') ? '50' : '---\nname: first\n---\n# First\n' });
    }
    return undefined;
  });
  await f.within(s => Effect.gen(function* () {
    const discovery = yield* read(s, 'discoverUpstream', { source: 'owner/repo' });
    assert.deepEqual(discovery, { kind: 'complete', source: 'owner/repo', commit: sha, skills: [{ name: 'first', description: 'First description.' }] });
    const upstreams = (yield* read(s, 'upstreams')) as any;
    assert.deepEqual(upstreams.sources, [{ source: 'owner/repo', inProfiles: [], pin: null, discovery }]);
    const skill = (yield* read(s, 'upstreamSkill', { source: 'owner/repo', commit: sha, name: 'first' })) as any;
    assert.equal(skill.text, '---\nname: first\n---\n# First\n'); assert.deepEqual(skill.files, ['SKILL.md']);
    assert.equal(f.m.read(join(f.m.paths.repo, 'skills-manifest.txt')), undefined);
    assert.ok(calls.find(c => c.cmd === 'npx')?.cwd?.startsWith(join(f.m.paths.stateRoot, 'agent/author/discovery')));
    assert.ok(calls.some(c => c.args.includes('init') && c.args.some(a => a.startsWith(join(f.m.paths.stateRoot, 'agent/author/cache')))));
  }));
});

test('cancelling GitHub login stops the pending process and clears its challenge', async t => {
  let release!: () => void; let stopped = false; let ready!: () => void;
  const challenged = new Promise<void>(resolve => { ready = resolve; });
  const f = await fixture(t, command => command.cmd === 'gh' && command.args[1] === 'login' ? Effect.callback(resume => {
    command.onOutput?.('stderr', 'First copy your one-time code: ABCD-1234\n'); ready();
    release = () => resume(Effect.succeed({ code: 0, stdout: '' }));
    return Effect.sync(() => { stopped = true; });
  }) : undefined);
  await f.within(s => Effect.gen(function* () {
    const p = yield* s.previewChange({ kind: 'ghLogin' } as any);
    const accepted = yield* s.runs.submit({ planId: p.planId, requestId: 'cancel-login', inputDigest: operationDigest(p.planId), actor: 'app' });
    yield* Effect.promise(() => challenged);
    const cancelled = yield* s.runs.cancel(accepted.runId).pipe(Effect.timeoutOption(500));
    release();
    assert.equal(cancelled._tag, 'Some'); assert.equal(stopped, true);
    const run = yield* s.runs.get(accepted.runId); assert.equal(run.state, 'cancelled'); assert.equal(run.ghCode, null);
  }));
});

test('source pin and ignore choices save draft intents across all profiles without editing checkout policy', async t => {
  const f = await fixture(t);
  f.m.write(join(f.m.paths.repo, 'skills-manifest.txt'), '[owner/repo]\none\n');
  f.git('-C', f.m.paths.repo, 'add', '.');
  f.git('-C', f.m.paths.repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'source fixture');
  f.git('-C', f.m.paths.repo, 'push', f.origin, 'main');
  await f.within(s => Effect.gen(function* () {
    const upstreams = (yield* read(s, 'upstreams')) as any;
    assert.deepEqual(upstreams.sources, [{ source: 'owner/repo', inProfiles: ['base', 'personal', 'team'], pin: null, discovery: null }]);
    let id: string | null = null;
    for (const intent of [{ kind: 'pin', source: 'owner/repo', commit: 'a'.repeat(40) }, { kind: 'ignore', source: 'owner/repo', revision: 'a'.repeat(40) }, { kind: 'unpin', source: 'owner/repo' }, { kind: 'unignore', source: 'owner/repo', revision: 'a'.repeat(40) }]) {
      const p: import('../src/operations/index.ts').ChangePreview = yield* s.previewChange({ kind: 'editDraft', draftId: id, intent } as any);
      id = (p as any).draftId; yield* apply(s, p.planId, intent.kind);
    }
    assert.equal(f.m.read(join(f.m.paths.repo, 'skill-pins.json')), undefined);
    assert.equal(f.m.read(join(f.m.paths.repo, 'source-ignores.json')), undefined);
    assert.equal(((yield* read(s, 'drafts')) as any).drafts[0].intents.length, 4);
  }));
});

test('a corrupt draft can be deleted when the configured repository is untrusted', async t => {
  const { SetupsStore } = await import('@nortuscc/sync');
  const f = await fixture(t); const id = '00000000-0000-4000-8000-000000000002';
  await f.m.run(SetupsStore.use(store => store.write([])));
  f.m.write(join(f.m.paths.stateRoot, 'agent/author/drafts', id + '.json'), '{');
  await f.within(s => Effect.gen(function* () {
    const p = yield* s.previewChange({ kind: 'deleteDraft', draftId: id } as any);
    assert.equal((yield* apply(s, p.planId, 'delete-untrusted')).state, 'succeeded');
    assert.deepEqual(yield* read(s, 'drafts'), { drafts: [] });
  }));
});

test('author wire schemas decode captured text without Node globals', () => {
  const buffer = globalThis.Buffer;
  try {
    Reflect.deleteProperty(globalThis, 'Buffer');
    const input = decodeOperationInput('previewChange', { change: { kind: 'editDraft', draftId: null, intent: { kind: 'captureFile', profile: 'base', fileId: 'claude:CLAUDE.md', text: 'browser text', choice: { kind: 'updateShared' } } } });
    assert.equal(input.change.kind, 'editDraft');
  } finally { globalThis.Buffer = buffer; }
});

test('a failed GitHub challenge checkpoint settles the run without an unhandled rejection', async t => {
  const f = await fixture(t, command => command.cmd === 'gh' && command.args[1] === 'login' ? Effect.sync(() => {
    command.onOutput?.('stderr', 'First copy your one-time code: ABCD-1234\n');
  }).pipe(Effect.andThen(Effect.sleep(50)), Effect.as({ code: 0, stdout: '' })) : undefined, undefined, true);
  await f.within(s => Effect.gen(function* () {
    const p = yield* s.previewChange({ kind: 'ghLogin' } as any);
    const run = yield* apply(s, p.planId, 'login-storage-failure');
    assert.equal(run.state, 'failed'); assert.equal(run.ghCode, null);
  }));
});

test('Git publication remains available without a hosted connection and retains pending announcements', async t => {
  const f = await fixture(t);
  await f.within(s => Effect.gen(function* () {
    const edit = yield* s.previewChange({ kind: 'editDraft', draftId: null, intent: { kind: 'captureFile', profile: 'base', fileId: 'claude:CLAUDE.md', text: 'offline publication\n', choice: { kind: 'updateShared' } } } as any);
    yield* apply(s, edit.planId, 'offline-edit');
    const draft = (yield* read(s, 'draftPreview', { draftId: (edit as any).draftId })) as any;
    const p = yield* s.previewChange({ kind: 'publishDraft', draftId: draft.draftId, digest: draft.digest });
    const run = yield* apply(s, p.planId, 'offline-publish');
    assert.equal(run.publication?.pushed, true); assert.deepEqual(run.publication?.pending, ['base', 'personal', 'team']);
    assert.equal(run.state, 'succeeded');
  }));
});

test('author repository reads distinguish missing gh, signed out, denied access and unavailable authentication', async t => {
  const { LaunchFailed } = await import('@nortuscc/machine');
  for (const [state, code] of [['missing', 'APP_UNAVAILABLE'], ['signed-out', 'NOT_SIGNED_IN'], ['ready', 'UNAUTHORIZED'], ['error', 'INTERNAL']] as const) {
    const f = await fixture(t, command => {
      if (command.cmd === 'git' && command.args.includes('clone')) return Effect.succeed({ code: 128, stdout: '', stderr: 'repository not found' });
      if (command.cmd !== 'gh') return undefined;
      if (state === 'missing') return Effect.fail(new LaunchFailed({ cmd: 'gh', reason: 'ENOENT' }));
      return Effect.succeed({ code: command.args[0] === '--version' || state === 'ready' ? 0 : state === 'signed-out' ? 1 : 2, stdout: '' });
    });
    await f.within(s => Effect.gen(function* () {
      const error = yield* Effect.flip(s.authorProfiles(decodeOperationInput('authorProfiles', {})));
      assert.equal(error.code, code, state);
      if (state === 'ready') assert.equal(error.message, `No access to ${repoUrl}`);
    }));
  }
});

const pendingLogin = async (t: import('node:test').TestContext) => {
  let release = () => {}; let ready = () => {};
  const challenged = new Promise<void>(resolve => { ready = resolve; });
  const f = await fixture(t, command => command.cmd === 'gh' && command.args[1] === 'login' ? Effect.callback(resume => {
    release = () => resume(Effect.succeed({ code: 0, stdout: '' }));
    command.onOutput?.('stderr', 'First copy your one-time code: ABCD-1234\n'); ready();
  }) : undefined);
  const start = (s: AgentSession) => Effect.gen(function* () {
    const p = yield* s.previewChange({ kind: 'ghLogin' });
    const accepted = yield* s.runs.submit({ planId: p.planId, requestId: 'pending-login', inputDigest: operationDigest(p.planId), actor: 'app' });
    yield* Effect.promise(() => challenged);
    return accepted;
  });
  return { ...f, start, release: () => release() };
};

test('author reads complete while a GitHub sign-in is pending', async t => {
  const f = await pendingLogin(t);
  await f.within((s, handle) => Effect.gen(function* () {
    const edit = yield* s.previewChange({ kind: 'editDraft', draftId: null, intent: { kind: 'createProfile', profile: 'extra', extends: 'base' } });
    yield* apply(s, edit.planId, 'read-draft');
    const draft = yield* s.draftPreview(decodeOperationInput('draftPreview', { draftId: (edit as any).draftId }));
    const publish = yield* s.previewChange({ kind: 'publishDraft', draftId: draft.draftId, digest: draft.digest });
    const publication = yield* apply(s, publish.planId, 'read-publication');
    yield* f.start(s);
    const reads = Effect.all([
      read(s, 'ghState'), read(s, 'drafts'), read(s, 'authorProfiles'),
      read(s, 'authorFile', { profile: 'base', fileId: 'claude:CLAUDE.md' }),
      read(s, 'upstreams'), read(s, 'draftPreview', { draftId: draft.draftId }), s.runs.get(publication.runId),
      handle.exclusive(Effect.succeed('scheduled job')),
    ], { concurrency: 'unbounded' });
    const completed = yield* reads.pipe(Effect.timeoutOption(2000));
    assert.equal(completed._tag, 'Some');
  }).pipe(Effect.ensuring(Effect.sync(f.release))));
});

test('a machine apply is not blocked by a pending GitHub sign-in', async t => {
  const f = await pendingLogin(t);
  await f.within(s => Effect.gen(function* () {
    yield* s.inspect('app');
    yield* f.start(s);
    assert.equal(liveLockHolder(join(f.m.paths.stateRoot, 'apply.lock')), undefined);
    const preview = yield* s.previewChange({ kind: 'reconcile', only: [] });
    const completed = yield* apply(s, preview.planId, 'during-login').pipe(Effect.timeoutOption(2000));
    assert.equal(completed._tag, 'Some');
    if (completed._tag === 'Some') assert.equal(completed.value.state, 'succeeded');
  }).pipe(Effect.ensuring(Effect.sync(f.release))));
});

test('a second sign-in is refused while one is pending', async t => {
  const f = await pendingLogin(t);
  await f.within(s => Effect.gen(function* () {
    const second = yield* s.previewChange({ kind: 'ghLogin' });
    yield* f.start(s);
    const refused = yield* Effect.flip(s.runs.submit({ planId: second.planId, requestId: 'second-login', inputDigest: operationDigest(second.planId), actor: 'app' }));
    assert.equal(refused.code, 'BUSY');
  }).pipe(Effect.ensuring(Effect.sync(f.release))));
});

test('author browsing returns valid profiles and issues for invalid profiles', async t => {
  const f = await fixture(t);
  f.m.write(join(f.m.paths.repo, 'skills-manifest.txt'), '[owner/repo]\none\n');
  f.m.write(join(f.m.paths.repo, 'profiles/broken.json'), '{');
  f.m.write(join(f.m.paths.repo, 'profiles/missing.json'), '{"extends":"absent"}');
  f.git('-C', f.m.paths.repo, 'add', '.');
  f.git('-C', f.m.paths.repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'invalid profiles');
  f.git('-C', f.m.paths.repo, 'push', f.origin, 'main');
  await f.within(s => Effect.gen(function* () {
    const profiles = yield* s.authorProfiles(decodeOperationInput('authorProfiles', {}));
    assert.deepEqual(profiles.profiles.map(p => p.name), ['base', 'personal', 'team']);
    assert.deepEqual(profiles.issues!.map(p => p.profile), ['broken', 'missing']);
    assert.ok(profiles.issues!.every(p => p.issues.length > 0));
    const file = yield* s.authorFile(decodeOperationInput('authorFile', { profile: 'base', fileId: 'claude:CLAUDE.md' }));
    assert.equal(file.text, 'old\n'); assert.deepEqual(file.issues, profiles.issues);
    const broken = yield* s.authorFile(decodeOperationInput('authorFile', { profile: 'broken', fileId: 'claude:CLAUDE.md' }));
    assert.equal(broken.path, null); assert.deepEqual(broken.issues, profiles.issues);
    const upstreams = yield* s.upstreams(decodeOperationInput('upstreams', {}));
    assert.deepEqual(upstreams.sources[0]!.inProfiles, ['base', 'personal', 'team']);
    assert.deepEqual(upstreams.issues, profiles.issues);
  }));
});

test('author reads complete while the scheduler job permit is held', async t => {
  const f = await fixture(t);
  await f.within((s, handle) => Effect.gen(function* () {
    const held = yield* Deferred.make<void>();
    const job = yield* Effect.forkChild(handle.exclusive(Deferred.succeed(held, undefined).pipe(Effect.andThen(Effect.never))));
    yield* Deferred.await(held);
    const completed = yield* Effect.all([read(s, 'ghState'), read(s, 'drafts'), read(s, 'authorProfiles')], { concurrency: 'unbounded' })
      .pipe(Effect.timeoutOption(2000), Effect.ensuring(Fiber.interrupt(job)));
    assert.equal(completed._tag, 'Some');
  }));
});

test('machine file read returns current text', async t => {
  const f = await fixture(t); f.m.write(join(f.m.paths.claude, 'CLAUDE.md'), '\uFEFFcurrent machine text é\n');
  await f.within(s => Effect.gen(function* () {
    assert.deepEqual(yield* read(s, 'machineFile', { fileId: 'claude:CLAUDE.md' }), { fileId: 'claude:CLAUDE.md', exists: true, text: '\uFEFFcurrent machine text é\n', truncated: false });
    assert.deepEqual(yield* read(s, 'machineFile', { fileId: 'codex:AGENTS.md' }), { fileId: 'codex:AGENTS.md', exists: false, text: '', truncated: false });
  }));
  for (const fileId of ['codex:config.toml', 'codex:models-static.json', '../secret'])
    assert.throws(() => decodeRequest({ version: 3, id: 'read', command: 'operation', operation: 'machineFile', input: { fileId } }));
});
test('oversized machine file is reported truncated and cannot be captured', async t => {
  const f = await fixture(t); f.m.write(join(f.m.paths.claude, 'CLAUDE.md'), 'x'.repeat(262_145));
  await f.within(s => Effect.gen(function* () {
    const value = (yield* read(s, 'machineFile', { fileId: 'claude:CLAUDE.md' })) as { text: string; truncated: boolean };
    assert.equal(value.truncated, true); assert.equal(Buffer.byteLength(value.text), 262_144);
    assert.throws(() => decodeOperationInput('previewChange', { change: { kind: 'editDraft', draftId: null, intent: { kind: 'captureFile', profile: 'base', fileId: 'claude:CLAUDE.md', text: 'x'.repeat(262_145), choice: {kind:'updateShared'} } } }));
  }));
});


test('author operations use the migrated followed repository through a real agent session', async t => {
  const f = await fixture(t);
  await f.m.run(SetupsStore.use(store => store.write([{ setupId: 'hosted-setup', repoUrl, checkout: f.m.paths.repo, trustedAt: '2026-10-06T00:00:00.000Z' }])));
  const followed = await f.m.run(migrateFollowed(f.m.paths));
  assert.equal(followed?.setupId, 'hosted-setup');
  f.git('-C', f.m.paths.repo, 'remote', 'set-url', 'origin', 'https://github.com/unrelated/checkout');
  await f.within(s => Effect.gen(function* () {
    const profiles = (yield* read(s, 'authorProfiles')) as any;
    assert.equal(profiles.repoUrl, repoUrl);
    assert.deepEqual(profiles.profiles.map((p: any) => p.name), ['base', 'personal', 'team']);
    assert.deepEqual(yield* read(s, 'upstreams'), { sources: [] });
    const preview = yield* s.previewChange({ kind: 'editDraft', draftId: null, intent: { kind: 'createProfile', profile: 'new', extends: 'base' } } as any);
    assert.equal((yield* apply(s, preview.planId, 'followed-edit')).state, 'succeeded');
    assert.equal(((yield* read(s, 'drafts')) as any).drafts[0].repoUrl, repoUrl);
  }));
});

test('author repository credentials are removed before drafts and receipts are stored', async t => {
  const f = await fixture(t);
  f.git('-C', f.m.paths.repo, 'remote', 'set-url', 'origin', 'https://user:secret@github.com/example/setup.git');
  await f.within(s => Effect.gen(function* () {
    const preview = yield* s.previewChange({ kind: 'editDraft', draftId: null, intent: { kind: 'createProfile', profile: 'new', extends: 'base' } } as any);
    const run = yield* apply(s, preview.planId, 'credential-free-edit');
    assert.equal(run.state, 'succeeded');
    const drafts = (yield* read(s, 'drafts')) as any;
    assert.equal(drafts.drafts[0].repoUrl, repoUrl);
    assert.ok(!JSON.stringify(run).includes('secret'));
  }));
});

test('author operations ask to follow a setup when no repository origin exists', async t => {
  const f = await fixture(t);
  f.git('-C', f.m.paths.repo, 'remote', 'remove', 'origin');
  await f.within(s => Effect.gen(function* () {
    const error = yield* Effect.flip(read(s, 'authorProfiles'));
    assert.equal((error as any).message, 'Follow your setup repository first');
  }));
});


test('machineFile never returns non-owned settings keys', async t => {
  const f = await fixture(t);
  f.git('-C', f.m.paths.repo, 'pull', '--ff-only', f.origin, 'main');
  f.m.write(join(f.m.paths.repo, 'claude/settings.keys.json'), '{"model":"old","alwaysThinkingEnabled":false}');
  f.git('-C', f.m.paths.repo, 'add', '.');
  f.git('-C', f.m.paths.repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'owned settings');
  f.git('-C', f.m.paths.repo, 'push', f.origin, 'main');
  f.m.write(join(f.m.paths.claude, 'settings.json'), JSON.stringify({ model: 'new', alwaysThinkingEnabled: true, permissions: { allow: ['Bash(*)'] }, enabledPlugins: { private: true }, env: { TOKEN: 'secret' }, hooks: { Stop: '/Users/private/hook' } }));
  await f.within(s => Effect.gen(function* () {
    const file = (yield* read(s, 'machineFile', { fileId: 'claude:settings.json' })) as any;
    assert.equal(file.exists, true);
    assert.deepEqual(JSON.parse(file.text), { model: 'new', alwaysThinkingEnabled: true });
    assert.equal(file.truncated, false);
  }));
});


test('machine settings capture uses the selected profile allowlist', async t => {
  const f = await fixture(t);
  f.m.write(join(f.m.paths.repo, 'claude/settings.keys.json'), '{"model":"old"}');
  f.m.write(join(f.m.paths.repo, 'profiles/personal.json'), '{"extends":"base","files":{"claude:settings.json":"claude/personal-settings.json"}}');
  f.m.write(join(f.m.paths.repo, 'claude/personal-settings.json'), '{"alwaysThinkingEnabled":false}');
  f.git('-C', f.m.paths.repo, 'add', '.');
  f.git('-C', f.m.paths.repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'profile settings');
  f.git('-C', f.m.paths.repo, 'push', f.origin, 'main');
  f.m.write(join(f.m.paths.claude, 'settings.json'), '{"model":"new","alwaysThinkingEnabled":true,"env":{"TOKEN":"secret"}}');
  await f.within(s => Effect.gen(function* () {
    const file = (yield* read(s, 'machineFile', { fileId: 'claude:settings.json', profile: 'personal' })) as any;
    assert.deepEqual(JSON.parse(file.text), { alwaysThinkingEnabled: true });
  }));
});


test('author profiles expose only the signed-in owners matching setup IDs', async t => {
  let accountId: string | null = 'owner';
  const setups = [
    { setupId: 'personal-setup', repoUrl: 'git@github.com:Example/Setup.git', profile: 'personal', owned: true, latestRevision: 1 },
    { setupId: 'not-owned', repoUrl, profile: 'team', owned: false, latestRevision: 1 },
    { setupId: 'other-repo', repoUrl: 'https://github.com/elsewhere/config', profile: 'base', owned: true, latestRevision: 1 },
  ];
  const client = { state: Effect.sync(() => ({ accountId, setups })) } as unknown as import('@nortuscc/hosted-client').HostedClient;
  const f = await fixture(t, undefined, client);
  await f.within(s => Effect.gen(function* () {
    const result = yield* s.authorProfiles(decodeOperationInput('authorProfiles', {}));
    assert.deepEqual(result.profiles.map(p => [p.name, (p as any).setupId]), [['base', null], ['personal', 'personal-setup'], ['team', null]]);
    accountId = null;
    const signedOut = yield* s.authorProfiles(decodeOperationInput('authorProfiles', {}));
    assert.ok(signedOut.profiles.every(p => (p as any).setupId === null));
  }));
});


test('author operations ask to follow a setup when the CLI checkout is absent', async t => {
  const f = await fixture(t); rmSync(f.m.paths.repo, { recursive: true });
  await f.within(s => Effect.gen(function* () {
    const error = yield* Effect.flip(read(s, 'authorProfiles'));
    assert.equal((error as any).message, 'Follow your setup repository first');
  }));
});


test('authoring preserves the public SSH login name while removing URL passwords', async t => {
  const f = await fixture(t);
  f.git('-C', f.m.paths.repo, 'remote', 'set-url', 'origin', 'ssh://git:secret@github.com/example/setup.git');
  await f.within(s => Effect.gen(function* () {
    const profiles = yield* s.authorProfiles(decodeOperationInput('authorProfiles', {}));
    assert.equal(profiles.repoUrl, sshRepoUrl);
    const preview = yield* s.previewChange({ kind: 'editDraft', draftId: null, intent: { kind: 'createProfile', profile: 'new', extends: 'base' } } as any);
    const run = yield* apply(s, preview.planId, 'ssh-edit');
    assert.equal(run.state, 'succeeded');
    assert.equal(((yield* read(s, 'drafts')) as any).drafts[0].repoUrl, sshRepoUrl);
  }));
});
