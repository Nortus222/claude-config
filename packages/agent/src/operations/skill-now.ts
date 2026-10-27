import { createHash, randomUUID } from 'node:crypto';
import { Effect, Layer } from 'effect';
import { backupsForRun, canonical, inspect, machinePaths, OverridesStore, peekMachineState, plan, selectAll, StateStore, type Observed } from '@nortuscc/machine';
import { normalizeSkillSource, TARGETS, type DesiredConfig, type Target } from '@nortuscc/profile-engine';
import { AgentClock } from '../clock.ts';
import { configuredTargets } from '../configured-targets.ts';
import { SessionError } from '../ipc/session.ts';
import type { RunLifecycle } from '../runs.ts';
import type { JobInspection } from '../job.ts';
import type { AgentDomains, AgentServices } from '../layer.ts';
import type { SkillOperations } from '../skill-operations.ts';
import { decodeOperationOutput, type ChangePreview, type MachineIntentChange, type ParityAcceptance, type ReconcileChange, type SkillNowChange } from './index.ts';
import type { PreparedParityChange } from './parity.ts';

// A run's failure cause for a copy the app cannot prove it installed; the desktop words it from this prefix.
export const OUTSIDE_APP = 'Installed outside the app; remove it on that machine';

type Route = 'enable' | 'add' | 'disable' | 'noop';
// An addition is retained by the skill owner; every other route is a prepared change for the session to retain.
export type PreparedSkillNow =
  | { readonly kind: 'retained'; readonly preview: ChangePreview }
  | { readonly kind: 'prepared'; readonly prepared: PreparedParityChange };

const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const refused = (code: SessionError['code'], message: string) => new SessionError(code, message);

// Routes one skill's install or remove to the existing owners so the saved choice and its effect are one run:
// enable/disable save the machine intent then reconcile `skill:<name>`; add uses the verified addition plan.
export const makeSkillNow = (deps: {
  readonly inspection: Effect.Effect<JobInspection | undefined>;
  readonly generation: Effect.Effect<number>;
  readonly freshInspection: Effect.Effect<JobInspection | undefined, unknown>;
  readonly domains: AgentDomains;
  readonly skills: Pick<SkillOperations, 'resolveSkillCandidate' | 'previewAddSkill'>;
  readonly prepareIntent: (change: MachineIntentChange) => Effect.Effect<PreparedParityChange & { readonly after: DesiredConfig }, SessionError>;
  readonly prepareReconcile: (change: ReconcileChange, inspection: JobInspection) => Effect.Effect<PreparedParityChange, SessionError>;
}) => Effect.gen(function* () {
  const context = yield* Effect.context<AgentServices>();
  const clock = yield* AgentClock;
  const overrides = yield* OverridesStore;
  const stateStore = yield* StateStore;
  const skillError = (e: { readonly code: SessionError['code']; readonly message: string }) => refused(e.code, e.message);

  const prepare = (change: SkillNowChange): Effect.Effect<PreparedSkillNow, SessionError> => Effect.gen(function* () {
    const inspection = yield* deps.inspection;
    if (!inspection) return yield* Effect.fail(refused('NO_REPORT', 'Inspect the machine before previewing'));
    const { name, source, action } = change;
    const key = `skill:${name}`;
    const declared = inspection.desired.skills.filter(s => s.name === name);
    const other = declared.find(s => normalizeSkillSource(s.source) !== source);
    if (other) return yield* Effect.fail(refused('INVALID_REQUEST', `A different ${name} skill, from ${other.source}, is already set up on this machine`));
    const skill = declared[0];
    const item = inspection.report.items.find(i => i.key === key);
    const current = yield* overrides.read;
    const targets = change.targets ?? configuredTargets(current, true);
    const observed = (i: JobInspection) => ({ skills: i.desired.skills.filter(s => s.name === name), item: i.report.items.find(row => row.key === key) ?? null });

    const preview = (route: Route, generation: string, steps: readonly unknown[], effects: readonly string[]) => Effect.try({
      try: () => decodeOperationOutput('previewChange', { planId: randomUUID(), scope: { kind: 'machine' }, generation, change, plan: { kind: 'operation', steps, skipped: [] }, nextActions: [], skillNow: { route, effects } }),
      catch: () => refused('OVERSIZED', 'Skill preview exceeds the supported limits'),
    });
    // A route with no steps: nothing changes, or the run fails with `failure` before changing anything.
    const settled = (route: Route, effects: readonly string[], failure?: string) => Effect.gen(function* () {
      const p = yield* preview(route, String(yield* deps.generation), [], effects);
      const acceptance: ParityAcceptance = { kind: 'skillNow', generation: p.generation, baselineDigest: digest(observed(inspection)), planDigest: digest(p.plan), plannedKeys: [] };
      const revalidate = Effect.gen(function* () {
        const fresh = yield* deps.freshInspection;
        if (!fresh || canonical(observed(fresh)) !== canonical(observed(inspection))) return yield* Effect.fail(refused('UNKNOWN_PLAN', `${name} changed on this machine; preview again`));
      }).pipe(Effect.mapError(e => e instanceof SessionError ? e : refused('UNKNOWN_PLAN', `${name} changed on this machine; preview again`)));
      const prepared: PreparedParityChange = { preview: p, acceptance, revalidate,
        execute: () => failure === undefined ? Effect.void : Effect.fail(refused('INVALID_REQUEST', failure)) };
      return { kind: 'prepared' as const, prepared };
    });
    const outside = (reason?: string) => settled('disable', [OUTSIDE_APP], reason ? `${OUTSIDE_APP} (${reason})` : OUTSIDE_APP);

    // Save the explicit choice, then reconcile only this skill against the configuration that choice resolves to.
    const choose = (route: 'enable' | 'disable', selected: readonly Target[]) => Effect.gen(function* () {
      const intent = yield* deps.prepareIntent({ kind: 'machineIntent', patch: { kind: 'skill', source, name, action: route } });
      const built = deps.domains(inspection.paths);
      const report = yield* inspect(intent.after, built).pipe(
        Effect.provideService(StateStore, { ...stateStore, read: peekMachineState }),
        Effect.provide(backupsForRun(yield* clock.now).pipe(Layer.provideMerge(machinePaths(inspection.paths)))),
        Effect.provideContext(context));
      const after: Observed | undefined = report.items.find(i => i.key === key);
      if (route === 'disable' && after?.disposition === 'blocked')
        return yield* after.state === 'disabled' ? outside(after.note) : Effect.fail(refused('INSPECT_FAILED', `Couldn't check ${name} on this machine: ${after.note ?? 'unknown'}`));
      const only = after ? [key] : [];
      const reconcile = only.length ? plan('apply', report, { ...selectAll, only, targets: selected }, built).steps : [];
      const reconcileKeys = reconcile.map(step => step.key);
      const steps = [...intent.preview.plan.steps, ...reconcile.map(step => ({ key: step.key, domain: step.domain, action: step.action, summary: step.summary,
        touches: [...step.touches], interruptible: step.interruptible, ...(step.targets ? { targets: [...step.targets] } : {}) }))];
      const p = yield* preview(route, intent.preview.generation, steps, [`Saves ${name} as ${route === 'enable' ? 'on' : 'off'} for this machine`,
        reconcileKeys.length === 0 ? 'Nothing is installed or removed now'
          : route === 'enable' ? `Installs ${name} from ${source} now, including any bundled scripts, without asking` : 'Removes the copy the app installed; a backup is kept']);
      const planned = p.plan.steps.map(step => step.key);
      const acceptance: ParityAcceptance = { kind: 'skillNow', generation: p.generation, baselineDigest: intent.acceptance.baselineDigest, planDigest: digest(p.plan), plannedKeys: planned };
      const changed = () => refused('UNKNOWN_PLAN', `${name} changed after its choice was saved; check for new changes and try again`);
      const execute = (lifecycle: RunLifecycle, signal: AbortSignal) => Effect.gen(function* () {
        let committed: string[] = [];
        let backupIds: string[] = [];
        // Each owner reports its own steps; the run sees one plan, one step order and one evidence record.
        const phase = (offset: number): RunLifecycle => ({ ...lifecycle,
          progress: event => lifecycle.progress(event.type === 'started' ? { ...event, index: event.index + offset, total: planned.length }
            : event.type === 'finished' ? { ...event, index: event.index + offset, total: planned.length } : event),
          parity: update => {
            committed = [...new Set([...committed, ...update.committedKeys])];
            backupIds = [...new Set([...backupIds, ...update.backupIds])];
            return lifecycle.parity({ kind: 'skillNow', state: update.state === 'committed' ? 'partial' : update.state, committedKeys: committed,
              remainingKeys: planned.filter(k => !committed.includes(k)), backupIds });
          },
        });
        yield* intent.execute(phase(0), signal);
        if (signal.aborted || reconcileKeys.length === 0) return;
        const fresh = yield* deps.freshInspection.pipe(Effect.mapError(changed));
        if (!fresh) return yield* Effect.fail(changed());
        const reconciled = yield* deps.prepareReconcile({ kind: 'reconcile', only, targets: [...selected] }, fresh);
        if (canonical(reconciled.acceptance.plannedKeys) !== canonical(reconcileKeys)) return yield* Effect.fail(changed());
        yield* reconciled.execute(phase(intent.acceptance.plannedKeys.length), signal);
      });
      const prepared: PreparedParityChange = { preview: p, acceptance, revalidate: intent.revalidate, execute, afterRelease: 'inspect' };
      return { kind: 'prepared' as const, prepared };
    });

    if (action === 'install') {
      if (targets.length === 0) return yield* Effect.fail(refused('TARGET_UNAVAILABLE', 'This machine has no agent targets set up; set them up in the app first'));
      // Already installed counts only when every requested target is one the skill is already set up for.
      const covered = targets.every(t => (skill?.targets ?? TARGETS).includes(t));
      if (skill?.install && covered && item?.state === 'ok' && item.disposition === 'in-sync') return yield* settled('noop', [`${name} is already installed on this machine`]);
      if (skill && skill.targets === undefined) return yield* choose('enable', targets);
      const found = yield* deps.skills.resolveSkillCandidate({ scope: { kind: 'machine' }, source, name }).pipe(Effect.mapError(skillError));
      if (found.status === 'unavailable' || found.status === 'limited')
        return yield* Effect.fail(refused('INSPECT_FAILED', `Couldn't read ${source}${found.failures[0] ? ` (${found.failures[0].reason})` : ''}; try again`));
      const candidates = found.candidates.filter(c => c.installedName === name && c.source === source);
      if (candidates.length !== 1) return yield* Effect.fail(candidates.length
        ? refused('INVALID_REQUEST', `${source} has more than one skill named ${name}`) : refused('UNKNOWN_KEY', `${source} has no skill named ${name}`));
      const candidate = candidates[0]!;
      if (change.revision !== undefined && candidate.revision !== change.revision)
        return yield* Effect.fail(refused('UNKNOWN_PLAN', `${source} is at a different revision than requested; check for new changes and try again`));
      const addition = yield* deps.skills.previewAddSkill({ scope: { kind: 'machine' }, candidateId: candidate.candidateId, targets }).pipe(Effect.mapError(skillError));
      const p = yield* Effect.try({ try: () => decodeOperationOutput('previewChange', { ...addition, change, skillNow: { route: 'add',
        effects: [`Adds ${name} from ${source} to this machine`, 'Installs and verifies it now, including any bundled scripts, without asking'] } }),
      catch: () => refused('OVERSIZED', 'Skill preview exceeds the supported limits') });
      return { kind: 'retained' as const, preview: p };
    }
    if (!skill) return yield* item ? outside() : settled('noop', [`${name} is not installed on this machine`]);
    if (!skill.install && item?.state === 'missing') return yield* settled('noop', [`${name} is not installed on this machine`]);
    return yield* choose('disable', targets.length ? targets : TARGETS);
  }).pipe(Effect.mapError(e => e instanceof SessionError ? e : refused('INSPECT_FAILED', 'Skill preview could not read configuration')));
  return { prepare };
});
