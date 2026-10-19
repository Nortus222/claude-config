import { Effect } from 'effect';
import { loadNamedProfile, nodeFiles, requireValid, type Input, type MachineOverrides, type ReadFailed, type ProfileInvalid } from '@nortuscc/profile-engine';
import type { Fs, FsFailed, LaunchFailed, Processes } from '@nortuscc/machine';
import { desiredOfDocuments, hasProfile, worktreeDocuments, writeDocuments, type Documents } from './documents.ts';
import { commitDocuments } from './git.ts';
import { patchItem } from './patch.ts';
import type { RevisionUnavailable, Snapshot } from './source.ts';
import type { Holds } from './store.ts';

// Where head's documents come from: the working tree (the CLI, so an author's uncommitted edit still
// applies) or a commit's git objects (the agent, ADR 0016).
export type Head = { readonly kind: 'worktree' } | { readonly kind: 'commit'; readonly commit: string };

type ComposeError = FsFailed | LaunchFailed | RevisionUnavailable | ProfileInvalid;

// Head's documents with every held item patched to its value at its held commit, in item-id order.
export const composeDocumentsWithStaleHolds = (input: { readonly repo: string; readonly head: Head; readonly held: Holds; readonly profile?: string }):
  Effect.Effect<{ documents: Documents; staleHolds: string[] }, ComposeError, Fs | Processes> =>
  Effect.gen(function* () {
    let documents = input.head.kind === 'worktree'
      ? yield* worktreeDocuments(input.repo)
      : yield* commitDocuments(input.repo, input.head.commit);
    const validate = (documents: Documents) => input.profile !== undefined && (input.profile !== 'default' || Object.keys(documents).some(path => path.startsWith('profiles/')))
      ? requireValid(desiredOfDocuments(documents, undefined, input.profile)).pipe(Effect.asVoid) : Effect.void;
    yield* validate(documents);
    const atCommit = new Map<string, Documents>();
    const staleHolds: string[] = [];
    for (const itemId of Object.keys(input.held).sort()) {
      const commit = input.held[itemId]!;
      let held = atCommit.get(commit);
      if (held === undefined) {
        held = yield* commitDocuments(input.repo, commit);
        atCommit.set(commit, held);
      }
      if (!hasProfile(held, input.profile)) {
        staleHolds.push(itemId);
        continue;
      }
      yield* validate(held);
      documents = patchItem(documents, itemId, held, input.profile);
    }
    return { documents, staleHolds };
  });

// A hold predating the followed profile has no value to replay and remains releasable.
export const composeDocuments = (input: Parameters<typeof composeDocumentsWithStaleHolds>[0]): Effect.Effect<Documents, ComposeError, Fs | Processes> =>
  composeDocumentsWithStaleHolds(input).pipe(Effect.map(result => result.documents));

// This machine's desired configuration: head with held items at their held values, resolved with
// machine overrides. With no holds, a worktree resolves in place; otherwise the composed
// documents replace `into`. Held commits use the same followed profile as head.
export const desiredFor = (input: {
  readonly repo: string;
  readonly profile: string;
  readonly head: Head;
  readonly held: Holds;
  readonly into: string;
  readonly overrides?: Input<MachineOverrides>;
}): Effect.Effect<Snapshot, ComposeError | ReadFailed | ProfileInvalid, Fs | Processes> =>
  Effect.gen(function* () {
    const options = input.overrides ? { overrides: input.overrides } : {};
    const load = (repo: string) => loadNamedProfile(repo, input.profile, options);
    if (input.head.kind === 'worktree' && Object.keys(input.held).length === 0) {
      return { desired: yield* load(input.repo).pipe(Effect.provide(nodeFiles)), repo: input.repo };
    }
    yield* writeDocuments(input.into, yield* composeDocuments(input));
    return { desired: yield* load(input.into).pipe(Effect.provide(nodeFiles)), repo: input.into };
  });
