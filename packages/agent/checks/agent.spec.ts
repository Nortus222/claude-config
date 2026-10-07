import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { Deferred, Effect, Exit, Fiber, Layer, Scope } from 'effect';
import { configDomain, DecisionsStore } from '@nortuscc/machine';
import { AgentStateStore, runAgent, SetupSource, startAgent, type AgentDomain } from '../src/index.ts';
import { agentMachine } from './support/agent-machine.ts';
import { accept, APPLIED, EFFORT, HEAD, setupFixture } from './support/setup-fixture.ts';

test('startAgent runs a start job on a trusted machine', async () => {
  const m = agentMachine();
  const fixture = setupFixture(join(m.root, 'setup'));
  await m.trust();
  const { status, inspection } = await m.run(Effect.scoped(Effect.gen(function* () {
    const agent = yield* startAgent(() => m.domains);
    const status = yield* agent.request('inspect');
    return { status, inspection: yield* agent.inspection };
  })), fixture.source);
  assert.equal(status.policy, 'notify');
  assert.equal(status.trusted, true);
  assert.equal(inspection?.trusted, true);
  assert.equal(inspection?.paths.repo, fixture.dirs[APPLIED]);
  assert.deepEqual(await m.kinds(), ['revision-verified']);
});

test('startAgent never trusts the checkout itself', async () => {
  const m = agentMachine();
  const fixture = setupFixture(join(m.root, 'setup'));
  const status = await m.run(Effect.scoped(Effect.gen(function* () {
    const agent = yield* startAgent(() => m.domains);
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
    const agent = yield* startAgent(() => m.domains);
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
    const agent = yield* startAgent(() => m.domains);
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
    const agent = yield* startAgent(() => m.domains);
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
    const agent = yield* startAgent(() => m.domains);
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
  const fiber = Effect.runFork(runAgent({ paths: m.paths, domains: () => m.domains, source: fixture.source, agentVersion: '1.0.0' }));
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
    yield* startAgent(() => [gated, m.domains[1]!]).pipe(Scope.provide(scope));
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
  const fiber = Effect.runFork(runAgent({ paths: m.paths, domains: () => m.domains, source: fixture.source, agentVersion: '1.0.0', signal: controller.signal }));
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
    const agent = yield* startAgent(() => m.domains).pipe(Scope.provide(scope));
    yield* agent.request('inspect');
    yield* Scope.close(scope, Exit.void);
    return yield* Effect.exit(agent.request('inspect').pipe(Effect.timeoutOption('1 second')));
  }), fixture.source);
  assert.ok(Exit.isFailure(exit), 'the request hung or answered after close');
});

const lockPath = (m: ReturnType<typeof agentMachine>) => join(m.paths.stateRoot, 'agent', 'agent.lock');
const writeLock = (path: string, pid: number) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid, startedAt: 'x' }));
};

test('a second agent fails LockHeld before it writes anything', async () => {
  const m = agentMachine();
  const fixture = setupFixture(join(m.root, 'setup'));
  await m.trust();
  writeLock(lockPath(m), process.ppid);
  const logPath = join(m.paths.stateRoot, 'agent', 'agent.log');
  const content = 'active'.repeat(200_000);
  writeFileSync(logPath, content);
  for (const suffix of ['1', '2', '3']) writeFileSync(logPath + '.' + suffix, 'archive ' + suffix);
  const stdout = new Writable({ write: (_chunk, _encoding, done) => done() });
  const stderr = new Writable({ write: (_chunk, _encoding, done) => done() });
  const original = stdout.write;
  let started = false;
  const exit = await Effect.runPromiseExit(runAgent({ paths: m.paths, domains: () => m.domains, source: fixture.source, agentVersion: '1.0.0',
    logOutput: { stdout, stderr }, onStarted: () => { started = true; },
  }));
  assert.ok(Exit.isFailure(exit) && String(exit.cause).includes('LockHeld'));
  assert.equal(stdout.write, original);
  assert.equal(started, false);
  assert.deepEqual(await m.kinds(), []);
  assert.equal(existsSync(lockPath(m)), true);
  assert.equal(readFileSync(logPath, 'utf8'), content);
  for (const suffix of ['1', '2', '3']) assert.equal(readFileSync(logPath + '.' + suffix, 'utf8'), 'archive ' + suffix);
});

test('runAgent rotates the service log before starting jobs', async () => {
  const m = agentMachine();
  const fixture = setupFixture(join(m.root, 'setup'));
  const logPath = join(m.paths.stateRoot, 'agent', 'agent.log');
  const content = 'a'.repeat(1_048_576);
  m.write(logPath, content);
  const controller = new AbortController();
  const source = Layer.succeed(SetupSource, {
    ...fixture.service,
    fetch: Effect.sync(() => {
      assert.equal(readFileSync(logPath, 'utf8'), '');
      assert.equal(readFileSync(logPath + '.1', 'utf8'), content);
    }).pipe(Effect.andThen(fixture.service.fetch)),
  });
  await m.trust();
  const fiber = Effect.runFork(runAgent({ paths: m.paths, domains: () => m.domains, source, agentVersion: '1.0.0', signal: controller.signal }));
  try {
    for (let i = 0; i < 200 && !(await m.kinds()).includes('revision-verified'); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok((await m.kinds()).includes('revision-verified'));
    assert.equal(readFileSync(logPath, 'utf8'), '');
    assert.equal(readFileSync(logPath + '.1', 'utf8'), content);
  } finally {
    controller.abort();
    await Effect.runPromise(Fiber.interrupt(fiber));
  }
});

test('an agent takes over a dead agent\'s lock and removes its own on close', async () => {
  const m = agentMachine();
  const fixture = setupFixture(join(m.root, 'setup'));
  await m.trust();
  writeLock(lockPath(m), spawnSync(process.execPath, ['-e', '']).pid);
  const controller = new AbortController();
  const fiber = Effect.runFork(runAgent({ paths: m.paths, domains: () => m.domains, source: fixture.source, agentVersion: '1.0.0', signal: controller.signal }));
  for (let i = 0; i < 200 && !(await m.kinds()).includes('revision-verified'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok((await m.kinds()).includes('revision-verified'));
  assert.equal(existsSync(lockPath(m)), true);
  controller.abort();
  assert.ok(Exit.isSuccess(await Effect.runPromise(Fiber.await(fiber))));
  assert.equal(existsSync(lockPath(m)), false);
});

// Sends each record in turn over one connection, waiting for its reply; answers the replies.
const converse = (path: string, records: ReadonlyArray<object>) =>
  new Promise<Array<{ readonly [key: string]: any }>>((resolve, reject) => {
    const socket = createConnection(path);
    const replies: Array<{ readonly [key: string]: any }> = [];
    let pending = '';
    const next = () => {
      const record = records[replies.length];
      if (record === undefined) {
        socket.end();
        return resolve(replies);
      }
      socket.write(JSON.stringify(record) + '\n');
    };
    socket.on('data', (chunk) => {
      pending += chunk.toString('utf8');
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const record = JSON.parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        if (record.id === undefined) continue;
        replies.push(record);
        next();
      }
    });
    socket.once('connect', next);
    socket.once('error', reject);
  });

test('with ipc, runAgent serves the socket, and a shutdown request ends it like an abort', { skip: process.platform === 'win32' }, async () => {
  const m = agentMachine('/tmp');
  const fixture = setupFixture(join(m.root, 'setup'));
  await m.trust();
  const dir = join(m.paths.stateRoot, 'agent');
  const fiber = Effect.runFork(runAgent({ paths: m.paths, domains: () => m.domains, source: fixture.source, agentVersion: '1.2.3', ipc: true }));
  try {
    for (let i = 0; i < 500 && !existsSync(join(dir, 'agent.sock')); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    const token = readFileSync(join(dir, 'agent.token'), 'utf8');
    const [hello, shutdown] = await converse(join(dir, 'agent.sock'), [
      { version: 3, id: 'h', command: 'hello', token, client: 'cli' },
      { version: 3, id: 's', command: 'shutdown' },
    ]);
    assert.deepEqual(hello?.result, { agentVersion: '1.2.3', protocol: 3, policy: 'notify', paused: null });
    assert.deepEqual(shutdown?.result, { shutdown: true });
    const ended = await Effect.runPromise(Fiber.await(fiber).pipe(Effect.timeoutOption('5 seconds')));
    assert.ok(ended._tag === 'Some' && Exit.isSuccess(ended.value), 'the agent kept running after shutdown');
    for (const name of ['agent.sock', 'agent.token', 'agent.lock']) assert.equal(existsSync(join(dir, name)), false, name);
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
  }
});

test('without ipc, runAgent writes no socket or token', async () => {
  const m = agentMachine();
  const fixture = setupFixture(join(m.root, 'setup'));
  await m.trust();
  const controller = new AbortController();
  const fiber = Effect.runFork(runAgent({ paths: m.paths, domains: () => m.domains, source: fixture.source, agentVersion: '1.0.0', signal: controller.signal }));
  for (let i = 0; i < 200 && !(await m.kinds()).includes('revision-verified'); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  const dir = join(m.paths.stateRoot, 'agent');
  assert.equal(existsSync(join(dir, 'agent.sock')), false);
  assert.equal(existsSync(join(dir, 'agent.token')), false);
  controller.abort();
  assert.ok(Exit.isSuccess(await Effect.runPromise(Fiber.await(fiber))));
});

test('a second agent with ipc fails LockHeld and leaves the running agent\'s socket and token', async () => {
  const m = agentMachine('/tmp');
  const fixture = setupFixture(join(m.root, 'setup'));
  await m.trust();
  writeLock(lockPath(m), process.ppid);
  const dir = join(m.paths.stateRoot, 'agent');
  writeFileSync(join(dir, 'agent.sock'), 'live');
  writeFileSync(join(dir, 'agent.token'), 'live');
  const exit = await Effect.runPromiseExit(runAgent({ paths: m.paths, domains: () => m.domains, source: fixture.source, agentVersion: '1.0.0', ipc: true }));
  assert.ok(Exit.isFailure(exit) && String(exit.cause).includes('LockHeld'));
  assert.equal(readFileSync(join(dir, 'agent.sock'), 'utf8'), 'live');
  assert.equal(readFileSync(join(dir, 'agent.token'), 'utf8'), 'live');
});

test('runAgent captures startup output under its lock and restores writers when aborted', async (t) => {
  const m = agentMachine();
  t.after(() => rmSync(m.root, { recursive: true, force: true }));
  const fixture = setupFixture(join(m.root, 'setup'));
  const controller = new AbortController();
  const stdout = new Writable({ write: (_chunk, _encoding, done) => done() });
  const stderr = new Writable({ write: (_chunk, _encoding, done) => done() });
  const original = stdout.write;
  const logPath = join(m.paths.stateRoot, 'agent', 'agent.log');
  const fiber = Effect.runFork(runAgent({ paths: m.paths, domains: () => m.domains, source: fixture.source, agentVersion: '1.0.0',
    signal: controller.signal, logOutput: { stdout, stderr },
    onStarted: () => {
      assert.ok(existsSync(lockPath(m)));
      stdout.write('started stdout\n');
      stderr.write('started stderr\n');
      controller.abort();
    },
  }));
  try {
    const ended = await Effect.runPromise(Fiber.await(fiber).pipe(Effect.timeoutOption('2 seconds')));
    assert.ok(ended._tag === 'Some' && Exit.isSuccess(ended.value), 'startup did not capture and finish');
    assert.equal(readFileSync(logPath, 'utf8'), 'started stdout\nstarted stderr\n');
    assert.equal(stdout.write, original);
    assert.equal(existsSync(lockPath(m)), false);
  } finally {
    controller.abort();
    await Effect.runPromise(Fiber.interrupt(fiber));
  }
});

test('runAgent records a fatal startup failure before restoring captured output', async (t) => {
  const m = agentMachine();
  t.after(() => rmSync(m.root, { recursive: true, force: true }));
  const fixture = setupFixture(join(m.root, 'setup'));
  const stdout = new Writable({ write: (_chunk, _encoding, done) => done() });
  const stderr = new Writable({ write: (_chunk, _encoding, done) => done() });
  const originalOut = stdout.write;
  const originalErr = stderr.write;
  const exit = await Effect.runPromiseExit(runAgent({ paths: m.paths, domains: () => m.domains, source: fixture.source, agentVersion: '1.0.0',
    logOutput: { stdout, stderr }, onStarted: () => { throw new Error('startup failed'); },
  }));
  assert.ok(Exit.isFailure(exit) && String(exit.cause).includes('startup failed'));
  assert.match(readFileSync(join(m.paths.stateRoot, 'agent', 'agent.log'), 'utf8'), /Agent failed: startup failed/);
  assert.equal(stdout.write, originalOut);
  assert.equal(stderr.write, originalErr);
  assert.equal(existsSync(lockPath(m)), false);
});
