import { join } from 'node:path';
import { Cause, Effect } from 'effect';
import { configDomain, Fs, skillsDomain, type MachinePathsValue } from '@nortuscc/machine';
import {
  agentLayer, AgentStateStore, installService, runAgent, trustOwnSetup, uninstallService, unitPath, type ServiceFailed, type ServiceTarget,
} from '@nortuscc/agent';
import { setupSourceLayer } from '@nortuscc/sync';
import { agentProgram, checkoutVersion, serviceTarget } from '../agent-service.ts';
import { CHECKOUT, resolvePaths, runCommand } from '../machine.ts';

const USAGE = `Usage: nortuscc agent install [--linger] | uninstall | run
  agent install [--linger]   run the local agent as a login service from this checkout
                             --linger (Linux) keeps it running with nobody logged in
  agent uninstall            stop the agent and remove its login service
  agent run                  run the agent in the foreground (the service runs this)`;

const APP_MANAGES = 'nortuscc: the desktop app manages the agent on this machine; manage it from the app.';

const usage = (problem?: string): number => {
  if (problem) console.error(`nortuscc: ${problem}\n`);
  console.error(USAGE);
  return 2;
};

// This machine's service target, or the exit code when the platform has no login service.
const targetFor = (paths: MachinePathsValue): ServiceTarget | number => {
  const target = serviceTarget(paths);
  if (target) return target;
  console.error(`nortuscc: the agent's login service is not supported on ${process.platform}`);
  return 2;
};

// A service manager failure reads as the command that failed and why.
const serviceFailed = (err: ServiceFailed) => Effect.sync(() => {
  console.error(`nortuscc: ${err.command} exited ${err.code}: ${err.reason}`);
  return 1;
});

// Trusts this checkout, writes and registers the login service, and records the CLI as its installer.
const install = (linger: boolean) =>
  Effect.gen(function* () {
    const paths = yield* resolvePaths((m) => console.error(m));
    const target = targetFor(paths);
    if (typeof target === 'number') return target;
    return yield* Effect.gen(function* () {
      const state = yield* AgentStateStore;
      if ((yield* state.read).installedBy === 'app') {
        console.error(APP_MANAGES);
        return 1;
      }
      const trusted = yield* trustOwnSetup('cli');
      if (trusted === undefined) {
        console.error(`nortuscc: ${join(paths.stateRoot, 'agent', 'setups.json')} is not valid, so nothing was installed; fix it by hand and re-run.`);
        return 1;
      }
      console.log(`trusted: ${trusted.repoUrl ?? trusted.checkout}`);
      const program = agentProgram(paths);
      yield* installService(target, program, { linger });
      yield* state.update((s) => ({ ...s, installedBy: 'cli', agentVersion: checkoutVersion() }));
      console.log(`agent installed: ${unitPath(target)}`);
      console.log(`log: ${program.logPath}`);
      return 0;
    }).pipe(Effect.catchTag('ServiceFailed', serviceFailed), Effect.provide(agentLayer(paths)));
  });

// Stops and removes the login service and the agent's socket and token; History, decisions,
// backups and trusted setups stay. Nothing installed is not an error.
const uninstall = Effect.gen(function* () {
  const paths = yield* resolvePaths((m) => console.error(m));
  const target = targetFor(paths);
  if (typeof target === 'number') return target;
  return yield* Effect.gen(function* () {
    const state = yield* AgentStateStore;
    const before = yield* state.read;
    if (before.installedBy === 'app') {
      console.error(APP_MANAGES);
      return 1;
    }
    yield* uninstallService(target);
    const fs = yield* Fs;
    for (const name of ['agent.sock', 'agent.token']) yield* fs.remove(join(paths.stateRoot, 'agent', name));
    if (before.installedBy !== undefined || before.agentVersion !== undefined) {
      // update drops the owned fields its result leaves out.
      yield* state.update(({ installedBy: _installedBy, agentVersion: _agentVersion, ...rest }) => rest);
    }
    console.log('agent uninstalled; History, decisions, backups and trusted setups are kept');
    return 0;
  }).pipe(Effect.catchTag('ServiceFailed', serviceFailed), Effect.provide(agentLayer(paths)));
});

// Runs the agent in the foreground until SIGTERM or SIGINT, which exit 0.
async function runForeground(): Promise<number> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    return await Effect.runPromise(Effect.gen(function* () {
      const paths = yield* resolvePaths((m) => console.error(m));
      const lock = join(paths.stateRoot, 'agent', 'agent.lock');
      console.error(`nortuscc agent: running from ${CHECKOUT} (pid ${process.pid})`);
      // The integrations domain captures its paths at construction (ADR 0016), so it joins once #78
      // can rebuild it per job.
      return yield* runAgent({ paths, domains: [configDomain, skillsDomain], source: setupSourceLayer(paths), signal: controller.signal }).pipe(
        Effect.as(0),
        Effect.catchTag('LockHeld', (err) => Effect.sync(() => {
          console.error(err.path === lock ? `nortuscc: another agent (pid ${err.pid}) is running` : `nortuscc: ${err.message}`);
          return 1;
        })),
      );
    }).pipe(Effect.catchCause((cause) => Effect.sync(() => {
      const error = Cause.squash(cause);
      console.error(`nortuscc: ${error instanceof Error && error.message ? error.message : String(error)}`);
      return 1;
    }))));
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}

export async function run(args: string[] = []): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'install': {
      const unknown = rest.find((arg) => arg !== '--linger');
      if (unknown !== undefined) return usage(`unknown option ${unknown}`);
      const linger = rest.includes('--linger');
      if (linger && process.platform !== 'linux') {
        console.error('nortuscc: --linger is for Linux only');
        return 2;
      }
      return runCommand(() => install(linger));
    }
    case 'uninstall':
      if (rest.length > 0) return usage(`unknown option ${rest[0]}`);
      return runCommand(() => uninstall);
    case 'run':
      if (rest.length > 0) return usage(`unknown option ${rest[0]}`);
      return runForeground();
    default:
      return usage(sub === undefined ? undefined : `unknown agent command '${sub}'`);
  }
}
