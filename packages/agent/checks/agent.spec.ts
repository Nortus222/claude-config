import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Deferred, Effect, Exit, Fiber, Layer, Scope } from 'effect';
import { configDomain, DecisionsStore } from '@nortuscc/machine';
import { AgentStateStore, runAgent, SetupSource, startAgent, type AgentDomain } from '../src/index.ts';
import { agentMachine } from './support/agent-machine.ts';
import { accept, EFFORT, HEAD, setupFixture } from './support/setup-fixture.ts';

test('startAgent runs a start job on a trusted machine', async () => {
  const m = agentMachine();
  const fixture = setupFixture(join(m.root, 'setup'));
  await m.trust();
  const status = await m.run(Effect.scoped(Effect.gen(function* () {
    const agent = yield* startAgent(m.domains);
    return yield* agent.request('inspect');
  })), fixture.source);
  assert.equal(status.policy, 'notify');
  assert.equal(status.trusted, true);
  assert.deepEqual(await m.kinds(), ['revision-verified']);
});

test('startAgent never trusts the checkout itself', async () => {
  const m = agentMachine();
  const fixture = setupFixture(join(m.root, 'setup'));
  const status = await m.run(Effect.scoped(Effect.gen(function* () {
    const agent = yield* startAgent(m.domains);
    return yield* agent.request('inspect');
  })), fixture.source);
  assert.equal(status.trusted, false);
  assert.equal(m.read(join(m.paths.stateRoot, 'agent', 'setups.json')), undefined);
  assert.ok(!(await m.kinds()).includes('setup-trusted'));
});

test('setPolicy records the change once and answers under the new policy', async () => {
  const m = agentMachine();
  const fixture = setupFixture(join(m.root, 'setup'));
  await m.trust();
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
  await m.trust();
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
  await m.trust();
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
  await m.trust();
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
  await m.trust();
  const fiber = Effect.runFork(runAgent({ paths: m.paths, domains: m.domains, source: fixture.source }));
  for (let i = 0; i < 200 && !(await m.kinds()).includes('revision-verified'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await Effect.runPromise(Fiber.interrupt(fiber));
  assert.ok((await m.kinds()).includes('revision-verified'));
});

const MODEL = 'setting:claude:settings.json#model';

// A trusted auto-apply machine with two accepted inert keys, so a run has two steps.
const autoApplyMachine = async () => {
  const m = agentMachine();
  const fixture = setupFixture(join(m.root, 'setup'), {
    headFiles: { 'claude/settings.keys.json': JSON.stringify({ theme: 'dark', effortLevel: 'high', model: 'opus' }) + '\n' },
  });
  m.write(join(m.paths.claude, 'settings.json'), JSON.stringify({ theme: 'dark' }) + '\n');
  await m.trust();
  await m.run(AgentStateStore.use((s) => s.update((state) => ({ ...state, policy: 'auto-apply', policySource: 'person' }))));
  for (const itemId of [EFFORT, MODEL]) await m.run(DecisionsStore.use((d) => d.record(accept(itemId))));
  return { m, fixture };
};

test('closing the agent cancels an in-flight auto-apply, which records cancelled', async () => {
  const { m, fixture } = await autoApplyMachine();
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

test('an aborted signal ends the agent, and no later job runs', async () => {
  const { m, fixture } = await autoApplyMachine();
  const controller = new AbortController();
  const fiber = Effect.runFork(runAgent({ paths: m.paths, domains: m.domains, source: fixture.source, signal: controller.signal }));
  for (let i = 0; i < 200 && !(await m.kinds()).includes('apply-finished'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  controller.abort();
  const ended = await Effect.runPromise(Fiber.await(fiber).pipe(Effect.timeoutOption('2 seconds')));
  if (ended._tag === 'None') await Effect.runPromise(Fiber.interrupt(fiber));
  assert.equal(ended._tag, 'Some', 'the agent kept running after its signal aborted');
  assert.ok(ended._tag === 'Some' && Exit.isSuccess(ended.value));
  const before = await m.kinds();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await m.kinds(), before);
  const runs = (await m.events()).filter((e) => e.kind === 'apply-finished');
  assert.equal(runs.length, 1);
  assert.ok(runs.every((e) => e.kind === 'apply-finished' && e.steps.length > 0 && e.result === 'done'));
});

test('a request after the agent closed fails promptly', async () => {
  const m = agentMachine();
  const fixture = setupFixture(join(m.root, 'setup'));
  await m.trust();
  const exit = await m.run(Effect.gen(function* () {
    const scope = yield* Scope.make();
    const agent = yield* startAgent(m.domains).pipe(Scope.provide(scope));
    yield* agent.request('inspect');
    yield* Scope.close(scope, Exit.void);
    return yield* Effect.exit(agent.request('inspect').pipe(Effect.timeoutOption('1 second')));
  }), fixture.source);
  assert.ok(Exit.isFailure(exit), 'the request hung or answered after close');
});
