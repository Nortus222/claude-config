import { isAbsolute, join } from 'node:path';
import { Effect } from 'effect';
import {
  AgentStateStore, installService, renderLaunchAgent, renderSystemdUnit, restartService, SetupsStore, stopService,
  trustOwnSetup, unitPath, LAUNCH_AGENT_LABEL, POLICIES, type ServiceProgram, type ServiceTarget,
} from '@nortuscc/agent';
import { decodeWireStatus } from '@nortuscc/agent/ipc/protocol';
import { acquirePidLock, Backups, Fs, liveLockHolder, validMcpRouting, type MachinePathsValue } from '@nortuscc/machine';
import { AgentError, AgentUnavailable, connectAgent, type AgentConnection } from '../../../src/agent-client.ts';
import { loginShell, SHELL_STARTUP_VARIABLES } from './login-environment.ts';

export type LifecycleInput = {
  readonly paths: MachinePathsValue;
  readonly target: ServiceTarget;
  readonly resources: string;
  readonly agentVersion: string;
  readonly appPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  // Pre-probe selection; absent startup variables must remain absent on the next service start.
  readonly shellEnvironment?: Readonly<Record<string, string | undefined>>;
};
export type LifecycleOptions = {
  readonly restart?: boolean;
  // Only the fixed recovery helper supplies an exact journal and verifies health under both locks.
  readonly recovery?: { readonly journal: string; readonly afterRegistration: (signal: AbortSignal) => Promise<void> };
  readonly connect?: () => Promise<AgentConnection>;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly retryDelayMs?: number;
};

// Fixed resource argv and resolved machine paths, independent of renderer input.
export const resourceProgram = (input: LifecycleInput): ServiceProgram => {
  const shellEnvironment = input.shellEnvironment ?? input.env;
  const env: Record<string, string> = { HOME: input.target.home, PATH: input.env.PATH ?? '', SHELL: loginShell(shellEnvironment) };
  for (const key of SHELL_STARTUP_VARIABLES) {
    const value = shellEnvironment[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(input.env)) {
    if (value !== undefined && key.startsWith('NORTUSCC_') && !key.startsWith('NORTUSCC_TEST_')) env[key] = value;
  }
  Object.assign(env, {
    NORTUSCC_REPO_DIR: input.paths.repo,
    NORTUSCC_STATE_DIR: input.paths.stateRoot,
    NORTUSCC_CLAUDE_DIR: input.paths.claude,
    NORTUSCC_CODEX_DIR: input.paths.codex,
    NORTUSCC_OPENROUTER_CODEX_DIR: input.paths.codexOpenRouter,
    NORTUSCC_AGENTS_DIR: input.paths.agentsSkills,
  });
  return {
    argv: [join(input.resources, 'bun'), join(input.resources, 'agent.mjs')],
    env: Object.fromEntries(Object.entries(env).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
    workingDirectory: input.resources,
    logPath: join(input.paths.stateRoot, 'agent', 'agent.log'),
  };
};
const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: (error) => error });

export const pendingPath = (input: LifecycleInput) => join(input.paths.stateRoot, 'agent/pending-update.json');
const validPath = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);

export const validateExistingAuthority = (input: LifecycleInput) => Effect.gen(function* () {
  const fs = yield* Fs;
  const text = yield* fs.readText(join(input.paths.stateRoot, 'agent/agent.json'));
  if (text !== undefined) {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('agent.json is invalid');
    const raw = value as Record<string, unknown>;
    if (raw.version !== 1 || !POLICIES.includes(raw.policy as typeof POLICIES[number]) || (raw.policySource !== 'person' && raw.policySource !== 'default')
      || !(raw.paused === null || (typeof raw.paused === 'object' && raw.paused !== null && !Array.isArray(raw.paused)
        && typeof (raw.paused as Record<string, unknown>).reason === 'string' && typeof (raw.paused as Record<string, unknown>).at === 'string'
        && (!Object.hasOwn(raw.paused, 'runId') || typeof (raw.paused as Record<string, unknown>).runId === 'string')))
      || (raw.installedBy !== undefined && raw.installedBy !== 'app' && raw.installedBy !== 'cli')
      || (raw.agentVersion !== undefined && typeof raw.agentVersion !== 'string') || (raw.appPath !== undefined && !validPath(raw.appPath))) throw new Error('agent.json is invalid; repair it before installing');
  }
  if ((yield* (yield* SetupsStore).read) === undefined) throw new Error('agent/setups.json is invalid; repair it before installing');
  for (const path of [join(input.paths.stateRoot, 'state.json'), join(input.paths.claude, '.nortuscc-lock.json')]) {
    const setup = yield* fs.readText(path);
    if (setup === undefined) continue;
    const raw = JSON.parse(setup) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !(raw.repo === null || typeof raw.repo === 'string')
      || (raw.version !== undefined && raw.version !== 1) || !raw.files || typeof raw.files !== 'object' || Array.isArray(raw.files)
      || !Object.values(raw.files).every(value => value !== null && typeof value === 'object' && typeof (value as Record<string, unknown>).hash === 'string'
        && typeof (value as Record<string, unknown>).appliedAt === 'string')
      || (Object.hasOwn(raw, 'mcpRouting') && !validMcpRouting(raw.mcpRouting))
      || (raw.skillsOnly !== undefined && typeof raw.skillsOnly !== 'boolean')
      || (raw.configTargets !== undefined && (!Array.isArray(raw.configTargets) || !raw.configTargets.every(value => value === 'claude' || value === 'codex')))) throw new Error('setup authority is invalid; repair it before installing');
    break;
  }
});

// Edit only registration values. Stored policy, pause and unknown JSON bytes keep their original form.
const registrationText = (text: string, changes: Readonly<Record<string, string>>): string => {
  const spans = new Map<string, [number, number]>();
  let at = text.indexOf('{') + 1;
  const whitespace = () => { while (/\s/.test(text[at] ?? '') && at < text.length) at++; };
  const stringEnd = (start: number) => {
    let index = start + 1;
    while (index < text.length) {
      if (text[index] === '\\') index += 2;
      else if (text[index++] === '"') return index;
    }
    throw new Error('agent.json is invalid');
  };
  while (true) {
    whitespace(); if (text[at] === '}') break;
    const keyStart = at; at = stringEnd(at);
    const key = JSON.parse(text.slice(keyStart, at)) as string;
    whitespace(); at++; whitespace(); const start = at;
    let depth = 0;
    while (at < text.length) {
      const char = text[at];
      if (char === '"') { at = stringEnd(at); continue; }
      if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') { if (depth === 0) break; depth--; }
      if (char === ',' && depth === 0) break;
      at++;
    }
    let end = at; while (/\s/.test(text[end - 1] ?? '')) end--;
    spans.set(key, [start, end]);
    if (text[at] === ',') at++; else break;
  }
  const edits = Object.entries(changes).flatMap(([key, value]) => {
    const span = spans.get(key); return span ? [{ start: span[0], end: span[1], value: JSON.stringify(value) }] : [];
  });
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
  const additions = Object.entries(changes).filter(([key]) => !spans.has(key)).map(([key, value]) => JSON.stringify(key) + ':' + JSON.stringify(value));
  if (additions.length) { const end = text.lastIndexOf('}'); text = text.slice(0, end) + (spans.size ? ',' : '') + additions.join(',') + text.slice(end); }
  return text;
};

// The Windows app runs its agent as a child (ADR 0040), so nothing is registered: the app only records
// itself as the agent's owner, which the agent and App MCP authenticate. A first ownership trusts the
// app's own setup, as a first installation does; an agent the CLI installed stays the CLI's.
export const recordAppOwnership = (input: LifecycleInput) => Effect.scoped(Effect.gen(function* () {
  if (!isAbsolute(input.appPath) || /[\x00-\x1f\x7f]/.test(input.appPath)) return yield* Effect.fail(new Error('app path must be an absolute executable path without control characters'));
  if (input.target.platform !== 'win32') return yield* Effect.fail(new Error('only the Windows app owns its agent without a login service'));
  const { paths } = input;
  const fs = yield* Fs;
  yield* acquirePidLock(join(paths.stateRoot, 'agent', 'app-install.lock'));
  if ((yield* fs.readText(pendingPath(input))) !== undefined) return yield* Effect.fail(new Error('pending app update requires recovery before ensuring the agent'));
  yield* validateExistingAuthority(input);
  const state = yield* AgentStateStore;
  const recorded = yield* state.read;
  if (recorded.installedBy === 'cli' || (recorded.installedBy === 'app' && recorded.agentVersion === input.agentVersion
    && recorded.appPath === input.appPath)) return { stateRoot: paths.stateRoot };
  const statePath = join(paths.stateRoot, 'agent', 'agent.json');
  const firstInstallation = recorded.installedBy === undefined && recorded.agentVersion === undefined
    && !(yield* fs.exists(join(paths.stateRoot, 'agent', 'setups.json')));
  const backups = yield* Backups;
  for (const name of ['agent.json', 'setups.json']) yield* backups.preserve(join(paths.stateRoot, 'agent', name), name, 'agent');
  if (firstInstallation) yield* trustOwnSetup('app');
  const text = (yield* fs.readText(statePath)) ?? JSON.stringify(yield* state.read);
  yield* fs.writeTextAtomic(statePath, registrationText(text, { installedBy: 'app', agentVersion: input.agentVersion, appPath: input.appPath }));
  return { stateRoot: paths.stateRoot };
}));

// A matching unit alone does not prove a successful bootstrap. The marker is written only after
// registration succeeds, so a failed install remains retryable even if it wrote the desired unit.
export const ensureAgent = (input: LifecycleInput, options: LifecycleOptions = {}) => Effect.scoped(Effect.gen(function* () {
  if (!isAbsolute(input.appPath) || /[\x00-\x1f\x7f]/.test(input.appPath)) return yield* Effect.fail(new Error('app path must be an absolute executable path without control characters'));
  if (input.target.platform === 'win32') return yield* Effect.fail(new Error('desktop agent IPC is not supported on Windows'));
  const { paths, target } = input;
  const fs = yield* Fs;
  yield* acquirePidLock(join(paths.stateRoot, 'agent', 'app-install.lock'));
  const pending = yield* fs.readText(pendingPath(input));
  if (pending !== undefined && (options.recovery === undefined || pending !== options.recovery.journal)) return yield* Effect.fail(new Error('pending app update requires recovery before ensuring the agent'));
  if (options.recovery !== undefined && pending !== options.recovery.journal) return yield* Effect.fail(new Error('pending update changed before recovery'));
  yield* validateExistingAuthority(input);
  const state = yield* AgentStateStore;
  const recorded = yield* state.read;
  const program = resourceProgram(input);
  const rendered = target.platform === 'darwin'
    ? renderLaunchAgent(target.label ?? LAUNCH_AGENT_LABEL, program) : renderSystemdUnit(program);
  const markerPath = join(paths.stateRoot, 'agent', 'app-service.json');
  const marker = JSON.stringify({ agentVersion: input.agentVersion, appPath: input.appPath, program });
  const previousMarker = yield* fs.readText(markerPath);
  const previousUnit = yield* fs.readText(unitPath(target));
  const registered = previousMarker?.trim() === marker;
  const unitMatches = previousUnit === rendered;
  const opened = yield* Effect.result(attempt(options.connect ?? (() => connectAgent(paths, { client: 'app', platform: target.platform }))));
  let conn: AgentConnection | undefined;
  if (opened._tag === 'Success') conn = opened.success;
  else {
    const error = opened.failure;
    if (!(error instanceof AgentUnavailable) && !(options.restart && error instanceof AgentError)) return yield* Effect.fail(error);
    if (!options.restart && liveLockHolder(join(paths.stateRoot, 'agent', 'agent.lock')) !== undefined) {
      return yield* Effect.fail(new Error('the running agent is unreachable; use explicit restart to recover'));
    }
  }
  if (conn) yield* Effect.addFinalizer(() => Effect.sync(() => conn?.close()));
  if (!options.restart && conn?.hello.agentVersion === input.agentVersion && recorded.installedBy === 'app'
    && recorded.agentVersion === input.agentVersion && recorded.appPath === input.appPath && registered && unitMatches) return { stateRoot: paths.stateRoot };
  if ((yield* (yield* SetupsStore).read) === undefined) return yield* Effect.fail(new Error('agent/setups.json is invalid; repair it before installing'));
  // Existing service metadata or a stored trust decision makes this an update or takeover. Only
  // a first installation without either may establish trust; removal must stay a person's choice.
  const firstInstallation = recorded.installedBy === undefined && recorded.agentVersion === undefined
    && previousMarker === undefined && previousUnit === undefined && conn === undefined
    && !(yield* fs.exists(join(paths.stateRoot, 'agent', 'setups.json')));

  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  const poll = options.pollMs ?? 500;
  const checkDeadline = () => Date.now() >= deadline
    ? Effect.fail(new Error('timed out waiting for the agent to be idle; a run may still be applying')) : Effect.void;
  const applyLock = join(paths.stateRoot, 'apply.lock');
  // Hold the shared lock after observing idle, preventing a new machine-changing run between the
  // check and shutdown. Contention keeps waiting; it never grants permission to stop a run.
  while (true) {
    yield* checkDeadline();
    let idle = liveLockHolder(applyLock) === undefined;
    if (conn) {
      const status = yield* Effect.result(attempt(async () => decodeWireStatus(await conn!.request({ command: 'status' }, { timeoutMs: Math.max(1, Math.min(5000, deadline - Date.now())) }))));
      if (status._tag === 'Failure') {
        if (!(status.failure instanceof AgentError && status.failure.code === 'NO_REPORT')) return yield* Effect.fail(status.failure);
        idle = false;
      } else idle = idle && status.success.applying !== true;
    }
    if (idle) {
      const acquired = yield* Effect.result(acquirePidLock(applyLock));
      if (acquired._tag === 'Success') break;
    }
    yield* Effect.sleep(poll);
  }

  const hadConnection = conn !== undefined;
  if (conn) {
    yield* attempt(() => conn!.request({ command: 'shutdown' }, { timeoutMs: 5000 }));
    conn.close();
    conn = undefined;
  } else if (options.restart && liveLockHolder(join(paths.stateRoot, 'agent', 'agent.lock')) !== undefined) {
    yield* stopService(target);
  }
  // Wait for finalizers before updating policy-bearing files. An old agent must not write a pause
  // or policy over the helper's metadata, or start another run while its program is replaced.
  while (liveLockHolder(join(paths.stateRoot, 'agent', 'agent.lock')) !== undefined) {
    yield* checkDeadline();
    yield* Effect.sleep(poll);
  }

  const backups = yield* Backups;
  yield* backups.preserve(unitPath(target), target.platform === 'darwin' ? 'service.plist' : 'service.service', 'agent');
  for (const name of ['agent.json', 'setups.json', 'app-service.json']) {
    yield* backups.preserve(join(paths.stateRoot, 'agent', name), name, 'agent');
  }
  if (firstInstallation) yield* trustOwnSetup('app');
  yield* validateExistingAuthority(input);
  const statePath = join(paths.stateRoot, 'agent', 'agent.json');
  const updateRegistration = (changes: Readonly<Record<string, string>>) => Effect.gen(function* () {
    const text = (yield* fs.readText(statePath)) ?? JSON.stringify(yield* state.read);
    yield* fs.writeTextAtomic(statePath, registrationText(text, changes));
  });
  yield* updateRegistration({ installedBy: 'app', agentVersion: input.agentVersion });
  const serviceOptions = { retryDelayMs: options.retryDelayMs };
  // A reachable unchanged registration remains loaded after graceful shutdown. Recovery of an
  // unreachable job re-registers it, since neither the unit nor the marker proves it is loaded.
  if (registered && unitMatches && hadConnection && options.restart) {
    yield* restartService(target, program, serviceOptions);
  } else {
    yield* installService(target, program, serviceOptions);
  }
  yield* updateRegistration({ appPath: input.appPath });
  yield* fs.writeTextAtomic(markerPath, marker + '\n');
  if (options.recovery) {
    const healthController = new AbortController();
    const health = options.recovery.afterRegistration(healthController.signal);
    // Cancellation joins health before releasing either lock, so a late callback cannot clear pending.
    yield* Effect.addFinalizer(() => Effect.promise(async () => {
      healthController.abort();
      await health.catch(() => undefined);
    }));
    yield* attempt(() => health);
  }
  return { stateRoot: paths.stateRoot };
}));
