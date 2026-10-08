import { Context, Data, type Effect } from 'effect';
import type { DesiredConfig } from '@nortuscc/profile-engine';
import type { Decision } from '@nortuscc/machine';
import type { SyncRevision } from '@nortuscc/hosted-protocol';

export type Revision = string | SyncRevision;

export const revisionCommit = (revision: Revision): string => typeof revision === 'string' ? revision : revision.commitSha;
export const revisionIdentity = (revision: Revision): string | number => typeof revision === 'string' ? revision : revision.number;
export const revisionSetupId = (revision: Revision): string => typeof revision === 'string' ? LOCAL_SETUP : revision.setupId;

export type HostedBaseline = { readonly revisionApplied: number; readonly origins: Readonly<Record<string, string>> };

// IDs positively confirmed by a fresh inspection with ownership, or successful apply and
// reinspection. Missing observations are never evidence; removals require ownership release.
export type AppliedEvidence = {
  readonly revision: SyncRevision;
  readonly decisions: ReadonlyArray<Decision>;
  readonly observed: ReadonlyArray<string>;
  readonly released: ReadonlyArray<string>;
};

// P2: decisions about the user's own setup, not linked to the hosted service.
export const LOCAL_SETUP = 'local';

// A configuration and a directory holding its files. The config domain reads a copied file's
// content from MachinePaths.repo, so the agent points that at `repo` while it inspects and applies.
export type Snapshot = { readonly desired: DesiredConfig; readonly repo: string };

export type Effective = {
  // The local applied commit; null for a hosted baseline composed from per-item origins.
  readonly applied: Snapshot & { readonly revision: Revision | null };
  // The applied revision plus the accepted items of newer revisions.
  readonly effective: Snapshot;
  // Accepted items that conflict with machine overrides, as #43 words them. Never resolved here.
  readonly conflicts: ReadonlyArray<string>;
};

export class RevisionMismatch extends Data.TaggedError('RevisionMismatch')<{ readonly revision: Revision; readonly reason: string }> {
  override get message() {
    return `revision ${revisionIdentity(this.revision)} failed verification: ${this.reason}`;
  }
}

export class RevisionUnavailable extends Data.TaggedError('RevisionUnavailable')<{ readonly revision: Revision; readonly reason: string }> {
  override get message() {
    return `revision ${revisionIdentity(this.revision)} could not be fetched: ${this.reason}`;
  }
}

// Machine sync's contract (#43), implemented by setupSourceLayer; the agent's tests fake it.
export class SetupSource extends Context.Service<
  SetupSource,
  {
    readonly setupId?: string;
    // Hosted sources check the active account and locally granted repository trust here.
    readonly trusted?: Effect.Effect<boolean, RevisionUnavailable>;
    readonly baseline?: Effect.Effect<HostedBaseline, RevisionUnavailable>;
    readonly recordApplied?: (evidence: AppliedEvidence) => Effect.Effect<void, RevisionMismatch | RevisionUnavailable>;
    // Answers the latest offered revision. Local sources refresh their tracked branch here;
    // hosted sources fetch and verify exact tags in load/effective. Never moves the checkout.
    readonly fetch: Effect.Effect<{ readonly head: Revision }, RevisionUnavailable>;
    // Verified configuration: local branch reachability, or hosted exact tag and item diff.
    readonly load: (revision: Revision) => Effect.Effect<Snapshot, RevisionMismatch | RevisionUnavailable>;
    // This machine's desired configuration; skipped and undecided items stay at their applied value.
    readonly effective: (decisions: ReadonlyArray<Decision>) => Effect.Effect<Effective, RevisionMismatch | RevisionUnavailable>;
    // Local sources inspect checkout HEAD with holds without trust. Hosted sources read their
    // consent-checked durable baseline without fetching. Neither operation authorizes apply.
    readonly current: Effect.Effect<Snapshot, RevisionUnavailable>;
  }
>()('sync/SetupSource') {}
