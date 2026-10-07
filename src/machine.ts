import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cause, Effect, Layer, Stream, type Scope } from 'effect';
import {
  loadProfile, nodeFiles, type DesiredConfig, type Input, type MachineOverrides, type ReadFailed, type Target,
} from '@nortuscc/profile-engine';
import {
  backupsForRun, configDomain, execute, integrationsDomain, machinePaths, nodeFs, nodeProcesses, overridesStore,
  OverridesStore, pathsFromEnvironment, skillsDomain, stateStore,
  type Backups, type Domain, type DomainServices, type Fs, type FsFailed, type IntegrationsServices, type LaunchFailed, type LockHeld,
  type MachinePaths, type MachinePathsValue, type MachineReport, type Plan, type PluginState, type Processes, type RepoNotFound,
  type StateStore, type Step,
} from '@nortuscc/machine';
import { desiredFor, SyncStore, syncStore, type Holds, type Snapshot, type SyncStateInvalid } from '@nortuscc/sync';
import { resolveConfigMode, type ConfigMode } from './config-mode.ts';

// The checkout this file belongs to: where a machine with no recorded checkout runs from.
export const CHECKOUT = fileURLToPath(new URL('..', import.meta.url));

export type CliServices = MachinePaths | Fs | Processes | StateStore | OverridesStore | Backups;

export type Opened = {
  paths: MachinePathsValue;
  layer: Layer.Layer<CliServices>;
  // As read from overrides.json, issues included; a command that changes anything refuses an invalid file.
  overrides: Input<MachineOverrides>;
  desired: DesiredConfig;
  // The git checkout. paths.repo is a composed directory instead when items are held (openDesired).
  checkout: string;
  // This machine's held items (sync.json); empty from openMachine.
  held: Holds;
};

// This machine's paths from the environment. `warn` hears about a recorded repo that is no longer a checkout.
export function resolvePaths(warn?: (message: string) => void): Effect.Effect<MachinePathsValue, RepoNotFound> {
  return pathsFromEnvironment({ env: process.env, home: homedir(), platform: process.platform, fallbackRepo: CHECKOUT, ...(warn ? { warn } : {}) });
}

// The CLI's services over `paths`.
export function cliLayer(paths: MachinePathsValue): Layer.Layer<CliServices> {
  return Layer.mergeAll(stateStore, overridesStore, backupsForRun())
    .pipe(Layer.provideMerge(Layer.mergeAll(machinePaths(paths), nodeFs, nodeProcesses())));
}

// Prints each overrides issue to stderr as `nortuscc: <source>: <message>`.
export function reportOverrideIssues(overrides: Input<MachineOverrides>): void {
  for (const issue of overrides.issues) console.error(`nortuscc: ${issue.source}: ${issue.message}`);
}

// True, after saying so, when the overrides have issues: a command that changes the machine or the
// repo refuses rather than guess what this machine manages. The issues themselves are printed by
// reportOverrideIssues (openMachine does so).
export function refuseInvalidOverrides(overrides: Input<MachineOverrides>): boolean {
  if (overrides.issues.length === 0) return false;
  console.error(`nortuscc: ${overrides.source} is not valid, so nothing was changed; fix it by hand and re-run.`);
  return true;
}

// Builds this machine's paths (unless given) and services, reads its overrides and loads the desired
// configuration. With `mode`, the profile is loaded with the run's config-mode choice applied.
// Override issues are reported to stderr and the run continues; commands that change anything then
// refuse through refuseInvalidOverrides.
export function openMachine(options: { mode?: ConfigMode; paths?: MachinePathsValue } = {}): Effect.Effect<Opened, RepoNotFound | ReadFailed | FsFailed> {
  return Effect.gen(function* () {
    const paths = options.paths ?? (yield* resolvePaths((m) => console.error(m)));
    const layer = cliLayer(paths);
    const overrides = yield* Effect.gen(function* () {
      return yield* (yield* OverridesStore).read;
    }).pipe(Effect.provide(layer));
    reportOverrideIssues(overrides);
    const value = options.mode ? resolveConfigMode(options.mode, overrides.value).overrides : overrides.value;
    const desired = yield* loadProfile(paths.repo, { overrides: { ...overrides, value } }).pipe(Effect.provide(nodeFiles));
    return { paths, layer, overrides, desired, checkout: paths.repo, held: {} };
  });
}

// This machine's held items (sync.json). An invalid file fails with SyncStateInvalid and is never rewritten.
export function readHolds(layer: Layer.Layer<MachinePaths | Fs>): Effect.Effect<Holds, FsFailed | SyncStateInvalid> {
  return Effect.gen(function* () {
    return yield* (yield* SyncStore).read;
  }).pipe(Effect.provide(syncStore.pipe(Layer.provide(layer))));
}

// The documents at the working tree of `checkout` with `held` patched in, resolved with `overrides`, composed
// into a private temporary directory that the caller's scope removes. Call it only when `held` is non-empty.
// desiredFor removes and recreates `into`, so it is a child of the private (0700) mkdtemp dir:
// recreated in a shared tmp under its own name, another user could plant documents in it.
// The exit hook removes the dir when the process exits before the scope closes.
export function composeHeld(input: { checkout: string; held: Holds; overrides?: Input<MachineOverrides> }):
  Effect.Effect<Snapshot, Error | FsFailed | LaunchFailed | ReadFailed, Fs | Processes | Scope.Scope> {
  const { checkout, held } = input;
  return Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const made = mkdtempSync(join(tmpdir(), 'nortuscc-desired-'));
        const remove = () => rmSync(made, { recursive: true, force: true });
        process.once('exit', remove);
        return { made, remove };
      }),
      ({ remove }) => Effect.sync(() => {
        process.off('exit', remove);
        remove();
      }),
    );
    return yield* desiredFor({
      repo: checkout, head: { kind: 'worktree' }, held, into: join(dir.made, 'repo'),
      ...(input.overrides ? { overrides: input.overrides } : {}),
    }).pipe(
      // A hold whose commit is gone cannot be composed; releasing it is the only way out.
      Effect.catchTag('RevisionUnavailable', (err) => {
        const items = Object.keys(held).filter((id) => held[id] === err.revision).sort();
        const release = items.map((id) => `nortuscc sync --release ${id}`).join('\n  ');
        return Effect.fail(new Error(
          `${items.join(', ')} ${items.length === 1 ? 'is' : 'are'} held at ${err.revision}, which this checkout lacks `
          + `(${err.message}). Take the checkout's value instead with:\n  ${release}`,
        ));
      }),
    );
  });
}

// openMachine with this machine's held items (sync.json) composed over the working tree, for the
// commands that apply or report desired state. With holds, paths.repo is a temporary directory of the
// composed documents, removed when the caller's scope closes, and `checkout` stays the git checkout.
// An invalid sync.json fails with SyncStateInvalid, so the command changes nothing.
export function openDesired(options: { mode?: ConfigMode; paths?: MachinePathsValue } = {}) {
  return Effect.gen(function* () {
    const opened = yield* openMachine(options);
    const held = yield* readHolds(opened.layer);
    if (Object.keys(held).length === 0) return opened;
    const value = options.mode ? resolveConfigMode(options.mode, opened.overrides.value).overrides : opened.overrides.value;
    const snapshot = yield* composeHeld({ checkout: opened.checkout, held, overrides: { ...opened.overrides, value } }).pipe(
      Effect.provide(opened.layer),
    );
    const paths = { ...opened.paths, repo: snapshot.repo };
    const composed: Opened = { ...opened, paths, layer: cliLayer(paths), desired: snapshot.desired, held };
    return composed;
  });
}

// openMachine plus this machine's held items, with paths.repo still the checkout: for commands that
// write into the checkout, which must keep held items out of what they publish.
export function openCheckout(options: { mode?: ConfigMode } = {}) {
  return Effect.gen(function* () {
    const opened = yield* openMachine(options);
    const held = yield* readHolds(opened.layer);
    const withHolds: Opened = { ...opened, held };
    return withHolds;
  });
}

// Filters desired.integrations to the selected targets, so an unselected agent is never probed.
export function forTargets(desired: DesiredConfig, targets: ReadonlyArray<Target>): DesiredConfig {
  return { ...desired, integrations: desired.integrations.filter((i) => targets.includes(i.declaration.target as Target)) };
}

// A Codex state read a caller shares with the integrations domain, so the CLI is asked once.
export type CodexStateRead = Effect.Effect<PluginState, never, Processes>;

export function domainsFor(paths: MachinePathsValue, options: { codexState?: CodexStateRead | undefined } = {}): {
  config: typeof configDomain;
  integrations: Domain<IntegrationsServices>;
  skills: typeof skillsDomain;
} {
  const integrations = integrationsDomain({ paths, env: process.env, ...(options.codexState ? { codexState: options.codexState } : {}) });
  return { config: configDomain, integrations, skills: skillsDomain };
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

// Wraps a command body: the first SIGINT aborts the signal it is given, a second exits the process
// with 130, and any failure is reported as `nortuscc: <message>` with exit code 1 (LockHeld reads
// "another nortuscc run (pid N) holds <path>").
export async function runCommand(body: (signal: AbortSignal) => Effect.Effect<number, unknown, never>): Promise<number> {
  const controller = new AbortController();
  const cancel = () => {
    if (controller.signal.aborted) process.exit(130);
    controller.abort();
  };
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
