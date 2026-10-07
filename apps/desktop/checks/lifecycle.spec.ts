import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { Effect, Layer } from 'effect';
import { agentLayer, DEFAULT_STATE, unitPath, type ServiceTarget, type WireStatus } from '@nortuscc/agent';
import { backupsForRun, Processes, type Command, type MachinePathsValue } from '@nortuscc/machine';
import { AgentError, AgentUnavailable, type AgentConnection } from '../../../src/agent-client.ts';
import { ensureAgent } from '../agent/lifecycle.ts';

const STATUS: WireStatus = {
  at: '2026-10-06T12:00:00.000Z', policy: 'notify', paused: null, trusted: true, pending: [], drift: [], conflicts: [], probeErrors: [],
  counts: { pending: 0, held: 0, ready: 0, drift: 0 }, applying: false,
};
const unavailable = async (): Promise<AgentConnection> => { throw new AgentUnavailable('no agent'); };
const fixture = (t: { after: (f: () => void) => void }) => {
  const home = mkdtempSync(join(tmpdir(), 'nal-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stateRoot = join(home, 'state');
  const paths: MachinePathsValue = {
    repo: join(home, 'repo'), claude: join(home, '.claude'), codex: join(home, '.codex'), codexOpenRouter: join(home, '.codex-openrouter'),
    agentsSkills: join(home, '.agents/skills'), stateRoot, backups: join(stateRoot, 'backups'),
  };
  mkdirSync(join(paths.repo, '.git'), { recursive: true });
  mkdirSync(join(stateRoot, 'agent'), { recursive: true });
  const target: ServiceTarget = { platform: 'darwin', home, uid: 501, user: 'fake', stateRoot };
  const events: string[] = [];
  const registrations: Array<Record<string, unknown>> = [];
  let fail = false;
  let origin = 'https://github.com/example/setup.git';
  let onService: ((command: Command) => void) | undefined;
  const processes = Layer.succeed(Processes, {
    run: (command) => Effect.sync(() => {
      if (command.cmd === 'git') return { code: 0, stdout: origin + '\n' };
      assert.equal(command.cmd, 'launchctl', 'only the injected service manager is called');
      events.push(command.args[0]!);
      onService?.(command);
      registrations.push(JSON.parse(readFileSync(join(stateRoot, 'agent/agent.json'), 'utf8')));
      return { code: fail && command.args[0] === 'bootstrap' ? 5 : 0, stdout: '', stderr: 'fake registration failed' };
    }),
  });
  const base = agentLayer(paths, { processes });
  const input = { paths, target, resources: join(home, 'resources'), agentVersion: 'v1', env: { HOME: home, PATH: '/fake/bin', NORTUSCC_STATE_DIR: stateRoot, NORTUSCC_TEST_SECRET: 'omit' } };
  const read = (name: string) => JSON.parse(readFileSync(join(stateRoot, 'agent', name), 'utf8')) as Record<string, unknown>;
  const write = (name: string, value: unknown) => writeFileSync(join(stateRoot, 'agent', name), JSON.stringify(value));
  const run = (changes: Partial<typeof input> = {}, options: Parameters<typeof ensureAgent>[1] = {}) =>
    Effect.runPromise(ensureAgent({ ...input, ...changes }, { connect: unavailable, pollMs: 1, timeoutMs: 300, retryDelayMs: 0, ...options }).pipe(Effect.provide(backupsForRun().pipe(Layer.provideMerge(base)))));
  return { home, paths, target, input, events, registrations, run, read, write, origin: (url: string) => { origin = url; }, onService: (f: (command: Command) => void) => { onService = f; }, fail: () => { fail = true; }, recover: () => { fail = false; } };
};
const connection = (events: string[], version = 'v1', statuses: Array<WireStatus | Error> = [STATUS]): AgentConnection => ({
  hello: { agentVersion: version, protocol: 3, policy: 'notify', paused: null },
  request: async <A>(command: object) => {
    const name = (command as { command: string }).command;
    events.push(name);
    if (name === 'status') {
      const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
      if (status instanceof Error) throw status;
      return status as A;
    }
    return { shutdown: true } as A;
  },
  onEvent: () => () => {}, onClose: () => () => {}, close: () => { events.push('close'); },
});

test('first install trusts the setup and records app ownership before starting its resource program', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.run(), { stateRoot: f.paths.stateRoot });
  assert.deepEqual(f.read('agent.json'), { ...DEFAULT_STATE, installedBy: 'app', agentVersion: 'v1' });
  assert.ok(f.registrations.every((s) => s.installedBy === 'app' && s.agentVersion === 'v1'));
  const unit = readFileSync(unitPath(f.target), 'utf8');
  assert.ok(unit.includes(join(f.input.resources, 'bun')));
  assert.ok(unit.includes(join(f.input.resources, 'agent.mjs')));
  assert.ok(unit.includes(`<string>${f.input.resources}</string>`));
  assert.ok(unit.includes(`<string>${f.home}</string>`));
  assert.ok(unit.includes('<key>NORTUSCC_STATE_DIR</key>'));
  assert.ok(!unit.includes('NORTUSCC_TEST_SECRET'));
  assert.equal((f.read('setups.json').setups as Array<{ checkout: string }>)[0]!.checkout, f.paths.repo);
});

test('repeat startup is idempotent and leaves existing trust bytes and unknown state fields intact', async (t) => {
  const f = fixture(t);
  await f.run();
  f.write('agent.json', { ...f.read('agent.json'), future: { retained: true } });
  const trust = readFileSync(join(f.paths.stateRoot, 'agent/setups.json'), 'utf8');
  f.events.length = 0;
  await f.run({}, { connect: async () => connection(f.events) });
  assert.deepEqual(f.events, ['close']);
  assert.deepEqual(f.read('agent.json').future, { retained: true });
  assert.equal(readFileSync(join(f.paths.stateRoot, 'agent/setups.json'), 'utf8'), trust);
});

test('moved resources gracefully stop the agent and rewrite registration with backups', async (t) => {
  const f = fixture(t);
  await f.run();
  const oldUnit = readFileSync(unitPath(f.target), 'utf8');
  const oldState = readFileSync(join(f.paths.stateRoot, 'agent/agent.json'), 'utf8');
  f.events.length = 0;
  const moved = join(f.home, 'moved');
  await f.run({ resources: moved }, { connect: async () => connection(f.events) });
  assert.deepEqual(f.events, ['status', 'shutdown', 'close', 'bootout', 'bootstrap']);
  assert.ok(readFileSync(unitPath(f.target), 'utf8').includes(join(moved, 'agent.mjs')));
  const folders = readdirSync(f.paths.backups);
  assert.ok(folders.some((dir) => readFileSync(join(f.paths.backups, dir, 'agent/service.plist'), 'utf8') === oldUnit));
  assert.ok(folders.some((dir) => readFileSync(join(f.paths.backups, dir, 'agent/agent.json'), 'utf8') === oldState));
});

test('upgrade uses the live hello version, waits through NO_REPORT and applying, then shuts down before registration', async (t) => {
  const f = fixture(t);
  await f.run();
  f.events.length = 0;
  await f.run({}, { connect: async () => connection(f.events, 'old', [new AgentError('NO_REPORT', 'starting'), { ...STATUS, applying: true }, STATUS]) });
  assert.deepEqual(f.events, ['status', 'status', 'status', 'shutdown', 'close', 'bootout', 'bootstrap']);
});

test('an apply that never finishes times out without stopping it or changing registration', async (t) => {
  const f = fixture(t);
  await f.run();
  f.events.length = 0;
  const before = readFileSync(unitPath(f.target), 'utf8');
  await assert.rejects(f.run({ agentVersion: 'v2' }, { connect: async () => connection(f.events, 'v1', [{ ...STATUS, applying: true }]) }), /idle|applying|running/);
  assert.ok(!f.events.includes('shutdown'));
  assert.ok(!f.events.includes('bootout'));
  assert.equal(readFileSync(unitPath(f.target), 'utf8'), before);
  assert.equal(f.read('agent.json').agentVersion, 'v1');
});

test('failed registration retries and preserves policy, pause, trust, unknown fields and their backups', async (t) => {
  const f = fixture(t);
  const pause = { reason: 'person', at: '2026-10-06T12:00:00Z' };
  f.write('agent.json', { ...DEFAULT_STATE, policy: 'manual', policySource: 'person', paused: pause, future: 42 });
  f.write('setups.json', { version: 1, future: 'trust', setups: [{ setupId: null, repoUrl: 'github.com/example/setup', checkout: f.paths.repo, trustedAt: 'original', future: 7 }] });
  const trust = readFileSync(join(f.paths.stateRoot, 'agent/setups.json'), 'utf8');
  f.fail();
  await assert.rejects(f.run(), /registration failed/);
  assert.equal(f.read('agent.json').policy, 'manual');
  assert.deepEqual(f.read('agent.json').paused, pause);
  assert.equal(f.read('agent.json').future, 42);
  assert.equal(readFileSync(join(f.paths.stateRoot, 'agent/setups.json'), 'utf8'), trust);
  f.recover();
  f.events.length = 0;
  await f.run();
  assert.ok(f.events.includes('bootstrap'), 'partial registration is installed again rather than kickstarted');
  assert.equal(f.read('agent.json').future, 42);
  const folders = readdirSync(f.paths.backups);
  assert.ok(folders.some((dir) => {
    const backedUp = JSON.parse(readFileSync(join(f.paths.backups, dir, 'agent/agent.json'), 'utf8'));
    return backedUp.future === 42 && backedUp.installedBy === undefined && backedUp.policy === 'manual';
  }));
  assert.ok(folders.some((dir) => readFileSync(join(f.paths.backups, dir, 'agent/setups.json'), 'utf8') === trust));
});

test('unreachable running agent and authentication refusal require explicit recovery', async (t) => {
  const f = fixture(t);
  await f.run();
  f.events.length = 0;
  f.write('agent.lock', { pid: process.pid });
  await assert.rejects(f.run(), /unreachable|restart/);
  assert.deepEqual(f.events, []);
  rmSync(join(f.paths.stateRoot, 'agent/agent.lock'));
  await assert.rejects(f.run({}, { connect: async () => { throw new AgentError('UNAUTHORIZED', 'bad token'); } }), /bad token/);
  assert.deepEqual(f.events, []);
});

test('explicit restart can recover incompatible protocol while an apply lock still protects a run', async (t) => {
  const f = fixture(t);
  await f.run();
  f.events.length = 0;
  const incompatible = async (): Promise<AgentConnection> => { throw new AgentError('MALFORMED', 'incompatible protocol'); };
  await assert.rejects(f.run({}, { connect: incompatible }), /incompatible protocol/);
  f.write('../apply.lock', { pid: process.pid });
  await assert.rejects(f.run({}, { connect: incompatible, restart: true }), /idle|applying|running/);
  assert.deepEqual(f.events, []);
  rmSync(join(f.paths.stateRoot, 'apply.lock'));
  await f.run({}, { connect: incompatible, restart: true });
  assert.deepEqual(f.events, ['bootout', 'bootstrap']);
});

test('old status without applying falls back to the shared apply lock', async (t) => {
  const f = fixture(t);
  await f.run();
  f.events.length = 0;
  f.write('../apply.lock', { pid: process.pid });
  const { applying: _, ...oldStatus } = STATUS;
  await assert.rejects(f.run({ agentVersion: 'v2' }, { connect: async () => connection(f.events, 'v1', [oldStatus]) }), /idle|applying|running/);
  assert.ok(!f.events.includes('shutdown'));
});

test('concurrent setup is harmlessly rejected before touching registration', async (t) => {
  const f = fixture(t);
  f.write('app-install.lock', { pid: process.pid });
  await assert.rejects(f.run(), /holds|lock|another/);
  assert.deepEqual(f.events, []);
});

test('an unreachable explicit restart re-registers even when the written unit and marker match', async (t) => {
  const f = fixture(t);
  await f.run();
  f.events.length = 0;
  await f.run({}, { restart: true });
  assert.deepEqual(f.events, ['bootout', 'bootstrap']);
});

test('explicit recovery stops an incompatible running job and drains its lock before recording metadata', async (t) => {
  const f = fixture(t);
  await f.run();
  f.events.length = 0;
  f.write('agent.lock', { pid: process.pid });
  f.onService((command) => {
    if (command.args[0] === 'bootout') rmSync(join(f.paths.stateRoot, 'agent/agent.lock'), { force: true });
  });
  await f.run({ agentVersion: 'v2' }, { connect: async () => { throw new AgentError('MALFORMED', 'protocol'); }, restart: true });
  assert.deepEqual(f.events, ['bootout', 'bootout', 'bootstrap']);
  assert.equal(f.registrations.at(-1)?.agentVersion, 'v2');
});

test('shutdown drains final pause writes before metadata update and backs up the successful registration marker', async (t) => {
  const f = fixture(t);
  await f.run();
  const beforeMarker = readFileSync(join(f.paths.stateRoot, 'agent/app-service.json'), 'utf8');
  const pause = { at: '2026-10-06T12:00:00Z', reason: 'final old-agent write' };
  const conn = connection(f.events);
  const oldRequest = conn.request;
  const draining: AgentConnection = { ...conn, request: async <A>(command: object, opts?: { timeoutMs?: number }): Promise<A> => {
    if ((command as { command: string }).command === 'shutdown') {
      f.write('agent.lock', { pid: process.pid });
      setTimeout(() => {
        f.write('agent.json', { ...f.read('agent.json'), paused: pause, futureFinalizer: true });
        rmSync(join(f.paths.stateRoot, 'agent/agent.lock'));
      }, 5);
    }
    return oldRequest<A>(command, opts);
  } };
  await f.run({ agentVersion: 'v2' }, { connect: async () => draining });
  assert.deepEqual(f.read('agent.json').paused, pause);
  assert.equal(f.read('agent.json').futureFinalizer, true);
  assert.equal(f.read('agent.json').agentVersion, 'v2');
  assert.ok(readdirSync(f.paths.backups).some((dir) => readFileSync(join(f.paths.backups, dir, 'agent/app-service.json'), 'utf8') === beforeMarker));
});

test('an apply that wins the idle-check race is waited out before shutdown', async (t) => {
  const f = fixture(t);
  await f.run();
  f.events.length = 0;
  const conn = connection(f.events);
  const oldRequest = conn.request;
  let statuses = 0;
  const racing: AgentConnection = { ...conn, request: async <A>(command: object, opts?: { timeoutMs?: number }): Promise<A> => {
    if ((command as { command: string }).command === 'status') {
      statuses++;
      if (statuses === 1) f.write('../apply.lock', { pid: process.pid });
      if (statuses === 2) rmSync(join(f.paths.stateRoot, 'apply.lock'));
    }
    if ((command as { command: string }).command === 'shutdown') assert.ok(statuses >= 3, 'the apply lock was observed and released');
    return oldRequest<A>(command, opts);
  } };
  await f.run({ agentVersion: 'v2' }, { connect: async () => racing });
  assert.equal(f.read('agent.json').agentVersion, 'v2');
});

test('explicit restart of a reachable unchanged registration shuts down and kickstarts it', async (t) => {
  const f = fixture(t);
  await f.run();
  f.events.length = 0;
  await f.run({}, { connect: async () => connection(f.events), restart: true });
  assert.deepEqual(f.events, ['status', 'shutdown', 'close', 'kickstart']);
});

test('app upgrades, moves and restarts preserve own trust after its origin changes', async (t) => {
  const f = fixture(t);
  await f.run();
  const trust = readFileSync(join(f.paths.stateRoot, 'agent/setups.json'), 'utf8');
  f.origin('https://github.com/other/setup.git');
  await f.run({ agentVersion: 'v2' }, { connect: async () => connection(f.events) });
  assert.equal(readFileSync(join(f.paths.stateRoot, 'agent/setups.json'), 'utf8'), trust);
  const resources = join(f.home, 'moved');
  await f.run({ agentVersion: 'v2', resources }, { connect: async () => connection(f.events, 'v2') });
  assert.equal(readFileSync(join(f.paths.stateRoot, 'agent/setups.json'), 'utf8'), trust);
  await f.run({ agentVersion: 'v2', resources }, { connect: async () => connection(f.events, 'v2'), restart: true });
  assert.equal(readFileSync(join(f.paths.stateRoot, 'agent/setups.json'), 'utf8'), trust);
});

test('removed own trust stays removed across app-owned upgrades and restarts', async (t) => {
  const f = fixture(t);
  await f.run();
  f.write('setups.json', { version: 1, future: 'person removed trust', setups: [] });
  const trust = readFileSync(join(f.paths.stateRoot, 'agent/setups.json'), 'utf8');
  await f.run({ agentVersion: 'v2' }, { connect: async () => connection(f.events) });
  assert.equal(readFileSync(join(f.paths.stateRoot, 'agent/setups.json'), 'utf8'), trust);
  await f.run({ agentVersion: 'v2' }, { connect: async () => connection(f.events, 'v2'), restart: true });
  assert.equal(readFileSync(join(f.paths.stateRoot, 'agent/setups.json'), 'utf8'), trust);
});

test('CLI takeover preserves an existing decision to leave own setup untrusted', async (t) => {
  const f = fixture(t);
  f.write('agent.json', { ...DEFAULT_STATE, installedBy: 'cli', agentVersion: 'cli' });
  f.write('setups.json', { version: 1, setups: [] });
  const trust = readFileSync(join(f.paths.stateRoot, 'agent/setups.json'), 'utf8');
  await f.run({}, { connect: async () => connection(f.events, 'cli') });
  assert.equal(f.read('agent.json').installedBy, 'app');
  assert.equal(readFileSync(join(f.paths.stateRoot, 'agent/setups.json'), 'utf8'), trust);
});

test('first app registration preserves an existing own setup even when its origin differs', async (t) => {
  const f = fixture(t);
  f.write('setups.json', { version: 1, future: 'keep', setups: [{ setupId: null, repoUrl: 'github.com/original/setup', checkout: f.paths.repo, trustedAt: 'original', future: 7 }] });
  const trust = readFileSync(join(f.paths.stateRoot, 'agent/setups.json'), 'utf8');
  await f.run();
  assert.equal(readFileSync(join(f.paths.stateRoot, 'agent/setups.json'), 'utf8'), trust);
});

test('failed app-owned registration and retry preserve mismatched own trust', async (t) => {
  const f = fixture(t);
  await f.run();
  const trust = readFileSync(join(f.paths.stateRoot, 'agent/setups.json'), 'utf8');
  f.origin('https://github.com/other/setup.git');
  f.fail();
  await assert.rejects(f.run({ agentVersion: 'v2' }, { connect: async () => connection(f.events) }), /registration failed/);
  assert.equal(readFileSync(join(f.paths.stateRoot, 'agent/setups.json'), 'utf8'), trust);
  f.recover();
  await f.run({ agentVersion: 'v2' });
  assert.equal(readFileSync(join(f.paths.stateRoot, 'agent/setups.json'), 'utf8'), trust);
});
