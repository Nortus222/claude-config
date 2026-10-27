import { createHash } from 'node:crypto';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Semaphore } from 'effect';
import { loadProfile, nodeFiles } from '@nortuscc/profile-engine';
import { HistoryStore, OverridesStore, Processes, inspectSkills, skillsDomain, type SkillCandidate } from '@nortuscc/machine';
import { agentSkillInstaller } from '../src/skill-installer.ts';
import { makeSession, type AgentSession } from '../src/ipc/session.ts';
import type { AgentHandle } from '../src/agent.ts';
import { decodeOperationOutput, type ChangePreview, type OperationChange } from '../src/operations/index.ts';
import { operationDigest } from '../src/runs.ts';
import { agentMachine } from './support/agent-machine.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const contentText = '---\nname: design-review\ndescription: Review design\n---\n';
const contentBlob = createHash('sha1').update(`blob ${Buffer.byteLength(contentText)}\0${contentText}`).digest('hex');
const c: SkillCandidate = { source: 'owner/repo', revision: 'a'.repeat(40), sourceDir: 'skills/design-review', selectorName: 'design-review', installedName: 'design-review', blob: contentBlob, tree: 'c'.repeat(40), description: 'Design review', internal: false, metadata: {} };
const verified = { verified: true, physical: { status: 'present' as const, path: '/isolated/SKILL.md' }, catalog: { status: 'present' as const }, restrictions: { status: 'no-known-denial' as const, diagnostics: [] },
  limits: { selectedSource: 'not-attested' as const, invocationAuthorization: 'not-attested' as const, configRoot: 'requested-environment-only' as const, managedStartup: 'remains-active' as const } };

// A machine whose setup declares `manifest`; the skills installer is faked and counted.
const fixture = (manifest: string) => {
  const m = agentMachine(); roots.push(m.root);
  m.write(join(m.paths.repo, 'skills-manifest.txt'), manifest);
  const lockPath = join(m.paths.agentsSkills, '..', '.skill-lock.json');
  let installs = 0;
  const within = (body: (session: AgentSession) => Effect.Effect<unknown, unknown, any>) => m.run(Effect.scoped(Effect.gen(function* () {
    const context = yield* Effect.context<any>();
    const fresh = Effect.gen(function* () {
      const overrides = yield* (yield* OverridesStore).read;
      const desired = yield* loadProfile(m.paths.repo, { overrides }).pipe(Effect.provide(nodeFiles));
      return { paths: m.paths, desired, report: { desired, ...yield* inspectSkills(desired) }, domains: [skillsDomain], trusted: true, revision: null };
    }).pipe(Effect.provideContext(context));
    const status = { state: 'idle', policy: 'manual', paused: null };
    const permit = yield* Semaphore.make(1);
    const exclusive = <A, E, R>(effect: Effect.Effect<A, E, R>) => permit.withPermit(effect);
    const handle = { inspection: fresh, freshInspection: Effect.map(fresh, inspection => ({ inspection, status })), generation: Effect.succeed(1), exclusive, withJobMutation: exclusive, request: () => Effect.succeed(status) } as unknown as AgentHandle;
    const processes = yield* Processes;
    const session = yield* makeSession(handle, { signal: new AbortController().signal, domains: () => [skillsDomain],
      skillCandidates: input => Effect.sync(() => { input.observeTree?.(c, [{ path: 'SKILL.md', sha: c.blob, mode: '100644' }]); return { ok: true, source: c.source, revision: c.revision, candidates: [c] }; }),
      skillVerification: {
        content: () => Effect.succeed({ verified: true, problems: [] }),
        codex: () => Effect.succeed({ verified: true, enabled: true, path: '/isolated/SKILL.md' }),
        claude: () => Effect.succeed(verified),
      },
    }).pipe(Effect.provide(agentSkillInstaller({ home: join(m.root, 'home') })),
      Effect.provideService(Processes, { ...processes, run: command => command.cmd !== 'npx' ? processes.run(command) : Effect.sync(() => { installs++; return { code: 0, stdout: '' }; }) }));
    return yield* body(session);
  })));
  const overrides = () => JSON.parse(m.read(join(m.paths.stateRoot, 'overrides.json')) ?? '{}');
  return { m, within, lockPath, overrides, installs: () => installs };
};
const skillNow = (name: string, action: 'install' | 'remove', extra: { targets?: ('claude' | 'codex')[] } = {}): OperationChange =>
  ({ kind: 'skillNow', source: 'owner/repo', name, action, ...extra });
const route = (p: ChangePreview) => 'skillNow' in p ? p.skillNow.route : undefined;
const finish = (session: AgentSession, planId: string, who: { actor: 'mcp' } | { actor: 'remote'; remoteMachine: string } = { actor: 'mcp' }) => Effect.gen(function* () {
  const accepted = yield* session.runs.submit({ requestId: 'request', planId, inputDigest: operationDigest(planId), ...who });
  yield* Effect.callback<void>(resume => { const off = session.runs.subscribe(accepted.runId, run => { if (run.result) resume(Effect.void); }); return Effect.sync(off); });
  while (yield* session.running) yield* Effect.yieldNow;
  return yield* session.runs.get(accepted.runId);
});

test('skillNow enables an inherited-off skill: saves the choice and installs it in one run', async () => {
  const f = fixture('[owner/repo] optional\nreview\n');
  await f.within(session => Effect.gen(function* () {
    const p = yield* session.previewChange(skillNow('review', 'install'));
    decodeOperationOutput('previewChange', p);
    assert.equal(p.change.kind, 'skillNow');
    assert.equal(route(p), 'enable');
    assert.deepEqual(p.plan.steps.map(step => step.key), ['intent:overrides', 'skills:install:owner/repo']);
    const done = yield* finish(session, p.planId, { actor: 'remote', remoteMachine: 'laptop' });
    assert.equal(done.state, 'succeeded', JSON.stringify(done.result));
    assert.equal(done.intent.change.kind, 'skillNow');
    assert.deepEqual(done.steps.map(step => [step.key, step.outcome]), [['intent:overrides', 'ok'], ['skills:install:owner/repo', 'ok']]);
    assert.equal(f.overrides().skills.review, true);
    assert.equal(done.parity?.state, 'committed'); assert.deepEqual(done.parity?.remainingKeys, []);
    assert.deepEqual('skillNow' in p && p.skillNow.effects, ['Saves review as on for this machine', 'Installs review from owner/repo now, including any bundled scripts, without asking']);
    assert.equal((yield* session.runs.list({ limit: 10 })).runs.length, 1);
    const events = (yield* (yield* HistoryStore).read).filter(event => 'runId' in event && event.runId === done.runId);
    assert.equal(events.filter(event => event.kind === 'apply-started').length, 1);
    assert.ok(events.length > 0 && events.every(event => event.remoteMachine === 'laptop'));
  }));
  assert.equal(f.installs(), 1);
});

test('skillNow adds an undeclared skill through the verified addition plan', async () => {
  const f = fixture('[owner/repo] exact\nunrelated\n');
  await f.within(session => Effect.gen(function* () {
    const p = yield* session.previewChange(skillNow('design-review', 'install', { targets: ['codex'] }));
    decodeOperationOutput('previewChange', p);
    assert.equal(p.change.kind, 'skillNow');
    assert.equal(route(p), 'add');
    const done = yield* finish(session, p.planId);
    assert.equal(done.state, 'succeeded', JSON.stringify(done.result));
    assert.equal(done.installation?.state, 'verified');
    assert.deepEqual(f.overrides().skillAdditions, [{ source: 'owner/repo', name: 'design-review', targets: ['codex'] }]);
  }));
  assert.equal(f.installs(), 1);
});

test('skillNow removes an owned skill: saves the choice and runs the owned disable', async () => {
  const f = fixture('[owner/repo]\nreview\n');
  f.m.write(join(f.m.paths.agentsSkills, 'review', 'SKILL.md'), '# review\n');
  f.m.write(f.lockPath, JSON.stringify({ version: 3, skills: { review: { source: 'owner/repo' } } }));
  await f.within(session => Effect.gen(function* () {
    const p = yield* session.previewChange(skillNow('review', 'remove'));
    assert.equal(route(p), 'disable');
    assert.deepEqual(p.plan.steps.map(step => step.key), ['intent:overrides', 'skills:disable:review']);
    const done = yield* finish(session, p.planId);
    assert.equal(done.state, 'succeeded', JSON.stringify(done.result));
    assert.deepEqual(done.steps.map(step => [step.key, step.outcome]), [['intent:overrides', 'ok'], ['skills:disable:review', 'ok']]);
    assert.equal(done.parity?.state, 'committed'); assert.deepEqual(done.parity?.remainingKeys, []);
    assert.equal(f.overrides().skills.review, false);
  }));
  assert.equal(existsSync(join(f.m.paths.agentsSkills, 'review')), false);
  assert.deepEqual(JSON.parse(f.m.read(f.lockPath)!).skills, {});
  assert.equal(f.installs(), 0);
});

test('skillNow refuses to remove a skill it cannot prove it installed, and changes nothing', async t => {
  let diagnostics = '';
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => { diagnostics += String(chunk); return true; });
  const f = fixture('[owner/repo]\nreview\n');
  f.m.write(join(f.m.paths.agentsSkills, 'review', 'SKILL.md'), '# review\n');
  await f.within(session => Effect.gen(function* () {
    const p = yield* session.previewChange(skillNow('review', 'remove'));
    assert.equal(route(p), 'disable');
    const done = yield* finish(session, p.planId);
    assert.equal(done.state, 'failed');
    assert.ok(done.result && 'message' in done.result);
    assert.match(done.result.message, /^Installed outside the app; remove it on that machine/);
  }));
  assert.equal(f.m.read(join(f.m.paths.agentsSkills, 'review', 'SKILL.md')), '# review\n');
  assert.equal(f.overrides().skills?.review, undefined);
  assert.match(diagnostics, /^apply run [0-9a-f-]+ \(skillNow\) failed: Installed outside the app; remove it on that machine \(installer lock is missing or not a regular file\)\n$/);
});

test('skillNow refuses a same-name skill from a different source', async () => {
  const f = fixture('[other/repo]\nreview\n');
  await f.within(session => Effect.gen(function* () {
    for (const action of ['install', 'remove'] as const) {
      const error = yield* Effect.flip(session.previewChange(skillNow('review', action)));
      assert.equal(error.code, 'INVALID_REQUEST');
      assert.match(error.message, /review.*other\/repo/);
    }
  }));
  assert.equal(f.m.read(join(f.m.paths.stateRoot, 'overrides.json')), undefined);
});

test('skillNow on an already installed skill is a no-op run with no steps', async () => {
  const f = fixture('[owner/repo]\nreview\n');
  f.m.write(join(f.m.paths.agentsSkills, 'review', 'SKILL.md'), '# review\n');
  await f.within(session => Effect.gen(function* () {
    const p = yield* session.previewChange(skillNow('review', 'install'));
    assert.equal(route(p), 'noop');
    assert.deepEqual(p.plan.steps, []);
    const done = yield* finish(session, p.planId);
    assert.equal(done.state, 'succeeded', JSON.stringify(done.result));
    assert.deepEqual(done.steps, []);
  }));
  assert.equal(f.installs(), 0);
  assert.equal(f.m.read(join(f.m.paths.stateRoot, 'overrides.json')), undefined);
});

for (const choice of [undefined, true] as const) test(`skillNow installs a declared, enabled (${choice ?? 'inherited'}) but missing skill in one run`, async () => {
  const f = fixture('[owner/repo]\nreview\n');
  if (choice !== undefined) f.m.write(join(f.m.paths.stateRoot, 'overrides.json'), JSON.stringify({ version: 2, skills: { review: choice } }));
  await f.within(session => Effect.gen(function* () {
    const p = yield* session.previewChange(skillNow('review', 'install'));
    assert.equal(route(p), 'enable');
    assert.ok(p.plan.steps.some(step => step.key === 'skills:install:owner/repo'));
    const done = yield* finish(session, p.planId);
    assert.equal(done.state, 'succeeded', JSON.stringify(done.result));
    assert.ok(done.steps.some(step => step.key === 'skills:install:owner/repo' && step.outcome === 'ok'));
    assert.equal(done.parity?.state, 'committed'); assert.deepEqual(done.parity?.remainingKeys, []);
    assert.equal(f.overrides().skills.review, true);
  }));
  assert.equal(f.installs(), 1);
});

test('skillNow saving only a choice says so in its effects', async () => {
  const f = fixture('[owner/repo]\nreview\n');
  await f.within(session => Effect.gen(function* () {
    const p = yield* session.previewChange(skillNow('review', 'remove'));
    assert.equal(route(p), 'disable');
    assert.deepEqual(p.plan.steps.map(step => step.key), ['intent:overrides']);
    assert.deepEqual('skillNow' in p && p.skillNow.effects, ['Saves review as off for this machine', 'Nothing is installed or removed now']);
  }));
});

test('skillNow install with a target the installed addition lacks adds that target instead of a no-op', async () => {
  const f = fixture('[owner/repo] exact\nunrelated\n');
  f.m.write(join(f.m.paths.agentsSkills, c.installedName, 'SKILL.md'), contentText);
  f.m.write(f.lockPath, JSON.stringify({ version: 3, skills: { [c.selectorName]: { source: c.source, sourceUrl: `https://github.com/${c.source}.git`, ref: c.revision, skillPath: `${c.sourceDir}/SKILL.md`, skillFolderHash: c.tree } } }));
  f.m.write(join(f.m.paths.stateRoot, 'overrides.json'), JSON.stringify({ version: 2, skillAdditions: [{ source: c.source, name: c.installedName, targets: ['codex'] }] }));
  await f.within(session => Effect.gen(function* () {
    assert.equal(route(yield* session.previewChange(skillNow(c.installedName, 'install', { targets: ['codex'] }))), 'noop');
    const p = yield* session.previewChange(skillNow(c.installedName, 'install', { targets: ['claude'] }));
    assert.equal(route(p), 'add');
    assert.deepEqual('skillAddition' in p && p.skillAddition?.declaration.after.targets, ['claude', 'codex']);
  }));
});
