import { createHash } from 'node:crypto';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Cause, Deferred, Effect, Exit, Fiber, Semaphore } from 'effect';
import { loadProfile, nodeFiles } from '@nortuscc/profile-engine';
import { DialogueCleanupFailed, Fs, FsFailed, HistoryStore, OverridesStore, Processes, inspectSkills, skillsDomain, verifyAcceptedSkill, SkillCandidateCleanupFailed, type HistoryInput, type SkillCandidatesResult, type SkillCandidate } from '@nortuscc/machine';
import { agentSkillInstaller } from '../src/skill-installer.ts';
import { makeSession, type AgentSession } from '../src/ipc/session.ts';
import { type AgentHandle } from '../src/agent.ts';
import { RunStore, RunStoreError, type RunReceipt } from '../src/run-store.ts';
import { makeAdditionDriver } from '../src/skill-addition.ts';
import { makeSkillOperations } from '../src/skill-operations.ts';
import type { JobInspection } from '../src/job.ts';
import { decodeRunView } from '../src/operations/index.ts';
import { operationDigest, type RunLifecycle } from '../src/runs.ts';
import { agentMachine } from './support/agent-machine.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const contentText = '---\nname: Design Review\ndescription: Review design\n---\n';
const contentBlob = createHash('sha1').update(`blob ${Buffer.byteLength(contentText)}\0${contentText}`).digest('hex');
const c: SkillCandidate = { source: 'owner/repo', revision: 'a'.repeat(40), sourceDir: 'skills/odd-folder', selectorName: 'Design Review', installedName: 'design-review', blob: contentBlob, tree: 'c'.repeat(40), description: 'Design review', internal: false, metadata: {} };
const fixture = (options: { sourceOutcome?: 'returned' | 'defect' | 'mixed' | 'mismatch'; noOverrides?: boolean; legacyState?: 'empty' | 'choices'; failReceipt?: (r: RunReceipt) => boolean; failHistory?: (event: HistoryInput) => boolean; nativeDefect?: 'defect' | 'mixed'; installerCode?: number; content?: boolean; codex?: boolean; pauseInstaller?: boolean; claude?: boolean; alreadyInstalled?: boolean; nativeCleanupFailed?: boolean; unavailableInstaller?: boolean; afterSaved?: () => void } = {}) => {
  const m = agentMachine(); roots.push(m.root);
  m.write(join(m.paths.repo, 'skills-manifest.txt'), '[owner/repo] exact\nunrelated\n');
  if (!options.noOverrides) m.write(join(m.paths.stateRoot, 'overrides.json'), JSON.stringify({ version: 2, skills: { unrelated: false }, future: { keep: true } }));
  if (options.alreadyInstalled) {
    m.write(join(m.paths.agentsSkills, c.installedName, 'SKILL.md'), contentText);
    m.write(join(m.paths.agentsSkills, '..', '.skill-lock.json'), JSON.stringify({ version: 3, skills: { [c.selectorName]: { source: c.source, sourceUrl: `https://github.com/${c.source}.git`, ref: c.revision, skillPath: `${c.sourceDir}/SKILL.md`, skillFolderHash: c.tree } } }));
    m.write(join(m.paths.stateRoot, 'overrides.json'), JSON.stringify({ version: 2, skills: { unrelated: false }, future: { keep: true }, skillAdditions: [{ source: c.source, name: c.installedName, targets: ['codex'] }] }));
  }
  if (options.legacyState) m.write(join(m.paths.stateRoot, 'state.json'), JSON.stringify({ files: {}, ...(options.legacyState === 'choices' ? { configTargets: ['codex'] } : {}) }));
  const started = Deferred.makeUnsafe<void>(); const release = Deferred.makeUnsafe<void>();
  const calls: string[] = []; const historyAttempts: HistoryInput[] = []; let installing = 0; let refreshes = 0; let heldPermits = 0;
  const within = (body: (session: AgentSession, fresh: Effect.Effect<JobInspection, unknown>) => Effect.Effect<unknown, unknown, any>) => m.run(Effect.scoped(Effect.gen(function* () {
    const context = yield* Effect.context<any>();
    const fresh = Effect.gen(function* () {
      const overrides = yield* (yield* OverridesStore).read;
      const desired = yield* loadProfile(m.paths.repo, { overrides }).pipe(Effect.provide(nodeFiles));
      return { paths: m.paths, desired, report: { desired, ...yield* inspectSkills(desired) }, domains: [skillsDomain], trusted: true, revision: null };
    }).pipe(Effect.provideContext(context));
    const status = { state: 'idle', policy: 'manual', paused: null };
    const permit = yield* Semaphore.make(1);
    const exclusive = <A, E, R>(effect: Effect.Effect<A, E, R>) => permit.withPermit(Effect.gen(function* () {
      heldPermits++; refreshes++;
      return yield* effect.pipe(Effect.ensuring(Effect.sync(() => { heldPermits--; })));
    }));
    const handle = { inspection: fresh, freshInspection: Effect.map(fresh, inspection => ({ inspection, status })), generation: Effect.succeed(1), exclusive, withJobMutation: exclusive, request: () => Effect.succeed(status) } as unknown as AgentHandle;
    const history = yield* HistoryStore; const store = yield* RunStore; const processes = yield* Processes;
    const session = yield* makeSession(handle, { signal: new AbortController().signal, domains: () => [skillsDomain],
      skillCandidates: input => Effect.sync(() => { input.observeTree?.(c, [{ path: 'SKILL.md', sha: c.blob, mode: '100644' }]); return { ok: true, source: c.source, revision: c.revision, candidates: [c] }; }),
      skillVerification: {
        content: candidate => options.sourceOutcome ? verifyAcceptedSkill(candidate, input => Effect.suspend<SkillCandidatesResult, never, never>(() => {
          calls.push('content');
          const retainedDirectory = join(m.paths.stateRoot, 'tmp', 'candidates-retained');
          if (options.sourceOutcome !== 'mismatch') m.write(join(retainedDirectory, 'owned'), 'retained');
          if (options.sourceOutcome === 'returned') return Effect.succeed({ ok: false, reason: 'cleanup-failed', retainedDirectory });
          if (options.sourceOutcome !== 'mismatch') {
            const cleanup = Cause.die(new SkillCandidateCleanupFailed({ temporaryDirectory: retainedDirectory }));
            return Effect.failCause(options.sourceOutcome === 'mixed' ? Cause.combine(Cause.interrupt(123), cleanup) : cleanup);
          }
          input.observeTree?.(c, [{ path: 'SKILL.md', sha: 'd'.repeat(40), mode: '100644' }]);
          return Effect.succeed({ ok: true, source: c.source, revision: c.revision, candidates: [c] });
        })) : Effect.sync(() => { assert.equal(candidate.sourceDir, c.sourceDir); calls.push('content'); return { verified: options.content !== false, problems: ['content differs'] }; }),
        codex: () => options.nativeDefect ? Effect.failCause(options.nativeDefect === 'mixed'
          ? Cause.combine(Cause.interrupt(123), Cause.die(new DialogueCleanupFailed())) : Cause.die(new DialogueCleanupFailed())) : Effect.sync(() => { calls.push('codex'); return options.nativeCleanupFailed ? { verified: false, reason: 'cleanup-failed' } : options.codex === false ? { verified: false, reason: 'disabled' } : { verified: true, enabled: true, path: '/isolated/SKILL.md' }; }),
        claude: () => Effect.sync(() => { calls.push('claude'); return { verified: options.claude !== false, ...(options.claude === false ? { reason: 'denied' as const } : {}), physical: { status: 'present' as const, path: '/isolated/SKILL.md' }, catalog: { status: 'present' as const }, restrictions: { status: options.claude === false ? 'denied' as const : 'no-known-denial' as const, diagnostics: [] }, limits: { selectedSource: 'not-attested' as const, invocationAuthorization: 'not-attested' as const, configRoot: 'requested-environment-only' as const, managedStartup: 'remains-active' as const } }; }),
      },
    }).pipe(Effect.provide(agentSkillInstaller(options.unavailableInstaller ? undefined : { home: join(m.root, 'home') })), Effect.provideService(RunStore, { ...store, write: r => { if (r.view.intentSaved) options.afterSaved?.(); return options.failReceipt?.(r) ? Effect.fail(new RunStoreError('disk failed')) : store.write(r); } }),
      Effect.provideService(HistoryStore, { ...history, append: event => { historyAttempts.push(event); return options.failHistory?.(event)
        ? Effect.fail(new FsFailed({ op: 'append', path: '/isolated/history', reason: 'injected failure' })) : history.append(event); } }),
      Effect.provideService(Processes, { ...processes, run: command => command.cmd !== 'npx' ? processes.run(command) : Effect.gen(function* () {
        assert.equal(heldPermits, 0, 'the addition driver releases its refresh permit before installation');
        installing++; calls.push('installer');
        if (!options.noOverrides) {
          const backups = readdirSync(m.paths.backups, { recursive: true }).filter(p => String(p).endsWith('overrides.json'));
          assert.ok(backups.length > 0, 'exact original declaration was backed up before installer');
          assert.deepEqual(JSON.parse(readFileSync(join(m.paths.backups, String(backups[0])), 'utf8')), { version: 2, skills: { unrelated: false }, future: { keep: true } });
        }
        assert.ok(command.args.includes(c.revision) || command.args.some(x => x.endsWith('/' + c.revision)));
        assert.ok(command.args.includes(c.selectorName));
        assert.equal(JSON.parse(m.read(join(m.paths.stateRoot, 'overrides.json'))!).skillAdditions[0].revision, undefined);
        yield* Deferred.succeed(started, undefined); if (options.pauseInstaller) yield* Deferred.await(release);
        return { code: options.installerCode ?? 0, stdout: '' };
      }) }));
    return yield* body(session, fresh);
  })));
  return { m, within, calls, historyAttempts, started, release, installing: () => installing, refreshes: () => refreshes };
};
const preview = (session: AgentSession, targets: readonly ('claude' | 'codex')[] = ['codex']) => Effect.gen(function* () {
  const found = yield* session.resolveSkillCandidate({ scope: { kind: 'machine' }, source: c.source, name: c.installedName });
  return yield* session.previewChange({ kind: 'addSkill', candidateId: found.candidates[0]!.candidateId, targets });
});
const request = (planId: string) => ({ requestId: 'same-request', planId, inputDigest: operationDigest(planId), actor: 'mcp' as const });
const terminal = (session: AgentSession, runId: string) => Effect.callback<void>(resume => {
  const off = session.runs.subscribe(runId, run => { if (run.result) resume(Effect.void); }); return Effect.sync(off);
});

test('addition saves backed-up intent and verifies only selected native target with one concurrent request result', async () => {
  const f = fixture(); await f.within(s => Effect.gen(function* () {
    const p = yield* preview(s); const inputs = request(p.planId);
    const [a, b] = yield* Effect.all([s.runs.submit(inputs), s.runs.submit(inputs)], { concurrency: 'unbounded' });
    assert.equal(a.runId, b.runId); yield* terminal(s, a.runId);
    const done = yield* s.runs.get(a.runId);
    assert.equal(done.state, 'succeeded'); assert.equal(done.intentSaved, true); assert.equal(done.installation?.state, 'verified');
    assert.equal(done.intent.skillAddition?.acceptedRevision, c.revision); assert.equal(done.installation?.sharedStore.codexScans, true);
    assert.deepEqual(done.installation?.nextActions, [
      { kind: 'share_with_my_machines', capability: { available: false, reason: 'Sharing requires the personal sharing workflow and a user destination.' }, requiredDestination: 'user' },
      { kind: 'promote_to_profile', capability: { available: false, reason: 'Promotion requires the profile publication workflow and an owned profile destination.' }, requiredDestination: 'profile' },
    ]);
    // Reading or ignoring a suggestion cannot publish or promote any part of the override.
    assert.deepEqual(done.scope, { kind: 'machine' });
    assert.deepEqual(done.intent.skillAddition?.declaration, { source: c.source, name: c.installedName, targets: ['codex'] });
    assert.deepEqual((yield* s.runs.get(done.runId)).installation?.nextActions, done.installation?.nextActions);
    const stored = JSON.parse(f.m.read(join(f.m.paths.stateRoot, 'overrides.json'))!);
    assert.deepEqual(stored.future, { keep: true }); assert.equal(stored.skills.unrelated, false); assert.equal(stored.skillAdditions.length, 1);
  })); assert.equal(f.installing(), 1); assert.deepEqual(f.calls, ['installer', 'content', 'codex']);
});

for (const failure of ['content', 'codex', 'installer'] as const) test(`${failure} failure retains intent and offers no sharing`, async () => {
  const f = fixture({ content: failure !== 'content', codex: failure !== 'codex', installerCode: failure === 'installer' ? 1 : 0 });
  await f.within(s => Effect.gen(function* () { const p = yield* preview(s); const run = yield* s.runs.submit(request(p.planId)); yield* terminal(s, run.runId);
    const done = yield* s.runs.get(run.runId); assert.equal(done.state, 'failed'); assert.equal(done.intentSaved, true); assert.equal(done.installation?.state, 'failed'); assert.deepEqual(done.installation?.nextActions, []);
    if (failure === 'codex') assert.deepEqual(done.installation?.codex, { verified: false, reason: 'disabled' });
  }));
});

test('saved intent receipt failure retains observed physical write and starts no installer', async t => {
  let diagnostics = '';
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => { diagnostics += String(chunk); return true; });
  const f = fixture({ failReceipt: r => r.view.intentSaved });
  await f.within(s => Effect.gen(function* () { const p = yield* preview(s); const run = yield* s.runs.submit(request(p.planId)); yield* terminal(s, run.runId);
    const done = yield* s.runs.get(run.runId); assert.equal(done.state, 'interrupted'); assert.equal(done.intentSaved, true); assert.equal(done.installation?.state, 'needsInspection');
    assert.equal(JSON.parse(f.m.read(join(f.m.paths.stateRoot, 'overrides.json'))!).skillAdditions.length, 1);
  })); assert.equal(f.installing(), 0);
  assert.match(diagnostics, /^apply run [0-9a-f-]+: receipt failed: disk failed\n$/);
});

test('cancellation after saving intent retains declaration and records partial installation', async () => {
  const f = fixture({ pauseInstaller: true }); await f.within(s => Effect.gen(function* () { const p = yield* preview(s); const run = yield* s.runs.submit(request(p.planId)); yield* Deferred.await(f.started);
    const done = yield* s.runs.cancel(run.runId); assert.equal(done.state, 'cancelled'); assert.equal(done.intentSaved, true); assert.equal(done.installation?.state, 'cancelled'); assert.deepEqual(done.installation.nextActions, []);
    assert.equal(JSON.parse(f.m.read(join(f.m.paths.stateRoot, 'overrides.json'))!).skillAdditions.length, 1);
  }));
});

for (const available of [true, false]) test(`Claude-only verification preserves source and authorization limits (${available}) without invoking Codex`, async () => {
  const f = fixture({ claude: available, codex: false }); await f.within(s => Effect.gen(function* () {
    const p = yield* preview(s, ['claude']); const run = yield* s.runs.submit(request(p.planId)); yield* terminal(s, run.runId);
    const done = yield* s.runs.get(run.runId); assert.equal(done.installation?.state, available ? 'verified' : 'failed');
    assert.equal(done.installation?.claude?.limits.selectedSource, 'not-attested'); assert.equal(done.installation?.claude?.limits.invocationAuthorization, 'not-attested');
    assert.equal(done.installation?.codex, undefined);
  })); assert.equal(f.calls.includes('codex'), false);
});

test('malformed or changed intent after preview prevents receipt, backups, and installation', async () => {
  for (const text of ['{bad json', JSON.stringify({ version: 2, skills: { unrelated: true } })]) {
    const f = fixture(); await f.within(s => Effect.gen(function* () {
      const p = yield* preview(s); f.m.write(join(f.m.paths.stateRoot, 'overrides.json'), text);
      assert.equal((yield* Effect.result(s.runs.submit(request(p.planId))))._tag, 'Failure');
      assert.deepEqual((yield* s.runs.list({ limit: 10 })).runs, []);
      assert.equal(f.m.read(join(f.m.paths.stateRoot, 'overrides.json')), text);
    })); assert.equal(f.installing(), 0);
  }
});

test('present incompatible native lock refuses before acceptance and preserves unrelated entries', async () => {
  const f = fixture(); const original = JSON.stringify({ version: 2, skills: { other: { source: 'other/source' } } });
  f.m.write(join(f.m.paths.agentsSkills, '..', '.skill-lock.json'), original);
  await f.within(s => Effect.gen(function* () { const p = yield* preview(s);
    const result = yield* Effect.result(s.runs.submit(request(p.planId))); assert.equal(result._tag, 'Failure');
    if (result._tag === 'Failure') assert.equal(result.failure.code, 'SKILL_INSTALL_UNAVAILABLE');
    assert.deepEqual((yield* s.runs.list({ limit: 10 })).runs, []);
    assert.equal(f.m.read(join(f.m.paths.agentsSkills, '..', '.skill-lock.json')), original);
  })); assert.equal(f.installing(), 0);
});

test('already satisfied declaration and content verify without rewriting intent or invoking an installer', async () => {
  const f = fixture({ alreadyInstalled: true, unavailableInstaller: true }); const before = f.m.read(join(f.m.paths.stateRoot, 'overrides.json'));
  await f.within(s => Effect.gen(function* () { const p = yield* preview(s);
    assert.deepEqual(p.plan.steps.map(step => step.key), ['skill-intent:design-review', 'skill-verify:design-review']);
    const run = yield* s.runs.submit(request(p.planId)); yield* terminal(s, run.runId);
    const done = yield* s.runs.get(run.runId); assert.equal(done.intentSaved, true); assert.equal(done.installation?.state, 'verified');
  }));
  assert.equal(f.installing(), 0); assert.equal(f.m.read(join(f.m.paths.stateRoot, 'overrides.json')), before); assert.equal(existsSync(f.m.paths.backups), false);
});

test('native cleanup uncertainty retains its directory and evidence without sharing', async () => {
  const f = fixture({ nativeCleanupFailed: true }); await f.within(s => Effect.gen(function* () {
    const p = yield* preview(s); const run = yield* s.runs.submit(request(p.planId)); yield* terminal(s, run.runId);
    const done = yield* s.runs.get(run.runId); assert.equal(done.installation?.state, 'needsInspection');
    assert.deepEqual(done.installation?.codex, { verified: false, reason: 'cleanup-failed' }); assert.deepEqual(done.installation?.nextActions, []);
    assert.ok(done.installation?.retainedDirectory && existsSync(done.installation.retainedDirectory));
  }));
});

test('explicit retry keeps one declaration and required target policy', async () => {
  const f = fixture({ content: false }); await f.within(s => Effect.gen(function* () {
    for (const requestId of ['first', 'retry']) {
      const p = yield* preview(s); const run = yield* s.runs.submit({ ...request(p.planId), requestId }); yield* terminal(s, run.runId);
      const done = yield* s.runs.get(run.runId); assert.equal(done.intentSaved, true); assert.equal(done.installation?.state, 'failed');
    }
    const stored = JSON.parse(f.m.read(join(f.m.paths.stateRoot, 'overrides.json'))!);
    assert.deepEqual(stored.skillAdditions, [{ source: c.source, name: c.installedName, targets: ['codex'] }]);
  })); assert.equal(f.installing(), 2);
});

test('a native lock edit after acceptance prevents installer replacement', async () => {
  let f: ReturnType<typeof fixture>;
  const changed = JSON.stringify({ version: 3, skills: { other: { source: 'other/repo' } } });
  f = fixture({ afterSaved: () => f.m.write(join(f.m.paths.agentsSkills, '..', '.skill-lock.json'), changed) });
  await f.within(s => Effect.gen(function* () {
    const p = yield* preview(s); const run = yield* s.runs.submit(request(p.planId)); yield* terminal(s, run.runId);
    const done = yield* s.runs.get(run.runId); assert.equal(done.intentSaved, true); assert.equal(done.installation?.state, 'failed');
  }));
  assert.equal(f.installing(), 0); assert.equal(f.m.read(join(f.m.paths.agentsSkills, '..', '.skill-lock.json')), changed);
});

test('source policy changing after intent persistence stops the accepted installation', async () => {
  let f: ReturnType<typeof fixture>;
  f = fixture({ afterSaved: () => f.m.write(join(f.m.paths.repo, 'skill-pins.json'), JSON.stringify({ version: 1, pins: { 'owner/repo': 'd'.repeat(40) } })) });
  await f.within(s => Effect.gen(function* () {
    const p = yield* preview(s); const run = yield* s.runs.submit(request(p.planId)); yield* terminal(s, run.runId);
    const done = yield* s.runs.get(run.runId); assert.equal(done.intentSaved, true); assert.equal(done.installation?.state, 'failed');
  })); assert.equal(f.installing(), 0);
});

for (const sourceUrl of [undefined, 'https://github.com/wrong/source.git']) test(`re-add plans lock identity repair for sourceUrl ${sourceUrl ?? 'absent'}`, async () => {
  const f = fixture({ alreadyInstalled: true });
  const path = join(f.m.paths.agentsSkills, '..', '.skill-lock.json');
  const lock = JSON.parse(f.m.read(path)!); lock.skills[c.selectorName].sourceUrl = sourceUrl;
  f.m.write(path, JSON.stringify(lock));
  await f.within(s => Effect.gen(function* () {
    const p = yield* preview(s);
    assert.deepEqual(p.plan.steps.map(step => step.key), ['skill-intent:design-review', `skills:install:${c.source}#${c.revision}`, 'skill-verify:design-review']);
  })); assert.equal(f.installing(), 0);
});

for (const targets of [['codex'], ['claude', 'codex']] as const)
for (const nativeDefect of ['defect', 'mixed'] as const) test(`native ${nativeDefect} cleanup cause for ${targets.join('/')} retains needsInspection`, async () => {
  const f = fixture({ nativeDefect });
  await f.within(s => Effect.gen(function* () {
    const p = yield* preview(s, targets); const run = yield* s.runs.submit(request(p.planId)); yield* terminal(s, run.runId);
    const done = yield* s.runs.get(run.runId);
    assert.equal(done.intentSaved, true); assert.equal(done.installation?.state, 'needsInspection');
    assert.ok(done.installation?.retainedDirectory && existsSync(done.installation.retainedDirectory));
    assert.deepEqual(done.installation.nextActions, []);
    if (targets.length > 1) {
      assert.equal(done.installation.claude?.verified, true);
      assert.equal(done.installation.claude?.limits.invocationAuthorization, 'not-attested');
    }
  }));
});

for (const checkpoint of ['before', 'after'] as const) for (const stores of ['history', 'both'] as const)
  test(`${stores} checkpoint failure ${checkpoint} intent write stops installer with uncertainty`, async t => {
    let diagnostics = '';
    t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => { diagnostics += String(chunk); return true; });
    const saved = checkpoint === 'after';
    const f = fixture({ failHistory: e => e.kind === 'skill-addition' && e.intentSaved === saved,
      ...(stores === 'both' ? { failReceipt: (r: RunReceipt) => r.view.intentState !== 'pending' && r.view.intentSaved === saved } : {}) });
    const original = f.m.read(join(f.m.paths.stateRoot, 'overrides.json'));
    await f.within(s => Effect.gen(function* () {
      const p = yield* preview(s); const run = yield* s.runs.submit(request(p.planId)); yield* terminal(s, run.runId);
      const done = yield* s.runs.get(run.runId);
      assert.equal(done.intentSaved, saved); assert.equal(done.installation?.state, 'needsInspection');
      assert.equal(done.intentState, saved ? 'saved' : 'needsInspection');
      assert.equal(done.state, stores === 'both' ? 'interrupted' : 'failed');
      assert.ok(f.historyAttempts.some(e => e.kind === 'skill-addition' && e.intentSaved === saved));
      const stored = f.m.read(join(f.m.paths.stateRoot, 'overrides.json'));
      if (saved) assert.deepEqual(JSON.parse(stored!).skillAdditions, [{ source: c.source, name: c.installedName, targets: ['codex'] }]);
      else assert.equal(stored, original);
    })); assert.equal(f.installing(), 0);
    if (stores === 'both') assert.match(diagnostics, /^apply run [0-9a-f-]+: receipt failed: disk failed\n$/);
    else assert.equal(diagnostics, '');
  });


for (const legacyState of [undefined, 'empty', 'choices'] as const) test(`first addition without overrides preserves ${legacyState ?? 'missing'} legacy state and installs`, async () => {
  const f = fixture({ noOverrides: true, legacyState });
  const legacy = f.m.read(join(f.m.paths.stateRoot, 'state.json'));
  await f.within(s => Effect.gen(function* () {
    const before = yield* (yield* OverridesStore).read;
    assert.equal(before.source, join(f.m.paths.stateRoot, 'state.json'));
    const p = yield* preview(s);
    assert.equal(f.m.read(join(f.m.paths.stateRoot, 'overrides.json')), undefined);
    assert.equal(f.m.read(join(f.m.paths.stateRoot, 'state.json')), legacy);
    assert.equal(existsSync(f.m.paths.backups), false);
    assert.deepEqual(p.skillAddition?.declaration.after.targets, ['codex']);
    const run = yield* s.runs.submit(request(p.planId)); yield* terminal(s, run.runId);
    const done = yield* s.runs.get(run.runId);
    assert.equal(done.installation?.state, 'verified', JSON.stringify(done));
    assert.equal(done.intentState, 'saved'); assert.equal(done.installation?.nextActions.length, 2);
    const after = yield* (yield* OverridesStore).read;
    assert.equal(after.source, join(f.m.paths.stateRoot, 'overrides.json'));
    assert.deepEqual(after.value, { ...before.value, skillAdditions: [{ source: c.source, name: c.installedName, targets: ['codex'] }] });
    assert.equal(f.m.read(join(f.m.paths.stateRoot, 'state.json')), legacy);
  })); assert.equal(f.installing(), 1);
});

for (const sourceOutcome of ['returned', 'defect', 'mixed', 'mismatch'] as const)
  test(`accepted source ${sourceOutcome} preserves cleanup ownership or ordinary content failure`, async () => {
    const f = fixture({ alreadyInstalled: true, sourceOutcome });
    let id = '';
    await f.within(s => Effect.gen(function* () {
      const p = yield* preview(s); const run = yield* s.runs.submit(request(p.planId)); id = run.runId;
      yield* terminal(s, id);
      const done = yield* s.runs.get(id);
      assert.equal(done.intentSaved, true); assert.equal(done.intentState, 'saved');
      assert.equal(done.installation?.state, sourceOutcome === 'mismatch' ? 'failed' : 'needsInspection');
      assert.deepEqual(done.installation?.nextActions, []);
      if (sourceOutcome === 'mismatch') {
        assert.equal(done.state, 'failed'); assert.equal(done.installation?.retainedDirectory, undefined);
        assert.match(done.installation!.message, /SKILL.md differs/);
      } else {
        assert.equal(done.installation?.retainedDirectory, join(f.m.paths.stateRoot, 'tmp', 'candidates-retained'));
        assert.ok(existsSync(join(done.installation!.retainedDirectory!, 'owned')));
      }
      assert.deepEqual((yield* s.runs.list({ limit: 1 })).runs[0]?.installation, done.installation);
    }));
    await f.within(s => Effect.gen(function* () {
      const recovered = yield* s.runs.get(id);
      assert.equal(recovered.installation?.state, sourceOutcome === 'mismatch' ? 'failed' : 'needsInspection');
      assert.deepEqual(recovered.installation?.nextActions, []);
      if (sourceOutcome !== 'mismatch') assert.ok(existsSync(join(recovered.installation!.retainedDirectory!, 'owned')));
    }));
    assert.equal(f.installing(), 0); assert.deepEqual(f.calls, ['content']);
  });

test('terminal-only receipt failure keeps saved and native evidence without follow-ups before and after restart', async () => {
  let failTerminal = true;
  const f = fixture({ alreadyInstalled: true, failReceipt: r => failTerminal && r.view.result !== null });
  let id = ''; let accepted: unknown; let diagnostics = '';
  const original = Object.getOwnPropertyDescriptor(process.stderr, 'write');
  Object.defineProperty(process.stderr, 'write', { configurable: true, writable: true,
    value: (chunk: string | Uint8Array) => { diagnostics += String(chunk); return true; } });
  try {
    await f.within(s => Effect.gen(function* () {
      const p = yield* preview(s); const run = yield* s.runs.submit(request(p.planId)); id = run.runId;
      yield* terminal(s, id);
      const done = yield* s.runs.get(id); accepted = done.intent.skillAddition;
      assert.equal(done.state, 'interrupted'); assert.equal(done.intentSaved, true); assert.equal(done.intentState, 'saved');
      assert.equal(done.installation?.state, 'needsInspection'); assert.deepEqual(done.installation?.nextActions, []);
      assert.deepEqual(done.installation?.codex, { verified: true, enabled: true, path: '/isolated/SKILL.md' });
      assert.deepEqual((yield* s.runs.list({ limit: 1 })).runs[0], done);
      assert.equal((yield* s.runs.submit(request(p.planId))).runId, id);
    }));
  } finally {
    if (original) Object.defineProperty(process.stderr, 'write', original); else Reflect.deleteProperty(process.stderr, 'write');
  }
  assert.match(diagnostics, /^apply run [0-9a-f-]+: receipt failed: disk failed\n$/);
  failTerminal = false;
  await f.within(s => Effect.gen(function* () {
    const recovered = yield* s.runs.get(id);
    assert.equal(recovered.state, 'interrupted'); assert.equal(recovered.intentSaved, true); assert.equal(recovered.intentState, 'saved');
    assert.deepEqual(recovered.intent.skillAddition, accepted);
    assert.equal(recovered.installation?.state, 'needsInspection'); assert.deepEqual(recovered.installation?.nextActions, []);
    assert.deepEqual(recovered.installation?.codex, { verified: true, enabled: true, path: '/isolated/SKILL.md' });
    assert.deepEqual((yield* s.runs.list({ limit: 1 })).runs[0], recovered);
  }));
  assert.equal(f.installing(), 0); assert.deepEqual(f.calls, ['content', 'codex']);
});

for (const outcome of ['returned', 'defect', 'mixed'] as const)
  test(`source ${outcome} cleanup evidence is bounded and the driver preserves the original cause`, async () => {
    const f = fixture({ alreadyInstalled: true });
    await f.within((_session, fresh) => Effect.gen(function* () {
      const ops = yield* makeSkillOperations({ inspection: fresh.pipe(Effect.orDie), generation: Effect.succeed(1),
        readCandidates: input => Effect.sync(() => {
          input.observeTree?.(c, [{ path: 'SKILL.md', sha: c.blob, mode: '100644' }]);
          return { ok: true, source: c.source, revision: c.revision, candidates: [c] };
        }),
      });
      const found = yield* ops.resolveSkillCandidate({ scope: { kind: 'machine' }, source: c.source, name: c.installedName });
      const p = yield* ops.previewAddSkill({ scope: { kind: 'machine' }, candidateId: found.candidates[0]!.candidateId, targets: ['codex'] });
      const accepted = (yield* ops.acceptedPlan(p.planId))!;
      const updates: Parameters<RunLifecycle['addition']>[0][] = [];
      const lifecycle: RunLifecycle = { actor: 'mcp', runId: 'direct-run', requestId: 'direct-request',
        publication: () => Effect.void, publicationResult: () => Effect.void, bindSignInFlow: () => Effect.die('unexpected sign-in binding'),
        accepted: () => Effect.void, parity: () => Effect.void, progress: () => Effect.void, finished: () => Effect.void,
        addition: update => Effect.sync(() => { updates.push(structuredClone(update)); }),
      };
      const directory = '/owned/' + '😀'.repeat(5000);
      const defect = new SkillCandidateCleanupFailed({ temporaryDirectory: directory });
      const cause = outcome === 'mixed'
        ? Cause.combine(Cause.interrupt(123), Cause.combine(Cause.die(new Error('private unrelated diagnostic')), Cause.die(defect)))
        : Cause.die(defect);
      const driver = yield* makeAdditionDriver(accepted, lifecycle, fresh, { content: candidate => verifyAcceptedSkill(candidate,
        () => outcome === 'returned' ? Effect.succeed({ ok: false, reason: 'cleanup-failed', retainedDirectory: directory }) : Effect.failCause(cause)) });
      const report = (yield* fresh).report;
      assert.notEqual(p.plan.kind, 'operation');
      if (p.plan.kind === 'operation') throw new Error('Addition requires a physical plan');
      assert.equal((yield* driver.domain.run(p.plan.steps[0]!, report)).ok, true);
      const exit = yield* Effect.exit(driver.domain.run(p.plan.steps.at(-1)!, report));
      if (outcome === 'returned') { assert.ok(Exit.isSuccess(exit)); assert.equal(exit.value.ok, false); }
      else { assert.ok(Exit.isFailure(exit)); assert.deepEqual(exit.cause.reasons, cause.reasons); }
      const update = updates.at(-1)!;
      assert.equal(update.installation?.state, 'needsInspection'); assert.equal(update.intentSaved, true);
      assert.deepEqual(update.installation?.nextActions, []);
      assert.equal(update.installation?.retainedDirectory, [...directory].slice(0, 4096).join(''));
      assert.doesNotMatch(JSON.stringify(update), /private unrelated diagnostic|Error:/);
      decodeRunView({ runId: 'direct-run', state: 'running', operation: 'applyChange', scope: { kind: 'machine' },
        intent: { requestId: 'direct-request', inputDigest: operationDigest(p.planId), planId: p.planId, change: p.change,
          skillAddition: { source: c.source, acceptedRevision: c.revision, sourceDir: c.sourceDir, selectorName: c.selectorName,
            installedName: c.installedName, blob: c.blob, tree: c.tree, internal: c.internal, targets: ['codex'],
            declaration: p.skillAddition!.declaration.after, policy: p.skillAddition!.pinImpact.policy } },
        ...update, steps: [], result: null });
    }));
    assert.equal(f.installing(), 0); assert.deepEqual(f.calls, []);
  });

test('addition refresh does not nest permits', { timeout: 5000 }, async () => {
  const f = fixture();
  await f.within(session => Effect.gen(function* () {
    const p = yield* preview(session); const run = yield* session.runs.submit(request(p.planId));
    yield* terminal(session, run.runId);
    assert.equal((yield* session.runs.get(run.runId)).state, 'succeeded');
    assert.equal(f.installing(), 1); assert.ok(f.refreshes() >= 2);
  }));
});
