import { FILES } from '@nortuscc/profile-engine/author-values';
import { createHash, randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { Effect, Layer, Schema, Semaphore } from 'effect';
import { Backups, Fs, MachinePaths, Processes, homeDir, backupsForRun, canonical } from '@nortuscc/machine';
import { listProfiles, memoryFiles, parseProfileDocument, resolveNamedProfile } from '@nortuscc/profile-engine';
import { AccessDenied, readDocuments } from '@nortuscc/sync';
import { Git, IGNORES_FILE, discoverSkills, machineGit, readSkillContents } from '@nortuscc/source-watch';
import { DraftStore, draftStore, type Draft } from '../author/drafts.ts';
import { CAPTURE_MAX_BYTES } from '../author/intents.ts';
import { AuthorWorkspace, authorWorkspaceLayer, GIT_TIMEOUT_MS, GIT_OUTPUT_BYTES } from '../author/workspace.ts';
import { ghLogin, ghStatus } from '../author/gh.ts';
import { makeAuthorPublisher } from '../author/publish.ts';
import { AgentClock } from '../clock.ts';
import { RunStore } from '../run-store.ts';
import type { AgentHandle } from '../agent.ts';
import { SessionError } from '../ipc/session.ts';
import { AgentSourceEnvironment } from './sources.ts';
import { decodeOperationOutput, type OperationChange, type OperationInput, type OperationOutput } from './index.ts';
import { DiscoveryResultSchema } from './schemas.ts';
import type { PreparedParityChange } from './parity.ts';

export type AuthorRead = 'machineFile' | 'authorProfiles' | 'authorFile' | 'upstreams' | 'discoverUpstream' | 'upstreamSkill' | 'drafts' | 'draftPreview' | 'ghState';
type LocalChange = Extract<OperationChange, { kind: 'editDraft' | 'removeDraftIntent' | 'deleteDraft' | 'ghLogin' }>;
export type AuthorChange = LocalChange | Extract<OperationChange, { kind: 'publishDraft' | 'announcePublication' }>;
export const isAuthorChange = (change: OperationChange): change is AuthorChange =>
  ['editDraft', 'removeDraftIntent', 'deleteDraft', 'ghLogin', 'publishDraft', 'announcePublication'].includes(change.kind);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const invalid = (message: string) => new SessionError('INVALID_REQUEST', message);
const stale = () => new SessionError('UNKNOWN_PLAN', 'Draft or author repository changed; preview again');

// Capture the machine services once; all author writes are local drafts or the private clone.
export const makeAuthorOperations = (handle: AgentHandle) => Effect.gen(function* () {
  const paths = yield* MachinePaths; const fs = yield* Fs; const processes = yield* Processes;
  const runs = yield* RunStore; const clock = yield* AgentClock; const environment = yield* AgentSourceEnvironment;
  const env = environment.env ?? {};
  const base = Layer.mergeAll(Layer.succeed(MachinePaths, paths), Layer.succeed(Fs, fs), Layer.succeed(Processes, processes), Layer.succeed(RunStore, runs));
  let activeBackups: Backups['Service'];
  let lastBackupTime = 0;
  const backed = Layer.merge(base, Layer.succeed(Backups, {
    dir: Effect.suspend(() => activeBackups.dir),
    preserve: (...args) => Effect.suspend(() => activeBackups.preserve(...args)),
    moveAside: (...args) => Effect.suspend(() => activeBackups.moveAside(...args)),
  }));
  const layer = Layer.mergeAll(draftStore, authorWorkspaceLayer({ env }), machineGit({ env, timeoutMs: GIT_TIMEOUT_MS, maxBytes: GIT_OUTPUT_BYTES })).pipe(Layer.provideMerge(backed));
  return yield* Effect.gen(function* () {
    const store = yield* DraftStore; const workspace = yield* AuthorWorkspace; const git = yield* Git; const backups = yield* Backups;
    const publisher = yield* makeAuthorPublisher(handle.authorClient, handle.generation);
    const gate = yield* Semaphore.make(1);
    const withBackups = <A, E>(body: Effect.Effect<A, E>) => Effect.gen(function* () {
      lastBackupTime = Math.max((yield* clock.now).getTime(), lastBackupTime + 1);
      activeBackups = yield* Backups.pipe(Effect.provide(backupsForRun(new Date(lastBackupTime)).pipe(Layer.provide(base))));
      return yield* body;
    }).pipe(gate.withPermit);
    const sourcesPath = join(paths.stateRoot, 'agent', 'author', 'sources.json');
    const repo = Effect.gen(function* () {
      const setup = handle.selectOperationSetup ? yield* handle.selectOperationSetup('local') : undefined;
      if (!setup?.trusted || !setup.repository) return yield* Effect.fail(new SessionError('APP_UNAVAILABLE', 'Trust the configured author repository in the app'));
      return (yield* git.run(['remote', 'get-url', 'origin'], { cwd: setup.repository })).trim();
    });
    const failure = (error: unknown): Effect.Effect<never, SessionError> => Effect.gen(function* () {
      if (error instanceof SessionError) return yield* Effect.fail(error);
      if (error instanceof AccessDenied) {
        const state = yield* ghStatus().pipe(Effect.provideService(Processes, processes));
        return yield* Effect.fail(new SessionError(state === 'missing' ? 'APP_UNAVAILABLE' : state === 'signed-out' ? 'NOT_SIGNED_IN' : state === 'ready' ? 'UNAUTHORIZED' : 'INTERNAL', 'GitHub repository access is unavailable'));
      }
      return yield* Effect.fail(new SessionError('INTERNAL', 'Author operation is unavailable'));
    });
    const sources = Effect.gen(function* () {
      const text = yield* fs.readText(sourcesPath);
      if (text === undefined) return [];
      return yield* Effect.try({ try: () => Schema.decodeUnknownSync(Schema.Array(DiscoveryResultSchema), { onExcessProperty: 'error' })(JSON.parse(text)), catch: () => invalid('Saved browsing sources are unreadable') });
    });
    const snapshot = Effect.gen(function* () {
      const repoUrl = yield* repo; const fresh = yield* workspace.fresh(repoUrl);
      const entries = (yield* git.run(['ls-tree', '-r', '--name-only', '-z', fresh.base], { cwd: fresh.dir })).split('\0').filter(Boolean);
      const present = new Set(entries);
      const read = (path: string) => present.has(path) ? git.run(['show', `${fresh.base}:${path}`], { cwd: fresh.dir }) : Effect.succeed(undefined);
      const names = entries.filter(path => /^profiles\/[^/]+\.json$/.test(path)).map(path => path.slice('profiles/'.length));
      const documents = { ...yield* readDocuments(read, names.length ? names : undefined) };
      const ignores = yield* read(IGNORES_FILE); if (ignores !== undefined) documents[IGNORES_FILE] = ignores;
      const profiles = yield* listProfiles('.').pipe(Effect.provide(memoryFiles(documents)));
      return { repoUrl, documents, profiles };
    });
    const read = <N extends AuthorRead>(name: N, input: OperationInput<N>): Effect.Effect<OperationOutput<N>, SessionError> => Effect.gen(function* () {
      if (input.scope.kind !== 'machine') return yield* Effect.fail(new SessionError('UNSUPPORTED_SCOPE', 'Author operations support machine scope only'));
      let result: unknown;
      if (name === 'ghState') result = { state: yield* ghStatus().pipe(Effect.provideService(Processes, processes)) };
      else if (name === 'machineFile') {
        const fileId = (input as OperationInput<'machineFile'>).fileId;
        const file = FILES.find(file => file.id === fileId)!;
        const text = yield* fs.readText(join(homeDir(paths, file.home), file.dest));
        const bytes = Buffer.from(text ?? '');
        result = { fileId, exists: text !== undefined, text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(0, CAPTURE_MAX_BYTES), { stream: true }), truncated: bytes.length > CAPTURE_MAX_BYTES };
      } else if (name === 'drafts') result = { drafts: yield* store.list() };
      else if (name === 'draftPreview') result = yield* publisher.previewDraft((input as OperationInput<'draftPreview'>).draftId);
      else if (name === 'discoverUpstream') {
        const source = (input as OperationInput<'discoverUpstream'>).source;
        const discovered = yield* discoverSkills(source, { tempDir: join(paths.stateRoot, 'agent', 'author', 'discovery') }).pipe(Effect.provideService(Processes, processes));
        const previous = yield* sources;
        if (yield* fs.exists(sourcesPath)) yield* backups.preserve(sourcesPath, 'agent/author/sources.json');
        yield* fs.writeTextAtomic(sourcesPath, JSON.stringify([...previous.filter(s => s.source !== source), discovered]) + '\n');
        result = discovered;
      } else if (name === 'upstreamSkill') {
        const args = input as OperationInput<'upstreamSkill'>;
        result = yield* readSkillContents(args.source, args.commit, args.name, { cacheDir: join(paths.stateRoot, 'agent', 'author', 'cache') }).pipe(Effect.provideService(Git, git), Effect.provideService(Fs, fs));
      } else {
        const { repoUrl, documents, profiles } = yield* snapshot;
        const allProfiles = profiles.map(name => ({ name, config: resolveNamedProfile({ documents, name }) }));
        const issues = allProfiles.filter(p => p.config.issues.length).map(p => ({ profile: p.name, issues: p.config.issues }));
        const resolved = allProfiles.filter(p => p.config.issues.length === 0);
        const problems = issues.length ? { issues } : {};
        if (name === 'authorProfiles') result = { repoUrl, ...problems, profiles: resolved.map(({ name, config }) => ({ name,
          extends: documents[`profiles/${name}.json`] ? parseProfileDocument(documents[`profiles/${name}.json`]!, `profiles/${name}.json`).value.extends ?? null : null,
          skills: config.skills.map(s => ({ source: s.source, name: s.name, included: s.install, from: s.from.source })),
          files: config.files.map(f => ({ fileId: f.id, path: f.managed ? f.src : null, from: f.from.source })),
        })) };
        else if (name === 'authorFile') {
          const args = input as OperationInput<'authorFile'>;
          const file = resolved.find(p => p.name === args.profile)?.config.files.find(f => f.id === args.fileId);
          if (!file && !issues.some(p => p.profile === args.profile)) return yield* Effect.fail(invalid('Unknown profile or file'));
          const text = file?.managed ? documents[file.src] ?? '' : '';
          result = { ...problems, path: file?.managed ? file.src : null, text: Buffer.from(text).subarray(0, CAPTURE_MAX_BYTES).toString('utf8'), truncated: Buffer.byteLength(text) > CAPTURE_MAX_BYTES };
        } else {
          const browsed = yield* sources;
          const all = new Set([...resolved.flatMap(p => p.config.skills.map(s => s.source)), ...browsed.map(s => s.source)]);
          result = { ...problems, sources: [...all].sort().map(source => ({ source, inProfiles: resolved.filter(p => p.config.skills.some(s => s.source === source && s.install)).map(p => p.name),
            pin: resolved.flatMap(p => p.config.skills).find(s => s.source === source)?.pin?.ref ?? null, discovery: browsed.find(s => s.source === source) ?? null })) };
        }
      }
      return decodeOperationOutput(name, result);
    }).pipe(withBackups, Effect.catch(failure));
    const prepareLocal = (change: LocalChange): Effect.Effect<PreparedParityChange, SessionError> => Effect.gen(function* () {
      const repoUrl = change.kind === 'ghLogin' || change.kind === 'deleteDraft' ? null : yield* repo;
      const id = change.kind === 'ghLogin' ? null : change.draftId ?? randomUUID();
      const path = id ? join(paths.stateRoot, 'agent', 'author', 'drafts', `${id}.json`) : null;
      const before = path ? yield* fs.readText(path) : undefined;
      let next: Draft | undefined;
      if (change.kind === 'editDraft' || change.kind === 'removeDraftIntent') {
        const current = change.draftId ? yield* store.read(change.draftId) : undefined;
        if (change.draftId && !current) return yield* Effect.fail(invalid('Draft does not exist'));
        if (current && current.repoUrl !== repoUrl) return yield* Effect.fail(invalid('Draft belongs to another author repository'));
        const draft: Draft = current ?? { version: 1, id: id!, repoUrl: repoUrl!, createdAt: (yield* clock.now).toISOString(), intents: [] };
        if (change.kind === 'removeDraftIntent' && change.index >= draft.intents.length) return yield* Effect.fail(invalid('Unknown draft intent'));
        next = { ...draft, intents: change.kind === 'editDraft' ? [...draft.intents, change.intent] : draft.intents.filter((_, index) => index !== change.index) };
      }
      const preview = next ? yield* publisher.previewDraftValue(next) : null;
      const generation = String(yield* (handle.generation ?? Effect.succeed(0)));
      const key = `author:${change.kind}:${id ?? 'github'}`;
      const plan = { kind: 'operation' as const, steps: [{ key, domain: 'author' as const, action: change.kind === 'ghLogin' ? 'gh-login' as const : change.kind === 'deleteDraft' ? 'delete-draft' as const : 'edit-draft' as const,
        summary: change.kind === 'ghLogin' ? 'Sign in to GitHub with gh' : change.kind === 'deleteDraft' ? 'Delete the local draft' : 'Save the local draft', touches: id ? [id] : [], interruptible: true }], skipped: [] };
      const acceptance = { kind: change.kind, generation, baselineDigest: digest(before ?? null), planDigest: digest(plan), plannedKeys: [key], draftId: id };
      const revalidate = Effect.gen(function* () { if (path && ((yield* fs.readText(path)) !== before || (repoUrl !== null && (yield* repo) !== repoUrl))) return yield* Effect.fail(stale()); }).pipe(Effect.catch(failure));
      return { acceptance, preview: decodeOperationOutput('previewChange', { change, plan, planId: randomUUID(), scope: { kind: 'machine' }, generation, draftId: id, draft: preview, actionEffects: [plan.steps[0]!.summary], nextActions: [] }), revalidate,
        execute: (lifecycle, signal) => Effect.gen(function* () {
          if (signal.aborted) return;
          yield* revalidate;
          if (change.kind === 'ghLogin') {
            let challenge = Promise.resolve();
            let checkpointFailed = false;
            const login = ghLogin((code, url) => { challenge = challenge.then(() => Effect.runPromise(lifecycle.ghCode({ code, url: url as 'https://github.com/login/device' }))).catch(() => { checkpointFailed = true; }); }).pipe(Effect.provideService(Processes, processes));
            const cancelled = Effect.callback<'signed-out'>(resume => {
              const abort = () => resume(Effect.succeed('signed-out'));
              signal.addEventListener('abort', abort, { once: true });
              if (signal.aborted) abort();
              return Effect.sync(() => signal.removeEventListener('abort', abort));
            });
            const state = yield* Effect.raceFirst(Effect.interruptible(login), cancelled).pipe(
              Effect.ensuring(Effect.promise(() => challenge).pipe(Effect.andThen(lifecycle.ghCode(null)), Effect.orDie)));
            if (signal.aborted) return;
            if (checkpointFailed) return yield* Effect.fail(new SessionError('INTERNAL', 'GitHub challenge could not be saved'));
            if (state !== 'ready') return yield* Effect.fail(new SessionError(state === 'missing' ? 'APP_UNAVAILABLE' : 'NOT_SIGNED_IN', 'GitHub sign-in did not complete'));
          } else if (change.kind === 'deleteDraft') yield* store.delete(id!);
          else yield* store.write(next!);
          yield* lifecycle.parity({ kind: change.kind, state: 'committed', committedKeys: [key], remainingKeys: [], backupIds: change.kind === 'ghLogin' ? [] : (yield* backups.dir) ? [basename((yield* backups.dir)!)] : [] });
        }).pipe(Effect.catch(failure)),
      } satisfies PreparedParityChange;
    }).pipe(Effect.catch(failure));
    return { read, prepare: (change: AuthorChange) => change.kind === 'ghLogin' ? prepareLocal(change) : withBackups(change.kind === 'publishDraft' ? publisher.preparePublish(change) : change.kind === 'announcePublication' ? publisher.prepareAnnounce(change) : prepareLocal(change)).pipe(
      Effect.map(prepared => ({ ...prepared, execute: (lifecycle, signal) => withBackups(prepared.execute(lifecycle, signal)) } satisfies PreparedParityChange))),
      recoverPublication: (run: Parameters<typeof publisher.recoverPublication>[0]) => withBackups(publisher.recoverPublication(run)),
    };
  }).pipe(Effect.provide(layer));
});
