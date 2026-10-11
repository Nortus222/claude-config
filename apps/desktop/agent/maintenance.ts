import { createHash } from 'node:crypto';
import { lstat, open, readFile, readdir, readlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Effect } from 'effect';
import { AgentStateStore, installService, renderLaunchAgent, LAUNCH_AGENT_LABEL, unitPath } from '@nortuscc/agent';
import { decodeWireStatus } from '@nortuscc/agent/ipc/protocol';
import { acquirePidLock, Backups, Fs, liveLockHolder, Processes } from '@nortuscc/machine';
import { AgentError, AgentUnavailable, connectAgent, type AgentConnection } from '../../../src/agent-client.ts';
import { decodeMaintenanceAction, decodePrepareUpdate, decodeRecoverUpdate, validInstallerPid, type MaintenanceState } from '../shared/maintenance-protocol.ts';
import { ensureAgent, pendingPath, resourceProgram, validateExistingAuthority, type LifecycleInput } from './lifecycle.ts';

const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: error => error });
type Journal = { version: 1; phase: 'prepared' | 'installing' | 'awaiting-health'; appPath: string; bundlePath: string;
  fromVersion: string; toVersion: string; oldAgentVersion: string; oldBundleHash: string; backupPath: string; installerPid: number | null };
export type MaintenanceOptions = { stdin: AsyncIterable<string | Uint8Array>; stdout: (value: unknown) => void;
  connect?: () => Promise<AgentConnection>; timeoutMs?: number; pollMs?: number; sessionTimeoutMs?: number; retryDelayMs?: number; installerAlive?: (pid: number) => boolean };

// Records have a bounded size and deadline; stdin remains open throughout the native installation.
export async function* maintenanceRecords(stdin: AsyncIterable<string | Uint8Array>) {
  let buffered = '';
  for await (const chunk of stdin) {
    buffered += Buffer.from(chunk).toString('utf8');
    if (Buffer.byteLength(buffered) > 4096) throw new Error('maintenance input exceeds 4096 bytes');
    let end: number;
    while ((end = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      if (line.length === 0) throw new Error('empty maintenance record');
      yield JSON.parse(line) as unknown;
    }
  }
  if (buffered.length) yield JSON.parse(buffered) as unknown;
}
const nextRecord = (records: AsyncIterator<unknown>, timeoutMs: number) => attempt(async () => {
  const next = await records.next();
  if (next.done) throw new Error('maintenance session interrupted at EOF');
  return next.value;
}).pipe(Effect.timeout(timeoutMs));
const hashPattern = /^[a-f0-9]{64}$/;
const validPath = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
const bundleFor = (appPath: string) => {
  if (!validPath(appPath) || !/\.app\/Contents\/MacOS\/[^/]+$/.test(appPath)) throw new Error('maintenance needs an app bundle executable');
  return dirname(dirname(dirname(appPath)));
};
const digestTree = async (path: string): Promise<string> => {
  const hash = createHash('sha256');
  const visit = async (entry: string, name: string): Promise<void> => {
    const stat = await lstat(entry); hash.update(JSON.stringify(name));
    if (stat.isSymbolicLink()) hash.update('link:' + await readlink(entry));
    else if (stat.isDirectory()) { hash.update('dir'); for (const child of (await readdir(entry)).sort()) await visit(join(entry, child), join(name, child)); }
    else if (stat.isFile()) { hash.update('file:' + stat.mode); hash.update(await readFile(entry)); }
    else throw new Error('unsupported app bundle entry');
  };
  await visit(path, ''); return hash.digest('hex');
};
const installedIdentity = (input: LifecycleInput) => Effect.gen(function* () {
  if (input.target.platform !== 'darwin') throw new Error('desktop updates are supported only on macOS');
  const fs = yield* Fs;
  const bundlePath = bundleFor(input.appPath);
  if ((yield* fs.realPath(input.appPath)) !== input.appPath || (yield* fs.realPath(bundlePath)) !== bundlePath
    || !(yield* fs.realPath(input.resources))?.startsWith(bundlePath + '/Contents/')) throw new Error('app bundle path is not canonical');
  const plist = yield* fs.readText(join(bundlePath, 'Contents/Info.plist'));
  const versions = [...(plist ?? '').matchAll(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/g)];
  if (versions.length !== 1) throw new Error('installed app version is invalid');
  const runtime = JSON.parse((yield* fs.readText(join(input.resources, 'runtime.json'))) ?? 'null') as Record<string, unknown> | null;
  if (runtime?.appVersion !== versions[0]![1]!) throw new Error('installed runtime app version does not match bundle');
  if (runtime?.maintenanceProtocol !== 1) throw new Error('unsupported maintenance protocol compatibility');
  if (!runtime || runtime.target !== 'darwin-arm64' || runtime.executable !== 'bun' || runtime.agentVersion !== input.agentVersion
    || !hashPattern.test(input.agentVersion)) throw new Error('installed runtime identity is invalid');
  const actual = yield* attempt(async () => createHash('sha256').update(await readFile(join(input.resources, 'agent.mjs'))).digest('hex'));
  if (actual !== input.agentVersion) throw new Error('installed agent hash does not match runtime identity');
  return { bundlePath, appVersion: versions[0]![1]! };
});

const decodeJournal = (text: string, input: LifecycleInput): Journal => {
  const raw = JSON.parse(text) as Journal;
  const keys = ['version', 'phase', 'appPath', 'bundlePath', 'fromVersion', 'toVersion', 'oldAgentVersion', 'oldBundleHash', 'backupPath', 'installerPid'];
  if (!raw || typeof raw !== 'object' || Object.keys(raw).length !== keys.length || !keys.every(key => Object.hasOwn(raw, key))
    || raw.version !== 1 || (raw.phase === 'installing' ? !validInstallerPid(raw.installerPid) : raw.installerPid !== null)
    || !['prepared', 'installing', 'awaiting-health'].includes(raw.phase) || raw.appPath !== input.appPath
    || raw.bundlePath !== bundleFor(input.appPath) || typeof raw.oldAgentVersion !== 'string' || !hashPattern.test(raw.oldAgentVersion)
    || typeof raw.oldBundleHash !== 'string' || !hashPattern.test(raw.oldBundleHash)
    || !validPath(raw.backupPath) || relative(input.paths.backups, raw.backupPath).startsWith('..') || raw.backupPath === input.paths.backups) throw new Error('pending update journal is invalid');
  decodePrepareUpdate({ fromVersion: raw.fromVersion, toVersion: raw.toVersion }); return raw;
};
// Flush the file and containing directory before granting native permission to replace bytes.
const durableJournal = (input: LifecycleInput, journal: Journal) => Effect.gen(function* () {
  const fs = yield* Fs; const path = pendingPath(input);
  yield* fs.writeTextAtomic(path, JSON.stringify(journal) + '\n');
  yield* attempt(async () => { for (const target of [path, dirname(path)]) { const file = await open(target, 'r'); try { await file.sync(); } finally { await file.close(); } } });
});
export const maintenanceState = (input: LifecycleInput) => Effect.gen(function* () {
  const text = yield* (yield* Fs).readText(pendingPath(input));
  const empty: MaintenanceState = { pending: false, phase: null, fromVersion: null, toVersion: null, backupPath: null, diagnostic: null };
  if (text === undefined) return empty;
  try { const journal = decodeJournal(text, input); return { ...empty, pending: true, phase: journal.phase, fromVersion: journal.fromVersion, toVersion: journal.toVersion, backupPath: journal.backupPath }; }
  catch { return { ...empty, pending: true, diagnostic: 'Pending update journal is invalid; manual recovery is required.' }; }
});
const waitForHealth = async (input: LifecycleInput, options: Pick<MaintenanceOptions, 'connect' | 'pollMs'>, signal: AbortSignal, deadline: number) => {
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    let conn: AgentConnection | undefined;
    try {
      conn = await (options.connect ?? (() => connectAgent(input.paths, { client: 'app', timeoutMs: Math.max(1, Math.min(5000, deadline - Date.now())) })))();
      signal.throwIfAborted();
      if (conn.hello.protocol !== 3 || conn.hello.agentVersion !== input.agentVersion) throw new Error('replacement agent health identity mismatch');
      return;
    } catch (error) { if (!(error instanceof AgentUnavailable)) throw error; }
    finally { conn?.close(); }
    await sleep(options.pollMs ?? 250, undefined, { signal });
  }
  throw new Error('replacement agent health timed out; pending update retained');
};
const restoredHealth = (input: LifecycleInput, options: MaintenanceOptions) => Effect.scoped(Effect.gen(function* () {
  const fs = yield* Fs;
  const controller = new AbortController();
  const health = (async () => {
    await waitForHealth(input, options, controller.signal, Date.now() + (options.timeoutMs ?? 60_000));
    controller.signal.throwIfAborted();
    await Effect.runPromise(fs.remove(pendingPath(input)));
  })();
  // Join a cancelled health probe before the containing maintenance scope releases either lock.
  yield* Effect.addFinalizer(() => Effect.promise(async () => {
    controller.abort();
    await health.catch(() => undefined);
  }));
  yield* attempt(() => health);
}));

export const prepareUpdate = (input: LifecycleInput, options: MaintenanceOptions) => Effect.scoped(Effect.gen(function* () {
  const records = maintenanceRecords(options.stdin)[Symbol.asyncIterator]();
  const versions = decodePrepareUpdate(yield* nextRecord(records, 5000));
  yield* acquirePidLock(join(input.paths.stateRoot, 'agent/app-install.lock'));
  const fs = yield* Fs;
  if (yield* fs.exists(pendingPath(input))) throw new Error('pending update requires recovery');
  yield* validateExistingAuthority(input);
  const state = yield* (yield* AgentStateStore).read;
  if (state.installedBy !== 'app' || state.appPath !== input.appPath || state.agentVersion !== input.agentVersion) throw new Error('only the app-owned agent can be updated');
  const program = resourceProgram(input);
  const marker = yield* fs.readText(join(input.paths.stateRoot, 'agent/app-service.json'));
  const unit = yield* fs.readText(unitPath(input.target));
  if (marker?.trim() !== JSON.stringify({ agentVersion: input.agentVersion, appPath: input.appPath, program })
    || unit !== renderLaunchAgent(input.target.label ?? LAUNCH_AGENT_LABEL, program)) throw new Error('app-owned service registration does not match this bundle');
  const identity = yield* installedIdentity(input);
  if (identity.appVersion !== versions.fromVersion) throw new Error('installed app version does not match update');
  const opened = yield* Effect.result(attempt(options.connect ?? (() => connectAgent(input.paths, { client: 'app' }))));
  let conn: AgentConnection | undefined;
  if (opened._tag === 'Success') { conn = opened.success; if (conn.hello.agentVersion !== input.agentVersion || conn.hello.protocol !== 3) { conn.close(); throw new Error('running agent is not the app-owned runtime'); } }
  else if (!(opened.failure instanceof AgentUnavailable) || liveLockHolder(join(input.paths.stateRoot, 'agent/agent.lock')) !== undefined) return yield* Effect.fail(opened.failure);
  yield* Effect.addFinalizer(() => Effect.sync(() => conn?.close()));
  const deadline = Date.now() + (options.timeoutMs ?? 60_000), poll = options.pollMs ?? 250;
  const budget = () => { if (Date.now() >= deadline) throw new Error('timed out waiting for agent idle or finalizers'); };
  while (true) {
    budget(); let idle = liveLockHolder(join(input.paths.stateRoot, 'apply.lock')) === undefined;
    if (conn) {
      const status = yield* Effect.result(attempt(async () => decodeWireStatus(await conn!.request({ command: 'status' }, { timeoutMs: Math.max(1, Math.min(5000, deadline - Date.now())) }))));
      if (status._tag === 'Failure') { if (!(status.failure instanceof AgentError && status.failure.code === 'NO_REPORT')) return yield* Effect.fail(status.failure); idle = false; }
      else idle = idle && status.success.applying !== true;
    }
    if (idle && (yield* Effect.result(acquirePidLock(join(input.paths.stateRoot, 'apply.lock'))))._tag === 'Success') break;
    yield* Effect.sleep(poll);
  }
  const backups = yield* Backups;
  const backupPath = yield* backups.preserve(identity.bundlePath, 'Nortuscc.app', 'desktop-update');
  if (!backupPath) throw new Error('app bundle backup failed');
  const oldBundleHash = yield* attempt(() => digestTree(backupPath));
  if ((yield* attempt(() => digestTree(identity.bundlePath))) !== oldBundleHash) throw new Error('app bundle changed while backing up');
  let journal: Journal = { version: 1, phase: 'prepared', ...versions, bundlePath: identity.bundlePath, appPath: input.appPath,
    oldAgentVersion: input.agentVersion, oldBundleHash, backupPath, installerPid: null };
  yield* durableJournal(input, journal);
  if (conn) { yield* attempt(() => conn!.request({ command: 'shutdown' }, { timeoutMs: 5000 })); conn.close(); conn = undefined; }
  while (liveLockHolder(join(input.paths.stateRoot, 'agent/agent.lock')) !== undefined) { budget(); yield* Effect.sleep(poll); }
  // Unload after shutdown to prevent launchd from respawning the old runtime during replacement.
  const result = yield* (yield* Processes).run({ cmd: 'launchctl', args: ['bootout', `gui/${input.target.uid}/${input.target.label ?? LAUNCH_AGENT_LABEL}`], output: 'capture', stderr: 'capture' });
  if (result.code !== 0) throw new Error('could not unload app-owned agent service');
  // A job may have respawned after the first drain, before bootout disabled further starts.
  while (liveLockHolder(join(input.paths.stateRoot, 'agent/agent.lock')) !== undefined) { budget(); yield* Effect.sleep(poll); }
  for (const [path, name] of [[unitPath(input.target), 'service.plist'], ...['agent.json', 'setups.json', 'app-service.json'].map(name => [join(input.paths.stateRoot, 'agent', name), name])]) yield* backups.preserve(path!, name!, 'desktop-update');
  options.stdout({ ready: true, backupPath });
  let installing = false;
  let restoreAttempted = false;
  const restore = Effect.gen(function* () {
    restoreAttempted = true;
    if (journal.phase !== 'prepared' || (yield* installedIdentity(input)).appVersion !== journal.fromVersion
      || (yield* attempt(() => digestTree(identity.bundlePath))) !== journal.oldBundleHash) throw new Error('old app identity cannot be proved; pending update retained');
    yield* installService(input.target, resourceProgram(input), { retryDelayMs: options.retryDelayMs });
    yield* restoredHealth(input, options);
  });
  const session = Effect.gen(function* () {
    while (true) {
      const record = decodeMaintenanceAction(yield* nextRecord(records, options.sessionTimeoutMs ?? 180_000));
      if (record.action === 'begin-install') {
        if (installing) throw new Error('installation already began');
        journal = { ...journal, phase: 'installing', installerPid: record.installerPid }; yield* durableJournal(input, journal); installing = true; options.stdout({ installing: true });
      } else if (record.action === 'commit') {
        if (!installing) throw new Error('commit requires begin-install');
        yield* durableJournal(input, { ...journal, phase: 'awaiting-health', installerPid: null }); return { committed: true };
      } else {
        if (installing) throw new Error('installation interrupted; pending recovery required');
        yield* restore; return { aborted: true };
      }
    }
  });
  return yield* session.pipe(Effect.onExit(exit => exit._tag === 'Failure' && !installing && !restoreAttempted ? restore.pipe(Effect.catchCause(() => Effect.void)) : Effect.void));
}));
export const recoverUpdate = (input: LifecycleInput, options: Omit<MaintenanceOptions, 'stdout'>) => Effect.gen(function* () {
  const records = maintenanceRecords(options.stdin)[Symbol.asyncIterator]();
  const { appVersion } = decodeRecoverUpdate(yield* nextRecord(records, 5000));
  const trailing = yield* attempt(() => records.next()).pipe(Effect.timeout(5000));
  if (!trailing.done) throw new Error('recovery accepts exactly one record; extra input refused');
  const fs = yield* Fs; const text = yield* fs.readText(pendingPath(input));
  if (text === undefined) return { recovered: false, interrupted: false, stateRoot: input.paths.stateRoot };
  const journal = decodeJournal(text, input);
  // A live native installer keeps recovery fenced after its helper session times out.
  if (journal.phase === 'installing' && options.installerAlive?.(journal.installerPid!) !== false) throw new Error('native installer may still be running; exit the installing app before recovery');
  const identity = yield* installedIdentity(input);
  if (identity.appVersion !== appVersion) throw new Error('native app version does not match installed bundle');
  const interrupted = appVersion === journal.fromVersion;
  if (interrupted) {
    if (input.agentVersion !== journal.oldAgentVersion
      || (yield* attempt(() => digestTree(identity.bundlePath))) !== journal.oldBundleHash) throw new Error('interrupted installation has no proven intact old bundle');
  } else if (appVersion !== journal.toVersion || journal.phase === 'prepared') throw new Error('installed app does not match pending update');
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  yield* ensureAgent(input, { restart: true, connect: options.connect, pollMs: options.pollMs, timeoutMs: options.timeoutMs, retryDelayMs: options.retryDelayMs,
    recovery: { journal: text, afterRegistration: async signal => {
      await waitForHealth(input, options, signal, deadline);
      signal.throwIfAborted();
      await Effect.runPromise(fs.remove(pendingPath(input)));
    } } });
  return { recovered: true, interrupted, stateRoot: input.paths.stateRoot };
});
