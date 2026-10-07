import { Schema } from 'effect';
import { CommitShaSchema, DisplayNameSchema, EnvNameSchema, IdSchema, IsoTimeSchema, RevisionCursorSchema, RevisionNumberSchema, TagSchema } from './primitives.ts';
import { ItemIdSchema, parseItemId } from './items.ts';
import { RepoUrlSchema } from './repo-url.ts';
import { MAX_CHANGELOG_BYTES, MAX_ITEMS, MAX_REVISION_BYTES, MAX_REVISIONS, MAX_SETUPS, jsonByteLength, utf8ByteLength } from './decode.ts';

export const SetupRegistrationSchema = Schema.Struct({ name: DisplayNameSchema, repoUrl: RepoUrlSchema });
export type SetupRegistration = typeof SetupRegistrationSchema.Type;
export const SetupRecordSchema = Schema.Struct({ setupId: IdSchema, ...SetupRegistrationSchema.fields, latestRevision: RevisionCursorSchema, createdAt: IsoTimeSchema });
export type SetupRecord = typeof SetupRecordSchema.Type;
export const SetupsResponseSchema = Schema.Struct({ setups: Schema.Array(SetupRecordSchema).check(Schema.isMaxLength(MAX_SETUPS), Schema.makeFilter((setups) => new Set(setups.map((setup) => setup.setupId)).size === setups.length)) });
export type SetupsResponse = typeof SetupsResponseSchema.Type;
export const RevisionItemSchema = Schema.Struct({ id: ItemIdSchema, kind: Schema.Literals(['setting', 'skill', 'integration', 'file']), change: Schema.Literals(['added', 'changed', 'removed']) }).check(Schema.makeFilter((item) => parseItemId(item.id)?.kind === item.kind));
export type RevisionItem = typeof RevisionItemSchema.Type;
export const RevisionPublicationSchema = Schema.Struct({
  number: RevisionNumberSchema,
  commitSha: CommitShaSchema,
  tag: TagSchema,
  changelog: Schema.String.check(Schema.makeFilter((text) => utf8ByteLength(text) <= MAX_CHANGELOG_BYTES)),
  items: Schema.Array(RevisionItemSchema).check(Schema.isMaxLength(MAX_ITEMS), Schema.makeFilter((items) => new Set(items.map((item) => item.id)).size === items.length)),
  requiredEnv: Schema.Array(EnvNameSchema).check(Schema.makeFilter((names) => new Set(names).size === names.length)),
}).check(Schema.makeFilter((record) => jsonByteLength(record) <= MAX_REVISION_BYTES));
export type RevisionPublication = typeof RevisionPublicationSchema.Type;
export const RevisionRecordSchema = Schema.Struct({ setupId: IdSchema, ...RevisionPublicationSchema.fields, publishedAt: IsoTimeSchema, machineId: IdSchema }).check(Schema.makeFilter((record) => jsonByteLength(record) <= MAX_REVISION_BYTES));
export type RevisionRecord = typeof RevisionRecordSchema.Type;
export const RevisionsResponseSchema = Schema.Struct({ revisions: Schema.Array(RevisionRecordSchema).check(Schema.isMaxLength(MAX_REVISIONS)), nextAfter: Schema.NullOr(RevisionNumberSchema) }).check(Schema.makeFilter((page) =>
  page.revisions.every((record, index) => index === 0 || (record.setupId === page.revisions[0].setupId && record.number > page.revisions[index - 1].number))
  && (page.nextAfter === null || (page.revisions.length > 0 && page.nextAfter === page.revisions[page.revisions.length - 1].number))));
export type RevisionsResponse = typeof RevisionsResponseSchema.Type;
