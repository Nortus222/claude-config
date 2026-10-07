import { homedir, userInfo } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cause, Effect, Layer } from 'effect';
import { agentLayer, runAgent } from '@nortuscc/agent';
import {
  backupsForRun, configDomain, Fs, integrationsDomain, nodeFs, nodeProcesses, pathsFromEnvironment, skillsDomain,
  type MachinePathsValue, type Processes,
} from '@nortuscc/machine';
import { setupSourceLayer } from '@nortuscc/sync';
import { ensureAgent } from './lifecycle.ts';
import { probeLoginEnvironment } from './login-environment.ts';

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
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
};

// No arguments run the service; fixed helper arguments return exactly one JSON line on success.
export async function runDesktopEntry(input: DesktopEntryInput): Promise<number> {
  const stdout = input.stdout ?? ((text) => { process.stdout.write(text); });
  const stderr = input.stderr ?? ((text) => { process.stderr.write(text); });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    return await Effect.runPromise(Effect.gen(function* () {
      const [arg, appFlag, appPath] = input.args;
      const serviceHelper = arg === '--ensure' || arg === '--restart';
      if (!(input.args.length === 0 || (arg === '--paths' && input.args.length === 1)
        || (serviceHelper && input.args.length === 3 && appFlag === '--app' && appPath !== undefined
          && isAbsolute(appPath) && !/[\x00-\x1f\x7f]/.test(appPath)))) {
        return yield* Effect.fail(new Error('Usage: agent.mjs [--ensure | --restart] --app <absolute executable> | --paths'));
      }
      if (arg === '--paths') {
        // Only the state root is used; this mode needs no checkout or runtime metadata.
        const login = yield* Effect.tryPromise({
          try: () => (input.probe ?? probeLoginEnvironment)({ env: input.env, runtime: process.execPath }), catch: (error) => error,
        });
        if (login.error) stderr(`nortuscc agent: ${login.error}\n`);
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
      const env = login.env;
      const home = env.HOME ?? input.env.HOME ?? homedir();
      const platform = input.platform ?? process.platform;
      const paths = yield* pathsFromEnvironment({ env, home, platform });
      const processes = input.processes ?? nodeProcesses({ env, inherit: 'stderr' });
      if (arg !== undefined) {
        if (platform !== 'darwin' && platform !== 'linux') return yield* Effect.fail(new Error(`desktop agent IPC is not supported on ${platform}`));
        const result = yield* ensureAgent({
          paths, env, shellEnvironment: input.env, resources: input.resources, agentVersion,
          appPath: appPath!,
          target: { platform, home, uid: input.uid ?? process.getuid?.() ?? 0, user: input.user ?? userInfo().username, stateRoot: paths.stateRoot },
        }, { restart: arg === '--restart' }).pipe(
          Effect.provide(backupsForRun().pipe(Layer.provideMerge(agentLayer(paths, { processes })))),
        );
        stdout(JSON.stringify(result) + '\n');
        return 0;
      }
      // Each job's integrations domain reads that job's snapshot and uses the login environment.
      const domains = (jobPaths: MachinePathsValue) => [configDomain, integrationsDomain({ paths: jobPaths, env }), skillsDomain];
      yield* runAgent({
        ...(env.NORTUSCC_HOSTED_URL === undefined ? {} : { hosted: { url: env.NORTUSCC_HOSTED_URL, platform } }),
        paths, domains, source: setupSourceLayer(paths, { processes }), processes, agentVersion, ipc: platform !== 'win32', notifications: { platform },
        signal: input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal,
      });
      return 0;
    }).pipe(Effect.catchCause((cause) => Effect.sync(() => {
      const error = Cause.squash(cause);
      stderr(`nortuscc agent: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }))));
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}

const entry = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === entry) {
  process.exitCode = await runDesktopEntry({ args: process.argv.slice(2), env: process.env, resources: dirname(entry) });
}
