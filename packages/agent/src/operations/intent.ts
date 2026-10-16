import { createHash, randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { Effect, Exit, Layer } from 'effect';
import { loadProfile, normalizeSkillSource, ProfileFiles, ReadFailed, settingsComplaints, intentValueProblem, type DesiredConfig, type Input, type MachineOverrides, type Origin } from '@nortuscc/profile-engine';
import { Backups, backupsForRun, canonical, Fs, inspectMcpRouting, mcpRoutingEvidence, MachinePaths, machinePaths, OverridesStore, overridesPath, peekMachineState, persistMachineIntent, proposeMachineIntent, releasedRouting, setMcpRouting, StateStore, type McpRoutingFileId } from '@nortuscc/machine';
import { AgentClock } from '../clock.ts';
import { safeOwnerString } from './safety.ts';
import { SessionError } from '../ipc/session.ts';
import type { RunLifecycle } from '../runs.ts';
import type { JobInspection } from '../job.ts';
import { decodeOperationInput, decodeOperationOutput, type ChangePreview, type OperationInput, type OperationOutput, type ParityAcceptance, type ParityRunEvidence } from './index.ts';
import type { PreparedParityChange } from './parity.ts';

const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const refused = (code: SessionError['code'], message: string) => new SessionError(code, message);
const invalid = () => refused('PROFILE_INVALID', 'Machine intent conflicts with owned declarations or source-wide revision policy');
const stale = () => refused('UNKNOWN_PLAN', 'The machine intent or instructions changed; inspect and preview again');
type IntentChange = Extract<OperationInput<'previewChange'>['change'], { kind: 'machineIntent' }>;
type IntentItem = OperationOutput<'inspectIntent'>['items'][number];
const safeString = safeOwnerString;
// Reads and previews share one safety contract for every projected owner row.
const intentItemProblem = (item: IntentItem): NonNullable<OperationOutput<'inspectIntent'>['limitReason']> | undefined => {
  if (item.kind === 'setting') {
    if (intentValueProblem(item.value)) return 'value-limit';
    if (settingsComplaints({ [item.key]: item.value }).length) return 'unsafe-value';
  }
  const strings = item.kind === 'setting' ? [item.fileId, item.key, item.from.source] : item.kind === 'integration' ? [item.id, item.from.source, ...item.prerequisites]
    : item.kind === 'file' ? [item.id, item.from.source] : item.kind === 'skill' ? [item.source, item.name, item.from.source, item.declaredFrom.source, ...(item.revision ? [item.revision] : [])]
    : [item.kind === 'issue' ? item.source : item.from.source];
  if (strings.some(value => !safeString(value))) return 'identity-limit';
  if (Buffer.byteLength(JSON.stringify(item)) > 64 * 1024) return 'record-bytes';
};
const origin = (value: Origin): Origin => ({ layer: value.layer, source: value.source });
const baseOrigin = { layer: 'base' as const, source: 'built-in' };
const routingIds: readonly McpRoutingFileId[] = ['claude:CLAUDE.md', 'codex:AGENTS.md'];

const intentRows = (section: OperationInput<'inspectIntent'>['section'], desired: DesiredConfig, current: Input<MachineOverrides>): IntentItem[] => {
  let items: IntentItem[] = [];
  switch (section) {
    case 'configuration': items = [
      { kind: 'manageConfig', value: current.value.manageConfig ?? true, from: current.value.manageConfig === undefined ? baseOrigin : { layer: 'machine', source: current.source } },
      { kind: 'configTargets', value: current.value.configTargets ?? ['claude', 'codex'], from: current.value.configTargets === undefined ? baseOrigin : { layer: 'machine', source: current.source } },
    ]; break;
    case 'files': items = desired.files.map(f => ({ kind: 'file', id: f.id, target: f.target, managed: f.managed, from: origin(f.from) })); break;
    case 'settings': items = desired.files.flatMap(f => Object.entries(f.keys ?? {}).map(([key, value]) => ({ kind: 'setting' as const, fileId: f.id, key, value: value.value, from: origin(value.from) }))); break;
    case 'skills': items = desired.skills.map(s => ({ kind: 'skill', source: normalizeSkillSource(s.source) ?? s.source, name: s.name, choice: current.value.skills?.[s.name] ?? null, defaultEnabled: s.targets !== undefined || !s.optional, enabled: s.install, from: origin(s.from), declaredFrom: origin(s.declaredFrom ?? { layer: 'base', source: 'skills-manifest.txt' }), targets: s.targets ?? ['claude', 'codex'], policy: !s.pin ? 'upstream' : s.pin.from.layer === 'machine' ? 'personal-pin' : 'source-pin', ...(s.pin ? { revision: s.pin.ref } : {}) })); break;
    case 'integrations': items = desired.integrations.map(i => ({ kind: 'integration', id: i.id,
      type: ['hook', 'mcp', 'plugin', 'marketplace'].includes(String(i.declaration.type)) ? i.declaration.type as 'hook' | 'mcp' | 'plugin' | 'marketplace' : 'unknown',
      ...(i.declaration.target === 'claude' || i.declaration.target === 'codex' ? { target: i.declaration.target } : {}), enabled: i.enabled, from: origin(i.from), prerequisites: [...(Array.isArray(i.declaration.requiresEnv) && i.declaration.requiresEnv.length ? ['Declared environment prerequisites must be available to the integration owner'] : []), ...(i.declaration.type === 'hook' ? ['The declared hook file must remain available'] : []), 'Installation uses the existing integration owner; removal is unavailable'] })); break;
    case 'issues': items = desired.issues.map(i => ({ kind: 'issue', layer: i.layer, source: i.source, message: 'Configuration input is invalid; inspect the owning document in the app' })); break;
  }
  return items;
};

// Read and mutation adapters share the profile/store owners. No installer is captured here.
export const makeIntentOperations = (options: {
  readonly inspection: Effect.Effect<JobInspection | undefined>;
  readonly generation: Effect.Effect<number>;
  readonly freshInspection: Effect.Effect<JobInspection | undefined, unknown>;
  readonly invalidate: () => void;
}) => Effect.gen(function* () {
  const fs = yield* Fs;
  const store = yield* OverridesStore;
  const stateStore = yield* StateStore;
  const paths = yield* MachinePaths;
  const clock = yield* AgentClock;
  const context = yield* Effect.context<Fs | MachinePaths | OverridesStore | StateStore>();
  const observeRouting = (desired: DesiredConfig, id: McpRoutingFileId) => inspectMcpRouting(desired, id).pipe(Effect.provideService(StateStore, { ...stateStore, read: peekMachineState }));
  const files = Layer.succeed(ProfileFiles, {
    readText: path => fs.readText(path).pipe(Effect.mapError(() => new ReadFailed({ path, reason: 'Configuration cannot be read' }))), exists: fs.exists,
    list: path => fs.list(path).pipe(Effect.mapError(() => new ReadFailed({ path, reason: 'Configuration cannot be read' }))),
  });
  const resolve = (inspection: JobInspection, overrides: Input<MachineOverrides>) => loadProfile(inspection.paths.repo, { overrides }).pipe(Effect.provide(files));
  const ready = Effect.gen(function* () {
    const inspection = yield* options.inspection;
    if (!inspection) return yield* Effect.fail(refused('NO_REPORT', 'Inspect the machine before reading or changing intent'));
    const current = yield* store.read;
    return { inspection, current };
  });
  let observedInspection: JobInspection | undefined;
  let observationSerial = 0;
  const inspectIntent = (input: OperationInput<'inspectIntent'>): Effect.Effect<OperationOutput<'inspectIntent'>, SessionError> => Effect.gen(function* () {
    const args = yield* Effect.try({ try: () => decodeOperationInput('inspectIntent', input), catch: () => refused('INVALID_REQUEST', 'Invalid intent inspection') });
    if (args.scope.kind !== 'machine') return yield* Effect.fail(refused('UNSUPPORTED_SCOPE', 'Intent inspection supports machine scope only'));
    const { inspection, current } = yield* ready;
    if (observedInspection !== inspection) { observedInspection = inspection; observationSerial++; }
    const generation = `${yield* options.generation}:${observationSerial}`;
    const desired = inspection.desired;
    // Refuse an observation/store mix from an external edit even without a scheduler generation.
    const observed = yield* resolve(inspection, current);
    if (canonical(observed) !== canonical(desired)) return yield* Effect.fail(stale());
    const items = intentRows(args.section, desired, current);
    const binding = digest({ section: args.section, generation, desired, current });
    let offset = 0;
    if (args.cursor) {
      const cursor = yield* Effect.try({ try: () => JSON.parse(Buffer.from(args.cursor!, 'base64url').toString('utf8')) as { binding: string; offset: number }, catch: () => stale() });
      if (cursor.binding !== binding || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > items.length || Object.keys(cursor).sort().join() !== 'binding,offset') return yield* Effect.fail(stale());
      offset = cursor.offset;
    }
    const limited = (limitReason: NonNullable<OperationOutput<'inspectIntent'>['limitReason']>) => ({ generation, items: [], nextCursor: null, limitReason });
    const page: IntentItem[] = [];
    for (const item of items.slice(offset, offset + args.limit)) {
      const problem = intentItemProblem(item);
      if (problem) return limited(problem);
      page.push(item);
      const nextCursor = offset + page.length < items.length ? Buffer.from(JSON.stringify({ binding, offset: offset + page.length })).toString('base64url') : null;
      if (Buffer.byteLength(JSON.stringify({ generation, items: page, nextCursor })) > 64 * 1024) { page.pop(); break; }
    }
    const nextCursor = offset + page.length < items.length ? Buffer.from(JSON.stringify({ binding, offset: offset + page.length })).toString('base64url') : null;
    return yield* Effect.try({ try: () => decodeOperationOutput('inspectIntent', { generation, items: page, nextCursor }), catch: () => refused('OVERSIZED', 'Intent identities or values exceed the supported read limits') });
  }).pipe(Effect.mapError(e => e instanceof SessionError ? e : refused('INSPECT_FAILED', 'Intent inspection could not read configuration')));

  const prepare = (change: IntentChange): Effect.Effect<PreparedParityChange, SessionError> => Effect.gen(function* () {
    const { inspection, current } = yield* ready;
    if (current.issues.length || inspection.desired.issues.length) return yield* Effect.fail(invalid());
    const generation = String(yield* options.generation);
    const before = yield* resolve(inspection, current);
    if (canonical(before) !== canonical(inspection.desired)) return yield* Effect.fail(stale());
    const next = yield* proposeMachineIntent(before, current.value, change.patch).pipe(Effect.mapError(e => e.reason === 'limit' ? refused('OVERSIZED', `Setting value exceeds its ${e.limit} limit`) : invalid()));
    const tentative = { value: next, source: overridesPath(inspection.paths), issues: [] };
    const after = yield* resolve(inspection, tentative);
    if (after.issues.length) return yield* Effect.fail(invalid());
    const routes = [] as { id: McpRoutingFileId; evidence: string; path: string; text: string | undefined }[];
    const routingState = yield* peekMachineState;
    for (const id of routingIds) {
      if (!before.files.some(f => f.id === id && f.managed) || after.files.some(f => f.id === id && f.managed)) continue;
      const status = yield* observeRouting(before, id);
      if (status.intent === 'invalid' || status.blockStatus === 'conflict' && status.intent !== 'active') return yield* Effect.fail(refused('PROFILE_INVALID', 'Routing ownership must be repaired before changing targets'));
      if (status.intent === 'unowned' || status.intent === 'released' && status.blockStatus === 'absent') continue;
      const path = join(id === 'claude:CLAUDE.md' ? paths.claude : paths.codex, id === 'claude:CLAUDE.md' ? 'CLAUDE.md' : 'AGENTS.md');
      const text = yield* fs.readText(path);
      if (status.evidence !== mcpRoutingEvidence(text, routingState.mcpRouting, true)) return yield* Effect.fail(stale());
      routes.push({ id, evidence: status.evidence, path, text });
    }
    const source = 'source' in change.patch ? change.patch.source : undefined;
    const impacted = source === undefined ? [] : after.skills.filter(s => normalizeSkillSource(s.source) === source);
    const affectedNames = source === undefined ? [] : [...new Set([...before.skills, ...after.skills].filter(s => normalizeSkillSource(s.source) === source).map(s => s.name))];
    if (affectedNames.length > 256) return yield* Effect.fail(refused('OVERSIZED', 'Source impact exceeds the supported preview limit'));
    const keys = ['intent:overrides', ...routes.map(r => `intent:routing:${r.id}`)];
    const plan = { kind: 'operation' as const, steps: keys.map(key => ({ key, domain: 'intent' as const, action: 'save-intent' as const,
      summary: key === 'intent:overrides' ? 'Save machine intent' : 'Release owned routing for an unmanaged target', touches: [key === 'intent:overrides' ? overridesPath(paths) : routes.find(r => key.endsWith(r.id))!.path], interruptible: false })), skipped: [] };
    const patch = change.patch;
    const section = patch.kind === 'setting' ? 'settings' : patch.kind === 'integration' ? 'integrations' : patch.kind === 'skill' || patch.kind === 'removeSkillDeclaration' ? 'skills' : 'configuration';
    const selected = (desired: DesiredConfig, overrides: Input<MachineOverrides>) => intentRows(section, desired, overrides).find(item =>
      patch.kind === 'setting' ? item.kind === 'setting' && item.fileId === patch.fileId && item.key === patch.key
        : patch.kind === 'integration' ? item.kind === 'integration' && item.id === patch.id
        : patch.kind === 'skill' || patch.kind === 'removeSkillDeclaration' ? item.kind === 'skill' && item.name === patch.name && item.source === patch.source
        : item.kind === patch.kind) ?? null;
    const beforeItem = selected(before, current);
    const afterItem = selected(after, tentative);
    const ownerStrings = [...(source === undefined ? [] : [source]), ...affectedNames, ...plan.steps.flatMap(step => step.touches)];
    if ([beforeItem, afterItem].some(item => item !== null && intentItemProblem(item) !== undefined) || ownerStrings.some(value => !safeString(value)))
      return yield* Effect.fail(refused('OVERSIZED', 'Intent preview contains unsafe or oversized owner data'));
    const preview: ChangePreview = yield* Effect.try({ try: () => decodeOperationOutput('previewChange', { planId: randomUUID(), scope: { kind: 'machine' }, generation, change, plan, nextActions: [], machineIntent: {
      intentChanges: [{ kind: 'machine-choice', action: change.patch.kind === 'removeSkillDeclaration' ? 'removeSkillDeclaration' : change.patch.action, message: 'Save the selected explicit machine choice; reset reveals inherited intent', before: beforeItem, after: afterItem }],
      installationEffects: ['No content is installed or physically removed by this operation', 'Targets require availability and do not restrict shared-store visibility', 'Later reconciliation uses the saved enablement and target choices'],
      sourceImpact: source === undefined ? [] : [{ source, skills: affectedNames, policy: !impacted[0]?.pin ? 'upstream' : impacted[0].pin.from.layer === 'machine' ? 'personal-pin' : 'source-pin' }],
    } }), catch: () => refused('OVERSIZED', 'Intent preview identities or values exceed the supported limits') });
    if (Buffer.byteLength(JSON.stringify(preview)) > 64 * 1024) return yield* Effect.fail(refused('OVERSIZED', 'Intent preview exceeds the result limit'));
    const acceptance: ParityAcceptance = { kind: 'machineIntent', generation, baselineDigest: digest({ before, current, routes: routes.map(r => ({ id: r.id, evidence: r.evidence })) }), planDigest: digest(plan), plannedKeys: keys };
    const revalidate = Effect.gen(function* () {
      const fresh = yield* options.freshInspection;
      if (!fresh || canonical(fresh.desired) !== canonical(before) || canonical(yield* store.read) !== canonical(current) || canonical(yield* resolve(fresh, current)) !== canonical(before)) return yield* Effect.fail(stale());
      for (const route of routes) if ((yield* observeRouting(before, route.id)).evidence !== route.evidence || (yield* fs.readText(route.path)) !== route.text) return yield* Effect.fail(stale());
    }).pipe(Effect.provideContext(context), Effect.mapError(e => e instanceof SessionError ? e : stale()));
    return { preview, acceptance, revalidate, execute: (lifecycle: RunLifecycle, signal: AbortSignal) => Effect.flatMap(clock.now, now => Effect.gen(function* () {
      const backups = yield* Backups;
      let evidence: Extract<ParityRunEvidence, { kind: 'machineIntent' }> = { kind: 'machineIntent', state: 'needsInspection', intentState: 'pending', routingEffects: [], committedKeys: [], remainingKeys: keys, backupIds: [] };
      const checkpoint = () => Effect.gen(function* () {
        const dir = yield* backups.dir;
        evidence = { ...evidence, backupIds: dir ? [basename(dir)] : evidence.backupIds };
        yield* lifecycle.parity(evidence);
      });
      const committed = (key: string) => { evidence = { ...evidence, state: 'partial', committedKeys: [...evidence.committedKeys, key], remainingKeys: evidence.remainingKeys.filter(k => k !== key) }; };
      // Save first: StateStore's routing write may migrate legacy choices otherwise.
      for (const [index, step] of plan.steps.entries()) {
        if (signal.aborted) return;
        yield* lifecycle.progress({ type: 'started', index, total: plan.steps.length, step });
        evidence = { ...evidence, state: 'needsInspection', ...(index === 0 ? { intentState: 'needsInspection' } : {}) };
        if (index > 0) evidence = { ...evidence, routingEffects: [...evidence.routingEffects, { fileId: routes[index - 1]!.id, state: 'needsInspection' }] };
        yield* checkpoint();
        const outcome = yield* Effect.exit(Effect.gen(function* () {
          if (index === 0) {
            yield* persistMachineIntent(next, current.value);
            evidence = { ...evidence, intentState: 'saved' };
            committed(step.key);
          } else {
            const route = routes[index - 1]!;
            // Permit only earlier releases from this operation, never freshly adopted edits.
            let expected = routingState;
            for (const earlier of routes.slice(0, index - 1)) expected = releasedRouting(expected, earlier.id);
            const expectedEvidence = mcpRoutingEvidence(route.text, expected.mcpRouting, true);
            const status = yield* inspectMcpRouting(before, route.id);
            if (status.evidence !== expectedEvidence) return yield* Effect.fail(stale());
            const result = yield* setMcpRouting(before, route.id, false, expectedEvidence, { lockHeld: true });
            evidence = { ...evidence, routingEffects: [...evidence.routingEffects.filter(r => r.fileId !== route.id), { fileId: route.id, state: 'observed', intentChanged: result.intentChanged, instructionsChanged: result.instructionsChanged, outcome: result.outcome }] };
            if (result.intentChanged || result.instructionsChanged || result.intent === 'released') committed(step.key);
            // The owner intentionally preserves an already edited active block on release.
            const preservedEdit = status.blockStatus === 'conflict' && result.intent === 'released' && !result.instructionsChanged && (yield* fs.readText(route.path)) === route.text;
            if (result.intent !== 'released' || result.outcome === 'conflict' && !preservedEdit) return yield* Effect.fail(stale());
          }
        }));
        options.invalidate();
        if (Exit.isFailure(outcome)) evidence = { ...evidence, state: 'needsInspection' };
        yield* checkpoint();
        if (Exit.isFailure(outcome)) return yield* Effect.fail(refused('INTERNAL', 'Intent operation stopped; inspect saved intent and routing ownership'));
        yield* lifecycle.progress({ type: 'finished', index, total: plan.steps.length, key: step.key, outcome: 'ok', note: 'Intent effect observed' });
      }
    }).pipe(Effect.provide(backupsForRun(now).pipe(Layer.provideMerge(machinePaths(inspection.paths)))), Effect.provideContext(context), Effect.ensuring(Effect.sync(options.invalidate)), Effect.mapError(() => refused('INTERNAL', 'Intent progress could not be saved; inspect before retrying')))), afterRelease: 'inspect' as const };
  }).pipe(Effect.provideContext(context), Effect.mapError(e => e instanceof SessionError ? e : refused('INSPECT_FAILED', 'Intent preview could not read configuration')));
  return { inspectIntent, prepare };
});
