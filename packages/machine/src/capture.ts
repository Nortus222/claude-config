import { join } from 'node:path';
import { Effect, Stream } from 'effect';
import { parseSettingsKeys, parseSkillsManifest, type DesiredConfig, type SkillGroup } from '@nortuscc/profile-engine';
import { authorDigest, AuthorUnavailable, observedAuthorReplacement, validateAuthorBinding, type AuthorBinding, type AuthorDocument, type AuthorServices, type PreparedAuthorEdit } from './author.ts';
import { Backups } from './backups.ts';
import { configDomain } from './config/domain.ts';
import { configFileId } from './config/observe.ts';
import { Fs } from './fs.ts';
import { FsFailed } from './errors.ts';
import type { MutationObserver } from './history.ts';
import { MachinePaths } from './paths.ts';
import type { Domain, MachineReport, Plan, Selection, Step } from './model.ts';
import { execute, inspect, plan } from './run.ts';
import { peekMachineState, serializeMachineState, StateStore } from './state.ts';
import { emitManifest, installedGroups, installedSkillNames, MANIFEST_FILE, readSkillLock, skillLockPath } from './skills/index.ts';

export const CAPTURE_MANIFEST_STEP: Step = { key: 'skills:manifest', domain: 'skills', action: 'write-manifest', summary: `write ${MANIFEST_FILE}`, touches: [MANIFEST_FILE], interruptible: false };
export type CaptureInput = { readonly author: AuthorBinding; readonly desired: DesiredConfig; readonly heldItemIds: readonly string[]; readonly heldManifestGroups: readonly SkillGroup[]; readonly selection: Selection; readonly allowShrink: boolean; readonly manageConfig: boolean };
export type PreparedCapture = PreparedAuthorEdit & { readonly report: MachineReport; readonly plan: Plan; readonly inputDigests: Readonly<Record<string, string | null>>; readonly manifest: { readonly write: boolean; readonly reason: string } };
type CapturePrivate = { stateDigest: string | null; installedDigest?: string | null; };
const internals = new WeakMap<PreparedCapture, CapturePrivate>();
const digestState = (state: unknown) => authorDigest(JSON.stringify(state));
const failure = () => new FsFailed({ op: 'capture', path: 'configured author checkout', reason: 'Capture inputs changed or could not be written; inspect again' });
const noop = { pending: () => Effect.void, committed: () => Effect.void };
const heldKey = (key: string) => key.includes('#') ? `setting:${key.slice('config:'.length)}` : `file:${configFileId(key)}`;

// Preview through the same config owner using an in-memory write boundary. No baseline is persisted.
export const prepareCapture = (input: CaptureInput): Effect.Effect<PreparedCapture, unknown, AuthorServices> => Effect.gen(function* () {
  const fs = yield* Fs; const paths = { ...(yield* MachinePaths), repo: input.author.realCheckout };
  yield* validateAuthorBinding(input.author);
  const inputDigests: Record<string, string | null> = {};
  const overlay = new Map<string, string>();
  const documents = new Map<string, AuthorDocument>();
  const readText = (path: string) => Effect.gen(function* () {
    if (overlay.has(path)) return overlay.get(path);
    const bytes = yield* fs.readBytes(path); const digest = authorDigest(bytes);
    if (Object.hasOwn(inputDigests, path) && inputDigests[path] !== digest) return yield* Effect.fail(failure());
    inputDigests[path] = digest;
    return bytes === undefined ? undefined : yield* Effect.try({ try: () => new TextDecoder('utf-8', { fatal: true }).decode(bytes), catch: () => failure() });
  });
  const memoryFs: Fs['Service'] = { ...fs, readText, writeTextAtomic: (path, text) => Effect.try({ try: () => {
    const file = input.author.files.find(file => join(paths.repo, file.path) === path);
    if (!file) throw new AuthorUnavailable();
    overlay.set(path, text); documents.set(file.path, { path: file.path, beforeSha256: file.sha256, text, afterSha256: authorDigest(text)! });
  }, catch: () => failure() }) };
  const initialState = yield* peekMachineState;
  for (const path of [join(paths.stateRoot, 'state.json'), join(paths.claude, '.nortuscc-lock.json')]) inputDigests[path] = authorDigest(yield* fs.readBytes(path));
  let state = initialState;
  const memoryStore: StateStore['Service'] = { read: Effect.sync(() => state), write: next => Effect.sync(() => { state = next; }), update: f => Effect.sync(() => { state = f(state); return state; }) };
  const noBackups: Backups['Service'] = { dir: Effect.succeed(undefined), preserve: () => Effect.succeed(undefined), moveAside: () => Effect.fail(failure()) };
  const desiredFiles = [];
  for (const file of input.manageConfig ? input.desired.files : []) {
    if (file.mode !== 'merge-keys') { desiredFiles.push(file); continue; }
    const text = yield* readText(join(paths.repo, file.src));
    const current = parseSettingsKeys(text, file.src);
    // The current author document owns the allowlist. Snapshot keys cannot restore a removed key.
    const keys = Object.fromEntries(Object.entries(file.keys ?? {}).filter(([key]) => current.value && Object.hasOwn(current.value, key)).map(([key, entry]) => [key, { ...entry, value: current.value![key] }]));
    desiredFiles.push({ ...file, keys });
  }
  const desired = { ...input.desired, files: desiredFiles };
  const body = Effect.gen(function* () {
    const report = yield* inspect(desired, input.manageConfig ? [configDomain] : []);
    const known = new Set([...report.items.map(item => item.key), CAPTURE_MANIFEST_STEP.key]);
    if (input.selection.only?.some(key => !known.has(key))) return yield* Effect.fail(new AuthorUnavailable());
    const original = plan('capture', report, input.selection, [configDomain]);
    const isHeld = (key: string) => input.heldItemIds.includes(heldKey(key));
    let planned: Plan = { ...original, steps: original.steps.filter(step => !isHeld(step.key)), skipped: [...original.skipped.map(item => isHeld(item.key) ? { ...item, reason: 'held by nortuscc sync' } : item), ...original.steps.filter(step => isHeld(step.key)).map(step => ({ key: step.key, reason: 'held by nortuscc sync' }))] };
    if (report.probeErrors.length === 0) for (const step of planned.steps) yield* configDomain.run(step, report);
    let manifest = { write: false, reason: 'not selected' }; let installedDigest: string | null | undefined;
    if ((input.selection.only === undefined || input.selection.only.includes(CAPTURE_MANIFEST_STEP.key)) && !input.selection.exclude.includes(CAPTURE_MANIFEST_STEP.key)) {
      const path = join(paths.repo, MANIFEST_FILE); const before = parseSkillsManifest(yield* readText(path));
      const lockPath = skillLockPath(paths);
      // Capture requires readable evidence. Decode only these bound bytes; the tolerant reader
      // must not swallow a filesystem failure or substitute data from another observation.
      const lockText = yield* readText(lockPath).pipe(Effect.mapError(() => failure()));
      const lock = yield* readSkillLock.pipe(Effect.provideService(Fs, { ...memoryFs,
        readText: path => path === lockPath ? Effect.succeed(lockText) : memoryFs.readText(path),
      }));
      const installed = yield* installedSkillNames;
      installedDigest = digestState(installed);
      const groups = installedGroups(lock, installed, before).map(group => ({ ...group, skills: group.skills.filter(name => !input.heldItemIds.includes(`skill:${group.source}/${name}`)) }));
      for (const held of input.heldManifestGroups) {
        const found = groups.find(group => group.source === held.source);
        if (found) found.skills = [...new Set([...found.skills, ...held.skills])].sort(); else groups.push({ ...held, skills: [...held.skills] });
      }
      const next = groups.filter(group => group.skills.length).sort((a,b) => a.source < b.source ? -1 : a.source > b.source ? 1 : 0);
      const beforeCount = before.reduce((n,g) => n + g.skills.length, 0); const afterCount = next.reduce((n,g) => n + g.skills.length, 0);
      manifest = afterCount < beforeCount && !input.allowShrink ? { write: false, reason: `refused — would drop ${beforeCount - afterCount} entr(ies); pass --allow-shrink` }
        : afterCount === 0 ? { write: false, reason: '' } : { write: true, reason: `written — ${afterCount} skill(s)` };
      if (manifest.write) yield* memoryFs.writeTextAtomic(path, emitManifest(next));
      planned = { ...planned, steps: [...planned.steps, CAPTURE_MANIFEST_STEP] };
    }
    const prepared = { author: input.author, documents: [...documents.values()], report, plan: planned, inputDigests, manifest };
    internals.set(prepared, { stateDigest: digestState(initialState), installedDigest });
    return prepared;
  });
  const result = yield* body.pipe(Effect.provideService(MachinePaths, paths), Effect.provideService(Fs, memoryFs), Effect.provideService(StateStore, memoryStore), Effect.provideService(Backups, noBackups));
  yield* validateCapture(result);
  return result;
});

export const validateCapture = (prepared: PreparedCapture): Effect.Effect<void, unknown, AuthorServices> => Effect.gen(function* () {
  const privateData = internals.get(prepared); if (!privateData) return yield* Effect.fail(failure());
  yield* validateAuthorBinding(prepared.author);
  const fs = yield* Fs;
  for (const [path, digest] of Object.entries(prepared.inputDigests)) if (authorDigest(yield* fs.readBytes(path)) !== digest) return yield* Effect.fail(failure());
  if (digestState(yield* peekMachineState) !== privateData.stateDigest || (privateData.installedDigest !== undefined && digestState(yield* installedSkillNames) !== privateData.installedDigest)) return yield* Effect.fail(failure());
});

// Both the CLI and app execute these guarded steps through machine.execute. The caller owns the lock.
export const captureDomains = (prepared: PreparedCapture, signal: AbortSignal, observer: MutationObserver = noop, revalidateInputs: Effect.Effect<void, unknown> = Effect.void): Effect.Effect<readonly Domain<AuthorServices | Backups>[], unknown, AuthorServices> => Effect.gen(function* () {
  const privateData = internals.get(prepared); if (!privateData) return yield* Effect.fail(failure());
  const context = yield* Effect.context<AuthorServices>();
  const fs = yield* Fs; const store = yield* StateStore; const paths = { ...(yield* MachinePaths), repo: prepared.author.realCheckout };
  let author = prepared.author; let expectedState = privateData.stateDigest; const expectedInputs = { ...prepared.inputDigests };
  const guard = Effect.gen(function* () {
    if (signal.aborted) return yield* Effect.fail(failure());
    yield* validateAuthorBinding(author);
    yield* revalidateInputs;
    for (const [path, digest] of Object.entries(expectedInputs)) if (authorDigest(yield* fs.readBytes(path)) !== digest) return yield* Effect.fail(failure());
    if (digestState(yield* peekMachineState) !== expectedState || (privateData.installedDigest !== undefined && digestState(yield* installedSkillNames) !== privateData.installedDigest)) return yield* Effect.fail(failure());
  });
  const guarded = guard.pipe(Effect.provideContext(context));
  const run = (step: Step) => Effect.gen(function* () {
    yield* guarded; yield* observer.pending(step.key);
    let observed = false;
    const guardedFs: Fs['Service'] = { ...fs, writeTextAtomic: (path, text) => Effect.gen(function* () {
      yield* guarded;
      const document = author.files.find(file => join(paths.repo, file.path) === path);
      if (!document) return yield* Effect.fail(failure());
      yield* fs.writeTextAtomic(path, text);
      author = observedAuthorReplacement(author, document.path, text);
      if (Object.hasOwn(expectedInputs, path)) expectedInputs[path] = authorDigest(text);
      observed = true;
      yield* observer.committed(step.key);
    }).pipe(Effect.mapError(() => failure())) };
    const guardedStore: StateStore['Service'] = { ...store, read: peekMachineState.pipe(Effect.provideContext(context)), update: f => Effect.gen(function* () {
      yield* guarded;
      const result = yield* store.update(f); expectedState = digestState(result);
      expectedInputs[join(paths.stateRoot, 'state.json')] = authorDigest(serializeMachineState(result));
      // A baseline-only effect is still a committed effect.
      if (!observed) { observed = true; yield* observer.committed(step.key); }
      return result;
    }).pipe(Effect.mapError(() => failure())) };
    if (step.key === CAPTURE_MANIFEST_STEP.key) {
      if (prepared.manifest.write) {
        const document = prepared.documents.find(doc => doc.path === MANIFEST_FILE)!;
        yield* (yield* Backups).preserve(join(paths.repo, MANIFEST_FILE), join('capture', MANIFEST_FILE));
        yield* guardedFs.writeTextAtomic(join(paths.repo, MANIFEST_FILE), document.text);
      }
      if (!observed) yield* observer.committed(step.key);
      return { ok: true, note: prepared.manifest.reason };
    }
    const result = yield* configDomain.run(step, prepared.report).pipe(Effect.provideService(MachinePaths, paths), Effect.provideService(Fs, guardedFs), Effect.provideService(StateStore, guardedStore));
    if (result.ok && !observed) yield* observer.committed(step.key);
    return result;
  });
  return [{ ...configDomain, run }, { name: 'skills', inspect: () => Effect.succeed({ items: [], probeErrors: [] }), steps: () => ({ steps: [], skipped: [] }), run }];
});

export const executeCapture = (prepared: PreparedCapture, signal: AbortSignal, observer: MutationObserver): Effect.Effect<{ committedPaths: readonly string[]; remainingPaths: readonly string[] }, unknown, AuthorServices | Backups> => Effect.gen(function* () {
  const committed = new Set<string>();
  const domains = yield* captureDomains(prepared, signal, { pending: observer.pending, committed: key => Effect.gen(function* () {
    const path = key === CAPTURE_MANIFEST_STEP.key ? MANIFEST_FILE : prepared.report.desired.files.find(file => file.id === configFileId(key))?.src;
    if (path && prepared.documents.some(document => document.path === path)) committed.add(path); yield* observer.committed(key);
  }) });
  const events = yield* Stream.runCollect(execute(prepared.plan, prepared.report, domains, { signal, lockHeld: true }));
  if ([...events].some(event => event.type === 'finished' && event.outcome !== 'ok')) return yield* Effect.fail(failure());
  return { committedPaths: [...committed], remainingPaths: prepared.documents.map(doc => doc.path).filter(path => !committed.has(path)) };
});
