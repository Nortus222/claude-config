import { Schema } from 'effect';

export type UpdateCommand = 'update_state' | 'check_update' | 'download_update' | 'cancel_update' | 'install_update' | 'update_preferences';
const Version = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const Bytes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
export const UpdateSnapshotSchema = Schema.Struct({
  installedVersion: Version,
  enabled: Schema.Boolean,
  automaticChecks: Schema.Boolean,
  phase: Schema.Literals(['idle', 'checking', 'current', 'available', 'downloading', 'verified', 'waiting', 'installing', 'restarting', 'error', 'recovery']),
  availableVersion: Schema.NullOr(Version),
  notes: Schema.NullOr(Schema.String.check(Schema.isMaxLength(8192))),
  downloadedBytes: Bytes,
  totalBytes: Schema.NullOr(Bytes),
  diagnostic: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
}).check(Schema.makeFilter((state) => state.totalBytes === null || state.downloadedBytes <= state.totalBytes));
export type UpdateSnapshot = typeof UpdateSnapshotSchema.Type;
export const decodeUpdateSnapshot = Schema.decodeUnknownSync(UpdateSnapshotSchema, { onExcessProperty: 'error' });
