import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { RemoteStore, TailscaleAccess, makeSession, startAgent } from '../src/index.ts';
import { makeOperationDispatch, type OperationCaller } from '../src/ipc/operation-dispatch.ts';
import { SessionError } from '../src/ipc/session.ts';
import { agentMachine } from './support/agent-machine.ts';
import { configDomain } from '@nortuscc/machine';

const self = { nodeId: 'n1', userId: 1, login: 'me@example.com', hostName: 'laptop', dnsName: 'laptop.ts.net.', os: 'macOS', ips: [] };
const fakeTailscale = (status: unknown) => Layer.succeed(TailscaleAccess, { status: () => Effect.succeed(status as never), whois: () => Effect.succeed(null) });

const setup = async (status: unknown = { self, peers: [] }) => {
  const m = agentMachine('/tmp');
  const file = join(m.paths.stateRoot, 'agent', 'remote.json');
  const dispatch = await m.run(Effect.gen(function* () {
    const domains = () => [configDomain];
    const handle = yield* startAgent(domains);
    const session = yield* makeSession(handle, { signal: new AbortController().signal, domains });
    return makeOperationDispatch({ session, paths: m.paths, handle, agentVersion: '9.9.9', platform: process.platform });
  }).pipe(Effect.scoped));
  const effect = (caller: OperationCaller, name: 'remoteAccess' | 'setRemoteAccess', input: object) =>
    dispatch(caller, name, { scope: { kind: 'machine' }, ...input }).pipe(Effect.provide(fakeTailscale(status)));
  const call = (caller: OperationCaller, name: 'remoteAccess' | 'setRemoteAccess', input: object): Promise<any> => m.run(effect(caller, name, input));
  return { m, file, call, effect };
};

test('remote access is off by default and reports Tailscale and this machine', async () => {
  const { m, call } = await setup();
  try {
    assert.deepEqual(await call({ actor: 'cli' }, 'remoteAccess', {}), { enabled: false, tailscale: 'ready', self: { name: 'laptop', login: 'me@example.com' }, listening: false });
    assert.deepEqual(await call({ actor: 'cli' }, 'remoteAccess', {}).then((r: any) => r.enabled), false);
  } finally { rmSync(m.root, { recursive: true, force: true }); }
});

test('reports a Tailscale state with no self', async () => {
  const { m, call } = await setup('logged-out');
  try {
    assert.deepEqual(await call({ actor: 'app' }, 'remoteAccess', {}), { enabled: false, tailscale: 'logged-out', self: null, listening: false });
  } finally { rmSync(m.root, { recursive: true, force: true }); }
});

test('the app and CLI change the switch and it persists', async () => {
  const { m, file, call } = await setup();
  try {
    const on: any = await call({ actor: 'cli' }, 'setRemoteAccess', { enabled: true });
    assert.equal(on.enabled, true);
    assert.deepEqual(JSON.parse(m.read(file)!), { version: 1, enabled: true, known: [] });
    assert.equal(((await call({ actor: 'app' }, 'remoteAccess', {})) as any).enabled, true);
    assert.equal(((await call({ actor: 'app' }, 'setRemoteAccess', { enabled: false })) as any).enabled, false);
  } finally { rmSync(m.root, { recursive: true, force: true }); }
});

test('mcp and remote callers cannot change the switch', async () => {
  const { m, file, call, effect } = await setup();
  try {
    await call({ actor: 'cli' }, 'setRemoteAccess', { enabled: true });
    const before = m.read(file);
    for (const caller of [{ actor: 'remote', machine: 'phone', origin: 'app' }, { actor: 'mcp', runtimeId: 'x' }] as const) {
      const error = await m.run(Effect.flip(effect(caller, 'setRemoteAccess', { enabled: false })));
      assert.ok(error instanceof SessionError);
      assert.equal(error.code, 'FORBIDDEN');
    }
    assert.equal(m.read(file), before);
  } finally { rmSync(m.root, { recursive: true, force: true }); }
});

test('a malformed remote.json reads as disabled and is backed up before it is rewritten', async () => {
  const { m, file, call } = await setup();
  try {
    m.write(file, '{not json');
    assert.equal(((await call({ actor: 'cli' }, 'remoteAccess', {})) as any).enabled, false);
    await call({ actor: 'cli' }, 'setRemoteAccess', { enabled: true });
    assert.equal(JSON.parse(m.read(file)!).enabled, true);
    const folders = readdirSync(m.paths.backups);
    assert.equal(folders.length, 1);
    assert.equal(m.read(join(m.paths.backups, folders[0]!, 'agent', 'remote.json')), '{not json');
  } finally { rmSync(m.root, { recursive: true, force: true }); }
});

test('remember keeps the most recently reached 64 machines by node', async () => {
  const { m, file } = await setup();
  try {
    const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
    const machines = Array.from({ length: 70 }, (_, i) => ({ nodeId: `n${i}`, name: `m${i}`, os: 'linux', lastReachedAt: at(i) }));
    await m.run(RemoteStore.use((s) => s.remember(machines)));
    await m.run(RemoteStore.use((s) => s.remember([{ nodeId: 'n69', name: 'renamed', os: 'linux', lastReachedAt: at(80) }])));
    const stored = JSON.parse(m.read(file)!);
    assert.equal(stored.known.length, 64);
    assert.equal(stored.known[0].name, 'renamed');
    assert.ok(!stored.known.some((k: any) => k.nodeId === 'n0'));
    assert.equal(stored.enabled, false);
  } finally { rmSync(m.root, { recursive: true, force: true }); }
});

test('listening reflects what the listener reports', async () => {
  const { m, effect } = await setup();
  try {
    const view: any = await m.run(RemoteStore.use((s) => s.setListening(true)).pipe(Effect.andThen(effect({ actor: 'cli' }, 'remoteAccess', {}))));
    assert.equal(view.listening, true);
  } finally { rmSync(m.root, { recursive: true, force: true }); }
});
