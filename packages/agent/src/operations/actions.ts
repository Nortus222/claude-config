import { createHash, randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { Effect, Layer } from 'effect';
import {
  Backups, backupsForRun, canonical, configDomainWithObserver, Fs, homeDir, inspect, MachinePaths, machinePaths,
  peekMachineState, plan, selectAll, StateStore, type MachineReport, type Plan, type Progress, type Selection,
} from '@nortuscc/machine';
import { itemIdOf } from '@nortuscc/sync';
import { recordedRun } from '../apply.ts';
import { AgentClock } from '../clock.ts';
import { SessionError } from '../ipc/session.ts';
import type { RunLifecycle } from '../runs.ts';
import type { JobInspection } from '../job.ts';
import type { AgentDomains, AgentServices } from '../layer.ts';
import { decodeOperationOutput, type ActionChange, type ParityRunEvidence } from './index.ts';
import type { PreparedParityChange } from './parity.ts';
import { describe, failedStepsMessage, redact, safeMessage, safeOwnerString } from './safety.ts';

const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const fileKey = (key: string) => key.split('#')[0]!;
const stale = () => new SessionError('UNKNOWN_PLAN', 'Selected configuration changed; preview again');
// The failed step's own note, else why the run itself stopped.
const failed = (error: unknown) => error instanceof SessionError ? error : new SessionError('INTERNAL', safeMessage(`Couldn't finish the machine action: ${describe(error)}`));
const skipReasons = new Set(['not selected', 'target not selected', 'not managed on this machine', 'changed since nortuscc wrote it',
  'not valid JSON on this machine; fix it by hand', 'changed on this machine; capture keeps it', 'changed on both sides; --take-repo keeps the repo version',
  'Resolve and preview this skill addition to repair or update it with native verification', 'not enabled on this machine',
  'declined (--no-hooks)', 'declined (--no-mcp)', 'declined (--no-plugins)', 'declined (--no-skills)']);
const projectPlan = (planned: Plan): Plan => ({ ...planned,
  steps: planned.steps.map(step => ({ ...step, summary: step.action === 'restore' ? 'Restore the selected recorded document and all its recorded keys'
    : step.domain === 'integrations' ? 'Install the selected declared integration using its existing prerequisites'
    : step.domain === 'skills' ? 'Reconcile the selected declared skills using the existing owner'
    : 'Apply the selected owned configuration' })),
  skipped: planned.skipped.map(item => ({ key: item.key, reason: skipReasons.has(item.reason) ? item.reason : "Skipped by the item's owner rules" })),
});
const safeProgress = (progress: Progress, publicPlan: Plan): Progress => progress.type === 'started'
  ? { ...progress, step: publicPlan.steps[progress.index]! }
  : progress.type === 'finished' ? { ...progress, note: progress.outcome === 'ok' ? 'Machine effect observed' : redact(progress.note) || 'Step did not complete' }
  : progress;

// Only config uninstall expands selected keys to documents. All their rows remain available to owner guards.
const actionPlan = (change: ActionChange, report: MachineReport, selection: Selection, domains: ReturnType<AgentDomains>): Plan => {
  if (change.kind === 'reconcile') return plan('apply', report, selection, domains);
  const selectedDocuments = new Set(change.only.map(fileKey));
  const rows = report.items.filter(item => item.domain === 'config' && item.target !== undefined && selection.targets.includes(item.target) && selectedDocuments.has(fileKey(item.key)));
  return plan('uninstall', { ...report, items: rows }, { ...selection, only: rows.map(item => item.key) }, domains.filter(domain => domain.name === 'config'));
};

export const prepareActionChange = (change: ActionChange, inspection: JobInspection, domains: AgentDomains): Effect.Effect<PreparedParityChange, SessionError, AgentServices> => Effect.gen(function* () {
  change = { ...change, only: [...new Set(change.only)] };
  if (inspection.desired.issues.length) return yield* Effect.fail(new SessionError('PROFILE_INVALID', 'Configuration inputs must be repaired before applying machine actions'));
  const context = yield* Effect.context<AgentServices>();
  const fs = yield* Fs; const stateStore = yield* StateStore; const clock = yield* AgentClock;
  const built = domains(inspection.paths);
  const observedAt = yield* clock.now;
  const selection: Selection = { ...selectAll, only: [...new Set(change.only)], targets: change.targets ?? selectAll.targets,
    declined: change.kind === 'reconcile' ? change.declined ?? [] : [], force: change.force ?? false };
  const known = new Set(inspection.report.items.filter(item => change.kind === 'reconcile' || item.domain === 'config').flatMap(item =>
    change.kind === 'uninstallConfig' ? [item.key, fileKey(item.key)] : [item.key]));
  if (change.only.some(key => !known.has(key))) return yield* Effect.fail(new SessionError('UNKNOWN_KEY', 'A selected key is not an eligible item of the inspection'));
  const planned = actionPlan(change, inspection.report, selection, built);
  const publicPlan = projectPlan(planned);
  const strings = [...change.only, ...publicPlan.steps.flatMap(step => [step.key, ...step.touches]), ...publicPlan.skipped.map(item => item.key)];
  if (strings.some(value => !safeOwnerString(value))) return yield* Effect.fail(new SessionError('OVERSIZED', 'Action preview contains unsafe or oversized owner data'));
  const selectedRows = (report: MachineReport) => report.items.filter(item => change.kind === 'uninstallConfig'
    ? item.domain === 'config' && change.only.some(key => fileKey(key) === fileKey(item.key)) && item.target !== undefined && selection.targets.includes(item.target)
    : selection.only!.includes(item.key));
  const selectedFiles = inspection.desired.files.filter(file => selectedRows(inspection.report).some(item => fileKey(item.key) === `config:${file.id}`));
  const evidence = (report: MachineReport) => Effect.gen(function* () {
    const state = yield* peekMachineState;
    const documents = [];
    for (const file of selectedFiles) documents.push({ id: file.id, text: yield* fs.readText(join(homeDir(inspection.paths, file.home), file.dest)) });
    return digest({ desired: report.desired, selection, rows: selectedRows(report).map(item => ({ ...item, identity: itemIdOf(item.key, report.desired) ?? item.key })), state, documents });
  });
  const baselineDigest = yield* evidence(inspection.report);
  const preview = yield* Effect.try({ try: () => decodeOperationOutput('previewChange', { planId: randomUUID(), scope: { kind: 'machine' }, generation: '0', change, plan: publicPlan, nextActions: [], actionEffects: change.kind === 'uninstallConfig'
    ? ['Restore each selected recorded document, including all its recorded keys, using trusted originals and ownership guards', 'Integration and skill content is preserved']
    : ['Install and repair declared selected content using existing prerequisites', 'Disable changes future installation policy; it does not delete installed integrations or skills'] }), catch: () => new SessionError('OVERSIZED', 'Action preview exceeds supported limits') });
  if (Buffer.byteLength(JSON.stringify(preview)) > 65536) return yield* Effect.fail(new SessionError('OVERSIZED', 'Action preview exceeds supported limits'));
  const acceptance = { kind: change.kind, generation: '0', baselineDigest, planDigest: digest(publicPlan), plannedKeys: planned.steps.map(step => step.key) };
  return { preview, acceptance, revalidate: Effect.gen(function* () {
    const report = yield* inspect(inspection.desired, built).pipe(Effect.provideService(StateStore, { ...stateStore, read: peekMachineState }));
    if (digest(actionPlan(change, report, selection, built)) !== digest(planned) || (yield* evidence(report)) !== baselineDigest) return yield* Effect.fail(stale());
  }).pipe(Effect.provide(backupsForRun(observedAt).pipe(Layer.provideMerge(machinePaths(inspection.paths)))), Effect.provideContext(context), Effect.mapError(() => stale())),
  execute: (lifecycle: RunLifecycle, signal: AbortSignal) => Effect.flatMap(clock.now, now => Effect.gen(function* () {
    const backups = yield* Backups;
    let evidence: ParityRunEvidence = { kind: change.kind, state: 'needsInspection', committedKeys: [], remainingKeys: [...acceptance.plannedKeys], backupIds: [] };
    const checkpoint = () => Effect.gen(function* () {
      const folder = yield* backups.dir;
      evidence = { ...evidence, backupIds: folder ? [basename(folder)] : evidence.backupIds };
      yield* lifecycle.parity(evidence);
    });
    const commit = (key: string) => Effect.gen(function* () {
      evidence = { ...evidence, committedKeys: [...new Set([...evidence.committedKeys, key])], remainingKeys: evidence.remainingKeys.filter(k => k !== key), state: 'partial' };
      yield* checkpoint();
    });
    const observedDomains = built.map(domain => domain.name === 'config' && change.kind === 'uninstallConfig' ? configDomainWithObserver({ pending: () => checkpoint(), committed: commit }) : domain);
    const ran = yield* recordedRun(planned, inspection.report, observedDomains, { runId: lifecycle.runId, actor: lifecycle.actor, automatic: false, signal,
      operation: { operation: 'applyChange', scope: { kind: 'machine' }, requestId: lifecycle.requestId }, projectProgress: event => safeProgress(event, publicPlan),
      checkpoint: event => Effect.gen(function* () {
        evidence = { ...evidence, state: 'needsInspection' };
        if (event.type === 'finished' && event.outcome === 'ok') yield* commit(event.key);
        else yield* checkpoint();
        yield* lifecycle.progress(safeProgress(event, publicPlan));
      }),
    });
    if (ran.steps.some(step => step.outcome !== 'ok'))
      return yield* Effect.fail(new SessionError('INTERNAL', failedStepsMessage(ran.steps) ?? 'Cancelled before every step finished'));
  }).pipe(Effect.provide(backupsForRun(now).pipe(Layer.provideMerge(machinePaths(inspection.paths)))), Effect.provideContext(context), Effect.mapError(failed))), afterRelease: 'inspect' as const };
}).pipe(Effect.mapError(error => error instanceof SessionError ? error : new SessionError('INSPECT_FAILED', 'Action preview could not read configuration')));
