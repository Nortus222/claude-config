import type { Effect } from 'effect';
import { TARGETS, type DesiredConfig, type Origin, type Target } from '@nortuscc/profile-engine';

export type DomainName = 'config' | 'integrations' | 'skills';
// The one cross-domain verdict: status, pickers and the app read it, and exit codes derive from it.
export type Disposition = 'in-sync' | 'apply' | 'capture' | 'blocked' | 'excluded' | 'undeclared';

export type Observed = {
  readonly key: string;
  readonly domain: DomainName;
  readonly target: Target;
  readonly label: string;
  readonly group: string;
  readonly state: string;
  readonly disposition: Disposition;
  readonly note?: string;
  // Facts only the owning domain's `steps` reads (for config: "recorded", "local-absent"). Deterministic, like `state`.
  readonly facts?: ReadonlyArray<string>;
  readonly from?: Origin;
};

export type MachineReport = {
  readonly desired: DesiredConfig;
  readonly items: ReadonlyArray<Observed>;
  readonly probeErrors: ReadonlyArray<string>;
};

export type InstallCategory = 'hooks' | 'mcp' | 'plugins' | 'skills';

// Run-time choices the engine deliberately does not resolve.
export type Selection = {
  readonly targets: ReadonlyArray<Target>;
  readonly declined: ReadonlyArray<InstallCategory>;
  readonly only?: ReadonlyArray<string>;
  readonly exclude: ReadonlyArray<string>;
  readonly force: boolean;
};

export const selectAll: Selection = { targets: TARGETS, declined: [], exclude: [], force: false };

export type PlanKind = 'apply' | 'uninstall' | 'capture';
export type StepAction =
  | 'write-file' | 'merge-keys' | 'restore' | 'remove' | 'capture-file' | 'write-manifest' | 'install-integration' | 'install-skills';

export type Step = {
  readonly key: string;
  readonly domain: DomainName;
  readonly action: StepAction;
  readonly summary: string;
  readonly touches: ReadonlyArray<string>;
  // false: a unit that always completes once started (file writes); true: cancellable (installers).
  readonly interruptible: boolean;
};

export type Skipped = { readonly key: string; readonly reason: string };
// `steps` and `skipped` must be deterministic for the same report and selection (no timestamps or
// random ids in a summary or reason): `samePlan` compares a preview against a fresh plan to detect staleness.
export type Plan = { readonly kind: PlanKind; readonly steps: ReadonlyArray<Step>; readonly skipped: ReadonlyArray<Skipped> };
export type StepResult = { readonly ok: boolean; readonly note?: string };

export type Progress =
  | { readonly type: 'started'; readonly index: number; readonly total: number; readonly step: Step }
  | {
    readonly type: 'finished'; readonly index: number; readonly total: number; readonly key: string;
    readonly outcome: 'ok' | 'failed' | 'cancelled'; readonly note: string;
  }
  | { readonly type: 'done'; readonly ok: number; readonly failed: number; readonly backups?: string }
  | { readonly type: 'cancelled'; readonly remaining: ReadonlyArray<string>; readonly backups?: string };

// One area of a machine: how to observe it, which steps reconcile it, and how to run one.
export type Domain<R = never> = {
  readonly name: DomainName;
  readonly inspect: (desired: DesiredConfig) => Effect.Effect<{ items: ReadonlyArray<Observed>; probeErrors: ReadonlyArray<string> }, never, R>;
  // `desired` is the report's: a step may need a declaration the observed item does not carry.
  readonly steps: (items: ReadonlyArray<Observed>, selection: Selection, kind: PlanKind, desired: DesiredConfig) =>
    { steps: ReadonlyArray<Step>; skipped: ReadonlyArray<Skipped> };
  // A step must not interrupt itself: self-interruption reads as cancellation and ends the run.
  // `report` is the one the plan was made from, so a step can read the observed item and `report.desired`.
  readonly run: (step: Step, report: MachineReport) => Effect.Effect<StepResult, unknown, R>;
};
