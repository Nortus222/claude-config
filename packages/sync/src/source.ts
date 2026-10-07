import { Context, Data, type Effect } from 'effect';
import type { DesiredConfig } from '@nortuscc/profile-engine';
import type { Decision } from '@nortuscc/machine';

// P2: a commit SHA on the setup's tracked branch. P3 adds hosted revision records.
export type Revision = string;

// P2: decisions about the user's own setup, not linked to the hosted service.
export const LOCAL_SETUP = 'local';

// A configuration and a directory holding its files. The config domain reads a copied file's
// content from MachinePaths.repo, so the agent points that at `repo` while it inspects and applies.
export type Snapshot = { readonly desired: DesiredConfig; readonly repo: string };

export type Effective = {
  // The revision this machine last applied, which pending items are measured against.
  readonly applied: Snapshot & { readonly revision: Revision };
  // The applied revision plus the accepted items of newer revisions.
  readonly effective: Snapshot;
  // Accepted items that conflict with machine overrides, as #43 words them. Never resolved here.
  readonly conflicts: ReadonlyArray<string>;
};

export class RevisionMismatch extends Data.TaggedError('RevisionMismatch')<{ readonly revision: Revision; readonly reason: string }> {
  override get message() {
    return `revision ${this.revision} failed verification: ${this.reason}`;
  }
}

export class RevisionUnavailable extends Data.TaggedError('RevisionUnavailable')<{ readonly revision: Revision; readonly reason: string }> {
  override get message() {
    return `revision ${this.revision} could not be fetched: ${this.reason}`;
  }
}

// Machine sync's contract (#43), implemented by setupSourceLayer; the agent's tests fake it.
export class SetupSource extends Context.Service<
  SetupSource,
  {
    // Updates the setup's remote refs from its trusted repoUrl with the user's own Git credentials.
    // Never touches the working tree. Answers the tracked branch's head.
    readonly fetch: Effect.Effect<{ readonly head: Revision }, RevisionUnavailable>;
    // The configuration at `revision`, verified to be reachable from the tracked branch fetched from repoUrl.
    readonly load: (revision: Revision) => Effect.Effect<Snapshot, RevisionMismatch | RevisionUnavailable>;
    // This machine's desired configuration; skipped and undecided items stay at their applied value.
    readonly effective: (decisions: ReadonlyArray<Decision>) => Effect.Effect<Effective, RevisionUnavailable>;
    // The checkout's HEAD with this machine's holds and overrides. No fetch and no trust check: it
    // is only for inspecting an untrusted checkout for drift, never for applying.
    readonly current: Effect.Effect<Snapshot, RevisionUnavailable>;
  }
>()('sync/SetupSource') {}
