import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { Effect, Exit } from 'effect';
import { acquireApplyLock, Backups, Fs, inspectMcpRouting, MachinePaths, MCP_ROUTING_BLOCK_ID, Processes, privateFile, setMcpRouting,
  type McpRoutingFileId, type McpRoutingStatus } from '@nortuscc/machine';
import { SetupSource } from '@nortuscc/sync';
import type { ConnectionResult, ConnectionsState, ConnectionTarget } from '../shared/mcp-connections-protocol.ts';

export type ConnectionsInput = { readonly home: string; readonly appPath: string };
type Receipt = { target: ConnectionTarget; registry: string; appPath: string; previousAppPath: string | null;
  intent: 'active' | 'disconnecting' | 'released'; reload: boolean; fileId: McpRoutingFileId; blockId: typeof MCP_ROUTING_BLOCK_ID };
type Store = { version: 1; hosts: Partial<Record<ConnectionTarget, Receipt>> };
const targets = ['codex', 'claude'] as const;
const fileId = (target: ConnectionTarget): McpRoutingFileId => target === 'codex' ? 'codex:AGENTS.md' : 'claude:CLAUDE.md';
const validPath = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096 && isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const canonical = (v: unknown): string => JSON.stringify(v, (_, v) => object(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const digest = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const expected = (target: ConnectionTarget, appPath: string) => target === 'claude'
  ? { type: 'stdio', command: appPath, args: ['--mcp'], env: {} }
  : { name: 'nortuscc', enabled: true, disabled_reason: null, transport: { type: 'stdio', command: appPath, args: ['--mcp'], env: null, env_vars: [], cwd: null }, enabled_tools: null, disabled_tools: null, startup_timeout_sec: null, tool_timeout_sec: null };
const parseStore = (text: string | undefined): Store | undefined => {
  if (text === undefined) return { version: 1, hosts: {} };
  try {
    if (text.length > 24000) return;
    const raw: unknown = JSON.parse(text);
    if (!object(raw) || Object.keys(raw).length !== 2 || raw.version !== 1 || !object(raw.hosts)) return;
    for (const [key, v] of Object.entries(raw.hosts)) {
      if (!targets.includes(key as ConnectionTarget) || !object(v) || Object.keys(v).length !== 8 || v.target !== key
        || !validPath(v.registry) || !validPath(v.appPath) || !(v.previousAppPath === null || validPath(v.previousAppPath))
        || !['active', 'disconnecting', 'released'].includes(v.intent as string) || typeof v.reload !== 'boolean'
        || v.fileId !== fileId(key as ConnectionTarget) || v.blockId !== MCP_ROUTING_BLOCK_ID) return;
    }
    return raw as Store;
  } catch { return; }
};
const context = (input: ConnectionsInput, target: ConnectionTarget) => Effect.gen(function* () {
  const paths = yield* MachinePaths;
  const customClaude = paths.claude !== join(input.home, '.claude');
  return { paths, registry: target === 'codex' ? join(paths.codex, 'config.toml') : join(customClaude ? paths.claude : input.home, '.claude.json'),
    receiptPath: join(paths.stateRoot, 'mcp-connections.json'),
    env: { HOME: input.home, CODEX_HOME: paths.codex, CLAUDE_CONFIG_DIR: customClaude ? paths.claude : '' } };
});
const cli = (input: ConnectionsInput, target: ConnectionTarget, args: readonly string[]) => Effect.gen(function* () {
  const { env, paths } = yield* context(input, target);
  // A neutral cwd excludes project-local registrations and untrusted project configuration.
  return yield* (yield* Processes).run({ cmd: target, args, cwd: paths.stateRoot, env, output: 'capture', stderr: 'capture' }).pipe(Effect.timeout(15000));
});
type Observation = { kind: 'present' | 'absent' | 'unavailable'; hash?: string; raw?: string };
const observe = (input: ConnectionsInput, target: ConnectionTarget) => Effect.gen(function* () {
  const fs = yield* Fs; const c = yield* context(input, target);
  if ((yield* fs.stat(c.registry))?.kind === 'symlink') return { kind: 'unavailable' } as Observation;
  const raw = yield* fs.readText(c.registry);
  if (target === 'claude') {
    const available = yield* cli(input, target, ['--version']);
    if (available.code !== 0) return { kind: 'unavailable', raw } as Observation;
    if (raw === undefined) return { kind: 'absent', raw } as Observation;
    const value: unknown = JSON.parse(raw);
    if (!object(value) || (value.mcpServers !== undefined && !object(value.mcpServers))) return { kind: 'unavailable', raw } as Observation;
    const entry = object(value.mcpServers) ? value.mcpServers.nortuscc : undefined;
    return entry === undefined ? { kind: 'absent', raw } as Observation : { kind: 'present', hash: digest(entry), raw } as Observation;
  }
  const list = yield* cli(input, target, ['mcp', 'list', '--json']);
  if (list.code !== 0) return { kind: 'unavailable', raw } as Observation;
  const entries: unknown = JSON.parse(list.stdout);
  if (!Array.isArray(entries) || !entries.every(e => object(e) && typeof e.name === 'string')) return { kind: 'unavailable', raw } as Observation;
  if (!entries.some(e => e.name === 'nortuscc')) return { kind: 'absent', raw } as Observation;
  const get = yield* cli(input, target, ['mcp', 'get', 'nortuscc', '--json']);
  if (get.code !== 0 || get.stdout.length > 16384) return { kind: 'unavailable', raw } as Observation;
  return { kind: 'present', hash: digest(JSON.parse(get.stdout)), raw } as Observation;
}).pipe(Effect.catchCause(() => Effect.succeed({ kind: 'unavailable' } as Observation)));
const unavailableRouting: ConnectionResult['routing'] = { status: 'unavailable', intent: 'unknown', blockStatus: 'unknown', offeredText: '' };
const publicRouting = (r: McpRoutingStatus): ConnectionResult['routing'] => ({ status: r.status, intent: r.intent, blockStatus: r.blockStatus, offeredText: r.offeredText });
const owns = (receipt: Receipt | undefined, seen: Observation, registry: string) => receipt?.registry === registry && seen.kind === 'present'
  && [receipt.appPath, receipt.previousAppPath].some(path => path !== null && seen.hash === digest(expected(receipt.target, path)));
const result = (target: ConnectionTarget, seen: Observation, store: Store | undefined, registry: string, appPath: string, routing: ConnectionResult['routing'], note = ''): ConnectionResult => {
  const receipt = store?.hosts[target];
  const registration = store === undefined || receipt && receipt.registry !== registry ? 'conflict'
    : seen.kind === 'unavailable' ? 'unavailable'
    : seen.kind === 'absent' ? receipt?.intent === 'active' ? 'repair-needed' : 'absent'
    : !owns(receipt, seen, registry) || receipt?.intent === 'released' ? 'conflict'
    : receipt?.intent === 'disconnecting' ? 'repair-needed'
    : receipt?.appPath !== appPath || seen.hash !== digest(expected(target, appPath)) ? 'repair-needed' : 'configured';
  return { target, registration, routing, session: 'unobserved', reload: receipt?.reload ? 'recommended' : 'unknown', observation: 'local-registration', note };
};
const ready = (input: ConnectionsInput) => Effect.gen(function* () {
  if (!validPath(input.home) || !validPath(input.appPath)) return false;
  const paths = yield* MachinePaths;
  const text = yield* (yield* Fs).readText(join(paths.stateRoot, 'agent/agent.json'));
  try { const value: unknown = JSON.parse(text ?? 'null'); return object(value) && value.installedBy === 'app' && value.appPath === input.appPath; } catch { return false; }
});

// Resolve management under the same fence as registration and routing writes.
const current = Effect.gen(function* () { return (yield* (yield* SetupSource).current).desired; });
export const inspectConnections = (input: ConnectionsInput) => Effect.scoped(Effect.gen(function* () {
  yield* acquireApplyLock;
  const desired = yield* Effect.exit(current);
  const fs = yield* Fs; const connections: ConnectionResult[] = [];
  for (const target of targets) {
    const c = yield* context(input, target); const store = parseStore(yield* fs.readText(c.receiptPath));
    const routing = Exit.isSuccess(desired) ? yield* inspectMcpRouting(desired.value, fileId(target)).pipe(Effect.map(publicRouting), Effect.catchCause(() => Effect.succeed(unavailableRouting))) : unavailableRouting;
    const seen = yield* observe(input, target);
    connections.push(result(target, seen, store, c.registry, input.appPath, routing));
  }
  return { connections } satisfies ConnectionsState;
}));

const change = (input: ConnectionsInput & { target: ConnectionTarget }, active: boolean, options: { lockHeld?: boolean; registrationOnly?: boolean; ownedOnly?: boolean } = {}) => Effect.scoped(Effect.gen(function* () {
  if (!options.lockHeld) yield* acquireApplyLock;
  const fs = yield* Fs; const c = yield* context(input, input.target);
  if (yield* fs.exists(join(c.paths.stateRoot, 'agent/pending-update.json'))) return yield* Effect.fail(new Error('App maintenance is pending'));
  const desired = yield* current;
  let route = yield* inspectMcpRouting(desired, fileId(input.target));
  let storeText = yield* fs.readText(c.receiptPath); const store = parseStore(storeText);
  let seen = yield* observe(input, input.target);
  const finish = (note = '') => result(input.target, seen, store, c.registry, input.appPath, publicRouting(route), note);
  if (!store || store.hosts[input.target] && store.hosts[input.target]!.registry !== c.registry) return finish('Connection ownership needs repair. No registration was changed.');
  const old = store.hosts[input.target];
  if ((yield* fs.stat(c.receiptPath))?.kind === 'symlink') return { ...finish('Connection receipt is a link. It was preserved.'), registration: 'conflict' as const };
  const receiptFile = privateFile(join((yield* fs.realPath(c.paths.stateRoot)) ?? c.paths.stateRoot, 'mcp-connections.json'));
  if (options.ownedOnly && old?.intent !== 'active') return finish();
  if (!(yield* ready(input))) return { ...finish('Open the configured app and repair its local agent first.'), registration: 'unavailable' as const };
  if (seen.kind === 'unavailable') return finish('The host CLI or selected configuration is unavailable.');
  if (seen.kind === 'present' && (!owns(old, seen, c.registry) || old?.intent === 'released')) {
    if (!active) {
      if (old && old.intent !== 'released') {
        yield* (yield* Backups).preserve(c.receiptPath, 'receipts.json', 'mcp-connections', { private: true });
        if ((yield* fs.readText(c.receiptPath)) !== storeText) return { ...finish('Connection ownership changed. Retry after reviewing it.'), registration: 'conflict' as const };
        old.intent = 'released'; old.previousAppPath = null;
        yield* receiptFile.write(JSON.stringify(store) + '\n');
      }
      yield* Effect.exit(setMcpRouting(desired, fileId(input.target), false, route.evidence, { lockHeld: true }));
      route = yield* inspectMcpRouting(desired, fileId(input.target));
    }
    return finish('The registration is foreign or was edited. It has been preserved.');
  }
  const replacement = active && seen.hash !== digest(expected(input.target, input.appPath));
  const mutation = replacement || !active && seen.kind === 'present';
  if (mutation || old?.intent !== (active ? 'active' : 'released')) {
    const backups = yield* Backups;
    yield* backups.preserve(c.registry, `${input.target}-registry`, 'mcp-connections', { private: true });
    yield* backups.preserve(c.receiptPath, 'receipts.json', 'mcp-connections', { private: true });
    const fresh = yield* observe(input, input.target);
    if (fresh.kind !== seen.kind || fresh.hash !== seen.hash || fresh.raw !== seen.raw || (yield* fs.readText(c.receiptPath)) !== storeText) return { ...finish('Configuration changed during preparation. Retry after reviewing it.'), registration: 'conflict' as const };
    const receipt: Receipt = { target: input.target, registry: c.registry, appPath: active ? input.appPath : old?.appPath ?? input.appPath,
      previousAppPath: active && old && old.appPath !== input.appPath ? old.appPath : old?.previousAppPath ?? null,
      intent: active ? 'active' : 'disconnecting', reload: mutation || old?.reload === true, fileId: fileId(input.target), blockId: MCP_ROUTING_BLOCK_ID };
    store.hosts[input.target] = receipt;
    storeText = JSON.stringify(store) + '\n';
    yield* receiptFile.write(storeText);
    const still = yield* observe(input, input.target);
    if (still.kind !== seen.kind || still.hash !== seen.hash || still.raw !== seen.raw || (yield* fs.readText(c.receiptPath)) !== storeText) return { ...finish('Configuration changed before mutation. Ownership was retained for review.'), registration: 'conflict' as const };
    const remove = input.target === 'claude' ? ['mcp', 'remove', '--scope', 'user', 'nortuscc'] : ['mcp', 'remove', 'nortuscc'];
    if (seen.kind === 'present' && mutation) {
      yield* Effect.exit(cli(input, input.target, remove));
      seen = yield* observe(input, input.target);
    }
    if (active && replacement && seen.kind === 'absent') {
      // Reinspect after removal; a failed CLI can have completed its physical write.
      const fresh = yield* observe(input, input.target);
      if (fresh.kind !== 'absent' || fresh.raw !== seen.raw || (yield* fs.readText(c.receiptPath)) !== storeText) {
        seen = fresh; return { ...finish('Configuration changed before registration. Review and retry.'), registration: 'conflict' as const };
      }
      const args = input.target === 'claude' ? ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'nortuscc', '--', input.appPath, '--mcp'] : ['mcp', 'add', 'nortuscc', '--', input.appPath, '--mcp'];
      yield* Effect.exit(cli(input, input.target, args));
      seen = yield* observe(input, input.target);
    }
  }
  const receipt = store.hosts[input.target];
  if (receipt && (active && seen.hash === digest(expected(input.target, input.appPath)) && receipt.previousAppPath !== null
    || !active && seen.kind === 'absent' && receipt.intent !== 'released')) {
    // Retire transition authority after observing completion; old commands no longer prove ownership.
    yield* (yield* Backups).preserve(c.receiptPath, 'receipts.json', 'mcp-connections', { private: true });
    if ((yield* fs.readText(c.receiptPath)) === storeText) {
      receipt.previousAppPath = null; receipt.intent = active ? 'active' : 'released';
      yield* receiptFile.write(JSON.stringify(store) + '\n');
    }
  }
  // A partial native operation is repairable from the receipt. Routing reports its own result.
  if (!options.registrationOnly && (!active || seen.hash === digest(expected(input.target, input.appPath)))) {
    yield* Effect.exit(setMcpRouting(desired, fileId(input.target), active, route.evidence, { lockHeld: true }));
    route = yield* inspectMcpRouting(desired, fileId(input.target));
  }
  return finish(seen.kind === 'unavailable' ? 'The host could not be reinspected. Retry to recover the recorded operation.' : 'Host sessions are not observed. Start a new session or reload the host after configuration changes.');
}));
export const connectHost = (input: ConnectionsInput & { target: ConnectionTarget }) => change(input, true);
export const disconnectHost = (input: ConnectionsInput & { target: ConnectionTarget }) => change(input, false);
// App lifecycle only. Never called by MCP and never enrolls an unowned or released host.
export const repairConnections = (input: ConnectionsInput, options: { lockHeld?: boolean } = {}) => Effect.scoped(Effect.gen(function* () {
  if (!options.lockHeld) yield* acquireApplyLock;
  const fs = yield* Fs; const paths = yield* MachinePaths;
  const store = parseStore(yield* fs.readText(join(paths.stateRoot, 'mcp-connections.json')));
  const connections: ConnectionResult[] = [];
  if (!store) return { connections };
  for (const target of targets) if (store.hosts[target]?.intent === 'active' && (store.hosts[target]?.appPath !== input.appPath || store.hosts[target]?.previousAppPath !== null)) {
    connections.push(yield* change({ ...input, target }, true, { lockHeld: true, registrationOnly: true, ownedOnly: true }));
  }
  return { connections };
}));
