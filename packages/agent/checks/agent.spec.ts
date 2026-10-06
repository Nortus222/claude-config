import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Deferred, Effect, Exit, Fiber, Layer, Scope } from 'effect';
import { configDomain, DecisionsStore } from '@nortuscc/machine';
import { AgentStateStore, runAgent, SetupSource, startAgent, type AgentDomain } from '../src/index.ts';
import { agentMachine } from './support/agent-machine.ts';
import { accept, EFFORT, HEAD, setupFixture } from './support/setup-fixture.ts';

test('startAgent trusts the own checkout and runs a start job', async () => {
  const m = agentMachine();
  const fixture = setupFixture(join(m.root, 'setup'));
  const status = await m.run(Effect.scoped(Effect.gen(function* () {
    const agent = yield* startAgent(m.domains);
    return yield* agent.request('inspect');
  })), fixture.source);
  assert.equal(status.policy, 'notify');
  assert.equal(status.trusted, true);
  const setups = JSON.parse(m.read(join(m.paths.stateRoot, 'agent', 'setups.json'))!);
  assert.deepEqual(setups.setups.map((s: { setupId: unknown; checkout: unknown }) => [s.setupId, s.checkout]), [[null, m.paths.repo]]);
  assert.deepEqual(await m.kinds(), ['setup-trusted', 'revision-verified']);
});

test('setPolicy records the change once and answers under the new policy', async () => {
  const m = agentMachine();
  const fixture = setupFixture(join(m.root, 'setup'));
  const status = await m.run(Effect.scoped(Effect.gen(function* () {
    const agent = yield* startAgent(m.domains);
    yield* agent.setPolicy('auto-apply', 'cli');
    return yield* agent.setPolicy('auto-apply', 'cli');
  })), fixture.source);
  assert.equal(status.policy, 'auto-apply');
  assert.equal(m.agentJson().policySource, 'person');
  const changes = (await m.events()).filter((e) => e.kind === 'policy-changed');
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], { ...changes[0], actor: 'cli', from: 'notify', to: 'auto-apply', origin: 'local' });
});

test('decide stores the decision, records who made it, and answers with the job that saw it', async () => {
  const m = agentMachine();
  const fixture = setupFixture(join(m.root, 'setup'));
  const synced = { ...accept(EFFORT), source: 'synced' as const, machineId: 'machine-2' };
  const status = await m.run(Effect.scoped(Effect.gen(function* () {
    const agent = yield* startAgent(m.domains);
    return yield* agent.decide(synced, 'sync');
  })), fixture.source);
  assert.ok(status.pending.some((p) => p.itemId === EFFORT));
  const decided = (await m.events()).filter((e) => e.kind === 'decided');
  assert.equal(decided.length, 1);
  assert.deepEqual(decided[0], {
    ...decided[0], actor: 'sync', machineId: 'machine-2', setupId: 'local', itemId: EFFORT, commit: HEAD, revision: null, decision: 'accept',
  });
  assert.equal(JSON.parse(m.read(join(m.paths.stateRoot, 'decisions.json'))!).decisions.length, 1);
});

test('resume clears a pause and runs a job', async () => {
  const m = agentMachine();
  const fixture = setupFixture(join(m.root, 'setup'));
  await m.run(AgentStateStore.use((s) => s.update((state) => ({ ...state, paused: { reason: 'a step failed', at: '2026-10-06T00:00:00.000Z' } }))));
  const status = await m.run(Effect.scoped(Effect.gen(function* () {
    const agent = yield* startAgent(m.domains);
    return yield* agent.resume('cli');
  })), fixture.source);
  assert.equal(status.paused, null);
  assert.ok((await m.kinds()).includes('resumed'));
});

test('a job that fails reports JOB_FAILED and the loop keeps running', async () => {
  const m = agentMachine();
  const fixture = setupFixture(join(m.root, 'setup'));
  let fail = false;
  const flaky = Layer.succeed(SetupSource, {
    ...fixture.service,
    effective: (decisions) => (fail ? Effect.die(new Error('boom')) : fixture.service.effective(decisions)),
  });
  const [failed, recovered] = await m.run(Effect.scoped(Effect.gen(function* () {
    const agent = yield* startAgent(m.domains);
    yield* agent.request('inspect');
    fail = true;
    const failed = yield* agent.request('inspect');
    fail = false;
    return [failed, yield* agent.request('inspect')] as const;
  })), flaky);
  assert.equal(failed.error, 'JOB_FAILED');
  assert.match(failed.detail ?? '', /boom/);
  assert.equal(recovered.error, undefined);
});

test('runAgent builds its services from paths and runs until interrupted', async () => {
  const m = agentMachine();
  const fixture = setupFixture(join(m.root, 'setup'));
  const fiber = Effect.runFork(runAgent({ paths: m.paths, domains: m.domains, source: fixture.source }));
  for (let i = 0; i < 200 && !(await m.kinds()).includes('revision-verified'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await Effect.runPromise(Fiber.interrupt(fiber));
  assert.ok((await m.kinds()).includes('revision-verified'));
});

test('closing the agent cancels an in-flight auto-apply, which records cancelled', async () => {
  const m = agentMachine();
  const MODEL = 'setting:claude:settings.json#model';
  const fixture = setupFixture(join(m.root, 'setup'), {
    headFiles: { 'claude/settings.keys.json': JSON.stringify({ theme: 'dark', effortLevel: 'high', model: 'opus' }) + '\n' },
  });
  m.write(join(m.paths.claude, 'settings.json'), JSON.stringify({ theme: 'dark' }) + '\n');
  await m.trust();
  await m.run(AgentStateStore.use((s) => s.update((state) => ({ ...state, policy: 'auto-apply', policySource: 'person' }))));
  for (const itemId of [EFFORT, MODEL]) await m.run(DecisionsStore.use((d) => d.record(accept(itemId))));
  // The first step waits until the test lets it finish, so the agent shuts down mid-run.
  const started = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  let steps = 0;
  const gated: AgentDomain = {
    ...configDomain,
    run: (step, report) => steps++ === 0
      ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(configDomain.run(step, report)))
      : configDomain.run(step, report),
  };
  await m.run(Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* startAgent([gated, m.domains[1]!]).pipe(Scope.provide(scope));
    yield* Deferred.await(started);
    const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));
    // The abort is closing's first, synchronous finalizer; let it run before the step finishes.
    yield* Effect.sleep('10 millis');
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(closing);
  }), fixture.source);
  const finished = (await m.events()).filter((e) => e.kind === 'apply-finished');
  assert.equal(finished.length, 1);
  assert.ok(finished[0]?.kind === 'apply-finished');
  assert.equal(finished[0].result, 'cancelled');
  assert.equal(finished[0].steps.length, 1);
  assert.equal(steps, 1);
  assert.ok(!(await m.kinds()).includes('paused'));
});
