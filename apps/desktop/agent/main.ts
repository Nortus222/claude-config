import { homedir, userInfo } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cause, Effect, Layer } from 'effect';
import { agentLayer, runAgent, type HostedOptions } from '@nortuscc/agent';
import {
  backupsForRun, configDomain, Fs, integrationsDomain, nodeFs, nodeProcesses, pathsFromEnvironment, skillsDomain,
  type MachinePathsValue, type Processes,
} from '@nortuscc/machine';
import { setupSourceLayer } from '@nortuscc/sync';
import { maintenanceState, prepareUpdate, recoverUpdate } from './maintenance.ts';
import { ensureAgent } from './lifecycle.ts';
import { probeLoginEnvironment } from './login-environment.ts';
import { bootstrapSetup, decodeSetupChoices, requestGitInstall, setupState } from './onboarding.ts';
import { desktopHostedUrl } from './public-config.ts';

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
export async function runDesktopEntry(input: DesktopEntryInput): Promise<number> {
  const stdout = input.stdout ?? ((text) => { process.stdout.write(text); });
  const stderr = input.stderr ?? ((text) => { process.stderr.write(text); });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  // Starts before probes/input/Git, leaving ten seconds before the native 120-second deadline.
  const deadline = input.args[0] === '--bootstrap' ? setTimeout(stop, input.bootstrapTimeoutMs ?? 110_000) : undefined;
  try {
    return await Effect.runPromise(Effect.gen(function* () {
      const [arg, appFlag, appPath] = input.args;
      const serviceHelper = arg === '--ensure' || arg === '--restart' || arg === '--bootstrap' || arg === '--prepare-update' || arg === '--recover-update' || arg === '--maintenance-state';
      if (!(input.args.length === 0 || (['--paths', '--setup-state', '--install-git'].includes(arg ?? '') && input.args.length === 1)
        || (serviceHelper && input.args.length === 3 && appFlag === '--app' && appPath !== undefined
          && isAbsolute(appPath) && !/[\x00-\x1f\x7f]/.test(appPath)))) {
        return yield* Effect.fail(new Error('Usage: agent.mjs [--ensure | --restart | --bootstrap | --prepare-update | --recover-update | --maintenance-state] --app <absolute executable> | --paths | --setup-state | --install-git'));
      }
      if (arg === '--paths' || arg === '--setup-state' || arg === '--install-git' || arg === '--bootstrap') {
        // First-run helpers need no existing checkout or bundled runtime metadata.
        const login = yield* Effect.tryPromise({
          try: () => (input.probe ?? probeLoginEnvironment)({ env: input.env, runtime: process.execPath }), catch: (error) => error,
        });
        if (login.error) stderr(`nortuscc agent: ${login.error}\n`);
        const helperInput = { env: login.env, home: login.env.HOME ?? input.env.HOME ?? homedir(), platform: input.platform ?? process.platform, processes: input.processes, signal: input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal };
        helperInput.signal.throwIfAborted();
        if (arg === '--setup-state') {
          stdout(JSON.stringify(yield* Effect.tryPromise({ try: () => setupState(helperInput), catch: (error) => error })) + '\n');
          return 0;
        }
        if (arg === '--install-git') {
          yield* Effect.tryPromise({ try: () => requestGitInstall(helperInput), catch: (error) => error });
          stdout(JSON.stringify({ requested: true }) + '\n');
          return 0;
        }
        if (arg === '--bootstrap') {
          const choices = yield* Effect.tryPromise({ try: () => readSetupChoices(input.stdin ?? process.stdin), catch: (error) => error }).pipe(Effect.timeout(5000));
          helperInput.signal.throwIfAborted();
          const result = yield* Effect.tryPromise({ try: () => bootstrapSetup(helperInput, choices), catch: (error) => error });
          stdout(JSON.stringify(result) + '\n');
          return 0;
        }
        const paths = yield* pathsFromEnvironment({ env: login.env, home: login.env.HOME ?? input.env.HOME ?? homedir(),
          platform: input.platform ?? process.platform, fallbackRepo: input.env.HOME ?? homedir() });
        stdout(JSON.stringify({ stateRoot: paths.stateRoot }) + '\n');
        return 0;
      }
      const metadata = yield* Fs.use((fs) => fs.readText(resolve(input.resources, 'runtime.json'))).pipe(Effect.provide(nodeFs));
      const agentVersion = yield* Effect.try({
        try: () => {
          const parsed: unknown = JSON.parse(metadata ?? 'null');
          if (typeof parsed !== 'object' || parsed === null || !('agentVersion' in parsed)
            || typeof parsed.agentVersion !== 'string' || parsed.agentVersion.trim() === '') throw new Error('runtime.json has no agentVersion');
          return parsed.agentVersion;
        }, catch: (error) => error,
      });
      const login = yield* Effect.tryPromise({
        try: () => (input.probe ?? probeLoginEnvironment)({ env: input.env, runtime: process.execPath }), catch: (error) => error,
      });
      if (login.error) stderr(`nortuscc agent: ${login.error}\n`);
      const env: Readonly<Record<string, string | undefined>> = { ...login.env, ...(input.env.NORTUSCC_DESKTOP_LOCAL_ONLY === undefined ? {} : { NORTUSCC_DESKTOP_LOCAL_ONLY: input.env.NORTUSCC_DESKTOP_LOCAL_ONLY }) };
      const hostedUrl = desktopHostedUrl(env);
      const home = env.HOME ?? input.env.HOME ?? homedir();
      const platform = input.platform ?? process.platform;
      const paths = yield* pathsFromEnvironment({ env, home, platform, ...(arg === '--maintenance-state' ? { fallbackRepo: home } : {}) });
      const processes = input.processes ?? nodeProcesses({ env, inherit: 'stderr' });
      if (arg !== undefined) {
        if (platform !== 'darwin' && platform !== 'linux') return yield* Effect.fail(new Error(`desktop agent IPC is not supported on ${platform}`));
        const lifecycleInput = {
          paths, env, shellEnvironment: input.env, resources: input.resources, agentVersion,
          appPath: appPath!,
          target: { platform, home, uid: input.uid ?? process.getuid?.() ?? 0, user: input.user ?? userInfo().username, stateRoot: paths.stateRoot },
        };
        const operation = Effect.gen(function* () {
          if (arg === '--maintenance-state') return yield* maintenanceState(lifecycleInput);
          if (arg === '--prepare-update') return yield* prepareUpdate(lifecycleInput, { stdin: input.stdin ?? process.stdin, stdout: value => stdout(JSON.stringify(value) + '\n') });
          if (arg === '--recover-update') return yield* recoverUpdate(lifecycleInput, { stdin: input.stdin ?? process.stdin, installerAlive: pid => {
            try { process.kill(pid, 0); return true; }
            catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
          } });
          return yield* ensureAgent(lifecycleInput, { restart: arg === '--restart' });
        });
        const result = yield* operation.pipe(
          Effect.provide(backupsForRun().pipe(Layer.provideMerge(agentLayer(paths, { processes })))),
        );
        stdout(JSON.stringify(result) + '\n');
        return 0;
      }
      // Each job's integrations domain reads that job's snapshot and uses the login environment.
      const domains = (jobPaths: MachinePathsValue) => [configDomain, integrationsDomain({ paths: jobPaths, env }), skillsDomain];
      yield* runAgent({
        ...(hostedUrl === undefined ? {} : { hosted: { url: hostedUrl, platform, ...input.hostedDependencies } }),
        paths, domains, source: setupSourceLayer(paths, { processes }), processes, agentVersion, ipc: platform !== 'win32', notifications: { platform },
        signal: input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal,
      });
      return 0;
    }).pipe(Effect.catchCause((cause) => Effect.sync(() => {
      const error = Cause.squash(cause);
      stderr(`nortuscc agent: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }))), ['--prepare-update', '--recover-update'].includes(input.args[0] ?? '') ? { signal: input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal } : undefined);
  } catch (error) {
    stderr(`nortuscc agent: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    clearTimeout(deadline);
    if (['--bootstrap', '--prepare-update', '--recover-update'].includes(input.args[0] ?? '') && input.stdin === undefined) process.stdin.destroy();
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}

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

const entry = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === entry) {
  process.exitCode = await runDesktopEntry({ args: process.argv.slice(2), env: process.env, resources: dirname(entry) });
}
