import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { Effect, Layer } from 'effect';
import { parseSkillsManifest, normalizeSkillSource } from '@nortuscc/profile-engine';
import { addCommand, authorDigest, Backups, backupsForRun, bindAuthorCheckout, canonical, executeUpdateManifest, Fs, inspectUpdates,
  installedSkillNames, machinePaths, MANIFEST_FILE, plan, prepareUpdateManifest, Processes, readSkillLockEvidence, selectAll, skillsDomain, skillsUpdateDomain, additionLockEntry, hasVerifiedAdoption,
  SKILL_STEP, skillNamesOf, matchSkillName, validateAuthorBinding,
  type MachinePathsValue, type MachineReport, type Plan, type PreparedAuthorEdit, type Progress } from '@nortuscc/machine';
import { checkoutGroups, decodeSyncState } from '@nortuscc/sync';
import { AgentClock } from '../clock.ts';
import { AgentSkillInstaller } from '../skill-installer.ts';
import { recordedRun } from '../apply.ts';
import { SessionError } from '../ipc/session.ts';
import type { JobInspection } from '../job.ts';
import type { AgentServices } from '../layer.ts';
import { decodeOperationInput, decodeOperationOutput, type OperationChange, type OperationInput, type OperationOutput, type ParityRunEvidence } from './index.ts';
import type { PreparedParityChange } from './parity.ts';
import { safeOwnerString } from './safety.ts';
const digest = (value: unknown) => authorDigest(canonical(value))!;
const stale = () => new SessionError('UNKNOWN_PLAN', 'Update inputs or author checkout changed; preview again');
const failed = () => new SessionError('INTERNAL', 'The update did not finish; check for new changes and preview again. Backups are in ~/.config/nortuscc/backups');
export const ADDITION_REPAIR = 'Resolve this source and skill with resolveSkillCandidate, review previewChange(addSkill), then applyChange for native verification';
export const LEGACY_NATIVE_PREREQUISITE = 'Exact legacy source and native selector evidence is required; resolveSkillCandidate then previewChange(addSkill) and applyChange';
// The declaration an update row's skill stands for. The installer treats skill names case-insensitively, so a
// declared `TDD` may be installed as `tdd`.
const declarationOf = (desired: JobInspection['desired'], label: string) => {
  const name = matchSkillName(desired.skills.map(s => s.name), label);
  return name === undefined ? undefined : desired.skills.find(s => s.name === name);
};
const observedUpdates = (desired: JobInspection['desired']) => inspectUpdates(desired,{ maxSources: 8, verifyAdoption: true }).pipe(Effect.timeout('20 seconds'));

export const inspectUpdateOperations = (inspection: JobInspection | undefined, generation: number, input: OperationInput<'inspectUpdates'>): Effect.Effect<OperationOutput<'inspectUpdates'>, SessionError, AgentServices> => Effect.gen(function* () {
  const args = yield* Effect.try({ try: () => decodeOperationInput('inspectUpdates', input), catch: () => new SessionError('INVALID_REQUEST', 'Invalid update inspection') });
  if (args.scope.kind !== 'machine') return yield* Effect.fail(new SessionError('UNSUPPORTED_SCOPE', 'Update inspection supports machine scope only'));
  if (!inspection) return yield* Effect.fail(new SessionError('NO_REPORT', 'Inspect the machine before checking updates'));
  const acceptedLock = yield* Effect.result(readSkillLockEvidence);
  if (acceptedLock._tag === 'Failure') return { generation: String(generation), items: [], nextCursor: null, unavailable: true };
  const observation = yield* Effect.result(observedUpdates(inspection.desired));
  if (observation._tag === 'Failure' || observation.success.probeErrors.length) return { generation: String(generation), items: [], nextCursor: null, unavailable: true };
  const freshLock = yield* Effect.result(readSkillLockEvidence);
  if (freshLock._tag === 'Failure' || authorDigest(freshLock.success.bytes) !== authorDigest(acceptedLock.success.bytes)) return { generation: String(generation), items: [], nextCursor: null, unavailable: true };
  const rows = observation.success.items;
  const items: OperationOutput<'inspectUpdates'>['items'][number][] = [];
  for (const row of rows) {
    // Local untracked folders have no source-qualified update identity. A row keeps the installed name, which update
    // and remove act on and which the operation schema's lowercase skill names admit, even when its declaration differs in case.
    const declaration = declarationOf(inspection.desired, row.label);
    const source = row.group || (declaration?.targets !== undefined ? declaration.source : undefined);
    if (!source) continue;
    const addition = declaration?.targets !== undefined;
    const tree = row.facts?.find(f => /^offered-tree:[a-f0-9]{40}$/.test(f))?.slice(13);
    const revision = row.state === 'off-pin' ? declaration?.pin?.ref : undefined;
    const adoptionPrerequisite = row.state === 'available' && !hasVerifiedAdoption(row);
    const exactLegacy = row.state === 'available' ? hasVerifiedAdoption(row) : additionLockEntry(acceptedLock.success.lock,row.label)?.selectorName === row.label;
    const repairRoute = addition || adoptionPrerequisite ? 'addition' as const : exactLegacy && ['available','off-pin','gone','outdated'].includes(row.state) ? 'reconcile' as const : 'unavailable' as const;
    const item = { id: `skill:${source}/${row.label}`, key: row.key, source, name: row.label,
      state: row.state as OperationOutput<'inspectUpdates'>['items'][number]['state'], targets: declaration?.targets ?? ['claude', 'codex'] as const,
      policy: !declaration?.pin ? 'upstream' as const : declaration.pin.from.layer === 'machine' ? 'personal-pin' as const : 'source-pin' as const,
      offered: tree ? { kind: 'tree' as const, digest: tree } : revision && /^[a-f0-9]{40}$/.test(revision) ? { kind: 'revision' as const, digest: revision } : null,
      repairRoute, ...(addition || adoptionPrerequisite ? { prerequisite: ADDITION_REPAIR } : repairRoute === 'unavailable' && ['outdated', 'gone', 'off-pin'].includes(row.state) ? { prerequisite: LEGACY_NATIVE_PREREQUISITE } : {}) };
    if ([item.id,item.key,item.source,item.name].some(v => !safeOwnerString(v))) return { generation: String(generation), items: [], nextCursor: null, unavailable: true, limitReason: 'unsafe-owner-data' as const };
    items.push(item);
  }
  const binding = digest({ generation, desired: inspection.desired, items }); let offset = 0;
  if (args.cursor) {
    const cursor = yield* Effect.try({ try: () => JSON.parse(Buffer.from(args.cursor!, 'base64url').toString('utf8')), catch: stale });
    if (cursor.binding !== binding || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > items.length || Object.keys(cursor).sort().join() !== 'binding,offset') return yield* Effect.fail(stale());
    offset = cursor.offset;
  }
  const page = items.slice(offset,offset + args.limit);
  if (Buffer.byteLength(JSON.stringify(page)) > 32768) return { generation: String(generation), items: [], nextCursor: null, unavailable: true, limitReason: 'result-bytes' as const };
  return yield* Effect.try({ try: () => decodeOperationOutput('inspectUpdates', { generation: String(generation), items: page, unavailable: false, nextCursor: offset + page.length < items.length ? Buffer.from(JSON.stringify({ binding, offset: offset + page.length })).toString('base64url') : null }), catch: () => new SessionError('OVERSIZED', 'Update inspection contains unsupported owner identities') });
}).pipe(Effect.mapError(error => error instanceof SessionError ? error : new SessionError('INSPECT_FAILED', 'Update inputs could not be read')));

type UpdateChange = Extract<OperationChange,{ kind: 'update' }>;
export const prepareUpdateChange = (change: UpdateChange, inspection: JobInspection, configured: MachinePathsValue): Effect.Effect<PreparedParityChange, SessionError, AgentServices> => Effect.gen(function* () {
  if (!inspection.trusted) return yield* Effect.fail(new SessionError('APP_UNAVAILABLE', 'Trust this repository in the app before updating skills'));
  if (inspection.desired.issues.length) return yield* Effect.fail(new SessionError('PROFILE_INVALID', 'Repair configuration inputs before updating skills'));
  change = { ...change, only: [...new Set(change.only)] };
  const context = yield* Effect.context<AgentServices>(); const fs = yield* Fs; const clock = yield* AgentClock; const installer = yield* AgentSkillInstaller;
  const raw = yield* readSkillLockEvidence; const installed = yield* installedSkillNames;
  const observed = yield* observedUpdates(inspection.desired);
  if (observed.probeErrors.length) return yield* Effect.fail(new SessionError('INSPECT_FAILED', 'Update inputs are unavailable'));
  // The first accepted raw bytes remain authoritative, including absence.
  if (authorDigest((yield* readSkillLockEvidence).bytes) !== authorDigest(raw.bytes)) return yield* Effect.fail(stale());
  const syncPath = join(configured.stateRoot, 'sync.json'); const overridesPath = join(configured.stateRoot, 'overrides.json');
  const syncBytes = yield* fs.readBytes(syncPath); const overridesBytes = yield* fs.readBytes(overridesPath);
  const holds = yield* decodeSyncState(syncBytes === undefined ? undefined : new TextDecoder('utf-8', { fatal: true }).decode(syncBytes), syncPath);
  const rows = observed.items.filter(row => !(row.state === 'available' && `skill:${row.group}/${row.label}` in holds));
  if (change.only.some(key => !rows.some(row => row.key === key))) return yield* Effect.fail(new SessionError('UNKNOWN_KEY', 'Selected update keys are unavailable in this inspection'));
  const report: MachineReport = { desired: inspection.desired, items: rows, probeErrors: [] };
  const selection = { ...selectAll, only: change.only, targets: change.targets ?? selectAll.targets, declined: change.declined ?? [] };
  if (rows.some(row => change.only.includes(row.key) && row.group && normalizeSkillSource(row.group) !== row.group)) return yield* Effect.fail(new SessionError('APP_UNAVAILABLE',LEGACY_NATIVE_PREREQUISITE));
  const legacy = plan('update', report, selection, [skillsDomain]);
  const selectedRows = report.items.filter(row => change.only.includes(row.key));
  const invalidLegacy = selectedRows.filter(row => declarationOf(inspection.desired, row.label)?.targets === undefined && (row.state === 'available' ? !hasVerifiedAdoption(row) : ['outdated','gone','off-pin'].includes(row.state) &&
    (!additionLockEntry(raw.lock,row.label) || additionLockEntry(raw.lock,row.label)?.selectorName !== row.label || normalizeSkillSource(row.group) !== row.group)));
  const blockedNames = new Set(invalidLegacy.map(row => row.label));
  const blocked = legacy.steps.filter(step => skillNamesOf(step).some(name => blockedNames.has(name)));
  let planned: Plan = { ...legacy, steps: legacy.steps.filter(step => step.key !== SKILL_STEP.manifest && !blocked.includes(step)).map(step => step.key === SKILL_STEP.expose ? { ...step, touches: [...new Set(legacy.steps.filter(s => s.key !== SKILL_STEP.remove && s.key !== SKILL_STEP.manifest && s.key !== SKILL_STEP.expose).flatMap(s => s.touches))] } : step),
    skipped: [...legacy.skipped, ...invalidLegacy.map(row => ({ key: row.key, reason: LEGACY_NATIVE_PREREQUISITE }))] };
  if (blocked.length) planned = { ...planned, steps: planned.steps.filter(step => step.key !== SKILL_STEP.expose) };
  const nativeDomain = skillsUpdateDomain(selection.targets);
  const prepareNative = (command: import('@nortuscc/machine').Command) => installer.prepareLegacy
    ? installer.prepareLegacy(inspection.paths,command)
    : Effect.fail(new SessionError('APP_UNAVAILABLE','Native skill installer requires an explicit home, shared lock and configured roots before legacy updates'));
  // Probe the destination mapping before retaining a plan or accepting any machine effect.
  if (planned.steps.length && !selection.targets.length) return yield* Effect.fail(new SessionError('INVALID_REQUEST','Select at least one native target for legacy skill effects'));
  if (planned.steps.length) yield* prepareNative(addCommand({ source: 'owner/repo', skills: ['probe'], targets: selection.targets }));
  let authorEdit: PreparedAuthorEdit | undefined;
  let heldManifestGroups: ReturnType<typeof checkoutGroups> = [];
  if (change.authorManifest) {
    const author = yield* bindAuthorCheckout(configured, [MANIFEST_FILE]);
    const before = parseSkillsManifest(yield* fs.readText(join(author.realCheckout, MANIFEST_FILE)));
    heldManifestGroups = checkoutGroups([],before,holds);
    authorEdit = yield* prepareUpdateManifest({ author, desired: inspection.desired, report, selected: planned, heldManifestGroups, heldItemIds: Object.keys(holds) });
    if (authorEdit.documents.length) planned = { ...planned, steps: [...planned.steps, { key: SKILL_STEP.manifest, domain: 'skills', action: 'write-manifest', summary: 'Write the separately reviewed author manifest', touches: [MANIFEST_FILE], interruptible: false }] };
  }
  const publicPlan: Plan = { ...planned, steps: planned.steps.map(step => ({ ...step, summary: step.key === SKILL_STEP.manifest ? 'Write the separately reviewed author manifest' : 'Apply the selected legacy skill action using existing owner rules' })), skipped: planned.skipped.map(row => ({ key: row.key, reason: row.reason === LEGACY_NATIVE_PREREQUISITE || row.reason.startsWith('Resolve and preview') || row.reason === 'not selected' ? row.reason : 'Existing owner rules prevent this selected update' })) };
  const strings = [...change.only, ...publicPlan.steps.flatMap(s => [s.key,...s.touches]), ...publicPlan.skipped.map(s => s.key), ...(authorEdit ? [authorEdit.author.checkout,authorEdit.author.realCheckout,authorEdit.author.gitDir,...authorEdit.author.files.map(f => f.path)] : [])];
  if (strings.some(s => !safeOwnerString(s))) return yield* Effect.fail(new SessionError('OVERSIZED', 'Update preview contains unsafe owner data'));
  const baseline = { raw: authorDigest(raw.bytes), installed, rows, holds: authorDigest(syncBytes), overrides: authorDigest(overridesBytes), author: authorEdit?.author };
  const preview = yield* Effect.try({ try: () => decodeOperationOutput('previewChange', { planId: randomUUID(), scope: { kind: 'machine' }, generation: '0', change, plan: publicPlan, nextActions: [],
    ...(authorEdit ? { authorManifest: { checkout: authorEdit.author.checkout, head: authorEdit.author.head, redacted: true, documents: authorEdit.documents.map(({path,beforeSha256,afterSha256}) => ({path,beforeSha256,afterSha256})) } } : {}),
    actionEffects: ['Selected machine effects retain source and revision policy; scoped prune can leave shared content for another native agent and is incomplete until observed absent; no native verification is claimed', 'Machine-only updates never write an observation snapshot or publish machine additions', ADDITION_REPAIR, ...(change.authorManifest ? ['The author manifest is written only if observed outcomes exactly match the reviewed proposal'] : [])] }), catch: () => new SessionError('OVERSIZED', 'Update preview exceeds supported bounds') });
  if (Buffer.byteLength(JSON.stringify(preview)) > 65536) return yield* Effect.fail(new SessionError('OVERSIZED', 'Update preview exceeds supported bounds'));
  const acceptance = { kind: 'update' as const, generation: '0', baselineDigest: digest(baseline), planDigest: digest(publicPlan), plannedKeys: planned.steps.map(s => s.key), ...(authorEdit ? { author: authorEdit.author } : {}) };
  const choices = Effect.gen(function* () {
    if (authorDigest(yield* fs.readBytes(syncPath)) !== baseline.holds || authorDigest(yield* fs.readBytes(overridesPath)) !== baseline.overrides) return yield* Effect.fail(stale());
  });
  const revalidate = Effect.gen(function* () {
    yield* choices;
    if (authorDigest((yield* readSkillLockEvidence).bytes) !== baseline.raw || canonical(yield* installedSkillNames) !== canonical(installed)) return yield* Effect.fail(stale());
    const refreshed = yield* observedUpdates(inspection.desired);
    if (refreshed.probeErrors.length || refreshed.sourceFailures?.some(failure => failure.reason === 'cleanup-failed' || failure.retainedDirectory !== undefined))
      return yield* Effect.fail(stale());
    if (canonical(refreshed.items) !== canonical(observed.items)) return yield* Effect.fail(stale());
    if (authorEdit) yield* validateAuthorBinding(authorEdit.author);
  }).pipe(Effect.provideContext(context), Effect.mapError(stale));
  yield* revalidate;
  return { preview, acceptance, revalidate, afterRelease: 'inspect' as const, execute: (lifecycle: import('../runs.ts').RunLifecycle, signal: AbortSignal) => Effect.flatMap(clock.now, now => Effect.gen(function* () {
    const backups = yield* Backups;
    let evidence: ParityRunEvidence = { kind: 'update', state: 'needsInspection', committedKeys: [], remainingKeys: [...acceptance.plannedKeys], backupIds: [] };
    const checkpoint = () => Effect.gen(function* () { const folder = yield* backups.dir; evidence = { ...evidence, backupIds: folder ? [basename(folder)] : evidence.backupIds }; yield* lifecycle.parity(evidence); });
    const commit = (key: string) => Effect.gen(function* () { evidence = { ...evidence, state: 'partial', committedKeys: [...new Set([...evidence.committedKeys,key])], remainingKeys: evidence.remainingKeys.filter(k => k !== key) }; yield* checkpoint(); });
    const processes = yield* Processes;
    const domain = { ...nativeDomain, run: (step: import('@nortuscc/machine').Step, input: MachineReport) => Effect.gen(function* () {
      if (step.key === SKILL_STEP.manifest) {
        if (!authorEdit) return { ok: false };
        yield* choices;
        const result = yield* executeUpdateManifest({ edit:authorEdit,desired:inspection.desired,selected:planned,heldManifestGroups,heldItemIds:Object.keys(holds) },signal,
          { pending:() => checkpoint(),committed:() => commit(SKILL_STEP.manifest) },choices);
        return { ok: !result.remainingPaths.length };
      }
      return yield* nativeDomain.run(step,input).pipe(Effect.provideService(Processes,{ ...processes, run: command => {
        if (command.cmd !== 'npx') return processes.run(command);
        if (!['add','remove'].includes(command.args[2] ?? '') || !command.args.includes('--agent')) return Effect.fail(new SessionError('APP_UNAVAILABLE', 'Legacy native side effects require a bounded configured invocation'));
        return Effect.flatMap(prepareNative(command),prepared => processes.run(prepared));
      } }));
    }) };
    const project = (event: Progress): Progress => event.type === 'started' ? { ...event, step: publicPlan.steps[event.index]! } : event.type === 'finished' ? { ...event, note: event.outcome === 'ok' ? 'Update effect observed' : 'Update effect did not complete' } : event;
    const ran = yield* recordedRun(planned,report,[domain],{ runId: lifecycle.runId, actor: lifecycle.actor, automatic: false, signal, operation: { operation: 'applyChange', scope: { kind: 'machine' }, requestId: lifecycle.requestId }, projectProgress: project,
      checkpoint: event => Effect.gen(function* () { evidence = { ...evidence, state: 'needsInspection' }; if (event.type === 'finished' && event.outcome === 'ok') yield* commit(event.key); else yield* checkpoint(); yield* lifecycle.progress(project(event)); }) });
    if (ran.steps.some(s => s.outcome !== 'ok')) return yield* Effect.fail(failed());
  }).pipe(Effect.provide(backupsForRun(now).pipe(Layer.provideMerge(machinePaths(inspection.paths)))),Effect.provideContext(context),Effect.mapError(failed))) };
}).pipe(Effect.mapError(error => error instanceof SessionError ? error : new SessionError('APP_UNAVAILABLE', 'Update inputs, configured native destinations or the requested author checkout are unavailable')));
