import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Cause, Effect, Exit, Layer, Scope, Stream } from 'effect';
import { loadProfile, nodeFiles } from '@nortuscc/profile-engine';
import {
  Backups, Fs, LockHeld, MachinePaths, OverridesStore, Processes, RepoNotFound, StateStore,
  acquireApplyLock, backupsForRun, execute, inspect, machinePaths, nodeFs, nodeProcesses, overridesStore, pathsFromEnvironment, plan,
  samePlan, selectAll, stateStore,
  type Domain, type MachinePathsValue, type MachineReport, type PathsEnvironment, type Plan, type Progress,
} from '@nortuscc/machine';
import { DEFAULT_TOOLS, missingTools, type LoginPath } from './login-path.ts';
import type { ApplyResult, ErrorCode, InspectResult, PreviewResult, RunProgress, WireObserved, WirePlan } from './protocol.ts';

export type DesktopServices = MachinePaths | Fs | Processes | StateStore | OverridesStore | Backups;

// A refusal the renderer can act on; `code` travels as the protocol's error code.
export class SessionError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type SessionOptions = {
  readonly environment: Pick<PathsEnvironment, 'env' | 'home' | 'platform'>;
  readonly loginPath: LoginPath;
  readonly domains: ReadonlyArray<Domain<DesktopServices>>;
  readonly tools?: ReadonlyArray<string>;
};

export type Prepared = {
  readonly result: ApplyResult;
  // Present when the run was accepted. Call it after replying, so the reply precedes every event.
  // Contract: once a `started` result is replied, `start` must be called, or the session stays busy.
  readonly start?: (emit: (runId: string, progress: RunProgress) => void) => void;
};

type Inspection = { readonly paths: MachinePathsValue; readonly report: MachineReport; readonly result: InspectResult };
type Previewed = { readonly planId: string; readonly exclude: ReadonlyArray<string>; readonly plan: Plan };

const describe = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'object' && error !== null && '_tag' in error && typeof error._tag === 'string') return error._tag;
  return String(error);
};

const settle = async <A>(effect: Effect.Effect<A, unknown>): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
};

// Every service a domain may need, built for one machine; a fresh Backups folder per call.
const services = (paths: MachinePathsValue, path: string) =>
  Layer.mergeAll(stateStore, overridesStore, backupsForRun()).pipe(
    Layer.provideMerge(Layer.mergeAll(machinePaths(paths), nodeFs, nodeProcesses({ path }))),
  );

const wireItem = (item: MachineReport['items'][number]): WireObserved => ({
  key: item.key, domain: item.domain, ...(item.target === undefined ? {} : { target: item.target }), label: item.label, group: item.group, state: item.state,
  disposition: item.disposition,
  ...(item.note === undefined ? {} : { note: item.note }),
  ...(item.from === undefined ? {} : { from: { layer: item.from.layer, source: item.from.source } }),
});

const wireStep = (step: Plan['steps'][number]) => ({
  key: step.key, domain: step.domain, action: step.action, summary: step.summary, touches: [...step.touches], interruptible: step.interruptible,
  ...(step.targets === undefined ? {} : { targets: [...step.targets] }),
});

const wirePlan = (p: Plan): WirePlan => ({
  kind: p.kind, steps: p.steps.map(wireStep), skipped: p.skipped.map((s) => ({ key: s.key, reason: s.reason })),
});

const wireProgress = (progress: Progress): RunProgress =>
  progress.type === 'started' ? { ...progress, step: wireStep(progress.step) } : progress;

// Takes apply.lock for this machine and returns its release. A live holder is a LOCKED refusal.
const lockMachine = async (paths: MachinePathsValue): Promise<() => Promise<void>> => {
  const scope = await Effect.runPromise(Scope.make());
  const release = () => Effect.runPromise(Scope.close(scope, Exit.void));
  const exit = await Effect.runPromiseExit(acquireApplyLock.pipe(Scope.provide(scope), Effect.provide(machinePaths(paths))));
  if (Exit.isSuccess(exit)) return release;
  await release();
  const err = Cause.squash(exit.cause);
  if (err instanceof LockHeld) throw new SessionError('LOCKED', `${err.message}; apply again when it finishes`);
  throw new SessionError('INTERNAL', describe(err));
};

// The backend's one machine: the last inspection, the last preview, and at most one run.
export class Session {
  private inspection?: Inspection;
  private previewed?: Previewed;
  private active?: { readonly abort: AbortController; readonly done: Promise<void> };

  private readonly options: SessionOptions;

  constructor(options: SessionOptions) {
    this.options = options;
  }

  get running(): boolean {
    return this.active !== undefined;
  }

  async inspect(): Promise<InspectResult> {
    this.idle();
    const inspection = await this.observe(await this.resolvePaths());
    this.inspection = inspection;
    this.previewed = undefined;
    return inspection.result;
  }

  preview(exclude: ReadonlyArray<string>): PreviewResult {
    this.idle();
    const inspection = this.inspection;
    if (!inspection) throw new SessionError('NO_REPORT', 'Inspect the machine before previewing');
    this.valid(inspection);
    const keys = new Set(inspection.report.items.map((item) => item.key));
    const unknown = exclude.find((key) => !keys.has(key));
    if (unknown !== undefined) throw new SessionError('UNKNOWN_KEY', `'${unknown}' is not an item of the last inspection; inspect again`);
    const unique = [...new Set(exclude)];
    this.previewed = { planId: randomUUID(), exclude: unique, plan: this.plan(inspection, unique) };
    return { planId: this.previewed.planId, plan: wirePlan(this.previewed.plan) };
  }

  async apply(planId: string): Promise<Prepared> {
    this.idle();
    const previewed = this.previewed;
    if (!previewed || previewed.planId !== planId) throw new SessionError('UNKNOWN_PLAN', 'That preview is no longer current; preview again');
    const abort = new AbortController();
    let finish!: () => void;
    this.active = { abort, done: new Promise<void>((resolve) => { finish = resolve; }) };
    const release = () => {
      if (this.active?.abort === abort) this.active = undefined;
      finish();
    };
    let unlock: (() => Promise<void>) | undefined;
    try {
      const paths = await this.resolvePaths();
      unlock = await lockMachine(paths);
      const inspection = await this.observe(paths);
      this.inspection = inspection;
      this.valid(inspection);
      const fresh = this.plan(inspection, previewed.exclude);
      if (!samePlan(previewed.plan, fresh)) {
        this.previewed = { planId: randomUUID(), exclude: previewed.exclude, plan: fresh };
        await unlock();
        release();
        return { result: { status: 'stale', planId: this.previewed.planId, plan: wirePlan(fresh) } };
      }
      this.previewed = undefined;
      const runId = randomUUID();
      const held = unlock;
      return {
        result: { status: 'started', runId },
        start: (emit) => {
          void this.execute(inspection, fresh, abort.signal, (progress) => emit(runId, progress), async () => {
            await held();
            release();
          });
        },
      };
    } catch (err) {
      await unlock?.();
      release();
      throw err;
    }
  }

  async cancel(): Promise<boolean> {
    const active = this.active;
    if (!active) return false;
    active.abort.abort();
    await active.done;
    return true;
  }

  private idle() {
    if (this.active) throw new SessionError('BUSY', 'An apply is running');
  }

  private valid(inspection: Inspection) {
    const issues = inspection.report.desired.issues;
    if (issues.length) {
      const first = issues[0]!;
      throw new SessionError('PROFILE_INVALID', `The profile has ${issues.length} issue(s); first: ${first.source}: ${first.path} — ${first.message}`);
    }
  }

  private plan(inspection: Inspection, exclude: ReadonlyArray<string>): Plan {
    return plan('apply', inspection.report, { ...selectAll, exclude }, this.options.domains);
  }

  private async resolvePaths(): Promise<MachinePathsValue> {
    return settle(pathsFromEnvironment(this.options.environment)).catch((err: unknown) => {
      if (err instanceof RepoNotFound) {
        throw new SessionError('REPO_NOT_FOUND', `${err.message}. Run 'nortuscc setup --dir <checkout>' in a terminal, then inspect again.`);
      }
      throw new SessionError('INSPECT_FAILED', describe(err));
    });
  }

  private async observe(paths: MachinePathsValue): Promise<Inspection> {
    const { domains, loginPath } = this.options;
    const observed = await settle(
      Effect.gen(function* () {
        const overrides = yield* (yield* OverridesStore).read;
        const desired = yield* Effect.provide(loadProfile(paths.repo, { overrides }), nodeFiles);
        const report = yield* inspect(desired, domains);
        const head = yield* Effect.exit((yield* Processes).run({ cmd: 'git', args: ['-C', paths.repo, 'rev-parse', 'HEAD'], output: 'capture' }));
        const revision = Exit.isSuccess(head) && head.value.code === 0 ? head.value.stdout.trim() || null : null;
        return { report, revision };
      }).pipe(Effect.provide(services(paths, loginPath.path))),
    ).catch((err: unknown) => {
      throw new SessionError('INSPECT_FAILED', describe(err));
    });
    const { report, revision } = observed;
    return {
      paths,
      report,
      result: {
        profile: {
          repo: paths.repo,
          revision,
          overrides: join(paths.stateRoot, 'overrides.json'),
          issues: report.desired.issues.map((i) => ({ layer: i.layer, source: i.source, path: i.path, message: i.message })),
        },
        items: report.items.map(wireItem),
        probeErrors: [
          ...(loginPath.error ? [loginPath.error] : []),
          ...missingTools(this.options.tools ?? DEFAULT_TOOLS, loginPath.path),
          ...report.probeErrors,
        ],
      },
    };
  }

  // Runs to completion. The terminal event is held back until the lock is released and busy is
  // cleared, so whoever sees it (or awaits cancel) finds the machine free.
  private async execute(inspection: Inspection, p: Plan, signal: AbortSignal, emit: (progress: RunProgress) => void, release: () => Promise<void>) {
    let terminal: RunProgress | undefined;
    try {
      const exit = await Effect.runPromiseExit(
        execute(p, inspection.report, this.options.domains, { signal, lockHeld: true }).pipe(
          Stream.runForEach((progress) =>
            Effect.sync(() => {
              const wire = wireProgress(progress);
              if (wire.type === 'done' || wire.type === 'cancelled') terminal = wire;
              else emit(wire);
            })),
          Effect.provide(services(inspection.paths, this.options.loginPath.path)),
        ),
      );
      if (Exit.isFailure(exit)) terminal = { type: 'failed', message: describe(Cause.squash(exit.cause)) };
    } finally {
      await release();
    }
    if (terminal) emit(terminal);
  }
}
