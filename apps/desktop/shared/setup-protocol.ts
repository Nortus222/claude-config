import { Schema } from 'effect';

export const DEFAULT_REPO_URL = 'https://github.com/Nortus222/claude-config.git';
export const SetupChoicesSchema = Schema.Struct({ configTargets: Schema.Array(Schema.Literals(['claude', 'codex'])).check(
  Schema.isMaxLength(2), Schema.makeFilter((values) => new Set(values).size === values.length)) });
export type SetupChoices = typeof SetupChoicesSchema.Type;
export const SetupStateSchema = Schema.Struct({ needsSetup: Schema.Boolean, repo: Schema.NullOr(Schema.String),
  gitAvailable: Schema.Boolean, canInstallGit: Schema.Boolean, defaultRepoUrl: Schema.Literal(DEFAULT_REPO_URL) });
export type SetupState = typeof SetupStateSchema.Type;
export const decodeSetupChoices = Schema.decodeUnknownSync(SetupChoicesSchema, { onExcessProperty: 'error' });
export const decodeSetupState = Schema.decodeUnknownSync(SetupStateSchema, { onExcessProperty: 'error' });
