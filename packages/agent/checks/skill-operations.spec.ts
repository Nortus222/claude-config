import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { snapshotFor, snapshotFromDocuments } from '@nortuscc/sync';
import { join } from 'node:path';
import { Cause, Deferred, Effect, Exit, Fiber } from 'effect';
import { Fs, OverridesStore, overridesStore, skillsDomain, inspectSkills, type SkillCandidate, type SkillCandidatesResult, SkillCandidateCleanupFailed } from '@nortuscc/machine';
import { loadProfile, nodeFiles } from '@nortuscc/profile-engine';
import { AgentClock } from '../src/clock.ts';
import { makeSkillOperations } from '../src/skill-operations.ts';
import { agentMachine } from './support/agent-machine.ts';
import { decodeOperationInput, decodeOperationOutput } from '../src/operations/index.ts';

const roots = new Set<string>();
afterEach(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); roots.clear(); });
const sha = 'a'.repeat(40);
const candidate = (source = 'owner/one', installedName = 'design-review', selectorName = 'Design Review'): SkillCandidate => ({
  source, revision: sha, installedName, selectorName, sourceDir: `skills/${installedName}`, description: 'Review design', blob: 'b'.repeat(40), tree: 'c'.repeat(40), internal: false, metadata: { name: selectorName },
});
const fixture = (options: { manifest?: string; overrides?: unknown; reads?: (input: { source: string; revision?: string; timeoutMs?: number }) => Effect.Effect<SkillCandidatesResult>; clock?: AgentClock['Service']; fs?: (fs: Fs['Service']) => Fs['Service'] } = {}) => {
  const m = agentMachine(); roots.add(m.root);
  let inspectionRepo = m.paths.repo;
  m.write(join(m.paths.repo, 'skills-manifest.txt'), options.manifest ?? '[owner/one] exact\nother\n');
  if (options.overrides) m.write(join(m.paths.stateRoot, 'overrides.json'), JSON.stringify(options.overrides));
  const calls: { source: string; revision?: string; timeoutMs?: number }[] = [];
  const run = <A, E>(body: (ops: Effect.Success<ReturnType<typeof makeSkillOperations>>) => Effect.Effect<A, E>) => m.run(Effect.gen(function* () {
    const fs = yield* Fs;
    const program = Effect.gen(function* () {
      const overrides = yield* (yield* OverridesStore).read;
      const desired = yield* loadProfile(inspectionRepo, { overrides }).pipe(Effect.provide(nodeFiles));
      const report = { desired, ...yield* inspectSkills(desired) };
      const inspection = { paths: { ...m.paths, repo: inspectionRepo }, desired, report, domains: [skillsDomain], trusted: true, revision: null };
      const ops = yield* makeSkillOperations({ inspection: Effect.succeed(inspection), generation: Effect.succeed(1), readCandidates: input => {
        calls.push(input); return options.reads?.(input) ?? Effect.succeed({ ok: true, source: input.source, revision: sha, candidates: [candidate(input.source), candidate(input.source, 'sibling', 'Sibling')] });
      } });
      return yield* body(ops);
    }).pipe(Effect.provide(overridesStore));
    const provided = program.pipe(Effect.provideService(Fs, options.fs?.(fs) ?? fs));
    return yield* options.clock ? provided.pipe(Effect.provideService(AgentClock, options.clock)) : provided;
  }));
  return { m, run, calls, setInspectionRepo: (repo: string) => { inspectionRepo = repo; } };
};
const resolve = (ops: Effect.Success<ReturnType<typeof makeSkillOperations>>, source?: string, name = 'design-review') => ops.resolveSkillCandidate({ scope: { kind: 'machine' }, name, ...(source ? { source } : {}) });
const add = (candidateId: string) => ({ kind: 'addSkill', candidateId, targets: ['claude'] } as const);

test('source-omitted lookup returns every exact identity and refuses first-wins ambiguity', async () => {
  const f = fixture({ manifest: '[owner/one]\nother\n[owner/two]\nanother\n' });
  const result = await f.run(ops => resolve(ops));
  assert.equal(result.status, 'ambiguous'); assert.deepEqual(result.candidates.map(c => c.source), ['owner/one', 'owner/two']);
  assert.equal(f.calls.length, 2); assert.ok(f.calls.every(c => c.timeoutMs === 15_000));
  rmSync(f.m.root, { recursive: true, force: true });
});

test('explicit normalized source outside inventory matches selector case-insensitively or installed name exactly', async () => {
  const f = fixture();
  await f.run(ops => Effect.gen(function* () {
    const r = yield* resolve(ops, 'https://github.com/Other/Repo.git', 'DESIGN REVIEW');
    assert.equal(r.status, 'found'); assert.equal(r.candidates[0]!.source, 'other/repo');
    assert.equal(r.candidates[0]!.selectorName, 'Design Review'); assert.equal(r.candidates[0]!.installedName, 'design-review');
    assert.equal((yield* resolve(ops, 'other/repo', 'DESIGN-REVIEW')).status, 'not-found');
    assert.deepEqual(decodeOperationOutput('resolveSkillCandidate', r), r);
  }));
  assert.equal(decodeOperationInput('resolveSkillCandidate', { name: 'Design Review' }).scope.kind, 'machine');
});

test('multiple matches across selector and installed identities remain ambiguous', async () => {
  const f = fixture({ reads: input => Effect.succeed({ ok: true, source: input.source, revision: sha, candidates: [candidate(input.source, 'first', 'design-review'), candidate(input.source)] }) });
  assert.equal((await f.run(ops => resolve(ops, 'owner/one'))).status, 'ambiguous');
});

test('preview keeps exact selected identity, declaration diff, explicit enablement and shared exposure without writes', async () => {
  let writes = 0;
  const f = fixture({ overrides: { version: 2, skills: { 'design-review': false }, skillAdditions: [{ source: 'owner/one', name: 'design-review', targets: ['claude'] }] }, fs: fs => ({ ...fs, writeTextAtomic: () => Effect.sync(() => { writes++; }) }) });
  await f.run(ops => Effect.gen(function* () {
    const r = yield* resolve(ops, 'owner/one');
    const p = yield* ops.previewAddSkill({ scope: { kind: 'machine' }, ...add(r.candidates[0]!.candidateId) });
    assert.deepEqual(p.skillAddition!.enablement, { before: false, after: true });
    assert.equal(p.skillAddition!.declaration.after.name, 'design-review');
    assert.equal(p.skillAddition!.sharedStore.codexScans, true); assert.deepEqual(p.nextActions, []);
    assert.ok(p.plan.steps.every(s => s.touches.every(t => t === 'skills/design-review' || t === 'overrides.json')));
    const accepted = (yield* ops.acceptedPlan(p.planId))!;
    assert.equal(accepted.candidate.selectorName, 'Design Review'); assert.equal(accepted.desired.skills.find(s => s.name === 'design-review')!.exact, true);
    assert.equal(accepted.desired.skills.find(s => s.name === 'design-review')!.install, true);
    assert.equal(accepted.desired.skills.some(s => s.name === 'sibling'), false);
    assert.deepEqual(decodeOperationOutput('previewChange', p), p);
  }));
  assert.equal(writes, 0);
});

test('preview consumes existing source pin without changing siblings or creating an unrequested policy pin', async () => {
  const f = fixture(); f.m.write(join(f.m.paths.repo, 'skill-pins.json'), JSON.stringify({ version: 1, pins: { 'owner/one': sha } }));
  await f.run(ops => Effect.gen(function* () {
    const r = yield* resolve(ops, 'owner/one');
    const p = yield* ops.previewAddSkill({ scope: { kind: 'machine' }, ...add(r.candidates[0]!.candidateId) });
    assert.equal(p.skillAddition!.pinImpact.policy, 'source-pin');
    assert.equal(p.skillAddition!.declaration.after.revision, undefined);
    assert.deepEqual(p.skillAddition!.pinImpact.affectedSkills, ['other']);
  }));
  assert.ok(f.calls.every(c => c.revision === sha));
});

test('moving upstream is refused at preview rather than silently refreshing accepted metadata', async () => {
  let n = 0; const f = fixture({ reads: input => { const c = { ...candidate(input.source), revision: n++ ? 'd'.repeat(40) : sha }; return Effect.succeed({ ok: true, source: input.source, revision: c.revision, candidates: [c] }); } });
  await f.run(ops => Effect.gen(function* () {
    const r = yield* resolve(ops, 'owner/one'); const outcome = yield* Effect.result(ops.previewAddSkill({ scope: { kind: 'machine' }, ...add(r.candidates[0]!.candidateId) }));
    assert.equal(outcome._tag, 'Failure'); if (outcome._tag === 'Failure') assert.match(outcome.failure.message, /changed.*resolve.*again/i);
  }));
});

test('same-name store source conflicts and actual canonical aliases refuse without overwrite', async () => {
  for (const alias of [false, true]) {
    const f = fixture({ fs: alias ? fs => ({ ...fs, realPath: path => path.endsWith('/design-review') || path.endsWith('/Design-Review') ? Effect.succeed(join(f.m.paths.agentsSkills, 'Design-Review')) : fs.realPath(path) }) : undefined });
    mkdirSync(join(f.m.paths.agentsSkills, alias ? 'Design-Review' : 'design-review'), { recursive: true });
    f.m.write(join(f.m.paths.agentsSkills, '..', '.skill-lock.json'), JSON.stringify({ skills: { [alias ? 'Design-Review' : 'design-review']: { source: 'other/repo' } } }));
    await f.run(ops => Effect.gen(function* () { const r = yield* resolve(ops, 'owner/one'); const p = yield* Effect.result(ops.previewAddSkill({ scope: { kind: 'machine' }, ...add(r.candidates[0]!.candidateId) })); assert.equal(p._tag, 'Failure'); if (p._tag === 'Failure') assert.match(p.failure.message, /conflict|alias/i); }));
  }
});

test('failed sources prevent partial first-wins success and preserve cleanup receipts', async () => {
  const f = fixture({ manifest: '[owner/one]\nother\n[owner/two]\nanother\n', reads: input => Effect.succeed(input.source === 'owner/one' ? { ok: true, source: input.source, revision: sha, candidates: [candidate()] } : { ok: false, reason: 'cleanup-failed', retainedDirectory: '/owned/quarantine' }) });
  const r = await f.run(ops => resolve(ops)); assert.equal(r.status, 'unavailable'); assert.deepEqual(r.candidates, []); assert.equal(r.failures[0]!.retainedDirectory, '/owned/quarantine');
});

test('unavailable target context and forged IDs refuse, satisfied declaration still requires native verification', async () => {
  const f = fixture({ overrides: { version: 2, configTargets: ['codex'], skillAdditions: [{ source: 'owner/one', name: 'design-review', targets: ['codex'] }] } });
  await f.run(ops => Effect.gen(function* () {
    const r = yield* resolve(ops, 'owner/one'); const id = r.candidates[0]!.candidateId;
    const unavailable = yield* Effect.result(ops.previewAddSkill({ scope: { kind: 'machine' }, ...add(id) }));
    assert.equal(unavailable._tag, 'Failure'); if (unavailable._tag === 'Failure') assert.equal(unavailable.failure.code, 'TARGET_UNAVAILABLE');
    assert.equal((yield* Effect.result(ops.previewAddSkill({ scope: { kind: 'machine' }, candidateId: '/arbitrary/path', targets: ['codex'] })))._tag, 'Failure');
    const p = yield* ops.previewAddSkill({ scope: { kind: 'machine' }, candidateId: id, targets: ['codex'] });
    assert.equal(p.skillAddition!.declaration.changed, false); assert.equal(p.skillAddition!.nativeVerification, 'required');
  }));
});


test('aggregate deadline joins reader cancellation and preserves its cleanup defect', async () => {
  const readerStarted = Deferred.makeUnsafe<void>();
  const cleanupStarted = Deferred.makeUnsafe<void>();
  const releaseCleanup = Deferred.makeUnsafe<void>();
  let lookupSettled = false;
  const f = fixture({
    clock: { now: Effect.succeed(new Date()), random: Effect.succeed(0), sleep: () => Deferred.await(readerStarted) },
    reads: () => Deferred.succeed(readerStarted, undefined).pipe(Effect.andThen(Effect.never), Effect.onInterrupt(() => Effect.gen(function* () {
      yield* Deferred.succeed(cleanupStarted, undefined);
      yield* Deferred.await(releaseCleanup);
      return yield* Effect.die(new SkillCandidateCleanupFailed({ temporaryDirectory: '/owned/quarantine' }));
    }))),
  });
  const exit = await f.run(ops => Effect.gen(function* () {
    const lookup = yield* Effect.forkChild(Effect.exit(resolve(ops, 'owner/one')).pipe(Effect.tap(() => Effect.sync(() => { lookupSettled = true; }))));
    yield* Deferred.await(cleanupStarted);
    assert.equal(lookupSettled, false, 'deadline waits for reader cleanup');
    yield* Deferred.succeed(releaseCleanup, undefined);
    return yield* Fiber.join(lookup);
  }));
  assert.equal(exit._tag, 'Failure');
  if (Exit.isFailure(exit)) assert.ok(exit.cause.reasons.some(reason => Cause.isDieReason(reason) && reason.defect instanceof SkillCandidateCleanupFailed));
});

test('external cancellation retains an unresolved reader cleanup cause', async () => {
  const f = fixture({ reads: () => Effect.never.pipe(Effect.onInterrupt(() => Effect.die(new SkillCandidateCleanupFailed({ temporaryDirectory: '/owned/external' })))) });
  const exit = await f.run(ops => Effect.gen(function* () { const fiber = yield* Effect.forkChild(resolve(ops, 'owner/one')); yield* Effect.sleep('20 millis'); yield* Fiber.interrupt(fiber); return yield* Fiber.await(fiber); }));
  assert.equal(exit._tag, 'Failure');
  if (Exit.isFailure(exit)) assert.ok(exit.cause.reasons.some(reason => Cause.isDieReason(reason) && reason.defect instanceof SkillCandidateCleanupFailed));
});

test('bounded inventory reports unsupported identities and too many configured sources without fetching', async () => {
  for (const manifest of ['[/local/source]\nlegacy\n', Array.from({ length: 9 }, (_, i) => `[owner/repo${i}]\nname${i}\n`).join('')]) {
    const f = fixture({ manifest }); const r = await f.run(ops => resolve(ops));
    assert.equal(r.status, 'limited'); assert.equal(f.calls.length, 0); assert.ok(r.searchedSources.length <= 8);
  }
});

test('a malformed installed inventory is an unavailable prerequisite, never empty successful lookup', async () => {
  const f = fixture(); f.m.write(join(f.m.paths.agentsSkills, '..', '.skill-lock.json'), '{');
  const r = await f.run(ops => Effect.result(resolve(ops)));
  assert.equal(r._tag, 'Failure'); if (r._tag === 'Failure') assert.match(r.failure.message, /inventory is invalid/);
});

test('candidate retention binds IDs and expires them', async () => {
  let time = Date.now(); const f = fixture({ clock: { now: Effect.sync(() => new Date(time)), sleep: ms => Effect.sleep(ms), random: Effect.succeed(0) } });
  await f.run(ops => Effect.gen(function* () {
    const one = yield* resolve(ops, 'owner/one'); const same = yield* resolve(ops, 'owner/one');
    assert.equal(one.candidates[0]!.candidateId, same.candidates[0]!.candidateId);
    time += 600_001;
    const old = yield* Effect.result(ops.previewAddSkill({ scope: { kind: 'machine' }, ...add(one.candidates[0]!.candidateId) }));
    assert.equal(old._tag, 'Failure');
    const again = yield* resolve(ops, 'owner/one'); assert.notEqual(again.candidates[0]!.candidateId, one.candidates[0]!.candidateId);
  }));
});

test('selected target same-name private directory conflicts before installer planning', async () => {
  const f = fixture(); mkdirSync(join(f.m.paths.claude, 'skills', 'design-review'), { recursive: true });
  const r = await f.run(ops => Effect.gen(function* () { const c = yield* resolve(ops, 'owner/one'); return yield* Effect.result(ops.previewAddSkill({ scope: { kind: 'machine' }, ...add(c.candidates[0]!.candidateId) })); }));
  assert.equal(r._tag, 'Failure'); if (r._tag === 'Failure') assert.match(r.failure.message, /conflict/);
});


test('parallel lookup count and candidate retention limits refuse instead of growing without bounds', async () => {
  const ready = Deferred.makeUnsafe<void>(), release = Deferred.makeUnsafe<void>(); let calls = 0;
  const f = fixture({ reads: input => Effect.gen(function* () { if (++calls === 2) yield* Deferred.succeed(ready, undefined); yield* Deferred.await(release); return { ok: true, source: input.source, revision: sha, candidates: [candidate(input.source)] } as const; }) });
  await f.run(ops => Effect.gen(function* () {
    const one = yield* Effect.forkChild(resolve(ops, 'owner/one')); const two = yield* Effect.forkChild(resolve(ops, 'owner/two')); yield* Deferred.await(ready);
    const busy = yield* Effect.result(resolve(ops, 'owner/three')); assert.equal(busy._tag, 'Failure'); if (busy._tag === 'Failure') assert.equal(busy.failure.code, 'BUSY');
    yield* Deferred.succeed(release, undefined); yield* Fiber.join(one); yield* Fiber.join(two);
  }));
  const retained = fixture();
  await retained.run(ops => Effect.gen(function* () { for (let i = 0; i < 32; i++) assert.equal((yield* resolve(ops, `owner/repo${i}`)).status, 'found'); assert.equal((yield* resolve(ops, 'owner/overflow')).status, 'limited'); }));
});

test('physical exposure without accepted lock/content evidence still plans installation and native verification', async () => {
  const f = fixture({ overrides: { version: 2, skillAdditions: [{ source: 'owner/one', name: 'design-review', targets: ['claude'] }] } });
  mkdirSync(join(f.m.paths.agentsSkills, 'design-review'), { recursive: true }); mkdirSync(join(f.m.paths.claude, 'skills'), { recursive: true });
  symlinkSync(join(f.m.paths.agentsSkills, 'design-review'), join(f.m.paths.claude, 'skills', 'design-review'));
  f.m.write(join(f.m.paths.agentsSkills, '..', '.skill-lock.json'), JSON.stringify({ skills: { 'design-review': { source: 'owner/one' } } }));
  await f.run(ops => Effect.gen(function* () { const r = yield* resolve(ops, 'owner/one'); const p = yield* ops.previewAddSkill({ scope: { kind: 'machine' }, ...add(r.candidates[0]!.candidateId) }); assert.deepEqual(p.plan.steps.map(s => s.key), ['skill-intent:design-review', `skills:install:owner/one#${sha}`, 'skill-verify:design-review']); assert.equal(p.skillAddition!.declaration.changed, false); assert.equal(p.skillAddition!.nativeVerification, 'required'); }));
});

test('held local and mixed hosted snapshots retain composed values and provenance in tentative resolution', async () => {
  for (const mode of ['held', 'hosted'] as const) {
    const f = fixture(); f.m.write(join(f.m.paths.repo, 'claude/settings.keys.json'), '{"theme":"held"}');
    const overrides = await f.m.run(OverridesStore.use(s => s.read));
    let repo: string;
    if (mode === 'held') {
      const git = (args: string[]) => execFileSync('git', ['-C', f.m.paths.repo, '-c', `core.hooksPath=${join(f.m.root, 'disabled-hooks')}`, '-c', 'init.templateDir=', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: f.m.root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
      git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'held']); const held = git(['rev-parse', 'HEAD']);
      f.m.write(join(f.m.paths.repo, 'claude/settings.keys.json'), '{"theme":"head"}'); f.m.write(join(f.m.paths.repo, 'skills-manifest.txt'), '[owner/new] exact\nhead-skill\n');
      git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'head']); const head = git(['rev-parse', 'HEAD']);
      repo = (await f.m.run(snapshotFor({ repo: f.m.paths.repo, stateRoot: f.m.paths.stateRoot, commit: head, held: { 'setting:claude:settings.json#theme': held, 'skill:owner/one/other': held }, overrides, now: new Date() }))).repo;
    } else {
      repo = (await f.m.run(snapshotFromDocuments({ documents: { 'skills-manifest.txt': '[owner/one] exact\nother\n[owner/new] exact\nhead-skill\n', 'claude/settings.keys.json': '{"theme":"held","effortLevel":"high"}' }, stateRoot: f.m.paths.stateRoot, overrides, now: new Date() }))).repo;
    }
    f.setInspectionRepo(repo);
    await f.run(ops => Effect.gen(function* () {
      const r = yield* resolve(ops, 'owner/one'); const p = yield* ops.previewAddSkill({ scope: { kind: 'machine' }, ...add(r.candidates[0]!.candidateId) }); const accepted = (yield* ops.acceptedPlan(p.planId))!;
      assert.equal(accepted.desired.files.find(file => file.id === 'claude:settings.json')!.keys!.theme!.value, 'held');
      assert.ok(accepted.desired.skills.some(skill => skill.name === 'head-skill')); assert.ok(accepted.desired.skills.some(skill => skill.name === 'other'));
      assert.deepEqual(accepted.desired.skills.find(skill => skill.name === 'other')!.from, { layer: 'base', source: 'skills-manifest.txt' });
    }));
  }
});

test('duplicate existing declarations retain the union of required targets when adding a selected target', async () => {
  const f = fixture({ overrides: { version: 2, skillAdditions: [{ source: 'owner/one', name: 'design-review', targets: ['claude'] }, { source: 'owner/one', name: 'design-review', targets: ['codex'] }] } });
  await f.run(ops => Effect.gen(function* () { const r = yield* resolve(ops, 'owner/one'); const p = yield* ops.previewAddSkill({ scope: { kind: 'machine' }, ...add(r.candidates[0]!.candidateId) }); assert.deepEqual(p.skillAddition!.declaration.after.targets, ['claude', 'codex']); }));
});

test('aggregate cancellation retains cleanup evidence from every concurrent source', async () => {
  const f = fixture({ manifest: Array.from({ length: 8 }, (_, i) => `[owner/repo${i}]\nname${i}\n`).join(''), clock: { now: Effect.succeed(new Date()), random: Effect.succeed(0), sleep: () => Effect.sleep('100 millis') }, reads: input => Effect.never.pipe(Effect.onInterrupt(() => Effect.die(new SkillCandidateCleanupFailed({ temporaryDirectory: `/owned/${input.source}` })))) });
  const exit = await f.run(ops => Effect.exit(resolve(ops)));
  assert.ok(Exit.isFailure(exit));
  const dirs = exit.cause.reasons.flatMap(reason => Cause.isDieReason(reason) && reason.defect instanceof SkillCandidateCleanupFailed ? [reason.defect.temporaryDirectory] : []);
  assert.deepEqual([...new Set(dirs)].sort(), Array.from({ length: 8 }, (_, i) => `/owned/owner/repo${i}`));
});

test('existing personal source-wide revisions remain in force, conflicting accepted candidates refuse', async () => {
  const f = fixture({ overrides: { version: 2, skillAdditions: [{ source: 'owner/new', name: 'existing', targets: ['codex'], revision: sha }] } });
  await f.run(ops => Effect.gen(function* () {
    const r = yield* resolve(ops, 'owner/new'); const p = yield* ops.previewAddSkill({ scope: { kind: 'machine' }, ...add(r.candidates[0]!.candidateId) });
    assert.equal(p.skillAddition!.pinImpact.policy, 'personal-pin'); assert.equal(p.skillAddition!.pinImpact.revision, sha); assert.equal(p.skillAddition!.declaration.after.revision, undefined);
    assert.equal((yield* ops.acceptedPlan(p.planId))!.desired.skills.find(s => s.name === 'existing')!.pin!.ref, sha);
  }));
  assert.ok(f.calls.every(c => c.revision === sha));
  const conflict = fixture({ overrides: { version: 2, skillAdditions: [{ source: 'owner/new', name: 'existing', targets: ['codex'], revision: sha }] }, reads: input => Effect.succeed({ ok: true, source: input.source, revision: 'd'.repeat(40), candidates: [{ ...candidate(input.source), revision: 'd'.repeat(40) }] }) });
  await conflict.run(ops => Effect.gen(function* () { const r = yield* resolve(ops, 'owner/new'); const p = yield* Effect.result(ops.previewAddSkill({ scope: { kind: 'machine' }, ...add(r.candidates[0]!.candidateId) })); assert.equal(p._tag, 'Failure'); if (p._tag === 'Failure') assert.match(p.failure.message, /revision policy changed/); }));
});


test('a prior matching explicit personal revision is preserved separately from accepted content evidence', async () => {
  const f = fixture({ manifest: '[base/repo] exact\nother\n', overrides: { version: 2, skillAdditions: [{ source: 'owner/new', name: 'design-review', targets: ['codex'], revision: sha }] } });
  await f.run(ops => Effect.gen(function* () { const r = yield* resolve(ops, 'owner/new'); const p = yield* ops.previewAddSkill({ scope: { kind: 'machine' }, ...add(r.candidates[0]!.candidateId) }); assert.equal(p.skillAddition!.declaration.after.revision, sha); assert.deepEqual(p.skillAddition!.declaration.after.targets, ['claude', 'codex']); assert.equal((yield* ops.acceptedPlan(p.planId))!.candidate.revision, sha); }));
});


test('ambiguous residual Git suffix refuses before fetch, candidate creation or declaration', async () => {
  const f = fixture();
  await f.run(ops => Effect.gen(function* () { const r = yield* Effect.result(resolve(ops, 'https://github.com/owner/repo.git.git')); assert.equal(r._tag, 'Failure'); if (r._tag === 'Failure') assert.equal(r.failure.code, 'INVALID_REQUEST'); }));
  assert.equal(f.calls.length, 0); assert.equal(f.m.read(join(f.m.paths.stateRoot, 'overrides.json')), undefined);
});


test('returned previews cannot rewrite accepted evidence and accepted plan lookup enforces expiry', async () => {
  let time = Date.now(); const f = fixture({ clock: { now: Effect.sync(() => new Date(time)), random: Effect.succeed(0), sleep: ms => Effect.sleep(ms) } });
  await f.run(ops => Effect.gen(function* () { const r = yield* resolve(ops, 'owner/one'); const p = yield* ops.previewAddSkill({ scope: { kind: 'machine' }, ...add(r.candidates[0]!.candidateId) });
    const altered = p as any; altered.skillAddition.candidate.sourceDir = '/caller/forgery'; altered.plan.steps[0].touches.push('skills/unreviewed');
    const accepted = (yield* ops.acceptedPlan(p.planId))!; assert.equal(accepted.candidate.sourceDir, 'skills/design-review'); assert.equal(accepted.preview.skillAddition!.candidate.sourceDir, 'skills/design-review'); assert.deepEqual(accepted.plan.steps[0]!.touches, ['skills/design-review']);
    time += 600_001; assert.equal(yield* ops.acceptedPlan(p.planId), undefined);
  }));
});
