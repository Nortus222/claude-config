import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Deferred, Effect, Fiber } from 'effect';
import { configDomain, DecisionsStore, integrationsDomain } from '@nortuscc/machine';
import {
  AgentStateStore, decodeInspectResult, decodePreviewResult, makeSession, SessionError, startAgent,
  type AgentDomain, type AgentDomains, type AgentServices, type AgentSession, type RunProgress,
} from '../src/index.ts';
import { agentMachine } from './support/agent-machine.ts';
import { accept, EFFORT, HEAD, setupFixture, type FixtureOptions } from './support/setup-fixture.ts';

const MODEL = 'setting:claude:settings.json#model';
const THEME_KEY = 'config:claude:settings.json#theme';
const EFFORT_KEY = 'config:claude:settings.json#effortLevel';
const MODEL_KEY = 'config:claude:settings.json#model';

type Options = {
  readonly paused?: boolean;
  readonly fixture?: FixtureOptions;
  // Replaces the config domain, so a test can gate or fail a step.
  readonly config?: AgentDomain;
};

// A trusted machine whose head adds two accepted settings keys, effortLevel and model. No key has a
// baseline yet, so a run has three config steps: theme, effortLevel and model. Each test runs inside one agent scope with a session over it.
const sessionMachine = async (options: Options = {}) => {
  const m = agentMachine();
  const fixture = setupFixture(join(m.root, 'setup'), {
    headFiles: { 'claude/settings.keys.json': JSON.stringify({ theme: 'dark', effortLevel: 'high', model: 'opus' }) + '\n' },
    ...options.fixture,
  });
  m.write(join(m.paths.claude, 'settings.json'), JSON.stringify({ theme: 'dark' }) + '\n');
  await m.trust();
  if (options.paused) {
    await m.run(AgentStateStore.use((s) => s.update((state) => ({ ...state, paused: { reason: 'test pause', at: '2026-10-06T00:00:00.000Z' } }))));
  }
  for (const itemId of [EFFORT, MODEL]) await m.run(DecisionsStore.use((d) => d.record(accept(itemId))));
  const domains: AgentDomains = (paths) => [options.config ?? configDomain, integrationsDomain({ paths, env: {} })];
  const shutdown = new AbortController();
  const within = <A, E>(body: (session: AgentSession) => Effect.Effect<A, E, AgentServices>) =>
    m.run(Effect.scoped(Effect.gen(function* () {
      const agent = yield* startAgent(domains);
      const session = yield* makeSession(agent, { signal: shutdown.signal, domains });
      return yield* body(session);
    })), fixture.source);
  const lock = join(m.paths.stateRoot, 'apply.lock');
  return { m, fixture, within, shutdown, lock };
};

// Only the config items: the hook stays out of every run.
const configOnly = (session: AgentSession) =>
  Effect.gen(function* () {
    const inspected = yield* session.inspect('app');
    return inspected.items.filter((i) => i.domain !== 'config').map((i) => i.key);
  });

// Starts the previewed run and collects its events. `ended` completes on the terminal event, which
// must find apply.lock released.
const startRun = (session: AgentSession, planId: string, lock: string) =>
  Effect.gen(function* () {
    const events: Array<RunProgress> = [];
    const runIds = new Set<string>();
    const ended = Deferred.makeUnsafe<void>();
    let lockAtEnd: boolean | undefined;
    const result = yield* session.apply(planId, 'app', (runId, progress) => {
      runIds.add(runId);
      events.push(progress);
      if (['done', 'cancelled', 'failed'].includes(progress.type)) {
        lockAtEnd = existsSync(lock);
        Deferred.doneUnsafe(ended, Effect.void);
      }
    });
    return { result, events, runIds, ended, lockAtEnd: () => lockAtEnd };
  });

// A config domain whose first step waits until the test releases it.
const gatedConfig = () => {
  const started = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  let steps = 0;
  const domain: AgentDomain = {
    ...configDomain,
    run: (step, report) => steps++ === 0
      ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(configDomain.run(step, report)))
      : configDomain.run(step, report),
  };
  return { domain, started, release };
};

const codeOf = (error: unknown) => (error instanceof SessionError ? error.code : `not a SessionError: ${String(error)}`);

test('inspect answers the profile, items and status; preview plans every item not excluded', async () => {
  const { m, within } = await sessionMachine();
  const { inspected, preview } = await within((session) => Effect.gen(function* () {
    const inspected = yield* session.inspect('cli');
    const exclude = inspected.items.filter((i) => i.domain !== 'config').map((i) => i.key);
    return { inspected, preview: yield* session.preview([...exclude, ...exclude]) };
  }));
  const { status, ...result } = inspected;
  const wire = decodeInspectResult(result);
  assert.equal(wire.profile.repo, m.paths.repo);
  assert.equal(wire.profile.revision, HEAD);
  assert.equal(wire.profile.overrides, join(m.paths.stateRoot, 'overrides.json'));
  assert.deepEqual(wire.profile.issues, []);
  assert.ok(wire.items.some((i) => i.key === EFFORT_KEY));
  assert.equal(status.trusted, true);
  assert.equal(status.counts.pending, status.pending.length);
  const plan = decodePreviewResult(preview).plan;
  assert.deepEqual(plan.steps.map((s) => s.key), [THEME_KEY, EFFORT_KEY, MODEL_KEY]);
  assert.ok(plan.skipped.some((s) => s.reason === 'not selected'));
});

test('preview refuses an unknown key and a path as a key', async () => {
  const { m, within } = await sessionMachine();
  const codes = await within((session) => Effect.gen(function* () {
    yield* session.inspect('app');
    const unknown = yield* Effect.flip(session.preview(['config:zzz']));
    const path = yield* Effect.flip(session.preview([join(m.paths.claude, 'settings.json')]));
    return [codeOf(unknown), codeOf(path)];
  }));
  assert.deepEqual(codes, ['UNKNOWN_KEY', 'UNKNOWN_KEY']);
});

test('without an inspection, preview is NO_REPORT and inspect names why the job could not inspect', async () => {
  const { within } = await sessionMachine({ fixture: { unavailable: ['effective'] } });
  const codes = await within((session) => Effect.gen(function* () {
    const inspect = yield* Effect.flip(session.inspect('app'));
    const preview = yield* Effect.flip(session.preview([]));
    return [codeOf(inspect), codeOf(preview)];
  }));
  assert.deepEqual(codes, ['INSPECT_FAILED', 'NO_REPORT']);
});

test('apply runs the previewed plan and records it in History as the client, releasing the lock first', async () => {
  const { m, within, lock } = await sessionMachine();
  const run = await within((session) => Effect.gen(function* () {
    const { planId } = yield* session.preview(yield* configOnly(session));
    const run = yield* startRun(session, planId, lock);
    yield* Deferred.await(run.ended);
    const again = yield* Effect.flip(session.apply(planId, 'app', () => {}));
    return { ...run, running: yield* session.running, again: codeOf(again) };
  }));
  assert.deepEqual(run.result, { status: 'started', runId: [...run.runIds][0] });
  assert.equal(run.runIds.size, 1);
  assert.deepEqual(run.events.map((e) => e.type), ['started', 'finished', 'started', 'finished', 'started', 'finished', 'done']);
  assert.equal(run.lockAtEnd(), false);
  assert.equal(run.running, false);
  assert.equal(run.again, 'UNKNOWN_PLAN');
  assert.deepEqual(JSON.parse(m.read(join(m.paths.claude, 'settings.json'))!), { theme: 'dark', effortLevel: 'high', model: 'opus' });
  const events = await m.events();
  const started = events.find((e) => e.kind === 'apply-started');
  const finished = events.find((e) => e.kind === 'apply-finished');
  assert.deepEqual(started, { ...started, actor: 'app', automatic: false, keys: [THEME_KEY, EFFORT_KEY, MODEL_KEY], runId: [...run.runIds][0] });
  assert.ok(finished?.kind === 'apply-finished');
  assert.equal(finished.actor, 'app');
  assert.equal(finished.result, 'done');
  assert.ok(finished.backup !== null && existsSync(join(finished.backup, 'claude', 'settings.json')));
});

test('an apply whose plan changed since the preview runs nothing and answers the new preview', async () => {
  const { m, within, lock } = await sessionMachine();
  const result = await within((session) => Effect.gen(function* () {
    const { planId } = yield* session.preview(yield* configOnly(session));
    // Between preview and apply, both new keys are skipped (say, synced from another machine).
    for (const itemId of [EFFORT, MODEL]) yield* DecisionsStore.use((d) => d.record({ ...accept(itemId), decision: 'skip' })).pipe(Effect.orDie);
    const result = yield* session.apply(planId, 'app', () => assert.fail('a stale apply emitted progress'));
    const old = yield* Effect.flip(session.apply(planId, 'app', () => {}));
    return { result, old: codeOf(old), running: yield* session.running };
  }));
  assert.equal(result.result.status, 'stale');
  assert.ok(result.result.status === 'stale');
  assert.deepEqual(result.result.plan.steps.map((s) => s.key), [THEME_KEY]);
  assert.equal(result.old, 'UNKNOWN_PLAN');
  assert.equal(result.running, false);
  assert.equal(existsSync(lock), false);
  assert.ok(!(await m.kinds()).includes('apply-started'));
});

test('a live process holding apply.lock refuses the apply as LOCKED, and the preview survives', async () => {
  const { m, within, lock } = await sessionMachine();
  const result = await within((session) => Effect.gen(function* () {
    const { planId } = yield* session.preview(yield* configOnly(session));
    mkdirSync(m.paths.stateRoot, { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }));
    const refused = yield* Effect.flip(session.apply(planId, 'app', () => {}));
    const running = yield* session.running;
    rmSync(lock);
    const run = yield* startRun(session, planId, lock);
    yield* Deferred.await(run.ended);
    return { refused, running, after: run.result.status };
  }));
  assert.equal(codeOf(result.refused), 'LOCKED');
  assert.match((result.refused as Error).message, new RegExp(`pid ${process.ppid}`));
  assert.equal(result.running, false);
  assert.equal(result.after, 'started');
});

test('a run blocks a second apply and preview as BUSY, and cancel stops it without pausing', async () => {
  const gate = gatedConfig();
  const { m, within, lock } = await sessionMachine({ config: gate.domain });
  const result = await within((session) => Effect.gen(function* () {
    const { planId } = yield* session.preview(yield* configOnly(session));
    const run = yield* startRun(session, planId, lock);
    yield* Deferred.await(gate.started);
    const busy = [codeOf(yield* Effect.flip(session.apply(planId, 'app', () => {}))), codeOf(yield* Effect.flip(session.preview([])))];
    const cancelling = yield* Effect.forkChild(session.cancel);
    yield* Effect.sleep('10 millis');
    yield* Deferred.succeed(gate.release, undefined);
    const cancelled = yield* Fiber.join(cancelling);
    return { run, busy, cancelled, again: yield* session.cancel, running: yield* session.running };
  }));
  assert.deepEqual(result.busy, ['BUSY', 'BUSY']);
  assert.equal(result.cancelled, true);
  assert.equal(result.again, false);
  assert.equal(result.running, false);
  assert.deepEqual(result.run.events.map((e) => e.type), ['started', 'finished', 'cancelled']);
  assert.deepEqual((result.run.events.at(-1) as Extract<RunProgress, { type: 'cancelled' }>).remaining, [EFFORT_KEY, MODEL_KEY]);
  assert.equal(result.run.lockAtEnd(), false);
  const finished = (await m.events()).find((e) => e.kind === 'apply-finished');
  assert.ok(finished?.kind === 'apply-finished' && finished.result === 'cancelled');
  assert.ok(!(await m.kinds()).includes('paused'));
});

test('shutdown cancels an active run as cancel does', async () => {
  const gate = gatedConfig();
  const { m, within, shutdown, lock } = await sessionMachine({ config: gate.domain });
  const events = await within((session) => Effect.gen(function* () {
    const { planId } = yield* session.preview(yield* configOnly(session));
    const run = yield* startRun(session, planId, lock);
    yield* Deferred.await(gate.started);
    shutdown.abort();
    yield* Deferred.succeed(gate.release, undefined);
    yield* Deferred.await(run.ended);
    return run.events;
  }));
  assert.equal(events.at(-1)?.type, 'cancelled');
  const finished = (await m.events()).find((e) => e.kind === 'apply-finished');
  assert.ok(finished?.kind === 'apply-finished' && finished.result === 'cancelled');
});

test('a person applies while auto-apply is paused, and a failed step does not pause again', async () => {
  const failing: AgentDomain = { ...configDomain, run: () => Effect.succeed({ ok: false, note: 'disk full' }) };
  const { m, within, lock } = await sessionMachine({ paused: true, config: failing });
  const run = await within((session) => Effect.gen(function* () {
    const { planId } = yield* session.preview(yield* configOnly(session));
    const run = yield* startRun(session, planId, lock);
    yield* Deferred.await(run.ended);
    return run;
  }));
  assert.equal(run.result.status, 'started');
  const done = run.events.at(-1);
  assert.ok(done?.type === 'done');
  assert.equal(done.failed, 3);
  assert.ok(!(await m.kinds()).includes('paused'));
  assert.equal(m.agentJson().paused.reason, 'test pause');
});
