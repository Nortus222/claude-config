import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttp, type IncomingMessage, type Server } from 'node:http';
import { createServer as createNet } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { Fs, FsFailed, LaunchFailed, Processes, type Command } from '@nortuscc/machine';
import { callerDecision, findLocalApi, myPeers, parseWhois, tailscaleStatus, whois, type LocalApiEndpoint, type TsSelf } from '../src/remote/tailscale.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./support/${name}.json`, import.meta.url), 'utf8'));
const status = fixture('tailscale-status');
const self: TsSelf = myPeers(status).self;

test('myPeers keeps only this user\'s untagged, unshared, unexpired peers', () => {
  const { self: s, peers } = myPeers(status);
  assert.deepEqual(s, { nodeId: 'nSELF', userId: 7, login: 'ihor@example.com', hostName: 'laptop', dnsName: 'laptop.tail1.ts.net.', os: 'macOS', ips: ['100.64.0.1', 'fd7a::1'] });
  assert.deepEqual(peers.map((p) => [p.nodeId, p.online]), [['nOWN', true], ['nOFF', false]]);
});

test('callerDecision admits only another untagged, unshared node of the same user', () => {
  const who = (name: string) => parseWhois(fixture(`whois-${name}`));
  assert.deepEqual(callerDecision(who('own'), self), { allow: true, machine: 'desktop' });
  assert.deepEqual(callerDecision(null, self), { allow: false, reason: 'unknown' });
  for (const reason of ['self', 'tagged', 'shared', 'other-user'] as const) {
    assert.deepEqual(callerDecision(who(reason), self), { allow: false, reason });
  }
  assert.deepEqual(callerDecision(parseWhois({ Node: { ID: 1, Name: 'x.tail1.ts.net.', User: 7 } }), self), { allow: true, machine: 'x' });
});

type Seen = { url: string; headers: IncomingMessage['headers'] };
const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'ts-')); closers.push(() => rmSync(d, { recursive: true, force: true })); return d; };

const listen = (server: Server, target: string | number) => new Promise<void>((resolve) => {
  closers.push(() => server.close());
  if (typeof target === 'number') server.listen(target, '127.0.0.1', resolve);
  else server.listen(target, resolve);
});
const fakeApi = (handler: (seen: Seen) => { status: number; body?: unknown }, seen: Seen[] = []) => createHttp((req, res) => {
  const s = { url: req.url ?? '', headers: req.headers };
  seen.push(s);
  const out = handler(s);
  res.writeHead(out.status, { 'content-type': 'application/json' });
  res.end(out.body === undefined ? '' : JSON.stringify(out.body));
});
const serveFixtures = (s: Seen) => s.url.startsWith('/localapi/v0/status') ? { status: 200, body: status }
  : s.url.startsWith('/localapi/v0/whois') ? (() => {
    const addr = new URL(s.url, 'http://x').searchParams.get('addr');
    return addr === '100.64.0.2:1234' ? { status: 200, body: fixture('whois-own') } : { status: 404, body: { error: 'no match' } };
  })() : { status: 404 };

test('status and whois over a Unix socket send the LocalAPI host and no browser headers', async () => {
  const seen: Seen[] = [];
  const path = join(dir(), 'tailscaled.sock');
  await listen(fakeApi(serveFixtures, seen), path);
  const endpoint: LocalApiEndpoint = { kind: 'path', path };
  const result = await Effect.runPromise(tailscaleStatus(endpoint));
  assert.ok(typeof result === 'object');
  assert.deepEqual(result.peers.map((p) => p.hostName), ['desktop', 'nas']);
  const who = await Effect.runPromise(whois(endpoint, '100.64.0.2:1234'));
  assert.deepEqual(callerDecision(who, self), { allow: true, machine: 'desktop' });
  assert.equal(await Effect.runPromise(whois(endpoint, '100.64.0.99:1')), null);
  for (const s of seen) {
    assert.equal(s.headers.host, 'local-tailscaled.sock');
    assert.equal(s.headers.origin, undefined);
    assert.equal(s.headers.referer, undefined);
    assert.equal(s.headers.authorization, undefined);
  }
});

test('TCP requests carry Basic auth with an empty user and the token', async () => {
  const seen: Seen[] = [];
  const server = fakeApi(serveFixtures, seen);
  await listen(server, 0);
  const port = (server.address() as { port: number }).port;
  await Effect.runPromise(tailscaleStatus({ kind: 'tcp', port, token: 'sekret' }));
  assert.equal(seen[0]!.headers.authorization, `Basic ${Buffer.from(':sekret').toString('base64')}`);
  assert.equal(seen[0]!.headers.host, 'local-tailscaled.sock');
  assert.equal(seen[0]!.headers.origin, undefined);
});

test('401 means needs-admin; a refused connection means not-running', async () => {
  const path = join(dir(), 'denied.sock');
  await listen(fakeApi(() => ({ status: 401 })), path);
  assert.equal(await Effect.runPromise(tailscaleStatus({ kind: 'path', path })), 'needs-admin');
  assert.equal(await Effect.runPromise(tailscaleStatus({ kind: 'path', path: join(dir(), 'missing.sock') })), 'not-running');
  assert.equal(await Effect.runPromise(tailscaleStatus({ kind: 'tcp', port: await closedPort(), token: 't' })), 'not-running');
});

test('a backend that is not running maps to logged-out or not-running', async () => {
  const path = join(dir(), 'state.sock');
  let backend = 'NeedsLogin';
  await listen(fakeApi(() => ({ status: 200, body: { ...status, BackendState: backend } })), path);
  assert.equal(await Effect.runPromise(tailscaleStatus({ kind: 'path', path })), 'logged-out');
  backend = 'Stopped';
  assert.equal(await Effect.runPromise(tailscaleStatus({ kind: 'path', path })), 'not-running');
});

const closedPort = () => new Promise<number>((resolve) => {
  const s = createNet().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});
const livePort = async () => {
  const s = createNet().listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  closers.push(() => s.close());
  return (s.address() as { port: number }).port;
};

type World = { files?: Record<string, string | 'denied'>; links?: Record<string, string>; lsof?: string };
const world = (w: World) => {
  const absent = (path: string) => new FsFailed({ op: 'x', path, reason: 'ENOENT' });
  const fs = Layer.succeed(Fs, {
    readText: (p: string) => w.files?.[p] === 'denied' ? Effect.fail(new FsFailed({ op: 'read', path: p, reason: 'EACCES' })) : Effect.succeed(w.files?.[p]),
    readLink: (p: string) => w.links?.[p] === undefined ? Effect.fail(absent(p)) : Effect.succeed(w.links[p]!),
    exists: (p: string) => Effect.succeed(w.files?.[p] !== undefined || w.links?.[p] !== undefined),
  } as unknown as Fs['Service']);
  const commands: Command[] = [];
  const processes = Layer.succeed(Processes, {
    run: (c: Command) => { commands.push(c); return w.lsof === undefined ? Effect.fail(new LaunchFailed({ cmd: c.cmd, reason: 'ENOENT' })) : Effect.succeed({ code: 0, stdout: w.lsof }); },
  });
  return { layer: Layer.mergeAll(fs, processes), commands };
};
const find = (platform: NodeJS.Platform, w: World) => { const x = world(w); return Effect.runPromise(findLocalApi(platform).pipe(Effect.provide(x.layer))).then((r) => ({ r, commands: x.commands })); };

test('findLocalApi reads the App Store sameuserproof file from lsof', async () => {
  const port = await livePort();
  const { r, commands } = await find('darwin', { lsof: `p123\nfcwd\nn/\nf5\nn/Library/x/sameuserproof-${port}-abc123\n` });
  assert.deepEqual(r, { kind: 'tcp', port, token: 'abc123' });
  assert.equal(commands[0]!.cmd, 'lsof');
  assert.deepEqual(commands[0]!.args.slice(0, 2), ['-n', '-a']);
  assert.ok(commands[0]!.args.includes('IPNExtension'));
});

test('findLocalApi skips a stale App Store port and uses the Standalone files', async () => {
  const stale = await closedPort();
  const port = await livePort();
  const { r } = await find('darwin', {
    lsof: `n/x/sameuserproof-${stale}-dead\n`,
    links: { '/Library/Tailscale/ipnport': String(port) },
    files: { [`/Library/Tailscale/sameuserproof-${port}`]: 'tok\n' },
  });
  assert.deepEqual(r, { kind: 'tcp', port, token: 'tok' });
});

test('findLocalApi reports needs-admin when the Standalone token is unreadable', async () => {
  const port = await livePort();
  const { r } = await find('darwin', { links: { '/Library/Tailscale/ipnport': String(port) }, files: { [`/Library/Tailscale/sameuserproof-${port}`]: 'denied' } });
  assert.equal(r, 'needs-admin');
});

test('findLocalApi falls back to the OSS socket on macOS, the daemon socket on Linux, and the pipe on Windows', async () => {
  assert.deepEqual((await find('darwin', { files: { '/var/run/tailscaled.socket': '' } })).r, { kind: 'path', path: '/var/run/tailscaled.socket' });
  assert.deepEqual((await find('linux', { files: { '/var/run/tailscale/tailscaled.sock': '' } })).r, { kind: 'path', path: '/var/run/tailscale/tailscaled.sock' });
  assert.deepEqual((await find('win32', {})).r, { kind: 'path', path: '\\\\.\\pipe\\ProtectedPrefix\\Administrators\\Tailscale\\tailscaled' });
});

test('findLocalApi reports not-installed when nothing is found', async () => {
  assert.equal((await find('darwin', {})).r, 'not-installed');
  assert.equal((await find('linux', {})).r, 'not-installed');
});
