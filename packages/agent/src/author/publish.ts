import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Effect, Semaphore } from 'effect';
import { canonical, MachinePaths } from '@nortuscc/machine';
import { listProfiles, memoryFiles, resolveNamedProfile } from '@nortuscc/profile-engine';
import { diffItems, hasProfile, normalizeRepoUrl, readDocuments, resolvedItemValues, type Documents } from '@nortuscc/sync';
import { Git, IGNORES_FILE } from '@nortuscc/source-watch';
import type { HostedClient } from '@nortuscc/hosted-client';
import type { RevisionItem } from '@nortuscc/hosted-protocol';
import { SessionError } from '../ipc/session.ts';
import { RunStore } from '../run-store.ts';
import type { RunLifecycle } from '../runs.ts';
import { decodeOperationOutput, type OperationChange, type ParityAcceptance, type RunView } from '../operations/index.ts';
import type { PreparedParityChange } from '../operations/parity.ts';
import { DraftStore, type Draft } from './drafts.ts';
import { AuthorWorkspace } from './workspace.ts';
import { replay } from './replay.ts';

export type DraftPreview = {
  draftId: string; base: string; digest: string;
  diff: { path: string; before: string | null; after: string | null }[];
  invalid: { index: number; reason: string }[]; affectedProfiles: string[];
};
type Publication = { -readonly [K in keyof NonNullable<RunView['publication']>]: NonNullable<RunView['publication']>[K] };
type Acceptance = Extract<ParityAcceptance, { kind: 'publishDraft' | 'announcePublication' }>;
type Target = Acceptance['publication'];
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const failed = (message = 'Publication could not be completed') => new SessionError('INTERNAL', message);
const profiles = (documents: Documents) => Effect.runSync(listProfiles('.').pipe(Effect.provide(memoryFiles(documents))));
const values = (documents: Documents, profile: string) => hasProfile(documents, profile)
  ? resolvedItemValues(resolveNamedProfile({ documents, name: profile }), documents) : new Map<string, string>();
const changedItems = (before: Documents, after: Documents, profile: string): RevisionItem[] =>
  diffItems(values(before, profile), values(after, profile)).map(item => ({ id: item.itemId, kind: item.kind,
    change: item.before === undefined ? 'added' : item.after === undefined ? 'removed' : 'changed' }));

// Capture services once. The session owns apply serialization; this gate also serializes private-clone reads.
export const makeAuthorPublisher = (client: HostedClient, generation: Effect.Effect<number> = Effect.succeed(0)) => Effect.gen(function* () {
  const workspace = yield* AuthorWorkspace;
  const drafts = yield* DraftStore;
  const runs = yield* RunStore;
  const paths = yield* MachinePaths;
  const git = yield* Git;
  const gate = yield* Semaphore.make(1);
  const previews = new Map<string, { base: string; digest: string }>();
  const dirFor = (repoUrl: string) => join(paths.stateRoot, 'agent', 'author', createHash('sha256').update(repoUrl).digest('hex').slice(0, 16));
  const documentsAt = (dir: string, commit: string, extra: readonly string[] = []) => Effect.gen(function* () {
    const entries = (yield* git.run(['ls-tree', '-r', '--name-only', '-z', commit], { cwd: dir })).split('\0').filter(Boolean);
    const entriesSet = new Set(entries);
    const read = (path: string) => entriesSet.has(path) ? git.run(['show', `${commit}:${path}`], { cwd: dir }) : Effect.succeed(undefined);
    const names = entries.filter(path => /^profiles\/[^/]+\.json$/.test(path)).map(path => path.slice('profiles/'.length));
    const documents: Record<string, string> = { ...yield* readDocuments(read, entries.some(path => path.startsWith('profiles/')) ? names : undefined) };
    for (const path of [IGNORES_FILE, ...extra]) { const text = yield* read(path); if (text !== undefined) documents[path] = text; }
    return documents;
  });
  const readDraft = (id: string) => Effect.gen(function* () {
    const draft = yield* drafts.read(id);
    if (!draft) return yield* Effect.fail(new SessionError('INVALID_REQUEST', 'Draft does not exist'));
    return draft;
  });
  const preview = (draft: Draft) => Effect.gen(function* () {
    const fresh = yield* workspace.fresh(draft.repoUrl);
    const extra = draft.intents.flatMap(intent => intent.kind === 'captureFile' && intent.choice.kind === 'ownCopy'
      ? [intent.choice.repoPath] : intent.kind === 'setFile' && intent.path !== null ? [intent.path] : []);
    const before = yield* documentsAt(fresh.dir, fresh.base, extra);
    const replayed = replay(before, draft.intents);
    const after = Object.fromEntries(Object.entries(replayed.documents).filter((entry): entry is [string, string] => entry[1] !== null));
    const diff = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(path => before[path] === after[path] ? []
      : [{ path, before: before[path] ?? null, after: after[path] ?? null }]);
    const affectedProfiles = [...new Set([...profiles(before), ...profiles(after)])].sort().filter(profile => changedItems(before, after, profile).length > 0);
    return { draftId: draft.id, base: fresh.base, digest: digest(diff), diff, invalid: replayed.invalid, affectedProfiles } satisfies DraftPreview;
  });
  const previewDraft = (id: string): Effect.Effect<DraftPreview, SessionError> => Effect.flatMap(readDraft(id), preview).pipe(
    Effect.tap(result => Effect.sync(() => { previews.set(id, { base: result.base, digest: result.digest }); })),
    gate.withPermit, Effect.mapError(() => failed('Draft preview is unavailable')));
  const prepared = (change: Extract<OperationChange, { kind: 'publishDraft' | 'announcePublication' }>, target: Target, baseDigest: string, commit?: string) => Effect.gen(function* () {
    const currentGeneration = String(yield* generation);
    const key = change.kind === 'publishDraft' ? `publish:${target.draftId}` : `announce:${change.runId}`;
    const plan = { kind: 'operation' as const, steps: [{ key, domain: 'author' as const,
      action: change.kind === 'publishDraft' ? 'publish-draft' as const : 'announce-publication' as const,
      summary: change.kind === 'publishDraft' ? 'Publish the previewed draft to main' : 'Announce the published profiles',
      touches: target.profiles, interruptible: false }], skipped: [] };
    const acceptance: Acceptance = change.kind === 'publishDraft'
      ? { kind: change.kind, generation: currentGeneration, baselineDigest: baseDigest, planDigest: digest(plan), plannedKeys: [key], publication: target }
      : { kind: change.kind, generation: currentGeneration, baselineDigest: baseDigest, planDigest: digest(plan), plannedKeys: [key], publication: target, commit: commit! };
    return { acceptance, preview: decodeOperationOutput('previewChange', { change, plan, planId: randomUUID(), scope: { kind: 'machine' }, generation: currentGeneration,
      actionEffects: [change.kind === 'publishDraft' ? 'Push to main, tag the commit and announce each changed profile' : 'Retry tags and missing profile announcements'], nextActions: [] }) };
  });
  const checkpoint = (lifecycle: RunLifecycle, publication: Publication) => lifecycle.publication(publication);
  const complete = (lifecycle: RunLifecycle, acceptance: Acceptance, publication: Publication) => Effect.gen(function* () {
    yield* checkpoint(lifecycle, publication);
    yield* lifecycle.parity({ kind: acceptance.kind, state: 'committed', committedKeys: acceptance.plannedKeys, remainingKeys: [], backupIds: [] });
    yield* lifecycle.publicationResult({ status: 'succeeded', message: publication.pending.length || !publication.tagged ? 'Published, not yet announced' : 'Published and announced' });
  });
  const announce = (target: Target, publication: Publication, lifecycle: RunLifecycle) => Effect.gen(function* () {
    const commit = publication.commit!; const dir = dirFor(target.repoUrl);
    // Tag and hosted failures cannot undo a published commit. Keep its targets for Announce.
    const tagged = yield* workspace.tag(dir, commit).pipe(Effect.match({ onSuccess: () => true, onFailure: () => false }));
    if (!tagged) return;
    publication.tagged = true; yield* checkpoint(lifecycle, publication);
    const hosted = Effect.gen(function* () {
      const state = yield* client.sync();
      if (target.accountId !== null && state.accountId !== target.accountId) return yield* Effect.fail(failed('Hosted account changed'));
      const after = yield* documentsAt(dir, commit);
      for (const profile of [...publication.pending]) {
        const result = yield* Effect.gen(function* () {
          const current = yield* client.state;
          if (target.accountId !== null && current.accountId !== target.accountId) return yield* Effect.fail(failed('Hosted account changed'));
          const setup = current.setups.find(s => s.owned && normalizeRepoUrl(s.repoUrl) === normalizeRepoUrl(target.repoUrl) && s.profile === profile)
            ?? (yield* client.registerSetup({ name: profile, repoUrl: target.repoUrl, profile }));
          const records = yield* client.listRevisions(setup.setupId);
          const existingIndex = records.findIndex(r => r.commitSha === commit);
          const existing = records[existingIndex];
          const previous = existingIndex >= 0 ? records[existingIndex - 1] : records.at(-1);
          if (previous) {
            // Never append an older or divergent commit after a later announcement.
            const ancestor = yield* git.run(['merge-base', previous.commitSha, commit], { cwd: dir });
            if (ancestor.trim() !== previous.commitSha) return false;
          }
          const before = previous ? yield* documentsAt(dir, previous.commitSha) : {};
          const items = changedItems(before, after, profile);
          const desired = resolveNamedProfile({ documents: after, name: profile });
          const requiredEnv = [...new Set(desired.integrations.filter(i => i.enabled).flatMap(i => Array.isArray(i.declaration.requiresEnv) ? i.declaration.requiresEnv.filter((name): name is string => typeof name === 'string') : []))].sort();
          const publication = { number: (previous?.number ?? 0) + 1, commitSha: commit, tag: `nortuscc/${commit}`, changelog: '', items, requiredEnv };
          if (existing) return existing.tag === publication.tag && canonical(existing.items) === canonical(items) && canonical(existing.requiredEnv) === canonical(requiredEnv);
          return yield* client.publishRevision(setup.setupId, publication).pipe(Effect.matchEffect({ onSuccess: () => Effect.succeed(true),
            // A committed request can lose its reply. A 409 must be reconciled, never blindly renumbered.
            onFailure: () => Effect.map(client.listRevisions(setup.setupId), latest => latest.some(r => r.commitSha === commit && r.tag === publication.tag && canonical(r.items) === canonical(items) && canonical(r.requiredEnv) === canonical(requiredEnv))),
          }));
        }).pipe(Effect.catch(() => Effect.succeed(false)));
        if (result) {
          publication.announced = [...new Set([...publication.announced, profile])].sort();
          publication.pending = publication.pending.filter(p => p !== profile);
          yield* checkpoint(lifecycle, publication);
        }
      }
    });
    yield* hosted.pipe(Effect.catch(() => Effect.void));
    if (publication.pending.length === 0) {
      const current = yield* drafts.read(target.draftId);
      if (current && digest(current) === target.draftDigest) {
        yield* drafts.delete(target.draftId); previews.delete(target.draftId);
      }
    }
  });
  const preparePublish = (change: { kind: 'publishDraft'; draftId: string; digest: string }): Effect.Effect<PreparedParityChange, SessionError> => Effect.gen(function* () {
    const draft = yield* readDraft(change.draftId);
    const seen = previews.get(draft.id);
    const accepted = yield* preview(draft);
    const state = yield* client.state;
    const target: Target = { repoUrl: draft.repoUrl, base: seen?.base ?? accepted.base, draftId: draft.id, draftDigest: digest(draft), profiles: accepted.affectedProfiles, accountId: state.accountId };
    const plan = yield* prepared(change, target, change.digest);
    return { ...plan, revalidate: Effect.void,
      execute: (lifecycle, signal) => Effect.gen(function* () {
        if (signal.aborted) return;
        const latestDraft = yield* readDraft(change.draftId);
        const latest = yield* preview(latestDraft);
        const publication: Publication = { commit: null, pushed: false, tagged: false, announced: [], pending: [...target.profiles] };
        yield* checkpoint(lifecycle, publication);
        if (seen?.digest !== change.digest || latestDraft.repoUrl !== target.repoUrl || latest.base !== target.base || latest.digest !== change.digest || latest.invalid.length || !latest.diff.length) {
          yield* lifecycle.publicationResult({ status: 'needs-preview', message: 'Draft or main changed; preview again' }); return;
        }
        const outcome = yield* workspace.commitAndPush({ dir: dirFor(target.repoUrl), base: latest.base,
          files: Object.fromEntries(latest.diff.map(entry => [entry.path, entry.after])), message: 'Publish configuration draft',
          onCommit: commit => Effect.gen(function* () {
            publication.commit = commit;
            yield* checkpoint(lifecycle, publication).pipe(Effect.orDie);
          }),
        });
        if (outcome.kind === 'moved') {
          const published = publication.commit ? yield* workspace.isPublished(dirFor(target.repoUrl), publication.commit) : false;
          if (published !== true) {
            if (published === 'unknown') return yield* Effect.fail(failed('Push outcome is unknown; inspect the publication before retrying'));
            yield* lifecycle.publicationResult({ status: 'needs-preview', message: 'Remote main moved; preview again' }); return;
          }
        } else if (outcome.kind !== 'pushed') {
          yield* lifecycle.finished({ type: 'failed', message: outcome.kind === 'denied' ? `No permission to push to ${target.repoUrl}` : outcome.detail }); return;
        }
        publication.pushed = true; yield* checkpoint(lifecycle, publication);
        yield* announce(target, publication, lifecycle);
        yield* complete(lifecycle, plan.acceptance, publication);
      }).pipe(gate.withPermit, Effect.mapError(error => error instanceof SessionError ? error : failed())),
    } satisfies PreparedParityChange;
  }).pipe(gate.withPermit, Effect.mapError(error => error instanceof SessionError ? error : failed()));
  const recoverPublication = (run: RunView) => Effect.gen(function* () {
    const acceptance = run.intent.parity;
    if ((acceptance?.kind !== 'publishDraft' && acceptance?.kind !== 'announcePublication') || !run.publication?.commit) return { published: false as const, action: 're-preview' as const };
    const published = yield* workspace.isPublished(dirFor(acceptance.publication.repoUrl), run.publication.commit);
    return { published, action: published === true ? 'announce' as const : published === false ? 're-preview' as const : null };
  }).pipe(gate.withPermit);
  const prepareAnnounce = (change: { kind: 'announcePublication'; runId: string }): Effect.Effect<PreparedParityChange, SessionError> => Effect.gen(function* () {
    const receipt = (yield* runs.read).find(r => r.view.runId === change.runId);
    const acceptance = receipt?.view.intent.parity;
    const commit = receipt?.view.publication?.commit;
    if (!receipt || !commit || (acceptance?.kind !== 'publishDraft' && acceptance?.kind !== 'announcePublication')) return yield* Effect.fail(new SessionError('INVALID_REQUEST', 'Run has no publication'));
    const target = acceptance.publication;
    const plan = yield* prepared(change, target, digest(commit), commit);
    return { ...plan, revalidate: Effect.void,
      execute: (lifecycle, signal) => Effect.gen(function* () {
        if (signal.aborted) return;
        const published = yield* workspace.isPublished(dirFor(target.repoUrl), commit);
        if (published !== true) return yield* Effect.fail(failed('Publication is not confirmed on remote main'));
        const publication: Publication = { commit, pushed: true, tagged: false, announced: [], pending: [...target.profiles] };
        yield* checkpoint(lifecycle, publication);
        yield* announce(target, publication, lifecycle);
        yield* complete(lifecycle, plan.acceptance, publication);
      }).pipe(gate.withPermit, Effect.mapError(error => error instanceof SessionError ? error : failed())),
    } satisfies PreparedParityChange;
  }).pipe(gate.withPermit, Effect.mapError(() => failed()));
  return { previewDraft, preparePublish, prepareAnnounce, recoverPublication };
});
