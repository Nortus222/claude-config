import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { Effect } from 'effect';
import { parseSkillsManifest } from '@nortuscc/profile-engine';
import { authorDigest, Backups, backupsForRun, bindAuthorCheckout, canonical, captureDomains, Fs, MachinePaths, MANIFEST_FILE, OverridesStore, prepareCapture, selectAll, validateCapture,
  type MachinePathsValue, type Plan, type Progress } from '@nortuscc/machine';
import { checkoutGroups, decodeSyncState } from '@nortuscc/sync';
import { recordedRun } from '../apply.ts';
import { AgentClock } from '../clock.ts';
import { SessionError } from '../ipc/session.ts';
import type { RunLifecycle } from '../runs.ts';
import type { ParityRunEvidence } from './model.ts';
import type { JobInspection } from '../job.ts';
import type { AgentServices } from '../layer.ts';
import { decodeOperationOutput, type OperationChange } from './index.ts';
import type { PreparedParityChange } from './parity.ts';
import { safeOwnerString } from './safety.ts';

type CaptureChange = Extract<OperationChange, { kind: 'capture' }>;
const digest = (value: unknown) => authorDigest(canonical(value))!;
const stale = () => new SessionError('UNKNOWN_PLAN', 'Author checkout or capture inputs changed; inspect and preview again');
const failed = () => new SessionError('INTERNAL', 'Capture stopped; inspect recorded effects and backups');

export const prepareCaptureChange = (change: CaptureChange, inspection: JobInspection, configured: MachinePathsValue): Effect.Effect<PreparedParityChange, SessionError, AgentServices> => Effect.gen(function* () {
  if (!inspection.trusted) return yield* Effect.fail(new SessionError('APP_UNAVAILABLE', 'Trust this repository in the app before capturing configuration'));
  const context = yield* Effect.context<AgentServices>(); const fs = yield* Fs; const clock = yield* AgentClock;
  const overrides = yield* (yield* OverridesStore).read;
  if (overrides.issues.length) return yield* Effect.fail(new SessionError('PROFILE_INVALID', 'Repair machine choices before capturing configuration'));
  const manageConfig = change.manageConfig ?? overrides.value.manageConfig !== false;
  const selection = { ...selectAll, only: [...new Set(change.only)], targets: change.targets ?? selectAll.targets, force: change.takeLocal };
  const paths = inspection.desired.files.filter(file => selection.only.some(key => key.split('#')[0] === `config:${file.id}`)).map(file => file.src);
  if (selection.only.includes('skills:manifest')) paths.push(MANIFEST_FILE);
  const author = yield* bindAuthorCheckout(configured, paths);
  const syncPath = join(configured.stateRoot, 'sync.json'); const overridesPath = join(configured.stateRoot, 'overrides.json');
  const syncBytes = yield* fs.readBytes(syncPath);
  const holds = yield* decodeSyncState(syncBytes === undefined ? undefined : new TextDecoder().decode(syncBytes), syncPath);
  const additional = { sync: authorDigest(syncBytes), overrides: authorDigest(yield* fs.readBytes(overridesPath)) };
  const before = selection.only.includes('skills:manifest') ? parseSkillsManifest(yield* fs.readText(join(author.realCheckout, MANIFEST_FILE))) : [];
  const prepared = yield* prepareCapture({ author, desired: inspection.desired, heldItemIds: Object.keys(holds), heldManifestGroups: checkoutGroups([], before, holds), selection,
    allowShrink: change.allowShrink, manageConfig }).pipe(Effect.provideService(MachinePaths, configured));
  if (prepared.report.probeErrors.length) return yield* Effect.fail(new SessionError('INSPECT_FAILED', 'Capture inputs could not be read'));
  const publicPlan: Plan = { ...prepared.plan, steps: prepared.plan.steps.map(step => ({ ...step, summary: step.key === 'skills:manifest' ? 'Regenerate the complete skills manifest with held declarations and the shrink guard' : 'Capture selected configuration into the configured author checkout' })),
    skipped: prepared.plan.skipped.map(item => ({ key: item.key, reason: ['not selected', 'target not selected', 'held by nortuscc sync'].includes(item.reason) ? item.reason : 'Existing capture rules prevent this effect; inspect the item in the app' })) };
  const strings = [author.checkout, author.realCheckout, author.gitDir, ...author.files.map(file => file.path), ...selection.only, ...publicPlan.steps.flatMap(step => [step.key, ...step.touches]), ...publicPlan.skipped.map(item => item.key), ...prepared.documents.map(doc => doc.path)];
  if (strings.some(value => !safeOwnerString(value))) return yield* Effect.fail(new SessionError('OVERSIZED', 'Capture preview contains unsafe or oversized owner data'));
  const preview = yield* Effect.try({ try: () => decodeOperationOutput('previewChange', { planId: randomUUID(), scope: { kind: 'machine' }, generation: '0', change, plan: publicPlan, nextActions: [],
    capture: { checkout: author.checkout, head: author.head, redacted: true, documents: prepared.documents.map(({ path, beforeSha256, afterSha256 }) => ({ path, beforeSha256, afterSha256 })),
      manifest: { ...prepared.manifest, reason: prepared.manifest.reason || 'No installed skills; the manifest remains unchanged' } },
    actionEffects: ['Writes only selected effects into the configured author checkout; observation snapshots remain unchanged', 'Private document bodies are redacted; names and exact digests identify proposed changes', 'Manifest regeneration replaces the whole manifest when selected, preserving held declarations and enforcing the shrink guard'] }), catch: () => new SessionError('OVERSIZED', 'Capture preview exceeds supported limits') });
  if (Buffer.byteLength(JSON.stringify(preview)) > 65536) return yield* Effect.fail(new SessionError('OVERSIZED', 'Capture preview exceeds supported limits'));
  const acceptance = { kind: 'capture' as const, author, generation: '0', baselineDigest: digest({ author, inputs: prepared.inputDigests, additional }), planDigest: digest(publicPlan), plannedKeys: publicPlan.steps.map(step => step.key) };
  const revalidateChoices = Effect.gen(function* () {
    if (authorDigest(yield* fs.readBytes(syncPath)) !== additional.sync || authorDigest(yield* fs.readBytes(overridesPath)) !== additional.overrides) return yield* Effect.fail(stale());
  }).pipe(Effect.mapError(() => stale()));
  yield* revalidateChoices;
  const revalidate = Effect.gen(function* () { yield* validateCapture(prepared); yield* revalidateChoices; }).pipe(Effect.provideService(MachinePaths, configured), Effect.provideContext(context), Effect.mapError(() => stale()));
  return { preview, acceptance, revalidate, execute: (lifecycle: RunLifecycle, signal: AbortSignal) => Effect.flatMap(clock.now, now => Effect.gen(function* () {
    const backups = yield* Backups;
    let evidence: ParityRunEvidence = { kind: 'capture', state: 'needsInspection', committedKeys: [], remainingKeys: [...acceptance.plannedKeys], backupIds: [] };
    const checkpointBackups = () => Effect.gen(function* () {
      const folder = yield* backups.dir;
      evidence = { ...evidence, backupIds: folder ? [basename(folder)] : evidence.backupIds };
      yield* lifecycle.parity(evidence);
    });
    const domains = yield* captureDomains(prepared, signal, { pending: () => Effect.gen(function* () { evidence = { ...evidence, state: 'needsInspection' }; yield* checkpointBackups(); }), committed: key => Effect.gen(function* () {
      evidence = { ...evidence, state: 'partial', committedKeys: [...new Set([...evidence.committedKeys, key])], remainingKeys: evidence.remainingKeys.filter(item => item !== key) };
      yield* checkpointBackups();
    }) }, revalidateChoices);
    const project = (event: Progress): Progress => event.type === 'started' ? { ...event, step: publicPlan.steps[event.index]! }
      : event.type === 'finished' ? { ...event, note: event.outcome === 'ok' ? 'Capture effect observed' : 'Capture did not complete; inspect recorded effects and backups' } : event;
    const ran = yield* recordedRun(prepared.plan, prepared.report, domains, { runId: lifecycle.runId, actor: lifecycle.actor, automatic: false, signal,
      operation: { operation: 'applyChange', scope: { kind: 'machine' }, requestId: lifecycle.requestId }, projectProgress: project,
      checkpoint: event => Effect.gen(function* () { yield* checkpointBackups(); yield* lifecycle.progress(project(event)); }) });
    if (ran.steps.some(step => step.outcome !== 'ok')) return yield* Effect.fail(failed());
  }).pipe(Effect.provide(backupsForRun(now)), Effect.provideService(MachinePaths, configured), Effect.provideContext(context), Effect.mapError(() => failed()))), afterRelease: 'inspect' as const };
}).pipe(Effect.mapError(error => error instanceof SessionError ? error : new SessionError('REPO_NOT_FOUND', 'A usable configured author checkout and unchanged capture inputs are required')));
