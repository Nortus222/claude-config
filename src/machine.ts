import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Cause, Effect, Layer, Stream } from 'effect';
import {
  loadProfile, nodeFiles, type DesiredConfig, type Input, type MachineOverrides, type ReadFailed, type Target,
} from '@nortuscc/profile-engine';
import {
  backupsForRun, configDomain, execute, integrationsDomain, machinePaths, nodeFs, nodeProcesses, overridesStore,
  OverridesStore, pathsFromEnvironment, skillsDomain, stateStore,
  type Backups, type Domain, type DomainServices, type Fs, type FsFailed, type IntegrationsServices, type LockHeld,
  type MachinePaths, type MachinePathsValue, type MachineReport, type Plan, type Processes, type RepoNotFound,
  type StateStore, type Step,
} from '@nortuscc/machine';
import { resolveConfigMode, type ConfigMode } from './config-mode.ts';

// The checkout this file belongs to: where a machine with no recorded checkout runs from.
export const CHECKOUT = fileURLToPath(new URL('..', import.meta.url));

export type CliServices = MachinePaths | Fs | Processes | StateStore | OverridesStore | Backups;

export type Opened = {
  paths: MachinePathsValue;
  layer: Layer.Layer<CliServices>;
  // As read from overrides.json, issues included; a command that writes overrides refuses an invalid file.
  overrides: Input<MachineOverrides>;
  desired: DesiredConfig;
};

// Builds this machine's paths and services, reads its overrides and loads the desired configuration.
// With `mode`, the profile is loaded with the run's config-mode choice applied. Override issues are
// reported to stderr and the run continues.
export function openMachine(options: { mode?: ConfigMode } = {}): Effect.Effect<Opened, RepoNotFound | ReadFailed | FsFailed> {
  return Effect.gen(function* () {
    const paths = yield* pathsFromEnvironment({
      env: process.env, home: homedir(), platform: process.platform, fallbackRepo: CHECKOUT, warn: (m) => console.error(m),
    });
    const layer: Layer.Layer<CliServices> = Layer.mergeAll(stateStore, overridesStore, backupsForRun())
      .pipe(Layer.provideMerge(Layer.mergeAll(machinePaths(paths), nodeFs, nodeProcesses())));
    const overrides = yield* Effect.gen(function* () {
      return yield* (yield* OverridesStore).read;
    }).pipe(Effect.provide(layer));
    for (const issue of overrides.issues) console.error(`nortuscc: ${issue.source}: ${issue.message}`);
    const value = options.mode ? resolveConfigMode(options.mode, overrides.value).overrides : overrides.value;
    const desired = yield* loadProfile(paths.repo, { overrides: { ...overrides, value } }).pipe(Effect.provide(nodeFiles));
    return { paths, layer, overrides, desired };
  });
}

// Filters desired.integrations to the selected targets, so an unselected agent is never probed.
export function forTargets(desired: DesiredConfig, targets: ReadonlyArray<Target>): DesiredConfig {
  return { ...desired, integrations: desired.integrations.filter((i) => targets.includes(i.declaration.target as Target)) };
}

export function domainsFor(paths: MachinePathsValue): {
  config: typeof configDomain;
  integrations: Domain<IntegrationsServices>;
  skills: typeof skillsDomain;
} {
  return { config: configDomain, integrations: integrationsDomain({ paths, env: process.env }), skills: skillsDomain };
}

export type Ran = {
  results: Array<{ step: Step; outcome: 'ok' | 'failed' | 'cancelled'; note: string }>;
  cancelled: boolean;
  backups?: string;
};

// Executes a plan, returning per-step results and the run's backup folder. `signal` stops the run
// after the current step (or interrupts it, when the step is interruptible).
export function runPlan<const D extends ReadonlyArray<Domain<any>>>(
  plan: Plan,
  report: MachineReport,
  domains: D,
  options: { signal?: AbortSignal; onStarted?: (step: Step) => void } = {},
): Effect.Effect<Ran, LockHeld, DomainServices<D> | MachinePaths | Backups> {
  const ran: Ran = { results: [], cancelled: false };
  return Stream.runForEach(execute(plan, report, domains, { signal: options.signal }), (event) => Effect.sync(() => {
    switch (event.type) {
      case 'started':
        options.onStarted?.(event.step);
        return;
      case 'finished':
        ran.results.push({ step: plan.steps[event.index]!, outcome: event.outcome, note: event.note });
        return;
      case 'cancelled':
        ran.cancelled = true;
        ran.backups = event.backups;
        return;
      case 'done':
        ran.backups = event.backups;
    }
  })).pipe(Effect.as(ran));
}

// A failure's message: its own, else a read failure's path and reason, else its tag.
const messageOf = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'object' && error !== null && 'path' in error && 'reason' in error) {
    return `could not read ${String(error.path)}: ${String(error.reason)}`;
  }
  if (typeof error === 'object' && error !== null && '_tag' in error) return String(error._tag);
  return String(error);
};

// Wraps a command body: SIGINT aborts the signal it is given, and any failure is reported as
// `nortuscc: <message>` with exit code 1 (LockHeld reads "another nortuscc run (pid N) holds <path>").
export async function runCommand(body: (signal: AbortSignal) => Effect.Effect<number, unknown, never>): Promise<number> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel);
  try {
    return await Effect.runPromise(body(controller.signal).pipe(
      Effect.catchCause((cause) => Effect.sync(() => {
        console.error(`nortuscc: ${messageOf(Cause.squash(cause))}`);
        return 1;
      })),
    ));
  } finally {
    process.off('SIGINT', cancel);
  }
}
