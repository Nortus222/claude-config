import { Schema } from 'effect';
import { IdSchema, IsoTimeSchema, PolicySchema, RevisionCursorSchema, RevisionNumberSchema, SequenceSchema } from './primitives.ts';
import { SetupRegistrationSchema, RevisionPublicationSchema } from './revisions.ts';
import { DecisionSchema } from './decisions.ts';
import { MAX_REVISION_BYTES, MAX_SETUPS, decodeHosted, jsonByteLength } from './decode.ts';

export const SetupCursorSchema = Schema.Struct({ setupId: IdSchema, revision: RevisionCursorSchema });
export type SetupCursor = typeof SetupCursorSchema.Type;
export const SyncQuerySchema = Schema.Struct({ since: SequenceSchema, setups: Schema.Array(SetupCursorSchema).check(Schema.isMaxLength(MAX_SETUPS), Schema.makeFilter((setups) => new Set(setups.map((setup) => setup.setupId)).size === setups.length)) });
export type SyncQuery = typeof SyncQuerySchema.Type;
export const SyncedDecisionSchema = Schema.Struct({ ...DecisionSchema.fields, decidedAt: IsoTimeSchema, machineId: IdSchema });
export type SyncedDecision = typeof SyncedDecisionSchema.Type;
export const SyncRevisionSchema = Schema.Struct({ setupId: IdSchema, ...RevisionPublicationSchema.fields }).check(Schema.makeFilter((revision) => jsonByteLength(revision) <= MAX_REVISION_BYTES));
export type SyncRevision = typeof SyncRevisionSchema.Type;
export const SyncMachineSchema = Schema.Struct({ policy: PolicySchema, reportStatus: Schema.Boolean });
export type SyncMachine = typeof SyncMachineSchema.Type;
export const SyncSetupSchema = Schema.Struct({ setupId: IdSchema, ...SetupRegistrationSchema.fields, latestRevision: RevisionCursorSchema });
export type SyncSetup = typeof SyncSetupSchema.Type;
export const SyncResponseSchema = Schema.Struct({
  seq: SequenceSchema,
  decisions: Schema.Array(SyncedDecisionSchema).check(Schema.makeFilter((decisions) => new Set(decisions.map((decision) => `${decision.setupId}:${decision.itemId}`)).size === decisions.length)),
  revisions: Schema.Array(SyncRevisionSchema).check(Schema.makeFilter((revisions) => {
    const latest = new Map<string, number>();
    for (const revision of revisions) {
      if (revision.number <= (latest.get(revision.setupId) ?? 0)) return false;
      latest.set(revision.setupId, revision.number);
    }
    return true;
  })),
  machine: SyncMachineSchema,
  setups: Schema.Array(SyncSetupSchema).check(Schema.isMaxLength(MAX_SETUPS), Schema.makeFilter((setups) => new Set(setups.map((setup) => setup.setupId)).size === setups.length)),
  pollAfter: RevisionNumberSchema,
}).check(Schema.makeFilter((response) => {
  const heads = new Map(response.setups.map((setup) => [setup.setupId, setup.latestRevision]));
  return response.revisions.every((revision) => revision.number <= (heads.get(revision.setupId) ?? 0))
    && response.decisions.every((decision) => decision.revision <= (heads.get(decision.setupId) ?? 0));
}));
export type SyncResponse = typeof SyncResponseSchema.Type;

const parseCursor = (text: string): number => {
  if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new Error('Invalid hosted payload');
  return decodeHosted(RevisionCursorSchema, Number(text));
};
export const parseSyncQuery = (params: URLSearchParams): SyncQuery => {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if ((key !== 'since' && key !== 'setups') || seen.has(key)) throw new Error('Invalid hosted payload');
    seen.add(key);
  }
  const setups = params.get('setups') ?? '';
  return decodeHosted(SyncQuerySchema, {
    since: parseCursor(params.get('since') ?? '0'),
    setups: setups === '' ? [] : setups.split(',').map((entry) => {
      const fields = entry.split(':');
      if (fields.length !== 2) throw new Error('Invalid hosted payload');
      return { setupId: fields[0], revision: parseCursor(fields[1]) };
    }),
  });
};
export const formatSyncQuery = (value: SyncQuery): URLSearchParams => {
  const query = decodeHosted(SyncQuerySchema, value);
  const params = new URLSearchParams({ since: String(query.since) });
  if (query.setups.length > 0) {
    const setups = [...query.setups].sort((a, b) => a.setupId < b.setupId ? -1 : a.setupId > b.setupId ? 1 : 0);
    params.set('setups', setups.map((setup) => `${setup.setupId}:${setup.revision}`).join(','));
  }
  return params;
};
