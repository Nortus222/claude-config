import { Effect } from 'effect';
import { loadProfile, nodeFiles, type Input, type MachineOverrides, type ReadFailed } from '@nortuscc/profile-engine';
import type { Fs, FsFailed, LaunchFailed, Processes } from '@nortuscc/machine';
import { worktreeDocuments, writeDocuments, type Documents } from './documents.ts';
import { commitDocuments } from './git.ts';
import { patchItem } from './patch.ts';
import type { RevisionUnavailable, Snapshot } from './source.ts';
import type { Holds } from './store.ts';

// Where head's documents come from: the working tree (the CLI, so an author's uncommitted edit still
// applies) or a commit's git objects (the agent, ADR 0016).
export type Head = { readonly kind: 'worktree' } | { readonly kind: 'commit'; readonly commit: string };

type ComposeError = FsFailed | LaunchFailed | RevisionUnavailable;

// Head's documents with every held item patched to its value at its held commit, in item-id order.
export const composeDocuments = (input: { readonly repo: string; readonly head: Head; readonly held: Holds }):
  Effect.Effect<Documents, ComposeError, Fs | Processes> =>
  Effect.gen(function* () {
    let documents = input.head.kind === 'worktree'
      ? yield* worktreeDocuments(input.repo)
      : yield* commitDocuments(input.repo, input.head.commit);
    const atCommit = new Map<string, Documents>();
    for (const itemId of Object.keys(input.held).sort()) {
      const commit = input.held[itemId]!;
      let held = atCommit.get(commit);
      if (held === undefined) {
        held = yield* commitDocuments(input.repo, commit);
        atCommit.set(commit, held);
      }
      documents = patchItem(documents, itemId, held);
    }
    return documents;
  });

// This machine's desired configuration: head with held items at their held values, resolved with
// `overrides` exactly as today. With nothing held and the working tree as head it is
// loadProfile(repo), in place; otherwise the composed documents replace `into` and resolve there.
export const desiredFor = (input: {
  readonly repo: string;
  readonly head: Head;
  readonly held: Holds;
  readonly into: string;
  readonly overrides?: Input<MachineOverrides>;
}): Effect.Effect<Snapshot, ComposeError | ReadFailed, Fs | Processes> =>
  Effect.gen(function* () {
    const options = input.overrides ? { overrides: input.overrides } : {};
    if (input.head.kind === 'worktree' && Object.keys(input.held).length === 0) {
      return { desired: yield* loadProfile(input.repo, options).pipe(Effect.provide(nodeFiles)), repo: input.repo };
    }
    yield* writeDocuments(input.into, yield* composeDocuments(input));
    return { desired: yield* loadProfile(input.into, options).pipe(Effect.provide(nodeFiles)), repo: input.into };
  });
