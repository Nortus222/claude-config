import type {
  DeviceStartRequest, MachineRecord, RevisionRecord, StatusSummary, SyncedDecision,
} from '@nortuscc/hosted-protocol';

interface Document {
  readonly id: string;
  readonly version: 1;
}

// Reserved metadata is sufficient to finish an interrupted setup creation.
export interface SetupReservation {
  readonly setupId: string;
  readonly name: string;
  readonly repoUrl: string;
  readonly createdAt: string;
  readonly state: 'reserved' | 'ready';
  readonly publishedHead: number;
}

export interface AccountDeletion {
  readonly startedAt: string;
  readonly remainingSetupIds: ReadonlyArray<string>;
  readonly identityRemoved: boolean;
}

export interface AccountDocument extends Document {
  readonly type: 'account';
  readonly accountId: string;
  readonly githubId: number;
  readonly login: string;
  readonly seq: number;
  readonly defaultPolicy: 'notify';
  readonly createdAt: string;
  readonly state: 'active' | 'deleting';
  readonly setups: ReadonlyArray<SetupReservation>;
  // The tombstone and setup index survive until every indexed partition is swept.
  readonly deletion?: AccountDeletion;
}

export interface MachineDocument extends Document, Omit<MachineRecord, 'status'> {
  readonly type: 'machine';
  readonly accountId: string;
  readonly tokenHash: string | null;
}

// Internal fence prevents a delayed issuance from recreating a cleaned machine.
export interface IssuanceFenceDocument extends Document {
  readonly type: 'issuanceFence';
  readonly accountId: string;
  readonly machineId: string;
}

export interface DecisionDocument extends Document, SyncedDecision {
  readonly type: 'decision';
  readonly accountId: string;
  readonly seq: number;
}

export interface StatusDocument extends Document {
  readonly type: 'status';
  readonly accountId: string;
  readonly machineId: string;
  readonly summary: StatusSummary;
}

export interface SetupDocument extends Document {
  readonly type: 'setup';
  readonly setupId: string;
  readonly ownerAccountId: string;
  readonly name: string;
  readonly repoUrl: string;
  readonly latestRevision: number;
  readonly createdAt: string;
  readonly publicationDay: string | null;
  readonly publicationsToday: number;
}

export interface RevisionDocument extends Document, RevisionRecord {
  readonly type: 'revision';
}

export interface IdentityDocument extends Document {
  readonly type: 'identity';
  readonly githubId: number;
  readonly accountId: string;
  readonly state: 'reserved' | 'active' | 'deleting';
}

// Claims hold only machine secret hashes; OAuth tokens never belong in Store.
export interface DeviceClaim {
  readonly claimId: string;
  readonly accountId: string;
  readonly machineId: string;
  readonly tokenHash: string;
  readonly claimedAt: number;
}

export interface DeviceSessionDocument extends Document {
  readonly type: 'deviceSession';
  readonly pendingId: string;
  // Temporary upstream exchange credential, bounded by expiresAt; never project or log it.
  readonly deviceCode: string;
  readonly description: DeviceStartRequest;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly interval: number;
  readonly nextPollAt: number;
  readonly state: 'pending' | 'claimed' | 'completed' | 'expired';
  readonly claim: DeviceClaim | null;
}

export type ServiceDocument = AccountDocument | MachineDocument | IssuanceFenceDocument | DecisionDocument | StatusDocument
  | SetupDocument | RevisionDocument | IdentityDocument | DeviceSessionDocument;
