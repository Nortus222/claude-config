import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import { Deferred, Effect, Exit, Fiber, Layer, Scope } from 'effect';
import { configDomain, DecisionsStore, HistoryStore, historyStore, integrationsDomain } from '@nortuscc/machine';
import {
  AgentStateStore, makeSession, MAX_RECORD_BYTES, runAgent, serveIpc, SetupSource, startAgent, ServeFailed,
  type AgentDomain, type AgentDomains,
} from '../src/index.ts';
import { agentMachine } from './support/agent-machine.ts';
import { accept, EFFORT, HEAD, setupFixture } from './support/setup-fixture.ts';

const MODEL = 'setting:claude:settings.json#model';
const THEME_KEY = 'config:claude:settings.json#theme';
const EFFORT_KEY = 'config:claude:settings.json#effortLevel';
const MODEL_KEY = 'config:claude:settings.json#model';

type Wire = { readonly [key: string]: any };

// One client connection: every record it received, in order.
type Client = {
  readonly socket: Socket;
  readonly records: Array<Wire>;
  readonly send: (record: unknown) => void;
  readonly sendRaw: (text: string) => void;
  // The first record from index `from` on that matches.
  readonly waitFor: (match: (record: Wire) => boolean, from?: number) => Promise<Wire>;
  readonly closed: Promise<void>;
};

const connect = (path: string) =>
  new Promise<Client>((resolve, reject) => {
    const socket = createConnection(path);
    const records: Array<Wire> = [];
    let pending = '';
    let notify = () => {};
    let ended = false;
    const closed = new Promise<void>((done) => socket.once('close', () => {
      ended = true;
      notify();
      done();
    }));
    socket.on('data', (chunk) => {
      pending += chunk.toString('utf8');
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        records.push(JSON.parse(pending.slice(0, newline)));
        pending = pending.slice(newline + 1);
      }
      notify();
    });
    const waitFor = (match: (record: Wire) => boolean, from = 0) =>
      new Promise<Wire>((done, fail) => {
        const timer = setTimeout(() => fail(new Error(`no matching record; got ${JSON.stringify(records.slice(from))}`)), 20_000);
        const check = () => {
          const found = records.slice(from).find(match);
          if (found) {
            clearTimeout(timer);
            done(found);
          } else if (ended) {
            clearTimeout(timer);
            fail(new Error(`closed without a matching record; got ${JSON.stringify(records.slice(from))}`));
          } else notify = check;
        };
        check();
      });
    socket.once('connect', () => resolve({
      socket, records, waitFor, closed,
      send: (record) => socket.write(JSON.stringify(record) + '\n'),
      sendRaw: (text) => socket.write(text),
    }));
    socket.once('error', reject);
  });

let ids = 0;
// Sends `command` and answers its response.
const ask = async (client: Client, command: object) => {
  const id = `r${++ids}`;
  const from = client.records.length;
  client.send({ version: 3, id, ...command });
  return client.waitFor((r) => r.id === id, from);
};

type Options = {
  readonly paused?: boolean;
  readonly config?: AgentDomain;
  readonly handshakeMs?: number;
  // The start job's fetch waits for this, so the agent has no status until it opens.
  readonly starting?: Deferred.Deferred<void>;
};

// A trusted machine whose head adds two accepted settings keys, as in the session spec, under a
// short temp root for its socket.
const prepare = async (options: Options = {}) => {
  const m = agentMachine('/tmp');
  const fixture = setupFixture(join(m.root, 'setup'), {
    headFiles: { 'claude/settings.keys.json': JSON.stringify({ theme: 'dark', effortLevel: 'high', model: 'opus' }) + '\n' },
  });
  m.write(join(m.paths.claude, 'settings.json'), JSON.stringify({ theme: 'dark' }) + '\n');
  await m.trust();
  if (options.paused) {
    await m.run(AgentStateStore.use((s) => s.update((state) => ({ ...state, paused: { reason: 'test pause', at: '2026-10-06T00:00:00.000Z' } }))));
  }
  for (const itemId of [EFFORT, MODEL]) await m.run(DecisionsStore.use((d) => d.record(accept(itemId))));
  const domains: AgentDomains = (paths) => [options.config ?? configDomain, integrationsDomain({ paths, env: {} })];
  const starting = options.starting;
  const source = starting === undefined ? fixture.source
    : Layer.succeed(SetupSource, { ...fixture.service, fetch: Effect.andThen(Deferred.await(starting), fixture.service.fetch) });
  const dir = join(m.paths.stateRoot, 'agent');
  return { m, fixture, domains, source, dir, socketPath: join(dir, 'agent.sock'), tokenPath: join(dir, 'agent.token') };
};

// `prepare`'s machine served on its socket. `open` connects and says hello. The agent, the session
// and the server run in a scope the test closes; unless `starting` holds it back, the start job has
// finished before this answers.
const serverMachine = async (options: Options = {}) => {
  const { m, domains, source, dir, socketPath, tokenPath } = await prepare(options);
  let shutdowns = 0;
  const scope = Scope.makeUnsafe();
  await m.run(Effect.gen(function* () {
    const agent = yield* startAgent(domains);
    const session = yield* makeSession(agent, { signal: new AbortController().signal, domains });
    yield* serveIpc({
      paths: m.paths, handle: agent, session, agentVersion: '9.9.9', onShutdown: () => void shutdowns++,
      ...(options.handshakeMs === undefined ? {} : { handshakeMs: options.handshakeMs }),
    });
    if (options.starting === undefined) while ((yield* agent.status) === undefined) yield* Effect.sleep('10 millis');
  }).pipe(Scope.provide(scope)), source);
  const token = readFileSync(tokenPath, 'utf8');
  const clients: Array<Client> = [];
  const open = async (client: 'app' | 'cli' = 'app') => {
    const c = await connect(socketPath);
    clients.push(c);
    const hello = await ask(c, { command: 'hello', token, client });
    assert.equal(hello.ok, true, JSON.stringify(hello));
    return c;
  };
  const close = async () => {
    for (const c of clients) c.socket.destroy();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  };
  return { m, dir, socketPath, tokenPath, token, open, clients, close, shutdowns: () => shutdowns };
};

const withServer = async (options: Options, body: (s: Awaited<ReturnType<typeof serverMachine>>) => Promise<void>) => {
  const s = await serverMachine(options);
  try {
    await body(s);
  } finally {
    await s.close();
  }
};

// Queues a shutdown reply behind enough output to fill a paused Unix socket's buffers.
const blockedShutdown = async (s: Awaited<ReturnType<typeof serverMachine>>) => {
  const c = await s.open();
  const observer = await s.open();
  c.socket.pause();
  const id = `r${++ids}`;
  c.sendRaw('{\n'.repeat(32_768) + JSON.stringify({ version: 3, id, command: 'shutdown' }) + '\n');
  let status = await ask(observer, { command: 'status' });
  for (let i = 0; i < 100 && status.ok; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    status = await ask(observer, { command: 'status' });
  }
  assert.equal(status.error?.code, 'SHUTDOWN', 'the shutdown request was not handled');
  assert.equal(s.shutdowns(), 0, 'the reply flushed despite the paused client');
  return { c, id };
};

test('a state root too deep for a socket path fails clearly before listening', async () => {
  const m = agentMachine();
  const deep = { ...m.paths, stateRoot: join(m.root, 'd'.repeat(120)) };
  const handle = { onStatus: () => () => {} } as never;
  const exit = await m.run(Effect.exit(Effect.scoped(serveIpc({ paths: deep, handle, session: {} as never, agentVersion: '0', onShutdown: () => {} }))));
  assert.ok(Exit.isFailure(exit));
  const error = exit.cause.reasons.map((r) => (r._tag === 'Fail' ? r.error : undefined)).find((e) => e !== undefined);
  assert.ok(error instanceof ServeFailed);
  assert.match(error.message, /socket path .* too long/);
});

const unixOnly = {
  skip: process.platform === 'win32' ? 'ADR 0019: Windows IPC is unsupported' : false,
};

test('hello with the right token answers the agent; a wrong token or no hello is UNAUTHORIZED and closes', unixOnly, async () => {
  await withServer({}, async (s) => {
    const good = await connect(s.socketPath);
    const hello = await ask(good, { command: 'hello', token: s.token, client: 'app' });
    assert.deepEqual(hello, { version: 3, id: hello.id, ok: true, result: { agentVersion: '9.9.9', protocol: 3, policy: 'notify', paused: null } });
    good.socket.destroy();

    const wrong = await connect(s.socketPath);
    const refused = await ask(wrong, { command: 'hello', token: 'x'.repeat(s.token.length), client: 'cli' });
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'UNAUTHORIZED');
    await wrong.closed;

    const short = await connect(s.socketPath);
    const shorter = await ask(short, { command: 'hello', token: 'abc', client: 'app' });
    assert.equal(shorter.error.code, 'UNAUTHORIZED');
    await short.closed;

    const early = await connect(s.socketPath);
    const before = await ask(early, { command: 'status' });
    assert.equal(before.error.code, 'UNAUTHORIZED');
    await early.closed;
  });
});

test('unknown fields are INVALID_REQUEST, an oversized record is OVERSIZED on a usable connection, a path as a key is UNKNOWN_KEY', unixOnly, async () => {
  await withServer({}, async (s) => {
    const c = await s.open();
    const extra = await ask(c, { command: 'status', path: '/etc' });
    assert.equal(extra.error.code, 'INVALID_REQUEST');

    const from = c.records.length;
    c.sendRaw('x'.repeat(MAX_RECORD_BYTES + 10) + '\n');
    const oversized = await c.waitFor((r) => r.ok === false, from);
    assert.equal(oversized.error.code, 'OVERSIZED');
    const garbled = c.records.length;
    c.sendRaw('{not json\n');
    assert.equal((await c.waitFor((r) => r.ok === false, garbled)).error.code, 'MALFORMED');

    const inspected = await ask(c, { command: 'inspect' });
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    const path = await ask(c, { command: 'preview', exclude: [join(s.m.paths.claude, 'settings.json')] });
    assert.equal(path.error.code, 'UNKNOWN_KEY');
  });
});

test('status, setPolicy, resume and decide answer the resulting status', unixOnly, async () => {
  await withServer({ paused: true }, async (s) => {
    const c = await s.open();
    const status = await ask(c, { command: 'status' });
    assert.equal(status.ok, true, JSON.stringify(status));
    assert.equal(status.result.trusted, true);
    assert.equal(status.result.paused.reason, 'test pause');

    const policy = await ask(c, { command: 'setPolicy', policy: 'manual' });
    assert.equal(policy.result.policy, 'manual');
    const resumed = await ask(c, { command: 'resume' });
    assert.equal(resumed.result.paused, null);

    const decided = await ask(c, { command: 'decide', items: [{ setupId: 'local', id: MODEL, revision: HEAD, decision: 'skip' }] });
    assert.equal(decided.ok, true, JSON.stringify(decided));
    assert.equal(typeof decided.result.counts.pending, 'number');
    const stored = await s.m.run(DecisionsStore.use((d) => d.read));
    assert.equal(stored.find((d) => d.itemId === MODEL)?.decision, 'skip');
    const kinds = (await s.m.events()).filter((e) => e.kind === 'decided' || e.kind === 'policy-changed' || e.kind === 'resumed');
    assert.deepEqual(kinds.map((e) => [e.kind, e.actor]), [['policy-changed', 'app'], ['resumed', 'app'], ['decided', 'app']]);
  });
});

test('a multi-item decide records every decision and runs one job', unixOnly, async () => {
  await withServer({}, async (s) => {
    const c = await s.open();
    await ask(c, { command: 'status' });
    await ask(c, { command: 'subscribe' });
    const from = c.records.length;
    const items = [EFFORT, MODEL, 'setting:claude:settings.json#theme'].map((id) => ({ setupId: 'local', id, revision: HEAD, decision: 'skip' }));
    const decided = await ask(c, { command: 'decide', items });
    assert.equal(decided.ok, true, JSON.stringify(decided));
    // A job's status event is written before the reply of the request that ran it.
    assert.equal(c.records.slice(from).filter((r) => r.event === 'status').length, 1);
    const stored = await s.m.run(DecisionsStore.use((d) => d.read));
    assert.deepEqual(items.map((i) => stored.find((d) => d.itemId === i.id)?.decision), ['skip', 'skip', 'skip']);
    assert.equal((await s.m.events()).filter((e) => e.kind === 'decided').length, 3);
  });
});

test('history answers newest first, at most limit, before a cursor', unixOnly, async () => {
  await withServer({}, async (s) => {
    const old = ['2020-01-01', '2020-01-02', '2020-01-03'].map((day) =>
      JSON.stringify({ v: 1, at: `${day}T00:00:00.000Z`, kind: 'resumed', actor: 'cli', reason: day }));
    mkdirSync(join(s.m.paths.stateRoot, 'history'), { recursive: true });
    writeFileSync(join(s.m.paths.stateRoot, 'history', '2020-01.jsonl'), old.join('\n') + '\n');
    const c = await s.open();
    await ask(c, { command: 'setPolicy', policy: 'manual' });

    const all = await ask(c, { command: 'history', limit: 500 });
    assert.deepEqual(all.result.events, [...await s.m.events()].reverse());
    assert.equal(all.result.nextBefore, null);
    assert.ok(all.result.events.some((e: Wire) => e.kind === 'policy-changed'));
    const newest = await ask(c, { command: 'history', limit: 1 });
    assert.deepEqual(newest.result.events, all.result.events.slice(0, 1));
    const before = await ask(c, { command: 'history', before: { at: '2020-01-03T00:00:00.000Z', seq: 0 }, limit: 500 });
    assert.deepEqual(before.result.events.map((e: Wire) => e.reason), ['2020-01-02', '2020-01-01']);
  });
});

const historyFixture = (s: Awaited<ReturnType<typeof serverMachine>>, month: string, events: ReadonlyArray<{ at: string; reason: string }>) => {
  s.m.write(join(s.m.paths.stateRoot, 'history', `${month}.jsonl`), events.map((e) =>
    JSON.stringify({ v: 1, kind: 'resumed', actor: 'cli', ...e })).join('\n') + '\n');
};

const historyPage = async (c: Client, before: { at: string; seq: number }, limit: number) => {
  const response = await ask(c, { command: 'history', before, limit });
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.result;
};

test('history pages every same-millisecond event with exclusive cursors and reports exhaustion', unixOnly, async () => {
  await withServer({}, async (s) => {
    const at = '2020-01-02T00:00:00.000Z';
    historyFixture(s, '2020-01', [
      { at: '2020-01-01T00:00:00.000Z', reason: 'older' },
      { at, reason: 'first' }, { at, reason: 'second' }, { at, reason: 'third' },
    ]);
    const c = await s.open();
    const first = await historyPage(c, { at: '2020-01-03T00:00:00.000Z', seq: 0 }, 1);
    assert.deepEqual(first.events.map((e: Wire) => e.reason), ['third']);
    assert.deepEqual(first.nextBefore, { at, seq: 2 });
    const second = await historyPage(c, first.nextBefore, 2);
    assert.deepEqual(second.events.map((e: Wire) => e.reason), ['second', 'first']);
    assert.deepEqual(second.nextBefore, { at, seq: 0 });
    const last = await historyPage(c, second.nextBefore, 1);
    assert.deepEqual(last.events.map((e: Wire) => e.reason), ['older']);
    assert.equal(last.nextBefore, null);
    const empty = await historyPage(c, { at: '2020-01-01T00:00:00.000Z', seq: 0 }, 10);
    assert.deepEqual(empty, { events: [], nextBefore: null });
  });
});

test('same-millisecond appends between history pages do not repeat or skip existing events', unixOnly, async () => {
  await withServer({}, async (s) => {
    const at = '2020-01-02T00:00:00.000Z';
    historyFixture(s, '2020-01', [{ at, reason: 'first' }, { at, reason: 'second' }, { at, reason: 'third' }]);
    const c = await s.open();
    const first = await historyPage(c, { at: '2020-01-03T00:00:00.000Z', seq: 0 }, 1);
    assert.deepEqual(first.events.map((e: Wire) => e.reason), ['third']);
    await Promise.all(['concurrent-a', 'concurrent-b'].map((reason) => s.m.run(
      HistoryStore.use((h) => h.append({ kind: 'resumed', actor: 'cli', reason })).pipe(
        Effect.provide(historyStore(() => new Date(at)))))));
    const remaining = await historyPage(c, first.nextBefore, 10);
    assert.deepEqual(remaining.events.map((e: Wire) => e.reason), ['second', 'first']);
    assert.equal(remaining.nextBefore, null);
    const fresh = await historyPage(c, { at: '2020-01-03T00:00:00.000Z', seq: 0 }, 2);
    assert.deepEqual(fresh.events.map((e: Wire) => e.reason).sort(), ['concurrent-a', 'concurrent-b']);
    assert.deepEqual(fresh.nextBefore, { at, seq: 3 });
  });
});

test('history cursors survive a clock rollback append into an older month', unixOnly, async () => {
  await withServer({}, async (s) => {
    historyFixture(s, '2020-01', [{ at: '2020-01-01T00:00:00.000Z', reason: 'january' }]);
    historyFixture(s, '2020-02', [
      { at: '2020-02-02T00:00:00.000Z', reason: 'first-february' },
      { at: '2020-02-02T00:00:00.000Z', reason: 'second-february' },
    ]);
    const c = await s.open();
    const first = await historyPage(c, { at: '2020-03-01T00:00:00.000Z', seq: 0 }, 1);
    assert.deepEqual(first.events.map((e: Wire) => e.reason), ['second-february']);
    await s.m.run(HistoryStore.use((h) => h.append({ kind: 'resumed', actor: 'cli', reason: 'rollback' })).pipe(
      Effect.provide(historyStore(() => new Date('2020-01-02T00:00:00.000Z')))));
    const rest = await historyPage(c, first.nextBefore, 10);
    assert.deepEqual(rest.events.map((e: Wire) => e.reason), ['first-february', 'rollback', 'january']);
    assert.equal(rest.nextBefore, null);
  });
});

test('history groups equivalent timestamp instants and skips invalid timestamps', unixOnly, async () => {
  await withServer({}, async (s) => {
    historyFixture(s, '2020-01', [
      { at: '2020-01-02T00:00:00Z', reason: 'utc' },
      { at: '2020-01-01T23:00:00Z', reason: 'older' },
      { at: '2020-01-02T03:00:00+03:00', reason: 'offset' },
      { at: 'invalid', reason: 'invalid' },
    ]);
    const c = await s.open();
    const first = await historyPage(c, { at: '2020-01-03T00:00:00.000Z', seq: 0 }, 1);
    assert.deepEqual(first.events.map((e: Wire) => e.reason), ['offset']);
    assert.equal(first.events[0].at, '2020-01-02T03:00:00+03:00');
    assert.deepEqual(first.nextBefore, { at: '2020-01-02T00:00:00.000Z', seq: 1 });
    const rest = await historyPage(c, { at: '2020-01-02T01:00:00+01:00', seq: 1 }, 10);
    assert.deepEqual(rest.events.map((e: Wire) => e.reason), ['utc', 'older']);
    assert.equal(rest.nextBefore, null);
  });
});

test('a subscriber receives a status event after another client inspects', unixOnly, async () => {
  await withServer({}, async (s) => {
    const watcher = await s.open();
    const subscribed = await ask(watcher, { command: 'subscribe' });
    assert.deepEqual(subscribed.result, { subscribed: true });
    const from = watcher.records.length;
    const other = await s.open('cli');
    const inspected = await ask(other, { command: 'inspect' });
    assert.equal(inspected.ok, true);
    const event = await watcher.waitFor((r) => r.event === 'status', from);
    assert.equal(event.version, 3);
    assert.equal(event.status.trusted, true);
    assert.equal(other.records.some((r) => r.event !== undefined), false);
  });
});

test('apply answers started, then streams progress to the client and to subscribers', unixOnly, async () => {
  await withServer({}, async (s) => {
    const watcher = await s.open();
    await ask(watcher, { command: 'subscribe' });
    const c = await s.open();
    const inspected = await ask(c, { command: 'inspect' });
    const exclude = inspected.result.items.filter((i: Wire) => i.domain !== 'config').map((i: Wire) => i.key);
    const preview = await ask(c, { command: 'preview', exclude });
    const from = c.records.length;
    const watched = watcher.records.length;
    const applied = await ask(c, { command: 'apply', planId: preview.result.planId });
    assert.equal(applied.result.status, 'started');
    const runId = applied.result.runId;
    await c.waitFor((r) => r.event === 'progress' && r.progress.type === 'done', from);
    const records = c.records.slice(from);
    assert.equal(records[0]!.id, applied.id);
    assert.deepEqual(records.slice(1).filter((r) => r.event === 'progress').map((r) => [r.runId, r.progress.type]),
      ['started', 'finished', 'started', 'finished', 'started', 'finished', 'done'].map((t) => [runId, t]));
    const done = await watcher.waitFor((r) => r.event === 'progress' && r.progress.type === 'done', watched);
    assert.equal(done.runId, runId);
    const started = records.find((r) => r.event === 'progress' && r.progress.type === 'started');
    assert.deepEqual(started!.progress.step.key, THEME_KEY);
    assert.deepEqual(JSON.parse(s.m.read(join(s.m.paths.claude, 'settings.json'))!), { theme: 'dark', effortLevel: 'high', model: 'opus' });
  });
});

test('an apply whose plan changed since the preview answers stale with the new preview', unixOnly, async () => {
  await withServer({}, async (s) => {
    const c = await s.open();
    const inspected = await ask(c, { command: 'inspect' });
    const exclude = inspected.result.items.filter((i: Wire) => i.domain !== 'config').map((i: Wire) => i.key);
    const preview = await ask(c, { command: 'preview', exclude });
    assert.deepEqual(preview.result.plan.steps.map((st: Wire) => st.key), [THEME_KEY, EFFORT_KEY, MODEL_KEY]);
    await ask(c, { command: 'decide', items: [EFFORT, MODEL].map((id) => ({ setupId: 'local', id, revision: HEAD, decision: 'skip' })) });
    const stale = await ask(c, { command: 'apply', planId: preview.result.planId });
    assert.equal(stale.result.status, 'stale', JSON.stringify(stale));
    assert.deepEqual(stale.result.plan.steps.map((st: Wire) => st.key), [THEME_KEY]);
  });
});

test('a silent client does not block another; the directory is 0700, the socket and token 0600', unixOnly, async () => {
  await withServer({}, async (s) => {
    const silent = await connect(s.socketPath);
    silent.sendRaw('{"version":3');
    const c = await s.open('cli');
    assert.equal((await ask(c, { command: 'status' })).ok, true);
    assert.equal(statSync(s.dir).mode & 0o777, 0o700);
    assert.equal(statSync(s.socketPath).mode & 0o777, 0o600);
    assert.equal(statSync(s.tokenPath).mode & 0o777, 0o600);
    assert.match(s.token, /^[A-Za-z0-9_-]{43}$/);
  });
});

test('a connection that sends no complete record in time is closed', unixOnly, async () => {
  await withServer({ handshakeMs: 50 }, async (s) => {
    const silent = await connect(s.socketPath);
    await silent.closed;
    assert.deepEqual(silent.records, []);
  });
});

test('shutdown answers, then calls onShutdown', unixOnly, async () => {
  await withServer({}, async (s) => {
    const c = await s.open();
    const reply = await ask(c, { command: 'shutdown' });
    assert.deepEqual(reply.result, { shutdown: true });
    // onShutdown runs once the reply is flushed, which may be after the client has read it.
    for (let i = 0; i < 100 && s.shutdowns() === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(s.shutdowns(), 1);
    assert.equal((await ask(c, { command: 'status' })).error.code, 'SHUTDOWN');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(s.shutdowns(), 1, 'a flushed reply left a second shutdown scheduled');
  });
});

test('shutdown bounds a blocked reply even after refused follow-up traffic, and calls onShutdown once', unixOnly, async () => {
  await withServer({}, async (s) => {
    const { c, id } = await blockedShutdown(s);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const laterId = `r${++ids}`;
    c.send({ version: 3, id: laterId, command: 'shutdown' });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(s.shutdowns(), 1, 'shutdown waited indefinitely for a client that never reads');

    c.socket.resume();
    assert.deepEqual((await c.waitFor((r) => r.id === id)).result, { shutdown: true });
    assert.equal((await c.waitFor((r) => r.id === laterId)).error.code, 'SHUTDOWN');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(s.shutdowns(), 1, 'the eventual flush called onShutdown again');
  });
});

test('closing the scope cancels a blocked shutdown callback', unixOnly, async () => {
  await withServer({}, async (s) => {
    const { c } = await blockedShutdown(s);
    await s.close();
    await c.closed;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(s.shutdowns(), 0, 'shutdown ran after its scope was closed');
    assert.equal(existsSync(s.socketPath), false);
    assert.equal(existsSync(s.tokenPath), false);
  });
});

test('closing the scope closes connections and removes the socket and token', unixOnly, async () => {
  const s = await serverMachine();
  const c = await s.open();
  await s.close();
  await c.closed;
  assert.equal(existsSync(s.socketPath), false);
  assert.equal(existsSync(s.tokenPath), false);
});

test('a leftover socket is replaced', unixOnly, async () => {
  const m = agentMachine('/tmp');
  const handle = { onStatus: () => () => {} } as never;
  const dir = join(m.paths.stateRoot, 'agent');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agent.sock'), 'stale');
  await m.run(Effect.scoped(Effect.gen(function* () {
    yield* serveIpc({ paths: m.paths, handle, session: {} as never, agentVersion: '0', onShutdown: () => {} });
    assert.equal(statSync(join(dir, 'agent.sock')).isSocket(), true);
  })));
});

test('status before the first job answers NO_REPORT at once, without waiting for a job', unixOnly, async () => {
  const starting = Deferred.makeUnsafe<void>();
  await withServer({ starting }, async (s) => {
    const c = await s.open('cli');
    const early = await ask(c, { command: 'status' });
    assert.equal(early.ok, false, JSON.stringify(early));
    assert.deepEqual(early.error, { code: 'NO_REPORT', message: 'the agent is still starting' });
    Deferred.doneUnsafe(starting, Effect.void);
    let later = early;
    for (let i = 0; i < 200 && !later.ok; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      later = await ask(c, { command: 'status' });
    }
    assert.equal(later.ok, true, JSON.stringify(later));
  });
});

const pendingKeys = (status: Wire) => status.pending.map((p: Wire) => p.key);

test('after an apply, a status event and the status reply no longer list the applied items', unixOnly, async () => {
  await withServer({}, async (s) => {
    const watcher = await s.open();
    await ask(watcher, { command: 'subscribe' });
    const c = await s.open();
    const before = await ask(c, { command: 'status' });
    assert.ok(pendingKeys(before.result).includes(EFFORT_KEY) && pendingKeys(before.result).includes(MODEL_KEY), JSON.stringify(before));
    const inspected = await ask(c, { command: 'inspect' });
    const exclude = inspected.result.items.filter((i: Wire) => i.domain !== 'config').map((i: Wire) => i.key);
    const preview = await ask(c, { command: 'preview', exclude });
    const watched = watcher.records.length;
    const applied = await ask(c, { command: 'apply', planId: preview.result.planId });
    assert.equal(applied.result.status, 'started');
    const done = await watcher.waitFor((r) => r.event === 'progress' && r.progress.type === 'done', watched);
    const event = await watcher.waitFor((r) => r.event === 'status', watcher.records.indexOf(done) + 1);
    assert.deepEqual(pendingKeys(event.status).filter((k: string) => k === EFFORT_KEY || k === MODEL_KEY), []);
    const after = await ask(c, { command: 'status' });
    assert.deepEqual(pendingKeys(after.result).filter((k: string) => k === EFFORT_KEY || k === MODEL_KEY), []);
  });
});

test('shutdown mid-apply answers, cancels the run, releases apply.lock and removes the socket and token', unixOnly, async () => {
  // Each step takes a while, so the run is still going when shutdown arrives.
  const slow: AgentDomain = { ...configDomain, run: (step, report) => Effect.andThen(Effect.sleep('200 millis'), configDomain.run(step, report)) };
  const { m, domains, source, socketPath, tokenPath } = await prepare({ config: slow });
  const fiber = Effect.runFork(runAgent({ paths: m.paths, domains, source, agentVersion: '1.0.0', ipc: true }));
  let c: Client | undefined;
  try {
    for (let i = 0; i < 500 && !existsSync(socketPath); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    c = await connect(socketPath);
    assert.equal((await ask(c, { command: 'hello', token: readFileSync(tokenPath, 'utf8'), client: 'cli' })).ok, true);
    const inspected = await ask(c, { command: 'inspect' });
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    const exclude = inspected.result.items.filter((i: Wire) => i.domain !== 'config').map((i: Wire) => i.key);
    const preview = await ask(c, { command: 'preview', exclude });
    const from = c.records.length;
    const applied = await ask(c, { command: 'apply', planId: preview.result.planId });
    assert.equal(applied.result.status, 'started', JSON.stringify(applied));
    await c.waitFor((r) => r.event === 'progress' && r.progress.type === 'started', from);

    const reply = await ask(c, { command: 'shutdown' });
    assert.deepEqual(reply.result, { shutdown: true });
    const ended = await Effect.runPromise(Fiber.await(fiber).pipe(Effect.timeoutOption('10 seconds')));
    assert.ok(ended._tag === 'Some' && Exit.isSuccess(ended.value), 'the agent kept running after shutdown');
    assert.equal(existsSync(join(m.paths.stateRoot, 'apply.lock')), false);
    const finished = (await m.events()).filter((e) => e.kind === 'apply-finished');
    assert.equal(finished.length, 1);
    assert.ok(finished[0]?.kind === 'apply-finished' && finished[0].result === 'cancelled', JSON.stringify(finished));
    assert.equal(existsSync(socketPath), false);
    assert.equal(existsSync(tokenPath), false);
  } finally {
    c?.socket.destroy();
    await Effect.runPromise(Fiber.interrupt(fiber));
  }
});

test('status observes an automatic apply lock rather than the cached job report', unixOnly, async () => {
  await withServer({}, async (s) => {
    const c = await s.open();
    assert.equal((await ask(c, { command: 'status' })).result.applying, false);
    const lock = join(s.m.paths.stateRoot, 'apply.lock');
    writeFileSync(lock, JSON.stringify({ pid: process.pid }));
    assert.equal((await ask(c, { command: 'status' })).result.applying, true);
    rmSync(lock);
    assert.equal((await ask(c, { command: 'status' })).result.applying, false);
    writeFileSync(lock, JSON.stringify({ pid: 2147483647 }));
    assert.equal((await ask(c, { command: 'status' })).result.applying, false);
  });
});

test('status observes a manual apply while its first step is blocked and becomes idle after completion', unixOnly, async () => {
  const started = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  const slow: AgentDomain = { ...configDomain, run: (step, report) => Effect.andThen(Deferred.succeed(started, undefined), Effect.andThen(Deferred.await(release), configDomain.run(step, report))) };
  await withServer({ config: slow }, async (s) => {
    const c = await s.open();
    const inspected = await ask(c, { command: 'inspect' });
    assert.equal(inspected.result.status.applying, false);
    const exclude = inspected.result.items.filter((i: Wire) => i.domain !== 'config').map((i: Wire) => i.key);
    const preview = await ask(c, { command: 'preview', exclude });
    assert.equal((await ask(c, { command: 'apply', planId: preview.result.planId })).result.status, 'started');
    await Effect.runPromise(Deferred.await(started));
    assert.equal((await ask(c, { command: 'status' })).result.applying, true);
    await Effect.runPromise(Deferred.succeed(release, undefined));
    await c.waitFor((record) => record.event === 'progress' && record.progress.type === 'done');
    assert.equal((await ask(c, { command: 'status' })).result.applying, false);
  });
});
