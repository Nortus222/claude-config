import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { additionRunPlan } from './skill-addition.ts';
import { Cause, Effect, Exit, Fiber, Layer } from 'effect';
import {
  acceptedSkillLockMatches, additionLockEntry, verifyInstalledSkillTree, type TreeEntry, canonical, FileIntegrity, Fs, MachinePaths, machinePaths, OverridesStore, overridesPath, Processes, readSkillCandidates,
  sourceOf, skillLockPath, agentSkillsDirs, inspectSkills, type Plan, type SkillCandidate,
} from '@nortuscc/machine';
import {
  normalizeSkillSource, ProfileFiles, ReadFailed, TARGETS,
  type DesiredConfig, type Input, type MachineOverrides, type SkillAddition,
} from '@nortuscc/profile-engine';
import { AgentClock } from './clock.ts';
import { resolveInspection, type JobInspection } from './job.ts';
import { decodeOperationInput, decodeOperationOutput, type ChangePreview, type OperationInput, type OperationScope, type SkillCandidateResult } from './operations/index.ts';
import type { ErrorCode } from './ipc/protocol.ts';

export const SKILL_OPERATION_LIMITS = Object.freeze({ sources: 8, sourceTimeoutMs: 15_000, candidateLifetimeMs: 600_000,
  retainedCandidates: 32, concurrentLookups: 2, resultBytes: 32_768, deadlineMs: 20_000 } as const);

export class SkillOperationError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) { super(message); this.code = code; }
}
const refuse = (code: ErrorCode, message: string) => Effect.fail(new SkillOperationError(code, message));
const identity = (c: SkillCandidate) => canonical({ source: c.source, revision: c.revision, sourceDir: c.sourceDir,
  selectorName: c.selectorName, installedName: c.installedName, blob: c.blob, tree: c.tree });
type Retained = { readonly candidate: SkillCandidate; readonly expires: number };
export type AcceptedSkillPlan = {
  readonly preview: ChangePreview; readonly candidate: SkillCandidate; readonly desired: DesiredConfig;
  readonly overrides: Input<MachineOverrides>; readonly priorOverrides: Input<MachineOverrides>; readonly baseline: DesiredConfig; readonly plan: Plan;
  readonly generation: number; readonly expires: number;
};

// Ephemeral agent-owned evidence. No caller path or mutable source lookup becomes installation intent.
export const makeSkillOperations = (options: {
  readonly inspection: Effect.Effect<JobInspection | undefined>;
  readonly generation: Effect.Effect<number>;
  readonly readCandidates?: typeof readSkillCandidates;
}) => Effect.gen(function* () {
  const context = yield* Effect.context<FileIntegrity | Fs | Processes | MachinePaths | OverridesStore | AgentClock>();
  const clock = yield* AgentClock;
  const fs = yield* Fs;
  const store = yield* OverridesStore;
  const lockRead = Effect.gen(function* () {
    const text = yield* fs.readText(skillLockPath(yield* MachinePaths));
    if (text === undefined) return { skills: {} as Record<string, unknown> };
    const value: unknown = yield* Effect.try({ try: () => JSON.parse(text), catch: () => new SkillOperationError('INSPECT_FAILED', 'Installed source inventory is invalid; repair the skill lock before discovery') });
    if (typeof value !== 'object' || value === null || Array.isArray(value) || !('skills' in value)
      || typeof value.skills !== 'object' || value.skills === null || Array.isArray(value.skills)) return yield* refuse('INSPECT_FAILED', 'Installed source inventory is invalid; repair the skill lock before discovery');
    return { skills: value.skills as Record<string, unknown> };
  });
  const reader = options.readCandidates ?? readSkillCandidates;
  const candidates = new Map<string, Retained>();
  const previews = new Map<string, AcceptedSkillPlan>();
  let lookups = 0;
  const prune = (now: number) => {
    for (const [id, c] of candidates) if (c.expires <= now) candidates.delete(id);
    for (const [id, p] of previews) if (p.expires <= now) previews.delete(id);
  };
  const bounded = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.suspend<A, E | SkillOperationError, R>(() => {
    if (lookups >= SKILL_OPERATION_LIMITS.concurrentLookups) return refuse('BUSY', 'Skill lookup limit reached; retry after the current lookup finishes');
    lookups++;
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(effect);
      const run = Effect.gen(function* () {
        const result = yield* Effect.raceFirst(Fiber.await(fiber).pipe(Effect.map(exit => ({ kind: 'exit' as const, exit }))),
          clock.sleep(SKILL_OPERATION_LIMITS.deadlineMs).pipe(Effect.as({ kind: 'deadline' as const })));
        if (result.kind === 'exit') return yield* Exit.isSuccess(result.exit) ? Effect.succeed(result.exit.value) : Effect.failCause(result.exit.cause);
        // Join cancellation and retain every cleanup defect. A plain timeout combinator erases it.
        yield* Fiber.interrupt(fiber);
        const interrupted = yield* Fiber.await(fiber);
        if (Exit.isFailure(interrupted) && !Cause.hasInterruptsOnly(interrupted.cause)) return yield* Effect.failCause(interrupted.cause);
        return yield* refuse('INSPECT_FAILED', 'Skill lookup deadline exceeded; resolve and review again');
      });
      return yield* run.pipe(Effect.onInterrupt(() => Effect.gen(function* () {
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);
        if (Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isDieReason)) return yield* Effect.failCause(exit.cause);
      })));
    }).pipe(Effect.ensuring(Effect.sync(() => { lookups--; })));
  });
  const ready = Effect.gen(function* () {
    const inspection = yield* options.inspection;
    if (!inspection) return yield* refuse('NO_REPORT', 'Inspect the machine before resolving or previewing skill additions');
    const overrides = yield* store.read;
    if (inspection.desired.issues.length || overrides.issues.length) return yield* refuse('PROFILE_INVALID', 'The effective setup or machine overrides are invalid; repair them before adding skills');
    return { inspection, overrides };
  });
  const pinFor = (desired: DesiredConfig, source: string) => {
    const pins = [...new Set(desired.skills.filter(s => normalizeSkillSource(s.source) === source).flatMap(s => s.pin ? [s.pin.ref] : []))];
    return pins.length === 1 ? pins[0] : undefined;
  };
  const project = (candidateId: string, c: SkillCandidate) => ({ candidateId, source: c.source, revision: c.revision,
    sourceDir: c.sourceDir, selectorName: c.selectorName, installedName: c.installedName,
    description: [...c.description].slice(0, 500).join(''), internal: c.internal });
  const retain = (c: SkillCandidate, now: number) => {
    for (const [id, value] of candidates) if (identity(value.candidate) === identity(c)) return project(id, value.candidate);
    if (candidates.size >= SKILL_OPERATION_LIMITS.retainedCandidates) return undefined;
    const id = randomUUID();
    // Whole YAML records are irrelevant to installer identity and are deliberately not retained.
    const accepted = structuredClone({ ...c, metadata: {} });
    candidates.set(id, { candidate: accepted, expires: now + SKILL_OPERATION_LIMITS.candidateLifetimeMs });
    return project(id, accepted);
  };
  const resolveSkillCandidate = (input: OperationInput<'resolveSkillCandidate'>) => bounded(Effect.gen(function* () {
    const args = yield* Effect.try({ try: () => decodeOperationInput('resolveSkillCandidate', input), catch: () => new SkillOperationError('INVALID_REQUEST', 'Invalid skill lookup') });
    if (args.scope.kind !== 'machine') return yield* refuse('UNSUPPORTED_SCOPE', 'Skill additions support machine scope only');
    const { inspection } = yield* ready;
    const now = (yield* clock.now).getTime(); prune(now);
    const source = args.source === undefined ? undefined : normalizeSkillSource(args.source);
    if (args.source !== undefined && source === undefined) return yield* refuse('INVALID_REQUEST', 'Use a supported public GitHub repository identity without credentials');
    const lock = yield* lockRead;
    const inventory = [...inspection.desired.skills.map(s => s.source), ...Object.values(lock.skills).flatMap(m => sourceOf(m) ? [sourceOf(m)!] : [])];
    const unsupportedSources = source ? 0 : new Set(inventory.filter(s => normalizeSkillSource(s) === undefined)).size;
    const sources = source ? [source] : [...new Set(inventory.flatMap(s => normalizeSkillSource(s) ? [normalizeSkillSource(s)!] : []))].sort();
    let searched = false;
    const result = (status: SkillCandidateResult['status'], found: SkillCandidateResult['candidates'] = [], failures: SkillCandidateResult['failures'] = [], limit?: SkillCandidateResult['limit']): SkillCandidateResult =>
      ({ status, candidates: found, failures, unsupportedSources, knownSources: sources.length + unsupportedSources, searchedSources: searched ? sources : [], ...(limit ? { limit } : {}), limits: SKILL_OPERATION_LIMITS });
    if (unsupportedSources) return result('limited', [], [], 'unsupported-source-inventory');
    if (sources.length > SKILL_OPERATION_LIMITS.sources) return result('limited', [], [], 'source-inventory');
    // Concurrent source reads share the deliberate 20s body budget; operation IPC allows 120s.
    searched = true;
    const reads = yield* Effect.forEach(sources, s => reader({ source: s, ...(pinFor(inspection.desired, s) ? { revision: pinFor(inspection.desired, s)! } : {}), timeoutMs: SKILL_OPERATION_LIMITS.sourceTimeoutMs })
      .pipe(Effect.map(read => ({ source: s, read }))), { concurrency: SKILL_OPERATION_LIMITS.sources });
    const failures = reads.flatMap(({ source, read }) => read.ok ? [] : [{ source, reason: read.reason, ...(read.retainedDirectory ? { retainedDirectory: read.retainedDirectory } : {}) }]);
    if (failures.length) return result('unavailable', [], failures);
    const matches = reads.flatMap(({ read }) => read.ok ? read.candidates.filter(c => c.selectorName.toLowerCase() === args.name.toLowerCase() || c.installedName === args.name) : []);
    if (matches.length > SKILL_OPERATION_LIMITS.retainedCandidates) return result('limited', [], [], 'candidate-count');
    if (matches.some(c => c.sourceDir.length > 500)) return result('limited', [], [], 'candidate-path');
    const rows = matches.map(c => project('x'.repeat(36), c));
    if (Buffer.byteLength(JSON.stringify(result('ambiguous', rows))) > SKILL_OPERATION_LIMITS.resultBytes) return result('limited', [], [], 'result-bytes');
    if (candidates.size + matches.filter(c => ![...candidates.values()].some(v => identity(v.candidate) === identity(c))).length > SKILL_OPERATION_LIMITS.retainedCandidates) return result('limited', [], [], 'candidate-retention');
    const found = matches.map(c => retain(c, now)!);
    return decodeOperationOutput('resolveSkillCandidate', result(found.length === 0 ? 'not-found' : found.length === 1 ? 'found' : 'ambiguous', found));
  })).pipe(Effect.provideContext(context), Effect.mapError(e => e instanceof SkillOperationError ? e : new SkillOperationError('INSPECT_FAILED', 'Skill discovery could not read the machine')));

  const profileFiles = Layer.succeed(ProfileFiles, {
    readText: path => fs.readText(path).pipe(Effect.mapError(e => new ReadFailed({ path, reason: e.message }))),
    exists: fs.exists,
    list: path => fs.list(path).pipe(Effect.mapError(e => new ReadFailed({ path, reason: e.message }))),
  });
  const resolve = (inspection: JobInspection, overrides: Input<MachineOverrides>) => resolveInspection(inspection, overrides).pipe(
    Effect.catchTag('ProfileInvalid', () => refuse('PROFILE_INVALID', 'Skill addition conflicts with existing declarations or source-wide revisions')), Effect.provide(profileFiles));
  const previewSkillChange = (input: OperationInput<'previewChange'>) => bounded(Effect.gen(function* () {
    const args = yield* Effect.try({ try: () => decodeOperationInput('previewChange', input), catch: () => new SkillOperationError('INVALID_REQUEST', 'Invalid skill addition') });
    if (args.scope.kind !== 'machine') return yield* refuse('UNSUPPORTED_SCOPE', 'Skill additions support machine scope only');
    if (args.change.kind !== 'addSkill') return yield* refuse('INVALID_REQUEST', 'Expected an addSkill change');
    const change = { ...args.change, targets: TARGETS.filter(t => args.change.kind === 'addSkill' && args.change.targets.includes(t)) };
    const now = (yield* clock.now).getTime(); prune(now);
    const retained = candidates.get(change.candidateId);
    if (!retained) return yield* refuse('UNKNOWN_PLAN', 'Candidate expired or is unknown; resolve the requested skill again');
    const c = retained.candidate;
    const { inspection, overrides } = yield* ready;
    const generation = yield* options.generation;
    const targets = overrides.value.manageConfig === false ? [] : overrides.value.configTargets ?? TARGETS;
    if (change.targets.some(t => !targets.includes(t))) return yield* refuse('TARGET_UNAVAILABLE', 'A selected target is unavailable in setup context; configure it in the app or select a configured target');
    const baseline = yield* resolve(inspection, overrides);
    if (canonical(baseline) !== canonical(inspection.desired)) return yield* refuse('UNKNOWN_PLAN', 'The composed setup or overrides changed; inspect and resolve again');
    const pin = pinFor(baseline, c.source);
    let acceptedTree: readonly TreeEntry[] | undefined;
    const refreshed = yield* reader({ source: c.source, ...(pin ? { revision: pin } : {}), timeoutMs: SKILL_OPERATION_LIMITS.sourceTimeoutMs, observeTree: (candidate, tree) => { if (identity(candidate) === identity(c)) acceptedTree = tree; } });
    if (!refreshed.ok) return yield* refuse('INSPECT_FAILED', refreshed.reason === 'cleanup-failed'
      ? `Skill source cleanup failed; retained directory: ${refreshed.retainedDirectory ?? 'unknown'}` : `Skill source review is unavailable: ${refreshed.reason}`);
    const current = refreshed.candidates.find(next => identity(next) === identity(c));
    if (!current || refreshed.revision !== c.revision) return yield* refuse('UNKNOWN_PLAN', 'Skill source changed since discovery; resolve and review again');
    if (pin && pin !== c.revision) return yield* refuse('UNKNOWN_PLAN', 'Source revision policy changed; resolve and review again');
    const lock = yield* lockRead;
    const destination = join(inspection.paths.agentsSkills, c.installedName);
    const canonicalDestination = yield* fs.realPath(destination);
    for (const name of (yield* fs.list(inspection.paths.agentsSkills)) ?? []) {
      if (name === c.installedName) {
        const kind = (yield* fs.stat(destination))?.kind;
        if (kind !== 'directory' && kind !== 'symlink') return yield* refuse('INVALID_REQUEST', 'The skill destination conflicts with a non-skill filesystem entry');
        if (normalizeSkillSource(sourceOf(additionLockEntry(lock, name)?.meta) ?? '') !== c.source) return yield* refuse('INVALID_REQUEST', 'An existing same-name skill conflicts with the selected source');
      } else if (canonicalDestination !== undefined && (yield* fs.realPath(join(inspection.paths.agentsSkills, name))) === canonicalDestination) {
        return yield* refuse('INVALID_REQUEST', 'The selected installed name aliases an existing skill destination');
      }
    }
    for (const dir of new Set(change.targets.flatMap(t => agentSkillsDirs(inspection.paths, t)).filter(dir => dir !== inspection.paths.agentsSkills))) {
      const proposed = join(dir, c.installedName);
      const existing = yield* fs.realPath(proposed);
      for (const name of (yield* fs.list(dir)) ?? []) {
        const path = join(dir, name);
        const canonical = yield* fs.realPath(path);
        if ((name === c.installedName || (existing !== undefined && canonical === existing))
          && (name !== c.installedName || canonicalDestination === undefined || canonical !== canonicalDestination)) return yield* refuse('INVALID_REQUEST', 'Selected target has a same-name skill or filesystem alias conflict');
      }
    }
    const before = (overrides.value.skillAdditions ?? []).filter(a => a.source === c.source && a.name === c.installedName);
    if (before.length > 32) return yield* refuse('OVERSIZED', 'Existing declarations exceed the supported diff bounds');
    const revision = before.find(a => a.revision !== undefined)?.revision;
    const after: SkillAddition = { source: c.source, name: c.installedName, targets: TARGETS.filter(t => change.targets.includes(t) || before.some(a => a.targets.includes(t))), ...(revision ? { revision } : {}) };
    const enable = overrides.value.skills?.[c.installedName] === false;
    // Saving a first declaration moves legacy choices to overrides.json; preview that future provenance.
    const tentative: Input<MachineOverrides> = { ...overrides, source: overridesPath(inspection.paths), value: { ...overrides.value,
      skillAdditions: [...(overrides.value.skillAdditions ?? []).filter(a => !(a.source === c.source && a.name === c.installedName)), after],
      ...(enable ? { skills: { ...overrides.value.skills, [c.installedName]: true } } : {}) } };
    const desired = yield* resolve(inspection, tentative);
    if (desired.issues.length) return yield* refuse('PROFILE_INVALID', 'Skill addition conflicts with existing declarations or source-wide revisions');
    const selected = desired.skills.find(s => s.name === c.installedName && normalizeSkillSource(s.source) === c.source);
    if (!selected?.install) return yield* refuse('PROFILE_INVALID', 'The selected skill is disabled in desired configuration');
    // Exactness belongs to the selected operation, even when an inherited group adopts siblings.
    const exact: DesiredConfig = { ...desired, skills: desired.skills.map(s => s === selected ? { ...s, exact: true } : s) };
    const affectedSkills = baseline.skills.filter(s => normalizeSkillSource(s.source) === c.source).map(s => s.name).sort();
    if (affectedSkills.length > 256 || affectedSkills.some(s => s.length > 500)) return yield* refuse('OVERSIZED', 'Source policy impact exceeds the supported preview bounds');
    const report = { desired: exact, ...yield* inspectSkills(exact).pipe(Effect.provide(machinePaths(inspection.paths))) };
    if (report.probeErrors.length) return yield* refuse('INSPECT_FAILED', 'Skill store or exposure is unreadable; repair machine access before adding skills');
    const currentContent = acceptedTree && canonicalDestination !== undefined
      ? (yield* verifyInstalledSkillTree(c.installedName, acceptedTree, c.revision)).length === 0 : false;
    const needsInstall = report.items.some(i => i.label === c.installedName && i.disposition === 'apply')
      || !currentContent || !acceptedSkillLockMatches(lock, c);
    const selectedPlan: Plan = { kind: 'apply', skipped: [], steps: needsInstall ? [{
      key: `skills:install:${c.source}#${c.revision}`, domain: 'skills', action: 'install-skills',
      summary: `install ${c.installedName} at the accepted revision`, touches: [`skills/${c.installedName}`], interruptible: true, targets: after.targets,
    }] : [] };
    if ((yield* clock.now).getTime() >= retained.expires) return yield* refuse('UNKNOWN_PLAN', 'Candidate expired during preview; resolve and review again');
    if (generation !== (yield* options.generation) || canonical(yield* store.read) !== canonical(overrides)
      || canonical(yield* resolve(inspection, overrides)) !== canonical(baseline)) return yield* refuse('UNKNOWN_PLAN', 'The setup changed during preview; inspect and resolve again');
    const preview: ChangePreview = { planId: randomUUID(), scope: { kind: 'machine' }, change, generation: String(generation), plan: additionRunPlan(selectedPlan, c.installedName), nextActions: [],
      skillAddition: { candidate: project(change.candidateId, c), declaration: { before, after, changed: before.length !== 1 || canonical(before[0]) !== canonical(after) },
        ...(enable ? { enablement: { before: false, after: true } } : {}), installationTargets: after.targets,
        sharedStore: { codexScans: true, visibility: 'shared' }, pinImpact: { policy: pin ? selected.pin?.from.layer === 'machine' ? 'personal-pin' : 'source-pin' : 'upstream', revision: c.revision, affectedSkills }, nativeVerification: 'required' } };
    if (Buffer.byteLength(JSON.stringify(preview)) > SKILL_OPERATION_LIMITS.resultBytes) return yield* refuse('OVERSIZED', 'Skill preview exceeds its result bound');
    if (previews.size >= SKILL_OPERATION_LIMITS.retainedCandidates) return yield* refuse('BUSY', 'Skill preview retention limit reached; retry after previews expire');
    const checked = decodeOperationOutput('previewChange', preview);
    previews.set(preview.planId, { preview: checked, candidate: c, desired: exact, baseline, priorOverrides: overrides, overrides: tentative, plan: selectedPlan, generation, expires: retained.expires });
    return structuredClone(checked);
  })).pipe(Effect.provideContext(context), Effect.mapError(e => e instanceof SkillOperationError ? e : new SkillOperationError('INSPECT_FAILED', 'Skill preview could not read the machine')));
  return { resolveSkillCandidate, previewAddSkill: (input: { readonly scope: OperationScope; readonly candidateId: string; readonly targets: ReadonlyArray<'claude' | 'codex'> }) => previewSkillChange({ scope: input.scope, change: { kind: 'addSkill', candidateId: input.candidateId, targets: input.targets } }),
    clear: () => { candidates.clear(); previews.clear(); },
    acceptedPlan: (planId: string): Effect.Effect<AcceptedSkillPlan | undefined> => Effect.gen(function* () {
      prune((yield* clock.now).getTime());
      const p = previews.get(planId);
      return p ? structuredClone(p) : undefined;
    }) };
});

export type SkillOperations = Effect.Success<ReturnType<typeof makeSkillOperations>>;
