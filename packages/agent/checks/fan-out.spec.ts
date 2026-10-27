import { createHash } from 'node:crypto';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { Effect, Exit, Layer, ManagedRuntime, Scope, Semaphore } from 'effect';
import { loadProfile, nodeFiles } from '@nortuscc/profile-engine';
import { HistoryStore, OverridesStore, Processes, inspectSkills, probeUndeclared, skillsDomain, type SkillCandidate } from '@nortuscc/machine';
import { AgentStateStore, RemoteStore, SetupSource, TailscaleAccess, agentLayer, type AgentServices } from '../src/index.ts';
import type { AgentHandle } from '../src/agent.ts';
import { makeSession } from '../src/ipc/session.ts';
import { makeOperationDispatch, type OperationCaller, type OperationDispatch } from '../src/ipc/operation-dispatch.ts';
import { agentSkillInstaller } from '../src/skill-installer.ts';
import { serveRemote } from '../src/remote/listener.ts';
import { peerClient } from '../src/remote/peer-client.ts';
import type { KnownMachine } from '../src/remote/remote-store.ts';
import type { TsPeer } from '../src/remote/tailscale.ts';
import { agentMachine } from './support/agent-machine.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as { port: number };
    server.close(() => resolve(port));
  });
});
const listening = <S extends Server | HttpServer>(server: S) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
const until = async <A>(read: () => Promise<A>, done: (value: A) => boolean, what: string): Promise<A> => {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

const noSource = Layer.succeed(SetupSource, { fetch: Effect.die('no source'), load: () => Effect.die('no source'), effective: () => Effect.die('no source'), current: Effect.die('no source') });
const contentText = '---\nname: design-review\ndescription: Review design\n---\n';
const contentBlob = createHash('sha1').update(`blob ${Buffer.byteLength(contentText)}\0${contentText}`).digest('hex');
const candidate: SkillCandidate = { source: 'owner/repo', revision: 'a'.repeat(40), sourceDir: 'skills/design-review', selectorName: 'design-review', installedName: 'design-review', blob: contentBlob, tree: 'c'.repeat(40), description: 'Design review', internal: false, metadata: {} };
const nativeVerified = { verified: true, physical: { status: 'present' as const, path: '/isolated/SKILL.md' }, catalog: { status: 'present' as const }, restrictions: { status: 'no-known-denial' as const, diagnostics: [] },
  limits: { selectedSource: 'not-attested' as const, invocationAuthorization: 'not-attested' as const, configRoot: 'requested-environment-only' as const, managedStartup: 'remains-active' as const } };

const peer = (nodeId: string, hostName: string, extra: Partial<TsPeer> = {}): TsPeer =>
  ({ nodeId, hostName, dnsName: `${hostName}.tail.ts.net.`, os: 'linux', ips: ['127.0.0.1'], online: true, ...extra });

type MachineOptions = {
  readonly nodeId: string;
  readonly name: string;
  readonly manifest: string;
  // Tailscale's peers as this machine sees them, read on every status call.
  readonly peers?: () => TsPeer[];
  // Where this machine's peer client finds a peer's listener.
  readonly ports?: Map<string, number>;
  // Serve remote requests, admitting callers as the machine `caller` names.
  readonly serve?: { readonly caller: string };
  readonly remote?: { readonly enabled: boolean; readonly known?: ReadonlyArray<KnownMachine> };
  // Holds the skills installer until it resolves.
  readonly installGate?: () => Promise<void>;
};

// One in-process agent: a temp machine with a fake Tailscale, a counted fake installer and a
// session; optionally serving remote requests on 127.0.0.1.
const machine = async (options: MachineOptions) => {
  const m = agentMachine();
  m.write(join(m.paths.repo, 'skills-manifest.txt'), options.manifest);
  const tailscale: TailscaleAccess['Service'] = {
    status: () => Effect.sync(() => ({
      self: { nodeId: options.nodeId, userId: 1, login: 'me@example.com', hostName: options.name, dnsName: `${options.name}.tail.ts.net.`, os: 'linux', ips: ['127.0.0.1'] },
      peers: options.peers?.() ?? [],
    })),
    whois: () => Effect.succeed(options.serve ? { nodeId: 'caller-node', name: `${options.serve.caller}.tail.ts.net.`, machine: options.serve.caller, tagged: false, userId: 1, shared: false } : null),
  };
  const runtime = ManagedRuntime.make(Layer.merge(agentLayer(m.paths, { tailscale: Layer.succeed(TailscaleAccess, tailscale) }), noSource));
  const scope = Scope.makeUnsafe();
  let installs = 0;
  const port = options.serve ? await freePort() : 0;
  const peers = peerClient({ address: (p) => ({ host: '127.0.0.1', port: options.ports?.get(p.nodeId) ?? 1 }), helloTimeoutMs: 300 });
  let inspections = 0;
  const runtimeFile = join(m.paths.stateRoot, 'agent', 'runtime.json');
  m.write(runtimeFile, JSON.stringify({ agentVersion: '9.9.9', appVersion: '0.1.6', target: 'darwin-arm64' }));
  const dispatch = await runtime.runPromise(Effect.gen(function* () {
    // An app-owned agent, so MCP callers are admitted.
    yield* AgentStateStore.use((s) => s.update((state) => ({ ...state, installedBy: 'app', agentVersion: '9.9.9', appPath: '/tmp/Test.app/Contents/MacOS/Test' })));
    if (options.remote) {
      const store = yield* RemoteStore;
      yield* store.setEnabled(options.remote.enabled);
      if (options.remote.known) yield* store.remember(options.remote.known);
    }
    const context = yield* Effect.context<AgentServices>();
    const fresh = Effect.gen(function* () {
      const overrides = yield* (yield* OverridesStore).read;
      const desired = yield* loadProfile(m.paths.repo, { overrides }).pipe(Effect.provide(nodeFiles));
      const skills = yield* inspectSkills(desired);
      const undeclared = yield* probeUndeclared(desired, { targets: ['claude'], installed: [], hookCommands: [] });
      return { paths: m.paths, desired, report: { desired, items: [...skills.items, ...undeclared.items], probeErrors: skills.probeErrors }, domains: [skillsDomain], trusted: true, revision: null };
    }).pipe(Effect.provideContext(context));
    // The latest job's status: a new one only when the machine inspects.
    const status = () => ({ at: new Date().toISOString(), policy: 'manual', paused: null, trusted: true, pending: [], drift: [], conflicts: [], probeErrors: [] });
    let latest = status();
    const permit = yield* Semaphore.make(1);
    const exclusive = <A, E, R>(effect: Effect.Effect<A, E, R>) => permit.withPermit(effect);
    const handle = { inspection: fresh, freshInspection: Effect.map(fresh, (inspection) => ({ inspection, status: status() })), generation: Effect.succeed(1), exclusive, withJobMutation: exclusive,
      status: Effect.sync(() => latest), request: () => Effect.sync(() => { inspections++; latest = status(); return latest; }) } as unknown as AgentHandle;
    const processes = yield* Processes;
    const session = yield* makeSession(handle, { signal: new AbortController().signal, domains: () => [skillsDomain],
      skillCandidates: (input) => Effect.sync(() => { input.observeTree?.(candidate, [{ path: 'SKILL.md', sha: candidate.blob, mode: '100644' }]); return { ok: true, source: candidate.source, revision: candidate.revision, candidates: [candidate] }; }),
      skillVerification: {
        content: () => Effect.succeed({ verified: true, problems: [] }),
        codex: () => Effect.succeed({ verified: true, enabled: true, path: '/isolated/SKILL.md' }),
        claude: () => Effect.succeed(nativeVerified),
      },
    }).pipe(Effect.provide(agentSkillInstaller({ home: join(m.root, 'home') })),
      Effect.provideService(Processes, { ...processes, run: (command) => command.cmd !== 'npx' ? processes.run(command)
        : Effect.promise(async () => { installs++; await options.installGate?.(); return { code: 0, stdout: '' }; }) }));
    const dispatch = makeOperationDispatch({ session, paths: m.paths, handle, agentVersion: '9.9.9', platform: 'darwin', peers,
      appRuntime: { version: '0.1.6', runtimeId: '9.9.9', appDirectory: '/tmp/Test.app/Contents/MacOS', platform: 'darwin', target: 'darwin-arm64', metadataPath: runtimeFile } });
    if (options.serve) {
      const store = yield* RemoteStore;
      yield* store.setEnabled(true);
      yield* Effect.forkScoped(serveRemote({ dispatch, tailscale, store, agentVersion: '9.9.9', bind: (ips) => ips, port, log: () => {} }));
      while (!(yield* store.listening)) yield* Effect.sleep('10 millis');
    }
    return dispatch;
  }).pipe(Scope.provide(scope)));
  cleanups.push(async () => {
    await runtime.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
    rmSync(m.root, { recursive: true, force: true });
  });
  const call = (name: Parameters<OperationDispatch>[1], input: object, caller: OperationCaller = { actor: 'app' }): Promise<any> =>
    runtime.runPromise(dispatch(caller, name, { scope: { kind: 'machine' }, ...input }));
  const fails = (name: Parameters<OperationDispatch>[1], input: object): Promise<{ code: string; message: string }> =>
    runtime.runPromise(Effect.flip(dispatch({ actor: 'app' }, name, { scope: { kind: 'machine' }, ...input })) as Effect.Effect<any, never, AgentServices>);
  const history = () => runtime.runPromise(HistoryStore.use((h) => h.read));
  const known = () => runtime.runPromise(RemoteStore.use((s) => s.get)).then((s) => s.known);
  return { m, port, call, fails, history, known, installs: () => installs, inspections: () => inspections };
};

// Machine B serving remote requests from machine A; A's Tailscale lists B.
const pair = async (b: { manifest?: string; installGate?: () => Promise<void> } = {}, a: { peers?: TsPeer[]; ports?: [string, number][]; known?: ReadonlyArray<KnownMachine> } = {}) => {
  const B = await machine({ nodeId: 'node-b', name: 'machine-b', manifest: b.manifest ?? '[owner/repo] optional\nreview\n', serve: { caller: 'machine-a' }, installGate: b.installGate });
  const ports = new Map<string, number>([['node-b', B.port], ...(a.ports ?? [])]);
  // Machine A, or A again after its agent restarted (it keeps no memory of earlier fan-outs).
  const caller = () => machine({ nodeId: 'node-a', name: 'machine-a', manifest: '[owner/repo] optional\nreview\n', ports,
    peers: () => [peer('node-b', 'machine-b'), ...(a.peers ?? [])], remote: { enabled: false, known: a.known } });
  const A = await caller();
  return { A, B, caller };
};

const install = (machines: string[] | 'all', requestId = 'request-1', name = 'review') =>
  ({ requestId, source: 'owner/repo', name, action: 'install', machines });
const runOn = (A: Awaited<ReturnType<typeof machine>>, machineRef: string, runId: string) =>
  until(() => A.call('machineRun', { machine: machineRef, runId }), (run) => run.result !== null, `the run on ${machineRef}`);
const mcp = { actor: 'mcp', runtimeId: '9.9.9' } as const;

// A Windows peer whose agent accepts connections but never answers, as one whose app is closed may.
const silent = async () => {
  const sockets: Socket[] = [];
  const server = createServer((socket) => { sockets.push(socket); });
  const port = await listening(server);
  cleanups.push(() => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }));
  return port;
};
// A peer whose agent speaks a newer remote protocol.
const newer = async () => {
  const server = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ protocol: 2, agentVersion: '99.0.0', machine: { name: 'machine-i', os: 'linux' }, operations: [] }));
  });
  const port = await listening(server);
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return port;
};

test('myMachines lists remembered machines and those that answer now, and remembers the reachable; the rest are not set up', async () => {
  const windows = await silent();
  const incompatible = await newer();
  const closed = await freePort();
  const { A } = await pair({}, {
    peers: [peer('node-c', 'machine-c', { online: false }), peer('node-w', 'machine-w', { os: 'windows' }), peer('node-i', 'machine-i'), peer('node-r', 'machine-r'),
      peer('node-k', 'machine-k'), peer('node-m', 'machine-m', { os: 'macOS', online: false }), peer('node-p', 'phone', { os: 'iOS', online: false }), peer('node-t', 'tablet', { os: 'android' })],
    ports: [['node-w', windows], ['node-i', incompatible], ['node-r', closed], ['node-k', closed], ['node-t', closed]],
    known: [{ nodeId: 'node-c', name: 'machine-c', os: 'linux', lastReachedAt: '2026-10-01T00:00:00.000Z' }, { nodeId: 'node-gone', name: 'old-laptop', os: 'macOS', lastReachedAt: '2026-09-01T00:00:00.000Z' },
      { nodeId: 'node-k', name: 'machine-k', os: 'linux', lastReachedAt: '2026-10-02T00:00:00.000Z' }],
  });
  const result = await A.call('myMachines', {});
  assert.equal(result.tailscale, 'ready');
  assert.deepEqual(result.self, { nodeId: 'node-a', name: 'machine-a', os: 'linux' });
  const reach = Object.fromEntries(result.machines.map((m: any) => [m.nodeId, [m.name, m.reach]]));
  assert.deepEqual(reach, {
    'node-b': ['machine-b', 'ok'], 'node-c': ['machine-c', 'offline'], 'node-gone': ['old-laptop', 'offline'],
    'node-i': ['machine-i', 'incompatible'], 'node-k': ['machine-k', 'remote-off'],
  });
  // Peers that never answered, on desktop systems only.
  assert.deepEqual(result.notSetUp, [
    { nodeId: 'node-m', name: 'machine-m', os: 'macOS' }, { nodeId: 'node-r', name: 'machine-r', os: 'linux' }, { nodeId: 'node-w', name: 'machine-w', os: 'windows' },
  ]);
  const byId = (id: string) => result.machines.find((m: any) => m.nodeId === id);
  assert.equal(byId('node-c').lastReachedAt, '2026-10-01T00:00:00.000Z');
  assert.equal(byId('node-i').lastReachedAt, null);
  assert.ok(Date.parse(byId('node-b').lastReachedAt) > Date.parse('2026-10-26T00:00:00.000Z'));
  const known = await A.known();
  assert.deepEqual(known.map((k) => k.nodeId).sort(), ['node-b', 'node-c', 'node-gone', 'node-k']);
  assert.equal(known.find((k) => k.nodeId === 'node-b')?.name, 'machine-b');
});

test('a Windows machine whose app is closed stays a column once it has been reached', async () => {
  const windows = await silent();
  const { A } = await pair({}, { peers: [peer('node-w', 'machine-w', { os: 'windows' })], ports: [['node-w', windows]],
    known: [{ nodeId: 'node-w', name: 'machine-w', os: 'windows', lastReachedAt: '2026-10-01T00:00:00.000Z' }] });
  const result = await A.call('myMachines', {});
  assert.deepEqual(result.machines.find((m: any) => m.nodeId === 'node-w')?.reach, 'app-closed');
  assert.deepEqual(result.notSetUp, []);
});

test('this machine\'s own node ID names this machine', async () => {
  const { A, B } = await pair();
  const skills = await A.call('machineSkills', { machine: 'node-a' });
  assert.ok(skills.skills.some((s: any) => s.name === 'review'));
  const result = await A.call('applySkillOnMachines', install(['node-a']));
  assert.deepEqual(result.results.map((r: any) => [r.machine, r.name, r.outcome.status]), [['node-a', 'machine-a', 'started']]);
  assert.equal((await runOn(A, 'node-a', result.results[0].outcome.runId)).state, 'succeeded');
  assert.equal(B.installs(), 0);
});

for (const [who, caller] of [['app', { actor: 'app' }], ['mcp', mcp]] as const) test(`installing from ${who} on another machine and this one starts a run on each; the target records the calling machine and ${who}`, async () => {
  const { A, B } = await pair();
  const result = await A.call('applySkillOnMachines', install(['node-b', 'this']), caller);
  assert.deepEqual(result.results.map((r: any) => [r.machine, r.name, r.outcome.status]), [['node-b', 'machine-b', 'started'], ['this', 'machine-a', 'started']]);
  const remote = await runOn(A, 'node-b', result.results[0].outcome.runId);
  assert.equal(remote.state, 'succeeded', JSON.stringify(remote.result));
  assert.deepEqual([remote.actor, remote.remoteMachine, remote.remoteOrigin], ['remote', 'machine-a', who]);
  const local = await runOn(A, 'this', result.results[1].outcome.runId);
  assert.equal(local.state, 'succeeded', JSON.stringify(local.result));
  assert.deepEqual([local.actor, local.remoteMachine, local.remoteOrigin], [who, undefined, undefined]);
  const events = (await B.history()).filter((e) => 'runId' in e && e.runId === remote.runId);
  assert.ok(events.length > 0 && events.every((e) => e.actor === 'remote' && e.remoteMachine === 'machine-a' && e.remoteOrigin === who), JSON.stringify(events));
  const listed = (await B.call('history', { limit: 50 })).events.filter((e: any) => e.runId === remote.runId);
  assert.ok(listed.length > 0 && listed.every((e: any) => e.remoteOrigin === who), JSON.stringify(listed));
  assert.equal(B.installs(), 1);
  assert.equal(A.installs(), 1);
});

test('an offline or refusing machine gets its own outcome while the others still start', async () => {
  const closed = await freePort();
  const { A, B } = await pair({ manifest: '[other/repo]\nreview\n' }, {
    peers: [peer('node-c', 'machine-c', { online: false }), peer('node-r', 'machine-r')], ports: [['node-r', closed]],
  });
  const result = await A.call('applySkillOnMachines', install(['node-b', 'node-c', 'node-r', 'node-unknown', 'this']));
  const outcomes = Object.fromEntries(result.results.map((r: any) => [r.machine, r.outcome]));
  assert.equal(outcomes['node-b'].status, 'refused');
  assert.match(outcomes['node-b'].reason, /other\/repo/);
  assert.deepEqual(outcomes['node-c'], { status: 'offline' });
  assert.deepEqual(outcomes['node-r'], { status: 'offline' });
  assert.equal(outcomes['node-unknown'].status, 'refused');
  assert.equal(outcomes.this.status, 'started');
  assert.equal(B.installs(), 0);
});

test('a target whose install outlives the call reports started, and the run finishes later', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { A } = await pair({ installGate: () => gate });
  const result = await A.call('applySkillOnMachines', install(['node-b']));
  assert.equal(result.results[0].outcome.status, 'started');
  const runId = result.results[0].outcome.runId;
  const pending = await A.call('machineRun', { machine: 'node-b', runId });
  assert.ok(['accepted', 'running'].includes(pending.state), pending.state);
  release();
  assert.equal((await runOn(A, 'node-b', runId)).state, 'succeeded');
});

test('resubmitting the same request returns the same runs, also after the calling agent restarts', async () => {
  const { A, B, caller } = await pair();
  const first = await A.call('applySkillOnMachines', install(['node-b', 'this'], 'same-request'));
  const second = await A.call('applySkillOnMachines', install(['node-b', 'this'], 'same-request'));
  assert.deepEqual(second.results, first.results);
  assert.ok(first.results.every((r: any) => r.outcome.status === 'started'));
  await runOn(A, 'node-b', first.results[0].outcome.runId);
  // A fresh agent previews again; B refuses the new plan under the same request ID, so the run it already has is found.
  const restarted = await caller();
  const again = await restarted.call('applySkillOnMachines', install(['node-b'], 'same-request'));
  assert.deepEqual(again.results[0].outcome, first.results[0].outcome);
  assert.equal(B.installs(), 1);
});

test('the same request ID from another kind of caller is another request', async () => {
  const { A } = await pair();
  const app = await A.call('applySkillOnMachines', install(['node-b'], 'shared-id'));
  await runOn(A, 'node-b', app.results[0].outcome.runId);
  const cli = await A.call('applySkillOnMachines', install(['node-b'], 'shared-id'), { actor: 'cli' });
  assert.equal(cli.results[0].outcome.status, 'started');
  assert.notEqual(cli.results[0].outcome.runId, app.results[0].outcome.runId);
});

test('a grid read leaves a pending preview on the target usable', async () => {
  const { A, B } = await pair();
  const preview = await B.call('previewChange', { change: { kind: 'skillNow', source: 'owner/repo', name: 'review', action: 'install' } });
  await A.call('machineSkills', { machine: 'node-b' });
  const applied = await B.call('applyChange', { planId: preview.planId, requestId: 'local-after-read' });
  assert.equal(applied.status, 'started');
});

test('a grid read during a run on the target answers from its last inspection; only fresh inspects again', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { A, B } = await pair({ installGate: () => gate });
  const before = B.inspections();
  const first = await A.call('machineSkills', { machine: 'node-b' });
  const started = await A.call('applySkillOnMachines', install(['node-b']));
  await until(() => A.call('machineRun', { machine: 'node-b', runId: started.results[0].outcome.runId }), (run) => run.state === 'running', 'the run to start');
  const during = await A.call('machineSkills', { machine: 'node-b' });
  assert.ok(during.skills.some((s: any) => s.name === 'review'));
  assert.equal(during.inspectedAt, first.inspectedAt);
  assert.equal(B.inspections(), before);
  // A machine busy with a run answers a fresh read from its last check, and says so.
  const busy = await A.call('machineSkills', { machine: 'node-b', fresh: true });
  assert.equal(busy.busy, true);
  assert.equal(busy.inspectedAt, first.inspectedAt);
  assert.ok(busy.skills.some((s: any) => s.name === 'review'));
  assert.equal(B.inspections(), before);
  release();
  await runOn(A, 'node-b', started.results[0].outcome.runId);
  await until(async () => B.inspections(), (n) => n > before, 'the inspection after the run');
  const settled = B.inspections();
  const fresh = await A.call('machineSkills', { machine: 'node-b', fresh: true });
  assert.equal(B.inspections(), settled + 1);
  assert.ok(Date.parse(fresh.inspectedAt) > Date.parse(first.inspectedAt));
  assert.equal(fresh.busy, undefined);
});

test('"all" installs on every reachable machine and this one', async () => {
  const { A } = await pair({}, { peers: [peer('node-c', 'machine-c', { online: false })] });
  const result = await A.call('applySkillOnMachines', install('all'));
  assert.deepEqual(result.results.map((r: any) => [r.machine, r.outcome.status]), [['node-b', 'started'], ['this', 'started']]);
});

test('a verified addition offers sharing with my machines only with remote access on and a known machine', async () => {
  for (const [remote, available] of [
    [{ enabled: false, known: [{ nodeId: 'node-b', name: 'machine-b', os: 'linux', lastReachedAt: '2026-10-01T00:00:00.000Z' }] }, false],
    [{ enabled: true }, false],
    [{ enabled: true, known: [{ nodeId: 'node-b', name: 'machine-b', os: 'linux', lastReachedAt: '2026-10-01T00:00:00.000Z' }] }, true],
  ] as const) {
    const A = await machine({ nodeId: 'node-a', name: 'machine-a', manifest: '[owner/repo] exact\nunrelated\n', remote });
    const result = await A.call('applySkillOnMachines', install(['this'], 'share', 'design-review'));
    const run = await runOn(A, 'this', result.results[0].outcome.runId);
    assert.equal(run.installation?.state, 'verified', JSON.stringify(run.result));
    const share = run.installation.nextActions.find((a: any) => a.kind === 'share_with_my_machines');
    assert.equal(share.capability.available, available, JSON.stringify(remote));
  }
});

test('machineSkills lists declared skills and hand-installed ones with the source their lock records', async () => {
  const { A, B } = await pair();
  B.m.write(join(B.m.paths.agentsSkills, 'handmade', 'SKILL.md'), '# handmade\n');
  B.m.write(join(B.m.paths.agentsSkills, 'scratch', 'SKILL.md'), '# scratch\n');
  B.m.write(join(B.m.paths.agentsSkills, '..', '.skill-lock.json'), JSON.stringify({ version: 3, skills: { handmade: { source: 'Someone/Tools' } } }));
  B.m.write(join(B.m.paths.claude, 'skills', 'direct', 'SKILL.md'), '# direct\n');
  for (const fresh of [false, true]) {
    const result = await A.call('machineSkills', { machine: 'node-b', fresh });
    assert.ok(Number.isFinite(Date.parse(result.inspectedAt)));
    const rows = Object.fromEntries(result.skills.map((s: any) => [s.name, s]));
    assert.deepEqual(rows.handmade, { source: 'someone/tools', name: 'handmade', state: 'undeclared', choice: null, from: null });
    assert.deepEqual(rows.scratch, { source: null, name: 'scratch', state: 'undeclared', choice: null, from: null });
    assert.deepEqual(rows.direct, { source: null, name: 'direct', state: 'undeclared', choice: null, from: null });
    assert.equal(rows.review.state, 'profile-off');
    assert.equal(rows.review.source, 'owner/repo');
    assert.equal(rows.review.choice, null);
  }
  const done = await A.call('applySkillOnMachines', install(['node-b']));
  await runOn(A, 'node-b', done.results[0].outcome.runId);
  B.m.write(join(B.m.paths.agentsSkills, 'review', 'SKILL.md'), '# review\n');
  const after = (await A.call('machineSkills', { machine: 'node-b', fresh: true })).skills.find((s: any) => s.name === 'review');
  assert.deepEqual([after.state, after.choice], ['installed', true]);
  const local = (await A.call('machineSkills', { machine: 'this' })).skills.find((s: any) => s.name === 'review');
  assert.equal(local.state, 'profile-off');
});

test('reading an unreachable machine fails as offline', async () => {
  const closed = await freePort();
  const { A } = await pair({}, { peers: [peer('node-r', 'machine-r'), peer('node-c', 'machine-c', { online: false })], ports: [['node-r', closed]] });
  for (const target of ['node-r', 'node-c']) {
    assert.equal((await A.fails('machineRun', { machine: target, runId: 'run-1' })).code, 'OFFLINE');
    assert.equal((await A.fails('machineSkills', { machine: target })).code, 'OFFLINE');
  }
});
