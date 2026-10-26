import { request } from 'node:http';
import { connect } from 'node:net';
import { Effect } from 'effect';
import { Fs, Processes } from '@nortuscc/machine';

export type LocalApiEndpoint = { kind: 'tcp'; port: number; token: string } | { kind: 'path'; path: string };
export type TailscaleState = 'not-installed' | 'not-running' | 'logged-out' | 'needs-admin' | 'ready';
export type TsSelf = { nodeId: string; userId: number; login: string; hostName: string; dnsName: string; os: string; ips: string[] };
export type TsPeer = { nodeId: string; hostName: string; dnsName: string; os: string; ips: string[]; online: boolean };

type RawNode = {
  ID: string; HostName: string; DNSName: string; OS: string; UserID: number; TailscaleIPs?: string[];
  Tags?: string[]; Online?: boolean; ShareeNode?: boolean; Expired?: boolean;
};
export type RawStatus = { BackendState: string; Self: RawNode; Peer?: Record<string, RawNode>; User?: Record<string, { LoginName: string }> };

// A node as `whois` reports it; `nodeId` is the stable ID, the same identifier `status` uses.
export type WhoisResult = { nodeId: string; name: string; machine: string; tagged: boolean; userId: number; shared: boolean };

const HOST = 'local-tailscaled.sock';
const WINDOWS_PIPE = '\\\\.\\pipe\\ProtectedPrefix\\Administrators\\Tailscale\\tailscaled';
const STANDALONE = '/Library/Tailscale';

const toPeer = (n: RawNode): TsPeer => ({ nodeId: n.ID, hostName: n.HostName, dnsName: n.DNSName, os: n.OS, ips: n.TailscaleIPs ?? [], online: n.Online === true });

// This user's own machines: untagged, not shared in, not expired. Tailscale's own node is `self`.
export const myPeers = (status: RawStatus): { self: TsSelf; peers: TsPeer[] } => {
  const { Self } = status;
  const { online: _online, ...me } = toPeer(Self);
  const self: TsSelf = { ...me, userId: Self.UserID, login: status.User?.[String(Self.UserID)]?.LoginName ?? '' };
  const peers = Object.values(status.Peer ?? {})
    .filter((p) => p.UserID === Self.UserID && !(p.Tags?.length) && p.ShareeNode !== true && p.Expired !== true)
    .map(toPeer);
  return { self, peers };
};

// Null unless the node carries a stable ID (the id space `status` uses) and a machine name.
export const parseWhois = (json: unknown): WhoisResult | null => {
  const node = (json as { Node?: Record<string, unknown> } | null)?.Node;
  if (!node || typeof node !== 'object' || typeof node.User !== 'number') return null;
  if (typeof node.StableID !== 'string' || node.StableID === '') return null;
  const name = typeof node.Name === 'string' ? node.Name : '';
  const computedName = typeof node.ComputedName === 'string' && node.ComputedName ? node.ComputedName : undefined;
  const machine = computedName ?? name.split('.')[0] ?? '';
  if (machine === '') return null;
  const tags = node.Tags;
  return {
    nodeId: node.StableID,
    name,
    machine,
    tagged: Array.isArray(tags) && tags.length > 0,
    userId: node.User,
    shared: typeof node.Sharer === 'number' && node.Sharer !== 0,
  };
};

// Admits only another untagged, unshared node of this Tailscale user.
export const callerDecision = (who: WhoisResult | null, self: TsSelf):
  | { allow: true; machine: string }
  | { allow: false; reason: 'unknown' | 'self' | 'tagged' | 'shared' | 'other-user' } => {
  if (!who) return { allow: false, reason: 'unknown' };
  if (who.tagged) return { allow: false, reason: 'tagged' };
  if (who.shared) return { allow: false, reason: 'shared' };
  if (who.userId !== self.userId) return { allow: false, reason: 'other-user' };
  if (who.nodeId === self.nodeId) return { allow: false, reason: 'self' };
  return { allow: true, machine: who.machine };
};

type Reply = { status: number; body: string } | 'unreachable';

// One GET against the LocalAPI. Auth goes only to 127.0.0.1; no Origin or Referer is ever sent.
const get = (endpoint: LocalApiEndpoint, path: string) => Effect.promise<Reply>((): Promise<Reply> => new Promise((resolve) => {
  const base = { method: 'GET', path, headers: { host: HOST, ...(endpoint.kind === 'tcp' ? { authorization: `Basic ${Buffer.from(`:${endpoint.token}`).toString('base64')}` } : {}) } };
  const req = request(endpoint.kind === 'tcp' ? { ...base, host: '127.0.0.1', port: endpoint.port } : { ...base, socketPath: endpoint.path }, (res) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    res.on('error', () => resolve('unreachable'));
  });
  req.setTimeout(5000, () => req.destroy());
  req.on('error', () => resolve('unreachable'));
  req.end();
}));

export const tailscaleStatus = (endpoint: LocalApiEndpoint): Effect.Effect<{ self: TsSelf; peers: TsPeer[] } | TailscaleState> =>
  Effect.map(get(endpoint, '/localapi/v0/status'), (reply) => {
    if (reply === 'unreachable') return 'not-running';
    if (reply.status === 401 || reply.status === 403) return 'needs-admin';
    if (reply.status !== 200) return 'not-running';
    try {
      const raw = JSON.parse(reply.body) as RawStatus;
      if (raw.BackendState === 'NeedsLogin' || raw.BackendState === 'NeedsMachineAuth') return 'logged-out';
      return raw.BackendState === 'Running' ? myPeers(raw) : 'not-running';
    } catch {
      return 'not-running';
    }
  });

// Who Tailscale says owns `addr` (ip:port); null when it is unknown or the LocalAPI is unavailable.
export const whois = (endpoint: LocalApiEndpoint, addr: string): Effect.Effect<WhoisResult | null> =>
  Effect.map(get(endpoint, `/localapi/v0/whois?addr=${encodeURIComponent(addr)}`), (reply) => {
    if (reply === 'unreachable' || reply.status !== 200) return null;
    try { return parseWhois(JSON.parse(reply.body)); } catch { return null; }
  });

// A stale proof file names a port nothing listens on.
const accepts = (port: number) => Effect.promise(() => new Promise<boolean>((resolve) => {
  const socket = connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(true); });
  socket.setTimeout(5000, () => { socket.destroy(); resolve(false); });
  socket.on('error', () => resolve(false));
}));

const appStore = Effect.gen(function* () {
  const processes = yield* Processes;
  const uid = process.getuid?.();
  const out = yield* processes.run({ cmd: 'lsof', args: ['-n', '-a', ...(uid === undefined ? [] : [`-u${uid}`]), '-c', 'IPNExtension', '-F'], output: 'capture' }).pipe(Effect.orElseSucceed(() => ({ code: 1, stdout: '' })));
  for (const line of out.stdout.split('\n')) {
    const m = /sameuserproof-(\d+)-(\S+)$/.exec(line);
    if (m && (yield* accepts(Number(m[1])))) return { kind: 'tcp', port: Number(m[1]), token: m[2]! } satisfies LocalApiEndpoint;
  }
  return undefined;
});

// Standalone: `ipnport` is a symlink whose target is the port; the token file is root-readable only for some installs.
const standalone = Effect.gen(function* () {
  const fs = yield* Fs;
  const port = Number(yield* fs.readLink(`${STANDALONE}/ipnport`).pipe(Effect.orElseSucceed(() => '')));
  if (!Number.isInteger(port) || port <= 0) return undefined;
  const token = yield* fs.readText(`${STANDALONE}/sameuserproof-${port}`).pipe(Effect.map((t) => t?.trim()), Effect.orElseSucceed(() => 'denied' as const));
  if (token === 'denied') return 'needs-admin' as const;
  if (!token || !(yield* accepts(port))) return undefined;
  return { kind: 'tcp', port, token } satisfies LocalApiEndpoint;
});

const socketAt = (path: string) => Effect.gen(function* () {
  return (yield* (yield* Fs).exists(path)) ? { kind: 'path', path } satisfies LocalApiEndpoint : undefined;
});

// Where this machine's Tailscale LocalAPI is, or why it cannot be reached. A running daemon is not
// checked here; `tailscaleStatus` reports that.
export const findLocalApi = (platform: NodeJS.Platform): Effect.Effect<LocalApiEndpoint | TailscaleState, never, Fs | Processes> =>
  Effect.gen(function* () {
    if (platform === 'win32') return { kind: 'path', path: WINDOWS_PIPE } satisfies LocalApiEndpoint;
    if (platform === 'linux') return (yield* socketAt('/var/run/tailscale/tailscaled.sock')) ?? 'not-installed';
    if (platform !== 'darwin') return 'not-installed';
    const store = yield* appStore;
    if (store) return store;
    const std = yield* standalone;
    if (std && std !== 'needs-admin') return std;
    return (yield* socketAt('/var/run/tailscaled.socket')) ?? std ?? 'not-installed';
  });
