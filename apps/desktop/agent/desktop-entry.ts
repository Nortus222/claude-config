import { homedir, userInfo } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { Cause, Effect, Exit, Layer } from 'effect';
import { agentSkillInstaller, agentLayer, runAgent, type HostedOptions } from '@nortuscc/agent';
import {
  backupsForRun, configDomain, Fs, integrationsDomain, nodeFileIntegrity, nodeFs, nodeProcesses, nodeProcessDialogue, pathsFromEnvironment, skillsDomain,
  type MachinePathsValue, type Processes,
} from '@nortuscc/machine';
import { setupSourceLayer } from '@nortuscc/sync';
import { maintenanceState, prepareUpdate, recoverUpdate } from './maintenance.ts';
import { inspectConnections, connectHost, disconnectHost, repairConnections } from './mcp-connections.ts';
import { decodeConnectionAction } from '../shared/mcp-connections-protocol.ts';
import { ensureAgent } from './lifecycle.ts';
import { probeLoginEnvironment } from './login-environment.ts';
import { bootstrapSetup, decodeSetupChoices, requestGitInstall, setupState } from './onboarding.ts';
import { desktopHostedUrl } from './public-config.ts';
import { decodeRecoverUpdate } from '../shared/maintenance-protocol.ts';
import { decodeStartupContext, type StartupContext } from '../shared/startup-protocol.ts';
import { type StartupDiagnostics, type StartupPhase } from './startup-diagnostics.ts';

export type DesktopEntryInput = {
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly resources: string;
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly user?: string;
  readonly processes?: Layer.Layer<Processes>;
  readonly probe?: typeof probeLoginEnvironment;
  readonly signal?: AbortSignal;
  readonly bootstrapTimeoutMs?: number;
  readonly stdin?: AsyncIterable<string | Uint8Array>;
  readonly hostedDependencies?: Pick<HostedOptions, 'transport' | 'keychain' | 'now'>;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
};

// No arguments run the service. Fixed helpers emit JSON records; prepare keeps its session open through installation.
export async function runDesktopEntry(input: DesktopEntryInput, trace: StartupDiagnostics): Promise<number> {
  const stdout = input.stdout ?? ((text) => { process.stdout.write(text); });
  const stderr = input.stderr ?? ((text) => { process.stderr.write(text); });
  const phase = <A, E, R>(name: StartupPhase, effect: Effect.Effect<A, E, R>) =>
    Effect.sync(() => trace.record(name, 'started')).pipe(Effect.andThen(effect), Effect.onExit(exit => Effect.sync(() =>
      trace.record(name, Exit.isSuccess(exit) ? 'completed'
        : controller.signal.aborted || input.signal?.aborted || Cause.hasInterruptsOnly(exit.cause) ? 'cancelled' : 'failed'))));
  // The probe owns detached children; interruption must wait for its abort-aware cleanup to join.
  const probe = () => Effect.tryPromise({ try: async () => {
    trace.record('login_probe', 'started');
    try {
      signal.throwIfAborted();
      const result = await (input.probe ?? probeLoginEnvironment)({ env: input.env, runtime: process.execPath, onProgress: trace.record, signal });
      signal.throwIfAborted();
      trace.record('login_probe', result.error ? 'fallback' : 'completed');
      return result;
    } catch (error) { trace.record('login_probe', signal.aborted ? 'cancelled' : 'failed'); throw error; }
  }, catch: error => error }).pipe(Effect.uninterruptible);
  trace.record('entry', 'started');
  const controller = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  // Starts before probes/input/Git, leaving ten seconds before the native 120-second deadline.
  const deadline = input.args[0] === '--bootstrap' ? setTimeout(stop, input.bootstrapTimeoutMs ?? 110_000) : undefined;
  try {
    const code = await Effect.runPromise(Effect.gen(function* () {
      const [arg, appFlag, appPath] = input.args;
      const serviceHelper = arg === '--startup' || arg === '--ensure' || arg === '--restart' || arg === '--bootstrap' || arg === '--prepare-update' || arg === '--recover-update' || arg === '--maintenance-state' || arg === '--mcp-connections';
      if (!(input.args.length === 0 || (['--paths', '--setup-state', '--install-git'].includes(arg ?? '') && input.args.length === 1)
        || (serviceHelper && input.args.length === 3 && appFlag === '--app' && appPath !== undefined
          && isAbsolute(appPath) && !/[\x00-\x1f\x7f]/.test(appPath)))) {
        return yield* Effect.fail(new Error('Usage: agent.mjs [--startup | --ensure | --restart | --bootstrap | --prepare-update | --recover-update | --maintenance-state] --app <absolute executable> | --paths | --setup-state | --install-git'));
      }
      if (arg === '--startup') {
        const versions = yield* Effect.tryPromise({ try: () => readStartupInput(input.stdin ?? process.stdin), catch: error => error }).pipe(Effect.timeout(5000));
        signal.throwIfAborted();
        const login = yield* probe();
        signal.throwIfAborted();
        // The resolved environment stays inside this helper. Original shell selectors remain authoritative.
        const env: Readonly<Record<string, string | undefined>> = { ...login.env, ...(input.env.NORTUSCC_DESKTOP_LOCAL_ONLY === undefined ? {}
          : { NORTUSCC_DESKTOP_LOCAL_ONLY: input.env.NORTUSCC_DESKTOP_LOCAL_ONLY }) };
        const home = env.HOME ?? input.env.HOME ?? homedir();
        const platform = input.platform ?? process.platform;
        const paths = yield* phase('paths', pathsFromEnvironment({ env, home, platform, fallbackRepo: home }));
        const context: StartupContext = decodeStartupContext({ stateRoot: paths.stateRoot, setup: null, maintenance: null, outcome: 'setup_failed' });
        const emit = () => { signal.throwIfAborted(); stdout(JSON.stringify(decodeStartupContext(context)) + '\n'); return 0; };
        const setup = yield* Effect.exit(phase('setup_state', Effect.tryPromise({
          try: async () => {
            const setup = await setupState({ env, home, platform, processes: input.processes, signal });
            // Validate read-only authority before any runtime, maintenance or lifecycle action.
            return decodeStartupContext({ ...context, setup, outcome: 'runtime_failed' }).setup!;
          }, catch: error => error,
        })));
        signal.throwIfAborted();
        if (Exit.isFailure(setup)) return emit();
        context.setup = setup.value;
        const runtime = yield* Effect.exit(phase('runtime_metadata', Effect.gen(function* () {
          const metadata = yield* Fs.use(fs => fs.readText(resolve(input.resources, 'runtime.json'))).pipe(Effect.provide(nodeFs));
          return yield* Effect.try({ try: () => {
            const parsed: unknown = JSON.parse(metadata ?? 'null');
            if (typeof parsed !== 'object' || parsed === null || !('agentVersion' in parsed)
              || typeof parsed.agentVersion !== 'string' || parsed.agentVersion.trim() === '') throw new Error('invalid runtime metadata');
            return parsed.agentVersion;
          }, catch: error => error });
        })));
        signal.throwIfAborted();
        if (Exit.isFailure(runtime)) { context.outcome = 'runtime_failed'; return emit(); }
        if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') { context.outcome = 'maintenance_failed'; return emit(); }
        const processes = input.processes ?? nodeProcesses({ env, inherit: 'stderr' });
        const lifecycleInput = { paths, env, shellEnvironment: input.env, resources: input.resources, agentVersion: runtime.value,
          appPath: appPath!, target: { platform, home, uid: input.uid ?? process.getuid?.() ?? 0,
            user: input.user ?? userInfo().username, stateRoot: paths.stateRoot } };
        const operation = Effect.gen(function* () {
          const maintenance = yield* Effect.exit(phase('maintenance_state', maintenanceState(lifecycleInput)));
          signal.throwIfAborted();
          if (Exit.isFailure(maintenance)) { context.outcome = 'maintenance_failed'; return; }
          context.maintenance = maintenance.value;
          if (context.setup!.needsSetup) { context.outcome = 'needs_setup'; return; }
          if (platform !== 'darwin' && platform !== 'linux') {
            context.outcome = maintenance.value.pending ? 'recovery_failed' : 'ensure_failed'; return;
          }
          if (maintenance.value.pending) {
            const recovered = yield* Effect.exit(phase('lifecycle', recoverUpdate(lifecycleInput, {
              stdin: { async *[Symbol.asyncIterator]() { yield JSON.stringify(versions) + '\n'; } }, installerAlive: pid => {
                try { process.kill(pid, 0); return true; }
                catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
              },
            })));
            signal.throwIfAborted();
            context.outcome = Exit.isSuccess(recovered) && recovered.value.recovered ? 'recovered' : 'recovery_failed';
          } else {
            const ensured = yield* Effect.exit(phase('lifecycle', ensureAgent(lifecycleInput)));
            signal.throwIfAborted();
            context.outcome = Exit.isSuccess(ensured) ? 'ready' : 'ensure_failed';
          }
        });
        yield* operation.pipe(Effect.provide(nodeFileIntegrity),
          Effect.provide(backupsForRun().pipe(Layer.provideMerge(agentLayer(paths, { processes })))));
        if (context.outcome === 'ready' || context.outcome === 'recovered') {
          yield* Effect.exit(repairConnections({ home, appPath: appPath! }).pipe(
            Effect.provide(setupSourceLayer(paths, { processes })),
            Effect.provide(backupsForRun().pipe(Layer.provideMerge(agentLayer(paths, { processes }))))));
        }
        return emit();
      }
      if (arg === '--paths' || arg === '--setup-state' || arg === '--install-git' || arg === '--bootstrap') {
        // First-run helpers need no existing checkout or bundled runtime metadata.
        const login = yield* probe();
        if (login.error) stderr(`nortuscc agent: ${login.error}\n`);
        const helperInput = { env: login.env, home: login.env.HOME ?? input.env.HOME ?? homedir(), platform: input.platform ?? process.platform, processes: input.processes, signal };
        helperInput.signal.throwIfAborted();
        if (arg === '--setup-state') {
          stdout(JSON.stringify(yield* phase('setup_state', Effect.tryPromise({ try: () => setupState(helperInput), catch: (error) => error }))) + '\n');
          return 0;
        }
        if (arg === '--install-git') {
          yield* phase('lifecycle', Effect.tryPromise({ try: () => requestGitInstall(helperInput), catch: (error) => error }));
          stdout(JSON.stringify({ requested: true }) + '\n');
          return 0;
        }
        if (arg === '--bootstrap') {
          const choices = yield* Effect.tryPromise({ try: () => readSetupChoices(input.stdin ?? process.stdin), catch: (error) => error }).pipe(Effect.timeout(5000));
          helperInput.signal.throwIfAborted();
          const result = yield* phase('lifecycle', Effect.tryPromise({ try: () => bootstrapSetup(helperInput, choices), catch: (error) => error }));
          stdout(JSON.stringify(result) + '\n');
          return 0;
        }
        const paths = yield* phase('paths', pathsFromEnvironment({ env: login.env, home: login.env.HOME ?? input.env.HOME ?? homedir(),
          platform: input.platform ?? process.platform, fallbackRepo: input.env.HOME ?? homedir() }));
        stdout(JSON.stringify({ stateRoot: paths.stateRoot }) + '\n');
        return 0;
      }
      const runtime = yield* phase('runtime_metadata', Effect.gen(function* () {
        const metadata = yield* Fs.use((fs) => fs.readText(resolve(input.resources, 'runtime.json'))).pipe(Effect.provide(nodeFs));
        return yield* Effect.try({
          try: () => {
            const parsed: unknown = JSON.parse(metadata ?? 'null');
            if (typeof parsed !== 'object' || parsed === null || !('agentVersion' in parsed)
              || typeof parsed.agentVersion !== 'string' || parsed.agentVersion.trim() === '') throw new Error('runtime.json has no agentVersion');
            return { agentVersion: parsed.agentVersion, appVersion: 'appVersion' in parsed && typeof parsed.appVersion === 'string' ? parsed.appVersion : undefined, target: 'target' in parsed && typeof parsed.target === 'string' ? parsed.target : undefined };
          }, catch: (error) => error,
        });
      }));
      const agentVersion = runtime.agentVersion;
      const login = yield* probe();
      if (login.error) stderr(`nortuscc agent: ${login.error}\n`);
      const env: Readonly<Record<string, string | undefined>> = { ...login.env, ...(input.env.NORTUSCC_DESKTOP_LOCAL_ONLY === undefined ? {} : { NORTUSCC_DESKTOP_LOCAL_ONLY: input.env.NORTUSCC_DESKTOP_LOCAL_ONLY }) };
      const hostedUrl = desktopHostedUrl(env);
      const home = env.HOME ?? input.env.HOME ?? homedir();
      const platform = input.platform ?? process.platform;
      const paths = yield* phase('paths', pathsFromEnvironment({ env, home, platform, ...(arg === '--maintenance-state' ? { fallbackRepo: home } : {}) }));
      const processes = input.processes ?? nodeProcesses({ env, inherit: 'stderr' });
      if (arg !== undefined) {
        if (platform !== 'darwin' && platform !== 'linux') return yield* Effect.fail(new Error(`desktop agent IPC is not supported on ${platform}`));
        const lifecycleInput = {
          paths, env, shellEnvironment: input.env, resources: input.resources, agentVersion,
          appPath: appPath!,
          target: { platform, home, uid: input.uid ?? process.getuid?.() ?? 0, user: input.user ?? userInfo().username, stateRoot: paths.stateRoot },
        };
        const operation = Effect.gen(function* () {
          if (arg === '--mcp-connections') {
            const action = yield* Effect.tryPromise({ try: () => readConnectionAction(input.stdin ?? process.stdin), catch: () => new Error('Invalid connection action') }).pipe(Effect.timeout(5000));
            const connectionInput = { home, appPath: appPath! };
            if (action.action === 'inspect') return yield* inspectConnections(connectionInput);
            return { connections: [yield* (action.action === 'connect' ? connectHost : disconnectHost)({ ...connectionInput, target: action.target })] };
          }
          if (arg === '--maintenance-state') return yield* maintenanceState(lifecycleInput);
          if (arg === '--prepare-update') return yield* prepareUpdate(lifecycleInput, { stdin: input.stdin ?? process.stdin, stdout: value => stdout(JSON.stringify(value) + '\n') });
          if (arg === '--recover-update') return yield* recoverUpdate(lifecycleInput, { stdin: input.stdin ?? process.stdin, installerAlive: pid => {
            try { process.kill(pid, 0); return true; }
            catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
          } });
          return yield* ensureAgent(lifecycleInput, { restart: arg === '--restart' });
        });
        const result = yield* phase('lifecycle', operation.pipe(
          Effect.provide(nodeFileIntegrity),
          Effect.provide(setupSourceLayer(paths, { processes })),
          Effect.provide(backupsForRun().pipe(Layer.provideMerge(agentLayer(paths, { processes })))),
        ));
        if (arg === '--ensure' || arg === '--restart' || arg === '--recover-update') {
          yield* Effect.exit(repairConnections({ home, appPath: appPath! }).pipe(
            Effect.provide(setupSourceLayer(paths, { processes })),
            Effect.provide(backupsForRun().pipe(Layer.provideMerge(agentLayer(paths, { processes }))))));
        }
        stdout(JSON.stringify(result) + '\n');
        return 0;
      }
      // Each job's integrations domain reads that job's snapshot and uses the login environment.
      const domains = (jobPaths: MachinePathsValue) => [configDomain, integrationsDomain({ paths: jobPaths, env }), skillsDomain];
      yield* runAgent({
        ...(hostedUrl === undefined ? {} : { hosted: { url: hostedUrl, platform, ...input.hostedDependencies } }),
        ...(runtime.appVersion && runtime.target ? { appRuntime: { version: runtime.appVersion, runtimeId: agentVersion, appDirectory: resolve(input.resources, '../../MacOS'), platform, target: runtime.target, metadataPath: resolve(input.resources, 'runtime.json') } } : {}),
        paths, domains, source: setupSourceLayer(paths, { processes }), processes, dialogue: nodeProcessDialogue({ env }), skillInstaller: agentSkillInstaller({ home, xdgStateHome: env.XDG_STATE_HOME }), agentVersion, ipc: platform !== 'win32', notifications: { platform },
        signal,
        onLifecycle: trace.record,
      });
      return 0;
    }).pipe(Effect.catchCause((cause) => Effect.sync(() => {
      if (input.args.length === 0 && signal.aborted) return 0;
      const error = Cause.squash(cause);
      stderr(`nortuscc agent: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }))), ['--startup', '--prepare-update', '--recover-update'].includes(input.args[0] ?? '') ? { signal } : undefined);
    trace.record('entry', signal.aborted ? 'cancelled' : code === 0 ? 'completed' : 'failed');
    return code;
  } catch (error) {
    trace.record('entry', controller.signal.aborted || input.signal?.aborted ? 'cancelled' : 'failed');
    if (input.args.length === 0 && signal.aborted) return 0;
    stderr(`nortuscc agent: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    clearTimeout(deadline);
    if (['--startup', '--bootstrap', '--prepare-update', '--recover-update', '--mcp-connections'].includes(input.args[0] ?? '') && input.stdin === undefined) process.stdin.destroy();
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}

const readStartupInput = async (stdin: AsyncIterable<string | Uint8Array>) => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.from(chunk); bytes += buffer.length;
    if (bytes > 4096) throw new Error('startup input exceeds 4096 bytes');
    chunks.push(buffer);
  }
  return decodeRecoverUpdate(JSON.parse(Buffer.concat(chunks).toString('utf8')));
};

export const readSetupChoices = async (stdin: AsyncIterable<string | Uint8Array>) => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 4096) throw new Error('setup input exceeds 4096 bytes');
    chunks.push(buffer);
  }
  return decodeSetupChoices(JSON.parse(Buffer.concat(chunks).toString('utf8')));
};

const readConnectionAction = async (stdin: AsyncIterable<string | Uint8Array>) => {
  let text = '';
  for await (const chunk of stdin) {
    text += Buffer.from(chunk).toString('utf8');
    if (Buffer.byteLength(text) > 1024) throw new Error('Connection action exceeds limit');
  }
  return decodeConnectionAction(JSON.parse(text));
};
