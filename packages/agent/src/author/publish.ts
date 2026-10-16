import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Effect, Schema, Semaphore } from 'effect';
import { canonical, MachinePaths, Processes } from '@nortuscc/machine';
import { listProfiles, memoryFiles, resolveNamedProfile } from '@nortuscc/profile-engine';
import { AccessDenied, diffItems, hasProfile, normalizeRepoUrl, readDocuments, resolvedItemValues, type Documents } from '@nortuscc/sync';
import { Git, IGNORES_FILE } from '@nortuscc/source-watch';
import type { HostedClient } from '@nortuscc/hosted-client';
import { EnvNameSchema, MAX_ITEMS, RevisionItemSchema, RevisionPublicationSchema, type RevisionItem } from '@nortuscc/hosted-protocol';
import { SessionError } from '../ipc/session.ts';
import { RunStore } from '../run-store.ts';
import type { RunLifecycle } from '../runs.ts';
import { decodeOperationOutput, type OperationChange, type ParityAcceptance, type RunView } from '../operations/index.ts';
import type { PreparedParityChange } from '../operations/parity.ts';
import { DraftStore, type Draft } from './drafts.ts';
import { AuthorWorkspace } from './workspace.ts';
import { replay } from './replay.ts';
import { ghStatus } from './gh.ts';

export type DraftPreview = {
  draftId: string; base: string; digest: string;
  diff: { path: string; before: string | null; after: string | null }[];
  invalid: { index: number | null; profile?: string; reason: string }[]; affectedProfiles: string[];
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
export const makeAuthorPublisher = (client: HostedClient | undefined, generation: Effect.Effect<number> = Effect.succeed(0)) => Effect.gen(function* () {
  const workspace = yield* AuthorWorkspace;
  const drafts = yield* DraftStore;
  const runs = yield* RunStore;
  const paths = yield* MachinePaths;
  const git = yield* Git;
  const processes = yield* Processes;
  const sessionError = (error: unknown, message = 'Publication could not be completed') => Effect.gen(function* () {
    if (error instanceof SessionError) return yield* Effect.fail(error);
    if (error instanceof AccessDenied) {
      const status = yield* ghStatus().pipe(Effect.provideService(Processes, processes));
      if (status === 'signed-out') return yield* Effect.fail(new SessionError('NOT_SIGNED_IN', 'gh is not signed in; sign in to GitHub before publishing'));
      if (status === 'missing') return yield* Effect.fail(new SessionError('APP_UNAVAILABLE', 'gh is not installed'));
      if (status === 'ready') return yield* Effect.fail(new SessionError('UNAUTHORIZED', `No access to repository ${error.repoUrl}`));
      return yield* Effect.fail(failed('GitHub sign-in status is unavailable'));
    }
    return yield* Effect.fail(failed(message));
  });
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
    const hosted = client ? yield* client.sync().pipe(Effect.catch(() => client.state), Effect.catch(() => Effect.succeed(undefined))) : undefined;
    const affectedProfiles = [...new Set([...profiles(before), ...profiles(after)])].sort().filter(profile => changedItems(before, after, profile).length > 0);
    const pendingProfiles: string[] = [];
    const announced = new Map<string, Documents>();
    for (const profile of [...new Set([...profiles(before), ...profiles(after)])].sort()) {
      const setup = hosted?.accountId ? hosted.setups.find(setup => setup.owned && setup.profile === profile && normalizeRepoUrl(setup.repoUrl) === normalizeRepoUrl(draft.repoUrl)) : undefined;
      const latest = setup && client ? (yield* client.revisions(setup.setupId).pipe(Effect.catch(() => Effect.succeed([])))).at(-1) : undefined;
      let previous: Documents = setup ? {} : before;
      if (latest) {
        if (!announced.has(latest.commitSha)) announced.set(latest.commitSha, yield* documentsAt(fresh.dir, latest.commitSha));
        previous = announced.get(latest.commitSha)!;
      }
      if (changedItems(previous, after, profile).length) pendingProfiles.push(profile);
    }
    const invalid = [...replayed.invalid, ...profiles(after).flatMap(profile => resolveNamedProfile({ documents: after, name: profile }).issues
      .map(issue => ({ index: null, profile, reason: `${profile}: ${issue.message}` })))];
    return { draftId: draft.id, base: fresh.base, digest: digest(diff), diff, invalid, affectedProfiles, pendingProfiles };
  });
  const displayed = ({ pendingProfiles: _, ...result }: DraftPreview & { pendingProfiles: string[] }): DraftPreview => result;
  const previewDraft = (id: string): Effect.Effect<DraftPreview, SessionError> => Effect.flatMap(readDraft(id), preview).pipe(
    Effect.map(displayed), Effect.tap(result => Effect.sync(() => { previews.set(id, { base: result.base, digest: result.digest }); })),
    gate.withPermit, Effect.catch(error => sessionError(error, 'Draft preview is unavailable')));
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
  const complete = (lifecycle: RunLifecycle, acceptance: Acceptance, publication: Publication, notes: string[]) => Effect.gen(function* () {
    yield* checkpoint(lifecycle, publication);
    yield* lifecycle.parity({ kind: acceptance.kind, state: 'committed', committedKeys: acceptance.plannedKeys, remainingKeys: [], backupIds: [] });
    const message = publication.pending.length || !publication.tagged ? 'Published, not yet announced'
      : publication.unannounceable?.length ? 'Published; some profiles cannot be announced' : 'Published and announced';
    yield* lifecycle.publicationResult({ status: 'succeeded', message: [message, ...notes].join('. ') });
  });
  const announce = (target: Target, publication: Publication, lifecycle: RunLifecycle, notes: string[]) => Effect.gen(function* () {
    const commit = publication.commit!; const dir = dirFor(target.repoUrl);
    // Tag and hosted failures cannot undo a published commit. Keep its targets for Announce.
    const tagged = yield* workspace.tag(dir, commit).pipe(Effect.match({ onSuccess: () => true, onFailure: () => false }));
    if (!tagged) return;
    publication.tagged = true; yield* checkpoint(lifecycle, publication);
    const hosted = Effect.gen(function* () {
      if (!client) return;
      const state = yield* client.sync();
      if (target.accountId !== null && state.accountId !== target.accountId) return yield* Effect.fail(failed('Hosted account changed'));
      const after = yield* documentsAt(dir, commit);
      for (const profile of [...publication.pending]) {
        const result = yield* Effect.gen(function* () {
          const desired = resolveNamedProfile({ documents: after, name: profile });
          if (desired.issues.length) return desired.issues.map(issue => issue.message).join('; ');
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
            if (ancestor.trim() !== previous.commitSha) return 'A newer or divergent commit has already been announced';
          }
          const before = previous ? yield* documentsAt(dir, previous.commitSha) : {};
          const items = changedItems(before, after, profile);
          const requiredEnv = [...new Set(desired.integrations.filter(i => i.enabled).flatMap(i => Array.isArray(i.declaration.requiresEnv) ? i.declaration.requiresEnv.filter((name): name is string => typeof name === 'string') : []))].sort();
          const revision = { number: (previous?.number ?? 0) + 1, commitSha: commit, tag: `nortuscc/${commit}`, changelog: '', items, requiredEnv };
          if (requiredEnv.some(name => !Schema.is(EnvNameSchema)(name))) return 'Required environment names are unsupported by hosted announcements';
          if (items.length > MAX_ITEMS) return `Hosted announcements allow at most ${MAX_ITEMS} items per revision`;
          if (items.some(item => !Schema.is(RevisionItemSchema)(item))) return 'Item identities are unsupported by hosted announcements';
          if (!Schema.is(RevisionPublicationSchema)(revision)) return 'Revision metadata exceeds hosted announcement limits';
          if (existing) return existing.tag === revision.tag && canonical(existing.items) === canonical(items) && canonical(existing.requiredEnv) === canonical(requiredEnv)
            ? true : 'Existing hosted revision has different publication metadata';
          return yield* client.publishRevision(setup.setupId, revision).pipe(Effect.matchEffect({ onSuccess: () => Effect.succeed(true),
            // A committed request can lose its reply. A 409 must be reconciled, never blindly renumbered.
            onFailure: () => Effect.map(client.listRevisions(setup.setupId), latest => latest.some(r => r.commitSha === commit && r.tag === revision.tag && canonical(r.items) === canonical(items) && canonical(r.requiredEnv) === canonical(requiredEnv))),
          }));
        }).pipe(Effect.catch(() => Effect.succeed(false)));
        if (result !== false) {
          if (result === true) publication.announced = [...new Set([...publication.announced, profile])].sort();
          else publication.unannounceable = [...(publication.unannounceable ?? []), { profile, reason: result }];
          publication.pending = publication.pending.filter(p => p !== profile);
          yield* checkpoint(lifecycle, publication);
        }
      }
      yield* client.sync();
    });
    yield* hosted.pipe(Effect.catch(() => Effect.void));
    if (publication.pending.length === 0) {
      yield* Effect.gen(function* () {
        const current = yield* drafts.read(target.draftId);
        if (current && digest(current) === target.draftDigest) {
          yield* drafts.delete(target.draftId); previews.delete(target.draftId);
        }
      }).pipe(Effect.catchCause(() => Effect.sync(() => { notes.push('Draft cleanup failed; the draft was retained'); })));
    }
  });
  const finishPublished = (target: Target, acceptance: Acceptance, publication: Publication, lifecycle: RunLifecycle) => Effect.gen(function* () {
    const notes: string[] = [];
    yield* Effect.gen(function* () {
      yield* checkpoint(lifecycle, publication);
      yield* announce(target, publication, lifecycle, notes);
    }).pipe(Effect.catchCause(() => Effect.sync(() => { notes.push('Tagging or announcement did not complete; retry Announce'); })));
    yield* complete(lifecycle, acceptance, publication, notes);
  });
  const preparePublish = (change: { kind: 'publishDraft'; draftId: string; digest: string }): Effect.Effect<PreparedParityChange, SessionError> => Effect.gen(function* () {
    const draft = yield* readDraft(change.draftId);
    const seen = previews.get(draft.id);
    const accepted = yield* preview(draft);
    const state = yield* (client?.state ?? Effect.succeed({ accountId: null }));
    const target: Target = { repoUrl: draft.repoUrl, base: seen?.base ?? accepted.base, draftId: draft.id, draftDigest: digest(draft), profiles: accepted.pendingProfiles, accountId: state.accountId };
    const plan = yield* prepared(change, target, change.digest);
    return { ...plan, revalidate: Effect.void,
      execute: (lifecycle, signal) => Effect.gen(function* () {
        if (signal.aborted) return;
        const latestDraft = yield* readDraft(change.draftId);
        const latest = yield* preview(latestDraft);
        const publication: Publication = { commit: null, pushed: false, tagged: false, announced: [], pending: [] };
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
        const published = outcome.kind === 'pushed' ? true : publication.commit
          ? yield* workspace.isPublished(dirFor(target.repoUrl), publication.commit) : false;
        if (published === 'unknown') {
          yield* lifecycle.publicationResult({ status: 'interrupted', message: 'Push outcome is unknown; re-check this publication before retrying' }); return;
        }
        if (!published) {
          if (outcome.kind === 'moved') {
            yield* lifecycle.publicationResult({ status: 'needs-preview', message: 'Remote main moved; preview again' }); return;
          }
          if (outcome.kind !== 'pushed') {
            yield* lifecycle.finished({ type: 'failed', message: outcome.kind === 'denied' ? `No permission to push to ${target.repoUrl}` : outcome.detail }); return;
          }
        }
        publication.pushed = true; publication.pending = [...target.profiles];
        yield* finishPublished(target, plan.acceptance, publication, lifecycle);
      }).pipe(gate.withPermit, Effect.catch(error => sessionError(error))),
    } satisfies PreparedParityChange;
  }).pipe(gate.withPermit, Effect.catch(error => sessionError(error)));
  // A later Announce receipt settles the original run without rewriting its history.
  const evidenceFor = (target: Target, publication: NonNullable<RunView['publication']>) => Effect.map(runs.read, receipts => {
    const latest = receipts.filter(receipt => {
      const acceptance = receipt.view.intent.parity;
      return receipt.view.state === 'succeeded' && receipt.view.publication?.pushed && receipt.view.publication.commit === publication.commit
        && (acceptance?.kind === 'publishDraft' || acceptance?.kind === 'announcePublication')
        && canonical(acceptance.publication) === canonical(target);
    }).sort((a, b) => b.sequence - a.sequence)[0];
    return latest?.view.publication ?? publication;
  }).pipe(Effect.catch(() => Effect.succeed(publication)));
  const recoverPublication = (run: RunView) => Effect.gen(function* () {
    const acceptance = run.intent.parity;
    if ((acceptance?.kind !== 'publishDraft' && acceptance?.kind !== 'announcePublication') || !run.publication?.commit) return { published: false as const, action: 're-preview' as const };
    const published = yield* workspace.isPublished(dirFor(acceptance.publication.repoUrl), run.publication.commit);
    const evidence = yield* evidenceFor(acceptance.publication, run.publication);
    const needsAnnouncement = !evidence.pushed || !evidence.tagged || evidence.pending.length > 0;
    return { published, action: published === true ? needsAnnouncement ? 'announce' as const : null
      : published === false ? 're-preview' as const : 're-check' as const };
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
        const unannounceable = (yield* evidenceFor(target, receipt.view.publication!)).unannounceable;
        const publication: Publication = { commit, pushed: true, tagged: false, announced: [],
          pending: target.profiles.filter(profile => !unannounceable?.some(p => p.profile === profile)),
          ...(unannounceable ? { unannounceable: [...unannounceable] } : {}) };
        yield* finishPublished(target, plan.acceptance, publication, lifecycle);
      }).pipe(gate.withPermit, Effect.catch(error => sessionError(error))),
    } satisfies PreparedParityChange;
  }).pipe(gate.withPermit, Effect.catch(error => sessionError(error)));
  return { previewDraftValue: (draft: Draft) => preview(draft).pipe(Effect.map(displayed), gate.withPermit, Effect.catch(error => sessionError(error, 'Draft preview is unavailable'))), previewDraft, preparePublish, prepareAnnounce, recoverPublication };
});
