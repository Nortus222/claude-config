import { join } from 'node:path';
import { Effect } from 'effect';
import {
  AgentStateStore, installService, renderLaunchAgent, renderSystemdUnit, restartService, SetupsStore, stopService,
  trustOwnSetup, unitPath, LAUNCH_AGENT_LABEL, type ServiceProgram, type ServiceTarget,
} from '@nortuscc/agent';
import { decodeWireStatus } from '@nortuscc/agent/ipc/protocol';
import { acquirePidLock, Backups, Fs, liveLockHolder, type MachinePathsValue } from '@nortuscc/machine';
import { AgentError, AgentUnavailable, connectAgent, type AgentConnection } from '../../../src/agent-client.ts';

export type LifecycleInput = {
  readonly paths: MachinePathsValue;
  readonly target: ServiceTarget;
  readonly resources: string;
  readonly agentVersion: string;
  readonly env: Readonly<Record<string, string | undefined>>;
};
export type LifecycleOptions = {
  readonly restart?: boolean;
  readonly connect?: () => Promise<AgentConnection>;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly retryDelayMs?: number;
};

// Fixed resource argv and resolved machine paths, independent of renderer input.
export const resourceProgram = (input: LifecycleInput): ServiceProgram => {
  const env: Record<string, string> = { HOME: input.target.home, PATH: input.env.PATH ?? '' };
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

// A matching unit alone does not prove a successful bootstrap. The marker is written only after
// registration succeeds, so a failed install remains retryable even if it wrote the desired unit.
export const ensureAgent = (input: LifecycleInput, options: LifecycleOptions = {}) => Effect.scoped(Effect.gen(function* () {
  if (input.target.platform === 'win32') return yield* Effect.fail(new Error('desktop agent IPC is not supported on Windows'));
  const { paths, target } = input;
  const fs = yield* Fs;
  yield* acquirePidLock(join(paths.stateRoot, 'agent', 'app-install.lock'));
  const state = yield* AgentStateStore;
  const recorded = yield* state.read;
  const program = resourceProgram(input);
  const rendered = target.platform === 'darwin'
    ? renderLaunchAgent(target.label ?? LAUNCH_AGENT_LABEL, program) : renderSystemdUnit(program);
  const markerPath = join(paths.stateRoot, 'agent', 'app-service.json');
  const marker = JSON.stringify({ agentVersion: input.agentVersion, program });
  const registered = (yield* fs.readText(markerPath))?.trim() === marker;
  const unitMatches = (yield* fs.readText(unitPath(target))) === rendered;
  const opened = yield* Effect.result(attempt(options.connect ?? (() => connectAgent(paths, { client: 'app' }))));
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
    && recorded.agentVersion === input.agentVersion && registered && unitMatches) return { stateRoot: paths.stateRoot };
  if ((yield* (yield* SetupsStore).read) === undefined) return yield* Effect.fail(new Error('agent/setups.json is invalid; repair it before installing'));

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
  yield* trustOwnSetup('app');
  yield* state.update((s) => ({ ...s, installedBy: 'app', agentVersion: input.agentVersion }));
  const serviceOptions = { retryDelayMs: options.retryDelayMs };
  // A reachable unchanged registration remains loaded after graceful shutdown. Recovery of an
  // unreachable job re-registers it, since neither the unit nor the marker proves it is loaded.
  if (registered && unitMatches && hadConnection && options.restart) {
    yield* restartService(target, program, serviceOptions);
  } else {
    yield* installService(target, program, serviceOptions);
  }
  yield* fs.writeTextAtomic(markerPath, marker + '\n');
  return { stateRoot: paths.stateRoot };
}));
