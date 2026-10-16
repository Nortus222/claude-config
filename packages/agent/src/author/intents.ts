import { Schema } from 'effect';
import { FILES, isProfileName, isSkillAdditionName, normalizeSkillSource } from '@nortuscc/profile-engine';

export type Intent =
  | { kind: 'createProfile'; profile: string; extends: string | null }
  | { kind: 'includeSkill' | 'excludeSkill'; profile: string; source: string; name: string }
  | { kind: 'pin'; source: string; commit: string } | { kind: 'unpin'; source: string }
  | { kind: 'ignore' | 'unignore'; source: string; revision: string }
  | { kind: 'setFile'; profile: string; fileId: string; path: string | null }
  | { kind: 'setIntegration'; profile: string; id: string; include: boolean }
  | { kind: 'captureFile'; profile: string; fileId: string; text: string;
      choice: { kind: 'updateShared' } | { kind: 'ownCopy'; repoPath: string } };

export const CAPTURE_MAX_BYTES = 262_144;
const Profile = Schema.String.check(Schema.makeFilter(isProfileName));
const Source = Schema.String.check(Schema.isNonEmpty());
const SkillSource = Source.check(Schema.makeFilter(value => normalizeSkillSource(value) !== undefined));
const Name = Schema.String.check(Schema.makeFilter(isSkillAdditionName));
const Revision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$(?![\s\S])/u));
const FileId = Schema.String.check(Schema.makeFilter(value => FILES.some(file => file.id === value)));
const RepoPath = Schema.String.check(Schema.makeFilter(value =>
  !value.includes('\\') && !value.includes('\0') && !/^[a-z]:/i.test(value)
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')));
const CopyPath = RepoPath.check(Schema.isPattern(/^(?:claude|codex)\/.+/u));

export const IntentSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('createProfile'), profile: Profile, extends: Schema.NullOr(Profile) }),
  Schema.Struct({ kind: Schema.Literals(['includeSkill', 'excludeSkill']), profile: Profile, source: SkillSource, name: Name }),
  Schema.Struct({ kind: Schema.Literal('pin'), source: Source, commit: Revision }),
  Schema.Struct({ kind: Schema.Literal('unpin'), source: Source }),
  Schema.Struct({ kind: Schema.Literals(['ignore', 'unignore']), source: Source, revision: Revision }),
  Schema.Struct({ kind: Schema.Literal('setFile'), profile: Profile, fileId: FileId, path: Schema.NullOr(RepoPath) }),
  Schema.Struct({ kind: Schema.Literal('setIntegration'), profile: Profile, id: Schema.String.check(Schema.isNonEmpty()), include: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal('captureFile'), profile: Profile, fileId: FileId,
    text: Schema.String.check(Schema.makeFilter(value => Buffer.byteLength(value, 'utf8') <= CAPTURE_MAX_BYTES)),
    choice: Schema.Union([
      Schema.Struct({ kind: Schema.Literal('updateShared') }),
      Schema.Struct({ kind: Schema.Literal('ownCopy'), repoPath: CopyPath }),
    ]),
  }),
]);
