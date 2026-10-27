import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { request } from 'node:http';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { Effect, Exit, Scope } from 'effect';
import { configDomain, integrationsDomain } from '@nortuscc/machine';
import { RemoteStore, TailscaleAccess, makeSession, startAgent, type AgentDomains } from '../src/index.ts';
import { makeOperationDispatch, type OperationCaller, type OperationDispatch } from '../src/ipc/operation-dispatch.ts';
import { MAX_RECORD_BYTES } from '../src/ipc/protocol.ts';
import { REMOTE_OPERATIONS, REMOTE_PROTOCOL, serveRemote, tailscaleAddresses } from '../src/remote/listener.ts';
import type { TailscaleState, TsSelf, WhoisResult } from '../src/remote/tailscale.ts';
import { agentMachine } from './support/agent-machine.ts';
import { setupFixture } from './support/setup-fixture.ts';

type Status = { self: TsSelf; peers: [] } | TailscaleState;
const ready = (ips: string[]): Status => ({ self: { nodeId: 'n1', userId: 1, login: 'me@example.com', hostName: 'laptop', dnsName: 'laptop.tail.ts.net.', os: 'macOS', ips }, peers: [] });
const desktop: WhoisResult = { nodeId: 'n2', name: 'desktop.tail.ts.net.', machine: 'desktop', tagged: false, userId: 1, shared: false };
const scope = { kind: 'machine' };

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as { port: number };
    server.close(() => resolve(port));
  });
});

type Reply = { status: number; body: any } | { error: string };
const send = (port: number, options: { host?: string; method?: string; path?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) =>
  new Promise<Reply>((resolve) => {
    const text = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    const req = request({ host: options.host ?? '127.0.0.1', port, method: options.method ?? (text === undefined ? 'GET' : 'POST'), path: options.path ?? '/v1/operation', headers: options.headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) }); } catch { resolve({ status: res.statusCode ?? 0, body }); }
      });
      res.on('error', (e: NodeJS.ErrnoException) => resolve({ error: e.code ?? e.message }));
    });
    req.on('error', (e: NodeJS.ErrnoException) => resolve({ error: e.code ?? e.message }));
    req.end(text);
  });
const operation = (port: number, name: string, input: object, extra: { host?: string; headers?: Record<string, string>; protocol?: number; origin?: unknown } = {}) =>
  send(port, { host: extra.host, headers: extra.headers, body: { protocol: extra.protocol ?? REMOTE_PROTOCOL, origin: 'origin' in extra ? extra.origin : 'app', operation: name, input: { scope, ...input } } });

// Whether this host can listen on IPv6 loopback, which the address-change and two-caller tests use.
const ipv6 = await new Promise<boolean>((resolve) => {
  const server = createServer();
  server.once('error', () => resolve(false));
  server.listen(0, '::1', () => server.close(() => resolve(true)));
});

const waitFor = async (check: () => boolean | Promise<boolean>, what: string) => {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

// One listener on 127.0.0.1 over a temp machine, with a fake Tailscale and a dispatch that records
// its calls. With `real`, calls reach a real agent's dispatch; a remote `skillNow` preview is
// answered with an empty reconcile plan there, so its apply is a real run.
const listen = async (options: { real?: boolean; enabled?: boolean; status?: Status; who?: (addr: string) => WhoisResult | null; whoisMs?: number; now?: () => number } = {}) => {
  const m = agentMachine('/tmp');
  const fixture = setupFixture(join(m.root, 'setup'), {});
  await m.trust();
  const port = await freePort();
  const fake = { status: options.status ?? ready(['127.0.0.1']), who: options.who ?? (() => desktop), whois: [] as string[], statusCalls: 0 };
  const tailscale: TailscaleAccess['Service'] = {
    status: () => Effect.sync(() => { fake.statusCalls++; return fake.status; }),
    whois: (addr) => Effect.sync(() => { fake.whois.push(addr); return fake.who(addr); }).pipe(Effect.delay(options.whoisMs ?? 0)),
  };
  const calls: Array<{ caller: OperationCaller; operation: string; input: any }> = [];
  const logged: string[] = [];
  const requests = { now: 0, max: 0 };
  const listenerScope = Scope.makeUnsafe();
  let local: (caller: OperationCaller, name: string, input: object) => Promise<any> = () => Promise.reject(new Error('no real dispatch'));
  const store = await m.run(Effect.gen(function* () {
    const store = yield* RemoteStore;
    if (options.enabled ?? true) yield* store.setEnabled(true);
    let real: OperationDispatch | undefined;
    if (options.real) {
      const domains: AgentDomains = (paths) => [configDomain, integrationsDomain({ paths, env: {} })];
      const handle = yield* startAgent(domains);
      const session = yield* makeSession(handle, { signal: new AbortController().signal, domains });
      while ((yield* handle.status) === undefined) yield* Effect.sleep('10 millis');
      real = makeOperationDispatch({ session, paths: m.paths, handle, agentVersion: '9.9.9', platform: process.platform });
    }
    const dispatch: OperationDispatch = (caller, name, input: any) => {
      calls.push({ caller, operation: name, input });
      if (!real) return Effect.succeed(name === 'previewChange' ? { planId: 'plan-1' } : { answered: name });
      if (name === 'previewChange' && input.change.kind === 'skillNow') return real(caller, name, { ...input, change: { kind: 'reconcile', only: [] } });
      return real(caller, name, input);
    };
    yield* Effect.forkScoped(serveRemote({ dispatch, tailscale, store, agentVersion: '9.9.9', bind: (ips) => ips, port, log: (line) => logged.push(line), ...(options.now ? { now: options.now } : {}), onRequests: (n) => { requests.now = n; requests.max = Math.max(requests.max, n); } }));
    const context = yield* Effect.context<any>();
    if (real) { const dispatchReal = real; local = (caller, name, input) => Effect.runPromise(dispatchReal(caller, name as never, { scope, ...input }).pipe(Effect.provideContext(context)) as Effect.Effect<unknown>); }
    return store;
  }).pipe(Scope.provide(listenerScope), Effect.provideService(TailscaleAccess, tailscale)), fixture.source);
  const listening = () => Effect.runPromise(store.listening);
  const close = async () => {
    await Effect.runPromise(Scope.close(listenerScope, Exit.void));
    rmSync(m.root, { recursive: true, force: true });
  };
  return { m, port, fake, calls, logged, requests, store, listening, close, local };
};

const withListener = async (options: Parameters<typeof listen>[0], body: (l: Awaited<ReturnType<typeof listen>>) => Promise<void>) => {
  const l = await listen(options);
  try {
    if (options?.enabled !== false && typeof options?.status !== 'string') await waitFor(l.listening, 'the listener');
    await body(l);
  } finally { await l.close(); }
};

test('an allowed caller reads context and hello, and its identity is checked once per minute', async () => {
  await withListener({ real: true }, async ({ port, fake, calls }) => {
    const context = await operation(port, 'getContext', {});
    assert.ok('status' in context && context.status === 200, JSON.stringify(context));
    assert.equal(context.body.ok, true, JSON.stringify(context.body));
    assert.equal(context.body.result.agent.version, '9.9.9');
    assert.deepEqual(calls[0]!.caller, { actor: 'remote', machine: 'desktop', origin: 'app' });
    assert.match(fake.whois[0]!, /^127\.0\.0\.1:\d+$/);
    const hello = await send(port, { path: '/v1/hello' });
    assert.deepEqual('body' in hello && hello.body, { protocol: 1, agentVersion: '9.9.9', machine: { name: 'laptop', os: 'macOS' }, operations: [...REMOTE_OPERATIONS] });
    assert.equal(fake.whois.length, 1);
  });
});

test('a remote skillNow apply runs as the remote actor naming the calling machine', async () => {
  await withListener({ real: true }, async ({ port }) => {
    const preview = await operation(port, 'previewChange', { change: { kind: 'skillNow', source: 'owner/repo', name: 'review', action: 'install' } });
    assert.ok('body' in preview && preview.body.ok, JSON.stringify(preview));
    const applied = await operation(port, 'applyChange', { planId: preview.body.result.planId, requestId: 'remote-request' });
    assert.ok('body' in applied && applied.body.ok, JSON.stringify(applied));
    assert.equal(applied.body.result.status, 'started');
    assert.equal(applied.body.result.run.actor, 'remote');
    assert.equal(applied.body.result.run.remoteMachine, 'desktop');
    assert.equal(applied.body.result.run.remoteOrigin, 'app');
  });
});

test('callers other than another untagged, unshared node of this user are refused with 403', async () => {
  const refused: Array<[string, WhoisResult | null]> = [
    ['self', { ...desktop, nodeId: 'n1' }], ['tagged', { ...desktop, tagged: true }], ['shared', { ...desktop, shared: true }],
    ['other user', { ...desktop, userId: 2 }], ['unknown', null],
  ];
  for (const [what, who] of refused) {
    await withListener({ who: () => who }, async ({ port, calls, logged }) => {
      const reply = await operation(port, 'getContext', {});
      assert.ok('status' in reply, `${what}: ${JSON.stringify(reply)}`);
      assert.equal(reply.status, 403, what);
      assert.equal(reply.body.ok, false);
      assert.equal((await send(port, { path: '/v1/hello' }) as { status: number }).status, 403, what);
      assert.deepEqual(calls, [], what);
      assert.equal(logged.length, 1, what);
      assert.match(logged[0]!, new RegExp(`^refused a remote request from 127\\.0\\.0\\.1: the caller is ${what.replace(' ', '-')}$`));
    });
  }
});

test('requests from a browser or naming another host are refused before any caller check', async () => {
  await withListener({}, async ({ port, calls, fake, logged }) => {
    const origin = await operation(port, 'getContext', {}, { headers: { origin: 'https://example.com' } });
    assert.equal((origin as { status: number }).status, 403);
    const host = await operation(port, 'getContext', {}, { headers: { host: `evil.example:${port}` } });
    assert.equal((host as { status: number }).status, 403);
    assert.deepEqual(calls, []);
    assert.deepEqual(fake.whois, []);
    // One line per address per minute.
    assert.equal(logged.length, 1);
  });
});

test('the listener closes when remote access is turned off', async () => {
  await withListener({}, async ({ port, store, listening }) => {
    assert.equal(((await operation(port, 'getContext', {})) as { status: number }).status, 200);
    await Effect.runPromise(store.setEnabled(false));
    await waitFor(async () => !(await listening()), 'the listener to close');
    assert.deepEqual(await operation(port, 'getContext', {}), { error: 'ECONNREFUSED' });
  });
});

test('remote access on but Tailscale not running opens no listener', async () => {
  await withListener({ status: 'not-running' }, async ({ port, fake, listening }) => {
    await waitFor(() => fake.statusCalls > 0, 'a status read');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await listening(), false);
    assert.deepEqual(await operation(port, 'getContext', {}), { error: 'ECONNREFUSED' });
  });
});

test('remote access off by default asks Tailscale nothing and opens no listener', async () => {
  await withListener({ enabled: false }, async ({ port, fake, listening }) => {
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fake.statusCalls, 0);
    assert.equal(await listening(), false);
    assert.deepEqual(await operation(port, 'getContext', {}), { error: 'ECONNREFUSED' });
  });
});

test('a changed Tailscale address rebinds the listener', { skip: !ipv6 && 'IPv6 loopback is unavailable' }, async () => {
  await withListener({}, async ({ port, fake, store }) => {
    fake.status = ready(['::1']);
    // Turning remote access on again signals the listener as setRemoteAccess does.
    await Effect.runPromise(store.setEnabled(true));
    await waitFor(async () => 'status' in (await operation(port, 'getContext', {}, { host: '::1' })), 'the new address');
    assert.deepEqual(await operation(port, 'getContext', {}), { error: 'ECONNREFUSED' });
  });
});

test('only the remote operations, skillNow previews, own plans and protocol 1 are served', async () => {
  await withListener({}, async ({ port, calls }) => {
    const code = (reply: Reply) => ('body' in reply ? reply.body.error?.code : reply.error);
    assert.equal(code(await operation(port, 'history', { limit: 1 })), 'UNSUPPORTED_OPERATION');
    assert.equal(code(await operation(port, 'setRemoteAccess', { enabled: false })), 'UNSUPPORTED_OPERATION');
    assert.equal(code(await operation(port, 'previewChange', { change: { kind: 'machineIntent', changes: [] } })), 'UNSUPPORTED_OPERATION');
    assert.equal(code(await operation(port, 'applyChange', { planId: 'plan-1', requestId: 'r' })), 'UNSUPPORTED_OPERATION');
    const incompatible = await operation(port, 'getContext', {}, { protocol: 2 });
    assert.equal(code(incompatible), 'INCOMPATIBLE');
    assert.match((incompatible as { body: any }).body.error.message, /protocol 1\b/);
    assert.equal(code(await send(port, { raw: '{nope' })), 'MALFORMED');
    assert.equal(calls.length, 0);
    // A plan this machine previewed for the caller can be applied.
    const preview = await operation(port, 'previewChange', { change: { kind: 'skillNow', source: 'owner/repo', name: 'review', action: 'install' } });
    assert.equal((preview as { body: any }).body.result.planId, 'plan-1');
    assert.equal((await operation(port, 'applyChange', { planId: 'plan-1', requestId: 'r' }) as { body: any }).body.ok, true);
    assert.deepEqual(calls.map((c) => c.operation), ['previewChange', 'applyChange']);
  });
});

test('outside tests the listener binds only Tailscale addresses', () => {
  assert.deepEqual(
    tailscaleAddresses(['0.0.0.0', '::', '127.0.0.1', '::1', '192.168.1.20', '100.63.0.1', '100.128.0.1', '100.101.102.103', 'fd7a:115c:a1e0::1', 'fe80::1']),
    ['100.101.102.103', 'fd7a:115c:a1e0::1']);
});

// Writes `text` on a raw connection and returns what the listener sent before closing it, or
// destroys the connection after `destroyMs`.
const rawSend = (port: number, text: string | Buffer, destroyMs?: number) => new Promise<string>((resolve) => {
  let out = '';
  const socket = connect(port, '127.0.0.1', () => {
    socket.write(text);
    if (destroyMs !== undefined) setTimeout(() => socket.destroy(), destroyMs);
  });
  socket.on('data', (d) => { out += d.toString('utf8'); });
  socket.on('error', () => {});
  socket.on('close', () => resolve(out));
});
const head = (port: number, extra: string) => `POST /v1/operation HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\ncontent-type: application/json\r\n${extra}\r\n`;

test('a body over the cap is refused with 413 by its length or as it streams, without dispatch', async () => {
  await withListener({}, async ({ port, calls }) => {
    const declared = await rawSend(port, head(port, `content-length: ${MAX_RECORD_BYTES + 1}\r\n`) + 'xxxx');
    assert.match(declared, /^HTTP\/1\.1 413 /);
    assert.match(declared, /"OVERSIZED"/);
    const chunk = 'x'.repeat(65_536);
    const chunks = Math.ceil((MAX_RECORD_BYTES + 1) / chunk.length);
    const body = Array.from({ length: chunks }, () => `${chunk.length.toString(16)}\r\n${chunk}\r\n`).join('') + '0\r\n\r\n';
    const streamed = await rawSend(port, head(port, 'transfer-encoding: chunked\r\n') + body);
    assert.match(streamed, /^HTTP\/1\.1 413 /);
    assert.equal(calls.length, 0);
  });
});

test('a caller that leaves mid-body is dropped without dispatch or a lingering request', async () => {
  await withListener({}, async ({ port, calls, requests }) => {
    await rawSend(port, head(port, 'content-length: 100\r\n') + '{"protocol":1', 100);
    await waitFor(() => requests.max === 1 && requests.now === 0, 'the request to settle');
    assert.equal(calls.length, 0);
  });
});

test('concurrent and repeated requests from an unknown caller ask Tailscale once', async () => {
  await withListener({ who: () => null, whoisMs: 50 }, async ({ port, fake, calls }) => {
    const replies = await Promise.all(Array.from({ length: 8 }, () => operation(port, 'getContext', {})));
    assert.ok(replies.every((r) => 'status' in r && r.status === 403), JSON.stringify(replies));
    for (let i = 0; i < 3; i++) assert.equal(((await operation(port, 'getContext', {})) as { status: number }).status, 403);
    assert.equal(fake.whois.length, 1);
    assert.equal(calls.length, 0);
  });
});

test('a plan previewed by one machine cannot be applied by another', { skip: !ipv6 && 'IPv6 loopback is unavailable' }, async () => {
  const nas: WhoisResult = { ...desktop, nodeId: 'n3', name: 'nas.tail.ts.net.', machine: 'nas' };
  await withListener({ status: undefined, who: (addr) => addr.startsWith('[::1]') ? nas : desktop }, async (l) => {
    l.fake.status = ready(['127.0.0.1', '::1']);
    await Effect.runPromise(l.store.setEnabled(true));
    await waitFor(async () => 'status' in (await operation(l.port, 'getContext', {}, { host: '::1' })), 'the second address');
    const preview = await operation(l.port, 'previewChange', { change: { kind: 'skillNow', source: 'owner/repo', name: 'review', action: 'install' } });
    assert.equal((preview as { body: any }).body.result.planId, 'plan-1');
    const other = await operation(l.port, 'applyChange', { planId: 'plan-1', requestId: 'r' }, { host: '::1' });
    assert.equal((other as { body: any }).body.error.code, 'UNSUPPORTED_OPERATION');
    assert.equal((await operation(l.port, 'applyChange', { planId: 'plan-1', requestId: 'r' }) as { body: any }).body.ok, true);
    assert.deepEqual(l.calls.filter((c) => c.operation === 'applyChange').map((c) => c.caller), [{ actor: 'remote', machine: 'desktop', origin: 'app' }]);
  });
});

test('a request must name what started it on the calling machine: its app, CLI or MCP', async () => {
  await withListener({}, async ({ port, calls }) => {
    for (const origin of [undefined, 'remote', 'agent', 'APP', 1]) {
      const reply = await operation(port, 'getContext', {}, { origin });
      assert.ok('body' in reply && reply.body.ok === false, JSON.stringify(reply));
      assert.equal(reply.body.error.code, 'INVALID_INPUT');
    }
    assert.equal(calls.length, 0);
    for (const origin of ['app', 'cli', 'mcp']) assert.equal(((await operation(port, 'getContext', {}, { origin })) as any).body.ok, true);
    assert.deepEqual(calls.map((c) => c.caller), ['app', 'cli', 'mcp'].map((origin) => ({ actor: 'remote', machine: 'desktop', origin })));
  });
});

test('another machine sees only the runs it started here', async () => {
  await withListener({ real: true }, async ({ port, local }) => {
    const own = await local({ actor: 'app' }, 'previewChange', { change: { kind: 'reconcile', only: [] } });
    const localRun = (await local({ actor: 'app' }, 'applyChange', { planId: own.planId, requestId: 'local-request' })).run;
    await waitFor(async () => (await local({ actor: 'app' }, 'getRun', { runId: localRun.runId })).result !== null, 'the local run');
    await waitFor(async () => { try { await local({ actor: 'app' }, 'previewChange', { change: { kind: 'reconcile', only: [] } }); return true; } catch { return false; } }, 'the agent to be idle');
    const preview = await operation(port, 'previewChange', { change: { kind: 'skillNow', source: 'owner/repo', name: 'review', action: 'install' } });
    const remoteRun = ((await operation(port, 'applyChange', { planId: (preview as any).body.result.planId, requestId: 'remote-request' })) as any).body.result.run;
    const listed: any = await operation(port, 'listRuns', { limit: 10 });
    assert.deepEqual(listed.body.result.runs.map((r: any) => r.runId), [remoteRun.runId]);
    assert.equal(listed.body.result.nextBefore, null);
    const hidden: any = await operation(port, 'getRun', { runId: localRun.runId });
    const unknown: any = await operation(port, 'getRun', { runId: 'no-such-run' });
    assert.deepEqual([hidden.body.ok, hidden.body.error.code, hidden.body.error.message], [false, unknown.body.error.code, unknown.body.error.message]);
    assert.equal(((await operation(port, 'listRuns', { limit: 10, before: localRun.runId })) as any).body.error.code, 'UNKNOWN_RUN');
    assert.equal(((await operation(port, 'getRun', { runId: remoteRun.runId })) as any).body.result.runId, remoteRun.runId);
    assert.equal((await local({ actor: 'app' }, 'listRuns', { limit: 10 })).runs.length, 2);
  });
});

test('caller checks and previewed plans expire by the listener clock, not the wall clock', async () => {
  const clock = { now: 0 };
  const wall = Date.now;
  // A wall clock stuck in the past must not keep an identity or a plan alive.
  Date.now = () => 0;
  try {
    await withListener({ now: () => clock.now }, async ({ port, fake }) => {
      const preview = await operation(port, 'previewChange', { change: { kind: 'skillNow', source: 'owner/repo', name: 'review', action: 'install' } });
      assert.equal((preview as { body: any }).body.ok, true);
      assert.equal(fake.whois.length, 1);
      clock.now = 60_000;
      await operation(port, 'getContext', {});
      assert.equal(fake.whois.length, 2, 'the caller is checked again after a minute');
      clock.now = 600_000;
      const applied = await operation(port, 'applyChange', { planId: 'plan-1', requestId: 'r' });
      assert.equal((applied as { body: any }).body.error?.code, 'UNSUPPORTED_OPERATION', 'the plan expired');
    });
  } finally { Date.now = wall; }
});
